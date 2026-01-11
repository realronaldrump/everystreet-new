/**
 * Upload Module Constants
 * Shared constants and configuration for the upload functionality
 */

/**
 * Map configuration defaults
 */
export const MAP_CONFIG = {
  defaultCenter: [37.0902, -95.7129],
  defaultZoom: 4,
  maxZoom: 19,
  fitBoundsPadding: 50,
  fitBoundsMaxZoom: 15,
};

/**
 * Supported file types for upload
 */
export const SUPPORTED_FILE_TYPES = {
  gpx: {
    name: "GPS Exchange Format",
    extension: ".gpx",
    mimeType: "application/gpx+xml",
  },
  geojson: {
    name: "GeoJSON",
    extension: ".geojson",
    mimeType: "application/geo+json",
  },
};

/**
 * Sources that indicate a trip was uploaded (vs fetched from an API)
 */
export const UPLOAD_SOURCES = ["upload_gpx", "upload_geojson", "upload"];

/**
 * API endpoints for upload operations
 */
export const API_ENDPOINTS = {
  UPLOAD: "/api/upload_gpx",
  TRIPS: "/api/trips",
  DELETE_TRIP: (tripId) => `/api/trips/${tripId}`,
};

/**
 * Preview layer styling
 */
export const PREVIEW_LAYER_STYLE = {
  lineColor: "#ff0000",
  lineWidth: 3,
  lineOpacity: 0.8,
};

/**
 * DOM element IDs used by the upload manager
 */
export const DOM_IDS = {
  dropZone: "dropZone",
  fileInput: "fileInput",
  fileListBody: "fileListBody",
  uploadButton: "uploadButton",
  totalFiles: "totalFiles",
  dateRange: "dateRange",
  totalPoints: "totalPoints",
  previewMap: "previewMap",
  mapMatchCheckbox: "mapMatchOnUpload",
  uploadedTripsBody: "uploadedTripsBody",
  selectAllCheckbox: "select-all",
  bulkDeleteBtn: "bulk-delete-btn",
};

/**
 * CSS class names used in the upload UI
 */
export const CSS_CLASSES = {
  dragover: "dragover",
  tripCheckbox: "trip-checkbox",
  deleteTrip: "delete-trip",
};
