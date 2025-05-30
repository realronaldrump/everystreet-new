/* global L, DateUtils */

document.addEventListener("DOMContentLoaded", () => {
  let editMap = null;
  let tripsLayerGroup = null;
  let editableLayers = null;
  let currentTrip = null;
  let editMode = false;

  async function init() {
    initializeMap();
    initializeControls();
    initializeEventListeners();
    await loadTrips();
  }

  function initializeMap() {
    const mapEl = document.getElementById("editMap");
    if (!mapEl) return;

    // Use shared map factory for Leaflet
    editMap = window.mapBase.createMap(mapEl.id, {
      library: "leaflet",
      center: [37.0902, -95.7129],
      zoom: 4,
      tileLayer:
        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      tileOptions: { maxZoom: 19, attribution: "" },
    });

    tripsLayerGroup = L.featureGroup().addTo(editMap);
    editableLayers = L.featureGroup().addTo(editMap);
  }

  function initializeControls() {
    if (!editMap || typeof L.Control.Draw !== "function") {
      console.error(
        "Leaflet Draw is missing. Ensure leaflet.draw.js is included.",
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
      }),
    );
  }

  function initializeEventListeners() {
    const editModeToggle = document.getElementById("editModeToggle");
    if (editModeToggle) {
      editModeToggle.addEventListener("change", toggleEditMode);
    }

    const tripTypeSelect = document.getElementById("tripType");
    if (tripTypeSelect) {
      tripTypeSelect.addEventListener("change", loadTrips);
    }

    const saveChangesBtn = document.getElementById("saveChanges");
    if (saveChangesBtn) {
      saveChangesBtn.addEventListener("mousedown", function (e) {
        if (e.button !== 0) return;
        saveTripChanges(e);
      });
    }

    const startInput = document.getElementById("start-date");
    const endInput = document.getElementById("end-date");
    if (startInput) {
      startInput.addEventListener("change", loadTrips);
    }
    if (endInput) {
      endInput.addEventListener("change", loadTrips);
    }

    if (document.getElementById("editMap")) {
      const applyFiltersBtn = document.getElementById("apply-filters");
      if (applyFiltersBtn) {
        applyFiltersBtn.addEventListener("mousedown", function (e) {
          if (e.button !== 0) return;
          loadTrips(e);
        });
      }
    }

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

  async function loadTrips() {
    try {
      const startInput = document.getElementById("start-date");
      const endInput = document.getElementById("end-date");
      const startDate =
        startInput?.value ||
        window.utils.getStorage("startDate") ||
        DateUtils.getYesterday();
      const endDate =
        endInput?.value ||
        window.utils.getStorage("endDate") ||
        DateUtils.getYesterday();

      window.utils.setStorage("startDate", startDate);
      window.utils.setStorage("endDate", endDate);

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
          `Error loading trips: ${error.message}`,
          "danger",
        );
      }
    }
  }

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
            `Skipping trip ${trip.transactionId} (no valid coordinates)`,
          );
          return null;
        }

        const coordsLatLng = gps.coordinates.map(([lon, lat]) => [lat, lon]);

        const poly = L.polyline(coordsLatLng, {
          color: "#BB86FC",
          weight: 3,
          opacity: 0.8,
        });

        poly.on("mousedown", (e) => {
          if (e.originalEvent && e.originalEvent.button !== 0) return;
          selectTrip(poly, trip);
        });
        tripsLayerGroup.addLayer(poly);
        return poly;
      })
      .filter(Boolean);

    if (layers.length > 0) {
      const group = L.featureGroup(layers);
      editMap.fitBounds(group.getBounds());
    }
  }

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

  function resetTripStyle(layer) {
    layer.setStyle({
      color: "#BB86FC",
      weight: 3,
      opacity: 0.6,
    });
  }

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

  function createEditableMarkers(coordinates) {
    editableLayers.clearLayers();

    coordinates.forEach(([lon, lat], index) => {
      const marker = L.marker([lat, lon], {
        draggable: true,
        pointIndex: index,
      });

      marker.on("dragend", (e) =>
        updatePointInTrip(index, e.target.getLatLng()),
      );
      editableLayers.addLayer(marker);
    });
  }

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

  function addPointToTrip(latLng) {
    if (!currentTrip) return;

    const coords = currentTrip.tripData.geometry.coordinates;
    const index = findClosestPointIndex(latLng, coords);

    coords.splice(index + 1, 0, [latLng.lng, latLng.lat]);

    updateTripPolyline();
    createEditableMarkers(coords);
  }

  function updatePointInTrip(index, latLng) {
    if (!currentTrip) return;

    currentTrip.tripData.geometry.coordinates[index] = [latLng.lng, latLng.lat];

    updateTripPolyline();
    createEditableMarkers(currentTrip.tripData.geometry.coordinates);
  }

  function updateTripPolyline() {
    if (!currentTrip) return;

    const coords = currentTrip.tripData.geometry.coordinates;
    const latLngs = coords.map(([lon, lat]) => [lat, lon]);

    currentTrip.layer.setLatLngs(latLngs);
  }

  async function saveTripChanges() {
    if (!currentTrip) {
      window.notificationManager?.show("No trip selected to save.", "warning");
      return;
    }

    try {
      const tripId =
        currentTrip.tripData.properties?.transactionId ||
        currentTrip.tripData.transactionId;

      if (!tripId) {
        console.error(
          "Error: transactionId is undefined.",
          currentTrip.tripData,
        );
        window.notificationManager?.show(
          "Error: Could not find the trip ID to save changes.",
          "danger",
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
        "success",
      );
    } catch (error) {
      console.error("Error saving trip:", error);
      window.notificationManager?.show(
        `Error saving trip: ${error.message}`,
        "danger",
      );
    }
  }

  init();
});
