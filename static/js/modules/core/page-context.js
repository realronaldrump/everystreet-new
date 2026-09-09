import { createFeatureApi } from "./feature-api.js";

export function createPageContext({ signal = null, cleanup = null } = {}) {
  const disposers = [];
  const registered = new Set();
  let disposed = false;
  const api = createFeatureApi({ signal });

  const onCleanup = (fn) => {
    if (typeof fn !== "function") {
      return () => {};
    }
    if (registered.has(fn)) return () => {};
    registered.add(fn);
    if (disposed) {
      fn();
      return () => {};
    }
    disposers.push(fn);
    return () => {
      const idx = disposers.indexOf(fn);
      if (idx >= 0) {
        disposers.splice(idx, 1);
      }
    };
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (let idx = disposers.length - 1; idx >= 0; idx -= 1) {
      try {
        disposers[idx]();
      } catch (error) {
        console.error("Cleanup callback failed", error);
      }
    }
    disposers.length = 0;
  };

  if (typeof cleanup === "function") {
    cleanup(dispose);
  }

  return {
    signal,
    api,
    onCleanup,
    cleanup: onCleanup,
    dispose,
  };
}
