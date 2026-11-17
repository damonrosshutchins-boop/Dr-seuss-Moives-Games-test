"use strict";
// Seuss Blooket bot: type the join code, choose how many bots (up to 50), and
// every bot gets its own random nickname.
//
// A web page cannot type into another site's tab, so this panel does the two
// things a page is allowed to do: it opens https://play.blooket.com/play once
// per bot and hands out the nicknames. The same code and nicknames are printed
// as a command for the runner on this computer, which opens one browser per bot
// and types the code and nickname into play.blooket.com/play for you.
(() => {
  const $ = (id) => document.getElementById(id);
  const overlay = $("blooketOverlay");
  if (!overlay) return;

  const JOIN = "https://play.blooket.com/play?gameId=";
  // The local bot service (npm run bots:serve) does the typing for every bot.
  const SERVICE = "http://127.0.0.1:8791";
  const MAX_BOTS = 50;
  const WORDS = ["calm", "brave", "sunny", "rapid", "lucky", "bold", "misty", "sharp", "quiet", "wild", "sneaky", "giddy", "cosmic", "turbo", "mossy", "frosty", "jazzy", "zippy", "noble", "peppy"];
  const CREATURES = ["Crane", "Otter", "Yak", "Panda", "Falcon", "Lynx", "Moth", "Tapir", "Bison", "Puffin", "Badger", "Heron", "Gecko", "Moose", "Robin", "Walrus", "Ibis", "Koala", "Ferret", "Narwhal"];

  let tabs = [];
  let names = [];

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

  // Every bot gets a different nickname: adjectives crossed with creatures, then
  // a two-digit tag only when all 400 pairings are used.
  function makeNames(count) {
    const pool = [];
    for (const word of WORDS) for (const creature of CREATURES) pool.push(word + creature);
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const picked = pool.slice(0, count).map((name) => name.charAt(0).toUpperCase() + name.slice(1));
    let tag = 10;
    while (picked.length < count) {
      picked.push("Bot" + tag);
      tag += 1;
    }
    return picked;
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try { return document.execCommand("copy"); } catch (fallback) { return false; }
      finally { area.remove(); }
    }
  }

  function renderNames(count) {
    names = makeNames(count);
    const box = $("blooketNames");
    box.textContent = "";
    names.forEach((name, index) => {
      const row = document.createElement("li");
      const label = document.createElement("b");
      label.textContent = "Bot " + (index + 1);
      const value = document.createElement("span");
      value.textContent = name;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Copy";
      button.addEventListener("click", async () => {
        const ok = await copy(name);
        log(ok ? "Copied " + name : "Could not copy; select " + name + " and press Ctrl+C.", ok ? "ok" : "err");
      });
      row.append(label, value, button);
      box.append(row);
    });
  }

  function command(code, count) {
    return "npm run bots:blooket -- --code " + code + " --count " + count +
      " --names \"" + names.slice(0, count).join(",") + "\"";
  }

  function refreshCommand(code, count) {
    const field = $("blooketCmd");
    if (!field) return;
    field.value = code && count ? command(code, count) : "";
  }

  function readInputs() {
    const code = ($("blooketCode").value || "").trim();
    const count = Math.max(1, Math.min(MAX_BOTS, Number($("blooketCount").value) || 1));
    return { code, count };
  }

  // Ask the service on this computer to start the bots. Returns null when it is
  // not running, so the panel can fall back to opening join tabs.
  async function startOnThisComputer(code, count) {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 2500);
    try {
      const response = await fetch(SERVICE + "/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, count }),
        signal: stop.signal
      });
      if (!response.ok) return null;
      const data = await response.json();
      return data && data.ok ? data : null;
    } catch (error) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function closeTabs() {
    let closed = 0;
    for (const tab of tabs) {
      try {
        if (tab && !tab.closed) { tab.close(); closed += 1; }
      } catch (error) { /* the browser refused; leave it open */ }
    }
    tabs = [];
    return closed;
  }

  async function start() {
    const { code, count } = readInputs();
    if (!/^\d{4,8}$/.test(code)) {
      setState("Type the 4 to 8 digit join code shown on the host screen.");
      $("blooketCode").focus();
      return;
    }
    closeTabs();
    renderNames(count);
    refreshCommand(code, count);
    const started = await startOnThisComputer(code, count);
    if (started) {
      const many = started.bots === 1 ? "bot" : "bots";
      log("Started " + started.bots + " " + many + " for room " + code + " with the bot service", "ok");
      setState("Joining room " + code + " with " + started.bots + " " + many + ". Each bot opens its own browser, types the code and its nickname, and joins on its own — leave the bot service running.");
      $("blooketStop").disabled = true;
      return;
    }
    const url = JOIN + encodeURIComponent(code);
    let opened = 0;
    for (let index = 0; index < count; index += 1) {
      // One named window per bot, so pressing again reuses these tabs.
      const tab = window.open(url, "seussBlooketBot" + index);
      if (tab) { tabs.push(tab); opened += 1; }
    }
    const lead = "Made " + count + " nickname" + (count === 1 ? "" : "s") + " for game " + code + ".";
    if (!opened) {
      setState(lead + " The bot service is not running and the browser blocked the tabs. Run npm run bots:serve once, then press Start bots again — the bots then join by themselves.");
      log("No tabs opened: the browser blocked pop-ups for this page.", "err");
      $("blooketStop").disabled = true;
      return;
    }
    log("Opened " + opened + " Blooket tab" + (opened === 1 ? "" : "s") + " for game " + code, "ok");
    if (opened < count) {
      log("The browser allowed " + opened + " of " + count + " tabs. Allow pop-ups for this site (pop-up icon in the address bar → Always allow), then press again for the rest.", "err");
    }
    setState(lead + " Opened " + opened + " join tab" + (opened === 1 ? "" : "s") + "; each bot's nickname is listed below. To have the bots join by themselves, run npm run bots:serve once and press Start bots again.");
    $("blooketStop").disabled = false;
  }

  function stop() {
    const closed = closeTabs();
    $("blooketStop").disabled = true;
    setState(closed ? "Closed the bot tabs this panel opened." : "No bot tabs are open.");
    if (closed) log("Closed " + closed + " tab" + (closed === 1 ? "" : "s"), "ok");
  }

  async function copyNames() {
    if (!names.length) { setState("Press Open bot tabs first, so each bot gets a nickname."); return; }
    const ok = await copy(names.join(", "));
    setState(ok ? "Copied all " + names.length + " nicknames." : "Could not copy the nicknames; press Ctrl+C over the list instead.");
    if (ok) log("Copied " + names.length + " nicknames", "ok");
  }

  async function copyCommand() {
    const { code, count } = readInputs();
    if (!/^\d{4,8}$/.test(code)) { setState("Type the join code first."); $("blooketCode").focus(); return; }
    if (names.length !== count) { renderNames(count); refreshCommand(code, count); }
    const ok = await copy(command(code, count));
    setState(ok
      ? "Copied the command. Run it in the arcade folder and each bot opens its own browser, types the code and nickname, then joins."
      : "Could not copy the command; select the text above and press Ctrl+C.");
    if (ok) log("Copied the auto-join command for " + count + " bots", "ok");
  }

  function open() {
    overlay.classList.remove("hidden");
    $("blooketCode").focus();
    if (!names.length) {
      const { code, count } = readInputs();
      renderNames(count);
      refreshCommand(code, count);
    }
  }

  function close() { overlay.classList.add("hidden"); }

  $("blooketOpen").addEventListener("click", open);
  $("blooketClose").addEventListener("click", close);
  $("blooketStart").addEventListener("click", start);
  $("blooketStop").addEventListener("click", stop);
  $("blooketCopy").addEventListener("click", copyNames);
  $("blooketCommand").addEventListener("click", copyCommand);
  $("blooketCode").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); start(); }
  });
  $("blooketCount").addEventListener("change", () => {
    const { code, count } = readInputs();
    renderNames(count);
    refreshCommand(code, count);
  });
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.classList.contains("hidden")) close();
  });
})();
