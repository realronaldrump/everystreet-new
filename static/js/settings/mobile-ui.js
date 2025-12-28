/* global showLoadingOverlay, hideLoadingOverlay, bootstrap, flatpickr */

import { TaskManager } from "./task-manager.js";

/**
 * Mobile UI module - handles all mobile-specific UI rendering and interactions
 */

export function setupMobileAccordions() {
  const headers = document.querySelectorAll(".mobile-accordion-header");
  headers.forEach((header) => {
    header.addEventListener("click", () => {
      const content = header.nextElementSibling;
      const icon = header.querySelector(".mobile-accordion-icon");
      if (content.classList.contains("expanded")) {
        content.classList.remove("expanded");
        icon?.classList.remove("expanded");
      } else {
        content.classList.add("expanded");
        icon?.classList.add("expanded");
      }
    });
  });
}

export function setupMobileTaskList(taskManager) {
  // Hook into the existing updateTaskConfigTable function
  const originalUpdate = taskManager?.updateTaskConfigTable;
  if (!originalUpdate) return;

  taskManager.updateTaskConfigTable = function (config) {
    originalUpdate.call(this, config);
    updateMobileTaskList(config, taskManager);
  };
}

export function updateMobileTaskList(config, taskManager) {
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
                ${taskManager.intervalOptions
                  .map(
                    (opt) => `
                  <option value="${opt.value}" ${opt.value === task.interval_minutes ? "selected" : ""}>
                    ${opt.label}
                  </option>
                `,
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
      taskManager?.runTask(taskId);
    });
  });

  mobileList.querySelectorAll(".mobile-stop-task").forEach((btn) => {
    btn.addEventListener("click", function () {
      const { taskId } = this.dataset;
      taskManager?.forceStopTask(taskId);
    });
  });

  mobileList.querySelectorAll(".mobile-view-task").forEach((btn) => {
    btn.addEventListener("click", function () {
      const { taskId } = this.dataset;
      taskManager?.showTaskDetails(taskId);
    });
  });
}

export function setupMobileHistoryList(taskManager) {
  const originalUpdate = taskManager?.updateTaskHistoryTable;
  if (!originalUpdate) return;

  taskManager.updateTaskHistoryTable = function (history) {
    originalUpdate.call(this, history);
    updateMobileHistoryList(history, taskManager);
  };
}

export function updateMobileHistoryList(history, taskManager) {
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
        durationText = TaskManager.formatDuration(runtimeMs);
      }
    } else if (entry.status === "RUNNING" && entry.timestamp) {
      try {
        const startTime = new Date(entry.timestamp);
        const now = new Date();
        const elapsedMs = now - startTime;
        if (!Number.isNaN(elapsedMs) && elapsedMs >= 0) {
          durationText = TaskManager.formatDuration(elapsedMs);
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

    const statusClass = TaskManager.getStatusColor(entry.status);

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
        data-error="${taskManager.escapeHtml(entry.error)}">
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
      taskManager?.showErrorModal(errorMessage);
    });
  });

  // Update pagination
  updateMobilePagination(taskManager);
}

export function updateMobilePagination(taskManager) {
  const pagination = document.getElementById("mobile-history-pagination");
  const prevBtn = document.getElementById("mobile-history-prev");
  const nextBtn = document.getElementById("mobile-history-next");
  const pageInfo = document.getElementById("mobile-history-page-info");

  if (!pagination || !taskManager) return;

  const { currentHistoryPage, historyTotalPages } = taskManager;

  if (historyTotalPages <= 1) {
    pagination.style.display = "none";
    return;
  }

  pagination.style.display = "flex";
  pageInfo.textContent = `Page ${currentHistoryPage} of ${historyTotalPages}`;

  prevBtn.disabled = currentHistoryPage === 1;
  nextBtn.disabled = currentHistoryPage === historyTotalPages;

  prevBtn.onclick = () => {
    if (taskManager.currentHistoryPage > 1) {
      taskManager.currentHistoryPage--;
      taskManager.updateTaskHistory();
    }
  };

  nextBtn.onclick = () => {
    if (taskManager.currentHistoryPage < taskManager.historyTotalPages) {
      taskManager.currentHistoryPage++;
      taskManager.updateTaskHistory();
    }
  };
}

export function setupMobileGlobalControls() {
  // Global disable switch
  const mobileGlobalSwitch = document.getElementById(
    "mobile-globalDisableSwitch",
  );
  const desktopGlobalSwitch = document.getElementById("globalDisableSwitch");

  if (mobileGlobalSwitch && desktopGlobalSwitch) {
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
      const modal = new bootstrap.Modal(
        document.getElementById("clearHistoryModal"),
      );
      modal.show();
    });
  }
}

export function setupMobileManualFetch(taskManager) {
  const form = document.getElementById("mobile-manualFetchTripsForm");
  if (!form) return;

  const startInput = document.getElementById("mobile-manual-fetch-start");
  const endInput = document.getElementById("mobile-manual-fetch-end");
  const mapMatchInput = document.getElementById(
    "mobile-manual-fetch-map-match",
  );
  const statusEl = document.getElementById("mobile-manual-fetch-status");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!taskManager) return;

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
      await taskManager.scheduleManualFetch(
        startDate.toISOString(),
        endDate.toISOString(),
        mapMatchEnabled,
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

export function setupMobileDataManagement() {
  setupMobileGeocodeTrips();
  setupMobileRemapTrips();
}

export function setupMobileGeocodeTrips() {
  const geocodeTabs = document.querySelectorAll(
    '.mobile-date-method-tab[data-target="geocode"]',
  );
  const geocodeDateRange = document.getElementById("mobile-geocode-date-range");
  const geocodeInterval = document.getElementById("mobile-geocode-interval");
  const geocodeBtn = document.getElementById("mobile-geocode-trips-btn");
  const progressPanel = document.getElementById(
    "mobile-geocode-progress-panel",
  );
  const progressBar = document.getElementById("mobile-geocode-progress-bar");
  const progressMessage = document.getElementById(
    "mobile-geocode-progress-message",
  );
  const progressMetrics = document.getElementById(
    "mobile-geocode-progress-metrics",
  );
  const statusEl = document.getElementById("mobile-geocode-trips-status");

  if (!geocodeBtn) return;

  // Handle tab clicks
  geocodeTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      geocodeTabs.forEach((t) => {
        t.classList.remove("active");
      });
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
      '.mobile-date-method-tab[data-target="geocode"].active',
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
          "danger",
        );
        return;
      }
    } else if (method === "interval") {
      interval_days = parseInt(
        document.getElementById("mobile-geocode-interval-select")?.value || "0",
        10,
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
          "progress-bar-striped",
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
            `/api/geocode_trips/progress/${taskId}`,
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

          if (progressBar) {
            progressBar.style.width = `${progress}%`;
            progressBar.textContent = `${progress}%`;
            progressBar.setAttribute("aria-valuenow", progress);
          }

          if (progressMessage) progressMessage.textContent = message;

          if (progressMetrics && metrics.total > 0) {
            progressMetrics.textContent = `Total: ${metrics.total} | Updated: ${metrics.updated || 0} | Skipped: ${metrics.skipped || 0} | Failed: ${metrics.failed || 0}`;
          }

          if (stage === "completed" || stage === "error") {
            clearInterval(pollInterval);
            geocodeBtn.disabled = false;

            if (stage === "completed") {
              if (progressBar) {
                progressBar.classList.remove(
                  "progress-bar-animated",
                  "progress-bar-striped",
                  "bg-primary",
                  "bg-danger",
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
                "success",
              );
            } else {
              if (progressBar) {
                progressBar.classList.remove(
                  "progress-bar-animated",
                  "progress-bar-striped",
                  "bg-primary",
                  "bg-success",
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
                "danger",
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
            "warning",
          );
        }
      }, 1000);
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
  } else if (typeof flatpickr !== "undefined") {
    flatpickr(".datepicker", {
      enableTime: false,
      dateFormat: "Y-m-d",
    });
  }
}

export function setupMobileRemapTrips() {
  const dateTab = document.querySelector(
    '.mobile-date-method-tab[data-method="date"]',
  );
  const intervalTab = document.querySelector(
    '.mobile-date-method-tab[data-method="interval"]',
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

  const remapBtn = document.getElementById("mobile-remap-btn");
  const remapStatus = document.getElementById("mobile-remap-status");

  if (remapBtn) {
    remapBtn.addEventListener("click", async () => {
      const method =
        document.querySelector(".mobile-date-method-tab.active")?.dataset
          .method || "date";
      let start_date;
      let end_date;
      let interval_days = 0;

      if (method === "date") {
        start_date = document.getElementById("mobile-remap-start").value;
        end_date = document.getElementById("mobile-remap-end").value;
        if (!start_date || !end_date) {
          window.notificationManager.show(
            "Please select both start and end dates",
            "danger",
          );
          return;
        }
      } else {
        interval_days = parseInt(
          document.getElementById("mobile-remap-interval-select").value,
          10,
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
  } else if (typeof flatpickr !== "undefined") {
    flatpickr(".mobile-form-input.datepicker", {
      enableTime: false,
      dateFormat: "Y-m-d",
    });
  }
}

export function setupMobileSaveFAB(taskManager) {
  const fab = document.getElementById("mobile-save-config-fab");
  if (!fab) return;

  fab.addEventListener("click", () => {
    if (!taskManager) return;

    // Gather mobile config
    const mobileGlobalSwitch = document.getElementById(
      "mobile-globalDisableSwitch",
    );
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

    taskManager
      .submitTaskConfigUpdate(config)
      .then(() => {
        window.notificationManager.show(
          "Task configuration updated successfully",
          "success",
        );
        fab.classList.add("saved");
        setTimeout(() => fab.classList.remove("saved"), 2000);
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

/**
 * Initialize all mobile UI components
 */
export function initMobileUI(taskManager) {
  setupMobileAccordions();
  setupMobileTaskList(taskManager);
  setupMobileHistoryList(taskManager);
  setupMobileGlobalControls();
  setupMobileManualFetch(taskManager);
  setupMobileDataManagement();
  setupMobileSaveFAB(taskManager);
}
