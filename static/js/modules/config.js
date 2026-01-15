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
      trackResize: false,
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
    sidebarState: "sidebarCollapsed",
    layerVisibility: "layerVisibility",
    layerSettings: "layerSettings",
    streetViewMode: "streetViewMode",
    theme: "theme",
    mapView: "mapView",
    mapType: "mapType",
    uiState: "uiState",
    showLiveTracking: "showLiveTracking",
  },

  // API endpoints - centralized location for all backend routes
  API: {
    // Trip endpoints
    trips: "/api/trips",
    tripById: (id) => `/api/trips/${id}`,
    tripsDataTable: "/api/trips/datatable",
    tripsBulkDelete: "/api/trips/bulk_delete",
    matchedTrips: "/api/matched_trips",
    mapMatchTrips: "/api/map_match_trips",
    geocodeTrips: "/api/geocode_trips",
    tripAnalytics: "/api/trip-analytics",

    // Coverage endpoints
    coverageAreas: "/api/coverage/areas",
    coverageAreaById: (id) => `/api/coverage/areas/${id}`,
    coverageAreaStreets: (id, params = "") =>
      `/api/coverage/areas/${id}/streets${params ? `?${params}` : ""}`,

    // Search endpoints
    searchStreets: "/api/search/streets",
    searchGeocode: "/api/search/geocode",

    // Vehicle endpoints
    vehicles: "/api/vehicles",

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
      color: "#7c9d96",
      opacity: 0.82,
      visible: true,
      name: "Trip Trails",
      weight: 2.2,
      minzoom: 0,
      maxzoom: 22,
      supportsColorPicker: false,
      supportsOpacitySlider: true,
      isHeatmap: false,
      lineBlur: 0.6,
      lineSortKey: ["-", 100000, ["coalesce", ["get", "es_recencyHours"], 99999]],
    },
    matchedTrips: {
      order: 3,
      color: "#8b9dc3",
      opacity: 0.55,
      visible: false,
      highlightColor: "#f6c26b",
      name: "Matched Trails",
      weight: 1.8,
      minzoom: 0,
      maxzoom: 22,
      dasharray: [1.4, 1.4],
      lineBlur: 0.3,
      lineSortKey: ["-", 100000, ["coalesce", ["get", "es_recencyHours"], 99999]],
    },
    undrivenStreets: {
      order: 2,
      color: "#00BFFF",
      opacity: 0.8,
      visible: false,
      name: "Undriven Streets",
      weight: 1.5,
      minzoom: 10,
      maxzoom: 22,
    },
    drivenStreets: {
      order: 2,
      color: "#059669",
      opacity: 0.8,
      visible: false,
      name: "Driven Streets",
      weight: 1.5,
      minzoom: 10,
      maxzoom: 22,
    },
    allStreets: {
      order: 2,
      color: "#818cf8",
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
    workerCount: navigator.hardwareConcurrency || 4,
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
      filterToggle: "#filters-toggle",
      filtersPanel: "#filters-panel",
      filtersClose: ".panel-close-btn",
      startDate: "#start-date",
      endDate: "#end-date",
      applyFiltersBtn: "#apply-filters",
      resetFilters: "#reset-filters",
      header: ".app-header",
      mapControls: "#map-controls",
      centerOnLocationButton: "#center-on-location",
      controlsToggle: "#controls-toggle",
      controlsContent: "#controls-content",
      filterIndicator: "#filter-indicator",
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
      light: "#f8f9fa",
      dark: "#121212",
    },
    animations: {
      enabled:
        typeof window !== "undefined"
        && !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    },
  },
};

export default CONFIG;
