import apiClient from "./modules/core/api-client.js";
import notificationManager from "./modules/ui/notifications.js";
import { escapeHtml, onPageLoad } from "./modules/utils.js";

const STATUS_API = "/api/status/health";
const LOGS_API_BASE = "/api/status/logs";
const TASKS_API_BASE = "/api/admin/tasks";

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
  // Global Refresh
  document
    .getElementById("status-refresh-btn")
    ?.addEventListener("click", () => loadStatus(true));

  // Service Restarts
  document.querySelectorAll(".restart-service-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const service = e.currentTarget.dataset.service;
      if (service) restartService(service);
    });
  });

  // View Logs
  document.querySelectorAll(".view-logs-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const service = e.currentTarget.dataset.service;
      if (service) openLogViewer(service);
    });
  });

  // Trigger Tasks
  document.querySelectorAll(".trigger-task-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const task = e.currentTarget.dataset.task;
      if (task) triggerTask(task, e.currentTarget);
    });
  });

  // Log Viewer Controls
  document.getElementById("close-logs-btn")?.addEventListener("click", closeLogViewer);
  document.getElementById("refresh-logs-btn")?.addEventListener("click", () => {
    const service = document.getElementById("log-viewer-card").dataset.activeService;
    if (service) loadLogs(service);
  });

  loadStatus();
  refreshInterval = setInterval(loadStatus, 15000); // 15s polling
}

async function loadStatus(isManual = false) {
  const refreshBtn = document.getElementById("status-refresh-btn");
  if (isManual && refreshBtn) {
    const icon = refreshBtn.querySelector("i");
    refreshBtn.disabled = true;
    icon?.classList.add("fa-spin");
  }

  try {
    const data = await apiClient.get(STATUS_API, withSignal());
    
    // Update individual services
    updateService("mongodb", data.services?.mongodb);
    updateService("redis", data.services?.redis);
    updateService("worker", data.services?.worker);
    updateService("nominatim", data.services?.nominatim);
    updateService("valhalla", data.services?.valhalla);
    
    // Update recent activity/errors
    updateActivityList(data.recent_errors || []);
    
    updateLastUpdated(data.overall?.last_updated);
  } catch (_error) {
     notificationManager.show("Failed to refresh system status.", "warning");
  } finally {
    if (isManual && refreshBtn) {
       const icon = refreshBtn.querySelector("i");
      refreshBtn.disabled = false;
      icon?.classList.remove("fa-spin");
    }
  }
}

function updateService(key, data) {
  if (!data) return;
  
  const badge = document.getElementById(`${key}-status-badge`);
  const message = document.getElementById(`${key}-status-message`);
  const detail = document.getElementById(`${key}-status-detail`);
  
  if (!badge || !message) return;

  const status = data.status || "warning";
  const statusColor = STATUS_CLASS[status] || "secondary";
  
  badge.className = `badge bg-${statusColor}`;
  badge.textContent = data.label || status.toUpperCase();
  
  message.textContent = data.message || "--";
  message.className = `mb-2 fw-medium text-${statusColor}`;

  if (detail) {
    detail.textContent = data.detail || "";
  }
}

function updateActivityList(errors) {
  const list = document.getElementById("recent-activity-list");
  if (!list) return;

  if (!errors || errors.length === 0) {
    list.innerHTML = `<div class="list-group-item bg-transparent text-muted small fst-italic py-3">No recent errors or warnings.</div>`;
    return;
  }

  list.innerHTML = errors.map(entry => `
    <div class="list-group-item bg-transparent border-0 border-bottom border-secondary px-0 py-2">
      <div class="d-flex justify-content-between align-items-start">
        <div class="text-danger small fw-bold">
           <i class="fas fa-exclamation-circle me-1"></i> ${escapeHtml(entry.task_id || "System Error")}
        </div>
        <small class="text-muted" style="font-size: 0.75rem;">${formatTime(entry.timestamp)}</small>
      </div>
      <div class="text-light small mt-1 text-break">${escapeHtml(entry.error || "Unknown error occurred")}</div>
    </div>
  `).join("");
}

// --- Logs ---

async function openLogViewer(serviceName) {
  const card = document.getElementById("log-viewer-card");
  const title = document.getElementById("log-viewer-title");
  const content = document.getElementById("log-viewer-content");
  
  if (!card || !content) return;
  
  card.classList.remove("d-none");
  card.dataset.activeService = serviceName;
  title.textContent = `${serviceName} Logs`;
  content.textContent = "Loading logs...";
  
  // Scroll to logs container
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  
  await loadLogs(serviceName);
}

function closeLogViewer() {
    const card = document.getElementById("log-viewer-card");
    if (card) {
        card.classList.add("d-none");
        card.dataset.activeService = "";
    }
}

async function loadLogs(serviceName) {
    const content = document.getElementById("log-viewer-content");
    const timestamp = document.getElementById("log-timestamp");
    const refreshBtn = document.getElementById("refresh-logs-btn");

    if (refreshBtn) refreshBtn.disabled = true;

    try {
        const data = await apiClient.get(`${LOGS_API_BASE}/${encodeURIComponent(serviceName)}`, withSignal());
        if (data.success) {
            content.textContent = data.logs || "No logs available.";
            timestamp.textContent = `Timestamp: ${formatTime(data.timestamp)}`;
            // Auto scroll to bottom
            content.scrollTop = content.scrollHeight;
        } else {
             content.textContent = data.logs || "Failed to fetch logs.";
        }
    } catch (error) {
        content.textContent = `Error fetching logs: ${error.message}`;
    } finally {
        if (refreshBtn) refreshBtn.disabled = false;
    }
}

// --- Actions ---

async function restartService(serviceName) {
  if (!confirm(`Are you sure you want to restart ${serviceName}?`)) return;

  try {
    const data = await apiClient.post(
      `/api/services/${encodeURIComponent(serviceName)}/restart`,
      null,
      withSignal()
    );
    notificationManager.show(data?.message || `Restarted ${serviceName}.`, "success");
    await loadStatus(true);
  } catch (error) {
    notificationManager.show(error.message || "Unable to restart service.", "danger");
  }
}

async function triggerTask(taskName, btnElement) {
    // Determine a nicer name for the confirm dialog
    let friendlyName = taskName;
    if (taskName === "periodic_fetch_trips") friendlyName = "Fetch Recent Trips";
    if (taskName === "setup_map_data_task") friendlyName = "Process Map Data";
    
    if (!confirm(`Run task: ${friendlyName}?`)) return;
    
    const originalText = btnElement ? btnElement.innerHTML : "";
    if (btnElement) {
        btnElement.disabled = true;
        btnElement.innerHTML = `<i class="fas fa-circle-notch fa-spin me-2"></i> Starting...`;
    }

    try {
        // We need to pass the task ID (name) in the URL
        const data = await apiClient.post(
            `${TASKS_API_BASE}/${encodeURIComponent(taskName)}/run`,
            null,
            withSignal()
        );
        
        notificationManager.show(data.message || "Task started successfully.", "success");
        // Refresh status to potentially show the new running task (if we had a running tasks view)
        // For now, it might show up in active workers count eventually
    } catch (error) {
         notificationManager.show(error.message || "Failed to trigger task.", "danger");
    } finally {
        if (btnElement) {
            btnElement.disabled = false;
            btnElement.innerHTML = originalText;
        }
    }
}

// --- Utils ---

function updateLastUpdated(timestamp) {
  const el = document.getElementById("status-last-updated");
  if (el) {
    el.textContent = `Last updated: ${formatTime(timestamp)}`;
  }
}

function formatTime(isoString) {
  if (!isoString) return "--";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit'
  });
}
