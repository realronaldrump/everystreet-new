/**
 * County Map State Module
 * Centralized state management for the county map
 */

/** @type {mapboxgl.Map|null} */
let map = null;

/** @type {Object.<string, {firstVisit: string, lastVisit: string}>} */
let countyVisits = {};

/** @type {Object.<string, {firstStop: string, lastStop: string}>} */
let countyStops = {};

/** @type {Object|null} GeoJSON county data */
let countyData = null;

/** @type {Object|null} GeoJSON states data */
let statesData = null;

/** @type {boolean} Whether recalculation is in progress */
let isRecalculating = false;

/** @type {boolean} Whether to show stopped counties layer */
let showStoppedCounties = false;

/** @type {boolean} Whether recalc polling is active */
let recalcPollerActive = false;

// Map getters and setters
export function getMap() {
  return map;
}

export function setMap(mapInstance) {
  map = mapInstance;
}

// County visits getters and setters
export function getCountyVisits() {
  return countyVisits;
}

export function setCountyVisits(visits) {
  countyVisits = visits;
}

// County stops getters and setters
export function getCountyStops() {
  return countyStops;
}

export function setCountyStops(stops) {
  countyStops = stops;
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

// Recalculating state
export function getIsRecalculating() {
  return isRecalculating;
}

export function setIsRecalculating(value) {
  isRecalculating = value;
}

// Show stopped counties state
export function getShowStoppedCounties() {
  return showStoppedCounties;
}

export function setShowStoppedCounties(value) {
  showStoppedCounties = value;
}

// Recalc poller state
export function getRecalcPollerActive() {
  return recalcPollerActive;
}

export function setRecalcPollerActive(value) {
  recalcPollerActive = value;
}

/**
 * Reset all state to initial values
 */
export function resetState() {
  map = null;
  countyVisits = {};
  countyStops = {};
  countyData = null;
  statesData = null;
  isRecalculating = false;
  showStoppedCounties = false;
  recalcPollerActive = false;
}

// Default export for backward compatibility
const CountyMapState = {
  getMap,
  setMap,
  getCountyVisits,
  setCountyVisits,
  getCountyStops,
  setCountyStops,
  getCountyData,
  setCountyData,
  getStatesData,
  setStatesData,
  getIsRecalculating,
  setIsRecalculating,
  getShowStoppedCounties,
  setShowStoppedCounties,
  getRecalcPollerActive,
  setRecalcPollerActive,
  resetState,
};

export default CountyMapState;
