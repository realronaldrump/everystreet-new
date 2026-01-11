/**
 * Upload Manager Module
 * Main orchestrator class for file upload functionality
 */

import { CSS_CLASSES } from "./constants.js";
import { readFileAsText, getFileExtension, parseGPX, parseGeoJSON } from "./parsers.js";
import { initializePreviewMap, updatePreviewMap } from "./preview-map.js";
import {
  cacheElements,
  renderFileList,
  updateStats,
  setUploadButtonState,
  renderUploadedTrips,
  getSelectedTripIds,
  updateBulkDeleteButtonState,
  resetSelectAllCheckbox,
} from "./ui.js";
import {
  uploadFiles,
  fetchUploadedTrips,
  deleteTrip,
  bulkDeleteTrips,
  getBulkDeleteMessage,
} from "./api.js";

/**
 * UploadManager class - orchestrates the upload functionality
 */
export class UploadManager {
  constructor() {
    this.state = {
      selectedFiles: [],
      previewMap: null,
      displayedTrips: [],
    };

    this.elements = {};
    this.loadingManager = null;

    document.addEventListener("DOMContentLoaded", () => this.init());
  }

  /**
   * Initialize the upload manager
   */
  async init() {
    this.loadingManager = window.loadingManager;
    this.loadingManager?.startOperation("Initializing Upload Manager");

    try {
      this.elements = cacheElements();
      await this.initializePreviewMap();
      this.initializeEventListeners();
      await this.loadUploadSourceTrips();
      this.loadingManager?.finish();
    } catch (error) {
      console.error("Failed to initialize upload manager:", error);
      this.loadingManager?.error("Failed to initialize upload manager");
    }
  }

  /**
   * Initialize the preview map
   */
  async initializePreviewMap() {
    const mapEl = this.elements.previewMapElement;
    if (!mapEl) {
      return;
    }

    this.state.previewMap = await initializePreviewMap(mapEl.id, (filename) =>
      this.handleMapFeatureClick(filename)
    );
  }

  /**
   * Handle click on a map feature
   * @param {string} filename - The filename of the clicked feature
   */
  handleMapFeatureClick(filename) {
    const index = this.state.selectedFiles.findIndex((f) => f.filename === filename);
    if (index !== -1) {
      this.removeFile(index);
    }
  }

  /**
   * Initialize all event listeners
   */
  initializeEventListeners() {
    this.initializeDropZoneListeners();
    this.initializeUploadButtonListener();
    this.initializeCheckboxListeners();

    // Expose removeFile globally for backwards compatibility
    window.removeFile = (index) => this.removeFile(index);
  }

  /**
   * Initialize drag and drop listeners
   */
  initializeDropZoneListeners() {
    const { dropZone, fileInput } = this.elements;

    if (!dropZone || !fileInput) {
      return;
    }

    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add(CSS_CLASSES.dragover);
    });

    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove(CSS_CLASSES.dragover);
    });

    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove(CSS_CLASSES.dragover);
      this.handleFiles(e.dataTransfer.files);
    });

    dropZone.addEventListener("mousedown", (e) => {
      if (e.button !== 0) {
        return;
      }
      fileInput.click();
    });

    fileInput.addEventListener("change", () => this.handleFiles(fileInput.files));
  }

  /**
   * Initialize upload button listener
   */
  initializeUploadButtonListener() {
    const { uploadButton } = this.elements;

    if (!uploadButton) {
      return;
    }

    uploadButton.addEventListener("mousedown", (e) => {
      if (e.button !== 0) {
        return;
      }
      this.uploadFiles();
    });
  }

  /**
   * Initialize checkbox listeners for bulk operations
   */
  initializeCheckboxListeners() {
    const { selectAllCheckbox, bulkDeleteBtn } = this.elements;

    if (selectAllCheckbox) {
      selectAllCheckbox.addEventListener("change", () => {
        const checkboxes = document.querySelectorAll(`.${CSS_CLASSES.tripCheckbox}`);
        checkboxes.forEach((cb) => {
          cb.checked = selectAllCheckbox.checked;
        });
        updateBulkDeleteButtonState(bulkDeleteBtn);
      });
    }

    if (bulkDeleteBtn) {
      bulkDeleteBtn.addEventListener("click", () => this.bulkDeleteTrips());
    }

    document.addEventListener("change", (evt) => {
      if (evt.target.matches(`.${CSS_CLASSES.tripCheckbox}`)) {
        updateBulkDeleteButtonState(bulkDeleteBtn);
      }
    });
  }

  /**
   * Handle dropped or selected files
   * @param {FileList} files - The files to process
   */
  async handleFiles(files) {
    if (!files || files.length === 0) {
      return;
    }

    this.loadingManager?.startOperation("Handling Files");
    this.loadingManager?.addSubOperation("parsing", files.length);

    this.state.selectedFiles = [];

    try {
      const filePromises = Array.from(files).map((file, index) =>
        this.processFile(file, index)
      );

      await Promise.all(filePromises);
      this.updateUI();
    } catch (error) {
      console.error("Error during file processing:", error);
      this.loadingManager?.error("Error during file processing.");
    } finally {
      this.loadingManager?.finish();
    }
  }

  /**
   * Process a single file
   * @param {File} file - The file to process
   * @param {number} index - The file index for progress tracking
   */
  async processFile(file, index) {
    try {
      const fileExtension = getFileExtension(file.name);

      if (fileExtension === ".gpx") {
        const content = await readFileAsText(file);
        const entry = parseGPX(file, content);
        if (entry) {
          this.state.selectedFiles.push(entry);
        }
      } else if (fileExtension === ".geojson") {
        const content = await readFileAsText(file);
        const entries = parseGeoJSON(file, content);
        this.state.selectedFiles.push(...entries);
      } else {
        window.notificationManager?.show(
          `Unsupported file type: ${file.name}. Only .gpx and .geojson files are supported.`,
          "warning"
        );
      }

      this.loadingManager?.updateSubOperation("parsing", index + 1);
    } catch (error) {
      this.loadingManager?.error(`Error handling file: ${file.name}`);
      window.notificationManager?.show(
        `Error parsing ${file.name}: ${error.message}`,
        "danger"
      );
    }
  }

  /**
   * Update the UI after file changes
   */
  updateUI() {
    renderFileList(this.elements.fileListBody, this.state.selectedFiles, (index) =>
      this.removeFile(index)
    );

    updatePreviewMap(this.state.previewMap, this.state.selectedFiles);
    updateStats(this.elements, this.state.selectedFiles);

    if (this.elements.uploadButton) {
      this.elements.uploadButton.disabled = this.state.selectedFiles.length === 0;
    }
  }

  /**
   * Remove a file from the selection
   * @param {number} index - The index of the file to remove
   */
  removeFile(index) {
    if (index >= 0 && index < this.state.selectedFiles.length) {
      const removedFile = this.state.selectedFiles.splice(index, 1);
      window.handleError?.(`Removed file ${removedFile[0]?.filename} from selection.`);
      this.updateUI();
    }
  }

  /**
   * Upload selected files to the server
   */
  async uploadFiles() {
    const { selectedFiles } = this.state;
    const { uploadButton } = this.elements;

    if (selectedFiles.length === 0) {
      window.notificationManager?.show("No files selected to upload", "warning");
      return;
    }

    this.loadingManager?.startOperation("Uploading Files");
    this.loadingManager?.addSubOperation("uploading", selectedFiles.length);

    setUploadButtonState(uploadButton, false, true);

    try {
      const data = await uploadFiles(selectedFiles, this.loadingManager);
      window.notificationManager?.show(data.message, "success");

      this.state.selectedFiles = [];
      this.updateUI();
      await this.loadUploadSourceTrips();
    } catch (error) {
      window.notificationManager?.show(
        `Error uploading files: ${error.message}`,
        "danger"
      );
      this.loadingManager?.error(`Error uploading files: ${error.message}`);
    } finally {
      setUploadButtonState(uploadButton, true, false);
      this.loadingManager?.finish();
    }
  }

  /**
   * Load and display uploaded trips
   */
  async loadUploadSourceTrips() {
    this.loadingManager?.startOperation("Loading Uploaded Trips");

    try {
      const trips = await fetchUploadedTrips();
      this.displayUploadSourceTrips(trips);
    } catch (error) {
      window.notificationManager?.show("Error loading trips from server", "danger");
      this.loadingManager?.error(`Error fetching trips: ${error.message}`);
      this.displayUploadSourceTrips([]);
    } finally {
      this.loadingManager?.finish();
    }
  }

  /**
   * Display uploaded trips in the table
   * @param {Array<Object>} trips - Array of trip objects
   */
  displayUploadSourceTrips(trips) {
    this.loadingManager?.startOperation("Displaying Uploaded Trips");

    this.state.displayedTrips = trips;

    renderUploadedTrips(this.elements.uploadedTripsBody, trips, (tripId) =>
      this.deleteTrip(tripId)
    );

    updateBulkDeleteButtonState(this.elements.bulkDeleteBtn);
    this.loadingManager?.finish();
  }

  /**
   * Delete a single trip
   * @param {string} tripId - The transaction ID of the trip to delete
   */
  async deleteTrip(tripId) {
    this.loadingManager?.startOperation("Deleting Trip");

    try {
      const result = await deleteTrip(tripId);

      if (result) {
        window.notificationManager?.show(
          `Trip ${tripId} deleted successfully. Matched trips deleted: ${result.deleted_matched_trips}`,
          "success"
        );
        await this.loadUploadSourceTrips();
      }
    } catch (error) {
      window.notificationManager?.show(
        `Error deleting trip: ${error.message}`,
        "danger"
      );
      this.loadingManager?.error(`Error deleting trip: ${error.message}`);
    } finally {
      this.loadingManager?.finish();
    }
  }

  /**
   * Bulk delete selected trips
   */
  async bulkDeleteTrips() {
    const { bulkDeleteBtn, selectAllCheckbox } = this.elements;

    this.loadingManager?.startOperation("Deleting Selected Trips");

    const tripIds = getSelectedTripIds();

    if (tripIds.length === 0) {
      window.notificationManager?.show("No trips selected for deletion.", "warning");
      this.loadingManager?.finish();
      return;
    }

    try {
      if (bulkDeleteBtn) {
        bulkDeleteBtn.disabled = true;
      }

      const { successCount, failCount } = await bulkDeleteTrips(
        tripIds,
        this.loadingManager
      );

      const { message, type } = getBulkDeleteMessage(successCount, failCount);
      window.notificationManager?.show(message, type);

      await this.loadUploadSourceTrips();
    } catch (error) {
      if (error.message !== "Bulk delete cancelled by user") {
        window.notificationManager?.show(
          `An unexpected error occurred during bulk deletion: ${error.message}`,
          "danger"
        );
        this.loadingManager?.error(`Error during bulk deletion: ${error.message}`);
      }
    } finally {
      if (bulkDeleteBtn) {
        bulkDeleteBtn.disabled = false;
      }
      resetSelectAllCheckbox(selectAllCheckbox);
      updateBulkDeleteButtonState(bulkDeleteBtn);
      this.loadingManager?.finish();
    }
  }
}
