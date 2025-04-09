/* global L, notificationManager, bootstrap, confirmationDialog */

class CustomPlacesManager {
  constructor(map) {
    if (!map) {
      console.error("Map is required for CustomPlacesManager");
      return;
    }

    this.map = map;
    this.drawControl = null;
    this.currentPolygon = null;
    this.places = new Map();
    this.drawingEnabled = false;
    this.customPlacesLayer = L.layerGroup();

    if (window.mapLayers?.customPlaces) {
      window.mapLayers.customPlaces.layer = this.customPlacesLayer;
      if (window.mapLayers.customPlaces.visible) {
        this.customPlacesLayer.addTo(this.map);
      }
    }

    this.init();
  }

  init() {
    this.elements = {
      startDrawingBtn: document.getElementById("start-drawing"),
      savePlaceBtn: document.getElementById("save-place"),
      managePlacesBtn: document.getElementById("manage-places"),
      placeNameInput: document.getElementById("place-name"),
      placesList: document.getElementById("places-list"),
    };

    const modalElement = document.getElementById("manage-places-modal");
    this.managePlacesModal = modalElement
      ? new bootstrap.Modal(modalElement)
      : null;

    if (L.Control?.Draw) {
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
    } else {
      console.warn("L.Control.Draw not available - drawing features disabled");
    }

    this.setupEventListeners();
    this.loadPlaces();
  }

  setupEventListeners() {
    const { startDrawingBtn, savePlaceBtn, managePlacesBtn } = this.elements;

    if (startDrawingBtn) {
      startDrawingBtn.addEventListener("click", () => this.startDrawing());
    }

    if (savePlaceBtn) {
      savePlaceBtn.addEventListener("click", () => this.savePlace());
    }

    if (managePlacesBtn) {
      managePlacesBtn.addEventListener("click", () =>
        this.showManagePlacesModal(),
      );
    }

    if (this.map && L.Draw?.Event) {
      this.map.on(L.Draw.Event.CREATED, (e) => this.onPolygonCreated(e));
    }

    window.customPlaces = this;
  }

  onPolygonCreated(e) {
    this.currentPolygon = e.layer;
    this.map.addLayer(this.currentPolygon);

    if (this.elements.savePlaceBtn) {
      this.elements.savePlaceBtn.disabled = false;
    }
  }

  startDrawing() {
    if (this.drawingEnabled || !this.drawControl) return;

    this.map.addControl(this.drawControl);

    if (L.Draw?.Polygon) {
      new L.Draw.Polygon(this.map).enable();
      this.drawingEnabled = true;

      if (this.elements.startDrawingBtn) {
        this.elements.startDrawingBtn.classList.add("active");
      }
    }
  }

  async savePlace() {
    const { placeNameInput } = this.elements;

    if (!placeNameInput || !this.currentPolygon) return;

    const placeName = placeNameInput.value.trim();
    if (!placeName) {
      window.notificationManager.show(
        "Please enter a name for this place",
        "warning",
      );
      return;
    }

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

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to save place");
      }

      const savedPlace = await response.json();

      if (savedPlace.geometry?.coordinates) {
        if (!Array.isArray(savedPlace.geometry.coordinates[0])) {
          savedPlace.geometry.coordinates = [savedPlace.geometry.coordinates];
        }

        this.places.set(savedPlace._id, savedPlace);
        this.displayPlace(savedPlace);
        this.resetDrawing();
        window.notificationManager.show(
          `Place "${placeName}" saved successfully`,
          "success",
        );
      }
    } catch (error) {
      console.error("Error saving place:", error);
      window.notificationManager.show(
        error.message || "Error saving place",
        "danger",
      );
    }
  }

  displayPlace(place) {
    if (!place?.geometry?.coordinates?.length) return;

    try {
      const polygon = L.geoJSON(place.geometry, {
        style: {
          color: "#BB86FC",
          fillColor: "#BB86FC",
          fillOpacity: 0.2,
        },
        onEachFeature: (feature, layer) => {
          if (!feature.properties) feature.properties = {};
          feature.properties.placeId = place._id;

          layer.bindPopup(`
            <div class="custom-place-popup">
              <h6>${place.name}</h6>
              <small>Click to see visit statistics</small>
            </div>
          `);

          layer.on("click", () => this.showPlaceStatistics(place._id));
        },
      });

      this.customPlacesLayer.addLayer(polygon);
    } catch (error) {
      console.error("Error displaying place:", error, place);
    }
  }

  resetDrawing() {
    if (this.currentPolygon) {
      this.map.removeLayer(this.currentPolygon);
    }

    this.currentPolygon = null;

    const { placeNameInput, savePlaceBtn, startDrawingBtn } = this.elements;

    if (placeNameInput) placeNameInput.value = "";
    if (savePlaceBtn) savePlaceBtn.disabled = true;
    if (startDrawingBtn) startDrawingBtn.classList.remove("active");
    if (this.drawControl) this.map.removeControl(this.drawControl);

    this.drawingEnabled = false;
  }

  async loadPlaces() {
    try {
      const response = await fetch("/api/places");

      if (!response.ok) {
        throw new Error(`Failed to fetch places: ${response.status}`);
      }

      const places = await response.json();

      places.forEach((place) => {
        if (place?.geometry?.coordinates) {
          if (!Array.isArray(place.geometry.coordinates[0])) {
            place.geometry.coordinates = [place.geometry.coordinates];
          }

          this.places.set(place._id, place);
          this.displayPlace(place);
        } else {
          console.warn(`Invalid geometry for place: ${place._id || "unknown"}`);
        }
      });
    } catch (error) {
      console.error("Error loading places:", error);
      window.notificationManager.show("Failed to load custom places", "danger");
    }
  }

  async updateVisitsData(force = false) {
    const isVisitsPage = window.location.pathname.includes("/visits");
    if (!isVisitsPage && !force) {
      console.log("Skipping place statistics on the main page");
      return;
    }

    try {
      const placeIds = Array.from(this.places.keys());

      if (placeIds.length === 0) return;

      const results = await Promise.all(
        placeIds.map(async (placeId) => {
          try {
            const response = await fetch(`/api/places/${placeId}/statistics`);
            if (!response.ok) throw new Error(`HTTP error: ${response.status}`);

            const stats = await response.json();
            return { placeId, stats };
          } catch (error) {
            console.warn(`Failed to fetch stats for place ${placeId}:`, error);
            return { placeId, stats: { totalVisits: 0, lastVisit: null } };
          }
        }),
      );

      results.forEach(({ placeId, stats }) => {
        const place = this.places.get(placeId);
        if (place) place.statistics = stats;
      });
    } catch (error) {
      console.error("Error updating place statistics:", error);
    }
  }

  async showPlaceStatistics(placeId) {
    const place = this.places.get(placeId);
    if (!place?.geometry?.coordinates?.length) return;

    try {
      const response = await fetch(`/api/places/${placeId}/statistics`);

      if (!response.ok) {
        throw new Error(`Failed to fetch statistics: ${response.status}`);
      }

      const stats = await response.json();

      const lastVisitDate = stats.lastVisit
        ? new Date(stats.lastVisit).toLocaleDateString()
        : "Never";

      const coordinates = place.geometry.coordinates[0][0];
      if (!coordinates) return;

      L.popup()
        .setLatLng(L.GeoJSON.coordsToLatLng(coordinates))
        .setContent(
          `
          <div class="custom-place-popup">
            <h6>${place.name}</h6>
            <p>Total Visits: ${stats.totalVisits || 0}</p>
            <p>Last Visit: ${lastVisitDate}</p>
          </div>
        `,
        )
        .openOn(this.map);
    } catch (error) {
      console.error("Error showing place statistics:", error);
      window.notificationManager.show(
        "Failed to load place statistics",
        "danger",
      );
    }
  }

  showManagePlacesModal() {
    const { placesList } = this.elements;
    if (!placesList || !this.managePlacesModal) return;

    placesList.innerHTML = "";

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
      placesList.appendChild(item);
    });

    this.managePlacesModal.show();
  }

  async deletePlace(placeId) {
    if (!placeId) return;

    const confirmed = await confirmationDialog.show({
      title: "Delete Place",
      message: "Are you sure you want to delete this place?",
      confirmText: "Delete",
      confirmButtonClass: "btn-danger",
    });

    if (!confirmed) return;

    try {
      const response = await fetch(`/api/places/${placeId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to delete place");
      }

      this.places.delete(placeId);

      this.customPlacesLayer.eachLayer((layer) => {
        if (layer.feature?.properties?.placeId === placeId) {
          this.customPlacesLayer.removeLayer(layer);
        }
      });

      window.notificationManager.show("Place deleted successfully", "success");

      if (
        this.managePlacesModal &&
        document
          .getElementById("manage-places-modal")
          ?.classList.contains("show")
      ) {
        this.showManagePlacesModal();
      }
    } catch (error) {
      console.error("Error deleting place:", error);
      window.notificationManager.show(
        `Error deleting place: ${error.message}`,
        "danger",
      );
    }
  }

  toggleVisibility(visible) {
    if (!this.map || !this.customPlacesLayer) return;

    if (visible) {
      this.customPlacesLayer.addTo(this.map);
    } else {
      this.map.removeLayer(this.customPlacesLayer);
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const checkForMap = setInterval(() => {
    const mapElement = document.getElementById("map");
    const mapInstance = window.map;

    if (mapElement && mapInstance) {
      window.customPlaces = new CustomPlacesManager(mapInstance);
      clearInterval(checkForMap);
    }
  }, 200);

  setTimeout(() => clearInterval(checkForMap), 10000);
});
