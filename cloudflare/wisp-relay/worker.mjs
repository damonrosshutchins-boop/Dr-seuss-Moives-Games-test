// Seuss Wisp relay for Cloudflare Workers.
//
// Speaks Wisp v1 over a websocket (the version the Scramjet/libcurl client on the
// Pages site negotiates) and proxies TCP through cloudflare:sockets. Each client
// websocket gets its own Durable Object instance, so the socket table lives for
// as long as the connection does.
//
// Deploy:  npx wrangler deploy      (from this folder)
// Endpoint: wss://<worker-name>.<subdomain>.workers.dev/wisp/
import { connect } from "cloudflare:sockets";

// Advertised stream buffer depth. 64 packets stalled large responses behind the
// tunnel handshake; 512 matches the Node relay and keeps downloads flowing.
const BUFFER_PACKETS = 512;
const decoder = new TextDecoder();
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

const OPEN = 0x01, DATA = 0x02, CONTINUE = 0x03, CLOSE = 0x04;
const REASON = {
  unspecified: 0x01, voluntary: 0x02, network: 0x03,
  invalid: 0x41, unreachable: 0x42, timeout: 0x43, refused: 0x44,
  blocked: 0x48, throttled: 0x49
};

function isIpLiteral(host) {
  return IPV4.test(host) || (host.includes(":") && /^[0-9a-f:.]+$/i.test(host));
}

// Mirrors the Node relay's defaults: any public destination, never the private
// ranges, so an open Worker relay cannot be aimed at Cloudflare-internal or LAN
// addresses.
function isPrivateHost(host) {
  if (IPV4.test(host)) {
    const [a, b] = host.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a >= 224) return true;
  }
  if (host.includes(":")) {
    const h = host.toLowerCase();
    if (h === "::" || h === "::1") return true;
    if (h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd")) return true;
  }
  return false;
}

function frame(type, id, payload = new Uint8Array(0)) {
  const out = new Uint8Array(5 + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, id, true);
  out.set(payload, 5);
  return out;
}
function continueFrame(id, remaining) {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, remaining, true);
  return frame(CONTINUE, id, payload);
}
function closeFrame(id, reason) {
  return frame(CLOSE, id, new Uint8Array([reason]));
}

function serve(server, env, state) {
  const streams = new Map();
  const allowDirectIp = env.ALLOW_DIRECT_IP === "1";
  const allowPrivate = env.ALLOW_PRIVATE_IPS === "1";

  const send = data => {
    try { server.send(data); } catch { /* socket already gone */ }
  };

  function shutdown(id, reason) {
    const stream = streams.get(id);
    if (!stream) return;
    streams.delete(id);
    try { stream.writer.abort().catch?.(() => {}); } catch {}
    try { stream.writer.close().catch?.(() => {}); } catch {}
    try { stream.socket.close(); } catch {}
    if (!stream.announced) send(closeFrame(id, reason));
    stream.announced = true;
  }

  async function open(id, payload) {
    if (payload.length < 3) return send(closeFrame(id, REASON.invalid));
    const streamType = payload[0];
    const port = new DataView(payload.buffer, payload.byteOffset).getUint16(1, true);
    const host = decoder.decode(payload.subarray(3)).trim().toLowerCase();
    if (streamType !== 0x01) return send(closeFrame(id, REASON.invalid)); // TCP only
    if (!host || port === 0) return send(closeFrame(id, REASON.invalid));
    if (isIpLiteral(host) && !allowDirectIp) return send(closeFrame(id, REASON.blocked));
    if (isPrivateHost(host) && !allowPrivate) return send(closeFrame(id, REASON.blocked));

    let socket;
    try {
      socket = connect({ hostname: host, port });
    } catch {
      return send(closeFrame(id, REASON.unreachable));
    }
    const stream = { socket, writer: socket.writable.getWriter(), announced: false };
    streams.set(id, stream);

    try {
      await socket.opened;
    } catch (error) {
      console.warn("wisp open failed", host + ":" + port, String(error));
      streams.delete(id);
      send(closeFrame(id, REASON.unreachable));
      return;
    }
    if (!streams.has(id)) return;

    // Stream-open confirmation plus the initial flow-control window.
    send(continueFrame(id, BUFFER_PACKETS));

    const pump = socket.readable.pipeTo(new WritableStream({
      write(chunk) {
        if (!streams.has(id)) return;
        send(frame(DATA, id, new Uint8Array(chunk)));
      },
      close() { shutdown(id, REASON.voluntary); },
      abort() { shutdown(id, REASON.network); }
    })).catch(error => { console.warn("wisp read failed", String(error)); shutdown(id, REASON.network); });
    // Durable Object I/O is cancelled when the triggering handler returns, so the
    // read pump is registered with waitUntil to keep the stream alive.
    state?.waitUntil?.(pump.catch(() => {}));
  }

  server.addEventListener("message", event => {
    if (typeof event.data === "string") return;
    const bytes = new Uint8Array(event.data);
    if (bytes.length < 5) return;
    const type = bytes[0];
    const id = new DataView(bytes.buffer, bytes.byteOffset).getUint32(1, true);
    const payload = bytes.subarray(5);

    if (type === OPEN) { open(id, payload); return; }
    if (type === DATA) {
      const stream = streams.get(id);
      if (!stream) { send(closeFrame(id, REASON.invalid)); return; }
      stream.writer.write(payload.slice()).catch(error => { console.warn("wisp write failed", String(error)); shutdown(id, REASON.network); })
        .finally(() => { if (streams.has(id)) send(continueFrame(id, BUFFER_PACKETS)); });
      return;
    }
    if (type === CLOSE) shutdown(id, payload[0] || REASON.voluntary);
    // CONTINUE from the client only matters for server-side flow control, which
    // this relay does not throttle.
  });

  server.addEventListener("close", () => {
    for (const id of [...streams.keys()]) shutdown(id, REASON.voluntary);
  });

  // Wisp v1: the server opens with a CONTINUE on stream 0 carrying the buffer size.
  send(continueFrame(0, BUFFER_PACKETS));
}

export class WispRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    serve(server, this.env, this.state);
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({
        ok: true,
        service: "seuss-wisp-relay-cloudflare",
        protocol: "wisp-1",
        transport: "cloudflare:sockets",
        relayOriginPolicy: "any-public-host",
        privateRanges: env.ALLOW_PRIVATE_IPS === "1" ? "allowed" : "blocked"
      }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    if (url.pathname === "/speedtest") {
      const bytes = Math.min(Math.max(Number(url.searchParams.get("bytes")) || 1500000, 1000), 8000000);
      return new Response(new Uint8Array(bytes), {
        headers: {
          "content-type": "application/octet-stream",
          "cache-control": "no-store",
          "access-control-allow-origin": "*"
        }
      });
    }
    if (url.pathname !== "/wisp/") {
      return new Response("Seuss Wisp relay: connect to /wisp/\n", {
        status: url.pathname === "/" ? 200 : 404,
        headers: { "content-type": "text/plain", "cache-control": "no-store" }
      });
    }
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return new Response("Expected a websocket upgrade\n", { status: 426 });
    }
    // Browsers still have to come from the arcade; an open relay is a bandwidth
    // faucet, not a public good.
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean);
    const origin = request.headers.get("Origin");
    if (allowed.length && origin && !allowed.includes(origin)) {
      return new Response("Origin not allowed\n", { status: 403 });
    }
    return env.WISP_RELAY.get(env.WISP_RELAY.idFromName("seuss")).fetch(request);
  }
};
