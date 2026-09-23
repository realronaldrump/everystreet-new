/**
 * The Trips table: sort definitions, column definitions, and the cell
 * renderers each column uses.
 */

import {
  escapeHtml,
  formatCurrency,
  formatDateOnly,
  formatGallons,
  formatInteger,
  formatMiles,
  formatOdometer,
  formatSpeed,
  formatTimeOnly,
  sanitizeLocation,
} from "../../utils.js";
import {
  formatRelativeTime,
  formatRouteSummary,
  formatTripDuration,
  generateSmartTitle,
  isInactiveTrip,
  shortId,
} from "./presentation.js";
import { selectedTripIds } from "./selection.js";

export const TRIP_SORT_DEFINITIONS = {
  date_desc: {
    label: "Date (newest first)",
    column: "startTime",
    dir: "desc",
  },
  date_asc: {
    label: "Date (oldest first)",
    column: "startTime",
    dir: "asc",
  },
  startTime_desc: {
    label: "Started (newest first)",
    column: "startTime",
    dir: "desc",
  },
  startTime_asc: {
    label: "Started (oldest first)",
    column: "startTime",
    dir: "asc",
  },
  endTime_desc: {
    label: "Ended (newest first)",
    column: "endTime",
    dir: "desc",
  },
  endTime_asc: {
    label: "Ended (oldest first)",
    column: "endTime",
    dir: "asc",
  },
  distance_desc: {
    label: "Distance (high to low)",
    column: "distance",
    dir: "desc",
  },
  distance_asc: {
    label: "Distance (low to high)",
    column: "distance",
    dir: "asc",
  },
  speed_desc: {
    label: "Speed (high to low)",
    column: "maxSpeed",
    dir: "desc",
  },
  speed_asc: {
    label: "Speed (low to high)",
    column: "maxSpeed",
    dir: "asc",
  },
  maxSpeed_desc: {
    label: "Max speed (high to low)",
    column: "maxSpeed",
    dir: "desc",
  },
  maxSpeed_asc: {
    label: "Max speed (low to high)",
    column: "maxSpeed",
    dir: "asc",
  },
  avgSpeed_desc: {
    label: "Average speed (high to low)",
    column: "avgSpeed",
    dir: "desc",
  },
  avgSpeed_asc: {
    label: "Average speed (low to high)",
    column: "avgSpeed",
    dir: "asc",
  },
  fuel_desc: {
    label: "Gas used (high to low)",
    column: "fuelConsumed",
    dir: "desc",
  },
  fuel_asc: {
    label: "Gas used (low to high)",
    column: "fuelConsumed",
    dir: "asc",
  },
  fuelConsumed_desc: {
    label: "Fuel (high to low)",
    column: "fuelConsumed",
    dir: "desc",
  },
  fuelConsumed_asc: {
    label: "Fuel (low to high)",
    column: "fuelConsumed",
    dir: "asc",
  },
  estimated_cost_desc: {
    label: "Cost (high to low)",
    column: "estimated_cost",
    dir: "desc",
  },
  estimated_cost_asc: {
    label: "Cost (low to high)",
    column: "estimated_cost",
    dir: "asc",
  },
  duration_desc: {
    label: "Duration (high to low)",
    column: "duration",
    dir: "desc",
  },
  duration_asc: {
    label: "Duration (low to high)",
    column: "duration",
    dir: "asc",
  },
  totalIdleDuration_desc: {
    label: "Idle time (high to low)",
    column: "totalIdleDuration",
    dir: "desc",
  },
  totalIdleDuration_asc: {
    label: "Idle time (low to high)",
    column: "totalIdleDuration",
    dir: "asc",
  },
  startOdometer_desc: {
    label: "Start odometer (high to low)",
    column: "startOdometer",
    dir: "desc",
  },
  startOdometer_asc: {
    label: "Start odometer (low to high)",
    column: "startOdometer",
    dir: "asc",
  },
  endOdometer_desc: {
    label: "End odometer (high to low)",
    column: "endOdometer",
    dir: "desc",
  },
  endOdometer_asc: {
    label: "End odometer (low to high)",
    column: "endOdometer",
    dir: "asc",
  },
  startLocation_desc: {
    label: "Start place (Z to A)",
    column: "startLocation",
    dir: "desc",
  },
  startLocation_asc: {
    label: "Start place (A to Z)",
    column: "startLocation",
    dir: "asc",
  },
  destination_desc: {
    label: "Destination (Z to A)",
    column: "destination",
    dir: "desc",
  },
  destination_asc: {
    label: "Destination (A to Z)",
    column: "destination",
    dir: "asc",
  },
  vehicleLabel_desc: {
    label: "Vehicle (Z to A)",
    column: "vehicleLabel",
    dir: "desc",
  },
  vehicleLabel_asc: {
    label: "Vehicle (A to Z)",
    column: "vehicleLabel",
    dir: "asc",
  },
  inactive_desc: {
    label: "State (inactive first)",
    column: "inactive",
    dir: "desc",
  },
  inactive_asc: {
    label: "State (active first)",
    column: "inactive",
    dir: "asc",
  },
  matchStatus_desc: {
    label: "Match status (Z to A)",
    column: "matchStatus",
    dir: "desc",
  },
  matchStatus_asc: {
    label: "Match status (A to Z)",
    column: "matchStatus",
    dir: "asc",
  },
  transactionId_desc: {
    label: "Trip ID (Z to A)",
    column: "transactionId",
    dir: "desc",
  },
  transactionId_asc: {
    label: "Trip ID (A to Z)",
    column: "transactionId",
    dir: "asc",
  },
  imei_desc: {
    label: "IMEI (Z to A)",
    column: "imei",
    dir: "desc",
  },
  imei_asc: {
    label: "IMEI (A to Z)",
    column: "imei",
    dir: "asc",
  },
  vin_desc: {
    label: "VIN (Z to A)",
    column: "vin",
    dir: "desc",
  },
  vin_asc: {
    label: "VIN (A to Z)",
    column: "vin",
    dir: "asc",
  },
  pointsRecorded_desc: {
    label: "Points (high to low)",
    column: "pointsRecorded",
    dir: "desc",
  },
  pointsRecorded_asc: {
    label: "Points (low to high)",
    column: "pointsRecorded",
    dir: "asc",
  },
};

export const TRIP_TABLE_COLUMNS = [
  {
    key: "select",
    label: "Select",
    icon: "fa-check-square",
    sortable: false,
    hideable: false,
    render: (trip) => renderTripSelectCell(trip),
  },
  {
    key: "date",
    label: "Date",
    icon: "fa-calendar-day",
    sortKey: "date",
    render: (trip) => renderDateCell(trip),
  },
  {
    key: "startTime",
    label: "Start Time",
    icon: "fa-play-circle",
    sortKey: "startTime",
    render: (trip) => renderTimeCell(trip.startTime),
  },
  {
    key: "endTime",
    label: "End Time",
    icon: "fa-stop-circle",
    sortKey: "endTime",
    render: (trip) => renderTimeCell(trip.endTime),
  },
  {
    key: "title",
    label: "Trip",
    icon: "fa-route",
    sortKey: "date",
    render: (trip) => renderTripTitleCell(trip),
  },
  {
    key: "startLocation",
    label: "Start",
    icon: "fa-location-dot",
    render: (trip) => renderTextCell(sanitizeLocation(trip.startLocation)),
  },
  {
    key: "destination",
    label: "Destination",
    icon: "fa-flag-checkered",
    render: (trip) => renderTextCell(sanitizeLocation(trip.destination)),
  },
  {
    key: "distance",
    label: "Distance",
    icon: "fa-road",
    align: "right",
    render: (trip) => renderMetricCell(formatMiles(trip.distance)),
  },
  {
    key: "duration",
    label: "Duration",
    icon: "fa-clock",
    align: "right",
    render: (trip) => renderMetricCell(formatTripDuration(trip.duration)),
  },
  {
    key: "maxSpeed",
    label: "Max Speed",
    icon: "fa-tachometer-alt",
    align: "right",
    render: (trip) => renderMetricCell(formatSpeed(trip.maxSpeed)),
  },
  {
    key: "avgSpeed",
    label: "Avg Speed",
    icon: "fa-tachometer-alt",
    align: "right",
    render: (trip) => renderMetricCell(formatSpeed(trip.avgSpeed)),
  },
  {
    key: "fuelConsumed",
    label: "Fuel",
    icon: "fa-gas-pump",
    align: "right",
    render: (trip) => renderMetricCell(formatGallons(trip.fuelConsumed)),
  },
  {
    key: "estimated_cost",
    label: "Cost",
    icon: "fa-dollar-sign",
    align: "right",
    render: (trip) => renderMetricCell(formatCurrency(trip.estimated_cost)),
  },
  {
    key: "totalIdleDuration",
    label: "Idle",
    icon: "fa-hourglass-half",
    align: "right",
    render: (trip) => renderMetricCell(formatTripDuration(trip.totalIdleDuration)),
  },
  {
    key: "odometer",
    label: "Odometer",
    icon: "fa-road",
    sortable: false,
    render: (trip) => renderOdometerCell(trip),
  },
  {
    key: "vehicleLabel",
    label: "Vehicle",
    icon: "fa-car",
    render: (trip) => renderTextCell(trip.vehicleLabel || "Unknown vehicle"),
  },
  {
    key: "inactive",
    label: "State",
    icon: "fa-toggle-on",
    render: (trip) => renderStateCell(trip),
  },
  {
    key: "matchStatus",
    label: "Match",
    icon: "fa-map-marked-alt",
    render: (trip) => renderStatusCell(trip.matchStatus || "Unmatched"),
  },
  {
    key: "pointsRecorded",
    label: "Points",
    icon: "fa-braille",
    align: "right",
    render: (trip) => renderMetricCell(formatInteger(trip.pointsRecorded)),
  },
  {
    key: "identifiers",
    label: "IDs",
    icon: "fa-fingerprint",
    sortable: false,
    render: (trip) => renderIdentifiersCell(trip),
  },
  {
    key: "actions",
    label: "Actions",
    icon: "fa-ellipsis-h",
    sortable: false,
    hideable: false,
    render: (trip) => renderTripActionCell(trip),
  },
];

export function getColumnSortKey(column) {
  if (column.sortable === false) {
    return null;
  }
  return column.sortKey || column.key;
}

export function getSortColumnForKey(sortKey) {
  const definition =
    TRIP_SORT_DEFINITIONS[`${sortKey}_desc`] || TRIP_SORT_DEFINITIONS[`${sortKey}_asc`];
  return definition?.column || sortKey;
}

function renderTripSelectCell(trip) {
  return `
    <label class="trip-table-select" aria-label="Select trip">
      <input type="checkbox" ${selectedTripIds.has(trip.transactionId) ? "checked" : ""}>
      <span></span>
    </label>
  `;
}

function renderDateCell(trip) {
  return `
    <div class="trip-table-date">
      <strong>${escapeHtml(formatDateOnly(trip.startTime))}</strong>
      <span>${escapeHtml(formatRelativeTime(trip.startTime))}</span>
    </div>
  `;
}

function renderTimeCell(isoString) {
  return `<span class="trip-table-text">${escapeHtml(formatTimeOnly(isoString))}</span>`;
}

function renderTripTitleCell(trip) {
  const badges = [
    isInactiveTrip(trip) ? '<span class="trip-table-badge muted">Inactive</span>' : "",
    trip.matchStatus ? '<span class="trip-table-badge">Matched</span>' : "",
  ]
    .filter(Boolean)
    .join("");
  return `
    <div class="trip-table-trip">
      <strong>${escapeHtml(generateSmartTitle(trip))}</strong>
      <span>${escapeHtml(formatRouteSummary(trip))}</span>
      ${badges ? `<div class="trip-table-badges">${badges}</div>` : ""}
    </div>
  `;
}

function renderTextCell(value) {
  return `<span class="trip-table-text">${escapeHtml(value || "--")}</span>`;
}

function renderMetricCell(value) {
  return `<span class="trip-table-metric">${escapeHtml(value || "--")}</span>`;
}

function renderStateCell(trip) {
  const inactive = isInactiveTrip(trip);
  return `
    <span class="trip-table-state ${inactive ? "inactive" : "active"}">
      <span></span>
      ${inactive ? "Inactive" : "Active"}
    </span>
  `;
}

function renderStatusCell(value) {
  const clean = String(value || "Unmatched").replace(/_/g, " ");
  return `<span class="trip-table-status">${escapeHtml(clean)}</span>`;
}

function renderOdometerCell(trip) {
  const start = formatOdometer(trip.startOdometer);
  const end = formatOdometer(trip.endOdometer);
  return `
    <div class="trip-table-stack">
      <strong>${escapeHtml(end)}</strong>
      <span>from ${escapeHtml(start)}</span>
    </div>
  `;
}

function renderIdentifiersCell(trip) {
  return `
    <div class="trip-table-ids">
      <span title="${escapeHtml(trip.transactionId || "")}">${escapeHtml(shortId(trip.transactionId))}</span>
      <span>${escapeHtml(trip.vehicleLabel || trip.imei || "--")}</span>
      <span>${escapeHtml(trip.vin || trip.imei || "--")}</span>
    </div>
  `;
}

function renderTripActionCell(trip) {
  const inactive = isInactiveTrip(trip);
  return `
    <div class="trip-row-actions">
      ${
        inactive
          ? ""
          : `
      <button class="trip-row-action-btn"
              type="button"
              title="Rematch trip"
              aria-label="Rematch trip"
              data-trip-action="rematch">
        <i class="fas fa-route"></i>
      </button>
      `
      }
      <button class="trip-row-action-btn"
              type="button"
              title="${inactive ? "Restore trip" : "Exclude from totals and maps"}"
              aria-label="${inactive ? "Restore trip" : "Exclude trip from totals and maps"}"
              data-trip-action="inactive">
        <i class="fas ${inactive ? "fa-undo" : "fa-eye-slash"}"></i>
      </button>
      <button class="trip-row-action-btn"
              type="button"
              title="View details"
              aria-label="View trip details"
              data-trip-action="view">
        <i class="fas fa-map"></i>
      </button>
      <button class="trip-row-action-btn delete"
              type="button"
              title="Delete"
              aria-label="Delete trip"
              data-trip-action="delete">
        <i class="fas fa-trash"></i>
      </button>
    </div>
  `;
}
