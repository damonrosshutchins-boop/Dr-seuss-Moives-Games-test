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
  // Ads and trackers are refused here, before the proxy opens a connection for
  // them. The routing prefix encodes the destination host in one path segment,
  // so the target is recovered from that and matched against ad networks only:
  // game and media hosts are never on this list.
  const AD_HOSTS = /^(?:[a-z0-9-]+\.)*(?:doubleclick\.net|googlesyndication\.com|googleadservices\.com|googletagservices\.com|adservice\.google\.[a-z.]+|adnxs\.com|amazon-adsystem\.com|criteo\.(?:com|net)|taboola\.com|outbrain\.com|pubmatic\.com|rubiconproject\.com|openx\.net|moatads\.com|adsrvr\.org|casalemedia\.com|sharethrough\.com|teads\.tv|smartadserver\.com|yieldmo\.com|mgid\.com|zedo\.com|advertising\.com|adroll\.com|quantserve\.com|bluekai\.com|demdex\.net|everesttech\.net|bidswitch\.net|33across\.com|gumgum\.com|smaato\.net|inmobi\.com|applovin\.com|unityads\.unity3d\.com|vungle\.com|chartboost\.com|ironsrc\.com|adcolony\.com|fyber\.com|tapjoy\.com|scorecardresearch\.com|sitescout\.com|turn\.com)$/;
  function blockedHost(request) {
    let path;
    try { path = new URL(request.url).pathname; } catch { return null; }
    for (const segment of path.split("/")) {
      if (!segment || segment.length < 8) continue;
      let target;
      try { target = decodeURIComponent(segment); } catch { continue; }
      if (!/^https?:\/\//i.test(target)) continue;
      try {
        const host = new URL(target).hostname.toLowerCase();
        return AD_HOSTS.test(host) ? host : null;
      } catch { return null; }
    }
    return null;
  }
  self.addEventListener("fetch", (event) => {
    if (!controllerLoaded) return;
    try {
      const blocked = blockedHost(event.request);
      if (blocked) {
        console.info("[Seuss ad block]", blocked);
        event.respondWith(new Response(null, { status: 204, statusText: "Blocked ad host" }));
        return;
      }
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
