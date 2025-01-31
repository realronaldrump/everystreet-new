document.addEventListener('DOMContentLoaded', () => {
    // Globals for map, layers, etc.
    let editMap, tripsLayerGroup, editableLayers;
    let currentTrip = null;
    let editMode = false;

    /**
     * Main entry point
     */
    function init() {
        initializeMap();
        initializeControls();
        initializeEventListeners();
        loadTrips();
    }

    /**
     * Initialize Leaflet Map
     */
    function initializeMap() {
        // Create the map
        editMap = L.map('editMap').setView([37.0902, -95.7129], 4);

        // Add base layer
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 19,
            attribution: ''
        }).addTo(editMap);

        // Groups for displaying trips & editable markers
        tripsLayerGroup = L.featureGroup().addTo(editMap);
        editableLayers = L.featureGroup().addTo(editMap);
    }

    /**
     * Initialize Leaflet Draw controls
     * (Requires Leaflet Draw to be included in HTML)
     */
    function initializeControls() {
        // Make sure Leaflet Draw is available
        if (typeof L.Control.Draw !== 'function') {
            console.error('Leaflet Draw plugin is not loaded. Please include Leaflet.draw.js.');
            return;
        }

        // Add the Leaflet Draw control
        const drawControl = new L.Control.Draw({
            edit: {
                featureGroup: editableLayers,
                edit: true,
                remove: true
            },
            draw: {
                marker: true,
                circlemarker: false,
                circle: false,
                rectangle: false,
                polygon: false,
                polyline: false
            }
        });

        editMap.addControl(drawControl);
    }

    /**
     * Set up event listeners for map & UI
     */
    function initializeEventListeners() {
        // Toggle Edit Mode
        const editModeToggle = document.getElementById('editModeToggle');
        if (editModeToggle) {
            editModeToggle.addEventListener('change', toggleEditMode);
        }

        // Save Changes
        const saveChangesBtn = document.getElementById('saveChanges');
        if (saveChangesBtn) {
            saveChangesBtn.addEventListener('click', saveTripChanges);
            saveChangesBtn.disabled = true; // disabled until Edit Mode is on
        }

        // Respond to Leaflet Draw events
        editMap.on(L.Draw.Event.CREATED, onDrawCreated);
        editMap.on(L.Draw.Event.EDITED, onDrawEdited);
        editMap.on(L.Draw.Event.DELETED, onDrawDeleted);
    }

    /**
     * Toggle Edit Mode
     */
    function toggleEditMode(e) {
        editMode = e.target.checked;
        document.getElementById('saveChanges').disabled = !editMode;

        if (editMode) {
            // If there's a currently selected trip, create markers
            if (currentTrip) {
                createEditableMarkers(currentTrip.tripData.geometry.coordinates);
            }
        } else {
            // Disable editing, remove markers
            editableLayers.clearLayers();
        }
    }

    /**
     * When user finishes drawing a new marker
     */
    function onDrawCreated(e) {
        // For this example, we only handle markers in the draws
        if (!editMode || !currentTrip) return;

        const newMarker = e.layer;   // L.Marker
        const latLng = newMarker.getLatLng();
        addPointToTrip(latLng);
    }

    /**
     * When user finishes editing marker positions
     */
    function onDrawEdited(e) {
        if (!editMode || !currentTrip) return;

        e.layers.eachLayer((layer) => {
            const index = layer.options.pointIndex;
            updatePointInTrip(index, layer.getLatLng());
        });
    }

    /**
     * When user deletes marker(s)
     */
    function onDrawDeleted(e) {
        if (!editMode || !currentTrip) return;

        e.layers.eachLayer((layer) => {
            const index = layer.options.pointIndex;
            removePointFromTrip(index);
        });
    }

    /**
     * Load Trips from server
     */
    async function loadTrips() {
        // Example: fetch from /api/edit_trips or a custom endpoint
        try {
            const startDate = localStorage.getItem('startDate') || document.getElementById('start-date').value;
            const endDate = localStorage.getItem('endDate') || document.getElementById('end-date').value;
            const tripType = document.getElementById('tripType').value;

            const res = await fetch(`/api/trips?start_date=${startDate}&end_date=${endDate}&type=${tripType}`);
            if (!res.ok) throw new Error('Failed to fetch trips');

            const data = await res.json();
            if (data.status === 'error') {
                console.error('Error fetching trips:', data.message);
                return;
            }

            displayTripsOnMap(data.trips || []);
        } catch (error) {
            console.error('Error loading trips:', error);
        }
    }

    /**
     * Display the trips on the map
     */
    function displayTripsOnMap(trips) {
        // Clear existing layers
        tripsLayerGroup.clearLayers();
        editableLayers.clearLayers();
        currentTrip = null;

        const layers = trips.map((trip) => {
            const gps = trip.gps || trip.geometry;
            if (!gps || gps.type !== 'LineString' || !gps.coordinates?.length) {
                return null; // skip invalid data
            }

            const coordsLatLng = gps.coordinates.map(([lon, lat]) => [lat, lon]);
            const poly = L.polyline(coordsLatLng, {
                color: (trip.imei === 'HISTORICAL') ? '#CF6679' : '#BB86FC',
                weight: 3,
                opacity: 0.6
            });

            // On click, select trip for editing
            poly.on('click', () => selectTrip(poly, trip));
            tripsLayerGroup.addLayer(poly);
            return poly;
        }).filter(Boolean);

        // Zoom to fit
        if (layers.length > 0) {
            const group = L.featureGroup(layers);
            editMap.fitBounds(group.getBounds());
        }
    }

    /**
     * Select a trip for editing
     */
    function selectTrip(layer, tripData) {
        // Reset old selection style
        if (currentTrip && currentTrip.layer) {
            resetTripStyle(currentTrip.layer, currentTrip.tripData);
        }

        currentTrip = { layer, tripData };

        // Highlight
        layer.setStyle({ color: '#FFD700', weight: 5, opacity: 1 });

        // If in edit mode, create markers
        if (editMode) {
            createEditableMarkers(tripData.gps.coordinates);
        }
    }

    /**
     * Reset trip style to default
     */
    function resetTripStyle(layer, tripData) {
        layer.setStyle({
            color: tripData.imei === 'HISTORICAL' ? '#CF6679' : '#BB86FC',
            weight: 3,
            opacity: 0.6
        });
    }

    /**
     * Create editable markers for the selected trip’s coordinates
     */
    function createEditableMarkers(coordinates) {
        editableLayers.clearLayers();

        coordinates.forEach(([lon, lat], index) => {
            const marker = L.marker([lat, lon], {
                draggable: true,
                pointIndex: index // custom property
            });
            marker.on('dragend', (e) => {
                const newLatLng = e.target.getLatLng();
                updatePointInTrip(index, newLatLng);
            });

            editableLayers.addLayer(marker);
        });
    }

    /**
     * Add a new point (marker) to the current trip
     */
    function addPointToTrip(latLng) {
        if (!currentTrip) return;
        const coords = currentTrip.tripData.gps.coordinates;
        // Insert before last or just push
        coords.push([latLng.lng, latLng.lat]);
        updateTripPolyline();
        createEditableMarkers(coords);
    }

    /**
     * Update existing point
     */
    function updatePointInTrip(index, latLng) {
        if (!currentTrip) return;
        currentTrip.tripData.gps.coordinates[index] = [latLng.lng, latLng.lat];
        updateTripPolyline();
        createEditableMarkers(currentTrip.tripData.gps.coordinates);
    }

    /**
     * Remove a point from the trip
     */
    function removePointFromTrip(index) {
        if (!currentTrip) return;
        const coords = currentTrip.tripData.gps.coordinates;
        if (coords.length > index) {
            coords.splice(index, 1);
        }
        updateTripPolyline();
        createEditableMarkers(coords);
    }

    /**
     * Update the polyline on the map to match current trip data
     */
    function updateTripPolyline() {
        if (!currentTrip) return;
        const coords = currentTrip.tripData.gps.coordinates;
        const latLngs = coords.map(([lon, lat]) => [lat, lon]);
        currentTrip.layer.setLatLngs(latLngs);
    }

    /**
     * Save changes for the current trip
     */
    async function saveTripChanges() {
        if (!currentTrip) {
            alert('No trip selected to save.');
            return;
        }
        try {
            // Example: PUT or POST to your API
            const tripId = currentTrip.tripData.transactionId;
            const res = await fetch(`/api/trips/${tripId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    geometry: currentTrip.tripData.gps,
                    properties: currentTrip.tripData
                })
            });
            if (!res.ok) {
                throw new Error(`Failed to save trip changes: ${res.status}`);
            }
            alert('Trip changes saved successfully.');
        } catch (error) {
            console.error('Error saving trip:', error);
            alert(`Error saving trip: ${error.message}`);
        }
    }

    // Start everything
    init();
});