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
            layer: null
        },
        historicalTrips: {
            order: 2,
            color: '#03DAC6',
            opacity: 0.4,
            visible: false,
            layer: null
        },
        matchedTrips: {
            order: 3,
            color: '#CF6679',
            opacity: 0.4,
            visible: false,
            layer: null
        },
        osmBoundary: {
            order: 4,
            color: '#03DAC6',
            opacity: 0.7,
            visible: false,
            layer: null
        },
        osmStreets: {
            order: 5,
            color: '#FF0266',
            opacity: 0.7,
            visible: false,
            layer: null
        },
        streetCoverage: {
            order: 6,
            color: '#00FF00',
            opacity: 0.7,
            name: 'Street Coverage',
            visible: false,
            layer: null
        },
        customPlaces: {
            order: 7,
            color: '#FF9800',
            opacity: 0.5,
            visible: false,
            layer: null
        },
    };

    /*
     * -------------------------------------------------------------------
     *   GLOBAL APP SETTINGS
     * -------------------------------------------------------------------
     */
    const mapSettings = {
        highlightRecentTrips: true
    };

    /*
     * -------------------------------------------------------------------
     *   GLOBAL VARIABLES
     * -------------------------------------------------------------------
     */
    let map,
        layerGroup,
        liveTracker,       // assigned if live tracking is active
        isInitialized = false,
        mapInitialized = false;

    /*
     * -------------------------------------------------------------------
     *   LOADING OVERLAY ELEMENTS
     * -------------------------------------------------------------------
     */
    const loadingOverlay = document.querySelector('.loading-overlay');
    const loadingText = document.getElementById('loading-text');
    const loadingBar = document.getElementById('loading-bar');

    /*
     * -------------------------------------------------------------------
     *   LOADING MANAGER CLASS
     * -------------------------------------------------------------------
     *  Helps display progress for multi-step or nested processes
     */
    class LoadingManager {
        constructor() {
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
            showLoadingOverlay(name);  // show the loading UI
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
                        acc + (subOp.progress / subOp.total) * (subOp.total / operation.total),
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
            updateLoadingProgress(overallPercentage);
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
                hideLoadingOverlay();  // hide if no more ops
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
     *   BASIC OVERLAY FUNCTIONS
     * -------------------------------------------------------------------
     */
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
            const currentMsg = message || loadingText.textContent.split(':')[0];
            loadingText.textContent = `${currentMsg}: ${Math.round(percentage)}%`;
            loadingBar.style.width = `${percentage}%`;
            loadingBar.setAttribute('aria-valuenow', percentage);
        }
    }
    function hideLoadingOverlay() {
        if (loadingOverlay) {
            setTimeout(() => {
                loadingOverlay.style.display = 'none';
            }, 500);
        }
    }

    /*
     * -------------------------------------------------------------------
     *   MAP INITIALIZATION
     * -------------------------------------------------------------------
     */
    function initializeMap() {
        // Already inited or no map container -> skip
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

            // Create a layer group reference for custom places
            mapLayers.customPlaces.layer = L.layerGroup();

            // Try to init live trip tracker if available
            if (!window.liveTracker) {
                try {
                    window.liveTracker = new LiveTripTracker(map);
                    console.log("Live Tracker initialized");
                } catch (error) {
                    console.error('Error initializing live tracking:', error);
                }
            }

            // Attempt to center map on last trip point
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

        } catch (error) {
            console.error('Error initializing map:', error);
        }
    }

    /*
     * -------------------------------------------------------------------
     *   DATE PICKER INITIALIZATION
     * -------------------------------------------------------------------
     */
    function setInitialDates() {
        const today = new Date().toISOString().split('T')[0];
        if (!localStorage.getItem('startDate')) localStorage.setItem('startDate', today);
        if (!localStorage.getItem('endDate')) localStorage.setItem('endDate', today);

        const startDateInput = document.getElementById('start-date');
        const endDateInput = document.getElementById('end-date');
        if (startDateInput) startDateInput.value = localStorage.getItem('startDate');
        if (endDateInput) endDateInput.value = localStorage.getItem('endDate');

        // Indicate first load
        localStorage.setItem('isFirstLoad', 'true');
    }

    function initializeDatePickers() {
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1);
        const commonConfig = {
            dateFormat: 'Y-m-d',
            maxDate: tomorrow,
            enableTime: false,
            static: true,
            onChange: () => {},
            onClose: () => {},
        };
        // If these elements exist, apply
        if (document.getElementById('start-date')) {
            flatpickr('#start-date', commonConfig);
        }
        if (document.getElementById('end-date')) {
            flatpickr('#end-date', commonConfig);
        }
    }

    /*
     * -------------------------------------------------------------------
     *   GET FILTER PARAMS
     * -------------------------------------------------------------------
     */
    function getFilterParams() {
        const startDate = document.getElementById('start-date')?.value;
        const endDate = document.getElementById('end-date')?.value;
        return new URLSearchParams({ start_date: startDate, end_date: endDate });
    }

    /*
     * -------------------------------------------------------------------
     *   FETCH TRIPS
     * -------------------------------------------------------------------
     */
    async function fetchTrips() {
        // Start the "Fetching and Displaying Trips" operation
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

            // Sync our date inputs
            document.getElementById('start-date').value = startDate;
            document.getElementById('end-date').value = endDate;

            // Update subOp
            loadingManager.updateSubOperation('fetch', 'Fetching Data', 25);

            const params = getFilterParams();
            const response = await fetch(`/api/trips?${params.toString()}`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const geojson = await response.json();

            loadingManager.updateSubOperation('fetch', 'Fetching Data', 50);
            loadingManager.updateSubOperation('fetch', 'Processing Data', 15);

            // If we have a tripsTable, update it
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
                        isCustomPlace: !!(trip.properties.startPlaceId || trip.properties.destinationPlaceId),
                        distance: (+trip.properties.distance).toFixed(2),
                    }));

                await new Promise((resolve) => {
                    window.tripsTable.clear().rows.add(formattedTrips).draw();
                    setTimeout(resolve, 100);
                });
            }

            // If there's a map, store the data in mapLayers and update
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

            // More progress updates
            loadingManager.updateSubOperation('fetch', 'Processing Data', 30);
            loadingManager.updateSubOperation('fetch', 'Displaying Data', 10);

            // Attempt fetching matched trips too
            try {
                await fetchMatchedTrips();
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

    /*
     * -------------------------------------------------------------------
     *   FETCH MATCHED TRIPS
     * -------------------------------------------------------------------
     */
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

    /*
     * -------------------------------------------------------------------
     *   UPDATE MAP
     * -------------------------------------------------------------------
     */
    async function updateMap(fitBounds = false) {
        if (!layerGroup) return;
        layerGroup.clearLayers();

        const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;

        // Gather visible layers in ascending order
        const visibleLayers = Object.entries(mapLayers)
            .filter(([, info]) => info.visible && info.layer)
            .sort(([, a], [, b]) => a.order - b.order);

        // We'll track asynchronous ops so we can await them
        const layerPromises = visibleLayers.map(async ([layerName, layerInfo], index) => {
            // Some progress update
            const progress = (index / visibleLayers.length) * 100;
            updateLoadingProgress(progress, 'Updating map visualization');

            if (layerName === 'streetCoverage' || layerName === 'customPlaces') {
                // If these are layerGroups or geoJSON
                layerInfo.layer.addTo(layerGroup);

            } else if (['trips','historicalTrips','matchedTrips'].includes(layerName)) {
                // We'll create a Leaflet GeoJSON from the data
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
                          <button class="btn btn-danger btn-sm mt-2 delete-matched-trip" data-trip-id="${feature.properties.transactionId}">
                            Delete Matched Trip
                          </button>
                        `;

                        lyr.bindPopup(popupContent).on('popupopen', () => {
                            const deleteBtn = lyr.getPopup().getElement().querySelector('.delete-matched-trip');
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
                                        fetchTrips();
                                        alert('Trip deleted');
                                    } catch (error) {
                                        console.error('Error deleting:', error);
                                        alert('Error deleting. Try again.');
                                    }
                                }
                            });
                        });
                    }
                });
                geoJsonLayer.addTo(layerGroup);

            } else if ((layerName === 'osmBoundary' || layerName === 'osmStreets') && layerInfo.layer) {
                // If we stored them as a Leaflet layer
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
            for (const [lname, linfo] of Object.entries(mapLayers)) {
                if (linfo.visible && linfo.layer) {
                    try {
                        const b = (typeof linfo.layer.getBounds === 'function')
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
            if (validBounds) map.fitBounds(bounds);
        }

        updateLoadingProgress(100, 'Map update complete');
    }

    /*
     * -------------------------------------------------------------------
     *   LAYER CONTROL INITIALIZATION
     * -------------------------------------------------------------------
     */
    function initializeLayerControls() {
        const layerToggles = document.getElementById('layer-toggles');
        if (!layerToggles) {
            console.warn("No 'layer-toggles' element found.");
            return;
        }
        layerToggles.innerHTML = '';

        for (const [layerName, layerInfo] of Object.entries(mapLayers)) {
            // We'll skip the color/opacity controls for certain layers
            const showControls = !['streetCoverage','customPlaces'].includes(layerName);
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

            // Toggle
            document.getElementById(`${layerName}-toggle`)
                ?.addEventListener('change', (e) => toggleLayer(layerName, e.target.checked));

            // Color
            if (showControls) {
                document.getElementById(`${layerName}-color`)
                  ?.addEventListener('change', (e) => changeLayerColor(layerName, e.target.value));
                document.getElementById(`${layerName}-opacity`)
                  ?.addEventListener('input', (e) => changeLayerOpacity(layerName, parseFloat(e.target.value)));
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
            console.warn(`Layer "${layerName}" not found in mapLayers.`);
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

    /*
     * -------------------------------------------------------------------
     *   LAYER ORDER UI
     * -------------------------------------------------------------------
     */
    function updateLayerOrderUI() {
        const layerOrder = document.getElementById('layer-order');
        if (!layerOrder) {
            console.warn('layer-order element not found.');
            return;
        }
        layerOrder.innerHTML = '<h4 class="h6">Layer Order</h4>';

        // Sort visible layers desc by order
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
            li.classList.add('list-group-item','bg-dark','text-white');
            ul.appendChild(li);
        });

        layerOrder.appendChild(ul);
        initializeDragAndDrop();
    }

    function initializeDragAndDrop() {
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
        list.addEventListener('dragend', updateLayerOrder);
    }

    function updateLayerOrder() {
        const list = document.getElementById('layer-order-list');
        if (!list) return;

        const items = Array.from(list.querySelectorAll('li'));
        const total = items.length;
        items.forEach((item, index) => {
            const lname = item.dataset.layer;
            mapLayers[lname].order = total - index;
        });

        updateMap();
    }

    /*
     * -------------------------------------------------------------------
     *   VALIDATE LOCATION  (Nominatim, etc.)
     * -------------------------------------------------------------------
     */
    async function validateLocation() {
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
            handleLocationValidationSuccess(data, locInput);
            alert('Location validated successfully!');
        } catch (err) {
            console.error('Error validating location:', err);
            alert('Error validating location. Please try again.');
        }
    }

    function handleLocationValidationSuccess(data, locInput) {
        window.validatedLocation = data;
        locInput.setAttribute('data-location', JSON.stringify(data));
        locInput.setAttribute('data-display-name', data.display_name || data.name || locInput.value);

        // Enable relevant buttons
        document.getElementById('generate-boundary').disabled = false;
        document.getElementById('generate-streets').disabled = false;
        document.getElementById('generate-coverage').disabled = false;

        // Trigger event if needed
        document.dispatchEvent(new Event('locationValidated'));
    }

    /*
     * -------------------------------------------------------------------
     *   GENERATE OSM DATA
     * -------------------------------------------------------------------
     */
    function generateOSMData(streetsOnly) {
        if (!window.validatedLocation) {
            alert('Please validate a location first.');
            return;
        }
    
        fetch('/api/generate_geojson', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                location: window.validatedLocation,
                streetsOnly,
            }),
        })
        .then((res) => {
            if (!res.ok) {
                // Handle HTTP errors (e.g., 400, 500)
                return res.json().then(errData => {
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
                    opacity: 0.7
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
        .catch((err) => {
            console.error('Error generating OSM data:', err);
            alert(err.message); // Display error to the user
        });
    }

    /*
     * -------------------------------------------------------------------
     *   MAIN EVENT LISTENERS
     * -------------------------------------------------------------------
     */
    function initializeEventListeners() {
        const applyFiltersBtn = document.getElementById('apply-filters');
        if (applyFiltersBtn && !applyFiltersBtn.hasListener) {
            applyFiltersBtn.hasListener = true;
            applyFiltersBtn.addEventListener('click', () => {
                const sd = document.getElementById('start-date').value;
                const ed = document.getElementById('end-date').value;
                localStorage.setItem('startDate', sd);
                localStorage.setItem('endDate', ed);
                fetchTrips();
                fetchMetrics();
            });
        }

        const controlsToggle = document.getElementById('controls-toggle');
        if (controlsToggle) {
            controlsToggle.addEventListener('click', function() {
                const mapControls = document.getElementById('map-controls');
                const controlsContent = document.getElementById('controls-content');
                mapControls?.classList.toggle('minimized');
                const icon = this.querySelector('i');
                icon?.classList.toggle('fa-chevron-up');
                icon?.classList.toggle('fa-chevron-down');
                controlsContent.style.display = mapControls?.classList.contains('minimized') ? 'none' : 'block';
            });
        }

        // Validate location
        document.getElementById('validate-location')
          ?.addEventListener('click', validateLocation);

        // Generate
        document.getElementById('generate-boundary')
          ?.addEventListener('click', () => generateOSMData(false));
        document.getElementById('generate-streets')
          ?.addEventListener('click', () => generateOSMData(true));

        // Map match
        document.getElementById('map-match-trips')
          ?.addEventListener('click', () => mapMatchTrips(false));
        document.getElementById('map-match-historical-trips')
          ?.addEventListener('click', () => mapMatchTrips(true));

        // Coverage
        document.getElementById('generate-coverage')
          ?.addEventListener('click', generateStreetCoverage);

        // Date preset
        document.querySelectorAll('.date-preset').forEach((btn) => {
            btn.addEventListener('click', handleDatePresetClick);
        });

        // Fetch trips range
        document.getElementById('fetch-trips-range')
          ?.addEventListener('click', fetchTripsInRange);

        // Toggle highlight recent trips
        const highlightRecent = document.getElementById('highlight-recent-trips');
        if (highlightRecent) {
            highlightRecent.addEventListener('change', function() {
                mapSettings.highlightRecentTrips = this.checked;
                updateMap();
            });
        }

        // Preprocess streets
        document.getElementById('preprocess-streets')?.addEventListener('click', preprocessStreets);
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
                .then((r) => r.json())
                .then((d) => {
                    startDate = new Date(d.first_trip_date);
                    updateDatePickersAndFetch(startDate, endDate);
                })
                .catch((err) => console.error('Error fetching first trip date:', err))
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
        // We expect date pickers to be flatpickr or input type=date
        const startFP = document.getElementById('start-date')._flatpickr;
        const endFP = document.getElementById('end-date')._flatpickr;
        if (startFP && endFP) {
            startFP.setDate(startDate);
            endFP.setDate(endDate);
        }

        localStorage.setItem('startDate', startDate.toISOString().split('T')[0]);
        localStorage.setItem('endDate', endDate.toISOString().split('T')[0]);

        fetchTrips();
        fetchMetrics();
    }

    /*
     * -------------------------------------------------------------------
     *   FETCH METRICS
     * -------------------------------------------------------------------
     */
    function fetchMetrics() {
        const sd = document.getElementById('start-date')?.value;
        const ed = document.getElementById('end-date')?.value;
        const imei = document.getElementById('imei')?.value || '';

        if (!sd || !ed) return;

        fetch(`/api/metrics?start_date=${sd}&end_date=${ed}&imei=${imei}`)
            .then((r) => r.json())
            .then((metrics) => {
                // Update your metrics elements
                const mapList = {
                    'total-trips': metrics.total_trips,
                    'total-distance': metrics.total_distance,
                    'avg-distance': metrics.avg_distance,
                    'avg-start-time': metrics.avg_start_time,
                    'avg-driving-time': metrics.avg_driving_time,
                    'avg-speed': `${metrics.avg_speed} mph`,
                    'max-speed': `${metrics.max_speed} mph`
                };
                for (const id in mapList) {
                    const el = document.getElementById(id);
                    if (el) el.textContent = mapList[id];
                }
            })
            .catch((err) => console.error('Error fetching metrics:', err));
    }

    /*
     * -------------------------------------------------------------------
     *   MAP MATCHING
     * -------------------------------------------------------------------
     */
    function mapMatchTrips(isHistorical = false) {
        const sd = document.getElementById('start-date')?.value;
        const ed = document.getElementById('end-date')?.value;
        if (!sd || !ed) {
            alert('Select start and end dates.');
            return;
        }

        showLoadingOverlay('Map matching all trips...');

        const tasks = [];
        // Normal trips
        tasks.push(
            fetch('/api/map_match_trips', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ start_date: sd, end_date: ed })
            })
        );
        // Historical too if needed
        if (isHistorical) {
            tasks.push(
                fetch('/api/map_match_historical_trips', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ start_date: sd, end_date: ed })
                })
            );
        }

        Promise.all(tasks)
          .then((responses) => Promise.all(responses.map((r) => {
              if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
              return r.json();
          })))
          .then((results) => {
              console.log('Map matching responses:', results);
              alert('Map matching completed selected trips.');
              fetchTrips();
          })
          .catch((err) => {
              console.error('Error map matching trips:', err);
              alert('Error map matching trips. Check console.');
          })
          .finally(hideLoadingOverlay);
    }

    function mapMatchHistoricalTrips() {
        mapMatchTrips(true);
    }

    /*
     * -------------------------------------------------------------------
     *   HISTORICAL DATA
     * -------------------------------------------------------------------
     */
    function loadHistoricalData() {
        const sd = document.getElementById('start-date')?.value;
        const ed = document.getElementById('end-date')?.value;
        if (!sd || !ed) {
            alert('Select start and end dates.');
            return;
        }
        showLoadingOverlay();

        fetch('/load_historical_data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ start_date: sd, end_date: ed })
        })
        .then((r) => {
            if (!r.ok) throw new Error(`HTTP error: ${r.status}`);
            return r.json();
        })
        .then((data) => {
            alert(data.message);
            fetchTrips();
        })
        .catch((err) => {
            console.error('Error loading historical data:', err);
            alert('Error loading historical data. Check console.');
        })
        .finally(hideLoadingOverlay);
    }

    function fetchTripsInRange() {
        const sd = document.getElementById('start-date')?.value;
        const ed = document.getElementById('end-date')?.value;
        if (!sd || !ed) {
            alert('Select start and end dates.');
            return;
        }
        showLoadingOverlay();

        fetch('/api/fetch_trips_range', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ start_date: sd, end_date: ed })
        })
        .then((r) => {
            if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
            return r.json();
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
        .catch((err) => {
            console.error('Error fetching trips in range:', err);
            alert('Error fetching trips. Check console.');
        })
        .finally(hideLoadingOverlay);
    }

    /*
     * -------------------------------------------------------------------
     *   STREET COVERAGE
     * -------------------------------------------------------------------
     */
    async function generateStreetCoverage() {
        // Start the loading operation
        loadingManager.startOperation('Generating Street Coverage');
    
        if (!window.validatedLocation) {
            alert('Validate a location first.');
            loadingManager.finish('Generating Street Coverage');
            return;
        }
    
        const coverageBtn = document.getElementById('generate-coverage');
        const originalText = coverageBtn.innerHTML;
        coverageBtn.disabled = true;
        coverageBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Loading...';
    
        try {
            const response = await fetch('/api/street_coverage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    location: window.validatedLocation
                })
            });
    
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || 'Failed to generate street coverage');
            }
    
            const coverageData = await response.json();
            visualizeStreetCoverage(coverageData);
        } catch (error) {
            console.error('Error generating street coverage:', error);
            alert(error.message || 'An error occurred while generating street coverage.');
        } finally {
            coverageBtn.disabled = false;
            coverageBtn.innerHTML = originalText;
            loadingManager.finish('Generating Street Coverage');
        }
    }
    
    function visualizeStreetCoverage(coverageData) {
        if (mapLayers.streetCoverage.layer) {
            layerGroup.removeLayer(mapLayers.streetCoverage.layer);
            mapLayers.streetCoverage.layer = null;
        }
    
        mapLayers.streetCoverage.layer = L.geoJSON(coverageData.streets_data, {
            style: (feature) => ({
                color: feature.properties.driven ? '#00FF00' : '#FF4444',
                weight: 3,
                opacity: feature.properties.driven ? 0.8 : 0.4
            }),
            onEachFeature: (feature, layer) => {
                layer.on('click', () => {
                    fetchSegmentDetails(feature.properties.segment_id);
                });
            }
        });
    
        // Add the layer to the layer group
        mapLayers.streetCoverage.layer.addTo(layerGroup);
    
        // Update the layer order UI and the map
        updateLayerOrderUI();
        updateMap();
    
        updateCoverageStats(coverageData);
    }

    function fetchSegmentDetails(segmentId) {
        fetch(`/api/street_segment/${segmentId}`)
            .then(response => {
                if (!response.ok) {
                    throw new Error('Segment not found');
                }
                return response.json();
            })
            .then(segmentData => {
                const properties = segmentData.properties;
                const popupContent = `
                    <strong>${properties.street_name || 'Unnamed Street'}</strong><br>
                    Segment ID: ${properties.segment_id}<br>
                    Status: ${properties.driven ? 'Driven' : 'Not driven'}<br>
                    Last Updated: ${properties.last_updated ? new Date(properties.last_updated).toLocaleString() : 'N/A'}<br>
                    Length: ${properties.length.toFixed(2)} meters<br>
                    Part of Street: ${properties.street_id}
                `;
    
                // Find the clicked segment's layer and open the popup
                mapLayers.streetCoverage.layer.eachLayer(layer => {
                    if (layer.feature.properties.segment_id === segmentId) {
                        layer.bindPopup(popupContent).openPopup();
                    }
                });
            })
            .catch(error => {
                console.error('Error fetching segment details:', error);
                alert('Error fetching segment details. Please try again.');
            });
    }
    
    function updateCoverageStats(coverageData) {
        const statsDiv = document.getElementById('coverage-stats');
        const progressBar = document.getElementById('coverage-progress');
        const coveragePercentageSpan = document.getElementById('coverage-percentage');
        const totalStreetLengthSpan = document.getElementById('total-street-length');
        const milesDrivenSpan = document.getElementById('miles-driven');
        if (!statsDiv || !progressBar || !coveragePercentageSpan || !totalStreetLengthSpan || !milesDrivenSpan) {
            console.error("One or more coverage stats elements not found!");
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

    function preprocessStreets() {
        const location = document.getElementById('location-input').value;
        const locationType = document.getElementById('location-type').value;
    
        if (!location) {
            alert('Please enter and validate a location first.');
            return;
        }
    
        fetch('/api/preprocess_streets', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                location: location,
                location_type: locationType
            })
        })
        .then(response => response.json())
        .then(data => {
            if (data.status === 'success') {
                alert(data.message);
            } else {
                alert(`Error: ${data.message}`);
            }
        })
        .catch(error => {
            console.error('Error preprocessing streets:', error);
            alert('Error preprocessing streets. Please check the console for details.');
        });
    }

    /*
     * -------------------------------------------------------------------
     *   OPTIONAL CLEAR LOCAL STORAGE
     * -------------------------------------------------------------------
     */
    function clearLocalStorage() {
        localStorage.removeItem('startDate');
        localStorage.removeItem('endDate');
        localStorage.removeItem('sidebarCollapsed');
    }

    /*
     * -------------------------------------------------------------------
     *   APP INITIALIZATION
     * -------------------------------------------------------------------
     */
    document.addEventListener('DOMContentLoaded', () => {
        if (isInitialized) {
            console.log('App already initialized, skipping...');
            return;
        }

        setInitialDates();
        initializeDatePickers();
        initializeEventListeners();

        // If we have a #map and not on the visits page
        if (document.getElementById('map') && !document.getElementById('visits-page')) {
            initializeMap();
            if (!map || !layerGroup) {
                console.error('Failed to initialize map components');
                return;
            }
            initializeLayerControls();

            // On first load, fetch trips once
            const isFirstLoad = localStorage.getItem('isFirstLoad') === 'true';
            if (isFirstLoad) {
                fetchTrips();
                localStorage.removeItem('isFirstLoad');
            }
        }

        // Also fetch metrics
        fetchMetrics();

        isInitialized = true;
    });
    
})(); // End of IIFE