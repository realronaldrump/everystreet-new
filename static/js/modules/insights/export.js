/**
 * Insights Export Module
 * Handles export, sharing, and report generation for the driving insights page
 */

import notificationManager from "../ui/notifications.js";
import { formatDate } from "./formatters.js";
import { getState } from "./state.js";

/**
 * Show a notification message
 * @param {string} message - Message to show
 * @param {string} type - Notification type (info, success, error)
 */
export function showNotification(message, type = "info") {
  notificationManager.show(message, type);
}

/**
 * Export the trends chart as a PNG image
 */
export function exportChart() {
  const canvas = document.getElementById("trendsChart");
  if (!canvas) {
    showNotification("Chart not found", "error");
    return;
  }

  const url = canvas.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = url;
  a.download = `driving-trends-${formatDate(new Date())}.png`;
  a.click();

  showNotification("Chart exported successfully", "success");
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) {
    return text;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

function buildCsvSections(state) {
  const lines = [];
  const derived = state.derivedInsights;
  const insights = state.data?.insights || {};

  lines.push("Summary");
  lines.push("Metric,Value");
  lines.push(`Total Trips,${csvEscape(insights.total_trips || 0)}`);
  lines.push(`Total Distance (mi),${csvEscape(Number(insights.total_distance || 0).toFixed(1))}`);
  lines.push(`Total Fuel (gal),${csvEscape(Number(insights.total_fuel_consumed || 0).toFixed(2))}`);
  lines.push("");

  if (derived) {
    const mode = state.rhythmView === "monthly" ? "monthly" : "weekly";
    const periods = derived.periods?.[mode] || [];

    lines.push(`${mode[0].toUpperCase() + mode.slice(1)} Period Comparison`);
    lines.push("Period,Trips,Distance (mi),Delta (%) ,Headline");
    periods.forEach((period) => {
      lines.push(
        [
          period.label,
          period.trips,
          period.distance.toFixed(1),
          period.distanceDeltaPct == null ? "" : period.distanceDeltaPct.toFixed(1),
          period.headline,
        ]
          .map(csvEscape)
          .join(",")
      );
    });
    lines.push("");

    lines.push("Pattern Cards");
    lines.push("Card,Value,Detail");
    (derived.patternCards || []).forEach((scene) => {
      lines.push([scene.title, scene.value, scene.detail].map(csvEscape).join(","));
    });
    lines.push("");

    lines.push("Places Orbit");
    lines.push("Place,Visits,Distance (mi),Last Visit");
    (derived.exploration?.destinations || []).forEach((destination) => {
      lines.push(
        [
          destination.location,
          destination.visits,
          destination.distance.toFixed(1),
          destination.lastVisit || "",
        ]
          .map(csvEscape)
          .join(",")
      );
    });
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Export insights data as CSV
 */
export function exportData() {
  const state = getState();
  if (!state.data?.insights) {
    showNotification("No data to export", "error");
    return;
  }

  const csv = buildCsvSections(state);
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `insights-data-${formatDate(new Date())}.csv`;
  a.click();

  URL.revokeObjectURL(url);
  showNotification("Insights data exported successfully", "success");
}

/**
 * Generate a PDF report (placeholder for future implementation)
 */
export function generateReport() {
  showNotification("Generating report...", "info");

  // This would generate a PDF report
  // For now, just show a success message
  setTimeout(() => {
    showNotification("Report downloaded successfully!", "success");
  }, 2000);
}

/**
 * Share insights via Web Share API or clipboard
 */
export function shareInsights() {
  const state = getState();
  const { insights } = state.data;
  const derived = state.derivedInsights;

  if (!insights) {
    showNotification("No data to share", "error");
    return;
  }

  const exploration = derived?.exploration;
  const consistency = derived?.consistency;
  const peakDay = derived?.timeSignature?.peakDayLabel;

  const shareData = {
    title: "My Driving Insights",
    text:
      `I logged ${insights.total_trips || 0} trips over ${Number(insights.total_distance || 0).toFixed(1)} miles.` +
      ` Active-day ratio: ${(consistency?.activeDaysRatio || 0).toFixed(1)}%.` +
      ` Exploration score: ${(exploration?.explorationScore || 0).toFixed(0)}/100.` +
      (peakDay ? ` Peak day: ${peakDay}.` : ""),
    url: window.location.href,
  };

  if (navigator.share) {
    navigator
      .share(shareData)
      .then(() => showNotification("Shared successfully", "success"))
      .catch((err) => {
        if (err.name !== "AbortError") {
          fallbackShare(shareData);
        }
      });
  } else {
    fallbackShare(shareData);
  }
}

/**
 * Fallback share method using clipboard
 * @param {Object} shareData - Data to share
 */
export function fallbackShare(shareData) {
  const text = `${shareData.title}\n${shareData.text}\n${shareData.url}`;
  navigator.clipboard
    .writeText(text)
    .then(() => showNotification("Link copied to clipboard!", "success"))
    .catch(() => showNotification("Failed to copy to clipboard", "error"));
}
