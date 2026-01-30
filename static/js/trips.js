/* global bootstrap, mapboxgl, dayjs */
/**
 * Trips Page - Modern Travel Journal
 * Card-based trip display with timeline grouping and smart features
 */

import apiClient from "./modules/core/api-client.js";
import { CONFIG } from "./modules/core/config.js";
import store, { optimisticAction } from "./modules/core/store.js";
import { createMap } from "./modules/map-base.js";
import { initTripSync } from "./modules/trip-sync.js";
import confirmationDialog from "./modules/ui/confirmation-dialog.js";
import notificationManager from "./modules/ui/notifications.js";
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

onPageLoad(
  async ({ signal, cleanup } = {}) => {
    try {
      await initializePage(signal, cleanup);
    } catch (e) {
      notificationManager.show(`Error loading trips: ${e.message}`, "danger");
      console.error(e);
    }
  },
  { route: "/trips" }
);

async function initializePage(signal, cleanup) {
  // Update greeting based on time
  updateGreeting();

  // Load vehicles for filter dropdown
  await loadVehicles();

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

  // Initial data load
  await Promise.all([loadTrips(), loadTripStats()]);

  // Check if we need to open a specific trip (from URL param)
  if (window.PRELOAD_TRIP_ID) {
    requestAnimationFrame(() => openTripModal(window.PRELOAD_TRIP_ID));
  }
}

// ==========================================
// GREETING & WELCOME
// ==========================================

function updateGreeting() {
  const hour = new Date().getHours();
  let greeting = "Good evening";
  let icon = "🌙";

  if (hour >= 5 && hour < 12) {
    greeting = "Good morning";
    icon = "☀️";
  } else if (hour >= 12 && hour < 17) {
    greeting = "Good afternoon";
    icon = "👋";
  }

  const greetingText = document.querySelector(".greeting-text");
  const greetingIcon = document.querySelector(".greeting-icon");

  if (greetingText) greetingText.textContent = greeting;
  if (greetingIcon) greetingIcon.textContent = icon;
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
  if (!vehicleSelect) return;

  try {
    const vehicles = await apiClient.get(`${CONFIG.API.vehicles}?active_only=true`);
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
    // Fetch stats for current month
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const params = new URLSearchParams({
      start_date: startOfMonth.toISOString(),
      end_date: now.toISOString(),
    });

    const [metricsResult, insightsResult] = await Promise.allSettled([
      apiClient.get(`${CONFIG.API.tripMetrics}?${params}`),
      apiClient.get(`${CONFIG.API.drivingInsights}?${params}`),
    ]);

    if (metricsResult.status === "rejected") {
      console.warn("Failed to load trip metrics:", metricsResult.reason);
    }
    if (insightsResult.status === "rejected") {
      console.warn("Failed to load trip insights:", insightsResult.reason);
    }

    const metrics = metricsResult.status === "fulfilled" ? metricsResult.value : null;
    const insights = insightsResult.status === "fulfilled" ? insightsResult.value : null;

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

    // Update welcome stats
    const totalMiles = toNumber(
      metrics?.total_distance ?? insights?.total_distance,
      0
    );
    const totalTrips = toNumber(
      metrics?.total_trips ?? insights?.total_trips,
      0
    );
    const totalHours = Math.round(
      toNumber(metrics?.total_duration_seconds, 0) / 3600
    );

    document.getElementById("stat-total-miles").textContent = totalMiles.toFixed(1);
    document.getElementById("stat-total-trips").textContent = totalTrips;
    document.getElementById("stat-total-time").textContent = totalHours;

    // Update summary text
    const summaryEl = document.getElementById("trips-summary-text");
    if (summaryEl) {
      summaryEl.innerHTML = `You've traveled <strong>${totalMiles.toFixed(1)} miles</strong> across <strong>${totalTrips} trips</strong> this month`;
    }

    // Update insight cards
    const longestEl = document.getElementById("insight-longest");
    const fuelEl = document.getElementById("insight-fuel");
    const longestTrip = toNumber(
      insights?.longest_trip_distance ?? insights?.records?.longest_trip?.distance,
      0
    );
    const totalFuel = toNumber(insights?.total_fuel_consumed, 0);

    if (longestEl) {
      longestEl.textContent = longestTrip
        ? `${longestTrip.toFixed(1)} mi`
        : "--";
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

  if (indicator) indicator.setAttribute("data-state", state);

  if (state === "syncing") {
    if (text) text.textContent = "Syncing...";
    if (btn) btn.classList.add("syncing");
  } else if (state === "error") {
    if (text) text.textContent = "Sync failed";
    if (btn) btn.classList.remove("syncing");
  } else {
    if (text) text.textContent = "Up to date";
    if (btn) btn.classList.remove("syncing");
  }
}

// ==========================================
// TRIPS LOADING & RENDERING
// ==========================================

async function loadTrips() {
  if (isLoading) return;

  isLoading = true;
  showLoadingState(true);

  try {
    const filters = getFilterValues();

    const response = await apiClient.post(CONFIG.API.tripsDataTable, {
      draw: ++datatableDraw,
      start: (currentPage - 1) * pageSize,
      length: pageSize,
      search: { value: "" },
      order: [],
      columns: [],
      filters,
    });

    tripsData = response?.data || [];
    totalTrips = response?.recordsFiltered ?? response?.recordsTotal ?? tripsData.length;
    filteredTrips = [...tripsData];

    if (tripsData.length === 0) {
      showEmptyState();
    } else {
      hideEmptyState();
      renderTripsTimeline(tripsData);
      updatePagination();
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

  if (emptyEl) emptyEl.style.display = "block";
  if (timelineEl) timelineEl.style.display = "none";
  if (paginationEl) paginationEl.style.display = "none";
}

function hideEmptyState() {
  const emptyEl = document.getElementById("trips-empty");
  const timelineEl = document.getElementById("trips-timeline");
  const paginationEl = document.getElementById("trips-pagination");

  if (emptyEl) emptyEl.style.display = "none";
  if (timelineEl) timelineEl.style.display = "block";
  if (paginationEl) paginationEl.style.display = "flex";
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

      if (section) section.style.display = "block";
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
          ${trip.maxSpeed ? Math.round(trip.maxSpeed) + " mph" : "--"}
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
  if (!value || typeof value !== "string") return null;
  const cleaned = value.trim().replace(/[^0-9MLml.,\s-]/g, "");
  return cleaned.length > 0 ? cleaned : null;
}

function getThemeColor(variable, fallback) {
  if (typeof window === "undefined") return fallback;
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

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;

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

  if (prevBtn) prevBtn.disabled = currentPage <= 1;
  if (nextBtn) nextBtn.disabled = currentPage >= totalPages;

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
      if (searchInput) searchInput.value = "";
      searchClear.style.display = "none";
      performSearch("");
    });
  }

  // Filter toggle
  const filterToggle = document.getElementById("filter-toggle-btn");
  const filtersPanel = document.getElementById("filters-panel");

  if (filterToggle && filtersPanel) {
    filterToggle.addEventListener("click", () => {
      const isVisible = filtersPanel.style.display !== "none";
      filtersPanel.style.display = isVisible ? "none" : "block";
      filterToggle.classList.toggle("active", !isVisible);
    });
  }

  // Apply filters
  document.getElementById("trip-filter-apply")?.addEventListener("click", () => {
    currentPage = 1;
    loadTrips();
    updateFilterChips();

    // Close filters panel on mobile
    if (window.innerWidth < 768 && filtersPanel) {
      filtersPanel.style.display = "none";
      filterToggle?.classList.remove("active");
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
    });

    // Clear date filters from storage
    setStorage("startDate", null);
    setStorage("endDate", null);
    document.dispatchEvent(new Event("filtersReset"));

    currentPage = 1;
    loadTrips();
    updateFilterChips();
  });

  // Quick date filters
  document.querySelectorAll(".quick-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".quick-filter-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      const range = btn.dataset.range;
      const dates = getDateRange(range);

      if (dates.start && dates.end) {
        setStorage("startDate", dates.start);
        setStorage("endDate", dates.end);
      } else {
        setStorage("startDate", null);
        setStorage("endDate", null);
      }
    });
  });

  // Vehicle filter
  document.getElementById("trip-filter-vehicle")?.addEventListener("change", (e) => {
    setStorage(CONFIG.STORAGE_KEYS.selectedVehicle, e.target.value || null);
    store.updateFilters({ vehicle: e.target.value || null }, { source: "vehicle" });
  });

  updateFilterChips();
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

  return {
    imei: getVal("trip-filter-vehicle"),
    distance_min: getVal("trip-filter-distance-min"),
    distance_max: getVal("trip-filter-distance-max"),
    start_date: getStorage("startDate") || null,
    end_date: getStorage("endDate") || null,
  };
}

function getDateRange(range) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (range) {
    case "today":
      return {
        start: today.toISOString(),
        end: new Date(today.getTime() + 86400000).toISOString(),
      };
    case "yesterday": {
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      return {
        start: yesterday.toISOString(),
        end: today.toISOString(),
      };
    }
    case "week": {
      const weekStart = new Date(today);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      return {
        start: weekStart.toISOString(),
        end: now.toISOString(),
      };
    }
    case "month": {
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      return {
        start: monthStart.toISOString(),
        end: now.toISOString(),
      };
    }
    case "all":
    default:
      return { start: null, end: null };
  }
}

function updateFilterChips() {
  const container = document.getElementById("active-filter-chips");
  if (!container) return;

  const filters = getFilterValues();
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

  if (filters.start_date || filters.end_date) {
    const start = filters.start_date
      ? new Date(filters.start_date).toLocaleDateString()
      : "Any";
    const end = filters.end_date
      ? new Date(filters.end_date).toLocaleDateString()
      : "Any";
    addChip(`Date: ${start} → ${end}`, () => {
      setStorage("startDate", null);
      setStorage("endDate", null);
      document.dispatchEvent(new Event("filtersReset"));
      document
        .querySelectorAll(".quick-filter-btn")
        .forEach((b) => b.classList.remove("active"));
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
        const tripId = card.dataset.tripId;
        const checkbox = card.querySelector(".trip-card-checkbox input");

        if (allSelected) {
          selectedTripIds.delete(tripId);
          card.classList.remove("selected");
          if (checkbox) checkbox.checked = false;
        } else {
          selectedTripIds.add(tripId);
          card.classList.add("selected");
          if (checkbox) checkbox.checked = true;
        }
      });

      updateBulkActionsBar();
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      if (selectedTripIds.size === 0) return;

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
        if (checkbox) checkbox.checked = false;
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
        await apiClient.delete(CONFIG.API.tripById(id));
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
        await apiClient.post(CONFIG.API.tripsBulkDelete, { trip_ids: ids });
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
    }
  }

  tripModalInstance.show();
}

function initTripModalMap() {
  if (tripModalMap) return;

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
            "circle-radius": 6,
            "circle-color": primary,
            "circle-opacity": 0.9,
            "circle-stroke-width": 2,
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
    const data = await apiClient.get(CONFIG.API.tripById(tripId));
    const trip = data.trip || data;

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
  const subtitleEl = document.getElementById("tripModalSubtitle");

  if (titleEl) titleEl.textContent = title;
  if (subtitleEl)
    subtitleEl.textContent = `${formatDateTime(trip.startTime)} • ${trip.transactionId}`;

  const distanceEl = document.getElementById("modal-distance");
  const durationEl = document.getElementById("modal-duration");
  const speedEl = document.getElementById("modal-max-speed");
  const fuelEl = document.getElementById("modal-fuel");
  const startEl = document.getElementById("modal-start-loc");
  const endEl = document.getElementById("modal-end-loc");

  if (distanceEl)
    distanceEl.textContent = trip.distance
      ? `${parseFloat(trip.distance).toFixed(2)} mi`
      : "--";
  if (durationEl)
    durationEl.textContent = trip.duration ? formatDuration(trip.duration) : "--";
  if (speedEl)
    speedEl.textContent = trip.maxSpeed ? `${Math.round(trip.maxSpeed)} mph` : "--";
  if (fuelEl)
    fuelEl.textContent = trip.fuelConsumed
      ? `${parseFloat(trip.fuelConsumed).toFixed(2)} gal`
      : "--";
  if (startEl) startEl.textContent = sanitizeLocation(trip.startLocation);
  if (endEl) endEl.textContent = sanitizeLocation(trip.destination);
}

function renderTripOnMap(trip) {
  if (!tripModalMap?.isStyleLoaded()) {
    setTimeout(() => renderTripOnMap(trip), 200);
    return;
  }

  const geometry = extractTripGeometry(trip);
  if (!geometry) return;

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
  if (!trip) return null;
  const candidate = trip.geometry || trip.matchedGps || trip.gps;
  if (!candidate) return null;

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
  if (playbackControlsBound) return;

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
  if (!tripModalMap || playbackState.coords.length === 0) return;

  playbackState.isPlaying = true;

  if (!playbackState.marker) {
    const { primary } = getTripUiColors();
    playbackState.marker = new mapboxgl.Marker({ color: primary });
  }

  const step = () => {
    if (!playbackState.isPlaying) return;

    playbackState.progress += playbackState.speed * 0.6;
    const index = Math.min(
      playbackState.coords.length - 1,
      Math.floor(playbackState.progress)
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
  if (!tripModalMap?.getSource(playbackState.headSourceId)) return;

  const feature = coord
    ? { type: "Feature", geometry: { type: "Point", coordinates: coord } }
    : null;

  const data = feature
    ? { type: "FeatureCollection", features: [feature] }
    : { type: "FeatureCollection", features: [] };

  tripModalMap.getSource(playbackState.headSourceId).setData(data);
}

function updatePlaybackTrail(coords) {
  if (!tripModalMap?.getSource(playbackState.trailSourceId)) return;

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
  if (!playBtn) return;

  const icon = playBtn.querySelector("i");
  const span = playBtn.querySelector("span");

  if (playbackState.isPlaying) {
    playBtn.classList.add("is-playing");
    playBtn.setAttribute("aria-pressed", "true");
    if (icon) icon.className = "fas fa-pause";
    if (span) span.textContent = "Pause";
  } else {
    playBtn.classList.remove("is-playing");
    playBtn.setAttribute("aria-pressed", "false");
    if (icon) icon.className = "fas fa-play";
    if (span) span.textContent = "Play";
  }
}
