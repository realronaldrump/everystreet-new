/**
 * Trips page controller: loads trips and stats, applies filters and sorting,
 * and renders the cards, timeline, and table with bulk actions. Trip
 * presentation lives in presentation.js, the table in columns.js, and the
 * trip modal in trip-modal.js.
 */

import { CONFIG } from "../../core/config.js";
import { updateRegion } from "../../core/partial-update.js";
import store, { optimisticAction } from "../../core/store.js";
import { getPreloadTripIdFromUrl } from "../../core/url-state.js";
import { initTripSync } from "../../trip-sync.js";
import confirmationDialog from "../../ui/confirmation-dialog.js";
import loadingManager from "../../ui/loading-manager.js";
import notificationManager from "../../ui/notifications.js";
import {
  DateUtils,
  escapeHtml,
  formatCurrency,
  formatDuration,
  formatVehicleName,
  getStorage,
  isAbortError,
  sanitizeLocation,
  setStorage,
} from "../../utils.js";
import {
  formatRelativeTime,
  generateSmartTitle,
  getLocationText,
  getTripBadges,
  getTripPreviewPath,
  isInactiveTrip,
  splitTripsByActiveState,
} from "./presentation.js";
import { selectedTripIds } from "./selection.js";
import {
  TRIP_SORT_DEFINITIONS,
  TRIP_TABLE_COLUMNS,
  getColumnSortKey,
  getSortColumnForKey,
} from "./columns.js";
import {
  apiDelete,
  apiGet,
  apiPost,
  bindPageEvent,
  pageSignal,
  releasePageSignal,
  setPageContext,
} from "./page-context.js";
import {
  mergeIntoOpenTrip,
  openTripModal,
  openTripTools,
  refreshOpenTrip,
  resetTripModal,
  setTripModalActions,
} from "./trip-modal.js";

// State management
let tripsData = [];
let filteredTrips = [];
let currentPage = 1;
const pageSize = 25;
let totalTrips = 0;
let filteredTripSummary = null;
let datatableDraw = 0;
let isLoading = false;

const DEFAULT_TRIP_SORT = "date_desc";
let appliedTripSort = DEFAULT_TRIP_SORT;
const DEFAULT_TRIP_VIEW = "cards";
const TABLE_COLUMN_STORAGE_KEY =
  CONFIG.STORAGE_KEYS.tripsTableColumns || "tripsTableColumns";
const TRIP_VIEW_STORAGE_KEY = CONFIG.STORAGE_KEYS.tripsViewMode || "tripsViewMode";
let tripViewMode = DEFAULT_TRIP_VIEW;
let tripTableColumnOrder = [];
let tripTableHiddenColumns = new Set();
let draggedColumnKey = null;

function resetTripsState() {
  resetTripModal();
  tripsData = [];
  filteredTrips = [];
  currentPage = 1;
  totalTrips = 0;
  filteredTripSummary = null;
  datatableDraw = 0;
  selectedTripIds.clear();
  isLoading = false;
  appliedTripSort = DEFAULT_TRIP_SORT;
  tripViewMode = DEFAULT_TRIP_VIEW;
  tripTableColumnOrder = [];
  tripTableHiddenColumns = new Set();
  draggedColumnKey = null;
}

function normalizeTripSort(value) {
  if (typeof value !== "string") {
    return DEFAULT_TRIP_SORT;
  }

  const normalized = value.trim();

  if (TRIP_SORT_DEFINITIONS[normalized]) {
    return normalized;
  }

  return DEFAULT_TRIP_SORT;
}

function getTripSortValue() {
  const select = document.getElementById("trip-sort-select");
  const stored = getStorage(CONFIG.STORAGE_KEYS.tripsSort, DEFAULT_TRIP_SORT);
  const candidate = stored || select?.value || DEFAULT_TRIP_SORT;
  return normalizeTripSort(candidate);
}

function getTripSortLabel(sort) {
  return (
    TRIP_SORT_DEFINITIONS[normalizeTripSort(sort)]?.label ||
    TRIP_SORT_DEFINITIONS[DEFAULT_TRIP_SORT].label
  );
}

function getTripsSortRequest() {
  const sort = getTripSortValue();
  const definition =
    TRIP_SORT_DEFINITIONS[sort] || TRIP_SORT_DEFINITIONS[DEFAULT_TRIP_SORT];
  const { column, dir } = definition;

  return {
    sort,
    order: [{ column: 0, dir }],
    columns: [{ data: column }],
  };
}

export default async function initTripsPage({ signal, cleanup, api } = {}) {
  const cleanupFns = [];
  const registerCleanup = (fn) => {
    if (typeof fn === "function") {
      if (signal?.aborted) fn();
      else cleanupFns.push(fn);
    }
  };

  setPageContext({ signal, api });
  setTripModalActions({ deleteTrip, toggleTripInactive });
  resetTripsState();

  const teardown = () => {
    for (const fn of cleanupFns.splice(0)) {
      try { fn(); } catch (error) { console.warn("Trips cleanup error", error); }
    }
    if (releasePageSignal(signal)) { resetTripsState(); }
  };
  cleanup?.(teardown);

  try {
    await initializePage(signal, registerCleanup);
  } catch (e) {
    if (signal?.aborted) return;
    notificationManager.show(`Error loading trips: ${e.message}`, "danger");
    console.error(e);
  }



  return teardown;
}

async function initializePage(signal, cleanup) {
  // Load vehicles for filter dropdown
  await loadVehicles();
  if (signal?.aborted) return;

  // Restore saved filters before setting up listeners
  restoreSavedFilters();
  restoreTripViewPreference();
  restoreTripTableColumnPreferences();

  // Setup all event listeners
  setupSearchAndFilters(cleanup);
  setupTripViewControls();
  setupBulkActions();
  setupTripCardInteractions();

  // Initialize trip sync functionality
  initTripSync({
    onSyncComplete: () => {
      if (pageSignal?.aborted) {
        return;
      }
      void loadTrips();
      void loadTripStats();
    },
    onSyncError: () => {
      updateSyncStatus("error");
    },
    cleanup,
  });

  // Listen for date/vehicle filter changes from global filter panel
  document.addEventListener(
    "filtersApplied",
    () => {
      loadTrips();
      loadTripStats();
    },
    signal ? { signal } : false
  );

  // Initial data load
  document.addEventListener(
    "historicalTripsUpdated",
    () => {
      void loadTrips();
      void loadTripStats();
    },
    signal ? { signal } : false
  );
  await Promise.all([loadTrips(), loadTripStats()]);
  if (signal?.aborted) return;

  // Apply any saved filters after data loads
  applySavedFilters();

  // Check if we need to open a specific trip (from URL param)
  const preloadTripId = getPreloadTripIdFromUrl();
  if (preloadTripId) {
    requestAnimationFrame(() => { if (!signal?.aborted) openTripTools(preloadTripId); });
  }
}

function updateOverviewStats({ totalMiles, totalTrips: totalTripsCount, totalHours }) {
  const milesEl = document.getElementById("stat-total-miles");
  const tripsEl = document.getElementById("stat-total-trips");
  const hoursEl = document.getElementById("stat-total-time");
  const hasMiles = totalMiles !== null && Number.isFinite(Number(totalMiles));
  const safeMiles = hasMiles ? Number(totalMiles) : 0;
  const safeTrips = Number.isFinite(Number(totalTripsCount))
    ? Number(totalTripsCount)
    : 0;
  const hasHours = totalHours !== null && Number.isFinite(Number(totalHours));
  const safeHours = hasHours ? Number(totalHours) : 0;

  if (milesEl) {
    milesEl.textContent = hasMiles ? safeMiles.toFixed(1) : "--";
  }
  if (tripsEl) {
    tripsEl.textContent = safeTrips;
  }
  if (hoursEl) {
    hoursEl.textContent = hasHours ? safeHours : "--";
  }

  const summaryEl = document.getElementById("trips-summary-text");
  if (summaryEl) {
    const { hasAnyFilters } = getFilterState();
    const milesText = hasMiles
      ? `${safeMiles.toFixed(1)} miles`
      : "mileage unavailable";

    if (hasAnyFilters) {
      summaryEl.innerHTML = `Showing <strong>${safeTrips} trips</strong> • <strong>${milesText}</strong>`;
    } else {
      summaryEl.innerHTML = `<strong>${milesText}</strong> across <strong>${safeTrips} trips</strong> in this range`;
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

function hasDistanceFilters() {
  const localFilters = getLocalFilterValues();
  return Boolean(localFilters.distance_min || localFilters.distance_max);
}

function restoreSavedFilters() {
  // Restore sort selection
  const sortSelect = document.getElementById("trip-sort-select");
  if (sortSelect) {
    const savedSort = normalizeTripSort(
      getStorage(CONFIG.STORAGE_KEYS.tripsSort, DEFAULT_TRIP_SORT)
    );
    const hasOption = Array.from(sortSelect.options).some(
      (option) => option.value === savedSort
    );
    sortSelect.value = hasOption ? savedSort : DEFAULT_TRIP_SORT;
    sortSelect.classList.toggle("has-value", savedSort !== DEFAULT_TRIP_SORT);
  }

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
    if (hasDistanceFilters()) {
      updateFilteredStats();
    }
  }
}

function normalizeTripViewMode(value) {
  return value === "list" ? "list" : DEFAULT_TRIP_VIEW;
}

function restoreTripViewPreference() {
  tripViewMode = normalizeTripViewMode(
    getStorage(TRIP_VIEW_STORAGE_KEY, DEFAULT_TRIP_VIEW)
  );
  applyTripViewMode(tripViewMode, { render: false, persist: false });
}

function setupTripViewControls() {
  document.querySelectorAll("[data-trip-view]").forEach((button) => {
    bindPageEvent(button, "click", () => {
      applyTripViewMode(button.dataset.tripView, { render: true, persist: true });
    });
  });

  bindPageEvent("trip-table-columns-toggle", "click", () => {
    const panel = document.getElementById("trip-table-columns-panel");
    const button = document.getElementById("trip-table-columns-toggle");
    if (!panel || !button) {
      return;
    }
    const willOpen = panel.hidden;
    panel.hidden = !willOpen;
    button.classList.toggle("active", willOpen);
    button.setAttribute("aria-expanded", willOpen ? "true" : "false");
    if (willOpen) {
      renderTripTableColumnControls();
    }
  });

  bindPageEvent("trip-table-columns-reset", "click", () => {
    tripTableColumnOrder = getDefaultTripTableColumnOrder();
    tripTableHiddenColumns = new Set();
    persistTripTableColumnPreferences();
    renderTripTableColumnControls();
    renderTrips(getRenderableTrips());
  });
}

function applyTripViewMode(value, { render = true, persist = true } = {}) {
  tripViewMode = normalizeTripViewMode(value);

  if (persist) {
    setStorage(TRIP_VIEW_STORAGE_KEY, tripViewMode);
  }

  document.querySelectorAll("[data-trip-view]").forEach((button) => {
    const active = button.dataset.tripView === tripViewMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });

  const columnsPanel = document.getElementById("trip-table-columns-panel");
  const columnsToggle = document.getElementById("trip-table-columns-toggle");
  if (tripViewMode !== "list" && columnsPanel && columnsToggle) {
    columnsPanel.hidden = true;
    columnsToggle.classList.remove("active");
    columnsToggle.setAttribute("aria-expanded", "false");
  }

  syncTripViewContainers();

  if (render) {
    renderTrips(getRenderableTrips());
  }
}

function syncTripViewContainers() {
  const timelineEl = document.getElementById("trips-timeline");
  const tableEl = document.getElementById("trips-list-view");
  const emptyEl = document.getElementById("trips-empty");
  const emptyVisible = emptyEl?.style.display === "block";

  if (timelineEl) {
    timelineEl.style.display =
      !emptyVisible && tripViewMode === "cards" ? "flex" : "none";
  }
  if (tableEl) {
    const showTable = !emptyVisible && tripViewMode === "list";
    tableEl.hidden = !showTable;
    tableEl.style.display = showTable ? "block" : "none";
  }
}

function getDefaultTripTableColumnOrder() {
  return TRIP_TABLE_COLUMNS.map((column) => column.key);
}

function getTripTableColumnByKey(key) {
  return TRIP_TABLE_COLUMNS.find((column) => column.key === key) || null;
}

function restoreTripTableColumnPreferences() {
  const saved = getStorage(TABLE_COLUMN_STORAGE_KEY, null);
  const defaultOrder = getDefaultTripTableColumnOrder();

  if (saved && Array.isArray(saved.order)) {
    const knownKeys = new Set(defaultOrder);
    const savedOrder = saved.order.filter((key) => knownKeys.has(key));
    const missingKeys = defaultOrder.filter((key) => !savedOrder.includes(key));
    tripTableColumnOrder = [...savedOrder, ...missingKeys];
  } else {
    tripTableColumnOrder = defaultOrder;
  }

  const hideableKeys = new Set(
    TRIP_TABLE_COLUMNS.filter((column) => column.hideable !== false).map(
      (column) => column.key
    )
  );
  tripTableHiddenColumns = new Set(
    Array.isArray(saved?.hidden)
      ? saved.hidden.filter((key) => hideableKeys.has(key))
      : []
  );

  renderTripTableColumnControls();
}

function persistTripTableColumnPreferences() {
  setStorage(TABLE_COLUMN_STORAGE_KEY, {
    order: tripTableColumnOrder,
    hidden: [...tripTableHiddenColumns],
  });
}

function getOrderedTripTableColumns({ includeHidden = false } = {}) {
  const keys = tripTableColumnOrder.length
    ? tripTableColumnOrder
    : getDefaultTripTableColumnOrder();

  return keys
    .map((key) => getTripTableColumnByKey(key))
    .filter(Boolean)
    .filter((column) => includeHidden || !tripTableHiddenColumns.has(column.key));
}

function renderTripTableColumnControls() {
  const list = document.getElementById("trip-column-list");
  if (!list) {
    return;
  }

  list.innerHTML = "";
  getOrderedTripTableColumns({ includeHidden: true }).forEach((column) => {
    const item = document.createElement("div");
    item.className = "trip-column-item";
    item.draggable = true;
    item.dataset.columnKey = column.key;
    item.innerHTML = `
      <span class="column-drag-handle" aria-hidden="true">
        <i class="fas fa-grip-vertical"></i>
      </span>
      <label class="column-toggle-label">
        <input type="checkbox"
               ${tripTableHiddenColumns.has(column.key) ? "" : "checked"}
               ${column.hideable === false ? "disabled" : ""}>
        <span>${escapeHtml(column.label)}</span>
      </label>
    `;

    item.addEventListener("dragstart", () => {
      draggedColumnKey = column.key;
      item.classList.add("is-dragging");
    });
    item.addEventListener("dragend", () => {
      draggedColumnKey = null;
      item.classList.remove("is-dragging");
    });
    item.addEventListener("dragover", (event) => {
      event.preventDefault();
      item.classList.add("is-drop-target");
    });
    item.addEventListener("dragleave", () => {
      item.classList.remove("is-drop-target");
    });
    item.addEventListener("drop", (event) => {
      event.preventDefault();
      item.classList.remove("is-drop-target");
      reorderTripTableColumn(draggedColumnKey, column.key);
    });

    const checkbox = item.querySelector("input");
    checkbox?.addEventListener("change", (event) => {
      if (column.hideable === false) {
        event.target.checked = true;
        return;
      }
      if (event.target.checked) {
        tripTableHiddenColumns.delete(column.key);
      } else {
        tripTableHiddenColumns.add(column.key);
      }
      persistTripTableColumnPreferences();
      renderTrips(getRenderableTrips());
    });

    list.appendChild(item);
  });
}

function reorderTripTableColumn(sourceKey, targetKey) {
  if (!sourceKey || !targetKey || sourceKey === targetKey) {
    return;
  }

  const nextOrder = tripTableColumnOrder.filter((key) => key !== sourceKey);
  const targetIndex = nextOrder.indexOf(targetKey);
  if (targetIndex === -1) {
    return;
  }
  nextOrder.splice(targetIndex, 0, sourceKey);
  tripTableColumnOrder = nextOrder;
  persistTripTableColumnPreferences();
  renderTripTableColumnControls();
  renderTrips(getRenderableTrips());
}

function getClientVisibleTrips() {
  const searchValue = document.getElementById("trip-search-input")?.value?.trim() || "";
  if (searchValue) {
    return [...filteredTrips];
  }
  if (filteredTrips.length > 0) {
    return [...filteredTrips];
  }
  return [...tripsData];
}

function getRenderableTrips() {
  const searchValue = document.getElementById("trip-search-input")?.value?.trim() || "";
  if (searchValue || filteredTrips.length > 0) {
    return filteredTrips;
  }
  return tripsData;
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
    if (isAbortError(err)) {
      return;
    }
    console.warn("Failed to load vehicles:", err);
  }
}

// ==========================================
// STATS LOADING
// ==========================================

async function loadTripStats() {
  try {
    const statsFilters = getStatsQueryFilters();
    if (hasDistanceFilters()) {
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

    if (metricsResult.status === "rejected" && !isAbortError(metricsResult.reason)) {
      console.warn("Failed to load trip metrics:", metricsResult.reason);
    }
    if (insightsResult.status === "rejected" && !isAbortError(insightsResult.reason)) {
      console.warn("Failed to load trip insights:", insightsResult.reason);
    }

    const metrics = metricsResult.status === "fulfilled" ? metricsResult.value : null;
    const insights =
      insightsResult.status === "fulfilled" ? insightsResult.value : null;

    if (!metrics && !insights) {
      return;
    }

    const toNumber = (value, defaultValue = 0) => {
      if (value === null || value === undefined) {
        return defaultValue;
      }
      const num = typeof value === "number" ? value : Number.parseFloat(value);
      return Number.isFinite(num) ? num : defaultValue;
    };

    const totalMiles = toNumber(metrics?.total_distance ?? insights?.total_distance, 0);
    const totalTripsCount = toNumber(metrics?.total_trips ?? insights?.total_trips, 0);
    const totalHours = Math.round(toNumber(metrics?.total_duration_seconds, 0) / 3600);

    updateOverviewStats({
      totalMiles,
      totalTrips: totalTripsCount,
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
    if (isAbortError(err)) {
      return;
    }
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
  const hasRenderedTrips = Boolean(
    document.querySelector(".trip-card, .trip-table-row")
  );
  showLoadingState(!hasRenderedTrips);

  try {
    const filters = getFilterValues();
    const sortRequest = getTripsSortRequest();

    const response = await apiPost(CONFIG.API.tripsDataTable, {
      draw: ++datatableDraw,
      start: (currentPage - 1) * pageSize,
      length: pageSize,
      search: { value: "" },
      order: sortRequest.order,
      columns: sortRequest.columns,
      filters,
    });

    tripsData = response?.data || [];
    totalTrips =
      response?.recordsFiltered ?? response?.recordsTotal ?? tripsData.length;
    filteredTripSummary = response?.filteredSummary || null;
    filteredTrips = [...tripsData];
    appliedTripSort = sortRequest.sort;

    if (tripsData.length === 0) {
      showEmptyState();
      if (hasDistanceFilters()) {
        updateFilteredStats();
      }
      updateFilterResultsPreview();
    } else {
      hideEmptyState();
      // Preserve any active client-side search across reloads (sort, pagination,
      // filter-chip removal, sync completion) instead of silently dropping it.
      const activeSearch =
        document.getElementById("trip-search-input")?.value?.trim() || "";
      if (activeSearch) {
        performSearch(activeSearch);
      } else {
        renderTrips(tripsData);
      }
      updatePagination();

      // Update stats based on filtered results
      if (hasDistanceFilters()) {
        updateFilteredStats();
      }
      updateFilterResultsPreview();
    }
  } catch (err) {
    if (isAbortError(err)) {
      return;
    }
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
    loadingEl.setAttribute("aria-hidden", show ? "false" : "true");
  }
}

function showEmptyState() {
  const emptyEl = document.getElementById("trips-empty");
  const timelineEl = document.getElementById("trips-timeline");
  const tableEl = document.getElementById("trips-list-view");
  const paginationEl = document.getElementById("trips-pagination");

  if (emptyEl) {
    emptyEl.style.display = "block";
  }
  if (timelineEl) {
    timelineEl.style.display = "none";
  }
  if (tableEl) {
    tableEl.hidden = true;
    tableEl.style.display = "none";
  }
  if (paginationEl) {
    paginationEl.style.display = "none";
  }
}

function hideEmptyState() {
  const emptyEl = document.getElementById("trips-empty");
  const paginationEl = document.getElementById("trips-pagination");

  if (emptyEl) {
    emptyEl.style.display = "none";
  }
  if (paginationEl) {
    paginationEl.style.display = "flex";
  }
  syncTripViewContainers();
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

function cacheTimelineDefaultTitles() {
  document.querySelectorAll(".timeline-section .timeline-title").forEach((titleEl) => {
    if (!titleEl.dataset.defaultTitle) {
      titleEl.dataset.defaultTitle = (titleEl.textContent || "").trim();
    }
  });
}

function restoreTimelineDefaultTitles() {
  cacheTimelineDefaultTitles();
  document.querySelectorAll(".timeline-section .timeline-title").forEach((titleEl) => {
    if (titleEl.dataset.defaultTitle) {
      titleEl.textContent = titleEl.dataset.defaultTitle;
    }
  });
}

function getFlatTripsTitle(sort) {
  const label = getTripSortLabel(sort);
  if (
    normalizeTripSort(sort) === "date_desc" ||
    normalizeTripSort(sort) === "date_asc"
  ) {
    return "Trips";
  }
  return `Sorted by ${label}`;
}

function renderTrips(trips) {
  const region = document.getElementById(tripViewMode === "list" ? "trips-list-view" : "trips-timeline");
  return updateRegion(region, () => renderTripResults(trips));
}

function renderTripResults(trips) {
  syncTripViewContainers();
  if (tripViewMode === "list") {
    renderTripsTable(trips);
    return;
  }

  const sort = normalizeTripSort(appliedTripSort);
  if (sort === "date_desc" || sort === "date_asc") {
    renderTripsTimeline(trips, { direction: sort === "date_asc" ? "asc" : "desc" });
  } else {
    renderTripsFlatList(trips, sort);
  }
}

function renderTripsFlatList(trips, sort) {
  restoreTimelineDefaultTitles();
  const { active: activeTrips, inactive: inactiveTrips } =
    splitTripsByActiveState(trips);

  // Hide all sections initially.
  document.querySelectorAll(".timeline-section").forEach((section) => {
    section.style.display = "none";
  });

  const container = document.getElementById("trips-today");
  const section = container?.closest(".timeline-section");
  const countEl = document.getElementById("count-today");
  const titleEl = section?.querySelector(".timeline-title");

  if (titleEl) {
    titleEl.textContent = getFlatTripsTitle(sort);
  }

  if (container && activeTrips.length > 0) {
    container.innerHTML = "";
    activeTrips.forEach((trip) => {
      const card = createTripCard(trip);
      container.appendChild(card);
    });

    if (section) {
      section.style.display = "block";
    }
    if (countEl) {
      countEl.textContent = `${activeTrips.length} trip${activeTrips.length !== 1 ? "s" : ""}`;
    }
  }

  renderInactiveTrips(inactiveTrips);
}

function renderTripsTimeline(trips, { direction = "desc" } = {}) {
  restoreTimelineDefaultTitles();
  const { active: activeTrips, inactive: inactiveTrips } =
    splitTripsByActiveState(trips);

  const groups = groupTripsByTimeline(activeTrips);
  const periodOrder =
    direction === "asc"
      ? ["older", "month", "week", "yesterday", "today"]
      : ["today", "yesterday", "week", "month", "older"];

  // Hide all sections initially.
  document.querySelectorAll(".timeline-section").forEach((section) => {
    section.style.display = "none";
  });

  periodOrder.forEach((period) => {
    const periodTrips = groups[period] || [];
    const container = document.getElementById(`trips-${period}`);
    const section = container?.closest(".timeline-section");
    const countEl = document.getElementById(`count-${period}`);

    if (container && periodTrips.length > 0) {
      container.innerHTML = "";
      periodTrips.forEach((trip) => {
        const card = createTripCard(trip);
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

  renderInactiveTrips(inactiveTrips);
}

function renderInactiveTrips(inactiveTrips) {
  const container = document.getElementById("trips-inactive");
  const section = container?.closest(".timeline-section");
  const countEl = document.getElementById("count-inactive");

  if (!container || !section) {
    return;
  }

  container.innerHTML = "";
  if (Array.isArray(inactiveTrips) && inactiveTrips.length > 0) {
    inactiveTrips.forEach((trip) => {
      const card = createTripCard(trip);
      container.appendChild(card);
    });
    section.style.display = "block";
    if (countEl) {
      countEl.textContent = `${inactiveTrips.length} trip${inactiveTrips.length !== 1 ? "s" : ""}`;
    }
    return;
  }

  section.style.display = "none";
  if (countEl) {
    countEl.textContent = "0 trips";
  }
}

function renderTripsTable(trips) {
  const head = document.getElementById("trips-table-head");
  const body = document.getElementById("trips-table-body");
  const summary = document.getElementById("trips-list-summary");

  if (!head || !body) {
    return;
  }

  const columns = getOrderedTripTableColumns();
  head.innerHTML = renderTripsTableHead(columns);
  bindTripTableHeaderSorting();
  body.innerHTML = "";

  if (summary) {
    const activeCount = trips.filter((trip) => !isInactiveTrip(trip)).length;
    const inactiveCount = trips.length - activeCount;
    summary.textContent = `${activeCount} active trip${
      activeCount === 1 ? "" : "s"
    } on this page${inactiveCount ? `, ${inactiveCount} inactive` : ""}`;
  }

  if (!trips.length) {
    const row = document.createElement("tr");
    row.className = "trip-table-empty-row";
    row.innerHTML = `
      <td colspan="${columns.length}">
        No trips match this view.
      </td>
    `;
    body.appendChild(row);
    return;
  }

  trips.forEach((trip) => {
    body.appendChild(createTripTableRow(trip, columns));
  });
}

function renderTripsTableHead(columns) {
  const activeDefinition =
    TRIP_SORT_DEFINITIONS[normalizeTripSort(appliedTripSort)] ||
    TRIP_SORT_DEFINITIONS[DEFAULT_TRIP_SORT];

  const cells = columns
    .map((column) => {
      const alignClass = column.align === "right" ? " is-right" : "";
      const sortKey = getColumnSortKey(column);
      const isActiveSort =
        column.sortable !== false &&
        Boolean(sortKey) &&
        activeDefinition.column === getSortColumnForKey(sortKey);
      const sortClass = isActiveSort ? " is-sorted" : "";
      const directionIcon =
        activeDefinition.dir === "asc" ? "fa-arrow-up" : "fa-arrow-down";

      if (column.sortable === false || !sortKey) {
        return `
          <th class="trip-table-heading${alignClass}" scope="col">
            <span class="trip-table-heading-label">
              <i class="fas ${column.icon}"></i>
              ${escapeHtml(column.label)}
            </span>
          </th>
        `;
      }

      return `
        <th class="trip-table-heading${alignClass}${sortClass}" scope="col">
          <button class="trip-table-sort-btn"
                  type="button"
                  data-sort-key="${escapeHtml(sortKey)}"
                  aria-label="Sort by ${escapeHtml(column.label)}">
            <span class="trip-table-heading-label">
              <i class="fas ${column.icon}"></i>
              ${escapeHtml(column.label)}
            </span>
            <i class="fas ${isActiveSort ? directionIcon : "fa-sort"} sort-icon"></i>
          </button>
        </th>
      `;
    })
    .join("");

  return `<tr>${cells}</tr>`;
}

function createTripTableRow(trip, columns) {
  const row = document.createElement("tr");
  row.className = "trip-table-row";
  row.dataset.tripId = trip.transactionId;
  row.classList.toggle("selected", selectedTripIds.has(trip.transactionId));
  row.classList.toggle("inactive", isInactiveTrip(trip));

  row.innerHTML = columns
    .map((column) => {
      const alignClass = column.align === "right" ? " is-right" : "";
      return `
        <td class="trip-table-cell trip-table-cell--${column.key}${alignClass}">
          ${column.render(trip)}
        </td>
      `;
    })
    .join("");

  bindTripTableRowEvents(row, trip);
  return row;
}

function bindTripTableHeaderSorting() {
  document.querySelectorAll(".trip-table-sort-btn").forEach((button) => {
    bindPageEvent(button, "click", () => {
      const { sortKey } = button.dataset;
      if (!sortKey) {
        return;
      }

      const activeDefinition =
        TRIP_SORT_DEFINITIONS[normalizeTripSort(appliedTripSort)] ||
        TRIP_SORT_DEFINITIONS[DEFAULT_TRIP_SORT];
      const activeColumn = activeDefinition.column;
      const nextDirection =
        activeColumn === getSortColumnForKey(sortKey) && activeDefinition.dir === "desc"
          ? "asc"
          : "desc";
      const nextSort = normalizeTripSort(`${sortKey}_${nextDirection}`);
      setStorage(CONFIG.STORAGE_KEYS.tripsSort, nextSort);
      currentPage = 1;
      loadTrips();
    });
  });
}

function bindTripTableRowEvents(row, trip) {
  row.addEventListener("click", (event) => {
    if (
      event.target.closest(".trip-table-select") ||
      event.target.closest(".trip-row-action-btn")
    ) {
      return;
    }
    openTripModal(trip.transactionId);
  });

  const checkbox = row.querySelector(".trip-table-select input");
  checkbox?.addEventListener("change", (event) => {
    event.stopPropagation();
    setTripSelected(trip.transactionId, event.target.checked);
  });

  bindTripActionButtons(row, trip);
}

function bindTripActionButtons(scope, trip) {
  const inactive = isInactiveTrip(trip);

  const viewBtn = scope.querySelector("[data-trip-action='view']");
  viewBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    openTripModal(trip.transactionId);
  });

  const rematchBtn = scope.querySelector("[data-trip-action='rematch']");
  rematchBtn?.addEventListener("click", async (event) => {
    event.stopPropagation();
    const confirmed = await confirmationDialog.show({
      title: "Rematch Trip",
      message: "Are you sure you want to run map matching on this trip again?",
      confirmText: "Rematch",
      confirmButtonClass: "btn-primary",
    });
    if (confirmed) {
      rematchTrip(trip.transactionId);
    }
  });

  const inactiveToggleBtn = scope.querySelector("[data-trip-action='inactive']");
  inactiveToggleBtn?.addEventListener("click", async (event) => {
    event.stopPropagation();
    const nextInactive = !inactive;
    const confirmed = await confirmationDialog.show({
      title: nextInactive ? "Mark Trip Inactive" : "Restore Trip",
      message: nextInactive
        ? "Keep this trip in history but exclude it from totals, maps, gas, routes, and coverage?"
        : "Restore this trip to totals, maps, gas, routes, and coverage again?",
      confirmText: nextInactive ? "Mark Inactive" : "Restore",
      confirmButtonClass: nextInactive ? "btn-warning" : "btn-primary",
    });
    if (confirmed) {
      await toggleTripInactive(trip.transactionId, nextInactive);
    }
  });

  const deleteBtn = scope.querySelector("[data-trip-action='delete']");
  deleteBtn?.addEventListener("click", async (event) => {
    event.stopPropagation();
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
}

function createTripCard(trip) {
  const card = document.createElement("div");
  card.className = "trip-card";
  card.dataset.tripId = trip.transactionId;
  const inactive = isInactiveTrip(trip);

  if (inactive) {
    card.classList.add("inactive");
  }

  if (selectedTripIds.has(trip.transactionId)) {
    card.classList.add("selected");
  }

  // Generate smart content
  const title = generateSmartTitle(trip);
  const badges = getTripBadges(trip);
  const distance = parseFloat(trip.distance) || 0;

  // Format times
  const duration = trip.duration ? formatDuration(trip.duration) : "--";
  const timeAgo = formatRelativeTime(trip.startTime);
  const tripCost = formatCurrency(trip.estimated_cost);
  const footerLabel = inactive ? `Excluded from totals · ${timeAgo}` : timeAgo;

  card.innerHTML = `
    <div class="trip-card-checkbox">
      <input type="checkbox" ${selectedTripIds.has(trip.transactionId) ? "checked" : ""}>
    </div>
    <div class="trip-card-map">
      <svg class="trip-route-line" viewBox="0 0 100 40" preserveAspectRatio="none">
        <path class="route-main" d="M 5,35 Q 25,5 50,20 T 95,15" stroke="var(--primary)" stroke-linecap="round" stroke-linejoin="round"/>
        <circle class="route-start" cx="5" cy="35" r="2.5"/>
        <circle class="route-end" cx="95" cy="15" r="2.5"/>
      </svg>
      <div class="trip-map-fade"></div>
      <span class="trip-map-distance">${distance.toFixed(1)} mi</span>
    </div>
    <div class="trip-card-content">
      <div class="trip-card-header">
        <h3 class="trip-title">${escapeHtml(title)}</h3>
        ${
          inactive || badges.length > 0
            ? `
          <div class="trip-badges">
            ${inactive ? '<span class="trip-badge inactive">Inactive</span>' : ""}
            ${badges.map((b) => `<span class="trip-badge ${b.class}">${b.text}</span>`).join("")}
          </div>
        `
            : ""
        }
      </div>

      <div class="trip-route-timeline">
        <div class="timeline-dots">
          <span class="timeline-dot start"></span>
          <span class="timeline-connector"></span>
          <span class="timeline-dot end"></span>
        </div>
        <div class="timeline-labels">
          <span class="timeline-label">${escapeHtml(sanitizeLocation(trip.startLocation))}</span>
          <span class="timeline-label">${escapeHtml(sanitizeLocation(trip.destination))}</span>
        </div>
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
          <i class="fas fa-dollar-sign"></i>
          ${escapeHtml(tripCost)}
        </span>
        <span class="trip-meta-item">
          <i class="fas fa-car"></i>
          ${escapeHtml(trip.vehicleLabel || "Unknown")}
        </span>
      </div>

      <div class="trip-card-footer">
        <span class="trip-date">${escapeHtml(footerLabel)}</span>
        <div class="trip-actions">
          ${
            inactive
              ? ""
              : `
          <button class="trip-action-btn rematch"
                  title="Rematch trip"
                  aria-label="Rematch trip">
            <i class="fas fa-route"></i>
          </button>
          `
          }
          <button class="trip-action-btn inactive-toggle"
                  title="${inactive ? "Restore trip" : "Exclude from totals and maps"}"
                  aria-label="${inactive ? "Restore trip" : "Exclude trip from totals and maps"}">
            <i class="fas ${inactive ? "fa-rotate-left" : "fa-eye-slash"}"></i>
          </button>
          <button class="trip-action-btn"
                  title="View details"
                  aria-label="View trip details">
            <i class="fas fa-map"></i>
          </button>
          <button class="trip-action-btn delete"
                  title="Delete"
                  aria-label="Delete trip">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>
    </div>
  `;

  const previewPath = getTripPreviewPath(trip);
  if (previewPath) {
    const svg = card.querySelector(".trip-route-line");
    const mainPath = svg.querySelector(".route-main");
    if (mainPath) {
      mainPath.setAttribute("d", previewPath);

      // Parse first and last coordinates from path for start/end markers
      const coords = previewPath.match(/[\d.]+[\s,][\d.]+/g);
      if (coords && coords.length >= 2) {
        const first = coords[0].split(/[\s,]+/);
        const last = coords[coords.length - 1].split(/[\s,]+/);
        const startCircle = svg.querySelector(".route-start");
        const endCircle = svg.querySelector(".route-end");
        if (startCircle) {
          startCircle.setAttribute("cx", first[0]);
          startCircle.setAttribute("cy", first[1]);
        }
        if (endCircle) {
          endCircle.setAttribute("cx", last[0]);
          endCircle.setAttribute("cy", last[1]);
        }
      }
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
    setTripSelected(trip.transactionId, e.target.checked);
  });

  const viewBtn = card.querySelector('.trip-action-btn[title="View details"]');
  viewBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openTripModal(trip.transactionId);
  });

  const rematchBtn = card.querySelector(".trip-action-btn.rematch");
  if (rematchBtn) {
    rematchBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const confirmed = await confirmationDialog.show({
        title: "Rematch Trip",
        message: "Are you sure you want to run map matching on this trip again?",
        confirmText: "Rematch",
        confirmButtonClass: "btn-primary",
      });
      if (confirmed) {
        rematchTrip(trip.transactionId);
      }
    });
  }

  const inactiveToggleBtn = card.querySelector(".trip-action-btn.inactive-toggle");
  inactiveToggleBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const nextInactive = !inactive;
    const confirmed = await confirmationDialog.show({
      title: nextInactive ? "Mark Trip Inactive" : "Restore Trip",
      message: nextInactive
        ? "Keep this trip in history but exclude it from totals, maps, gas, routes, and coverage?"
        : "Restore this trip to totals, maps, gas, routes, and coverage again?",
      confirmText: nextInactive ? "Mark Inactive" : "Restore",
      confirmButtonClass: nextInactive ? "btn-warning" : "btn-primary",
    });
    if (confirmed) {
      await toggleTripInactive(trip.transactionId, nextInactive);
    }
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

function setupSearchAndFilters(cleanup) {
  // Search input
  const searchInput = document.getElementById("trip-search-input");
  const searchClear = document.getElementById("search-clear-btn");

  if (searchInput) {
    let searchTimeout;
    cleanup?.(() => clearTimeout(searchTimeout));
    bindPageEvent(searchInput, "input", (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        performSearch(e.target.value);
      }, 300);
    });
  }

  if (searchClear) {
    bindPageEvent(searchClear, "click", () => {
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
    bindPageEvent(filterToggle, "click", () => {
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
  bindPageEvent("trip-filter-apply", "click", () => {
    currentPage = 1;
    loadTrips();
    updateFilterChips();
    const { hasLocalFilters } = getFilterState();
    if (hasLocalFilters) {
      showFilterFeedback();
    } else {
      clearFilterFeedback();
    }

    if (!hasDistanceFilters()) {
      loadTripStats();
    }

    // Close filters panel on mobile
    if (window.innerWidth < 768 && filtersPanel) {
      filtersPanel.classList.remove("is-open");
      filterToggle?.classList.remove("active");
      filterToggle?.setAttribute("aria-expanded", "false");
    }
  });

  // Reset filters
  bindPageEvent("trip-filter-reset", "click", () => {
    document.querySelectorAll(".filter-select, .filter-group input").forEach((el) => {
      if (el.type === "checkbox") {
        el.checked = false;
      } else {
        el.value = "";
      }
      el.classList.remove("has-value");
    });

    setStorage(CONFIG.STORAGE_KEYS.selectedVehicle, null);
    store.updateFilters({ vehicle: null }, { source: "vehicle" });

    currentPage = 1;
    loadTrips();
    updateFilterChips();
    if (!hasDistanceFilters()) {
      loadTripStats();
    }

    clearFilterFeedback();
  });

  // Sort selection
  bindPageEvent("trip-sort-select", "change", (e) => {
    const normalized = normalizeTripSort(e.target.value);
    e.target.value = normalized;
    setStorage(CONFIG.STORAGE_KEYS.tripsSort, normalized);
    e.target.classList.toggle("has-value", normalized !== DEFAULT_TRIP_SORT);

    // Sorting is a view operation; apply immediately so users don't need to hit "Apply Filters".
    currentPage = 1;
    updateFilterChips();
    loadTrips();
  });

  // Vehicle filter
  bindPageEvent("trip-filter-vehicle", "change", (e) => {
    setStorage(CONFIG.STORAGE_KEYS.selectedVehicle, e.target.value || null);
    store.updateFilters({ vehicle: e.target.value || null }, { source: "vehicle" });
    e.target.classList.toggle("has-value", e.target.value);
  });

  // Distance filters - add has-value class
  ["trip-filter-distance-min", "trip-filter-distance-max"].forEach((id) => {
    bindPageEvent(id, "input", (e) => {
      e.target.classList.toggle("has-value", e.target.value);
    });
  });

  updateFilterChips();
}

function clearFilterFeedback() {
  document.querySelectorAll(".stat-pill").forEach((pill) => {
    pill.classList.remove("filtered");
  });
  document.getElementById("trips-filters-panel")?.classList.remove("has-filters");
  document.querySelector(".trips-search-section")?.classList.remove("has-filters");
  document.getElementById("filters-status")?.style.setProperty("display", "none");
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
  if (filterCount?.textContent && filterCount.textContent !== "0") {
    notificationManager.show(
      `${filterCount.textContent} filter${filterCount.textContent !== "1" ? "s" : ""} applied`,
      "info",
      { duration: 2000 }
    );
  }
}

function updateFilteredStats() {
  const summary = filteredTripSummary;
  if (!summary) {
    return;
  }

  const totalMiles =
    summary.totalDistance === null ? null : Number(summary.totalDistance);
  const totalTripsCount = Number(summary.totalTrips) || 0;
  const totalHours =
    summary.totalDurationSeconds === null
      ? null
      : Math.round(Number(summary.totalDurationSeconds) / 3600);

  updateOverviewStats({
    totalMiles,
    totalTrips: totalTripsCount,
    totalHours,
  });

  updateFilteredInsights(summary);
}

function updateFilteredInsights(summary) {
  const longestTrip = Number(summary.longestDistance);
  const hasLongestTrip =
    summary.longestDistance !== null && Number.isFinite(longestTrip);
  const totalFuel = Number(summary.totalFuel);
  const hasFuel = summary.totalFuel !== null && Number.isFinite(totalFuel);

  // Animate insight card updates
  const longestEl = document.getElementById("insight-longest");
  const fuelEl = document.getElementById("insight-fuel");

  if (longestEl) {
    longestEl.style.opacity = "0";
    setTimeout(() => {
      longestEl.textContent = hasLongestTrip ? `${longestTrip.toFixed(1)} mi` : "--";
      longestEl.style.opacity = "1";
    }, 150);
  }

  if (fuelEl) {
    fuelEl.style.opacity = "0";
    setTimeout(() => {
      fuelEl.textContent = hasFuel ? `${totalFuel.toFixed(1)} gal` : "--";
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

  renderTrips(filteredTrips);
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
  const start_date = DateUtils.getStartDate() || null;
  const end_date = DateUtils.getEndDate() || null;
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
      const el = document.getElementById("trip-filter-vehicle");
      if (el) {
        el.value = "";
        el.classList.remove("has-value");
      }
      setStorage(CONFIG.STORAGE_KEYS.selectedVehicle, null);
      store.updateFilters({ vehicle: null }, { source: "vehicle" });
    });
  }

  if (filters.distance_min || filters.distance_max) {
    addChip(
      `Distance: ${filters.distance_min || "0"} - ${filters.distance_max || "∞"} mi`,
      () => {
        const minEl = document.getElementById("trip-filter-distance-min");
        const maxEl = document.getElementById("trip-filter-distance-max");
        if (minEl) {
          minEl.value = "";
          minEl.classList.remove("has-value");
        }
        if (maxEl) {
          maxEl.value = "";
          maxEl.classList.remove("has-value");
        }
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

  const visibleTrips = getClientVisibleTrips();
  const activeVisibleTrips = visibleTrips.filter((trip) => !isInactiveTrip(trip));
  const inactiveCount = visibleTrips.length - activeVisibleTrips.length;
  const { hasLocalFilters } = getFilterState();

  if (hasLocalFilters && visibleTrips.length > 0) {
    const totalMiles = activeVisibleTrips.reduce(
      (sum, trip) => sum + (parseFloat(trip.distance) || 0),
      0
    );
    previewEl.innerHTML = `
      <span class="results-count">${activeVisibleTrips.length}</span> active trips
      <span style="color: var(--text-tertiary);">•</span>
      ${totalMiles.toFixed(1)} mi
      ${
        inactiveCount > 0
          ? `<span style="color: var(--text-tertiary);">•</span>${inactiveCount} inactive excluded`
          : ""
      }
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

function setTripSelected(tripId, selected) {
  if (!tripId) {
    return;
  }

  if (selected) {
    selectedTripIds.add(tripId);
  } else {
    selectedTripIds.delete(tripId);
  }

  document.querySelectorAll(".trip-card, .trip-table-row").forEach((el) => {
    if (el.dataset.tripId !== tripId) {
      return;
    }
    el.classList.toggle("selected", selected);
    const checkbox = el.querySelector(
      ".trip-card-checkbox input, .trip-table-select input"
    );
    if (checkbox) {
      checkbox.checked = selected;
    }
  });

  updateBulkActionsBar();
}

function getVisibleTripSelectionElements() {
  return Array.from(document.querySelectorAll(".trip-card, .trip-table-row")).filter(
    (el) => el.offsetParent !== null
  );
}

function setupBulkActions() {
  const _bulkBar = document.getElementById("bulk-actions-bar");
  const selectAllBtn = document.getElementById("bulk-select-all-btn");
  const deleteBtn = document.getElementById("bulk-delete-trips-btn");
  const closeBtn = document.getElementById("bulk-close-btn");

  if (selectAllBtn) {
    bindPageEvent(selectAllBtn, "click", () => {
      const visibleTrips = getVisibleTripSelectionElements();
      const allSelected =
        visibleTrips.length > 0 &&
        visibleTrips.every((el) => selectedTripIds.has(el.dataset.tripId));

      visibleTrips.forEach((el) => {
        setTripSelected(el.dataset.tripId, !allSelected);
      });
    });
  }

  if (deleteBtn) {
    bindPageEvent(deleteBtn, "click", async () => {
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
    bindPageEvent(closeBtn, "click", () => {
      selectedTripIds.clear();
      document.querySelectorAll(".trip-card, .trip-table-row").forEach((el) => {
        el.classList.remove("selected");
        const checkbox = el.querySelector(
          ".trip-card-checkbox input, .trip-table-select input"
        );
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
  if (!bulkBar || !countEl) {
    return;
  }

  if (selectedTripIds.size > 0) {
    bulkBar.style.display = "flex";
    countEl.textContent = `${selectedTripIds.size} selected`;
  } else {
    bulkBar.style.display = "none";
  }
}

function setupTripCardInteractions() {
  // Pagination buttons
  bindPageEvent("prev-page", "click", () => {
    if (currentPage > 1) {
      currentPage--;
      loadTrips();
    }
  });

  bindPageEvent("next-page", "click", () => {
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

async function rematchTrip(id) {
  try {
    loadingManager.show("Queueing map matching job...");
    const res = await apiPost("/api/map_matching/jobs", {
      mode: "trip_id",
      trip_id: id,
      rematch: true,
      unmatched_only: false,
    });
    if (res) {
      notificationManager.show(
        "Map matching job queued. View progress in Map Matching.",
        "success"
      );
      // Optionally reload the map after a short delay
      setTimeout(() => {
        loadTrips();
      }, 3000);
    }
  } catch (err) {
    console.error("Rematch error:", err);
    notificationManager.show(`Map matching error: ${err.message}`, "danger");
  } finally {
    loadingManager.hide();
  }
}

async function deleteTrip(id) {
  try {
    await optimisticAction({
      optimistic: () => {
        tripsData = tripsData.filter((t) => t.transactionId !== id);
        filteredTrips = filteredTrips.filter((t) => t.transactionId !== id);
        renderTrips(filteredTrips);
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
        renderTrips(filteredTrips);
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

function mergeTripIntoState(updatedTrip) {
  if (!updatedTrip?.transactionId) {
    return;
  }

  const mergeTrip = (trip) =>
    trip?.transactionId === updatedTrip.transactionId
      ? { ...trip, ...updatedTrip }
      : trip;

  tripsData = tripsData.map(mergeTrip);
  filteredTrips = filteredTrips.map(mergeTrip);

  mergeIntoOpenTrip(updatedTrip);
}

async function toggleTripInactive(id, inactive) {
  try {
    const response = await apiPost(CONFIG.API.tripInactive(id), { inactive });
    mergeTripIntoState(response?.trip || { transactionId: id, inactive });
    renderTrips(filteredTrips);
    updateFilterResultsPreview();
    await loadTripStats();

    refreshOpenTrip(id);

    notificationManager.show(
      inactive ? "Trip excluded from app totals" : "Trip restored to app totals",
      "success"
    );
  } catch (err) {
    console.error("Failed to toggle inactive trip state:", err);
    notificationManager.show(err?.message || "Failed to update trip state", "danger");
  }
}
