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
  // Proxied pages run on this site's origin, so each bot needs its own storage
  // keys or the site's backend sees one repeated visitor. Inject the per-frame
  // shim into navigations; it does nothing unless the URL carries ?bkbot=.
  const storageShimUrl = new URL("bot-storage.js", self.location.href).href;
  const storageShim = '<script src="' + storageShimUrl + '"><' + '/script>';

  async function routeWithShim(event) {
    const response = await self.$scramjetController.route(event);
    if (event.request.mode !== "navigate") return response;
    try {
      const type = response.headers.get("content-type") || "";
      if (!/text\/html/i.test(type) || response.status !== 200) return response;
      const html = await response.clone().text();
      if (html.indexOf("bot-storage.js") >= 0) return response;
      const patched = /<head[^>]*>/i.test(html)
        ? html.replace(/<head[^>]*>/i, (match) => match + storageShim)
        : storageShim + html;
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(patched, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      return response;
    }
  }

  self.addEventListener("fetch", (event) => {
    if (!controllerLoaded) return;
    try {
      if (self.$scramjetController.shouldRoute(event)) {
        event.respondWith(routeWithShim(event));
      }
    } catch (error) {
      console.error("Worker routing error:", error);
    }
  });
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
})();
