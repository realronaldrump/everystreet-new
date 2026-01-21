import apiClient from "./modules/core/api-client.js";
import notificationManager from "./modules/ui/notifications.js";
import { onPageLoad } from "./modules/utils.js";

const STATUS_API = "/api/status/health";
const STATUS_CLASS = {
  healthy: "success",
  warning: "warning",
  error: "danger",
};

let refreshInterval = null;
let pageSignal = null;

onPageLoad(
  ({ signal, cleanup } = {}) => {
    pageSignal = signal || null;
    initialize();
    if (typeof cleanup === "function") {
      cleanup(() => {
        pageSignal = null;
        if (refreshInterval) {
          clearInterval(refreshInterval);
          refreshInterval = null;
        }
      });
    }
  },
  { route: "/status" }
);

  function withSignal(options = {}) {
    if (pageSignal) {
      return { ...options, signal: pageSignal };
    }
    return options;
  }

function initialize() {
  document
    .getElementById("status-refresh-btn")
    ?.addEventListener("click", () => loadStatus(true));
  document
    .getElementById("nominatim-restart-btn")
    ?.addEventListener("click", () => restartService("nominatim"));
  document
    .getElementById("valhalla-restart-btn")
    ?.addEventListener("click", () => restartService("valhalla"));
  loadStatus();
  refreshInterval = setInterval(loadStatus, 30000);
}

async function loadStatus(isManual = false) {
  const refreshBtn = document.getElementById("status-refresh-btn");
  if (isManual && refreshBtn) {
    refreshBtn.disabled = true;
  }

  try {
    const data = await apiClient.get(STATUS_API, withSignal());
    updateOverall(data.overall);
    updateService("mongodb", data.services?.mongodb);
    updateService("redis", data.services?.redis);
    updateService("worker", data.services?.worker);
    updateService("nominatim", data.services?.nominatim);
    updateService("valhalla", data.services?.valhalla);
    updateService("bouncie", data.services?.bouncie);
    updateRecentErrors(data.recent_errors || []);
    updateLastUpdated(data.overall?.last_updated);
  } catch (_error) {
    updateOverall({
      status: "error",
      message: "Unable to load status dashboard.",
    });
  } finally {
    if (isManual && refreshBtn) {
      refreshBtn.disabled = false;
    }
  }
}

  function updateOverall(overall) {
    const badge = document.getElementById("overall-status-badge");
    const message = document.getElementById("overall-status-message");
    if (!overall || !badge || !message) {
      return;
    }
    const status = overall.status || "warning";
    badge.className = `badge bg-${STATUS_CLASS[status] || "secondary"}`;
    badge.textContent = status.replace(/^[a-z]/, (c) => c.toUpperCase());
    message.textContent = overall.message || "Status unavailable";
  }

  function updateService(key, data) {
    if (!data) {
      return;
    }
    const badge = document.getElementById(`${key}-status-badge`);
    const message = document.getElementById(`${key}-status-message`);
    const detail = document.getElementById(`${key}-status-detail`);
    if (!badge || !message) {
      return;
    }
    const status = data.status || "warning";
    badge.className = `badge bg-${STATUS_CLASS[status] || "secondary"}`;
    badge.textContent = data.label || status;
    message.textContent = data.message || "--";
    if (detail) {
      detail.textContent = data.detail || "";
    }
  }

  function updateRecentErrors(errors) {
    const list = document.getElementById("recent-errors-list");
    if (!list) {
      return;
    }
    if (!errors.length) {
      list.innerHTML = '<div class="text-muted">No recent errors.</div>';
      return;
    }
    list.innerHTML = errors
      .map(
        (entry) => `
          <div class="d-flex justify-content-between align-items-start gap-3">
            <div>
              <div class="fw-semibold">${escapeHtml(entry.task_id || "Unknown task")}</div>
              <div class="text-muted small">${escapeHtml(entry.error || "Unknown error")}</div>
            </div>
            <div class="text-muted small">${formatTime(entry.timestamp)}</div>
          </div>
        `
      )
      .join("");
  }

  function updateLastUpdated(timestamp) {
    const el = document.getElementById("status-last-updated");
    if (!el) {
      return;
    }
    if (!timestamp) {
      el.textContent = "Last updated: --";
      return;
    }
    el.textContent = `Last updated: ${formatTime(timestamp)}`;
  }

  function formatTime(isoString) {
    if (!isoString) {
      return "--";
    }
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
      return "--";
    }
    return date.toLocaleString();
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text || "";
    return div.innerHTML;
  }

async function restartService(serviceName) {
  const button = document.getElementById(`${serviceName}-restart-btn`);
  const icon = button?.querySelector("i");
  if (button) {
    button.disabled = true;
  }
  icon?.classList.add("fa-spin");
  try {
    const data = await apiClient.post(
      `/api/services/${encodeURIComponent(serviceName)}/restart`,
      null,
      withSignal()
    );
    notificationManager.show(
      data?.message || `Restarted ${serviceName}.`,
      "success"
    );
    await loadStatus(true);
  } catch (error) {
    notificationManager.show(error.message || "Unable to restart service.", "danger");
  } finally {
    icon?.classList.remove("fa-spin");
    if (button) {
      button.disabled = false;
    }
  }
}
