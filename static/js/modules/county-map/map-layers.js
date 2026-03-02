/**
 * County Map Layers Module
 * Handles map layer creation and management
 */

import { getCurrentTheme, resolveMapStyle } from "../core/map-style-resolver.js";
import { COLORS } from "./constants.js";
import * as CountyMapState from "./state.js";

const COUNTIES_SOURCE_ID = "counties";
const STATES_SOURCE_ID = "states";
const CITIES_SOURCE_ID = "cities";

const COUNTIES_FILL_LAYER_ID = "counties-fill";
const COUNTIES_BORDER_LAYER_ID = "counties-border";
const COUNTIES_HOVER_LAYER_ID = "counties-hover";

const STATES_FILL_LAYER_ID = "states-fill";
const STATES_BORDER_LAYER_ID = "states-border";
const STATES_HOVER_LAYER_ID = "states-hover";

const CITIES_FILL_LAYER_ID = "cities-fill";
const CITIES_BORDER_LAYER_ID = "cities-border";
const CITIES_HOVER_LAYER_ID = "cities-hover";

const REMOVABLE_LAYERS = [
  COUNTIES_HOVER_LAYER_ID,
  COUNTIES_BORDER_LAYER_ID,
  COUNTIES_FILL_LAYER_ID,
  STATES_HOVER_LAYER_ID,
  STATES_BORDER_LAYER_ID,
  STATES_FILL_LAYER_ID,
  CITIES_HOVER_LAYER_ID,
  CITIES_BORDER_LAYER_ID,
  CITIES_FILL_LAYER_ID,
];

const REMOVABLE_SOURCES = [COUNTIES_SOURCE_ID, STATES_SOURCE_ID, CITIES_SOURCE_ID];

function scheduleFrame(callback) {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(callback);
    return;
  }
  callback();
}

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

function buildStateFillColorExpression() {
  return [
    "interpolate",
    ["linear"],
    ["coalesce", ["feature-state", "percent"], 0],
    0,
    COLORS.levels.state.low,
    40,
    COLORS.levels.state.medium,
    100,
    COLORS.levels.state.high,
  ];
}

function buildCityFillColorExpression() {
  return [
    "case",
    ["boolean", ["feature-state", "visited"], false],
    COLORS.levels.city.visited,
    COLORS.levels.city.unvisited,
  ];
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

function addCountyLayers({ map, countyData, statesData, showStoppedCounties }) {
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
    id: STATES_BORDER_LAYER_ID,
    type: "line",
    source: STATES_SOURCE_ID,
    paint: {
      "line-color": COLORS.borders.state,
      "line-width": 1.5,
    },
  });

  map.addLayer({
    id: COUNTIES_HOVER_LAYER_ID,
    type: "fill",
    source: COUNTIES_SOURCE_ID,
    filter: ["==", ["get", "fips"], ""],
    paint: {
      "fill-color": COLORS.hover.fill,
      "fill-opacity": COLORS.hover.opacity,
    },
  });
}

function addStateLayers({ map, stateFeatureCollection }) {
  map.addSource(STATES_SOURCE_ID, {
    type: "geojson",
    data: stateFeatureCollection,
    promoteId: "stateFips",
  });

  map.addLayer({
    id: STATES_FILL_LAYER_ID,
    type: "fill",
    source: STATES_SOURCE_ID,
    paint: {
      "fill-color": buildStateFillColorExpression(),
      "fill-opacity": [
        "case",
        ["boolean", ["feature-state", "visited"], false],
        0.85,
        0.35,
      ],
    },
  });

  map.addLayer({
    id: STATES_BORDER_LAYER_ID,
    type: "line",
    source: STATES_SOURCE_ID,
    paint: {
      "line-color": COLORS.borders.state,
      "line-width": 1.5,
    },
  });

  map.addLayer({
    id: STATES_HOVER_LAYER_ID,
    type: "fill",
    source: STATES_SOURCE_ID,
    filter: ["==", ["get", "stateFips"], ""],
    paint: {
      "fill-color": COLORS.hover.fill,
      "fill-opacity": COLORS.hover.opacity,
    },
  });
}

function addCityLayers({ map, cityFeatureCollection }) {
  map.addSource(CITIES_SOURCE_ID, {
    type: "geojson",
    data: cityFeatureCollection,
    promoteId: "cityId",
  });

  map.addLayer({
    id: CITIES_FILL_LAYER_ID,
    type: "fill",
    source: CITIES_SOURCE_ID,
    paint: {
      "fill-color": buildCityFillColorExpression(),
      "fill-opacity": [
        "case",
        ["boolean", ["feature-state", "visited"], false],
        0.8,
        0.35,
      ],
    },
  });

  map.addLayer({
    id: CITIES_BORDER_LAYER_ID,
    type: "line",
    source: CITIES_SOURCE_ID,
    paint: {
      "line-color": COLORS.borders.city,
      "line-width": 0.8,
    },
  });

  map.addLayer({
    id: CITIES_HOVER_LAYER_ID,
    type: "fill",
    source: CITIES_SOURCE_ID,
    filter: ["==", ["get", "cityId"], ""],
    paint: {
      "fill-color": COLORS.hover.fill,
      "fill-opacity": COLORS.hover.opacity,
    },
  });
}

export function clearCoverageLayers(map = CountyMapState.getMap()) {
  if (!map) {
    return;
  }

  REMOVABLE_LAYERS.forEach((layerId) => {
    if (map.getLayer(layerId)) {
      try {
        map.removeLayer(layerId);
      } catch {
        // Ignore map remove races during transitions.
      }
    }
  });

  REMOVABLE_SOURCES.forEach((sourceId) => {
    if (map.getSource(sourceId)) {
      try {
        map.removeSource(sourceId);
      } catch {
        // Ignore map remove races during transitions.
      }
    }
  });
}

/**
 * Add all map layers for counties and states.
 */
export function addMapLayers() {
  const map = CountyMapState.getMap();
  const countyData = CountyMapState.getCountyData();
  const statesData = CountyMapState.getStatesData();
  const showStoppedCounties = CountyMapState.getShowStoppedCounties();

  if (!map || !countyData || !statesData) {
    return;
  }

  clearCoverageLayers(map);
  addCountyLayers({ map, countyData, statesData, showStoppedCounties });

  // Release duplicated JS-side geometry after Mapbox has taken ownership.
  CountyMapState.clearGeometryData();
}

/**
 * Render map layers for the active level.
 * @param {'county'|'state'|'city'} level
 * @param {{countyData?: Object, statesData?: Object, stateFeatureCollection?: Object, cityFeatureCollection?: Object, showStoppedCounties?: boolean}} options
 */
export function renderLevelLayers(level, options = {}) {
  const map = CountyMapState.getMap();
  if (!map) {
    return;
  }

  clearCoverageLayers(map);

  if (level === "county") {
    const countyData = options.countyData || CountyMapState.getCountyData();
    const statesData = options.statesData || CountyMapState.getStatesData();
    if (!countyData || !statesData) {
      return;
    }
    addCountyLayers({
      map,
      countyData,
      statesData,
      showStoppedCounties:
        options.showStoppedCounties ?? CountyMapState.getShowStoppedCounties(),
    });
    return;
  }

  if (level === "state") {
    const stateFeatureCollection =
      options.stateFeatureCollection || CountyMapState.getStateFeatureCollection();
    if (!stateFeatureCollection) {
      return;
    }
    addStateLayers({ map, stateFeatureCollection });
    return;
  }

  if (level === "city") {
    const cityFeatureCollection = options.cityFeatureCollection;
    if (!cityFeatureCollection) {
      return;
    }
    addCityLayers({ map, cityFeatureCollection });
  }
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

  scheduleFrame(() => {
    mergedStateByFips.forEach((featureState, fips) => {
      map.setFeatureState({ source: COUNTIES_SOURCE_ID, id: fips }, featureState);
    });
  });
}

/**
 * Apply state-level completion feature state.
 * @param {mapboxgl.Map} map
 * @param {Array<Object>} states
 */
export function applyStateVisitFeatureState(map, states = []) {
  if (!map || !map.getSource(STATES_SOURCE_ID)) {
    return;
  }

  if (typeof map.removeFeatureState === "function") {
    map.removeFeatureState({ source: STATES_SOURCE_ID });
  }

  scheduleFrame(() => {
    states.forEach((entry) => {
      const stateFips = entry?.stateFips;
      if (!stateFips) {
        return;
      }
      const countyStats = entry?.county || {};
      const visited = Number(countyStats.visited || 0) > 0;
      const percent = Number(countyStats.percent || 0);
      map.setFeatureState(
        { source: STATES_SOURCE_ID, id: stateFips },
        {
          visited,
          percent: Number.isFinite(percent) ? percent : 0,
        }
      );
    });
  });
}

/**
 * Apply city-level visited feature state.
 * @param {mapboxgl.Map} map
 * @param {Object.<string, any>} cityVisits
 */
export function applyCityVisitFeatureState(map, cityVisits = {}) {
  if (!map || !map.getSource(CITIES_SOURCE_ID)) {
    return;
  }

  if (typeof map.removeFeatureState === "function") {
    map.removeFeatureState({ source: CITIES_SOURCE_ID });
  }

  scheduleFrame(() => {
    Object.keys(cityVisits || {}).forEach((cityId) => {
      map.setFeatureState({ source: CITIES_SOURCE_ID, id: cityId }, { visited: true });
    });
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
 * Set the hover highlight filter for the currently active layer.
 * @param {string} value
 */
export function setHoverHighlight(value) {
  const map = CountyMapState.getMap();
  if (!map) {
    return;
  }

  if (map.getLayer(COUNTIES_HOVER_LAYER_ID)) {
    map.setFilter(COUNTIES_HOVER_LAYER_ID, ["==", ["get", "fips"], value]);
    return;
  }

  if (map.getLayer(STATES_HOVER_LAYER_ID)) {
    map.setFilter(STATES_HOVER_LAYER_ID, ["==", ["get", "stateFips"], value]);
    return;
  }

  if (map.getLayer(CITIES_HOVER_LAYER_ID)) {
    map.setFilter(CITIES_HOVER_LAYER_ID, ["==", ["get", "cityId"], value]);
  }
}

export function getInteractiveLayerId(level = CountyMapState.getActiveLevel()) {
  if (level === "state") {
    return STATES_FILL_LAYER_ID;
  }
  if (level === "city") {
    return CITIES_FILL_LAYER_ID;
  }
  return COUNTIES_FILL_LAYER_ID;
}

/**
 * Get appropriate map style based on theme
 * @returns {string} Mapbox style URL
 */
export function getMapStyle() {
  const { styleUrl } = resolveMapStyle({ theme: getCurrentTheme() });
  return styleUrl;
}
