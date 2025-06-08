/* global DateUtils, confirmationDialog, $, handleError */

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
      // React to global filtersApplied event instead of direct button click
      document.addEventListener("filtersApplied", () => {
        this.fetchTrips();
      });

      this.initializeDatePresetButtons();

      this.initializeBulkActionButtons();

      this.initializeTableEditHandlers();
    }

    initializeDatePresetButtons() {
      document.querySelectorAll(".date-preset").forEach((button) => {
        button.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          this.handleDatePresetClick(e);
        });
      });
    }

    handleDatePresetClick(e) {
      const range = e.currentTarget.dataset.range;
      this.setDateRange(range);
    }

    async setDateRange(preset) {
      if (!preset) return;

      try {
        const { startDate, endDate } =
          await DateUtils.getDateRangePreset(preset);
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

        await window.utils.setStorage("startDate", startDate);
        await window.utils.setStorage("endDate", endDate);

        this.fetchTrips();
      } catch (error) {
        handleError(error, "Error setting date range", "error");
      }
    }

    initializeBulkActionButtons() {
      const bulkDeleteBtn = document.getElementById("bulk-delete-trips-btn");
      if (bulkDeleteBtn) {
        bulkDeleteBtn.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          this.bulkDeleteTrips();
        });
      }

      const refreshGeocodingBtn = document.getElementById(
        "refresh-geocoding-btn",
      );
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

      $(tableEl).on("mousedown", ".edit-trip-btn", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const row = $(e.currentTarget).closest("tr");
        this.setRowEditMode(row, true);
      });

      $(tableEl).on("mousedown", ".cancel-edit-btn", (e) => {
        if (e.button !== 0) return;
        const row = $(e.currentTarget).closest("tr");
        this.cancelRowEdit(row);
      });

      $(tableEl).on("mousedown", ".save-changes-btn", (e) => {
        if (e.button !== 0) return;
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
        handleError(error, "Error updating trip", "error");
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

    initializeTripsTable() {
      const tableEl = document.getElementById("trips-table");
      if (!tableEl) return;

      // Clear any existing table
      if (this.tripsTable) {
        this.tripsTable.destroy();
      }

      this.tripsTable = $(tableEl).DataTable({
        responsive: true,
        processing: true,
        serverSide: true, // Enable server-side processing
        deferRender: true, // Defer rendering for performance
        scroller: true, // Virtual scrolling
        scrollY: "400px",
        ajax: {
          url: "/api/trips",
          type: "POST",
          data: (d) => {
            // Add date filters
            d.start_date =
              window.utils.getStorage("startDate") ||
              DateUtils.getCurrentDate();
            d.end_date =
              window.utils.getStorage("endDate") || DateUtils.getCurrentDate();
            return d;
          },
          dataSrc: (json) => {
            // Cache the data for quick access
            this.tripsCache.clear();
            json.data.forEach((trip) => {
              this.tripsCache.set(trip.transactionId, trip);
            });
            return json.data;
          },
          error: (xhr, error, thrown) => {
            handleError(
              new Error(`Error fetching trips: ${thrown}`),
              "Trips data loading",
            );
            // Tell DataTables that we've handled the error
            // and there's no data to display
            if (this.tripsTable) {
              this.tripsTable.clear().draw();
            }
          },
        },
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
            render: (data) =>
              this.renderDateTime(data, "datetime", null, "startTime"),
          },
          {
            data: "endTime",
            title: "End Time",
            render: (data) =>
              this.renderDateTime(data, "datetime", null, "endTime"),
          },
          {
            data: "duration",
            title: "Duration",
            render: (data) => TripsManager.formatDuration(data),
          },
          {
            data: "distance",
            title: "Distance (miles)",
            render: (data) => `${parseFloat(data).toFixed(2)} miles`,
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
            render: (data) => `${parseFloat(data).toFixed(1)} mph`,
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
        pageLength: 50, // Show 50 rows at a time
        lengthMenu: [
          [25, 50, 100, -1],
          [25, 50, 100, "All"],
        ],
        order: [[0, "desc"]], // Sort by start time descending
        drawCallback() {
          // Cleanup previous event listeners
          $(this)
            .find(".edit-trip-btn, .cancel-edit-btn, .save-changes-btn")
            .off("mousedown");

          // Re-attach event listeners only for visible rows
          $(this)
            .find(".edit-trip-btn:visible")
            .on("mousedown", function (e) {
              if (e.button !== 0) return;
              e.preventDefault();
              const row = $(this).closest("tr");
              window.EveryStreet.Trips.tripsManager.setRowEditMode(row, true);
            });
        },
      });

      // Replace fetchTrips with just a table reload
      this.fetchTrips = function () {
        if (this.tripsTable) {
          this.tripsTable.ajax.reload(null, false); // Don't reset pagination
        }
      };

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
          <button class="btn btn-sm btn-outline-primary edit-trip-btn">Edit</button>
          <button class="btn btn-sm btn-outline-danger delete-trip-btn" data-id="${row.transactionId}">Delete</button>
          <div class="btn-group">
            <button class="btn btn-sm btn-outline-secondary dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false">
              Export
            </button>
            <ul class="dropdown-menu">
              <li><a class="dropdown-item export-trip-btn" href="#" data-format="gpx" data-id="${row.transactionId}">GPX</a></li>
              <li><a class="dropdown-item export-trip-btn" href="#" data-format="geojson" data-id="${row.transactionId}">GeoJSON</a></li>
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
      $("#bulk-delete-trips-btn").prop("disabled", !anyChecked);
    }

    async bulkDeleteTrips() {
      const checkedCheckboxes = document.querySelectorAll(
        ".trip-checkbox:checked",
      );
      if (checkedCheckboxes.length === 0) {
        window.notificationManager.show(
          "Please select trips to delete.",
          "info",
        );
        return;
      }

      const tripIds = Array.from(checkedCheckboxes).map((checkbox) => {
        const row = checkbox.closest("tr");
        const rowData = this.tripsTable.row(row).data();
        return rowData.transactionId;
      });

      const dialog = new window.ConfirmationDialog();
      dialog.show({
        title: "Confirm Bulk Deletion",
        message: `Are you sure you want to delete ${tripIds.length} selected trip(s)? This action cannot be undone.`,
        confirmText: "Delete",
        confirmButtonClass: "btn-danger",
        onConfirm: async () => {
          window.notificationManager.show("Deleting selected trips...", "info");

          try {
            const response = await fetch("/api/trips/bulk_delete", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ trip_ids: tripIds }),
            });

            if (!response.ok) {
              const errorData = await response.json();
              throw new Error(
                errorData.error || "Failed to delete one or more trips",
              );
            }

            window.notificationManager.show(
              "Trips deleted successfully",
              "success",
            );
            this.fetchTrips();
          } catch (error) {
            handleError(error, "bulkDeleteTrips");
          }
        },
      });
    }

    async refreshGeocoding() {
      window.notificationManager.show("Refreshing geocoding...", "info");
      try {
        const response = await fetch("/api/refresh_geocoding", {
          method: "POST",
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Failed to refresh geocoding");
        }

        window.notificationManager.show(
          "Geocoding refresh started successfully. It may take some time to see the changes.",
          "success",
        );
      } catch (error) {
        handleError(error, "refreshGeocoding");
      }
    }

    getFilterParams() {
      const startDate =
        window.utils.getStorage("startDate") || DateUtils.getCurrentDate();
      const endDate =
        window.utils.getStorage("endDate") || DateUtils.getCurrentDate();

      return `?start_date=${startDate}&end_date=${endDate}`;
    }

    async fetchTrips() {
      if (this.tripsTable) {
        this.tripsTable.ajax.reload();
      }
    }

    formatTripData(trip) {
      // This is now primarily handled by DataTables render functions.
      // Can be used for any pre-processing if needed in the future.
      return trip;
    }

    async deleteTrip(tripId) {
      if (!tripId) {
        window.notificationManager.show(
          "Cannot delete trip: ID is missing",
          "warning",
        );
        return;
      }

      const dialog = new window.ConfirmationDialog();
      dialog.show({
        title: "Confirm Deletion",
        message: `Are you sure you want to delete trip ${tripId}?`,
        confirmText: "Delete",
        confirmButtonClass: "btn-danger",
        onConfirm: async () => {
          try {
            const response = await fetch(`/api/trips/${tripId}`, {
              method: "DELETE",
            });

            if (!response.ok) {
              const errorData = await response.json();
              throw new Error(errorData.error || "Failed to delete trip");
            }

            this.tripsTable
              .row($(`#${tripId}`))
              .remove()
              .draw();
            window.notificationManager.show(
              "Trip deleted successfully",
              "success",
            );
          } catch (error) {
            handleError(error, `deleteTrip ${tripId}`);
          }
        },
      });
    }

    exportTrip(tripId, format) {
      if (!tripId) {
        window.notificationManager.show(
          "Cannot export trip: ID is missing",
          "warning",
        );
        return;
      }

      window.notificationManager.show(
        `Exporting trip ${tripId} as ${format}...`,
        "info",
      );

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
          window.notificationManager.show(
            `Trip ${tripId} exported successfully`,
            "success",
          );
        })
        .catch((error) => {
          handleError(error, `exportTrip ${tripId}`);
        });
    }

    static formatDuration(seconds) {
      if (seconds === null || seconds === undefined) {
        return "N/A";
      }
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      return [h, m, s]
        .map((v) => (v < 10 ? "0" + v : v))
        .filter((v, i) => v !== "00" || i > 0)
        .join(":");
    }
  }

  // Expose to global scope
  window.EveryStreet = window.EveryStreet || {};
  window.EveryStreet.Trips = {
    manager: new TripsManager(),
  };
})();
