/**
 * County Map Index Module
 * Re-exports all county map modules for convenient importing
 */

// Constants
export {
  RECALC_STORAGE_KEY,
  MAP_CONFIG,
  COLORS,
  STATE_FIPS_TO_NAME,
  getStateName,
} from "./constants.js";

// State management
export {
  default as CountyMapState,
  getMap,
  setMap,
  getCountyVisits,
  setCountyVisits,
  getCountyStops,
  setCountyStops,
  getCountyData,
  setCountyData,
  getStatesData,
  setStatesData,
  getIsRecalculating,
  setIsRecalculating,
  getShowStoppedCounties,
  setShowStoppedCounties,
  getRecalcPollerActive,
  setRecalcPollerActive,
  resetState,
} from "./state.js";

// API
export {
  default as CountyMapAPI,
  fetchCountyTopology,
  fetchVisitedCounties,
  triggerRecalculation,
  fetchCacheStatus,
} from "./api.js";

// Storage
export {
  default as CountyMapStorage,
  getStoredRecalcState,
  storeRecalcState,
  clearStoredRecalcState,
} from "./storage.js";

// UI
export {
  default as CountyMapUI,
  getRecalculateButtons,
  updateRecalculateUi,
  showRecalculatePrompt,
  updateLoadingText,
  hideLoading,
  updateLastUpdated,
  updateStats,
  formatDate,
  setupPanelToggle,
} from "./ui.js";

// Map layers
export {
  default as CountyMapLayers,
  addMapLayers,
  updateStopLayerVisibility,
  setHoverHighlight,
  getMapStyle,
} from "./map-layers.js";

// Interactions
export {
  default as CountyMapInteractions,
  setupInteractions,
} from "./interactions.js";

// State stats
export {
  default as CountyMapStateStats,
  calculateStateStats,
  renderStateStatsList,
  zoomToState,
  setupStateStatsToggle,
} from "./state-stats.js";

// Main
export { default as CountyMapMain, init } from "./main.js";
