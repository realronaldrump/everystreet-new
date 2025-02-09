/* global showLoadingOverlay, hideLoadingOverlay, bootstrap, flatpickr */

(() => {
  "use strict";

  // Initialize settings on DOM load
  document.addEventListener("DOMContentLoaded", () => {
    // Initialize managers first
    window.settingsManager = new SettingsManager();
    window.taskManager = new TaskManager();
    
    // Then initialize the UI
    loadBackgroundTasksConfig();
    setupTaskConfigEventListeners();
    setupHistoricalData();
    setupGeoPointsUpdate();
    setupRegeocode();
    setupDeleteMatchedTrips();
    setupRemapMatchedTrips();

    // Add task details modal run button handler
    document.querySelector('.run-task-btn')?.addEventListener('click', async (e) => {
        const taskId = e.target.dataset.taskId;
        if (taskId) {
            await taskManager.runTask(taskId);
            bootstrap.Modal.getInstance(document.getElementById('taskDetailsModal')).hide();
        }
    });

    // Update the view details handler
    document.addEventListener('click', async (e) => {
        if (e.target.closest('.view-details-btn')) {
            const taskId = e.target.closest('.view-details-btn').dataset.taskId;
            try {
                const response = await fetch(`/api/background_tasks/task/${taskId}`);
                if (!response.ok) {
                    throw new Error(`Failed to fetch task details for ${taskId}`);
                }
                
                const taskDetails = await response.json();
                const detailsContent = document.querySelector('.task-details-content');
                if (!detailsContent) {
                    console.error('Task details content element not found');
                    return;
                }

                // Update the modal content safely
                detailsContent.innerHTML = `
                    <h6>Task ID: ${taskId}</h6>
                    <p><strong>Description:</strong> ${taskDetails.description || 'No description available'}</p>
                    <p><strong>Priority:</strong> ${taskDetails.priority || 'Not set'}</p>
                    <p><strong>Dependencies:</strong> ${taskDetails.dependencies?.join(', ') || 'None'}</p>
                    <p><strong>Last Run:</strong> ${taskDetails.last_run ? formatDateTime(taskDetails.last_run) : 'Never'}</p>
                    <p><strong>Next Run:</strong> ${taskDetails.next_run ? formatDateTime(taskDetails.next_run) : 'Not scheduled'}</p>
                    <p><strong>Status:</strong> ${taskDetails.status || 'Unknown'}</p>
                    ${taskDetails.last_error ? `
                        <div class="alert alert-danger">
                            <strong>Last Error:</strong><br>
                            <pre>${taskDetails.last_error}</pre>
                        </div>
                    ` : ''}
                `;

                // Show the modal
                const modal = new bootstrap.Modal(document.getElementById('taskDetailsModal'));
                modal.show();
            } catch (error) {
                console.error(`Error fetching task details for ${taskId}:`, error);
                taskManager.toastManager.show('Error', 
                    `Error fetching task details for ${taskId}. Please try again.`, 'danger');
            }
        }
    });
  });

  // HISTORICAL DATA MANAGEMENT
  function setupHistoricalData() {
    const btn = document.getElementById("load-historical-data");
    if (!btn) return;
    btn.addEventListener("click", () => {
      showLoadingOverlay();
      fetch("/load_historical_data", { method: "POST" })
        .then((r) => r.json())
        .then((data) => {
          document.getElementById("historical-data-status").textContent =
            data.message;
          settingsManager.toastManager.show('Success', data.message, 'success');
        })
        .catch((err) => {
          console.error("Error loading historical data:", err);
          settingsManager.toastManager.show('Error', 'Error loading historical data. Check console.', 'danger');
        })
        .finally(() => hideLoadingOverlay());
    });
  }

  // GEOPOINT UPDATES
  function setupGeoPointsUpdate() {
    const btn = document.getElementById("update-geo-points");
    const select = document.getElementById("collection-select");
    if (!btn || !select) return;
    btn.addEventListener("click", () => {
      const collection = select.value;
      document.getElementById("update-geo-points-status").textContent =
        "Updating...";
      fetch("/update_geo_points", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collection }),
      })
        .then((r) => r.json())
        .then((data) => {
          document.getElementById("update-geo-points-status").textContent =
            data.message;
          settingsManager.toastManager.show('Success', data.message, 'success');
        })
        .catch((err) => console.error("Error updating GeoPoints:", err));
    });
  }

  // RE-GEOCODE ALL TRIPS
  function setupRegeocode() {
    const btn = document.getElementById("re-geocode-all-trips");
    if (!btn) return;
    btn.addEventListener("click", () => {
      document.getElementById("re-geocode-all-trips-status").textContent =
        "Re-geocoding all trips...";
      fetch("/api/regeocode_all_trips", { method: "POST" })
        .then((r) => r.json())
        .then((data) => {
          document.getElementById("re-geocode-all-trips-status").textContent =
            "All trips have been re-geocoded.";
          settingsManager.toastManager.show('Success', data.message, 'success');
        })
        .catch((err) => {
          console.error("Error re-geocoding trips:", err);
          document.getElementById("re-geocode-all-trips-status").textContent =
            "Error re-geocoding trips. See console.";
          settingsManager.toastManager.show('Error', 'Error re-geocoding trips. See console.', 'danger');
        });
    });
  }

  // DELETE MATCHED TRIPS
  function setupDeleteMatchedTrips() {
    const btn = document.getElementById("delete-matched-trips");
    if (!btn) return;
    btn.addEventListener("click", () => {
      if (!confirm("Are you sure you want to delete all matched trips?"))
        return;
      document.getElementById("delete-matched-trips-status").textContent =
        "Deleting...";
      fetch("/api/matched_trips/delete", { method: "POST" })
        .then((r) => r.json())
        .then((data) => {
          document.getElementById("delete-matched-trips-status").textContent =
            data.message;
          settingsManager.toastManager.show('Success', data.message, 'success');
        })
        .catch((err) => {
          console.error("Error deleting matched trips:", err);
          document.getElementById("delete-matched-trips-status").textContent =
            "Error deleting matched trips. See console.";
          settingsManager.toastManager.show('Error', 'Error deleting matched trips. See console.', 'danger');
        });
    });
  }

  // REMAP MATCHED TRIPS
  function setupRemapMatchedTrips() {
    const remapType = document.getElementById("remap-type");
    const dateRangeDiv = document.getElementById("remap-date-range");
    const intervalDiv = document.getElementById("remap-interval");
    if (!remapType || !dateRangeDiv || !intervalDiv) return;

    // Toggle between date range and interval selection
    remapType.addEventListener("change", function () {
      if (this.value === "date") {
        dateRangeDiv.style.display = "block";
        intervalDiv.style.display = "none";
      } else {
        dateRangeDiv.style.display = "none";
        intervalDiv.style.display = "block";
      }
    });

    const remapBtn = document.getElementById("remap-btn");
    if (!remapBtn) return;
    remapBtn.addEventListener("click", function () {
      const method = remapType.value;
      let start_date,
        end_date,
        interval_days = 0;

      if (method === "date") {
        start_date = document.getElementById("remap-start").value;
        end_date = document.getElementById("remap-end").value;
        if (!start_date || !end_date) {
          settingsManager.toastManager.show('Error', 'Please select both start and end dates.', 'danger');
          return;
        }
      } else {
        interval_days = parseInt(
          document.getElementById("remap-interval-select").value,
          10,
        );
        start_date = new Date();
        start_date.setDate(start_date.getDate() - interval_days);
        start_date = start_date.toISOString().split("T")[0]; // Convert to YYYY-MM-DD
        end_date = new Date().toISOString().split("T")[0];
      }

      fetch("/api/matched_trips/remap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date, end_date, interval_days }),
      })
        .then((response) => response.json())
        .then((data) => {
          document.getElementById("remap-status").textContent = data.message;
          settingsManager.toastManager.show('Success', data.message, 'success');
        })
        .catch((error) => {
          console.error("Error re-matching trips:", error);
          document.getElementById("remap-status").textContent =
            "Error re-matching trips.";
          settingsManager.toastManager.show('Error', 'Error re-matching trips.', 'danger');
        });
    });

    // Initialize datepickers
    flatpickr(".datepicker", { dateFormat: "Y-m-d" });
  }

  // BACKGROUND TASK CONFIGURATION
  function setupTaskConfigEventListeners() {
    const saveTaskConfigBtn = document.getElementById("saveTaskConfigBtn");
    const confirmPauseBtn = document.getElementById("confirmPause");
    const resumeBtn = document.getElementById("resumeBtn");
    const stopAllBtn = document.getElementById("stopAllBtn");
    const enableAllBtn = document.getElementById("enableAllBtn");
    const disableAllBtn = document.getElementById("disableAllBtn");
    const manualRunAllBtn = document.getElementById("manualRunAllBtn");
    const globalSwitch = document.getElementById("globalDisableSwitch");

    if (saveTaskConfigBtn)
      saveTaskConfigBtn.addEventListener("click", saveBackgroundTasksConfig);
    if (confirmPauseBtn)
      confirmPauseBtn.addEventListener("click", confirmPause);
    if (resumeBtn) resumeBtn.addEventListener("click", resumeBackgroundTasks);
    if (stopAllBtn) stopAllBtn.addEventListener("click", stopAllBackgroundTasks);
    if (enableAllBtn) enableAllBtn.addEventListener("click", enableAllTasks);
    if (disableAllBtn) disableAllBtn.addEventListener("click", disableAllTasks);
    if (manualRunAllBtn)
      manualRunAllBtn.addEventListener("click", () => manualRunTasks(["ALL"]));

    if (globalSwitch) {
      globalSwitch.addEventListener("change", function () {
        const config = gatherTaskConfigFromUI();
        config.globalDisable = this.checked;
        submitTaskConfigUpdate(config)
          .then(() => settingsManager.toastManager.show('Success', 'Global disable toggled.', 'success'))
          .catch((err) => settingsManager.toastManager.show('Error', 'Error toggling global disable: ' + err.message, 'danger'));
      });
    }
  }

  // LOAD TASK CONFIGURATION
  function loadBackgroundTasksConfig() {
    fetch("/api/background_tasks/config")
      .then((r) => r.json())
      .then((cfg) => populateTaskConfigUI(cfg))
      .catch((err) =>
        console.error("Error loading background task config:", err),
      );
  }

  // POPULATE TASK CONFIGURATION UI
  function populateTaskConfigUI(cfg) {
    const globalDisableSwitch = document.getElementById("globalDisableSwitch");
    if (globalDisableSwitch)
        globalDisableSwitch.checked = Boolean(cfg.disabled);
    const tableBody = document.querySelector("#taskConfigTable tbody");
    if (!tableBody || !cfg.tasks) return;
    tableBody.innerHTML = "";

    const intervalOptions = [
        { value: 30, label: "Every 30 min" },
        { value: 60, label: "Every 1 hour" },
        { value: 180, label: "Every 3 hours" },
        { value: 360, label: "Every 6 hours" },
        { value: 720, label: "Every 12 hours" },
        { value: 1440, label: "Every 24 hours" },
    ];

    const knownTasks = [
        { id: "fetch_and_store_trips", name: "Fetch & Store Trips" },
        { id: "periodic_fetch_trips", name: "Periodic Trip Fetch" },
        {
            id: "update_coverage_for_all_locations",
            name: "Update Coverage (All)",
        },
        { id: "cleanup_stale_trips", name: "Cleanup Stale Trips" },
        { id: "cleanup_invalid_trips", name: "Cleanup Invalid Trips" },
    ];

    knownTasks.forEach((task) => {
        const row = document.createElement("tr");
        row.dataset.taskId = task.id;

        const tdName = document.createElement("td");
        tdName.textContent = task.name;
        row.appendChild(tdName);

        const tdInterval = document.createElement("td");
        const currentInterval = cfg.tasks[task.id]?.interval_minutes || 60;
        const sel = document.createElement("select");
        sel.className = "form-select form-select-sm w-auto";
        intervalOptions.forEach((opt) => {
            const optionEl = document.createElement("option");
            optionEl.value = opt.value;
            optionEl.textContent = opt.label;
            if (opt.value == currentInterval) optionEl.selected = true;
            sel.appendChild(optionEl);
        });
        sel.dataset.taskId = task.id;
        tdInterval.appendChild(sel);
        row.appendChild(tdInterval);

        const tdEnable = document.createElement("td");
        const enableCheck = document.createElement("input");
        enableCheck.type = "checkbox";
        enableCheck.classList.add("form-check-input");
        enableCheck.checked = Boolean(cfg.tasks[task.id]?.enabled);
        enableCheck.dataset.taskId = task.id;
        tdEnable.appendChild(enableCheck);
        row.appendChild(tdEnable);

        const tdPriority = document.createElement("td");
        tdPriority.textContent = cfg.tasks[task.id]?.priority || "MEDIUM";
        row.appendChild(tdPriority);

        const tdStatus = document.createElement("td");
        tdStatus.className = 'task-status';
        tdStatus.innerHTML = taskManager.getStatusHTML(cfg.tasks[task.id]?.status || 'IDLE');
        row.appendChild(tdStatus);

        const tdLastRun = document.createElement("td");
        tdLastRun.className = 'task-last-run';
        tdLastRun.textContent = cfg.tasks[task.id]?.last_run ? 
            formatDateTime(cfg.tasks[task.id].last_run) : 'Never';
        row.appendChild(tdLastRun);

        const tdNextRun = document.createElement("td");
        tdNextRun.className = 'task-next-run';
        tdNextRun.textContent = cfg.tasks[task.id]?.next_run ? 
            formatDateTime(cfg.tasks[task.id].next_run) : 'Not scheduled';
        row.appendChild(tdNextRun);

        const tdActions = document.createElement("td");
        tdActions.innerHTML = `
            <div class="btn-group btn-group-sm">
                <button class="btn btn-info run-now-btn" data-task-id="${task.id}">
                    <i class="fas fa-play"></i>
                </button>
                <button class="btn btn-primary view-details-btn" data-task-id="${task.id}">
                    <i class="fas fa-info-circle"></i>
                </button>
            </div>
        `;
        row.appendChild(tdActions);

        tableBody.appendChild(row);
    });
  }

  // SAVE TASK CONFIGURATION
  function saveBackgroundTasksConfig() {
    const config = gatherTaskConfigFromUI();
    submitTaskConfigUpdate(config)
      .then(() => {
        settingsManager.toastManager.show('Success', 'Background task config saved.', 'success');
        loadBackgroundTasksConfig();
      })
      .catch((err) => {
        console.error("Error saving config:", err);
        settingsManager.toastManager.show('Error', 'Failed to save config. Check console.', 'danger');
      });
  }

  // GATHER TASK CONFIGURATION FROM UI
  function gatherTaskConfigFromUI() {
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

  // SUBMIT TASK CONFIGURATION UPDATE
  function submitTaskConfigUpdate(config) {
    return fetch("/api/background_tasks/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    }).then((res) => {
      if (!res.ok) {
        return res.json().then((errData) => {
          throw new Error(errData.message || "Error updating config");
        });
      }
      return res.json();
    });
  }

  // TASK CONTROLS
  function confirmPause() {
    const mins = parseInt(document.getElementById("pauseDuration").value, 10);
    fetch("/api/background_tasks/pause", {
        method: "POST",
        body: JSON.stringify({ minutes: mins }),
    })
        .then((r) => r.json())
        .then((data) => {
            taskManager.toastManager.show('Success', data.message, 'success');
            loadBackgroundTasksConfig();
            const pauseModal = document.getElementById("pauseModal");
            const modalInstance = bootstrap.Modal.getInstance(pauseModal);
            if (modalInstance) modalInstance.hide();
        })
        .catch((err) => {
            console.error("Error pausing tasks:", err);
            taskManager.toastManager.show('Error', 'Error pausing tasks', 'danger');
        });
  }

  function resumeBackgroundTasks() {
    fetch("/api/background_tasks/resume", { method: "POST" })
        .then((r) => r.json())
        .then((data) => {
            taskManager.toastManager.show('Success', data.message, 'success');
            loadBackgroundTasksConfig();
        })
        .catch((err) => {
            console.error("Error resuming tasks:", err);
            taskManager.toastManager.show('Error', 'Error resuming tasks', 'danger');
        });
  }

  function stopAllBackgroundTasks() {
    if (!confirm("Are you sure you want to STOP ALL tasks?")) return;
    fetch("/api/background_tasks/stop_all", { method: "POST" })
        .then((r) => r.json())
        .then((data) => {
            taskManager.toastManager.show('Success', data.message, 'success');
            loadBackgroundTasksConfig();
        })
        .catch((err) => {
            console.error("Error stopping tasks:", err);
            taskManager.toastManager.show('Error', 'Error stopping tasks', 'danger');
        });
  }

  function enableAllTasks() {
    fetch("/api/background_tasks/enable", { method: "POST" })
        .then((r) => r.json())
        .then((data) => {
            taskManager.toastManager.show('Success', data.message, 'success');
            loadBackgroundTasksConfig();
        })
        .catch((err) => {
            console.error("Error enabling tasks:", err);
            taskManager.toastManager.show('Error', 'Error enabling tasks', 'danger');
        });
  }

  function disableAllTasks() {
    fetch("/api/background_tasks/disable", { method: "POST" })
        .then((r) => r.json())
        .then((data) => {
            taskManager.toastManager.show('Success', data.message, 'success');
            loadBackgroundTasksConfig();
        })
        .catch((err) => {
            console.error("Error disabling tasks:", err);
            taskManager.toastManager.show('Error', 'Error disabling tasks', 'danger');
        });
  }

  function manualRunTasks(tasksArr) {
    fetch("/api/background_tasks/manual_run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tasks: tasksArr }),
    })
        .then((r) => r.json())
        .then((data) => {
            if (data.status === "success") {
                const msg = "Tasks triggered:\n" +
                    data.results
                        .map((r) => `${r.task}: ${r.success ? "OK" : "Unknown"}`)
                        .join("\n");
                taskManager.toastManager.show('Success', msg, 'success');
                
                // Add tasks to active tasks map for status tracking
                tasksArr.forEach(taskId => {
                    if (taskId !== 'ALL') {
                        taskManager.activeTasksMap.set(taskId, 'RUNNING');
                    }
                });
            } else {
                taskManager.toastManager.show('Error', 'Error: ' + data.message, 'danger');
            }
        })
        .catch((err) => {
            console.error("Error triggering tasks manually:", err);
            taskManager.toastManager.show('Error', 'Error triggering tasks. Check console.', 'danger');
        });
  }
})();

class SettingsManager {
  constructor() {
    this.initializeEventListeners();
    this.initializeDatePickers();
    this.toastManager = new ToastManager();
  }

  initializeDatePickers() {
    // Initialize flatpickr datepickers
    const dateConfig = {
      dateFormat: "Y-m-d",
      maxDate: "today",
      enableTime: false,
      static: true
    };
    flatpickr(".datepicker", dateConfig);
  }

  initializeEventListeners() {
    // Task Management Event Listeners
    this.initializeTaskManagementListeners();
    
    // Data Management Event Listeners
    this.initializeDataManagementListeners();
    
    // Remap Functionality Listeners
    this.initializeRemapListeners();
  }

  initializeTaskManagementListeners() {
    // These are already handled in the inline script
    // They're working well with the new task manager
  }

  initializeDataManagementListeners() {
    // Historical Data
    document.getElementById('load-historical-data')?.addEventListener('click', async () => {
      await this.loadHistoricalData();
    });

    // GeoPoint Update
    document.getElementById('update-geo-points')?.addEventListener('click', async () => {
      await this.updateGeoPoints();
    });

    // Re-geocode Trips
    document.getElementById('re-geocode-all-trips')?.addEventListener('click', async () => {
      await this.regecodeAllTrips();
    });
  }

  initializeRemapListeners() {
    // Remap type selector
    const remapType = document.getElementById('remap-type');
    const dateRangeDiv = document.getElementById('remap-date-range');
    const intervalDiv = document.getElementById('remap-interval');

    if (remapType) {
      remapType.addEventListener('change', () => {
        if (remapType.value === 'date') {
          dateRangeDiv.style.display = 'block';
          intervalDiv.style.display = 'none';
        } else {
          dateRangeDiv.style.display = 'none';
          intervalDiv.style.display = 'block';
        }
      });
    }

    // Remap button
    document.getElementById('remap-btn')?.addEventListener('click', async () => {
      await this.remapTrips();
    });
  }

  async loadHistoricalData() {
    try {
      const statusElement = document.getElementById('historical-data-status');
      statusElement.textContent = 'Loading historical data...';

      const response = await fetch('/load_historical_data', {
        method: 'POST'
      });
      const data = await response.json();
      
      statusElement.textContent = data.message;
      this.toastManager.show('Success', data.message, 'success');
    } catch (error) {
      console.error('Error loading historical data:', error);
      this.toastManager.show('Error', 'Error loading historical data. Check console for details.', 'danger');
    }
  }

  async updateGeoPoints() {
    try {
      const collection = document.getElementById('collection-select').value;
      const statusElement = document.getElementById('update-geo-points-status');
      statusElement.textContent = 'Updating GeoPoints...';

      const response = await fetch('/update_geo_points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection })
      });
      const data = await response.json();
      
      statusElement.textContent = data.message;
      this.toastManager.show('Success', data.message, 'success');
    } catch (error) {
      console.error('Error updating GeoPoints:', error);
      this.toastManager.show('Error', 'Error updating GeoPoints. Check console for details.', 'danger');
    }
  }

  async regecodeAllTrips() {
    try {
      const statusElement = document.getElementById('re-geocode-all-trips-status');
      statusElement.textContent = 'Re-geocoding all trips...';

      const response = await fetch('/api/regeocode_all_trips', {
        method: 'POST'
      });
      const data = await response.json();
      
      statusElement.textContent = 'All trips have been re-geocoded.';
      this.toastManager.show('Success', data.message, 'success');
    } catch (error) {
      console.error('Error re-geocoding trips:', error);
      statusElement.textContent = 'Error re-geocoding trips. See console.';
      this.toastManager.show('Error', 'Error re-geocoding trips. See console.', 'danger');
    }
  }

  async remapTrips() {
    try {
      const statusElement = document.getElementById('remap-status');
      statusElement.textContent = 'Processing...';

      const method = document.getElementById('remap-type').value;
      let start_date, end_date, interval_days = 0;

      if (method === 'date') {
        start_date = document.getElementById('remap-start').value;
        end_date = document.getElementById('remap-end').value;
        if (!start_date || !end_date) {
          this.toastManager.show('Error', 'Please select both start and end dates.', 'danger');
          return;
        }
      } else {
        interval_days = parseInt(document.getElementById('remap-interval-select').value, 10);
        const now = new Date();
        start_date = new Date(now);
        start_date.setDate(start_date.getDate() - interval_days);
        start_date = start_date.toISOString().split('T')[0];
        end_date = now.toISOString().split('T')[0];
      }

      // First, delete existing matched trips in the range
      const deleteResponse = await fetch('/api/matched_trips/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_date, end_date })
      });
      const deleteResult = await deleteResponse.json();
      
      if (deleteResult.status !== 'success') {
        throw new Error(deleteResult.message || 'Failed to delete existing matched trips');
      }

      // Then, remap the trips
      const remapResponse = await fetch('/api/matched_trips/remap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_date, end_date, interval_days })
      });
      const remapResult = await remapResponse.json();

      statusElement.textContent = remapResult.message;
      if (remapResult.status === 'success') {
        this.toastManager.show('Success', 'Remap process completed successfully.', 'success');
      } else {
        throw new Error(remapResult.message || 'Failed to remap trips');
      }
    } catch (error) {
      console.error('Error during remap process:', error);
      document.getElementById('remap-status').textContent = 'Error: ' + error.message;
      this.toastManager.show('Error', 'Error during remap process. Check console for details.', 'danger');
    }
  }
}

class ToastManager {
  constructor() {
    this.container = document.querySelector('.toast-container');
    this.template = document.getElementById('toast-template');
  }

  show(title, message, type = 'info') {
    const toast = this.template.content.cloneNode(true).querySelector('.toast');
    const icon = toast.querySelector('.toast-icon');
    icon.className = `rounded me-2 bg-${type}`;
    toast.querySelector('.toast-title').textContent = title;
    toast.querySelector('.toast-body').textContent = message;
    
    this.container.appendChild(toast);
    const bsToast = new bootstrap.Toast(toast, { delay: 5000 });
    bsToast.show();
    
    toast.addEventListener('hidden.bs.toast', () => {
      toast.remove();
    });
  }
}

class TaskManager {
  constructor() {
    this.toastManager = new ToastManager();
    this.activeTasksMap = new Map();
    this.pollingInterval = null;
    this.initializePolling();
  }

  initializePolling() {
    // Poll for task updates every 2 seconds
    this.pollingInterval = setInterval(() => this.pollTaskStatus(), 2000);
  }

  async pollTaskStatus() {
    if (this.activeTasksMap.size === 0) return;

    try {
      const response = await fetch('/api/background_tasks/config');
      if (!response.ok) {
        throw new Error('Failed to fetch task status');
      }
      const config = await response.json();
      
      for (const [taskId, status] of this.activeTasksMap) {
        const taskConfig = config.tasks[taskId];
        if (taskConfig) {
          this.updateTaskStatus(taskId, taskConfig);
        }
      }
    } catch (error) {
      console.error('Error polling task status:', error);
    }
  }

  updateTaskStatus(taskId, taskConfig) {
    const row = document.querySelector(`tr[data-task-id="${taskId}"]`);
    if (!row) return;

    const statusCell = row.querySelector('.task-status');
    const lastRunCell = row.querySelector('.task-last-run');
    const nextRunCell = row.querySelector('.task-next-run');
    const runButton = row.querySelector('.run-now-btn');

    if (!statusCell || !lastRunCell || !nextRunCell) {
      console.error(`Missing required cells for task ${taskId}`);
      return;
    }

    // Update status
    const newStatus = taskConfig.status || 'IDLE';
    statusCell.innerHTML = this.getStatusHTML(newStatus);

    // Update timestamps
    if (taskConfig.last_run) {
      lastRunCell.textContent = formatDateTime(taskConfig.last_run);
    }
    if (taskConfig.next_run) {
      nextRunCell.textContent = formatDateTime(taskConfig.next_run);
    }

    // Handle completion states
    if (newStatus === 'COMPLETED' || newStatus === 'FAILED') {
      this.activeTasksMap.delete(taskId);
      this.toastManager.show(
        'Task Update',
        `Task ${taskId} ${newStatus.toLowerCase()}`,
        newStatus === 'COMPLETED' ? 'success' : 'danger'
      );
      
      // Re-enable the run button
      if (runButton) {
        runButton.disabled = false;
      }

      // Update task history
      this.updateTaskHistory();
    }
  }

  getStatusHTML(status) {
    const statusTemplate = document.getElementById('task-status-template');
    if (!statusTemplate) {
      console.error('Task status template not found');
      return `<span class="badge bg-${this.getStatusColor(status)}">${status}</span>`;
    }

    try {
      if (status === 'RUNNING') {
        const statusElement = statusTemplate.content.cloneNode(true);
        return statusElement.querySelector('.task-status').outerHTML;
      }
      return `<span class="badge bg-${this.getStatusColor(status)}">${status}</span>`;
    } catch (error) {
      console.error('Error generating status HTML:', error);
      return `<span class="badge bg-${this.getStatusColor(status)}">${status}</span>`;
    }
  }

  getStatusColor(status) {
    const colors = {
      'IDLE': 'secondary',
      'RUNNING': 'primary',
      'COMPLETED': 'success',
      'FAILED': 'danger',
      'PAUSED': 'warning'
    };
    return colors[status] || 'secondary';
  }

  async runTask(taskId) {
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
        
        // Update UI immediately
        const row = document.querySelector(`tr[data-task-id="${taskId}"]`);
        if (row) {
          const statusCell = row.querySelector('.task-status');
          if (statusCell) {
            statusCell.innerHTML = this.getStatusHTML('RUNNING');
          }
          
          // Disable the run button while task is running
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

  async updateTaskHistory() {
    try {
      const response = await fetch('/api/background_tasks/history');
      if (!response.ok) {
        throw new Error('Failed to fetch task history');
      }
      const history = await response.json();
      updateTaskHistoryTable(history);
    } catch (error) {
      console.error('Error updating task history:', error);
    }
  }
}
