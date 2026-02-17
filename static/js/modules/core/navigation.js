import { ensureRouteModule } from "./route-loader.js";
import store from "./store.js";

let swup = null;
let resolveReady = null;

export const swupReady = new Promise((resolve) => {
  resolveReady = resolve;
});

export function getSwup() {
  return swup;
}

function pathnameFromSwupUrl(urlish) {
  if (!urlish) {
    return null;
  }
  // Swup v4 uses strings for visit.to.url / visit.from.url (pathname + search).
  if (typeof urlish === "string") {
    try {
      return new URL(urlish, window.location.origin).pathname || null;
    } catch {
      const trimmed = urlish.trim();
      if (!trimmed) {
        return null;
      }
      return trimmed.split("#")[0].split("?")[0] || null;
    }
  }
  // Tolerate URL-like objects.
  if (typeof urlish === "object") {
    if (typeof urlish.pathname === "string" && urlish.pathname) {
      return urlish.pathname;
    }
    if (typeof urlish.href === "string" && urlish.href) {
      try {
        return new URL(urlish.href, window.location.origin).pathname || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function urlFromSwupUrl(urlish) {
  if (!urlish) {
    return null;
  }
  if (typeof urlish === "string") {
    return urlish;
  }
  if (typeof urlish === "object") {
    if (typeof urlish.href === "string" && urlish.href) {
      return urlish.href;
    }
    if (typeof urlish.pathname === "string" && urlish.pathname) {
      return urlish.pathname;
    }
  }
  return null;
}

async function loadSwupDeps() {
  const [swupMod, headMod, preloadMod, scrollMod, progressMod, a11yMod] =
    await Promise.all([
      import("https://cdn.jsdelivr.net/npm/swup@4.8.2/+esm"),
      import("https://cdn.jsdelivr.net/npm/@swup/head-plugin@2.3.1/+esm"),
      import("https://cdn.jsdelivr.net/npm/@swup/preload-plugin@3.2.11/+esm"),
      import("https://cdn.jsdelivr.net/npm/@swup/scroll-plugin@4.0.0/+esm"),
      import("https://cdn.jsdelivr.net/npm/@swup/progress-plugin@3.2.0/+esm"),
      import("https://cdn.jsdelivr.net/npm/@swup/a11y-plugin@5.0.0/+esm"),
    ]);

  return {
    Swup: swupMod?.default,
    SwupHeadPlugin: headMod?.default,
    SwupPreloadPlugin: preloadMod?.default,
    SwupScrollPlugin: scrollMod?.default,
    SwupProgressPlugin: progressMod?.default,
    SwupA11yPlugin: a11yMod?.default,
  };
}

function applyThemeFromStorage() {
  try {
    const savedTheme = localStorage.getItem("theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = savedTheme || (prefersDark ? "dark" : "light");
    const isLight = theme === "light";

    document.documentElement.setAttribute("data-bs-theme", theme);
    document.documentElement.classList.toggle("light-mode", isLight);
    document.body?.classList.toggle("light-mode", isLight);
    document.documentElement.classList.add("swup-native");

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", isLight ? "#fafafa" : "#0a0a0c");
    }
  } catch {
    // Theme is best-effort.
  }
}

function isInternalLink(anchor) {
  if (!(anchor instanceof HTMLAnchorElement)) {
    return false;
  }
  const href = anchor.getAttribute("href") || "";
  if (!href || href.startsWith("#")) {
    return false;
  }
  if (href.startsWith("mailto:") || href.startsWith("tel:")) {
    return false;
  }
  try {
    const url = new URL(anchor.href, window.location.origin);
    return url.origin === window.location.origin;
  } catch {
    return false;
  }
}

function normalizeForNav(pathname) {
  if (typeof pathname !== "string") {
    return "/";
  }
  if (pathname === "/trips" || pathname.startsWith("/trips/")) {
    return "/trips";
  }
  if (pathname === "/routes" || pathname.startsWith("/routes/")) {
    return "/routes";
  }
  return pathname;
}

function updateNav(pathname) {
  if (!pathname) {
    return;
  }
  const activePath = normalizeForNav(pathname);

  document.querySelectorAll("nav a[href]").forEach((anchor) => {
    if (!isInternalLink(anchor)) {
      return;
    }
    const url = new URL(anchor.href, window.location.origin);
    const isActive = normalizeForNav(url.pathname) === activePath;
    anchor.classList.toggle("active", isActive);
    if (isActive) {
      anchor.setAttribute("aria-current", "page");
    } else {
      anchor.removeAttribute("aria-current");
    }
  });

  document.querySelectorAll(".nav-item").forEach((item) => {
    const link = item.querySelector("a[href]");
    if (!link || !isInternalLink(link)) {
      return;
    }
    const url = new URL(link.href, window.location.origin);
    item.classList.toggle("active", normalizeForNav(url.pathname) === activePath);
  });
}

function updateMapShellA11y(pathname) {
  const isMap = pathname === "/map";
  const shell = document.getElementById("persistent-shell");
  if (shell) {
    if (!isMap) {
      const focused = shell.querySelector(":focus");
      if (focused && typeof focused.blur === "function") {
        focused.blur();
      }
    }
    shell.setAttribute("aria-hidden", isMap ? "false" : "true");
    if (typeof shell.toggleAttribute === "function") {
      shell.toggleAttribute("inert", !isMap);
    } else if (!isMap) {
      shell.setAttribute("inert", "");
    } else {
      shell.removeAttribute("inert");
    }
  }

  const mapCanvas = document.getElementById("map-canvas");
  if (mapCanvas) {
    if (isMap) {
      mapCanvas.removeAttribute("aria-hidden");
      mapCanvas.removeAttribute("inert");
    } else {
      mapCanvas.setAttribute("aria-hidden", "true");
      mapCanvas.setAttribute("inert", "");
    }
  }
}

function updatePersistentShell(visit) {
  const shell = document.getElementById("persistent-shell");
  const incomingShell = visit?.to?.document?.querySelector?.("#persistent-shell");
  if (!shell || !incomingShell) {
    return;
  }

  const trimmed = (incomingShell.innerHTML || "").trim();
  if (!trimmed) {
    // Keep already-loaded persistent shell (map stays alive across visits).
    return;
  }

  const template = document.createElement("template");
  template.innerHTML = trimmed;
  const incomingId = template.content.firstElementChild?.dataset?.esShellId || null;
  const existingId = shell.firstElementChild?.dataset?.esShellId || null;
  const hasExisting = shell.innerHTML.trim().length > 0;

  if (!hasExisting || incomingId !== existingId) {
    shell.innerHTML = "";
    shell.appendChild(template.content);
  }
}

const HISTORY_KEY = "es:route-history";

function loadRouteHistory() {
  try {
    const raw = sessionStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.slice(-8);
    }
  } catch {
    // Ignore parse errors.
  }
  return [
    { path: window.location.pathname, title: document.title, timestamp: Date.now() },
  ];
}

function saveRouteHistory(items) {
  try {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(-8)));
  } catch {
    // Ignore storage failures.
  }
}

function updateRouteUsage(path) {
  try {
    const raw = localStorage.getItem("es:route-counts");
    const counts = raw ? JSON.parse(raw) : {};
    counts[path] = (counts[path] || 0) + 1;
    localStorage.setItem("es:route-counts", JSON.stringify(counts));
  } catch {
    // Ignore storage failures.
  }
}

function updateBreadcrumb(routeHistory) {
  const trail = document.getElementById("nav-trail");
  const container = document.getElementById("nav-breadcrumb");
  if (!trail || !container) {
    return;
  }

  const items = routeHistory.slice(-3);
  trail.innerHTML = "";

  items.forEach((item, index) => {
    if (index > 0) {
      const divider = document.createElement("span");
      divider.className = "nav-trail-sep";
      divider.textContent = "›";
      trail.appendChild(divider);
    }

    const link = document.createElement("a");
    link.href = item.path;
    link.className = "nav-trail-item";
    link.textContent = item.title || item.path;
    if (index === items.length - 1) {
      link.setAttribute("aria-current", "page");
      link.classList.add("current");
    }
    trail.appendChild(link);
  });

  container.classList.toggle("is-empty", items.length === 0);
}

function updateHistoryAndBreadcrumb(pathname) {
  if (!pathname) {
    return;
  }

  const label = document.title || pathname;
  const now = Date.now();

  const history = loadRouteHistory();
  const last = history[history.length - 1];
  if (last && last.path === pathname) {
    last.title = label;
    last.timestamp = now;
  } else {
    history.push({ path: pathname, title: label, timestamp: now });
  }

  const trimmed = history.slice(-8);
  saveRouteHistory(trimmed);
  updateRouteUsage(pathname);
  updateBreadcrumb(trimmed);
}

function setRouteState(pathname) {
  const path = pathname || window.location.pathname;
  document.body.dataset.route = path;
  document.body.classList.toggle("map-page", path === "/map");
  document.body.classList.toggle("turn-by-turn-active", path === "/turn-by-turn");
  updateNav(path);
  updateMapShellA11y(path);
}

function shouldIgnoreVisit(url, { el, event } = {}) {
  if (el?.closest?.("[data-no-swup]")) {
    return true;
  }

  const href = typeof url === "string" ? url : url?.toString?.() || "";
  if (!href) {
    return true;
  }
  if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) {
    return true;
  }

  if (el?.getAttribute?.("data-bs-toggle")) {
    return true;
  }
  if (el?.hasAttribute?.("download")) {
    return true;
  }
  const target = el?.target;
  if (target && target !== "_self") {
    return true;
  }

  if (event) {
    const isLeftClick = typeof event.button === "number" ? event.button === 0 : true;
    if (!isLeftClick) {
      return true;
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return true;
    }
  }

  return false;
}

export async function initNavigation() {
  if (swup) {
    return swup;
  }

  // Apply persisted theme once before swup plugins start syncing head/attributes.
  applyThemeFromStorage();

  let Swup = null;
  let SwupHeadPlugin = null;
  let SwupPreloadPlugin = null;
  let SwupScrollPlugin = null;
  let SwupProgressPlugin = null;
  let SwupA11yPlugin = null;

  try {
    ({
      Swup,
      SwupHeadPlugin,
      SwupPreloadPlugin,
      SwupScrollPlugin,
      SwupProgressPlugin,
      SwupA11yPlugin,
    } = await loadSwupDeps());
  } catch (error) {
    throw new Error(`Swup failed to load: ${error instanceof Error ? error.message : error}`);
  }

  const missing = [];
  if (typeof Swup !== "function") {
    missing.push("Swup");
  }
  if (typeof SwupHeadPlugin !== "function") {
    missing.push("SwupHeadPlugin");
  }
  if (typeof SwupPreloadPlugin !== "function") {
    missing.push("SwupPreloadPlugin");
  }
  if (typeof SwupScrollPlugin !== "function") {
    missing.push("SwupScrollPlugin");
  }
  if (typeof SwupProgressPlugin !== "function") {
    missing.push("SwupProgressPlugin");
  }
  if (typeof SwupA11yPlugin !== "function") {
    missing.push("SwupA11yPlugin");
  }

  if (missing.length > 0) {
    throw new Error(`Swup dependencies missing: ${missing.join(", ")}`);
  }

  swup = new Swup({
    containers: ["#route-content"],
    native: true,
    // We're using the browser's View Transitions API (native mode) + our own
    // view-transition CSS. Swup's default animationSelector looks for
    // `[class*="transition-"]` and warns if none exist.
    animationSelector: false,
    cache: true,
    animateHistoryBrowsing: true,
    linkToSelf: "scroll",
    // Some UI interactions (filters, map state, etc.) push history entries that should not
    // trigger a full Swup navigation. However, those same entries can be reached via
    // back/forward *across routes*; in that case Swup must handle the popstate or the URL
    // and rendered content will drift out of sync.
    skipPopStateHandling: (event) => {
      const source = event?.state?.source;
      if (!source || source === "swup") {
        return false;
      }

      const renderedRoute = document.body?.dataset?.route;
      if (!renderedRoute) {
        // Be conservative: if we can't verify the currently-rendered route, let Swup handle.
        return false;
      }

      // Only skip non-swup popstates when the URL change stays on the currently-rendered route.
      return window.location.pathname === renderedRoute;
    },
    ignoreVisit: shouldIgnoreVisit,
    plugins: [
      new SwupHeadPlugin({
        awaitAssets: true,
        timeout: 5000,
        attributes: ["lang", "dir", "class", /^data-/],
      }),
      new SwupPreloadPlugin({ preloadInitialPage: true }),
      new SwupScrollPlugin({
        animateScroll: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      }),
      new SwupProgressPlugin({
        className: "swup-progress-bar",
        delay: 300,
        transition: 150,
        initialValue: 0.25,
        finishAnimation: true,
      }),
      new SwupA11yPlugin({
        respectReducedMotion: true,
        headingSelector: "h1",
      }),
    ],
  });

  // Swup uses this class in native mode; head syncing can wipe it.
  document.documentElement.classList.add("swup-native");

  // Handle "store-only" history entries (filters, URL-state changes) without triggering
  // a swup page transition.
  window.addEventListener("popstate", (event) => {
    if (event.state?.source === "es-store") {
      const renderedRoute = document.body?.dataset?.route;
      // Only apply URL params directly when the popstate stays on the same rendered route.
      // Cross-route browsing should be handled by Swup, which will call applyUrlParams after
      // the correct page content is loaded.
      if (!renderedRoute || window.location.pathname !== renderedRoute) {
        return;
      }

      store.applyUrlParams(window.location.href, {
        emit: true,
        source: "popstate",
      });
    }
  });

  swup.hooks.on("visit:start", (visit) => {
    const toPath = pathnameFromSwupUrl(visit?.to?.url);
    ensureRouteModule(toPath || window.location.pathname);
  });

  swup.hooks.on("content:replace", (visit) => {
    updatePersistentShell(visit);
    const toPath = pathnameFromSwupUrl(visit?.to?.url);
    setRouteState(toPath || window.location.pathname);
  });

  swup.hooks.on("page:view", (visit) => {
    applyThemeFromStorage();

    const href = urlFromSwupUrl(visit?.to?.url) || window.location.href;
    const source = visit?.history?.popstate ? "popstate" : "navigate";
    store.applyUrlParams(href, { emit: true, source });
    store.clearElementCache();

    updateHistoryAndBreadcrumb(window.location.pathname);
  });

  // Initial route module and state.
  await ensureRouteModule(window.location.pathname);
  setRouteState(window.location.pathname);
  updateHistoryAndBreadcrumb(window.location.pathname);

  resolveReady?.(swup);
  return swup;
}
