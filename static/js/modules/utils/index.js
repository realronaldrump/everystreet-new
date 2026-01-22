import {
  clearOldCache,
  debounce,
  fetchWithRetry,
  getDeviceProfile,
  getStorage,
  handleError,
  measurePerformance,
  removeStorage,
  setStorage,
  showNotification,
  throttle,
} from "./data.js";
import { DateUtils } from "./date-utils.js";
import {
  announce,
  batchDOMUpdates,
  createElement,
  fadeIn,
  fadeOut,
  getAllElements,
  getElement,
  measureScrollbarWidth,
  moveModalsToContainer,
  onPageLoad,
  yieldToBrowser,
} from "./dom.js";
import {
  escapeHtml,
  formatDateTime,
  formatDateToString,
  formatDistance,
  formatDuration,
  formatDurationMs,
  formatHourLabel,
  formatMonth,
  formatNumber,
  formatTimeAgo,
  formatVehicleName,
  formatWeekRange,
  distanceInUserUnits,
  sanitizeLocation,
} from "./formatting.js";

export {
  announce,
  batchDOMUpdates,
  clearOldCache,
  createElement,
  debounce,
  distanceInUserUnits,
  escapeHtml,
  fadeIn,
  fadeOut,
  fetchWithRetry,
  formatDateTime,
  formatDateToString,
  formatDistance,
  formatDuration,
  formatDurationMs,
  formatHourLabel,
  formatMonth,
  formatNumber,
  formatTimeAgo,
  formatVehicleName,
  formatWeekRange,
  getAllElements,
  getDeviceProfile,
  getElement,
  getStorage,
  handleError,
  measurePerformance,
  measureScrollbarWidth,
  moveModalsToContainer,
  onPageLoad,
  removeStorage,
  sanitizeLocation,
  setStorage,
  showNotification,
  throttle,
  yieldToBrowser,
  DateUtils,
};

const utils = {
  // Formatters
  escapeHtml,
  formatNumber,
  formatDistance,
  formatDuration,
  formatDateTime,
  formatDateToString,
  formatDurationMs,
  formatHourLabel,
  formatMonth,
  formatTimeAgo,
  formatVehicleName,
  formatWeekRange,
  distanceInUserUnits,
  sanitizeLocation,

  // DOM
  createElement,
  getElement,
  getAllElements,
  batchDOMUpdates,
  yieldToBrowser,
  moveModalsToContainer,

  // Functions
  debounce,
  throttle,

  // Storage
  getStorage,
  setStorage,
  removeStorage,
  clearOldCache,

  // Fetch
  fetchWithRetry,

  // Animation
  fadeIn,
  fadeOut,

  // Device/Browser
  getDeviceProfile,
  measureScrollbarWidth,

  // Notifications
  showNotification,
  announce,

  // Performance
  measurePerformance,

  // Error Handling
  handleError,
};

export { utils };
export default utils;
