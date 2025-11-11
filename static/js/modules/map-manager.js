/* global mapboxgl */
import utils from "./utils.js";
import { CONFIG } from "./config.js";
import state from "./state.js";

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
        !isNaN(latParam) && !isNaN(lngParam)
          ? [lngParam, latParam]
          : savedView?.center || CONFIG.MAP.defaultCenter;
      const zoom = !isNaN(zoomParam)
        ? zoomParam
        : savedView?.zoom || CONFIG.MAP.defaultZoom;

      initStage.update(60, "Creating map instance...");

      state.map = new mapboxgl.Map({
        container: "map",
        style: CONFIG.MAP.styles[theme],
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
            } catch (e) {
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
    const features = state.map.queryRenderedFeatures(e.point, {
      layers: ["trips-layer", "matchedTrips-layer"],
    });

    if (features.length === 0) {
      if (state.selectedTripId) {
        state.selectedTripId = null;
        this.refreshTripStyles();
      }
    }
  },

  refreshTripStyles: utils.throttle(() => {
    if (!state.map || !state.mapInitialized) return;

    const selectedId = state.selectedTripId
      ? String(state.selectedTripId)
      : null;
    const highlightRecent = state.mapSettings.highlightRecentTrips;

    ["trips", "matchedTrips"].forEach((layerName) => {
      const layerInfo = state.mapLayers[layerName];
      if (!layerInfo?.visible) return;

      const layerId = `${layerName}-layer`;
      if (!state.map.getLayer(layerId)) return;

      // Build dynamic color expression
      // Priority: selected trip > recent trip > default
      const colorExpr = ["case"];
      const baseColor =
        layerInfo.color || window.MapStyles.MAP_LAYER_COLORS.trips.default;
      const intensityProperty = ["coalesce", ["get", "heatIntensity"], 0];
      const clampedIntensity = ["max", 0, ["min", 1, intensityProperty]];

      if (selectedId) {
        colorExpr.push([
          "==",
          [
            "to-string",
            [
              "coalesce",
              ["get", "transactionId"],
              ["get", "id"],
              ["get", "tripId"],
            ],
          ],
          selectedId,
        ]);
        colorExpr.push(
          layerInfo.highlightColor ||
            window.MapStyles.MAP_LAYER_COLORS.trips.selected,
        );
      }

      if (highlightRecent) {
        colorExpr.push(["==", ["get", "isRecent"], true]);
        const recentColor = layerInfo.colorRecentExpression || [
          "interpolate",
          ["linear"],
          intensityProperty,
          0,
          window.MapStyles.MAP_LAYER_COLORS.trips.recent.light,
          1,
          layerInfo.colorRecent ||
            window.MapStyles.MAP_LAYER_COLORS.trips.recent.dark,
        ];
        colorExpr.push(recentColor);
      }

      // Default color
      colorExpr.push(baseColor);

      // Build width expression (slightly thicker for selected)
      const baseWeight = layerInfo.weight || 2;
      const intensityWidthExpr = [
        "*",
        baseWeight,
        ["+", 0.6, ["*", 1.4, clampedIntensity]],
      ];
      const widthExpr = ["case"];
      if (selectedId) {
        widthExpr.push([
          "==",
          [
            "to-string",
            [
              "coalesce",
              ["get", "transactionId"],
              ["get", "id"],
              ["get", "tripId"],
            ],
          ],
          selectedId,
        ]);
        widthExpr.push(baseWeight * 2);
      }
      widthExpr.push(["==", ["get", "isRecent"], true]);
      widthExpr.push(baseWeight * 1.5);
      widthExpr.push(intensityWidthExpr);

      // Apply paint updates
      try {
        state.map.setPaintProperty(layerId, "line-color", colorExpr);
        state.map.setPaintProperty(layerId, "line-opacity", layerInfo.opacity);
        // Maintain zoom-interpolated width by wrapping expression with interpolate if necessary
        const zoomWidthExpr = [
          "interpolate",
          ["linear"],
          ["zoom"],
          10,
          ["*", 0.5, widthExpr],
          15,
          widthExpr,
          20,
          ["*", 2, widthExpr],
        ];
        state.map.setPaintProperty(layerId, "line-width", zoomWidthExpr);
      } catch (error) {
        console.warn("Failed to update trip styles:", error);
      }
    });
  }, CONFIG.MAP.throttleDelay),

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
      !isNaN(lastCoord[0]) &&
      !isNaN(lastCoord[1])
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

// Make available globally for legacy code until the rest of the app is fully migrated.
if (!window.EveryStreet) window.EveryStreet = {};
window.EveryStreet.MapManager = mapManager;

export default mapManager;
