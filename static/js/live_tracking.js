class LiveTripTracker {
    constructor(map) {
        if (!map) throw new Error("Map instance is required");

        this.map = map;
        this.activeTrips = new Map();
        this.eventSource = null;

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

        this.layers = {
            liveTrips: L.layerGroup().addTo(this.map),
            vehicles: L.layerGroup().addTo(this.map),
        };

        this.initialize();
    }

    initialize() {
        this.setupEventSource();
    }

    setupEventSource() {
        try {
            this.eventSource = new EventSource("/stream");

            this.eventSource.onopen = () => {
                console.log("SSE connection established");
            };

            this.eventSource.onmessage = (event) => {
                const data = JSON.parse(event.data);
                this.handleTripUpdate(data);
            };

            this.eventSource.onerror = () => {
                console.error("SSE connection error");
                if (this.eventSource) this.eventSource.close();
            };
        } catch (error) {
            console.error("Error setting up EventSource:", error);
        }
    }

    handleTripUpdate(data) {
        if (!data || !data.data || !data.data.transactionId) {
            console.warn("Invalid trip update data received:", data);
            return;
        }

        const tripId = data.data.transactionId;
        const coords = data.data.coordinates;

        switch (data.type) {
            case "trip_start":
                this.initializeTrip(tripId);
                break;

            case "trip_update":
                this.updateTripPath(tripId, coords);
                break;

            case "trip_end":
                this.completeTrip(tripId);
                break;

            default:
                console.warn(`Unhandled event type: ${data.type}`);
        }
    }

    initializeTrip(tripId) {
        if (this.activeTrips.has(tripId)) {
            console.warn(`Trip ${tripId} already exists.`);
            return;
        }

        const tripData = {
            polyline: L.polyline([], this.config.tripLine).addTo(this.layers.liveTrips),
            marker: null,
        };

        this.activeTrips.set(tripId, tripData);
        console.log(`Trip ${tripId} initialized.`);
    }

    updateTripPath(tripId, coords) {
        const trip = this.activeTrips.get(tripId);
        if (!trip) {
            console.warn(`Trip ${tripId} not found. Initializing.`);
            this.initializeTrip(tripId);
            return;
        }

        if (coords && coords.length) {
            const latlngs = coords.map((c) => [c.lat, c.lon]);
            trip.polyline.setLatLngs(latlngs);

            const lastPos = latlngs[latlngs.length - 1];
            if (!trip.marker) {
                trip.marker = L.marker(lastPos, {
                    icon: L.divIcon(this.config.vehicleIcon),
                }).addTo(this.layers.vehicles);
            } else {
                trip.marker.setLatLng(lastPos);
            }

            this.map.panTo(lastPos);
        }
    }

    completeTrip(tripId) {
        const trip = this.activeTrips.get(tripId);
        if (!trip) return;

        this.layers.liveTrips.removeLayer(trip.polyline);
        if (trip.marker) {
            this.layers.vehicles.removeLayer(trip.marker);
        }

        this.activeTrips.delete(tripId);
        console.log(`Trip ${tripId} completed and removed.`);
    }
}

// Initialize LiveTripTracker when the DOM is ready
document.addEventListener("DOMContentLoaded", () => {
    const map = window.EveryStreet?.getMap();
    if (map) {
        new LiveTripTracker(map);
    }
});