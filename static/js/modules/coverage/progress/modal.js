/**
 * Progress Modal Module
 * Manages the progress modal UI for coverage calculations
 */

/* global bootstrap */

import { STATUS, TERMINAL_STATUSES } from "./constants.js";
import {
  formatElapsedTime,
  formatMetricStats,
  formatStageName,
  formatTimeAgo,
  getStageIcon,
  getStageTextClass,
} from "./formatters.js";
import { updateStepIndicators } from "./step-indicators.js";

/**
 * ProgressModal class manages the visual progress modal UI
 */
export class ProgressModal {
  constructor() {
    this.processingStartTime = null;
    this.progressTimer = null;
    this.lastProgressUpdate = null;
    this.lastActivityTime = null;
    this.currentProcessingLocation = null;
    this.isMinimized = false;
  }

  /**
   * Get the modal element
   */
  getModalElement() {
    return document.getElementById("taskProgressModal");
  }

  /**
   * Show the progress modal
   */
  show(message = "Processing...", progress = 0, locationName = null) {
    const modalElement = this.getModalElement();
    if (!modalElement) {
      return;
    }

    const modalTitle = modalElement.querySelector(".modal-title");
    const modalProgressBar = modalElement.querySelector(".progress-bar");
    const progressMessage = modalElement.querySelector(".progress-message");
    const progressDetails = modalElement.querySelector(".progress-details");
    const cancelBtn = document.getElementById("cancel-processing");

    if (!progressDetails) {
      console.error("UI Error: Progress details container not found.");
      return;
    }

    // Set title
    if (modalTitle) {
      modalTitle.textContent = locationName
        ? `Processing: ${locationName}`
        : "Processing Coverage";
    }

    // Initialize progress bar
    if (modalProgressBar) {
      modalProgressBar.style.width = `${progress}%`;
      modalProgressBar.setAttribute("aria-valuenow", progress);
      modalProgressBar.textContent = `${progress}%`;
      modalProgressBar.className
        = "progress-bar progress-bar-striped progress-bar-animated bg-primary";
    }

    // Set initial message
    if (progressMessage) {
      progressMessage.textContent = message;
      progressMessage.className = "progress-message text-center mb-3";
      progressMessage.removeAttribute("data-stage");
    }

    // Reset details sections
    const stageInfo = progressDetails.querySelector(".stage-info");
    const statsInfo = progressDetails.querySelector(".stats-info");
    const elapsedTime = progressDetails.querySelector(".elapsed-time");
    const estimatedTime = progressDetails.querySelector(".estimated-time");

    if (stageInfo) {
      stageInfo.innerHTML = "";
    }
    if (statsInfo) {
      statsInfo.innerHTML = "";
    }
    if (elapsedTime) {
      elapsedTime.textContent = "Elapsed: 0s";
    }
    if (estimatedTime) {
      estimatedTime.textContent = "";
    }

    // Enable cancel button
    if (cancelBtn) {
      cancelBtn.disabled = false;
    }

    // Start timing
    this.startTiming();

    // Show modal
    const bsModal = bootstrap.Modal.getOrCreateInstance(modalElement, {
      backdrop: "static",
      keyboard: false,
    });

    modalElement.classList.add("fade-in-up");
    bsModal.show();
  }

  /**
   * Hide the progress modal
   */
  hide() {
    const modalElement = this.getModalElement();
    if (!modalElement) {
      return;
    }

    const modal = bootstrap.Modal.getInstance(modalElement);
    if (modal) {
      modalElement.style.opacity = "0";
      modalElement.style.transform = "scale(0.95)";

      // Remove focus from any element inside the modal to prevent
      // "Blocked aria-hidden" errors when Bootstrap adds aria-hidden=true
      if (document.activeElement && modalElement.contains(document.activeElement)) {
        document.activeElement.blur();
      }

      setTimeout(() => {
        modal.hide();
        modalElement.style.opacity = "";
        modalElement.style.transform = "";
        modalElement.classList.remove("fade-in-up");
      }, 200);
    }

    this.stopTiming();
  }

  /**
   * Update modal content with progress data
   */
  updateContent(data) {
    const modalElement = this.getModalElement();
    if (!modalElement) {
      return;
    }

    const {
      stage = STATUS.UNKNOWN,
      progress = 0,
      metrics = {},
      message = "Processing...",
      error = null,
    } = data || {};

    const progressBar = modalElement.querySelector(".progress-bar");
    const progressMessageEl = modalElement.querySelector(".progress-message");
    const stageInfoEl = modalElement.querySelector(".stage-info");
    const statsInfoEl = modalElement.querySelector(".stats-info");
    const cancelBtn = document.getElementById("cancel-processing");

    // Update progress bar
    if (progressBar) {
      const currentProgress = parseInt(
        progressBar.getAttribute("aria-valuenow") || "0",
        10
      );

      if (progress > currentProgress) {
        progressBar.style.transition = "width 0.5s ease";
      } else {
        progressBar.style.transition = "none";
      }

      progressBar.style.width = `${progress}%`;
      progressBar.setAttribute("aria-valuenow", progress);
      progressBar.textContent = `${progress}%`;

      progressBar.className = "progress-bar";
      if (stage === STATUS.COMPLETE || stage === STATUS.COMPLETED) {
        progressBar.classList.add("bg-success");
      } else if (stage === STATUS.ERROR) {
        progressBar.classList.add("bg-danger");
      } else {
        progressBar.classList.add(
          "progress-bar-striped",
          "progress-bar-animated",
          "bg-primary"
        );
      }
    }

    // Update message with fade effect
    if (progressMessageEl) {
      progressMessageEl.style.opacity = "0";

      setTimeout(() => {
        progressMessageEl.textContent = error ? `Error: ${error}` : message;
        progressMessageEl.dataset.stage = stage;
        progressMessageEl.className = "progress-message text-center mb-3";

        if (stage === STATUS.ERROR) {
          progressMessageEl.classList.add("text-danger");
        } else if (stage === STATUS.COMPLETE || stage === STATUS.COMPLETED) {
          progressMessageEl.classList.add("text-success");
        }

        progressMessageEl.style.opacity = "1";
      }, 150);
    }

    // Update stage info
    if (stageInfoEl) {
      const stageName = formatStageName(stage);
      const stageIcon = getStageIcon(stage);
      stageInfoEl.innerHTML = `${stageIcon} ${stageName}`;
      stageInfoEl.className = `stage-info mb-3 text-center text-${getStageTextClass(stage)}`;
    }

    // Update stats
    if (statsInfoEl) {
      statsInfoEl.innerHTML = formatMetricStats(stage, metrics);
    }

    // Update cancel button state
    if (cancelBtn) {
      cancelBtn.disabled = TERMINAL_STATUSES.includes(stage);
    }

    // Update step indicators
    updateStepIndicators(modalElement, stage, progress);

    // Handle terminal states
    if (TERMINAL_STATUSES.includes(stage)) {
      this.stopTiming();
      this.updateActivityIndicator(false);

      const estimatedTimeEl = modalElement.querySelector(".estimated-time");
      if (estimatedTimeEl) {
        estimatedTimeEl.textContent = "";
      }
    } else {
      if (!this.progressTimer) {
        this.startTiming();
      }
      this.updateActivityIndicator(true);
    }

    this.lastActivityTime = new Date();
    this.lastProgressUpdate = {
      stage,
      progress,
      metrics,
      message,
      error,
      elapsedMs: Date.now() - (this.processingStartTime || Date.now()),
    };

    // Update minimized indicator if minimized
    this.updateMinimizedIndicator(progress);
  }

  /**
   * Start the timing interval
   */
  startTiming() {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
    }

    this.processingStartTime = Date.now();
    this.lastActivityTime = Date.now();

    this.progressTimer = setInterval(() => {
      this.updateTimingInfo();
      this.updateActivityIndicator();
    }, 1000);

    this.updateTimingInfo();
    this.updateActivityIndicator();
  }

  /**
   * Stop the timing interval
   */
  stopTiming() {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
    this.updateTimingInfo();
  }

  /**
   * Update timing information display
   */
  updateTimingInfo() {
    if (!this.processingStartTime) {
      return;
    }

    const elapsedMs = Date.now() - this.processingStartTime;
    const elapsedText = formatElapsedTime(elapsedMs);

    const elapsedTimeEl = document.querySelector("#taskProgressModal .elapsed-time");
    const estimatedTimeEl = document.querySelector(
      "#taskProgressModal .estimated-time"
    );

    if (elapsedTimeEl) {
      elapsedTimeEl.textContent = `Elapsed: ${elapsedText}`;
    }
    if (estimatedTimeEl) {
      estimatedTimeEl.textContent = "";
    }
  }

  /**
   * Update activity indicator
   */
  updateActivityIndicator(isActive = null) {
    const modalElement = this.getModalElement();
    if (!modalElement) {
      return;
    }

    const activityIndicator = modalElement.querySelector(".activity-indicator");
    const lastUpdateEl = modalElement.querySelector(".last-update-time");

    if (!activityIndicator || !lastUpdateEl) {
      return;
    }

    const now = new Date();
    let currentlyActive = false;

    if (isActive !== null) {
      currentlyActive = isActive;
    } else {
      currentlyActive = this.lastActivityTime && now - this.lastActivityTime < 10000;
    }

    if (currentlyActive) {
      activityIndicator.classList.add("pulsing");
      activityIndicator.innerHTML
        = '<i class="fas fa-circle-notch fa-spin text-info me-1"></i>Active';
    } else {
      activityIndicator.classList.remove("pulsing");
      activityIndicator.innerHTML
        = '<i class="fas fa-hourglass-half text-secondary me-1"></i>Idle';
    }

    if (this.lastActivityTime) {
      lastUpdateEl.textContent = `Last update: ${formatTimeAgo(this.lastActivityTime)}`;
    } else {
      lastUpdateEl.textContent = currentlyActive ? "" : "No recent activity";
    }
  }

  /**
   * Show success animation
   */
  showSuccessAnimation() {
    const modal = this.getModalElement();
    if (!modal) {
      return;
    }

    const modalBody = modal.querySelector(".modal-body");
    const successIcon = document.createElement("div");
    successIcon.className = "text-center my-4 fade-in-up";
    successIcon.innerHTML = `
      <i class="fas fa-check-circle text-success" style="font-size: 4rem;"></i>
      <h4 class="mt-3 text-success">Processing Complete!</h4>
    `;

    modalBody.appendChild(successIcon);

    setTimeout(() => {
      successIcon.remove();
    }, 1500);
  }

  /**
   * Show error state with retry button
   */
  showErrorState(_errorMessage, onRetry) {
    const modal = this.getModalElement();
    if (!modal) {
      return;
    }

    const footer = modal.querySelector(".modal-footer");
    const retryBtn = document.createElement("button");
    retryBtn.className = "btn btn-primary";
    retryBtn.innerHTML = '<i class="fas fa-redo me-1"></i>Retry';
    retryBtn.onclick = () => {
      this.hide();
      if (onRetry) {
        onRetry();
      }
    };

    footer.insertBefore(retryBtn, footer.firstChild);
  }

  /**
   * Show retry option in modal body
   */
  showRetryOption(taskId, onRetry) {
    const modal = this.getModalElement();
    if (!modal) {
      return;
    }

    const modalBody = modal.querySelector(".modal-body");
    const retrySection = document.createElement("div");
    retrySection.className = "alert alert-warning mt-3 fade-in-up";
    retrySection.innerHTML = `
      <p class="mb-2">The operation failed. Would you like to retry?</p>
      <button class="btn btn-sm btn-primary retry-task-btn">
        <i class="fas fa-redo me-1"></i>Retry
      </button>
    `;

    retrySection.querySelector(".retry-task-btn").onclick = () => {
      retrySection.remove();
      if (onRetry) {
        onRetry(taskId);
      }
    };

    modalBody.appendChild(retrySection);
  }

  /**
   * Set the current processing location
   */
  setProcessingLocation(location) {
    this.currentProcessingLocation = location;
  }

  /**
   * Get the current processing location
   */
  getProcessingLocation() {
    return this.currentProcessingLocation;
  }

  /**
   * Minimize the modal and show floating indicator
   */
  minimize() {
    const modalElement = this.getModalElement();
    if (!modalElement) {
      return;
    }

    const modal = bootstrap.Modal.getInstance(modalElement);
    if (modal) {
      // Remove focus to prevent aria-hidden warnings
      if (document.activeElement && modalElement.contains(document.activeElement)) {
        document.activeElement.blur();
      }
      modal.hide();
    }

    this.isMinimized = true;
    this.showMinimizedIndicator();
  }

  /**
   * Restore the modal from minimized state
   */
  restore() {
    this.hideMinimizedIndicator();
    this.isMinimized = false;

    const modalElement = this.getModalElement();
    if (!modalElement) {
      return;
    }

    const bsModal = bootstrap.Modal.getOrCreateInstance(modalElement, {
      backdrop: "static",
      keyboard: false,
    });
    bsModal.show();

    // Update with last known progress
    if (this.lastProgressUpdate) {
      this.updateContent(this.lastProgressUpdate);
    }
  }

  /**
   * Show the minimized floating indicator
   */
  showMinimizedIndicator() {
    const indicator = document.getElementById("minimized-progress-indicator");
    if (!indicator) {
      return;
    }

    const locationName
      = this.currentProcessingLocation?.display_name || "Processing...";
    const progress = this.lastProgressUpdate?.progress || 0;

    indicator.querySelector(".minimized-location-name").textContent = locationName;
    indicator.querySelector(".minimized-progress-percent").textContent = `${progress}%`;
    indicator.style.display = "block";
  }

  /**
   * Hide the minimized floating indicator
   */
  hideMinimizedIndicator() {
    const indicator = document.getElementById("minimized-progress-indicator");
    if (indicator) {
      indicator.style.display = "none";
    }
  }

  /**
   * Update the minimized indicator with current progress
   */
  updateMinimizedIndicator(progress) {
    if (!this.isMinimized) {
      return;
    }

    const indicator = document.getElementById("minimized-progress-indicator");
    if (!indicator) {
      return;
    }

    const progressEl = indicator.querySelector(".minimized-progress-percent");
    if (progressEl) {
      progressEl.textContent = `${progress}%`;
    }
  }

  /**
   * Check if modal is currently minimized
   */
  getIsMinimized() {
    return this.isMinimized;
  }

  /**
   * Reset all modal state
   */
  reset() {
    this.stopTiming();
    this.processingStartTime = null;
    this.lastProgressUpdate = null;
    this.lastActivityTime = null;
    this.currentProcessingLocation = null;
    this.isMinimized = false;
    this.hideMinimizedIndicator();
  }
}
