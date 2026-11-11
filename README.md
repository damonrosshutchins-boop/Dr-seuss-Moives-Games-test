# Seuss Cinema & Arcade

A modern, responsive entertainment launcher for the curated destinations **wasm.rip** and **shuttletv.pk**. Static frontend works on GitHub Pages.

## Current state
- Library, category filters, search, favorites, and viewer are implemented.
- The viewer uses direct iframe URLs. Some destinations may reject this.
- Connection settings store a proxy origin and Wisp endpoint for future integration, but **they do not connect the iframe through Scramjet**.
- **Scramjet and Wisp are not yet deployed**. There is no unrestricted URL input.
- A Render service is needed for Wisp. A separate, properly integrated Scramjet frontend is also required.

## GitHub Pages
Settings → Pages → Deploy from branch → main → root.

## Render
Create a workspace in Render Dashboard first, then deploy a dedicated backend service into it. Keep the relay restricted to approved domains, block private networks, and require valid origin checks. Do not claim a relay is working until WebSocket connection and game playback tests pass.

## Usage
Only embed, proxy, and stream websites/media where allowed. This application does not bypass DRM, authentication, subscriptions, or access restrictions.
