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
