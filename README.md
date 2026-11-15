# Seuss Cinema & Arcade

A curated movies-and-games dashboard with an embedded Scramjet 2.x player.

## GitHub Pages deployment

GitHub Actions builds the browser assets into `dist/` and deploys them to GitHub Pages on pushes to `main`.

1. In **Settings → Pages**, set **Build and deployment → Source** to **GitHub Actions**.
2. Check **Actions → Deploy Cinema Arcade to GitHub Pages** to see build/deploy results.
3. Visit https://damonrosshutchins-boop.github.io/Dr-seuss-Moives-Games-test/

The static site serves the Scramjet worker under the GitHub Pages repository path. Its Libcurl transport connects to the separately hosted Render endpoint:
`wss://seuss-cinema-arcade.onrender.com/wisp/`.

GitHub Pages cannot run a Wisp server. The Render service must be active for proxied pages to load. Existing origin checks and destination restrictions are enforced server-side.

## Render deployment

Render hosts the Node.js service in `server.mjs` (frontend and Wisp combined). `npm start` starts the service. `/health` reports liveness.

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
numbered sound chunks via the existing Render service:
`https://seuss-cinema-arcade.onrender.com/approved-games/horizon/`.
The server-side restriction does not permit arbitrary URL fetches.

Build success does not guarantee playability on every WebGPU device.


## God of War: Ghost of Sparta (approved Surge source via Render)

The current owner-supplied PSP game source is `https://psp-web-damon.surge.sh/`.
The Arcade card opens `games/gow-sparta/index.html`, which checks the pinned
Render endpoint and navigates in the same browser tab to
`https://seuss-cinema-arcade.onrender.com/approved-games/gow-sparta/`.
Only game files on this exact Surge hostname are fetched by the new Render
route; request paths are checked and redirects are rejected. The server streams
ordinary assets, passes through simple byte ranges (important for large game
files), and rewrites common HTML/CSS root-relative URLs to stay under the
approved route. This does **not** provide a general web proxy.

The PSP site must exist and be reachable at its Surge source. A GitHub Actions source audit fetched the root HTML successfully (HTTP 200) and found no statically embedded absolute URL hosts in that HTML; this does not verify runtime dependencies. Some games use
external CDNs, root-absolute JavaScript paths, special response headers,
websockets or service workers that cannot be verified without inspecting the
live upstream page; those dependencies are not automatically proxied.
The launcher reports an unavailable source instead of silently redirecting.
The successful Pages build/Render deploy alone does not verify gameplay.


The PSP site's first-party root-relative fetch/XHR URLs and first-party absolute asset references are rewritten to stay inside the fixed Render game route. Any dynamic third-party endpoints must be inspected and independently approved; arbitrary domains are not automatically granted proxy access.


## Minecraft 1.8 Wrust Mod and Minecraft 1.8 Mods

These two entries are added as separate Minecraft 1.8 Eaglercraft-style games in
the Arcade. Clicking a card opens a same-site launcher, which checks Render and
then navigates in the same tab to a **fixed** Render URL. No visitor-provided
proxy destination, arbitrary Google Drive ID, or arbitrary CDN path is accepted.

- **Minecraft 1.8 Wrust Mod:** the public Google Drive file
  `clwurst.html` (27,847,113 bytes), fixed ID
  `1TBtrBMMw9w9lqc3Z3aw4CARG_O04abIM`. The offline HTML is streamed
  through `/approved-games/minecraft-18-wrust/index.html` on Render.
- **Minecraft 1.8 Mods:** the public Google Drive file
  `cleaglerforge.html` (1,035 bytes), fixed ID
  `17mqNnsALl6ZvDVOtarz4EuP5pS8E4-R9`. Its four hardcoded CDN
  downloads are rewritten to the four Render routes
  `/approved-games/minecraft-18-mods/assets/forge-part1` to
  `forge-part4`. The server obtains those parts from a pinned GitHub
  revision and does not accept unapproved hostnames. The four files total
  about 79 MB.

The approved game **files** are delivered through Render. The original
EaglercraftX client also contains external multiplayer relay addresses and
links; these are **not** implicitly proxied or whitelisted. External network
multiplayer may use direct game server connections or may be unavailable.
Successful deployment verifies the routes, not gameplay or compatibility.


## Gamble With Your Friends (camzzz solo web port)

The Arcade card opens `games/gamble-with-your-friends/index.html` in the in-site
player, so the browser stays on this website. The Pages build publishes an ~8 KB
entry page whose loader, framework, addressables and all 69 split parts are
absolute URLs on the fixed Render route; the bytes come from Render while the
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
from Render. The compiled game data still contains dormant Mirror multiplayer
client strings (`api.diabolical.studio` REST and `wss`, plus
`api.edgegap.com/v1/lobbies`), but they are baked into the C# bundle, unused by
this solo port, and that REST host returns no CORS headers, so online play is not
proxied and not available here.

None of the game's own files are copied into the GitHub Pages artifact: the split
parts exceed GitHub's per-file and repository limits, so only the entry page is
published. Render must be redeployed for the new route to exist on
`seuss-cinema-arcade.onrender.com`; the build fails loudly if the upstream entry
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
pointing at the fixed Render game route, so the page stays on the Pages origin
while all 20 game files come from Render: 17 `buckshot-roulette.pck.partN` parts,
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

## Render deploys

GitHub Pages deploys on push, but the Render service does not, so
`.github/workflows/pages.yml` ends with a `render-deploy` job that POSTs the
service's deploy hook once the Pages build and its published-asset checks pass.
Every push to `main` therefore ships the site and the proxy routes together, and
the job is skipped on other branches.

It needs one repository secret:

1. Render dashboard -> the `seuss-cinema-arcade` service -> **Settings** ->
   **Deploy Hook** -> copy the URL.
2. GitHub repository -> **Settings** -> **Secrets and variables** -> **Actions**
   -> **New repository secret**.
3. Name `RENDER_DEPLOY_HOOK_URL`, value = the copied hook URL, then save.

Until that secret exists the job fails with an explicit
`RENDER_DEPLOY_HOOK_URL is not set` error, on purpose: a green Pages deploy with
an undeployed proxy route is the failure this job prevents. The hook only starts
a Render build; `/approved-games/.../status` on the live service remains the way
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
  used to reach Render's internal network or a self-hoster's LAN. Opt in with
  `WISP_ALLOW_PRIVATE_IPS=1` (and/or `WISP_ALLOW_LOOPBACK_IPS=1`).
- Browsers are still Origin-checked before the `/wisp/` socket is accepted.
- `/health` reports `restricted:false` and `relayOriginPolicy:"any-public-host"`.

An open relay spends the service's bandwidth for whoever knows the URL; the Render
plan limits are the practical ceiling.
