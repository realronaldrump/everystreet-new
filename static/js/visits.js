/* global Chart, DateUtils, bootstrap, $, MapboxDraw, confirmationDialog, loadingManager, mapBase, notificationManager */

(() => {
  class VisitsManager {
    constructor() {
      this.map = null;
      this.draw = null;
      this.currentPolygon = null;
      this.drawingEnabled = false;
      this.isDetailedView = false;
      this.placeBeingEdited = null;
      this.isCustomPlacesVisible = true;

      this.places = new Map();
      this.loadingManager = window.loadingManager;
      this.chartManager = new window.VisitsChartManager("visitsChart");
      this.mapController = new window.VisitsMapController({
        geometryUtils: window.VisitsGeometry,
        mapStyles: window.MapStyles,
        onPlaceClicked: (placeId, lngLat) =>
          this.showPlaceStatistics(placeId, lngLat),
      });
      this.tripViewer = new window.TripViewer({
        geometryUtils: window.VisitsGeometry,
        mapStyles: window.MapStyles,
      });

      this.visitsTable = null;
      this.tripsTable = null;
      this.nonCustomVisitsTable = null;
      this.suggestionsTable = null;

      this.statsUpdateTimer = null;

      VisitsManager.setupDurationSorting();
      this.initialize();
    }

    async initialize() {
      VisitsManager.showInitialLoading();
      this.loadingManager.startOperation("Initializing Visits Page");
      try {
        await this.mapController.initialize(VisitsManager.getCurrentTheme());
        this.map = this.mapController.getMap();
        this.initializeDrawControls();
        this.initializeTables();
        this.setupEventListeners();
        VisitsManager.setupEnhancedUI();

        await Promise.all([
          this.loadPlaces(),
          this.loadNonCustomPlacesVisits(),
          this.loadSuggestions(),
        ]);

        this.updateStatsCounts();
        this.startStatsAnimation();
        this.loadingManager.finish("Initializing Visits Page");
        VisitsManager.hideInitialLoading();
      } catch (error) {
        console.error("Error initializing visits page:", error);
        this.loadingManager.error("Failed to initialize visits page");
        VisitsManager.showErrorState();
      }
    }

    static getCurrentTheme() {
      return document.documentElement.getAttribute("data-bs-theme") || "dark";
    }

    static showInitialLoading() {
      const loadingOverlay = document.getElementById("map-loading");
      if (loadingOverlay) {
        loadingOverlay.style.display = "flex";
        loadingOverlay.style.opacity = "1";
        loadingOverlay.style.pointerEvents = "all";
      }
    }

    static hideInitialLoading() {
      const loadingOverlay = document.getElementById("map-loading");
      if (loadingOverlay) {
        loadingOverlay.style.pointerEvents = "none";
        setTimeout(() => {
          loadingOverlay.style.transition = "opacity 0.3s ease";
          loadingOverlay.style.opacity = "0";
          setTimeout(() => {
            loadingOverlay.style.display = "none";
          }, 300);
        }, 500);
      }
    }

    static showErrorState() {
      const mapContainer = document.getElementById("map");
      if (mapContainer) {
        mapContainer.innerHTML = `
          <div class="empty-state">
            <i class="fas fa-exclamation-triangle"></i>
            <h5>Unable to Load Map</h5>
            <p>Please refresh the page to try again</p>
          </div>
        `;
      }
    }

    static setupEnhancedUI() {
      document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
        anchor.addEventListener("click", (e) => {
          e.preventDefault();
          const href = anchor.getAttribute("href");
          if (href && href !== "#") {
            try {
              const target = document.querySelector(href);
              if (target) {
                target.scrollIntoView({ behavior: "smooth", block: "start" });
              }
            } catch (_e) {
              console.warn("Invalid selector for smooth scroll:", href);
            }
          }
        });
      });

      const tooltipTriggerList = [].slice.call(
        document.querySelectorAll('[data-bs-toggle="tooltip"]'),
      );
      tooltipTriggerList.forEach((tooltipTriggerEl) => {
        new bootstrap.Tooltip(tooltipTriggerEl, {
          template:
            '<div class="tooltip" role="tooltip"><div class="tooltip-arrow"></div><div class="tooltip-inner bg-primary"></div></div>',
        });
      });

      document.querySelectorAll(".action-button").forEach((button) => {
        button.addEventListener("click", (e) => {
          const ripple = document.createElement("span");
          const rect = button.getBoundingClientRect();
          const size = Math.max(rect.width, rect.height);
          const x = e.clientX - rect.left - size / 2;
          const y = e.clientY - rect.top - size / 2;

          ripple.style.position = "absolute";
          ripple.style.width = ripple.style.height = `${size}px`;
          ripple.style.left = `${x}px`;
          ripple.style.top = `${y}px`;
          ripple.classList.add("ripple");

          button.appendChild(ripple);
          setTimeout(() => ripple.remove(), 600);
        });
      });

      document.querySelectorAll(".place-name-input").forEach((input) => {
        input.addEventListener("focus", () => {
          input.parentElement.classList.add("focused");
        });

        input.addEventListener("blur", () => {
          if (!input.value) {
            input.parentElement.classList.remove("focused");
          }
        });
      });
    }

    startStatsAnimation() {
      VisitsManager.animateCounter(
        "total-places-count",
        this.places.size,
        1000,
      );
      VisitsManager.updateMonthlyVisits();
      this.statsUpdateTimer = setInterval(() => {
        this.updateStatsCounts();
      }, 30000);
    }

    static animateCounter(elementId, targetValue, duration = 1000) {
      const element = document.getElementById(elementId);
      if (!element) return;

      const startValue = parseInt(element.textContent, 10) || 0;
      const increment = (targetValue - startValue) / (duration / 16);
      let currentValue = startValue;

      const animate = () => {
        currentValue += increment;
        if (
          (increment > 0 && currentValue >= targetValue) ||
          (increment < 0 && currentValue <= targetValue)
        ) {
          element.textContent = targetValue;
        } else {
          element.textContent = Math.round(currentValue);
          requestAnimationFrame(animate);
        }
      };

      requestAnimationFrame(animate);
    }

    async updateStatsCounts() {
      document.getElementById("total-places-count").textContent =
        this.places.size;
      document.getElementById("active-places-stat").textContent =
        this.places.size;

      try {
        const customStats =
          await window.VisitsDataService.fetchPlaceStatistics();
        const totalVisits = customStats.reduce(
          (sum, p) => sum + (p.totalVisits || 0),
          0,
        );
        VisitsManager.animateCounter("total-visits-count", totalVisits);
      } catch (error) {
        console.error("Error updating stats:", error);
      }
    }

    static async updateMonthlyVisits() {
      try {
        const stats = await window.VisitsDataService.fetchPlaceStatistics({
          timeframe: "month",
        });
        const monthlyVisits = stats.reduce(
          (sum, p) => sum + (p.monthlyVisits || p.totalVisits || 0),
          0,
        );
        VisitsManager.animateCounter("month-visits-stat", monthlyVisits);
      } catch (error) {
        console.error("Error updating monthly visits:", error);
      }
    }

    initializeTables() {
      this.visitsTable = window.VisitsTableFactory.createVisitsTable({
        onPlaceSelected: (placeId) => this.toggleView(placeId),
      });
      this.nonCustomVisitsTable =
        window.VisitsTableFactory.createNonCustomVisitsTable();
      this.tripsTable = window.VisitsTableFactory.createTripsTable({
        onTripSelected: (tripId) => this.confirmViewTripOnMap(tripId),
      });
      this.suggestionsTable = window.VisitsTableFactory.createSuggestionsTable({
        onCreatePlace: (suggestion) => this.applySuggestion(suggestion),
        onPreview: (suggestion) => this.previewSuggestion(suggestion),
      });
    }

    setupEventListeners() {
      document
        .getElementById("start-drawing")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          this.startDrawing();
        });

      document
        .getElementById("save-place")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          this.savePlace();
        });

      document
        .getElementById("clear-drawing")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          this.clearCurrentDrawing();
        });

      document
        .getElementById("zoom-to-fit")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          this.zoomToFitAllPlaces();
        });

      document
        .getElementById("manage-places")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          this.showManagePlacesModal();
        });

      document
        .getElementById("edit-place-form")
        ?.addEventListener("submit", (e) => {
          e.preventDefault();
          this.saveEditedPlace();
        });

      document
        .getElementById("edit-place-boundary")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          this.startEditingPlaceBoundary();
        });

      document
        .getElementById("toggle-custom-places")
        ?.addEventListener("change", (e) =>
          this.toggleCustomPlacesVisibility(e.target.checked),
        );

      document
        .getElementById("back-to-places-btn")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          this.toggleView();
        });

      document
        .getElementById("map-style-toggle")
        ?.addEventListener("click", () => {
          this.mapController.toggleMapStyle();
        });

      document
        .getElementById("time-filter")
        ?.addEventListener("change", (e) => {
          this.filterByTimeframe(e.target.value);
        });

      document.addEventListener("keydown", (e) => {
        if (e.ctrlKey || e.metaKey) {
          switch (e.key) {
            case "d":
              e.preventDefault();
              document.getElementById("start-drawing")?.click();
              break;
            case "s":
              e.preventDefault();
              if (!document.getElementById("save-place")?.disabled) {
                document.getElementById("save-place")?.click();
              }
              break;
            case "z":
              e.preventDefault();
              document.getElementById("zoom-to-fit")?.click();
              break;
            default:
              // Other keys - no action needed
              break;
          }
        }
      });
    }

    async filterByTimeframe(timeframe) {
      const tables = [this.visitsTable, this.nonCustomVisitsTable];
      tables.forEach((table) => {
        table?.processing?.(true);
      });

      try {
        const [customStats, otherStats] = await Promise.all([
          window.VisitsDataService.fetchPlaceStatistics({ timeframe }),
          window.VisitsDataService.fetchNonCustomVisits({ timeframe }),
        ]);

        this.updateVisitsData(customStats);
        this.nonCustomVisitsTable?.clear().rows.add(otherStats).draw();
        await this.loadSuggestions();
      } catch (error) {
        console.error("Error filtering by timeframe:", error);
        window.notificationManager?.show("Error filtering data", "danger");
      } finally {
        tables.forEach((table) => {
          table?.processing?.(false);
        });
      }
    }

    async loadPlaces() {
      this.loadingManager.startOperation("Loading Places");
      try {
        const places = await window.VisitsDataService.fetchPlaces();
        this.places = new Map(places.map((place) => [place._id, place]));
        this.mapController.setPlaces(places);

        await this.updateVisitsData();
        this.updateStatsCounts();
        this.loadingManager.finish("Loading Places");
      } catch (error) {
        console.error("Error loading places:", error);
        window.notificationManager?.show(
          "Failed to load custom places",
          "danger",
        );
        this.loadingManager.error("Failed during Loading Places");
      }
    }

    async updateVisitsData(statsData = null) {
      this.loadingManager.startOperation("Updating Statistics");
      const placeEntries = Array.from(this.places.entries());
      if (placeEntries.length === 0) {
        this.chartManager.update([], null);
        this.visitsTable?.clear().draw();
        VisitsManager.updateInsights([]);
        this.loadingManager.finish("Updating Statistics");
        return;
      }

      try {
        const statsList =
          statsData || (await window.VisitsDataService.fetchPlaceStatistics());

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
            this.toggleView(placeId);
          }
        });

        this.visitsTable?.clear().rows.add(validResults).draw();
        VisitsManager.updateInsights(statsList);
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

    static updateInsights(stats) {
      if (!stats || stats.length === 0) {
        document.getElementById("most-visited-place").textContent = "-";
        document.getElementById("avg-visit-duration").textContent = "-";
        document.getElementById("visit-frequency").textContent = "-";
        return;
      }

      const mostVisited = stats.reduce((max, place) =>
        place.totalVisits > max.totalVisits ? place : max,
      );
      document.getElementById("most-visited-place").textContent =
        `${mostVisited.name} (${mostVisited.totalVisits} visits)`;

      const avgDurations = stats
        .filter((s) => s.averageTimeSpent && s.averageTimeSpent !== "N/A")
        .map((s) => DateUtils.convertDurationToSeconds(s.averageTimeSpent));

      if (avgDurations.length > 0) {
        const overallAvg =
          avgDurations.reduce((a, b) => a + b, 0) / avgDurations.length;
        const formatted = DateUtils.formatDuration(overallAvg * 1000);
        document.getElementById("avg-visit-duration").textContent = formatted;
      }

      const totalVisits = stats.reduce(
        (sum, place) => sum + place.totalVisits,
        0,
      );
      const firstVisitDate = stats
        .filter((s) => s.firstVisit)
        .map((s) => new Date(s.firstVisit))
        .reduce((min, date) => (date < min ? date : min), new Date());

      const weeksSinceFirst =
        (Date.now() - firstVisitDate) / (1000 * 60 * 60 * 24 * 7);
      const visitsPerWeek = (
        totalVisits / Math.max(weeksSinceFirst, 1)
      ).toFixed(1);
      document.getElementById("visit-frequency").textContent =
        `${visitsPerWeek} visits/week`;
    }

    async savePlace() {
      const placeNameInput = document.getElementById("place-name");
      const placeName = placeNameInput?.value.trim();

      if (!placeName) {
        VisitsManager.showInputError(
          placeNameInput,
          "Please enter a name for the place.",
        );
        return;
      }
      if (!this.currentPolygon) {
        window.notificationManager?.show(
          "Please draw a boundary for the place first.",
          "warning",
        );
        return;
      }

      const saveBtn = document.getElementById("save-place");
      saveBtn.classList.add("loading");
      saveBtn.innerHTML =
        '<span class="spinner-border spinner-border-sm me-2"></span>Saving...';

      this.loadingManager.startOperation("Saving Place");
      try {
        const savedPlace = await window.VisitsDataService.createPlace({
          name: placeName,
          geometry: this.currentPolygon.geometry,
        });

        this.places.set(savedPlace._id, savedPlace);
        this.mapController.addPlace(savedPlace);
        this.mapController.animateToPlace(savedPlace);

        await this.updateVisitsData();
        this.resetDrawing();

        window.notificationManager?.show(
          `Place "${placeName}" saved successfully!`,
          "success",
        );

        this.updateStatsCounts();
      } catch (error) {
        console.error("Error saving place:", error);
        window.notificationManager?.show(
          "Failed to save place. Please try again.",
          "danger",
        );
      } finally {
        saveBtn.classList.remove("loading");
        saveBtn.innerHTML =
          '<i class="fas fa-save me-2"></i><span>Save Place</span>';
        this.loadingManager.finish("Saving Place");
      }
    }

    static showInputError(input, message) {
      input?.classList.add("is-invalid");
      window.notificationManager?.show(message, "warning");
      input?.focus();
      input?.addEventListener(
        "input",
        () => {
          input.classList.remove("is-invalid");
        },
        { once: true },
      );
    }

    async deletePlace(placeId) {
      const placeToDelete = this.places.get(placeId);
      if (!placeToDelete) {
        window.notificationManager?.show(
          "Attempted to delete non-existent place.",
          "warning",
        );
        return;
      }

      let confirmed = false;
      if (window.confirmationDialog) {
        confirmed = await window.confirmationDialog.show({
          title: "Delete Place",
          message: `Are you sure you want to delete the place "<strong>${placeToDelete.name}</strong>"? This cannot be undone.`,
          confirmText: "Delete",
          confirmButtonClass: "btn-danger",
        });
      } else {
        confirmed = true;
      }

      if (!confirmed) return;

      this.loadingManager.startOperation("Deleting Place");
      try {
        await window.VisitsDataService.deletePlace(placeId);
        this.mapController.removePlace(placeId);
        this.places.delete(placeId);

        await this.updateVisitsData();
        this.refreshManagePlacesModal();
        this.updateStatsCounts();

        window.notificationManager?.show(
          `Place "${placeToDelete.name}" deleted successfully.`,
          "success",
        );
      } catch (error) {
        console.error("Error deleting place:", error);
        window.notificationManager?.show(
          "Failed to delete place. Please try again.",
          "danger",
        );
      } finally {
        this.loadingManager.finish("Deleting Place");
      }
    }

    startDrawing() {
      if (this.drawingEnabled || !this.draw) return;

      this.resetDrawing(false);
      this.draw.changeMode("draw_polygon");
      this.drawingEnabled = true;

      const drawBtn = document.getElementById("start-drawing");
      drawBtn?.classList.add("active");
      document.getElementById("save-place")?.setAttribute("disabled", true);

      const notification = window.notificationManager?.show(
        "Click on the map to start drawing the place boundary. Click the first point or press Enter to finish.",
        "info",
        0,
      );
      this.drawingNotification = notification;
    }

    onPolygonCreated(event) {
      if (!event?.features || event.features.length === 0) return;

      if (this.currentPolygon) {
        this.draw.delete(this.currentPolygon.id);
      }

      this.currentPolygon = event.features[0];
      this.drawingEnabled = false;

      document.getElementById("start-drawing")?.classList.remove("active");
      document.getElementById("save-place")?.removeAttribute("disabled");

      if (this.drawingNotification) {
        this.drawingNotification.remove();
      }

      window.notificationManager?.show(
        "Boundary drawn! Enter a name and click Save Place.",
        "success",
      );

      document.getElementById("place-name")?.focus();
    }

    clearCurrentDrawing() {
      if (this.currentPolygon) {
        this.draw.delete(this.currentPolygon.id);
        this.currentPolygon = null;
        document.getElementById("save-place")?.setAttribute("disabled", true);
        window.notificationManager?.show("Drawing cleared.", "info");
      }

      if (this.drawingEnabled) {
        this.draw.changeMode("simple_select");
        this.drawingEnabled = false;
        document.getElementById("start-drawing")?.classList.remove("active");
      }
    }

    resetDrawing(removeControl = true) {
      if (this.currentPolygon) {
        this.draw.delete(this.currentPolygon.id);
        this.currentPolygon = null;
      }

      const placeNameInput = document.getElementById("place-name");
      const savePlaceBtn = document.getElementById("save-place");
      const startDrawingBtn = document.getElementById("start-drawing");

      if (placeNameInput) {
        placeNameInput.value = "";
        placeNameInput.classList.remove("is-invalid");
      }
      if (savePlaceBtn) savePlaceBtn.setAttribute("disabled", true);
      if (startDrawingBtn) startDrawingBtn.classList.remove("active");

      if (this.drawingEnabled && removeControl) {
        this.draw.changeMode("simple_select");
      }
      this.drawingEnabled = false;
      this.placeBeingEdited = null;
    }

    showManagePlacesModal() {
      const modalElement = document.getElementById("manage-places-modal");
      if (!modalElement) return;

      const modal = bootstrap.Modal.getOrCreateInstance(modalElement);
      this.refreshManagePlacesModal();
      modal.show();
    }

    refreshManagePlacesModal() {
      const tableBody = document.querySelector("#manage-places-table tbody");
      if (!tableBody) return;

      tableBody.innerHTML = "";
      const placesArray = Array.from(this.places.values());
      placesArray.sort((a, b) => a.name.localeCompare(b.name));

      if (placesArray.length === 0) {
        tableBody.innerHTML = `
          <tr>
            <td colspan="3" class="text-center">
              <div class="empty-state py-4">
                <i class="fas fa-map-marked-alt"></i>
                <h5>No Custom Places Yet</h5>
                <p>Draw your first place on the map to get started</p>
              </div>
            </td>
          </tr>
        `;
        return;
      }

      placesArray.forEach((place, index) => {
        const row = tableBody.insertRow();
        const createdDate = place.createdAt
          ? DateUtils.formatForDisplay(place.createdAt, { dateStyle: "medium" })
          : "Unknown";

        row.innerHTML = `
          <td>
            <i class="fas fa-map-marker-alt me-2 text-primary"></i>
            ${place.name}
          </td>
          <td class="text-center text-muted">${createdDate}</td>
          <td class="text-center">
            <div class="btn-group btn-group-sm" role="group">
              <button type="button" class="btn btn-primary edit-place-btn" data-place-id="${place._id}" title="Edit Name/Boundary">
                <i class="fas fa-edit"></i> Edit
              </button>
              <button type="button" class="btn btn-danger delete-place-btn" data-place-id="${place._id}" title="Delete Place">
                <i class="fas fa-trash-alt"></i> Delete
              </button>
            </div>
          </td>
        `;

        row.style.opacity = "0";
        setTimeout(() => {
          row.style.transition = "opacity 0.3s ease";
          row.style.opacity = "1";
        }, index * 50);

        row.querySelector(".edit-place-btn").addEventListener("click", (e) => {
          const placeId = e.currentTarget.getAttribute("data-place-id");
          bootstrap.Modal.getInstance(
            document.getElementById("manage-places-modal"),
          )?.hide();
          this.showEditPlaceModal(placeId);
        });

        row
          .querySelector(".delete-place-btn")
          .addEventListener("click", (e) => {
            const placeId = e.currentTarget.getAttribute("data-place-id");
            bootstrap.Modal.getInstance(
              document.getElementById("manage-places-modal"),
            )?.hide();
            this.deletePlace(placeId);
          });
      });
    }

    showEditPlaceModal(placeId) {
      const place = this.places.get(placeId);
      if (!place) return;

      const modalElement = document.getElementById("edit-place-modal");
      if (!modalElement) return;

      document.getElementById("edit-place-id").value = placeId;
      document.getElementById("edit-place-name").value = place.name;

      this.placeBeingEdited = null;
      if (this.currentPolygon) {
        this.resetDrawing();
      }

      const modal = bootstrap.Modal.getOrCreateInstance(modalElement);
      modal.show();
    }

    async showPlaceStatistics(placeId, lngLat = null) {
      const place = this.places.get(placeId);
      if (!place) return;

      let targetLngLat = lngLat;
      if (!targetLngLat && place.geometry?.coordinates) {
        const coords = window.VisitsGeometry.collectCoordinates(place.geometry);
        if (coords.length) {
          targetLngLat = { lng: coords[0][0], lat: coords[0][1] };
        }
      }

      const popup = this.mapController.showPlacePopup(
        `
        <div class="custom-place-popup">
          <h6><i class="fas fa-map-marker-alt me-2"></i>${place.name}</h6>
          <div class="text-center py-3">
            <div class="spinner-border spinner-border-sm text-primary" role="status">
              <span class="visually-hidden">Loading...</span>
            </div>
            <p class="mb-0 mt-2 text-muted small">Fetching statistics...</p>
          </div>
        </div>
      `,
        targetLngLat,
      );

      try {
        const stats =
          await window.VisitsDataService.fetchPlaceDetailStatistics(placeId);
        const formatDate = (dateStr) =>
          dateStr
            ? DateUtils.formatForDisplay(dateStr, { dateStyle: "medium" })
            : "N/A";
        const formatAvg = (value) => value || "N/A";

        const popupContent = `
          <div class="custom-place-popup">
            <h6><i class="fas fa-map-marker-alt me-2 text-primary"></i>${place.name}</h6>
            <div class="stats-grid">
              <p>
                <span class="stat-label">Total Visits</span>
                <strong class="stat-value text-primary">${stats.totalVisits || 0}</strong>
              </p>
              <p>
                <span class="stat-label">First Visit</span>
                <strong class="stat-value">${formatDate(stats.firstVisit)}</strong>
              </p>
              <p>
                <span class="stat-label">Last Visit</span>
                <strong class="stat-value">${formatDate(stats.lastVisit)}</strong>
              </p>
              <p>
                <span class="stat-label">Avg Duration</span>
                <strong class="stat-value text-success">${formatAvg(stats.averageTimeSpent)}</strong>
              </p>
              <p>
                <span class="stat-label">Time Since Last</span>
                <strong class="stat-value text-info">${formatAvg(stats.averageTimeSinceLastVisit)}</strong>
              </p>
            </div>
            <hr style="margin: 10px 0; opacity: 0.2;">
            <div class="d-grid gap-2">
              <button class="btn btn-sm btn-primary view-trips-btn" data-place-id="${placeId}">
                <i class="fas fa-list-ul me-1"></i> View All Trips
              </button>
              <button class="btn btn-sm btn-outline-primary zoom-to-place-btn" data-place-id="${placeId}">
                <i class="fas fa-search-plus me-1"></i> Zoom to Place
              </button>
            </div>
          </div>`;

        popup?.setHTML(popupContent);

        setTimeout(() => {
          const popupNode = popup?.getElement();
          popupNode
            ?.querySelector(".view-trips-btn")
            ?.addEventListener("click", (e) => {
              e.preventDefault();
              const id = e.currentTarget.getAttribute("data-place-id");
              if (id) {
                this.mapController.closePopup();
                this.toggleView(id);
              }
            });

          popupNode
            ?.querySelector(".zoom-to-place-btn")
            ?.addEventListener("click", (e) => {
              e.preventDefault();
              const id = e.currentTarget.getAttribute("data-place-id");
              if (id) {
                const zoomPlace = this.places.get(id);
                if (zoomPlace) {
                  this.mapController.animateToPlace(zoomPlace);
                }
              }
            });
        }, 100);
      } catch (error) {
        console.error("Error fetching place statistics:", error);
        popup?.setHTML(
          `<div class="custom-place-popup">
            <h6><i class="fas fa-map-marker-alt me-2"></i>${place.name}</h6>
            <div class="alert alert-danger mb-0">
              <i class="fas fa-exclamation-triangle me-2"></i>
              Error loading statistics
            </div>
          </div>`,
        );
        window.notificationManager?.show(
          "Failed to fetch place statistics",
          "danger",
        );
      }
    }

    async toggleView(placeId = null) {
      const mainViewContainer = document.getElementById(
        "visits-table-container",
      );
      const detailViewContainer = document.getElementById(
        "trips-for-place-container",
      );

      if (placeId) {
        const place = this.places.get(placeId);
        if (!place) {
          console.error(
            `Cannot switch to detail view: Place ID ${placeId} not found.`,
          );
          window.notificationManager?.show(
            "Could not find the selected place.",
            "warning",
          );
          return;
        }

        mainViewContainer.style.opacity = "0";
        setTimeout(() => {
          this.isDetailedView = true;
          mainViewContainer.style.display = "none";
          detailViewContainer.style.display = "block";
          detailViewContainer.style.opacity = "0";

          setTimeout(() => {
            detailViewContainer.style.transition = "opacity 0.3s ease";
            detailViewContainer.style.opacity = "1";
          }, 50);
        }, 300);

        const placeNameElement = document.getElementById("selected-place-name");
        if (placeNameElement) placeNameElement.textContent = place.name;

        await this.showTripsForPlace(placeId);
        this.mapController.animateToPlace(place);
      } else {
        detailViewContainer.style.opacity = "0";
        setTimeout(() => {
          this.isDetailedView = false;
          detailViewContainer.style.display = "none";
          mainViewContainer.style.display = "block";
          mainViewContainer.style.opacity = "0";

          setTimeout(() => {
            mainViewContainer.style.transition = "opacity 0.3s ease";
            mainViewContainer.style.opacity = "1";
          }, 50);
        }, 300);

        this.visitsTable?.columns.adjust().responsive?.recalc?.();
      }
    }

    async showTripsForPlace(placeId) {
      if (!this.tripsTable) {
        console.error("Trips table not initialized.");
        return;
      }
      this.loadingManager.startOperation("Loading Trips");
      this.tripsTable.clear().draw();

      try {
        const data = await window.VisitsDataService.fetchPlaceTrips(placeId);
        const trips = data.trips || [];
        this.tripsTable.rows.add(trips).draw();

        const placeNameElement = document.getElementById("selected-place-name");
        if (placeNameElement && data.name)
          placeNameElement.textContent = data.name;
      } catch (error) {
        console.error(`Error fetching trips for place ${placeId}:`, error);
        window.notificationManager?.show(
          "Failed to fetch trips for the selected place.",
          "danger",
        );
        this.tripsTable.clear().draw();
      } finally {
        this.loadingManager.finish("Loading Trips");
      }
    }

    async loadNonCustomPlacesVisits() {
      if (!this.nonCustomVisitsTable) return;
      this.loadingManager.updateMessage("Loading other locations...");
      try {
        const visitsData =
          await window.VisitsDataService.fetchNonCustomVisits();
        this.nonCustomVisitsTable.clear().rows.add(visitsData).draw();
      } catch (error) {
        console.error("Error fetching non-custom places visits:", error);
        window.notificationManager?.show(
          "Failed to load non-custom places visits",
          "danger",
        );
      }
    }

    toggleCustomPlacesVisibility(isVisible) {
      this.isCustomPlacesVisible = isVisible;
      this.mapController.toggleCustomPlacesVisibility(isVisible);

      const customContent = document.getElementById("custom-places-content");
      const customTabButton = document.getElementById("custom-places-tab");

      if (isVisible) {
        customContent?.classList.remove("hidden");
        if (customTabButton?.parentElement) {
          customTabButton.parentElement.style.display = "";
        }

        if (!customTabButton?.classList.contains("active")) {
          const nonCustomTab = document.getElementById("non-custom-places-tab");
          if (nonCustomTab?.classList.contains("active")) {
            bootstrap.Tab.getOrCreateInstance(customTabButton)?.show();
          }
        }
      } else {
        customContent?.classList.add("hidden");
        if (customTabButton?.parentElement) {
          customTabButton.parentElement.style.display = "none";
        }

        if (customTabButton?.classList.contains("active")) {
          const nonCustomTab = document.getElementById("non-custom-places-tab");
          if (nonCustomTab) {
            bootstrap.Tab.getOrCreateInstance(nonCustomTab)?.show();
          }
        }
      }
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

    confirmViewTripOnMap(tripId) {
      if (!tripId) return;
      this.fetchAndShowTrip(tripId);
    }

    async fetchAndShowTrip(tripId) {
      this.loadingManager.startOperation("Loading Trip");
      try {
        const tripResponse = await window.VisitsDataService.fetchTrip(tripId);
        const trip = tripResponse.trip || tripResponse;
        VisitsManager.extractTripGeometry(trip);
        this.tripViewer.showTrip(trip);
      } catch (error) {
        console.error("Error fetching or showing trip data:", error);
        this.loadingManager.error("Failed to fetch trip data");
        window.notificationManager?.show(
          "Error loading trip data. Please try again.",
          "danger",
        );
      } finally {
        this.loadingManager.finish("Loading Trip");
        document.querySelectorAll(".view-trip-btn.loading").forEach((btn) => {
          btn.classList.remove("loading");
        });
      }
    }

    destroy() {
      if (this.statsUpdateTimer) {
        clearInterval(this.statsUpdateTimer);
      }

      document.removeEventListener("keydown", this.keyboardHandler);
      this.map?.remove();
      this.chartManager.destroy();
      this.visitsTable?.destroy();
      this.nonCustomVisitsTable?.destroy();
      this.tripsTable?.destroy();
      this.suggestionsTable?.destroy();
    }

    static setupDurationSorting() {
      if (window.$ && $.fn.dataTable) {
        $.fn.dataTable.ext.type.order["duration-pre"] = (data) =>
          DateUtils.convertDurationToSeconds(data);
      }
    }

    static extractTripGeometry(trip) {
      if (
        trip.gps &&
        typeof trip.gps === "object" &&
        trip.gps.type === "LineString" &&
        trip.gps.coordinates &&
        trip.gps.coordinates.length > 0
      ) {
        trip.geometry = trip.gps;
        return;
      }

      if (trip.geometry?.coordinates?.length > 0) {
        return;
      }
      if (
        trip.matchedGps?.coordinates &&
        trip.matchedGps.coordinates.length > 0
      ) {
        trip.geometry = trip.matchedGps;
        return;
      }
      if (typeof trip.gps === "string" && trip.gps) {
        try {
          const gpsData = JSON.parse(trip.gps);
          if (gpsData?.coordinates?.length > 0) {
            trip.geometry = gpsData;
            return;
          }
        } catch (e) {
          console.error("Failed to parse gps JSON", e);
          window.notificationManager?.show(
            "Failed to parse gps JSON.",
            "danger",
          );
        }
      }
      if (
        trip.startGeoPoint?.coordinates &&
        trip.destinationGeoPoint?.coordinates
      ) {
        trip.geometry = {
          type: "LineString",
          coordinates: [
            trip.startGeoPoint.coordinates,
            trip.destinationGeoPoint.coordinates,
          ],
        };
      }
    }

    async saveEditedPlace() {
      const placeId = document.getElementById("edit-place-id")?.value;
      const newNameInput = document.getElementById("edit-place-name");
      const newName = newNameInput?.value.trim();

      if (!placeId || !newName) {
        window.notificationManager?.show(
          "Place ID or Name is missing.",
          "warning",
        );
        newNameInput?.focus();
        return;
      }

      const placeToUpdate = this.places.get(placeId);
      if (!placeToUpdate) {
        window.notificationManager?.show(
          "Cannot find place to update.",
          "danger",
        );
        return;
      }

      this.loadingManager.startOperation("Updating Place");
      try {
        const requestBody = { name: newName };

        if (this.currentPolygon && this.placeBeingEdited === placeId) {
          requestBody.geometry = this.currentPolygon.geometry;
        }

        const updatedPlace = await window.VisitsDataService.updatePlace(
          placeId,
          requestBody,
        );
        this.places.set(placeId, updatedPlace);
        this.mapController.removePlace(placeId);
        this.mapController.addPlace(updatedPlace);

        await this.updateVisitsData();

        const modalEl = document.getElementById("edit-place-modal");
        if (modalEl) {
          const modal = bootstrap.Modal.getInstance(modalEl);
          modal?.hide();
        }

        if (requestBody.geometry) {
          this.resetDrawing();
        }
        this.placeBeingEdited = null;

        window.notificationManager?.show(
          `Place "${newName}" updated successfully.`,
          "success",
        );
      } catch (error) {
        console.error("Error updating place:", error);
        window.notificationManager?.show(
          "Failed to update place. Please try again.",
          "danger",
        );
      } finally {
        this.loadingManager.finish("Updating Place");
      }
    }

    startEditingPlaceBoundary() {
      const placeId = document.getElementById("edit-place-id")?.value;
      const place = this.places.get(placeId);
      if (!place) {
        window.notificationManager?.show(
          "Could not find place to edit.",
          "warning",
        );
        return;
      }

      const editModalEl = document.getElementById("edit-place-modal");
      if (editModalEl) {
        const editModal = bootstrap.Modal.getInstance(editModalEl);
        editModal?.hide();
      }

      this.resetDrawing(false);
      window.VisitsGeometry.fitMapToGeometry(this.map, place.geometry, {
        padding: 20,
      });

      this.placeBeingEdited = placeId;
      this.startDrawing();

      window.notificationManager?.show(
        `Draw the new boundary for "${place.name}". The previous boundary is shown dashed. Finish drawing, then save changes via the Manage Places modal.`,
        "info",
        10000,
      );
    }

    initializeDrawControls() {
      if (typeof MapboxDraw === "undefined") {
        console.error("MapboxDraw library not loaded");
        return;
      }

      this.draw = new MapboxDraw({
        displayControlsDefault: false,
        controls: {
          polygon: true,
          trash: true,
        },
        defaultMode: "simple_select",
        styles: [
          {
            id: "gl-draw-polygon-fill-inactive",
            type: "fill",
            filter: [
              "all",
              ["==", "$type", "Polygon"],
              ["==", "active", "false"],
            ],
            paint: {
              "fill-color": window.MapStyles.MAP_LAYER_COLORS.customPlaces.fill,
              "fill-opacity": 0.15,
            },
          },
          {
            id: "gl-draw-polygon-fill-active",
            type: "fill",
            filter: [
              "all",
              ["==", "$type", "Polygon"],
              ["==", "active", "true"],
            ],
            paint: {
              "fill-color": "#F59E0B",
              "fill-opacity": 0.1,
            },
          },
          {
            id: "gl-draw-polygon-stroke-inactive",
            type: "line",
            filter: [
              "all",
              ["==", "$type", "Polygon"],
              ["==", "active", "false"],
            ],
            paint: {
              "line-color":
                window.MapStyles.MAP_LAYER_COLORS.customPlaces.outline,
              "line-width": 2,
            },
          },
          {
            id: "gl-draw-polygon-stroke-active",
            type: "line",
            filter: [
              "all",
              ["==", "$type", "Polygon"],
              ["==", "active", "true"],
            ],
            paint: {
              "line-color":
                window.MapStyles.MAP_LAYER_COLORS.customPlaces.highlight,
              "line-width": 2,
            },
          },
          {
            id: "gl-draw-polygon-vertex-active",
            type: "circle",
            filter: ["all", ["==", "meta", "vertex"], ["==", "active", "true"]],
            paint: {
              "circle-radius": 6,
              "circle-color": "#F59E0B",
              "circle-stroke-width": 2,
              "circle-stroke-color": "#fff",
            },
          },
        ],
      });

      if (this.map) {
        this.map.addControl(this.draw, "top-left");
        this.map.on("draw.create", (e) => this.onPolygonCreated(e));
      }
    }

    updateMapTheme(theme) {
      this.mapController.updateTheme(theme);
      this.tripViewer.updateTheme(theme);
    }

    async loadSuggestions() {
      if (!this.suggestionsTable) return;
      if (this.suggestionsTable?.processing) {
        this.suggestionsTable.processing(true);
      }
      try {
        const params = {};
        const tfSelect = document.getElementById("time-filter");
        if (tfSelect?.value !== "all" && tfSelect?.value) {
          params.timeframe = tfSelect.value;
        }

        const data =
          await window.VisitsDataService.fetchVisitSuggestions(params);
        this.suggestionsTable.clear().rows.add(data).draw();
      } catch (err) {
        console.error("Error loading visit suggestions", err);
      } finally {
        if (this.suggestionsTable?.processing) {
          this.suggestionsTable.processing(false);
        }
      }
    }

    applySuggestion(suggestion) {
      if (!suggestion || !suggestion.boundary) return;

      this.resetDrawing(false);

      const feature = {
        type: "Feature",
        geometry: suggestion.boundary,
        properties: {},
      };

      if (this.draw) {
        this.draw.changeMode("simple_select");
        const [featId] = this.draw.add(feature);
        this.currentPolygon = { id: featId, ...feature };
      } else {
        this.currentPolygon = feature;
      }

      const nameInput = document.getElementById("place-name");
      if (nameInput && !nameInput.value) {
        nameInput.value = suggestion.suggestedName;
      }

      document.getElementById("save-place")?.removeAttribute("disabled");

      this.mapController.animateToPlace({ geometry: suggestion.boundary });
      const customTab = document.getElementById("custom-places-tab");
      if (customTab) {
        bootstrap.Tab.getOrCreateInstance(customTab).show();
      }

      this.previewSuggestion(suggestion);

      window.notificationManager?.show(
        "Suggestion applied! Adjust boundary or name, then click Save Place.",
        "info",
      );
    }

    previewSuggestion(suggestion) {
      this.mapController.previewSuggestion(suggestion);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (
      typeof Chart !== "undefined" &&
      typeof $ !== "undefined" &&
      typeof bootstrap !== "undefined" &&
      typeof DateUtils !== "undefined" &&
      typeof window.mapBase !== "undefined" &&
      typeof window.mapBase.createMap === "function"
    ) {
      window.visitsManager = new VisitsManager();

      const themeObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.attributeName === "data-bs-theme") {
            const newTheme =
              document.documentElement.getAttribute("data-bs-theme");
            window.visitsManager?.updateMapTheme(newTheme);
          }
        });
      });

      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-bs-theme"],
      });
    } else {
      const missingLibraries = [];
      if (typeof Chart === "undefined") missingLibraries.push("Chart.js");
      if (typeof $ === "undefined") missingLibraries.push("jQuery");
      if (typeof bootstrap === "undefined") missingLibraries.push("Bootstrap");
      if (typeof DateUtils === "undefined") missingLibraries.push("DateUtils");
      if (typeof window.mapBase === "undefined")
        missingLibraries.push("mapBase (window.mapBase)");
      else if (typeof window.mapBase.createMap !== "function")
        missingLibraries.push("mapBase.createMap (function missing)");

      const errorMessage = `Critical libraries not loaded: ${missingLibraries.join(", ")}`;
      console.error(errorMessage);

      const errorDiv = document.createElement("div");
      errorDiv.className = "alert alert-danger m-4";
      errorDiv.innerHTML = `
        <i class="fas fa-exclamation-triangle me-2"></i>
        <strong>Error:</strong> Could not load necessary components for the Visits page. 
        Please refresh the page.
      `;
      document.body.prepend(errorDiv);
    }
  });
})();
