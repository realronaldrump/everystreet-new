class TripEditor {
    constructor() {
        this.map = null;
        this.selectedTrip = null;
        this.editMode = 'regular'; // Start in regular trip edit mode
        this.tripLayer = null;
        this.pointMarkers = [];
        this.selectedPoint = null;
        this.undoStack = [];
        this.modified = false;
        this.showPoints = false;

        this.editControls = {
            addPoint: document.getElementById('add-point'),
            deletePoint: document.getElementById('delete-point'),
            undo: document.getElementById('undo'),
            saveChanges: document.getElementById('save-changes'),
            discardChanges: document.getElementById('discard-changes'),
            showPoints: document.getElementById('show-points'),
            editModeSelect: document.getElementById('edit-mode')
        };

        this.initializeMap();
        this.setupEventListeners();
        this.loadTrips(); // Load initial trips on page load
    }

    initializeMap() {
        this.map = L.map('map', {
            center: [37.0902, -95.7129], // Centered on US
            zoom: 4
        });

        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '©OpenStreetMap, ©CartoDB',
            maxZoom: 19
        }).addTo(this.map);

        this.tripLayer = L.layerGroup().addTo(this.map);
    }

    setupEventListeners() {
        // Edit mode change
        this.editControls.editModeSelect.addEventListener('change', (e) => {
            this.editMode = e.target.value;
            this.loadTrips(); // Reload trips when edit mode changes
            this.clearSelection(); // Clear any existing selection
        });

        this.editControls.addPoint.addEventListener('click', () => {
            this.map.getContainer().classList.add('add-point-mode');
            this.map.once('click', (e) => {
                this.addNewPoint(e.latlng);
                this.map.getContainer().classList.remove('add-point-mode');
            });
        });

        this.editControls.deletePoint.addEventListener('click', () => this.deleteSelectedPoint());
        this.editControls.undo.addEventListener('click', () => this.undoLastAction());
        this.editControls.saveChanges.addEventListener('click', () => this.saveChanges());
        this.editControls.discardChanges.addEventListener('click', () => this.discardChanges());
        this.editControls.showPoints.addEventListener('change', (e) => {
            this.showPoints = e.target.checked;
            this.showTripPoints(); // Redraw points to reflect visibility/editability change
        });

        document.getElementById('apply-filters').addEventListener('click', () => {
            this.loadTrips();
            this.clearSelection(); // Clear selection when filters are applied
        });
    }

    async loadTrips() {
        const startDate = document.getElementById('start-date').value;
        const endDate = document.getElementById('end-date').value;

        if (!startDate || !endDate) {
            return; // Don't fetch if dates are not selected
        }

        const endpoint = this.editMode === 'regular' ? '/api/trips' : '/api/matched_trips';
        const params = new URLSearchParams({ start_date: startDate, end_date: endDate });

        try {
            const response = await fetch(`${endpoint}?${params}`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            this.displayTrips(data);
        } catch (error) {
            console.error('Error loading trips:', error);
            alert('Error loading trips. Please try again.');
        }
    }

    displayTrips(geojson) {
        this.tripLayer.clearLayers();

        if (!geojson || !geojson.features || geojson.features.length === 0) {
            console.warn('No trips to display');
            return;
        }

        L.geoJSON(geojson, {
            style: {
                color: '#BB86FC',
                weight: 2,
                opacity: 0.8
            },
            onEachFeature: (feature, layer) => {
                layer.on('click', () => this.selectTrip(feature, layer));
            }
        }).addTo(this.tripLayer);
    }

    selectTrip(feature, layer) {
        if (this.selectedTrip && this.selectedTrip.feature.properties.transactionId === feature.properties.transactionId) {
            // Trip is already selected, do nothing
            return;
        }

        if (this.selectedTrip) {
            this.clearSelection(); // Clear previous selection
        }

        this.selectedTrip = {
            feature: feature,
            layer: layer,
            originalGeometry: JSON.parse(JSON.stringify(feature.geometry))
        };

        layer.setStyle({
            color: '#FF5722',
            weight: 4
        });

        document.querySelector('.map-edit-controls').classList.remove('d-none');
        document.getElementById('edit-controls').classList.remove('d-none');
        this.showPoints = true; // Show points when selecting a new trip
        this.editControls.showPoints.checked = true;
        this.showTripPoints(); // Refresh markers
        this.updateTripInfo();

        const bounds = layer.getBounds();
        this.map.fitBounds(bounds, { padding: [50, 50] });

        this.map.on('click', this.handleMapClick.bind(this)); // Enable map click for deselection
    }

    showTripPoints() {
        this.pointMarkers.forEach(marker => this.map.removeLayer(marker));
        this.pointMarkers = [];

        if (!this.selectedTrip) return;

        const coordinates = this.selectedTrip.feature.geometry.coordinates;
        coordinates.forEach((coord, index) => {
            const marker = L.marker([coord[1], coord[0]], {
                draggable: this.showPoints, // Only draggable if showPoints is true
                icon: L.divIcon({
                    className: `point-marker ${this.showPoints ? 'editable' : ''}`,
                    html: '<div></div>',
                    iconSize: [12, 12],
                    iconAnchor: [6, 6]
                })
            }).addTo(this.map);

            marker.on('click', (e) => {
                if (this.showPoints) {
                    e.originalEvent.stopPropagation(); // Prevent trip deselection
                    this.selectPoint(index, marker);
                }
            });

            if (this.showPoints) { // Only add drag events if editable
                marker.on('dragstart', () => {
                    this.addToUndoStack();
                    this.map.off('click', this.handleMapClick.bind(this)); // Disable deselection during drag
                });

                marker.on('drag', (e) => {
                    const newLatLng = e.target.getLatLng();
                    this.updatePointPosition(index, [newLatLng.lng, newLatLng.lat]);
                });

                marker.on('dragend', () => {
                    this.map.on('click', this.handleMapClick.bind(this)); // Re-enable deselection after drag
                    this.setModified(true);
                });
            }

            this.pointMarkers.push(marker);
        });
    }

    updatePointPosition(index, newCoord) {
        this.selectedTrip.feature.geometry.coordinates[index] = newCoord;
        this.updateTripPath();
        this.setModified(true);
    }

    selectPoint(index, marker) {
        if (this.selectedPoint) {
            this.selectedPoint.getElement().querySelector('div').classList.remove('selected-point');
        }
        this.selectedPoint = marker;
        marker.getElement().querySelector('div').classList.add('selected-point');
        this.editControls.deletePoint.disabled = false;
    }

    addNewPoint(latlng) {
        this.addToUndoStack();
        const newPoint = [latlng.lng, latlng.lat];
        const insertIndex = this.findNearestSegment(latlng);
        this.selectedTrip.feature.geometry.coordinates.splice(insertIndex + 1, 0, newPoint);
        this.updateTripPath();
        this.showTripPoints(); // Refresh markers
        this.setModified(true);
    }

    deleteSelectedPoint() {
        if (!this.selectedPoint) return;

        this.addToUndoStack();
        const index = this.pointMarkers.indexOf(this.selectedPoint);
        if (index > -1) {
            this.selectedTrip.feature.geometry.coordinates.splice(index, 1);
            this.updateTripPath();
            this.showTripPoints(); // Refresh markers
            this.setModified(true);
        }
        this.selectedPoint = null;
        this.editControls.deletePoint.disabled = true;
    }

    findNearestSegment(clickLatLng) {
        const coordinates = this.selectedTrip.feature.geometry.coordinates;
        let minDistance = Infinity;
        let insertIndex = 0;

        for (let i = 0; i < coordinates.length - 1; i++) {
            const p1 = L.latLng(coordinates[i][1], coordinates[i][0]);
            const p2 = L.latLng(coordinates[i + 1][1], coordinates[i + 1][0]);
            const distance = L.GeometryUtil.distanceSegment(this.map, clickLatLng, p1, p2);

            if (distance < minDistance) {
                minDistance = distance;
                insertIndex = i;
            }
        }

        return insertIndex;
    }

    updateTripPath() {
        const coordinates = this.selectedTrip.feature.geometry.coordinates;
        const latLngs = coordinates.map(coord => [coord[1], coord[0]]);
        this.selectedTrip.layer.setLatLngs(latLngs);
    }

    addToUndoStack() {
        this.undoStack.push(JSON.parse(JSON.stringify(this.selectedTrip.feature.geometry.coordinates)));
        this.editControls.undo.disabled = false;
    }

    undoLastAction() {
        if (this.undoStack.length === 0) return;

        const previousState = this.undoStack.pop();
        this.selectedTrip.feature.geometry.coordinates = previousState;
        this.updateTripPath();
        this.showTripPoints();
        this.setModified(this.undoStack.length > 0); // Modified if undo stack is not empty

        this.editControls.undo.disabled = this.undoStack.length === 0;
    }

    async saveChanges() {
        if (!this.selectedTrip || !this.modified) return;

        const transactionId = this.selectedTrip.feature.properties.transactionId;
        const updatedGeometry = this.selectedTrip.feature.geometry;

        try {
            const response = await fetch(`/api/trips/${transactionId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ geometry: updatedGeometry })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || 'Failed to save changes');
            }

            alert('Changes saved successfully!');
            this.setModified(false);
            this.undoStack = []; // Clear undo stack after saving
            this.editControls.undo.disabled = true;
            this.loadTrips(); // Refresh trips to reflect changes
        } catch (error) {
            console.error('Error saving changes:', error);
            alert(`Error saving changes: ${error.message}`);
        }
    }

    discardChanges() {
        if (!this.selectedTrip) return;

        this.selectedTrip.feature.geometry = JSON.parse(JSON.stringify(this.selectedTrip.originalGeometry));
        this.updateTripPath();
        this.showTripPoints();
        this.setModified(false);
        this.undoStack = [];
        this.editControls.undo.disabled = true;
    }

    setModified(modified) {
        this.modified = modified;
        this.editControls.saveChanges.disabled = !modified;
        this.editControls.discardChanges.disabled = !modified;
    }

    updateTripInfo() {
        const tripInfo = document.getElementById('trip-info');
        if (!tripInfo || !this.selectedTrip) return;

        const props = this.selectedTrip.feature.properties;
        tripInfo.innerHTML = `
            <p><strong>Trip ID:</strong> ${props.transactionId}</p>
            <p><strong>Start Time:</strong> ${new Date(props.startTime).toLocaleString()}</p>
            <p><strong>End Time:</strong> ${new Date(props.endTime).toLocaleString()}</p>
            <p><strong>Distance:</strong> ${parseFloat(props.distance).toFixed(2)} miles</p>
        `;
    }

    clearSelection() {
        if (!this.selectedTrip) return;

        this.selectedTrip.layer.setStyle({
            color: '#BB86FC',
            weight: 2
        });

        this.pointMarkers.forEach(marker => this.map.removeLayer(marker));
        this.pointMarkers = [];
        this.selectedPoint = null;
        this.selectedTrip = null;
        this.undoStack = [];
        this.setModified(false);
        this.editControls.deletePoint.disabled = true; // Disable delete button

        document.querySelector('.map-edit-controls').classList.add('d-none');
        document.getElementById('edit-controls').classList.add('d-none');
        document.getElementById('trip-info').innerHTML = '<p>No trip selected</p>';

        this.map.off('click', this.handleMapClick.bind(this)); // Remove map click listener
    }

    handleMapClick(e) {
        if (e.originalEvent.target.classList.contains('point-marker') || (this.selectedTrip && this.selectedTrip.layer.contains(e.originalEvent.target))) {
            return; // Don't deselect if clicking a marker or the trip line itself
        }
        this.clearSelection(); // Deselect the trip if clicking outside
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.tripEditor = new TripEditor();
});