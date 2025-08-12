"use strict";

// Classic script for progress modal and polling utilities.
// Exposes: window.CoverageModules.Progress

(() => {
  window.CoverageModules = window.CoverageModules || {};

  const STATUS = window.STATUS || {};

  const Progress = {
    async pollCoverageProgress(manager, taskId) {
      const maxRetries = 600;
      let retries = 0;
      let lastStage = null;
      let consecutiveSameStage = 0;

      while (retries < maxRetries) {
        try {
          const response = await fetch(`/api/coverage_progress/${taskId}`);
          const data = await response.json();
          if (!response.ok)
            throw new Error(data.error || "Failed to fetch progress");

          manager.lastActivityTime = new Date();
          manager.updateModalContent?.(data);
          manager.updateTimingInfo?.();
          manager.updateActivityIndicator?.();
          (manager.constructor.updateStepIndicators || (() => {}))(
            data.stage,
            data.progress || 0,
          );

          if ([STATUS.COMPLETE, STATUS.COMPLETED].includes(data.stage)) {
            manager.activeTaskIds.delete(taskId);
            manager._removeBeforeUnloadListener?.();
            manager.showSuccessAnimation?.();
            manager.hideProgressModal?.();
            return data;
          } else if (data.stage === STATUS.ERROR) {
            const errorMessage = data.error || data.message || "Unknown error";
            manager.notificationManager?.show(
              `Task failed: ${errorMessage}`,
              "danger",
            );
            manager.activeTaskIds.delete(taskId);
            manager._removeBeforeUnloadListener?.();
            manager.showErrorState?.(errorMessage);
            throw new Error(
              data.error || data.message || "Coverage calculation failed",
            );
          } else if (data.stage === STATUS.CANCELED) {
            manager.notificationManager?.show(`Task was canceled.`, "warning");
            manager.activeTaskIds.delete(taskId);
            manager._removeBeforeUnloadListener?.();
            manager.hideProgressModal?.();
            throw new Error("Task was canceled");
          }

          if (data.stage === lastStage) {
            consecutiveSameStage++;
            if (consecutiveSameStage > 12) {
              manager.notificationManager?.show(
                `Task seems stalled at: ${manager.constructor.formatStageName(data.stage)}`,
                "warning",
              );
              consecutiveSameStage = 0;
            }
          } else {
            lastStage = data.stage;
            consecutiveSameStage = 0;
          }

          const pollInterval = Progress.calculatePollInterval(
            data.stage,
            retries,
          );
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
          retries++;
        } catch (error) {
          manager.notificationManager?.show(
            `Error polling progress: ${error.message}`,
            "danger",
          );
          manager.updateModalContent?.({
            stage: STATUS.ERROR,
            progress: manager.currentProcessingLocation?.progress || 0,
            message: `Polling failed: ${error.message}`,
            error: error.message,
            metrics: {},
          });
          (manager.constructor.updateStepIndicators || (() => {}))(
            STATUS.ERROR,
            manager.currentProcessingLocation?.progress || 0,
          );
          manager.activeTaskIds.delete(taskId);
          manager._removeBeforeUnloadListener?.();
          manager.showRetryOption?.(taskId);
          throw error;
        }
      }

      manager.notificationManager?.show(
        `Polling timed out after ${Math.round((maxRetries * Progress.calculatePollInterval(STATUS.UNKNOWN, maxRetries - 1)) / 60000)} minutes.`,
        "danger",
      );
      manager.updateModalContent?.({
        stage: STATUS.ERROR,
        progress: manager.currentProcessingLocation?.progress || 99,
        message: "Polling timed out waiting for completion.",
        error: "Polling timed out",
        metrics: {},
      });
      (manager.constructor.updateStepIndicators || (() => {}))(
        STATUS.ERROR,
        manager.currentProcessingLocation?.progress || 99,
      );
      manager.activeTaskIds.delete(taskId);
      manager._removeBeforeUnloadListener?.();
      throw new Error("Coverage calculation polling timed out");
    },

    calculatePollInterval(stage, retries) {
      const baseInterval = 5000;
      if (stage === STATUS.PROCESSING_TRIPS || stage === STATUS.CALCULATING)
        return Math.min(baseInterval * 2, 15000);
      if (retries > 100) return Math.min(baseInterval * 3, 20000);
      return baseInterval;
    },

    showSuccessAnimation() {
      const modal = document.getElementById("taskProgressModal");
      if (!modal) return;
      const modalBody = modal.querySelector(".modal-body");
      const successIcon = document.createElement("div");
      successIcon.className = "text-center my-4 fade-in-up";
      successIcon.innerHTML = `
        <i class="fas fa-check-circle text-success" style="font-size: 4rem;"></i>
        <h4 class="mt-3 text-success">Processing Complete!</h4>`;
      modalBody.appendChild(successIcon);
      setTimeout(() => successIcon.remove(), 1500);
    },

    showErrorState(manager, errorMessage) {
      const modal = document.getElementById("taskProgressModal");
      if (!modal) return;
      const footer = modal.querySelector(".modal-footer");
      const retryBtn = document.createElement("button");
      retryBtn.className = "btn btn-primary";
      retryBtn.innerHTML = '<i class="fas fa-redo me-1"></i>Retry';
      retryBtn.onclick = () => {
        manager.hideProgressModal?.();
        if (manager.currentProcessingLocation) {
          manager.resumeInterruptedTask?.({
            location: manager.currentProcessingLocation,
            taskId: manager.currentTaskId,
            progress: 0,
          });
        }
      };
      footer.insertBefore(retryBtn, footer.firstChild);
    },

    showRetryOption(manager, taskId) {
      const modal = document.getElementById("taskProgressModal");
      if (!modal) return;
      const modalBody = modal.querySelector(".modal-body");
      const retrySection = document.createElement("div");
      retrySection.className = "alert alert-warning mt-3 fade-in-up";
      retrySection.innerHTML = `
        <p class="mb-2">The operation failed. Would you like to retry?</p>
        <button class="btn btn-sm btn-primary retry-task-btn">
          <i class="fas fa-redo me-1"></i>Retry
        </button>`;
      retrySection.querySelector(".retry-task-btn").onclick = () => {
        retrySection.remove();
        manager.activeTaskIds.add(taskId);
        manager._addBeforeUnloadListener?.();
        Progress.pollCoverageProgress(manager, taskId).catch(console.error);
      };
      modalBody.appendChild(retrySection);
    },

    showProgressModal(manager, message = "Processing...", progress = 0) {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement) return;
      const modalTitle = modalElement.querySelector(".modal-title");
      const modalProgressBar = modalElement.querySelector(".progress-bar");
      const progressMessage = modalElement.querySelector(".progress-message");
      const progressDetails = modalElement.querySelector(".progress-details");
      const cancelBtn = document.getElementById("cancel-processing");
      if (!progressDetails) {
        manager.notificationManager?.show(
          "UI Error: Progress details container not found.",
          "danger",
        );
        return;
      }
      if (modalTitle) {
        modalTitle.textContent = manager.currentProcessingLocation?.display_name
          ? `Processing: ${manager.currentProcessingLocation.display_name}`
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
      progressDetails.querySelector(".elapsed-time").textContent =
        "Elapsed: 0s";
      progressDetails.querySelector(".estimated-time").textContent = "";
      if (cancelBtn) cancelBtn.disabled = false;
      if (manager.progressTimer) clearInterval(manager.progressTimer);
      manager.processingStartTime = Date.now();
      manager.lastActivityTime = Date.now();
      manager.progressTimer = setInterval(() => {
        manager.updateTimingInfo?.();
        manager.updateActivityIndicator?.();
      }, 1000);
      manager.updateTimingInfo?.();
      manager.updateActivityIndicator?.();
      const bsModal = bootstrap.Modal.getOrCreateInstance(modalElement, {
        backdrop: "static",
        keyboard: false,
      });
      modalElement.classList.add("fade-in-up");
      bsModal.show();
    },

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
    },
  };

  window.CoverageModules.Progress = Progress;
})();
