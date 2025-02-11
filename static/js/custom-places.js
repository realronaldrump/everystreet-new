/* global L, flatpickr, notificationManager, bootstrap, LoadingManager */

(() => {
  "use strict";

  class CustomPlacesManager {
    constructor(map) {
      this.map = map;
      this.drawControl = null;
      this.currentPolygon = null;
      this.places = new Map();
      this.drawingEnabled = false;
      this.customPlacesLayer = L.layerGroup().addTo(this.map);
      this.loadingManager = new LoadingManager();

      this.cacheDOMElements();
      this.initializeControls();
      this.loadPlaces();
      this.setupEventListeners();
    }

    cacheDOMElements() {
      this.startDrawingBtn = document.getElementById("start-drawing");
      this.savePlaceBtn = document.getElementById("save-place");
      this.managePlacesBtn = document.getElementById("manage-places");
      this.placeNameInput = document.getElementById("place-name");
      this.placesList = document.getElementById("places-list");
      this.managePlacesModal = new bootstrap.Modal(
        document.getElementById("manage-places-modal"),
      );
    }

    initializeControls() {
      this.drawControl = new L.Control.Draw({
        draw: {
          polygon: {
            allowIntersection: false,
            drawError: {
              color: "#e1e100",
              message: "<strong>Error:</strong> Shape edges cannot cross!",
            },
            shapeOptions: { color: "#BB86FC" },
          },
          circle: false,
          rectangle: false,
          circlemarker: false,
          marker: false,
          polyline: false,
        },
      });
    }

    setupEventListeners() {
      this.startDrawingBtn?.addEventListener("click", () =>
        this.startDrawing(),
      );
      this.savePlaceBtn?.addEventListener("click", () => this.savePlace());
      this.managePlacesBtn?.addEventListener("click", () =>
        this.showManagePlacesModal(),
      );
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
        this.startDrawingBtn.classList.add("active");
      }
    }

    async savePlace() {
      const placeName = this.placeNameInput.value.trim();
      if (!placeName || !this.currentPolygon) return;
      const placeData = {
        name: placeName,
        geometry: this.currentPolygon.toGeoJSON().geometry,
      };

      try {
        const response = await fetch("/api/places", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(placeData),
        });
        if (response.ok) {
          const savedPlace = await response.json();
          // Ensure the coordinates are in the expected format
          savedPlace.geometry.coordinates = savedPlace.geometry.coordinates[0];
          this.places.set(savedPlace._id, savedPlace);
          this.displayPlace(savedPlace);
          this.resetDrawing();
        } else {
          const errorData = await response.json();
          throw new Error(errorData.message || "Failed to save place");
        }
      } catch (error) {
        console.error("Error saving place:", error);
        notificationManager.show(error.message || "An error occurred while saving the place.", "danger");
      }
    }

    displayPlace(place) {
      const polygon = L.geoJSON(place.geometry, {
        style: { color: "#BB86FC", fillColor: "#BB86FC", fillOpacity: 0.2 },
        onEachFeature: (feature) => (feature.properties.placeId = place._id),
      });
      polygon.bindPopup(`
          <div class="custom-place-popup">
            <h6>${place.name}</h6>
            <small>Click to see visit statistics</small>
          </div>
        `);
      polygon.on("click", () => this.showPlaceStatistics(place._id));
      this.customPlacesLayer.addLayer(polygon);
    }

    async updateVisitsData() {
      try {
        const results = await Promise.all(
          Array.from(this.places.keys()).map(async (placeId) => {
            const stats = await fetch(`/api/places/${placeId}/statistics`).then(
              (res) => res.json(),
            );
            return { placeId, stats };
          }),
        );
        results.forEach(({ placeId, stats }) => {
          const place = this.places.get(placeId);
          if (place) place.statistics = stats;
        });
      } catch (error) {
        console.error("Error updating visits data:", error);
      }
    }

    async showPlaceStatistics(placeId) {
      try {
        const stats = await fetch(`/api/places/${placeId}/statistics`).then(
          (res) => res.json(),
        );
        const place = this.places.get(placeId);
        L.popup()
          .setLatLng(L.GeoJSON.coordsToLatLng(place.geometry.coordinates[0]))
          .setContent(
            `
              <div class="custom-place-popup">
                <h6>${place.name}</h6>
                <p>Total Visits: ${stats.totalVisits}</p>
                <p>Last Visit: ${new Date(stats.lastVisit).toLocaleDateString()}</p>
              </div>
            `,
          )
          .openOn(this.map);
      } catch (error) {
        console.error("Error fetching place statistics:", error);
      }
    }

    async loadPlaces() {
      this.loadingManager.startOperation("Loading Places");
      try {
        this.loadingManager.addSubOperation("fetch", 50);
        this.loadingManager.addSubOperation("display", 50);
        const response = await fetch("/api/places");
        if (!response.ok) throw new Error("Failed to fetch places");
        const places = await response.json();
        this.loadingManager.updateSubOperation("fetch", 100);
        places.forEach((place) => {
          // Convert geometry coordinates if necessary
          place.geometry.coordinates = place.geometry.coordinates[0];
          this.places.set(place._id, place);
          this.displayPlace(place);
        });
        this.loadingManager.updateSubOperation("display", 100);
        await this.updateVisitsData();
      } catch (error) {
        console.error("Error loading places:", error);
        this.loadingManager.error("Failed to load places");
      } finally {
        this.loadingManager.finish("Loading Places");
      }
    }

    resetDrawing() {
      if (this.currentPolygon) this.map.removeLayer(this.currentPolygon);
      this.currentPolygon = null;
      this.placeNameInput.value = "";
      this.savePlaceBtn.disabled = true;
      this.startDrawingBtn.classList.remove("active");
      this.map.removeControl(this.drawControl);
      this.drawingEnabled = false;
    }

    showManagePlacesModal() {
      this.placesList.innerHTML = "";
      this.places.forEach((place) => {
        const item = document.createElement("div");
        item.className =
          "list-group-item d-flex justify-content-between align-items-center bg-dark text-white";
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
      const confirmed = await confirmationDialog.show({
        title: 'Delete Place',
        message: 'Are you sure you want to delete this place?',
        confirmText: 'Delete',
        confirmButtonClass: 'btn-danger'
      });

      if (confirmed) {
        try {
          const response = await fetch(`/api/places/${placeId}`, {
            method: "DELETE",
          });
          if (response.ok) {
            this.places.delete(placeId);
            this.customPlacesLayer.eachLayer((layer) => {
              if (layer.feature && layer.feature.properties.placeId === placeId) {
                this.customPlacesLayer.removeLayer(layer);
              }
            });
            this.showManagePlacesModal();
          } else {
            const errorData = await response.json();
            throw new Error(errorData.message || "Failed to delete place");
          }
        } catch (error) {
          console.error("Error deleting place:", error);
          notificationManager.show(error.message || "An error occurred while deleting the place.", "danger");
        }
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const checkMapReady = setInterval(() => {
      if (document.getElementById("map")) {
        clearInterval(checkMapReady);
        // Use the existing global map if available.
        if (window.map) {
          window.customPlaces = new CustomPlacesManager(window.map);
        } else {
          // Fallback: create a new map and then save it globally.
          window.customPlaces = new CustomPlacesManager(L.map("map"));
          window.map = window.customPlaces.map;
        }
      }
    }, 100);
    setTimeout(() => clearInterval(checkMapReady), 10000);
  });
})();
