import { ensureLibraries } from "./library-loader.js";

const loadedRoutes = new Set();

async function importOnce([pattern, specifier, libraries = []]) {
  const key = pattern.replace(/\*$/, "");
  if (loadedRoutes.has(key)) {
    return;
  }
  loadedRoutes.add(key);
  try {
    try {
      await ensureLibraries(libraries);
    } catch (error) {
      console.error(`Failed to load route libraries: ${key}`, error);
    }
    await import(specifier);
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

const routes = [
  ["/", "../../pages/landing.js"],
  ["/map", "../../pages/map.js", ["map", "deck"]],
  ["/trips/*", "../../pages/trips.js", ["map"]],
  ["/routes/*", "../../pages/routes.js", ["map", "chart"]],
  ["/insights", "../../pages/insights.js", ["chart", "deck", "plot"]],
  ["/visits", "../../pages/visits.js", ["map", "mapDraw", "chart", "datatables"]],
  ["/control-center", "../../pages/control-center.js"],
  ["/vehicles", "../../pages/vehicles.js"],
  ["/gas-tracking", "../../pages/gas-tracking.js", ["map"]],
  ["/map-matching", "../../pages/map-matching.js", ["map"]],
  ["/coverage-management", "../../pages/coverage-management.js", ["map"]],
  ["/coverage-route-planner", "../../pages/coverage-route-planner.js", ["map"]],
  ["/live-navigation", "../../pages/live-navigation.js", ["map"]],
  [
    "/regional-coverage-explorer",
    "../../pages/regional-coverage-explorer.js",
    ["map", "topojson"],
  ],
  ["/export", "../../pages/export.js"],
  ["/setup-wizard", "../../pages/setup-wizard.js"],
];

function routeMatches([pattern], path) {
  if (!pattern.endsWith("*")) {
    return path === pattern;
  }
  const prefix = pattern.slice(0, -1);
  return path === prefix.slice(0, -1) || path.startsWith(prefix);
}

export async function ensureRouteModule(pathname) {
  const path = normalizePathname(pathname);
  const route = routes.find((candidate) => routeMatches(candidate, path));
  if (route) {
    await importOnce(route);
  }
}
