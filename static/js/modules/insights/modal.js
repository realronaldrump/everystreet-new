/* global bootstrap */
/**
 * Insights Modal Module (ES6)
 * Handles the trip details modal for the driving insights page
 */

import { escapeHtml } from "../formatters.js";
import { fetchTimePeriodTrips } from "./api.js";
import { showNotification } from "./export.js";
import { formatDuration, formatHourLabel, getDateRange } from "./formatters.js";

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
    displayTripsInModal(trips, timeType, timeValue);
  } catch (error) {
    console.error("Error loading trips:", error);
    showNotification("Error loading trips. Please try again.", "error");
  }
}

/**
 * Display trips in the modal
 * @param {Array} trips - Trip data to display
 * @param {string} timeType - Type of time period
 * @param {number} timeValue - Value for the time period
 */
export function displayTripsInModal(trips, timeType, timeValue) {
  // Update modal title
  const modalTitle = document.getElementById("tripDetailsModalLabel");
  if (modalTitle) {
    if (timeType === "hour") {
      modalTitle.textContent = `Trips at ${formatHourLabel(timeValue)} (${trips.length} trips)`;
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
      modalTitle.textContent = `Trips on ${days[timeValue]} (${trips.length} trips)`;
    }
  }

  // Build table rows
  const tbody = document.querySelector("#modal-trips-table tbody");
  if (!tbody) return;

  if (!trips || trips.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="8" class="text-center">No trips found for this time period.</td></tr>';
  } else {
    tbody.innerHTML = trips
      .map((trip) => {
        const startTime = trip.startTime
          ? new Date(trip.startTime).toLocaleString("en-US", { hour12: true })
          : "-";
        const endTime = trip.endTime
          ? new Date(trip.endTime).toLocaleString("en-US", { hour12: true })
          : "-";
        const duration = formatDuration(trip.duration || 0);
        const distance = trip.distance ? `${trip.distance.toFixed(1)} mi` : "-";
        const startLoc =
          trip.startLocation?.formatted_address ||
          trip.startLocation?.name ||
          "Unknown";
        const destLoc =
          trip.destination?.formatted_address || trip.destination?.name || "Unknown";
        const maxSpeed = trip.maxSpeed ? `${trip.maxSpeed.toFixed(1)} mph` : "-";
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

// Default export as object for backward compatibility
const InsightsModal = {
  loadAndShowTripsForTimePeriod,
  displayTripsInModal,
};

// Keep window assignment for backward compatibility during transition
if (typeof window !== "undefined") {
  window.InsightsModal = InsightsModal;
}

export default InsightsModal;
