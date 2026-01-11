/**
 * Insights Metrics Module (ES6)
 * Handles counter animations and metric updates for the driving insights page
 */

import { getCounter, getState, setCounter } from "./state.js";

// Ensure CountUp is defined when using the UMD build
if (typeof window !== "undefined") {
  window.CountUp = window.CountUp || window.countUp?.CountUp;
}

/**
 * Animate a counter element to a target value
 * @param {string} elementId - ID of the element to animate
 * @param {number} endValue - Target value
 * @param {number} decimals - Number of decimal places (default 0)
 */
export function animateCounter(elementId, endValue, decimals = 0) {
  const element = document.getElementById(elementId);
  if (!element) return;

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
  if (!element) return;

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  element.textContent = `${hours}h ${minutes}m`;
}

/**
 * Update all metrics with current data
 */
export function updateAllMetrics() {
  const state = getState();
  const { behavior: behaviorData, insights, metrics } = state.data;

  // Primary metrics
  animateCounter("total-trips", insights.total_trips || 0);
  animateCounter("total-distance", insights.total_distance || 0, 1);
  animateCounter("total-fuel", insights.total_fuel_consumed || 0, 2);
  animateCounter("hero-total-miles", insights.total_distance || 0, 1);

  // Behavior / safety metrics (date-filtered)
  animateCounter("hard-braking", behaviorData.hardBrakingCounts || 0);
  animateCounter("hard-accel", behaviorData.hardAccelerationCounts || 0);
  animateCounter("max-speed", behaviorData.maxSpeed || 0, 1);
  animateCounter("avg-speed", behaviorData.avgSpeed || 0, 1);

  // Time metrics
  updateTimeMetric("total-time", metrics.total_duration_seconds || 0);
  updateTimeMetric("idle-time", insights.total_idle_duration || 0);

  // Update comparisons
  updateComparisons();

  // Update trends vs. previous fetch
  updateTrends();
}

/**
 * Update comparison statistics in metric cards
 */
export function updateComparisons() {
  const state = getState();
  const { insights, behavior: behaviorData } = state.data;

  // Trips comparison
  const dailyAvgTrips = (insights.total_trips || 0) / state.currentPeriod;
  const tripsCompEl = document.querySelector("#trips-comparison span");
  if (tripsCompEl) {
    tripsCompEl.textContent = dailyAvgTrips.toFixed(1);
  }

  // Distance comparison
  const avgPerTrip =
    insights.total_trips > 0
      ? (insights.total_distance / insights.total_trips).toFixed(1)
      : 0;
  const distanceCompEl = document.querySelector("#distance-comparison span");
  if (distanceCompEl) {
    distanceCompEl.textContent = avgPerTrip;
  }

  // Fuel comparison
  const mpg =
    insights.total_distance > 0 && insights.total_fuel_consumed > 0
      ? (insights.total_distance / insights.total_fuel_consumed).toFixed(1)
      : 0;
  const fuelCompEl = document.querySelector("#fuel-comparison span");
  if (fuelCompEl) {
    fuelCompEl.textContent = mpg;
  }

  // Time comparison
  const timeCompEl = document.querySelector("#time-comparison span");
  if (timeCompEl) {
    timeCompEl.textContent = behaviorData.avgSpeed?.toFixed(1) || 0;
  }
}

/**
 * Update trend indicators comparing current vs previous period
 */
export function updateTrends() {
  const state = getState();
  if (!state.prevRange) return;

  const { insights, behavior } = state.data;
  const { insights: prevIn, behavior: prevBh } = state.prevRange;

  const trendElements = document.querySelectorAll(".metric-trend");
  if (trendElements.length < 4) return;

  const currentVals = [
    insights.total_trips || 0,
    insights.total_distance || 0,
    insights.total_fuel_consumed || 0,
    behavior.avgSpeed || 0,
  ];

  const prevVals = [
    prevIn?.total_trips || 0,
    prevIn?.total_distance || 0,
    prevIn?.total_fuel_consumed || 0,
    prevBh?.avgSpeed || 0,
  ];

  trendElements.forEach((el, idx) => {
    const curr = currentVals[idx];
    const prev = prevVals[idx];
    let diff = 0;
    if (prev > 0) diff = ((curr - prev) / prev) * 100;

    let cls = "neutral";
    let icon = "fa-minus";
    if (diff > 0.5) {
      cls = "positive";
      icon = "fa-arrow-up";
    } else if (diff < -0.5) {
      cls = "negative";
      icon = "fa-arrow-down";
    }

    el.className = `metric-trend ${cls}`;
    el.innerHTML = `${diff !== 0 ? `<i class="fas ${icon}"></i>` : ""} ${Math.abs(diff).toFixed(0)}%`;
  });
}

// Expose to window for backward compatibility
const InsightsMetrics = {
  animateCounter,
  updateTimeMetric,
  updateAllMetrics,
  updateComparisons,
  updateTrends,
};

if (typeof window !== "undefined") {
  window.InsightsMetrics = InsightsMetrics;
}

export default InsightsMetrics;
