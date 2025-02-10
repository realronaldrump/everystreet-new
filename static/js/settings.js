/* global showLoadingOverlay, hideLoadingOverlay, bootstrap, flatpickr */

(() => {
  "use strict";

  class TaskManager {
    constructor() {
        this.toastManager = new ToastManager();
        this.ws = null;
        this.activeTasksMap = new Map();
        this.intervalOptions = [
            { value: 1, label: "1 minute" },
            { value: 5, label: "5 minutes" },
            { value: 15, label: "15 minutes" },
            { value: 30, label: "30 minutes" },
            { value: 60, label: "1 hour" },
            { value: 360, label: "6 hours" },
            { value: 720, label: "12 hours" },
            { value: 1440, label: "24 hours" }
        ];
        this.initializeWebSocket();
        this.setupPolling();
    }

    initializeWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.ws = new WebSocket(`${protocol}//${window.location.host}/ws/live_trip`);
        
        this.ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'task_update') {
                this.handleTaskUpdate(data);
            }
        };

        this.ws.onclose = () => {
            console.log('WebSocket connection closed. Attempting to reconnect...');
            setTimeout(() => this.initializeWebSocket(), 5000);
        };
    }

    setupPolling() {
        // Poll for updates every 30 seconds
        setInterval(() => {
            this.loadTaskConfig();
            this.updateTaskHistory();
        }, 30000);
    }

    handleTaskUpdate(data) {
        const row = document.querySelector(`tr[data-task-id="${data.task_id}"]`);
        if (row) {
            const statusCell = row.querySelector('.task-status');
            const lastRunCell = row.querySelector('.task-last-run');
            const nextRunCell = row.querySelector('.task-next-run');
            
            if (statusCell) statusCell.innerHTML = this.getStatusHTML(data.status);
            if (lastRunCell && data.last_run) lastRunCell.textContent = this.formatDateTime(data.last_run);
            if (nextRunCell && data.next_run) nextRunCell.textContent = this.formatDateTime(data.next_run);

            // Update run button state
            const runButton = row.querySelector('.run-now-btn');
            if (runButton) {
                runButton.disabled = data.status === 'RUNNING';
            }
        }
    }

    getStatusHTML(status) {
        const statusColors = {
            'RUNNING': 'primary',
            'COMPLETED': 'success',
            'FAILED': 'danger',
            'PAUSED': 'warning',
            'IDLE': 'secondary'
        };

        const color = statusColors[status] || 'secondary';
        
        if (status === 'RUNNING') {
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
        const colors = {
            'RUNNING': 'primary',
            'COMPLETED': 'success',
            'FAILED': 'danger',
            'PAUSED': 'warning',
            'IDLE': 'secondary'
        };
        return colors[status] || 'secondary';
    }

    async runTask(taskId) {
        if (taskId === 'ALL') {
            try {
                const configResponse = await fetch('/api/background_tasks/config');
                if (!configResponse.ok) {
                    throw new Error('Failed to fetch task configuration');
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
                console.error('Error in run all tasks:', error);
                this.toastManager.show('Error', 'Failed to run all tasks: ' + error.message, 'danger');
            }
        } else {
            await this.runSingleTask(taskId);
        }
    }

    async runSingleTask(taskId) {
        try {
            const response = await fetch('/api/background_tasks/manual_run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tasks: [taskId] })
            });

            if (!response.ok) {
                throw new Error('Failed to start task');
            }

            const result = await response.json();
            if (result.status === 'success') {
                this.activeTasksMap.set(taskId, 'RUNNING');
                this.toastManager.show('Task Started', `Task ${taskId} has been started`, 'info');

                const row = document.querySelector(`tr[data-task-id="${taskId}"]`);
                if (row) {
                    const statusCell = row.querySelector('.task-status');
                    if (statusCell) {
                        statusCell.innerHTML = this.getStatusHTML('RUNNING');
                    }

                    const runButton = row.querySelector('.run-now-btn');
                    if (runButton) {
                        runButton.disabled = true;
                    }
                }
            } else {
                throw new Error(result.message || 'Failed to start task');
            }
        } catch (error) {
            console.error(`Error running task ${taskId}:`, error);
            this.toastManager.show('Error', `Failed to start task ${taskId}: ${error.message}`, 'danger');
        }
    }

    async loadTaskConfig() {
        try {
            const response = await fetch('/api/background_tasks/config');
            if (!response.ok) {
                throw new Error('Failed to load task configuration');
            }
            const config = await response.json();

            // Update global disable switch
            const globalSwitch = document.getElementById('globalDisableSwitch');
            if (globalSwitch) {
                globalSwitch.checked = Boolean(config.disabled);
            }

            // Update task configuration table
            this.updateTaskConfigTable(config);

            // Load task history
            await this.updateTaskHistory();

        } catch (error) {
            console.error('Error loading task configuration:', error);
            this.toastManager.show('Error', 'Failed to load task configuration: ' + error.message, 'danger');
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
                        ${this.intervalOptions.map(opt => `
                            <option value="${opt.value}" ${opt.value === task.interval_minutes ? 'selected' : ''}>
                                ${opt.label}
                            </option>
                        `).join('')}
                    </select>
                </td>
                <td>
                    <div class="form-check form-switch">
                        <input class="form-check-input" type="checkbox" 
                            id="enable-${taskId}" ${task.enabled ? 'checked' : ''} 
                            data-task-id="${taskId}">
                    </div>
                </td>
                <td>${task.priority || "MEDIUM"}</td>
                <td class="task-status">${this.getStatusHTML(task.status || 'IDLE')}</td>
                <td class="task-last-run">${task.last_run ? this.formatDateTime(task.last_run) : 'Never'}</td>
                <td class="task-next-run">${task.next_run ? this.formatDateTime(task.next_run) : 'Not scheduled'}</td>
                <td>
                    <div class="btn-group btn-group-sm">
                        <button class="btn btn-info run-now-btn" data-task-id="${taskId}"
                            ${task.status === 'RUNNING' ? 'disabled' : ''}>
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
            const response = await fetch('/api/background_tasks/history');
            if (!response.ok) {
                throw new Error('Failed to fetch task history');
            }
            const history = await response.json();
            this.updateTaskHistoryTable(history);
        } catch (error) {
            console.error('Error updating task history:', error);
            this.toastManager.show('Error', 'Failed to update task history: ' + error.message, 'danger');
        }
    }

    updateTaskHistoryTable(history) {
        const tbody = document.querySelector("#taskHistoryTable tbody");
        if (!tbody) return;

        tbody.innerHTML = "";

        history.forEach(entry => {
            const row = document.createElement("tr");
            row.innerHTML = `
                <td>${entry.task_id}</td>
                <td>
                    <span class="badge bg-${this.getStatusColor(entry.status)}">
                        ${entry.status}
                    </span>
                </td>
                <td>${this.formatDateTime(entry.timestamp)}</td>
                <td>${entry.runtime ? this.formatDuration(entry.runtime) : '-'}</td>
                <td>${entry.result ? 'Success' : 'Failed'}</td>
                <td>
                    ${entry.error ?
                        `<button class="btn btn-sm btn-danger view-error-btn"
                            data-error="${entry.error}">
                            <i class="fas fa-exclamation-circle"></i> View Error
                        </button>` :
                        '-'
                    }
                </td>
            `;
            tbody.appendChild(row);
        });
    }

    formatDateTime(date) {
        if (!date) return '';
        return new Date(date).toLocaleString();
    }

    formatDuration(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        return hours > 0 ?
            `${hours}h ${minutes % 60}m ${seconds % 60}s` :
            minutes > 0 ?
                `${minutes}m ${seconds % 60}s` :
                `${seconds}s`;
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
            const response = await fetch(`/api/background_tasks/details/${taskId}`);
            if (!response.ok) throw new Error('Failed to fetch task details');
            const details = await response.json();

            const modal = document.getElementById('taskDetailsModal');
            const content = modal.querySelector('.task-details-content');
            const runBtn = modal.querySelector('.run-task-btn');

            content.innerHTML = `
                <div class="mb-3">
                    <h6>Task ID</h6>
                    <p>${details.task_id}</p>
                </div>
                <div class="mb-3">
                    <h6>Description</h6>
                    <p>${details.description || 'No description available'}</p>
                </div>
                <div class="mb-3">
                    <h6>Status</h6>
                    <p>${this.getStatusHTML(details.status)}</p>
                </div>
                <div class="mb-3">
                    <h6>Last Run</h6>
                    <p>${details.last_run ? this.formatDateTime(details.last_run) : 'Never'}</p>
                </div>
                <div class="mb-3">
                    <h6>Next Run</h6>
                    <p>${details.next_run ? this.formatDateTime(details.next_run) : 'Not scheduled'}</p>
                </div>
            `;

            runBtn.dataset.taskId = taskId;
            runBtn.disabled = details.status === 'RUNNING';

            const bsModal = new bootstrap.Modal(modal);
            bsModal.show();
        } catch (error) {
            console.error('Error fetching task details:', error);
            this.toastManager.show('Error', 'Failed to fetch task details', 'danger');
        }
    }
  }

  class ToastManager {
    constructor() {
        this.container = document.querySelector('.toast-container');
        this.template = document.getElementById('toast-template');
    }

    show(title, message, type = 'info') {
        if (!this.container || !this.template) {
            console.error('Toast container or template not found');
            return;
        }

        const toast = this.template.content.cloneNode(true).querySelector('.toast');
        
        toast.querySelector('.toast-title').textContent = title;
        toast.querySelector('.toast-body').textContent = message;
        
        const icon = toast.querySelector('.toast-icon');
        icon.className = `rounded me-2 toast-icon bg-${type}`;
        
        this.container.appendChild(toast);
        
        const bsToast = new bootstrap.Toast(toast);
        bsToast.show();
        
        toast.addEventListener('hidden.bs.toast', () => {
            toast.remove();
        });
    }
  }

  // Initialize settings on DOM load
  document.addEventListener("DOMContentLoaded", () => {
    // Initialize managers
    window.settingsManager = new ToastManager();
    window.taskManager = new TaskManager();

    // Setup event listeners
    setupTaskConfigEventListeners();
    setupHistoricalData();
    setupGeoPointsUpdate();
    setupRegeocode();
    setupRemapMatchedTrips();

    // Initial load of task configuration and history
    taskManager.loadTaskConfig();
  });

  // TASK CONFIGURATION EVENT LISTENERS
  function setupTaskConfigEventListeners() {
    const saveTaskConfigBtn = document.getElementById("saveTaskConfigBtn");
    const confirmPauseBtn = document.getElementById("confirmPause");
    const resumeBtn = document.getElementById("resumeBtn");
    const stopAllBtn = document.getElementById("stopAllBtn");
    const enableAllBtn = document.getElementById("enableAllBtn");
    const disableAllBtn = document.getElementById("disableAllBtn");
    const manualRunAllBtn = document.getElementById("manualRunAllBtn");
    const globalSwitch = document.getElementById("globalDisableSwitch");

    if (saveTaskConfigBtn) {
        saveTaskConfigBtn.addEventListener("click", () => {
            const config = taskManager.gatherTaskConfigFromUI();
            taskManager.submitTaskConfigUpdate(config)
                .then(() => {
                    settingsManager.show('Success', 'Task configuration saved', 'success');
                    taskManager.loadTaskConfig();
                })
                .catch(err => {
                    console.error("Error saving config:", err);
                    settingsManager.show('Error', 'Failed to save configuration', 'danger');
                });
        });
    }

    if (confirmPauseBtn) {
        confirmPauseBtn.addEventListener("click", async () => {
            const mins = parseInt(document.getElementById("pauseDuration").value, 10);
            try {
                const response = await fetch("/api/background_tasks/pause", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ minutes: mins }),
                });
                if (!response.ok) throw new Error('Failed to pause tasks');
                
                bootstrap.Modal.getInstance(document.getElementById('pauseModal')).hide();
                settingsManager.show('Success', `Tasks paused for ${mins} minutes`, 'success');
                taskManager.loadTaskConfig();
            } catch (error) {
                console.error("Error pausing tasks:", error);
                settingsManager.show('Error', 'Failed to pause tasks', 'danger');
            }
        });
    }

    if (resumeBtn) {
        resumeBtn.addEventListener("click", async () => {
            try {
                const response = await fetch("/api/background_tasks/resume", { method: "POST" });
                if (!response.ok) throw new Error('Failed to resume tasks');
                
                settingsManager.show('Success', 'Tasks resumed', 'success');
                taskManager.loadTaskConfig();
            } catch (error) {
                console.error("Error resuming tasks:", error);
                settingsManager.show('Error', 'Failed to resume tasks', 'danger');
            }
        });
    }

    if (stopAllBtn) {
        stopAllBtn.addEventListener("click", async () => {
            try {
                const response = await fetch("/api/background_tasks/stop_all", { method: "POST" });
                if (!response.ok) throw new Error('Failed to stop tasks');
                
                settingsManager.show('Success', 'All tasks stopped', 'success');
                taskManager.loadTaskConfig();
            } catch (error) {
                console.error("Error stopping tasks:", error);
                settingsManager.show('Error', 'Failed to stop tasks', 'danger');
            }
        });
    }

    if (enableAllBtn) {
        enableAllBtn.addEventListener("click", async () => {
            try {
                const response = await fetch("/api/background_tasks/enable", { method: "POST" });
                if (!response.ok) throw new Error('Failed to enable all tasks');
                
                settingsManager.show('Success', 'All tasks enabled', 'success');
                taskManager.loadTaskConfig();
            } catch (error) {
                console.error("Error enabling tasks:", error);
                settingsManager.show('Error', 'Failed to enable tasks', 'danger');
            }
        });
    }

    if (disableAllBtn) {
        disableAllBtn.addEventListener("click", async () => {
            try {
                const response = await fetch("/api/background_tasks/disable", { method: "POST" });
                if (!response.ok) throw new Error('Failed to disable all tasks');
                
                settingsManager.show('Success', 'All tasks disabled', 'success');
                taskManager.loadTaskConfig();
            } catch (error) {
                console.error("Error disabling tasks:", error);
                settingsManager.show('Error', 'Failed to disable tasks', 'danger');
            }
        });
    }

    if (manualRunAllBtn) {
        manualRunAllBtn.addEventListener("click", () => taskManager.runTask("ALL"));
    }

    if (globalSwitch) {
        globalSwitch.addEventListener("change", function() {
            const config = taskManager.gatherTaskConfigFromUI();
            taskManager.submitTaskConfigUpdate(config)
                .then(() => settingsManager.show('Success', 'Global disable toggled', 'success'))
                .catch(err => settingsManager.show('Error', 'Failed to toggle global disable', 'danger'));
        });
    }

    // Add event delegation for task details buttons
    document.querySelector("#taskConfigTable tbody").addEventListener("click", (e) => {
        const detailsBtn = e.target.closest('.view-details-btn');
        if (detailsBtn) {
            const taskId = detailsBtn.dataset.taskId;
            taskManager.showTaskDetails(taskId);
        }
    });

    // Add this in setupTaskConfigEventListeners
    const taskDetailsModal = document.getElementById('taskDetailsModal');
    if (taskDetailsModal) {
        taskDetailsModal.querySelector('.run-task-btn').addEventListener('click', async (e) => {
            const taskId = e.target.dataset.taskId;
            if (taskId) {
                await taskManager.runTask(taskId);
                bootstrap.Modal.getInstance(taskDetailsModal).hide();
            }
        });
    }
  }

  // HISTORICAL DATA MANAGEMENT
  function setupHistoricalData() {
    const btn = document.getElementById("load-historical-data");
    if (!btn) return;
    
    btn.addEventListener("click", async () => {
      showLoadingOverlay();
      try {
        const response = await fetch("/load_historical_data", { method: "POST" });
        const data = await response.json();
        
        document.getElementById("historical-data-status").textContent = data.message;
        settingsManager.show('Success', data.message, 'success');
      } catch (err) {
        console.error("Error loading historical data:", err);
        settingsManager.show('Error', 'Failed to load historical data', 'danger');
      } finally {
        hideLoadingOverlay();
      }
    });
  }

  // GEOPOINT UPDATES
  function setupGeoPointsUpdate() {
    const btn = document.getElementById("update-geo-points");
    const select = document.getElementById("collection-select");
    if (!btn || !select) return;
    
    btn.addEventListener("click", async () => {
      const collection = select.value;
      document.getElementById("update-geo-points-status").textContent = "Updating...";
      
      try {
        const response = await fetch("/update_geo_points", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ collection }),
        });
        const data = await response.json();
        
        document.getElementById("update-geo-points-status").textContent = data.message;
        settingsManager.show('Success', data.message, 'success');
      } catch (err) {
        console.error("Error updating GeoPoints:", err);
        settingsManager.show('Error', 'Failed to update GeoPoints', 'danger');
      }
    });
  }

  // RE-GEOCODE ALL TRIPS
  function setupRegeocode() {
    const btn = document.getElementById("re-geocode-all-trips");
    if (!btn) return;
    
    btn.addEventListener("click", async () => {
      document.getElementById("re-geocode-all-trips-status").textContent = "Re-geocoding all trips...";
      
      try {
        const response = await fetch("/api/regeocode_all_trips", { method: "POST" });
        const data = await response.json();
        
        document.getElementById("re-geocode-all-trips-status").textContent = "All trips have been re-geocoded.";
        settingsManager.show('Success', data.message, 'success');
      } catch (err) {
        console.error("Error re-geocoding trips:", err);
        document.getElementById("re-geocode-all-trips-status").textContent = "Error re-geocoding trips. See console.";
        settingsManager.show('Error', 'Failed to re-geocode trips', 'danger');
      }
    });
  }

  // REMAP MATCHED TRIPS
  function setupRemapMatchedTrips() {
    const remapType = document.getElementById("remap-type");
    const dateRangeDiv = document.getElementById("remap-date-range");
    const intervalDiv = document.getElementById("remap-interval");
    if (!remapType || !dateRangeDiv || !intervalDiv) return;

    remapType.addEventListener("change", function() {
      dateRangeDiv.style.display = this.value === "date" ? "block" : "none";
      intervalDiv.style.display = this.value === "date" ? "none" : "block";
    });

    const remapBtn = document.getElementById("remap-btn");
    if (!remapBtn) return;
    
    remapBtn.addEventListener("click", async function() {
      const method = remapType.value;
      let start_date, end_date, interval_days = 0;

      if (method === "date") {
        start_date = document.getElementById("remap-start").value;
        end_date = document.getElementById("remap-end").value;
        if (!start_date || !end_date) {
          settingsManager.show('Error', 'Please select both start and end dates', 'danger');
          return;
        }
      } else {
        interval_days = parseInt(document.getElementById("remap-interval-select").value, 10);
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
        settingsManager.show('Success', data.message, 'success');
      } catch (error) {
        console.error("Error re-matching trips:", error);
        document.getElementById("remap-status").textContent = "Error re-matching trips.";
        settingsManager.show('Error', 'Failed to re-match trips', 'danger');
      }
    });

    // Initialize datepickers
    flatpickr(".datepicker", { dateFormat: "Y-m-d" });
  }
})();