/**
 * LiveCoverageTracker - Tracks and visualizes real-time street coverage
 * @class
 */
class LiveCoverageTracker {
  /**
   * Creates a new LiveCoverageTracker instance
   * @param {L.Map} map - Leaflet map instance
   * @param {LiveTripTracker} tripTracker - Optional LiveTripTracker instance to integrate with
   */
  constructor(map, tripTracker = null) {
    if (!map) {
      throw new Error("LiveCoverageTracker: Map is required");
    }

    // Initialize properties
    this.map = map;
    this.tripTracker = tripTracker;
    this.coverageLayer = null;
    this.streetsLayer = null;
    this.coveredSegments = new Set();
    this.segmentLookup = new Map();
    this.totalSegments = 0;
    this.totalLength = 0;
    this.coveredLength = 0;
    this.isActive = false;
    this.currentLocation = null;
    this.websocket = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectTimeout = null;
    this.availableAreas = [];

    // UI elements
    this.coverageStatsElem = document.querySelector(".coverage-stats");
    this.coveragePercentElem = document.querySelector(".coverage-percent");
    this.coverageMilesElem = document.querySelector(".coverage-miles");
    this.coverageToggleBtn = document.querySelector("#toggle-live-coverage");
    this.areaSelectElem = document.querySelector("#coverage-area-select");

    // Initialize
    this.initialize();
  }

  /**
   * Initialize the tracker
   * @async
   */
  async initialize() {
    try {
      // Create coverage layer
      this.coverageLayer = L.layerGroup().addTo(this.map);
      this.streetsLayer = L.layerGroup();

      // Fetch available coverage areas
      await this.fetchAvailableCoverageAreas();

      // Set up event listeners
      if (this.coverageToggleBtn) {
        this.coverageToggleBtn.addEventListener("click", () =>
          this.toggleCoverage(),
        );
      }

      // If we have a trip tracker, listen for its updates
      if (this.tripTracker) {
        document.addEventListener("liveTripUpdate", (e) => {
          if (this.isActive && e.detail && e.detail.coordinates) {
            this.processNewCoordinates(e.detail.coordinates);
          }
        });
      }
    } catch (error) {
      window.notificationManager.show(
        "Error initializing live coverage tracker: " + error.message,
        "danger",
      );
    }
  }

  /**
   * Fetch available coverage areas from the server
   */
  async fetchAvailableCoverageAreas() {
    try {
      const response = await fetch("/api/coverage_areas");
      if (!response.ok) throw new Error("Failed to fetch coverage areas");

      const data = await response.json();
      this.availableAreas = data.areas || [];

      // Update the area select dropdown if it exists
      if (this.areaSelectElem) {
        this.areaSelectElem.innerHTML = "";

        if (this.availableAreas.length === 0) {
          const option = document.createElement("option");
          option.value = "";
          option.textContent = "No coverage areas available";
          option.disabled = true;
          option.selected = true;
          this.areaSelectElem.appendChild(option);
          this.coverageToggleBtn.disabled = true;

          // Add a message and link to coverage management
          const statusCard = document.querySelector(
            ".live-coverage-status .card-body",
          );
          if (statusCard) {
            const messageDiv = document.createElement("div");
            messageDiv.className = "alert alert-warning mt-2";
            messageDiv.innerHTML = `
              No coverage areas found. Please add areas in the 
              <a href="/coverage-management" class="alert-link">Coverage Management</a> section first.
            `;
            statusCard.appendChild(messageDiv);
          }
        } else {
          const defaultOption = document.createElement("option");
          defaultOption.value = "";
          defaultOption.textContent = "Select a coverage area";
          defaultOption.disabled = true;
          defaultOption.selected = true;
          this.areaSelectElem.appendChild(defaultOption);

          this.availableAreas.forEach((area) => {
            const option = document.createElement("option");
            option.value = area.location.display_name;
            option.textContent = area.location.display_name;
            option.dataset.location = JSON.stringify(area.location);
            this.areaSelectElem.appendChild(option);
          });

          this.coverageToggleBtn.disabled = false;

          // Remove any existing message
          const existingMessage = document.querySelector(
            ".live-coverage-status .alert",
          );
          if (existingMessage) {
            existingMessage.remove();
          }
        }
      } else {
        // If the select element doesn't exist, create it
        this.createAreaSelectUI();
      }
    } catch (error) {
      window.notificationManager.show(
        "Error fetching coverage areas: " + error.message,
        "warning",
      );

      // Create empty select if it doesn't exist
      if (!this.areaSelectElem) {
        this.createAreaSelectUI();
      }
    }
  }

  /**
   * Create the area select UI if it doesn't exist
   */
  createAreaSelectUI() {
    // Find the coverage status card
    const statusCard = document.querySelector(
      ".live-coverage-status .card-body",
    );
    if (!statusCard) return;

    // Create the select element container
    const selectContainer = document.createElement("div");
    selectContainer.className = "mb-3 mt-2";

    // Create label
    const label = document.createElement("label");
    label.htmlFor = "coverage-area-select";
    label.className = "form-label";
    label.textContent = "Coverage Area:";

    // Create select element
    this.areaSelectElem = document.createElement("select");
    this.areaSelectElem.id = "coverage-area-select";
    this.areaSelectElem.className = "form-select form-select-sm";

    // Add default option
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent =
      this.availableAreas.length > 0
        ? "Select a coverage area"
        : "No coverage areas available";
    defaultOption.disabled = true;
    defaultOption.selected = true;
    this.areaSelectElem.appendChild(defaultOption);

    // Add available areas
    this.availableAreas.forEach((area) => {
      const option = document.createElement("option");
      option.value = area.location.display_name;
      option.textContent = area.location.display_name;
      option.dataset.location = JSON.stringify(area.location);
      this.areaSelectElem.appendChild(option);
    });

    // Add elements to container
    selectContainer.appendChild(label);
    selectContainer.appendChild(this.areaSelectElem);

    // Insert before the coverage stats
    statusCard.insertBefore(selectContainer, this.coverageStatsElem);

    // Disable toggle button if no areas available
    if (this.coverageToggleBtn) {
      this.coverageToggleBtn.disabled = this.availableAreas.length === 0;
    }
  }

  /**
   * Toggle coverage tracking on/off
   */
  toggleCoverage() {
    if (this.isActive) {
      this.deactivate();
    } else {
      this.activate();
    }
  }

  /**
   * Activate coverage tracking
   */
  async activate() {
    if (this.isActive) return;

    try {
      // Check if an area is selected
      if (!this.areaSelectElem || !this.areaSelectElem.value) {
        window.notificationManager.show(
          "Please select a coverage area first.",
          "warning",
        );
        return;
      }

      // Get the selected location
      const selectedOption =
        this.areaSelectElem.options[this.areaSelectElem.selectedIndex];
      let location;

      try {
        location = JSON.parse(selectedOption.dataset.location);
      } catch (e) {
        // If parsing fails, try to find the location in availableAreas
        const area = this.availableAreas.find(
          (a) => a.location.display_name === this.areaSelectElem.value,
        );
        if (area) {
          location = area.location;
        } else {
          throw new Error("Could not determine selected location");
        }
      }

      if (!location) {
        window.notificationManager.show(
          "Could not determine selected location. Please try again.",
          "warning",
        );
        return;
      }

      this.currentLocation = location;

      // Connect to WebSocket for live updates
      this.connectWebSocket();

      // Update UI to show we're in the process of activating
      if (this.coverageToggleBtn) {
        this.coverageToggleBtn.textContent = "Activating...";
        this.coverageToggleBtn.disabled = true;
      }

      // Load streets for the area
      try {
        await this.loadStreets(location);

        // Update UI
        this.isActive = true;
        if (this.coverageToggleBtn) {
          this.coverageToggleBtn.textContent = "Disable Live Coverage";
          this.coverageToggleBtn.classList.replace("btn-success", "btn-danger");
          this.coverageToggleBtn.disabled = false;
        }

        // Disable area select while active
        if (this.areaSelectElem) {
          this.areaSelectElem.disabled = true;
        }

        window.notificationManager.show(
          `Live coverage tracking enabled for ${location.display_name}`,
          "success",
        );

        // Add streets layer to map
        this.streetsLayer.addTo(this.map);

        // If we have active trip data, process it
        if (this.tripTracker && this.tripTracker.activeTrip) {
          this.processNewCoordinates(this.tripTracker.activeTrip.coordinates);
        }
      } catch (streetError) {
        if (streetError.message === "Streets are being processed") {
          // Streets are being processed, set up a retry mechanism
          window.notificationManager.show(
            "Streets are being processed. Will automatically retry in 5 seconds...",
            "info",
          );

          if (this.coverageToggleBtn) {
            this.coverageToggleBtn.textContent = "Processing...";
          }

          // Retry after 5 seconds
          setTimeout(() => {
            if (this.coverageToggleBtn) {
              this.coverageToggleBtn.textContent = "Enable Live Coverage";
              this.coverageToggleBtn.disabled = false;
            }
            window.notificationManager.show(
              "Please try enabling coverage again in a few moments.",
              "info",
            );
          }, 5000);
        } else {
          // Other error, reset UI
          if (this.coverageToggleBtn) {
            this.coverageToggleBtn.textContent = "Enable Live Coverage";
            this.coverageToggleBtn.disabled = false;
          }
          throw streetError;
        }
      }
    } catch (error) {
      window.notificationManager.show(
        "Error activating coverage tracking: " + error.message,
        "danger",
      );

      // Reset UI
      if (this.coverageToggleBtn) {
        this.coverageToggleBtn.textContent = "Enable Live Coverage";
        this.coverageToggleBtn.disabled = false;
      }

      // Re-enable area select
      if (this.areaSelectElem) {
        this.areaSelectElem.disabled = false;
      }
    }
  }

  /**
   * Deactivate coverage tracking
   */
  deactivate() {
    if (!this.isActive) return;

    // Disconnect WebSocket
    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
    }

    // Clear timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Clear layers
    this.coverageLayer.clearLayers();
    this.map.removeLayer(this.streetsLayer);

    // Reset state
    this.coveredSegments.clear();
    this.segmentLookup.clear();
    this.totalSegments = 0;
    this.totalLength = 0;
    this.coveredLength = 0;
    this.isActive = false;
    this.currentLocation = null;

    // Update UI
    if (this.coverageToggleBtn) {
      this.coverageToggleBtn.textContent = "Enable Live Coverage";
      this.coverageToggleBtn.classList.replace("btn-danger", "btn-success");
    }

    // Re-enable area select
    if (this.areaSelectElem) {
      this.areaSelectElem.disabled = false;
    }

    this.updateCoverageStats(0, 0, 0);

    window.notificationManager.show("Live coverage tracking disabled", "info");
  }

  /**
   * Load streets for the given location
   * @param {Object} location - Location object
   */
  async loadStreets(location) {
    try {
      window.notificationManager.show(
        "Loading streets for coverage tracking...",
        "info",
      );

      const response = await fetch("/api/streets_for_coverage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location }),
      });

      // Handle 202 status (streets being processed)
      if (response.status === 202) {
        const data = await response.json();
        throw new Error("Streets are being processed");
      }

      // Handle 400 status (invalid coverage area)
      if (response.status === 400) {
        const data = await response.json();
        throw new Error(data.error || "Invalid coverage area");
      }

      if (!response.ok) throw new Error("Failed to load streets");
      const data = await response.json();

      if (!data.streets || data.streets.length === 0) {
        throw new Error("No streets found for this location");
      }

      // Process streets data
      this.totalSegments = data.streets.length;
      this.totalLength = data.total_length || 0;

      // Clear existing streets
      this.streetsLayer.clearLayers();
      this.segmentLookup.clear();
      this.coveredSegments.clear();

      // Add streets to map
      data.streets.forEach((street) => {
        const segmentId = street.properties.segment_id;
        const geojsonLayer = L.geoJSON(street, {
          style: {
            color: "#555555",
            weight: 2,
            opacity: 0.7,
          },
        });

        this.segmentLookup.set(segmentId, {
          layer: geojsonLayer,
          length: street.properties.segment_length || 0,
          covered: false,
        });

        this.streetsLayer.addLayer(geojsonLayer);
      });

      // Get current coverage status for this area
      try {
        const encodedName = encodeURIComponent(location.display_name);
        const statusResponse = await fetch(
          `/api/coverage_status/${encodedName}`,
        );
        if (statusResponse.ok) {
          const statusData = await statusResponse.json();
          if (statusData.coverage_percentage > 0) {
            // Update stats with existing coverage data
            this.updateCoverageStats(
              statusData.driven_length || 0,
              this.totalLength,
              statusData.coverage_percentage || 0,
            );
          } else {
            // No existing coverage, start at 0
            this.updateCoverageStats(0, this.totalLength, 0);
          }
        } else {
          // If status fetch fails, start at 0
          this.updateCoverageStats(0, this.totalLength, 0);
        }
      } catch (statusError) {
        // If status fetch fails, start at 0
        this.updateCoverageStats(0, this.totalLength, 0);
      }

      window.notificationManager.show(
        `Loaded ${this.totalSegments} street segments for coverage tracking`,
        "success",
      );
    } catch (error) {
      // If it's the "Streets are being processed" error, propagate it
      if (error.message === "Streets are being processed") {
        throw error;
      }

      window.notificationManager.show(
        "Error loading streets: " + error.message,
        "danger",
      );
      this.deactivate();
    }
  }

  /**
   * Connect to WebSocket for live coverage updates
   */
  connectWebSocket() {
    // Clear any existing reconnect timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Create new WebSocket connection
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${protocol}://${window.location.host}/ws/live_coverage`;

    this.websocket = new WebSocket(wsUrl);

    // Set up event handlers
    this.websocket.addEventListener("open", () => {
      this.reconnectAttempts = 0;

      // Send current location to server
      if (this.currentLocation) {
        this.websocket.send(
          JSON.stringify({
            type: "subscribe",
            location: this.currentLocation,
          }),
        );
      }
    });

    this.websocket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        this.handleWebSocketMessage(message);
      } catch (err) {
        console.error("Error parsing WebSocket message:", err);
      }
    });

    this.websocket.addEventListener("error", (err) => {
      console.error("WebSocket error:", err);
    });

    this.websocket.addEventListener("close", () => {
      this.attemptReconnect();
    });
  }

  /**
   * Attempt to reconnect to WebSocket
   */
  attemptReconnect() {
    if (!this.isActive) return;

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

      window.notificationManager.show(
        `Coverage WebSocket reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
        "info",
      );

      this.reconnectTimeout = setTimeout(() => {
        this.connectWebSocket();
      }, delay);
    } else {
      window.notificationManager.show(
        "Maximum WebSocket reconnect attempts reached. Coverage updates paused.",
        "warning",
      );
    }
  }

  /**
   * Handle messages from WebSocket
   * @param {Object} message - Message data
   */
  handleWebSocketMessage(message) {
    if (!message || !message.type) return;

    switch (message.type) {
      case "coverage_update":
        if (message.data) {
          // Add newly covered segments to our existing set
          if (
            message.data.covered_segments &&
            Array.isArray(message.data.covered_segments)
          ) {
            this.updateCoveredSegments(message.data.covered_segments);
          }

          // Update coverage stats with the full data
          this.updateCoverageStats(
            message.data.covered_length || 0,
            message.data.total_length || this.totalLength,
            message.data.coverage_percentage || 0,
          );
        }
        break;

      case "info":
        window.notificationManager.show(
          message.message || "Info from server",
          "info",
        );
        break;

      case "error":
        window.notificationManager.show(
          "Coverage error: " + message.message,
          "danger",
        );
        break;

      default:
        console.warn("Unhandled WebSocket message type:", message.type);
    }
  }

  /**
   * Process new coordinates from live tracking
   * @param {Array} coordinates - Array of coordinate objects
   */
  processNewCoordinates(coordinates) {
    if (!this.isActive || !coordinates || coordinates.length < 2) return;

    // Format coordinates for the server
    const formattedCoords = coordinates.map((coord) => {
      return Array.isArray(coord) ? coord : [coord.lon, coord.lat];
    });

    // Send to server for processing if websocket is connected
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      this.websocket.send(
        JSON.stringify({
          type: "process_coordinates",
          coordinates: formattedCoords,
          location: this.currentLocation,
        }),
      );
    }
  }

  /**
   * Update covered segments on the map
   * @param {Array} coveredSegmentIds - Array of covered segment IDs
   */
  updateCoveredSegments(coveredSegmentIds) {
    if (
      !coveredSegmentIds ||
      !Array.isArray(coveredSegmentIds) ||
      coveredSegmentIds.length === 0
    )
      return;

    // Track newly covered segments
    const newlyCovered = [];

    // Check if this is an initial load (large number of segments)
    const isInitialLoad = coveredSegmentIds.length > 100;

    // Process in batches to avoid UI freezing with large updates
    const batchSize = isInitialLoad ? 100 : 50;
    const processBatch = (startIdx) => {
      const endIdx = Math.min(startIdx + batchSize, coveredSegmentIds.length);
      const batch = coveredSegmentIds.slice(startIdx, endIdx);

      batch.forEach((segmentId) => {
        // Skip if already covered
        if (this.coveredSegments.has(segmentId)) return;

        // Mark as covered
        this.coveredSegments.add(segmentId);
        newlyCovered.push(segmentId);

        // Update segment style
        const segment = this.segmentLookup.get(segmentId);
        if (segment && segment.layer) {
          segment.layer.setStyle({
            color: "#00FF00",
            weight: 3,
            opacity: 0.8,
          });

          segment.covered = true;
        }
      });

      // Process next batch if needed
      if (endIdx < coveredSegmentIds.length) {
        setTimeout(() => processBatch(endIdx), 0);
      } else {
        // All batches processed, show notification if needed
        if (newlyCovered.length > 0 && !isInitialLoad) {
          window.notificationManager.show(
            `Covered ${newlyCovered.length} new street segments!`,
            "success",
          );
        } else if (isInitialLoad && newlyCovered.length > 0) {
          window.notificationManager.show(
            `Loaded ${newlyCovered.length} previously covered street segments`,
            "info",
          );
        }
      }
    };

    // Start processing the first batch
    processBatch(0);
  }

  /**
   * Update coverage statistics in the UI
   * @param {number} coveredLength - Length of covered streets in meters
   * @param {number} totalLength - Total length of streets in meters
   * @param {number} percentage - Coverage percentage
   */
  updateCoverageStats(coveredLength, totalLength, percentage) {
    this.coveredLength = coveredLength;

    // Convert meters to miles
    const coveredMiles = (coveredLength / 1609.34).toFixed(2);
    const totalMiles = (totalLength / 1609.34).toFixed(2);

    // Update UI elements if they exist
    if (this.coveragePercentElem) {
      this.coveragePercentElem.textContent = `${percentage.toFixed(1)}%`;
    }

    if (this.coverageMilesElem) {
      this.coverageMilesElem.textContent = `${coveredMiles} / ${totalMiles} miles`;
    }

    // Dispatch event for other components
    document.dispatchEvent(
      new CustomEvent("liveCoverageUpdate", {
        detail: {
          coveredLength,
          totalLength,
          percentage,
          coveredMiles,
          totalMiles,
          coveredSegments: this.coveredSegments.size,
          totalSegments: this.totalSegments,
        },
      }),
    );
  }

  /**
   * Clean up resources when destroying the tracker
   */
  destroy() {
    this.deactivate();

    if (this.coverageToggleBtn) {
      this.coverageToggleBtn.removeEventListener("click", () =>
        this.toggleCoverage(),
      );
    }

    document.removeEventListener("liveTripUpdate", () => {});
  }
}

// Export for use in other modules
window.LiveCoverageTracker = LiveCoverageTracker;
