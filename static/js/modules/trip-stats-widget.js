import { calculateTripMetrics } from "./shared/trip-metrics.js";

const MOBILE_BREAKPOINT = "(max-width: 768px)";
const PANEL_EDGE_MARGIN_PX = 12;
const EXPANDED_TRANSITION_MS = 200;

/**
 * Trip Statistics Widget Manager
 * Handles the floating trip statistics widget at the top-left of the map
 */
const tripStatsWidget = {
  elements: {},
  isExpanded: false,
  initialized: false,
  dragState: null,
  customPosition: null,
  handlers: null,
  positionSyncTimer: null,

  /**
   * Initialize the trip statistics widget
   */
  init() {
    if (this.initialized) {
      return;
    }

    this.cacheElements();

    if (!this.elements.widget) {
      return;
    }

    this.bindEvents();
    this.initialized = true;
  },

  /**
   * Cache DOM elements for performance
   */
  cacheElements() {
    this.elements = {
      widget: document.getElementById("trip-stats-widget"),
      card: document.getElementById("trip-stats-card"),
      compact: document.getElementById("trip-stats-compact"),
      expanded: document.getElementById("trip-stats-expanded"),
      toggle: document.getElementById("trip-stats-toggle"),
      header:
        document
          .getElementById("trip-stats-compact")
          ?.querySelector?.(".trip-stats-header") || null,

      // Compact view elements
      totalTripsCompact: document.getElementById("widget-total-trips"),
      totalDistanceCompact: document.getElementById("widget-total-distance"),

      // Expanded view elements
      detailedTrips: document.getElementById("widget-detailed-trips"),
      detailedDistance: document.getElementById("widget-detailed-distance"),
      detailedAvgDistance: document.getElementById("widget-detailed-avg-distance"),
      detailedAvgSpeed: document.getElementById("widget-detailed-avg-speed"),
      detailedAvgStart: document.getElementById("widget-detailed-avg-start"),
      detailedAvgDuration: document.getElementById("widget-detailed-avg-duration"),
    };
  },

  /**
   * Bind event listeners
   */
  bindEvents() {
    this.ensureHandlers();

    if (this.elements.toggle) {
      this.elements.toggle.addEventListener("click", this.handlers.onToggleClick);
    }
    this.elements.header?.addEventListener("pointerdown", this.handlers.onDragStart);

    // Listen for metrics updates from the metrics manager
    document.addEventListener("metricsUpdated", this.handlers.onMetricsUpdated);

    // Listen for GeoJSON data updates
    document.addEventListener("tripsDataLoaded", this.handlers.onTripsDataLoaded);
    window.addEventListener("resize", this.handlers.onResize);
  },

  ensureHandlers() {
    if (this.handlers) {
      return;
    }

    this.handlers = {
      onToggleClick: () => this.toggleExpanded(),
      onMetricsUpdated: (event) => this.handleMetricsUpdate(event.detail),
      onTripsDataLoaded: (event) => {
        if (event.detail?.geojson) {
          this.updateFromGeoJSON(event.detail.geojson);
        }
      },
      onResize: () => this.handleViewportResize(),
      onDragStart: (event) => this.handleDragStart(event),
      onDragMove: (event) => this.handleDragMove(event),
      onDragEnd: (event) => this.handleDragEnd(event),
    };
  },

  /**
   * Toggle the expanded state of the widget
   */
  toggleExpanded() {
    this.isExpanded = !this.isExpanded;

    if (this.elements.toggle) {
      this.elements.toggle.setAttribute("aria-expanded", this.isExpanded.toString());
    }

    if (this.elements.expanded) {
      if (this.isExpanded) {
        this.elements.expanded.style.display = "block";
        // Trigger a reflow to enable transition
        void this.elements.expanded.offsetHeight;
        this.elements.expanded.classList.add("is-visible");
        this.schedulePositionSync();
      } else {
        this.elements.expanded.classList.remove("is-visible");
        setTimeout(() => {
          if (!this.isExpanded) {
            this.elements.expanded.style.display = "none";
            this.handleViewportResize();
          }
        }, EXPANDED_TRANSITION_MS);
      }
    }
  },

  isMobileViewport() {
    return window.matchMedia
      ? window.matchMedia(MOBILE_BREAKPOINT).matches
      : window.innerWidth <= 768;
  },

  clearInlinePosition() {
    if (!this.elements.widget) {
      return;
    }

    this.elements.widget.style.left = "";
    this.elements.widget.style.top = "";
    this.elements.widget.style.right = "";
    this.elements.widget.style.bottom = "";
  },

  getWidgetBounds() {
    const container = this.elements.widget?.parentElement;
    const widget = this.elements.widget;
    if (!container || !widget) {
      return null;
    }

    const containerRect = container.getBoundingClientRect();
    const widgetRect = widget.getBoundingClientRect();

    return {
      left: widgetRect.left - containerRect.left,
      top: widgetRect.top - containerRect.top,
    };
  },

  applyWidgetPosition(left, top) {
    const widget = this.elements.widget;
    const container = widget?.parentElement;
    if (!widget || !container) {
      return;
    }

    const widgetRect = widget.getBoundingClientRect();
    const widgetWidth = widget.offsetWidth || widgetRect.width || 0;
    const widgetHeight = widget.offsetHeight || widgetRect.height || 0;
    const maxLeft = Math.max(0, container.clientWidth - widgetWidth);
    const maxTop = Math.max(0, container.clientHeight - widgetHeight);
    const minLeft = Math.min(PANEL_EDGE_MARGIN_PX, maxLeft);
    const minTop = Math.min(PANEL_EDGE_MARGIN_PX, maxTop);
    const clampedLeft = Math.min(Math.max(left, minLeft), maxLeft);
    const clampedTop = Math.min(Math.max(top, minTop), maxTop);

    widget.style.left = `${clampedLeft}px`;
    widget.style.top = `${clampedTop}px`;
    widget.style.right = "auto";
    widget.style.bottom = "auto";
    this.customPosition = { left: clampedLeft, top: clampedTop };
  },

  syncWidgetPosition() {
    if (!this.elements.widget) {
      return;
    }
    if (this.isMobileViewport()) {
      this.stopDrag();
      this.clearInlinePosition();
      return;
    }

    if (!this.customPosition) {
      this.clearInlinePosition();
      return;
    }

    this.applyWidgetPosition(this.customPosition.left, this.customPosition.top);
  },

  schedulePositionSync(delayMs = 0) {
    if (this.positionSyncTimer) {
      clearTimeout(this.positionSyncTimer);
    }

    this.positionSyncTimer = setTimeout(() => {
      this.positionSyncTimer = null;
      this.syncWidgetPosition();
    }, delayMs);
  },

  handleViewportResize() {
    if (this.dragState) {
      this.stopDrag();
    }
    this.syncWidgetPosition();
  },

  handleDragStart(event) {
    if (!this.elements.widget || !this.elements.header || this.isMobileViewport()) {
      return;
    }
    if (typeof event.button === "number" && event.button !== 0) {
      return;
    }
    if (event.target?.closest?.("button, a, input, select, textarea")) {
      return;
    }

    const bounds = this.getWidgetBounds();
    if (!bounds) {
      return;
    }

    event.preventDefault?.();
    this.applyWidgetPosition(bounds.left, bounds.top);

    this.dragState = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startLeft: this.customPosition?.left ?? bounds.left,
      startTop: this.customPosition?.top ?? bounds.top,
    };

    this.elements.widget.classList.add("dragging");
    this.elements.header.classList.add("dragging");
    this.elements.header.setPointerCapture?.(event.pointerId);
    this.elements.header.addEventListener("pointermove", this.handlers.onDragMove);
    this.elements.header.addEventListener("pointerup", this.handlers.onDragEnd);
    this.elements.header.addEventListener("pointercancel", this.handlers.onDragEnd);
  },

  handleDragMove(event) {
    if (!this.dragState || event.pointerId !== this.dragState.pointerId) {
      return;
    }

    const deltaX = event.clientX - this.dragState.startClientX;
    const deltaY = event.clientY - this.dragState.startClientY;
    this.applyWidgetPosition(
      this.dragState.startLeft + deltaX,
      this.dragState.startTop + deltaY
    );
  },

  handleDragEnd(event) {
    if (!this.dragState || event.pointerId !== this.dragState.pointerId) {
      return;
    }
    this.stopDrag();
  },

  stopDrag() {
    const header = this.elements.header;
    const pointerId = this.dragState?.pointerId;

    header?.removeEventListener("pointermove", this.handlers?.onDragMove);
    header?.removeEventListener("pointerup", this.handlers?.onDragEnd);
    header?.removeEventListener("pointercancel", this.handlers?.onDragEnd);
    if (pointerId != null) {
      header?.releasePointerCapture?.(pointerId);
    }

    this.elements.widget?.classList.remove("dragging");
    header?.classList.remove("dragging");
    this.dragState = null;
  },

  /**
   * Handle metrics update event
   */
  handleMetricsUpdate(detail) {
    if (!detail) {
      return;
    }

    const totals = detail.totals || {};
    const metrics = detail.metrics || null;

    // Update compact view
    if (this.elements.totalTripsCompact) {
      this.elements.totalTripsCompact.textContent = this.formatNumber(
        totals.totalTrips ?? metrics?.totalTrips ?? 0
      );
    }

    if (this.elements.totalDistanceCompact) {
      this.elements.totalDistanceCompact.textContent = this.formatNumber(
        totals.totalDistanceMiles ?? metrics?.totalDistanceMiles ?? 0,
        1
      );
    }

    // Update detailed view (if the values are available)
    if (this.elements.detailedTrips) {
      this.elements.detailedTrips.textContent = this.formatNumber(
        totals.totalTrips ?? metrics?.totalTrips ?? 0
      );
    }

    if (this.elements.detailedDistance) {
      this.elements.detailedDistance.textContent = this.formatNumber(
        totals.totalDistanceMiles ?? metrics?.totalDistanceMiles ?? 0,
        1
      );
    }

    // Extended metrics (preferred when available from `/api/metrics`)
    if (metrics) {
      if (this.elements.detailedAvgDistance) {
        this.elements.detailedAvgDistance.textContent = this.formatNumber(
          metrics.avgDistanceMiles ?? 0,
          1
        );
      }
      if (this.elements.detailedAvgSpeed) {
        this.elements.detailedAvgSpeed.textContent = this.formatNumber(
          metrics.avgSpeed ?? 0,
          1
        );
      }
      if (this.elements.detailedAvgStart) {
        this.elements.detailedAvgStart.textContent = String(
          metrics.avgStartTime ?? "--:--"
        );
      }
      if (this.elements.detailedAvgDuration) {
        this.elements.detailedAvgDuration.textContent = String(
          metrics.avgDrivingTime ?? "--:--"
        );
      }
    }
  },

  /**
   * Update widget from GeoJSON data
   */
  updateFromGeoJSON(geojson) {
    if (!geojson?.features) {
      this.resetValues();
      return;
    }

    const metrics = calculateTripMetrics(geojson.features);
    this.updateDisplay(metrics);
  },

  /**
   * Update the display with calculated metrics
   */
  updateDisplay(metrics) {
    // Compact view
    if (this.elements.totalTripsCompact) {
      this.elements.totalTripsCompact.textContent = this.formatNumber(
        metrics.totalTrips
      );
    }

    if (this.elements.totalDistanceCompact) {
      this.elements.totalDistanceCompact.textContent = this.formatNumber(
        metrics.totalDistance,
        1
      );
    }

    // Expanded view
    if (this.elements.detailedTrips) {
      this.elements.detailedTrips.textContent = this.formatNumber(metrics.totalTrips);
    }

    if (this.elements.detailedDistance) {
      this.elements.detailedDistance.textContent = this.formatNumber(
        metrics.totalDistance,
        1
      );
    }

    if (this.elements.detailedAvgDistance) {
      this.elements.detailedAvgDistance.textContent = this.formatNumber(
        metrics.avgDistance,
        1
      );
    }

    if (this.elements.detailedAvgSpeed) {
      this.elements.detailedAvgSpeed.textContent = this.formatNumber(
        metrics.avgSpeed,
        1
      );
    }

    if (this.elements.detailedAvgStart) {
      this.elements.detailedAvgStart.textContent = metrics.avgStartTime;
    }

    if (this.elements.detailedAvgDuration) {
      this.elements.detailedAvgDuration.textContent = metrics.avgDrivingTime;
    }

    // Dispatch event for other components
    this.dispatchWidgetUpdateEvent(metrics);
  },

  /**
   * Reset all values to zero/empty state
   */
  resetValues() {
    const compactElements = [
      this.elements.totalTripsCompact,
      this.elements.totalDistanceCompact,
    ];

    const expandedElements = [
      this.elements.detailedTrips,
      this.elements.detailedDistance,
      this.elements.detailedAvgDistance,
      this.elements.detailedAvgSpeed,
    ];

    compactElements.forEach((el) => {
      if (el) {
        el.textContent = "0";
      }
    });

    expandedElements.forEach((el) => {
      if (el) {
        el.textContent = "0";
      }
    });

    if (this.elements.detailedAvgStart) {
      this.elements.detailedAvgStart.textContent = "--:--";
    }

    if (this.elements.detailedAvgDuration) {
      this.elements.detailedAvgDuration.textContent = "--:--";
    }
  },

  /**
   * Format a number with optional decimal places
   */
  formatNumber(value, decimals = 0) {
    if (value === null || value === undefined || Number.isNaN(value)) {
      return "0";
    }

    const num = Number(value);

    if (decimals > 0) {
      return num.toFixed(decimals);
    }

    // Add thousands separator for large numbers
    if (num >= 1000) {
      return num.toLocaleString();
    }

    return num.toString();
  },

  /**
   * Dispatch event when widget is updated
   */
  dispatchWidgetUpdateEvent(metrics) {
    try {
      const detail = {
        source: "tripStatsWidget",
        updatedAt: Date.now(),
        metrics: {
          totalTrips: metrics.totalTrips,
          totalDistance: Number(metrics.totalDistance.toFixed(1)),
          avgDistance: Number(metrics.avgDistance.toFixed(1)),
          avgSpeed: Number(metrics.avgSpeed.toFixed(1)),
          maxSpeed: Number(metrics.maxSpeed.toFixed(0)),
        },
      };

      document.dispatchEvent(new CustomEvent("tripStatsWidgetUpdated", { detail }));
    } catch (error) {
      console.warn("Failed to dispatch widget update event", error);
    }
  },

  destroy() {
    if (this.positionSyncTimer) {
      clearTimeout(this.positionSyncTimer);
      this.positionSyncTimer = null;
    }

    this.stopDrag();
    this.elements.toggle?.removeEventListener("click", this.handlers?.onToggleClick);
    this.elements.header?.removeEventListener("pointerdown", this.handlers?.onDragStart);
    document.removeEventListener("metricsUpdated", this.handlers?.onMetricsUpdated);
    document.removeEventListener("tripsDataLoaded", this.handlers?.onTripsDataLoaded);
    window.removeEventListener("resize", this.handlers?.onResize);

    this.elements = {};
    this.isExpanded = false;
    this.initialized = false;
    this.customPosition = null;
  },
};

// Auto-initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    tripStatsWidget.init();
  });
} else {
  // DOM is already ready
  tripStatsWidget.init();
}

export default tripStatsWidget;
