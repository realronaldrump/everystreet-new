/* global L, EveryStreet, LoadingManager, uploadFiles, parseFiles*/
const dropZone = document.getElementById('dropZone');
let fileInput = document.getElementById('fileInput');
let fileListBody = document.getElementById('fileListBody');
let uploadButton = document.getElementById('uploadButton');
let totalFilesSpan = document.getElementById('totalFiles');
let dateRangeSpan = document.getElementById('dateRange');
let totalPointsSpan = document.getElementById('totalPoints');
let previewMap = null;
let previewLayer = null;
let selectedFiles = [];

// Get the LoadingManager instance
const loadingManager = new LoadingManager();

function initializePreviewMap() {
    previewMap = L.map('previewMap').setView([37.0902, -95.7129], 4); // Center of USA
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        attribution: '',
    }).addTo(previewMap);
    previewLayer = L.featureGroup().addTo(previewMap);
}

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    let files = e.dataTransfer.files;
    handleFiles(files);
});

dropZone.addEventListener('click', () => {
    fileInput.click();
});

fileInput.addEventListener('change', () => {
    let files = fileInput.files;
    handleFiles(files);
});

async function handleFiles(files) {
    loadingManager.startOperation('Handling Files');
    loadingManager.addSubOperation('parsing', files.length);

    selectedFiles = []; // Reset selectedFiles for each new set of files

    const filePromises = [];

    for (let i = 0; i < files.length; i++) {
        let file = files[i];
        const filePromise = new Promise((resolve, reject) => {
            try {
                if (file.name.endsWith('.gpx')) {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        parseGPX(file, e.target.result);
                        loadingManager.updateSubOperation('parsing', i + 1);
                        resolve();
                    };
                    reader.onerror = (error) => {
                        reject(error);
                    };
                    reader.readAsText(file);
                } else if (file.name.endsWith('.geojson')) {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        parseGeoJSON(file, e.target.result);
                        loadingManager.updateSubOperation('parsing', i + 1);
                        resolve();
                    };
                    reader.onerror = (error) => {
                        reject(error);
                    };
                    reader.readAsText(file);
                } else {
                    reject(new Error('Invalid file type: ' + file.name + '. Only .gpx and .geojson files are supported.'));
                }
            } catch (error) {
                console.error('Error handling file:', error);
                loadingManager.error('Error handling file: ' + file.name);
                reject(error);
            }
        });
        filePromises.push(filePromise);
    }

    // Wait for all files to be parsed
    try {
        await Promise.all(filePromises);
        updateFileList();
        updatePreviewMap();
        updateStats();
    } catch (error) {
        console.error('Error during file processing:', error);
        loadingManager.error('Error during file processing.');
    } finally {
        loadingManager.finish();
    }
}

function parseGPX(file, gpxContent) {
    try {
        let parser = new DOMParser();
        let gpxDoc = parser.parseFromString(gpxContent, 'application/xml');
        let trkpts = gpxDoc.getElementsByTagName('trkpt');
        let coordinates = [];
        let times = [];

        for (let i = 0; i < trkpts.length; i++) {
            let trkpt = trkpts[i];
            let lat = parseFloat(trkpt.getAttribute('lat'));
            let lon = parseFloat(trkpt.getAttribute('lon'));
            coordinates.push([lon, lat]); // GeoJSON format expects [longitude, latitude]
            let timeElems = trkpt.getElementsByTagName('time');
            if (timeElems.length > 0) {
                times.push(new Date(timeElems[0].textContent));
            }
        }

        if (coordinates.length === 0) {
            throw new Error('No coordinates found in ' + file.name);
        }

        let startTime = times.length > 0 ? new Date(Math.min(...times)) : null;
        let endTime = times.length > 0 ? new Date(Math.max(...times)) : null;

        let fileEntry = {
            file: file,
            filename: file.name,
            startTime: startTime,
            endTime: endTime,
            points: coordinates.length,
            coordinates: coordinates,
        };

        selectedFiles.push(fileEntry);
    } catch (error) {
        console.error('Error parsing GPX:', error);
        loadingManager.error('Error parsing GPX file: ' + file.name);
    }
}

function parseGeoJSON(file, content) {
    try {
        const geojsonData = JSON.parse(content);
        if (!geojsonData.features || !Array.isArray(geojsonData.features)) {
            throw new Error('Invalid GeoJSON structure');
        }

        geojsonData.features.forEach((feature) => {
            if (!feature.geometry || !feature.properties) {
                return;
            }

            const coordinates = feature.geometry.coordinates;
            const properties = feature.properties;

            let fileEntry = {
                file: file,
                filename: file.name,
                startTime: properties.start_time ? new Date(properties.start_time) : null,
                endTime: properties.end_time ? new Date(properties.end_time) : null,
                points: coordinates.length,
                coordinates: coordinates,
                type: 'geojson',
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
        console.error('Error parsing GeoJSON:', error);
        loadingManager.error('Error parsing GeoJSON file: ' + file.name);
    }
}

function updateFileList() {
    fileListBody.innerHTML = '';

    selectedFiles.forEach((entry, index) => {
        let row = document.createElement('tr');
        row.innerHTML = `
            <td>${entry.filename}</td>
            <td>${entry.startTime ? entry.startTime.toLocaleString() : '-'} - ${
      entry.endTime ? entry.endTime.toLocaleString() : '-'
    }</td>
            <td>${entry.points}</td>
            <td>Pending</td>
            <td><button class="btn btn-sm btn-danger" onclick="removeFile(${index})">Remove</button></td>
        `;
        fileListBody.appendChild(row);
    });

    uploadButton.disabled = selectedFiles.length === 0;
}

function updatePreviewMap() {
    previewLayer.clearLayers();

    selectedFiles.forEach((entry) => {
        // Swap [lon, lat] to [lat, lon] for Leaflet
        let latlngs = entry.coordinates.map((coord) => [coord[1], coord[0]]);
        let polyline = L.polyline(latlngs, {
            color: 'red',
        }).addTo(previewLayer);

        polyline.on('click', () => {
            if (confirm(`Remove ${entry.filename}?`)) {
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

function updateStats() {
    totalFilesSpan.textContent = selectedFiles.length;
    let allTimes = selectedFiles.flatMap((entry) => [entry.startTime, entry.endTime]).filter((t) => t);
    if (allTimes.length > 0) {
        let minTime = new Date(Math.min(...allTimes));
        let maxTime = new Date(Math.max(...allTimes));
        dateRangeSpan.textContent = `${minTime.toLocaleString()} - ${maxTime.toLocaleString()}`;
    } else {
        dateRangeSpan.textContent = '-';
    }

    let totalPoints = selectedFiles.reduce((sum, entry) => sum + entry.points, 0);
    totalPointsSpan.textContent = totalPoints;
}

function removeFile(index) {
    selectedFiles.splice(index, 1);
    updateFileList();
    updatePreviewMap();
    updateStats();
}

uploadButton.addEventListener('click', () => {
    loadingManager.startOperation('Uploading Files');
    loadingManager.addSubOperation('uploading', selectedFiles.length);

    let formData = new FormData();
    selectedFiles.forEach((entry, index) => {
        formData.append('files[]', entry.file);
        loadingManager.updateSubOperation('uploading', index + 1);
    });

    let mapMatch = document.getElementById('mapMatchOnUpload').checked;
    formData.append('map_match', mapMatch);

    uploadButton.disabled = true;

    fetch('/api/upload_gpx', {
            // Updated URL to match Flask route
            method: 'POST',
            body: formData,
        })
        .then((response) => response.json())
        .then((data) => {
            uploadButton.disabled = false;
            if (data.status === 'success') {
                alert(data.message);
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
            console.error('Error uploading files:', error);
            loadingManager.error('Error uploading files: ' + error.message);
        })
        .finally(() => {
            loadingManager.finish();
        });
});

function loadUploadedTrips() {
    loadingManager.startOperation('Loading Uploaded Trips');
    fetch('/api/uploaded_trips')
        .then((response) => response.json())
        .then((data) => {
            if (data.status === 'success') {
                displayUploadedTrips(data.trips);
            } else {
                throw new Error(data.message);
            }
        })
        .catch((error) => {
            console.error('Error fetching uploaded trips:', error);
            loadingManager.error('Error fetching uploaded trips: ' + error.message);
        })
        .finally(() => {
            loadingManager.finish();
        });
}

function displayUploadedTrips(trips) {
    loadingManager.startOperation('Displaying Uploaded Trips');
    let tbody = document.getElementById('historicalTripsBody');
    tbody.innerHTML = '';

    trips.forEach((trip, index) => {
        let row = document.createElement('tr');

        // Checkbox cell
        let checkboxCell = document.createElement('td');
        let checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.classList.add('trip-checkbox');
        checkbox.value = trip._id;
        checkboxCell.appendChild(checkbox);
        row.appendChild(checkboxCell);

        // Transaction ID
        let transactionIdCell = document.createElement('td');
        transactionIdCell.textContent = trip.transactionId;
        row.appendChild(transactionIdCell);

        // Filename
        let filenameCell = document.createElement('td');
        filenameCell.textContent = trip.filename;
        row.appendChild(filenameCell);

        // Start Time
        let startTimeCell = document.createElement('td');
        startTimeCell.textContent = trip.startTime ? new Date(trip.startTime).toLocaleString() : '-';
        row.appendChild(startTimeCell);

        // End Time
        let endTimeCell = document.createElement('td');
        endTimeCell.textContent = trip.endTime ? new Date(trip.endTime).toLocaleString() : '-';
        row.appendChild(endTimeCell);

        // Source
        let sourceCell = document.createElement('td');
        sourceCell.textContent = trip.source || 'upload';
        row.appendChild(sourceCell);

        // Actions
        let actionsCell = document.createElement('td');
        let deleteButton = document.createElement('button');
        deleteButton.classList.add('btn', 'btn-sm', 'btn-danger');
        deleteButton.textContent = 'Delete';
        deleteButton.onclick = () => deleteUploadedTrip(trip._id);
        actionsCell.appendChild(deleteButton);
        row.appendChild(actionsCell);

        tbody.appendChild(row);
    });

    // Update event listeners for checkboxes and 'select all'
    addCheckboxEventListeners();

    updateBulkDeleteButtonState();
    loadingManager.finish();
}

function addCheckboxEventListeners() {
    const selectAllCheckbox = document.getElementById('select-all');
    selectAllCheckbox.addEventListener('change', function() {
        const checkboxes = document.querySelectorAll('.trip-checkbox');
        checkboxes.forEach((cb) => (cb.checked = this.checked));
        updateBulkDeleteButtonState();
    });

    const individualCheckboxes = document.querySelectorAll('.trip-checkbox');
    individualCheckboxes.forEach((cb) => {
        cb.addEventListener('change', function() {
            const allCheckboxes = document.querySelectorAll('.trip-checkbox');
            const allChecked = Array.from(allCheckboxes).every((cb) => cb.checked);
            selectAllCheckbox.checked = allChecked;
            updateBulkDeleteButtonState();
        });
    });
}

function updateBulkDeleteButtonState() {
    const selectedCheckboxes = document.querySelectorAll('.trip-checkbox:checked');
    const bulkDeleteBtn = document.getElementById('bulk-delete-btn');
    bulkDeleteBtn.disabled = selectedCheckboxes.length === 0;

    // Add event listener if not already added
    if (!bulkDeleteBtn.dataset.listenerAdded) {
        bulkDeleteBtn.addEventListener('click', bulkDeleteTrips);
        bulkDeleteBtn.dataset.listenerAdded = 'true';
    }
}

function bulkDeleteTrips() {
    loadingManager.startOperation('Deleting Selected Trips');
    const selectedCheckboxes = document.querySelectorAll('.trip-checkbox:checked');
    const tripIds = Array.from(selectedCheckboxes).map((cb) => cb.value);

    if (tripIds.length === 0) {
        alert('No trips selected for deletion.');
        loadingManager.finish();
        return;
    }

    if (!confirm(`Are you sure you want to delete ${tripIds.length} selected trips?`)) {
        loadingManager.finish();
        return;
    }

    fetch('/api/uploaded_trips/bulk_delete', {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                trip_ids: tripIds,
            }),
        })
        .then((response) => response.json())
        .then((data) => {
            if (data.status === 'success') {
                alert(
                    `${data.deleted_uploaded_trips} uploaded trips and ${data.deleted_matched_trips} matched trips deleted successfully.`
                );
                loadUploadedTrips();
            } else {
                throw new Error(data.message);
            }
        })
        .catch((error) => {
            console.error('Error deleting trips:', error);
            loadingManager.error('Error deleting trips: ' + error.message);
        })
        .finally(() => {
            loadingManager.finish();
        });
}

// Ensure that individual trip deletion also removes the corresponding matched trip
function deleteUploadedTrip(tripId) {
    loadingManager.startOperation('Deleting Trip');
    if (!confirm('Are you sure you want to delete this trip?')) {
        loadingManager.finish();
        return;
    }

    fetch('/api/uploaded_trips/bulk_delete', {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                trip_ids: [tripId],
            }),
        })
        .then((response) => response.json())
        .then((data) => {
            if (data.status === 'success') {
                alert(`Trip deleted successfully. Matched trips deleted: ${data.deleted_matched_trips}`);
                loadUploadedTrips();
            } else {
                throw new Error(data.message);
            }
        })
        .catch((error) => {
            console.error('Error deleting trip:', error);
            loadingManager.error('Error deleting trip: ' + error.message);
        })
        .finally(() => {
            loadingManager.finish();
        });
}

document.addEventListener('DOMContentLoaded', () => {
    initializePreviewMap();
    loadUploadedTrips();
});

async function handleFileUpload(files) {
    // Removed the reference to getLoadingManager() here.
    loadingManager.startOperation('Processing Files');
    loadingManager.addSubOperation('parsing', 0.3);
    loadingManager.addSubOperation('preview', 0.3);
    loadingManager.addSubOperation('upload', 0.4);

    try {
        loadingManager.updateSubOperation('parsing', 50);
        // Parse files
        await parseFiles(files);
        loadingManager.updateSubOperation('parsing', 100);

        loadingManager.updateSubOperation('preview', 50);
        // Update preview
        updateFileList();
        updatePreviewMap();
        loadingManager.updateSubOperation('preview', 100);

        loadingManager.updateSubOperation('upload', 50);
        // Handle upload
        await uploadFiles();
        loadingManager.updateSubOperation('upload', 100);
    } catch (error) {
        console.error('Upload error:', error);
    } finally {
        loadingManager.finish();
    }
}