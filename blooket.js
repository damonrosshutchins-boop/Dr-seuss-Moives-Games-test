"use strict";
// Seuss Blooket: pressing the button opens one Blooket join tab per bot in the
// browser that is looking at this page. Nothing is installed, nothing runs on a
// server, and the tabs are ordinary Blooket pages carrying the game code.
(() => {
  const $ = (id) => document.getElementById(id);
  const overlay = $("blooketOverlay");
  if (!overlay) return;

  const JOIN = "https://play.blooket.com/play?gameId=";
  const MAX_TABS = 25;
  let tabs = [];

  function logLine(text, kind) {
    const list = $("blooketLog");
    if (!list) return;
    const line = document.createElement("li");
    line.textContent = text;
    if (kind) line.className = "bk-" + kind;
    list.appendChild(line);
    list.scrollTop = list.scrollHeight;
  }

  function setState(text) {
    $("blooketState").textContent = text;
  }

  function closeTabs() {
    let closed = 0;
    for (const tab of tabs) {
      try {
        if (tab && !tab.closed) { tab.close(); closed += 1; }
      } catch (error) { /* the browser refused; leave it */ }
    }
    tabs = [];
    return closed;
  }

  function start() {
    const code = ($("blooketCode").value || "").trim();
    const count = Math.max(1, Math.min(MAX_TABS, Number($("blooketCount").value) || 3));
    if (!/^\d{4,8}$/.test(code)) {
      setState("Type the 4 to 8 digit game code shown on the host screen.");
      $("blooketCode").focus();
      return;
    }
    closeTabs();
    const url = JOIN + encodeURIComponent(code);
    let opened = 0;
    for (let index = 0; index < count; index += 1) {
      // A named window per bot means pressing the button again reuses the tabs
      // instead of stacking new ones.
      const tab = window.open(url, "seussBlooketBot" + index);
      if (tab) { tabs.push(tab); opened += 1; }
    }
    if (!opened) {
      setState("The browser blocked the tabs. Click the pop-up icon at the right end of the address bar, choose \"Always allow\", then press again.");
      logLine("No tabs opened: the browser blocked pop-ups for this page. Allow pop-ups once for this site, then press Open bot tabs again.", "err");
      $("blooketStop").disabled = true;
      return;
    }
    logLine("Opened " + opened + " Blooket tab" + (opened === 1 ? "" : "s") + " for game " + code, "ok");
    if (opened < count) {
      logLine("The browser allowed one tab per click. Allow pop-ups for this site (pop-up icon in the address bar → Always allow), then press again for all " + count + ".", "err");
    }
    setState("Opened " + opened + " tab" + (opened === 1 ? "" : "s") + ". Enter a name on each Blooket tab to land in the lobby for " + code + ".");
    $("blooketStop").disabled = false;
  }

  function stop() {
    const closed = closeTabs();
    $("blooketStop").disabled = true;
    setState(closed ? "Closed the bot tabs this panel opened." : "No bot tabs are open.");
    if (closed) logLine("Closed " + closed + " tab" + (closed === 1 ? "" : "s"), "ok");
  }

  function open() {
    overlay.classList.remove("hidden");
    $("blooketCode").focus();
  }

  function close() {
    overlay.classList.add("hidden");
  }

  $("blooketOpen").addEventListener("click", open);
  $("blooketClose").addEventListener("click", close);
  $("blooketStart").addEventListener("click", start);
  $("blooketStop").addEventListener("click", stop);
  $("blooketCode").addEventListener("keydown", (event) => {
    if (event.key === "Enter") start();
  });
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.classList.contains("hidden")) close();
  });
})();
