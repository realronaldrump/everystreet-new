import { calculateTripMetrics } from "./shared/trip-metrics.js";

/**
 * Trip Statistics Widget Manager
 * Handles the floating trip statistics widget at the top-left of the map
 */
const tripStatsWidget = {
  elements: {},
  isExpanded: false,
  initialized: false,

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
    if (this.elements.toggle) {
      this.elements.toggle.addEventListener("click", () => {
        this.toggleExpanded();
      });
    }

    // Listen for metrics updates from the metrics manager
    document.addEventListener("metricsUpdated", (event) => {
      this.handleMetricsUpdate(event.detail);
    });

    // Listen for GeoJSON data updates
    document.addEventListener("tripsDataLoaded", (event) => {
      if (event.detail?.geojson) {
        this.updateFromGeoJSON(event.detail.geojson);
      }
    });
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
      } else {
        this.elements.expanded.classList.remove("is-visible");
        setTimeout(() => {
          if (!this.isExpanded) {
            this.elements.expanded.style.display = "none";
          }
        }, 200);
      }
    }
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
