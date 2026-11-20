// A local stand-in for Blooket's join page: a game-code form that submits with
// fetch, so the probe's three outcomes can be produced on demand.
//
//   clear             answered 200 with a nickname prompt
//   app               answered 200 with an app-level refusal ("Game not found")
//   blocked           answered 403 with cf-mitigated: challenge (the real shape)
//   blocked-then-quiet first POST challenged, the retry's POST never answered —
//                     the case that used to slip through as inconclusive
//   quiet             no answer at all
import http from "node:http";

const page = (mode) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Fake join</title></head>
<body>
<form id="join">
  <input placeholder="Game ID" aria-label="Enter Game ID" autocomplete="off">
  <button type="submit" aria-label="Submit">Join</button>
</form>
<p id="out"></p>
<script>
document.getElementById("join").addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = document.querySelector('input[placeholder="Game ID"]').value.trim();
  try {
    const response = await fetch("/join?mode=${mode}&code=" + encodeURIComponent(code), { method: "POST" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();
    if (data.ok) {
      const input = document.createElement("input");
      input.placeholder = "Nickname";
      document.body.appendChild(input);
    } else {
      document.getElementById("out").textContent = data.reason || "Game not found";
    }
  } catch (error) {
    document.getElementById("out").textContent = "Join failed";
  }
});
</script>
</body></html>`;

export async function startFakeJoin() {
  const held = [];
  const posts = new Map();

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const mode = url.searchParams.get("mode") || "clear";

    if (url.pathname === "/play") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(page(mode));
      return;
    }

    if (url.pathname === "/join" && request.method === "POST") {
      const seen = (posts.get(mode) || 0) + 1;
      posts.set(mode, seen);

      if (mode === "blocked" || (mode === "blocked-then-quiet" && seen === 1)) {
        response.writeHead(403, { "content-type": "text/html; charset=UTF-8", "cf-mitigated": "challenge" });
        response.end("<!doctype html><html><head><title>Just a moment...</title></head><body></body></html>");
        return;
      }
      if (mode === "blocked-then-quiet" || mode === "quiet") {
        held.push(response); // never answered, never closed by us
        return;
      }
      if (mode === "app") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, reason: "Game not found" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/play`,
    close: () => {
      for (const response of held) response.destroy();
      server.closeAllConnections?.();
      server.close();
    },
  };
}
