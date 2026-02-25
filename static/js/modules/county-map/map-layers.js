/**
 * County Map Layers Module
 * Handles map layer creation and management
 */

import { getCurrentTheme, resolveMapStyle } from "../core/map-style-resolver.js";
import { COLORS } from "./constants.js";
import * as CountyMapState from "./state.js";

const COUNTIES_SOURCE_ID = "counties";
const STATES_SOURCE_ID = "states";
const COUNTIES_FILL_LAYER_ID = "counties-fill";
const COUNTIES_BORDER_LAYER_ID = "counties-border";

export function buildCountyFillColorExpression(showStoppedCounties) {
  if (showStoppedCounties) {
    return [
      "case",
      ["boolean", ["feature-state", "stopped"], false],
      COLORS.stopped.fill,
      ["boolean", ["feature-state", "visited"], false],
      COLORS.visited.fill,
      COLORS.unvisited.fill,
    ];
  }

  return [
    "case",
    ["boolean", ["feature-state", "visited"], false],
    COLORS.visited.fill,
    COLORS.unvisited.fill,
  ];
}

export function buildCountyFillOpacityExpression(showStoppedCounties) {
  if (showStoppedCounties) {
    return [
      "case",
      ["boolean", ["feature-state", "stopped"], false],
      COLORS.stopped.opacity,
      ["boolean", ["feature-state", "visited"], false],
      COLORS.visited.opacity,
      1,
    ];
  }

  return [
    "case",
    ["boolean", ["feature-state", "visited"], false],
    COLORS.visited.opacity,
    1,
  ];
}

export function buildCountyBorderColorExpression(showStoppedCounties) {
  if (showStoppedCounties) {
    return [
      "case",
      ["boolean", ["feature-state", "stopped"], false],
      COLORS.stopped.border,
      ["boolean", ["feature-state", "visited"], false],
      COLORS.visited.border,
      COLORS.borders.county,
    ];
  }

  return [
    "case",
    ["boolean", ["feature-state", "visited"], false],
    COLORS.visited.border,
    COLORS.borders.county,
  ];
}

export function buildCountyBorderWidthExpression(showStoppedCounties) {
  if (showStoppedCounties) {
    return [
      "case",
      ["boolean", ["feature-state", "stopped"], false],
      1,
      ["boolean", ["feature-state", "visited"], false],
      1,
      0.5,
    ];
  }

  return ["case", ["boolean", ["feature-state", "visited"], false], 1, 0.5];
}

function applyCountyLayerPaint(map, showStoppedCounties) {
  if (map.getLayer(COUNTIES_FILL_LAYER_ID)) {
    map.setPaintProperty(
      COUNTIES_FILL_LAYER_ID,
      "fill-color",
      buildCountyFillColorExpression(showStoppedCounties)
    );
    map.setPaintProperty(
      COUNTIES_FILL_LAYER_ID,
      "fill-opacity",
      buildCountyFillOpacityExpression(showStoppedCounties)
    );
  }

  if (map.getLayer(COUNTIES_BORDER_LAYER_ID)) {
    map.setPaintProperty(
      COUNTIES_BORDER_LAYER_ID,
      "line-color",
      buildCountyBorderColorExpression(showStoppedCounties)
    );
    map.setPaintProperty(
      COUNTIES_BORDER_LAYER_ID,
      "line-width",
      buildCountyBorderWidthExpression(showStoppedCounties)
    );
  }
}

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

  map.addSource(COUNTIES_SOURCE_ID, {
    type: "geojson",
    data: countyData,
    promoteId: "fips",
  });

  map.addSource(STATES_SOURCE_ID, {
    type: "geojson",
    data: statesData,
  });

  map.addLayer({
    id: COUNTIES_FILL_LAYER_ID,
    type: "fill",
    source: COUNTIES_SOURCE_ID,
    paint: {
      "fill-color": buildCountyFillColorExpression(showStoppedCounties),
      "fill-opacity": buildCountyFillOpacityExpression(showStoppedCounties),
    },
  });

  map.addLayer({
    id: COUNTIES_BORDER_LAYER_ID,
    type: "line",
    source: COUNTIES_SOURCE_ID,
    paint: {
      "line-color": buildCountyBorderColorExpression(showStoppedCounties),
      "line-width": buildCountyBorderWidthExpression(showStoppedCounties),
    },
  });

  map.addLayer({
    id: "states-border",
    type: "line",
    source: STATES_SOURCE_ID,
    paint: {
      "line-color": COLORS.borders.state,
      "line-width": 1.5,
    },
  });

  map.addLayer({
    id: "counties-hover",
    type: "fill",
    source: COUNTIES_SOURCE_ID,
    filter: ["==", ["get", "fips"], ""],
    paint: {
      "fill-color": COLORS.hover.fill,
      "fill-opacity": COLORS.hover.opacity,
    },
  });

  // Release duplicated JS-side geometry after Mapbox has taken ownership.
  CountyMapState.clearGeometryData();
}

/**
 * Apply visited/stopped county state via Mapbox feature-state.
 * @param {mapboxgl.Map} map
 * @param {Object.<string, any>} countyVisits
 * @param {Object.<string, any>} countyStops
 */
export function applyCountyVisitFeatureState(map, countyVisits = {}, countyStops = {}) {
  if (!map || !map.getSource(COUNTIES_SOURCE_ID)) {
    return;
  }

  if (typeof map.removeFeatureState === "function") {
    map.removeFeatureState({ source: COUNTIES_SOURCE_ID });
  }

  const mergedStateByFips = new Map();
  Object.keys(countyVisits || {}).forEach((fips) => {
    mergedStateByFips.set(fips, { visited: true });
  });
  Object.keys(countyStops || {}).forEach((fips) => {
    const existing = mergedStateByFips.get(fips) || {};
    mergedStateByFips.set(fips, { ...existing, stopped: true });
  });

  mergedStateByFips.forEach((featureState, fips) => {
    map.setFeatureState({ source: COUNTIES_SOURCE_ID, id: fips }, featureState);
  });
}

/**
 * Update stopped county styling based on toggle state.
 */
export function updateStopLayerVisibility() {
  const map = CountyMapState.getMap();
  const showStoppedCounties = CountyMapState.getShowStoppedCounties();
  if (!map) {
    return;
  }

  applyCountyLayerPaint(map, showStoppedCounties);
}

/**
 * Set the hover highlight filter for a county
 * @param {string} fips - County FIPS code (empty string to clear)
 */
export function setHoverHighlight(fips) {
  const map = CountyMapState.getMap();
  if (map?.getLayer("counties-hover")) {
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
