/**
 * Progress Formatters Module
 * Formatting utilities for stage names, icons, metrics, and distances
 */

import { STATUS } from "./constants.js";

/**
 * Format stage name for display
 */
export function formatStageName(stage) {
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
    [STATUS.UNKNOWN]: "Unknown",
    [STATUS.POST_PREPROCESSING]: "Post-processing",
  };
  return (
    stageNames[stage] ||
    stage.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
  );
}

/**
 * Get stage icon HTML
 */
export function getStageIcon(stage) {
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
    [STATUS.UNKNOWN]: '<i class="fas fa-question-circle"></i>',
    [STATUS.POST_PREPROCESSING]: '<i class="fas fa-cog fa-spin"></i>',
  };
  return icons[stage] || icons[STATUS.UNKNOWN];
}

/**
 * Get Bootstrap text class for stage
 */
export function getStageTextClass(stage) {
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

/**
 * Convert meters to user-friendly units (miles/feet)
 */
export function distanceInUserUnits(meters, fixed = 2) {
  let validMeters = meters;
  if (typeof meters !== "number" || Number.isNaN(meters)) {
    validMeters = 0;
  }
  const miles = validMeters * 0.000621371;
  return miles < 0.1
    ? `${(validMeters * 3.28084).toFixed(0)} ft`
    : `${miles.toFixed(fixed)} mi`;
}

/**
 * Format time ago from date
 */
export function formatTimeAgo(date) {
  if (!date) return "never";
  const seconds = Math.floor((Date.now() - new Date(date)) / 1000);

  if (seconds < 2) {
    return "just now";
  } else if (seconds < 60) {
    return `${seconds}s ago`;
  } else {
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `${minutes}m ago`;
    } else {
      const hours = Math.floor(minutes / 60);
      if (hours < 24) {
        return `${hours}h ago`;
      } else {
        const days = Math.floor(hours / 24);
        if (days < 7) {
          return `${days}d ago`;
        } else {
          return new Date(date).toLocaleDateString();
        }
      }
    }
  }
}

/**
 * Format elapsed time from milliseconds
 */
export function formatElapsedTime(elapsedMs) {
  const elapsedSeconds = Math.floor(elapsedMs / 1000);

  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;

  if (minutes < 60) {
    return `${minutes}m ${seconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m ${seconds}s`;
}

/**
 * Format metric stats HTML for display
 */
export function formatMetricStats(stage, metrics) {
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
      const iconHtml = icon ? `<i class="${icon} me-2 opacity-75"></i>` : "";
      const displayValue =
        typeof value === "number" ? value.toLocaleString() : value;
      statsHtml += `
        <div class="d-flex justify-content-between py-1 border-bottom border-secondary border-opacity-10">
          <small class="text-muted">${iconHtml}${label}:</small>
          <small class="fw-bold ${colorClass}">${displayValue}${unit}</small>
        </div>`;
    }
  };

  // Common metrics
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
      distanceInUserUnits(metrics.total_length_m),
      "",
      "fas fa-ruler-horizontal",
    );
  }
  if (metrics.driveable_length_m !== undefined) {
    addStat(
      "Driveable Length",
      distanceInUserUnits(metrics.driveable_length_m),
      "",
      "fas fa-car",
    );
  }

  // Stage-specific metrics
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
        distanceInUserUnits(metrics.covered_length_m),
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
        distanceInUserUnits(metrics.covered_length_m),
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
