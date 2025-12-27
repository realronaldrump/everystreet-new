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

  // 3. Setup Filter Listeners
  setupFilterListeners();

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
      data: function (d) {
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
        render: function (data, type, row) {
          return `<input type="checkbox" class="trip-checkbox form-check-input" value="${row.transactionId}">`;
        },
      },
      { data: "vehicleLabel", name: "vehicleLabel", defaultContent: "Unknown" },
      {
        data: "startTime",
        name: "startTime",
        render: function (data) {
          return formatDateTime(data);
        },
      },
      {
        data: "endTime",
        name: "endTime",
        render: function (data) {
          return formatDateTime(data);
        },
      },
      {
        data: "duration",
        name: "duration",
        render: function (data) {
          return formatDuration(data);
        },
      },
      {
        data: "distance",
        name: "distance",
        render: function (data) {
          return data ? `${parseFloat(data).toFixed(1)} mi` : "--";
        },
      },
      {
        data: "startLocation",
        name: "startLocation",
        defaultContent: "Unknown",
      },
      { data: "destination", name: "destination", defaultContent: "Unknown" },
      {
        data: "maxSpeed",
        name: "maxSpeed",
        render: function (data) {
          return data ? `${Math.round(data)} mph` : "--";
        },
      },
      {
        data: "totalIdleDuration",
        name: "totalIdleDuration",
        visible: false, // Hidden by default to save space, but available
      },
      {
        data: "fuelConsumed",
        name: "fuelConsumed",
        render: function (data) {
          return data ? `${parseFloat(data).toFixed(2)} gal` : "--";
        },
      },
      {
        data: "estimated_cost",
        name: "estimated_cost",
        render: function (data) {
          return data ? `$${parseFloat(data).toFixed(2)}` : "--";
        },
      },
      {
        data: null,
        orderable: false,
        render: function (data, type, row) {
          return `
                        <div class="btn-group btn-group-sm">
                            <a href="/trips/${row.transactionId}" class="btn btn-outline-primary" title="View Details">
                                <i class="fas fa-map"></i>
                            </a>
                            <button class="btn btn-outline-danger delete-trip-btn" data-id="${row.transactionId}" title="Delete">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    `;
        },
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
    drawCallback: function () {
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
    imei: document.getElementById("trip-filter-vehicle")?.value || null,
    distance_min:
      document.getElementById("trip-filter-distance-min")?.value || null,
    distance_max:
      document.getElementById("trip-filter-distance-max")?.value || null,
    speed_min: document.getElementById("trip-filter-speed-min")?.value || null,
    speed_max: document.getElementById("trip-filter-speed-max")?.value || null,
    fuel_min: document.getElementById("trip-filter-fuel-min")?.value || null,
    fuel_max: document.getElementById("trip-filter-fuel-max")?.value || null,
    has_fuel: document.getElementById("trip-filter-has-fuel")?.checked || false,
    // Add date filters (will be added to HTML next)
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

  const debouncedReload = utils.debounce(() => {
    tripsTable.ajax.reload();
  }, 500);

  inputs.forEach((input) => {
    input.addEventListener("input", debouncedReload);
    input.addEventListener("change", debouncedReload); // For selects and checkboxes
  });

  // Reset button
  const resetBtn = document.getElementById("trip-filter-reset");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      // Clear all inputs
      inputs.forEach((input) => {
        if (input.type === "checkbox") input.checked = false;
        else input.value = "";
      });
      // Reload table
      tripsTable.ajax.reload();
    });
  }
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
    .on("change", function () {
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
  $("#bulk-delete-trips-btn").on("click", async function () {
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
  $("#refresh-geocoding-btn").on("click", async function () {
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
