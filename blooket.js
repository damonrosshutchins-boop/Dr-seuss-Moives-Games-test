"use strict";
// Seuss Blooket: hands the browser a ready-to-paste auto-join script.
//
// Blooket is Cloudflare-hosted, so the relay cannot open a socket to it, and a
// page on this origin cannot script a Blooket frame. The one thing that does
// work is a script running on Blooket's own page, where each bot tab it opens
// is same-origin. This panel bakes the code and names into that script and
// copies it to the clipboard.
(() => {
  const $ = (id) => document.getElementById(id);
  const overlay = $("blooketOverlay");
  if (!overlay) return;

  const ADJECTIVES = ["swift", "quiet", "brave", "clever", "lucky", "wild", "calm", "sharp", "sunny", "rapid", "frosty", "noble", "merry", "bold", "sly", "vivid", "gentle", "cosmic", "zesty", "misty"];
  const NOUNS = ["Otter", "Falcon", "Panda", "Tiger", "Koala", "Raven", "Lynx", "Bison", "Heron", "Yak", "Gecko", "Moth", "Wombat", "Crane", "Badger", "Ferret", "Quokka", "Tapir", "Marmot", "Puffin"];
  const JOIN_URL = "https://play.blooket.com/play";
  const SCRIPT_FILE = "./blooket-autojoin.user.js";

  let template = null;

  function setState(text) {
    $("blooketState").textContent = text;
  }

  function generatedNames(count) {
    const names = [];
    const used = new Set();
    while (names.length < count) {
      const name = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)] + NOUNS[Math.floor(Math.random() * NOUNS.length)];
      if (used.has(name)) continue;
      used.add(name);
      names.push(name.slice(0, 15));
    }
    return names;
  }

  function chosenNames(count) {
    if ($("blooketModeRandom").checked) return generatedNames(count);
    const typed = ($("blooketNames").value || "")
      .split(/[\n,]+/)
      .map((name) => name.trim().slice(0, 15))
      .filter(Boolean);
    const names = [];
    const used = new Set();
    for (const name of typed) {
      if (used.has(name.toLowerCase())) continue;
      used.add(name.toLowerCase());
      names.push(name);
    }
    if (names.length >= count) return names.slice(0, count);
    for (const filler of generatedNames(count)) {
      if (names.length >= count) break;
      if (used.has(filler.toLowerCase())) continue;
      used.add(filler.toLowerCase());
      names.push(filler);
    }
    return names;
  }

  async function loadTemplate() {
    if (template) return template;
    const response = await fetch(SCRIPT_FILE, { cache: "no-cache" });
    if (!response.ok) throw new Error("the bot script file is missing (" + response.status + ")");
    template = await response.text();
    return template;
  }

  async function buildScript() {
    const typedCode = ($("blooketCode").value || "").trim();
    const code = /^\d{4,8}$/.test(typedCode) ? typedCode : "";
    const count = Math.max(1, Math.min(25, Number($("blooketCount").value) || 1));
    const names = chosenNames(count);
    const source = await loadTemplate();
    return source
      .replace("__CODE__", JSON.stringify(code))
      .replace("__NAMES__", JSON.stringify(names));
  }

  // Clipboard writes need a secure page and a click; when the browser refuses,
  // show the text in a tab so it can still be selected by hand.
  function showForCopy(text) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    window.open(url, "_blank", "noopener");
    setState("The browser refused the clipboard, so the script opened in a new tab — select it there and copy it.");
  }

  async function copyScript() {
    let script;
    try {
      script = await buildScript();
    } catch (error) {
      setState("Could not build the bot script: " + (error && error.message ? error.message : error) + ".");
      return;
    }
    try {
      await navigator.clipboard.writeText(script);
      setState("Copied. Open the Blooket join page, press F12 → Console, paste, and press Enter — it opens one tab per bot and fills in the code and nickname.");
    } catch (error) {
      showForCopy(script);
    }
  }

  function setNameMode() {
    $("blooketNamesWrap").classList.toggle("hidden", $("blooketModeRandom").checked);
  }

  function open() {
    overlay.classList.remove("hidden");
    setNameMode();
    $("blooketCode").focus();
  }

  function close() {
    overlay.classList.add("hidden");
  }

  $("blooketOpen").addEventListener("click", open);
  $("blooketClose").addEventListener("click", close);
  $("blooketCopy").addEventListener("click", copyScript);
  $("blooketModeRandom").addEventListener("change", setNameMode);
  $("blooketModeCustom").addEventListener("change", setNameMode);
  // Direct browser navigation; the relay cannot reach Blooket itself.
  $("blooketOpenJoin").addEventListener("click", () => {
    window.open(JOIN_URL, "_blank", "noopener");
    setState("Join page opened in a new tab. Get your bot script first, then paste it in that tab's console (F12).");
  });
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.classList.contains("hidden")) close();
  });
})();
