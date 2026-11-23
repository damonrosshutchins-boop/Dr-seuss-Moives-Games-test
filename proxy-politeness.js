// Rate-limit manners for the proxy transport.
//
// A destination that answers 429, or a 503 carrying Retry-After, is telling the
// request how to behave. The tunnel has no way to pass that back to the page:
// Scramjet renders the response and the browser keeps firing asset requests at
// the same host, so one "slow down" turns into a burst the host reads as abuse.
// Waiting the asked-for time and retrying the same idempotent request is what
// any well-behaved client does, and it is the difference between a soft rate
// limit and a host that starts challenging everything from this relay.
//
// What this deliberately does not do: forge clearance cookies, solve or dodge a
// challenge, rotate identities, or retry a 401/403 refusal the host meant. A
// refusal is answered by the destination and shown as such.
const RETRY_STATUS = new Set([429, 503]);
const SAFE_METHODS = new Set(["GET", "HEAD"]);
const DEFAULT_ATTEMPTS = 3; // the first try plus two retries
const DEFAULT_BUDGET_MS = 8000; // longer than this and the page has moved on
const FLOOR_MS = 500;
const JITTER_MS = 400;

// `request()` resolves with libcurl's raw header pairs, not a Headers object, so
// read both shapes rather than assuming one.
function headerValue(headers, name) {
  if (!headers) return "";
  const wanted = name.toLowerCase();
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return value == null ? "" : String(value);
  }
  let pairs;
  try { pairs = [...headers]; } catch { return ""; }
  for (const entry of pairs) {
    if (Array.isArray(entry) && String(entry[0]).toLowerCase() === wanted) return String(entry[1] ?? "");
  }
  return "";
}

// Retry-After is either a number of seconds or an HTTP date.
function retryAfterMs(headers) {
  const value = headerValue(headers, "retry-after").trim();
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

function abortError() {
  return typeof DOMException === "function"
    ? new DOMException("The operation was aborted.", "AbortError")
    : Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

export function politeTransport(Base, { attempts = DEFAULT_ATTEMPTS, budgetMs = DEFAULT_BUDGET_MS } = {}) {
  return class PoliteTransport extends Base {
    async request(remote, method, body, headers, signal) {
      const safe = SAFE_METHODS.has(String(method || "GET").toUpperCase());
      let tried = 1;
      for (;;) {
        const response = await super.request(remote, method, body, headers, signal);
        if (!safe || tried >= attempts || !RETRY_STATUS.has(response.status)) return response;
        const asked = retryAfterMs(response.headers);
        // A host asking for longer than the page can wait is answering, not
        // stalling: show its answer rather than waiting and asking again.
        if (asked > budgetMs) return response;
        // Honour the asked-for pause; without one, back off exponentially. The
        // 250 ms floor stops a "Retry-After: 0" from becoming a tight loop.
        const wait = Math.min(budgetMs, Math.max(250, asked || FLOOR_MS * 2 ** (tried - 1)) + Math.random() * JITTER_MS);
        // The discarded response holds a tunnel connection until its body is
        // dropped, so release it before waiting.
        try { await response.body?.cancel?.(); } catch { /* body already consumed */ }
        await sleep(wait, signal);
        tried++;
      }
    }
  };
}
