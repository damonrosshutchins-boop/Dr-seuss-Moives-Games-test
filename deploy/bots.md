# Hosting the bot program (no program on the player's computer)

The site itself cannot join a Blooket room: Blooket sends no CORS headers, so a
page on GitHub Pages is not allowed to call its API, and there is no public join
endpoint to call. The bots therefore run where a real browser can be started —
but that place does not have to be your computer. Deploy this image once and the
arcade page can start bots from anywhere.

## Build and run

```bash
docker build -f Dockerfile.bots -t seuss-bots .
docker run -d --name seuss-bots -p 8080:8080 \
  -e BOTS_TOKEN=pick-a-long-random-value \
  seuss-bots
```

Any container host works (Render, Fly.io, Railway, a VPS, a Hugging Face Docker
Space). Give it at least 1 GB of RAM: each bot is a separate Chromium profile,
and they share the container. Unpause/sleep settings matter — a host that idles
the container will drop running bots.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Port the host expects. |
| `BOTS_HOST` | `0.0.0.0` in the image | Bind address. |
| `BOTS_TOKEN` | none | Required for `POST /bots` and `/stop`. **Always set it on a public host.** |
| `BOTS_ORIGINS` | none | Extra allowed origins, comma separated. `https://damonrosshutchins-boop.github.io` is always allowed. |
| `BROWSER_PATH` | auto | Chromium binary; the image uses Playwright's download. |
| `BROWSER_NO_SANDBOX` | `1` in the image | Containers run as root, where Chromium needs `--no-sandbox`. |
| `BOTS_URL` | `https://play.blooket.com/play` | Test seam: point it at `blooket-mock.html` to exercise the panel without a live game. |

## Connect the site

1. Open the arcade site → **Settings**.
2. **Bot program address**: `https://your-bots-host.example.com`
3. **Access token**: the same `BOTS_TOKEN` value.
4. **Save bots**. Open the Blooket panel, type the game code, press Send bots.

The program is remembered per browser in `localStorage` (`seussBotService`,
`seussBotToken`); clearing the address goes back to the local bridge.

## Checks

```bash
curl https://your-bots-host.example.com/health
curl -X POST https://your-bots-host.example.com/bots \
  -H "content-type: application/json" -H "x-bots-token: $BOTS_TOKEN" \
  -d '{"code":"1234567","count":2}'
```

`/health` answers `{"ok":true,"running":false,"code":""}` when the service is up.

## Limits worth knowing

- Blooket's pages sit behind bot management; a headless container browser is
  easier for it to block than a desktop browser, and a blocked bot simply fails
  to join. If joins stop working, check the container log first.
- Automated play is against Blooket's terms of service. Use it on games you run
  yourself. This project does not defeat their challenge or log bots into
  accounts.
- One run at a time: a second `POST /bots` while a run is active returns 409.
