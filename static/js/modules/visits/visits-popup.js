/* global DateUtils */

/**
 * Visits Popup Module
 * Handles popup display and place statistics rendering
 */

(() => {
  class VisitsPopup {
    constructor(options = {}) {
      this.mapController = options.mapController;
      this.dataLoader = options.dataLoader;
      this.notificationManager =
        options.notificationManager || window.notificationManager;
      this.onViewTrips = options.onViewTrips || (() => {});
      this.onZoomToPlace = options.onZoomToPlace || (() => {});
    }

    /**
     * Set the map controller reference
     * @param {Object} mapController - Map controller instance
     */
    setMapController(mapController) {
      this.mapController = mapController;
    }

    /**
     * Set the data loader reference
     * @param {Object} dataLoader - Data loader instance
     */
    setDataLoader(dataLoader) {
      this.dataLoader = dataLoader;
    }

    /**
     * Show place statistics in a popup
     * @param {string} placeId - Place ID
     * @param {Object} place - Place data
     * @param {Object} lngLat - Longitude/latitude coordinates (optional)
     */
    async showPlaceStatistics(placeId, place, lngLat = null) {
      if (!place) return;

      let targetLngLat = lngLat;
      if (!targetLngLat && place.geometry?.coordinates) {
        const coords = window.VisitsGeometry.collectCoordinates(place.geometry);
        if (coords.length) {
          targetLngLat = { lng: coords[0][0], lat: coords[0][1] };
        }
      }

      // Show loading popup
      const popup = this.mapController?.showPlacePopup(
        this._createLoadingPopupHTML(place.name),
        targetLngLat,
      );

      try {
        const stats = await this.dataLoader.loadPlaceDetailStatistics(placeId);
        const popupContent = this._createStatsPopupHTML(
          placeId,
          place.name,
          stats,
        );

        popup?.setHTML(popupContent);

        // Bind button events after DOM update
        setTimeout(() => {
          this._bindPopupButtons(popup, placeId);
        }, 100);
      } catch (error) {
        console.error("Error fetching place statistics:", error);
        popup?.setHTML(this._createErrorPopupHTML(place.name));
        this.notificationManager?.show(
          "Failed to fetch place statistics",
          "danger",
        );
      }
    }

    /**
     * Create loading state popup HTML
     * @param {string} placeName - Name of the place
     * @returns {string} HTML string
     */
    _createLoadingPopupHTML(placeName) {
      return `
        <div class="custom-place-popup">
          <h6><i class="fas fa-map-marker-alt me-2"></i>${placeName}</h6>
          <div class="text-center py-3">
            <div class="spinner-border spinner-border-sm text-primary" role="status">
              <span class="visually-hidden">Loading...</span>
            </div>
            <p class="mb-0 mt-2 text-muted small">Fetching statistics...</p>
          </div>
        </div>
      `;
    }

    /**
     * Create statistics popup HTML
     * @param {string} placeId - Place ID
     * @param {string} placeName - Place name
     * @param {Object} stats - Statistics data
     * @returns {string} HTML string
     */
    _createStatsPopupHTML(placeId, placeName, stats) {
      const formatDate = (dateStr) =>
        dateStr
          ? DateUtils.formatForDisplay(dateStr, { dateStyle: "medium" })
          : "N/A";
      const formatAvg = (value) => value || "N/A";

      return `
        <div class="custom-place-popup">
          <h6><i class="fas fa-map-marker-alt me-2 text-primary"></i>${placeName}</h6>
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
        </div>
      `;
    }

    /**
     * Create error state popup HTML
     * @param {string} placeName - Name of the place
     * @returns {string} HTML string
     */
    _createErrorPopupHTML(placeName) {
      return `
        <div class="custom-place-popup">
          <h6><i class="fas fa-map-marker-alt me-2"></i>${placeName}</h6>
          <div class="alert alert-danger mb-0">
            <i class="fas fa-exclamation-triangle me-2"></i>
            Error loading statistics
          </div>
        </div>
      `;
    }

    /**
     * Bind event handlers to popup buttons
     * @param {Object} popup - Mapbox popup instance
     * @param {string} placeId - Place ID
     */
    _bindPopupButtons(popup) {
      const popupNode = popup?.getElement();
      if (!popupNode) return;

      popupNode
        .querySelector(".view-trips-btn")
        ?.addEventListener("click", (e) => {
          e.preventDefault();
          const id = e.currentTarget.getAttribute("data-place-id");
          if (id) {
            this.mapController?.closePopup();
            this.onViewTrips(id);
          }
        });

      popupNode
        .querySelector(".zoom-to-place-btn")
        ?.addEventListener("click", (e) => {
          e.preventDefault();
          const id = e.currentTarget.getAttribute("data-place-id");
          if (id) {
            this.onZoomToPlace(id);
          }
        });
    }
  }

  window.VisitsPopup = VisitsPopup;
})();
