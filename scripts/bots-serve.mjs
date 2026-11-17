// Local bot service for the arcade's Blooket bot panel.
//
// Run it once and leave it in a terminal:
//   npm run bots:serve
//
// The panel then needs only a room code and a bot count: pressing Start posts to
// this service, which launches scripts/blooket-bots.mjs, and every bot opens its
// own browser, types the code into play.blooket.com/play, types a random
// nickname and joins. Nothing else is typed by hand.
//
// It listens on loopback only, so nothing on the network can reach it, and it
// answers the arcade origin plus the Pages site so the hosted page can call it.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.BOTS_PORT || 8791);
const runner = path.join(process.cwd(), "scripts", "blooket-bots.mjs");
const logDir = path.join(process.cwd(), "_work", "bot-logs");
// Tests point the bots at the local mock room instead of the real one.
const testUrl = process.env.BOTS_URL || "";
const allowedOrigins = new Set([
  "https://damonrosshutchins-boop.github.io",
  "http://localhost:8123",
  "http://127.0.0.1:8123"
]);
const isLocalOrigin = (origin) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

const running = new Map();

function cors(origin) {
  const ok = allowedOrigins.has(origin) || isLocalOrigin(origin) || !origin;
  if (!ok) return null;
  const headers = {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    // Chrome asks before a public page may call loopback; this allows it.
    "access-control-allow-private-network": "true",
    vary: "origin"
  };
  return headers;
}

function reply(response, status, body, origin) {
  const headers = cors(origin);
  if (!headers) {
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "origin not allowed" }));
    return;
  }
  response.writeHead(status, { ...headers, "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 4000) { reject(new Error("body too large")); request.destroy(); }
    });
    request.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(new Error("invalid JSON body")); }
    });
    request.on("error", reject);
  });
}

function start(code, count) {
  if (!/^\d{4,8}$/.test(code)) throw new Error("Type the 4 to 8 digit room code.");
  const bots = Math.max(1, Math.min(50, Number(count) || 1));
  mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(logDir, "room-" + code + "-" + stamp + ".log");
  const out = openSync(logPath, "a");
  const args = [runner, "--code", code, "--count", String(bots)];
  if (testUrl) args.push("--url", testUrl);
  const child = spawn(process.execPath, args, { cwd: process.cwd(), detached: true, stdio: ["ignore", out, out] });
  child.unref();
  running.set(child.pid, { code, bots, logPath, startedAt: Date.now() });
  child.on("exit", () => running.delete(child.pid));
  console.log("[bots] room " + code + " · " + bots + " bot" + (bots === 1 ? "" : "s") + " · pid " + child.pid + " · " + logPath);
  return { ok: true, code, bots, pid: child.pid, log: logPath };
}

const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin || "";
  if (request.method === "OPTIONS") {
    const headers = cors(origin);
    if (!headers) { response.writeHead(403); response.end(); return; }
    response.writeHead(204, headers);
    response.end();
    return;
  }
  const url = new URL(request.url || "/", "http://127.0.0.1");
  try {
    if (request.method === "GET" && url.pathname === "/status") {
      reply(response, 200, {
        service: "seuss-blooket-bots",
        running: [...running.values()]
      }, origin);
      return;
    }
    if (request.method === "POST" && url.pathname === "/join") {
      const body = await readBody(request);
      reply(response, 200, start(String(body.code || "").trim(), body.count), origin);
      return;
    }
    reply(response, 404, { error: "not found" }, origin);
  } catch (error) {
    reply(response, 400, { error: error.message || String(error) }, origin);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("[bots] Blooket bot service on http://127.0.0.1:" + PORT);
  console.log("[bots] Open the arcade, type a room code, pick how many bots, press Start bots.");
  if (testUrl) console.log("[bots] Test mode: bots join " + testUrl);
});
