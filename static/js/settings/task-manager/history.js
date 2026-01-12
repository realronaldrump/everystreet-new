/**
 * Task Manager History
 * Handles rendering and updating task execution history
 */

import {
  escapeHtml,
  formatDateTime,
  formatDurationMs,
  getStatusColor,
} from "./formatters.js";
import { showErrorModal } from "./modals.js";

/**
 * Render the task history table
 * @param {Array} history - Array of history entries
 */
export function renderTaskHistoryTable(history) {
  const tbody = document.querySelector("#taskHistoryTable tbody");
  if (!tbody) {
    return;
  }

  tbody.innerHTML = "";

  if (history.length === 0) {
    const row = document.createElement("tr");
    row.innerHTML
      = '<td colspan="6" class="text-center">No task history available</td>';
    tbody.appendChild(row);
    return;
  }

  history.forEach((entry) => {
    const row = document.createElement("tr");

    let durationText = "Unknown";
    if (entry.runtime !== null && entry.runtime !== undefined) {
      const runtimeMs = parseFloat(entry.runtime);
      if (!Number.isNaN(runtimeMs)) {
        durationText = formatDurationMs(runtimeMs);
      }
    } else if (entry.status === "RUNNING" && entry.timestamp) {
      try {
        const startTime = new Date(entry.timestamp);
        const now = new Date();
        const elapsedMs = now - startTime;
        if (!Number.isNaN(elapsedMs) && elapsedMs >= 0) {
          durationText = formatDurationMs(elapsedMs);
          row.dataset.startTime = entry.timestamp;
          row.dataset.isRunning = "true";
        }
      } catch {
        // Error calculating elapsed time - silently ignore
      }
    }

    let resultText = "N/A";
    if (entry.status === "RUNNING") {
      resultText = "Running";
    } else if (entry.status === "PENDING") {
      resultText = "Pending";
    } else if (entry.status === "COMPLETED") {
      resultText = entry.result ? "Success" : "Completed";
    } else if (entry.status === "FAILED") {
      resultText = "Failed";
    } else {
      resultText = "N/A";
    }

    let detailsContent = "N/A";
    if (entry.error) {
      detailsContent = `<button class="btn btn-sm btn-danger view-error-btn"
        data-error="${escapeHtml(entry.error)}">
        <i class="fas fa-exclamation-circle"></i> View Error
      </button>`;
    } else if (entry.status === "COMPLETED") {
      detailsContent
        = '<span class="text-success"><i class="fas fa-check-circle"></i> Completed successfully</span>';
    } else if (entry.status === "RUNNING") {
      detailsContent
        = '<span class="text-info"><i class="fas fa-spinner fa-spin"></i> In progress</span>';
    } else if (entry.status === "FAILED") {
      detailsContent
        = '<span class="text-danger"><i class="fas fa-times-circle"></i> Failed</span>';
    }

    row.innerHTML = `
      <td>${entry.task_id}</td>
      <td>
        <span class="badge bg-${getStatusColor(entry.status)}">
          ${entry.status}
        </span>
      </td>
      <td>${formatDateTime(entry.timestamp)}</td>
      <td class="task-duration">${durationText}</td>
      <td>${resultText}</td>
      <td>${detailsContent}</td>
    `;
    tbody.appendChild(row);
  });

  // Attach error button handlers
  const errorButtons = tbody.querySelectorAll(".view-error-btn");
  errorButtons.forEach((btn) => {
    btn.addEventListener("mousedown", () => {
      const errorMessage = btn.dataset.error;
      showErrorModal(errorMessage);
    });
  });

  // Update running task durations immediately
  updateRunningTaskDurations();
}

/**
 * Update the duration display for currently running tasks
 */
export function updateRunningTaskDurations() {
  // Update desktop table
  const tbody = document.querySelector("#taskHistoryTable tbody");
  if (tbody) {
    tbody.querySelectorAll("tr[data-is-running='true']").forEach((row) => {
      const startTimeStr = row.dataset.startTime;
      if (startTimeStr) {
        try {
          const startTime = new Date(startTimeStr);
          const now = new Date();
          const elapsedMs = now - startTime;
          if (!Number.isNaN(elapsedMs) && elapsedMs >= 0) {
            const durationCell = row.querySelector(".task-duration");
            if (durationCell) {
              durationCell.textContent = formatDurationMs(elapsedMs);
            }
          }
        } catch {
          // Error updating duration - silently ignore
        }
      }
    });
  }

  // Update mobile list
  const mobileList = document.getElementById("mobile-history-list");
  if (mobileList) {
    mobileList
      .querySelectorAll(".mobile-history-card[data-is-running='true']")
      .forEach((card) => {
        const startTimeStr = card.dataset.startTime;
        if (startTimeStr) {
          try {
            const startTime = new Date(startTimeStr);
            const now = new Date();
            const elapsedMs = now - startTime;
            if (!Number.isNaN(elapsedMs) && elapsedMs >= 0) {
              const durationElement = card.querySelector(".task-duration");
              if (durationElement) {
                durationElement.textContent = formatDurationMs(elapsedMs);
              }
            }
          } catch {
            // Error updating duration - silently ignore
          }
        }
      });
  }
}

/**
 * Render pagination controls for task history
 * @param {number} currentPage - Current page number
 * @param {number} totalPages - Total number of pages
 * @param {Function} onPageChange - Callback when page changes
 */
export function renderHistoryPagination(currentPage, totalPages, onPageChange) {
  const paginationContainer = document.querySelector("#taskHistoryPagination");
  if (!paginationContainer) {
    return;
  }

  paginationContainer.innerHTML = "";

  if (totalPages <= 1) {
    return;
  }

  const pagination = document.createElement("ul");
  pagination.className = "pagination justify-content-center";

  // Previous button
  const prevLi = document.createElement("li");
  prevLi.className = `page-item ${currentPage === 1 ? "disabled" : ""}`;
  prevLi.innerHTML = `<a class="page-link" href="#" data-page="${currentPage - 1}">Previous</a>`;
  pagination.appendChild(prevLi);

  // Page numbers
  const startPage = Math.max(1, currentPage - 2);
  const endPage = Math.min(totalPages, startPage + 4);

  for (let i = startPage; i <= endPage; i++) {
    const pageLi = document.createElement("li");
    pageLi.className = `page-item ${i === currentPage ? "active" : ""}`;
    pageLi.innerHTML = `<a class="page-link" href="#" data-page="${i}">${i}</a>`;
    pagination.appendChild(pageLi);
  }

  // Next button
  const nextLi = document.createElement("li");
  nextLi.className = `page-item ${currentPage === totalPages ? "disabled" : ""}`;
  nextLi.innerHTML = `<a class="page-link" href="#" data-page="${currentPage + 1}">Next</a>`;
  pagination.appendChild(nextLi);

  paginationContainer.appendChild(pagination);

  // Attach click handlers
  const pageLinks = paginationContainer.querySelectorAll(".page-link");
  pageLinks.forEach((link) => {
    link.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const page = parseInt(e.target.dataset.page, 10);
      if (page && page !== currentPage && page >= 1 && page <= totalPages) {
        if (onPageChange) {
          onPageChange(page);
        }
      }
    });
  });
}
