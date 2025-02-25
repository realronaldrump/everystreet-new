/* global L, notificationManager, bootstrap, confirmationDialog */

/**
 * CustomPlacesManager - Manages creation and interaction with custom map places
 */
class CustomPlacesManager {
  /**
   * Creates a new CustomPlacesManager instance
   * @param {L.Map} map - Leaflet map instance
   */
  constructor(map) {
    if (!map) {
      console.error('Map is required for CustomPlacesManager');
      return;
    }
    
    this.map = map;
    this.drawControl = null;
    this.currentPolygon = null;
    this.places = new Map();
    this.drawingEnabled = false;
    this.customPlacesLayer = L.layerGroup();
    
    // Register with global mapLayers if available
    if (window.mapLayers?.customPlaces) {
      window.mapLayers.customPlaces.layer = this.customPlacesLayer;
      if (window.mapLayers.customPlaces.visible) {
        this.customPlacesLayer.addTo(this.map);
      }
    }

    this.init();
  }

  /**
   * Initialize the manager
   */
  init() {
    // Cache DOM elements
    this.elements = {
      startDrawingBtn: document.getElementById('start-drawing'),
      savePlaceBtn: document.getElementById('save-place'),
      managePlacesBtn: document.getElementById('manage-places'),
      placeNameInput: document.getElementById('place-name'),
      placesList: document.getElementById('places-list')
    };
    
    // Initialize modal
    const modalElement = document.getElementById('manage-places-modal');
    this.managePlacesModal = modalElement ? new bootstrap.Modal(modalElement) : null;
    
    // Initialize drawing controls if available
    if (L.Control?.Draw) {
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
          // Disable other drawing tools
          circle: false,
          rectangle: false,
          circlemarker: false,
          marker: false,
          polyline: false
        }
      });
    } else {
      console.warn('L.Control.Draw not available - drawing features disabled');
    }
    
    this.setupEventListeners();
    this.loadPlaces();
  }

  /**
   * Set up event listeners
   */
  setupEventListeners() {
    const { startDrawingBtn, savePlaceBtn, managePlacesBtn } = this.elements;
    
    // Button event listeners
    if (startDrawingBtn) {
      startDrawingBtn.addEventListener('click', () => this.startDrawing());
    }
    
    if (savePlaceBtn) {
      savePlaceBtn.addEventListener('click', () => this.savePlace());
    }
    
    if (managePlacesBtn) {
      managePlacesBtn.addEventListener('click', () => this.showManagePlacesModal());
    }
    
    // Map drawing events
    if (this.map && L.Draw?.Event) {
      this.map.on(L.Draw.Event.CREATED, e => this.onPolygonCreated(e));
    }
    
    // Make deletePlace accessible globally for event handlers
    window.customPlaces = this;
  }

  /**
   * Handle polygon creation event
   * @param {L.DrawEvent} e - Drawing event
   */
  onPolygonCreated(e) {
    this.currentPolygon = e.layer;
    this.map.addLayer(this.currentPolygon);
    
    if (this.elements.savePlaceBtn) {
      this.elements.savePlaceBtn.disabled = false;
    }
  }

  /**
   * Start drawing mode
   */
  startDrawing() {
    if (this.drawingEnabled || !this.drawControl) return;
    
    this.map.addControl(this.drawControl);
    
    if (L.Draw?.Polygon) {
      new L.Draw.Polygon(this.map).enable();
      this.drawingEnabled = true;
      
      if (this.elements.startDrawingBtn) {
        this.elements.startDrawingBtn.classList.add('active');
      }
    }
  }

  /**
   * Save the current polygon as a place
   */
  async savePlace() {
    const { placeNameInput } = this.elements;
    
    if (!placeNameInput || !this.currentPolygon) return;
    
    const placeName = placeNameInput.value.trim();
    if (!placeName) {
      notificationManager.show('Please enter a name for this place', 'warning');
      return;
    }
    
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
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to save place');
      }
      
      const savedPlace = await response.json();
      
      // Ensure coordinates are properly formatted
      if (savedPlace.geometry?.coordinates) {
        // Make sure we have proper format for polygon coordinates
        if (!Array.isArray(savedPlace.geometry.coordinates[0])) {
          savedPlace.geometry.coordinates = [savedPlace.geometry.coordinates];
        }
        
        this.places.set(savedPlace._id, savedPlace);
        this.displayPlace(savedPlace);
        this.resetDrawing();
        notificationManager.show(`Place "${placeName}" saved successfully`, 'success');
      }
    } catch (error) {
      console.error('Error saving place:', error);
      notificationManager.show(error.message || 'Error saving place', 'danger');
    }
  }

  /**
   * Display a place on the map
   * @param {Object} place - Place data
   */
  displayPlace(place) {
    if (!place?.geometry?.coordinates?.length) return;
    
    try {
      const polygon = L.geoJSON(place.geometry, {
        style: { 
          color: '#BB86FC', 
          fillColor: '#BB86FC', 
          fillOpacity: 0.2 
        },
        onEachFeature: (feature, layer) => {
          // Add place ID to feature properties
          if (!feature.properties) feature.properties = {};
          feature.properties.placeId = place._id;
          
          // Add popup
          layer.bindPopup(`
            <div class="custom-place-popup">
              <h6>${place.name}</h6>
              <small>Click to see visit statistics</small>
            </div>
          `);
          
          // Add click handler
          layer.on('click', () => this.showPlaceStatistics(place._id));
        }
      });
      
      this.customPlacesLayer.addLayer(polygon);
    } catch (error) {
      console.error('Error displaying place:', error, place);
    }
  }

  /**
   * Reset drawing state
   */
  resetDrawing() {
    if (this.currentPolygon) {
      this.map.removeLayer(this.currentPolygon);
    }
    
    this.currentPolygon = null;
    
    const { placeNameInput, savePlaceBtn, startDrawingBtn } = this.elements;
    
    if (placeNameInput) placeNameInput.value = '';
    if (savePlaceBtn) savePlaceBtn.disabled = true;
    if (startDrawingBtn) startDrawingBtn.classList.remove('active');
    if (this.drawControl) this.map.removeControl(this.drawControl);
    
    this.drawingEnabled = false;
  }

  /**
   * Load places from API
   */
  async loadPlaces() {
    try {
      const response = await fetch('/api/places');
      
      if (!response.ok) {
        throw new Error(`Failed to fetch places: ${response.status}`);
      }
      
      const places = await response.json();
      
      places.forEach(place => {
        if (place?.geometry?.coordinates) {
          // Ensure proper coordinates structure
          if (!Array.isArray(place.geometry.coordinates[0])) {
            place.geometry.coordinates = [place.geometry.coordinates];
          }
          
          this.places.set(place._id, place);
          this.displayPlace(place);
        } else {
          console.warn(`Invalid geometry for place: ${place._id || 'unknown'}`);
        }
      });
      
      // Load visit statistics for each place
      this.updateVisitsData();
    } catch (error) {
      console.error('Error loading places:', error);
      notificationManager.show('Failed to load custom places', 'danger');
    }
  }

  /**
   * Update visit statistics for all places
   */
  async updateVisitsData() {
    try {
      const placeIds = Array.from(this.places.keys());
      
      // Fetch statistics for all places in parallel
      const results = await Promise.all(
        placeIds.map(async placeId => {
          try {
            const response = await fetch(`/api/places/${placeId}/statistics`);
            if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
            
            const stats = await response.json();
            return { placeId, stats };
          } catch (error) {
            console.warn(`Failed to fetch stats for place ${placeId}:`, error);
            return { placeId, stats: { totalVisits: 0, lastVisit: null } };
          }
        })
      );
      
      // Update place data with statistics
      results.forEach(({ placeId, stats }) => {
        const place = this.places.get(placeId);
        if (place) place.statistics = stats;
      });
    } catch (error) {
      console.error('Error updating place statistics:', error);
    }
  }

  /**
   * Show statistics for a place
   * @param {string} placeId - Place ID
   */
  async showPlaceStatistics(placeId) {
    const place = this.places.get(placeId);
    if (!place?.geometry?.coordinates?.length) return;
    
    try {
      // Fetch fresh statistics
      const response = await fetch(`/api/places/${placeId}/statistics`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch statistics: ${response.status}`);
      }
      
      const stats = await response.json();
      
      // Format date or use placeholder
      const lastVisitDate = stats.lastVisit ? 
        new Date(stats.lastVisit).toLocaleDateString() :
        'Never';
      
      // Create and show popup
      L.popup()
        .setLatLng(L.GeoJSON.coordsToLatLng(place.geometry.coordinates[0][0]))
        .setContent(`
          <div class="custom-place-popup">
            <h6>${place.name}</h6>
            <p>Total Visits: ${stats.totalVisits || 0}</p>
            <p>Last Visit: ${lastVisitDate}</p>
          </div>
        `)
        .openOn(this.map);
    } catch (error) {
      console.error('Error showing place statistics:', error);
      notificationManager.show('Failed to load place statistics', 'danger');
    }
  }

  /**
   * Show modal for managing places
   */
  showManagePlacesModal() {
    const { placesList } = this.elements;
    if (!placesList || !this.managePlacesModal) return;
    
    // Clear existing list items
    placesList.innerHTML = '';
    
    // Add places to list
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
    
    // Show modal
    this.managePlacesModal.show();
  }

  /**
   * Delete a place
   * @param {string} placeId - Place ID
   */
  async deletePlace(placeId) {
    if (!placeId) return;
    
    const confirmed = await confirmationDialog.show({
      title: 'Delete Place',
      message: 'Are you sure you want to delete this place?',
      confirmText: 'Delete',
      confirmButtonClass: 'btn-danger'
    });

    if (!confirmed) return;
    
    try {
      const response = await fetch(`/api/places/${placeId}`, {
        method: 'DELETE'
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to delete place');
      }
      
      // Remove from places collection
      this.places.delete(placeId);
      
      // Remove from map
      this.customPlacesLayer.eachLayer(layer => {
        if (layer.feature?.properties?.placeId === placeId) {
          this.customPlacesLayer.removeLayer(layer);
        }
      });
      
      notificationManager.show('Place deleted successfully', 'success');
      
      // Refresh modal if open
      if (this.managePlacesModal && 
          document.getElementById('manage-places-modal')?.classList.contains('show')) {
        this.showManagePlacesModal();
      }
    } catch (error) {
      console.error('Error deleting place:', error);
      notificationManager.show(error.message || 'Error deleting place', 'danger');
    }
  }

  /**
   * Toggle layer visibility
   * @param {boolean} visible - Whether the layer should be visible
   */
  toggleVisibility(visible) {
    if (!this.map || !this.customPlacesLayer) return;
    
    if (visible) {
      this.customPlacesLayer.addTo(this.map);
    } else {
      this.map.removeLayer(this.customPlacesLayer);
    }
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Wait for map to be available
  const checkForMap = setInterval(() => {
    const mapElement = document.getElementById('map');
    const mapInstance = window.map;
    
    if (mapElement && mapInstance) {
      window.customPlaces = new CustomPlacesManager(mapInstance);
      clearInterval(checkForMap);
    }
  }, 200);
  
  // Fail-safe to stop checking after 10 seconds
  setTimeout(() => clearInterval(checkForMap), 10000);
});
