/**
 * County Map Interactions Module
 * Handles tooltip and hover interactions for the county map
 */

import { setHoverHighlight } from "./map-layers.js";
import CountyMapState from "./state.js";
import { formatDate } from "./ui.js";

/**
 * Format a date range for display in tooltip
 * @param {string} label - Label for the date range
 * @param {string} firstIso - ISO string of first date
 * @param {string} lastIso - ISO string of last date
 * @returns {string} HTML string for date range
 */
function formatDateRange(label, firstIso, lastIso) {
  const firstDate = formatDate(firstIso);
  const lastDate = formatDate(lastIso);

  if (firstDate === "Unknown" && lastDate === "Unknown") {
    return "";
  }

  if (firstDate === lastDate || lastDate === "Unknown") {
    return `<div class="tooltip-date"><span class="date-label">${label}:</span> ${firstDate}</div>`;
  }

  if (firstDate === "Unknown") {
    return `<div class="tooltip-date"><span class="date-label">${label}:</span> ${lastDate}</div>`;
  }

  return `<div class="tooltip-date"><span class="date-label">${label}:</span> ${firstDate} to ${lastDate}</div>`;
}

/**
 * Setup hover and click interactions for the map
 */
export function setupInteractions() {
  const map = CountyMapState.getMap();
  if (!map) {
    return;
  }

  const tooltip = document.getElementById("county-tooltip");
  if (!tooltip) {
    return;
  }

  const tooltipCounty = tooltip.querySelector(".tooltip-county-name");
  const tooltipState = tooltip.querySelector(".tooltip-state-name");
  const tooltipStatus = tooltip.querySelector(".tooltip-status");
  const tooltipDates = tooltip.querySelector(".tooltip-dates");

  /**
   * Show tooltip for a county
   * @param {Object} e - Mapbox event
   */
  function showTooltip(e) {
    if (e.features.length === 0) {
      return;
    }

    const countyVisits = CountyMapState.getCountyVisits();
    const countyStops = CountyMapState.getCountyStops();

    const feature = e.features[0];
    const { fips } = feature.properties;
    const countyName = feature.properties.name || "Unknown County";
    const stateName = feature.properties.stateName || "Unknown State";
    const isVisited = Boolean(countyVisits[fips]);
    const isStopped = Boolean(countyStops[fips]);

    // Update highlight
    setHoverHighlight(fips);

    // Update tooltip content
    tooltipCounty.textContent = countyName;
    tooltipState.textContent = stateName;

    if (isStopped) {
      tooltipStatus.textContent = isVisited
        ? "Stopped In + Driven Through"
        : "Stopped In";
      tooltipStatus.className = "tooltip-status tooltip-status--stopped";
    } else if (isVisited) {
      tooltipStatus.textContent = "Driven Through";
      tooltipStatus.className = "tooltip-status tooltip-status--visited";
    } else {
      tooltipStatus.textContent = "Not yet visited";
      tooltipStatus.className = "tooltip-status tooltip-status--unvisited";
    }

    const dateLines = [];
    if (isVisited && countyVisits[fips]) {
      dateLines.push(
        formatDateRange(
          "Driven",
          countyVisits[fips].firstVisit,
          countyVisits[fips].lastVisit,
        ),
      );
    }
    if (isStopped && countyStops[fips]) {
      dateLines.push(
        formatDateRange(
          "Stopped",
          countyStops[fips].firstStop,
          countyStops[fips].lastStop,
        ),
      );
    }

    const filteredLines = dateLines.filter((line) => line !== "");
    if (filteredLines.length > 0) {
      tooltipDates.innerHTML = filteredLines.join("");
      tooltipDates.style.display = "block";
    } else {
      tooltipDates.style.display = "none";
    }

    // Position tooltip
    tooltip.style.display = "block";
    tooltip.style.left = `${e.point.x}px`;
    tooltip.style.top = `${e.point.y}px`;

    // Change cursor
    map.getCanvas().style.cursor = "pointer";
  }

  /**
   * Hide the tooltip
   */
  function hideTooltip() {
    tooltip.style.display = "none";
    setHoverHighlight("");
    map.getCanvas().style.cursor = "";
  }

  // Mouse move - show tooltip
  map.on("mousemove", "counties-unvisited-fill", showTooltip);
  map.on("mousemove", "counties-visited-fill", showTooltip);
  map.on("mousemove", "counties-stopped-fill", showTooltip);

  // Mouse leave - hide tooltip
  map.on("mouseleave", "counties-unvisited-fill", hideTooltip);
  map.on("mouseleave", "counties-visited-fill", hideTooltip);
  map.on("mouseleave", "counties-stopped-fill", hideTooltip);
}

// Default export for backward compatibility
const CountyMapInteractions = {
  setupInteractions,
};

export default CountyMapInteractions;
