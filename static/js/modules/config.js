export const CONFIG = {
  MAP: {
    defaultCenter: [-95.7129, 37.0902],
    defaultZoom: 4,
    maxZoom: 19,
    recentTripThreshold: 6 * 60 * 60 * 1000, // 6 hours
    recencyWindowMs: 30 * 24 * 60 * 60 * 1000, // 30 days window for recency styling
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
  STORAGE_KEYS: {
    startDate: "startDate",
    endDate: "endDate",
    selectedLocation: "selectedLocation",
    sidebarState: "sidebarCollapsed",
    layerVisibility: "layerVisibility",
    layerSettings: "layerSettings",
    streetViewMode: "streetViewMode",
  },
  API: {
    cacheTime: 30000,
    retryAttempts: 3,
    retryDelay: 1000,
    timeout: 120000,
    batchSize: 100,
  },
  LAYER_DEFAULTS: {
    trips: {
      order: 1,
      color: "#4A90D9",
      opacity: 0.85,
      visible: true,
      highlightColor: "#FFD700",
      colorRecent: "#22C55E",
      name: "Trips Heatmap",
      weight: 2,
      minzoom: 0,
      maxzoom: 22,
      supportsColorPicker: false,
      supportsOpacitySlider: true,
      isHeatmap: true,
      heatmapSettings: {
        densifyDistance: 30, // Distance between points in meters
      },
    },
    matchedTrips: {
      order: 3,
      color: "#CF6679",
      opacity: 0.6,
      visible: false,
      highlightColor: "#40E0D0",
      name: "Matched Trips",
      weight: 2,
      minzoom: 0,
      maxzoom: 22,
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
  PERFORMANCE: {
    enableWebGL: true,
    enableWorkers: true,
    workerCount: navigator.hardwareConcurrency || 4,
    maxParallelRequests: 6,
    tripChunkSize: 500, // Features per render batch for progressive loading
    progressiveLoadingDelay: 16, // ms between chunks (one frame at 60fps)
  },
};

export default CONFIG;
