/**
 * LiveTripTracker - Handles real-time trip visualization and updates.
 */
class LiveTripTracker {
    /**
     * Constructor for the LiveTripTracker class.
     * @param {L.Map} map - Leaflet map instance.
     */
    constructor(map) {
        if (!map) throw new Error("Map instance is required");

        // Core properties
        this.map = map;
        this.activeTrips = new Map(); // Stores active trips by transactionId
        this.eventSource = null; // Server-Sent Events connection
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5; // Maximum number of reconnection attempts
        this.reconnectDelay = 1000; // Delay for reconnection in milliseconds
        this.archiveDelay = 10 * 60 * 1000; // Archive delay for completed trips (10 minutes)

        // Configuration for trip visualization
        this.config = {
            tripLine: {
                color: "#00f7ff",
                weight: 4,
                opacity: 0.8,
                className: "active-trip",
            },
            vehicleIcon: {
                className: "vehicle-marker",
                html: '<i class="fas fa-car"></i>',
                iconSize: [24, 24],
                iconAnchor: [12, 12],
            },
        };

        // UI elements
        this.ui = {
            statusIndicator: document.querySelector(".status-indicator"),
            statusText: document.querySelector(".status-text"),
            activeTripsCount: document.querySelector("#active-trips-count"),
            liveMetrics: document.querySelector(".live-trip-metrics"),
        };

        // Map layers
        this.layers = {
            liveTrips: L.layerGroup().addTo(this.map),
            vehicles: L.layerGroup().addTo(this.map),
        };

        // Initialize live tracking
        this.initialize();
    }

    /**
     * Initialize the live trip tracker.
     */
    initialize() {
        this.setupEventSource();
        this.setupPeriodicCleanup();
        this.updateUI();
    }

    /**
     * Set up the Server-Sent Events connection for live tracking.
     */
    setupEventSource() {
        try {
            this.eventSource = new EventSource("/stream");

            this.eventSource.onopen = () => {
                console.log("SSE connection established");
                this.reconnectAttempts = 0;
                this.reconnectDelay = 1000; // Reset delay on successful connection
                this.updateConnectionStatus(true);
            };

            this.eventSource.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.handleTripUpdate(data);
                } catch (error) {
                    console.error("Error processing trip update:", error);
                }
            };

            this.eventSource.onerror = (error) => {
                console.error("SSE connection error:", error);
                this.handleConnectionError();
            };
        } catch (error) {
            console.error("Error setting up EventSource:", error);
            this.handleConnectionError();
        }
    }

    /**
     * Handle errors and implement reconnection logic.
     */
    handleConnectionError() {
        this.updateConnectionStatus(false);

        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            setTimeout(() => {
                console.log(
                    `Attempting to reconnect (${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})...`
                );
                this.setupEventSource();
                this.reconnectAttempts++;
                this.reconnectDelay *= 2; // Exponential backoff
            }, this.reconnectDelay);
        } else {
            console.error("Max reconnection attempts reached");
            this.updateUI("Connection failed. Please refresh the page.");
        }
    }

    /**
     * Handle incoming trip updates.
     * @param {Object} data - Trip update data from the server.
     */
    handleTripUpdate(data) {
        if (!data || !data.data || !data.data.transactionId) {
            console.warn("Invalid trip update data received");
            return;
        }

        const tripId = data.data.transactionId;
        const coords = data.data.coordinates;

        try {
            switch (data.type) {
                case "trip_start":
                    this.initializeTrip(tripId);
                    break;

                case "trip_update":
                    this.updateTripPath(tripId, coords);
                    break;

                case "trip_end":
                    this.handleTripEnd(tripId);
                    break;

                default:
                    console.warn(`Unknown event type: ${data.type}`);
            }

            this.updateUI();
        } catch (error) {
            console.error(`Error handling trip update for ${tripId}:`, error);
        }
    }

    /**
     * Initialize a new trip.
     * @param {string} tripId - Unique identifier for the trip.
     */
    initializeTrip(tripId) {
        if (this.activeTrips.has(tripId)) {
            console.warn(`Trip ${tripId} already exists`);
            return;
        }

        const tripData = {
            polyline: L.polyline([], this.config.tripLine).addTo(this.layers.liveTrips),
            marker: null,
            startTime: new Date(),
            lastUpdate: new Date(),
            metrics: {
                distance: 0,
                averageSpeed: 0,
                maxSpeed: 0,
            },
        };

        this.activeTrips.set(tripId, tripData);
        this.updateUI();
    }

    /**
     * Update the trip path with new coordinates.
     * @param {string} tripId - Unique identifier for the trip.
     * @param {Array} coords - Array of GPS coordinates.
     */
    updateTripPath(tripId, coords) {
        const trip = this.activeTrips.get(tripId);
        if (!trip) {
            console.warn(`Trip ${tripId} not found`);
            return;
        }

        if (!coords || coords.length === 0) {
            console.warn(`No coordinates provided for trip ${tripId}`);
            return;
        }

        const latlngs = coords.map((c) => [c.lat, c.lon]);

        // Update polyline
        trip.polyline.setLatLngs(latlngs);

        // Update vehicle marker
        if (latlngs.length > 0) {
            const lastPos = latlngs[latlngs.length - 1];
            if (!trip.marker) {
                trip.marker = L.marker(lastPos, {
                    icon: L.divIcon(this.config.vehicleIcon),
                }).addTo(this.layers.vehicles);
            } else {
                trip.marker.setLatLng(lastPos);
            }

            // Pan map to follow the vehicle if necessary
            if (this.shouldUpdateMapView(lastPos)) {
                this.map.panTo(lastPos);
            }
        }

        // Update trip metrics
        this.updateTripMetrics(trip, coords);
        trip.lastUpdate = new Date();
    }

    /**
     * Handle trip end event.
     * @param {string} tripId - Unique identifier for the trip.
     */
    handleTripEnd(tripId) {
        const trip = this.activeTrips.get(tripId);
        if (!trip) return;

        // Add an end marker
        const lastPos = trip.polyline.getLatLngs().slice(-1)[0];
        if (lastPos) {
            L.marker(lastPos, {
                icon: L.divIcon({
                    className: "trip-end-marker",
                    html: '<i class="fas fa-flag-checkered"></i>',
                }),
            }).addTo(this.layers.liveTrips);
        }

        // Schedule cleanup
        setTimeout(() => {
            this.archiveTrip(tripId);
        }, this.archiveDelay);
    }

    /**
     * Archive a completed trip.
     * @param {string} tripId - Unique identifier for the trip.
     */
    archiveTrip(tripId) {
        const trip = this.activeTrips.get(tripId);
        if (!trip) return;

        // Remove trip from the map
        this.layers.liveTrips.removeLayer(trip.polyline);
        if (trip.marker) {
            this.layers.vehicles.removeLayer(trip.marker);
        }

        // Remove trip from active trips
        this.activeTrips.delete(tripId);
        this.updateUI();
    }

    /**
     * Update trip metrics such as distance and speed.
     * @param {Object} trip - Trip object.
     * @param {Array} coords - Array of GPS coordinates.
     */
    updateTripMetrics(trip, coords) {
        if (!coords || coords.length < 2) return;

        let distance = 0;
        let maxSpeed = trip.metrics.maxSpeed;

        for (let i = 1; i < coords.length; i++) {
            const prev = coords[i - 1];
            const curr = coords[i];
            distance += this.calculateDistance([prev.lat, prev.lon], [curr.lat, curr.lon]);
            maxSpeed = Math.max(maxSpeed, curr.speed || 0);
        }

        trip.metrics = {
            distance: distance,
            maxSpeed: maxSpeed,
            averageSpeed: distance / ((new Date() - trip.startTime) / 3600000), // mph
        };
    }

    /**
     * Calculate distance between two points (Haversine formula).
     * @param {Array} point1 - [lat, lon].
     * @param {Array} point2 - [lat, lon].
     * @returns {number} Distance in miles.
     */
    calculateDistance(point1, point2) {
        const R = 3959; // Radius of the Earth in miles
        const dLat = this.toRadians(point2[0] - point1[0]);
        const dLon = this.toRadians(point2[1] - point1[1]);
        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(this.toRadians(point1[0])) * Math.cos(this.toRadians(point2[0])) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    /**
     * Convert degrees to radians.
     * @param {number} degrees - Degrees to convert.
     * @returns {number} Radians.
     */
    toRadians(degrees) {
        return degrees * (Math.PI / 180);
    }

    /**
     * Check if the map view should be updated to follow the vehicle.
     * @param {Array} position - [lat, lon].
     * @returns {boolean} Whether to update the map view.
     */
    shouldUpdateMapView(position) {
        return !this.map.getBounds().contains(position);
    }

    /**
     * Update the UI elements for live tracking.
     * @param {string} [statusMessage] - Optional status message.
     */
    updateUI(statusMessage = null) {
        // Update active trips count
        if (this.ui.activeTripsCount) {
            this.ui.activeTripsCount.textContent = this.activeTrips.size;
        }

        // Update status message if provided
        if (statusMessage && this.ui.statusText) {
            this.ui.statusText.textContent = statusMessage;
        }

        // Update trip metrics
        if (this.ui.liveMetrics) {
            let metricsHTML = "";
            for (const [tripId, trip] of this.activeTrips) {
                metricsHTML += `
                    <div class="trip-metrics">
                        <strong>Trip: ${tripId.slice(-6)}</strong><br>
                        Distance: ${trip.metrics.distance.toFixed(2)} mi<br>
                        Avg Speed: ${trip.metrics.averageSpeed.toFixed(1)} mph<br>
                        Max Speed: ${trip.metrics.maxSpeed.toFixed(1)} mph
                    </div>`;
            }
            this.ui.liveMetrics.innerHTML = metricsHTML || "No active trips";
        }
    }

    /**
     * Update connection status indicator.
     * @param {boolean} connected - Whether the connection is active.
     */
    updateConnectionStatus(connected) {
        if (this.ui.statusIndicator) {
            this.ui.statusIndicator.classList.toggle("active", connected);
        }
        if (this.ui.statusText) {
            this.ui.statusText.textContent = connected
                ? "Live Tracking Connected"
                : "Live Tracking Disconnected";
        }
    }

    /**
     * Periodically clean up stale trips.
     */
    setupPeriodicCleanup() {
        setInterval(() => {
            const now = new Date();
            for (const [tripId, trip] of this.activeTrips) {
                // Remove trips not updated in the last 5 minutes
                if (now - trip.lastUpdate > 5 * 60 * 1000) {
                    console.log(`Removing stale trip: ${tripId}`);
                    this.archiveTrip(tripId);
                }
            }
        }, 60 * 1000); // Run every minute
    }

    /**
     * Clean up resources when the tracker is destroyed.
     */
    destroy() {
        if (this.eventSource) {
            this.eventSource.close();
        }
        this.layers.liveTrips.clearLayers();
        this.layers.vehicles.clearLayers();
        this.activeTrips.clear();
    }
}

// Initialize LiveTripTracker when the DOM is ready
document.addEventListener("DOMContentLoaded", () => {
    const map = window.EveryStreet?.getMap();
    if (map) {
        try {
            window.liveTracker = new LiveTripTracker(map);
        } catch (error) {
            console.error("Error initializing LiveTripTracker:", error);
        }
    }
});