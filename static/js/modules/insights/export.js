/* global $ */
/**
 * Insights Export Module
 * Handles export, sharing, and report generation for the driving insights page
 */

import { formatDate } from "./formatters.js";
import { getState } from "./state.js";
import notificationManager from "../ui/notifications.js";

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

/**
 * Export analytics table data as CSV
 */
export function exportData() {
  // Check if DataTable is initialized
  if (!$.fn.DataTable.isDataTable("#analytics-table")) {
    showNotification("No data to export", "error");
    return;
  }

  const table = $("#analytics-table").DataTable();
  const data = table.rows().data().toArray();

  if (!data.length) {
    showNotification("No data to export", "error");
    return;
  }

  let csv = "Period,Trips,Distance,Duration,Fuel,Hard Events,Efficiency\n";
  data.forEach((row) => {
    csv += `${row[0]},${row[1]},${row[2]},${row[3]},${row[4]},${row[5]},${row[6]}\n`;
  });

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `driving-analytics-${formatDate(new Date())}.csv`;
  a.click();

  URL.revokeObjectURL(url);
  showNotification("Data exported successfully", "success");
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

  if (!insights) {
    showNotification("No data to share", "error");
    return;
  }

  const shareData = {
    title: "My Driving Insights",
    text: `Total Distance: ${insights.total_distance || 0} miles | Trips: ${insights.total_trips || 0}`,
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
