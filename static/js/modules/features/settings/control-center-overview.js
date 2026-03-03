import apiClient from "../../core/api-client.js";
import notificationManager from "../../ui/notifications.js";
import { formatDateTime } from "../../utils.js";

const OVERVIEW_API = "/api/status/overview";
const HEALTH_API = "/api/status/health";
const POLL_INTERVAL_MS = 30000;

const STATUS_VARIANTS = {
  healthy: {
    badgeClass: "bg-success",
    label: "Healthy",
  },
  warning: {
    badgeClass: "bg-warning text-dark",
    label: "Warning",
  },
  error: {
    badgeClass: "bg-danger",
    label: "Error",
  },
};

const SERVICE_ORDER = ["mongodb", "redis", "worker", "bouncie", "nominatim", "valhalla"];
const RESTARTABLE_SERVICES = new Set(["nominatim", "valhalla"]);

function formatStatusVariant(statusValue) {
  return STATUS_VARIANTS[statusValue] || {
    badgeClass: "bg-secondary",
    label: String(statusValue || "Unknown"),
  };
}

function formatTimestamp(value) {
  if (!value) {
    return "--";
  }
  try {
    return formatDateTime(value);
  } catch {
    return "--";
  }
}

function renderOverviewHeader({ overviewData, healthData }) {
  const badge = document.getElementById("cc-overview-status-badge");
  const message = document.getElementById("cc-overview-status-message");
  const summary = document.getElementById("cc-overview-summary");
  const lastUpdated = document.getElementById("cc-overview-last-updated");

  const overall = overviewData?.overall || healthData?.overall || {};
  const status = String(overall.status || "warning").toLowerCase();
  const variant = formatStatusVariant(status);

  if (badge) {
    badge.className = `status-pill cc-overview-status-badge ${variant.badgeClass}`;
    badge.textContent = overall.label || variant.label;
  }

  if (message) {
    message.textContent =
      overall.message || healthData?.overall?.message || "System status unavailable.";
  }

  if (summary) {
    const taskSummary = overviewData?.tasks?.summary || {};
    const docker = overviewData?.docker || {};
    const integrationSummary = overviewData?.integrations?.summary || "";
    summary.textContent = [
      `Tasks: ${taskSummary.running || 0} running, ${taskSummary.failed || 0} failed`,
      `Docker: ${docker.available ? "online" : "offline"}`,
      integrationSummary,
    ]
      .filter(Boolean)
      .join(" | ");
  }

  if (lastUpdated) {
    lastUpdated.textContent = `Last updated: ${formatTimestamp(
      overviewData?.last_updated || healthData?.overall?.last_updated
    )}`;
  }
}

function renderServiceCards(healthData) {
  const servicesContainer = document.getElementById("cc-overview-services");
  if (!servicesContainer) {
    return;
  }

  const services = healthData?.services || {};
  const availableKeys = SERVICE_ORDER.filter((key) => services[key]);
  const keysToRender = availableKeys.length > 0 ? availableKeys : Object.keys(services);

  if (!keysToRender.length) {
    servicesContainer.innerHTML = '<div class="text-muted small">No services available.</div>';
    return;
  }

  servicesContainer.innerHTML = keysToRender
    .map((key) => {
      const entry = services[key] || {};
      const status = String(entry.status || "warning").toLowerCase();
      const variant = formatStatusVariant(status);
      const canRestart = RESTARTABLE_SERVICES.has(key);
      const restartButton = canRestart
        ? `<button type="button" class="btn btn-outline-danger btn-sm cc-overview-restart-btn" data-service="${key}"><i class="fas fa-power-off"></i> Restart</button>`
        : "";

      return `
        <article class="control-center-service-card" data-service-card="${key}">
          <div class="control-center-service-card-head">
            <h4>${key}</h4>
            <span class="badge ${variant.badgeClass}">${entry.label || variant.label}</span>
          </div>
          <p class="control-center-service-message">${entry.message || "No status message."}</p>
          <p class="control-center-service-detail text-muted small">${entry.detail || ""}</p>
          <div class="control-center-service-actions">${restartButton}</div>
        </article>
      `;
    })
    .join("");
}

function renderFailures(healthData) {
  const failuresContainer = document.getElementById("cc-overview-failures");
  if (!failuresContainer) {
    return;
  }

  const entries = Array.isArray(healthData?.recent_errors) ? healthData.recent_errors : [];
  if (entries.length === 0) {
    failuresContainer.innerHTML =
      '<div class="text-muted small">No recent task failures. System looks stable.</div>';
    return;
  }

  failuresContainer.innerHTML = entries
    .map((entry) => {
      const taskId = entry.task_id || "unknown-task";
      const error = entry.error || "No error details";
      const stamp = formatTimestamp(entry.timestamp);
      return `
        <div class="control-center-failure-item">
          <div class="control-center-failure-meta">
            <strong>${taskId}</strong>
            <span>${stamp}</span>
          </div>
          <p>${error}</p>
        </div>
      `;
    })
    .join("");
}

export default function initControlCenterOverview({ signal } = {}) {
  const tab = document.getElementById("overview-tab");
  if (!tab) {
    return () => {};
  }

  const withSignal = (options = {}) => (signal ? { ...options, signal } : options);
  let refreshTimer = null;

  const refreshOverview = async (isManual = false) => {
    try {
      const [overviewData, healthData] = await Promise.all([
        apiClient.get(OVERVIEW_API, withSignal()),
        apiClient.get(HEALTH_API, withSignal()),
      ]);

      renderOverviewHeader({ overviewData, healthData });
      renderServiceCards(healthData);
      renderFailures(healthData);
    } catch (error) {
      if (error?.name === "AbortError") {
        return;
      }
      if (isManual) {
        notificationManager.show(`Failed to refresh overview: ${error.message}`, "warning");
      }
    }
  };

  const servicesContainer = document.getElementById("cc-overview-services");
  const serviceActionOptions = signal ? { signal } : false;

  servicesContainer?.addEventListener(
    "click",
    async (event) => {
      const button = event.target.closest(".cc-overview-restart-btn");
      if (!button) {
        return;
      }

      const service = button.getAttribute("data-service");
      if (!service) {
        return;
      }

      try {
        button.disabled = true;
        await apiClient.post(`/api/services/${encodeURIComponent(service)}/restart`, {}, withSignal());
        notificationManager.show(`${service} restart requested`, "success");
        await refreshOverview(true);
      } catch (error) {
        if (error?.name !== "AbortError") {
          notificationManager.show(`Failed to restart ${service}: ${error.message}`, "danger");
        }
      } finally {
        button.disabled = false;
      }
    },
    serviceActionOptions
  );

  refreshOverview();
  refreshTimer = setInterval(() => {
    refreshOverview();
  }, POLL_INTERVAL_MS);

  return () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  };
}
