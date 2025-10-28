/**
 * Search Manager Module
 * Handles geocoding search for places, addresses, and streets with map highlighting
 */

import utils from "./utils.js";
import state from "./state.js";
import { CONFIG } from "./config.js";

const searchManager = {
  searchInput: null,
  searchResults: null,
  clearSearchBtn: null,
  currentResults: [],
  selectedIndex: -1,
  searchTimeout: null,
  highlightLayerId: "search-highlight-layer",
  highlightSourceId: "search-highlight-source",
  searchMarkerId: null,

  initialize() {
    this.searchInput = document.getElementById("map-search-input");
    this.searchResults = document.getElementById("search-results");
    this.clearSearchBtn = document.getElementById("clear-search-btn");

    if (!this.searchInput || !this.searchResults) {
      console.warn("Search elements not found");
      return;
    }

    this.setupEventListeners();

    // Reposition dropdown on window resize or scroll
    window.addEventListener(
      "resize",
      utils.debounce(() => {
        if (!this.searchResults.classList.contains("d-none")) {
          this.positionDropdown();
        }
      }, 100),
    );

    // Reposition on scroll of parent containers
    const controlPanel = document.getElementById("map-controls");
    if (controlPanel) {
      controlPanel.addEventListener("scroll", () => {
        if (!this.searchResults.classList.contains("d-none")) {
          this.positionDropdown();
        }
      });
    }

    console.log("Search manager initialized");
  },

  setupEventListeners() {
    // Search input with debounce
    this.searchInput.addEventListener(
      "input",
      utils.debounce((e) => {
        const query = e.target.value.trim();
        if (query.length >= 2) {
          this.performSearch(query);
          this.showClearButton();
        } else {
          this.hideResults();
          this.clearHighlight();
          if (query.length === 0) {
            this.hideClearButton();
          }
        }
      }, 300),
    );

    // Keyboard navigation
    this.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.navigateResults(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.navigateResults(-1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const index =
          this.selectedIndex >= 0
            ? this.selectedIndex
            : this.currentResults.length > 0
              ? 0
              : -1;
        if (index >= 0 && this.currentResults[index]) {
          this.selectResult(this.currentResults[index]);
        } else {
          window.notificationManager?.show(
            "No results to select",
            "warning",
            2000,
          );
        }
      } else if (e.key === "Escape") {
        this.hideResults();
        this.searchInput.blur();
      }
    });

    // Clear button
    if (this.clearSearchBtn) {
      this.clearSearchBtn.addEventListener("click", () => {
        this.clearSearch();
      });
    }

    // Click outside to close
    document.addEventListener("click", (e) => {
      if (
        !this.searchInput.contains(e.target) &&
        !this.searchResults.contains(e.target)
      ) {
        this.hideResults();
      }
    });

    // Focus event to reshow results if they exist
    this.searchInput.addEventListener("focus", () => {
      if (this.currentResults.length > 0) {
        this.positionDropdown();
        this.searchResults.classList.remove("d-none");
      }
    });
  },

  async performSearch(query) {
    try {
      this.showLoading();

      // Determine if this is a street search or general geocoding
      const isStreetQuery = this.isStreetQuery(query);
      const selectedLocationId = utils.getStorage(
        CONFIG.STORAGE_KEYS.selectedLocation,
      );

      let results = [];

      // If it looks like a street query and we have a location selected, try street search first
      if (isStreetQuery && selectedLocationId) {
        const streetResults = await this.searchStreets(
          query,
          selectedLocationId,
        );
        results = streetResults;
      }

      // If no street results, fall back to geocoding
      if (results.length === 0) {
        results = await this.geocodeSearch(query);
      }

      this.currentResults = results;
      this.displayResults(results);

      // Immediate feedback if no results
      if (!results || results.length === 0) {
        window.notificationManager?.show("No results found", "info", 2000);
      }
    } catch (error) {
      console.error("Search error:", error);
      this.showError("Search failed. Please try again.");
      window.notificationManager?.show(
        "Search failed. Please try again.",
        "danger",
        2500,
      );
    }
  },

  isStreetQuery(query) {
    // Simple heuristic: if query contains street-like words
    const streetKeywords = [
      "street",
      "st",
      "avenue",
      "ave",
      "road",
      "rd",
      "boulevard",
      "blvd",
      "lane",
      "ln",
      "drive",
      "dr",
      "way",
      "circle",
      "court",
      "ct",
      "place",
      "pl",
    ];

    const lowerQuery = query.toLowerCase();
    return streetKeywords.some((keyword) => lowerQuery.includes(keyword));
  },

  async searchStreets(query, locationId) {
    try {
      const response = await fetch(
        `/api/search/streets?query=${encodeURIComponent(query)}&location_id=${locationId}&limit=10`,
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const features = data.features || [];

      // Convert to result format (use street_name if present, fallback to name)
      return features.map((feature) => ({
        type: "street",
        name:
          feature.properties.street_name ||
          feature.properties.name ||
          "Unnamed Street",
        subtitle: `Street in ${locationId}`,
        geometry: feature.geometry,
        feature: feature,
        locationId: locationId,
      }));
    } catch (error) {
      console.warn("Street search failed:", error);
      return [];
    }
  },

  async geocodeSearch(query) {
    try {
      const response = await fetch(
        `/api/search/geocode?query=${encodeURIComponent(query)}&limit=5`,
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const results = data.results || [];

      // Convert to result format
      return results.map((result) => {
        const placeType = result.place_type
          ? result.place_type[0]
          : result.type || "place";
        const isStreet = ["road", "street", "highway", "residential"].includes(
          placeType,
        );

        return {
          type: isStreet ? "street" : "place",
          name: result.text || result.place_name || "Unknown",
          subtitle: result.place_name || result.display_name || "",
          center: result.center || [
            parseFloat(result.lon),
            parseFloat(result.lat),
          ],
          bbox: result.bbox,
          osm_id: result.osm_id,
          osm_type: result.osm_type,
          raw: result,
        };
      });
    } catch (error) {
      console.error("Geocode search failed:", error);
      throw error;
    }
  },

  displayResults(results) {
    this.searchResults.innerHTML = "";

    if (results.length === 0) {
      this.showNoResults();
      return;
    }

    results.forEach((result, index) => {
      const item = document.createElement("div");
      item.className = "search-result-item";
      item.setAttribute("role", "option");
      item.setAttribute("data-index", index);

      const typeLabel = document.createElement("span");
      typeLabel.className = `search-result-type ${result.type}`;
      typeLabel.textContent = result.type;

      const title = document.createElement("div");
      title.className = "search-result-title";
      title.textContent = result.name;

      const subtitle = document.createElement("div");
      subtitle.className = "search-result-subtitle";
      subtitle.textContent = result.subtitle;

      item.appendChild(typeLabel);
      item.appendChild(title);
      item.appendChild(subtitle);

      item.addEventListener("click", () => this.selectResult(result));
      item.addEventListener("mouseenter", () => {
        this.selectedIndex = index;
        this.updateSelectedItem();
      });

      this.searchResults.appendChild(item);
    });

    this.positionDropdown();
    this.searchResults.classList.remove("d-none");
    this.selectedIndex = -1;
  },

  positionDropdown() {
    if (!this.searchInput || !this.searchResults) return;

    const inputRect = this.searchInput.getBoundingClientRect();
    const dropdownHeight = this.searchResults.offsetHeight || 300;
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const spaceBelow = viewportHeight - inputRect.bottom;
    const spaceAbove = inputRect.top;

    // Determine if dropdown should appear above or below
    const showAbove =
      spaceBelow < Math.min(dropdownHeight + 20, 200) &&
      spaceAbove > spaceBelow;

    if (showAbove) {
      // Position above the input
      this.searchResults.style.top = "auto";
      this.searchResults.style.bottom = `${viewportHeight - inputRect.top + 8}px`;
      this.searchResults.classList.add("above");
    } else {
      // Position below the input
      this.searchResults.style.top = `${inputRect.bottom + 8}px`;
      this.searchResults.style.bottom = "auto";
      this.searchResults.classList.remove("above");
    }

    // Horizontal positioning with boundary checks
    const minWidth = 280;
    const preferredWidth = Math.max(inputRect.width, minWidth);
    let leftPosition = inputRect.left;

    // Ensure dropdown doesn't go off-screen on the right
    if (leftPosition + preferredWidth > viewportWidth - 20) {
      leftPosition = Math.max(20, viewportWidth - preferredWidth - 20);
    }

    // Ensure dropdown doesn't go off-screen on the left
    if (leftPosition < 20) {
      leftPosition = 20;
    }

    this.searchResults.style.left = `${leftPosition}px`;
    this.searchResults.style.width = `${Math.min(preferredWidth, viewportWidth - 40)}px`;
  },

  navigateResults(direction) {
    if (this.currentResults.length === 0) return;

    // Remove previous selection
    const previousIndex = this.selectedIndex;

    this.selectedIndex += direction;

    if (this.selectedIndex < 0) {
      this.selectedIndex = this.currentResults.length - 1;
    } else if (this.selectedIndex >= this.currentResults.length) {
      this.selectedIndex = 0;
    }

    this.updateSelectedItem();

    // Announce to screen readers
    if (
      this.selectedIndex !== previousIndex &&
      this.currentResults[this.selectedIndex]
    ) {
      const result = this.currentResults[this.selectedIndex];
      utils.announce(`${result.type}: ${result.name}`, "polite");
    }
  },

  updateSelectedItem() {
    const items = this.searchResults.querySelectorAll(".search-result-item");
    items.forEach((item, index) => {
      if (index === this.selectedIndex) {
        item.classList.add("active");
        item.setAttribute("aria-selected", "true");
        item.scrollIntoView({ block: "nearest" });
      } else {
        item.classList.remove("active");
        item.setAttribute("aria-selected", "false");
      }
    });
  },

  async selectResult(result) {
    console.log("Selected result:", result);

    this.hideResults();
    this.searchInput.value = result.name;

    if (result.type === "street" && result.geometry) {
      await this.highlightStreet(result);
    } else if (result.center) {
      this.panToLocation(result);
    }

    // Announce to screen readers
    const announcement = `Selected ${result.type}: ${result.name}`;
    utils.announce(announcement);
  },

  async highlightStreet(result) {
    if (!state.map || !state.mapInitialized) {
      console.warn("Map not initialized");
      return;
    }

    // Clear existing highlights
    this.clearHighlight();

    const geometry = result.geometry;

    try {
      // Add highlight source and layer
      if (!state.map.getSource(this.highlightSourceId)) {
        state.map.addSource(this.highlightSourceId, {
          type: "geojson",
          data: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: geometry,
                properties: { name: result.name },
              },
            ],
          },
        });
      } else {
        state.map.getSource(this.highlightSourceId).setData({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: geometry,
              properties: { name: result.name },
            },
          ],
        });
      }

      if (!state.map.getLayer(this.highlightLayerId)) {
        state.map.addLayer({
          id: this.highlightLayerId,
          type: "line",
          source: this.highlightSourceId,
          paint: {
            "line-color": "#FFD700", // Gold color
            "line-width": [
              "interpolate",
              ["linear"],
              ["zoom"],
              10,
              3,
              15,
              6,
              20,
              12,
            ],
            "line-opacity": 0.9,
          },
        });
      }

      // Fit bounds to the street
      if (geometry.type === "LineString") {
        const coordinates = geometry.coordinates;
        const bounds = coordinates.reduce(
          (bounds, coord) => bounds.extend(coord),
          new mapboxgl.LngLatBounds(coordinates[0], coordinates[0]),
        );

        state.map.fitBounds(bounds, {
          padding: 100,
          maxZoom: 16,
          duration: 1000,
        });
      } else if (geometry.type === "Point") {
        state.map.flyTo({
          center: geometry.coordinates,
          zoom: 16,
          duration: 1000,
        });
      }

      window.notificationManager.show(
        `Highlighted: ${result.name}`,
        "success",
        3000,
      );
    } catch (error) {
      console.error("Error highlighting street:", error);
      window.notificationManager.show(
        "Failed to highlight street",
        "warning",
        3000,
      );
    }
  },

  panToLocation(result) {
    if (!state.map || !state.mapInitialized || !result.center) {
      return;
    }

    // Clear existing highlights
    this.clearHighlight();

    const [lng, lat] = result.center;

    // Add a marker
    if (this.searchMarkerId) {
      this.searchMarkerId.remove();
    }

    this.searchMarkerId = new mapboxgl.Marker({ color: "#FFD700" })
      .setLngLat([lng, lat])
      .setPopup(
        new mapboxgl.Popup({ offset: 25 }).setHTML(
          `<strong>${result.name}</strong><br>${result.subtitle}`,
        ),
      )
      .addTo(state.map);

    // Fly to location
    if (result.bbox && result.bbox.length === 4) {
      // [west, south, east, north] or [minLon, minLat, maxLon, maxLat]
      const [west, south, east, north] = result.bbox;
      state.map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        {
          padding: 50,
          maxZoom: 15,
          duration: 1000,
        },
      );
    } else {
      state.map.flyTo({
        center: [lng, lat],
        zoom: 14,
        duration: 1000,
      });
    }

    window.notificationManager.show(
      `Navigated to: ${result.name}`,
      "success",
      3000,
    );
  },

  clearHighlight() {
    if (!state.map || !state.mapInitialized) return;

    // Remove highlight layer and source
    if (state.map.getLayer(this.highlightLayerId)) {
      state.map.removeLayer(this.highlightLayerId);
    }
    if (state.map.getSource(this.highlightSourceId)) {
      state.map.removeSource(this.highlightSourceId);
    }

    // Remove marker
    if (this.searchMarkerId) {
      this.searchMarkerId.remove();
      this.searchMarkerId = null;
    }
  },

  clearSearch() {
    this.searchInput.value = "";
    this.hideResults();
    this.clearHighlight();
    this.hideClearButton();
    this.currentResults = [];
  },

  showLoading() {
    this.searchResults.innerHTML =
      '<div class="search-loading">Searching...</div>';
    this.positionDropdown();
    this.searchResults.classList.remove("d-none");
  },

  showNoResults() {
    this.searchResults.innerHTML =
      '<div class="search-no-results">No results found</div>';
    this.positionDropdown();
    this.searchResults.classList.remove("d-none");
  },

  showError(message) {
    this.searchResults.innerHTML = `<div class="search-error">${message}</div>`;
    this.positionDropdown();
    this.searchResults.classList.remove("d-none");
  },

  hideResults() {
    this.searchResults.classList.add("d-none");
    this.selectedIndex = -1;
  },

  showClearButton() {
    if (this.clearSearchBtn) {
      this.clearSearchBtn.classList.remove("d-none");
    }
  },

  hideClearButton() {
    if (this.clearSearchBtn) {
      this.clearSearchBtn.classList.add("d-none");
    }
  },
};

// Make available globally for debugging
if (!window.EveryStreet) window.EveryStreet = {};
window.EveryStreet.SearchManager = searchManager;

export default searchManager;
