/* global L, flatpickr, notificationManager, bootstrap, EveryStreet, confirmationDialog, $ */

/**
 * Creates an editable cell for the DataTable
 * @param {*} data - Cell data
 * @param {string} type - Render type ('display', 'filter', etc.)
 * @param {string} field - Field name
 * @param {string} [inputType='text'] - HTML input type
 * @returns {string} HTML for the editable cell
 */
function createEditableCell(data, type, field, inputType = 'text') {
  if (type !== 'display') return data;
  
  const value = data === null || data === undefined ? '' : data;
  let inputAttributes = '';
  
  // Set specific attributes based on input type
  if (inputType === 'number') {
    inputAttributes = 'step="any"';
  } else if (inputType === 'datetime-local') {
    // Convert date to datetime-local format for input
    const datetime = value ? new Date(value) : new Date();
    const localDatetime = new Date(datetime.getTime() - datetime.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    
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

(() => {
  "use strict";

  /**
   * TripsManager - Manages trips data and UI interactions
   */
  class TripsManager {
    constructor() {
      // Initialize properties
      this.tripsTable = null;
      this.map = null;
      this.tripsLayer = L.layerGroup();
      this.selectedTripId = null;
      this.tripsCache = new Map();
      
      // Use global loadingManager
      this.loadingManager = window.loadingManager || {
        startOperation: () => {},
        addSubOperation: () => {},
        updateSubOperation: () => {},
        finish: () => {},
        error: () => {}
      };
      
      // Configuration
      this.config = {
        tables: {
          order: [[3, "desc"]],
          language: { 
            emptyTable: "No trips found in the selected date range" 
          }
        },
        dateFormats: {
          display: { 
            dateStyle: "medium", 
            timeStyle: "short", 
            hour12: true 
          }
        }
      };
      
      // Initialize on DOM load
      this.init();
    }

    /**
     * Initialize the trips manager
     */
    init() {
      this.initializeTripsTable();
      this.initializeEventListeners();
      this.fetchTrips(); // Initial load
    }

    /**
     * Initialize event listeners
     */
    initializeEventListeners() {
      // Apply filters button
      const applyFiltersButton = document.getElementById("apply-filters");
      if (applyFiltersButton) {
        applyFiltersButton.addEventListener("click", () => this.handleApplyFilters());
      }

      // Date preset buttons
      this.initializeDatePresetButtons();

      // Bulk actions buttons
      this.initializeBulkActionButtons();

      // Table row edit handlers (using event delegation)
      this.initializeTableEditHandlers();
    }

    /**
     * Initialize date preset buttons
     */
    initializeDatePresetButtons() {
      document.querySelectorAll(".date-preset").forEach(button => {
        button.addEventListener("click", (e) => this.handleDatePresetClick(e));
      });
    }

    /**
     * Handle click on date preset button
     * @param {Event} e - Click event
     */
    handleDatePresetClick(e) {
      const range = e.currentTarget.dataset.range;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      let startDate = new Date(today);
      let endDate = new Date(today);

      switch (range) {
        case "today":
          break;
        case "yesterday":
          startDate.setDate(startDate.getDate() - 1);
          break;
        case "last-week":
          startDate.setDate(startDate.getDate() - 7);
          break;
        case "last-month":
          startDate.setDate(startDate.getDate() - 30);
          break;
        case "last-6-months":
          startDate.setMonth(startDate.getMonth() - 6);
          break;
        case "last-year":
          startDate.setFullYear(startDate.getFullYear() - 1);
          break;
        case "all-time":
          this.fetchFirstTripDate(endDate);
          return;
      }
      
      this.updateDatesAndFetch(startDate, endDate);
    }

    /**
     * Fetch the date of the first trip
     * @param {Date} endDate - End date for range
     */
    async fetchFirstTripDate(endDate) {
      try {
        const response = await fetch("/api/first_trip_date");
        const data = await response.json();
        const startDate = new Date(data.first_trip_date);
        this.updateDatesAndFetch(startDate, endDate);
      } catch (error) {
        console.error("Error fetching first trip date:", error);
        notificationManager.show("Failed to fetch first trip date", "danger");
      }
    }

    /**
     * Initialize bulk action buttons
     */
    initializeBulkActionButtons() {
      const bulkDeleteBtn = document.getElementById("bulk-delete-trips-btn");
      if (bulkDeleteBtn) {
        bulkDeleteBtn.addEventListener("click", () => this.bulkDeleteTrips());
      }

      const refreshGeocodingBtn = document.getElementById("refresh-geocoding-btn");
      if (refreshGeocodingBtn) {
        refreshGeocodingBtn.addEventListener("click", () => this.refreshGeocoding());
      }
    }

    /**
     * Initialize table edit event handlers
     */
    initializeTableEditHandlers() {
      const tableEl = document.getElementById("trips-table");
      if (!tableEl) return;

      // Edit button click
      $(tableEl).on("click", ".edit-trip-btn", (e) => {
        e.preventDefault();
        const row = $(e.currentTarget).closest("tr");
        this.setRowEditMode(row, true);
      });

      // Cancel edit button click
      $(tableEl).on("click", ".cancel-edit-btn", (e) => {
        const row = $(e.currentTarget).closest("tr");
        this.cancelRowEdit(row);
      });

      // Save changes button click
      $(tableEl).on("click", ".save-changes-btn", (e) => {
        const row = $(e.currentTarget).closest("tr");
        this.saveRowChanges(row);
      });
    }

    /**
     * Set a table row to edit mode
     * @param {jQuery} row - Row jQuery element
     * @param {boolean} editMode - Whether to enable edit mode
     */
    setRowEditMode(row, editMode) {
      row.toggleClass("editing", editMode);
      row.find(".display-value").toggleClass("d-none", editMode);
      row.find(".edit-input").toggleClass("d-none", !editMode);
      row.find(".btn-group").toggleClass("d-none", editMode);
      row.find(".edit-actions").toggleClass("d-none", !editMode);
    }

    /**
     * Cancel row edit and restore original values
     * @param {jQuery} row - Row jQuery element
     */
    cancelRowEdit(row) {
      const rowData = this.tripsTable.row(row).data();
      row.find(".edit-input").each(function() {
        const field = $(this).closest(".editable-cell").data("field");
        $(this).val(rowData[field]);
      });
      this.setRowEditMode(row, false);
    }

    /**
     * Save changes to a row
     * @param {jQuery} row - Row jQuery element
     */
    async saveRowChanges(row) {
      try {
        const rowData = this.tripsTable.row(row).data();
        const updatedData = { ...rowData };

        // Collect updated values from inputs
        row.find(".edit-input").each(function() {
          const field = $(this).closest(".editable-cell").data("field");
          let value = $(this).val();
          if (field === "startTime" || field === "endTime") {
            value = new Date(value).toISOString();
          }
          updatedData[field] = value;
        });

        // Get trip ID
        const tripId = this.getTripId(rowData);
        if (!tripId) {
          throw new Error("Could not determine trip ID");
        }

        // Prepare update payload
        const updatePayload = {
          type: "trips",
          properties: { ...updatedData, transactionId: tripId },
        };

        if (rowData.geometry || rowData.gps) {
          updatePayload.geometry = rowData.geometry || rowData.gps;
        }

        // Send update to server
        const response = await fetch(`/api/trips/${tripId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updatePayload),
        });
        
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Failed to update trip");
        }
        
        // Update the table
        this.tripsTable.row(row).data(updatedData).draw();
        this.setRowEditMode(row, false);
        notificationManager.show("Trip updated successfully", "success");
      } catch (error) {
        console.error("Error updating trip:", error);
        notificationManager.show(error.message || "Failed to update trip", "danger");
      }
    }

    /**
     * Extract trip ID from row data
     * @param {Object} rowData - Row data object
     * @returns {string|null} Trip ID or null
     */
    getTripId(rowData) {
      if (rowData.properties?.transactionId) {
        return rowData.properties.transactionId;
      } else if (rowData.transactionId) {
        return rowData.transactionId;
      }
      return null;
    }

    /**
     * Handle apply filters button click
     */
    handleApplyFilters() {
      const startDate = document.getElementById("start-date").value;
      const endDate = document.getElementById("end-date").value;
      this.storeDates(startDate, endDate);
      this.fetchTrips();
    }

    /**
     * Store dates in localStorage
     * @param {string} startDate - Start date (YYYY-MM-DD)
     * @param {string} endDate - End date (YYYY-MM-DD)
     */
    storeDates(startDate, endDate) {
      try {
        localStorage.setItem("startDate", startDate);
        localStorage.setItem("endDate", endDate);
      } catch (error) {
        console.warn("Failed to store dates in localStorage:", error);
      }
    }

    /**
     * Update date inputs and fetch trips
     * @param {Date} startDate - Start date
     * @param {Date} endDate - End date
     */
    updateDatesAndFetch(startDate, endDate) {
      const startDateStr = startDate.toISOString().split("T")[0];
      const endDateStr = endDate.toISOString().split("T")[0];
      
      // Update DOM inputs
      const startInput = document.getElementById("start-date");
      const endInput = document.getElementById("end-date");
      
      if (startInput) startInput.value = startDateStr;
      if (endInput) endInput.value = endDateStr;
      
      // Store and fetch
      this.storeDates(startDateStr, endDateStr);
      this.fetchTrips();
    }

    /**
     * Initialize the trips DataTable
     */
    initializeTripsTable() {
      const tableEl = document.getElementById("trips-table");
      if (!tableEl) return;

      this.tripsTable = $(tableEl).DataTable({
        responsive: true,
        order: this.config.tables.order,
        columns: [
          {
            data: null,
            orderable: false,
            className: "select-checkbox",
            render: () => '<input type="checkbox" class="trip-checkbox">',
          },
          {
            data: "transactionId",
            title: "Transaction ID",
            render: (data, type) => createEditableCell(data, type, "transactionId"),
          },
          {
            data: "imei",
            title: "IMEI",
            render: (data, type) => createEditableCell(data, type, "imei"),
          },
          {
            data: "startTime",
            title: "Start Time",
            render: (data, type, row) => this.renderDateTime(data, type, row, "startTime"),
          },
          {
            data: "endTime",
            title: "End Time",
            render: (data, type, row) => this.renderDateTime(data, type, row, "endTime"),
          },
          {
            data: "distance",
            title: "Distance (miles)",
            render: (data, type) => createEditableCell(data, type, "distance", "number"),
          },
          {
            data: "startLocation",
            title: "Start Location",
            render: (data, type) => createEditableCell(data, type, "startLocation"),
          },
          {
            data: "destination",
            title: "Destination",
            render: (data, type) => createEditableCell(data, type, "destination"),
          },
          {
            data: "maxSpeed",
            title: "Max Speed (mph)",
            render: (data, type) => createEditableCell(data, type, "maxSpeed", "number"),
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
            render: (data, type) => createEditableCell(data, type, "fuelConsumed", "number"),
          },
          {
            data: null,
            title: "Actions",
            orderable: false,
            render: (data, type, row) => this.renderActionButtons(row),
          },
        ],
        language: this.config.tables.language,
      });

      // Make the trips table accessible globally
      window.tripsTable = this.tripsTable;

      // Selecting all trips checkbox
      $("#select-all-trips").on("change", (e) => {
        $(".trip-checkbox").prop("checked", e.target.checked);
        this.updateBulkDeleteButton();
      });

      // Individual checkboxes
      $(tableEl).on("change", ".trip-checkbox", () => {
        this.updateBulkDeleteButton();
      });
    }

    /**
     * Render date and time in proper format
     * @param {string} data - ISO date string
     * @param {string} type - Render type
     * @param {Object} row - Row data
     * @param {string} field - Field name
     * @returns {string} Formatted date or original data
     */
    renderDateTime(data, type, row, field) {
      if (type === "display") {
        const date = new Date(data);
        const timezone = row.timeZone || "America/Chicago";
        const formatter = new Intl.DateTimeFormat("en-US", {
          ...this.config.dateFormats.display,
          timeZone: timezone,
        });
        return createEditableCell(formatter.format(date), type, field, "datetime-local");
      }
      return data;
    }

    /**
     * Render action buttons for a row
     * @param {Object} row - Row data
     * @returns {string} HTML for action buttons
     */
    renderActionButtons(row) {
      return `
        <div class="btn-group">
          <button type="button" class="btn btn-sm btn-primary dropdown-toggle" data-bs-toggle="dropdown" aria-expanded="false">
            Actions
          </button>
          <ul class="dropdown-menu dropdown-menu-dark">
            <li><a class="dropdown-item" href="#" onclick="EveryStreet.Trips.exportTrip('${row.transactionId}', 'geojson')">Export GeoJSON</a></li>
            <li><a class="dropdown-item" href="#" onclick="EveryStreet.Trips.exportTrip('${row.transactionId}', 'gpx')">Export GPX</a></li>
            <li><a class="dropdown-item edit-trip-btn" href="#" data-trip-id="${row.transactionId}">Edit</a></li>
            <li><hr class="dropdown-divider"></li>
            <li><a class="dropdown-item text-danger" href="#" onclick="EveryStreet.Trips.deleteTrip('${row.transactionId}')">Delete</a></li>
          </ul>
        </div>
        <div class="edit-actions d-none">
          <button class="btn btn-sm btn-success save-changes-btn">Save</button>
          <button class="btn btn-sm btn-danger cancel-edit-btn">Cancel</button>
        </div>
      `;
    }

    /**
     * Update the bulk delete button state
     */
    updateBulkDeleteButton() {
      const checkedCount = $(".trip-checkbox:checked").length;
      $("#bulk-delete-trips-btn").prop("disabled", checkedCount === 0);
    }

    /**
     * Delete trips in bulk
     */
    async bulkDeleteTrips() {
      const selectedTrips = [];
      
      // Collect selected trip IDs
      $(".trip-checkbox:checked").each((_, el) => {
        const rowData = this.tripsTable.row($(el).closest("tr")).data();
        selectedTrips.push(rowData.transactionId);
      });
      
      if (selectedTrips.length === 0) {
        notificationManager.show("No trips selected for deletion.", "warning");
        return;
      }

      try {
        const confirmed = await confirmationDialog.show({
          title: "Delete Trips",
          message: `Are you sure you want to delete ${selectedTrips.length} trip(s)?`,
          confirmText: "Delete",
          confirmButtonClass: "btn-danger",
        });

        if (confirmed) {
          const response = await fetch("/api/trips/bulk_delete", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trip_ids: selectedTrips }),
          });
          
          const data = await response.json();
          
          if (data.status === "success") {
            notificationManager.show(`Successfully deleted ${data.deleted_count} trip(s).`, "success");
            this.fetchTrips();
          } else {
            notificationManager.show(`Error deleting trip(s): ${data.message}`, "danger");
            console.error("Error deleting trip(s):", data.message);
          }
        }
      } catch (error) {
        console.error("Error deleting trips:", error);
        notificationManager.show("Error deleting trip(s). Please try again.", "danger");
      }
    }

    /**
     * Refresh geocoding for selected trips
     */
    async refreshGeocoding() {
      const selectedTrips = [];
      
      // Collect selected trip IDs
      $(".trip-checkbox:checked").each((_, el) => {
        const rowData = this.tripsTable.row($(el).closest("tr")).data();
        selectedTrips.push(rowData.transactionId);
      });
      
      if (selectedTrips.length === 0) {
        notificationManager.show("No trips selected to refresh.", "warning");
        return;
      }

      try {
        const confirmed = await confirmationDialog.show({
          title: "Refresh Geocoding",
          message: `Are you sure you want to refresh geocoding for ${selectedTrips.length} trip(s)?`,
          confirmText: "Refresh",
          confirmButtonClass: "btn-primary",
        });

        if (confirmed) {
          const response = await fetch("/api/trips/refresh_geocoding", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trip_ids: selectedTrips }),
          });
          
          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || "Failed to refresh geocoding");
          }
          
          const data = await response.json();
          notificationManager.show(`Successfully refreshed geocoding for ${data.updated_count} trip(s).`, "success");
          this.fetchTrips();
        }
      } catch (error) {
        console.error("Error refreshing geocoding:", error);
        notificationManager.show(error.message || "Error refreshing geocoding. Please try again.", "danger");
      }
    }

    /**
     * Get filter parameters for API requests
     * @returns {URLSearchParams} URL parameters
     */
    getFilterParams() {
      const params = new URLSearchParams();
      
      // Get dates from localStorage or date inputs
      let startDate = localStorage.getItem("startDate");
      let endDate = localStorage.getItem("endDate");
      
      const startInput = document.getElementById("start-date");
      const endInput = document.getElementById("end-date");
      
      if (!startDate && startInput) startDate = startInput.value;
      if (!endDate && endInput) endDate = endInput.value;
      
      params.append("start_date", startDate);
      params.append("end_date", endDate);
      
      return params;
    }

    /**
     * Fetch trips data from API
     */
    async fetchTrips() {
      try {
        const params = this.getFilterParams();
        const url = `/api/trips?${params.toString()}`;
        
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        if (!data.features || !Array.isArray(data.features)) {
          console.warn("No trips data received or invalid format");
          this.tripsTable.clear().draw();
          return;
        }
        
        const formattedTrips = data.features.map(trip => this.formatTripData(trip));
        
        // Update the DataTable
        await new Promise(resolve => {
          this.tripsTable.clear().rows.add(formattedTrips).draw();
          setTimeout(resolve, 100);
        });
      } catch (error) {
        console.error("Error fetching trips:", error);
        notificationManager.show("Error loading trips. Please try again.", "danger");
      }
    }

    /**
     * Format trip data for display
     * @param {Object} trip - Trip data from API
     * @returns {Object} Formatted trip data
     */
    formatTripData(trip) {
      return {
        ...trip.properties,
        gps: trip.geometry,
        destination: trip.properties.destination || "N/A",
        isCustomPlace: trip.properties.isCustomPlace || false,
        distance: parseFloat(trip.properties.distance).toFixed(2),
        maxSpeed: trip.properties.maxSpeed || trip.properties.endLocation?.obdMaxSpeed || 0,
        totalIdleDuration: trip.properties.totalIdleDuration,
        fuelConsumed: trip.properties.fuelConsumed || 0,
      };
    }

    /**
     * Delete a single trip
     * @param {string} tripId - Trip ID to delete
     */
    async deleteTrip(tripId) {
      try {
        const confirmed = await confirmationDialog.show({
          title: "Delete Trip",
          message: "Are you sure you want to delete this trip?",
          confirmText: "Delete",
          confirmButtonClass: "btn-danger",
        });

        if (confirmed) {
          const response = await fetch(`/api/trips/${tripId}`, {
            method: "DELETE",
          });
          
          if (!response.ok) {
            throw new Error("Network response was not ok");
          }
          
          const data = await response.json();
          if (data.status === "success") {
            notificationManager.show("Trip deleted successfully", "success");
            this.fetchTrips();
          } else {
            notificationManager.show(`Error: ${data.message}`, "danger");
          }
        }
      } catch (error) {
        console.error("Error deleting trip:", error);
        notificationManager.show("Error deleting trip. Please try again.", "danger");
      }
    }

    /**
     * Export a trip in the specified format
     * @param {string} tripId - Trip ID to export
     * @param {string} format - Export format ('geojson' or 'gpx')
     */
    exportTrip(tripId, format) {
      const url = `/api/export/trip/${tripId}?format=${format}`;
      
      fetch(url)
        .then(response => {
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
          return response.blob();
        })
        .then(blob => {
          const blobUrl = window.URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.style.display = "none";
          a.href = blobUrl;
          a.download = `trip_${tripId}.${format}`;
          document.body.appendChild(a);
          a.click();
          window.URL.revokeObjectURL(blobUrl);
          document.body.removeChild(a);
        })
        .catch(error => {
          console.error("Error exporting trip:", error);
          notificationManager.show("Error exporting trip. Please try again.", "danger");
        });
    }
  }

  // Initialize TripsManager on DOM load
  document.addEventListener("DOMContentLoaded", () => {
    const tripsManager = new TripsManager();
    
    // Export public methods for global access
    window.EveryStreet = window.EveryStreet || {};
    window.EveryStreet.Trips = {
      fetchTrips: () => tripsManager.fetchTrips(),
      updateDatesAndFetch: (startDate, endDate) => tripsManager.updateDatesAndFetch(startDate, endDate),
      getFilterParams: () => tripsManager.getFilterParams(),
      deleteTrip: (tripId) => tripsManager.deleteTrip(tripId),
      exportTrip: (tripId, format) => tripsManager.exportTrip(tripId, format),
    };
  });
})();
