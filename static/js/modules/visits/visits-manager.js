
import MapStyles from "../map-styles.js";
import { ensureLibraries } from "../core/library-loader.js";
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
  constructor({ dataService = null, onDataChanged = null, onTablesReady = null, loadLibraries = ensureLibraries } = {}) {
    // Core state
    this.map = null;
    this.places = new Map();
    this.destroyed = false;
    this.onDataChanged = onDataChanged;
    this.onTablesReady = onTablesReady;
    this.loadLibraries = loadLibraries;
    this.initialized = false;
    this.mapInitialization = null;
    this.tripsRequestId = 0;
    this.tablesInitialization = null;
    this.latestVisitStats = null;

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
    this.tripViewer = new TripViewer({ geometryUtils: VisitsGeometry });

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

  }

  async initialize() {
    if (this.destroyed) {
      return false;
    }
    if (!this.initialized) {
      this.initialized = true;
      this.events.setupEventListeners();
      void this.initializeTables();
    }
    return this.initializeMap();
  }

  initializeMap() {
    if (this.destroyed) {
      return Promise.resolve(false);
    }
    if (this.mapInitialization) {
      return this.mapInitialization;
    }
    if (this.map) {
      return Promise.resolve(true);
    }
    const pending = this._initializeMap();
    this.mapInitialization = pending;
    const clearPending = () => {
      if (this.mapInitialization === pending) {
        this.mapInitialization = null;
      }
    };
    pending.then(clearPending, clearPending);
    return pending;
  }

  async _initializeMap() {
    VisitsHelpers.setMapControlsEnabled(false);
    VisitsHelpers.showInitialLoading();
    try {
      const ready = await this.mapController.initialize(VisitsHelpers.getCurrentTheme());
      if (this.destroyed || !ready) {
        return false;
      }
      this.map = this.mapController.getMap();
      this.drawing.initialize(this.map);
      this.popup.setMapController(this.mapController);
      VisitsHelpers.setMapControlsEnabled(true, Boolean(this.drawing.draw));
      this.mapController.zoomToFitAllPlaces();
      return true;
    } catch (error) {
      if (!this.destroyed) {
        this.mapController.reset();
        this.map = null;
        this.drawing.draw = null;
        console.error("Error initializing visits map:", error);
        VisitsHelpers.showErrorState(() => this.initializeMap());
      }
      return false;
    } finally {
      if (!this.destroyed) {
        VisitsHelpers.hideInitialLoading();
      }
    }
  }

  _resolvePlaceId(place) {
    const rawId = place?.id;
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

  setPlaces(places) {
    if (this.destroyed) {
      return;
    }
    const hadPlaces = this.places.size > 0;
    this.places.clear();
    for (const place of places || []) {
      this._setPlace(this._resolvePlaceId(place), place);
    }
    this.mapController.setPlaces([...this.places.values()]);
    if (!hadPlaces && this.map) {
      this.mapController.zoomToFitAllPlaces();
    }
  }

  // --- Stats & Data Updates ---

  async refreshAfterMutation() {
    if (this.destroyed) {
      return;
    }
    await this.onDataChanged?.({ places: [...this.places.values()] });
  }

  updateVisitsData(statsList) {
    if (this.destroyed) {
      return;
    }
    this.latestVisitStats = statsList;
    if (!this.visitsTable) {
      return;
    }
    if (this.places.size === 0) {
      this.visitsTable?.clear().draw();
      return;
    }

    try {
      const validResults = [...(statsList || [])]
        .sort((a, b) => b.totalVisits - a.totalVisits)
        .map((d) => ({
          id: d.id,
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
    if (!this.map || !this.drawing.draw || this.destroyed) {
      return;
    }
    this.drawing.startDrawing();
  }

  startBoundarySelectionMode() {
    if (!this.map || !this.drawing.draw || this.destroyed) {
      return;
    }
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
    if (!this.map || !this.drawing.draw || this.destroyed) {
      notificationManager?.show("Wait for the map to load before editing boundaries.", "info");
      return;
    }
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
    if (!suggestion?.boundary || !this.map || !this.drawing.draw || this.destroyed) {
      return;
    }

    this.drawing.applySuggestion(suggestion);
    this.mapController.animateToPlace({ geometry: suggestion.boundary });
  }

  // --- Tables ---

  initializeTables() {
    if (this.destroyed) {
      return Promise.resolve(false);
    }
    if (this.tablesInitialization) {
      return this.tablesInitialization;
    }
    if (this.visitsTable && this.tripsTable) {
      return Promise.resolve(true);
    }
    const pending = this._initializeTables();
    this.tablesInitialization = pending;
    const clearPending = () => {
      if (this.tablesInitialization === pending) {
        this.tablesInitialization = null;
      }
    };
    pending.then(clearPending, clearPending);
    return pending;
  }

  async _initializeTables() {
    VisitsHelpers.setTableState("loading");
    try {
      await this.loadLibraries(["datatables"]);
      if (this.destroyed) {
        return false;
      }
      VisitsHelpers.setupDurationSorting();
      this._createTables();
      if (this.latestVisitStats) {
        this.updateVisitsData(this.latestVisitStats);
      }
      VisitsHelpers.setTableState("ready");
      this.onTablesReady?.();
      return true;
    } catch (error) {
      if (!this.destroyed) {
        this.visitsTable?.destroy();
        this.tripsTable?.destroy();
        this.visitsTable = null;
        this.tripsTable = null;
        console.error("Error initializing visits tables:", error);
        VisitsHelpers.setTableState("error", () => this.initializeTables());
      }
      return false;
    }
  }

  _createTables() {
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
      if (this.destroyed) {
        return;
      }
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

    const requestId = ++this.tripsRequestId;
    this.tripsTable.clear().draw();

    const data = await this.dataLoader.loadPlaceTrips(placeId);
    if (this.destroyed || requestId !== this.tripsRequestId) {
      return;
    }
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
    VisitsHelpers.hideInitialLoading();
    this.events?.destroy?.();
    this.onDataChanged = null;
    this.onTablesReady = null;
    this.mapController.destroy();
    this.map = null;
    this.tripViewer.destroy();
    this.visitsTable?.destroy();
    this.tripsTable?.destroy();
  }
}

export default VisitsManager;
