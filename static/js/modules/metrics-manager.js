import utils from "./utils.js";
import dateUtils from "./date-utils.js";

const metricsManager = {
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
      utils.batchDOMUpdates([
        () =>
          Object.values(elements).forEach((el) => {
            if (el) el.textContent = el.id.includes("time") ? "--:--" : "0";
          }),
      ]);
      return;
    }

    const metrics = this.calculateMetrics(geojson.features);

    utils.batchDOMUpdates([
      () => {
        if (elements.totalTrips)
          elements.totalTrips.textContent = metrics.totalTrips;
        if (elements.totalDistance)
          elements.totalDistance.textContent = metrics.totalDistance.toFixed(1);
        if (elements.avgDistance)
          elements.avgDistance.textContent = metrics.avgDistance.toFixed(1);
        if (elements.avgStartTime)
          elements.avgStartTime.textContent = metrics.avgStartTime;
        if (elements.avgDrivingTime)
          elements.avgDrivingTime.textContent = metrics.avgDrivingTime;
        if (elements.avgSpeed)
          elements.avgSpeed.textContent = metrics.avgSpeed.toFixed(1);
        if (elements.maxSpeed)
          elements.maxSpeed.textContent = metrics.maxSpeed.toFixed(0);
      },
    ]);
  },

  calculateMetrics(features) {
    const metrics = {
      totalTrips: features.length,
      totalDistance: 0,
      totalDrivingTime: 0,
      totalStartHours: 0,
      maxSpeed: 0,
      validDistanceCount: 0,
      validDrivingTimeCount: 0,
      validStartTimeCount: 0,
    };

    features.forEach((feature) => {
      const props = feature.properties || {};

      if (props.distance && !isNaN(props.distance)) {
        metrics.totalDistance += parseFloat(props.distance);
        metrics.validDistanceCount++;
      }

      let drivingTime = props.duration || props.drivingTime;
      if (!drivingTime && props.startTime && props.endTime) {
        const start = new Date(props.startTime);
        const end = new Date(props.endTime);
        if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
          drivingTime = (end - start) / 1000;
        }
      }

      if (drivingTime && !isNaN(drivingTime)) {
        metrics.totalDrivingTime += parseFloat(drivingTime);
        metrics.validDrivingTimeCount++;
      }

      if (props.startTime) {
        const startTime = new Date(props.startTime);
        if (!isNaN(startTime.getTime())) {
          metrics.totalStartHours +=
            startTime.getHours() + startTime.getMinutes() / 60;
          metrics.validStartTimeCount++;
        }
      }

      if (props.maxSpeed && !isNaN(props.maxSpeed)) {
        metrics.maxSpeed = Math.max(
          metrics.maxSpeed,
          parseFloat(props.maxSpeed),
        );
      }
    });

    return {
      totalTrips: metrics.totalTrips,
      totalDistance: metrics.totalDistance,
      avgDistance:
        metrics.validDistanceCount > 0
          ? metrics.totalDistance / metrics.validDistanceCount
          : 0,
      avgStartTime:
        metrics.validStartTimeCount > 0
          ? dateUtils.formatTimeFromHours(
              metrics.totalStartHours / metrics.validStartTimeCount,
            )
          : "--:--",
      avgDrivingTime:
        metrics.validDrivingTimeCount > 0
          ? this.formatDuration(
              metrics.totalDrivingTime / metrics.validDrivingTimeCount,
            )
          : "--:--",
      avgSpeed:
        metrics.totalDrivingTime > 0
          ? (metrics.totalDistance / metrics.totalDrivingTime) * 3600
          : 0,
      maxSpeed: metrics.maxSpeed,
    };
  },

  formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return "--:--";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return hours > 0
      ? `${hours}:${minutes.toString().padStart(2, "0")}:${secs
          .toString()
          .padStart(2, "0")}`
      : `${minutes}:${secs.toString().padStart(2, "0")}`;
  },
};

if (!window.EveryStreet) window.EveryStreet = {};
window.EveryStreet.MetricsManager = metricsManager;

export default metricsManager;
