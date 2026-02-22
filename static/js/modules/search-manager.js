/**
 * Search Manager Module
 * Handles geocoding search for places, addresses, and streets with map highlighting
 * Fixed race conditions with proper AbortController usage
 */
/* global mapboxgl */

import apiClient from "./core/api-client.js";
import { CONFIG } from "./core/config.js";
import state from "./core/store.js";
import MapStyles from "./map-styles.js";
import { getMapboxToken } from "./mapbox-token.js";
import notificationManager from "./ui/notifications.js";
import { createElement, escapeHtml, utils } from "./utils.js";

const searchManager = {
  searchInput: null,
  searchResults: null,
  clearSearchBtn: null,
  currentResults: [],
  selectedIndex: -1,
  highlightLayerId: "search-highlight-layer",
  highlightSourceId: "search-highlight-source",
  searchMarkerId: null,
  streetGeometryCache: new Map(),
  currentSearchId: 0, // Track search requests to handle race conditions
  maxSearchResults: 12,

  initialize() {
    this.searchInput = document.getElementById("map-search-input");
    this.searchResults = document.getElementById("search-results");
    this.clearSearchBtn = document.getElementById("clear-search-btn");

    if (!this.searchInput || !this.searchResults) {
      console.warn("Search elements not found");
      return;
    }

    this.setupEventListeners();

    // Reposition dropdown on window resize
    window.addEventListener(
      "resize",
      utils.debounce(() => {
        if (!this.searchResults.classList.contains("d-none")) {
          this.positionDropdown();
        }
      }, 100)
    );
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
      }, 300)
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
          notificationManager.show("No results to select", "warning", 2000);
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

  cancelSearchRequests() {
    state.cancelRequest("searchStreets");
    state.cancelRequest("searchGeocode");
    state.cancelRequest("searchMapbox");
  },

  normalizeSearchText(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  },

  buildResultKey(result) {
    if (result?.osm_id && result?.osm_type) {
      return `osm:${String(result.osm_type).toLowerCase()}:${result.osm_id}`;
    }
    if (result?.mapbox_id) {
      return `mapbox:${result.mapbox_id}`;
    }
    if (Array.isArray(result?.center) && result.center.length === 2) {
      const [lng, lat] = result.center;
      const safeLng = Number.parseFloat(lng);
      const safeLat = Number.parseFloat(lat);
      if (Number.isFinite(safeLng) && Number.isFinite(safeLat)) {
        return [
          this.normalizeSearchText(result.name),
          safeLng.toFixed(4),
          safeLat.toFixed(4),
        ].join(":");
      }
    }
    return [
      result?.type || "unknown",
      this.normalizeSearchText(result?.name),
      this.normalizeSearchText(result?.subtitle),
    ].join(":");
  },

  scoreResult(query, result) {
    const queryText = this.normalizeSearchText(query);
    const nameText = this.normalizeSearchText(result?.name);
    const subtitleText = this.normalizeSearchText(result?.subtitle);

    let score = 0;
    if (nameText && queryText) {
      if (nameText === queryText) {
        score += 120;
      } else if (nameText.startsWith(queryText)) {
        score += 90;
      } else if (nameText.includes(queryText)) {
        score += 70;
      }
    }
    if (subtitleText && queryText && subtitleText.includes(queryText)) {
      score += 30;
    }

    if (result?.type === "street" && result?.geometry) {
      score += 8;
    }

    const importance = Number.parseFloat(result?.importance);
    if (Number.isFinite(importance)) {
      const clampedImportance = Math.max(0, Math.min(importance, 1));
      score += clampedImportance * 20;
    }

    if (result?.source === "mapbox_searchbox") {
      score += 12;
    } else if (result?.source === "nominatim") {
      score += 6;
    }

    return score;
  },

  mergeAndRankResults(query, ...resultGroups) {
    const deduped = new Map();
    for (const group of resultGroups) {
      for (const result of group || []) {
        if (!result?.name) {
          continue;
        }

        const normalized = {
          ...result,
          type:
            result.type === "street" || result.type === "address"
              ? result.type
              : "place",
        };
        const key = this.buildResultKey(normalized);
        const score = this.scoreResult(query, normalized);
        const existing = deduped.get(key);
        if (!existing || score > existing._score) {
          deduped.set(key, { ...normalized, _score: score });
        }
      }
    }

    return [...deduped.values()]
      .sort((a, b) => b._score - a._score)
      .slice(0, this.maxSearchResults)
      .map(({ _score, ...result }) => result);
  },

  async performSearch(query) {
    // Cancel any pending search requests to prevent race conditions
    const searchId = ++this.currentSearchId;
    this.cancelSearchRequests();

    try {
      this.showLoading();

      const selectedLocationId = utils.getStorage(CONFIG.STORAGE_KEYS.selectedLocation);

      const [streetSettled, geocodeSettled] = await Promise.allSettled([
        this.searchStreets(query, selectedLocationId, searchId),
        this.geocodeSearch(query, searchId),
      ]);

      if (searchId !== this.currentSearchId) {
        return;
      }

      const streetResults =
        streetSettled.status === "fulfilled" ? streetSettled.value : [];
      const geocodeResults =
        geocodeSettled.status === "fulfilled" ? geocodeSettled.value : [];

      let results = this.mergeAndRankResults(query, streetResults, geocodeResults);

      if (results.length < 6 && query.length >= 3) {
        const mapboxResults = await this.mapboxSearch(query, searchId);
        if (searchId !== this.currentSearchId) {
          return;
        }
        results = this.mergeAndRankResults(
          query,
          streetResults,
          geocodeResults,
          mapboxResults
        );
      }

      this.currentResults = results.slice(0, this.maxSearchResults);
      this.displayResults(this.currentResults);

      if (!this.currentResults || this.currentResults.length === 0) {
        notificationManager.show("No results found", "info", 2000);
      }
    } catch (error) {
      if (error.name === "AbortError") {
        return; // Request was aborted, ignore
      }
      console.error("Search error:", error);
      this.showError("Search failed. Please try again.");
    }
  },

  async searchStreets(query, locationId, searchId) {
    try {
      let url = `${CONFIG.API.searchStreets}?query=${encodeURIComponent(query)}&limit=10`;
      if (locationId) {
        url += `&location_id=${locationId}`;
      }

      const controller = state.createAbortController("searchStreets");
      const data = await apiClient.get(url, { signal: controller.signal });

      // Check if this search is still current
      if (searchId !== this.currentSearchId) {
        return [];
      }

      const features = Array.isArray(data) ? data : data.features || [];

      return features.map((feature) => {
        const locationName =
          feature.properties.location ||
          (locationId ? `Location ${locationId}` : "Unknown location");
        const streetName =
          feature.properties.street_name || feature.properties.name || "Unnamed Street";
        const segmentCount = feature.properties.segment_count;
        const segmentInfo = segmentCount
          ? ` - ${segmentCount} segment${segmentCount > 1 ? "s" : ""}`
          : "";

        return {
          type: "street",
          name: streetName,
          subtitle: `${locationName}${segmentInfo}`,
          geometry: feature.geometry,
          feature,
          locationId,
          source: "coverage_street",
        };
      });
    } catch (error) {
      if (error.name === "AbortError") {
        throw error; // Re-throw abort errors to be handled by caller
      }
      console.warn("Street search failed:", error);
      return [];
    }
  },

  async geocodeSearch(query, searchId) {
    try {
      let proximityParams = "";
      if (state.map) {
        const center = state.map.getCenter();
        proximityParams = `&proximity_lon=${center.lng}&proximity_lat=${center.lat}`;
      }

      const controller = state.createAbortController("searchGeocode");
      const data = await apiClient.get(
        `${CONFIG.API.searchGeocode}?query=${encodeURIComponent(query)}&limit=10${proximityParams}`,
        { signal: controller.signal }
      );

      // Check if this search is still current
      if (searchId !== this.currentSearchId) {
        return [];
      }

      const results = data.results || [];

      return results.map((result) => {
        const placeType = result.place_type
          ? result.place_type[0]
          : result.type || "place";
        const isStreet = ["road", "street", "highway", "residential"].includes(
          placeType
        );

        return {
          type: isStreet ? "street" : "place",
          name: result.text || result.place_name || "Unknown",
          subtitle: result.place_name || result.display_name || "",
          center: result.center || [parseFloat(result.lon), parseFloat(result.lat)],
          bbox: result.bbox,
          osm_id: result.osm_id,
          osm_type: result.osm_type,
          importance: result.importance,
          source: result.source || "nominatim",
          raw: result,
        };
      });
    } catch (error) {
      if (error.name === "AbortError") {
        throw error;
      }
      console.error("Geocode search failed:", error);
      throw error;
    }
  },

  async mapboxSearch(query, searchId) {
    const token = getMapboxToken();
    if (!token) {
      return [];
    }

    try {
      const params = new URLSearchParams({
        q: query,
        limit: "8",
        country: "us",
        access_token: token,
      });

      if (state.map) {
        const center = state.map.getCenter();
        params.set("proximity", `${center.lng},${center.lat}`);
      }

      const controller = state.createAbortController("searchMapbox");
      const data = await apiClient.get(
        `https://api.mapbox.com/search/searchbox/v1/forward?${params.toString()}`,
        {
          signal: controller.signal,
          retry: false,
          cache: true,
          cacheDuration: 2 * 60 * 1000,
        }
      );

      if (searchId !== this.currentSearchId) {
        return [];
      }

      const features = Array.isArray(data?.features) ? data.features : [];
      return features
        .map((feature) => {
          const props = feature?.properties || {};
          const geometryCenter = feature?.geometry?.coordinates;
          const coordinateCenter = [
            props?.coordinates?.longitude,
            props?.coordinates?.latitude,
          ];

          const center =
            Array.isArray(geometryCenter) && geometryCenter.length === 2
              ? geometryCenter
              : coordinateCenter;

          if (!Array.isArray(center) || center.length !== 2) {
            return null;
          }
          const lng = Number(center[0]);
          const lat = Number(center[1]);
          if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
            return null;
          }

          const featureType = String(props.feature_type || "").toLowerCase();
          const type = ["street", "address"].includes(featureType)
            ? "address"
            : "place";
          const placeName =
            props.name || props.full_address || props.place_formatted || "Unknown";
          const subtitle =
            props.full_address || props.place_formatted || props.address || "Mapbox";

          return {
            type,
            name: placeName,
            subtitle: `${subtitle} \u00b7 Mapbox`,
            center: [lng, lat],
            bbox: feature.bbox,
            mapbox_id: props.mapbox_id,
            importance: props.match_code?.confidence,
            source: "mapbox_searchbox",
            raw: feature,
          };
        })
        .filter(Boolean);
    } catch (error) {
      if (error.name === "AbortError") {
        throw error;
      }
      console.warn("Mapbox search fallback failed:", error);
      return [];
    }
  },

  _getStreetGeometryCacheKey(result, locationId) {
    const osmId = result?.osm_id;
    const osmType = String(result?.osm_type || "")
      .trim()
      .toLowerCase();
    if (!osmId || !["node", "way", "relation"].includes(osmType)) {
      return null;
    }
    return `${osmType}:${osmId}:${locationId || "none"}`;
  },

  async fetchStreetGeometry(result, locationId) {
    const cacheKey = this._getStreetGeometryCacheKey(result, locationId);
    if (!cacheKey) {
      return null;
    }

    if (this.streetGeometryCache.has(cacheKey)) {
      return this.streetGeometryCache.get(cacheKey);
    }

    try {
      const osmType = String(result.osm_type).trim().toLowerCase();
      let url =
        `${CONFIG.API.searchStreetGeometry}?osm_id=${encodeURIComponent(result.osm_id)}` +
        `&osm_type=${encodeURIComponent(osmType)}&clip_to_area=true`;
      if (locationId) {
        url += `&location_id=${encodeURIComponent(locationId)}`;
      }

      const controller = state.createAbortController("streetGeometry");
      const response = await apiClient.get(url, { signal: controller.signal });
      const cachedValue =
        response?.available === true && response?.feature?.geometry ? response : null;
      this.streetGeometryCache.set(cacheKey, cachedValue);
      return cachedValue;
    } catch (error) {
      if (error.name === "AbortError") {
        return null;
      }
      console.warn("Street geometry lookup failed:", error);
      return null;
    }
  },

  displayResults(results) {
    this.searchResults.innerHTML = "";

    if (results.length === 0) {
      this.showNoResults();
      return;
    }

    const fragment = document.createDocumentFragment();

    results.forEach((result, index) => {
      const item = document.createElement("div");
      item.className = "search-result-item";
      item.setAttribute("role", "option");
      item.setAttribute("data-index", String(index));

      const typeLabel = document.createElement("span");
      typeLabel.className = `search-result-type ${escapeHtml(result.type)}`;
      typeLabel.textContent = result.type;

      const title = document.createElement("div");
      title.className = "search-result-title";
      title.textContent = result.name; // textContent is XSS-safe

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

      fragment.appendChild(item);
    });

    this.searchResults.appendChild(fragment);
    this.positionDropdown();
    this.searchResults.classList.remove("d-none");
    this.selectedIndex = -1;
  },

  positionDropdown() {
    if (!this.searchInput || !this.searchResults) {
      return;
    }

    const inputRect = this.searchInput.getBoundingClientRect();
    const dropdownHeight = this.searchResults.offsetHeight || 300;
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const spaceBelow = viewportHeight - inputRect.bottom;
    const spaceAbove = inputRect.top;

    const showAbove =
      spaceBelow < Math.min(dropdownHeight + 20, 200) && spaceAbove > spaceBelow;

    if (showAbove) {
      this.searchResults.style.top = "auto";
      this.searchResults.style.bottom = `${viewportHeight - inputRect.top + 8}px`;
      this.searchResults.classList.add("above");
    } else {
      this.searchResults.style.top = `${inputRect.bottom + 8}px`;
      this.searchResults.style.bottom = "auto";
      this.searchResults.classList.remove("above");
    }

    const minWidth = 280;
    const preferredWidth = Math.max(inputRect.width, minWidth);
    let leftPosition = inputRect.left;

    if (leftPosition + preferredWidth > viewportWidth - 20) {
      leftPosition = Math.max(20, viewportWidth - preferredWidth - 20);
    }
    if (leftPosition < 20) {
      leftPosition = 20;
    }

    this.searchResults.style.left = `${leftPosition}px`;
    this.searchResults.style.width = `${Math.min(preferredWidth, viewportWidth - 40)}px`;
  },

  navigateResults(direction) {
    if (this.currentResults.length === 0) {
      return;
    }

    const previousIndex = this.selectedIndex;
    this.selectedIndex += direction;

    if (this.selectedIndex < 0) {
      this.selectedIndex = this.currentResults.length - 1;
    } else if (this.selectedIndex >= this.currentResults.length) {
      this.selectedIndex = 0;
    }

    this.updateSelectedItem();

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
    this.hideResults();
    this.searchInput.value = result.name;

    if (result.type === "street") {
      if (result.geometry) {
        await this.highlightStreet(result);
      } else {
        const selectedLocationId = utils.getStorage(
          CONFIG.STORAGE_KEYS.selectedLocation
        );
        const resolved = await this.fetchStreetGeometry(result, selectedLocationId);
        if (resolved?.feature?.geometry) {
          await this.highlightStreet({
            ...result,
            geometry: resolved.feature.geometry,
            feature: resolved.feature,
          });
        } else if (result.center) {
          this.panToLocation(result, { showNotification: false });
        }
      }
    } else if (result.center) {
      this.panToLocation(result);
    }

    utils.announce(`Selected ${result.type}: ${result.name}`);
  },

  highlightStreet(result) {
    if (!state.map || !state.mapInitialized) {
      console.warn("Map not initialized");
      return;
    }

    this.clearHighlight();

    const { geometry } = result;

    try {
      if (!state.map.getSource(this.highlightSourceId)) {
        state.map.addSource(this.highlightSourceId, {
          type: "geojson",
          data: {
            type: "FeatureCollection",
            features: [
              { type: "Feature", geometry, properties: { name: result.name } },
            ],
          },
        });
      } else {
        state.map.getSource(this.highlightSourceId).setData({
          type: "FeatureCollection",
          features: [{ type: "Feature", geometry, properties: { name: result.name } }],
        });
      }

      if (!state.map.getLayer(this.highlightLayerId)) {
        state.map.addLayer({
          id: this.highlightLayerId,
          type: "line",
          source: this.highlightSourceId,
          paint: {
            "line-color": MapStyles.MAP_LAYER_COLORS?.trips?.selected || "#d09868",
            "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 15, 6, 20, 12],
            "line-opacity": 0.9,
          },
        });
      }

      // Fit bounds to the geometry
      const coords =
        geometry.type === "LineString"
          ? geometry.coordinates
          : geometry.type === "MultiLineString"
            ? geometry.coordinates.flat()
            : geometry.type === "Point"
              ? [geometry.coordinates]
              : [];

      if (coords.length > 0) {
        const bounds = coords.reduce(
          (b, coord) => b.extend(coord),
          new mapboxgl.LngLatBounds(coords[0], coords[0])
        );

        state.map.fitBounds(bounds, {
          padding: 100,
          maxZoom: 16,
          duration: 1000,
        });
      }

      const segmentInfo = result.feature?.properties?.segment_count
        ? ` (${result.feature.properties.segment_count} segments)`
        : "";

      notificationManager.show(
        `Highlighted: ${escapeHtml(result.name)}${segmentInfo}`,
        "success",
        3000
      );
    } catch (error) {
      console.error("Error highlighting street:", error);
      notificationManager.show("Failed to highlight street", "warning", 3000);
    }
  },

  panToLocation(result, { showNotification = true } = {}) {
    if (!state.map || !state.mapInitialized || !result.center) {
      return;
    }

    this.clearHighlight();

    const [lng, lat] = result.center;

    if (this.searchMarkerId) {
      this.searchMarkerId.remove();
    }

    // Create popup with safe content
    const popupContent = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = result.name;
    popupContent.appendChild(strong);
    popupContent.appendChild(document.createElement("br"));
    popupContent.appendChild(document.createTextNode(result.subtitle));

    this.searchMarkerId = new mapboxgl.Marker({
      color: MapStyles.MAP_LAYER_COLORS?.trips?.selected || "#d09868",
    })
      .setLngLat([lng, lat])
      .setPopup(new mapboxgl.Popup({ offset: 25 }).setDOMContent(popupContent))
      .addTo(state.map);

    if (result.bbox?.length === 4) {
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
        }
      );
    } else {
      state.map.flyTo({ center: [lng, lat], zoom: 14, duration: 1000 });
    }

    if (showNotification) {
      notificationManager.show(
        `Navigated to: ${escapeHtml(result.name)}`,
        "success",
        3000
      );
    }
  },

  clearHighlight() {
    if (!state.map || !state.mapInitialized) {
      return;
    }

    if (state.map.getLayer(this.highlightLayerId)) {
      state.map.removeLayer(this.highlightLayerId);
    }
    if (state.map.getSource(this.highlightSourceId)) {
      state.map.removeSource(this.highlightSourceId);
    }

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
    this.cancelSearchRequests();
    state.cancelRequest("streetGeometry");
  },

  showLoading() {
    const loading = createElement("div", "Searching...", "search-loading");
    this.searchResults.innerHTML = "";
    this.searchResults.appendChild(loading);
    this.positionDropdown();
    this.searchResults.classList.remove("d-none");
  },

  showNoResults() {
    const noResults = createElement("div", "No results found", "search-no-results");
    this.searchResults.innerHTML = "";
    this.searchResults.appendChild(noResults);
    this.positionDropdown();
    this.searchResults.classList.remove("d-none");
  },

  showError(message) {
    const error = createElement("div", message, "search-error");
    this.searchResults.innerHTML = "";
    this.searchResults.appendChild(error);
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

export default searchManager;
