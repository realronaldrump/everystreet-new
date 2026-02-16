/* global mapboxgl */

import { CONFIG } from "../core/config.js";

export class OptimalRouteMap {
  constructor(containerId, options = {}) {
    this.containerId = containerId;
    this.options = options;
    this.map = null;
    this.mapLayersReady = false;
    this.routeAnimationFrame = null;
    this.ownsMap = false;
    this.interactivityHandlers = null;

    this.onLayerReady = options.onLayerReady || (() => {});
  }

  initialize() {
    if (this.options.sharedMap) {
      this.map = this.options.sharedMap;
      this.ownsMap = false;
      return this.bindMapLoad();
    }

    const container = document.getElementById(this.containerId);
    if (!container) {
      return Promise.resolve();
    }

    const theme = document.documentElement.getAttribute("data-bs-theme") || "dark";
    const styleUrl = CONFIG.MAP.styles[theme] || CONFIG.MAP.styles.dark;
    this.disableTelemetry();

    this.map = new mapboxgl.Map({
      container: this.containerId,
      style: styleUrl,
      center: [-98.5795, 39.8283], // Center of US
      zoom: 4,
      attributionControl: false,
    });

    if (this.options.addNavigationControl) {
      this.map.addControl(new mapboxgl.NavigationControl(), "top-right");
    }

    this.ownsMap = true;
    return this.bindMapLoad();
  }

  disableTelemetry() {
    if (typeof mapboxgl?.setTelemetryEnabled === "function") {
      mapboxgl.setTelemetryEnabled(false);
    }
    if (typeof mapboxgl?.config === "object") {
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
  }

  bindMapLoad() {
    if (!this.map) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const handleLoad = () => {
        this.addArrowImage();
        this.setupMapLayers();
        this.onLayerReady();
        resolve();
      };
      if (typeof this.map.isStyleLoaded === "function" && this.map.isStyleLoaded()) {
        handleLoad();
      } else {
        this.map.on("load", handleLoad);
      }
    });
  }

  addArrowImage() {
    if (this.map.hasImage("arrow")) {
      return;
    }

    const width = 24;
    const height = 24;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");

    // Draw arrow
    ctx.fillStyle = "#b87a4a"; // Copper
    ctx.strokeStyle = "#faf9f7";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(width * 0.2, height * 0.8);
    ctx.lineTo(width * 0.5, height * 0.2);
    ctx.lineTo(width * 0.8, height * 0.8);
    ctx.stroke();
    ctx.fill();

    const imageData = ctx.getImageData(0, 0, width, height);
    this.map.addImage("arrow", imageData, { pixelRatio: 2 });
  }

  setupMapLayers() {
    if (!this.map || this.mapLayersReady) {
      return;
    }

    const emptyGeoJSON = { type: "FeatureCollection", features: [] };

    this.addSource("streets-driven", emptyGeoJSON);
    this.addSource("streets-undriven", emptyGeoJSON);
    this.addSource("optimal-route", emptyGeoJSON);

    this.addLayer({
      id: "streets-driven-layer",
      type: "line",
      source: "streets-driven",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": "#4d9a6a",
        "line-width": 2,
        "line-opacity": 0.6,
      },
    });

    this.addLayer({
      id: "streets-undriven-layer",
      type: "line",
      source: "streets-undriven",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": "#c47050",
        "line-width": 2.5,
        "line-opacity": 0.8,
      },
    });

    // Add cursor interaction for undriven streets
    const handleMouseEnter = () => {
      this.map.getCanvas().style.cursor = "pointer";
    };
    const handleMouseLeave = () => {
      this.map.getCanvas().style.cursor = "";
    };
    this.map.on("mouseenter", "streets-undriven-layer", handleMouseEnter);
    this.map.on("mouseleave", "streets-undriven-layer", handleMouseLeave);
    this.interactivityHandlers = { handleMouseEnter, handleMouseLeave };

    this.addLayer({
      id: "optimal-route-line",
      type: "line",
      source: "optimal-route",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": "#b87a4a",
        "line-width": 5,
        "line-opacity": 0.9,
      },
    });

    this.addLayer({
      id: "optimal-route-arrows",
      type: "symbol",
      source: "optimal-route",
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 100,
        "icon-image": "arrow",
        "icon-size": 0.5,
        "icon-allow-overlap": true,
      },
    });

    this.mapLayersReady = true;
  }

  addSource(id, data) {
    if (!this.map.getSource(id)) {
      this.map.addSource(id, { type: "geojson", data });
    }
  }

  addLayer(layerDef) {
    if (!this.map.getLayer(layerDef.id)) {
      this.map.addLayer(layerDef);
    }
  }

  ensureMapLayers() {
    if (!this.map) {
      return false;
    }
    if (this.map.getSource("streets-driven")) {
      return true;
    }
    if (typeof this.map.isStyleLoaded === "function" && !this.map.isStyleLoaded()) {
      return false;
    }
    this.setupMapLayers();
    return Boolean(this.map.getSource("streets-driven"));
  }

  updateStreets(drivenFeatures, undrivenFeatures) {
    if (!this.ensureMapLayers()) {
      return;
    }

    this.setSourceData("streets-driven", drivenFeatures);
    this.setSourceData("streets-undriven", undrivenFeatures);
  }

  setSourceData(sourceId, features) {
    const source = this.map.getSource(sourceId);
    if (source) {
      source.setData({
        type: "FeatureCollection",
        features: features || [],
      });
    }
  }

  clearStreets() {
    this.setSourceData("streets-driven", []);
    this.setSourceData("streets-undriven", []);
  }

  clearRoute() {
    if (this.routeAnimationFrame) {
      cancelAnimationFrame(this.routeAnimationFrame);
      this.routeAnimationFrame = null;
    }
    this.setSourceData("optimal-route", []);
  }

  destroy() {
    if (this.routeAnimationFrame) {
      cancelAnimationFrame(this.routeAnimationFrame);
      this.routeAnimationFrame = null;
    }

    if (this.map && this.interactivityHandlers) {
      const { handleMouseEnter, handleMouseLeave } = this.interactivityHandlers;
      try {
        this.map.off("mouseenter", "streets-undriven-layer", handleMouseEnter);
        this.map.off("mouseleave", "streets-undriven-layer", handleMouseLeave);
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

  displayRoute(coordinates, stats, animate = false) {
    if (!this.map || !coordinates || coordinates.length < 2) {
      return;
    }
    if (!this.ensureMapLayers()) {
      return;
    }

    if (this.routeAnimationFrame) {
      cancelAnimationFrame(this.routeAnimationFrame);
      this.routeAnimationFrame = null;
    }

    const geojson = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates,
          },
          properties: stats,
        },
      ],
    };

    if (animate) {
      this.setSourceData("optimal-route", []); // Clear first
      this.animateRouteDrawing(geojson);
    } else {
      const source = this.map.getSource("optimal-route");
      if (source) {
        source.setData(geojson);
      }
    }

    // Fit bounds
    const routeBounds = coordinates.reduce(
      (accBounds, coord) => accBounds.extend(coord),
      new mapboxgl.LngLatBounds(coordinates[0], coordinates[0])
    );

    this.map.fitBounds(routeBounds, { padding: 50, duration: 1000 });
  }

  animateRouteDrawing(geojson) {
    const source = this.map?.getSource("optimal-route");
    const coordinates = geojson?.features?.[0]?.geometry?.coordinates;
    const properties = geojson?.features?.[0]?.properties || {};

    if (!source || !coordinates || coordinates.length < 2) {
      if (source) {
        source.setData(geojson);
      }
      return;
    }

    const total = coordinates.length;
    const step = Math.max(2, Math.round(total / 180));
    let index = 2;

    const drawFrame = () => {
      const slice = coordinates.slice(0, index);
      source.setData({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: slice,
            },
            properties,
          },
        ],
      });

      if (index < total) {
        index = Math.min(total, index + step);
        this.routeAnimationFrame = requestAnimationFrame(drawFrame);
      } else {
        source.setData(geojson);
        this.routeAnimationFrame = null;
      }
    };

    this.routeAnimationFrame = requestAnimationFrame(drawFrame);
  }

  flyToBounds(bounds) {
    if (!this.map || !bounds) {
      return;
    }
    const [south, north, west, east] = bounds;
    this.map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: 50, duration: 1000 }
    );
  }

  toggleLayer(layerIds, isVisible) {
    if (!this.map || !this.mapLayersReady) {
      return;
    }
    layerIds.forEach((id) => {
      try {
        if (this.map.getLayer(id)) {
          this.map.setLayoutProperty(id, "visibility", isVisible ? "visible" : "none");
        }
      } catch (e) {
        console.warn(`Could not toggle layer ${id}:`, e.message);
      }
    });
  }

  setLayerOpacity(layerIds, opacity) {
    if (!this.map || !this.mapLayersReady) {
      return;
    }
    layerIds.forEach((id) => {
      try {
        const layer = this.map.getLayer(id);
        if (layer) {
          const layerType = layer.type;
          if (layerType === "symbol") {
            this.map.setPaintProperty(id, "icon-opacity", opacity);
            this.map.setPaintProperty(id, "text-opacity", opacity);
          } else if (layerType === "line") {
            this.map.setPaintProperty(id, "line-opacity", opacity);
          } else if (layerType === "fill") {
            this.map.setPaintProperty(id, "fill-opacity", opacity);
          }
        }
      } catch (e) {
        console.warn(`Could not set opacity for layer ${id}:`, e.message);
      }
    });
  }

  moveLayers(layerIds) {
    if (!this.map || !this.mapLayersReady) {
      return;
    }
    layerIds.forEach((layerId) => {
      try {
        if (this.map.getLayer(layerId)) {
          this.map.moveLayer(layerId); // Moves to top by default
        }
      } catch (e) {
        console.warn(`Could not move layer ${layerId}:`, e.message);
      }
    });
  }
}
