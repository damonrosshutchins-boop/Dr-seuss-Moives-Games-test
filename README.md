# Seuss Cinema & Arcade

A curated movies-and-games dashboard with an embedded Scramjet 2.x player.

## GitHub Pages deployment

GitHub Actions builds the browser assets into `dist/` and deploys them to GitHub Pages on pushes to `main`.

1. In **Settings → Pages**, set **Build and deployment → Source** to **GitHub Actions**.
2. Check **Actions → Deploy Cinema Arcade to GitHub Pages** to see build/deploy results.
3. Visit https://damonrosshutchins-boop.github.io/Dr-seuss-Moives-Games-test/

The static site serves the Scramjet worker under the GitHub Pages repository path. Its Libcurl transport connects to the separately hosted Cloudflare endpoint:
`wss://seuss-arcade-relay.damonrosshutchins.workers.dev/wisp/`.

GitHub Pages cannot run a Wisp server or stream game files, so proxied pages and every pinned game route depend on the Cloudflare Worker below. Existing origin checks and destination restrictions are enforced inside the Worker.

## Cloudflare deployment

Everything that used to run on Render now runs on one Cloudflare Worker in
`cloudflare/arcade/`:

- `worker.mjs` serves `/approved-assets/*` and `/approved-games/*` from the same
  pinned, path-restricted upstreams the Node service used, plus the Wisp v1 relay
  on `/wisp/` (Durable Object over `cloudflare:sockets`).
- `wrangler.jsonc` holds the Durable Object binding and the origin policy
  (`ALLOWED_ORIGINS`, `ALLOW_PRIVATE_IPS`, `ALLOW_DIRECT_IP`).

```bash
cd cloudflare/arcade
npm install
npx wrangler deploy
```

The deployed URL is `https://seuss-arcade-relay.damonrosshutchins.workers.dev`;
`/health` reports liveness and `/wisp/` is the relay endpoint. The Pages workflow
deploys the Worker too when a `CLOUDFLARE_API_TOKEN` secret is configured.
`server.mjs` and `render.yaml` stay in the repository as the older local Node
server, but the published arcade no longer calls Render, and
`scripts/check-arcade-routing.mjs` fails the build if a `*.onrender.com` URL
returns.

## Compatibility

Service worker interception, content security policies, cross-origin isolation, and some game/video sites' embedded resources may cause incompatibilities. A successful build is **not** proof that each game or movie plays successfully. Only use media sources you have permission to access. This does not circumvent DRM or subscription requirements.



## Minecraft 26.3 Rust / Horizon

Selecting Minecraft 26.3 Rust (Horizon) in the Arcade automatically launches
the bundled standalone game, without requiring a user to import an HTML file.
The 45.6 MB authorized source file is committed as 12 versioned text chunks under
`games/horizon/parts/`. The Pages build reconstructs the exact
source bytes, verifies the supplied SHA-256 hash, and publishes
`games/horizon/play.html` (the chunks themselves are not published).
The separate loader installs a game-scoped service worker and navigates into
the same-site game page; this enables cross-origin isolation on GitHub Pages.
The game uses the browser's WebGPU runtime and local save storage.

Default play skips the game's ~355 MB optional sound archive.
The optional sound mode requests only pinned `parts.json` and 18 fixed
numbered sound chunks via the existing Cloudflare service:
`https://seuss-arcade-relay.damonrosshutchins.workers.dev/approved-games/horizon/`.
The server-side restriction does not permit arbitrary URL fetches.

Build success does not guarantee playability on every WebGPU device.


## God of War: Ghost of Sparta (recompiled build published from this site)

The owner-supplied PSP build at `https://psp-web-damon.surge.sh/` is published
from this site under `games/gow-sparta/`: `index.html`, `index.js`,
`index.wasm.gz`, `index.data.gz`, `coi-serviceworker.js` and `gow-boot.js`,
about 14 MB in
total. The Arcade card opens `games/gow-sparta/index.html` in its own tab, so the
page is top-level and its service worker can answer with COOP/COEP and make it
cross-origin isolated; the recompiled game needs that for `SharedArrayBuffer`.
No file in the page points at the relay, so the address bar stays on this site.
`gow-boot.js` decompresses both archives itself when the browser has no
`DecompressionStream` (Firefox before 113), so the uncompressed `index.wasm` and
`index.data` variants (about 105 MB) are still not published, to stay inside the
GitHub Pages size limit.

The page also fails visibly instead of showing a black screen: when
`crossOriginIsolated` is false it draws a message explaining that the game needs
a normal window, because the isolation comes from a service worker that a
private window cannot keep. Firefox below 139 hides `navigator.serviceWorker`
there, and 139 and later expose it with nothing registered, so the check asks for
the registrations rather than trusting the object; when a worker is registered
but the page is still not isolated, the message says the COOP/COEP headers were
stripped in front of the site instead.

The copy above was taken once from the Surge source, and the published build no
longer contacts it. The relay keeps no PSP route now: `cloudflare/arcade/worker.mjs`
has no `gow-sparta` handler, rewrite or status probe, and the `audit-psp.yml`
workflow that tested that route was removed with it. A later change to this game
is a plain file copy into `games/gow-sparta/`.


## Rocket League (single-file shell, game data streamed from its own host)

The owner-supplied Google Drive file (`single-file.html`, 458 KB) is published as
`games/rocket-legue/index.html`, with `coi-serviceworker.js` and `rl-boot.js`
copied beside it and two lines added to its `<head>` that load them. The file is only the
engine shell: its wasm, file index and 16 MB data blocks are fetched at play time
from `https://rocket-league-dhl.pages.dev/assets/`, which answers with
`Access-Control-Allow-Origin: *`, so no multi-gigabyte game data enters the Pages
artifact. The build uses real wasm threads, so the card opens the page in this tab
(`needsIsolation`) and the scoped worker answers with COOP/COEP; the page reloads
once and becomes `crossOriginIsolated`. The port needs WebGPU, `memory64` and
JSPI, so it runs in Chrome or Edge 137 and later and shows its own message on
older browsers. First open downloads several GB.

When the page cannot become cross-origin isolated it used to leave only a small
status line on a black screen. `rl-boot.js` reuses the God of Sparta failure card
and its wording: it says the game needs a normal window, because the isolation
comes from a service worker that a private window cannot keep, and it asks for the
registered workers rather than trusting `navigator.serviceWorker`, which Firefox
139 and later also expose in private windows. A worker that is registered while
the page is still not isolated is reported as stripped COOP/COEP headers instead.


## Minecraft 1.8 Wrust Mod and Minecraft 1.8 Mods

These two entries are added as separate Minecraft 1.8 Eaglercraft-style games in
the Arcade. Clicking a card opens a same-site launcher, which checks Cloudflare and
then navigates in the same tab to a **fixed** Cloudflare URL. No visitor-provided
proxy destination, arbitrary Google Drive ID, or arbitrary CDN path is accepted.

- **Minecraft 1.8 Wrust Mod:** the public Google Drive file
  `clwurst.html` (27,847,113 bytes), fixed ID
  `1TBtrBMMw9w9lqc3Z3aw4CARG_O04abIM`. The offline HTML is streamed
  through `/approved-games/minecraft-18-wrust/index.html` on Cloudflare.
- **Minecraft 1.8 Mods:** the public Google Drive file
  `cleaglerforge.html` (1,035 bytes), fixed ID
  `17mqNnsALl6ZvDVOtarz4EuP5pS8E4-R9`. Its four hardcoded CDN
  downloads are rewritten to the four Cloudflare routes
  `/approved-games/minecraft-18-mods/assets/forge-part1` to
  `forge-part4`. The server obtains those parts from a pinned GitHub
  revision and does not accept unapproved hostnames. The four files total
  about 79 MB.

The approved game **files** are delivered through Cloudflare. The original
EaglercraftX client also contains external multiplayer relay addresses and
links; these are **not** implicitly proxied or whitelisted. External network
multiplayer may use direct game server connections or may be unavailable.
Successful deployment verifies the routes, not gameplay or compatibility.


## Gamble With Your Friends (camzzz solo web port)

The Arcade card opens `games/gamble-with-your-friends/index.html` in the in-site
player, so the browser stays on this website. The Pages build publishes an ~8 KB
entry page whose loader, framework, addressables and all 69 split parts are
absolute URLs on the fixed Cloudflare route; the bytes come from Cloudflare while the
page itself stays on the Pages origin. The game is a
Unity WebGL build of about 1.2 GB, committed upstream as 69 fixed parts
(50 `chunks/build.data.partNNN` and 19 `chunks/build.wasm.partNNN`) plus its
loader, framework, addressables catalog and localization bundles.

`server.mjs` serves only those exact file shapes, only from the single pinned
commit `d7b3ac61ce6d2cb98e212dfa01ba0df413539a53` of
`Camzzz-vrgt/gamble-with-your-friends-web` (jsDelivr primary, GitHub raw
fallback). Visitors cannot supply a host, URL, path or redirect. Byte ranges are
passed through because the parts are large, and
`/approved-games/gamble-with-your-friends/status` reports whether the source is
reachable.

Network audit: a live run of the published page requests nothing outside this
route — all 69 parts, the loader, the framework and the addressables files come
from Cloudflare. The compiled game data still contains dormant Mirror multiplayer
client strings (`api.diabolical.studio` REST and `wss`, plus
`api.edgegap.com/v1/lobbies`), but they are baked into the C# bundle, unused by
this solo port, and that REST host returns no CORS headers, so online play is not
proxied and not available here.

None of the game's own files are copied into the GitHub Pages artifact: the split
parts exceed GitHub's per-file and repository limits, so only the entry page is
published. The Cloudflare Worker must be redeployed for the new route to exist on
`seuss-arcade-relay.damonrosshutchins.workers.dev`; the build fails loudly if the upstream entry
page no longer matches the expected 69-part layout.

### Local hosting

`npm start` serves the same route on this computer. If the upstream `game/`
folder is present at `local-games/gamble-with-your-friends/` (or
`GAMBLE_LOCAL_DIR` points at it), those files are served from disk with no
network access; otherwise they stream from the pinned commit. Open
`http://localhost:10000/approved-games/gamble-with-your-friends/index.html`.

A successful build and deploy verify that the routes respond, not that the
Unity build plays on a given device.

## Buckshot Roulette (Godot 4 web export)

The Arcade card opens `games/buckshot/index.html` in the in-site player. The
Pages build publishes the upstream Godot entry page with a document `<base>`
pointing at the fixed Cloudflare game route, so the page stays on the Pages origin
while all 20 game files come from Cloudflare: 17 `buckshot-roulette.pck.partN` parts,
3 `buckshot-roulette.wasm.partN` parts, the engine script, the two audio
worklets, `main.js`, `style.css` and the icons.

`server.mjs` serves only those exact filenames from the single pinned commit
`f8a263b4da11c181e02e31086e5a5c8bc2dd1457` of
`Random-Red-Dude-809-4456/buckshot` (jsDelivr primary, GitHub raw fallback for
ranged reads). The upstream export is flat, so the route rejects any path
separator, subdirectory or redirect. The build is single-threaded
(`GODOT_THREADS_ENABLED = false`), so it needs no cross-origin isolation, and a
live audit of the source found no external hosts. ~594 MB is downloaded on
first play.

Local hosting: `local-games/buckshot/` (or `BUCKSHOT_LOCAL_DIR`) serves the same
files from disk at `http://localhost:10000/approved-games/buckshot/index.html`.

## Cloudflare deploys

GitHub Pages deploys on push, but the Cloudflare service does not, so
`.github/workflows/pages.yml` ends with a `render-deploy` job that POSTs the
service's deploy hook once the Pages build and its published-asset checks pass.
Every push to `main` therefore ships the site and the proxy routes together, and
the job is skipped on other branches.

It needs one repository secret:

1. Cloudflare dashboard -> the `seuss-cinema-arcade` service -> **Settings** ->
   **Deploy Hook** -> copy the URL.
2. GitHub repository -> **Settings** -> **Secrets and variables** -> **Actions**
   -> **New repository secret**.
3. Name `RENDER_DEPLOY_HOOK_URL`, value = the copied hook URL, then save.

Until that secret exists the job fails with an explicit
`RENDER_DEPLOY_HOOK_URL is not set` error, on purpose: a green Pages deploy with
an undeployed proxy route is the failure this job prevents. The hook only starts
a Cloudflare build; `/approved-games/.../status` on the live service remains the way
to confirm the new routes are actually serving.

## Seuss Search v2

`seuss-search.html` and `search-client.js` are a search-driven browser on the same
Scramjet runtime as the player, but with no destination allowlist: they open any
http(s) page the relay can reach. Queries go to Bing (`https://www.bing.com/search?q=`), which renders through the
relay; DuckDuckGo and Mojeek both answer proxied traffic with a block page. Anything
that looks like a host opens directly. The page is published by the Pages build, served by `server.mjs` at
`/seuss-search.html`, and linked from the library sidebar.

Relay policy in `server.mjs`:

- `hostname_whitelist=null` and `port_whitelist=null`: any public host, any port.
  wisp-js tests these for truthiness, so an empty array blocks everything.
- TCP and UDP streams and direct-IP destinations are allowed.
- Private, loopback and reserved ranges stay blocked, so an open relay cannot be
  used to reach Cloudflare's internal network or a self-hoster's LAN. Opt in with
  `WISP_ALLOW_PRIVATE_IPS=1` (and/or `WISP_ALLOW_LOOPBACK_IPS=1`).
- Browsers are still Origin-checked before the `/wisp/` socket is accepted.
- `/health` reports `restricted:false` and `relayOriginPolicy:"any-public-host"`.

An open relay spends the service's bandwidth for whoever knows the URL; the Cloudflare
plan limits are the practical ceiling.

### Settings, backgrounds and relay choice

The ⚙ button opens Settings on `seuss-search.html`:

- **Background**: dot matrix (default), grid, rings, or plain. Stored in
  `localStorage` as `seuss-bg` and swapped live, without a reload.
- **Relay**: Cloudflare (default), Cloudflare, or a custom `wss://…/wisp/` URL.
  Stored as `seuss-relay`; applying reloads the page because the transport is
  bound to one endpoint at startup. On `localhost` the page defaults to the relay
  `server.mjs` serves on the same origin.
- **🎮 Library** in the top bar (and the brand mark, and the footer link) returns
  to the arcade catalogue.

### Cloudflare relay

`cloudflare/wisp-relay` is a Wisp v1 relay that runs on Cloudflare Workers: one
Durable Object per client websocket, TCP through `cloudflare:sockets`, same
policy as the Node relay (any public host, private ranges blocked). Deploy with
`npm install && npx wrangler deploy` inside that folder, then paste the printed
`wss://…workers.dev/wisp/` URL into Settings → Relay → Cloudflare (both relays
are pre-filled, so the speed pills measure Cloudflare and Cloudflare out of the box). See
`cloudflare/wisp-relay/README.md` for the binding and origin details.

Note the platform trade-off: a websocket is one long-lived connection per tab,
and Workers bill per request and CPU millisecond, so this suits personal use
rather than a public proxy service.

### Relay speed tuning

Both relays advertise a deeper per-stream send buffer than the wisp-js default
(512 packets instead of 128; the Worker uses the same depth), so large responses
stop stalling behind the tunnel handshake. The Node relay also keeps DNS results
for 10 minutes instead of 2, since search traffic hits the same handful of hosts.
Override with `WISP_SEND_BUFFER`, `WISP_DNS_TTL` and `WISP_DNS_CACHE`.

`.github/workflows/relay-keepalive.yml` pings `/health` every five minutes so the
Cloudflare instance never cold-starts; point it at another relay with the repository
variable `RELAY_HEALTH_URL`. Cold starts, not bandwidth, are the largest single
cost in a first search.

Where else this relay runs unchanged: any host that keeps a process alive and
allows outbound TCP — Fly.io, Railway, Koyeb, or a small VPS (Hetzner, DigitalOcean,
Vultr). Serverless functions are a poor fit because Wisp is one long-lived
websocket per tab; the Workers build is the serverless exception and is priced
per request.

