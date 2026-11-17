// Runs the three-bot Blooket test against blooket-mock.html in headless Edge.
// Everything it needs is started here: a static server for the site, an
// OpenAI-compatible stub for the answers, and the browser itself.
// Usage: npm run test:blooket
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const BOTS = 3;
const CODE = "555123";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function serveSite(port) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.join(ROOT, relative);
    if (!file.startsWith(ROOT)) { response.writeHead(403).end("forbidden"); return; }
    try {
      if (!statSync(file).isFile()) throw new Error("not a file");
    } catch (error) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    response.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}


function edgePath() {
  const candidates = [
    process.env.EDGE_PATH,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Edge was not found; set EDGE_PATH to msedge.exe");
  return found;
}

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const request = fetch(`http://127.0.0.1:${port}${urlPath}`);
    const timer = setTimeout(() => reject(new Error("devtools did not answer")), 3000);
    request.then((response) => response.json()).then((value) => { clearTimeout(timer); resolve(value); }).catch((error) => { clearTimeout(timer); reject(error); });
  });
}

async function launchHeadless(url) {
  const port = await freePort();
  const profile = mkdtempSync(path.join(tmpdir(), "blooket-test-"));
  const child = spawn(edgePath(), [
    "--headless=new", "--disable-gpu", "--mute-audio", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=" + port, "--remote-allow-origins=*", "--user-data-dir=" + profile,
    "--window-size=1400,900", url
  ], { stdio: "ignore" });

  let target = null;
  for (let attempt = 0; attempt < 60 && !target; attempt += 1) {
    try { target = (await getJson(port, "/json/list")).find((item) => item.type === "page"); } catch (error) { /* still starting */ }
    if (!target) await sleep(300);
  }
  if (!target) throw new Error("headless Edge never exposed a page");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () => reject(new Error("could not attach to the page")));
  });
  let id = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const settle = pending.get(message.id);
    if (settle) { pending.delete(message.id); settle(message); }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const messageId = id++;
    pending.set(messageId, resolve);
    socket.send(JSON.stringify({ id: messageId, method, params }));
  });
  await send("Runtime.enable");
  const evaluate = async (expression) => {
    const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.text || "page threw");
    return reply.result?.result?.value;
  };
  const close = () => {
    try { socket.close(); } catch (error) { /* ignore */ }
    try { child.kill(); } catch (error) { /* ignore */ }
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch (error) { /* locked */ } }, 1500);
  };
  return { evaluate, close };
}

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

const sitePort = await freePort();
const site = await serveSite(sitePort);
let browser = null;

try {
  console.log(`site :${sitePort} · headless Edge`);
  browser = await launchHeadless(`http://127.0.0.1:${sitePort}/index.html?blooketTest=/blooket-mock.html&test=1`);
  const { evaluate } = browser;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await evaluate(`!!document.getElementById('blooketStart')`)) break;
    await sleep(250);
  }

  await evaluate(`(() => {
    document.getElementById('blooketOpen').click();
    document.getElementById('blooketCode').value = '${CODE}';
    document.getElementById('blooketCount').value = '${BOTS}';
    document.getElementById('blooketStart').click();
    return true;
  })()`);

  const outcome = /joined|could not|did not|refused|timed out|not shown|gave up/i;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(3000);
    const settled = await evaluate(`[...document.querySelectorAll('#blooketLog li')].filter((line) => ${outcome}.test(line.textContent)).length`);
    if (settled >= BOTS) break;
  }

  // A bot only sees the mock's question a couple of seconds after joining, and
  // the watcher polls every 1.5s, so the answers arrive after the join lines.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const answered = await evaluate(`[...document.querySelectorAll('#blooketLog li')].filter((line) => /answered "/i.test(line.textContent)).length`);
    if (answered >= BOTS) break;
    await sleep(1500);
  }

  const logs = await evaluate(`[...document.querySelectorAll('#blooketLog li')].map((line) => line.textContent)`);
  const reloads = logs.filter((line) => /not shown the code box|loading it again/i.test(line)).length;
  const joined = logs.filter((line) => /joined — /i.test(line)).length;
  const answered = logs.filter((line) => /answered "/i.test(line)).length;
  const bots = await evaluate(`(() => {
    const out = [];
    for (let index = 0; index < ${BOTS}; index += 1) {
      const key = '__bk' + index + '__';
      out.push({
        id: localStorage.getItem(key + 'mockPlayerId'),
        code: localStorage.getItem(key + 'mockCode'),
        name: localStorage.getItem(key + 'mockName'),
        blook: localStorage.getItem(key + 'mockBlook'),
        answer: localStorage.getItem(key + 'mockAnswer')
      });
    }
    return out;
  })()`);

  console.log("\npanel log");
  for (const line of logs) console.log("  " + line);
  console.log("\nbots");
  for (const [index, bot] of bots.entries()) {
    console.log(`  ${index}: ${bot.id} · code ${bot.code} · name ${bot.name} · blook ${bot.blook || "-"} · answer ${bot.answer || "-"}`);
  }

  check(joined === BOTS, `expected ${BOTS} joins, got ${joined}`);
  check(reloads === 0, `expected no reload retries, got ${reloads}`);
  check(answered === BOTS, `expected an AI answer for each bot, got ${answered}`);
  check(bots.every((bot) => bot.code === CODE), "every bot should have typed the game code");
  check(bots.every((bot) => bot.name && bot.name.length > 2), "every bot should have typed a name");
  check(bots.every((bot) => bot.blook), "every bot should have picked a Blook");
  check(new Set(bots.map((bot) => bot.id)).size === BOTS, "bots should have separate player identities");
  check(bots.every((bot) => bot.answer), "every bot should pick an answer option");
} catch (error) {
  failures.push(error.message || String(error));
} finally {
  if (browser) browser.close();
  site.close();
}

if (failures.length) {
  console.log("\nFAIL");
  for (const failure of failures) console.log("  · " + failure);
  process.exitCode = 1;
} else {
  console.log("\nPASS — three bots joined the mock game with separate identities");
}
