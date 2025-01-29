document.addEventListener('DOMContentLoaded', () => {
    const editMap = L.map('editMap').setView([37.0902, -95.7129], 4);
    let tripsLayerGroup = L.featureGroup().addTo(editMap);
    let editableLayers = L.featureGroup().addTo(editMap);
    let currentTrip = null;
    let editMode = false;

    initializeMap();
    initializeControls();
    initializeEventListeners();
    loadTrips();

    /** Initialize Map */
    function initializeMap() {
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 19,
            attribution: ''
        }).addTo(editMap);
    }

    /** Initialize UI Controls */
    function initializeControls() {
        document.getElementById('saveChanges').disabled = true;
        L.control.draw({
            edit: { featureGroup: editableLayers, edit: true, remove: true },
            draw: { marker: true, circlemarker: false, circle: false, rectangle: false, polygon: false, polyline: false }
        }).addTo(editMap);
    }

    /** Set Up Event Listeners */
    function initializeEventListeners() {
        document.getElementById('tripType')?.addEventListener('change', loadTrips);
        document.getElementById('apply-filters')?.addEventListener('click', loadTrips);
        document.getElementById('fetch-trips-range')?.addEventListener('click', loadTrips);
        document.getElementById('editModeToggle')?.addEventListener('change', toggleEditMode);
        document.getElementById('saveChanges')?.addEventListener('click', saveTripChanges);

        editMap.on(L.Draw.Event.CREATED, (e) => addPointToTrip(e.layer.getLatLng()));
        editMap.on(L.Draw.Event.EDITED, (e) => e.layers.eachLayer((layer) => updatePointInTrip(layer.options.pointIndex, layer.getLatLng())));
        editMap.on(L.Draw.Event.DELETED, (e) => e.layers.eachLayer((layer) => removePointFromTrip(layer.options.pointIndex)));
    }

    /** Get Selected Date Range */
    function getDateRange() {
        return {
            startDate: localStorage.getItem('startDate') || document.getElementById('start-date').value,
            endDate: localStorage.getItem('endDate') || document.getElementById('end-date').value
        };
    }

    /** Load Trips Based on Type */
    async function loadTrips() {
        const tripType = document.getElementById('tripType').value;
        const { startDate, endDate } = getDateRange();
        if (!startDate || !endDate) return showNotification('Select a date range.', 'danger');

        try {
            const url = tripType === 'matched_trips'
                ? `/api/matched_trips?start_date=${startDate}&end_date=${endDate}`
                : `/api/trips?start_date=${startDate}&end_date=${endDate}`;

            const response = await fetch(url);
            if (!response.ok) throw new Error('Failed to fetch trips');
            const data = await response.json();

            if (!data.features || !Array.isArray(data.features)) throw new Error('Invalid trip data format');
            displayTrips(data.features);
        } catch (error) {
            console.error('Error loading trips:', error);
            showNotification('Error loading trips. Try again.', 'danger');
        }
    }

    /** Display Trips on Map */
    function displayTrips(trips) {
        tripsLayerGroup.clearLayers();
        editableLayers.clearLayers();
        currentTrip = null;

        const layers = trips.map(trip => {
            if (!trip.geometry?.coordinates) return null;

            const coordinates = trip.geometry.coordinates.map(coord => [coord[1], coord[0]]);
            const color = trip.properties.imei === 'HISTORICAL'
                ? '#CF6679'
                : tripType === 'matched_trips' ? '#FF9800' : '#BB86FC';

            const tripLayer = L.polyline(coordinates, { color, weight: 3, opacity: 0.6 });
            tripLayer.on('click', () => selectTrip(tripLayer, trip));
            tripsLayerGroup.addLayer(tripLayer);
            return tripLayer;
        }).filter(layer => layer);

        if (layers.length) {
            editMap.fitBounds(L.featureGroup(layers).getBounds());
            showNotification(`Loaded ${trips.length} trips.`, 'success');
        } else {
            showNotification('No trips found.', 'warning');
        }
    }

    /** Select a Trip for Editing */
    function selectTrip(layer, tripData) {
        if (currentTrip) resetTripStyle(currentTrip.layer, currentTrip.tripData);

        currentTrip = { layer, tripData };
        highlightTrip(layer);
        updateTripDetails(tripData);

        if (editMode) createEditableMarkers(tripData.geometry.coordinates);
    }

    /** Highlight Selected Trip */
    function highlightTrip(layer) {
        layer.setStyle({ color: '#FFD700', weight: 5, opacity: 1 });
    }

    /** Reset Trip Style */
    function resetTripStyle(layer, tripData) {
        layer.setStyle({
            color: tripData.properties.imei === 'HISTORICAL' ? '#CF6679' : '#BB86FC',
            weight: 3,
            opacity: 0.6
        });
    }

    /** Enable/Disable Edit Mode */
    function toggleEditMode(e) {
        editMode = e.target.checked;
        document.getElementById('saveChanges').disabled = !editMode;

        if (editMode) enableEditing();
        else disableEditing();
    }

    /** Enable Editing (Add Markers) */
    function enableEditing() {
        if (currentTrip) createEditableMarkers(currentTrip.tripData.geometry.coordinates);
    }

    /** Disable Editing */
    function disableEditing() {
        editableLayers.clearLayers();
    }

    /** Create Editable Markers */
    function createEditableMarkers(coordinates) {
        editableLayers.clearLayers();
        coordinates.forEach((coord, index) => {
            const marker = L.marker([coord[1], coord[0]], { draggable: true, pointIndex: index });
            marker.on('dragend', (e) => updatePointInTrip(index, e.target.getLatLng()));
            editableLayers.addLayer(marker);
        });
    }

    /** Add Point to Trip */
    function addPointToTrip(latLng) {
        if (!currentTrip) return;
        const newPoint = [latLng.lng, latLng.lat];
        const coords = currentTrip.tripData.geometry.coordinates;
        coords.splice(coords.length - 1, 0, newPoint);
        updateTripLayer();
    }

    /** Update Point in Trip */
    function updatePointInTrip(index, newLatLng) {
        if (!currentTrip) return;
        currentTrip.tripData.geometry.coordinates[index] = [newLatLng.lng, newLatLng.lat];
        updateTripLayer();
    }

    /** Remove Point from Trip */
    function removePointFromTrip(index) {
        if (!currentTrip || currentTrip.tripData.geometry.coordinates.length <= 2) return;
        currentTrip.tripData.geometry.coordinates.splice(index, 1);
        updateTripLayer();
    }

    /** Update Trip Layer */
    function updateTripLayer() {
        if (!currentTrip) return;
        const coords = currentTrip.tripData.geometry.coordinates.map(coord => [coord[1], coord[0]]);
        currentTrip.layer.setLatLngs(coords);
        createEditableMarkers(currentTrip.tripData.geometry.coordinates);
    }

    /** Save Trip Changes */
    async function saveTripChanges() {
        if (!currentTrip) return showNotification('No trip selected.', 'warning');

        try {
            const tripId = currentTrip.tripData.properties.transactionId;
            const response = await fetch(`/api/trips/${tripId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ geometry: currentTrip.tripData.geometry })
            });

            if (!response.ok) throw new Error('Failed to save changes');
            showNotification('Trip saved successfully!', 'success');
        } catch (error) {
            showNotification('Error saving trip.', 'danger');
        }
    }
});