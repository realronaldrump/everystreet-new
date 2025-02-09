/* global showLoadingOverlay, hideLoadingOverlay, bootstrap, flatpickr */

(() => {
  "use strict";

  // Initialize settings on DOM load
  document.addEventListener("DOMContentLoaded", () => {
    loadBackgroundTasksConfig();
    setupTaskConfigEventListeners();
    setupHistoricalData();
    setupGeoPointsUpdate();
    setupRegeocode();
    setupDeleteMatchedTrips();
    setupRemapMatchedTrips();
    window.settingsManager = new SettingsManager();
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
          alert(data.message);
        })
        .catch((err) => {
          console.error("Error loading historical data:", err);
          alert("Error loading historical data. Check console.");
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
          alert(data.message);
        })
        .catch((err) => {
          console.error("Error re-geocoding trips:", err);
          document.getElementById("re-geocode-all-trips-status").textContent =
            "Error re-geocoding trips. See console.";
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
          alert(data.message);
        })
        .catch((err) => {
          console.error("Error deleting matched trips:", err);
          document.getElementById("delete-matched-trips-status").textContent =
            "Error deleting matched trips. See console.";
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
          alert("Please select both start and end dates.");
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
        })
        .catch((error) => {
          console.error("Error re-matching trips:", error);
          document.getElementById("remap-status").textContent =
            "Error re-matching trips.";
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
          .then(() => console.log("Global disable toggled."))
          .catch((err) => console.error("Error toggling global disable:", err));
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

      const tdRun = document.createElement("td");
      const btnRun = document.createElement("button");
      btnRun.className = "btn btn-sm btn-info";
      btnRun.textContent = "Run Now";
      btnRun.addEventListener("click", () => manualRunTasks([task.id]));
      tdRun.appendChild(btnRun);
      row.appendChild(tdRun);

      tableBody.appendChild(row);
    });
  }

  // SAVE TASK CONFIGURATION
  function saveBackgroundTasksConfig() {
    const config = gatherTaskConfigFromUI();
    submitTaskConfigUpdate(config)
      .then(() => {
        alert("Background task config saved.");
        loadBackgroundTasksConfig();
      })
      .catch((err) => {
        console.error("Error saving config:", err);
        alert("Failed to save config. Check console.");
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
        alert(data.message);
        loadBackgroundTasksConfig();
        const pauseModal = document.getElementById("pauseModal");
        const modalInstance = bootstrap.Modal.getInstance(pauseModal);
        if (modalInstance) modalInstance.hide();
      })
      .catch((err) => {
        console.error("Error pausing tasks:", err);
        alert("Error pausing tasks");
      });
  }

  function resumeBackgroundTasks() {
    fetch("/api/background_tasks/resume", { method: "POST" })
      .then((r) => r.json())
      .then((data) => {
        alert(data.message);
        loadBackgroundTasksConfig();
      })
      .catch((err) => {
        console.error("Error resuming tasks:", err);
        alert("Error resuming tasks");
      });
  }

  function stopAllBackgroundTasks() {
    if (!confirm("Are you sure you want to STOP ALL tasks?")) return;
    fetch("/api/background_tasks/stop_all", { method: "POST" })
      .then((r) => r.json())
      .then((data) => {
        alert(data.message);
        loadBackgroundTasksConfig();
      })
      .catch((err) => {
        console.error("Error stopping tasks:", err);
        alert("Error stopping tasks");
      });
  }

  function enableAllTasks() {
    fetch("/api/background_tasks/enable", { method: "POST" })
      .then((r) => r.json())
      .then((data) => {
        alert(data.message);
        loadBackgroundTasksConfig();
      })
      .catch((err) => {
        console.error("Error enabling tasks:", err);
        alert("Error enabling tasks");
      });
  }

  function disableAllTasks() {
    fetch("/api/background_tasks/disable", { method: "POST" })
      .then((r) => r.json())
      .then((data) => {
        alert(data.message);
        loadBackgroundTasksConfig();
      })
      .catch((err) => {
        console.error("Error disabling tasks:", err);
        alert("Error disabling tasks");
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
          const msg =
            "Tasks triggered:\n" +
            data.results
              .map((r) => `${r.task}: ${r.success ? "OK" : "Unknown"}`)
              .join("\n");
          alert(msg);
        } else {
          alert("Error: " + data.message);
        }
      })
      .catch((err) => {
        console.error("Error triggering tasks manually:", err);
        alert("Error triggering tasks. Check console.");
      });
  }
})();

class SettingsManager {
  constructor() {
    this.initializeEventListeners();
    this.initializeDatePickers();
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
      alert(data.message);
    } catch (error) {
      console.error('Error loading historical data:', error);
      alert('Error loading historical data. Check console for details.');
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
    } catch (error) {
      console.error('Error updating GeoPoints:', error);
      alert('Error updating GeoPoints. Check console for details.');
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
      alert(data.message);
    } catch (error) {
      console.error('Error re-geocoding trips:', error);
      statusElement.textContent = 'Error re-geocoding trips. See console.';
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
          alert('Please select both start and end dates.');
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
        alert('Remap process completed successfully.');
      } else {
        throw new Error(remapResult.message || 'Failed to remap trips');
      }
    } catch (error) {
      console.error('Error during remap process:', error);
      document.getElementById('remap-status').textContent = 'Error: ' + error.message;
      alert('Error during remap process. Check console for details.');
    }
  }
}
