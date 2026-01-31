/**
 * Task Manager Constants
 * Shared constants used across task manager modules
 */

/**
 * Interval options for task scheduling (in minutes)
 */
export const INTERVAL_OPTIONS = [
  { value: 1, label: "1 minute" },
  { value: 5, label: "5 minutes" },
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
  { value: 360, label: "6 hours" },
  { value: 720, label: "12 hours" },
  { value: 1440, label: "24 hours" },
];

/**
 * Status color mapping for task states
 */
export const STATUS_COLORS = {
  RUNNING: "primary",
  PENDING: "info",
  COMPLETED: "success",
  FAILED: "danger",
  CANCELLED: "secondary",
  PAUSED: "warning",
  IDLE: "secondary",
};

/**
 * Default history pagination settings
 */
export const HISTORY_DEFAULTS = {
  PAGE: 1,
  LIMIT: 10,
};

/**
 * Polling intervals (in milliseconds)
 */
export const POLLING_INTERVALS = {
  SSE_CONNECTED: 15000,
  SSE_DISCONNECTED: 5000,
  DURATION_UPDATE: 1000,
  SSE_RECONNECT: 5000,
};

/**
 * API endpoints for task management
 */
export const API_ENDPOINTS = {
  CONFIG: "/api/background_tasks/config",
  HISTORY: "/api/background_tasks/history",
  RUN: "/api/background_tasks/run",
  FORCE_STOP: "/api/background_tasks/force_stop",
  FETCH_TRIPS_RANGE: "/api/background_tasks/fetch_trips_range",
  DETAILS: "/api/background_tasks/details",
  SSE: "/api/background_tasks/sse",
};
