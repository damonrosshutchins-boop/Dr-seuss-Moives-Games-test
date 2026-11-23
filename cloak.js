// Shared tab disguise. Both the Seuss Search page and the arcade load this, so a
// tab that is pretending to be about:blank (or Classroom, or Docs) keeps that
// label when a game opens and control passes to the arcade.
//
// The title and the icon are both re-asserted rather than set once: proxied
// pages are served from this origin and can rename the tab or install their own
// favicon, and every page load would otherwise restore the real name.
(() => {
  const KEY = "seuss-cloak";
  // Whatever the page is actually called, remembered before any disguise.
  const realTitle = document.title || "Seuss";
  // The disguise artwork is Google's official product icon set, saved locally so
  // the tab icon works offline and from any page depth (root or games/<slug>/).
  const base = (document.currentScript && document.currentScript.src) || location.href;
  const art = name => new URL("assets/cloak/" + name + ".png", base).href;
  const CLOAKS = {
    blank: {
      title: "about:blank"
      // Deliberately no icon: a blank tab shows the browser's own empty icon.
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
  let iconLink = null;
  const titleFor = () => (CLOAKS[current] ? CLOAKS[current].title : realTitle);
  function assertTitle() {
    if (document.title !== titleFor()) document.title = titleFor();
  }
  // A page icon is made inert while a disguise is on, and put back exactly as it
  // was when the disguise is switched off.
  const SHADOW_REL = "seuss-icon";
  // Shadowed links are tracked directly: once their rel changes they no longer
  // match the icon selector, so an attribute search could not restore them.
  const shadowed = new Set();
  function shadowPageIcons(hide) {
    if (hide) {
      for (const link of document.querySelectorAll('link[rel~="icon" i]')) {
        if (link.dataset.seussCloak || shadowed.has(link)) continue;
        shadowed.add(link);
        link.dataset.seussRel = link.getAttribute("rel") || "icon";
        link.setAttribute("rel", SHADOW_REL);
      }
      for (const link of shadowed) if (!link.isConnected) shadowed.delete(link);
      return;
    }
    for (const link of shadowed) {
      if (link.dataset.seussRel) link.setAttribute("rel", link.dataset.seussRel);
      delete link.dataset.seussRel;
    }
    shadowed.clear();
  }
  function assertIcon() {
    const preset = CLOAKS[current];
    if (!preset) {
      if (iconLink) { iconLink.remove(); iconLink = null; }
      shadowPageIcons(false);
      return;
    }
    if (!preset.icon && iconLink) { iconLink.remove(); iconLink = null; }
    if (preset.icon) {
      if (!iconLink || !iconLink.isConnected) {
        iconLink = document.createElement("link");
        iconLink.dataset.seussCloak = "1";
        document.head.append(iconLink);
      }
      iconLink.rel = "icon";
      if (iconLink.getAttribute("href") !== preset.icon) iconLink.href = preset.icon;
      if (iconLink.getAttribute("type") !== preset.type) iconLink.type = preset.type;
      // Browsers take the last icon in the document, so our link has to stay at
      // the end of <head> after a page appends or swaps its own.
      if (document.head.lastElementChild !== iconLink) document.head.append(iconLink);
    }
    shadowPageIcons(true);
  }
  function assertDisguise() {
    assertTitle();
    assertIcon();
  }
  function apply(name, persist = true) {
    current = CLOAKS[name] ? name : "off";
    if (persist) { try { localStorage.setItem(KEY, current); } catch { /* private mode */ } }
    assertDisguise();
    clearInterval(guard);
    guard = CLOAKS[current] ? setInterval(assertDisguise, 700) : 0;
    document.dispatchEvent(new CustomEvent("seuss-cloak-change", { detail: { cloak: current } }));
  }
  // A backgrounded tab comes back with whatever the page set while it was away,
  // and a proxied page can rename the tab as soon as it loads.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) assertDisguise(); });
  addEventListener("focus", assertDisguise);
  window.SeussCloak = {
    apply,
    current: () => current,
    titles: CLOAKS,
    // Only disguises with artwork; about:blank intentionally has none.
    icons: Object.fromEntries(Object.entries(CLOAKS).filter(([, preset]) => preset.icon).map(([name, preset]) => [name, preset.icon]))
  };
  let stored = "off";
  try { stored = localStorage.getItem(KEY) || "off"; } catch { /* private mode */ }
  apply(stored, false);
})();
