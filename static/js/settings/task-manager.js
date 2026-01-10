/* global showLoadingOverlay, hideLoadingOverlay, bootstrap */

/**
 * TaskManager - Handles background task management, SSE updates, and UI rendering
 */
export class TaskManager {
  constructor() {
    this.notifier = {
      show: (title, message, type = "info") => {
        window.notificationManager.show(`${title}: ${message}`, type);
      },
    };

    this.activeTasksMap = new Map();
    this.intervalOptions = [
      { value: 1, label: "1 minute" },
      { value: 5, label: "5 minutes" },
      { value: 15, label: "15 minutes" },
      { value: 30, label: "30 minutes" },
      { value: 60, label: "1 hour" },
      { value: 360, label: "6 hours" },
      { value: 720, label: "12 hours" },
      { value: 1440, label: "24 hours" },
    ];
    this.currentHistoryPage = 1;
    this.historyLimit = 10;
    this.historyTotalPages = 1;
    this.pollingInterval = null;
    this.configRefreshTimeout = null;
    this.eventSource = null;
    this.durationUpdateInterval = null;

    this.setupEventSource();
    this.setupPolling();
    this.setupDurationUpdates();
  }

  setupEventSource() {
    if (this.eventSource) {
      this.eventSource.close();
    }

    try {
      this.eventSource = new EventSource("/api/background_tasks/sse");

      this.eventSource.onmessage = (event) => {
        try {
          const updates = JSON.parse(event.data);

          Object.entries(updates).forEach(([taskId, update]) => {
            const row = document.querySelector(`tr[data-task-id="${taskId}"]`);
            if (!row) return;

            const statusCell = row.querySelector(".task-status");
            if (statusCell) {
              const currentStatus = statusCell.dataset.status;
              const newStatus = update.status;

              if (currentStatus !== newStatus) {
                statusCell.innerHTML = TaskManager.getStatusHTML(newStatus);
                statusCell.dataset.status = newStatus;

                const runButton = row.querySelector(".run-now-btn");
                if (runButton) {
                  const manualOnly = row.dataset.manualOnly === "true";
                  runButton.disabled = manualOnly || newStatus === "RUNNING";
                  runButton.title = manualOnly
                    ? "Use the manual fetch form below"
                    : "Run task now";
                }

                const forceButton = row.querySelector(".force-stop-btn");
                if (forceButton) {
                  forceButton.disabled = !["RUNNING", "PENDING"].includes(newStatus);
                }

                if (
                  currentStatus === "RUNNING" &&
                  (newStatus === "COMPLETED" || newStatus === "FAILED")
                ) {
                  const taskName = row.querySelector(".task-name-display").textContent;
                  const notificationType =
                    newStatus === "COMPLETED" ? "success" : "danger";
                  const message =
                    newStatus === "COMPLETED"
                      ? `Task ${taskName} completed successfully`
                      : `Task ${taskName} failed: ${update.last_error || "Unknown error"}`;

                  this.notifier.show(
                    newStatus === "COMPLETED" ? "Success" : "Error",
                    message,
                    notificationType
                  );
                }
              }
            }

            const lastRunCell = row.querySelector(".task-last-run");
            if (lastRunCell && update.last_run) {
              lastRunCell.textContent = TaskManager.formatDateTime(update.last_run);
            }

            const nextRunCell = row.querySelector(".task-next-run");
            if (nextRunCell && update.next_run) {
              nextRunCell.textContent = TaskManager.formatDateTime(update.next_run);
            }
          });

          this.updateActiveTasksMapFromUpdates(updates);
        } catch (error) {
          console.error("Error processing SSE update:", error);
        }
      };

      this.eventSource.onerror = (error) => {
        console.error("SSE connection error:", error);
        setTimeout(() => this.setupEventSource(), 5000);
      };
    } catch (error) {
      console.error("Error setting up EventSource:", error);
      this.setupPolling();
    }
  }

  updateActiveTasksMapFromUpdates(updates) {
    const runningTasks = new Set();

    for (const [taskId, taskData] of Object.entries(updates)) {
      if (taskData.status === "RUNNING") {
        runningTasks.add(taskId);
        if (!this.activeTasksMap.has(taskId)) {
          this.activeTasksMap.set(taskId, {
            status: "RUNNING",
            startTime: new Date(),
          });

          const row = document.querySelector(`tr[data-task-id="${taskId}"]`);
          if (row) {
            const displayName =
              row.querySelector(".task-name-display")?.textContent || taskId;
            this.notifier.show(
              "Task Started",
              `Task ${displayName} is now running`,
              "info"
            );
          }
        }
      }
    }

    for (const [taskId, taskState] of this.activeTasksMap.entries()) {
      if (!runningTasks.has(taskId) && updates[taskId]) {
        const taskStatus = updates[taskId].status;
        if (taskStatus !== "RUNNING") {
          if (taskState.status === "RUNNING") {
            const row = document.querySelector(`tr[data-task-id="${taskId}"]`);
            if (row) {
              const displayName =
                row.querySelector(".task-name-display")?.textContent || taskId;
              if (taskStatus === "COMPLETED" || taskStatus === "FAILED") {
                const type = taskStatus === "COMPLETED" ? "success" : "danger";
                const runTime = Math.round((Date.now() - taskState.startTime) / 1000);
                const message =
                  taskStatus === "COMPLETED"
                    ? `Task ${displayName} completed successfully in ${runTime}s`
                    : `Task ${displayName} failed: ${updates[taskId].last_error || "Unknown error"}`;

                this.notifier.show(taskStatus, message, type);
              }
            }
          }

          this.activeTasksMap.delete(taskId);
        }
      }
    }
  }

  setupPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    const pollInterval =
      this.eventSource?.readyState === EventSource.OPEN ? 15000 : 5000;

    this.pollingInterval = setInterval(() => {
      this.loadTaskConfig();
      this.updateTaskHistory();
    }, pollInterval);
  }

  async loadTaskConfig() {
    try {
      const response = await fetch("/api/background_tasks/config");
      if (!response.ok) {
        throw new Error("Failed to load task configuration");
      }
      const config = await response.json();

      const globalSwitch = document.getElementById("globalDisableSwitch");
      if (globalSwitch) {
        globalSwitch.checked = Boolean(config.disabled);
      }

      this.updateTaskConfigTable(config);
      this.updateActiveTasksMap(config);
      await this.updateTaskHistory();
    } catch (error) {
      console.error("Error loading task configuration:", error);
      this.notifier.show(
        "Error",
        `Failed to load task configuration: ${error.message}`,
        "danger"
      );
    }
  }

  updateActiveTasksMap(config) {
    const runningTasks = new Set();

    for (const [taskId, taskConfig] of Object.entries(config.tasks)) {
      if (taskConfig.status === "RUNNING") {
        runningTasks.add(taskId);
        if (!this.activeTasksMap.has(taskId)) {
          this.activeTasksMap.set(taskId, {
            status: "RUNNING",
            startTime: new Date(),
          });
        }
      }
    }

    const recentlyFinished = [];
    for (const [taskId] of this.activeTasksMap.entries()) {
      if (!runningTasks.has(taskId)) {
        recentlyFinished.push(taskId);
      }
    }

    for (const taskId of recentlyFinished) {
      const displayName = config.tasks[taskId]?.display_name || taskId;
      const status = config.tasks[taskId]?.status || "COMPLETED";

      if (
        this.activeTasksMap.get(taskId).status === "RUNNING" &&
        (status === "COMPLETED" || status === "FAILED")
      ) {
        const type = status === "COMPLETED" ? "success" : "danger";
        const runTime = Math.round(
          (Date.now() - this.activeTasksMap.get(taskId).startTime) / 1000
        );
        const message =
          status === "COMPLETED"
            ? `Task ${displayName} completed successfully in ${runTime}s`
            : `Task ${displayName} failed: ${config.tasks[taskId]?.last_error || "Unknown error"}`;

        this.notifier.show(status, message, type);
      }

      this.activeTasksMap.delete(taskId);
    }
  }

  updateTaskConfigTable(config) {
    const tbody = document.querySelector("#taskConfigTable tbody");
    if (!tbody) return;

    tbody.innerHTML = "";

    Object.entries(config.tasks).forEach(([taskId, task]) => {
      const row = document.createElement("tr");
      row.dataset.taskId = taskId;

      const isManualOnly = Boolean(task.manual_only);
      row.dataset.manualOnly = isManualOnly ? "true" : "false";
      const taskStatus = task.status || "IDLE";
      const canForceStop = ["RUNNING", "PENDING"].includes(taskStatus);

      if (!task.display_name) return;

      row.innerHTML = `
          <td>
            <span class="task-name-display">${task.display_name || taskId}</span>
            <span class="text-muted small d-block">${taskId}</span>
            ${isManualOnly ? '<span class="badge bg-secondary ms-2">Manual</span>' : ""}
          </td>
          <td>
            ${
              isManualOnly
                ? '<span class="badge bg-info text-dark">Manual trigger</span>'
                : `<select class="form-select form-select-sm" data-task-id="${taskId}">
              ${this.intervalOptions
                .map(
                  (opt) => `
                <option value="${opt.value}" ${opt.value === task.interval_minutes ? "selected" : ""}>
                  ${opt.label}
                </option>
              `
                )
                .join("")}
            </select>`
            }
          </td>
          <td>
            ${
              isManualOnly
                ? '<span class="badge bg-info text-dark">Always enabled</span>'
                : `<div class="form-check form-switch">
              <input class="form-check-input" type="checkbox"
                id="enable-${taskId}" ${task.enabled ? "checked" : ""}
                data-task-id="${taskId}">
            </div>`
            }
          </td>
          <td class="task-status" data-status="${taskStatus}">${TaskManager.getStatusHTML(taskStatus)}</td>
          <td class="task-last-run">${task.last_run ? TaskManager.formatDateTime(task.last_run) : "Never"}</td>
          <td class="task-next-run">${task.next_run ? TaskManager.formatDateTime(task.next_run) : "Not scheduled"}</td>
          <td>
            <div class="btn-group btn-group-sm">
              <button class="btn btn-info run-now-btn" data-task-id="${taskId}"
                ${isManualOnly || taskStatus === "RUNNING" ? "disabled" : ""}
                title="${isManualOnly ? "Use the manual fetch form below" : "Run task now"}">
                <i class="fas fa-play"></i>
              </button>
              <button class="btn btn-warning force-stop-btn" data-task-id="${taskId}"
                ${canForceStop ? "" : "disabled"}
                title="Force stop and reset task">
                <i class="fas fa-stop-circle"></i>
              </button>
              <button class="btn btn-primary view-details-btn" data-task-id="${taskId}"
                title="View task details">
                <i class="fas fa-info-circle"></i>
              </button>
            </div>
          </td>
        `;

      tbody.appendChild(row);
    });
  }

  async updateTaskHistory() {
    try {
      const response = await fetch(
        `/api/background_tasks/history?page=${this.currentHistoryPage}&limit=${this.historyLimit}`
      );
      if (!response.ok) {
        throw new Error("Failed to fetch task history");
      }
      const data = await response.json();
      this.historyTotalPages = data.total_pages;
      TaskManager.updateTaskHistoryTable(data.history);
      this.updateHistoryPagination();
    } catch (error) {
      console.error("Error updating task history:", error);
      this.notifier.show(
        "Error",
        `Failed to update task history: ${error.message}`,
        "danger"
      );
    }
  }

  static updateTaskHistoryTable(history) {
    const tbody = document.querySelector("#taskHistoryTable tbody");
    if (!tbody) return;

    tbody.innerHTML = "";

    if (history.length === 0) {
      const row = document.createElement("tr");
      row.innerHTML =
        '<td colspan="6" class="text-center">No task history available</td>';
      tbody.appendChild(row);
      return;
    }

    history.forEach((entry) => {
      const row = document.createElement("tr");

      let durationText = "Unknown";
      if (entry.runtime !== null && entry.runtime !== undefined) {
        const runtimeMs = parseFloat(entry.runtime);
        if (!Number.isNaN(runtimeMs)) {
          durationText = TaskManager.formatDuration(runtimeMs);
        }
      } else if (entry.status === "RUNNING" && entry.timestamp) {
        try {
          const startTime = new Date(entry.timestamp);
          const now = new Date();
          const elapsedMs = now - startTime;
          if (!Number.isNaN(elapsedMs) && elapsedMs >= 0) {
            durationText = TaskManager.formatDuration(elapsedMs);
            row.dataset.startTime = entry.timestamp;
            row.dataset.isRunning = "true";
          }
        } catch (e) {
          console.error("Error calculating elapsed time:", e);
        }
      }

      let resultText = "N/A";
      if (entry.status === "RUNNING") {
        resultText = "Running";
      } else if (entry.status === "PENDING") {
        resultText = "Pending";
      } else if (entry.status === "COMPLETED") {
        resultText = entry.result ? "Success" : "Completed";
      } else if (entry.status === "FAILED") {
        resultText = "Failed";
      } else {
        resultText = "N/A";
      }

      let detailsContent = "N/A";
      if (entry.error) {
        detailsContent = `<button class="btn btn-sm btn-danger view-error-btn"
                  data-error="${TaskManager.escapeHtml(entry.error)}">
                  <i class="fas fa-exclamation-circle"></i> View Error
                </button>`;
      } else if (entry.status === "COMPLETED") {
        detailsContent =
          '<span class="text-success"><i class="fas fa-check-circle"></i> Completed successfully</span>';
      } else if (entry.status === "RUNNING") {
        detailsContent =
          '<span class="text-info"><i class="fas fa-spinner fa-spin"></i> In progress</span>';
      } else if (entry.status === "FAILED") {
        detailsContent =
          '<span class="text-danger"><i class="fas fa-times-circle"></i> Failed</span>';
      }

      row.innerHTML = `
          <td>${entry.task_id}</td>
          <td>
            <span class="badge bg-${TaskManager.getStatusColor(entry.status)}">
              ${entry.status}
            </span>
          </td>
          <td>${TaskManager.formatDateTime(entry.timestamp)}</td>
          <td class="task-duration">${durationText}</td>
          <td>${resultText}</td>
          <td>${detailsContent}</td>
        `;
      tbody.appendChild(row);
    });

    const errorButtons = tbody.querySelectorAll(".view-error-btn");
    errorButtons.forEach((btn) => {
      btn.addEventListener("mousedown", (_e) => {
        const errorMessage = btn.dataset.error;
        TaskManager.showErrorModal(errorMessage);
      });
    });

    TaskManager.updateRunningTaskDurations();
  }

  static updateRunningTaskDurations() {
    // Update desktop table
    const tbody = document.querySelector("#taskHistoryTable tbody");
    if (tbody) {
      tbody.querySelectorAll("tr[data-is-running='true']").forEach((row) => {
        const startTimeStr = row.dataset.startTime;
        if (startTimeStr) {
          try {
            const startTime = new Date(startTimeStr);
            const now = new Date();
            const elapsedMs = now - startTime;
            if (!Number.isNaN(elapsedMs) && elapsedMs >= 0) {
              const durationCell = row.querySelector(".task-duration");
              if (durationCell) {
                durationCell.textContent = TaskManager.formatDuration(elapsedMs);
              }
            }
          } catch (e) {
            console.error("Error updating duration:", e);
          }
        }
      });
    }

    // Update mobile list
    const mobileList = document.getElementById("mobile-history-list");
    if (mobileList) {
      mobileList
        .querySelectorAll(".mobile-history-card[data-is-running='true']")
        .forEach((card) => {
          const startTimeStr = card.dataset.startTime;
          if (startTimeStr) {
            try {
              const startTime = new Date(startTimeStr);
              const now = new Date();
              const elapsedMs = now - startTime;
              if (!Number.isNaN(elapsedMs) && elapsedMs >= 0) {
                const durationElement = card.querySelector(".task-duration");
                if (durationElement) {
                  durationElement.textContent = TaskManager.formatDuration(elapsedMs);
                }
              }
            } catch (e) {
              console.error("Error updating duration:", e);
            }
          }
        });
    }
  }

  setupDurationUpdates() {
    if (this.durationUpdateInterval) {
      clearInterval(this.durationUpdateInterval);
    }
    this.durationUpdateInterval = setInterval(() => {
      TaskManager.updateRunningTaskDurations();
    }, 1000);
  }

  static escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  static showErrorModal(errorMessage) {
    let modal = document.getElementById("errorModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "errorModal";
      modal.className = "modal fade";
      modal.setAttribute("tabindex", "-1");
      modal.innerHTML = `
        <div class="modal-dialog">
          <div class="modal-content bg-dark text-white">
            <div class="modal-header">
              <h5 class="modal-title">Task Error Details</h5>
              <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <pre class="error-details p-3 bg-dark text-danger border border-danger rounded" style="white-space: pre-wrap;"></pre>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }

    const errorContent = modal.querySelector(".error-details");
    errorContent.textContent = errorMessage;

    const bsModal = new bootstrap.Modal(modal);
    bsModal.show();
  }

  updateHistoryPagination() {
    const paginationContainer = document.querySelector("#taskHistoryPagination");
    if (!paginationContainer) return;

    paginationContainer.innerHTML = "";

    if (this.historyTotalPages <= 1) return;

    const pagination = document.createElement("ul");
    pagination.className = "pagination justify-content-center";

    const prevLi = document.createElement("li");
    prevLi.className = `page-item ${this.currentHistoryPage === 1 ? "disabled" : ""}`;
    prevLi.innerHTML = `<a class="page-link" href="#" data-page="${this.currentHistoryPage - 1}">Previous</a>`;
    pagination.appendChild(prevLi);

    const startPage = Math.max(1, this.currentHistoryPage - 2);
    const endPage = Math.min(this.historyTotalPages, startPage + 4);

    for (let i = startPage; i <= endPage; i++) {
      const pageLi = document.createElement("li");
      pageLi.className = `page-item ${i === this.currentHistoryPage ? "active" : ""}`;
      pageLi.innerHTML = `<a class="page-link" href="#" data-page="${i}">${i}</a>`;
      pagination.appendChild(pageLi);
    }

    const nextLi = document.createElement("li");
    nextLi.className = `page-item ${this.currentHistoryPage === this.historyTotalPages ? "disabled" : ""}`;
    nextLi.innerHTML = `<a class="page-link" href="#" data-page="${this.currentHistoryPage + 1}">Next</a>`;
    pagination.appendChild(nextLi);

    paginationContainer.appendChild(pagination);

    const pageLinks = paginationContainer.querySelectorAll(".page-link");
    pageLinks.forEach((link) => {
      link.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const page = parseInt(e.target.dataset.page, 10);
        if (page && page !== this.currentHistoryPage) {
          this.currentHistoryPage = page;
          this.updateTaskHistory();
        }
      });
    });
  }

  static getStatusHTML(status) {
    const statusColors = {
      RUNNING: "primary",
      PENDING: "info",
      COMPLETED: "success",
      FAILED: "danger",
      PAUSED: "warning",
      IDLE: "secondary",
    };

    const color = statusColors[status] || "secondary";

    if (status === "RUNNING") {
      return `
          <div class="d-flex align-items-center">
            <div class="spinner-border spinner-border-sm me-2" role="status">
              <span class="visually-hidden">Running...</span>
            </div>
            <span class="status-text">Running</span>
          </div>
        `;
    }

    return `<span class="badge bg-${color}">${status}</span>`;
  }

  static getStatusColor(status) {
    const statusColors = {
      RUNNING: "primary",
      PENDING: "info",
      COMPLETED: "success",
      FAILED: "danger",
      PAUSED: "warning",
      IDLE: "secondary",
    };
    return statusColors[status] || "secondary";
  }

  static formatDateTime(date) {
    if (!date) return "N/A";
    const d = new Date(date);
    return d.toLocaleString();
  }

  static formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  async runTask(taskId) {
    try {
      showLoadingOverlay();

      const response = await fetch("/api/background_tasks/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([taskId]),
      });

      const result = await response.json();

      hideLoadingOverlay();

      if (!response.ok) {
        throw new Error(result.detail || "Failed to start task");
      }

      if (result.status === "success") {
        if (result.results?.length > 0) {
          const taskResult = result.results.find((r) => r.task === taskId);

          if (taskResult && !taskResult.success) {
            TaskManager.showDependencyErrorModal(taskId, taskResult.message);
            return false;
          }
        }

        this.activeTasksMap.set(taskId, {
          status: "RUNNING",
          startTime: new Date(),
        });

        this.notifier.show("Task Started", `Task ${taskId} has been started`, "info");

        const row = document.querySelector(`tr[data-task-id="${taskId}"]`);
        if (row) {
          const statusCell = row.querySelector(".task-status");
          if (statusCell) {
            statusCell.innerHTML = TaskManager.getStatusHTML("RUNNING");
            statusCell.dataset.status = "RUNNING";
          }

          const runButton = row.querySelector(".run-now-btn");
          if (runButton) {
            runButton.disabled = true;
          }
        }

        await this.loadTaskConfig();

        return true;
      }
      throw new Error(result.message || "Failed to start task");
    } catch (error) {
      console.error(`Error running task ${taskId}:`, error);
      hideLoadingOverlay();
      this.notifier.show(
        "Error",
        `Failed to start task ${taskId}: ${error.message}`,
        "danger"
      );
      return false;
    }
  }

  async forceStopTask(taskId) {
    if (!taskId) return false;

    let confirmed = true;
    const confirmMessage = `Force stop task ${taskId}? This will reset its status.`;

    if (
      window.confirmationDialog &&
      typeof window.confirmationDialog.show === "function"
    ) {
      confirmed = await window.confirmationDialog.show({
        title: "Force Stop Task",
        message: confirmMessage,
        confirmLabel: "Force Stop",
        confirmVariant: "danger",
      });
    } else {
      confirmed = await window.confirmationDialog.show({
        title: "Confirm Action",
        message: confirmMessage,
        confirmText: "Yes",
        confirmButtonClass: "btn-primary",
      });
    }

    if (!confirmed) return false;

    try {
      showLoadingOverlay();
      const response = await fetch("/api/background_tasks/force_stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: taskId }),
      });

      const data = await response.json();
      hideLoadingOverlay();

      if (!response.ok) {
        throw new Error(data.detail || data.message || "Failed to force stop task");
      }

      const message = data.message || `Task ${taskId} has been reset.`;
      this.notifier.show("Task Reset", message, "warning");

      await this.loadTaskConfig();
      return true;
    } catch (error) {
      hideLoadingOverlay();
      console.error(`Error force stopping task ${taskId}:`, error);
      this.notifier.show(
        "Error",
        `Failed to force stop task ${taskId}: ${error.message}`,
        "danger"
      );
      return false;
    }
  }

  async scheduleManualFetch(startIso, endIso, mapMatch) {
    try {
      showLoadingOverlay();
      const response = await fetch("/api/background_tasks/fetch_trips_range", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_date: startIso,
          end_date: endIso,
          map_match: mapMatch,
        }),
      });

      const result = await response.json();
      hideLoadingOverlay();

      if (!response.ok) {
        throw new Error(result.detail || result.message || "Failed to schedule fetch");
      }

      this.notifier.show(
        "Success",
        result.message || "Fetch scheduled successfully",
        "success"
      );
      await this.loadTaskConfig();
      return true;
    } catch (error) {
      hideLoadingOverlay();
      console.error("Error scheduling manual fetch:", error);
      this.notifier.show(
        "Error",
        `Failed to schedule fetch: ${error.message}`,
        "danger"
      );
      throw error;
    }
  }

  static gatherTaskConfigFromUI() {
    const config = { tasks: {} };
    const globalSwitch = document.getElementById("globalDisableSwitch");
    config.disabled = globalSwitch?.checked || false;

    document.querySelectorAll("#taskConfigTable tbody tr").forEach((row) => {
      const { taskId } = row.dataset;
      if (!taskId) return;

      const intervalSelect = row.querySelector(`select[data-task-id="${taskId}"]`);
      const enabledCheckbox = row.querySelector(`input[data-task-id="${taskId}"]`);

      config.tasks[taskId] = {
        interval_minutes: intervalSelect ? parseInt(intervalSelect.value, 10) : null,
        enabled: enabledCheckbox ? enabledCheckbox.checked : true,
      };
    });

    return config;
  }

  static async submitTaskConfigUpdate(config) {
    const response = await fetch("/api/background_tasks/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.detail || "Failed to update configuration");
    }

    return response.json();
  }

  static async showTaskDetails(taskId) {
    const modal = document.getElementById("taskDetailsModal");
    if (!modal) return;

    const modalBody = modal.querySelector(".modal-body");
    const runBtn = modal.querySelector(".run-task-btn");

    if (runBtn) {
      runBtn.dataset.taskId = taskId;
    }

    modalBody.innerHTML =
      '<div class="text-center"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';

    const bsModal = new bootstrap.Modal(modal);
    bsModal.show();

    try {
      const response = await fetch(`/api/background_tasks/details/${taskId}`);
      if (!response.ok) throw new Error("Failed to fetch task details");

      const details = await response.json();

      modalBody.innerHTML = `
        <div class="task-details">
          <h6>${details.display_name || taskId}</h6>
          <p class="text-muted small">${taskId}</p>
          
          <div class="row mb-3">
            <div class="col-6">
              <strong>Status:</strong><br>
              ${TaskManager.getStatusHTML(details.status || "IDLE")}
            </div>
            <div class="col-6">
              <strong>Enabled:</strong><br>
              ${details.enabled ? '<span class="badge bg-success">Yes</span>' : '<span class="badge bg-secondary">No</span>'}
            </div>
          </div>
          
          <div class="row mb-3">
            <div class="col-6">
              <strong>Interval:</strong><br>
              ${details.interval_minutes ? `${details.interval_minutes} minutes` : "Manual"}
            </div>
            <div class="col-6">
              <strong>Run Count:</strong><br>
              ${details.run_count || 0}
            </div>
          </div>
          
          <div class="row mb-3">
            <div class="col-6">
              <strong>Last Run:</strong><br>
              ${details.last_run ? TaskManager.formatDateTime(details.last_run) : "Never"}
            </div>
            <div class="col-6">
              <strong>Next Run:</strong><br>
              ${details.next_run ? TaskManager.formatDateTime(details.next_run) : "Not scheduled"}
            </div>
          </div>
          
          ${
            details.last_error
              ? `
          <div class="alert alert-danger">
            <strong>Last Error:</strong><br>
            <pre class="mb-0" style="white-space: pre-wrap;">${TaskManager.escapeHtml(details.last_error)}</pre>
          </div>
          `
              : ""
          }
          
          ${
            details.description
              ? `
          <div class="mt-3">
            <strong>Description:</strong><br>
            <p class="text-muted">${details.description}</p>
          </div>
          `
              : ""
          }
        </div>
      `;
    } catch (error) {
      console.error("Error fetching task details:", error);
      modalBody.innerHTML = `
        <div class="alert alert-danger">
          Failed to load task details: ${error.message}
        </div>
      `;
    }
  }

  async clearTaskHistory() {
    let confirmed = true;

    if (
      window.confirmationDialog &&
      typeof window.confirmationDialog.show === "function"
    ) {
      confirmed = await window.confirmationDialog.show({
        title: "Clear Task History",
        message:
          "Are you sure you want to clear all task history? This cannot be undone.",
        confirmLabel: "Clear History",
        confirmVariant: "danger",
      });
    }

    if (!confirmed) return;

    try {
      showLoadingOverlay();
      const response = await fetch("/api/background_tasks/history", {
        method: "DELETE",
      });

      hideLoadingOverlay();

      if (!response.ok) {
        throw new Error("Failed to clear history");
      }

      this.notifier.show("Success", "Task history cleared", "success");
      this.currentHistoryPage = 1;
      await this.updateTaskHistory();
    } catch (error) {
      hideLoadingOverlay();
      console.error("Error clearing task history:", error);
      this.notifier.show(
        "Error",
        `Failed to clear history: ${error.message}`,
        "danger"
      );
    }
  }

  static showDependencyErrorModal(_taskId, errorMessage) {
    let modal = document.getElementById("dependencyErrorModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "dependencyErrorModal";
      modal.className = "modal fade";
      modal.setAttribute("tabindex", "-1");
      modal.innerHTML = `
        <div class="modal-dialog">
          <div class="modal-content bg-dark text-white">
            <div class="modal-header bg-warning text-dark">
              <h5 class="modal-title"><i class="fas fa-exclamation-triangle"></i> Task Dependency Error</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <p class="dependency-error-message"></p>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }

    const messageEl = modal.querySelector(".dependency-error-message");
    messageEl.textContent = errorMessage;

    const bsModal = new bootstrap.Modal(modal);
    bsModal.show();
  }

  cleanup() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    if (this.configRefreshTimeout) {
      clearTimeout(this.configRefreshTimeout);
      this.configRefreshTimeout = null;
    }
    if (this.durationUpdateInterval) {
      clearInterval(this.durationUpdateInterval);
      this.durationUpdateInterval = null;
    }
  }
}
