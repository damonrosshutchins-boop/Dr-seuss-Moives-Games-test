// Requests through the Wisp tunnel are assembled from the browser's own headers,
// but they can still look less like a browser than they should:
//   - synthesized requests (XHR/fetch rebuilt by Scramjet) can miss the
//     low-entropy client hints Chrome sends to every secure origin;
//   - WebSocket handshakes carry only a user agent and origin, where Chrome also
//     sends Accept-Language, Accept-Encoding and cache directives;
//   - any proxy header that leaks through is an immediate giveaway.
// This wraps the libcurl transport so every outbound request leaves with a
// consistent, Chrome-shaped header set. It only fills gaps and drops proxy
// headers; it never overwrites a header the browser already supplied.
//
// What this cannot change: the relay's egress address is a Cloudflare Worker's,
// and TLS is terminated inside libcurl.wasm rather than by the browser, so IP
// reputation and the TLS fingerprint still identify the connection as a proxy.
// A site that challenges will still challenge, and the person browsing has to
// solve that challenge; this does not forge clearance cookies or solve them.
const DROP = new Set([
  "via", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
  "x-real-ip", "proxy-connection", "x-proxy-id", "x-scramjet"
]);
// Privacy, not disguise: the referer a proxied request would carry is this site's
// own address (Scramjet rebuilds it from the frame URL), so every destination a
// reader visits would learn where they came from. The browser offers the same
// control as Referrer-Policy: no-referrer, which is what this does for the
// tunnel. Nothing is forged; the header is simply not sent.

function normalize(headers) {
  const out = [];
  for (const entry of headers || []) {
    const name = entry && entry[0];
    const lower = String(name || "").toLowerCase();
    if (!name || DROP.has(lower) || lower === "referer") continue;
    out.push([name, entry[1]]);
  }
  return out;
}
function has(headers, name) {
  return headers.some(entry => String(entry[0]).toLowerCase() === name);
}
function get(headers, name) {
  const found = headers.find(entry => String(entry[0]).toLowerCase() === name);
  return found ? String(found[1] ?? "") : "";
}
function drop(headers, name) {
  for (let index = headers.length - 1; index >= 0; index--) {
    if (String(headers[index][0]).toLowerCase() === name) headers.splice(index, 1);
  }
}
function add(headers, name, value) {
  if (value && !has(headers, name)) headers.push([name, value]);
}

// navigator.languages order and q-values, the way Chrome builds Accept-Language.
function acceptLanguage() {
  const list = navigator.languages && navigator.languages.length
    ? navigator.languages
    : [navigator.language || "en-US"];
  return list.map((tag, index) =>
    index === 0 ? tag : tag + ";q=" + Math.max(0.1, 1 - index / 10).toFixed(1)
  ).join(",");
}
// The low-entropy hints Chrome sends to every secure origin by default. Only
// added when the browser exposes them, so the values always match the real UA.
function clientHints(headers) {
  const data = navigator.userAgentData;
  if (!data || !Array.isArray(data.brands)) return;
  add(headers, "sec-ch-ua", data.brands.map(brand => `"${brand.brand}";v="${brand.version}"`).join(", "));
  add(headers, "sec-ch-ua-mobile", data.mobile ? "?1" : "?0");
  add(headers, "sec-ch-ua-platform", '"' + data.platform + '"');
}
function requestHeaders(headers, remote, method) {
  const out = normalize(headers);
  add(out, "accept-language", acceptLanguage());
  clientHints(out);
  // Scramjet rebuilds Origin from whichever frame started the request, so a plain
  // navigation can arrive carrying the previous destination's origin and hand it
  // to the next site. A browser sends no Origin on a cross-site GET/HEAD, so an
  // origin that does not belong to the destination is dropped there. Other
  // methods keep it: forms and fetches need it.
  if (remote && /^(GET|HEAD)$/i.test(String(method || ""))) {
    const origin = get(out, "origin");
    if (origin) {
      let host = "";
      try { host = new URL(origin).hostname; } catch { host = ""; }
      if (!host || host.toLowerCase() !== String(remote.hostname || "").toLowerCase()) drop(out, "origin");
    }
  }
  return out;
}
// A Chrome WebSocket handshake is a GET with no-cache directives and an
// Accept-Encoding; libcurl leaves those off unless asked.
function socketHeaders(headers) {
  const out = requestHeaders(headers);
  add(out, "pragma", "no-cache");
  add(out, "cache-control", "no-cache");
  add(out, "accept-encoding", "gzip, deflate, br");
  return out;
}

export function browserLikeTransport(Base) {
  return class BrowserLikeTransport extends Base {
    request(remote, method, body, headers, signal) {
      return super.request(remote, method, body, requestHeaders(headers, remote, method), signal);
    }
    connect(url, protocols, headers, onopen, onmessage, onclose, onerror) {
      return super.connect(url, protocols, socketHeaders(headers), onopen, onmessage, onclose, onerror);
    }
  };
}
