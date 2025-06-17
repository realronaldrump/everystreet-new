// static/js/coverage/config.js
const COVERAGE_CONFIG = {
    // Status constants
    STATUS: {
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
      POST_PREPROCESSING: "post_preprocessing"
    },
  
    // API endpoints
    ENDPOINTS: {
      COVERAGE_AREAS: '/api/coverage_areas',
      VALIDATE_LOCATION: '/api/validate_location',
      VALIDATE_CUSTOM_BOUNDARY: '/api/validate_custom_boundary',
      PREPROCESS_STREETS: '/api/preprocess_streets',
      PREPROCESS_CUSTOM_BOUNDARY: '/api/preprocess_custom_boundary',
      STREET_COVERAGE: '/api/street_coverage',
      STREET_COVERAGE_INCREMENTAL: '/api/street_coverage/incremental',
      MARK_DRIVEN: '/api/street_segments/mark_driven',
      MARK_UNDRIVEN: '/api/street_segments/mark_undriven',
      MARK_UNDRIVEABLE: '/api/street_segments/mark_undriveable',
      MARK_DRIVEABLE: '/api/street_segments/mark_driveable',
      SUGGEST_STREETS: '/api/driving-navigation/suggest-next-street',
      TRIPS_IN_BOUNDS: '/api/trips_in_bounds'
    },
  
    // Default values
    DEFAULTS: {
      SEGMENT_LENGTH: 100,
      MATCH_BUFFER: 15,
      MIN_MATCH_LENGTH: 5,
      POLL_INTERVAL: 5000,
      MAX_RETRIES: 360,
      CACHE_TIME: 300000, // 5 minutes
      CHART_COLORS: {
        COVERED: '#4caf50',
        UNCOVERED: '#ff5252',
        UNDRIVEABLE: '#607d8b',
        TRIP_OVERLAY: '#3388ff'
      }
    },
  
    // Map settings
    MAP: {
      DEFAULT_CENTER: [0, 0],
      DEFAULT_ZOOM: 1,
      MAX_ZOOM: 20,
      MIN_ZOOM: 0,
      TRIP_MIN_ZOOM: 12,
      FIT_BOUNDS_PADDING: 20,
      FIT_BOUNDS_MAX_ZOOM: 17
    },
  
    // UI settings
    UI: {
      ANIMATION_DURATION: 300,
      TOAST_DURATION: 3000,
      BATCH_SIZE: 100,
      MAX_UNDRIVEN_STREETS: 50,
      PROGRESS_UPDATE_INTERVAL: 1000
    },
  
    // Storage keys
    STORAGE: {
      PROCESSING_STATE: 'coverageProcessingState',
      TRIP_OVERLAY: 'showTripsOverlay',
      LAST_MAP_VIEW: 'lastMapView',
      SORT_CRITERION: 'undrivenSortCriterion'
    },
  
    // Error messages
    MESSAGES: {
      VALIDATION_REQUIRED: 'Please validate a location first.',
      LOCATION_REQUIRED: 'Please enter a location.',
      AREA_EXISTS: 'This area is already being tracked.',
      NO_PROCESSING: 'No active processing to cancel.',
      MAP_TOKEN_MISSING: 'Mapbox access token not configured.',
      EXPORT_FAILED: 'Failed to export data.',
      POSITION_UNAVAILABLE: 'Unable to determine current position.'
    }
  };
  
  // Freeze the configuration to prevent accidental modifications
  Object.freeze(COVERAGE_CONFIG);
  
  // Export for ES modules
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = COVERAGE_CONFIG;
  }
  
  // Make available globally
  window.COVERAGE_CONFIG = COVERAGE_CONFIG;