/**
 * County Map State Stats Module
 * Handles state-level statistics display and zoom functionality
 */

import * as CountyMapState from "./state.js";
import { formatDate } from "./ui.js";

function parseVisitDate(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Calculate state-level statistics
 * @returns {Array} Array of state statistics objects
 */
export function calculateStateStats() {
  const countyToState = CountyMapState.getCountyToState();
  const stateTotals = CountyMapState.getStateTotals();
  const countyVisits = CountyMapState.getCountyVisits();

  const stateStats = {};

  Object.entries(stateTotals).forEach(([stateFips, totals]) => {
    stateStats[stateFips] = {
      name: totals?.name || "Unknown",
      fips: stateFips,
      total: Number.isFinite(totals?.total) ? totals.total : 0,
      visited: 0,
      firstVisit: null,
      lastVisit: null,
    };
  });

  Object.entries(countyVisits).forEach(([fips, visits]) => {
    const countyMeta = countyToState[fips];
    const stateFips = countyMeta?.stateFips;
    if (!stateFips || !stateStats[stateFips]) {
      return;
    }

    const stats = stateStats[stateFips];
    stats.visited += 1;

    const firstVisit = parseVisitDate(visits?.firstVisit);
    const lastVisit = parseVisitDate(visits?.lastVisit);

    if (firstVisit && (!stats.firstVisit || firstVisit < stats.firstVisit)) {
      stats.firstVisit = firstVisit;
    }
    if (lastVisit && (!stats.lastVisit || lastVisit > stats.lastVisit)) {
      stats.lastVisit = lastVisit;
    }
  });

  return Object.values(stateStats).map((state) => ({
    ...state,
    percentage: state.total > 0 ? (state.visited / state.total) * 100 : 0,
  }));
}

/**
 * Render state stats list
 * @param {string} [sortBy="name"] - Sort method (name, coverage-desc, coverage-asc, visited-desc)
 */
export function renderStateStatsList(sortBy = "name") {
  const stateList = calculateStateStats();

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
        const lastDate = formatDate(state.lastVisit?.toISOString());
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
  const stateBounds = CountyMapState.getStateBounds();
  const bounds = stateBounds[stateFips];

  if (!map || !Array.isArray(bounds) || bounds.length !== 2) {
    return;
  }

  map.fitBounds(bounds, { padding: 50, maxZoom: 8 });
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

      const stateList = content.querySelector("#state-list");
      if ((!isExpanded && content.innerHTML.trim() === "") || !stateList?.innerHTML.trim()) {
        renderStateStatsList();
      }
    });
  }

  const sortSelect = document.getElementById("state-sort");
  if (sortSelect) {
    sortSelect.addEventListener("change", () => {
      renderStateStatsList(sortSelect.value);
    });
  }
}
