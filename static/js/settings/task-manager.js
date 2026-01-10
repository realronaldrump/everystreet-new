/**
 * Task Manager - Re-exports from modular task-manager directory
 *
 * This file provides backward compatibility for existing imports.
 * All functionality has been refactored into smaller, more organized modules
 * located in the task-manager/ directory.
 *
 * @module settings/task-manager
 */

// Re-export the TaskManager class from the modular implementation
// Also re-export utility functions for direct access if needed
export {
  API_ENDPOINTS,
  // Formatters
  escapeHtml,
  formatDateTime,
  formatDuration,
  getStatusColor,
  getStatusHTML,
  HISTORY_DEFAULTS,
  // Constants
  INTERVAL_OPTIONS,
  POLLING_INTERVALS,
  STATUS_COLORS,
  showDependencyErrorModal,
  // Modal functions
  showErrorModal,
  showTaskDetails,
  TaskManager,
} from "./task-manager/index.js";
