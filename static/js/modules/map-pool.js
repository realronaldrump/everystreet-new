/**
 * Centralized Map Pool Manager
 * Prevents WebGL context limit issues by managing Mapbox map instances
 * Browsers have a hard limit on WebGL contexts (usually 8-16)
 */
/* global mapboxgl */

import { CONFIG } from "./config.js";

class MapPool {
  constructor() {
    this.maps = new Map(); // key -> { map, container, lastUsed, inUse }
    this.maxMaps = 6; // Safe limit below browser's WebGL context limit
    this.accessToken = null;
  }

  /**
   * Initialize the map pool with Mapbox access token
   */
  initialize(accessToken) {
    if (!accessToken) {
      throw new Error("Mapbox access token is required");
    }
    this.accessToken = accessToken;
    mapboxgl.accessToken = accessToken;

    // Disable telemetry for performance
    mapboxgl.config.REPORT_MAP_LOAD_TIMES = false;
    mapboxgl.config.COLLECT_RESOURCE_TIMING = false;
  }

  /**
   * Get or create a map instance
   * @param {string} containerId - The DOM element ID for the map
   * @param {Object} options - Mapbox map options
   * @param {string} key - Optional key for reusing maps (defaults to containerId)
   * @returns {Promise<mapboxgl.Map>}
   */
  async getMap(containerId, options = {}, key = null) {
    const mapKey = key || containerId;
    const container = document.getElementById(containerId);

    if (!container) {
      throw new Error(`Map container '${containerId}' not found`);
    }

    // Check if we already have this map
    const existing = this.maps.get(mapKey);
    if (existing && existing.map && !existing.map._removed) {
      existing.lastUsed = Date.now();
      existing.inUse = true;

      // If container changed, move the map
      if (existing.container !== containerId) {
        // We need to recreate - can't move maps between containers easily
        this.releaseMap(mapKey);
      } else {
        // Resize to fit container in case it changed
        existing.map.resize();
        return existing.map;
      }
    }

    // Evict old maps if we're at the limit
    await this._evictIfNeeded();

    // Determine theme and style
    const theme = document.documentElement.getAttribute("data-bs-theme") || "dark";
    const style = options.style || CONFIG.MAP.styles[theme];

    // Create new map
    const map = new mapboxgl.Map({
      container: containerId,
      style,
      center: options.center || CONFIG.MAP.defaultCenter,
      zoom: options.zoom || CONFIG.MAP.defaultZoom,
      maxZoom: options.maxZoom || CONFIG.MAP.maxZoom,
      attributionControl: options.attributionControl ?? false,
      logoPosition: options.logoPosition || "bottom-right",
      ...CONFIG.MAP.performanceOptions,
      ...(options.performanceOptions || {}),
      transformRequest: (url) => {
        if (typeof url === "string") {
          try {
            const parsed = new URL(url, window.location.origin);
            if (parsed.hostname === "events.mapbox.com") {
              return null;
            }
          } catch {
            // Ignore parse errors
          }
        }
        return { url };
      },
    });

    // Store in pool
    this.maps.set(mapKey, {
      map,
      container: containerId,
      lastUsed: Date.now(),
      inUse: true,
    });

    // Wait for map to load
    await new Promise((resolve) => {
      if (map.loaded()) {
        resolve();
      } else {
        map.once("load", resolve);
      }
    });

    return map;
  }

  /**
   * Release a map back to the pool (mark as not in use)
   * @param {string} key - The map key
   */
  releaseMap(key) {
    const entry = this.maps.get(key);
    if (entry) {
      entry.inUse = false;
      entry.lastUsed = Date.now();
    }
  }

  /**
   * Destroy a specific map
   * @param {string} key - The map key
   */
  destroyMap(key) {
    const entry = this.maps.get(key);
    if (entry?.map) {
      try {
        entry.map.remove();
      } catch (e) {
        console.warn(`Error removing map ${key}:`, e);
      }
      this.maps.delete(key);
    }
  }

  /**
   * Evict least recently used maps if we're at the limit
   */
  async _evictIfNeeded() {
    if (this.maps.size < this.maxMaps) return;

    // Find maps that are not in use and sort by last used
    const evictable = [];
    for (const [key, entry] of this.maps) {
      if (!entry.inUse) {
        evictable.push({ key, lastUsed: entry.lastUsed });
      }
    }

    // Sort by oldest first
    evictable.sort((a, b) => a.lastUsed - b.lastUsed);

    // Evict oldest maps until we're under the limit
    const toEvict = Math.max(1, this.maps.size - this.maxMaps + 1);
    for (let i = 0; i < Math.min(toEvict, evictable.length); i++) {
      this.destroyMap(evictable[i].key);
    }
  }

  /**
   * Get map count for debugging
   */
  getStats() {
    let inUse = 0;
    let idle = 0;
    for (const entry of this.maps.values()) {
      if (entry.inUse) inUse++;
      else idle++;
    }
    return { total: this.maps.size, inUse, idle, max: this.maxMaps };
  }

  /**
   * Destroy all maps (cleanup)
   */
  destroyAll() {
    for (const key of this.maps.keys()) {
      this.destroyMap(key);
    }
  }

  /**
   * Update theme for all maps
   * @param {string} theme - 'dark' or 'light'
   */
  updateTheme(theme) {
    const style = CONFIG.MAP.styles[theme];
    for (const [key, entry] of this.maps) {
      if (entry.map && !entry.map._removed) {
        try {
          // Save current state
          const center = entry.map.getCenter();
          const zoom = entry.map.getZoom();
          const bearing = entry.map.getBearing();
          const pitch = entry.map.getPitch();

          entry.map.setStyle(style);

          // Restore state after style loads
          entry.map.once("styledata", () => {
            entry.map.jumpTo({ center, zoom, bearing, pitch });
          });
        } catch (e) {
          console.warn(`Error updating theme for map ${key}:`, e);
        }
      }
    }
  }
}

// Export singleton instance
export const mapPool = new MapPool();
export default mapPool;
