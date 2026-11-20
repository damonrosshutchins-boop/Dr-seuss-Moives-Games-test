#!/usr/bin/env node
// Seuss Arcade — self-hosted Blooket bot runner.
//
// The userscript's join step, lifted out of a browser extension so it can live
// on an always-on machine instead of the browser you are sitting in front of.
// The steps, waits and selectors are the same as blooket-autojoin.user.js:
// dismiss the consent banner, type the game code, wait for the nickname box,
// type the name, submit, then read the page back to see whether it was refused.
//
//   node runner.mjs --code 1234567 --bots 3 \
//     --report https://seuss-arcade-relay.damonrosshutchins.workers.dev
//
// Options
//   --code <digits>   game code from the host screen (required)
//   --bots <n>        how many bots to join with (1-25, default 3)
//   --names a,b,c     fixed names; generated ones fill any gap
//   --report <url>    Worker base URL; posts status to <url>/bots/report
//   --headful         show the browser windows instead of running headless
//   --dry-run         report fake progress and never launch a browser
//   --spacing <ms>    pause between bots (default 1200, same as the userscript)
//   --timeout <ms>    how long each join step may take (default 30000)
//   --url <url>       join page to drive (default https://play.blooket.com/play)
//
// Blooket sits behind Cloudflare, so run this on a residential connection: a
// datacenter VPS is usually challenged long before a join happens.
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

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

async function visible(locator, ms) {
  try {
    await locator.waitFor({ state: "visible", timeout: ms });
    return true;
  } catch {
    return false;
  }
}

// React ignores a plain value assignment, so fill and then send the same input
// and change events the userscript dispatches.
async function typeInto(locator, value) {
  try { await locator.click({ timeout: 5000 }); } catch { /* already focused */ }
  await locator.fill(value, { timeout: 8000 });
  await locator.evaluate((node) => {
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function clickButton(page, pattern) {
  const button = page.getByRole("button", { name: pattern }).first();
  try {
    if (await button.isVisible({ timeout: 1200 })) {
      await button.click({ timeout: 3000 });
      return true;
    }
  } catch { /* no such button on screen */ }
  return false;
}

// Blooket uses CookieYes: the banner's buttons carry aria-label text and no
// visible label, and the banner lands a second or two after the page does.
const CONSENT_TARGETS = [
  "button.cky-btn-reject",
  "button.cky-btn-accept",
  "button[aria-label=\"Reject All\"]",
  "button[aria-label=\"Accept All\"]",
];

async function dismissConsent(page) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    for (const selector of CONSENT_TARGETS) {
      const button = page.locator(selector).first();
      try {
        if (await button.isVisible({ timeout: 300 })) {
          await button.click({ timeout: 3000 });
          await page.waitForTimeout(500);
          return true;
        }
      } catch { /* keep waiting for the banner */ }
    }
    await page.waitForTimeout(400);
  }
  return false;
}

// The join forms submit through icon buttons with no text or accessible name,
// so match the submit control itself rather than its label.
async function pressSubmit(page) {
  const submit = page.locator("form button[type=submit], form input[type=submit], button[type=submit], input[type=submit]").first();
  try {
    if (await submit.isVisible({ timeout: 1500 })) {
      await submit.click({ timeout: 3000 });
      return true;
    }
  } catch { /* no submit control on screen */ }
  return false;
}

async function pageText(page) {
  try {
    return await page.evaluate(() => (document.body ? document.body.innerText : ""));
  } catch {
    return "";
  }
}

async function firstLines(page) {
  const text = await pageText(page);
  return text.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 2).join(" ");
}

// Blooket's join form is a Next.js server action: the click becomes a POST to
// the page itself, and Cloudflare answers that POST with a challenge
// ("cf-mitigated: challenge", body "Just a moment...") when it does not trust
// the browser. The challenge is never rendered into the page, so it has to be
// caught on the response.
const CHALLENGE_MESSAGE = "Cloudflare challenged the join POST; run --setup once to pass the check";
const INTERSTITIAL = /just a moment|security verification|verify you are (a )?human|attention required/i;

// Failures carry a kind so setup can tell "Cloudflare stopped us" apart from
// "Blooket answered, just not with a lobby".
function failure(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

function interstitialMessage() {
  return args.headless
    ? "Cloudflare served the \"Just a moment…\" interstitial to headless Chromium; rerun with --headful, or pass --setup once"
    : "Cloudflare served the \"Just a moment…\" interstitial; pass the check once with --setup";
}

// Tracks the join POST itself: whether anything answered it, with what status,
// and whether Cloudflare mitigated it. "No nickname box" has three very
// different causes — a challenge, an app-level refusal, or nothing answering at
// all — and only the response can tell them apart.
function watchChallenge(page) {
  const state = { challenged: false, status: 0, postAnswered: false, postStatus: 0, postChallenged: false };
  page.on("response", (response) => {
    try {
      if (response.request().method() !== "POST") return;
      state.postAnswered = true;
      state.postStatus = response.status();
      if ((response.headers()["cf-mitigated"] || "").length > 0 || response.status() === 403) {
        state.postChallenged = true;
        state.challenged = true;
        state.status = response.status();
      }
    } catch { /* response gone */ }
  });
  return state;
}

// Cloudflare's interstitial often clears itself once its script has run, so a
// page that is still verifying gets a moment instead of an immediate failure.
async function waitPastInterstitial(page, ms) {
  if (!(await challengedNow(page))) return true;
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await sleep(1500);
    if (!(await challengedNow(page))) return true;
  }
  return false;
}

async function challengedNow(page) {
  try {
    const title = await page.title();
    const text = (await pageText(page)).slice(0, 400);
    return INTERSTITIAL.test(title + " " + text);
  } catch {
    return false;
  }
}

const CODE_INPUT = 'input[placeholder*="game id" i], input[aria-label*="game id" i], input[placeholder*="code" i]';
const NICK_INPUT = 'input[placeholder*="nick" i], input[aria-label*="nick" i], input[name*="name" i]';

async function openJoin(page, code, timeout) {
  await page.goto(args.url, { waitUntil: "domcontentloaded", timeout });
  if (!(await waitPastInterstitial(page, Math.min(timeout, 45000)))) {
    throw failure("interstitial", interstitialMessage());
  }
  await dismissConsent(page);
  // The join page asks for the code first; some builds skip straight to the
  // nickname box when the lobby is already known.
  const codeBox = page.locator(CODE_INPUT).first();
  if (await visible(codeBox, 8000)) {
    await typeInto(codeBox, code);
    await codeBox.press("Enter").catch(() => {});
    await clickButton(page, /submit|join|enter|next/i);
    await pressSubmit(page);
  }
}

// Types the game code and waits for the join POST to be answered. Returns the
// nickname field: a normal run fills it, a setup probe stops right there.
async function enterCode(page, code, timeout, state) {
  await openJoin(page, code, timeout);
  const nickBox = page.locator(NICK_INPUT).first();
  const window = Math.min(timeout, 12000);
  if (await visible(nickBox, window)) return nickBox;

  // A challenged POST can still leave a clearance behind, so reload once and
  // submit again before deciding anything: Cloudflare's check is sometimes
  // satisfied by the very request it rejected.
  if (state && state.postChallenged) {
    state.postChallenged = false;
    state.challenged = false;
    state.postAnswered = false;
    await page.reload({ waitUntil: "domcontentloaded", timeout }).catch(() => {});
    await waitPastInterstitial(page, 45000);
    await dismissConsent(page);
    const again = page.locator(CODE_INPUT).first();
    if (await visible(again, 8000)) {
      await typeInto(again, code);
      await again.press("Enter").catch(() => {});
      await clickButton(page, /submit|join|enter|next/i);
      await pressSubmit(page);
    }
    if (await visible(nickBox, window)) return nickBox;
  }

  if (state && state.postChallenged) throw failure("challenge", CHALLENGE_MESSAGE + " (HTTP " + state.status + ")");
  if (await challengedNow(page)) throw failure("interstitial", interstitialMessage());
  if (state && !state.postAnswered) throw failure("timeout", "nothing answered the join POST within " + window + " ms");
  throw failure("answer", (await firstLines(page)) || "no nickname box appeared — is the lobby still open for joining?");
}

async function joinOne(page, code, name, timeout, state) {
  const nickBox = await enterCode(page, code, timeout, state);
  await typeInto(nickBox, name.slice(0, 15));
  await sleep(300);
  if (!(await clickButton(page, /^join$|^submit$|^enter$|^play$/i))) {
    await nickBox.press("Enter").catch(() => {});
    await pressSubmit(page);
  }

  await sleep(2500);
  const after = await pageText(page);
  if (/already (taken|in use)|name (is )?taken|game (has )?(ended|closed)|not found/i.test(after)) {
    throw failure("refused", after.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 2).join(" "));
  }
  return "joined";
}

// Opens the persistent profile so a person can pass Cloudflare's check once.
// Readiness is the cf_clearance cookie, not the absence of the interstitial:
// the GET is usually fine and it is the join POST that gets challenged.
// Opens the persistent profile for a person to pass Cloudflare's check, then
// proves the clearance instead of trusting a cookie: one real join POST against
// the profile, classified by whatever answered it. A cookie can exist and still
// not be honoured, and the GET works even when the POST is challenged.
async function runSetup() {
  const { chromium } = await loadPlaywright();
  args.headless = false; // setup and probe always open a real window
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
    const verdict = await probeJoin(context, probeCode);
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

// One join POST, judged by its answer: a nickname prompt or an app-level reply
// means Cloudflare let it through; a challenge means it did not.
// Verdicts are tri-state, because "no nickname box" is not proof of anything:
//   clear        — Blooket answered the join POST (nickname prompt or an
//                  app-level reply with a real status)
//   blocked      — Cloudflare answered instead: mitigated POST or interstitial
//   inconclusive — nothing answered inside the window; the check was not tested
async function probeJoin(context, code, windowMs = 15000) {
  const page = await context.newPage();
  const state = watchChallenge(page);
  try {
    await enterCode(page, code, windowMs, state);
    if (!state.postAnswered) {
      return { verdict: "inconclusive", message: "Inconclusive: the page reached Blooket and a nickname prompt appeared, but no join POST answer was observed, so the challenge was not proven either way." };
    }
    return {
      verdict: "clear",
      message: "Challenge is gone: Blooket answered the join POST with a nickname prompt for " + code + " (HTTP " + state.postStatus + "). The probe stops there and submits no name.",
    };
  } catch (error) {
    const kind = error && error.kind ? error.kind : "answer";
    const detail = error && error.message ? error.message : String(error);
    if (kind === "challenge" || kind === "interstitial") {
      return { verdict: "blocked", message: "Cloudflare still stops the join: " + detail };
    }
    if (kind === "timeout" || !state.postAnswered) {
      return {
        verdict: "inconclusive",
        message: "Inconclusive: " + detail + " — no answer to the join POST at all, so nothing was proven about the challenge. Try again, or pass the check in --setup.",
      };
    }
    return {
      verdict: "clear",
      message: "Challenge is gone: Blooket itself answered the join POST for " + code + " (HTTP " + state.postStatus + " — " + detail + ").",
    };
  } finally {
    await page.close().catch(() => {});
  }
}

// Same probe without waiting for a clearance: for checking a profile quickly.
async function runProbe() {
  const { chromium } = await loadPlaywright();
  args.headless = false; // setup and probe always open a real window
  const probeCode = /^\d{4,8}$/.test(args.code) ? args.code : "000000";
  console.log("Probing profile " + args.profile + " with one join POST for " + probeCode + "…");
  const context = await chromium.launchPersistentContext(args.profile, { headless: false, channel: args.channel || undefined, viewport: { width: 900, height: 900 } });
  try {
    const verdict = await probeJoin(context, probeCode);
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

let args;

async function main() {
  args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(USAGE);
  // Setup and probe run before the code check: passing the check needs no game
  // code, and any code given is only used to pick the probe.
  if (args.setup) return runSetup();
  if (args.probe) return runProbe();
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
          await joinOne(page, args.code, name, args.timeout, state);
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
