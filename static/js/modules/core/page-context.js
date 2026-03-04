import { createFeatureApi } from "./feature-api.js";

export function createPageContext({ signal = null, cleanup = null } = {}) {
  const disposers = [];
  const api = createFeatureApi({ signal });

  const onCleanup = (fn) => {
    if (typeof fn !== "function") {
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
