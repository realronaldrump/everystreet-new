/* global bootstrap */

/**
 * Visits Manager - Main Orchestrator
 * Coordinates all visits management modules
 */

(() => {
  class VisitsManager {
    constructor() {
      // Core state
      this.map = null;
      this.places = new Map();

      // External managers
      this.loadingManager = window.loadingManager;
      this.chartManager = new window.VisitsChartManager("visitsChart");
      this.statsManager = new window.VisitsStatsManager();
      this.uiManager = new window.VisitsUIManager(this);

      // Map controller
      this.mapController = new window.VisitsMapController({
        geometryUtils: window.VisitsGeometry,
        mapStyles: window.MapStyles,
        onPlaceClicked: (placeId, lngLat) =>
          this.showPlaceStatistics(placeId, lngLat),
      });

      // Trip viewer
      this.tripViewer = new window.TripViewer({
        geometryUtils: window.VisitsGeometry,
        mapStyles: window.MapStyles,
      });

      // Initialize new modular components
      this.dataLoader = new window.VisitsDataLoader({
        loadingManager: this.loadingManager,
        notificationManager: window.notificationManager,
      });

      this.actions = new window.VisitsActions({
        loadingManager: this.loadingManager,
        notificationManager: window.notificationManager,
        confirmationDialog: window.confirmationDialog,
      });

      this.drawing = new window.VisitsDrawing(this.mapController, {
        notificationManager: window.notificationManager,
      });

      this.events = new window.VisitsEvents(this);

      this.popup = new window.VisitsPopup({
        dataLoader: this.dataLoader,
        notificationManager: window.notificationManager,
        onViewTrips: (placeId) => this.uiManager.toggleView(placeId),
        onZoomToPlace: (placeId) => {
          const place = this.places.get(placeId);
          if (place) {
            this.mapController.animateToPlace(place);
          }
        },
      });

      // Tables
      this.visitsTable = null;
      this.tripsTable = null;
      this.nonCustomVisitsTable = null;
      this.suggestionsTable = null;

      // Set up duration sorting and initialize
      window.VisitsHelpers.setupDurationSorting();
      this.initialize();
    }

    async initialize() {
      window.VisitsHelpers.showInitialLoading();
      this.loadingManager.startOperation("Initializing Visits Page");

      try {
        await this.mapController.initialize(
          window.VisitsHelpers.getCurrentTheme(),
        );
        this.map = this.mapController.getMap();

        // Initialize drawing with the map
        this.drawing.initialize(this.map);

        // Set map controller on popup after initialization
        this.popup.setMapController(this.mapController);

        this.initializeTables();
        this.events.setupEventListeners();
        this.uiManager.setupEnhancedUI();

        await Promise.all([
          this.loadPlaces(),
          this.loadNonCustomPlacesVisits(),
          this.loadSuggestions(),
        ]);

        // Start stats animation
        this.updateStatsCounts();
        this.statsManager.startStatsAnimation(this.places.size, () =>
          this.updateStatsCounts(),
        );

        this.loadingManager.finish("Initializing Visits Page");
        window.VisitsHelpers.hideInitialLoading();
      } catch (error) {
        console.error("Error initializing visits page:", error);
        this.loadingManager.error("Failed to initialize visits page");
        window.VisitsHelpers.showErrorState();
      }
    }

    // --- Data Loading ---

    async loadPlaces() {
      const placesMap = await this.dataLoader.loadPlaces((places) => {
        this.mapController.setPlaces(places);
      });

      this.places = placesMap;
      await this.updateVisitsData();
      this.updateStatsCounts();
    }

    async loadNonCustomPlacesVisits() {
      if (!this.nonCustomVisitsTable) {
        return;
      }

      const visitsData = await this.dataLoader.loadNonCustomPlacesVisits();
      this.nonCustomVisitsTable.clear().rows.add(visitsData).draw();
    }

    async loadSuggestions() {
      if (!this.suggestionsTable) {
        return;
      }

      if (this.suggestionsTable?.processing) {
        this.suggestionsTable.processing(true);
      }

      try {
        const data = await this.dataLoader.loadSuggestions();
        this.suggestionsTable.clear().rows.add(data).draw();
      } finally {
        if (this.suggestionsTable?.processing) {
          this.suggestionsTable.processing(false);
        }
      }
    }

    // --- Stats & Data Updates ---

    async updateStatsCounts() {
      try {
        const customStats = await this.dataLoader.loadPlaceStatistics();
        const totalVisits = customStats.reduce(
          (sum, p) => sum + (p.totalVisits || 0),
          0,
        );
        this.statsManager.updateStatsCounts(this.places.size, totalVisits);
      } catch (error) {
        console.error("Error updating stats:", error);
        this.statsManager.updateStatsCounts(this.places.size, null);
      }
    }

    async updateVisitsData(statsData = null) {
      this.loadingManager.startOperation("Updating Statistics");
      const placeEntries = Array.from(this.places.entries());

      if (placeEntries.length === 0) {
        this.chartManager.update([], null);
        this.visitsTable?.clear().draw();
        this.statsManager.updateInsights([]);
        this.loadingManager.finish("Updating Statistics");
        return;
      }

      try {
        const statsList =
          statsData || (await this.dataLoader.loadPlaceStatistics());
        statsList.sort((a, b) => b.totalVisits - a.totalVisits);

        const validResults = statsList.map((d) => ({
          _id: d._id,
          name: d.name,
          totalVisits: d.totalVisits,
          firstVisit: d.firstVisit,
          lastVisit: d.lastVisit,
          avgTimeSpent: d.averageTimeSpent || "N/A",
        }));

        this.chartManager.update(validResults, (placeName) => {
          const placeEntry = Array.from(this.places.entries()).find(
            ([, placeData]) => placeData.name === placeName,
          );
          if (placeEntry) {
            const [placeId] = placeEntry;
            this.uiManager.toggleView(placeId);
          }
        });

        this.visitsTable?.clear().rows.add(validResults).draw();
        this.statsManager.updateInsights(statsList);
      } catch (error) {
        console.error("Error updating place statistics:", error);
        window.notificationManager?.show(
          "Error updating place statistics",
          "danger",
        );
      } finally {
        this.loadingManager.finish("Updating Statistics");
      }
    }

    async filterByTimeframe(timeframe) {
      const tables = [this.visitsTable, this.nonCustomVisitsTable];
      tables.forEach((table) => {
        table?.processing?.(true);
      });

      try {
        const { customStats, otherStats } =
          await this.dataLoader.filterByTimeframe(timeframe);

        this.updateVisitsData(customStats);
        this.nonCustomVisitsTable?.clear().rows.add(otherStats).draw();
        await this.loadSuggestions();
      } catch (error) {
        console.error("Error filtering by timeframe:", error);
      } finally {
        tables.forEach((table) => {
          table?.processing?.(false);
        });
      }
    }

    // --- Place Actions ---

    async savePlace() {
      const placeNameInput = document.getElementById("place-name");
      const placeName = placeNameInput?.value.trim();
      const currentPolygon = this.drawing.getCurrentPolygon();

      if (!placeName) {
        window.VisitsHelpers.showInputError(
          placeNameInput,
          "Please enter a name for the place.",
        );
        return;
      }

      const savedPlace = await this.actions.savePlace({
        name: placeName,
        geometry: currentPolygon?.geometry,
        onSuccess: async (place) => {
          this.places.set(place._id, place);
          this.mapController.addPlace(place);
          this.mapController.animateToPlace(place);
          await this.updateVisitsData();
          this.resetDrawing();
          this.updateStatsCounts();
        },
      });

      return savedPlace;
    }

    async deletePlace(placeId) {
      const placeToDelete = this.places.get(placeId);

      const success = await this.actions.deletePlace(
        placeId,
        placeToDelete,
        async () => {
          this.mapController.removePlace(placeId);
          this.places.delete(placeId);
          await this.updateVisitsData();
          this.uiManager.refreshManagePlacesModal(this.places);
          this.updateStatsCounts();
        },
      );

      return success;
    }

    async saveEditedPlace() {
      const placeId = document.getElementById("edit-place-id")?.value;
      const newNameInput = document.getElementById("edit-place-name");
      const newName = newNameInput?.value.trim();
      const placeToUpdate = this.places.get(placeId);
      const currentPolygon = this.drawing.getCurrentPolygon();
      const placeBeingEdited = this.drawing.getPlaceBeingEdited();

      // Only include geometry if editing the same place that was started for edit
      const newGeometry =
        currentPolygon && placeBeingEdited === placeId
          ? currentPolygon.geometry
          : null;

      const updatedPlace = await this.actions.saveEditedPlace({
        placeId,
        newName,
        place: placeToUpdate,
        newGeometry,
        onSuccess: async (place, hadGeometry) => {
          this.places.set(placeId, place);
          this.mapController.removePlace(placeId);
          this.mapController.addPlace(place);
          await this.updateVisitsData();

          if (hadGeometry) {
            this.resetDrawing();
          }
        },
      });

      return updatedPlace;
    }

    // --- Drawing Delegation ---

    startDrawing() {
      this.drawing.startDrawing();
    }

    clearCurrentDrawing() {
      this.drawing.clearCurrentDrawing();
    }

    resetDrawing(removeControl = true) {
      this.drawing.resetDrawing(removeControl);
    }

    startEditingPlaceBoundary() {
      const placeId = document.getElementById("edit-place-id")?.value;
      const place = this.places.get(placeId);
      this.drawing.startEditingPlaceBoundary(placeId, place, this.map);
    }

    applySuggestion(suggestion) {
      if (!suggestion || !suggestion.boundary) {
        return;
      }

      this.drawing.applySuggestion(suggestion);
      this.mapController.animateToPlace({ geometry: suggestion.boundary });

      const customTab = document.getElementById("custom-places-tab");
      if (customTab) {
        bootstrap.Tab.getOrCreateInstance(customTab).show();
      }

      this.uiManager.previewSuggestion(suggestion);
    }

    // --- Tables ---

    initializeTables() {
      this.visitsTable = window.VisitsTableFactory.createVisitsTable({
        onPlaceSelected: (placeId) => this.uiManager.toggleView(placeId),
      });
      this.nonCustomVisitsTable =
        window.VisitsTableFactory.createNonCustomVisitsTable();
      this.tripsTable = window.VisitsTableFactory.createTripsTable({
        onTripSelected: (tripId) => this.confirmViewTripOnMap(tripId),
      });
      this.suggestionsTable = window.VisitsTableFactory.createSuggestionsTable({
        onCreatePlace: (suggestion) => this.applySuggestion(suggestion),
        onPreview: (suggestion) =>
          this.mapController.previewSuggestion(suggestion),
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
        window.VisitsHelpers.extractTripGeometry(trip);
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
        window.notificationManager?.show(
          "No custom places found to zoom to.",
          "info",
        );
        return;
      }
      this.mapController.zoomToFitAllPlaces();
    }

    async showPlaceStatistics(placeId, lngLat = null) {
      const place = this.places.get(placeId);
      if (!place) {
        return;
      }

      await this.popup.showPlaceStatistics(placeId, place, lngLat);
    }

    // --- Cleanup ---

    destroy() {
      this.statsManager.destroy();
      this.map?.remove();
      this.chartManager.destroy();
      this.visitsTable?.destroy();
      this.nonCustomVisitsTable?.destroy();
      this.tripsTable?.destroy();
      this.suggestionsTable?.destroy();
    }
  }

  window.VisitsManager = VisitsManager;
})();
