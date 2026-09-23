/**
 * The trip modal: trip details, route chip, share and re-geocode tools,
 * the route map (Mapbox or Google), and route playback. The page opens it
 * with openTripModal/openTripTools and keeps it in step through
 * resetTripModal, mergeIntoOpenTrip, and refreshOpenTrip.
 */

import { CONFIG } from "../../core/config.js";
import { navigate } from "../../core/navigation.js";
import { createMap } from "../../map-core.js";
import {
  getGoogleMapsApi,
  hasGoogleMapsApi,
  waitForGoogleMaps,
} from "../../maps/google_maps_loader.js";
import confirmationDialog from "../../ui/confirmation-dialog.js";
import { moveFocusOutOfModal } from "../../ui/modal-focus.js";
import notificationManager from "../../ui/notifications.js";
import {
  escapeHtml,
  formatCurrency,
  formatDateTime,
  formatDuration,
  isAbortError,
  sanitizeLocation,
  toFiniteNumber,
} from "../../utils.js";
import { generateSmartTitle, getTripUiColors, isInactiveTrip } from "./presentation.js";
import { apiGet, apiPost, bindPageEvent, pageSignal } from "./page-context.js";

let tripModalMap = null;
let tripModalInstance = null;
let tripModalElement = null;
let modalReturnFocus = null;
let currentTripId = null;
let currentTripData = null;
let regeocodeInFlight = false;
let modalRouteActionsTripId = null;
let modalRouteChipToken = 0;
let playbackControlsBound = false;
let modalActionsBound = false;
let tripModalMapInitPromise = null;

const playbackState = {
  coords: [],
  marker: null,
  startMarker: null,
  endMarker: null,
  frame: null,
  progress: 0,
  speed: 0.5,
  isPlaying: false,
  isComplete: false,
  trailSourceId: "modal-trip-trail",
  trailLayerId: "modal-trip-trail-line",
  headSourceId: "modal-trip-head",
  headLayerId: "modal-trip-head-point",
};

const PLAYBACK_SPEED_BASE = 0.5;
const PLAYBACK_STEP_PER_FRAME = 0.02;
const googleModalState = {
  routePolyline: null,
  trailPolyline: null,
  headMarker: null,
};

function disposeTripModalInstance() {
  const modal = tripModalElement;
  if (modal) {
    moveFocusOutOfModal(modal, { preferredTarget: modalReturnFocus });
  }

  const instance = tripModalInstance;
  if (instance) {
    if (modal?.classList?.contains("show") || modal?.style?.display === "block") {
      instance.hide?.();
    }
    instance.dispose?.();
  }

  tripModalInstance = null;
  tripModalElement = null;
  modalReturnFocus = null;
}

function isGoogleMapProvider() {
  return String(window.MAP_PROVIDER || "").toLowerCase() === "google";
}

function toGoogleLatLng(coord) {
  if (!Array.isArray(coord) || coord.length < 2) {
    return null;
  }
  const lng = Number(coord[0]);
  const lat = Number(coord[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return null;
  }
  return { lng, lat };
}

function toGooglePath(coords = []) {
  return coords.map((coord) => toGoogleLatLng(coord)).filter(Boolean);
}

function removeMapMarker(marker) {
  if (!marker) {
    return;
  }
  try {
    if (typeof marker.remove === "function") {
      marker.remove();
      return;
    }
    if (typeof marker.setMap === "function") {
      marker.setMap(null);
    }
  } catch {
    // Ignore marker cleanup errors.
  }
}

function setMapMarkerPosition(marker, coord) {
  if (!marker || !tripModalMap || !Array.isArray(coord) || coord.length < 2) {
    return;
  }
  if (typeof marker.setLngLat === "function") {
    marker.setLngLat(coord).addTo(tripModalMap);
    return;
  }
  const latLng = toGoogleLatLng(coord);
  if (!latLng) {
    return;
  }
  if (typeof marker.setPosition === "function") {
    marker.setPosition(latLng);
  }
  if (typeof marker.setMap === "function") {
    marker.setMap(tripModalMap);
  }
}

function resizeTripModalMap() {
  if (!tripModalMap) {
    return;
  }
  if (typeof tripModalMap.resize === "function") {
    tripModalMap.resize();
    return;
  }
  const maps = getGoogleMapsApi();
  if (maps?.event && typeof maps.event.trigger === "function") {
    const center = tripModalMap.getCenter?.();
    maps.event.trigger(tripModalMap, "resize");
    if (center && typeof tripModalMap.setCenter === "function") {
      tripModalMap.setCenter(center);
    }
  }
}

function clearGoogleModalState() {
  removeMapMarker(googleModalState.headMarker);
  googleModalState.headMarker = null;

  if (googleModalState.routePolyline?.setPath) {
    googleModalState.routePolyline.setPath([]);
  }
  if (googleModalState.routePolyline?.setMap) {
    googleModalState.routePolyline.setMap(null);
  }
  googleModalState.routePolyline = null;

  if (googleModalState.trailPolyline?.setPath) {
    googleModalState.trailPolyline.setPath([]);
  }
  if (googleModalState.trailPolyline?.setMap) {
    googleModalState.trailPolyline.setMap(null);
  }
  googleModalState.trailPolyline = null;
}

function clearTripModalRouteData() {
  if (!tripModalMap) {
    return;
  }
  if (isGoogleMapProvider()) {
    if (googleModalState.routePolyline?.setPath) {
      googleModalState.routePolyline.setPath([]);
    }
  } else {
    const src = tripModalMap.getSource?.("modal-trip");
    if (src) {
      src.setData({ type: "FeatureCollection", features: [] });
    }
  }
  updatePlaybackTrail([]);
  updatePlaybackHead(null);
  updateTripEndpointMarkers(null, null);
}

function cleanupTripModalMap() {
  clearTripModalRouteData();
  clearGoogleModalState();

  removeMapMarker(playbackState.marker);
  playbackState.marker = null;
  removeMapMarker(playbackState.startMarker);
  playbackState.startMarker = null;
  removeMapMarker(playbackState.endMarker);
  playbackState.endMarker = null;

  if (tripModalMap) {
    try {
      if (typeof tripModalMap.remove === "function") {
        tripModalMap.remove();
      } else if (hasGoogleMapsApi()) {
        getGoogleMapsApi()?.event?.clearInstanceListeners?.(tripModalMap);
      }
    } catch {
      // Ignore map cleanup errors.
    }
    tripModalMap = null;
  }
  tripModalMapInitPromise = null;
}

// ==========================================
// TRIP MODAL
// ==========================================

/** Page actions the modal buttons call; set by the page on init. */
const pageActions = {
  deleteTrip: async () => {},
  toggleTripInactive: async () => {},
};

export function setTripModalActions(actions) {
  Object.assign(pageActions, actions);
}

/** Close the modal, stop playback, and forget the open trip. */
export function resetTripModal() {
  disposeTripModalInstance();
  currentTripId = null;
  currentTripData = null;
  regeocodeInFlight = false;
  modalRouteActionsTripId = null;
  playbackControlsBound = false;
  modalActionsBound = false;

  pausePlayback();
  playbackState.coords = [];
  playbackState.frame = null;
  playbackState.progress = 0;
  playbackState.speed = PLAYBACK_SPEED_BASE;
  playbackState.isPlaying = false;
  playbackState.isComplete = false;
  cleanupTripModalMap();
}

/** Fold an edited trip into the open trip when it is the same one. */
export function mergeIntoOpenTrip(updatedTrip) {
  if (currentTripData?.transactionId === updatedTrip.transactionId) {
    currentTripData = { ...currentTripData, ...updatedTrip };
  }
}

/** Redraw the modal if it is showing this trip. */
export function refreshOpenTrip(tripId) {
  if (currentTripData?.transactionId === tripId) {
    updateModalContent(currentTripData);
  }
}

export function openTripModal(tripId) {
  void navigate(`/trips/${encodeURIComponent(tripId)}`);
}

export function openTripTools(tripId) {
  if (!tripId) {
    return;
  }

  const el = document.getElementById("tripDetailsModal");
  const Modal = typeof bootstrap !== "undefined" ? bootstrap.Modal : null;
  if (!el || typeof Modal !== "function") {
    return;
  }

  if (tripModalElement !== el) {
    disposeTripModalInstance();
    tripModalElement = el;
    tripModalInstance = new Modal(el);

    bindPageEvent(el, "hide.bs.modal", () => {
      moveFocusOutOfModal(el, { preferredTarget: modalReturnFocus });
    });

    bindPageEvent(el, "hidden.bs.modal", () => {
      if (tripModalElement !== el) {
        return;
      }
      resetPlayback();
      currentTripData = null;
      regeocodeInFlight = false;
      modalRouteActionsTripId = null;
      modalReturnFocus = null;
      clearTripModalRouteData();
    });

    bindPageEvent(el, "shown.bs.modal", () => {
      if (!tripModalMap) {
        void initTripModalMap();
      } else {
        resizeTripModalMap();
        setupTripPlaybackControls();
        void loadTripData(currentTripId);
      }
    });

    bindTripModalActions();
  }

  const activeElement = document.activeElement;
  modalReturnFocus =
    activeElement &&
    activeElement !== el &&
    !el.contains(activeElement) &&
    activeElement.isConnected !== false
      ? activeElement
      : null;
  currentTripId = tripId;

  if (el.classList.contains("show")) {
    void loadTripData(tripId);
  } else {
    tripModalInstance.show();
  }
}

function bindTripModalActions() {
  if (modalActionsBound) {
    return;
  }

  const shareBtn = document.getElementById("modal-share-btn");
  const inactiveBtn = document.getElementById("modal-inactive-toggle-btn");
  const deleteBtn = document.getElementById("modal-delete-btn");
  const regeocodeBtn = document.getElementById("modal-regeocode-btn");

  if (!shareBtn && !inactiveBtn && !deleteBtn && !regeocodeBtn) {
    console.warn("Trip modal action buttons not found");
    return;
  }

  if (shareBtn) {
    shareBtn.type = "button";
    bindPageEvent(shareBtn, "click", () => showShareModal());
  }

  if (deleteBtn) {
    deleteBtn.type = "button";
    bindPageEvent(deleteBtn, "click", async () => {
      const confirmed = await confirmationDialog.show({
        title: "Delete Trip",
        message:
          "Are you sure you want to delete this trip? This action cannot be undone.",
        confirmText: "Delete",
        confirmButtonClass: "btn-danger",
      });
      if (confirmed && currentTripId) {
        tripModalInstance?.hide();
        await pageActions.deleteTrip(currentTripId);
      }
    });
  }

  if (inactiveBtn) {
    inactiveBtn.type = "button";
    bindPageEvent(inactiveBtn, "click", async () => {
      if (!currentTripData?.transactionId) {
        return;
      }
      const nextInactive = !isInactiveTrip(currentTripData);
      const confirmed = await confirmationDialog.show({
        title: nextInactive ? "Mark Trip Inactive" : "Restore Trip",
        message: nextInactive
          ? "Keep this trip in history but exclude it from totals, maps, gas, routes, and coverage?"
          : "Restore this trip to totals, maps, gas, routes, and coverage again?",
        confirmText: nextInactive ? "Mark Inactive" : "Restore",
        confirmButtonClass: nextInactive ? "btn-warning" : "btn-primary",
      });
      if (confirmed) {
        await pageActions.toggleTripInactive(
          currentTripData.transactionId,
          nextInactive
        );
      }
    });
  }

  if (regeocodeBtn) {
    regeocodeBtn.type = "button";
    bindPageEvent(regeocodeBtn, "click", () => regeocodeCurrentTrip());
  }

  const subtleRegeocodeBtn = document.getElementById("modal-regeocode-subtle-btn");
  if (subtleRegeocodeBtn) {
    bindPageEvent(subtleRegeocodeBtn, "click", () => regeocodeCurrentTrip());
  }

  const matchToggle = document.getElementById("trip-modal-matched-toggle");
  if (matchToggle) {
    bindPageEvent(matchToggle, "change", () => {
      if (currentTripData) {
        renderTripOnMap(currentTripData);
      }
    });
  }

  modalActionsBound = true;
}

function updateRegeocodeControls(trip) {
  const wrap = document.getElementById("modal-route-actions");
  const btn = document.getElementById("modal-regeocode-btn");
  const statusEl = document.getElementById("modal-regeocode-status");
  const subtleBtn = document.getElementById("modal-regeocode-subtle-btn");

  const tripId = trip?.transactionId || null;
  if (!regeocodeInFlight && tripId && tripId !== modalRouteActionsTripId) {
    modalRouteActionsTripId = tripId;
    if (statusEl) {
      statusEl.textContent = "";
    }
  }

  const startLoc = sanitizeLocation(trip?.startLocation);
  const endLoc = sanitizeLocation(trip?.destination);
  const needsGeocode = startLoc === "Unknown" || endLoc === "Unknown";

  // Prominent button — only for missing addresses
  if (wrap && btn) {
    wrap.style.display = needsGeocode ? "flex" : "none";
    if (needsGeocode) {
      btn.disabled = regeocodeInFlight;
      btn.classList.toggle("is-loading", regeocodeInFlight);

      const textEl = btn.querySelector(".btn-route-action__text");
      if (textEl) {
        textEl.textContent = regeocodeInFlight ? "Geocoding..." : "Geocode this trip";
      }

      if (statusEl && !regeocodeInFlight && !statusEl.textContent) {
        statusEl.textContent = "Addresses are missing. Click to geocode this trip.";
      }
    } else if (statusEl) {
      statusEl.textContent = "";
    }
  }

  // Subtle button in section title — always available
  if (subtleBtn) {
    subtleBtn.disabled = regeocodeInFlight;
    subtleBtn.classList.toggle("is-loading", regeocodeInFlight);
    subtleBtn.title = regeocodeInFlight ? "Geocoding..." : "Re-geocode addresses";
  }
}

async function regeocodeCurrentTrip() {
  const tripId = currentTripData?.transactionId || currentTripId;
  if (!tripId || regeocodeInFlight) {
    return;
  }

  const btn = document.getElementById("modal-regeocode-btn");
  const statusEl = document.getElementById("modal-regeocode-status");
  const textEl = btn?.querySelector(".btn-route-action__text");

  try {
    regeocodeInFlight = true;
    if (btn) {
      btn.disabled = true;
      btn.classList.add("is-loading");
    }
    if (textEl) {
      textEl.textContent = "Geocoding...";
    }
    if (statusEl) {
      statusEl.textContent = "Running geocoder for this trip...";
    }

    const resp = await apiPost(CONFIG.API.tripRegeocode(tripId), {});
    notificationManager.show(resp?.message || "Trip geocoded", "success");
    if (statusEl) {
      statusEl.textContent = resp?.message || "Geocoding finished. Refreshing trip...";
    }

    await loadTripData(tripId);
  } catch (err) {
    console.error("Failed to geocode trip:", err);
    notificationManager.show(
      err?.message ? `Geocode failed: ${err.message}` : "Failed to geocode trip",
      "danger"
    );
    if (statusEl) {
      statusEl.textContent = err?.message || "Failed to geocode trip.";
    }
  } finally {
    regeocodeInFlight = false;
    updateRegeocodeControls(currentTripData);
  }
}

function showShareModal() {
  const shareData = buildTripShareData(currentTripData);

  // Detect mobile/touch devices (iOS, Android, etc.)
  const isMobile =
    /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints && navigator.maxTouchPoints > 1);

  // Use native share on mobile devices (iOS share sheet, Android share, etc.)
  if (navigator.share && isMobile) {
    navigator
      .share(shareData)
      .then(() => {
        notificationManager.show("Shared successfully", "success");
      })
      .catch((err) => {
        // User cancelled - don't show error
        if (isAbortError(err)) {
          return;
        }
        // Native share failed, use copy modal
        console.warn("Native share failed, showing copy modal:", err);
        displayShareModalUI(shareData);
      });
    return;
  }

  // Desktop: show copy modal
  displayShareModalUI(shareData);
}

function displayShareModalUI(shareData) {
  const existingModal = document.getElementById("shareModal");
  if (existingModal) {
    existingModal.remove();
  }

  const modal = document.createElement("div");
  modal.className = "modal fade";
  modal.id = "shareModal";
  modal.tabIndex = -1;
  modal.innerHTML = `
    <div class="modal-dialog modal-dialog-centered modal-sm">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title">
            <i class="fas fa-share-alt me-2"></i>Share Trip
          </h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
        </div>
        <div class="modal-body">
          <p class="share-description text-muted mb-3">${escapeHtml(shareData.text)}</p>
          <div class="share-url-container">
            <input type="text" class="form-control share-url-input" id="share-url-input" value="${escapeHtml(shareData.url)}" readonly>
            <button class="btn btn-primary copy-btn" type="button" id="copy-share-url">
              <i class="fas fa-copy me-2"></i>Copy Link
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const shareModal = new bootstrap.Modal(modal);

  const copyBtn = modal.querySelector("#copy-share-url");
  const urlInput = modal.querySelector("#share-url-input");

  // Select all text when input is focused
  bindPageEvent(urlInput, "focus", () => urlInput.select());

  bindPageEvent(copyBtn, "click", async () => {
    try {
      await navigator.clipboard.writeText(shareData.url);
      copyBtn.innerHTML = '<i class="fas fa-check me-2"></i>Copied!';
      copyBtn.classList.remove("btn-primary");
      copyBtn.classList.add("btn-success");
      notificationManager.show("Link copied to clipboard", "success");
      setTimeout(() => {
        shareModal.hide();
      }, 1000);
    } catch {
      // Default for older browsers
      urlInput.select();
      urlInput.setSelectionRange(0, 99999);
      document.execCommand("copy");
      notificationManager.show("Link copied to clipboard", "success");
      setTimeout(() => {
        shareModal.hide();
      }, 1000);
    }
  });

  modal.addEventListener("hidden.bs.modal", () => modal.remove(), {
    once: true,
  });
  pageSignal?.addEventListener(
    "abort",
    () => {
      try {
        shareModal.hide();
      } finally {
        modal.remove();
      }
    },
    { once: true }
  );

  shareModal.show();
}

function buildTripShareData(trip) {
  const id = trip?.transactionId || currentTripId;
  const distance = trip?.distance ? `${parseFloat(trip.distance).toFixed(1)} mi` : null;
  const start = sanitizeLocation(trip?.startLocation);
  const end = sanitizeLocation(trip?.destination);

  let text = "Check out this trip.";
  if (distance && start && end && start !== "--" && end !== "--") {
    text = `${distance} from ${start} to ${end}`;
  } else if (distance) {
    text = `${distance} trip`;
  }

  return {
    title: trip ? generateSmartTitle(trip) : "Every Street Trip",
    text,
    url: id
      ? `${window.location.origin}/trips/${encodeURIComponent(id)}`
      : `${window.location.origin}/trips`,
  };
}

function initTripModalMap() {
  if (tripModalMap) {
    return Promise.resolve(tripModalMap);
  }
  if (tripModalMapInitPromise) {
    return tripModalMapInitPromise;
  }

  const mapContainer = document.getElementById("trip-modal-map");
  if (!mapContainer) {
    return Promise.resolve(null);
  }

  const onMapReady = () => {
    setupTripPlaybackControls();
    if (currentTripId) {
      loadTripData(currentTripId);
    }
  };

  tripModalMapInitPromise = (async () => {
    try {
      if (isGoogleMapProvider()) {
        await waitForGoogleMaps();
        const maps = getGoogleMapsApi();
        if (!maps) {
          throw new Error("Google Maps JS is not loaded");
        }

        mapContainer.replaceChildren();
        tripModalMap = new maps.Map(mapContainer, {
          zoom: 3,
          center: { lng: -98.57, lat: 39.82 },
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
        });

        maps.event.addListenerOnce(tripModalMap, "idle", onMapReady);
        return tripModalMap;
      }

      tripModalMap = createMap("trip-modal-map", {
        zoom: 1,
        center: [-98.57, 39.82],
      });

      tripModalMap.on("load", () => {
        const { primary, success, stroke } = getTripUiColors();
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
            "line-color": primary,
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
              "line-color": success,
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
              "circle-radius": 8,
              "circle-color": primary,
              "circle-opacity": 0.9,
              "circle-stroke-width": 3,
              "circle-stroke-color": stroke,
            },
          });
        }

        onMapReady();
      });

      return tripModalMap;
    } catch (e) {
      console.error("Failed to init modal map:", e);
      mapContainer.innerHTML =
        '<div style="padding: 20px; color: var(--danger);">Failed to load map.</div>';
      tripModalMap = null;
      return null;
    } finally {
      tripModalMapInitPromise = null;
    }
  })();

  return tripModalMapInitPromise;
}

async function loadTripData(tripId) {
  const loadingEl = document.getElementById("trip-map-loading");
  loadingEl?.classList.remove("d-none");

  try {
    const data = await apiGet(CONFIG.API.tripById(tripId));
    // Guard against a stale response after the user switched to another trip.
    if (currentTripId !== tripId) {
      return;
    }
    const { trip } = data;
    currentTripData = trip;

    // Show/hide matched toggle based on if matchedGps exists
    const toggleContainer = document.querySelector(".trip-layer-toggle");
    if (toggleContainer) {
      const hasMatched = Boolean(trip.matchedGps);
      if (hasMatched) {
        toggleContainer.classList.remove("d-none");
        toggleContainer.classList.add("d-flex");
      } else {
        toggleContainer.classList.add("d-none");
        toggleContainer.classList.remove("d-flex");
      }
    }

    updateModalContent(trip);

    renderTripOnMap(trip);
  } catch (err) {
    if (currentTripId !== tripId || err?.name === "AbortError" || pageSignal?.aborted) {
      return;
    }
    if (err?.status === 404) {
      currentTripData = null;
      clearTripModalRouteData();
      moveFocusOutOfModal(tripModalElement, { preferredTarget: modalReturnFocus });
      tripModalInstance?.hide();
      notificationManager.show("This trip is no longer available.", "warning");
      return;
    }
    console.error("Failed to load trip data:", err);
    notificationManager.show("Failed to load trip details", "danger");
  } finally {
    loadingEl?.classList.add("d-none");
  }
}

function updateModalContent(trip) {
  const title = generateSmartTitle(trip);

  const titleEl = document.getElementById("tripModalTitle");
  const dateEl = document.getElementById("modal-date");
  const tripIdEl = document.getElementById("modal-trip-id");

  if (titleEl) {
    titleEl.textContent = title;
  }
  if (dateEl) {
    dateEl.textContent = formatDateTime(trip.startTime);
  }
  if (tripIdEl) {
    tripIdEl.textContent = trip.transactionId;
  }

  updateInactiveTripControls(trip);

  const distanceEl = document.getElementById("modal-distance");
  const durationEl = document.getElementById("modal-duration");
  const speedEl = document.getElementById("modal-max-speed");
  const fuelEl = document.getElementById("modal-fuel");
  const costEl = document.getElementById("modal-cost");
  const startEl = document.getElementById("modal-start-loc");
  const endEl = document.getElementById("modal-end-loc");

  if (distanceEl) {
    const distance = toFiniteNumber(trip.distance);
    distanceEl.textContent = distance === null ? "--" : `${distance.toFixed(2)} mi`;
  }
  if (durationEl) {
    const duration = toFiniteNumber(trip.duration);
    durationEl.textContent = duration === null ? "--" : formatDuration(duration);
  }
  if (speedEl) {
    const maxSpeed = toFiniteNumber(trip.maxSpeed);
    speedEl.textContent = maxSpeed === null ? "--" : `${Math.round(maxSpeed)} mph`;
  }
  if (fuelEl) {
    const fuel = toFiniteNumber(trip.fuelConsumed);
    fuelEl.textContent = fuel === null ? "--" : `${fuel.toFixed(2)} gal`;
  }
  if (costEl) {
    costEl.textContent = formatCurrency(trip.estimated_cost);
  }
  if (startEl) {
    const startLoc = sanitizeLocation(trip.startLocation);
    startEl.textContent = startLoc;
    startEl.classList.toggle("unknown", startLoc === "Unknown");
  }
  if (endEl) {
    const endLoc = sanitizeLocation(trip.destination);
    endEl.textContent = endLoc;
    endEl.classList.toggle("unknown", endLoc === "Unknown");
  }

  void updateTripRouteChip(trip);
  updateRegeocodeControls(trip);
}

function updateInactiveTripControls(trip) {
  const inactive = isInactiveTrip(trip);
  const statePill = document.getElementById("modal-trip-state-pill");
  const inactiveNote = document.getElementById("modal-trip-inactive-note");
  const inactiveBtn = document.getElementById("modal-inactive-toggle-btn");

  if (statePill) {
    statePill.hidden = !inactive;
  }
  if (inactiveNote) {
    inactiveNote.style.display = inactive ? "flex" : "none";
  }
  if (inactiveBtn) {
    inactiveBtn.title = inactive
      ? "Restore this trip to app totals"
      : "Exclude this trip from app totals";
    inactiveBtn.setAttribute(
      "aria-label",
      inactive ? "Restore trip" : "Mark trip inactive"
    );
    inactiveBtn.classList.toggle("is-active", inactive);
    inactiveBtn.innerHTML = `
      <i class="fas ${inactive ? "fa-rotate-left" : "fa-eye-slash"}"></i>
    `;
  }
}

function normalizeMongoId(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    const cleaned = value.trim();
    return cleaned ? cleaned : null;
  }
  if (typeof value === "object") {
    if (typeof value.$oid === "string" && value.$oid.trim()) {
      return value.$oid.trim();
    }
    if (typeof value.toString === "function") {
      const rendered = value.toString();
      if (typeof rendered === "string") {
        const cleaned = rendered.trim();
        if (cleaned && cleaned !== "[object Object]") {
          return cleaned;
        }
      }
    }
  }
  return null;
}

async function updateTripRouteChip(trip) {
  const tagsEl = document.getElementById("modal-tags");
  const sectionEl = document.getElementById("modal-route-chip-section");
  if (!tagsEl) {
    return;
  }

  tagsEl.innerHTML = "";
  if (isInactiveTrip(trip)) {
    if (sectionEl) {
      sectionEl.style.display = "none";
    }
    return;
  }

  const routeId = normalizeMongoId(trip?.recurringRouteId);
  if (!routeId) {
    if (sectionEl) {
      sectionEl.style.display = "none";
    }
    return;
  }

  if (sectionEl) {
    sectionEl.style.display = "";
  }

  const token = ++modalRouteChipToken;

  const chip = document.createElement("a");
  chip.className = "trip-tag";
  chip.href = `/routes/${encodeURIComponent(routeId)}`;
  chip.textContent = "Route: ...";
  bindPageEvent(chip, "click", () => {
    try {
      tripModalInstance?.hide();
    } catch {
      // Best-effort: navigation will still work.
    }
  });

  tagsEl.appendChild(chip);

  try {
    const resp = await apiGet(`/api/recurring_routes/${encodeURIComponent(routeId)}`);
    if (token !== modalRouteChipToken) {
      return;
    }
    const route = resp?.route || resp;
    const displayName = (
      route?.display_name ||
      route?.displayName ||
      route?.name ||
      route?.auto_name ||
      route?.autoName ||
      ""
    ).trim();
    chip.textContent = displayName ? `Route: ${displayName}` : "Route";
  } catch {
    if (token !== modalRouteChipToken) {
      return;
    }
    chip.textContent = "Route: (unavailable)";
  }
}

function renderTripOnMap(trip) {
  const geometry = extractTripGeometry(trip);
  if (!geometry) {
    clearTripModalRouteData();
    return;
  }

  if (isGoogleMapProvider()) {
    const maps = getGoogleMapsApi();
    if (!tripModalMap || !maps) {
      return;
    }

    const { primary } = getTripUiColors();
    if (!googleModalState.routePolyline) {
      googleModalState.routePolyline = new maps.Polyline({
        map: tripModalMap,
        geodesic: true,
        strokeColor: primary,
        strokeWeight: 4,
        strokeOpacity: 0.9,
      });
    }

    if (geometry.type === "LineString") {
      googleModalState.routePolyline.setPath(toGooglePath(geometry.coordinates));
    } else if (geometry.type === "Point") {
      const pointPath = toGooglePath([geometry.coordinates]);
      googleModalState.routePolyline.setPath(pointPath);
    } else {
      googleModalState.routePolyline.setPath([]);
    }
  } else {
    if (!tripModalMap?.isStyleLoaded()) {
      setTimeout(() => renderTripOnMap(trip), 200);
      return;
    }

    const geojson = {
      type: "Feature",
      geometry,
      properties: {},
    };

    const src = tripModalMap.getSource("modal-trip");
    if (src) {
      src.setData({ type: "FeatureCollection", features: [geojson] });
    }
  }

  setPlaybackRoute(geometry);

  if (geometry.type === "LineString" && geometry.coordinates.length >= 2) {
    const startCoord = geometry.coordinates[0];
    const endCoord = geometry.coordinates[geometry.coordinates.length - 1];
    updateTripEndpointMarkers(startCoord, endCoord);
  } else {
    updateTripEndpointMarkers(null, null);
  }

  if (isGoogleMapProvider()) {
    const maps = getGoogleMapsApi();
    if (!tripModalMap || !maps) {
      return;
    }

    const bounds = new maps.LatLngBounds();
    let hasBounds = false;

    if (geometry.type === "LineString") {
      for (const coord of geometry.coordinates) {
        const latLng = toGoogleLatLng(coord);
        if (!latLng) {
          continue;
        }
        bounds.extend(latLng);
        hasBounds = true;
      }
    } else if (geometry.type === "Point") {
      const latLng = toGoogleLatLng(geometry.coordinates);
      if (latLng) {
        bounds.extend(latLng);
        hasBounds = true;
      }
    }

    if (hasBounds) {
      resizeTripModalMap();
      tripModalMap.fitBounds(bounds, 100);
    }
    return;
  }

  const mapbox = globalThis?.mapboxgl;
  if (!mapbox?.LngLatBounds) {
    return;
  }

  const bounds = new mapbox.LngLatBounds();
  const coords = geometry.coordinates;
  if (geometry.type === "LineString") {
    coords.forEach((c) => bounds.extend(c));
  } else if (geometry.type === "Point") {
    bounds.extend(coords);
  }

  if (!bounds.isEmpty()) {
    resizeTripModalMap();
    tripModalMap.fitBounds(bounds, {
      padding: 100,
      duration: 1000,
      essential: true,
    });
  }
}

function createTripEndpointMarker(label, variant) {
  const markerEl = document.createElement("div");
  markerEl.className = `trip-route-marker trip-route-marker--${variant}`;
  markerEl.innerHTML = `
    <div class="trip-route-marker__label">${label}</div>
    <div class="trip-route-marker__dot"></div>
  `;
  return markerEl;
}

function createGoogleEndpointMarker(label, variant) {
  const maps = getGoogleMapsApi();
  if (!maps || !tripModalMap) {
    return null;
  }

  const { primary, success, stroke } = getTripUiColors();
  const fillColor = variant === "start" ? success : primary;

  return new maps.Marker({
    map: tripModalMap,
    title: label,
    label: {
      text: variant === "start" ? "S" : "E",
      color: stroke,
      fontSize: "10px",
      fontWeight: "700",
    },
    icon: {
      path: maps.SymbolPath.CIRCLE,
      scale: 9,
      fillColor,
      fillOpacity: 1,
      strokeColor: stroke,
      strokeWeight: 2,
    },
  });
}

function updateTripEndpointMarkers(startCoord, endCoord) {
  if (!tripModalMap) {
    return;
  }

  const updateMarker = (coord, key, variant, label) => {
    if (!Array.isArray(coord) || coord.length < 2) {
      removeMapMarker(playbackState[key]);
      playbackState[key] = null;
      return;
    }

    if (!playbackState[key]) {
      if (isGoogleMapProvider()) {
        playbackState[key] = createGoogleEndpointMarker(label, variant);
      } else {
        const markerEl = createTripEndpointMarker(label, variant);
        const mapbox = globalThis?.mapboxgl;
        if (!mapbox?.Marker) {
          return;
        }
        playbackState[key] = new mapbox.Marker({
          element: markerEl,
          anchor: "bottom",
        });
      }
    }

    if (!playbackState[key]) {
      return;
    }

    setMapMarkerPosition(playbackState[key], coord);
  };

  updateMarker(startCoord, "startMarker", "start", "Started");
  updateMarker(endCoord, "endMarker", "end", "Ended");
}

function extractTripGeometry(trip) {
  if (!trip) {
    return null;
  }

  const toggle = document.getElementById("trip-modal-matched-toggle");
  const wantMatched = toggle ? toggle.checked : true;

  const candidate = wantMatched
    ? trip.matchedGps || trip.geometry || trip.gps
    : trip.gps || trip.geometry || trip.matchedGps;

  if (!candidate) {
    return null;
  }

  let parsed = candidate;
  if (typeof candidate === "string") {
    try {
      parsed = JSON.parse(candidate);
    } catch {
      return null;
    }
  }

  if (parsed?.type === "Feature") {
    parsed = parsed.geometry;
  }

  if (!parsed || !parsed.type || !parsed.coordinates) {
    return null;
  }

  return parsed;
}

// ==========================================
// PLAYBACK CONTROLS
// ==========================================

function setupTripPlaybackControls() {
  if (playbackControlsBound) {
    return;
  }

  const playBtn = document.getElementById("trip-playback-toggle");
  const speedInput = document.getElementById("trip-playback-speed");
  const speedLabel = document.getElementById("trip-playback-speed-label");

  const updateSpeedLabel = () => {
    if (!speedLabel) {
      return;
    }
    speedLabel.textContent = `${getPlaybackSpeedMultiplier().toFixed(1)}x`;
  };

  if (playBtn) {
    bindPageEvent(playBtn, "click", () => {
      if (playbackState.isPlaying) {
        pausePlayback();
      } else if (playbackState.isComplete) {
        // Replay from beginning
        resetPlayback();
        playbackState.isComplete = false;
        startPlayback();
      } else {
        startPlayback();
      }
      updatePlaybackUI();
    });
  }

  if (speedInput) {
    playbackState.speed = Number(speedInput.value) || PLAYBACK_SPEED_BASE;
    updateSpeedLabel();
    bindPageEvent(speedInput, "input", () => {
      playbackState.speed = Number(speedInput.value) || PLAYBACK_SPEED_BASE;
      updateSpeedLabel();
    });
  }

  playbackControlsBound = true;
  updatePlaybackUI();
}

function getPlaybackSpeedMultiplier() {
  const speedValue =
    Number.isFinite(playbackState.speed) && playbackState.speed > 0
      ? playbackState.speed
      : PLAYBACK_SPEED_BASE;
  return speedValue / PLAYBACK_SPEED_BASE;
}

function setPlaybackRoute(geometry) {
  if (!geometry || geometry.type !== "LineString") {
    playbackState.coords = [];
    playbackState.progress = 0;
    updatePlaybackTrail([]);
    updatePlaybackHead(null);
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
  playbackState.isComplete = false;

  // Create custom pulsing marker if not exists
  if (!playbackState.marker) {
    if (isGoogleMapProvider()) {
      const maps = getGoogleMapsApi();
      if (maps) {
        const { primary, stroke } = getTripUiColors();
        playbackState.marker = new maps.Marker({
          map: tripModalMap,
          clickable: false,
          zIndex: 50,
          icon: {
            path: maps.SymbolPath.CIRCLE,
            scale: 8,
            fillColor: primary,
            fillOpacity: 0.95,
            strokeColor: stroke,
            strokeWeight: 2,
          },
        });
      }
    } else {
      const markerEl = document.createElement("div");
      markerEl.className = "playback-marker";
      markerEl.innerHTML = `
        <div class="playback-marker-inner"></div>
        <div class="playback-marker-pulse"></div>
      `;
      const mapbox = globalThis?.mapboxgl;
      if (mapbox?.Marker) {
        playbackState.marker = new mapbox.Marker({
          element: markerEl,
          anchor: "center",
        });
      }
    }
  }

  if (!playbackState.marker) {
    return;
  }

  const step = () => {
    if (!playbackState.isPlaying) {
      return;
    }

    playbackState.progress += getPlaybackSpeedMultiplier() * PLAYBACK_STEP_PER_FRAME;
    const index = Math.min(
      playbackState.coords.length - 1,
      Math.floor(playbackState.progress)
    );
    const coord = playbackState.coords[index];

    if (!coord) {
      completePlayback();
      return;
    }

    setMapMarkerPosition(playbackState.marker, coord);
    if (isGoogleMapProvider()) {
      const center = toGoogleLatLng(coord);
      if (center) {
        tripModalMap.setCenter(center);
      }
    } else {
      tripModalMap.setCenter(coord);
    }
    updatePlaybackHead(coord);
    updatePlaybackTrail(playbackState.coords.slice(0, index + 1));

    if (index >= playbackState.coords.length - 1) {
      completePlayback();
      return;
    }

    playbackState.frame = requestAnimationFrame(step);
  };

  playbackState.frame = requestAnimationFrame(step);
}

function completePlayback() {
  pausePlayback();
  playbackState.isComplete = true;
  updatePlaybackUI();
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
  removeMapMarker(playbackState.marker);
  playbackState.marker = null;
}

function updatePlaybackHead(coord) {
  if (!tripModalMap) {
    return;
  }

  if (isGoogleMapProvider()) {
    const maps = getGoogleMapsApi();
    if (!maps) {
      return;
    }

    if (!coord) {
      removeMapMarker(googleModalState.headMarker);
      googleModalState.headMarker = null;
      return;
    }

    if (!googleModalState.headMarker) {
      const { primary, stroke } = getTripUiColors();
      googleModalState.headMarker = new maps.Marker({
        map: tripModalMap,
        clickable: false,
        zIndex: 40,
        icon: {
          path: maps.SymbolPath.CIRCLE,
          scale: 6,
          fillColor: primary,
          fillOpacity: 0.9,
          strokeColor: stroke,
          strokeWeight: 2,
        },
      });
    }

    setMapMarkerPosition(googleModalState.headMarker, coord);
    return;
  }

  if (!tripModalMap?.getSource(playbackState.headSourceId)) {
    return;
  }

  const feature = coord
    ? { type: "Feature", geometry: { type: "Point", coordinates: coord } }
    : null;

  const data = feature
    ? { type: "FeatureCollection", features: [feature] }
    : { type: "FeatureCollection", features: [] };

  tripModalMap.getSource(playbackState.headSourceId).setData(data);
}

function updatePlaybackTrail(coords) {
  if (!tripModalMap) {
    return;
  }

  if (isGoogleMapProvider()) {
    const maps = getGoogleMapsApi();
    if (!maps) {
      return;
    }
    if (!googleModalState.trailPolyline) {
      const { success } = getTripUiColors();
      googleModalState.trailPolyline = new maps.Polyline({
        map: tripModalMap,
        geodesic: true,
        strokeColor: success,
        strokeWeight: 3,
        strokeOpacity: 0.6,
      });
    }
    googleModalState.trailPolyline.setPath(toGooglePath(coords));
    return;
  }

  if (!tripModalMap?.getSource(playbackState.trailSourceId)) {
    return;
  }

  const data = coords.length
    ? {
        type: "FeatureCollection",
        features: [
          { type: "Feature", geometry: { type: "LineString", coordinates: coords } },
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
  const span = playBtn.querySelector("span");

  if (playbackState.isPlaying) {
    playBtn.classList.add("is-playing");
    playBtn.classList.remove("is-complete");
    playBtn.setAttribute("aria-pressed", "true");
    if (icon) {
      icon.className = "fas fa-pause";
    }
    if (span) {
      span.textContent = "Pause";
    }
  } else if (playbackState.isComplete) {
    playBtn.classList.remove("is-playing");
    playBtn.classList.add("is-complete");
    playBtn.setAttribute("aria-pressed", "false");
    if (icon) {
      icon.className = "fas fa-redo";
    }
    if (span) {
      span.textContent = "Replay";
    }
  } else {
    playBtn.classList.remove("is-playing", "is-complete");
    playBtn.setAttribute("aria-pressed", "false");
    if (icon) {
      icon.className = "fas fa-play";
    }
    if (span) {
      span.textContent = "Play";
    }
  }
}
