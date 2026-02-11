/* global bootstrap */
/**
 * Insights Modal Module (ES6)
 * Handles the trip details modal for the driving insights page
 */

import { escapeHtml } from "../utils.js";
import { fetchDrilldownTrips, fetchTimePeriodTrips } from "./api.js";
import { showNotification } from "./export.js";
import { formatDuration, formatHourLabel, getDateRange } from "./formatters.js";

function formatInsightValue(kind, trip) {
  if (!kind || !trip) {
    return "-";
  }
  switch (kind) {
    case "distance": {
      const v = Number(trip.distance);
      return Number.isFinite(v) && v > 0 ? `${v.toFixed(1)} mi` : "-";
    }
    case "duration":
      return formatDuration(Number(trip.duration) || 0);
    case "fuel": {
      const v = Number(trip.fuelConsumed);
      return Number.isFinite(v) && v > 0 ? `${v.toFixed(2)} gal` : "-";
    }
    case "top_speed": {
      const v = Number(trip.maxSpeed);
      return Number.isFinite(v) && v > 0 ? `${v.toFixed(1)} mph` : "-";
    }
    case "avg_speed": {
      const v = Number(trip.avgSpeed);
      return Number.isFinite(v) && v > 0 ? `${v.toFixed(1)} mph` : "-";
    }
    case "idle_time":
      return trip.totalIdleDuration
        ? formatDuration(Number(trip.totalIdleDuration) || 0)
        : "-";
    case "hard_braking":
      return trip.hardBrakingCounts !== undefined && trip.hardBrakingCounts !== null
        ? `${trip.hardBrakingCounts}`
        : "-";
    default:
      return "-";
  }
}

function titleForDrilldown(kind, dateRange) {
  const rangeText = dateRange ? `${dateRange.start} to ${dateRange.end}` : "";
  switch (kind) {
    case "distance":
      return `Top trips by distance (${rangeText})`;
    case "duration":
      return `Top trips by duration (${rangeText})`;
    case "fuel":
      return `Top trips by fuel used (${rangeText})`;
    case "top_speed":
      return `Top trips by top speed (${rangeText})`;
    case "avg_speed":
      return `Top trips by average speed (${rangeText})`;
    case "idle_time":
      return `Top trips by idle time (${rangeText})`;
    case "hard_braking":
      return `Top trips by hard braking (${rangeText})`;
    default:
      return `Trips (${rangeText})`;
  }
}

function parseDateMs(value) {
  if (!value) {
    return 0;
  }
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function getTripSortValue(kind, trip) {
  if (!trip) {
    return 0;
  }
  switch (kind) {
    case "distance":
      return Number(trip.distance) || 0;
    case "duration":
      return Number(trip.duration) || 0;
    case "fuel":
      return Number(trip.fuelConsumed) || 0;
    case "top_speed":
      return Number(trip.maxSpeed) || 0;
    case "avg_speed":
      return Number(trip.avgSpeed) || 0;
    case "idle_time":
      return Number(trip.totalIdleDuration) || 0;
    case "hard_braking":
      return Number(trip.hardBrakingCounts) || 0;
    default:
      return parseDateMs(trip.startTime);
  }
}

function sortTripsByKind(trips, kind) {
  if (!Array.isArray(trips) || trips.length < 2) {
    return trips;
  }
  const activeKind = kind || "trips";
  return [...trips].sort((a, b) => {
    const av = getTripSortValue(activeKind, a);
    const bv = getTripSortValue(activeKind, b);
    if (bv !== av) {
      return bv - av;
    }
    // Stable-ish tie-breaker: newest trip first.
    const at = parseDateMs(a?.startTime);
    const bt = parseDateMs(b?.startTime);
    return bt - at;
  });
}

/**
 * Load and display trips for a specific time period
 * @param {string} timeType - Type of time period ("hour" or "day")
 * @param {number} timeValue - Value for the time period
 */
export async function loadAndShowTripsForTimePeriod(timeType, timeValue) {
  try {
    const dateRange = getDateRange();
    const params = new URLSearchParams({
      start_date: dateRange.start,
      end_date: dateRange.end,
      time_type: timeType,
      time_value: timeValue.toString(),
    });

    const trips = await fetchTimePeriodTrips(params);
    let title = "Trips";
    if (timeType === "hour") {
      title = `Trips at ${formatHourLabel(timeValue)} (${trips.length} trips)`;
    } else {
      const days = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ];
      title = `Trips on ${days[timeValue]} (${trips.length} trips)`;
    }
    displayTripsInModal(trips, { title });
  } catch (error) {
    console.error("Error loading trips:", error);
    showNotification("Error loading trips. Please try again.", "error");
  }
}

/**
 * Load and display trips for a drill-down kind
 * @param {string} kind - drilldown kind (e.g. "top_speed", "distance")
 * @param {Object} [opts]
 * @param {string} [opts.start] - override start_date (YYYY-MM-DD)
 * @param {string} [opts.end] - override end_date (YYYY-MM-DD)
 * @param {string} [opts.title] - override modal title
 * @param {number} [opts.limit] - max trips to load
 */
export async function loadAndShowTripsForDrilldown(kind, opts = {}) {
  try {
    const fallback = getDateRange();
    const dateRange = {
      start: opts.start || fallback.start,
      end: opts.end || fallback.end,
    };

    const params = new URLSearchParams({
      start_date: dateRange.start,
      end_date: dateRange.end,
      kind: kind || "trips",
      limit: String(opts.limit || 100),
    });

    const trips = await fetchDrilldownTrips(params);
    const title = opts.title || titleForDrilldown(kind, dateRange);
    displayTripsInModal(trips, { title, insightKind: kind });
  } catch (error) {
    console.error("Error loading drilldown trips:", error);
    showNotification("Error loading trips. Please try again.", "error");
  }
}

/**
 * Display trips in the modal
 * @param {Array} trips - Trip data to display
 * @param {Object} opts
 * @param {string} [opts.title] - Modal title
 * @param {string} [opts.insightKind] - Kind used to populate the Insight column
 */
export function displayTripsInModal(trips, opts = {}) {
  const { title, insightKind } = opts;
  const sortedTrips = sortTripsByKind(trips, insightKind || "trips");

  // Update modal title.
  const modalTitle = document.getElementById("tripDetailsModalLabel");
  if (modalTitle) {
    modalTitle.textContent = title || `Trips (${sortedTrips?.length || 0})`;
  }

  // Build table rows
  const tbody = document.querySelector("#modal-trips-table tbody");
  if (!tbody) {
    return;
  }

  if (!sortedTrips || sortedTrips.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="9" class="text-center">No trips found.</td></tr>';
  } else {
    tbody.innerHTML = sortedTrips
      .map((trip) => {
        const startTime = trip.startTime
          ? new Date(trip.startTime).toLocaleString("en-US", { hour12: true })
          : "-";
        const endTime = trip.endTime
          ? new Date(trip.endTime).toLocaleString("en-US", { hour12: true })
          : "-";
        const duration = formatDuration(Number(trip.duration) || 0);
        const distanceVal = Number(trip.distance);
        const distance =
          Number.isFinite(distanceVal) && distanceVal > 0
            ? `${distanceVal.toFixed(1)} mi`
            : "-";
        const startLoc =
          trip.startLocation?.formatted_address ||
          trip.startLocation?.name ||
          "Unknown";
        const destLoc =
          trip.destination?.formatted_address || trip.destination?.name || "Unknown";
        const maxSpeedVal = Number(trip.maxSpeed);
        const maxSpeed =
          Number.isFinite(maxSpeedVal) && maxSpeedVal > 0
            ? `${maxSpeedVal.toFixed(1)} mph`
            : "-";
        const insight = escapeHtml(formatInsightValue(insightKind, trip));
        const tripId = trip.transactionId || trip._id?.$oid || trip._id || "-";

        return `
          <tr>
            <td>${startTime}</td>
            <td>${endTime}</td>
            <td>${duration}</td>
            <td>${distance}</td>
            <td>${escapeHtml(startLoc)}</td>
            <td>${escapeHtml(destLoc)}</td>
            <td>${maxSpeed}</td>
            <td>${insight}</td>
            <td>
              <a href="/trips?highlight=${encodeURIComponent(tripId)}" class="btn btn-sm btn-primary" target="_blank">
                <i class="fas fa-external-link-alt"></i>
              </a>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  // Show the modal
  const modalEl = document.getElementById("tripDetailsModal");
  if (modalEl) {
    const modal = new bootstrap.Modal(modalEl);
    modal.show();
  }
}
