/**
 * TaskManager - Main class that orchestrates background task management
 *
 * This is the primary entry point for the task manager functionality.
 * It coordinates SSE updates, polling, and UI rendering by delegating
 * to specialized modules.
 */

import {
  clearTaskHistory as apiClearTaskHistory,
  forceStopTask as apiForceStopTask,
  runTask as apiRunTask,
  scheduleManualFetch as apiScheduleManualFetch,
  fetchTaskConfig,
  fetchTaskHistory,
} from "./api.js";
import {
  HISTORY_DEFAULTS,
  INTERVAL_OPTIONS,
  POLLING_INTERVALS,
} from "./constants.js";
import {
  renderHistoryPagination,
  renderTaskHistoryTable,
  updateRunningTaskDurations,
} from "./history.js";
import {
  createEventSource,
  getPollingInterval,
  processSSEUpdates,
  updateActiveTasksMapFromConfig,
  updateActiveTasksMapFromSSE,
} from "./sse.js";
import { renderTaskConfigTable, updateGlobalDisableSwitch } from "./ui.js";

/**
 * TaskManager - Handles background task management, SSE updates, and UI rendering
 */
export class TaskManager {
  constructor() {
    this.notifier = {
      show: (title, message, type = "info") => {
        window.notificationManager.show(`${title}: ${message}`, type);
      },
    };

    this.activeTasksMap = new Map();
    this.intervalOptions = INTERVAL_OPTIONS;
    this.currentHistoryPage = HISTORY_DEFAULTS.PAGE;
    this.historyLimit = HISTORY_DEFAULTS.LIMIT;
    this.historyTotalPages = 1;
    this.pollingInterval = null;
    this.configRefreshTimeout = null;
    this.eventSource = null;
    this.durationUpdateInterval = null;

    this.setupEventSource();
    this.setupPolling();
    this.setupDurationUpdates();
  }

  /**
   * Setup SSE connection for real-time task updates
   */
  setupEventSource() {
    if (this.eventSource) {
      this.eventSource.close();
    }

    this.eventSource = createEventSource({
      onUpdate: (updates) => {
        processSSEUpdates(updates, { notifier: this.notifier });
        this.updateActiveTasksMapFromUpdates(updates);
      },
      onError: () => {},
      onReconnect: () => {
        this.setupEventSource();
      },
    });

    if (!this.eventSource) {
      this.setupPolling();
    }
  }

  /**
   * Update active tasks map from SSE updates
   * @param {Object} updates - Task updates keyed by taskId
   */
  updateActiveTasksMapFromUpdates(updates) {
    updateActiveTasksMapFromSSE(updates, this.activeTasksMap, this.notifier);
  }

  /**
   * Setup polling interval for config updates
   */
  setupPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    const pollInterval = getPollingInterval(this.eventSource);

    this.pollingInterval = setInterval(() => {
      this.loadTaskConfig();
      this.updateTaskHistory();
    }, pollInterval);
  }

  /**
   * Load task configuration from the server
   */
  async loadTaskConfig() {
    try {
      const config = await fetchTaskConfig();

      updateGlobalDisableSwitch(config.disabled);
      this.updateTaskConfigTable(config);
      this.updateActiveTasksMap(config);
      await this.updateTaskHistory();
    } catch (error) {
      this.notifier.show(
        "Error",
        `Failed to load task configuration: ${error.message}`,
        "danger",
      );
    }
  }

  /**
   * Update active tasks map from config
   * @param {Object} config - Task configuration
   */
  updateActiveTasksMap(config) {
    updateActiveTasksMapFromConfig(config, this.activeTasksMap, this.notifier);
  }

  /**
   * Update the task configuration table
   * @param {Object} config - Task configuration
   */
  updateTaskConfigTable(config) {
    renderTaskConfigTable(config, this.intervalOptions);
  }

  /**
   * Update task history table
   */
  async updateTaskHistory() {
    try {
      const data = await fetchTaskHistory(
        this.currentHistoryPage,
        this.historyLimit,
      );
      this.historyTotalPages = data.total_pages;
      this.updateTaskHistoryTable(data.history);
      this.updateHistoryPagination();
    } catch (error) {
      this.notifier.show(
        "Error",
        `Failed to update task history: ${error.message}`,
        "danger",
      );
    }
  }

  /**
   * Setup interval to update running task durations
   */
  setupDurationUpdates() {
    if (this.durationUpdateInterval) {
      clearInterval(this.durationUpdateInterval);
    }
    this.durationUpdateInterval = setInterval(() => {
      updateRunningTaskDurations();
    }, POLLING_INTERVALS.DURATION_UPDATE);
  }

  /**
   * Update history pagination controls
   */
  updateHistoryPagination() {
    renderHistoryPagination(
      this.currentHistoryPage,
      this.historyTotalPages,
      (page) => {
        this.currentHistoryPage = page;
        this.updateTaskHistory();
      },
    );
  }

  /**
   * Update task history table (default desktop view)
   * @param {Array} history - History entries
   */
  updateTaskHistoryTable(history) {
    renderTaskHistoryTable(history);
  }

  /**
   * Run a specific task
   * @param {string} taskId - ID of the task to run
   * @returns {Promise<boolean>} True if task started successfully
   */
  async runTask(taskId) {
    return apiRunTask(
      taskId,
      { notifier: this.notifier, activeTasksMap: this.activeTasksMap },
      () => this.loadTaskConfig(),
    );
  }

  /**
   * Force stop a running task
   * @param {string} taskId - ID of the task to stop
   * @returns {Promise<boolean>} True if task stopped successfully
   */
  async forceStopTask(taskId) {
    return apiForceStopTask(taskId, { notifier: this.notifier }, () =>
      this.loadTaskConfig(),
    );
  }

  /**
   * Schedule a manual trip fetch
   * @param {string} startIso - Start date in ISO format
   * @param {string} endIso - End date in ISO format
   * @param {boolean} mapMatch - Whether to map match the trips
   * @returns {Promise<boolean>} True if fetch scheduled successfully
   */
  async scheduleManualFetch(startIso, endIso, mapMatch) {
    return apiScheduleManualFetch(
      startIso,
      endIso,
      mapMatch,
      { notifier: this.notifier },
      () => this.loadTaskConfig(),
    );
  }

  /**
   * Clear all task history
   */
  async clearTaskHistory() {
    return apiClearTaskHistory({ notifier: this.notifier }, async () => {
      this.currentHistoryPage = 1;
      await this.updateTaskHistory();
    });
  }

  /**
   * Cleanup all intervals and connections
   */
  cleanup() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    if (this.configRefreshTimeout) {
      clearTimeout(this.configRefreshTimeout);
      this.configRefreshTimeout = null;
    }
    if (this.durationUpdateInterval) {
      clearInterval(this.durationUpdateInterval);
      this.durationUpdateInterval = null;
    }
  }
}
