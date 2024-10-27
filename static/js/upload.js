document.addEventListener('DOMContentLoaded', function() {
    let previewMap = null;
    let previewLayerGroup = null;
    const files = new Map();

    // Initialize map
    function initializePreviewMap() {
        previewMap = L.map('previewMap', {
            center: [37.0902, -95.7129],
            zoom: 4
        });

        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 19
        }).addTo(previewMap);

        previewLayerGroup = L.layerGroup().addTo(previewMap);
    }

    // Initialize drag and drop
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');

    dropZone.addEventListener('click', () => fileInput.click());
    
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        handleFiles(e.dataTransfer.files);
    });

    fileInput.addEventListener('change', (e) => {
        handleFiles(e.target.files);
    });

    async function handleFiles(fileList) {
        for (const file of fileList) {
            if (file.name.toLowerCase().endsWith('.gpx')) {
                try {
                    const result = await validateGPXFile(file);
                    files.set(file.name, {
                        file,
                        ...result
                    });
                    updateFileList();
                    updatePreviewMap();
                    updateUploadSummary();
                } catch (error) {
                    console.error(`Error processing ${file.name}:`, error);
                }
            }
        }
    }

    async function validateGPXFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const parser = new DOMParser();
                    const gpx = parser.parseFromString(e.target.result, 'text/xml');
                    
                    const points = gpx.getElementsByTagName('trkpt');
                    const times = Array.from(gpx.getElementsByTagName('time'))
                        .map(time => new Date(time.textContent));
                    
                    resolve({
                        points: points.length,
                        startDate: times[0],
                        endDate: times[times.length - 1],
                        coordinates: Array.from(points).map(point => ({
                            lat: parseFloat(point.getAttribute('lat')),
                            lon: parseFloat(point.getAttribute('lon'))
                        }))
                    });
                } catch (error) {
                    reject(error);
                }
            };
            reader.readAsText(file);
        });
    }

    function addRouteToMap(data, filename) {
        const polyline = L.polyline(data.coordinates.map(coord => [coord.lat, coord.lon]), {
            color: '#BB86FC',
            weight: 2,
            opacity: 0.7
        }).addTo(previewLayerGroup);

        // Add click handler
        polyline.on('click', (e) => {
            if (confirm(`Delete route from "${filename}"?`)) {
                files.delete(filename);
                updateFileList();
                updatePreviewMap();
                updateUploadSummary();
            }
        });

        // Add hover effect
        polyline.on('mouseover', (e) => {
            polyline.setStyle({
                weight: 4,
                opacity: 1
            });
        });

        polyline.on('mouseout', (e) => {
            polyline.setStyle({
                weight: 2,
                opacity: 0.7
            });
        });

        // Add popup
        polyline.bindPopup(`
            <strong>${filename}</strong><br>
            Date: ${data.startDate.toLocaleDateString()}<br>
            Points: ${data.points}<br>
            <button class="btn btn-sm btn-danger mt-2" onclick="removeFile('${filename}')">
                Delete Route
            </button>
        `);
    }

    function updateFileList() {
        const tbody = document.getElementById('fileListBody');
        tbody.innerHTML = '';

        files.forEach((data, filename) => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${filename}</td>
                <td>${data.startDate.toLocaleDateString()} - ${data.endDate.toLocaleDateString()}</td>
                <td>${data.points}</td>
                <td><span class="badge bg-success">Valid</span></td>
                <td>
                    <button class="btn btn-sm btn-danger" onclick="removeFile('${filename}')">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            `;
            tbody.appendChild(row);
        });

        document.getElementById('uploadButton').disabled = files.size === 0;
    }

    function updatePreviewMap() {
        if (!previewMap) {
            initializePreviewMap();
        }

        previewLayerGroup.clearLayers();

        files.forEach((data, filename) => {
            addRouteToMap(data, filename);
        });

        if (files.size > 0) {
            previewMap.fitBounds(previewLayerGroup.getBounds());
        }
    }

    function updateUploadSummary() {
        document.getElementById('totalFiles').textContent = files.size;
        
        if (files.size > 0) {
            const allDates = Array.from(files.values()).flatMap(data => [data.startDate, data.endDate]);
            const startDate = new Date(Math.min(...allDates));
            const endDate = new Date(Math.max(...allDates));
            document.getElementById('dateRange').textContent = 
                `${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`;
            
            const totalPoints = Array.from(files.values())
                .reduce((sum, data) => sum + data.points, 0);
            document.getElementById('totalPoints').textContent = totalPoints;
        } else {
            document.getElementById('dateRange').textContent = '-';
            document.getElementById('totalPoints').textContent = '0';
        }
    }

    // Initialize map
    initializePreviewMap();

    // Handle file upload
    document.getElementById('uploadButton').addEventListener('click', async () => {
        const formData = new FormData();
        files.forEach((data, filename) => {
            formData.append('files', data.file);
        });

        const mapMatchOnUpload = document.getElementById('mapMatchOnUpload').checked;
        formData.append('map_match', mapMatchOnUpload.toString());

        showLoadingOverlay();
        try {
            const response = await fetch('/api/upload_gpx', {
                method: 'POST',
                body: formData
            });

            const result = await response.json();
            if (result.success) {
                if (mapMatchOnUpload) {
                    await fetch('/api/map_match_historical_trips', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            trip_ids: result.trip_ids
                        })
                    });
                }
                alert('Files uploaded successfully!');
                window.location.href = '/';
            } else {
                alert('Error uploading files: ' + result.message);
            }
        } catch (error) {
            console.error('Upload error:', error);
            alert('Error uploading files');
        } finally {
            hideLoadingOverlay();
        }
    });

    // Expose removeFile to global scope
    window.removeFile = function(filename) {
        files.delete(filename);
        updateFileList();
        updatePreviewMap();
        updateUploadSummary();
    };

    // Import showLoadingOverlay and hideLoadingOverlay from app.js
    function showLoadingOverlay() {
        const loadingOverlay = document.querySelector('.loading-overlay');
        if (loadingOverlay) {
            loadingOverlay.style.display = 'flex';
        } else {
            console.warn('Loading overlay element not found');
        }
    }

    function hideLoadingOverlay() {
        const loadingOverlay = document.querySelector('.loading-overlay');
        if (loadingOverlay) {
            loadingOverlay.style.display = 'none';
        } else {
            console.warn('Loading overlay element not found');
        }
    }
});