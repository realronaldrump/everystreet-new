/* global mapboxgl */

import { CONFIG } from "./config.js";
import state from "./state.js";
import utils from "./utils.js";

// NOTE: this is extracted verbatim from `app.js` to keep behaviour identical.
// Future refactors can safely trim dependencies now that the code is isolated.

const mapManager = {
  async initialize() {
    try {
      const initStage = window.loadingManager.startStage(
        "init",
        "Initializing map...",
      );

      const mapElement = utils.getElement("map");
      if (!mapElement || state.map) {
        initStage.complete();
        return state.mapInitialized;
      }

      if (!window.MAPBOX_ACCESS_TOKEN) {
        throw new Error("Mapbox access token not configured");
      }

      mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;

      if (!mapboxgl.supported()) {
        mapElement.innerHTML =
          '<div class="webgl-unsupported-message p-4 text-center">WebGL is not supported by your browser.</div>';
        throw new Error("WebGL not supported");
      }

      initStage.update(30, "Configuring map...");

      // Disable telemetry for performance
      mapboxgl.config.REPORT_MAP_LOAD_TIMES = false;
      mapboxgl.config.COLLECT_RESOURCE_TIMING = false;

      const theme =
        document.documentElement.getAttribute("data-bs-theme") || "dark";

      // Determine initial map view
      const urlParams = new URLSearchParams(window.location.search);
      const latParam = parseFloat(urlParams.get("lat"));
      const lngParam = parseFloat(urlParams.get("lng"));
      const zoomParam = parseFloat(urlParams.get("zoom"));
      const savedView = utils.getStorage("mapView");
      const center =
        !Number.isNaN(latParam) && !Number.isNaN(lngParam)
          ? [lngParam, latParam]
          : savedView?.center || CONFIG.MAP.defaultCenter;
      const zoom = !Number.isNaN(zoomParam)
        ? zoomParam
        : savedView?.zoom || CONFIG.MAP.defaultZoom;

      // Determine initial map style - respect stored preference or use theme
      const storedMapType = utils.getStorage("mapType");
      const initialMapType = storedMapType || theme;
      const initialStyle =
        CONFIG.MAP.styles[initialMapType] || CONFIG.MAP.styles[theme];

      initStage.update(60, "Creating map instance...");

      state.map = new mapboxgl.Map({
        container: "map",
        style: initialStyle,
        center,
        zoom,
        maxZoom: CONFIG.MAP.maxZoom,
        attributionControl: false,
        logoPosition: "bottom-right",
        ...CONFIG.MAP.performanceOptions,
        transformRequest: (url) => {
          if (typeof url === "string") {
            try {
              // Use window.location.origin for base in case of relative URLs
              const parsed = new URL(url, window.location.origin);
              if (parsed.hostname === "events.mapbox.com") {
                return null;
              }
            } catch (_e) {
              // Ignore parse errors, do not block
            }
          }
          return { url };
        },
      });

      window.map = state.map;

      initStage.update(80, "Adding controls...");

      // Add controls
      state.map.addControl(new mapboxgl.NavigationControl(), "top-right");
      state.map.addControl(
        new mapboxgl.AttributionControl({ compact: true }),
        "bottom-right",
      );

      // Setup event handlers
      const saveViewState = utils.debounce(() => {
        if (!state.map) return;
        const center = state.map.getCenter();
        const zoom = state.map.getZoom();
        utils.setStorage("mapView", {
          center: [center.lng, center.lat],
          zoom,
        });
        this.updateUrlState();
      }, CONFIG.MAP.debounceDelay);

      state.map.on("moveend", saveViewState);
      state.map.on("click", this.handleMapClick.bind(this));

      // Wait for map to load
      await new Promise((resolve) => {
        state.map.on("load", () => {
          initStage.complete();
          resolve();
        });
      });

      state.mapInitialized = true;
      state.metrics.mapLoadTime = Date.now() - state.metrics.loadStartTime;

      document.dispatchEvent(new CustomEvent("mapInitialized"));

      return true;
    } catch (error) {
      console.error("Map initialization error:", error);
      window.loadingManager.stageError("init", error.message);
      window.notificationManager.show(
        `Map initialization failed: ${error.message}`,
        "danger",
      );
      return false;
    }
  },

  updateUrlState() {
    if (!state.map || !window.history?.replaceState) return;

    try {
      const center = state.map.getCenter();
      const zoom = state.map.getZoom();
      const url = new URL(window.location.href);

      url.searchParams.set("zoom", zoom.toFixed(2));
      url.searchParams.set("lat", center.lat.toFixed(5));
      url.searchParams.set("lng", center.lng.toFixed(5));

      window.history.replaceState({}, "", url.toString());
    } catch (error) {
      console.warn("Failed to update URL:", error);
    }
  },

  handleMapClick(e) {
    // Clear selections when clicking on an empty area.
    // Only query non-heatmap layers that support feature selection
    const queryLayers = [];
    if (state.map.getLayer("trips-hitbox")) {
      queryLayers.push("trips-hitbox");
    } else if (
      !state.mapLayers.trips?.isHeatmap &&
      state.map.getLayer("trips-layer")
    ) {
      queryLayers.push("trips-layer");
    } else if (
      state.mapLayers.trips?.isHeatmap &&
      state.map.getLayer("trips-layer-1")
    ) {
      queryLayers.push("trips-layer-1");
    }
    if (state.map.getLayer("matchedTrips-hitbox")) {
      queryLayers.push("matchedTrips-hitbox");
    } else if (state.map.getLayer("matchedTrips-layer")) {
      queryLayers.push("matchedTrips-layer");
    }

    if (queryLayers.length === 0) {
      // No queryable layers, just clear selection if needed
      if (state.selectedTripId) {
        state.selectedTripId = null;
        state.selectedTripLayer = null;
        this.refreshTripStyles();
      }
      return;
    }

    const features = state.map.queryRenderedFeatures(e.point, {
      layers: queryLayers,
    });

    if (features.length === 0) {
      if (state.selectedTripId) {
        state.selectedTripId = null;
        state.selectedTripLayer = null;
        this.refreshTripStyles();
      }
    }
  },

  refreshTripStyles: utils.throttle(() => {
    if (!state.map || !state.mapInitialized) return;

    const selectedId = state.selectedTripId
      ? String(state.selectedTripId)
      : null;

    ["trips", "matchedTrips"].forEach((layerName) => {
      const layerInfo = state.mapLayers[layerName];
      if (!layerInfo?.visible) return;

      // Skip heatmap layers - they don't support trip selection styling
      if (layerInfo.isHeatmap) return;

      const layerId = `${layerName}-layer`;
      if (!state.map.getLayer(layerId)) return;

      const baseColor = layerInfo.color || "#4A90D9";
      const baseWeight = layerInfo.weight || 2;

      // Simple styling: highlight selected trip, otherwise use base color
      const colorExpr = selectedId
        ? [
            "case",
            [
              "==",
              [
                "to-string",
                ["coalesce", ["get", "transactionId"], ["get", "id"]],
              ],
              selectedId,
            ],
            layerInfo.highlightColor || "#FFD700",
            baseColor,
          ]
        : baseColor;

      const widthExpr = selectedId
        ? [
            "case",
            [
              "==",
              [
                "to-string",
                ["coalesce", ["get", "transactionId"], ["get", "id"]],
              ],
              selectedId,
            ],
            baseWeight * 2,
            baseWeight,
          ]
        : baseWeight;

      try {
        state.map.setPaintProperty(layerId, "line-color", colorExpr);
        state.map.setPaintProperty(layerId, "line-opacity", layerInfo.opacity);
        state.map.setPaintProperty(layerId, "line-width", widthExpr);
      } catch (error) {
        console.warn("Failed to update trip styles:", error);
      }
    });

    mapManager._updateSelectedTripOverlay(selectedId);
  }, CONFIG.MAP.throttleDelay),

  _updateSelectedTripOverlay(selectedId) {
    if (!state.map || !state.mapInitialized) return;

    const sourceId = "selected-trip-source";
    const layerId = "selected-trip-layer";

    const removeOverlay = () => {
      if (state.map.getLayer(layerId)) {
        state.map.removeLayer(layerId);
      }
      if (state.map.getSource(sourceId)) {
        state.map.removeSource(sourceId);
      }
    };

    if (
      !selectedId ||
      state.selectedTripLayer !== "trips" ||
      !state.mapLayers.trips?.isHeatmap ||
      !state.mapLayers.trips?.visible
    ) {
      removeOverlay();
      return;
    }

    const tripLayer = state.mapLayers.trips?.layer;
    const matchingFeature = tripLayer?.features?.find((feature) => {
      const featureId =
        feature?.properties?.transactionId ||
        feature?.properties?.id ||
        feature?.properties?.tripId ||
        feature?.id;
      return featureId != null && String(featureId) === selectedId;
    });

    if (!matchingFeature?.geometry) {
      removeOverlay();
      return;
    }

    const selectedFeature = {
      type: "Feature",
      geometry: matchingFeature.geometry,
      properties: matchingFeature.properties || {},
    };

    const highlightColor =
      window.MapStyles?.MAP_LAYER_COLORS?.trips?.selected || "#FFD700";
    const highlightWidth = [
      "interpolate",
      ["linear"],
      ["zoom"],
      6,
      2,
      10,
      4,
      14,
      6,
      18,
      10,
      22,
      14,
    ];

    if (!state.map.getSource(sourceId)) {
      state.map.addSource(sourceId, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [selectedFeature] },
      });
    } else {
      state.map.getSource(sourceId).setData({
        type: "FeatureCollection",
        features: [selectedFeature],
      });
    }

    if (!state.map.getLayer(layerId)) {
      state.map.addLayer({
        id: layerId,
        type: "line",
        source: sourceId,
        layout: {
          "line-join": "round",
          "line-cap": "round",
        },
        paint: {
          "line-color": highlightColor,
          "line-opacity": 0.9,
          "line-width": highlightWidth,
        },
      });
    } else {
      state.map.setPaintProperty(layerId, "line-color", highlightColor);
      state.map.setPaintProperty(layerId, "line-width", highlightWidth);
    }
  },

  async fitBounds(animate = true) {
    if (!state.map || !state.mapInitialized) return;

    await utils.measurePerformance("fitBounds", async () => {
      const bounds = new mapboxgl.LngLatBounds();
      let hasFeatures = false;

      Object.values(state.mapLayers).forEach(({ visible, layer }) => {
        if (visible && layer?.features) {
          layer.features.forEach((feature) => {
            if (feature.geometry) {
              if (feature.geometry.type === "Point") {
                bounds.extend(feature.geometry.coordinates);
                hasFeatures = true;
              } else if (feature.geometry.type === "LineString") {
                feature.geometry.coordinates.forEach((coord) => {
                  bounds.extend(coord);
                  hasFeatures = true;
                });
              }
            }
          });
        }
      });

      if (hasFeatures && !bounds.isEmpty()) {
        state.map.fitBounds(bounds, {
          padding: 50,
          maxZoom: 15,
          duration: animate ? 1000 : 0,
        });
      }
    });
  },

  zoomToLastTrip(targetZoom = 14) {
    if (!state.map || !state.mapLayers.trips?.layer?.features) return;

    const { features } = state.mapLayers.trips.layer;

    const lastTripFeature = features.reduce((latest, feature) => {
      const endTime = feature.properties?.endTime;
      if (!endTime) return latest;

      const time = new Date(endTime).getTime();
      const latestTime = latest?.properties?.endTime
        ? new Date(latest.properties.endTime).getTime()
        : 0;

      return time > latestTime ? feature : latest;
    }, null);

    if (!lastTripFeature?.geometry) return;

    let lastCoord = null;
    const { type, coordinates } = lastTripFeature.geometry;

    if (type === "LineString" && coordinates?.length > 0) {
      lastCoord = coordinates[coordinates.length - 1];
    } else if (type === "Point") {
      lastCoord = coordinates;
    }

    if (
      lastCoord?.length === 2 &&
      !Number.isNaN(lastCoord[0]) &&
      !Number.isNaN(lastCoord[1])
    ) {
      state.map.flyTo({
        center: lastCoord,
        zoom: targetZoom,
        duration: 2000,
        essential: true,
      });
    }
  },
};

export default mapManager;
