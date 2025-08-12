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

      // Simple debounce utility for this class
      this._debounceTimers = new Map();

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
      // Map info panel creation handled by Dashboard module
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

      // Multi-select street segment support
      // Holds the segment_id strings that the user has selected for bulk actions
      this.selectedSegmentIds = new Set();
    }

    debounce(fn, wait = 200) {
      return (...args) => {
        const key = fn;
        const existing = this._debounceTimers.get(key);
        if (existing) clearTimeout(existing);
        const t = setTimeout(() => {
          try {
            fn.apply(this, args);
          } catch (e) {
            console.warn("debounced function error", e);
          }
        }, wait);
        this._debounceTimers.set(key, t);
      };
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
      if (window.CoverageShared?.UI?.showToast) {
        window.CoverageShared.UI.showToast(message, type, duration);
        return;
      }
      // Fallback to console if shared UI unavailable
      console.log(`[${type}] ${message}`);
    }

    announceToScreenReader(message) {
      if (window.CoverageShared?.UI?.announceToScreenReader) {
        window.CoverageShared.UI.announceToScreenReader(message);
      }
    }

    async showEnhancedConfirmDialog(options) {
      if (window.CoverageShared?.UI?.showEnhancedConfirmDialog) {
        return window.CoverageShared.UI.showEnhancedConfirmDialog(options);
      }
      return window.confirm(options?.message || "Are you sure?");
    }

    startRenderLoop() {
      if (!this._renderQueue) {
        const RQ = window.CoverageShared?.RenderQueue;
        this._renderQueue = RQ ? new RQ(this.targetFPS) : null;
      }
      if (this._renderQueue) this._renderQueue.start();
      else
        this.animationFrameId = requestAnimationFrame(() =>
          this.processRenderQueue(),
        );
    }

    queueRender(fn) {
      if (this._renderQueue) this._renderQueue.enqueue(fn);
      else this.renderQueue.push(fn);
    }

    processRenderQueue() {
      if (this._renderQueue) this._renderQueue.process();
      else {
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
      if (window.CoverageShared?.UI?.distanceInUserUnits) {
        return window.CoverageShared.UI.distanceInUserUnits(meters, fixed);
      }
      // Fallback
      const miles = (meters || 0) * 0.000621371;
      return miles < 0.1
        ? `${((meters || 0) * 3.28084).toFixed(0)} ft`
        : `${miles.toFixed(fixed)} mi`;
    }

    static setupConnectionMonitoring() {
      if (window.CoverageShared?.setupConnectionMonitoring) {
        return window.CoverageShared.setupConnectionMonitoring(() =>
          window.coverageManager?.syncPendingOperations(),
        );
      }
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
        const data = await window.CoverageAPI.getCoverageAreas();
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
        const data =
          (await window.CoverageAPI.__validateLocation?.({
            location: locationInput,
            locationType: locType,
          })) ??
          // Fallback to POST if helper not provided
          (await (async () => {
            const resp = await fetch("/api/validate_location", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: locationInput,
                locationType: locType,
              }),
            });
            const json = await resp.json();
            if (!resp.ok) throw new Error(json.detail || `Validation failed`);
            return json;
          })());

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
      if (segLenEl?.value) {
        const val = parseInt(segLenEl.value, 10);
        if (!isNaN(val) && val > 0) locationToAdd.segment_length_meters = val;
      }
      const bufEl = document.getElementById("match-buffer-input");
      if (bufEl?.value) {
        const v = parseFloat(bufEl.value);
        if (!isNaN(v) && v > 0) locationToAdd.match_buffer_meters = v;
      }
      const minEl = document.getElementById("min-match-length-input");
      if (minEl?.value) {
        const v2 = parseFloat(minEl.value);
        if (!isNaN(v2) && v2 > 0) locationToAdd.min_match_length_meters = v2;
      }

      try {
        const { areas } = await window.CoverageAPI.getCoverageAreas();
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

        const taskData =
          await window.CoverageAPI.preprocessStreets(locationToAdd);

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

        const data = await window.CoverageAPI.getCoverageArea(locationId);
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

        const data = await window.CoverageAPI.startCoverageUpdate(
          processingLocation,
          mode,
        );

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
        await window.CoverageAPI.cancelCoverage(locationToCancel.display_name);

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

        await window.CoverageAPI.deleteCoverage(location.display_name);

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
        const data = await window.CoverageAPI.getCoverageAreas();

        this.queueRender(() => {
          if (window.CoverageModules?.Table?.updateCoverageTable) {
            window.CoverageModules.Table.updateCoverageTable(data.areas, this);
          }
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
      if (window.CoverageModules?.Progress?.pollCoverageProgress) {
        return window.CoverageModules.Progress.pollCoverageProgress(
          this,
          taskId,
        );
      }
      throw new Error("Progress module not loaded");
    }

    calculatePollInterval(stage, retries) {
      if (window.CoverageModules?.Progress?.calculatePollInterval) {
        return window.CoverageModules.Progress.calculatePollInterval(
          stage,
          retries,
        );
      }
      return 5000;
    }

    showSuccessAnimation() {
      if (window.CoverageModules?.Progress?.showSuccessAnimation) {
        return window.CoverageModules.Progress.showSuccessAnimation();
      }
    }

    showErrorState(errorMessage) {
      if (window.CoverageModules?.Progress?.showErrorState) {
        return window.CoverageModules.Progress.showErrorState(
          this,
          errorMessage,
        );
      }
    }

    showRetryOption(taskId) {
      if (window.CoverageModules?.Progress?.showRetryOption) {
        return window.CoverageModules.Progress.showRetryOption(this, taskId);
      }
    }

    showProgressModal(message = "Processing...", progress = 0) {
      if (window.CoverageModules?.Progress?.showProgressModal) {
        return window.CoverageModules.Progress.showProgressModal(
          this,
          message,
          progress,
        );
      }
    }

    hideProgressModal() {
      if (window.CoverageModules?.Progress?.hideProgressModal) {
        return window.CoverageModules.Progress.hideProgressModal();
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
      if (window.CoverageModules?.Dashboard?.displayCoverageDashboard) {
        return window.CoverageModules.Dashboard.displayCoverageDashboard(
          this,
          locationId,
        );
      }
      throw new Error("Dashboard module not loaded");
    }

    static createLoadingSkeleton(height, count = 1) {
      let skeletonHtml = "";
      for (let i = 0; i < count; i++) {
        skeletonHtml += `<div class="loading-skeleton skeleton-shimmer mb-2" style="height: ${height}px;"></div>`;
      }
      return skeletonHtml;
    }

    updateDashboardStats(coverage) {
      if (window.CoverageModules?.Dashboard?.updateDashboardStats) {
        return window.CoverageModules.Dashboard.updateDashboardStats(
          this,
          coverage,
        );
      }
    }

    updateStreetTypeCoverage(streetTypes) {
      if (window.CoverageModules?.Dashboard?.updateStreetTypeCoverage) {
        return window.CoverageModules.Dashboard.updateStreetTypeCoverage(
          this,
          streetTypes,
        );
      }
    }

    clearDashboardUI() {
      if (window.CoverageModules?.Dashboard?.clearDashboardUI) {
        return window.CoverageModules.Dashboard.clearDashboardUI(this);
      }
    }

    static createLoadingIndicator(message = "Loading...") {
      if (window.CoverageModules?.Dashboard?.createLoadingIndicator) {
        return window.CoverageModules.Dashboard.createLoadingIndicator(message);
      }
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
      if (window.CoverageModules?.Dashboard?.createAlertMessage) {
        return window.CoverageModules.Dashboard.createAlertMessage(
          title,
          message,
          type,
          locationId,
        );
      }
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
      if (window.CoverageModules?.Dashboard?.initializeCoverageMap) {
        return window.CoverageModules.Dashboard.initializeCoverageMap(
          this,
          coverage,
        );
      }
      throw new Error("Dashboard module not loaded");
    }

    addStreetsToMap(geojson) {
      if (window.CoverageModules?.Dashboard?.addStreetsToMap) {
        return window.CoverageModules.Dashboard.addStreetsToMap(this, geojson);
      }
    }

    fitMapToBounds() {
      if (window.CoverageModules?.Dashboard?.fitMapToBounds) {
        return window.CoverageModules.Dashboard.fitMapToBounds(this);
      }
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

    createStreetTypeChart(streetTypes) {
      if (window.CoverageModules?.Dashboard?.createStreetTypeChart) {
        return window.CoverageModules.Dashboard.createStreetTypeChart(
          this,
          streetTypes,
        );
      }
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

    // New method to find most efficient streets
    async findMostEfficientStreets() {
      if (window.CoverageModules?.Efficient?.findMostEfficientStreets) {
        return window.CoverageModules.Efficient.findMostEfficientStreets(this);
      }
      this.notificationManager?.show("Efficient module not loaded", "warning");
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
      if (window.CoverageModules?.Efficient?.displayEfficientStreets) {
        return window.CoverageModules.Efficient.displayEfficientStreets(
          this,
          clusters,
          positionSource,
        );
      }
    }

    // Create popup for efficient street
    createEfficientStreetPopup(cluster, rank) {
      if (window.CoverageModules?.Efficient?.createEfficientStreetPopup) {
        return window.CoverageModules.Efficient.createEfficientStreetPopup(
          this,
          cluster,
          rank,
        );
      }
    }

    // Show efficient streets panel
    showEfficientStreetsPanel(clusters, positionSource) {
      if (window.CoverageModules?.Efficient?.showEfficientStreetsPanel) {
        return window.CoverageModules.Efficient.showEfficientStreetsPanel(
          this,
          clusters,
          positionSource,
        );
      }
    }

    // Clear efficient street markers and their feature states
    clearEfficientStreetMarkers(removePanel = true) {
      if (window.CoverageModules?.Efficient?.clearEfficientStreetMarkers) {
        return window.CoverageModules.Efficient.clearEfficientStreetMarkers(
          this,
          removePanel,
        );
      }
    }

    // Drawing Interface Methods
    handleAreaDefinitionTypeChange(type) {
      if (window.CoverageModules?.Drawing?.handleAreaDefinitionTypeChange) {
        return window.CoverageModules.Drawing.handleAreaDefinitionTypeChange(
          this,
          type,
        );
      }
    }

    initializeDrawingMap() {
      if (window.CoverageModules?.Drawing?.initializeDrawingMap) {
        return window.CoverageModules.Drawing.initializeDrawingMap(this);
      }
    }

    handleDrawingCreate(e) {
      if (window.CoverageModules?.Drawing?.handleDrawingCreate) {
        return window.CoverageModules.Drawing.handleDrawingCreate(this, e);
      }
    }

    handleDrawingUpdate(e) {
      if (window.CoverageModules?.Drawing?.handleDrawingUpdate) {
        return window.CoverageModules.Drawing.handleDrawingUpdate(this, e);
      }
    }

    handleDrawingDelete(e) {
      if (window.CoverageModules?.Drawing?.handleDrawingDelete) {
        return window.CoverageModules.Drawing.handleDrawingDelete(this, e);
      }
    }

    updateDrawingValidationState(feature) {
      if (window.CoverageModules?.Drawing?.updateDrawingValidationState) {
        return window.CoverageModules.Drawing.updateDrawingValidationState(
          this,
          feature,
        );
      }
    }

    clearDrawingValidationState() {
      if (window.CoverageModules?.Drawing?.clearDrawingValidationState) {
        return window.CoverageModules.Drawing.clearDrawingValidationState(this);
      }
    }

    clearDrawing() {
      if (window.CoverageModules?.Drawing?.clearDrawing) {
        return window.CoverageModules.Drawing.clearDrawing(this);
      }
    }

    cleanupDrawingMap() {
      if (window.CoverageModules?.Drawing?.cleanupDrawingMap) {
        return window.CoverageModules.Drawing.cleanupDrawingMap(this);
      }
    }

    resetModalState() {
      if (window.CoverageModules?.Drawing?.resetModalState) {
        return window.CoverageModules.Drawing.resetModalState(this);
      }
    }

    resetModalValidationState() {
      if (window.CoverageModules?.Drawing?.resetModalValidationState) {
        return window.CoverageModules.Drawing.resetModalValidationState(this);
      }
    }

    showDrawingError(message) {
      if (window.CoverageModules?.Drawing?.showDrawingError) {
        return window.CoverageModules.Drawing.showDrawingError(this, message);
      }
    }

    showDrawingValidationResult(data) {
      if (window.CoverageModules?.Drawing?.showDrawingValidationResult) {
        return window.CoverageModules.Drawing.showDrawingValidationResult(
          this,
          data,
        );
      }
    }

    hideDrawingValidationResult() {
      if (window.CoverageModules?.Drawing?.hideDrawingValidationResult) {
        return window.CoverageModules.Drawing.hideDrawingValidationResult();
      }
    }

    async validateCustomBoundary() {
      if (window.CoverageModules?.Drawing?.validateCustomBoundary) {
        return window.CoverageModules.Drawing.validateCustomBoundary(this);
      }
    }

    async addCustomCoverageArea() {
      if (window.CoverageModules?.Drawing?.addCustomCoverageArea) {
        return window.CoverageModules.Drawing.addCustomCoverageArea(this);
      }
    }

    async reprocessStreetsForArea(locationId) {
      try {
        // Fetch location metadata
        const data = await window.CoverageAPI.getCoverageArea(locationId);
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

        // show modal progress
        this.showProgressModal(
          `Reprocessing streets for ${location.display_name} (seg ${settings.segment} m)...`,
          0,
        );

        const taskData = await window.CoverageAPI.reprocess(location);

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
      const undrivenData = [...aggregates.entries()]
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

    /* =============================================================
     * Multi-select / Bulk Segment Actions
     * =========================================================== */

    createBulkActionToolbar() {
      if (document.getElementById("bulk-action-toolbar")) return;
      const mapContainer = document.getElementById("coverage-map");
      if (!mapContainer) return;

      const toolbar = document.createElement("div");
      toolbar.id = "bulk-action-toolbar";
      toolbar.className =
        "bulk-action-toolbar d-flex align-items-center bg-dark bg-opacity-75 rounded shadow-sm";
      toolbar.style.cssText =
        "position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:2;gap:6px;padding:6px 10px;display:none;";

      toolbar.innerHTML = `
        <span id="bulk-selected-count" class="badge bg-info">0 Selected</span>
        <button class="btn btn-sm btn-success bulk-mark-btn" data-action="driven" disabled title="Mark Driven"><i class="fas fa-check"></i></button>
        <button class="btn btn-sm btn-danger bulk-mark-btn" data-action="undriven" disabled title="Mark Undriven"><i class="fas fa-times"></i></button>
        <button class="btn btn-sm btn-warning bulk-mark-btn" data-action="undriveable" disabled title="Mark Undriveable"><i class="fas fa-ban"></i></button>
        <button class="btn btn-sm btn-info text-white bulk-mark-btn" data-action="driveable" disabled title="Mark Driveable"><i class="fas fa-road"></i></button>
        <button class="btn btn-sm btn-secondary bulk-clear-selection-btn" disabled title="Clear Selection"><i class="fas fa-eraser"></i></button>
      `;

      toolbar.addEventListener("click", (e) => {
        const markBtn = e.target.closest(".bulk-mark-btn");
        if (markBtn) {
          const action = markBtn.dataset.action;
          if (action) {
            this._handleBulkMarkSegments(action);
          }
          return;
        }
        if (e.target.closest(".bulk-clear-selection-btn")) {
          this.clearSelection();
        }
      });

      mapContainer.appendChild(toolbar);
    }

    toggleSegmentSelection(segmentId) {
      if (!segmentId) return;
      if (this.selectedSegmentIds.has(segmentId))
        this.selectedSegmentIds.delete(segmentId);
      else this.selectedSegmentIds.add(segmentId);

      this._updateSelectionHighlight();
      this._updateBulkToolbar();
    }

    _updateSelectionHighlight() {
      if (!this.coverageMap || !this.coverageMap.getSource("streets")) return;

      const layerId = "streets-selection-highlight";
      if (!this.coverageMap.getLayer(layerId)) {
        // Create highlight layer above base streets
        this.coverageMap.addLayer(
          {
            id: layerId,
            type: "line",
            source: "streets",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": "#00bcd4",
              "line-width": ["interpolate", ["linear"], ["zoom"], 8, 3, 14, 7],
              "line-opacity": 1,
            },
            filter: ["in", "segment_id", ""],
          },
          "streets-layer",
        );
      }

      const ids = Array.from(this.selectedSegmentIds);
      if (ids.length === 0) {
        this.coverageMap.setFilter(layerId, ["in", "segment_id", ""]);
      } else {
        this.coverageMap.setFilter(layerId, ["in", "segment_id", ...ids]);
      }
    }

    _updateBulkToolbar() {
      const toolbar = document.getElementById("bulk-action-toolbar");
      if (!toolbar) return;
      const countSpan = document.getElementById("bulk-selected-count");
      const count = this.selectedSegmentIds.size;
      if (countSpan) countSpan.textContent = `${count} Selected`;

      const disabled = count === 0;
      toolbar
        .querySelectorAll(".bulk-mark-btn, .bulk-clear-selection-btn")
        .forEach((btn) => {
          btn.disabled = disabled;
        });
      // Show or hide toolbar
      toolbar.style.display = count > 0 ? "flex" : "none";
    }

    clearSelection() {
      if (this.selectedSegmentIds.size === 0) return;
      this.selectedSegmentIds.clear();
      this._updateSelectionHighlight();
      this._updateBulkToolbar();
    }

    async _handleBulkMarkSegments(action) {
      if (this.selectedSegmentIds.size === 0) return;

      const activeLocationId =
        this.selectedLocation?._id || this.currentDashboardLocationId;
      if (!activeLocationId) {
        this.notificationManager.show(
          "Cannot perform bulk action: No active location.",
          "warning",
        );
        return;
      }

      const segmentIds = Array.from(this.selectedSegmentIds);

      const endpointMap = {
        driven: "/api/street_segments/mark_driven",
        undriven: "/api/street_segments/mark_undriven",
        undriveable: "/api/street_segments/mark_undriveable",
        driveable: "/api/street_segments/mark_driveable",
      };

      const endpoint = endpointMap[action];
      if (!endpoint) {
        this.notificationManager.show(`Unknown action: ${action}`, "danger");
        return;
      }

      // Fire off requests in parallel for speed
      await Promise.allSettled(
        segmentIds.map((segId) =>
          this._makeSegmentApiRequest(endpoint, {
            location_id: activeLocationId,
            segment_id: segId,
          }),
        ),
      );

      // Optimistic local update (reuse logic from single handler)
      segmentIds.forEach((segId) => {
        const idx = this.streetsGeoJson?.features?.findIndex(
          (f) => f.properties.segment_id === segId,
        );
        if (idx !== undefined && idx !== -1) {
          const feature = this.streetsGeoJson.features[idx];
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
          this.streetsGeoJson.features[idx] = { ...feature };
        }
      });

      if (this.coverageMap?.getSource("streets")) {
        this.coverageMap.getSource("streets").setData(this.streetsGeoJson);
      }

      this.notificationManager.show(
        `${segmentIds.length} segments marked as ${action}.`,
        "success",
        2500,
      );

      // Refresh statistics once after bulk operation
      await this.refreshDashboardData(activeLocationId);
      await this.loadCoverageAreas();

      // Clear selection & UI
      this.clearSelection();
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
// Modular overrides to delegate to smaller focused modules and avoid fallback bloat
// These override class prototype methods with thin delegations to window.CoverageModules
// to ensure consistency and reduce code paths.
(function () {
  if (!window.coverageManager) return;
  const CM = window.coverageManager.constructor;
  const proto = CM.prototype;

  // Dashboard
  proto.displayCoverageDashboard = function (locationId) {
    if (window.CoverageModules?.Dashboard?.displayCoverageDashboard) {
      return window.CoverageModules.Dashboard.displayCoverageDashboard(
        this,
        locationId,
      );
    }
    throw new Error("Dashboard module not loaded");
  };
  proto.updateDashboardStats = function (coverage) {
    if (window.CoverageModules?.Dashboard?.updateDashboardStats) {
      return window.CoverageModules.Dashboard.updateDashboardStats(
        this,
        coverage,
      );
    }
  };
  proto.updateStreetTypeCoverage = function (streetTypes) {
    if (window.CoverageModules?.Dashboard?.updateStreetTypeCoverage) {
      return window.CoverageModules.Dashboard.updateStreetTypeCoverage(
        this,
        streetTypes,
      );
    }
  };
  proto.initializeCoverageMap = function (coverage) {
    if (window.CoverageModules?.Dashboard?.initializeCoverageMap) {
      return window.CoverageModules.Dashboard.initializeCoverageMap(
        this,
        coverage,
      );
    }
  };
  proto.addStreetsToMap = function (geojson) {
    if (window.CoverageModules?.Dashboard?.addStreetsToMap) {
      return window.CoverageModules.Dashboard.addStreetsToMap(this, geojson);
    }
  };
  proto.fitMapToBounds = function () {
    if (window.CoverageModules?.Dashboard?.fitMapToBounds) {
      return window.CoverageModules.Dashboard.fitMapToBounds(this);
    }
  };
  proto.createStreetTypeChart = function (streetTypes) {
    if (window.CoverageModules?.Dashboard?.createStreetTypeChart) {
      return window.CoverageModules.Dashboard.createStreetTypeChart(
        this,
        streetTypes,
      );
    }
  };

  // Progress modal/polling
  proto.pollCoverageProgress = function (taskId) {
    if (window.CoverageModules?.Progress?.pollCoverageProgress) {
      return window.CoverageModules.Progress.pollCoverageProgress(this, taskId);
    }
    return Promise.reject(new Error("Progress module not loaded"));
  };
  proto.calculatePollInterval = function (stage, retries) {
    if (window.CoverageModules?.Progress?.calculatePollInterval) {
      return window.CoverageModules.Progress.calculatePollInterval(
        stage,
        retries,
      );
    }
    return 5000;
  };
  proto.showSuccessAnimation = function () {
    if (window.CoverageModules?.Progress?.showSuccessAnimation) {
      return window.CoverageModules.Progress.showSuccessAnimation();
    }
  };
  proto.showErrorState = function (errorMessage) {
    if (window.CoverageModules?.Progress?.showErrorState) {
      return window.CoverageModules.Progress.showErrorState(this, errorMessage);
    }
  };
  proto.showRetryOption = function (taskId) {
    if (window.CoverageModules?.Progress?.showRetryOption) {
      return window.CoverageModules.Progress.showRetryOption(this, taskId);
    }
  };
  proto.showProgressModal = function (message = "Processing...", progress = 0) {
    if (window.CoverageModules?.Progress?.showProgressModal) {
      return window.CoverageModules.Progress.showProgressModal(
        this,
        message,
        progress,
      );
    }
  };
  proto.hideProgressModal = function () {
    if (window.CoverageModules?.Progress?.hideProgressModal) {
      return window.CoverageModules.Progress.hideProgressModal();
    }
  };

  // Efficient streets
  proto.findMostEfficientStreets = function () {
    if (window.CoverageModules?.Efficient?.findMostEfficientStreets) {
      return window.CoverageModules.Efficient.findMostEfficientStreets(this);
    }
    this.notificationManager?.show?.("Efficient module not loaded", "warning");
  };
  proto.displayEfficientStreets = function (clusters, source) {
    if (window.CoverageModules?.Efficient?.displayEfficientStreets) {
      return window.CoverageModules.Efficient.displayEfficientStreets(
        this,
        clusters,
        source,
      );
    }
  };
  proto.createEfficientStreetPopup = function (cluster, rank) {
    if (window.CoverageModules?.Efficient?.createEfficientStreetPopup) {
      return window.CoverageModules.Efficient.createEfficientStreetPopup(
        this,
        cluster,
        rank,
      );
    }
  };
  proto.showEfficientStreetsPanel = function (clusters, source) {
    if (window.CoverageModules?.Efficient?.showEfficientStreetsPanel) {
      return window.CoverageModules.Efficient.showEfficientStreetsPanel(
        this,
        clusters,
        source,
      );
    }
  };
  proto.clearEfficientStreetMarkers = function (removePanel = true) {
    if (window.CoverageModules?.Efficient?.clearEfficientStreetMarkers) {
      return window.CoverageModules.Efficient.clearEfficientStreetMarkers(
        this,
        removePanel,
      );
    }
  };

  // Drawing
  proto.handleAreaDefinitionTypeChange = function (type) {
    if (window.CoverageModules?.Drawing?.handleAreaDefinitionTypeChange) {
      return window.CoverageModules.Drawing.handleAreaDefinitionTypeChange(
        this,
        type,
      );
    }
  };
  proto.initializeDrawingMap = function () {
    if (window.CoverageModules?.Drawing?.initializeDrawingMap) {
      return window.CoverageModules.Drawing.initializeDrawingMap(this);
    }
  };
  proto.handleDrawingCreate = function (e) {
    if (window.CoverageModules?.Drawing?.handleDrawingCreate) {
      return window.CoverageModules.Drawing.handleDrawingCreate(this, e);
    }
  };
  proto.handleDrawingUpdate = function (e) {
    if (window.CoverageModules?.Drawing?.handleDrawingUpdate) {
      return window.CoverageModules.Drawing.handleDrawingUpdate(this, e);
    }
  };
  proto.handleDrawingDelete = function (e) {
    if (window.CoverageModules?.Drawing?.handleDrawingDelete) {
      return window.CoverageModules.Drawing.handleDrawingDelete(this, e);
    }
  };
  proto.updateDrawingValidationState = function () {
    if (window.CoverageModules?.Drawing?.updateDrawingValidationState) {
      return window.CoverageModules.Drawing.updateDrawingValidationState(this);
    }
  };
  proto.clearDrawingValidationState = function () {
    if (window.CoverageModules?.Drawing?.clearDrawingValidationState) {
      return window.CoverageModules.Drawing.clearDrawingValidationState(this);
    }
  };
  proto.clearDrawing = function () {
    if (window.CoverageModules?.Drawing?.clearDrawing) {
      return window.CoverageModules.Drawing.clearDrawing(this);
    }
  };
  proto.cleanupDrawingMap = function () {
    if (window.CoverageModules?.Drawing?.cleanupDrawingMap) {
      return window.CoverageModules.Drawing.cleanupDrawingMap(this);
    }
  };
  proto.resetModalState = function () {
    if (window.CoverageModules?.Drawing?.resetModalState) {
      return window.CoverageModules.Drawing.resetModalState(this);
    }
  };
  proto.resetModalValidationState = function () {
    if (window.CoverageModules?.Drawing?.resetModalValidationState) {
      return window.CoverageModules.Drawing.resetModalValidationState(this);
    }
  };
  proto.showDrawingError = function (message) {
    if (window.CoverageModules?.Drawing?.showDrawingError) {
      return window.CoverageModules.Drawing.showDrawingError(this, message);
    }
  };
  proto.showDrawingValidationResult = function (data) {
    if (window.CoverageModules?.Drawing?.showDrawingValidationResult) {
      return window.CoverageModules.Drawing.showDrawingValidationResult(
        this,
        data,
      );
    }
  };
  proto.hideDrawingValidationResult = function () {
    if (window.CoverageModules?.Drawing?.hideDrawingValidationResult) {
      return window.CoverageModules.Drawing.hideDrawingValidationResult();
    }
  };
  proto.validateCustomBoundary = function () {
    if (window.CoverageModules?.Drawing?.validateCustomBoundary) {
      return window.CoverageModules.Drawing.validateCustomBoundary(this);
    }
  };
  proto.addCustomCoverageArea = function () {
    if (window.CoverageModules?.Drawing?.addCustomCoverageArea) {
      return window.CoverageModules.Drawing.addCustomCoverageArea(this);
    }
  };
})();
