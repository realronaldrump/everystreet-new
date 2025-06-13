export const CONFIG = {
  MAP: {
    defaultCenter: [-95.7129, 37.0902],
    defaultZoom: 4,
    maxZoom: 19,
    recentTripThreshold: 6 * 60 * 60 * 1000, // 6 hours
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
      color: "#BB86FC",
      opacity: 0.6,
      visible: true,
      highlightColor: "#FFD700",
      name: "Trips",
      weight: 2,
      minzoom: 0,
      maxzoom: 22,
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
  },
  PERFORMANCE: {
    enableWebGL: true,
    enableWorkers: true,
    workerCount: navigator.hardwareConcurrency || 4,
    maxParallelRequests: 6,
  },
};

export default CONFIG; 