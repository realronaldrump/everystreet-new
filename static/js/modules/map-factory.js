/**
 * Map Factory
 * High-level factory for creating and configuring Mapbox maps
 * Standardizes map initialization and common patterns
 * Built on top of map-pool for efficient resource management
 */

/* global mapboxgl */

import { CONFIG } from "./config.js";
import mapPool from "./map-pool.js";

class MapFactory {
  constructor() {
    this.defaultControls = {
      navigation: true,
      geolocate: false,
      fullscreen: false,
      scale: false,
    };
  }

  /**
   * Initialize the factory (delegates to map pool)
   */
  initialize(accessToken) {
    mapPool.initialize(accessToken);
  }

  /**
   * Create a standard map with common configurations
   */
  async createMap(containerId, options = {}) {
    const {
      center = CONFIG.MAP.defaultCenter,
      zoom = CONFIG.MAP.defaultZoom,
      style = null,
      controls = {},
      interactive = true,
      bounds = null,
      fitBoundsOptions = {},
      onClick = null,
      onLoad = null,
      key = null,
    } = options;

    // Get map from pool
    const map = await mapPool.getMap(
      containerId,
      {
        center,
        zoom,
        style,
        interactive,
        ...options,
      },
      key,
    );

    // Add controls
    const controlConfig = { ...this.defaultControls, ...controls };
    this._addControls(map, controlConfig);

    // Fit bounds if provided
    if (bounds) {
      map.fitBounds(bounds, {
        padding: 50,
        ...fitBoundsOptions,
      });
    }

    // Add event handlers
    if (onClick) {
      map.on("click", onClick);
    }

    if (onLoad) {
      if (map.loaded()) {
        onLoad(map);
      } else {
        map.once("load", () => onLoad(map));
      }
    }

    return map;
  }

  /**
   * Create a map for coverage visualization
   */
  async createCoverageMap(containerId, options = {}) {
    return this.createMap(containerId, {
      zoom: 13,
      controls: {
        navigation: true,
        geolocate: true,
        fullscreen: true,
      },
      ...options,
    });
  }

  /**
   * Create a map for trip viewing
   */
  async createTripMap(containerId, options = {}) {
    return this.createMap(containerId, {
      zoom: 12,
      controls: {
        navigation: true,
        fullscreen: true,
      },
      ...options,
    });
  }

  /**
   * Create a map for navigation
   */
  async createNavigationMap(containerId, options = {}) {
    return this.createMap(containerId, {
      zoom: 16,
      controls: {
        navigation: true,
        geolocate: true,
      },
      pitch: 45,
      bearing: 0,
      ...options,
    });
  }

  /**
   * Create a static/preview map (non-interactive)
   */
  async createStaticMap(containerId, options = {}) {
    return this.createMap(containerId, {
      interactive: false,
      controls: {},
      attributionControl: false,
      ...options,
    });
  }

  /**
   * Create a county/region overview map
   */
  async createCountyMap(containerId, options = {}) {
    return this.createMap(containerId, {
      zoom: 8,
      controls: {
        navigation: true,
        fullscreen: true,
      },
      ...options,
    });
  }

  /**
   * Add standard controls to a map
   */
  _addControls(map, controls) {
    // Navigation control (zoom buttons)
    if (controls.navigation) {
      map.addControl(
        new mapboxgl.NavigationControl({
          showCompass: true,
          showZoom: true,
          visualizePitch: true,
        }),
        "top-right",
      );
    }

    // Geolocate control
    if (controls.geolocate) {
      const geolocateControl = new mapboxgl.GeolocateControl({
        positionOptions: {
          enableHighAccuracy: true,
        },
        trackUserLocation: true,
        showUserHeading: true,
      });
      map.addControl(
        geolocateControl,
        controls.geolocatePosition || "top-right",
      );
    }

    // Fullscreen control
    if (controls.fullscreen) {
      map.addControl(new mapboxgl.FullscreenControl(), "top-right");
    }

    // Scale control
    if (controls.scale) {
      map.addControl(
        new mapboxgl.ScaleControl({
          maxWidth: 100,
          unit: "imperial",
        }),
        "bottom-left",
      );
    }

    // Custom controls
    if (controls.custom) {
      controls.custom.forEach(({ control, position = "top-right" }) => {
        map.addControl(control, position);
      });
    }
  }

  /**
   * Add a marker to a map
   */
  addMarker(map, lngLat, options = {}) {
    const {
      color = "#3FB1CE",
      draggable = false,
      popup = null,
      onClick = null,
    } = options;

    const marker = new mapboxgl.Marker({
      color,
      draggable,
    })
      .setLngLat(lngLat)
      .addTo(map);

    if (popup) {
      const popupInstance = new mapboxgl.Popup({ offset: 25 }).setHTML(popup);
      marker.setPopup(popupInstance);
    }

    if (onClick) {
      marker.getElement().addEventListener("click", (e) => {
        e.stopPropagation();
        onClick(marker, lngLat);
      });
    }

    return marker;
  }

  /**
   * Add a GeoJSON source to a map
   */
  addGeoJSONSource(map, sourceId, data, options = {}) {
    if (map.getSource(sourceId)) {
      map.getSource(sourceId).setData(data);
    } else {
      map.addSource(sourceId, {
        type: "geojson",
        data,
        ...options,
      });
    }
  }

  /**
   * Add a line layer to a map
   */
  addLineLayer(map, layerId, sourceId, options = {}) {
    const {
      color = "#3FB1CE",
      width = 3,
      opacity = 1,
      filter = null,
      beforeId = null,
    } = options;

    if (map.getLayer(layerId)) {
      return;
    }

    const layer = {
      id: layerId,
      type: "line",
      source: sourceId,
      paint: {
        "line-color": color,
        "line-width": width,
        "line-opacity": opacity,
      },
    };

    if (filter) {
      layer.filter = filter;
    }

    map.addLayer(layer, beforeId);
  }

  /**
   * Add a fill layer to a map
   */
  addFillLayer(map, layerId, sourceId, options = {}) {
    const {
      color = "#3FB1CE",
      opacity = 0.5,
      outlineColor = null,
      filter = null,
      beforeId = null,
    } = options;

    if (map.getLayer(layerId)) {
      return;
    }

    const layer = {
      id: layerId,
      type: "fill",
      source: sourceId,
      paint: {
        "fill-color": color,
        "fill-opacity": opacity,
      },
    };

    if (outlineColor) {
      layer.paint["fill-outline-color"] = outlineColor;
    }

    if (filter) {
      layer.filter = filter;
    }

    map.addLayer(layer, beforeId);
  }

  /**
   * Fit map to bounds with padding
   */
  fitToBounds(map, coordinates, options = {}) {
    if (!coordinates || coordinates.length === 0) {
      return;
    }

    const bounds = new mapboxgl.LngLatBounds();

    coordinates.forEach((coord) => {
      // Handle both [lng, lat] and {lng, lat} formats
      if (Array.isArray(coord)) {
        bounds.extend(coord);
      } else if (coord.lng !== undefined && coord.lat !== undefined) {
        bounds.extend([coord.lng, coord.lat]);
      }
    });

    map.fitBounds(bounds, {
      padding: 50,
      maxZoom: 16,
      duration: 1000,
      ...options,
    });
  }

  /**
   * Fly to location with animation
   */
  flyTo(map, lngLat, zoom = null, options = {}) {
    const flyOptions = {
      center: lngLat,
      duration: 1500,
      essential: true,
      ...options,
    };

    if (zoom !== null) {
      flyOptions.zoom = zoom;
    }

    map.flyTo(flyOptions);
  }

  /**
   * Release a map back to the pool
   */
  releaseMap(key) {
    mapPool.releaseMap(key);
  }

  /**
   * Destroy a specific map
   */
  destroyMap(key) {
    mapPool.destroyMap(key);
  }

  /**
   * Update theme for all maps
   */
  updateTheme(theme) {
    mapPool.updateTheme(theme);
  }

  /**
   * Get pool statistics
   */
  getStats() {
    return mapPool.getStats();
  }
}

// Create singleton instance
const mapFactory = new MapFactory();

// Export both class and singleton
export { MapFactory, mapFactory };
export default mapFactory;
