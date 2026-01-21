import {
  announce,
  batchDOMUpdates,
  createElement,
  fadeIn,
  fadeOut,
  getAllElements,
  getElement,
  measureScrollbarWidth,
  onPageLoad,
  yieldToBrowser,
} from "./dom.js";
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
import {
  escapeHtml,
  formatDateTime,
  formatDistance,
  formatDuration,
  formatNumber,
  formatVehicleName,
  sanitizeLocation,
} from "./formatting.js";
import { DateUtils } from "./date-utils.js";

export {
  announce,
  batchDOMUpdates,
  clearOldCache,
  createElement,
  debounce,
  escapeHtml,
  fadeIn,
  fadeOut,
  fetchWithRetry,
  formatDateTime,
  formatDistance,
  formatDuration,
  formatNumber,
  formatVehicleName,
  getAllElements,
  getDeviceProfile,
  getElement,
  getStorage,
  handleError,
  measurePerformance,
  measureScrollbarWidth,
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
  formatVehicleName,
  sanitizeLocation,

  // DOM
  createElement,
  getElement,
  getAllElements,
  batchDOMUpdates,
  yieldToBrowser,

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
