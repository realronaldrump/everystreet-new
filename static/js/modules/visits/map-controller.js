/* global mapboxgl */

import { createMap } from "../map-base.js";
import MapStyles from "../map-styles.js";
import { VisitsGeometry } from "./geometry.js";

class VisitsMapController {
  constructor({
    geometryUtils = VisitsGeometry,
    mapStyles = MapStyles,
    onPlaceClicked,
  } = {}) {
    this.geometryUtils = geometryUtils;
    this.mapStyles = mapStyles;
    this.onPlaceClicked = onPlaceClicked;
    this.map = null;
    this.mapStyle = "dark";
    this.customPlacesData = { type: "FeatureCollection", features: [] };
    this.placeFeatures = new Map();
    this.activePopup = null;
  }

  initialize(theme) {
    return new Promise((resolve, reject) => {
      try {
        this.mapStyle = theme || "dark";
        this.map = createMap("map", {
          library: "mapbox",
          style:
            this.mapStyle === "light"
              ? "mapbox://styles/mapbox/light-v11"
              : "mapbox://styles/mapbox/dark-v11",
          center: [-95.7129, 37.0902],
          zoom: 4,
          attributionControl: false,
          pitchWithRotate: false,
          dragRotate: false,
          touchZoomRotate: false,
        });

        this.map.addControl(
          new mapboxgl.NavigationControl({ showCompass: false }),
          "bottom-right"
        );

        this.map.on("load", () => {
          this._addPlacesSource();
          this._addPlacesLayers();
          this._bindPlaceInteractions();
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  getMap() {
    return this.map;
  }

  setPlaces(places) {
    this.customPlacesData.features = [];
    this.placeFeatures.clear();
    places.forEach((place) => {
      this.addPlace(place, false);
    });
    this._refreshPlacesSource();
  }

  addPlace(place, refreshSource = true) {
    if (!place?.geometry || !place?._id) {
      return;
    }
    const feature = VisitsMapController._createFeature(place);
    this.placeFeatures.set(place._id, feature);
    this.customPlacesData.features.push(feature);
    if (refreshSource) {
      this._refreshPlacesSource();
    }
  }

  removePlace(placeId) {
    if (!this.placeFeatures.has(placeId)) {
      return;
    }
    const feature = this.placeFeatures.get(placeId);
    this.customPlacesData.features = this.customPlacesData.features.filter(
      (f) => f !== feature
    );
    this.placeFeatures.delete(placeId);
    this._refreshPlacesSource();
  }

  previewSuggestion(suggestion) {
    if (!this.map || !suggestion?.boundary) {
      return;
    }

    if (this.map.getLayer("suggestion-preview-fill")) {
      this.map.removeLayer("suggestion-preview-fill");
    }
    if (this.map.getSource("suggestion-preview")) {
      this.map.removeSource("suggestion-preview");
    }

    this.map.addSource("suggestion-preview", {
      type: "geojson",
      data: suggestion.boundary,
    });

    this.map.addLayer({
      id: "suggestion-preview-fill",
      type: "fill",
      source: "suggestion-preview",
      paint: {
        "fill-color": "#F59E0B",
        "fill-opacity": 0.25,
      },
    });

    this.geometryUtils.fitMapToGeometry(this.map, suggestion.boundary, {
      padding: 50,
      duration: 1000,
    });
  }

  animateToPlace(place) {
    if (!place?.geometry || !this.map) {
      return;
    }
    this.geometryUtils.fitMapToGeometry(this.map, place.geometry, {
      padding: 100,
      duration: 1000,
    });
  }

  zoomToFitAllPlaces() {
    if (!this.map || this.customPlacesData.features.length === 0) {
      return;
    }
    const geometry = {
      type: "GeometryCollection",
      geometries: this.customPlacesData.features.map((f) => f.geometry),
    };
    this.geometryUtils.fitMapToGeometry(this.map, geometry, {
      padding: 50,
      duration: 1000,
    });
  }

  toggleCustomPlacesVisibility(isVisible) {
    if (!this.map) {
      return;
    }
    const visibility = isVisible ? "visible" : "none";
    ["custom-places-fill", "custom-places-outline", "custom-places-highlight"].forEach(
      (layerId) => {
        if (this.map.getLayer(layerId)) {
          this.map.setLayoutProperty(layerId, "visibility", visibility);
        }
      }
    );
  }

  toggleMapStyle() {
    this.mapStyle = this.mapStyle === "satellite" ? "dark" : "satellite";
    const styleUrl
      = this.mapStyle === "satellite"
        ? "mapbox://styles/mapbox/satellite-streets-v12"
        : "mapbox://styles/mapbox/dark-v11";

    this.map.setStyle(styleUrl);
    this.map.once("styledata", () => {
      this._addPlacesSource();
      this._addPlacesLayers();
      this._refreshPlacesSource();
      this._bindPlaceInteractions();
    });
  }

  updateTheme(theme) {
    this.mapStyle = theme === "light" ? "light" : "dark";
    const styleUrl
      = this.mapStyle === "light"
        ? "mapbox://styles/mapbox/light-v11"
        : "mapbox://styles/mapbox/dark-v11";

    const center = this.map?.getCenter();
    const zoom = this.map?.getZoom();
    const bearing = this.map?.getBearing();
    const pitch = this.map?.getPitch();

    this.map?.setStyle(styleUrl);
    this.map?.once("styledata", () => {
      if (center) {
        this.map.jumpTo({ center, zoom, bearing, pitch });
      }
      this._addPlacesSource();
      this._addPlacesLayers();
      this._refreshPlacesSource();
      this._bindPlaceInteractions();
      setTimeout(() => this.map?.resize(), 100);
    });
  }

  /**
   * Show a popup with XSS-safe DOM content
   * @param {HTMLElement|string} content - DOM element (safe) or text (will be escaped)
   * @param {LngLat} lngLat - Map coordinates
   */
  showPlacePopup(content, lngLat) {
    if (!this.map) {
      return null;
    }
    this.activePopup?.remove?.();

    this.activePopup = new mapboxgl.Popup({
      offset: 12,
      className: "custom-popup-enhanced",
      maxWidth: "320px",
    }).setLngLat(lngLat);

    // Use setDOMContent for safe content instead of setHTML to prevent XSS
    if (content instanceof HTMLElement) {
      this.activePopup.setDOMContent(content);
    } else {
      const container = document.createElement("div");
      container.textContent = String(content); // textContent is XSS-safe
      this.activePopup.setDOMContent(container);
    }

    this.activePopup.addTo(this.map);
    return this.activePopup;
  }

  /**
   * Create safe popup content from place data
   * @param {Object} place - Place object
   * @returns {HTMLElement} - Safe DOM content
   */
  static createPlacePopupContent(place) {
    const container = document.createElement("div");
    container.className = "place-popup-content";

    const title = document.createElement("strong");
    title.textContent = place.name || "Unnamed Place";
    container.appendChild(title);

    if (place.visitCount) {
      const visits = document.createElement("div");
      visits.className = "place-visits";
      visits.textContent = `${place.visitCount} visit${place.visitCount !== 1 ? "s" : ""}`;
      container.appendChild(visits);
    }

    return container;
  }

  closePopup() {
    this.activePopup?.remove?.();
    this.activePopup = null;
  }

  static _createFeature(place) {
    return {
      type: "Feature",
      id: place._id,
      geometry: place.geometry,
      properties: {
        placeId: place._id,
        name: place.name,
      },
    };
  }

  _addPlacesSource() {
    if (!this.map) {
      return;
    }

    if (this.map.getSource("custom-places")) {
      return;
    }

    this.map.addSource("custom-places", {
      type: "geojson",
      data: this.customPlacesData,
    });
  }

  _addPlacesLayers() {
    if (!this.map || !this.map.getSource("custom-places")) {
      return;
    }

    if (!this.map.getLayer("custom-places-fill")) {
      this.map.addLayer({
        id: "custom-places-fill",
        type: "fill",
        source: "custom-places",
        paint: {
          "fill-color": this.mapStyles.MAP_LAYER_COLORS.customPlaces.fill,
          "fill-opacity": 0.15,
        },
      });
    }

    if (!this.map.getLayer("custom-places-outline")) {
      this.map.addLayer({
        id: "custom-places-outline",
        type: "line",
        source: "custom-places",
        paint: {
          "line-color": this.mapStyles.MAP_LAYER_COLORS.customPlaces.outline,
          "line-width": 2,
        },
      });
    }

    if (!this.map.getLayer("custom-places-highlight")) {
      this.map.addLayer({
        id: "custom-places-highlight",
        type: "line",
        source: "custom-places",
        paint: {
          "line-color": this.mapStyles.MAP_LAYER_COLORS.customPlaces.highlight,
          "line-width": 4,
          "line-opacity": 0,
        },
      });
    }
  }

  _bindPlaceInteractions() {
    if (!this.map?.getLayer("custom-places-fill")) {
      return;
    }

    let hoveredStateId = null;
    this.map.on("mousemove", "custom-places-fill", (e) => {
      if (e.features.length > 0) {
        const featureId = e.features[0].id;
        // Guard against undefined feature IDs
        if (featureId === undefined || featureId === null) {
          this.map.getCanvas().style.cursor = "pointer";
          return;
        }
        if (hoveredStateId !== null && hoveredStateId !== undefined) {
          this.map.setFeatureState(
            { source: "custom-places", id: hoveredStateId },
            { hover: false }
          );
        }
        hoveredStateId = featureId;
        this.map.setFeatureState(
          { source: "custom-places", id: hoveredStateId },
          { hover: true }
        );
        this.map.getCanvas().style.cursor = "pointer";
      }
    });

    this.map.on("mouseleave", "custom-places-fill", () => {
      if (hoveredStateId !== null && hoveredStateId !== undefined) {
        this.map.setFeatureState(
          { source: "custom-places", id: hoveredStateId },
          { hover: false }
        );
      }
      hoveredStateId = null;
      this.map.getCanvas().style.cursor = "";
    });

    this.map.on("click", "custom-places-fill", (e) => {
      const feature = e.features?.[0];
      const placeId = feature?.properties?.placeId;
      if (placeId) {
        this._animatePlaceClick();
        this.onPlaceClicked?.(placeId, e.lngLat);
      }
    });
  }

  _animatePlaceClick() {
    if (!this.map?.getLayer("custom-places-highlight")) {
      return;
    }
    this.map.setPaintProperty("custom-places-highlight", "line-opacity", 0.8);
    setTimeout(() => {
      this.map?.setPaintProperty("custom-places-highlight", "line-opacity", 0);
    }, 300);
  }

  _refreshPlacesSource() {
    if (this.map?.getSource("custom-places")) {
      this.map.getSource("custom-places").setData(this.customPlacesData);
    }
  }
}

export { VisitsMapController };
export default VisitsMapController;
