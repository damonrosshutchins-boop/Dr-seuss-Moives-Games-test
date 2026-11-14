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

The Minecraft 26.3 Rust (Horizon) library card opens games/horizon/index.html. The owner-provided standalone HTML is about 45 MB and contains the game WASM and prepared startup files. The launcher accepts the exact uploaded file, verifies its SHA-256, and caches it in the current browser. Future visits can launch locally. The game opens top-level in the same tab (not a nested iframe) to support game-scoped service-worker isolation.

To make the game load automatically for every visitor, the owner can commit the authorized horizon-standalone.html under games/horizon/ using git. The Pages build copies it automatically if present, and the loader verifies it before use. Only publish copyrighted game content with appropriate permission.

Quick start skips a 355 MB optional sound download. Play with sound via Render streams only the pinned manifest and 18 numbered sound chunks through /approved-games/horizon/ on the existing Render backend. It cannot be used as an unrestricted proxy. The audio source is pinned to AlexBoops/mc-rust-onweb revision b21a7ae704b415182631429a7e71c797287661df.

WebGPU, substantial browser memory, HTTPS and device support are required. A deployment does not guarantee the game plays on all devices.
