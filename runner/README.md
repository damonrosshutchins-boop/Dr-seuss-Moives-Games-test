# Bot runner (self-hosted)

Drives Blooket's join page with Playwright so the bots do not need a browser
extension or userscript on the machine you are actually sitting at. Same join
steps, waits and selectors as `../blooket-autojoin.user.js`, moved into a script
so it can run on an always-on box at home.

Run it for your own games. Blooket's terms prohibit automated play and bots, so
the risk lands on whichever account and connection runs them — that is why this
sits on a machine you control, on a residential connection, and is not a hosted
service.

## 1 · Prepare the machine

Any always-on computer at home works: an old laptop, a mini PC, a Raspberry Pi 4/5.

- **Node.js 20 or newer** — `node -v` should print v20 or higher.
- **A residential connection.** Blooket is behind Cloudflare; datacenter IPs are
  usually challenged before a join even starts, so a VPS is the wrong host.
- Nothing else. No Blooket login is used — the bots join as guests.

## 2 · Install

```bash
cd runner
npm install
npx playwright install chromium      # downloads the browser (~150 MB, once)
```

On a fresh Debian/Ubuntu box you may also need Playwright's system libraries:

```bash
npx playwright install-deps chromium
```

## 3 · Check it without touching Blooket

```bash
node runner.mjs --code 1234567 --bots 3 --dry-run \
  --report https://seuss-arcade-relay.damonrosshutchins.workers.dev
```

That posts fake progress to the Worker board. Open the arcade, press
**Watch runner**, enter `1234567`, and the rows should appear — proof the phone
or laptop you are browsing from can see the home machine's runs.

## 3b · Pass Cloudflare once (required for real joins)

Blooket's join form is a Next.js server action: pressing join becomes a `POST`
to the page itself, and Cloudflare challenges that POST (`cf-mitigated:
challenge`, a "Just a moment…" body) when it does not trust the browser. The
page still renders, so the failure looks like "the form does nothing" unless
you read the response.

Clear it once, in the profile the runner reuses:

```bash
node runner.mjs --setup
```

A browser window opens on the machine. Enter a game code and press join once, so
Cloudflare issues a `cf_clearance` cookie, then leave the window alone. The
runner waits for the cookie, then **proves it** with one real join POST for the
code you passed (or `000000` if none) and prints one of:

- `Challenge is gone: Blooket answered the join POST with a nickname prompt for
  607323` — the profile is ready. The probe stops there without submitting a name.
- `Challenge is gone: Blooket itself answered the join POST … (Game not found)` —
  still good: the request reached the app, which is all the clearance has to prove.
- `Cloudflare still stops the join: …` — the cookie exists but is not honoured;
  exit code 1, and the profile is not ready.

It probes even when no cookie appeared, so the answer is what actually happens
rather than what the cookie suggests. Real runs reopen the same profile
(`./runner/.profile` by default, `--profile <dir>` to move it), so one cleared
session covers every bot until the clearance expires.

This reuses a session a person cleared. It is not a stealth patch: if the
challenge keeps coming back, the machine or the connection is being scored as a
bot, and the answer is a different connection, not another workaround.

Headless runs print a warning up front, and a bot that actually gets the
interstitial fails with `Cloudflare served the "Just a moment…" interstitial to
headless Chromium; rerun with --headful` — the same request succeeds in a
headful window, so the mode is named in the error instead of leaving you to
guess.

## 4 · Run a real game

```bash
node runner.mjs --code 1234567 --bots 5 \
  --report https://seuss-arcade-relay.damonrosshutchins.workers.dev
```

Every bot gets its own tab in one shared profile. A `failed — Cloudflare
challenged the join POST` row means the clearance has expired: run `--setup`
again.

Add `--headful` to watch the windows on the machine itself, `--names a,b,c` to
fix the names, `--spacing 2000` if the lobby rejects joins that arrive too fast.
Exit code is `0` when every bot joined and `1` when any failed.

## 5 · Keep it running

The runner is a one-shot command per game, because a Blooket code only lives as
long as the lobby. Start it when the host opens the lobby, from the machine or
over SSH.

**systemd** (Linux, `/etc/systemd/system/seuss-bots.service`) — start it per game:

```ini
[Unit]
Description=Seuss Arcade bot runner
After=network-online.target

[Service]
Type=oneshot
User=pi
WorkingDirectory=/home/pi/seuss/runner
ExecStart=/usr/bin/node runner.mjs --code 1234567 --bots 5 --report https://seuss-arcade-relay.damonrosshutchins.workers.dev
TimeoutStartSec=900
```

```bash
sudo systemctl start seuss-bots     # run one game
journalctl -u seuss-bots -f         # watch it
```

**Windows Task Scheduler** — create a task, trigger *On demand*, action
*Start a program* with `node`, arguments as above, and *Start in*
`C:\path\to\runner`.

**cron** (Linux) — for a fixed class slot, e.g. every weekday at 09:55:

```cron
55 9 * * 1-5 cd /home/pi/seuss/runner && /usr/bin/node runner.mjs --code 1234567 --bots 5 --report https://seuss-arcade-relay.damonrosshutchins.workers.dev >> bot.log 2>&1
```

## Watching from anywhere

Every state change is a `POST` to `<report>/bots/report`:

```json
{ "code": "1234567", "event": "bot", "name": "swiftOtter", "state": "joined" }
```

`event` is `start` (with `names` and `total`), `bot` (`state` is `armed`,
`joining`, `joined` or `failed`, plus `detail`) or `done`. The Worker stores the
board in a Durable Object and the panel reads it back with
`GET /bots/status?code=1234567`, so any device that can open the arcade sees the
same rows. Boards untouched for six hours are forgotten.

## When Blooket changes its page

The selectors live in `joinOne()` — `input[placeholder*="code"]` for the game
code, `input[placeholder*="nick"]` for the nickname, and the button text patterns
next to them. If joins start failing with "no nickname box appeared", open the
join page in a normal browser, check what the box is called now, and update those
two locators. The userscript uses the same selectors, so fix both.
