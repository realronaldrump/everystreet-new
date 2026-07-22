/* global bootstrap */

import MapStyles from "../map-styles.js";
import confirmationDialog from "../ui/confirmation-dialog.js";
import loadingManager from "../ui/loading-manager.js";
import notificationManager from "../ui/notifications.js";
import { VisitsGeometry } from "./geometry.js";
import VisitsMapController from "./map-controller.js";
import { createTripsTable, createVisitsTable } from "./table-factory.js";
import TripViewer from "./trip-viewer.js";
import VisitsActions from "./visits-actions.js";
import VisitsDataLoader from "./visits-data-loader.js";
import VisitsDrawing from "./visits-drawing.js";
import VisitsEvents from "./visits-events.js";
import VisitsHelpers from "./visits-helpers.js";
import VisitsPopup from "./visits-popup.js";
import VisitsUIManager from "./visits-ui-manager.js";

/**
 * Visits Manager - Main Orchestrator
 * Coordinates all visits management modules
 */

class VisitsManager {
  constructor({ dataService = null, onDataChanged = null } = {}) {
    // Core state
    this.map = null;
    this.places = new Map();
    this.destroyed = false;
    this.onDataChanged = onDataChanged;

    // External managers
    this.loadingManager = loadingManager;
    this.uiManager = new VisitsUIManager(this);

    // Map controller
    this.mapController = new VisitsMapController({
      geometryUtils: VisitsGeometry,
      mapStyles: MapStyles,
      onPlaceClicked: (placeId, lngLat) => this.handlePlaceClick(placeId, lngLat),
    });

    // Trip viewer
    this.tripViewer = new TripViewer({
      geometryUtils: VisitsGeometry,
      mapStyles: MapStyles,
    });

    // Initialize new modular components
    this.dataLoader = new VisitsDataLoader({
      dataService,
      loadingManager: this.loadingManager,
      notificationManager,
    });

    this.actions = new VisitsActions({
      dataService,
      loadingManager: this.loadingManager,
      notificationManager,
      confirmationDialog,
    });

    this.drawing = new VisitsDrawing(this.mapController, {
      notificationManager,
    });

    this.events = new VisitsEvents(this);

    this.popup = new VisitsPopup({
      dataLoader: this.dataLoader,
      notificationManager,
      onViewTrips: (placeId) => this.uiManager.toggleView(placeId),
      onZoomToPlace: (placeId) => {
        const place = this._getPlaceById(placeId);
        if (place) {
          this.mapController.animateToPlace(place);
        }
      },
      onEditBoundary: (placeId) => this.startEditingPlaceBoundary(placeId),
    });

    // Tables
    this.visitsTable = null;
    this.tripsTable = null;

    // Set up duration sorting; initialization is owned by the page controller.
    VisitsHelpers.setupDurationSorting();
  }

  async initialize() {
    VisitsHelpers.showInitialLoading();
    this.loadingManager?.show("Initializing Visits Page");

    try {
      await this.mapController.initialize(VisitsHelpers.getCurrentTheme());
      if (this.destroyed) {
        return null;
      }
      this.map = this.mapController.getMap();

      // Initialize drawing with the map
      this.drawing.initialize(this.map);

      // Set map controller on popup after initialization
      this.popup.setMapController(this.mapController);

      this.initializeTables();
      this.events.setupEventListeners();

      const initialData = await this.loadPlaces();
      if (this.destroyed) {
        return null;
      }

      this.loadingManager?.hide();
      VisitsHelpers.hideInitialLoading();

      // Final map resize to ensure proper display after all content loads
      setTimeout(() => {
        this.map?.resize();
      }, 100);

      // Trigger stagger animations for widgets
      this._triggerStaggerAnimations();
      return initialData;
    } catch (error) {
      this.loadingManager?.hide();
      if (!this.destroyed) {
        console.error("Error initializing visits page:", error);
        VisitsHelpers.showErrorState();
      }
      return null;
    }
  }

  /**
   * Trigger stagger animations for widgets
   */
  _triggerStaggerAnimations() {
    const widgets = document.querySelectorAll("#visits-page .widget");
    widgets.forEach((widget, index) => {
      widget.style.opacity = "0";
      widget.style.transform = "translateY(20px)";
      setTimeout(() => {
        widget.style.transition =
          "opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1), transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)";
        widget.style.opacity = "1";
        widget.style.transform = "translateY(0)";
      }, index * 100);
    });
  }

  _resolvePlaceId(place) {
    const rawId = place?._id ?? place?.id;
    if (rawId === undefined || rawId === null) {
      return "";
    }
    return String(rawId);
  }

  _getPlaceById(placeId) {
    const normalizedId =
      placeId === undefined || placeId === null ? "" : String(placeId);
    if (!normalizedId) {
      return null;
    }

    const directMatch = this.places.get(normalizedId);
    if (directMatch) {
      return directMatch;
    }

    for (const place of this.places.values()) {
      if (this._resolvePlaceId(place) === normalizedId) {
        return place;
      }
    }

    return null;
  }

  _setPlace(placeId, place) {
    const normalizedIncomingId =
      placeId === undefined || placeId === null ? "" : String(placeId);
    const normalizedResolvedId = this._resolvePlaceId(place) || normalizedIncomingId;

    if (!normalizedResolvedId) {
      return "";
    }

    if (normalizedIncomingId && normalizedIncomingId !== normalizedResolvedId) {
      this.places.delete(normalizedIncomingId);
    }

    this.places.set(normalizedResolvedId, place);
    return normalizedResolvedId;
  }

  // --- Data Loading ---

  async loadPlaces() {
    const placesMap = await this.dataLoader.loadPlaces((places) => {
      if (!this.destroyed) {
        this.mapController.setPlaces(places);
      }
    });

    if (this.destroyed) {
      return null;
    }
    this.places = placesMap;
    const stats = await this.refreshStatistics();
    return { places: [...placesMap.values()], stats };
  }

  // --- Stats & Data Updates ---

  async refreshStatistics() {
    if (this.destroyed) {
      return [];
    }
    const stats = await this.dataLoader.loadPlaceStatistics({ timeframe: "all" });
    if (!this.destroyed) {
      this.updateVisitsData(stats);
    }
    return stats;
  }

  async refreshAfterMutation() {
    if (this.destroyed) {
      return;
    }
    const stats = await this.refreshStatistics();
    if (!this.destroyed) {
      void this.onDataChanged?.({ places: [...this.places.values()], stats });
    }
  }

  updateVisitsData(statsList) {
    if (this.destroyed) {
      return;
    }
    this.loadingManager?.show("Updating Statistics");

    if (this.places.size === 0) {
      this.visitsTable?.clear().draw();
      this.loadingManager?.hide();
      return;
    }

    try {
      statsList.sort((a, b) => b.totalVisits - a.totalVisits);

      const validResults = statsList.map((d) => ({
        _id: d._id || d.id,
        name: d.name,
        totalVisits: d.totalVisits,
        firstVisit: d.firstVisit,
        lastVisit: d.lastVisit,
        avgTimeSpent: d.averageTimeSpent || "N/A",
      }));

      this.visitsTable?.clear().rows.add(validResults).draw();
    } catch (error) {
      console.error("Error updating place statistics:", error);
      notificationManager?.show("Error updating place statistics", "danger");
    } finally {
      this.loadingManager?.hide();
    }
  }

  // --- Place Actions ---

  async savePlace() {
    const placeNameInput = document.getElementById("place-name");
    const placeName = placeNameInput?.value.trim();
    const currentPolygon = this.drawing.getCurrentPolygon();
    const placeBeingEdited = this.drawing.getPlaceBeingEdited();

    if (!placeName) {
      VisitsHelpers.showInputError(
        placeNameInput,
        "Please enter a name for the place."
      );
      return null;
    }

    if (placeBeingEdited) {
      return this._saveEditedPlaceFromMap({
        placeId: placeBeingEdited,
        newName: placeName,
        currentPolygon,
      });
    }

    const savedPlace = await this.actions.savePlace({
      name: placeName,
      geometry: currentPolygon?.geometry,
      onSuccess: async (place) => {
        if (this.destroyed) {
          return;
        }
        const placeId = this._setPlace(this._resolvePlaceId(place), place);
        if (!placeId) {
          notificationManager?.show(
            "Place was saved, but an ID was missing in the response.",
            "warning"
          );
        }
        this.mapController.addPlace(place);
        this.mapController.animateToPlace(place);
        await this.refreshAfterMutation();
        this.resetDrawing();
      },
    });

    return savedPlace;
  }

  async _saveEditedPlaceFromMap({ placeId, newName, currentPolygon }) {
    const placeToUpdate = this._getPlaceById(placeId);
    const normalizedPlaceId = this._resolvePlaceId(placeToUpdate) || String(placeId);

    const updatedPlace = await this.actions.saveEditedPlace({
      placeId: normalizedPlaceId,
      newName,
      place: placeToUpdate,
      newGeometry: currentPolygon?.geometry || null,
      onSuccess: async (place) => {
        if (this.destroyed) {
          return;
        }
        const updatedPlaceId = this._setPlace(normalizedPlaceId, place);
        this.mapController.removePlace(normalizedPlaceId);
        if (updatedPlaceId && updatedPlaceId !== normalizedPlaceId) {
          this.mapController.removePlace(updatedPlaceId);
        }
        this.mapController.addPlace(place);
        this.mapController.animateToPlace(place);
        await this.refreshAfterMutation();
        this.resetDrawing();
      },
    });

    return updatedPlace;
  }

  async deletePlace(placeId) {
    const requestedPlaceId =
      placeId === undefined || placeId === null ? "" : String(placeId);
    const placeToDelete = this._getPlaceById(requestedPlaceId);
    const resolvedPlaceId = this._resolvePlaceId(placeToDelete) || requestedPlaceId;
    if (!resolvedPlaceId) {
      return false;
    }

    const success = await this.actions.deletePlace(
      resolvedPlaceId,
      placeToDelete,
      async () => {
        if (this.destroyed) {
          return;
        }
        this.mapController.removePlace(resolvedPlaceId);
        if (requestedPlaceId && requestedPlaceId !== resolvedPlaceId) {
          this.mapController.removePlace(requestedPlaceId);
        }
        this.places.delete(resolvedPlaceId);
        if (requestedPlaceId && requestedPlaceId !== resolvedPlaceId) {
          this.places.delete(requestedPlaceId);
        }
        await this.refreshAfterMutation();
      }
    );

    return success;
  }

  async saveEditedPlace() {
    const placeId = document.getElementById("edit-place-id")?.value?.trim();
    const newNameInput = document.getElementById("edit-place-name");
    const newName = newNameInput?.value.trim();
    const placeToUpdate = this._getPlaceById(placeId);
    const resolvedPlaceId = this._resolvePlaceId(placeToUpdate) || placeId;
    const currentPolygon = this.drawing.getCurrentPolygon();
    const placeBeingEdited = this.drawing.getPlaceBeingEdited();

    // Only include geometry if editing the same place that was started for edit
    const newGeometry =
      currentPolygon && String(placeBeingEdited) === String(resolvedPlaceId)
        ? currentPolygon.geometry
        : null;

    const updatedPlace = await this.actions.saveEditedPlace({
      placeId: resolvedPlaceId,
      newName,
      place: placeToUpdate,
      newGeometry,
      onSuccess: async (place, hadGeometry) => {
        if (this.destroyed) {
          return;
        }
        const updatedPlaceId = this._setPlace(resolvedPlaceId, place);
        this.mapController.removePlace(resolvedPlaceId);
        if (updatedPlaceId && updatedPlaceId !== resolvedPlaceId) {
          this.mapController.removePlace(updatedPlaceId);
        }
        this.mapController.addPlace(place);
        await this.refreshAfterMutation();

        if (hadGeometry) {
          this.resetDrawing();
          this.mapController.animateToPlace(place);
        }
      },
    });

    return updatedPlace;
  }

  // --- Drawing Delegation ---

  startDrawing() {
    this.drawing.startDrawing();
  }

  startBoundarySelectionMode() {
    this.drawing.startSelectingBoundaryForEdit();
  }

  clearCurrentDrawing() {
    this.drawing.clearCurrentDrawing();
  }

  adjustBoundaryRadius(scaleFactor) {
    this.drawing.adjustBoundaryRadius(scaleFactor);
  }

  simplifyBoundaryShape() {
    this.drawing.simplifyBoundaryShape();
  }

  smoothBoundaryShape() {
    this.drawing.smoothBoundaryShape();
  }

  resetDrawing(removeControl = true) {
    this.drawing.resetDrawing(removeControl);
  }

  startEditingPlaceBoundary(placeId = null) {
    const requestedPlaceId =
      placeId || document.getElementById("edit-place-id")?.value?.trim();
    const place = this._getPlaceById(requestedPlaceId);
    const resolvedPlaceId = this._resolvePlaceId(place) || requestedPlaceId;

    if (!resolvedPlaceId || !place) {
      notificationManager?.show(
        "Could not find that place for boundary editing.",
        "warning"
      );
      return;
    }

    const beginBoundaryEdit = () => {
      this.drawing.startEditingPlaceBoundary(resolvedPlaceId, place);
      this.mapController.animateToPlace(place);

      document.querySelector(".map-section")?.scrollIntoView?.({
        behavior: "smooth",
        block: "start",
      });
    };

    const editModalEl = document.getElementById("edit-place-modal");
    const editModalInstance =
      bootstrap?.Modal && editModalEl
        ? bootstrap.Modal.getInstance(editModalEl) ||
          bootstrap.Modal.getOrCreateInstance(editModalEl)
        : null;

    if (editModalEl?.classList.contains("show") && editModalInstance) {
      let completed = false;
      const finalize = () => {
        if (completed) {
          return;
        }
        completed = true;
        beginBoundaryEdit();
      };

      editModalEl.addEventListener("hidden.bs.modal", finalize, { once: true });
      editModalInstance.hide();
      setTimeout(finalize, 450);
      return;
    }

    beginBoundaryEdit();
  }

  applySuggestion(suggestion) {
    if (!suggestion?.boundary) {
      return;
    }

    this.drawing.applySuggestion(suggestion);
    this.mapController.animateToPlace({ geometry: suggestion.boundary });
  }

  // --- Tables ---

  initializeTables() {
    this.visitsTable = createVisitsTable({
      onPlaceSelected: (placeId) => this.uiManager.toggleView(placeId),
    });
    this.tripsTable = createTripsTable({
      onTripSelected: (tripId) => this.confirmViewTripOnMap(tripId),
    });
  }

  // --- Trip Viewing ---

  confirmViewTripOnMap(tripId) {
    if (!tripId) {
      return;
    }
    this.fetchAndShowTrip(tripId);
  }

  async fetchAndShowTrip(tripId) {
    try {
      const trip = await this.dataLoader.loadTrip(tripId);
      VisitsHelpers.extractTripGeometry(trip);
      this.tripViewer.showTrip(trip);
    } catch {
      // Error already handled in dataLoader
    } finally {
      document.querySelectorAll(".view-trip-btn.loading").forEach((btn) => {
        btn.classList.remove("loading");
      });
    }
  }

  async showTripsForPlace(placeId) {
    if (!this.tripsTable) {
      console.error("Trips table not initialized.");
      return;
    }

    this.tripsTable.clear().draw();

    const data = await this.dataLoader.loadPlaceTrips(placeId);
    const trips = data.trips || [];
    this.tripsTable.rows.add(trips).draw();

    const placeNameElement = document.getElementById("selected-place-name");
    if (placeNameElement && data.name) {
      placeNameElement.textContent = data.name;
    }
  }

  // --- Map & UI ---

  updateMapTheme(theme) {
    this.mapController.updateTheme(theme);
    this.tripViewer.updateTheme(theme);
  }

  zoomToFitAllPlaces() {
    if (!this.map) {
      notificationManager?.show("No custom places found to zoom to.", "info");
      return;
    }
    this.mapController.zoomToFitAllPlaces();
  }

  handlePlaceClick(placeId, lngLat = null) {
    if (this.drawing.isSelectingBoundaryForEdit()) {
      this.startEditingPlaceBoundary(placeId);
      return;
    }

    // Avoid popup interruptions while actively drawing/editing boundaries.
    if (this.drawing.isDrawingBoundary() || this.drawing.isEditingBoundary()) {
      return;
    }

    void this.showPlaceStatistics(placeId, lngLat);
  }

  async showPlaceStatistics(placeId, lngLat = null) {
    const place = this._getPlaceById(placeId);
    if (!place) {
      return;
    }

    await this.popup.showPlaceStatistics(this._resolvePlaceId(place), place, lngLat);
  }

  // --- Cleanup ---

  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.loadingManager?.hide();
    VisitsHelpers.hideInitialLoading();
    this.events?.destroy?.();
    this.onDataChanged = null;
    this.mapController.destroy();
    this.map = null;
    this.tripViewer.destroy();
    this.visitsTable?.destroy();
    this.tripsTable?.destroy();
  }
}

export default VisitsManager;
