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

## Minecraft 26.3 (Horizon / Rust WebGPU)

The user-supplied 45.6 MB standalone HTML is stored as 23 text chunks under `games/minecraft-26.3/chunks/`; `scripts/assemble-minecraft.mjs` verifies its SHA-256 and assembles `index.html` at build/startup. The GitHub Pages build also includes it under `games/minecraft-26.3/`.

The arcade card opens `https://seuss-cinema-arcade.onrender.com/approved-games/minecraft/` in the **same tab**. A WebGPU game may need top-level COOP/COEP headers, which GitHub Pages cannot configure directly. Render supplies them and hosts the approved game content.

Sound files are fetched only from `/approved-games/minecraft-sounds/` on the same Render service, which serves a fixed list of 18 pinned sound chunks and `parts.json`. No arbitrary URL proxy is provided. The optional external sound archive is approximately 355 MB, so startup can use significant bandwidth and memory. WebGPU browser support is required. Browser saves are origin-specific; files saved on GitHub Pages will not automatically transfer to the Render origin.
