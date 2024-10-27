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
        coordinates.push([lat, lon]);
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
        let latlngs = entry.coordinates.map(coord => [coord[0], coord[1]]);
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

    trips.forEach(trip => {
        let row = document.createElement('tr');
        row.innerHTML = `
            <td>${trip.transactionId}</td>
            <td>${trip.filename}</td>
            <td>${trip.startTime ? new Date(trip.startTime).toLocaleString() : '-'}</td>
            <td>${trip.endTime ? new Date(trip.endTime).toLocaleString() : '-'}</td>
            <td>${trip.source || 'upload'}</td>
            <td><button class="btn btn-sm btn-danger" onclick="deleteUploadedTrip('${trip._id}')">Delete</button></td>
        `;
        tbody.appendChild(row);
    });
}

function deleteUploadedTrip(tripId) {
    if (!confirm('Are you sure you want to delete this trip?')) {
        return;
    }

    fetch(`/api/uploaded_trips/${tripId}`, {
        method: 'DELETE'
    })
    .then(response => response.json())
    .then(data => {
        if (data.status === 'success') {
            alert(data.message);
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
