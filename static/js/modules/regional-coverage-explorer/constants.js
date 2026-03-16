/**
 * County Map Constants Module
 * Contains FIPS code mappings and configuration values
 */

import { COVERAGE_BBOX_LINE_COLOR } from "../core/coverage-bounds.js";
import MapStyles from "../map-styles.js";

const COUNTY_COLORS = MapStyles.MAP_LAYER_COLORS?.county || {};

const colorOr = (value, fallback) => {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return fallback;
};

/** LocalStorage key for recalculation state */
export const RECALC_STORAGE_KEY = "countyRecalcStatus";

/** Map configuration */
export const MAP_CONFIG = {
  center: [-98.5795, 39.8283], // Center of US
  zoom: 4,
  minZoom: 2,
  maxZoom: 12,
};

/** Map layer colors */
export const COLORS = {
  visited: {
    fill: colorOr(COUNTY_COLORS.visitedFill, "#4d9a6a"),
    border: colorOr(COUNTY_COLORS.visitedBorder, "#3b7a53"),
    opacity: 0.6,
  },
  stopped: {
    fill: colorOr(COUNTY_COLORS.stoppedFill, "#5b9bd5"),
    border: colorOr(COUNTY_COLORS.stoppedBorder, "#4a80b4"),
    opacity: 0.55,
  },
  unvisited: {
    fill: "rgba(245, 242, 236, 0.02)",
  },
  hover: {
    fill: colorOr(COUNTY_COLORS.hoverFill, "#faf9f7"),
    opacity: 0.2,
  },
  borders: {
    county: colorOr(COUNTY_COLORS.borderCounty, "rgba(245, 242, 236, 0.15)"),
    state: COVERAGE_BBOX_LINE_COLOR,
    city: colorOr(COUNTY_COLORS.borderCity, "rgba(245, 242, 236, 0.25)"),
  },
  levels: {
    state: {
      low: colorOr(COUNTY_COLORS.stateLow, "rgba(245, 242, 236, 0.08)"),
      medium: colorOr(COUNTY_COLORS.stateMedium, "rgba(111, 179, 136, 0.45)"),
      high: colorOr(COUNTY_COLORS.stateHigh, "rgba(62, 132, 91, 0.75)"),
    },
    city: {
      visited: colorOr(COUNTY_COLORS.visitedFill, "#4d9a6a"),
      stopped: colorOr(COUNTY_COLORS.stoppedFill, "#5b9bd5"),
      unvisited: colorOr(COUNTY_COLORS.cityUnvisited, "rgba(245, 242, 236, 0.08)"),
      visitedBorder: colorOr(COUNTY_COLORS.visitedBorder, "#3b7a53"),
      stoppedBorder: colorOr(COUNTY_COLORS.stoppedBorder, "#4a80b4"),
    },
  },
};

/** FIPS code to state name mapping */
export const STATE_FIPS_TO_NAME = {
  "01": "Alabama",
  "02": "Alaska",
  "04": "Arizona",
  "05": "Arkansas",
  "06": "California",
  "08": "Colorado",
  "09": "Connecticut",
  10: "Delaware",
  11: "District of Columbia",
  12: "Florida",
  13: "Georgia",
  15: "Hawaii",
  16: "Idaho",
  17: "Illinois",
  18: "Indiana",
  19: "Iowa",
  20: "Kansas",
  21: "Kentucky",
  22: "Louisiana",
  23: "Maine",
  24: "Maryland",
  25: "Massachusetts",
  26: "Michigan",
  27: "Minnesota",
  28: "Mississippi",
  29: "Missouri",
  30: "Montana",
  31: "Nebraska",
  32: "Nevada",
  33: "New Hampshire",
  34: "New Jersey",
  35: "New Mexico",
  36: "New York",
  37: "North Carolina",
  38: "North Dakota",
  39: "Ohio",
  40: "Oklahoma",
  41: "Oregon",
  42: "Pennsylvania",
  44: "Rhode Island",
  45: "South Carolina",
  46: "South Dakota",
  47: "Tennessee",
  48: "Texas",
  49: "Utah",
  50: "Vermont",
  51: "Virginia",
  53: "Washington",
  54: "West Virginia",
  55: "Wisconsin",
  56: "Wyoming",
  60: "American Samoa",
  66: "Guam",
  69: "Northern Mariana Islands",
  72: "Puerto Rico",
  78: "Virgin Islands",
};

/**
 * Get state name from FIPS code
 * @param {string} fips - State FIPS code
 * @returns {string} State name or "Unknown"
 */
export function getStateName(fips) {
  return STATE_FIPS_TO_NAME[fips] || "Unknown";
}
