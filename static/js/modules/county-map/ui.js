/**
 * County Map UI Module
 * Handles UI updates, loading states, and recalculation prompts
 */

import * as CountyMapState from "./state.js";

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
    const prompt = document.createElement("div");
    prompt.className = "recalculate-prompt";
    prompt.innerHTML = `
      <p>County data needs to be calculated from your trips.</p>
      <button class="btn btn-primary btn-sm" id="trigger-recalculate">
        <i class="fas fa-calculator me-2"></i>Calculate Now
      </button>
    `;
    statsContent.insertBefore(prompt, statsContent.firstChild);

    document
      .getElementById("trigger-recalculate")
      .addEventListener("click", onRecalculate);
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
  const lastUpdated = new Date(isoString);
  const el = document.getElementById("last-updated");
  if (el) {
    el.textContent = `Last updated: ${lastUpdated.toLocaleDateString()} ${lastUpdated.toLocaleTimeString()}`;
  }
}

/**
 * Update statistics display
 */
export function updateStats() {
  const countyData = CountyMapState.getCountyData();
  const countyVisits = CountyMapState.getCountyVisits();

  if (!countyData) {
    return;
  }

  const totalCounties = countyData.features.length;
  const visitedCount = Object.keys(countyVisits).length;
  const percentage =
    totalCounties > 0
      ? ((visitedCount / totalCounties) * 100).toFixed(1)
      : "0.0";

  // Count unique states
  const visitedStates = new Set();
  countyData.features.forEach((feature) => {
    if (feature.properties.visited) {
      visitedStates.add(feature.properties.stateFips);
    }
  });

  // Update DOM
  const countiesVisitedEl = document.getElementById("counties-visited");
  const countiesTotalEl = document.getElementById("counties-total");
  const coveragePercentEl = document.getElementById("coverage-percent");
  const statesVisitedEl = document.getElementById("states-visited");

  if (countiesVisitedEl) {
    countiesVisitedEl.textContent = visitedCount.toLocaleString();
  }
  if (countiesTotalEl) {
    countiesTotalEl.textContent = totalCounties.toLocaleString();
  }
  if (coveragePercentEl) {
    coveragePercentEl.textContent = `${percentage}%`;
  }
  if (statesVisitedEl) {
    statesVisitedEl.textContent = visitedStates.size;
  }
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

  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      panel.classList.toggle("stats-panel--collapsed");
      const isCollapsed = panel.classList.contains("stats-panel--collapsed");
      toggleBtn.setAttribute("aria-expanded", !isCollapsed);
    });
  }
}
