/**
 * Trips Page Logic
 * Handles vehicle fetching, DataTable initialization, and filtering.
 */

document.addEventListener("DOMContentLoaded", async () => {
  console.log("Trips Page: DOM Loaded");
  try {
    if (!window.jQuery) {
      console.error("jQuery is required but not loaded");
      return;
    }

    await initializePage();
  } catch (e) {
    console.error("Trips Page: Critical initialization error:", e);
    // Use notification manager if available, otherwise alert or console
    if (window.notificationManager) {
      window.notificationManager.show(`Critical Error: ${e.message}`, "danger");
    }
  }
});

async function initializePage() {
  // 1. Load Vehicles
  await loadVehicles();

  // 2. Initialize DataTable
  initializeDataTable();

  // 3. Setup Filter Listeners & chips
  setupFilterListeners();
  setupQuickRanges();
  updateFilterChips();

  // 4. Setup Bulk Actions
  setupBulkActions();
}

/**
 * Load vehicles into the dropdown
 */
async function loadVehicles() {
  const vehicleSelect = document.getElementById("trip-filter-vehicle");
  if (!vehicleSelect) return;

  try {
    // Fetch active vehicles
    const response = await fetch("/api/vehicles?active_only=true");
    if (!response.ok) throw new Error("Failed to load vehicles");

    const vehicles = await response.json();

    // Clear existing options except the first "All vehicles"
    vehicleSelect.innerHTML = '<option value="">All vehicles</option>';

    if (vehicles.length === 0) {
      // Maybe show a message or just leave it empty
    } else {
      vehicles.forEach((v) => {
        const option = document.createElement("option");
        option.value = v.imei;
        // Use custom name or make/model/year or VIN or IMEI
        let label = v.custom_name;
        if (!label) {
          if (v.year || v.make || v.model) {
            label = `${v.year || ""} ${v.make || ""} ${v.model || ""}`.trim();
          } else {
            label = v.vin ? `VIN: ${v.vin}` : `IMEI: ${v.imei}`;
          }
        }
        option.textContent = label;
        vehicleSelect.appendChild(option);
      });
    }
  } catch (error) {
    console.error("Error loading vehicles:", error);
    if (window.notificationManager) {
      window.notificationManager.show(
        "Failed to load vehicles list",
        "warning",
      );
    }
  }
}

/**
 * Initialize DataTables
 */
let tripsTable;

function initializeDataTable() {
  tripsTable = $("#trips-table").DataTable({
    processing: true,
    serverSide: true,
    ajax: {
      url: "/api/trips/datatable",
      type: "POST",
      contentType: "application/json",
      data: (d) => {
        // Add custom filter params to the payload
        d.filters = getFilterValues();
        // Send as JSON body, not form data
        return JSON.stringify(d);
      },
      // DataTables usually expects data to be sent as form-url-encoded or standard ajax query params.
      // When sending JSON with `contentType: "application/json"`, we need to handle the data processing differently or ensure backend expects it.
      // The backend `get_trips_datatable` expects `await request.json()`, so sending JSON string is correct.
      // However, jQuery ajax `data` needs to be stringified manually if contentType is json.
    },
    columns: [
      {
        data: null,
        orderable: false,
        className: "text-center",
        render: (_data, _type, row) =>
          `<input type="checkbox" class="trip-checkbox form-check-input" value="${row.transactionId}">`,
      },
      {
        data: "vehicleLabel",
        name: "vehicleLabel",
        render: (_data, _type, row) => {
          const name = row.vehicleLabel || "Unknown vehicle";
          const idTag = row.transactionId
            ? `<span class="pill pill-muted">${row.transactionId}</span>`
            : "";
          const vin = row.vin
            ? `<span class="pill pill-subtle">VIN ${row.vin}</span>`
            : "";
          return `
            <div class="trip-cell">
              <div class="trip-title">${name}</div>
              <div class="trip-meta">${idTag} ${vin}</div>
            </div>
          `;
        },
      },
      {
        data: "startTime",
        name: "startTime",
        render: (_data, _type, row) => {
          const start = formatDateTime(row.startTime);
          const end = formatDateTime(row.endTime);
          const duration = formatDuration(row.duration);
          return `
            <div class="trip-cell">
              <div class="trip-title">${start}</div>
              <div class="trip-meta"><i class="far fa-clock"></i> ${duration} · Ends ${end}</div>
            </div>
          `;
        },
      },
      {
        data: "distance",
        name: "distance",
        render: (_data, _type, row) => {
          const distance = row.distance
            ? `${parseFloat(row.distance).toFixed(1)} mi`
            : "--";
          const startLocation = sanitizeLocation(row.startLocation);
          const destination = sanitizeLocation(row.destination);
          return `
            <div class="trip-cell">
              <div class="trip-title">${distance}</div>
              <div class="trip-meta"><i class="fas fa-map-marker-alt"></i> ${startLocation} → ${destination}</div>
            </div>
          `;
        },
      },
      {
        data: "maxSpeed",
        name: "maxSpeed",
        render: (_data, _type, row) => {
          const speed = row.maxSpeed ? `${Math.round(row.maxSpeed)} mph` : "--";
          const idle = row.totalIdleDuration
            ? `${Math.round(row.totalIdleDuration / 60)} min idle`
            : "Minimal idle";
          return `
            <div class="trip-cell">
              <div class="trip-title">${speed}</div>
              <div class="trip-meta"><i class="fas fa-stopwatch"></i> ${idle}</div>
            </div>
          `;
        },
      },
      {
        data: "fuelConsumed",
        name: "fuelConsumed",
        render: (_data, _type, row) => {
          const fuel = row.fuelConsumed
            ? `${parseFloat(row.fuelConsumed).toFixed(2)} gal`
            : "--";
          const cost = row.estimated_cost
            ? `$${parseFloat(row.estimated_cost).toFixed(2)}`
            : "--";
          return `
            <div class="trip-cell">
              <div class="trip-title">${fuel}</div>
              <div class="trip-meta"><i class="fas fa-dollar-sign"></i> Est. cost ${cost}</div>
            </div>
          `;
        },
      },
      {
        data: null,
        orderable: false,
        render: (_data, _type, row) => `
          <div class="btn-group btn-group-sm">
            <a href="/trips/${row.transactionId}" class="btn btn-outline-primary" title="View details">
              <i class="fas fa-map"></i>
            </a>
            <button class="btn btn-outline-danger delete-trip-btn" data-id="${row.transactionId}" title="Delete">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        `,
      },
    ],
    order: [[2, "desc"]], // Sort by Start Time desc by default
    dom:
      '<"row"<"col-sm-12 col-md-6"l><"col-sm-12 col-md-6"f>>' +
      '<"row"<"col-sm-12"tr>>' +
      '<"row"<"col-sm-12 col-md-5"i><"col-sm-12 col-md-7"p>>',
    language: {
      emptyTable: "No trips found matching criteria",
      processing:
        '<div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div>',
    },
    drawCallback: () => {
      // Re-apply event listeners for dynamic content
      setupRowActions();
      updateBulkDeleteButton();
    },
  });

  // Handle "Select All" checkbox in header
  $("#select-all-trips").on("change", function () {
    const isChecked = $(this).is(":checked");
    $(".trip-checkbox").prop("checked", isChecked);
    updateBulkDeleteButton();
  });
}

function getFilterValues() {
  return {
    imei:
      (document.getElementById("trip-filter-vehicle")?.value || "").trim() ||
      null,
    distance_min:
      (
        document.getElementById("trip-filter-distance-min")?.value || ""
      ).trim() || null,
    distance_max:
      (
        document.getElementById("trip-filter-distance-max")?.value || ""
      ).trim() || null,
    speed_min:
      (document.getElementById("trip-filter-speed-min")?.value || "").trim() ||
      null,
    speed_max:
      (document.getElementById("trip-filter-speed-max")?.value || "").trim() ||
      null,
    fuel_min:
      (document.getElementById("trip-filter-fuel-min")?.value || "").trim() ||
      null,
    fuel_max:
      (document.getElementById("trip-filter-fuel-max")?.value || "").trim() ||
      null,
    has_fuel: document.getElementById("trip-filter-has-fuel")?.checked || false,
    start_date:
      document.getElementById("trip-filter-date-start")?.value || null,
    end_date: document.getElementById("trip-filter-date-end")?.value || null,
  };
}

/**
 * Setup debounced filter listeners
 */
function setupFilterListeners() {
  const inputs = document.querySelectorAll(
    "#trip-filter-vehicle, #trip-filter-distance-min, #trip-filter-distance-max, " +
      "#trip-filter-speed-min, #trip-filter-speed-max, #trip-filter-fuel-min, #trip-filter-fuel-max, " +
      "#trip-filter-has-fuel, #trip-filter-date-start, #trip-filter-date-end",
  );

  inputs.forEach((input) => {
    input.addEventListener("change", () => {
      updateFilterChips();
    });
    input.addEventListener("input", () => {
      updateFilterChips(false);
    });
  });

  // Apply button
  document
    .getElementById("trip-filter-apply")
    ?.addEventListener("click", () => {
      tripsTable.ajax.reload();
      showFilterAppliedMessage();
      updateFilterChips();
    });

  // Reset button
  const resetBtn = document.getElementById("trip-filter-reset");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      inputs.forEach((input) => {
        if (input.type === "checkbox") input.checked = false;
        else input.value = "";
      });
      updateFilterChips();
      tripsTable.ajax.reload();
    });
  }
}

function setupQuickRanges() {
  const buttons = document.querySelectorAll(".filter-quick-btn");
  const startInput = document.getElementById("trip-filter-date-start");
  const endInput = document.getElementById("trip-filter-date-end");

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const range = Number(btn.dataset.range);
      if (!startInput || !endInput || Number.isNaN(range)) return;

      if (range === 0) {
        startInput.value = "";
        endInput.value = "";
      } else {
        const today = new Date();
        const startDate = new Date();
        startDate.setDate(today.getDate() - range + 1);

        startInput.value = startDate.toISOString().slice(0, 10);
        endInput.value = today.toISOString().slice(0, 10);
      }

      updateFilterChips();
      tripsTable.ajax.reload();
    });
  });
}

function updateFilterChips(triggerReload = false) {
  const container = document.getElementById("active-filter-chips");
  if (!container) return;

  const filters = getFilterValues();
  const chips = [];

  if (filters.imei)
    chips.push(
      makeChip("Vehicle", filters.imei, () =>
        clearInput("trip-filter-vehicle"),
      ),
    );
  if (filters.start_date || filters.end_date)
    chips.push(
      makeChip(
        "Date",
        `${filters.start_date || "Any"} → ${filters.end_date || "Any"}`,
        () => {
          clearInput("trip-filter-date-start");
          clearInput("trip-filter-date-end");
        },
      ),
    );
  if (filters.distance_min || filters.distance_max)
    chips.push(
      makeChip(
        "Distance",
        `${filters.distance_min || "0"} - ${filters.distance_max || "∞"} mi`,
        () => {
          clearInput("trip-filter-distance-min");
          clearInput("trip-filter-distance-max");
        },
      ),
    );
  if (filters.speed_min || filters.speed_max)
    chips.push(
      makeChip(
        "Speed",
        `${filters.speed_min || "0"} - ${filters.speed_max || "∞"} mph`,
        () => {
          clearInput("trip-filter-speed-min");
          clearInput("trip-filter-speed-max");
        },
      ),
    );
  if (filters.fuel_min || filters.fuel_max)
    chips.push(
      makeChip(
        "Fuel",
        `${filters.fuel_min || "0"} - ${filters.fuel_max || "∞"} gal`,
        () => {
          clearInput("trip-filter-fuel-min");
          clearInput("trip-filter-fuel-max");
        },
      ),
    );
  if (filters.has_fuel)
    chips.push(
      makeChip("Has fuel", "Only trips with fuel data", () => {
        const cb = document.getElementById("trip-filter-has-fuel");
        if (cb) cb.checked = false;
      }),
    );

  container.innerHTML = "";
  if (chips.length === 0) {
    container.innerHTML = '<span class="filter-empty">No active filters</span>';
  } else {
    chips.forEach((chip) => container.appendChild(chip));
  }

  if (triggerReload) tripsTable.ajax.reload();
}

function makeChip(label, value, onRemove) {
  const chip = document.createElement("span");
  chip.className = "filter-chip";
  chip.innerHTML = `<strong>${label}:</strong> ${value} <button type="button" aria-label="Remove filter"><i class="fas fa-times"></i></button>`;
  chip.querySelector("button")?.addEventListener("click", () => {
    onRemove();
    updateFilterChips(true);
  });
  return chip;
}

function clearInput(id) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.type === "checkbox") {
    el.checked = false;
  } else {
    el.value = "";
  }
}

function showFilterAppliedMessage() {
  const helper = document.getElementById("filter-helper-text");
  if (!helper) return;
  helper.textContent = "Filters applied. Showing the newest matching trips.";
  helper.classList.add("text-success");
  setTimeout(() => {
    helper.textContent =
      "Adjust filters then apply to refresh results. Active filters appear as chips above.";
    helper.classList.remove("text-success");
  }, 2000);
}

/**
 * Setup row actions (delete, etc)
 */
function setupRowActions() {
  $(".delete-trip-btn")
    .off("click")
    .on("click", async function () {
      const id = $(this).data("id");
      if (!id) return;

      const confirmed = await window.confirmationDialog.show({
        title: "Delete Trip",
        message: "Are you sure you want to delete this trip?",
        confirmText: "Delete",
        confirmButtonClass: "btn-danger",
      });

      if (confirmed) {
        deleteTrip(id);
      }
    });

  $(".trip-checkbox")
    .off("change")
    .on("change", () => {
      updateBulkDeleteButton();
    });
}

/**
 * Update Bulk Delete Button State
 */
function updateBulkDeleteButton() {
  const checkedCount = $(".trip-checkbox:checked").length;
  const btn = $("#bulk-delete-trips-btn");
  const mobileBtn = $("#bulk-delete-trips-mobile-btn"); // If we implement mobile view later

  if (checkedCount > 0) {
    btn.prop("disabled", false).text(`Delete Selected (${checkedCount})`);
    if (mobileBtn) mobileBtn.prop("disabled", false);
  } else {
    btn.prop("disabled", true).text("Delete Selected");
    if (mobileBtn) mobileBtn.prop("disabled", true);
  }
}

function setupBulkActions() {
  $("#bulk-delete-trips-btn").on("click", async () => {
    const selectedIds = $(".trip-checkbox:checked")
      .map(function () {
        return $(this).val();
      })
      .get();

    if (selectedIds.length === 0) return;

    const confirmed = await window.confirmationDialog.show({
      title: "Delete Trips",
      message: `Are you sure you want to delete ${selectedIds.length} trips?`,
      confirmText: "Delete All",
      confirmButtonClass: "btn-danger",
    });

    if (confirmed) {
      bulkDeleteTrips(selectedIds);
    }
  });

  // Refresh Geocoding Button
  $("#refresh-geocoding-btn").on("click", async () => {
    // Just trigger basic refresh for now, or open modal if needed.
    // For now, let's just trigger a full recent refresh via API.
    try {
      if (window.notificationManager)
        window.notificationManager.show(
          "Starting geocoding refresh...",
          "info",
        );

      const response = await fetch("/api/geocode_trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval_days: 7 }), // Default to last 7 days
      });

      const result = await response.json();
      if (response.ok) {
        if (window.notificationManager)
          window.notificationManager.show("Geocoding task started.", "success");
      } else {
        throw new Error(result.detail || "Failed to start geocoding");
      }
    } catch (e) {
      if (window.notificationManager)
        window.notificationManager.show(e.message, "danger");
    }
  });
}

async function deleteTrip(id) {
  try {
    const response = await fetch(`/api/trips/${id}`, { method: "DELETE" });
    if (!response.ok) throw new Error("Failed to delete trip");

    if (window.notificationManager)
      window.notificationManager.show("Trip deleted successfully", "success");
    tripsTable.ajax.reload(null, false); // Reload but keep page
  } catch (e) {
    console.error("Delete failed", e);
    if (window.notificationManager)
      window.notificationManager.show("Failed to delete trip", "danger");
  }
}

async function bulkDeleteTrips(ids) {
  try {
    const response = await fetch("/api/trips/bulk_delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trip_ids: ids }),
    });

    if (!response.ok) throw new Error("Failed to bulk delete trips");

    const result = await response.json();

    if (window.notificationManager)
      window.notificationManager.show(
        result.message || "Trips deleted",
        "success",
      );
    tripsTable.ajax.reload(null, false);
    $("#select-all-trips").prop("checked", false);
  } catch (e) {
    console.error("Bulk delete failed", e);
    if (window.notificationManager)
      window.notificationManager.show("Failed to delete trips", "danger");
  }
}

/**
 * Format Helpers
 */
function formatDateTime(isoString) {
  if (!isoString) return "--";
  const date = new Date(isoString);
  return date.toLocaleString(); // Use browser locale
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return "--";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function sanitizeLocation(location) {
  if (!location) return "Unknown";
  if (typeof location === "string") return location;
  if (typeof location === "object") {
    return (
      location.formatted_address ||
      location.name ||
      [location.street, location.city, location.state]
        .filter(Boolean)
        .join(", ") ||
      "Unknown"
    );
  }
  return "Unknown";
}
