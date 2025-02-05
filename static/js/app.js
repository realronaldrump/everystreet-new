/* global L, flatpickr */
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
    },
    historicalTrips: {
      order: 2,
      color: "#03DAC6",
      opacity: 0.4,
      visible: false,
      layer: null,
    },
    matchedTrips: {
      order: 3,
      color: "#CF6679",
      opacity: 0.4,
      visible: false,
      layer: null,
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

  // Global settings and variables
  const mapSettings = { highlightRecentTrips: true };
  let map,
    layerGroup,
    liveTracker,
    mapInitialized = false;

  // Loading overlay elements
  const loadingOverlay = document.querySelector(".loading-overlay"),
    loadingText = document.getElementById("loading-text"),
    loadingBar = document.getElementById("loading-bar");

  // LoadingManager class
  class LoadingManager {
    constructor() {
      this.operations = {};
      this.totalProgress = 0;
    }
    startOperation(name, total) {
      this.operations[name] = { total, progress: 0, subOperations: {} };
      this.updateOverallProgress();
      showLoadingOverlay(name);
    }
    addSubOperation(opName, subName, total) {
      if (this.operations[opName]) {
        this.operations[opName].subOperations[subName] = { total, progress: 0 };
      }
    }
    updateSubOperation(opName, subName, progress) {
      const op = this.operations[opName];
      if (op?.subOperations[subName]) {
        op.subOperations[subName].progress = progress;
        this.updateOperationProgress(opName);
      }
    }
    updateOperationProgress(opName) {
      const op = this.operations[opName];
      if (op) {
        const subProgress = Object.values(op.subOperations).reduce(
          (acc, sub) =>
            acc + (sub.progress / sub.total) * (sub.total / op.total),
          0,
        );
        op.progress = subProgress * op.total;
        this.updateOverallProgress();
      }
    }
    updateOverallProgress() {
      this.totalProgress = Object.values(this.operations).reduce(
        (acc, op) => acc + op.progress / 100,
        0,
      );
      const overallPercentage =
        (this.totalProgress / Object.keys(this.operations).length) * 100;
      updateLoadingProgress(overallPercentage);
    }
    finish(name) {
      if (name) delete this.operations[name];
      else this.operations = {};
      this.updateOverallProgress();
      if (!Object.keys(this.operations).length) hideLoadingOverlay();
    }
  }
  const loadingManager = new LoadingManager();

  // Basic overlay functions
  function showLoadingOverlay(message = "Loading trips") {
    if (loadingOverlay) {
      loadingOverlay.style.display = "flex";
      loadingText.textContent = `${message}: 0%`;
      loadingBar.style.width = "0%";
      loadingBar.setAttribute("aria-valuenow", "0");
    }
  }
  function updateLoadingProgress(percentage, message) {
    if (loadingText && loadingBar) {
      const currentMsg = message || loadingText.textContent.split(":")[0];
      loadingText.textContent = `${currentMsg}: ${Math.round(percentage)}%`;
      loadingBar.style.width = `${percentage}%`;
      loadingBar.setAttribute("aria-valuenow", percentage);
    }
  }
  function hideLoadingOverlay() {
    if (loadingOverlay)
      setTimeout(() => (loadingOverlay.style.display = "none"), 500);
  }

  // Map initialization (note: ensure this code runs only once)
  function initializeMap() {
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
        },
      ).addTo(map);
      layerGroup = L.layerGroup().addTo(map);
      mapLayers.customPlaces.layer = L.layerGroup();

      if (!window.liveTracker) {
        try {
          window.liveTracker = new LiveTripTracker(map);
          console.log("Live Tracker initialized");
        } catch (error) {
          console.error("Error initializing live tracking:", error);
        }
      }

      fetch("/api/last_trip_point")
        .then((response) => response.json())
        .then((data) => {
          const lastPoint = data.lastPoint;
          if (lastPoint)
            map.flyTo([lastPoint[1], lastPoint[0]], 11, {
              duration: 2,
              easeLinearity: 0.25,
            });
          else map.setView([31.55002, -97.123354], 14);
          mapInitialized = true;
        })
        .catch((error) => {
          console.error("Error fetching last point:", error);
          map.setView([37.0902, -95.7129], 4);
          mapInitialized = true;
        });
    } catch (error) {
      console.error("Error initializing map:", error);
    }
  }

  // Date pickers and initial dates
  function setInitialDates() {
    const today = new Date().toISOString().split("T")[0];
    if (!localStorage.getItem("startDate"))
      localStorage.setItem("startDate", today);
    if (!localStorage.getItem("endDate"))
      localStorage.setItem("endDate", today);
  }
  function initializeDatePickers() {
    const today = new Date(),
      tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const config = {
      dateFormat: "Y-m-d",
      maxDate: tomorrow,
      enableTime: false,
      static: true,
    };
    if (document.getElementById("start-date")) flatpickr("#start-date", config);
    if (document.getElementById("end-date")) flatpickr("#end-date", config);
  }

  function getFilterParams() {
    const startDate = document.getElementById("start-date")?.value,
      endDate = document.getElementById("end-date")?.value;
    return new URLSearchParams({ start_date: startDate, end_date: endDate });
  }

  // Fetch trips and update table/map
  async function fetchTrips() {
    loadingManager.startOperation("Fetching and Displaying Trips", 100);
    loadingManager.addSubOperation("fetch", "Fetching Data", 50);
    loadingManager.addSubOperation("fetch", "Processing Data", 30);
    loadingManager.addSubOperation("fetch", "Displaying Data", 20);
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
      loadingManager.updateSubOperation("fetch", "Fetching Data", 25);
      const params = getFilterParams(),
        response = await fetch(`/api/trips?${params.toString()}`);
      if (!response.ok)
        throw new Error(`HTTP error! status: ${response.status}`);
      const geojson = await response.json();
      loadingManager.updateSubOperation("fetch", "Fetching Data", 50);
      loadingManager.updateSubOperation("fetch", "Processing Data", 15);

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
            (f) => f.properties.imei !== "HISTORICAL",
          ),
        };
        mapLayers.historicalTrips.layer = {
          type: "FeatureCollection",
          features: geojson.features.filter(
            (f) => f.properties.imei === "HISTORICAL",
          ),
        };
        await updateMap();
      }
      loadingManager.updateSubOperation("fetch", "Processing Data", 30);
      loadingManager.updateSubOperation("fetch", "Displaying Data", 10);
      try {
        await fetchMatchedTrips();
      } catch (err) {
        console.error("Error fetching matched trips:", err);
      } finally {
        loadingManager.updateSubOperation("fetch", "Displaying Data", 20);
      }
    } catch (error) {
      console.error("Error fetching trips:", error);
      alert("Error fetching trips. Check console for details.");
    } finally {
      loadingManager.finish("Fetching and Displaying Trips");
    }
  }

  async function fetchMatchedTrips() {
    const params = getFilterParams(),
      url = `/api/matched_trips?${params.toString()}`;
    try {
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(
          `HTTP error fetching matched trips: ${response.status}`,
        );
      const geojson = await response.json();
      mapLayers.matchedTrips.layer = geojson;
    } catch (error) {
      console.error("Error fetching matched trips:", error);
    }
  }

  // Update map visualization
  async function updateMap(fitBounds = false) {
    if (!layerGroup) return;
    layerGroup.clearLayers();
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
    const visibleLayers = Object.entries(mapLayers)
      .filter(([, info]) => info.visible && info.layer)
      .sort(([, a], [, b]) => a.order - b.order);

    await Promise.all(
      visibleLayers.map(async ([name, info], i) => {
        updateLoadingProgress(
          (i / visibleLayers.length) * 100,
          "Updating map visualization",
        );
        if (name === "streetCoverage" || name === "customPlaces") {
          // For streetCoverage, the layer is already an L.geoJSON layer
          info.layer.addTo(layerGroup);
        } else if (
          ["trips", "historicalTrips", "matchedTrips"].includes(name)
        ) {
          const geoJsonLayer = L.geoJSON(info.layer, {
            style: (feature) => {
              const start = new Date(feature.properties.startTime).getTime();
              const highlight =
                mapSettings.highlightRecentTrips && start > sixHoursAgo;
              return {
                color: highlight ? "#FF5722" : info.color,
                weight: highlight ? 4 : 2,
                opacity: highlight ? 0.8 : info.opacity,
                className: highlight ? "recent-trip" : "",
              };
            },
            onEachFeature: (feature, lyr) => {
              const timezone = feature.properties.timezone || "America/Chicago",
                startTime = new Date(feature.properties.startTime),
                endTime = new Date(feature.properties.endTime),
                formatter = new Intl.DateTimeFormat("en-US", {
                  dateStyle: "short",
                  timeStyle: "short",
                  timeZone: timezone,
                  hour12: true,
                }),
                popupContent = `
                  <strong>Trip ID:</strong> ${feature.properties.transactionId}<br>
                  <strong>Start Time:</strong> ${formatter.format(startTime)}<br>
                  <strong>End Time:</strong> ${formatter.format(endTime)}<br>
                  <strong>Distance:</strong> ${Number(feature.properties.distance).toFixed(2)} miles<br>
                  ${
                    mapSettings.highlightRecentTrips &&
                    startTime.getTime() > sixHoursAgo
                      ? "<br><strong>(Recent Trip)</strong>"
                      : ""
                  }
                  <button class="btn btn-danger btn-sm mt-2 delete-matched-trip" data-trip-id="${
                    feature.properties.transactionId
                  }">
                    Delete Matched Trip
                  </button>`;
              lyr.bindPopup(popupContent).on("popupopen", () => {
                const deleteBtn = lyr
                  .getPopup()
                  .getElement()
                  .querySelector(".delete-matched-trip");
                deleteBtn?.addEventListener("click", async (e) => {
                  e.preventDefault();
                  const tid = e.target.dataset.tripId;
                  if (confirm("Delete this matched trip?")) {
                    try {
                      const res = await fetch(`/api/matched_trips/${tid}`, {
                        method: "DELETE",
                      });
                      if (!res.ok) throw new Error("Failed to delete");
                      lyr.closePopup();
                      fetchTrips();
                      alert("Trip deleted");
                    } catch (error) {
                      console.error("Error deleting:", error);
                      alert("Error deleting. Try again.");
                    }
                  }
                });
              });
            },
          });
          geoJsonLayer.addTo(layerGroup);
        } else if (["osmBoundary", "osmStreets"].includes(name)) {
          info.layer
            .setStyle({ color: info.color, opacity: info.opacity })
            .addTo(layerGroup);
        }
      }),
    );

    if (fitBounds) {
      const bounds = L.latLngBounds();
      let validBounds = false;
      for (const [lname, linfo] of Object.entries(mapLayers)) {
        if (linfo.visible && linfo.layer) {
          try {
            const b =
              typeof linfo.layer.getBounds === "function"
                ? linfo.layer.getBounds()
                : L.geoJSON(linfo.layer).getBounds();
            if (b?.isValid()) {
              bounds.extend(b);
              validBounds = true;
            }
          } catch (e) {
            /* ignore */
          }
        }
      }
      if (validBounds) map.fitBounds(bounds);
    }
    updateLoadingProgress(100, "Map update complete");
  }

  // Layer control and order UI
  function initializeLayerControls() {
    const toggles = document.getElementById("layer-toggles");
    if (!toggles) {
      console.warn("No 'layer-toggles' element found.");
      return;
    }
    toggles.innerHTML = "";
    Object.entries(mapLayers).forEach(([name, info]) => {
      const showControls = !["streetCoverage", "customPlaces"].includes(name),
        colorPicker = showControls
          ? `<input type="color" id="${name}-color" value="${info.color}">`
          : "",
        opacitySlider = showControls
          ? `<label for="${name}-opacity">Opacity:</label>
             <input type="range" id="${name}-opacity" min="0" max="1" step="0.1" value="${info.opacity}">`
          : "";
      const div = document.createElement("div");
      div.className = "layer-control";
      div.dataset.layerName = name;
      div.innerHTML = `
        <label class="custom-checkbox">
          <input type="checkbox" id="${name}-toggle" ${
        info.visible ? "checked" : ""
      }>
          <span class="checkmark"></span>
        </label>
        <label for="${name}-toggle">${info.name || name}</label>
        ${colorPicker}
        ${opacitySlider}`;
      toggles.appendChild(div);
      document
        .getElementById(`${name}-toggle`)
        ?.addEventListener("change", (e) =>
          toggleLayer(name, e.target.checked),
        );
      if (showControls) {
        document
          .getElementById(`${name}-color`)
          ?.addEventListener("change", (e) =>
            changeLayerColor(name, e.target.value),
          );
        document
          .getElementById(`${name}-opacity`)
          ?.addEventListener("input", (e) =>
            changeLayerOpacity(name, parseFloat(e.target.value)),
          );
      }
    });
    updateLayerOrderUI();
  }
  function toggleLayer(name, visible) {
    if (mapLayers[name]) {
      mapLayers[name].visible = visible;
      updateMap();
      updateLayerOrderUI();
    } else console.warn(`Layer "${name}" not found.`);
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
    let dragged;
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
      if (mapLayers[lname]) mapLayers[lname].order = total - i;
    });
    updateMap();
  }

  // Location validation and OSM data generation
  async function validateLocation() {
    const locInput = document.getElementById("location-input"),
      locType = document.getElementById("location-type");
    if (!locInput || !locType || !locInput.value || !locType.value) {
      alert("Please enter a location and select a location type.");
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
        alert("Location not found. Please check your input.");
        return;
      }
      handleLocationValidationSuccess(data, locInput);
      alert("Location validated successfully!");
    } catch (err) {
      console.error("Error validating location:", err);
      alert("Error validating location. Please try again.");
    }
  }
  function handleLocationValidationSuccess(data, locInput) {
    window.validatedLocation = data;
    locInput.setAttribute("data-location", JSON.stringify(data));
    locInput.setAttribute(
      "data-display-name",
      data.display_name || data.name || locInput.value,
    );
    ["generate-boundary", "generate-streets", "generate-coverage"].forEach(
      (id) => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = false;
      },
    );
    document.dispatchEvent(new Event("locationValidated"));
  }
  function generateOSMData(streetsOnly) {
    if (!window.validatedLocation) {
      alert("Please validate a location first.");
      return;
    }
    fetch("/api/generate_geojson", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location: window.validatedLocation, streetsOnly }),
    })
      .then((res) => {
        if (!res.ok)
          return res.json().then((errData) => {
            throw new Error(
              errData.error || "Unknown error generating OSM data",
            );
          });
        return res.json();
      })
      .then((geojson) => {
        if (!geojson || geojson.type !== "FeatureCollection")
          throw new Error("Invalid GeoJSON data from Overpass");
        const layer = L.geoJSON(geojson, {
          style: {
            color: streetsOnly
              ? mapLayers.osmStreets.color
              : mapLayers.osmBoundary.color,
            weight: 2,
            opacity: 0.7,
          },
        });
        if (streetsOnly) mapLayers.osmStreets.layer = layer;
        else mapLayers.osmBoundary.layer = layer;
        updateMap();
        updateLayerOrderUI();
      })
      .catch((err) => {
        console.error("Error generating OSM data:", err);
        alert(err.message);
      });
  }

  // Map matching and fetching trips in range
  function mapMatchTrips(isHistorical = false) {
    const sd = document.getElementById("start-date")?.value,
      ed = document.getElementById("end-date")?.value;
    if (!sd || !ed) {
      alert("Select start and end dates.");
      return;
    }
    showLoadingOverlay("Map matching all trips...");
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
        }),
      );
    }
    Promise.all(tasks)
      .then((responses) =>
        Promise.all(
          responses.map((r) => {
            if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
            return r.json();
          }),
        ),
      )
      .then((results) => {
        console.log("Map matching responses:", results);
        alert("Map matching completed for selected trips.");
        fetchTrips();
      })
      .catch((err) => {
        console.error("Error map matching trips:", err);
        alert("Error map matching trips. Check console.");
      })
      .finally(hideLoadingOverlay);
  }
  function fetchTripsInRange() {
    const sd = document.getElementById("start-date")?.value,
      ed = document.getElementById("end-date")?.value;
    if (!sd || !ed) {
      alert("Select start and end dates.");
      return;
    }
    showLoadingOverlay();
    fetch("/api/fetch_trips_range", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start_date: sd, end_date: ed }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (data.status === "success") {
          alert(data.message);
          fetchTrips();
        } else {
          console.error(`Error: ${data.message}`);
          alert("Error fetching trips. Check console.");
        }
      })
      .catch((err) => {
        console.error("Error fetching trips in range:", err);
        alert("Error fetching trips. Check console.");
      })
      .finally(hideLoadingOverlay);
  }

  // Fetch metrics
  function fetchMetrics() {
    const sd = document.getElementById("start-date")?.value,
      ed = document.getElementById("end-date")?.value,
      imei = document.getElementById("imei")?.value || "";
    if (!sd || !ed) return;
    fetch(`/api/metrics?start_date=${sd}&end_date=${ed}&imei=${imei}`)
      .then((r) => r.json())
      .then((metrics) => {
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
      })
      .catch((err) => console.error("Error fetching metrics:", err));
  }

  // Preprocess streets
  async function preprocessStreets() {
    const location = document.getElementById("location-input").value,
      locationType = document.getElementById("location-type").value;
    if (!location) {
      alert("Please enter and validate a location first.");
      return;
    }
    fetch("/api/preprocess_streets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location, location_type: locationType }),
    })
      .then((response) => response.json())
      .then((data) => {
        alert(
          data.status === "success" ? data.message : `Error: ${data.message}`,
        );
      })
      .catch((error) => {
        console.error("Error preprocessing streets:", error);
        alert(
          "Error preprocessing streets. Please check the console for details.",
        );
      });
  }

  // Event listeners and date presets
  function initializeEventListeners() {
    const applyFiltersBtn = document.getElementById("apply-filters");
    if (applyFiltersBtn && !applyFiltersBtn.hasListener) {
      applyFiltersBtn.hasListener = true;
      applyFiltersBtn.addEventListener("click", () => {
        const sd = document.getElementById("start-date").value,
          ed = document.getElementById("end-date").value;
        localStorage.setItem("startDate", sd);
        localStorage.setItem("endDate", ed);
        fetchTrips();
        fetchMetrics();
      });
    }
    const controlsToggle = document.getElementById("controls-toggle");
    if (controlsToggle) {
      controlsToggle.addEventListener("click", function () {
        const mapControls = document.getElementById("map-controls"),
          controlsContent = document.getElementById("controls-content");
        mapControls?.classList.toggle("minimized");
        const icon = this.querySelector("i");
        icon?.classList.toggle("fa-chevron-up");
        icon?.classList.toggle("fa-chevron-down");
        controlsContent.style.display = mapControls?.classList.contains(
          "minimized",
        )
          ? "none"
          : "block";
      });
    }
    document
      .getElementById("validate-location")
      ?.addEventListener("click", validateLocation);
    document
      .getElementById("generate-boundary")
      ?.addEventListener("click", () => generateOSMData(false));
    document
      .getElementById("generate-streets")
      ?.addEventListener("click", () => generateOSMData(true));
    document
      .getElementById("map-match-trips")
      ?.addEventListener("click", () => mapMatchTrips(false));
    document
      .getElementById("map-match-historical-trips")
      ?.addEventListener("click", () => mapMatchTrips(true));
    document
      .getElementById("generate-coverage")
      ?.addEventListener("click", generateStreetCoverage);
    document
      .querySelectorAll(".date-preset")
      .forEach((btn) => btn.addEventListener("click", handleDatePresetClick));
    document
      .getElementById("fetch-trips-range")
      ?.addEventListener("click", fetchTripsInRange);
    const highlightRecent = document.getElementById("highlight-recent-trips");
    if (highlightRecent) {
      highlightRecent.addEventListener("change", function () {
        mapSettings.highlightRecentTrips = this.checked;
        updateMap();
      });
    }
    document
      .getElementById("preprocess-streets")
      ?.addEventListener("click", preprocessStreets);
  }
  function handleDatePresetClick() {
    const range = this.dataset.range;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let startDate = new Date(today),
      endDate = new Date(today);
    if (range === "all-time") {
      showLoadingOverlay();
      fetch("/api/first_trip_date")
        .then((r) => r.json())
        .then((d) =>
          updateDatePickersAndStore(new Date(d.first_trip_date), endDate),
        )
        .catch((err) => console.error("Error fetching first trip date:", err))
        .finally(hideLoadingOverlay);
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
    }
    updateDatePickersAndStore(startDate, endDate);
  }
  function updateDatePickersAndStore(startDate, endDate) {
    const startFP = document.getElementById("start-date")?._flatpickr,
      endFP = document.getElementById("end-date")?._flatpickr;
    if (startFP && endFP) {
      startFP.setDate(startDate);
      endFP.setDate(endDate);
    }
    localStorage.setItem("startDate", startDate.toISOString().split("T")[0]);
    localStorage.setItem("endDate", endDate.toISOString().split("T")[0]);
  }

  // Street coverage generation and visualization
  async function generateStreetCoverage() {
    if (!window.validatedLocation) {
      alert("Validate a location first.");
      return;
    }
    const coverageBtn = document.getElementById("generate-coverage"),
      originalText = coverageBtn.innerHTML;
    coverageBtn.disabled = true;
    coverageBtn.innerHTML =
      '<span class="spinner-border spinner-border-sm"></span> Loading...';
    try {
      const response = await fetch("/api/street_coverage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location: window.validatedLocation }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.message || "Failed to generate street coverage",
        );
      }
      const coverageData = await response.json();
      visualizeStreetCoverage(coverageData);
    } catch (error) {
      console.error("Error generating street coverage:", error);
      alert(
        error.message || "An error occurred while generating street coverage.",
      );
    } finally {
      coverageBtn.disabled = false;
      coverageBtn.innerHTML = originalText;
    }
  }

  function visualizeStreetCoverage(coverageData) {
    // Remove any existing streetCoverage layer
    if (mapLayers.streetCoverage.layer) {
      layerGroup.removeLayer(mapLayers.streetCoverage.layer);
      mapLayers.streetCoverage.layer = null;
    }
    // Use the GeoJSON FeatureCollection returned by the backend
    mapLayers.streetCoverage.layer = L.geoJSON(coverageData.streets_data, {
      style: (feature) => ({
        color: feature.properties.driven ? "#00FF00" : "#FF4444",
        weight: 3,
        opacity: feature.properties.driven ? 0.8 : 0.4,
      }),
      onEachFeature: (feature, layer) => {
        layer.on("click", () =>
          fetchSegmentDetails(feature.properties.segment_id),
        );
      },
    });
    mapLayers.streetCoverage.layer.addTo(layerGroup);
    mapLayers.streetCoverage.visible = true;
    updateLayerOrderUI();
    updateMap();
    updateCoverageStats(coverageData);
  }

  function fetchSegmentDetails(segmentId) {
    fetch(`/api/street_segment/${segmentId}`)
      .then((response) => {
        if (!response.ok) throw new Error("Segment not found");
        return response.json();
      })
      .then((segmentData) => {
        const props = segmentData.properties || {},
          popupContent = `
            <strong>${props.street_name || "Unnamed Street"}</strong><br>
            Segment ID: ${props.segment_id}<br>
            Status: ${props.driven ? "Driven" : "Not driven"}<br>
            Last Updated: ${
              props.last_updated
                ? new Date(props.last_updated).toLocaleString()
                : "N/A"
            }<br>
            Length: ${props.length ? props.length.toFixed(2) : "??"} meters<br>
          `;
        mapLayers.streetCoverage.layer.eachLayer((lyr) => {
          if (lyr.feature?.properties?.segment_id === segmentId) {
            lyr.bindPopup(popupContent).openPopup();
          }
        });
      })
      .catch((error) => {
        console.error("Error fetching segment details:", error);
        alert("Error fetching segment details. Please try again.");
      });
  }

  function updateCoverageStats(coverageData) {
    const statsDiv = document.getElementById("coverage-stats"),
      progressBar = document.getElementById("coverage-progress"),
      coveragePercentageSpan = document.getElementById("coverage-percentage"),
      totalStreetLengthSpan = document.getElementById("total-street-length"),
      milesDrivenSpan = document.getElementById("miles-driven");

    if (
      !statsDiv ||
      !progressBar ||
      !coveragePercentageSpan ||
      !totalStreetLengthSpan ||
      !milesDrivenSpan
    ) {
      console.error("One or more coverage stats elements not found!");
      return;
    }

    // Unhide the stats panel
    statsDiv.classList.remove("d-none");

    const percent = coverageData.coverage_percentage || 0;
    // Convert meters to miles (0.000621371 conversion factor)
    const totalMiles = (coverageData.total_length || 0) * 0.000621371;
    const drivenMiles = (coverageData.driven_length || 0) * 0.000621371;

    progressBar.style.width = `${percent}%`;
    progressBar.setAttribute("aria-valuenow", percent.toFixed(1));
    coveragePercentageSpan.textContent = percent.toFixed(1);
    totalStreetLengthSpan.textContent = totalMiles.toFixed(2);
    milesDrivenSpan.textContent = drivenMiles.toFixed(2);
  }

  // Main initialization on DOM load
  document.addEventListener("DOMContentLoaded", () => {
    setInitialDates();
    initializeDatePickers();
    initializeEventListeners();
    if (
      document.getElementById("map") &&
      !document.getElementById("visits-page")
    ) {
      initializeMap();
      if (!map || !layerGroup) {
        console.error("Failed to initialize map components");
        return;
      }
      initializeLayerControls();
      fetchTrips().then(fetchMetrics);
    } else {
      fetchMetrics();
    }
  });
})();