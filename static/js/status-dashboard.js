/* global bootstrap */

import apiClient from "./modules/core/api-client.js";
import notificationManager from "./modules/ui/notifications.js";
import { escapeHtml, formatDateTime, onPageLoad } from "./modules/utils.js";
import { setupManualFetchTripsForm } from "./settings/geocode-remap.js";
import mapServices from "./settings/map-services.js";
import {
  gatherTaskConfigFromUI,
  submitTaskConfigUpdate,
} from "./settings/task-manager/api.js";
import { showTaskDetails } from "./settings/task-manager/modals.js";
import { TaskManager } from "./settings/task-manager/task-manager.js";

const OVERVIEW_API = "/api/status/overview";
const STATUS_API = "/api/status/health";
const LOGS_API_BASE = "/api/status/logs";
const SERVER_LOGS_API = "/api/server-logs";
const CONTAINER_LIST_API = "/api/docker-logs/containers";
const CONTAINER_LOGS_API = "/api/docker-logs";

const STATUS_CLASS = {
  healthy: "success",
  warning: "warning",
  error: "danger",
};

let refreshInterval = null;
let pageSignal = null;
let taskManager = null;

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
        if (taskManager) {
          taskManager.cleanup();
          taskManager = null;
        }
        mapServices.cleanupMapServicesTab();
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
    ?.addEventListener("click", () => loadAll(true));

  document
    .getElementById("quick-refresh-services")
    ?.addEventListener("click", () => loadStatus(true));

  document
    .getElementById("quick-run-all")
    ?.addEventListener("click", () => runAllTasks());

  document.getElementById("quick-open-setup")?.addEventListener("click", () => {
    window.location.href = "/setup-wizard";
  });

  document.querySelectorAll(".restart-service-btn").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      const { service } = event.currentTarget.dataset;
      if (service) {
        restartService(service);
      }
    });
  });

  document.querySelectorAll(".view-logs-btn").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      const { service } = event.currentTarget.dataset;
      if (service) {
        const select = document.getElementById("service-log-select");
        if (select) {
          select.value = service;
        }
        loadServiceLogs(service);
        const tabTrigger = document.getElementById("service-logs-tab");
        if (tabTrigger && window.bootstrap) {
          bootstrap.Tab.getOrCreateInstance(tabTrigger).show();
        }
      }
    });
  });

  document
    .getElementById("refresh-app-logs")
    ?.addEventListener("click", () => loadAppLogs(true));
  document.getElementById("refresh-service-logs")?.addEventListener("click", () => {
    const service = document.getElementById("service-log-select")?.value;
    if (service) {
      loadServiceLogs(service);
    }
  });
  document.getElementById("refresh-container-logs")?.addEventListener("click", () => {
    const container = document.getElementById("container-log-select")?.value;
    if (container) {
      loadContainerLogs(container);
    }
  });

  document.getElementById("service-log-select")?.addEventListener("change", (e) => {
    const service = e.target.value;
    if (service) {
      loadServiceLogs(service);
    }
  });

  document.getElementById("container-log-select")?.addEventListener("change", (e) => {
    const container = e.target.value;
    if (container) {
      loadContainerLogs(container);
    }
  });

  document
    .getElementById("pauseTasksBtn")
    ?.addEventListener("click", () => pauseTasks());
  document
    .getElementById("resumeTasksBtn")
    ?.addEventListener("click", () => resumeTasks());
  document
    .getElementById("stopAllTasksBtn")
    ?.addEventListener("click", () => stopAllTasks());
  document
    .getElementById("runAllTasksBtn")
    ?.addEventListener("click", () => runAllTasks());
  document
    .getElementById("resetTasksBtn")
    ?.addEventListener("click", () => resetTasks());
  document
    .getElementById("saveTaskConfigBtn")
    ?.addEventListener("click", () => saveTaskConfig());
  document
    .getElementById("clearHistoryBtn")
    ?.addEventListener("click", () => clearTaskHistory());

  document.getElementById("globalDisableSwitch")?.addEventListener("change", (e) => {
    if (e.target.checked) {
      pauseTasks();
    } else {
      resumeTasks();
    }
  });

  document.getElementById("taskConfigTable")?.addEventListener("mousedown", (e) => {
    const runBtn = e.target.closest(".run-now-btn");
    if (runBtn?.dataset.taskId) {
      taskManager?.runTask(runBtn.dataset.taskId);
      return;
    }
    const forceBtn = e.target.closest(".force-stop-btn");
    if (forceBtn?.dataset.taskId) {
      taskManager?.forceStopTask(forceBtn.dataset.taskId);
      return;
    }
    const detailsBtn = e.target.closest(".view-details-btn");
    if (detailsBtn?.dataset.taskId) {
      showTaskDetails(detailsBtn.dataset.taskId);
    }
  });

  const taskDetailsModal = document.getElementById("taskDetailsModal");
  if (taskDetailsModal) {
    const runBtn = taskDetailsModal.querySelector(".run-task-btn");
    runBtn?.addEventListener("click", async (event) => {
      const { taskId } = event.currentTarget.dataset;
      if (taskId) {
        await taskManager?.runTask(taskId);
        bootstrap.Modal.getInstance(taskDetailsModal)?.hide();
      }
    });
  }

  document
    .getElementById("fetchAllMissingBtn")
    ?.addEventListener("click", () => fetchAllMissingTrips());

  taskManager = new TaskManager();
  setupManualFetchTripsForm(taskManager);
  mapServices.initMapServicesTab();

  loadAll();
  refreshInterval = setInterval(loadAll, 15000);
}

async function loadAll(isManual = false) {
  await Promise.all([loadOverview(isManual), loadStatus(isManual)]);
  loadAppLogs();
  loadContainerList();
}

async function loadOverview(isManual = false) {
  const refreshBtn = document.getElementById("status-refresh-btn");
  if (isManual && refreshBtn) {
    refreshBtn.disabled = true;
  }

  try {
    const data = await apiClient.get(OVERVIEW_API, withSignal());
    updateOverview(data);
    updatePlaybooks(data);
  } catch (error) {
    notificationManager.show(`Failed to load overview: ${error.message}`, "warning");
  } finally {
    if (isManual && refreshBtn) {
      refreshBtn.disabled = false;
    }
  }
}

async function loadStatus(isManual = false) {
  try {
    const data = await apiClient.get(STATUS_API, withSignal());
    updateService("mongodb", data.services?.mongodb);
    updateService("redis", data.services?.redis);
    updateService("worker", data.services?.worker);
    updateService("nominatim", data.services?.nominatim);
    updateService("valhalla", data.services?.valhalla);
    updateService("bouncie", data.services?.bouncie);
    updateActivityList(data.recent_errors || []);
    updateLastUpdated(data.overall?.last_updated);
  } catch (_error) {
    if (isManual) {
      notificationManager.show("Failed to refresh system status.", "warning");
    }
  }
}

function updateOverview(data) {
  if (!data) {
    return;
  }

  const overall = data.overall || {};
  const overallBadge = document.getElementById("overall-status-badge");
  const overallMessage = document.getElementById("overall-status-message");
  const overallDetail = document.getElementById("overall-status-detail");

  if (overallBadge) {
    const status = overall.status || "warning";
    const statusColor = STATUS_CLASS[status] || "secondary";
    overallBadge.className = `status-pill badge bg-${statusColor}`;
    overallBadge.textContent = overall.label || status.toUpperCase();
  }

  if (overallMessage) {
    overallMessage.textContent = overall.message || "--";
  }

  if (overallDetail) {
    overallDetail.textContent
      = overall.detail || "Monitor services and tasks in real time.";
  }

  const tasksSummary = data.tasks?.summary || {};
  const tasksSummaryEl = document.getElementById("tasks-summary");
  const tasksDetailEl = document.getElementById("tasks-detail");
  if (tasksSummaryEl) {
    tasksSummaryEl.textContent = `${tasksSummary.running || 0} running, ${tasksSummary.failed || 0} failed`;
  }
  if (tasksDetailEl) {
    tasksDetailEl.textContent = `${tasksSummary.total || 0} total tasks${tasksSummary.disabled ? " (paused)" : ""}`;
  }

  const storageSummaryEl = document.getElementById("storage-summary");
  const storageDetailEl = document.getElementById("storage-detail");
  if (storageSummaryEl) {
    const used = data.storage?.used_mb;
    const hasValue = typeof used === "number";
    storageSummaryEl.textContent = hasValue
      ? `${used.toFixed(1)} MB used`
      : "Storage data unavailable";
    storageDetailEl.textContent = data.storage?.error || "MongoDB storage usage";
  }

  const dockerSummaryEl = document.getElementById("docker-summary");
  const dockerDetailEl = document.getElementById("docker-detail");
  if (dockerSummaryEl) {
    dockerSummaryEl.textContent = data.docker?.available
      ? `Docker online (${data.docker?.container_count || 0} containers)`
      : "Docker unavailable";
  }
  if (dockerDetailEl) {
    dockerDetailEl.textContent = data.docker?.detail || "Container management and logs";
  }

  const integrationSummaryEl = document.getElementById("integration-summary");
  const integrationDetailEl = document.getElementById("integration-detail");
  if (integrationSummaryEl) {
    integrationSummaryEl.textContent = data.integrations?.summary || "--";
  }
  if (integrationDetailEl) {
    integrationDetailEl.textContent = data.integrations?.detail || "--";
  }

  const appVersionEl = document.getElementById("status-app-version");
  if (appVersionEl) {
    appVersionEl.textContent = data.app?.version
      ? `Version: ${data.app.version}`
      : "Version: --";
  }

  updateLastUpdated(overall.last_updated || data.last_updated);
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
  const statusColor = STATUS_CLASS[status] || "secondary";

  badge.className = `badge bg-${statusColor}`;
  badge.textContent = data.label || status.toUpperCase();

  message.textContent = data.message || "--";
  message.className = `status-service-message text-${statusColor}`;

  if (detail) {
    detail.textContent = data.detail || "";
  }
}

function updateActivityList(errors) {
  const list = document.getElementById("recent-activity-list");
  if (!list) {
    return;
  }

  if (!errors || errors.length === 0) {
    list.innerHTML
      = '<div class="list-group-item bg-transparent text-muted small fst-italic py-3">No recent errors or warnings.</div>';
    return;
  }

  list.innerHTML = errors
    .map(
      (entry) => `
    <div class="list-group-item bg-transparent border-0 border-bottom border-secondary px-0 py-2">
      <div class="d-flex justify-content-between align-items-start">
        <div class="text-danger small fw-bold">
          <i class="fas fa-exclamation-circle me-1"></i> ${escapeHtml(
            entry.task_id || "System Error"
          )}
        </div>
        <small class="text-muted" style="font-size: 0.75rem;">${formatDateTime(
          entry.timestamp
        )}</small>
      </div>
      <div class="text-light small mt-1 text-break">${escapeHtml(
        entry.error || "Unknown error occurred"
      )}</div>
    </div>
  `
    )
    .join("");
}

function updatePlaybooks(data) {
  const container = document.getElementById("playbook-list");
  if (!container) {
    return;
  }

  const playbooks = [];
  const services = data?.services || {};
  const mapStatus = data?.map_services || {};
  const mapConfig = mapStatus?.config || {};
  const tasks = data?.tasks || {};

  if (services.mongodb?.status === "error") {
    playbooks.push({
      title: "Database offline",
      body: "MongoDB is unavailable. Check storage, then review logs.",
      actions: [
        { label: "Open DB Tools", href: "/settings#database" },
        { label: "View Logs", action: () => loadServiceLogs("mongodb") },
      ],
    });
  }

  if (services.redis?.status === "error") {
    playbooks.push({
      title: "Queue unavailable",
      body: "Redis is down, tasks cannot run. Restart redis or check Docker.",
      actions: [{ label: "View Redis Logs", action: () => loadServiceLogs("redis") }],
    });
  }

  if (services.worker?.status !== "healthy") {
    playbooks.push({
      title: "Worker needs attention",
      body: "Worker heartbeat is stale. Inspect worker logs or restart tasks.",
      actions: [
        { label: "View Worker Logs", action: () => loadServiceLogs("worker") },
        { label: "Run Tasks", action: () => runAllTasks() },
      ],
    });
  }

  if (services.bouncie?.status !== "healthy") {
    playbooks.push({
      title: "Bouncie not configured",
      body: "Credentials or devices missing. Complete setup wizard.",
      actions: [{ label: "Run Setup", href: "/setup-wizard" }],
    });
  }

  if (
    mapConfig?.last_error
    || mapConfig?.status === "error"
    || mapConfig?.status === "not_configured"
  ) {
    playbooks.push({
      title: "Map services incomplete",
      body: "Map data needs provisioning or retry.",
      actions: [
        {
          label: "Open Map Services",
          action: () => scrollToSection("map-services-content"),
        },
      ],
    });
  }

  if (tasks?.summary?.failed > 0) {
    playbooks.push({
      title: "Tasks failing",
      body: "Recent tasks failed. Inspect task history and retry after fixes.",
      actions: [
        {
          label: "View Task History",
          action: () => scrollToSection("taskHistoryTable"),
        },
      ],
    });
  }

  if (playbooks.length === 0) {
    container.innerHTML
      = '<div class="text-muted small">All systems look steady. No active playbooks.</div>';
    return;
  }

  container.innerHTML = playbooks
    .map((playbook, index) => {
      const actions = playbook.actions
        .map((action) => {
          if (action.href) {
            return `<a class="btn btn-outline-light btn-sm" href="${action.href}">${action.label}</a>`;
          }
          return `<button class="btn btn-outline-light btn-sm" data-playbook-action="${index}" data-action-label="${action.label}">${action.label}</button>`;
        })
        .join("");
      return `
        <div class="playbook-card">
          <h4>${playbook.title}</h4>
          <p>${playbook.body}</p>
          <div class="playbook-actions">${actions}</div>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll("[data-playbook-action]").forEach((btn) => {
    const index = Number(btn.dataset.playbookAction);
    const label = btn.dataset.actionLabel;
    const action = playbooks[index]?.actions?.find((a) => a.label === label);
    if (action?.action) {
      btn.addEventListener("click", action.action);
    }
  });
}

async function loadAppLogs(showSpinner = false) {
  const output = document.getElementById("app-log-output");
  if (!output) {
    return;
  }

  const level = document.getElementById("app-log-level")?.value || "";
  const search = document.getElementById("app-log-search")?.value || "";

  if (showSpinner) {
    output.textContent = "Loading app logs...";
  }

  try {
    const query = new URLSearchParams({ limit: "200" });
    if (level) {
      query.set("level", level);
    }
    if (search) {
      query.set("search", search);
    }
    const data = await apiClient.get(
      `${SERVER_LOGS_API}?${query.toString()}`,
      withSignal()
    );
    const lines
      = data.logs?.map((log) => `[${log.timestamp}] ${log.level}: ${log.message}`) || [];
    output.textContent = lines.join("\n") || "No logs found.";
  } catch (error) {
    output.textContent = `Failed to load logs: ${error.message}`;
  }
}

async function loadServiceLogs(serviceName) {
  const output = document.getElementById("service-log-output");
  if (!output) {
    return;
  }
  output.textContent = "Loading logs...";
  try {
    const data = await apiClient.get(
      `${LOGS_API_BASE}/${encodeURIComponent(serviceName)}`,
      withSignal()
    );
    output.textContent = data.logs || "No logs available.";
  } catch (error) {
    output.textContent = `Failed to load logs: ${error.message}`;
  }
}

async function loadContainerList() {
  const select = document.getElementById("container-log-select");
  if (!select) {
    return;
  }
  try {
    const data = await apiClient.get(CONTAINER_LIST_API, withSignal());
    const containers = data.containers || [];
    select.innerHTML = '<option value="">Select container</option>';
    containers.forEach((container) => {
      const option = document.createElement("option");
      option.value = container.name;
      option.textContent = `${container.name} (${container.status})`;
      select.appendChild(option);
    });
  } catch (error) {
    notificationManager.show(`Failed to load containers: ${error.message}`, "warning");
  }
}

async function loadContainerLogs(containerName) {
  const output = document.getElementById("container-log-output");
  if (!output) {
    return;
  }
  output.textContent = "Loading logs...";
  try {
    const data = await apiClient.get(
      `${CONTAINER_LOGS_API}/${encodeURIComponent(containerName)}?tail=200`,
      withSignal()
    );
    output.textContent = data.logs?.join("\n") || "No logs available.";
  } catch (error) {
    output.textContent = `Failed to load logs: ${error.message}`;
  }
}

async function restartService(serviceName) {
  if (!confirm(`Restart ${serviceName}?`)) {
    return;
  }
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

async function pauseTasks() {
  try {
    await apiClient.post("/api/background_tasks/pause", { duration: 60 }, withSignal());
    notificationManager.show("Tasks paused", "warning");
    taskManager?.loadTaskConfig();
  } catch (error) {
    notificationManager.show(`Failed to pause tasks: ${error.message}`, "danger");
  }
}

async function resumeTasks() {
  try {
    await apiClient.post("/api/background_tasks/resume", null, withSignal());
    notificationManager.show("Tasks resumed", "success");
    taskManager?.loadTaskConfig();
  } catch (error) {
    notificationManager.show(`Failed to resume tasks: ${error.message}`, "danger");
  }
}

async function stopAllTasks() {
  try {
    await apiClient.post("/api/background_tasks/stop", null, withSignal());
    notificationManager.show("All running tasks stopped", "success");
    taskManager?.loadTaskConfig();
  } catch (error) {
    notificationManager.show(`Failed to stop tasks: ${error.message}`, "danger");
  }
}

async function runAllTasks() {
  try {
    await apiClient.post("/api/background_tasks/run", { task_id: "ALL" }, withSignal());
    notificationManager.show("Running all enabled tasks", "info");
    taskManager?.loadTaskConfig();
  } catch (error) {
    notificationManager.show(`Failed to run tasks: ${error.message}`, "danger");
  }
}

async function resetTasks() {
  try {
    await apiClient.post("/api/background_tasks/reset", null, withSignal());
    notificationManager.show("Task state reset", "success");
    taskManager?.loadTaskConfig();
  } catch (error) {
    notificationManager.show(`Failed to reset tasks: ${error.message}`, "danger");
  }
}

async function saveTaskConfig() {
  try {
    const payload = gatherTaskConfigFromUI();
    await submitTaskConfigUpdate(payload);
    notificationManager.show("Task configuration saved", "success");
    taskManager?.loadTaskConfig();
  } catch (error) {
    notificationManager.show(`Failed to save config: ${error.message}`, "danger");
  }
}

async function clearTaskHistory() {
  if (!taskManager) {
    return;
  }
  await taskManager.clearTaskHistory();
}

async function fetchAllMissingTrips() {
  const statusEl = document.getElementById("fetch-all-status");
  const startInput = document.getElementById("fetch-all-start");
  const startDate = startInput?.value || null;

  if (statusEl) {
    statusEl.classList.remove("is-hidden");
    statusEl.textContent = "Starting fetch...";
  }

  try {
    const data = await apiClient.post(
      "/api/background_tasks/fetch_all_missing_trips",
      { start_date: startDate },
      withSignal()
    );
    notificationManager.show(data.message || "Fetch started", "success");
    if (statusEl) {
      statusEl.textContent = "Fetch started successfully.";
    }
  } catch (error) {
    notificationManager.show(`Failed to start fetch: ${error.message}`, "danger");
    if (statusEl) {
      statusEl.textContent = "Failed to start fetch.";
    }
  }
}

function updateLastUpdated(timestamp) {
  const el = document.getElementById("status-last-updated");
  if (el) {
    el.textContent = `Last updated: ${formatDateTime(timestamp)}`;
  }
}

function scrollToSection(id) {
  const el = document.getElementById(id);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}
