/**
 * Centralized Configuration Module
 * All API endpoints, storage keys, and constants in one place
 */

export const CONFIG = {
  // Map configuration
  MAP: {
    defaultCenter: [-95.7129, 37.0902],
    defaultZoom: 4,
    maxZoom: 19,
    // Canonical front-end Mapbox token source.
    accessToken: "pk.your-public-mapbox-token",
    recentTripThreshold: 6 * 60 * 60 * 1000, // 6 hours
    recencyWindowMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    debounceDelay: 150,
    throttleDelay: 50,
    styles: {
      dark: "mapbox://styles/mapbox/dark-v11",
      light: "mapbox://styles/mapbox/light-v11",
      satellite: "mapbox://styles/mapbox/satellite-v9",
      streets: "mapbox://styles/mapbox/streets-v12",
    },
    performanceOptions: {
      // Keep map canvas dimensions in sync with viewport changes.
      trackResize: true,
      refreshExpiredTiles: false,
      fadeDuration: 300,
      antialias: false,
    },
  },

  // LocalStorage keys
  STORAGE_KEYS: {
    startDate: "startDate",
    endDate: "endDate",
    selectedLocation: "selectedLocation",
    selectedVehicle: "selectedVehicleImei",
    tripsSort: "tripsSort",
    sidebarState: "sidebarCollapsed",
    layerVisibility: "layerVisibility",
    layerSettings: "layerSettings",
    streetViewMode: "streetViewMode",
    theme: "theme",
    mapView: "mapView",
    mapType: "mapType",
    uiState: "uiState",
  },

  // API endpoints - centralized location for all backend routes
  API: {
    // Trip endpoints
    trips: "/api/trips",
    tripById: (id) => `/api/trips/${id}`,
    tripRegeocode: (id) => `/api/trips/${id}/regeocode`,
    tripsDataTable: "/api/trips/datatable",
    tripsBulkDelete: "/api/trips/bulk_delete",
    matchedTrips: "/api/matched_trips",
    matchedTripById: (id) => `/api/matched_trips/${id}`,
    matchedTripsBulkUnmatch: "/api/matched_trips/bulk_unmatch",
    failedTrips: "/api/failed_trips",
    mapMatchTrips: "/api/map_match_trips",
    mapMatchingJobs: "/api/map_matching/jobs",
    mapMatchingJob: (id) => `/api/map_matching/jobs/${id}`,
    mapMatchingJobCancel: (id) => `/api/map_matching/jobs/${id}/cancel`,
    mapMatchingJobMatches: (id) => `/api/map_matching/jobs/${id}/matches`,
    geocodeTrips: "/api/geocode_trips",
    tripAnalytics: "/api/trip-analytics",
    tripMetrics: "/api/metrics",
    drivingInsights: "/api/driving-insights",
    tripSyncStatus: "/api/actions/trips/sync/status",
    tripSyncStart: "/api/actions/trips/sync",
    tripSyncCancel: (jobId) => `/api/actions/trips/sync/${jobId}`,
    tripSyncSse: "/api/actions/trips/sync/sse",
    tripSyncConfig: "/api/actions/trips/sync/config",
    tripSyncHistoryImportPlan: "/api/actions/trips/sync/history_import/plan",
    tripSyncHistoryImportJob: (jobId) =>
      `/api/actions/trips/sync/history_import/${jobId}`,
    tripSyncHistoryImportSse: (jobId) =>
      `/api/actions/trips/sync/history_import/${jobId}/sse`,
    tripSyncHistoryImportCancel: (jobId) =>
      `/api/actions/trips/sync/history_import/${jobId}`,
    tripMemoryAtlas: (id) => `/api/trips/${id}/memory-atlas`,
    tripMemoryAtlasAttach: (id) => `/api/trips/${id}/memory-atlas/attach`,
    tripMemoryAtlasAutoAssign: "/api/trips/memory-atlas/auto-assign",
    tripMemoryAtlasPostcard: (id) => `/api/trips/${id}/memory-atlas/postcard`,
    tripMemoryAtlasMoment: (id, momentId) =>
      `/api/trips/${id}/memory-atlas/moments/${momentId}`,

    // Coverage endpoints
    coverageAreas: "/api/coverage/areas",
    coverageAreaById: (id) => `/api/coverage/areas/${id}`,
    coverageAreaStreets: (id, params = "") =>
      `/api/coverage/areas/${id}/streets${params ? `?${params}` : ""}`,
    // Full-area street export endpoint (FeatureCollection). Supports `status=undriven|driven|undriveable`.
    coverageAreaAllStreets: (id, params = "") =>
      `/api/coverage/areas/${id}/streets/all${params ? `?${params}` : ""}`,

    // Search endpoints
    searchStreets: "/api/search/streets",
    searchGeocode: "/api/search/geocode",
    searchStreetGeometry: "/api/search/street-geometry",

    // Vehicle endpoints
    vehicles: "/api/vehicles",

    // Google Photos endpoints
    googlePhotosStatus: "/api/google-photos/status",
    googlePhotosCredentials: "/api/google-photos/credentials",
    googlePhotosAuthorize: (mode = "picker") =>
      `/api/google-photos/authorize?mode=${encodeURIComponent(mode)}`,
    googlePhotosDisconnect: "/api/google-photos/disconnect",
    googlePhotosPickerSessions: "/api/google-photos/picker/sessions",
    googlePhotosPickerSession: (sessionId) =>
      `/api/google-photos/picker/sessions/${encodeURIComponent(sessionId)}`,
    googlePhotosPickerSessionMediaItems: (sessionId) =>
      `/api/google-photos/picker/sessions/${encodeURIComponent(sessionId)}/media-items`,

    // Caching and retry settings
    cacheTime: 30000,
    retryAttempts: 3,
    retryDelay: 1000,
    timeout: 120000,
    batchSize: 100,
  },

  // Default layer configurations
  LAYER_DEFAULTS: {
    trips: {
      order: 1,
      color: "#b87a4a",
      opacity: 0.85,
      visible: true,
      name: "Trips Heatmap",
      weight: 2,
      minzoom: 0,
      maxzoom: 22,
      supportsColorPicker: false,
      supportsOpacitySlider: true,
      isHeatmap: true,
    },
    matchedTrips: {
      order: 3,
      color: "#c45454",
      opacity: 0.6,
      visible: false,
      highlightColor: "#4da396",
      name: "Matched Trips",
      weight: 2,
      minzoom: 0,
      maxzoom: 22,
      supportsColorPicker: false,
      supportsOpacitySlider: true,
      isHeatmap: true,
    },
    undrivenStreets: {
      order: 2,
      color: "#c47050",
      opacity: 0.8,
      visible: false,
      name: "Undriven Streets",
      weight: 1.5,
      minzoom: 10,
      maxzoom: 22,
    },
    drivenStreets: {
      order: 2,
      color: "#4d9a6a",
      opacity: 0.8,
      visible: false,
      name: "Driven Streets",
      weight: 1.5,
      minzoom: 10,
      maxzoom: 22,
    },
    allStreets: {
      order: 2,
      color: "#6a72a0",
      opacity: 0.7,
      visible: false,
      name: "All Streets",
      weight: 1.5,
      minzoom: 10,
      maxzoom: 22,
    },
  },

  // Performance settings
  PERFORMANCE: {
    enableWebGL: true,
    enableWorkers: true,
    workerCount:
      (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4,
    maxParallelRequests: 6,
    tripChunkSize: 500,
    progressiveLoadingDelay: 16,
  },

  // UI configuration
  UI: {
    mobileBreakpoint: 768,
    debounceDelays: {
      resize: 250,
      scroll: 50,
      input: 300,
    },
    transitions: {
      fast: 150,
      normal: 300,
      slow: 500,
    },
    tooltipDelay: { show: 500, hide: 100 },
    selectors: {
      themeToggle: "#theme-toggle-checkbox",
      mobileDrawer: "#mobile-nav-drawer",
      menuToggle: "#menu-toggle",
      closeBtn: ".drawer-close-btn",
      contentOverlay: "#content-overlay",
      // Date picker dropdown selectors
      datePickerWrapper: "#date-picker-wrapper",
      datePickerTrigger: "#date-picker-trigger",
      datePickerDropdown: "#date-picker-dropdown",
      datePickerOverlay: "#date-picker-overlay",
      dateDisplay: "#date-display",
      dpStartDate: "#dp-start-date",
      dpEndDate: "#dp-end-date",
      datePickerApply: "#date-picker-apply",
      datePickerReset: "#date-picker-reset",
      header: ".app-header",
      mapControls: "#map-controls",
      controlsToggle: "#controls-toggle",
      controlsContent: "#controls-content",
      toolsSection: ".tools-section",
      mapTypeSelect: "#map-type-select",
    },
    classes: {
      active: "active",
      open: "open",
      visible: "visible",
      show: "show",
      scrolled: "scrolled",
      lightMode: "light-mode",
      minimized: "minimized",
      connected: "connected",
      disconnected: "disconnected",
      loading: "loading",
      unseen: "unseen",
      applied: "applied",
    },
    themeColors: {
      light: "#faf9f7",
      dark: "#111113",
    },
    animations: {
      enabled:
        typeof window !== "undefined" &&
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    },
  },
};

export default CONFIG;
