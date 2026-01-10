/**
 * Coverage Auto Refresh
 * Handles automatic refresh of coverage data and processing status updates
 */
import COVERAGE_API from "./coverage-api.js";

/**
 * Class to manage auto-refresh functionality for coverage areas
 */
export class CoverageAutoRefresh {
  /**
   * @param {Object} manager - Reference to the CoverageManager instance
   */
  constructor(manager) {
    this.manager = manager;
    this.isAutoRefreshing = false;
    this.refreshInterval = null;
    this.refreshIntervalMs = 30000; // 30 seconds
  }

  /**
   * Setup auto refresh interval
   * Uses smart incremental updates instead of full table rebuilds to prevent flickering
   */
  setup() {
    // Clear any existing interval
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }

    this.refreshInterval = setInterval(async () => {
      // Skip if already refreshing or if modal is showing (polling handles that)
      if (this.isAutoRefreshing) return;

      const isModalProcessing =
        this.manager.crud?.currentProcessingLocation &&
        document
          .getElementById("taskProgressModal")
          ?.classList.contains("show");

      // Don't auto-refresh while modal is open - polling handles updates there
      if (isModalProcessing) return;

      const processingRows = document.querySelectorAll(".processing-row");
      if (processingRows.length === 0) return;

      // Only do incremental status updates, not full table rebuilds
      this.isAutoRefreshing = true;
      try {
        await this.updateProcessingRowsInPlace();
      } finally {
        this.isAutoRefreshing = false;
      }
    }, this.refreshIntervalMs);
  }

  /**
   * Stop auto refresh
   */
  stop() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    this.isAutoRefreshing = false;
  }

  /**
   * Update only the processing rows in place without rebuilding the entire table
   */
  async updateProcessingRowsInPlace() {
    try {
      const areas = await COVERAGE_API.getAllAreas();
      const processingRows = document.querySelectorAll(".processing-row");

      processingRows.forEach((row) => {
        const locationLink = row.querySelector(".location-name-link");
        if (!locationLink) return;

        const { locationId } = locationLink.dataset;
        const area = areas.find((a) => a._id === locationId);

        if (!area) return;

        // Check if no longer processing
        const status = area.status || "unknown";
        const isStillProcessing = this._isProcessingStatus(status);

        if (!isStillProcessing) {
          // Item finished processing - do a full refresh once
          this.manager.loadCoverageAreas(false, true);
          return;
        }

        // Update the status text in place
        const statusDiv = row.querySelector(".text-primary.small");
        if (statusDiv) {
          statusDiv.innerHTML = `<i class="fas fa-spinner fa-spin me-1"></i>${this.manager.progress.formatStageName(status)}...`;
        }
      });
    } catch (error) {
      console.warn("Auto-refresh status update failed:", error.message);
    }
  }

  /**
   * Check if a status indicates processing is ongoing
   * @param {string} status - The status string to check
   * @returns {boolean} True if processing is ongoing
   */
  _isProcessingStatus(status) {
    const processingStatuses = [
      "processing_trips",
      "preprocessing",
      "calculating",
      "indexing",
      "finalizing",
      "generating_geojson",
      "completed_stats",
      "initializing",
      "loading_streets",
      "counting_trips",
    ];
    return processingStatuses.includes(status);
  }

  /**
   * Check for interrupted tasks from previous sessions
   */
  checkForInterruptedTasks() {
    const savedProgress = localStorage.getItem("coverageProcessingState");
    if (!savedProgress) return;

    try {
      const progressData = JSON.parse(savedProgress);
      const now = new Date();
      const savedTime = new Date(progressData.timestamp);

      // Only restore if less than 1 hour old
      if (now - savedTime < 60 * 60 * 1000) {
        this._showInterruptedTaskNotification(progressData);
      } else {
        localStorage.removeItem("coverageProcessingState");
      }
    } catch (e) {
      console.error("Error restoring saved progress:", e);
      localStorage.removeItem("coverageProcessingState");
    }
  }

  /**
   * Show notification for interrupted task
   * @param {Object} progressData - Saved progress data from localStorage
   */
  _showInterruptedTaskNotification(progressData) {
    const { location } = progressData;
    const { taskId } = progressData;

    if (!location || !location.display_name || !taskId) {
      console.warn("Incomplete saved progress data found.", progressData);
      localStorage.removeItem("coverageProcessingState");
      return;
    }

    const notification = document.createElement("div");
    notification.className =
      "alert alert-info alert-dismissible fade show mt-3 fade-in-up";
    notification.innerHTML = `
      <h5><i class="fas fa-info-circle me-2"></i>Interrupted Task Found</h5>
      <p>A processing task for <strong>${location.display_name}</strong> 
         (Task ID: ${taskId.substring(0, 8)}...) was interrupted.</p>
      <div class="progress mb-2" style="height: 20px;">
        <div class="progress-bar bg-info" style="width: ${progressData.progress || 0}%">
          ${progressData.progress || 0}%
        </div>
      </div>
      <div class="d-flex gap-2">
        <button class="btn btn-sm btn-primary resume-task">
          <i class="fas fa-play me-1"></i>Check Status / Resume
        </button>
        <button class="btn btn-sm btn-secondary discard-task">
          <i class="fas fa-trash me-1"></i>Discard
        </button>
      </div>
      <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
    `;

    notification.querySelector(".resume-task").addEventListener("click", () => {
      this.manager.crud.resumeInterruptedTask(progressData);
      notification.remove();
    });

    notification
      .querySelector(".discard-task")
      .addEventListener("click", () => {
        localStorage.removeItem("coverageProcessingState");
        this.manager.notificationManager.show(
          "Interrupted task discarded",
          "info",
        );
        notification.remove();
      });

    document.querySelector("#alerts-container")?.prepend(notification);
  }
}
