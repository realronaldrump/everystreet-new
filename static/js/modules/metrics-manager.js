import { calculateTripMetrics } from "./shared/trip-metrics.js";
import { utils } from "./utils.js";

const metricsManager = {
  /**
   * Update the map-page metrics table from server-provided aggregates (/api/metrics).
   * This avoids needing to download huge GeoJSON just to compute totals.
   */
  updateTripsTableFromApi(metrics) {
    const elements = {
      totalTrips: utils.getElement("total-trips"),
      totalDistance: utils.getElement("total-distance"),
      avgDistance: utils.getElement("avg-distance"),
      avgStartTime: utils.getElement("avg-start-time"),
      avgDrivingTime: utils.getElement("avg-driving-time"),
      avgSpeed: utils.getElement("avg-speed"),
      maxSpeed: utils.getElement("max-speed"),
    };

    if (!metrics) {
      utils.batchDOMUpdates([
        () =>
          Object.values(elements).forEach((el) => {
            if (el) {
              el.textContent = el.id.includes("time") ? "--:--" : "0";
            }
          }),
      ]);
      return;
    }

    const toFixedNumber = (value, digits = 1) => {
      const n = Number.parseFloat(value);
      return Number.isFinite(n) ? n.toFixed(digits) : "0";
    };

    utils.batchDOMUpdates([
      () => {
        if (elements.totalTrips) {
          elements.totalTrips.textContent = String(metrics.totalTrips ?? 0);
        }
        if (elements.totalDistance) {
          elements.totalDistance.textContent = toFixedNumber(
            metrics.totalDistanceMiles ?? 0,
            1
          );
        }
        if (elements.avgDistance) {
          elements.avgDistance.textContent = toFixedNumber(
            metrics.avgDistanceMiles ?? 0,
            1
          );
        }
        if (elements.avgStartTime) {
          elements.avgStartTime.textContent = metrics.avgStartTime ?? "--:--";
        }
        if (elements.avgDrivingTime) {
          elements.avgDrivingTime.textContent = metrics.avgDrivingTime ?? "--:--";
        }
        if (elements.avgSpeed) {
          elements.avgSpeed.textContent = toFixedNumber(metrics.avgSpeed ?? 0, 1);
        }
        if (elements.maxSpeed) {
          elements.maxSpeed.textContent = toFixedNumber(metrics.maxSpeed ?? 0, 0);
        }
      },
    ]);
  },

  updateTripsTable(geojson) {
    const elements = {
      totalTrips: utils.getElement("total-trips"),
      totalDistance: utils.getElement("total-distance"),
      avgDistance: utils.getElement("avg-distance"),
      avgStartTime: utils.getElement("avg-start-time"),
      avgDrivingTime: utils.getElement("avg-driving-time"),
      avgSpeed: utils.getElement("avg-speed"),
      maxSpeed: utils.getElement("max-speed"),
    };

    if (!geojson?.features) {
      const totalsDetail = {
        totalTrips: 0,
        totalDistanceMiles: 0,
        avgSpeed: 0,
        maxSpeed: 0,
      };
      utils.batchDOMUpdates([
        () =>
          Object.values(elements).forEach((el) => {
            if (el) {
              el.textContent = el.id.includes("time") ? "--:--" : "0";
            }
          }),
        () => this.dispatchMetricsEvent(totalsDetail),
      ]);
      return;
    }

    const metrics = calculateTripMetrics(geojson.features);
    const totalsDetail = {
      totalTrips: metrics.totalTrips,
      totalDistanceMiles: Number(metrics.totalDistance.toFixed(1)),
      avgSpeed: Number(metrics.avgSpeed.toFixed(1)),
      maxSpeed: Number(metrics.maxSpeed.toFixed(0)),
    };

    utils.batchDOMUpdates([
      () => {
        if (elements.totalTrips) {
          elements.totalTrips.textContent = metrics.totalTrips;
        }
        if (elements.totalDistance) {
          elements.totalDistance.textContent = metrics.totalDistance.toFixed(1);
        }
        if (elements.avgDistance) {
          elements.avgDistance.textContent = metrics.avgDistance.toFixed(1);
        }
        if (elements.avgStartTime) {
          elements.avgStartTime.textContent = metrics.avgStartTime;
        }
        if (elements.avgDrivingTime) {
          elements.avgDrivingTime.textContent = metrics.avgDrivingTime;
        }
        if (elements.avgSpeed) {
          elements.avgSpeed.textContent = metrics.avgSpeed.toFixed(1);
        }
        if (elements.maxSpeed) {
          elements.maxSpeed.textContent = metrics.maxSpeed.toFixed(0);
        }
      },
      () => this.dispatchMetricsEvent(totalsDetail),
    ]);
  },

  dispatchMetricsEvent(totals) {
    if (!totals || typeof document === "undefined") {
      return;
    }
    try {
      const detail = {
        source: "metricsManager",
        updatedAt: Date.now(),
        totals: {
          totalTrips: totals.totalTrips ?? 0,
          totalDistanceMiles: totals.totalDistanceMiles ?? 0,
          avgSpeed: totals.avgSpeed ?? 0,
          maxSpeed: totals.maxSpeed ?? 0,
        },
      };
      document.dispatchEvent(new CustomEvent("metricsUpdated", { detail }));
    } catch (error) {
      console.warn("Failed to dispatch metrics update event", error);
    }
  },
};

export default metricsManager;
