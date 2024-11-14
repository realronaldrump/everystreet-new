class CustomPlacesManager {
    constructor(map) {
        this.map = map;
        this.drawControl = null;
        this.currentPolygon = null;
        this.places = new Map();
        this.drawingEnabled = false;

        this.customPlacesLayer = EveryStreet.mapLayers.customPlaces.layer;

        this.initializeControls();
        this.loadPlaces();
        this.setupEventListeners();
    }

    initializeControls() {
        // Initialize Leaflet.Draw plugin
        this.drawControl = new L.Control.Draw({
            draw: {
                polygon: {
                    allowIntersection: false,
                    drawError: {
                        color: '#e1e100',
                        message: '<strong>Error:</strong> Shape edges cannot cross!'
                    },
                    shapeOptions: {
                        color: '#BB86FC'
                    }
                },
                circle: false,
                rectangle: false,
                circlemarker: false,
                marker: false,
                polyline: false
            }
        });
    }

    setupEventListeners() {
        const startDrawingBtn = document.getElementById('start-drawing');
        const savePlaceBtn = document.getElementById('save-place');
        const managePlacesBtn = document.getElementById('manage-places');
    
        if (startDrawingBtn) {
            startDrawingBtn.addEventListener('click', () => this.startDrawing());
        }
        
        if (savePlaceBtn) {
            savePlaceBtn.addEventListener('click', () => this.savePlace());
        }
        
        if (managePlacesBtn) {
            managePlacesBtn.addEventListener('click', () => this.showManagePlacesModal());
        }
    
        if (this.map) {
            this.map.on(L.Draw.Event.CREATED, (e) => {
                this.currentPolygon = e.layer;
                this.map.addLayer(this.currentPolygon);
                const saveButton = document.getElementById('save-place');
                if (saveButton) {
                    saveButton.disabled = false;
                }
            });
        }
    }

    startDrawing() {
        if (!this.drawingEnabled) {
            this.map.addControl(this.drawControl);
            new L.Draw.Polygon(this.map).enable();
            this.drawingEnabled = true;
            document.getElementById('start-drawing').classList.add('active');
        }
    }

    async savePlace() {
        const placeName = document.getElementById('place-name').value.trim();
        if (!placeName || !this.currentPolygon) return;

        const placeData = {
            name: placeName,
            geometry: this.currentPolygon.toGeoJSON().geometry
        };

        try {
            const response = await fetch('/api/places', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(placeData)
            });

            if (response.ok) {
                const savedPlace = await response.json();
                this.places.set(savedPlace._id, savedPlace);
                this.displayPlace(savedPlace);
                this.resetDrawing();
            }
        } catch (error) {
            console.error('Error saving place:', error);
        }
    }

    displayPlace(place) {
        const polygon = L.geoJSON(place.geometry, {
            style: {
                color: '#BB86FC',
                fillColor: '#BB86FC',
                fillOpacity: 0.2
            }
        });

        polygon.bindPopup(`
            <div class="custom-place-popup">
                <h6>${place.name}</h6>
                <small>Click to see visit statistics</small>
            </div>
        `);

        polygon.on('click', () => this.showPlaceStatistics(place._id));

        // Add the polygon to the customPlaces LayerGroup
        this.customPlacesLayer.addLayer(polygon);
    }

    // Add this method to the CustomPlacesManager class
    async updateVisitsData() {
        try {
            const promises = Array.from(this.places.keys()).map(placeId =>
                fetch(`/api/places/${placeId}/statistics`)
                    .then(response => response.json())
                    .then(stats => ({
                        placeId,
                        stats
                    }))
            );

            const results = await Promise.all(promises);
            results.forEach(({placeId, stats}) => {
                const place = this.places.get(placeId);
                if (place) {
                    place.statistics = stats;
                }
            });
        } catch (error) {
            console.error('Error updating visits data:', error);
        }
    }

    async showPlaceStatistics(placeId) {
        try {
            const response = await fetch(`/api/places/${placeId}/statistics`);
            const stats = await response.json();
            
            const popup = L.popup()
                .setLatLng(this.places.get(placeId).geometry.coordinates[0][0])
                .setContent(`
                    <div class="custom-place-popup">
                        <h6>${this.places.get(placeId).name}</h6>
                        <p>Total Visits: ${stats.totalVisits}</p>
                        <p>Last Visit: ${new Date(stats.lastVisit).toLocaleDateString()}</p>
                    </div>
                `)
                .openOn(this.map);
        } catch (error) {
            console.error('Error fetching place statistics:', error);
        }
    }

    async loadPlaces() {
        const loadingManager = getLoadingManager();
        loadingManager.startOperation('Loading Places');
        
        try {
            loadingManager.updateProgress(30, 'Fetching places');
            const response = await fetch('/api/places');
            const places = await response.json();
            
            loadingManager.updateProgress(60, 'Displaying places');
            places.forEach(place => {
                this.places.set(place._id, place);
                this.displayPlace(place);
            });
            
            loadingManager.updateProgress(90, 'Updating statistics');
            await this.updateVisitsData();
            
        } catch (error) {
            console.error('Error loading places:', error);
        } finally {
            loadingManager.finish();
        }
    }

    resetDrawing() {
        if (this.currentPolygon) {
            this.map.removeLayer(this.currentPolygon);
        }
        this.currentPolygon = null;
        document.getElementById('place-name').value = '';
        document.getElementById('save-place').disabled = true;
        document.getElementById('start-drawing').classList.remove('active');
        this.map.removeControl(this.drawControl);
        this.drawingEnabled = false;
    }

    showManagePlacesModal() {
        const placesList = document.getElementById('places-list');
        placesList.innerHTML = '';

        this.places.forEach(place => {
            const item = document.createElement('div');
            item.className = 'list-group-item d-flex justify-content-between align-items-center bg-dark text-white';
            item.innerHTML = `
                <span>${place.name}</span>
                <button class="btn btn-danger btn-sm" onclick="customPlaces.deletePlace('${place._id}')">
                    <i class="fas fa-trash"></i>
                </button>
            `;
            placesList.appendChild(item);
        });

        new bootstrap.Modal(document.getElementById('manage-places-modal')).show();
    }

    async deletePlace(placeId) {
        try {
            const response = await fetch(`/api/places/${placeId}`, {
                method: 'DELETE'
            });

            if (response.ok) {
                this.places.delete(placeId);
                this.map.eachLayer(layer => {
                    if (layer.feature && layer.feature.properties.placeId === placeId) {
                        this.map.removeLayer(layer);
                    }
                });
                this.showManagePlacesModal();
            }
        } catch (error) {
            console.error('Error deleting place:', error);
        }
    }
}

// Initialize when the map is ready
document.addEventListener('DOMContentLoaded', () => {
    const initializeCustomPlaces = () => {
        const map = EveryStreet.getMap();
        if (map && document.getElementById('start-drawing')) {
            window.customPlaces = new CustomPlacesManager(map);
        } else if (map) {
            console.log('Custom places controls not found, skipping initialization');
        } else {
            setTimeout(initializeCustomPlaces, 100);
        }
    };
    initializeCustomPlaces();
});