/* global L, notificationManager, bootstrap, confirmationDialog */

/**
 * UploadManager - Manages file uploads and processing
 */
class UploadManager {
  /**
   * Initialize the upload manager
   */
  constructor() {
    // Initialize properties
    this.droppedFiles = [];
    this.parsedFiles = [];
    this.selectedFiles = [];
    this.state = {
      selectedFiles: [],
      previewMap: null,
      previewLayer: null,
    };

    // DOM elements
    this.elements = {};

    // Configuration
    this.config = {
      map: {
        defaultCenter: [37.0902, -95.7129],
        defaultZoom: 4,
        tileLayerUrl:
          "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        maxZoom: 19,
      },
      supportedFileTypes: {
        gpx: {
          name: "GPS Exchange Format",
          extension: ".gpx",
          mimeType: "application/gpx+xml",
        },
        geojson: {
          name: "GeoJSON",
          extension: ".geojson",
          mimeType: "application/geo+json",
        },
      },
    };

    // Initialize on DOM content loaded
    document.addEventListener("DOMContentLoaded", () => this.init());
  }

  /**
   * Initialize the upload manager
   */
  init() {
    this.loadingManager = window.loadingManager || {
      startOperation: () => {},
      addSubOperation: () => {},
      updateSubOperation: () => {},
      finish: () => {},
      error: () => {},
    };

    this.loadingManager.startOperation("Initializing Upload Manager");

    try {
      this.cacheElements();
      this.initializePreviewMap();
      this.initializeEventListeners();
      this.loadUploadedTrips();

      this.loadingManager.finish();
    } catch (error) {
      console.error("Error initializing upload manager:", error);
      this.loadingManager.error("Failed to initialize upload manager");
    }
  }

  /**
   * Cache DOM elements for better performance
   */
  cacheElements() {
    this.elements = {
      dropZone: document.getElementById("dropZone"),
      fileInput: document.getElementById("fileInput"),
      fileListBody: document.getElementById("fileListBody"),
      uploadButton: document.getElementById("uploadButton"),
      totalFilesSpan: document.getElementById("totalFiles"),
      dateRangeSpan: document.getElementById("dateRange"),
      totalPointsSpan: document.getElementById("totalPoints"),
      previewMapElement: document.getElementById("previewMap"),
      mapMatchCheckbox: document.getElementById("mapMatchOnUpload"),
      uploadedTripsBody: document.getElementById("uploadedTripsBody"),
      selectAllCheckbox: document.getElementById("select-all"),
      bulkDeleteBtn: document.getElementById("bulk-delete-btn"),
    };
  }

  /**
   * Initialize the preview map
   */
  initializePreviewMap() {
    if (!this.elements.previewMapElement) return;

    this.state.previewMap = L.map(this.elements.previewMapElement).setView(
      this.config.map.defaultCenter,
      this.config.map.defaultZoom
    );

    L.tileLayer(this.config.map.tileLayerUrl, {
      maxZoom: this.config.map.maxZoom,
      attribution: "",
    }).addTo(this.state.previewMap);

    this.state.previewLayer = L.featureGroup().addTo(this.state.previewMap);
  }

  /**
   * Initialize event listeners
   */
  initializeEventListeners() {
    this.initializeDropZoneListeners();
    this.initializeUploadButtonListener();
    this.initializeCheckboxListeners();

    // Expose removeFile function globally
    window.removeFile = (index) => this.removeFile(index);
  }

  /**
   * Initialize drop zone event listeners
   */
  initializeDropZoneListeners() {
    const { dropZone, fileInput } = this.elements;

    if (!dropZone || !fileInput) return;

    // Drag and drop events
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    });

    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("dragover");
    });

    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
      this.handleFiles(e.dataTransfer.files);
    });

    // Click to select files
    dropZone.addEventListener("click", () => fileInput.click());

    // File input change
    fileInput.addEventListener("change", () =>
      this.handleFiles(fileInput.files)
    );
  }

  /**
   * Initialize upload button listener
   */
  initializeUploadButtonListener() {
    const { uploadButton } = this.elements;

    if (!uploadButton) return;

    uploadButton.addEventListener("click", () => this.uploadFiles());
  }

  /**
   * Initialize checkbox listeners
   */
  initializeCheckboxListeners() {
    const { selectAllCheckbox, bulkDeleteBtn } = this.elements;

    if (selectAllCheckbox) {
      selectAllCheckbox.addEventListener("change", () => {
        const checkboxes = document.querySelectorAll(".trip-checkbox");
        checkboxes.forEach((cb) => (cb.checked = selectAllCheckbox.checked));
        this.updateBulkDeleteButtonState();
      });
    }

    if (bulkDeleteBtn) {
      bulkDeleteBtn.addEventListener("click", () => this.bulkDeleteTrips());
    }

    // Event delegation for trip checkboxes
    document.addEventListener("change", (e) => {
      if (e.target.matches(".trip-checkbox")) {
        this.updateBulkDeleteButtonState();
      }
    });
  }

  /**
   * Handle files selected by the user
   * @param {FileList} files - Files selected by the user
   */
  async handleFiles(files) {
    if (!files || files.length === 0) return;

    this.loadingManager.startOperation("Handling Files");
    this.loadingManager.addSubOperation("parsing", files.length);

    this.state.selectedFiles = [];
    const filePromises = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const promise = this.processFile(file, i);
      filePromises.push(promise);
    }

    try {
      await Promise.all(filePromises);
      this.updateFileList();
      this.updatePreviewMap();
      this.updateStats();
    } catch (error) {
      console.error("Error during file processing:", error);
      this.loadingManager.error("Error during file processing.");
    } finally {
      this.loadingManager.finish();
    }
  }

  /**
   * Process a single file
   * @param {File} file - File to process
   * @param {number} index - File index
   * @returns {Promise<void>}
   */
  processFile(file, index) {
    return new Promise((resolve, reject) => {
      try {
        const fileExtension = this.getFileExtension(file.name);

        if (fileExtension === ".gpx") {
          this.readFileAsText(file)
            .then((content) => {
              this.parseGPX(file, content);
              this.loadingManager.updateSubOperation("parsing", index + 1);
              resolve();
            })
            .catch((error) => reject(error));
        } else if (fileExtension === ".geojson") {
          this.readFileAsText(file)
            .then((content) => {
              this.parseGeoJSON(file, content);
              this.loadingManager.updateSubOperation("parsing", index + 1);
              resolve();
            })
            .catch((error) => reject(error));
        } else {
          reject(
            new Error(
              `Unsupported file type: ${file.name}. Only .gpx and .geojson files are supported.`
            )
          );
        }
      } catch (error) {
        console.error("Error handling file:", error);
        this.loadingManager.error("Error handling file: " + file.name);
        reject(error);
      }
    });
  }

  /**
   * Read a file as text
   * @param {File} file - File to read
   * @returns {Promise<string>} File contents as text
   */
  readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = (error) => reject(error);
      reader.readAsText(file);
    });
  }

  /**
   * Get file extension from file name
   * @param {string} filename - File name
   * @returns {string} File extension including the dot
   */
  getFileExtension(filename) {
    return filename.slice(filename.lastIndexOf(".")).toLowerCase();
  }

  /**
   * Parse a GPX file
   * @param {File} file - GPX file
   * @param {string} gpxContent - GPX file content
   */
  parseGPX(file, gpxContent) {
    try {
      const parser = new DOMParser();
      const gpxDoc = parser.parseFromString(gpxContent, "application/xml");
      const trkpts = gpxDoc.getElementsByTagName("trkpt");
      const coordinates = [];
      const times = [];

      for (let i = 0; i < trkpts.length; i++) {
        const trkpt = trkpts[i];
        const lat = parseFloat(trkpt.getAttribute("lat"));
        const lon = parseFloat(trkpt.getAttribute("lon"));
        coordinates.push([lon, lat]); // GeoJSON format: [lon, lat]

        const timeElems = trkpt.getElementsByTagName("time");
        if (timeElems.length > 0) {
          times.push(new Date(timeElems[0].textContent));
        }
      }

      if (coordinates.length === 0) {
        throw new Error(`No coordinates found in ${file.name}`);
      }

      const startTime =
        times.length > 0
          ? new Date(Math.min(...times.map((t) => t.getTime())))
          : null;
      const endTime =
        times.length > 0
          ? new Date(Math.max(...times.map((t) => t.getTime())))
          : null;

      const fileEntry = {
        file,
        filename: file.name,
        startTime,
        endTime,
        points: coordinates.length,
        coordinates,
        type: "gpx",
      };

      this.state.selectedFiles.push(fileEntry);
    } catch (error) {
      console.error("Error parsing GPX:", error);
      this.loadingManager.error("Error parsing GPX file: " + file.name);
    }
  }

  /**
   * Parse a GeoJSON file
   * @param {File} file - GeoJSON file
   * @param {string} content - GeoJSON file content
   */
  parseGeoJSON(file, content) {
    try {
      const geojsonData = JSON.parse(content);

      if (!geojsonData.features || !Array.isArray(geojsonData.features)) {
        throw new Error("Invalid GeoJSON structure");
      }

      geojsonData.features.forEach((feature) => {
        if (!feature.geometry || !feature.properties) return;

        const coordinates = feature.geometry.coordinates;
        const properties = feature.properties;

        const fileEntry = {
          file,
          filename: file.name,
          startTime: properties.start_time
            ? new Date(properties.start_time)
            : null,
          endTime: properties.end_time ? new Date(properties.end_time) : null,
          points: coordinates.length,
          coordinates,
          type: "geojson",
          properties: {
            max_speed: properties.max_speed,
            hard_brakings: properties.hard_brakings,
            hard_accelerations: properties.hard_accelerations,
            idle: properties.idle,
            transaction_id: properties.transaction_id,
          },
        };

        this.state.selectedFiles.push(fileEntry);
      });
    } catch (error) {
      console.error("Error parsing GeoJSON:", error);
      this.loadingManager.error("Error parsing GeoJSON file: " + file.name);
    }
  }

  /**
   * Update the file list UI
   */
  updateFileList() {
    const { fileListBody, uploadButton } = this.elements;

    if (!fileListBody) return;

    fileListBody.innerHTML = "";

    this.state.selectedFiles.forEach((entry, index) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${entry.filename}</td>
        <td>${entry.startTime ? entry.startTime.toLocaleString() : "-"} - ${
        entry.endTime ? entry.endTime.toLocaleString() : "-"
      }</td>
        <td>${entry.points}</td>
        <td>Pending</td>
        <td><button class="btn btn-sm btn-danger" onclick="removeFile(${index})">Remove</button></td>
      `;
      fileListBody.appendChild(row);
    });

    if (uploadButton) {
      uploadButton.disabled = this.state.selectedFiles.length === 0;
    }
  }

  /**
   * Update the preview map with file data
   */
  updatePreviewMap() {
    const { previewLayer, previewMap } = this.state;

    if (!previewLayer) return;

    previewLayer.clearLayers();

    this.state.selectedFiles.forEach((entry) => {
      const latlngs = entry.coordinates.map((coord) => [coord[1], coord[0]]);
      const polyline = L.polyline(latlngs, { color: "red" }).addTo(
        previewLayer
      );

      polyline.on("click", async () => {
        const confirmed = await confirmationDialog.show({
          title: "Remove File",
          message: `Remove ${entry.filename}?`,
          confirmText: "Remove",
          confirmButtonClass: "btn-danger",
        });

        if (confirmed) {
          this.state.selectedFiles = this.state.selectedFiles.filter(
            (e) => e !== entry
          );
          this.updateFileList();
          this.updatePreviewMap();
          this.updateStats();
        }
      });
    });

    if (previewMap && previewLayer.getLayers().length > 0) {
      previewMap.fitBounds(previewLayer.getBounds());
    }
  }

  /**
   * Update file statistics UI
   */
  updateStats() {
    const { totalFilesSpan, dateRangeSpan, totalPointsSpan } = this.elements;
    const { selectedFiles } = this.state;

    if (totalFilesSpan) {
      totalFilesSpan.textContent = selectedFiles.length;
    }

    if (dateRangeSpan) {
      const allTimes = selectedFiles
        .flatMap((entry) => [entry.startTime, entry.endTime])
        .filter((t) => t);

      if (allTimes.length > 0) {
        const minTime = new Date(Math.min(...allTimes.map((t) => t.getTime())));
        const maxTime = new Date(Math.max(...allTimes.map((t) => t.getTime())));
        dateRangeSpan.textContent = `${minTime.toLocaleString()} - ${maxTime.toLocaleString()}`;
      } else {
        dateRangeSpan.textContent = "-";
      }
    }

    if (totalPointsSpan) {
      const totalPoints = selectedFiles.reduce(
        (sum, entry) => sum + entry.points,
        0
      );
      totalPointsSpan.textContent = totalPoints;
    }
  }

  /**
   * Remove a file from the selected files
   * @param {number} index - File index to remove
   */
  removeFile(index) {
    if (index >= 0 && index < this.state.selectedFiles.length) {
      this.state.selectedFiles.splice(index, 1);
      this.updateFileList();
      this.updatePreviewMap();
      this.updateStats();
    }
  }

  /**
   * Upload selected files
   */
  async uploadFiles() {
    const { selectedFiles } = this.state;
    const { uploadButton, mapMatchCheckbox } = this.elements;

    if (selectedFiles.length === 0) {
      window.notificationManager.show("No files selected to upload", "warning");
      return;
    }

    this.loadingManager.startOperation("Uploading Files");
    this.loadingManager.addSubOperation("uploading", selectedFiles.length);

    const formData = new FormData();

    selectedFiles.forEach((entry, index) => {
      formData.append("files[]", entry.file);
      this.loadingManager.updateSubOperation("uploading", index + 1);
    });

    const mapMatch = mapMatchCheckbox?.checked || false;
    formData.append("map_match", mapMatch);

    if (uploadButton) {
      uploadButton.disabled = true;
    }

    try {
      const response = await fetch("/api/upload_gpx", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Server responded with status: ${response.status}`);
      }

      const data = await response.json();

      if (data.status === "success") {
        window.notificationManager.show(data.message, "success");
        this.state.selectedFiles = [];
        this.updateFileList();
        this.updatePreviewMap();
        this.updateStats();
        this.loadUploadedTrips();
      } else {
        throw new Error(data.message || "Error uploading files");
      }
    } catch (error) {
      console.error("Error uploading files:", error);
      window.notificationManager.show(
        "Error uploading files: " + error.message,
        "danger"
      );
      this.loadingManager.error("Error uploading files: " + error.message);
    } finally {
      if (uploadButton) {
        uploadButton.disabled = false;
      }
      this.loadingManager.finish();
    }
  }

  /**
   * Load previously uploaded trips
   */
  async loadUploadedTrips() {
    this.loadingManager.startOperation("Loading Uploaded Trips");

    try {
      const response = await fetch("/api/uploaded_trips");

      if (!response.ok) {
        throw new Error(`Server responded with status: ${response.status}`);
      }

      const data = await response.json();

      if (data.status === "success") {
        this.displayUploadedTrips(data.trips);
      } else {
        throw new Error(data.message || "Error loading uploaded trips");
      }
    } catch (error) {
      console.error("Error fetching uploaded trips:", error);
      window.notificationManager.show("Error loading uploaded trips", "danger");
      this.loadingManager.error(
        "Error fetching uploaded trips: " + error.message
      );
    } finally {
      this.loadingManager.finish();
    }
  }

  /**
   * Display uploaded trips in the table
   * @param {Array} trips - Uploaded trips data
   */
  displayUploadedTrips(trips) {
    const { uploadedTripsBody } = this.elements;

    if (!uploadedTripsBody) return;

    this.loadingManager.startOperation("Displaying Uploaded Trips");

    uploadedTripsBody.innerHTML = "";

    trips.forEach((trip) => {
      const row = document.createElement("tr");

      // Checkbox cell
      const checkboxCell = document.createElement("td");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "trip-checkbox";
      checkbox.value = trip._id;
      checkboxCell.appendChild(checkbox);
      row.appendChild(checkboxCell);

      // Data cells
      row.innerHTML += `
        <td>${trip.transactionId || "N/A"}</td>
        <td>${trip.filename || "N/A"}</td>
        <td>${
          trip.startTime ? new Date(trip.startTime).toLocaleString() : "-"
        }</td>
        <td>${trip.endTime ? new Date(trip.endTime).toLocaleString() : "-"}</td>
        <td>${trip.source || "upload"}</td>
        <td>
          <button class="btn btn-sm btn-danger delete-trip" data-trip-id="${
            trip._id
          }">
            Delete
          </button>
        </td>
      `;

      uploadedTripsBody.appendChild(row);
    });

    this.bindDeleteTripButtons();
    this.updateBulkDeleteButtonState();
    this.loadingManager.finish();
  }

  /**
   * Bind event handlers to delete trip buttons
   */
  bindDeleteTripButtons() {
    document.querySelectorAll(".delete-trip").forEach((button) => {
      button.addEventListener("click", (e) => {
        const tripId = e.currentTarget.dataset.tripId;
        if (tripId) {
          this.deleteUploadedTrip(tripId);
        }
      });
    });
  }

  /**
   * Update bulk delete button state
   */
  updateBulkDeleteButtonState() {
    const { bulkDeleteBtn } = this.elements;

    if (!bulkDeleteBtn) return;

    const selectedCheckboxes = document.querySelectorAll(
      ".trip-checkbox:checked"
    );
    bulkDeleteBtn.disabled = selectedCheckboxes.length === 0;
  }

  /**
   * Delete trips in bulk
   */
  async bulkDeleteTrips() {
    this.loadingManager.startOperation("Deleting Selected Trips");

    const selectedCheckboxes = document.querySelectorAll(
      ".trip-checkbox:checked"
    );
    const tripIds = Array.from(selectedCheckboxes).map((cb) => cb.value);

    if (tripIds.length === 0) {
      window.notificationManager.show(
        "No trips selected for deletion.",
        "warning"
      );
      this.loadingManager.finish();
      return;
    }

    try {
      const confirmed = await confirmationDialog.show({
        title: "Delete Trips",
        message: `Are you sure you want to delete ${tripIds.length} selected trips?`,
        confirmText: "Delete",
        confirmButtonClass: "btn-danger",
      });

      if (confirmed) {
        const response = await fetch("/api/uploaded_trips_bulk_delete", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trip_ids: tripIds }),
        });

        if (!response.ok) {
          throw new Error(`Server responded with status: ${response.status}`);
        }

        const data = await response.json();

        if (data.status === "success") {
          window.notificationManager.show(
            `${data.deleted_uploaded_trips} uploaded trips and ${data.deleted_matched_trips} matched trips deleted successfully.`,
            "success"
          );
          await this.loadUploadedTrips();
        } else {
          throw new Error(data.message || "Error deleting trips");
        }
      }
    } catch (error) {
      window.notificationManager.show(
        "Error deleting trips: " + error.message,
        "danger"
      );
      this.loadingManager.error("Error deleting trips: " + error.message);
    } finally {
      this.loadingManager.finish();
    }
  }

  /**
   * Delete a single uploaded trip
   * @param {string} tripId - Trip ID to delete
   */
  async deleteUploadedTrip(tripId) {
    this.loadingManager.startOperation("Deleting Trip");

    try {
      const confirmed = await confirmationDialog.show({
        title: "Delete Trip",
        message: "Are you sure you want to delete this trip?",
        confirmText: "Delete",
        confirmButtonClass: "btn-danger",
      });

      if (confirmed) {
        const response = await fetch(`/api/uploaded_trips/${tripId}`, {
          method: "DELETE",
        });

        if (!response.ok) {
          throw new Error(`Server responded with status: ${response.status}`);
        }

        const data = await response.json();

        if (data.status === "success") {
          window.notificationManager.show(
            `Trip deleted successfully. Matched trips deleted: ${data.deleted_matched_trips}`,
            "success"
          );
          await this.loadUploadedTrips();
        } else {
          throw new Error(data.message || "Error deleting trip");
        }
      }
    } catch (error) {
      window.notificationManager.show(
        "Error deleting trip: " + error.message,
        "danger"
      );
      this.loadingManager.error("Error deleting trip: " + error.message);
    } finally {
      this.loadingManager.finish();
    }
  }
}

// Initialize the upload manager
const uploadManager = new UploadManager();
