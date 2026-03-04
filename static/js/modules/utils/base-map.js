/* global mapboxgl */

import { createMap } from "../map-core.js";

const NOOP = () => {};

/**
 * Shared base class for feature map wrappers.
 * Handles shared-map binding, standalone map creation, and load/error wiring.
 */
export class BaseFeatureMap {
  constructor(containerId, options = {}) {
    this.containerId = containerId;
    this.options = options;
    this.map = null;
    this.ownsMap = false;
  }

  setContainer(containerId) {
    this.containerId = containerId;
  }

  initializeMap(
    mapOptions = {},
    { afterCreate = NOOP, onLoad = NOOP, onError = null } = {}
  ) {
    const handleError = (error) => {
      if (typeof onError === "function") {
        onError(error);
      }
    };

    if (this.options?.sharedMap) {
      this.map = this.options.sharedMap;
      this.ownsMap = false;
      try {
        afterCreate();
      } catch (error) {
        handleError(error);
        return Promise.reject(error);
      }
      return this.bindMapLoad(onLoad, onError);
    }

    if (!this.containerId || typeof document === "undefined") {
      return Promise.resolve();
    }

    const container = document.getElementById(this.containerId);
    if (!container) {
      return Promise.resolve();
    }

    try {
      this.map = createMap(this.containerId, mapOptions);
      this.ownsMap = true;
      afterCreate();
    } catch (error) {
      handleError(error);
      return Promise.reject(error);
    }

    return this.bindMapLoad(onLoad, onError);
  }

  bindMapLoad(onLoad = NOOP, onError = null) {
    if (!this.map) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const mapRef = this.map;

      const cleanup = () => {
        if (!mapRef || typeof mapRef.off !== "function") {
          return;
        }
        try {
          mapRef.off("load", handleLoad);
        } catch {
          // Ignore map API differences.
        }
        try {
          mapRef.off("error", handleError);
        } catch {
          // Ignore map API differences.
        }
      };

      const fail = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (typeof onError === "function") {
          onError(error);
        }
        reject(error);
      };

      const succeed = async () => {
        if (settled) {
          return;
        }
        cleanup();
        try {
          await onLoad();
          settled = true;
          resolve();
        } catch (error) {
          settled = true;
          if (typeof onError === "function") {
            onError(error);
          }
          reject(error);
        }
      };

      const handleLoad = () => {
        void succeed();
      };

      const handleError = (event) => {
        const error = event?.error ?? event ?? new Error("Map failed to load");
        fail(error);
      };

      if (typeof mapRef.on === "function") {
        mapRef.on("load", handleLoad);
        mapRef.on("error", handleError);
      }

      if (typeof mapRef.isStyleLoaded === "function" && mapRef.isStyleLoaded()) {
        void succeed();
      }
    });
  }

  disableTelemetry() {
    if (typeof mapboxgl?.setTelemetryEnabled === "function") {
      mapboxgl.setTelemetryEnabled(false);
    }
    if (typeof mapboxgl?.config !== "object") {
      return;
    }
    try {
      mapboxgl.config.REPORT_MAP_LOAD_TIMES = false;
    } catch {
      // Ignore Mapbox config API differences.
    }
    try {
      mapboxgl.config.COLLECT_RESOURCE_TIMING = false;
    } catch {
      // Ignore Mapbox config API differences.
    }
    try {
      mapboxgl.config.EVENTS_URL = null;
    } catch {
      // Ignore Mapbox config API differences.
    }
  }

  removeOwnedMap() {
    if (this.map && this.ownsMap) {
      try {
        this.map.remove();
      } catch {
        // Ignore map cleanup errors.
      }
    }
    this.map = null;
    this.ownsMap = false;
  }
}

export default BaseFeatureMap;
