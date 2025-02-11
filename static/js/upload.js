/* global L, LoadingManager, uploadFiles, parseFiles, notificationManager, bootstrap, confirmationDialog */
(() => {
  "use strict";

  const dropZone = document.getElementById("dropZone");
  const fileInput = document.getElementById("fileInput");
  const fileListBody = document.getElementById("fileListBody");
  const uploadButton = document.getElementById("uploadButton");
  const totalFilesSpan = document.getElementById("totalFiles");
  const dateRangeSpan = document.getElementById("dateRange");
  const totalPointsSpan = document.getElementById("totalPoints");
  let previewMap = null;
  let previewLayer = null;
  let selectedFiles = [];

  const loadingManager = new LoadingManager();

  // Initialize the preview map
  function initializePreviewMap() {
    previewMap = L.map("previewMap").setView([37.0902, -95.7129], 4);
    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      {
        maxZoom: 19,
        attribution: "",
      },
    ).addTo(previewMap);
    previewLayer = L.featureGroup().addTo(previewMap);
  }

  // Drag and drop event handlers
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
    handleFiles(e.dataTransfer.files);
  });

  dropZone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => handleFiles(fileInput.files));

  // Process a list of files
  async function handleFiles(files) {
    loadingManager.startOperation("Handling Files");
    loadingManager.addSubOperation("parsing", files.length);
    selectedFiles = []; // Reset for new files
    const filePromises = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const promise = new Promise((resolve, reject) => {
        try {
          if (file.name.endsWith(".gpx")) {
            const reader = new FileReader();
            reader.onload = (e) => {
              parseGPX(file, e.target.result);
              loadingManager.updateSubOperation("parsing", i + 1);
              resolve();
            };
            reader.onerror = (error) => reject(error);
            reader.readAsText(file);
          } else if (file.name.endsWith(".geojson")) {
            const reader = new FileReader();
            reader.onload = (e) => {
              parseGeoJSON(file, e.target.result);
              loadingManager.updateSubOperation("parsing", i + 1);
              resolve();
            };
            reader.onerror = (error) => reject(error);
            reader.readAsText(file);
          } else {
            reject(
              new Error(
                `Invalid file type: ${file.name}. Only .gpx and .geojson files are supported.`,
              ),
            );
          }
        } catch (error) {
          console.error("Error handling file:", error);
          loadingManager.error("Error handling file: " + file.name);
          reject(error);
        }
      });
      filePromises.push(promise);
    }

    try {
      await Promise.all(filePromises);
      updateFileList();
      updatePreviewMap();
      updateStats();
    } catch (error) {
      console.error("Error during file processing:", error);
      loadingManager.error("Error during file processing.");
    } finally {
      loadingManager.finish();
    }
  }

  // Parse GPX file content
  function parseGPX(file, gpxContent) {
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
      const startTime = times.length > 0 ? new Date(Math.min(...times)) : null;
      const endTime = times.length > 0 ? new Date(Math.max(...times)) : null;
      const fileEntry = {
        file,
        filename: file.name,
        startTime,
        endTime,
        points: coordinates.length,
        coordinates,
      };
      selectedFiles.push(fileEntry);
    } catch (error) {
      console.error("Error parsing GPX:", error);
      loadingManager.error("Error parsing GPX file: " + file.name);
    }
  }

  // Parse GeoJSON file content
  function parseGeoJSON(file, content) {
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
        selectedFiles.push(fileEntry);
      });
    } catch (error) {
      console.error("Error parsing GeoJSON:", error);
      loadingManager.error("Error parsing GeoJSON file: " + file.name);
    }
  }

  // Update the file list display
  function updateFileList() {
    fileListBody.innerHTML = "";
    selectedFiles.forEach((entry, index) => {
      const row = document.createElement("tr");
      row.innerHTML = `
          <td>${entry.filename}</td>
          <td>${entry.startTime ? entry.startTime.toLocaleString() : "-"} - ${entry.endTime ? entry.endTime.toLocaleString() : "-"}</td>
          <td>${entry.points}</td>
          <td>Pending</td>
          <td><button class="btn btn-sm btn-danger" onclick="removeFile(${index})">Remove</button></td>
        `;
      fileListBody.appendChild(row);
    });
    uploadButton.disabled = selectedFiles.length === 0;
  }

  // Update the preview map with file data
  function updatePreviewMap() {
    previewLayer.clearLayers();
    selectedFiles.forEach((entry) => {
      const latlngs = entry.coordinates.map((coord) => [coord[1], coord[0]]);
      const polyline = L.polyline(latlngs, { color: "red" }).addTo(
        previewLayer,
      );
      polyline.on("click", async () => {
        const confirmed = await confirmationDialog.show({
          title: 'Remove File',
          message: `Remove ${entry.filename}?`,
          confirmText: 'Remove',
          confirmButtonClass: 'btn-danger'
        });
        if (confirmed) {
          selectedFiles = selectedFiles.filter((e) => e !== entry);
          updateFileList();
          updatePreviewMap();
          updateStats();
        }
      });
    });
    if (previewLayer.getLayers().length > 0) {
      previewMap.fitBounds(previewLayer.getBounds());
    }
  }

  // Update file upload statistics
  function updateStats() {
    totalFilesSpan.textContent = selectedFiles.length;
    const allTimes = selectedFiles
      .flatMap((entry) => [entry.startTime, entry.endTime])
      .filter((t) => t);
    if (allTimes.length > 0) {
      const minTime = new Date(Math.min(...allTimes));
      const maxTime = new Date(Math.max(...allTimes));
      dateRangeSpan.textContent = `${minTime.toLocaleString()} - ${maxTime.toLocaleString()}`;
    } else {
      dateRangeSpan.textContent = "-";
    }
    const totalPoints = selectedFiles.reduce(
      (sum, entry) => sum + entry.points,
      0,
    );
    totalPointsSpan.textContent = totalPoints;
  }

  // Remove a file from the selected files list
  window.removeFile = function (index) {
    selectedFiles.splice(index, 1);
    updateFileList();
    updatePreviewMap();
    updateStats();
  };

  // Upload files when the upload button is clicked
  uploadButton.addEventListener("click", () => {
    loadingManager.startOperation("Uploading Files");
    loadingManager.addSubOperation("uploading", selectedFiles.length);
    const formData = new FormData();
    selectedFiles.forEach((entry, index) => {
      formData.append("files[]", entry.file);
      loadingManager.updateSubOperation("uploading", index + 1);
    });
    const mapMatch = document.getElementById("mapMatchOnUpload").checked;
    formData.append("map_match", mapMatch);
    uploadButton.disabled = true;
    fetch("/api/upload_gpx", {
      method: "POST",
      body: formData,
    })
      .then((response) => response.json())
      .then((data) => {
        uploadButton.disabled = false;
        if (data.status === "success") {
          notificationManager.show(data.message, "success");
          selectedFiles = [];
          updateFileList();
          updatePreviewMap();
          updateStats();
          loadUploadedTrips();
        } else {
          throw new Error(data.message);
        }
      })
      .catch((error) => {
        console.error("Error uploading files:", error);
        loadingManager.error("Error uploading files: " + error.message);
      })
      .finally(() => loadingManager.finish());
  });

  // Load uploaded trips from the server
  function loadUploadedTrips() {
    loadingManager.startOperation("Loading Uploaded Trips");
    fetch("/api/uploaded_trips")
      .then((response) => response.json())
      .then((data) => {
        if (data.status === "success") {
          displayUploadedTrips(data.trips);
        } else {
          throw new Error(data.message);
        }
      })
      .catch((error) => {
        console.error("Error fetching uploaded trips:", error);
        loadingManager.error("Error fetching uploaded trips: " + error.message);
      })
      .finally(() => loadingManager.finish());
  }

  // Display uploaded trips in the historical trips table
  function displayUploadedTrips(trips) {
    loadingManager.startOperation("Displaying Uploaded Trips");
    const tbody = document.getElementById("historicalTripsBody");
    tbody.innerHTML = "";
    trips.forEach((trip) => {
      const row = document.createElement("tr");

      const checkboxCell = document.createElement("td");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.classList.add("trip-checkbox");
      checkbox.value = trip._id;
      checkboxCell.appendChild(checkbox);
      row.appendChild(checkboxCell);

      const transactionIdCell = document.createElement("td");
      transactionIdCell.textContent = trip.transactionId;
      row.appendChild(transactionIdCell);

      const filenameCell = document.createElement("td");
      filenameCell.textContent = trip.filename;
      row.appendChild(filenameCell);

      const startTimeCell = document.createElement("td");
      startTimeCell.textContent = trip.startTime
        ? new Date(trip.startTime).toLocaleString()
        : "-";
      row.appendChild(startTimeCell);

      const endTimeCell = document.createElement("td");
      endTimeCell.textContent = trip.endTime
        ? new Date(trip.endTime).toLocaleString()
        : "-";
      row.appendChild(endTimeCell);

      const sourceCell = document.createElement("td");
      sourceCell.textContent = trip.source || "upload";
      row.appendChild(sourceCell);

      const actionsCell = document.createElement("td");
      const deleteButton = document.createElement("button");
      deleteButton.classList.add("btn", "btn-sm", "btn-danger");
      deleteButton.textContent = "Delete";
      deleteButton.onclick = () => deleteUploadedTrip(trip._id);
      actionsCell.appendChild(deleteButton);
      row.appendChild(actionsCell);

      tbody.appendChild(row);
    });
    addCheckboxEventListeners();
    updateBulkDeleteButtonState();
    loadingManager.finish();
  }

  // Checkbox event listeners for bulk delete functionality
  function addCheckboxEventListeners() {
    const selectAllCheckbox = document.getElementById("select-all");
    selectAllCheckbox.addEventListener("change", function () {
      document
        .querySelectorAll(".trip-checkbox")
        .forEach((cb) => (cb.checked = this.checked));
      updateBulkDeleteButtonState();
    });
    document.querySelectorAll(".trip-checkbox").forEach((cb) => {
      cb.addEventListener("change", function () {
        const allCheckboxes = document.querySelectorAll(".trip-checkbox");
        selectAllCheckbox.checked = Array.from(allCheckboxes).every(
          (cb) => cb.checked,
        );
        updateBulkDeleteButtonState();
      });
    });
  }

  function updateBulkDeleteButtonState() {
    const selectedCheckboxes = document.querySelectorAll(
      ".trip-checkbox:checked",
    );
    const bulkDeleteBtn = document.getElementById("bulk-delete-btn");
    bulkDeleteBtn.disabled = selectedCheckboxes.length === 0;
    if (!bulkDeleteBtn.dataset.listenerAdded) {
      bulkDeleteBtn.addEventListener("click", bulkDeleteTrips);
      bulkDeleteBtn.dataset.listenerAdded = "true";
    }
  }

  // Delete selected trips in bulk
  async function bulkDeleteTrips() {
    loadingManager.startOperation("Deleting Selected Trips");
    const selectedCheckboxes = document.querySelectorAll(
      ".trip-checkbox:checked",
    );
    const tripIds = Array.from(selectedCheckboxes).map((cb) => cb.value);
    if (tripIds.length === 0) {
      notificationManager.show("No trips selected for deletion.", "warning");
      loadingManager.finish();
      return;
    }

    const confirmed = await confirmationDialog.show({
      title: 'Delete Trips',
      message: `Are you sure you want to delete ${tripIds.length} selected trips?`,
      confirmText: 'Delete',
      confirmButtonClass: 'btn-danger'
    });

    if (confirmed) {
      try {
        const response = await fetch("/api/uploaded_trips/bulk_delete", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trip_ids: tripIds }),
        });
        const data = await response.json();
        if (data.status === "success") {
          notificationManager.show(
            `${data.deleted_uploaded_trips} uploaded trips and ${data.deleted_matched_trips} matched trips deleted successfully.`,
            "success"
          );
          loadUploadedTrips();
        } else {
          throw new Error(data.message);
        }
      } catch (error) {
        console.error("Error deleting trips:", error);
        loadingManager.error("Error deleting trips: " + error.message);
      } finally {
        loadingManager.finish();
      }
    }
  }

  // Delete an individual uploaded trip
  async function deleteUploadedTrip(tripId) {
    loadingManager.startOperation("Deleting Trip");
    
    const confirmed = await confirmationDialog.show({
      title: 'Delete Trip',
      message: 'Are you sure you want to delete this trip?',
      confirmText: 'Delete',
      confirmButtonClass: 'btn-danger'
    });

    if (confirmed) {
      try {
        const response = await fetch("/api/uploaded_trips/bulk_delete", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trip_ids: [tripId] }),
        });
        const data = await response.json();
        if (data.status === "success") {
          notificationManager.show(
            `Trip deleted successfully. Matched trips deleted: ${data.deleted_matched_trips}`,
            "success"
          );
          loadUploadedTrips();
        } else {
          throw new Error(data.message);
        }
      } catch (error) {
        console.error("Error deleting trip:", error);
        loadingManager.error("Error deleting trip: " + error.message);
      } finally {
        loadingManager.finish();
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    initializePreviewMap();
    loadUploadedTrips();
  });

  // An alternative file upload handler that uses external functions
  async function handleFileUpload(files) {
    loadingManager.startOperation("Processing Files");
    loadingManager.addSubOperation("parsing", 0.3);
    loadingManager.addSubOperation("preview", 0.3);
    loadingManager.addSubOperation("upload", 0.4);
    try {
      loadingManager.updateSubOperation("parsing", 50);
      await parseFiles(files);
      loadingManager.updateSubOperation("parsing", 100);

      loadingManager.updateSubOperation("preview", 50);
      updateFileList();
      updatePreviewMap();
      loadingManager.updateSubOperation("preview", 100);

      loadingManager.updateSubOperation("upload", 50);
      await uploadFiles();
      loadingManager.updateSubOperation("upload", 100);
    } catch (error) {
      console.error("Upload error:", error);
    } finally {
      loadingManager.finish();
    }
  }
})();
