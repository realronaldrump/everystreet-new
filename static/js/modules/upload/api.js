/* global confirmationDialog */

/**
 * Upload API Module
 * Handles all API calls related to file uploads and trip management
 */

import { API_ENDPOINTS, UPLOAD_SOURCES } from "./constants.js";

/**
 * Upload files to the server
 * @param {Array<Object>} selectedFiles - Array of file entries to upload
 * @param {Object} loadingManager - The loading manager instance
 * @returns {Promise<Object>} Server response
 * @throws {Error} If the upload fails
 */
export async function uploadFiles(selectedFiles, loadingManager) {
  const formData = new FormData();

  selectedFiles.forEach((entry, index) => {
    if (entry.file instanceof File) {
      formData.append("files", entry.file, entry.filename);
      loadingManager?.updateSubOperation("uploading", index + 1);
    } else {
      window.notificationManager?.show(
        `Could not upload ${entry.filename}: File data missing. Please re-select the file.`,
        "warning"
      );
    }
  });

  if (!formData.has("files")) {
    throw new Error("No valid files to upload. Please re-select files.");
  }

  const response = await fetch(API_ENDPOINTS.UPLOAD, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    let errorDetail = `Server responded with status: ${response.status}`;
    try {
      const errorData = await response.json();
      errorDetail = errorData.detail || errorDetail;
    } catch {
      // Ignore JSON parse errors
    }
    throw new Error(errorDetail);
  }

  const data = await response.json();

  if (data.status !== "success") {
    throw new Error(data.message || "Error uploading files");
  }

  return data;
}

/**
 * Fetch all trips from the server
 * @returns {Promise<Array<Object>>} Array of trip objects
 * @throws {Error} If the fetch fails
 */
export async function fetchTrips() {
  const response = await fetch(API_ENDPOINTS.TRIPS);

  if (!response.ok) {
    throw new Error(`Server responded with status: ${response.status}`);
  }

  const geojsonData = await response.json();

  if (geojsonData?.type !== "FeatureCollection") {
    throw new Error("Invalid data format received from /api/trips");
  }

  return geojsonData.features.map((feature) => ({
    _id: feature.properties.transactionId,
    transactionId: feature.properties.transactionId,
    filename: feature.properties.filename || "N/A",
    startTime: feature.properties.startTime,
    endTime: feature.properties.endTime,
    source: feature.properties.source || "unknown",
  }));
}

/**
 * Fetch only trips that were uploaded (not fetched from external APIs)
 * @returns {Promise<Array<Object>>} Array of uploaded trip objects
 */
export async function fetchUploadedTrips() {
  const allTrips = await fetchTrips();
  return allTrips.filter((trip) => UPLOAD_SOURCES.includes(trip.source));
}

/**
 * Delete a single trip
 * @param {string} tripId - The transaction ID of the trip to delete
 * @param {boolean} skipConfirmation - Whether to skip the confirmation dialog
 * @returns {Promise<Object>} Server response
 * @throws {Error} If the deletion fails
 */
export async function deleteTrip(tripId, skipConfirmation = false) {
  if (!skipConfirmation) {
    const confirmed = await confirmationDialog.show({
      title: "Delete Trip",
      message:
        "Are you sure you want to delete this trip? This will also delete associated map-matched data.",
      confirmText: "Delete",
      confirmButtonClass: "btn-danger",
    });

    if (!confirmed) {
      return null;
    }
  }

  const response = await fetch(API_ENDPOINTS.DELETE_TRIP(tripId), {
    method: "DELETE",
  });

  if (!response.ok) {
    let errorDetail = `Server responded with status: ${response.status}`;
    try {
      const errorData = await response.json();
      errorDetail = errorData.detail || errorDetail;
    } catch {
      // Ignore JSON parse errors
    }
    throw new Error(errorDetail);
  }

  const data = await response.json();

  if (data.status !== "success") {
    throw new Error(data.message || "Error deleting trip");
  }

  return data;
}

/**
 * Delete multiple trips in bulk
 * @param {Array<string>} tripIds - Array of transaction IDs to delete
 * @param {Object} loadingManager - The loading manager instance
 * @returns {Promise<Object>} Object with successCount and failCount
 * @throws {Error} If confirmation is cancelled
 */
export async function bulkDeleteTrips(tripIds, loadingManager) {
  if (tripIds.length === 0) {
    return { successCount: 0, failCount: 0 };
  }

  const confirmed = await confirmationDialog.show({
    title: "Delete Trips",
    message: `Are you sure you want to delete ${tripIds.length} selected trip(s)? This will also delete associated map-matched data.`,
    confirmText: "Delete",
    confirmButtonClass: "btn-danger",
  });

  if (!confirmed) {
    throw new Error("Bulk delete cancelled by user");
  }

  let successCount = 0;
  let failCount = 0;

  loadingManager?.addSubOperation("bulk_delete", tripIds.length);

  for (let i = 0; i < tripIds.length; i++) {
    const tripId = tripIds[i];
    try {
      await deleteTrip(tripId, true);
      successCount++;
    } catch (error) {
      window.notificationManager?.show(
        `Error deleting trip ${tripId}: ${error.message}`,
        "warning"
      );
      failCount++;
    }
    loadingManager?.updateSubOperation("bulk_delete", i + 1);
  }

  return { successCount, failCount };
}

/**
 * Get a notification message for bulk delete results
 * @param {number} successCount - Number of successful deletions
 * @param {number} failCount - Number of failed deletions
 * @returns {Object} Object with message and type properties
 */
export function getBulkDeleteMessage(successCount, failCount) {
  let message = "";
  let type = "info";

  if (successCount > 0) {
    message += `${successCount} trip(s) deleted successfully. `;
    type = "success";
  }

  if (failCount > 0) {
    message += `${failCount} trip(s) failed to delete.`;
    type = successCount > 0 ? "warning" : "danger";
  }

  return { message, type };
}
