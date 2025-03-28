/* global L, notificationManager, bootstrap, confirmationDialog */

/**
 * UploadManager - Manages file uploads and processing for trips originating from uploads.
 */
class UploadManager {
  /**
   * Initialize the upload manager
   */
  constructor() {
    // Initialize properties
    this.droppedFiles = [];
    this.parsedFiles = [];
    this.selectedFiles = []; // Files selected in the drop zone, pending upload
    this.state = {
      selectedFiles: [], // Renamed from parsedFiles for clarity
      previewMap: null,
      previewLayer: null,
      displayedTrips: [], // Cache the trips currently displayed in the table
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
      // Define which sources are considered "uploaded" for display purposes
      uploadSources: ["upload_gpx", "upload_geojson", "upload"],
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
      this.loadUploadSourceTrips(); // Load trips originating from uploads

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
      uploadedTripsBody: document.getElementById("uploadedTripsBody"), // Keep ID for now, represents the table body
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
      this.config.map.defaultZoom,
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
      this.handleFiles(fileInput.files),
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

    this.state.selectedFiles = []; // Clear previous selections
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
          // Use notification manager for user feedback
          window.notificationManager.show(
            `Unsupported file type: ${file.name}. Only .gpx and .geojson files are supported.`,
            "warning",
          );
          this.loadingManager.updateSubOperation("parsing", index + 1); // Still update progress even if skipped
          resolve(); // Resolve so Promise.all doesn't fail for unsupported types
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
    return filename
      .slice(((filename.lastIndexOf(".") - 1) >>> 0) + 1)
      .toLowerCase();
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
      const errorNode = gpxDoc.querySelector("parsererror");
      if (errorNode) {
        throw new Error(`GPX parsing error: ${errorNode.textContent}`);
      }
      const trkpts = gpxDoc.getElementsByTagName("trkpt");
      const coordinates = [];
      const times = [];

      if (trkpts.length === 0) {
        // Check for route points as fallback
        const rtepts = gpxDoc.getElementsByTagName("rtept");
        if (rtepts.length > 0) {
          for (let i = 0; i < rtepts.length; i++) {
            const rtept = rtepts[i];
            const lat = parseFloat(rtept.getAttribute("lat"));
            const lon = parseFloat(rtept.getAttribute("lon"));
            if (!isNaN(lat) && !isNaN(lon)) {
              coordinates.push([lon, lat]);
              const timeElems = rtept.getElementsByTagName("time");
              if (timeElems.length > 0) {
                times.push(new Date(timeElems[0].textContent));
              }
            }
          }
        } else {
          throw new Error(
            `No track points (trkpt) or route points (rtept) found in ${file.name}`,
          );
        }
      } else {
        for (let i = 0; i < trkpts.length; i++) {
          const trkpt = trkpts[i];
          const lat = parseFloat(trkpt.getAttribute("lat"));
          const lon = parseFloat(trkpt.getAttribute("lon"));
          if (!isNaN(lat) && !isNaN(lon)) {
            coordinates.push([lon, lat]); // GeoJSON format: [lon, lat]
            const timeElems = trkpt.getElementsByTagName("time");
            if (timeElems.length > 0) {
              times.push(new Date(timeElems[0].textContent));
            }
          }
        }
      }

      if (coordinates.length < 2) {
        throw new Error(`Insufficient valid coordinates found in ${file.name}`);
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
      window.notificationManager.show(
        `Error parsing ${file.name}: ${error.message}`,
        "danger",
      );
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

      // Handle FeatureCollection
      if (geojsonData.type === "FeatureCollection") {
        if (!geojsonData.features || !Array.isArray(geojsonData.features)) {
          throw new Error("Invalid GeoJSON FeatureCollection structure");
        }

        geojsonData.features.forEach((feature, index) => {
          this.processGeoJSONFeature(feature, file, index);
        });
      }
      // Handle single Feature
      else if (geojsonData.type === "Feature") {
        this.processGeoJSONFeature(geojsonData, file, 0);
      }
      // Handle single Geometry (LineString)
      else if (geojsonData.type === "LineString") {
        this.processGeoJSONGeometry(geojsonData, file);
      } else {
        throw new Error(
          "Unsupported GeoJSON type. Must be FeatureCollection, Feature, or LineString.",
        );
      }
    } catch (error) {
      console.error("Error parsing GeoJSON:", error);
      this.loadingManager.error("Error parsing GeoJSON file: " + file.name);
      window.notificationManager.show(
        `Error parsing ${file.name}: ${error.message}`,
        "danger",
      );
    }
  }

  /**
   * Process a single GeoJSON feature.
   * @param {object} feature - The GeoJSON feature object.
   * @param {File} file - The original file object.
   * @param {number} index - The index of the feature within the file (for naming).
   */
  processGeoJSONFeature(feature, file, index) {
    if (
      !feature.geometry ||
      !feature.properties ||
      feature.geometry.type !== "LineString"
    ) {
      console.warn(
        `Skipping invalid or non-LineString feature ${index + 1} in ${
          file.name
        }`,
      );
      return;
    }

    const coordinates = feature.geometry.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      console.warn(
        `Skipping feature ${index + 1} in ${
          file.name
        } due to insufficient coordinates.`,
      );
      return;
    }

    const properties = feature.properties;
    const filename = `${file.name} (Feature ${index + 1})`; // Distinguish features

    const fileEntry = {
      file, // Keep original file reference for upload
      filename: filename,
      startTime: properties.start_time
        ? new Date(properties.start_time)
        : properties.coordTimes && properties.coordTimes.length > 0
          ? new Date(properties.coordTimes[0])
          : null,
      endTime: properties.end_time
        ? new Date(properties.end_time)
        : properties.coordTimes && properties.coordTimes.length > 0
          ? new Date(properties.coordTimes[properties.coordTimes.length - 1])
          : null,
      points: coordinates.length,
      coordinates,
      type: "geojson",
      properties: {
        // Include potentially useful properties
        max_speed: properties.max_speed,
        hard_brakings: properties.hard_brakings,
        hard_accelerations: properties.hard_accelerations,
        idle: properties.idle,
        transaction_id: properties.transaction_id,
        // Add other relevant properties if needed
      },
    };
    this.state.selectedFiles.push(fileEntry);
  }

  /**
   * Process a bare GeoJSON LineString geometry.
   * @param {object} geometry - The GeoJSON LineString geometry object.
   * @param {File} file - The original file object.
   */
  processGeoJSONGeometry(geometry, file) {
    const coordinates = geometry.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      console.warn(
        `Skipping geometry in ${file.name} due to insufficient coordinates.`,
      );
      return;
    }

    // Cannot infer times from geometry alone
    const startTime = null;
    const endTime = null;

    const fileEntry = {
      file,
      filename: file.name,
      startTime,
      endTime,
      points: coordinates.length,
      coordinates,
      type: "geojson",
      properties: {}, // No properties available
    };
    this.state.selectedFiles.push(fileEntry);
  }

  /**
   * Update the file list UI
   */
  updateFileList() {
    const { fileListBody, uploadButton } = this.elements;

    if (!fileListBody) return;

    fileListBody.innerHTML = ""; // Clear existing list

    this.state.selectedFiles.forEach((entry, index) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${entry.filename}</td>
        <td>${entry.startTime ? entry.startTime.toLocaleString() : "N/A"} - ${
          entry.endTime ? entry.endTime.toLocaleString() : "N/A"
        }</td>
        <td>${entry.points}</td>
        <td>Pending</td>
        <td><button class="btn btn-sm btn-danger" onclick="uploadManager.removeFile(${index})">Remove</button></td>
      `; // Use uploadManager instance
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

    if (!previewLayer || !previewMap) return;

    previewLayer.clearLayers();

    this.state.selectedFiles.forEach((entry, index) => {
      // Ensure coordinates are valid numbers
      const validCoords = entry.coordinates.filter(
        (coord) =>
          Array.isArray(coord) &&
          coord.length >= 2 &&
          !isNaN(coord[0]) &&
          !isNaN(coord[1]),
      );

      if (validCoords.length < 2) {
        console.warn(
          `Skipping preview for ${entry.filename}: Insufficient valid coordinates.`,
        );
        return;
      }

      const latlngs = validCoords.map((coord) => [coord[1], coord[0]]); // Leaflet uses [lat, lon]
      const polyline = L.polyline(latlngs, { color: "red" }).addTo(
        previewLayer,
      );

      // Add tooltip
      polyline.bindTooltip(entry.filename);

      // Add click handler to remove
      polyline.on("click", async () => {
        const confirmed = await confirmationDialog.show({
          title: "Remove File from Preview",
          message: `Remove ${entry.filename} from the upload list?`,
          confirmText: "Remove",
          confirmButtonClass: "btn-danger",
        });

        if (confirmed) {
          // Find the actual index in the current state array
          const currentIndex = this.state.selectedFiles.findIndex(
            (e) => e === entry,
          );
          if (currentIndex !== -1) {
            this.removeFile(currentIndex); // Use the removeFile method
          }
        }
      });
    });

    if (previewLayer.getLayers().length > 0) {
      try {
        previewMap.fitBounds(previewLayer.getBounds());
      } catch (e) {
        console.error("Error fitting map bounds:", e);
        // Fallback zoom if bounds are invalid
        previewMap.setView(
          this.config.map.defaultCenter,
          this.config.map.defaultZoom,
        );
      }
    } else {
      // Reset view if no layers
      previewMap.setView(
        this.config.map.defaultCenter,
        this.config.map.defaultZoom,
      );
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
        .filter((t) => t instanceof Date && !isNaN(t)); // Ensure valid dates

      if (allTimes.length > 0) {
        const minTime = new Date(Math.min(...allTimes.map((t) => t.getTime())));
        const maxTime = new Date(Math.max(...allTimes.map((t) => t.getTime())));
        dateRangeSpan.textContent = `${minTime.toLocaleString()} - ${maxTime.toLocaleString()}`;
      } else {
        dateRangeSpan.textContent = "N/A";
      }
    }

    if (totalPointsSpan) {
      const totalPoints = selectedFiles.reduce(
        (sum, entry) => sum + (entry.points || 0), // Handle potential undefined points
        0,
      );
      totalPointsSpan.textContent = totalPoints.toLocaleString(); // Format large numbers
    }
  }

  /**
   * Remove a file from the selected files list (before upload)
   * @param {number} index - File index to remove
   */
  removeFile(index) {
    if (index >= 0 && index < this.state.selectedFiles.length) {
      const removedFile = this.state.selectedFiles.splice(index, 1);
      console.log(`Removed file ${removedFile[0]?.filename} from selection.`);
      this.updateFileList();
      this.updatePreviewMap();
      this.updateStats();
    } else {
      console.warn(`Attempted to remove file at invalid index: ${index}`);
    }
  }

  /**
   * Upload selected files to the backend.
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

    // Append each actual file object
    selectedFiles.forEach((entry, index) => {
      // Ensure we have the file object; might be lost if page reloaded without persistence
      if (entry.file instanceof File) {
        formData.append("files", entry.file, entry.filename); // Use 'files' as expected by FastAPI
        this.loadingManager.updateSubOperation("uploading", index + 1);
      } else {
        console.warn(`File object missing for ${entry.filename}, skipping.`);
        window.notificationManager.show(
          `Could not upload ${entry.filename}: File data missing. Please re-select the file.`,
          "warning",
        );
      }
    });

    // Check if any files were actually added
    if (!formData.has("files")) {
      window.notificationManager.show(
        "No valid files to upload. Please re-select files.",
        "warning",
      );
      this.loadingManager.error("No valid files found to upload.");
      this.loadingManager.finish();
      return;
    }

    if (uploadButton) {
      uploadButton.disabled = true;
      uploadButton.innerHTML =
        '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Uploading...';
    }

    try {
      // Use the endpoint designed for GPX/GeoJSON uploads
      const response = await fetch("/api/upload_gpx", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        let errorDetail = `Server responded with status: ${response.status}`;
        try {
          const errorData = await response.json();
          errorDetail = errorData.detail || errorDetail;
        } catch (e) {
          /* Ignore JSON parsing error */
        }
        throw new Error(errorDetail);
      }

      const data = await response.json();

      if (data.status === "success") {
        window.notificationManager.show(data.message, "success");
        this.state.selectedFiles = []; // Clear selection after successful upload
        this.updateFileList();
        this.updatePreviewMap();
        this.updateStats();
        this.loadUploadSourceTrips(); // Refresh the list of trips below
      } else {
        throw new Error(data.message || "Error uploading files");
      }
    } catch (error) {
      console.error("Error uploading files:", error);
      window.notificationManager.show(
        "Error uploading files: " + error.message,
        "danger",
      );
      this.loadingManager.error("Error uploading files: " + error.message);
    } finally {
      if (uploadButton) {
        uploadButton.disabled = false;
        uploadButton.innerHTML = "Upload Selected Files";
      }
      this.loadingManager.finish();
    }
  }

  /**
   * Load trips with upload sources from the main trips endpoint.
   */
  async loadUploadSourceTrips() {
    this.loadingManager.startOperation("Loading Uploaded Trips");

    try {
      // Fetch ALL trips from the unified endpoint
      const response = await fetch("/api/trips"); // No specific filters here yet

      if (!response.ok) {
        throw new Error(`Server responded with status: ${response.status}`);
      }

      const geojsonData = await response.json(); // Expecting GeoJSON FeatureCollection

      if (geojsonData && geojsonData.type === "FeatureCollection") {
        // Extract trip data from features, filtering by source on the frontend
        const allTrips = geojsonData.features.map((feature) => ({
          _id: feature.properties.transactionId, // Use transactionId as _id for consistency here
          transactionId: feature.properties.transactionId,
          filename: feature.properties.filename || "N/A", // Assuming filename might be stored
          startTime: feature.properties.startTime,
          endTime: feature.properties.endTime,
          source: feature.properties.source || "unknown",
        }));

        // Filter trips based on defined upload sources
        const uploadSourceTrips = allTrips.filter((trip) =>
          this.config.uploadSources.includes(trip.source),
        );

        this.displayUploadSourceTrips(uploadSourceTrips); // Display only the filtered trips
      } else {
        throw new Error("Invalid data format received from /api/trips");
      }
    } catch (error) {
      console.error("Error fetching trips:", error);
      window.notificationManager.show(
        "Error loading trips from server",
        "danger",
      );
      this.loadingManager.error("Error fetching trips: " + error.message);
      // Clear the table on error
      this.displayUploadSourceTrips([]);
    } finally {
      this.loadingManager.finish();
    }
  }

  /**
   * Display trips with upload sources in the table.
   * @param {Array} trips - Trips data filtered by source.
   */
  displayUploadSourceTrips(trips) {
    const { uploadedTripsBody } = this.elements; // Still using the same table body element

    if (!uploadedTripsBody) return;

    this.loadingManager.startOperation("Displaying Uploaded Trips");

    uploadedTripsBody.innerHTML = ""; // Clear existing table content
    this.state.displayedTrips = trips; // Cache the displayed trips

    trips.forEach((trip) => {
      const row = document.createElement("tr");

      // Checkbox cell
      const checkboxCell = document.createElement("td");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "trip-checkbox";
      // Use transactionId for value as _id might not be consistently available from /api/trips
      checkbox.value = trip.transactionId;
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
        <td>${trip.source || "unknown"}</td>
        <td>
          <button class="btn btn-sm btn-danger delete-trip" data-trip-id="${
            trip.transactionId // Use transactionId for deletion
          }">
            <i class="fas fa-trash-alt"></i> Delete
          </button>
        </td>
      `;

      uploadedTripsBody.appendChild(row);
    });

    this.bindDeleteTripButtons(); // Re-bind listeners for new buttons
    this.updateBulkDeleteButtonState(); // Update button state based on new content
    this.loadingManager.finish();
  }

  /**
   * Bind event handlers to delete trip buttons in the table.
   */
  bindDeleteTripButtons() {
    document.querySelectorAll(".delete-trip").forEach((button) => {
      // Remove existing listener to prevent duplicates if re-binding
      button.replaceWith(button.cloneNode(true));
    });
    // Add new listeners
    document.querySelectorAll(".delete-trip").forEach((button) => {
      button.addEventListener("click", (e) => {
        const tripId = e.currentTarget.dataset.tripId;
        if (tripId) {
          this.deleteTrip(tripId); // Call the renamed delete function
        }
      });
    });
  }

  /**
   * Update bulk delete button state based on selected checkboxes.
   */
  updateBulkDeleteButtonState() {
    const { bulkDeleteBtn } = this.elements;

    if (!bulkDeleteBtn) return;

    const selectedCheckboxes = document.querySelectorAll(
      ".trip-checkbox:checked",
    );
    bulkDeleteBtn.disabled = selectedCheckboxes.length === 0;
  }

  /**
   * Delete trips in bulk using the single delete endpoint iteratively.
   */
  async bulkDeleteTrips() {
    const { bulkDeleteBtn } = this.elements;
    this.loadingManager.startOperation("Deleting Selected Trips");

    const selectedCheckboxes = document.querySelectorAll(
      ".trip-checkbox:checked",
    );
    const tripIds = Array.from(selectedCheckboxes).map((cb) => cb.value);

    if (tripIds.length === 0) {
      window.notificationManager.show(
        "No trips selected for deletion.",
        "warning",
      );
      this.loadingManager.finish();
      return;
    }

    try {
      const confirmed = await confirmationDialog.show({
        title: "Delete Trips",
        message: `Are you sure you want to delete ${tripIds.length} selected trip(s)? This will also delete associated map-matched data.`,
        confirmText: "Delete",
        confirmButtonClass: "btn-danger",
      });

      if (confirmed) {
        if (bulkDeleteBtn) bulkDeleteBtn.disabled = true; // Disable button during operation
        let successCount = 0;
        let failCount = 0;
        this.loadingManager.addSubOperation("bulk_delete", tripIds.length);

        for (let i = 0; i < tripIds.length; i++) {
          const tripId = tripIds[i];
          try {
            // Call the single delete endpoint for each trip
            const response = await fetch(`/api/trips/${tripId}`, {
              method: "DELETE",
            });
            if (!response.ok) {
              // Try to get error message from response
              let errorMsg = `Failed to delete trip ${tripId} (Status: ${response.status})`;
              try {
                const errData = await response.json();
                errorMsg = errData.detail || errorMsg;
              } catch (e) {}
              throw new Error(errorMsg);
            }
            const data = await response.json();
            if (data.status === "success") {
              successCount++;
            } else {
              throw new Error(
                data.message || `Failed to delete trip ${tripId}`,
              );
            }
          } catch (error) {
            console.error(`Error deleting trip ${tripId}:`, error);
            window.notificationManager.show(
              `Error deleting trip ${tripId}: ${error.message}`,
              "warning",
            );
            failCount++;
          }
          this.loadingManager.updateSubOperation("bulk_delete", i + 1);
        }

        let finalMessage = "";
        let messageType = "info";
        if (successCount > 0) {
          finalMessage += `${successCount} trip(s) deleted successfully. `;
          messageType = "success";
        }
        if (failCount > 0) {
          finalMessage += `${failCount} trip(s) failed to delete.`;
          messageType = successCount > 0 ? "warning" : "danger";
        }
        window.notificationManager.show(finalMessage, messageType);

        await this.loadUploadSourceTrips(); // Refresh the list
      }
    } catch (error) {
      window.notificationManager.show(
        "An unexpected error occurred during bulk deletion: " + error.message,
        "danger",
      );
      this.loadingManager.error("Error during bulk deletion: " + error.message);
    } finally {
      if (bulkDeleteBtn) bulkDeleteBtn.disabled = false; // Re-enable button
      // Ensure select-all is unchecked
      if (this.elements.selectAllCheckbox)
        this.elements.selectAllCheckbox.checked = false;
      this.updateBulkDeleteButtonState(); // Update state after operation
      this.loadingManager.finish();
    }
  }

  /**
   * Delete a single trip (from any source displayed in the table) using the unified endpoint.
   * @param {string} tripId - Trip ID (Transaction ID) to delete.
   */
  async deleteTrip(tripId) {
    this.loadingManager.startOperation("Deleting Trip");

    try {
      const confirmed = await confirmationDialog.show({
        title: "Delete Trip",
        message:
          "Are you sure you want to delete this trip? This will also delete associated map-matched data.",
        confirmText: "Delete",
        confirmButtonClass: "btn-danger",
      });

      if (confirmed) {
        // Use the unified DELETE /api/trips/{id} endpoint
        const response = await fetch(`/api/trips/${tripId}`, {
          method: "DELETE",
        });

        if (!response.ok) {
          let errorDetail = `Server responded with status: ${response.status}`;
          try {
            const errorData = await response.json();
            errorDetail = errorData.detail || errorDetail;
          } catch (e) {
            /* Ignore JSON parsing error */
          }
          throw new Error(errorDetail);
        }

        const data = await response.json();

        if (data.status === "success") {
          window.notificationManager.show(
            `Trip ${tripId} deleted successfully. Matched trips deleted: ${data.deleted_matched_trips}`,
            "success",
          );
          await this.loadUploadSourceTrips(); // Refresh the list
        } else {
          throw new Error(data.message || "Error deleting trip");
        }
      }
    } catch (error) {
      window.notificationManager.show(
        "Error deleting trip: " + error.message,
        "danger",
      );
      this.loadingManager.error("Error deleting trip: " + error.message);
    } finally {
      this.loadingManager.finish();
    }
  }
}

// Initialize the upload manager instance making it globally accessible if needed
const uploadManager = new UploadManager();
// window.uploadManager = uploadManager; // Optional: if needed globally elsewhere
