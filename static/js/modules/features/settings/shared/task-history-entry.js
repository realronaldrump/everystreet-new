import { formatDurationMs } from "../../../utils.js";

export function getDurationState(entry) {
  let durationText = "Unknown";
  let isRunning = false;
  let startTime = null;

  if (entry.runtime !== null && entry.runtime !== undefined) {
    const runtimeMs = Number.parseFloat(entry.runtime);
    if (!Number.isNaN(runtimeMs)) {
      durationText = formatDurationMs(runtimeMs);
    }
  } else if (entry.status === "RUNNING" && entry.timestamp) {
    try {
      const startedAt = new Date(entry.timestamp);
      const elapsedMs = Date.now() - startedAt.getTime();
      if (!Number.isNaN(elapsedMs) && elapsedMs >= 0) {
        durationText = formatDurationMs(elapsedMs);
        isRunning = true;
        startTime = entry.timestamp;
      }
    } catch {
      // Ignore invalid date payloads.
    }
  }

  return { durationText, isRunning, startTime };
}

export function getResultText(entry) {
  if (entry.status === "RUNNING") {
    return "Running";
  }
  if (entry.status === "PENDING") {
    return "Pending";
  }
  if (entry.status === "COMPLETED") {
    return entry.result ? "Success" : "Completed";
  }
  if (entry.status === "FAILED") {
    return "Failed";
  }
  if (entry.status === "CANCELLED") {
    return "Cancelled";
  }
  return "N/A";
}
