import { DrivingNavigation } from "../../driving-navigation/manager.js";
import { DrivingNavigationUI } from "../../driving-navigation/ui.js";
import { createMap } from "../../map-core.js";
import { OptimalRoutesManager } from "../../optimal-route/manager.js";
import initCoverageRoutePlannerUi from "./ui-scaffold.js";

const MAP_CONTAINER_ID = "coverage-map";

export default function initCoverageRoutePlannerPage(context = {}) {
  const { signal = null, cleanup = null, onCleanup = () => {} } = context;
  const noopTeardown = () => {};

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

  initCoverageRoutePlannerUi({ signal, onCleanup });

  try {
    sharedMap = createMap(MAP_CONTAINER_ID, {
      center: [-96, 37.8],
      zoom: 4,
    });
  } catch (error) {
    console.error("Route planner map failed to initialize", error);
    container.innerHTML =
      '<div class="alert alert-danger m-3">Error: Mapping library failed to initialize.</div>';
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

  let tornDown = false;
  const teardown = () => {
    if (tornDown) {
      return;
    }
    tornDown = true;
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

  onCleanup(teardown);

  if (typeof cleanup === "function") {
    cleanup(teardown);
  } else {
    return teardown;
  }

  return teardown;
}
