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

function fetchTrips() {
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;
    const imeis = document.getElementById('imei').value.split(',').map(imei => imei.trim()).filter(imei => imei); // Get IMEIs from input

    if (imeis.length === 0) {
        alert('Please enter at least one IMEI.');
        return;
    }

    const imeisParam = imeis.join(','); // Convert IMEIs to a comma-separated string

    fetch(`/api/trips?start_date=${startDate}&end_date=${endDate}&imei=${imeisParam}`)
        .then(response => response.json())
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

                    if (!geometry || !geometry.coordinates) throw new Error('Invalid GPS data');

                    // Ensure correct coordinate order [longitude, latitude]
                    if (geometry.type === 'LineString' || geometry.type === 'Point') {
                        geometry.coordinates = geometry.coordinates.map(coord => {
                            if (Array.isArray(coord) && coord.length === 2) {
                                return [coord[0], coord[1]];  // [longitude, latitude]
                            }
                            return coord;
                        });
                    }
                } catch (error) {
                    console.error('Error parsing GPS data:', error, trip);
                    return null;  // Skip invalid trip
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
            }).filter(feature => feature !== null);  // Filter out invalid features

            // Log unique IMEIs in the processed GeoJSON
            const uniqueImeis = [...new Set(currentGeoJSON.features.map(f => f.properties.imei))];
            console.log('Unique IMEIs in processed GeoJSON:', uniqueImeis);

            updateMap(); // Update the map once the data is ready
            fetchMetrics(); // Fetch the metrics once trips are loaded
        })
        .catch(error => {
            console.error('Error fetching trips:', error);
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

    // Check if the source exists, otherwise add it
    if (map.getSource('routes')) {
        map.getSource('routes').setData(currentGeoJSON);
    } else {
        map.addSource('routes', {
            type: 'geojson',
            data: currentGeoJSON
        });

        // Add a layer for each IMEI
        // Add a layer for each IMEI
        const uniqueImeis = [...new Set(currentGeoJSON.features.map(f => f.properties.imei))];

        uniqueImeis.forEach(imei => {
            map.addLayer({
                id: `route-${imei}`,
                type: 'line',
                source: 'routes',
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round'
                },
                paint: {
                    'line-color': '#888',
                    'line-width': 4
                },
                filter: ['==', 'imei', imei]  // Filter by IMEI
            });
        });

        // Fit the map to the bounds of the current GeoJSON
        const bounds = new mapboxgl.LngLatBounds();
        currentGeoJSON.features.forEach(feature => {
            if (feature.geometry && feature.geometry.coordinates) {
                feature.geometry.coordinates.forEach(coord => {
                    bounds.extend(coord);
                });
            }
        });

        if (bounds.isEmpty()) {
            console.warn('No valid coordinates to fit the map to.');
        } else {
            map.fitBounds(bounds, { padding: 20 });
        }
    }
}

// Event listener for the date range apply button
document.getElementById('apply-date-range').addEventListener('click', () => {
    fetchTrips();  // Fetch trips when the date range is applied
});

// Event listeners for preset periods
document.querySelectorAll('#preset-periods button').forEach(button => {
    button.addEventListener('click', () => {
        const period = button.getAttribute('data-period');
        const endDate = new Date();
        let startDate;

        switch (period) {
            case '24h':
                startDate = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
                break;
            case '7d':
                startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
                break;
            case '30d':
                startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
                break;
            case '1y':
                startDate = new Date(endDate.getTime() - 365 * 24 * 60 * 60 * 1000);
                break;
            default:
                return;
        }

        document.getElementById('start-date').value = startDate.toISOString().split('T')[0];
        document.getElementById('end-date').value = endDate.toISOString().split('T')[0];
        fetchTrips();  // Fetch trips with the new date range
    });
});

// Initialize date range on load
initializeDateRange();