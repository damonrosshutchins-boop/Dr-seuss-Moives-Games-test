# Hosting the arcade server somewhere else

The arcade needs a host that can

- keep a WebSocket open (`/wisp/` carries every proxied game), and
- open outbound TCP to any public host on port 443 (the browser side does TLS).

Cloudflare Workers cannot do the second part. Workers refuse plaintext TCP to
ports 80 and 443 ("cannot connect to the specified address ... use fetch
instead"), and both bundled transports (Wisp/libcurl and Epoxy) tunnel raw TCP,
so a Worker relay fails every HTTPS page. Use a container or VPS instead.

## Hugging Face Spaces (free, no card)

1. Create a Space: **Docker** → **Blank**, hardware **CPU basic (free)**.
2. Push this repository to the Space's git remote:

   ```
   git remote add space https://huggingface.co/spaces/<user>/<space>
   git push space main
   ```

   The root `Dockerfile` installs dependencies and starts `server.mjs` on port
   7860, which is the port Spaces expects.
3. Wait for the build, then check:

   ```
   curl https://<user>-<space>.hf.space/health
   ```

   It should answer `{"ok":true,...}`.
4. Give the maintainer the Space URL. The relay address is that URL with
   `/wisp/` on the end and `wss://` instead of `https://`; it replaces the
   Render endpoint in `proxy-client.js`.

## Any Docker host (VPS, Fly.io, Koyeb, Railway, a home server)

```
docker build -t seuss-arcade .
docker run -p 7860:7860 seuss-arcade
```

Set `PORT` to change the listening port. The image serves the frontend, the
approved game asset routes and the Wisp relay, exactly as `server.mjs` does on
Render.

## Running it on this machine

```
cd _work/target
npm start
```

Then open <http://127.0.0.1:10000/>. Pages served from loopback automatically
use that local relay (`proxy-client.js` checks the hostname), so the player and
the Blooket bots work without any public service.
