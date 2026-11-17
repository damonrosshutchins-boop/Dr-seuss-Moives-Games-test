// Runs the standalone bot runner against blooket-mock.html in headless Edge.
// The mock stands in for a live room: code screen, nickname, Blook grid, lobby
// and one question, so the whole join-and-answer flow is checked without a game.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CODE = "555123";
const BOTS = 2;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

const freePort = () => new Promise((resolve) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const port = await freePort();
const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const file = path.join(rootDir, decodeURIComponent(url.pathname));
  if (!file.startsWith(rootDir)) { response.writeHead(403).end("forbidden"); return; }
  try {
    const body = await readFile(file);
    response.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    response.end(body);
  } catch (error) {
    response.writeHead(404).end("not found");
  }
});
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
console.log(`mock game on :${port} · ${BOTS} bots · headless Edge`);

const output = [];
const exitCode = await new Promise((resolve) => {
  const child = spawn(process.execPath, [
    path.join(rootDir, "scripts", "blooket-bots.mjs"),
    "--code", CODE,
    "--count", String(BOTS),
    "--minutes", "1",
    "--url", `http://127.0.0.1:${port}/blooket-mock.html`
  ], { cwd: rootDir });
  const timer = setTimeout(() => child.kill(), 150000);
  child.stdout.on("data", (chunk) => { const text = String(chunk); output.push(text); process.stdout.write(text); });
  child.stderr.on("data", (chunk) => process.stdout.write(chunk));
  child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
});

server.close();
const log = output.join("");
const joined = (log.match(/joined — waiting for the host/g) || []).length;
const answered = (log.match(/answered "/g) || []).length;
const failures = [];
if (exitCode !== 0) failures.push(`runner exited with code ${exitCode}`);
if (!log.includes(`${BOTS} of ${BOTS} bots joined game ${CODE}`)) failures.push(`expected ${BOTS} bots to join game ${CODE}`);
if (answered < BOTS) failures.push(`expected ${BOTS} random answers, saw ${answered}`);

if (failures.length) {
  console.log("\nFAIL");
  for (const failure of failures) console.log("  · " + failure);
  process.exitCode = 1;
} else {
  console.log(`\nPASS — ${joined} bots joined the mock room and answered ${answered} questions at random`);
}
