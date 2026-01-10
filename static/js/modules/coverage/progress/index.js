/**
 * Coverage Progress Module Index
 * Re-exports all progress-related modules
 */

export { POLLING_CONFIG, STATUS, STEP_ORDER, TERMINAL_STATUSES } from "./constants.js";
export {
  distanceInUserUnits,
  formatElapsedTime,
  formatMetricStats,
  formatStageName,
  formatTimeAgo,
  getStageIcon,
  getStageTextClass,
} from "./formatters.js";
export { ProgressModal } from "./modal.js";
export { calculatePollInterval, ProgressPoller } from "./polling.js";
export { StatePersistence } from "./state.js";
export { updateStepIndicators } from "./step-indicators.js";
