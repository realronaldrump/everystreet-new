/**
 * Progress State Persistence Module
 * Handles saving and restoring progress state
 */

import { STATUS } from "./constants.js";

const STORAGE_KEY = "coverageProcessingState";

/**
 * StatePersistence class manages saving/loading progress state
 */
export class StatePersistence {
  constructor() {
    this.currentTaskId = null;
    this.currentProcessingLocation = null;
    this.boundSaveState = this.saveState.bind(this);
    this.isBeforeUnloadListenerActive = false;
  }

  /**
   * Enable beforeunload listener
   */
  enableAutoSave() {
    if (!this.isBeforeUnloadListenerActive) {
      window.addEventListener("beforeunload", this.boundSaveState);
      this.isBeforeUnloadListenerActive = true;
    }
  }

  /**
   * Disable beforeunload listener
   */
  disableAutoSave() {
    if (this.isBeforeUnloadListenerActive) {
      window.removeEventListener("beforeunload", this.boundSaveState);
      this.isBeforeUnloadListenerActive = false;
    }
  }

  /**
   * Set the current task info
   */
  setCurrentTask(taskId, location) {
    this.currentTaskId = taskId;
    this.currentProcessingLocation = location;
  }

  /**
   * Get the current task ID
   */
  getCurrentTaskId() {
    return this.currentTaskId;
  }

  /**
   * Get the current processing location
   */
  getCurrentLocation() {
    return this.currentProcessingLocation;
  }

  /**
   * Save current processing state to localStorage
   */
  saveState() {
    if (this.currentProcessingLocation && this.currentTaskId) {
      const progressBar = document.querySelector("#taskProgressModal .progress-bar");
      const progressMessageEl = document.querySelector(
        "#taskProgressModal .progress-message"
      );

      const saveData = {
        location: this.currentProcessingLocation,
        taskId: this.currentTaskId,
        stage: progressMessageEl?.dataset.stage || STATUS.UNKNOWN,
        progress: parseInt(progressBar?.getAttribute("aria-valuenow") || "0", 10),
        timestamp: new Date().toISOString(),
      };

      localStorage.setItem(STORAGE_KEY, JSON.stringify(saveData));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  /**
   * Load saved processing state from localStorage
   */
  loadState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (error) {
      console.error("Failed to load processing state:", error);
    }
    return null;
  }

  /**
   * Clear saved processing state
   */
  clearState() {
    localStorage.removeItem(STORAGE_KEY);
    this.currentTaskId = null;
    this.currentProcessingLocation = null;
  }

  /**
   * Reset all state and listeners
   */
  reset() {
    this.disableAutoSave();
    this.clearState();
  }
}
