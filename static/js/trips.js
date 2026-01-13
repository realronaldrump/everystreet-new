/**
 * Trips Page Logic
 * Handles trip listing, filtering, and bulk operations
 * Uses vanilla JS TableManager instead of jQuery DataTables
 */

import { CONFIG } from "./modules/config.js";
import { optimisticAction } from "./modules/spa/optimistic.js";
import store from "./modules/spa/store.js";
import { TableManager } from "./modules/table-manager.js";
import {
  escapeHtml,
  formatDateTime,
  formatDuration,
  formatVehicleName,
  getStorage,
  onPageLoad,
  sanitizeLocation,
  setStorage,
} from "./modules/utils.js";

let tripsTable = null;
const selectedTripIds = new Set();
onPageLoad(
  async ({ signal } = {}) => {
    try {
      await initializePage(signal);
    } catch (e) {
      window.notificationManager?.show(
        `Critical Error: ${e.message}`,
        "danger",
      );
    }
  },
  { route: "/trips" },
);

async function initializePage(signal) {
  await loadVehicles();
  initializeTable();
  setupFilterListeners();
  setupBulkActions();
  updateFilterChips();

  document.addEventListener(
    "filtersApplied",
    () => {
      updateFilterChips();
      tripsTable.reload({ resetPage: true });
    },
    signal ? { signal } : false,
  );
}

async function loadVehicles() {
  const vehicleSelect = document.getElementById("trip-filter-vehicle");
  if (!vehicleSelect) {
    return;
  }

  try {
    const response = await fetch(`${CONFIG.API.vehicles}?active_only=true`);
    if (!response.ok) {
      throw new Error("Failed to load vehicles");
    }

    const vehicles = await response.json();
    vehicleSelect.innerHTML = '<option value="">All vehicles</option>';

    vehicles.forEach((v) => {
      const option = document.createElement("option");
      option.value = v.imei;
      option.textContent = formatVehicleName(v);
      vehicleSelect.appendChild(option);
    });

    const savedImei = getStorage(CONFIG.STORAGE_KEYS.selectedVehicle);
    if (savedImei) {
      vehicleSelect.value = savedImei;
    }
  } catch {
    window.notificationManager?.show("Failed to load vehicles list", "warning");
  }
}

function initializeTable() {
  tripsTable = new TableManager("trips-table", {
    serverSide: true,
    url: CONFIG.API.tripsDataTable,
    pageSize: 25,
    defaultSort: { column: 2, dir: "desc" },
    emptyMessage: "No trips found matching criteria",
    getFilters: getFilterValues,
    columns: [
      {
        data: null,
        orderable: false,
        className: "text-center",
        render: (_data, _type, row) => {
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.className = "trip-checkbox form-check-input";
          checkbox.value = row.transactionId;
          checkbox.checked = selectedTripIds.has(row.transactionId);
          checkbox.addEventListener("change", (e) => {
            if (e.target.checked) {
              selectedTripIds.add(row.transactionId);
            } else {
              selectedTripIds.delete(row.transactionId);
            }
            updateBulkDeleteButton();
          });
          return checkbox;
        },
      },
      {
        data: "vehicleLabel",
        name: "vehicleLabel",
        render: (_data, _type, row) => {
          const cell = document.createElement("div");
          cell.className = "trip-cell";

          const title = document.createElement("div");
          title.className = "trip-title";
          title.textContent = row.vehicleLabel || "Unknown vehicle";
          cell.appendChild(title);

          const meta = document.createElement("div");
          meta.className = "trip-meta";
          if (row.transactionId) {
            const idPill = document.createElement("span");
            idPill.className = "pill pill-muted";
            idPill.textContent = row.transactionId;
            meta.appendChild(idPill);
          }
          if (row.vin) {
            const vinPill = document.createElement("span");
            vinPill.className = "pill pill-subtle";
            vinPill.textContent = `VIN ${row.vin}`;
            meta.appendChild(vinPill);
          }
          cell.appendChild(meta);

          return cell;
        },
      },
      {
        data: "startTime",
        name: "startTime",
        render: (_data, _type, row) => {
          const cell = document.createElement("div");
          cell.className = "trip-cell";

          const title = document.createElement("div");
          title.className = "trip-title";
          title.textContent = formatDateTime(row.startTime);
          cell.appendChild(title);

          const meta = document.createElement("div");
          meta.className = "trip-meta";
          meta.innerHTML = `<i class="far fa-clock"></i> ${escapeHtml(formatDuration(row.duration))} &middot; Ends ${escapeHtml(formatDateTime(row.endTime))}`;
          cell.appendChild(meta);

          return cell;
        },
      },
      {
        data: "distance",
        name: "distance",
        render: (_data, _type, row) => {
          const cell = document.createElement("div");
          cell.className = "trip-cell";

          const title = document.createElement("div");
          title.className = "trip-title";
          title.textContent = row.distance
            ? `${parseFloat(row.distance).toFixed(1)} mi`
            : "--";
          cell.appendChild(title);

          const meta = document.createElement("div");
          meta.className = "trip-meta";
          meta.innerHTML = `<i class="fas fa-map-marker-alt"></i> ${escapeHtml(sanitizeLocation(row.startLocation))} &rarr; ${escapeHtml(sanitizeLocation(row.destination))}`;
          cell.appendChild(meta);

          return cell;
        },
      },
      {
        data: "maxSpeed",
        name: "maxSpeed",
        render: (_data, _type, row) => {
          const cell = document.createElement("div");
          cell.className = "trip-cell";

          const title = document.createElement("div");
          title.className = "trip-title";
          title.textContent = row.maxSpeed
            ? `${Math.round(row.maxSpeed)} mph`
            : "--";
          cell.appendChild(title);

          const idle = row.totalIdleDuration
            ? `${Math.round(row.totalIdleDuration / 60)} min idle`
            : "Minimal idle";
          const meta = document.createElement("div");
          meta.className = "trip-meta";
          meta.innerHTML = `<i class="fas fa-stopwatch"></i> ${escapeHtml(idle)}`;
          cell.appendChild(meta);

          return cell;
        },
      },
      {
        data: "fuelConsumed",
        name: "fuelConsumed",
        render: (_data, _type, row) => {
          const cell = document.createElement("div");
          cell.className = "trip-cell";

          const title = document.createElement("div");
          title.className = "trip-title";
          title.textContent = row.fuelConsumed
            ? `${parseFloat(row.fuelConsumed).toFixed(2)} gal`
            : "--";
          cell.appendChild(title);

          const cost = row.estimated_cost
            ? `$${parseFloat(row.estimated_cost).toFixed(2)}`
            : "--";
          const meta = document.createElement("div");
          meta.className = "trip-meta";
          meta.innerHTML = `<i class="fas fa-dollar-sign"></i> Est. cost ${escapeHtml(cost)}`;
          cell.appendChild(meta);

          return cell;
        },
      },
      {
        data: null,
        orderable: false,
        render: (_data, _type, row) => {
          const container = document.createElement("div");
          container.className = "btn-group btn-group-sm no-row-click";

          const viewBtn = document.createElement("button");
          viewBtn.type = "button";
          viewBtn.className = "btn btn-outline-primary";
          viewBtn.title = "View details";
          viewBtn.innerHTML = '<i class="fas fa-map"></i>';
          viewBtn.addEventListener("click", () =>
            openTripModal(row.transactionId),
          );
          container.appendChild(viewBtn);

          const deleteBtn = document.createElement("button");
          deleteBtn.className = "btn btn-outline-danger";
          deleteBtn.title = "Delete";
          deleteBtn.innerHTML = '<i class="fas fa-trash"></i>';
          deleteBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const confirmed = await window.confirmationDialog.show({
              title: "Delete Trip",
              message: "Are you sure you want to delete this trip?",
              confirmText: "Delete",
              confirmButtonClass: "btn-danger",
            });
            if (confirmed) {
              deleteTrip(row.transactionId);
            }
          });
          container.appendChild(deleteBtn);

          return container;
        },
      },
    ],
    onDataLoaded: () => {
      updateBulkDeleteButton();
    },
  });

  // Select all checkbox
  const selectAll = document.getElementById("select-all-trips");
  if (selectAll) {
    selectAll.addEventListener("change", (e) => {
      const checkboxes = document.querySelectorAll(".trip-checkbox");
      checkboxes.forEach((cb) => {
        cb.checked = e.target.checked;
        if (e.target.checked) {
          selectedTripIds.add(cb.value);
        } else {
          selectedTripIds.delete(cb.value);
        }
      });
      updateBulkDeleteButton();
    });
  }
}

function getFilterValues() {
  const getVal = (id) => document.getElementById(id)?.value?.trim() || null;
  return {
    imei: getVal("trip-filter-vehicle"),
    distance_min: getVal("trip-filter-distance-min"),
    distance_max: getVal("trip-filter-distance-max"),
    speed_min: getVal("trip-filter-speed-min"),
    speed_max: getVal("trip-filter-speed-max"),
    fuel_min: getVal("trip-filter-fuel-min"),
    fuel_max: getVal("trip-filter-fuel-max"),
    has_fuel: document.getElementById("trip-filter-has-fuel")?.checked || false,
    start_date: getStorage("startDate") || null,
    end_date: getStorage("endDate") || null,
  };
}

function setupFilterListeners() {
  const inputs = document.querySelectorAll(
    "#trip-filter-vehicle, #trip-filter-distance-min, #trip-filter-distance-max, " +
      "#trip-filter-speed-min, #trip-filter-speed-max, #trip-filter-fuel-min, #trip-filter-fuel-max, " +
      "#trip-filter-has-fuel",
  );

  inputs.forEach((input) => {
    input.addEventListener("change", () => {
      if (input.id === "trip-filter-vehicle") {
        setStorage(CONFIG.STORAGE_KEYS.selectedVehicle, input.value || null);
        store.updateFilters(
          { vehicle: input.value || null },
          { source: "vehicle" },
        );
      }
      updateFilterChips();
    });
    input.addEventListener("input", () => updateFilterChips(false));
  });

  document
    .getElementById("trip-filter-apply")
    ?.addEventListener("click", () => {
      tripsTable.reload({ resetPage: true });
      showFilterAppliedMessage();
      updateFilterChips();
    });

  const resetBtn = document.getElementById("trip-filter-reset");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      inputs.forEach((input) => {
        if (input.type === "checkbox") {
          input.checked = false;
        } else {
          input.value = "";
        }
      });
      updateFilterChips();
      tripsTable.reload({ resetPage: true });
    });
  }
}

function updateFilterChips(triggerReload = false) {
  const container = document.getElementById("active-filter-chips");
  if (!container) {
    return;
  }

  const filters = getFilterValues();
  container.innerHTML = "";

  const addChip = (label, value, onRemove) => {
    const chip = document.createElement("span");
    chip.className = "filter-chip";

    const labelEl = document.createElement("strong");
    labelEl.textContent = `${label}: `;
    chip.appendChild(labelEl);
    chip.appendChild(document.createTextNode(`${value} `));

    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", "Remove filter");
    btn.innerHTML = '<i class="fas fa-times"></i>';
    btn.addEventListener("click", () => {
      onRemove();
      updateFilterChips(true);
    });
    chip.appendChild(btn);

    container.appendChild(chip);
  };

  if (filters.imei) {
    addChip("Vehicle", filters.imei, () => clearInput("trip-filter-vehicle"));
  }
  if (filters.start_date || filters.end_date) {
    addChip(
      "Date",
      `${filters.start_date || "Any"} -> ${filters.end_date || "Any"}`,
      () => {
        setStorage("startDate", null);
        setStorage("endDate", null);
        document.dispatchEvent(new Event("filtersReset"));
        tripsTable.reload({ resetPage: true });
      },
    );
  }
  if (filters.distance_min || filters.distance_max) {
    addChip(
      "Distance",
      `${filters.distance_min || "0"} - ${filters.distance_max || "inf"} mi`,
      () => {
        clearInput("trip-filter-distance-min");
        clearInput("trip-filter-distance-max");
      },
    );
  }
  if (filters.speed_min || filters.speed_max) {
    addChip(
      "Speed",
      `${filters.speed_min || "0"} - ${filters.speed_max || "inf"} mph`,
      () => {
        clearInput("trip-filter-speed-min");
        clearInput("trip-filter-speed-max");
      },
    );
  }
  if (filters.fuel_min || filters.fuel_max) {
    addChip(
      "Fuel",
      `${filters.fuel_min || "0"} - ${filters.fuel_max || "inf"} gal`,
      () => {
        clearInput("trip-filter-fuel-min");
        clearInput("trip-filter-fuel-max");
      },
    );
  }
  if (filters.has_fuel) {
    addChip("Has fuel", "Only trips with fuel data", () => {
      const cb = document.getElementById("trip-filter-has-fuel");
      if (cb) {
        cb.checked = false;
      }
    });
  }

  if (container.children.length === 0) {
    container.innerHTML = '<span class="filter-empty">No active filters</span>';
  }

  if (triggerReload) {
    tripsTable.reload({ resetPage: true });
  }
}

function clearInput(id) {
  const el = document.getElementById(id);
  if (!el) {
    return;
  }
  if (el.type === "checkbox") {
    el.checked = false;
  } else {
    el.value = "";
  }
}

function showFilterAppliedMessage() {
  const helper = document.getElementById("filter-helper-text");
  if (!helper) {
    return;
  }
  helper.textContent = "Filters applied. Showing the newest matching trips.";
  helper.classList.add("text-success");
  setTimeout(() => {
    helper.textContent = "Adjust filters then apply to refresh results.";
    helper.classList.remove("text-success");
  }, 2000);
}

function updateBulkDeleteButton() {
  const btn = document.getElementById("bulk-delete-trips-btn");
  if (!btn) {
    return;
  }

  const count = selectedTripIds.size;
  btn.disabled = count === 0;
  const textEl = btn.querySelector(".btn-text");
  if (textEl) {
    textEl.textContent =
      count > 0 ? `Delete Selected (${count})` : "Delete Selected";
  }
}

function setupBulkActions() {
  document
    .getElementById("bulk-delete-trips-btn")
    ?.addEventListener("click", async () => {
      if (selectedTripIds.size === 0) {
        return;
      }

      const confirmed = await window.confirmationDialog.show({
        title: "Delete Trips",
        message: `Are you sure you want to delete ${selectedTripIds.size} trips?`,
        confirmText: "Delete All",
        confirmButtonClass: "btn-danger",
      });

      if (confirmed) {
        await bulkDeleteTrips([...selectedTripIds]);
      }
    });

  document
    .getElementById("refresh-geocoding-btn")
    ?.addEventListener("click", async () => {
      try {
        window.notificationManager?.show(
          "Starting geocoding refresh...",
          "info",
        );
        const response = await fetch(CONFIG.API.geocodeTrips, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ interval_days: 7 }),
        });
        const result = await response.json();
        if (response.ok) {
          window.notificationManager?.show(
            "Geocoding task started.",
            "success",
          );
        } else {
          throw new Error(result.detail || "Failed to start geocoding");
        }
      } catch (e) {
        window.notificationManager?.show(e.message, "danger");
      }
    });
}

async function deleteTrip(id) {
  try {
    await optimisticAction({
      optimistic: () => {
        if (!tripsTable?.state?.data) {
          return null;
        }
        const snapshot = {
          data: [...tripsTable.state.data],
          totalRecords: tripsTable.state.totalRecords,
          totalPages: tripsTable.state.totalPages,
        };
        tripsTable.state.data = tripsTable.state.data.filter(
          (row) => row.transactionId !== id,
        );
        tripsTable.state.totalRecords = Math.max(
          0,
          tripsTable.state.totalRecords - 1,
        );
        tripsTable.state.totalPages = Math.ceil(
          tripsTable.state.totalRecords / tripsTable.options.pageSize,
        );
        tripsTable._render();
        selectedTripIds.delete(id);
        updateBulkDeleteButton();
        return snapshot;
      },
      request: async () => {
        const response = await fetch(CONFIG.API.tripById(id), {
          method: "DELETE",
        });
        if (!response.ok) {
          throw new Error("Failed to delete trip");
        }
        return response;
      },
      commit: () => {
        window.notificationManager?.show(
          "Trip deleted successfully",
          "success",
        );
        tripsTable.reload();
      },
      rollback: (snapshot) => {
        if (snapshot && tripsTable?.state) {
          tripsTable.state.data = snapshot.data;
          tripsTable.state.totalRecords = snapshot.totalRecords;
          tripsTable.state.totalPages = snapshot.totalPages;
          tripsTable._render();
        }
        window.notificationManager?.show("Failed to delete trip", "danger");
      },
    });
  } catch {
    // Error handled in rollback
  }
}

async function bulkDeleteTrips(ids) {
  try {
    await optimisticAction({
      optimistic: () => {
        if (!tripsTable?.state?.data) {
          return null;
        }
        const snapshot = {
          data: [...tripsTable.state.data],
          totalRecords: tripsTable.state.totalRecords,
          totalPages: tripsTable.state.totalPages,
        };
        const idSet = new Set(ids);
        tripsTable.state.data = tripsTable.state.data.filter(
          (row) => !idSet.has(row.transactionId),
        );
        tripsTable.state.totalRecords = Math.max(
          0,
          tripsTable.state.totalRecords - ids.length,
        );
        tripsTable.state.totalPages = Math.ceil(
          tripsTable.state.totalRecords / tripsTable.options.pageSize,
        );
        tripsTable._render();
        selectedTripIds.clear();
        const selectAllEl = document.getElementById("select-all-trips");
        if (selectAllEl) {
          selectAllEl.checked = false;
        }
        updateBulkDeleteButton();
        return snapshot;
      },
      request: async () => {
        const response = await fetch(CONFIG.API.tripsBulkDelete, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trip_ids: ids }),
        });

        if (!response.ok) {
          throw new Error("Failed to bulk delete trips");
        }
        return response.json();
      },
      commit: (result) => {
        window.notificationManager?.show(
          result.message || "Trips deleted",
          "success",
        );
        tripsTable.reload();
      },
      rollback: (snapshot) => {
        if (snapshot && tripsTable?.state) {
          tripsTable.state.data = snapshot.data;
          tripsTable.state.totalRecords = snapshot.totalRecords;
          tripsTable.state.totalPages = snapshot.totalPages;
          tripsTable._render();
        }
        window.notificationManager?.show("Failed to delete trips", "danger");
      },
    });
  } catch {
    // Error handled in rollback
  }
}

// --- Trip Modal Logic ---

let tripModalMap = null;
let tripModalInstance = null;
let currentTripId = null;
let playbackControlsBound = false;

const playbackState = {
  coords: [],
  marker: null,
  frame: null,
  progress: 0,
  speed: 1,
  isPlaying: false,
  trailSourceId: "modal-trip-trail",
  trailLayerId: "modal-trip-trail-line",
  headSourceId: "modal-trip-head",
  headLayerId: "modal-trip-head-point",
};

async function openTripModal(tripId) {
  currentTripId = tripId;

  // Initialize modal instance if needed
  if (!tripModalInstance) {
    const el = document.getElementById("tripDetailsModal");
    if (el) {
      tripModalInstance = new bootstrap.Modal(el);
      // Clean up map when modal is hidden
      el.addEventListener("hidden.bs.modal", () => {
        if (tripModalMap) {
          // Clear map data but keep instance
          const src = tripModalMap.getSource("modal-trip");
          if (src) {
            src.setData({ type: "FeatureCollection", features: [] });
          }
        }
        resetPlayback();
      });
      // Handle map resize when modal is shown
      el.addEventListener("shown.bs.modal", () => {
        if (tripModalMap) {
          tripModalMap.resize();
        } else {
          initTripModalMap();
        }
        setupTripPlaybackControls();
        loadTripData(currentTripId);
      });
    }
  }

  tripModalInstance.show();
}

async function initTripModalMap() {
  if (tripModalMap) return;

  try {
    const { createMap } = window.mapBase;
    tripModalMap = createMap("trip-modal-map", {
      style: "mapbox://styles/mapbox/dark-v11", // Use dark mode by default for contrast
      zoom: 1,
      center: [-98.57, 39.82], // Center US
    });

    tripModalMap.on("load", () => {
      // Add source and layer for the trip
      tripModalMap.addSource("modal-trip", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      tripModalMap.addLayer({
        id: "modal-trip-line",
        type: "line",
        source: "modal-trip",
        layout: {
          "line-join": "round",
          "line-cap": "round",
        },
        paint: {
          "line-color": "#4A90D9",
          "line-width": 4,
          "line-opacity": 0.9,
        },
      });

      if (!tripModalMap.getSource(playbackState.trailSourceId)) {
        tripModalMap.addSource(playbackState.trailSourceId, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });

        tripModalMap.addLayer({
          id: playbackState.trailLayerId,
          type: "line",
          source: playbackState.trailSourceId,
          layout: {
            "line-join": "round",
            "line-cap": "round",
          },
          paint: {
            "line-color": "#7c9d96",
            "line-width": 3,
            "line-opacity": 0.6,
          },
        });
      }

      if (!tripModalMap.getSource(playbackState.headSourceId)) {
        tripModalMap.addSource(playbackState.headSourceId, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });

        tripModalMap.addLayer({
          id: playbackState.headLayerId,
          type: "circle",
          source: playbackState.headSourceId,
          paint: {
            "circle-radius": 6,
            "circle-color": "#f97316",
            "circle-opacity": 0.9,
            "circle-stroke-width": 2,
            "circle-stroke-color": "#fff",
          },
        });
      }

      // Add start/end points if needed, or markers
    });
  } catch (e) {
    console.error("Failed to init modal map", e);
    document.getElementById("trip-modal-map").innerHTML =
      '<div class="alert alert-danger m-3">Failed to load map.</div>';
  }
}

async function loadTripData(tripId) {
  const loadingEl = document.getElementById("trip-map-loading");
  if (loadingEl) loadingEl.classList.remove("d-none");

  // Reset text
  setText("tripModalTitle", "Loading...");
  setText("tripModalSubtitle", "");
  setText("modal-distance", "--");
  setText("modal-duration", "--");
  setText("modal-max-speed", "--");
  setText("modal-fuel", "--");
  setText("modal-start-loc", "--");
  setText("modal-end-loc", "--");

  try {
    // Fetch trip details
    const res = await fetch(CONFIG.API.tripById(tripId));
    if (!res.ok) throw new Error("Failed to load trip details");
    const data = await res.json();
    const trip = data.trip || data; // Handle wrapped response

    updateModalContent(trip);

    // Fetch GeoJSON for map
    // We can use the same endpoint if it returns geometry, or a specific one.
    // Assuming API.tripById returns the full trip with geometry or we need another call.
    // Let's check `trips.js` or `CONFIG`. Usually `tripById` returns the document.
    // If geometry inside trip object:
    if (trip.geometry) {
      renderTripOnMap(trip);
    } else {
      // Fallback or separate fetch if needed.
      // Attempt to fetch dedicated geojson if geometry is missing from detail
      // const geoRes = await fetch(`/api/trips/${tripId}/geojson`); ...
    }
  } catch (e) {
    console.error(e);
    window.notificationManager?.show("Failed to load trip data", "danger");
  } finally {
    if (loadingEl) loadingEl.classList.add("d-none");
  }
}

function updateModalContent(trip) {
  setText("tripModalTitle", trip.vehicleLabel || "Trip Details");
  setText(
    "tripModalSubtitle",
    `${formatDateTime(trip.startTime)} • ${trip.transactionId}`,
  );
  setText(
    "modal-distance",
    trip.distance ? `${parseFloat(trip.distance).toFixed(2)} mi` : "--",
  );
  setText(
    "modal-duration",
    trip.duration ? formatDuration(trip.duration) : "--",
  );
  setText(
    "modal-max-speed",
    trip.maxSpeed ? `${Math.round(trip.maxSpeed)} mph` : "--",
  );
  setText(
    "modal-fuel",
    trip.fuelConsumed
      ? `${parseFloat(trip.fuelConsumed).toFixed(2)} gal`
      : "--",
  );
  setText("modal-start-loc", sanitizeLocation(trip.startLocation));
  setText("modal-end-loc", sanitizeLocation(trip.destination));
}

function renderTripOnMap(trip) {
  if (!tripModalMap || !tripModalMap.isStyleLoaded()) {
    // Retry shortly if map not ready (though 'shown' event usually handles this)
    setTimeout(() => renderTripOnMap(trip), 200);
    return;
  }

  const geojson = {
    type: "Feature",
    geometry: trip.geometry,
    properties: {},
  };

  const src = tripModalMap.getSource("modal-trip");
  if (src) {
    src.setData({ type: "FeatureCollection", features: [geojson] });
  }

  setPlaybackRoute(trip.geometry);

  // Fit bounds
  const bounds = new mapboxgl.LngLatBounds();
  const coords = trip.geometry.coordinates;
  // Handle Point vs LineString vs MultiLineString if necessary. Assuming LineString for trips.
  if (trip.geometry.type === "LineString") {
    coords.forEach((c) => bounds.extend(c));
  } else if (trip.geometry.type === "Point") {
    bounds.extend(coords);
  }

  if (!bounds.isEmpty()) {
    // Ensure map is resized correctly before fitting bounds
    tripModalMap.resize();
    tripModalMap.fitBounds(bounds, {
      padding: 100,
      duration: 2000, // Animate over 2 seconds
      essential: true, // Ensure animation happens even if user hasn't interacted
    });
  }
}

function setupTripPlaybackControls() {
  if (playbackControlsBound) {
    return;
  }

  const playBtn = document.getElementById("trip-playback-toggle");
  const speedInput = document.getElementById("trip-playback-speed");
  const speedLabel = document.getElementById("trip-playback-speed-label");

  if (playBtn) {
    playBtn.addEventListener("click", () => {
      if (playbackState.isPlaying) {
        pausePlayback();
      } else {
        startPlayback();
      }
      updatePlaybackUI();
    });
  }

  if (speedInput) {
    speedInput.addEventListener("input", () => {
      playbackState.speed = Number(speedInput.value) || 1;
      if (speedLabel) {
        speedLabel.textContent = `${playbackState.speed.toFixed(1)}x`;
      }
    });
  }

  playbackControlsBound = true;
  updatePlaybackUI();
}

function setPlaybackRoute(geometry) {
  if (!geometry || geometry.type !== "LineString") {
    playbackState.coords = [];
    return;
  }
  playbackState.coords = geometry.coordinates || [];
  playbackState.progress = 0;
  updatePlaybackTrail([]);
  updatePlaybackHead(null);
}

function startPlayback() {
  if (!tripModalMap || playbackState.coords.length === 0) {
    return;
  }
  playbackState.isPlaying = true;
  if (!playbackState.marker) {
    playbackState.marker = new mapboxgl.Marker({ color: "#f97316" });
  }

  const step = () => {
    if (!playbackState.isPlaying) {
      return;
    }
    playbackState.progress += playbackState.speed * 0.6;
    const index = Math.min(
      playbackState.coords.length - 1,
      Math.floor(playbackState.progress),
    );
    const coord = playbackState.coords[index];
    if (!coord) {
      pausePlayback();
      return;
    }

    playbackState.marker.setLngLat(coord).addTo(tripModalMap);
    updatePlaybackHead(coord);
    updatePlaybackTrail(playbackState.coords.slice(0, index + 1));

    if (index >= playbackState.coords.length - 1) {
      pausePlayback();
      return;
    }
    playbackState.frame = requestAnimationFrame(step);
  };

  playbackState.frame = requestAnimationFrame(step);
}

function pausePlayback() {
  playbackState.isPlaying = false;
  if (playbackState.frame) {
    cancelAnimationFrame(playbackState.frame);
    playbackState.frame = null;
  }
}

function resetPlayback() {
  pausePlayback();
  playbackState.progress = 0;
  updatePlaybackTrail([]);
  updatePlaybackHead(null);
  if (playbackState.marker) {
    playbackState.marker.remove();
  }
}

function updatePlaybackHead(coord) {
  if (!tripModalMap?.getSource(playbackState.headSourceId)) {
    return;
  }
  const feature = coord
    ? { type: "Feature", geometry: { type: "Point", coordinates: coord } }
    : null;
  const data = feature
    ? { type: "FeatureCollection", features: [feature] }
    : {
        type: "FeatureCollection",
        features: [],
      };
  tripModalMap.getSource(playbackState.headSourceId).setData(data);
}

function updatePlaybackTrail(coords) {
  if (!tripModalMap?.getSource(playbackState.trailSourceId)) {
    return;
  }
  const data = coords.length
    ? {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "LineString", coordinates: coords },
          },
        ],
      }
    : { type: "FeatureCollection", features: [] };
  tripModalMap.getSource(playbackState.trailSourceId).setData(data);
}

function updatePlaybackUI() {
  const playBtn = document.getElementById("trip-playback-toggle");
  if (!playBtn) {
    return;
  }
  const icon = playBtn.querySelector("i");
  if (playbackState.isPlaying) {
    playBtn.classList.add("is-playing");
    playBtn.setAttribute("aria-pressed", "true");
    if (icon) {
      icon.className = "fas fa-pause";
    }
    const span = playBtn.querySelector("span");
    if (span) span.textContent = "Pause";
  } else {
    playBtn.classList.remove("is-playing");
    playBtn.setAttribute("aria-pressed", "false");
    if (icon) {
      icon.className = "fas fa-play";
    }
    const span = playBtn.querySelector("span");
    if (span) span.textContent = "Play";
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
