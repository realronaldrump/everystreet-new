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
        updateMap();
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
            
            const tripsByImei = {};
            trips.forEach(trip => {
                if (!tripsByImei[trip.imei]) {
                    tripsByImei[trip.imei] = [];
                }
                tripsByImei[trip.imei].push(trip);
            });
            
            Object.keys(tripsByImei).forEach(imei => {
                console.log(`IMEI ${imei}: ${tripsByImei[imei].length} trips`);
            });

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

            const uniqueImeis = [...new Set(currentGeoJSON.features.map(f => f.properties.imei))];
            console.log('Unique IMEIs in processed GeoJSON:', uniqueImeis);

            updateMap();
            fetchMetrics();
            initThreeJSAnimations();
        })
        .catch(error => {
            console.error('Error fetching trips:', error);
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

        const imeis = [...new Set(currentGeoJSON.features.map(f => f.properties.imei))];
        const colors = ['#BB86FC', '#03DAC6', '#FF0266', '#CF6679'];

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
                feature.geometry.coordinates.forEach(coord => {
                    if (Array.isArray(coord) && coord.length >= 2) {
                        const lng = parseFloat(coord[0]);
                        const lat = parseFloat(coord[1]);
                        if (!isNaN(lng) && !isNaN(lat)) {
                            bounds.extend([lng, lat]);
                        } else {
                            console.warn('Invalid coordinates:', coord, 'for feature:', feature);
                        }
                    }
                });
            } else if (feature.geometry.coordinates.length >= 2) {
                const lng = parseFloat(feature.geometry.coordinates[0]);
                const lat = parseFloat(feature.geometry.coordinates[1]);
                if (!isNaN(lng) && !isNaN(lat)) {
                    bounds.extend([lng, lat]);
                } else {
                    console.warn('Invalid coordinates:', feature.geometry.coordinates, 'for feature:', feature);
                }
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

if (map) {
    map.on('error', (e) => {
        console.error('MapBox error:', e.error);
    });
}

function initThreeJSAnimations() {
    initBackgroundAnimation();
    initMetricsAnimation();
}

// The Three.js animations functions (initBackgroundAnimation and initMetricsAnimation) 
// should be defined in the three_animations.js file, which is included in the HTML.