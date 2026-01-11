/* global bootstrap */

/**
 * Task Manager Modals
 * Handles modal dialogs for task details, errors, and confirmations
 */

import { fetchTaskDetails } from "./api.js";
import { escapeHtml, formatDateTime, getStatusHTML } from "./formatters.js";

/**
 * Show an error modal with the given error message
 * @param {string} errorMessage - Error message to display
 */
export function showErrorModal(errorMessage) {
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

  const errorContent = modal.querySelector(".error-details");
  errorContent.textContent = errorMessage;

  const bsModal = new bootstrap.Modal(modal);
  bsModal.show();
}

/**
 * Show a dependency error modal
 * @param {string} _taskId - Task ID (unused but kept for API compatibility)
 * @param {string} errorMessage - Error message to display
 */
export function showDependencyErrorModal(_taskId, errorMessage) {
  let modal = document.getElementById("dependencyErrorModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "dependencyErrorModal";
    modal.className = "modal fade";
    modal.setAttribute("tabindex", "-1");
    modal.innerHTML = `
      <div class="modal-dialog">
        <div class="modal-content bg-dark text-white">
          <div class="modal-header bg-warning text-dark">
            <h5 class="modal-title"><i class="fas fa-exclamation-triangle"></i> Task Dependency Error</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            <p class="dependency-error-message"></p>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  const messageEl = modal.querySelector(".dependency-error-message");
  messageEl.textContent = errorMessage;

  const bsModal = new bootstrap.Modal(modal);
  bsModal.show();
}

/**
 * Show the task details modal and load task information
 * @param {string} taskId - ID of the task to show details for
 */
export async function showTaskDetails(taskId) {
  const modal = document.getElementById("taskDetailsModal");
  if (!modal) {
    return;
  }

  const modalBody = modal.querySelector(".modal-body");
  const runBtn = modal.querySelector(".run-task-btn");

  if (runBtn) {
    runBtn.dataset.taskId = taskId;
  }

  modalBody.innerHTML =
    '<div class="text-center"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';

  const bsModal = new bootstrap.Modal(modal);
  bsModal.show();

  try {
    const details = await fetchTaskDetails(taskId);

    modalBody.innerHTML = `
      <div class="task-details">
        <h6>${details.display_name || taskId}</h6>
        <p class="text-muted small">${taskId}</p>

        <div class="row mb-3">
          <div class="col-6">
            <strong>Status:</strong><br>
            ${getStatusHTML(details.status || "IDLE")}
          </div>
          <div class="col-6">
            <strong>Enabled:</strong><br>
            ${details.enabled ? '<span class="badge bg-success">Yes</span>' : '<span class="badge bg-secondary">No</span>'}
          </div>
        </div>

        <div class="row mb-3">
          <div class="col-6">
            <strong>Interval:</strong><br>
            ${details.interval_minutes ? `${details.interval_minutes} minutes` : "Manual"}
          </div>
          <div class="col-6">
            <strong>Run Count:</strong><br>
            ${details.run_count || 0}
          </div>
        </div>

        <div class="row mb-3">
          <div class="col-6">
            <strong>Last Run:</strong><br>
            ${details.last_run ? formatDateTime(details.last_run) : "Never"}
          </div>
          <div class="col-6">
            <strong>Next Run:</strong><br>
            ${details.next_run ? formatDateTime(details.next_run) : "Not scheduled"}
          </div>
        </div>

        ${
          details.last_error
            ? `
        <div class="alert alert-danger">
          <strong>Last Error:</strong><br>
          <pre class="mb-0" style="white-space: pre-wrap;">${escapeHtml(details.last_error)}</pre>
        </div>
        `
            : ""
        }

        ${
          details.description
            ? `
        <div class="mt-3">
          <strong>Description:</strong><br>
          <p class="text-muted">${details.description}</p>
        </div>
        `
            : ""
        }
      </div>
    `;
  } catch (error) {
    modalBody.innerHTML = `
      <div class="alert alert-danger">
        Failed to load task details: ${error.message}
      </div>
    `;
  }
}
