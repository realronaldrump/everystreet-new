// Self-contained IIFE to prevent global namespace pollution
(() => {
    'use strict';

    /*
     * -------------------------------------------------------------------
     *   MAP LAYER CONFIGURATION
     * -------------------------------------------------------------------
     */
    const mapLayers = {
        trips: {
            order: 1,
            color: '#BB86FC',
            opacity: 0.4,
            visible: true,
            layer: null,
        },
        historicalTrips: {
            order: 2,
            color: '#03DAC6',
            opacity: 0.4,
            visible: false,
            layer: null,
        },
        matchedTrips: {
            order: 3,
            color: '#CF6679',
            opacity: 0.4,
            visible: false,
            layer: null,
        },
        osmBoundary: {
            order: 4,
            color: '#03DAC6',
            opacity: 0.7,
            visible: false,
            layer: null,
        },
        osmStreets: {
            order: 5,
            color: '#FF0266',
            opacity: 0.7,
            visible: false,
            layer: null,
        },
        streetCoverage: {
            order: 6,
            color: '#00FF00',
            opacity: 0.7,
            name: 'Street Coverage',
            visible: false,
            layer: null,
        },
        customPlaces: {
            order: 7,
            color: '#FF9800',
            opacity: 0.5,
            visible: false,
            layer: null,
        },
    };

    /*
     * -------------------------------------------------------------------
     *   GLOBAL APP SETTINGS
     * -------------------------------------------------------------------
     */
    const mapSettings = {
        highlightRecentTrips: true,
    };

    /*
     * -------------------------------------------------------------------
     *   LOADING MANAGER CLASS (Enhanced)
     * -------------------------------------------------------------------
     *  Helps display progress for multi-step or nested processes
     */
    class LoadingManager {
        constructor() {
            this.overlay = document.querySelector('.loading-overlay');
            this.loadingText = document.getElementById('loading-text');
            this.loadingBar = document.getElementById('loading-bar');
            this.operations = {};
            this.totalProgress = 0;
        }

        // Start a named operation with an overall 'total' progress (like 100)
        startOperation(name, total) {
            this.operations[name] = {
                total: total,
                progress: 0,
                subOperations: {},
            };
            this.updateOverallProgress();
            this.showLoadingOverlay(name);
        }

        // Add a sub-operation inside a named operation
        addSubOperation(operationName, subOperationName, total) {
            if (this.operations[operationName]) {
                this.operations[operationName].subOperations[subOperationName] = {
                    total: total,
                    progress: 0,
                };
            }
        }

        // Update a sub-operation's progress
        updateSubOperation(operationName, subOperationName, progress) {
            const operation = this.operations[operationName];
            if (operation?.subOperations[subOperationName]) {
                operation.subOperations[subOperationName].progress = progress;
                this.updateOperationProgress(operationName);
            }
        }

        // Recompute the parent operation's total progress based on sub-ops
        updateOperationProgress(operationName) {
            const operation = this.operations[operationName];
            if (operation) {
                // Weighted sum of subOp progress
                const subOpProgress = Object.values(operation.subOperations).reduce(
                    (acc, subOp) =>
                        acc +
                        (subOp.progress / subOp.total) * (subOp.total / operation.total),
                    0
                );
                operation.progress = subOpProgress * operation.total;
                this.updateOverallProgress();
            }
        }

        // Recompute overall progress across all operations
        updateOverallProgress() {
            this.totalProgress = Object.values(this.operations).reduce(
                (acc, op) => acc + op.progress / 100,
                0
            );
            const totalOperations = Object.keys(this.operations).length;
            const overallPercentage = (this.totalProgress / totalOperations) * 100;
            this.updateLoadingProgress(overallPercentage);
        }

        // Finish and remove an operation
        finish(operationName) {
            if (operationName) {
                delete this.operations[operationName];
            } else {
                this.operations = {};
            }
            this.updateOverallProgress();
            if (Object.keys(this.operations).length === 0) {
                this.hideLoadingOverlay();
            }
        }

        // Display a user-friendly error message
        error(operationName, message) {
            console.error(`Error in ${operationName}:`, message);
            if (this.loadingText) {
                this.loadingText.textContent = `Error: ${message}`;
                this.loadingText.style.color = 'red';
            }
            // Optionally, add a button to retry the operation or dismiss the error
        }

        // Show loading overlay with a specific message
        showLoadingOverlay(message = 'Loading') {
            if (this.overlay) {
                this.overlay.style.display = 'flex';
                this.loadingText.textContent = `${message}: 0%`;
                this.loadingBar.style.width = '0%';
                this.loadingBar.setAttribute('aria-valuenow', '0');
            }
        }

        // Update loading progress with an optional message
        updateLoadingProgress(percentage, message) {
            if (this.loadingText && this.loadingBar) {
                const currentMsg = message || this.loadingText.textContent.split(':')[0];
                this.loadingText.textContent = `${currentMsg}: ${Math.round(percentage)}%`;
                this.loadingBar.style.width = `${percentage}%`;
                this.loadingBar.setAttribute('aria-valuenow', percentage);
            }
        }

        // Hide the loading overlay after a short delay
        hideLoadingOverlay() {
            if (this.overlay) {
                setTimeout(() => {
                    this.overlay.style.display = 'none';
                    this.loadingText.style.color = null; // Reset text color
                }, 500);
            }
        }
    }

    /*
     * -------------------------------------------------------------------
     *   CREATE A SINGLETON LOADING MANAGER
     * -------------------------------------------------------------------
     */
    const loadingManager = new LoadingManager();

    /*
     * -------------------------------------------------------------------
     *   MAP MANAGER CLASS
     * -------------------------------------------------------------------
     */
    class MapManager {
        constructor() {
            this.map = null;
            this.layerGroup = null;
            this.mapInitialized = false;
            this.liveTracker = null;
            this.trackedTripId = null; // Variable to track the currently tracked trip ID

            this.initializeMap();
            this.initializeLayerControls();
        }

        /*
         * -------------------------------------------------------------------
         *   MAP INITIALIZATION
         * -------------------------------------------------------------------
         */
        initializeMap() {
            if (this.mapInitialized || !document.getElementById('map')) return;

            try {
                this.map = L.map('map', {
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
                }).addTo(this.map);

                this.layerGroup = L.layerGroup().addTo(this.map);

                mapLayers.customPlaces.layer = L.layerGroup();

                this.initializeLiveTracking();

                this.centerMapOnLastTrip();
            } catch (error) {
                console.error('Error initializing map:', error);
                loadingManager.error('initializeMap', 'Failed to initialize the map.');
            }
        }

        /*
         * -------------------------------------------------------------------
         *   LIVE TRACKING INITIALIZATION
         * -------------------------------------------------------------------
         */
        initializeLiveTracking() {
            if (!window.liveTracker) {
                try {
                    window.liveTracker = new LiveTripTracker(this.map);
                } catch (error) {
                    console.error('Error initializing live tracking:', error);
                    loadingManager.error('initializeLiveTracking', 'Failed to initialize live tracking.');
                }
            }
        }

        /*
         * -------------------------------------------------------------------
         *   CENTER MAP ON LAST TRIP
         * -------------------------------------------------------------------
         */
        async centerMapOnLastTrip() {
            try {
                const response = await fetch('/api/last_trip_point');
                if (!response.ok) {
                    throw new Error('Failed to fetch last trip point');
                }

                const data = await response.json();
                const lastPoint = data.lastPoint;
                if (lastPoint) {
                    this.map.flyTo([lastPoint[1], lastPoint[0]], 11, {
                        duration: 2,
                        easeLinearity: 0.25,
                    });
                } else {
                    this.map.setView([31.55002, -97.123354], 14); // Default view
                }
                this.mapInitialized = true;
            } catch (error) {
                console.error('Error centering map on last trip:', error);
                this.map.setView([37.0902, -95.7129], 4); // Fallback view
                this.mapInitialized = true;
            }
        }

        /*
         * -------------------------------------------------------------------
         *   LAYER CONTROL INITIALIZATION
         * -------------------------------------------------------------------
         */
        initializeLayerControls() {
            const layerToggles = document.getElementById('layer-toggles');
            if (!layerToggles) {
                console.warn("No 'layer-toggles' element found.");
                return;
            }
            layerToggles.innerHTML = '';

            for (const [layerName, layerInfo] of Object.entries(mapLayers)) {
                const showControls = !['streetCoverage', 'customPlaces'].includes(layerName);
                const colorPicker = showControls
                    ? `<input type="color" id="${layerName}-color" value="${layerInfo.color}">`
                    : '';
                const opacitySlider = showControls
                    ? `<label for="${layerName}-opacity">Opacity:</label>
                       <input type="range" id="${layerName}-opacity" min="0" max="1" step="0.1" value="${layerInfo.opacity}">`
                    : '';

                const layerDiv = document.createElement('div');
                layerDiv.classList.add('layer-control');
                layerDiv.dataset.layerName = layerName;
                layerDiv.innerHTML = `
                    <label class="custom-checkbox">
                      <input type="checkbox" id="${layerName}-toggle" ${layerInfo.visible ? 'checked' : ''}>
                      <span class="checkmark"></span>
                    </label>
                    <label for="${layerName}-toggle">${layerInfo.name || layerName}</label>
                    ${colorPicker}
                    ${opacitySlider}
                `;

                layerToggles.appendChild(layerDiv);

                document.getElementById(`${layerName}-toggle`)
                    ?.addEventListener('change', (e) => this.toggleLayer(layerName, e.target.checked));

                if (showControls) {
                    document.getElementById(`${layerName}-color`)
                      ?.addEventListener('change', (e) => this.changeLayerColor(layerName, e.target.value));
                    document.getElementById(`${layerName}-opacity`)
                      ?.addEventListener('input', (e) => this.changeLayerOpacity(layerName, parseFloat(e.target.value)));
                }
            }

            this.updateLayerOrderUI();
        }

        toggleLayer(layerName, visible) {
            if (mapLayers[layerName]) {
                mapLayers[layerName].visible = visible;
                this.updateMap();
                this.updateLayerOrderUI();
            } else {
                console.warn(`Layer "${layerName}" not found in mapLayers.`);
            }
        }

        changeLayerColor(layerName, color) {
            if (mapLayers[layerName]) {
                mapLayers[layerName].color = color;
                this.updateMap();
            }
        }

        changeLayerOpacity(layerName, opacity) {
            if (mapLayers[layerName]) {
                mapLayers[layerName].opacity = opacity;
                this.updateMap();
            }
        }

        /*
         * -------------------------------------------------------------------
         *   LAYER ORDER UI
         * -------------------------------------------------------------------
         */
        updateLayerOrderUI() {
            const layerOrder = document.getElementById('layer-order');
            if (!layerOrder) {
                console.warn('layer-order element not found.');
                return;
            }
            layerOrder.innerHTML = '<h4 class="h6">Layer Order</h4>';

            const orderedLayers = Object.entries(mapLayers)
                .filter(([, v]) => v.visible)
                .sort(([, a], [, b]) => b.order - a.order);

            const ul = document.createElement('ul');
            ul.id = 'layer-order-list';
            ul.classList.add('list-group', 'bg-dark');

            orderedLayers.forEach(([lname]) => {
                const li = document.createElement('li');
                li.textContent = lname;
                li.draggable = true;
                li.dataset.layer = lname;
                li.classList.add('list-group-item', 'bg-dark', 'text-white');
                ul.appendChild(li);
            });

            layerOrder.appendChild(ul);
            this.initializeDragAndDrop();
        }

        initializeDragAndDrop() {
            const list = document.getElementById('layer-order-list');
            if (!list) return;

            let draggedItem = null;
            list.addEventListener('dragstart', (e) => {
                draggedItem = e.target;
                e.dataTransfer.effectAllowed = 'move';
            });
            list.addEventListener('dragover', (e) => {
                e.preventDefault();
                const target = e.target.closest('li');
                if (target && target !== draggedItem) {
                    const rect = target.getBoundingClientRect();
                    const next = (e.clientY - rect.top) / (rect.bottom - rect.top) > 0.5;
                    list.insertBefore(draggedItem, next ? target.nextSibling : target);
                }
            });
            list.addEventListener('dragend', () => this.updateLayerOrder());
        }

        updateLayerOrder() {
            const list = document.getElementById('layer-order-list');
            if (!list) return;

            const items = Array.from(list.querySelectorAll('li'));
            const total = items.length;
            items.forEach((item, index) => {
                const lname = item.dataset.layer;
                mapLayers[lname].order = total - index;
            });

            this.updateMap();
        }

        /*
         * -------------------------------------------------------------------
         *   UPDATE MAP
         * -------------------------------------------------------------------
         */
        async updateMap(fitBounds = false) {
            if (!this.layerGroup) return;
            this.layerGroup.clearLayers();

            const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;

            const visibleLayers = Object.entries(mapLayers)
                .filter(([, info]) => info.visible && info.layer)
                .sort(([, a], [, b]) => a.order - b.order);

            const layerPromises = visibleLayers.map(async ([layerName, layerInfo], index) => {
                const progress = (index / visibleLayers.length) * 100;
                loadingManager.updateLoadingProgress(progress, 'Updating map visualization');

                if (layerName === 'streetCoverage' || layerName === 'customPlaces') {
                    layerInfo.layer.addTo(this.layerGroup);
                } else if (['trips', 'historicalTrips', 'matchedTrips'].includes(layerName)) {
                    const geoJsonLayer = L.geoJSON(layerInfo.layer, {
                        style: (feature) => {
                            const start = new Date(feature.properties.startTime).getTime();
                            const highlight = mapSettings.highlightRecentTrips && start > sixHoursAgo;
                            return {
                                color: highlight ? '#FF5722' : layerInfo.color,
                                weight: highlight ? 4 : 2,
                                opacity: highlight ? 0.8 : layerInfo.opacity,
                                className: highlight ? 'recent-trip' : '',
                            };
                        },
                        onEachFeature: (feature, lyr) => {
                            const timezone = feature.properties.timezone || 'America/Chicago';
                            const startTime = new Date(feature.properties.startTime);
                            const endTime = new Date(feature.properties.endTime);

                            const formatter = new Intl.DateTimeFormat('en-US', {
                                dateStyle: 'short',
                                timeStyle: 'short',
                                timeZone: timezone,
                                hour12: true,
                            });

                            const isRecent = startTime.getTime() > sixHoursAgo;
                            const shouldHighlight = mapSettings.highlightRecentTrips && isRecent;
                            const popupContent = `
                              <strong>Trip ID:</strong> ${feature.properties.transactionId}<br>
                              <strong>Start Time:</strong> ${formatter.format(startTime)}<br>
                              <strong>End Time:</strong> ${formatter.format(endTime)}<br>
                              <strong>Distance:</strong> ${(+feature.properties.distance).toFixed(2)} miles<br>
                              ${shouldHighlight ? '<br><strong>(Recent Trip)</strong>' : ''}
                              <button class="btn btn-danger btn-sm mt-2 delete-matched-trip" data-trip-id="${
                                  feature.properties.transactionId
                              }">
                                Delete Matched Trip
                              </button>
                            `;

                            lyr.bindPopup(popupContent).on('popupopen', () => {
                                const deleteBtn = lyr
                                    .getPopup()
                                    .getElement()
                                    .querySelector('.delete-matched-trip');
                                deleteBtn?.addEventListener('click', async (e) => {
                                    e.preventDefault();
                                    const tid = e.target.dataset.tripId;
                                    if (confirm('Delete this matched trip?')) {
                                        try {
                                            const res = await fetch(`/api/matched_trips/${tid}`, {
                                                method: 'DELETE',
                                            });
                                            if (!res.ok) throw new Error('Failed to delete');
                                            lyr.closePopup();
                                            // Assuming fetchTrips is adapted to use MapManager's context
                                            fetchTrips.call(MapManager); 
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
                    geoJsonLayer.addTo(this.layerGroup);
                } else if (
                    (layerName === 'osmBoundary' || layerName === 'osmStreets') &&
                    layerInfo.layer
                ) {
                    layerInfo.layer
                        .setStyle({
                            color: layerInfo.color,
                            opacity: layerInfo.opacity,
                        })
                        .addTo(this.layerGroup);
                }
            });

            await Promise.all(layerPromises);

            if (fitBounds) {
                const bounds = L.latLngBounds();
                let validBounds = false;
                for (const [lname, linfo] of Object.entries(mapLayers)) {
                    if (linfo.visible && linfo.layer) {
                        try {
                            const b =
                                typeof linfo.layer.getBounds === 'function'
                                    ? linfo.layer.getBounds()
                                    : L.geoJSON(linfo.layer).getBounds();
                            if (b?.isValid()) {
                                bounds.extend(b);
                                validBounds = true;
                            }
                        } catch (e) {
                            // skip
                        }
                    }
                }
                if (validBounds) this.map.fitBounds(bounds);
            }

            loadingManager.updateLoadingProgress(100, 'Map update complete');
        }
    }

    /*
     * -------------------------------------------------------------------
     *   DATE PICKER MANAGER CLASS
     * -------------------------------------------------------------------
     */
    class DatePickerManager {
        constructor() {
            this.startDateInput = document.getElementById('start-date');
            this.endDateInput = document.getElementById('end-date');
            this.initializeDatePickers();
        }

        initializeDatePickers() {
            this.setInitialDates();
            const commonConfig = {
                dateFormat: 'Y-m-d',
                maxDate: new Date(),
                enableTime: false,
                static: true,
            };

            if (this.startDateInput) {
                flatpickr('#start-date', commonConfig);
            }
            if (this.endDateInput) {
                flatpickr('#end-date', commonConfig);
            }
        }

        setInitialDates() {
            const today = new Date().toISOString().split('T')[0];
            if (!localStorage.getItem('startDate')) localStorage.setItem('startDate', today);
            if (!localStorage.getItem('endDate')) localStorage.setItem('endDate', today);

            if (this.startDateInput) this.startDateInput.value = localStorage.getItem('startDate');
            if (this.endDateInput) this.endDateInput.value = localStorage.getItem('endDate');

            localStorage.setItem('isFirstLoad', 'true');
        }

        getFilterParams() {
            const startDate = this.startDateInput?.value;
            const endDate = this.endDateInput?.value;
            return new URLSearchParams({ start_date: startDate, end_date: endDate });
        }
    }

    /*
     * -------------------------------------------------------------------
     *   TRIP FETCHER CLASS
     * -------------------------------------------------------------------
     */
    class TripFetcher {
        constructor(mapManager, datePickerManager) {
            this.mapManager = mapManager;
            this.datePickerManager = datePickerManager;
        }

        async fetchTrips() {
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

                this.datePickerManager.startDateInput.value = startDate;
                this.datePickerManager.endDateInput.value = endDate;

                loadingManager.updateSubOperation('fetch', 'Fetching Data', 25);

                const params = this.datePickerManager.getFilterParams();
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
                            destination: trip.properties.destinationPlaceId
                                ? trip.properties.destination
                                : trip.properties.destination || 'N/A',
                            startLocation: trip.properties.startPlaceId
                                ? trip.properties.startLocation
                                : trip.properties.startLocation || 'N/A',
                            isCustomPlace: !!(
                                trip.properties.startPlaceId || trip.properties.destinationPlaceId
                            ),
                            distance: (+trip.properties.distance).toFixed(2),
                        }));

                    await new Promise((resolve) => {
                        window.tripsTable.clear().rows.add(formattedTrips).draw();
                        setTimeout(resolve, 100);
                    });
                }

                if (this.mapManager.map && this.mapManager.layerGroup) {
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
                    await this.mapManager.updateMap();
                }

                loadingManager.updateSubOperation('fetch', 'Processing Data', 30);
                loadingManager.updateSubOperation('fetch', 'Displaying Data', 10);

                try {
                    await this.fetchMatchedTrips();
                } catch (err) {
                    console.error('Error fetching matched trips:', err);
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

        async fetchMatchedTrips() {
            const params = this.datePickerManager.getFilterParams();
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
                loadingManager.error('fetchMatchedTrips', 'Failed to fetch matched trips.');
            }
        }
    }

    /*
     * -------------------------------------------------------------------
     *   OSM DATA MANAGER CLASS
     * -------------------------------------------------------------------
     */
    class OSMDataManager {
        constructor(mapManager) {
            this.mapManager = mapManager;
            this.validatedLocation = null;
        }

        // Validate a location using the /api/validate_location endpoint
        async validateLocation() {
            const locInput = document.getElementById('location-input');
            const locType = document.getElementById('location-type');
            if (!locInput || !locType || !locInput.value || !locType.value) {
                alert('Please enter a location and select a location type.');
                return;
            }

            try {
                const res = await fetch('/api/validate_location', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        location: locInput.value,
                        locationType: locType.value,
                    }),
                });
                if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);

                const data = await res.json();
                if (!data) {
                    alert('Location not found. Please check your input.');
                    return;
                }
                this.handleLocationValidationSuccess(data, locInput);
                alert('Location validated successfully!');
            } catch (err) {
                console.error('Error validating location:', err);
                loadingManager.error('validateLocation', 'Failed to validate location.');
            }
        }

        // Handle successful location validation
        handleLocationValidationSuccess(data, locInput) {
            this.validatedLocation = data;
            locInput.setAttribute('data-location', JSON.stringify(data));
            locInput.setAttribute('data-display-name', data.display_name || data.name || locInput.value);

            // Enable relevant buttons
            document.getElementById('generate-boundary').disabled = false;
            document.getElementById('generate-streets').disabled = false;
            document.getElementById('generate-coverage').disabled = false;
        }

        // Generate OSM data (streets or boundary) based on the validated location
        generateOSMData(streetsOnly) {
            if (!this.validatedLocation) {
                alert('Please validate a location first.');
                return;
            }

            fetch('/api/generate_geojson', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    location: this.validatedLocation,
                    streetsOnly,
                }),
            })
                .then((res) => {
                    if (!res.ok) {
                        return res.json().then((errData) => {
                            throw new Error(errData.error || 'Unknown error generating OSM data');
                        });
                    }
                    return res.json();
                })
                .then((geojson) => {
                    if (!geojson || geojson.type !== 'FeatureCollection') {
                        throw new Error('Invalid GeoJSON data from Overpass');
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

                    this.mapManager.updateMap();
                    this.mapManager.updateLayerOrderUI();
                })
                .catch((err) => {
                    console.error('Error generating OSM data:', err);
                    loadingManager.error('generateOSMData', 'Failed to generate OSM data.');
                });
        }
    }

    /*
     * -------------------------------------------------------------------
     *   EVENT HANDLER MANAGER CLASS
     * -------------------------------------------------------------------
     */
    class EventHandlerManager {
        constructor(mapManager, datePickerManager, tripFetcher, osmDataManager) {
            this.mapManager = mapManager;
            this.datePickerManager = datePickerManager;
            this.tripFetcher = tripFetcher;
            this.osmDataManager = osmDataManager;
            this.initializeEventListeners();
        }

        initializeEventListeners() {
            // Apply filters
            this.setupEventListener('apply-filters', 'click', this.handleApplyFilters);

            // Toggle map controls
            this.setupEventListener('controls-toggle', 'click', this.handleControlsToggle);

            // Validate location
            this.setupEventListener('validate-location', 'click', this.osmDataManager.validateLocation.bind(this.osmDataManager));

            // Generate OSM data
            this.setupEventListener('generate-boundary', 'click', () => this.osmDataManager.generateOSMData(false));
            this.setupEventListener('generate-streets', 'click', () => this.osmDataManager.generateOSMData(true));

            // Map matching
            this.setupEventListener('map-match-trips', 'click', () => this.mapMatchTrips(false));
            this.setupEventListener('map-match-historical-trips', 'click', () => this.mapMatchTrips(true));

            // Street coverage
            this.setupEventListener('generate-coverage', 'click', this.generateStreetCoverage);

            // Date preset buttons
            document.querySelectorAll('.date-preset').forEach((btn) => {
                btn.addEventListener('click', this.handleDatePresetClick.bind(this));
            });

            // Fetch trips in range
            this.setupEventListener('fetch-trips-range', 'click', this.fetchTripsInRange);

            // Highlight recent trips
            this.setupEventListener('highlight-recent-trips', 'change', this.handleHighlightRecentTrips);

            // Preprocess streets
            this.setupEventListener('preprocess-streets', 'click', this.preprocessStreets);
        }

        setupEventListener(elementId, eventType, handler) {
            const element = document.getElementById(elementId);
            if (element) {
                element.addEventListener(eventType, handler.bind(this));
            }
        }

        handleApplyFilters() {
            const sd = this.datePickerManager.startDateInput.value;
            const ed = this.datePickerManager.endDateInput.value;
            localStorage.setItem('startDate', sd);
            localStorage.setItem('endDate', ed);
            this.tripFetcher.fetchTrips();
            this.fetchMetrics(); // Assuming you have a method to fetch metrics
        }

        handleControlsToggle() {
            const mapControls = document.getElementById('map-controls');
            const controlsContent = document.getElementById('controls-content');
            mapControls?.classList.toggle('minimized');
            const icon = this.querySelector('i');
            icon?.classList.toggle('fa-chevron-up');
            icon?.classList.toggle('fa-chevron-down');
            controlsContent.style.display = mapControls?.classList.contains('minimized') ? 'none' : 'block';
        }

        async handleDatePresetClick(event) {
            const range = event.target.dataset.range;
            const today = new Date();
            today.setHours(0, 0, 0, 0);
        
            let startDate = new Date(today);
            let endDate = new Date(today);
        
            if (range === 'all-time') {
                loadingManager.startOperation('Fetching First Trip Date');
                try {
                    const response = await fetch('/api/first_trip_date');
                    if (!response.ok) {
                        throw new Error('Failed to fetch first trip date');
                    }
                    const data = await response.json();
                    startDate = new Date(data.first_trip_date);
                } catch (error) {
                    console.error('Error fetching first trip date:', error);
                    loadingManager.error('handleDatePresetClick', 'Failed to fetch first trip date.');
                } finally {
                    loadingManager.finish('Fetching First Trip Date');
                }
            } else {
                switch (range) {
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
            }
        
            this.updateDatePickersAndFetch(startDate, endDate);
        }

        updateDatePickersAndFetch(startDate, endDate) {
            this.datePickerManager.startDateInput.value = startDate.toISOString().split('T')[0];
            this.datePickerManager.endDateInput.value = endDate.toISOString().split('T')[0];

            localStorage.setItem('startDate', startDate.toISOString().split('T')[0]);
            localStorage.setItem('endDate', endDate.toISOString().split('T')[0]);

            this.tripFetcher.fetchTrips();
            this.fetchMetrics();
        }

        handleHighlightRecentTrips(event) {
            mapSettings.highlightRecentTrips = event.target.checked;
            this.mapManager.updateMap();
        }

        fetchMetrics() {
            const sd = this.datePickerManager.startDateInput?.value;
            const ed = this.datePickerManager.endDateInput?.value;
            const imei = document.getElementById('imei')?.value || '';

            if (!sd || !ed) return;

            fetch(`/api/metrics?start_date=${sd}&end_date=${ed}&imei=${imei}`)
                .then((r) => r.json())
                .then((metrics) => {
                    const mapList = {
                        'total-trips': metrics.total_trips,
                        'total-distance': metrics.total_distance,
                        'avg-distance': metrics.avg_distance,
                        'avg-start-time': metrics.avg_start_time,
                        'avg-driving-time': metrics.avg_driving_time,
                        'avg-speed': `${metrics.avg_speed} mph`,
                        'max-speed': `${metrics.max_speed} mph`,
                    };
                    for (const id in mapList) {
                        const el = document.getElementById(id);
                        if (el) el.textContent = mapList[id];
                    }
                })
                .catch((err) => {
                    console.error('Error fetching metrics:', err);
                    loadingManager.error('fetchMetrics', 'Failed to fetch metrics.');
                });
        }

        async mapMatchTrips(isHistorical = false) {
            const sd = this.datePickerManager.startDateInput?.value;
            const ed = this.datePickerManager.endDateInput?.value;
            if (!sd || !ed) {
                alert('Select start and end dates.');
                return;
            }

            loadingManager.startOperation('Map Matching Trips');

            const endpoints = ['/api/map_match_trips'];
            if (isHistorical) {
                endpoints.push('/api/map_match_historical_trips');
            }

            const tasks = endpoints.map((endpoint) =>
                fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ start_date: sd, end_date: ed }),
                })
            );

            try {
                const responses = await Promise.all(tasks);
                const results = await Promise.all(
                    responses.map((r) => {
                        if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
                        return r.json();
                    })
                );
                console.log('Map matching responses:', results);
                alert(
                    `Map matching completed for ${isHistorical ? 'historical and regular' : 'regular'} trips.`
                );
                await this.tripFetcher.fetchTrips();
            } catch (error) {
                console.error('Error map matching trips:', error);
                loadingManager.error('mapMatchTrips', 'Failed to map match trips.');
            } finally {
                loadingManager.finish('Map Matching Trips');
            }
        }

        async generateStreetCoverage() {
            loadingManager.startOperation('Generating Street Coverage');

            if (!this.osmDataManager.validatedLocation) {
                alert('Validate a location first.');
                loadingManager.finish('Generating Street Coverage');
                return;
            }

            const coverageBtn = document.getElementById('generate-coverage');
            const originalText = coverageBtn.innerHTML;
            coverageBtn.disabled = true;
            coverageBtn.innerHTML =
                '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Loading...';

            try {
                const response = await fetch('/api/street_coverage', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        location: this.osmDataManager.validatedLocation,
                    }),
                });

                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.message || 'Failed to generate street coverage');
                }

                const coverageData = await response.json();
                this.visualizeStreetCoverage(coverageData);
            } catch (error) {
                console.error('Error generating street coverage:', error);
                loadingManager.error('generateStreetCoverage', 'Failed to generate street coverage.');
            } finally {
                coverageBtn.disabled = false;
                coverageBtn.innerHTML = originalText;
                loadingManager.finish('Generating Street Coverage');
            }
        }

        visualizeStreetCoverage(coverageData) {
            if (mapLayers.streetCoverage.layer) {
                this.mapManager.layerGroup.removeLayer(mapLayers.streetCoverage.layer);
                mapLayers.streetCoverage.layer = null;
            }

            mapLayers.streetCoverage.layer = L.geoJSON(coverageData.streets_data, {
                style: (feature) => ({
                    color: feature.properties.driven ? '#00FF00' : '#FF4444',
                    weight: 3,
                    opacity: feature.properties.driven ? 0.8 : 0.4,
                }),
                onEachFeature: (feature, layer) => {
                    layer.on('click', () => {
                        this.fetchSegmentDetails(feature.properties.segment_id);
                    });
                },
            });

            mapLayers.streetCoverage.layer.addTo(this.mapManager.layerGroup);

            this.mapManager.updateLayerOrderUI();
            this.mapManager.updateMap();

            this.updateCoverageStats(coverageData);
        }

        fetchSegmentDetails(segmentId) {
            fetch(`/api/street_segment/${segmentId}`)
                .then((response) => {
                    if (!response.ok) {
                        throw new Error('Segment not found');
                    }
                    return response.json();
                })
                .then((segmentData) => {
                    const properties = segmentData.properties;
                    const popupContent = `
                        <strong>${properties.street_name || 'Unnamed Street'}</strong><br>
                        Segment ID: ${properties.segment_id}<br>
                        Status: ${properties.driven ? 'Driven' : 'Not driven'}<br>
                        Last Updated: ${
                            properties.last_updated
                                ? new Date(properties.last_updated).toLocaleString()
                                : 'N/A'
                        }<br>
                        Length: ${properties.length.toFixed(2)} meters<br>
                        Part of Street: ${properties.street_id}
                    `;

                    mapLayers.streetCoverage.layer.eachLayer((layer) => {
                        if (layer.feature.properties.segment_id === segmentId) {
                            layer.bindPopup(popupContent).openPopup();
                        }
                    });
                })
                .catch((error) => {
                    console.error('Error fetching segment details:', error);
                    loadingManager.error('fetchSegmentDetails', 'Failed to fetch segment details.');
                });
        }

        updateCoverageStats(coverageData) {
            const statsDiv = document.getElementById('coverage-stats');
            const progressBar = document.getElementById('coverage-progress');
            const coveragePercentageSpan = document.getElementById('coverage-percentage');
            const totalStreetLengthSpan = document.getElementById('total-street-length');
            const milesDrivenSpan = document.getElementById('miles-driven');

            if (!statsDiv || !progressBar || !coveragePercentageSpan || !totalStreetLengthSpan || !milesDrivenSpan) {
                console.error('One or more coverage stats elements not found!');
                return;
            }

            statsDiv.classList.remove('d-none');
            const percent = coverageData.coverage_percentage;
            const totalLengthMiles = coverageData.streets_data.metadata.total_length_miles;
            const drivenLengthMiles = coverageData.streets_data.metadata.driven_length_miles;

            progressBar.style.width = `${percent}%`;
            progressBar.setAttribute('aria-valuenow', percent);
            coveragePercentageSpan.textContent = percent.toFixed(1);
            totalStreetLengthSpan.textContent = totalLengthMiles.toFixed(2);
            milesDrivenSpan.textContent = drivenLengthMiles.toFixed(2);
        }

        async fetchTripsInRange() {
            const sd = this.datePickerManager.startDateInput?.value;
            const ed = this.datePickerManager.endDateInput?.value;
            if (!sd || !ed) {
                alert('Select start and end dates.');
                return;
            }
            loadingManager.startOperation('Fetching Trips in Range');
        
            try {
                const response = await fetch('/api/fetch_trips_range', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ start_date: sd, end_date: ed }),
                });
        
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
        
                const data = await response.json();
                if (data.status === 'success') {
                    alert(data.message);
                    await this.tripFetcher.fetchTrips();
                } else {
                    console.error(`Error: ${data.message}`);
                    alert('Error fetching trips. Check console.');
                }
            } catch (error) {
                console.error('Error fetching trips in range:', error);
                loadingManager.error('fetchTripsInRange', 'Failed to fetch trips in range.');
            } finally {
                loadingManager.finish('Fetching Trips in Range');
            }
        }
        

        async preprocessStreets() {
            const location = document.getElementById('location-input').value;
            const locationType = document.getElementById('location-type').value;
        
            if (!location) {
                alert('Please enter and validate a location first.');
                return;
            }
            loadingManager.startOperation('Preprocessing Streets');
        
            try {
                const response = await fetch('/api/preprocess_streets', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        location: location,
                        location_type: locationType,
                    }),
                });
        
                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.message || 'Failed to preprocess streets');
                }
        
                const data = await response.json();
                if (data.status === 'success') {
                    alert(data.message);
                } else {
                    alert(`Error: ${data.message}`);
                }
            } catch (error) {
                console.error('Error preprocessing streets:', error);
                loadingManager.error('preprocessStreets', 'Failed to preprocess streets.');
            } finally {
                loadingManager.finish('Preprocessing Streets');
            }
        }
    }

    /*
     * -------------------------------------------------------------------
     *   INITIALIZATION
     * -------------------------------------------------------------------
     */
    document.addEventListener('DOMContentLoaded', () => {
        const mapManager = new MapManager();
        const datePickerManager = new DatePickerManager();
        const tripFetcher = new TripFetcher(mapManager, datePickerManager);
        const osmDataManager = new OSMDataManager(mapManager);
        const eventHandlerManager = new EventHandlerManager(
            mapManager,
            datePickerManager,
            tripFetcher,
            osmDataManager
        );

        // Initial fetch of trips on DOMContentLoaded
        tripFetcher.fetchTrips();

        // Also fetch metrics
        eventHandlerManager.fetchMetrics();
    });
})();