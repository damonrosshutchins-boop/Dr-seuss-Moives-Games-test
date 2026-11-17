"use strict";
// Seuss Blooket bot: one button.
//
// Type the room code, pick how many bots, press Start. The bot program on this
// computer (npm run bots:serve) then opens one browser per bot, types the room
// code into play.blooket.com/play and gives every bot its own random name, so
// nothing else is typed by hand.
(() => {
  const $ = (id) => document.getElementById(id);
  const overlay = $("blooketOverlay");
  if (!overlay) return;

  // The bot program is reachable same-origin when it is also serving the arcade
  // (http://127.0.0.1:8791/), and on its port otherwise. A page on the public
  // site cannot reach loopback at all, so Start tells you to use that address.
  const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const SERVICE_URLS = LOOPBACK ? ["", "http://127.0.0.1:8791"] : ["http://127.0.0.1:8791"];
  const MAX_BOTS = 50;
  let busy = false;

  const log = (text, kind) => {
    const list = $("blooketLog");
    if (!list) return;
    const line = document.createElement("li");
    line.textContent = text;
    if (kind) line.className = "bk-" + kind;
    list.appendChild(line);
    list.scrollTop = list.scrollHeight;
  };

  const setState = (text) => { $("blooketState").textContent = text; };

  async function startOnThisComputer(code, count) {
    for (const base of SERVICE_URLS) {
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), 2500);
      try {
        const response = await fetch(base + "/join", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, count }),
          signal: stop.signal
        });
        if (response.ok) {
          const data = await response.json();
          if (data && data.ok) return data;
        }
      } catch (error) {
        // try the next address
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  async function start() {
    if (busy) return;
    const code = ($("blooketCode").value || "").trim();
    const count = Math.max(1, Math.min(MAX_BOTS, Number($("blooketCount").value) || 1));
    if (!/^\d{4,8}$/.test(code)) {
      setState("Type the 4 to 8 digit room code shown on the host screen.");
      $("blooketCode").focus();
      return;
    }
    busy = true;
    $("blooketStart").disabled = true;
    setState("Starting " + count + " bot" + (count === 1 ? "" : "s") + " for room " + code + "…");
    const started = await startOnThisComputer(code, count);
    busy = false;
    $("blooketStart").disabled = false;
    if (!started) {
      log("Could not reach the bot program on this computer", "err");
      setState("The bot program is not running. Double-click Start-Blooket-Bots in the arcade folder (it opens http://127.0.0.1:8791/ by itself), then press Start bots again.");
      return;
    }
    const many = started.bots === 1 ? "bot" : "bots";
    log("Room " + code + ": started " + started.bots + " " + many, "ok");
    setState("Room " + code + ": " + started.bots + " " + many + " are joining now. Each one picks a random name and types the code itself.");
  }

  function open() {
    overlay.classList.remove("hidden");
    $("blooketCode").focus();
  }

  function close() { overlay.classList.add("hidden"); }

  $("blooketOpen").addEventListener("click", open);
  $("blooketClose").addEventListener("click", close);
  $("blooketStart").addEventListener("click", start);
  $("blooketCode").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); start(); }
  });
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.classList.contains("hidden")) close();
  });
})();
