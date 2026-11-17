// Local bridge for the site's Blooket panel.
//
// The page cannot drive Blooket itself (cross-origin), so the panel posts the
// game code to this tiny server and it runs the ordinary bot runner: real
// browser profiles, straight to play.blooket.com, random answers. No Wisp
// relay, no in-page proxy.
//
//   npm run bots:bridge
//
// BOTS_URL is a test seam: point it at a stand-in page to exercise the panel
// without a live game.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || process.env.BOTS_BRIDGE_PORT || 8788);
// Loopback by default so nothing outside this computer can reach it. A host
// sets BOTS_HOST=0.0.0.0 (and a token) to serve the arcade site instead.
const HOST = process.env.BOTS_HOST || "127.0.0.1";
const TOKEN = (process.env.BOTS_TOKEN || "").trim();
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runner = path.join(rootDir, "scripts", "blooket-bots.mjs");
const allowedOrigins = new Set([
  "https://damonrosshutchins-boop.github.io",
  ...(process.env.BOTS_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean)
]);

let current = null;
// Served from this origin so the page can start bots even when the browser
// refuses to let the public arcade page reach a local server.
const pagePath = path.join(rootDir, "scripts", "bots-bridge-page.html");
const panelHtml = () => readFileSync(pagePath);

function reply(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

const server = createServer((request, response) => {
  const origin = request.headers.origin;
  // Any page on this computer may call the bridge, but a remote site needs to be
  // listed: otherwise every website could start bots for a game code.
  if (origin) {
    const own = origin.startsWith("http://127.0.0.1:") || origin.startsWith("http://localhost:");
    if (!own && !allowedOrigins.has(origin)) {
      reply(response, 403, { error: "origin not allowed" });
      return;
    }
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-headers", "content-type, x-bots-token");
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    // Chromium asks for explicit consent before a public page may talk to a
    // loopback server; without this header the request never leaves the page.
    response.setHeader("access-control-allow-private-network", "true");
    response.setHeader("vary", "origin");
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }

  const url = new URL(request.url || "/", "http://127.0.0.1");
  // A public host must not let anyone start bots: the site sends this token.
  if (TOKEN && (url.pathname === "/bots" || url.pathname === "/stop")) {
    if (String(request.headers["x-bots-token"] || "").trim() !== TOKEN) {
      reply(response, 401, { error: "access token missing or wrong" });
      return;
    }
  }
  if ((url.pathname === "/" || url.pathname === "/index.html") && request.method === "GET") {
    try {
      const body = panelHtml();
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-length": body.length });
      response.end(body);
    } catch (error) {
      reply(response, 500, { error: "the panel page is missing: " + pagePath });
    }
    return;
  }
  if (url.pathname === "/health") {
    reply(response, 200, { ok: true, running: !!current, code: current ? current.code : "" });
    return;
  }
  if (url.pathname === "/stop" && request.method === "POST") {
    if (!current) {
      reply(response, 200, { stopped: false, reason: "nothing is running" });
      return;
    }
    const code = current.code;
    try { current.child.kill(); } catch (error) { /* already gone */ }
    current = null;
    reply(response, 200, { stopped: true, code });
    return;
  }
  if (url.pathname !== "/bots" || request.method !== "POST") {
    reply(response, 404, { error: "not found" });
    return;
  }

  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
    if (body.length > 4096) request.destroy();
  });
  request.on("end", () => {
    let input;
    try { input = JSON.parse(body || "{}"); } catch (error) { reply(response, 400, { error: "bad request" }); return; }

    const code = String(input.code || "").trim();
    const count = Math.max(1, Math.min(30, Number(input.count) || 1));
    const minutes = Math.max(1, Math.min(180, Number(input.minutes) || 20));
    const names = Array.isArray(input.names)
      ? input.names.map((name) => String(name).trim().slice(0, 20)).filter(Boolean).slice(0, count)
      : [];
    if (!/^\d{4,8}$/.test(code)) {
      reply(response, 400, { error: "the game code must be 4 to 8 digits" });
      return;
    }
    if (current) {
      reply(response, 409, { error: "bots are already running for game " + current.code });
      return;
    }

    const args = [runner, "--code", code, "--count", String(count), "--minutes", String(minutes)];
    if (names.length) args.push("--names", names.join(","));
    if (process.env.BOTS_URL) args.push("--url", process.env.BOTS_URL);

    console.log(`\nstarting ${count} bot${count === 1 ? "" : "s"} for game ${code}`);
    const child = spawn(process.execPath, args, { cwd: rootDir, stdio: "inherit" });
    current = { code, count, child };
    child.on("exit", (exitCode) => {
      console.log(`game ${code} runner finished with code ${exitCode}`);
      if (current && current.child === child) current = null;
    });
    reply(response, 202, { started: true, code, count, names });
  });
});

server.listen(PORT, HOST, () => {
  const shown = HOST === "0.0.0.0" ? "port " + PORT : "http://127.0.0.1:" + PORT;
  console.log("Blooket bot bridge ready on " + shown);
  if (HOST === "0.0.0.0") {
    console.log("Add this address (with BOTS_TOKEN) to the arcade site under Settings -> Bot program address.");
    if (!TOKEN) console.log("Warning: no BOTS_TOKEN is set, so anyone who finds this address can start bots.");
  } else {
    console.log("Open http://127.0.0.1:" + PORT + "/ to send bots, or press Send bots on the arcade page.");
  }
});
