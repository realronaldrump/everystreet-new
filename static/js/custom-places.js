/* global L, EveryStreet, getLoadingManager*/
class CustomPlacesManager {
	constructor(map) {
		this.map = map;
		this.drawControl = null;
		this.currentPolygon = null;
		this.places = new Map();
		this.drawingEnabled = false;
		this.customPlacesLayer = EveryStreet.mapLayers.customPlaces.layer;
		
		this.cacheDOMElements();
		this.initializeControls();
		this.loadPlaces();
		this.setupEventListeners();
	}

	cacheDOMElements() {
		this.startDrawingBtn = document.getElementById('start-drawing');
		this.savePlaceBtn = document.getElementById('save-place');
		this.managePlacesBtn = document.getElementById('manage-places');
		this.placeNameInput = document.getElementById('place-name');
		this.placesList = document.getElementById('places-list');
		this.managePlacesModal = new bootstrap.Modal(document.getElementById('manage-places-modal'));
	}

	initializeControls() {
		this.drawControl = new L.Control.Draw({
			draw: {
				polygon: {
					allowIntersection: false,
					drawError: {
						color: '#e1e100',
						message: '<strong>Error:</strong> Shape edges cannot cross!'
					},
					shapeOptions: { color: '#BB86FC' }
				},
				circle: false, rectangle: false, circlemarker: false,
				marker: false, polyline: false
			}
		});
	}

	setupEventListeners() {
		this.startDrawingBtn?.addEventListener('click', () => this.startDrawing());
		this.savePlaceBtn?.addEventListener('click', () => this.savePlace());
		this.managePlacesBtn?.addEventListener('click', () => this.showManagePlacesModal());

		this.map?.on(L.Draw.Event.CREATED, (e) => this.onPolygonCreated(e));
	}

	onPolygonCreated(e) {
		this.currentPolygon = e.layer;
		this.map.addLayer(this.currentPolygon);
		this.savePlaceBtn.disabled = false;
	}

	startDrawing() {
		if (!this.drawingEnabled) {
			this.map.addControl(this.drawControl);
			new L.Draw.Polygon(this.map).enable();
			this.drawingEnabled = true;
			this.startDrawingBtn.classList.add('active');
		}
	}

	async savePlace() {
		const placeName = this.placeNameInput.value.trim();
		if (!placeName || !this.currentPolygon) return;

		const placeData = {
			name: placeName,
			geometry: this.currentPolygon.toGeoJSON().geometry
		};

		try {
			const response = await fetch('/api/places', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
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
			style: { color: '#BB86FC', fillColor: '#BB86FC', fillOpacity: 0.2 }
		});

		polygon.bindPopup(`
            <div class="custom-place-popup">
                <h6>${place.name}</h6>
                <small>Click to see visit statistics</small>
            </div>
        `);
		polygon.on('click', () => this.showPlaceStatistics(place._id));
		this.customPlacesLayer.addLayer(polygon);
	}

	async updateVisitsData() {
		try {
			const results = await Promise.all(Array.from(this.places.keys()).map(async placeId => {
				const stats = await fetch(`/api/places/${placeId}/statistics`).then(response => response.json());
				return { placeId, stats };
			}));

			results.forEach(({ placeId, stats }) => {
				const place = this.places.get(placeId);
				if (place) place.statistics = stats;
			});
		} catch (error) {
			console.error('Error updating visits data:', error);
		}
	}

	async showPlaceStatistics(placeId) {
		try {
			const stats = await fetch(`/api/places/${placeId}/statistics`).then(response => response.json());
			const place = this.places.get(placeId);

			L.popup()
				.setLatLng(place.geometry.coordinates[0][0])
				.setContent(`
                    <div class="custom-place-popup">
                        <h6>${place.name}</h6>
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
			const places = await fetch('/api/places').then(response => response.json());

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
		if (this.currentPolygon) this.map.removeLayer(this.currentPolygon);
		this.currentPolygon = null;
		this.placeNameInput.value = '';
		this.savePlaceBtn.disabled = true;
		this.startDrawingBtn.classList.remove('active');
		this.map.removeControl(this.drawControl);
		this.drawingEnabled = false;
	}

	showManagePlacesModal() {
		this.placesList.innerHTML = '';
		this.places.forEach(place => {
			const item = document.createElement('div');
			item.className = 'list-group-item d-flex justify-content-between align-items-center bg-dark text-white';
			item.innerHTML = `
                <span>${place.name}</span>
                <button class="btn btn-danger btn-sm" onclick="customPlaces.deletePlace('${place._id}')">
                    <i class="fas fa-trash"></i>
                </button>
            `;
			this.placesList.appendChild(item);
		});
		this.managePlacesModal.show();
	}

	async deletePlace(placeId) {
		try {
			const response = await fetch(`/api/places/${placeId}`, { method: 'DELETE' });

			if (response.ok) {
				this.places.delete(placeId);
				this.customPlacesLayer.eachLayer(layer => {
					if (layer.feature?.properties?.placeId === placeId) {
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