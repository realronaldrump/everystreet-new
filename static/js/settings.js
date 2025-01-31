document.addEventListener('DOMContentLoaded', () => {
    loadBackgroundTasksConfig();
    setupTaskConfigEventListeners();
    setupHistoricalData();
    setupGeoPointsUpdate();
    setupRegeocode();
});

/***************************************************
 * HISTORICAL DATA MANAGEMENT
 ***************************************************/
function setupHistoricalData() {
    const loadHistoricalDataBtn = document.getElementById('load-historical-data');
    if (loadHistoricalDataBtn) {
        loadHistoricalDataBtn.addEventListener('click', () => {
            showLoadingOverlay();
            fetch('/load_historical_data', { method: 'POST' })
                .then((r) => r.json())
                .then((data) => {
                    document.getElementById('historical-data-status').textContent = data.message;
                    alert(data.message);
                })
                .catch((err) => {
                    console.error('Error loading historical data:', err);
                    alert('Error loading historical data. Check console.');
                })
                .finally(hideLoadingOverlay);
        });
    }
}

/***************************************************
 * GEOPROINT UPDATES
 ***************************************************/
function setupGeoPointsUpdate() {
    const updateGeoPointsBtn = document.getElementById('update-geo-points');
    const collectionSelect = document.getElementById('collection-select');
    if (updateGeoPointsBtn && collectionSelect) {
        updateGeoPointsBtn.addEventListener('click', () => {
            const collection = collectionSelect.value;
            document.getElementById('update-geo-points-status').textContent = 'Updating...';
            fetch('/update_geo_points', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ collection }),
            })
                .then((r) => r.json())
                .then((data) => {
                    document.getElementById('update-geo-points-status').textContent = data.message;
                })
                .catch((err) => {
                    console.error('Error updating GeoPoints:', err);
                });
        });
    }
}

/***************************************************
 * RE-GEOCODE ALL TRIPS
 ***************************************************/
function setupRegeocode() {
    const regeocodeAllTripsBtn = document.getElementById('re-geocode-all-trips');
    if (regeocodeAllTripsBtn) {
        regeocodeAllTripsBtn.addEventListener('click', () => {
            document.getElementById('re-geocode-all-trips-status').textContent = 'Re-geocoding all trips...';
            fetch('/api/regeocode_all_trips', { method: 'POST' })
                .then((r) => r.json())
                .then((data) => {
                    document.getElementById('re-geocode-all-trips-status').textContent = 'All trips have been re-geocoded.';
                    alert(data.message);
                })
                .catch((err) => {
                    console.error('Error re-geocoding trips:', err);
                    document.getElementById('re-geocode-all-trips-status').textContent = 'Error re-geocoding trips. See console.';
                });
        });
    }
}

/***************************************************
 * BACKGROUND TASK CONFIGURATION
 ***************************************************/
function setupTaskConfigEventListeners() {
    document.getElementById('saveTaskConfigBtn')?.addEventListener('click', saveBackgroundTasksConfig);
    document.getElementById('confirmPause')?.addEventListener('click', confirmPause);
    document.getElementById('resumeBtn')?.addEventListener('click', resumeBackgroundTasks);
    document.getElementById('stopAllBtn')?.addEventListener('click', stopAllBackgroundTasks);
    document.getElementById('enableAllBtn')?.addEventListener('click', enableAllTasks);
    document.getElementById('disableAllBtn')?.addEventListener('click', disableAllTasks);
    document.getElementById('manualRunAllBtn')?.addEventListener('click', () => manualRunTasks(['ALL']));

    const globalDisableSwitch = document.getElementById('globalDisableSwitch');
    if (globalDisableSwitch) {
        globalDisableSwitch.addEventListener('change', function () {
            const config = gatherTaskConfigFromUI();
            config.globalDisable = this.checked;
            submitTaskConfigUpdate(config)
                .then(() => console.log('Global disable toggled.'))
                .catch((err) => console.error('Error toggling global disable:', err));
        });
    }
}

/***************************************************
 * LOAD TASK CONFIGURATION FROM SERVER
 ***************************************************/
function loadBackgroundTasksConfig() {
    fetch('/api/background_tasks/config')
        .then((r) => r.json())
        .then((cfg) => {
            populateTaskConfigUI(cfg);
        })
        .catch((err) => {
            console.error('Error loading background task config:', err);
        });
}

/***************************************************
 * POPULATE TASK CONFIGURATION UI
 ***************************************************/
function populateTaskConfigUI(cfg) {
    document.getElementById('globalDisableSwitch').checked = !!cfg.disabled;

    const tableBody = document.querySelector('#taskConfigTable tbody');
    if (!tableBody) return;

    tableBody.innerHTML = '';
    if (!cfg.tasks) return;

    const intervalOptions = [
        { value: 30, label: 'Every 30 min' },
        { value: 60, label: 'Every 1 hour' },
        { value: 180, label: 'Every 3 hours' },
        { value: 360, label: 'Every 6 hours' },
        { value: 720, label: 'Every 12 hours' },
        { value: 1440, label: 'Every 24 hours' },
    ];

    Object.entries(cfg.tasks).forEach(([taskId, taskData]) => {
        const row = document.createElement('tr');

        const tdName = document.createElement('td');
        tdName.textContent = taskId.replace(/_/g, ' ').toUpperCase();
        row.appendChild(tdName);

        const tdInterval = document.createElement('td');
        const sel = document.createElement('select');
        sel.className = 'form-select form-select-sm w-auto';
        intervalOptions.forEach((opt) => {
            const optionEl = document.createElement('option');
            optionEl.value = opt.value;
            optionEl.textContent = opt.label;
            if (opt.value == taskData.interval_minutes) {
                optionEl.selected = true;
            }
            sel.appendChild(optionEl);
        });
        sel.dataset.taskId = taskId;
        tdInterval.appendChild(sel);
        row.appendChild(tdInterval);

        const tdEnable = document.createElement('td');
        const enableCheck = document.createElement('input');
        enableCheck.type = 'checkbox';
        enableCheck.classList.add('form-check-input');
        enableCheck.checked = !!taskData.enabled;
        enableCheck.dataset.taskId = taskId;
        tdEnable.appendChild(enableCheck);
        row.appendChild(tdEnable);

        const tdRun = document.createElement('td');
        const btnRun = document.createElement('button');
        btnRun.className = 'btn btn-sm btn-info';
        btnRun.textContent = 'Run Now';
        btnRun.addEventListener('click', () => manualRunTasks([taskId]));
        tdRun.appendChild(btnRun);
        row.appendChild(tdRun);

        tableBody.appendChild(row);
    });
}

/***************************************************
 * SAVE TASK CONFIGURATION
 ***************************************************/
function saveBackgroundTasksConfig() {
    const config = gatherTaskConfigFromUI();
    submitTaskConfigUpdate(config)
        .then(() => {
            alert('Background task config saved.');
            loadBackgroundTasksConfig();
        })
        .catch((err) => {
            console.error('Error saving config:', err);
            alert('Failed to save config. Check console.');
        });
}

function gatherTaskConfigFromUI() {
    const tasks = {};
    document.querySelectorAll('#taskConfigTable tbody tr').forEach((row) => {
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
    }).then((res) => res.json());
}

/***************************************************
 * TASK CONTROLS
 ***************************************************/
function confirmPause() {
    const mins = parseInt(document.getElementById('pauseDuration').value, 10);
    fetch('/api/background_tasks/pause', { method: 'POST', body: JSON.stringify({ minutes: mins }) })
        .then(() => loadBackgroundTasksConfig());
}

function resumeBackgroundTasks() {
    fetch('/api/background_tasks/resume', { method: 'POST' }).then(() => loadBackgroundTasksConfig());
}

function stopAllBackgroundTasks() {
    fetch('/api/background_tasks/stop_all', { method: 'POST' }).then(() => loadBackgroundTasksConfig());
}

function enableAllTasks() {
    fetch('/api/background_tasks/enable', { method: 'POST' }).then(() => loadBackgroundTasksConfig());
}

function disableAllTasks() {
    fetch('/api/background_tasks/disable', { method: 'POST' }).then(() => loadBackgroundTasksConfig());
}

function manualRunTasks(tasksArr) {
    fetch('/api/background_tasks/manual_run', { method: 'POST', body: JSON.stringify({ tasks: tasksArr }) });
}