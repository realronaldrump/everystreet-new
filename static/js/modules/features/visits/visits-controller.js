/* Visits Page Redesign - Main Controller
 * Integrates with real API endpoints and uses imperial units
 */

import { getCurrentTheme, resolveMapStyle } from "../../core/map-style-resolver.js";
import { createMap } from "../../map-core.js";
import confirmationDialog from "../../ui/confirmation-dialog.js";
import { VisitsGeometry } from "../../visits/geometry.js";
import VisitsManager from "../../visits/visits-manager.js";

const { mapboxgl } = globalThis;
const { bootstrap } = globalThis;

// Configuration for imperial units
const IMPERIAL_CONFIG = {
  // Convert meters to feet (1 meter = 3.28084 feet)
  metersToFeet: (meters) => Math.round(meters * 3.28084),
  // Suggestion sizes in feet (converted from meters)
  suggestionSizes: {
    small: 150, // ~45m
    medium: 250, // ~75m
    large: 360, // ~110m
  },
};

// Place icon - generic pin for all places
const PLACE_ICON = "📍";

const DISCOVERY_PREVIEW_COLORS = {
  fill: "#6a9fc0",
  line: "#6a9fc0",
};

const PLACE_PREVIEW_COLORS = {
  mint: { fill: "#22b7a2", line: "#49d7c3" },
  purple: { fill: "#9176d2", line: "#b39ce5" },
  sky: { fill: "#5d9fd9", line: "#82bbea" },
  slate: { fill: "#6f7f96", line: "#94a3b8" },
};

// Day names for pattern detection
const _DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

class VisitsPageController {
  constructor() {
    this.visitsManager = null;
    this.places = [];
    this.placesStats = [];
    this.suggestions = [];
    this.nonCustomPlaces = [];
    this.currentView = "cards";
    this.currentSuggestionSize = 250; // feet (converted from 75m)
    this.suggestionPage = 1;
    this.suggestionPageSize = 6;
    this.placePreviewMaps = new Map();
    this.suggestionPreviewMaps = new Map();
    this.hasProcessedPlaceDeepLink = false;
    this.activePlaceId = "";
    this.listenerAbortController = new AbortController();
    this.modalWatchdogObserver = null;
    this.visitsModalIds = ["place-detail-modal", "edit-place-modal", "view-trip-modal"];

    // Timeline pagination for the detail modal
    this.TIMELINE_PAGE_SIZE = 20;
    this.modalTrips = [];
    this.modalTimelineShown = 0;

    // DOM Elements
    this.elements = {};

    this.init();
  }

  async init() {
    this.cacheElements();
    this.setupEventListeners();

    // Initialize the existing VisitsManager for map functionality
    this.visitsManager = new VisitsManager();

    // Load initial data
    await this.loadData();
  }

  cacheElements() {
    this.elements = {
      // Hero stats
      totalPlacesCount: document.getElementById("total-places-count"),
      totalVisitsCount: document.getElementById("total-visits-count"),
      monthVisitsCount: document.getElementById("month-visits-count"),
      visitStreak: document.getElementById("visit-streak"),
      streakCard: document.getElementById("streak-card"),

      // Places section
      placesGrid: document.getElementById("places-grid"),
      placesListView: document.getElementById("places-list-view"),
      placesEmptyState: document.getElementById("places-empty-state"),

      // Patterns section
      patternsSection: document.getElementById("patterns-section"),
      patternsGrid: document.getElementById("patterns-grid"),

      // Discoveries section
      discoveriesSection: document.getElementById("discoveries-section"),
      discoveriesGrid: document.getElementById("discoveries-grid"),
      discoveriesEmptyState: document.getElementById("discoveries-empty-state"),
      discoveriesPagination: document.getElementById("discoveries-pagination"),
      discoveriesPrev: document.getElementById("discoveries-prev"),
      discoveriesNext: document.getElementById("discoveries-next"),
      discoveriesPageInfo: document.getElementById("discoveries-page-info"),
      suggestionSize: document.getElementById("suggestion-size"),

      // Map section
      drawingToast: document.getElementById("drawing-toast"),
      savePlaceForm: document.getElementById("save-place-form"),
      placeNameInput: document.getElementById("place-name"),

      // Other stops
      otherStopsSection: document.getElementById("other-stops-section"),
      otherStopsList: document.getElementById("other-stops-list"),

      // Trips section
      tripsSection: document.getElementById("trips-section"),
      selectedPlaceName: document.getElementById("selected-place-name"),
      placeStatsSummary: document.getElementById("place-stats-summary"),
      visitTimeline: document.getElementById("visit-timeline"),

      // FAB
      startDrawingFab: document.getElementById("start-drawing-fab"),

      // View toggles
      viewBtns: document.querySelectorAll(".view-btn"),
    };
  }

  setupEventListeners() {
    const { signal } = this.listenerAbortController;

    // Listen for date filter changes
    document.addEventListener(
      "filtersApplied",
      () => {
        this.loadData();
      },
      { signal }
    );

    // View toggle
    this.elements.viewBtns.forEach((btn) => {
      btn.addEventListener("click", (e) => this.handleViewToggle(e), { signal });
    });

    // Suggestion size change
    this.elements.suggestionSize?.addEventListener(
      "change",
      (e) => {
        this.currentSuggestionSize = parseInt(e.target.value, 10);
        this.suggestionPage = 1;
        this.loadSuggestions();
      },
      { signal }
    );

    this.elements.discoveriesPrev?.addEventListener(
      "click",
      () => {
        this.setSuggestionPage(this.suggestionPage - 1);
      },
      { signal }
    );

    this.elements.discoveriesNext?.addEventListener(
      "click",
      () => {
        this.setSuggestionPage(this.suggestionPage + 1);
      },
      { signal }
    );

    // Back button
    document.getElementById("back-to-places-btn")?.addEventListener(
      "click",
      () => {
        this.showPlacesSection();
      },
      { signal }
    );

    // Cancel drawing
    document.getElementById("cancel-drawing")?.addEventListener(
      "click",
      () => {
        this.cancelDrawing();
      },
      { signal }
    );

    // Discard drawing
    document.getElementById("discard-drawing")?.addEventListener(
      "click",
      () => {
        this.discardDrawing();
      },
      { signal }
    );

    this.elements.startDrawingFab?.addEventListener(
      "click",
      () => {
        this.startDrawingFromFab();
      },
      { signal }
    );

    document.getElementById("modal-edit-place")?.addEventListener(
      "click",
      () => {
        this.openEditModalForActivePlace();
      },
      { signal }
    );

    document.getElementById("modal-edit-boundary")?.addEventListener(
      "click",
      () => {
        this.startBoundaryEditForActivePlace();
      },
      { signal }
    );

    document.getElementById("modal-delete-place")?.addEventListener(
      "click",
      () => {
        void this.deleteActivePlace();
      },
      { signal }
    );

    document.getElementById("modal-timeline-show-more")?.addEventListener(
      "click",
      () => {
        const timelineEl = document.getElementById("modal-visit-timeline");
        if (timelineEl) {
          this._renderTimelineBatch(timelineEl);
        }
      },
      { signal }
    );

    document.addEventListener(
      "hidden.bs.modal",
      () => {
        this._cleanupOrphanedModalState();
      },
      { signal }
    );

    this._startModalWatchdog();
  }

  cancelDrawing() {
    this.visitsManager?.resetDrawing?.();
  }

  discardDrawing() {
    this.visitsManager?.resetDrawing?.();
  }

  startDrawingFromFab() {
    this.visitsManager?.startDrawing?.();
    document.querySelector(".map-section")?.scrollIntoView?.({
      behavior: "smooth",
      block: "start",
    });
  }

  _hideModalById(modalId) {
    const modalEl = document.getElementById(modalId);
    if (!bootstrap?.Modal || !modalEl) {
      return;
    }

    const modal =
      bootstrap.Modal.getInstance(modalEl) ||
      (modalEl.classList.contains("show")
        ? bootstrap.Modal.getOrCreateInstance(modalEl)
        : null);
    modal?.hide();
  }

  _cleanupOrphanedModalState(force = false) {
    const hasVisibleModal = Boolean(
      document.querySelector(
        '.modal.show, .modal[aria-modal="true"], .modal[style*="display: block"]'
      )
    );
    const backdrops = document.querySelectorAll(".modal-backdrop");

    if (!hasVisibleModal || force) {
      backdrops.forEach((backdrop) => backdrop.remove());
      document.body.classList.remove("modal-open");
      document.body.style.removeProperty("padding-right");
      document.body.style.removeProperty("overflow");
      document.body.removeAttribute("data-bs-overflow");
    }
  }

  _startModalWatchdog() {
    this.modalWatchdogObserver?.disconnect();
    this.modalWatchdogObserver = new MutationObserver(() => {
      requestAnimationFrame(() => this._cleanupOrphanedModalState());
    });

    if (document.body) {
      this.modalWatchdogObserver.observe(document.body, {
        childList: true,
        attributes: true,
        attributeFilter: ["class", "style"],
      });
    }
  }

  _showEditModalAfterDetailClose(editModalEl) {
    const showEditModal = () => {
      bootstrap.Modal.getOrCreateInstance(editModalEl).show();
    };

    const detailModalEl = document.getElementById("place-detail-modal");
    const detailModal = detailModalEl
      ? bootstrap?.Modal?.getInstance(detailModalEl) ||
        bootstrap?.Modal?.getOrCreateInstance(detailModalEl)
      : null;

    if (detailModalEl?.classList.contains("show") && detailModal) {
      let completed = false;
      const finalize = () => {
        if (completed) {
          return;
        }
        completed = true;
        showEditModal();
      };
      detailModalEl.addEventListener("hidden.bs.modal", finalize, { once: true });
      detailModal.hide();
      setTimeout(finalize, 450);
      return;
    }

    showEditModal();
  }

  getPlaceByIdentifier(placeId) {
    const normalizedPlaceId = this.normalizeDeepLinkValue(placeId);
    if (!normalizedPlaceId) {
      return null;
    }

    return (
      this.places.find(
        (place) =>
          this.normalizeDeepLinkValue(this.getPlaceIdentifier(place)) ===
          normalizedPlaceId
      ) || null
    );
  }

  openEditModalForActivePlace() {
    const placeId = this.activePlaceId;
    if (!placeId) {
      this.showNotification("No place selected to edit.", "warning");
      return;
    }

    const place = this.getPlaceByIdentifier(placeId);
    if (!place) {
      this.showNotification("Unable to find that place for editing.", "warning");
      return;
    }

    const editModalEl = document.getElementById("edit-place-modal");
    if (!bootstrap?.Modal || !editModalEl) {
      this.showNotification("Edit dialog is unavailable.", "error");
      return;
    }

    const editPlaceIdInput = document.getElementById("edit-place-id");
    const editPlaceNameInput = document.getElementById("edit-place-name");
    if (editPlaceIdInput) {
      editPlaceIdInput.value = this.getPlaceIdentifier(place);
    }
    if (editPlaceNameInput) {
      editPlaceNameInput.value = place.name || "";
    }

    this._showEditModalAfterDetailClose(editModalEl);
  }

  startBoundaryEditForActivePlace() {
    const placeId = this.activePlaceId;
    if (!placeId) {
      this.showNotification("No place selected to edit.", "warning");
      return;
    }

    const launchBoundaryEdit = () => {
      this._hideModalById("edit-place-modal");
      this.visitsManager?.startEditingPlaceBoundary?.(placeId);
      setTimeout(() => this._cleanupOrphanedModalState(), 450);
    };

    const detailModalEl = document.getElementById("place-detail-modal");
    const detailModal = detailModalEl
      ? bootstrap?.Modal?.getInstance(detailModalEl) ||
        bootstrap?.Modal?.getOrCreateInstance(detailModalEl)
      : null;
    if (detailModalEl?.classList.contains("show") && detailModal) {
      let completed = false;
      const finalize = () => {
        if (completed) {
          return;
        }
        completed = true;
        launchBoundaryEdit();
      };
      detailModalEl.addEventListener("hidden.bs.modal", finalize, { once: true });
      detailModal.hide();
      setTimeout(finalize, 450);
      return;
    }

    launchBoundaryEdit();
  }

  async deleteActivePlace() {
    const placeId = this.activePlaceId;
    if (!placeId || !this.visitsManager?.deletePlace) {
      return;
    }

    const deleted = await this.visitsManager.deletePlace(placeId);
    if (!deleted) {
      return;
    }

    this._hideModalById("place-detail-modal");
    this._hideModalById("edit-place-modal");
    this.activePlaceId = "";
    await this.loadData();
  }

  async loadData() {
    try {
      // Load all data in parallel
      const [places, allStats, monthStats] = await Promise.all([
        this.fetchPlaces(),
        this.fetchAllStats("all"),
        this.fetchAllStats("month"),
      ]);

      this.places = places;
      this.placesStats = this.mergePlacesWithStats(places, allStats);

      // Update hero stats
      this.updateHeroStats(allStats, monthStats);

      // Render places
      this.renderPlaces();

      // Load patterns
      this.renderPatterns();

      // Load suggestions
      await this.loadSuggestions();

      // Load other stops
      await this.loadOtherStops();

      // Deep-link to a place once after initial data is available.
      this.processInitialPlaceDeepLink();
    } catch (error) {
      console.error("Error loading visits data:", error);
      this.showNotification("Error loading data. Please try refreshing.", "error");
    }
  }

  // API Methods
  async fetchPlaces() {
    const response = await fetch("/api/places");
    if (!response.ok) {
      throw new Error("Failed to fetch places");
    }
    return response.json();
  }

  async fetchAllStats(timeframe = "all") {
    const response = await fetch(`/api/places/statistics?timeframe=${timeframe}`);
    if (!response.ok) {
      throw new Error("Failed to fetch statistics");
    }
    return response.json();
  }

  async fetchPlaceStats(placeId) {
    const response = await fetch(`/api/places/${placeId}/statistics`);
    if (!response.ok) {
      throw new Error("Failed to fetch place statistics");
    }
    return response.json();
  }

  async fetchPlaceTrips(placeId) {
    const response = await fetch(`/api/places/${placeId}/trips`);
    if (!response.ok) {
      throw new Error("Failed to fetch place trips");
    }
    return response.json();
  }

  async fetchSuggestions(cellSizeFt = 250) {
    // Convert feet to meters for API
    const cellSizeM = Math.round(cellSizeFt / 3.28084);
    const response = await fetch(
      `/api/visit_suggestions?cell_size_m=${cellSizeM}&min_visits=5`
    );
    if (!response.ok) {
      throw new Error("Failed to fetch suggestions");
    }
    return response.json();
  }

  async fetchNonCustomPlaces() {
    const response = await fetch("/api/non_custom_places_visits");
    if (!response.ok) {
      throw new Error("Failed to fetch non-custom places");
    }
    return response.json();
  }

  async createPlace(name, geometry) {
    const response = await fetch("/api/places", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, geometry }),
    });
    if (!response.ok) {
      throw new Error("Failed to create place");
    }
    return response.json();
  }

  async deletePlace(placeId) {
    const response = await fetch(`/api/places/${placeId}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      throw new Error("Failed to delete place");
    }
    return response.json();
  }

  // Data processing
  mergePlacesWithStats(places, stats) {
    return places.map((place) => {
      const placeStats = stats.find((s) => s.id === place.id) || {};
      return {
        ...place,
        totalVisits: placeStats.totalVisits || 0,
        averageTimeSpent: placeStats.averageTimeSpent || "N/A",
        firstVisit: placeStats.firstVisit,
        lastVisit: placeStats.lastVisit,
        averageTimeSinceLastVisit: placeStats.averageTimeSinceLastVisit || "N/A",
      };
    });
  }

  updateHeroStats(allStats, monthStats) {
    const totalPlaces = this.places.length;
    const totalVisits = allStats.reduce((sum, s) => sum + (s.totalVisits || 0), 0);
    const monthVisits = monthStats.reduce((sum, s) => sum + (s.totalVisits || 0), 0);

    // Calculate streak (simplified - would need individual visit data)
    const streak = this.calculateStreak(allStats);

    this.elements.totalPlacesCount.textContent = totalPlaces;
    this.elements.totalVisitsCount.textContent = totalVisits;
    this.elements.monthVisitsCount.textContent = monthVisits;

    if (streak > 1) {
      this.elements.visitStreak.textContent = streak;
      this.elements.streakCard.style.display = "block";
    }
  }

  calculateStreak(stats) {
    // Simplified streak calculation based on last visit dates
    // In production, this would analyze individual visit timestamps
    const placesWithRecentVisits = stats.filter((s) => {
      if (!s.lastVisit) {
        return false;
      }
      const lastVisit = new Date(s.lastVisit);
      const today = new Date();
      const daysDiff = (today - lastVisit) / (1000 * 60 * 60 * 24);
      return daysDiff <= 1;
    });

    return placesWithRecentVisits.length > 0
      ? Math.min(placesWithRecentVisits.length, 5)
      : 0;
  }

  // Rendering
  renderPlaces() {
    this.clearPlacePreviewMaps();

    if (this.placesStats.length === 0) {
      this.elements.placesGrid.style.display = "none";
      this.elements.placesEmptyState.style.display = "block";
      return;
    }

    this.elements.placesEmptyState.style.display = "none";

    if (this.currentView === "cards") {
      this.renderPlaceCards();
    } else {
      this.renderPlaceList();
    }
  }

  renderPlaceCards() {
    const maxVisits = Math.max(...this.placesStats.map((p) => p.totalVisits));
    const placePreviewConfigs = [];

    const cardsHTML = this.placesStats
      .map((place, index) => {
        const accent = this.getPlaceAccent(place.totalVisits, maxVisits);
        const patterns = this.detectPatterns(place);
        const isMostVisited = place.totalVisits === maxVisits && maxVisits > 0;
        const placeId = this.getPlaceIdentifier(place);
        const mapId = `place-map-${index}`;
        const geometry = this.getRenderableGeometry(place?.geometry);
        if (geometry) {
          placePreviewConfigs.push({ mapId, geometry, accent });
        }

        return `
        <div class="place-card" data-place-id="${placeId}" onclick="visitsPage.showPlaceDetail('${placeId}')">
          <div class="place-card-header ${accent}">
            <div class="place-map-preview" id="${mapId}">
              <div class="map-preview-default">
                <i class="fas fa-draw-polygon"></i>
                <span>${geometry ? "Loading boundary preview..." : "Boundary unavailable"}</span>
              </div>
            </div>
            ${isMostVisited ? '<span class="place-badge">Most visited</span>' : ""}
          </div>
          <div class="place-card-body">
            <h3 class="place-name">${this.escapeHtml(place.name)}</h3>
            <div class="place-meta">
              <div class="place-stat">
                <i class="fas fa-calendar"></i>
                <span>${place.totalVisits} visits</span>
              </div>
              <div class="place-stat">
                <i class="fas fa-clock"></i>
                <span>Avg: ${place.averageTimeSpent}</span>
              </div>
            </div>
            ${
              patterns.length > 0
                ? `
              <div class="place-patterns">
                ${patterns.map((p) => `<span class="pattern-tag">${p}</span>`).join("")}
              </div>
            `
                : ""
            }
          </div>
          <div class="place-card-footer">
            <span class="visit-count">${place.totalVisits} visits</span>
            <span class="last-visit">${this.formatRelativeDate(place.lastVisit)}</span>
          </div>
        </div>
      `;
      })
      .join("");

    this.elements.placesGrid.innerHTML = cardsHTML;
    this.elements.placesGrid.style.display = "grid";
    this.elements.placesListView.style.display = "none";
    this.renderPlacePreviewMaps(placePreviewConfigs);
  }

  renderPlaceList() {
    // Keep using the existing DataTable
    this.clearPlacePreviewMaps();
    this.elements.placesGrid.style.display = "none";
    this.elements.placesListView.style.display = "block";
  }

  renderPatterns() {
    const placesWithPatterns = this.placesStats.filter((p) => p.totalVisits >= 5);

    if (placesWithPatterns.length === 0) {
      this.elements.patternsSection.style.display = "none";
      return;
    }

    this.elements.patternsSection.style.display = "block";

    const patternsHTML = placesWithPatterns
      .map((place) => {
        const patterns = this.detectDetailedPatterns(place);
        const icon = this.getPlaceIcon(place.name);

        return `
        <div class="pattern-card">
          <div class="pattern-header">
            <div class="pattern-icon">${icon}</div>
            <h4>${this.escapeHtml(place.name)}</h4>
          </div>
          <p class="pattern-description">${patterns[0] || "Regular destination"}</p>
          <div class="pattern-stats">
            <span>${place.totalVisits} total visits</span>
            <span>Since ${this.formatDate(place.firstVisit)}</span>
          </div>
        </div>
      `;
      })
      .join("");

    this.elements.patternsGrid.innerHTML = patternsHTML;
  }

  async loadSuggestions() {
    try {
      this.suggestions = await this.fetchSuggestions(this.currentSuggestionSize);
      this.suggestionPage = 1;
      this.renderSuggestions();
    } catch (error) {
      console.error("Error loading suggestions:", error);
    }
  }

  renderSuggestions() {
    this.clearSuggestionPreviewMaps();

    if (this.suggestions.length === 0) {
      this.elements.discoveriesGrid.style.display = "none";
      this.elements.discoveriesEmptyState.style.display = "block";
      this.elements.discoveriesPagination.style.display = "none";
      return;
    }

    this.elements.discoveriesEmptyState.style.display = "none";
    this.elements.discoveriesSection.style.display = "block";

    const totalPages = this.getSuggestionPageCount();
    if (this.suggestionPage > totalPages) {
      this.suggestionPage = totalPages;
    }

    const startIndex = (this.suggestionPage - 1) * this.suggestionPageSize;
    const pageSuggestions = this.suggestions.slice(
      startIndex,
      startIndex + this.suggestionPageSize
    );

    const suggestionsHTML = pageSuggestions
      .map((suggestion, pageIndex) => {
        const index = startIndex + pageIndex;
        // Convert boundary size from meters to feet for display
        const boundarySizeFt = IMPERIAL_CONFIG.metersToFeet(this.currentSuggestionSize);

        return `
        <div class="discovery-card" data-suggestion-index="${index}">
          <div class="discovery-map-preview" id="discovery-map-${index}">
            <div class="map-preview-default">
              <i class="fas fa-map-marked-alt"></i>
              <span>Map preview unavailable</span>
            </div>
            <span class="discovery-boundary-indicator"><i class="fas fa-ruler-combined"></i> ~${boundarySizeFt} ft boundary</span>
          </div>
          <div class="discovery-content">
            <h4>${this.escapeHtml(suggestion.suggestedName)}</h4>
            <p class="discovery-stats">
              ${suggestion.totalVisits} visits •
              First: ${this.formatDate(suggestion.firstVisit)} •
              Last: ${this.formatDate(suggestion.lastVisit)}
            </p>
            <div class="discovery-actions">
              <button class="btn-preview" onclick="visitsPage.previewSuggestion(${index})">Preview</button>
              <button class="btn-add" onclick="visitsPage.addSuggestionAsPlace(${index})">Save place</button>
            </div>
          </div>
        </div>
      `;
      })
      .join("");

    this.elements.discoveriesGrid.innerHTML = suggestionsHTML;
    this.elements.discoveriesGrid.style.display = "grid";
    this.updateSuggestionPagination(pageSuggestions.length, startIndex);
    this.renderSuggestionPreviewMaps(pageSuggestions, startIndex);
  }

  async loadOtherStops() {
    try {
      this.nonCustomPlaces = await this.fetchNonCustomPlaces();
      this.renderOtherStops();
    } catch (error) {
      console.error("Error loading other stops:", error);
    }
  }

  renderOtherStops() {
    if (this.nonCustomPlaces.length === 0) {
      this.elements.otherStopsSection.style.display = "none";
      return;
    }

    this.elements.otherStopsSection.style.display = "block";

    const stopsHTML = this.nonCustomPlaces
      .map(
        (stop) => `
      <div class="other-stop-item">
        <div class="other-stop-info">
          <h4>${this.escapeHtml(stop.name)}</h4>
          <span style="color: var(--text-tertiary); font-size: 0.9rem;">${stop.totalVisits} visits</span>
        </div>
        <div class="other-stop-dates">
          <span>First: ${this.formatDate(stop.firstVisit)}</span>
          <span>Last: ${this.formatDate(stop.lastVisit)}</span>
        </div>
        <button class="btn-save" onclick="visitsPage.saveNonCustomPlace('${this.escapeHtml(stop.name)}')">
          <i class="fas fa-plus"></i> Save
        </button>
      </div>
    `
      )
      .join("");

    this.elements.otherStopsList.innerHTML = stopsHTML;
  }

  // Pattern detection
  detectPatterns(place) {
    const patterns = [];

    if (place.totalVisits >= 20) {
      patterns.push("Regular");
    } else if (place.totalVisits >= 10) {
      patterns.push("Frequent");
    }

    if (place.averageTimeSpent && place.averageTimeSpent !== "N/A") {
      const duration = this.parseDuration(place.averageTimeSpent);
      if (duration > 3600) {
        // More than 1 hour
        patterns.push("Extended stays");
      } else if (duration < 600) {
        // Less than 10 minutes
        patterns.push("Quick stops");
      }
    }

    return patterns;
  }

  detectDetailedPatterns(place) {
    const patterns = [];

    if (place.totalVisits >= 10) {
      patterns.push(`You visit regularly (${place.totalVisits} times)`);
    }

    if (place.firstVisit && place.lastVisit) {
      const first = new Date(place.firstVisit);
      const last = new Date(place.lastVisit);
      const weeks = (last - first) / (1000 * 60 * 60 * 24 * 7);
      const visitsPerWeek = place.totalVisits / Math.max(weeks, 1);

      if (visitsPerWeek >= 1) {
        patterns.push(`About ${visitsPerWeek.toFixed(1)} times per week`);
      }
    }

    return patterns.length > 0 ? patterns : ["A place you visit"];
  }

  processInitialPlaceDeepLink() {
    if (this.hasProcessedPlaceDeepLink) {
      return;
    }
    this.hasProcessedPlaceDeepLink = true;

    const { placeId, placeName } = this.getPlaceDeepLinkParams();
    if (!placeId && !placeName) {
      return;
    }

    const matchedPlace = this.findPlaceForDeepLink({ placeId, placeName });
    if (!matchedPlace) {
      return;
    }

    this.focusPlace(matchedPlace);

    const matchedPlaceId = this.getPlaceIdentifier(matchedPlace);
    if (!matchedPlaceId) {
      return;
    }
    void this.showPlaceDetail(matchedPlaceId);
  }

  getPlaceDeepLinkParams() {
    const locationSearch = globalThis.location?.search || "";
    const query = new URLSearchParams(locationSearch);

    return {
      placeId: (query.get("place") || "").trim(),
      placeName: (query.get("place_name") || "").trim(),
    };
  }

  findPlaceForDeepLink({ placeId, placeName }) {
    const byId = this.findPlaceById(placeId);
    if (byId) {
      return byId;
    }
    return this.findBestPlaceNameMatch(placeName);
  }

  findPlaceById(placeId) {
    const normalizedPlaceId = this.normalizeDeepLinkValue(placeId);
    if (!normalizedPlaceId) {
      return null;
    }

    return (
      this.places.find(
        (place) =>
          this.normalizeDeepLinkValue(this.getPlaceIdentifier(place)) ===
          normalizedPlaceId
      ) || null
    );
  }

  findBestPlaceNameMatch(placeName) {
    const normalizedQuery = this.normalizeDeepLinkValue(placeName);
    if (!normalizedQuery) {
      return null;
    }

    let bestPlace = null;
    let bestScore = 0;

    this.places.forEach((place) => {
      const normalizedName = this.normalizeDeepLinkValue(place?.name);
      if (!normalizedName) {
        return;
      }

      const score = this.scorePlaceNameMatch(normalizedName, normalizedQuery);
      if (score > bestScore) {
        bestScore = score;
        bestPlace = place;
      }
    });

    return bestPlace;
  }

  scorePlaceNameMatch(candidateName, queryName) {
    if (candidateName === queryName) {
      return 300;
    }
    if (candidateName.startsWith(queryName)) {
      return 200;
    }
    if (candidateName.includes(queryName)) {
      return 100;
    }
    if (queryName.includes(candidateName)) {
      return 50;
    }
    return 0;
  }

  focusPlace(place) {
    this.visitsManager?.mapController?.animateToPlace?.(place);

    const placeId = this.getPlaceIdentifier(place);
    if (!placeId) {
      return;
    }

    const matchingCard = Array.from(document.querySelectorAll("[data-place-id]")).find(
      (card) => card?.dataset?.placeId === placeId
    );
    matchingCard?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }

  normalizeDeepLinkValue(value) {
    return value ? String(value).trim().toLowerCase() : "";
  }

  getPlaceIdentifier(place) {
    const placeId = place?.id ?? place?._id;
    return placeId === undefined || placeId === null ? "" : String(placeId);
  }

  // Helper methods
  getPlaceIcon(_name) {
    return PLACE_ICON;
  }

  getPlaceAccent(visits, maxVisits) {
    if (visits === maxVisits) {
      return "mint";
    }
    if (visits > maxVisits * 0.7) {
      return "purple";
    }
    if (visits > maxVisits * 0.4) {
      return "sky";
    }
    return "slate";
  }

  formatDate(dateString) {
    if (!dateString) {
      return "N/A";
    }
    const date = new Date(dateString);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
    });
  }

  formatRelativeDate(dateString) {
    if (!dateString) {
      return "Never";
    }
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return "Today";
    }
    if (diffDays === 1) {
      return "Yesterday";
    }
    if (diffDays < 7) {
      return `${diffDays} days ago`;
    }
    if (diffDays < 30) {
      return `${Math.floor(diffDays / 7)} weeks ago`;
    }
    return this.formatDate(dateString);
  }

  parseDuration(durationStr) {
    if (!durationStr || durationStr === "N/A") {
      return 0;
    }

    let seconds = 0;
    const days = durationStr.match(/(\d+)d/);
    const hours = durationStr.match(/(\d+)h/);
    const minutes = durationStr.match(/(\d+)m/);
    const secs = durationStr.match(/(\d+)s/);

    if (days) {
      seconds += parseInt(days[1], 10) * 86400;
    }
    if (hours) {
      seconds += parseInt(hours[1], 10) * 3600;
    }
    if (minutes) {
      seconds += parseInt(minutes[1], 10) * 60;
    }
    if (secs) {
      seconds += parseInt(secs[1], 10);
    }

    return seconds;
  }

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // Event handlers
  handleViewToggle(e) {
    const { view } = e.target.dataset;
    this.currentView = view;

    // Update active state
    this.elements.viewBtns.forEach((btn) => btn.classList.remove("active"));
    e.target.classList.add("active");

    // Re-render
    this.renderPlaces();
  }

  async showPlaceDetail(placeId) {
    try {
      this.activePlaceId = String(placeId);

      const [stats, tripsResponse] = await Promise.all([
        this.fetchPlaceStats(placeId),
        this.fetchPlaceTrips(placeId),
      ]);

      // `/api/places/:id/trips` returns `{ trips: [...], name: string }`.
      // Be defensive in case older endpoints ever returned the array directly.
      const trips = Array.isArray(tripsResponse)
        ? tripsResponse
        : tripsResponse?.trips || [];

      // Update modal content
      document.getElementById("modal-place-name").textContent = stats.name;

      // Update stats row
      const statsHTML = `
        <div class="modal-stat">
          <span class="modal-stat-value">${stats.totalVisits}</span>
          <span class="modal-stat-label">Total Visits</span>
        </div>
        <div class="modal-stat">
          <span class="modal-stat-value">${stats.averageTimeSpent}</span>
          <span class="modal-stat-label">Avg Duration</span>
        </div>
        <div class="modal-stat">
          <span class="modal-stat-value">${stats.averageTimeSinceLastVisit}</span>
          <span class="modal-stat-label">Time Between</span>
        </div>
      `;
      document.getElementById("modal-stats-row").innerHTML = statsHTML;
      const editPlaceIdInput = document.getElementById("edit-place-id");
      const editPlaceNameInput = document.getElementById("edit-place-name");
      if (editPlaceIdInput) {
        editPlaceIdInput.value = this.activePlaceId;
      }
      if (editPlaceNameInput) {
        editPlaceNameInput.value = stats.name || "";
      }

      // Store trips for progressive rendering
      this.modalTrips = trips;
      this.modalTimelineShown = 0;

      // Update timeline count badge
      const countEl = document.getElementById("modal-timeline-count");
      if (countEl) {
        countEl.textContent =
          trips.length > 0
            ? `${trips.length} visit${trips.length !== 1 ? "s" : ""}`
            : "";
      }

      // Clear and render initial batch
      const timelineEl = document.getElementById("modal-visit-timeline");
      timelineEl.innerHTML = "";
      this._renderTimelineBatch(timelineEl);

      // Show modal
      const modalEl = document.getElementById("place-detail-modal");
      if (!bootstrap?.Modal || !modalEl) {
        console.warn("Bootstrap modal is unavailable for place details.");
        return;
      }
      this._cleanupOrphanedModalState();
      const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
      modal.show();
    } catch (error) {
      console.error("Error loading place detail:", error);
      this.showNotification("Error loading place details", "error");
    }
  }

  /**
   * Render the next batch of timeline items, updating the "show more" button.
   */
  _renderTimelineBatch(timelineEl) {
    const trips = this.modalTrips;
    const start = this.modalTimelineShown;
    const end = Math.min(start + this.TIMELINE_PAGE_SIZE, trips.length);

    if (trips.length === 0) {
      timelineEl.innerHTML = '<p class="text-secondary">No visits recorded</p>';
      return;
    }

    const fragment = document.createDocumentFragment();

    for (let i = start; i < end; i++) {
      const trip = trips[i];
      const sinceLast = i > 0 ? trip.timeSinceLastVisit : null;

      const item = document.createElement("div");
      item.className = "timeline-item";
      item.innerHTML = `
        <div class="timeline-date">${this.formatDate(trip.endTime)}</div>
        <div class="timeline-content">
          <span>${new Date(trip.endTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} - ${trip.departureTime ? new Date(trip.departureTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "Unknown"}</span>
          <span class="duration">${trip.timeSpent}</span>
          ${sinceLast ? `<span class="since-last">${sinceLast} since last</span>` : ""}
        </div>
      `;
      fragment.appendChild(item);
    }

    timelineEl.appendChild(fragment);
    this.modalTimelineShown = end;

    // Update "show more" button
    const showMoreBtn = document.getElementById("modal-timeline-show-more");
    if (showMoreBtn) {
      const remaining = trips.length - this.modalTimelineShown;
      if (remaining > 0) {
        showMoreBtn.style.display = "flex";
        showMoreBtn.innerHTML = `<i class="fas fa-chevron-down me-2"></i>Show ${Math.min(remaining, this.TIMELINE_PAGE_SIZE)} more of ${remaining} remaining`;
      } else {
        showMoreBtn.style.display = "none";
      }
    }
  }

  destroy() {
    this._previewMapObserver?.disconnect();
    this._previewMapObserver = null;
    this.listenerAbortController.abort();
    this.modalWatchdogObserver?.disconnect();
    this.modalWatchdogObserver = null;

    this.visitsModalIds.forEach((modalId) => {
      const modalEl = document.getElementById(modalId);
      if (!modalEl || !bootstrap?.Modal) {
        return;
      }

      const instance = bootstrap.Modal.getInstance(modalEl);
      if (instance) {
        instance.hide();
        instance.dispose();
      }
      modalEl.classList.remove("show");
      modalEl.style.display = "none";
      modalEl.removeAttribute("aria-modal");
      modalEl.setAttribute("aria-hidden", "true");
    });

    this._cleanupOrphanedModalState(true);
  }

  previewSuggestion(index) {
    const suggestion = this.suggestions[index];
    if (suggestion?.boundary) {
      // Show boundary on main map with editable controls
      this.visitsManager?.applySuggestion?.(suggestion);

      // Scroll to map
      document.querySelector(".map-section").scrollIntoView({ behavior: "smooth" });
    }
  }

  getSuggestionPageCount() {
    return Math.max(1, Math.ceil(this.suggestions.length / this.suggestionPageSize));
  }

  setSuggestionPage(page) {
    const totalPages = this.getSuggestionPageCount();
    const nextPage = Math.min(Math.max(page, 1), totalPages);
    if (nextPage === this.suggestionPage) {
      return;
    }
    this.suggestionPage = nextPage;
    this.renderSuggestions();
  }

  updateSuggestionPagination(countOnPage, startIndex) {
    if (!this.elements.discoveriesPagination) {
      return;
    }

    const total = this.suggestions.length;
    const totalPages = this.getSuggestionPageCount();
    const showPagination = total > this.suggestionPageSize;

    this.elements.discoveriesPagination.style.display = showPagination
      ? "flex"
      : "none";

    if (!showPagination) {
      return;
    }

    const rangeStart = startIndex + 1;
    const rangeEnd = startIndex + countOnPage;

    if (this.elements.discoveriesPageInfo) {
      this.elements.discoveriesPageInfo.textContent = `Showing ${rangeStart}-${rangeEnd} of ${total}`;
    }

    if (this.elements.discoveriesPrev) {
      this.elements.discoveriesPrev.disabled = this.suggestionPage <= 1;
    }
    if (this.elements.discoveriesNext) {
      this.elements.discoveriesNext.disabled = this.suggestionPage >= totalPages;
    }
  }

  clearSuggestionPreviewMaps() {
    this.suggestionPreviewMaps.forEach((map) => {
      try {
        map.remove();
      } catch {
        // Ignore cleanup errors.
      }
    });
    this.suggestionPreviewMaps.clear();
  }

  clearPlacePreviewMaps() {
    this.placePreviewMaps.forEach((map) => {
      try {
        map.remove();
      } catch {
        // Ignore cleanup errors.
      }
    });
    this.placePreviewMaps.clear();
  }

  getPreviewMapStyle() {
    const { styleUrl } = resolveMapStyle({ theme: getCurrentTheme() });
    return styleUrl;
  }

  getPlacePreviewColors(accent = "slate") {
    return PLACE_PREVIEW_COLORS[accent] || PLACE_PREVIEW_COLORS.slate;
  }

  getRenderableGeometry(geometry) {
    if (!geometry || typeof geometry !== "object") {
      return null;
    }

    if (geometry.type === "Feature") {
      return this.getRenderableGeometry(geometry.geometry);
    }

    if (!geometry.type) {
      return null;
    }

    return geometry;
  }

  addPreviewLayers(map, { sourceId, layerIdPrefix, geometry, colors }) {
    const geometryType = geometry?.type;
    const isPolygon = geometryType === "Polygon" || geometryType === "MultiPolygon";
    const isPoint = geometryType === "Point" || geometryType === "MultiPoint";

    if (isPolygon) {
      map.addLayer({
        id: `${layerIdPrefix}-fill`,
        type: "fill",
        source: sourceId,
        paint: {
          "fill-color": colors.fill,
          "fill-opacity": 0.26,
        },
      });

      map.addLayer({
        id: `${layerIdPrefix}-outline`,
        type: "line",
        source: sourceId,
        paint: {
          "line-color": colors.line,
          "line-width": 2,
        },
      });
      return;
    }

    if (isPoint) {
      map.addLayer({
        id: `${layerIdPrefix}-point`,
        type: "circle",
        source: sourceId,
        paint: {
          "circle-color": colors.fill,
          "circle-radius": 5,
          "circle-stroke-color": colors.line,
          "circle-stroke-width": 1.5,
        },
      });
      return;
    }

    map.addLayer({
      id: `${layerIdPrefix}-line`,
      type: "line",
      source: sourceId,
      paint: {
        "line-color": colors.line,
        "line-width": 2.5,
      },
    });
  }

  renderPlacePreviewMaps(placePreviewConfigs) {
    if (typeof mapboxgl === "undefined") {
      return;
    }

    // Lazy-load: only create Mapbox instances when containers scroll into view
    if (!this._previewMapObserver) {
      this._previewMapObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const container = entry.target;
            const init = container._lazyMapInit;
            if (init) {
              this._previewMapObserver.unobserve(container);
              delete container._lazyMapInit;
              init();
            }
          }
        },
        { rootMargin: "200px" },
      );
    }

    placePreviewConfigs.forEach(({ mapId, geometry, accent }) => {
      const container = document.getElementById(mapId);
      if (!container || !geometry) {
        return;
      }

      container._lazyMapInit = () => {
        const previewMap = createMap(mapId, {
          center: [-95.7129, 37.0902],
          zoom: 3,
          interactive: false,
        });

        previewMap.on("load", () => {
          const sourceId = "place-preview";
          previewMap.addSource(sourceId, {
            type: "geojson",
            data: geometry,
          });

          this.addPreviewLayers(previewMap, {
            sourceId,
            layerIdPrefix: "place-preview",
            geometry,
            colors: this.getPlacePreviewColors(accent),
          });

          VisitsGeometry.fitMapToGeometry(previewMap, geometry, {
            padding: 18,
            duration: 0,
          });

          container.classList.add("has-map");
        });

        previewMap.on("error", () => {
          container.classList.remove("has-map");
        });

        this.placePreviewMaps.set(mapId, previewMap);
      };

      this._previewMapObserver.observe(container);
    });
  }

  renderSuggestionPreviewMaps(pageSuggestions, startIndex) {
    if (typeof mapboxgl === "undefined") {
      return;
    }

    if (!this._previewMapObserver) {
      this._previewMapObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const container = entry.target;
            const init = container._lazyMapInit;
            if (init) {
              this._previewMapObserver.unobserve(container);
              delete container._lazyMapInit;
              init();
            }
          }
        },
        { rootMargin: "200px" },
      );
    }

    pageSuggestions.forEach((suggestion, pageIndex) => {
      const boundary = this.getRenderableGeometry(suggestion?.boundary);
      if (!boundary) {
        return;
      }
      const mapId = `discovery-map-${startIndex + pageIndex}`;
      const container = document.getElementById(mapId);
      if (!container) {
        return;
      }

      container._lazyMapInit = () => {
        const previewMap = createMap(mapId, {
          center: [-95.7129, 37.0902],
          zoom: 3,
          interactive: false,
        });

        previewMap.on("load", () => {
          const sourceId = "suggestion-preview";
          previewMap.addSource(sourceId, {
            type: "geojson",
            data: boundary,
          });

          this.addPreviewLayers(previewMap, {
            sourceId,
            layerIdPrefix: "suggestion-preview",
            geometry: boundary,
            colors: DISCOVERY_PREVIEW_COLORS,
          });

          VisitsGeometry.fitMapToGeometry(previewMap, boundary, {
            padding: 18,
            duration: 0,
          });

          container.classList.add("has-map");
        });

        previewMap.on("error", () => {
          container.classList.remove("has-map");
        });

        this.suggestionPreviewMaps.set(mapId, previewMap);
      };

      this._previewMapObserver.observe(container);
    });
  }

  async addSuggestionAsPlace(index) {
    const suggestion = this.suggestions[index];
    if (!suggestion) {
      return;
    }

    const name = await this.promptPlaceName(suggestion.suggestedName);
    if (!name) {
      return;
    }

    try {
      await this.createPlace(name, suggestion.boundary);
      this.showNotification(`Place "${name}" created successfully!`, "success");

      // Reload data
      await this.loadData();
    } catch (error) {
      console.error("Error creating place:", error);
      this.showNotification("Error creating place. Please try again.", "error");
    }
  }

  // Convert a non-custom place to a custom place
  async saveNonCustomPlace(name) {
    const customName = await this.promptPlaceName(name);
    if (!customName) {
      return;
    }

    this.showNotification(
      `Place "${customName}" would be created here. Drawing on map required.`,
      "info"
    );
    // Note: User needs to draw boundary on map - this is handled by the drawing workflow
  }

  showPlacesSection() {
    this.elements.tripsSection.style.display = "none";
    document.querySelectorAll(".visits-section").forEach((s) => {
      if (s.id !== "trips-section") {
        s.style.display = "block";
      }
    });
  }

  showNotification(message, type = "info") {
    // Use the existing notification manager if available
    if (window.notificationManager) {
      window.notificationManager.show(message, type);
    } else {
      console.log(`[${type}] ${message}`);
    }
  }

  promptPlaceName(defaultValue = "") {
    if (!confirmationDialog?.prompt) {
      this.showNotification("Unable to open naming dialog.", "error");
      return Promise.resolve(null);
    }

    return confirmationDialog.prompt({
      title: "Name this place",
      message: "Enter a short, descriptive name.",
      inputLabel: "Place name",
      defaultValue,
      placeholder: "e.g., Home, Downtown Market",
      confirmText: "Save",
      cancelText: "Cancel",
      confirmButtonClass: "btn-primary",
    });
  }
}

// Export the class
export default VisitsPageController;
