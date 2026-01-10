/**
 * Turn-by-Turn Geo Utilities
 * Pure geo/math utility functions (stateless)
 */

import {
  INSTRUCTION_LABELS,
  TURN_ANGLE_THRESHOLDS,
  TURN_ROTATIONS,
} from "./turn-by-turn-config.js";

/**
 * Convert degrees to radians
 * @param {number} deg
 * @returns {number}
 */
export function toRad(deg) {
  return deg * (Math.PI / 180);
}

/**
 * Convert radians to degrees
 * @param {number} rad
 * @returns {number}
 */
export function toDeg(rad) {
  return rad * (180 / Math.PI);
}

/**
 * Earth radius in meters
 */
const EARTH_RADIUS = 6371000;

/**
 * Calculate distance between two points using Haversine formula
 * @param {[number, number]} a - [lon, lat]
 * @param {[number, number]} b - [lon, lat]
 * @returns {number} Distance in meters
 */
export function distanceMeters(a, b) {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Calculate bearing from point a to point b
 * @param {[number, number]} a - [lon, lat]
 * @param {[number, number]} b - [lon, lat]
 * @returns {number} Bearing in degrees (0-360)
 */
export function bearing(a, b) {
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLon = toRad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Convert a coordinate to XY (Cartesian) for local calculations
 * @param {[number, number]} coord - [lon, lat]
 * @param {number} refLat - Reference latitude for projection
 * @returns {{x: number, y: number}}
 */
export function toXY(coord, refLat) {
  const lat = toRad(coord[1]);
  const lon = toRad(coord[0]);
  const x = lon * Math.cos(toRad(refLat)) * EARTH_RADIUS;
  const y = lat * EARTH_RADIUS;
  return { x, y };
}

/**
 * Project a point onto a line segment
 * @param {[number, number]} point - [lon, lat]
 * @param {[number, number]} a - Segment start [lon, lat]
 * @param {[number, number]} b - Segment end [lon, lat]
 * @returns {{distance: number, t: number, point: [number, number]}}
 */
export function projectToSegment(point, a, b) {
  const refLat = (a[1] + b[1]) / 2;
  const p = toXY(point, refLat);
  const p1 = toXY(a, refLat);
  const p2 = toXY(b, refLat);
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) {
    t = ((p.x - p1.x) * dx + (p.y - p1.y) * dy) / lenSq;
    t = Math.min(1, Math.max(0, t));
  }
  const projX = p1.x + t * dx;
  const projY = p1.y + t * dy;
  const distance = Math.hypot(p.x - projX, p.y - projY);
  const projLng = a[0] + t * (b[0] - a[0]);
  const projLat = a[1] + t * (b[1] - a[1]);
  return { distance, t, point: [projLng, projLat] };
}

/**
 * Calculate minimum distance from a point to a LineString
 * @param {[number, number]} point - [lon, lat]
 * @param {Array<[number, number]>} lineCoords - Array of [lon, lat] coordinates
 * @returns {number} Minimum distance in meters
 */
export function distanceToLineString(point, lineCoords) {
  let minDistance = Infinity;

  for (let i = 0; i < lineCoords.length - 1; i++) {
    const proj = projectToSegment(point, lineCoords[i], lineCoords[i + 1]);
    if (proj.distance < minDistance) {
      minDistance = proj.distance;
    }
  }

  return minDistance;
}

/**
 * Calculate angle delta between two bearings
 * @param {number} from - Source bearing
 * @param {number} to - Target bearing
 * @returns {number} Delta in degrees (-180 to 180)
 */
export function angleDelta(from, to) {
  return ((to - from + 540) % 360) - 180;
}

/**
 * Classify turn type from angle delta
 * @param {number} delta - Angle delta
 * @returns {string} Turn type
 */
export function classifyTurn(delta) {
  const { uturn, sharp, turn, slight } = TURN_ANGLE_THRESHOLDS;
  const abs = Math.abs(delta);
  let classification = "straight";
  if (abs > uturn) classification = "uturn";
  else if (abs > sharp) classification = delta > 0 ? "sharp-right" : "sharp-left";
  else if (abs > turn) classification = delta > 0 ? "right" : "left";
  else if (abs > slight) classification = delta > 0 ? "slight-right" : "slight-left";
  return classification;
}

/**
 * Get human-readable instruction text for a turn type
 * @param {string} type - Turn type
 * @returns {string} Instruction text
 */
export function getInstructionText(type) {
  return INSTRUCTION_LABELS[type] || "Continue";
}

/**
 * Get turn icon rotation for a turn type
 * @param {string} type - Turn type
 * @returns {number} Rotation in degrees
 */
export function getTurnRotation(type) {
  return TURN_ROTATIONS[type] ?? 0;
}

/**
 * Format distance in meters to human-readable string
 * @param {number} meters - Distance in meters
 * @returns {string} Formatted distance (feet or miles)
 */
export function formatDistance(meters) {
  if (!Number.isFinite(meters)) return "--";
  if (meters < 160) {
    return `${Math.round(meters * 3.28084)} ft`;
  }
  const miles = meters / 1609.344;
  return `${miles < 10 ? miles.toFixed(1) : miles.toFixed(0)} mi`;
}
