/**
 * County Map UI Module
 * Handles UI updates, loading states, and recalculation prompts.
 */

import * as CountyMapState from "./state.js";

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = text;
  }
}

/**
 * Get all recalculate buttons
 * @returns {HTMLElement[]} Array of recalculate button elements
 */
export function getRecalculateButtons() {
  return ["recalculate-btn", "trigger-recalculate"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);
}

/**
 * Update the recalculate UI state (buttons, status message)
 * @param {boolean} isActive - Whether recalculation is active
 * @param {string} [message] - Optional status message
 */
export function updateRecalculateUi(isActive, message) {
  const status = document.getElementById("recalculate-status");
  if (status) {
    if (isActive) {
      status.classList.add("recalculate-status--active");
      status.innerHTML = `<i class="fas fa-spinner fa-spin"></i><span>${message}</span>`;
    } else {
      status.classList.remove("recalculate-status--active");
      status.textContent = "";
    }
  }

  const buttons = getRecalculateButtons();
  buttons.forEach((btn) => {
    if (!btn.dataset.defaultLabel) {
      btn.dataset.defaultLabel = btn.innerHTML;
    }
    btn.disabled = isActive;
    btn.innerHTML = isActive
      ? '<i class="fas fa-spinner fa-spin me-2"></i>Calculating...'
      : btn.dataset.defaultLabel;
  });
}

/**
 * Show prompt to recalculate county data
 * @param {Function} onRecalculate - Callback when recalculate button is clicked
 */
export function showRecalculatePrompt(onRecalculate) {
  const statsContent = document.getElementById("stats-content");
  if (statsContent) {
    if (statsContent.querySelector(".recalculate-prompt")) {
      return;
    }
    const prompt = document.createElement("div");
    prompt.className = "recalculate-prompt";
    prompt.innerHTML = `
      <p>Coverage data needs to be calculated from your trips.</p>
      <button class="btn btn-primary btn-sm" id="trigger-recalculate">
        <i class="fas fa-calculator me-2"></i>Calculate Now
      </button>
    `;
    statsContent.insertBefore(prompt, statsContent.firstChild);

    document.getElementById("trigger-recalculate")?.addEventListener("click", onRecalculate);
  }
}

/**
 * Update loading text display
 * @param {string} text - Loading text to display
 */
export function updateLoadingText(text) {
  const textEl = document.querySelector(".loading-text");
  if (textEl) {
    textEl.textContent = text;
  }
}

/**
 * Hide the loading overlay
 */
export function hideLoading() {
  const loadingEl = document.getElementById("map-loading");
  if (loadingEl) {
    loadingEl.classList.add("hidden");
    setTimeout(() => {
      loadingEl.style.display = "none";
    }, 500);
  }
}

/**
 * Update the last updated timestamp display
 * @param {string} isoString - ISO date string
 */
export function updateLastUpdated(isoString) {
  const lastUpdated = isoString ? new Date(isoString) : null;
  const el = document.getElementById("last-updated");
  if (el) {
    if (!lastUpdated || Number.isNaN(lastUpdated.getTime())) {
      el.textContent = "";
      return;
    }
    el.textContent = `Last updated: ${lastUpdated.toLocaleDateString()} ${lastUpdated.toLocaleTimeString()}`;
  }
}

/**
 * Update statistics display
 */
export function updateStats() {
  const summary = CountyMapState.getSummary();
  if (!summary?.levels) {
    return;
  }

  const county = summary.levels.county || {};
  const state = summary.levels.state || {};
  const city = summary.levels.city || {};

  const countyVisited = Number(county.visited || 0);
  const countyTotal = Number(county.total || 0);
  const countyPercent = Number(county.percent || 0);

  const stateVisited = Number(state.visited || 0);
  const stateTotal = Number(state.total || 0);
  const statePercent = Number(state.percent || 0);

  const cityVisited = Number(city.visited || 0);
  const cityTotal = Number(city.total || 0);
  const cityPercent = Number(city.percent || 0);

  setText("counties-visited", countyVisited.toLocaleString());
  setText("counties-total", countyTotal.toLocaleString());
  setText("states-visited", stateVisited.toLocaleString());
  setText("states-total", stateTotal.toLocaleString());
  setText("cities-visited", cityVisited.toLocaleString());
  setText("cities-total", cityTotal.toLocaleString());

  setText("county-coverage", `${countyPercent.toFixed(1)}%`);
  setText("state-coverage", `${statePercent.toFixed(1)}%`);
  setText("city-coverage", `${cityPercent.toFixed(1)}%`);

}

/**
 * Update visible level-specific sections.
 * @param {'county'|'state'|'city'} level
 */
export function updateLevelUi(level) {
  const levelButtons = document.querySelectorAll("[data-level]");
  levelButtons.forEach((button) => {
    const active = button.dataset.level === level;
    button.classList.toggle("coverage-level-btn--active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });

  const countyLegend = document.getElementById("legend-county");
  const stateLegend = document.getElementById("legend-state");
  const cityLegend = document.getElementById("legend-city");

  if (countyLegend) {
    countyLegend.style.display = level === "county" ? "block" : "none";
  }
  if (stateLegend) {
    stateLegend.style.display = level === "state" ? "block" : "none";
  }
  if (cityLegend) {
    cityLegend.style.display = level === "city" ? "block" : "none";
  }

  const cityControls = document.getElementById("city-controls");
  if (cityControls) {
    cityControls.style.display = level === "city" ? "block" : "none";
  }
}

/**
 * Render state rollup list
 * @param {{sortBy?: string, onSelectState?: (stateFips: string) => void}} options
 */
export function renderStateStatsList(options = {}) {
  const { sortBy = "name", onSelectState } = options;
  const stateList = [...CountyMapState.getStateRollups()];

  switch (sortBy) {
    case "coverage-desc":
      stateList.sort((a, b) => (b?.county?.percent || 0) - (a?.county?.percent || 0));
      break;
    case "coverage-asc":
      stateList.sort((a, b) => (a?.county?.percent || 0) - (b?.county?.percent || 0));
      break;
    case "visited-desc":
      stateList.sort((a, b) => (b?.county?.visited || 0) - (a?.county?.visited || 0));
      break;
    default:
      stateList.sort((a, b) => (a.stateName || "").localeCompare(b.stateName || ""));
  }

  const container = document.getElementById("state-list");
  if (!container) {
    return;
  }

  container.innerHTML = stateList
    .filter((entry) => Number(entry?.county?.total || 0) > 0)
    .map((entry) => {
      const countyStats = entry.county || {};
      const cityStats = entry.city || {};
      const countyPct = Number(countyStats.percent || 0);
      const isComplete = countyPct >= 100;
      return `
        <div class="state-stat-item ${isComplete ? "state-stat-item--complete" : ""}" data-state-fips="${entry.stateFips}">
          <div class="state-stat-header">
            <span class="state-name">${entry.stateName}</span>
            <span class="state-coverage ${countyStats.visited ? "state-coverage--visited" : ""}">${countyPct.toFixed(1)}%</span>
          </div>
          <div class="state-stat-details">
            <span class="state-counties">${countyStats.visited || 0} / ${countyStats.total || 0} counties</span>
          </div>
          <div class="state-stat-details">
            <span class="state-counties">${cityStats.visited || 0} / ${cityStats.total || 0} cities</span>
          </div>
          <div class="state-progress-bar">
            <div class="state-progress-fill" style="width: ${countyPct.toFixed(1)}%"></div>
          </div>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll(".state-stat-item").forEach((item) => {
    item.addEventListener("click", () => {
      const { stateFips } = item.dataset;
      if (typeof onSelectState === "function" && stateFips) {
        onSelectState(stateFips);
      }
    });
  });
}

/**
 * Render city rows
 * @param {Object} payload
 */
export function renderCityRows(payload) {
  const listEl = document.getElementById("city-list");
  const paginationEl = document.getElementById("city-pagination");
  if (!listEl || !paginationEl) {
    return;
  }

  const cities = payload?.cities || [];
  const pagination = payload?.pagination || {};

  if (!cities.length) {
    listEl.innerHTML = '<div class="empty-list">No cities match this filter.</div>';
  } else {
    listEl.innerHTML = cities
      .map((city) => {
        const statusClass = city.visited
          ? "tooltip-status tooltip-status--visited"
          : "tooltip-status tooltip-status--unvisited";
        return `
          <div class="city-stat-item" data-city-id="${city.cityId}">
            <div class="city-stat-header">
              <span class="state-name">${city.name}</span>
              <span class="${statusClass}">${city.visited ? "Visited" : "Unvisited"}</span>
            </div>
            <div class="state-date">${city.visited ? `First: ${formatDate(city.firstVisit)} - Last: ${formatDate(city.lastVisit)}` : "No visits yet"}</div>
          </div>
        `;
      })
      .join("");
  }

  const currentPage = Number(pagination.page || 1);
  const totalPages = Number(pagination.totalPages || 1);

  paginationEl.innerHTML = `
    <button class="btn btn-sm btn-outline-secondary" id="city-page-prev" ${currentPage <= 1 ? "disabled" : ""}>Prev</button>
    <span class="city-pagination-label">Page ${currentPage} of ${Math.max(totalPages, 1)}</span>
    <button class="btn btn-sm btn-outline-secondary" id="city-page-next" ${currentPage >= totalPages ? "disabled" : ""}>Next</button>
  `;
}

/**
 * Format date for display
 * @param {string} isoString - ISO date string
 * @returns {string} Formatted date string
 */
export function formatDate(isoString) {
  if (!isoString) {
    return "Unknown";
  }
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
      return "Unknown";
    }
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "Unknown";
  }
}

/**
 * Setup panel toggle functionality
 */
export function setupPanelToggle() {
  const panel = document.getElementById("stats-panel");
  const toggleBtn = document.getElementById("stats-toggle");

  if (toggleBtn && panel) {
    toggleBtn.addEventListener("click", () => {
      panel.classList.toggle("stats-panel--collapsed");
      const isCollapsed = panel.classList.contains("stats-panel--collapsed");
      toggleBtn.setAttribute("aria-expanded", String(!isCollapsed));
    });
  }
}
