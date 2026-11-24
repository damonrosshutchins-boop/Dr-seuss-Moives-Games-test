/* Rocket League bootstrap: a visible failure when the page is not cross-origin
   isolated.
   The game runs its threads on shared WebAssembly memory, and every browser only
   allows that in a cross-origin isolated page. GitHub Pages cannot send
   COOP/COEP headers, so coi-serviceworker supplies them from a service worker
   and reloads once. A private window cannot keep that worker: Firefox below 139
   hides the API there, and 139 and later expose it with nothing registered, so
   the reload never happens and the page would otherwise sit on a black screen
   with nothing to go on. */
(function () {
  "use strict";

  /* ------------------------------------------------------ isolation warning --- */
  function isolationState() {
    if (window.crossOriginIsolated) return "isolated";
    var container = window.navigator && window.navigator.serviceWorker;
    if (!container) return "private";
    if (container.controller) return "blocked";
    var failed = false;
    try { failed = !!window.sessionStorage.getItem("coiCoepHasFailed"); } catch (error) {}
    return failed ? "blocked" : "pending";
  }

  /* Firefox 139 and later do expose navigator.serviceWorker in a private window,
     so the object being there no longer proves the isolation worker can run:
     ask for the registrations too, and treat none as a window that cannot keep
     one. Without the API at all the page is already known to be a private one. */
  function reasonWithoutIsolation(callback) {
    var container = window.navigator && window.navigator.serviceWorker;
    if (!container || !container.getRegistrations) { callback("private"); return; }
    var settled = false;
    function done(registered) {
      if (settled) return;
      settled = true;
      callback(registered ? "blocked" : "private");
    }
    window.setTimeout(function () { done(false); }, 1500);
    container.getRegistrations().then(function (list) {
      done(!!(list && list.length));
    }, function () { done(false); });
  }

  function buildCard(reason) {
    var card = document.createElement("div");
    card.id = "coi-failure";
    card.setAttribute("role", "alertdialog");
    card.setAttribute("aria-live", "assertive");
    card.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;background:#0b0b0df2;color:#fff;font:15px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif";
    var panel = document.createElement("div");
    panel.style.cssText = "max-width:560px;width:100%;background:#1b1b1f;border:1px solid #4a4a55;border-radius:14px;padding:26px;box-shadow:0 20px 60px #000a";
    var container = window.navigator && window.navigator.serviceWorker;
    panel.innerHTML =
      '<h1 style="margin:0 0 10px;font-size:21px">Rocket League needs a normal window to start</h1>' +
      '<p style="margin:0 0 12px;color:#d6d6de">The game runs its threads on shared memory, ' +
      'and browsers only allow that in a cross-origin isolated page. This page gets the ' +
      'isolation from a service worker, and ' +
      (reason === "private"
        ? 'this window has none: Firefox turns service workers off in private windows, and ' +
          'in normal windows that clear cookies and site data when they close. Open the game ' +
          'in a normal window rather than a private one and it will start.'
        : 'the worker it registered did not isolate the page, so the ' +
          'Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers it sends were ' +
          'stripped on the way here. Open the page in a normal window of its own, not inside ' +
          'another page, and reload; a proxy, VPN or extension that removes those headers has ' +
          'to be off for it to start.') +
      '</p>' +
      '<p style="margin:0 0 16px;font:12px/1.4 ui-monospace,Consolas,monospace;color:#9a9aa6">' +
      'crossOriginIsolated=false &middot; serviceWorker=' + (container ? 'yes' : 'no') +
      ' &middot; controller=' + (container && container.controller ? 'yes' : 'no') + '</p>';
    var actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center";
    var reload = document.createElement("button");
    reload.type = "button";
    reload.textContent = "Reload the page";
    reload.style.cssText = "border:0;border-radius:9px;background:#4d7fdd;color:#fff;font:600 14px system-ui;padding:11px 18px;cursor:pointer";
    reload.addEventListener("click", function () { window.location.reload(); });
    var back = document.createElement("a");
    back.href = "../../index.html";
    back.textContent = "\u2190 Back to the Arcade";
    back.style.cssText = "color:#a9c3f0;font-size:14px;text-decoration:none";
    actions.appendChild(reload);
    actions.appendChild(back);
    panel.appendChild(actions);
    card.appendChild(panel);
    return card;
  }

  function showCard(reason) {
    if (document.getElementById("coi-failure")) return;
    var card = buildCard(reason);
    function mount() { (document.body || document.documentElement).appendChild(card); }
    if (document.body) mount();
    else document.addEventListener("DOMContentLoaded", mount);
  }

  var state = isolationState();
  if (state === "isolated") return;
  if (state === "private" || state === "blocked") {
    showCard(state);
    return;
  }
  /* The first load in a normal window is not isolated until the worker has
     installed and reloaded the page, so give that a moment before failing. */
  window.setTimeout(function () {
    if (window.crossOriginIsolated) return;
    reasonWithoutIsolation(function (reason) { showCard(reason); });
  }, 4000);
})();
