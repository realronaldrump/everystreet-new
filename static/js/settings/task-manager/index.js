/**
 * Task Manager Module Index
 * Re-exports all task manager functionality for convenient imports
 */

// API functions
export {
  clearTaskHistory,
  fetchTaskConfig,
  fetchTaskDetails,
  fetchTaskHistory,
  forceStopTask,
  gatherTaskConfigFromUI,
  runTask,
  scheduleManualFetch,
  submitTaskConfigUpdate,
} from "./api.js";
// Constants
export {
  API_ENDPOINTS,
  HISTORY_DEFAULTS,
  INTERVAL_OPTIONS,
  POLLING_INTERVALS,
  STATUS_COLORS,
} from "./constants.js";
// Formatters
export {
  escapeHtml,
  formatDateTime,
  formatDuration,
  getStatusColor,
  getStatusHTML,
} from "./formatters.js";
// History functions
export {
  renderHistoryPagination,
  renderTaskHistoryTable,
  updateRunningTaskDurations,
} from "./history.js";
// Modal functions
export { showDependencyErrorModal, showErrorModal, showTaskDetails } from "./modals.js";
// SSE functions
export {
  createEventSource,
  getPollingInterval,
  processSSEUpdates,
  updateActiveTasksMapFromConfig,
  updateActiveTasksMapFromSSE,
} from "./sse.js";
// Main TaskManager class
export { TaskManager } from "./task-manager.js";
// UI functions
export { renderTaskConfigTable, updateGlobalDisableSwitch } from "./ui.js";
