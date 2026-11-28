// Epoxy first, libcurl as the safety net.
//
// Epoxy starts faster and is the smaller WebAssembly client, but it is pickier
// about unusual servers than libcurl. The Controller owns one transport for the
// page, so this wrapper keeps that contract while swapping the client underneath
// when Epoxy throws. libcurl is built lazily: a search that works on Epoxy never
// downloads or initialises it.
//
// The switch is one-way. Creating the replacement leaves the old WebAssembly
// client and its Wisp socket to be collected; switching back and forth on every
// request would keep both alive, which the transport docs warn against.
export class EpoxyFirstTransport {
  constructor(primary, makeFallback) {
    this.primary = primary;
    this.makeFallback = makeFallback;
    this.fallback = null;
    this.active = primary;
    this.ready = !!primary.ready;
  }

  get transport() {
    return this.active === this.primary ? "epoxy" : "libcurl";
  }

  async init() {
    if (this.active.ready) { this.ready = true; return; }
    if (this.active !== this.primary) {
      await this.active.init();
      this.ready = !!this.active.ready;
      return;
    }
    try {
      await this.primary.init();
      this.ready = !!this.primary.ready;
    } catch (error) {
      console.warn("[Seuss search] Epoxy could not start; switching to libcurl.", error);
      await this.useFallback();
    }
  }

  async useFallback() {
    if (!this.fallback) {
      this.fallback = await this.makeFallback();
      if (!this.fallback.ready) await this.fallback.init();
    }
    this.active = this.fallback;
    this.ready = !!this.fallback.ready;
    return this.fallback;
  }

  async request(remote, method, body, headers, signal) {
    if (!this.active.ready) await this.init();
    try {
      return await this.active.request(remote, method, body, headers, signal);
    } catch (error) {
      if (this.active !== this.primary) throw error;
      console.warn("[Seuss search] Epoxy request failed; switching to libcurl.", error);
      let fallback;
      try {
        fallback = await this.useFallback();
      } catch (fallbackError) {
        console.error("[Seuss search] libcurl fallback could not start.", fallbackError);
        throw error;
      }
      // A GET or HEAD can be sent again safely. For anything else the request
      // may already have reached the server, so switch future calls but let
      // this one's error reach the page.
      if (!/^(GET|HEAD)$/i.test(String(method || "GET"))) throw error;
      return fallback.request(remote, method, body, headers, signal);
    }
  }

  connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
    const active = this.active;
    return active.connect(url, protocols, requestHeaders, onopen, onmessage, onclose, error => {
      if (active === this.primary) {
        console.warn("[Seuss search] Epoxy WebSocket failed; switching to libcurl.", error);
        void this.useFallback().catch(fallbackError =>
          console.error("[Seuss search] libcurl fallback could not start.", fallbackError));
      }
      onerror(error);
    });
  }
}
