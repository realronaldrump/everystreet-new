"use strict";

// Shared helpers used by coverage management and related UIs.
// Classic script (non-module) to keep compatibility with existing pages.

(() => {
  const UI = {
    distanceInUserUnits(meters, fixed = 2) {
      if (typeof meters !== "number" || isNaN(meters)) meters = 0;
      const miles = meters * 0.000621371;
      return miles < 0.1 ? `${(meters * 3.28084).toFixed(0)} ft` : `${miles.toFixed(fixed)} mi`;
    },
    showToast(message, type = "info", duration = 3000) {
      const container = document.getElementById("alerts-container");
      if (!container) return;

      const toast = document.createElement("div");
      toast.className = `alert alert-${type} alert-dismissible fade show fade-in-up`;
      toast.setAttribute("role", "alert");

      const icon =
        {
          success: "fa-check-circle",
          danger: "fa-exclamation-circle",
          warning: "fa-exclamation-triangle",
          info: "fa-info-circle",
        }[type] || "fa-info-circle";

      toast.innerHTML = `
        <i class="fas ${icon} me-2"></i>
        <span>${message}</span>
        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
      `;

      container.prepend(toast);
      UI.announceToScreenReader(message);

      if (duration > 0) {
        setTimeout(() => {
          const bsAlert = bootstrap.Alert.getOrCreateInstance(toast);
          if (bsAlert) bsAlert.close();
        }, duration);
      }

      toast.addEventListener("closed.bs.alert", () => toast.remove());
    },

    announceToScreenReader(message) {
      const region = document.getElementById("coverage-live-region");
      if (!region) return;
      region.textContent = message;
      setTimeout(() => (region.textContent = ""), 1000);
    },

    async showEnhancedConfirmDialog(options = {}) {
      return new Promise((resolve) => {
        const modalHtml = `
          <div class="modal fade" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-dialog-centered">
              <div class="modal-content bg-dark text-white">
                <div class="modal-header">
                  <h5 class="modal-title">${options.title || "Confirm Action"}</h5>
                  <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Close"></button>
                </div>
                <div class="modal-body">
                  <p>${options.message || "Are you sure?"}</p>
                  ${options.details ? `<small class="text-muted">${options.details}</small>` : ""}
                </div>
                <div class="modal-footer">
                  <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">${options.cancelText || "Cancel"}</button>
                  <button type="button" class="btn ${options.confirmButtonClass || "btn-primary"}" data-action="confirm">${options.confirmText || "Confirm"}</button>
                </div>
              </div>
            </div>
          </div>`;

        const wrapper = document.createElement("div");
        wrapper.innerHTML = modalHtml;
        const modal = wrapper.firstElementChild;
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
    },
  };

  function setupConnectionMonitoring(onSyncPending) {
    let offlineTimer = null;
    const handleConnectionChange = () => {
      const isOnline = navigator.onLine;
      const alertsContainer = document.querySelector("#alerts-container");
      if (!alertsContainer) return;
      alertsContainer.querySelectorAll(".connection-status").forEach((el) => el.remove());
      if (!isOnline) {
        const statusBar = document.createElement("div");
        statusBar.className = "connection-status alert alert-danger fade show";
        statusBar.innerHTML = `
          <i class=\"fas fa-wifi-slash me-2\"></i>
          <strong>Offline</strong> - Changes cannot be saved while offline.
          <div class=\"mt-2\"><small>Your work will be saved locally and synced when connection is restored.</small></div>`;
        alertsContainer.insertBefore(statusBar, alertsContainer.firstChild);
        offlineTimer = setInterval(() => {
          if (navigator.onLine) {
            clearInterval(offlineTimer);
            handleConnectionChange();
          }
        }, 5000);
      } else {
        if (offlineTimer) {
          clearInterval(offlineTimer);
          offlineTimer = null;
        }
        const statusBar = document.createElement("div");
        statusBar.className = "connection-status alert alert-success alert-dismissible fade show";
        statusBar.innerHTML = `
          <i class=\"fas fa-wifi me-2\"></i>
          <strong>Connected</strong> - Connection restored.
          <button type=\"button\" class=\"btn-close\" data-bs-dismiss=\"alert\" aria-label=\"Close\"></button>`;
        alertsContainer.insertBefore(statusBar, alertsContainer.firstChild);
        setTimeout(() => {
          const bsAlert = bootstrap.Alert.getOrCreateInstance(statusBar);
          if (bsAlert) bsAlert.close();
        }, 5000);
        if (typeof onSyncPending === "function") onSyncPending();
      }
    };
    window.addEventListener("online", handleConnectionChange);
    window.addEventListener("offline", handleConnectionChange);
    handleConnectionChange();
  }

  class RenderQueue {
    constructor(targetFps = 60) {
      this.queue = [];
      this.isProcessing = false;
      this.lastRenderTime = 0;
      this.targetFps = targetFps;
      this.frameTime = 1000 / targetFps;
      this._rafId = null;
    }

    enqueue(fn) {
      if (typeof fn === "function") this.queue.push(fn);
    }

    _processNow() {
      if (this.isProcessing || this.queue.length === 0) return;
      this.isProcessing = true;
      const start = performance.now();
      while (this.queue.length > 0 && performance.now() - start < this.frameTime * 0.8) {
        const task = this.queue.shift();
        try {
          task();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("Render task error:", err);
        }
      }
      this.isProcessing = false;
    }

    start() {
      const loop = (ts) => {
        if (ts - this.lastRenderTime >= this.frameTime) {
          this._processNow();
          this.lastRenderTime = ts;
        }
        this._rafId = requestAnimationFrame(loop);
      };
      this._rafId = requestAnimationFrame(loop);
    }

    stop() {
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    process() {
      this._processNow();
    }
  }

  window.CoverageShared = { UI, RenderQueue, setupConnectionMonitoring };
})();


