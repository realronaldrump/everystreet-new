/* global Chart, notificationManager, bootstrap, L */
"use strict";

/**
 * Coverage Dashboard - Visualize and track progress for driving every street
 */
(() => {
  // ==============================
  // Configuration
  // ==============================
  const CONFIG = {
    STORAGE_KEYS: {
      selectedLocation: "selectedLocation",
      goalDate: "goalCompletionDate",
    },
    CHART_COLORS: {
      primary: "#BB86FC",
      secondary: "#03DAC6",
      accent: "#CF6679",
      background: "rgba(30, 30, 30, 0.8)",
      grid: "rgba(255, 255, 255, 0.1)",
      text: "rgba(255, 255, 255, 0.7)",
    },
    REFRESH_INTERVAL: 60000, // 1 minute
    PAGE_SIZE: 20,
  };

  // ==============================
  // State Management
  // ==============================
  const state = {
    locations: [],
    selectedLocation: null,
    coverageData: null,
    streetData: {
      streets: [],
      filteredStreets: [],
      currentPage: 0,
      searchTerm: "",
    },
    charts: {
      weeklyProgress: null,
      areaCoverage: null,
    },
    routeSuggestion: {
      map: null,
      routeLayer: null,
    },
    goalDate: null,
  };

  // ==============================
  // DOM Elements
  // ==============================
  const elements = {
    // Buttons and controls
    refreshBtn: document.getElementById("refresh-dashboard"),
    locationSelector: document.getElementById("location-selector"),
    locationDropdown: document.getElementById("location-dropdown"),
    viewOnMapBtn: document.getElementById("view-on-map"),
    suggestRouteBtn: document.getElementById("suggest-route"),
    updateCoverageBtn: document.getElementById("update-coverage"),
    streetSearchInput: document.getElementById("street-search"),
    streetSearchBtn: document.getElementById("street-search-btn"),
    prevPageBtn: document.getElementById("prev-page"),
    nextPageBtn: document.getElementById("next-page"),
    goalDateInput: document.getElementById("goal-date"),

    // Display elements
    overallProgressCircle: document.getElementById("overall-progress-circle"),
    overallProgressPercentage: document.getElementById(
      "overall-progress-percentage",
    ),
    drivenMiles: document.getElementById("driven-miles"),
    totalMiles: document.getElementById("total-miles"),
    lastTripDate: document.getElementById("last-trip-date"),
    newStreetsCount: document.getElementById("new-streets-count"),
    lastWeekProgress: document.getElementById("last-week-progress"),
    lastMonthProgress: document.getElementById("last-month-progress"),
    dailyGoalMiles: document.getElementById("daily-goal-miles"),
    estimatedCompletion: document.getElementById("estimated-completion"),
    streetsTable: document
      .getElementById("streets-table")
      .querySelector("tbody"),
    showingStart: document.getElementById("showing-start"),
    showingEnd: document.getElementById("showing-end"),
    totalStreets: document.getElementById("total-streets"),

    // Charts
    weeklyProgressChart: document.getElementById("weekly-progress-chart"),
    areaCoverageChart: document.getElementById("area-coverage-chart"),

    // Route suggestion modal
    routeSuggestionModal: document.getElementById("route-suggestion-modal"),
    routeType: document.getElementById("route-type"),
    routeLength: document.getElementById("route-length"),
    routeLengthValue: document.getElementById("route-length-value"),
    routeMapContainer: document.getElementById("route-map-container"),
    exportRouteBtn: document.getElementById("export-route"),
  };

  // ==============================
  // Initialization
  // ==============================
  function init() {
    loadSavedState();
    setupEventListeners();
    initCharts();
    loadLocations();

    // Update route length display when slider changes
    elements.routeLength.addEventListener("input", () => {
      elements.routeLengthValue.textContent = `${elements.routeLength.value} miles`;
    });

    // Set up auto-refresh
    setInterval(refreshDashboard, CONFIG.REFRESH_INTERVAL);
  }

  function loadSavedState() {
    // Load selected location from localStorage
    const savedLocation = localStorage.getItem(
      CONFIG.STORAGE_KEYS.selectedLocation,
    );
    if (savedLocation) {
      try {
        state.selectedLocation = JSON.parse(savedLocation);
      } catch (e) {
        console.error("Error parsing saved location:", e);
      }
    }

    // Load goal date from localStorage
    const savedGoalDate = localStorage.getItem(CONFIG.STORAGE_KEYS.goalDate);
    if (savedGoalDate) {
      state.goalDate = savedGoalDate;
      elements.goalDateInput.value = savedGoalDate;
    }
  }

  function setupEventListeners() {
    // Refresh dashboard
    elements.refreshBtn.addEventListener("click", refreshDashboard);

    // Location selection
    elements.locationDropdown.addEventListener("click", handleLocationSelect);

    // Quick actions
    elements.viewOnMapBtn.addEventListener("click", viewOnMap);
    elements.suggestRouteBtn.addEventListener("click", showRouteSuggestion);
    elements.updateCoverageBtn.addEventListener("click", updateCoverage);

    // Street search
    elements.streetSearchBtn.addEventListener("click", searchStreets);
    elements.streetSearchInput.addEventListener("keyup", (e) => {
      if (e.key === "Enter") searchStreets();
    });

    // Pagination
    elements.prevPageBtn.addEventListener("click", () => changePage(-1));
    elements.nextPageBtn.addEventListener("click", () => changePage(1));

    // Goal date
    elements.goalDateInput.addEventListener("change", updateGoalDate);

    // Export route
    elements.exportRouteBtn.addEventListener("click", exportSuggestedRoute);
  }

  // ==============================
  // Data Loading
  // ==============================
  async function loadLocations() {
    try {
      const response = await fetch("/api/coverage_areas");
      if (!response.ok) throw new Error("Failed to load coverage areas");

      const data = await response.json();
      state.locations = data; // API now returns an array directly

      // Populate dropdown
      renderLocationDropdown();

      // If we have a saved location, select it
      if (state.selectedLocation) {
        selectLocation(state.selectedLocation);
      } else if (data.length > 0) {
        // Otherwise select the first location
        selectLocation(data[0]);
      }
    } catch (error) {
      notificationManager.show(
        "Failed to load coverage areas: " + error.message,
        "danger",
      );
    }
  }

  async function loadCoverageData(location) {
    try {
      const response = await fetch(`/api/coverage_data/${location.id}`);
      if (!response.ok) throw new Error("Failed to load coverage data");

      const data = await response.json();
      state.coverageData = data;

      // Update UI with coverage data
      updateDashboardUI();

      // Load street data
      await loadStreetData(location);
    } catch (error) {
      notificationManager.show(
        "Failed to load coverage data: " + error.message,
        "danger",
      );
    }
  }

  async function loadStreetData(location) {
    try {
      const response = await fetch(`/api/streets/${location.id}`);
      if (!response.ok) throw new Error("Failed to load street data");

      const data = await response.json();

      // Ensure each street has the required properties
      const processedStreets = data.map((street) => ({
        id: street.id,
        name: street.name || "Unknown Street",
        length: street.length || 0,
        coverage: street.coverage || 0,
        last_driven: street.last_driven || null,
        geometry: street.geometry,
      }));

      state.streetData.streets = processedStreets;
      state.streetData.filteredStreets = [...processedStreets];
      state.streetData.currentPage = 0;

      // Update street table
      renderStreetTable();
    } catch (error) {
      notificationManager.show(
        "Failed to load street data: " + error.message,
        "danger",
      );
    }
  }

  async function loadProgressHistory(location) {
    try {
      const response = await fetch(`/api/coverage_history/${location.id}`);
      if (!response.ok) throw new Error("Failed to load progress history");

      const data = await response.json();

      // Update charts with historical data
      updateProgressCharts(data);
    } catch (error) {
      notificationManager.show(
        "Failed to load progress history: " + error.message,
        "danger",
      );
    }
  }

  // ==============================
  // UI Rendering
  // ==============================
  function renderLocationDropdown() {
    const { locations } = state;

    if (!locations || locations.length === 0) {
      elements.locationDropdown.innerHTML = `
        <li><span class="dropdown-item-text text-muted">No locations available</span></li>
      `;
      return;
    }

    const locationItems = locations
      .map(
        (location) => `
      <li>
        <a class="dropdown-item" href="#" data-location-id="${location.id}">
          ${location.display_name || "Unknown Location"}
        </a>
      </li>
    `,
      )
      .join("");

    elements.locationDropdown.innerHTML = locationItems;
  }

  function updateDashboardUI() {
    const { coverageData } = state;

    if (!coverageData) return;

    // Update overall progress
    const progressPercentage = coverageData.coverage_percentage;
    elements.overallProgressPercentage.textContent = `${Math.round(progressPercentage)}%`;
    elements.overallProgressCircle.style.background = `conic-gradient(var(--bs-primary) 0%, var(--bs-primary) ${progressPercentage}%, #2c3034 ${progressPercentage}%)`;

    // Update mileage
    const drivenMiles = (coverageData.driven_length / 1609.34).toFixed(1);
    const totalMiles = (coverageData.total_length / 1609.34).toFixed(1);
    elements.drivenMiles.textContent = drivenMiles;
    elements.totalMiles.textContent = totalMiles;

    // Update recent activity
    elements.lastTripDate.textContent = coverageData.last_trip_date || "--";
    elements.newStreetsCount.textContent =
      coverageData.new_streets_count || "0";
    elements.lastWeekProgress.textContent = `+${coverageData.last_week_progress || 0}%`;
    elements.lastMonthProgress.textContent = `+${coverageData.last_month_progress || 0}%`;

    // Update goal tracking
    updateGoalTracking();

    // Update location selector button text
    if (state.selectedLocation) {
      elements.locationSelector.textContent =
        state.selectedLocation.display_name;
    }
  }

  function renderStreetTable() {
    const { streets, filteredStreets, currentPage } = state.streetData;
    const pageSize = CONFIG.PAGE_SIZE;

    // Calculate pagination
    const startIndex = currentPage * pageSize;
    const endIndex = Math.min(startIndex + pageSize, filteredStreets.length);
    const totalStreets = filteredStreets.length;

    // Update pagination info
    elements.showingStart.textContent = totalStreets > 0 ? startIndex + 1 : 0;
    elements.showingEnd.textContent = endIndex;
    elements.totalStreets.textContent = totalStreets;

    // Enable/disable pagination buttons
    elements.prevPageBtn.disabled = currentPage === 0;
    elements.nextPageBtn.disabled = endIndex >= totalStreets;

    // Get streets for current page
    const currentPageStreets = filteredStreets.slice(startIndex, endIndex);

    // Render table rows
    elements.streetsTable.innerHTML = currentPageStreets
      .map((street) => {
        const coverage = street.coverage || 0;
        const lengthMiles = (street.length / 1609.34).toFixed(2);
        const lastDriven = street.last_driven || "Never";

        return `
        <tr>
          <td>${street.name}</td>
          <td>${lengthMiles}</td>
          <td>
            <div class="d-flex align-items-center">
              <div class="coverage-bar me-2 flex-grow-1">
                <div class="coverage-progress" style="width: ${coverage}%"></div>
              </div>
              <span>${Math.round(coverage)}%</span>
            </div>
          </td>
          <td>${lastDriven}</td>
          <td>
            <button class="btn btn-sm btn-outline-primary view-street-btn" data-street-id="${street.id}">
              <i class="fas fa-eye"></i>
            </button>
          </td>
        </tr>
      `;
      })
      .join("");

    // Add event listeners to view buttons
    document.querySelectorAll(".view-street-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const streetId = btn.dataset.streetId;
        viewStreetOnMap(streetId);
      });
    });
  }

  function updateGoalTracking() {
    if (!state.coverageData) return;

    const { coverageData } = state;
    const goalDate = state.goalDate ? new Date(state.goalDate) : null;

    if (!goalDate) {
      elements.dailyGoalMiles.textContent = "Set a goal date";
      elements.estimatedCompletion.textContent = "--";
      return;
    }

    const today = new Date();
    const daysRemaining = Math.ceil((goalDate - today) / (1000 * 60 * 60 * 24));

    if (daysRemaining <= 0) {
      elements.dailyGoalMiles.textContent = "Goal date passed";
      elements.estimatedCompletion.textContent = "Goal date passed";
      return;
    }

    // Calculate remaining miles
    const totalMiles = coverageData.total_length / 1609.34;
    const drivenMiles = coverageData.driven_length / 1609.34;
    const remainingMiles = totalMiles - drivenMiles;

    // Calculate daily goal
    const dailyGoal = remainingMiles / daysRemaining;
    elements.dailyGoalMiles.textContent = `${dailyGoal.toFixed(1)} miles/day`;

    // Calculate estimated completion date based on recent progress
    const recentDailyAverage = coverageData.recent_daily_average || 0;

    if (recentDailyAverage <= 0) {
      elements.estimatedCompletion.textContent = "No recent progress";
      return;
    }

    const daysToCompletion = remainingMiles / recentDailyAverage;
    const estimatedCompletionDate = new Date();
    estimatedCompletionDate.setDate(
      today.getDate() + Math.ceil(daysToCompletion),
    );

    const options = { year: "numeric", month: "short", day: "numeric" };
    elements.estimatedCompletion.textContent =
      estimatedCompletionDate.toLocaleDateString(undefined, options);
  }

  // ==============================
  // Chart Initialization and Updates
  // ==============================
  function initCharts() {
    // Weekly progress chart
    const weeklyCtx = elements.weeklyProgressChart.getContext("2d");
    state.charts.weeklyProgress = new Chart(weeklyCtx, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            label: "Coverage %",
            data: [],
            borderColor: CONFIG.CHART_COLORS.primary,
            backgroundColor: "rgba(187, 134, 252, 0.1)",
            tension: 0.3,
            fill: true,
          },
        ],
      },
      options: getChartOptions("Weekly Coverage Progress"),
    });

    // Area coverage chart
    const areaCtx = elements.areaCoverageChart.getContext("2d");
    state.charts.areaCoverage = new Chart(areaCtx, {
      type: "doughnut",
      data: {
        labels: ["Covered", "Remaining"],
        datasets: [
          {
            data: [0, 100],
            backgroundColor: [
              CONFIG.CHART_COLORS.primary,
              CONFIG.CHART_COLORS.background,
            ],
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "bottom",
            labels: {
              color: CONFIG.CHART_COLORS.text,
              padding: 20,
              font: {
                size: 12,
              },
            },
          },
          tooltip: {
            backgroundColor: CONFIG.CHART_COLORS.background,
            titleColor: "#fff",
            bodyColor: "#fff",
            displayColors: false,
            callbacks: {
              label: function (context) {
                return `${context.label}: ${context.raw}%`;
              },
            },
          },
        },
        cutout: "70%",
      },
    });
  }

  function getChartOptions(title) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          backgroundColor: CONFIG.CHART_COLORS.background,
          titleColor: "#fff",
          bodyColor: "#fff",
          mode: "index",
          intersect: false,
        },
        title: {
          display: false,
          text: title,
        },
      },
      scales: {
        x: {
          grid: {
            color: CONFIG.CHART_COLORS.grid,
          },
          ticks: {
            color: CONFIG.CHART_COLORS.text,
          },
        },
        y: {
          grid: {
            color: CONFIG.CHART_COLORS.grid,
          },
          ticks: {
            color: CONFIG.CHART_COLORS.text,
          },
          beginAtZero: true,
        },
      },
    };
  }

  function updateProgressCharts(historyData) {
    if (
      !historyData ||
      !state.charts.weeklyProgress ||
      !state.charts.areaCoverage
    )
      return;

    // Update weekly progress chart
    const weeklyData = historyData.weekly || [];
    const labels = weeklyData.map((item) => item.date);
    const data = weeklyData.map((item) => item.coverage_percentage);

    state.charts.weeklyProgress.data.labels = labels;
    state.charts.weeklyProgress.data.datasets[0].data = data;
    state.charts.weeklyProgress.update();

    // Update area coverage chart
    if (state.coverageData) {
      const coverage = Math.round(state.coverageData.coverage_percentage);
      const remaining = 100 - coverage;

      state.charts.areaCoverage.data.datasets[0].data = [coverage, remaining];
      state.charts.areaCoverage.update();
    }
  }

  // ==============================
  // Event Handlers
  // ==============================
  function handleLocationSelect(e) {
    const target = e.target.closest("[data-location-id]");
    if (!target) return;

    e.preventDefault();

    const locationId = target.dataset.locationId;
    const location = state.locations.find((loc) => loc.id === locationId);

    if (location) {
      selectLocation(location);
    }
  }

  function selectLocation(location) {
    state.selectedLocation = location;

    // Save to localStorage
    localStorage.setItem(
      CONFIG.STORAGE_KEYS.selectedLocation,
      JSON.stringify(location),
    );

    // Update UI
    elements.locationSelector.textContent = location.display_name;

    // Load data for selected location
    loadCoverageData(location);
    loadProgressHistory(location);
  }

  function refreshDashboard() {
    if (state.selectedLocation) {
      loadCoverageData(state.selectedLocation);
      loadProgressHistory(state.selectedLocation);
    } else {
      loadLocations();
    }
  }

  function searchStreets() {
    const searchTerm = elements.streetSearchInput.value.trim().toLowerCase();
    state.streetData.searchTerm = searchTerm;

    if (!searchTerm) {
      state.streetData.filteredStreets = [...state.streetData.streets];
    } else {
      state.streetData.filteredStreets = state.streetData.streets.filter(
        (street) => street.name.toLowerCase().includes(searchTerm),
      );
    }

    state.streetData.currentPage = 0;
    renderStreetTable();
  }

  function changePage(direction) {
    const newPage = state.streetData.currentPage + direction;

    if (newPage < 0) return;

    const maxPage =
      Math.ceil(state.streetData.filteredStreets.length / CONFIG.PAGE_SIZE) - 1;
    if (newPage > maxPage) return;

    state.streetData.currentPage = newPage;
    renderStreetTable();
  }

  function updateGoalDate() {
    const goalDate = elements.goalDateInput.value;
    state.goalDate = goalDate;

    // Save to localStorage
    localStorage.setItem(CONFIG.STORAGE_KEYS.goalDate, goalDate);

    // Update goal tracking
    updateGoalTracking();
  }

  // ==============================
  // Actions
  // ==============================
  function viewOnMap() {
    if (!state.selectedLocation) {
      notificationManager.show("Please select a location first", "warning");
      return;
    }

    window.location.href = `/?location=${encodeURIComponent(JSON.stringify(state.selectedLocation))}`;
  }

  function viewStreetOnMap(streetId) {
    if (!state.selectedLocation) {
      notificationManager.show("Please select a location first", "warning");
      return;
    }

    window.location.href = `/?location=${encodeURIComponent(JSON.stringify(state.selectedLocation))}&street=${streetId}`;
  }

  function updateCoverage() {
    if (!state.selectedLocation) {
      notificationManager.show("Please select a location first", "warning");
      return;
    }

    // Show loading indicator
    notificationManager.show("Updating coverage data...", "info");

    fetch(`/api/update_coverage/${state.selectedLocation.id}`, {
      method: "POST",
    })
      .then((response) => {
        if (!response.ok) throw new Error("Failed to update coverage");
        return response.json();
      })
      .then((data) => {
        notificationManager.show(
          "Coverage update started. This may take a few minutes.",
          "success",
        );

        // Poll for completion
        const checkInterval = setInterval(() => {
          fetch(`/api/task_status/${data.task_id}`)
            .then((response) => response.json())
            .then((statusData) => {
              if (statusData.status === "completed") {
                clearInterval(checkInterval);
                notificationManager.show(
                  "Coverage update completed!",
                  "success",
                );
                refreshDashboard();
              } else if (statusData.status === "failed") {
                clearInterval(checkInterval);
                notificationManager.show(
                  "Coverage update failed: " + statusData.error,
                  "danger",
                );
              }
            })
            .catch((error) => {
              clearInterval(checkInterval);
              notificationManager.show(
                "Error checking task status: " + error.message,
                "danger",
              );
            });
        }, 5000);
      })
      .catch((error) => {
        notificationManager.show(
          "Failed to update coverage: " + error.message,
          "danger",
        );
      });
  }

  function showRouteSuggestion() {
    if (!state.selectedLocation) {
      notificationManager.show("Please select a location first", "warning");
      return;
    }

    // Show the modal
    const modal = new bootstrap.Modal(elements.routeSuggestionModal);
    modal.show();

    // Initialize map if not already done
    if (!state.routeSuggestion.map) {
      initRouteSuggestionMap();
    }

    // Generate route suggestion
    generateRouteSuggestion();
  }

  function initRouteSuggestionMap() {
    // Create map
    state.routeSuggestion.map = L.map(elements.routeMapContainer).setView(
      [0, 0],
      13,
    );

    // Add tile layer
    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      },
    ).addTo(state.routeSuggestion.map);

    // Create route layer
    state.routeSuggestion.routeLayer = L.layerGroup().addTo(
      state.routeSuggestion.map,
    );

    // Add event listeners for route type and length changes
    elements.routeType.addEventListener("change", generateRouteSuggestion);
    elements.routeLength.addEventListener("change", generateRouteSuggestion);

    // Handle modal shown event to resize map
    elements.routeSuggestionModal.addEventListener("shown.bs.modal", () => {
      state.routeSuggestion.map.invalidateSize();
    });
  }

  function generateRouteSuggestion() {
    if (!state.selectedLocation || !state.routeSuggestion.map) return;

    const routeType = elements.routeType.value;
    const routeLength = elements.routeLength.value;

    // Clear existing route
    state.routeSuggestion.routeLayer.clearLayers();

    // Show loading indicator
    notificationManager.show("Generating route suggestion...", "info");

    fetch("/api/suggest_route", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        location_id: state.selectedLocation.id,
        route_type: routeType,
        length_miles: routeLength,
      }),
    })
      .then((response) => {
        if (!response.ok)
          throw new Error("Failed to generate route suggestion");
        return response.json();
      })
      .then((data) => {
        // Display the suggested route
        displaySuggestedRoute(data.route);
        notificationManager.show("Route suggestion generated", "success");
      })
      .catch((error) => {
        notificationManager.show(
          "Failed to generate route: " + error.message,
          "danger",
        );
      });
  }

  function displaySuggestedRoute(routeData) {
    if (!routeData || !routeData.geometry || !state.routeSuggestion.map) return;

    // Clear existing route
    state.routeSuggestion.routeLayer.clearLayers();

    // Create route polyline
    const routeLine = L.geoJSON(routeData, {
      style: {
        color: "#BB86FC",
        weight: 5,
        opacity: 0.8,
      },
    }).addTo(state.routeSuggestion.routeLayer);

    // Fit map to route bounds
    state.routeSuggestion.map.fitBounds(routeLine.getBounds());

    // Add start and end markers
    if (
      routeData.geometry.type === "LineString" &&
      routeData.geometry.coordinates.length > 0
    ) {
      const startCoords = routeData.geometry.coordinates[0];
      const endCoords =
        routeData.geometry.coordinates[
          routeData.geometry.coordinates.length - 1
        ];

      L.marker([startCoords[1], startCoords[0]], {
        icon: L.divIcon({
          className: "route-marker start-marker",
          html: '<i class="fas fa-play-circle"></i>',
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        }),
      }).addTo(state.routeSuggestion.routeLayer);

      L.marker([endCoords[1], endCoords[0]], {
        icon: L.divIcon({
          className: "route-marker end-marker",
          html: '<i class="fas fa-flag-checkered"></i>',
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        }),
      }).addTo(state.routeSuggestion.routeLayer);
    }
  }

  function exportSuggestedRoute() {
    if (!state.selectedLocation) {
      notificationManager.show("Please select a location first", "warning");
      return;
    }

    const routeType = elements.routeType.value;
    const routeLength = elements.routeLength.value;

    window.location.href = `/api/export_route?location_id=${state.selectedLocation.id}&route_type=${routeType}&length_miles=${routeLength}`;
  }

  // Initialize the dashboard when DOM is ready
  document.addEventListener("DOMContentLoaded", init);
})();
