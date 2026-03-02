/**
 * County Map UI Module
 * Handles UI updates, loading states, level-specific renderers, and recalculation prompts.
 */

import * as CountyMapState from "./state.js";

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = text;
  }
}

export function getRecalculateButtons() {
  return ["recalculate-btn", "trigger-recalculate"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);
}

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

    document
      .getElementById("trigger-recalculate")
      ?.addEventListener("click", onRecalculate);
  }
}

export function updateLoadingText(text) {
  const textEl = document.querySelector(".loading-text");
  if (textEl) {
    textEl.textContent = text;
  }
}

export function hideLoading() {
  const loadingEl = document.getElementById("map-loading");
  if (loadingEl) {
    loadingEl.classList.add("hidden");
    setTimeout(() => {
      loadingEl.style.display = "none";
    }, 500);
  }
}

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

// =============================================================================
// Summary bar
// =============================================================================

export function updateSummaryBar() {
  const summary = CountyMapState.getSummary();
  if (!summary?.levels) {
    return;
  }

  const county = summary.levels.county || {};
  const state = summary.levels.state || {};
  const city = summary.levels.city || {};

  setText(
    "summary-county-count",
    `${Number(county.visited || 0).toLocaleString()}/${Number(county.total || 0).toLocaleString()}`
  );
  setText(
    "summary-state-count",
    `${Number(state.visited || 0).toLocaleString()}/${Number(state.total || 0).toLocaleString()}`
  );
  setText(
    "summary-city-count",
    `${Number(city.visited || 0).toLocaleString()}/${Number(city.total || 0).toLocaleString()}`
  );
}

// =============================================================================
// Hero ring helper
// =============================================================================

const HERO_R = 32;
const HERO_CIRCUMFERENCE = 2 * Math.PI * HERO_R;

function renderHeroRing(percent, visited, total, levelLabel, ringModifier = "") {
  const offset = HERO_CIRCUMFERENCE - (percent / 100) * HERO_CIRCUMFERENCE;

  return `
    <div class="level-hero">
      <div class="hero-ring">
        <svg viewBox="0 0 76 76">
          <circle class="hero-ring-bg" cx="38" cy="38" r="${HERO_R}" />
          <circle class="hero-ring-fill${ringModifier}" cx="38" cy="38" r="${HERO_R}"
                  stroke-dasharray="${HERO_CIRCUMFERENCE.toFixed(2)}"
                  stroke-dashoffset="${offset.toFixed(2)}" />
        </svg>
        <span class="hero-ring-value">${percent.toFixed(1)}%</span>
      </div>
      <div class="hero-detail">
        <div class="hero-count">
          ${visited.toLocaleString()} <span class="hero-count-total">/ ${total.toLocaleString()}</span>
        </div>
        <div class="hero-label">${levelLabel}</div>
      </div>
    </div>`;
}

// =============================================================================
// State list section helper (shared by county and state views)
// =============================================================================

function renderStateListSection() {
  return `
    <div class="level-list-section">
      <div class="level-list-header">
        <span class="level-list-title">By State</span>
        <select class="form-select form-select-sm level-sort-select" id="state-sort">
          <option value="name">Name A\u2192Z</option>
          <option value="coverage-desc">Coverage \u2193</option>
          <option value="coverage-asc">Coverage \u2191</option>
          <option value="visited-desc">Visited \u2193</option>
        </select>
      </div>
      <div class="state-stats-list" id="state-list"></div>
    </div>`;
}

// =============================================================================
// Level-specific renderers
// =============================================================================

export function renderCountyLevelView(container) {
  const summary = CountyMapState.getSummary();
  const county = summary?.levels?.county || {};
  const percent = Number(county.percent || 0);
  const visited = Number(county.visited || 0);
  const total = Number(county.total || 0);
  const stoppedCount = Object.keys(CountyMapState.getCountyStops()).length;
  const showStopped = CountyMapState.getShowStoppedCounties();

  let html = renderHeroRing(percent, visited, total, "Counties Visited");

  if (stoppedCount > 0) {
    html += `<div class="level-stat-badge">
      <i class="fas fa-map-pin me-1" aria-hidden="true"></i>${stoppedCount} Stopped In
    </div>`;
  }

  html += `
    <div class="level-legend">
      <div class="legend-row">
        <span class="legend-swatch legend-swatch--visited"></span>
        <span>Driven Through</span>
      </div>
      <div class="legend-row legend-row--toggle">
        <span class="legend-swatch legend-swatch--stopped"></span>
        <span>Stopped In</span>
        <div class="form-check form-switch">
          <input class="form-check-input" type="checkbox" id="toggle-stops"${showStopped ? " checked" : ""}>
        </div>
      </div>
      <div class="legend-row">
        <span class="legend-swatch legend-swatch--unvisited"></span>
        <span>Not Yet Visited</span>
      </div>
    </div>`;

  html += renderStateListSection();
  container.innerHTML = html;
}

export function renderStateLevelView(container) {
  const summary = CountyMapState.getSummary();
  const state = summary?.levels?.state || {};
  const percent = Number(state.percent || 0);
  const visited = Number(state.visited || 0);
  const total = Number(state.total || 0);

  let html = renderHeroRing(
    percent,
    visited,
    total,
    "States Visited",
    " hero-ring-fill--state"
  );

  html += `
    <div class="level-legend">
      <div class="legend-row">
        <span class="legend-swatch legend-swatch--state-low"></span>
        <span>Low Coverage</span>
      </div>
      <div class="legend-row">
        <span class="legend-swatch legend-swatch--state-mid"></span>
        <span>Mid Coverage</span>
      </div>
      <div class="legend-row">
        <span class="legend-swatch legend-swatch--state-high"></span>
        <span>High Coverage</span>
      </div>
    </div>`;

  html += renderStateListSection();
  container.innerHTML = html;
}

export function renderCityLevelView(container) {
  const summary = CountyMapState.getSummary();
  const city = summary?.levels?.city || {};
  const percent = Number(city.percent || 0);
  const visited = Number(city.visited || 0);
  const total = Number(city.total || 0);

  let html = renderHeroRing(
    percent,
    visited,
    total,
    "Cities Visited",
    " hero-ring-fill--city"
  );

  html += `
    <div class="level-legend">
      <div class="legend-row">
        <span class="legend-swatch legend-swatch--visited"></span>
        <span>Visited City</span>
      </div>
      <div class="legend-row">
        <span class="legend-swatch legend-swatch--unvisited"></span>
        <span>Unvisited City</span>
      </div>
    </div>`;

  html += `
    <div class="level-list-section">
      <div class="level-list-header">
        <span class="level-list-title">City Explorer</span>
        <select class="form-select form-select-sm level-sort-select" id="city-state-select"></select>
      </div>
      <div class="city-filters">
        <select class="form-select form-select-sm" id="city-status">
          <option value="all">All</option>
          <option value="visited">Visited</option>
          <option value="unvisited">Unvisited</option>
        </select>
        <select class="form-select form-select-sm" id="city-sort">
          <option value="name">Name A\u2192Z</option>
          <option value="visited_first">Visited First</option>
          <option value="unvisited_first">Unvisited First</option>
        </select>
        <input type="text" class="form-control form-control-sm" id="city-search"
               placeholder="Search cities\u2026">
      </div>
      <div class="city-stats-list" id="city-list"></div>
      <div class="city-pagination" id="city-pagination"></div>
    </div>`;

  container.innerHTML = html;
}

// =============================================================================
// Level UI orchestration
// =============================================================================

export function updateLevelUi(level) {
  // Update tab buttons
  document.querySelectorAll(".coverage-level-btn[data-level]").forEach((btn) => {
    const active = btn.dataset.level === level;
    btn.classList.toggle("coverage-level-btn--active", active);
    btn.setAttribute("aria-selected", String(active));
  });

  // Update summary pills
  document.querySelectorAll(".summary-pill[data-level]").forEach((pill) => {
    pill.classList.toggle("summary-pill--active", pill.dataset.level === level);
  });

  // Render level-specific view into dynamic container
  const container = document.getElementById("level-content");
  if (!container) {
    return;
  }

  // Retrigger fade-in animation
  container.style.animation = "none";
  void container.offsetHeight;
  container.style.animation = "";

  switch (level) {
    case "county":
      renderCountyLevelView(container);
      break;
    case "state":
      renderStateLevelView(container);
      break;
    case "city":
      renderCityLevelView(container);
      break;
  }
}

// =============================================================================
// State stats list
// =============================================================================

export function renderStateStatsList(options = {}) {
  const { sortBy = "name", onSelectState } = options;
  const stateList = [...CountyMapState.getStateRollups()];

  switch (sortBy) {
    case "coverage-desc":
      stateList.sort(
        (a, b) => (b?.county?.percent || 0) - (a?.county?.percent || 0)
      );
      break;
    case "coverage-asc":
      stateList.sort(
        (a, b) => (a?.county?.percent || 0) - (b?.county?.percent || 0)
      );
      break;
    case "visited-desc":
      stateList.sort(
        (a, b) => (b?.county?.visited || 0) - (a?.county?.visited || 0)
      );
      break;
    default:
      stateList.sort((a, b) =>
        (a.stateName || "").localeCompare(b.stateName || "")
      );
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

// =============================================================================
// City rows
// =============================================================================

export function renderCityRows(payload) {
  const listEl = document.getElementById("city-list");
  const paginationEl = document.getElementById("city-pagination");
  if (!listEl || !paginationEl) {
    return;
  }

  const cities = payload?.cities || [];
  const pagination = payload?.pagination || {};

  if (!cities.length) {
    listEl.innerHTML =
      '<div class="empty-list">No cities match this filter.</div>';
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
