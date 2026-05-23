/**
 * County Map State Module
 * Centralized state for unified county/state/city coverage explorer
 */

/** @type {mapboxgl.Map|null} */
let map = null;

/** @type {'county' | 'state' | 'city'} */
let activeLevel = "county";

/** @type {Object|null} */
let summary = null;

/** @type {Array<Object>} */
let stateRollups = [];

/** @type {string|null} */
let selectedStateFips = null;

/** @type {string|null} */
let selectedCountyFips = null;

/** @type {string|null} */
let selectedCityId = null;

/** @type {Object.<string, {firstVisit: string, lastVisit: string}>} */
let countyVisits = {};

/** @type {Object.<string, {firstStop: string, lastStop: string}>} */
let countyStops = {};

/** @type {Object.<string, Object.<string, {firstVisit: string, lastVisit: string}>>} */
let cityVisitsByState = {};

/** @type {Object.<string, Object.<string, {firstStop: string, lastStop: string}>>} */
let cityStopsByState = {};

/** @type {Object|null} GeoJSON county data */
let countyData = null;

/** @type {Object|null} GeoJSON states data from county topology */
let statesData = null;

/** @type {Object|null} State boundary feature collection for state mode */
let stateFeatureCollection = null;

/** @type {Object.<string, Object>} Cached city feature collections keyed by state FIPS */
let cityFeatureCollections = {};

/** @type {Object.<string, [[number, number], [number, number]]>} */
let stateBounds = {};

/** @type {boolean} Whether recalculation is in progress */
let isRecalculating = false;

/** @type {boolean} Whether to show stopped counties layer */
let showStoppedCounties = true;

/** @type {boolean} Whether to show stopped cities layer */
let showStoppedCities = true;

/** @type {boolean} Whether recalc polling is active */
let recalcPollerActive = false;

function normalizeCountyFipsKey(value) {
  const raw = String(value ?? "").trim();
  if (/^\d+$/.test(raw) && raw.length <= 5) {
    return raw.padStart(5, "0");
  }
  return raw;
}

function normalizeCountyRecordMap(records) {
  const normalized = {};
  Object.entries(records || {}).forEach(([rawKey, payload]) => {
    const key = normalizeCountyFipsKey(rawKey);
    if (!key) {
      return;
    }
    normalized[key] = payload;
  });
  return normalized;
}

// Map getters and setters
export function getMap() {
  return map;
}

export function setMap(mapInstance) {
  map = mapInstance;
}

export function getActiveLevel() {
  return activeLevel;
}

export function setActiveLevel(level) {
  if (level === "county" || level === "state" || level === "city") {
    activeLevel = level;
  }
}

export function getSummary() {
  return summary;
}

export function setSummary(value) {
  summary = value;
}

export function getStateRollups() {
  return stateRollups;
}

export function setStateRollups(value) {
  stateRollups = Array.isArray(value) ? value : [];
}

export function getSelectedStateFips() {
  return selectedStateFips;
}

export function setSelectedStateFips(value) {
  selectedStateFips = value || null;
}

export function getSelectedCountyFips() {
  return selectedCountyFips;
}

export function setSelectedCountyFips(value) {
  selectedCountyFips = value ? normalizeCountyFipsKey(value) : null;
}

export function getSelectedCityId() {
  return selectedCityId;
}

export function setSelectedCityId(value) {
  selectedCityId = value || null;
}

// County visits getters and setters
export function getCountyVisits() {
  return countyVisits;
}

export function setCountyVisits(visits) {
  countyVisits = normalizeCountyRecordMap(visits);
}

// County stops getters and setters
export function getCountyStops() {
  return countyStops;
}

export function setCountyStops(stops) {
  countyStops = normalizeCountyRecordMap(stops);
}

export function getCityVisitsForState(stateFips) {
  return cityVisitsByState[stateFips] || {};
}

export function setCityVisitsForState(stateFips, visits) {
  if (!stateFips) {
    return;
  }
  cityVisitsByState[stateFips] = visits || {};
}

export function getCityStopsForState(stateFips) {
  return cityStopsByState[stateFips] || {};
}

export function setCityStopsForState(stateFips, stops) {
  if (!stateFips) {
    return;
  }
  cityStopsByState[stateFips] = stops || {};
}

// County data getters and setters
export function getCountyData() {
  return countyData;
}

export function setCountyData(data) {
  countyData = data;
}

// States data getters and setters
export function getStatesData() {
  return statesData;
}

export function setStatesData(data) {
  statesData = data;
}

export function getStateFeatureCollection() {
  return stateFeatureCollection;
}

export function setStateFeatureCollection(collection) {
  stateFeatureCollection = collection;
}

export function getCityFeatureCollection(stateFips) {
  return cityFeatureCollections[stateFips] || null;
}

export function setCityFeatureCollection(stateFips, collection) {
  if (!stateFips || !collection) {
    return;
  }
  cityFeatureCollections[stateFips] = collection;
}

export function getStateBounds() {
  return stateBounds;
}

export function setStateBounds(bounds) {
  stateBounds = bounds || {};
}

// Recalculating state
export function getIsRecalculating() {
  return isRecalculating;
}

export function setIsRecalculating(value) {
  isRecalculating = Boolean(value);
}

// Show stopped counties state
export function getShowStoppedCounties() {
  return showStoppedCounties;
}

export function setShowStoppedCounties(value) {
  showStoppedCounties = Boolean(value);
}

export function getShowStoppedCities() {
  return showStoppedCities;
}

export function setShowStoppedCities(value) {
  showStoppedCities = Boolean(value);
}

// Recalc poller state
export function getRecalcPollerActive() {
  return recalcPollerActive;
}

export function setRecalcPollerActive(value) {
  recalcPollerActive = Boolean(value);
}

/**
 * Reset all state to initial values
 */
export function resetState() {
  map = null;
  activeLevel = "county";
  summary = null;
  stateRollups = [];
  selectedStateFips = null;
  selectedCountyFips = null;
  selectedCityId = null;
  countyVisits = {};
  countyStops = {};
  cityVisitsByState = {};
  cityStopsByState = {};
  countyData = null;
  statesData = null;
  stateFeatureCollection = null;
  cityFeatureCollections = {};
  stateBounds = {};
  isRecalculating = false;
  showStoppedCounties = true;
  showStoppedCities = true;
  recalcPollerActive = false;
}
