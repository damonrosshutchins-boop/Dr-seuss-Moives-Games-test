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
