/**
 * Task Manager API
 * Handles all API calls related to task management
 */

import apiClient from "../../modules/api-client.js";
import { API_ENDPOINTS } from "./constants.js";
import { getStatusHTML } from "./formatters.js";
import { showDependencyErrorModal } from "./modals.js";

/**
 * Fetch task configuration from the server
 * @returns {Promise<Object>} Task configuration object
 * @throws {Error} If the request fails
 */
export async function fetchTaskConfig() {
  return apiClient.get(API_ENDPOINTS.CONFIG);
}

/**
 * Fetch task history with pagination
 * @param {number} page - Current page number
 * @param {number} limit - Number of items per page
 * @returns {Promise<Object>} History data with pagination info
 * @throws {Error} If the request fails
 */
export async function fetchTaskHistory(page, limit) {
  return apiClient.get(`${API_ENDPOINTS.HISTORY}?page=${page}&limit=${limit}`);
}

/**
 * Submit updated task configuration to the server
 * @param {Object} config - Task configuration to save
 * @returns {Promise<Object>} Server response
 * @throws {Error} If the request fails
 */
export async function submitTaskConfigUpdate(config) {
  return apiClient.post(API_ENDPOINTS.CONFIG, config);
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
    window.loadingManager?.show();

    const result = await apiClient.post(API_ENDPOINTS.RUN, { task_id: taskId });

    window.loadingManager?.hide();

    if (result.status === "success") {
      if (result.results?.length > 0) {
        const taskResult = result.results.find((r) => r.task === taskId);

        if (taskResult && !taskResult.success) {
          showDependencyErrorModal(taskResult.message);
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
    window.loadingManager?.hide();
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

  if (!taskId) {
    return false;
  }

  let confirmed = true;
  const confirmMessage = `Force stop task ${taskId}? This will reset its status.`;

  if (
    window.confirmationDialog
    && typeof window.confirmationDialog.show === "function"
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

  if (!confirmed) {
    return false;
  }

  try {
    window.loadingManager?.show();
    const data = await apiClient.post(API_ENDPOINTS.FORCE_STOP, { task_id: taskId });
    window.loadingManager?.hide();

    const message = data.message || `Task ${taskId} has been reset.`;
    notifier.show("Task Reset", message, "warning");

    if (onSuccess) {
      await onSuccess();
    }

    return true;
  } catch (error) {
    window.loadingManager?.hide();
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
    window.loadingManager?.show();
    const result = await apiClient.post(API_ENDPOINTS.FETCH_TRIPS_RANGE, {
      start_date: startIso,
      end_date: endIso,
      map_match: mapMatch,
    });
    window.loadingManager?.hide();

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
    window.loadingManager?.hide();
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
  return apiClient.get(`${API_ENDPOINTS.DETAILS}/${taskId}`);
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
    window.confirmationDialog
    && typeof window.confirmationDialog.show === "function"
  ) {
    confirmed = await window.confirmationDialog.show({
      title: "Clear Task History",
      message:
        "Are you sure you want to clear all task history? This cannot be undone.",
      confirmLabel: "Clear History",
      confirmVariant: "danger",
    });
  }

  if (!confirmed) {
    return false;
  }

  try {
    window.loadingManager?.show();
    await apiClient.delete(API_ENDPOINTS.HISTORY);
    window.loadingManager?.hide();

    notifier.show("Success", "Task history cleared", "success");

    if (onSuccess) {
      await onSuccess();
    }

    return true;
  } catch (error) {
    window.loadingManager?.hide();
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
    if (!taskId) {
      return;
    }

    const intervalSelect = row.querySelector(`select[data-task-id="${taskId}"]`);
    const enabledCheckbox = row.querySelector(`input[data-task-id="${taskId}"]`);

    config.tasks[taskId] = {
      interval_minutes: intervalSelect ? parseInt(intervalSelect.value, 10) : null,
      enabled: enabledCheckbox ? enabledCheckbox.checked : true,
    };
  });

  return config;
}
