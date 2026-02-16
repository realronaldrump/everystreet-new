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

function formatDateTime(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatLocation(location) {
  if (!location) {
    return "Unknown";
  }
  if (typeof location === "string") {
    return location;
  }
  if (typeof location === "object") {
    return location.formatted_address || location.name || location.address || "Unknown";
  }
  return String(location);
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
 * @param {string} [opts.insightKind] - Kind used to populate the insight badge
 */
export function displayTripsInModal(trips, opts = {}) {
  const { title, insightKind } = opts;
  const sortedTrips = sortTripsByKind(trips, insightKind || "trips");

  // Update modal title.
  const modalTitle = document.getElementById("tripDetailsModalLabel");
  if (modalTitle) {
    modalTitle.textContent = title || `Trips (${sortedTrips?.length || 0})`;
  }

  const countEl = document.getElementById("tripDetailsModalCount");
  if (countEl) {
    countEl.textContent = `${sortedTrips?.length || 0} trips`;
  }

  const grid = document.getElementById("modal-trips-grid");
  if (!grid) {
    return;
  }

  if (!sortedTrips || sortedTrips.length === 0) {
    grid.innerHTML = '<div class="modal-trip-empty"><i class="fas fa-route" style="font-size:1.5rem;margin-bottom:0.5rem;opacity:0.4"></i><span>No trips found</span></div>';
  } else {
    // Compute max value for the bar chart fill
    const maxVal = sortedTrips.reduce(
      (mx, t) => Math.max(mx, Math.abs(getTripSortValue(insightKind || "trips", t))),
      0,
    );

    grid.innerHTML = sortedTrips
      .map((trip, idx) => {
        const startTime = formatDateTime(trip.startTime);
        const duration = formatDuration(Number(trip.duration) || 0);
        const distanceVal = Number(trip.distance);
        const distance =
          Number.isFinite(distanceVal) && distanceVal > 0
            ? `${distanceVal.toFixed(1)} mi`
            : "-";
        const startLoc = formatLocation(trip.startLocation);
        const destLoc = formatLocation(trip.destination);
        const maxSpeedVal = Number(trip.maxSpeed);
        const maxSpeed =
          Number.isFinite(maxSpeedVal) && maxSpeedVal > 0
            ? `${maxSpeedVal.toFixed(0)} mph`
            : "-";
        const insightValue = formatInsightValue(insightKind, trip);
        const insight = escapeHtml(insightValue === "-" ? distance : insightValue);
        const tripId = trip.transactionId || trip._id?.$oid || trip._id || "-";
        const tripUrl = `/trips?highlight=${encodeURIComponent(tripId)}`;

        // Bar fill percentage based on the metric
        const sortVal = Math.abs(getTripSortValue(insightKind || "trips", trip));
        const fillPct = maxVal > 0 ? Math.round((sortVal / maxVal) * 100) : 0;

        // Rank badge for top 3
        const rank = idx + 1;
        const rankBadge =
          rank <= 3
            ? `<span class="modal-trip-rank rank-${rank}">${rank}</span>`
            : `<span class="modal-trip-rank">${rank}</span>`;

        return `
          <a href="${tripUrl}" class="modal-trip-card" target="_blank" rel="noopener noreferrer">
            <div class="modal-trip-bar" style="--fill:${fillPct}%"></div>
            <div class="modal-trip-content">
              <div class="modal-trip-head">
                ${rankBadge}
                <span class="modal-trip-hero">${insight}</span>
                <span class="modal-trip-date">${escapeHtml(startTime)}</span>
              </div>
              <div class="modal-trip-route">
                <span class="modal-trip-loc">${escapeHtml(startLoc)}</span>
                <i class="fas fa-long-arrow-alt-right"></i>
                <span class="modal-trip-loc">${escapeHtml(destLoc)}</span>
              </div>
              <div class="modal-trip-meta">
                <span><i class="fas fa-road"></i>${distance}</span>
                <span><i class="fas fa-clock"></i>${duration}</span>
                <span><i class="fas fa-tachometer-alt"></i>${maxSpeed}</span>
              </div>
            </div>
            <i class="fas fa-chevron-right modal-trip-arrow"></i>
          </a>
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
