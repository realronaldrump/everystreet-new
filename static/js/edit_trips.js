/* global L, flatpickr, notificationManager, bootstrap, DateUtils, $ */

document.addEventListener("DOMContentLoaded", () => {
  let editMap = null;
  let tripsLayerGroup = null;
  let editableLayers = null;
  let currentTrip = null;
  let editMode = false;

  /**
   * Initialize the trip editor
   */
  async function init() {
    initializeMap();
    initializeControls();
    initializeEventListeners();
    await loadTrips();
  }

  /**
   * Initialize the map for trip editing
   */
  function initializeMap() {
    const mapContainer = document.getElementById("editMap");
    if (!mapContainer) return;

    editMap = L.map("editMap").setView([37.0902, -95.7129], 4);

    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      {
        maxZoom: 19,
        attribution: "",
      }
    ).addTo(editMap);

    tripsLayerGroup = L.featureGroup().addTo(editMap);
    editableLayers = L.featureGroup().addTo(editMap);
  }

  /**
   * Initialize Leaflet.Draw controls
   */
  function initializeControls() {
    if (!editMap || typeof L.Control.Draw !== "function") {
      console.error(
        "Leaflet Draw is missing. Ensure leaflet.draw.js is included."
      );
      return;
    }

    editMap.addControl(
      new L.Control.Draw({
        edit: {
          featureGroup: editableLayers,
          edit: true,
          remove: true,
        },
        draw: {
          marker: true,
          polyline: false,
          circle: false,
          rectangle: false,
          polygon: false,
        },
      })
    );
  }

  /**
   * Initialize event listeners
   */
  function initializeEventListeners() {
    // Toggle edit mode
    const editModeToggle = document.getElementById("editModeToggle");
    if (editModeToggle) {
      editModeToggle.addEventListener("change", toggleEditMode);
    }

    // Trip type selector
    const tripTypeSelect = document.getElementById("tripType");
    if (tripTypeSelect) {
      tripTypeSelect.addEventListener("change", loadTrips);
    }

    // Save changes button
    const saveChangesBtn = document.getElementById("saveChanges");
    if (saveChangesBtn) {
      saveChangesBtn.addEventListener("click", saveTripChanges);
    }

    // Date inputs
    const startInput = document.getElementById("start-date");
    const endInput = document.getElementById("end-date");
    if (startInput) {
      startInput.addEventListener("change", loadTrips);
    }
    if (endInput) {
      endInput.addEventListener("change", loadTrips);
    }

    // Apply filters button (if present on edit_trips page)
    if (document.getElementById("editMap")) {
      const applyFiltersBtn = document.getElementById("apply-filters");
      if (applyFiltersBtn) {
        applyFiltersBtn.addEventListener("click", loadTrips);
      }
    }

    // Leaflet.Draw created event
    if (editMap) {
      editMap.on(L.Draw.Event.CREATED, (e) => {
        if (editMode && currentTrip) {
          const newMarker = e.layer;
          const latLng = newMarker.getLatLng();
          addPointToTrip(latLng);
        }
      });
    }
  }

  /**
   * Get a fallback date (yesterday)
   * @returns {string} Yesterday's date in YYYY-MM-DD format
   */
  function getFallbackDate() {
    return DateUtils.getYesterday();
  }

  /**
   * Load trips from API
   */
  async function loadTrips() {
    try {
      // Get dates from inputs or localStorage or fallback
      const startDate =
        document.getElementById("start-date")?.value ||
        localStorage.getItem("startDate") ||
        getFallbackDate();

      const endDate =
        document.getElementById("end-date")?.value ||
        localStorage.getItem("endDate") ||
        getFallbackDate();

      // Save the chosen dates to localStorage
      localStorage.setItem("startDate", startDate);
      localStorage.setItem("endDate", endDate);

      // Get selected trip type
      const tripTypeSelect = document.getElementById("tripType");
      if (!tripTypeSelect) return;

      const tripType = tripTypeSelect.value;
      const url =
        tripType === "matched_trips"
          ? `/api/matched_trips?start_date=${startDate}&end_date=${endDate}`
          : `/api/trips?start_date=${startDate}&end_date=${endDate}`;

      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch trips");

      const data = await res.json();
      if (!data.features || data.features.length === 0) {
        console.warn("No trips found for selected dates.");
        tripsLayerGroup.clearLayers();
        return;
      }

      displayTripsOnMap(data.features);
    } catch (error) {
      console.error("Error loading trips:", error);
      if (window.notificationManager) {
        window.notificationManager.show(
          "Error loading trips: " + error.message,
          "danger"
        );
      }
    }
  }

  /**
   * Display trips on the map
   * @param {Array} trips - Array of trip features
   */
  function displayTripsOnMap(trips) {
    if (!tripsLayerGroup) return;

    tripsLayerGroup.clearLayers();
    editableLayers.clearLayers();
    currentTrip = null;

    if (!trips || trips.length === 0) {
      console.warn("No trips to display.");
      return;
    }

    const layers = trips
      .map((trip) => {
        const gps = trip.geometry || trip.gps;
        if (!gps || gps.type !== "LineString" || !gps.coordinates?.length) {
          console.warn(
            `Skipping trip ${trip.transactionId} (no valid coordinates)`
          );
          return null;
        }

        // Convert GeoJSON coordinates ([lon, lat]) to Leaflet ([lat, lon])
        const coordsLatLng = gps.coordinates.map(([lon, lat]) => [lat, lon]);

        const poly = L.polyline(coordsLatLng, {
          color: "#BB86FC",
          weight: 3,
          opacity: 0.8,
        });

        poly.on("click", () => selectTrip(poly, trip));
        tripsLayerGroup.addLayer(poly);
        return poly;
      })
      .filter(Boolean);

    if (layers.length > 0) {
      const group = L.featureGroup(layers);
      editMap.fitBounds(group.getBounds());
    }
  }

  /**
   * Select a trip for editing
   * @param {L.Polyline} layer - Leaflet polyline layer
   * @param {Object} tripData - Trip data
   */
  function selectTrip(layer, tripData) {
    if (currentTrip) {
      resetTripStyle(currentTrip.layer);
    }

    currentTrip = { layer, tripData };
    layer.setStyle({ color: "#FFD700", weight: 5, opacity: 1 });

    if (editMode) {
      createEditableMarkers(tripData.geometry.coordinates);
    }
  }

  /**
   * Reset trip style to default
   * @param {L.Polyline} layer - Leaflet polyline layer
   */
  function resetTripStyle(layer) {
    layer.setStyle({
      color: "#BB86FC",
      weight: 3,
      opacity: 0.6,
    });
  }

  /**
   * Toggle edit mode
   * @param {Event} e - Change event
   */
  function toggleEditMode(e) {
    editMode = e.target.checked;

    const saveChangesBtn = document.getElementById("saveChanges");
    if (saveChangesBtn) {
      saveChangesBtn.disabled = !editMode;
    }

    if (!editMode) {
      editableLayers.clearLayers();
    } else if (currentTrip) {
      createEditableMarkers(currentTrip.tripData.geometry.coordinates);
    }
  }

  /**
   * Create editable markers for trip points
   * @param {Array} coordinates - Trip coordinates
   */
  function createEditableMarkers(coordinates) {
    editableLayers.clearLayers();

    coordinates.forEach(([lon, lat], index) => {
      const marker = L.marker([lat, lon], {
        draggable: true,
        pointIndex: index,
      });

      marker.on("dragend", (e) =>
        updatePointInTrip(index, e.target.getLatLng())
      );
      editableLayers.addLayer(marker);
    });
  }

  /**
   * Find the closest point index to insert a new point
   * @param {L.LatLng} latLng - New point position
   * @param {Array} coordinates - Existing coordinates
   * @returns {number} Index where the new point should be inserted
   */
  function findClosestPointIndex(latLng, coordinates) {
    let closestIndex = 0;
    let minDistance = Infinity;
    const point = L.latLng(latLng);

    for (let i = 0; i < coordinates.length; i++) {
      const coord = L.latLng(coordinates[i][1], coordinates[i][0]);
      const distance = point.distanceTo(coord);

      if (distance < minDistance) {
        minDistance = distance;
        closestIndex = i;
      }
    }

    return closestIndex;
  }

  /**
   * Add a new point to the trip
   * @param {L.LatLng} latLng - New point position
   */
  function addPointToTrip(latLng) {
    if (!currentTrip) return;

    const coords = currentTrip.tripData.geometry.coordinates;
    const index = findClosestPointIndex(latLng, coords);

    // Insert new point after the closest existing point
    coords.splice(index + 1, 0, [latLng.lng, latLng.lat]);

    updateTripPolyline();
    createEditableMarkers(coords);
  }

  /**
   * Update an existing point in the trip
   * @param {number} index - Point index
   * @param {L.LatLng} latLng - New point position
   */
  function updatePointInTrip(index, latLng) {
    if (!currentTrip) return;

    currentTrip.tripData.geometry.coordinates[index] = [latLng.lng, latLng.lat];

    updateTripPolyline();
    createEditableMarkers(currentTrip.tripData.geometry.coordinates);
  }

  /**
   * Update the trip polyline with the current coordinates
   */
  function updateTripPolyline() {
    if (!currentTrip) return;

    const coords = currentTrip.tripData.geometry.coordinates;
    const latLngs = coords.map(([lon, lat]) => [lat, lon]);

    currentTrip.layer.setLatLngs(latLngs);
  }

  /**
   * Save trip changes to the server
   */
  async function saveTripChanges() {
    if (!currentTrip) {
      window.notificationManager?.show("No trip selected to save.", "warning");
      return;
    }

    try {
      // Get trip ID from properties or directly from tripData
      let tripId =
        currentTrip.tripData.properties?.transactionId ||
        currentTrip.tripData.transactionId;

      if (!tripId) {
        console.error(
          "Error: transactionId is undefined.",
          currentTrip.tripData
        );
        window.notificationManager?.show(
          "Error: Could not find the trip ID to save changes.",
          "danger"
        );
        return;
      }

      const isMatchedTrip =
        document.getElementById("tripType")?.value === "matched_trips";
      const baseUrl = isMatchedTrip ? "/api/matched_trips" : "/api/trips";
      const url = `${baseUrl}/${tripId}`;

      const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          geometry: currentTrip.tripData.geometry,
          type: isMatchedTrip ? "matched_trips" : "trips",
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to save trip changes: ${response.status}`);
      }

      window.notificationManager?.show(
        "Trip changes saved successfully.",
        "success"
      );
    } catch (error) {
      console.error("Error saving trip:", error);
      window.notificationManager?.show(
        `Error saving trip: ${error.message}`,
        "danger"
      );
    }
  }

  // Initialize the editor
  init();
});
