/* global L, flatpickr, notificationManager, bootstrap, $ */

document.addEventListener("DOMContentLoaded", () => {
  let editMap = null,
    tripsLayerGroup = null,
    editableLayers = null;
  let currentTrip = null;
  let editMode = false;

  async function init() {
    initializeMap();
    initializeControls();
    initializeEventListeners();
    await loadTrips();
  }

  function initializeMap() {
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

  function initializeControls() {
    if (typeof L.Control.Draw !== "function") {
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

  function initializeEventListeners() {
    document
      .getElementById("editModeToggle")
      ?.addEventListener("change", toggleEditMode);
    document.getElementById("tripType")?.addEventListener("change", loadTrips);
    document
      .getElementById("saveChanges")
      ?.addEventListener("click", saveTripChanges);
    // Also update trips when the date inputs change (if they exist)
    const startInput = document.getElementById("start-date");
    const endInput = document.getElementById("end-date");
    if (startInput) {
      startInput.addEventListener("change", loadTrips);
    }
    if (endInput) {
      endInput.addEventListener("change", loadTrips);
    }
    // Additionally, if the sidebar's "Apply Filters" button is present,
    // attach a listener to trigger loadTrips on the edit_trips page.
    if (document.getElementById("editMap")) {
      document
        .getElementById("apply-filters")
        ?.addEventListener("click", loadTrips);
    }
    editMap.on(L.Draw.Event.CREATED, (e) => {
      if (editMode && currentTrip) {
        const newMarker = e.layer;
        const latLng = newMarker.getLatLng();
        addPointToTrip(latLng);
      }
    });
  }

  // Helper: Return yesterday's date in YYYY-MM-DD format.
  function getFallbackDate() {
    const dateObj = new Date();
    dateObj.setDate(dateObj.getDate() - 1);
    return dateObj.toISOString().split("T")[0];
  }

  async function loadTrips() {
    try {
      // Get dates from inputs if available; otherwise from localStorage; otherwise fallback to yesterday.
      const startDate =
        (document.getElementById("start-date") &&
          document.getElementById("start-date").value) ||
        localStorage.getItem("startDate") ||
        getFallbackDate();
      const endDate =
        (document.getElementById("end-date") &&
          document.getElementById("end-date").value) ||
        localStorage.getItem("endDate") ||
        getFallbackDate();

      // Save the chosen dates to localStorage
      localStorage.setItem("startDate", startDate);
      localStorage.setItem("endDate", endDate);

      const tripType = document.getElementById("tripType").value;
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
    }
  }

  function displayTripsOnMap(trips) {
    tripsLayerGroup.clearLayers();
    editableLayers.clearLayers();
    currentTrip = null;

    if (trips.length === 0) {
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

  function selectTrip(layer, tripData) {
    if (currentTrip) {
      resetTripStyle(currentTrip.layer, currentTrip.tripData);
    }
    currentTrip = { layer, tripData };
    layer.setStyle({ color: "#FFD700", weight: 5, opacity: 1 });

    if (editMode) {
      createEditableMarkers(tripData.geometry.coordinates);
    }
  }

  function resetTripStyle(layer, tripData) {
    layer.setStyle({
      color: "#BB86FC",
      weight: 3,
      opacity: 0.6,
    });
  }

  function toggleEditMode(e) {
    editMode = e.target.checked;
    document.getElementById("saveChanges").disabled = !editMode;
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
        updatePointInTrip(index, e.target.getLatLng())
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
      notificationManager.show("No trip selected to save.", "warning");
      return;
    }

    try {
      let tripId = currentTrip.tripData.properties?.transactionId;
      if (!tripId) {
        tripId = currentTrip.tripData.transactionId;
      }
      const isMatchedTrip =
        document.getElementById("tripType").value === "matched_trips";
      const baseUrl = isMatchedTrip ? "/api/matched_trips" : "/api/trips";
      if (!tripId) {
        console.error(
          "Error: transactionId is undefined.",
          currentTrip.tripData
        );
        notificationManager.show(
          "Error: Could not find the trip ID to save changes.",
          "danger"
        );
        return;
      }
      const url = `${baseUrl}/${tripId}`;
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          geometry: currentTrip.tripData.geometry,
          type: isMatchedTrip ? "matched_trips" : "trips",
        }),
      });
      if (!res.ok)
        throw new Error(`Failed to save trip changes: ${res.status}`);
      notificationManager.show("Trip changes saved successfully.", "success");
    } catch (error) {
      console.error("Error saving trip:", error);
      notificationManager.show(`Error saving trip: ${error.message}`, "danger");
    }
  }

  init();
});
