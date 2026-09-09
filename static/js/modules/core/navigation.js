import { ensureRouteModule } from "./route-loader.js";
import store from "./store.js";
import { emitNavigation, pathnameFromSwupUrl } from "./navigation-events.js";
import { shouldSkipPopState, detailParent } from "./navigation-policy.js";
import { createNavigationUI } from "./navigation-ui.js";
export { pathnameFromSwupUrl } from "./navigation-events.js";

let swup = null;
let resolveReady = null;

export const swupReady = new Promise((resolve) => {
  resolveReady = resolve;
});

let initialization = null;

async function loadSwupDeps() {
  return import("../../vendor/swup.js");
}

export async function navigate(url, options = {}) {
  const instance = await swupReady;
  if (instance) instance.navigate(url, options);
  else window.location.assign(url);
}

export function invalidateNavigationCache() {
  swup?.cache.clear();
}

export function initNavigation() {
  if (!initialization) {
    initialization = initializeNavigation().catch((error) => {
      swup?.destroy();
      swup = null;
      resolveReady?.(null);
      throw error;
    });
  }
  return initialization;
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
      meta.setAttribute("content", isLight ? "#f4f1e8" : "#050507");
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
  if (pathname.startsWith("/coverage-management/")) {
    return "/coverage-management";
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
  ["/coverage-diorama", "Coverage Diorama"],
  ["/control-center", "Settings"],
  ["/vehicles", "My Vehicle"],
  ["/setup-wizard", "Setup"],
  ["/login", "Owner Login"],
]);

const BREADCRUMB_DETAIL_ROUTES = [
  {
    pattern: /^\/coverage-management\/[^/]+\/journal$/,
    parent: "/coverage-management",
    label: "Field Journal",
  },
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
    path = new URL(path, globalThis.location?.origin || "https://www.everystreet.me")
      .pathname;
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

  const detailRoute = BREADCRUMB_DETAIL_ROUTES.find((route) =>
    route.pattern.test(path)
  );
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
  const isMap = pathname === "/map" || document.body.dataset.backgroundRoute === "/map";
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
  const path = pathnameFromSwupUrl(href);
  if (path === "/login" || path === "/logout" || path?.startsWith("/api/")) return true;
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

async function initializeNavigation() {
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
  let SwupFragmentPlugin = null;

  try {
    ({
      Swup,
      SwupHeadPlugin,
      SwupPreloadPlugin,
      SwupScrollPlugin,
      SwupProgressPlugin,
      SwupA11yPlugin,
      SwupFragmentPlugin,
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

  if (typeof SwupFragmentPlugin !== "function") missing.push("SwupFragmentPlugin");

  if (missing.length > 0) {
    throw new Error(`Swup dependencies missing: ${missing.join(", ")}`);
  }

  const navigationUI = createNavigationUI(navigate);
  let renderedUrl = window.location.pathname + window.location.search;
  swup = new Swup({
    containers: ["#route-content", "#detail-content"],
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
    skipPopStateHandling: (event) =>
      !swup?.navigating &&
      shouldSkipPopState(
        event,
        document.body?.dataset?.detailRoute || document.body?.dataset?.route,
        window.location.pathname
      ),
    ignoreVisit: shouldIgnoreVisit,
    plugins: [
      new SwupHeadPlugin({
        awaitAssets: true,
        timeout: 5000,
        persistTags: (tag) =>
          tag.dataset?.esBackgroundStyle === "true" ||
          tag.matches?.("script[src], style, link[data-es-map-style]"),
        attributes: ["lang", "dir", "class", /^data-/],
      }),
      new SwupPreloadPlugin({ preloadInitialPage: true }),
      new SwupFragmentPlugin({
        rules: [
          {
            from: /.*/,
            to: [/^\/trips\/[^/]+$/, /^\/coverage-management\/[^/]+\/journal$/],
            containers: ["#detail-content"],
            name: "detail",
            focus: false,
            if: (visit) =>
              !detailParent(pathnameFromSwupUrl(visit.from.url)) ||
              Boolean(navigationUI.backgroundUrl),
          },
          {
            from: /.*/,
            to: /.*/,
            containers: ["#detail-content"],
            name: "detail-close",
            focus: false,
            if: (visit) => navigationUI.isClosing(visit),
          },
        ],
      }),
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
      if (swup?.navigating) return;
      // Detail filters belong to the drawer (e.g. Journal range/as-of). They
      // must not change date/vehicle filters on the retained background page.
      if (document.body?.dataset?.detailRoute) return;
      const renderedRoute =
        document.body?.dataset?.detailRoute || document.body?.dataset?.route;
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
    navigationUI.prepare(visit);
    // Start imports early, then explicitly await them before touching the old page.
    visit.meta.routeModule = ensureRouteModule(pathnameFromSwupUrl(visit.to.url));
    visit.meta.routeModule.catch(() => {});
  });

  swup.hooks.before(
    "content:replace",
    async (visit) => {
      await visit.meta.routeModule;
      if (visit.done) return;
      const version = visit.to.document?.querySelector(
        'meta[name="es-build"]'
      )?.content;
      const currentVersion = document.querySelector('meta[name="es-build"]')?.content;
      const role = visit.to.document?.body?.dataset.authRole;
      if (
        (version && currentVersion && version !== currentVersion) ||
        (role && role !== document.body.dataset.authRole)
      ) {
        visit.ignore();
        throw new Error("The application session changed; reload the document.");
      }
      emitNavigation("page:leave", visit);
    },
    { priority: -100 }
  );

  swup.hooks.on("content:replace", (visit) => {
    updatePersistentShell(visit);
    navigationUI.replaced(visit);
    const path = pathnameFromSwupUrl(visit.to.url);
    renderedUrl = visit.to.url;
    if (detailParent(path)) document.body.dataset.detailRoute = path;
    else delete document.body.dataset.detailRoute;
    setRouteState(document.body.dataset.backgroundRoute || path);
  });

  swup.hooks.on("page:view", (visit) => {
    applyThemeFromStorage();
    store.clearElementCache();
    // Detail visits do not reset the filters of the page underneath.
    if (!visit.meta.detailVisit) {
      store.applyUrlParams(visit.to.url, {
        emit: true,
        source: visit.history.popstate ? "popstate" : "navigate",
      });
    }
    updateRouteTelemetryAndBreadcrumb(window.location.pathname);
    emitNavigation("page:view", visit);
    navigationUI.viewed(visit);
  });
  for (const hook of ["visit:end", "visit:abort", "visit:fail"]) {
    swup.hooks.on(hook, (visit) => navigationUI.finish(visit));
  }
  document.addEventListener("es:data-changed", invalidateNavigationCache);
  document.addEventListener("historicalTripsUpdated", invalidateNavigationCache);
  swup.hooks.on("cache:set", (_visit, { page }) => {
    swup.cache.update(page.url, { cachedAt: Date.now() });
    if (swup.cache.size > 30) swup.cache.delete(swup.cache.all.keys().next().value);
  });
  swup.hooks.before("visit:start", (visit) => {
    if (!visit.history.popstate) {
      const renderedPath =
        document.body.dataset.detailRoute || document.body.dataset.route;
      if (window.location.pathname === renderedPath)
        renderedUrl = window.location.pathname + window.location.search;
      visit.from.url = renderedUrl;
    }
    swup.cache.prune(
      (_url, page) => !page.cachedAt || Date.now() - page.cachedAt > 90000
    );
  });
  let intentTimer;
  const prepareLink = (event) => {
    clearTimeout(intentTimer);
    const link = event.target.closest?.("a[href]");
    if (!link || shouldIgnoreVisit(link.href, { el: link }) || !isInternalLink(link))
      return;
    if (navigator.connection?.saveData) return;
    intentTimer = setTimeout(() => {
      void ensureRouteModule(new URL(link.href).pathname).catch(() => {});
    }, 100);
  };
  document.addEventListener("pointerover", prepareLink, { passive: true });
  document.addEventListener("focusin", prepareLink);

  // Initial route module and state.
  await ensureRouteModule(window.location.pathname);
  setRouteState(window.location.pathname);
  updateRouteTelemetryAndBreadcrumb(window.location.pathname);

  if (detailParent(window.location.pathname)) {
    document.body.dataset.detailRoute = window.location.pathname;
    const initialVisit = { to: { url: window.location.href }, meta: {} };
    navigationUI.replaced(initialVisit);
    navigationUI.viewed(initialVisit);
  }
  resolveReady?.(swup);
  return swup;
}
