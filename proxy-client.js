// Curated game/movie player. Static assets run on GitHub Pages.
// Its chosen transport connects to Render or a configured CloudFront WebSocket distribution.
let controller;
let initialization;
let currentStage = "Not started";
const progressListeners = new Set();
const base = new URL("./", import.meta.url).pathname;
const asset = path => base + path;
const allowed = new Set(["mclegacy.pages.dev", "wasm.rip", "shuttletv.pk", "raw.githack.com", "ripjaw1219.github.io", "monoxide.dev", "c00lkiddtech.github.io", "linkawaken1979-alt.github.io", "mollomm1.github.io", "sagaofowlz.github.io"]);
// Exact entry points on shared hosting domains prevent arbitrary navigation.
const gameEntries = new Set(["https://mclegacy.pages.dev/","https://ripjaw1219.github.io/super-mario-64-javascript/start.html","https://monoxide.dev/ultrakill/","https://c00lkiddtech.github.io/md-/","https://linkawaken1979-alt.github.io/kisakcod/","https://raw.githack.com/Truf-Porter/HTMLgta/main/index.html","https://mollomm1.github.io/test/","https://sagaofowlz.github.io/hmm/","https://raw.githack.com/web-ports/fish/main/index.html"]);
const RENDER_ENDPOINT = "wss://seuss-cinema-arcade.onrender.com/wisp/";
const RELAY_STORAGE_KEY = "seuss-cinema-relay-v1";

// CloudFront is a CDN/WebSocket reverse proxy, not a Node.js/Wisp host.
// Keep the CloudFront choice restricted to a distribution domain and /wisp/ path.
export function normalizeCloudFrontDomain(input) {
  let value = String(input || "").trim().toLowerCase();
  if (value.startsWith("https://")) value = value.slice("https://".length);
  if (value.startsWith("wss://")) value = value.slice("wss://".length);
  value = value.replace(/\/$/, "");
  if (!/^d[a-z0-9-]{7,60}\.cloudfront\.net$/.test(value)) {
    throw new Error("Enter an AWS CloudFront distribution hostname, for example d1234567890abc.cloudfront.net.");
  }
  return value;
}
export function getRelaySettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(RELAY_STORAGE_KEY) || "null");
    if (stored?.provider === "cloudfront") {
      const domain = normalizeCloudFrontDomain(stored.domain);
      return { provider: "cloudfront", domain, endpoint: "wss://" + domain + "/wisp/" };
    }
  } catch (error) {
    console.warn("[Seuss relay] Using default Render relay:", error.message);
  }
  return { provider: "render", domain: "", endpoint: RENDER_ENDPOINT };
}
export function saveRelaySettings(provider, domain) {
  if (provider !== "render" && provider !== "cloudfront") {
    throw new Error("Choose Render or CloudFront.");
  }
  const next = provider === "cloudfront"
    ? {provider, domain: normalizeCloudFrontDomain(domain)}
    : {provider: "render", domain: ""};
  localStorage.setItem(RELAY_STORAGE_KEY, JSON.stringify(next));
  return getRelaySettings();
}
export function testRelaySettings(provider, domain, timeoutMs = 9000) {
  let endpoint;
  if (provider === "render") endpoint = RENDER_ENDPOINT;
  else if (provider === "cloudfront") endpoint = "wss://" + normalizeCloudFrontDomain(domain) + "/wisp/";
  else return Promise.reject(new Error("Unknown relay provider."));
  return new Promise((resolve, reject) => {
    let socket;
    let finished = false;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (socket) {
        socket.onopen = null; socket.onerror = null; socket.onclose = null;
        try { socket.close(); } catch {}
      }
      if (err) reject(err); else resolve(endpoint);
    };
    const timer = setTimeout(() => finish(new Error("The selected relay did not respond within 9 seconds.")), timeoutMs);
    try {
      socket = new WebSocket(endpoint);
      socket.onopen = () => finish(null);
      socket.onerror = () => finish(new Error("Unable to open a secure WebSocket to " + endpoint + ". Check the distribution's origin, /wisp/ behavior, WebSocket headers and allowed website origins."));
      socket.onclose = () => finish(new Error("The relay closed the WebSocket before it connected."));
    } catch (error) { finish(error); }
  });
}
const MAX_STARTUP_MS = 15000;

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
function report(stage, onProgress) {
  currentStage = stage;
  console.info("[Seuss player]", stage);
  if (typeof onProgress === "function") onProgress(stage);
  for (const listener of progressListeners) listener(stage);
}

// Check the worker's controller import before creating the Scramjet controller.
// A worker that installed after swallowing importScripts errors cannot handshake.
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
async function createController(onProgress) {
  report("Registering service worker…", onProgress);
  const registration = await timeout(
    navigator.serviceWorker.register(asset("sw.js"), {scope: base, updateViaCache: "none"}),
    "Service-worker registration"
  );
  report("Activating service worker…", onProgress);
  // Do not await controllerchange: clients.claim() may not immediately attach
  // to this already-open document. A live registration.active worker suffices.
  await timeout(navigator.serviceWorker.ready, "Service-worker activation");
  const worker = registration.active || (await navigator.serviceWorker.getRegistration(base))?.active;
  if (!worker) throw new Error("Service worker is not active; reload the page and try again.");
  report("Checking service-worker runtime…", onProgress);
  await checkWorker(worker);

  report("Loading player scripts…", onProgress);
  for (const src of [
    asset("scram/scramjet.js"),
    asset("controller/controller.api.js"),
    asset("utils/scramjet-utils.js")
  ]) await loadScript(src);

  if (typeof window.$scramjetController?.Controller !== "function") {
    throw new Error("Scramjet controller did not initialize. Check browser console for script errors.");
  }

  const selectedRelay = getRelaySettings();
  report("Setting up " + (selectedRelay.provider === "cloudfront" ? "CloudFront" : "Render") + " transport…", onProgress);
  const module = await timeout(import(asset("libcurl/index.mjs")), "Loading transport module");
  const LibcurlClient = module.default;
  if (typeof LibcurlClient !== "function") {
    throw new Error("Libcurl transport module did not export a client.");
  }
  const transport = new LibcurlClient({wisp: selectedRelay.endpoint});
  const instance = new window.$scramjetController.Controller({
    serviceworker: worker,
    transport,
    config: {
      scramjetPath: asset("scram/scramjet.js"),
      wasmPath: asset("scram/scramjet.wasm"),
      injectPath: asset("controller/controller.inject.js"),
      prefix: base + "scramjet/"
    }
  });
  report("Initializing Scramjet controller…", onProgress);
  if (typeof instance.wait === "function")
    await timeout(instance.wait(), "Scramjet controller initialization (worker handshake, WebAssembly or browser storage)", 20000);
  report("Scramjet controller ready", onProgress);
  return instance;
}

// Begin initializing when the dashboard loads, rather than on first Play.
export function warmupPlayer() {
  if (!navigator.serviceWorker || controller || initialization) return;
  initialization = createController().then(value => {
    controller = value;
    return value;
  }).finally(() => { initialization = undefined; });
  // Observe background failures without swallowing them for an active Play request.
  initialization.catch(error => console.warn("[Seuss player] Background warmup failed:", error));
}

export async function openProxied(iframe, url, onProgress) {
  const target = new URL(url);
  if (target.protocol !== "https:" ||
    ![...allowed].some(host => target.hostname === host || target.hostname.endsWith("." + host))) {
    throw new Error("Only approved games and movie destinations can be opened.");
  }
  if (target.hostname !== "wasm.rip" && target.hostname !== "shuttletv.pk" && !gameEntries.has(target.href)) {
    throw new Error("Only the approved game entry points can be opened here.");
  }
  if (!navigator.serviceWorker)
    throw new Error("This browser does not support service workers.");

  if (!controller) {
    if (!initialization) initialization = createController(onProgress).then(value => {
      controller = value;
      return value;
    }).finally(() => { initialization = undefined; });
    if (typeof onProgress === "function") {
      onProgress(currentStage);
      progressListeners.add(onProgress);
    }
    try { await initialization; }
    finally { progressListeners.delete(onProgress); }
  }
  report("Opening selected content…", onProgress);
  const frame = controller.createFrame(iframe);
  await timeout(Promise.resolve(frame.go(target.href)), "Starting content");
}
