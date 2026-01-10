/**
 * Progress Polling Module
 * Handles polling for task progress updates
 */

import COVERAGE_API from "../coverage-api.js";
import { POLLING_CONFIG, STATUS } from "./constants.js";
import { formatStageName } from "./formatters.js";

/**
 * Calculate polling interval based on stage and retry count
 */
export function calculatePollInterval(stage, retries) {
  const baseInterval = POLLING_CONFIG.BASE_INTERVAL;

  if (stage === STATUS.PROCESSING_TRIPS || stage === STATUS.CALCULATING) {
    return Math.min(baseInterval * 2, 15000);
  }

  if (retries > 100) {
    return Math.min(baseInterval * 3, POLLING_CONFIG.MAX_INTERVAL);
  }

  return baseInterval;
}

/**
 * ProgressPoller class handles polling for task progress
 */
export class ProgressPoller {
  constructor(notificationManager) {
    this.notificationManager = notificationManager;
    this.activeTaskIds = new Set();
    this.lastPollInterval = null;
  }

  /**
   * Check if a task is active
   */
  isTaskActive(taskId) {
    return this.activeTaskIds.has(taskId);
  }

  /**
   * Add a task to active tracking
   */
  addActiveTask(taskId) {
    this.activeTaskIds.add(taskId);
  }

  /**
   * Remove a task from active tracking
   */
  removeActiveTask(taskId) {
    this.activeTaskIds.delete(taskId);
  }

  /**
   * Poll for task progress
   * @param {string} taskId - The task ID to poll
   * @param {object} callbacks - Callback functions for progress updates
   * @param {Function} callbacks.onUpdate - Called on each progress update
   * @param {Function} callbacks.onComplete - Called when task completes
   * @param {Function} callbacks.onError - Called when task returns error status
   * @param {Function} callbacks.onPollingError - Called when polling itself fails (network, etc.)
   * @param {Function} callbacks.onCancel - Called when task is canceled
   * @param {Function} callbacks.onTimeout - Called when polling times out
   */
  async poll(taskId, callbacks = {}) {
    const {
      onUpdate = () => {},
      onComplete = () => {},
      onError = () => {},
      onPollingError = () => {},
      onCancel = () => {},
      onTimeout = () => {},
    } = callbacks;

    let retries = 0;
    let initial404Count = 0;
    let lastStage = null;
    let consecutiveSameStage = 0;

    // Add task to active set
    this.addActiveTask(taskId);

    // Small initial delay to give the backend task time to start
    await new Promise((resolve) => setTimeout(resolve, POLLING_CONFIG.INITIAL_DELAY));

    while (retries < POLLING_CONFIG.MAX_RETRIES) {
      // Check if task was canceled
      if (!this.isTaskActive(taskId)) {
        this.notificationManager.show(
          `Polling stopped for task ${taskId.substring(0, 8)}...`,
          "info"
        );
        throw new Error("Polling canceled");
      }

      try {
        const data = await COVERAGE_API.getTaskProgress(taskId);

        // Reset 404 counter on successful response
        initial404Count = 0;

        // Notify of update
        onUpdate(data);

        // Check for completion states
        if (data.stage === STATUS.COMPLETE || data.stage === STATUS.COMPLETED) {
          this.removeActiveTask(taskId);
          onComplete(data);
          return data;
        } else if (data.stage === STATUS.ERROR) {
          const errorMessage = data.error || data.message || "Unknown error";
          this.notificationManager.show(`Task failed: ${errorMessage}`, "danger");
          this.removeActiveTask(taskId);
          onError(data);
          throw new Error(data.error || data.message || "Coverage calculation failed");
        } else if (data.stage === STATUS.CANCELED) {
          this.notificationManager.show("Task was canceled.", "warning");
          this.removeActiveTask(taskId);
          onCancel(data);
          throw new Error("Task was canceled");
        }

        // Track stalls
        if (data.stage === lastStage) {
          consecutiveSameStage++;
          if (consecutiveSameStage > 12 && consecutiveSameStage % 24 === 0) {
            console.warn(`Task appears stalled at: ${formatStageName(data.stage)}`);
          }
        } else {
          lastStage = data.stage;
          consecutiveSameStage = 0;
        }

        // Wait before next poll
        const pollInterval = calculatePollInterval(data.stage, retries);
        this.lastPollInterval = pollInterval;
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        retries++;
      } catch (error) {
        // Handle 404 gracefully during initial polling - the task may still be starting
        const is404 = error.message?.includes("Task not found");
        if (is404 && initial404Count < POLLING_CONFIG.MAX_INITIAL_404_RETRIES) {
          initial404Count++;
          console.log(
            `Task ${taskId.substring(0, 8)}... not ready yet (attempt ${initial404Count}/${POLLING_CONFIG.MAX_INITIAL_404_RETRIES}), retrying...`
          );
          // Wait a bit longer for the task to initialize
          await new Promise((resolve) => setTimeout(resolve, 1000));
          retries++;
          continue;
        }

        // For non-404 errors or after max 404 retries, handle error
        this.notificationManager.show(
          `Error polling progress: ${error.message}`,
          "danger"
        );
        this.removeActiveTask(taskId);
        onPollingError({
          stage: STATUS.ERROR,
          progress: 0,
          message: `Polling failed: ${error.message}`,
          error: error.message,
          metrics: {},
          taskId,
        });
        throw error;
      }
    }

    // Timeout
    this.notificationManager.show(
      `Polling timed out after ${Math.round(
        (POLLING_CONFIG.MAX_RETRIES *
          calculatePollInterval(STATUS.UNKNOWN, POLLING_CONFIG.MAX_RETRIES - 1)) /
          60000
      )} minutes.`,
      "danger"
    );
    this.removeActiveTask(taskId);
    onTimeout({
      stage: STATUS.ERROR,
      progress: 99,
      message: "Polling timed out waiting for completion.",
      error: "Polling timed out",
      metrics: {},
    });
    throw new Error("Coverage calculation polling timed out");
  }

  /**
   * Cancel polling for a task
   */
  cancelPolling(taskId) {
    this.removeActiveTask(taskId);
  }

  /**
   * Cancel all active polling
   */
  cancelAllPolling() {
    this.activeTaskIds.clear();
  }
}
