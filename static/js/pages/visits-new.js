/* global mapboxgl */
/* Visits Page Redesign - Main Controller
 * Integrates with real API endpoints and uses imperial units
 */

import { onPageLoad } from "../modules/utils.js";
import { VisitsGeometry } from "../modules/visits/geometry.js";
import VisitsManager from "../modules/visits/visits-manager.js";

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

// Day names for pattern detection
const DAY_NAMES = [
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
    this.suggestionPreviewMaps = new Map();

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
    // View toggle
    this.elements.viewBtns.forEach((btn) => {
      btn.addEventListener("click", (e) => this.handleViewToggle(e));
    });

    // Suggestion size change
    this.elements.suggestionSize?.addEventListener("change", (e) => {
      this.currentSuggestionSize = parseInt(e.target.value);
      this.suggestionPage = 1;
      this.loadSuggestions();
    });

    this.elements.discoveriesPrev?.addEventListener("click", () => {
      this.setSuggestionPage(this.suggestionPage - 1);
    });

    this.elements.discoveriesNext?.addEventListener("click", () => {
      this.setSuggestionPage(this.suggestionPage + 1);
    });

    // Back button
    document.getElementById("back-to-places-btn")?.addEventListener("click", () => {
      this.showPlacesSection();
    });

    // Cancel drawing
    document.getElementById("cancel-drawing")?.addEventListener("click", () => {
      this.cancelDrawing();
    });

    // Discard drawing
    document.getElementById("discard-drawing")?.addEventListener("click", () => {
      this.discardDrawing();
    });
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
    } catch (error) {
      console.error("Error loading visits data:", error);
      this.showNotification("Error loading data. Please try refreshing.", "error");
    }
  }

  // API Methods
  async fetchPlaces() {
    const response = await fetch("/api/places");
    if (!response.ok) throw new Error("Failed to fetch places");
    return response.json();
  }

  async fetchAllStats(timeframe = "all") {
    const response = await fetch(`/api/places/statistics?timeframe=${timeframe}`);
    if (!response.ok) throw new Error("Failed to fetch statistics");
    return response.json();
  }

  async fetchPlaceStats(placeId) {
    const response = await fetch(`/api/places/${placeId}/statistics`);
    if (!response.ok) throw new Error("Failed to fetch place statistics");
    return response.json();
  }

  async fetchPlaceTrips(placeId) {
    const response = await fetch(`/api/places/${placeId}/trips`);
    if (!response.ok) throw new Error("Failed to fetch place trips");
    return response.json();
  }

  async fetchSuggestions(cellSizeFt = 250) {
    // Convert feet to meters for API
    const cellSizeM = Math.round(cellSizeFt / 3.28084);
    const response = await fetch(
      `/api/visit_suggestions?cell_size_m=${cellSizeM}&min_visits=5`
    );
    if (!response.ok) throw new Error("Failed to fetch suggestions");
    return response.json();
  }

  async fetchNonCustomPlaces() {
    const response = await fetch("/api/non_custom_places_visits");
    if (!response.ok) throw new Error("Failed to fetch non-custom places");
    return response.json();
  }

  async createPlace(name, geometry) {
    const response = await fetch("/api/places", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, geometry }),
    });
    if (!response.ok) throw new Error("Failed to create place");
    return response.json();
  }

  async deletePlace(placeId) {
    const response = await fetch(`/api/places/${placeId}`, {
      method: "DELETE",
    });
    if (!response.ok) throw new Error("Failed to delete place");
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
      if (!s.lastVisit) return false;
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

    const cardsHTML = this.placesStats
      .map((place) => {
        const icon = this.getPlaceIcon(place.name);
        const accent = this.getPlaceAccent(place.totalVisits, maxVisits);
        const patterns = this.detectPatterns(place);
        const isMostVisited = place.totalVisits === maxVisits && maxVisits > 0;

        return `
        <div class="place-card" data-place-id="${place.id}" onclick="visitsPage.showPlaceDetail('${place.id}')">
          <div class="place-card-header ${accent}">
            <span class="place-icon">${icon}</span>
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
  }

  renderPlaceList() {
    // Keep using the existing DataTable
    this.elements.placesGrid.style.display = "none";
    this.elements.placesListView.style.display = "block";

    // Trigger the existing table update through VisitsManager
    if (this.visitsManager) {
      this.visitsManager.updateVisitsTable?.(this.placesStats);
    }
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
            <div class="map-preview-fallback">
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

  // Helper methods
  getPlaceIcon(name) {
    return PLACE_ICON;
  }

  getPlaceAccent(visits, maxVisits) {
    if (visits === maxVisits) return "mint";
    if (visits > maxVisits * 0.7) return "purple";
    if (visits > maxVisits * 0.4) return "sky";
    return "slate";
  }

  formatDate(dateString) {
    if (!dateString) return "N/A";
    const date = new Date(dateString);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
    });
  }

  formatRelativeDate(dateString) {
    if (!dateString) return "Never";
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
    return this.formatDate(dateString);
  }

  parseDuration(durationStr) {
    if (!durationStr || durationStr === "N/A") return 0;

    let seconds = 0;
    const days = durationStr.match(/(\d+)d/);
    const hours = durationStr.match(/(\d+)h/);
    const minutes = durationStr.match(/(\d+)m/);
    const secs = durationStr.match(/(\d+)s/);

    if (days) seconds += parseInt(days[1]) * 86400;
    if (hours) seconds += parseInt(hours[1]) * 3600;
    if (minutes) seconds += parseInt(minutes[1]) * 60;
    if (secs) seconds += parseInt(secs[1]);

    return seconds;
  }

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // Event handlers
  handleViewToggle(e) {
    const view = e.target.dataset.view;
    this.currentView = view;

    // Update active state
    this.elements.viewBtns.forEach((btn) => btn.classList.remove("active"));
    e.target.classList.add("active");

    // Re-render
    this.renderPlaces();
  }

  async showPlaceDetail(placeId) {
    try {
      const [stats, trips] = await Promise.all([
        this.fetchPlaceStats(placeId),
        this.fetchPlaceTrips(placeId),
      ]);

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

      // Update timeline
      const timelineHTML = trips
        .map((trip, index) => {
          const sinceLast = index > 0 ? trip.timeSinceLastVisit : null;
          return `
          <div class="timeline-item">
            <div class="timeline-date">${this.formatDate(trip.endTime)}</div>
            <div class="timeline-content">
              <span>${new Date(trip.endTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} - ${trip.departureTime ? new Date(trip.departureTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "Unknown"}</span>
              <span class="duration">${trip.timeSpent}</span>
              ${sinceLast ? `<span class="since-last">${sinceLast} since last</span>` : ""}
            </div>
          </div>
        `;
        })
        .join("");

      document.getElementById("modal-visit-timeline").innerHTML =
        timelineHTML || '<p class="text-secondary">No visits recorded</p>';

      // Show modal
      const modal = new bootstrap.Modal(document.getElementById("place-detail-modal"));
      modal.show();
    } catch (error) {
      console.error("Error loading place detail:", error);
      this.showNotification("Error loading place details", "error");
    }
  }

  previewSuggestion(index) {
    const suggestion = this.suggestions[index];
    if (suggestion && suggestion.boundary) {
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

    this.elements.discoveriesPagination.style.display = showPagination ? "flex" : "none";

    if (!showPagination) {
      return;
    }

    const rangeStart = startIndex + 1;
    const rangeEnd = startIndex + countOnPage;

    if (this.elements.discoveriesPageInfo) {
      this.elements.discoveriesPageInfo.textContent = `Showing ${rangeStart}–${rangeEnd} of ${total}`;
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

  renderSuggestionPreviewMaps(pageSuggestions, startIndex) {
    if (typeof mapboxgl === "undefined") {
      return;
    }

    const token = window.MAPBOX_ACCESS_TOKEN;
    if (!token) {
      return;
    }

    mapboxgl.accessToken = token;
    const theme = document.documentElement.getAttribute("data-bs-theme") || "dark";
    const style =
      theme === "light"
        ? "mapbox://styles/mapbox/light-v11"
        : "mapbox://styles/mapbox/dark-v11";

    pageSuggestions.forEach((suggestion, pageIndex) => {
      if (!suggestion?.boundary) {
        return;
      }
      const mapId = `discovery-map-${startIndex + pageIndex}`;
      const container = document.getElementById(mapId);
      if (!container) {
        return;
      }

      const previewMap = new mapboxgl.Map({
        container,
        style,
        center: [-95.7129, 37.0902],
        zoom: 3,
        interactive: false,
        attributionControl: false,
      });

      previewMap.on("load", () => {
        previewMap.addSource("suggestion-preview", {
          type: "geojson",
          data: suggestion.boundary,
        });

        previewMap.addLayer({
          id: "suggestion-preview-fill",
          type: "fill",
          source: "suggestion-preview",
          paint: {
            "fill-color": "#38bdf8",
            "fill-opacity": 0.28,
          },
        });

        previewMap.addLayer({
          id: "suggestion-preview-outline",
          type: "line",
          source: "suggestion-preview",
          paint: {
            "line-color": "#38bdf8",
            "line-width": 2,
          },
        });

        VisitsGeometry.fitMapToGeometry(previewMap, suggestion.boundary, {
          padding: 18,
          duration: 0,
        });

        container.classList.add("has-map");
      });

      previewMap.on("error", () => {
        container.classList.remove("has-map");
      });

      this.suggestionPreviewMaps.set(mapId, previewMap);
    });
  }

  async addSuggestionAsPlace(index) {
    const suggestion = this.suggestions[index];
    if (!suggestion) return;

    const name = prompt("Name this place:", suggestion.suggestedName);
    if (!name) return;

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
    const customName = prompt("Name this place:", name);
    if (!customName) return;

    this.showNotification(
      `Place "${customName}" would be created here. Drawing on map required.`,
      "info"
    );
    // Note: User needs to draw boundary on map - this is handled by the drawing workflow
  }

  showPlacesSection() {
    this.elements.tripsSection.style.display = "none";
    document.querySelectorAll(".visits-section").forEach((s) => {
      if (s.id !== "trips-section") s.style.display = "block";
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
}

// Export the class
export default VisitsPageController;
