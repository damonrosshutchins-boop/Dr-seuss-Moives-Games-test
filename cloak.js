// Shared tab disguise. Both the Seuss Search page and the arcade load this, so a
// tab that is pretending to be about:blank (or Classroom, or Docs) keeps that
// label when a game opens and control passes to the arcade.
//
// The title is re-asserted rather than set once: proxied pages are served from
// this origin and can write to the tab title, and every page load would
// otherwise restore its real name.
(() => {
  const KEY = "seuss-cloak";
  // Whatever the page is actually called, remembered before any disguise.
  const realTitle = document.title || "Seuss";
  const icon = svg => "data:image/svg+xml," + encodeURIComponent(svg);
  // The disguise artwork is Google's official product icon set, saved locally so
  // the tab icon works offline and from any page depth (root or games/<slug>/).
  const base = (document.currentScript && document.currentScript.src) || location.href;
  const art = name => new URL("assets/cloak/" + name + ".png", base).href;
  const CLOAKS = {
    blank: {
      title: "about:blank",
      // A blank tab has no artwork, so this is an empty white tile.
      icon: icon('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#fff"/></svg>'),
      type: "image/svg+xml"
    },
    classroom: {
      title: "Google Classroom",
      icon: art("classroom"),
      type: "image/png"
    },
    docs: {
      title: "Google Docs",
      icon: art("docs"),
      type: "image/png"
    },
    slides: {
      title: "Google Slides",
      icon: art("slides"),
      type: "image/png"
    },
    drive: {
      title: "Google Drive",
      icon: art("drive"),
      type: "image/png"
    }
  };
  let current = "off";
  let guard = 0;
  const titleFor = () => (CLOAKS[current] ? CLOAKS[current].title : realTitle);
  function assertTitle() {
    if (document.title !== titleFor()) document.title = titleFor();
  }
  function apply(name, persist = true) {
    current = CLOAKS[name] ? name : "off";
    if (persist) { try { localStorage.setItem(KEY, current); } catch { /* private mode */ } }
    const preset = CLOAKS[current];
    document.title = titleFor();
    let link = document.querySelector("link[data-seuss-cloak]");
    if (preset) {
      if (!link) {
        link = document.createElement("link");
        link.rel = "icon";
        link.dataset.seussCloak = "1";
        document.head.append(link);
      }
      link.type = preset.type;
      link.href = preset.icon;
    } else if (link) {
      link.remove();
    }
    clearInterval(guard);
    guard = preset ? setInterval(assertTitle, 700) : 0;
    document.dispatchEvent(new CustomEvent("seuss-cloak-change", { detail: { cloak: current } }));
  }
  // A backgrounded tab comes back with whatever the page set while it was away,
  // and a proxied page can rename the tab as soon as it loads.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) assertTitle(); });
  addEventListener("focus", assertTitle);
  window.SeussCloak = {
    apply,
    current: () => current,
    titles: CLOAKS,
    icons: Object.fromEntries(Object.entries(CLOAKS).map(([name, preset]) => [name, preset.icon]))
  };
  let stored = "off";
  try { stored = localStorage.getItem(KEY) || "off"; } catch { /* private mode */ }
  apply(stored, false);
})();
