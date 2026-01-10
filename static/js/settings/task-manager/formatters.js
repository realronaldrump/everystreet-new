/**
 * Task Manager Formatters
 * Utility functions for formatting task data for display
 */

import { STATUS_COLORS } from "./constants.js";

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
export function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Format a date/time for display
 * @param {string|Date} date - Date to format
 * @returns {string} Formatted date string
 */
export function formatDateTime(date) {
  if (!date) return "N/A";
  const d = new Date(date);
  return d.toLocaleString();
}

/**
 * Format a duration in milliseconds for display
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration string (e.g., "1h 30m", "45m 30s", "30s")
 */
export function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
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
