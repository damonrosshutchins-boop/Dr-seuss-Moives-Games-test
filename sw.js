// GitHub Pages-compatible worker bootstrap.
// Never let a missing or broken dependency abort service-worker installation.
(() => {
  const root = new URL("./", self.location.href);
  const controllerUrl = new URL("controller/controller.sw.js", root).href;
  // The published worker has the controller inlined by the Pages build, which
  // is the only reliable path: importScripts is allowed during the first
  // installation but throws once the worker has restarted, and a worker
  // without the controller answers every proxied request with a 404.
  let controllerLoaded = false;
  let loadFailure = null;
  if (!self.$scramjetController) {
    try {
      importScripts(controllerUrl);
    } catch (error) {
      loadFailure = error ? `${error.name || "Error"}: ${error.message || String(error)}` : "Unknown import failure";
      console.error("Service worker dependency failed:", controllerUrl, error);
    }
  }
  controllerLoaded =
    typeof self.$scramjetController !== "undefined" &&
    typeof self.$scramjetController.shouldRoute === "function" &&
    typeof self.$scramjetController.route === "function";
  if (!controllerLoaded && !loadFailure) {
    loadFailure = "Controller imported but did not initialize";
  }

  self.addEventListener("message", (event) => {
    if (event.data === "seuss-worker-diagnostics") {
      event.source?.postMessage({
        type: "seuss-worker-diagnostics",
        loaded: controllerLoaded,
        error: loadFailure,
        controllerUrl
      });
    }
  });
  self.addEventListener("fetch", (event) => {
    if (!controllerLoaded) return;
    try {
      if (self.$scramjetController.shouldRoute(event)) {
        event.respondWith(self.$scramjetController.route(event));
      }
    } catch (error) {
      console.error("Worker routing error:", error);
    }
  });
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
})();
