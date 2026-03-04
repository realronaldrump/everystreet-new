import { DateUtils } from "../utils.js";

const dateUtils = DateUtils;

export function formatDurationHms(seconds) {
  if (!seconds || Number.isNaN(seconds)) {
    return "--:--";
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
    : `${minutes}:${secs.toString().padStart(2, "0")}`;
}

export function calculateTripMetrics(features = []) {
  const metrics = {
    totalTrips: Array.isArray(features) ? features.length : 0,
    totalDistance: 0,
    totalDistanceFullTrip: 0,
    totalDrivingTime: 0,
    totalStartHours: 0,
    maxSpeed: 0,
    validFullDistanceCount: 0,
    validDrivingTimeCount: 0,
    validStartTimeCount: 0,
  };

  (features || []).forEach((feature) => {
    const props = feature.properties || {};
    const fullTripDistance = Number.parseFloat(props.distance);
    const clippedDistance = Number.parseFloat(props.coverageDistance);
    const strictDistance = Number.isFinite(clippedDistance)
      ? clippedDistance
      : fullTripDistance;

    if (Number.isFinite(strictDistance)) {
      metrics.totalDistance += strictDistance;
    }
    if (Number.isFinite(fullTripDistance)) {
      metrics.totalDistanceFullTrip += fullTripDistance;
      metrics.validFullDistanceCount += 1;
    }

    let drivingTime = props.duration || props.drivingTime;
    if (!drivingTime && props.startTime && props.endTime) {
      const start = new Date(props.startTime);
      const end = new Date(props.endTime);
      if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
        drivingTime = (end - start) / 1000;
      }
    }

    if (drivingTime && !Number.isNaN(drivingTime)) {
      metrics.totalDrivingTime += Number.parseFloat(drivingTime);
      metrics.validDrivingTimeCount += 1;
    }

    if (props.startTime) {
      const startTime = new Date(props.startTime);
      if (!Number.isNaN(startTime.getTime())) {
        metrics.totalStartHours += startTime.getHours() + startTime.getMinutes() / 60;
        metrics.validStartTimeCount += 1;
      }
    }

    if (props.maxSpeed && !Number.isNaN(props.maxSpeed)) {
      metrics.maxSpeed = Math.max(metrics.maxSpeed, Number.parseFloat(props.maxSpeed));
    }
  });

  return {
    totalTrips: metrics.totalTrips,
    totalDistance: metrics.totalDistance,
    avgDistance:
      metrics.validFullDistanceCount > 0
        ? metrics.totalDistanceFullTrip / metrics.validFullDistanceCount
        : 0,
    avgStartTime:
      metrics.validStartTimeCount > 0
        ? dateUtils.formatTimeFromHours(metrics.totalStartHours / metrics.validStartTimeCount)
        : "--:--",
    avgDrivingTime:
      metrics.validDrivingTimeCount > 0
        ? formatDurationHms(metrics.totalDrivingTime / metrics.validDrivingTimeCount)
        : "--:--",
    avgSpeed:
      metrics.totalDrivingTime > 0
        ? (metrics.totalDistanceFullTrip / metrics.totalDrivingTime) * 3600
        : 0,
    maxSpeed: metrics.maxSpeed,
  };
}

export default calculateTripMetrics;
