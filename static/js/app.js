mapboxgl.accessToken = 'pk.eyJ1IjoiZGF2aXNkZWF0b24iLCJhIjoiY2x6bG43d2lxMDQ2bjJxcGxnbHlkYXNnYiJ9.mNEfq94qzLyu21ZvpdiTRw';

let map;
let currentGeoJSON = {
    type: 'FeatureCollection',
    features: []
};

try {
    map = new mapboxgl.Map({
        container: 'map',
        style: 'mapbox://styles/mapbox/dark-v10',
        center: [-95.7129, 37.0902],
        zoom: 3
    });

    map.on('load', () => {
        updateMap(); // This will add the source and layer when the map is ready
    });
} catch (error) {
    console.error('Error initializing MapBox map:', error);
    document.getElementById('map').innerHTML = '<p>Error loading map. Please check your internet connection and try again.</p>';
}

const socket = io();

function initializeDateRange() {
    const today = new Date();
    const fourYearsAgo = new Date(today.getTime() - 4 * 365 * 24 * 60 * 60 * 1000);
    
    document.getElementById('start-date').value = fourYearsAgo.toISOString().split('T')[0];
    document.getElementById('end-date').value = today.toISOString().split('T')[0];
}

// In the fetchTrips function
function fetchTrips() {
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
            
            // Group trips by IMEI
            const tripsByImei = {};
            trips.forEach(trip => {
                if (!tripsByImei[trip.imei]) {
                    tripsByImei[trip.imei] = [];
                }
                tripsByImei[trip.imei].push(trip);
            });
            
            // Log trips count for each IMEI
            Object.keys(tripsByImei).forEach(imei => {
                console.log(`IMEI ${imei}: ${tripsByImei[imei].length} trips`);
            });

            currentGeoJSON.features = trips.map(trip => {
                let geometry;
                try {
                    geometry = typeof trip.gps === 'string' ? JSON.parse(trip.gps) : trip.gps;
                } catch (error) {
                    console.error('Error parsing GPS data:', error);
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

            // Log unique IMEIs in the processed GeoJSON
            const uniqueImeis = [...new Set(currentGeoJSON.features.map(f => f.properties.imei))];
            console.log('Unique IMEIs in processed GeoJSON:', uniqueImeis);

            updateMap(); // Update the map once the data is ready
            fetchMetrics(); // Fetch the metrics once trips are loaded
            initThreeJSAnimations(); // Initialize Three.js animations
        })
        .catch(error => {
            console.error('Error fetching trips:', error);
            // Display an error message to the user
            document.getElementById('map').innerHTML = '<p>Error loading trips. Please try again later.</p>';
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
    if (!map.loaded()) {
        map.on('load', updateMap);
        return;
    }

    if (map.getSource('routes')) {
        map.getSource('routes').setData(currentGeoJSON);
    } else {
        map.addSource('routes', {
            type: 'geojson',
            data: currentGeoJSON
        });

        // Add a layer for each IMEI
        const imeis = [...new Set(currentGeoJSON.features.map(f => f.properties.imei))];
        const colors = ['#BB86FC', '#03DAC6', '#FF0266', '#CF6679']; // Add more colors if needed

        imeis.forEach((imei, index) => {
            map.addLayer({
                id: `routes-${imei}`,
                type: 'line',
                source: 'routes',
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round'
                },
                paint: {
                    'line-color': colors[index % colors.length],
                    'line-width': 2
                },
                filter: ['==', ['get', 'imei'], imei]
            });
        });
    }

    const bounds = new mapboxgl.LngLatBounds();
    currentGeoJSON.features.forEach(feature => {
        if (feature.geometry && feature.geometry.coordinates) {
            if (Array.isArray(feature.geometry.coordinates[0])) {
                feature.geometry.coordinates.forEach(coord => bounds.extend(coord));
            } else {
                bounds.extend(feature.geometry.coordinates);
            }
        }
    });

    if (!bounds.isEmpty()) {
        map.fitBounds(bounds, { padding: 50 });
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
                    distance: data.data[data.data.length - 1].distance - data.data[0].distance
                }
            };

            currentGeoJSON.features.push(newFeature);
            updateMap();
        } catch (error) {
            console.error('Error handling live route update:', error);
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initializeDateRange();
    fetchTrips();

    document.getElementById('apply-date-range').addEventListener('click', fetchTrips);
    document.getElementById('preset-periods').addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON') {
            const today = new Date();
            let startDate = new Date(today);

            switch (e.target.dataset.period) {
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
    });

    document.getElementById('show-live-routes').addEventListener('change', (e) => {
        if (e.target.checked) {
            console.log('Live routes enabled');
        } else {
            console.log('Live routes disabled');
        }
    });

    socket.on('live_route_update', handleLiveRouteUpdate);
});

// Basic error handling for MapBox
if (map) {
    map.on('error', (e) => {
        console.error('MapBox error:', e.error);
    });
}

// Initialize Three.js animations
function initThreeJSAnimations() {
    initBackgroundAnimation();
    initMetricsAnimation();
}