"use strict";
// Seuss Blooket: sends bots into a live Blooket game with its code.
// Blooket refuses plain cross-origin requests and its join page cannot be
// scripted from a foreign frame, so every bot is a real join page loaded
// through the in-site proxy, which keeps it same-origin and scriptable.
(() => {
  const $ = (id) => document.getElementById(id);
  const overlay = $("blooketOverlay");
  if (!overlay) return;

  const ADJECTIVES = ["swift", "quiet", "brave", "clever", "lucky", "wild", "calm", "sharp", "sunny", "rapid", "frosty", "noble", "merry", "bold", "sly", "vivid", "gentle", "cosmic", "zesty", "misty"];
  const NOUNS = ["Otter", "Falcon", "Panda", "Tiger", "Koala", "Raven", "Lynx", "Bison", "Heron", "Yak", "Gecko", "Moth", "Wombat", "Crane", "Badger", "Ferret", "Quokka", "Tapir", "Marmot", "Puffin"];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let proxy = null;
  let running = false;
  let stopped = false;

  function logLine(text, kind) {
    const line = document.createElement("li");
    line.textContent = text;
    if (kind) line.className = "bk-" + kind;
    $("blooketLog").appendChild(line);
    $("blooketLog").scrollTop = $("blooketLog").scrollHeight;
    return line;
  }

  function setState(text) {
    $("blooketState").textContent = text;
  }

  async function getProxy() {
    if (!proxy) proxy = await import("./proxy-client.js?v=5");
    return proxy;
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

  function chosenNames(count) {
    if ($("blooketModeRandom").checked) return generatedNames(count);
    const typed = ($("blooketNames").value || "")
      .split(/[\n,]+/)
      .map((name) => name.trim().slice(0, 20))
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

  async function waitFor(get, ms, label) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (stopped) throw new Error("stopped");
      let value = null;
      try { value = get(); } catch (error) { value = null; }
      if (value) return value;
      await sleep(300);
    }
    throw new Error("timed out waiting for " + label);
  }

  const visible = (node) => !!node && node.offsetParent !== null;
  const textOf = (doc) => (doc && doc.body && doc.body.innerText) || "";

  function setValue(input, value) {
    const view = input.ownerDocument.defaultView;
    const proto = input.ownerDocument.defaultView.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
    input.dispatchEvent(new view.Event("input", { bubbles: true }));
    input.dispatchEvent(new view.Event("change", { bubbles: true }));
  }

  function submitForm(input) {
    const doc = input.ownerDocument;
    if (input.form && typeof input.form.requestSubmit === "function") {
      try { input.form.requestSubmit(); return; } catch (error) { /* fall through to a click */ }
    }
    const button = [...doc.querySelectorAll("button, [type=submit]")].find((node) => visible(node) && /submit|join|next|enter|play|let'?s go/i.test(node.textContent || ""));
    if (button) { button.click(); return; }
    input.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  }

  function clickLabel(doc, pattern) {
    const node = [...doc.querySelectorAll("button, a, [role=button]")].find((item) => visible(item) && pattern.test((item.textContent || "").trim()));
    if (node) { node.click(); return true; }
    return false;
  }

  const CODE_FIELD = /game id|code/i;

  function findCodeInput(doc) {
    return [...doc.querySelectorAll("input")].find((input) => visible(input) &&
      (input.type === "tel" || input.type === "number" || CODE_FIELD.test(input.placeholder || ""))) || null;
  }

  function findNameInput(doc) {
    const candidates = [...doc.querySelectorAll("input")].filter((input) => visible(input) &&
      !CODE_FIELD.test(input.placeholder || "") && (input.type === "text" || input.type === ""));
    return candidates.find((input) => /name|nick/i.test((input.placeholder || "") + (input.name || "") + (input.id || ""))) ||
      candidates.find((input) => !input.readOnly) || null;
  }

  async function joinBot(frame, code, name) {
    const mod = await getProxy();
    if (stopped) throw new Error("stopped");
    await mod.openProxied(frame, "https://play.blooket.com/play");

    await waitFor(() => {
      const doc = frame.contentDocument;
      return doc && doc.body && textOf(doc).replace(/\s+/g, "").length > 0 ? doc : null;
    }, 60000, "the Blooket join page");

    clickLabel(frame.contentDocument, /^accept( all)?$/i);

    const codeInput = await waitFor(() => findCodeInput(frame.contentDocument), 45000, "the game code box");
    setValue(codeInput, code);
    submitForm(codeInput);

    const answer = await waitFor(() => {
      const doc = frame.contentDocument;
      const text = textOf(doc);
      if (/invalid game id|game not found|game has ended|game is over/i.test(text)) {
        return { rejected: (text.match(/invalid game id|game not found|game has ended|game is over/i) || ["rejected"])[0] };
      }
      if (findNameInput(doc) || /nickname|your name|choose a name/i.test(text)) return { accepted: true };
      return null;
    }, 30000, "an answer from Blooket");

    if (answer.rejected) throw new Error("Blooket refused the code (" + answer.rejected + ")");

    const nameInput = await waitFor(() => findNameInput(frame.contentDocument), 30000, "the nickname box");
    setValue(nameInput, name);
    submitForm(nameInput);

    await sleep(5000);
    const after = textOf(frame.contentDocument);
    if (/name (is )?(already )?(taken|in use)/i.test(after)) throw new Error("nickname already in use");
    return "joined";
  }

  async function start() {
    if (running) return;
    const code = ($("blooketCode").value || "").trim();
    if (!/^\d{4,8}$/.test(code)) {
      setState("Enter the game code Blooket shows on the host screen.");
      return;
    }
    const count = Math.max(1, Math.min(25, Number($("blooketCount").value) || 1));
    const names = chosenNames(count);

    running = true;
    stopped = false;
    $("blooketStart").disabled = true;
    $("blooketStop").disabled = false;
    $("blooketLog").replaceChildren();
    $("blooketBots").replaceChildren();
    setState("Sending " + names.length + " bot" + (names.length === 1 ? "" : "s") + " to game " + code + "…");

    const queue = names.slice();
    let fatal = "";
    let finished = 0;
    let joined = 0;

    const worker = async () => {
      while (queue.length && !stopped && !fatal) {
        const name = queue.shift();
        const frame = document.createElement("iframe");
        frame.title = "Blooket bot " + name;
        frame.setAttribute("referrerpolicy", "no-referrer");
        frame.sandbox = "allow-scripts allow-forms allow-same-origin allow-pointer-lock";
        $("blooketBots").appendChild(frame);
        const line = logLine("Bot " + name + " loading the join page…");
        try {
          const result = await joinBot(frame, code, name);
          line.className = "bk-ok";
          line.textContent = "Bot " + name + " " + result + ".";
          joined += 1;
        } catch (error) {
          line.className = "bk-err";
          line.textContent = "Bot " + name + ": " + (error && error.message ? error.message : String(error));
          if (/refused the code|invalid game id|game not found|game has ended|game is over/i.test(line.textContent)) {
            fatal = "Blooket did not accept code " + code + " — check the code on the host screen.";
          }
        } finally {
          finished += 1;
          if (!fatal) setState("Bots: " + joined + " joined · " + finished + " of " + names.length + " attempted");
        }
      }
    };

    await Promise.all([worker(), worker(), worker()]);

    running = false;
    $("blooketStart").disabled = false;
    $("blooketStop").disabled = true;
    if (fatal) setState(fatal);
    else if (stopped) setState("Stopped after " + joined + " joined.");
    else setState(joined + " of " + names.length + " bots joined game " + code + ".");
  }

  function stop() {
    stopped = true;
    setState("Stopping…");
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
    if (running) return;
    overlay.classList.add("hidden");
  }

  $("blooketOpen").addEventListener("click", open);
  $("blooketClose").addEventListener("click", close);
  $("blooketStart").addEventListener("click", start);
  $("blooketStop").addEventListener("click", stop);
  $("blooketModeRandom").addEventListener("change", setNameMode);
  $("blooketModeCustom").addEventListener("change", setNameMode);
  $("blooketShowBots").addEventListener("click", () => {
    $("blooketBots").classList.toggle("bk-shown");
    $("blooketShowBots").textContent = $("blooketBots").classList.contains("bk-shown") ? "Hide bot windows" : "Show bot windows";
  });
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.classList.contains("hidden")) close();
  });
})();
