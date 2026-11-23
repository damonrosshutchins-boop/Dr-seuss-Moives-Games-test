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

function normalize(headers) {
  const out = [];
  for (const entry of headers || []) {
    const name = entry && entry[0];
    if (!name || DROP.has(String(name).toLowerCase())) continue;
    out.push([name, entry[1]]);
  }
  return out;
}
function has(headers, name) {
  return headers.some(entry => String(entry[0]).toLowerCase() === name);
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
function requestHeaders(headers) {
  const out = normalize(headers);
  add(out, "accept-language", acceptLanguage());
  clientHints(out);
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
      return super.request(remote, method, body, requestHeaders(headers), signal);
    }
    connect(url, protocols, headers, onopen, onmessage, onclose, onerror) {
      return super.connect(url, protocols, socketHeaders(headers), onopen, onmessage, onclose, onerror);
    }
  };
}
