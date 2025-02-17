/* global L, flatpickr, notificationManager, bootstrap, LoadingManager, EveryStreet, confirmationDialog, createEditableCell, $ */

(() => {
  "use strict";

  let tripsTable = null;

  // Initialize on DOM load
  document.addEventListener("DOMContentLoaded", () => {
    initializeEventListeners();
    initializeTripsTable();
    fetchTrips(); // Initial load
  });

  //  EVENT LISTENERS
  function initializeEventListeners() {
    const applyFiltersButton = document.getElementById("apply-filters");
    if (applyFiltersButton) {
      applyFiltersButton.addEventListener("click", () => {
        const startDate = document.getElementById("start-date").value;
        const endDate = document.getElementById("end-date").value;
        localStorage.setItem("startDate", startDate);
        localStorage.setItem("endDate", endDate);
        fetchTrips();
      });
    }

    document.querySelectorAll(".date-preset").forEach((button) => {
      button.addEventListener("click", function () {
        const range = this.dataset.range;
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
            fetch("/api/first_trip_date")
              .then((response) => response.json())
              .then((data) => {
                startDate = new Date(data.first_trip_date);
                updateDatesAndFetch(startDate, endDate);
              })
              .catch((error) =>
                console.error("Error fetching first trip date:", error),
              );
            return;
        }
        updateDatesAndFetch(startDate, endDate);
      });
    });

    const bulkDeleteBtn = document.getElementById("bulk-delete-trips-btn");
    if (bulkDeleteBtn) {
      bulkDeleteBtn.addEventListener("click", bulkDeleteTrips);
    }

    const refreshGeocodingBtn = document.getElementById(
      "refresh-geocoding-btn",
    );
    if (refreshGeocodingBtn) {
      refreshGeocodingBtn.addEventListener("click", refreshGeocoding);
    }

    // Edit trip event handlers using jQuery for DataTable rows
    $("#trips-table").on("click", ".edit-trip-btn", function (e) {
      e.preventDefault();
      const row = $(this).closest("tr");
      row.addClass("editing");
      row.find(".display-value").addClass("d-none");
      row.find(".edit-input").removeClass("d-none");
      row.find(".btn-group").addClass("d-none");
      row.find(".edit-actions").removeClass("d-none");
    });

    $("#trips-table").on("click", ".cancel-edit-btn", function () {
      const row = $(this).closest("tr");
      row.removeClass("editing");
      const rowData = tripsTable.row(row).data();
      row.find(".edit-input").each(function () {
        const field = $(this).closest(".editable-cell").data("field");
        $(this).val(rowData[field]);
      });
      row.find(".display-value").removeClass("d-none");
      row.find(".edit-input").addClass("d-none");
      row.find(".btn-group").removeClass("d-none");
      row.find(".edit-actions").addClass("d-none");
    });

    $("#trips-table").on("click", ".save-changes-btn", async function () {
      const row = $(this).closest("tr");
      const rowData = tripsTable.row(row).data();
      const updatedData = { ...rowData };

      row.find(".edit-input").each(function () {
        const field = $(this).closest(".editable-cell").data("field");
        let value = $(this).val();
        if (field === "startTime" || field === "endTime") {
          value = new Date(value).toISOString();
        }
        updatedData[field] = value;
      });

      try {
        let tripId;
        if (rowData.properties?.transactionId) {
          tripId = rowData.properties.transactionId;
        } else if (rowData.transactionId) {
          tripId = rowData.transactionId;
        } else {
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
        tripsTable.row(row).data(updatedData).draw();

        row.removeClass("editing");
        row.find(".display-value").removeClass("d-none");
        row.find(".edit-input").addClass("d-none");
        row.find(".btn-group").removeClass("d-none");
        row.find(".edit-actions").addClass("d-none");
        notificationManager.show("Trip updated successfully", "success");
      } catch (error) {
        console.error("Error updating trip:", error);
        notificationManager.show(
          error.message || "Failed to update trip",
          "danger",
        );
      }
    });
  }

  //  HELPER FUNCTIONS
  function updateDatesAndFetch(startDate, endDate) {
    const startDateStr = startDate.toISOString().split("T")[0];
    const endDateStr = endDate.toISOString().split("T")[0];
    document.getElementById("start-date").value = startDateStr;
    document.getElementById("end-date").value = endDateStr;
    localStorage.setItem("startDate", startDateStr);
    localStorage.setItem("endDate", endDateStr);
    fetchTrips();
  }

  function initializeTripsTable() {
    tripsTable = $("#trips-table").DataTable({
      responsive: true,
      order: [[3, "desc"]],
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
          render: (data, type, row) => {
            if (type === "display") {
              const date = new Date(data);
              const timezone = row.timeZone || "America/Chicago";
              const formatter = new Intl.DateTimeFormat("en-US", {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: timezone,
                hour12: true,
              });
              return createEditableCell(
                formatter.format(date),
                type,
                "startTime",
                "datetime-local",
              );
            }
            return data;
          },
        },
        {
          data: "endTime",
          title: "End Time",
          render: (data, type, row) => {
            if (type === "display") {
              const date = new Date(data);
              const timezone = row.timeZone || "America/Chicago";
              const formatter = new Intl.DateTimeFormat("en-US", {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: timezone,
                hour12: true,
              });
              return createEditableCell(
                formatter.format(date),
                type,
                "endTime",
                "datetime-local",
              );
            }
            return data;
          },
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
          render: (data, type) =>
            createEditableCell(data, type, "startLocation"),
        },
        {
          data: "destination",
          title: "Destination",
          render: (data, type) => createEditableCell(data, type, "destination"),
        },
        {
          data: "maxSpeed",
          title: "Max Speed (mph)",
          render: (data, type) =>
            createEditableCell(data, type, "maxSpeed", "number"),
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
          render: (data, type, row) => `
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
            `,
        },
      ],
      language: {
        emptyTable: "No trips found in the selected date range",
      },
    });

    $("#select-all-trips").on("change", function () {
      $(".trip-checkbox").prop("checked", this.checked);
      updateBulkDeleteButton();
    });

    $("#trips-table").on("change", ".trip-checkbox", function () {
      updateBulkDeleteButton();
    });

    window.tripsTable = tripsTable;
  }

  function updateBulkDeleteButton() {
    const checkedCount = $(".trip-checkbox:checked").length;
    $("#bulk-delete-trips-btn").prop("disabled", checkedCount === 0);
  }

  async function bulkDeleteTrips() {
    const selectedTrips = [];
    $(".trip-checkbox:checked").each(function () {
      const rowData = tripsTable.row($(this).closest("tr")).data();
      selectedTrips.push(rowData.transactionId);
    });
    if (selectedTrips.length === 0) {
      notificationManager.show("No trips selected for deletion.", "warning");
      return;
    }

    const confirmed = await confirmationDialog.show({
      title: "Delete Trips",
      message: `Are you sure you want to delete ${selectedTrips.length} trip(s)?`,
      confirmText: "Delete",
      confirmButtonClass: "btn-danger",
    });

    if (confirmed) {
      try {
        const response = await fetch("/api/trips/bulk_delete", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trip_ids: selectedTrips }),
        });
        const data = await response.json();
        if (data.status === "success") {
          notificationManager.show(
            `Successfully deleted ${data.deleted_count} trip(s).`,
            "success",
          );
          fetchTrips();
        } else {
          notificationManager.show(
            `Error deleting trip(s): ${data.message}`,
            "danger",
          );
          console.error("Error deleting trip(s):", data.message);
        }
      } catch (error) {
        console.error("Error deleting trips:", error);
        notificationManager.show(
          "Error deleting trip(s). Please try again.",
          "danger",
        );
      }
    }
  }

  async function refreshGeocoding() {
    const selectedTrips = [];
    $(".trip-checkbox:checked").each(function () {
      const rowData = tripsTable.row($(this).closest("tr")).data();
      selectedTrips.push(rowData.transactionId);
    });
    if (selectedTrips.length === 0) {
      notificationManager.show("No trips selected to refresh.", "warning");
      return;
    }

    const confirmed = await confirmationDialog.show({
      title: "Refresh Geocoding",
      message: `Are you sure you want to refresh geocoding for ${selectedTrips.length} trip(s)?`,
      confirmText: "Refresh",
      confirmButtonClass: "btn-primary",
    });

    if (confirmed) {
      try {
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
        notificationManager.show(
          `Successfully refreshed geocoding for ${data.updated_count} trip(s).`,
          "success",
        );
        fetchTrips();
      } catch (error) {
        console.error("Error refreshing geocoding:", error);
        notificationManager.show(
          error.message || "Error refreshing geocoding. Please try again.",
          "danger",
        );
      }
    }
  }

  function formatDateTime(data, type, row) {
    if (type === "display" || type === "filter") {
      const date = new Date(data);
      const timezone = row.timeZone || "America/Chicago";
      const formatter = new Intl.DateTimeFormat("en-US", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: timezone,
        hour12: true,
      });
      return formatter.format(date);
    }
    return data;
  }

  function formatDistance(data, type) {
    if (type === "display") {
      const distance = parseFloat(data);
      return isNaN(distance) ? "0.00" : distance.toFixed(2);
    }
    return data;
  }

  function getFilterParams() {
    const params = new URLSearchParams();
    const startDate =
      localStorage.getItem("startDate") ||
      document.getElementById("start-date").value;
    const endDate =
      localStorage.getItem("endDate") ||
      document.getElementById("end-date").value;
    params.append("start_date", startDate);
    params.append("end_date", endDate);
    return params;
  }

  async function fetchTrips() {
    try {
      const params = getFilterParams();
      const url = `/api/trips?${params.toString()}`;
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(`HTTP error! status: ${response.status}`);
      const data = await response.json();
      if (!data.features || !Array.isArray(data.features)) {
        console.warn("No trips data received or invalid format");
        tripsTable.clear().draw();
        return;
      }
      const formattedTrips = data.features.map((trip) => ({
        ...trip.properties,
        gps: trip.geometry,
        destination: trip.properties.destination || "N/A",
        isCustomPlace: trip.properties.isCustomPlace || false,
        distance: parseFloat(trip.properties.distance).toFixed(2),
        maxSpeed:
          trip.properties.maxSpeed ||
          trip.properties.endLocation?.obdMaxSpeed ||
          0,
        totalIdleDuration: trip.properties.totalIdleDuration,
        fuelConsumed: trip.properties.fuelConsumed || 0,
      }));
      await new Promise((resolve) => {
        tripsTable.clear().rows.add(formattedTrips).draw();
        setTimeout(resolve, 100);
      });
    } catch (error) {
      console.error("Error fetching trips:", error);
      notificationManager.show(
        "Error loading trips. Please try again.",
        "danger",
      );
    }
  }

  function createEditableCell(data, type, field, inputType = "text") {
    if (type !== "display") return data;

    const value = data != null ? data : "";
    let inputValue = value;

    if (field === "startTime" || field === "endTime") {
      inputValue = value ? new Date(value).toISOString().slice(0, 16) : "";
    }

    return `
      <div class="editable-cell" data-field="${field}">
        <span class="display-value">${value}</span>
        <input type="${inputType}" class="form-control form-control-sm edit-input d-none" value="${inputValue}">
      </div>
    `;
  }

  // Expose global functions under EveryStreet.Trips
  window.EveryStreet = window.EveryStreet || {};
  window.EveryStreet.Trips = {
    fetchTrips,
    updateDatesAndFetch,
    getFilterParams,
    createEditableCell,
    deleteTrip: async function (tripId) {
      const confirmed = await confirmationDialog.show({
        title: "Delete Trip",
        message: "Are you sure you want to delete this trip?",
        confirmText: "Delete",
        confirmButtonClass: "btn-danger",
      });

      if (confirmed) {
        try {
          const response = await fetch(`/api/trips/${tripId}`, {
            method: "DELETE",
          });
          if (!response.ok) throw new Error("Network response was not ok");
          const data = await response.json();
          if (data.status === "success") {
            notificationManager.show("Trip deleted successfully", "success");
            EveryStreet.Trips.fetchTrips();
          } else {
            notificationManager.show(`Error: ${data.message}`, "danger");
          }
        } catch (error) {
          console.error("Error deleting trip:", error);
          notificationManager.show(
            "Error deleting trip. Please try again.",
            "danger",
          );
        }
      }
    },
    exportTrip: function (tripId, format) {
      const url = `/api/export/trip/${tripId}?format=${format}`;
      fetch(url)
        .then((response) => {
          if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);
          return response.blob();
        })
        .then((blob) => {
          const blobUrl = window.URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.style.display = "none";
          a.href = blobUrl;
          a.download = `trip_${tripId}.${format}`;
          document.body.appendChild(a);
          a.click();
          window.URL.revokeObjectURL(blobUrl);
        })
        .catch((error) => {
          console.error("Error exporting trip:", error);
          notificationManager.show(
            "Error exporting trip. Please try again.",
            "danger",
          );
        });
    },
  };
})();
