# Seuss Wisp relay (Cloudflare Workers)

A Wisp v1 relay for Seuss Search, running entirely on Cloudflare: one Durable
Object per client websocket, TCP through `cloudflare:sockets`. Nothing here needs
a server you have to keep alive.

```
cloudflare/wisp-relay/
  worker.mjs        relay + Durable Object
  wrangler.jsonc    bindings, migration, origins
  package.json      wrangler devDependency
```

## Deploy

```bash
cd cloudflare/wisp-relay
npm install
npx wrangler login      # once
npx wrangler deploy
```

Wrangler prints the URL, for example:

```
https://seuss-wisp-relay.<your-subdomain>.workers.dev
```

The relay endpoint is that URL with `/wisp/` on the end:

```
wss://seuss-wisp-relay.<your-subdomain>.workers.dev/wisp/
```

Check it is alive:

```bash
curl https://seuss-wisp-relay.<your-subdomain>.workers.dev/health
# {"ok":true,"service":"seuss-wisp-relay-cloudflare","protocol":"wisp-1",...}
```

## Point Seuss Search at it

1. Open `…/Dr-seuss-Moives-Games-test/seuss-search.html` → **⚙ Settings**.
2. Paste the `wss://…/wisp/` URL into **Cloudflare relay URL**.
3. Pick **Cloudflare** under Relay → **Apply & reload**.

The choice is stored in `localStorage` (`seuss-relay`), so it survives reloads on
that browser only. This standalone relay is now optional: `cloudflare/arcade`
serves the same `/wisp/` endpoint (and every game asset route) by default.

## Policy

- Any public host and any port over TCP; UDP is not implemented (Wisp marks it
  optional).
- Private, loopback, link-local and reserved ranges are blocked (`0x48`), and
  bare IP literals are blocked unless `ALLOW_DIRECT_IP=1`.
- `ALLOWED_ORIGINS` gates the websocket upgrade so unrelated sites cannot borrow
  the relay. Add your own origin there if you host the page elsewhere.
- `ALLOW_PRIVATE_IPS=1` opens the private ranges — only do that if you understand
  it turns the relay into an SSRF probe for whoever finds it.

## Limits worth knowing

Cloudflare Workers bill per request and per CPU millisecond, and a websocket is
one long-lived connection per browsing tab. `connect()` also has per-connection
limits. This is fine for personal use; it is not a way to run a public proxy
service for free.
