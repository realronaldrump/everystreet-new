/**
 * Upload Module Index
 * Re-exports all upload functionality for convenient imports
 */

// API
export {
  bulkDeleteTrips,
  deleteTrip,
  fetchTrips,
  fetchUploadedTrips,
  getBulkDeleteMessage,
  uploadFiles,
} from "./api.js";
// Constants
export {
  API_ENDPOINTS,
  CSS_CLASSES,
  DOM_IDS,
  MAP_CONFIG,
  PREVIEW_LAYER_STYLE,
  SUPPORTED_FILE_TYPES,
  UPLOAD_SOURCES,
} from "./constants.js";
// Parsers
export {
  getFileExtension,
  parseGeoJSON,
  parseGPX,
  readFileAsText,
} from "./parsers.js";
// Preview Map
export {
  getPreviewIds,
  initializePreviewMap,
  resetMapView,
  updatePreviewMap,
} from "./preview-map.js";
// UI
export {
  cacheElements,
  formatDate,
  getSelectedTripIds,
  renderFileList,
  renderUploadedTrips,
  resetSelectAllCheckbox,
  setUploadButtonState,
  updateBulkDeleteButtonState,
  updateStats,
} from "./ui.js";

// Main UploadManager class
export { UploadManager } from "./upload-manager.js";
