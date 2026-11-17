// Runs Blooket bots straight against play.blooket.com with no proxy: one real
// browser profile per bot, so every bot is a separate visitor. Joins with the
// game code and nickname, picks a Blook, then answers questions.
//
//   node scripts/blooket-bots.mjs --code 1234567 --count 3
//   node scripts/blooket-bots.mjs --code 1234567 --count 3 --names "ann,bob,cid"
//   node scripts/blooket-bots.mjs --code 1234567 --count 3 --minutes 40 --show
//
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf("--" + name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};
const code = flag("code", "");
const count = Math.max(1, Math.min(30, Number(flag("count", "1")) || 1));
const names = (flag("names", "") || "").split(",").map((name) => name.trim()).filter(Boolean);
const minutes = Math.max(1, Math.min(180, Number(flag("minutes", "20")) || 20));
const show = args.includes("--show");
const pageUrl = flag("url", "https://play.blooket.com/play");

if (!/^\d{4,8}$/.test(code)) {
  console.error("Pass the game code: --code 1234567");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WORDS = ["calm", "brave", "sunny", "rapid", "lucky", "bold", "misty", "sharp", "quiet", "wild"];
const CREATURES = ["Crane", "Otter", "Yak", "Panda", "Falcon", "Lynx", "Moth", "Tapir", "Bison", "Puffin"];
const botName = (index) => names[index] || WORDS[index % WORDS.length] + CREATURES[Math.floor(index / WORDS.length) % CREATURES.length];

function edgePath() {
  const found = [process.env.EDGE_PATH, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"]
    .filter(Boolean).find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Edge was not found; set EDGE_PATH to msedge.exe");
  return found;
}

async function freePort() {
  const { createServer } = await import("node:http");
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// One browser window with its own profile, driven over the debug protocol.
async function launchPage(url, { visible = false } = {}) {
  const port = await freePort();
  const profile = mkdtempSync(path.join(tmpdir(), "blooket-bot-"));
  const chrome = [
    "--remote-debugging-port=" + port, "--remote-allow-origins=*", "--user-data-dir=" + profile,
    "--no-first-run", "--no-default-browser-check", "--window-size=1000,780", "--mute-audio"
  ];
  if (!visible) {
    chrome.push("--headless=new", "--disable-gpu",
      "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "--disable-blink-features=AutomationControlled");
  }
  const child = spawn(edgePath(), [...chrome, url], { stdio: "ignore" });

  let target = null;
  for (let attempt = 0; attempt < 90 && !target; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((item) => item.type === "page" && !String(item.url).startsWith("edge://"));
    } catch (error) { /* still starting */ }
    if (!target) await sleep(300);
  }
  if (!target) throw new Error("browser never opened the page");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () => reject(new Error("could not attach")));
  });
  let id = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const settle = pending.get(message.id);
    if (settle) { pending.delete(message.id); settle(message); }
  });
  const evaluate = async (expression) => {
    const messageId = id++;
    const reply = await new Promise((resolve) => {
      pending.set(messageId, resolve);
      socket.send(JSON.stringify({ id: messageId, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }));
    });
    if (reply.result?.exceptionDetails) {
      const text = reply.result.exceptionDetails.exception?.description || reply.result.exceptionDetails.text || "";
      throw new Error(String(text).split("\n")[0].slice(0, 160));
    }
    return reply.result?.result?.value;
  };
  const close = () => {
    try { socket.close(); } catch (error) { /* ignore */ }
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch (error) { /* locked */ } }, 2000);
  };
  return { evaluate, close };
}

const snapshot = (bot) => bot.page.evaluate(`(() => {
  const shown = (node) => !!node && node.offsetParent !== null;
  const text = (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim();
  const inputs = [...document.querySelectorAll('input')].filter(shown).map((input) => ({ type: input.type, placeholder: input.placeholder || '', value: input.value }));
  const buttons = [...document.querySelectorAll('button, [role=button]')].filter(shown).map((node) => (node.textContent || '').trim());
  const question = (() => {
    const node = [...document.querySelectorAll('[class*="question" i], h1, h2, h3')].find((item) => shown(item) && (item.innerText || '').trim().length > 6);
    return node ? (node.innerText || '').trim().slice(0, 300) : '';
  })();
  const answers = [...document.querySelectorAll('[class*="answer" i], [class*="option" i]')]
    .filter((node) => shown(node) && (node.innerText || '').trim() && !node.querySelector('[class*="answer" i], [class*="option" i]'))
    .map((node) => (node.innerText || '').trim().slice(0, 80));
  return JSON.stringify({ text: text.slice(0, 500), inputs, buttons, question, answers, url: location.href });
})()`);

const clickText = (bot, pattern) => bot.page.evaluate(`(() => {
  const node = [...document.querySelectorAll('button, [role=button], a')]
    .find((item) => item.offsetParent !== null && ${pattern}.test((item.textContent || '').trim()));
  if (!node) return '';
  node.click();
  return (node.textContent || '').trim();
})()`);

const typeInto = (bot, placeholderPattern, value) => bot.page.evaluate(`(() => {
  const input = [...document.querySelectorAll('input')]
    .find((item) => item.offsetParent !== null && (item.type === 'tel' || item.type === 'text') && ${placeholderPattern}.test(item.placeholder || ''));
  if (!input) return '';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  input.focus();
  setter.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const button = [...document.querySelectorAll('button')].find((item) => item.offsetParent !== null && /join|next|play|submit|enter/i.test(item.textContent || ''));
  if (button) { button.click(); return 'button'; }
  input.form?.requestSubmit();
  return 'form';
})()`);

const clickAnswer = (bot, text) => bot.page.evaluate(`(() => {
  const wanted = ${JSON.stringify(text)};
  const node = [...document.querySelectorAll('[class*="answer" i], [class*="option" i], button')]
    .find((item) => item.offsetParent !== null && (item.innerText || '').trim() === wanted);
  if (!node) return '';
  node.click();
  return (node.innerText || '').trim();
})()`);

async function runBot(bot) {
  const log = (message) => console.log(`[${bot.name}] ${message}`);
  const deadline = Date.now() + minutes * 60000;
  let stage = "opening";
  let lastQuestion = "";
  let joinClicks = 0;
  let reportedBlook = false;

  while (Date.now() < deadline) {
    const raw = await snapshot(bot).catch(() => undefined);
    if (!raw) { await sleep(800); continue; }
    const page = JSON.parse(raw);
    const shownText = page.text;

    // Cookie banners cover the join form and swallow clicks, so clear them on
    // every pass rather than only once.
    if (page.buttons.some((label) => /^accept( all)?$/i.test(label))) {
      if (await clickText(bot, /^accept( all)?$/i)) { await sleep(600); continue; }
    }

    if (/invalid game id|game not found|game has ended|game is over|failed to join/i.test(shownText)) {
      log("Blooket refused: " + shownText.slice(0, 90));
      return "refused";
    }

    const inLobby = /waiting for (the )?host|you are in|joining the game/i.test(shownText);
    if (!inLobby) {
      const codeField = page.inputs.find((input) => input.type === "tel" || /game id|code/i.test(input.placeholder));
      if (codeField) {
        if (codeField.value !== code) {
          if (await typeInto(bot, /game id|code/i, code)) { log("typed game code " + code); await sleep(2000); continue; }
        }
        await sleep(1200);
        continue;
      }

      const nameField = page.inputs.find((input) => /name|nick/i.test(input.placeholder));
      if (nameField) {
        if (nameField.value !== bot.name) {
          if (await typeInto(bot, /name|nick/i, bot.name)) { log("typed nickname " + bot.name); await sleep(2000); continue; }
        }
        const picked = await bot.page.evaluate(`(() => {
          const choices = [...document.querySelectorAll('button[class*="blook" i], [class*="blook" i] button')].filter((node) => node.offsetParent !== null);
          if (!choices.length) return '';
          (choices[Math.floor(Math.random() * choices.length)]).click();
          return String(choices.length);
        })()`);
        if (picked && !reportedBlook) { reportedBlook = true; log("picked a Blook (" + picked + " available)"); }
        await sleep(900);
        const joined = await clickText(bot, /join|play|continue|start|let'?s go|confirm/i);
        if (joined) { joinClicks += 1; log("clicked \"" + joined + "\""); }
        await sleep(1800);
        if (joinClicks > 8) {
          log("stuck: " + shownText.slice(0, 90) + " | buttons: " + page.buttons.join(",").slice(0, 70));
          return "stuck";
        }
        continue;
      }

      if (page.buttons.some((label) => /join|play|start|continue|confirm/i.test(label))) {
        await clickText(bot, /join|play|start|continue|confirm/i);
        await sleep(1500);
        continue;
      }
      await sleep(1000);
      continue;
    }

    if (stage !== "lobby") { stage = "lobby"; log("joined — waiting for the host"); }

    if (page.question && page.answers.length >= 2) {
      const signature = page.question + "|" + page.answers.join("|");
      if (signature !== lastQuestion) {
        lastQuestion = signature;
        // Bots pick a random option; there is no AI provider involved.
        const index = Math.floor(Math.random() * page.answers.length);
        const clicked = await clickAnswer(bot, page.answers[index]);
        log(`answered "${page.answers[index]}"${clicked ? "" : " (click missed)"}`);
      }
    }
    await sleep(1500);
  }

  log("stopped watching after " + minutes + " minute" + (minutes === 1 ? "" : "s"));
  return stage === "lobby" ? "lobby" : "timeout";
}

const bots = [];
const results = [];
try {
  console.log(`game ${code} · ${count} bot${count === 1 ? "" : "s"} · random answers${show ? " · visible" : " · headless"}`);
  for (let index = 0; index < count; index += 1) {
    const name = botName(index);
    bots.push({ name, page: await launchPage(pageUrl, { visible: show }) });
    console.log(`[${name}] browser ready`);
  }
  results.push(...await Promise.all(bots.map((bot) => runBot(bot))));
  const joined = results.filter((result) => result === "lobby").length;
  console.log(`\n${joined} of ${count} bots joined game ${code}`);
} catch (error) {
  console.error("failed: " + (error.message || error));
  process.exitCode = 1;
} finally {
  for (const bot of bots) bot.page.close();
}
