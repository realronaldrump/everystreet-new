import { ensureRouteModule } from "./route-loader.js";
import store from "./store.js";

let swup = null;
let resolveReady = null;

export const swupReady = new Promise((resolve) => {
  resolveReady = resolve;
});

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

const BREADCRUMB_ROUTE_LABELS = new Map([
  ["/", "Home"],
  ["/map", "Map"],
  ["/trips", "Trips"],
  ["/routes", "Recurring Routes"],
  ["/insights", "Insights"],
  ["/visits", "Visits"],
  ["/gas-tracking", "Gas Tracking"],
  ["/export", "Export Data"],
  ["/map-matching", "Map Matching"],
  ["/coverage-management", "Coverage Management"],
  ["/coverage-route-planner", "Route Planner"],
  ["/live-navigation", "Live Navigation"],
  ["/regional-coverage-explorer", "Region Explorer"],
  ["/memory-city", "Memory City"],
  ["/control-center", "Settings"],
  ["/vehicles", "My Vehicle"],
  ["/setup-wizard", "Setup"],
  ["/login", "Owner Login"],
]);

const BREADCRUMB_DETAIL_ROUTES = [
  {
    pattern: /^\/trips\/[^/]+$/,
    parent: "/trips",
    label: "Trip Details",
  },
  {
    pattern: /^\/routes\/[^/]+$/,
    parent: "/routes",
    label: "Route Details",
  },
];

function normalizeBreadcrumbPath(pathname) {
  if (typeof pathname !== "string" || !pathname.trim()) {
    return "/";
  }

  let path = pathname.trim();
  try {
    path = new URL(path, globalThis.location?.origin || "http://localhost").pathname;
  } catch {
    path = path.split("#")[0].split("?")[0] || "/";
  }

  if (path.length > 1 && path.endsWith("/")) {
    return path.slice(0, -1);
  }
  return path || "/";
}

export function buildBreadcrumbItems(pathname) {
  const path = normalizeBreadcrumbPath(pathname);
  const exactLabel = BREADCRUMB_ROUTE_LABELS.get(path);
  if (exactLabel) {
    return [{ path, label: exactLabel }];
  }

  const detailRoute = BREADCRUMB_DETAIL_ROUTES.find((route) => route.pattern.test(path));
  if (detailRoute) {
    return [
      {
        path: detailRoute.parent,
        label: BREADCRUMB_ROUTE_LABELS.get(detailRoute.parent) || detailRoute.parent,
      },
      {
        path,
        label: detailRoute.label,
      },
    ];
  }

  return [];
}

function shouldShowBreadcrumb(items) {
  return items.length > 1;
}

function updateNav(pathname) {
  if (!pathname) {
    return;
  }
  const activePath = normalizeForNav(pathname);

  document.querySelectorAll("nav a[href]").forEach((anchor) => {
    if (anchor.closest(".nav-breadcrumb")) {
      return;
    }
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

function updateBreadcrumb(pathname) {
  const trail = document.getElementById("nav-trail");
  const container = document.getElementById("nav-breadcrumb");
  if (!trail || !container) {
    return;
  }

  const items = buildBreadcrumbItems(pathname);
  const visible = shouldShowBreadcrumb(items);
  trail.innerHTML = "";
  container.hidden = !visible;
  container.classList.toggle("is-empty", !visible);

  if (!visible) {
    return;
  }

  items.forEach((item, index) => {
    const entry = document.createElement("li");
    entry.className = "nav-trail-entry";

    if (index > 0) {
      const divider = document.createElement("span");
      divider.className = "nav-trail-sep";
      divider.textContent = "›";
      divider.setAttribute("aria-hidden", "true");
      divider.style.opacity = "0";
      divider.style.animation = `fadeIn 150ms ${60 + index * 40}ms cubic-bezier(0, 0, 0.2, 1) forwards`;
      entry.appendChild(divider);
    }

    if (index === items.length - 1) {
      const current = document.createElement("span");
      current.className = "nav-trail-item current";
      current.textContent = item.label;
      current.setAttribute("aria-current", "page");
      current.style.opacity = "0";
      current.style.animation = `fadeInUp 200ms ${80 + index * 50}ms cubic-bezier(0, 0, 0.2, 1) forwards`;
      entry.appendChild(current);
    } else {
      const link = document.createElement("a");
      link.href = item.path;
      link.className = "nav-trail-item";
      link.textContent = item.label;
      link.style.opacity = "0";
      link.style.animation = `fadeInUp 200ms ${80 + index * 50}ms cubic-bezier(0, 0, 0.2, 1) forwards`;
      entry.appendChild(link);
    }

    trail.appendChild(entry);
  });
}

function updateRouteTelemetryAndBreadcrumb(pathname) {
  if (!pathname) {
    return;
  }

  updateRouteUsage(pathname);
  updateBreadcrumb(pathname);
}

function setRouteState(pathname) {
  const path = pathname || window.location.pathname;
  document.body.dataset.route = path;
  document.body.classList.toggle("map-page", path === "/map");
  document.body.classList.toggle("live-navigation-active", path === "/live-navigation");
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
    throw new Error(
      `Swup failed to load: ${error instanceof Error ? error.message : error}`
    );
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
        scrollFriction: 0.3,
        scrollAcceleration: 0.04,
      }),
      new SwupProgressPlugin({
        className: "swup-progress-bar",
        delay: 200,
        transition: 100,
        initialValue: 0.3,
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

    updateRouteTelemetryAndBreadcrumb(window.location.pathname);
  });

  // Initial route module and state.
  await ensureRouteModule(window.location.pathname);
  setRouteState(window.location.pathname);
  updateRouteTelemetryAndBreadcrumb(window.location.pathname);

  resolveReady?.(swup);
  return swup;
}
