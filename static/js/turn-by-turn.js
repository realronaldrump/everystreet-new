/**
 * Turn-by-Turn Navigation Entry Point
 *
 * This file initializes the modular turn-by-turn navigation system.
 * The implementation is split across multiple modules in ./modules/turn-by-turn/
 * for better organization and maintainability.
 *
 * Modules:
 * - turn-by-turn-config.js: Constants, defaults, and lookup tables
 * - turn-by-turn-api.js: API/network calls
 * - turn-by-turn-geo.js: Geo/math utility functions
 * - turn-by-turn-map.js: Mapbox map and layer management
 * - turn-by-turn-ui.js: DOM and UI updates
 * - turn-by-turn-gps.js: GPS/geolocation handling
 * - turn-by-turn-state.js: Navigation state machine
 * - turn-by-turn-coverage.js: Real-time segment tracking
 * - turn-by-turn-navigator.js: Main orchestrator class
 */

import TurnByTurnNavigator from "./modules/turn-by-turn/turn-by-turn-navigator.js";
import { onPageLoad } from "./modules/utils.js";

onPageLoad(
  () => {
    const navigator = new TurnByTurnNavigator();
    navigator.init();
  },
  { route: "/turn-by-turn" },
);
