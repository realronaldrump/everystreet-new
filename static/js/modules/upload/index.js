/**
 * Upload Module Index
 * Re-exports all upload functionality for convenient imports
 */

// Constants
export {
  MAP_CONFIG,
  SUPPORTED_FILE_TYPES,
  UPLOAD_SOURCES,
  API_ENDPOINTS,
  PREVIEW_LAYER_STYLE,
  DOM_IDS,
  CSS_CLASSES,
} from "./constants.js";

// Parsers
export {
  readFileAsText,
  getFileExtension,
  parseGPX,
  parseGeoJSON,
} from "./parsers.js";

// Preview Map
export {
  initializePreviewMap,
  updatePreviewMap,
  resetMapView,
  getPreviewIds,
} from "./preview-map.js";

// UI
export {
  cacheElements,
  formatDate,
  renderFileList,
  updateStats,
  setUploadButtonState,
  renderUploadedTrips,
  getSelectedTripIds,
  updateBulkDeleteButtonState,
  resetSelectAllCheckbox,
} from "./ui.js";

// API
export {
  uploadFiles,
  fetchTrips,
  fetchUploadedTrips,
  deleteTrip,
  bulkDeleteTrips,
  getBulkDeleteMessage,
} from "./api.js";

// Main UploadManager class
export { UploadManager } from "./upload-manager.js";
