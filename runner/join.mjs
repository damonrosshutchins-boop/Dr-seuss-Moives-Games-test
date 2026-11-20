// Seuss Arcade — the page-level join steps.
//
// Kept apart from the CLI so the probe can be exercised against a local fake
// join page in a test. Everything here takes { url, headless } as `config`;
// none of it reads CLI state.

import { setTimeout as sleep } from "node:timers/promises";

export async function visible(locator, ms) {
  try {
    await locator.waitFor({ state: "visible", timeout: ms });
    return true;
  } catch {
    return false;
  }
}

// React ignores a plain value assignment, so fill and then send the same input
// and change events the userscript dispatches.
export async function typeInto(locator, value) {
  try { await locator.click({ timeout: 5000 }); } catch { /* already focused */ }
  await locator.fill(value, { timeout: 8000 });
  await locator.evaluate((node) => {
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

export async function clickButton(page, pattern) {
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
export const CONSENT_TARGETS = [
  "button.cky-btn-reject",
  "button.cky-btn-accept",
  "button[aria-label=\"Reject All\"]",
  "button[aria-label=\"Accept All\"]",
];

export async function dismissConsent(page) {
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
    // No consent framework in the page at all: stop instead of waiting it out.
    const framework = await page.evaluate(() => !!document.querySelector("[class*=cky],[id*=cky]")).catch(() => false);
    if (!framework && attempt >= 3) return false;
    await page.waitForTimeout(400);
  }
  return false;
}

// The join forms submit through icon buttons with no text or accessible name,
// so match the submit control itself rather than its label.
export async function pressSubmit(page) {
  const submit = page.locator("form button[type=submit], form input[type=submit], button[type=submit], input[type=submit]").first();
  try {
    if (await submit.isVisible({ timeout: 1500 })) {
      await submit.click({ timeout: 3000 });
      return true;
    }
  } catch { /* no submit control on screen */ }
  return false;
}

export async function pageText(page) {
  try {
    return await page.evaluate(() => (document.body ? document.body.innerText : ""));
  } catch {
    return "";
  }
}

export async function firstLines(page) {
  const text = await pageText(page);
  return text.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 2).join(" ");
}

// Blooket's join form is a Next.js server action: the click becomes a POST to
// the page itself, and Cloudflare answers that POST with a challenge
// ("cf-mitigated: challenge", body "Just a moment...") when it does not trust
// the browser. The challenge is never rendered into the page, so it has to be
// caught on the response.
export const CHALLENGE_MESSAGE = "Cloudflare challenged the join POST; run --setup once to pass the check";
export const INTERSTITIAL = /just a moment|security verification|verify you are (a )?human|attention required/i;

// Failures carry a kind so setup can tell "Cloudflare stopped us" apart from
// "Blooket answered, just not with a lobby".
export function failure(kind, message) {
  const error = new Error(message);
  error.kind = kind;
  return error;
}

export function interstitialMessage(config) {
  return config.headless
    ? "Cloudflare served the \"Just a moment…\" interstitial to headless Chromium; rerun with --headful, or pass --setup once"
    : "Cloudflare served the \"Just a moment…\" interstitial; pass the check once with --setup";
}

// Tracks the join POST itself: whether anything answered it, with what status,
// and whether Cloudflare mitigated it. "No nickname box" has three very
// different causes — a challenge, an app-level refusal, or nothing answering at
// all — and only the response can tell them apart.
export function watchChallenge(page) {
  // Counters, not flags: the retry means one bot can produce two POSTs, and a
  // challenge seen on the first must survive a silent second.
  const state = { posts: 0, answered: 0, challenged: 0, lastStatus: 0, challengeStatus: 0 };
  page.on("response", (response) => {
    try {
      if (response.request().method() !== "POST") return;
      const status = response.status();
      state.posts += 1;
      state.lastStatus = status;
      if ((response.headers()["cf-mitigated"] || "").length > 0 || status === 403) {
        state.challenged += 1;
        state.challengeStatus = status;
      } else {
        state.answered += 1;
      }
    } catch { /* response gone */ }
  });
  return state;
}

// Cloudflare's interstitial often clears itself once its script has run, so a
// page that is still verifying gets a moment instead of an immediate failure.
export async function waitPastInterstitial(page, ms) {
  if (!(await challengedNow(page))) return true;
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await sleep(1500);
    if (!(await challengedNow(page))) return true;
  }
  return false;
}

export async function challengedNow(page) {
  try {
    const title = await page.title();
    const text = (await pageText(page)).slice(0, 400);
    return INTERSTITIAL.test(title + " " + text);
  } catch {
    return false;
  }
}

export const CODE_INPUT = 'input[placeholder*="game id" i], input[aria-label*="game id" i], input[placeholder*="code" i]';
export const NICK_INPUT = 'input[placeholder*="nick" i], input[aria-label*="nick" i], input[name*="name" i]';

export async function openJoin(page, code, timeout, config) {
  await page.goto(config.url, { waitUntil: "domcontentloaded", timeout });
  if (!(await waitPastInterstitial(page, Math.min(timeout, 45000)))) {
    throw failure("interstitial", interstitialMessage(config));
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
export async function enterCode(page, code, timeout, state, config) {
  await openJoin(page, code, timeout, config);
  const nickBox = page.locator(NICK_INPUT).first();
  const window = Math.min(timeout, 12000);
  if (await visible(nickBox, window)) return nickBox;

  // A challenged POST can still leave a clearance behind, so reload once and
  // submit again before deciding anything: Cloudflare's check is sometimes
  // satisfied by the very request it rejected. Nothing is reset, so the first
  // attempt's evidence outlives a silent retry.
  if (state && state.challenged > 0) {
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

  // Order matters: a challenge at any point outranks a silent retry, which is
  // the case that used to slip through as "inconclusive".
  if (state && state.challenged > 0) throw failure("challenge", CHALLENGE_MESSAGE + " (HTTP " + (state.challengeStatus || state.lastStatus) + ")");
  if (await challengedNow(page)) throw failure("interstitial", interstitialMessage(config));
  if (!state || state.answered === 0) throw failure("timeout", "nothing answered the join POST within " + window + " ms");
  throw failure("answer", (await firstLines(page)) || "no nickname box appeared — is the lobby still open for joining?");
}

export async function joinOne(page, code, name, timeout, state, config) {
  const nickBox = await enterCode(page, code, timeout, state, config);
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
// Verdicts are tri-state, because "no nickname box" is not proof of anything:
//   clear        — Blooket answered the join POST (nickname prompt or an
//                  app-level reply with a real status)
//   blocked      — Cloudflare answered instead: mitigated POST or interstitial
//   inconclusive — nothing answered inside the window; the check was not tested
export async function probeJoin(context, code, config, windowMs = 15000) {
  const page = await context.newPage();
  const state = watchChallenge(page);
  try {
    await enterCode(page, code, windowMs, state, config);
    if (state.answered === 0) {
      return { verdict: "inconclusive", message: "Inconclusive: the page reached Blooket and a nickname prompt appeared, but no join POST answer was observed, so the challenge was not proven either way." };
    }
    return {
      verdict: "clear",
      message: "Challenge is gone: Blooket answered the join POST with a nickname prompt for " + code + " (HTTP " + state.lastStatus + "). The probe stops there and submits no name.",
    };
  } catch (error) {
    const kind = error && error.kind ? error.kind : "answer";
    const detail = error && error.message ? error.message : String(error);
    if (kind === "challenge" || kind === "interstitial") {
      return { verdict: "blocked", message: "Cloudflare still stops the join: " + detail };
    }
    if (kind === "timeout" || state.answered === 0) {
      return {
        verdict: "inconclusive",
        message: "Inconclusive: " + detail + " — no answer to the join POST at all, so nothing was proven about the challenge. Try again, or pass the check in --setup.",
      };
    }
    if (kind === "answer") {
      return {
        verdict: "clear",
        message: "Challenge is gone: Blooket itself answered the join POST for " + code + " (HTTP " + state.lastStatus + " — " + detail + ").",
      };
    }
    // Anything else is the runner's own fault, not evidence about Cloudflare.
    // Claiming "clear" here once turned a ReferenceError into a pass.
    return { verdict: "inconclusive", message: "Inconclusive: the probe itself failed before it could judge the POST (" + detail + ")." };
  } finally {
    await page.close().catch(() => {});
  }
}

