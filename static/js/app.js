let map = null;
let layerGroup = null;
let liveRoutePolyline = null;
let liveMarker = null;
let osmLayer = null;

let mapLayers = {
    trips: { layer: null, visible: true, color: '#BB86FC', order: 1, opacity: 0.4 },
    historicalTrips: { layer: null, visible: true, color: '#03DAC6', order: 2, opacity: 0.4 },
    matchedTrips: { layer: null, visible: true, color: '#CF6679', order: 3, opacity: 0.4 },
    osmBoundary: { layer: null, visible: false, color: '#03DAC6', order: 4, opacity: 0.7 },
    osmStreets: { layer: null, visible: false, color: '#FF0266', order: 5, opacity: 0.7 }
};

/* global flatpickr */

/* global io */
const socket = io(); 

function initializeMap() {
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

        L.control.zoom({
            position: 'topright'
        }).addTo(map);

        L.control.scale({
            imperial: true,
            metric: true,
            position: 'bottomright'
        }).addTo(map);

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
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const storedStartDate = localStorage.getItem('startDate');
    const storedEndDate = localStorage.getItem('endDate');

    const startDate = storedStartDate ? new Date(storedStartDate) : today;
    const endDate = storedEndDate ? new Date(storedEndDate) : today;

    if (document.getElementById('start-date')) {
        flatpickr("#start-date", {
            dateFormat: "Y-m-d",
            maxDate: "today",
            defaultDate: startDate,
            onChange(selectedDates) {
                const date = selectedDates[0];
                localStorage.setItem('startDate', date.toISOString().split('T')[0]);
            }
        });
    }

    if (document.getElementById('end-date')) {
        flatpickr("#end-date", {
            dateFormat: "Y-m-d",
            maxDate: "today",
            defaultDate: endDate,
            onChange(selectedDates) {
                const date = selectedDates[0];
                localStorage.setItem('endDate', date.toISOString().split('T')[0]);
            }
        });
    }
}

function exportGeojson() {
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;
    const imei = document.getElementById('imei').value;

    const params = new URLSearchParams();
    if (startDate) params.append('start_date', startDate);
    if (endDate) params.append('end_date', endDate);
    if (imei) params.append('imei', imei);

    let url = '/export/geojson';
    if (params.toString()) {
        url += `?${params.toString()}`;
    }

    fetch(url)
        .then(response => {
            if (!response.ok) {
                if (response.status === 404) {
                    throw new Error('No trips found for the specified filters.');
                } else {
                    throw new Error('Network response was not ok');
                }
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
            alert(error.message || 'An error occurred while exporting GeoJSON.');
        });
}

function exportGPX() {
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;
    const imei = document.getElementById('imei').value;

    const params = new URLSearchParams();
    if (startDate) params.append('start_date', startDate);
    if (endDate) params.append('end_date', endDate);
    if (imei) params.append('imei', imei);

    let url = '/export/gpx';
    if (params.toString()) {
        url += `?${params.toString()}`;
    }

    fetch(url)
        .then(response => {
            if (!response.ok) {
                if (response.status === 404) {
                    throw new Error('No trips found for the specified filters.');
                } else {
                    throw new Error('Network response was not ok');
                }
            }
            return response.text();
        })
        .then(gpxData => {
            const blob = new Blob([gpxData], { type: 'application/gpx+xml' });
            const blobUrl = URL.createObjectURL(blob);
            const downloadAnchorNode = document.createElement('a');
            downloadAnchorNode.setAttribute("href", blobUrl);
            downloadAnchorNode.setAttribute("download", "trips.gpx");
            document.body.appendChild(downloadAnchorNode);
            downloadAnchorNode.click();
            downloadAnchorNode.remove();
            URL.revokeObjectURL(blobUrl);
        })
        .catch(error => {
            console.error('Error exporting GPX:', error);
            alert(error.message || 'An error occurred while exporting GPX.');
        });
}

document.getElementById('export-gpx').addEventListener('click', exportGPX);

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

            const trips = geojson.features
                .filter(feature => feature.properties.imei !== 'HISTORICAL')
                .map(feature => ({
                    ...feature.properties,
                    gps: feature.geometry,
                    destination: feature.properties.destination || 'N/A'
                }));

            const historicalTrips = geojson.features
                .filter(feature => feature.properties.imei === 'HISTORICAL')
                .map(feature => ({
                    ...feature.properties,
                    gps: feature.geometry,
                    destination: feature.properties.destination || 'N/A'
                }));

            if (tripsTable) {
                tripsTable.clear().rows.add(trips).draw();
            }
            console.log('Trips data:', trips);

            mapLayers.trips.layer = {
                type: 'FeatureCollection',
                features: trips.map(trip => ({
                    type: 'Feature',
                    geometry: trip.gps,
                    properties: trip
                }))
            };

            mapLayers.historicalTrips.layer = {
                type: 'FeatureCollection',
                features: historicalTrips.map(trip => ({
                    type: 'Feature',
                    geometry: trip.gps,
                    properties: trip
                }))
            };

            fetchMatchedTrips(startDate, endDate, imei)
                .then(() => {
                    updateMap();
                })
                .catch(error => {
                    console.error('Error fetching matched trips:', error);
                    updateMap();
                });
        })
        .catch(error => {
            console.error('Error fetching trips:', error);
        })
        .finally(() => {
            hideLoadingOverlay();
        });
}


function fetchMetrics() {
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;
    const imei = document.getElementById('imei').value;

    fetch(`/api/metrics?start_date=${startDate}&end_date=${endDate}&imei=${imei}`)
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
        if ((layerName === 'trips' || layerName === 'historicalTrips' || layerName === 'matchedTrips') && layerInfo.layer) {
            L.geoJSON(layerInfo.layer, {
                style: {
                    color: layerInfo.color,
                    weight: 2,
                    opacity: layerInfo.opacity
                },
                onEachFeature: (feature, layer) => {
                    const startTime = new Date(feature.properties.startTime);
                    const endTime = new Date(feature.properties.endTime);
                
                    layer.bindPopup(`
                        <strong>Trip ID:</strong> ${feature.properties.transactionId}<br>
                        <strong>Start Time:</strong> ${startTime.toLocaleString()}<br>
                        <strong>End Time:</strong> ${endTime.toLocaleString()}<br>
                        <strong>Distance:</strong> ${feature.properties.distance.toFixed(2)} miles
                    `);
                }
            }).addTo(layerGroup);
        } else if (layerName === 'osmBoundary' && layerInfo.layer) {
            layerInfo.layer.setStyle({ 
                color: layerInfo.color,
                opacity: layerInfo.opacity
            }).addTo(layerGroup);
        } else if (layerName === 'osmStreets' && layerInfo.layer) {
            layerInfo.layer.setStyle({ 
                color: layerInfo.color,
                opacity: layerInfo.opacity
            }).addTo(layerGroup);
        }
    });

    let bounds = L.latLngBounds();
    for (const layerName in mapLayers) {
        if (mapLayers[layerName].visible && mapLayers[layerName].layer) {
            bounds.extend(L.geoJSON(mapLayers[layerName].layer).getBounds());
        }
    }

    if (bounds.isValid()) {
        map.fitBounds(bounds);
    } else {
        console.warn('No valid bounds to fit');
    }
}

function handleLiveRouteUpdate(data) {
    if (document.getElementById('show-live-routes').checked) {
        try {
            const coordinates = data.data.map(point => [point.gps.lat, point.gps.lon]);
            const lastPoint = coordinates[coordinates.length - 1];
            const isVehicleOff = data.isVehicleOff;

            if (liveRoutePolyline) {
                layerGroup.removeLayer(liveRoutePolyline);
            }
            if (liveMarker) {
                layerGroup.removeLayer(liveMarker);
            }

            liveRoutePolyline = L.polyline(coordinates, {
                color: isVehicleOff ? 'red' : 'green',
                weight: 3,
                opacity: 0.7,
            }).addTo(layerGroup);

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

            map.panTo(lastPoint);

        } catch (error) {
            console.error('Error handling live route update:', error);
        }
    }
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('active');

    const icon = document.getElementById('sidebar-toggle').querySelector('i');
    if (sidebar.classList.contains('active')) {
        icon.classList.remove('fa-bars');
        icon.classList.add('fa-times');
    } else {
        icon.classList.remove('fa-times');
        icon.classList.add('fa-bars');
    }
}

function initializeLayerControls() {
    const layerToggles = document.getElementById('layer-toggles');
    if (!layerToggles) {
        console.warn("Element with ID 'layer-toggles' not found.");
        return;
    }
    layerToggles.innerHTML = ''; 

    for (const [layerName, layerInfo] of Object.entries(mapLayers)) {
        const layerControl = document.createElement('div');
        layerControl.classList.add('layer-control');
        layerControl.dataset.layerName = layerName;

        layerControl.innerHTML = `
            <input type="checkbox" id="${layerName}-toggle" ${layerInfo.visible ? 'checked' : ''}>
            <label for="${layerName}-toggle">${layerName}</label>
            <input type="color" id="${layerName}-color" value="${layerInfo.color}">
            <label for="${layerName}-opacity">Opacity:</label>
            <input type="range" id="${layerName}-opacity" min="0" max="1" step="0.1" value="${layerInfo.opacity}">
        `;
        layerToggles.appendChild(layerControl);

        document.getElementById(`${layerName}-toggle`).addEventListener('change', (e) => toggleLayer(layerName, e.target.checked));
        document.getElementById(`${layerName}-color`).addEventListener('change', (e) => changeLayerColor(layerName, e.target.value));
        document.getElementById(`${layerName}-opacity`).addEventListener('input', (e) => changeLayerOpacity(layerName, e.target.value));
    }
}

function toggleLayer(layerName, visible) {
    if (!mapLayers[layerName]) {
        console.warn(`Layer ${layerName} not found`);
        return;
    }
    mapLayers[layerName].visible = visible;
    updateMap();
    updateLayerOrderUI();
}

function changeLayerColor(layerName, color) {
    mapLayers[layerName].color = color;
    updateMap();
}

function changeLayerOpacity(layerName, opacity) {
    mapLayers[layerName].opacity = parseFloat(opacity);
    updateMap();
}

function updateLayerOrderUI() {
    const layerOrder = document.getElementById('layer-order');
    if (!layerOrder) {
        console.warn('Layer order element not found');
        return;
    }
    layerOrder.innerHTML = '<h3>Layer Order (Drag to reorder)</h3>';

    const orderedLayers = Object.entries(mapLayers)
        .filter(([_, layerInfo]) => layerInfo.visible)
        .sort((a, b) => b[1].order - a[1].order);

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
        e.dataTransfer.setData('text/plain', '');
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
    const layers = Array.from(layerList.querySelectorAll('li'));
    const totalLayers = layers.length;
    layers.forEach((layer, index) => {
        mapLayers[layer.dataset.layer].order = totalLayers - index;
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
        if (!geojson || !geojson.type || geojson.type !== 'FeatureCollection') {
            throw new Error('Invalid GeoJSON data');
        }

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
    const applyFiltersButton = document.getElementById('apply-filters');
    if (applyFiltersButton) {
        applyFiltersButton.addEventListener('click', () => {
            const startDate = document.getElementById('start-date').value;
            const endDate = document.getElementById('end-date').value;
            localStorage.setItem('startDate', startDate);
            localStorage.setItem('endDate', endDate);
            fetchTrips();
            fetchMetrics();
        });
    }

    const sidebarToggle = document.getElementById('sidebar-toggle');
    if (sidebarToggle) {
        sidebarToggle.addEventListener('click', toggleSidebar);
    }

    const fetchTripsRangeButton = document.getElementById('fetch-trips-range');
    if (fetchTripsRangeButton) {
        fetchTripsRangeButton.addEventListener('click', () => {
            const startDate = document.getElementById('start-date').value;
            const endDate = document.getElementById('end-date').value;
            fetchTripsInRange(startDate, endDate);
        });
    }

    const exportGeojsonButton = document.getElementById('export-geojson');
    if (exportGeojsonButton) {
        exportGeojsonButton.addEventListener('click', exportGeojson);
    }

    const exportGPXButton = document.getElementById('export-gpx');
    if (exportGPXButton) {
        exportGPXButton.addEventListener('click', exportGPX);
    }

    const validateLocationButton = document.getElementById('validate-location');
    if (validateLocationButton) {
        validateLocationButton.addEventListener('click', validateLocation);
    }

    const generateBoundaryButton = document.getElementById('generate-boundary');
    if (generateBoundaryButton) {
        generateBoundaryButton.addEventListener('click', () => generateOSMData(false));
    }

    const generateStreetsButton = document.getElementById('generate-streets');
    if (generateStreetsButton) {
        generateStreetsButton.addEventListener('click', () => generateOSMData(true));
    }

    const mapMatchTripsButton = document.getElementById('map-match-trips');
    if (mapMatchTripsButton) {
        mapMatchTripsButton.addEventListener('click', mapMatchTrips);
    }

    const mapMatchHistoricalTripsButton = document.getElementById('map-match-historical-trips');
    if (mapMatchHistoricalTripsButton) {
        mapMatchHistoricalTripsButton.addEventListener('click', mapMatchHistoricalTrips);
    }

    const loadHistoricalDataButton = document.getElementById('load-historical-data');
    if (loadHistoricalDataButton) {
        loadHistoricalDataButton.addEventListener('click', loadHistoricalData);
    }

    initializeLayerControls();

    const mapControlsToggle = document.getElementById('controls-toggle'); 
    if (mapControlsToggle) {
        mapControlsToggle.addEventListener('click', function() {
            console.log('Toggle button clicked');
            const mapControls = document.getElementById('map-controls');
            const controlsContent = document.getElementById('controls-content'); 
            mapControls.classList.toggle('minimized');
            const icon = this.querySelector('i');
            if (mapControls.classList.contains('minimized')) {
                icon.classList.remove('fa-chevron-up'); 
                icon.classList.add('fa-chevron-down'); 
                controlsContent.style.display = 'none'; 
            } else {
                icon.classList.remove('fa-chevron-down');
                icon.classList.add('fa-chevron-up');
                controlsContent.style.display = 'block'; 
            }
        });
    }
}

async function fetchMatchedTrips(startDate, endDate, imei) {
    let url = '/api/matched_trips';
    const params = new URLSearchParams();

    if (startDate) params.append('start_date', startDate);
    if (endDate) params.append('end_date', endDate);
    if (imei) params.append('imei', imei);

    if (params.toString()) {
        url += `?${params.toString()}`;
    }

    try {
        const response = await fetch(url);
        const geojson = await response.json();

        mapLayers.matchedTrips.layer = geojson;
    } catch (error) {
        console.error('Error fetching matched trips:', error);
    }
}

function mapMatchTrips() {
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;

    showLoadingOverlay();

    fetch('/api/map_match_trips', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            start_date: startDate,
            end_date: endDate
        })
    })
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
    })
    .then(data => {
        if (data.status === 'success') {
            alert(data.message);
            fetchTrips(); 
        } else {
            console.error(`Error: ${data.message}`);
        }
    })
    .catch(error => {
        console.error('Error initiating map matching for trips:', error);
    })
    .finally(() => {
        hideLoadingOverlay(); 
    });
}

function mapMatchHistoricalTrips() {
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;

    showLoadingOverlay(); 

    fetch('/api/map_match_historical_trips', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            start_date: startDate,
            end_date: endDate
        })
    })
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
    })
    .then(data => {
        if (data.status === 'success') {
            alert(data.message);
            fetchTrips(); 
        } else {
            console.error(`Error: ${data.message}`);
        }
    })
    .catch(error => {
        console.error('Error initiating map matching for historical trips:', error);
    })
    .finally(() => {
        hideLoadingOverlay();
    });
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
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
    })
    .then(data => {
        if (data.status === 'success') {
            console.log(data.message);
            fetchTrips(); 
        } else {
            console.error(`Error: ${data.message}`);
        }
    })
    .catch(error => {
        console.error('Error fetching trips in range:', error);
    });
}


document.addEventListener('DOMContentLoaded', () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const startDateInput = document.getElementById('start-date');
    const endDateInput = document.getElementById('end-date');

    if (startDateInput) startDateInput.value = today.toISOString().split('T')[0];
    if (endDateInput) endDateInput.value = today.toISOString().split('T')[0];

    // Automatically fetch trips for today's date range on page load
    fetchTripsInRange(startDateInput.value, endDateInput.value);

});

function updateClock() {
    const dateElement = document.getElementById('current-date');
    const timeElement = document.getElementById('current-time');
    if (dateElement && timeElement) {
        const now = new Date();

        
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
    if (document.getElementById('map')) {
        initializeMap();
        initializeLayerControls();
        fetchTrips();
    }
    startClock();
    initializeDatePickers();
    initializeEventListeners();
    fetchMetrics(); 
    initializeSidebarToggle();
    updateLayerOrderUI();
});

function initializeSidebarToggle() {
    const sidebarToggleBtn = document.getElementById('sidebar-toggle');
    const sidebar = document.getElementById('sidebar');

    sidebarToggleBtn.addEventListener('click', () => {
        sidebar.classList.toggle('active');
    });

    document.addEventListener('click', (event) => {
        if (!sidebar.contains(event.target) && !sidebarToggleBtn.contains(event.target) && sidebar.classList.contains('active')) {
            sidebar.classList.remove('active');
        }
    });
}

function loadHistoricalData() {
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;

    fetch('/load_historical_data', {
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
        alert(data.message);
        fetchTrips(); // Refresh the trips data after loading historical data
    })
    .catch(error => {
        console.error('Error loading historical data:', error);
        alert('An error occurred while loading historical data.');
    });
}