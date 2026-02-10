const loadedRoutes = new Set();

function getStaticVersion() {
  const script = document.querySelector('script[type="module"][src*="/static/js/app.js"]');
  if (!script?.src) {
    return "";
  }
  try {
    const url = new URL(script.src, window.location.origin);
    return url.searchParams.get("v") || "";
  } catch {
    return "";
  }
}

function withVersion(specifier) {
  const v = getStaticVersion();
  if (!v) {
    return specifier;
  }
  const join = specifier.includes("?") ? "&" : "?";
  return `${specifier}${join}v=${encodeURIComponent(v)}`;
}

async function importOnce(key, specifier) {
  if (loadedRoutes.has(key)) {
    return;
  }
  loadedRoutes.add(key);
  try {
    await import(withVersion(specifier));
  } catch (error) {
    loadedRoutes.delete(key);
    console.error(`Failed to import route module: ${key}`, error);
  }
}

function normalizePathname(pathname) {
  if (typeof pathname !== "string" || !pathname) {
    return "/";
  }
  if (pathname === "/") {
    return "/";
  }
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

export async function ensureRouteModule(pathname) {
  const path = normalizePathname(pathname);

  if (path === "/") {
    await importOnce("/", "../../pages/landing.js");
    return;
  }
  if (path === "/map") {
    await importOnce("/map", "../../pages/map.js");
    return;
  }
  if (path === "/trips" || path.startsWith("/trips/")) {
    await importOnce("/trips", "../../pages/trips.js");
    return;
  }
  if (path === "/routes" || path.startsWith("/routes/")) {
    await importOnce("/routes", "../../pages/routes.js");
    return;
  }
  if (path === "/insights") {
    await importOnce("/insights", "../../pages/insights.js");
    return;
  }
  if (path === "/visits") {
    await importOnce("/visits", "../../pages/visits.js");
    return;
  }
  if (path === "/settings") {
    await importOnce("/settings", "../../pages/settings.js");
    return;
  }
  if (path === "/profile") {
    await importOnce("/profile", "../../pages/profile.js");
    return;
  }
  if (path === "/vehicles") {
    await importOnce("/vehicles", "../../pages/vehicles.js");
    return;
  }
  if (path === "/gas-tracking") {
    await importOnce("/gas-tracking", "../../pages/gas-tracking.js");
    return;
  }
  if (path === "/map-matching") {
    await importOnce("/map-matching", "../../pages/map-matching.js");
    return;
  }
  if (path === "/coverage-management") {
    await importOnce("/coverage-management", "../../pages/coverage-management.js");
    return;
  }
  if (path === "/coverage-navigator") {
    await importOnce("/coverage-navigator", "../../pages/coverage-navigator.js");
    return;
  }
  if (path === "/turn-by-turn") {
    await importOnce("/turn-by-turn", "../../pages/turn-by-turn.js");
    return;
  }
  if (path === "/county-map") {
    await importOnce("/county-map", "../../pages/county-map.js");
    return;
  }
  if (path === "/export") {
    await importOnce("/export", "../../pages/export.js");
    return;
  }
  if (path === "/setup-wizard") {
    await importOnce("/setup-wizard", "../../pages/setup-wizard.js");
    return;
  }
  if (path === "/server-logs") {
    await importOnce("/server-logs", "../../pages/server-logs.js");
    return;
  }
  if (path === "/status") {
    await importOnce("/status", "../../pages/status.js");
  }
}
