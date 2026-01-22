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

import { initDatabaseManagement } from "../database-management.js";
import apiClient from "../modules/core/api-client.js";
import { CONFIG } from "../modules/core/config.js";
import confirmationDialog from "../modules/ui/confirmation-dialog.js";
import loadingManager from "../modules/ui/loading-manager.js";
import notificationManager from "../modules/ui/notifications.js";
import { formatDateTime, onPageLoad } from "../modules/utils.js";
import { initAppSettings } from "./app-settings.js";
import {
  setupGeocodeTrips,
  setupManualFetchTripsForm,
  setupRemapMatchedTrips,
} from "./geocode-remap.js";
import { InvalidTripReview } from "./invalid-trip-review.js";
import mapServices from "./map-services.js";
import { initMobileUI } from "./mobile-ui.js";
import { clearInlineStatus, setInlineStatus } from "./status-utils.js";
import { gatherTaskConfigFromUI, submitTaskConfigUpdate } from "./task-manager/api.js";
import { showTaskDetails } from "./task-manager/modals.js";
import { TaskManager } from "./task-manager/task-manager.js";

let taskManager = null;
const SETTINGS_MODAL_IDS = [
  "addRegionModal",
  "deleteRegionModal",
  "taskDetailsModal",
  "pauseModal",
  "clearHistoryModal",
  "fetchAllMissingModal",
];

function moveSettingsModals() {
  const modalsContainer = document.getElementById("modals-container");
  if (!modalsContainer) {
    return;
  }

  SETTINGS_MODAL_IDS.forEach((id) => {
    const routeModal = document.querySelector(`#route-content #${id}`);
    const modal = routeModal || document.getElementById(id);
    if (!modal) {
      return;
    }

    const existing = modalsContainer.querySelector(`#${id}`);
    if (existing && existing !== modal) {
      existing.remove();
    }
    if (!modalsContainer.contains(modal)) {
      modalsContainer.appendChild(modal);
    }
  });
}

function parseDateInput(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

async function loadSyncSettings() {
  const autoToggle = document.getElementById("sync-auto-toggle");
  const intervalSelect = document.getElementById("sync-interval-select");
  const lastSuccess = document.getElementById("sync-last-success");
  const alertEl = document.getElementById("sync-settings-alert");
  const syncNowBtn = document.getElementById("sync-now-btn");
  const importBtn = document.getElementById("sync-import-btn");

  if (!autoToggle || !intervalSelect) {
    return;
  }

  try {
    const [config, status] = await Promise.all([
      apiClient.get(CONFIG.API.tripSyncConfig),
      apiClient.get(CONFIG.API.tripSyncStatus),
    ]);

    autoToggle.checked = config.auto_sync_enabled !== false;
    const intervalValue = String(config.interval_minutes || 720);
    const options = [...intervalSelect.options].map((opt) => opt.value);
    if (!options.includes(intervalValue)) {
      const option = document.createElement("option");
      option.value = intervalValue;
      option.textContent = `Every ${intervalValue} minutes`;
      intervalSelect.appendChild(option);
    }
    intervalSelect.value = intervalValue;

    if (lastSuccess) {
      lastSuccess.textContent = config.last_success_at
        ? formatDateTime(config.last_success_at)
        : "--";
    }

    if (alertEl) {
      if (["paused", "error"].includes(status.state) && status.error?.message) {
        alertEl.textContent = status.error.message;
        alertEl.classList.remove("d-none");
      } else {
        alertEl.classList.add("d-none");
      }
    }

    const paused = status.state === "paused";
    if (syncNowBtn) {
      syncNowBtn.disabled = paused;
    }
    if (importBtn) {
      importBtn.disabled = paused;
    }
  } catch (error) {
    notificationManager.show(
      `Failed to load sync settings: ${error.message}`,
      "danger"
    );
  }
}

function setupTripSyncSettings() {
  const autoToggle = document.getElementById("sync-auto-toggle");
  const intervalSelect = document.getElementById("sync-interval-select");
  const saveBtn = document.getElementById("sync-settings-save");
  const resetBtn = document.getElementById("sync-settings-reset");
  const syncNowBtn = document.getElementById("sync-now-btn");
  const importBtn = document.getElementById("sync-import-btn");
  const historyStart = document.getElementById("sync-history-start");

  if (!autoToggle || !intervalSelect) {
    return;
  }

  loadSyncSettings();

  if (historyStart && !historyStart.value) {
    historyStart.value = "2020-01-01";
  }

  saveBtn?.addEventListener("click", async () => {
    try {
      const payload = {
        auto_sync_enabled: autoToggle.checked,
        interval_minutes: parseInt(intervalSelect.value, 10),
      };
      await apiClient.post(CONFIG.API.tripSyncConfig, payload);
      notificationManager.show("Sync settings saved", "success");
      await loadSyncSettings();
    } catch (error) {
      notificationManager.show(
        `Failed to save sync settings: ${error.message}`,
        "danger"
      );
    }
  });

  resetBtn?.addEventListener("click", () => {
    autoToggle.checked = true;
    intervalSelect.value = "720";
  });

  syncNowBtn?.addEventListener("click", async () => {
    try {
      await apiClient.post(CONFIG.API.tripSyncStart, { mode: "recent" });
      notificationManager.show("Trip sync started", "info");
    } catch (error) {
      notificationManager.show(error.message, "danger");
    }
  });

  importBtn?.addEventListener("click", async () => {
    const confirmed = await confirmationDialog.show({
      title: "Import trip history",
      message: "This can take a while. You can keep using the app while it runs.",
      confirmText: "Start import",
      confirmButtonClass: "btn-primary",
    });
    if (!confirmed) {
      return;
    }
    const startDate = parseDateInput(historyStart?.value);
    const payload = { mode: "history" };
    if (startDate) {
      payload.start_date = startDate.toISOString();
    }
    try {
      await apiClient.post(CONFIG.API.tripSyncStart, payload);
      notificationManager.show("History import started", "info");
    } catch (error) {
      notificationManager.show(error.message, "danger");
    }
  });
}

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
          notificationManager.show(
            "Task configuration updated successfully",
            "success"
          );
          taskManager.loadTaskConfig();
        })
        .catch((error) => {
          notificationManager.show(
            `Error updating task config: ${error.message}`,
            "danger"
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
        loadingManager.show();
        const response = await apiClient.raw("/api/background_tasks/reset", {
          method: "POST",
        });

        loadingManager.hide();

        if (!response.ok) {
          throw new Error("Failed to reset tasks");
        }

        const result = await response.json();
        notificationManager.show(result.message, "success");
        taskManager.loadTaskConfig();
      } catch {
        loadingManager.hide();
        notificationManager.show("Failed to reset tasks", "danger");
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
        loadingManager.show();
        const response = await apiClient.raw("/api/background_tasks/pause", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ duration: parseInt(duration, 10) }),
        });

        loadingManager.hide();

        if (!response.ok) {
          throw new Error("Failed to pause tasks");
        }

        notificationManager.show(`Tasks paused for ${duration} minutes`, "success");

        const modal = bootstrap.Modal.getInstance(
          document.getElementById("pauseModal")
        );
        if (modal) {
          modal.hide();
        }

        taskManager.loadTaskConfig();
      } catch {
        loadingManager.hide();
        notificationManager.show("Failed to pause tasks", "danger");
      }
    });
  }

  if (resumeBtn) {
    resumeBtn.addEventListener("mousedown", async (e) => {
      if (e.button !== 0) {
        return;
      }
      try {
        loadingManager.show();
        const response = await apiClient.raw("/api/background_tasks/resume", {
          method: "POST",
        });

        loadingManager.hide();

        if (!response.ok) {
          throw new Error("Failed to resume tasks");
        }

        notificationManager.show("Tasks resumed", "success");
        taskManager.loadTaskConfig();
      } catch {
        loadingManager.hide();
        notificationManager.show("Failed to resume tasks", "danger");
      }
    });
  }

  if (stopAllBtn) {
    stopAllBtn.addEventListener("mousedown", async (e) => {
      if (e.button !== 0) {
        return;
      }
      try {
        loadingManager.show();
        const response = await apiClient.raw("/api/background_tasks/stop", {
          method: "POST",
        });

        loadingManager.hide();

        if (!response.ok) {
          throw new Error("Failed to stop tasks");
        }

        notificationManager.show("All running tasks stopped", "success");
        taskManager.loadTaskConfig();
      } catch {
        loadingManager.hide();
        notificationManager.show("Failed to stop tasks", "danger");
      }
    });
  }

  if (enableAllBtn) {
    enableAllBtn.addEventListener("mousedown", async (e) => {
      if (e.button !== 0) {
        return;
      }
      try {
        loadingManager.show();
        const response = await apiClient.raw("/api/background_tasks/enable", {
          method: "POST",
        });

        loadingManager.hide();

        if (!response.ok) {
          throw new Error("Failed to enable all tasks");
        }

        notificationManager.show("All tasks enabled", "success");
        taskManager.loadTaskConfig();
      } catch {
        loadingManager.hide();
        notificationManager.show("Failed to enable tasks", "danger");
      }
    });
  }

  if (disableAllBtn) {
    disableAllBtn.addEventListener("mousedown", async (e) => {
      if (e.button !== 0) {
        return;
      }
      try {
        loadingManager.show();
        const response = await apiClient.raw("/api/background_tasks/disable", {
          method: "POST",
        });

        loadingManager.hide();

        if (!response.ok) {
          throw new Error("Failed to disable all tasks");
        }

        notificationManager.show("All tasks disabled", "success");
        taskManager.loadTaskConfig();
      } catch {
        loadingManager.hide();
        notificationManager.show("Failed to disable tasks", "danger");
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
        .then(() => notificationManager.show("Global disable toggled", "success"))
        .catch(() =>
          notificationManager.show("Failed to toggle global disable", "danger")
        );
    });
  }

  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener("mousedown", (e) => {
      if (e.button !== 0) {
        return;
      }
      const modal = new bootstrap.Modal(document.getElementById("clearHistoryModal"));
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
        document.getElementById("clearHistoryModal")
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
    "openFetchAllMissingModalBtn"
  );
  const confirmFetchAllMissingBtn = document.getElementById("confirmFetchAllMissing");
  const fetchAllMissingStartInput = document.getElementById("fetchAllMissingStart");

  if (openFetchAllMissingModalBtn) {
    openFetchAllMissingModalBtn.addEventListener("click", async () => {
      try {
        const response = await apiClient.raw("/api/trips/earliest_date");
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
        clearInlineStatus(statusSpan);
        setInlineStatus(statusSpan, "Starting task...", "info");

        loadingManager.show();
        const response = await apiClient.raw(
          "/api/background_tasks/fetch_all_missing_trips",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ start_date: startDate }),
          }
        );
        const result = await response.json();
        loadingManager.hide();

        if (response.ok && result.status === "success") {
          taskManager.notifier.show(
            "Success",
            "Fetch all missing trips task started",
            "success"
          );
          setInlineStatus(statusSpan, "Task started!", "success");
          setTimeout(() => {
            clearInlineStatus(statusSpan);
            if (openFetchAllMissingModalBtn) {
              openFetchAllMissingModalBtn.disabled = false;
            }
          }, 3000);
          taskManager.loadTaskConfig();
        } else {
          throw new Error(result.detail || result.message || "Failed to start task");
        }
      } catch (error) {
        loadingManager.hide();
        taskManager.notifier.show("Error", error.message, "danger");
        setInlineStatus(statusSpan, "Error starting task", "danger");
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
function init({ cleanup, signal } = {}) {
  // Keep settings modals outside layout stacking contexts so they remain clickable.
  moveSettingsModals();

  // Create TaskManager instance
  taskManager = new TaskManager();

  // Setup all event listeners and modules
  setupTaskConfigEventListeners(taskManager);
  setupManualFetchTripsForm(taskManager);
  setupGeocodeTrips();
  setupRemapMatchedTrips();
  setupFetchAllMissingModal(taskManager);
  setupTripSyncSettings();

  // Initialize mobile UI
  const mobileCleanup = initMobileUI(taskManager);

  // Initialize app settings (tabs, preferences)
  initAppSettings();

  // Initialize database management tab
  initDatabaseManagement({ signal });

  // Initialize InvalidTripReview
  new InvalidTripReview();

  // Initialize Map Services tab
  mapServices.initMapServicesTab();

  // Load initial task config
  taskManager.loadTaskConfig();

  if (typeof cleanup === "function") {
    cleanup(() => {
      if (typeof mobileCleanup === "function") {
        mobileCleanup();
      }
      if (taskManager) {
        taskManager.cleanup();
      }
      // Cleanup map services
      mapServices.cleanupMapServicesTab();
    });
  }
}

onPageLoad(init, { route: "/settings" });
