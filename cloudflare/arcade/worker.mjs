// Seuss Arcade relay for Cloudflare Workers.
//
// Serves the pinned, path-restricted game asset routes that used to run on
// Render, and speaks Wisp v1 on /wisp/ for the Scramjet/libcurl player. Every
// game file is fetched from one fixed upstream (or an ordered list of fixed
// mirrors); a visitor can never choose a host, URL or redirect target.
//
// Deploy:  npx wrangler deploy      (from this folder)
import { connect } from "cloudflare:sockets";

/* ---------------------------------------------------------------- relay --- */

// Advertised stream buffer depth. 64 packets stalled large responses behind the
// tunnel handshake; 512 matches the Node relay and keeps downloads flowing.
const BUFFER_PACKETS = 512;
// A TCP stream that never opens (blocked host, dead TLS handshake) would leave the
// player on its start-up banner indefinitely; fail it so the client can report.
const OPEN_TIMEOUT_MS = 20000;
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
      // Without a ceiling a stalled TLS handshake leaves the player spinning on
      // "Starting Scramjet over Wisp…" forever; tell the client instead.
      await Promise.race([
        socket.opened,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error("connect timed out")), OPEN_TIMEOUT_MS))
      ]);
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

/* --------------------------------------------------------------- policy --- */

const PAGES_ORIGIN = "https://damonrosshutchins-boop.github.io";
const SELF_ORIGIN = "https://seuss-arcade-relay.damonrosshutchins.workers.dev";

function isAllowedOrigin(origin, env) {
  if (!origin) return true; // same-origin requests carry no Origin header
  if (origin === PAGES_ORIGIN || origin === SELF_ORIGIN) return true;
  const configured = (env.ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean);
  if (configured.includes(origin)) return true;
  // Local preview servers only, never a public host.
  return /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin);
}

function denyOrigin(request, env) {
  if (isAllowedOrigin(request.headers.get("Origin"), env)) return null;
  return new Response("Unapproved arcade origin\n", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
  });
}

function corsHeaders(request, extra = {}) {
  const headers = new Headers(extra);
  const origin = request.headers.get("Origin");
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }
  headers.set("cross-origin-resource-policy", "cross-origin");
  return headers;
}

// Every /approved-* answer needs the arcade Origin echoed back, including JSON
// status replies and error bodies: the launchers check those with fetch().
function withCors(request, response) {
  const origin = request.headers.get("Origin");
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function preflight(request) {
  const headers = corsHeaders(request, {
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "Range, Content-Type",
    "access-control-max-age": "3600"
  });
  headers.set("cache-control", "no-store");
  return new Response(null, { status: 204, headers });
}

function textError(status, message) {
  return new Response(message + "\n", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function mimeFor(file, fallback = "application/octet-stream") {
  const lower = String(file).toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html; charset=utf-8";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".json") || lower.endsWith(".webmanifest")) return "application/json; charset=utf-8";
  if (lower.endsWith(".wasm")) return "application/wasm";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".ico")) return "image/x-icon";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".xml")) return "application/xml; charset=utf-8";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".unityweb") || lower.endsWith(".data") || lower.endsWith(".pck")) return "application/octet-stream";
  return fallback;
}

/* ------------------------------------------------------------- fetching --- */

const RANGE = /^bytes=\d*-\d*$/;

// One pinned upstream file, streamed back through the Worker. Returns null only
// when the transport itself failed, so the caller can try its next fixed mirror.
// Workers only implement "follow" and "manual"; "manual" plus a status check keeps
// the no-redirect rule the Node service had with redirect: "manual".
async function attemptPinned(request, upstreamUrl, options = {}) {
  const {
    mime, cache = "public, max-age=3600", timeout = 30000,
    forwardRange = true, headers: extraHeaders = {}, statusIfMissing = 502
  } = options;
  const headers = new Headers(extraHeaders);
  headers.set("accept-encoding", "identity");
  const range = request.headers.get("Range");
  if (range && forwardRange) {
    if (!RANGE.test(range)) return textError(416, "Unsupported byte range");
    headers.set("range", range);
  }

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeout)
    });
  } catch (error) {
    console.warn("pinned fetch failed", new URL(upstreamUrl).hostname, new URL(upstreamUrl).pathname, String(error));
    return null;
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    try { await upstream.body?.cancel(); } catch {}
    return textError(502, "The approved game source redirected; redirects are not followed.");
  }

  if (!upstream.ok) {
    try { await upstream.body?.cancel(); } catch {}
    console.warn("pinned upstream status", upstream.status, new URL(upstreamUrl).hostname, new URL(upstreamUrl).pathname);
    return textError(statusIfMissing, "Approved game file unavailable at its source (" + upstream.status + ")");
  }

  const out = corsHeaders(request, {
    "content-type": mime || upstream.headers.get("content-type") || "application/octet-stream",
    "cache-control": cache,
    "x-content-type-options": "nosniff"
  });
  const contentRange = upstream.headers.get("content-range");
  if (contentRange) out.set("content-range", contentRange);
  const acceptRanges = upstream.headers.get("accept-ranges");
  if (acceptRanges) out.set("accept-ranges", acceptRanges);
  // Only a byte-range reply has a body whose length we can safely restate.
  if (upstream.status === 206) {
    const length = upstream.headers.get("content-length");
    if (length) out.set("content-length", length);
  }
  if (request.method === "HEAD") return new Response(null, { status: upstream.status, headers: out });
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

// Always answers with a Response: a transport failure becomes a 502.
async function fetchPinned(request, upstreamUrl, options = {}) {
  const response = await attemptPinned(request, upstreamUrl, options);
  return response || textError(502, "The approved game's source server could not be reached.");
}

// Try each fixed mirror in order; the last failure is reported.
async function fetchPinnedWithFallback(request, sources, options = {}) {
  let last = null;
  for (const source of sources) {
    const response = await attemptPinned(request, source, options);
    if (!response) continue;
    if (response.status !== 502 && response.status !== 416) return response;
    last = response;
  }
  return last || textError(502, "The approved game's source server could not be reached.");
}

// Concatenate several pinned bodies into one response, as the Ocarina ROM and
// the UwU Client HTML both need.
function concatBodies(bodies) {
  return new ReadableStream({
    async start(controller) {
      try {
        for (const body of bodies) {
          const reader = body.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
          } finally {
            reader.releaseLock();
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });
}

async function streamSequence(request, urls, options = {}) {
  const bodies = [];
  if (request.method === "HEAD") {
    // Probe every part without downloading them, so a broken source still
    // reports 502 rather than a convincing 200.
    const checks = await checkUrls(request, urls, options.timeout || 120000);
    if (checks.some(check => !check.ok)) return textError(502, "Approved game source unavailable");
    const headHeaders = corsHeaders(request, {
      "content-type": options.mime || "application/octet-stream",
      "cache-control": options.cache || "public, max-age=3600",
      "x-content-type-options": "nosniff"
    });
    if (options.acceptRanges === false) headHeaders.set("accept-ranges", "none");
    return new Response(null, { status: 200, headers: headHeaders });
  }
  for (const url of urls) {
    let upstream;
    try {
      upstream = await fetch(url, {
        headers: { "accept-encoding": "identity" },
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeout || 120000)
      });
    } catch (error) {
      for (const body of bodies) { try { await body.cancel(); } catch {} }
      return textError(502, "Approved game source unavailable (network error)");
    }
    if (!upstream.ok || !upstream.body) {
      for (const body of bodies) { try { await body.cancel(); } catch {} }
      return textError(502, "Approved game source unavailable (" + upstream.status + ")");
    }
    bodies.push(upstream.body);
  }
  const headers = corsHeaders(request, {
    "content-type": options.mime || "application/octet-stream",
    "cache-control": options.cache || "public, max-age=3600",
    "x-content-type-options": "nosniff"
  });
  if (options.acceptRanges === false) headers.set("accept-ranges", "none");
  return new Response(concatBodies(bodies), { status: 200, headers });
}

async function checkUrls(request, urls, timeout = 30000) {
  const checks = await Promise.all(urls.map(async url => {
    try {
      const response = await fetch(url, {
        method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(timeout)
      });
      try { await response.body?.cancel(); } catch {}
      return { file: url.split("/").slice(-1)[0], ok: response.ok, status: response.status };
    } catch {
      return { file: url.split("/").slice(-1)[0], ok: false, status: 0 };
    }
  }));
  return checks;
}

function safeAssetPath(raw) {
  let file;
  try { file = decodeURIComponent(raw || ""); } catch { return null; }
  if (!file || file.length > 400 || file.startsWith("/") || file.includes("//") ||
      file.includes("\\") || file.split("/").some(part => !part || part === "." || part === "..")) return null;
  if (!/^[A-Za-z0-9._/()# %@+-]+$/.test(file)) return null;
  return file;
}

function encodePath(file) {
  return file.split("/").map(encodeURIComponent).join("/");
}

/* --------------------------------------------------------- pinned sources --- */

const balatroAssets = new Set([
  "manifest.json", "love.js", "love.wasm", "game.js",
  ...Array.from({ length: 7 }, (_, i) => "game-" + String(i).padStart(2, "0") + ".bin")
]);
const balatroRoot = "https://cdn.jsdelivr.net/gh/3cfl/balatro-webport@cb01302a4ee9d3712676daa7a8bf58e04f9e8fa8/";

const cheeseRoot = "https://raw.githubusercontent.com/SomeRandomFella/portsandrips/9546494b3052e8e078fb28df7430ac35f42a8787/CheeseRollingWeb/";
const cheeseAllowedFiles = new Set([
  "index.html",
  "manifest.webmanifest",
  "ServiceWorker.js",
  "Build/CheeseRollingWeb.loader.js",
  "Build/CheeseRollingWeb.framework.js",
  "Build/CheeseRollingWeb.data.part001",
  "Build/CheeseRollingWeb.data.part002",
  "Build/CheeseRollingWeb.data.part003",
  "Build/CheeseRollingWeb.data.part004",
  "Build/CheeseRollingWeb.data.part005",
  "Build/CheeseRollingWeb.wasm.part001",
  "Build/CheeseRollingWeb.wasm.part002",
  "TemplateData/favicon.ico",
  "TemplateData/style.css",
  "TemplateData/progress-bar-empty-dark.png",
  "TemplateData/progress-bar-empty-light.png",
  "TemplateData/progress-bar-full-dark.png",
  "TemplateData/progress-bar-full-light.png",
  "TemplateData/unity-logo-dark.png",
  "TemplateData/unity-logo-light.png",
  "TemplateData/icons/unity-logo-dark.png",
  "TemplateData/icons/unity-logo-light.png"
]);
const cheeseCheckFiles = ["index.html", "Build/CheeseRollingWeb.loader.js", "Build/CheeseRollingWeb.data.part001"];

const horizonRoot = "https://raw.githubusercontent.com/AlexBoops/mc-rust-onweb/b21a7ae704b415182631429a7e71c797287661df/";

const spartaUpstream = "https://psp-web-damon.surge.sh/";
const spartaRoute = "/approved-games/gow-sparta/";
const SPARTA_ORIGIN = "https://seuss-arcade-relay.damonrosshutchins.workers.dev";

const mc18Sources = new Map([
  ["minecraft-18-wrust", {
    id: "1TBtrBMMw9w9lqc3Z3aw4CARG_O04abIM",
    filename: "clwurst.html",
    expectedSize: 27847113
  }],
  ["minecraft-18-mods", {
    id: "17mqNnsALl6ZvDVOtarz4EuP5pS8E4-R9",
    filename: "cleaglerforge.html",
    expectedSize: 1035
  }]
]);
const mc18ForgeCommit = "ba062f533d86966ff2bcddec4f5859aab7c23346";
const mc18ForgeBase = "https://cdn.jsdelivr.net/gh/shayderrr/eaglercraft@" + mc18ForgeCommit + "/PineTools.com_files/cleaglerforge.html.part";
const mc18ForgeRoute = "/approved-games/minecraft-18-mods/assets/forge-part";
function mc18DriveURL(item) {
  const url = new URL("https://drive.usercontent.google.com/download");
  url.searchParams.set("id", item.id);
  url.searchParams.set("export", "download");
  url.searchParams.set("confirm", "t");
  return url.href;
}

// Pinned by commit: the branch moves, so `@main` would let the upstream repo
// swap the game's files (and its manifest) without any change here.
const oneVOneCommit = "af28b6e4c6ac08827a3404d33defd626cd236f74";
const importedAssetRoots = Object.freeze({
  "emu": "https://cdn.jsdelivr.net/gh/bubblfan/emu@main/",
  // Pinned release, not /stable/: the emulator script and its core data must
  // not change under a launcher that was built against one version.
  "emu-4.2.3": "https://cdn.emulatorjs.org/4.2.3/data/",
  "1v1": "https://cdn.jsdelivr.net/gh/n-101-1/1@" + oneVOneCommit + "/"
});
const importedExactAssets=Object.freeze({
  "tomb-mask/UnityLoader.js":"https://cdn.jsdelivr.net/gh/bubbls/UGS-Assets@9cf433220236bb0471ab3a68ec8fe3e0a2799e36/tomb/UnityLoader.js",
  "tomb-mask/totm.json":"https://cdn.jsdelivr.net/gh/bubbls/UGS-Assets@9cf433220236bb0471ab3a68ec8fe3e0a2799e36/tomb/totm.json",
  "tomb-mask/totm.data.unityweb":"https://cdn.jsdelivr.net/gh/bubbls/UGS-Assets@9cf433220236bb0471ab3a68ec8fe3e0a2799e36/tomb/totm.data.unityweb",
  "tomb-mask/totm.wasm.code.unityweb":"https://cdn.jsdelivr.net/gh/bubbls/UGS-Assets@9cf433220236bb0471ab3a68ec8fe3e0a2799e36/tomb/totm.wasm.code.unityweb",
  "tomb-mask/totm.wasm.framework.unityweb":"https://cdn.jsdelivr.net/gh/bubbls/UGS-Assets@9cf433220236bb0471ab3a68ec8fe3e0a2799e36/tomb/totm.wasm.framework.unityweb",
  "tomb-mask/UnityProgress.js":"https://cdn.jsdelivr.net/gh/bubbls/UGS-Assets@9cf433220236bb0471ab3a68ec8fe3e0a2799e36/tomb/UnityProgress.js",
  "tomb-mask/style.css":"https://cdn.jsdelivr.net/gh/bubbls/UGS-Assets@9cf433220236bb0471ab3a68ec8fe3e0a2799e36/tomb/style.css",
  "snow-rider/Build/UnityLoader.js":"https://cdn.jsdelivr.net/gh/Vrkids2009/snowrider3d@6b7c2b9167b592528b221428414e63f06c4640b9/Build/UnityLoader.js",
  "snow-rider/Build/SnowRider3D-gd-1.json":"https://cdn.jsdelivr.net/gh/Vrkids2009/snowrider3d@6b7c2b9167b592528b221428414e63f06c4640b9/Build/SnowRider3D-gd-1.json",
  "snow-rider/Build/SnowRider3D-gd-1.data.unityweb":"https://cdn.jsdelivr.net/gh/Vrkids2009/snowrider3d@6b7c2b9167b592528b221428414e63f06c4640b9/Build/SnowRider3D-gd-1.data.unityweb",
  "snow-rider/Build/SnowRider3D-gd-1.wasm.code.unityweb":"https://cdn.jsdelivr.net/gh/Vrkids2009/snowrider3d@6b7c2b9167b592528b221428414e63f06c4640b9/Build/SnowRider3D-gd-1.wasm.code.unityweb",
  "snow-rider/Build/SnowRider3D-gd-1.wasm.framework.unityweb.js":"https://cdn.jsdelivr.net/gh/Vrkids2009/snowrider3d@6b7c2b9167b592528b221428414e63f06c4640b9/Build/SnowRider3D-gd-1.wasm.framework.unityweb.js",
  "snow-rider/Build/SnowRider3D-gd-1.wasm.framework.unityweb":"https://cdn.jsdelivr.net/gh/Vrkids2009/snowrider3d@6b7c2b9167b592528b221428414e63f06c4640b9/Build/SnowRider3D-gd-1.wasm.framework.unityweb",
  "snow-rider/TemplateData/UnityProgress.js":"https://cdn.jsdelivr.net/gh/Vrkids2009/snowrider3d@6b7c2b9167b592528b221428414e63f06c4640b9/TemplateData/UnityProgress.js",
  "snow-rider/TemplateData/style.css":"https://cdn.jsdelivr.net/gh/Vrkids2009/snowrider3d@6b7c2b9167b592528b221428414e63f06c4640b9/TemplateData/style.css",
  "snow-rider/TemplateData/logo.png":"https://cdn.jsdelivr.net/gh/Vrkids2009/snowrider3d@6b7c2b9167b592528b221428414e63f06c4640b9/TemplateData/logo.png",
  "snow-rider/TemplateData/gears.gif":"https://cdn.jsdelivr.net/gh/Vrkids2009/snowrider3d@6b7c2b9167b592528b221428414e63f06c4640b9/TemplateData/gears.gif",
  "run2/Run2.swf":"https://cdn.jsdelivr.net/gh/bubbls/UGS-file-encryption@f69cc42a2ca577ff18acdf1158d3dc6940afd3d3/Run2.swf",
  "run2/ruffle.js":"https://cdn.jsdelivr.net/npm/@ruffle-rs/ruffle@0.2.0-nightly.2025.10.2/ruffle.js",
  "run2/core.ruffle.9085ee9763de4e85853c.js":"https://cdn.jsdelivr.net/npm/@ruffle-rs/ruffle@0.2.0-nightly.2025.10.2/core.ruffle.9085ee9763de4e85853c.js",
  "run2/core.ruffle.ae1054522f49580946c0.js":"https://cdn.jsdelivr.net/npm/@ruffle-rs/ruffle@0.2.0-nightly.2025.10.2/core.ruffle.ae1054522f49580946c0.js",
  "run2/4d882486fa9bfce731b9.wasm":"https://cdn.jsdelivr.net/npm/@ruffle-rs/ruffle@0.2.0-nightly.2025.10.2/4d882486fa9bfce731b9.wasm",
  "run2/f7f28eb60b84863611ca.wasm":"https://cdn.jsdelivr.net/npm/@ruffle-rs/ruffle@0.2.0-nightly.2025.10.2/f7f28eb60b84863611ca.wasm",
  "zelda-oot/rom.n64.part1":"https://cdn.jsdelivr.net/gh/bubbls/ugss@ffa46738ce21236742f4a44db08d87160fed6c7d/ocarinaoftime/Legend%20of%20Zelda%2C%20The%20-%20Ocarina%20of%20Time%20(USA).n64.part1",
  "zelda-oot/rom.n64.part2":"https://cdn.jsdelivr.net/gh/bubbls/ugss@ffa46738ce21236742f4a44db08d87160fed6c7d/ocarinaoftime/Legend%20of%20Zelda%2C%20The%20-%20Ocarina%20of%20Time%20(USA).n64.part2",
  "centipede/rom.zip":"https://cdn.jsdelivr.net/gh/ap-math-class/exams@main/mame/centiped.zip",
  "fnae/Build/fnae.loader.js":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/Build/fnae.loader.js",
  "fnae/Build/fnae.framework.js":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/Build/fnae.framework.js",
  "fnae/TemplateData/style.css":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/TemplateData/style.css",
  "fnae/TemplateData/favicon.ico":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/TemplateData/favicon.ico",
  "fnae/TemplateData/progress-bar-empty-dark.png":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/TemplateData/progress-bar-empty-dark.png",
  "fnae/TemplateData/progress-bar-empty-light.png":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/TemplateData/progress-bar-empty-light.png",
  "fnae/TemplateData/progress-bar-full-dark.png":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/TemplateData/progress-bar-full-dark.png",
  "fnae/TemplateData/progress-bar-full-light.png":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/TemplateData/progress-bar-full-light.png",
  "fnae/TemplateData/unity-logo-dark.png":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/TemplateData/unity-logo-dark.png",
  "fnae/TemplateData/unity-logo-light.png":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/TemplateData/unity-logo-light.png",
  "fnae/TemplateData/webmemd-icon.png":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/TemplateData/webmemd-icon.png",
  "fnae/StreamingAssets/UnityServicesProjectConfiguration.json":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/StreamingAssets/UnityServicesProjectConfiguration.json",
  "fnae/Build/fnae.data.part1":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/Build/fnae.data.part1",
  "fnae/Build/fnae.data.part2":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/Build/fnae.data.part2",
  "fnae/Build/fnae.data.part3":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/Build/fnae.data.part3",
  "fnae/Build/fnae.wasm.part1":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/Build/fnae.wasm.part1",
  "fnae/Build/fnae.wasm.part2":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/Build/fnae.wasm.part2",
  "fnae/StreamingAssets/202512191935.webm.part1":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/StreamingAssets/202512191935.webm.part1",
  "fnae/StreamingAssets/202512191935.webm.part2":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/StreamingAssets/202512191935.webm.part2",
  "fnae/StreamingAssets/202512191935.webm.part3":"https://cdn.jsdelivr.net/gh/web-ports/fnae@afd4e5071add297d6169665a4f999d62f312532e/StreamingAssets/202512191935.webm.part3",
  "mario-kart/rom.zip":"https://cdn.jsdelivr.net/gh/a456pur/seraph@ae2fcc6d6a9cd051654fcc0519080db1f79cf2a7/games/mariokart64/mariokart64.zip",
});

const uwuClientParts = [
  "https://cdn.jsdelivr.net/gh/shayderrr/eaglercraft@ba062f533d86966ff2bcddec4f5859aab7c23346/uwuclient/cluwuclient.html.part1",
  "https://cdn.jsdelivr.net/gh/shayderrr/eaglercraft@ba062f533d86966ff2bcddec4f5859aab7c23346/uwuclient/cluwuclient.html.part2"
];

const btd6Commit = "9546494b3052e8e078fb28df7430ac35f42a8787";
const btd6Primary = "https://cdn.jsdelivr.net/gh/SomeRandomFella/portsandrips@" + btd6Commit + "/btd6/";
const btd6Fallback = "https://raw.githubusercontent.com/SomeRandomFella/portsandrips/" + btd6Commit + "/btd6/";

const repoHalloweenCommit = "edd5e11fae76bfe8966633f19a6e43935874a8b4";
const repoHalloweenCdn = "https://cdn.jsdelivr.net/gh/Vanta-git/repo-halloween-v1@" + repoHalloweenCommit + "/";
const repoHalloweenRaw = "https://raw.githubusercontent.com/Vanta-git/repo-halloween-v1/" + repoHalloweenCommit + "/";

const gartenCommit = "a82c94ea3e9a2f2cbc2e1d925007947134b4f156";
const gartenCdn = "https://cdn.jsdelivr.net/gh/web-ports/garten-of-banban@" + gartenCommit + "/";
const gartenRaw = "https://raw.githubusercontent.com/web-ports/garten-of-banban/" + gartenCommit + "/";
const gartenFiles=new Set(["game/clay/content/paks/clay-windows.pak.0","game/clay/content/paks/clay-windows.pak.1","game/clay/content/paks/clay-windows.ucas.0","game/clay/content/paks/clay-windows.ucas.1","game/clay/content/paks/clay-windows.ucas.10","game/clay/content/paks/clay-windows.ucas.11","game/clay/content/paks/clay-windows.ucas.12","game/clay/content/paks/clay-windows.ucas.13","game/clay/content/paks/clay-windows.ucas.2","game/clay/content/paks/clay-windows.ucas.3","game/clay/content/paks/clay-windows.ucas.4","game/clay/content/paks/clay-windows.ucas.5","game/clay/content/paks/clay-windows.ucas.6","game/clay/content/paks/clay-windows.ucas.7","game/clay/content/paks/clay-windows.ucas.8","game/clay/content/paks/clay-windows.ucas.9","game/clay/content/paks/clay-windows.utoc.0","game/clay/content/paks/global.ucas.0","game/clay/content/paks/global.utoc.0","game/clay/content/paks/zzz_breadbb_p.pak.0","game/clay/content/paks/zzz_breadbb_p.ucas.0","game/clay/content/paks/zzz_breadbb_p.utoc.0","game/engine/content/slate/cursor/invisible.cur.0","gbb.js","gbb.wasm.part1","gbb.wasm.part10","gbb.wasm.part11","gbb.wasm.part12","gbb.wasm.part13","gbb.wasm.part14","gbb.wasm.part15","gbb.wasm.part16","gbb.wasm.part17","gbb.wasm.part18","gbb.wasm.part19","gbb.wasm.part2","gbb.wasm.part20","gbb.wasm.part21","gbb.wasm.part3","gbb.wasm.part4","gbb.wasm.part5","gbb.wasm.part6","gbb.wasm.part7","gbb.wasm.part8","gbb.wasm.part9","gbb_fflean.1.wasm.part1","gbb_fflean.1.wasm.part2","gbb_fflean.1.wasm.part3","gbb_fflean.1.wasm.part4","gbb_fflean.2.wasm.part1","gbb_fflean.2.wasm.part2","gbb_fflean.2.wasm.part3","gbb_fflean.2.wasm.part4","gbb_fflean.3.wasm.part1","gbb_fflean.3.wasm.part2","gbb_fflean.3.wasm.part3","gbb_fflean.3.wasm.part4","gbb_fflean.4.wasm.part1","gbb_fflean.4.wasm.part2","gbb_fflean.4.wasm.part3","gbb_fflean.4.wasm.part4","gbb_fflean.5.wasm.part1","gbb_fflean.5.wasm.part2","gbb_fflean.5.wasm.part3","gbb_fflean.5.wasm.part4","gbb_fflean.js","gbb_fflean.wasm.part1","gbb_fflean.wasm.part2","gbb_fflean.wasm.part3","gbb_fflean.wasm.part4","gbb_gfx.js","gbb_gfx.wasm","gfx_worker.js","image.bin.part1","image.bin.part2","image.bin.part3","image.bin.part4","image.bin.part5","image.bin.part6","image.bin.part7","image.bin.part8","image.bin.part9","manifest.json","preload.json","programs.json","range_cache.js","seed.json","shadow_store.js","split-assets.json","split-loader.js"]);

const gambleCommit = "d7b3ac61ce6d2cb98e212dfa01ba0df413539a53";
const gambleCdn = "https://cdn.jsdelivr.net/gh/Camzzz-vrgt/gamble-with-your-friends-web@" + gambleCommit + "/game/";
const gambleRaw = "https://raw.githubusercontent.com/Camzzz-vrgt/gamble-with-your-friends-web/" + gambleCommit + "/game/";
const gambleRoute = "/approved-games/gamble-with-your-friends/";

const buckshotCommit = "f8a263b4da11c181e02e31086e5a5c8bc2dd1457";
const buckshotCdn = "https://cdn.jsdelivr.net/gh/Random-Red-Dude-809-4456/buckshot@" + buckshotCommit + "/";
const buckshotRaw = "https://raw.githubusercontent.com/Random-Red-Dude-809-4456/buckshot/" + buckshotCommit + "/";
const buckshotRoute = "/approved-games/buckshot/";
const buckshotFiles = new Set([
  "index.html", "main.js", "style.css", "buckshot-roulette.js",
  "buckshot-roulette.icon.png", "buckshot-roulette.apple-touch-icon.png",
  "buckshot-roulette.png", "buckshot-roulette.audio.worklet.js",
  "buckshot-roulette.audio.position.worklet.js"
]);
// Four Unity ports used to pull their builds straight from a third-party CDN.
// Each mirror below is pinned to one commit and only serves paths inside that
// commit, so every game file reaches the browser through this Worker.
const unityMirrors = Object.freeze({
  "peak": {
    cdn: "https://cdn.jsdelivr.net/gh/skibbsz/jsdelivr-cdns@d4ce675e5ab1bddd8ef03994129d31a8c8b34c67/peak/",
    raw: "https://raw.githubusercontent.com/skibbsz/jsdelivr-cdns/d4ce675e5ab1bddd8ef03994129d31a8c8b34c67/peak/"
  },
  "slimeranch": {
    cdn: "https://cdn.jsdelivr.net/gh/reeyuki/SlimeRanch@eb5348fe5a0f17956daaea873fb161c7142ed0a7/",
    raw: "https://raw.githubusercontent.com/reeyuki/SlimeRanch/eb5348fe5a0f17956daaea873fb161c7142ed0a7/"
  },
  "lobcorp": {
    cdn: "https://cdn.jsdelivr.net/gh/Reeyuki/lobcorp@a8815a5edf746b24ebd8028273c4de80c8f67821/",
    raw: "https://raw.githubusercontent.com/Reeyuki/lobcorp/a8815a5edf746b24ebd8028273c4de80c8f67821/"
  },
  "plague-inc": {
    cdn: "https://cdn.jsdelivr.net/gh/Reeyuki/PlagueIncEvolved@79306ef07b5456ebdc6d25dc023aa61184c1ae27/",
    raw: "https://raw.githubusercontent.com/Reeyuki/PlagueIncEvolved/79306ef07b5456ebdc6d25dc023aa61184c1ae27/"
  },
  "tabs": {
    cdn: "https://cdn.jsdelivr.net/gh/reeyuki/tabs@631e27caca8f082cd60c8d374f7a7a96d422e26f/",
    raw: "https://raw.githubusercontent.com/reeyuki/tabs/631e27caca8f082cd60c8d374f7a7a96d422e26f/"
  }
});
const UNITY_MIRROR_DIRS = new Set(["Build", "StreamingAssets", "TemplateData"]);

function approvedUnityMirrorFile(raw) {
  const file = safeAssetPath(raw || "index.html");
  if (!file) return null;
  const slash = file.indexOf("/");
  if (slash < 0) return file;
  return UNITY_MIRROR_DIRS.has(file.slice(0, slash)) ? file : null;
}

/* ------------------------------------------------------------- rewrites --- */

function spartaRewriteRootPaths(source) {
  return source
    .replaceAll(spartaUpstream, SPARTA_ORIGIN + spartaRoute)
    .replace(/\b(src|href|poster|data|action|srcset)\s*=\s*(["'])\/(?!\/)/gi,
      (_full, attr, quote) => attr + "=" + quote + spartaRoute)
    .replace(/url\(\s*(["']?)\/(?!\/)/gi,
      (_full, quote) => "url(" + quote + spartaRoute);
}

function spartaRewriteHtml(html) {
  let page = spartaRewriteRootPaths(html);
  page = page.replace(/\b(fetch|Worker|SharedWorker|register)\s*\(\s*(["'])\/(?!\/)/g,
    (_full, fn, quote) => fn + "(" + quote + spartaRoute);
  const bridge = "<script>(()=>{" +
    "const upstream=\"" + spartaUpstream.replace(/\/$/, "") + "\";" +
    "const route=\"" + spartaRoute + "\";" +
    "const reroute=(input)=>{try{const value=String(input);" +
    "if(value.startsWith(route))return value;" +
    "if(value.startsWith(\"/\")&&!value.startsWith(\"//\"))return route+value.slice(1);" +
    "const u=new URL(value,location.href);" +
    "if(u.origin===upstream)return route+u.pathname.replace(/^\\//,\"\")+u.search+u.hash;" +
    "}catch(e){}return input;};" +
    "const nativeFetch=window.fetch;window.fetch=function(resource,options){" +
    "if(typeof resource===\"string\"||resource instanceof URL)" +
    "return nativeFetch.call(this,reroute(resource),options);" +
    "if(resource instanceof Request){const rewritten=reroute(resource.url);" +
    "if(rewritten!==resource.url)return nativeFetch.call(this,new Request(rewritten,resource),options);}" +
    "return nativeFetch.call(this,resource,options);};" +
    "const originalOpen=XMLHttpRequest.prototype.open;" +
    "XMLHttpRequest.prototype.open=function(method,url,...rest){return originalOpen.call(this,method,reroute(url),...rest);};" +
    "})();</script>";
  const base = "<base href=\"" + spartaRoute + "\">" + bridge;
  if (/<head\b[^>]*>/i.test(page)) page = page.replace(/<head\b[^>]*>/i, match => match + "\n" + base);
  else page = base + page;
  const back = "<nav id=\"seuss-sparta-back\" style=\"position:fixed;z-index:2147483646;top:8px;left:8px\">" +
    "<a href=\"" + PAGES_ORIGIN + "/Dr-seuss-Moives-Games-test/\" " +
    "style=\"display:inline-block;padding:8px 11px;background:#152821ef;color:#fff;" +
    "border:1px solid #82c9a1;border-radius:8px;font:13px system-ui;text-decoration:none\">" +
    "← Back to Seuss Arcade</a></nav>";
  if (/<body\b[^>]*>/i.test(page)) page = page.replace(/<body\b[^>]*>/i, match => match + "\n" + back);
  return page;
}

/* -------------------------------------------------------------- routing --- */

function approvedGambleFile(raw) {
  const file = safeAssetPath(raw || "index.html") || null;
  if (!file) return null;
  if (["index.html", "Build/build.loader.js", "Build/build.framework.js",
    "assets/port-by-camzzz.png", "StreamingAssets/aa/catalog.bin",
    "StreamingAssets/aa/catalog.hash", "StreamingAssets/aa/settings.json"].includes(file)) return file;
  const chunk = file.match(/^chunks\/build\.(data|wasm)\.part(\d{3})$/);
  if (chunk) {
    const lastPart = chunk[1] === "data" ? 50 : 19;
    if (Number(chunk[2]) >= 1 && Number(chunk[2]) <= lastPart) return file;
  }
  if (/^StreamingAssets\/aa\/StandaloneWindows64\/[A-Za-z0-9._() -]+\.bundle$/.test(file)) return file;
  return null;
}

function approvedBuckshotFile(raw) {
  const file = raw === "" || raw === undefined ? "index.html" : raw;
  if (!file || file.length > 120 || file.includes("/") || file.includes("\\") ||
      !/^[A-Za-z0-9._-]+$/.test(file)) return null;
  if (buckshotFiles.has(file)) return file;
  const part = file.match(/^buckshot-roulette\.(pck|wasm)\.part(\d{1,2})$/);
  if (part) {
    const lastPart = part[1] === "pck" ? 17 : 3;
    if (Number(part[2]) >= 1 && Number(part[2]) <= lastPart) return file;
  }
  return null;
}

function approvedRepoHalloweenFile(raw) {
  const file = safeAssetPath(raw || "");
  if (!file) return null;
  if (file === "split-manifest.json" || file === "Build/1234.loader.js" ||
      file === "Build/1234.framework.js.unityweb") return file;
  const data = file.match(/^Build\/1234\.data\.unityweb\.part(\d{3})$/);
  if (data && Number(data[1]) < 237) return file;
  const wasm = file.match(/^Build\/1234\.wasm\.unityweb\.part(\d{2})$/);
  if (wasm && Number(wasm[1]) < 7) return file;
  if (file.startsWith("StreamingAssets/")) return file;
  return null;
}

function approvedBtd6Asset(raw) {
  const file = safeAssetPath(raw || "");
  if (!file) return null;
  if (!(file.startsWith("Build/") || file.startsWith("StreamingAssets/") ||
    file.startsWith("TemplateData/") || file === "split-loader.js" || file === "manifest.json")) return null;
  return file;
}

function importedAssetUrl(raw) {
  const asset = safeAssetPath(raw || "");
  if (!asset) return null;
  if (importedExactAssets[asset]) return importedExactAssets[asset];
  if (/^pvz\/rom\.nds\.part[1-4]$/.test(asset))
    return "https://cdn.jsdelivr.net/gh/greeniYT/ROM-s@main/pvz/5495%20-%20Plants%20vs.%20Zombies%20(U).nds" + asset.slice("pvz/rom.nds".length);
  const slash = asset.indexOf("/");
  if (slash < 0) return null;
  const category = asset.slice(0, slash), file = asset.slice(slash + 1);
  const root = importedAssetRoots[category];
  if (!root || !file) return null;
  return root + encodePath(file);
}

const pinnedUnitySources = [
  ["tomb-mask/", "https://cdn.jsdelivr.net/gh/bubbls/UGS-Assets@9cf433220236bb0471ab3a68ec8fe3e0a2799e36/tomb/", "https://raw.githubusercontent.com/bubbls/UGS-Assets/9cf433220236bb0471ab3a68ec8fe3e0a2799e36/tomb/"],
  ["snow-rider/", "https://cdn.jsdelivr.net/gh/Vrkids2009/snowrider3d@6b7c2b9167b592528b221428414e63f06c4640b9/", "https://raw.githubusercontent.com/Vrkids2009/snowrider3d/6b7c2b9167b592528b221428414e63f06c4640b9/"]
];

async function handleApproved(request, env, url) {
  const pathname = url.pathname;

  /* ------------------------------------------------------------- statuses --- */
  if (pathname === "/approved-games/cheese/status") {
    const checks = await checkUrls(request, cheeseCheckFiles.map(file => cheeseRoot + file));
    const ok = checks.every(check => check.ok);
    return json({
      ok, source: "SomeRandomFella/portsandrips/CheeseRollingWeb",
      revision: "9546494b3052e8e078fb28df7430ac35f42a8787", checks,
      note: ok ? "Pinned Unity game entry, loader and first data part reachable" : "One or more pinned game files are unavailable"
    }, ok ? 200 : 502);
  }
  if (pathname === "/approved-games/gow-sparta/status") {
    try {
      const response = await fetch(spartaUpstream, { redirect: "manual", signal: AbortSignal.timeout(12000) });
      try { await response.body?.cancel(); } catch {}
      return json({
        ok: response.ok, upstreamStatus: response.status, source: "fixed Surge game host",
        note: response.ok ? "Surge source reachable" : "Surge source returned an error"
      }, response.ok ? 200 : 502);
    } catch (error) {
      console.warn("sparta status failed", String(error));
      return json({ ok: false, note: "The approved Surge game source is not reachable from Cloudflare" }, 502);
    }
  }
  for (const [slug, item] of mc18Sources) {
    if (pathname === "/approved-games/" + slug + "/status") {
      try {
        const upstream = await fetch(mc18DriveURL(item), {
          redirect: "manual", signal: AbortSignal.timeout(20000), headers: { "user-agent": "Mozilla/5.0" }
        });
        const disposition = upstream.headers.get("content-disposition") || "";
        const size = Number(upstream.headers.get("content-length") || 0);
        const ok = upstream.ok && disposition.toLowerCase().includes(item.filename.toLowerCase()) &&
          (!size || size === item.expectedSize);
        try { await upstream.body?.cancel(); } catch {}
        return json({
          ok, file: item.filename, source: "fixed Google Drive file ID",
          message: ok ? "Approved game file reachable" : "Approved game file unavailable or changed"
        }, ok ? 200 : 502);
      } catch {
        return json({ ok: false, message: "The approved game file could not be reached" }, 502);
      }
    }
  }
  if (pathname === gambleRoute + "status") {
    try {
      const probe = await fetch(gambleCdn + "index.html", {
        method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(15000)
      });
      try { await probe.body?.cancel(); } catch {}
      if (!probe.ok) return json({ ok: false, note: "Pinned game entry unavailable (HTTP " + probe.status + ")" }, 502);
      return json({ ok: true, source: "pinned GitHub upstream", commit: gambleCommit, parts: 69 });
    } catch {
      return json({ ok: false, note: "The approved game source could not be reached" }, 502);
    }
  }
  if (pathname === buckshotRoute + "status") {
    try {
      const probe = await fetch(buckshotCdn + "index.html", {
        method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(15000)
      });
      try { await probe.body?.cancel(); } catch {}
      if (!probe.ok) return json({ ok: false, note: "Pinned game entry unavailable (HTTP " + probe.status + ")" }, 502);
      return json({ ok: true, source: "pinned GitHub upstream", commit: buckshotCommit, parts: 20 });
    } catch {
      return json({ ok: false, note: "The approved game source could not be reached" }, 502);
    }
  }

  /* ---------------------------------------------------------------- games --- */

  if (pathname === "/approved-games/gow-sparta" || pathname === "/approved-games/gow-sparta/") {
    if (pathname === "/approved-games/gow-sparta") return Response.redirect(url.origin + spartaRoute, 308);
    // Fall through to the wildcard handler with an empty remainder.
    return serveSparta(request, url, "");
  }
  if (pathname.startsWith(spartaRoute) && !pathname.startsWith(spartaRoute + "status")) {
    return serveSparta(request, url, pathname.slice(spartaRoute.length));
  }

  if (pathname.startsWith("/approved-games/cheese/")) {
    const file = pathname.slice("/approved-games/cheese/".length);
    if (!cheeseAllowedFiles.has(file)) return textError(404, "Not an approved Cheese Rolling file");
    if (file === "index.html") return serveCheeseIndex(request);
    return fetchPinned(request, cheeseRoot + file, {
      mime: file.endsWith(".js") ? "application/javascript; charset=utf-8" :
        file.endsWith(".css") ? "text/css; charset=utf-8" :
        file.endsWith(".webmanifest") ? "application/manifest+json" :
        file.endsWith(".png") ? "image/png" :
        file.endsWith(".ico") ? "image/x-icon" : undefined,
      timeout: 120000
    });
  }

  /* ------------------------------------------------- archived site games --- */

  if (pathname === "/approved-games/happywheels") return Response.redirect(url.origin + HW_ROUTE, 308);
  if (pathname === HW_ROUTE || pathname === HW_ROUTE + "index.html") {
    return serveArchivedHtml(request, HW_PAGE, page => happyWheelsHtml(page, url.origin));
  }
  if (pathname.startsWith(HW_ROUTE)) {
    const raw = pathname.slice(HW_ROUTE.length);
    if (raw === "config.json") return serveHappyWheelsConfig(request);
    if (raw === "intro.js") {
      return fetchPinned(request, HW_INTRO, {
        mime: "application/javascript; charset=utf-8", cache: "public, max-age=86400", timeout: 45000
      });
    }
    if (raw.startsWith("api/")) return serveHappyWheelsApi(request, url);
    if (raw === "game/backend-config.js") return serveHappyWheelsBackendConfig(request, url.origin);
    if (raw.startsWith("game/")) {
      const file = archivedGameFile(raw.slice("game/".length));
      if (!file) return textError(404, "Not an approved Happy Wheels file");
      return fetchPinned(request, HW_ASSET_ROOT + encodePath(file), {
        mime: mimeFor(file), cache: "public, max-age=86400, immutable", timeout: 120000
      });
    }
    return textError(404, "Not an approved Happy Wheels route");
  }

  if (pathname.startsWith(DISPATCH_ROUTE + "lfs/")) {
    const file = archivedGameFile(pathname.slice((DISPATCH_ROUTE + "lfs/").length));
    if (!file) return textError(404, "Not an approved Dispatch asset");
    return fetchPinned(request, DISPATCH_LFS_ROOT + encodePath(file), {
      cache: "public, max-age=86400, immutable", timeout: 180000
    });
  }
  if (pathname === "/approved-games/dispatch") return Response.redirect(url.origin + DISPATCH_ROUTE, 308);
  if (pathname.startsWith(DISPATCH_ROUTE)) {
    const raw = pathname.slice(DISPATCH_ROUTE.length);
    if (raw === "" || raw === "index.html") {
      return serveArchivedHtml(request, archivedGames.dispatch.base + "index.html",
        page => dispatchHtml(page, url.origin));
    }
    const file = archivedGameFile(raw);
    if (!file) return textError(404, "Not an approved Dispatch file");
    return fetchPinned(request, archivedGames.dispatch.base + encodePath(file), {
      mime: mimeFor(file), cache: "public, max-age=86400", timeout: 180000
    });
  }

  if (pathname === "/approved-games/needle") return Response.redirect(url.origin + NEEDLE_ROUTE, 308);
  if (pathname.startsWith(NEEDLE_ROUTE)) {
    const raw = pathname.slice(NEEDLE_ROUTE.length);
    if (raw === "" || raw === "index.html") {
      return serveArchivedHtml(request, archivedGames.needle.base + "index.html", page => page, { isolated: true });
    }
    const file = archivedGameFile(raw);
    if (!file) return textError(404, "Not an approved FindTheNeedle file");
    return fetchPinned(request, archivedGames.needle.base + encodePath(file), {
      mime: mimeFor(file), cache: "public, max-age=86400", timeout: 180000
    });
  }

  for (const [slug, mirror] of Object.entries(unityMirrors)) {
    const prefix = "/approved-games/" + slug + "/";
    if (!pathname.startsWith(prefix)) continue;
    const file = approvedUnityMirrorFile(pathname.slice(prefix.length));
    if (!file) return textError(404, "Not an approved " + slug + " game file");
    // jsDelivr answers a ranged request with an empty 206, so ranges go straight
    // to GitHub raw, which honours them.
    const sources = request.headers.get("Range")
      ? [mirror.raw + encodePath(file)]
      : [mirror.cdn + encodePath(file), mirror.raw + encodePath(file)];
    return fetchPinnedWithFallback(request, sources, {
      mime: mimeFor(file), cache: "public, max-age=86400, immutable", timeout: 180000
    });
  }

  if (pathname === "/approved-games/horizon/parts.json") {
    return fetchPinned(request, horizonRoot + "parts.json", { mime: "application/json; charset=utf-8" });
  }
  if (pathname.startsWith("/approved-games/horizon/fs/res/assets/minecraft/")) {
    const file = pathname.slice("/approved-games/horizon/fs/res/assets/minecraft/".length);
    if (!/^sound[.]tar[.]gz[.]part(0|[1-9]|1[0-7])$/.test(file)) return textError(404, "Not an approved Horizon sound part");
    return fetchPinned(request, horizonRoot + "fs/res/assets/minecraft/" + file, { timeout: 120000 });
  }

  for (const [slug, item] of mc18Sources) {
    if (pathname === "/approved-games/" + slug + "/index.html") return serveMc18Html(request, item);
  }
  if (pathname.startsWith(mc18ForgeRoute)) {
    const tail = pathname.slice(mc18ForgeRoute.length);
    if (!/^[1-4]$/.test(tail)) return textError(404, "Not an approved Forge part");
    return fetchPinned(request, mc18ForgeBase + tail, {
      mime: "text/plain; charset=utf-8", cache: "public, max-age=86400, immutable", timeout: 150000
    });
  }

  if (pathname === "/approved-games/uwu-client/index.html") {
    return streamSequence(request, uwuClientParts, {
      mime: "text/html; charset=utf-8", cache: "public, max-age=300", timeout: 120000
    });
  }

  if (pathname.startsWith(gambleRoute)) {
    const file = approvedGambleFile(pathname.slice(gambleRoute.length));
    if (!file) return textError(404, "Not an approved Gamble With Your Friends file");
    const cache = file === "index.html" ? "public, max-age=300" : "public, max-age=86400, immutable";
    // jsDelivr answers a byte-range request with an empty 206 body, so ranged
    // reads go straight to GitHub raw, which honours ranges correctly.
    const sources = request.headers.get("Range")
      ? [gambleRaw + encodePath(file)]
      : [gambleCdn + encodePath(file), gambleRaw + encodePath(file)];
    return fetchPinnedWithFallback(request, sources, { mime: mimeFor(file), cache, timeout: 120000 });
  }

  if (pathname.startsWith(buckshotRoute)) {
    const file = approvedBuckshotFile(pathname.slice(buckshotRoute.length));
    if (!file) return textError(404, "Not an approved Buckshot Roulette file");
    const cache = file === "index.html" ? "public, max-age=300" : "public, max-age=86400, immutable";
    const sources = request.headers.get("Range")
      ? [buckshotRaw + file]
      : [buckshotCdn + file, buckshotRaw + file];
    return fetchPinnedWithFallback(request, sources, { mime: mimeFor(file), cache, timeout: 180000 });
  }

  /* -------------------------------------------------------------- assets --- */

  if (pathname.startsWith("/approved-assets/balatro/")) {
    const file = pathname.slice("/approved-assets/balatro/".length);
    if (!balatroAssets.has(file)) return textError(404, "Not an approved Balatro file");
    return fetchPinned(request, balatroRoot + file, { mime: mimeFor(file) });
  }

  if (pathname === "/approved-assets/imported/zelda-oot/rom.n64") {
    return streamSequence(request, [
      importedExactAssets["zelda-oot/rom.n64.part1"],
      importedExactAssets["zelda-oot/rom.n64.part2"]
    ], { mime: "application/octet-stream", cache: "public, max-age=3600", timeout: 90000, acceptRanges: false });
  }

  if (pathname.startsWith("/approved-assets/imported/")) {
    const asset = safeAssetPath(pathname.slice("/approved-assets/imported/".length));
    if (!asset) return textError(404, "Not an approved imported asset");
    const target = importedAssetUrl(asset);
    if (!target) return textError(404, "Not an approved imported asset");
    if (asset === "1v1/2.7.json") return serve11Manifest(request, target);
    if (firebaseSdkAssets.has(asset)) return serve11FirebaseSdk(request, target);
    for (const [prefix, primaryBase, fallbackBase] of pinnedUnitySources) {
      if (asset.startsWith(prefix) && Object.hasOwn(importedExactAssets, asset) && target.startsWith(primaryBase)) {
        return fetchPinnedWithFallback(request, [target, fallbackBase + target.slice(primaryBase.length)], {
          mime: mimeFor(asset), timeout: 45000
        });
      }
    }
    return fetchPinned(request, target, { mime: mimeFor(asset), timeout: 45000 });
  }

  if (pathname.startsWith("/approved-assets/repo-halloween/")) {
    const asset = approvedRepoHalloweenFile(pathname.slice("/approved-assets/repo-halloween/".length));
    if (!asset) return textError(404, "Not an approved R.E.P.O. game file");
    return fetchPinnedWithFallback(request, [repoHalloweenCdn + encodePath(asset), repoHalloweenRaw + encodePath(asset)], {
      mime: mimeFor(asset), cache: "public, max-age=86400, immutable", timeout: 120000
    });
  }

  if (pathname.startsWith("/approved-assets/btd6/")) {
    const asset = approvedBtd6Asset(pathname.slice("/approved-assets/btd6/".length));
    if (!asset) return textError(404, "Unapproved Bloons TD 6 file");
    return fetchPinnedWithFallback(request, [btd6Primary + encodePath(asset), btd6Fallback + encodePath(asset)], {
      mime: mimeFor(asset), cache: "public, max-age=86400, immutable", timeout: 120000
    });
  }

  if (pathname.startsWith("/approved-assets/garten/")) {
    const asset = gartenFiles.has(pathname.slice("/approved-assets/garten/".length))
      ? pathname.slice("/approved-assets/garten/".length) : null;
    if (!asset) return textError(404, "Not an approved Garten of Banban asset");
    return fetchPinnedWithFallback(request, [gartenCdn + encodePath(asset), gartenRaw + encodePath(asset)], {
      mime: mimeFor(asset), cache: "public, max-age=86400, immutable", timeout: 120000
    });
  }

  return textError(404, "Not an approved arcade route");
}

function spartaFileUrl(raw, search) {
  if (!safeAssetPath(raw || "index.html")) return null;
  const file = raw || "index.html";
  const target = new URL(file, spartaUpstream);
  if (target.origin !== new URL(spartaUpstream).origin) return null;
  target.search = search; // a query may select an asset version, never a hostname
  return target.href;
}

async function serveSparta(request, url, remainder) {
  const upstreamUrl = spartaFileUrl(remainder, url.search);
  if (!upstreamUrl) return textError(404, "Not an approved PSP game file");
  const headers = new Headers({ "accept-encoding": "identity" });
  const range = request.headers.get("Range");
  if (range) {
    if (!RANGE.test(range)) return textError(416, "Unsupported byte range");
    headers.set("range", range);
  }
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers, redirect: "manual", signal: AbortSignal.timeout(120000)
    });
  } catch (error) {
    console.warn("sparta fetch failed", upstreamUrl, String(error));
    return textError(502, "The approved Surge game file could not be fetched");
  }
  if (!upstream.ok) {
    try { await upstream.body?.cancel(); } catch {}
    return textError(502, "The approved Surge game file is unavailable (" + upstream.status + ")");
  }
  const contentType = upstream.headers.get("content-type") || "application/octet-stream";
  const contentLength = Number(upstream.headers.get("content-length") || 0);
  if (/text\/html/i.test(contentType) && (!contentLength || contentLength <= 8000000)) {
    const html = await upstream.text();
    if (html.length > 8000000) return textError(502, "Game HTML exceeds safe rewrite size");
    return new Response(spartaRewriteHtml(html), {
      status: 200,
      headers: corsHeaders(request, {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff"
      })
    });
  }
  if (/text\/css/i.test(contentType) && (!contentLength || contentLength <= 2000000)) {
    const css = await upstream.text();
    if (css.length > 2000000) return textError(502, "Game CSS exceeds safe rewrite size");
    return new Response(spartaRewriteRootPaths(css), {
      status: 200,
      headers: corsHeaders(request, {
        "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff"
      })
    });
  }
  const out = corsHeaders(request, {
    "content-type": contentType, "cache-control": "public, max-age=300", "x-content-type-options": "nosniff"
  });
  const contentRange = upstream.headers.get("content-range");
  if (contentRange) out.set("content-range", contentRange);
  const acceptRanges = upstream.headers.get("accept-ranges");
  if (acceptRanges) out.set("accept-ranges", acceptRanges);
  if (upstream.status === 206) {
    const length = upstream.headers.get("content-length");
    if (length) out.set("content-length", length);
  }
  if (request.method === "HEAD") return new Response(null, { status: upstream.status, headers: out });
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

// 1v1.LOL's Unity manifest points its own build files straight at the CDN, so
// the game pulled its data and wasm around the Worker. Rewrite them onto this
// route so every file the game needs is served through Cloudflare.
async function serve11Manifest(request, target) {
  let upstream;
  try {
    upstream = await fetch(target, { signal: AbortSignal.timeout(30000) });
  } catch (error) {
    console.warn("1v1 manifest fetch failed", String(error));
    return textError(502, "The 1v1.LOL manifest is unavailable");
  }
  if (!upstream.ok) {
    try { await upstream.body?.cancel(); } catch {}
    return textError(502, "The 1v1.LOL manifest is unavailable (" + upstream.status + ")");
  }
  let manifest;
  try {
    manifest = await upstream.json();
  } catch {
    return textError(502, "The 1v1.LOL manifest is not valid JSON");
  }
  // Built against the origin this request arrived on, so the game's files come
  // back through the same host (workers.dev, a custom domain, a local dev port).
  const base = new URL("/approved-assets/imported/1v1/", request.url);
  for (const key of ["dataUrl", "wasmCodeUrl", "wasmFrameworkUrl", "asmCodeUrl", "asmFrameworkUrl"]) {
    const value = manifest[key];
    if (typeof value !== "string" || !value) continue;
    if (!/^https:\/\//.test(value)) continue;
    const file = value.slice(value.lastIndexOf("/") + 1);
    if (!/^[A-Za-z0-9._-]+$/.test(file)) return textError(502, "Unexpected 1v1.LOL build file name");
    manifest[key] = new URL(file, base).href;
  }
  return new Response(request.method === "HEAD" ? null : JSON.stringify(manifest), {
    status: 200,
    headers: corsHeaders(request, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff"
    })
  });
}

/* --------------------------------------------- 1v1.LOL Firebase relay --- */

// The game's Firebase SDK normally calls Google directly for auth tokens and
// Firestore. Its bundles are rewritten (serve11FirebaseSdk) to send those calls
// here instead, so the data and token traffic goes through Cloudflare. Google
// sign-in itself is deliberately left alone: signInWithPopup opens the project's
// firebaseapp.com auth domain, which cannot be proxied without breaking OAuth.
const FIREBASE_ROUTE = "/firebase/1v1/";
const firebaseUpstreams = Object.freeze({
  // identitytoolkit: sign-in/sign-up REST methods (the game's own accounts).
  idt: "https://www.googleapis.com/identitytoolkit/v3/relyingparty/",
  // securetoken: ID-token refresh.
  st: "https://securetoken.googleapis.com/v1/",
  // firestore: the game's live data store.
  fs: "https://firestore.googleapis.com/"
});
const firebaseSdkAssets = new Set(["1v1/1firebase-auth.js", "1v1/1firebase-firestore.js"]);
// Only the endpoints the pinned Firebase auth bundle calls are relayed; this is
// not a general Google proxy, so any other path is refused before a fetch.
const firebaseIdtMethods = new Set([
  "signupNewUser", "verifyPassword", "verifyAssertion", "verifyCustomToken",
  "setAccountInfo", "getAccountInfo", "getProjectConfig", "getOobConfirmationCode",
  "getRecaptchaParam", "resetPassword", "verifyPasswordResetCode", "deleteAccount",
  "sendVerificationCode"
]);
// Firestore builds document paths at load time, so its lock is the game's own
// project and database rather than a fixed endpoint list.
const FIREBASE_FIRESTORE_PREFIX = "v1/projects/justbuild-cdb86/databases/(default)/documents";
const FIREBASE_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
const FIREBASE_DROP_HEADERS = new Set([
  "host", "connection", "content-length", "accept-encoding", "cookie", "origin", "referer",
  "upgrade-insecure-requests", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"
]);

// The Firebase SDK sends its XHRs with credentials, so the exact origin plus
// allow-credentials is required; a bare wildcard would be rejected.
function firebaseCors(request, response) {
  const origin = request.headers.get("Origin");
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  // Firestore's WebChannel reads these to learn the session Google assigned; a
  // cross-origin client cannot see them unless they are exposed explicitly.
  headers.set("access-control-expose-headers", "X-HTTP-Session-Id, X-Client-Wire-Protocol");
  headers.set("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function firebasePreflight(request) {
  // Echo the requested header list back: the SDK sends its own x-goog-* and
  // x-firebase-* headers, and a fixed list would fail preflight as it changes.
  const headers = corsHeaders(request, {
    "access-control-allow-methods": FIREBASE_METHODS,
    "access-control-allow-headers": request.headers.get("access-control-request-headers") || "authorization, content-type, accept",
    "access-control-allow-credentials": "true",
    "access-control-max-age": "600"
  });
  headers.set("cache-control", "no-store");
  return new Response(null, { status: 204, headers });
}

// Firestore keeps a long-lived streaming channel, so the body is passed through
// untouched rather than buffered or parsed.
async function handleFirebaseRelay(request, url) {
  if (request.method === "OPTIONS") return firebasePreflight(request);
  if (!FIREBASE_METHODS.split(", ").includes(request.method)) {
    return firebaseCors(request, textError(405, "Unsupported method for the Firebase route"));
  }
  const tail = url.pathname.slice(FIREBASE_ROUTE.length);
  const slash = tail.indexOf("/");
  const bucket = slash < 0 ? tail : tail.slice(0, slash);
  const rest = slash < 0 ? "" : tail.slice(slash + 1);
  const upstream = firebaseUpstreams[bucket];
  if (!upstream || !approvedFirebaseTarget(bucket, rest, url)) {
    return firebaseCors(request, textError(404, "Not an approved Firebase route"));
  }
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (FIREBASE_DROP_HEADERS.has(lower) || lower.startsWith("cf-") || lower.startsWith("x-forwarded-")) continue;
    headers.set(name, value);
  }
  const init = {
    method: request.method,
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(120000)
  };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  let response;
  try {
    response = await fetch(upstream + rest + url.search, init);
  } catch (error) {
    console.warn("firebase relay failed", url.pathname, String(error));
    return firebaseCors(request, textError(502, "The Firebase endpoint could not be reached"));
  }
  const out = new Headers();
  for (const name of ["content-type", "content-disposition", "retry-after", "x-http-session-id", "x-client-wire-protocol"]) {
    const value = response.headers.get(name);
    if (value) out.set(name, value);
  }
  out.set("cache-control", "no-store");
  out.set("x-content-type-options", "nosniff");
  return firebaseCors(request, new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    headers: out
  }));
}

function approvedFirebaseTarget(bucket, rest, url) {
  if (!rest || rest.length > 600) return false;
  if (rest.split("/").some(part => !part || part === "." || part === "..")) return false;
  if (bucket === "idt") return firebaseIdtMethods.has(rest);
  if (bucket === "st") return rest === "token";
  if (bucket !== "fs") return false;
  if (rest === FIREBASE_FIRESTORE_PREFIX ||
      rest.startsWith(FIREBASE_FIRESTORE_PREFIX + "/") ||
      rest.startsWith(FIREBASE_FIRESTORE_PREFIX + ":")) return true;
  // Firestore's live channel names the database in its query string, so that
  // shape is accepted only for the game's own database.
  if (!/^google\.firestore\.v1\.Firestore\/[A-Za-z]+\/(?:[A-Za-z0-9-]+\/)?channel$/.test(rest)) return false;
  const database = url.searchParams.get("database");
  return database === null || database === "projects/justbuild-cdb86/databases/(default)";
}

// The SDK bundles carry the Google hosts in plain strings; point them at this
// origin, taken from the request so a custom domain or a dev port still works.
async function serve11FirebaseSdk(request, target) {
  let upstream;
  try {
    upstream = await fetch(target, { signal: AbortSignal.timeout(45000) });
  } catch (error) {
    console.warn("1v1 firebase sdk fetch failed", String(error));
    return textError(502, "The 1v1.LOL Firebase bundle is unavailable");
  }
  if (!upstream.ok) {
    try { await upstream.body?.cancel(); } catch {}
    return textError(502, "The 1v1.LOL Firebase bundle is unavailable (" + upstream.status + ")");
  }
  const origin = new URL(request.url).origin;
  const host = new URL(origin).host;
  const source = (await upstream.text())
    .replaceAll("https://www.googleapis.com/identitytoolkit/v3/relyingparty/", origin + FIREBASE_ROUTE + "idt/")
    .replaceAll("https://securetoken.googleapis.com/v1/token", origin + FIREBASE_ROUTE + "st/token")
    // Firestore builds its URLs as https://<host>/v1/..., so the prefix rides on
    // the host string itself.
    .replaceAll('"firestore.googleapis.com"', JSON.stringify(host + FIREBASE_ROUTE + "fs"));
  return new Response(request.method === "HEAD" ? null : source, {
    status: 200,
    headers: corsHeaders(request, {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff"
    })
  });
}

async function serveCheeseIndex(request) {
  let upstream;
  try {
    upstream = await fetch(cheeseRoot + "index.html", { redirect: "manual", signal: AbortSignal.timeout(30000) });
  } catch {
    return textError(502, "The pinned Cheese Rolling entry cannot be loaded through Cloudflare.");
  }
  if (!upstream.ok) {
    try { await upstream.body?.cancel(); } catch {}
    return textError(502, "Approved Cheese Rolling entry unavailable (" + upstream.status + ")");
  }
  const html = await upstream.text();
  if (!/<base\b[^>]*>/i.test(html)) return textError(502, "Pinned Cheese Rolling HTML has no expected base element");
  // The upstream page opens with a joke alert() and reports Unity failures with
  // alert(). In a sandboxed arcade frame modals are dropped without "allow-modals",
  // so failures were silent, and at top level the modal blocks the loader script
  // before it fetches anything. Send both to a visible notice bar instead.
  const notice = '<script>window.__cheeseNotice=function(message){try{console.warn("[Cheese Rolling]",message);' +
    'var box=document.getElementById("cheeseNotice");if(!box){box=document.createElement("div");box.id="cheeseNotice";' +
    'box.setAttribute("role","status");box.style.cssText="position:fixed;left:0;right:0;bottom:0;z-index:9;padding:10px 14px;' +
    'background:#141b24;border-top:1px solid #2c3b4d;color:#e6f6ff;font:13px/1.4 system-ui,sans-serif";' +
    'document.body.appendChild(box);}box.textContent=String(message);}catch(error){}};<\/script>';
  let served = html
    .replace(/<base\b[^>]*>/i, '<base href="/approved-games/cheese/">')
    .replace(/\balert\s*\(/g, "__cheeseNotice(");
  served = /<head\b[^>]*>/i.test(served)
    ? served.replace(/<head\b[^>]*>/i, match => match + notice)
    : notice + served;
  return new Response(served, {
    status: 200,
    headers: corsHeaders(request, {
      "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff"
    })
  });
}

async function serveMc18Html(request, item) {
  const headers = new Headers({ "accept-encoding": "identity", "user-agent": "Mozilla/5.0" });
  let upstream;
  try {
    upstream = await fetch(mc18DriveURL(item), { redirect: "manual", signal: AbortSignal.timeout(150000), headers });
  } catch (error) {
    console.warn("drive fetch failed", item.filename, String(error));
    return textError(502, "Minecraft game source is temporarily unavailable");
  }
  if (!upstream.ok) {
    try { await upstream.body?.cancel(); } catch {}
    return textError(502, "Approved Drive file is unavailable (" + upstream.status + ")");
  }
  const disposition = upstream.headers.get("content-disposition") || "";
  const size = Number(upstream.headers.get("content-length") || 0);
  // Google may return an HTML login or quota notice with status 200.
  if (!disposition.toLowerCase().includes(item.filename.toLowerCase()) ||
      (size && size !== item.expectedSize)) {
    try { await upstream.body?.cancel(); } catch {}
    return textError(502, "The approved Google Drive game file is unavailable or changed. Check its public sharing and version.");
  }
  const out = corsHeaders(request, {
    "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff"
  });
  if (request.method === "HEAD") {
    try { await upstream.body?.cancel(); } catch {}
    return new Response(null, { status: 200, headers: out });
  }
  if (item.id === "17mqNnsALl6ZvDVOtarz4EuP5pS8E4-R9") {
    const html = await upstream.text();
    if (html.length > 10000) return textError(502, "The mod launcher changed format");
    let modified = html;
    for (let i = 1; i <= 4; i++) {
      const source = "https://cdn.jsdelivr.net/gh/shayderrr/eaglercraft@main/PineTools.com_files/cleaglerforge.html.part" + i;
      if (!modified.includes(source)) return textError(502, "Expected Forge launcher asset is missing");
      modified = modified.replaceAll(source, mc18ForgeRoute + i);
    }
    return new Response(modified, { status: 200, headers: out });
  }
  return new Response(upstream.body, { status: 200, headers: out });
}

/* ------------------------------------------------- legacy Minecraft site --- */

// The MCTM legacy-console Minecraft launcher only exists on a Cloudflare-hosted
// Pages site that sends X-Frame-Options: DENY plus frame-ancestors 'none', so
// neither an iframe nor the Wisp relay (Cloudflare refuses sockets to its own
// addresses) can open it. Serve that one site from this origin instead: the
// page keeps its own absolute paths, so paths are passed through unchanged and
// only the framing and CSP headers are dropped.
const LEGACY_ORIGIN = "https://mclegacy.pages.dev";
const LEGACY_TIMEOUT_MS = 120000;
// Body metadata only. content-length and content-encoding are left out because
// the runtime decompresses the upstream body before it reaches us.
const LEGACY_HEADERS = ["content-type", "etag", "last-modified", "cache-control", "content-range", "accept-ranges", "content-disposition"];

async function handleLegacyMirror(request, url) {
  if (request.method === "OPTIONS") return preflight(request);
  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
    return textError(405, "Only GET, HEAD and POST are supported here");
  }
  // The launcher and game pages bounce first-time visitors to the author's
  // long animated letter before they will render. The arcade opens the
  // launcher directly, so mark the letter as read instead of redirecting.
  if (/^\/r\/[0-9a-f]+\/letter-gate\.js$/.test(url.pathname)) {
    return new Response('try{localStorage.setItem("webcraft.letter.v1","seen")}catch(e){}', {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "public, max-age=300",
        "access-control-allow-origin": "*"
      }
    });
  }
  const target = LEGACY_ORIGIN + url.pathname + url.search;
  const headers = new Headers();
  const range = request.headers.get("Range");
  if (range && RANGE.test(range)) headers.set("Range", range);
  for (const name of ["Content-Type", "Accept"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "POST" ? request.body : undefined,
      redirect: "follow",
      signal: AbortSignal.timeout(LEGACY_TIMEOUT_MS)
    });
  } catch (error) {
    console.warn("legacy mirror failed", url.pathname, String(error));
    return textError(502, "The legacy Minecraft site could not be reached");
  }
  const out = new Headers();
  for (const name of LEGACY_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  const isHtml = (out.get("content-type") || "").includes("text/html");
  // Launcher pages change between releases; the game's own files are named by
  // content hash, so they can be cached hard.
  out.set("cache-control", isHtml ? "no-store" : "public, max-age=86400");
  out.set("access-control-allow-origin", "*");
  out.set("x-robots-tag", "noindex");
  // The game is a threaded Unity build: it transfers SharedArrayBuffer to its
  // workers, which the browser only allows on a cross-origin isolated page.
  // GitHub Pages cannot send these headers, this origin can. Isolation is
  // decided by the document, so only pages carry them.
  if (isHtml) {
    out.set("cross-origin-opener-policy", "same-origin");
    out.set("cross-origin-embedder-policy", "require-corp");
    if (request.method === "HEAD") return new Response(null, { status: upstream.status, headers: out });
    // The Pages host appends its own analytics beacon after the page; the
    // mirrored launcher must not talk to static.cloudflareinsights.com.
    let page;
    try {
      page = await upstream.text();
    } catch (error) {
      console.warn("legacy mirror read failed", url.pathname, String(error));
      return textError(502, "The legacy Minecraft site returned an unreadable page");
    }
    page = page
      .replaceAll("<!-- Cloudflare Pages Analytics -->", "")
      .replace(/<script[^>]*static\.cloudflareinsights\.com[^>]*><\/script>/gi, "");
    return new Response(page, { status: upstream.status, headers: out });
  }
  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: out
  });
}

/* ------------------------------------------- mirrored GitHub Pages games --- */

// Three GitHub Pages games load their own directory trees with relative URLs,
// and two of them also pull from a fixed asset host. Serving all of it from
// this origin keeps every request inside the Worker instead of the browser
// talking to nawsif.github.io, jsDelivr, media.githubusercontent.com or the
// game's own Workers backend directly.
const NW_SITE = "https://nawsif.github.io";
const HW_PAGE = NW_SITE + "/html/happywheels";
const HW_ASSET_COMMIT = "80b52b89d6e2739e79378ef2512cd86e2ef79c7c";
const HW_ASSET_ROOT = "https://cdn.jsdelivr.net/gh/nawsif/host@" + HW_ASSET_COMMIT + "/HappyWheels/";
const HW_INTRO = "https://tinklehost.github.io/intro.js";
const HW_API_ORIGIN = "https://happy-wheels-api.nawsifsspammail.workers.dev";
const DISPATCH_LFS_ROOT = "https://media.githubusercontent.com/media/Nawsif/hctapsid/main/";
const HW_ROUTE = "/approved-games/happywheels/";
const DISPATCH_ROUTE = "/approved-games/dispatch/";
const NEEDLE_ROUTE = "/approved-games/needle/";
const archivedGames = Object.freeze({
  dispatch: { base: NW_SITE + "/hctapsid/" },
  needle: { base: NW_SITE + "/FindTheNeedle/" }
});

// A page may use any path inside its own published directory, but nothing else:
// the shared asset-path check rejects traversal, empty segments and odd bytes.
function archivedGameFile(raw) {
  return safeAssetPath(raw || "");
}

async function serveArchivedHtml(request, upstreamUrl, rewrite, options = {}) {
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, { redirect: "follow", signal: AbortSignal.timeout(45000) });
  } catch (error) {
    console.warn("archived page failed", upstreamUrl, String(error));
    return textError(502, "The approved game page could not be reached");
  }
  if (!upstream.ok) {
    try { await upstream.body?.cancel(); } catch {}
    return textError(502, "The approved game page is unavailable (" + upstream.status + ")");
  }
  const page = rewrite(await upstream.text());
  const headers = corsHeaders(request, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  // A threaded Godot page only becomes cross-origin isolated when the document
  // itself carries these; an iframe inherits its parent's cluster instead.
  if (options.isolated) {
    headers.set("cross-origin-opener-policy", "same-origin");
    headers.set("cross-origin-embedder-policy", "require-corp");
  }
  return new Response(request.method === "HEAD" ? null : page, {
    status: 200,
    headers
  });
}

// Happy Wheels ships its own CSP, a jsDelivr base and a Google Fonts stylesheet.
// Point the base at the relayed asset route, drop the font hosts, route the
// intro script through the Worker and allow only this origin in the policy.
function happyWheelsHtml(html, origin) {
  // The port reads one small config file from the publisher's site before it
  // finishes booting. Send that request to the relayed copy instead so the page
  // never leaves this origin.
  const configBridge = '<script>(function(){' +
    'var from="https://totaljerkface.com/hw-steam/config.json",' +
    'to=location.origin+"' + HW_ROUTE + 'config.json",native=window.fetch;' +
    'if(typeof native!="function")return;' +
    'window.fetch=function(input,init){try{var url=typeof input==="string"?input:(input&&input.url)||"";' +
    'if(url.indexOf(from)===0)input=to+(url.indexOf("?")>=0?url.slice(url.indexOf("?")):"");}catch(e){}' +
    'return native.call(this,input,init);};})();<\/script>';
  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; ' +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; " +
    "font-src 'self' data:; connect-src 'self' data: blob:; media-src 'self' data: blob:; " +
    "img-src 'self' data: blob:; object-src 'none'\">";
  return html
    .replace(/<base\b[^>]*>/i, '<base href="' + origin + HW_ROUTE + 'game/">')
    .replace(/<link\b[^>]*fonts\.(?:googleapis|gstatic)[^>]*>/gi, "")
    .replace(/<link\b[^>]*rel="preconnect"[^>]*>/gi, "")
    .replaceAll(HW_INTRO, origin + HW_ROUTE + "intro.js")
    .replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, csp)
    .replace(/<head\b[^>]*>/i, match => match + configBridge);
}

const HW_CONFIG_ORIGIN = "https://totaljerkface.com/hw-steam/config.json";

async function serveHappyWheelsConfig(request) {
  return fetchPinned(request, HW_CONFIG_ORIGIN, {
    mime: "application/json; charset=utf-8", cache: "public, max-age=300", timeout: 30000
  });
}

// Dispatch rewrites its own Git LFS paths to a hard-coded media host; send that
// prefix to the relayed route instead.
function dispatchHtml(html, origin) {
  const page = html.replaceAll(DISPATCH_LFS_ROOT, origin + DISPATCH_ROUTE + "lfs/");
  // The port is built with JSPI. Without it the engine throws while wiring its
  // wasm imports and the page would sit on "Loading…" with no explanation.
  const notice = '<script>(function(){' +
    'if(typeof WebAssembly.Suspending==="function"&&typeof WebAssembly.promising==="function")return;' +
    'var status=document.getElementById("status");if(!status)return;' +
    'status.textContent="Dispatch needs WebAssembly JSPI, which this browser does not offer. ' +
    'Enable chrome://flags/#enable-experimental-webassembly-features, restart the browser, then reload.";' +
    '})();<\/script>';
  return page.replace(/<\/body>/i, notice + "</body>");
}

// The game's backend is a Cloudflare Workers host the relay cannot open sockets
// to, so the config script is rewritten to call the API through this Worker.
async function serveHappyWheelsBackendConfig(request, origin) {
  let upstream;
  try {
    upstream = await fetch(HW_ASSET_ROOT + "backend-config.js", { signal: AbortSignal.timeout(30000) });
  } catch {
    return textError(502, "The Happy Wheels config script could not be reached");
  }
  if (!upstream.ok) {
    try { await upstream.body?.cancel(); } catch {}
    return textError(502, "The Happy Wheels config script is unavailable (" + upstream.status + ")");
  }
  const source = (await upstream.text()).replaceAll(HW_API_ORIGIN, origin + HW_ROUTE + "api");
  return new Response(request.method === "HEAD" ? null : source, {
    status: 200,
    headers: corsHeaders(request, {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff"
    })
  });
}

async function serveHappyWheelsApi(request, url) {
  if (request.method === "OPTIONS") return preflight(request);
  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
    return textError(405, "Unsupported method for the Happy Wheels backend");
  }
  const tail = archivedGameFile(url.pathname.slice((HW_ROUTE + "api/").length));
  if (!tail) return textError(404, "Not an approved Happy Wheels backend path");
  const headers = new Headers({ "accept-encoding": "identity" });
  for (const name of ["content-type", "accept"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const init = { method: request.method, headers, redirect: "follow", signal: AbortSignal.timeout(30000) };
  if (request.method === "POST") init.body = request.body;
  let upstream;
  try {
    upstream = await fetch(HW_API_ORIGIN + "/" + encodePath(tail) + url.search, init);
  } catch (error) {
    console.warn("happy wheels api failed", tail, String(error));
    return textError(502, "The Happy Wheels backend could not be reached");
  }
  const out = corsHeaders(request, {
    "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: out
  });
}

/* ---------------------------------------------- Projection Studios mirror --- */

// The movie site lives on another workers.dev host. Cloudflare will not let the
// Wisp relay open TCP sockets to its own addresses, so the movie page could only
// be framed straight from that host. This mirrors it instead: the shell, its
// scripts, its /api calls and its chat socket all come back through this origin.
const MOVIE_ROUTE = "/movies/projection/";
const MOVIE_ROOT = "/movies/projection";
const MOVIE_ORIGIN = "https://projection-studios.dogeeats531.workers.dev";
const MOVIE_FORWARD_HEADERS = ["accept", "accept-language", "authorization", "content-type", "range", "x-token", "x-session"];
const MOVIE_COPY_HEADERS = ["content-type", "etag", "last-modified", "cache-control", "content-range", "accept-ranges", "content-disposition"];

// The page hardcodes root-absolute paths (API='/api', new URL('/ws', …)) because
// it normally owns its whole host. Rewrite them onto the mirror prefix so the
// browser keeps every request on this origin.
function movieRewrite(source) {
  return source
    .replaceAll(MOVIE_ORIGIN + "/", MOVIE_ROUTE)
    .replaceAll('"' + MOVIE_ORIGIN, '"' + MOVIE_ROOT)
    .replaceAll('"' + "/api", '"' + MOVIE_ROUTE + "api")
    .replaceAll("'" + "/api", "'" + MOVIE_ROUTE + "api")
    .replaceAll('"' + "/ws", '"' + MOVIE_ROUTE + "ws")
    .replaceAll("'" + "/ws'", "'" + MOVIE_ROUTE + "ws'")
    .replaceAll('"' + "/vendor/", '"' + MOVIE_ROUTE + "vendor/")
    .replaceAll("'" + "/vendor/", "'" + MOVIE_ROUTE + "vendor/")
    .replaceAll('"' + "/degloved-games.json", '"' + MOVIE_ROUTE + "degloved-games.json")
    .replaceAll("'" + "/degloved-games.json", "'" + MOVIE_ROUTE + "degloved-games.json")
    // The catalogue also loads sidebar scripts, its own stylesheet and its
    // game-art thumbnails by root-absolute path, and frames proxied games
    // through /proxy/, so those move under the mirror too. The lookaheads keep
    // a value that is already mirrored from being prefixed a second time.
    .replaceAll("'/proxy/", "'" + MOVIE_ROUTE + "proxy/")
    .replaceAll('"' + "/proxy/", '"' + MOVIE_ROUTE + "proxy/")
    .replace(/(src|href)="\/(?!\/)(?!movies\/projection\/)/g, ('$1="' + MOVIE_ROUTE))
    .replace(/(["'])\/(?!movies\/projection\/)([A-Za-z0-9][A-Za-z0-9._/-]*\.(?:js|css|html|json|jpg|jpeg|png|webp|svg|gif|woff2?|otf|ttf|mp4|webm))\1/g,
      (match, quote, path) => quote + MOVIE_ROUTE + path + quote);
}

async function serveMovieApp(request, url) {
  if (request.method === "OPTIONS") return preflight(request);
  const rest = url.pathname.slice(MOVIE_ROOT.length) || "/";
  const target = MOVIE_ORIGIN + (rest.startsWith("/") ? rest : "/" + rest) + url.search;
  const headers = new Headers();
  for (const name of MOVIE_FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const init = {
    method: request.method,
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(60000)
  };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (error) {
    console.warn("movie mirror failed", url.pathname, String(error));
    return textError(502, "Projection Studios could not be reached");
  }
  const out = new Headers();
  for (const name of MOVIE_COPY_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  const type = (out.get("content-type") || "").toLowerCase();
  // Only documents and code are rewritten. API JSON carries the catalogue's own
  // data (TMDB poster paths that the page joins onto image.tmdb.org), so a
  // prefix must never be injected into it.
  const textual = type.includes("text/html") || type.includes("text/css") || type.includes("javascript");
  // Pages, catalogue API replies and the socket carry the app's live state, so
  // neither the edge nor the browser may hold on to them.
  const live = type.includes("text/html") || rest.startsWith("/api/") || rest.startsWith("/ws");
  out.set("cache-control", live || !upstream.ok ? "no-store" : "public, max-age=3600");
  out.set("x-content-type-options", "nosniff");
  if (request.method === "HEAD") return new Response(null, { status: upstream.status, headers: out });
  if (!textual) return new Response(upstream.body, { status: upstream.status, headers: out });
  let source;
  try {
    source = await upstream.text();
  } catch (error) {
    console.warn("movie mirror read failed", url.pathname, String(error));
    return textError(502, "Projection Studios returned an unreadable page");
  }
  return new Response(movieRewrite(source), { status: upstream.status, headers: out });
}

// The catalogue keeps watch-party and chat state on a socket at /ws, so the
// mirror has to carry it across as well.
async function serveMovieSocket(request) {
  if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
    return textError(426, "Expected a websocket upgrade");
  }
  const url = new URL(request.url);
  let upstream;
  try {
    upstream = await fetch(MOVIE_ORIGIN + "/ws" + url.search, { headers: { Upgrade: "websocket" } });
  } catch (error) {
    console.warn("movie socket failed", String(error));
    return textError(502, "The movie chat socket could not be reached");
  }
  const peer = upstream.webSocket;
  if (!peer) {
    try { await upstream.body?.cancel(); } catch {}
    return textError(502, "The movie chat socket was refused (" + upstream.status + ")");
  }
  const pair = new WebSocketPair();
  const client = pair[0], server = pair[1];
  server.accept();
  peer.accept();
  const shutdown = () => {
    try { server.close(); } catch {}
    try { peer.close(); } catch {}
  };
  server.addEventListener("message", event => { try { peer.send(event.data); } catch (error) { console.warn("movie socket write failed", String(error)); shutdown(); } });
  peer.addEventListener("message", event => { try { server.send(event.data); } catch (error) { console.warn("movie socket read failed", String(error)); shutdown(); } });
  server.addEventListener("close", shutdown);
  peer.addEventListener("close", shutdown);
  server.addEventListener("error", shutdown);
  peer.addEventListener("error", shutdown);
  return new Response(null, { status: 101, webSocket: client });
}

/* -------------------------------------------------------- Toby Web mirror --- */

// The Toby Web hub is a Cloudflare-hosted single page whose files are all
// relative, so the relay's sockets cannot reach it and it was framed straight
// from its own host. Mirroring it moves the page, every file and its API onto
// this origin; relative paths then resolve under the mirror by themselves.
const TOBY_ROOT = "/approved-games/toby";
const TOBY_ROUTE = TOBY_ROOT + "/";
const TOBY_API_ROUTE = TOBY_ROUTE + "themes-api/";
const TOBY_ORIGIN = "https://toby.booksforschool.online";
const TOBY_API_ORIGIN = "https://themes-api.booksforschool.online";
const TOBY_FORWARD_HEADERS = ["accept", "accept-language", "authorization", "content-type", "range"];
const TOBY_COPY_HEADERS = ["content-type", "etag", "last-modified", "cache-control", "content-range", "accept-ranges", "content-disposition"];

function tobyRewrite(source) {
  return source
    .replaceAll(TOBY_ORIGIN + "/", TOBY_ROUTE)
    .replaceAll('"' + TOBY_ORIGIN, '"' + TOBY_ROOT)
    .replaceAll(TOBY_API_ORIGIN, TOBY_API_ROUTE.slice(0, -1))
    // Nothing on the mirrored page should talk to a third-party host, so the
    // analytics loader is swapped for an empty file: their snippet defines its
    // own gtag stub, so the page behaves the same without the beacon.
    .replaceAll("https://www.googletagmanager.com/gtag/js", TOBY_ROUTE + "__gtm.js");
}

async function serveToby(request, url) {
  if (request.method === "OPTIONS") return preflight(request);
  const rest = url.pathname.slice(TOBY_ROOT.length) || "/";
  if (rest === "/__gtm.js") {
    return new Response("/* analytics disabled on the mirrored page */\n", {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400" }
    });
  }
  const isApi = rest === "/themes-api" || rest.startsWith("/themes-api/");
  const target = isApi
    ? TOBY_API_ORIGIN + (rest.slice("/themes-api".length) || "/") + url.search
    : TOBY_ORIGIN + (rest.startsWith("/") ? rest : "/" + rest) + url.search;
  const headers = new Headers();
  for (const name of TOBY_FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const init = { method: request.method, headers, redirect: "follow", signal: AbortSignal.timeout(60000) };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (error) {
    console.warn("toby mirror failed", url.pathname, String(error));
    return textError(502, "Toby Web could not be reached");
  }
  const out = new Headers();
  for (const name of TOBY_COPY_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  const type = (out.get("content-type") || "").toLowerCase();
  const textual = type.includes("text/") || type.includes("javascript") || type.includes("json");
  out.set("cache-control", type.includes("text/html") ? "public, max-age=300" : "public, max-age=14400");
  out.set("x-content-type-options", "nosniff");
  if (request.method === "HEAD") return new Response(null, { status: upstream.status, headers: out });
  if (!textual) return new Response(upstream.body, { status: upstream.status, headers: out });
  let source;
  try {
    source = await upstream.text();
  } catch (error) {
    console.warn("toby mirror read failed", url.pathname, String(error));
    return textError(502, "Toby Web returned an unreadable page");
  }
  return new Response(tobyRewrite(source), { status: upstream.status, headers: out });
}

/* ------------------------------------------------------------ 2v2.io mirror --- */

// 2v2.io is a Cloudflare-hosted Unity build; the relay cannot open sockets to
// Cloudflare's own addresses, so the shell, the build files and the SDK are
// served from this origin. Ads are switched off here: the game's SDK gates every
// ad call on window.ENABLE_ADS, and the CSP keeps adinplay, CPMStar, Criteo and
// the rest of their stack from loading at all.
const TWOV2_ROOT = "/approved-games/2v2";
const TWOV2_ROUTE = TWOV2_ROOT + "/";
const TWOV2_ORIGIN = "https://2v2.io";
const TWOV2_FORWARD_HEADERS = ["accept", "accept-language", "content-type", "range"];
const TWOV2_COPY_HEADERS = ["content-type", "etag", "last-modified", "cache-control", "content-range", "accept-ranges", "content-disposition"];
const TWOV2_CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  // files.2v2.io is the game's own asset CDN, and its addressables catalogue
  // refers to it by absolute URL, so it is the one outside host allowed here.
  "connect-src 'self' data: blob: ws: wss: https://files.2v2.io",
  "frame-src 'self' blob:",
  "worker-src 'self' blob:",
  "base-uri 'self'",
  "form-action 'self'"
].join("; ");
// The game's SDK bundles its adinplay/CPMStar/local banner engine, so the CSP only
// stops the network half of it. This silences the engine too: the provider table
// it looks banners up in always reads empty, and any banner element that still
// reaches the page is hidden.
const TWOV2_AD_BLOCK = "<script>(function(){" +
  "try{Object.defineProperty(window,\"ENABLE_ADS\",{configurable:false,get:function(){return false;},set:function(){}});}catch(error){window.ENABLE_ADS=false;}" +
  "window.adsbygoogle=window.adsbygoogle||{loaded:true,push:function(){}};" +
  "window.googletag=window.googletag||{cmd:[],apiReady:true,enableServices:function(){},pubads:function(){return{addEventListener:function(){},refresh:function(){},setTargeting:function(){}};}," +
  "defineSlot:function(){return{addService:function(){return this;}};},display:function(){},destroySlots:function(){}};" +
  "var noProviders=new Proxy({},{get:function(){return undefined;},set:function(){return true;},has:function(){return false;},deleteProperty:function(){return true;}," +
  "ownKeys:function(){return [];},getOwnPropertyDescriptor:function(){return undefined;}});" +
  "try{Object.defineProperty(window,\"videoAdProviders\",{configurable:true,get:function(){return noProviders;},set:function(){}});}" +
  "catch(error){window.videoAdProviders=noProviders;}" +
  "var AD_HINT=/\\/ads\\/|fallzone\\.io|veck\\.io|cpmstar|adinplay/i;" +
  "function sweepBanners(){try{var nodes=document.querySelectorAll(\"img,iframe,a\");" +
  "for(var i=0;i<nodes.length;i++){var node=nodes[i];var url=node.getAttribute(\"src\")||node.getAttribute(\"href\")||\"\";" +
  "if(!AD_HINT.test(url))continue;var slot=node.closest(\"[class*=banner],[id*=banner],[class*=ad-],[id*=ad-]\")||node;" +
  "slot.style.setProperty(\"display\",\"none\",\"important\");}}catch(error){}}" +
  "setInterval(sweepBanners,400);document.addEventListener(\"DOMContentLoaded\",sweepBanners);})();</script>";

// A 1x1 transparent PNG, served wherever the page asks for banner artwork.
const TRANSPARENT_PIXEL = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), char => char.charCodeAt(0));

function twoVTwoRewrite(source) {
  return source
    .replaceAll('<base href="/">', `<base href="${TWOV2_ROUTE}">`)
    .replaceAll("window.ENABLE_ADS = true", "window.ENABLE_ADS = false")
    .replaceAll(TWOV2_ORIGIN + "/", TWOV2_ROUTE)
    .replaceAll('"' + TWOV2_ORIGIN + '"', '"' + TWOV2_ROOT + '"')
    .replaceAll('<link rel="preconnect" href="https://www.googletagmanager.com" crossorigin>', "")
    .replaceAll("https://www.googletagmanager.com/ns.html", TWOV2_ROUTE + "__adblock.html")
    .replaceAll("https://www.googletagmanager.com/gtag/js", TWOV2_ROUTE + "__adblock.js")
    .replaceAll("https://www.googletagmanager.com/gtm.js", TWOV2_ROUTE + "__adblock.js")
    .replaceAll("//www.google-analytics.com", TWOV2_ROUTE + "__adblock.js")
    .replace("</head>", TWOV2_AD_BLOCK + "</head>");
}

async function serveTwoVTwo(request, url) {
  if (request.method === "OPTIONS") return preflight(request);
  const rest = url.pathname.slice(TWOV2_ROOT.length) || "/";
  if (rest.startsWith("/ads/")) {
    // The game's own ad adapters and banner artwork live on its host, so the CSP
    // cannot stop them: adapters become empty scripts and art a blank pixel.
    if (rest.endsWith(".js")) {
      return new Response("/* ads are disabled on the mirrored page */\n", {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400" }
      });
    }
    return new Response(TRANSPARENT_PIXEL, {
      headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" }
    });
  }
  if (rest === "/__adblock.js" || rest === "/__adblock.html") {
    const script = rest.endsWith(".js");
    return new Response(script ? "/* ads are disabled on the mirrored page */\n" : "<!doctype html><title></title>\n", {
      headers: {
        "content-type": script ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
        "cache-control": "public, max-age=86400",
        "content-security-policy": TWOV2_CSP
      }
    });
  }
  const target = TWOV2_ORIGIN + (rest.startsWith("/") ? rest : "/" + rest) + url.search;
  const headers = new Headers();
  for (const name of TWOV2_FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const init = { method: request.method, headers, redirect: "follow", signal: AbortSignal.timeout(120000) };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (error) {
    console.warn("2v2 mirror failed", url.pathname, String(error));
    return textError(502, "2v2.io could not be reached");
  }
  const out = new Headers();
  for (const name of TWOV2_COPY_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  const type = (out.get("content-type") || "").toLowerCase();
  // Unity's loader decompresses .br/.unityweb files itself when the response
  // does not arrive already encoded, so those are streamed through untouched
  // instead of being read and rewritten as text.
  const encoded = /[.](br|gz|unityweb|wasm)$/i.test(url.pathname) || !!upstream.headers.get("content-encoding");
  const html = type.includes("text/html") && !encoded;
  const textual = !encoded && (html || type.includes("javascript") || type.includes("text/css"));
  if (encoded) {
    const encoding = upstream.headers.get("content-encoding");
    if (encoding) out.set("content-encoding", encoding);
  }
  out.set("cache-control", html ? "no-cache, must-revalidate" : "public, max-age=86400");
  out.set("x-content-type-options", "nosniff");
  if (html) {
    out.set("content-security-policy", TWOV2_CSP);
    out.set("referrer-policy", "no-referrer");
  }
  if (request.method === "HEAD") return new Response(null, { status: upstream.status, headers: out });
  if (!textual) return new Response(upstream.body, { status: upstream.status, headers: out });
  let source;
  try {
    source = await upstream.text();
  } catch (error) {
    console.warn("2v2 mirror read failed", url.pathname, String(error));
    return textError(502, "2v2.io returned an unreadable file");
  }
  return new Response(twoVTwoRewrite(source), { status: upstream.status, headers: out });
}

/* ------------------------------------------------------------- now.gg --- */

// now.gg is served from this origin so the arcade's own proxy carries it and
// the page runs under a policy that refuses the ad and consent networks. Its
// page addresses itself by root-relative path and its art by absolute URL, so
// the page and its code are moved under the route while cdn.now.gg (the asset
// host) stays absolute and is allowed explicitly.
const NOWGG_COPY_HEADERS = ["content-type", "etag", "last-modified", "cache-control", "content-range", "accept-ranges"];
const NOWGG_CSP = [
  "default-src 'self' https://now.gg https://*.now.gg",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: https://now.gg https://*.now.gg",
  "style-src 'self' 'unsafe-inline' https://now.gg https://*.now.gg https://fonts.googleapis.com",
  "img-src 'self' data: blob: https://now.gg https://*.now.gg",
  "font-src 'self' data: https://now.gg https://*.now.gg https://fonts.gstatic.com",
  "media-src 'self' blob: https://now.gg https://*.now.gg",
  // The play client opens its own sockets and talks to its account service, so
  // connections stay open while scripts, frames and images (where the ads live)
  // remain restricted.
  "connect-src 'self' https: wss: ws: data: blob: https://now.gg wss://now.gg",
  "frame-src 'self' blob: https://now.gg https://*.now.gg https://www.youtube.com",
  "worker-src 'self' blob: https://now.gg https://*.now.gg",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'"
].join("; ");
// Tags that only exist to load ads, consent walls or page metrics.
const NOWGG_AD_TAG = /<script\b[^>]*src=["'][^"']*(?:googletagmanager|google-analytics|doubleclick|googlesyndication|cmp\.inmobi|requestmetrics)[^"']*["'][^>]*>\s*<\/script>/gi;

// now.gg addresses itself by root-relative path and its art by absolute URL, so
// the mirror is described by one of these records. The list is kept as a record
// set because more than one now.gg page may be carried at once.
const NOWGG_SITES = [
  {
    slug: "nowgg",
    root: "/approved-games/nowgg",
    origin: "https://now.gg",
    entry: "/",
    // Paths the page builds at runtime as absolute paths of its own origin. They
    // arrive without the route in front, so the mirror answers them as well.
    ownPaths: ["/oapi/", "/1/", "/_next/", "/api/", "/assets/", "/play/", "/games/", "/apps/", "/static/", "/nowgg-static/", "/7/", "/ncm/"],
    // The site's asset CDN answers for nowgg-static (its icon font lives there,
    // and cross-origin font loads are refused without CORS, so those go through
    // the route too). Everything else the page asks for is on now.gg itself.
    cdnOrigin: "https://cdn.now.gg",
    cdnPath: "/nowgg-static/",
    csp: NOWGG_CSP
  }
];
for (const site of NOWGG_SITES) site.route = site.root + "/";

function nowGgRewrite(source, site) {
  let out = source.replace(NOWGG_AD_TAG, "");
  // The play client starts the session only after its preroll ad reports back.
  // The ad networks are refused here, so the page data is answered with the ads
  // switched off and the client goes straight to the session.
  out = out
    .replace(/"enablePrerollAds":true/gi, '"enablePrerollAds":false')
    .replace(/"enableMidrollAds":true/gi, '"enableMidrollAds":false')
    .replace(/"enableDisplayAds":true/gi, '"enableDisplayAds":false')
    .replace(/"enableRewardedAds":true/gi, '"enableRewardedAds":false');
  if (site.cdnOrigin) out = out.replaceAll(site.cdnOrigin + site.cdnPath, site.route + site.cdnPath.slice(1));
  out = out
    .replaceAll(site.origin + "/", site.route)
    .replaceAll('"' + site.origin, '"' + site.root);
  // Root-relative attributes are the page's own files.
  return out.replace(/((?:src|href|content|poster|action)\s*=\s*["'])\/(?!\/|approved-games\/)/g, "$1" + site.route);
}

// now.gg joins its own asset prefix with paths the page builds at runtime, so a
// route segment can arrive in the middle of a path instead of in front of it.
// Take the route out wherever it sits and keep the rest as the upstream path.
function nowGgUpstreamPath(site, pathname) {
  if (pathname === site.root || pathname === site.root + "/") return site.entry;
  if (pathname.startsWith(site.route)) return "/" + pathname.slice(site.route.length);
  const at = pathname.indexOf(site.route);
  if (at > 0) {
    const head = pathname.slice(0, at);
    const tail = pathname.slice(at + site.route.length);
    return (head.endsWith("/") ? head : head + "/") + tail;
  }
  return pathname.startsWith("/") ? pathname : "/" + pathname;
}

// The route prefix wins; a bare own path belongs to the site that claims it.
function nowGgSiteFor(pathname) {
  for (const site of NOWGG_SITES) {
    if (pathname === site.root || pathname.includes(site.route)) return site;
  }
  for (const site of NOWGG_SITES) {
    if (site.ownPaths.some(prefix => pathname.startsWith(prefix))) return site;
  }
  return null;
}

// The play client builds some URLs from its configured play domain instead of
// the page's own location, so a guest-login call goes straight to now.gg from
// this origin and the browser refuses it (no CORS). This maps those absolute
// URLs back inside the route before any request leaves the page.
function nowGgShim(site) {
  const hosts = [site.origin + "/"];
  if (site.cdnOrigin) hosts.push(site.cdnOrigin + site.cdnPath);
  const mapped = [site.route];
  if (site.cdnOrigin) mapped.push(site.route + site.cdnPath.slice(1));
  return "<script>(function(){" +
    "var H=" + JSON.stringify(hosts) + ",M=" + JSON.stringify(mapped) + ";" +
    "function t(u){if(typeof u!=='string'||!u)return u;" +
    "for(var i=0;i<H.length;i++){if(u.indexOf(H[i])===0)return M[i]+u.slice(H[i].length);}" +
    "return u;}" +
    "var f=window.fetch;if(f)window.fetch=function(a,b){try{if(typeof a==='string')a=t(a);" +
    "else if(a&&a.url){var m=t(a.url);if(m!==a.url)a=new Request(m,a);}}catch(e){}return f.call(this,a,b);};" +
    "var x=window.XMLHttpRequest&&XMLHttpRequest.prototype.open;" +
    "if(x)XMLHttpRequest.prototype.open=function(m,u){try{arguments[1]=t(u);}catch(e){}return x.apply(this,arguments);};" +
    "var W=window.WebSocket;if(W){var N=function(u,p){return p===undefined?new W(t(u)):new W(t(u),p);};" +
    "N.prototype=W.prototype;window.WebSocket=N;}" +
    "var B=navigator.sendBeacon;if(B)navigator.sendBeacon=function(u,d){return B.call(navigator,t(u),d);};" +
    "})();</script>";
}

let nowGgGuest = null;
async function nowGgGuestIdentity() {
  if (nowGgGuest && Date.now() < nowGgGuest.until) return nowGgGuest;
  try {
    const response = await fetch("https://now.gg/accounts/auth/v2/access-token?implicitGuestLogin=true", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15000)
    });
    const raw = (response.headers.get("set-cookie") || "").split(";")[0];
    const data = await response.json().catch(() => null);
    if (!data || !data.access_token || !raw.startsWith("_NSID=")) return null;
    const expiry = Date.parse(data.access_token_expiry || "");
    nowGgGuest = {
      cookie: raw,
      token: data.access_token,
      expiry: data.access_token_expiry || "",
      until: Math.min(Number.isFinite(expiry) ? expiry : Date.now() + 1800000, Date.now() + 1800000)
    };
    return nowGgGuest;
  } catch (error) {
    return null;
  }
}

async function serveNowgg(request, url, site) {
  if (request.method === "OPTIONS") return preflight(request);
  const upstreamPath = nowGgUpstreamPath(site, url.pathname);
  const origin = site.cdnOrigin && upstreamPath.startsWith(site.cdnPath) ? site.cdnOrigin : site.origin;
  const target = origin + upstreamPath + url.search;
  // Everything the page sends goes upstream, minus the headers that describe
  // this hop. now.gg identifies a player by its own cookies and request headers,
  // so dropping them turned authenticated calls into anonymous ones (a 409 from
  // the play API) and no session could ever start.
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (!SITE_MIRROR_SKIP.has(name.toLowerCase())) headers.set(name, value);
  });
  const init = { method: request.method, headers, redirect: "follow", signal: AbortSignal.timeout(45000) };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (error) {
    console.warn("now.gg mirror failed", url.pathname, String(error));
    return textError(502, "now.gg could not be reached");
  }
  const out = new Headers();
  for (const name of NOWGG_COPY_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  // The player's own cookies have to reach the browser under this origin, so the
  // upstream domain is dropped from each one.
  const secure = url.protocol === "https:";
  for (const cookie of upstream.headers.getSetCookie()) {
    let value = cookie.replace(/;\s*domain=[^;]+/gi, "");
    if (!secure) value = value.replace(/;\s*secure/gi, "");
    out.append("set-cookie", value);
  }
  const type = (out.get("content-type") || "").toLowerCase();
  const encoded = /[.](br|gz|wasm|woff2?|png|jpe?g|webp|avif|gif|svg|mp4|webm|zip)$/i.test(url.pathname) || !!upstream.headers.get("content-encoding");
  const html = type.includes("text/html") && !encoded;
  const textual = !encoded && (html || type.includes("javascript") || type.includes("text/css"));
  if (encoded) {
    const encoding = upstream.headers.get("content-encoding");
    if (encoding) out.set("content-encoding", encoding);
  }
  out.set("cache-control", html ? "no-cache, must-revalidate" : "public, max-age=3600");
  out.set("x-content-type-options", "nosniff");
  if (html) {
    out.set("content-security-policy", site.csp);
    out.set("referrer-policy", "no-referrer");
  }
  if (request.method === "HEAD") return new Response(null, { status: upstream.status, headers: out });
  if (!textual) return new Response(upstream.body, { status: upstream.status, headers: out });
  let source;
  try {
    source = await upstream.text();
  } catch (error) {
    console.warn("now.gg mirror read failed", url.pathname, String(error));
    return textError(502, "now.gg returned an unreadable file");
  }
  let body = nowGgRewrite(source, site);
  if (html) {
    const hasToken = /(?:^|;\s*)_NSID=/.test(request.headers.get("cookie") || "");
    const guest = hasToken ? null : await nowGgGuestIdentity();
    if (guest) {
      out.append("set-cookie", guest.cookie + "; Path=/; SameSite=Lax" + (secure ? "; Secure" : ""));
      // The page reads the play token from its own storage as well, so the same
      // identity is written where the client looks when the cookie is not enough.
      body = body.replace(/window\.nggParams = \{\};/, m =>
        m + "window.nggParams[\"ng_token_v2\"]=" + JSON.stringify(guest.token) +
        ";window.nggParams[\"ng_token_expiry_v2\"]=" + JSON.stringify(guest.expiry) + ";");
    }
    body = body.replace(/<head(\s[^>]*)?>/i, m => m + nowGgShim(site));
  }
  return new Response(body, { status: upstream.status, headers: out });
}

/* --------------------------------------------------------- site mirrors --- */

// Kahoot is served from this origin the way now.gg is: the page, its own files
// and its asset hosts are fetched and rewritten by the Worker. Each mirror
// answers with a policy that names the hosts the page needs and refuses the ad,
// consent and page-metric networks by omission.
const SITE_MIRROR_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
// Everything the page sends is forwarded, minus the headers that describe this
// hop. Without content-type and the page's own origin, a server action or a JSON
// call is rejected upstream.
const SITE_MIRROR_SKIP = new Set(["host", "connection", "content-length", "accept-encoding", "origin", "referer", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cdn-loop", "x-forwarded-for", "x-forwarded-proto", "x-real-ip", "keep-alive", "te", "upgrade", "proxy-connection"]);
const SITE_MIRROR_COPY = ["content-type", "etag", "last-modified", "cache-control", "content-range", "accept-ranges"];

const SITE_MIRRORS = {
  // The Kahoot client on clients-kahoot.x-network.lol keeps its controller build
  // under /_b/assets-cdn.kahoot.it and loads its own client layer from
  // x-network.lol. Its edge refuses the relay's raw sockets, so the page is
  // proxied here and every path-based request stays on this origin.
  kahoot: {
    root: "/approved-games/kahoot",
    origin: "https://clients-kahoot.x-network.lol",
    entry: "/",
    // The controller navigates to these paths by script, which the shim cannot
    // see; they are sent back into the route.
    navPaths: ["/controller/", "/challenges/", "/join/"],
    // Its build and art are fetched from the origin root; the prefixes name the
    // upstream host so another mirror's /_b/ request is never claimed here.
    aliases: ["/_b/assets-cdn.kahoot.it/", "/_b/files-cdn.kahoot.it/", "/_b/kahoot.it/", "/_b/apis.kahoot.it/", "/reserve/", "/cometd/"],
    // The controller builds its server URLs from absolute config values.
    rawScripts: true,
    hosts: [],
    policy: [
      "default-src 'self' data: blob:",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: https://x-network.lol https://*.x-network.lol",
      "style-src 'self' 'unsafe-inline' https://x-network.lol https://*.x-network.lol",
      "img-src 'self' data: blob: https://x-network.lol https://*.x-network.lol https://*.kahoot.it",
      "font-src 'self' data: https://x-network.lol https://*.x-network.lol https://*.kahoot.it",
      "media-src 'self' blob: https://*.x-network.lol",
      // The client's flag service answers on apis.kahoot.it and the live quiz
      // keeps its socket on Kahoot's own host.
      "connect-src 'self' https://x-network.lol https://*.x-network.lol wss://*.x-network.lol https://apis.kahoot.it https://*.kahoot.it wss://*.kahoot.it",
      "frame-src 'self' blob:",
      "worker-src 'self' blob:",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'"
    ].join("; "),
    ads: /(?:googletagmanager|googlesyndication|doubleclick|google-analytics|amplitude|segment\.io|hotjar|cloudflareinsights|adservice|cookieyes)/i
  },
  // The Blooket client on clients-blooket.x-network.lol already points its build,
  // its assets and its API calls at its own origin. That edge refuses the relay's
  // raw sockets, so the page is proxied here instead of through the Wisp player:
  // bringing it inside this route keeps every path-based request on this origin.
  blooket: {
    root: "/approved-games/blooket",
    origin: "https://clients-blooket.x-network.lol",
    entry: "/play",
    navPaths: ["/play"],
    // Its Next.js runtime loads chunks and art from the origin root, so those
    // prefixes are claimed and mapped back inside the route.
    aliases: ["/_b/ac.blooket.com/", "/_b/id.blooket.com/", "/_b/blooket.com/"],
    hosts: [],
    // The mirror loads its own client layer from x-network.lol/api/scripts, so that
    // host is allowed for code, styles and data while the ad networks stay refused.
    policy: [
      "default-src 'self' data: blob:",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: https://x-network.lol https://*.x-network.lol",
      "style-src 'self' 'unsafe-inline' https://x-network.lol https://*.x-network.lol",
      "img-src 'self' data: blob: https://x-network.lol https://*.x-network.lol https://*.blooket.com",
      "font-src 'self' data: https://x-network.lol https://*.x-network.lol",
      "media-src 'self' blob: https://*.x-network.lol",
      "connect-src 'self' https://x-network.lol https://*.x-network.lol wss://*.x-network.lol https://media.blooket.com",
      "frame-src 'self' blob:",
      "worker-src 'self' blob:",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'"
    ].join("; "),
    ads: /(?:cookieyes|googletagmanager|googlesyndication|doubleclick|google-analytics|cloudflareinsights|adservice|criteo|taboola|outbrain)/i
  },
  // Movy is a Next.js film and TV catalogue on its own host, with its data and
  // media served by a separate API host. The page, its chunks and its art come
  // back through this origin; the API host, TMDB art and the players it embeds
  // are named in the policy so the catalogue can hydrate, while the ad and
  // consent networks stay refused by omission.
  movy: {
    root: "/movies/movy",
    origin: "https://www.movy.sx",
    entry: "/",
    // The app routes on the client; these paths are what a reload lands on.
    navPaths: ["/movie/", "/tv/", "/watch/", "/genre/", "/trending/", "/anime/"],
    // Its Next.js runtime loads art and its icons from the origin root, outside
    // the route, so those prefixes are claimed and moved back inside it. Chunks
    // are requested at the root too, but now.gg claims /_next/ there, so those
    // are routed by the referer of the page that asked.
    aliases: ["/img/", "/icon-"],
    referrer: "strict-origin-when-cross-origin",
    hosts: [],
    policy: [
      "default-src 'self' data: blob: https:",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:",
      "style-src 'self' 'unsafe-inline' https:",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data: https:",
      "media-src 'self' blob: https:",
      "connect-src 'self' https: wss:",
      "frame-src 'self' blob: https:",
      "worker-src 'self' blob:",
      "base-uri 'self'",
      "form-action 'self' https:",
      "object-src 'none'"
    ].join("; "),
    ads: /(?:googletagmanager|googlesyndication|doubleclick|google-analytics|amp-api|cloudflareinsights|adservice|cookieyes|popads|propellerads|onclickads)/i
  },
  // YouShows is a Next.js film and TV catalogue. Its page, its chunks and its own
  // catalogue API come back through this origin; the TMDB art it renders and the
  // players it embeds are named in the policy, while the ad, consent and metric
  // networks stay refused by omission.
  youshows: {
    root: "/movies/youshows",
    origin: "https://youshows.org",
    entry: "/",
    // The app routes on the client; these paths are what a reload lands on.
    navPaths: ["/movie/", "/tv/", "/watch/", "/person/", "/genre/", "/trending/", "/discover/", "/search"],
    aliases: ["/icon-"],
    referrer: "strict-origin-when-cross-origin",
    // Its Turbopack runtime derives every chunk path from "/_next/", so those
    // tags stay at the origin root and are routed here by the page referer.
    rootAssets: true,
    hosts: [],
    policy: [
      "default-src 'self' data: blob: https:",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:",
      "style-src 'self' 'unsafe-inline' https:",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data: https:",
      "media-src 'self' blob: https:",
      "connect-src 'self' https: wss:",
      "frame-src 'self' blob: https:",
      "worker-src 'self' blob:",
      "base-uri 'self'",
      "form-action 'self' https:",
      "object-src 'none'"
    ].join("; "),
    ads: /(?:enjellyclysma|googletagmanager|googlesyndication|doubleclick|google-analytics|cloudflareinsights|adservice|cookieyes|popads|propellerads|onclickads)/i
  }
};

const SITE_MIRROR_LIST = Object.values(SITE_MIRRORS);

function isSiteNavPath(site, pathname) {
  return (site.navPaths || []).some((prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix));
}

function isSiteMirrorPath(site, pathname) {
  return pathname === site.root || pathname.startsWith(site.root + "/");
}

// Route path -> upstream path. The site's asset hosts keep their own prefixes so
// a fetch of the page's code never leaves this origin.
function siteMirrorTarget(site, pathname) {
  if (pathname === site.root || pathname === site.root + "/") return site.origin + site.entry;
  for (const [host, route] of site.hosts) {
    if (pathname.startsWith(route)) return host + pathname.slice(route.length);
  }
  if (pathname.startsWith(site.root + "/")) return site.origin + "/" + pathname.slice(site.root.length + 1);
  return site.origin + site.entry;
}

// The page, its code and its styles are moved inside the route; tags that only
// exist to load ads, consent walls or page metrics are dropped.
function siteMirrorRewrite(source, site, html) {
  let out = source;
  for (const [host, route] of site.hosts) out = out.split(host).join(route);
  // A script's own absolute URLs must sometimes keep their scheme and host: the
  // Kahoot bundle builds URLs with `new URL` from its config, where a bare path
  // throws. Its site sets rawScripts; others have their paths moved inside the
  // route so a script never reaches the origin directly.
  if (html || !site.rawScripts) out = out.split(site.origin + "/").join(site.root + "/");
  if (!html) return out;
  out = out.replace(/<script\b[^>]*\bsrc=["'][^"']*["'][^>]*>\s*<\/script>/gi, tag => (site.ads.test(tag) ? "" : tag));
  out = out.replace(/<link\b[^>]*>/gi, tag => (site.ads.test(tag) ? "" : tag));
  // Cloudflare's bot-detection bootstrap re-injects itself on the parent origin
  // and spins against a challenger that does not exist behind this route. It is
  // inline, so it is matched without crossing a closing tag and dropped.
  out = out.replace(/<script\b[^>]*>(?:(?!<\/script>)[\s\S])*cdn-cgi\/challenge-platform(?:(?!<\/script>)[\s\S])*<\/script>/gi, "");
  if (site.rootAssets) out = out.replace(/((?:src|href|content|poster|action)\s*=\s*["'])\/_next\//g, "$1_next/");
  out = out.replace(/((?:src|href|content|poster|action)\s*=\s*["'])\/(?!\/|approved-games\/)/g, "$1" + site.root + "/");
  if (site.rootAssets) out = out.split("").join("/");
  return out.replace(/<\/head>/i, (site.noShim ? "" : siteMirrorScript(site)) + "</head>");
}

// The page builds request paths at runtime, and a path that starts at "/" would
// leave the route and hit this worker's own root. This maps those back inside
// the route before any request leaves the page.
function siteMirrorScript(site) {
  const route = site.root + "/";
  const hosts = JSON.stringify(site.hosts);
  const origin = JSON.stringify(site.origin + "/");
  return "<script>(function(){" +
    "var R=" + JSON.stringify(route) + ",M=" + hosts + ",O=" + origin + ";" +
    "function t(u){if(typeof u!=='string'||!u)return u;" +
    "for(var i=0;i<M.length;i++){if(u.indexOf(M[i][0])===0)return M[i][1]+u.slice(M[i][0].length);}" +
    "if(u.indexOf(O)===0)return R+u.slice(O.length);" +
    "if(u.charAt(0)!=='/'||u.charAt(1)==='/')return u;" +
    "if(u.indexOf(R)===0)return u;" +
    "return R.slice(0,-1)+u;}" +
    "var f=window.fetch;if(f)window.fetch=function(a,b){try{if(typeof a==='string')a=t(a);" +
    "else if(a&&a.url){var m=t(a.url);if(m!==a.url)a=new Request(m,a);}}catch(e){}return f.call(this,a,b);};" +
    "var x=window.XMLHttpRequest&&XMLHttpRequest.prototype.open;" +
    "if(x)XMLHttpRequest.prototype.open=function(m,u){try{arguments[1]=t(u);}catch(e){}return x.apply(this,arguments);};" +
    "var W=window.WebSocket;if(W){var N=function(u,p){return p===undefined?new W(t(u)):new W(t(u),p);};" +
    "N.prototype=W.prototype;window.WebSocket=N;}" +
    "var B=navigator.sendBeacon;if(B)navigator.sendBeacon=function(u,d){return B.call(navigator,t(u),d);};" +
    "})();</script>";
}

async function serveSiteMirror(request, url, site) {
  if (request.method === "OPTIONS") return preflight(request);
  const target = siteMirrorTarget(site, url.pathname) + url.search;
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!SITE_MIRROR_SKIP.has(name)) headers.set(name, value);
  }
  // Blooket's edge refuses a request without a browser user agent.
  headers.set("user-agent", SITE_MIRROR_UA);
  // Same-origin checks upstream must see the site's own origin, not this route.
  headers.set("origin", site.origin);
  headers.set("referer", site.origin + siteMirrorTarget(site, url.pathname));
  if (!headers.has("accept")) headers.set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  if (!headers.has("accept-language")) headers.set("accept-language", "en-US,en;q=0.9");
  const init = { method: request.method, headers, redirect: "follow", signal: AbortSignal.timeout(45000) };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (error) {
    console.warn("site mirror failed", site.root, url.pathname, String(error));
    return textError(502, "This site could not be reached");
  }
  const out = new Headers();
  for (const name of SITE_MIRROR_COPY) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  const type = (out.get("content-type") || "").toLowerCase();
  const encoding = upstream.headers.get("content-encoding");
  const encoded = !!encoding;
  const html = !encoded && type.includes("text/html");
  const textual = !encoded && (html || type.includes("javascript") || type.includes("text/css"));
  if (encoded) out.set("content-encoding", encoding);
  out.set("cache-control", html ? "no-cache, must-revalidate" : "public, max-age=3600");
  out.set("x-content-type-options", "nosniff");
  if (html) {
    out.set("content-security-policy", site.policy);
    // The default refuses referers, but a page whose runtime asks for root-level
    // chunks needs its own route named in them, so it can choose.
    out.set("referrer-policy", site.referrer || "no-referrer");
  }
  if (request.method === "HEAD") return new Response(null, { status: upstream.status, headers: out });
  if (!textual) return new Response(upstream.body, { status: upstream.status, headers: out });
  let source;
  try {
    source = await upstream.text();
  } catch (error) {
    console.warn("site mirror read failed", site.root, url.pathname, String(error));
    return textError(502, "This site returned an unreadable file");
  }
  return new Response(siteMirrorRewrite(source, site, html), { status: upstream.status, headers: out });
}

/* ------------------------------------------------------------- entrypoint --- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === "/health") {
      return json({
        ok: true,
        service: "seuss-arcade-relay-cloudflare",
        protocol: "wisp-1",
        transport: "cloudflare:sockets",
        restricted: false,
        relayOriginPolicy: "any-public-host",
        privateRanges: env.ALLOW_PRIVATE_IPS === "1" ? "allowed" : "blocked",
        search: true,
        games: "cloudflare"
      });
    }
    if (pathname === "/speedtest") {
      const bytes = Math.min(Math.max(Number(url.searchParams.get("bytes")) || 1500000, 1000), 8000000);
      return new Response(new Uint8Array(bytes), {
        headers: {
          "content-type": "application/octet-stream",
          "cache-control": "no-store",
          "access-control-allow-origin": "*"
        }
      });
    }
    if (pathname === "/wisp/" || pathname === "/wisp") {
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
        return new Response("Expected a websocket upgrade\n", { status: 426 });
      }
      const denied = denyOrigin(request, env);
      if (denied) return denied;
      return env.WISP_RELAY.get(env.WISP_RELAY.idFromName("seuss")).fetch(request);
    }
    if (pathname.startsWith(FIREBASE_ROUTE)) {
      const denied = denyOrigin(request, env);
      if (denied) return denied;
      try {
        return await handleFirebaseRelay(request, url);
      } catch (error) {
        console.error("firebase route failed", pathname, String(error));
        return withCors(request, textError(502, "The Firebase route failed"));
      }
    }

    // 2v2's Unity build asks for its addressables catalogue at the origin root,
    // which would leave the mirror and hit this worker's fallback instead. Only
    // its own versioned folder is claimed: the legacy Minecraft mirror also
    // lives at this root and must keep every other path.
    if (pathname.startsWith("/StreamingAssets/aa0.0.2798/")) {
      return withCors(request, await serveTwoVTwo(request, new URL(TWOV2_ROOT + pathname + url.search, url.origin)));
    }

    // Next.js builds some of its chunk URLs from the origin root, which more than
    // one mirror can claim. The referer names the page that asked, so the chunk
    // goes back to that page's mirror.
    if (pathname.startsWith("/_next/")) {
      const referer = request.headers.get("referer") || "";
      for (const site of SITE_MIRROR_LIST) {
        if (!referer.includes(site.root + "/")) continue;
        const aliased = new URL(request.url);
        aliased.pathname = site.root + pathname;
        try {
          return withCors(request, await serveSiteMirror(request, aliased, site));
        } catch (error) {
          console.error("site mirror root chunk failed", site.root, pathname, String(error));
        }
      }
    }

    const nowggSite = nowGgSiteFor(pathname);
    if (nowggSite) {
      try {
        return withCors(request, await serveNowgg(request, url, nowggSite));
      } catch (error) {
        console.error("now.gg route failed", nowggSite.slug, pathname, String(error));
        return withCors(request, textError(502, "The " + nowggSite.slug + " route failed"));
      }
    }

    // Two mirrors can share a nav path ("/watch/"), so a hard navigation out of
    // one of them is sent back to the page it came from rather than the first
    // site that also claims the path.
    const navReferer = request.headers.get("referer") || "";
    const navFrom = SITE_MIRROR_LIST.filter((site) => navReferer.includes(site.root + "/") && isSiteNavPath(site, pathname));
    for (const site of [...navFrom, ...SITE_MIRROR_LIST]) {
      if (!isSiteNavPath(site, pathname) || isSiteMirrorPath(site, pathname)) continue;
      const back = new URL(site.root + pathname + url.search, url.origin);
      return withCors(request, new Response(null, { status: 302, headers: { location: back.toString() } }));
    }

    for (const site of SITE_MIRROR_LIST) {
      if (!isSiteMirrorPath(site, pathname)) continue;
      try {
        return withCors(request, await serveSiteMirror(request, url, site));
      } catch (error) {
        console.error("site mirror failed", site.root, pathname, String(error));
        return withCors(request, textError(502, "The " + site.root.split("/").pop() + " route failed"));
      }
    }

    // Some mirrored pages build their file paths from the origin root instead of
    // the page's own path, which would leave the route; their prefixes are
    // claimed here and moved back inside it.
    for (const site of SITE_MIRROR_LIST) {
      if (!(site.aliases || []).some((prefix) => pathname.startsWith(prefix))) continue;
      const aliased = new URL(request.url);
      aliased.pathname = site.root + pathname;
      try {
        return withCors(request, await serveSiteMirror(request, aliased, site));
      } catch (error) {
        console.error("site mirror alias failed", site.root, pathname, String(error));
        return withCors(request, textError(502, "The " + site.root.split("/").pop() + " route failed"));
      }
    }

    if (pathname === TWOV2_ROOT || pathname.startsWith(TWOV2_ROUTE)) {
      try {
        return withCors(request, await serveTwoVTwo(request, url));
      } catch (error) {
        console.error("2v2 route failed", pathname, String(error));
        return withCors(request, textError(502, "The 2v2.io route failed"));
      }
    }

    if (pathname === TOBY_ROOT || pathname.startsWith(TOBY_ROUTE)) {
      try {
        return withCors(request, await serveToby(request, url));
      } catch (error) {
        console.error("toby route failed", pathname, String(error));
        return withCors(request, textError(502, "The Toby Web route failed"));
      }
    }

    if (pathname.startsWith(MOVIE_ROOT)) {
      try {
        if (pathname === MOVIE_ROUTE + "ws" || pathname === MOVIE_ROUTE + "ws/") return serveMovieSocket(request);
        return withCors(request, await serveMovieApp(request, url));
      } catch (error) {
        console.error("movie route failed", pathname, String(error));
        return withCors(request, textError(502, "The movie route failed"));
      }
    }

    // Everything outside the pinned routes is the mirrored legacy Minecraft
    // site, whose launcher, game page and hashed asset paths all need this
    // origin's root.
    if (!pathname.startsWith("/approved-")) {
      return handleLegacyMirror(request, url);
    }

    const denied = denyOrigin(request, env);
    if (denied) return denied;
    if (request.method === "OPTIONS") return preflight(request);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return withCors(request, textError(405, "Only GET, HEAD and OPTIONS are supported"));
    }
    try {
      return withCors(request, await handleApproved(request, env, url));
    } catch (error) {
      console.error("arcade route failed", pathname, String(error));
      return withCors(request, textError(502, "The approved game route failed"));
    }
  }
};
