/**
 * Driving Navigation - Entry Point
 *
 * This file initializes the DrivingNavigation component on page load.
 * The actual implementation is in the modules/driving-navigation/ folder.
 *
 * @see modules/driving-navigation/manager.js - Main DrivingNavigation class
 * @see modules/driving-navigation/api.js - API interactions
 * @see modules/driving-navigation/map.js - Map management
 * @see modules/driving-navigation/ui.js - UI helpers
 * @see modules/driving-navigation/constants.js - Configuration constants
 */

/* global mapboxgl */

import { DrivingNavigation } from "./modules/driving-navigation/manager.js";
import { DrivingNavigationUI } from "./modules/driving-navigation/ui.js";
import { onPageLoad } from "./modules/utils.js";

/**
 * Initialize driving navigation when page is ready.
 */
onPageLoad(
  ({ cleanup } = {}) => {
    if (typeof mapboxgl === "undefined") {
      const mapContainerId
        = window.coverageNavigatorConfig?.drivingNavigation?.mapContainerId
        || "driving-map";
      const mapDiv = document.getElementById(mapContainerId);
      if (mapDiv) {
        mapDiv.innerHTML
          = '<div class="alert alert-danger m-3">Error: Mapping library failed to load.</div>';
      }
      return;
    }

    // Initialize driving navigation
    const navigation = new DrivingNavigation();

    // Inject cluster marker styles
    DrivingNavigationUI.injectClusterStyles();

    if (typeof cleanup === "function") {
      cleanup(() => navigation.destroy?.());
    }
  },
  { route: "/coverage-navigator" }
);
