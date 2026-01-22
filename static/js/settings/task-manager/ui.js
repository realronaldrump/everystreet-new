/**
 * Task Manager UI
 * Handles rendering and updating the task configuration table
 */

import { INTERVAL_OPTIONS } from "./constants.js";
import { formatDateTime, getStatusHTML } from "./formatters.js";

/**
 * Render the task configuration table using merge strategy.
 * Updates only dynamic cells (status, times, buttons) while preserving user-editable
 * form inputs (toggles, interval selects) to prevent state loss during SSE/polling updates.
 *
 * @param {Object} config - Task configuration object
 * @param {Object} intervalOptions - Optional custom interval options (uses default if not provided)
 */
export function renderTaskConfigTable(config, intervalOptions = INTERVAL_OPTIONS) {
  const tbody = document.querySelector("#taskConfigTable tbody");
  if (!tbody) {
    return;
  }

  const existingTaskIds = new Set();

  Object.entries(config.tasks).forEach(([taskId, task]) => {
    if (!task.display_name) {
      return;
    }

    existingTaskIds.add(taskId);

    const isManualOnly = Boolean(task.manual_only);
    const taskStatus = task.status || "IDLE";
    const isActive = ["RUNNING", "PENDING"].includes(taskStatus);
    const canForceStop = isActive;

    // Check if row already exists
    let row = tbody.querySelector(`tr[data-task-id="${taskId}"]`);

    if (row) {
      // Row exists - update only dynamic cells, preserve form inputs
      row.dataset.manualOnly = isManualOnly ? "true" : "false";

      // Update status cell
      const statusCell = row.querySelector(".task-status");
      if (statusCell && statusCell.dataset.status !== taskStatus) {
        statusCell.innerHTML = getStatusHTML(taskStatus);
        statusCell.dataset.status = taskStatus;
      }

      // Update last run cell
      const lastRunCell = row.querySelector(".task-last-run");
      if (lastRunCell) {
        lastRunCell.textContent = task.last_run
          ? formatDateTime(task.last_run)
          : "Never";
      }

      // Update next run cell
      const nextRunCell = row.querySelector(".task-next-run");
      if (nextRunCell) {
        nextRunCell.textContent = task.next_run
          ? formatDateTime(task.next_run)
          : "Not scheduled";
      }

      // Update button states (but not form inputs!)
      const runButton = row.querySelector(".run-now-btn");
      if (runButton) {
        runButton.disabled = isManualOnly || isActive;
      }

      const forceButton = row.querySelector(".force-stop-btn");
      if (forceButton) {
        forceButton.disabled = !canForceStop;
      }
    } else {
      // New row - create from scratch
      row = document.createElement("tr");
      row.dataset.taskId = taskId;
      row.dataset.manualOnly = isManualOnly ? "true" : "false";

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
            ${intervalOptions
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
        <td class="task-status" data-status="${taskStatus}">${getStatusHTML(taskStatus)}</td>
        <td class="task-last-run">${task.last_run ? formatDateTime(task.last_run) : "Never"}</td>
        <td class="task-next-run">${task.next_run ? formatDateTime(task.next_run) : "Not scheduled"}</td>
        <td>
          <div class="btn-group btn-group-sm">
            <button class="btn btn-info run-now-btn" data-task-id="${taskId}"
              ${isManualOnly || isActive ? "disabled" : ""}
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
    }
  });

  // Remove rows for tasks no longer in config
  tbody.querySelectorAll("tr[data-task-id]").forEach((row) => {
    if (!existingTaskIds.has(row.dataset.taskId)) {
      row.remove();
    }
  });
}

/**
 * Update the global disable switch state
 * @param {boolean} disabled - Whether tasks are globally disabled
 */
export function updateGlobalDisableSwitch(disabled) {
  const globalSwitch = document.getElementById("globalDisableSwitch");
  if (globalSwitch) {
    globalSwitch.checked = Boolean(disabled);
  }
}
