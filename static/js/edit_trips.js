/* global mapboxgl, MapboxDraw */

document.addEventListener("DOMContentLoaded", () => {
  let editMap = null;
  let draw = null;
  const tripsSourceId = "trips-source";
  const tripsLayerId = "trips-layer";
  const markersSourceId = "markers-source";
  const markersLayerId = "markers-layer";
  let currentTrip = null;
  let editMode = false;
  let tripFeatures = [];

  async function init() {
    await initializeMap();
    initializeControls();
    initializeEventListeners();
    await loadTrips();
  }

  async function initializeMap() {
    const mapEl = document.getElementById("editMap");
    if (!mapEl) return;

    editMap = window.mapBase.createMap(mapEl.id, {
      center: [-95.7129, 37.0902],
      zoom: 4,
    });

    // Wait for map style to load before adding sources/layers
    await new Promise((resolve) => {
      if (editMap.isStyleLoaded()) {
        resolve();
      } else {
        editMap.once("styledata", resolve);
        // Fallback timeout
        setTimeout(resolve, 1000);
      }
    });

    // Initialize GeoJSON sources
    editMap.addSource(tripsSourceId, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      generateId: true,
    });

    editMap.addSource(markersSourceId, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      generateId: true,
    });

    // Add trips layer
    editMap.addLayer({
      id: tripsLayerId,
      type: "line",
      source: tripsSourceId,
      paint: {
        "line-color":
          window.MapStyles?.getTripStyle?.("default")?.color || "#3388ff",
        "line-width": 3,
        "line-opacity": 0.8,
      },
      layout: {
        "line-join": "round",
        "line-cap": "round",
      },
    });

    // Add markers layer
    editMap.addLayer({
      id: markersLayerId,
      type: "circle",
      source: markersSourceId,
      paint: {
        "circle-radius": 6,
        "circle-color": "#ff0000",
        "circle-stroke-width": 2,
        "circle-stroke-color": "#ffffff",
      },
    });

    // Handle trip clicks
    editMap.on("click", tripsLayerId, (e) => {
      if (e.originalEvent?.button !== 0) return;
      const feature = e.features[0];
      if (feature) {
        selectTrip(feature);
      }
    });

    // Change cursor on hover
    editMap.on("mouseenter", tripsLayerId, () => {
      editMap.getCanvas().style.cursor = "pointer";
    });
    editMap.on("mouseleave", tripsLayerId, () => {
      editMap.getCanvas().style.cursor = "";
    });
  }

  function initializeControls() {
    if (!editMap || typeof MapboxDraw === "undefined") {
      console.error(
        "MapboxDraw is missing. Ensure mapbox-gl-draw.js is included.",
      );
      return;
    }

    draw = new MapboxDraw({
      displayControlsDefault: false,
      controls: {
        point: true,
        trash: true,
      },
      defaultMode: "simple_select",
      userProperties: true,
    });

    editMap.addControl(draw);

    editMap.on("draw.create", (e) => {
      if (editMode && currentTrip) {
        const feature = e.features[0];
        if (feature.geometry.type === "Point") {
          const [lng, lat] = feature.geometry.coordinates;
          addPointToTrip({ lat, lng });
          // Remove the point from draw since we handle it ourselves
          draw.delete(e.features[0].id);
        }
      }
    });

    editMap.on("draw.update", (e) => {
      if (!editMode || !currentTrip) return;

      e.features.forEach((feature) => {
        if (feature.geometry.type === "Point") {
          const index = feature.properties?.index;
          if (index !== undefined) {
            const [lng, lat] = feature.geometry.coordinates;
            updatePointInTrip(index, { lat, lng });
          }
        }
      });
    });
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
  }

  async function loadTrips() {
    try {
      const startInput = document.getElementById("start-date");
      const endInput = document.getElementById("end-date");
      const startDate =
        startInput?.value ||
        window.utils.getStorage("startDate") ||
        window.DateUtils.getYesterday();
      const endDate =
        endInput?.value ||
        window.utils.getStorage("endDate") ||
        window.DateUtils.getYesterday();

      // Validate date range
      if (!window.DateUtils.isValidDateRange(startDate, endDate)) {
        throw new Error(
          "Invalid date range. Start date must be before or equal to end date.",
        );
      }

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
        clearTrips();
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
    if (!editMap) return;

    clearTrips();
    currentTrip = null;

    if (!trips || trips.length === 0) {
      console.warn("No trips to display.");
      return;
    }

    tripFeatures = trips.filter((trip) => {
      const gps = trip.geometry || trip.gps;
      return (
        gps &&
        gps.type === "LineString" &&
        gps.coordinates &&
        gps.coordinates.length > 0
      );
    });

    if (tripFeatures.length === 0) {
      console.warn("No valid trips to display.");
      return;
    }

    // Update source with all trips
    const source = editMap.getSource(tripsSourceId);
    if (source) {
      source.setData({
        type: "FeatureCollection",
        features: tripFeatures,
      });
    }

    // Fit bounds to all trips
    if (tripFeatures.length > 0) {
      const bounds = tripFeatures.reduce((bounds, feature) => {
        const coords = feature.geometry.coordinates;
        coords.forEach(([lng, lat]) => {
          bounds.extend([lng, lat]);
        });
        return bounds;
      }, new mapboxgl.LngLatBounds());

      editMap.fitBounds(bounds, {
        padding: 50,
        maxZoom: 15,
      });
    }
  }

  function clearTrips() {
    const tripsSource = editMap?.getSource(tripsSourceId);
    if (tripsSource) {
      tripsSource.setData({ type: "FeatureCollection", features: [] });
    }
    const markersSource = editMap?.getSource(markersSourceId);
    if (markersSource) {
      markersSource.setData({ type: "FeatureCollection", features: [] });
    }
    tripFeatures = [];
    currentTrip = null;
  }

  function selectTrip(feature) {
    if (!editMap) return;

    // Reset previous selection
    if (currentTrip) {
      updateTripStyle(currentTrip, "default");
    }

    currentTrip = feature;
    updateTripStyle(feature, "selected");

    if (editMode) {
      createEditableMarkers(feature.geometry.coordinates);
    }
  }

  function updateTripStyle(feature, styleType) {
    if (!editMap || !feature) return;

    const style = window.MapStyles?.getTripStyle?.(styleType) || {
      color: styleType === "selected" ? "#ffd700" : "#3388ff",
      weight: 3,
      opacity: 0.8,
    };

    // Update feature state for styling
    editMap.setFeatureState(
      { source: tripsSourceId, id: feature.id },
      { selected: styleType === "selected" },
    );

    // Update layer paint properties
    editMap.setPaintProperty(tripsLayerId, "line-color", [
      "case",
      ["boolean", ["feature-state", "selected"], false],
      style.color,
      window.MapStyles?.getTripStyle?.("default")?.color || "#3388ff",
    ]);
    editMap.setPaintProperty(tripsLayerId, "line-width", [
      "case",
      ["boolean", ["feature-state", "selected"], false],
      style.weight || 4,
      3,
    ]);
  }

  function toggleEditMode(e) {
    editMode = e.target.checked;

    const saveChangesBtn = document.getElementById("saveChanges");
    if (saveChangesBtn) {
      saveChangesBtn.disabled = !editMode;
    }

    if (!editMode) {
      clearMarkers();
    } else if (currentTrip) {
      createEditableMarkers(currentTrip.geometry.coordinates);
    }
  }

  function createEditableMarkers(coordinates) {
    if (!editMap) return;

    clearMarkers();

    const markerFeatures = coordinates.map(([lng, lat], index) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [lng, lat],
      },
      properties: {
        index,
      },
    }));

    const markersSource = editMap.getSource(markersSourceId);
    if (markersSource) {
      markersSource.setData({
        type: "FeatureCollection",
        features: markerFeatures,
      });
    }

    // Make markers draggable using MapboxDraw
    if (draw && editMode) {
      draw.deleteAll();
      markerFeatures.forEach((feature) => {
        draw.add(feature);
      });
      // Use direct_select mode to allow dragging individual points
      if (markerFeatures.length > 0) {
        draw.changeMode("direct_select", markerFeatures[0].id);
      }
    }
  }

  function clearMarkers() {
    const markersSource = editMap?.getSource(markersSourceId);
    if (markersSource) {
      markersSource.setData({ type: "FeatureCollection", features: [] });
    }
    if (draw) {
      draw.deleteAll();
    }
  }

  function findClosestPointIndex(latLng, coordinates) {
    let closestIndex = 0;
    let minDistance = Infinity;

    for (let i = 0; i < coordinates.length; i++) {
      const [lng, lat] = coordinates[i];
      const distance = getDistance(latLng, { lat, lng });

      if (distance < minDistance) {
        minDistance = distance;
        closestIndex = i;
      }
    }

    return closestIndex;
  }

  function getDistance(point1, point2) {
    const R = 6371e3; // Earth radius in meters
    const φ1 = (point1.lat * Math.PI) / 180;
    const φ2 = (point2.lat * Math.PI) / 180;
    const Δφ = ((point2.lat - point1.lat) * Math.PI) / 180;
    const Δλ = ((point2.lng - point1.lng) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  function addPointToTrip(latLng) {
    if (!currentTrip) return;

    const coords = currentTrip.geometry.coordinates;
    const index = findClosestPointIndex(latLng, coords);

    coords.splice(index + 1, 0, [latLng.lng, latLng.lat]);

    updateTripPolyline();
    createEditableMarkers(coords);
  }

  function updatePointInTrip(index, latLng) {
    if (!currentTrip) return;

    currentTrip.geometry.coordinates[index] = [latLng.lng, latLng.lat];

    updateTripPolyline();
    createEditableMarkers(currentTrip.geometry.coordinates);
  }

  function updateTripPolyline() {
    if (!currentTrip || !editMap) return;

    // Update the source data
    const source = editMap.getSource(tripsSourceId);
    if (source) {
      const features = tripFeatures.map((f) =>
        f.id === currentTrip.id ? currentTrip : f,
      );
      source.setData({
        type: "FeatureCollection",
        features,
      });
    }
  }

  async function saveTripChanges() {
    if (!currentTrip) {
      window.notificationManager?.show("No trip selected to save.", "warning");
      return;
    }

    try {
      const tripId =
        currentTrip.properties?.transactionId || currentTrip.transactionId;

      if (!tripId) {
        console.error("Error: transactionId is undefined.", currentTrip);
        window.notificationManager?.show(
          "Error: Could not find the trip ID to save changes.",
          "danger",
        );
        return;
      }

      const tripTypeSelect = document.getElementById("tripType");
      const isMatchedTrip = tripTypeSelect?.value === "matched_trips";
      const baseUrl = isMatchedTrip ? "/api/matched_trips" : "/api/trips";
      const url = `${baseUrl}/${tripId}`;

      const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          geometry: currentTrip.geometry,
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
