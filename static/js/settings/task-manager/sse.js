/**
 * Task Manager SSE (Server-Sent Events)
 * Handles real-time task updates via SSE and fallback polling
 */

import { API_ENDPOINTS, POLLING_INTERVALS } from "./constants.js";
import { getStatusHTML } from "./formatters.js";

/**
 * Create and setup an EventSource connection for task updates
 * @param {Object} callbacks - Callback functions for handling events
 * @param {Function} callbacks.onUpdate - Called with parsed update data
 * @param {Function} callbacks.onError - Called when connection error occurs
 * @param {Function} callbacks.onReconnect - Called before attempting reconnection
 * @returns {EventSource|null} The EventSource instance or null on failure
 */
export function createEventSource(callbacks) {
  const { onUpdate, onError, onReconnect } = callbacks;

  try {
    const eventSource = new EventSource(API_ENDPOINTS.SSE);

    eventSource.onmessage = (event) => {
      try {
        const updates = JSON.parse(event.data);
        if (onUpdate) {
          onUpdate(updates);
        }
      } catch (error) {
        console.error("Error processing SSE update:", error);
      }
    };

    eventSource.onerror = (error) => {
      console.error("SSE connection error:", error);
      if (onError) {
        onError(error);
      }
      setTimeout(() => {
        if (onReconnect) {
          onReconnect();
        }
      }, POLLING_INTERVALS.SSE_RECONNECT);
    };

    return eventSource;
  } catch (error) {
    console.error("Error setting up EventSource:", error);
    return null;
  }
}

/**
 * Process SSE updates and apply them to the DOM
 * @param {Object} updates - Updates keyed by taskId
 * @param {Object} context - Context object with notifier and activeTasksMap
 */
export function processSSEUpdates(updates, context) {
  const { notifier } = context;

  Object.entries(updates).forEach(([taskId, update]) => {
    const row = document.querySelector(`tr[data-task-id="${taskId}"]`);
    if (!row) return;

    const statusCell = row.querySelector(".task-status");
    if (statusCell) {
      const currentStatus = statusCell.dataset.status;
      const newStatus = update.status;

      if (currentStatus !== newStatus) {
        statusCell.innerHTML = getStatusHTML(newStatus);
        statusCell.dataset.status = newStatus;

        const runButton = row.querySelector(".run-now-btn");
        if (runButton) {
          const manualOnly = row.dataset.manualOnly === "true";
          runButton.disabled = manualOnly || newStatus === "RUNNING";
          runButton.title = manualOnly
            ? "Use the manual fetch form below"
            : "Run task now";
        }

        const forceButton = row.querySelector(".force-stop-btn");
        if (forceButton) {
          forceButton.disabled = !["RUNNING", "PENDING"].includes(newStatus);
        }

        // Notify on task completion/failure
        if (
          currentStatus === "RUNNING" &&
          (newStatus === "COMPLETED" || newStatus === "FAILED")
        ) {
          const taskName = row.querySelector(".task-name-display").textContent;
          const notificationType =
            newStatus === "COMPLETED" ? "success" : "danger";
          const message =
            newStatus === "COMPLETED"
              ? `Task ${taskName} completed successfully`
              : `Task ${taskName} failed: ${update.last_error || "Unknown error"}`;

          notifier.show(
            newStatus === "COMPLETED" ? "Success" : "Error",
            message,
            notificationType,
          );
        }
      }
    }

    // Update last run time
    const lastRunCell = row.querySelector(".task-last-run");
    if (lastRunCell && update.last_run) {
      const d = new Date(update.last_run);
      lastRunCell.textContent = d.toLocaleString();
    }

    // Update next run time
    const nextRunCell = row.querySelector(".task-next-run");
    if (nextRunCell && update.next_run) {
      const d = new Date(update.next_run);
      nextRunCell.textContent = d.toLocaleString();
    }
  });
}

/**
 * Update the active tasks map from SSE updates
 * @param {Object} updates - Updates keyed by taskId
 * @param {Map} activeTasksMap - Map tracking active task states
 * @param {Object} notifier - Notifier for showing messages
 */
export function updateActiveTasksMapFromSSE(updates, activeTasksMap, notifier) {
  const runningTasks = new Set();

  for (const [taskId, taskData] of Object.entries(updates)) {
    if (taskData.status === "RUNNING") {
      runningTasks.add(taskId);
      if (!activeTasksMap.has(taskId)) {
        activeTasksMap.set(taskId, {
          status: "RUNNING",
          startTime: new Date(),
        });

        const row = document.querySelector(`tr[data-task-id="${taskId}"]`);
        if (row) {
          const displayName =
            row.querySelector(".task-name-display")?.textContent || taskId;
          notifier.show(
            "Task Started",
            `Task ${displayName} is now running`,
            "info",
          );
        }
      }
    }
  }

  // Check for tasks that have finished
  for (const [taskId, taskState] of activeTasksMap.entries()) {
    if (!runningTasks.has(taskId) && updates[taskId]) {
      const taskStatus = updates[taskId].status;
      if (taskStatus !== "RUNNING") {
        if (taskState.status === "RUNNING") {
          const row = document.querySelector(`tr[data-task-id="${taskId}"]`);
          if (row) {
            const displayName =
              row.querySelector(".task-name-display")?.textContent || taskId;
            if (taskStatus === "COMPLETED" || taskStatus === "FAILED") {
              const type = taskStatus === "COMPLETED" ? "success" : "danger";
              const runTime = Math.round(
                (Date.now() - taskState.startTime) / 1000,
              );
              const message =
                taskStatus === "COMPLETED"
                  ? `Task ${displayName} completed successfully in ${runTime}s`
                  : `Task ${displayName} failed: ${updates[taskId].last_error || "Unknown error"}`;

              notifier.show(taskStatus, message, type);
            }
          }
        }

        activeTasksMap.delete(taskId);
      }
    }
  }
}

/**
 * Update the active tasks map from config polling
 * @param {Object} config - Full config object with tasks
 * @param {Map} activeTasksMap - Map tracking active task states
 * @param {Object} notifier - Notifier for showing messages
 */
export function updateActiveTasksMapFromConfig(
  config,
  activeTasksMap,
  notifier,
) {
  const runningTasks = new Set();

  for (const [taskId, taskConfig] of Object.entries(config.tasks)) {
    if (taskConfig.status === "RUNNING") {
      runningTasks.add(taskId);
      if (!activeTasksMap.has(taskId)) {
        activeTasksMap.set(taskId, {
          status: "RUNNING",
          startTime: new Date(),
        });
      }
    }
  }

  const recentlyFinished = [];
  for (const [taskId] of activeTasksMap.entries()) {
    if (!runningTasks.has(taskId)) {
      recentlyFinished.push(taskId);
    }
  }

  for (const taskId of recentlyFinished) {
    const displayName = config.tasks[taskId]?.display_name || taskId;
    const status = config.tasks[taskId]?.status || "COMPLETED";

    if (
      activeTasksMap.get(taskId).status === "RUNNING" &&
      (status === "COMPLETED" || status === "FAILED")
    ) {
      const type = status === "COMPLETED" ? "success" : "danger";
      const runTime = Math.round(
        (Date.now() - activeTasksMap.get(taskId).startTime) / 1000,
      );
      const message =
        status === "COMPLETED"
          ? `Task ${displayName} completed successfully in ${runTime}s`
          : `Task ${displayName} failed: ${config.tasks[taskId]?.last_error || "Unknown error"}`;

      notifier.show(status, message, type);
    }

    activeTasksMap.delete(taskId);
  }
}

/**
 * Get the appropriate polling interval based on SSE connection state
 * @param {EventSource|null} eventSource - The EventSource instance
 * @returns {number} Polling interval in milliseconds
 */
export function getPollingInterval(eventSource) {
  return eventSource?.readyState === EventSource.OPEN
    ? POLLING_INTERVALS.SSE_CONNECTED
    : POLLING_INTERVALS.SSE_DISCONNECTED;
}
