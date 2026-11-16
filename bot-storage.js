// Gives one proxied game frame its own storage.
// The proxied page runs on this site's origin, so without this every bot frame
// reads and writes the same keys and the site's backend sees one repeated
// visitor instead of several players. The worker injects this file into the
// proxied document, and the bot's frame URL carries ?bkbot=<n>.
(() => {
  const id = new URLSearchParams(window.location.search || "").get("bkbot");
  if (!id) return;
  const prefix = "__bk" + id + "__";

  const namespace = (real) => {
    const mine = () => {
      const list = [];
      for (let i = 0; i < real.length; i += 1) {
        const key = real.key(i);
        if (key && key.indexOf(prefix) === 0) list.push(key.slice(prefix.length));
      }
      return list;
    };
    return new Proxy(real, {
      get(target, prop) {
        if (prop === "length") return mine().length;
        if (prop === "key") return (index) => { const list = mine(); return index >= 0 && index < list.length ? list[index] : null; };
        if (prop === "getItem") return (key) => target.getItem(prefix + String(key));
        if (prop === "setItem") return (key, value) => target.setItem(prefix + String(key), value);
        if (prop === "removeItem") return (key) => target.removeItem(prefix + String(key));
        if (prop === "clear") return () => mine().forEach((key) => target.removeItem(prefix + key));
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
      set(target, prop, value) { target.setItem(prefix + String(prop), value); return true; },
      has(target, prop) { return typeof prop === "string" && target.getItem(prefix + prop) !== null; },
      deleteProperty(target, prop) { target.removeItem(prefix + String(prop)); return true; },
      ownKeys() { return mine(); },
      getOwnPropertyDescriptor(target, prop) {
        if (typeof prop === "string") {
          const value = target.getItem(prefix + prop);
          if (value !== null) return { value, writable: true, enumerable: true, configurable: true };
        }
        return undefined;
      }
    });
  };

  for (const name of ["localStorage", "sessionStorage"]) {
    try {
      const real = window[name];
      if (!real) continue;
      const scoped = namespace(real);
      Object.defineProperty(window, name, { configurable: true, enumerable: true, get: () => scoped });
    } catch (error) {
      // Leave the shared storage in place rather than breaking the page.
    }
  }
})();
