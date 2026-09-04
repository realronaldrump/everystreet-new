import apiClient from "./core/api-client.js";
import { clearCoverageAreasCache } from "./features/navigation-core/coverage-areas.js";

export function processingSummary(status) {
  const historical = Number(status?.historical_sync?.pending || 0);
  const coverage = Number(status?.coverage?.pending || 0);
  const failed =
    Number(status?.historical_sync?.failed || 0) +
    Number(status?.coverage?.failed || 0);
  const parts = [];
  if (historical) parts.push(`Waiting for completed drive history (${historical})`);
  if (coverage) parts.push(`Updating coverage (${coverage})`);
  if (failed)
    parts.push(`${failed} drive update${failed === 1 ? " needs" : "s need"} attention`);
  return { pending: historical + coverage, failed, text: parts.join(". ") };
}

export function startTripProcessingMonitor({
  api = apiClient,
  doc = document,
  intervalMs = 15000,
} = {}) {
  let stopped = false;
  let timer = null;
  let inFlight = false;
  let revision = null;
  const banner = doc.getElementById("trip-processing-status");
  const label = doc.getElementById("trip-processing-label");
  const retryButton = doc.getElementById("trip-processing-retry");

  const refresh = async () => {
    clearTimeout(timer);
    if (stopped || inFlight) return;
    if (doc.hidden || doc.body?.dataset.authRole !== "owner") {
      timer = setTimeout(refresh, intervalMs);
      return;
    }
    inFlight = true;
    try {
      const status = await api.get("/api/actions/trips/processing/status", {
        retry: false,
        timeout: 10000,
      });
      if (stopped) return;
      const summary = processingSummary(status);
      if (banner) banner.hidden = !summary.text;
      if (label) label.textContent = summary.text;
      if (retryButton) retryButton.hidden = summary.failed === 0;
      const nextRevision = String(status.revision);
      if (revision !== null && revision !== nextRevision) {
        clearCoverageAreasCache();
        doc.dispatchEvent(
          new CustomEvent("historicalTripsUpdated", {
            detail: { revision: nextRevision },
          })
        );
      }
      revision = nextRevision;
    } catch {
      // Keep the last known processing state during a temporary network outage.
    } finally {
      inFlight = false;
      if (!stopped) timer = setTimeout(refresh, intervalMs);
    }
  };
  const retry = async () => {
    if (retryButton) retryButton.disabled = true;
    try {
      await api.post("/api/actions/trips/processing/retry", {});
      await refresh();
    } catch (error) {
      if (label) label.textContent = `Could not retry drive updates: ${error.message}`;
    } finally {
      if (retryButton) retryButton.disabled = false;
    }
  };
  retryButton?.addEventListener("click", retry);
  doc.addEventListener("visibilitychange", refresh);
  void refresh();
  return () => {
    stopped = true;
    clearTimeout(timer);
    retryButton?.removeEventListener("click", retry);
    doc.removeEventListener("visibilitychange", refresh);
  };
}
