/* global bootstrap, mapboxgl, dayjs */
/**
 * Trips Page - Modern Travel Journal
 * Card-based trip display with timeline grouping and smart features
 */

import apiClient from "../../core/api-client.js";
import { CONFIG } from "../../core/config.js";
import store, { optimisticAction } from "../../core/store.js";
import { createMap } from "../../map-base.js";
import { initTripSync } from "../../trip-sync.js";
import confirmationDialog from "../../ui/confirmation-dialog.js";
import notificationManager from "../../ui/notifications.js";
import {
  DateUtils,
  escapeHtml,
  formatDateTime,
  formatDuration,
  formatVehicleName,
  getStorage,
  sanitizeLocation,
  setStorage,
} from "../../utils.js";

// State management
let tripsData = [];
let filteredTrips = [];
let currentPage = 1;
const pageSize = 25;
let totalTrips = 0;
let datatableDraw = 0;
const selectedTripIds = new Set();
let isLoading = false;
let tripModalMap = null;
let tripModalInstance = null;
let currentTripId = null;
let currentTripData = null;
let playbackControlsBound = false;
let modalActionsBound = false;
let pageSignal = null;

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
  startSourceId: "modal-trip-start",
  startLayerId: "modal-trip-start-point",
  endSourceId: "modal-trip-end",
  endLayerId: "modal-trip-end-point",
};

const PLAYBACK_SPEED_BASE = 0.5;
const PLAYBACK_STEP_PER_FRAME = 0.05;

const withSignal = (options = {}) =>
  pageSignal ? { ...options, signal: pageSignal } : options;
const apiGet = (url, options = {}) => apiClient.get(url, withSignal(options));
const apiPost = (url, body, options = {}) =>
  apiClient.post(url, body, withSignal(options));
const apiDelete = (url, options = {}) => apiClient.delete(url, withSignal(options));

function resetTripsState() {
  tripsData = [];
  filteredTrips = [];
  currentPage = 1;
  totalTrips = 0;
  datatableDraw = 0;
  selectedTripIds.clear();
  isLoading = false;
  currentTripId = null;
  currentTripData = null;
  playbackControlsBound = false;
  modalActionsBound = false;

  pausePlayback();
  if (playbackState.marker) {
    try {
      playbackState.marker.remove();
    } catch {
      // Ignore marker cleanup errors.
    }
    playbackState.marker = null;
  }
  if (playbackState.startMarker) {
    try {
      playbackState.startMarker.remove();
    } catch {}
    playbackState.startMarker = null;
  }
  if (playbackState.endMarker) {
    try {
      playbackState.endMarker.remove();
    } catch {}
    playbackState.endMarker = null;
  }
  playbackState.coords = [];
  playbackState.frame = null;
  playbackState.progress = 0;
  playbackState.speed = PLAYBACK_SPEED_BASE;
  playbackState.isPlaying = false;
  playbackState.isComplete = false;

  if (tripModalMap) {
    try {
      tripModalMap.remove();
    } catch {
      // Ignore map cleanup errors.
    }
    tripModalMap = null;
  }
  tripModalInstance = null;
}

export default async function initTripsPage({ signal, cleanup } = {}) {
  const cleanupFns = [];
  const registerCleanup = (fn) => {
    if (typeof fn === "function") {
      cleanupFns.push(fn);
    }
  };

  pageSignal = signal || null;
  resetTripsState();

  try {
    await initializePage(signal, registerCleanup);
  } catch (e) {
    notificationManager.show(`Error loading trips: ${e.message}`, "danger");
    console.error(e);
  }

  registerCleanup(() => {
    pageSignal = null;
    resetTripsState();
  });

  const teardown = () => {
    cleanupFns.forEach((fn) => {
      try {
        fn();
      } catch (error) {
        console.warn("Trips cleanup error", error);
      }
    });
  };

  if (typeof cleanup === "function") {
    cleanup(teardown);
  } else {
    return teardown;
  }
}

async function initializePage(signal, cleanup) {
  // Update greeting based on time
  updateGreeting();

  // Load vehicles for filter dropdown
  await loadVehicles();

  // Restore saved filters before setting up listeners
  restoreSavedFilters();

  // Setup all event listeners
  setupSearchAndFilters();
  setupBulkActions();
  setupTripCardInteractions();

  // Initialize trip sync functionality
  initTripSync({
    onSyncComplete: () => {
      loadTrips();
      loadTripStats();
    },
    onSyncError: () => {
      updateSyncStatus("error");
    },
    cleanup,
  });

  // Listen for date filter changes from global filter panel
  document.addEventListener(
    "filtersApplied",
    () => {
      loadTrips();
    },
    signal ? { signal } : false
  );

  document.addEventListener(
    "es:filters-change",
    (event) => {
      const source = event?.detail?.source;
      if (source !== "filters" && source !== "url") {
        return;
      }
      loadTripStats();
    },
    signal ? { signal } : false
  );

  // Initial data load
  await Promise.all([loadTrips(), loadTripStats()]);

  // Apply any saved filters after data loads
  applySavedFilters();

  // Check if we need to open a specific trip (from URL param)
  if (window.PRELOAD_TRIP_ID) {
    requestAnimationFrame(() => openTripModal(window.PRELOAD_TRIP_ID));
  }
}

function updateOverviewStats({ totalMiles, totalTrips, totalHours }) {
  const milesEl = document.getElementById("stat-total-miles");
  const tripsEl = document.getElementById("stat-total-trips");
  const hoursEl = document.getElementById("stat-total-time");
  const safeMiles = Number.isFinite(Number(totalMiles)) ? Number(totalMiles) : 0;
  const safeTrips = Number.isFinite(Number(totalTrips)) ? Number(totalTrips) : 0;
  const safeHours = Number.isFinite(Number(totalHours)) ? Number(totalHours) : 0;

  if (milesEl) {
    milesEl.textContent = safeMiles.toFixed(1);
  }
  if (tripsEl) {
    tripsEl.textContent = safeTrips;
  }
  if (hoursEl) {
    hoursEl.textContent = safeHours;
  }

  const summaryEl = document.getElementById("trips-summary-text");
  if (summaryEl) {
    const { hasAnyFilters } = getFilterState();
    const milesText = safeMiles.toFixed(1);

    if (hasAnyFilters) {
      summaryEl.innerHTML = `Showing <strong>${safeTrips} trips</strong> totaling <strong>${milesText} miles</strong>`;
    } else {
      summaryEl.innerHTML = `You've traveled <strong>${milesText} miles</strong> across <strong>${safeTrips} trips</strong> this month`;
    }
  }
}

function getStatsQueryFilters() {
  const dateRange = getDateRangeFilters();
  const localFilters = getLocalFilterValues();
  return {
    start_date: dateRange.start_date,
    end_date: dateRange.end_date,
    imei: localFilters.imei,
    distance_min: localFilters.distance_min,
    distance_max: localFilters.distance_max,
  };
}

function restoreSavedFilters() {
  // Restore vehicle filter
  const savedVehicle = getStorage(CONFIG.STORAGE_KEYS.selectedVehicle);
  const vehicleSelect = document.getElementById("trip-filter-vehicle");
  if (savedVehicle && vehicleSelect) {
    vehicleSelect.value = savedVehicle;
    vehicleSelect.classList.add("has-value");
  }
}

function applySavedFilters() {
  const { hasLocalFilters, hasAnyFilters } = getFilterState();

  if (hasLocalFilters) {
    updateFilterChips();

    // Add visual feedback that filters are active
    document.querySelectorAll(".stat-pill").forEach((pill) => {
      pill.classList.add("filtered");
    });
    document.getElementById("trips-filters-panel")?.classList.add("has-filters");
    document.querySelector(".trips-search-section")?.classList.add("has-filters");
    document.getElementById("filters-status")?.style.setProperty("display", "flex");
  }

  if (hasAnyFilters) {
    updateFilteredStats();
  }
}

// ==========================================
// GREETING & WELCOME
// ==========================================

function updateGreeting() {
  const hour = new Date().getHours();
  let greeting = "Good evening";
  let iconHtml = '<i class="fas fa-moon text-info"></i>';

  if (hour >= 5 && hour < 12) {
    greeting = "Good morning";
    iconHtml = '<i class="fas fa-sun text-warning"></i>';
  } else if (hour >= 12 && hour < 17) {
    greeting = "Good afternoon";
    iconHtml = '<i class="fas fa-hand-paper text-primary"></i>';
  }

  const greetingText = document.querySelector(".greeting-text");
  const greetingIcon = document.querySelector(".greeting-icon");

  if (greetingText) {
    greetingText.textContent = greeting;
  }
  if (greetingIcon) {
    greetingIcon.innerHTML = iconHtml;
  }
}

// ==========================================
// SMART TITLE GENERATION
// ==========================================

function getLocationText(location) {
  const text = sanitizeLocation(location);
  if (!text || text === "Unknown" || text === "--") {
    return "";
  }
  return text;
}

function generateSmartTitle(trip) {
  const distance = parseFloat(trip.distance) || 0;
  const startLocText = getLocationText(trip.startLocation);
  const endLocText = getLocationText(trip.destination);
  const startLoc = startLocText.toLowerCase();
  const endLoc = endLocText.toLowerCase();
  const startTime = new Date(trip.startTime);
  const hour = startTime.getHours();
  const day = startTime.getDay();

  // Determine trip characteristics
  const isWeekend = day === 0 || day === 6;
  const isEvening = hour >= 17;
  const isMorning = hour >= 6 && hour < 12;
  const isShort = distance < 5;
  const isLong = distance > 50;
  const isCommute =
    (startLoc.includes("home") && endLoc.includes("work")) ||
    (startLoc.includes("work") && endLoc.includes("home")) ||
    (startLoc.includes("home") && endLoc.includes("office")) ||
    (startLoc.includes("office") && endLoc.includes("home"));

  // Smart title logic
  if (isCommute) {
    return isMorning ? "Morning Commute" : "Evening Commute";
  }

  if (isShort) {
    return "Quick Trip";
  }

  if (isLong) {
    return "Long Drive";
  }

  if (isWeekend && distance > 10) {
    return "Weekend Adventure";
  }

  if (isEvening && distance > 5) {
    return "Evening Drive";
  }

  // Use destination if available
  if (endLocText) {
    const dest = endLocText.split(",")[0];
    if (dest && dest.length < 30) {
      return `Trip to ${dest}`;
    }
  }

  return "Trip";
}

function getTripBadges(trip, allTrips) {
  const badges = [];
  const distance = parseFloat(trip.distance) || 0;

  // Check if it's among the longest trips
  const distances = allTrips.map((t) => parseFloat(t.distance) || 0);
  const maxDistance = Math.max(...distances);
  if (distance === maxDistance && distance > 10) {
    badges.push({ text: "Longest", class: "new" });
  }

  // Check for frequent route
  const sameRouteCount = allTrips.filter(
    (t) => t.startLocation === trip.startLocation && t.destination === trip.destination
  ).length;
  if (sameRouteCount > 3) {
    badges.push({ text: "Frequent", class: "frequent" });
  }

  return badges;
}

// ==========================================
// VEHICLE LOADING
// ==========================================

async function loadVehicles() {
  const vehicleSelect = document.getElementById("trip-filter-vehicle");
  if (!vehicleSelect) {
    return;
  }

  try {
    const vehicles = await apiGet(`${CONFIG.API.vehicles}?active_only=true`);
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
  } catch (err) {
    console.warn("Failed to load vehicles:", err);
  }
}

// ==========================================
// STATS LOADING
// ==========================================

async function loadTripStats() {
  try {
    const statsFilters = getStatsQueryFilters();
    if (statsFilters.distance_min || statsFilters.distance_max) {
      updateFilteredStats();
      return;
    }

    const params = new URLSearchParams();
    if (statsFilters.start_date) {
      params.set("start_date", statsFilters.start_date);
    }
    if (statsFilters.end_date) {
      params.set("end_date", statsFilters.end_date);
    }
    if (statsFilters.imei) {
      params.set("imei", statsFilters.imei);
    }

    if (!params.toString()) {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      params.set("start_date", DateUtils.formatDateToString(startOfMonth));
      params.set("end_date", DateUtils.formatDateToString(now));
    }

    const [metricsResult, insightsResult] = await Promise.allSettled([
      apiGet(`${CONFIG.API.tripMetrics}?${params}`),
      apiGet(`${CONFIG.API.drivingInsights}?${params}`),
    ]);

    if (metricsResult.status === "rejected") {
      console.warn("Failed to load trip metrics:", metricsResult.reason);
    }
    if (insightsResult.status === "rejected") {
      console.warn("Failed to load trip insights:", insightsResult.reason);
    }

    const metrics = metricsResult.status === "fulfilled" ? metricsResult.value : null;
    const insights =
      insightsResult.status === "fulfilled" ? insightsResult.value : null;

    if (!metrics && !insights) {
      return;
    }

    const toNumber = (value, fallback = 0) => {
      if (value === null || value === undefined) {
        return fallback;
      }
      const num = typeof value === "number" ? value : Number.parseFloat(value);
      return Number.isFinite(num) ? num : fallback;
    };

    const totalMiles = toNumber(metrics?.total_distance ?? insights?.total_distance, 0);
    const totalTrips = toNumber(metrics?.total_trips ?? insights?.total_trips, 0);
    const totalHours = Math.round(toNumber(metrics?.total_duration_seconds, 0) / 3600);

    updateOverviewStats({
      totalMiles,
      totalTrips,
      totalHours,
    });

    // Update insight cards
    const longestEl = document.getElementById("insight-longest");
    const fuelEl = document.getElementById("insight-fuel");
    const longestTrip = toNumber(
      insights?.longest_trip_distance ?? insights?.records?.longest_trip?.distance,
      0
    );
    const totalFuel = toNumber(insights?.total_fuel_consumed, 0);

    if (longestEl) {
      longestEl.textContent = longestTrip ? `${longestTrip.toFixed(1)} mi` : "--";
    }
    if (fuelEl) {
      fuelEl.textContent = totalFuel ? `${totalFuel.toFixed(1)} gal` : "--";
    }
  } catch (err) {
    console.warn("Failed to load trip stats:", err);
  }
}

function updateSyncStatus(state) {
  const indicator = document.querySelector(".sync-indicator");
  const text = document.querySelector(".sync-text");
  const btn = document.getElementById("sync-now-btn");

  if (indicator) {
    indicator.setAttribute("data-state", state);
  }

  if (state === "syncing") {
    if (text) {
      text.textContent = "Syncing...";
    }
    if (btn) {
      btn.classList.add("syncing");
    }
  } else if (state === "error") {
    if (text) {
      text.textContent = "Sync failed";
    }
    if (btn) {
      btn.classList.remove("syncing");
    }
  } else {
    if (text) {
      text.textContent = "Up to date";
    }
    if (btn) {
      btn.classList.remove("syncing");
    }
  }
}

// ==========================================
// TRIPS LOADING & RENDERING
// ==========================================

async function loadTrips() {
  if (isLoading) {
    return;
  }

  isLoading = true;
  showLoadingState(true);

  try {
    const filters = getFilterValues();

    const response = await apiPost(CONFIG.API.tripsDataTable, {
      draw: ++datatableDraw,
      start: (currentPage - 1) * pageSize,
      length: pageSize,
      search: { value: "" },
      order: [],
      columns: [],
      filters,
    });

    tripsData = response?.data || [];
    totalTrips =
      response?.recordsFiltered ?? response?.recordsTotal ?? tripsData.length;
    filteredTrips = [...tripsData];

    if (tripsData.length === 0) {
      showEmptyState();
      updateFilteredStats();
      updateFilterResultsPreview();
    } else {
      hideEmptyState();
      renderTripsTimeline(tripsData);
      updatePagination();

      // Update stats based on filtered results
      updateFilteredStats();
      updateFilterResultsPreview();
    }
  } catch (err) {
    console.error("Failed to load trips:", err);
    notificationManager.show("Failed to load trips", "danger");
    showEmptyState();
  } finally {
    isLoading = false;
    showLoadingState(false);
  }
}

function showLoadingState(show) {
  const loadingEl = document.getElementById("trips-loading");
  if (loadingEl) {
    loadingEl.style.display = show ? "block" : "none";
  }
}

function showEmptyState() {
  const emptyEl = document.getElementById("trips-empty");
  const timelineEl = document.getElementById("trips-timeline");
  const paginationEl = document.getElementById("trips-pagination");

  if (emptyEl) {
    emptyEl.style.display = "block";
  }
  if (timelineEl) {
    timelineEl.style.display = "none";
  }
  if (paginationEl) {
    paginationEl.style.display = "none";
  }
}

function hideEmptyState() {
  const emptyEl = document.getElementById("trips-empty");
  const timelineEl = document.getElementById("trips-timeline");
  const paginationEl = document.getElementById("trips-pagination");

  if (emptyEl) {
    emptyEl.style.display = "none";
  }
  if (timelineEl) {
    timelineEl.style.display = "block";
  }
  if (paginationEl) {
    paginationEl.style.display = "flex";
  }
}

// ==========================================
// TIMELINE GROUPING & RENDERING
// ==========================================

function groupTripsByTimeline(trips) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const thisWeekStart = new Date(today);
  thisWeekStart.setDate(thisWeekStart.getDate() - today.getDay());

  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const groups = {
    today: [],
    yesterday: [],
    week: [],
    month: [],
    older: [],
  };

  trips.forEach((trip) => {
    const tripDate = new Date(trip.startTime);

    if (tripDate >= today) {
      groups.today.push(trip);
    } else if (tripDate >= yesterday) {
      groups.yesterday.push(trip);
    } else if (tripDate >= thisWeekStart) {
      groups.week.push(trip);
    } else if (tripDate >= thisMonthStart) {
      groups.month.push(trip);
    } else {
      groups.older.push(trip);
    }
  });

  return groups;
}

function renderTripsTimeline(trips) {
  const groups = groupTripsByTimeline(trips);

  // Hide all sections initially
  document.querySelectorAll(".timeline-section").forEach((section) => {
    section.style.display = "none";
  });

  // Render each group
  Object.entries(groups).forEach(([period, periodTrips]) => {
    const container = document.getElementById(`trips-${period}`);
    const section = container?.closest(".timeline-section");
    const countEl = document.getElementById(`count-${period}`);

    if (container && periodTrips.length > 0) {
      container.innerHTML = "";
      periodTrips.forEach((trip) => {
        const card = createTripCard(trip, trips);
        container.appendChild(card);
      });

      if (section) {
        section.style.display = "block";
      }
      if (countEl) {
        countEl.textContent = `${periodTrips.length} trip${periodTrips.length !== 1 ? "s" : ""}`;
      }
    }
  });
}

function createTripCard(trip, allTrips) {
  const card = document.createElement("div");
  card.className = "trip-card";
  card.dataset.tripId = trip.transactionId;

  if (selectedTripIds.has(trip.transactionId)) {
    card.classList.add("selected");
  }

  // Generate smart content
  const title = generateSmartTitle(trip);
  const badges = getTripBadges(trip, allTrips);
  const distance = parseFloat(trip.distance) || 0;
  const maxDistance =
    Math.max(...allTrips.map((t) => parseFloat(t.distance) || 0)) || 1;
  const progressPercent = Math.min(100, (distance / Math.max(maxDistance, 50)) * 100);

  // Format times
  const duration = trip.duration ? formatDuration(trip.duration) : "--";
  const timeAgo = formatRelativeTime(trip.startTime);

  card.innerHTML = `
    <div class="trip-card-checkbox">
      <input type="checkbox" ${selectedTripIds.has(trip.transactionId) ? "checked" : ""}>
    </div>
    <div class="trip-card-map">
      <svg class="trip-route-line" viewBox="0 0 100 40" preserveAspectRatio="none">
        <path d="M 5,35 Q 25,5 50,20 T 95,15" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <div class="trip-card-content">
      <div class="trip-card-header">
        <h3 class="trip-title">${escapeHtml(title)}</h3>
        ${
          badges.length > 0
            ? `
          <div class="trip-badges">
            ${badges.map((b) => `<span class="trip-badge ${b.class}">${b.text}</span>`).join("")}
          </div>
        `
            : ""
        }
      </div>
      
      <div class="trip-route">
        <i class="fas fa-map-marker-alt"></i>
        <span>${escapeHtml(sanitizeLocation(trip.startLocation))}</span>
        <span class="trip-route-arrow">→</span>
        <span>${escapeHtml(sanitizeLocation(trip.destination))}</span>
      </div>
      
      <div class="trip-progress">
        <div class="trip-progress-bar">
          <div class="trip-progress-fill" style="width: ${progressPercent}%"></div>
        </div>
        <span class="trip-progress-label">${distance.toFixed(1)} miles</span>
      </div>
      
      <div class="trip-meta">
        <span class="trip-meta-item">
          <i class="far fa-clock"></i>
          ${escapeHtml(duration)}
        </span>
        <span class="trip-meta-item">
          <i class="fas fa-tachometer-alt"></i>
          ${trip.maxSpeed ? `${Math.round(trip.maxSpeed)} mph` : "--"}
        </span>
        <span class="trip-meta-item">
          <i class="fas fa-car"></i>
          ${escapeHtml(trip.vehicleLabel || "Unknown")}
        </span>
      </div>
      
      <div class="trip-card-footer">
        <span class="trip-date">${timeAgo}</span>
        <div class="trip-actions">
          <button class="trip-action-btn" title="View details">
            <i class="fas fa-map"></i>
          </button>
          <button class="trip-action-btn delete" title="Delete">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>
    </div>
  `;

  const previewPath = getTripPreviewPath(trip);
  if (previewPath) {
    const routePath = card.querySelector(".trip-route-line path");
    if (routePath) {
      routePath.setAttribute("d", previewPath);
    }
  }

  // Event listeners
  card.addEventListener("click", (e) => {
    if (
      e.target.closest(".trip-card-checkbox") ||
      e.target.closest(".trip-action-btn")
    ) {
      return;
    }
    openTripModal(trip.transactionId);
  });

  const checkbox = card.querySelector(".trip-card-checkbox input");
  checkbox.addEventListener("change", (e) => {
    e.stopPropagation();
    if (e.target.checked) {
      selectedTripIds.add(trip.transactionId);
      card.classList.add("selected");
    } else {
      selectedTripIds.delete(trip.transactionId);
      card.classList.remove("selected");
    }
    updateBulkActionsBar();
  });

  const viewBtn = card.querySelector('.trip-action-btn[title="View details"]');
  viewBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openTripModal(trip.transactionId);
  });

  const deleteBtn = card.querySelector(".trip-action-btn.delete");
  deleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const confirmed = await confirmationDialog.show({
      title: "Delete Trip",
      message: "Are you sure you want to delete this trip?",
      confirmText: "Delete",
      confirmButtonClass: "btn-danger",
    });
    if (confirmed) {
      deleteTrip(trip.transactionId);
    }
  });

  return card;
}

function getTripPreviewPath(trip) {
  const previewPath = trip?.previewPath || trip?.preview_path;
  return sanitizeSvgPath(previewPath);
}

function sanitizeSvgPath(value) {
  if (!value || typeof value !== "string") {
    return null;
  }
  const cleaned = value.trim().replace(/[^0-9MLml.,\s-]/g, "");
  return cleaned.length > 0 ? cleaned : null;
}

function getThemeColor(variable, fallback) {
  if (typeof window === "undefined") {
    return fallback;
  }
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(variable)
    .trim();
  return value || fallback;
}

function getTripUiColors() {
  return {
    primary: getThemeColor("--primary", "#1fb6ad"),
    success: getThemeColor("--success", "#2fb86d"),
    stroke: getThemeColor("--text-primary", "#f2f7fc"),
  };
}

function formatRelativeTime(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) {
    return "Just now";
  }
  if (diffMins < 60) {
    return `${diffMins}m ago`;
  }
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  if (diffDays === 1) {
    return "Yesterday";
  }
  if (diffDays < 7) {
    return `${diffDays} days ago`;
  }

  return formatDateTime(dateStr);
}

// ==========================================
// PAGINATION
// ==========================================

function updatePagination() {
  const textEl = document.getElementById("pagination-text");
  const prevBtn = document.getElementById("prev-page");
  const nextBtn = document.getElementById("next-page");
  const pagesEl = document.getElementById("pagination-pages");

  const totalPages = Math.ceil(totalTrips / pageSize);
  const startIdx = (currentPage - 1) * pageSize + 1;
  const endIdx = Math.min(startIdx + tripsData.length - 1, totalTrips);

  if (textEl) {
    textEl.textContent = `Showing ${startIdx}-${endIdx} of ${totalTrips} trips`;
  }

  if (prevBtn) {
    prevBtn.disabled = currentPage <= 1;
  }
  if (nextBtn) {
    nextBtn.disabled = currentPage >= totalPages;
  }

  if (pagesEl) {
    pagesEl.innerHTML = "";

    const maxVisiblePages = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxVisiblePages / 2));
    const endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);

    if (endPage - startPage < maxVisiblePages - 1) {
      startPage = Math.max(1, endPage - maxVisiblePages + 1);
    }

    for (let i = startPage; i <= endPage; i++) {
      const pageBtn = document.createElement("button");
      pageBtn.className = `page-number ${i === currentPage ? "active" : ""}`;
      pageBtn.textContent = i;
      pageBtn.addEventListener("click", () => {
        currentPage = i;
        loadTrips();
      });
      pagesEl.appendChild(pageBtn);
    }
  }
}

// ==========================================
// SEARCH & FILTERS
// ==========================================

function setupSearchAndFilters() {
  // Search input
  const searchInput = document.getElementById("trip-search-input");
  const searchClear = document.getElementById("search-clear-btn");

  if (searchInput) {
    let searchTimeout;
    searchInput.addEventListener("input", (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        performSearch(e.target.value);
      }, 300);
    });
  }

  if (searchClear) {
    searchClear.addEventListener("click", () => {
      if (searchInput) {
        searchInput.value = "";
      }
      searchClear.style.display = "none";
      performSearch("");
    });
  }

  // Filter toggle
  const filterToggle = document.getElementById("filter-toggle-btn");
  const filtersPanel = document.getElementById("trips-filters-panel");

  if (filterToggle && filtersPanel) {
    filterToggle.addEventListener("click", () => {
      const isOpen = filtersPanel.classList.contains("is-open");

      if (isOpen) {
        filtersPanel.classList.remove("is-open");
        filterToggle.classList.remove("active");
        filterToggle.setAttribute("aria-expanded", "false");
      } else {
        filtersPanel.classList.add("is-open");
        filterToggle.classList.add("active");
        filterToggle.setAttribute("aria-expanded", "true");
      }
    });
  }

  // Apply filters
  document.getElementById("trip-filter-apply")?.addEventListener("click", () => {
    currentPage = 1;
    loadTrips();
    updateFilterChips();
    showFilterFeedback();

    // Update stat cards with filtered data
    updateFilteredStats();

    // Close filters panel on mobile
    if (window.innerWidth < 768 && filtersPanel) {
      filtersPanel.classList.remove("is-open");
      filterToggle?.classList.remove("active");
      filterToggle?.setAttribute("aria-expanded", "false");
    }
  });

  // Reset filters
  document.getElementById("trip-filter-reset")?.addEventListener("click", () => {
    document.querySelectorAll(".filter-select, .filter-group input").forEach((el) => {
      if (el.type === "checkbox") {
        el.checked = false;
      } else {
        el.value = "";
      }
      el.classList.remove("has-value");
    });

    currentPage = 1;
    loadTrips();
    updateFilterChips();
    updateFilteredStats();

    // Reset visual feedback
    document.querySelectorAll(".stat-pill").forEach((pill) => {
      pill.classList.remove("filtered");
    });
    filtersPanel?.classList.remove("has-filters");
    document.querySelector(".trips-search-section")?.classList.remove("has-filters");
    document.getElementById("filters-status")?.style.setProperty("display", "none");
  });

  // Vehicle filter
  document.getElementById("trip-filter-vehicle")?.addEventListener("change", (e) => {
    setStorage(CONFIG.STORAGE_KEYS.selectedVehicle, e.target.value || null);
    store.updateFilters({ vehicle: e.target.value || null }, { source: "vehicle" });
    e.target.classList.toggle("has-value", e.target.value);
  });

  // Distance filters - add has-value class
  ["trip-filter-distance-min", "trip-filter-distance-max"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("input", (e) => {
        e.target.classList.toggle("has-value", e.target.value);
      });
    }
  });

  updateFilterChips();
}

function showFilterFeedback() {
  // Add pulse animation to stat pills
  document.querySelectorAll(".stat-pill").forEach((pill, index) => {
    setTimeout(() => {
      pill.classList.add("updating", "filtered");
      setTimeout(() => {
        pill.classList.remove("updating");
      }, 500);
    }, index * 100);
  });

  // Add visual feedback to search section
  const searchSection = document.querySelector(".trips-search-section");
  if (searchSection) {
    searchSection.classList.add("has-filters");
  }

  // Update filter panel styling
  const filtersPanel = document.getElementById("trips-filters-panel");
  if (filtersPanel) {
    filtersPanel.classList.add("has-filters");
  }

  // Show filter status indicator
  const filtersStatus = document.getElementById("filters-status");
  if (filtersStatus) {
    filtersStatus.style.display = "flex";
  }

  // Show notification
  const filterCount = document.getElementById("active-filter-count");
  if (filterCount && filterCount.textContent && filterCount.textContent !== "0") {
    notificationManager.show(
      `${filterCount.textContent} filter${filterCount.textContent !== "1" ? "s" : ""} applied`,
      "info",
      { duration: 2000 }
    );
  }
}

function updateFilteredStats() {
  // Calculate stats from currently filtered/displayed trips
  const visibleTrips = filteredTrips.length > 0 ? filteredTrips : tripsData;

  const totalMiles = visibleTrips.reduce(
    (sum, trip) => sum + (parseFloat(trip.distance) || 0),
    0
  );
  const totalTrips = visibleTrips.length;
  const totalDuration = visibleTrips.reduce(
    (sum, trip) => sum + (parseInt(trip.duration) || 0),
    0
  );
  const totalHours = Math.round(totalDuration / 3600);

  updateOverviewStats({
    totalMiles,
    totalTrips,
    totalHours,
  });

  // Update insight cards for filtered data
  updateFilteredInsights(visibleTrips);
}

function updateFilteredInsights(trips) {
  if (trips.length === 0) {
    const longestEl = document.getElementById("insight-longest");
    const fuelEl = document.getElementById("insight-fuel");
    if (longestEl) {
      longestEl.textContent = "--";
    }
    if (fuelEl) {
      fuelEl.textContent = "--";
    }
    return;
  }

  const distances = trips.map((t) => parseFloat(t.distance) || 0);
  const longestTrip = Math.max(...distances);
  const totalFuel = trips.reduce(
    (sum, trip) => sum + (parseFloat(trip.fuelConsumed) || 0),
    0
  );

  // Animate insight card updates
  const longestEl = document.getElementById("insight-longest");
  const fuelEl = document.getElementById("insight-fuel");

  if (longestEl) {
    longestEl.style.opacity = "0";
    setTimeout(() => {
      longestEl.textContent = longestTrip ? `${longestTrip.toFixed(1)} mi` : "--";
      longestEl.style.opacity = "1";
    }, 150);
  }

  if (fuelEl) {
    fuelEl.style.opacity = "0";
    setTimeout(() => {
      fuelEl.textContent = totalFuel ? `${totalFuel.toFixed(1)} gal` : "--";
      fuelEl.style.opacity = "1";
    }, 150);
  }
}

function performSearch(query) {
  const searchClear = document.getElementById("search-clear-btn");
  if (searchClear) {
    searchClear.style.display = query ? "flex" : "none";
  }

  if (!query.trim()) {
    filteredTrips = [...tripsData];
  } else {
    const lowerQuery = query.toLowerCase();
    filteredTrips = tripsData.filter((trip) => {
      const startLoc = getLocationText(trip.startLocation).toLowerCase();
      const endLoc = getLocationText(trip.destination).toLowerCase();
      return (
        (trip.vehicleLabel || "").toLowerCase().includes(lowerQuery) ||
        startLoc.includes(lowerQuery) ||
        endLoc.includes(lowerQuery) ||
        (trip.transactionId || "").toLowerCase().includes(lowerQuery)
      );
    });
  }

  renderTripsTimeline(filteredTrips);
}

function getFilterValues() {
  const getVal = (id) => document.getElementById(id)?.value?.trim() || null;
  const dateRange = getDateRangeFilters();

  return {
    imei: getVal("trip-filter-vehicle"),
    distance_min: getVal("trip-filter-distance-min"),
    distance_max: getVal("trip-filter-distance-max"),
    start_date: dateRange.start_date,
    end_date: dateRange.end_date,
  };
}

function getDateRangeFilters() {
  const start_date = DateUtils.getStartDate?.() || null;
  const end_date = DateUtils.getEndDate?.() || null;
  return { start_date, end_date };
}

function getLocalFilterValues() {
  const getVal = (id) => document.getElementById(id)?.value?.trim() || null;
  return {
    imei: getVal("trip-filter-vehicle"),
    distance_min: getVal("trip-filter-distance-min"),
    distance_max: getVal("trip-filter-distance-max"),
  };
}

function getFilterState() {
  const localFilters = getLocalFilterValues();
  const dateRange = getDateRangeFilters();
  const hasLocalFilters = Boolean(
    localFilters.imei || localFilters.distance_min || localFilters.distance_max
  );
  const hasDateRange = Boolean(dateRange.start_date || dateRange.end_date);
  return {
    localFilters,
    dateRange,
    hasLocalFilters,
    hasDateRange,
    hasAnyFilters: hasLocalFilters || hasDateRange,
  };
}

function updateFilterChips() {
  const container = document.getElementById("active-filter-chips");
  if (!container) {
    return;
  }

  const filters = getLocalFilterValues();
  container.innerHTML = "";
  let filterCount = 0;

  const addChip = (label, onRemove) => {
    const chip = document.createElement("span");
    chip.className = "filter-chip";
    chip.innerHTML = `
      ${escapeHtml(label)}
      <button type="button" aria-label="Remove filter">
        <i class="fas fa-times"></i>
      </button>
    `;
    chip.querySelector("button").addEventListener("click", () => {
      onRemove();
      updateFilterChips();
      loadTrips();
    });
    container.appendChild(chip);
    filterCount++;
  };

  if (filters.imei) {
    const vehicleSelect = document.getElementById("trip-filter-vehicle");
    const vehicleName =
      vehicleSelect?.options[vehicleSelect.selectedIndex]?.text || filters.imei;
    addChip(`Vehicle: ${vehicleName}`, () => {
      document.getElementById("trip-filter-vehicle").value = "";
      setStorage(CONFIG.STORAGE_KEYS.selectedVehicle, null);
    });
  }

  if (filters.distance_min || filters.distance_max) {
    addChip(
      `Distance: ${filters.distance_min || "0"} - ${filters.distance_max || "∞"} mi`,
      () => {
        document.getElementById("trip-filter-distance-min").value = "";
        document.getElementById("trip-filter-distance-max").value = "";
      }
    );
  }

  // Update badge count
  const badge = document.getElementById("active-filter-count");
  if (badge) {
    badge.textContent = filterCount;
    badge.style.display = filterCount > 0 ? "inline-flex" : "none";
  }

  // Update filter toggle button styling
  const filterToggle = document.getElementById("filter-toggle-btn");
  if (filterToggle) {
    filterToggle.classList.toggle("has-filters", filterCount > 0);
  }

  // Update filter panel styling
  const filtersPanel = document.getElementById("trips-filters-panel");
  if (filtersPanel) {
    filtersPanel.classList.toggle("has-filters", filterCount > 0);
  }

  // Update filters status indicator
  const filtersStatus = document.getElementById("filters-status");
  if (filtersStatus) {
    filtersStatus.style.display = filterCount > 0 ? "flex" : "none";
  }
}

function updateFilterResultsPreview() {
  const previewEl = document.getElementById("filter-results-preview");
  if (!previewEl) {
    return;
  }

  const visibleTrips = filteredTrips.length > 0 ? filteredTrips : tripsData;
  const { hasLocalFilters } = getFilterState();

  if (hasLocalFilters && visibleTrips.length > 0) {
    const totalMiles = visibleTrips.reduce(
      (sum, trip) => sum + (parseFloat(trip.distance) || 0),
      0
    );
    previewEl.innerHTML = `
      <span class="results-count">${visibleTrips.length}</span> trips 
      <span style="color: var(--trips-text-tertiary);">•</span> 
      ${totalMiles.toFixed(1)} mi
    `;
    previewEl.style.display = "inline";
  } else {
    previewEl.textContent = "";
    previewEl.style.display = "none";
  }
}

// ==========================================
// BULK ACTIONS
// ==========================================

function setupBulkActions() {
  const bulkBar = document.getElementById("bulk-actions-bar");
  const selectAllBtn = document.getElementById("bulk-select-all-btn");
  const deleteBtn = document.getElementById("bulk-delete-trips-btn");
  const closeBtn = document.getElementById("bulk-close-btn");

  if (selectAllBtn) {
    selectAllBtn.addEventListener("click", () => {
      const visibleCards = document.querySelectorAll(".trip-card");
      const allSelected = visibleCards.length === selectedTripIds.size;

      visibleCards.forEach((card) => {
        const { tripId } = card.dataset;
        const checkbox = card.querySelector(".trip-card-checkbox input");

        if (allSelected) {
          selectedTripIds.delete(tripId);
          card.classList.remove("selected");
          if (checkbox) {
            checkbox.checked = false;
          }
        } else {
          selectedTripIds.add(tripId);
          card.classList.add("selected");
          if (checkbox) {
            checkbox.checked = true;
          }
        }
      });

      updateBulkActionsBar();
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      if (selectedTripIds.size === 0) {
        return;
      }

      const confirmed = await confirmationDialog.show({
        title: "Delete Trips",
        message: `Are you sure you want to delete ${selectedTripIds.size} trips?`,
        confirmText: "Delete All",
        confirmButtonClass: "btn-danger",
      });

      if (confirmed) {
        await bulkDeleteTrips([...selectedTripIds]);
      }
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      selectedTripIds.clear();
      document.querySelectorAll(".trip-card").forEach((card) => {
        card.classList.remove("selected");
        const checkbox = card.querySelector(".trip-card-checkbox input");
        if (checkbox) {
          checkbox.checked = false;
        }
      });
      updateBulkActionsBar();
    });
  }
}

function updateBulkActionsBar() {
  const bulkBar = document.getElementById("bulk-actions-bar");
  const countEl = document.getElementById("bulk-count");

  if (selectedTripIds.size > 0) {
    bulkBar.style.display = "flex";
    countEl.textContent = `${selectedTripIds.size} selected`;
  } else {
    bulkBar.style.display = "none";
  }
}

function setupTripCardInteractions() {
  // Pagination buttons
  document.getElementById("prev-page")?.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      loadTrips();
    }
  });

  document.getElementById("next-page")?.addEventListener("click", () => {
    const totalPages = Math.ceil(totalTrips / pageSize);
    if (currentPage < totalPages) {
      currentPage++;
      loadTrips();
    }
  });
}

// ==========================================
// TRIP OPERATIONS
// ==========================================

async function deleteTrip(id) {
  try {
    await optimisticAction({
      optimistic: () => {
        tripsData = tripsData.filter((t) => t.transactionId !== id);
        filteredTrips = filteredTrips.filter((t) => t.transactionId !== id);
        renderTripsTimeline(filteredTrips);
        selectedTripIds.delete(id);
        updateBulkActionsBar();
        return { id };
      },
      request: async () => {
        await apiDelete(CONFIG.API.tripById(id));
        return true;
      },
      commit: () => {
        notificationManager.show("Trip deleted", "success");
        loadTripStats();
      },
      rollback: () => {
        loadTrips();
        notificationManager.show("Failed to delete trip", "danger");
      },
    });
  } catch (err) {
    console.error("Delete failed:", err);
  }
}

async function bulkDeleteTrips(ids) {
  try {
    await optimisticAction({
      optimistic: () => {
        const idSet = new Set(ids);
        tripsData = tripsData.filter((t) => !idSet.has(t.transactionId));
        filteredTrips = filteredTrips.filter((t) => !idSet.has(t.transactionId));
        ids.forEach((id) => selectedTripIds.delete(id));
        renderTripsTimeline(filteredTrips);
        updateBulkActionsBar();
        return { ids };
      },
      request: async () => {
        await apiPost(CONFIG.API.tripsBulkDelete, { trip_ids: ids });
        return true;
      },
      commit: () => {
        notificationManager.show(`${ids.length} trips deleted`, "success");
        loadTrips();
        loadTripStats();
      },
      rollback: () => {
        loadTrips();
        notificationManager.show("Failed to delete trips", "danger");
      },
    });
  } catch (err) {
    console.error("Bulk delete failed:", err);
  }
}

// ==========================================
// TRIP MODAL
// ==========================================

function openTripModal(tripId) {
  currentTripId = tripId;

  if (!tripModalInstance) {
    const el = document.getElementById("tripDetailsModal");
    if (el) {
      tripModalInstance = new bootstrap.Modal(el);

      el.addEventListener("hidden.bs.modal", () => {
        resetPlayback();
        currentTripData = null;
        if (tripModalMap) {
          const src = tripModalMap.getSource("modal-trip");
          if (src) {
            src.setData({ type: "FeatureCollection", features: [] });
          }
        }
      });

      el.addEventListener("shown.bs.modal", () => {
        if (!tripModalMap) {
          initTripModalMap();
        } else {
          tripModalMap.resize();
          setupTripPlaybackControls();
          loadTripData(currentTripId);
        }
      });

      bindTripModalActions();
    }
  }

  tripModalInstance.show();
}

function bindTripModalActions() {
  if (modalActionsBound) {
    return;
  }

  const shareBtn = document.getElementById("modal-share-btn");
  if (!shareBtn) {
    return;
  }

  shareBtn.type = "button";
  shareBtn.addEventListener(
    "click",
    () => {
      const shareData = buildTripShareData(currentTripData);
      if (navigator.share) {
        navigator.share(shareData).catch((err) => {
          if (err?.name === "AbortError") {
            return;
          }
          notificationManager.show("Share failed", "danger");
          console.warn("Share failed:", err);
        });
        return;
      }

      if (navigator.clipboard?.writeText && shareData.url) {
        navigator.clipboard
          .writeText(shareData.url)
          .then(() => {
            notificationManager.show("Trip link copied to clipboard", "success");
          })
          .catch((err) => {
            notificationManager.show("Share is not available on this device", "info");
            console.warn("Clipboard write failed:", err);
          });
        return;
      }

      notificationManager.show("Share is not available on this device", "info");
    },
    pageSignal ? { signal: pageSignal } : false
  );

  const deleteBtn = document.getElementById("modal-delete-btn");
  if (deleteBtn) {
    deleteBtn.type = "button";
    deleteBtn.addEventListener(
      "click",
      async () => {
        const confirmed = await confirmationDialog.show({
          title: "Delete Trip",
          message: "Are you sure you want to delete this trip?",
          confirmText: "Delete",
          confirmButtonClass: "btn-danger",
        });
        if (confirmed && currentTripId) {
          tripModalInstance?.hide();
          deleteTrip(currentTripId);
        }
      },
      pageSignal ? { signal: pageSignal } : false
    );
  }

  modalActionsBound = true;
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
    return;
  }

  try {
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

      // Add start point marker source and layer
      if (!tripModalMap.getSource(playbackState.startSourceId)) {
        tripModalMap.addSource(playbackState.startSourceId, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });

        tripModalMap.addLayer({
          id: playbackState.startLayerId,
          type: "circle",
          source: playbackState.startSourceId,
          paint: {
            "circle-radius": 12,
            "circle-color": "#10b981",
            "circle-opacity": 1,
            "circle-stroke-width": 3,
            "circle-stroke-color": stroke,
          },
        });
      }

      // Add end point marker source and layer
      if (!tripModalMap.getSource(playbackState.endSourceId)) {
        tripModalMap.addSource(playbackState.endSourceId, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });

        tripModalMap.addLayer({
          id: playbackState.endLayerId,
          type: "circle",
          source: playbackState.endSourceId,
          paint: {
            "circle-radius": 12,
            "circle-color": "#8b5cf6",
            "circle-opacity": 1,
            "circle-stroke-width": 3,
            "circle-stroke-color": stroke,
          },
        });
      }

      setupTripPlaybackControls();
      loadTripData(currentTripId);
    });
  } catch (e) {
    console.error("Failed to init modal map:", e);
    document.getElementById("trip-modal-map").innerHTML =
      '<div style="padding: 20px; color: #dc3545;">Failed to load map.</div>';
  }
}

async function loadTripData(tripId) {
  const loadingEl = document.getElementById("trip-map-loading");
  loadingEl?.classList.remove("d-none");

  try {
    const data = await apiGet(CONFIG.API.tripById(tripId));
    const trip = data.trip || data;
    currentTripData = trip;

    updateModalContent(trip);

    renderTripOnMap(trip);
  } catch (err) {
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

  const distanceEl = document.getElementById("modal-distance");
  const durationEl = document.getElementById("modal-duration");
  const speedEl = document.getElementById("modal-max-speed");
  const fuelEl = document.getElementById("modal-fuel");
  const startEl = document.getElementById("modal-start-loc");
  const endEl = document.getElementById("modal-end-loc");

  if (distanceEl) {
    distanceEl.textContent = trip.distance
      ? `${parseFloat(trip.distance).toFixed(2)} mi`
      : "--";
  }
  if (durationEl) {
    durationEl.textContent = trip.duration ? formatDuration(trip.duration) : "--";
  }
  if (speedEl) {
    speedEl.textContent = trip.maxSpeed ? `${Math.round(trip.maxSpeed)} mph` : "--";
  }
  if (fuelEl) {
    fuelEl.textContent = trip.fuelConsumed
      ? `${parseFloat(trip.fuelConsumed).toFixed(2)} gal`
      : "--";
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
}

function renderTripOnMap(trip) {
  if (!tripModalMap?.isStyleLoaded()) {
    setTimeout(() => renderTripOnMap(trip), 200);
    return;
  }

  const geometry = extractTripGeometry(trip);
  if (!geometry) {
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

  setPlaybackRoute(geometry);

  // Update start and end markers
  if (geometry.type === "LineString" && geometry.coordinates.length >= 2) {
    const startCoord = geometry.coordinates[0];
    const endCoord = geometry.coordinates[geometry.coordinates.length - 1];

    // Update start point
    const startSrc = tripModalMap.getSource(playbackState.startSourceId);
    if (startSrc) {
      startSrc.setData({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: startCoord },
            properties: { label: "Start" },
          },
        ],
      });
    }

    // Update end point
    const endSrc = tripModalMap.getSource(playbackState.endSourceId);
    if (endSrc) {
      endSrc.setData({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: endCoord },
            properties: { label: "End" },
          },
        ],
      });
    }
  }

  const bounds = new mapboxgl.LngLatBounds();
  const coords = geometry.coordinates;

  if (geometry.type === "LineString") {
    coords.forEach((c) => bounds.extend(c));
  } else if (geometry.type === "Point") {
    bounds.extend(coords);
  }

  if (!bounds.isEmpty()) {
    tripModalMap.resize();
    tripModalMap.fitBounds(bounds, {
      padding: 100,
      duration: 1000,
      essential: true,
    });
  }
}

function extractTripGeometry(trip) {
  if (!trip) {
    return null;
  }
  const candidate = trip.geometry || trip.matchedGps || trip.gps;
  if (!candidate) {
    return null;
  }

  let parsed = candidate;
  if (typeof candidate === "string") {
    try {
      parsed = JSON.parse(candidate);
    } catch (err) {
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
    playBtn.addEventListener("click", () => {
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
    speedInput.addEventListener("input", () => {
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
    const markerEl = document.createElement("div");
    markerEl.className = "playback-marker";
    markerEl.innerHTML = `
      <div class="playback-marker-inner"></div>
      <div class="playback-marker-pulse"></div>
    `;
    playbackState.marker = new mapboxgl.Marker({
      element: markerEl,
      anchor: "center",
    });
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

    playbackState.marker.setLngLat(coord).addTo(tripModalMap);
    tripModalMap.setCenter(coord);
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
    : { type: "FeatureCollection", features: [] };

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
