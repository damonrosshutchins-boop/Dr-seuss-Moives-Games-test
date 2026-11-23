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
  const CLOAKS = {
    blank: {
      title: "about:blank",
      // A blank tab has no artwork, so this is an empty white tile.
      icon: icon('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#fff"/></svg>')
    },
    classroom: {
      title: "Google Classroom",
      icon: icon('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0f9d58"/><rect x="8.5" y="9" width="15" height="10.5" rx="1.6" fill="none" stroke="#fff" stroke-width="2"/><rect x="12" y="23" width="8" height="2.4" rx="1.2" fill="#fff"/></svg>')
    },
    docs: {
      title: "Google Docs",
      icon: icon('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="5" y="2" width="22" height="28" rx="3" fill="#1a73e8"/><g fill="#fff"><rect x="10" y="9" width="12" height="2.4" rx="1.2"/><rect x="10" y="14" width="12" height="2.4" rx="1.2"/><rect x="10" y="19" width="7.5" height="2.4" rx="1.2"/></g></svg>')
    },
    slides: {
      title: "Google Slides",
      icon: icon('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#fbbc04"/><rect x="8" y="8.5" width="16" height="11" rx="1.8" fill="#fff"/><rect x="12" y="22" width="8" height="2.6" rx="1.3" fill="#fff"/></svg>')
    },
    drive: {
      title: "Google Drive",
      icon: icon('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#fff"/><polygon points="16,6.5 22.5,18 9.5,18" fill="#fbbc04"/><polygon points="9.5,18 22.5,18 19,25 13,25" fill="#4285f4"/><polygon points="16,6.5 19,12.2 13,12.2" fill="#0f9d58"/></svg>')
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
      link.type = "image/svg+xml";
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
  window.SeussCloak = { apply, current: () => current, titles: CLOAKS };
  let stored = "off";
  try { stored = localStorage.getItem(KEY) || "off"; } catch { /* private mode */ }
  apply(stored, false);
})();
