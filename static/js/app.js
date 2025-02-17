/* global L, flatpickr, notificationManager, LiveTripTracker, loadingManager */
(() => {
  "use strict";

  // Map layer configuration
  const mapLayers = {
    trips: {
      order: 1,
      color: "#BB86FC",
      opacity: 0.4,
      visible: true,
      layer: null,
      highlightColor: "#FFD700",
    },
    historicalTrips: {
      order: 2,
      color: "#03DAC6",
      opacity: 0.4,
      visible: false,
      layer: null,
      highlightColor: "#FFD700",
    },
    matchedTrips: {
      order: 3,
      color: "#CF6679",
      opacity: 0.4,
      visible: false,
      layer: null,
      highlightColor: "#40E0D0",
    },
    osmBoundary: {
      order: 4,
      color: "#03DAC6",
      opacity: 0.7,
      visible: false,
      layer: null,
    },
    osmStreets: {
      order: 5,
      color: "#FF0266",
      opacity: 0.7,
      visible: false,
      layer: null,
    },
    streetCoverage: {
      order: 6,
      color: "#00FF00",
      opacity: 0.7,
      name: "Street Coverage",
      visible: false,
      layer: null,
    },
    customPlaces: {
      order: 7,
      color: "#FF9800",
      opacity: 0.5,
      visible: false,
      layer: null,
    },
  };

  const mapSettings = { highlightRecentTrips: true };
  let map,
    layerGroup,
    liveTracker,
    mapInitialized = false,
    selectedTripId = null;

  /**
   * Returns the style object for a given trip feature based on the current selectedTripId.
   * This function is used both during initial map rendering and to update styles when a trip is clicked.
   * @param {Object} feature - The GeoJSON feature.
   * @param {Object} info - The mapLayers info object for this layer.
   * @returns {Object} - The style object.
   */
  function getTripFeatureStyle(feature, info) {
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
    const startTime = new Date(feature.properties.startTime).getTime();
    const highlight = mapSettings.highlightRecentTrips && startTime > sixHoursAgo;
    const isSelected = feature.properties.transactionId === selectedTripId;
    const isMatchedPair =
      feature.properties.transactionId === selectedTripId ||
      (selectedTripId &&
        feature.properties.transactionId &&
        (selectedTripId.replace("MATCHED-", "") === feature.properties.transactionId ||
          feature.properties.transactionId.replace("MATCHED-", "") === selectedTripId));
    return {
      color: isSelected
        ? info.highlightColor
        : isMatchedPair
        ? (info === mapLayers.matchedTrips
            ? mapLayers.matchedTrips.highlightColor
            : mapLayers.trips.highlightColor)
        : highlight
        ? "#FF5722"
        : info.color,
      weight: isSelected || isMatchedPair ? 5 : highlight ? 4 : 2,
      opacity: isSelected || isMatchedPair ? 0.9 : highlight ? 0.8 : info.opacity,
      className: highlight ? "recent-trip" : "",
      zIndexOffset: isSelected || isMatchedPair ? 1000 : 0,
    };
  }

  /**
   * Initialize the map if the #map element is present.
   */
  async function initializeMap() {
    if (mapInitialized || !document.getElementById("map")) return;
    try {
      map = L.map("map", {
        center: [37.0902, -95.7129],
        zoom: 4,
        zoomControl: true,
        attributionControl: false,
        maxBounds: [
          [-90, -180],
          [90, 180],
        ],
      });
      window.map = map;
      L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        {
          maxZoom: 19,
          attribution: "",
        }
      ).addTo(map);
      layerGroup = L.layerGroup().addTo(map);
      mapLayers.customPlaces.layer = L.layerGroup();

      if (!window.liveTracker) {
        try {
          window.liveTracker = new LiveTripTracker(map);
        } catch (error) {
          console.error("Error initializing live tracking:", error);
        }
      }

      try {
        const response = await fetch("/api/last_trip_point");
        const data = await response.json();
        const lastPoint = data.lastPoint;
        if (lastPoint) {
          map.flyTo([lastPoint[1], lastPoint[0]], 11, {
            duration: 2,
            easeLinearity: 0.25,
          });
        } else {
          map.setView([31.55002, -97.123354], 14);
        }
      } catch (error) {
        console.error("Error fetching last point:", error);
        map.setView([37.0902, -95.7129], 4);
      } finally {
        mapInitialized = true;
      }
    } catch (error) {
      console.error("Error initializing map:", error);
    }
  }

  /**
   * Set default dates in localStorage if not already set.
   */
  function setInitialDates() {
    const today = new Date().toISOString().split("T")[0];
    if (!localStorage.getItem("startDate"))
      localStorage.setItem("startDate", today);
    if (!localStorage.getItem("endDate"))
      localStorage.setItem("endDate", today);
  }

  /**
   * Initialize flatpickr on date inputs.
   */
  function initializeDatePickers() {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const config = {
      dateFormat: "Y-m-d",
      maxDate: tomorrow,
      enableTime: false,
      static: false,
      appendTo: document.body,
      theme: "dark",
      position: "auto",
      disableMobile: true,
      onChange: function (selectedDates, dateStr) {
        const input = this.input;
        if (input) {
          localStorage.setItem(
            input.id === "start-date" ? "startDate" : "endDate",
            dateStr
          );
        }
      },
    };

    const dateInputs = ["start-date", "end-date"];
    dateInputs.forEach((id) => {
      const element = document.getElementById(id);
      if (element) {
        flatpickr(element, config);
      }
    });
  }

  /**
   * Build URL search parameters from date pickers.
   */
  function getFilterParams() {
    const startDate = document.getElementById("start-date")?.value,
      endDate = document.getElementById("end-date")?.value;
    return new URLSearchParams({ start_date: startDate, end_date: endDate });
  }

  /**
   * Fetch and display trips.
   */
  async function fetchTrips() {
    loadingManager.startOperation("Fetching and Displaying Trips", 100);
    loadingManager.addSubOperation("Fetching and Displaying Trips", "Fetching Data", 50);
    loadingManager.addSubOperation("Fetching and Displaying Trips", "Processing Data", 30);
    loadingManager.addSubOperation("Fetching and Displaying Trips", "Displaying Data", 20);
    try {
      const startDate = localStorage.getItem("startDate"),
        endDate = localStorage.getItem("endDate");
      if (!startDate || !endDate) {
        console.warn("No dates selected for fetching trips.");
        loadingManager.finish("Fetching and Displaying Trips");
        return;
      }
      document.getElementById("start-date").value = startDate;
      document.getElementById("end-date").value = endDate;
      loadingManager.updateSubOperation("Fetching and Displaying Trips", "Fetching Data", 25);
      const params = getFilterParams();
      const response = await fetch(`/api/trips?${params.toString()}`);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const geojson = await response.json();
      loadingManager.updateSubOperation("Fetching and Displaying Trips", "Fetching Data", 50);
      loadingManager.updateSubOperation("Fetching and Displaying Trips", "Processing Data", 15);

      if (window.tripsTable) {
        const formattedTrips = geojson.features
          .filter((trip) => trip.properties.imei !== "HISTORICAL")
          .map((trip) => ({
            ...trip.properties,
            gps: trip.geometry,
            destination: trip.properties.destination || "N/A",
            startLocation: trip.properties.startLocation || "N/A",
            distance: Number(trip.properties.distance).toFixed(2),
          }));
        await new Promise((resolve) => {
          window.tripsTable.clear().rows.add(formattedTrips).draw();
          setTimeout(resolve, 100);
        });
      }

      if (document.getElementById("map") && map && layerGroup) {
        mapLayers.trips.layer = {
          type: "FeatureCollection",
          features: geojson.features.filter(
            (f) => f.properties.imei !== "HISTORICAL"
          ),
        };
        mapLayers.historicalTrips.layer = {
          type: "FeatureCollection",
          features: geojson.features.filter(
            (f) => f.properties.imei === "HISTORICAL"
          ),
        };
        await updateMap();
      }
      loadingManager.updateSubOperation("Fetching and Displaying Trips", "Processing Data", 30);
      loadingManager.updateSubOperation("Fetching and Displaying Trips", "Displaying Data", 10);
      try {
        await fetchMatchedTrips();
      } catch (err) {
        console.error("Error fetching matched trips:", err);
      } finally {
        loadingManager.updateSubOperation("Fetching and Displaying Trips", "Displaying Data", 20);
      }
    } catch (error) {
      console.error("Error fetching trips:", error);
      notificationManager.show("Error fetching trips. Check console for details.", "danger");
    } finally {
      loadingManager.finish("Fetching and Displaying Trips");
    }
  }

  /**
   * Fetch matched trips.
   */
  async function fetchMatchedTrips() {
    const params = getFilterParams();
    const url = `/api/matched_trips?${params.toString()}`;
    try {
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(`HTTP error fetching matched trips: ${response.status}`);
      const geojson = await response.json();
      mapLayers.matchedTrips.layer = geojson;
    } catch (error) {
      console.error("Error fetching matched trips:", error);
    }
  }

  /**
   * Update the map layers without clearing the popup.
   * Uses the extracted style function for trips.
   */
  async function updateMap(fitBounds = false) {
    if (!layerGroup) return;
    layerGroup.clearLayers();
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
    const visibleLayers = Object.entries(mapLayers)
      .filter(([, info]) => info.visible && info.layer)
      .sort(([, a], [, b]) => a.order - b.order);

    // We'll collect the trip layers so we can update their style on click later.
    const tripLayers = new Map();

    await Promise.all(
      visibleLayers.map(async ([name, info], i) => {
        // For coverage and custom places, simply add the layer group.
        if (name === "streetCoverage" || name === "customPlaces") {
          info.layer.addTo(layerGroup);
        } else if (["trips", "historicalTrips", "matchedTrips"].includes(name)) {
          const geoJsonLayer = L.geoJSON(info.layer, {
            style: (feature) => {
              return getTripFeatureStyle(feature, info);
            },
            onEachFeature: (feature, lyr) => {
              tripLayers.set(feature.properties.transactionId, lyr);
              lyr.on("click", () => {
                const clickedId = feature.properties.transactionId;
                const wasSelected = selectedTripId === clickedId;
                selectedTripId = wasSelected ? null : clickedId;

                // Close any open popups
                layerGroup.eachLayer((layer) => {
                  if (layer.closePopup) layer.closePopup();
                });

                // If not already selected and it's from the trips layer, open popup.
                if (!wasSelected && name === "trips") {
                  const timezone = feature.properties.timezone || "America/Chicago";
                  const startTime = new Date(feature.properties.startTime);
                  const endTime = new Date(feature.properties.endTime);
                  const formatter = new Intl.DateTimeFormat("en-US", {
                    dateStyle: "short",
                    timeStyle: "short",
                    timeZone: timezone,
                    hour12: true,
                  });
                  const popupContent = `
                    <div class="trip-popup">
                      <h4>Trip Details</h4>
                      <p><strong>Start:</strong> ${formatter.format(startTime)}</p>
                      <p><strong>End:</strong> ${formatter.format(endTime)}</p>
                      <p><strong>Distance:</strong> ${Number(feature.properties.distance).toFixed(2)} miles</p>
                      <p><strong>From:</strong> ${feature.properties.startLocation || "Unknown"}</p>
                      <p><strong>To:</strong> ${feature.properties.destination || "Unknown"}</p>
                      ${
                        feature.properties.maxSpeed
                          ? `<p><strong>Max Speed:</strong> ${Number(feature.properties.maxSpeed).toFixed(1)} mph</p>`
                          : ""
                      }
                      ${
                        feature.properties.averageSpeed
                          ? `<p><strong>Avg Speed:</strong> ${Number(feature.properties.averageSpeed).toFixed(1)} mph</p>`
                          : ""
                      }
                      ${
                        feature.properties.totalIdleDurationFormatted
                          ? `<p><strong>Idle Time:</strong> ${feature.properties.totalIdleDurationFormatted}</p>`
                          : ""
                      }
                      <div class="mt-2">
                        <button class="btn btn-danger btn-sm me-2 delete-trip" data-trip-id="${feature.properties.transactionId}">Delete Trip</button>
                        <button class="btn btn-danger btn-sm delete-matched-trip" data-trip-id="${feature.properties.transactionId}">Delete Matched Trip</button>
                      </div>
                    </div>
                  `;
                  lyr.bindPopup(popupContent, {
                    className: "trip-popup",
                    maxWidth: 300,
                    autoPan: true,
                  }).openPopup();
                }
                // After click, update styles for all trip layers to reflect the new selection.
                layerGroup.eachLayer((layer) => {
                  if (layer.feature && layer.feature.properties && layer.setStyle) {
                    // Choose appropriate info based on imei value:
                    const infoObj = layer.feature.properties.imei !== "HISTORICAL" ? mapLayers.trips : mapLayers.historicalTrips;
                    layer.setStyle(getTripFeatureStyle(layer.feature, infoObj));
                  }
                });
              });

              // When a popup opens, attach delete button event listeners.
              lyr.on("popupopen", () => {
                const popupEl = lyr.getPopup().getElement();
                const deleteMatchedBtn = popupEl.querySelector(".delete-matched-trip");
                const deleteTripBtn = popupEl.querySelector(".delete-trip");

                deleteMatchedBtn?.addEventListener("click", async (e) => {
                  e.preventDefault();
                  const tid = e.target.dataset.tripId;
                  if (confirm("Delete this matched trip?")) {
                    try {
                      const res = await fetch(`/api/matched_trips/${tid}`, { method: "DELETE" });
                      if (!res.ok) throw new Error("Failed to delete");
                      lyr.closePopup();
                      await fetchTrips();
                      notificationManager.show("Trip deleted", "success");
                    } catch (error) {
                      console.error("Error deleting:", error);
                      notificationManager.show("Error deleting. Try again.", "danger");
                    }
                  }
                });

                deleteTripBtn?.addEventListener("click", async (e) => {
                  e.preventDefault();
                  const tid = e.target.dataset.tripId;
                  if (confirm("Delete this trip? This will also delete its corresponding matched trip.")) {
                    try {
                      const tripRes = await fetch(`/api/trips/${tid}`, { method: "DELETE" });
                      if (!tripRes.ok) throw new Error("Failed to delete trip");

                      const matchedRes = await fetch(`/api/matched_trips/${tid}`, { method: "DELETE" });
                      if (!matchedRes.ok) {
                        console.warn("No matched trip found or failed to delete matched trip");
                      }
                      lyr.closePopup();
                      await fetchTrips();
                      notificationManager.show("Trip and its matched trip deleted", "success");
                    } catch (error) {
                      console.error("Error deleting:", error);
                      notificationManager.show("Error deleting. Try again.", "danger");
                    }
                  }
                });
              });
            },
          });
          geoJsonLayer.addTo(layerGroup);
        } else if (["osmBoundary", "osmStreets"].includes(name)) {
          info.layer.setStyle({ color: info.color, opacity: info.opacity }).addTo(layerGroup);
        }
      })
    );

    // Bring the selected trip to the front
    if (selectedTripId && tripLayers.has(selectedTripId)) {
      const selectedLayer = tripLayers.get(selectedTripId);
      selectedLayer?.bringToFront();
    }

    // Optionally fit map to all visible layers
    if (fitBounds) {
      const bounds = L.latLngBounds();
      let validBounds = false;
      for (const [lname, linfo] of Object.entries(mapLayers)) {
        if (linfo.visible && linfo.layer) {
          try {
            const b = typeof linfo.layer.getBounds === "function"
              ? linfo.layer.getBounds()
              : L.geoJSON(linfo.layer).getBounds();
            if (b?.isValid()) {
              bounds.extend(b);
              validBounds = true;
            }
          } catch (e) {
            // ignore
          }
        }
      }
      if (validBounds) map.fitBounds(bounds);
    }
  }

  /**
   * Build dynamic layer controls.
   */
  function initializeLayerControls() {
    const toggles = document.getElementById("layer-toggles");
    if (!toggles) {
      console.warn("No 'layer-toggles' element found.");
      return;
    }
    toggles.innerHTML = "";
    Object.entries(mapLayers).forEach(([name, info]) => {
      const showControls = !["streetCoverage", "customPlaces"].includes(name);
      const colorPicker = showControls
        ? `<input type="color" id="${name}-color" value="${info.color}">`
        : "";
      const opacitySlider = showControls
        ? `<label for="${name}-opacity">Opacity:</label>
           <input type="range" id="${name}-opacity" min="0" max="1" step="0.1" value="${info.opacity}">`
        : "";
      const div = document.createElement("div");
      div.className = "layer-control";
      div.dataset.layerName = name;
      div.innerHTML = `
        <label class="custom-checkbox">
          <input type="checkbox" id="${name}-toggle" ${info.visible ? "checked" : ""}>
          <span class="checkmark"></span>
        </label>
        <label for="${name}-toggle">${info.name || name}</label>
        ${colorPicker}
        ${opacitySlider}
      `;
      toggles.appendChild(div);
      document.getElementById(`${name}-toggle`)?.addEventListener("change", (e) =>
        toggleLayer(name, e.target.checked)
      );
      if (showControls) {
        document.getElementById(`${name}-color`)?.addEventListener("change", (e) =>
          changeLayerColor(name, e.target.value)
        );
        document.getElementById(`${name}-opacity`)?.addEventListener("input", (e) =>
          changeLayerOpacity(name, parseFloat(e.target.value))
        );
      }
    });
    updateLayerOrderUI();
  }

  function toggleLayer(name, visible) {
    if (mapLayers[name]) {
      mapLayers[name].visible = visible;
      if (name === "customPlaces" && window.customPlaces) {
        window.customPlaces.toggleVisibility(visible);
      } else {
        updateMap();
      }
      updateLayerOrderUI();
    } else {
      console.warn(`Layer "${name}" not found.`);
    }
  }

  function changeLayerColor(name, color) {
    if (mapLayers[name]) {
      mapLayers[name].color = color;
      updateMap();
    }
  }

  function changeLayerOpacity(name, opacity) {
    if (mapLayers[name]) {
      mapLayers[name].opacity = opacity;
      updateMap();
    }
  }

  /**
   * Manage layer order via drag & drop.
   */
  function updateLayerOrderUI() {
    const orderDiv = document.getElementById("layer-order");
    if (!orderDiv) {
      console.warn("layer-order element not found.");
      return;
    }
    orderDiv.innerHTML = '<h4 class="h6">Layer Order</h4>';
    const ordered = Object.entries(mapLayers)
      .filter(([, v]) => v.visible)
      .sort(([, a], [, b]) => b.order - a.order);
    const ul = document.createElement("ul");
    ul.id = "layer-order-list";
    ul.className = "list-group bg-dark";
    ordered.forEach(([lname]) => {
      const li = document.createElement("li");
      li.textContent = lname;
      li.draggable = true;
      li.dataset.layer = lname;
      li.className = "list-group-item bg-dark text-white";
      ul.appendChild(li);
    });
    orderDiv.appendChild(ul);
    initializeDragAndDrop();
  }

  function initializeDragAndDrop() {
    const list = document.getElementById("layer-order-list");
    if (!list) return;
    let dragged = null;
    list.addEventListener("dragstart", (e) => {
      dragged = e.target;
      e.dataTransfer.effectAllowed = "move";
    });
    list.addEventListener("dragover", (e) => {
      e.preventDefault();
      const target = e.target.closest("li");
      if (target && target !== dragged) {
        const rect = target.getBoundingClientRect();
        const next = (e.clientY - rect.top) / (rect.bottom - rect.top) > 0.5;
        list.insertBefore(dragged, next ? target.nextSibling : target);
      }
    });
    list.addEventListener("dragend", updateLayerOrder);
  }

  function updateLayerOrder() {
    const list = document.getElementById("layer-order-list");
    if (!list) return;
    const items = Array.from(list.querySelectorAll("li"));
    const total = items.length;
    items.forEach((item, i) => {
      const lname = item.dataset.layer;
      if (mapLayers[lname]) {
        mapLayers[lname].order = total - i;
      }
    });
    updateMap();
  }

  /**
   * Validate location input.
   */
  async function validateLocation() {
    const locInput = document.getElementById("location-input");
    const locType = document.getElementById("location-type");
    if (!locInput || !locType || !locInput.value || !locType.value) {
      notificationManager.show("Please enter a location and select a location type.", "warning");
      return;
    }
    try {
      const res = await fetch("/api/validate_location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: locInput.value,
          locationType: locType.value,
        }),
      });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const data = await res.json();
      if (!data) {
        notificationManager.show("Location not found. Please check your input.", "warning");
        return;
      }
      handleLocationValidationSuccess(data, locInput);
      notificationManager.show("Location validated successfully!", "success");
    } catch (err) {
      console.error("Error validating location:", err);
      notificationManager.show("Error validating location. Please try again.", "danger");
    }
  }

  function handleLocationValidationSuccess(data, locInput) {
    window.validatedLocation = data;
    locInput.setAttribute("data-location", JSON.stringify(data));
    locInput.setAttribute("data-display-name", data.display_name || data.name || locInput.value);
    ["generate-boundary", "generate-streets", "generate-coverage", "preprocess-streets"].forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = false;
    });
    document.dispatchEvent(new Event("locationValidated"));
  }

  /**
   * Generate OSM data.
   */
  async function generateOSMData(streetsOnly) {
    if (!window.validatedLocation) {
      notificationManager.show("Please validate a location first.", "warning");
      return;
    }
    try {
      const res = await fetch("/api/generate_geojson", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: window.validatedLocation,
          streetsOnly,
        }),
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Unknown error generating OSM data");
      }
      const geojson = await res.json();
      if (!geojson || geojson.type !== "FeatureCollection") {
        throw new Error("Invalid GeoJSON data from Overpass");
      }
      const layer = L.geoJSON(geojson, {
        style: {
          color: streetsOnly ? mapLayers.osmStreets.color : mapLayers.osmBoundary.color,
          weight: 2,
          opacity: 0.7,
        },
      });
      if (streetsOnly) {
        mapLayers.osmStreets.layer = layer;
      } else {
        mapLayers.osmBoundary.layer = layer;
      }
      updateMap();
      updateLayerOrderUI();
      notificationManager.show("OSM data generated successfully!", "success");
    } catch (err) {
      console.error("Error generating OSM data:", err);
      notificationManager.show(err.message, "danger");
    }
  }

  /**
   * Map match trips (standard or historical).
   */
  async function mapMatchTrips(isHistorical = false) {
    const sd = document.getElementById("start-date")?.value;
    const ed = document.getElementById("end-date")?.value;
    if (!sd || !ed) {
      notificationManager.show("Select start and end dates.", "warning");
      return;
    }
    loadingManager.startOperation("MapMatching", 100);
    const tasks = [
      fetch("/api/map_match_trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: sd, end_date: ed }),
      }),
    ];
    if (isHistorical) {
      tasks.push(
        fetch("/api/map_match_historical_trips", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ start_date: sd, end_date: ed }),
        })
      );
    }
    try {
      const responses = await Promise.all(tasks);
      for (const response of responses) {
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
        }
      }
      const results = await Promise.all(responses.map((r) => r.json()));
      console.log("Map matching responses:", results);
      notificationManager.show("Map matching completed for selected trips.", "success");
      fetchTrips();
    } catch (err) {
      console.error("Error map matching trips:", err);
      notificationManager.show("Error map matching trips. Check console.", "danger");
    } finally {
      loadingManager.finish("MapMatching");
    }
  }

  /**
   * Fetch trips in a given date range.
   */
  async function fetchTripsInRange() {
    const sd = document.getElementById("start-date")?.value;
    const ed = document.getElementById("end-date")?.value;
    if (!sd || !ed) {
      notificationManager.show("Select start and end dates.", "warning");
      return;
    }
    loadingManager.startOperation("FetchTripsRange", 100);
    try {
      const r = await fetch("/api/fetch_trips_range", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: sd, end_date: ed }),
      });
      if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
      const data = await r.json();
      if (data.status === "success") {
        notificationManager.show(data.message, "success");
        fetchTrips();
      } else {
        console.error(`Error: ${data.message}`);
        notificationManager.show("Error fetching trips. Check console.", "danger");
      }
    } catch (err) {
      console.error("Error fetching trips in range:", err);
      notificationManager.show("Error fetching trips. Check console.", "danger");
    } finally {
      loadingManager.finish("FetchTripsRange");
    }
  }

  /**
   * Fetch top-level metrics.
   */
  async function fetchMetrics() {
    const sd = document.getElementById("start-date")?.value;
    const ed = document.getElementById("end-date")?.value;
    const imei = document.getElementById("imei")?.value || "";
    if (!sd || !ed) return;
    try {
      const r = await fetch(`/api/metrics?start_date=${sd}&end_date=${ed}&imei=${imei}`);
      const metrics = await r.json();
      const mapping = {
        "total-trips": metrics.total_trips,
        "total-distance": metrics.total_distance,
        "avg-distance": metrics.avg_distance,
        "avg-start-time": metrics.avg_start_time,
        "avg-driving-time": metrics.avg_driving_time,
        "avg-speed": `${metrics.avg_speed} mph`,
        "max-speed": `${metrics.max_speed} mph`,
      };
      Object.keys(mapping).forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = mapping[id];
      });
    } catch (err) {
      console.error("Error fetching metrics:", err);
    }
  }

  /**
   * Preprocess streets for coverage.
   */
  async function preprocessStreets() {
    const location = document.getElementById("location-input")?.value;
    const locationType = document.getElementById("location-type")?.value;
    if (!location) {
      notificationManager.show("Please enter and validate a location first.", "warning");
      return;
    }
    try {
      const response = await fetch("/api/preprocess_streets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location, location_type: locationType }),
      });
      const data = await response.json();
      if (data.status === "success") {
        notificationManager.show(data.message, "success");
      } else {
        notificationManager.show(`Error: ${data.message}`, "danger");
      }
    } catch (error) {
      console.error("Error preprocessing streets:", error);
      notificationManager.show("Error preprocessing streets. Please check the console for details.", "danger");
    }
  }

  /**
   * Attach various event listeners.
   */
  function initializeEventListeners() {
    const applyFiltersBtn = document.getElementById("apply-filters");
    if (applyFiltersBtn && !applyFiltersBtn.hasListener) {
      applyFiltersBtn.hasListener = true;
      applyFiltersBtn.addEventListener("click", () => {
        const sd = document.getElementById("start-date").value;
        const ed = document.getElementById("end-date").value;
        localStorage.setItem("startDate", sd);
        localStorage.setItem("endDate", ed);
        fetchTrips();
        fetchMetrics();
      });
    }
    const controlsToggle = document.getElementById("controls-toggle");
    if (controlsToggle) {
      controlsToggle.addEventListener("click", function () {
        const mapControls = document.getElementById("map-controls");
        const controlsContent = document.getElementById("controls-content");
        mapControls?.classList.toggle("minimized");
        const icon = this.querySelector("i");
        icon?.classList.toggle("fa-chevron-up");
        icon?.classList.toggle("fa-chevron-down");
        controlsContent.style.display = mapControls?.classList.contains("minimized") ? "none" : "block";
      });
    }
    document.getElementById("validate-location")?.addEventListener("click", validateLocation);
    document.getElementById("generate-boundary")?.addEventListener("click", () => generateOSMData(false));
    document.getElementById("generate-streets")?.addEventListener("click", () => generateOSMData(true));
    document.getElementById("map-match-trips")?.addEventListener("click", () => mapMatchTrips(false));
    document.getElementById("map-match-historical-trips")?.addEventListener("click", () => mapMatchTrips(true));
    document.getElementById("generate-coverage")?.addEventListener("click", generateStreetCoverage);
    document.querySelectorAll(".date-preset").forEach((btn) => btn.addEventListener("click", handleDatePresetClick));
    document.getElementById("fetch-trips-range")?.addEventListener("click", fetchTripsInRange);
    const highlightRecent = document.getElementById("highlight-recent-trips");
    if (highlightRecent) {
      highlightRecent.addEventListener("change", function () {
        mapSettings.highlightRecentTrips = this.checked;
        updateMap();
      });
    }
    document.getElementById("preprocess-streets")?.addEventListener("click", preprocessStreets);
  }

  /**
   * Handle date preset clicks.
   */
  async function handleDatePresetClick() {
    const range = this.dataset.range;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let startDate = new Date(today);
    let endDate = new Date(today);
    if (range === "all-time") {
      loadingManager.startOperation("AllTimeDatePreset", 100);
      try {
        const r = await fetch("/api/first_trip_date");
        const d = await r.json();
        updateDatePickersAndStore(new Date(d.first_trip_date), endDate);
      } catch (err) {
        console.error("Error fetching first trip date:", err);
        notificationManager.show("Error fetching first trip date. Please try again.", "danger");
      } finally {
        loadingManager.finish("AllTimeDatePreset");
      }
      return;
    }
    switch (range) {
      case "yesterday":
        startDate.setDate(startDate.getDate() - 1);
        break;
      case "last-week":
        startDate.setDate(startDate.getDate() - 7);
        break;
      case "last-month":
        startDate.setDate(startDate.getDate() - 30);
        break;
      case "last-6-months":
        startDate.setMonth(startDate.getMonth() - 6);
        break;
      case "last-year":
        startDate.setFullYear(startDate.getFullYear() - 1);
        break;
      default:
        break;
    }
    updateDatePickersAndStore(startDate, endDate);
  }

  function updateDatePickersAndStore(startDate, endDate) {
    const startFP = document.getElementById("start-date")?._flatpickr;
    const endFP = document.getElementById("end-date")?._flatpickr;
    if (startFP && endFP) {
      startFP.setDate(startDate);
      endFP.setDate(endDate);
    }
    localStorage.setItem("startDate", startDate.toISOString().split("T")[0]);
    localStorage.setItem("endDate", endDate.toISOString().split("T")[0]);
  }

  /**
   * Generate street coverage.
   */
  async function generateStreetCoverage() {
    if (!window.validatedLocation) {
      notificationManager.show("Validate a location first.", "warning");
      return;
    }
    const coverageBtn = document.getElementById("generate-coverage");
    const originalText = coverageBtn.innerHTML;
    const progressBar = document.getElementById("coverage-progress");
    const progressText = document.getElementById("coverage-progress-text");
    try {
      coverageBtn.disabled = true;
      coverageBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Starting...';
      document.getElementById("coverage-stats").classList.remove("d-none");
      progressBar.style.width = "0%";
      progressBar.setAttribute("aria-valuenow", "0");
      progressText.textContent = "Starting coverage calculation...";
      const response = await fetch("/api/street_coverage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location: window.validatedLocation }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to start coverage calculation");
      }
      const data = await response.json();
      if (!data || !data.task_id) {
        throw new Error("Invalid response from server: missing task ID");
      }
      const task_id = data.task_id;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const maxRetries = 3;
      let retryCount = 0;
      while (true) {
        try {
          const statusResponse = await fetch(`/api/street_coverage/${task_id}`);
          if (statusResponse.status === 404) {
            retryCount++;
            if (retryCount > maxRetries) {
              throw new Error("Task not found after multiple retries");
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
            continue;
          }
          retryCount = 0;
          if (statusResponse.status === 500) {
            const errorData = await statusResponse.json();
            throw new Error(errorData.detail || "Error in coverage calculation");
          }
          if (!statusResponse.ok) {
            throw new Error(`Server returned ${statusResponse.status}: ${statusResponse.statusText}`);
          }
          const statusData = await statusResponse.json();
          if (!statusData) {
            console.warn("Received empty status data");
            await new Promise((resolve) => setTimeout(resolve, 1000));
            continue;
          }
          if (statusData.streets_data) {
            visualizeStreetCoverage(statusData);
            break;
          }
          if (!statusData.stage) {
            console.warn("Invalid progress data received:", statusData);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            continue;
          }
          if (statusData.stage === "complete" && statusData.result) {
            visualizeStreetCoverage(statusData.result);
            break;
          } else if (statusData.stage === "error") {
            throw new Error(statusData.message || "Error in coverage calculation");
          }
          const progress = statusData.progress || 0;
          progressBar.style.width = `${progress}%`;
          progressBar.setAttribute("aria-valuenow", progress);
          progressText.textContent = statusData.message || `Progress: ${progress}%`;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (error) {
          if (error.message === "Task not found after multiple retries") {
            throw error;
          }
          console.warn("Error polling progress:", error);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    } catch (error) {
      console.error("Error generating street coverage:", error);
      notificationManager.show(error.message || "An error occurred while generating street coverage.", "danger");
      progressBar.style.width = "0%";
      progressBar.setAttribute("aria-valuenow", "0");
      progressText.textContent = "Error calculating coverage";
    } finally {
      coverageBtn.disabled = false;
      coverageBtn.innerHTML = originalText;
    }
  }

  /**
   * Display street coverage data on the map.
   */
  function visualizeStreetCoverage(coverageData) {
    if (mapLayers.streetCoverage.layer) {
      layerGroup.removeLayer(mapLayers.streetCoverage.layer);
      mapLayers.streetCoverage.layer = null;
    }
    if (!coverageData || !coverageData.streets_data) {
      console.error("Invalid coverage data received");
      return;
    }
    mapLayers.streetCoverage.layer = L.geoJSON(coverageData.streets_data, {
      style: (feature) => {
        const driven = feature.properties.driven;
        const count = feature.properties.coverage_count || 0;
        let color = "#FF4444";
        let opacity = 0.4;
        let weight = 3;
        if (driven) {
          if (count >= 10) color = "#004400";
          else if (count >= 5) color = "#006600";
          else if (count >= 3) color = "#008800";
          else color = "#00AA00";
          opacity = 0.8;
          weight = 4;
        }
        return { color, weight, opacity };
      },
      onEachFeature: (feature, layer) => {
        const props = feature.properties;
        const lengthMiles = (props.length * 0.000621371).toFixed(2);
        const popupContent = `
          <strong>${props.street_name || "Unnamed Street"}</strong><br>
          Status: ${props.driven ? "Driven" : "Not driven"}<br>
          Times driven: ${props.coverage_count || 0}<br>
          Length: ${lengthMiles} miles<br>
          Segment ID: ${props.segment_id}
        `;
        layer.bindPopup(popupContent);
        layer.on({
          mouseover: (e) => {
            e.target.setStyle({ weight: 5, opacity: 1 });
          },
          mouseout: (e) => {
            mapLayers.streetCoverage.layer.resetStyle(e.target);
          },
        });
      },
    });
    mapLayers.streetCoverage.layer.addTo(layerGroup);
    mapLayers.streetCoverage.visible = true;
    updateLayerOrderUI();
    updateMap();
    updateCoverageStats(coverageData);
  }

  /**
   * Update the coverage stats display.
   */
  function updateCoverageStats(coverageData) {
    const statsDiv = document.getElementById("coverage-stats");
    const progressBar = document.getElementById("coverage-progress");
    const coveragePercentageSpan = document.getElementById("coverage-percentage");
    const totalStreetLengthSpan = document.getElementById("total-street-length");
    const milesDrivenSpan = document.getElementById("miles-driven");
    if (!statsDiv || !progressBar || !coveragePercentageSpan || !totalStreetLengthSpan || !milesDrivenSpan) {
      console.error("One or more coverage stats elements not found!");
      return;
    }
    statsDiv.classList.remove("d-none");
    const metadata = coverageData.streets_data.metadata;
    const percent = metadata.coverage_percentage || 0;
    const totalMiles = metadata.total_length_miles || 0;
    const drivenMiles = metadata.driven_length_miles || 0;
    progressBar.style.width = `${percent}%`;
    progressBar.setAttribute("aria-valuenow", percent.toFixed(1));
    coveragePercentageSpan.textContent = percent.toFixed(1);
    totalStreetLengthSpan.textContent = totalMiles.toFixed(2);
    milesDrivenSpan.textContent = drivenMiles.toFixed(2);
  }

  /**
   * Show coverage for a given location (from coverage management navigation).
   */
  async function showCoverageForLocation(location) {
    try {
      const response = await fetch(`/api/street_coverage/${location.display_name}`);
      if (!response.ok) throw new Error("Failed to fetch coverage data");
      const data = await response.json();
      if (data?.streets_data) {
        visualizeStreetCoverage(data);
        mapLayers.streetCoverage.visible = true;
        updateLayerOrderUI();
        updateMap(true);
      }
    } catch (error) {
      console.error("Error showing coverage:", error);
      notificationManager.show("Error loading coverage data", "danger");
    }
  }

  /**
   * DOMContentLoaded: initialize date pickers, event listeners, and the map.
   */
  document.addEventListener("DOMContentLoaded", () => {
    setInitialDates();
    initializeDatePickers();
    initializeEventListeners();
    if (document.getElementById("map") && !document.getElementById("visits-page")) {
      initializeMap();
      if (!map || !layerGroup) {
        console.error("Failed to initialize map components");
        notificationManager.show("Failed to initialize map components. Please refresh the page.", "danger");
        return;
      }
      initializeLayerControls();
      fetchTrips().then(fetchMetrics);
      const selectedLocation = localStorage.getItem("selectedLocation");
      if (selectedLocation) {
        try {
          const location = JSON.parse(selectedLocation);
          window.validatedLocation = location;
          showCoverageForLocation(location).then(() => {
            localStorage.removeItem("selectedLocation");
          });
        } catch (error) {
          console.error("Error loading selected location:", error);
        }
      }
    } else {
      fetchMetrics();
    }
    ["generate-boundary", "generate-streets", "generate-coverage", "preprocess-streets"].forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = true;
    });
  });

  // Expose functions if needed globally
})();