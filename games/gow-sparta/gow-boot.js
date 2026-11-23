/* God of War bootstrap: gzip fallback and a visible failure when the page is
   not cross-origin isolated.
   The recompiled game allocates a shared WebAssembly memory for its threads,
   and every browser only allows that in a cross-origin isolated page. GitHub
   Pages cannot send COOP/COEP headers, so coi-serviceworker supplies them from
   a service worker and reloads once. Firefox has no service workers at all in
   a private window, so that reload never happens there and the page would
   otherwise sit on a black screen with nothing to go on. */
(function () {
  "use strict";

  var haveDecompression = typeof DecompressionStream === "function";
  var nativeFetch = window.fetch.bind(window);
  var wasmOnce = null;

  /* ------------------------------------------------------------- inflate ---
     Firefox before 113 has no DecompressionStream, so index.wasm.gz and
     index.data.gz are inflated here. Plain DEFLATE (RFC 1951) inside the gzip
     wrapper, using the puff-style canonical Huffman decode. */
  var LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43,
      51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4,
      4, 4, 4, 5, 5, 5, 5, 0];
  var DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257,
      385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385,
      24577];
  var DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9,
      9, 10, 10, 11, 11, 12, 12, 13, 13];
  var CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1,
      15];

  function Huffman(lengths, count) {
    var offsets = new Int32Array(16);
    var i;
    this.counts = new Int32Array(16);
    this.symbols = new Int32Array(count);
    for (i = 0; i < count; i++) this.counts[lengths[i]]++;
    this.counts[0] = 0;
    for (i = 1; i < 16; i++) offsets[i] = offsets[i - 1] + this.counts[i - 1];
    for (i = 0; i < count; i++) {
      if (lengths[i]) this.symbols[offsets[lengths[i]]++] = i;
    }
  }

  Huffman.prototype.decode = function (state) {
    var code = 0;
    var first = 0;
    var index = 0;
    var len;
    var count;
    for (len = 1; len < 16; len++) {
      code |= state.bits(1);
      count = this.counts[len];
      if (code - first < count) return this.symbols[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Error("invalid Huffman code");
  };

  function fixedTrees() {
    var lengths = new Uint8Array(288);
    var distances = new Uint8Array(30);
    var i = 0;
    for (; i < 144; i++) lengths[i] = 8;
    for (; i < 256; i++) lengths[i] = 9;
    for (; i < 280; i++) lengths[i] = 7;
    for (; i < 288; i++) lengths[i] = 8;
    for (i = 0; i < 30; i++) distances[i] = 5;
    return { literal: new Huffman(lengths, 288), distance: new Huffman(distances, 30) };
  }

  function inflateRaw(input, start, expected) {
    var pos = start;
    var bitbuf = 0;
    var bitcnt = 0;
    var out = new Uint8Array(expected > 0 ? expected : 1 << 16);
    var op = 0;
    var fixed = null;
    var state = { bits: bits };

    function bits(wanted) {
      while (bitcnt < wanted) {
        if (pos >= input.length) throw new Error("truncated deflate stream");
        bitbuf |= input[pos++] << bitcnt;
        bitcnt += 8;
      }
      var value = bitbuf & ((1 << wanted) - 1);
      bitbuf >>>= wanted;
      bitcnt -= wanted;
      return value;
    }

    function grow() {
      var bigger = new Uint8Array(out.length * 2);
      bigger.set(out);
      out = bigger;
    }

    function put(byte) {
      if (op === out.length) grow();
      out[op++] = byte;
    }

    for (;;) {
      var last = bits(1);
      var type = bits(2);
      if (type === 0) {
        bitbuf = 0;
        bitcnt = 0;
        var length = input[pos] | (input[pos + 1] << 8);
        var inverse = input[pos + 2] | (input[pos + 3] << 8);
        pos += 4;
        if ((length ^ 0xffff) !== inverse) throw new Error("bad stored block length");
        while (length--) put(input[pos++]);
      } else if (type === 3) {
        throw new Error("invalid deflate block type");
      } else {
        var literalTree;
        var distanceTree;
        var i;
        if (type === 1) {
          if (!fixed) fixed = fixedTrees();
          literalTree = fixed.literal;
          distanceTree = fixed.distance;
        } else {
          var hlit = bits(5) + 257;
          var hdist = bits(5) + 1;
          var hclen = bits(4) + 4;
          var codeLengths = new Uint8Array(19);
          for (i = 0; i < hclen; i++) codeLengths[CLORDER[i]] = bits(3);
          var codeTree = new Huffman(codeLengths, 19);
          var lengths = new Uint8Array(hlit + hdist);
          var index = 0;
          while (index < hlit + hdist) {
            var symbol = codeTree.decode(state);
            if (symbol < 16) {
              lengths[index++] = symbol;
              continue;
            }
            var repeat;
            var value = 0;
            if (symbol === 16) {
              if (!index) throw new Error("repeat with no previous length");
              value = lengths[index - 1];
              repeat = 3 + bits(2);
            } else if (symbol === 17) {
              repeat = 3 + bits(3);
            } else {
              repeat = 11 + bits(7);
            }
            if (index + repeat > hlit + hdist) throw new Error("length repeat overruns");
            while (repeat--) lengths[index++] = value;
          }
          literalTree = new Huffman(lengths.subarray(0, hlit), hlit);
          distanceTree = new Huffman(lengths.subarray(hlit), hdist);
        }
        for (;;) {
          var code = literalTree.decode(state);
          if (code < 256) {
            put(code);
            continue;
          }
          if (code === 256) break;
          code -= 257;
          if (code >= 29) throw new Error("invalid length symbol");
          var copyLength = LBASE[code] + bits(LEXT[code]);
          var distanceCode = distanceTree.decode(state);
          if (distanceCode >= 30) throw new Error("invalid distance symbol");
          var distance = DBASE[distanceCode] + bits(DEXT[distanceCode]);
          if (distance > op) throw new Error("distance reaches before the output");
          while (copyLength--) put(out[op - distance]);
        }
      }
      if (last) break;
    }
    return op === out.length ? out : out.subarray(0, op);
  }

  function gunzip(buffer) {
    var bytes = new Uint8Array(buffer);
    if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8) {
      throw new Error("not a gzip stream");
    }
    var flags = bytes[3];
    var pos = 10;
    if (flags & 4) pos += 2 + (bytes[pos] | (bytes[pos + 1] << 8));
    if (flags & 8) while (pos < bytes.length && bytes[pos++]) {}
    if (flags & 16) while (pos < bytes.length && bytes[pos++]) {}
    if (flags & 2) pos += 2;
    var end = bytes.length;
    var size = (bytes[end - 4] | (bytes[end - 3] << 8) |
      (bytes[end - 2] << 16) | (bytes[end - 1] << 24)) >>> 0;
    var out = inflateRaw(bytes, pos, size);
    if (size && out.length !== size) throw new Error("gzip size mismatch");
    return out;
  }

  window.__seussGunzip = gunzip;

  /* ------------------------------------------------------------ fetch shim ---
     The build asks for index.wasm and index.data; only the gzipped copies are
     published, so both are decompressed here whatever the browser offers. */
  function gzipped(url) {
    return nativeFetch(url + ".gz").then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      if (haveDecompression) {
        return new Response(response.body.pipeThrough(new DecompressionStream("gzip")));
      }
      return response.arrayBuffer().then(function (buffer) {
        return new Response(gunzip(buffer), { status: 200 });
      });
    });
  }

  window.fetch = function (resource, options) {
    var path = (typeof resource === "string" ? resource : (resource && resource.url) || "").split("?")[0];
    if (/(^|\/)index\.wasm$/.test(path)) {
      if (!wasmOnce) wasmOnce = gzipped("index.wasm").then(function (response) { return response.arrayBuffer(); });
      return wasmOnce.then(function (buffer) {
        return new Response(buffer, {
          status: 200,
          headers: { "Content-Type": "application/wasm", "Content-Length": String(buffer.byteLength) }
        });
      }, function () {
        wasmOnce = null;
        return nativeFetch(resource, options);
      });
    }
    if (/(^|\/)index\.data$/.test(path)) {
      return gzipped("index.data").catch(function () { return nativeFetch(resource, options); });
    }
    return nativeFetch(resource, options);
  };

  /* ------------------------------------------------------ isolation warning --- */
  function isolationState() {
    if (window.crossOriginIsolated) return "isolated";
    if (!window.navigator.serviceWorker) return "private";
    var failed = false;
    try { failed = !!window.sessionStorage.getItem("coiCoepHasFailed"); } catch (error) {}
    return failed ? "blocked" : "pending";
  }

  function buildCard(privateWindow) {
    var card = document.createElement("div");
    card.id = "coi-failure";
    card.setAttribute("role", "alertdialog");
    card.setAttribute("aria-live", "assertive");
    card.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;background:#0b0b0df2;color:#fff;font:15px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif";
    var panel = document.createElement("div");
    panel.style.cssText = "max-width:560px;width:100%;background:#1b1b1f;border:1px solid #4a4a55;border-radius:14px;padding:26px;box-shadow:0 20px 60px #000a";
    panel.innerHTML =
      '<h1 style="margin:0 0 10px;font-size:21px">God of War cannot start in this window</h1>' +
      '<p style="margin:0 0 12px;color:#d6d6de">The game runs its threads on shared memory, ' +
      'and browsers only allow that in a cross-origin isolated page. This page gets the ' +
      'isolation from a service worker, and ' +
      (privateWindow
        ? 'this window has none: Firefox turns service workers off in private windows. ' +
          'Open the game in a normal window and it will start.'
        : 'this window has not received one yet. Reload the page once: the worker installs ' +
          'on the first load and the reload isolates the page.') +
      '</p>' +
      '<p style="margin:0 0 16px;font:12px/1.4 ui-monospace,Consolas,monospace;color:#9a9aa6">' +
      'crossOriginIsolated=false &middot; serviceWorker=' +
      (window.navigator.serviceWorker ? 'yes' : 'no') + '</p>';
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

  function showCard(privateWindow) {
    if (document.getElementById("coi-failure")) return;
    var card = buildCard(privateWindow);
    function mount() { (document.body || document.documentElement).appendChild(card); }
    if (document.body) mount();
    else document.addEventListener("DOMContentLoaded", mount);
  }

  var state = isolationState();
  if (state === "private" || state === "blocked") {
    showCard(state === "private");
  } else if (state === "pending") {
    window.setTimeout(function () {
      if (!window.crossOriginIsolated) showCard(false);
    }, 10000);
  }
})();
