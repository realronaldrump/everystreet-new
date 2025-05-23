/* global L, DateUtils */

class LiveTripTracker {
  constructor(map) {
    if (!map) {
      window.handleError(
        "LiveTripTracker: Map is required",
        "LiveTripTracker constructor",
      );
      return;
    }

    this.map = map;
    this.activeTrip = null;
    this.polyline = L.polyline([], {
      color: "#00FF00",
      weight: 3,
      opacity: 0.8,
      zIndex: 1000,
    }).addTo(this.map);

    this.marker = L.marker([0, 0], {
      icon: L.divIcon({
        className: "vehicle-marker",
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      }),
      zIndexOffset: 1000,
    });

    this.lastSequence = 0;
    this.pollingInterval = 2000;
    this.maxPollingInterval = 10000;
    this.minPollingInterval = 500;
    this.pollingTimerId = null;
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 5;
    this.isPolling = false;
    this.lastMarkerLatLng = null; // For animating marker

    this.statusIndicator = document.querySelector(".status-indicator");
    this.statusText = document.querySelector(".status-text");
    this.activeTripsCountElem = document.querySelector("#active-trips-count");
    this.tripMetricsElem = document.querySelector(".live-trip-metrics");
    this.errorMessageElem = document.querySelector(".error-message");

    this.initialize();
  }

  async initialize() {
    try {
      await this.loadInitialTripData();
      this.initWebSocket(); // WebSocket first; fallback to polling if not available
      document.addEventListener("mapUpdated", () => {
        this.bringLiveTripToFront();
      });

      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          this.decreasePollingInterval();
          this.bringLiveTripToFront();
        } else {
          this.increasePollingInterval();
        }
      });

      window.addEventListener("beforeunload", () => {
        this.stopPolling();
      });
    } catch (error) {
      window.handleError(
        `LiveTripTracker initialization error: ${error}`,
        "initialize",
      );
      this.updateStatus(false);
      this.showError("Failed to initialize tracker. Will retry shortly.");
      setTimeout(() => this.initialize(), 5000);
    }
  }

  async loadInitialTripData() {
    try {
      window.handleError(
        "Loading initial trip data",
        "loadInitialTripData",
        "info",
      );
      const response = await fetch("/api/active_trip");

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      window.handleError(
        `Initial trip data response: ${JSON.stringify(data)}`,
        "loadInitialTripData",
        "info",
      );

      if (data.status === "success") {
        if (data.has_active_trip && data.trip) {
          window.handleError(
            `Found active trip: ${data.trip.transactionId} with sequence: ${data.trip.sequence}`,
            "loadInitialTripData",
            "info",
          );
          this.setActiveTrip(data.trip);
          this.updateActiveTripsCount(1);
          this.updateTripMetrics(data.trip);
          this.lastSequence = data.trip.sequence || 0;
          this.updateStatus(true);
        } else {
          window.handleError(
            "No active trips found during initialization",
            "loadInitialTripData",
            "info",
          );
          this.updateStatus(true, "No active trips");
          this.updateActiveTripsCount(0);
        }
      } else {
        throw new Error(data.message || "Error loading initial trip data");
      }
    } catch (error) {
      window.handleError(
        `Error loading initial trip data: ${error}`,
        "loadInitialTripData",
      );
      this.updateStatus(false, "Failed to load trip data");
      this.showError(`Failed to load trip data: ${error.message}`);
      throw error;
    }
  }

  startPolling() {
    if (this.isPolling) return;

    this.isPolling = true;
    this.poll();
    window.handleError(
      `LiveTripTracker: Started polling (${this.pollingInterval}ms interval)`,
      "startPolling",
      "info",
    );
  }

  stopPolling() {
    if (this.pollingTimerId) {
      clearTimeout(this.pollingTimerId);
      this.pollingTimerId = null;
    }
    this.isPolling = false;
    window.handleError(
      "LiveTripTracker: Stopped polling",
      "stopPolling",
      "info",
    );
  }

  async poll() {
    if (!this.isPolling) return;

    try {
      window.handleError(
        `Polling for updates since sequence: ${this.lastSequence}`,
        "poll",
        "info",
      );
      await this.fetchTripUpdates();

      this.consecutiveErrors = 0;

      if (this.activeTrip) {
        this.decreasePollingInterval();
      }
    } catch (error) {
      window.handleError(`Error polling trip updates: ${error}`, "poll");
      this.consecutiveErrors++;

      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        this.updateStatus(false, "Connection lost");
        this.showError("Connection lost. Retrying...");
        this.increasePollingInterval();
      }
    } finally {
      this.pollingTimerId = setTimeout(() => {
        this.poll();
      }, this.pollingInterval);
    }
  }

  async fetchTripUpdates() {
    window.handleError(
      `Fetching trip updates with last_sequence=${this.lastSequence}`,
      "fetchTripUpdates",
      "info",
    );

    const response = await fetch(
      `/api/trip_updates?last_sequence=${this.lastSequence}`,
    );

    if (!response.ok) {
      window.handleError(`HTTP error: ${response.status}`, "fetchTripUpdates");
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    window.handleError(
      `Trip update response: ${JSON.stringify(data)}`,
      "fetchTripUpdates",
      "info",
    );

    if (data.status === "success") {
      if (data.has_update && data.trip) {
        window.handleError(
          `Received trip update with sequence: ${data.trip.sequence}`,
          "fetchTripUpdates",
          "info",
        );
        this.setActiveTrip(data.trip);
        this.updateActiveTripsCount(1);
        this.updateTripMetrics(data.trip);
        this.lastSequence = data.trip.sequence || this.lastSequence;
        this.updateStatus(true);
        this.hideError();

        this.setAdaptivePollingInterval(data.trip, true);
      } else if (this.activeTrip && !data.has_update) {
        window.handleError(
          "No new updates for current trip",
          "fetchTripUpdates",
          "info",
        );
        this.updateStatus(true);

        this.setAdaptivePollingInterval(this.activeTrip, false);
      } else if (!this.activeTrip && !data.has_update) {
        window.handleError("No active trips found", "fetchTripUpdates", "info");
        this.clearActiveTrip();
        this.updateActiveTripsCount(0);
        this.updateStatus(true, "No active trips");

        this.increasePollingInterval(1.2);
      }
    } else {
      window.handleError(
        `API error: ${data.message || "Unknown error"}`,
        "fetchTripUpdates",
      );
      throw new Error(data.message || "Unknown error fetching trip updates");
    }
  }

  increasePollingInterval(factor = 1.5) {
    const oldInterval = this.pollingInterval;
    this.pollingInterval = Math.min(
      this.pollingInterval * factor,
      this.maxPollingInterval,
    );

    if (this.pollingInterval !== oldInterval) {
      window.handleError(
        `LiveTripTracker: Increased polling interval to ${Math.round(this.pollingInterval)}ms`,
        "increasePollingInterval",
        "info",
      );
    }

    if (this.pollingInterval >= this.maxPollingInterval && !this.activeTrip) {
      this.updateStatus(true, "Standby mode - waiting for trips");
    }
  }

  decreasePollingInterval(factor = 0.7, forceMinimum = false) {
    const oldInterval = this.pollingInterval;

    if (forceMinimum) {
      this.pollingInterval = this.minPollingInterval;
    } else {
      this.pollingInterval = Math.max(
        this.pollingInterval * factor,
        this.activeTrip ? this.minPollingInterval : this.minPollingInterval * 2,
      );
    }

    if (this.pollingInterval !== oldInterval) {
      window.handleError(
        `LiveTripTracker: Decreased polling interval to ${Math.round(this.pollingInterval)}ms`,
        "decreasePollingInterval",
        "info",
      );
    }

    if (this.activeTrip) {
      this.updateStatus(true, "Connected - tracking active");
    }
  }

  setAdaptivePollingInterval(trip, hasNewData) {
    if (!trip) {
      this.increasePollingInterval(1.2);
      return;
    }

    const isMoving = trip.currentSpeed > 2;
    const isFastMoving = trip.currentSpeed > 15;

    if (isFastMoving && hasNewData) {
      this.decreasePollingInterval(0.5, true);
    } else if (isMoving && hasNewData) {
      this.decreasePollingInterval(0.8);
    } else if (isMoving) {
      this.pollingInterval = Math.max(
        this.minPollingInterval * 1.5,
        Math.min(this.pollingInterval, this.maxPollingInterval / 2),
      );
    } else if (hasNewData) {
      this.pollingInterval = Math.max(
        this.minPollingInterval * 1.5,
        Math.min(this.pollingInterval, this.maxPollingInterval / 2),
      );
    } else {
      this.increasePollingInterval(1.1);
    }
  }

  updateStatus(connected, message) {
    if (!this.statusIndicator || !this.statusText) return;

    this.statusIndicator.classList.toggle("connected", connected);
    this.statusIndicator.classList.toggle("disconnected", !connected);
    this.statusIndicator.setAttribute(
      "aria-label",
      connected ? "Connected" : "Disconnected",
    );

    this.statusText.textContent =
      message || (connected ? "Connected" : "Disconnected");
  }

  showError(message) {
    if (!this.errorMessageElem) return;

    this.errorMessageElem.textContent = message;
    this.errorMessageElem.classList.remove("d-none");
  }

  hideError() {
    if (!this.errorMessageElem) return;

    this.errorMessageElem.classList.add("d-none");
  }

  setActiveTrip(trip) {
    if (!trip) return;

    // Prevent redundant redraws if nothing changed:
    if (this.activeTrip && this.activeTrip.sequence === trip.sequence) return;

    const isNewTrip =
      !this.activeTrip || this.activeTrip.transactionId !== trip.transactionId;

    if (trip.status === "completed") {
      window.handleError(
        "Trip is completed, clearing from map",
        "setActiveTrip",
        "info",
      );
      this.clearActiveTrip();
      this.updateActiveTripsCount(0);
      this.updateStatus(true, "No active trips");
      return;
    }

    this.activeTrip = trip;

    if (!Array.isArray(trip.coordinates) || trip.coordinates.length === 0) {
      this.clearActiveTrip();
      return;
    }

    const sortedCoords = [...trip.coordinates];
    sortedCoords.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const latLngs = sortedCoords.map((coord) => [coord.lat, coord.lon]);
    const lastPoint = latLngs[latLngs.length - 1];

    if (isNewTrip) {
      this.polyline.setLatLngs(latLngs);
      this.polyline.bringToFront();

      if (!this.map.hasLayer(this.marker)) {
        this.marker.addTo(this.map);
      }

      this.marker.setLatLng(lastPoint);
      this.marker.setOpacity(1);

      if (latLngs.length > 1) {
        try {
          const bounds = L.latLngBounds(latLngs);
          this.map.fitBounds(bounds, { padding: [50, 50] });
        } catch (e) {
          console.error("Error fitting bounds:", e);
          this.map.setView(lastPoint, 15);
          window.handleError(`Error fitting bounds: ${e}`, "setActiveTrip");
        }
      } else {
        this.map.setView(lastPoint, 15);
      }
    } else {
      const prevCoords = this.polyline.getLatLngs();

      // Optimize for single new point added:
      if (latLngs.length > prevCoords.length) {
        if (latLngs.length - prevCoords.length === 1) {
          // Just add the latest point to polyline:
          this.polyline.addLatLng(lastPoint);
        } else {
          // More than one new point, redraw
          this.polyline.setLatLngs(latLngs);
        }
        this.polyline.bringToFront();

        if (prevCoords.length > 0) {
          const prevLastPoint = prevCoords[prevCoords.length - 1];

          if (
            prevLastPoint[0] !== lastPoint[0] ||
            prevLastPoint[1] !== lastPoint[1]
          ) {
            // Animate marker between old and new position for smoothness:
            if (this.lastMarkerLatLng && lastPoint) {
              this.animateMarker(this.lastMarkerLatLng, lastPoint);
            } else {
              this.marker.setLatLng(lastPoint);
            }
            this.lastMarkerLatLng = lastPoint;

            if (window.utils.getStorage("autoFollowVehicle") === "true") {
              if (!this.map.getBounds().contains(lastPoint)) {
                this.map.panTo(lastPoint);
              }
            }
          }
        } else {
          this.marker.setLatLng(lastPoint);
          this.lastMarkerLatLng = lastPoint;
        }
      }
    }

    this.updateMarkerIcon(trip.currentSpeed);
  }

  animateMarker(from, to) {
    const duration = 100; // ms
    const start = performance.now();
    const marker = this.marker;

    function animate(now) {
      const t = Math.min(1, (now - start) / duration);
      const lat = from[0] + (to[0] - from[0]) * t;
      const lng = from[1] + (to[1] - from[1]) * t;
      marker.setLatLng([lat, lng]);
      if (t < 1) requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
  }

  updateMarkerIcon(speed) {
    if (!this.marker) return;

    let iconClass = "vehicle-marker";

    if (speed === 0) {
      iconClass += " vehicle-stopped";
    } else if (speed < 10) {
      iconClass += " vehicle-slow";
    } else if (speed < 35) {
      iconClass += " vehicle-medium";
    } else {
      iconClass += " vehicle-fast";
    }

    if (this.marker.options.icon.options.className !== iconClass) {
      this.marker.setIcon(
        L.divIcon({
          className: iconClass,
          iconSize: [12, 12],
          iconAnchor: [6, 6],
          html: `<div class="vehicle-marker-inner" data-speed="${Math.round(
            speed,
          )}"></div>`,
        }),
      );
    }
  }

  clearActiveTrip() {
    this.activeTrip = null;
    this.polyline.setLatLngs([]);

    if (this.map.hasLayer(this.marker)) {
      this.marker.removeFrom(this.map);
    }
  }

  updateActiveTripsCount(count) {
    if (this.activeTripsCountElem) {
      this.activeTripsCountElem.textContent = count;
      this.activeTripsCountElem.setAttribute(
        "aria-label",
        `${count} active trips`,
      );
    }
  }

  updateTripMetrics(trip) {
    if (!this.tripMetricsElem || !trip) return;

    let startTime = trip.startTime ? new Date(trip.startTime) : null;
    const lastUpdate = trip.lastUpdate ? new Date(trip.lastUpdate) : null;
    const endTime = trip.endTime ? new Date(trip.endTime) : null;
    const tripStatus = trip.status || "active";

    let durationStr = trip.durationFormatted;
    if (!durationStr && startTime) {
      const endTimeToUse =
        tripStatus === "completed" ? endTime : lastUpdate || new Date();

      if (endTimeToUse) {
        durationStr = DateUtils.formatDurationHMS(startTime, endTimeToUse);
      }
    }

    const distance = typeof trip.distance === "number" ? trip.distance : 0;
    const currentSpeed =
      typeof trip.currentSpeed === "number" ? trip.currentSpeed : 0;
    const avgSpeed = typeof trip.avgSpeed === "number" ? trip.avgSpeed : 0;
    const maxSpeed = typeof trip.maxSpeed === "number" ? trip.maxSpeed : 0;
    const pointsRecorded = trip.pointsRecorded || trip.coordinates?.length || 0;
    const startOdometer =
      trip.startOdometer !== undefined && trip.startOdometer !== null
        ? trip.startOdometer
        : "N/A";
    const totalIdlingTime =
      typeof trip.totalIdlingTime === "number" ? trip.totalIdlingTime : 0;
    const hardBrakingCounts =
      typeof trip.hardBrakingCounts === "number" ? trip.hardBrakingCounts : 0;
    const hardAccelerationCounts =
      typeof trip.hardAccelerationCounts === "number"
        ? trip.hardAccelerationCounts
        : 0;

    let startTimeFormatted = "N/A";

    if (trip.startTimeFormatted) {
      startTimeFormatted = trip.startTimeFormatted;
    } else if (startTime) {
      try {
        if (typeof startTime === "string") {
          startTime = new Date(startTime);
        }

        if (!isNaN(startTime.getTime())) {
          startTimeFormatted = startTime.toLocaleString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "numeric",
            second: "numeric",
            hour12: true,
          });
        }
      } catch (err) {
        console.error("Error formatting start time:", err);
      }
    }

    const metrics = this.formatTripMetrics({
      trip,
      startTime,
      lastUpdate,
      endTime,
      tripStatus,
      durationStr,
      distance,
      currentSpeed,
      avgSpeed,
      maxSpeed,
      pointsRecorded,
      startOdometer,
      totalIdlingTime,
      hardBrakingCounts,
      hardAccelerationCounts,
      startTimeFormatted,
    });

    window.handleError(
      `Displaying metrics:${JSON.stringify(metrics)}`,
      "updateTripMetrics",
      "info",
    );

    this.tripMetricsElem.innerHTML = Object.entries(metrics)
      .map(
        ([label, value]) => `<div class="metric-row">
        <span class="metric-label">${label}:</span>
        <span class="metric-value">${value}</span>
      </div>`,
      )
      .join("");
  }

  formatTripMetrics({
    trip,
    startTime,
    lastUpdate,
    endTime,
    tripStatus,
    durationStr,
    distance,
    currentSpeed,
    avgSpeed,
    maxSpeed,
    pointsRecorded,
    startOdometer,
    totalIdlingTime,
    hardBrakingCounts,
    hardAccelerationCounts,
    startTimeFormatted,
  }) {
    return {
      "Start Time": startTimeFormatted,
      Duration: durationStr || "0:00:00",
      Distance: `${distance.toFixed(2)} miles`,
      "Current Speed": `${currentSpeed.toFixed(1)} mph`,
      "Average Speed": `${avgSpeed.toFixed(1)} mph`,
      "Max Speed": `${maxSpeed.toFixed(1)} mph`,
      "Points Recorded": pointsRecorded,
      "Start Odometer": `${startOdometer}${startOdometer !== "N/A" ? " miles" : ""}`,
      "Total Idling Time": `${DateUtils.formatSecondsToHMS(totalIdlingTime)}`,
      "Hard Braking": hardBrakingCounts,
      "Hard Acceleration": hardAccelerationCounts,
      "Last Update": lastUpdate ? DateUtils.formatTimeAgo(lastUpdate) : "N/A",
    };
  }

  updatePolylineStyle(color, opacity) {
    if (!this.polyline) return;

    this.polyline.setStyle({
      color: color || "#00FF00",
      opacity: parseFloat(opacity) || 0.8,
      zIndex: 1000,
    });

    if (
      this.activeTrip?.coordinates &&
      this.activeTrip.coordinates.length > 0
    ) {
      this.polyline.redraw();
      this.bringLiveTripToFront();
    }

    window.handleError(
      "LiveTripTracker: Polyline style updated",
      "updatePolylineStyle",
      "info",
    );
  }

  bringLiveTripToFront() {
    if (this.polyline && this.map.hasLayer(this.polyline)) {
      this.polyline.bringToFront();
      window.handleError(
        "LiveTripTracker: Polyline brought to front",
        "bringLiveTripToFront",
        "info",
      );
    }
    if (this.marker && this.map.hasLayer(this.marker)) {
      this.marker.bringToFront();
    }
  }

  destroy() {
    this.stopPolling();

    if (this.map) {
      if (this.map.hasLayer(this.polyline)) {
        this.map.removeLayer(this.polyline);
      }

      if (this.map.hasLayer(this.marker)) {
        this.map.removeLayer(this.marker);
      }
    }

    this.updateStatus(false, "Disconnected");
    this.updateActiveTripsCount(0);

    if (this.tripMetricsElem) {
      this.tripMetricsElem.innerHTML = "";
    }

    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );

    window.handleError("LiveTripTracker instance destroyed", "destroy", "info");
  }

  /**
   * Initialize WebSocket live channel.
   * Falls back to polling when socket closes or errors.
   */
  initWebSocket() {
    if (!("WebSocket" in window)) {
      return this.startPolling();
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws/trips`;
    try {
      this.ws = new WebSocket(url);

      // Batch updates & run all changes in the animation frame loop for ultra-smoothness:
      let needsUpdate = false;
      let latestTrip = null;

      this.ws.addEventListener("message", (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data && data.trip) {
            latestTrip = data.trip;
            needsUpdate = true;
          }
        } catch (err) {
          console.warn("LiveTripTracker WebSocket parse error:", err);
        }
      });

      const updateLoop = () => {
        if (needsUpdate && latestTrip) {
          this.setActiveTrip(latestTrip);
          this.updateTripMetrics(latestTrip);
          needsUpdate = false;
        }
        requestAnimationFrame(updateLoop);
      };
      updateLoop();

      this.ws.addEventListener("open", () => {
        console.info("LiveTripTracker: WebSocket connected – stopping poller");
        this.stopPolling?.();
      });
      this.ws.addEventListener("close", (event) => {
        console.warn("WebSocket closed – resuming polling", {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });
        this.startPolling();
      });
      this.ws.addEventListener("error", (event) => {
        console.warn("WebSocket error – resuming polling", event);
        this.startPolling();
      });
    } catch (e) {
      console.warn("Failed to establish WebSocket:", e);
      this.startPolling();
    }
  }
}

window.LiveTripTracker = LiveTripTracker;
