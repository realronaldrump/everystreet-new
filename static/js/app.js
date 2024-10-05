let map = null;
let layerGroup = null;
let liveRoutePolyline = null;
let liveMarker = null;
let osmLayer = null;

let mapLayers = {
    trips: { layer: null, visible: true, color: '#BB86FC', order: 1 },
    osmBoundary: { layer: null, visible: false, color: '#03DAC6', order: 2 },
    osmStreets: { layer: null, visible: false, color: '#FF0266', order: 3 }
};

/* global flatpickr */

/* global io */
const socket = io.connect();

function initializeMap() {
    // Ensure the map container exists
    const mapElement = document.getElementById('map');
    if (!mapElement) {
        console.error('Map container not found');
        return;
    }

    /* global L */
    try {
        map = L.map('map', {
            center: [37.0902, -95.7129],
            zoom: 4,
            zoomControl: true,
            attributionControl: false
        });

        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 19,
            attribution: ''
        }).addTo(map);

        layerGroup = L.layerGroup().addTo(map);

        // Add zoom control to the top-right corner
        L.control.zoom({
            position: 'topright'
        }).addTo(map);

        // Add a scale control
        L.control.scale({
            imperial: true,
            metric: true,
            position: 'bottomright'
        }).addTo(map);

        // Disable wrap around the globe
        map.setMaxBounds([
            [-90, -180],
            [90, 180]
        ]);

        console.log('Map initialized successfully');
    } catch (error) {
        console.error('Error initializing Leaflet map:', error);
    }
}

function initializeDatePickers() {
    flatpickr("#start-date", {
        dateFormat: "Y-m-d"
    });
    flatpickr("#end-date", {
        dateFormat: "Y-m-d"
    });
}

function exportGeojson() {
    fetch('/export/geojson')
        .then(response => {
            if (!response.ok) {
                throw new Error('Network response was not ok');
            }
            return response.json();
        })
        .then(geojson => {
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(geojson));
            const downloadAnchorNode = document.createElement('a');
            downloadAnchorNode.setAttribute("href", dataStr);
            downloadAnchorNode.setAttribute("download", "trips.geojson");
            document.body.appendChild(downloadAnchorNode);
            downloadAnchorNode.click();
            downloadAnchorNode.remove();
        })
        .catch(error => {
            console.error('Error exporting GeoJSON:', error);
        });
}

function showLoadingOverlay() {
    const loadingOverlay = document.querySelector('.loading-overlay');
    if (loadingOverlay) {
        loadingOverlay.style.display = 'flex';
    } else {
        console.log('Loading overlay not found, skipping display');
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

function updateLoadingProgress(progress) {
    const loadingBar = document.getElementById('loading-bar');
    const loadingText = document.getElementById('loading-text');
    loadingBar.style.width = `${progress}%`;
    loadingText.textContent = `Loading trips: ${progress}%`;
}

function fetchTrips() {
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;
    const imei = document.getElementById('imei').value;

    let url = '/api/trips';
    const params = new URLSearchParams();

    if (startDate) params.append('start_date', startDate);
    if (endDate) params.append('end_date', endDate);
    if (imei) params.append('imei', imei);

    if (params.toString()) {
        url += `?${params.toString()}`;
    }

    showLoadingOverlay();

    fetch(url)
        .then(response => response.json())
        .then(geojson => {
            console.log('Received GeoJSON:', geojson);
            const trips = geojson.features.map(feature => ({
                ...feature.properties,
                gps: feature.geometry,
                destination: feature.properties.destination || 'N/A'
            }));
            if (tripsTable) {
                tripsTable.clear().rows.add(trips).draw();
            }
            console.log('Trips data:', trips);
            if (geojson.features && geojson.features.length > 0) {
                mapLayers.trips.layer = geojson;
                updateMap();
            } else {
                console.warn('No features found in GeoJSON data');
            }
        })
        .catch(error => {
            console.error('Error fetching trips:', error);
        })
        .finally(() => {
            hideLoadingOverlay();
        });
}

function geocodeCoordinates(lat, lon) {
    return fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`)
        .then(response => response.json())
        .then(data => data.display_name)
        .catch(error => {
            console.error('Geocoding error:', error);
            return 'Unknown location';
        });
}

function fetchMetrics() {
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;

    fetch(`/api/metrics?start_date=${startDate}&end_date=${endDate}`)
        .then(response => response.json())
        .then(metrics => {
            document.getElementById('total-trips').textContent = metrics.total_trips;
            document.getElementById('total-distance').textContent = metrics.total_distance;
            document.getElementById('avg-distance').textContent = metrics.avg_distance;
            document.getElementById('avg-start-time').textContent = metrics.avg_start_time;
            document.getElementById('avg-driving-time').textContent = metrics.avg_driving_time;
        })
        .catch(error => {
            console.error('Error fetching metrics:', error);
        });
}

function updateMap() {
    console.log('Updating map');
    if (!map || !layerGroup) {
        console.log('Map or layerGroup not initialized, skipping map update');
        return;
    }
    layerGroup.clearLayers();

    const orderedLayers = Object.entries(mapLayers)
        .filter(([_, layerInfo]) => layerInfo.visible)
        .sort((a, b) => a[1].order - b[1].order);

    orderedLayers.forEach(([layerName, layerInfo]) => {
        if (layerName === 'trips' && layerInfo.layer) {
            L.geoJSON(layerInfo.layer, {
                style: {
                    color: layerInfo.color,
                    weight: 2,
                    opacity: 0.5
                },
                onEachFeature: (feature, layer) => {
                    const startTime = applyTimeOffset(feature.properties.startTime);
                    const endTime = applyTimeOffset(feature.properties.endTime);

                    layer.bindPopup(`
                        <strong>Trip ID:</strong> ${feature.properties.transactionId}<br>
                        <strong>Start Time:</strong> ${startTime.toLocaleString()}<br>
                        <strong>End Time:</strong> ${endTime.toLocaleString()}<br>
                        <strong>Distance:</strong> ${feature.properties.distance.toFixed(2)} miles
                    `);
                }
            }).addTo(layerGroup);
        } else if (layerName === 'osmBoundary' && layerInfo.layer) {
            layerInfo.layer.setStyle({ color: layerInfo.color }).addTo(layerGroup);
        } else if (layerName === 'osmStreets' && layerInfo.layer) {
            layerInfo.layer.setStyle({ color: layerInfo.color }).addTo(layerGroup);
        }
    });

    if (mapLayers.trips.layer) {
        const bounds = L.geoJSON(mapLayers.trips.layer).getBounds();
        if (bounds.isValid()) {
            map.fitBounds(bounds);
        } else {
            console.warn('No valid bounds to fit');
        }
    }
}

function handleLiveRouteUpdate(data) {
    if (document.getElementById('show-live-routes').checked) {
        try {
            const coordinates = data.data.map(point => [point.gps.lat, point.gps.lon]);
            const lastPoint = coordinates[coordinates.length - 1];
            const isVehicleOff = data.isVehicleOff; // Assuming this data is available

            if (liveRoutePolyline) {
                layerGroup.removeLayer(liveRoutePolyline);
            }
            if (liveMarker) {
                layerGroup.removeLayer(liveMarker);
            }

            // Add or update the live route polyline
            liveRoutePolyline = L.polyline(coordinates, {
                color: isVehicleOff ? 'red' : 'green',
                weight: 3,
                opacity: 0.7,
            }).addTo(layerGroup);

            // Add or update the live location marker
            liveMarker = L.circleMarker(lastPoint, {
                radius: 8,
                color: '#fff',
                fillColor: isVehicleOff ? '#f03' : '#0f0',
                fillOpacity: 1,
                className: 'live-marker',
            }).addTo(layerGroup);

            liveMarker.bindPopup(`
                <strong>Vehicle Status:</strong> ${isVehicleOff ? 'Parked' : 'Driving'}<br>
                <strong>Latitude:</strong> ${lastPoint[0].toFixed(5)}<br>
                <strong>Longitude:</strong> ${lastPoint[1].toFixed(5)}
            `);

            // Center the map on the new point
            map.panTo(lastPoint);

        } catch (error) {
            console.error('Error handling live route update:', error);
        }
    }
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('active');
}

function initializeLayerControls() {
    const layerToggles = document.getElementById('layer-toggles');
    const layerColors = document.getElementById('layer-colors');
    const layerOrder = document.getElementById('layer-order');

    for (const [layerName, layerInfo] of Object.entries(mapLayers)) {
        // Create toggle
        const toggle = document.createElement('div');
        toggle.innerHTML = `
            <input type="checkbox" id="${layerName}-toggle" ${layerInfo.visible ? 'checked' : ''}>
            <label for="${layerName}-toggle">${layerName}</label>
        `;
        layerToggles.appendChild(toggle);

        // Create color picker
        const colorPicker = document.createElement('div');
        colorPicker.innerHTML = `
            <label for="${layerName}-color">${layerName} color:</label>
            <input type="color" id="${layerName}-color" value="${layerInfo.color}">
        `;
        layerColors.appendChild(colorPicker);

        // Add event listeners
        document.getElementById(`${layerName}-toggle`).addEventListener('change', (e) => toggleLayer(layerName, e.target.checked));
        document.getElementById(`${layerName}-color`).addEventListener('change', (e) => changeLayerColor(layerName, e.target.value));
    }

    updateLayerOrderUI();
}

function toggleLayer(layerName, visible) {
    mapLayers[layerName].visible = visible;
    updateMap();
    updateLayerOrderUI();
}

function changeLayerColor(layerName, color) {
    mapLayers[layerName].color = color;
    updateMap();
}

function updateLayerOrderUI() {
    const layerOrder = document.getElementById('layer-order');
    layerOrder.innerHTML = '<h3>Layer Order (Drag to reorder)</h3>';

    const orderedLayers = Object.entries(mapLayers)
        .filter(([_, layerInfo]) => layerInfo.visible)
        .sort((a, b) => a[1].order - b[1].order);

    const ul = document.createElement('ul');
    ul.id = 'layer-order-list';
    orderedLayers.forEach(([layerName, _]) => {
        const li = document.createElement('li');
        li.textContent = layerName;
        li.draggable = true;
        li.dataset.layer = layerName;
        ul.appendChild(li);
    });

    layerOrder.appendChild(ul);
    initializeDragAndDrop();
}

function initializeDragAndDrop() {
    const layerList = document.getElementById('layer-order-list');
    let draggedItem = null;

    layerList.addEventListener('dragstart', (e) => {
        draggedItem = e.target;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', ''); // Required for Firefox
    });

    layerList.addEventListener('dragover', (e) => {
        e.preventDefault();
        const targetItem = e.target.closest('li');
        if (targetItem && targetItem !== draggedItem) {
            const rect = targetItem.getBoundingClientRect();
            const next = (e.clientY - rect.top) / (rect.bottom - rect.top) > 0.5;
            layerList.insertBefore(draggedItem, next ? targetItem.nextSibling : targetItem);
        }
    });

    layerList.addEventListener('dragend', () => {
        updateLayerOrder();
    });
}

function updateLayerOrder() {
    const layerList = document.getElementById('layer-order-list');
    const layers = layerList.querySelectorAll('li');
    layers.forEach((layer, index) => {
        mapLayers[layer.dataset.layer].order = index + 1;
    });
    updateMap();
}

function validateLocation() {
    const location = document.getElementById('location-input').value;
    const locationType = document.getElementById('location-type').value;

    fetch('/api/validate_location', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ location, locationType }),
    })
    .then(response => response.json())
    .then(data => {
        if (data) {
            alert('Location validated successfully!');
            window.validatedLocation = data;
        } else {
            alert('Location not found. Please check your input.');
        }
    })
    .catch(error => {
        console.error('Error validating location:', error);
    });
}

function generateOSMData(streetsOnly) {
    if (!window.validatedLocation) {
        alert('Please validate a location first.');
        return;
    }

    fetch('/api/generate_geojson', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ location: window.validatedLocation, streetsOnly }),
    })
    .then(response => response.json())
    .then(geojson => {
        if (streetsOnly) {
            mapLayers.osmStreets.layer = L.geoJSON(geojson, {
                style: {
                    color: mapLayers.osmStreets.color,
                    weight: 2,
                    opacity: 0.7
                }
            });
        } else {
            mapLayers.osmBoundary.layer = L.geoJSON(geojson, {
                style: {
                    color: mapLayers.osmBoundary.color,
                    weight: 2,
                    opacity: 0.7
                }
            });
        }
        updateMap();
        updateLayerOrderUI();
    })
    .catch(error => {
        console.error('Error generating OSM data:', error);
    });
}

function initializeEventListeners() {
    document.getElementById('apply-filters').addEventListener('click', () => {
        // Update localStorage with the selected dates
        const startDate = document.getElementById('start-date').value;
        const endDate = document.getElementById('end-date').value;
        localStorage.setItem('startDate', startDate);
        localStorage.setItem('endDate', endDate);
        fetchTrips();
    });
    document.getElementById('sidebar-toggle').addEventListener('click', toggleSidebar);
    document.getElementById('fetch-trips-range').addEventListener('click', () => {
        const startDate = document.getElementById('start-date').value;
        const endDate = document.getElementById('end-date').value;
        fetchTripsInRange(startDate, endDate);
    });
    document.getElementById('export-geojson').addEventListener('click', exportGeojson);
    document.getElementById('validate-location').addEventListener('click', validateLocation);
    document.getElementById('generate-boundary').addEventListener('click', () => generateOSMData(false));
    document.getElementById('generate-streets').addEventListener('click', () => generateOSMData(true));
    initializeLayerControls();
}

socket.on('live_route_update', handleLiveRouteUpdate);
socket.on('loading_progress', (data) => {
    updateLoadingProgress(data.progress);
});

function fetchTripsInRange(startDate, endDate) {
    fetch('/api/fetch_trips_range', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            start_date: startDate,
            end_date: endDate
        })
    })
    .then(response => response.json())
    .then(data => {
        if (data.status === 'success') {
            console.info(data.message);
            fetchTrips(); // Refresh trips table after successful fetch
        } else {
            console.error(`Error: ${data.message}`);
        }
    })
    .catch(error => {
        console.error('Error fetching trips in range:', error);
        console.error('An error occurred while fetching trips in range.');
    });
}

let timeOffset = 0;

function adjustTime(hours) {
    timeOffset += hours;
    localStorage.setItem('timeOffset', timeOffset);
    fetchTrips();
}

function applyTimeOffset(dateString) {
    const date = new Date(dateString);
    date.setHours(date.getHours() + timeOffset);
    return date;
}

function setTimeOffset(hours) {
    fetch('/api/set_time_offset', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ offset: hours }),
    })
    .then(response => response.json())
    .then(data => {
        console.log(data.message);
        timeOffset += hours;
        updateClock();
        fetchTrips();
    })
    .catch((error) => {
        console.error('Error:', error);
    });
}

document.getElementById('time-backward').addEventListener('click', () => setTimeOffset(-1));
document.getElementById('time-forward').addEventListener('click', () => setTimeOffset(1));

// Load the time offset from localStorage when the page loads
document.addEventListener('DOMContentLoaded', () => {
    timeOffset = parseInt(localStorage.getItem('timeOffset') || '0');
});

function updateClock() {
    const dateElement = document.getElementById('current-date');
    const timeElement = document.getElementById('current-time');
    if (dateElement && timeElement) {
        const now = new Date();
        now.setHours(now.getHours() + timeOffset);
        
        const options = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' };
        dateElement.textContent = now.toLocaleDateString(undefined, options);
        timeElement.textContent = now.toLocaleTimeString();
    }
}

function startClock() {
    updateClock();
    setInterval(updateClock, 1000);
}

document.addEventListener('DOMContentLoaded', () => {
    startClock();
    initializeDatePickers();
    initializeEventListeners();
    if (document.getElementById('map')) {
        initializeMap();
        fetchTrips();
    }
});