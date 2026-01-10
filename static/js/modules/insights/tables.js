/* global $ */
/**
 * Insights Tables Module (ES6)
 * Handles table rendering and DataTables initialization for the driving insights page
 */

import { formatDuration, formatMonth, formatWeekRange } from "./formatters.js";
import { getState } from "./state.js";

/**
 * Update all tables with current data
 */
export function updateTables() {
  updateDestinationsTable();
  updateAnalyticsTable();
}

/**
 * Update the destinations table with top destinations data
 */
export function updateDestinationsTable() {
  const state = getState();
  const { insights } = state.data;

  const destinations = insights.top_destinations || [];

  const tbody = document.querySelector("#destinations-table tbody");
  if (!tbody) return;

  if (!destinations.length) {
    tbody.innerHTML =
      '<tr><td colspan="5" class="text-center">No destination data in the selected date range.</td></tr>';
    return;
  }

  tbody.innerHTML = destinations
    .map((dest) => {
      const duration = formatDuration(dest.duration_seconds || 0);
      const last = dest.lastVisit
        ? new Date(dest.lastVisit).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          })
        : "-";
      return `
      <tr>
        <td>${dest.location || "Unknown"}</td>
        <td>${dest.visits}</td>
        <td>${dest.distance.toFixed(1)} mi</td>
        <td>${duration}</td>
        <td>${last}</td>
      </tr>
    `;
    })
    .join("");

  // Initialize DataTable if not already
  if (!$.fn.DataTable.isDataTable("#destinations-table")) {
    $("#destinations-table").DataTable({
      order: [[1, "desc"]],
      pageLength: 5,
      lengthChange: false,
      searching: false,
      info: false,
    });
  }
}

/**
 * Update the analytics table with weekly/monthly data
 */
export function updateAnalyticsTable() {
  const tableEl = document.getElementById("analytics-table");
  if (!tableEl) return;

  const state = getState();
  const { behavior } = state.data;

  const tableData =
    state.currentView === "weekly"
      ? behavior.weekly || []
      : behavior.monthly || [];

  const tbody = tableEl.querySelector("tbody");
  if (!tbody) return;

  tbody.innerHTML = tableData
    .map((row) => {
      const period =
        state.currentView === "weekly"
          ? formatWeekRange(row.week)
          : formatMonth(row.month);

      const efficiency =
        row.distance > 0 && row.fuelConsumed > 0
          ? (row.distance / row.fuelConsumed).toFixed(1)
          : "N/A";

      return `
        <tr>
          <td>${period}</td>
          <td>${row.trips}</td>
          <td>${row.distance.toFixed(1)} mi</td>
          <td>${formatDuration(row.duration || 0)}</td>
          <td>${(row.fuelConsumed || 0).toFixed(2)} gal</td>
          <td>${row.hardBraking + row.hardAccel}</td>
          <td>${efficiency} MPG</td>
        </tr>
      `;
    })
    .join("");

  // Initialize or refresh DataTable
  if ($.fn.DataTable.isDataTable("#analytics-table")) {
    $("#analytics-table").DataTable().clear().destroy(true);
  }

  $("#analytics-table").DataTable({
    order: [[0, "desc"]],
    pageLength: 10,
    responsive: true,
  });
}

// Default export as object for backward compatibility
const InsightsTables = {
  updateTables,
  updateDestinationsTable,
  updateAnalyticsTable,
};

// Keep window assignment for backward compatibility during transition
if (typeof window !== "undefined") {
  window.InsightsTables = InsightsTables;
}

export default InsightsTables;
