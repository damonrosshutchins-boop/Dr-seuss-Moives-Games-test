"use strict";
// Seuss Blooket: the panel starts the standalone bot runner on this computer.
// The runner drives real browser profiles straight to play.blooket.com and
// answers every question with a random option, so no in-page proxy or Wisp
// relay is involved. The page talks to the runner through a small local bridge
// (`npm run bots:bridge`).
(() => {
  const $ = (id) => document.getElementById(id);
  const overlay = $("blooketOverlay");
  if (!overlay) return;

  const LOCAL_BRIDGE = "http://127.0.0.1:8788";
  const BRIDGE_HINT = "cd _work/target  then  npm run bots:bridge";

  // Settings can name a bot program running on a host, so nothing has to be
  // started on this computer; otherwise the local bridge is used.
  function stored(key) {
    try { return (localStorage.getItem(key) || "").trim(); } catch (error) { return ""; }
  }
  const hosted = () => !!stored("seussBotService");
  const serviceBase = () => (stored("seussBotService") || LOCAL_BRIDGE).replace(/\/+$/, "");
  const ADJECTIVES = ["swift", "quiet", "brave", "clever", "lucky", "wild", "calm", "sharp", "sunny", "rapid", "frosty", "noble", "merry", "bold", "sly", "vivid", "gentle", "cosmic", "zesty", "misty"];
  const NOUNS = ["Otter", "Falcon", "Panda", "Tiger", "Koala", "Raven", "Lynx", "Bison", "Heron", "Yak", "Gecko", "Moth", "Wombat", "Crane", "Badger", "Ferret", "Quokka", "Tapir", "Marmot", "Puffin"];

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

  // The browser may refuse a public page's call to a local server; the program
  // serves its own panel at that address, which always works.
  function showLocalPage() {
    const wrap = $("blooketFallback");
    if (wrap) wrap.classList.remove("hidden");
  }

  function hideLocalPage() {
    const wrap = $("blooketFallback");
    if (wrap) wrap.classList.add("hidden");
  }

  function generatedNames(count) {
    const names = [];
    const used = new Set();
    while (names.length < count) {
      const name = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)] + NOUNS[Math.floor(Math.random() * NOUNS.length)];
      if (used.has(name)) continue;
      used.add(name);
      names.push(name.slice(0, 20));
    }
    return names;
  }

  // The runner makes up its own names when none are given, so random mode sends
  // none at all and custom mode fills any blanks so every bot still gets in.
  function chosenNames(count) {
    if ($("blooketModeRandom").checked) return [];
    const typed = ($("blooketNames").value || "")
      .split(/[\n,]+/)
      .map((name) => name.trim())
      .filter(Boolean);
    const names = [];
    const used = new Set();
    for (const name of typed) {
      if (names.length >= count) break;
      const key = name.toLowerCase();
      if (used.has(key)) continue;
      used.add(key);
      names.push(name.slice(0, 20));
    }
    for (const filler of generatedNames(count)) {
      if (names.length >= count) break;
      const key = filler.toLowerCase();
      if (used.has(key)) continue;
      used.add(key);
      names.push(filler);
    }
    return names;
  }

  function setNameMode() {
    $("blooketNamesWrap").classList.toggle("hidden", $("blooketModeRandom").checked);
  }

  async function callBridge(path, options) {
    const token = stored("seussBotToken");
    const headers = { ...((options && options.headers) || {}), ...(token ? { "x-bots-token": token } : {}) };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(serviceBase() + path, { ...options, headers, signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      return { status: response.status, data };
    } finally {
      clearTimeout(timer);
    }
  }

  async function start() {
    const code = ($("blooketCode").value || "").trim();
    const count = Math.max(1, Math.min(25, Number($("blooketCount").value) || 3));
    if (!/^\d{4,8}$/.test(code)) {
      setState("Type the 4 to 8 digit game code shown on the host screen.");
      $("blooketCode").focus();
      return;
    }
    $("blooketStart").disabled = true;
    $("blooketStop").disabled = true;
    setState("Starting the bot program…");
    const names = chosenNames(count);
    try {
      const { status, data } = await callBridge("/bots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, count, names })
      });
      if (status === 202) {
        hideLocalPage();
        logLine("Started " + data.count + " bot" + (data.count === 1 ? "" : "s") + " for game " + data.code, "ok");
        setState("Bots are joining game " + code + ". Watch the terminal for progress; they answer each question with a random option.");
        $("blooketStop").disabled = false;
      } else {
        const message = data.error || ("The bot program refused the request (" + status + ")");
        logLine(message, "err");
        setState(message);
      }
    } catch (error) {
      if (hosted()) {
        logLine("The hosted bot program did not answer at " + serviceBase() + ". Check the address in Settings.", "err");
        setState("The hosted bot program did not answer. Open Settings and check the bot program address.");
        return;
      }
      logLine("No answer from the bot program. Start it with: " + BRIDGE_HINT + " — or use the bot page link below, which works even when the browser blocks this page.", "err");
      setState("The page could not reach the bot program on this computer.");
      showLocalPage();
    } finally {
      $("blooketStart").disabled = false;
    }
  }

  async function stop() {
    $("blooketStop").disabled = true;
    try {
      const { data } = await callBridge("/stop", { method: "POST" });
      if (data.stopped) {
        logLine("Stopped the bots for game " + data.code, "ok");
        setState("Bot windows closed.");
      } else {
        setState("No bot run is active.");
      }
    } catch (error) {
      if (hosted()) {
        logLine("The hosted bot program did not answer at " + serviceBase() + ".", "err");
        setState("The hosted bot program did not answer.");
        return;
      }
      logLine("No answer from the bot program. Start it with: " + BRIDGE_HINT, "err");
      setState("The page could not reach the bot program on this computer.");
    }
  }

  async function open() {
    overlay.classList.remove("hidden");
    $("blooketCode").focus();
    setState("Checking for the bot program…");
    try {
      const { data } = await callBridge("/health", { method: "GET" });
      if (data.running) {
        setState("Bots are already running for game " + data.code + ".");
        $("blooketStop").disabled = false;
      } else {
        setState("Bot program ready. Enter the host's game code and press Send bots.");
        hideLocalPage();
      }
    } catch (error) {
      if (hosted()) {
        setState("No answer from the hosted bot program at " + serviceBase() + ". Check the address in Settings.");
        return;
      }
      setState("No bot program found. Start it in a terminal: " + BRIDGE_HINT);
      showLocalPage();
    }
  }

  function close() {
    overlay.classList.add("hidden");
  }

  $("blooketOpen").addEventListener("click", open);
  $("blooketClose").addEventListener("click", close);
  $("blooketStart").addEventListener("click", start);
  $("blooketStop").addEventListener("click", stop);
  $("blooketModeRandom").addEventListener("change", setNameMode);
  $("blooketModeCustom").addEventListener("change", setNameMode);
  $("blooketCode").addEventListener("keydown", (event) => {
    if (event.key === "Enter") start();
  });
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.classList.contains("hidden")) close();
  });
  setNameMode();
})();
