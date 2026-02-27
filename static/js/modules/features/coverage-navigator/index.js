/* global mapboxgl */

import { DrivingNavigation } from "../../driving-navigation/manager.js";
import { DrivingNavigationUI } from "../../driving-navigation/ui.js";
import { createMap } from "../../map-core.js";
import { OptimalRoutesManager } from "../../optimal-route/manager.js";

const MAP_CONTAINER_ID = "coverage-map";

export default function initCoverageNavigatorPage({ cleanup } = {}) {
  const noopTeardown = () => {};

  if (typeof mapboxgl === "undefined") {
    const mapDiv = document.getElementById(MAP_CONTAINER_ID);
    if (mapDiv) {
      mapDiv.innerHTML =
        '<div class="alert alert-danger m-3">Error: Mapping library failed to load.</div>';
    }
    if (typeof cleanup === "function") {
      cleanup(noopTeardown);
    }
    return noopTeardown;
  }

  const container = document.getElementById(MAP_CONTAINER_ID);
  if (!container) {
    if (typeof cleanup === "function") {
      cleanup(noopTeardown);
    }
    return noopTeardown;
  }

  let sharedMap = null;
  let drivingNavigation = null;
  let optimalRoutes = null;

  try {
    sharedMap = createMap(MAP_CONTAINER_ID, {
      center: [-96, 37.8],
      zoom: 4,
    });
  } catch (error) {
    console.error("Coverage navigator map failed to initialize", error);
    if (typeof cleanup === "function") {
      cleanup(noopTeardown);
    }
    return noopTeardown;
  }

  DrivingNavigationUI.injectClusterStyles();

  drivingNavigation = new DrivingNavigation({
    mapContainerId: MAP_CONTAINER_ID,
    sharedMap,
    populateAreaSelect: false,
    loadCoverageAreas: false,
  });

  optimalRoutes = new OptimalRoutesManager({
    mapContainerId: MAP_CONTAINER_ID,
    sharedMap,
    addNavigationControl: false,
    populateAreaSelect: true,
    emitCoverageAreasLoaded: false,
    onCoverageAreasLoaded: (areas) => {
      drivingNavigation?.setCoverageAreas(areas);
    },
  });

  const teardown = () => {
    optimalRoutes?.destroy?.();
    optimalRoutes = null;
    drivingNavigation?.destroy?.();
    drivingNavigation = null;
    if (sharedMap) {
      try {
        sharedMap.remove();
      } catch {
        // Ignore cleanup errors.
      }
      sharedMap = null;
    }
  };

  if (typeof cleanup === "function") {
    cleanup(teardown);
  } else {
    return teardown;
  }

  return teardown;
}
