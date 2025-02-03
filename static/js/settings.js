(() => {
    'use strict';
  
    // Initialize settings on DOM load
    document.addEventListener('DOMContentLoaded', () => {
      loadBackgroundTasksConfig();
      setupTaskConfigEventListeners();
      setupHistoricalData();
      setupGeoPointsUpdate();
      setupRegeocode();
    });
  
    // --- HISTORICAL DATA MANAGEMENT ---
    function setupHistoricalData() {
      const btn = document.getElementById('load-historical-data');
      if (!btn) return;
      btn.addEventListener('click', () => {
        showLoadingOverlay();
        fetch('/load_historical_data', { method: 'POST' })
          .then(r => r.json())
          .then(data => {
            document.getElementById('historical-data-status').textContent = data.message;
            alert(data.message);
          })
          .catch(err => {
            console.error('Error loading historical data:', err);
            alert('Error loading historical data. Check console.');
          })
          .finally(hideLoadingOverlay);
      });
    }
  
    // --- GEOPOINT UPDATES ---
    function setupGeoPointsUpdate() {
      const btn = document.getElementById('update-geo-points');
      const select = document.getElementById('collection-select');
      if (btn && select) {
        btn.addEventListener('click', () => {
          const collection = select.value;
          document.getElementById('update-geo-points-status').textContent = 'Updating...';
          fetch('/update_geo_points', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ collection }),
          })
            .then(r => r.json())
            .then(data => {
              document.getElementById('update-geo-points-status').textContent = data.message;
            })
            .catch(err => console.error('Error updating GeoPoints:', err));
        });
      }
    }
  
    // --- RE-GEOCODE ALL TRIPS ---
    function setupRegeocode() {
      const btn = document.getElementById('re-geocode-all-trips');
      if (btn) {
        btn.addEventListener('click', () => {
          document.getElementById('re-geocode-all-trips-status').textContent = 'Re-geocoding all trips...';
          fetch('/api/regeocode_all_trips', { method: 'POST' })
            .then(r => r.json())
            .then(data => {
              document.getElementById('re-geocode-all-trips-status').textContent = 'All trips have been re-geocoded.';
              alert(data.message);
            })
            .catch(err => {
              console.error('Error re-geocoding trips:', err);
              document.getElementById('re-geocode-all-trips-status').textContent = 'Error re-geocoding trips. See console.';
            });
        });
      }
    }
  
    // --- BACKGROUND TASK CONFIGURATION ---
    function setupTaskConfigEventListeners() {
      document.getElementById('saveTaskConfigBtn')?.addEventListener('click', saveBackgroundTasksConfig);
      document.getElementById('confirmPause')?.addEventListener('click', confirmPause);
      document.getElementById('resumeBtn')?.addEventListener('click', resumeBackgroundTasks);
      document.getElementById('stopAllBtn')?.addEventListener('click', stopAllBackgroundTasks);
      document.getElementById('enableAllBtn')?.addEventListener('click', enableAllTasks);
      document.getElementById('disableAllBtn')?.addEventListener('click', disableAllTasks);
      document.getElementById('manualRunAllBtn')?.addEventListener('click', () => manualRunTasks(['ALL']));
  
      const globalSwitch = document.getElementById('globalDisableSwitch');
      if (globalSwitch) {
        globalSwitch.addEventListener('change', function () {
          const config = gatherTaskConfigFromUI();
          config.globalDisable = this.checked;
          submitTaskConfigUpdate(config)
            .then(() => console.log('Global disable toggled.'))
            .catch(err => console.error('Error toggling global disable:', err));
        });
      }
    }
  
    // --- LOAD TASK CONFIGURATION ---
    function loadBackgroundTasksConfig() {
      fetch('/api/background_tasks/config')
        .then(r => r.json())
        .then(cfg => populateTaskConfigUI(cfg))
        .catch(err => console.error('Error loading background task config:', err));
    }
  
    // --- POPULATE TASK CONFIGURATION UI ---
    function populateTaskConfigUI(cfg) {
      document.getElementById('globalDisableSwitch').checked = !!cfg.disabled;
      const tableBody = document.querySelector('#taskConfigTable tbody');
      if (!tableBody || !cfg.tasks) return;
      tableBody.innerHTML = '';
  
      const intervalOptions = [
        { value: 30, label: 'Every 30 min' },
        { value: 60, label: 'Every 1 hour' },
        { value: 180, label: 'Every 3 hours' },
        { value: 360, label: 'Every 6 hours' },
        { value: 720, label: 'Every 12 hours' },
        { value: 1440, label: 'Every 24 hours' },
      ];
  
      const knownTasks = [
        { id: "fetch_and_store_trips", name: "Fetch & Store Trips" },
        { id: "periodic_fetch_trips", name: "Periodic Trip Fetch" },
        { id: "update_coverage_for_all_locations", name: "Update Coverage (All)" },
        { id: "cleanup_stale_trips", name: "Cleanup Stale Trips" },
        { id: "cleanup_invalid_trips", name: "Cleanup Invalid Trips" },
      ];
  
      knownTasks.forEach(task => {
        const row = document.createElement('tr');
  
        const tdName = document.createElement('td');
        tdName.textContent = task.name;
        row.appendChild(tdName);
  
        const tdInterval = document.createElement('td');
        const currentInterval = cfg.tasks[task.id]?.interval_minutes || 60;
        const sel = document.createElement("select");
        sel.className = "form-select form-select-sm w-auto";
        intervalOptions.forEach(opt => {
          const optionEl = document.createElement("option");
          optionEl.value = opt.value;
          optionEl.textContent = opt.label;
          if (opt.value == currentInterval) optionEl.selected = true;
          sel.appendChild(optionEl);
        });
        sel.dataset.taskId = task.id;
        tdInterval.appendChild(sel);
        row.appendChild(tdInterval);
  
        const tdEnable = document.createElement('td');
        const enableCheck = document.createElement('input');
        enableCheck.type = 'checkbox';
        enableCheck.classList.add('form-check-input');
        enableCheck.checked = !!cfg.tasks[task.id]?.enabled;
        enableCheck.dataset.taskId = task.id;
        tdEnable.appendChild(enableCheck);
        row.appendChild(tdEnable);
  
        const tdRun = document.createElement('td');
        const btnRun = document.createElement('button');
        btnRun.className = 'btn btn-sm btn-info';
        btnRun.textContent = 'Run Now';
        btnRun.addEventListener('click', () => manualRunTasks([task.id]));
        tdRun.appendChild(btnRun);
        row.appendChild(tdRun);
  
        tableBody.appendChild(row);
      });
    }
  
    // --- SAVE TASK CONFIGURATION ---
    function saveBackgroundTasksConfig() {
      const config = gatherTaskConfigFromUI();
      submitTaskConfigUpdate(config)
        .then(() => {
          alert('Background task config saved.');
          loadBackgroundTasksConfig();
        })
        .catch(err => {
          console.error('Error saving config:', err);
          alert('Failed to save config. Check console.');
        });
    }
  
    function gatherTaskConfigFromUI() {
      const tasks = {};
      document.querySelectorAll('#taskConfigTable tbody tr').forEach(row => {
        const sel = row.querySelector('select');
        const check = row.querySelector('input[type="checkbox"]');
        if (!sel || !check) return;
        const taskId = sel.dataset.taskId;
        tasks[taskId] = {
          interval_minutes: parseInt(sel.value, 10),
          enabled: check.checked,
        };
      });
      return {
        globalDisable: document.getElementById('globalDisableSwitch').checked,
        tasks: tasks,
      };
    }
  
    function submitTaskConfigUpdate(config) {
      return fetch('/api/background_tasks/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      }).then(res => {
        if (!res.ok) {
          return res.json().then(errData => {
            throw new Error(errData.message || "Error updating config");
          });
        }
        return res.json();
      });
    }
  
    // --- TASK CONTROLS ---
    function confirmPause() {
      const mins = parseInt(document.getElementById('pauseDuration').value, 10);
      fetch('/api/background_tasks/pause', { method: 'POST', body: JSON.stringify({ minutes: mins }) })
        .then(r => r.json())
        .then(data => {
          alert(data.message);
          loadBackgroundTasksConfig();
          const pauseModal = document.getElementById("pauseModal");
          const modalInstance = bootstrap.Modal.getInstance(pauseModal);
          modalInstance.hide();
        })
        .catch(err => {
          console.error("Error pausing tasks:", err);
          alert("Error pausing tasks");
        });
    }
  
    function resumeBackgroundTasks() {
      fetch('/api/background_tasks/resume', { method: 'POST' })
        .then(r => r.json())
        .then(data => {
          alert(data.message);
          loadBackgroundTasksConfig();
        })
        .catch(err => {
          console.error("Error resuming tasks:", err);
          alert("Error resuming tasks");
        });
    }
  
    function stopAllBackgroundTasks() {
      if (!confirm("Are you sure you want to STOP ALL tasks?")) return;
      fetch('/api/background_tasks/stop_all', { method: 'POST' })
        .then(r => r.json())
        .then(data => {
          alert(data.message);
          loadBackgroundTasksConfig();
        })
        .catch(err => {
          console.error("Error stopping tasks:", err);
          alert("Error stopping tasks");
        });
    }
  
    function enableAllTasks() {
      fetch('/api/background_tasks/enable', { method: 'POST' })
        .then(r => r.json())
        .then(data => {
          alert(data.message);
          loadBackgroundTasksConfig();
        })
        .catch(err => {
          console.error("Error enabling tasks:", err);
          alert("Error enabling tasks");
        });
    }
  
    function disableAllTasks() {
      fetch('/api/background_tasks/disable', { method: 'POST' })
        .then(r => r.json())
        .then(data => {
          alert(data.message);
          loadBackgroundTasksConfig();
        })
        .catch(err => {
          console.error("Error disabling tasks:", err);
          alert("Error disabling tasks");
        });
    }
  
    function manualRunTasks(tasksArr) {
      fetch('/api/background_tasks/manual_run', { 
        method: 'POST', 
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tasks: tasksArr }),
      })
        .then(r => r.json())
        .then(data => {
          if (data.status === "success") {
            const msg = "Tasks triggered:\n" + data.results.map(r => `${r.task}: ${r.success ? "OK" : "Unknown"}`).join("\n");
            alert(msg);
          } else {
            alert("Error: " + data.message);
          }
        })
        .catch(err => {
          console.error("Error triggering tasks manually:", err);
          alert("Error triggering tasks. Check console.");
        });
    }
  })();