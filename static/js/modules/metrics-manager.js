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

};

export default metricsManager;
