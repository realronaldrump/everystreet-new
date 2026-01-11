/**
 * County Map State Stats Module
 * Handles state-level statistics display and zoom functionality
 */

import CountyMapState from "./state.js";
import { formatDate } from "./ui.js";

/**
 * Flatten nested coordinate arrays
 * @param {Array} coords - Nested coordinate array
 * @returns {Array} Flattened array of [lng, lat] pairs
 */
function flattenCoordinates(coords) {
  const result = [];
  function flatten(arr) {
    if (typeof arr[0] === "number") {
      result.push(arr);
    } else {
      arr.forEach(flatten);
    }
  }
  flatten(coords);
  return result;
}

/**
 * Calculate state-level statistics
 * @returns {Array} Array of state statistics objects
 */
export function calculateStateStats() {
  const countyData = CountyMapState.getCountyData();
  const countyVisits = CountyMapState.getCountyVisits();

  if (!countyData) {
    return [];
  }

  // Group counties by state
  const stateStats = {};

  countyData.features.forEach((feature) => {
    const { stateFips, stateName } = feature.properties;

    if (!stateStats[stateFips]) {
      stateStats[stateFips] = {
        name: stateName,
        fips: stateFips,
        total: 0,
        visited: 0,
        firstVisit: null,
        lastVisit: null,
      };
    }

    stateStats[stateFips].total++;

    if (feature.properties.visited) {
      stateStats[stateFips].visited++;

      // Track earliest and latest visits for the state
      const countyFips = feature.properties.fips;
      const visits = countyVisits[countyFips];
      if (visits) {
        const firstVisit = visits.firstVisit ? new Date(visits.firstVisit) : null;
        const lastVisit = visits.lastVisit ? new Date(visits.lastVisit) : null;

        if (
          firstVisit &&
          (!stateStats[stateFips].firstVisit ||
            firstVisit < stateStats[stateFips].firstVisit)
        ) {
          stateStats[stateFips].firstVisit = firstVisit;
        }
        if (
          lastVisit &&
          (!stateStats[stateFips].lastVisit ||
            lastVisit > stateStats[stateFips].lastVisit)
        ) {
          stateStats[stateFips].lastVisit = lastVisit;
        }
      }
    }
  });

  // Convert to array and calculate percentages
  const stateList = Object.values(stateStats).map((state) => ({
    ...state,
    percentage: state.total > 0 ? (state.visited / state.total) * 100 : 0,
  }));

  return stateList;
}

/**
 * Render state stats list
 * @param {string} [sortBy="name"] - Sort method (name, coverage-desc, coverage-asc, visited-desc)
 */
export function renderStateStatsList(sortBy = "name") {
  const stateList = calculateStateStats();

  // Sort based on selected option
  switch (sortBy) {
    case "coverage-desc":
      stateList.sort((a, b) => b.percentage - a.percentage);
      break;
    case "coverage-asc":
      stateList.sort((a, b) => a.percentage - b.percentage);
      break;
    case "visited-desc":
      stateList.sort((a, b) => b.visited - a.visited);
      break;
    default:
      stateList.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Filter to only states with counties
  const filteredList = stateList.filter((s) => s.total > 0);

  const container = document.getElementById("state-list");
  if (!container) {
    return;
  }

  container.innerHTML = filteredList
    .map((state) => {
      const pct = state.percentage.toFixed(1);
      const isComplete = state.percentage >= 100;
      const hasVisits = state.visited > 0;

      let dateInfo = "";
      if (hasVisits && state.firstVisit) {
        const firstDate = formatDate(state.firstVisit.toISOString());
        const lastDate = formatDate(state.lastVisit.toISOString());
        if (firstDate === lastDate) {
          dateInfo = `<div class="state-date">Visited: ${firstDate}</div>`;
        } else {
          dateInfo = `<div class="state-date">First: ${firstDate} - Last: ${lastDate}</div>`;
        }
      }

      return `
        <div class="state-stat-item ${isComplete ? "state-stat-item--complete" : ""}" data-state-fips="${state.fips}">
          <div class="state-stat-header">
            <span class="state-name">${state.name}</span>
            <span class="state-coverage ${hasVisits ? "state-coverage--visited" : ""}">${pct}%</span>
          </div>
          <div class="state-stat-details">
            <span class="state-counties">${state.visited} / ${state.total} counties</span>
          </div>
          <div class="state-progress-bar">
            <div class="state-progress-fill" style="width: ${pct}%"></div>
          </div>
          ${dateInfo}
        </div>
      `;
    })
    .join("");

  // Add click handlers to zoom to state
  container.querySelectorAll(".state-stat-item").forEach((item) => {
    item.addEventListener("click", () => {
      const { stateFips } = item.dataset;
      zoomToState(stateFips);
    });
  });
}

/**
 * Zoom map to a specific state
 * @param {string} stateFips - State FIPS code
 */
export function zoomToState(stateFips) {
  const map = CountyMapState.getMap();
  const countyData = CountyMapState.getCountyData();

  if (!map || !countyData) {
    return;
  }

  // Get bounding box of all counties in this state
  const stateCounties = countyData.features.filter(
    (f) => f.properties.stateFips === stateFips
  );

  if (stateCounties.length === 0) {
    return;
  }

  // Calculate bounds
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  stateCounties.forEach((county) => {
    const coords = county.geometry.coordinates;
    const flatCoords = flattenCoordinates(coords);
    flatCoords.forEach(([lng, lat]) => {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    });
  });

  // Fit map to bounds
  map.fitBounds(
    [
      [minLng, minLat],
      [maxLng, maxLat],
    ],
    { padding: 50, maxZoom: 8 }
  );
}

/**
 * Setup state stats toggle and sort functionality
 */
export function setupStateStatsToggle() {
  const toggleBtn = document.getElementById("state-stats-toggle");
  const content = document.getElementById("state-stats-list");
  const chevron = toggleBtn ? toggleBtn.querySelector(".state-stats-chevron") : null;

  if (toggleBtn && content) {
    toggleBtn.addEventListener("click", () => {
      const isExpanded = content.style.display !== "none";
      content.style.display = isExpanded ? "none" : "block";
      toggleBtn.setAttribute("aria-expanded", !isExpanded);
      if (chevron) {
        chevron.style.transform = isExpanded ? "rotate(0deg)" : "rotate(180deg)";
      }

      // Render stats on first open
      if (
        (!isExpanded && content.innerHTML.trim() === "") ||
        content.querySelector("#state-list").innerHTML.trim() === ""
      ) {
        renderStateStatsList();
      }
    });
  }

  // Setup sort dropdown
  const sortSelect = document.getElementById("state-sort");
  if (sortSelect) {
    sortSelect.addEventListener("change", () => {
      renderStateStatsList(sortSelect.value);
    });
  }
}

// Default export for backward compatibility
const CountyMapStateStats = {
  calculateStateStats,
  renderStateStatsList,
  zoomToState,
  setupStateStatsToggle,
};

export default CountyMapStateStats;
