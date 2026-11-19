// Seuss Arcade — Blooket auto-join.
//
// Run this on Blooket's own page, not inside the arcade:
//   1. open https://play.blooket.com/play
//   2. press F12, choose Console
//   3. paste this file, press Enter
//
// Blooket is Cloudflare-hosted, so the arcade's relay cannot open a socket to
// it, and a page on another origin cannot script a Blooket frame. Here the
// script *is* on Blooket's origin, so the tabs it opens are same-origin and it
// can fill in the code and nickname of each one.
//
// The arcade fills in CODE and NAMES before you copy this; leave them empty and
// the script asks for them instead.
(() => {
  "use strict";

  const CODE = __CODE__ || (prompt("Game ID shown on the host screen:") || "").trim();
  const NAMES = __NAMES__;
  if (!CODE) return alert("No game ID was given, so nothing was sent.");
  if (location.hostname !== "play.blooket.com") {
    return alert("Open https://play.blooket.com/play first, then paste this script there.");
  }

  const names = (NAMES && NAMES.length
    ? NAMES
    : (prompt("Bot names, separated by commas:", "alpha, bravo, charlie") || "").split(","))
    .map((name) => String(name).trim())
    .filter(Boolean)
    .slice(0, 25);
  if (!names.length) return alert("No bot names were given.");

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

  async function join(win, name) {
    const doc = await until(() => {
      const ready = win.document;
      return ready && ready.readyState === "complete" && ready.body && ready.body.innerText.trim() ? ready : null;
    }, 30000);
    if (!doc) throw new Error("the tab never finished loading");

    click(win, /^reject all$|^accept all$/i);

    const box = await until(() => codeInput(win.document), 25000);
    if (box) {
      type(box, CODE);
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

  (async () => {
    const results = [];
    for (const name of names) {
      const win = window.open("https://play.blooket.com/play", "_blank", "width=560,height=820");
      if (!win) {
        results.push(name + ": popup blocked — allow popups for play.blooket.com and run again");
        break;
      }
      try {
        results.push(name + ": " + (await join(win, name)));
      } catch (error) {
        results.push(name + ": " + (error && error.message ? error.message : String(error)));
      }
      await sleep(1200);
    }
    console.log("[Seuss Arcade] bot results:\n" + results.join("\n"));
    alert("Bot results:\n\n" + results.join("\n"));
  })();
})();
