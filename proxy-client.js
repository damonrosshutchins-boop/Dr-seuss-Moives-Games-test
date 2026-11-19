// Curated game/movie player. Static assets run on GitHub Pages.
// Its configured transport connects to the Cloudflare-hosted Wisp relay.
let controller;
let initialization;
let currentStage = "Not started";
const progressListeners = new Set();
const base = new URL("./", import.meta.url).pathname;
const asset = path => base + path;
const allowed = new Set(["cdn.jsdelivr.net", "game.azgame.io", "nostaligafun.pages.dev", "toby.booksforschool.online", "mclegacy.pages.dev", "wasm.rip", "shuttletv.pk", "youshows.org", "raw.githack.com", "ripjaw1219.github.io", "c00lkiddtech.github.io", "mollomm1.github.io", "sagaofowlz.github.io"]);
// Whole-site destinations, so they are not limited to one exact entry URL.
const openHosts = new Set(["wasm.rip", "shuttletv.pk", "youshows.org"]);
// Exact entry points on shared hosting domains prevent arbitrary navigation.
const gameEntries = new Set(["https://cdn.jsdelivr.net/gh/3cfl/balatro-webport@7255b72aaae4b572d171a8ff24ace071aa02f3f7/balatro.html","https://mclegacy.pages.dev/", "https://game.azgame.io/wacky-flip/", "https://nostaligafun.pages.dev/games/games-accualy/GC/PaperMarioTheThousandYearDoor_Data/index.html", "https://toby.booksforschool.online/index.html","https://ripjaw1219.github.io/super-mario-64-javascript/start.html","https://c00lkiddtech.github.io/md-/","https://mollomm1.github.io/test/","https://sagaofowlz.github.io/hmm/","https://raw.githack.com/web-ports/fish/main/index.html"]);
const endpoint = "wss://seuss-wisp-relay.damonrosshutchins.workers.dev/wisp/";
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

  report("Setting up Render transport…", onProgress);
  const module = await timeout(import(asset("libcurl/index.mjs")), "Loading transport module");
  const LibcurlClient = module.default;
  if (typeof LibcurlClient !== "function") {
    throw new Error("Libcurl transport module did not export a client.");
  }
  const transport = new LibcurlClient({wisp: endpoint});
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
  if (!openHosts.has(target.hostname) && !gameEntries.has(target.href)) {
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
  // GitHub Pages answers 404 for a player URL that nobody intercepts, which is
  // what a freshly activated service worker looks like before it claims frames.
  await waitForServiceWorkerControl();
  const frame = controller.createFrame(iframe);
  for (let attempt = 1; attempt <= 2; attempt++) {
    await timeout(Promise.resolve(frame.go(target.href)), "Starting content");
    if (await frameTookControl(iframe)) return;
    if (attempt === 1) {
      report("Waiting for the player service worker…", onProgress);
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
  throw new Error("The player service worker did not take control of the page, so GitHub Pages answered 404. Reload the arcade and try again.");
}

// An activated worker only intercepts frames once it is claiming clients. Until
// then the player prefix URL goes to the static host, whose 404 page is a
// perfectly ordinary 200 document.
function waitForServiceWorkerControl(timeoutMs = 6000) {
  if (!navigator.serviceWorker || navigator.serviceWorker.controller) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    navigator.serviceWorker.addEventListener("controllerchange", finish);
  });
}

// The player frame is same-origin with the arcade, so its document is readable:
// recognise the static host's "File not found" page and report it as a miss.
// A page that loaded but crashed shows its own error, which a retry cannot fix.
function frameTookControl(iframe, timeoutMs = 20000) {
  return new Promise(resolve => {
    const started = Date.now();
    const check = () => {
      let doc = null;
      try { doc = iframe.contentDocument; } catch (error) { doc = null; }
      if (doc && doc.readyState !== "loading") {
        const text = (doc.body?.innerText || "").slice(0, 4000);
        if (/does not contain the requested file/i.test(text) ||
          /^404\b|Page not found/i.test(doc.title || "")) return resolve(false);
        if (text.trim().length) return resolve(true);
      }
      if (Date.now() - started > timeoutMs) return resolve(true);
      setTimeout(check, 400);
    };
    check();
  });
}
