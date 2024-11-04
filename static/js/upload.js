let dropZone = document.getElementById('dropZone');
let fileInput = document.getElementById('fileInput');
let fileListBody = document.getElementById('fileListBody');
let uploadButton = document.getElementById('uploadButton');
let totalFilesSpan = document.getElementById('totalFiles');
let dateRangeSpan = document.getElementById('dateRange');
let totalPointsSpan = document.getElementById('totalPoints');
let previewMap = null;
let previewLayer = null;
let selectedFiles = [];

function initializePreviewMap() {
    previewMap = L.map('previewMap').setView([37.0902, -95.7129], 4); // Center of USA
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        attribution: ''
    }).addTo(previewMap);
    previewLayer = L.featureGroup().addTo(previewMap);  // Changed from layerGroup to featureGroup
}

initializePreviewMap();

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

function handleFiles(files) {
    for (let i = 0; i < files.length; i++) {
        let file = files[i];
        if (file.name.endsWith('.gpx')) {
            let reader = new FileReader();
            reader.onload = (e) => {
                parseGPX(file, e.target.result);
            };
            reader.readAsText(file);
        } else {
            alert('Invalid file type: ' + file.name);
        }
    }
}

function parseGPX(file, gpxContent) {
    let parser = new DOMParser();
    let gpxDoc = parser.parseFromString(gpxContent, 'application/xml');
    let trkpts = gpxDoc.getElementsByTagName('trkpt');
    let coordinates = [];
    let times = [];

    for (let i = 0; i < trkpts.length; i++) {
        let trkpt = trkpts[i];
        let lat = parseFloat(trkpt.getAttribute('lat'));
        let lon = parseFloat(trkpt.getAttribute('lon'));
        coordinates.push([lon, lat]);  // GeoJSON format expects [longitude, latitude]
        let timeElems = trkpt.getElementsByTagName('time');
        if (timeElems.length > 0) {
            times.push(new Date(timeElems[0].textContent));
        }
    }

    if (coordinates.length === 0) {
        alert('No coordinates found in ' + file.name);
        return;
    }

    let startTime = times.length > 0 ? new Date(Math.min(...times)) : null;
    let endTime = times.length > 0 ? new Date(Math.max(...times)) : null;

    let fileEntry = {
        file: file,
        filename: file.name,
        startTime: startTime,
        endTime: endTime,
        points: coordinates.length,
        coordinates: coordinates
    };

    selectedFiles.push(fileEntry);
    updateFileList();
    updatePreviewMap();
    updateStats();
}

function updateFileList() {
    fileListBody.innerHTML = '';

    selectedFiles.forEach((entry, index) => {
        let row = document.createElement('tr');
        row.innerHTML = `
            <td>${entry.filename}</td>
            <td>${entry.startTime ? entry.startTime.toLocaleString() : '-'} - ${entry.endTime ? entry.endTime.toLocaleString() : '-'}</td>
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
        let latlngs = entry.coordinates.map(coord => [coord[1], coord[0]]);
        let polyline = L.polyline(latlngs, { color: 'red' }).addTo(previewLayer);

        polyline.on('click', () => {
            if (confirm(`Remove ${entry.filename}?`)) {
                selectedFiles = selectedFiles.filter(e => e !== entry);
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
    let allTimes = selectedFiles.flatMap(entry => [entry.startTime, entry.endTime]).filter(t => t);
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
    let formData = new FormData();
    selectedFiles.forEach(entry => {
        formData.append('files[]', entry.file);
    });

    let mapMatch = document.getElementById('mapMatchOnUpload').checked;
    formData.append('map_match', mapMatch);

    uploadButton.disabled = true;

    fetch('/api/upload_gpx', {  // Updated URL to match Flask route
        method: 'POST',
        body: formData
    })
    .then(response => response.json())
    .then(data => {
        uploadButton.disabled = false;
        if (data.status === 'success') {
            alert(data.message);
            selectedFiles = [];
            updateFileList();
            updatePreviewMap();
            updateStats();
            loadUploadedTrips();
        } else {
            alert('Error uploading files: ' + data.message);
        }
    })
    .catch(error => {
        uploadButton.disabled = false;
        console.error('Error uploading files:', error);
        alert('An error occurred while uploading files.');
    });
});

function loadUploadedTrips() {
    fetch('/api/uploaded_trips')
    .then(response => response.json())
    .then(data => {
        if (data.status === 'success') {
            displayUploadedTrips(data.trips);
        } else {
            alert('Error fetching uploaded trips: ' + data.message);
        }
    })
    .catch(error => {
        console.error('Error fetching uploaded trips:', error);
    });
}

function displayUploadedTrips(trips) {
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
}

function addCheckboxEventListeners() {
    const selectAllCheckbox = document.getElementById('select-all');
    selectAllCheckbox.addEventListener('change', function() {
        const checkboxes = document.querySelectorAll('.trip-checkbox');
        checkboxes.forEach(cb => cb.checked = this.checked);
        updateBulkDeleteButtonState();
    });

    const individualCheckboxes = document.querySelectorAll('.trip-checkbox');
    individualCheckboxes.forEach(cb => {
        cb.addEventListener('change', function() {
            const allCheckboxes = document.querySelectorAll('.trip-checkbox');
            const allChecked = Array.from(allCheckboxes).every(cb => cb.checked);
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
        bulkDeleteBtn.dataset.listenerAdded = true;
    }
}

function bulkDeleteTrips() {
    const selectedCheckboxes = document.querySelectorAll('.trip-checkbox:checked');
    const tripIds = Array.from(selectedCheckboxes).map(cb => cb.value);

    if (tripIds.length === 0) {
        alert('No trips selected for deletion.');
        return;
    }

    if (!confirm(`Are you sure you want to delete ${tripIds.length} selected trips?`)) {
        return;
    }

    fetch('/api/uploaded_trips/bulk_delete', {
        method: 'DELETE',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ trip_ids: tripIds })
    })
    .then(response => response.json())
    .then(data => {
        if (data.status === 'success') {
            alert(`${data.deleted_uploaded_trips} uploaded trips and ${data.deleted_matched_trips} matched trips deleted successfully.`);
            loadUploadedTrips();
        } else {
            alert('Error deleting trips: ' + data.message);
        }
    })
    .catch(error => {
        console.error('Error deleting trips:', error);
        alert('An error occurred while deleting trips.');
    });
}

// Ensure that individual trip deletion also removes the corresponding matched trip
function deleteUploadedTrip(tripId) {
    if (!confirm('Are you sure you want to delete this trip?')) {
        return;
    }

    fetch('/api/uploaded_trips/bulk_delete', {
        method: 'DELETE',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ trip_ids: [tripId] })
    })
    .then(response => response.json())
    .then(data => {
        if (data.status === 'success') {
            alert(`Trip deleted successfully. Matched trips deleted: ${data.deleted_matched_trips}`);
            loadUploadedTrips();
        } else {
            alert('Error deleting trip: ' + data.message);
        }
    })
    .catch(error => {
        console.error('Error deleting trip:', error);
        alert('An error occurred while deleting the trip.');
    });
}

document.addEventListener('DOMContentLoaded', () => {
    loadUploadedTrips();
});

async function handleFileUpload(files) {
    const loadingManager = getLoadingManager();
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
