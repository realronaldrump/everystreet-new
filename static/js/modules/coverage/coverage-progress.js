/**
 * Coverage Progress Module
 * Handles progress tracking, polling, and modal management
 */

import COVERAGE_API from "./coverage-api.js";

const STATUS = {
  INITIALIZING: "initializing",
  PREPROCESSING: "preprocessing",
  LOADING_STREETS: "loading_streets",
  INDEXING: "indexing",
  COUNTING_TRIPS: "counting_trips",
  PROCESSING_TRIPS: "processing_trips",
  CALCULATING: "calculating",
  FINALIZING: "finalizing",
  GENERATING_GEOJSON: "generating_geojson",
  COMPLETE_STATS: "completed_stats",
  COMPLETE: "complete",
  COMPLETED: "completed",
  ERROR: "error",
  WARNING: "warning",
  CANCELED: "canceled",
  UNKNOWN: "unknown",
  POST_PREPROCESSING: "post_preprocessing",
};

class CoverageProgress {
  constructor(notificationManager) {
    this.notificationManager = notificationManager;
    this.processingStartTime = null;
    this.lastProgressUpdate = null;
    this.progressTimer = null;
    this.activeTaskIds = new Set();
    this.currentTaskId = null;
    this.currentProcessingLocation = null;
    this.lastActivityTime = null;
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
    }
  }

  /**
   * Remove beforeunload listener
   */
  _removeBeforeUnloadListener() {
    if (this.isBeforeUnloadListenerActive) {
      window.removeEventListener("beforeunload", this.boundSaveProcessingState);
      this.isBeforeUnloadListenerActive = false;
    }
  }

  /**
   * Save processing state to localStorage
   */
  saveProcessingState() {
    if (this.currentProcessingLocation && this.currentTaskId) {
      const progressBar = document.querySelector(
        "#taskProgressModal .progress-bar",
      );
      const progressMessageEl = document.querySelector(
        "#taskProgressModal .progress-message",
      );

      const saveData = {
        location: this.currentProcessingLocation,
        taskId: this.currentTaskId,
        stage: progressMessageEl?.dataset.stage || STATUS.UNKNOWN,
        progress: parseInt(
          progressBar?.getAttribute("aria-valuenow") || "0",
          10,
        ),
        timestamp: new Date().toISOString(),
      };

      localStorage.setItem("coverageProcessingState", JSON.stringify(saveData));
    } else {
      localStorage.removeItem("coverageProcessingState");
    }
  }

  /**
   * Clear processing context
   */
  clearProcessingContext() {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }

    this._removeBeforeUnloadListener();
    localStorage.removeItem("coverageProcessingState");

    this.currentProcessingLocation = null;
    this.processingStartTime = null;
    this.lastProgressUpdate = null;
    this.currentTaskId = null;
    this.lastActivityTime = null;
  }

  /**
   * Poll coverage progress
   */
  async pollCoverageProgress(taskId, onUpdate) {
    const maxRetries = 360; // ~30 minutes
    let retries = 0;
    let lastStage = null;
    let consecutiveSameStage = 0;

    while (retries < maxRetries) {
      if (!this.activeTaskIds.has(taskId)) {
        this.notificationManager.show(
          `Polling stopped for task ${taskId.substring(0, 8)}...`,
          "info",
        );
        this._removeBeforeUnloadListener();
        throw new Error("Polling canceled");
      }

      try {
        const data = await COVERAGE_API.getTaskProgress(taskId);

        if (onUpdate) {
          onUpdate(data);
        }

        this.updateModalContent(data);
        this.updateStepIndicators(data.stage, data.progress);
        this.lastActivityTime = new Date();
        this.saveProcessingState();

        if (data.stage === STATUS.COMPLETE || data.stage === STATUS.COMPLETED) {
          this.updateModalContent({ ...data, progress: 100 });
          this.updateStepIndicators(STATUS.COMPLETE, 100);
          this.activeTaskIds.delete(taskId);
          this._removeBeforeUnloadListener();
          this.showSuccessAnimation();
          setTimeout(() => {
            this.hideProgressModal();
          }, 1500);
          return data;
        } else if (data.stage === STATUS.ERROR) {
          const errorMessage = data.error || data.message || "Unknown error";
          this.notificationManager.show(
            `Task failed: ${errorMessage}`,
            "danger",
          );
          this.activeTaskIds.delete(taskId);
          this._removeBeforeUnloadListener();
          this.showErrorState(errorMessage);
          throw new Error(
            data.error || data.message || "Coverage calculation failed",
          );
        } else if (data.stage === STATUS.CANCELED) {
          this.notificationManager.show("Task was canceled.", "warning");
          this.activeTaskIds.delete(taskId);
          this._removeBeforeUnloadListener();
          this.hideProgressModal();
          throw new Error("Task was canceled");
        }

        if (data.stage === lastStage) {
          consecutiveSameStage++;
          if (consecutiveSameStage > 12) {
            this.notificationManager.show(
              `Task seems stalled at: ${this.formatStageName(data.stage)}`,
              "warning",
            );
            consecutiveSameStage = 0;
          }
        } else {
          lastStage = data.stage;
          consecutiveSameStage = 0;
        }

        const pollInterval = this.calculatePollInterval(data.stage, retries);
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        retries++;
      } catch (error) {
        this.notificationManager.show(
          `Error polling progress: ${error.message}`,
          "danger",
        );
        this.updateModalContent({
          stage: STATUS.ERROR,
          progress: this.currentProcessingLocation?.progress || 0,
          message: `Polling failed: ${error.message}`,
          error: error.message,
          metrics: {},
        });
        this.updateStepIndicators(
          STATUS.ERROR,
          this.currentProcessingLocation?.progress || 0,
        );
        this.activeTaskIds.delete(taskId);
        this._removeBeforeUnloadListener();
        this.showRetryOption(taskId);
        throw error;
      }
    }

    this.notificationManager.show(
      `Polling timed out after ${Math.round(
        (maxRetries *
          this.calculatePollInterval(STATUS.UNKNOWN, maxRetries - 1)) /
          60000,
      )} minutes.`,
      "danger",
    );
    this.updateModalContent({
      stage: STATUS.ERROR,
      progress: this.currentProcessingLocation?.progress || 99,
      message: "Polling timed out waiting for completion.",
      error: "Polling timed out",
      metrics: {},
    });
    this.updateStepIndicators(
      STATUS.ERROR,
      this.currentProcessingLocation?.progress || 99,
    );
    this.activeTaskIds.delete(taskId);
    this._removeBeforeUnloadListener();
    throw new Error("Coverage calculation polling timed out");
  }

  /**
   * Calculate polling interval based on stage
   */
  calculatePollInterval(stage, retries) {
    const baseInterval = 5000; // 5 seconds

    if (stage === STATUS.PROCESSING_TRIPS || stage === STATUS.CALCULATING) {
      return Math.min(baseInterval * 2, 15000);
    }

    if (retries > 100) {
      return Math.min(baseInterval * 3, 20000);
    }

    return baseInterval;
  }

  /**
   * Show progress modal
   */
  showProgressModal(message = "Processing...", progress = 0) {
    const modalElement = document.getElementById("taskProgressModal");
    if (!modalElement) return;

    const modalTitle = modalElement.querySelector(".modal-title");
    const modalProgressBar = modalElement.querySelector(".progress-bar");
    const progressMessage = modalElement.querySelector(".progress-message");
    const progressDetails = modalElement.querySelector(".progress-details");
    const cancelBtn = document.getElementById("cancel-processing");

    if (!progressDetails) {
      this.notificationManager.show(
        "UI Error: Progress details container not found.",
        "danger",
      );
      return;
    }

    if (modalTitle) {
      modalTitle.textContent = this.currentProcessingLocation?.display_name
        ? `Processing: ${this.currentProcessingLocation.display_name}`
        : "Processing Coverage";
    }

    if (modalProgressBar) {
      modalProgressBar.style.width = `${progress}%`;
      modalProgressBar.setAttribute("aria-valuenow", progress);
      modalProgressBar.textContent = `${progress}%`;
      modalProgressBar.className =
        "progress-bar progress-bar-striped progress-bar-animated bg-primary";
    }

    if (progressMessage) {
      progressMessage.textContent = message;
      progressMessage.className = "progress-message text-center mb-3";
      progressMessage.removeAttribute("data-stage");
    }

    progressDetails.querySelector(".stage-info").innerHTML = "";
    progressDetails.querySelector(".stats-info").innerHTML = "";
    progressDetails.querySelector(".elapsed-time").textContent = "Elapsed: 0s";
    progressDetails.querySelector(".estimated-time").textContent = "";

    if (cancelBtn) cancelBtn.disabled = false;

    if (this.progressTimer) clearInterval(this.progressTimer);
    this.processingStartTime = Date.now();
    this.lastActivityTime = Date.now();

    this.progressTimer = setInterval(() => {
      this.updateTimingInfo();
      this.updateActivityIndicator();
    }, 1000);

    this.updateTimingInfo();
    this.updateActivityIndicator();

    const bsModal = bootstrap.Modal.getOrCreateInstance(modalElement, {
      backdrop: "static",
      keyboard: false,
    });

    modalElement.classList.add("fade-in-up");
    bsModal.show();
  }

  /**
   * Hide progress modal
   */
  hideProgressModal() {
    const modalElement = document.getElementById("taskProgressModal");
    if (!modalElement) return;

    const modal = bootstrap.Modal.getInstance(modalElement);
    if (modal) {
      modalElement.style.opacity = "0";
      modalElement.style.transform = "scale(0.95)";

      setTimeout(() => {
        modal.hide();
        modalElement.style.opacity = "";
        modalElement.style.transform = "";
        modalElement.classList.remove("fade-in-up");
      }, 200);
    }
  }

  /**
   * Update modal content
   */
  updateModalContent(data) {
    const modalElement = document.getElementById("taskProgressModal");
    if (!modalElement || !this.currentProcessingLocation) return;

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

    if (progressBar) {
      const currentProgress = parseInt(
        progressBar.getAttribute("aria-valuenow") || "0",
        10,
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
          "bg-primary",
        );
      }
    }

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

    if (stageInfoEl) {
      const stageName = this.formatStageName(stage);
      const stageIcon = this.getStageIcon(stage);
      stageInfoEl.innerHTML = `${stageIcon} ${stageName}`;
      stageInfoEl.className = `stage-info mb-3 text-center text-${this.getStageTextClass(
        stage,
      )}`;
    }

    if (statsInfoEl) {
      statsInfoEl.innerHTML = this.formatMetricStats(stage, metrics);
    }

    if (cancelBtn) {
      cancelBtn.disabled = [
        STATUS.COMPLETE,
        STATUS.COMPLETED,
        STATUS.ERROR,
        STATUS.CANCELED,
      ].includes(stage);
    }

    if (
      [
        STATUS.COMPLETE,
        STATUS.COMPLETED,
        STATUS.ERROR,
        STATUS.CANCELED,
      ].includes(stage)
    ) {
      if (this.progressTimer) {
        clearInterval(this.progressTimer);
        this.progressTimer = null;
        this.updateTimingInfo();

        const estimatedTimeEl = modalElement.querySelector(".estimated-time");
        if (estimatedTimeEl) estimatedTimeEl.textContent = "";
      }
      this.updateActivityIndicator(false);
    } else {
      if (!this.progressTimer) {
        this.processingStartTime =
          Date.now() - (this.lastProgressUpdate?.elapsedMs || 0);
        this.progressTimer = setInterval(() => {
          this.updateTimingInfo();
          this.updateActivityIndicator();
        }, 1000);
      }
      this.updateActivityIndicator(true);
    }

    this.lastProgressUpdate = {
      stage,
      progress,
      elapsedMs: Date.now() - (this.processingStartTime || Date.now()),
    };
  }

  /**
   * Update step indicators
   */
  updateStepIndicators(stage, progress) {
    const modal = document.getElementById("taskProgressModal");
    if (!modal) return;

    const steps = {
      initializing: modal.querySelector(".step-initializing"),
      preprocessing: modal.querySelector(".step-preprocessing"),
      indexing: modal.querySelector(".step-indexing"),
      calculating: modal.querySelector(".step-calculating"),
      complete: modal.querySelector(".step-complete"),
    };

    Object.values(steps).forEach((step) => {
      if (step) {
        step.classList.remove("active", "complete", "error");
        step.style.transform = "scale(1)";
      }
    });

    const markComplete = (stepKey) => {
      if (steps[stepKey]) {
        steps[stepKey].classList.add("complete");
        steps[stepKey].style.transform = "scale(0.9)";
        const iconEl = steps[stepKey].querySelector(".step-icon i");
        if (iconEl) {
          iconEl.className = "fas fa-check-circle";
        }
      }
    };

    const markActive = (stepKey) => {
      if (steps[stepKey]) {
        steps[stepKey].classList.add("active");
        steps[stepKey].style.transform = "scale(1.1)";
      }
    };

    const markError = (stepKey) => {
      if (steps[stepKey]) {
        steps[stepKey].classList.add("error");
        steps[stepKey].style.transform = "scale(1.1)";
        const iconEl = steps[stepKey].querySelector(".step-icon i");
        if (iconEl) {
          iconEl.className = "fas fa-exclamation-triangle";
        }
      }
    };

    if (stage === STATUS.ERROR) {
      let errorStepFound = false;
      if (progress > 75 && steps.calculating) {
        markError("calculating");
        errorStepFound = true;
      } else if (progress > 50 && steps.indexing) {
        markError("indexing");
        errorStepFound = true;
      } else if (progress > 10 && steps.preprocessing) {
        markError("preprocessing");
        errorStepFound = true;
      } else if (steps.initializing) {
        markError("initializing");
        errorStepFound = true;
      }

      if (errorStepFound) {
        if (steps.calculating?.classList.contains("error") && steps.indexing)
          markComplete("indexing");
        if (
          (steps.calculating?.classList.contains("error") ||
            steps.indexing?.classList.contains("error")) &&
          steps.preprocessing
        )
          markComplete("preprocessing");
        if (
          (steps.calculating?.classList.contains("error") ||
            steps.indexing?.classList.contains("error") ||
            steps.preprocessing?.classList.contains("error")) &&
          steps.initializing
        )
          markComplete("initializing");
      }
      return;
    }

    if (stage === STATUS.CANCELED) {
      if (steps.calculating?.classList.contains("active"))
        markError("calculating");
      else if (steps.indexing?.classList.contains("active"))
        markError("indexing");
      else if (steps.preprocessing?.classList.contains("active"))
        markError("preprocessing");
      else if (steps.initializing) markError("initializing");
      return;
    }

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
        markComplete("initializing");
        markComplete("preprocessing");
        markActive("indexing");
        break;
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
        } else if (
          progress > 50 ||
          stage?.toLowerCase().includes("preprocessing")
        ) {
          markComplete("initializing");
          markActive("preprocessing");
        } else {
          markActive("initializing");
        }
        break;
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

    const elapsedTimeEl = document.querySelector(
      "#taskProgressModal .elapsed-time",
    );
    const estimatedTimeEl = document.querySelector(
      "#taskProgressModal .estimated-time",
    );

    if (elapsedTimeEl) elapsedTimeEl.textContent = `Elapsed: ${elapsedText}`;
    if (estimatedTimeEl) estimatedTimeEl.textContent = "";
  }

  /**
   * Update activity indicator
   */
  updateActivityIndicator(isActive = null) {
    const modalElement = document.getElementById("taskProgressModal");
    if (!modalElement) return;

    const activityIndicator = modalElement.querySelector(".activity-indicator");
    const lastUpdateEl = modalElement.querySelector(".last-update-time");

    if (!activityIndicator || !lastUpdateEl) return;

    const now = new Date();
    let currentlyActive;

    if (isActive !== null) {
      currentlyActive = isActive;
    } else {
      currentlyActive =
        this.lastActivityTime && now - this.lastActivityTime < 10000;
    }

    if (currentlyActive) {
      activityIndicator.classList.add("pulsing");
      activityIndicator.innerHTML =
        '<i class="fas fa-circle-notch fa-spin text-info me-1"></i>Active';
    } else {
      activityIndicator.classList.remove("pulsing");
      activityIndicator.innerHTML =
        '<i class="fas fa-hourglass-half text-secondary me-1"></i>Idle';
    }

    if (this.lastActivityTime) {
      lastUpdateEl.textContent = `Last update: ${this.formatTimeAgo(
        this.lastActivityTime,
      )}`;
    } else {
      lastUpdateEl.textContent = currentlyActive ? "" : "No recent activity";
    }
  }

  /**
   * Format time ago
   */
  formatTimeAgo(date) {
    if (!date) return "never";
    const seconds = Math.floor((Date.now() - new Date(date)) / 1000);

    if (seconds < 2) return "just now";
    if (seconds < 60) return `${seconds}s ago`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;

    return new Date(date).toLocaleDateString();
  }

  /**
   * Format metric stats
   */
  formatMetricStats(stage, metrics) {
    if (!metrics || Object.keys(metrics).length === 0) {
      return '<div class="text-muted small text-center py-2">Calculating statistics...</div>';
    }

    let statsHtml = '<div class="mt-1 stats-info">';

    const addStat = (
      label,
      value,
      unit = "",
      icon = null,
      colorClass = "text-primary",
    ) => {
      if (value !== undefined && value !== null && value !== "") {
        const iconHtml = icon ? `<i class="${icon} me-2 opacity-75"></i>` : "";
        const displayValue =
          typeof value === "number" ? value.toLocaleString() : value;
        statsHtml += `
          <div class="d-flex justify-content-between py-1 border-bottom border-secondary border-opacity-10">
            <small class="text-muted">${iconHtml}${label}:</small>
            <small class="fw-bold ${colorClass}">${displayValue}${unit}</small>
          </div>`;
      }
    };

    if (metrics.total_segments !== undefined) {
      addStat(
        "Total Segments",
        metrics.total_segments,
        "",
        "fas fa-road",
        "text-info",
      );
    }
    if (metrics.total_length_m !== undefined) {
      addStat(
        "Total Length",
        this.distanceInUserUnits(metrics.total_length_m),
        "",
        "fas fa-ruler-horizontal",
      );
    }
    if (metrics.driveable_length_m !== undefined) {
      addStat(
        "Driveable Length",
        this.distanceInUserUnits(metrics.driveable_length_m),
        "",
        "fas fa-car",
      );
    }

    if (
      [
        STATUS.INDEXING,
        STATUS.PREPROCESSING,
        STATUS.LOADING_STREETS,
        STATUS.POST_PREPROCESSING,
      ].includes(stage)
    ) {
      if (metrics.initial_covered_segments !== undefined) {
        addStat(
          "Initial Driven",
          metrics.initial_covered_segments,
          " segs",
          "fas fa-flag-checkered",
          "text-success",
        );
      }
    } else if (
      [
        STATUS.PROCESSING_TRIPS,
        STATUS.CALCULATING,
        STATUS.COUNTING_TRIPS,
      ].includes(stage)
    ) {
      const processed = metrics.processed_trips || 0;
      const total = metrics.total_trips_to_process || 0;
      const tripsProgress =
        total > 0 ? ((processed / total) * 100).toFixed(1) : 0;
      addStat(
        "Trips Processed",
        `${processed.toLocaleString()}/${total.toLocaleString()} (${tripsProgress}%)`,
        "",
        "fas fa-route",
        "text-info",
      );
      if (metrics.newly_covered_segments !== undefined) {
        addStat(
          "New Segments Found",
          metrics.newly_covered_segments,
          "",
          "fas fa-plus-circle",
          "text-success",
        );
      }
      if (metrics.coverage_percentage !== undefined) {
        addStat(
          "Current Coverage",
          metrics.coverage_percentage.toFixed(1),
          "%",
          "fas fa-tachometer-alt",
          "text-success",
        );
      }
      if (metrics.covered_length_m !== undefined) {
        addStat(
          "Distance Covered",
          this.distanceInUserUnits(metrics.covered_length_m),
          "",
          "fas fa-road",
          "text-success",
        );
      }
    } else if (
      [
        STATUS.FINALIZING,
        STATUS.GENERATING_GEOJSON,
        STATUS.COMPLETE_STATS,
        STATUS.COMPLETE,
        STATUS.COMPLETED,
      ].includes(stage)
    ) {
      const finalCovered =
        metrics.total_covered_segments || metrics.covered_segments;
      if (finalCovered !== undefined) {
        addStat(
          "Segments Covered",
          finalCovered,
          "",
          "fas fa-check-circle",
          "text-success",
        );
      }
      if (metrics.coverage_percentage !== undefined) {
        addStat(
          "Final Coverage",
          metrics.coverage_percentage.toFixed(1),
          "%",
          "fas fa-check-double",
          "text-success",
        );
      }
      if (metrics.covered_length_m !== undefined) {
        addStat(
          "Distance Covered",
          this.distanceInUserUnits(metrics.covered_length_m),
          "",
          "fas fa-road",
          "text-success",
        );
      }
    } else {
      statsHtml +=
        '<div class="text-muted small text-center py-2">Processing...</div>';
    }

    statsHtml += "</div>";
    return statsHtml;
  }

  /**
   * Distance in user units
   */
  distanceInUserUnits(meters, fixed = 2) {
    if (typeof meters !== "number" || Number.isNaN(meters)) {
      meters = 0;
    }
    const miles = meters * 0.000621371;
    return miles < 0.1
      ? `${(meters * 3.28084).toFixed(0)} ft`
      : `${miles.toFixed(fixed)} mi`;
  }

  /**
   * Get stage icon
   */
  getStageIcon(stage) {
    const icons = {
      [STATUS.INITIALIZING]: '<i class="fas fa-cog fa-spin"></i>',
      [STATUS.PREPROCESSING]: '<i class="fas fa-map-marked-alt"></i>',
      [STATUS.LOADING_STREETS]: '<i class="fas fa-map"></i>',
      [STATUS.INDEXING]: '<i class="fas fa-project-diagram"></i>',
      [STATUS.COUNTING_TRIPS]: '<i class="fas fa-calculator"></i>',
      [STATUS.PROCESSING_TRIPS]: '<i class="fas fa-route fa-spin"></i>',
      [STATUS.CALCULATING]: '<i class="fas fa-cogs fa-spin"></i>',
      [STATUS.FINALIZING]: '<i class="fas fa-chart-line"></i>',
      [STATUS.GENERATING_GEOJSON]: '<i class="fas fa-file-code fa-spin"></i>',
      [STATUS.COMPLETE_STATS]: '<i class="fas fa-check"></i>',
      [STATUS.COMPLETE]: '<i class="fas fa-check-circle"></i>',
      [STATUS.COMPLETED]: '<i class="fas fa-check-circle"></i>',
      [STATUS.ERROR]: '<i class="fas fa-exclamation-circle"></i>',
      [STATUS.WARNING]: '<i class="fas fa-exclamation-triangle"></i>',
      [STATUS.CANCELED]: '<i class="fas fa-ban"></i>',
      [STATUS.UNKNOWN]: '<i class="fas fa-question-circle"></i>',
      [STATUS.POST_PREPROCESSING]: '<i class="fas fa-cog fa-spin"></i>',
    };
    return icons[stage] || icons[STATUS.UNKNOWN];
  }

  /**
   * Get stage text class
   */
  getStageTextClass(stage) {
    const classes = {
      [STATUS.COMPLETE]: "text-success",
      [STATUS.COMPLETED]: "text-success",
      [STATUS.ERROR]: "text-danger",
      [STATUS.WARNING]: "text-warning",
      [STATUS.CANCELED]: "text-warning",
      [STATUS.POST_PREPROCESSING]: "text-info",
    };
    return classes[stage] || "text-info";
  }

  /**
   * Format stage name
   */
  formatStageName(stage) {
    const stageNames = {
      [STATUS.INITIALIZING]: "Initializing",
      [STATUS.PREPROCESSING]: "Fetching Streets",
      [STATUS.LOADING_STREETS]: "Loading Streets",
      [STATUS.INDEXING]: "Building Index",
      [STATUS.COUNTING_TRIPS]: "Analyzing Trips",
      [STATUS.PROCESSING_TRIPS]: "Processing Trips",
      [STATUS.CALCULATING]: "Calculating Coverage",
      [STATUS.FINALIZING]: "Calculating Stats",
      [STATUS.GENERATING_GEOJSON]: "Generating Map",
      [STATUS.COMPLETE_STATS]: "Finalizing",
      [STATUS.COMPLETE]: "Complete",
      [STATUS.COMPLETED]: "Complete",
      [STATUS.ERROR]: "Error",
      [STATUS.WARNING]: "Warning",
      [STATUS.CANCELED]: "Canceled",
      [STATUS.UNKNOWN]: "Unknown",
      [STATUS.POST_PREPROCESSING]: "Post-processing",
    };
    return (
      stageNames[stage] ||
      stage.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
    );
  }

  /**
   * Show success animation
   */
  showSuccessAnimation() {
    const modal = document.getElementById("taskProgressModal");
    if (!modal) return;

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
   * Show error state
   */
  showErrorState(_errorMessage) {
    const modal = document.getElementById("taskProgressModal");
    if (!modal) return;

    const footer = modal.querySelector(".modal-footer");
    const retryBtn = document.createElement("button");
    retryBtn.className = "btn btn-primary";
    retryBtn.innerHTML = '<i class="fas fa-redo me-1"></i>Retry';
    retryBtn.onclick = () => {
      this.hideProgressModal();
      if (this.currentProcessingLocation) {
        // Retry logic would be handled by the manager
        document.dispatchEvent(
          new CustomEvent("coverageRetryTask", {
            detail: {
              location: this.currentProcessingLocation,
              taskId: this.currentTaskId,
            },
          }),
        );
      }
    };

    footer.insertBefore(retryBtn, footer.firstChild);
  }

  /**
   * Show retry option
   */
  showRetryOption(taskId) {
    const modal = document.getElementById("taskProgressModal");
    if (!modal) return;

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
      this.activeTaskIds.add(taskId);
      this._addBeforeUnloadListener();
      document.dispatchEvent(
        new CustomEvent("coverageRetryTask", {
          detail: { taskId },
        }),
      );
    };

    modalBody.appendChild(retrySection);
  }
}

export { CoverageProgress, STATUS };
