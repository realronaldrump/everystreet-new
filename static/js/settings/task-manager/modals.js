/* global bootstrap */

/**
 * Task Manager Modals
 * Handles modal dialogs for task details, errors, and confirmations
 */

import { fetchTaskDetails } from "./api.js";
import {
  escapeHtml,
  formatDateTime,
  formatDurationMs,
  getStatusHTML,
} from "./formatters.js";

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
 * @param {string} errorMessage - Error message to display
 */
export function showDependencyErrorModal(errorMessage) {
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

  modalBody.innerHTML
    = '<div class="text-center"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';

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

/**
 * Show a modal with task execution logs/results
 * @param {Object} entry - Task history entry object
 */
export function showTaskLogsModal(entry) {
  let modal = document.getElementById("taskLogsModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "taskLogsModal";
    modal.className = "modal fade";
    modal.setAttribute("tabindex", "-1");
    modal.innerHTML = `
      <div class="modal-dialog modal-lg">
        <div class="modal-content bg-dark text-white">
          <div class="modal-header">
            <h5 class="modal-title">Task Execution Logs</h5>
            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            <div id="taskLogsContent"></div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  const contentDiv = modal.querySelector("#taskLogsContent");
  
  // Format the result/error for display
  let resultHtml = '<div class="text-muted fst-italic">No result data available</div>';
  let summaryHtml = "";

  if (entry.result) {
    const jsonStr = JSON.stringify(entry.result, null, 2);
    resultHtml = `<pre class="bg-black p-3 rounded border border-secondary text-info"><code>${escapeHtml(jsonStr)}</code></pre>`;

    // Try to extract metrics for summary
    try {
      const keys = Object.keys(entry.result);
      const metrics = [];
      
      keys.forEach(key => {
        const val = entry.result[key];
        // Check for numeric values or short strings that look like status/counts
        if (typeof val === 'number' || (typeof val === 'string' && val.length < 20) || typeof val === 'boolean') {
           // Skip internal or uninteresting keys if needed, but for now show all top-level primitives
           const label = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
           metrics.push(`<div class="col-md-4 mb-2"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(String(val))}</div>`);
        }
      });

      if (metrics.length > 0) {
        summaryHtml = `
          <div class="card bg-dark border-secondary mb-3">
            <div class="card-header border-secondary bg-dark opacity-75">
              <h6 class="mb-0">Run Summary</h6>
            </div>
            <div class="card-body">
              <div class="row">
                ${metrics.join("")}
              </div>
            </div>
          </div>
        `;
      }
    } catch (e) {
      console.warn("Failed to generate summary", e);
    }
  }

  let errorHtml = "";
  if (entry.error) {
    errorHtml = `
      <div class="alert alert-danger mt-3">
        <h6><i class="fas fa-exclamation-circle"></i> Error</h6>
        <pre class="mb-0" style="white-space: pre-wrap;">${escapeHtml(entry.error)}</pre>
      </div>
    `;
  }

  contentDiv.innerHTML = `
    <div class="mb-3">
      <div class="row">
        <div class="col-md-6">
          <strong>Task ID:</strong> <span class="text-monospace">${entry.task_id || "Unknown"}</span>
        </div>
        <div class="col-md-6 text-md-end">
          <strong>Time:</strong> ${formatDateTime(entry.timestamp)}
        </div>
      </div>
      <div class="row mt-2">
        <div class="col-md-6">
           <strong>Status:</strong> ${getStatusHTML(entry.status)}
        </div>
        <div class="col-md-6 text-md-end">
           <strong>Duration:</strong> ${entry.runtime ? formatDurationMs(parseFloat(entry.runtime)) : "N/A"}
        </div>
      </div>
    </div>
    
    <hr class="border-secondary">
    
    <h6>Execution Result</h6>
    ${summaryHtml}
    ${resultHtml}
    ${errorHtml}
  `;

  const bsModal = new bootstrap.Modal(modal);
  bsModal.show();
}
