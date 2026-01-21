import { createMap } from "./modules/map-base.js";
import { onPageLoad } from "./modules/utils.js";

const baseConfig = window.coverageNavigatorConfig || {};
const mapContainerId = baseConfig.mapContainerId || "coverage-map";

// DrivingNavigation should NOT populate the dropdown since OptimalRoutesManager does it
// This prevents duplicate entries
const drivingDefaults = {
  areaSelectId: "area-select",
  mapContainerId,
  useSharedMap: true,
  populateAreaSelect: false, // OptimalRoutesManager handles this
};

// OptimalRoutesManager populates the dropdown for both components
const optimalDefaults = {
  areaSelectId: "area-select",
  mapContainerId,
  useSharedMap: true,
  addNavigationControl: false,
  populateAreaSelect: true, // Only this one populates the dropdown
};

window.coverageNavigatorConfig = {
  ...baseConfig,
  mapContainerId,
  drivingNavigation: {
    ...drivingDefaults,
    ...(baseConfig.drivingNavigation || {}),
  },
  optimalRoutes: {
    ...optimalDefaults,
    ...(baseConfig.optimalRoutes || {}),
  },
};

onPageLoad(
  ({ cleanup } = {}) => {
    if (!createMap || typeof mapboxgl === "undefined") {
      console.error("Mapbox GL JS library not found. Coverage map cannot load.");
      return;
    }

    const container = document.getElementById(mapContainerId);
    if (!container || !window.MAPBOX_ACCESS_TOKEN) {
      return;
    }

    if (!window.coverageMasterMap) {
      window.coverageMasterMap = createMap(mapContainerId, {
        center: [-96, 37.8],
        zoom: 4,
        accessToken: window.MAPBOX_ACCESS_TOKEN,
      });
    }

    if (typeof cleanup === "function") {
      cleanup(() => {
        if (window.coverageMasterMap) {
          try {
            window.coverageMasterMap.remove();
          } catch {
            // Ignore cleanup errors.
          }
          window.coverageMasterMap = null;
        }
      });
    }
  },
  { route: "/coverage-navigator" }
);
