/* global mapboxgl */

/**
 * Map management for Driving Navigation.
 * Handles map initialization, layers, and map interactions.
 */

import {
  DEFAULT_CLUSTER_COLORS,
  DEFAULT_ROUTE_COLORS,
  DEFAULT_STREET_COLORS,
} from "./constants.js";

export class DrivingNavigationMap {
  /**
   * @param {string} containerId - The DOM container ID for the map
   * @param {Object} options - Configuration options
   * @param {boolean} [options.useSharedMap=false] - Use shared map instance
   */
  constructor(containerId, options = {}) {
    this.containerId = containerId;
    this.options = options;
    this.map = null;
    this.clusterMarkers = [];
    this.ownsMap = false;
    this.interactivityHandlers = null;

    // Get colors with fallbacks from MapStyles if available
    this.clusterColors
      = window.MapStyles?.MAP_LAYER_COLORS?.clusters || DEFAULT_CLUSTER_COLORS;
    this.streetColors
      = window.MapStyles?.MAP_LAYER_COLORS?.streets || DEFAULT_STREET_COLORS;
    this.routeColors
      = window.MapStyles?.MAP_LAYER_COLORS?.routes || DEFAULT_ROUTE_COLORS;
  }

  /**
   * Initialize the map.
   * @returns {Promise<void>}
   */
  initialize() {
    if (this.options.useSharedMap && window.coverageMasterMap) {
      this.map = window.coverageMasterMap;
      this.ownsMap = false;
      return this.bindMapLoad();
    }

    return new Promise((resolve, reject) => {
      try {
        const mapContainer = document.getElementById(this.containerId);
        if (!mapContainer) {
          throw new Error(`Map container #${this.containerId} not found!`);
        }

        mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;
        this.map = new mapboxgl.Map({
          container: this.containerId,
          style: "mapbox://styles/mapbox/dark-v11",
          center: [-96, 37.8],
          zoom: 3,
          attributionControl: false,
        });

        this.map.on("load", () => {
          this.setupMapLayers();
          this.ownsMap = true;
          resolve();
        });

        this.map.on("error", (e) => {
          console.error("Mapbox error:", e);
          reject(e);
        });
      } catch (error) {
        console.error("Error initializing map:", error);
        reject(error);
      }
    });
  }

  /**
   * Bind to an existing map that may already be loaded.
   * @returns {Promise<void>}
   */
  bindMapLoad() {
    if (!this.map) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const handleLoad = () => {
        this.setupMapLayers();
        resolve();
      };

      if (typeof this.map.isStyleLoaded === "function" && this.map.isStyleLoaded()) {
        handleLoad();
      } else {
        this.map.on("load", handleLoad);
      }

      this.map.on("error", (e) => {
        console.error("Mapbox error:", e);
        reject(e);
      });
    });
  }

  /**
   * Check if map is initialized and ready.
   * @returns {boolean}
   */
  isReady() {
    return this.map !== null;
  }

  /**
   * Set up all map layers for driving navigation.
   */
  setupMapLayers() {
    if (!this.map) {
      return;
    }

    const emptyGeoJSON = { type: "FeatureCollection", features: [] };

    // Source and Layer for Undriven Streets
    if (!this.map.getSource("undriven-streets")) {
      this.map.addSource("undriven-streets", {
        type: "geojson",
        data: emptyGeoJSON,
      });
    }
    if (!this.map.getLayer("undriven-streets-layer")) {
      this.map.addLayer({
        id: "undriven-streets-layer",
        type: "line",
        source: "undriven-streets",
        paint: {
          "line-color": this.streetColors.undriven,
          "line-width": 3,
          "line-opacity": 0.6,
          "line-dasharray": [2, 2],
        },
      });
    }

    // Source and Layer for Calculated Route
    if (!this.map.getSource("route")) {
      this.map.addSource("route", { type: "geojson", data: emptyGeoJSON });
    }
    if (!this.map.getLayer("route-layer")) {
      this.map.addLayer({
        id: "route-layer",
        type: "line",
        source: "route",
        paint: {
          "line-color": this.routeColors.calculated,
          "line-width": 5,
          "line-opacity": 0.8,
        },
      });
    }

    // Source and Layer for Highlighted Target Street
    if (!this.map.getSource("target-street")) {
      this.map.addSource("target-street", {
        type: "geojson",
        data: emptyGeoJSON,
      });
    }
    if (!this.map.getLayer("target-street-layer")) {
      this.map.addLayer({
        id: "target-street-layer",
        type: "line",
        source: "target-street",
        paint: {
          "line-color": this.routeColors.target,
          "line-width": 6,
          "line-opacity": 1,
        },
      });
    }

    // Source and Layer for Efficient Clusters
    if (!this.map.getSource("efficient-clusters")) {
      this.map.addSource("efficient-clusters", {
        type: "geojson",
        data: emptyGeoJSON,
      });
    }
    this.clusterColors.forEach((color, index) => {
      const layerId = `efficient-cluster-layer-${index}`;
      if (this.map.getLayer(layerId)) {
        return;
      }
      this.map.addLayer({
        id: layerId,
        type: "line",
        source: "efficient-clusters",
        paint: { "line-color": color, "line-width": 5, "line-opacity": 0.7 },
        filter: ["==", "clusterIndex", index],
      });
    });
  }

  destroy() {
    this.clusterMarkers.forEach((marker) => {
      try {
        marker.remove();
      } catch {
        // Ignore marker cleanup errors.
      }
    });
    this.clusterMarkers = [];

    if (this.map && this.interactivityHandlers) {
      const { handleMouseEnter, handleMouseLeave, handleClick }
        = this.interactivityHandlers;
      try {
        this.map.off("mouseenter", "undriven-streets-layer", handleMouseEnter);
        this.map.off("mouseleave", "undriven-streets-layer", handleMouseLeave);
        this.map.off("click", "undriven-streets-layer", handleClick);
      } catch {
        // Ignore map listener cleanup errors.
      }
      this.interactivityHandlers = null;
    }

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

  /**
   * Set data on a map source.
   * @param {string} sourceId - The source ID
   * @param {Object} data - GeoJSON data
   */
  setSourceData(sourceId, data) {
    if (!this.map) {
      return;
    }
    const source = this.map.getSource(sourceId);
    if (source) {
      source.setData(data);
    }
  }

  /**
   * Clear multiple map sources to empty GeoJSON.
   * @param {string[]} sourceIds - Array of source IDs to clear
   */
  clearSources(sourceIds) {
    const emptyGeoJSON = { type: "FeatureCollection", features: [] };
    sourceIds.forEach((sourceId) => {
      this.setSourceData(sourceId, emptyGeoJSON);
    });
  }

  /**
   * Query features from a source.
   * @param {string} sourceId - The source ID
   * @param {Object} [options] - Query options including filter
   * @returns {Array} Array of features
   */
  querySourceFeatures(sourceId, options = {}) {
    if (!this.map) {
      return [];
    }
    return this.map.querySourceFeatures(sourceId, options);
  }

  /**
   * Fit the map to given bounds.
   * @param {mapboxgl.LngLatBounds} bounds - The bounds to fit
   * @param {Object} [options] - Fit options like padding
   */
  fitBounds(bounds, options = { padding: 50 }) {
    if (!this.map || bounds.isEmpty()) {
      return;
    }
    this.map.fitBounds(bounds, options);
  }

  /**
   * Pan the map to a location.
   * @param {number[]} coordinates - [lng, lat] coordinates
   */
  panTo(coordinates) {
    if (!this.map) {
      return;
    }
    this.map.panTo(coordinates);
  }

  /**
   * Highlight a target street by segment ID.
   * @param {string} segmentId - The segment ID to highlight
   */
  highlightTargetStreet(segmentId) {
    if (!this.map) {
      return;
    }

    const targetSource = this.map.getSource("target-street");
    if (!targetSource) {
      return;
    }

    // Query the rendered features from the undriven-streets layer
    const features = this.querySourceFeatures("undriven-streets", {
      filter: ["==", ["get", "segment_id"], segmentId],
    });

    if (features && features.length > 0) {
      targetSource.setData({
        type: "FeatureCollection",
        features: [features[0]],
      });
    } else {
      // Fallback: search through all features
      const allFeatures = this.querySourceFeatures("undriven-streets");
      const targetFeature = allFeatures.find(
        (f) => f.properties?.segment_id === segmentId
      );
      if (targetFeature) {
        targetSource.setData({
          type: "FeatureCollection",
          features: [targetFeature],
        });
      } else {
        targetSource.setData({ type: "FeatureCollection", features: [] });
      }
    }
  }

  /**
   * Display efficient street clusters on the map.
   * @param {Array} clusters - Array of cluster objects
   * @param {Function} createPopupFn - Function to create popup HTML for a cluster
   */
  displayEfficientClusters(clusters, createPopupFn) {
    this.clearEfficientClusters();

    const bounds = new mapboxgl.LngLatBounds();
    const features = [];

    clusters.forEach((cluster, index) => {
      cluster.segments.forEach((segment) => {
        if (segment.geometry?.type === "LineString") {
          features.push({
            type: "Feature",
            geometry: segment.geometry,
            properties: { clusterIndex: index },
          });
        }
      });
    });

    this.setSourceData("efficient-clusters", {
      type: "FeatureCollection",
      features,
    });

    // Add cluster markers
    clusters.forEach((cluster, index) => {
      const el = document.createElement("div");
      el.className = "efficient-cluster-marker";
      el.innerHTML = `<div class="cluster-marker-wrapper"><div class="cluster-marker-inner" style="background-color: ${this.clusterColors[index]};"><div class="cluster-number">${index + 1}</div><div class="cluster-count">${cluster.segment_count}</div></div></div>`;

      const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(
        createPopupFn(cluster, index)
      );

      const marker = new mapboxgl.Marker(el)
        .setLngLat(cluster.centroid)
        .setPopup(popup)
        .addTo(this.map);

      this.clusterMarkers.push(marker);
      bounds.extend(cluster.centroid);
    });

    return bounds;
  }

  /**
   * Clear all efficient cluster markers and data.
   */
  clearEfficientClusters() {
    this.clusterMarkers.forEach((marker) => {
      marker.remove();
    });
    this.clusterMarkers = [];

    if (this.map) {
      const source = this.map.getSource("efficient-clusters");
      if (source) {
        source.setData({ type: "FeatureCollection", features: [] });
      }
    }
  }

  /**
   * Set up map interactivity for clicking on streets.
   * @param {Function} createPopupFn - Function to create popup HTML for a segment
   */
  setupInteractivity(createPopupFn) {
    if (!this.map) {
      return;
    }

    const handleMouseEnter = () => {
      this.map.getCanvas().style.cursor = "pointer";
    };

    const handleMouseLeave = () => {
      this.map.getCanvas().style.cursor = "";
    };

    const handleClick = (e) => {
      if (!e.features || e.features.length === 0) {
        return;
      }
      const feature = e.features[0];
      const popupContent = createPopupFn(feature);

      new mapboxgl.Popup().setLngLat(e.lngLat).setHTML(popupContent).addTo(this.map);
    };

    this.map.on("mouseenter", "undriven-streets-layer", handleMouseEnter);
    this.map.on("mouseleave", "undriven-streets-layer", handleMouseLeave);
    this.map.on("click", "undriven-streets-layer", handleClick);
    this.interactivityHandlers = {
      handleMouseEnter,
      handleMouseLeave,
      handleClick,
    };
  }

  /**
   * Get the underlying Mapbox map instance.
   * @returns {mapboxgl.Map|null}
   */
  getMap() {
    return this.map;
  }
}
