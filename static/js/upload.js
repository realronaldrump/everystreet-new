/* global mapboxgl, confirmationDialog */

class UploadManager {
  constructor() {
    this.droppedFiles = [];
    this.parsedFiles = [];
    this.selectedFiles = [];
    this.state = {
      selectedFiles: [],
      previewMap: null,
      previewSourceId: "preview-source",
      previewLayerId: "preview-layer",
      displayedTrips: [],
    };

    this.elements = {};

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
      uploadSources: ["upload_gpx", "upload_geojson", "upload"],
    };

    document.addEventListener("DOMContentLoaded", () => this.init());
  }

  init() {
    this.loadingManager = window.loadingManager;

    this.loadingManager.startOperation("Initializing Upload Manager");

    try {
      this.cacheElements();
      this.initializePreviewMap()
        .then(() => {
          this.initializeEventListeners();
          this.loadUploadSourceTrips();
          this.loadingManager.finish();
        })
        .catch((error) => {
          console.error("Error initializing upload manager:", error);
          this.loadingManager.error("Failed to initialize upload manager");
        });
    } catch (error) {
      console.error("Error initializing upload manager:", error);
      this.loadingManager.error("Failed to initialize upload manager");
    }
  }

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

  async initializePreviewMap() {
    const mapEl = this.elements.previewMapElement;
    if (!mapEl) return;

    this.state.previewMap = window.mapBase.createMap(mapEl.id, {
      center: this.config.map.defaultCenter,
      zoom: this.config.map.defaultZoom,
    });

    // Wait for map style to load before adding sources/layers
    await new Promise((resolve) => {
      if (this.state.previewMap.isStyleLoaded()) {
        resolve();
      } else {
        this.state.previewMap.once("styledata", resolve);
        // Fallback timeout
        setTimeout(resolve, 1000);
      }
    });

    // Initialize GeoJSON source
    this.state.previewMap.addSource(this.state.previewSourceId, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      generateId: true,
    });

    // Add preview layer
    this.state.previewMap.addLayer({
      id: this.state.previewLayerId,
      type: "line",
      source: this.state.previewSourceId,
      paint: {
        "line-color": "#ff0000",
        "line-width": 3,
        "line-opacity": 0.8,
      },
      layout: {
        "line-join": "round",
        "line-cap": "round",
      },
    });

    // Handle clicks on preview lines
    this.state.previewMap.on("click", this.state.previewLayerId, async (e) => {
      const feature = e.features[0];
      if (feature && feature.properties?.filename) {
        const confirmed = await confirmationDialog.show({
          title: "Remove File from Preview",
          message: `Remove ${feature.properties.filename} from the upload list?`,
          confirmText: "Remove",
          confirmButtonClass: "btn-danger",
        });

        if (confirmed) {
          const currentIndex = this.state.selectedFiles.findIndex(
            (f) => f.filename === feature.properties.filename,
          );
          if (currentIndex !== -1) {
            this.removeFile(currentIndex);
          }
        }
      }
    });

    // Change cursor on hover
    this.state.previewMap.on("mouseenter", this.state.previewLayerId, () => {
      this.state.previewMap.getCanvas().style.cursor = "pointer";
    });
    this.state.previewMap.on("mouseleave", this.state.previewLayerId, () => {
      this.state.previewMap.getCanvas().style.cursor = "";
    });
  }

  initializeEventListeners() {
    this.initializeDropZoneListeners();
    this.initializeUploadButtonListener();
    this.initializeCheckboxListeners();

    window.removeFile = (index) => this.removeFile(index);
  }

  initializeDropZoneListeners() {
    const { dropZone, fileInput } = this.elements;

    if (!dropZone || !fileInput) return;

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

    dropZone.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      fileInput.click();
    });

    fileInput.addEventListener("change", () =>
      this.handleFiles(fileInput.files),
    );
  }

  initializeUploadButtonListener() {
    const { uploadButton } = this.elements;

    if (!uploadButton) return;

    uploadButton.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      this.uploadFiles();
    });
  }

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

    document.addEventListener("change", (evt) => {
      if (evt.target.matches(".trip-checkbox")) {
        this.updateBulkDeleteButtonState();
      }
    });
  }

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
          window.notificationManager.show(
            `Unsupported file type: ${file.name}. Only .gpx and .geojson files are supported.`,
            "warning",
          );
          this.loadingManager.updateSubOperation("parsing", index + 1);
          resolve();
        }
      } catch (error) {
        console.error("Error handling file:", error);
        this.loadingManager.error(`Error handling file: ${file.name}`);
        reject(error);
      }
    });
  }

  readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = (error) => reject(error);
      reader.readAsText(file);
    });
  }

  getFileExtension(filename) {
    return filename
      .slice(((filename.lastIndexOf(".") - 1) >>> 0) + 1)
      .toLowerCase();
  }

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
            coordinates.push([lon, lat]);
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
      this.loadingManager.error(`Error parsing GPX file: ${file.name}`);
      window.notificationManager.show(
        `Error parsing ${file.name}: ${error.message}`,
        "danger",
      );
    }
  }

  parseGeoJSON(file, content) {
    try {
      const geojsonData = JSON.parse(content);

      if (geojsonData.type === "FeatureCollection") {
        if (!geojsonData.features || !Array.isArray(geojsonData.features)) {
          throw new Error("Invalid GeoJSON FeatureCollection structure");
        }

        geojsonData.features.forEach((feature, index) => {
          this.processGeoJSONFeature(feature, file, index);
        });
      } else if (geojsonData.type === "Feature") {
        this.processGeoJSONFeature(geojsonData, file, 0);
      } else if (geojsonData.type === "LineString") {
        this.processGeoJSONGeometry(geojsonData, file);
      } else {
        throw new Error(
          "Unsupported GeoJSON type. Must be FeatureCollection, Feature, or LineString.",
        );
      }
    } catch (error) {
      console.error("Error parsing GeoJSON:", error);
      this.loadingManager.error(`Error parsing GeoJSON file: ${file.name}`);
      window.notificationManager.show(
        `Error parsing ${file.name}: ${error.message}`,
        "danger",
      );
    }
  }

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
    const filename = `${file.name} (Feature ${index + 1})`;

    const fileEntry = {
      file,
      filename,
      startTime: properties.start_time
        ? new Date(properties.start_time)
        : properties.coordTimes?.length > 0
          ? new Date(properties.coordTimes[0])
          : null,
      endTime: properties.end_time
        ? new Date(properties.end_time)
        : properties.coordTimes?.length > 0
          ? new Date(properties.coordTimes[properties.coordTimes.length - 1])
          : null,
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
  }

  processGeoJSONGeometry(geometry, file) {
    const coordinates = geometry.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      console.warn(
        `Skipping geometry in ${file.name} due to insufficient coordinates.`,
      );
      return;
    }

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
      properties: {},
    };
    this.state.selectedFiles.push(fileEntry);
  }

  updateFileList() {
    const { fileListBody, uploadButton } = this.elements;

    if (!fileListBody) return;

    fileListBody.innerHTML = "";

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
      `;
      fileListBody.appendChild(row);
    });

    if (uploadButton) {
      uploadButton.disabled = this.state.selectedFiles.length === 0;
    }
  }

  updatePreviewMap() {
    const { previewMap, previewSourceId } = this.state;

    if (!previewMap) return;

    const features = this.state.selectedFiles
      .map((entry) => {
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
          return null;
        }

        return {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: validCoords,
          },
          properties: {
            filename: entry.filename,
          },
        };
      })
      .filter(Boolean);

    const source = previewMap.getSource(previewSourceId);
    if (source) {
      source.setData({
        type: "FeatureCollection",
        features,
      });
    }

    if (features.length > 0) {
      try {
        const bounds = features.reduce((bounds, feature) => {
          const coords = feature.geometry.coordinates;
          coords.forEach(([lng, lat]) => {
            bounds.extend([lng, lat]);
          });
          return bounds;
        }, new mapboxgl.LngLatBounds());

        previewMap.fitBounds(bounds, {
          padding: 50,
          maxZoom: 15,
        });
      } catch (e) {
        console.error("Error fitting map bounds:", e);
        previewMap.setCenter(this.config.map.defaultCenter);
        previewMap.setZoom(this.config.map.defaultZoom);
      }
    } else {
      previewMap.setCenter(this.config.map.defaultCenter);
      previewMap.setZoom(this.config.map.defaultZoom);
    }
  }

  updateStats() {
    const { totalFilesSpan, dateRangeSpan, totalPointsSpan } = this.elements;
    const { selectedFiles } = this.state;

    if (totalFilesSpan) {
      totalFilesSpan.textContent = selectedFiles.length;
    }

    if (dateRangeSpan) {
      const allTimes = selectedFiles
        .flatMap((entry) => [entry.startTime, entry.endTime])
        .filter((t) => t instanceof Date && !isNaN(t));

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
        (sum, entry) => sum + (entry.points || 0),
        0,
      );
      totalPointsSpan.textContent = totalPoints.toLocaleString();
    }
  }

  removeFile(index) {
    if (index >= 0 && index < this.state.selectedFiles.length) {
      const removedFile = this.state.selectedFiles.splice(index, 1);
      window.handleError(
        `Removed file ${removedFile[0]?.filename} from selection.`,
      );
      this.updateFileList();
      this.updatePreviewMap();
      this.updateStats();
    } else {
      console.warn(`Attempted to remove file at invalid index: ${index}`);
    }
  }

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
      if (entry.file instanceof File) {
        formData.append("files", entry.file, entry.filename);
        this.loadingManager.updateSubOperation("uploading", index + 1);
      } else {
        console.warn(`File object missing for ${entry.filename}, skipping.`);
        window.notificationManager.show(
          `Could not upload ${entry.filename}: File data missing. Please re-select the file.`,
          "warning",
        );
      }
    });

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
      const response = await fetch("/api/upload_gpx", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        let errorDetail = `Server responded with status: ${response.status}`;
        try {
          const errorData = await response.json();
          errorDetail = errorData.detail || errorDetail;
        } catch (error) {
          void error;
        }
        throw new Error(errorDetail);
      }

      const data = await response.json();

      if (data.status === "success") {
        window.notificationManager.show(data.message, "success");
        this.state.selectedFiles = [];
        this.updateFileList();
        this.updatePreviewMap();
        this.updateStats();
        this.loadUploadSourceTrips();
      } else {
        throw new Error(data.message || "Error uploading files");
      }
    } catch (error) {
      console.error("Error uploading files:", error);
      window.notificationManager.show(
        `Error uploading files: ${error.message}`,
        "danger",
      );
      this.loadingManager.error(`Error uploading files: ${error.message}`);
    } finally {
      if (uploadButton) {
        uploadButton.disabled = false;
        uploadButton.innerHTML = "Upload Selected Files";
      }
      this.loadingManager.finish();
    }
  }

  async loadUploadSourceTrips() {
    this.loadingManager.startOperation("Loading Uploaded Trips");

    try {
      const response = await fetch("/api/trips");

      if (!response.ok) {
        throw new Error(`Server responded with status: ${response.status}`);
      }

      const geojsonData = await response.json();

      if (geojsonData?.type === "FeatureCollection") {
        const allTrips = geojsonData.features.map((feature) => ({
          _id: feature.properties.transactionId,
          transactionId: feature.properties.transactionId,
          filename: feature.properties.filename || "N/A",
          startTime: feature.properties.startTime,
          endTime: feature.properties.endTime,
          source: feature.properties.source || "unknown",
        }));

        const uploadSourceTrips = allTrips.filter((trip) =>
          this.config.uploadSources.includes(trip.source),
        );

        this.displayUploadSourceTrips(uploadSourceTrips);
      } else {
        throw new Error("Invalid data format received from /api/trips");
      }
    } catch (error) {
      console.error("Error fetching trips:", error);
      window.notificationManager.show(
        "Error loading trips from server",
        "danger",
      );
      this.loadingManager.error(`Error fetching trips: ${error.message}`);
      this.displayUploadSourceTrips([]);
    } finally {
      this.loadingManager.finish();
    }
  }

  displayUploadSourceTrips(trips) {
    const { uploadedTripsBody } = this.elements;

    if (!uploadedTripsBody) return;

    this.loadingManager.startOperation("Displaying Uploaded Trips");

    uploadedTripsBody.innerHTML = "";
    this.state.displayedTrips = trips;

    trips.forEach((trip) => {
      const row = document.createElement("tr");

      const checkboxCell = document.createElement("td");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "trip-checkbox";
      checkbox.value = trip.transactionId;
      checkboxCell.appendChild(checkbox);
      row.appendChild(checkboxCell);

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
            trip.transactionId
          }">
            <i class="fas fa-trash-alt"></i> Delete
          </button>
        </td>
      `;

      uploadedTripsBody.appendChild(row);
    });

    this.bindDeleteTripButtons();
    this.updateBulkDeleteButtonState();
    this.loadingManager.finish();
  }

  bindDeleteTripButtons() {
    document.querySelectorAll(".delete-trip").forEach((button) => {
      button.replaceWith(button.cloneNode(true));
    });
    document.querySelectorAll(".delete-trip").forEach((button) => {
      button.addEventListener("click", (e) => {
        const tripId = e.currentTarget.dataset.tripId;
        if (tripId) {
          this.deleteTrip(tripId);
        }
      });
    });
  }

  updateBulkDeleteButtonState() {
    const { bulkDeleteBtn } = this.elements;

    if (!bulkDeleteBtn) return;

    const selectedCheckboxes = document.querySelectorAll(
      ".trip-checkbox:checked",
    );
    bulkDeleteBtn.disabled = selectedCheckboxes.length === 0;
  }

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
        if (bulkDeleteBtn) bulkDeleteBtn.disabled = true;
        let successCount = 0;
        let failCount = 0;
        this.loadingManager.addSubOperation("bulk_delete", tripIds.length);

        for (let i = 0; i < tripIds.length; i++) {
          const tripId = tripIds[i];
          try {
            const response = await fetch(`/api/trips/${tripId}`, {
              method: "DELETE",
            });
            if (!response.ok) {
              let errorMsg = `Failed to delete trip ${tripId} (Status: ${response.status})`;
              try {
                const errData = await response.json();
                errorMsg = errData.detail || errorMsg;
              } catch (error) {
                void error;
              }
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

        await this.loadUploadSourceTrips();
      }
    } catch (error) {
      window.notificationManager.show(
        `An unexpected error occurred during bulk deletion: ${error.message}`,
        "danger",
      );
      this.loadingManager.error(`Error during bulk deletion: ${error.message}`);
    } finally {
      if (bulkDeleteBtn) bulkDeleteBtn.disabled = false;
      if (this.elements.selectAllCheckbox)
        this.elements.selectAllCheckbox.checked = false;
      this.updateBulkDeleteButtonState();
      this.loadingManager.finish();
    }
  }

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
        const response = await fetch(`/api/trips/${tripId}`, {
          method: "DELETE",
        });

        if (!response.ok) {
          let errorDetail = `Server responded with status: ${response.status}`;
          try {
            const errorData = await response.json();
            errorDetail = errorData.detail || errorDetail;
          } catch (error) {
            void error;
          }
          throw new Error(errorDetail);
        }

        const data = await response.json();

        if (data.status === "success") {
          window.notificationManager.show(
            `Trip ${tripId} deleted successfully. Matched trips deleted: ${data.deleted_matched_trips}`,
            "success",
          );
          await this.loadUploadSourceTrips();
        } else {
          throw new Error(data.message || "Error deleting trip");
        }
      }
    } catch (error) {
      window.notificationManager.show(
        `Error deleting trip: ${error.message}`,
        "danger",
      );
      this.loadingManager.error(`Error deleting trip: ${error.message}`);
    } finally {
      this.loadingManager.finish();
    }
  }
}

const uploadManager = new UploadManager();
