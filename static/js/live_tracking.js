class LiveTripTracker {
    constructor(map) {
        this.map = map;
        this.activeTrips = new Map();
        this.socket = io();
        this.setupSocketListeners();
        this.statusIndicator = document.querySelector('.status-indicator');
        this.activeTripsCount = document.querySelector('.active-trips-count');
        this.statusText = document.querySelector('.status-text');
        this.updateStatus();
    }

    setupSocketListeners() {
        this.socket.on('connect', () => {
            console.log('Connected to WebSocket');
            this.statusIndicator.classList.add('active');
            this.statusText.textContent = 'Live Tracking Connected';
        });

        this.socket.on('disconnect', () => {
            console.log('Disconnected from WebSocket');
            this.statusIndicator.classList.remove('active');
            this.statusText.textContent = 'Live Tracking Disconnected';
        });

        this.socket.on('trip_start', (data) => {
            console.log('Trip started:', data);
            this.initializeTrip(data);
        });

        this.socket.on('trip_data', (data) => {
            console.log('Trip update:', data);
            this.updateTrip(data);
        });

        this.socket.on('trip_end', (data) => {
            console.log('Trip ended:', data);
            this.finalizeTrip(data);
        });

        this.socket.on('trip_metrics', (data) => {
            console.log('Trip metrics:', data);
            this.displayTripMetrics(data);
        });

        this.socket.on('error', (error) => {
            console.error('Socket error:', error);
            this.statusIndicator.classList.remove('active');
            this.statusText.textContent = 'Live Tracking Error';
        });

        this.socket.on('reconnect', (attemptNumber) => {
            console.log('Reconnected after', attemptNumber, 'attempts');
            this.statusIndicator.classList.add('active');
            this.statusText.textContent = 'Live Tracking Connected';
        });
    }

    initializeTrip(tripData) {
        const tripId = tripData.transactionId;  // Use transactionId consistently
        const polyline = L.polyline([], {
            color: '#FF5722',
            weight: 4,
            opacity: 0.8
        }).addTo(this.map);

        // Add trip to activeTrips map even if GPS coordinates are not present yet
        this.activeTrips.set(tripId, {
            polyline: polyline,
            coordinates: []
        });

        // Conditionally add start marker if GPS coordinates are present
        if (tripData.gps && tripData.gps.coordinates) {
            const startPoint = tripData.gps.coordinates[0];
            L.marker([startPoint[1], startPoint[0]], {
                icon: L.divIcon({
                    className: 'trip-marker trip-start',
                    html: '<i class="fas fa-play"></i>'
                })
            }).addTo(this.map);
        }
        this.updateStatus();
    }

    updateTrip(tripData) {
        const tripId = tripData.transactionId;
        const activeTripData = this.activeTrips.get(tripId);
        
        if (!activeTripData || !tripData.gps || !tripData.gps.coordinates) return;

        const newCoords = tripData.gps.coordinates.map(coord => [coord[1], coord[0]]);
        activeTripData.coordinates.push(...newCoords);  // Append to coordinates
        activeTripData.polyline.setLatLngs(activeTripData.coordinates);

        // Update vehicle position marker
        const lastPoint = activeTripData.coordinates[activeTripData.coordinates.length - 1];
        this.updateVehicleMarker(tripId, lastPoint);

        // Pan map to follow vehicle
        this.map.panTo(lastPoint);
    }

    updateVehicleMarker(tripId, position) {
        const activeTripData = this.activeTrips.get(tripId);
        
        if (!activeTripData.vehicleMarker) {
            activeTripData.vehicleMarker = L.marker(position, {
                icon: L.divIcon({
                    className: 'vehicle-marker',
                    html: '<i class="fas fa-car"></i>'
                })
            }).addTo(this.map);
        } else {
            activeTripData.vehicleMarker.setLatLng(position);
        }
    }

    finalizeTrip(tripData) {
        const tripId = tripData.transactionId;
        const activeTripData = this.activeTrips.get(tripId);
        
        if (!activeTripData) return;

        // Check if coordinates are available and add end marker accordingly
        if (tripData.gps && tripData.gps.coordinates) {
            const endPoint = tripData.gps.coordinates[tripData.gps.coordinates.length - 1];
            L.marker([endPoint[1], endPoint[0]], {
                icon: L.divIcon({
                    className: 'trip-marker trip-end',
                    html: '<i class="fas fa-stop"></i>'
                })
            }).addTo(this.map);
        }

        // Remove vehicle marker
        if (activeTripData.vehicleMarker) {
            this.map.removeLayer(activeTripData.vehicleMarker);
        }
        
        this.activeTrips.delete(tripId);
        if (window.fetchTrips) {
            window.fetchTrips();
        }
        this.updateStatus();
    }

    displayTripMetrics(tripData) {
        const tripId = tripData.transactionId;
        const metrics = tripData.metrics;

        // Display metrics in console or update the UI as needed
        console.log(`Trip metrics for ${tripId}:`, metrics);

        // Example code to update metrics display on the webpage if needed
        const metricsContainer = document.querySelector('.trip-metrics');
        if (metricsContainer) {
            metricsContainer.innerHTML = `
                <p>Trip Time: ${metrics.tripTime} seconds</p>
                <p>Distance: ${metrics.tripDistance} km</p>
                <p>Total Idling Time: ${metrics.totalIdlingTime} seconds</p>
                <p>Max Speed: ${metrics.maxSpeed} km/h</p>
                <p>Average Speed: ${metrics.averageDriveSpeed} km/h</p>
                <p>Hard Braking Events: ${metrics.hardBrakingCounts}</p>
                <p>Hard Acceleration Events: ${metrics.hardAccelerationCounts}</p>
            `;
        }
    }

    updateStatus() {
        if (this.activeTripsCount) {
            this.activeTripsCount.textContent = this.activeTrips.size;
        }
        
        if (this.statusText) {
            if (this.activeTrips.size > 0) {
                this.statusText.textContent = `Tracking ${this.activeTrips.size} active trip${this.activeTrips.size > 1 ? 's' : ''}`;
            } else {
                this.statusText.textContent = 'No active trips';
            }
        }
    }
}