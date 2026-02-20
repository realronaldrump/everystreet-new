/**
 * County Map Layers Module
 * Handles map layer creation and management
 */

import { COLORS } from "./constants.js";
import { getCurrentTheme, resolveMapStyle } from "../core/map-style-resolver.js";
import * as CountyMapState from "./state.js";

/**
 * Add all map layers for counties and states
 */
export function addMapLayers() {
  const map = CountyMapState.getMap();
  const countyData = CountyMapState.getCountyData();
  const statesData = CountyMapState.getStatesData();
  const showStoppedCounties = CountyMapState.getShowStoppedCounties();

  if (!map || !countyData || !statesData) {
    return;
  }

  // Add counties source
  map.addSource("counties", {
    type: "geojson",
    data: countyData,
  });

  // Add states source for borders
  map.addSource("states", {
    type: "geojson",
    data: statesData,
  });

  // Unvisited counties fill (subtle)
  map.addLayer({
    id: "counties-unvisited-fill",
    type: "fill",
    source: "counties",
    filter: ["!=", ["get", "visited"], true],
    paint: {
      "fill-color": COLORS.unvisited.fill,
      "fill-opacity": 1,
    },
  });

  // Visited counties fill (green)
  map.addLayer({
    id: "counties-visited-fill",
    type: "fill",
    source: "counties",
    filter: ["==", ["get", "visited"], true],
    paint: {
      "fill-color": COLORS.visited.fill,
      "fill-opacity": COLORS.visited.opacity,
    },
  });

  // Stopped counties fill (optional highlight)
  map.addLayer({
    id: "counties-stopped-fill",
    type: "fill",
    source: "counties",
    filter: ["==", ["get", "stopped"], true],
    layout: {
      visibility: showStoppedCounties ? "visible" : "none",
    },
    paint: {
      "fill-color": COLORS.stopped.fill,
      "fill-opacity": COLORS.stopped.opacity,
    },
  });

  // County borders
  map.addLayer({
    id: "counties-border",
    type: "line",
    source: "counties",
    paint: {
      "line-color": COLORS.borders.county,
      "line-width": 0.5,
    },
  });

  // Visited county borders (more prominent)
  map.addLayer({
    id: "counties-visited-border",
    type: "line",
    source: "counties",
    filter: ["==", ["get", "visited"], true],
    paint: {
      "line-color": COLORS.visited.border,
      "line-width": 1,
    },
  });

  // Stopped county borders
  map.addLayer({
    id: "counties-stopped-border",
    type: "line",
    source: "counties",
    filter: ["==", ["get", "stopped"], true],
    layout: {
      visibility: showStoppedCounties ? "visible" : "none",
    },
    paint: {
      "line-color": COLORS.stopped.border,
      "line-width": 1,
    },
  });

  // State borders
  map.addLayer({
    id: "states-border",
    type: "line",
    source: "states",
    paint: {
      "line-color": COLORS.borders.state,
      "line-width": 1.5,
    },
  });

  // Hover highlight layer
  map.addLayer({
    id: "counties-hover",
    type: "fill",
    source: "counties",
    filter: ["==", ["get", "fips"], ""],
    paint: {
      "fill-color": COLORS.hover.fill,
      "fill-opacity": COLORS.hover.opacity,
    },
  });
}

/**
 * Update visibility of stopped counties layers
 */
export function updateStopLayerVisibility() {
  const map = CountyMapState.getMap();
  const showStoppedCounties = CountyMapState.getShowStoppedCounties();

  if (!map) {
    return;
  }

  const visibility = showStoppedCounties ? "visible" : "none";
  ["counties-stopped-fill", "counties-stopped-border"].forEach((layerId) => {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, "visibility", visibility);
    }
  });
}

/**
 * Set the hover highlight filter for a county
 * @param {string} fips - County FIPS code (empty string to clear)
 */
export function setHoverHighlight(fips) {
  const map = CountyMapState.getMap();
  if (map) {
    map.setFilter("counties-hover", ["==", ["get", "fips"], fips]);
  }
}

/**
 * Get appropriate map style based on theme
 * @returns {string} Mapbox style URL
 */
export function getMapStyle() {
  const { styleUrl } = resolveMapStyle({ theme: getCurrentTheme() });
  return styleUrl;
}
