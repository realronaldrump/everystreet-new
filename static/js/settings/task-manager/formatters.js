/**
 * Task Manager Formatters
 * Task-specific formatting utilities
 *
 * Common formatters are imported from the central formatters module.
 */

import {
  escapeHtml as baseEscapeHtml,
  formatDateTime as baseFormatDateTime,
  formatDurationMs,
} from "../../modules/formatters.js";
import { STATUS_COLORS } from "./constants.js";

// Re-export base functions for backward compatibility
export const escapeHtml = baseEscapeHtml;
export const formatDateTime = baseFormatDateTime;

/**
 * Format a duration in milliseconds for display
 * Wraps the central formatDurationMs for backward compatibility
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration string (e.g., "1h 30m", "45m 30s", "30s")
 */
export function formatDuration(ms) {
  return formatDurationMs(ms);
}

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

  return `<span class="badge bg-${color}">${status}</span>`;
}
