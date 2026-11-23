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
    },
    sheets: {
      title: "Google Sheets",
      icon: art("sheets"),
      type: "image/png"
    },
    search: {
      title: "Google",
      icon: art("search"),
      type: "image/png"
    },
    gmail: {
      title: "Gmail",
      icon: art("gmail"),
      type: "image/png"
    },
    kahoot: {
      title: "Kahoot!",
      icon: art("kahoot"),
      type: "image/png"
    },
    canva: {
      title: "Canva",
      icon: art("canva"),
      type: "image/png"
    },
    canvas: {
      title: "Canvas",
      icon: art("canvas"),
      type: "image/png"
    },
    iready: {
      title: "i-Ready",
      icon: art("iready"),
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
  // Whenever the window is not focused or the tab is in the background, cover the
  // whole page with a supplied photo, so a glance at the screen shows that instead
  // of the arcade. It lifts again the moment the page is focused.
  let cover = null;
  let coverShown = false;
  // Why the cover went up: a tab switch never delivers a click to the page, but
  // clicking straight back into an unfocused window does, at the exact moment
  // the cover lifts, so that press has to be absorbed.
  let coverReason = "";
  // Timestamp of the focus event that may own a press. The click that brings the
  // window back arrives with its press attached, a fraction of a millisecond
  // after that focus, so only a press whose own input timestamp falls in that
  // instant belongs to the cover. Alt+Tab focuses the window with no press, and
  // the click that follows it is therefore left alone.
  let returnPress = 0;
  const RETURN_PRESS_MS = 120;
  let absorbingPress = false;
  let pressTimer = 0;
  const PRESSES = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "auxclick", "dblclick", "contextmenu", "touchstart", "touchend"];
  // Only an activation event ends the press: clearing on pointerup would let the
  // mouseup and click of the same press through.
  const ENDS_PRESS = new Set(["click", "auxclick", "contextmenu"]);
  const RELEASE = new Set(["pointerup", "mouseup", "touchend"]);
  // Presses land on whatever is behind the cover, so they are caught here in the
  // window's capture phase, before any page handler can act on them. The whole
  // press is swallowed, from pointerdown to click, so a button behind the photo
  // cannot focus or activate.
  function swallowFirstPress(event) {
    if (!coverShown && !absorbingPress) {
      if (!returnPress || event.timeStamp - returnPress > RETURN_PRESS_MS) return;
      absorbingPress = true;
      returnPress = 0;
      // The release is not delivered if the button comes up outside the window,
      // so the absorb must never outlive the press it belongs to.
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => { absorbingPress = false; }, 2000);
    }
    event.stopImmediatePropagation();
    event.preventDefault();
    if (ENDS_PRESS.has(event.type)) { absorbingPress = false; returnPress = 0; }
    // Once a press is absorbed the rest of it stays absorbed however long the
    // button is held, so a slow click cannot activate anything either.
    else if (RELEASE.has(event.type)) setTimeout(() => { absorbingPress = false; returnPress = 0; }, 0);
  }
  for (const type of PRESSES) addEventListener(type, swallowFirstPress, true);
  function awayCover() {
    if (cover) return cover;
    cover = document.createElement("img");
    cover.alt = "";
    cover.setAttribute("aria-hidden", "true");
    cover.dataset.seussAway = "1";
    Object.assign(cover.style, {
      position: "fixed",
      inset: "0",
      width: "100%",
      height: "100%",
      objectFit: "cover",
      background: "#101010",
      zIndex: "2147483646",
      pointerEvents: "none",
      display: "none"
    });
    cover.src = new URL("assets/tab-away.png", base).href;
    (document.body || document.documentElement).append(cover);
    return cover;
  }
  function syncAwayCover(event) {
    if (document.hidden || !document.hasFocus()) {
      if (!coverShown) coverReason = document.hidden ? "hidden" : "blur";
      coverShown = true;
      awayCover().style.display = "block";
      return;
    }
    if (coverShown) {
      coverShown = false;
      // Only a window that kept the page visible is re-entered with a press on
      // the page; that click belongs to the cover, not to the page beneath it.
      if (coverReason === "blur" && event && event.type === "focus") returnPress = event.timeStamp;
      coverReason = "";
    }
    if (cover) cover.style.display = "none";
  }
  document.addEventListener("visibilitychange", syncAwayCover);
  addEventListener("blur", syncAwayCover);
  addEventListener("focus", syncAwayCover);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", syncAwayCover, { once: true });
  else syncAwayCover();
  // Warm the photo once the page is idle, so the cover is instant when needed.
  addEventListener("load", () => {
    if ("requestIdleCallback" in window) requestIdleCallback(awayCover, { timeout: 4000 });
    else setTimeout(awayCover, 1500);
  });
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
