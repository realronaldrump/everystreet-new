// static/js/coverage/modal-manager.js
class ModalManager {
  constructor(uiManager) {
    this.ui = uiManager;
    this.activeModals = new Map();
  }

  // Confirmation dialogs
  async showConfirmDialog(options) {
    const {
      title = "Confirm Action",
      message = "Are you sure?",
      details = "",
      confirmText = "Confirm",
      cancelText = "Cancel",
      confirmButtonClass = "btn-primary",
    } = options;

    return new Promise((resolve) => {
      const modalId = `confirm-${Date.now()}`;
      const modalHtml = `
          <div class="modal fade" id="${modalId}" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-dialog-centered">
              <div class="modal-content bg-dark text-white">
                <div class="modal-header">
                  <h5 class="modal-title">${title}</h5>
                  <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                  <p>${message}</p>
                  ${details ? `<small class="text-muted">${details}</small>` : ""}
                </div>
                <div class="modal-footer">
                  <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">${cancelText}</button>
                  <button type="button" class="btn ${confirmButtonClass}" data-action="confirm">${confirmText}</button>
                </div>
              </div>
            </div>
          </div>
        `;

      const container = document.createElement("div");
      container.innerHTML = modalHtml;
      const modal = container.firstElementChild;
      document.body.appendChild(modal);

      const bsModal = new bootstrap.Modal(modal);

      modal.addEventListener("click", (e) => {
        if (e.target.matches('[data-action="confirm"]')) {
          resolve(true);
          bsModal.hide();
        }
      });

      modal.addEventListener("hidden.bs.modal", () => {
        resolve(false);
        modal.remove();
      });

      bsModal.show();
    });
  }

  // Progress modal
  showProgressModal(
    title,
    initialMessage = "Processing...",
    initialProgress = 0,
  ) {
    const modalId = "taskProgressModal";
    const modal = this.ui.getElement(modalId);
    if (!modal) return null;

    // Reset modal state
    this.updateProgressModal({
      title,
      message: initialMessage,
      progress: initialProgress,
      stage: "initializing",
      metrics: {},
      showSteps: true,
    });

    const bsModal = bootstrap.Modal.getOrCreateInstance(modal, {
      backdrop: "static",
      keyboard: false,
    });

    bsModal.show();
    this.activeModals.set(modalId, bsModal);

    return {
      update: (data) => this.updateProgressModal(data),
      hide: () => this.hideProgressModal(modalId),
    };
  }

  updateProgressModal(data) {
    const {
      title,
      message = "Processing...",
      progress = 0,
      stage = "unknown",
      metrics = {},
      error = null,
      showSteps = false,
    } = data;

    const modal = this.ui.getElement("taskProgressModal");
    if (!modal) return;

    // Update title
    if (title) {
      const titleEl = modal.querySelector(".modal-title");
      if (titleEl) titleEl.textContent = title;
    }

    // Update progress bar
    const progressBar = modal.querySelector(".progress-bar");
    if (progressBar) {
      this.ui.updateProgress(progressBar, progress, `${progress}%`);

      // Update bar style based on stage
      progressBar.className = "progress-bar";
      if (stage === "complete" || stage === "completed") {
        progressBar.classList.add("bg-success");
      } else if (stage === "error") {
        progressBar.classList.add("bg-danger");
      } else {
        progressBar.classList.add(
          "progress-bar-striped",
          "progress-bar-animated",
          "bg-primary",
        );
      }
    }

    // Update message
    const messageEl = modal.querySelector(".progress-message");
    if (messageEl) {
      messageEl.textContent = error ? `Error: ${error}` : message;
      messageEl.className = "progress-message text-center mb-3";

      if (stage === "error") {
        messageEl.classList.add("text-danger");
      } else if (stage === "complete" || stage === "completed") {
        messageEl.classList.add("text-success");
      }
    }

    // Update steps if shown
    if (showSteps) {
      this.updateProgressSteps(stage, progress);
    }

    // Update stage info
    const stageInfoEl = modal.querySelector(".stage-info");
    if (stageInfoEl) {
      const stageName = this.formatStageName(stage);
      const stageIcon = this.getStageIcon(stage);
      stageInfoEl.innerHTML = `${stageIcon} ${stageName}`;
      stageInfoEl.className = `stage-info mb-3 text-center text-${this.getStageTextClass(stage)}`;
    }

    // Update stats
    const statsInfoEl = modal.querySelector(".stats-info");
    if (statsInfoEl) {
      statsInfoEl.innerHTML = this.formatMetricStats(stage, metrics);
    }

    // Update cancel button
    const cancelBtn = modal.querySelector("#cancel-processing");
    if (cancelBtn) {
      cancelBtn.disabled = [
        "complete",
        "completed",
        "error",
        "canceled",
      ].includes(stage);
    }
  }

  updateProgressSteps(stage, progress) {
    const modal = this.ui.getElement("taskProgressModal");
    if (!modal) return;

    const steps = {
      initializing: modal.querySelector(".step-initializing"),
      preprocessing: modal.querySelector(".step-preprocessing"),
      indexing: modal.querySelector(".step-indexing"),
      calculating: modal.querySelector(".step-calculating"),
      complete: modal.querySelector(".step-complete"),
    };

    // Reset all steps
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
        if (iconEl) iconEl.className = "fas fa-check-circle";
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
        if (iconEl) iconEl.className = "fas fa-exclamation-triangle";
      }
    };

    // Apply step states based on stage
    switch (stage) {
      case "initializing":
        markActive("initializing");
        break;
      case "preprocessing":
      case "loading_streets":
        markComplete("initializing");
        markActive("preprocessing");
        break;
      case "indexing":
      case "post_preprocessing":
        markComplete("initializing");
        markComplete("preprocessing");
        markActive("indexing");
        break;
      case "counting_trips":
      case "processing_trips":
      case "calculating":
      case "finalizing":
      case "generating_geojson":
      case "complete_stats":
        markComplete("initializing");
        markComplete("preprocessing");
        markComplete("indexing");
        markActive("calculating");
        break;
      case "complete":
      case "completed":
        markComplete("initializing");
        markComplete("preprocessing");
        markComplete("indexing");
        markComplete("calculating");
        markComplete("complete");
        break;
      case "error":
        if (progress > 75) markError("calculating");
        else if (progress > 50) markError("indexing");
        else if (progress > 10) markError("preprocessing");
        else markError("initializing");
        break;
    }
  }

  hideProgressModal(modalId = "taskProgressModal") {
    const modal = this.ui.getElement(modalId);
    if (!modal) return;

    const bsModal =
      this.activeModals.get(modalId) || bootstrap.Modal.getInstance(modal);
    if (bsModal) {
      bsModal.hide();
      this.activeModals.delete(modalId);
    }
  }

  // Batch progress modal
  createBatchProgressModal(total) {
    const modalId = `batch-progress-${Date.now()}`;
    const modalHtml = `
        <div class="modal fade" id="${modalId}" tabindex="-1" data-bs-backdrop="static">
          <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content bg-dark text-white">
              <div class="modal-header">
                <h5 class="modal-title">
                  <i class="fas fa-sync-alt fa-spin me-2"></i>Batch Update Progress
                </h5>
              </div>
              <div class="modal-body">
                <div class="progress mb-3" style="height: 25px;">
                  <div class="progress-bar progress-bar-striped progress-bar-animated" 
                       role="progressbar" style="width: 0%">0 / ${total}</div>
                </div>
                <div class="text-center">
                  <div class="batch-stats">
                    <span class="text-success me-3">
                      <i class="fas fa-check-circle"></i> Completed: <span class="completed-count">0</span>
                    </span>
                    <span class="text-danger">
                      <i class="fas fa-times-circle"></i> Failed: <span class="failed-count">0</span>
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

    const container = document.createElement("div");
    container.innerHTML = modalHtml;
    const modalElement = container.firstElementChild;
    document.body.appendChild(modalElement);

    const bsModal = new bootstrap.Modal(modalElement);
    this.activeModals.set(modalId, bsModal);

    return {
      show: () => bsModal.show(),
      hide: () => {
        bsModal.hide();
        this.activeModals.delete(modalId);
        setTimeout(() => modalElement.remove(), 500);
      },
      updateProgress: (current, completed, failed) => {
        const percentage = (current / total) * 100;
        const progressBar = modalElement.querySelector(".progress-bar");
        this.ui.updateProgress(
          progressBar,
          percentage,
          `${current} / ${total}`,
        );
        modalElement.querySelector(".completed-count").textContent = completed;
        modalElement.querySelector(".failed-count").textContent = failed;
      },
    };
  }

  // Format helper methods
  formatStageName(stage) {
    const stageNames = {
      initializing: "Initializing",
      preprocessing: "Fetching Streets",
      loading_streets: "Loading Streets",
      indexing: "Building Index",
      counting_trips: "Analyzing Trips",
      processing_trips: "Processing Trips",
      calculating: "Calculating Coverage",
      finalizing: "Calculating Stats",
      generating_geojson: "Generating Map",
      complete_stats: "Finalizing",
      complete: "Complete",
      completed: "Complete",
      error: "Error",
      warning: "Warning",
      canceled: "Canceled",
      unknown: "Unknown",
    };
    return (
      stageNames[stage] ||
      stage.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
    );
  }

  getStageIcon(stage) {
    const icons = {
      initializing: '<i class="fas fa-cog fa-spin"></i>',
      preprocessing: '<i class="fas fa-map-marked-alt"></i>',
      loading_streets: '<i class="fas fa-map"></i>',
      indexing: '<i class="fas fa-project-diagram"></i>',
      counting_trips: '<i class="fas fa-calculator"></i>',
      processing_trips: '<i class="fas fa-route fa-spin"></i>',
      calculating: '<i class="fas fa-cogs fa-spin"></i>',
      finalizing: '<i class="fas fa-chart-line"></i>',
      generating_geojson: '<i class="fas fa-file-code fa-spin"></i>',
      complete_stats: '<i class="fas fa-check"></i>',
      complete: '<i class="fas fa-check-circle"></i>',
      completed: '<i class="fas fa-check-circle"></i>',
      error: '<i class="fas fa-exclamation-circle"></i>',
      warning: '<i class="fas fa-exclamation-triangle"></i>',
      canceled: '<i class="fas fa-ban"></i>',
      unknown: '<i class="fas fa-question-circle"></i>',
    };
    return icons[stage] || icons.unknown;
  }

  getStageTextClass(stage) {
    const classes = {
      complete: "text-success",
      completed: "text-success",
      error: "text-danger",
      warning: "text-warning",
      canceled: "text-warning",
    };
    return classes[stage] || "text-info";
  }

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

    // Add relevant stats based on available metrics
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
        this.ui.constructor.distanceInUserUnits(metrics.total_length_m),
        "",
        "fas fa-ruler-horizontal",
      );
    }
    if (
      metrics.processed_trips !== undefined &&
      metrics.total_trips_to_process !== undefined
    ) {
      const progress = (
        (metrics.processed_trips / metrics.total_trips_to_process) *
        100
      ).toFixed(1);
      addStat(
        "Trips Progress",
        `${progress}%`,
        "",
        "fas fa-route",
        "text-info",
      );
    }
    if (metrics.coverage_percentage !== undefined) {
      addStat(
        "Coverage",
        metrics.coverage_percentage.toFixed(1),
        "%",
        "fas fa-tachometer-alt",
        "text-success",
      );
    }

    statsHtml += "</div>";
    return statsHtml;
  }

  // Clean up all modals
  cleanup() {
    this.activeModals.forEach((modal, id) => {
      try {
        modal.hide();
      } catch (e) {
        console.warn(`Error hiding modal ${id}:`, e);
      }
    });
    this.activeModals.clear();
  }
}
