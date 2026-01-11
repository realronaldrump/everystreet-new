/**
 * Trips Page Logic
 * Handles trip listing, filtering, and bulk operations
 * Uses vanilla JS TableManager instead of jQuery DataTables
 */

import { CONFIG } from "./modules/config.js";
import { TableManager } from "./modules/table-manager.js";
import {
  escapeHtml,
  formatDateTime,
  formatDuration,
  formatVehicleName,
  getStorage,
  sanitizeLocation,
  setStorage,
} from "./modules/utils.js";

let tripsTable = null;
const selectedTripIds = new Set();

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await initializePage();
  } catch (e) {
    window.notificationManager?.show(`Critical Error: ${e.message}`, "danger");
  }
});

async function initializePage() {
  await loadVehicles();
  initializeTable();
  setupFilterListeners();
  setupBulkActions();
  updateFilterChips();

  document.addEventListener("filtersApplied", () => {
    updateFilterChips();
    tripsTable.reload();
  });
}

async function loadVehicles() {
  const vehicleSelect = document.getElementById("trip-filter-vehicle");
  if (!vehicleSelect) return;

  try {
    const response = await fetch(`${CONFIG.API.vehicles}?active_only=true`);
    if (!response.ok) throw new Error("Failed to load vehicles");

    const vehicles = await response.json();
    vehicleSelect.innerHTML = '<option value="">All vehicles</option>';

    vehicles.forEach((v) => {
      const option = document.createElement("option");
      option.value = v.imei;
      option.textContent = formatVehicleName(v);
      vehicleSelect.appendChild(option);
    });
  } catch {
    window.notificationManager?.show("Failed to load vehicles list", "warning");
  }
}

function initializeTable() {
  tripsTable = new TableManager("trips-table", {
    serverSide: true,
    url: CONFIG.API.tripsDataTable,
    pageSize: 25,
    defaultSort: { column: 2, dir: "desc" },
    emptyMessage: "No trips found matching criteria",
    getFilters: getFilterValues,
    columns: [
      {
        data: null,
        orderable: false,
        className: "text-center",
        render: (_data, _type, row) => {
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.className = "trip-checkbox form-check-input";
          checkbox.value = row.transactionId;
          checkbox.checked = selectedTripIds.has(row.transactionId);
          checkbox.addEventListener("change", (e) => {
            if (e.target.checked) {
              selectedTripIds.add(row.transactionId);
            } else {
              selectedTripIds.delete(row.transactionId);
            }
            updateBulkDeleteButton();
          });
          return checkbox;
        },
      },
      {
        data: "vehicleLabel",
        name: "vehicleLabel",
        render: (_data, _type, row) => {
          const cell = document.createElement("div");
          cell.className = "trip-cell";

          const title = document.createElement("div");
          title.className = "trip-title";
          title.textContent = row.vehicleLabel || "Unknown vehicle";
          cell.appendChild(title);

          const meta = document.createElement("div");
          meta.className = "trip-meta";
          if (row.transactionId) {
            const idPill = document.createElement("span");
            idPill.className = "pill pill-muted";
            idPill.textContent = row.transactionId;
            meta.appendChild(idPill);
          }
          if (row.vin) {
            const vinPill = document.createElement("span");
            vinPill.className = "pill pill-subtle";
            vinPill.textContent = `VIN ${row.vin}`;
            meta.appendChild(vinPill);
          }
          cell.appendChild(meta);

          return cell;
        },
      },
      {
        data: "startTime",
        name: "startTime",
        render: (_data, _type, row) => {
          const cell = document.createElement("div");
          cell.className = "trip-cell";

          const title = document.createElement("div");
          title.className = "trip-title";
          title.textContent = formatDateTime(row.startTime);
          cell.appendChild(title);

          const meta = document.createElement("div");
          meta.className = "trip-meta";
          meta.innerHTML = `<i class="far fa-clock"></i> ${escapeHtml(formatDuration(row.duration))} &middot; Ends ${escapeHtml(formatDateTime(row.endTime))}`;
          cell.appendChild(meta);

          return cell;
        },
      },
      {
        data: "distance",
        name: "distance",
        render: (_data, _type, row) => {
          const cell = document.createElement("div");
          cell.className = "trip-cell";

          const title = document.createElement("div");
          title.className = "trip-title";
          title.textContent = row.distance
            ? `${parseFloat(row.distance).toFixed(1)} mi`
            : "--";
          cell.appendChild(title);

          const meta = document.createElement("div");
          meta.className = "trip-meta";
          meta.innerHTML = `<i class="fas fa-map-marker-alt"></i> ${escapeHtml(sanitizeLocation(row.startLocation))} &rarr; ${escapeHtml(sanitizeLocation(row.destination))}`;
          cell.appendChild(meta);

          return cell;
        },
      },
      {
        data: "maxSpeed",
        name: "maxSpeed",
        render: (_data, _type, row) => {
          const cell = document.createElement("div");
          cell.className = "trip-cell";

          const title = document.createElement("div");
          title.className = "trip-title";
          title.textContent = row.maxSpeed
            ? `${Math.round(row.maxSpeed)} mph`
            : "--";
          cell.appendChild(title);

          const idle = row.totalIdleDuration
            ? `${Math.round(row.totalIdleDuration / 60)} min idle`
            : "Minimal idle";
          const meta = document.createElement("div");
          meta.className = "trip-meta";
          meta.innerHTML = `<i class="fas fa-stopwatch"></i> ${escapeHtml(idle)}`;
          cell.appendChild(meta);

          return cell;
        },
      },
      {
        data: "fuelConsumed",
        name: "fuelConsumed",
        render: (_data, _type, row) => {
          const cell = document.createElement("div");
          cell.className = "trip-cell";

          const title = document.createElement("div");
          title.className = "trip-title";
          title.textContent = row.fuelConsumed
            ? `${parseFloat(row.fuelConsumed).toFixed(2)} gal`
            : "--";
          cell.appendChild(title);

          const cost = row.estimated_cost
            ? `$${parseFloat(row.estimated_cost).toFixed(2)}`
            : "--";
          const meta = document.createElement("div");
          meta.className = "trip-meta";
          meta.innerHTML = `<i class="fas fa-dollar-sign"></i> Est. cost ${escapeHtml(cost)}`;
          cell.appendChild(meta);

          return cell;
        },
      },
      {
        data: null,
        orderable: false,
        render: (_data, _type, row) => {
          const container = document.createElement("div");
          container.className = "btn-group btn-group-sm no-row-click";

          const viewBtn = document.createElement("a");
          viewBtn.href = `/trips/${row.transactionId}`;
          viewBtn.className = "btn btn-outline-primary";
          viewBtn.title = "View details";
          viewBtn.innerHTML = '<i class="fas fa-map"></i>';
          container.appendChild(viewBtn);

          const deleteBtn = document.createElement("button");
          deleteBtn.className = "btn btn-outline-danger";
          deleteBtn.title = "Delete";
          deleteBtn.innerHTML = '<i class="fas fa-trash"></i>';
          deleteBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const confirmed = await window.confirmationDialog.show({
              title: "Delete Trip",
              message: "Are you sure you want to delete this trip?",
              confirmText: "Delete",
              confirmButtonClass: "btn-danger",
            });
            if (confirmed) {
              deleteTrip(row.transactionId);
            }
          });
          container.appendChild(deleteBtn);

          return container;
        },
      },
    ],
    onDataLoaded: () => {
      updateBulkDeleteButton();
    },
  });

  // Select all checkbox
  const selectAll = document.getElementById("select-all-trips");
  if (selectAll) {
    selectAll.addEventListener("change", (e) => {
      const checkboxes = document.querySelectorAll(".trip-checkbox");
      checkboxes.forEach((cb) => {
        cb.checked = e.target.checked;
        if (e.target.checked) {
          selectedTripIds.add(cb.value);
        } else {
          selectedTripIds.delete(cb.value);
        }
      });
      updateBulkDeleteButton();
    });
  }
}

function getFilterValues() {
  const getVal = (id) => document.getElementById(id)?.value?.trim() || null;
  return {
    imei: getVal("trip-filter-vehicle"),
    distance_min: getVal("trip-filter-distance-min"),
    distance_max: getVal("trip-filter-distance-max"),
    speed_min: getVal("trip-filter-speed-min"),
    speed_max: getVal("trip-filter-speed-max"),
    fuel_min: getVal("trip-filter-fuel-min"),
    fuel_max: getVal("trip-filter-fuel-max"),
    has_fuel: document.getElementById("trip-filter-has-fuel")?.checked || false,
    start_date: getStorage("startDate") || null,
    end_date: getStorage("endDate") || null,
  };
}

function setupFilterListeners() {
  const inputs = document.querySelectorAll(
    "#trip-filter-vehicle, #trip-filter-distance-min, #trip-filter-distance-max, " +
      "#trip-filter-speed-min, #trip-filter-speed-max, #trip-filter-fuel-min, #trip-filter-fuel-max, " +
      "#trip-filter-has-fuel",
  );

  inputs.forEach((input) => {
    input.addEventListener("change", () => updateFilterChips());
    input.addEventListener("input", () => updateFilterChips(false));
  });

  document
    .getElementById("trip-filter-apply")
    ?.addEventListener("click", () => {
      tripsTable.reload();
      showFilterAppliedMessage();
      updateFilterChips();
    });

  const resetBtn = document.getElementById("trip-filter-reset");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      inputs.forEach((input) => {
        if (input.type === "checkbox") input.checked = false;
        else input.value = "";
      });
      updateFilterChips();
      tripsTable.reload();
    });
  }
}

function updateFilterChips(triggerReload = false) {
  const container = document.getElementById("active-filter-chips");
  if (!container) return;

  const filters = getFilterValues();
  container.innerHTML = "";

  const addChip = (label, value, onRemove) => {
    const chip = document.createElement("span");
    chip.className = "filter-chip";

    const labelEl = document.createElement("strong");
    labelEl.textContent = `${label}: `;
    chip.appendChild(labelEl);
    chip.appendChild(document.createTextNode(`${value} `));

    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", "Remove filter");
    btn.innerHTML = '<i class="fas fa-times"></i>';
    btn.addEventListener("click", () => {
      onRemove();
      updateFilterChips(true);
    });
    chip.appendChild(btn);

    container.appendChild(chip);
  };

  if (filters.imei) {
    addChip("Vehicle", filters.imei, () => clearInput("trip-filter-vehicle"));
  }
  if (filters.start_date || filters.end_date) {
    addChip(
      "Date",
      `${filters.start_date || "Any"} -> ${filters.end_date || "Any"}`,
      () => {
        setStorage("startDate", null);
        setStorage("endDate", null);
        document.dispatchEvent(new Event("filtersReset"));
        tripsTable.reload();
      },
    );
  }
  if (filters.distance_min || filters.distance_max) {
    addChip(
      "Distance",
      `${filters.distance_min || "0"} - ${filters.distance_max || "inf"} mi`,
      () => {
        clearInput("trip-filter-distance-min");
        clearInput("trip-filter-distance-max");
      },
    );
  }
  if (filters.speed_min || filters.speed_max) {
    addChip(
      "Speed",
      `${filters.speed_min || "0"} - ${filters.speed_max || "inf"} mph`,
      () => {
        clearInput("trip-filter-speed-min");
        clearInput("trip-filter-speed-max");
      },
    );
  }
  if (filters.fuel_min || filters.fuel_max) {
    addChip(
      "Fuel",
      `${filters.fuel_min || "0"} - ${filters.fuel_max || "inf"} gal`,
      () => {
        clearInput("trip-filter-fuel-min");
        clearInput("trip-filter-fuel-max");
      },
    );
  }
  if (filters.has_fuel) {
    addChip("Has fuel", "Only trips with fuel data", () => {
      const cb = document.getElementById("trip-filter-has-fuel");
      if (cb) cb.checked = false;
    });
  }

  if (container.children.length === 0) {
    container.innerHTML = '<span class="filter-empty">No active filters</span>';
  }

  if (triggerReload) tripsTable.reload();
}

function clearInput(id) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.type === "checkbox") el.checked = false;
  else el.value = "";
}

function showFilterAppliedMessage() {
  const helper = document.getElementById("filter-helper-text");
  if (!helper) return;
  helper.textContent = "Filters applied. Showing the newest matching trips.";
  helper.classList.add("text-success");
  setTimeout(() => {
    helper.textContent = "Adjust filters then apply to refresh results.";
    helper.classList.remove("text-success");
  }, 2000);
}

function updateBulkDeleteButton() {
  const btn = document.getElementById("bulk-delete-trips-btn");
  if (!btn) return;

  const count = selectedTripIds.size;
  btn.disabled = count === 0;
  const textEl = btn.querySelector(".btn-text");
  if (textEl) {
    textEl.textContent =
      count > 0 ? `Delete Selected (${count})` : "Delete Selected";
  }
}

function setupBulkActions() {
  document
    .getElementById("bulk-delete-trips-btn")
    ?.addEventListener("click", async () => {
      if (selectedTripIds.size === 0) return;

      const confirmed = await window.confirmationDialog.show({
        title: "Delete Trips",
        message: `Are you sure you want to delete ${selectedTripIds.size} trips?`,
        confirmText: "Delete All",
        confirmButtonClass: "btn-danger",
      });

      if (confirmed) {
        await bulkDeleteTrips([...selectedTripIds]);
      }
    });

  document
    .getElementById("refresh-geocoding-btn")
    ?.addEventListener("click", async () => {
      try {
        window.notificationManager?.show(
          "Starting geocoding refresh...",
          "info",
        );
        const response = await fetch(CONFIG.API.geocodeTrips, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ interval_days: 7 }),
        });
        const result = await response.json();
        if (response.ok) {
          window.notificationManager?.show(
            "Geocoding task started.",
            "success",
          );
        } else {
          throw new Error(result.detail || "Failed to start geocoding");
        }
      } catch (e) {
        window.notificationManager?.show(e.message, "danger");
      }
    });
}

async function deleteTrip(id) {
  try {
    const response = await fetch(CONFIG.API.tripById(id), { method: "DELETE" });
    if (!response.ok) throw new Error("Failed to delete trip");

    window.notificationManager?.show("Trip deleted successfully", "success");
    selectedTripIds.delete(id);
    tripsTable.reload();
  } catch {
    window.notificationManager?.show("Failed to delete trip", "danger");
  }
}

async function bulkDeleteTrips(ids) {
  try {
    const response = await fetch(CONFIG.API.tripsBulkDelete, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trip_ids: ids }),
    });

    if (!response.ok) throw new Error("Failed to bulk delete trips");

    const result = await response.json();
    window.notificationManager?.show(
      result.message || "Trips deleted",
      "success",
    );
    selectedTripIds.clear();
    const selectAllEl = document.getElementById("select-all-trips");
    if (selectAllEl) selectAllEl.checked = false;
    tripsTable.reload();
  } catch {
    window.notificationManager?.show("Failed to delete trips", "danger");
  }
}
