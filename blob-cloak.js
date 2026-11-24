/* blob-cloak.js — the one null-origin tab launcher, shared by the arcade, the
   search page and ares.html. A Blob URL only comes out opaque when it is made
   in a null origin, so the button that creates it lives in a sandboxed frame
   without allow-same-origin. This file builds the page that frame shows and the
   shell the new tab holds. */
(function () {
  "use strict";
  const escape = text => String(text)
    .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // The document the cloaked tab really holds: a disguise for the tab itself and
  // one full-screen frame on the real address. The frame is cross-origin to that
  // document, so the page it loads cannot retitle the tab.
  function shellDocument(options) {
    const title = options.title || options.url;
    const icon = options.icon || "";
    return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      "<title>" + escape(title) + "</title>" +
      (icon ? '<link rel="icon" href="' + escape(icon) + '">' : "") +
      "<style>html,body{margin:0;height:100%;background:#0e1620;overflow:hidden}" +
      "iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style></head><body>" +
      '<iframe src="' + escape(options.url) + '" allow="autoplay; fullscreen; clipboard-read; ' +
      'clipboard-write; encrypted-media; picture-in-picture" referrerpolicy="no-referrer"></iframe>' +
      "</body></html>";
  }

  // What lives inside the sandboxed frame: the button that runs in a null origin,
  // which is the only place a blob:null URL can be made.
  function launcherDocument(options) {
    const label = options.label || "blob:null";
    const message = options.message || "seuss-blob-tab";
    const hint = options.hint || "Open this page in a tab whose address is blob:null";
    return '<!doctype html><html><head><meta charset="utf-8"><style>' +
      "html,body{margin:0;height:100%;overflow:hidden}" +
      "button{display:flex;align-items:center;justify-content:center;width:100%;height:100%;" +
      "padding:0 10px;border:0;background:#141414;color:#dcdcdc;cursor:pointer;" +
      "font:700 11px ui-monospace,Consolas,monospace;letter-spacing:.02em}" +
      "button:hover{background:#232323}button:focus-visible{outline:2px solid #fff;outline-offset:-2px}" +
      "</style></head><body>" +
      '<button id="go" type="button" title="' + escape(hint) + '">' + escape(label) + "</button>" +
      "<script>var SHELL=" + JSON.stringify(options.shell).replace(/<\//g, "<\\/") +
      ",MESSAGE=" + JSON.stringify(message) + ";" +
      'document.getElementById("go").addEventListener("click",function(){try{' +
      'var u=URL.createObjectURL(new Blob([SHELL],{type:"text/html"}));' +
      'var w=window.open(u,"_blank");' +
      "if(w)setTimeout(function(){URL.revokeObjectURL(u);},60000);" +
      'parent.postMessage({type:MESSAGE,ok:!!w},"*");' +
      '}catch(e){parent.postMessage({type:MESSAGE,ok:false},"*");}});' +
      "<" + "/script></body></html>";
  }

  // Fill a sandboxed frame with the launcher for one page and one disguise.
  function mount(frame, options) {
    if (!frame) return;
    frame.srcdoc = launcherDocument({
      shell: shellDocument({
        url: options.url || location.href,
        title: options.title,
        icon: options.icon
      }),
      label: options.label,
      hint: options.hint,
      message: options.message
    });
  }

  window.SeussBlob = { shellDocument: shellDocument, launcherDocument: launcherDocument, mount: mount };
})();
