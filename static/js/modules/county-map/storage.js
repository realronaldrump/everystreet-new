/**
 * County Map Storage Module
 * Handles localStorage persistence for recalculation state
 */

import { RECALC_STORAGE_KEY } from "./constants.js";

/**
 * Get stored recalculation state from localStorage
 * @returns {{startedAt: Date}|null} Recalc state or null if not found/invalid
 */
export function getStoredRecalcState() {
  const raw = localStorage.getItem(RECALC_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed.startedAt) {
      return null;
    }

    const startedAt = new Date(parsed.startedAt);
    if (Number.isNaN(startedAt.getTime())) {
      return null;
    }

    return { startedAt };
  } catch {
    return null;
  }
}

/**
 * Store recalculation state to localStorage
 * @param {Date} startedAt - When recalculation started
 */
export function storeRecalcState(startedAt) {
  localStorage.setItem(
    RECALC_STORAGE_KEY,
    JSON.stringify({ startedAt: startedAt.toISOString() }),
  );
}

/**
 * Clear recalculation state from localStorage
 */
export function clearStoredRecalcState() {
  localStorage.removeItem(RECALC_STORAGE_KEY);
}

// Default export for backward compatibility
const CountyMapStorage = {
  getStoredRecalcState,
  storeRecalcState,
  clearStoredRecalcState,
};

export default CountyMapStorage;
