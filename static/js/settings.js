/* global showLoadingOverlay, hideLoadingOverlay, bootstrap, flatpickr, taskManager */

"use strict";

(() => {
  class TaskManager {
    constructor() {
      this.notifier = {
        show: (title, message, type = "info") => {
          if (window.notificationManager) {
            window.notificationManager.show(`${title}: ${message}`, type);
          } else {
            console.log(`${type.toUpperCase()}: ${title} - ${message}`);
          }
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

      // Set up real-time event source for task updates
      this.setupEventSource();

      // Setup polling as fallback
      this.setupPolling();
    }

    setupEventSource() {
      // Close existing event source if any
      if (this.eventSource) {
        this.eventSource.close();
      }

      try {
        this.eventSource = new EventSource("/api/background_tasks/sse");

        this.eventSource.onmessage = (event) => {
          try {
            const updates = JSON.parse(event.data);

            // Process each task update
            Object.entries(updates).forEach(([taskId, update]) => {
              const row = document.querySelector(
                `tr[data-task-id="${taskId}"]`,
              );
              if (!row) return;

              // Update status cell
              const statusCell = row.querySelector(".task-status");
              if (statusCell) {
                const currentStatus = statusCell.dataset.status;
                const newStatus = update.status;

                if (currentStatus !== newStatus) {
                  statusCell.innerHTML = this.getStatusHTML(newStatus);
                  statusCell.dataset.status = newStatus;

                  // Update run button state
                  const runButton = row.querySelector(".run-now-btn");
                  if (runButton) {
                    runButton.disabled = newStatus === "RUNNING";
                  }

                  // Handle task completion notifications
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
                      notificationType,
                    );
                  }
                }
              }

              // Update last run time
              const lastRunCell = row.querySelector(".task-last-run");
              if (lastRunCell && update.last_run) {
                lastRunCell.textContent = this.formatDateTime(update.last_run);
              }

              // Update next run time
              const nextRunCell = row.querySelector(".task-next-run");
              if (nextRunCell && update.next_run) {
                nextRunCell.textContent = this.formatDateTime(update.next_run);
              }
            });

            // Update active tasks map based on latest data
            this.updateActiveTasksMapFromUpdates(updates);
          } catch (error) {
            console.error("Error processing SSE update:", error);
          }
        };

        this.eventSource.onerror = (error) => {
          console.error("SSE connection error:", error);
          // Try to reconnect after delay
          setTimeout(() => this.setupEventSource(), 5000);
        };
      } catch (error) {
        console.error("Error setting up EventSource:", error);
        // If EventSource fails, rely on polling
        this.setupPolling();
      }
    }

    updateActiveTasksMapFromUpdates(updates) {
      const runningTasks = new Set();

      // Add tasks that are currently running
      for (const [taskId, taskData] of Object.entries(updates)) {
        if (taskData.status === "RUNNING") {
          runningTasks.add(taskId);
          // Track when task started running
          if (!this.activeTasksMap.has(taskId)) {
            this.activeTasksMap.set(taskId, {
              status: "RUNNING",
              startTime: new Date(),
            });

            // Notify about task start
            const row = document.querySelector(`tr[data-task-id="${taskId}"]`);
            if (row) {
              const displayName =
                row.querySelector(".task-name-display")?.textContent || taskId;
              this.notifier.show(
                "Task Started",
                `Task ${displayName} is now running`,
                "info",
              );
            }
          }
        }
      }

      // Check for tasks that have finished
      for (const [taskId, taskState] of this.activeTasksMap.entries()) {
        if (!runningTasks.has(taskId) && updates[taskId]) {
          const taskStatus = updates[taskId].status;
          if (taskStatus !== "RUNNING") {
            // Don't notify if task wasn't previously known to be running
            if (taskState.status === "RUNNING") {
              // Notify about task completion
              const row = document.querySelector(
                `tr[data-task-id="${taskId}"]`,
              );
              if (row) {
                const displayName =
                  row.querySelector(".task-name-display")?.textContent ||
                  taskId;
                if (taskStatus === "COMPLETED" || taskStatus === "FAILED") {
                  const type =
                    taskStatus === "COMPLETED" ? "success" : "danger";
                  const runTime = Math.round(
                    (new Date() - taskState.startTime) / 1000,
                  );
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
      // Clear any existing interval
      if (this.pollingInterval) {
        clearInterval(this.pollingInterval);
      }

      // Poll less frequently when we have EventSource
      const pollInterval =
        this.eventSource && this.eventSource.readyState === EventSource.OPEN
          ? 15000
          : 5000;

      // Polling as backup
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

        // Update active tasks map based on current config
        this.updateActiveTasksMap(config);

        await this.updateTaskHistory();
      } catch (error) {
        console.error("Error loading task configuration:", error);
        this.notifier.show(
          "Error",
          "Failed to load task configuration: " + error.message,
          "danger",
        );
      }
    }

    // Enhanced active task tracking
    updateActiveTasksMap(config) {
      // Build a set of currently running tasks from latest config
      const runningTasks = new Set();

      for (const [taskId, taskConfig] of Object.entries(config.tasks)) {
        if (taskConfig.status === "RUNNING") {
          runningTasks.add(taskId);
          // Add newly running tasks with timestamp
          if (!this.activeTasksMap.has(taskId)) {
            this.activeTasksMap.set(taskId, {
              status: "RUNNING",
              startTime: new Date(),
            });
          }
        }
      }

      // Check for tasks that have recently finished
      const recentlyFinished = [];
      for (const [taskId, taskState] of this.activeTasksMap.entries()) {
        if (!runningTasks.has(taskId)) {
          recentlyFinished.push(taskId);
        }
      }

      // Remove finished tasks
      for (const taskId of recentlyFinished) {
        const displayName = config.tasks[taskId]?.display_name || taskId;
        const status = config.tasks[taskId]?.status || "COMPLETED";

        // Only notify on transitions from RUNNING to COMPLETED/FAILED
        if (
          this.activeTasksMap.get(taskId).status === "RUNNING" &&
          (status === "COMPLETED" || status === "FAILED")
        ) {
          const type = status === "COMPLETED" ? "success" : "danger";
          const runTime = Math.round(
            (new Date() - this.activeTasksMap.get(taskId).startTime) / 1000,
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

        // Skip if task has no display_name (likely not a proper task)
        if (!task.display_name) return;

        row.innerHTML = `
            <td>
              <span class="task-name-display">${
                task.display_name || taskId
              }</span>
              <span class="text-muted small d-block">${taskId}</span>
            </td>
            <td>
              <select class="form-select form-select-sm" data-task-id="${taskId}">
                ${this.intervalOptions
                  .map(
                    (opt) => `
                  <option value="${opt.value}" ${
                    opt.value === task.interval_minutes ? "selected" : ""
                  }>
                    ${opt.label}
                  </option>
                `,
                  )
                  .join("")}
              </select>
            </td>
            <td>
              <div class="form-check form-switch">
                <input class="form-check-input" type="checkbox"
                  id="enable-${taskId}" ${task.enabled ? "checked" : ""}
                  data-task-id="${taskId}">
              </div>
            </td>
            <td>${task.priority || "MEDIUM"}</td>
            <td class="task-status" data-status="${
              task.status || "IDLE"
            }">${this.getStatusHTML(task.status || "IDLE")}</td>
            <td class="task-last-run">${
              task.last_run ? this.formatDateTime(task.last_run) : "Never"
            }</td>
            <td class="task-next-run">${
              task.next_run
                ? this.formatDateTime(task.next_run)
                : "Not scheduled"
            }</td>
            <td>
              <div class="btn-group btn-group-sm">
                <button class="btn btn-info run-now-btn" data-task-id="${taskId}"
                  ${task.status === "RUNNING" ? "disabled" : ""} 
                  title="Run task now">
                  <i class="fas fa-play"></i>
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
          `/api/background_tasks/history?page=${this.currentHistoryPage}&limit=${this.historyLimit}`,
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
          "Failed to update task history: " + error.message,
          "danger",
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

        // Handle duration properly - runtime should be in milliseconds
        let durationText = "Unknown";
        if (entry.runtime !== null && entry.runtime !== undefined) {
          // Handle numbers and strings
          const runtimeMs = parseFloat(entry.runtime);
          if (!isNaN(runtimeMs)) {
            durationText = this.formatDuration(runtimeMs);
          }
        }

        // Better details content based on status
        let detailsContent = "N/A";
        if (entry.error) {
          detailsContent = `<button class="btn btn-sm btn-danger view-error-btn"
                    data-error="${this.escapeHtml(entry.error)}">
                    <i class="fas fa-exclamation-circle"></i> View Error
                  </button>`;
        } else if (entry.status === "COMPLETED") {
          detailsContent = `<span class="text-success"><i class="fas fa-check-circle"></i> Completed successfully</span>`;
        } else if (entry.status === "RUNNING") {
          detailsContent = `<span class="text-info"><i class="fas fa-spinner fa-spin"></i> In progress</span>`;
        } else if (entry.status === "FAILED") {
          detailsContent = `<span class="text-danger"><i class="fas fa-times-circle"></i> Failed</span>`;
        }

        row.innerHTML = `
            <td>${entry.task_id}</td>
            <td>
              <span class="badge bg-${this.getStatusColor(entry.status)}">
                ${entry.status}
              </span>
            </td>
            <td>${this.formatDateTime(entry.timestamp)}</td>
            <td>${durationText}</td>
            <td>${entry.result ? "Success" : "Failed"}</td>
            <td>${detailsContent}</td>
          `;
        tbody.appendChild(row);
      });

      // Add event listeners for error buttons
      const errorButtons = tbody.querySelectorAll(".view-error-btn");
      errorButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
          const errorMessage = btn.dataset.error;
          this.showErrorModal(errorMessage);
        });
      });
    }

    // Escape HTML for security
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
      // Create modal if it doesn't exist
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

      // Set error content
      const errorContent = modal.querySelector(".error-details");
      errorContent.textContent = errorMessage;

      // Show modal
      const bsModal = new bootstrap.Modal(modal);
      bsModal.show();
    }

    updateHistoryPagination() {
      const paginationContainer = document.querySelector(
        "#taskHistoryPagination",
      );
      if (!paginationContainer) return;

      paginationContainer.innerHTML = "";

      if (this.historyTotalPages <= 1) return;

      const pagination = document.createElement("ul");
      pagination.className = "pagination justify-content-center";

      // Previous button
      const prevLi = document.createElement("li");
      prevLi.className = `page-item ${
        this.currentHistoryPage === 1 ? "disabled" : ""
      }`;
      prevLi.innerHTML = `<a class="page-link" href="#" data-page="${
        this.currentHistoryPage - 1
      }">Previous</a>`;
      pagination.appendChild(prevLi);

      // Page numbers (show up to 5 pages with current page in the middle)
      const startPage = Math.max(1, this.currentHistoryPage - 2);
      const endPage = Math.min(this.historyTotalPages, startPage + 4);

      for (let i = startPage; i <= endPage; i++) {
        const pageLi = document.createElement("li");
        pageLi.className = `page-item ${
          i === this.currentHistoryPage ? "active" : ""
        }`;
        pageLi.innerHTML = `<a class="page-link" href="#" data-page="${i}">${i}</a>`;
        pagination.appendChild(pageLi);
      }

      // Next button
      const nextLi = document.createElement("li");
      nextLi.className = `page-item ${
        this.currentHistoryPage === this.historyTotalPages ? "disabled" : ""
      }`;
      nextLi.innerHTML = `<a class="page-link" href="#" data-page="${
        this.currentHistoryPage + 1
      }">Next</a>`;
      pagination.appendChild(nextLi);

      paginationContainer.appendChild(pagination);

      // Add event listeners to pagination links
      const pageLinks = paginationContainer.querySelectorAll(".page-link");
      pageLinks.forEach((link) => {
        link.addEventListener("click", (e) => {
          e.preventDefault();
          const page = parseInt(e.target.dataset.page, 10);
          if (page && page !== this.currentHistoryPage) {
            this.currentHistoryPage = page;
            this.updateTaskHistory();
          }
        });
      });
    }

    getStatusHTML(status) {
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

    getStatusColor(status) {
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
        // Show loading overlay while starting task
        showLoadingOverlay();

        const response = await fetch("/api/background_tasks/manual_run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tasks: [taskId] }),
        });

        // Get the result regardless of response status
        const result = await response.json();

        // Hide loading overlay
        hideLoadingOverlay();

        if (!response.ok) {
          // API returned an error
          throw new Error(result.detail || "Failed to start task");
        }

        // Handle successful API call but potential dependency issues
        if (result.status === "success") {
          // Check for detailed results from specific tasks
          if (result.results && result.results.length > 0) {
            const taskResult = result.results.find((r) => r.task === taskId);

            if (taskResult && !taskResult.success) {
              // Task couldn't start, likely a dependency issue
              this.showDependencyErrorModal(taskId, taskResult.message);
              return false;
            }
          }

          // If we get here, task started successfully
          this.activeTasksMap.set(taskId, {
            status: "RUNNING",
            startTime: new Date(),
          });

          this.notifier.show(
            "Task Started",
            `Task ${taskId} has been started`,
            "info",
          );

          // Update UI to show running status
          const row = document.querySelector(`tr[data-task-id="${taskId}"]`);
          if (row) {
            const statusCell = row.querySelector(".task-status");
            if (statusCell) {
              statusCell.innerHTML = this.getStatusHTML("RUNNING");
              statusCell.dataset.status = "RUNNING";
            }

            const runButton = row.querySelector(".run-now-btn");
            if (runButton) {
              runButton.disabled = true;
            }
          }

          // Load the config once immediately after starting
          await this.loadTaskConfig();

          return true;
        } else {
          throw new Error(result.message || "Failed to start task");
        }
      } catch (error) {
        console.error(`Error running task ${taskId}:`, error);
        hideLoadingOverlay();
        this.notifier.show(
          "Error",
          `Failed to start task ${taskId}: ${error.message}`,
          "danger",
        );
        return false;
      }
    }

    formatDateTime(date) {
      if (!date) return "";
      try {
        return new Date(date).toLocaleString();
      } catch (e) {
        return date;
      }
    }

    formatDuration(ms) {
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);

      if (isNaN(seconds)) return "Unknown";

      return hours > 0
        ? `${hours}h ${minutes % 60}m ${seconds % 60}s`
        : minutes > 0
          ? `${minutes}m ${seconds % 60}s`
          : `${seconds}s`;
    }

    gatherTaskConfigFromUI() {
      const tasks = {};
      document.querySelectorAll("#taskConfigTable tbody tr").forEach((row) => {
        const taskId = row.dataset.taskId;
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
        tasks: tasks,
      };
    }

    async submitTaskConfigUpdate(config) {
      // Show loading overlay while saving config
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
        // Show loading overlay while fetching details
        showLoadingOverlay();

        // First get the task metadata
        const taskResponse = await fetch(
          `/api/background_tasks/task/${taskId}`,
        );
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
              <p>${this.getStatusHTML(taskDetails.status || "IDLE")}</p>
            </div>
            <div class="mb-3">
              <h6>Interval</h6>
              <p>${
                this.intervalOptions.find(
                  (opt) => opt.value === taskDetails.interval_minutes,
                )?.label || taskDetails.interval_minutes + " minutes"
              }</p>
            </div>
            <div class="mb-3">
              <h6>Priority</h6>
              <p>${taskDetails.priority || "MEDIUM"}</p>
            </div>
            <div class="mb-3">
              <h6>Dependencies</h6>
              ${
                taskDetails.dependencies && taskDetails.dependencies.length > 0
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
                  ? this.formatDateTime(taskDetails.last_run)
                  : "Never"
              }</p>
            </div>
            <div class="mb-3">
              <h6>Next Run</h6>
              <p>${
                taskDetails.next_run
                  ? this.formatDateTime(taskDetails.next_run)
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
                taskDetails.last_error,
              )}</pre>
            </div>`
                : ""
            }
            ${
              taskDetails.history && taskDetails.history.length > 0
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
                      <td>${this.formatDateTime(entry.timestamp)}</td>
                      <td><span class="badge bg-${this.getStatusColor(
                        entry.status,
                      )}">${entry.status}</span></td>
                      <td>${
                        entry.runtime
                          ? this.formatDuration(entry.runtime)
                          : "N/A"
                      }</td>
                    </tr>
                  `,
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
          "Failed to fetch task details: " + error.message,
          "danger",
        );
      }
    }

    async clearTaskHistory() {
      try {
        // Show loading overlay
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

        // Reset pagination
        this.currentHistoryPage = 1;
        this.historyTotalPages = 1;
        const paginationContainer = document.querySelector(
          "#taskHistoryPagination",
        );
        if (paginationContainer) {
          paginationContainer.innerHTML = "";
        }

        this.notifier.show(
          "Success",
          "Task history cleared successfully",
          "success",
        );
      } catch (error) {
        hideLoadingOverlay();
        console.error("Error clearing task history:", error);
        this.notifier.show(
          "Error",
          `Failed to clear task history: ${error.message}`,
          "danger",
        );
      }
    }

    showDependencyErrorModal(taskId, errorMessage) {
      // Create modal if it doesn't exist
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

      // Set content
      const errorMessageEl = modal.querySelector(".dependency-error-message");
      if (errorMessageEl) {
        errorMessageEl.textContent = errorMessage;
      }

      // Show modal
      const bsModal = new bootstrap.Modal(modal);
      bsModal.show();

      // Refresh task config to show accurate status
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

      // Close EventSource
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }
    }
  }

  // Make taskManager accessible globally
  window.taskManager = null;

  document.addEventListener("DOMContentLoaded", () => {
    window.taskManager = new TaskManager();

    setupTaskConfigEventListeners();
    setupGeoPointsUpdate();
    setupRegeocode();
    setupRemapMatchedTrips();

    // Initial loading of task configuration
    taskManager.loadTaskConfig();

    // Cleanup on page unload
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
      saveTaskConfigBtn.addEventListener("click", () => {
        const config = taskManager.gatherTaskConfigFromUI();
        taskManager
          .submitTaskConfigUpdate(config)
          .then(() => {
            window.notificationManager.show(
              "Task configuration updated successfully",
              "success",
            );
            taskManager.loadTaskConfig();
          })
          .catch((error) => {
            console.error("Error updating task config:", error);
            window.notificationManager.show(
              `Error updating task config: ${error.message}`,
              "danger",
            );
          });
      });
    }

    // Reset Tasks Button Handler
    const resetTasksBtn = document.getElementById("resetTasksBtn");
    if (resetTasksBtn) {
      resetTasksBtn.addEventListener("click", async () => {
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

    if (resumeBtn) {
      resumeBtn.addEventListener("click", async () => {
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
      stopAllBtn.addEventListener("click", async () => {
        try {
          showLoadingOverlay();
          const response = await fetch("/api/background_tasks/stop_all", {
            method: "POST",
          });

          hideLoadingOverlay();

          if (!response.ok) throw new Error("Failed to stop tasks");

          window.notificationManager.show(
            "All running tasks stopped",
            "success",
          );
          taskManager.loadTaskConfig();
        } catch (error) {
          hideLoadingOverlay();
          console.error("Error stopping tasks:", error);
          window.notificationManager.show("Failed to stop tasks", "danger");
        }
      });
    }

    if (enableAllBtn) {
      enableAllBtn.addEventListener("click", async () => {
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
      disableAllBtn.addEventListener("click", async () => {
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
      manualRunAllBtn.addEventListener("click", () =>
        taskManager.runTask("ALL"),
      );
    }

    if (globalSwitch) {
      globalSwitch.addEventListener("change", function () {
        const config = taskManager.gatherTaskConfigFromUI();
        taskManager
          .submitTaskConfigUpdate(config)
          .then(() =>
            window.notificationManager.show(
              "Global disable toggled",
              "success",
            ),
          )
          .catch(() =>
            window.notificationManager.show(
              "Failed to toggle global disable",
              "danger",
            ),
          );
      });
    }

    if (clearHistoryBtn) {
      clearHistoryBtn.addEventListener("click", () => {
        const modal = new bootstrap.Modal(
          document.getElementById("clearHistoryModal"),
        );
        modal.show();
      });
    }

    const confirmClearHistory = document.getElementById("confirmClearHistory");
    if (confirmClearHistory) {
      confirmClearHistory.addEventListener("click", async () => {
        await taskManager.clearTaskHistory();
        const modal = bootstrap.Modal.getInstance(
          document.getElementById("clearHistoryModal"),
        );
        modal.hide();
      });
    }

    document
      .querySelector("#taskConfigTable tbody")
      .addEventListener("click", (e) => {
        const detailsBtn = e.target.closest(".view-details-btn");
        const runBtn = e.target.closest(".run-now-btn");
        if (detailsBtn) {
          const taskId = detailsBtn.dataset.taskId;
          taskManager.showTaskDetails(taskId);
        } else if (runBtn) {
          const taskId = runBtn.dataset.taskId;
          taskManager.runTask(taskId);
        }
      });

    const taskDetailsModal = document.getElementById("taskDetailsModal");
    if (taskDetailsModal) {
      taskDetailsModal
        .querySelector(".run-task-btn")
        .addEventListener("click", async (e) => {
          const taskId = e.target.dataset.taskId;
          if (taskId) {
            await taskManager.runTask(taskId);
            bootstrap.Modal.getInstance(taskDetailsModal).hide();
          }
        });
    }
  }

  function setupGeoPointsUpdate() {
    const btn = document.getElementById("update-geo-points");
    const select = document.getElementById("collection-select");
    if (!btn || !select) return;

    btn.addEventListener("click", async () => {
      const collection = select.value;
      document.getElementById("update-geo-points-status").textContent =
        "Updating...";

      try {
        showLoadingOverlay();
        const response = await fetch("/update_geo_points", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ collection }),
        });

        hideLoadingOverlay();

        const data = await response.json();

        document.getElementById("update-geo-points-status").textContent =
          data.message;
        window.notificationManager.show(data.message, "success");
      } catch (err) {
        hideLoadingOverlay();
        console.error("Error updating GeoPoints:", err);
        window.notificationManager.show("Failed to update GeoPoints", "danger");
      }
    });
  }

  function setupRegeocode() {
    const btn = document.getElementById("re-geocode-all-trips");
    if (!btn) return;

    btn.addEventListener("click", async () => {
      document.getElementById("re-geocode-all-trips-status").textContent =
        "Re-geocoding all trips...";

      try {
        showLoadingOverlay();
        const response = await fetch("/api/regeocode_all_trips", {
          method: "POST",
        });

        hideLoadingOverlay();

        const data = await response.json();

        document.getElementById("re-geocode-all-trips-status").textContent =
          "All trips have been re-geocoded.";
        window.notificationManager.show(data.message, "success");
      } catch (err) {
        hideLoadingOverlay();
        console.error("Error re-geocoding trips:", err);
        document.getElementById("re-geocode-all-trips-status").textContent =
          "Error re-geocoding trips. See console.";
        window.notificationManager.show("Failed to re-geocode trips", "danger");
      }
    });
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

    remapBtn.addEventListener("click", async function () {
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
            "danger",
          );
          return;
        }
      } else {
        interval_days = parseInt(
          document.getElementById("remap-interval-select").value,
          10,
        );
        start_date = new Date();
        start_date.setDate(start_date.getDate() - interval_days);
        start_date = start_date.toISOString().split("T")[0];
        end_date = new Date().toISOString().split("T")[0];
      }

      try {
        // Show loading as this can take time
        showLoadingOverlay();
        document.getElementById("remap-status").textContent =
          "Remapping trips...";

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

    // Use the central DateUtils function
    if (window.DateUtils && window.DateUtils.initDatePicker) {
      window.DateUtils.initDatePicker(".datepicker");
    } else {
      // Fallback to flatpickr directly
      flatpickr(".datepicker", {
        enableTime: false,
        dateFormat: "Y-m-d",
      });
    }
  }
})();
