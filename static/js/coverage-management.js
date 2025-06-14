/* eslint-disable complexity */
/* global bootstrap, Chart, mapboxgl, html2canvas, $*/
"use strict";

const STATUS = window.STATUS || {
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
  POLLING_CHECK: "polling_check",
  POST_PREPROCESSING: "post_preprocessing",
};

(() => {
  class CoverageManager {
    constructor() {
      this.map = null;
      this.coverageMap = null;
      this.streetsGeoJson = null;
      this.mapBounds = null;

      this.selectedLocation = null;
      this.currentDashboardLocationId = null;
      this.currentProcessingLocation = null;
      this.processingStartTime = null;
      this.lastProgressUpdate = null;
      this.progressTimer = null;
      this.activeTaskIds = new Set();
      this.currentTaskId = null;
      this.validatedLocation = null;
      this.currentFilter = "all";
      this.lastActivityTime = null;
      this.showTripsActive = false;
      this.loadTripsDebounceTimer = null;

      this.tooltips = [];
      this.mapInfoPanel = null;
      this.coverageSummaryControl = null;
      this.streetTypeChartInstance = null;

      // Enhanced state management
      this.pendingOperations = new Map();
      this.operationHistory = [];
      this.maxHistorySize = 50;
      this.retryAttempts = new Map();
      this.maxRetries = 3;
      this.animationFrameId = null;
      this.keyboardShortcuts = new Map();

      // Performance optimization
      this.renderQueue = [];
      this.isRendering = false;
      this.lastRenderTime = 0;
      this.targetFPS = 60;
      this.frameTime = 1000 / this.targetFPS;

      // Cache management
      this.dataCache = new Map();
      this.cacheTimeout = 5 * 60 * 1000; // 5 minutes

      // For beforeunload listener
      this.boundSaveProcessingState = this.saveProcessingState.bind(this);
      this.isBeforeUnloadListenerActive = false;

      // Add to the constructor
      this.efficientStreetMarkers = [];
      this.suggestedEfficientStreets = [];

      // Drawing interface properties
      this.drawingMap = null;
      this.drawingMapDraw = null;
      this.validatedCustomBoundary = null;
      this.currentAreaDefinitionType = "location";

      this.notificationManager = window.notificationManager || {
        show: (message, type, duration = 3000) => {
          console.log(`[${type || "info"}] Notification: ${message}`);
          this.showToast(message, type, duration);
        },
      };

      this.confirmationDialog = window.confirmationDialog || {
        show: async (options) => {
          return await this.showEnhancedConfirmDialog(options);
        },
      };

      this.initializeKeyboardShortcuts();
      this.setupAutoRefresh();
      this.checkForInterruptedTasks();
      CoverageManager.setupConnectionMonitoring();
      this.initTooltips();
      this.createMapInfoPanel();
      this.setupEventListeners();
      this.loadCoverageAreas();
      this.initializeQuickActions();
      this.setupAccessibility();
      this.startRenderLoop();

      // Add cleanup tracking
      this._activeIntervals = new Set();
      this._activeTimeouts = new Set();
      this._activeEventSources = new Set();
      this.sseReconnectAttempts = 0;

      // Container reference for undriven streets list
      this.undrivenStreetsContainer = null;
      this.undrivenSortCriterion = "length_desc";
      this.undrivenSortSelect = null;
    }

    // Override setTimeout and setInterval to track them
    _setTimeout(fn, delay) {
      const timeoutId = setTimeout(() => {
        fn();
        this._activeTimeouts.delete(timeoutId);
      }, delay);
      this._activeTimeouts.add(timeoutId);
      return timeoutId;
    }

    _setInterval(fn, delay) {
      const intervalId = setInterval(fn, delay);
      this._activeIntervals.add(intervalId);
      return intervalId;
    }

    setupEventSource() {
      // Clean up any existing connection
      if (this.eventSource) {
        this.eventSource.close();
        this._activeEventSources.delete(this.eventSource);
        this.eventSource = null;
      }

      try {
        this.eventSource = new EventSource("/api/background_tasks/sse");
        this._activeEventSources.add(this.eventSource);

        // Add connection timeout
        const connectionTimeout = this._setTimeout(() => {
          if (
            this.eventSource &&
            this.eventSource.readyState !== EventSource.OPEN
          ) {
            console.warn(
              "EventSource connection timeout, falling back to polling",
            );
            this.eventSource.close();
            this._activeEventSources.delete(this.eventSource);
            this.eventSource = null;
            this.setupPolling();
          }
        }, 5000);

        this.eventSource.onopen = () => {
          clearTimeout(connectionTimeout);
          this._activeTimeouts.delete(connectionTimeout);
        };

        this.eventSource.onmessage = (event) => {
          try {
            const updates = JSON.parse(event.data);
            this.processEventSourceUpdate(updates);
          } catch (error) {
            console.error("Error processing SSE update:", error);
          }
        };

        this.eventSource.onerror = (error) => {
          console.error("SSE connection error:", error);
          clearTimeout(connectionTimeout);
          this._activeTimeouts.delete(connectionTimeout);

          if (this.eventSource) {
            this.eventSource.close();
            this._activeEventSources.delete(this.eventSource);
            this.eventSource = null;
          }

          // Use exponential backoff for reconnection
          const backoffDelay = Math.min(
            5000 * Math.pow(2, this.sseReconnectAttempts || 0),
            30000,
          );
          this.sseReconnectAttempts = (this.sseReconnectAttempts || 0) + 1;

          this._setTimeout(() => {
            this.setupEventSource();
          }, backoffDelay);
        };
      } catch (error) {
        console.error("Error setting up EventSource:", error);
        this.setupPolling();
      }
    }

    setupPolling() {
      // Clean up existing polling
      if (this.pollingInterval) {
        clearInterval(this.pollingInterval);
        this._activeIntervals.delete(this.pollingInterval);
        this.pollingInterval = null;
      }

      const pollInterval = 15000; // Fixed 15 second interval

      this.pollingInterval = this._setInterval(() => {
        // Only poll if we're actually visible
        if (document.visibilityState === "visible") {
          this.loadTaskConfig();
          this.updateTaskHistory();
        }
      }, pollInterval);
    }

    // Add cleanup method
    cleanup() {
      // Clear all timeouts
      this._activeTimeouts.forEach((timeoutId) => clearTimeout(timeoutId));
      this._activeTimeouts.clear();

      // Clear all intervals
      this._activeIntervals.forEach((intervalId) => clearInterval(intervalId));
      this._activeIntervals.clear();

      // Close all event sources
      this._activeEventSources.forEach((eventSource) => eventSource.close());
      this._activeEventSources.clear();

      // Clean up main references
      if (this.pollingInterval) {
        clearInterval(this.pollingInterval);
        this.pollingInterval = null;
      }

      if (this.configRefreshTimeout) {
        clearTimeout(this.configRefreshTimeout);
        this.configRefreshTimeout = null;
      }

      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }

      // Cancel animation frame
      if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
    }

    // Ensure cleanup on page unload
    _setupCleanupListener() {
      if (!this.isBeforeUnloadListenerActive) {
        this.boundCleanup = () => this.cleanup();
        window.addEventListener("beforeunload", this.boundCleanup);
        this.isBeforeUnloadListenerActive = true;
      }
    }

    _removeCleanupListener() {
      if (this.isBeforeUnloadListenerActive && this.boundCleanup) {
        window.removeEventListener("beforeunload", this.boundCleanup);
        this.isBeforeUnloadListenerActive = false;
      }
    }

    _addBeforeUnloadListener() {
      if (!this.isBeforeUnloadListenerActive) {
        window.addEventListener("beforeunload", this.boundSaveProcessingState);
        this.isBeforeUnloadListenerActive = true;
        console.info("BeforeUnload listener added.");
      }
    }

    _removeBeforeUnloadListener() {
      if (this.isBeforeUnloadListenerActive) {
        window.removeEventListener(
          "beforeunload",
          this.boundSaveProcessingState,
        );
        this.isBeforeUnloadListenerActive = false;
        console.info("BeforeUnload listener removed.");
      }
    }

    // Enhanced initialization methods
    initializeKeyboardShortcuts() {
      this.keyboardShortcuts.set("ctrl+n", () => {
        const modal = bootstrap.Modal.getOrCreateInstance(
          document.getElementById("addAreaModal"),
        );
        modal.show();
      });

      this.keyboardShortcuts.set("ctrl+r", () => {
        this.loadCoverageAreas();
      });

      this.keyboardShortcuts.set("escape", () => {
        if (this.currentProcessingLocation) {
          this.cancelProcessing(this.currentProcessingLocation);
        }
      });

      document.addEventListener("keydown", (e) => {
        const key = `${e.ctrlKey ? "ctrl+" : ""}${e.key.toLowerCase()}`;
        const handler = this.keyboardShortcuts.get(key);
        if (handler && !e.target.matches("input, textarea, select")) {
          e.preventDefault();
          handler();
        }
      });
    }

    setupAccessibility() {
      // Add ARIA live regions for dynamic updates
      const liveRegion = document.createElement("div");
      liveRegion.setAttribute("aria-live", "polite");
      liveRegion.setAttribute("aria-atomic", "true");
      liveRegion.className = "visually-hidden";
      liveRegion.id = "coverage-live-region";
      document.body.appendChild(liveRegion);

      // Enhance table accessibility
      const table = document.getElementById("coverage-areas-table");
      if (table) {
        table.setAttribute("role", "table");
        table.setAttribute("aria-label", "Coverage areas data");
      }

      // Add keyboard navigation to map controls
      this.setupMapKeyboardNavigation();
    }

    setupMapKeyboardNavigation() {
      if (!this.coverageMap) return;

      const mapContainer = document.getElementById("coverage-map");
      if (!mapContainer) return;

      mapContainer.setAttribute("tabindex", "0");
      mapContainer.setAttribute("role", "application");
      mapContainer.setAttribute("aria-label", "Interactive coverage map");

      mapContainer.addEventListener("keydown", (e) => {
        if (!this.coverageMap) return;

        const step = e.shiftKey ? 50 : 10;
        switch (e.key) {
          case "ArrowUp":
            e.preventDefault();
            this.coverageMap.panBy([0, -step]);
            break;
          case "ArrowDown":
            e.preventDefault();
            this.coverageMap.panBy([0, step]);
            break;
          case "ArrowLeft":
            e.preventDefault();
            this.coverageMap.panBy([-step, 0]);
            break;
          case "ArrowRight":
            e.preventDefault();
            this.coverageMap.panBy([step, 0]);
            break;
          case "+":
          case "=":
            e.preventDefault();
            this.coverageMap.zoomIn();
            break;
          case "-":
          case "_":
            e.preventDefault();
            this.coverageMap.zoomOut();
            break;
        }
      });
    }

    showToast(message, type = "info", duration = 3000) {
      const toastContainer = document.getElementById("alerts-container");
      if (!toastContainer) return;

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

      toastContainer.prepend(toast);

      // Announce to screen readers
      this.announceToScreenReader(message);

      // Auto dismiss
      if (duration > 0) {
        setTimeout(() => {
          const bsAlert = bootstrap.Alert.getOrCreateInstance(toast);
          if (bsAlert) {
            bsAlert.close();
          }
        }, duration);
      }

      // Remove after animation
      toast.addEventListener("closed.bs.alert", () => {
        toast.remove();
      });
    }

    announceToScreenReader(message) {
      const liveRegion = document.getElementById("coverage-live-region");
      if (liveRegion) {
        liveRegion.textContent = message;
        setTimeout(() => {
          liveRegion.textContent = "";
        }, 1000);
      }
    }

    async showEnhancedConfirmDialog(options) {
      return new Promise((resolve) => {
        const modalHtml = `
          <div class="modal fade" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-dialog-centered">
              <div class="modal-content bg-dark text-white">
                <div class="modal-header">
                  <h5 class="modal-title">${
                    options.title || "Confirm Action"
                  }</h5>
                  <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Close"></button>
                </div>
                <div class="modal-body">
                  <p>${options.message || "Are you sure?"}</p>
                  ${
                    options.details
                      ? `<small class="text-muted">${options.details}</small>`
                      : ""
                  }
                </div>
                <div class="modal-footer">
                  <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                    ${options.cancelText || "Cancel"}
                  </button>
                  <button type="button" class="btn ${
                    options.confirmButtonClass || "btn-primary"
                  }" data-action="confirm">
                    ${options.confirmText || "Confirm"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        `;

        const modalElement = document.createElement("div");
        modalElement.innerHTML = modalHtml;
        const modal = modalElement.firstElementChild;
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

    startRenderLoop() {
      const render = (timestamp) => {
        if (timestamp - this.lastRenderTime >= this.frameTime) {
          this.processRenderQueue();
          this.lastRenderTime = timestamp;
        }
        this.animationFrameId = requestAnimationFrame(render);
      };
      this.animationFrameId = requestAnimationFrame(render);
    }

    queueRender(fn) {
      this.renderQueue.push(fn);
    }

    processRenderQueue() {
      if (this.isRendering || this.renderQueue.length === 0) return;

      this.isRendering = true;
      const startTime = performance.now();

      while (
        this.renderQueue.length > 0 &&
        performance.now() - startTime < this.frameTime * 0.8
      ) {
        const fn = this.renderQueue.shift();
        try {
          fn();
        } catch (error) {
          console.error("Render error:", error);
        }
      }

      this.isRendering = false;
    }

    // Cache management
    getCachedData(key) {
      const cached = this.dataCache.get(key);
      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.data;
      }
      this.dataCache.delete(key);
      return null;
    }

    setCachedData(key, data) {
      this.dataCache.set(key, {
        data,
        timestamp: Date.now(),
      });
    }

    clearCache() {
      this.dataCache.clear();
    }

    // Operation history management
    addToHistory(operation) {
      this.operationHistory.push({
        ...operation,
        timestamp: Date.now(),
      });

      if (this.operationHistory.length > this.maxHistorySize) {
        this.operationHistory.shift();
      }
    }

    getLastOperation(type) {
      for (let i = this.operationHistory.length - 1; i >= 0; i--) {
        if (this.operationHistory[i].type === type) {
          return this.operationHistory[i];
        }
      }
      return null;
    }

    // Retry mechanism
    async retryOperation(operation, error) {
      const key = operation.id || operation.toString();
      const attempts = this.retryAttempts.get(key) || 0;

      if (attempts >= this.maxRetries) {
        this.retryAttempts.delete(key);
        throw new Error(
          `Operation failed after ${this.maxRetries} attempts: ${error.message}`,
        );
      }

      this.retryAttempts.set(key, attempts + 1);

      // Exponential backoff
      const delay = Math.min(1000 * Math.pow(2, attempts), 10000);
      await new Promise((resolve) => setTimeout(resolve, delay));

      try {
        const result = await operation();
        this.retryAttempts.delete(key);
        return result;
      } catch (retryError) {
        return this.retryOperation(operation, retryError);
      }
    }

    // Enhanced utility methods
    static distanceInUserUnits(meters, fixed = 2) {
      if (typeof meters !== "number" || isNaN(meters)) {
        meters = 0;
      }
      const miles = meters * 0.000621371;
      return miles < 0.1
        ? `${(meters * 3.28084).toFixed(0)} ft`
        : `${miles.toFixed(fixed)} mi`;
    }

    static setupConnectionMonitoring() {
      let offlineTimer = null;

      const handleConnectionChange = () => {
        const isOnline = navigator.onLine;
        const alertsContainer = document.querySelector("#alerts-container");
        if (!alertsContainer) return;

        // Clear existing connection status alerts
        alertsContainer
          .querySelectorAll(".connection-status")
          .forEach((el) => el.remove());

        if (!isOnline) {
          // Show persistent offline warning
          const statusBar = document.createElement("div");
          statusBar.className =
            "connection-status alert alert-danger fade show";
          statusBar.innerHTML = `
            <i class="fas fa-wifi-slash me-2"></i>
            <strong>Offline</strong> - Changes cannot be saved while offline.
            <div class="mt-2">
              <small>Your work will be saved locally and synced when connection is restored.</small>
            </div>
          `;
          alertsContainer.insertBefore(statusBar, alertsContainer.firstChild);

          // Start monitoring for reconnection
          offlineTimer = setInterval(() => {
            if (navigator.onLine) {
              clearInterval(offlineTimer);
              handleConnectionChange();
            }
          }, 5000);
        } else {
          // Show temporary online confirmation
          if (offlineTimer) {
            clearInterval(offlineTimer);
            offlineTimer = null;
          }

          const statusBar = document.createElement("div");
          statusBar.className =
            "connection-status alert alert-success alert-dismissible fade show";
          statusBar.innerHTML = `
            <i class="fas fa-wifi me-2"></i>
            <strong>Connected</strong> - Connection restored.
            <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
          `;
          alertsContainer.insertBefore(statusBar, alertsContainer.firstChild);

          // Auto-dismiss after animation
          setTimeout(() => {
            const bsAlert = bootstrap.Alert.getOrCreateInstance(statusBar);
            if (bsAlert) {
              bsAlert.close();
            }
          }, 5000);

          // Sync any pending operations
          if (window.coverageManager) {
            window.coverageManager.syncPendingOperations();
          }
        }
      };

      window.addEventListener("online", handleConnectionChange);
      window.addEventListener("offline", handleConnectionChange);
      handleConnectionChange();
    }

    syncPendingOperations() {
      if (this.pendingOperations.size === 0) return;

      this.notificationManager.show("Syncing pending operations...", "info");

      const operations = Array.from(this.pendingOperations.values());
      Promise.allSettled(operations.map((op) => op())).then((results) => {
        const successful = results.filter(
          (r) => r.status === "fulfilled",
        ).length;
        const failed = results.filter((r) => r.status === "rejected").length;

        if (successful > 0) {
          this.notificationManager.show(
            `Synced ${successful} operation${successful > 1 ? "s" : ""}`,
            "success",
          );
        }

        if (failed > 0) {
          this.notificationManager.show(
            `Failed to sync ${failed} operation${failed > 1 ? "s" : ""}`,
            "warning",
          );
        }

        this.pendingOperations.clear();
        this.loadCoverageAreas();
      });
    }

    initTooltips() {
      this.queueRender(() => {
        // Dispose existing tooltips
        this.tooltips.forEach((tooltip) => {
          if (tooltip && typeof tooltip.dispose === "function") {
            tooltip.dispose();
          }
        });
        this.tooltips = [];

        // Initialize new tooltips with enhanced options
        const tooltipTriggerList = document.querySelectorAll(
          '[data-bs-toggle="tooltip"]',
        );
        this.tooltips = [...tooltipTriggerList].map((tooltipTriggerEl) => {
          return new bootstrap.Tooltip(tooltipTriggerEl, {
            animation: true,
            delay: { show: 500, hide: 100 },
            html: true,
            placement: "auto",
          });
        });
      });
    }

    static enhanceResponsiveTables() {
      const tables = document.querySelectorAll("#coverage-areas-table");
      tables.forEach((table) => {
        const headers = Array.from(table.querySelectorAll("thead th")).map(
          (th) => th.textContent.trim(),
        );
        const rows = table.querySelectorAll("tbody tr");
        rows.forEach((row) => {
          const cells = row.querySelectorAll("td");
          cells.forEach((cell, i) => {
            if (headers[i]) {
              cell.setAttribute("data-label", headers[i]);
            }
          });
        });
      });
    }

    initializeQuickActions() {
      // Quick refresh all
      document
        .getElementById("quick-refresh-all")
        ?.addEventListener("click", async () => {
          const areas = await this.getAllCoverageAreas();
          if (areas.length === 0) {
            this.notificationManager.show(
              "No coverage areas to refresh",
              "info",
            );
            return;
          }

          const confirmed = await this.confirmationDialog.show({
            title: "Refresh All Coverage Areas",
            message: `This will update coverage data for all ${
              areas.length
            } area${areas.length > 1 ? "s" : ""}. This may take some time.`,
            confirmText: "Refresh All",
            confirmButtonClass: "btn-primary",
          });

          if (confirmed) {
            this.batchUpdateCoverageAreas(areas);
          }
        });

      // Quick export data
      document
        .getElementById("quick-export-data")
        ?.addEventListener("click", () => {
          this.exportAllCoverageData();
        });

      // Refresh table button
      document
        .getElementById("refresh-table-btn")
        ?.addEventListener("click", () => {
          this.loadCoverageAreas(true);
        });

      // Close dashboard button
      document
        .getElementById("close-dashboard-btn")
        ?.addEventListener("click", () => {
          this.closeCoverageDashboard();
        });

      // Add to initializeQuickActions() or setupEventListeners()
      document
        .getElementById("find-efficient-street-btn")
        ?.addEventListener("click", () => {
          this.findMostEfficientStreets();
        });
    }

    async getAllCoverageAreas() {
      try {
        const response = await fetch("/api/coverage_areas");
        if (!response.ok) throw new Error("Failed to fetch coverage areas");
        const data = await response.json();
        return data.areas || [];
      } catch (error) {
        console.error("Error fetching coverage areas:", error);
        return [];
      }
    }

    async batchUpdateCoverageAreas(areas) {
      const progressModal = this.createBatchProgressModal(areas.length);
      progressModal.show();

      let completed = 0;
      let failed = 0;

      for (const area of areas) {
        try {
          await this.updateCoverageForArea(area._id, "incremental", false);
          completed++;
        } catch (error) {
          console.error(
            `Failed to update ${area.location?.display_name}:`,
            error,
          );
          failed++;
        }

        progressModal.updateProgress(completed + failed, completed, failed);

        // Brief pause between updates to avoid overwhelming the server
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      progressModal.hide();

      this.notificationManager.show(
        `Batch update complete: ${completed} succeeded, ${failed} failed`,
        failed > 0 ? "warning" : "success",
        5000,
      );

      this.loadCoverageAreas();
    }

    createBatchProgressModal(total) {
      const modalHtml = `
        <div class="modal fade" id="batchProgressModal" tabindex="-1" data-bs-backdrop="static">
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

      return {
        show: () => bsModal.show(),
        hide: () => {
          bsModal.hide();
          setTimeout(() => modalElement.remove(), 500);
        },
        updateProgress: (current, completed, failed) => {
          const percentage = (current / total) * 100;
          const progressBar = modalElement.querySelector(".progress-bar");
          progressBar.style.width = `${percentage}%`;
          progressBar.textContent = `${current} / ${total}`;
          modalElement.querySelector(".completed-count").textContent =
            completed;
          modalElement.querySelector(".failed-count").textContent = failed;
        },
      };
    }

    async exportAllCoverageData() {
      const areas = await this.getAllCoverageAreas();
      if (areas.length === 0) {
        this.notificationManager.show("No coverage data to export", "info");
        return;
      }

      const exportData = {
        exportDate: new Date().toISOString(),
        totalAreas: areas.length,
        areas: areas.map((area) => ({
          location: area.location?.display_name,
          totalLength: area.total_length,
          drivenLength: area.driven_length,
          coveragePercentage: area.coverage_percentage,
          totalSegments: area.total_segments,
          lastUpdated: area.last_updated,
          streetTypes: area.street_types,
        })),
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: "application/json",
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `coverage_export_${
        new Date().toISOString().split("T")[0]
      }.json`;
      document.body.appendChild(a);
      a.click();

      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);

      this.notificationManager.show(
        "Coverage data exported successfully",
        "success",
      );
    }

    closeCoverageDashboard() {
      const dashboard = document.getElementById("coverage-dashboard");
      if (dashboard) {
        dashboard.style.opacity = "0";
        dashboard.style.transform = "translateY(20px)";

        setTimeout(() => {
          dashboard.style.display = "none";
          dashboard.style.opacity = "";
          dashboard.style.transform = "";
          this.clearDashboardUI();
        }, 300);
      }
    }

    setupAutoRefresh() {
      setInterval(async () => {
        const isProcessingRow = document.querySelector(".processing-row");
        const isModalProcessing =
          this.currentProcessingLocation &&
          document
            .getElementById("taskProgressModal")
            ?.classList.contains("show");

        if (isProcessingRow || isModalProcessing) {
          await this.loadCoverageAreas(false, true);
        }
      }, 10000);
    }

    setupEventListeners() {
      // Enhanced form validation
      const locationInput = document.getElementById("location-input");
      if (locationInput) {
        let validationTimeout;
        locationInput.addEventListener("input", (e) => {
          clearTimeout(validationTimeout);
          const value = e.target.value.trim();

          // Reset validation state
          const addButton = document.getElementById("add-coverage-area");
          if (addButton) addButton.disabled = true;
          this.validatedLocation = null;
          locationInput.classList.remove("is-invalid", "is-valid");

          // Show typing indicator
          if (value.length > 2) {
            locationInput.classList.add("loading-pulse");
            validationTimeout = setTimeout(() => {
              locationInput.classList.remove("loading-pulse");
            }, 1000);
          }
        });
      }

      // Area definition type selection
      const areaTypeRadios = document.querySelectorAll(
        'input[name="area-definition-type"]',
      );
      areaTypeRadios.forEach((radio) => {
        radio.addEventListener("change", (e) => {
          this.handleAreaDefinitionTypeChange(e.target.value);
        });
      });

      // Custom area name input validation
      const customAreaNameInput = document.getElementById("custom-area-name");
      if (customAreaNameInput) {
        customAreaNameInput.addEventListener("input", (e) => {
          const value = e.target.value.trim();
          const addButton = document.getElementById("add-custom-area");
          if (addButton) {
            addButton.disabled = !value || !this.validatedCustomBoundary;
          }
        });
      }

      // Validate location button
      document
        .getElementById("validate-location")
        ?.addEventListener("click", (e) => {
          e.preventDefault();
          this.validateLocation();
        });

      // Validate drawing button
      document
        .getElementById("validate-drawing")
        ?.addEventListener("click", (e) => {
          e.preventDefault();
          this.validateCustomBoundary();
        });

      // Clear drawing button
      document
        .getElementById("clear-drawing")
        ?.addEventListener("click", (e) => {
          e.preventDefault();
          this.clearDrawing();
        });

      // Add coverage area button
      document
        .getElementById("add-coverage-area")
        ?.addEventListener("click", (e) => {
          e.preventDefault();
          this.addCoverageArea();
        });

      // Add custom area button
      document
        .getElementById("add-custom-area")
        ?.addEventListener("click", (e) => {
          e.preventDefault();
          this.addCustomCoverageArea();
        });

      // Cancel processing button
      document
        .getElementById("cancel-processing")
        ?.addEventListener("click", (e) => {
          e.preventDefault();
          this.cancelProcessing(this.currentProcessingLocation);
        });

      // Modal event handlers
      document
        .getElementById("taskProgressModal")
        ?.addEventListener("hidden.bs.modal", () => {
          // Always clear processing context when modal is hidden.
          this.clearProcessingContext();
        });

      // Add area modal shown event
      document
        .getElementById("addAreaModal")
        ?.addEventListener("shown.bs.modal", () => {
          // Initialize drawing map when modal is shown
          if (this.currentAreaDefinitionType === "draw") {
            this.initializeDrawingMap();
          }

          const locationInput = document.getElementById("location-input");
          if (locationInput && this.currentAreaDefinitionType === "location") {
            locationInput.focus();
            locationInput.select();
          }
        });

      // Add area modal hidden event
      document
        .getElementById("addAreaModal")
        ?.addEventListener("hidden.bs.modal", () => {
          // Clean up drawing map when modal is hidden
          this.cleanupDrawingMap();
          this.resetModalState();
        });

      // Table event delegation with enhanced interactions
      document
        .querySelector("#coverage-areas-table")
        ?.addEventListener("click", (e) => {
          const targetButton = e.target.closest("button[data-action]");
          const targetLink = e.target.closest("a.location-name-link");
          const targetRow = e.target.closest("tr");

          if (targetButton) {
            e.preventDefault();
            e.stopPropagation();
            this.handleTableAction(targetButton);
          } else if (targetLink) {
            e.preventDefault();
            e.stopPropagation();
            const locationId = targetLink.dataset.locationId;
            if (locationId) {
              this.displayCoverageDashboard(locationId);
            }
          } else if (targetRow && !targetRow.querySelector("td[colspan]")) {
            // Row click for quick view
            const locationLink = targetRow.querySelector(".location-name-link");
            if (locationLink?.dataset.locationId) {
              targetRow.style.backgroundColor = "rgba(255, 255, 255, 0.05)";
              setTimeout(() => {
                targetRow.style.backgroundColor = "";
              }, 200);
            }
          }
        });

      // Dashboard controls
      document.addEventListener("click", (e) => {
        const updateMissingDataBtn = e.target.closest(
          ".update-missing-data-btn",
        );
        if (updateMissingDataBtn) {
          e.preventDefault();
          const locationId = updateMissingDataBtn.dataset.locationId;
          if (locationId) {
            this.updateCoverageForArea(locationId, "full");
          }
        }

        const filterButton = e.target.closest(
          ".map-controls button[data-filter]",
        );
        if (filterButton) {
          this.setMapFilter(filterButton.dataset.filter);
        }

        const exportButton = e.target.closest("#export-coverage-map");
        if (exportButton) {
          this.exportCoverageMap();
        }

        const tripToggle = e.target.closest("#toggle-trip-overlay");
        if (tripToggle) {
          this.handleTripOverlayToggle(tripToggle.checked);
        }
      });

      // Enhanced map movement handler
      if (this.coverageMap) {
        this.setupMapEventHandlers();
      }

      // Drag and drop for file imports
      this.setupDragAndDrop();
    }

    handleTableAction(button) {
      const action = button.dataset.action;
      const locationId = button.dataset.locationId;
      const locationStr = button.dataset.location;

      if (!locationId && !locationStr) {
        this.notificationManager.show(
          "Action failed: Missing location identifier.",
          "danger",
        );
        return;
      }

      let locationData = null;
      if (locationStr) {
        try {
          locationData = JSON.parse(locationStr);
        } catch (parseError) {
          this.notificationManager.show(
            `Action failed: Invalid location data.`,
            "danger",
          );
          return;
        }
      }

      // Add visual feedback
      button.classList.add("loading-pulse");
      button.disabled = true;

      const resetButton = () => {
        button.classList.remove("loading-pulse");
        button.disabled = false;
      };

      switch (action) {
        case "update-full":
          if (locationId) {
            this.updateCoverageForArea(locationId, "full").finally(resetButton);
          }
          break;
        case "update-incremental":
          if (locationId) {
            this.updateCoverageForArea(locationId, "incremental").finally(
              resetButton,
            );
          }
          break;
        case "delete":
          if (locationData) {
            this.deleteArea(locationData).finally(resetButton);
          }
          break;
        case "cancel":
          if (locationData) {
            this.cancelProcessing(locationData).finally(resetButton);
          }
          break;
        case "reprocess":
          if (locationId) {
            this.reprocessStreetsForArea(locationId).finally(resetButton);
          }
          break;
        default:
          this.notificationManager.show(
            `Unknown table action: ${action}`,
            "warning",
          );
          resetButton();
      }
    }

    handleTripOverlayToggle(enabled) {
      this.showTripsActive = enabled;

      if (enabled) {
        this.setupTripLayers();
        this.loadTripsForView();
        this.notificationManager.show("Trip overlay enabled", "info", 2000);
      } else {
        this.clearTripOverlay();
        this.notificationManager.show("Trip overlay disabled", "info", 2000);
      }

      // Save preference
      localStorage.setItem("showTripsOverlay", enabled.toString());
    }

    setupMapEventHandlers() {
      if (!this.coverageMap) return;

      let moveEndTimer;
      this.coverageMap.on("moveend", () => {
        clearTimeout(moveEndTimer);
        moveEndTimer = setTimeout(() => {
          if (this.showTripsActive) {
            this.loadTripsForView();
          }
          // Save map position
          const center = this.coverageMap.getCenter();
          const zoom = this.coverageMap.getZoom();
          localStorage.setItem("lastMapView", JSON.stringify({ center, zoom }));
        }, 300);
      });
    }

    setupDragAndDrop() {
      const dropZone = document.getElementById("coverage-areas-table");
      if (!dropZone) return;

      ["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
        dropZone.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
      });

      ["dragenter", "dragover"].forEach((eventName) => {
        dropZone.addEventListener(eventName, () => {
          dropZone.classList.add("drag-over");
        });
      });

      ["dragleave", "drop"].forEach((eventName) => {
        dropZone.addEventListener(eventName, () => {
          dropZone.classList.remove("drag-over");
        });
      });

      dropZone.addEventListener("drop", (e) => {
        const files = e.dataTransfer.files;
        if (files.length > 0) {
          this.handleFileImport(files[0]);
        }
      });
    }

    async handleFileImport(file) {
      if (!file.name.endsWith(".json")) {
        this.notificationManager.show("Please upload a JSON file", "warning");
        return;
      }

      try {
        const text = await file.text();
        const data = JSON.parse(text);

        if (data.areas && Array.isArray(data.areas)) {
          const confirmed = await this.confirmationDialog.show({
            title: "Import Coverage Data",
            message: `Import ${data.areas.length} coverage area${
              data.areas.length > 1 ? "s" : ""
            }?`,
            details: "This will add new areas but won't affect existing ones.",
            confirmText: "Import",
            confirmButtonClass: "btn-primary",
          });

          if (confirmed) {
            this.importCoverageAreas(data.areas);
          }
        } else {
          this.notificationManager.show("Invalid file format", "danger");
        }
      } catch (error) {
        console.error("Import error:", error);
        this.notificationManager.show("Failed to import file", "danger");
      }
    }

    async importCoverageAreas(areas) {
      // Implementation would depend on backend API
      this.notificationManager.show("Import feature coming soon", "info");
    }

    checkForInterruptedTasks() {
      const savedProgress =
        window.utils?.getStorage?.("coverageProcessingState") ||
        localStorage.getItem("coverageProcessingState");

      if (!savedProgress) return;

      try {
        const progressData = JSON.parse(savedProgress);
        const now = new Date();
        const savedTime = new Date(progressData.timestamp);

        if (now - savedTime < 60 * 60 * 1000) {
          // 1 hour threshold
          this.showInterruptedTaskNotification(progressData);
        } else {
          localStorage.removeItem("coverageProcessingState");
        }
      } catch (e) {
        console.error("Error restoring saved progress:", e);
        localStorage.removeItem("coverageProcessingState");
      }
    }

    showInterruptedTaskNotification(progressData) {
      const location = progressData.location;
      const taskId = progressData.taskId;

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
          <div class="progress-bar bg-info" style="width: ${
            progressData.progress || 0
          }%">
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

      notification
        .querySelector(".resume-task")
        .addEventListener("click", () => {
          this.resumeInterruptedTask(progressData);
          notification.remove();
        });

      notification
        .querySelector(".discard-task")
        .addEventListener("click", () => {
          localStorage.removeItem("coverageProcessingState");
          this.notificationManager.show("Interrupted task discarded", "info");
          notification.remove();
        });

      document.querySelector("#alerts-container")?.prepend(notification);
    }

    async resumeInterruptedTask(savedData) {
      const location = savedData.location;
      const taskId = savedData.taskId;

      if (!location || !location.display_name || !taskId) {
        this.notificationManager.show(
          "Cannot resume task: Incomplete data.",
          "warning",
        );
        localStorage.removeItem("coverageProcessingState");
        return;
      }

      this.currentProcessingLocation = location;
      this.currentTaskId = taskId;
      this._addBeforeUnloadListener(); // Add listener when resuming

      this.showProgressModal(
        `Checking status for ${location.display_name}...`,
        savedData.progress || 0,
      );

      this.activeTaskIds.add(taskId);

      try {
        const finalData = await this.pollCoverageProgress(taskId);

        if (finalData?.stage !== STATUS.ERROR) {
          this.notificationManager.show(
            `Task for ${location.display_name} completed.`,
            "success",
          );
        }
        // `_removeBeforeUnloadListener` will be called by pollCoverageProgress or clearProcessingContext

        await this.loadCoverageAreas();

        if (this.selectedLocation?._id === location._id) {
          await this.displayCoverageDashboard(this.selectedLocation._id);
        }
      } catch (pollError) {
        this.notificationManager.show(
          `Failed to resume task: ${pollError.message}`,
          "danger",
        );
        // `_removeBeforeUnloadListener` will be called by pollCoverageProgress or clearProcessingContext
        await this.loadCoverageAreas();
      } finally {
        // activeTaskIds.delete is handled by pollCoverageProgress
        // Listener removal handled by poll or clearProcessingContext
      }
    }

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
          progress: parseInt(progressBar?.getAttribute("aria-valuenow") || "0"),
          timestamp: new Date().toISOString(),
        };

        localStorage.setItem(
          "coverageProcessingState",
          JSON.stringify(saveData),
        );
        this.saveToIndexedDB("processingState", saveData);
      } else {
        localStorage.removeItem("coverageProcessingState");
      }
    }

    async saveToIndexedDB(key, data) {
      try {
        if (!window.indexedDB) return;

        const db = await this.openDatabase();
        const transaction = db.transaction(["coverage"], "readwrite");
        const store = transaction.objectStore("coverage");
        await store.put({ key, data, timestamp: Date.now() });
      } catch (error) {
        console.error("IndexedDB save error:", error);
      }
    }

    async openDatabase() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open("CoverageManager", 1);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);

        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains("coverage")) {
            db.createObjectStore("coverage", { keyPath: "key" });
          }
        };
      });
    }

    clearProcessingContext() {
      if (this.progressTimer) {
        clearInterval(this.progressTimer);
        this.progressTimer = null;
      }

      this._removeBeforeUnloadListener(); // Centralized removal
      localStorage.removeItem("coverageProcessingState");

      this.currentProcessingLocation = null;
      this.processingStartTime = null;
      this.lastProgressUpdate = null;
      this.currentTaskId = null;
      this.lastActivityTime = null;
    }

    async validateLocation() {
      const locationInputEl = document.getElementById("location-input");
      const locationTypeEl = document.getElementById("location-type");
      const validateButton = document.getElementById("validate-location");
      const addButton = document.getElementById("add-coverage-area");
      const validationResult = document.getElementById("validation-result");

      if (
        !locationInputEl ||
        !locationTypeEl ||
        !validateButton ||
        !addButton
      ) {
        console.error("Validation form elements not found.");
        return;
      }

      const locationInput = locationInputEl.value.trim();
      const locType = locationTypeEl.value;

      // Reset state
      locationInputEl.classList.remove("is-invalid", "is-valid");
      addButton.disabled = true;
      this.validatedLocation = null;
      validationResult.classList.add("d-none");

      if (!locationInput) {
        locationInputEl.classList.add("is-invalid", "shake-animation");
        this.notificationManager.show("Please enter a location.", "warning");
        return;
      }

      const originalButtonContent = validateButton.innerHTML;
      validateButton.disabled = true;
      validateButton.innerHTML =
        '<i class="fas fa-spinner fa-spin"></i> Validating...';

      try {
        const response = await fetch("/api/validate_location", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: locationInput,
            locationType: locType,
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.detail || `Validation failed`);
        }

        if (!data || !data.osm_id || !data.display_name) {
          locationInputEl.classList.add("is-invalid");
          this.notificationManager.show(
            "Location not found. Please check your input.",
            "warning",
          );
        } else {
          locationInputEl.classList.add("is-valid");
          this.validatedLocation = data;
          addButton.disabled = false;

          // Show validation result
          validationResult.classList.remove("d-none");
          validationResult.querySelector(".validation-message").textContent =
            `Found: ${data.display_name}`;

          this.notificationManager.show(
            `Location validated: ${data.display_name}`,
            "success",
          );

          // Focus add button
          addButton.focus();
        }
      } catch (error) {
        console.error("Error validating location:", error);
        locationInputEl.classList.add("is-invalid");
        this.notificationManager.show(
          `Validation failed: ${error.message}`,
          "danger",
        );
      } finally {
        validateButton.disabled = false;
        validateButton.innerHTML = originalButtonContent;
      }
    }

    async addCoverageArea() {
      if (!this.validatedLocation || !this.validatedLocation.display_name) {
        this.notificationManager.show(
          "Please validate a location first.",
          "warning",
        );
        return;
      }

      const addButton = document.getElementById("add-coverage-area");
      const modal = bootstrap.Modal.getInstance(
        document.getElementById("addAreaModal"),
      );

      if (!addButton) return;

      const originalButtonContent = addButton.innerHTML;
      addButton.disabled = true;
      addButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding...';

      const locationToAdd = { ...this.validatedLocation };
      const segLenEl = document.getElementById("segment-length-input");
      if (segLenEl && segLenEl.value) {
        const val = parseInt(segLenEl.value, 10);
        if (!isNaN(val) && val > 0) locationToAdd.segment_length_meters = val;
      }
      if (bufEl && bufEl.value) {
        const v = parseFloat(bufEl.value);
        if (!isNaN(v) && v > 0) locationToAdd.match_buffer_meters = v;
      }
      if (minEl && minEl.value) {
        const v2 = parseFloat(minEl.value);
        if (!isNaN(v2) && v2 > 0) locationToAdd.min_match_length_meters = v2;
      }

      try {
        const currentAreasResponse = await fetch("/api/coverage_areas");
        if (!currentAreasResponse.ok) {
          throw new Error("Failed to fetch current coverage areas");
        }

        const { areas } = await currentAreasResponse.json();
        const exists = areas.some(
          (area) => area.location?.display_name === locationToAdd.display_name,
        );

        if (exists) {
          this.notificationManager.show(
            "This area is already being tracked.",
            "warning",
          );
          return;
        }

        if (modal) modal.hide();

        this.currentProcessingLocation = locationToAdd;
        this.currentTaskId = null;
        this._addBeforeUnloadListener();

        this.showProgressModal(
          `Starting processing for ${locationToAdd.display_name}...`,
          0,
        );

        const preprocessResponse = await fetch("/api/preprocess_streets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(locationToAdd),
        });

        const taskData = await preprocessResponse.json();

        if (!preprocessResponse.ok) {
          this.hideProgressModal();
          throw new Error(taskData.detail || "Failed to start processing");
        }

        this.notificationManager.show(
          "Coverage area processing started.",
          "info",
        );

        if (taskData?.task_id) {
          this.currentTaskId = taskData.task_id;
          this.activeTaskIds.add(taskData.task_id);
          this.saveProcessingState();

          await this.pollCoverageProgress(taskData.task_id);
          // `_removeBeforeUnloadListener` called by poll or clearProcessingContext

          this.notificationManager.show(
            `Processing for ${locationToAdd.display_name} completed.`,
            "success",
          );

          await this.loadCoverageAreas();
        } else {
          this.hideProgressModal();
          // `_removeBeforeUnloadListener` called by clearProcessingContext via modal hide
          this.notificationManager.show(
            "Processing started, but no task ID received.",
            "warning",
          );
          await this.loadCoverageAreas();
        }

        const locationInput = document.getElementById("location-input");
        if (locationInput) {
          locationInput.value = "";
          locationInput.classList.remove("is-valid", "is-invalid");
        }
        this.validatedLocation = null;
        this.updateTotalAreasCount();
      } catch (error) {
        console.error("Error adding coverage area:", error);
        this.notificationManager.show(
          `Failed to add coverage area: ${error.message}`,
          "danger",
        );
        this.hideProgressModal();
        // `_removeBeforeUnloadListener` called by clearProcessingContext via modal hide
        await this.loadCoverageAreas();
      } finally {
        addButton.disabled = true;
        addButton.innerHTML = originalButtonContent;
      }
    }

    async updateCoverageForArea(
      locationId,
      mode = "full",
      showNotification = true,
    ) {
      if (!locationId) {
        this.notificationManager.show(
          "Invalid location ID provided for update.",
          "warning",
        );
        return;
      }

      if (this.pendingOperations.has(`update-${locationId}`)) {
        this.notificationManager.show(
          "Update already in progress for this location.",
          "info",
        );
        return;
      }

      let locationData = null;

      try {
        this.pendingOperations.set(`update-${locationId}`, async () => {
          return this.updateCoverageForArea(locationId, mode, showNotification);
        });

        const response = await fetch(`/api/coverage_areas/${locationId}`);
        const data = await response.json();

        if (!data.success || !data.coverage || !data.coverage.location) {
          throw new Error(data.error || "Failed to fetch location details");
        }

        locationData = data.coverage.location;

        if (!locationData.display_name) {
          throw new Error("Location details missing display name");
        }
      } catch (fetchError) {
        this.notificationManager.show(
          `Failed to start update: ${fetchError.message}`,
          "danger",
        );
        this.pendingOperations.delete(`update-${locationId}`);
        return;
      }

      if (
        this.currentProcessingLocation?.display_name ===
        locationData.display_name
      ) {
        this.notificationManager.show(
          `Update already in progress for ${locationData.display_name}.`,
          "info",
        );
        this.showProgressModal(
          `Update already running for ${locationData.display_name}...`,
        );
        return;
      }

      const processingLocation = { ...locationData };

      try {
        this.currentProcessingLocation = processingLocation;
        this.currentTaskId = null;
        this._addBeforeUnloadListener();

        const isUpdatingDisplayedLocation =
          this.selectedLocation?._id === locationId;

        this.showProgressModal(
          `Requesting ${mode} update for ${processingLocation.display_name}...`,
        );

        const endpoint =
          mode === "incremental"
            ? "/api/street_coverage/incremental"
            : "/api/street_coverage";

        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(processingLocation),
        });

        const data = await response.json();

        if (!response.ok) {
          if (response.status === 422 && data.detail) {
            const errorMsg = Array.isArray(data.detail)
              ? data.detail
                  .map((err) => `${err.loc?.join(".")}: ${err.msg}`)
                  .join("; ")
              : data.detail;
            throw new Error(`Validation error: ${errorMsg}`);
          }
          throw new Error(data.detail || `Failed to start update`);
        }

        if (data.task_id) {
          this.currentTaskId = data.task_id;
          this.activeTaskIds.add(data.task_id);
          this.saveProcessingState();

          await this.pollCoverageProgress(data.task_id);
          // `_removeBeforeUnloadListener` called by poll or clearProcessingContext

          if (showNotification) {
            this.notificationManager.show(
              `Coverage update for ${processingLocation.display_name} completed.`,
              "success",
            );
          }

          await this.loadCoverageAreas();

          if (isUpdatingDisplayedLocation) {
            await this.displayCoverageDashboard(locationId);
          }
        } else {
          this.hideProgressModal();
          // `_removeBeforeUnloadListener` called by clearProcessingContext via modal hide
          this.notificationManager.show(
            "Update started, but no task ID received.",
            "warning",
          );
          await this.loadCoverageAreas();
        }
      } catch (error) {
        console.error("Error updating coverage:", error);
        if (showNotification) {
          this.notificationManager.show(
            `Coverage update failed: ${error.message}`,
            "danger",
          );
        }
        this.hideProgressModal();
        // `_removeBeforeUnloadListener` called by clearProcessingContext via modal hide
        await this.loadCoverageAreas();
        throw error;
      } finally {
        this.pendingOperations.delete(`update-${locationId}`);
      }
    }

    async cancelProcessing(location = null) {
      const locationToCancel = location || this.currentProcessingLocation;

      if (!locationToCancel || !locationToCancel.display_name) {
        this.notificationManager.show(
          "No active processing to cancel.",
          "warning",
        );
        return;
      }

      const confirmed = await this.confirmationDialog.show({
        title: "Cancel Processing",
        message: `Are you sure you want to cancel processing for <strong>${locationToCancel.display_name}</strong>?`,
        details:
          "This will stop the current operation. You can restart it later.",
        confirmText: "Yes, Cancel",
        cancelText: "No, Continue",
        confirmButtonClass: "btn-danger",
      });

      if (!confirmed) return;

      this.notificationManager.show(
        `Attempting to cancel processing for ${locationToCancel.display_name}...`,
        "info",
      );

      try {
        const payload = { display_name: locationToCancel.display_name };
        const response = await fetch("/api/coverage_areas/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.detail || "Failed to send cancel request");
        }

        this.notificationManager.show(
          `Processing for ${locationToCancel.display_name} cancelled.`,
          "success",
        );

        if (
          this.currentProcessingLocation?.display_name ===
          locationToCancel.display_name
        ) {
          if (this.currentTaskId) {
            this.activeTaskIds.delete(this.currentTaskId);
            this._removeBeforeUnloadListener(); // Remove listener on explicit cancel
          }
          this.hideProgressModal();
          // `clearProcessingContext` will be called when modal hides, further ensuring cleanup.
        }

        await this.loadCoverageAreas();
      } catch (error) {
        console.error("Error cancelling processing:", error);
        this.notificationManager.show(
          `Failed to cancel processing: ${error.message}`,
          "danger",
        );
      }
    }

    async deleteArea(location) {
      if (!location || !location.display_name) {
        this.notificationManager.show(
          "Invalid location data for deletion.",
          "warning",
        );
        return;
      }

      const confirmed = await this.confirmationDialog.show({
        title: "Delete Coverage Area",
        message: `Are you sure you want to delete <strong>${location.display_name}</strong>?`,
        details:
          "This will permanently delete all associated street data, statistics, and history. This action cannot be undone.",
        confirmText: "Delete Permanently",
        confirmButtonClass: "btn-danger",
      });

      if (!confirmed) return;

      try {
        this.notificationManager.show(
          `Deleting coverage area: ${location.display_name}...`,
          "info",
        );

        const payload = { display_name: location.display_name };
        const response = await fetch("/api/coverage_areas/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.detail || "Failed to delete area");
        }

        await this.loadCoverageAreas();

        if (
          this.selectedLocation?.location?.display_name ===
          location.display_name
        ) {
          this.closeCoverageDashboard();
        }

        this.notificationManager.show(
          `Coverage area '${location.display_name}' deleted.`,
          "success",
        );

        this.updateTotalAreasCount();
      } catch (error) {
        console.error("Error deleting coverage area:", error);
        this.notificationManager.show(
          `Error deleting coverage area: ${error.message}`,
          "danger",
        );
      }
    }

    async loadCoverageAreas(showLoading = true, silent = false) {
      const tableBody = document.querySelector("#coverage-areas-table tbody");

      if (!tableBody) return;

      if (showLoading && !silent) {
        tableBody.innerHTML = `
          <tr>
            <td colspan="7" class="text-center">
              <div class="empty-state">
                <div class="loading-indicator mb-3"></div>
                <p class="mb-0">Loading coverage areas...</p>
              </div>
            </td>
          </tr>
        `;
      }

      try {
        const response = await fetch("/api/coverage_areas");

        if (!response.ok) {
          let errorDetail = `HTTP ${response.status}`;
          try {
            errorDetail = (await response.json()).detail || errorDetail;
          } catch (e) {
            /* ignore json parsing error */
          }
          throw new Error(`Failed to fetch coverage areas (${errorDetail})`);
        }

        const data = await response.json();

        if (!data.success) {
          throw new Error(data.error || "API returned failure");
        }

        this.queueRender(() => {
          CoverageManager.updateCoverageTable(data.areas, this);
          CoverageManager.enhanceResponsiveTables();
          this.initTooltips();
          this.initializeDataTable();
        });

        this.updateTotalAreasCount(data.areas.length);
      } catch (error) {
        console.error("Error loading coverage areas:", error);

        if (!silent) {
          this.notificationManager.show(
            `Failed to load coverage areas: ${error.message}.`,
            "danger",
          );
        }

        if (tableBody) {
          tableBody.innerHTML = `
            <tr>
              <td colspan="7" class="text-center text-danger">
                <div class="empty-state">
                  <i class="fas fa-exclamation-circle mb-2"></i>
                  <p>Error loading data: ${error.message}</p>
                  <button class="btn btn-sm btn-primary mt-2" onclick="window.coverageManager.loadCoverageAreas()">
                    <i class="fas fa-redo me-1"></i>Retry
                  </button>
                </div>
              </td>
            </tr>
          `;
        }
      }
    }

    initializeDataTable() {
      if (!window.$ || !$.fn.DataTable) return;

      const table = $("#coverage-areas-table");

      if ($.fn.DataTable.isDataTable(table)) {
        table.DataTable().destroy();
      }

      table.DataTable({
        order: [[5, "desc"]], // Sort by last updated descending
        paging: false,
        searching: false,
        info: false,
        responsive: true,
        autoWidth: false,
        columnDefs: [
          { orderable: false, targets: 6 }, // Actions column
          {
            targets: 1, // Total Length column
            render(data, type) {
              return type === "display" ? data : parseFloat(data);
            },
          },
        ],
        language: {
          emptyTable: "No coverage areas defined yet.",
        },
        drawCallback() {
          // Re-initialize tooltips after table redraw
          window.coverageManager.initTooltips();
        },
      });
    }

    updateTotalAreasCount(count = null) {
      const countElement = document.getElementById("total-areas-count");
      if (!countElement) return;

      if (count === null) {
        // Fetch count if not provided
        this.getAllCoverageAreas().then((areas) => {
          countElement.textContent = areas.length;
          countElement.classList.add("fade-in-up");
        });
      } else {
        countElement.textContent = count;
        countElement.classList.add("fade-in-up");
      }
    }

    async pollCoverageProgress(taskId) {
      const maxRetries = 360; // ~30 minutes
      let retries = 0;
      let lastStage = null;
      let consecutiveSameStage = 0;
      const pollingStartTime = Date.now();

      while (retries < maxRetries) {
        if (!this.activeTaskIds.has(taskId)) {
          this.notificationManager.show(
            `Polling stopped for task ${taskId.substring(0, 8)}...`,
            "info",
          );
          this._removeBeforeUnloadListener(); // Remove listener as polling stopped
          throw new Error("Polling canceled");
        }

        try {
          const response = await fetch(`/api/street_coverage/${taskId}`);

          if (response.status === 404) {
            this._removeBeforeUnloadListener();
            throw new Error("Task not found (expired or invalid).");
          }

          if (!response.ok) {
            let errorDetail = `HTTP error ${response.status}`;
            try {
              errorDetail = (await response.json()).detail || errorDetail;
            } catch (e) {
              /* ignore json parsing error */
            }
            this._removeBeforeUnloadListener();
            throw new Error(`Failed to get task status: ${errorDetail}`);
          }

          let data = null;

          try {
            data = await response.json();

            if (!data || typeof data !== "object" || !data.stage) {
              if (response.ok) {
                this.notificationManager.show(
                  `Task ${taskId.substring(
                    0,
                    8,
                  )}...: Received incomplete data.`,
                  "warning",
                );
              }
              this._removeBeforeUnloadListener();
              throw new Error("Invalid data format received from server.");
            }
          } catch (jsonError) {
            this._removeBeforeUnloadListener();
            throw new Error(
              `Error processing server response: ${jsonError.message}`,
            );
          }

          this.updateModalContent(data);
          CoverageManager.updateStepIndicators(data.stage, data.progress);
          this.lastActivityTime = new Date();
          this.saveProcessingState();

          if (
            data.stage === STATUS.COMPLETE ||
            data.stage === STATUS.COMPLETED
          ) {
            this.updateModalContent({ ...data, progress: 100 });
            CoverageManager.updateStepIndicators(STATUS.COMPLETE, 100);
            this.activeTaskIds.delete(taskId);
            this._removeBeforeUnloadListener(); // Task finished
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
            this._removeBeforeUnloadListener(); // Task finished with error
            this.showErrorState(errorMessage);
            throw new Error(
              data.error || data.message || "Coverage calculation failed",
            );
          } else if (data.stage === STATUS.CANCELED) {
            this.notificationManager.show(`Task was canceled.`, "warning");
            this.activeTaskIds.delete(taskId);
            this._removeBeforeUnloadListener(); // Task finished due to cancel
            this.hideProgressModal();
            throw new Error("Task was canceled");
          }

          if (data.stage === lastStage) {
            consecutiveSameStage++;
            if (consecutiveSameStage > 12) {
              // Increased threshold for stall warning
              this.notificationManager.show(
                `Task seems stalled at: ${CoverageManager.formatStageName(
                  data.stage,
                )}`,
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
          CoverageManager.updateStepIndicators(
            STATUS.ERROR,
            this.currentProcessingLocation?.progress || 0,
          );
          this.activeTaskIds.delete(taskId);
          this._removeBeforeUnloadListener(); // Task finished with polling error
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
      CoverageManager.updateStepIndicators(
        STATUS.ERROR,
        this.currentProcessingLocation?.progress || 99,
      );
      this.activeTaskIds.delete(taskId);
      this._removeBeforeUnloadListener(); // Task timed out
      throw new Error("Coverage calculation polling timed out");
    }

    calculatePollInterval(stage, retries) {
      // Adaptive polling based on stage and retry count
      const baseInterval = 5000; // 5 seconds

      if (stage === STATUS.PROCESSING_TRIPS || stage === STATUS.CALCULATING) {
        // These stages typically take longer
        return Math.min(baseInterval * 2, 15000);
      }

      if (retries > 100) {
        // After many retries, poll less frequently
        return Math.min(baseInterval * 3, 20000);
      }

      return baseInterval;
    }

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

    showErrorState(errorMessage) {
      const modal = document.getElementById("taskProgressModal");
      if (!modal) return;

      const footer = modal.querySelector(".modal-footer");
      const retryBtn = document.createElement("button");
      retryBtn.className = "btn btn-primary";
      retryBtn.innerHTML = '<i class="fas fa-redo me-1"></i>Retry';
      retryBtn.onclick = () => {
        this.hideProgressModal();
        if (this.currentProcessingLocation) {
          this.resumeInterruptedTask({
            location: this.currentProcessingLocation,
            taskId: this.currentTaskId,
            progress: 0,
          });
        }
      };

      footer.insertBefore(retryBtn, footer.firstChild);
    }

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
        this._addBeforeUnloadListener(); // Re-add listener for retry attempt
        this.pollCoverageProgress(taskId).catch(console.error);
      };

      modalBody.appendChild(retrySection);
    }

    static updateCoverageTable(areas, instance) {
      const tableBody = document.querySelector("#coverage-areas-table tbody");
      if (!tableBody) return;

      tableBody.innerHTML = "";

      if (!areas || areas.length === 0) {
        tableBody.innerHTML = `
          <tr>
            <td colspan="7" class="text-center">
              <div class="empty-state py-5">
                <i class="fas fa-map-marked-alt fa-3x mb-3 opacity-50"></i>
                <h5>No Coverage Areas Yet</h5>
                <p class="text-muted mb-3">Start tracking your coverage by adding a new area.</p>
                <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addAreaModal">
                  <i class="fas fa-plus me-2"></i>Add Your First Area
                </button>
              </div>
            </td>
          </tr>
        `;
        return;
      }

      // Sort areas by last updated (newest first)
      areas.sort((a, b) => {
        const dateA = new Date(a.last_updated || 0);
        const dateB = new Date(b.last_updated || 0);
        return dateB - dateA;
      });

      areas.forEach((area, index) => {
        const row = document.createElement("tr");
        const status = area.status || STATUS.UNKNOWN;
        const isProcessing = [
          STATUS.PROCESSING_TRIPS,
          STATUS.PREPROCESSING,
          STATUS.CALCULATING,
          STATUS.INDEXING,
          STATUS.FINALIZING,
          STATUS.GENERATING_GEOJSON,
          STATUS.COMPLETE_STATS,
          STATUS.INITIALIZING,
          STATUS.LOADING_STREETS,
          STATUS.COUNTING_TRIPS,
        ].includes(status);
        const hasError = status === STATUS.ERROR;
        const isCanceled = status === STATUS.CANCELED;

        row.className = isProcessing
          ? "processing-row table-info"
          : hasError
            ? "table-danger"
            : isCanceled
              ? "table-warning"
              : "";

        // Add animation for new rows
        if (index < 5) {
          row.style.animationDelay = `${index * 0.05}s`;
          row.classList.add("fade-in-up");
        }

        const lastUpdated = area.last_updated
          ? new Date(area.last_updated).toLocaleString()
          : "Never";
        const lastUpdatedOrder = area.last_updated
          ? new Date(area.last_updated).getTime()
          : 0;
        const totalLengthMiles = CoverageManager.distanceInUserUnits(
          area.total_length,
        );
        const drivenLengthMiles = CoverageManager.distanceInUserUnits(
          area.driven_length,
        );
        const coveragePercentage =
          area.coverage_percentage?.toFixed(1) || "0.0";

        let progressBarColor = "bg-success";
        if (hasError || isCanceled) progressBarColor = "bg-secondary";
        else if (area.coverage_percentage < 25) progressBarColor = "bg-danger";
        else if (area.coverage_percentage < 75) progressBarColor = "bg-warning";

        const locationButtonData = JSON.stringify({
          display_name: area.location?.display_name || "",
        }).replace(/'/g, "&apos;");

        const locationId = area._id;

        row.innerHTML = `
          <td data-label="Location">
            <a href="#" class="location-name-link text-info fw-bold" data-location-id="${locationId}">
              ${area.location?.display_name || "Unknown Location"}
            </a>
            ${
              hasError
                ? `<div class="text-danger small mt-1" title="${
                    area.last_error || ""
                  }"><i class="fas fa-exclamation-circle me-1"></i>Error occurred</div>`
                : ""
            }
            ${
              isCanceled
                ? '<div class="text-warning small mt-1"><i class="fas fa-ban me-1"></i>Canceled</div>'
                : ""
            }
            ${
              isProcessing
                ? `<div class="text-primary small mt-1"><i class="fas fa-spinner fa-spin me-1"></i>${CoverageManager.formatStageName(
                    status,
                  )}...</div>`
                : ""
            }
          </td>
          <td data-label="Total Length" class="text-end" data-order="${
            parseFloat(area.total_length || 0) * 0.000621371
          }">${totalLengthMiles}</td>
          <td data-label="Driven Length" class="text-end" data-order="${
            parseFloat(area.driven_length || 0) * 0.000621371
          }">${drivenLengthMiles}</td>
          <td data-label="Coverage" data-order="${parseFloat(
            area.coverage_percentage || 0,
          )}">
            <div class="progress" style="height: 22px;" title="${coveragePercentage}% coverage">
              <div class="progress-bar ${progressBarColor}" role="progressbar"
                   style="width: ${coveragePercentage}%; transition: width 0.5s ease;"
                   aria-valuenow="${coveragePercentage}"
                   aria-valuemin="0" aria-valuemax="100">
                <span style="font-weight: 600;">${coveragePercentage}%</span>
              </div>
            </div>
          </td>
          <td data-label="Segments" class="text-end" data-order="${parseInt(
            area.total_segments || 0,
            10,
          )}">${area.total_segments?.toLocaleString() || 0}</td>
          <td data-label="Last Updated" data-order="${lastUpdatedOrder}">
            <span title="${lastUpdated}">${instance.formatRelativeTime(
              area.last_updated,
            )}</span>
          </td>
          <td data-label="Actions">
            <div class="btn-group" role="group" aria-label="Coverage area actions">
              <button class="btn btn-sm btn-success" data-action="update-full" data-location-id="${locationId}" 
                      title="Full Update - Recalculate all coverage" ${
                        isProcessing ? "disabled" : ""
                      } 
                      data-bs-toggle="tooltip">
                <i class="fas fa-sync-alt"></i>
              </button>
              <button class="btn btn-sm btn-info" data-action="update-incremental" data-location-id="${locationId}" 
                      title="Quick Update - Process new trips only" ${
                        isProcessing ? "disabled" : ""
                      } 
                      data-bs-toggle="tooltip">
                <i class="fas fa-bolt"></i>
              </button>
              <button class="btn btn-sm btn-secondary" data-action="reprocess" data-location-id="${locationId}" title="Re-segment streets (choose new segment length)" ${isProcessing ? "disabled" : ""} data-bs-toggle="tooltip">
                <i class="fas fa-sliders-h"></i>
              </button>
              <button class="btn btn-sm btn-danger" data-action="delete" data-location='${locationButtonData}' 
                      title="Delete this coverage area" ${
                        isProcessing ? "disabled" : ""
                      } 
                      data-bs-toggle="tooltip">
                <i class="fas fa-trash-alt"></i>
              </button>
              ${
                isProcessing
                  ? `<button class="btn btn-sm btn-warning" data-action="cancel" data-location='${locationButtonData}' title="Cancel processing" data-bs-toggle="tooltip"><i class="fas fa-stop-circle"></i></button>`
                  : ""
              }
            </div>
          </td>
        `;
        tableBody.appendChild(row);
      });
    }

    formatRelativeTime(dateString) {
      if (!dateString) return "Never";

      const date = new Date(dateString);
      const now = new Date();
      const diff = now - date;

      const seconds = Math.floor(diff / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);

      if (days > 7) {
        return date.toLocaleDateString();
      } else if (days > 0) {
        return `${days} day${days > 1 ? "s" : ""} ago`;
      } else if (hours > 0) {
        return `${hours} hour${hours > 1 ? "s" : ""} ago`;
      } else if (minutes > 0) {
        return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
      } else {
        return "Just now";
      }
    }

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

      // Set initial modal state with smooth transitions
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

      // Clear and reset progress details
      progressDetails.querySelector(".stage-info").innerHTML = "";
      progressDetails.querySelector(".stats-info").innerHTML = "";
      progressDetails.querySelector(".elapsed-time").textContent =
        "Elapsed: 0s";
      progressDetails.querySelector(".estimated-time").textContent = "";

      if (cancelBtn) cancelBtn.disabled = false;

      // Start timers
      if (this.progressTimer) clearInterval(this.progressTimer);
      this.processingStartTime = Date.now();
      this.lastActivityTime = Date.now();

      this.progressTimer = setInterval(() => {
        this.updateTimingInfo();
        this.updateActivityIndicator();
      }, 1000);

      this.updateTimingInfo();
      this.updateActivityIndicator();

      // Show modal with animation
      const bsModal = bootstrap.Modal.getOrCreateInstance(modalElement, {
        backdrop: "static",
        keyboard: false,
      });

      modalElement.classList.add("fade-in-up");
      bsModal.show();
    }

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

      // Smooth progress bar update
      if (progressBar) {
        const currentProgress = parseInt(
          progressBar.getAttribute("aria-valuenow") || "0",
        );

        if (progress > currentProgress) {
          progressBar.style.transition = "width 0.5s ease";
        } else {
          progressBar.style.transition = "none";
        }

        progressBar.style.width = `${progress}%`;
        progressBar.setAttribute("aria-valuenow", progress);
        progressBar.textContent = `${progress}%`;

        // Update bar style based on stage
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

      // Update stage indicator
      if (stageInfoEl) {
        const stageName = CoverageManager.formatStageName(stage);
        const stageIcon = CoverageManager.getStageIcon(stage);
        stageInfoEl.innerHTML = `${stageIcon} ${stageName}`;
        stageInfoEl.className = `stage-info mb-3 text-center text-${CoverageManager.getStageTextClass(
          stage,
        )}`;
      }

      // Update stats display
      if (statsInfoEl) {
        statsInfoEl.innerHTML = this.formatMetricStats(stage, metrics);
      }

      // Update cancel button state
      if (cancelBtn) {
        cancelBtn.disabled = [
          STATUS.COMPLETE,
          STATUS.COMPLETED,
          STATUS.ERROR,
          STATUS.CANCELED,
        ].includes(stage);
      }

      // Handle terminal states
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

    static updateStepIndicators(stage, progress) {
      const modal = document.getElementById("taskProgressModal");
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
          steps[stepKey].style.transform = "scale(0.9)"; // Slight shrink to indicate done
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
      if (estimatedTimeEl) estimatedTimeEl.textContent = ""; // Placeholder
    }

    updateActivityIndicator(isActive = null) {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement) return;

      const activityIndicator = modalElement.querySelector(
        ".activity-indicator",
      );
      const lastUpdateEl = modalElement.querySelector(".last-update-time");

      if (!activityIndicator || !lastUpdateEl) return;

      const now = new Date();
      let currentlyActive;

      if (isActive !== null) {
        currentlyActive = isActive;
      } else {
        currentlyActive =
          this.lastActivityTime && now - this.lastActivityTime < 10000; // 10s threshold
      }

      if (currentlyActive) {
        activityIndicator.classList.add("pulsing");
        activityIndicator.innerHTML = `<i class="fas fa-circle-notch fa-spin text-info me-1"></i>Active`;
      } else {
        activityIndicator.classList.remove("pulsing");
        activityIndicator.innerHTML = `<i class="fas fa-hourglass-half text-secondary me-1"></i>Idle`;
      }

      if (this.lastActivityTime) {
        lastUpdateEl.textContent = `Last update: ${CoverageManager.formatTimeAgo(
          this.lastActivityTime,
        )}`;
      } else {
        lastUpdateEl.textContent = currentlyActive ? "" : "No recent activity";
      }
    }

    static formatTimeAgo(date) {
      if (!date) return "never";
      const seconds = Math.floor((new Date() - new Date(date)) / 1000);

      if (seconds < 2) return "just now";
      if (seconds < 60) return `${seconds}s ago`;

      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m ago`;

      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h ago`;

      const days = Math.floor(hours / 24);
      if (days < 7) return `${days}d ago`;

      return new Date(date).toLocaleDateString(); // For older dates, show full date
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
          const iconHtml = icon
            ? `<i class="${icon} me-2 opacity-75"></i>`
            : "";
          const displayValue =
            typeof value === "number" ? value.toLocaleString() : value;
          statsHtml += `
            <div class="d-flex justify-content-between py-1 border-bottom border-secondary border-opacity-10">
              <small class="text-muted">${iconHtml}${label}:</small>
              <small class="fw-bold ${colorClass}">${displayValue}${unit}</small>
            </div>`;
        }
      };

      // Generic stats applicable to many stages
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
          CoverageManager.distanceInUserUnits(metrics.total_length_m),
          "",
          "fas fa-ruler-horizontal",
        );
      }
      if (metrics.driveable_length_m !== undefined) {
        addStat(
          "Driveable Length",
          CoverageManager.distanceInUserUnits(metrics.driveable_length_m),
          "",
          "fas fa-car",
        );
      }

      // Stage-specific stats
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
            CoverageManager.distanceInUserUnits(metrics.covered_length_m),
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
            CoverageManager.distanceInUserUnits(metrics.covered_length_m),
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

    async displayCoverageDashboard(locationId) {
      this.currentDashboardLocationId = locationId;

      const dashboardElement = document.getElementById("coverage-dashboard");
      const locationNameElement = document.getElementById(
        "dashboard-location-name",
      );
      const streetTypeChartElement =
        document.getElementById("street-type-chart");
      const streetTypeCoverageElement = document.getElementById(
        "street-type-coverage",
      );
      const mapContainer = document.getElementById("coverage-map");

      if (!dashboardElement || !locationNameElement || !mapContainer) {
        console.error("Essential dashboard elements not found.");
        this.notificationManager.show(
          "UI Error: Dashboard components missing.",
          "danger",
        );
        return;
      }

      this.clearDashboardUI();
      dashboardElement.style.display = "block";
      dashboardElement.classList.add("fade-in-up");

      locationNameElement.innerHTML = `<span class="loading-skeleton" style="width: 150px; display: inline-block;"></span>`;

      if (streetTypeChartElement)
        streetTypeChartElement.innerHTML =
          CoverageManager.createLoadingSkeleton(180);
      if (streetTypeCoverageElement)
        streetTypeCoverageElement.innerHTML =
          CoverageManager.createLoadingSkeleton(100, 3);
      mapContainer.innerHTML = CoverageManager.createLoadingIndicator(
        "Loading map data...",
      );

      try {
        const cachedData = this.getCachedData(`dashboard-${locationId}`);
        let coverageData;

        if (cachedData) {
          coverageData = cachedData;
          this.notificationManager.show(
            "Loaded dashboard from cache.",
            "info",
            1500,
          );
        } else {
          const metaResponse = await fetch(`/api/coverage_areas/${locationId}`);
          if (!metaResponse.ok) {
            const errorData = await metaResponse.json().catch(() => ({}));
            throw new Error(
              `Failed to load metadata: ${
                errorData.detail || metaResponse.statusText
              }`,
            );
          }
          const apiResponse = await metaResponse.json();
          if (
            !apiResponse.success ||
            !apiResponse.coverage ||
            !apiResponse.coverage.location
          ) {
            throw new Error(
              apiResponse.error || "Incomplete metadata received.",
            );
          }
          coverageData = apiResponse.coverage;

          const streetsResp = await fetch(
            `/api/coverage_areas/${locationId}/streets?cache_bust=${new Date().getTime()}`,
          );
          if (!streetsResp.ok) {
            const errData = await streetsResp.json().catch(() => ({}));
            throw new Error(
              `Failed to load street geometry: ${
                errData.detail || streetsResp.statusText
              }`,
            );
          }
          coverageData.streets_geojson = await streetsResp.json();
          this.setCachedData(`dashboard-${locationId}`, coverageData);
        }

        this.selectedLocation = coverageData;
        locationNameElement.textContent =
          coverageData.location.display_name || "Unnamed Area";
        this.updateDashboardStats(coverageData);
        this.updateStreetTypeCoverage(coverageData.street_types || []);
        this.createStreetTypeChart(coverageData.street_types || []);
        this.updateFilterButtonStates();

        if (coverageData.streets_geojson) {
          this.initializeCoverageMap(coverageData);
          // Update undriven streets listing
          this.updateUndrivenStreetsList(coverageData.streets_geojson);
        } else {
          mapContainer.innerHTML = CoverageManager.createAlertMessage(
            "Map Data Error",
            "Could not load street geometry.",
            "danger",
            locationId,
          );
        }

        // Restore trip overlay state
        this.showTripsActive =
          localStorage.getItem("showTripsOverlay") === "true";
        const tripToggle = document.getElementById("toggle-trip-overlay");
        if (tripToggle) tripToggle.checked = this.showTripsActive;
      } catch (error) {
        console.error("Error displaying coverage dashboard:", error);
        locationNameElement.textContent = "Error loading data";
        this.notificationManager.show(
          `Error loading dashboard: ${error.message}`,
          "danger",
        );
        mapContainer.innerHTML = CoverageManager.createAlertMessage(
          "Dashboard Load Error",
          error.message,
          "danger",
          locationId,
        );
      } finally {
        this.initTooltips();
      }
    }

    static createLoadingSkeleton(height, count = 1) {
      let skeletonHtml = "";
      for (let i = 0; i < count; i++) {
        skeletonHtml += `<div class="loading-skeleton skeleton-shimmer mb-2" style="height: ${height}px;"></div>`;
      }
      return skeletonHtml;
    }

    updateDashboardStats(coverage) {
      if (!coverage) return;
      const statsContainer = document.querySelector(
        ".dashboard-stats-card .stats-container",
      );
      if (!statsContainer) return;

      const totalLengthM = parseFloat(coverage.total_length || 0);
      const drivenLengthM = parseFloat(coverage.driven_length || 0);
      const coveragePercentage = parseFloat(
        coverage.coverage_percentage || 0,
      ).toFixed(1);
      const totalSegments = parseInt(coverage.total_segments || 0, 10);

      let coveredSegments = 0;
      if (Array.isArray(coverage.street_types)) {
        coveredSegments = coverage.street_types.reduce((sum, typeStats) => {
          const c1 = parseInt(typeStats.covered, 10);
          const c2 = parseInt(typeStats.covered_segments, 10);
          return sum + (!isNaN(c1) ? c1 : c2 || 0);
        }, 0);
      }

      const lastUpdated =
        coverage.last_stats_update || coverage.last_updated
          ? this.formatRelativeTime(
              coverage.last_stats_update || coverage.last_updated,
            )
          : "Never";

      let barColor = "bg-success";
      if (
        coverage.status === STATUS.ERROR ||
        coverage.status === STATUS.CANCELED
      )
        barColor = "bg-danger";
      else if (
        coverage.status !== STATUS.COMPLETED &&
        coverage.status !== STATUS.COMPLETE
      )
        barColor = "bg-warning";

      const html = `
        <div class="row g-3">
          ${this.createStatItem(
            CoverageManager.distanceInUserUnits(totalLengthM),
            "Total Length",
          )}
          ${this.createStatItem(
            CoverageManager.distanceInUserUnits(drivenLengthM),
            "Driven Length",
            "text-success",
          )}
          ${this.createStatItem(
            `${coveragePercentage}%`,
            "Coverage",
            "text-primary",
          )}
          ${this.createStatItem(
            totalSegments.toLocaleString(),
            "Total Segments",
          )}
          ${this.createStatItem(
            coveredSegments.toLocaleString(),
            "Driven Segments",
            "text-success",
          )}
          ${this.createStatItem(
            lastUpdated,
            "Last Updated",
            "text-muted",
            "small",
          )}
        </div>
        <div class="progress mt-3 mb-2" style="height: 12px;">
          <div class="progress-bar ${barColor}" role="progressbar" style="width: ${coveragePercentage}%" 
               aria-valuenow="${coveragePercentage}" aria-valuemin="0" aria-valuemax="100">
          </div>
        </div>
      `;
      statsContainer.innerHTML = html;
      // Smooth transition animations
      statsContainer.querySelectorAll(".stat-value").forEach((el) => {
        el.classList.add("value-updated");
        setTimeout(() => el.classList.remove("value-updated"), 600);
      });
      const progressBar = statsContainer.querySelector(".progress-bar");
      if (progressBar) {
        progressBar.style.transition = "width 0.6s ease";
      }
      this.initTooltips();
    }

    createStatItem(value, label, valueClass = "", labelClass = "") {
      return `
        <div class="col-md-4 col-6">
          <div class="stat-item">
            <div class="stat-value ${valueClass}">${value}</div>
            <div class="stat-label ${labelClass}">${label}</div>
          </div>
        </div>`;
    }

    updateStreetTypeCoverage(streetTypes) {
      const streetTypeCoverageEl = document.getElementById(
        "street-type-coverage",
      );
      if (!streetTypeCoverageEl) return;

      if (!streetTypes || !streetTypes.length) {
        streetTypeCoverageEl.innerHTML = CoverageManager.createAlertMessage(
          "No Data",
          "No street type data available.",
          "secondary",
        );
        return;
      }

      const sortedTypes = [...streetTypes].sort(
        (a, b) =>
          parseFloat(b.total_length_m || 0) - parseFloat(a.total_length_m || 0),
      );
      const topTypes = sortedTypes.slice(0, 6);

      let html = "";
      topTypes.forEach((type) => {
        const coveragePct = parseFloat(type.coverage_percentage || 0).toFixed(
          1,
        );
        const coveredDist = CoverageManager.distanceInUserUnits(
          parseFloat(type.covered_length_m || 0),
        );
        const totalDist = CoverageManager.distanceInUserUnits(
          parseFloat(
            (type.driveable_length_m !== undefined
              ? type.driveable_length_m
              : type.total_length_m) || 0,
          ),
        );
        const denominatorLabel =
          type.driveable_length_m !== undefined ? "Driveable" : "Total";

        let barColor = "bg-success";
        if (parseFloat(coveragePct) < 25) barColor = "bg-danger";
        else if (parseFloat(coveragePct) < 75) barColor = "bg-warning";

        html += `
          <div class="street-type-item mb-2">
            <div class="d-flex justify-content-between align-items-center mb-1">
              <small class="fw-bold text-truncate me-2" title="${CoverageManager.formatStreetType(
                type.type,
              )}">${CoverageManager.formatStreetType(type.type)}</small>
              <small class="text-muted text-nowrap">${coveragePct}% (${coveredDist} / ${totalDist} ${denominatorLabel})</small>
            </div>
            <div class="progress" style="height: 8px;" title="${CoverageManager.formatStreetType(
              type.type,
            )}: ${coveragePct}% Covered">
              <div class="progress-bar ${barColor}" role="progressbar" style="width: ${coveragePct}%"
                   aria-valuenow="${coveragePct}" aria-valuemin="0" aria-valuemax="100"></div>
            </div>
          </div>
        `;
      });
      streetTypeCoverageEl.innerHTML = html;
    }

    clearDashboardUI() {
      document.getElementById("dashboard-location-name").textContent =
        "Select a location";
      const statsContainer = document.querySelector(
        ".dashboard-stats-card .stats-container",
      );
      if (statsContainer) statsContainer.innerHTML = "";

      const chartContainer = document.getElementById("street-type-chart");
      if (chartContainer) chartContainer.innerHTML = "";

      const coverageEl = document.getElementById("street-type-coverage");
      if (coverageEl) coverageEl.innerHTML = "";

      const mapContainer = document.getElementById("coverage-map");
      if (mapContainer) mapContainer.innerHTML = "";

      if (this.coverageMap) {
        try {
          this.coverageMap.remove();
        } catch (e) {
          /* ignore */
        }
        this.coverageMap = null;
      }

      this.selectedLocation = null;
      this.streetsGeoJson = null;
      this.mapBounds = null;

      if (this.streetTypeChartInstance) {
        this.streetTypeChartInstance.destroy();
        this.streetTypeChartInstance = null;
      }

      this.currentDashboardLocationId = null;
      if (this.mapInfoPanel) {
        this.mapInfoPanel.remove();
        this.mapInfoPanel = null;
      }
      if (this.coverageSummaryControl && this.coverageMap) {
        try {
          this.coverageMap.removeControl(this.coverageSummaryControl);
        } catch (e) {
          /* ignore */
        }
        this.coverageSummaryControl = null;
      }
      document.title = "Coverage Management"; // Reset page title
      this.clearEfficientStreetMarkers(); // Clear efficient street suggestions
    }

    static createLoadingIndicator(message = "Loading...") {
      return `
        <div class="d-flex flex-column align-items-center justify-content-center p-4 text-center text-muted h-100">
          <div class="loading-indicator mb-3"></div>
          <small>${message}</small>
        </div>`;
    }

    static createAlertMessage(
      title,
      message,
      type = "info",
      locationId = null,
    ) {
      const iconClass =
        {
          danger: "fa-exclamation-circle",
          warning: "fa-exclamation-triangle",
          info: "fa-info-circle",
          secondary: "fa-question-circle",
        }[type] || "fa-info-circle";

      const showButton =
        locationId && (type === "danger" || type === "warning");
      const buttonHtml = showButton
        ? `
        <hr class="my-2">
        <p class="mb-1 small">Try running an update:</p>
        <button class="update-missing-data-btn btn btn-sm btn-primary" data-location-id="${locationId}">
          <i class="fas fa-sync-alt me-1"></i> Update Coverage Now
        </button>`
        : "";

      return `
        <div class="alert alert-${type} m-3 fade-in-up">
          <h5 class="alert-heading h6 mb-1"><i class="fas ${iconClass} me-2"></i>${title}</h5>
          <p class="small mb-0">${message}</p>
          ${buttonHtml}
        </div>`;
    }

    initializeCoverageMap(coverage) {
      const mapContainer = document.getElementById("coverage-map");
      if (!mapContainer) return;

      if (this.coverageMap && typeof this.coverageMap.remove === "function") {
        try {
          this.coverageMap.remove();
        } catch (e) {
          console.warn("Error removing previous map:", e);
        }
        this.coverageMap = null;
      }
      mapContainer.innerHTML = "";

      if (!window.MAPBOX_ACCESS_TOKEN) {
        mapContainer.innerHTML = CoverageManager.createAlertMessage(
          "Mapbox Token Missing",
          "Cannot display map. Please configure Mapbox access token.",
          "danger",
        );
        return;
      }
      mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;

      try {
        const mapOptions = {
          container: "coverage-map",
          style: "mapbox://styles/mapbox/dark-v11",
          center: [0, 0],
          zoom: 1,
          minZoom: 0,
          maxZoom: 20,
          preserveDrawingBuffer: true,
          attributionControl: false,
        };
        this.coverageMap = new mapboxgl.Map(mapOptions);

        this.coverageMap.addControl(
          new mapboxgl.NavigationControl(),
          "top-right",
        );
        this.coverageMap.addControl(new mapboxgl.ScaleControl());
        this.coverageMap.addControl(new mapboxgl.FullscreenControl());
        this.coverageMap.addControl(
          new mapboxgl.AttributionControl({ compact: true }),
          "bottom-right",
        );

        this.coverageMap.on("load", () => {
          if (coverage.streets_geojson) {
            this.addStreetsToMap(coverage.streets_geojson);
          } else {
            this.notificationManager.show(
              "No street data found for this area.",
              "warning",
            );
            this.mapBounds = null;
          }
          this.addCoverageSummary(coverage);
          this.fitMapToBounds();
          this.setupMapEventHandlers();

          if (this.showTripsActive) {
            this.setupTripLayers();
            this.loadTripsForView();
          }
        });

        this.coverageMap.on("error", (e) => {
          console.error("Mapbox GL Error:", e.error);
          this.notificationManager.show(
            `Map error: ${e.error?.message || "Unknown map error"}`,
            "danger",
          );
          mapContainer.innerHTML = CoverageManager.createAlertMessage(
            "Map Load Error",
            e.error?.message || "Could not initialize map.",
            "danger",
          );
        });

        if (this.mapInfoPanel) this.mapInfoPanel.remove();
        this.createMapInfoPanel();
      } catch (mapInitError) {
        console.error("Failed to initialize Mapbox GL:", mapInitError);
        mapContainer.innerHTML = CoverageManager.createAlertMessage(
          "Map Initialization Failed",
          mapInitError.message,
          "danger",
        );
      }
    }

    addStreetsToMap(geojson) {
      if (!this.coverageMap || !this.coverageMap.isStyleLoaded() || !geojson) {
        console.warn("Map not ready or no GeoJSON data to add streets.");
        return;
      }

      const layersToRemove = [
        "streets-layer",
        "streets-hover-highlight",
        "streets-click-highlight",
      ];
      layersToRemove.forEach((layerId) => {
        if (this.coverageMap.getLayer(layerId))
          this.coverageMap.removeLayer(layerId);
      });
      if (this.coverageMap.getSource("streets"))
        this.coverageMap.removeSource("streets");

      this.streetsGeoJson = geojson;
      this.currentFilter = "all"; // Reset filter when new streets are added

      try {
        this.coverageMap.addSource("streets", {
          type: "geojson",
          data: geojson,
          promoteId: "segment_id", // Ensure segment_id is promoted for feature state
        });

        // Updated getLineColor to handle efficient street highlighting
        const getLineColor = [
          "case",
          ["boolean", ["feature-state", "hover"], false],
          "#ffff00", // Yellow hover
          ["!=", ["feature-state", "efficientRank"], null], // Check if efficientRank state exists
          [
            "case", // If efficientRank exists, apply rank-based colors
            ["==", ["feature-state", "efficientRank"], 1],
            "#ffd700", // Gold for rank 1
            ["==", ["feature-state", "efficientRank"], 2],
            "#c0c0c0", // Silver for rank 2
            ["==", ["feature-state", "efficientRank"], 3],
            "#cd7f32", // Bronze for rank 3
            "#9467bd", // Purple for other ranks (if any)
          ],
          // Fallback to original logic if not an efficient street
          ["boolean", ["get", "undriveable"], false],
          "#607d8b", // Grey undriveable
          ["boolean", ["get", "driven"], false],
          "#4caf50", // Green driven
          "#ff5252", // Red not driven
        ];

        const getLineWidth = [
          "interpolate",
          ["linear"],
          ["zoom"],
          8,
          1.5,
          14,
          4,
          18,
          7,
        ];
        const getLineOpacity = [
          "case",
          ["boolean", ["feature-state", "hover"], false],
          1.0,
          ["boolean", ["get", "undriveable"], false],
          0.6,
          0.85,
        ];
        const getLineDash = [
          "case",
          ["boolean", ["get", "undriveable"], false],
          ["literal", [2, 2]],
          ["literal", [1, 0]],
        ];

        this.coverageMap.addLayer({
          id: "streets-layer",
          type: "line",
          source: "streets",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": getLineColor,
            "line-width": getLineWidth,
            "line-opacity": getLineOpacity,
            "line-dasharray": getLineDash,
          },
        });

        const bounds = new mapboxgl.LngLatBounds();
        geojson.features.forEach((f) => {
          if (f.geometry?.coordinates) {
            if (f.geometry.type === "LineString")
              f.geometry.coordinates.forEach((coord) => bounds.extend(coord));
            else if (f.geometry.type === "MultiLineString")
              f.geometry.coordinates.forEach((line) =>
                line.forEach((coord) => bounds.extend(coord)),
              );
          }
        });
        this.mapBounds = !bounds.isEmpty() ? bounds : null;

        let hoveredSegmentId = null;
        this.coverageMap.on("mouseenter", "streets-layer", (e) => {
          this.coverageMap.getCanvas().style.cursor = "pointer";
          if (e.features?.length > 0) {
            const props = e.features[0].properties;
            const currentHoverId = props.segment_id;
            if (currentHoverId !== hoveredSegmentId) {
              if (
                hoveredSegmentId !== null &&
                this.coverageMap.getSource("streets")
              ) {
                this.coverageMap.setFeatureState(
                  { source: "streets", id: hoveredSegmentId },
                  { hover: false },
                );
              }
              if (this.coverageMap.getSource("streets")) {
                this.coverageMap.setFeatureState(
                  { source: "streets", id: currentHoverId },
                  { hover: true },
                );
              }
              hoveredSegmentId = currentHoverId;
            }
            this.updateMapInfoPanel(props, true);
            if (this.mapInfoPanel) this.mapInfoPanel.style.display = "block";
          }
        });

        this.coverageMap.on("mouseleave", "streets-layer", () => {
          this.coverageMap.getCanvas().style.cursor = "";
          if (this.mapInfoPanel) this.mapInfoPanel.style.display = "none";
          if (
            hoveredSegmentId !== null &&
            this.coverageMap.getSource("streets")
          ) {
            this.coverageMap.setFeatureState(
              { source: "streets", id: hoveredSegmentId },
              { hover: false },
            );
          }
          hoveredSegmentId = null;
        });

        this.coverageMap.on("click", "streets-layer", (e) => {
          if (e.originalEvent?.button !== 0) return;
          if (e.features?.length > 0) {
            const props = e.features[0].properties;
            const popupContent = this.createStreetPopupContentHTML(props);
            const popup = new mapboxgl.Popup({
              closeButton: true,
              closeOnClick: true,
              maxWidth: "350px",
              className: "coverage-popup",
            })
              .setLngLat(e.lngLat)
              .setHTML(popupContent)
              .addTo(this.coverageMap);

            const popupElement = popup.getElement();
            if (popupElement) {
              popupElement.addEventListener("click", (event) => {
                const button = event.target.closest("button[data-action]");
                if (button) {
                  const action = button.dataset.action;
                  const segmentId = button.dataset.segmentId;
                  if (action && segmentId) {
                    this._handleMarkSegmentAction(action, segmentId);
                    popup.remove();
                  }
                }
              });
            }
            this.updateMapInfoPanel(props, false);
            if (this.mapInfoPanel) this.mapInfoPanel.style.display = "block";
          }
        });
      } catch (error) {
        console.error("Error adding streets source/layer:", error);
        this.notificationManager.show(
          `Failed to display streets: ${error.message}`,
          "danger",
        );
      }
    }

    createStreetPopupContentHTML(props) {
      const streetName =
        props.street_name ||
        props.name ||
        props.display_name ||
        "Unnamed Street";
      const streetType =
        props.highway || props.inferred_highway_type || "unknown";
      const segmentLength = parseFloat(
        props.segment_length || props.segment_length_m || props.length || 0,
      );
      const lengthFormatted =
        CoverageManager.distanceInUserUnits(segmentLength);
      const isDriven =
        props.driven === true || String(props.driven).toLowerCase() === "true";
      const isUndriveable =
        props.undriveable === true ||
        String(props.undriveable).toLowerCase() === "true";
      const status = isDriven ? "Driven" : "Not Driven";
      const segmentId = props.segment_id || "N/A";

      return `
        <div class="coverage-popup-content">
          <div class="popup-title">${streetName}</div>
          <div class="popup-detail"><span class="popup-label">Type:</span><span class="popup-value">${CoverageManager.formatStreetType(
            streetType,
          )}</span></div>
          <div class="popup-detail"><span class="popup-label">Length:</span><span class="popup-value">${lengthFormatted}</span></div>
          <div class="popup-detail"><span class="popup-label">Status:</span><span class="popup-value ${
            isDriven ? "status-driven" : "status-undriven"
          }">${status}</span></div>
          ${
            isUndriveable
              ? `<div class="popup-detail"><span class="popup-label">Marked as:</span> <span class="popup-value status-undriveable">Undriveable</span></div>`
              : ""
          }
          <div class="popup-detail"><span class="popup-label">ID:</span><span class="popup-value segment-id">${segmentId}</span></div>
          <div class="street-actions">
            ${
              !isDriven
                ? `<button class="btn btn-sm btn-outline-success mark-driven-btn" data-action="driven" data-segment-id="${segmentId}"><i class="fas fa-check me-1"></i>Mark Driven</button>`
                : ""
            }
            ${
              isDriven
                ? `<button class="btn btn-sm btn-outline-danger mark-undriven-btn" data-action="undriven" data-segment-id="${segmentId}"><i class="fas fa-times me-1"></i>Mark Undriven</button>`
                : ""
            }
            ${
              !isUndriveable
                ? `<button class="btn btn-sm btn-outline-warning mark-undriveable-btn" data-action="undriveable" data-segment-id="${segmentId}"><i class="fas fa-ban me-1"></i>Mark Undriveable</button>`
                : ""
            }
            ${
              isUndriveable
                ? `<button class="btn btn-sm btn-outline-info mark-driveable-btn" data-action="driveable" data-segment-id="${segmentId}"><i class="fas fa-road me-1"></i>Mark Driveable</button>`
                : ""
            }
          </div>
        </div>`;
    }

    async _handleMarkSegmentAction(action, segmentId) {
      const activeLocationId =
        this.selectedLocation?._id || this.currentDashboardLocationId;
      if (!activeLocationId || !segmentId) {
        this.notificationManager.show(
          "Cannot perform action: Missing ID.",
          "warning",
        );
        return;
      }

      let endpoint = "";
      const payload = { location_id: activeLocationId, segment_id: segmentId };

      switch (action) {
        case "driven":
          endpoint = "/api/street_segments/mark_driven";
          break;
        case "undriven":
          endpoint = "/api/street_segments/mark_undriven";
          break;
        case "undriveable":
          endpoint = "/api/street_segments/mark_undriveable";
          break;
        case "driveable":
          endpoint = "/api/street_segments/mark_driveable";
          break;
        default:
          this.notificationManager.show(`Unknown action: ${action}`, "warning");
          return;
      }

      try {
        await this._makeSegmentApiRequest(endpoint, payload);
        this.notificationManager.show(
          `Segment marked as ${action}. Refreshing...`,
          "success",
          2000,
        );

        // Optimistic UI update
        if (
          this.streetsGeoJson?.features &&
          this.coverageMap?.getSource("streets")
        ) {
          const featureIndex = this.streetsGeoJson.features.findIndex(
            (f) => f.properties.segment_id === segmentId,
          );
          if (featureIndex !== -1) {
            const feature = this.streetsGeoJson.features[featureIndex];
            switch (action) {
              case "driven":
                feature.properties.driven = true;
                feature.properties.undriveable = false;
                break;
              case "undriven":
                feature.properties.driven = false;
                break;
              case "undriveable":
                feature.properties.undriveable = true;
                feature.properties.driven = false;
                break;
              case "driveable":
                feature.properties.undriveable = false;
                break;
            }
            const newGeoJson = {
              ...this.streetsGeoJson,
              features: [...this.streetsGeoJson.features],
            };
            newGeoJson.features[featureIndex] = { ...feature };
            this.coverageMap.getSource("streets").setData(newGeoJson);
            this.streetsGeoJson = newGeoJson;
            // Refresh undriven streets list after segment status change
            this.updateUndrivenStreetsList(this.streetsGeoJson);
          }
        }
        // Full refresh of stats and potentially map data
        await this.refreshDashboardData(activeLocationId);
        await this.loadCoverageAreas(); // Refresh main table
      } catch (error) {
        this.notificationManager.show(
          `Failed to mark segment: ${error.message}`,
          "danger",
        );
      }
    }

    async refreshDashboardData(locationId) {
      try {
        const refreshResp = await fetch(
          `/api/coverage_areas/${locationId}/refresh_stats`,
          { method: "POST" },
        );
        const refreshData = await refreshResp.json();
        if (refreshResp.ok && refreshData.coverage) {
          this.selectedLocation = refreshData.coverage;
          this.updateDashboardStats(refreshData.coverage);
          this.addCoverageSummary(refreshData.coverage);
          this.updateStreetTypeCoverage(
            refreshData.coverage.street_types || [],
          );
          if (this.streetTypeChartInstance)
            this.streetTypeChartInstance.destroy();
          this.createStreetTypeChart(refreshData.coverage.street_types || []);
        } else {
          this.notificationManager.show(
            `Failed to refresh stats: ${refreshData.detail || "Unknown error"}`,
            "warning",
          );
        }
      } catch (e) {
        console.error("Error refreshing stats:", e);
        this.notificationManager.show(
          `Error fetching updated stats: ${e.message}`,
          "danger",
        );
      }
    }

    async _makeSegmentApiRequest(endpoint, payload) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (!response.ok)
          throw new Error(
            data.detail || `API request failed (HTTP ${response.status})`,
          );
        return data;
      } catch (error) {
        console.error(`Error calling ${endpoint}:`, error);
        throw error;
      }
    }

    fitMapToBounds() {
      if (this.coverageMap && this.mapBounds && !this.mapBounds.isEmpty()) {
        try {
          this.coverageMap.fitBounds(this.mapBounds, {
            padding: 20,
            maxZoom: 17,
            duration: 800,
          });
        } catch (e) {
          console.error("Error fitting map to bounds:", e);
          this.notificationManager.show(
            "Could not zoom to area bounds. Map view may be incorrect.",
            "warning",
          );
        }
      } else if (this.coverageMap) {
        this.notificationManager.show(
          "No geographical data to display for this area.",
          "info",
        );
      }
    }

    setMapFilter(filterType, updateButtons = true) {
      if (!this.coverageMap || !this.coverageMap.getLayer("streets-layer"))
        return;
      this.currentFilter = filterType;
      let filter = null;

      if (filterType === "driven")
        filter = [
          "all",
          ["==", ["get", "driven"], true],
          ["!=", ["get", "undriveable"], true],
        ];
      else if (filterType === "undriven")
        filter = [
          "all",
          ["==", ["get", "driven"], false],
          ["!=", ["get", "undriveable"], true],
        ];
      else if (filterType === "undriveable")
        filter = ["==", ["get", "undriveable"], true];

      try {
        this.coverageMap.setFilter("streets-layer", filter);
        if (updateButtons) this.updateFilterButtonStates();
      } catch (error) {
        console.error("Error setting map filter:", error);
        this.notificationManager.show(
          `Failed to apply map filter: ${error.message}`,
          "danger",
        );
      }
    }

    updateFilterButtonStates() {
      const filterButtons = document.querySelectorAll(
        ".map-controls button[data-filter]",
      );
      filterButtons.forEach((btn) => {
        // Remove all possible style classes to prevent conflicts
        btn.classList.remove(
          "active",
          "btn-primary",
          "btn-outline-primary",
          "btn-success",
          "btn-outline-success",
          "btn-danger",
          "btn-outline-danger",
          "btn-warning",
          "btn-outline-warning",
        );

        let buttonClass = "";
        // Determine the class based on whether the button's filter is the current one
        if (btn.dataset.filter === this.currentFilter) {
          btn.classList.add("active"); // Add active class if it's selected
          // Assign the solid button style
          if (this.currentFilter === "driven") buttonClass = "btn-success";
          else if (this.currentFilter === "undriven")
            buttonClass = "btn-danger";
          else if (this.currentFilter === "undriveable")
            buttonClass = "btn-warning";
          else buttonClass = "btn-primary"; // for 'all' filter
        } else {
          // Assign the outline button style for inactive buttons
          if (btn.dataset.filter === "driven")
            buttonClass = "btn-outline-success";
          else if (btn.dataset.filter === "undriven")
            buttonClass = "btn-outline-danger";
          else if (btn.dataset.filter === "undriveable")
            buttonClass = "btn-outline-warning";
          else buttonClass = "btn-outline-primary"; // for 'all' filter
        }

        btn.classList.add(buttonClass);
      });
    }

    static getStageIcon(stage) {
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
        [STATUS.POLLING_CHECK]: '<i class="fas fa-sync-alt fa-spin"></i>',
        [STATUS.UNKNOWN]: '<i class="fas fa-question-circle"></i>',
        [STATUS.POST_PREPROCESSING]: '<i class="fas fa-cog fa-spin"></i>',
      };
      return icons[stage] || icons[STATUS.UNKNOWN];
    }

    static getStageTextClass(stage) {
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

    static formatStageName(stage) {
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
        [STATUS.POLLING_CHECK]: "Checking Status",
        [STATUS.UNKNOWN]: "Unknown",
        [STATUS.POST_PREPROCESSING]: "Post-processing",
      };
      return (
        stageNames[stage] ||
        stage.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
      );
    }

    static formatStreetType(type) {
      if (!type) return "Unknown";
      return type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
    }

    setupTripLayers() {
      if (!this.coverageMap || !this.coverageMap.isStyleLoaded()) return;
      if (!this.coverageMap.getSource("trips-source")) {
        this.coverageMap.addSource("trips-source", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }
      if (!this.coverageMap.getLayer("trips-layer")) {
        this.coverageMap.addLayer(
          {
            id: "trips-layer",
            type: "line",
            source: "trips-source",
            layout: { "line-join": "round", "line-cap": "round" },
            paint: {
              "line-color": "#3388ff",
              "line-width": 2.5,
              "line-opacity": 0.75,
              "line-blur": 0.5,
            },
          },
          "streets-layer",
        ); // Add below streets
      }
    }

    clearTripOverlay() {
      if (!this.coverageMap || !this.coverageMap.getSource("trips-source"))
        return;
      try {
        this.coverageMap
          .getSource("trips-source")
          .setData({ type: "FeatureCollection", features: [] });
      } catch (error) {
        console.warn("Error clearing trip overlay:", error);
      }
    }

    async loadTripsForView() {
      if (
        !this.coverageMap ||
        !this.showTripsActive ||
        !this.coverageMap.isStyleLoaded()
      )
        return;
      this.setupTripLayers();
      const tripsSource = this.coverageMap.getSource("trips-source");
      if (!tripsSource) return;

      const bounds = this.coverageMap.getBounds();
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      const zoom = this.coverageMap.getZoom();

      if (zoom < 12) {
        // Only load trips if zoomed in sufficiently
        this.notificationManager.show(
          "Zoom in further to view trip overlays.",
          "info",
          2000,
        );
        this.clearTripOverlay();
        return;
      }

      const params = new URLSearchParams({
        min_lat: sw.lat.toFixed(6),
        min_lon: sw.lng.toFixed(6),
        max_lat: ne.lat.toFixed(6),
        max_lon: ne.lng.toFixed(6),
      });
      try {
        const response = await fetch(
          `/api/trips_in_bounds?${params.toString()}`,
        );
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.detail || `HTTP Error ${response.status}`);
        }
        const data = await response.json();
        if (!data || !Array.isArray(data.trips))
          throw new Error("Invalid trip data received.");

        const tripFeatures = data.trips
          .map((coords, index) => {
            if (
              !Array.isArray(coords) ||
              coords.length < 2 ||
              !Array.isArray(coords[0]) ||
              coords[0].length < 2
            )
              return null;
            return {
              type: "Feature",
              properties: { tripId: `trip-${index}` },
              geometry: { type: "LineString", coordinates: coords },
            };
          })
          .filter((feature) => feature !== null);

        tripsSource.setData({
          type: "FeatureCollection",
          features: tripFeatures,
        });
      } catch (error) {
        this.notificationManager.show(
          `Failed to load trip overlay: ${error.message}`,
          "danger",
        );
        this.clearTripOverlay();
      }
    }

    createMapInfoPanel() {
      if (document.querySelector(".map-info-panel")) return;
      this.mapInfoPanel = document.createElement("div");
      this.mapInfoPanel.className = "map-info-panel";
      this.mapInfoPanel.style.display = "none";
      const mapContainer = document.getElementById("coverage-map");
      if (mapContainer) mapContainer.appendChild(this.mapInfoPanel);
      else console.warn("Map container not found for info panel.");
    }

    updateMapInfoPanel(props, isHover = false) {
      if (!this.mapInfoPanel) return;
      const streetName = props.name || props.street_name || "Unnamed Street";
      const streetType =
        props.highway || props.inferred_highway_type || "unknown";
      const segmentLength = parseFloat(
        props.segment_length || props.segment_length_m || props.length || 0,
      );
      const lengthFormatted =
        CoverageManager.distanceInUserUnits(segmentLength);
      const isDriven =
        props.driven === true || String(props.driven).toLowerCase() === "true";
      const isUndriveable =
        props.undriveable === true ||
        String(props.undriveable).toLowerCase() === "true";
      const status = isDriven ? "Driven" : "Not Driven";
      const segmentId = props.segment_id || "N/A";

      this.mapInfoPanel.innerHTML = `
        <strong class="d-block mb-1">${streetName}</strong>
        ${isHover ? "" : '<hr class="panel-divider my-1">'}
        <div class="d-flex justify-content-between small"><span class="text-muted">Type:</span><span class="text-info">${CoverageManager.formatStreetType(
          streetType,
        )}</span></div>
        <div class="d-flex justify-content-between small"><span class="text-muted">Length:</span><span class="text-info">${lengthFormatted}</span></div>
        <div class="d-flex justify-content-between small"><span class="text-muted">Status:</span><span class="${
          isDriven ? "text-success" : "text-danger"
        }"><i class="fas fa-${
          isDriven ? "check-circle" : "times-circle"
        } me-1"></i>${status}</span></div>
        ${
          isUndriveable
            ? `<div class="d-flex justify-content-between small"><span class="text-muted">Marked:</span><span class="text-warning"><i class="fas fa-exclamation-triangle me-1"></i>Undriveable</span></div>`
            : ""
        }
        ${
          isHover
            ? ""
            : `<div class="d-flex justify-content-between small mt-1"><span class="text-muted">ID:</span><span class="text-muted">${segmentId.substring(
                0,
                12,
              )}...</span></div><div class="mt-2 small text-center text-muted opacity-75">Click segment for actions</div>`
        }`;
      if (!isHover) this.mapInfoPanel.style.display = "block";
    }

    createStreetTypeChart(streetTypes) {
      const chartContainer = document.getElementById("street-type-chart");
      if (!chartContainer) return;
      if (this.streetTypeChartInstance) this.streetTypeChartInstance.destroy();

      if (!streetTypes || !streetTypes.length) {
        chartContainer.innerHTML = CoverageManager.createAlertMessage(
          "No Data",
          "No street type data available for chart.",
          "secondary",
        );
        return;
      }

      const sortedTypes = [...streetTypes]
        .sort((a, b) => (b.total_length_m || 0) - (a.total_length_m || 0))
        .slice(0, 10); // Top 10 types
      const labels = sortedTypes.map((t) =>
        CoverageManager.formatStreetType(t.type),
      );
      const covered = sortedTypes.map(
        (t) => (t.covered_length_m || 0) * 0.000621371,
      );
      const driveable = sortedTypes.map(
        (t) => (t.driveable_length_m || 0) * 0.000621371,
      );
      const coveragePct = sortedTypes.map((t) => t.coverage_percentage || 0);

      chartContainer.innerHTML =
        '<canvas id="streetTypeChartCanvas" style="min-height: 180px;"></canvas>';
      const ctx = document
        .getElementById("streetTypeChartCanvas")
        .getContext("2d");

      this.streetTypeChartInstance = new Chart(ctx, {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              label: "Covered (mi)",
              data: covered,
              backgroundColor: "#4caf50",
              order: 1,
            },
            {
              label: "Driveable (mi)",
              data: driveable,
              backgroundColor: "#607d8b",
              order: 1,
            },
            {
              label: "% Covered",
              data: coveragePct,
              type: "line",
              yAxisID: "y1",
              borderColor: "#ffb300",
              tension: 0.2,
              order: 0,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: "bottom",
              labels: { color: "#fff", boxWidth: 15, padding: 15 },
            },
            tooltip: {
              mode: "index",
              intersect: false,
              callbacks: {
                label: (ctx) =>
                  `${ctx.dataset.label}: ${
                    ctx.dataset.label === "% Covered"
                      ? `${ctx.parsed.y.toFixed(1)}%`
                      : `${ctx.parsed.y.toFixed(2)} mi`
                  }`,
              },
            },
          },
          scales: {
            x: {
              ticks: { color: "#ccc", font: { size: 10 } },
              grid: { color: "rgba(255,255,255,0.05)" },
            },
            y: {
              beginAtZero: true,
              title: { display: true, text: "Distance (mi)", color: "#ccc" },
              ticks: { color: "#ccc" },
              grid: { color: "rgba(255,255,255,0.1)" },
            },
            y1: {
              beginAtZero: true,
              position: "right",
              title: { display: true, text: "% Covered", color: "#ffb300" },
              ticks: { color: "#ffb300", callback: (v) => `${v}%` },
              grid: { drawOnChartArea: false },
              min: 0,
              max: 100,
            },
          },
        },
      });
    }

    addCoverageSummary(coverage) {
      if (this.coverageSummaryControl && this.coverageMap?.removeControl) {
        try {
          this.coverageMap.removeControl(this.coverageSummaryControl);
        } catch (e) {
          /* ignore */
        }
        this.coverageSummaryControl = null;
      }
      if (!coverage || !this.coverageMap) return;

      const coveragePercentage = parseFloat(
        coverage.coverage_percentage || 0,
      ).toFixed(1);
      const totalDist = CoverageManager.distanceInUserUnits(
        coverage.total_length_m || coverage.total_length || 0,
      );
      const drivenDist = CoverageManager.distanceInUserUnits(
        coverage.driven_length_m || coverage.driven_length || 0,
      );

      const controlDiv = document.createElement("div");
      controlDiv.className =
        "coverage-summary-control mapboxgl-ctrl mapboxgl-ctrl-group";
      controlDiv.innerHTML = `
        <div class="summary-title">Overall Coverage</div>
        <div class="summary-percentage">${coveragePercentage}%</div>
        <div class="summary-progress"><div class="progress" style="height: 8px;"><div class="progress-bar bg-success" role="progressbar" style="width: ${coveragePercentage}%"></div></div></div>
        <div class="summary-details"><div>Total: ${totalDist}</div><div>Driven: ${drivenDist}</div></div>`;

      this.coverageSummaryControl = {
        onAdd: () => controlDiv,
        onRemove: () => controlDiv.remove(),
        getDefaultPosition: () => "top-left",
      };
      try {
        this.coverageMap.addControl(this.coverageSummaryControl, "top-left");
      } catch (e) {
        console.error("Error adding coverage summary control:", e);
      }
    }

    exportCoverageMap() {
      const mapContainer = document.getElementById("coverage-map");
      if (!this.coverageMap || !mapContainer) {
        this.notificationManager.show("Map not ready for export.", "warning");
        return;
      }
      this.notificationManager.show("Preparing map export...", "info");

      const doExport = () => {
        setTimeout(() => {
          // Allow map to render fully
          html2canvas(mapContainer, {
            useCORS: true,
            backgroundColor: "#1e1e1e",
            logging: false,
            allowTaint: true,
            width: mapContainer.offsetWidth,
            height: mapContainer.offsetHeight,
          })
            .then((canvas) => {
              canvas.toBlob((blob) => {
                if (!blob) {
                  this.notificationManager.show(
                    "Failed to create image blob.",
                    "danger",
                  );
                  return;
                }
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                const locationName =
                  this.selectedLocation?.location?.display_name ||
                  "coverage_map";
                const dateStr = new Date().toISOString().split("T")[0];
                a.download = `${locationName
                  .replace(/[^a-z0-9]/gi, "_")
                  .toLowerCase()}_${dateStr}.png`;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                  this.notificationManager.show("Map exported.", "success");
                }, 100);
              }, "image/png");
            })
            .catch((error) => {
              console.error("html2canvas export error:", error);
              this.notificationManager.show(
                `Map export failed: ${error.message}`,
                "danger",
              );
            });
        }, 500);
      };

      if (typeof html2canvas === "undefined") {
        const script = document.createElement("script");
        script.src =
          "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
        script.integrity =
          "sha512-BNaRQnYJYiPSqHHDb58B0yaPfCu+Wgds8Gp/gU33kqBtgNS4tSPHuGibyoeqMV/TJlSKda6FXzoEyYGjTe+vXA==";
        script.crossOrigin = "anonymous";
        script.onload = doExport;
        script.onerror = () =>
          this.notificationManager.show(
            "Failed to load export library.",
            "danger",
          );
        document.head.appendChild(script);
      } else {
        doExport();
      }
    }

    // New method to find most efficient streets
    async findMostEfficientStreets() {
      if (!this.selectedLocation || !this.selectedLocation._id) {
        this.notificationManager.show(
          "Please select a coverage area first.",
          "warning",
        );
        return;
      }

      // Try to get current position
      let currentLat, currentLon;
      let positionSource = "unknown";

      try {
        // First try to get from browser geolocation
        const position = await this.getCurrentPosition();
        currentLat = position.coords.latitude;
        currentLon = position.coords.longitude;
        positionSource = "browser";
      } catch (error) {
        // If geolocation fails, try to get from active trip
        try {
          const activeTripResponse = await fetch("/api/trip/active");
          if (activeTripResponse.ok) {
            const activeTripData = await activeTripResponse.json();
            if (
              activeTripData.trip &&
              activeTripData.trip.coordinates &&
              activeTripData.trip.coordinates.length > 0
            ) {
              const lastCoord =
                activeTripData.trip.coordinates[
                  activeTripData.trip.coordinates.length - 1
                ];
              currentLat = lastCoord.lat;
              currentLon = lastCoord.lon;
              positionSource = "active-trip";
            }
          }
        } catch (tripError) {
          // If that fails too, check for last trip
          try {
            const lastTripResponse = await fetch("/api/trips?limit=1");
            if (lastTripResponse.ok) {
              const tripsData = await lastTripResponse.json();
              if (tripsData.trips && tripsData.trips.length > 0) {
                const lastTrip = tripsData.trips[0];
                if (
                  lastTrip.destinationGeoPoint &&
                  lastTrip.destinationGeoPoint.coordinates
                ) {
                  currentLon = lastTrip.destinationGeoPoint.coordinates[0];
                  currentLat = lastTrip.destinationGeoPoint.coordinates[1];
                  positionSource = "last-trip";
                }
              }
            }
          } catch (lastTripError) {
            this.notificationManager.show(
              "Unable to determine current position. Please enable location services or start a trip.",
              "warning",
            );
            return;
          }
        }
      }

      if (currentLat === undefined || currentLon === undefined) {
        this.notificationManager.show(
          "Unable to determine current position. Please enable location services or start/complete a trip.",
          "warning",
        );
        return;
      }

      // Show loading state
      const btn = document.getElementById("find-efficient-street-btn");
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin me-2"></i>Finding...';
      }

      try {
        const response = await fetch(
          `/api/driving-navigation/suggest-next-street/${this.selectedLocation._id}?` +
            `current_lat=${currentLat}&current_lon=${currentLon}&top_n=3`,
        );

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.detail || `HTTP error ${response.status}`);
        }

        const data = await response.json();

        if (
          data.status === "no_streets" ||
          data.status === "no_valid_streets" ||
          data.status === "no_clusters"
        ) {
          this.notificationManager.show(data.message, "info");
          this.clearEfficientStreetMarkers(); // Clear any previous suggestions
          return;
        }

        if (
          data.status === "success" &&
          data.suggested_clusters &&
          data.suggested_clusters.length > 0
        ) {
          this.suggestedEfficientStreets = data.suggested_clusters; // Changed from suggested_streets
          this.displayEfficientStreets(data.suggested_clusters, positionSource); // Changed from suggested_streets

          // Show notification
          const topCluster = data.suggested_clusters[0];
          const distanceMiles = (
            topCluster.distance_to_cluster_m / 1609.34
          ).toFixed(1);
          const lengthMiles = (topCluster.total_length_m / 1609.34).toFixed(2);
          const startingStreetName = topCluster.nearest_segment.street_name;

          this.notificationManager.show(
            `Found ${data.suggested_clusters.length} efficient street clusters. ` +
              `Top cluster (starts with ${startingStreetName}): ${distanceMiles} mi away, ${lengthMiles} mi total length.`,
            "success",
            7000, // Increased duration for longer message
          );
        } else if (
          data.suggested_clusters &&
          data.suggested_clusters.length === 0
        ) {
          this.notificationManager.show(
            "No efficient street clusters found matching criteria.",
            "info",
          );
          this.clearEfficientStreetMarkers();
        } else {
          this.notificationManager.show(
            data.message || "Could not retrieve suggestions.",
            "warning",
          );
          this.clearEfficientStreetMarkers();
        }
      } catch (error) {
        console.error("Error finding efficient streets:", error);
        this.notificationManager.show(
          `Error finding efficient streets: ${error.message}`,
          "danger",
        );
        this.clearEfficientStreetMarkers();
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML =
            '<i class="fas fa-bullseye me-2"></i>Find Most Efficient Streets';
        }
      }
    }

    // Helper method to get current position
    getCurrentPosition() {
      return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
          reject(new Error("Geolocation is not supported"));
          return;
        }

        navigator.geolocation.getCurrentPosition(
          (position) => resolve(position),
          (error) => reject(error),
          {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0,
          },
        );
      });
    }

    // Display efficient streets on the coverage map
    displayEfficientStreets(clusters, positionSource) {
      // Argument changed from streets to clusters
      if (!this.coverageMap || !this.coverageMap.isStyleLoaded()) return;

      // Clear previous markers and feature states
      this.clearEfficientStreetMarkers(false); // Pass false to not remove panel yet

      this.suggestedEfficientStreets = clusters; // Store the clusters

      const colors = ["#ffd700", "#c0c0c0", "#cd7f32"]; // Gold, Silver, Bronze for ranks
      const defaultClusterColor = "#9467bd"; // Default for other ranks

      // Add markers and highlights for each suggested cluster
      clusters.forEach((cluster, index) => {
        const rank = index + 1;
        const markerColor = colors[index] || defaultClusterColor;

        // Highlight ALL segments within this cluster
        if (
          cluster.segments &&
          Array.isArray(cluster.segments) &&
          this.coverageMap.getSource("streets")
        ) {
          cluster.segments.forEach((segment) => {
            const segmentId =
              segment.segment_id || segment.properties?.segment_id;
            if (segmentId) {
              this.coverageMap.setFeatureState(
                { source: "streets", id: segmentId },
                { efficientRank: rank }, // Store rank (1-based)
              );
            }
          });
        }

        // Add marker at the start of the nearest segment in the cluster
        // (or centroid if preferred, but start_coords is good for navigation start)
        if (cluster.nearest_segment && cluster.nearest_segment.start_coords) {
          const startPoint = cluster.nearest_segment.start_coords;
          const el = document.createElement("div");
          el.className = "efficient-street-marker-mapbox"; // Ensure this class exists or style directly
          el.innerHTML = `
            <div style="background-color: ${markerColor}; border: 2px solid white; 
                 border-radius: 50%; width: 30px; height: 30px; display: flex; 
                 align-items: center; justify-content: center; font-weight: bold; 
                 color: ${
                   index === 0 ? "black" : "white"
                 }; box-shadow: 0 2px 8px rgba(0,0,0,0.3);">
              ${rank}
            </div>
          `;

          const marker = new mapboxgl.Marker(el)
            .setLngLat(startPoint)
            .setPopup(this.createEfficientStreetPopup(cluster, index)) // Pass cluster and rank
            .addTo(this.coverageMap);

          this.efficientStreetMarkers.push(marker);
        } else {
          console.warn(
            "Cluster missing nearest_segment.start_coords, cannot place marker:",
            cluster,
          );
        }
      });

      // Show info panel
      this.showEfficientStreetsPanel(clusters, positionSource);

      // Fit map to show all suggestions
      const bounds = new mapboxgl.LngLatBounds();
      clusters.forEach((cluster) => {
        // Extend bounds to include all segments in the cluster for better visibility.
        if (cluster.segments && Array.isArray(cluster.segments)) {
          cluster.segments.forEach((segment) => {
            if (
              segment.geometry &&
              segment.geometry.type === "LineString" &&
              segment.geometry.coordinates
            ) {
              segment.geometry.coordinates.forEach((coord) =>
                bounds.extend(coord),
              );
            } else if (
              segment.geometry &&
              segment.geometry.type === "MultiLineString" &&
              segment.geometry.coordinates
            ) {
              segment.geometry.coordinates.forEach((line) =>
                line.forEach((coord) => bounds.extend(coord)),
              );
            }
          });
        } else if (
          cluster.nearest_segment &&
          cluster.nearest_segment.start_coords
        ) {
          // Fallback to nearest segment start point if full segment data isn't readily available for bounds
          bounds.extend(cluster.nearest_segment.start_coords);
        }
      });

      if (!bounds.isEmpty()) {
        this.coverageMap.fitBounds(bounds, {
          padding: { top: 100, bottom: 50, left: 50, right: 400 },
          maxZoom: 17,
        }); // Increased right padding if panel is on right
      }
    }

    // Create popup for efficient street
    createEfficientStreetPopup(cluster, rank) {
      // Argument changed to cluster
      const nearestSegment = cluster.nearest_segment;
      const streetName = nearestSegment.street_name || "Unnamed Street";

      const totalLengthMiles = (cluster.total_length_m / 1609.34).toFixed(2);
      const distanceToClusterMiles = (
        cluster.distance_to_cluster_m / 1609.34
      ).toFixed(1);
      const efficiencyScore = cluster.efficiency_score.toFixed(2);
      const segmentCount = cluster.segment_count;

      const popup = new mapboxgl.Popup({
        closeButton: true,
        closeOnClick: true,
        maxWidth: "320px", // Adjusted max width
      });

      const content = `
        <div class="efficient-street-popup p-3">
          <h6 class="mb-2 fw-bold text-primary">#${
            rank + 1
          } Efficient Cluster</h6>
          <div class="mb-1"><strong>Starts with:</strong> ${streetName}</div>
          <div class="small text-muted mb-2">Cluster ID: ${cluster.cluster_id.substring(
            0,
            8,
          )}...</div>
          
          <div class="efficiency-metrics small">
            <div><i class="fas fa-ruler text-info me-1"></i> Total Length: ${totalLengthMiles} mi</div>
            <div><i class="fas fa-road text-info me-1"></i> Segments: ${segmentCount}</div>
            <div><i class="fas fa-location-arrow text-warning me-1"></i> Approx. Distance: ${distanceToClusterMiles} mi</div>
            <div><i class="fas fa-chart-line text-success me-1"></i> Efficiency Score: ${efficiencyScore}</div>
          </div>
          
          <hr class="my-2">
          <div class="text-center">
            <button class="btn btn-sm btn-outline-light copy-segment-id-btn" data-segment-id="${
              nearestSegment.segment_id
            }" title="Copy ID of starting segment">
              <i class="fas fa-copy me-1"></i> Copy Start Segment ID
            </button>
          </div>
        </div>
      `;

      popup.setHTML(content);

      popup.on("open", () => {
        const copyButton = popup
          .getElement()
          .querySelector(".copy-segment-id-btn");
        if (copyButton) {
          copyButton.addEventListener("click", (e) => {
            e.stopPropagation();
            const segmentId = e.target.dataset.segmentId;
            navigator.clipboard.writeText(segmentId).then(() => {
              this.notificationManager.show(
                "Segment ID copied to clipboard",
                "success",
                2000,
              );
            });
          });
        }
      });

      return popup;
    }

    // Show efficient streets panel
    showEfficientStreetsPanel(clusters, positionSource) {
      // Argument changed to clusters
      let panel = document.getElementById("efficient-streets-panel");
      if (!panel) {
        panel = document.createElement("div");
        panel.id = "efficient-streets-panel";
        panel.className = "efficient-streets-panel-overlay";
        const dashboard =
          document.getElementById("coverage-dashboard") || document.body;
        dashboard.appendChild(panel);
      }

      let html = `
        <div class="card bg-dark text-white">
          <div class="card-header d-flex justify-content-between align-items-center">
            <h6 class="mb-0">
              <i class="fas fa-bullseye me-2"></i>Most Efficient Street Clusters
            </h6>
            <button type="button" class="btn-close btn-close-white" 
                    onclick="document.getElementById('efficient-streets-panel').remove(); window.coverageManager.clearEfficientStreetMarkers(false);">
            </button>
          </div>
          <div class="card-body" style="max-height: 300px; overflow-y: auto;">
            <small class="text-muted d-block mb-2">Position source: ${positionSource}</small>
      `;

      clusters.forEach((cluster, index) => {
        const nearestSegment = cluster.nearest_segment;
        const distanceMiles = (cluster.distance_to_cluster_m / 1609.34).toFixed(
          1,
        );
        const totalLengthMiles = (cluster.total_length_m / 1609.34).toFixed(2);
        const score = cluster.efficiency_score.toFixed(2);
        const colors = ["#ffd700", "#c0c0c0", "#cd7f32"];
        const borderColor = colors[index] || "#9467bd";

        html += `
          <div class="efficient-street-item mb-2 p-2" style="border-left: 4px solid ${borderColor};">
            <div class="d-flex justify-content-between align-items-start">
              <div class="flex-grow-1">
                <div class="d-flex align-items-center mb-1">
                  <span class="badge bg-secondary me-2">#${index + 1}</span>
                  <strong>Starts with: ${nearestSegment.street_name}</strong>
                </div>
                <div class="small">
                  <span class="me-3" title="Total length of segments in cluster"><i class="fas fa-ruler"></i> ${totalLengthMiles} mi (${
                    cluster.segment_count
                  } segs)</span>
                  <span class="me-3" title="Approx. distance to cluster centroid"><i class="fas fa-location-arrow"></i> ${distanceMiles} mi</span>
                  <span title="Efficiency score"><i class="fas fa-chart-line"></i> Score: ${score}</span>
                </div>
              </div>
              <button class="btn btn-sm btn-outline-light focus-street-btn" 
                      title="Focus map on start of this cluster"
                      data-coords="${nearestSegment.start_coords.join(",")}"
                      data-segment-id="${nearestSegment.segment_id}">
                <i class="fas fa-crosshairs"></i>
              </button>
            </div>
          </div>
        `;
      });

      html += `
            <div class="mt-3 text-muted small">
              <i class="fas fa-info-circle"></i> Higher score = longer, more compact cluster, closer to you.
            </div>
          </div>
        </div>
      `;

      panel.innerHTML = html;

      panel.querySelectorAll(".focus-street-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const coords = btn.dataset.coords.split(",").map(Number);
          if (this.coverageMap) {
            this.coverageMap.flyTo({ center: coords, zoom: 17 });
          }
        });
      });
    }

    // Clear efficient street markers and their feature states
    clearEfficientStreetMarkers(removePanel = true) {
      this.efficientStreetMarkers.forEach((marker) => marker.remove());
      this.efficientStreetMarkers = [];

      if (
        this.coverageMap &&
        this.suggestedEfficientStreets &&
        this.coverageMap.getSource("streets")
      ) {
        this.suggestedEfficientStreets.forEach((cluster) => {
          if (cluster.segments && Array.isArray(cluster.segments)) {
            cluster.segments.forEach((segment) => {
              const segmentId =
                segment.segment_id || segment.properties?.segment_id;
              if (segmentId && this.coverageMap.getSource("streets")) {
                // Check source again
                try {
                  this.coverageMap.removeFeatureState(
                    { source: "streets", id: segmentId },
                    "efficientRank",
                  );
                } catch (e) {
                  // console.warn(`Could not remove feature state for segment ${segmentId}: ${e.message}`);
                }
              }
            });
          }
        });
      }

      this.suggestedEfficientStreets = []; // Clear the stored suggestions

      if (removePanel) {
        const panel = document.getElementById("efficient-streets-panel");
        if (panel) panel.remove();
      }
    }

    // Drawing Interface Methods
    handleAreaDefinitionTypeChange(type) {
      this.currentAreaDefinitionType = type;

      const locationSearchForm = document.getElementById(
        "location-search-form",
      );
      const drawingInterface = document.getElementById("drawing-interface");
      const locationSearchButtons = document.getElementById(
        "location-search-buttons",
      );
      const drawingButtons = document.getElementById("drawing-buttons");

      if (type === "location") {
        locationSearchForm?.classList.remove("d-none");
        drawingInterface?.classList.add("d-none");
        locationSearchButtons?.classList.remove("d-none");
        drawingButtons?.classList.add("d-none");

        // Clean up drawing map if it exists
        this.cleanupDrawingMap();
      } else if (type === "draw") {
        locationSearchForm?.classList.add("d-none");
        drawingInterface?.classList.remove("d-none");
        locationSearchButtons?.classList.add("d-none");
        drawingButtons?.classList.remove("d-none");

        // Initialize drawing map
        this.initializeDrawingMap();
      }

      // Reset validation states
      this.resetModalValidationState();
    }

    initializeDrawingMap() {
      if (this.drawingMap) {
        this.cleanupDrawingMap();
      }

      if (!window.MAPBOX_ACCESS_TOKEN) {
        this.showDrawingError(
          "Mapbox token not configured. Cannot initialize drawing map.",
        );
        return;
      }

      try {
        mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;

        this.drawingMap = new mapboxgl.Map({
          container: "drawing-map",
          style: "mapbox://styles/mapbox/dark-v11",
          center: [-97.1467, 31.5494], // Default to Waco, TX
          zoom: 10,
          attributionControl: false,
        });

        // Add draw control
        if (window.MapboxDraw) {
          this.drawingMapDraw = new MapboxDraw({
            displayControlsDefault: false,
            controls: {
              polygon: true,
              trash: true,
            },
            defaultMode: "draw_polygon",
            styles: [
              // Polygon fill
              {
                id: "gl-draw-polygon-fill-inactive",
                type: "fill",
                filter: [
                  "all",
                  ["==", "active", "false"],
                  ["==", "$type", "Polygon"],
                  ["!=", "mode", "static"],
                ],
                paint: {
                  "fill-color": "#3bb2d0",
                  "fill-outline-color": "#3bb2d0",
                  "fill-opacity": 0.1,
                },
              },
              // Polygon outline
              {
                id: "gl-draw-polygon-stroke-inactive",
                type: "line",
                filter: [
                  "all",
                  ["==", "active", "false"],
                  ["==", "$type", "Polygon"],
                  ["!=", "mode", "static"],
                ],
                layout: {
                  "line-cap": "round",
                  "line-join": "round",
                },
                paint: {
                  "line-color": "#3bb2d0",
                  "line-width": 2,
                },
              },
              // Active polygon fill
              {
                id: "gl-draw-polygon-fill-active",
                type: "fill",
                filter: [
                  "all",
                  ["==", "active", "true"],
                  ["==", "$type", "Polygon"],
                ],
                paint: {
                  "fill-color": "#fbb03b",
                  "fill-outline-color": "#fbb03b",
                  "fill-opacity": 0.1,
                },
              },
              // Active polygon outline
              {
                id: "gl-draw-polygon-stroke-active",
                type: "line",
                filter: [
                  "all",
                  ["==", "active", "true"],
                  ["==", "$type", "Polygon"],
                ],
                layout: {
                  "line-cap": "round",
                  "line-join": "round",
                },
                paint: {
                  "line-color": "#fbb03b",
                  "line-width": 2,
                },
              },
              // Vertex points
              {
                id: "gl-draw-polygon-midpoint",
                type: "circle",
                filter: [
                  "all",
                  ["==", "$type", "Point"],
                  ["==", "meta", "midpoint"],
                ],
                paint: {
                  "circle-radius": 3,
                  "circle-color": "#fbb03b",
                },
              },
              // Active vertex points
              {
                id: "gl-draw-polygon-vertex-active",
                type: "circle",
                filter: [
                  "all",
                  ["==", "$type", "Point"],
                  ["==", "meta", "vertex"],
                  ["==", "active", "true"],
                ],
                paint: {
                  "circle-radius": 5,
                  "circle-color": "#fbb03b",
                },
              },
              // Inactive vertex points
              {
                id: "gl-draw-polygon-vertex-inactive",
                type: "circle",
                filter: [
                  "all",
                  ["==", "$type", "Point"],
                  ["==", "meta", "vertex"],
                  ["==", "active", "false"],
                ],
                paint: {
                  "circle-radius": 3,
                  "circle-color": "#3bb2d0",
                },
              },
            ],
          });

          this.drawingMap.addControl(this.drawingMapDraw);

          // Add event listeners
          this.drawingMap.on("draw.create", (e) => {
            this.handleDrawingCreate(e);
          });

          this.drawingMap.on("draw.update", (e) => {
            this.handleDrawingUpdate(e);
          });

          this.drawingMap.on("draw.delete", (e) => {
            this.handleDrawingDelete(e);
          });
        } else {
          this.showDrawingError(
            "MapboxDraw library not loaded. Cannot enable drawing functionality.",
          );
        }

        // Add navigation controls
        this.drawingMap.addControl(
          new mapboxgl.NavigationControl(),
          "top-right",
        );
      } catch (error) {
        console.error("Error initializing drawing map:", error);
        this.showDrawingError(
          `Failed to initialize drawing map: ${error.message}`,
        );
      }
    }

    handleDrawingCreate(e) {
      if (e.features && e.features.length > 0) {
        const feature = e.features[0];
        this.updateDrawingValidationState(feature);
      }
    }

    handleDrawingUpdate(e) {
      if (e.features && e.features.length > 0) {
        const feature = e.features[0];
        this.updateDrawingValidationState(feature);
      }
    }

    handleDrawingDelete(e) {
      this.clearDrawingValidationState();
    }

    updateDrawingValidationState(feature) {
      const validateButton = document.getElementById("validate-drawing");
      const addButton = document.getElementById("add-custom-area");

      if (validateButton) validateButton.disabled = false;
      if (addButton) addButton.disabled = true;

      this.validatedCustomBoundary = null;
      this.hideDrawingValidationResult();
    }

    clearDrawingValidationState() {
      const validateButton = document.getElementById("validate-drawing");
      const addButton = document.getElementById("add-custom-area");

      if (validateButton) validateButton.disabled = true;
      if (addButton) addButton.disabled = true;

      this.validatedCustomBoundary = null;
      this.hideDrawingValidationResult();
    }

    clearDrawing() {
      if (this.drawingMapDraw) {
        this.drawingMapDraw.deleteAll();
        this.clearDrawingValidationState();
      }
    }

    cleanupDrawingMap() {
      if (this.drawingMap) {
        try {
          this.drawingMap.remove();
        } catch (e) {
          console.warn("Error removing drawing map:", e);
        }
        this.drawingMap = null;
        this.drawingMapDraw = null;
      }
    }

    resetModalState() {
      // Reset to location search mode
      const locationRadio = document.getElementById("area-type-location");
      if (locationRadio) {
        locationRadio.checked = true;
        this.handleAreaDefinitionTypeChange("location");
      }

      // Clear form inputs
      const locationInput = document.getElementById("location-input");
      const customAreaName = document.getElementById("custom-area-name");

      if (locationInput) {
        locationInput.value = "";
        locationInput.classList.remove("is-valid", "is-invalid");
      }

      if (customAreaName) {
        customAreaName.value = "";
      }

      // Reset validation states
      this.resetModalValidationState();
    }

    resetModalValidationState() {
      this.validatedLocation = null;
      this.validatedCustomBoundary = null;

      // Hide validation results
      const validationResult = document.getElementById("validation-result");
      const drawingValidationResult = document.getElementById(
        "drawing-validation-result",
      );

      if (validationResult) validationResult.classList.add("d-none");
      if (drawingValidationResult)
        drawingValidationResult.classList.add("d-none");

      // Disable add buttons
      const addLocationButton = document.getElementById("add-coverage-area");
      const addCustomButton = document.getElementById("add-custom-area");

      if (addLocationButton) addLocationButton.disabled = true;
      if (addCustomButton) addCustomButton.disabled = true;
    }

    showDrawingError(message) {
      const mapContainer = document.getElementById("drawing-map");
      if (mapContainer) {
        mapContainer.innerHTML = `
          <div class="alert alert-danger m-3">
            <i class="fas fa-exclamation-circle me-2"></i>
            <strong>Drawing Error:</strong> ${message}
          </div>
        `;
      }
    }

    showDrawingValidationResult(data) {
      const resultDiv = document.getElementById("drawing-validation-result");
      const messageSpan = resultDiv?.querySelector(
        ".drawing-validation-message",
      );

      if (resultDiv && messageSpan) {
        messageSpan.textContent = `Custom area "${data.display_name}" validated successfully! (${data.stats.total_points} points, ${data.stats.rings} ring${data.stats.rings > 1 ? "s" : ""})`;
        resultDiv.classList.remove("d-none");
      }
    }

    hideDrawingValidationResult() {
      const resultDiv = document.getElementById("drawing-validation-result");
      if (resultDiv) {
        resultDiv.classList.add("d-none");
      }
    }

    async validateCustomBoundary() {
      const customAreaNameInput = document.getElementById("custom-area-name");
      const validateButton = document.getElementById("validate-drawing");
      const addButton = document.getElementById("add-custom-area");

      if (!customAreaNameInput || !validateButton) {
        console.error("Required form elements not found.");
        return;
      }

      const areaName = customAreaNameInput.value.trim();
      if (!areaName) {
        customAreaNameInput.classList.add("is-invalid", "shake-animation");
        this.notificationManager.show("Please enter an area name.", "warning");
        return;
      }

      if (!this.drawingMapDraw) {
        this.notificationManager.show(
          "Drawing functionality not initialized.",
          "danger",
        );
        return;
      }

      const drawnFeatures = this.drawingMapDraw.getAll();
      if (!drawnFeatures.features || drawnFeatures.features.length === 0) {
        this.notificationManager.show(
          "Please draw a polygon boundary first.",
          "warning",
        );
        return;
      }

      const polygon = drawnFeatures.features[0];
      if (polygon.geometry.type !== "Polygon") {
        this.notificationManager.show(
          "Please draw a polygon boundary.",
          "warning",
        );
        return;
      }

      // Reset validation state
      customAreaNameInput.classList.remove("is-invalid", "is-valid");
      if (addButton) addButton.disabled = true;
      this.validatedCustomBoundary = null;
      this.hideDrawingValidationResult();

      const originalButtonContent = validateButton.innerHTML;
      validateButton.disabled = true;
      validateButton.innerHTML =
        '<i class="fas fa-spinner fa-spin"></i> Validating...';

      try {
        const response = await fetch("/api/validate_custom_boundary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            area_name: areaName,
            geometry: polygon.geometry,
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.detail || `Validation failed`);
        }

        if (!data || !data.valid) {
          customAreaNameInput.classList.add("is-invalid");
          this.notificationManager.show(
            "Custom boundary validation failed. Please check your drawing.",
            "warning",
          );
        } else {
          customAreaNameInput.classList.add("is-valid");
          this.validatedCustomBoundary = data;
          if (addButton) addButton.disabled = false;

          // Show validation result
          this.showDrawingValidationResult(data);

          this.notificationManager.show(
            `Custom boundary "${data.display_name}" validated successfully!`,
            "success",
          );

          // Focus add button
          if (addButton) addButton.focus();
        }
      } catch (error) {
        console.error("Error validating custom boundary:", error);
        customAreaNameInput.classList.add("is-invalid");
        this.notificationManager.show(
          `Validation failed: ${error.message}`,
          "danger",
        );
      } finally {
        validateButton.disabled = false;
        validateButton.innerHTML = originalButtonContent;
      }
    }

    async addCustomCoverageArea() {
      if (
        !this.validatedCustomBoundary ||
        !this.validatedCustomBoundary.display_name
      ) {
        this.notificationManager.show(
          "Please validate your custom boundary first.",
          "warning",
        );
        return;
      }

      const addButton = document.getElementById("add-custom-area");
      const modal = bootstrap.Modal.getInstance(
        document.getElementById("addAreaModal"),
      );

      if (!addButton) return;

      const originalButtonContent = addButton.innerHTML;
      addButton.disabled = true;
      addButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding...';

      const customAreaToAdd = { ...this.validatedCustomBoundary };
      const segLenEl2 = document.getElementById("segment-length-input");
      if (segLenEl2 && segLenEl2.value) {
        const val2 = parseInt(segLenEl2.value, 10);
        if (!isNaN(val2) && val2 > 0)
          customAreaToAdd.segment_length_meters = val2;
      }
      const bufElC = document.getElementById("match-buffer-input");
      if (bufElC && bufElC.value) {
        const v = parseFloat(bufElC.value);
        if (!isNaN(v) && v > 0) customAreaToAdd.match_buffer_meters = v;
      }
      const minElC = document.getElementById("min-match-length-input");
      if (minElC && minElC.value) {
        const v2 = parseFloat(minElC.value);
        if (!isNaN(v2) && v2 > 0) customAreaToAdd.min_match_length_meters = v2;
      }

      try {
        const currentAreasResponse = await fetch("/api/coverage_areas");
        if (!currentAreasResponse.ok) {
          throw new Error("Failed to fetch current coverage areas");
        }

        const { areas } = await currentAreasResponse.json();
        const exists = areas.some(
          (area) =>
            area.location?.display_name === customAreaToAdd.display_name,
        );

        if (exists) {
          this.notificationManager.show(
            "This area name is already being tracked.",
            "warning",
          );
          return;
        }

        if (modal) modal.hide();

        this.currentProcessingLocation = customAreaToAdd;
        this.currentTaskId = null;
        this._addBeforeUnloadListener();

        this.showProgressModal(
          `Starting processing for ${customAreaToAdd.display_name}...`,
          0,
        );

        const preprocessResponse = await fetch(
          "/api/preprocess_custom_boundary",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(customAreaToAdd),
          },
        );

        const taskData = await preprocessResponse.json();

        if (!preprocessResponse.ok) {
          this.hideProgressModal();
          throw new Error(taskData.detail || "Failed to start processing");
        }

        this.notificationManager.show(
          "Custom coverage area processing started.",
          "info",
        );

        if (taskData?.task_id) {
          this.currentTaskId = taskData.task_id;
          this.activeTaskIds.add(taskData.task_id);
          this.saveProcessingState();

          await this.pollCoverageProgress(taskData.task_id);

          this.notificationManager.show(
            `Processing for ${customAreaToAdd.display_name} completed.`,
            "success",
          );

          await this.loadCoverageAreas();
        } else {
          this.hideProgressModal();
          this.notificationManager.show(
            "Processing started, but no task ID received.",
            "warning",
          );
          await this.loadCoverageAreas();
        }

        const customAreaName = document.getElementById("custom-area-name");
        if (customAreaName) {
          customAreaName.value = "";
        }
        this.validatedCustomBoundary = null;
        this.updateTotalAreasCount();
      } catch (error) {
        console.error("Error adding custom coverage area:", error);
        this.notificationManager.show(
          `Failed to add custom coverage area: ${error.message}`,
          "danger",
        );
        this.hideProgressModal();
        await this.loadCoverageAreas();
      } finally {
        addButton.disabled = true;
        addButton.innerHTML = originalButtonContent;
      }
    }

    async reprocessStreetsForArea(locationId) {
      try {
        // Fetch location metadata
        const resp = await fetch(`/api/coverage_areas/${locationId}`);
        const data = await resp.json();
        if (!data.success || !data.coverage) {
          throw new Error(data.error || "Failed to fetch coverage area");
        }
        const location = data.coverage.location;
        if (!location.display_name) throw new Error("Missing location");

        // Ask user for new segment length
        const defaults = {
          segment: location.segment_length_meters || 100,
          buffer: location.match_buffer_meters || 15,
          min: location.min_match_length_meters || 5,
        };
        const settings = await this._askMatchSettings(
          location.display_name,
          defaults,
        );
        if (settings === null) return; // cancelled
        location.segment_length_meters = settings.segment;
        location.match_buffer_meters = settings.buffer;
        location.min_match_length_meters = settings.min;

        const endpoint =
          location.osm_type === "custom"
            ? "/api/preprocess_custom_boundary"
            : "/api/preprocess_streets";

        // show modal progress
        this.showProgressModal(
          `Reprocessing streets for ${location.display_name} (seg ${settings.segment} m)...`,
          0,
        );

        const resp2 = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(location),
        });
        const taskData = await resp2.json();
        if (!resp2.ok) {
          throw new Error(taskData.detail || "Failed to start reprocessing");
        }

        this.currentProcessingLocation = location;
        this.currentTaskId = taskData.task_id;
        this.activeTaskIds.add(taskData.task_id);
        this.saveProcessingState();

        await this.pollCoverageProgress(taskData.task_id);

        this.notificationManager.show(
          `Reprocessing completed for ${location.display_name}`,
          "success",
        );
        await this.loadCoverageAreas();
      } catch (err) {
        console.error("Reprocess error", err);
        this.notificationManager.show(
          `Reprocess failed: ${err.message}`,
          "danger",
        );
        this.hideProgressModal();
      }
    }

    async _askMatchSettings(
      locationName,
      defaults = { segment: 100, buffer: 15, min: 5 },
    ) {
      return new Promise((resolve) => {
        const modalEl = document.getElementById("segmentLengthModal");
        if (!modalEl) return resolve(null);

        const segEl = modalEl.querySelector("#segment-length-modal-input");
        const bufEl = modalEl.querySelector("#modal-match-buffer");
        const minEl = modalEl.querySelector("#modal-min-match");
        const titleEl = modalEl.querySelector(".modal-title");
        const confirmBtn = modalEl.querySelector("#segment-length-confirm-btn");
        const cancelBtn = modalEl.querySelector("#segment-length-cancel-btn");

        segEl.value = defaults.segment;
        bufEl.value = defaults.buffer;
        minEl.value = defaults.min;
        if (titleEl)
          titleEl.textContent = `Re-segment Streets for ${locationName}`;

        const bsModal = new bootstrap.Modal(modalEl, { backdrop: "static" });

        const cleanup = () => {
          confirmBtn.removeEventListener("click", onConfirm);
          cancelBtn.removeEventListener("click", onCancel);
          modalEl.removeEventListener("hidden.bs.modal", onCancel);
        };

        const onConfirm = () => {
          const segVal = parseInt(segEl.value, 10);
          const bufVal = parseFloat(bufEl.value);
          const minVal = parseFloat(minEl.value);
          cleanup();
          bsModal.hide();
          if (
            isNaN(segVal) ||
            segVal <= 0 ||
            isNaN(bufVal) ||
            bufVal <= 0 ||
            isNaN(minVal) ||
            minVal <= 0
          ) {
            resolve(null);
          } else {
            resolve({ segment: segVal, buffer: bufVal, min: minVal });
          }
        };

        const onCancel = () => {
          cleanup();
          resolve(null);
        };

        confirmBtn.addEventListener("click", onConfirm);
        cancelBtn.addEventListener("click", onCancel);
        modalEl.addEventListener("hidden.bs.modal", onCancel);

        bsModal.show();
      });
    }

    /**
     * Updates the sidebar list of undriven streets (street names with zero driven segments).
     * @param {object} geojson - The streets GeoJSON for the current area.
     */
    updateUndrivenStreetsList(geojson) {
      // Ensure container exists
      if (!this.undrivenStreetsContainer) {
        this.undrivenStreetsContainer = document.getElementById(
          "undriven-streets-list",
        );
      }
      if (!this.undrivenSortSelect) {
        this.undrivenSortSelect = document.getElementById(
          "undriven-streets-sort",
        );
        if (
          this.undrivenSortSelect &&
          !this.undrivenSortSelect.dataset.listenerAttached
        ) {
          this.undrivenSortSelect.addEventListener("change", () => {
            this.undrivenSortCriterion = this.undrivenSortSelect.value;
            // Rebuild list with new sort
            this.updateUndrivenStreetsList(this.streetsGeoJson || geojson);
          });
          this.undrivenSortSelect.dataset.listenerAttached = "true";
        }
      }
      const container = this.undrivenStreetsContainer;
      if (!container) return;

      // Validate geojson structure
      if (
        !geojson ||
        !Array.isArray(geojson.features) ||
        !geojson.features.length
      ) {
        container.innerHTML = CoverageManager.createAlertMessage(
          "No Data",
          "No street data available.",
          "secondary",
        );
        return;
      }

      // Aggregate stats per street
      const aggregates = new Map();
      for (const feature of geojson.features) {
        const props = feature.properties || {};
        const name = props.street_name || "Unnamed";
        const segLen = parseFloat(props.segment_length || 0);
        let agg = aggregates.get(name);
        if (!agg) {
          agg = { length: 0, segments: 0, driven: false };
          aggregates.set(name, agg);
        }
        agg.length += isNaN(segLen) ? 0 : segLen;
        agg.segments += 1;
        if (props.driven) agg.driven = true;
      }

      // Build undriven array with metrics
      let undrivenData = [...aggregates.entries()]
        .filter(([, agg]) => !agg.driven)
        .map(([name, agg]) => ({
          name,
          length: agg.length,
          segments: agg.segments,
        }));

      if (!undrivenData.length) {
        container.innerHTML = CoverageManager.createAlertMessage(
          "All Covered",
          "Great job! Every street has at least one driven segment.",
          "success",
        );
        return;
      }

      // Apply sorting
      const sortKey = this.undrivenSortCriterion || "length_desc";
      undrivenData.sort((a, b) => {
        switch (sortKey) {
          case "length_asc":
            return a.length - b.length;
          case "length_desc":
            return b.length - a.length;
          case "segments_asc":
            return a.segments - b.segments;
          case "segments_desc":
            return b.segments - a.segments;
          case "name_asc":
            return a.name.localeCompare(b.name, undefined, {
              sensitivity: "base",
            });
          default:
            return 0;
        }
      });

      // Build list HTML with metrics badges
      let html = '<ul class="list-group list-group-flush small">';
      undrivenData.forEach((item) => {
        const dist = CoverageManager.distanceInUserUnits(item.length);
        html += `<li class="list-group-item d-flex align-items-center justify-content-between bg-transparent text-truncate undriven-street-item" data-street-name="${item.name}" title="${item.name}">
          <span class="street-name text-truncate me-2">${item.name}</span>
          <div class="text-nowrap"><span class="badge bg-secondary" title="Total length">${dist}</span> <span class="badge bg-dark" title="Segment count">${item.segments}</span></div>
        </li>`;
      });
      html += "</ul>";

      container.innerHTML = html;

      // Attach click listeners
      container.querySelectorAll(".undriven-street-item").forEach((el) => {
        el.addEventListener("click", () => {
          const street = el.dataset.streetName || el.textContent.trim();
          this.showStreetOnMap(street);
        });
      });
    }

    /**
     * Zooms and highlights all segments for a given street name.
     * @param {string} streetName - Display name of the street ("Unnamed" possible).
     */
    showStreetOnMap(streetName) {
      if (!this.coverageMap || !this.streetsGeoJson) return;

      const matchingFeatures = this.streetsGeoJson.features.filter(
        (f) => (f.properties?.street_name || "Unnamed") === streetName,
      );

      if (!matchingFeatures.length) {
        this.notificationManager?.show(
          `No geometry found for '${streetName}'.`,
          "warning",
        );
        return;
      }

      // Remove any previous selection layer/source
      const selSource = "selected-street";
      const selLayer = "selected-street-layer";
      if (this.coverageMap.getLayer(selLayer))
        this.coverageMap.removeLayer(selLayer);
      if (this.coverageMap.getSource(selSource))
        this.coverageMap.removeSource(selSource);

      // Add new selection source/layer
      this.coverageMap.addSource(selSource, {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: matchingFeatures,
        },
      });

      this.coverageMap.addLayer({
        id: selLayer,
        type: "line",
        source: selSource,
        paint: {
          "line-color": "#00e5ff", // Cyan highlight
          "line-width": 6,
          "line-opacity": 0.9,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });

      // Compute bounds
      const bounds = new mapboxgl.LngLatBounds();
      matchingFeatures.forEach((f) => {
        const geom = f.geometry;
        if (!geom) return;
        const extendCoord = (coord) => bounds.extend(coord);
        if (geom.type === "LineString") geom.coordinates.forEach(extendCoord);
        else if (geom.type === "MultiLineString")
          geom.coordinates.forEach((line) => line.forEach(extendCoord));
      });
      if (!bounds.isEmpty()) {
        this.coverageMap.fitBounds(bounds, {
          padding: 40,
          maxZoom: 18,
          duration: 800,
        });
      }
    }
  } // End of CoverageManager class

  document.addEventListener("DOMContentLoaded", () => {
    if (typeof mapboxgl === "undefined") {
      const msg =
        "Error: Mapbox GL JS library failed to load. Map functionality will be unavailable.";
      const errContainer =
        document.getElementById("alerts-container") || document.body;
      const errDiv = document.createElement("div");
      errDiv.className = "alert alert-danger m-3";
      errDiv.textContent = msg;
      errContainer.prepend(errDiv);
      console.error(msg);
      return;
    }
    if (typeof Chart === "undefined") {
      console.warn(
        "Chart.js not loaded. Chart functionality will be unavailable.",
      );
      const chartContainer = document.getElementById("street-type-chart");
      if (chartContainer)
        chartContainer.innerHTML =
          '<div class="alert alert-warning small p-2">Chart library not loaded.</div>';
    }
    window.coverageManager = new CoverageManager();
  });
})();
