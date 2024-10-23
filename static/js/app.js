/* global L, flatpickr, io */

// Create namespace for the application using IIFE pattern
window.EveryStreet = (function() {
    // Private variables
    let map = null;
    let layerGroup = null;
    let liveRoutePolyline = null;
    let liveMarker = null;
    let socket = null;

    const mapLayers = {
        trips: { layer: null, visible: true, color: '#BB86FC', order: 1, opacity: 0.4 },
        historicalTrips: { layer: null, visible: true, color: '#03DAC6', order: 2, opacity: 0.4 },
        matchedTrips: { layer: null, visible: true, color: '#CF6679', order: 3, opacity: 0.4 },
        osmBoundary: { layer: null, visible: false, color: '#03DAC6', order: 4, opacity: 0.7 },
        osmStreets: { layer: null, visible: false, color: '#FF0266', order: 5, opacity: 0.7 }
    };

    // At the top of app.js, add this flag
    let isInitialized = false;

    // Private functions
    function initializeMap() {
        const mapElement = document.getElementById('map');
        if (!mapElement) {
            console.error('Map container not found');
            return;
        }

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

    function setInitialDates() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayStr = today.toISOString().split('T')[0];
        
        // Only set if not already set during this session
        if (!window.datesInitialized) {
            localStorage.setItem('startDate', todayStr);
            localStorage.setItem('endDate', todayStr);
            window.datesInitialized = true;
        }
    }

    function initializeDatePickers() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const commonConfig = {
            dateFormat: "Y-m-d",
            maxDate: "today",
            defaultDate: today,
            enableTime: false,
            onChange: function() {}, // Empty onChange to prevent automatic updates
            onClose: function() {}, // Empty onClose to prevent automatic updates
            static: true // Prevents automatic updates on initialization
        };

        if (document.getElementById('start-date')) {
            flatpickr("#start-date", commonConfig);
        }

        if (document.getElementById('end-date')) {
            flatpickr("#end-date", commonConfig);
        }
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
        if (loadingBar && loadingText) {
            loadingBar.style.width = `${progress}%`;
            loadingText.textContent = `Loading trips: ${progress}%`;
        }
    }

    async function fetchTrips() {
        console.log('fetchTrips called from:', new Error().stack); // Debug line
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

        try {
            const response = await fetch(url);
            const geojson = await response.json();
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

            await fetchMatchedTrips(startDate, endDate, imei);
            updateMap();
        } catch (error) {
            console.error('Error fetching trips:', error);
        } finally {
            hideLoadingOverlay();
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
    function updateMap() {
        console.log('Updating map');
        if (!map || !layerGroup) {
            console.log('Map or layerGroup not initialized, skipping map update');
            return;
        }
        layerGroup.clearLayers();

        const orderedLayers = Object.entries(mapLayers)
            .filter(([, layerInfo]) => layerInfo.visible)
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
        let validBoundsFound = false;

        for (const layerName in mapLayers) {
            if (mapLayers[layerName].visible && mapLayers[layerName].layer) {
                const layerBounds = L.geoJSON(mapLayers[layerName].layer).getBounds();
                if (layerBounds.isValid()) {
                    bounds.extend(layerBounds);
                    validBoundsFound = true;
                }
            }
        }

        if (validBoundsFound) {
            map.fitBounds(bounds);
        } else {
            console.warn('No valid bounds to fit');
        }
    }

    function handleLiveRouteUpdate(data) {
        if (document.getElementById('show-live-routes')?.checked) {
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
            .filter(([, layerInfo]) => layerInfo.visible)
            .sort((a, b) => b[1].order - a[1].order);

        const ul = document.createElement('ul');
        ul.id = 'layer-order-list';
        orderedLayers.forEach(([layerName]) => {
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

        layerList?.addEventListener('dragstart', (e) => {
            draggedItem = e.target;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', '');
        });

        layerList?.addEventListener('dragover', (e) => {
            e.preventDefault();
            const targetItem = e.target.closest('li');
            if (targetItem && targetItem !== draggedItem) {
                const rect = targetItem.getBoundingClientRect();
                const next = (e.clientY - rect.top) / (rect.bottom - rect.top) > 0.5;
                layerList.insertBefore(draggedItem, next ? targetItem.nextSibling : targetItem);
            }
        });

        layerList?.addEventListener('dragend', () => {
            updateLayerOrder();
        });
    }

    function updateLayerOrder() {
        const layerList = document.getElementById('layer-order-list');
        if (!layerList) return;
        
        const layers = Array.from(layerList.querySelectorAll('li'));
        const totalLayers = layers.length;
        layers.forEach((layer, index) => {
            mapLayers[layer.dataset.layer].order = totalLayers - index;
        });
        updateMap();
    }

    function validateLocation() {
        const locationInput = document.getElementById('location-input');
        const locationTypeInput = document.getElementById('location-type');
        if (!locationInput || !locationTypeInput || !locationInput.value || !locationTypeInput.value) return;

        fetch('/api/validate_location', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ 
                location: locationInput.value, 
                locationType: locationTypeInput.value 
            }),
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
        // Apply filters button
        const applyFiltersButton = document.getElementById('apply-filters');
        if (applyFiltersButton && !applyFiltersButton.hasListener) {
            applyFiltersButton.hasListener = true;
            applyFiltersButton.addEventListener('click', () => {
                const startDate = document.getElementById('start-date').value;
                const endDate = document.getElementById('end-date').value;
                localStorage.setItem('startDate', startDate);
                localStorage.setItem('endDate', endDate);
                fetchTrips();
                fetchMetrics();
            });
        }

        // Map controls toggle
        const mapControlsToggle = document.getElementById('controls-toggle');
        if (mapControlsToggle) {
            mapControlsToggle.addEventListener('click', function() {
                const mapControls = document.getElementById('map-controls');
                const controlsContent = document.getElementById('controls-content');
                mapControls?.classList.toggle('minimized');
                const icon = this.querySelector('i');
                if (mapControls?.classList.contains('minimized')) {
                    icon?.classList.replace('fa-chevron-up', 'fa-chevron-down');
                    if (controlsContent) controlsContent.style.display = 'none';
                } else {
                    icon?.classList.replace('fa-chevron-down', 'fa-chevron-up');
                    if (controlsContent) controlsContent.style.display = 'block';
                }
            });
        }

        // OSM Controls
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

        // Map matching buttons
        const mapMatchTripsButton = document.getElementById('map-match-trips');
        if (mapMatchTripsButton) {
            mapMatchTripsButton.addEventListener('click', mapMatchTrips);
        }

        const mapMatchHistoricalTripsButton = document.getElementById('map-match-historical-trips');
        if (mapMatchHistoricalTripsButton) {
            mapMatchHistoricalTripsButton.addEventListener('click', mapMatchHistoricalTrips);
        }

        // Historical data loading
        const loadHistoricalDataButton = document.getElementById('load-historical-data');
        if (loadHistoricalDataButton) {
            loadHistoricalDataButton.addEventListener('click', loadHistoricalData);
        }
    }

    function fetchMetrics() {
        const startDateInput = document.getElementById('start-date');
        const endDateInput = document.getElementById('end-date');
        const imeiInput = document.getElementById('imei');
        
        if (!startDateInput || !endDateInput || !startDateInput.value || !endDateInput.value) return;

        const imeiValue = imeiInput ? imeiInput.value : '';

        fetch(`/api/metrics?start_date=${startDateInput.value}&end_date=${endDateInput.value}&imei=${imeiValue}`)
            .then(response => response.json())
            .then(metrics => {
                const elements = {
                    'total-trips': metrics.total_trips,
                    'total-distance': metrics.total_distance,
                    'avg-distance': metrics.avg_distance,
                    'avg-start-time': metrics.avg_start_time,
                    'avg-driving-time': metrics.avg_driving_time
                };

                Object.entries(elements).forEach(([id, value]) => {
                    const element = document.getElementById(id);
                    if (element) {
                        element.textContent = value;
                    }
                });
            })
            .catch(error => {
                console.error('Error fetching metrics:', error);
            });
    }

    function mapMatchTrips() {
        const startDateInput = document.getElementById('start-date');
        const endDateInput = document.getElementById('end-date');
        if (!startDateInput || !endDateInput || !startDateInput.value || !endDateInput.value) return;

        showLoadingOverlay();

        fetch('/api/map_match_trips', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                start_date: startDateInput.value,
                end_date: endDateInput.value
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
        const startDateInput = document.getElementById('start-date');
        const endDateInput = document.getElementById('end-date');
        if (!startDateInput || !endDateInput || !startDateInput.value || !endDateInput.value) return;

        showLoadingOverlay();

        fetch('/api/map_match_historical_trips', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                start_date: startDateInput.value,
                end_date: endDateInput.value
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

    function loadHistoricalData() {
        showLoadingOverlay();

        fetch('/api/load_historical_data', {
            method: 'POST'
        })
        .then(response => response.json())
        .then(data => {
            alert(data.message);
            if (data.status === 'success') {
                fetchTrips();
            }
        })
        .catch(error => {
            console.error('Error loading historical data:', error);
            alert('Error loading historical data. Please check the console for details.');
        })
        .finally(() => {
            hideLoadingOverlay();
        });
    }

    function initializeDatePresets() {
        document.querySelectorAll('.date-preset').forEach(button => {
            button.addEventListener('click', function() {
                const range = this.dataset.range;
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                let startDate = new Date(today);
                let endDate = new Date(today);

                switch(range) {
                    case 'today':
                        // Start and end are already today
                        break;
                    case 'yesterday':
                        startDate.setDate(startDate.getDate() - 1);
                        endDate.setDate(endDate.getDate() - 1);
                        break;
                    case 'last-week':
                        startDate.setDate(startDate.getDate() - 7);
                        break;
                    case 'last-month':
                        startDate.setDate(startDate.getDate() - 30);
                        break;
                    case 'last-6-months':
                        startDate.setMonth(startDate.getMonth() - 6);
                        break;
                    case 'last-year':
                        startDate.setFullYear(startDate.getFullYear() - 1);
                        break;
                }

                // Update the flatpickr instances
                const startDatePicker = document.getElementById('start-date')._flatpickr;
                const endDatePicker = document.getElementById('end-date')._flatpickr;
                
                startDatePicker.setDate(startDate);
                endDatePicker.setDate(endDate);

                // Store the new dates in localStorage
                localStorage.setItem('startDate', startDate.toISOString().split('T')[0]);
                localStorage.setItem('endDate', endDate.toISOString().split('T')[0]);

                // Fetch new data
                fetchTrips();
                fetchMetrics();
            });
        });
    }

    // Public API
    return {
        // Initialization
        initialize: function() {
            // Guard against multiple initializations
            if (isInitialized) {
                console.log('App already initialized, skipping...');
                return;
            }
            
            socket = io();
            
            socket.on('live_route_update', handleLiveRouteUpdate);
            socket.on('loading_progress', (data) => {
                updateLoadingProgress(data.progress);
            });

            setInitialDates(); // Set initial dates once
            
            if (document.getElementById('map')) {
                initializeMap();
                initializeLayerControls();
                fetchTrips();
            }
            
            initializeDatePickers();
            initializeEventListeners();
            fetchMetrics();
            updateLayerOrderUI();
            initializeDatePresets();
            
            // Mark as initialized
            isInitialized = true;
        },

        // Public methods
        getMap: () => map,
        getLayerGroup: () => layerGroup,
        getSocket: () => socket,
        mapLayers,
        
        // Public actions
        refreshMap: updateMap,
        fetchTrips: fetchTrips,
        fetchMetrics: fetchMetrics,
        validateLocation: validateLocation,
        generateOSMData: generateOSMData,
        mapMatchTrips: mapMatchTrips,
        mapMatchHistoricalTrips: mapMatchHistoricalTrips,
        loadHistoricalData: loadHistoricalData,
        
        // Layer management
        toggleLayer: toggleLayer,
        changeLayerColor: changeLayerColor,
        changeLayerOpacity: changeLayerOpacity,
        updateLayerOrder: updateLayerOrder
    };
})();

// Initialize the application when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    EveryStreet.initialize();
});

