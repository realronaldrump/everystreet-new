/**
 * Task Manager UI
 * Handles rendering and updating the task configuration table
 */

import { INTERVAL_OPTIONS } from "./constants.js";
import { formatDateTime, getStatusHTML } from "./formatters.js";

/**
 * Render the task configuration table
 * @param {Object} config - Task configuration object
 * @param {Object} intervalOptions - Optional custom interval options (uses default if not provided)
 */
export function renderTaskConfigTable(
  config,
  intervalOptions = INTERVAL_OPTIONS,
) {
  const tbody = document.querySelector("#taskConfigTable tbody");
  if (!tbody) {
    return;
  }

  tbody.innerHTML = "";

  Object.entries(config.tasks).forEach(([taskId, task]) => {
    const row = document.createElement("tr");
    row.dataset.taskId = taskId;

    const isManualOnly = Boolean(task.manual_only);
    row.dataset.manualOnly = isManualOnly ? "true" : "false";
    const taskStatus = task.status || "IDLE";
    const isActive = ["RUNNING", "PENDING"].includes(taskStatus);
    const canForceStop = isActive;

    if (!task.display_name) {
      return;
    }

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
          `,
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
