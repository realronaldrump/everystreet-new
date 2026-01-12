/* global bootstrap */

/**
 * Settings Page Entry Point
 *
 * This module imports and initializes all settings page components:
 * - TaskManager: Background task management with SSE updates
 * - InvalidTripReview: Invalid trip table management
 * - Geocode/Remap: Trip geocoding and remapping forms
 * - Mobile UI: Mobile-specific rendering
 * - App Settings: Tab switching and preferences
 */

import { initAppSettings } from "./app-settings.js";
import {
  setupGeocodeTrips,
  setupManualFetchTripsForm,
  setupRemapMatchedTrips,
} from "./geocode-remap.js";
import { InvalidTripReview } from "./invalid-trip-review.js";
import { initMobileUI } from "./mobile-ui.js";
import {
  gatherTaskConfigFromUI,
  submitTaskConfigUpdate,
} from "./task-manager/api.js";
import { showTaskDetails } from "./task-manager/modals.js";
import { TaskManager } from "./task-manager/task-manager.js";

// Initialize task manager globally
window.taskManager = null;

/**
 * Setup task configuration event listeners (buttons, checkboxes, etc.)
 */
function setupTaskConfigEventListeners(taskManager) {
  const saveTaskConfigBtn = document.getElementById("saveTaskConfigBtn");
  const confirmPauseBtn = document.getElementById("confirmPause");
  const resumeBtn = document.getElementById("resumeBtn");
  const stopAllBtn = document.getElementById("stopAllBtn");
  const enableAllBtn = document.getElementById("enableAllBtn");
  const disableAllBtn = document.getElementById("disableAllBtn");
  const manualRunAllBtn = document.getElementById("manualRunAllBtn");
  const globalSwitch = document.getElementById("globalDisableSwitch");
  const clearHistoryBtn = document.getElementById("clearHistoryBtn");

  if (saveTaskConfigBtn) {
    saveTaskConfigBtn.addEventListener("mousedown", (e) => {
      if (e.button !== 0) {
        return;
      }
      const config = gatherTaskConfigFromUI();
      submitTaskConfigUpdate(config)
        .then(() => {
          window.notificationManager.show(
            "Task configuration updated successfully",
            "success",
          );
          taskManager.loadTaskConfig();
        })
        .catch((error) => {
          window.notificationManager.show(
            `Error updating task config: ${error.message}`,
            "danger",
          );
        });
    });
  }

  const resetTasksBtn = document.getElementById("resetTasksBtn");
  if (resetTasksBtn) {
    resetTasksBtn.addEventListener("mousedown", async (e) => {
      if (e.button !== 0) {
        return;
      }
      try {
        window.loadingManager?.show();
        const response = await fetch("/api/background_tasks/reset", {
          method: "POST",
        });

        window.loadingManager?.hide();

        if (!response.ok) {
          throw new Error("Failed to reset tasks");
        }

        const result = await response.json();
        window.notificationManager.show(result.message, "success");
        taskManager.loadTaskConfig();
      } catch {
        window.loadingManager?.hide();
        window.notificationManager.show("Failed to reset tasks", "danger");
      }
    });
  }

  if (confirmPauseBtn) {
    confirmPauseBtn.addEventListener("mousedown", async (e) => {
      if (e.button !== 0) {
        return;
      }
      const duration = document.getElementById("pauseDuration")?.value || 60;
      try {
        window.loadingManager?.show();
        const response = await fetch("/api/background_tasks/pause", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ duration: parseInt(duration, 10) }),
        });

        window.loadingManager?.hide();

        if (!response.ok) {
          throw new Error("Failed to pause tasks");
        }

        window.notificationManager.show(
          `Tasks paused for ${duration} minutes`,
          "success",
        );

        const modal = bootstrap.Modal.getInstance(
          document.getElementById("pauseModal"),
        );
        if (modal) {
          modal.hide();
        }

        taskManager.loadTaskConfig();
      } catch {
        window.loadingManager?.hide();
        window.notificationManager.show("Failed to pause tasks", "danger");
      }
    });
  }

  if (resumeBtn) {
    resumeBtn.addEventListener("mousedown", async (e) => {
      if (e.button !== 0) {
        return;
      }
      try {
        window.loadingManager?.show();
        const response = await fetch("/api/background_tasks/resume", {
          method: "POST",
        });

        window.loadingManager?.hide();

        if (!response.ok) {
          throw new Error("Failed to resume tasks");
        }

        window.notificationManager.show("Tasks resumed", "success");
        taskManager.loadTaskConfig();
      } catch {
        window.loadingManager?.hide();
        window.notificationManager.show("Failed to resume tasks", "danger");
      }
    });
  }

  if (stopAllBtn) {
    stopAllBtn.addEventListener("mousedown", async (e) => {
      if (e.button !== 0) {
        return;
      }
      try {
        window.loadingManager?.show();
        const response = await fetch("/api/background_tasks/stop", {
          method: "POST",
        });

        window.loadingManager?.hide();

        if (!response.ok) {
          throw new Error("Failed to stop tasks");
        }

        window.notificationManager.show("All running tasks stopped", "success");
        taskManager.loadTaskConfig();
      } catch {
        window.loadingManager?.hide();
        window.notificationManager.show("Failed to stop tasks", "danger");
      }
    });
  }

  if (enableAllBtn) {
    enableAllBtn.addEventListener("mousedown", async (e) => {
      if (e.button !== 0) {
        return;
      }
      try {
        window.loadingManager?.show();
        const response = await fetch("/api/background_tasks/enable", {
          method: "POST",
        });

        window.loadingManager?.hide();

        if (!response.ok) {
          throw new Error("Failed to enable all tasks");
        }

        window.notificationManager.show("All tasks enabled", "success");
        taskManager.loadTaskConfig();
      } catch {
        window.loadingManager?.hide();
        window.notificationManager.show("Failed to enable tasks", "danger");
      }
    });
  }

  if (disableAllBtn) {
    disableAllBtn.addEventListener("mousedown", async (e) => {
      if (e.button !== 0) {
        return;
      }
      try {
        window.loadingManager?.show();
        const response = await fetch("/api/background_tasks/disable", {
          method: "POST",
        });

        window.loadingManager?.hide();

        if (!response.ok) {
          throw new Error("Failed to disable all tasks");
        }

        window.notificationManager.show("All tasks disabled", "success");
        taskManager.loadTaskConfig();
      } catch {
        window.loadingManager?.hide();
        window.notificationManager.show("Failed to disable tasks", "danger");
      }
    });
  }

  if (manualRunAllBtn) {
    manualRunAllBtn.addEventListener("mousedown", (e) => {
      if (e.button !== 0) {
        return;
      }
      taskManager.runTask("ALL");
    });
  }

  if (globalSwitch) {
    globalSwitch.addEventListener("change", () => {
      const config = gatherTaskConfigFromUI();
      submitTaskConfigUpdate(config)
        .then(() =>
          window.notificationManager.show("Global disable toggled", "success"),
        )
        .catch(() =>
          window.notificationManager.show(
            "Failed to toggle global disable",
            "danger",
          ),
        );
    });
  }

  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener("mousedown", (e) => {
      if (e.button !== 0) {
        return;
      }
      const modal = new bootstrap.Modal(
        document.getElementById("clearHistoryModal"),
      );
      modal.show();
    });
  }

  const confirmClearHistory = document.getElementById("confirmClearHistory");
  if (confirmClearHistory) {
    confirmClearHistory.addEventListener("mousedown", async (e) => {
      if (e.button !== 0) {
        return;
      }
      await taskManager.clearTaskHistory();
      const modal = bootstrap.Modal.getInstance(
        document.getElementById("clearHistoryModal"),
      );
      modal.hide();
    });
  }

  // Task table row button handlers
  const taskTableBody = document.querySelector("#taskConfigTable tbody");
  if (taskTableBody) {
    taskTableBody.addEventListener("mousedown", (e) => {
      const detailsBtn = e.target.closest(".view-details-btn");
      const runBtn = e.target.closest(".run-now-btn");
      const forceBtn = e.target.closest(".force-stop-btn");
      if (detailsBtn) {
        const { taskId } = detailsBtn.dataset;
        showTaskDetails(taskId);
      } else if (runBtn) {
        const { taskId } = runBtn.dataset;
        taskManager.runTask(taskId);
      } else if (forceBtn) {
        const { taskId } = forceBtn.dataset;
        taskManager.forceStopTask(taskId);
      }
    });
  }

  // Task details modal run button
  const taskDetailsModal = document.getElementById("taskDetailsModal");
  if (taskDetailsModal) {
    const runBtn = taskDetailsModal.querySelector(".run-task-btn");
    if (runBtn) {
      runBtn.addEventListener("mousedown", async (e) => {
        const { taskId } = e.target.dataset;
        if (taskId) {
          await taskManager.runTask(taskId);
          bootstrap.Modal.getInstance(taskDetailsModal).hide();
        }
      });
    }
  }
}

/**
 * Setup fetch all missing trips modal
 */
function setupFetchAllMissingModal(taskManager) {
  const openFetchAllMissingModalBtn = document.getElementById(
    "openFetchAllMissingModalBtn",
  );
  const confirmFetchAllMissingBtn = document.getElementById(
    "confirmFetchAllMissing",
  );
  const fetchAllMissingStartInput = document.getElementById(
    "fetchAllMissingStart",
  );

  if (openFetchAllMissingModalBtn) {
    openFetchAllMissingModalBtn.addEventListener("click", async () => {
      try {
        const response = await fetch("/api/trips/earliest_date");
        if (response.ok) {
          const data = await response.json();
          if (data.earliest_date && fetchAllMissingStartInput) {
            const date = new Date(data.earliest_date);
            const formatted = date.toISOString().slice(0, 16);
            fetchAllMissingStartInput.value = formatted;
          } else if (fetchAllMissingStartInput) {
            fetchAllMissingStartInput.value = "2020-01-01T00:00";
          }
        }
      } catch {
        if (fetchAllMissingStartInput) {
          fetchAllMissingStartInput.value = "2020-01-01T00:00";
        }
      }
    });
  }

  if (confirmFetchAllMissingBtn) {
    confirmFetchAllMissingBtn.addEventListener("click", async () => {
      const startDate = fetchAllMissingStartInput?.value;
      const statusSpan = document.getElementById("fetchAllMissingStatus");

      const modalEl = document.getElementById("fetchAllMissingModal");
      const modal = bootstrap.Modal.getInstance(modalEl);
      modal.hide();

      try {
        if (openFetchAllMissingModalBtn) {
          openFetchAllMissingModalBtn.disabled = true;
        }
        if (statusSpan) {
          statusSpan.textContent = "Starting task...";
        }

        window.loadingManager?.show();
        const response = await fetch(
          "/api/background_tasks/fetch_all_missing_trips",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ start_date: startDate }),
          },
        );
        const result = await response.json();
        window.loadingManager?.hide();

        if (response.ok && result.status === "success") {
          taskManager.notifier.show(
            "Success",
            "Fetch all missing trips task started",
            "success",
          );
          if (statusSpan) {
            statusSpan.textContent = "Task started!";
          }
          setTimeout(() => {
            if (statusSpan) {
              statusSpan.textContent = "";
            }
            if (openFetchAllMissingModalBtn) {
              openFetchAllMissingModalBtn.disabled = false;
            }
          }, 3000);
          taskManager.loadTaskConfig();
        } else {
          throw new Error(
            result.detail || result.message || "Failed to start task",
          );
        }
      } catch (error) {
        window.loadingManager?.hide();
        taskManager.notifier.show("Error", error.message, "danger");
        if (statusSpan) {
          statusSpan.textContent = "Error starting task";
        }
        if (openFetchAllMissingModalBtn) {
          openFetchAllMissingModalBtn.disabled = false;
        }
      }
    });
  }
}

/**
 * Main initialization function
 */
function init() {
  // Create TaskManager instance
  const taskManager = new TaskManager();
  window.taskManager = taskManager;

  // Setup all event listeners and modules
  setupTaskConfigEventListeners(taskManager);
  setupManualFetchTripsForm(taskManager);
  setupGeocodeTrips();
  setupRemapMatchedTrips();
  setupFetchAllMissingModal(taskManager);

  // Initialize mobile UI
  initMobileUI(taskManager);

  // Initialize app settings (tabs, preferences)
  initAppSettings();

  // Initialize InvalidTripReview
  new InvalidTripReview();

  // Load initial task config
  taskManager.loadTaskConfig();

  // Cleanup on page unload
  window.addEventListener("beforeunload", () => {
    if (window.taskManager) {
      window.taskManager.cleanup();
    }
  });

  document.addEventListener(
    "es:page-unload",
    () => {
      if (window.taskManager) {
        window.taskManager.cleanup();
      }
    },
    { once: true },
  );
}

window.utils?.onPageLoad(init, { route: "/settings" });
