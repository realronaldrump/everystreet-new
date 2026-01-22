/**
 * Task Manager Formatters
 * Task-specific formatting utilities
 *
 * Common formatters are imported from the central formatters module.
 */

import { escapeHtml, formatDateTime, formatDurationMs } from "../../modules/utils.js";
import { STATUS_COLORS } from "./constants.js";

export { escapeHtml, formatDateTime, formatDurationMs };
/**
 * Get the Bootstrap color class for a task status
 * @param {string} status - Task status
 * @returns {string} Bootstrap color name
 */
export function getStatusColor(status) {
  return STATUS_COLORS[status] || "secondary";
}

/**
 * Generate HTML for a task status badge/indicator
 * @param {string} status - Task status
 * @returns {string} HTML string for status display
 */
export function getStatusHTML(status) {
  const color = getStatusColor(status);

  if (status === "RUNNING") {
    return `
      <div class="d-flex align-items-center">
        <div class="spinner-border spinner-border-sm me-2" role="status">
          <span class="visually-hidden">Running...</span>
        </div>
        <span class="status-text">Running</span>
      </div>
    `;
  }
  if (status === "PENDING") {
    return `
      <div class="d-flex align-items-center">
        <div class="spinner-border spinner-border-sm me-2" role="status">
          <span class="visually-hidden">Queued...</span>
        </div>
        <span class="status-text">Queued</span>
      </div>
    `;
  }

  return `<span class="badge bg-${color}">${status}</span>`;
}
