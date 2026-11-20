"use strict";
// Seuss Blooket: gets the bots into a live game without a proxied bot farm.
//
// Blooket is Cloudflare-hosted, so the relay cannot open a socket to it, and a
// page on this origin cannot script a Blooket frame. The one thing that does
// work is a script running on Blooket's own page, where each bot tab it opens
// is same-origin. This panel either arms that script through a link hash (it
// is installed once as a userscript) or bakes the code and names into a copy
// for the console.
(() => {
  const $ = (id) => document.getElementById(id);
  const overlay = $("blooketOverlay");
  if (!overlay) return;

  const ADJECTIVES = ["swift", "quiet", "brave", "clever", "lucky", "wild", "calm", "sharp", "sunny", "rapid", "frosty", "noble", "merry", "bold", "sly", "vivid", "gentle", "cosmic", "zesty", "misty"];
  const NOUNS = ["Otter", "Falcon", "Panda", "Tiger", "Koala", "Raven", "Lynx", "Bison", "Heron", "Yak", "Gecko", "Moth", "Wombat", "Crane", "Badger", "Ferret", "Quokka", "Tapir", "Marmot", "Puffin"];
  const JOIN_URL = "https://play.blooket.com/play";
  const SCRIPT_FILE = "./blooket-autojoin.user.js";
  // The userscript ships with an empty preset so that, installed but unarmed,
  // it stays silent on ordinary Blooket visits.
  const PRESET_LINE = /const PRESET = \{[^}]*\}; \/\/ SEUSS-PRESET/;
  const MAX_BOTS = 25;

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

  // The game code stays empty unless it looks like one, so a typo never arms a
  // script that would do nothing but open blank tabs.
  function chosen() {
    const typedCode = ($("blooketCode").value || "").trim();
    const code = /^\d{4,8}$/.test(typedCode) ? typedCode : "";
    const count = Math.max(1, Math.min(MAX_BOTS, Number($("blooketCount").value) || 1));
    return { code, count, names: chosenNames(count) };
  }

  async function buildScript() {
    const { code, names } = chosen();
    if (!code) throw new Error("enter the game code from the host screen first");
    const source = await loadTemplate();
    if (!PRESET_LINE.test(source)) throw new Error("the bot script has no preset line to fill in");
    return source.replace(PRESET_LINE, "const PRESET = " + JSON.stringify({ code, names }) + "; // SEUSS-PRESET");
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
      setState("Copied. This is the fallback for a browser with no userscript manager: open the Blooket join page, press F12 → Console, paste, and press Enter — it opens one tab per bot and fills in the code and nickname.");
    } catch (error) {
      showForCopy(script);
    }
  }

  // Installed once, the same file runs by itself on the join page. Tampermonkey
  // and Violentmonkey both offer their install page for a .user.js URL.
  function installScript() {
    const win = window.open(SCRIPT_FILE, "_blank");
    if (!win) {
      setState("The browser blocked the tab. Allow popups for this site, then press Install userscript again.");
      return;
    }
    setState("If Tampermonkey or Violentmonkey is installed it now shows an install page — press Install there once and this panel never needs the console again.");
  }

  // Arms the installed userscript: the code and names travel in the hash, which
  // the browser keeps and Blooket's servers never see.
  function armAndLaunch() {
    const { code, names } = chosen();
    if (!code) {
      setState("Enter the game code the host screen shows — four to eight digits — then press Arm & launch again.");
      $("blooketCode").focus();
      return;
    }
    const hash = "#seuss=" + encodeURIComponent([code, ...names].join("\n"));
    const win = window.open(JOIN_URL + hash, "_blank");
    if (!win) {
      setState("The browser blocked the tab. Allow popups for this site, then press Arm & launch again.");
      return;
    }
    setState("Blooket opened with " + names.length + (names.length === 1 ? " bot" : " bots") + " armed for game " + code + ". Install the userscript first if you have not — the tab then shows a Start button. Allow popups for play.blooket.com so the bot tabs can open.");
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
  $("blooketArm").addEventListener("click", armAndLaunch);
  $("blooketInstall").addEventListener("click", installScript);
  $("blooketCopy").addEventListener("click", copyScript);
  $("blooketModeRandom").addEventListener("change", setNameMode);
  $("blooketModeCustom").addEventListener("change", setNameMode);
  // Direct browser navigation; the relay cannot reach Blooket itself.
  $("blooketOpenJoin").addEventListener("click", () => {
    window.open(JOIN_URL, "_blank", "noopener");
    setState("Join page opened in a new tab, with no bots armed. Use Arm & launch instead when you want the bots to join it.");
  });
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.classList.contains("hidden")) close();
  });
})();
