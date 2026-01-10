/**
 * Progress Constants Module
 * Status definitions and constants for coverage progress tracking
 */

/**
 * Coverage calculation status values
 */
export const STATUS = {
  INITIALIZING: "initializing",
  PREPROCESSING: "preprocessing",
  LOADING_STREETS: "loading_streets",
  INDEXING: "indexing",
  COUNTING_TRIPS: "counting_trips",
  PROCESSING_TRIPS: "processing_trips",
  CALCULATING: "calculating",
  FINALIZING: "finalizing",
  GENERATING_GEOJSON: "generating_geojson",
  COMPLETE_STATS: "completed_stats",
  COMPLETE: "complete",
  COMPLETED: "completed",
  ERROR: "error",
  WARNING: "warning",
  CANCELED: "canceled",
  UNKNOWN: "unknown",
  POST_PREPROCESSING: "post_preprocessing",
};

/**
 * Terminal statuses that indicate task completion (success or failure)
 */
export const TERMINAL_STATUSES = [
  STATUS.COMPLETE,
  STATUS.COMPLETED,
  STATUS.ERROR,
  STATUS.CANCELED,
];

/**
 * Polling configuration
 */
export const POLLING_CONFIG = {
  MAX_RETRIES: 360, // ~30 minutes
  MAX_INITIAL_404_RETRIES: 5,
  BASE_INTERVAL: 5000, // 5 seconds
  MAX_INTERVAL: 20000, // 20 seconds
  INITIAL_DELAY: 500,
};

/**
 * Step order for progress indicators
 */
export const STEP_ORDER = [
  "initializing",
  "preprocessing",
  "indexing",
  "calculating",
  "complete",
];
