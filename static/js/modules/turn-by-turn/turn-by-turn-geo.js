/**
 * Turn-by-Turn Geo Utilities
 * Domain-specific geo helpers built on shared geo-math primitives.
 */

import { distanceInUserUnits } from "../utils.js";
import {
  angleDelta,
  bearing as _bearing,
  haversineDistance,
  projectToSegment,
  toXY,
} from "../utils/geo-math.js";
import {
  INSTRUCTION_LABELS,
  TURN_ANGLE_THRESHOLDS,
  TURN_ROTATIONS,
} from "./turn-by-turn-config.js";

export { angleDelta, projectToSegment, toXY };

/**
 * Haversine distance between two [lon, lat] coordinate pairs.
 * @param {[number, number]} a - [lon, lat]
 * @param {[number, number]} b - [lon, lat]
 * @returns {number} Distance in meters
 */
export function distanceMeters(a, b) {
  return haversineDistance(a[1], a[0], b[1], b[0]);
}

/**
 * Bearing from [lon, lat] a to [lon, lat] b.
 * @param {[number, number]} a - [lon, lat]
 * @param {[number, number]} b - [lon, lat]
 * @returns {number} Bearing in degrees (0-360)
 */
export function bearing(a, b) {
  return _bearing(a[1], a[0], b[1], b[0]);
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
 * Classify turn type from angle delta
 * @param {number} delta - Angle delta
 * @returns {string} Turn type
 */
export function classifyTurn(delta) {
  const { uturn, sharp, turn, slight } = TURN_ANGLE_THRESHOLDS;
  const abs = Math.abs(delta);
  let classification = "straight";
  if (abs > uturn) {
    classification = "uturn";
  } else if (abs > sharp) {
    classification = delta > 0 ? "sharp-right" : "sharp-left";
  } else if (abs > turn) {
    classification = delta > 0 ? "right" : "left";
  } else if (abs > slight) {
    classification = delta > 0 ? "slight-right" : "slight-left";
  }
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
 * Delegates to central formatter
 * @param {number} meters - Distance in meters
 * @returns {string} Formatted distance (feet or miles)
 */
export function formatDistance(meters) {
  return distanceInUserUnits(meters, 1);
}
