/**
 * Upload UI Module
 * Handles DOM manipulation and UI updates for the upload functionality
 */

import { DOM_IDS, CSS_CLASSES } from "./constants.js";

/**
 * Cache and return all relevant DOM elements
 * @returns {Object} Object containing all cached DOM elements
 */
export function cacheElements() {
  return {
    dropZone: document.getElementById(DOM_IDS.dropZone),
    fileInput: document.getElementById(DOM_IDS.fileInput),
    fileListBody: document.getElementById(DOM_IDS.fileListBody),
    uploadButton: document.getElementById(DOM_IDS.uploadButton),
    totalFilesSpan: document.getElementById(DOM_IDS.totalFiles),
    dateRangeSpan: document.getElementById(DOM_IDS.dateRange),
    totalPointsSpan: document.getElementById(DOM_IDS.totalPoints),
    previewMapElement: document.getElementById(DOM_IDS.previewMap),
    mapMatchCheckbox: document.getElementById(DOM_IDS.mapMatchCheckbox),
    uploadedTripsBody: document.getElementById(DOM_IDS.uploadedTripsBody),
    selectAllCheckbox: document.getElementById(DOM_IDS.selectAllCheckbox),
    bulkDeleteBtn: document.getElementById(DOM_IDS.bulkDeleteBtn),
  };
}

/**
 * Format a date for display
 * @param {Date|string|null} date - The date to format
 * @returns {string} Formatted date string or "N/A"
 */
export function formatDate(date) {
  if (!date) {
    return "N/A";
  }
  const dateObj = date instanceof Date ? date : new Date(date);
  return dateObj.toLocaleString("en-US", { hour12: true });
}

/**
 * Render the file list table
 * @param {HTMLElement} fileListBody - The table body element
 * @param {Array<Object>} selectedFiles - Array of file entries
 * @param {Function} onRemove - Callback when remove button is clicked (receives index)
 */
export function renderFileList(fileListBody, selectedFiles, onRemove) {
  if (!fileListBody) {
    return;
  }

  fileListBody.innerHTML = "";

  selectedFiles.forEach((entry, index) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${escapeHtml(entry.filename)}</td>
      <td>${formatDate(entry.startTime)} - ${formatDate(entry.endTime)}</td>
      <td>${entry.points}</td>
      <td>Pending</td>
      <td><button class="btn btn-sm btn-danger remove-file-btn" data-index="${index}">Remove</button></td>
    `;
    fileListBody.appendChild(row);
  });

  // Bind remove buttons
  fileListBody.querySelectorAll(".remove-file-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const index = parseInt(e.target.dataset.index, 10);
      if (onRemove) {
        onRemove(index);
      }
    });
  });
}

/**
 * Update the upload statistics display
 * @param {Object} elements - DOM elements object
 * @param {Array<Object>} selectedFiles - Array of file entries
 */
export function updateStats(elements, selectedFiles) {
  const { totalFilesSpan, dateRangeSpan, totalPointsSpan } = elements;

  if (totalFilesSpan) {
    totalFilesSpan.textContent = selectedFiles.length;
  }

  if (dateRangeSpan) {
    const allTimes = selectedFiles
      .flatMap((entry) => [entry.startTime, entry.endTime])
      .filter((t) => t instanceof Date && !Number.isNaN(t.getTime()));

    if (allTimes.length > 0) {
      const minTime = new Date(Math.min(...allTimes.map((t) => t.getTime())));
      const maxTime = new Date(Math.max(...allTimes.map((t) => t.getTime())));
      dateRangeSpan.textContent = `${formatDate(minTime)} - ${formatDate(maxTime)}`;
    } else {
      dateRangeSpan.textContent = "N/A";
    }
  }

  if (totalPointsSpan) {
    const totalPoints = selectedFiles.reduce(
      (sum, entry) => sum + (entry.points || 0),
      0,
    );
    totalPointsSpan.textContent = totalPoints.toLocaleString();
  }
}

/**
 * Set the upload button state
 * @param {HTMLElement} uploadButton - The upload button element
 * @param {boolean} enabled - Whether the button should be enabled
 * @param {boolean} loading - Whether to show loading state
 */
export function setUploadButtonState(uploadButton, enabled, loading = false) {
  if (!uploadButton) {
    return;
  }

  uploadButton.disabled = !enabled || loading;

  if (loading) {
    uploadButton.innerHTML = `
      <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 
      Uploading...
    `;
  } else {
    uploadButton.innerHTML = "Upload Selected Files";
  }
}

/**
 * Render the uploaded trips table
 * @param {HTMLElement} uploadedTripsBody - The table body element
 * @param {Array<Object>} trips - Array of trip objects
 * @param {Function} onDelete - Callback when delete button is clicked (receives tripId)
 */
export function renderUploadedTrips(uploadedTripsBody, trips, onDelete) {
  if (!uploadedTripsBody) {
    return;
  }

  uploadedTripsBody.innerHTML = "";

  trips.forEach((trip) => {
    const row = document.createElement("tr");

    const checkboxCell = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = CSS_CLASSES.tripCheckbox;
    checkbox.value = trip.transactionId;
    checkboxCell.appendChild(checkbox);
    row.appendChild(checkboxCell);

    row.innerHTML += `
      <td>${escapeHtml(trip.transactionId || "N/A")}</td>
      <td>${escapeHtml(trip.filename || "N/A")}</td>
      <td>${formatDate(trip.startTime)}</td>
      <td>${formatDate(trip.endTime)}</td>
      <td>${escapeHtml(trip.source || "unknown")}</td>
      <td>
        <button class="btn btn-sm btn-danger ${CSS_CLASSES.deleteTrip}" data-trip-id="${trip.transactionId}">
          <i class="fas fa-trash-alt"></i> Delete
        </button>
      </td>
    `;

    uploadedTripsBody.appendChild(row);
  });

  // Bind delete buttons
  bindDeleteButtons(uploadedTripsBody, onDelete);
}

/**
 * Bind delete button event handlers
 * @param {HTMLElement} container - The container element
 * @param {Function} onDelete - Callback when delete button is clicked
 */
function bindDeleteButtons(container, onDelete) {
  container.querySelectorAll(`.${CSS_CLASSES.deleteTrip}`).forEach((button) => {
    // Clone and replace to remove old event listeners
    const newButton = button.cloneNode(true);
    button.parentNode.replaceChild(newButton, button);

    newButton.addEventListener("click", (e) => {
      const { tripId } = e.currentTarget.dataset;
      if (tripId && onDelete) {
        onDelete(tripId);
      }
    });
  });
}

/**
 * Get all selected trip IDs from checkboxes
 * @returns {Array<string>} Array of selected trip IDs
 */
export function getSelectedTripIds() {
  const selectedCheckboxes = document.querySelectorAll(
    `.${CSS_CLASSES.tripCheckbox}:checked`,
  );
  return Array.from(selectedCheckboxes).map((cb) => cb.value);
}

/**
 * Update the bulk delete button state based on selection
 * @param {HTMLElement} bulkDeleteBtn - The bulk delete button element
 */
export function updateBulkDeleteButtonState(bulkDeleteBtn) {
  if (!bulkDeleteBtn) {
    return;
  }

  const selectedCheckboxes = document.querySelectorAll(
    `.${CSS_CLASSES.tripCheckbox}:checked`,
  );
  bulkDeleteBtn.disabled = selectedCheckboxes.length === 0;
}

/**
 * Reset the select all checkbox
 * @param {HTMLElement} selectAllCheckbox - The select all checkbox element
 */
export function resetSelectAllCheckbox(selectAllCheckbox) {
  if (selectAllCheckbox) {
    selectAllCheckbox.checked = false;
  }
}

/**
 * Escape HTML to prevent XSS
 * @param {string} text - The text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
  if (!text) {
    return "";
  }
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
