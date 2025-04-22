/* global DateUtils, confirmationDialog, $ */

"use strict";

function createEditableCell(data, type, field, inputType = "text") {
  if (type !== "display") return data;

  const value = data === null || data === undefined ? "" : data;
  let inputAttributes = "";

  if (inputType === "number") {
    inputAttributes = 'step="any"';
  } else if (inputType === "datetime-local") {
    const dateObj = DateUtils.parseDate(value);
    const localDatetime = dateObj
      ? new Date(dateObj.getTime() - dateObj.getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16)
      : "";

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
  class TripsManager {
    constructor() {
      this.tripsTable = null;
      this.selectedTripId = null;
      this.tripsCache = new Map();

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

      this.init();
    }

    init() {
      this.initializeTripsTable();
      this.initializeEventListeners();
      this.fetchTrips();
    }

    initializeEventListeners() {
      const applyFiltersButton = document.getElementById("apply-filters");
      if (applyFiltersButton) {
        applyFiltersButton.addEventListener("click", () =>
          this.handleApplyFilters(),
        );
      }

      this.initializeDatePresetButtons();

      this.initializeBulkActionButtons();

      this.initializeTableEditHandlers();
    }

    initializeDatePresetButtons() {
      document.querySelectorAll(".date-preset").forEach((button) => {
        button.addEventListener("click", (e) => this.handleDatePresetClick(e));
      });
    }

    handleDatePresetClick(e) {
      const range = e.currentTarget.dataset.range;
      this.setDateRange(range);
    }

    setDateRange(preset) {
      if (!preset) return;

      DateUtils.getDateRangePreset(preset)
        .then(({ startDate, endDate }) => {
          const startDateInput = document.getElementById("start-date");
          const endDateInput = document.getElementById("end-date");

          if (startDateInput && endDateInput) {
            if (startDateInput._flatpickr) {
              startDateInput._flatpickr.setDate(startDate);
            } else {
              startDateInput.value = startDate;
            }

            if (endDateInput._flatpickr) {
              endDateInput._flatpickr.setDate(endDate);
            } else {
              endDateInput.value = endDate;
            }
          }

          localStorage.setItem("startDate", startDate);
          localStorage.setItem("endDate", endDate);

          this.fetchTrips();
        })
        .catch((error) => {
          console.error("Error setting date range:", error);
          window.notificationManager.show("Error setting date range", "danger");
        });
    }

    initializeBulkActionButtons() {
      const bulkDeleteBtn = document.getElementById("bulk-delete-trips-btn");
      if (bulkDeleteBtn) {
        bulkDeleteBtn.addEventListener("click", () => this.bulkDeleteTrips());
      }

      const refreshGeocodingBtn = document.getElementById(
        "refresh-geocoding-btn",
      );
      if (refreshGeocodingBtn) {
        refreshGeocodingBtn.addEventListener("click", () =>
          this.refreshGeocoding(),
        );
      }
    }

    initializeTableEditHandlers() {
      const tableEl = document.getElementById("trips-table");
      if (!tableEl) return;

      $(tableEl).on("click", ".edit-trip-btn", (e) => {
        e.preventDefault();
        const row = $(e.currentTarget).closest("tr");
        this.setRowEditMode(row, true);
      });

      $(tableEl).on("click", ".cancel-edit-btn", (e) => {
        const row = $(e.currentTarget).closest("tr");
        this.cancelRowEdit(row);
      });

      $(tableEl).on("click", ".save-changes-btn", (e) => {
        const row = $(e.currentTarget).closest("tr");
        this.saveRowChanges(row);
      });
    }

    setRowEditMode(row, editMode) {
      this.tripsTable;
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
        window.notificationManager.show("Trip updated successfully", "success");
      } catch (error) {
        console.error("Error updating trip:", error);
        window.notificationManager.show(
          `Error updating trip: ${error.message}`,
          "danger",
        );
      }
    }

    getTripId(rowData) {
      this.tripsCache;
      if (rowData.properties?.transactionId) {
        return rowData.properties.transactionId;
      } else if (rowData.transactionId) {
        return rowData.transactionId;
      }
      return null;
    }

    handleApplyFilters() {
      const startDate = document.getElementById("start-date").value;
      const endDate = document.getElementById("end-date").value;
      this.storeDates(startDate, endDate);
      this.fetchTrips();
    }

    storeDates(startDate, endDate) {
      this.tripsCache;
      try {
        localStorage.setItem("startDate", startDate);
        localStorage.setItem("endDate", endDate);
      } catch (error) {
        console.warn("Failed to store dates in localStorage:", error);
      }
    }

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
            render: (data, type) =>
              createEditableCell(data, type, "transactionId"),
          },
          {
            data: "imei",
            title: "IMEI",
            render: (data, type) => createEditableCell(data, type, "imei"),
          },
          {
            data: "startTime",
            title: "Start Time",
            render: (data, type, row) =>
              this.renderDateTime(data, type, row, "startTime"),
          },
          {
            data: "endTime",
            title: "End Time",
            render: (data, type, row) =>
              this.renderDateTime(data, type, row, "endTime"),
          },
          {
            data: "duration",
            title: "Duration",
            render: (data, type) => {
              if (type !== "display") return data;
              if (data == null || isNaN(data)) return "N/A";
              return TripsManager.formatDuration(data);
            },
            orderable: true,
          },
          {
            data: "distance",
            title: "Distance (miles)",
            render: (data, type) =>
              createEditableCell(data, type, "distance", "number"),
          },
          {
            data: "startLocation",
            title: "Start Location",
            render: (data, type) => {
              let displayValue = data;
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
              let displayValue = data;
              if (typeof data === "object" && data !== null) {
                displayValue = data.formatted_address || "Unknown destination";
              }
              return createEditableCell(displayValue, type, "destination");
            },
          },
          {
            data: "maxSpeed",
            title: "Max Speed (mph)",
            render: (data, type) => {
              const formattedValue =
                data != null ? parseFloat(data).toFixed(2) : data;
              return createEditableCell(
                formattedValue,
                type,
                "maxSpeed",
                "number",
              );
            },
          },
          {
            data: "totalIdleDuration",
            title: "Idle Duration (min)",
            render: (data, type) => {
              const value = data != null ? (data / 60).toFixed(2) : "N/A";
              return createEditableCell(
                value,
                type,
                "totalIdleDuration",
                "number",
              );
            },
          },
          {
            data: "fuelConsumed",
            title: "Fuel Consumed (gal)",
            render: (data, type) =>
              createEditableCell(data, type, "fuelConsumed", "number"),
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

      window.tripsTable = this.tripsTable;

      $("#select-all-trips").on("change", (e) => {
        $(".trip-checkbox").prop("checked", e.target.checked);
        this.updateBulkDeleteButton();
      });

      $(tableEl).on("change", ".trip-checkbox", () => {
        this.updateBulkDeleteButton();
      });
    }

    renderDateTime(data, type, row, field) {
      this.tripsCache;
      if (type === "display" && data) {
        const formattedDate = DateUtils.formatForDisplay(data, {
          dateStyle: "medium",
          timeStyle: "short",
        });

        return createEditableCell(formattedDate, type, field, "datetime-local");
      }
      return data;
    }

    renderActionButtons(row) {
      this.tripsCache;
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

    updateBulkDeleteButton() {
      this.tripsCache;
      const checkedCount = $(".trip-checkbox:checked").length;
      $("#bulk-delete-trips-btn").prop("disabled", checkedCount === 0);
    }

    async bulkDeleteTrips() {
      try {
        const selectedTrips = this.tripsTable
          .rows({ selected: true })
          .data()
          .map((row) => this.getTripId(row))
          .toArray();

        if (selectedTrips.length === 0) {
          window.notificationManager.show(
            "Please select at least one trip to delete",
            "warning",
          );
          return;
        }

        const confirmed = await confirmationDialog.show({
          title: "Delete Selected Trips",
          message: `Are you sure you want to delete ${selectedTrips.length} selected trip(s)? This action cannot be undone.`,
          confirmText: "Delete",
          confirmButtonClass: "btn-danger",
        });

        if (confirmed) {
          const response = await fetch("/api/trips/bulk_delete", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trip_ids: selectedTrips }),
          });

          if (!response.ok) {
            throw new Error("Network response was not ok");
          }

          const data = await response.json();

          if (data.status === "success") {
            window.notificationManager.show(
              `Successfully deleted ${data.deleted_trips} trip(s) and ${data.deleted_matched_trips} matched trip(s)`,
              "success",
            );
            this.fetchTrips();
          } else {
            window.notificationManager.show(
              `Error deleting trip(s): ${data.message}`,
              "danger",
            );
          }
        }
      } catch (error) {
        window.notificationManager.show(
          `Error deleting trips: ${error.message}`,
          "danger",
        );
      }
    }

    async refreshGeocoding() {
      const selectedTrips = [];

      $(".trip-checkbox:checked").each((_, el) => {
        const rowData = this.tripsTable.row($(el).closest("tr")).data();
        selectedTrips.push(rowData.transactionId);
      });

      if (selectedTrips.length === 0) {
        window.notificationManager.show(
          "No trips selected to refresh.",
          "warning",
        );
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

          window.notificationManager.show(
            `Successfully refreshed ${selectedTrips.length} trip(s)`,
            "success",
          );
          this.fetchTrips();
        }
      } catch (error) {
        console.error("Error refreshing trips:", error);
        window.notificationManager.show(
          `Error refreshing trips: ${error.message}`,
          "danger",
        );
      }
    }

    getFilterParams() {
      this.tripsCache;
      const params = new URLSearchParams();

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

    async fetchTrips() {
      try {
        if (window.loadingManager) {
          window.loadingManager.startOperation("Fetching Trips");
        }

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

        const formattedTrips = data.features.map((trip) =>
          this.formatTripData(trip),
        );

        this.tripsTable.clear().rows.add(formattedTrips).draw();

        if (window.loadingManager) {
          window.loadingManager.finish();
        }
      } catch (error) {
        console.error("Error fetching trips:", error);
        window.notificationManager.show(
          "Error loading trips. Please try again.",
          "danger",
        );

        if (window.loadingManager) {
          window.loadingManager.error(`Error loading trips: ${error.message}`);
        }
      }
    }

    formatTripData(trip) {
      this.tripsCache;
      let startLocation = trip.properties.startLocation;
      let destination = trip.properties.destination;

      if (startLocation && typeof startLocation === "object") {
        startLocation = startLocation.formatted_address || "Unknown location";
      }

      if (destination && typeof destination === "object") {
        destination = destination.formatted_address || "Unknown destination";
      }

      return {
        ...trip.properties,
        gps: trip.geometry,
        startLocation,
        destination: destination || "N/A",
        isCustomPlace: trip.properties.isCustomPlace || false,
        distance: parseFloat(trip.properties.distance).toFixed(2),
        maxSpeed:
          trip.properties.maxSpeed ||
          trip.properties.endLocation?.obdMaxSpeed ||
          0,
        totalIdleDuration: trip.properties.totalIdleDuration,
        fuelConsumed: trip.properties.fuelConsumed || 0,
      };
    }

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
            window.notificationManager.show(
              `Trip deleted successfully. Matched trips deleted: ${data.deleted_matched_trips}`,
              "success",
            );
            this.fetchTrips();
          } else {
            window.notificationManager.show(`Error: ${data.message}`, "danger");
          }
        }
      } catch (error) {
        window.notificationManager.show(
          `Error deleting trip: ${error.message}`,
          "danger",
        );
      }
    }

    exportTrip(tripId, format) {
      this.tripsCache;
      const url = `/api/export/trip/${tripId}?format=${format}`;

      fetch(url)
        .then((response) => {
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
          return response.blob();
        })
        .then((blob) => {
          const blobUrl = window.URL.createObjectURL(blob);
          const downloadLink = document.createElement("a");
          downloadLink.style.display = "none";
          downloadLink.href = blobUrl;
          downloadLink.download = `trip_${tripId}.${format}`;
          document.body.appendChild(downloadLink);
          downloadLink.click();
          window.URL.revokeObjectURL(blobUrl);
          document.body.removeChild(downloadLink);
        })
        .catch((error) => {
          console.error("Error exporting trip:", error);
          window.notificationManager.show(
            "Error exporting trip. Please try again.",
            "danger",
          );
        });
    }

    static formatDuration(seconds) {
      seconds = Math.floor(seconds);
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      return [h, m, s]
        .map((v) => v.toString().padStart(2, "0"))
        .join(":");
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const tripsManager = new TripsManager();

    window.EveryStreet = window.EveryStreet || {};
    window.EveryStreet.Trips = {
      fetchTrips: () => tripsManager.fetchTrips(),
      deleteTrip: (tripId) => tripsManager.deleteTrip(tripId),
      exportTrip: (tripId, format) => tripsManager.exportTrip(tripId, format),
    };
  });
})();
