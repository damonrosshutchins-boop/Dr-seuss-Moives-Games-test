#!/usr/bin/env node
// Seuss Arcade — self-hosted Blooket bot runner.
//
// This file is the command line: flags, naming, progress reporting, and the
// browser session. The page steps themselves live in join.mjs, because the test
// drives them directly.
//
//   node runner.mjs --code 1234567 --bots 3 \
//     --report https://seuss-arcade-relay.damonrosshutchins.workers.dev
//
//   node runner.mjs --help      every flag
//   node runner.mjs --setup     pass Cloudflare's check once, then prove it
//
// Blooket sits behind Cloudflare, so run this on a residential connection: a
// datacenter VPS is usually challenged long before a join happens.
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { joinOne, probeJoin, watchChallenge } from "./join.mjs";

const DEFAULT_PROFILE = fileURLToPath(new URL("./.profile", import.meta.url));

const ADJECTIVES = ["swift", "quiet", "brave", "clever", "lucky", "wild", "calm", "sharp", "sunny", "rapid", "frosty", "noble", "merry", "bold", "sly", "vivid", "gentle", "cosmic", "zesty", "misty"];
const NOUNS = ["Otter", "Falcon", "Panda", "Tiger", "Koala", "Raven", "Lynx", "Bison", "Heron", "Yak", "Gecko", "Moth", "Wombat", "Crane", "Badger", "Ferret", "Quokka", "Tapir", "Marmot", "Puffin"];
const MAX_BOTS = 25;

const USAGE = `Seuss Arcade bot runner

  node runner.mjs --code 1234567 [--bots 3] [--names a,b] [--report <worker-url>]
                  [--headful] [--dry-run] [--spacing 1200] [--timeout 30000]

  --code      game code from the host screen (4-8 digits, required)
  --bots      how many bots join (1-${MAX_BOTS}, default 3)
  --names     comma-separated names; the rest are generated
  --report    Worker base URL; each bot's state is posted to <url>/bots/report
  --headful   show the browser windows
  --dry-run   post fake progress without launching a browser
  --profile   browser profile directory (default ./runner/.profile)
  --setup     pass Cloudflare's check once, then prove it with a real join POST
  --probe     check the current profile with one join POST, without waiting
  --channel   use an installed browser: chrome, msedge (default: bundled Chromium)`;

function parseArgs(argv) {
  const args = {
    code: "", bots: 3, names: [], report: "", headless: true,
    dryRun: false, spacing: 1200, timeout: 30000, setup: false, probe: false, channel: "",
    profile: DEFAULT_PROFILE,
    url: "https://play.blooket.com/play", help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => argv[++i];
    if (flag === "--code") args.code = String(value() || "").trim();
    else if (flag === "--bots") args.bots = Math.max(1, Math.min(MAX_BOTS, Number(value()) || 1));
    else if (flag === "--names") args.names = String(value() || "").split(",").map((name) => name.trim()).filter(Boolean);
    else if (flag === "--report") args.report = String(value() || "").replace(/\/+$/, "");
    else if (flag === "--url") args.url = String(value() || args.url);
    else if (flag === "--headful") args.headless = false;
    else if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--setup") args.setup = true;
    else if (flag === "--probe") args.probe = true;
    else if (flag === "--channel") args.channel = String(value() || "").trim();
    else if (flag === "--profile") args.profile = String(value() || args.profile);
    else if (flag === "--spacing") args.spacing = Math.max(0, Number(value()) || 0);
    else if (flag === "--timeout") args.timeout = Math.max(5000, Number(value()) || 30000);
    else if (flag === "--help" || flag === "-h") args.help = true;
    else if (flag.startsWith("-")) throw new Error("Unknown option: " + flag);
  }
  return args;
}

// Same name rules as the panel: unique, 15 characters, generated to fill gaps.
function planNames(args) {
  const chosen = [];
  const seen = new Set();
  for (const raw of args.names) {
    const name = String(raw).trim().slice(0, 15);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    chosen.push(name);
    if (chosen.length >= args.bots) return chosen;
  }
  while (chosen.length < args.bots) {
    const name = (ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)] + NOUNS[Math.floor(Math.random() * NOUNS.length)]).slice(0, 15);
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    chosen.push(name);
  }
  return chosen;
}

async function post(args, payload) {
  if (!args.report) return;
  try {
    const response = await fetch(args.report + "/bots/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, code: args.code }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) console.warn("  report rejected: HTTP " + response.status);
  } catch (error) {
    console.warn("  report failed: " + (error && error.message ? error.message : error));
  }
}

// Opens the persistent profile for a person to pass Cloudflare's check, then
// proves the clearance instead of trusting a cookie: one real join POST against
// the profile, classified by whatever answered it. A cookie can exist and still
// not be honoured, and the GET works even when the POST is challenged.
async function runSetup(args) {
  const { chromium } = await loadPlaywright();
  // Setup and the probe always open a real window, whatever the flags say.
  const live = { url: args.url, headless: false };
  const probeCode = /^\d{4,8}$/.test(args.code) ? args.code : "000000";
  console.log("Profile: " + args.profile);
  const context = await chromium.launchPersistentContext(args.profile, { headless: false, channel: args.channel || undefined, viewport: { width: 900, height: 900 } });
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    console.log("In that window: enter a game code and press join once, so Cloudflare issues a clearance.\nWaiting up to five minutes for a cf_clearance cookie…");
    let cleared = false;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      await sleep(2000);
      const cookies = await context.cookies("https://play.blooket.com").catch(() => []);
      if (cookies.some((cookie) => cookie.name === "cf_clearance")) { cleared = true; break; }
    }
    console.log(cleared
      ? "Clearance cookie found. Proving it with one real join POST for " + probeCode + "…"
      : "No cf_clearance cookie appeared. Probing anyway to see what actually answers…");
    const verdict = await probeJoin(context, probeCode, live);
    console.log(verdict.message);
    if (verdict.verdict === "clear") {
      console.log("Setup succeeded: the profile is ready, and runs will reuse it until the clearance expires.");
    } else {
      if (verdict.verdict === "inconclusive") console.log("Not proven yet, so setup is not claiming success. Run --probe again, or pass the check again.");
      process.exitCode = 1;
    }
  } finally {
    await context.close();
  }
}

// The same probe without waiting for a clearance, for checking a profile fast.
async function runProbe(args) {
  const { chromium } = await loadPlaywright();
  const live = { url: args.url, headless: false };
  const probeCode = /^\d{4,8}$/.test(args.code) ? args.code : "000000";
  console.log("Probing profile " + args.profile + " with one join POST for " + probeCode + "…");
  const context = await chromium.launchPersistentContext(args.profile, { headless: false, channel: args.channel || undefined, viewport: { width: 900, height: 900 } });
  try {
    const verdict = await probeJoin(context, probeCode, live);
    console.log(verdict.message);
    if (verdict.verdict !== "clear") process.exitCode = 1;
  } finally {
    await context.close();
  }
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    console.error("Playwright is not installed here.\n  cd runner && npm install && npx playwright install chromium");
    process.exit(3);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(USAGE);
  // Setup and probe run before the code check: passing the check needs no game
  // code, and any code given is only used to pick the probe.
  if (args.setup) return runSetup(args);
  if (args.probe) return runProbe(args);
  if (!/^\d{4,8}$/.test(args.code)) {
    console.error("--code must be the 4-8 digit game code from the host screen\n\n" + USAGE);
    process.exitCode = 2;
    return;
  }

  const names = planNames(args);
  console.log("Seuss Arcade bot runner · game " + args.code + " · " + names.length + (names.length === 1 ? " bot" : " bots") +
    (args.report ? " · reporting to " + args.report : " · terminal only") + (args.dryRun ? " · dry run" : ""));
  if (!args.dryRun && args.headless) {
    console.log("Headless mode: Cloudflare often serves its \"Just a moment…\" interstitial to headless Chromium. If a bot fails with that, rerun with --headful.");
  }
  await post(args, { event: "start", total: names.length, names });

  const results = [];
  let failures = 0;

  if (args.dryRun) {
    for (const name of names) {
      await post(args, { event: "bot", name, state: "joining" });
      console.log("  " + name + " · joining");
      await sleep(300);
      await post(args, { event: "bot", name, state: "joined" });
      console.log("  " + name + " · joined (dry run)");
      results.push(name + ": joined (dry run)");
      await sleep(Math.min(args.spacing, 200));
    }
  } else {
    const { chromium } = await loadPlaywright();
    // One persistent profile for every bot: Cloudflare's clearance is per
    // browser session, so a check passed once covers all of them instead of
    // each fresh context being challenged again.
    const context = await chromium.launchPersistentContext(args.profile, {
      headless: args.headless,
      channel: args.channel || undefined,
      viewport: { width: 560, height: 820 },
    });
    try {
      for (const name of names) {
        await post(args, { event: "bot", name, state: "joining" });
        console.log("  " + name + " · joining");
        const page = await context.newPage();
        const state = watchChallenge(page);
        try {
          await joinOne(page, args.code, name, args.timeout, state, args);
          results.push(name + ": joined");
          await post(args, { event: "bot", name, state: "joined" });
          console.log("  " + name + " · joined");
        } catch (error) {
          failures += 1;
          const detail = (error && error.message ? error.message : String(error)).split("\n")[0].slice(0, 160);
          results.push(name + ": " + detail);
          await post(args, { event: "bot", name, state: "failed", detail });
          console.log("  " + name + " · failed — " + detail);
        }
        await page.close();
        await sleep(args.spacing);
      }
    } finally {
      await context.close();
    }
  }

  await post(args, { event: "done", total: names.length, results });
  console.log("\n" + results.join("\n"));
  if (failures) process.exitCode = 1;
}

process.on("SIGINT", () => {
  console.log("\nStopped.");
  process.exit(130);
});

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
