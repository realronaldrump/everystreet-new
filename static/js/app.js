let map;
let currentGeoJSON = {
    type: 'FeatureCollection',
    features: []
};
let layerGroup;

const socket = io();

function initializeMap() {
    try {
        map = L.map('map').setView([37.0902, -95.7129], 4);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors'
        }).addTo(map);
        layerGroup = L.layerGroup().addTo(map);
    } catch (error) {
        console.error('Error initializing Leaflet map:', error);
        document.getElementById('map').innerHTML = '<p>Error loading map. Please check your internet connection and try again.</p>';
    }
}

function initializeDateRange() {
    const today = new Date();
    const fourYearsAgo = new Date(today.getTime() - 4 * 365 * 24 * 60 * 60 * 1000);
    
    document.getElementById('start-date').value = fourYearsAgo.toISOString().split('T')[0];
    document.getElementById('end-date').value = today.toISOString().split('T')[0];
}

function showLoadingOverlay() {
    document.getElementById('loading-overlay').style.display = 'flex';
}

function hideLoadingOverlay() {
    document.getElementById('loading-overlay').style.display = 'none';
}

function updateLoadingProgress(progress) {
    const loadingBar = document.getElementById('loading-bar');
    const loadingText = document.getElementById('loading-text');
    loadingBar.style.width = `${progress}%`;
    loadingText.textContent = `Loading trips: ${progress}%`;
}

function fetchTrips() {
    showLoadingOverlay();
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;
    
    fetch(`/api/trips?start_date=${startDate}&end_date=${endDate}`)
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
        })
        .then(trips => {
            console.log(`Received ${trips.length} trips`);
            
            currentGeoJSON.features = trips.map(trip => {
                let geometry;
                try {
                    geometry = typeof trip.gps === 'string' ? JSON.parse(trip.gps) : trip.gps;
                    if (!geometry || !geometry.coordinates || geometry.coordinates.length === 0) {
                        console.warn(`Invalid geometry for trip ${trip.transactionId}`);
                        return null;
                    }
                } catch (error) {
                    console.error(`Error parsing GPS data for trip ${trip.transactionId}:`, error);
                    return null;
                }
                return {
                    type: 'Feature',
                    geometry: geometry,
                    properties: {
                        transactionId: trip.transactionId,
                        startTime: trip.startTime,
                        endTime: trip.endTime,
                        distance: trip.distance,
                        imei: trip.imei
                    }
                };
            }).filter(feature => feature !== null);

            updateMap();
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
            document.getElementById('total-distance').textContent = metrics.total_distance.toFixed(2);
            document.getElementById('avg-distance').textContent = metrics.avg_distance.toFixed(2);
            document.getElementById('avg-start-time').textContent = metrics.avg_start_time;
            document.getElementById('avg-driving-time').textContent = metrics.avg_driving_time;
        })
        .catch(error => {
            console.error('Error fetching metrics:', error);
        });
}

function updateMap() {
    console.log('Updating map with currentGeoJSON:', currentGeoJSON);

    layerGroup.clearLayers();

    const colors = ['#BB86FC', '#03DAC6', '#FF0266', '#CF6679'];
    const imeis = [...new Set(currentGeoJSON.features.map(f => f.properties.imei))];

    currentGeoJSON.features.forEach((feature, index) => {
        const color = colors[imeis.indexOf(feature.properties.imei) % colors.length];
        L.geoJSON(feature, {
            style: {
                color: color,
                weight: 2,
                opacity: 0.7
            }
        }).addTo(layerGroup);
    });

    const bounds = L.geoJSON(currentGeoJSON).getBounds();
    if (bounds.isValid()) {
        map.fitBounds(bounds);
    } else {
        console.warn('No valid bounds to fit');
    }
}

function handleLiveRouteUpdate(data) {
    if (document.getElementById('show-live-routes').checked) {
        try {
            const newFeature = {
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    coordinates: data.data.map(point => [point.gps.lon, point.gps.lat])
                },
                properties: {
                    transactionId: data.transactionId,
                    startTime: data.data[0].timestamp,
                    endTime: data.data[data.data.length - 1].timestamp,
                    distance: data.data[data.data.length - 1].distance - data.data[0].distance,
                    imei: data.imei
                }
            };

            currentGeoJSON.features.push(newFeature);
            updateMap();
        } catch (error) {
            console.error('Error handling live route update:', error);
        }
    }
}

function handlePresetPeriodChange(e) {
    const today = new Date();
    let startDate = new Date(today);

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
    const main = document.querySelector('main');
    sidebar.classList.toggle('collapsed');
    main.classList.toggle('expanded');
}

function initThreeJSAnimations() {
    // Placeholder for Three.js animations
    // Implement your Three.js animations here
}

document.addEventListener('DOMContentLoaded', () => {
    initializeMap();
    initializeDateRange();
    fetchTrips();

    document.getElementById('apply-date-range').addEventListener('click', fetchTrips);
    document.getElementById('preset-periods-dropdown').addEventListener('change', handlePresetPeriodChange);
    document.getElementById('show-live-routes').addEventListener('change', handleLiveRoutesToggle);
    document.getElementById('sidebar-toggle').addEventListener('click', toggleSidebar);

    socket.on('live_route_update', handleLiveRouteUpdate);
    socket.on('loading_progress', (data) => {
        updateLoadingProgress(data.progress);
    });

    flatpickr("#start-date", { dateFormat: "Y-m-d" });
    flatpickr("#end-date", { dateFormat: "Y-m-d" });
});