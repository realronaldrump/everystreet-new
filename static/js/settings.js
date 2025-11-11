/* global showLoadingOverlay, hideLoadingOverlay, bootstrap, flatpickr, taskManager */

(() => {
  class TaskManager {
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
                    const taskName =
                      row.querySelector(".task-name-display").textContent;
                    const notificationType =
                      newStatus === "COMPLETED" ? "success" : "danger";
                    const message =
                      newStatus === "COMPLETED"
                        ? `Task ${taskName} completed successfully`
                        : `Task ${taskName} failed: ${
                            update.last_error || "Unknown error"
                          }`;

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
                      : `Task ${displayName} failed: ${
                          updates[taskId].last_error || "Unknown error"
                        }`;

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
      for (const [taskId, _taskState] of this.activeTasksMap.entries()) {
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
              : `Task ${displayName} failed: ${
                  config.tasks[taskId]?.last_error || "Unknown error"
                }`;

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
              ${
                isManualOnly
                  ? '<span class="badge bg-secondary ms-2">Manual</span>'
                  : ""
              }
            </td>
            <td>
              ${
                isManualOnly
                  ? '<span class="badge bg-info text-dark">Manual trigger</span>'
                  : `<select class="form-select form-select-sm" data-task-id="${taskId}">
                ${this.intervalOptions
                  .map(
                    (opt) => `
                  <option value="${opt.value}" ${
                    opt.value === task.interval_minutes ? "selected" : ""
                  }>
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
            <td>${task.priority || "MEDIUM"}</td>
            <td class="task-status" data-status="${
              taskStatus
            }">${TaskManager.getStatusHTML(taskStatus)}</td>
            <td class="task-last-run">${
              task.last_run ? TaskManager.formatDateTime(task.last_run) : "Never"
            }</td>
            <td class="task-next-run">${
              task.next_run
                ? TaskManager.formatDateTime(task.next_run)
                : "Not scheduled"
            }</td>
            <td>
              <div class="btn-group btn-group-sm">
                <button class="btn btn-info run-now-btn" data-task-id="${taskId}"
                  ${isManualOnly || taskStatus === "RUNNING" ? "disabled" : ""}
                  title="${
                    isManualOnly ? "Use the manual fetch form below" : "Run task now"
                  }">
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
        this.updateTaskHistoryTable(data.history);
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

    updateTaskHistoryTable(history) {
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
          // Calculate elapsed time for running tasks
          try {
            const startTime = new Date(entry.timestamp);
            const now = new Date();
            const elapsedMs = now - startTime;
            if (!Number.isNaN(elapsedMs) && elapsedMs >= 0) {
              durationText = TaskManager.formatDuration(elapsedMs);
              // Store the timestamp for real-time updates
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
        } else if (entry.status === "COMPLETED") {
          resultText = entry.result ? "Success" : "Completed";
        } else if (entry.status === "FAILED") {
          resultText = "Failed";
        } else {
          resultText = entry.result ? "Success" : "Failed";
        }

        let detailsContent = "N/A";
        if (entry.error) {
          detailsContent = `<button class="btn btn-sm btn-danger view-error-btn"
                    data-error="${this.escapeHtml(entry.error)}">
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
          this.showErrorModal(errorMessage);
        });
      });

      // Update durations for running tasks
      this.updateRunningTaskDurations();
    }

    updateRunningTaskDurations() {
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
      // Update durations every second for running tasks
      this.durationUpdateInterval = setInterval(() => {
        this.updateRunningTaskDurations();
      }, 1000);
    }

    escapeHtml(str) {
      if (!str) return "";
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    showErrorModal(errorMessage) {
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
      prevLi.innerHTML = `<a class="page-link" href="#" data-page="${
        this.currentHistoryPage - 1
      }">Previous</a>`;
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
      nextLi.className = `page-item ${
        this.currentHistoryPage === this.historyTotalPages ? "disabled" : ""
      }`;
      nextLi.innerHTML = `<a class="page-link" href="#" data-page="${
        this.currentHistoryPage + 1
      }">Next</a>`;
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
        COMPLETED: "success",
        FAILED: "danger",
        PAUSED: "warning",
        IDLE: "secondary",
      };
      return statusColors[status] || "secondary";
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
              this.showDependencyErrorModal(taskId, taskResult.message);
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
        confirmed = window.confirm(confirmMessage);
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
            map_match: Boolean(mapMatch),
          }),
        });

        const data = await response.json();
        hideLoadingOverlay();

        if (!response.ok) {
          throw new Error(data.detail || data.message || "Failed to schedule fetch");
        }

        const message = data.message || "Manual trip fetch scheduled.";
        this.notifier.show("Fetch Scheduled", message, "success");
        await this.loadTaskConfig();
        return data;
      } catch (error) {
        hideLoadingOverlay();
        console.error("Error scheduling manual fetch:", error);
        this.notifier.show(
          "Error",
          `Failed to schedule manual fetch: ${error.message}`,
          "danger"
        );
        throw error;
      }
    }

    static formatDateTime(date) {
      if (!date) return "";
      try {
        return new Date(date).toLocaleString();
      } catch (_e) {
        return date;
      }
    }

    static formatDuration(ms) {
      if (typeof ms !== "number" || Number.isNaN(ms)) return "Unknown";
      const seconds = Math.max(0, Math.floor(ms / 1000));
      return window.DateUtils?.formatDuration(seconds) || "Unknown";
    }

    gatherTaskConfigFromUI() {
      const tasks = {};
      document.querySelectorAll("#taskConfigTable tbody tr").forEach((row) => {
        const { taskId } = row.dataset;
        if (!taskId) return;

        const sel = row.querySelector("select");
        const check = row.querySelector('input[type="checkbox"]');
        if (!sel || !check) return;

        tasks[taskId] = {
          interval_minutes: parseInt(sel.value, 10),
          enabled: check.checked,
        };
      });

      return {
        globalDisable: document.getElementById("globalDisableSwitch")?.checked,
        tasks,
      };
    }

    async submitTaskConfigUpdate(config) {
      showLoadingOverlay();

      try {
        const response = await fetch("/api/background_tasks/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(config),
        });

        if (!response.ok) {
          const errData = await response.json();
          throw new Error(errData.message || "Error updating config");
        }

        hideLoadingOverlay();
        return response.json();
      } catch (error) {
        hideLoadingOverlay();
        throw error;
      }
    }

    async showTaskDetails(taskId) {
      try {
        showLoadingOverlay();

        const taskResponse = await fetch(`/api/background_tasks/task/${taskId}`);
        if (!taskResponse.ok) throw new Error("Failed to fetch task details");
        const taskDetails = await taskResponse.json();

        hideLoadingOverlay();

        const modal = document.getElementById("taskDetailsModal");
        const content = modal.querySelector(".task-details-content");
        const runBtn = modal.querySelector(".run-task-btn");

        content.innerHTML = `
            <div class="mb-3">
              <h6>Task ID</h6>
              <p>${taskId}</p>
            </div>
            <div class="mb-3">
              <h6>Display Name</h6>
              <p>${taskDetails.display_name || taskId}</p>
            </div>
            <div class="mb-3">
              <h6>Description</h6>
              <p>${taskDetails.description || "No description available"}</p>
            </div>
            <div class="mb-3">
              <h6>Status</h6>
                      <p>${TaskManager.getStatusHTML(taskDetails.status || "IDLE")}</p>
            </div>
            <div class="mb-3">
              <h6>Interval</h6>
              <p>${
                this.intervalOptions.find(
                  (opt) => opt.value === taskDetails.interval_minutes
                )?.label || `${taskDetails.interval_minutes} minutes`
              }</p>
            </div>
            <div class="mb-3">
              <h6>Priority</h6>
              <p>${taskDetails.priority || "MEDIUM"}</p>
            </div>
            <div class="mb-3">
              <h6>Dependencies</h6>
              ${
                taskDetails.dependencies?.length > 0
                  ? `<div>
                   <p>${taskDetails.dependencies.join(", ")}</p>
                   <div class="alert alert-info small mt-2">
                     <i class="fas fa-info-circle"></i> 
                     Dependencies will be checked before task execution. This task will wait for any running dependencies to complete.
                   </div>
                 </div>`
                  : "<p>None</p>"
              }
            </div>
            <div class="mb-3">
              <h6>Last Run</h6>
              <p>${
                taskDetails.last_run
                  ? TaskManager.formatDateTime(taskDetails.last_run)
                  : "Never"
              }</p>
            </div>
            <div class="mb-3">
              <h6>Next Run</h6>
              <p>${
                taskDetails.next_run
                  ? TaskManager.formatDateTime(taskDetails.next_run)
                  : "Not scheduled"
              }</p>
            </div>
            <div class="mb-3">
              <h6>Enabled</h6>
              <p>${taskDetails.enabled ? "Yes" : "No"}</p>
            </div>
            ${
              taskDetails.last_error
                ? `
            <div class="mb-3">
              <h6>Last Error</h6>
              <pre class="bg-dark text-danger p-2 rounded">${this.escapeHtml(
                taskDetails.last_error
              )}</pre>
            </div>`
                : ""
            }
            ${
              taskDetails.history?.length > 0
                ? `
            <div class="mb-3">
              <h6>Recent History</h6>
              <table class="table table-dark table-sm">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Status</th>
                    <th>Runtime</th>
                  </tr>
                </thead>
                <tbody>
                  ${taskDetails.history
                    .map(
                      (entry) => `
                    <tr>
                      <td>${TaskManager.formatDateTime(entry.timestamp)}</td>
                      <td><span class="badge bg-${TaskManager.getStatusColor(
                        entry.status
                      )}">${entry.status}</span></td>
                      <td>${
                        entry.runtime
                          ? TaskManager.formatDuration(entry.runtime)
                          : "N/A"
                      }</td>
                    </tr>
                  `
                    )
                    .join("")}
                </tbody>
              </table>
            </div>`
                : ""
            }
          `;

        runBtn.dataset.taskId = taskId;
        runBtn.disabled = taskDetails.status === "RUNNING";

        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();
      } catch (error) {
        hideLoadingOverlay();
        console.error("Error fetching task details:", error);
        this.notifier.show(
          "Error",
          `Failed to fetch task details: ${error.message}`,
          "danger"
        );
      }
    }

    async clearTaskHistory() {
      try {
        showLoadingOverlay();

        const response = await fetch("/api/background_tasks/history/clear", {
          method: "POST",
        });

        if (!response.ok) {
          throw new Error("Failed to clear task history");
        }

        hideLoadingOverlay();

        const tbody = document.querySelector("#taskHistoryTable tbody");
        if (tbody) {
          tbody.innerHTML =
            '<tr><td colspan="6" class="text-center">No task history available</td></tr>';
        }

        this.currentHistoryPage = 1;
        this.historyTotalPages = 1;
        const paginationContainer = document.querySelector("#taskHistoryPagination");
        if (paginationContainer) {
          paginationContainer.innerHTML = "";
        }

        this.notifier.show("Success", "Task history cleared successfully", "success");
      } catch (error) {
        hideLoadingOverlay();
        console.error("Error clearing task history:", error);
        this.notifier.show(
          "Error",
          `Failed to clear task history: ${error.message}`,
          "danger"
        );
      }
    }

    showDependencyErrorModal(_taskId, errorMessage) {
      let modal = document.getElementById("dependencyErrorModal");
      if (!modal) {
        modal = document.createElement("div");
        modal.id = "dependencyErrorModal";
        modal.className = "modal fade";
        modal.setAttribute("tabindex", "-1");
        modal.innerHTML = `
          <div class="modal-dialog">
            <div class="modal-content bg-dark text-white">
              <div class="modal-header">
                <h5 class="modal-title">Dependency Check Failed</h5>
                <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
              </div>
              <div class="modal-body">
                <div class="alert alert-warning">
                  <i class="fas fa-exclamation-triangle"></i> 
                  <span class="dependency-error-message"></span>
                </div>
                <p>The task cannot run because one or more dependencies are not satisfied.</p>
                <div class="dependency-details"></div>
              </div>
              <div class="modal-footer">
                <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
              </div>
            </div>
          </div>
        `;
        document.body.appendChild(modal);
      }

      const errorMessageEl = modal.querySelector(".dependency-error-message");
      if (errorMessageEl) {
        errorMessageEl.textContent = errorMessage;
      }

      const bsModal = new bootstrap.Modal(modal);
      bsModal.show();

      this.loadTaskConfig();
    }

    cleanup() {
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

      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }
    }
  }

  window.taskManager = null;

  document.addEventListener("DOMContentLoaded", () => {
    window.taskManager = new TaskManager();

    setupTaskConfigEventListeners();
    setupManualFetchTripsForm();
    setupGeocodeTrips();
    setupRemapMatchedTrips();

    taskManager.loadTaskConfig();

    window.addEventListener("beforeunload", () => {
      if (window.taskManager) {
        window.taskManager.cleanup();
      }
    });
  });

  function setupTaskConfigEventListeners() {
    const saveTaskConfigBtn = document.getElementById("saveTaskConfigBtn");
    const confirmPauseBtn = document.getElementById("confirmPause");
    const resumeBtn = document.getElementById("resumeBtn");
    const stopAllBtn = document.getElementById("stopAllBtn");
    const enableAllBtn = document.getElementById("enableAllBtn");
    const disableAllBtn = document.getElementById("disableAllBtn");
    const manualRunAllBtn = document.getElementById("manualRunAllBtn");
    const globalSwitch = document.getElementById("globalDisableSwitch");
    const clearHistoryBtn = document.getElementById("clearHistoryBtn");

    if (saveTaskConfigBtn) {
      saveTaskConfigBtn.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        const config = taskManager.gatherTaskConfigFromUI();
        taskManager
          .submitTaskConfigUpdate(config)
          .then(() => {
            window.notificationManager.show(
              "Task configuration updated successfully",
              "success"
            );
            taskManager.loadTaskConfig();
          })
          .catch((error) => {
            console.error("Error updating task config:", error);
            window.notificationManager.show(
              `Error updating task config: ${error.message}`,
              "danger"
            );
          });
      });
    }

    const resetTasksBtn = document.getElementById("resetTasksBtn");
    if (resetTasksBtn) {
      resetTasksBtn.addEventListener("mousedown", async (e) => {
        if (e.button !== 0) return;
        try {
          showLoadingOverlay();
          const response = await fetch("/api/background_tasks/reset", {
            method: "POST",
          });

          hideLoadingOverlay();

          if (!response.ok) throw new Error("Failed to reset tasks");

          const result = await response.json();
          window.notificationManager.show(result.message, "success");
          taskManager.loadTaskConfig();
        } catch (error) {
          hideLoadingOverlay();
          console.error("Error resetting tasks:", error);
          window.notificationManager.show("Failed to reset tasks", "danger");
        }
      });
    }

    if (confirmPauseBtn) {
      confirmPauseBtn.addEventListener("mousedown", async (e) => {
        if (e.button !== 0) return;
        const duration = document.getElementById("pauseDuration")?.value || 60;
        try {
          showLoadingOverlay();
          const response = await fetch("/api/background_tasks/pause", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ duration: parseInt(duration, 10) }),
          });

          hideLoadingOverlay();

          if (!response.ok) throw new Error("Failed to pause tasks");

          window.notificationManager.show(
            `Tasks paused for ${duration} minutes`,
            "success"
          );

          // Close the modal
          const modal = bootstrap.Modal.getInstance(
            document.getElementById("pauseModal")
          );
          if (modal) modal.hide();

          taskManager.loadTaskConfig();
        } catch (error) {
          hideLoadingOverlay();
          console.error("Error pausing tasks:", error);
          window.notificationManager.show("Failed to pause tasks", "danger");
        }
      });
    }

    if (resumeBtn) {
      resumeBtn.addEventListener("mousedown", async (e) => {
        if (e.button !== 0) return;
        try {
          showLoadingOverlay();
          const response = await fetch("/api/background_tasks/resume", {
            method: "POST",
          });

          hideLoadingOverlay();

          if (!response.ok) throw new Error("Failed to resume tasks");

          window.notificationManager.show("Tasks resumed", "success");
          taskManager.loadTaskConfig();
        } catch (error) {
          hideLoadingOverlay();
          console.error("Error resuming tasks:", error);
          window.notificationManager.show("Failed to resume tasks", "danger");
        }
      });
    }

    if (stopAllBtn) {
      stopAllBtn.addEventListener("mousedown", async (e) => {
        if (e.button !== 0) return;
        try {
          showLoadingOverlay();
          const response = await fetch("/api/background_tasks/stop", {
            method: "POST",
          });

          hideLoadingOverlay();

          if (!response.ok) throw new Error("Failed to stop tasks");

          window.notificationManager.show("All running tasks stopped", "success");
          taskManager.loadTaskConfig();
        } catch (error) {
          hideLoadingOverlay();
          console.error("Error stopping tasks:", error);
          window.notificationManager.show("Failed to stop tasks", "danger");
        }
      });
    }

    if (enableAllBtn) {
      enableAllBtn.addEventListener("mousedown", async (e) => {
        if (e.button !== 0) return;
        try {
          showLoadingOverlay();
          const response = await fetch("/api/background_tasks/enable", {
            method: "POST",
          });

          hideLoadingOverlay();

          if (!response.ok) throw new Error("Failed to enable all tasks");

          window.notificationManager.show("All tasks enabled", "success");
          taskManager.loadTaskConfig();
        } catch (error) {
          hideLoadingOverlay();
          console.error("Error enabling tasks:", error);
          window.notificationManager.show("Failed to enable tasks", "danger");
        }
      });
    }

    if (disableAllBtn) {
      disableAllBtn.addEventListener("mousedown", async (e) => {
        if (e.button !== 0) return;
        try {
          showLoadingOverlay();
          const response = await fetch("/api/background_tasks/disable", {
            method: "POST",
          });

          hideLoadingOverlay();

          if (!response.ok) throw new Error("Failed to disable all tasks");

          window.notificationManager.show("All tasks disabled", "success");
          taskManager.loadTaskConfig();
        } catch (error) {
          hideLoadingOverlay();
          console.error("Error disabling tasks:", error);
          window.notificationManager.show("Failed to disable tasks", "danger");
        }
      });
    }

    if (manualRunAllBtn) {
      manualRunAllBtn.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        taskManager.runTask("ALL");
      });
    }

    if (globalSwitch) {
      globalSwitch.addEventListener("change", () => {
        const config = taskManager.gatherTaskConfigFromUI();
        taskManager
          .submitTaskConfigUpdate(config)
          .then(() =>
            window.notificationManager.show("Global disable toggled", "success")
          )
          .catch(() =>
            window.notificationManager.show("Failed to toggle global disable", "danger")
          );
      });
    }

    if (clearHistoryBtn) {
      clearHistoryBtn.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        const modal = new bootstrap.Modal(document.getElementById("clearHistoryModal"));
        modal.show();
      });
    }

    const confirmClearHistory = document.getElementById("confirmClearHistory");
    if (confirmClearHistory) {
      confirmClearHistory.addEventListener("mousedown", async (e) => {
        if (e.button !== 0) return;
        await taskManager.clearTaskHistory();
        const modal = bootstrap.Modal.getInstance(
          document.getElementById("clearHistoryModal")
        );
        modal.hide();
      });
    }

    document
      .querySelector("#taskConfigTable tbody")
      .addEventListener("mousedown", (e) => {
        const detailsBtn = e.target.closest(".view-details-btn");
        const runBtn = e.target.closest(".run-now-btn");
        const forceBtn = e.target.closest(".force-stop-btn");
        if (detailsBtn) {
          const { taskId } = detailsBtn.dataset;
          taskManager.showTaskDetails(taskId);
        } else if (runBtn) {
          const { taskId } = runBtn.dataset;
          taskManager.runTask(taskId);
        } else if (forceBtn) {
          const { taskId } = forceBtn.dataset;
          taskManager.forceStopTask(taskId);
        }
      });

    const taskDetailsModal = document.getElementById("taskDetailsModal");
    if (taskDetailsModal) {
      taskDetailsModal
        .querySelector(".run-task-btn")
        .addEventListener("mousedown", async (e) => {
          const { taskId } = e.target.dataset;
          if (taskId) {
            await taskManager.runTask(taskId);
            bootstrap.Modal.getInstance(taskDetailsModal).hide();
          }
        });
    }
  }

  function setupManualFetchTripsForm() {
    const form = document.getElementById("manualFetchTripsForm");
    if (!form) return;

    const startInput = document.getElementById("manual-fetch-start");
    const endInput = document.getElementById("manual-fetch-end");
    const mapMatchInput = document.getElementById("manual-fetch-map-match");
    const statusEl = document.getElementById("manual-fetch-status");

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!window.taskManager) return;

      const startValue = startInput?.value;
      const endValue = endInput?.value;

      if (statusEl) statusEl.textContent = "";

      if (!startValue || !endValue) {
        if (statusEl) statusEl.textContent = "Please select both start and end dates.";
        return;
      }

      // Inputs are type="datetime-local" (e.g., 2025-10-30T13:34),
      // so parse using native Date which treats them as local time
      const startDate = new Date(startValue);
      const endDate = new Date(endValue);

      if (
        !startDate ||
        !endDate ||
        Number.isNaN(startDate.getTime()) ||
        Number.isNaN(endDate.getTime())
      ) {
        if (statusEl) statusEl.textContent = "Invalid date selection.";
        return;
      }

      if (endDate.getTime() <= startDate.getTime()) {
        if (statusEl) statusEl.textContent = "End date must be after the start date.";
        return;
      }

      const mapMatchEnabled = Boolean(mapMatchInput?.checked);

      try {
        if (statusEl) statusEl.textContent = "Scheduling fetch...";
        await window.taskManager.scheduleManualFetch(
          startDate.toISOString(),
          endDate.toISOString(),
          mapMatchEnabled
        );
        if (statusEl) statusEl.textContent = "Fetch scheduled successfully.";
      } catch (error) {
        if (statusEl) statusEl.textContent = `Error: ${error.message}`;
      }
    });
  }

  function setupGeocodeTrips() {
    const geocodeType = document.getElementById("geocode-type");
    const dateRangeDiv = document.getElementById("geocode-date-range");
    const intervalDiv = document.getElementById("geocode-interval");
    const geocodeBtn = document.getElementById("geocode-trips-btn");
    const progressPanel = document.getElementById("geocode-progress-panel");
    const progressBar = document.getElementById("geocode-progress-bar");
    const progressMessage = document.getElementById("geocode-progress-message");
    const progressMetrics = document.getElementById("geocode-progress-metrics");
    const statusEl = document.getElementById("geocode-trips-status");

    if (!geocodeType || !geocodeBtn) return;

    // Handle method selection
    geocodeType.addEventListener("change", function () {
      const method = this.value;
      if (method === "date") {
        dateRangeDiv.style.display = "block";
        intervalDiv.style.display = "none";
      } else if (method === "interval") {
        dateRangeDiv.style.display = "none";
        intervalDiv.style.display = "block";
      } else {
        dateRangeDiv.style.display = "none";
        intervalDiv.style.display = "none";
      }
    });

    // Handle button click
    geocodeBtn.addEventListener("mousedown", async (e) => {
      if (e.button !== 0) return;

      const method = geocodeType.value;
      let start_date = "";
      let end_date = "";
      let interval_days = 0;

      if (method === "date") {
        start_date = document.getElementById("geocode-start").value;
        end_date = document.getElementById("geocode-end").value;
        if (!start_date || !end_date) {
          window.notificationManager.show(
            "Please select both start and end dates",
            "danger"
          );
          return;
        }
      } else if (method === "interval") {
        interval_days = parseInt(
          document.getElementById("geocode-interval-select").value,
          10
        );
      }

      try {
        geocodeBtn.disabled = true;
        if (statusEl) {
          statusEl.textContent = "Starting geocoding...";
          statusEl.className = "mt-2 text-info";
        }
        progressPanel.style.display = "block";
        progressBar.style.width = "0%";
        progressBar.textContent = "0%";
        progressBar.setAttribute("aria-valuenow", "0");
        progressBar.classList.remove("bg-success", "bg-danger");
        progressBar.classList.add(
          "bg-primary",
          "progress-bar-animated",
          "progress-bar-striped"
        );
        progressMessage.textContent = "Initializing...";
        progressMetrics.textContent = "";

        const response = await fetch("/api/geocode_trips", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ start_date, end_date, interval_days }),
        });

        if (!response.ok) {
          throw new Error("Failed to start geocoding");
        }

        const data = await response.json();
        const taskId = data.task_id;

        // Start polling for progress
        const pollInterval = setInterval(async () => {
          try {
            const progressResponse = await fetch(
              `/api/geocode_trips/progress/${taskId}`
            );
            if (!progressResponse.ok) {
              clearInterval(pollInterval);
              geocodeBtn.disabled = false;
              const errorMessage =
                progressResponse.status === 404
                  ? "Geocoding task not found."
                  : "Unable to retrieve geocoding progress.";
              if (statusEl) {
                statusEl.textContent = errorMessage;
                statusEl.className = "mt-2 text-danger";
              }
              window.notificationManager?.show(errorMessage, "danger");
              return;
            }

            const progressData = await progressResponse.json();
            const progress = progressData.progress || 0;
            const stage = progressData.stage || "unknown";
            const message = progressData.message || "";
            const metrics = progressData.metrics || {};

            // Update progress bar
            progressBar.style.width = `${progress}%`;
            progressBar.textContent = `${progress}%`;
            progressBar.setAttribute("aria-valuenow", progress);

            // Update message
            progressMessage.textContent = message;

            // Update metrics
            if (metrics.total > 0) {
              progressMetrics.textContent = `Total: ${metrics.total} | Updated: ${metrics.updated || 0} | Skipped: ${metrics.skipped || 0} | Failed: ${metrics.failed || 0}`;
            }

            // Check if completed
            if (stage === "completed" || stage === "error") {
              clearInterval(pollInterval);
              geocodeBtn.disabled = false;

              if (stage === "completed") {
                progressBar.classList.remove(
                  "progress-bar-animated",
                  "progress-bar-striped",
                  "bg-primary",
                  "bg-danger"
                );
                progressBar.classList.add("bg-success");
                if (statusEl) {
                  statusEl.textContent = `Geocoding completed: ${metrics.updated || 0} updated, ${metrics.skipped || 0} skipped`;
                  statusEl.className = "mt-2 text-success";
                }
                window.notificationManager.show(
                  `Geocoding completed: ${metrics.updated || 0} updated, ${metrics.skipped || 0} skipped`,
                  "success"
                );
              } else {
                progressBar.classList.remove(
                  "progress-bar-animated",
                  "progress-bar-striped",
                  "bg-primary",
                  "bg-success"
                );
                progressBar.classList.add("bg-danger");
                if (statusEl) {
                  statusEl.textContent = `Error: ${progressData.error || "Unknown error"}`;
                  statusEl.className = "mt-2 text-danger";
                }
                window.notificationManager.show(
                  `Geocoding failed: ${progressData.error || "Unknown error"}`,
                  "danger"
                );
              }
            }
          } catch (pollErr) {
            console.error("Error polling progress:", pollErr);
            clearInterval(pollInterval);
            geocodeBtn.disabled = false;
            if (statusEl) {
              statusEl.textContent = "Lost connection while monitoring progress.";
              statusEl.className = "mt-2 text-warning";
            }
            window.notificationManager?.show(
              "Lost connection while monitoring geocoding progress",
              "warning"
            );
          }
        }, 1000); // Poll every second
      } catch (err) {
        console.error("Error starting geocoding:", err);
        geocodeBtn.disabled = false;
        if (statusEl) {
          statusEl.textContent = "Error starting geocoding. See console.";
          statusEl.className = "mt-2 text-danger";
        }
        window.notificationManager.show("Failed to start geocoding", "danger");
      }
    });

    // Initialize date pickers
    if (window.DateUtils?.initDatePicker) {
      window.DateUtils.initDatePicker(".datepicker");
    } else {
      flatpickr(".datepicker", {
        enableTime: false,
        dateFormat: "Y-m-d",
      });
    }
  }

  function setupRemapMatchedTrips() {
    const remapType = document.getElementById("remap-type");
    const dateRangeDiv = document.getElementById("remap-date-range");
    const intervalDiv = document.getElementById("remap-interval");
    if (!remapType || !dateRangeDiv || !intervalDiv) return;

    remapType.addEventListener("change", function () {
      dateRangeDiv.style.display = this.value === "date" ? "block" : "none";
      intervalDiv.style.display = this.value === "date" ? "none" : "block";
    });

    const remapBtn = document.getElementById("remap-btn");
    if (!remapBtn) return;

    remapBtn.addEventListener("mousedown", async (e) => {
      if (e.button !== 0) return;
      const method = remapType.value;
      let start_date,
        end_date,
        interval_days = 0;

      if (method === "date") {
        start_date = document.getElementById("remap-start").value;
        end_date = document.getElementById("remap-end").value;
        if (!start_date || !end_date) {
          window.notificationManager.show(
            "Please select both start and end dates",
            "danger"
          );
          return;
        }
      } else {
        interval_days = parseInt(
          document.getElementById("remap-interval-select").value,
          10
        );
        const startDateObj = new Date();
        startDateObj.setDate(startDateObj.getDate() - interval_days);
        start_date = window.DateUtils.formatDateToString(startDateObj);
        end_date = window.DateUtils.formatDateToString(new Date());
      }

      try {
        showLoadingOverlay();
        document.getElementById("remap-status").textContent = "Remapping trips...";

        const response = await fetch("/api/matched_trips/remap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ start_date, end_date, interval_days }),
        });

        hideLoadingOverlay();

        const data = await response.json();

        document.getElementById("remap-status").textContent = data.message;
        window.notificationManager.show(data.message, "success");
      } catch (error) {
        hideLoadingOverlay();
        console.error("Error re-matching trips:", error);
        document.getElementById("remap-status").textContent =
          "Error re-matching trips.";
        window.notificationManager.show("Failed to re-match trips", "danger");
      }
    });

    if (window.DateUtils?.initDatePicker) {
      window.DateUtils.initDatePicker(".datepicker");
    } else {
      flatpickr(".datepicker", {
        enableTime: false,
        dateFormat: "Y-m-d",
      });
    }
  }

  // Mobile-specific functions
  function setupMobileUI() {
    // Check if mobile container exists
    const mobileContainer = document.querySelector(".settings-mobile-container");
    if (!mobileContainer) return;

    setupMobileAccordions();
    setupMobileTaskList();
    setupMobileHistoryList();
    setupMobileGlobalControls();
    setupMobileManualFetch();
    setupMobileDataManagement();
    setupMobileSaveFAB();
  }

  function setupMobileAccordions() {
    const headers = document.querySelectorAll(".mobile-settings-section-header");

    headers.forEach((header) => {
      header.addEventListener("click", function () {
        const content = this.nextElementSibling;
        const isExpanded = this.classList.contains("expanded");

        if (isExpanded) {
          this.classList.remove("expanded");
          content.classList.remove("expanded");
        } else {
          this.classList.add("expanded");
          content.classList.add("expanded");
        }
      });
    });
  }

  function setupMobileTaskList() {
    // This will be updated whenever desktop task list updates
    // Hook into the existing updateTaskConfigTable function
    const originalUpdate = window.taskManager?.updateTaskConfigTable;
    if (!originalUpdate) return;

    window.taskManager.updateTaskConfigTable = function (config) {
      originalUpdate.call(this, config);
      updateMobileTaskList(config);
    };
  }

  function updateMobileTaskList(config) {
    const mobileList = document.getElementById("mobile-task-list");
    if (!mobileList) return;

    mobileList.innerHTML = "";

    Object.entries(config.tasks).forEach(([taskId, task]) => {
      if (!task.display_name) return;

      const isManualOnly = Boolean(task.manual_only);
      const taskStatus = task.status || "IDLE";

      const card = document.createElement("div");
      card.className = "mobile-task-card";
      card.dataset.taskId = taskId;

      const statusClass = taskStatus.toLowerCase();

      card.innerHTML = `
        <div class="mobile-task-card-header">
          <div class="mobile-task-name">${task.display_name || taskId}</div>
          <div class="mobile-task-id">${taskId}</div>
          <div class="mobile-task-badges">
            ${isManualOnly ? '<span class="mobile-task-badge manual">Manual</span>' : ""}
            <span class="mobile-task-badge status ${statusClass}">${taskStatus}</span>
          </div>
        </div>
        <div class="mobile-task-card-body">
          <div class="mobile-task-info-grid">
            ${
              !isManualOnly
                ? `
            <div class="mobile-task-info-item">
              <span class="mobile-task-info-label">Interval</span>
              <div class="mobile-task-info-value">
                <select class="mobile-interval-select" data-task-id="${taskId}">
                  ${window.taskManager.intervalOptions
                    .map(
                      (opt) => `
                    <option value="${opt.value}" ${opt.value === task.interval_minutes ? "selected" : ""}>
                      ${opt.label}
                    </option>
                  `
                    )
                    .join("")}
                </select>
              </div>
            </div>
            <div class="mobile-task-info-item">
              <span class="mobile-task-info-label">Enabled</span>
              <div class="mobile-task-info-value">
                <input type="checkbox" class="mobile-switch mobile-task-enabled" 
                  data-task-id="${taskId}" ${task.enabled ? "checked" : ""} />
              </div>
            </div>
            `
                : `
            <div class="mobile-task-info-item">
              <span class="mobile-task-info-label">Trigger</span>
              <div class="mobile-task-info-value">Manual Only</div>
            </div>
            <div class="mobile-task-info-item">
              <span class="mobile-task-info-label">Status</span>
              <div class="mobile-task-info-value">Always Enabled</div>
            </div>
            `
            }
            <div class="mobile-task-info-item">
              <span class="mobile-task-info-label">Priority</span>
              <div class="mobile-task-info-value">${task.priority || "MEDIUM"}</div>
            </div>
            <div class="mobile-task-info-item">
              <span class="mobile-task-info-label">Last Run</span>
              <div class="mobile-task-info-value">${task.last_run ? TaskManager.formatDateTime(task.last_run) : "Never"}</div>
            </div>
            <div class="mobile-task-info-item full-width">
              <span class="mobile-task-info-label">Next Run</span>
              <div class="mobile-task-info-value">${task.next_run ? TaskManager.formatDateTime(task.next_run) : "Not scheduled"}</div>
            </div>
          </div>
          <div class="mobile-task-actions">
            <button class="btn btn-info btn-sm mobile-run-task" data-task-id="${taskId}"
              ${isManualOnly || taskStatus === "RUNNING" ? "disabled" : ""}>
              <i class="fas fa-play"></i> Run
            </button>
            <button class="btn btn-warning btn-sm mobile-stop-task" data-task-id="${taskId}"
              ${["RUNNING", "PENDING"].includes(taskStatus) ? "" : "disabled"}>
              <i class="fas fa-stop-circle"></i> Stop
            </button>
            <button class="btn btn-primary btn-sm mobile-view-task" data-task-id="${taskId}">
              <i class="fas fa-info-circle"></i> Details
            </button>
          </div>
        </div>
      `;

      mobileList.appendChild(card);
    });

    // Attach event listeners
    mobileList.querySelectorAll(".mobile-run-task").forEach((btn) => {
      btn.addEventListener("click", function () {
        const { taskId } = this.dataset;
        window.taskManager?.runTask(taskId);
      });
    });

    mobileList.querySelectorAll(".mobile-stop-task").forEach((btn) => {
      btn.addEventListener("click", function () {
        const { taskId } = this.dataset;
        window.taskManager?.forceStopTask(taskId);
      });
    });

    mobileList.querySelectorAll(".mobile-view-task").forEach((btn) => {
      btn.addEventListener("click", function () {
        const { taskId } = this.dataset;
        window.taskManager?.showTaskDetails(taskId);
      });
    });
  }

  function setupMobileHistoryList() {
    const originalUpdate = window.taskManager?.updateTaskHistoryTable;
    if (!originalUpdate) return;

    window.taskManager.updateTaskHistoryTable = function (history) {
      originalUpdate.call(this, history);
      updateMobileHistoryList(history);
    };
  }

  function updateMobileHistoryList(history) {
    const mobileList = document.getElementById("mobile-history-list");
    if (!mobileList) return;

    mobileList.innerHTML = "";

    if (history.length === 0) {
      mobileList.innerHTML = `
        <div class="mobile-empty-state">
          <i class="fas fa-inbox"></i>
          <div class="mobile-empty-state-title">No History</div>
          <div class="mobile-empty-state-text">Task execution history will appear here</div>
        </div>
      `;
      return;
    }

    history.forEach((entry) => {
      const card = document.createElement("div");
      card.className = "mobile-history-card";

      let durationText = "Unknown";
      if (entry.runtime !== null && entry.runtime !== undefined) {
        const runtimeMs = parseFloat(entry.runtime);
        if (!Number.isNaN(runtimeMs)) {
          durationText = window.taskManager.formatDuration(runtimeMs);
        }
      } else if (entry.status === "RUNNING" && entry.timestamp) {
        // Calculate elapsed time for running tasks
        try {
          const startTime = new Date(entry.timestamp);
          const now = new Date();
          const elapsedMs = now - startTime;
          if (!Number.isNaN(elapsedMs) && elapsedMs >= 0) {
            durationText = window.taskManager.formatDuration(elapsedMs);
            // Store the timestamp for real-time updates
            card.dataset.startTime = entry.timestamp;
            card.dataset.isRunning = "true";
          }
        } catch (e) {
          console.error("Error calculating elapsed time:", e);
        }
      }

      let resultText = "N/A";
      if (entry.status === "RUNNING") {
        resultText = "Running";
      } else if (entry.status === "COMPLETED") {
        resultText = entry.result ? "Success" : "Completed";
      } else if (entry.status === "FAILED") {
        resultText = "Failed";
      } else {
        resultText = entry.result ? "Success" : "Failed";
      }

      const statusClass = window.taskManager.getStatusColor(entry.status);

      card.innerHTML = `
        <div class="mobile-history-header">
          <div>
            <div class="mobile-history-task-name">${entry.task_id}</div>
            <div class="mobile-history-time">${TaskManager.formatDateTime(entry.timestamp)}</div>
          </div>
          <span class="badge bg-${statusClass}">${entry.status}</span>
        </div>
        <div class="mobile-history-info">
          <div class="mobile-history-info-item">
            <span class="mobile-task-info-label">Duration</span>
            <span class="mobile-task-info-value task-duration">${durationText}</span>
          </div>
          <div class="mobile-history-info-item">
            <span class="mobile-task-info-label">Result</span>
            <span class="mobile-task-info-value">${resultText}</span>
          </div>
        </div>
        ${
          entry.error
            ? `
        <button class="btn btn-danger btn-sm w-100 mt-2 mobile-view-error" 
          data-error="${window.taskManager.escapeHtml(entry.error)}">
          <i class="fas fa-exclamation-circle"></i> View Error
        </button>
        `
            : ""
        }
      `;

      mobileList.appendChild(card);
    });

    // Attach error button listeners
    mobileList.querySelectorAll(".mobile-view-error").forEach((btn) => {
      btn.addEventListener("click", function () {
        const errorMessage = this.dataset.error;
        window.taskManager?.showErrorModal(errorMessage);
      });
    });

    // Update pagination
    updateMobilePagination();
  }

  function updateMobilePagination() {
    const pagination = document.getElementById("mobile-history-pagination");
    const prevBtn = document.getElementById("mobile-history-prev");
    const nextBtn = document.getElementById("mobile-history-next");
    const pageInfo = document.getElementById("mobile-history-page-info");

    if (!pagination || !window.taskManager) return;

    const { currentHistoryPage, historyTotalPages } = window.taskManager;

    if (historyTotalPages <= 1) {
      pagination.style.display = "none";
      return;
    }

    pagination.style.display = "flex";
    pageInfo.textContent = `Page ${currentHistoryPage} of ${historyTotalPages}`;

    prevBtn.disabled = currentHistoryPage === 1;
    nextBtn.disabled = currentHistoryPage === historyTotalPages;

    prevBtn.onclick = () => {
      if (window.taskManager.currentHistoryPage > 1) {
        window.taskManager.currentHistoryPage--;
        window.taskManager.updateTaskHistory();
      }
    };

    nextBtn.onclick = () => {
      if (
        window.taskManager.currentHistoryPage < window.taskManager.historyTotalPages
      ) {
        window.taskManager.currentHistoryPage++;
        window.taskManager.updateTaskHistory();
      }
    };
  }

  function setupMobileGlobalControls() {
    // Global disable switch
    const mobileGlobalSwitch = document.getElementById("mobile-globalDisableSwitch");
    const desktopGlobalSwitch = document.getElementById("globalDisableSwitch");

    if (mobileGlobalSwitch && desktopGlobalSwitch) {
      // Sync switches
      mobileGlobalSwitch.checked = desktopGlobalSwitch.checked;

      mobileGlobalSwitch.addEventListener("change", function () {
        desktopGlobalSwitch.checked = this.checked;
        desktopGlobalSwitch.dispatchEvent(new Event("change"));
      });
    }

    // Action buttons
    const actions = [
      { id: "pauseBtn", requiresModal: true },
      { id: "resumeBtn" },
      { id: "stopAllBtn" },
      { id: "resetTasksBtn" },
      { id: "enableAllBtn" },
      { id: "disableAllBtn" },
      { id: "manualRunAllBtn" },
    ];

    actions.forEach(({ id, requiresModal }) => {
      const mobileBtn = document.getElementById(`mobile-${id}`);
      const desktopBtn = document.getElementById(id);

      if (mobileBtn && desktopBtn) {
        mobileBtn.addEventListener("click", () => {
          if (requiresModal) {
            // For pause button, show modal
            const modal = document.getElementById("pauseModal");
            if (modal) {
              const bsModal = new bootstrap.Modal(modal);
              bsModal.show();
            }
          } else {
            desktopBtn.click();
          }
        });
      }
    });

    // Clear history button
    const mobileClearBtn = document.getElementById("mobile-clearHistoryBtn");
    const desktopClearBtn = document.getElementById("clearHistoryBtn");

    if (mobileClearBtn && desktopClearBtn) {
      mobileClearBtn.addEventListener("click", () => {
        const modal = new bootstrap.Modal(document.getElementById("clearHistoryModal"));
        modal.show();
      });
    }
  }

  function setupMobileManualFetch() {
    const form = document.getElementById("mobile-manualFetchTripsForm");
    if (!form) return;

    const startInput = document.getElementById("mobile-manual-fetch-start");
    const endInput = document.getElementById("mobile-manual-fetch-end");
    const mapMatchInput = document.getElementById("mobile-manual-fetch-map-match");
    const statusEl = document.getElementById("mobile-manual-fetch-status");

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!window.taskManager) return;

      const startValue = startInput?.value;
      const endValue = endInput?.value;

      if (statusEl) {
        statusEl.classList.remove("d-none", "success", "error");
        statusEl.textContent = "";
      }

      if (!startValue || !endValue) {
        if (statusEl) {
          statusEl.classList.add("error");
          statusEl.textContent = "Please select both start and end dates.";
          statusEl.classList.remove("d-none");
        }
        return;
      }

      // Inputs are type="datetime-local" (e.g., 2025-10-30T13:34),
      // so parse using native Date which treats them as local time
      const startDate = new Date(startValue);
      const endDate = new Date(endValue);

      if (
        !startDate ||
        !endDate ||
        Number.isNaN(startDate.getTime()) ||
        Number.isNaN(endDate.getTime())
      ) {
        if (statusEl) {
          statusEl.classList.add("error");
          statusEl.textContent = "Invalid date selection.";
          statusEl.classList.remove("d-none");
        }
        return;
      }

      if (endDate.getTime() <= startDate.getTime()) {
        if (statusEl) {
          statusEl.classList.add("error");
          statusEl.textContent = "End date must be after the start date.";
          statusEl.classList.remove("d-none");
        }
        return;
      }

      const mapMatchEnabled = Boolean(mapMatchInput?.checked);

      try {
        if (statusEl) {
          statusEl.classList.add("info");
          statusEl.textContent = "Scheduling fetch...";
          statusEl.classList.remove("d-none");
        }
        await window.taskManager.scheduleManualFetch(
          startDate.toISOString(),
          endDate.toISOString(),
          mapMatchEnabled
        );
        if (statusEl) {
          statusEl.classList.remove("info");
          statusEl.classList.add("success");
          statusEl.textContent = "Fetch scheduled successfully.";
        }
      } catch (error) {
        if (statusEl) {
          statusEl.classList.remove("info");
          statusEl.classList.add("error");
          statusEl.textContent = `Error: ${error.message}`;
        }
      }
    });
  }

  function setupMobileDataManagement() {
    // Unified Geocoding
    setupMobileGeocodeTrips();

    // Remap trips - method tabs (keep existing remap functionality)
    setupMobileRemapTrips();
  }

  function setupMobileGeocodeTrips() {
    // Handle method tabs
    const geocodeTabs = document.querySelectorAll(
      '.mobile-date-method-tab[data-target="geocode"]'
    );
    const geocodeDateRange = document.getElementById("mobile-geocode-date-range");
    const geocodeInterval = document.getElementById("mobile-geocode-interval");
    const geocodeBtn = document.getElementById("mobile-geocode-trips-btn");
    const progressPanel = document.getElementById("mobile-geocode-progress-panel");
    const progressBar = document.getElementById("mobile-geocode-progress-bar");
    const progressMessage = document.getElementById("mobile-geocode-progress-message");
    const progressMetrics = document.getElementById("mobile-geocode-progress-metrics");
    const statusEl = document.getElementById("mobile-geocode-trips-status");

    if (!geocodeBtn) return;

    // Handle tab clicks
    geocodeTabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        geocodeTabs.forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        const { method } = tab.dataset;

        if (method === "date") {
          geocodeDateRange.style.display = "block";
          geocodeInterval.style.display = "none";
        } else if (method === "interval") {
          geocodeDateRange.style.display = "none";
          geocodeInterval.style.display = "block";
        } else {
          geocodeDateRange.style.display = "none";
          geocodeInterval.style.display = "none";
        }
      });
    });

    // Handle button click
    geocodeBtn.addEventListener("click", async () => {
      const activeTab = document.querySelector(
        '.mobile-date-method-tab[data-target="geocode"].active'
      );
      const method = activeTab?.dataset.method || "date";
      let start_date = "";
      let end_date = "";
      let interval_days = 0;

      if (method === "date") {
        start_date = document.getElementById("mobile-geocode-start")?.value || "";
        end_date = document.getElementById("mobile-geocode-end")?.value || "";
        if (!start_date || !end_date) {
          window.notificationManager.show(
            "Please select both start and end dates",
            "danger"
          );
          return;
        }
      } else if (method === "interval") {
        interval_days = parseInt(
          document.getElementById("mobile-geocode-interval-select")?.value || "0",
          10
        );
      }

      try {
        geocodeBtn.disabled = true;
        if (statusEl) {
          statusEl.textContent = "Starting geocoding...";
          statusEl.classList.remove("d-none", "success", "error");
          statusEl.classList.add("info");
        }
        if (progressPanel) progressPanel.style.display = "block";
        if (progressBar) {
          progressBar.style.width = "0%";
          progressBar.textContent = "0%";
          progressBar.setAttribute("aria-valuenow", "0");
          progressBar.classList.remove("bg-success", "bg-danger");
          progressBar.classList.add(
            "bg-primary",
            "progress-bar-animated",
            "progress-bar-striped"
          );
        }
        if (progressMessage) progressMessage.textContent = "Initializing...";
        if (progressMetrics) progressMetrics.textContent = "";

        const response = await fetch("/api/geocode_trips", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ start_date, end_date, interval_days }),
        });

        if (!response.ok) {
          throw new Error("Failed to start geocoding");
        }

        const data = await response.json();
        const taskId = data.task_id;

        // Start polling for progress
        const pollInterval = setInterval(async () => {
          try {
            const progressResponse = await fetch(
              `/api/geocode_trips/progress/${taskId}`
            );
            if (!progressResponse.ok) {
              clearInterval(pollInterval);
              geocodeBtn.disabled = false;
              const errorMessage =
                progressResponse.status === 404
                  ? "Geocoding task not found."
                  : "Unable to retrieve geocoding progress.";
              if (statusEl) {
                statusEl.textContent = errorMessage;
                statusEl.classList.remove("info", "success");
                statusEl.classList.add("error");
              }
              window.notificationManager?.show(errorMessage, "danger");
              return;
            }

            const progressData = await progressResponse.json();
            const progress = progressData.progress || 0;
            const stage = progressData.stage || "unknown";
            const message = progressData.message || "";
            const metrics = progressData.metrics || {};

            // Update progress bar
            if (progressBar) {
              progressBar.style.width = `${progress}%`;
              progressBar.textContent = `${progress}%`;
              progressBar.setAttribute("aria-valuenow", progress);
            }

            // Update message
            if (progressMessage) progressMessage.textContent = message;

            // Update metrics
            if (progressMetrics && metrics.total > 0) {
              progressMetrics.textContent = `Total: ${metrics.total} | Updated: ${metrics.updated || 0} | Skipped: ${metrics.skipped || 0} | Failed: ${metrics.failed || 0}`;
            }

            // Check if completed
            if (stage === "completed" || stage === "error") {
              clearInterval(pollInterval);
              geocodeBtn.disabled = false;

              if (stage === "completed") {
                if (progressBar) {
                  progressBar.classList.remove(
                    "progress-bar-animated",
                    "progress-bar-striped",
                    "bg-primary",
                    "bg-danger"
                  );
                  progressBar.classList.add("bg-success");
                }
                if (statusEl) {
                  statusEl.textContent = `Geocoding completed: ${metrics.updated || 0} updated, ${metrics.skipped || 0} skipped`;
                  statusEl.classList.remove("info");
                  statusEl.classList.add("success");
                }
                window.notificationManager.show(
                  `Geocoding completed: ${metrics.updated || 0} updated, ${metrics.skipped || 0} skipped`,
                  "success"
                );
              } else {
                if (progressBar) {
                  progressBar.classList.remove(
                    "progress-bar-animated",
                    "progress-bar-striped",
                    "bg-primary",
                    "bg-success"
                  );
                  progressBar.classList.add("bg-danger");
                }
                if (statusEl) {
                  statusEl.textContent = `Error: ${progressData.error || "Unknown error"}`;
                  statusEl.classList.remove("info");
                  statusEl.classList.add("error");
                }
                window.notificationManager.show(
                  `Geocoding failed: ${progressData.error || "Unknown error"}`,
                  "danger"
                );
              }
            }
          } catch (pollErr) {
            console.error("Error polling progress:", pollErr);
            clearInterval(pollInterval);
            geocodeBtn.disabled = false;
            if (statusEl) {
              statusEl.textContent = "Lost connection while monitoring progress.";
              statusEl.classList.remove("info", "success");
              statusEl.classList.add("error");
            }
            window.notificationManager?.show(
              "Lost connection while monitoring geocoding progress",
              "warning"
            );
          }
        }, 1000); // Poll every second
      } catch (err) {
        console.error("Error starting geocoding:", err);
        geocodeBtn.disabled = false;
        if (statusEl) {
          statusEl.textContent = "Error starting geocoding. See console.";
          statusEl.classList.remove("info");
          statusEl.classList.add("error");
        }
        window.notificationManager.show("Failed to start geocoding", "danger");
      }
    });

    // Initialize date pickers
    if (window.DateUtils?.initDatePicker) {
      window.DateUtils.initDatePicker(".datepicker");
    } else {
      flatpickr(".datepicker", {
        enableTime: false,
        dateFormat: "Y-m-d",
      });
    }
  }

  function setupMobileRemapTrips() {
    // Remap trips - method tabs
    const dateTab = document.querySelector(
      '.mobile-date-method-tab[data-method="date"]'
    );
    const intervalTab = document.querySelector(
      '.mobile-date-method-tab[data-method="interval"]'
    );
    const dateRange = document.getElementById("mobile-remap-date-range");
    const intervalDiv = document.getElementById("mobile-remap-interval");

    if (dateTab && intervalTab) {
      dateTab.addEventListener("click", () => {
        dateTab.classList.add("active");
        intervalTab.classList.remove("active");
        dateRange.style.display = "block";
        intervalDiv.style.display = "none";
      });

      intervalTab.addEventListener("click", () => {
        intervalTab.classList.add("active");
        dateTab.classList.remove("active");
        dateRange.style.display = "none";
        intervalDiv.style.display = "block";
      });
    }

    // Remap button
    const remapBtn = document.getElementById("mobile-remap-btn");
    const remapStatus = document.getElementById("mobile-remap-status");

    if (remapBtn) {
      remapBtn.addEventListener("click", async () => {
        const method =
          document.querySelector(".mobile-date-method-tab.active")?.dataset.method ||
          "date";
        let start_date,
          end_date,
          interval_days = 0;

        if (method === "date") {
          start_date = document.getElementById("mobile-remap-start").value;
          end_date = document.getElementById("mobile-remap-end").value;
          if (!start_date || !end_date) {
            window.notificationManager.show(
              "Please select both start and end dates",
              "danger"
            );
            return;
          }
        } else {
          interval_days = parseInt(
            document.getElementById("mobile-remap-interval-select").value,
            10
          );
          const startDateObj = new Date();
          startDateObj.setDate(startDateObj.getDate() - interval_days);
          start_date = window.DateUtils.formatDateToString(startDateObj);
          end_date = window.DateUtils.formatDateToString(new Date());
        }

        try {
          showLoadingOverlay();
          if (remapStatus) {
            remapStatus.classList.remove("d-none", "success", "error");
            remapStatus.classList.add("info");
            remapStatus.textContent = "Remapping trips...";
          }

          const response = await fetch("/api/matched_trips/remap", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ start_date, end_date, interval_days }),
          });

          hideLoadingOverlay();
          const data = await response.json();

          if (remapStatus) {
            remapStatus.classList.remove("info");
            remapStatus.classList.add("success");
            remapStatus.textContent = data.message;
          }
          window.notificationManager.show(data.message, "success");
        } catch (error) {
          hideLoadingOverlay();
          console.error("Error re-matching trips:", error);
          if (remapStatus) {
            remapStatus.classList.remove("info");
            remapStatus.classList.add("error");
            remapStatus.textContent = "Error re-matching trips.";
          }
          window.notificationManager.show("Failed to re-match trips", "danger");
        }
      });
    }

    // Initialize datepickers for mobile
    if (window.DateUtils?.initDatePicker) {
      window.DateUtils.initDatePicker(".mobile-form-input.datepicker");
    } else {
      flatpickr(".mobile-form-input.datepicker", {
        enableTime: false,
        dateFormat: "Y-m-d",
      });
    }
  }

  function setupMobileSaveFAB() {
    const fab = document.getElementById("mobile-save-config-fab");
    if (!fab) return;

    fab.addEventListener("click", () => {
      if (!window.taskManager) return;

      // Gather mobile config
      const mobileGlobalSwitch = document.getElementById("mobile-globalDisableSwitch");
      const tasks = {};

      document.querySelectorAll(".mobile-task-card").forEach((card) => {
        const { taskId } = card.dataset;
        const intervalSelect = card.querySelector(".mobile-interval-select");
        const enabledSwitch = card.querySelector(".mobile-task-enabled");

        if (intervalSelect && enabledSwitch) {
          tasks[taskId] = {
            interval_minutes: parseInt(intervalSelect.value, 10),
            enabled: enabledSwitch.checked,
          };
        }
      });

      const config = {
        globalDisable: mobileGlobalSwitch?.checked || false,
        tasks,
      };

      // Submit config
      window.taskManager
        .submitTaskConfigUpdate(config)
        .then(() => {
          window.notificationManager.show(
            "Task configuration updated successfully",
            "success"
          );
          fab.classList.add("saved");
          setTimeout(() => fab.classList.remove("saved"), 2000);
          window.taskManager.loadTaskConfig();
        })
        .catch((error) => {
          console.error("Error updating task config:", error);
          window.notificationManager.show(
            `Error updating task config: ${error.message}`,
            "danger"
          );
        });
    });
  }

  // Initialize mobile UI on load
  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(setupMobileUI, 100);
  });
})();
