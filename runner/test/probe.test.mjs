// Verdict tests for the probe, against the local fake join page.
//
//   node --test test/
//
// The blocked case is the one that actually fired against Blooket; clear and
// inconclusive are produced here so they are not guesses.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { probeJoin } from "../join.mjs";
import { startFakeJoin } from "./fake-join.mjs";

const WINDOW = 5000;
const CODE = "1234567";

async function verdictFor(mode) {
  const server = await startFakeJoin();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const url = server.url + "?mode=" + mode;
    return await probeJoin(context, CODE, { url, headless: true }, WINDOW);
  } finally {
    await browser.close();
    server.close();
  }
}

test("clear: an answered POST that asks for a nickname", async () => {
  const verdict = await verdictFor("clear");
  assert.equal(verdict.verdict, "clear");
  assert.match(verdict.message, /nickname prompt/);
});

test("clear: an app-level answer still proves the challenge is gone", async () => {
  const verdict = await verdictFor("app");
  assert.equal(verdict.verdict, "clear");
  assert.match(verdict.message, /Game not found/);
});

test("blocked: a challenged POST", async () => {
  const verdict = await verdictFor("blocked");
  assert.equal(verdict.verdict, "blocked");
  assert.match(verdict.message, /Cloudflare/);
});

test("blocked: a challenged first attempt survives a silent retry", async () => {
  // The regression: the retry resets the old flags, so the silent second POST
  // used to be reported as inconclusive even though the join was challenged.
  const verdict = await verdictFor("blocked-then-quiet");
  assert.equal(verdict.verdict, "blocked");
  assert.match(verdict.message, /Cloudflare/);
});

test("inconclusive: no answer to the join POST at all", async () => {
  const verdict = await verdictFor("quiet");
  assert.equal(verdict.verdict, "inconclusive");
  assert.match(verdict.message, /nothing was proven/i);
});

test("inconclusive: the probe's own failure is not a pass", async () => {
  // Extracting the page logic once dropped the sleep import, and the resulting
  // ReferenceError was reported as "Challenge is gone". An internal error must
  // never read as proof.
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const verdict = await probeJoin(context, CODE, { url: "http://127.0.0.1:1/play", headless: true }, 3000);
    assert.equal(verdict.verdict, "inconclusive");
    assert.doesNotMatch(verdict.message, /Challenge is gone/);
  } finally {
    await browser.close();
  }
});
