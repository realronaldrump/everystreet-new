import { CONFIG } from "./config.js";

class AppState {
  constructor() {
    this.map = null;
    this.mapInitialized = false;
    this.mapLayers = JSON.parse(JSON.stringify(CONFIG.LAYER_DEFAULTS));
    this.mapSettings = {
      highlightRecentTrips: true,
      autoRefresh: false,
      clusterTrips: false,
    };
    this.selectedTripId = null;
    this.liveTracker = null;
    this.dom = new Map();
    this.listeners = new WeakMap();
    this.apiCache = new Map();
    this.abortControllers = new Map();
    this.loadingStates = new Map();
    this.pendingRequests = new Set();
    this.layerLoadPromises = new Map();

    this.metrics = {
      loadStartTime: Date.now(),
      mapLoadTime: null,
      dataLoadTime: null,
      renderTime: null,
    };
  }

  reset() {
    this.cancelAllRequests();

    if (this.map) {
      this.map.off();
      this.map.remove();
      this.map = null;
    }

    this.mapInitialized = false;
    this.selectedTripId = null;
    this.dom.clear();
    this.apiCache.clear();
    this.loadingStates.clear();
    this.pendingRequests.clear();
    this.layerLoadPromises.clear();
  }

  cancelAllRequests() {
    this.abortControllers.forEach((controller) => {
      try {
        controller.abort();
      } catch (e) {
        console.warn("Error aborting request:", e);
      }
    });
    this.abortControllers.clear();
    this.pendingRequests.clear();
  }

  trackRequest(url) {
    this.pendingRequests.add(url);
  }

  completeRequest(url) {
    this.pendingRequests.delete(url);
  }

  hasPendingRequests() {
    return this.pendingRequests.size > 0;
  }
}

export const state = new AppState();
export default state;
