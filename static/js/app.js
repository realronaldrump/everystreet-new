/* global L, flatpickr, io */

// Self-contained IIFE to prevent global namespace pollution
(() => {
    'use strict';

    const mapLayers = {
        trips: {
            order: 1,
            color: '#BB86FC',
            opacity: 0.4,
            visible: true,
        },
        historicalTrips: {
            order: 2,
            color: '#03DAC6',
            opacity: 0.4,
            visible: false,
        },
        matchedTrips: {
            order: 3,
            color: '#CF6679',
            opacity: 0.4,
            visible: false,
        },
        osmBoundary: {
            order: 4,
            color: '#03DAC6',
            opacity: 0.7,
            visible: false,
        },
        osmStreets: {
            order: 5,
            color: '#FF0266',
            opacity: 0.7,
            visible: false,
        },
        streetCoverage: {
            order: 6,
            color: '#00FF00',
            opacity: 0.7,
            name: 'Street Coverage',
            visible: false,
        },
        customPlaces: {
            order: 7,
            color: '#FF9800',
            opacity: 0.5,
            visible: false,
        },
    };

    const mapSettings = {
        highlightRecentTrips: true,
    };

    let map,
        layerGroup,
        socket,
        liveTracker,
        isInitialized = false,
        mapInitialized = false;

    const loadingOverlay = document.querySelector('.loading-overlay');
    const loadingText = document.getElementById('loading-text');
    const loadingBar = document.getElementById('loading-bar');

    // Loading Manager for better progress tracking
    class LoadingManager {
        constructor() {
            this.operations = {};
            this.totalProgress = 0;
        }

        startOperation(name, total) {
            this.operations[name] = {
                total: total,
                progress: 0,
                subOperations: {},
            };
            this.updateOverallProgress();
            showLoadingOverlay(name);
        }

        addSubOperation(operationName, subOperationName, total) {
            if (this.operations[operationName]) {
                this.operations[operationName].subOperations[subOperationName] = {
                    total: total,
                    progress: 0,
                };
            }
        }

        updateSubOperation(operationName, subOperationName, progress) {
            if (
                this.operations[operationName] &&
                this.operations[operationName].subOperations[subOperationName]
            ) {
                this.operations[operationName].subOperations[subOperationName].progress = progress;
                this.updateOperationProgress(operationName);
            }
        }

        updateOperationProgress(operationName) {
            const operation = this.operations[operationName];
            if (operation) {
                const subOpProgress = Object.values(operation.subOperations).reduce(
                    (acc, subOp) => acc + (subOp.progress / subOp.total) * (subOp.total / operation.total),
                    0
                );
                operation.progress = subOpProgress * operation.total;
                this.updateOverallProgress();
            }
        }

        updateOverallProgress() {
            this.totalProgress = Object.values(this.operations).reduce(
                (acc, op) => acc + op.progress / 100,
                0
            );
            const totalOperations = Object.keys(this.operations).length;
            const overallPercentage = (this.totalProgress / totalOperations) * 100;
            updateLoadingProgress(overallPercentage);
        }

        finish(operationName) {
            if (operationName) {
                delete this.operations[operationName];
            } else {
                this.operations = {};
            }
            this.updateOverallProgress();
            if (Object.keys(this.operations).length === 0) {
                hideLoadingOverlay();
            }
        }
    }

    const loadingManager = new LoadingManager();

    function initializeMap() {
        if (mapInitialized || !document.getElementById('map')) return;

        try {
            map = L.map('map', {
                center: [37.0902, -95.7129],
                zoom: 4,
                zoomControl: true,
                attributionControl: false,
                maxBounds: [
                    [-90, -180],
                    [90, 180],
                ],
            });

            L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                maxZoom: 19,
                attribution: '',
            }).addTo(map);

            layerGroup = L.layerGroup().addTo(map);

            mapLayers.customPlaces.layer = L.layerGroup();

            // Initialize LiveTripTracker after the map is fully ready
            if (!window.liveTracker) {
                try {
                    window.liveTracker = new LiveTripTracker(map);
                    console.log("Live Tracker initialized");
                } catch (error) {
                    console.error('Error initializing live tracking:', error);
                }
            }

            if (!mapInitialized) {
                fetch('/api/last_trip_point')
                    .then((response) => response.json())
                    .then((data) => {
                        const lastPoint = data.lastPoint;
                        if (lastPoint) {
                            map.flyTo([lastPoint[1], lastPoint[0]], 11, {
                                duration: 2,
                                easeLinearity: 0.25,
                            });
                        } else {
                            map.setView([31.55002, -97.123354], 14);
                        }
                        mapInitialized = true;
                    })
                    .catch((error) => {
                        console.error('Error fetching last point:', error);
                        map.setView([37.0902, -95.7129], 4);
                        mapInitialized = true;
                    });
            }
        } catch (error) {
            console.error('Error initializing map:', error);
        }
    }

    function setInitialDates() {
        const today = new Date().toISOString().split('T')[0];
        if (!localStorage.getItem('startDate')) localStorage.setItem('startDate', today);
        if (!localStorage.getItem('endDate')) localStorage.setItem('endDate', today);

        const startDateInput = document.getElementById('start-date');
        const endDateInput = document.getElementById('end-date');
        if (startDateInput) startDateInput.value = localStorage.getItem('startDate');
        if (endDateInput) endDateInput.value = localStorage.getItem('endDate');

        // Set flag for first load
        localStorage.setItem('isFirstLoad', 'true');
    }

    function initializeDatePickers() {
        const today = new Date();
        const commonConfig = {
            dateFormat: 'Y-m-d',
            maxDate: today,
            enableTime: false,
            static: true,
            onChange: () => {},
            onClose: () => {},
        };
        if (document.getElementById('start-date')) {
            flatpickr('#start-date', commonConfig);
        }
        if (document.getElementById('end-date')) {
            flatpickr('#end-date', commonConfig);
        }
    }

    function showLoadingOverlay(message = 'Loading trips') {
        if (loadingOverlay) {
            loadingOverlay.style.display = 'flex';
            loadingText.textContent = message + ': 0%';
            loadingBar.style.width = '0%';
            loadingBar.setAttribute('aria-valuenow', '0');
        }
    }

    function updateLoadingProgress(percentage, message) {
        if (loadingText && loadingBar) {
            loadingText.textContent =
                (message || loadingText.textContent.split(':')[0]) + `: ${Math.round(percentage)}%`;
            loadingBar.style.width = `${percentage}%`;
            loadingBar.setAttribute('aria-valuenow', percentage);
        }
    }

    function hideLoadingOverlay() {
        if (loadingOverlay) {
            setTimeout(() => (loadingOverlay.style.display = 'none'), 500);
        }
    }

    function getFilterParams() {
        const startDate = document.getElementById('start-date').value;
        const endDate = document.getElementById('end-date').value;
        return new URLSearchParams({
            start_date: startDate,
            end_date: endDate
        });
    }

    async function fetchTrips() {
        loadingManager.startOperation('Fetching and Displaying Trips', 100);
        loadingManager.addSubOperation('fetch', 'Fetching Data', 50);
        loadingManager.addSubOperation('fetch', 'Processing Data', 30);
        loadingManager.addSubOperation('fetch', 'Displaying Data', 20);

        try {
            const startDate = localStorage.getItem('startDate');
            const endDate = localStorage.getItem('endDate');

            if (!startDate || !endDate) {
                console.warn('No dates selected');
                loadingManager.finish('Fetching and Displaying Trips');
                return;
            }

            document.getElementById('start-date').value = startDate;
            document.getElementById('end-date').value = endDate;

            loadingManager.updateSubOperation('fetch', 'Fetching Data', 25);
            const params = getFilterParams();
            const response = await fetch(`/api/trips?${params.toString()}`);

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const geojson = await response.json();
            loadingManager.updateSubOperation('fetch', 'Fetching Data', 50);
            loadingManager.updateSubOperation('fetch', 'Processing Data', 15);

            if (window.tripsTable) {
                const formattedTrips = geojson.features
                    .filter((trip) => trip.properties.imei !== 'HISTORICAL')
                    .map((trip) => ({
                        ...trip.properties,
                        gps: trip.geometry,
                        destination: trip.properties.destination || 'N/A',
                        isCustomPlace: trip.properties.isCustomPlace || false,
                        distance: (+trip.properties.distance).toFixed(2),
                    }));
                await new Promise((resolve) => {
                    window.tripsTable.clear().rows.add(formattedTrips).draw();
                    setTimeout(resolve, 100);
                });
            }

            if (document.getElementById('map') && map && layerGroup) {
                mapLayers.trips.layer = {
                    type: 'FeatureCollection',
                    features: geojson.features.filter(
                        (feature) => feature.properties.imei !== 'HISTORICAL'
                    ),
                };
                mapLayers.historicalTrips.layer = {
                    type: 'FeatureCollection',
                    features: geojson.features.filter(
                        (feature) => feature.properties.imei === 'HISTORICAL'
                    ),
                };
                await updateMap();
            }

            loadingManager.updateSubOperation('fetch', 'Processing Data', 30);
            loadingManager.updateSubOperation('fetch', 'Displaying Data', 10);

            try {
                await fetchMatchedTrips();
            } catch (error) {
                console.error('Error fetching matched trips:', error);
            } finally {
                loadingManager.updateSubOperation('fetch', 'Displaying Data', 20);
            }
        } catch (error) {
            console.error('Error fetching trips:', error);
            alert('Error fetching trips. Please check the console for details.');
        } finally {
            loadingManager.finish('Fetching and Displaying Trips');
        }
    }

    async function fetchMatchedTrips() {
        const params = getFilterParams();
        const url = `/api/matched_trips?${params.toString()}`;

        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP error fetching matched trips: ${response.status}`);
            }
            const geojson = await response.json();
            mapLayers.matchedTrips.layer = geojson;
        } catch (error) {
            console.error('Error fetching matched trips:', error);
        }
    }

    async function updateMap(fitBounds = false) {
        layerGroup.clearLayers();

        const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
        const visibleLayers = Object.entries(mapLayers)
            .filter(([, layerInfo]) => layerInfo.visible && layerInfo.layer)
            .sort(([, a], [, b]) => a.order - b.order);

        const layerPromises = visibleLayers.map(async ([layerName, layerInfo], index) => {
            const progress = (index / visibleLayers.length) * 100;
            updateLoadingProgress(progress, 'Updating map visualization');

            if (layerName === 'streetCoverage' || layerName === 'customPlaces') {
                layerInfo.layer.addTo(layerGroup);
            } else if (['trips', 'historicalTrips', 'matchedTrips'].includes(layerName)) {
                const geoJsonLayer = L.geoJSON(layerInfo.layer, {
                    style: (feature) => {
                        const isRecent = new Date(feature.properties.startTime) > sixHoursAgo;
                        const highlight = mapSettings.highlightRecentTrips && isRecent;
                        return {
                            color: highlight ? '#FF5722' : layerInfo.color,
                            weight: highlight ? 4 : 2,
                            opacity: highlight ? 0.8 : layerInfo.opacity,
                            className: highlight ? 'recent-trip' : '',
                        };
                    },
                    onEachFeature: (feature, layer) => {
                        const timezone = feature.properties.timezone || 'America/Chicago';
                        const startTime = new Date(feature.properties.startTime);
                        const endTime = new Date(feature.properties.endTime);
                        const formatter = new Intl.DateTimeFormat('en-US', {
                            dateStyle: 'short',
                            timeStyle: 'short',
                            timeZone: timezone,
                            hour12: true,
                        });
                        const isRecent = startTime > sixHoursAgo;
                        const shouldHighlight = mapSettings.highlightRecentTrips && isRecent;

                        const popupContent = `
              <strong>Trip ID:</strong> ${feature.properties.transactionId}<br>
              <strong>Start Time:</strong> ${formatter.format(startTime)}<br>
              <strong>End Time:</strong> ${formatter.format(endTime)}<br>
              <strong>Distance:</strong> ${(+feature.properties.distance).toFixed(2)} miles<br>
              ${shouldHighlight ? '<br><strong>(Recent Trip)</strong>' : ''}
              <button class="btn btn-danger btn-sm mt-2 delete-matched-trip" data-trip-id="${feature.properties.transactionId}">Delete Matched Trip</button>
            `;

                        layer.bindPopup(popupContent).on('popupopen', () => {
                            layer
                                .getPopup()
                                .getElement()
                                .querySelector('.delete-matched-trip')
                                .addEventListener('click', async (e) => {
                                    e.preventDefault();
                                    const tripId = e.target.dataset.tripId;
                                    if (confirm('Delete this matched trip?')) {
                                        try {
                                            const response = await fetch(`/api/matched_trips/${tripId}`, {
                                                method: 'DELETE',
                                            });
                                            if (!response.ok) throw new Error('Failed to delete');
                                            layer.closePopup();
                                            fetchTrips();
                                            alert('Trip deleted');
                                        } catch (error) {
                                            console.error('Error deleting:', error);
                                            alert('Error deleting. Try again.');
                                        }
                                    }
                                });
                        });
                    },
                });
                geoJsonLayer.addTo(layerGroup);
            } else if ((layerName === 'osmBoundary' || layerName === 'osmStreets') && layerInfo.layer) {
                layerInfo.layer
                    .setStyle({
                        color: layerInfo.color,
                        opacity: layerInfo.opacity
                    })
                    .addTo(layerGroup);
            }
        });

        await Promise.all(layerPromises);

        if (fitBounds) {
            const bounds = L.latLngBounds();
            let validBounds = false;
            for (const layerName in mapLayers) {
                const layer = mapLayers[layerName].layer;
                if (mapLayers[layerName].visible && layer) {
                    try {
                        const layerBounds = layer.getBounds ?
                            layer.getBounds() :
                            L.geoJSON(layer).getBounds();
                        if (layerBounds && layerBounds.isValid()) {
                            bounds.extend(layerBounds);
                            validBounds = true;
                        }
                    } catch (e) {
                        /* Ignore invalid bounds */
                    }
                }
            }
            if (validBounds) map.fitBounds(bounds);
        }

        updateLoadingProgress(100, 'Map update complete');
    }



    function initializeLayerControls() {
        const layerToggles = document.getElementById('layer-toggles');
        if (!layerToggles) {
            console.warn("No 'layer-toggles' element.");
            return;
        }
        layerToggles.innerHTML = '';

        for (const [layerName, layerInfo] of Object.entries(mapLayers)) {
            const showControls = !['streetCoverage', 'customPlaces'].includes(layerName);
            const colorPicker = showControls ?
                `<input type="color" id="${layerName}-color" value="${layerInfo.color}">` :
                '';
            const opacitySlider = showControls ?
                `<label for="${layerName}-opacity">Opacity:</label><input type="range" id="${layerName}-opacity" min="0" max="1" step="0.1" value="${layerInfo.opacity}">` :
                '';

            const layerControl = document.createElement('div');
            layerControl.classList.add('layer-control');
            layerControl.dataset.layerName = layerName;
            layerControl.innerHTML = `
        <label class="custom-checkbox">
          <input type="checkbox" id="${layerName}-toggle" ${layerInfo.visible ? 'checked' : ''}>
          <span class="checkmark"></span>
        </label>
        <label for="${layerName}-toggle">${layerInfo.name || layerName}</label>
        ${colorPicker}${opacitySlider}
      `;

            layerToggles.appendChild(layerControl);

            document
                .getElementById(`${layerName}-toggle`)
                .addEventListener('change', (e) => toggleLayer(layerName, e.target.checked));

            if (showControls) {
                document
                    .getElementById(`${layerName}-color`)
                    .addEventListener('change', (e) => changeLayerColor(layerName, e.target.value));
                document
                    .getElementById(`${layerName}-opacity`)
                    .addEventListener('input', (e) => changeLayerOpacity(layerName, +e.target.value));
            }
        }
        updateLayerOrderUI();
    }

    function toggleLayer(layerName, visible) {
        if (mapLayers[layerName]) {
            mapLayers[layerName].visible = visible;
            updateMap();
            updateLayerOrderUI();
        } else {
            console.warn(`Layer "${layerName}" not found.`);
        }
    }

    function changeLayerColor(layerName, color) {
        if (mapLayers[layerName]) {
            mapLayers[layerName].color = color;
            updateMap();
        }
    }

    function changeLayerOpacity(layerName, opacity) {
        if (mapLayers[layerName]) {
            mapLayers[layerName].opacity = opacity;
            updateMap();
        }
    }

    function updateLayerOrderUI() {
        const layerOrder = document.getElementById('layer-order');
        if (!layerOrder) {
            console.warn('Layer order element not found');
            return;
        }
        layerOrder.innerHTML = '<h4 class="h6">Layer Order</h4>';

        const orderedLayers = Object.entries(mapLayers)
            .filter(([, layerInfo]) => layerInfo.visible)
            .sort(([, a], [, b]) => b.order - a.order);

        const ul = document.createElement('ul');
        ul.id = 'layer-order-list';
        ul.classList.add('list-group', 'bg-dark');
        orderedLayers.forEach(([layerName]) => {
            const li = document.createElement('li');
            li.textContent = layerName;
            li.draggable = true;
            li.dataset.layer = layerName;
            li.classList.add('list-group-item', 'bg-dark', 'text-white');
            ul.appendChild(li);
        });
        layerOrder.appendChild(ul);
        initializeDragAndDrop();
    }

    function initializeDragAndDrop() {
        const layerList = document.getElementById('layer-order-list');
        if (!layerList) return;

        let draggedItem = null;

        layerList.addEventListener('dragstart', (e) => {
            draggedItem = e.target;
            e.dataTransfer.effectAllowed = 'move';
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

        layerList.addEventListener('dragend', updateLayerOrder);
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

    async function validateLocation() {
        const locationInput = document.getElementById('location-input');
        const locationTypeInput = document.getElementById('location-type');

        if (!locationInput || !locationTypeInput || !locationInput.value || !locationTypeInput.value) {
            alert('Please enter a location and select a location type.');
            return;
        }

        try {
            const response = await fetch('/api/validate_location', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    location: locationInput.value,
                    locationType: locationTypeInput.value,
                }),
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            if (!data) {
                alert('Location not found. Please check your input.');
                return;
            }

            handleLocationValidationSuccess(data, locationInput);
            alert('Location validated successfully!');
        } catch (error) {
            console.error('Error validating location:', error);
            alert('Error validating location. Please try again.');
        }
    }

    function handleLocationValidationSuccess(data, locationInput) {
        window.validatedLocation = data;
        locationInput.setAttribute('data-location', JSON.stringify(data));
        locationInput.setAttribute(
            'data-display-name',
            data.display_name || data.name || locationInput.value
        );

        // Enable relevant buttons
        document.getElementById('generate-boundary').disabled = false;
        document.getElementById('generate-streets').disabled = false;
        document.getElementById('generate-coverage').disabled = false;

        // Dispatch location validated event
        document.dispatchEvent(new Event('locationValidated'));
    }

    function generateOSMData(streetsOnly) {
        if (!window.validatedLocation) {
            alert('Please validate a location first.');
            return;
        }

        fetch('/api/generate_geojson', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    location: window.validatedLocation,
                    streetsOnly
                }),
            })
            .then((response) => response.json())
            .then((geojson) => {
                if (!geojson || geojson.type !== 'FeatureCollection') {
                    throw new Error('Invalid GeoJSON data');
                }

                const layer = L.geoJSON(geojson, {
                    style: {
                        color: streetsOnly ? mapLayers.osmStreets.color : mapLayers.osmBoundary.color,
                        weight: 2,
                        opacity: 0.7,
                    },
                });

                if (streetsOnly) {
                    mapLayers.osmStreets.layer = layer;
                } else {
                    mapLayers.osmBoundary.layer = layer;
                }

                updateMap();
                updateLayerOrderUI();
            })
            .catch((error) => console.error('Error generating OSM data:', error));
    }

    function initializeEventListeners() {
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

        const mapControlsToggle = document.getElementById('controls-toggle');
        if (mapControlsToggle) {
            mapControlsToggle.addEventListener('click', function() {
                const mapControls = document.getElementById('map-controls');
                const controlsContent = document.getElementById('controls-content');
                mapControls?.classList.toggle('minimized');
                const icon = this.querySelector('i');
                icon?.classList.toggle('fa-chevron-up');
                icon?.classList.toggle('fa-chevron-down');
                controlsContent.style.display = mapControls?.classList.contains('minimized') ?
                    'none' :
                    'block';
            });
        }

        document.getElementById('validate-location')?.addEventListener('click', validateLocation);
        document
            .getElementById('generate-boundary')
            ?.addEventListener('click', () => generateOSMData(false));
        document
            .getElementById('generate-streets')
            ?.addEventListener('click', () => generateOSMData(true));
        document.getElementById('map-match-trips')?.addEventListener('click', mapMatchTrips);
        document
            .getElementById('map-match-historical-trips')
            ?.addEventListener('click', mapMatchHistoricalTrips);
        document.getElementById('load-historical-data')?.addEventListener('click', loadHistoricalData);
        document.getElementById('generate-coverage')?.addEventListener('click', generateStreetCoverage);

        document.querySelectorAll('.date-preset').forEach((button) => {
            button.addEventListener('click', handleDatePresetClick);
        });

        document
            .getElementById('fetch-trips-range')
            ?.addEventListener('click', fetchTripsInRange);

        const highlightToggle = document.getElementById('highlight-recent-trips');
        if (highlightToggle) {
            highlightToggle.addEventListener('change', function() {
                mapSettings.highlightRecentTrips = this.checked;
                updateMap();
            });
        }
    }

    function handleDatePresetClick() {
        const range = this.dataset.range;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        let startDate = new Date(today);
        let endDate = new Date(today);

        if (range === 'all-time') {
            showLoadingOverlay();
            fetch('/api/first_trip_date')
                .then((response) => response.json())
                .then((data) => {
                    startDate = new Date(data.first_trip_date);
                    updateDatePickersAndFetch(startDate, endDate);
                })
                .catch((error) => console.error('Error fetching first trip date:', error))
                .finally(hideLoadingOverlay);
            return;
        }

        switch (range) {
            case 'yesterday':
                startDate.setDate(startDate.getDate() - 1);
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

        updateDatePickersAndFetch(startDate, endDate);
    }

    function updateDatePickersAndFetch(startDate, endDate) {
        const startDatePicker = document.getElementById('start-date')._flatpickr;
        const endDatePicker = document.getElementById('end-date')._flatpickr;
        startDatePicker.setDate(startDate);
        endDatePicker.setDate(endDate);

        localStorage.setItem('startDate', startDate.toISOString().split('T')[0]);
        localStorage.setItem('endDate', endDate.toISOString().split('T')[0]);

        fetchTrips();
        fetchMetrics();
    }

    function fetchMetrics() {
        const startDate = document.getElementById('start-date')?.value;
        const endDate = document.getElementById('end-date')?.value;
        const imei = document.getElementById('imei')?.value || '';

        if (!startDate || !endDate) return;

        fetch(`/api/metrics?start_date=${startDate}&end_date=${endDate}&imei=${imei}`)
            .then((response) => response.json())
            .then((metrics) => {
                const elements = {
                    'total-trips': metrics.total_trips,
                    'total-distance': metrics.total_distance,
                    'avg-distance': metrics.avg_distance,
                    'avg-start-time': metrics.avg_start_time,
                    'avg-driving-time': metrics.avg_driving_time,
                };

                for (const id in elements) {
                    const element = document.getElementById(id);
                    if (element) element.textContent = elements[id];
                }
            })
            .catch((error) => console.error('Error fetching metrics:', error));
    }

    function mapMatchTrips(isHistorical = false) {
        const startDate = document.getElementById('start-date')?.value;
        const endDate = document.getElementById('end-date')?.value;

        if (!startDate || !endDate) {
            alert('Select start and end dates.');
            return;
        }

        showLoadingOverlay('Map matching all trips...');

        const promises = [];

        promises.push(
            fetch('/api/map_match_trips', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    start_date: startDate,
                    end_date: endDate
                }),
            })
        );

        if (isHistorical) {
            promises.push(
                fetch('/api/map_match_historical_trips', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        start_date: startDate,
                        end_date: endDate
                    }),
                })
            );
        }

        Promise.all(promises)
            .then((responses) =>
                Promise.all(
                    responses.map((response) => {
                        if (!response.ok) {
                            throw new Error(`HTTP error! status: ${response.status}`);
                        }
                        return response.json();
                    })
                )
            )
            .then((results) => {
                console.log('Map matching responses:', results);
                alert('Map matching initiated for all selected trips.');
                fetchTrips();
            })
            .catch((error) => {
                console.error('Error map matching trips:', error);
                alert('Error map matching trips. Check console for details.');
            })
            .finally(() => {
                hideLoadingOverlay();
            });
    }

    function mapMatchHistoricalTrips() {
        mapMatchTrips(true);
    }

    function loadHistoricalData() {
        const startDate = document.getElementById('start-date')?.value;
        const endDate = document.getElementById('end-date')?.value;

        if (!startDate || !endDate) {
            alert('Select start and end dates.');
            return;
        }

        showLoadingOverlay();

        fetch('/load_historical_data', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    start_date: startDate,
                    end_date: endDate
                }),
            })
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                return response.json();
            })
            .then((data) => {
                alert(data.message);
                fetchTrips();
            })
            .catch((error) => {
                console.error('Error loading historical data:', error);
                alert('Error loading historical data. Check console.');
            })
            .finally(hideLoadingOverlay);
    }

    function fetchTripsInRange() {
        const startDate = document.getElementById('start-date')?.value;
        const endDate = document.getElementById('end-date')?.value;

        if (!startDate || !endDate) {
            alert('Select start and end dates.');
            return;
        }

        showLoadingOverlay();

        fetch('/api/fetch_trips_range', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    start_date: startDate,
                    end_date: endDate
                }),
            })
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                return response.json();
            })
            .then((data) => {
                if (data.status === 'success') {
                    alert(data.message);
                    fetchTrips();
                } else {
                    console.error(`Error: ${data.message}`);
                    alert('Error fetching trips. Check console.');
                }
            })
            .catch((error) => {
                console.error('Error fetching trips in range:', error);
                alert('Error fetching trips. Check console.');
            })
            .finally(hideLoadingOverlay);
    }

    function visualizeStreetCoverage(coverageData) {
        if (mapLayers.streetCoverage.layer) {
            layerGroup.removeLayer(mapLayers.streetCoverage.layer);
        }

        mapLayers.streetCoverage.layer = L.geoJSON(coverageData.streets_data, {
            style: (feature) => ({
                color: feature.properties.driven ? '#00FF00' : '#FF4444',
                weight: 3,
                opacity: feature.properties.driven ? 0.8 : 0.4,
            }),
            onEachFeature: (feature, layer) => {
                layer.bindPopup(
                    `<strong>${feature.properties.name || 'Unnamed Street'}</strong><br>Status: ${
            feature.properties.driven ? 'Driven' : 'Not driven yet'
          }`
                );
            },
        });

        updateCoverageStats(coverageData);
        updateMap();
    }

    function updateCoverageStats(coverageData) {
        const statsDiv = document.getElementById('coverage-stats');
        const progressBar = document.getElementById('coverage-progress');
        const detailsSpan = document.getElementById('coverage-details');

        if (!statsDiv || !progressBar || !detailsSpan) return;

        statsDiv.classList.remove('d-none');

        const percentage = coverageData.coverage_percentage;
        progressBar.style.width = `${percentage}%`;
        progressBar.setAttribute('aria-valuenow', percentage);

        const totalMiles = (coverageData.total_length * 0.000621371).toFixed(2);
        const drivenMiles = (coverageData.driven_length * 0.000621371).toFixed(2);

        detailsSpan.innerHTML = `${percentage.toFixed(1)}% complete<br>${drivenMiles} / ${totalMiles} miles driven`;
    }

    function generateStreetCoverage() {
        if (!window.validatedLocation) {
            alert('Validate a location first.');
            return;
        }

        const coverageButton = document.getElementById('generate-coverage');
        const originalText = coverageButton.innerHTML;
        coverageButton.disabled = true;
        coverageButton.innerHTML =
            '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Loading...';

        fetch('/api/street_coverage', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    location: window.validatedLocation
                }),
            })
            .then((response) => {
                if (!response.ok) throw new Error('Network response was not ok');
                return response.json();
            })
            .then(visualizeStreetCoverage)
            .catch((error) => {
                console.error('Error generating street coverage:', error);
                alert('Error generating street coverage. Please try again.');
            })
            .finally(() => {
                coverageButton.disabled = false;
                coverageButton.innerHTML = originalText;
            });
    }

    function clearLocalStorage() {
        localStorage.removeItem('startDate');
        localStorage.removeItem('endDate');
        localStorage.removeItem('sidebarCollapsed');
    }

    function initializeSocketIO() {
        if (socket) {
            console.warn('Socket already initialized');
            return;
        }

        try {
            socket = io();

            socket.on('connect', () => console.log('Connected to WebSocket server'));
            socket.on('disconnect', () => console.log('Disconnected from WebSocket server'));
            socket.on('error', (error) => console.error('WebSocket error:', error));
        } catch (error) {
            console.error('Error initializing Socket.IO:', error);
        }
    }

    // Initialize the application
    document.addEventListener('DOMContentLoaded', () => {
        if (isInitialized) {
            console.log('App already initialized, skipping...');
            return;
        }
    
        setInitialDates();
        initializeDatePickers();
        initializeEventListeners();
    
        if (document.getElementById('map') && !document.getElementById('visits-page')) {
            initializeMap();
            if (!map || !layerGroup) {
                console.error('Failed to initialize map components');
                return;
            }
            initializeLayerControls();
    
            const isFirstLoad = localStorage.getItem('isFirstLoad') === 'true';
            if (isFirstLoad) {
                fetchTrips();
                localStorage.removeItem('isFirstLoad');
            }
        }
    
        fetchMetrics();
        initializeSocketIO();
    
        isInitialized = true;
    });
    
})();