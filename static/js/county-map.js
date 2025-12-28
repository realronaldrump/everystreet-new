/* global topojson, mapboxgl */
/**
 * County Map JavaScript
 * Renders a US county map with visited counties highlighted
 * Shows first and most recent visit dates for each county
 */

(() => {
  // State
  let map = null;
  let countyVisits = {}; // {fips: {firstVisit, lastVisit}}
  let countyData = null;
  let statesData = null;
  let isRecalculating = false;

  // FIPS code to state name mapping
  const stateFipsToName = {
    "01": "Alabama",
    "02": "Alaska",
    "04": "Arizona",
    "05": "Arkansas",
    "06": "California",
    "08": "Colorado",
    "09": "Connecticut",
    10: "Delaware",
    11: "District of Columbia",
    12: "Florida",
    13: "Georgia",
    15: "Hawaii",
    16: "Idaho",
    17: "Illinois",
    18: "Indiana",
    19: "Iowa",
    20: "Kansas",
    21: "Kentucky",
    22: "Louisiana",
    23: "Maine",
    24: "Maryland",
    25: "Massachusetts",
    26: "Michigan",
    27: "Minnesota",
    28: "Mississippi",
    29: "Missouri",
    30: "Montana",
    31: "Nebraska",
    32: "Nevada",
    33: "New Hampshire",
    34: "New Jersey",
    35: "New Mexico",
    36: "New York",
    37: "North Carolina",
    38: "North Dakota",
    39: "Ohio",
    40: "Oklahoma",
    41: "Oregon",
    42: "Pennsylvania",
    44: "Rhode Island",
    45: "South Carolina",
    46: "South Dakota",
    47: "Tennessee",
    48: "Texas",
    49: "Utah",
    50: "Vermont",
    51: "Virginia",
    53: "Washington",
    54: "West Virginia",
    55: "Wisconsin",
    56: "Wyoming",
    60: "American Samoa",
    66: "Guam",
    69: "Northern Mariana Islands",
    72: "Puerto Rico",
    78: "Virgin Islands",
  };

  // Initialize the map
  async function init() {
    updateLoadingText("Initializing map...");

    // Create map with standard projection (not Albers - TopoJSON is unprojected)
    mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;

    map = new mapboxgl.Map({
      container: "county-map",
      style: getMapStyle(),
      center: [-98.5795, 39.8283], // Center of US
      zoom: 4,
      minZoom: 2,
      maxZoom: 12,
    });

    // Add navigation controls
    map.addControl(new mapboxgl.NavigationControl(), "bottom-right");

    // Wait for map to load
    map.on("load", async () => {
      try {
        updateLoadingText("Loading county boundaries...");
        await loadCountyData();

        updateLoadingText("Loading visited counties...");
        await loadVisitedCounties();

        updateLoadingText("Rendering map...");
        addMapLayers();

        hideLoading();
        setupInteractions();
        updateStats();
      } catch (error) {
        console.error("Error initializing county map:", error);
        updateLoadingText(`Error: ${error.message}`);
      }
    });

    // Setup panel toggle and recalculate button
    setupPanelToggle();
    setupRecalculateButton();
    setupStateStatsToggle();
  }

  // Get appropriate map style based on theme
  function getMapStyle() {
    const isDark =
      document.documentElement.getAttribute("data-bs-theme") === "dark" ||
      document.documentElement.classList.contains("dark-mode") ||
      !document.documentElement.classList.contains("light-mode");
    return isDark
      ? "mapbox://styles/mapbox/dark-v11"
      : "mapbox://styles/mapbox/light-v11";
  }

  // Load TopoJSON county data (unprojected version)
  async function loadCountyData() {
    const response = await fetch("/static/data/counties-10m.json");
    const topology = await response.json();

    // Convert TopoJSON to GeoJSON using topojson-client library
    countyData = topojson.feature(topology, topology.objects.counties);
    statesData = topojson.feature(topology, topology.objects.states);

    // Add state FIPS and names to each county
    countyData.features.forEach((feature) => {
      const fips = String(feature.id).padStart(5, "0");
      const stateFips = fips.substring(0, 2);
      feature.properties = feature.properties || {};
      feature.properties.fips = fips;
      feature.properties.stateFips = stateFips;
      feature.properties.stateName = stateFipsToName[stateFips] || "Unknown";
      feature.properties.visited = false;
    });

    console.log(`Loaded ${countyData.features.length} counties`);
  }

  // Load visited counties from API (cached)
  async function loadVisitedCounties() {
    try {
      const response = await fetch("/api/counties/visited");
      const data = await response.json();

      if (
        data.success &&
        data.counties &&
        Object.keys(data.counties).length > 0
      ) {
        // Store county visits data (includes dates)
        countyVisits = data.counties;

        // Mark counties as visited
        countyData.features.forEach((feature) => {
          const { fips } = feature.properties;
          if (countyVisits[fips]) {
            feature.properties.visited = true;
          }
        });

        console.log(
          `Marked ${Object.keys(countyVisits).length} counties as visited`,
        );

        // Show last updated time if available
        if (data.lastUpdated) {
          const lastUpdated = new Date(data.lastUpdated);
          document.getElementById("last-updated").textContent =
            `Last updated: ${lastUpdated.toLocaleDateString()} ${lastUpdated.toLocaleTimeString()}`;
        }
      } else if (!data.cached) {
        // No cache - prompt user to calculate
        console.log("No cached county data. Showing prompt...");
        showRecalculatePrompt();
      }
    } catch (error) {
      console.error("Error loading visited counties:", error);
    }
  }

  // Format date for display
  function formatDate(isoString) {
    if (!isoString) return "Unknown";
    try {
      const date = new Date(isoString);
      return date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return "Unknown";
    }
  }

  // Show prompt to recalculate
  function showRecalculatePrompt() {
    const statsContent = document.getElementById("stats-content");
    if (statsContent) {
      const prompt = document.createElement("div");
      prompt.className = "recalculate-prompt";
      prompt.innerHTML = `
        <p>County data needs to be calculated from your trips.</p>
        <button class="btn btn-primary btn-sm" id="trigger-recalculate">
          <i class="fas fa-calculator me-2"></i>Calculate Now
        </button>
      `;
      statsContent.insertBefore(prompt, statsContent.firstChild);

      document
        .getElementById("trigger-recalculate")
        .addEventListener("click", triggerRecalculate);
    }
  }

  // Trigger recalculation
  async function triggerRecalculate() {
    if (isRecalculating) return;

    isRecalculating = true;
    const btn =
      document.getElementById("trigger-recalculate") ||
      document.getElementById("recalculate-btn");

    if (btn) {
      btn.disabled = true;
      btn.innerHTML =
        '<i class="fas fa-spinner fa-spin me-2"></i>Calculating...';
    }

    try {
      const response = await fetch("/api/counties/recalculate", {
        method: "POST",
      });
      const data = await response.json();

      if (data.success) {
        // Poll for completion
        setTimeout(checkAndRefresh, 3000);
      } else {
        alert(`Error starting calculation: ${data.error}`);
        isRecalculating = false;
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-sync-alt me-1"></i>Refresh';
        }
      }
    } catch (error) {
      console.error("Error triggering recalculate:", error);
      isRecalculating = false;
    }
  }

  // Check if calculation is done and refresh
  async function checkAndRefresh() {
    try {
      const response = await fetch("/api/counties/cache-status");
      const data = await response.json();

      if (data.cached && data.totalVisited > 0) {
        // Refresh the page to show new data
        window.location.reload();
      } else {
        // Still calculating, check again
        setTimeout(checkAndRefresh, 2000);
      }
    } catch (error) {
      console.error("Error checking cache status:", error);
      setTimeout(checkAndRefresh, 3000);
    }
  }

  // Add map layers for counties and states
  function addMapLayers() {
    // Add counties source
    map.addSource("counties", {
      type: "geojson",
      data: countyData,
    });

    // Add states source for borders
    map.addSource("states", {
      type: "geojson",
      data: statesData,
    });

    // Unvisited counties fill (subtle)
    map.addLayer({
      id: "counties-unvisited-fill",
      type: "fill",
      source: "counties",
      filter: ["!=", ["get", "visited"], true],
      paint: {
        "fill-color": "rgba(255, 255, 255, 0.02)",
        "fill-opacity": 1,
      },
    });

    // Visited counties fill (green)
    map.addLayer({
      id: "counties-visited-fill",
      type: "fill",
      source: "counties",
      filter: ["==", ["get", "visited"], true],
      paint: {
        "fill-color": "#10b981",
        "fill-opacity": 0.6,
      },
    });

    // County borders
    map.addLayer({
      id: "counties-border",
      type: "line",
      source: "counties",
      paint: {
        "line-color": "rgba(255, 255, 255, 0.15)",
        "line-width": 0.5,
      },
    });

    // Visited county borders (more prominent)
    map.addLayer({
      id: "counties-visited-border",
      type: "line",
      source: "counties",
      filter: ["==", ["get", "visited"], true],
      paint: {
        "line-color": "#059669",
        "line-width": 1,
      },
    });

    // State borders
    map.addLayer({
      id: "states-border",
      type: "line",
      source: "states",
      paint: {
        "line-color": "rgba(255, 255, 255, 0.4)",
        "line-width": 1.5,
      },
    });

    // Hover highlight layer
    map.addLayer({
      id: "counties-hover",
      type: "fill",
      source: "counties",
      filter: ["==", ["get", "fips"], ""],
      paint: {
        "fill-color": "#ffffff",
        "fill-opacity": 0.2,
      },
    });
  }

  // Setup hover and click interactions
  function setupInteractions() {
    const tooltip = document.getElementById("county-tooltip");
    const tooltipCounty = tooltip.querySelector(".tooltip-county-name");
    const tooltipState = tooltip.querySelector(".tooltip-state-name");
    const tooltipStatus = tooltip.querySelector(".tooltip-status");
    const tooltipDates = tooltip.querySelector(".tooltip-dates");

    // Mouse move - show tooltip
    map.on("mousemove", "counties-unvisited-fill", (e) =>
      showTooltip(e, false),
    );
    map.on("mousemove", "counties-visited-fill", (e) => showTooltip(e, true));

    function showTooltip(e, isVisited) {
      if (e.features.length === 0) return;

      const feature = e.features[0];
      const { fips } = feature.properties;
      const countyName = feature.properties.name || "Unknown County";
      const stateName = feature.properties.stateName || "Unknown State";

      // Update highlight
      map.setFilter("counties-hover", ["==", ["get", "fips"], fips]);

      // Update tooltip content
      tooltipCounty.textContent = countyName;
      tooltipState.textContent = stateName;

      if (isVisited && countyVisits[fips]) {
        const visits = countyVisits[fips];
        tooltipStatus.textContent = "✓ Visited";
        tooltipStatus.className = "tooltip-status tooltip-status--visited";

        // Show dates
        const firstDate = formatDate(visits.firstVisit);
        const lastDate = formatDate(visits.lastVisit);

        if (firstDate === lastDate) {
          tooltipDates.innerHTML = `<div class="tooltip-date">Visited: ${firstDate}</div>`;
        } else {
          tooltipDates.innerHTML = `
            <div class="tooltip-date"><span class="date-label">First:</span> ${firstDate}</div>
            <div class="tooltip-date"><span class="date-label">Last:</span> ${lastDate}</div>
          `;
        }
        tooltipDates.style.display = "block";
      } else {
        tooltipStatus.textContent = "Not yet visited";
        tooltipStatus.className = "tooltip-status tooltip-status--unvisited";
        tooltipDates.style.display = "none";
      }

      // Position tooltip
      tooltip.style.display = "block";
      tooltip.style.left = `${e.point.x}px`;
      tooltip.style.top = `${e.point.y}px`;

      // Change cursor
      map.getCanvas().style.cursor = "pointer";
    }

    // Mouse leave - hide tooltip
    map.on("mouseleave", "counties-unvisited-fill", hideTooltip);
    map.on("mouseleave", "counties-visited-fill", hideTooltip);

    function hideTooltip() {
      tooltip.style.display = "none";
      map.setFilter("counties-hover", ["==", ["get", "fips"], ""]);
      map.getCanvas().style.cursor = "";
    }
  }

  // Update statistics display
  function updateStats() {
    const totalCounties = countyData.features.length;
    const visitedCount = Object.keys(countyVisits).length;
    const percentage =
      totalCounties > 0
        ? ((visitedCount / totalCounties) * 100).toFixed(1)
        : "0.0";

    // Count unique states
    const visitedStates = new Set();
    countyData.features.forEach((feature) => {
      if (feature.properties.visited) {
        visitedStates.add(feature.properties.stateFips);
      }
    });

    // Update DOM
    document.getElementById("counties-visited").textContent =
      visitedCount.toLocaleString();
    document.getElementById("counties-total").textContent =
      totalCounties.toLocaleString();
    document.getElementById("coverage-percent").textContent = `${percentage}%`;
    document.getElementById("states-visited").textContent = visitedStates.size;
  }

  // Panel toggle functionality
  function setupPanelToggle() {
    const panel = document.getElementById("stats-panel");
    const toggleBtn = document.getElementById("stats-toggle");

    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        panel.classList.toggle("stats-panel--collapsed");
        const isCollapsed = panel.classList.contains("stats-panel--collapsed");
        toggleBtn.setAttribute("aria-expanded", !isCollapsed);
      });
    }
  }

  // Setup recalculate button
  function setupRecalculateButton() {
    const btn = document.getElementById("recalculate-btn");
    if (btn) {
      btn.addEventListener("click", triggerRecalculate);
    }
  }

  // Calculate and display state-level statistics
  function calculateStateStats() {
    // Group counties by state
    const stateStats = {};

    countyData.features.forEach((feature) => {
      const { stateFips } = feature.properties;
      const { stateName } = feature.properties;

      if (!stateStats[stateFips]) {
        stateStats[stateFips] = {
          name: stateName,
          fips: stateFips,
          total: 0,
          visited: 0,
          firstVisit: null,
          lastVisit: null,
        };
      }

      stateStats[stateFips].total++;

      if (feature.properties.visited) {
        stateStats[stateFips].visited++;

        // Track earliest and latest visits for the state
        const countyFips = feature.properties.fips;
        const visits = countyVisits[countyFips];
        if (visits) {
          const firstVisit = visits.firstVisit
            ? new Date(visits.firstVisit)
            : null;
          const lastVisit = visits.lastVisit
            ? new Date(visits.lastVisit)
            : null;

          if (
            firstVisit &&
            (!stateStats[stateFips].firstVisit ||
              firstVisit < stateStats[stateFips].firstVisit)
          ) {
            stateStats[stateFips].firstVisit = firstVisit;
          }
          if (
            lastVisit &&
            (!stateStats[stateFips].lastVisit ||
              lastVisit > stateStats[stateFips].lastVisit)
          ) {
            stateStats[stateFips].lastVisit = lastVisit;
          }
        }
      }
    });

    // Convert to array and calculate percentages
    const stateList = Object.values(stateStats).map((state) => ({
      ...state,
      percentage: state.total > 0 ? (state.visited / state.total) * 100 : 0,
    }));

    return stateList;
  }

  // Render state stats list
  function renderStateStatsList(sortBy = "name") {
    const stateList = calculateStateStats();

    // Sort based on selected option
    switch (sortBy) {
      case "coverage-desc":
        stateList.sort((a, b) => b.percentage - a.percentage);
        break;
      case "coverage-asc":
        stateList.sort((a, b) => a.percentage - b.percentage);
        break;
      case "visited-desc":
        stateList.sort((a, b) => b.visited - a.visited);
        break;
      default:
        stateList.sort((a, b) => a.name.localeCompare(b.name));
    }

    // Filter to only states with counties (exclude territories if needed)
    const filteredList = stateList.filter((s) => s.total > 0);

    const container = document.getElementById("state-list");
    if (!container) return;

    container.innerHTML = filteredList
      .map((state) => {
        const pct = state.percentage.toFixed(1);
        const isComplete = state.percentage >= 100;
        const hasVisits = state.visited > 0;

        let dateInfo = "";
        if (hasVisits && state.firstVisit) {
          const firstDate = formatDate(state.firstVisit.toISOString());
          const lastDate = formatDate(state.lastVisit.toISOString());
          if (firstDate === lastDate) {
            dateInfo = `<div class="state-date">Visited: ${firstDate}</div>`;
          } else {
            dateInfo = `<div class="state-date">First: ${firstDate} · Last: ${lastDate}</div>`;
          }
        }

        return `
        <div class="state-stat-item ${isComplete ? "state-stat-item--complete" : ""}" data-state-fips="${state.fips}">
          <div class="state-stat-header">
            <span class="state-name">${state.name}</span>
            <span class="state-coverage ${hasVisits ? "state-coverage--visited" : ""}">${pct}%</span>
          </div>
          <div class="state-stat-details">
            <span class="state-counties">${state.visited} / ${state.total} counties</span>
          </div>
          <div class="state-progress-bar">
            <div class="state-progress-fill" style="width: ${pct}%"></div>
          </div>
          ${dateInfo}
        </div>
      `;
      })
      .join("");

    // Add click handlers to zoom to state
    container.querySelectorAll(".state-stat-item").forEach((item) => {
      item.addEventListener("click", () => {
        const { stateFips } = item.dataset;
        zoomToState(stateFips);
      });
    });
  }

  // Zoom map to a specific state
  function zoomToState(stateFips) {
    // Get bounding box of all counties in this state
    const stateCounties = countyData.features.filter(
      (f) => f.properties.stateFips === stateFips,
    );

    if (stateCounties.length === 0) return;

    // Calculate bounds
    let minLng = Infinity,
      minLat = Infinity,
      maxLng = -Infinity,
      maxLat = -Infinity;

    stateCounties.forEach((county) => {
      const coords = county.geometry.coordinates;
      const flatCoords = flattenCoordinates(coords);
      flatCoords.forEach(([lng, lat]) => {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      });
    });

    // Fit map to bounds
    map.fitBounds(
      [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
      { padding: 50, maxZoom: 8 },
    );
  }

  // Flatten nested coordinate arrays
  function flattenCoordinates(coords) {
    const result = [];
    function flatten(arr) {
      if (typeof arr[0] === "number") {
        result.push(arr);
      } else {
        arr.forEach(flatten);
      }
    }
    flatten(coords);
    return result;
  }

  // Setup state stats toggle
  function setupStateStatsToggle() {
    const toggleBtn = document.getElementById("state-stats-toggle");
    const content = document.getElementById("state-stats-list");
    const chevron = toggleBtn
      ? toggleBtn.querySelector(".state-stats-chevron")
      : null;

    if (toggleBtn && content) {
      toggleBtn.addEventListener("click", () => {
        const isExpanded = content.style.display !== "none";
        content.style.display = isExpanded ? "none" : "block";
        toggleBtn.setAttribute("aria-expanded", !isExpanded);
        if (chevron) {
          chevron.style.transform = isExpanded
            ? "rotate(0deg)"
            : "rotate(180deg)";
        }

        // Render stats on first open
        if (
          (!isExpanded && content.innerHTML.trim() === "") ||
          content.querySelector("#state-list").innerHTML.trim() === ""
        ) {
          renderStateStatsList();
        }
      });
    }

    // Setup sort dropdown
    const sortSelect = document.getElementById("state-sort");
    if (sortSelect) {
      sortSelect.addEventListener("change", () => {
        renderStateStatsList(sortSelect.value);
      });
    }
  }

  // Loading helpers
  function updateLoadingText(text) {
    const textEl = document.querySelector(".loading-text");
    if (textEl) {
      textEl.textContent = text;
    }
  }

  function hideLoading() {
    const loadingEl = document.getElementById("map-loading");
    if (loadingEl) {
      loadingEl.classList.add("hidden");
      setTimeout(() => {
        loadingEl.style.display = "none";
      }, 500);
    }
  }

  // Initialize on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
