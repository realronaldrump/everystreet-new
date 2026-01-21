/* global flatpickr */

/**
 * Setup functions for trip geocoding and remapping functionality
 */

import apiClient from "../modules/core/api-client.js";
import loadingManager from "../modules/ui/loading-manager.js";
import notificationManager from "../modules/ui/notifications.js";
import { DateUtils } from "../modules/utils.js";

export function setupManualFetchTripsForm(taskManager) {
  const form = document.getElementById("manualFetchTripsForm");
  if (!form) {
    return;
  }

  const startInput = document.getElementById("manual-fetch-start");
  const endInput = document.getElementById("manual-fetch-end");
  const mapMatchInput = document.getElementById("manual-fetch-map-match");
  const statusEl = document.getElementById("manual-fetch-status");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!taskManager) {
      return;
    }

    const startValue = startInput?.value;
    const endValue = endInput?.value;

    if (statusEl) {
      statusEl.textContent = "";
    }

    if (!startValue || !endValue) {
      if (statusEl) {
        statusEl.textContent = "Please select both start and end dates.";
      }
      return;
    }

    // Inputs are type="datetime-local" (e.g., 2025-10-30T13:34),
    // so parse using native Date which treats them as local time
    const startDate = new Date(startValue);
    const endDate = new Date(endValue);

    if (
      !startDate
      || !endDate
      || Number.isNaN(startDate.getTime())
      || Number.isNaN(endDate.getTime())
    ) {
      if (statusEl) {
        statusEl.textContent = "Invalid date selection.";
      }
      return;
    }

    if (endDate.getTime() <= startDate.getTime()) {
      if (statusEl) {
        statusEl.textContent = "End date must be after the start date.";
      }
      return;
    }

    const mapMatchEnabled = Boolean(mapMatchInput?.checked);

    try {
      if (statusEl) {
        statusEl.textContent = "Scheduling fetch...";
      }
      await taskManager.scheduleManualFetch(
        startDate.toISOString(),
        endDate.toISOString(),
        mapMatchEnabled
      );
      if (statusEl) {
        statusEl.textContent = "Fetch scheduled successfully.";
      }
    } catch (error) {
      if (statusEl) {
        statusEl.textContent = `Error: ${error.message}`;
      }
    }
  });
}

export function setupGeocodeTrips() {
  const geocodeType = document.getElementById("geocode-type");
  const dateRangeDiv = document.getElementById("geocode-date-range");
  const intervalDiv = document.getElementById("geocode-interval");
  const geocodeBtn = document.getElementById("geocode-trips-btn");
  const progressPanel = document.getElementById("geocode-progress-panel");
  const progressBar = document.getElementById("geocode-progress-bar");
  const progressMessage = document.getElementById("geocode-progress-message");
  const progressMetrics = document.getElementById("geocode-progress-metrics");
  const statusEl = document.getElementById("geocode-trips-status");

  if (!geocodeType || !geocodeBtn) {
    return;
  }

  // Handle method selection
  geocodeType.addEventListener("change", function () {
    const method = this.value;
    if (method === "date") {
      dateRangeDiv.style.display = "block";
      intervalDiv.style.display = "none";
    } else if (method === "interval") {
      dateRangeDiv.style.display = "none";
      intervalDiv.style.display = "block";
    } else {
      dateRangeDiv.style.display = "none";
      intervalDiv.style.display = "none";
    }
  });

  // Handle button click
  geocodeBtn.addEventListener("mousedown", async (e) => {
    if (e.button !== 0) {
      return;
    }

    const method = geocodeType.value;
    let start_date = "";
    let end_date = "";
    let interval_days = 0;

    if (method === "date") {
      start_date = document.getElementById("geocode-start").value;
      end_date = document.getElementById("geocode-end").value;
      if (!start_date || !end_date) {
        notificationManager.show(
          "Please select both start and end dates",
          "danger"
        );
        return;
      }
    } else if (method === "interval") {
      interval_days = parseInt(
        document.getElementById("geocode-interval-select").value,
        10
      );
    }

    try {
      geocodeBtn.disabled = true;
      if (statusEl) {
        statusEl.textContent = "Starting geocoding...";
        statusEl.className = "mt-2 text-info";
      }
      progressPanel.style.display = "block";
      progressBar.style.width = "0%";
      progressBar.textContent = "0%";
      progressBar.setAttribute("aria-valuenow", "0");
      progressBar.classList.remove("bg-success", "bg-danger");
      progressBar.classList.add(
        "bg-primary",
        "progress-bar-animated",
        "progress-bar-striped"
      );
      progressMessage.textContent = "Initializing...";
      progressMetrics.textContent = "";

      const response = await apiClient.raw("/api/geocode_trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date, end_date, interval_days }),
      });

      if (!response.ok) {
        throw new Error("Failed to start geocoding");
      }

      const data = await response.json();
      const taskId = data.task_id;

      // Start polling for progress
      const pollInterval = setInterval(async () => {
        try {
          const progressResponse = await apiClient.raw(`/api/geocode_trips/progress/${taskId}`);
          if (!progressResponse.ok) {
            clearInterval(pollInterval);
            geocodeBtn.disabled = false;
            const errorMessage
              = progressResponse.status === 404
                ? "Geocoding task not found."
                : "Unable to retrieve geocoding progress.";
            if (statusEl) {
              statusEl.textContent = errorMessage;
              statusEl.className = "mt-2 text-danger";
            }
            notificationManager.show(errorMessage, "danger");
            return;
          }

          const progressData = await progressResponse.json();
          const progress = progressData.progress || 0;
          const stage = progressData.stage || "unknown";
          const message = progressData.message || "";
          const metrics = progressData.metrics || {};

          // Update progress bar
          progressBar.style.width = `${progress}%`;
          progressBar.textContent = `${progress}%`;
          progressBar.setAttribute("aria-valuenow", progress);

          // Update message
          progressMessage.textContent = message;

          // Update metrics
          if (metrics.total > 0) {
            progressMetrics.textContent = `Total: ${metrics.total} | Updated: ${metrics.updated || 0} | Skipped: ${metrics.skipped || 0} | Failed: ${metrics.failed || 0}`;
          }

          // Check if completed
          if (stage === "completed" || stage === "error") {
            clearInterval(pollInterval);
            geocodeBtn.disabled = false;

            if (stage === "completed") {
              progressBar.classList.remove(
                "progress-bar-animated",
                "progress-bar-striped",
                "bg-primary",
                "bg-danger"
              );
              progressBar.classList.add("bg-success");
              if (statusEl) {
                statusEl.textContent = `Geocoding completed: ${metrics.updated || 0} updated, ${metrics.skipped || 0} skipped`;
                statusEl.className = "mt-2 text-success";
              }
              notificationManager.show(
                `Geocoding completed: ${metrics.updated || 0} updated, ${metrics.skipped || 0} skipped`,
                "success"
              );
            } else {
              progressBar.classList.remove(
                "progress-bar-animated",
                "progress-bar-striped",
                "bg-primary",
                "bg-success"
              );
              progressBar.classList.add("bg-danger");
              if (statusEl) {
                statusEl.textContent = `Error: ${progressData.error || "Unknown error"}`;
                statusEl.className = "mt-2 text-danger";
              }
              notificationManager.show(
                `Geocoding failed: ${progressData.error || "Unknown error"}`,
                "danger"
              );
            }
          }
        } catch {
          // Error polling progress - silently ignore
          clearInterval(pollInterval);
          geocodeBtn.disabled = false;
          if (statusEl) {
            statusEl.textContent = "Lost connection while monitoring progress.";
            statusEl.className = "mt-2 text-warning";
          }
          notificationManager.show(
            "Lost connection while monitoring geocoding progress",
            "warning"
          );
        }
      }, 1000); // Poll every second
    } catch {
      // Error starting geocoding - silently ignore
      geocodeBtn.disabled = false;
      if (statusEl) {
        statusEl.textContent = "Error starting geocoding. See console.";
        statusEl.className = "mt-2 text-danger";
      }
      notificationManager.show("Failed to start geocoding", "danger");
    }
  });

  // Initialize date pickers
  if (DateUtils?.initDatePicker) {
    DateUtils.initDatePicker(".datepicker");
  } else if (typeof flatpickr !== "undefined") {
    flatpickr(".datepicker", {
      enableTime: false,
      dateFormat: "Y-m-d",
    });
  }
}

export function setupRemapMatchedTrips() {
  const remapType = document.getElementById("remap-type");
  const dateRangeDiv = document.getElementById("remap-date-range");
  const intervalDiv = document.getElementById("remap-interval");
  if (!remapType || !dateRangeDiv || !intervalDiv) {
    return;
  }

  remapType.addEventListener("change", function () {
    dateRangeDiv.style.display = this.value === "date" ? "block" : "none";
    intervalDiv.style.display = this.value === "date" ? "none" : "block";
  });

  const remapBtn = document.getElementById("remap-btn");
  if (!remapBtn) {
    return;
  }

  remapBtn.addEventListener("mousedown", async (e) => {
    if (e.button !== 0) {
      return;
    }
    const method = remapType.value;
    let start_date = "";
    let end_date = "";
    let interval_days = 0;

    if (method === "date") {
      start_date = document.getElementById("remap-start").value;
      end_date = document.getElementById("remap-end").value;
      if (!start_date || !end_date) {
        notificationManager.show(
          "Please select both start and end dates",
          "danger"
        );
        return;
      }
    } else {
      interval_days = parseInt(
        document.getElementById("remap-interval-select").value,
        10
      );
      const startDateObj = new Date();
      startDateObj.setDate(startDateObj.getDate() - interval_days);
      start_date = DateUtils.formatDateToString(startDateObj);
      end_date = DateUtils.formatDateToString(new Date());
    }

    try {
      loadingManager.show();
      document.getElementById("remap-status").textContent = "Remapping trips...";

      const response = await apiClient.raw("/api/matched_trips/remap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date, end_date, interval_days }),
      });

      loadingManager.hide();

      const data = await response.json();

      document.getElementById("remap-status").textContent = data.message;
      notificationManager.show(data.message, "success");
    } catch {
      loadingManager.hide();
      document.getElementById("remap-status").textContent = "Error re-matching trips.";
      notificationManager.show("Failed to re-match trips", "danger");
    }
  });

  if (DateUtils?.initDatePicker) {
    DateUtils.initDatePicker(".datepicker");
  } else if (typeof flatpickr !== "undefined") {
    flatpickr(".datepicker", {
      enableTime: false,
      dateFormat: "Y-m-d",
    });
  }
}
