/**
 * Export Configuration
 * Contains all export-related constants and configuration
 */

/**
 * Export form configurations for each export type
 */
export const EXPORT_CONFIG = {
  trips: {
    id: "export-trips-form",
    dateStart: "trips-start-date",
    dateEnd: "trips-end-date",
    format: "trips-format",
    endpoint: "/api/export/trips",
    name: "trips",
  },
  matchedTrips: {
    id: "export-matched-trips-form",
    dateStart: "matched-trips-start-date",
    dateEnd: "matched-trips-end-date",
    format: "matched-trips-format",
    endpoint: "/api/export/matched_trips",
    name: "map-matched trips",
  },
  streets: {
    id: "export-streets-form",
    location: "streets-location",
    format: "streets-format",
    endpoint: "/api/export/streets",
    name: "streets",
  },
  boundary: {
    id: "export-boundary-form",
    location: "boundary-location",
    format: "boundary-format",
    endpoint: "/api/export/boundary",
    name: "boundary",
  },
  advanced: {
    id: "advanced-export-form",
    dateStart: "adv-start-date",
    dateEnd: "adv-end-date",
    format: "adv-format",
    endpoint: "/api/export/advanced",
    name: "advanced export",
  },
  undrivenStreets: {
    id: "export-undriven-streets-form",
    location: "undriven-streets-location",
    format: "undriven-streets-format",
    endpoint: "/api/undriven_streets",
    name: "undriven streets",
  },
};

/**
 * Default timeout for export operations (in milliseconds)
 */
export const EXPORT_TIMEOUT_MS = 120000;

/**
 * Element IDs for advanced export options
 */
export const ADVANCED_EXPORT_ELEMENTS = {
  // Data source checkboxes
  includeTrips: "include-trips",
  includeMatchedTrips: "include-matched-trips",
  includeUploadedTrips: "include-uploaded-trips",

  // Data field checkboxes
  includeBasicInfo: "include-basic-info",
  includeLocations: "include-locations",
  includeTelemetry: "include-telemetry",
  includeGeometry: "include-geometry",
  includeMeta: "include-meta",
  includeCustom: "include-custom",

  // Date settings
  exportAllDates: "export-all-dates",
  saveExportSettings: "save-export-settings",

  // CSV options
  csvOptionsContainer: "csv-options",
  includeGpsInCsv: "include-gps-in-csv",
  flattenLocationFields: "flatten-location-fields",
};

/**
 * Storage key for saving export settings
 */
export const EXPORT_SETTINGS_STORAGE_KEY = "advancedExportSettings";

export default {
  EXPORT_CONFIG,
  EXPORT_TIMEOUT_MS,
  ADVANCED_EXPORT_ELEMENTS,
  EXPORT_SETTINGS_STORAGE_KEY,
};
