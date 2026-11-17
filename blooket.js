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
  // Every bot gets a signal so a stalled or abandoned join can be released
  // instead of holding the queue or answering twice after a new run starts.
  const botSignals = new Set();
  function newSignal() { const signal = { aborted: false }; botSignals.add(signal); return signal; }
  function abortAllSignals() { botSignals.forEach((signal) => { signal.aborted = true; }); botSignals.clear(); }
  function checkAbort(signal) { if (signal && signal.aborted) throw new Error("gave up on this bot"); }

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
    if (!proxy) proxy = await import("./proxy-client.js?v=4");
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

  function visibleQuestion(doc) {
    const shown = (node) => node && node.offsetParent !== null;
    const questionNode = [...doc.querySelectorAll('[class*="question" i], h1, h2, h3')]
      .find((node) => shown(node) && (node.innerText || "").trim().length > 6);
    if (!questionNode) return null;
    const candidates = [...doc.querySelectorAll('[class*="answer" i], [class*="option" i], button')]
      .filter((node) => shown(node) && /answer|option/i.test(String(node.className || "")))
      .map((node) => ({ node, text: (node.innerText || "").trim().slice(0, 80) }))
      .filter((option) => option.text && option.text.length < 80);
    // Clickable leaves only: a wrapper such as .answers matches the same class
    // filter and would otherwise shift every option index by one.
    const leaves = candidates.filter((outer) => !candidates.some((inner) => inner !== outer && outer.node.contains(inner.node)));
    const seen = new Set();
    const options = leaves.filter((option) => !seen.has(option.text) && seen.add(option.text));
    if (options.length < 2) return null;
    return { question: (questionNode.innerText || "").trim().slice(0, 400), options };
  }

  function botFrame(index) {
    // The proxy may swap the iframe element, so resolve by position instead of
    // keeping a reference or relying on attributes we set.
    return $("blooketBots").children[index] || null;
  }


  // Bots answer with a random option, so a full game can be filled without an
  // AI provider or key.
  async function answerLoop(index, name, signal) {
    let last = "";
    while (!stopped && !(signal && signal.aborted)) {
      await sleep(1500);
      // The frame is briefly cross-origin while the proxy takes over, so every
      // touch of its document has to be guarded or this loop dies for good.
      let found = null;
      try {
        // The proxy can replace the iframe element, so never hold a stale one.
        const frame = botFrame(index);
        if (!frame) continue;
        const doc = frame.contentDocument;
        if (!doc) continue;
        found = visibleQuestion(doc);
      } catch (error) {
        continue;
      }
      if (!found) continue;
      const signature = found.question + "|" + found.options.map((option) => option.text).join("|");
      if (signature === last) continue;
      last = signature;
      const picked = found.options[Math.floor(Math.random() * found.options.length)];
      try {
        picked.node.click();
        logLine("answered \"" + picked.text.slice(0, 28) + "\" (" + name + ")", "ok");
      } catch (error) {
        logLine("could not answer for " + name, "err");
      }
    }
  }

  function setValue(input, value) {
    const view = input.ownerDocument.defaultView;
    const proto = input.ownerDocument.defaultView.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
    input.dispatchEvent(new view.Event("input", { bubbles: true }));
    input.dispatchEvent(new view.Event("change", { bubbles: true }));
  }

  function submitForm(input) {
    const doc = input.ownerDocument;
    // Click the screen's own button first: native form submission reloads the
    // page on sites whose screens are drawn by script, losing the typed value.
    const button = [...doc.querySelectorAll("button, [type=submit], [role=button]")]
      .find((node) => visible(node) && /submit|join|next|enter|play|let'?s go/i.test((node.textContent || "").trim()));
    if (button) { button.click(); return; }
    if (input.form && typeof input.form.requestSubmit === "function") {
      try { input.form.requestSubmit(); return; } catch (error) { /* fall through to Enter */ }
    }
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

  // Record what Blooket itself answers when the page joins, so the panel can
  // report a real result instead of assuming the join worked.
  function watchNetwork(frame, hits) {
    try {
      const view = frame.contentWindow;
      if (!view || view.__bkNet === hits) return;
      view.__bkNet = hits;
      const staticFile = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|map)(\?|$)/i;
      const note = (url, status, text) => {
        const value = String(url || "");
        if (!value || staticFile.test(value)) return;
        hits.push({ url: value.slice(-70), status, text: String(text || "").slice(0, 180) });
        if (hits.length > 40) hits.shift();
      };
      const originalFetch = view.fetch;
      view.fetch = function (...args) {
        const request = args[0];
        const url = request && request.url ? request.url : String(request);
        const pending = originalFetch.apply(view, args);
        try {
          pending.then((response) => {
            try { response.clone().text().then((text) => note(url, response.status, text)).catch(() => {}); } catch (error) { /* ignore */ }
          }).catch(() => {});
        } catch (error) { /* never let bookkeeping break the page */ }
        return pending;
      };
      const open = view.XMLHttpRequest.prototype.open;
      const send = view.XMLHttpRequest.prototype.send;
      view.XMLHttpRequest.prototype.open = function (method, url) { this.__bkUrl = url; return open.apply(this, arguments); };
      view.XMLHttpRequest.prototype.send = function () {
        this.addEventListener("load", () => { try { note(this.__bkUrl, this.status, this.responseText); } catch (error) { /* ignore */ } });
        return send.apply(this, arguments);
      };
    } catch (error) { /* the frame may not be scriptable yet */ }
  }

  // A same-origin page can stand in for Blooket (page?blooketTest=...) so the
  // whole join flow can be exercised without a live game code.
  const TEST_TARGET = new URLSearchParams(location.search).get("blooketTest");
  const JOIN_PAGE = "https://play.blooket.com/play";

  async function loadTarget(frame, botIndex) {
    const marker = "bkbot=" + botIndex;
    if (TEST_TARGET) {
      frame.src = TEST_TARGET + (TEST_TARGET.indexOf("?") >= 0 ? "&" : "?") + marker;
      return;
    }
    const mod = await getProxy();
    await mod.openProxied(frame, JOIN_PAGE + "?" + marker);
  }

  // Cookie banners and ads also answer every page, so only quote replies that
  // are actually about a game or a player.
  function joinDetail(hits) {
    const relevant = hits.filter((hit) => /join|player|firebase|game/i.test(hit.url) || /"?(player|gameId|success)"?\s*:/i.test(hit.text));
    const last = relevant[relevant.length - 1];
    return last ? last.url.split("/").pop().slice(0, 26) + ": " + last.text.slice(0, 70) : "";
  }

  async function joinBot(frame, code, name, botIndex, signal) {
    if (stopped) throw new Error("stopped");
    checkAbort(signal);
    await loadTarget(frame, botIndex);
    checkAbort(signal);

    await waitFor(() => {
      const doc = frame.contentDocument;
      return doc && doc.body && textOf(doc).replace(/\s+/g, "").length > 0 ? doc : null;
    }, TEST_TARGET ? 30000 : 120000, "the Blooket join page");

    checkAbort(signal);
    clickLabel(frame.contentDocument, /^accept( all)?$/i);
    const netHits = [];
    watchNetwork(frame, netHits);

    let codeInput;
    try {
      codeInput = await waitFor(() => findCodeInput(frame.contentDocument), TEST_TARGET ? 20000 : 90000, "the game code box");
    } catch (error) {
      if (TEST_TARGET) throw error;
      // Several bots loading at once can starve the tunnel's first paint, so
      // give the same frame one clean reload before calling it a failure.
      logLine("Bot " + name + " has not shown the code box yet — loading it again", "warn");
      await loadTarget(frame, botIndex);
      codeInput = await waitFor(() => findCodeInput(frame.contentDocument), 90000, "the game code box");
    }
    setValue(codeInput, code);
    submitForm(codeInput);

    const answer = await waitFor(() => {
      watchNetwork(frame, netHits);
      const doc = frame.contentDocument;
      const text = textOf(doc);
      if (/invalid game id|game not found|game has ended|game is over/i.test(text)) {
        return { rejected: (text.match(/invalid game id|game not found|game has ended|game is over/i) || ["rejected"])[0] };
      }
      if (findNameInput(doc) || /nickname|your name|choose a name/i.test(text)) return { accepted: true };
      return null;
    }, 45000, "an answer from Blooket");

    if (answer.rejected) {
      const detail = joinDetail(netHits);
      throw new Error("Blooket refused the code (" + answer.rejected + (detail ? " · " + detail : "") + ")");
    }

    checkAbort(signal);
    const nameInput = await waitFor(() => {
      watchNetwork(frame, netHits);
      return findNameInput(frame.contentDocument);
    }, 30000, "the nickname box");
    watchNetwork(frame, netHits);
    setValue(nameInput, name);
    submitForm(nameInput);
    await sleep(2500);
    if (findNameInput(frame.contentDocument)) {
      clickLabel(frame.contentDocument, /^(join|join game|next|continue|play|let'?s go)$/i);
      await sleep(1500);
    }

    // Blooket usually asks a player to pick a Blook before the lobby accepts
    // them; leaving that screen open looks joined but is not.
    checkAbort(signal);
    for (let attempt = 0; attempt < 14; attempt += 1) {
      await sleep(500);
      checkAbort(signal);
      watchNetwork(frame, netHits);
      const doc = frame.contentDocument;
      if (!doc) continue;
      const blooks = [...doc.querySelectorAll('[class*="blook" i] button, button[class*="blook" i], [class*="blook" i] img')]
        .filter((node) => visible(node));
      if (blooks.length) {
        const choice = blooks[Math.floor(Math.random() * blooks.length)];
        const target = choice.closest("button") || choice;
        try { target.click(); } catch (error) { /* ignore */ }
        await sleep(1200);
        // The screen's own button is usually "Join Game" / "Play", so match on
        // the verb rather than the whole label.
        clickLabel(frame.contentDocument, /join|continue|play|start|let'?s go/i);
        await sleep(800);
        clickLabel(frame.contentDocument, /join|continue|play|start|let'?s go/i);
        break;
      }
      if (findNameInput(doc) === null && /waiting|joining|lobby/i.test(textOf(doc))) break;
    }

    let outcome;
    try {
      outcome = await waitFor(() => {
        watchNetwork(frame, netHits);
        const doc = frame.contentDocument;
        const text = textOf(doc);
        const hits = netHits;
        const failure = text.match(/invalid game id|game not found|game has ended|game is over|game is full|late join|name (is )?(already )?(taken|in use)/i);
        if (failure) {
          const last = hits[hits.length - 1];
          return { fail: failure[0] + (last ? " · " + last.text.slice(0, 70) : "") };
        }
        const apiHit = [...hits].reverse().find((hit) => /join|player/i.test(hit.url));
        if (apiHit && /"?(success|ok)"?\s*:\s*(true|1)/i.test(apiHit.text)) return { ok: "Blooket accepted the join" };
        if (/waiting for (the )?host|waiting room|you are in|joining the game/i.test(text)) return { ok: "waiting room shown" };
        const path = String((frame.contentWindow && frame.contentWindow.location && frame.contentWindow.location.pathname) || "");
        if (/\/play\/[a-z0-9]+/i.test(path) && !findNameInput(doc)) return { ok: "game page opened" };
        return null;
      }, 30000, "a join confirmation from Blooket");
    } catch (error) {
      const detail = joinDetail(netHits);
      throw new Error("could not confirm the join" + (detail ? " (Blooket said: " + detail + ")" : " — Blooket never answered a join request"));
    }

    if (outcome.fail) throw new Error("Blooket refused the join (" + outcome.fail + ")");
    return "joined — " + outcome.ok;
  }

  const JOIN_BUDGET = 180000;

  // One unresponsive bot must not hold up the bots behind it in the queue.
  function withDeadline(promise, ms, signal) {
    let timer;
    const guard = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        if (signal) signal.aborted = true;
        reject(new Error("gave up after " + Math.round(ms / 1000) + "s — moving to the next bot"));
      }, ms);
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
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

    abortAllSignals();
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
        const botIndex = $("blooketBots").children.length;
        frame.dataset.bot = String(botIndex);
        $("blooketBots").appendChild(frame);
        const line = logLine("Bot " + name + " loading the join page…");
        const signal = newSignal();
        answerLoop(botIndex, name, signal);
        try {
          const result = await withDeadline(joinBot(frame, code, name, botIndex, signal), JOIN_BUDGET, signal);
          line.className = "bk-ok";
          line.textContent = "Bot " + name + " " + result + ".";
          joined += 1;
        } catch (error) {
          if (signal) signal.aborted = true;
          line.className = "bk-err";
          const reason = error && error.message ? error.message : String(error);
          line.textContent = "Bot " + name + ": " + (/importScripts/i.test(reason)
            ? "the site's service worker is stale — reload this page (Ctrl+Shift+R) and try again"
            : reason);
          if (/refused the code|invalid game id|game not found|game has ended|game is over/i.test(line.textContent)) {
            fatal = "Blooket did not accept code " + code + " — check the code on the host screen.";
          }
        } finally {
          finished += 1;
          if (!fatal) setState("Bots: " + joined + " joined · " + finished + " of " + names.length + " attempted");
        }
      }
    };

    // One bot at a time: loading pages concurrently starves the tunnel, which is
    // what pushed bots into the reload retry.
    await worker();

    running = false;
    $("blooketStart").disabled = false;
    $("blooketStop").disabled = true;
    if (fatal) setState(fatal);
    else if (stopped) setState("Stopped after " + joined + " joined.");
    else setState(joined + " of " + names.length + " bots joined game " + code + ".");
  }

  function stop() {
    stopped = true;
    abortAllSignals();
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
