/**
 * Coverage Progress Module
 * Handles progress tracking, polling, and modal management
 *
 * This is the main orchestrator class that coordinates:
 * - Progress modal display
 * - Polling for task updates
 * - State persistence across page reloads
 */

import {
  distanceInUserUnits,
  formatStageName,
  ProgressModal,
  ProgressPoller,
  STATUS,
  StatePersistence,
} from "./progress/index.js";

/**
 * CoverageProgress class coordinates all progress tracking functionality
 */
class CoverageProgress {
  constructor(notificationManager) {
    this.notificationManager = notificationManager;

    // Initialize sub-modules
    this.modal = new ProgressModal();
    this.poller = new ProgressPoller(notificationManager);
    this.statePersistence = new StatePersistence();

    // Expose properties for backward compatibility
    this.processingStartTime = null;
    this.lastProgressUpdate = null;
    this.progressTimer = null;
    this.activeTaskIds = this.poller.activeTaskIds;
    this.currentTaskId = null;
    this.currentProcessingLocation = null;
    this.lastActivityTime = null;

    // Bind methods for event listeners
    this.boundSaveProcessingState = this.saveProcessingState.bind(this);
    this.isBeforeUnloadListenerActive = false;
  }

  /**
   * Add beforeunload listener
   */
  _addBeforeUnloadListener() {
    if (!this.isBeforeUnloadListenerActive) {
      window.addEventListener("beforeunload", this.boundSaveProcessingState);
      this.isBeforeUnloadListenerActive = true;
      this.statePersistence.enableAutoSave();
    }
  }

  /**
   * Remove beforeunload listener
   */
  _removeBeforeUnloadListener() {
    if (this.isBeforeUnloadListenerActive) {
      window.removeEventListener("beforeunload", this.boundSaveProcessingState);
      this.isBeforeUnloadListenerActive = false;
      this.statePersistence.disableAutoSave();
    }
  }

  /**
   * Save processing state to localStorage
   */
  saveProcessingState() {
    this.statePersistence.setCurrentTask(
      this.currentTaskId,
      this.currentProcessingLocation
    );
    this.statePersistence.saveState();
  }

  /**
   * Clear processing context
   */
  clearProcessingContext() {
    // Stop modal timer
    this.modal.reset();

    // Stop state persistence
    this._removeBeforeUnloadListener();
    this.statePersistence.reset();

    // Clear local references
    this.currentProcessingLocation = null;
    this.processingStartTime = null;
    this.lastProgressUpdate = null;
    this.currentTaskId = null;
    this.lastActivityTime = null;

    // Legacy property cleanup
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  /**
   * Poll coverage progress
   */
  async pollCoverageProgress(taskId, onUpdate) {
    this.currentTaskId = taskId;
    this.statePersistence.setCurrentTask(taskId, this.currentProcessingLocation);
    this._addBeforeUnloadListener();

    return this.poller.poll(taskId, {
      onUpdate: (data) => {
        if (onUpdate) onUpdate(data);
        this.updateModalContent(data);
        this.updateStepIndicators(data.stage, data.progress);
        this.lastActivityTime = new Date();
        this.saveProcessingState();
      },
      onComplete: (data) => {
        this.updateModalContent({ ...data, progress: 100 });
        this.updateStepIndicators(STATUS.COMPLETE, 100);
        this._removeBeforeUnloadListener();
        this.showSuccessAnimation();
        setTimeout(() => {
          this.hideProgressModal();
        }, 1500);
      },
      onError: (data) => {
        const errorMessage = data.error || data.message || "Unknown error";
        this.updateModalContent(data);
        this.updateStepIndicators(STATUS.ERROR, data.progress || 0);
        this._removeBeforeUnloadListener();
        this.showErrorState(errorMessage);
      },
      onPollingError: (data) => {
        this.updateModalContent(data);
        this.updateStepIndicators(
          STATUS.ERROR,
          this.currentProcessingLocation?.progress || 0
        );
        this._removeBeforeUnloadListener();
        this.showRetryOption(data.taskId);
      },
      onCancel: () => {
        this._removeBeforeUnloadListener();
        this.hideProgressModal();
      },
      onTimeout: (data) => {
        this.updateModalContent(data);
        this.updateStepIndicators(STATUS.ERROR, data.progress || 99);
        this._removeBeforeUnloadListener();
      },
    });
  }

  /**
   * Show progress modal
   */
  showProgressModal(message = "Processing...", progress = 0) {
    const locationName = this.currentProcessingLocation?.display_name;

    // Update legacy properties
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.processingStartTime = Date.now();
    this.lastActivityTime = Date.now();

    this.progressTimer = setInterval(() => {
      this.updateTimingInfo();
      this.updateActivityIndicator();
    }, 1000);

    this.modal.show(message, progress, locationName);
  }

  /**
   * Hide progress modal
   */
  hideProgressModal() {
    this.lastProgressModalHideTime = Date.now();
    this.modal.hide();

    // Clear legacy timer
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  /**
   * Update modal content
   */
  updateModalContent(data) {
    if (!this.currentProcessingLocation) return;
    this.modal.updateContent(data);

    // Sync legacy properties
    this.lastActivityTime = new Date();
    if (data) {
      this.lastProgressUpdate = {
        stage: data.stage,
        progress: data.progress,
        elapsedMs: Date.now() - (this.processingStartTime || Date.now()),
      };
    }
  }

  /**
   * Update step indicators
   */
  updateStepIndicators(stage, progress) {
    this.lastStepIndicatorState = { stage, progress };
    const modal = document.getElementById("taskProgressModal");
    if (modal) {
      // Import dynamically to avoid circular dependency issues
      import("./progress/step-indicators.js").then(({ updateStepIndicators }) => {
        updateStepIndicators(modal, stage, progress);
      });
    }
  }

  /**
   * Update timing info
   */
  updateTimingInfo() {
    if (!this.processingStartTime) return;

    const now = Date.now();
    const elapsedMs = now - this.processingStartTime;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);

    let elapsedText = `${elapsedSeconds}s`;
    if (elapsedSeconds >= 60) {
      const minutes = Math.floor(elapsedSeconds / 60);
      const seconds = elapsedSeconds % 60;
      elapsedText = `${minutes}m ${seconds}s`;
      if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        const remMinutes = minutes % 60;
        elapsedText = `${hours}h ${remMinutes}m ${seconds}s`;
      }
    }

    const elapsedTimeEl = document.querySelector("#taskProgressModal .elapsed-time");
    const estimatedTimeEl = document.querySelector(
      "#taskProgressModal .estimated-time"
    );

    if (elapsedTimeEl) elapsedTimeEl.textContent = `Elapsed: ${elapsedText}`;
    if (estimatedTimeEl) estimatedTimeEl.textContent = "";
  }

  /**
   * Update activity indicator
   */
  updateActivityIndicator(isActive = null) {
    this.modal.updateActivityIndicator(isActive);
  }

  /**
   * Format time ago
   */
  formatTimeAgo(date) {
    if (!date) return "never";
    const seconds = Math.floor((Date.now() - new Date(date)) / 1000);

    let formatted = "";
    if (seconds < 2) {
      formatted = "just now";
    } else if (seconds < 60) {
      formatted = `${seconds}s ago`;
    } else {
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) {
        formatted = `${minutes}m ago`;
      } else {
        const hours = Math.floor(minutes / 60);
        if (hours < 24) {
          formatted = `${hours}h ago`;
        } else {
          const days = Math.floor(hours / 24);
          if (days < 7) {
            formatted = `${days}d ago`;
          } else {
            formatted = new Date(date).toLocaleDateString();
          }
        }
      }
    }

    this.lastFormattedTimeAgo = formatted;
    return formatted;
  }

  /**
   * Distance in user units
   */
  distanceInUserUnits(meters, fixed = 2) {
    const formatted = distanceInUserUnits(meters, fixed);
    this.lastDistanceLabel = formatted;
    return formatted;
  }

  /**
   * Format stage name
   */
  formatStageName(stage) {
    const formatted = formatStageName(stage);
    this.lastStageName = formatted;
    return formatted;
  }

  /**
   * Show success animation
   */
  showSuccessAnimation() {
    this.lastSuccessAnimationAt = Date.now();
    this.modal.showSuccessAnimation();
  }

  /**
   * Show error state
   */
  showErrorState(_errorMessage) {
    this.modal.showErrorState(_errorMessage, () => {
      if (this.currentProcessingLocation) {
        document.dispatchEvent(
          new CustomEvent("coverageRetryTask", {
            detail: {
              location: this.currentProcessingLocation,
              taskId: this.currentTaskId,
            },
          })
        );
      }
    });
  }

  /**
   * Show retry option
   */
  showRetryOption(taskId) {
    this.modal.showRetryOption(taskId, (retryTaskId) => {
      this.activeTaskIds.add(retryTaskId);
      this._addBeforeUnloadListener();
      document.dispatchEvent(
        new CustomEvent("coverageRetryTask", {
          detail: { taskId: retryTaskId },
        })
      );
    });
  }

  // Static methods for backward compatibility
  static _markErrorStepByProgress(progress, steps, markError, markComplete) {
    const errorSteps = [
      { threshold: 75, step: "calculating" },
      { threshold: 50, step: "indexing" },
      { threshold: 10, step: "preprocessing" },
      { threshold: 0, step: "initializing" },
    ];

    const errorStep = errorSteps.find((s) => progress > s.threshold && steps[s.step]);

    if (!errorStep) return false;

    markError(errorStep.step);

    const stepOrder = ["initializing", "preprocessing", "indexing", "calculating"];
    const errorIndex = stepOrder.indexOf(errorStep.step);
    for (let i = 0; i < errorIndex; i++) {
      if (steps[stepOrder[i]]) markComplete(stepOrder[i]);
    }

    return true;
  }

  static _markCanceledStep(steps, markError) {
    const stepOrder = ["calculating", "indexing", "preprocessing", "initializing"];
    for (const stepKey of stepOrder) {
      if (steps[stepKey]?.classList.contains("active")) {
        markError(stepKey);
        return;
      }
    }
    if (steps.initializing) markError("initializing");
  }

  static _markStepsByStage(stage, progress, markComplete, markActive) {
    switch (stage) {
      case STATUS.INITIALIZING:
        markActive("initializing");
        break;
      case STATUS.PREPROCESSING:
      case STATUS.LOADING_STREETS:
        markComplete("initializing");
        markActive("preprocessing");
        break;
      case STATUS.POST_PREPROCESSING:
      case STATUS.INDEXING:
        markComplete("initializing");
        markComplete("preprocessing");
        markActive("indexing");
        break;
      case STATUS.COUNTING_TRIPS:
      case STATUS.PROCESSING_TRIPS:
      case STATUS.CALCULATING:
      case STATUS.FINALIZING:
      case STATUS.GENERATING_GEOJSON:
      case STATUS.COMPLETE_STATS:
        markComplete("initializing");
        markComplete("preprocessing");
        markComplete("indexing");
        markActive("calculating");
        break;
      case STATUS.COMPLETE:
      case STATUS.COMPLETED:
        markComplete("initializing");
        markComplete("preprocessing");
        markComplete("indexing");
        markComplete("calculating");
        markComplete("complete");
        break;
      default:
        CoverageProgress._markStepsByProgress(
          progress,
          stage,
          markComplete,
          markActive
        );
        break;
    }
  }

  static _markStepsByProgress(progress, stage, markComplete, markActive) {
    if (progress >= 100) {
      markComplete("initializing");
      markComplete("preprocessing");
      markComplete("indexing");
      markComplete("calculating");
      markComplete("complete");
    } else if (progress > 75) {
      markComplete("initializing");
      markComplete("preprocessing");
      markComplete("indexing");
      markActive("calculating");
    } else if (progress > 50 || stage?.toLowerCase().includes("preprocessing")) {
      markComplete("initializing");
      markActive("preprocessing");
    } else {
      markActive("initializing");
    }
  }
}

export { CoverageProgress, STATUS };
