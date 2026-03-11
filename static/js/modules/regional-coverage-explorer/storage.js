/**
 * County Map Storage Module
 * Handles localStorage persistence for recalculation state
 */

import { RECALC_STORAGE_KEY } from "./constants.js";

/**
 * Get stored recalculation state from localStorage
 * @returns {{startedAt: Date, jobId: string|null}|null} Recalc state or null if not found/invalid
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

    const jobId = typeof parsed.jobId === "string" ? parsed.jobId : null;
    return { startedAt, jobId };
  } catch {
    return null;
  }
}

/**
 * Store recalculation state to localStorage
 * @param {Date} startedAt - When recalculation started
 * @param {string|null} [jobId] - Background job identifier
 */
export function storeRecalcState(startedAt, jobId = null) {
  localStorage.setItem(
    RECALC_STORAGE_KEY,
    JSON.stringify({
      startedAt: startedAt.toISOString(),
      jobId: typeof jobId === "string" ? jobId : null,
    })
  );
}

/**
 * Clear recalculation state from localStorage
 */
export function clearStoredRecalcState() {
  localStorage.removeItem(RECALC_STORAGE_KEY);
}
