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
      // Remove the websocket initialization
      // this.ws = null;
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

      // Enhance polling to handle all updates
      this.setupPolling();
    }

    setupPolling() {
      // Increase polling frequency for better responsiveness
      setInterval(() => {
        this.loadTaskConfig();
        this.updateTaskHistory();
        // Check for active tasks status updates
        this.checkActiveTasksStatus();
      }, 10000); // Poll every 10 seconds instead of 30 seconds
    }

    // Add a method to check status of active tasks
    async checkActiveTasksStatus() {
      try {
        const activeTaskIds = Array.from(this.activeTasksMap.keys());
        if (activeTaskIds.length === 0) return;

        // Fetch the current status of all active tasks
        const configResponse = await fetch("/api/background_tasks/config");
        if (!configResponse.ok) {
          throw new Error("Failed to fetch task configuration");
        }
        const config = await configResponse.json();

        // Update UI for each active task
        for (const taskId of activeTaskIds) {
          const taskConfig = config.tasks[taskId];
          if (!taskConfig) continue;

          const currentStatus = taskConfig.status;
          const previousStatus = this.activeTasksMap.get(taskId);

          if (currentStatus !== previousStatus) {
            this.activeTasksMap.set(taskId, currentStatus);
            this.handleTaskUpdate({
              task_id: taskId,
              status: currentStatus,
              last_run: taskConfig.last_run,
              next_run: taskConfig.next_run,
            });

            // If task completed or failed, show a notification
            if (
              previousStatus === "RUNNING" &&
              (currentStatus === "COMPLETED" || currentStatus === "FAILED")
            ) {
              const statusType =
                currentStatus === "COMPLETED" ? "success" : "danger";
              this.notifier.show(
                "Task Update",
                `Task ${taskId} ${currentStatus.toLowerCase()}`,
                statusType,
              );
            }
          }
        }
      } catch (error) {
        console.error("Error checking active tasks status:", error);
      }
    }

    handleTaskUpdate(data) {
      const row = document.querySelector(`tr[data-task-id="${data.task_id}"]`);
      if (row) {
        const statusCell = row.querySelector(".task-status");
        const lastRunCell = row.querySelector(".task-last-run");
        const nextRunCell = row.querySelector(".task-next-run");

        if (statusCell) statusCell.innerHTML = this.getStatusHTML(data.status);
        if (lastRunCell && data.last_run)
          lastRunCell.textContent = this.formatDateTime(data.last_run);
        if (nextRunCell && data.next_run)
          nextRunCell.textContent = this.formatDateTime(data.next_run);

        const runButton = row.querySelector(".run-now-btn");
        if (runButton) {
          runButton.disabled = data.status === "RUNNING";
        }
      }
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
      if (taskId === "ALL") {
        try {
          const configResponse = await fetch("/api/background_tasks/config");
          if (!configResponse.ok) {
            throw new Error("Failed to fetch task configuration");
          }
          const config = await configResponse.json();

          const enabledTasks = [];
          for (const task in config.tasks) {
            if (config.tasks[task].enabled) {
              enabledTasks.push(task);
            }
          }

          for (const task of enabledTasks) {
            await this.runSingleTask(task);
          }
        } catch (error) {
          console.error("Error in run all tasks:", error);
          this.notifier.show(
            "Error",
            "Failed to run all tasks: " + error.message,
            "danger",
          );
        }
      } else {
        await this.runSingleTask(taskId);
      }
    }

    async runSingleTask(taskId) {
      try {
        const response = await fetch("/api/background_tasks/manual_run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tasks: [taskId] }),
        });

        if (!response.ok) {
          throw new Error("Failed to start task");
        }

        const result = await response.json();
        if (result.status === "success") {
          this.activeTasksMap.set(taskId, "RUNNING");
          this.notifier.show(
            "Task Started",
            `Task ${taskId} has been started`,
            "info",
          );

          const row = document.querySelector(`tr[data-task-id="${taskId}"]`);
          if (row) {
            const statusCell = row.querySelector(".task-status");
            if (statusCell) {
              statusCell.innerHTML = this.getStatusHTML("RUNNING");
            }

            const runButton = row.querySelector(".run-now-btn");
            if (runButton) {
              runButton.disabled = true;
            }
          }
        } else {
          throw new Error(result.message || "Failed to start task");
        }
      } catch (error) {
        console.error(`Error running task ${taskId}:`, error);
        this.notifier.show(
          "Error",
          `Failed to start task ${taskId}: ${error.message}`,
          "danger",
        );
      }
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

    updateTaskConfigTable(config) {
      const tbody = document.querySelector("#taskConfigTable tbody");
      if (!tbody) return;

      tbody.innerHTML = "";

      Object.entries(config.tasks).forEach(([taskId, task]) => {
        const row = document.createElement("tr");
        row.dataset.taskId = taskId;

        row.innerHTML = `
            <td>${task.display_name || taskId}</td>
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
            <td class="task-status">${this.getStatusHTML(
              task.status || "IDLE",
            )}</td>
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
                  ${task.status === "RUNNING" ? "disabled" : ""}>
                  <i class="fas fa-play"></i>
                </button>
                <button class="btn btn-primary view-details-btn" data-task-id="${taskId}">
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
                    data-error="${entry.error}">
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

    formatDateTime(date) {
      if (!date) return "";
      return new Date(date).toLocaleString();
    }

    formatDuration(ms) {
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      return hours > 0
        ? `${hours}h ${minutes % 60}m ${seconds % 60}s`
        : minutes > 0
          ? `${minutes}m ${seconds % 60}s`
          : `${seconds}s`;
    }

    gatherTaskConfigFromUI() {
      const tasks = {};
      document.querySelectorAll("#taskConfigTable tbody tr").forEach((row) => {
        const sel = row.querySelector("select");
        const check = row.querySelector('input[type="checkbox"]');
        if (!sel || !check) return;
        const taskId = sel.dataset.taskId;
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
      const response = await fetch("/api/background_tasks/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.message || "Error updating config");
      }

      return response.json();
    }

    async showTaskDetails(taskId) {
      try {
        const response = await fetch("/api/background_tasks/config");
        if (!response.ok) throw new Error("Failed to fetch task configuration");
        const config = await response.json();

        const taskDetails = config.tasks[taskId];
        if (!taskDetails) throw new Error("Task not found");

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
          `;

        runBtn.dataset.taskId = taskId;
        runBtn.disabled = taskDetails.status === "RUNNING";

        const bsModal = new bootstrap.Modal(modal);
        bsModal.show();
      } catch (error) {
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
        const response = await fetch("/api/background_tasks/history/clear", {
          method: "POST",
        });

        if (!response.ok) {
          throw new Error("Failed to clear task history");
        }

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

        this.task_history = [];
        this.notifier.show(
          "Success",
          "Task history cleared successfully",
          "success",
        );
      } catch (error) {
        console.error("Error clearing task history:", error);
        this.notifier.show(
          "Error",
          `Failed to clear task history: ${error.message}`,
          "danger",
        );
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    window.taskManager = new TaskManager();

    setupTaskConfigEventListeners();
    setupGeoPointsUpdate();
    setupRegeocode();
    setupRemapMatchedTrips();

    taskManager.loadTaskConfig();
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

    if (confirmPauseBtn) {
      confirmPauseBtn.addEventListener("click", async () => {
        const mins = parseInt(
          document.getElementById("pauseDuration").value,
          10,
        );
        try {
          const response = await fetch("/api/background_tasks/pause", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ minutes: mins }),
          });
          if (!response.ok) throw new Error("Failed to pause tasks");

          bootstrap.Modal.getInstance(
            document.getElementById("pauseModal"),
          ).hide();
          window.notificationManager.show(
            "Success",
            `Tasks paused for ${mins} minutes`,
            "success",
          );
          taskManager.loadTaskConfig();
        } catch (error) {
          console.error("Error pausing tasks:", error);
          window.notificationManager.show(
            "Error",
            "Failed to pause tasks",
            "danger",
          );
        }
      });
    }

    if (resumeBtn) {
      resumeBtn.addEventListener("click", async () => {
        try {
          const response = await fetch("/api/background_tasks/resume", {
            method: "POST",
          });
          if (!response.ok) throw new Error("Failed to resume tasks");

          window.notificationManager.show(
            "Success",
            "Tasks resumed",
            "success",
          );
          taskManager.loadTaskConfig();
        } catch (error) {
          console.error("Error resuming tasks:", error);
          window.notificationManager.show(
            "Error",
            "Failed to resume tasks",
            "danger",
          );
        }
      });
    }

    if (stopAllBtn) {
      stopAllBtn.addEventListener("click", async () => {
        try {
          const response = await fetch("/api/background_tasks/stop_all", {
            method: "POST",
          });
          if (!response.ok) throw new Error("Failed to stop tasks");

          window.notificationManager.show(
            "Success",
            "All tasks stopped",
            "success",
          );
          taskManager.loadTaskConfig();
        } catch (error) {
          console.error("Error stopping tasks:", error);
          window.notificationManager.show(
            "Error",
            "Failed to stop tasks",
            "danger",
          );
        }
      });
    }

    if (enableAllBtn) {
      enableAllBtn.addEventListener("click", async () => {
        try {
          const response = await fetch("/api/background_tasks/enable", {
            method: "POST",
          });
          if (!response.ok) throw new Error("Failed to enable all tasks");

          window.notificationManager.show(
            "Success",
            "All tasks enabled",
            "success",
          );
          taskManager.loadTaskConfig();
        } catch (error) {
          console.error("Error enabling tasks:", error);
          window.notificationManager.show(
            "Error",
            "Failed to enable tasks",
            "danger",
          );
        }
      });
    }

    if (disableAllBtn) {
      disableAllBtn.addEventListener("click", async () => {
        try {
          const response = await fetch("/api/background_tasks/disable", {
            method: "POST",
          });
          if (!response.ok) throw new Error("Failed to disable all tasks");

          window.notificationManager.show(
            "Success",
            "All tasks disabled",
            "success",
          );
          taskManager.loadTaskConfig();
        } catch (error) {
          console.error("Error disabling tasks:", error);
          window.notificationManager.show(
            "Error",
            "Failed to disable tasks",
            "danger",
          );
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
              "Success",
              "Global disable toggled",
              "success",
            ),
          )
          .catch(() =>
            window.notificationManager.show(
              "Error",
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
        const response = await fetch("/update_geo_points", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ collection }),
        });
        const data = await response.json();

        document.getElementById("update-geo-points-status").textContent =
          data.message;
        window.notificationManager.show("Success", data.message, "success");
      } catch (err) {
        console.error("Error updating GeoPoints:", err);
        window.notificationManager.show(
          "Error",
          "Failed to update GeoPoints",
          "danger",
        );
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
        const response = await fetch("/api/regeocode_all_trips", {
          method: "POST",
        });
        const data = await response.json();

        document.getElementById("re-geocode-all-trips-status").textContent =
          "All trips have been re-geocoded.";
        window.notificationManager.show("Success", data.message, "success");
      } catch (err) {
        console.error("Error re-geocoding trips:", err);
        document.getElementById("re-geocode-all-trips-status").textContent =
          "Error re-geocoding trips. See console.";
        window.notificationManager.show(
          "Error",
          "Failed to re-geocode trips",
          "danger",
        );
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
            "Error",
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
        const response = await fetch("/api/matched_trips/remap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ start_date, end_date, interval_days }),
        });
        const data = await response.json();

        document.getElementById("remap-status").textContent = data.message;
        window.notificationManager.show("Success", data.message, "success");
      } catch (error) {
        console.error("Error re-matching trips:", error);
        document.getElementById("remap-status").textContent =
          "Error re-matching trips.";
        window.notificationManager.show(
          "Error",
          "Failed to re-match trips",
          "danger",
        );
      }
    });

    // Use the central DateUtils function
    DateUtils.initDatePicker(".datepicker");
  }
})();
