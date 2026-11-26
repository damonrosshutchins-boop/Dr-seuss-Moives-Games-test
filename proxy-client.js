// Curated game/movie player. Static assets run on GitHub Pages.
// Its configured transport connects to the separately hosted Cloudflare Wisp service.
import { browserLikeTransport } from "./proxy-headers.js";
import { politeTransport } from "./proxy-politeness.js";
let controller;
let initialization;
let currentStage = "Not started";
const progressListeners = new Set();
const base = new URL("./", import.meta.url).pathname;
const asset = path => base + path;
const allowed = new Set(["cdn.jsdelivr.net", "game.azgame.io", "nostaligafun.pages.dev", "wasm.rip", "shuttletv.pk", "raw.githack.com", "ripjaw1219.github.io", "c00lkiddtech.github.io", "mollomm1.github.io", "sagaofowlz.github.io", "stg420.github.io", "projection-studios.dogeeats531.workers.dev", "2v2.io", "gd-webport.pages.dev", "seuss-arcade-games.surge.sh", "seuss-centipede.surge.sh", "seuss-games-a1.surge.sh", "seuss-games-a2.surge.sh", "seuss-games-a3.surge.sh", "seuss-games-a5.surge.sh", "seuss-games-a6.surge.sh", "damonrosshutchins-boop.github.io", "seuss-arcade-relay.damonrosshutchins.workers.dev"]);
// Exact entry points on shared hosting domains prevent arbitrary navigation.
const gameEntries = new Set(["https://seuss-arcade-relay.damonrosshutchins.workers.dev/approved-games/nowgg/","https://seuss-arcade-relay.damonrosshutchins.workers.dev/approved-games/kahoot/","https://seuss-arcade-relay.damonrosshutchins.workers.dev/approved-games/blooket/","https://seuss-arcade-relay.damonrosshutchins.workers.dev/approved-games/2v2/",,"https://seuss-games-a1.surge.sh/milkman-karlson/index.html","https://seuss-games-a1.surge.sh/minesweeperplus/index.html","https://seuss-games-a2.surge.sh/baldi-remaster/index.html","https://seuss-games-a3.surge.sh/speed-stars/index.html","https://seuss-games-a5.surge.sh/the-man-in-the-window/index.html","https://seuss-games-a5.surge.sh/bergentruck/index.html","https://cdn.jsdelivr.net/gh/3cfl/balatro-webport@7255b72aaae4b572d171a8ff24ace071aa02f3f7/balatro.html","https://seuss-arcade-relay.damonrosshutchins.workers.dev/", "https://game.azgame.io/wacky-flip/", "https://nostaligafun.pages.dev/games/games-accualy/GC/PaperMarioTheThousandYearDoor_Data/index.html", "https://seuss-arcade-relay.damonrosshutchins.workers.dev/approved-games/toby/","https://gd-webport.pages.dev/","https://ripjaw1219.github.io/super-mario-64-javascript/start.html","https://c00lkiddtech.github.io/md-/","https://mollomm1.github.io/test/","https://sagaofowlz.github.io/hmm/","https://stg420.github.io/ultrakill/","https://raw.githack.com/web-ports/fish/main/index.html", "https://projection-studios.dogeeats531.workers.dev/", "https://seuss-arcade-relay.damonrosshutchins.workers.dev/movies/projection/","https://seuss-arcade-relay.damonrosshutchins.workers.dev/movies/movy/", "https://seuss-arcade-relay.damonrosshutchins.workers.dev/movies/youshows/", "https://seuss-arcade-relay.damonrosshutchins.workers.dev/approved-games/needle/", "https://seuss-arcade-games.surge.sh/cheese/index.html", "https://seuss-arcade-games.surge.sh/run2/index.html", "https://seuss-arcade-games.surge.sh/balatro/index.html", "https://damonrosshutchins-boop.github.io/centipede-mirror/centipede/index.html", "https://damonrosshutchins-boop.github.io/centipede-mirror/games/karlson/index.html", "https://damonrosshutchins-boop.github.io/centipede-mirror/games/happy-sheepies/index.html", "https://damonrosshutchins-boop.github.io/centipede-mirror/games/sonic-exe/index.html", "https://damonrosshutchins-boop.github.io/centipede-mirror/games/slender/index.html", "https://damonrosshutchins-boop.github.io/centipede-mirror/games/tattletail/index.html", "https://damonrosshutchins-boop.github.io/centipede-mirror/games/jelly-drift/index.html", "https://damonrosshutchins-boop.github.io/deltatraveler-mirror/index.html", "https://damonrosshutchins-boop.github.io/undertale-yellow-mirror/index.html", "https://damonrosshutchins-boop.github.io/thats-not-my-neighbor-mirror/index.html", "https://damonrosshutchins-boop.github.io/donottakethiscathome-mirror/index.html", "https://damonrosshutchins-boop.github.io/dead-plate-mirror/index.html", "https://seuss-arcade-games.surge.sh/centipede/index.html","https://seuss-centipede.surge.sh/index.html","https://seuss-centipede.surge.sh/index.html?autostart=1", "https://damonrosshutchins-boop.github.io/Geometry-Dash-webport/","https://damonrosshutchins-boop.github.io/crazy-games/"]);
const endpoint = "wss://seuss-arcade-relay.damonrosshutchins.workers.dev/wisp/";
const MAX_STARTUP_MS = 15000;
const KEEPALIVE_MS = 15000;
let registration;
let keepaliveTimer;
let proxyPrefix;

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
// A browser stops an idle service worker after about 30 seconds, and Scramjet's
// worker keeps its frame routing table in module scope. The restarted worker
// has forgotten every prefix, so the next proxied navigation is not intercepted
// and lands on the static host's 404 page instead of the proxy. Pinging keeps
// the worker alive; probeRouting() below verifies it before a frame navigates.
function pingWorker() {
  try {
    const worker = navigator.serviceWorker.controller || registration?.active;
    worker?.postMessage({type: "seuss-sw-keepalive"});
  } catch (error) {
    console.warn("[Seuss player] Service-worker ping failed:", error);
  }
}
async function probeRouting(prefix) {
  try {
    const response = await fetch(new URL(prefix + "route-check", location.href).href, {
      cache: "no-store",
      signal: AbortSignal.timeout(2500)
    });
    // A routed request is answered by the worker (500 for an unknown frame); a
    // 404 comes from the static host, which means the worker is not routing.
    return response.status !== 404;
  } catch {
    return false;
  }
}
async function ensureRouting(controller, prefix, onProgress) {
  if (await probeRouting(prefix)) return true;
  report("Waking the proxy route…", onProgress);
  for (let attempt = 0; attempt < 12; attempt++) {
    // Re-sending the controller handshake both wakes a stopped worker and
    // restores this page's frame prefix in its routing table.
    try {
      if (typeof controller.setupMessagePort === "function") controller.setupMessagePort();
      else pingWorker();
    } catch (error) {
      console.warn("[Seuss player] Route handshake failed:", error);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
    if (await probeRouting(prefix)) return true;
  }
  return false;
}
// A page the archive could not proxy: the static host's 404 page or the worker's
// own error document. Both are safe to retry once the route is restored.
function failedFrameMessage(iframe) {
  let detail = "";
  try { detail = (iframe.contentDocument?.body?.textContent || "").trim().slice(0, 200); } catch {}
  return detail
    ? "This destination could not be loaded through the proxy: " + detail
    : "This destination could not be loaded through the proxy. Try Reload or another item.";
}
async function frameState(iframe) {
  try {
    const doc = iframe.contentDocument;
    if (!doc) return "loading";
    const text = (doc.body?.textContent || "").slice(0, 400);
    if (/GitHub Pages/i.test(doc.title || "") || /Page not found/i.test(doc.title || "") ||
      /Internal Service Worker Error/i.test(text)) return "failed";
    if (doc.readyState === "complete" && (doc.title || "").trim()) return "loaded";
    return "loading";
  } catch {
    return "loading";
  }
}
async function createController(onProgress) {
  report("Registering service worker…", onProgress);
  registration = await timeout(
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

  report("Setting up Cloudflare transport…", onProgress);
  const module = await timeout(import(asset("libcurl/index.mjs")), "Loading transport module");
  const LibcurlClient = module.default;
  if (typeof LibcurlClient !== "function") {
    throw new Error("Libcurl transport module did not export a client.");
  }
  // Every outbound request leaves with Chrome-shaped headers, no proxy headers,
  // and a 429/503 that asks for a pause is honoured instead of retried at once.
  const BrowserLibcurl = politeTransport(browserLikeTransport(LibcurlClient));
  const transport = new BrowserLibcurl({wisp: endpoint});
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
  proxyPrefix = instance.prefix || (base + "scramjet/");
  if (!keepaliveTimer) keepaliveTimer = setInterval(pingWorker, KEEPALIVE_MS);
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

// Scramjet stamps a frame handle's routing prefix when the handle is created
// and keeps its own table in the worker. A second handle for one element, or a
// handle whose element was replaced, produces requests that match no frame and
// the worker answers them with 500 "No frame found for request". Keep exactly
// one handle per element and rebuild it only when the controller is replaced.
let frameElement = null, frameHandle = null, frameController = null;
function frameHandleFor(controller, iframe) {
  if (!frameHandle || frameElement !== iframe || frameController !== controller) {
    frameHandle = controller.createFrame(iframe);
    frameElement = iframe;
    frameController = controller;
  }
  return frameHandle;
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
  const prefix = controller.prefix || proxyPrefix || (base + "scramjet/");
  await ensureRouting(controller, prefix, onProgress);
  const frame = frameHandleFor(controller, iframe);
  await timeout(Promise.resolve(frame.go(target.href)), "Starting content");
  // The route can still be lost between the probe and the navigation; a lost
  // route shows up as the host's 404 page, which one retry recovers from.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const state = await frameState(iframe);
    if (state === "loaded") return;
    if (state === "failed") {
      report("Proxy route was lost · retrying", onProgress);
      if (!await ensureRouting(controller, prefix, onProgress)) {
        throw new Error("The proxy route could not be restored. Reload the page and try again.");
      }
      await timeout(Promise.resolve(frame.go(target.href)), "Retrying content");
      // Report what the frame actually shows: a destination the relay cannot
      // reach must not look like an arcade that simply did nothing.
      const retryDeadline = Date.now() + 6000;
      while (Date.now() < retryDeadline) {
        const next = await frameState(iframe);
        if (next === "loaded") return;
        if (next === "failed") break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw new Error(failedFrameMessage(iframe));
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
