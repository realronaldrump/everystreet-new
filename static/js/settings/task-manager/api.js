/* global showLoadingOverlay, hideLoadingOverlay */

/**
 * Task Manager API
 * Handles all API calls related to task management
 */

import { API_ENDPOINTS } from "./constants.js";
import { getStatusHTML } from "./formatters.js";
import { showDependencyErrorModal } from "./modals.js";

/**
 * Fetch task configuration from the server
 * @returns {Promise<Object>} Task configuration object
 * @throws {Error} If the request fails
 */
export async function fetchTaskConfig() {
  const response = await fetch(API_ENDPOINTS.CONFIG);
  if (!response.ok) {
    throw new Error("Failed to load task configuration");
  }
  return response.json();
}

/**
 * Fetch task history with pagination
 * @param {number} page - Current page number
 * @param {number} limit - Number of items per page
 * @returns {Promise<Object>} History data with pagination info
 * @throws {Error} If the request fails
 */
export async function fetchTaskHistory(page, limit) {
  const response = await fetch(`${API_ENDPOINTS.HISTORY}?page=${page}&limit=${limit}`);
  if (!response.ok) {
    throw new Error("Failed to fetch task history");
  }
  return response.json();
}

/**
 * Submit updated task configuration to the server
 * @param {Object} config - Task configuration to save
 * @returns {Promise<Object>} Server response
 * @throws {Error} If the request fails
 */
export async function submitTaskConfigUpdate(config) {
  const response = await fetch(API_ENDPOINTS.CONFIG, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });

  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.detail || "Failed to update configuration");
  }

  return response.json();
}

/**
 * Run a specific task
 * @param {string} taskId - ID of the task to run
 * @param {Object} context - Context object with notifier and activeTasksMap
 * @param {Function} onSuccess - Callback on successful task start
 * @returns {Promise<boolean>} True if task started successfully
 */
export async function runTask(taskId, context, onSuccess) {
  const { notifier, activeTasksMap } = context;

  try {
    showLoadingOverlay();

    const response = await fetch(API_ENDPOINTS.RUN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([taskId]),
    });

    const result = await response.json();

    hideLoadingOverlay();

    if (!response.ok) {
      throw new Error(result.detail || "Failed to start task");
    }

    if (result.status === "success") {
      if (result.results?.length > 0) {
        const taskResult = result.results.find((r) => r.task === taskId);

        if (taskResult && !taskResult.success) {
          showDependencyErrorModal(taskId, taskResult.message);
          return false;
        }
      }

      activeTasksMap.set(taskId, {
        status: "RUNNING",
        startTime: new Date(),
      });

      notifier.show("Task Started", `Task ${taskId} has been started`, "info");

      // Update UI immediately
      const row = document.querySelector(`tr[data-task-id="${taskId}"]`);
      if (row) {
        const statusCell = row.querySelector(".task-status");
        if (statusCell) {
          statusCell.innerHTML = getStatusHTML("RUNNING");
          statusCell.dataset.status = "RUNNING";
        }

        const runButton = row.querySelector(".run-now-btn");
        if (runButton) {
          runButton.disabled = true;
        }
      }

      if (onSuccess) {
        await onSuccess();
      }

      return true;
    }
    throw new Error(result.message || "Failed to start task");
  } catch (error) {
    console.error(`Error running task ${taskId}:`, error);
    hideLoadingOverlay();
    notifier.show(
      "Error",
      `Failed to start task ${taskId}: ${error.message}`,
      "danger"
    );
    return false;
  }
}

/**
 * Force stop a running task
 * @param {string} taskId - ID of the task to stop
 * @param {Object} context - Context object with notifier
 * @param {Function} onSuccess - Callback on successful stop
 * @returns {Promise<boolean>} True if task stopped successfully
 */
export async function forceStopTask(taskId, context, onSuccess) {
  const { notifier } = context;

  if (!taskId) return false;

  let confirmed = true;
  const confirmMessage = `Force stop task ${taskId}? This will reset its status.`;

  if (
    window.confirmationDialog &&
    typeof window.confirmationDialog.show === "function"
  ) {
    confirmed = await window.confirmationDialog.show({
      title: "Force Stop Task",
      message: confirmMessage,
      confirmLabel: "Force Stop",
      confirmVariant: "danger",
    });
  } else {
    confirmed = await window.confirmationDialog.show({
      title: "Confirm Action",
      message: confirmMessage,
      confirmText: "Yes",
      confirmButtonClass: "btn-primary",
    });
  }

  if (!confirmed) return false;

  try {
    showLoadingOverlay();
    const response = await fetch(API_ENDPOINTS.FORCE_STOP, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: taskId }),
    });

    const data = await response.json();
    hideLoadingOverlay();

    if (!response.ok) {
      throw new Error(data.detail || data.message || "Failed to force stop task");
    }

    const message = data.message || `Task ${taskId} has been reset.`;
    notifier.show("Task Reset", message, "warning");

    if (onSuccess) {
      await onSuccess();
    }

    return true;
  } catch (error) {
    hideLoadingOverlay();
    console.error(`Error force stopping task ${taskId}:`, error);
    notifier.show(
      "Error",
      `Failed to force stop task ${taskId}: ${error.message}`,
      "danger"
    );
    return false;
  }
}

/**
 * Schedule a manual trip fetch for a date range
 * @param {string} startIso - Start date in ISO format
 * @param {string} endIso - End date in ISO format
 * @param {boolean} mapMatch - Whether to map match the trips
 * @param {Object} context - Context object with notifier
 * @param {Function} onSuccess - Callback on successful scheduling
 * @returns {Promise<boolean>} True if fetch scheduled successfully
 */
export async function scheduleManualFetch(
  startIso,
  endIso,
  mapMatch,
  context,
  onSuccess
) {
  const { notifier } = context;

  try {
    showLoadingOverlay();
    const response = await fetch(API_ENDPOINTS.FETCH_TRIPS_RANGE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        start_date: startIso,
        end_date: endIso,
        map_match: mapMatch,
      }),
    });

    const result = await response.json();
    hideLoadingOverlay();

    if (!response.ok) {
      throw new Error(result.detail || result.message || "Failed to schedule fetch");
    }

    notifier.show(
      "Success",
      result.message || "Fetch scheduled successfully",
      "success"
    );

    if (onSuccess) {
      await onSuccess();
    }

    return true;
  } catch (error) {
    hideLoadingOverlay();
    console.error("Error scheduling manual fetch:", error);
    notifier.show("Error", `Failed to schedule fetch: ${error.message}`, "danger");
    throw error;
  }
}

/**
 * Fetch detailed information about a specific task
 * @param {string} taskId - ID of the task
 * @returns {Promise<Object>} Task details
 * @throws {Error} If the request fails
 */
export async function fetchTaskDetails(taskId) {
  const response = await fetch(`${API_ENDPOINTS.DETAILS}/${taskId}`);
  if (!response.ok) {
    throw new Error("Failed to fetch task details");
  }
  return response.json();
}

/**
 * Clear all task history
 * @param {Object} context - Context object with notifier
 * @param {Function} onSuccess - Callback on successful clear
 * @returns {Promise<boolean>} True if history cleared successfully
 */
export async function clearTaskHistory(context, onSuccess) {
  const { notifier } = context;

  let confirmed = true;

  if (
    window.confirmationDialog &&
    typeof window.confirmationDialog.show === "function"
  ) {
    confirmed = await window.confirmationDialog.show({
      title: "Clear Task History",
      message:
        "Are you sure you want to clear all task history? This cannot be undone.",
      confirmLabel: "Clear History",
      confirmVariant: "danger",
    });
  }

  if (!confirmed) return false;

  try {
    showLoadingOverlay();
    const response = await fetch(API_ENDPOINTS.HISTORY, {
      method: "DELETE",
    });

    hideLoadingOverlay();

    if (!response.ok) {
      throw new Error("Failed to clear history");
    }

    notifier.show("Success", "Task history cleared", "success");

    if (onSuccess) {
      await onSuccess();
    }

    return true;
  } catch (error) {
    hideLoadingOverlay();
    console.error("Error clearing task history:", error);
    notifier.show("Error", `Failed to clear history: ${error.message}`, "danger");
    return false;
  }
}

/**
 * Gather task configuration from the UI form elements
 * @returns {Object} Task configuration object
 */
export function gatherTaskConfigFromUI() {
  const config = { tasks: {} };
  const globalSwitch = document.getElementById("globalDisableSwitch");
  config.disabled = globalSwitch?.checked || false;

  document.querySelectorAll("#taskConfigTable tbody tr").forEach((row) => {
    const { taskId } = row.dataset;
    if (!taskId) return;

    const intervalSelect = row.querySelector(`select[data-task-id="${taskId}"]`);
    const enabledCheckbox = row.querySelector(`input[data-task-id="${taskId}"]`);

    config.tasks[taskId] = {
      interval_minutes: intervalSelect ? parseInt(intervalSelect.value, 10) : null,
      enabled: enabledCheckbox ? enabledCheckbox.checked : true,
    };
  });

  return config;
}
