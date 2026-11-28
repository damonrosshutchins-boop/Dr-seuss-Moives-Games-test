// Seuss Search v2 client: unrestricted public-web navigation through the
// Cloudflare-hosted Wisp relay. Any http(s) destination the relay can resolve.
// The curated player (proxy-client.js) keeps its own allowlist for games.
import { browserLikeTransport } from "./proxy-headers.js";
import { politeTransport } from "./proxy-politeness.js";
import { EpoxyFirstTransport } from "./proxy-fallback.js";
const base = new URL("./", import.meta.url).pathname;
const asset = path => base + path;
// Keep in sync with package.json and sw.js. Versioned runtime URLs make a
// returning visitor fetch the matching Scramjet build instead of a cached one.
const RUNTIME_VERSION = "2.1.0";
const runtime = path => asset(path) + "?v=" + RUNTIME_VERSION;
// A freshly updated worker has no frame routes until this page reloads. Bind
// the page to the worker build it is actually running, once per version.
function reloadOnWorkerUpdate() {
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) return;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    try {
      if (sessionStorage.getItem("seuss-worker-runtime") === RUNTIME_VERSION) return;
      sessionStorage.setItem("seuss-worker-runtime", RUNTIME_VERSION);
    } catch { return; }
    location.reload();
  }, { once: true });
}
reloadOnWorkerUpdate();
// Relay choice lives in localStorage so Settings can switch between the default
// Cloudflare relay and any custom endpoint.
const ARCADE_ENDPOINT = "wss://seuss-arcade-relay.damonrosshutchins.workers.dev/wisp/";
const RELAY_KEY = "seuss-relay";
const onLoopback = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const loopbackEndpoint = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/wisp/";

export function readRelay() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(RELAY_KEY) || "{}") || {}; } catch { stored = {}; }
  // "render" and "cloudflare" are the older stored names for the same relay.
  const mode = ["arcade", "render", "cloudflare", "custom"].includes(stored.mode) ? stored.mode : null;
  return {
    mode: mode === "render" || mode === "cloudflare" ? "arcade" : mode,
    cloudflare: typeof stored.cloudflare === "string" && stored.cloudflare.trim()
      ? stored.cloudflare.trim()
      : ARCADE_ENDPOINT,
    custom: typeof stored.custom === "string" ? stored.custom.trim() : ""
  };
}

export function writeRelay(next) {
  try { localStorage.setItem(RELAY_KEY, JSON.stringify(next)); } catch { /* private mode */ }
}

function pickEndpoint() {
  const relay = readRelay();
  if (relay.mode === "arcade" && relay.cloudflare) return relay.cloudflare;
  if (relay.mode === "custom" && relay.custom) return relay.custom;
  return onLoopback ? loopbackEndpoint : ARCADE_ENDPOINT;
}

const endpoint = pickEndpoint();
export const relaySource = onLoopback && endpoint === loopbackEndpoint ? "local" : "remote";
// DuckDuckGo's HTML endpoint rather than the main duckduckgo.com app: it answers
// with a plain results page instead of a JavaScript shell that has to boot inside
// the proxied frame, and the app endpoint replies to relay traffic with a bot
// challenge (HTTP 202) where this one still returns results.
const SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/?q=";
const MAX_STARTUP_MS = 20000;
let controller;
let initialization;
let frame;
let keepAlive;

// Browsers stop an idle service worker after ~30s and the relay registry lives
// inside it, so routing silently falls through to the host until something
// wakes the worker. A periodic no-op message keeps it resident.
function keepWorkerWarm(worker) {
  clearInterval(keepAlive);
  keepAlive = setInterval(() => {
    try { worker.postMessage("seuss-keepalive"); }
    catch { clearInterval(keepAlive); keepAlive = undefined; }
  }, 15000);
}

export const relayEndpoint = endpoint;
export { ARCADE_ENDPOINT, loopbackEndpoint, RELAY_KEY };

// Link quality for the relay actually in use. Ping runs on the same WebSocket
// path the tunnel uses; throughput downloads the relay's /speedtest payload, so
// both numbers describe this browser's path to that particular relay.
export function relayHost() {
  try { return new URL(endpoint.replace(/^ws/, "http")).hostname; } catch { return location.hostname; }
}

export function relayHttpOrigin() {
  try { return new URL(endpoint.replace(/^ws/, "http")).origin; } catch { return location.origin; }
}

export function relayLabelOf(url) {
  let host;
  try { host = new URL(url.replace(/^ws/, "http")).hostname; } catch { host = location.hostname; }
  if (host.endsWith("workers.dev")) return "Cloudflare";
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(host)) return "Local";
  return host;
}

export function relayLabel() { return relayLabelOf(endpoint); }

// Every relay this browser has configured, so an override and the default can
// be compared side by side instead of only seeing the one currently selected.
export function relayCandidates() {
  const relay = readRelay();
  const list = [{ key: "arcade", name: "Cloudflare", endpoint: ARCADE_ENDPOINT }];
  if (relay.cloudflare && relay.cloudflare !== ARCADE_ENDPOINT)
    list.push({ key: "cloudflare", name: "Cloudflare", endpoint: relay.cloudflare });
  if (relay.custom) list.push({ key: "custom", name: relayLabelOf(relay.custom), endpoint: relay.custom });
  if (onLoopback) list.push({ key: "local", name: "Local", endpoint: loopbackEndpoint });
  const seen = new Set();
  return list
    .filter(item => (seen.has(item.endpoint) ? false : seen.add(item.endpoint)))
    .map(item => ({ ...item, active: item.endpoint === endpoint }));
}

// The first connection to a relay pays DNS, TLS and (for the Cloudflare Worker)
// Durable Object start-up, so it is a cold-start figure rather than a link
// measurement. Sample one extra time and drop the first result.
async function medianPing(url, pings) {
  const samples = [];
  for (let i = 0; i <= pings; i++) {
    const sample = await pingRelay(url, 6000);
    if (sample !== null && i > 0) samples.push(sample);
    if (i < pings) await new Promise(resolve => setTimeout(resolve, 120));
  }
  samples.sort((a, b) => a - b);
  return samples.length ? samples[Math.floor(samples.length / 2)] : null;
}

// Latency for every configured relay at once, so the Cloudflare figure is
// available even when Cloudflare is the relay in use.
export async function measureRelayPings(pings = 2) {
  return Promise.all(relayCandidates().map(async target => ({
    ...target,
    ping: await medianPing(target.endpoint, pings)
  })));
}

function pingRelay(url, limit) {
  return new Promise(resolve => {
    const started = performance.now();
    let settled = false;
    let socket;
    let timer;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (socket) socket.close(); } catch { /* already closing */ }
      resolve(value);
    };
    timer = setTimeout(() => finish(null), limit);
    try { socket = new WebSocket(url); } catch { finish(null); return; }
    socket.onopen = () => finish(Math.round(performance.now() - started));
    socket.onerror = () => finish(null);
    socket.onclose = () => finish(null);
  });
}

// ping=null means the relay never answered; ping=0 samples are dropped. mbps is
// null when the payload could not be fetched (no /speedtest, blocked CORS).
export async function measureRelaySpeed({ pings = 3, bytes = 1200000 } = {}) {
  const ping = await medianPing(endpoint, pings);
  let mbps = null;
  if (bytes > 0) {
    try {
      const started = performance.now();
      const response = await fetch(relayHttpOrigin() + "/speedtest?bytes=" + bytes, { cache: "no-store" });
      const payload = await response.arrayBuffer();
      const seconds = (performance.now() - started) / 1000;
      if (payload.byteLength > 0 && seconds > 0) mbps = (payload.byteLength * 8) / 1e6 / seconds;
    } catch { mbps = null; }
  }
  return { ping, mbps, label: relayLabel(), endpoint };
}

export function searchUrl(query) {
  return SEARCH_ENDPOINT + encodeURIComponent(String(query || "").trim());
}

// "cats" searches, "example.com" opens a site, and a full URL is used as-is.
export function resolveTarget(raw) {
  const value = String(raw || "").trim();
  if (!value) throw new Error("Type a search or a URL first.");
  if (/^https?:\/\//i.test(value)) return new URL(value);
  const looksLikeHost = /^[a-z0-9-]+(\.[a-z0-9-]+)+(?::\d+)?([/?#]|$)/i.test(value);
  if (looksLikeHost && !/\s/.test(value)) return new URL("https://" + value);
  return new URL(searchUrl(value));
}

function timeout(promise, name, ms = MAX_STARTUP_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(name + " timed out after " + Math.round(ms / 1000) + " seconds")), ms))
  ]);
}
function loadScript(src) {
  return timeout(new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Cannot load required script: " + src));
    document.head.append(script);
  }), "Loading " + src);
}
function report(stage, onStage) {
  console.info("[Seuss search]", stage);
  if (typeof onStage === "function") onStage(stage);
}

// A worker that swallowed an importScripts error cannot complete the handshake.
function checkWorker(worker) {
  return timeout(new Promise((resolve, reject) => {
    const onMessage = event => {
      if (event.data?.type !== "seuss-worker-diagnostics") return;
      navigator.serviceWorker.removeEventListener("message", onMessage);
      if (event.data.loaded) resolve();
      else reject(new Error("Service worker controller failed to load: " +
        (event.data.error || "unknown error") + " (" + event.data.controllerUrl + ")"));
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    try { worker.postMessage("seuss-worker-diagnostics"); }
    catch (error) {
      navigator.serviceWorker.removeEventListener("message", onMessage);
      reject(error);
    }
  }), "Service-worker controller handshake", 5000);
}

// Epoxy is a purpose-built Rust/WASM TLS stack. It initialises faster than
// libcurl, but it is pickier about unusual servers, so it goes first and
// libcurl (built only when needed) catches anything it cannot finish.
async function makeEpoxy() {
  const module = await timeout(import(asset("epoxy/index.mjs")), "Loading Epoxy transport module");
  const EpoxyClient = module.default;
  if (typeof EpoxyClient !== "function") throw new Error("Epoxy transport module did not export a client.");
  const transport = new (politeTransport(browserLikeTransport(EpoxyClient)))({ wisp: endpoint });
  await timeout(transport.init(), "Starting Epoxy transport", 20000);
  return transport;
}
// libcurl keeps a 40-entry connection cache and only 6 sockets per host, which
// serialises asset-heavy pages: a search results page pulls dozens of files
// from a single host. The middle figure keeps more sockets open than the 6 a
// browser uses, without the 120-wide burst a destination sees as hammering.
async function makeLibcurl() {
  const module = await timeout(import(asset("libcurl/index.mjs")), "Loading libcurl transport module");
  const LibcurlClient = module.default;
  if (typeof LibcurlClient !== "function") throw new Error("Libcurl transport module did not export a client.");
  return new (politeTransport(browserLikeTransport(LibcurlClient)))({ wisp: endpoint, connections: [64, 48, 8] });
}

async function createController(onStage) {
  report("Registering service worker…", onStage);
  const registration = await timeout(
    navigator.serviceWorker.register(asset("sw.js"), { scope: base, updateViaCache: "none" }),
    "Service-worker registration"
  );
  report("Activating service worker…", onStage);
  await timeout(navigator.serviceWorker.ready, "Service-worker activation");
  const worker = registration.active || (await navigator.serviceWorker.getRegistration(base))?.active;
  if (!worker) throw new Error("Service worker is not active; reload the page and try again.");
  report("Checking service-worker runtime…", onStage);
  await checkWorker(worker);
  keepWorkerWarm(worker);

  report("Loading relay scripts…", onStage);
  // controller.api.js and the utils hang off the namespace scramjet.js creates,
  // so that one still goes first; the other two only need it, not each other.
  await loadScript(runtime("scram/scramjet.js"));
  await Promise.all([
    runtime("controller/controller.api.js"),
    runtime("utils/scramjet-utils.js")
  ].map(loadScript));

  if (typeof window.$scramjetController?.Controller !== "function") {
    throw new Error("Scramjet controller did not initialize. Check the browser console.");
  }

  report("Connecting to the Cloudflare relay…", onStage);
  // Hand the Controller an Epoxy-first transport. If Epoxy cannot load or start,
  // the catch builds libcurl instead, so a missing Epoxy runtime never blocks a
  // search. If Epoxy starts but a later request fails, the wrapper switches.
  let transport;
  try {
    transport = new EpoxyFirstTransport(await makeEpoxy(), makeLibcurl);
    console.info("[Seuss search] Transport: Epoxy (libcurl on failure)");
  } catch (error) {
    console.warn("[Seuss search] Epoxy unavailable; using libcurl.", error);
    report("Epoxy unavailable · using libcurl…", onStage);
    transport = await makeLibcurl();
    console.info("[Seuss search] Transport: libcurl");
  }
  const instance = new window.$scramjetController.Controller({
    serviceworker: worker,
    transport,
    config: {
      scramjetPath: runtime("scram/scramjet.js"),
      wasmPath: runtime("scram/scramjet.wasm"),
      injectPath: runtime("controller/controller.inject.js"),
      prefix: base + "scramjet/"
    }
  });
  report("Initializing relay controller…", onStage);
  if (typeof instance.wait === "function")
    await timeout(instance.wait(), "Relay initialization (worker handshake, WebAssembly or storage)", 30000);
  report("Relay ready", onStage);
  return instance;
}

export async function browse(iframe, raw, onStage) {
  const target = resolveTarget(raw);
  if (target.protocol !== "https:" && target.protocol !== "http:")
    throw new Error("Only http and https pages can be opened.");
  if (!navigator.serviceWorker)
    throw new Error("This browser does not support service workers, which the relay needs.");

  if (!controller) {
    if (!initialization) initialization = createController(onStage).then(value => {
      controller = value;
      return value;
    }).finally(() => { initialization = undefined; });
    await initialization;
  }
  report("Opening page…", onStage);
  if (!frame) frame = controller.createFrame(iframe);
  try {
    await timeout(Promise.resolve(frame.go(target.href)), "Starting page");
  } catch (error) {
    // A wisp socket that drops during the request usually recovers on the second
    // attempt, and the controller is already up, so retrying costs one request
    // instead of making the reader type the address again.
    report("First attempt failed, retrying…", onStage);
    await new Promise(resolve => setTimeout(resolve, 700));
    await timeout(Promise.resolve(frame.go(target.href)), "Starting page");
  }
  return target;
}

export function currentFrame() {
  return frame || null;
}

// The controller costs about a second on a cold page (service worker handshake,
// relay scripts, wasm fetch, wisp websocket). Paying it while the page sits idle
// turns the first search into just a navigation.
export function preconnectRelay() {
  try {
    const origin = relayHttpOrigin();
    for (const rel of ["preconnect", "dns-prefetch"]) {
      if (document.querySelector('link[data-seuss-relay][rel="' + rel + '"]')) continue;
      const link = document.createElement("link");
      link.rel = rel;
      link.href = origin;
      if (rel === "preconnect") link.crossOrigin = "anonymous";
      link.dataset.seussRelay = origin;
      document.head.append(link);
    }
    if (!document.querySelector('link[data-seuss-transport]')) {
      const module = document.createElement("link");
      module.rel = "modulepreload";
      module.href = asset("epoxy/index.mjs");
      module.dataset.seussTransport = "epoxy";
      document.head.append(module);
    }
  } catch { /* hints are optional */ }
}

let priming;
export function primeRelay() {
  preconnectRelay();
  if (controller) return Promise.resolve(controller);
  if (!navigator.serviceWorker) return Promise.resolve(null);
  if (!priming) {
    priming = createController(() => {}).then(value => {
      controller = value;
      return value;
    }).catch(error => {
      console.info("[Seuss search] Warm-up skipped:", error?.message || error);
      return null;
    }).finally(() => { priming = undefined; });
  }
  return priming;
}
