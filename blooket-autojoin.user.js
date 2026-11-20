// ==UserScript==
// @name         Seuss Arcade — Blooket auto-join
// @namespace    https://damonrosshutchins-boop.github.io/Dr-seuss-Moives-Games-test/
// @version      1.2.0
// @description  Opens one tab per bot on Blooket's join page and fills in the game code and nickname.
// @match        https://play.blooket.com/play*
// @updateURL    https://damonrosshutchins-boop.github.io/Dr-seuss-Moives-Games-test/blooket-autojoin.user.js
// @downloadURL  https://damonrosshutchins-boop.github.io/Dr-seuss-Moives-Games-test/blooket-autojoin.user.js
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==
//
// Seuss Arcade — Blooket auto-join.
//
// Blooket is Cloudflare-hosted, so the arcade's relay cannot open a socket to
// it, and a page on another origin cannot script a Blooket frame. Here the
// script *is* on Blooket's origin, so each tab it opens is same-origin and it
// can fill in the game code and nickname for that tab.
//
// Install it once in Tampermonkey or Violentmonkey, then press "Arm & launch"
// in the arcade's Blooket panel. The game code and names ride in the link's
// hash (#seuss=…), which stays in the browser and never reaches Blooket.
// Updates arrive through @updateURL/@downloadURL above, so reinstalling is
// never needed.
//
// With no armed link and an empty preset below, this script does nothing at
// all, so ordinary visits to Blooket are untouched. The panel's "Copy for
// console" bakes the code and names into the PRESET line and copies the whole
// file, so it still works as a console paste without a userscript manager.
(() => {
  "use strict";

  // The arcade's "Copy for console" button fills in this line.
  const PRESET = { "code": "", "names": [] }; // SEUSS-PRESET
  const MAX_BOTS = 25;
  const JOB_KEY = "seuss-arcade-job";
  const JOB_TTL = 10 * 60 * 1000;

  const ready = (fn) => {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once: true });
    else fn();
  };

  if (location.hostname !== "play.blooket.com") {
    ready(() => alert("Open https://play.blooket.com/play first, then run this script there."));
    return;
  }

  // Blooket's router rewrites the URL as soon as it boots, which can drop the
  // hash before a document-idle script ever looks at it. So the job is read at
  // document-start — before any page script exists to touch the address — and
  // the URL is cleaned right there. The router never sees the hash, and a
  // reload of this tab cannot re-fire the job.
  function readHash() {
    try {
      return new URLSearchParams(location.hash.slice(1)).get("seuss") || "";
    } catch (error) {
      return "";
    }
  }

  function unpark() {
    try { sessionStorage.removeItem(JOB_KEY); } catch (error) { /* storage disabled */ }
  }

  function park(raw) {
    try { sessionStorage.setItem(JOB_KEY, JSON.stringify({ raw, at: Date.now() })); } catch (error) { /* storage disabled */ }
  }

  // The parked copy is what survives a router rewrite, and it expires so an old
  // job cannot fire on a much later visit in the same tab.
  function parked() {
    try {
      const held = JSON.parse(sessionStorage.getItem(JOB_KEY) || "null");
      if (!held || typeof held.raw !== "string") return "";
      if (Date.now() - Number(held.at || 0) > JOB_TTL) { unpark(); return ""; }
      return held.raw;
    } catch (error) {
      return "";
    }
  }

  function cleanUrl() {
    try {
      if (location.hash) history.replaceState(history.state, "", location.pathname + location.search);
    } catch (error) { /* the router already moved on */ }
  }

  function split(raw) {
    const [code, ...names] = String(raw).split("\n").map((part) => part.trim());
    return { code: code || "", names: names.filter(Boolean) };
  }

  let armed = false;

  // One claim per page, so the hash, a parked copy and a late hashchange can
  // never arm the same tab twice.
  function claim() {
    if (armed) return null;
    const linked = split(parked() || readHash());
    if (linked.code) {
      armed = true;
      unpark();
      cleanUrl();
      return { code: linked.code, names: linked.names, linked: true };
    }
    const presetCode = String(PRESET.code || "").trim();
    if (presetCode) {
      armed = true;
      return { code: presetCode, names: (PRESET.names || []).map((name) => String(name)), linked: false };
    }
    return null; // nothing armed: stay completely silent
  }

  const early = readHash();
  if (early) {
    park(early);
    cleanUrl();
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function until(get, ms = 30000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      let value = null;
      try { value = get(); } catch (error) { value = null; }
      if (value) return value;
      await sleep(250);
    }
    return null;
  }

  // React inputs ignore a plain .value assignment, so set it the way a keypress
  // would and let Blooket's own handlers see the change.
  function type(input, value) {
    const view = input.ownerDocument.defaultView;
    const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    for (const kind of ["input", "change"]) input.dispatchEvent(new view.Event(kind, { bubbles: true }));
  }

  const shown = (node) => !!node && node.offsetParent !== null;

  function click(win, pattern) {
    const node = [...win.document.querySelectorAll("button, a, [role=button], [type=submit]")]
      .find((item) => shown(item) && pattern.test((item.textContent || "").trim()));
    if (node) { node.click(); return true; }
    return false;
  }

  const codeInput = (doc) => [...doc.querySelectorAll("input")]
    .find((input) => shown(input) && /game id|code/i.test(input.placeholder || ""));
  // Blooket's join step is "Enter Nickname" with an input placeholder "Nickname"
  // capped at 15 characters.
  const nickInput = (doc) => [...doc.querySelectorAll("input")]
    .find((input) => shown(input) && /nick|name/i.test((input.placeholder || "") + (input.name || "")));

  async function join(win, code, name) {
    const doc = await until(() => {
      const ready = win.document;
      return ready && ready.readyState === "complete" && ready.body && ready.body.innerText.trim() ? ready : null;
    }, 30000);
    if (!doc) throw new Error("the tab never finished loading");

    click(win, /^reject all$|^accept all$/i);

    const box = await until(() => codeInput(win.document), 25000);
    if (box) {
      type(box, code);
      if (box.form && typeof box.form.requestSubmit === "function") box.form.requestSubmit();
      else click(win, /submit|join|enter|next/i);
    }

    const nick = await until(() => nickInput(win.document), 30000);
    if (!nick) {
      const text = (win.document.body && win.document.body.innerText) || "";
      const reason = text.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 2).join(" ");
      throw new Error(reason || "no nickname box appeared — is the lobby still open for joining?");
    }
    type(nick, name.slice(0, 15));
    await sleep(300);
    if (!click(win, /^join$|^submit$|^enter$|^play$/i) && nick.form && nick.form.requestSubmit) nick.form.requestSubmit();

    await sleep(2500);
    const after = (win.document.body && win.document.body.innerText) || "";
    if (/already (taken|in use)|name (is )?taken|game (has )?(ended|closed)|not found/i.test(after)) {
      throw new Error(after.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 2).join(" "));
    }
    return "joined";
  }

  async function start(code, names) {
    const results = [];
    for (const name of names) {
      const win = window.open("https://play.blooket.com/play", "_blank", "width=560,height=820");
      if (!win) {
        results.push(name + ": popup blocked — allow popups for play.blooket.com and run again");
        break;
      }
      try {
        results.push(name + ": " + (await join(win, code, name)));
      } catch (error) {
        results.push(name + ": " + (error && error.message ? error.message : String(error)));
      }
      await sleep(1200);
    }
    console.log("[Seuss Arcade] bot results:\n" + results.join("\n"));
    alert("Bot results:\n\n" + results.join("\n"));
  }

  // A tab opened from a link cannot open more windows without a gesture, so an
  // armed tab offers one button instead of relying on Blooket's own controls.
  function launchBar(code, names, run) {
    if (!document.body) return;
    const bar = document.createElement("div");
    bar.setAttribute("data-seuss-arcade", "bots");
    bar.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;gap:12px;align-items:center;background:#232323;color:#fbfbfb;border:1px solid #6d6d6d;border-radius:12px;padding:12px 14px;font:600 13px/1.4 system-ui,sans-serif;box-shadow:0 14px 40px #00000088";
    const label = document.createElement("span");
    label.textContent = names.length + (names.length === 1 ? " bot armed for game " : " bots armed for game ") + code + ".";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Start bots";
    button.style.cssText = "border:0;border-radius:8px;padding:8px 12px;font:700 13px system-ui,sans-serif;background:linear-gradient(115deg,#ffffff,#c4c4c4);color:#000;cursor:pointer";
    button.addEventListener("click", () => {
      bar.remove();
      run();
    });
    bar.append(label, button);
    document.body.append(bar);
  }

  function run(job) {
    let names = job.names.map((name) => String(name).trim()).filter(Boolean);
    if (!names.length) {
      names = (prompt("Bot names, separated by commas:", "alpha, bravo, charlie") || "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    }
    names = names.slice(0, MAX_BOTS);
    if (!names.length) return alert("No bot names were given.");
    if (job.linked) launchBar(job.code, names, () => start(job.code, names));
    else start(job.code, names);
  }

  function boot() {
    const job = claim();
    if (job) ready(() => run(job));
  }

  // A link pasted into an already-open Blooket tab changes only the hash — the
  // page never reloads — so a late job has to be caught here as well.
  window.addEventListener("hashchange", () => {
    const late = readHash();
    if (!late) return;
    park(late);
    cleanUrl();
    boot();
  });

  boot();
})();
