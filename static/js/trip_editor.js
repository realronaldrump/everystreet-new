class TripEditor {
    constructor() {
        this.map = null;
        this.selectedTrip = null;
        this.editMode = 'regular';
        this.tripLayer = null;
        this.pointMarkers = [];
        this.selectedPoint = null;
        this.undoStack = [];
        this.modified = false;
        this.showPoints = false;

        // Initialize controls
        this.editControls = {
            addPoint: document.getElementById('add-point'),
            deletePoint: document.getElementById('delete-point'),
            undo: document.getElementById('undo'),
            saveChanges: document.getElementById('save-changes'),
            discardChanges: document.getElementById('discard-changes'),
            showPoints: document.getElementById('show-points')
        };

        this.initializeMap();
        this.setupEventListeners();
        this.loadTrips();
    }

    initializeMap() {
        this.map = L.map('map', {
            center: [37.0902, -95.7129],
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
        document.getElementById('edit-mode').addEventListener('change', (e) => {
            this.editMode = e.target.value;
            this.loadTrips();
        });

        // Edit control buttons
        this.editControls.addPoint.addEventListener('click', () => {
            this.map.getContainer().classList.add('add-point-mode');
            this.map.once('click', (e) => {
                this.addNewPoint(e.latlng);
                this.map.getContainer().classList.remove('add-point-mode');
            });
        });

        this.editControls.deletePoint.addEventListener('click', () => {
            if (this.selectedPoint) {
                this.deleteSelectedPoint();
            }
        });

        this.editControls.undo.addEventListener('click', () => this.undoLastAction());
        this.editControls.saveChanges.addEventListener('click', () => this.saveChanges());
        this.editControls.discardChanges.addEventListener('click', () => this.discardChanges());

        // Listen for date range changes
        document.getElementById('apply-filters').addEventListener('click', () => this.loadTrips());

        this.editControls.showPoints.addEventListener('change', (e) => {
            this.showPoints = e.target.checked;
            if (this.selectedTrip) {
                this.showTripPoints();
            }
        });
    }

    async loadTrips() {
        const startDate = document.getElementById('start-date').value;
        const endDate = document.getElementById('end-date').value;
        
        if (!startDate || !endDate) return;

        const endpoint = this.editMode === 'regular' ? '/api/trips' : '/api/matched_trips';
        const params = new URLSearchParams({ start_date: startDate, end_date: endDate });

        try {
            const response = await fetch(`${endpoint}?${params}`);
            const data = await response.json();
            this.displayTrips(data);
        } catch (error) {
            console.error('Error loading trips:', error);
            alert('Error loading trips. Please try again.');
        }
    }

    displayTrips(geojson) {
        this.tripLayer.clearLayers();
        
        if (!geojson || !geojson.features) {
            console.warn('No trips to display');
            return;
        }

        // Filter trips based on edit mode
        const tripsToDisplay = geojson.features.filter(feature => {
            if (this.editMode === 'regular') {
                return !feature.properties.matched;
            } else {
                return feature.properties.matched;
            }
        });

        L.geoJSON({
            type: 'FeatureCollection',
            features: tripsToDisplay
        }, {
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
            return;
        }

        if (this.selectedTrip) {
            this.clearSelection();
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

        // Show points initially but not in edit mode
        this.showPoints = false;
        this.editControls.showPoints.checked = false;
        
        // Always show points, but they're only draggable when editing is enabled
        this.showTripPoints();
        this.updateTripInfo();

        const bounds = layer.getBounds();
        this.map.fitBounds(bounds, { padding: [50, 50] });

        this.map.on('click', this.handleMapClick.bind(this));
    }

    showTripPoints() {
        // Clear existing points
        this.pointMarkers.forEach(marker => this.map.removeLayer(marker));
        this.pointMarkers = [];

        if (!this.selectedTrip) return;

        const coordinates = this.selectedTrip.feature.geometry.coordinates;
        coordinates.forEach((coord, index) => {
            const marker = L.marker([coord[1], coord[0]], {
                draggable: this.showPoints,
                icon: L.divIcon({
                    className: `point-marker ${this.showPoints ? 'editable' : ''}`,
                    html: '<div></div>',
                    iconSize: [12, 12],
                    iconAnchor: [6, 6]
                })
            });

            if (this.showPoints) {
                marker.on('dragstart', () => {
                    this.addToUndoStack();
                    this.map.off('click', this.handleMapClick.bind(this));
                });

                marker.on('drag', (e) => {
                    const newLatLng = e.target.getLatLng();
                    this.updatePointPosition(index, [newLatLng.lng, newLatLng.lat]);
                });

                marker.on('dragend', () => {
                    this.map.on('click', this.handleMapClick.bind(this));
                    this.setModified(true);
                });

                marker.on('click', (e) => {
                    e.originalEvent.stopPropagation();
                    this.selectPoint(index, marker);
                });
            }

            marker.addTo(this.map);
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
        this.showTripPoints();
        this.setModified(true);
    }

    deleteSelectedPoint() {
        if (!this.selectedPoint) return;

        this.addToUndoStack();
        const index = this.pointMarkers.indexOf(this.selectedPoint);
        if (index > -1) {
            this.selectedTrip.feature.geometry.coordinates.splice(index, 1);
            this.updateTripPath();
            this.showTripPoints();
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
        this.undoStack.push(
            JSON.parse(JSON.stringify(this.selectedTrip.feature.geometry.coordinates))
        );
        this.editControls.undo.disabled = false;
    }

    undoLastAction() {
        if (this.undoStack.length === 0) return;

        const previousState = this.undoStack.pop();
        this.selectedTrip.feature.geometry.coordinates = previousState;
        this.updateTripPath();
        this.showTripPoints();
        this.setModified(true);

        if (this.undoStack.length === 0) {
            this.editControls.undo.disabled = true;
        }
    }

    async saveChanges() {
        if (!this.selectedTrip || !this.modified) return;

        const endpoint = this.editMode === 'regular' ? 
            `/api/trips/${this.selectedTrip.feature.properties.transactionId}` :
            `/api/matched_trips/${this.selectedTrip.feature.properties.transactionId}`;

        try {
            const response = await fetch(endpoint, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    geometry: this.selectedTrip.feature.geometry
                })
            });

            if (!response.ok) {
                throw new Error('Failed to save changes');
            }

            const data = await response.json();
            if (data.status === 'success') {
                alert('Changes saved successfully');
                this.setModified(false);
                this.loadTrips();
            } else {
                throw new Error(data.message || 'Failed to save changes');
            }
        } catch (error) {
            console.error('Error saving changes:', error);
            alert(`Error saving changes: ${error.message}`);
        }
    }

    discardChanges() {
        if (!this.selectedTrip) return;

        this.selectedTrip.feature.geometry = JSON.parse(
            JSON.stringify(this.selectedTrip.originalGeometry)
        );
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
        this.modified = false;

        document.querySelector('.map-edit-controls').classList.add('d-none');
        document.getElementById('edit-controls').classList.add('d-none');
        document.getElementById('trip-info').innerHTML = '<p>No trip selected</p>';
    }

    handleMapClick(e) {
        // Don't deselect if clicking a marker
        if (e.originalEvent.target.classList.contains('point-marker')) {
            return;
        }
        
        // Don't deselect if clicking within the selected trip's path
        if (this.selectedTrip) {
            const clickPoint = e.latlng;
            const tripCoords = this.selectedTrip.feature.geometry.coordinates;
            
            // Simple distance check without GeometryUtil
            for (let i = 0; i < tripCoords.length - 1; i++) {
                const p1 = L.latLng(tripCoords[i][1], tripCoords[i][0]);
                const p2 = L.latLng(tripCoords[i + 1][1], tripCoords[i + 1][0]);
                
                // Check if click is near either point
                if (clickPoint.distanceTo(p1) < 20 || clickPoint.distanceTo(p2) < 20) {
                    return;
                }
            }
        }
        
        this.clearSelection();
        this.map.off('click', this.handleMapClick.bind(this));
    }
}

// Initialize the trip editor when the page loads
document.addEventListener('DOMContentLoaded', () => {
    window.tripEditor = new TripEditor();
});