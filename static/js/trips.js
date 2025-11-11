/* global DateUtils, $, handleError */

function createEditableCell(data, type, field, inputType = "text") {
  if (type !== "display") return data;

  const value = data === null || data === undefined ? "" : data;
  let inputAttributes = "";

  if (inputType === "number") {
    inputAttributes = 'step="any"';
  } else if (inputType === "datetime-local") {
    // Parse the date and convert to local datetime format for datetime-local input
    const dateObj = DateUtils.parseDate(value);
    let localDatetime = "";
    if (dateObj) {
      // Format as YYYY-MM-DDTHH:mm for datetime-local input (uses local timezone)
      const year = dateObj.getFullYear();
      const month = String(dateObj.getMonth() + 1).padStart(2, "0");
      const day = String(dateObj.getDate()).padStart(2, "0");
      const hours = String(dateObj.getHours()).padStart(2, "0");
      const minutes = String(dateObj.getMinutes()).padStart(2, "0");
      localDatetime = `${year}-${month}-${day}T${hours}:${minutes}`;
    }

    return `
      <div class="editable-cell" data-field="${field}">
        <span class="display-value">${value}</span>
        <input type="${inputType}" class="form-control edit-input d-none" value="${localDatetime}" ${inputAttributes}>
      </div>
    `;
  }

  return `
    <div class="editable-cell" data-field="${field}">
      <span class="display-value">${value}</span>
      <input type="${inputType}" class="form-control edit-input d-none" value="${value}" ${inputAttributes}>
    </div>
  `;
}

// Wait for all required dependencies to load
function waitForDependencies() {
  return new Promise((resolve) => {
    const checkDependencies = () => {
      if (
        typeof $ !== "undefined" &&
        $.fn.DataTable &&
        typeof DateUtils !== "undefined" &&
        typeof window.utils !== "undefined" &&
        window.confirmationDialog &&
        typeof window.confirmationDialog.show === "function"
      ) {
        resolve();
      } else {
        setTimeout(checkDependencies, 50);
      }
    };
    checkDependencies();
  });
}

class TripsManager {
  constructor() {
    this.tripsTable = null;
    this.selectedTripId = null;
    this.tripsCache = new Map();
    this.isInitialized = false;

    // Mobile-specific state
    this.isMobile = window.innerWidth <= 768;
    this.mobileTrips = [];
    this.mobileCurrentPage = 0;
    this.mobilePageSize = 10;
    this.mobileTotalTrips = 0;

    this.config = {
      tables: {
        order: [[3, "desc"]],
        language: {
          emptyTable: "No trips found in the selected date range",
        },
      },
      dateFormats: {
        display: {
          dateStyle: "medium",
          timeStyle: "short",
          hour12: true,
        },
      },
    };

    // Listen for window resize
    window.addEventListener("resize", () => {
      const wasMobile = this.isMobile;
      this.isMobile = window.innerWidth <= 768;

      // If we switched between mobile and desktop, reload
      if (wasMobile !== this.isMobile) {
        this.fetchTrips();
      }
    });
  }

  async init() {
    if (this.isInitialized) return;

    try {
      // Wait for dependencies to load
      await waitForDependencies();

      this.initializeTripsTable();
      this.initializeEventListeners();
      this.initializeMobileEventListeners();
      this.isInitialized = true;

      // Initial load
      this.fetchTrips();
    } catch (error) {
      console.error("Error initializing TripsManager:", error);
      if (typeof handleError === "function") {
        handleError(error, "Error initializing trips manager", "error");
      }
    }
  }

  initializeEventListeners() {
    // React to global filtersApplied event
    document.addEventListener("filtersApplied", () => {
      this.fetchTrips();
    });

    this.initializeBulkActionButtons();
    this.initializeTableEditHandlers();
  }

  initializeBulkActionButtons() {
    const bulkDeleteBtn = document.getElementById("bulk-delete-trips-btn");
    if (bulkDeleteBtn) {
      bulkDeleteBtn.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        this.bulkDeleteTrips();
      });
    }

    const refreshGeocodingBtn = document.getElementById("refresh-geocoding-btn");
    if (refreshGeocodingBtn) {
      refreshGeocodingBtn.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        this.refreshGeocoding();
      });
    }
  }

  initializeTableEditHandlers() {
    const tableEl = document.getElementById("trips-table");
    if (!tableEl) return;

    // Use event delegation for dynamic content
    $(document).on("mousedown", ".edit-trip-btn", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const row = $(e.currentTarget).closest("tr");
      this.setRowEditMode(row, true);
    });

    $(document).on("mousedown", ".cancel-edit-btn", (e) => {
      if (e.button !== 0) return;
      const row = $(e.currentTarget).closest("tr");
      this.cancelRowEdit(row);
    });

    $(document).on("mousedown", ".save-changes-btn", (e) => {
      if (e.button !== 0) return;
      const row = $(e.currentTarget).closest("tr");
      this.saveRowChanges(row);
    });

    $(document).on("mousedown", ".delete-trip-btn", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const tripId = $(e.currentTarget).data("id");
      this.deleteTrip(tripId);
    });

    $(document).on("mousedown", ".export-trip-btn", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const tripId = $(e.currentTarget).data("id");
      const format = $(e.currentTarget).data("format");
      this.exportTrip(tripId, format);
    });

    $(document).on("mousedown", ".refresh-geocoding-trip-btn", async (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const tripId = $(e.currentTarget).data("id");
      await this.refreshGeocodingForTrip(tripId);
    });
  }

  setRowEditMode(row, editMode) {
    row.toggleClass("editing", editMode);
    row.find(".display-value").toggleClass("d-none", editMode);
    row.find(".edit-input").toggleClass("d-none", !editMode);
    row.find(".btn-group").toggleClass("d-none", editMode);
    row.find(".edit-actions").toggleClass("d-none", !editMode);
  }

  cancelRowEdit(row) {
    const rowData = this.tripsTable.row(row).data();
    row.find(".edit-input").each(function () {
      const field = $(this).closest(".editable-cell").data("field");
      $(this).val(rowData[field]);
    });
    this.setRowEditMode(row, false);
  }

  async saveRowChanges(row) {
    try {
      const rowData = this.tripsTable.row(row).data();
      const updatedData = { ...rowData };

      row.find(".edit-input").each(function () {
        const field = $(this).closest(".editable-cell").data("field");
        let value = $(this).val();
        if (field === "startTime" || field === "endTime") {
          value = new Date(value).toISOString();
        }
        updatedData[field] = value;
      });

      const tripId = this.getTripId(rowData);
      if (!tripId) {
        throw new Error("Could not determine trip ID");
      }

      const updatePayload = {
        type: "trips",
        properties: { ...updatedData, transactionId: tripId },
      };

      if (rowData.geometry || rowData.gps) {
        updatePayload.geometry = rowData.geometry || rowData.gps;
      }

      const response = await fetch(`/api/trips/${tripId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatePayload),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to update trip");
      }

      this.tripsTable.row(row).data(updatedData).draw();
      this.setRowEditMode(row, false);

      if (window.notificationManager) {
        window.notificationManager.show("Trip updated successfully", "success");
      }
    } catch (error) {
      if (typeof handleError === "function") {
        handleError(error, "Error updating trip", "error");
      }
    }
  }

  getTripId(rowData) {
    if (rowData.properties?.transactionId) {
      return rowData.properties.transactionId;
    } else if (rowData.transactionId) {
      return rowData.transactionId;
    }
    return null;
  }

  initializeTripsTable() {
    const tableEl = document.getElementById("trips-table");
    if (!tableEl) {
      console.error("Trips table element not found");
      return;
    }

    // Clear any existing table
    if (this.tripsTable) {
      this.tripsTable.destroy();
      this.tripsTable = null;
    }

    try {
      this.tripsTable = $(tableEl).DataTable({
        responsive: true,
        processing: true,
        serverSide: true,
        deferRender: true,
        ajax: {
          url: "/api/trips/datatable",
          type: "POST",
          contentType: "application/json",
          data: (d) => {
            // Add date filters
            d.start_date =
              window.utils.getStorage("startDate") || DateUtils.getCurrentDate();
            d.end_date =
              window.utils.getStorage("endDate") || DateUtils.getCurrentDate();
            return JSON.stringify(d);
          },
          dataSrc: (json) => {
            // Cache the data for quick access
            this.tripsCache.clear();
            if (json.data) {
              json.data.forEach((trip) => {
                this.tripsCache.set(trip.transactionId, trip);
              });
            }
            return json.data || [];
          },
          error: (xhr, error, thrown) => {
            console.error("DataTables error:", { xhr, error, thrown });
            if (typeof handleError === "function") {
              handleError(
                new Error(`Error fetching trips: ${thrown || error}`),
                "Trips data loading"
              );
            }
          },
        },
        columns: [
          {
            data: null,
            orderable: false,
            searchable: false,
            className: "select-checkbox",
            render: () => '<input type="checkbox" class="trip-checkbox">',
          },
          {
            data: "startTime",
            title: "Start Time",
            render: (data, type) => this.renderDateTime(data, type, null, "startTime"),
          },
          {
            data: "endTime",
            title: "End Time",
            render: (data, type) => this.renderDateTime(data, type, null, "endTime"),
          },
          {
            data: "duration",
            title: "Duration",
            render: (data) => TripsManager.formatDuration(data),
          },
          {
            data: "distance",
            title: "Distance (miles)",
            render: (data) => {
              const distance = parseFloat(data || 0);
              return `${distance.toFixed(2)} miles`;
            },
          },
          {
            data: "startLocation",
            title: "Start Location",
            render: (data, type) => {
              let displayValue = data || "Unknown";
              if (typeof data === "object" && data !== null) {
                displayValue = data.formatted_address || "Unknown location";
              }
              return createEditableCell(displayValue, type, "startLocation");
            },
          },
          {
            data: "destination",
            title: "Destination",
            render: (data, type) => {
              let displayValue = data || "Unknown";
              if (typeof data === "object" && data !== null) {
                displayValue = data.formatted_address || "Unknown destination";
              }
              return createEditableCell(displayValue, type, "destination");
            },
          },
          {
            data: "maxSpeed",
            title: "Max Speed (mph)",
            render: (data) => {
              const speed = parseFloat(data || 0);
              return `${speed.toFixed(1)} mph`;
            },
          },
          {
            data: "totalIdleDuration",
            title: "Idle Duration (min)",
            render: (data, type) => {
              const value = data != null ? (data / 60).toFixed(2) : "N/A";
              return createEditableCell(value, type, "totalIdleDuration", "number");
            },
          },
          {
            data: "fuelConsumed",
            title: "Fuel Consumed (gal)",
            render: (data, type) => {
              const value = data != null ? parseFloat(data).toFixed(2) : "N/A";
              return createEditableCell(value, type, "fuelConsumed", "number");
            },
          },
          {
            data: null,
            title: "Actions",
            orderable: false,
            searchable: false,
            render: (_data, _type, row) => this.renderActionButtons(row),
          },
        ],
        language: {
          processing:
            '<div class="spinner-border spinner-border-sm" role="status"><span class="visually-hidden">Loading...</span></div>',
          emptyTable: "No trips found",
          zeroRecords: "No matching trips found",
          loadingRecords: "Loading trips...",
          info: "Showing _START_ to _END_ of _TOTAL_ trips",
          infoEmpty: "No trips available",
          infoFiltered: "(filtered from _MAX_ total trips)",
        },
        pageLength: 25,
        lengthMenu: [
          [10, 25, 50, 100],
          [10, 25, 50, 100],
        ],
        order: [[1, "desc"]], // Sort by start time descending
        drawCallback: () => {
          // Update bulk delete button state
          this.updateBulkDeleteButton();
        },
      });

      // Set up global reference and event handlers
      window.tripsTable = this.tripsTable;

      // Select all checkbox handler
      $("#select-all-trips").on("change", (e) => {
        $(".trip-checkbox").prop("checked", e.target.checked);
        this.updateBulkDeleteButton();
      });

      // Individual checkbox handler
      $(tableEl).on("change", ".trip-checkbox", () => {
        this.updateBulkDeleteButton();
      });
    } catch (error) {
      console.error("Error initializing DataTable:", error);
      if (typeof handleError === "function") {
        handleError(error, "Error initializing trips table", "error");
      }
    }
  }

  renderDateTime(data, type, _row, field) {
    if (type === "display" && data) {
      try {
        const formattedDate = DateUtils.formatForDisplay(data, {
          dateStyle: "medium",
          timeStyle: "short",
        });
        return createEditableCell(formattedDate, type, field, "datetime-local");
      } catch (error) {
        console.warn("Error formatting date:", data, error);
        return createEditableCell(data, type, field, "datetime-local");
      }
    }
    return data;
  }

  renderActionButtons(row) {
    const transactionId = row.transactionId || "";
    return `
      <div class="btn-group">
        <button class="btn btn-sm btn-outline-primary edit-trip-btn">Edit</button>
        <button class="btn btn-sm btn-outline-info refresh-geocoding-trip-btn" data-id="${transactionId}">Refresh Geocoding</button>
        <button class="btn btn-sm btn-outline-danger delete-trip-btn" data-id="${transactionId}">Delete</button>
        <div class="btn-group">
          <button class="btn btn-sm btn-outline-secondary dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false">
            Export
          </button>
          <ul class="dropdown-menu">
            <li><a class="dropdown-item export-trip-btn" href="#" data-format="gpx" data-id="${transactionId}">GPX</a></li>
            <li><a class="dropdown-item export-trip-btn" href="#" data-format="geojson" data-id="${transactionId}">GeoJSON</a></li>
          </ul>
        </div>
      </div>
      <div class="edit-actions d-none">
        <button class="btn btn-sm btn-success save-changes-btn">Save</button>
        <button class="btn btn-sm btn-warning cancel-edit-btn">Cancel</button>
      </div>
    `;
  }

  updateBulkDeleteButton() {
    const anyChecked = $(".trip-checkbox:checked").length > 0;
    const bulkDeleteBtn = $("#bulk-delete-trips-btn");
    if (bulkDeleteBtn.length) {
      bulkDeleteBtn.prop("disabled", !anyChecked);
    }
  }

  async bulkDeleteTrips(fromMobile = false) {
    let tripIds;

    if (fromMobile) {
      const checkedCheckboxes = document.querySelectorAll(
        ".trip-card-checkbox:checked"
      );
      if (checkedCheckboxes.length === 0) {
        if (window.notificationManager) {
          window.notificationManager.show("Please select trips to delete.", "info");
        }
        return;
      }
      tripIds = Array.from(checkedCheckboxes).map((checkbox) =>
        checkbox.getAttribute("data-trip-id")
      );
    } else {
      const checkedCheckboxes = document.querySelectorAll(".trip-checkbox:checked");
      if (checkedCheckboxes.length === 0) {
        if (window.notificationManager) {
          window.notificationManager.show("Please select trips to delete.", "info");
        }
        return;
      }
      tripIds = Array.from(checkedCheckboxes).map((checkbox) => {
        const row = checkbox.closest("tr");
        const rowData = this.tripsTable.row(row).data();
        return rowData.transactionId;
      });
    }

    if (
      typeof window.confirmationDialog === "object" &&
      window.confirmationDialog !== null
    ) {
      window.confirmationDialog
        .show({
          title: "Confirm Bulk Deletion",
          message: `Are you sure you want to delete ${tripIds.length} selected trip(s)? This action cannot be undone.`,
          confirmText: "Delete",
          confirmButtonClass: "btn-danger",
        })
        .then(async (confirmed) => {
          if (confirmed) {
            await this.performBulkDelete(tripIds);
          }
        });
    } else {
      // Fallback for environments where confirmationDialog is not available
      if (
        confirm(
          `Are you sure you want to delete ${tripIds.length} selected trip(s)? This action cannot be undone.`
        )
      ) {
        await this.performBulkDelete(tripIds);
      }
    }
  }

  async performBulkDelete(tripIds) {
    if (window.notificationManager) {
      window.notificationManager.show("Deleting selected trips...", "info");
    }

    try {
      const response = await fetch("/api/trips/bulk_delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trip_ids: tripIds }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to delete one or more trips");
      }

      const result = await response.json();

      if (window.notificationManager) {
        window.notificationManager.show(
          result.message || "Trips deleted successfully",
          "success"
        );
      }

      this.fetchTrips();
    } catch (error) {
      if (typeof handleError === "function") {
        handleError(error, "Error deleting trips");
      }
    }
  }

  async refreshGeocoding() {
    if (window.notificationManager) {
      window.notificationManager.show("Refreshing geocoding...", "info");
    }

    try {
      const response = await fetch("/api/geocode_trips", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          start_date: "",
          end_date: "",
          interval_days: 0,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to refresh geocoding");
      }

      await response.json();
      if (window.notificationManager) {
        window.notificationManager.show(
          "Geocoding refresh started successfully. It may take some time to see the changes.",
          "success"
        );
      }
    } catch (error) {
      if (typeof handleError === "function") {
        handleError(error, "Error refreshing geocoding");
      }
    }
  }

  fetchTrips() {
    if (this.isMobile) {
      this.fetchMobileTrips();
    } else if (this.tripsTable) {
      this.tripsTable.ajax.reload(null, false);
    }
  }

  async fetchMobileTrips() {
    const mobileList = document.getElementById("trips-mobile-list");
    if (!mobileList) return;

    // Show loading state
    mobileList.innerHTML = `
      <div class="trips-mobile-loading">
        <div class="spinner-border" role="status">
          <span class="visually-hidden">Loading...</span>
        </div>
        <div class="trips-mobile-loading-text">Loading trips...</div>
      </div>
    `;

    try {
      const startDate =
        window.utils.getStorage("startDate") || DateUtils.getCurrentDate();
      const endDate = window.utils.getStorage("endDate") || DateUtils.getCurrentDate();

      const requestData = {
        start: this.mobileCurrentPage * this.mobilePageSize,
        length: this.mobilePageSize,
        order: [{ column: 1, dir: "desc" }],
        start_date: startDate,
        end_date: endDate,
      };

      const response = await fetch("/api/trips/datatable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestData),
      });

      if (!response.ok) {
        throw new Error("Failed to fetch trips");
      }

      const data = await response.json();
      this.mobileTrips = data.data || [];
      this.mobileTotalTrips = data.recordsFiltered || 0;

      // Cache the data
      this.tripsCache.clear();
      this.mobileTrips.forEach((trip) => {
        this.tripsCache.set(trip.transactionId, trip);
      });

      this.renderMobileTrips();
      this.updateMobilePagination();
    } catch (error) {
      console.error("Error fetching mobile trips:", error);
      mobileList.innerHTML = `
        <div class="trips-mobile-empty">
          <i class="fas fa-exclamation-triangle"></i>
          <div class="trips-mobile-empty-title">Error Loading Trips</div>
          <div class="trips-mobile-empty-text">${error.message}</div>
        </div>
      `;
    }
  }

  renderMobileTrips() {
    const mobileList = document.getElementById("trips-mobile-list");
    if (!mobileList) return;

    if (this.mobileTrips.length === 0) {
      mobileList.innerHTML = `
        <div class="trips-mobile-empty">
          <i class="fas fa-car"></i>
          <div class="trips-mobile-empty-title">No Trips Found</div>
          <div class="trips-mobile-empty-text">No trips found in the selected date range</div>
        </div>
      `;
      return;
    }

    mobileList.innerHTML = this.mobileTrips
      .map((trip) => this.renderMobileTripCard(trip))
      .join("");
  }

  renderMobileTripCard(trip) {
    const transactionId = trip.transactionId || "";
    const startTime = DateUtils.formatForDisplay(trip.startTime, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    const endTime = DateUtils.formatForDisplay(trip.endTime, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    const duration = TripsManager.formatDuration(trip.duration);
    const distance = parseFloat(trip.distance || 0).toFixed(2);
    const maxSpeed = parseFloat(trip.maxSpeed || 0).toFixed(1);
    const idleDuration =
      trip.totalIdleDuration != null ? (trip.totalIdleDuration / 60).toFixed(2) : "N/A";
    const fuelConsumed =
      trip.fuelConsumed != null ? parseFloat(trip.fuelConsumed).toFixed(2) : "N/A";

    const startLocation =
      typeof trip.startLocation === "object" && trip.startLocation !== null
        ? trip.startLocation.formatted_address || "Unknown"
        : trip.startLocation || "Unknown";

    const destination =
      typeof trip.destination === "object" && trip.destination !== null
        ? trip.destination.formatted_address || "Unknown"
        : trip.destination || "Unknown";

    return `
      <div class="trip-card" data-trip-id="${transactionId}">
        <div class="trip-card-header">
          <input type="checkbox" class="trip-card-checkbox" data-trip-id="${transactionId}">
          <div class="trip-card-time">
            <div class="trip-card-start-time">${startTime}</div>
            <div class="trip-card-end-time">to ${endTime}</div>
          </div>
        </div>
        <div class="trip-card-body">
          <div class="trip-info-grid">
            <div class="trip-info-item">
              <div class="trip-info-label">Duration</div>
              <div class="trip-info-value">${duration}</div>
            </div>
            <div class="trip-info-item">
              <div class="trip-info-label">Distance</div>
              <div class="trip-info-value">${distance} mi</div>
            </div>
            <div class="trip-info-item">
              <div class="trip-info-label">Max Speed</div>
              <div class="trip-info-value">${maxSpeed} mph</div>
            </div>
            <div class="trip-info-item">
              <div class="trip-info-label">Idle Time</div>
              <div class="trip-info-value">${idleDuration} min</div>
            </div>
            <div class="trip-info-item">
              <div class="trip-info-label">Fuel</div>
              <div class="trip-info-value">${fuelConsumed} gal</div>
            </div>
          </div>
          <div class="trip-location">
            <div class="trip-location-item">
              <i class="fas fa-map-marker-alt trip-location-icon"></i>
              <div class="trip-location-text">${startLocation}</div>
            </div>
            <div class="trip-location-item">
              <i class="fas fa-flag-checkered trip-location-icon"></i>
              <div class="trip-location-text">${destination}</div>
            </div>
          </div>
          <div class="trip-card-actions">
            <button class="btn btn-sm btn-outline-info refresh-geocoding-trip-btn" data-id="${transactionId}">
              <i class="fas fa-sync"></i> Refresh
            </button>
            <button class="btn btn-sm btn-outline-danger delete-trip-btn" data-id="${transactionId}">
              <i class="fas fa-trash"></i> Delete
            </button>
            <div class="dropdown">
              <button class="btn btn-sm btn-outline-secondary dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false">
                <i class="fas fa-download"></i> Export
              </button>
              <ul class="dropdown-menu">
                <li><a class="dropdown-item export-trip-btn" href="#" data-format="gpx" data-id="${transactionId}">GPX</a></li>
                <li><a class="dropdown-item export-trip-btn" href="#" data-format="geojson" data-id="${transactionId}">GeoJSON</a></li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  updateMobilePagination() {
    const pagination = document.getElementById("trips-mobile-pagination");
    const pageInfo = document.getElementById("trips-mobile-page-info");
    const prevBtn = document.getElementById("trips-mobile-prev-btn");
    const nextBtn = document.getElementById("trips-mobile-next-btn");

    if (!pagination || !pageInfo || !prevBtn || !nextBtn) return;

    if (this.mobileTotalTrips === 0) {
      pagination.style.display = "none";
      return;
    }

    pagination.style.display = "flex";

    const start = this.mobileCurrentPage * this.mobilePageSize + 1;
    const end = Math.min(
      (this.mobileCurrentPage + 1) * this.mobilePageSize,
      this.mobileTotalTrips
    );
    pageInfo.textContent = `Showing ${start}-${end} of ${this.mobileTotalTrips} trips`;

    prevBtn.disabled = this.mobileCurrentPage === 0;
    nextBtn.disabled = end >= this.mobileTotalTrips;
  }

  initializeMobileEventListeners() {
    // Mobile select all
    const selectAllMobile = document.getElementById("select-all-trips-mobile");
    if (selectAllMobile) {
      selectAllMobile.addEventListener("change", (e) => {
        const checkboxes = document.querySelectorAll(".trip-card-checkbox");
        checkboxes.forEach((cb) => {
          cb.checked = e.target.checked;
          const card = cb.closest(".trip-card");
          if (card) {
            card.classList.toggle("selected", e.target.checked);
          }
        });
        this.updateMobileBulkDeleteButton();
      });
    }

    // Mobile individual checkboxes (delegated)
    document.addEventListener("change", (e) => {
      if (e.target.classList.contains("trip-card-checkbox")) {
        const card = e.target.closest(".trip-card");
        if (card) {
          card.classList.toggle("selected", e.target.checked);
        }
        this.updateMobileBulkDeleteButton();
      }
    });

    // Mobile bulk delete
    const bulkDeleteMobile = document.getElementById("bulk-delete-trips-mobile-btn");
    if (bulkDeleteMobile) {
      bulkDeleteMobile.addEventListener("click", () => {
        this.bulkDeleteTrips(true);
      });
    }

    // Mobile refresh geocoding
    const refreshMobile = document.getElementById("refresh-geocoding-mobile-btn");
    if (refreshMobile) {
      refreshMobile.addEventListener("click", () => {
        this.refreshGeocoding();
      });
    }

    // Mobile pagination
    const prevBtn = document.getElementById("trips-mobile-prev-btn");
    const nextBtn = document.getElementById("trips-mobile-next-btn");

    if (prevBtn) {
      prevBtn.addEventListener("click", () => {
        if (this.mobileCurrentPage > 0) {
          this.mobileCurrentPage--;
          this.fetchMobileTrips();
        }
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        const maxPage = Math.ceil(this.mobileTotalTrips / this.mobilePageSize) - 1;
        if (this.mobileCurrentPage < maxPage) {
          this.mobileCurrentPage++;
          this.fetchMobileTrips();
        }
      });
    }
  }

  updateMobileBulkDeleteButton() {
    const anyChecked =
      document.querySelectorAll(".trip-card-checkbox:checked").length > 0;
    const bulkDeleteBtn = document.getElementById("bulk-delete-trips-mobile-btn");
    if (bulkDeleteBtn) {
      bulkDeleteBtn.disabled = !anyChecked;
    }
  }

  async deleteTrip(tripId) {
    if (!tripId) {
      if (window.notificationManager) {
        window.notificationManager.show("Cannot delete trip: ID is missing", "warning");
      }
      return;
    }

    const confirmDelete = () =>
      new Promise((resolve) => {
        if (
          typeof window.confirmationDialog === "object" &&
          window.confirmationDialog !== null
        ) {
          window.confirmationDialog
            .show({
              title: "Confirm Deletion",
              message: `Are you sure you want to delete trip ${tripId}? This action cannot be undone.`,
              confirmText: "Delete",
              confirmButtonClass: "btn-danger",
            })
            .then(resolve);
        } else {
          // Fallback for environments where confirmationDialog is not available
          resolve(
            confirm(
              `Are you sure you want to delete trip ${tripId}? This action cannot be undone.`
            )
          );
        }
      });

    if (await confirmDelete()) {
      try {
        const response = await fetch(`/api/trips/${tripId}`, {
          method: "DELETE",
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Failed to delete trip");
        }

        if (window.notificationManager) {
          window.notificationManager.show("Trip deleted successfully", "success");
        }

        this.fetchTrips();
      } catch (error) {
        if (typeof handleError === "function") {
          handleError(error, `Error deleting trip ${tripId}`);
        }
      }
    }
  }

  exportTrip(tripId, format) {
    if (!tripId) {
      if (window.notificationManager) {
        window.notificationManager.show("Cannot export trip: ID is missing", "warning");
      }
      return;
    }

    if (window.notificationManager) {
      window.notificationManager.show(
        `Exporting trip ${tripId} as ${format}...`,
        "info"
      );
    }

    fetch(`/api/export/${format}?transaction_id=${tripId}`)
      .then((response) => {
        if (!response.ok) {
          return response.json().then((err) => {
            throw new Error(err.error || `Export failed for trip ${tripId}`);
          });
        }
        return response.blob();
      })
      .then((blob) => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${tripId}.${format}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);

        if (window.notificationManager) {
          window.notificationManager.show(
            `Trip ${tripId} exported successfully`,
            "success"
          );
        }
      })
      .catch((error) => {
        if (typeof handleError === "function") {
          handleError(error, `Error exporting trip ${tripId}`);
        }
      });
  }

  async refreshGeocodingForTrip(tripId) {
    if (!tripId) {
      if (window.notificationManager) {
        window.notificationManager.show(
          "Cannot refresh geocoding: trip ID missing",
          "warning"
        );
      }
      return;
    }

    if (window.notificationManager) {
      window.notificationManager.show(`Refreshing geocoding for ${tripId}...`, "info");
    }

    try {
      const response = await fetch(`/api/trips/${tripId}/regeocode`, {
        method: "POST",
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `Failed to refresh geocoding for ${tripId}`);
      }

      if (window.notificationManager) {
        window.notificationManager.show(
          `Trip ${tripId} geocoding refreshed successfully`,
          "success"
        );
      }

      // Reload the row data
      this.fetchTrips();
    } catch (error) {
      if (typeof handleError === "function") {
        handleError(error, `Error refreshing geocoding for ${tripId}`);
      }
    }
  }

  static formatDuration(rawValue) {
    const metricsManager = window.metricsManager || window.EveryStreet?.MetricsManager;

    const parsedSeconds = Number(rawValue);

    if (metricsManager?.formatDuration && !Number.isNaN(parsedSeconds)) {
      return metricsManager.formatDuration(parsedSeconds);
    }

    if (typeof rawValue === "string" && rawValue.includes(":")) {
      return rawValue.trim() || "N/A";
    }

    if (Number.isNaN(parsedSeconds) || parsedSeconds == null) {
      return "N/A";
    }

    const safeSeconds = Math.max(0, Math.floor(parsedSeconds));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const seconds = safeSeconds % 60;

    return hours > 0
      ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds
          .toString()
          .padStart(2, "0")}`
      : `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }
}

// Initialize when dependencies are ready
(async () => {
  try {
    // Wait for dependencies
    await waitForDependencies();

    // Create and initialize the trips manager
    const tripsManager = new TripsManager();
    await tripsManager.init();

    // Expose to global scope
    window.EveryStreet = window.EveryStreet || {};
    window.EveryStreet.Trips = {
      manager: tripsManager,
    };

    console.log("TripsManager initialized successfully");
  } catch (error) {
    console.error("Failed to initialize TripsManager:", error);
  }
})();
