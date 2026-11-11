// GitHub Pages-compatible worker bootstrap.
// Never let a missing or broken dependency abort service-worker installation.
(() => {
  const root = new URL("./", self.location.href);
  const controllerUrl = new URL("controller/controller.sw.js", root).href;
  let controllerLoaded = false;
  let loadFailure = null;
  try {
    importScripts(controllerUrl);
    controllerLoaded =
      typeof self.$scramjetController !== "undefined" &&
      typeof self.$scramjetController.shouldRoute === "function" &&
      typeof self.$scramjetController.route === "function";
    if (!controllerLoaded) {
      loadFailure = "Controller imported but did not initialize";
    }
  } catch (error) {
    loadFailure = error ? `${error.name || "Error"}: ${error.message || String(error)}${error.stack ? " | " + error.stack : ""}` : "Unknown import failure";
    console.error("Service worker dependency failed:", controllerUrl, error);
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
