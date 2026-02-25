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

/** @type {Object.<string, {stateFips: string, stateName: string}>} */
let countyToState = {};

/** @type {Object.<string, {name: string, total: number}>} */
let stateTotals = {};

/** @type {Object.<string, [[number, number], [number, number]]>} */
let stateBounds = {};

/** @type {number} */
let totalCounties = 0;

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

export function clearGeometryData() {
  countyData = null;
  statesData = null;
}

export function getCountyToState() {
  return countyToState;
}

export function setCountyToState(index) {
  countyToState = index || {};
}

export function getStateTotals() {
  return stateTotals;
}

export function setStateTotals(totals) {
  stateTotals = totals || {};
}

export function getStateBounds() {
  return stateBounds;
}

export function setStateBounds(bounds) {
  stateBounds = bounds || {};
}

export function getTotalCounties() {
  return totalCounties;
}

export function setTotalCounties(value) {
  totalCounties = Number.isFinite(value) ? value : 0;
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
  countyToState = {};
  stateTotals = {};
  stateBounds = {};
  totalCounties = 0;
  isRecalculating = false;
  showStoppedCounties = false;
  recalcPollerActive = false;
}
