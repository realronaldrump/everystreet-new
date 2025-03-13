/* global THREE, google, DateUtils */

"use strict";

(() => {
  // Global variables
  let map;
  let heatmap;
  let tripPathsLayer = [];
  let threeScene, threeCamera, threeRenderer, threeControls;
  let threePaths = [];
  let threeHeatmap;
  let showHeatmap = true;
  let showPaths = true;

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

    // 3D controls
    document
      .getElementById("toggle-heatmap")
      ?.addEventListener("click", toggleHeatmap);
    document
      .getElementById("toggle-paths")
      ?.addEventListener("click", togglePaths);
    document
      .getElementById("reset-camera")
      ?.addEventListener("click", resetCamera);

    // Handle resize events for Three.js
    window.addEventListener("resize", onWindowResize, false);
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
      console.error("Error setting date range:", error);
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
      initializeThreeJsVisualization(data.trip_data);

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
      console.error("Error analyzing data:", error);

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

    // Create heatmap
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
      new google.maps.Marker({
        position: { lat: startCoord[1], lng: startCoord[0] },
        map: map,
        title: `Start: ${trip.start_location}`,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 7,
          fillColor: "#4CAF50",
          fillOpacity: 1,
          strokeWeight: 2,
          strokeColor: "#FFFFFF",
        },
      });

      // End marker
      new google.maps.Marker({
        position: { lat: endCoord[1], lng: endCoord[0] },
        map: map,
        title: `Destination: ${trip.destination}`,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 7,
          fillColor: "#F44336",
          fillOpacity: 1,
          strokeWeight: 2,
          strokeColor: "#FFFFFF",
        },
      });
    });
  }

  // Three.js Visualization
  function initializeThreeJsVisualization(tripData) {
    const container = document.getElementById("three-container");
    if (!container) return;

    // Get dimensions
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Initialize Three.js scene if not already created
    if (!threeScene) {
      threeScene = new THREE.Scene();
      threeScene.background = new THREE.Color(0x1a1a2e);

      // Setup camera
      threeCamera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
      threeCamera.position.set(0, 20, 30);

      // Setup renderer
      threeRenderer = new THREE.WebGLRenderer({ antialias: true });
      threeRenderer.setSize(width, height);
      threeRenderer.setPixelRatio(window.devicePixelRatio);
      container.appendChild(threeRenderer.domElement);

      // Setup controls
      threeControls = new THREE.OrbitControls(
        threeCamera,
        threeRenderer.domElement,
      );
      threeControls.enableDamping = true;
      threeControls.dampingFactor = 0.25;

      // Add lights
      const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
      threeScene.add(ambientLight);

      const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
      directionalLight.position.set(5, 10, 7.5);
      threeScene.add(directionalLight);

      // Add grid for reference
      const gridHelper = new THREE.GridHelper(50, 50, 0x555555, 0x333333);
      threeScene.add(gridHelper);

      // Start animation loop
      animate();
    } else {
      // Clear existing paths
      threePaths.forEach((path) => threeScene.remove(path));
      threePaths = [];

      if (threeHeatmap) {
        threeScene.remove(threeHeatmap);
        threeHeatmap = null;
      }
    }

    // Extract coordinates, normalize them for 3D space
    if (!bounds || !center) return;

    const centerLat = center.lat();
    const centerLng = center.lng();

    // Calculate scale factor based on bounds size
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    const boundsWidth = Math.abs(ne.lng() - sw.lng());
    const boundsHeight = Math.abs(ne.lat() - sw.lat());
    const scale = 50 / Math.max(boundsWidth, boundsHeight);

    // Process trip data to create 3D paths
    tripData.forEach((trip) => {
      if (!trip.coordinates || trip.coordinates.length < 2) return;

      const points = [];
      const heatmapPoints = [];

      // Convert coordinates to 3D points
      trip.coordinates.forEach((coord) => {
        const x = (coord[0] - centerLng) * scale;
        const z = (coord[1] - centerLat) * scale * -1; // Invert lat for correct orientation

        // Use distance as height (y) for visual interest
        const y = trip.distance / 100 + Math.random() * 0.5;

        points.push(new THREE.Vector3(x, y, z));
        heatmapPoints.push({ x, y: 0, z }); // For heatmap, keep y at ground level
      });

      // Create path
      const curve = new THREE.CatmullRomCurve3(points);
      const geometry = new THREE.TubeGeometry(
        curve,
        Math.min(points.length * 2, 100),
        0.05,
        8,
        false,
      );
      const material = new THREE.MeshPhongMaterial({
        color: new THREE.Color().setHSL(Math.random(), 0.7, 0.5),
        emissive: 0x072534,
        side: THREE.DoubleSide,
        flatShading: true,
      });

      const path = new THREE.Mesh(geometry, material);
      threeScene.add(path);
      threePaths.push(path);

      // Add small spheres for start and end points
      const startGeometry = new THREE.SphereGeometry(0.2, 16, 16);
      const startMaterial = new THREE.MeshPhongMaterial({ color: 0x4caf50 });
      const startSphere = new THREE.Mesh(startGeometry, startMaterial);
      startSphere.position.copy(points[0]);
      threeScene.add(startSphere);
      threePaths.push(startSphere);

      const endGeometry = new THREE.SphereGeometry(0.2, 16, 16);
      const endMaterial = new THREE.MeshPhongMaterial({ color: 0xf44336 });
      const endSphere = new THREE.Mesh(endGeometry, endMaterial);
      endSphere.position.copy(points[points.length - 1]);
      threeScene.add(endSphere);
      threePaths.push(endSphere);
    });

    // Create heatmap
    createThreeJsHeatmap(tripData, centerLat, centerLng, scale);

    // Reset camera
    resetCamera();
  }

  function createThreeJsHeatmap(tripData, centerLat, centerLng, scale) {
    // Extract all coordinates for heatmap
    const points = [];

    tripData.forEach((trip) => {
      if (!trip.coordinates) return;

      trip.coordinates.forEach((coord) => {
        const x = (coord[0] - centerLng) * scale;
        const z = (coord[1] - centerLat) * scale * -1;
        points.push(new THREE.Vector2(x, z)); // 2D points for heatmap
      });
    });

    if (points.length === 0) return;

    // Create a canvas for the heatmap
    const size = 512;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");

    // Clear canvas
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, size, size);

    // Draw points with a gradient
    points.forEach((point) => {
      const x = ((point.x / 50 + 1) * size) / 2; // Scale to canvas
      const y = ((point.y / 50 + 1) * size) / 2;

      const gradient = ctx.createRadialGradient(x, y, 0, x, y, size / 30);
      gradient.addColorStop(0, "rgba(255, 0, 0, 1)");
      gradient.addColorStop(0.2, "rgba(255, 255, 0, 0.8)");
      gradient.addColorStop(0.4, "rgba(0, 255, 0, 0.6)");
      gradient.addColorStop(0.6, "rgba(0, 255, 255, 0.4)");
      gradient.addColorStop(0.8, "rgba(0, 0, 255, 0.2)");
      gradient.addColorStop(1, "rgba(0, 0, 0, 0)");

      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(x, y, size / 15, 0, Math.PI * 2);
      ctx.fill();
    });

    // Apply blur for smoother effect
    ctx.filter = "blur(4px)";
    ctx.drawImage(canvas, 0, 0);
    ctx.filter = "none";

    // Create texture from canvas
    const texture = new THREE.CanvasTexture(canvas);

    // Create a plane for the heatmap
    const geometry = new THREE.PlaneGeometry(50, 50);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    threeHeatmap = new THREE.Mesh(geometry, material);
    threeHeatmap.rotation.x = -Math.PI / 2; // Rotate to lay flat
    threeHeatmap.position.y = 0.05; // Slightly above the grid

    threeScene.add(threeHeatmap);
  }

  function animate() {
    requestAnimationFrame(animate);

    if (threeControls) {
      threeControls.update();
    }

    if (threeRenderer && threeScene && threeCamera) {
      threeRenderer.render(threeScene, threeCamera);
    }
  }

  function onWindowResize() {
    if (!threeRenderer || !threeCamera) return;

    const container = document.getElementById("three-container");
    if (!container) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    threeCamera.aspect = width / height;
    threeCamera.updateProjectionMatrix();
    threeRenderer.setSize(width, height);
  }

  // UI CONTROL FUNCTIONS

  function toggleHeatmap() {
    showHeatmap = !showHeatmap;

    // Google Maps heatmap
    if (heatmap) {
      heatmap.setMap(showHeatmap ? map : null);
    }

    // Three.js heatmap
    if (threeHeatmap) {
      threeHeatmap.visible = showHeatmap;
    }
  }

  function togglePaths() {
    showPaths = !showPaths;

    // Google Maps paths
    tripPathsLayer.forEach((path) => {
      path.setMap(showPaths ? map : null);
    });

    // Three.js paths
    threePaths.forEach((path) => {
      path.visible = showPaths;
    });
  }

  function resetCamera() {
    if (!threeCamera || !threeControls) return;

    threeCamera.position.set(0, 20, 30);
    threeCamera.lookAt(0, 0, 0);
    threeControls.update();
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
    renderInsightsList("efficiency-tips-list", insights.efficiency_tips || []);
    renderInsightsList("route-insights-list", insights.route_insights || []);
    renderInsightsList("safety-insights-list", insights.safety_insights || []);
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
      if (elementId === "efficiency-tips-list") icon = "fa-leaf";
      if (elementId === "route-insights-list") icon = "fa-route";
      if (elementId === "safety-insights-list") icon = "fa-shield-alt";

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
