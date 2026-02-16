/* global CountUp */
/**
 * Insights Metrics Module (ES6)
 * Handles counter animations and metric updates for the driving insights page.
 */

import metricAnimator from "../ui/metric-animator.js";
import { formatHourLabel } from "./formatters.js";
import { getCounter, getState, setCounter } from "./state.js";

// Ensure CountUp is defined when using the UMD build
if (typeof window !== "undefined") {
  window.CountUp = window.CountUp || window.countUp?.CountUp;
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (!element) {
    return;
  }
  element.textContent = value;
}

/**
 * Animate a counter element to a target value
 * @param {string} elementId - ID of the element to animate
 * @param {number} endValue - Target value
 * @param {number} decimals - Number of decimal places (default 0)
 */
export function animateCounter(elementId, endValue, decimals = 0) {
  const element = document.getElementById(elementId);
  if (!element) {
    return;
  }

  if (metricAnimator?.animateById) {
    metricAnimator.animateById(elementId, endValue, { decimals });
    return;
  }

  const existingCounter = getCounter(elementId);

  if (!existingCounter) {
    const counter = new CountUp(elementId, 0, endValue, decimals, 1.5, {
      useEasing: true,
      useGrouping: true,
      separator: ",",
      decimal: ".",
      prefix: "",
      suffix: "",
    });

    setCounter(elementId, counter);

    if (!counter.error) {
      counter.start();
    } else {
      element.textContent = endValue.toFixed(decimals);
    }
  } else {
    existingCounter.update(endValue);
    if (!existingCounter.error) {
      existingCounter.start();
    } else {
      element.textContent = endValue.toFixed(decimals);
    }
  }
}

/**
 * Update a time metric element with formatted hours and minutes
 * @param {string} elementId - ID of the element to update
 * @param {number} seconds - Duration in seconds
 */
export function updateTimeMetric(elementId, seconds) {
  const element = document.getElementById(elementId);
  if (!element) {
    return;
  }

  const safeSeconds = Number.isFinite(Number(seconds)) ? Number(seconds) : 0;
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  element.textContent = `${hours}h ${minutes}m`;
}

/**
 * Update all metrics with current data
 */
export function updateAllMetrics() {
  const state = getState();
  const { insights = {}, metrics = {} } = state.data;

  // Primary counters
  animateCounter("total-trips", Number(insights.total_trips) || 0);
  animateCounter("total-distance", Number(insights.total_distance) || 0, 1);
  animateCounter("total-fuel", Number(insights.total_fuel_consumed) || 0, 2);
  animateCounter("hero-total-miles", Number(insights.total_distance) || 0, 1);
  updateTimeMetric("total-time", Number(metrics.total_duration_seconds) || 0);

  // Narrative context copy sourced from derived insights
  const derived = state.derivedInsights;
  if (!derived) {
    setText("trips-context", "Patterns will appear as your trip history grows.");
    setText("distance-context", "Long-form distance stories need more data.");
    setText("time-context", "Signature windows appear once time clusters emerge.");
    setText("fuel-context", "Fuel context appears when fuel entries are available.");
    return;
  }

  const consistency = derived.consistency || {};
  const timeSignature = derived.timeSignature || {};
  const exploration = derived.exploration || {};
  const fuelLens = derived.fuelLens || {};

  setText(
    "trips-context",
    `${(consistency.activeDaysRatio || 0).toFixed(1)}% of days active in this range`
  );
  setText(
    "distance-context",
    `Longest streak: ${Number(consistency.longestStreak) || 0} days`
  );
  setText(
    "time-context",
    `Signature window: ${formatHourLabel(Number(timeSignature.peakHour) || 0)}`
  );

  const fuelText =
    fuelLens.mpg == null
      ? "Add fuel entries for a stronger fuel lens"
      : `${fuelLens.mpg.toFixed(1)} MPG with ${fuelLens.fuelPerTrip.toFixed(2)} gal/trip`;
  setText("fuel-context", fuelText);

  setText(
    "scene-streak-value",
    `${Number(consistency.longestStreak) || 0} day streak`
  );
  setText(
    "scene-exploration-value",
    `${Number(exploration.explorationScore || 0).toFixed(0)} exploration score`
  );
  setText(
    "scene-signature-value",
    `${timeSignature.dominantDaypartLabel || "Daytime"} rhythm`
  );
  setText(
    "scene-active-ratio-value",
    `${(consistency.activeDaysRatio || 0).toFixed(1)}% active-day ratio`
  );
}
