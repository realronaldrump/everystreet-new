import store from "./store.js";
import { onNavigation, pathnameFromSwupUrl } from "./navigation-events.js";

function matches(route, path) {
  if (!route) return true;
  if (typeof route === "string") return route === path;
  if (typeof route === "function") return Boolean(route(path));
  route.lastIndex = 0;
  return route.test(path);
}

export function onPageLoad(callback, options = {}) {
  const ownerDocument = document;
  let active = null;
  let disposed = false;

  const stop = () => {
    const previous = active;
    active = null;
    if (!previous) return;
    previous.controller.abort();
    for (const fn of [...previous.cleanups].reverse()) {
      try {
        fn();
      } catch (error) {
        console.error("Page cleanup failed", error);
      }
    }
  };

  const run = (visit = {}) => {
    if (disposed) return;
    const path =
      pathnameFromSwupUrl(visit.to?.url) ||
      document.body?.dataset?.route ||
      window.location.pathname;
    if (!matches(options.route, path)) return;
    if (!store.appReady && !options.skipAppReady) return;
    // Returning from a drawer reveals the original, still-mounted page.
    if (options.route && active?.path === path && visit.meta?.closeDetail) return;
    stop();
    const instance = { path, controller: new AbortController(), cleanups: new Set() };
    active = instance;
    const registerCleanup = (fn) => {
      if (typeof fn !== "function" || instance.cleanups.has(fn)) return;
      if (active !== instance) {
        try {
          fn();
        } catch (error) {
          console.error("Late page cleanup failed", error);
        }
      } else instance.cleanups.add(fn);
    };
    try {
      const result = callback({
        signal: instance.controller.signal,
        cleanup: registerCleanup,
      });
      if (result?.then) {
        result.then(registerCleanup).catch((error) => {
          if (!instance.controller.signal.aborted)
            console.error("Page initialization failed", error);
        });
      } else registerCleanup(result);
    } catch (error) {
      stop();
      console.error("Page initialization failed", error);
    }
  };

  const offView = onNavigation("page:view", run);
  const offLeave = onNavigation("page:leave", (visit) => {
    if (!active) return;
    if (
      options.route &&
      visit.meta?.detailVisit &&
      active.path === visit.meta.backgroundPath
    )
      return;
    stop();
  });
  const ready = () => {
    if (!active) run();
  };
  ownerDocument.addEventListener("appReady", ready);
  const timer = setTimeout(ready, 0);
  return () => {
    disposed = true;
    clearTimeout(timer);
    ownerDocument.removeEventListener?.("appReady", ready);
    offView();
    offLeave();
    stop();
  };
}
