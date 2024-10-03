let map = null;
let layerGroup = null;
let liveRoutePolyline = null;
let liveMarker = null;

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
        map.setMaxBounds([[-90, -180], [90, 180]]);

        console.log('Map initialized successfully');
    } catch (error) {
        console.error('Error initializing Leaflet map:', error);
    }
}

function initializeDateRange() {
    const today = new Date();
    const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    document.getElementById('start-date').value = sevenDaysAgo.toISOString().split('T')[0];
    document.getElementById('end-date').value = today.toISOString().split('T')[0];
}

function showLoadingOverlay() {
    document.getElementById('loading-overlay').style.display = 'flex';
    document.body.classList.add('loading');
}

function hideLoadingOverlay() {
    document.getElementById('loading-overlay').style.display = 'none';
    document.body.classList.remove('loading');
}

function updateLoadingProgress(progress) {
    const loadingBar = document.getElementById('loading-bar');
    const loadingText = document.getElementById('loading-text');
    loadingBar.style.width = `${progress}%`;
    loadingText.textContent = `Loading trips: ${progress}%`;
}

function fetchTrips() {
    const startDate = localStorage.getItem('startDate') || '';
    const endDate = localStorage.getItem('endDate') || '';

    const params = new URLSearchParams();
    if (startDate) params.append('start_date', startDate);
    if (endDate) params.append('end_date', endDate);

    const url = `/api/trips?${params.toString()}`;

    showLoadingOverlay();

    fetch(url)
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
        })
        .then(geojson => {
            console.log(`Received ${geojson.features.length} trips`);
            updateMap(geojson);
            fetchMetrics();
            initThreeJSAnimations();
            hideLoadingOverlay();
        })
        .catch(error => {
            console.error('Error fetching trips:', error);
            document.getElementById('map').innerHTML = '<p>Error loading trips. Please try again later.</p>';
            hideLoadingOverlay();
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

function updateMap(geojson) {
    console.log('Updating map with GeoJSON:', geojson);

    layerGroup.clearLayers();

    const colors = ['#BB86FC', '#03DAC6', '#FF0266', '#CF6679'];
    const imeis = [...new Set(geojson.features.map(f => f.properties.imei))];

    L.geoJSON(geojson, {
        style: (feature) => {
            const color = colors[imeis.indexOf(feature.properties.imei) % colors.length];
            return {
                color: color,
                weight: 2,
                opacity: 0.5
            };
        },
        onEachFeature: (feature, layer) => {
            // Convert ISO date strings to Date objects and format them
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

    const bounds = L.geoJSON(geojson).getBounds();
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
            const isVehicleOff = data.isVehicleOff; // Assuming this data is available

            // Remove existing polyline and marker if they exist
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

            // Optionally, center the map on the new point
            map.panTo(lastPoint);

        } catch (error) {
            console.error('Error handling live route update:', error);
        }
    }
}

function handlePresetPeriodChange(e) {
    const today = new Date();
    const startDate = new Date(today);

    switch (e.target.value) {
        case '24h':
            startDate.setDate(today.getDate() - 1);
            break;
        case '7d':
            startDate.setDate(today.getDate() - 7);
            break;
        case '30d':
            startDate.setMonth(today.getMonth() - 1);
            break;
        case '1y':
            startDate.setFullYear(today.getFullYear() - 1);
            break;
        case '4y':
            startDate.setFullYear(today.getFullYear() - 4);
            break;
    }

    document.getElementById('start-date').value = startDate.toISOString().split('T')[0];
    document.getElementById('end-date').value = today.toISOString().split('T')[0];
    fetchTrips();
}

function handleLiveRoutesToggle(e) {
    if (e.target.checked) {
        console.log('Live routes enabled');
    } else {
        console.log('Live routes disabled');
    }
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('active');
}

function initThreeJSAnimations() {
    // Placeholder for Three.js animations
}

document.addEventListener('DOMContentLoaded', () => {
    initializeDatePickers();
    initializeMap();
    initializeEventListeners();
    fetchTrips();
});

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
}

socket.on('live_route_update', handleLiveRouteUpdate);
socket.on('loading_progress', (data) => {
    updateLoadingProgress(data.progress);
});

flatpickr("#start-date", { dateFormat: "Y-m-d" });
flatpickr("#end-date", { dateFormat: "Y-m-d" });

function fetchTripsInRange(startDate, endDate) {
    fetch('/api/fetch_trips_in_range', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ start_date: startDate, end_date: endDate })
    })
    .then(response => response.json())
    .then(data => {
        if (data.status === 'success') {
            alert(data.message);
            fetchTrips(); // Refresh trips table after successful fetch
        } else {
            alert(`Error: ${data.message}`);
        }
    })
    .catch(error => {
        console.error('Error fetching trips in range:', error);
        alert('An error occurred while fetching trips in range.');
    });
}