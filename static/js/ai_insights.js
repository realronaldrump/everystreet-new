/* global google, DateUtils, Chart */

"use strict";

(() => {
  // Global variables
  let map;
  let heatmap;
  let tripPathsLayer = [];
  let showHeatmap = true;
  let showPaths = true;
  let timelineChart;
  let animationInterval;

  // Main geographic bounds for centering the visualizations
  let bounds;
  let center;

  // Loading manager reference
  const loadingManager = window.loadingManager || {
    startOperation: () => {},
    finish: () => {},
  };

  // Initialize everything once DOM is ready
  document.addEventListener("DOMContentLoaded", () => {
    initializeEventListeners();
    initializeDatepickers();

    // Default to last 30 days
    setDateRange(30);

    // Auto-load insights
    analyzeData();
  });

  function initializeEventListeners() {
    // Analyze button
    document
      .getElementById("analyze-button")
      ?.addEventListener("click", analyzeData);

    // Quick filter buttons
    document.querySelectorAll(".quick-select-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const range = e.target.dataset.range;
        if (range === "last-week") setDateRange(7);
        else if (range === "last-month") setDateRange(30);
        else if (range === "quarter") setDateRange(90);
      });
    });

    // Enhanced visualization controls
    document
      .getElementById("toggle-heatmap")
      ?.addEventListener("click", toggleHeatmap);
    document
      .getElementById("toggle-paths")
      ?.addEventListener("click", togglePaths);
    document
      .getElementById("animate-paths")
      ?.addEventListener("click", animateTrips);

    // Handle resize events
    window.addEventListener("resize", handleResize, false);
  }

  function handleResize() {
    // Resize chart if it exists
    if (timelineChart) {
      timelineChart.resize();
    }
  }

  function initializeDatepickers() {
    const startDateEl = document.getElementById("start-date");
    const endDateEl = document.getElementById("end-date");

    if (startDateEl && endDateEl) {
      // Get saved dates from localStorage or use defaults
      const savedStartDate =
        localStorage.getItem("startDate") ||
        DateUtils.formatDate(
          DateUtils.getDateRangeForPreset("30days").startDate,
        );
      const savedEndDate =
        localStorage.getItem("endDate") || DateUtils.getCurrentDate();

      // Set initial values using DateUtils
      if (startDateEl._flatpickr && endDateEl._flatpickr) {
        // Update when flatpickr is already initialized
        startDateEl._flatpickr.setDate(savedStartDate);
        endDateEl._flatpickr.setDate(savedEndDate);
      } else {
        // Initialize date pickers if they don't exist yet
        DateUtils.initDatePicker(startDateEl, { defaultDate: savedStartDate });
        DateUtils.initDatePicker(endDateEl, { defaultDate: savedEndDate });
      }
    }
  }

  function setDateRange(days) {
    try {
      const startDateInput = document.getElementById("start-date");
      const endDateInput = document.getElementById("end-date");

      if (!startDateInput || !endDateInput) {
        return;
      }

      // Map to preset names used by DateUtils
      let preset;
      switch (days) {
        case 7:
          preset = "7days";
          break;
        case 30:
          preset = "30days";
          break;
        case 90:
          preset = "90days";
          break;
        default:
          // Use DateUtils for custom days calculation
          const endDate = new Date();
          const startDate = new Date();
          startDate.setDate(startDate.getDate() - days);

          updateDateInputs(
            startDateInput,
            endDateInput,
            DateUtils.formatDate(startDate),
            DateUtils.formatDate(endDate),
          );
          return;
      }

      // Use DateUtils to get the range
      if (typeof DateUtils.getDateRangePreset === "function") {
        DateUtils.getDateRangePreset(preset).then(({ startDate, endDate }) => {
          updateDateInputs(startDateInput, endDateInput, startDate, endDate);
        });
      } else {
        // Fallback if DateUtils.getDateRangePreset is not available
        const { startDate, endDate } = DateUtils.getDateRangeForPreset(preset);
        updateDateInputs(
          startDateInput,
          endDateInput,
          DateUtils.formatDate(startDate),
          DateUtils.formatDate(endDate),
        );
      }
    } catch (error) {
      console.error("Error setting date range: %s", error);
    }
  }

  function updateDateInputs(startInput, endInput, startDate, endDate) {
    // Save to localStorage for persistence
    localStorage.setItem("startDate", startDate);
    localStorage.setItem("endDate", endDate);

    // Update input values
    if (startInput._flatpickr) {
      startInput._flatpickr.setDate(startDate);
    } else {
      startInput.value = startDate;
    }

    if (endInput._flatpickr) {
      endInput._flatpickr.setDate(endDate);
    } else {
      endInput.value = endDate;
    }
  }

  function getFilterParams() {
    // Use stored date range or default to last 30 days
    const startDate =
      localStorage.getItem("startDate") ||
      DateUtils.formatDate(
        new Date(new Date().setDate(new Date().getDate() - 30)),
      );
    const endDate =
      localStorage.getItem("endDate") || DateUtils.formatDate(new Date());

    return new URLSearchParams({ start_date: startDate, end_date: endDate });
  }

  // MAIN DATA FETCHING FUNCTION
  async function analyzeData() {
    // Reset any active animations
    if (animationInterval) {
      clearInterval(animationInterval);
      animationInterval = null;
    }

    // Show loading state
    document.getElementById("loading-container").classList.remove("d-none");
    document.getElementById("insights-container").classList.add("d-none");
    document.getElementById("no-data-container").classList.add("d-none");

    loadingManager.startOperation("Analyzing driving data with AI");

    try {
      const params = getFilterParams();
      const response = await fetch(`/api/ai-insights?${params}`);

      if (!response.ok) {
        throw new Error(
          `Failed to fetch AI insights: ${response.status} ${response.statusText}`,
        );
      }

      const data = await response.json();

      // Check if we have trip data
      if (!data.trip_data || data.trip_data.length === 0) {
        // Show no data message
        document.getElementById("loading-container").classList.add("d-none");
        document.getElementById("no-data-container").classList.remove("d-none");
        return;
      }

      // Process and display data
      renderAiInsights(data.ai_insights);
      initializeGoogleMap(data.trip_data);
      initializeEnhancedVisualization(data.trip_data);

      // Show insights container
      document.getElementById("loading-container").classList.add("d-none");
      document.getElementById("insights-container").classList.remove("d-none");

      // Show success message
      if (window.notificationManager) {
        window.notificationManager.show(
          "AI analysis completed successfully",
          "success",
        );
      }
    } catch (error) {
      console.error("Error analyzing data: %s", error);

      // Show error message
      document.getElementById("loading-container").classList.add("d-none");
      document.getElementById("no-data-container").classList.remove("d-none");

      if (window.notificationManager) {
        window.notificationManager.show(
          `Error analyzing driving data: ${error.message}`,
          "danger",
        );
      }
    } finally {
      loadingManager.finish("Analyzing driving data with AI");
    }
  }

  // VISUALIZATION FUNCTIONS

  // Google Maps Initialization
  function initializeGoogleMap(tripData) {
    const mapContainer = document.getElementById("map-container");
    if (!mapContainer) return;

    // Clear existing paths
    tripPathsLayer.forEach((path) => {
      if (path.setMap) path.setMap(null);
    });
    tripPathsLayer = [];

    // Process coordinates for heatmap and paths
    const heatmapPoints = [];
    bounds = new google.maps.LatLngBounds();

    // Process all trips
    tripData.forEach((trip) => {
      if (!trip.coordinates || trip.coordinates.length === 0) return;

      const path = [];

      // Add each coordinate to the heatmap and path
      trip.coordinates.forEach((coord) => {
        const latLng = new google.maps.LatLng(coord[1], coord[0]);
        heatmapPoints.push(latLng);
        path.push(latLng);
        bounds.extend(latLng);
      });

      if (path.length > 0) {
        // Create a polyline for the trip
        const tripPath = new google.maps.Polyline({
          path: path,
          geodesic: true,
          strokeColor: getRandomColor(),
          strokeOpacity: 0.8,
          strokeWeight: 2,
        });

        tripPathsLayer.push(tripPath);
      }
    });

    // Create map if not already initialized
    if (!map) {
      map = new google.maps.Map(mapContainer, {
        zoom: 12,
        mapTypeId: google.maps.MapTypeId.ROADMAP,
        styles: [
          { elementType: "geometry", stylers: [{ color: "#242f3e" }] },
          {
            elementType: "labels.text.stroke",
            stylers: [{ color: "#242f3e" }],
          },
          { elementType: "labels.text.fill", stylers: [{ color: "#746855" }] },
          {
            featureType: "administrative.locality",
            elementType: "labels.text.fill",
            stylers: [{ color: "#d59563" }],
          },
          {
            featureType: "poi",
            elementType: "labels.text.fill",
            stylers: [{ color: "#d59563" }],
          },
          {
            featureType: "poi.park",
            elementType: "geometry",
            stylers: [{ color: "#263c3f" }],
          },
          {
            featureType: "poi.park",
            elementType: "labels.text.fill",
            stylers: [{ color: "#6b9a76" }],
          },
          {
            featureType: "road",
            elementType: "geometry",
            stylers: [{ color: "#38414e" }],
          },
          {
            featureType: "road",
            elementType: "geometry.stroke",
            stylers: [{ color: "#212a37" }],
          },
          {
            featureType: "road",
            elementType: "labels.text.fill",
            stylers: [{ color: "#9ca5b3" }],
          },
          {
            featureType: "road.highway",
            elementType: "geometry",
            stylers: [{ color: "#746855" }],
          },
          {
            featureType: "road.highway",
            elementType: "geometry.stroke",
            stylers: [{ color: "#1f2835" }],
          },
          {
            featureType: "road.highway",
            elementType: "labels.text.fill",
            stylers: [{ color: "#f3d19c" }],
          },
          {
            featureType: "transit",
            elementType: "geometry",
            stylers: [{ color: "#2f3948" }],
          },
          {
            featureType: "transit.station",
            elementType: "labels.text.fill",
            stylers: [{ color: "#d59563" }],
          },
          {
            featureType: "water",
            elementType: "geometry",
            stylers: [{ color: "#17263c" }],
          },
          {
            featureType: "water",
            elementType: "labels.text.fill",
            stylers: [{ color: "#515c6d" }],
          },
          {
            featureType: "water",
            elementType: "labels.text.stroke",
            stylers: [{ color: "#17263c" }],
          },
        ],
      });
    }

    // Create or update heatmap
    if (heatmap) {
      heatmap.setData(heatmapPoints);
    } else {
      heatmap = new google.maps.visualization.HeatmapLayer({
        data: heatmapPoints,
        map: map,
        radius: 15,
        opacity: 0.7,
        gradient: [
          "rgba(0, 0, 255, 0)",
          "rgba(65, 105, 225, 1)",
          "rgba(30, 144, 255, 1)",
          "rgba(0, 191, 255, 1)",
          "rgba(0, 255, 255, 1)",
          "rgba(0, 255, 127, 1)",
          "rgba(173, 255, 47, 1)",
          "rgba(255, 255, 0, 1)",
          "rgba(255, 165, 0, 1)",
          "rgba(255, 69, 0, 1)",
          "rgba(255, 0, 0, 1)",
        ],
      });
    }

    // Add paths to map
    tripPathsLayer.forEach((path) => path.setMap(map));

    // Set map center and zoom based on bounds
    center = bounds.getCenter();
    map.fitBounds(bounds);

    // Add start and end markers for each trip
    tripData.forEach((trip) => {
      if (!trip.coordinates || trip.coordinates.length < 2) return;

      const startCoord = trip.coordinates[0];
      const endCoord = trip.coordinates[trip.coordinates.length - 1];

      // Start marker
      const startMarker = new google.maps.Marker({
        position: { lat: startCoord[1], lng: startCoord[0] },
        map: map,
        title: `Start: ${trip.start_location || "Unknown"}`,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 7,
          fillColor: "#4CAF50",
          fillOpacity: 1,
          strokeWeight: 2,
          strokeColor: "#FFFFFF",
        },
      });

      tripPathsLayer.push(startMarker);

      // End marker
      const endMarker = new google.maps.Marker({
        position: { lat: endCoord[1], lng: endCoord[0] },
        map: map,
        title: `Destination: ${trip.destination || "Unknown"}`,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 7,
          fillColor: "#F44336",
          fillOpacity: 1,
          strokeWeight: 2,
          strokeColor: "#FFFFFF",
        },
      });

      tripPathsLayer.push(endMarker);
    });
  }

  // Chart.js Enhanced Visualization
  function initializeEnhancedVisualization(tripData) {
    const canvas = document.getElementById("trip-timeline-canvas");
    if (!canvas) return;

    // Destroy existing chart if it exists
    if (timelineChart) {
      timelineChart.destroy();
    }

    // Process trip data for visualization
    const tripsByDay = aggregateTripsByDay(tripData);

    // Create datasets for Chart.js
    const datasets = createTimelineDatasets(tripsByDay);

    // Initialize Chart.js
    timelineChart = new Chart(canvas, {
      type: "bar",
      data: {
        labels: Object.keys(tripsByDay),
        datasets: datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "top",
            labels: {
              color: "#fff",
            },
          },
          tooltip: {
            callbacks: {
              label: function (context) {
                return `${context.dataset.label}: ${context.raw.toFixed(
                  1,
                )} miles`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: {
              color: "rgba(255, 255, 255, 0.1)",
            },
            ticks: {
              color: "#ccc",
            },
          },
          y: {
            grid: {
              color: "rgba(255, 255, 255, 0.1)",
            },
            ticks: {
              color: "#ccc",
            },
            title: {
              display: true,
              text: "Distance (miles)",
              color: "#fff",
            },
          },
        },
        animation: {
          duration: 1000,
        },
        backgroundColor: "rgba(13, 17, 23, 0.75)",
      },
    });
  }

  function aggregateTripsByDay(tripData) {
    const tripsByDay = {};

    tripData.forEach((trip) => {
      // Skip if no timestamp
      if (!trip.timestamp) return;

      const date = new Date(trip.timestamp);
      const dateString = date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });

      if (!tripsByDay[dateString]) {
        tripsByDay[dateString] = [];
      }

      tripsByDay[dateString].push(trip);
    });

    return tripsByDay;
  }

  function createTimelineDatasets(tripsByDay) {
    // Create four different types of measurements for visual interest
    const distanceData = [];
    const avgSpeedData = [];
    const durationData = [];

    Object.keys(tripsByDay).forEach((date) => {
      const trips = tripsByDay[date];

      // Calculate total distance for the day
      const totalDistance = trips.reduce((sum, trip) => {
        return sum + (trip.distance || 0);
      }, 0);

      // Calculate average speed across all trips for the day
      const avgSpeed =
        trips.reduce((sum, trip) => {
          return sum + (trip.avg_speed || 0);
        }, 0) / trips.length;

      // Calculate total duration in minutes
      const totalDuration = trips.reduce((sum, trip) => {
        return sum + (trip.duration_minutes || 0);
      }, 0);

      distanceData.push(totalDistance);
      avgSpeedData.push(Math.min(avgSpeed, 60)); // Cap at 60 for visualization
      durationData.push(Math.min(totalDuration / 10, 20)); // Scale down and cap for visualization
    });

    return [
      {
        label: "Trip Distance",
        data: distanceData,
        backgroundColor: "rgba(54, 162, 235, 0.7)",
        borderColor: "rgba(54, 162, 235, 1)",
        borderWidth: 1,
      },
      {
        label: "Avg Speed (scaled)",
        data: avgSpeedData,
        backgroundColor: "rgba(75, 192, 192, 0.7)",
        borderColor: "rgba(75, 192, 192, 1)",
        borderWidth: 1,
      },
      {
        label: "Duration (scaled)",
        data: durationData,
        backgroundColor: "rgba(255, 159, 64, 0.7)",
        borderColor: "rgba(255, 159, 64, 1)",
        borderWidth: 1,
      },
    ];
  }

  function animateTrips() {
    if (animationInterval) {
      clearInterval(animationInterval);
      animationInterval = null;
      return;
    }

    // Get trip paths
    const paths = tripPathsLayer.filter((path) => path.getPath);
    if (paths.length === 0) return;

    // Reset all paths to be fully visible
    paths.forEach((path) => {
      path.setOptions({
        strokeOpacity: 0.8,
      });
    });

    let currentPathIndex = 0;
    let stepCount = 0;
    const maxSteps = 50; // Number of steps to animate the full path

    // Animate one path at a time
    animationInterval = setInterval(() => {
      const path = paths[currentPathIndex];

      if (!path || !path.getPath) {
        // Skip to next path if this one is invalid
        currentPathIndex++;
        stepCount = 0;
        if (currentPathIndex >= paths.length) {
          clearInterval(animationInterval);
          animationInterval = null;
        }
        return;
      }

      const originalPath = path.getPath();
      if (!originalPath) return;

      const numPoints = originalPath.getLength();
      if (numPoints < 2) {
        currentPathIndex++;
        stepCount = 0;
        return;
      }

      // Calculate how many points to show based on step count
      const pointsToShow = Math.ceil((stepCount / maxSteps) * numPoints);

      if (pointsToShow >= numPoints) {
        // This path animation is complete, move to next path
        stepCount = 0;
        currentPathIndex++;

        if (currentPathIndex >= paths.length) {
          clearInterval(animationInterval);
          animationInterval = null;
        }
        return;
      }

      // Create a new path with only a portion of the points
      const newPath = new google.maps.MVCArray();
      for (let i = 0; i < pointsToShow; i++) {
        newPath.push(originalPath.getAt(i));
      }

      // Update the path with the partial set of points
      path.setPath(newPath);

      // Make this path more visible and fade others
      paths.forEach((p, idx) => {
        if (idx === currentPathIndex) {
          p.setOptions({
            strokeOpacity: 1.0,
            strokeWeight: 4,
          });
        } else {
          p.setOptions({
            strokeOpacity: 0.3,
            strokeWeight: 2,
          });
        }
      });

      // Increment step counter
      stepCount++;
    }, 100); // Update every 100ms
  }

  // UI CONTROL FUNCTIONS

  function toggleHeatmap() {
    showHeatmap = !showHeatmap;

    // Google Maps heatmap
    if (heatmap) {
      heatmap.setMap(showHeatmap ? map : null);
    }
  }

  function togglePaths() {
    showPaths = !showPaths;

    // Google Maps paths
    tripPathsLayer.forEach((path) => {
      if (path.setMap) {
        path.setMap(showPaths ? map : null);
      }
    });
  }

  // AI INSIGHTS RENDERING

  function renderAiInsights(insights) {
    if (!insights) return;

    // Set summary
    const summaryElement = document.getElementById("ai-summary");
    if (summaryElement) {
      summaryElement.textContent =
        insights.summary || "No AI summary available.";
    }

    // Render lists of insights
    renderInsightsList(
      "driving-patterns-list",
      insights.driving_patterns || [],
    );
    renderInsightsList("route-insights-list", insights.route_insights || []);
    renderInsightsList(
      "predictive-insights-list",
      insights.predictive_insights || [],
    );
  }

  function renderInsightsList(elementId, insights) {
    const element = document.getElementById(elementId);
    if (!element) return;

    // Clear existing content
    element.innerHTML = "";

    // Add each insight as a list item
    insights.forEach((insight) => {
      const li = document.createElement("li");
      li.className = "list-group-item border-0 bg-transparent";

      // Add icon based on list type
      let icon = "fa-lightbulb";
      if (elementId === "driving-patterns-list") icon = "fa-location-dot";
      if (elementId === "route-insights-list") icon = "fa-route";
      if (elementId === "predictive-insights-list") icon = "fa-chart-line";

      li.innerHTML = `<i class="fas ${icon} me-2 text-primary"></i> ${insight}`;
      element.appendChild(li);
    });

    // Show placeholder if no insights
    if (insights.length === 0) {
      const li = document.createElement("li");
      li.className = "list-group-item border-0 bg-transparent text-muted";
      li.textContent = "No insights available.";
      element.appendChild(li);
    }
  }

  // UTILITY FUNCTIONS

  function getRandomColor() {
    const letters = "0123456789ABCDEF";
    let color = "#";
    for (let i = 0; i < 6; i++) {
      color += letters[Math.floor(Math.random() * 16)];
    }
    return color;
  }
})();
