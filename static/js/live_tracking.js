// Ensure LiveTripTracker is only defined once
if (typeof window.LiveTripTracker === 'undefined') {
    window.LiveTripTracker = class LiveTripTracker {
        constructor(map) {
            this.map = map;
            this.activeTrips = new Map(); // Store active trips using transactionId as key
            this.socket = io();
            this.setupSocketListeners();
            
            // Initialize UI elements
            this.statusIndicator = document.querySelector('.status-indicator');
            this.activeTripsCount = document.querySelector('.active-trips-count');
            this.statusText = document.querySelector('.status-text');
            
            // Create a layer group for live trips
            this.liveTripsLayer = L.layerGroup().addTo(map);
            
            this.updateStatus();
        }

        setupSocketListeners() {
            this.socket.on('connect', () => {
                console.log('Connected to WebSocket');
                this.updateConnectionStatus(true);
            });

            this.socket.on('disconnect', () => {
                console.log('Disconnected from WebSocket');
                this.updateConnectionStatus(false);
            });

            // Handle trip start event
            this.socket.on('trip_tripStart', (data) => {
                console.log('Trip started:', data);
                this.initializeTrip(data);
            });

            // Handle trip data updates
            this.socket.on('trip_tripData', (data) => {
                console.log('Trip data update:', data);
                this.updateTripPath(data);
            });

            // Handle trip end event
            this.socket.on('trip_tripEnd', (data) => {
                console.log('Trip ended:', data);
                this.finalizeTrip(data);
            });

            // Handle trip metrics
            this.socket.on('trip_tripMetrics', (data) => {
                console.log('Trip metrics received:', data);
                this.updateTripMetrics(data);
            });
        }

        updateConnectionStatus(connected) {
            if (this.statusIndicator) {
                this.statusIndicator.classList.toggle('active', connected);
            }
            if (this.statusText) {
                this.statusText.textContent = connected ? 'Live Tracking Connected' : 'Live Tracking Disconnected';
            }
        }

        initializeTrip(tripData) {
            const tripId = tripData.transactionId;
            
            // Create new trip object
            const tripObject = {
                polyline: L.polyline([], {
                    color: '#FF5722',
                    weight: 4,
                    opacity: 0.8,
                    className: 'active-trip'
                }).addTo(this.liveTripsLayer),
                coordinates: [],
                startTime: new Date(tripData.start.timestamp),
                vehicleMarker: null,
                dataPoints: []
            };

            this.activeTrips.set(tripId, tripObject);
            this.updateStatus();
            
            console.log(`Initialized new trip: ${tripId}`);
        }

        updateTripPath(tripData) {
            const tripId = tripData.transactionId;
            const trip = this.activeTrips.get(tripId);
            
            if (!trip) {
                console.warn(`No active trip found for ID: ${tripId}`);
                return;
            }

            // Process each GPS point in the data array
            if (Array.isArray(tripData.data)) {
                tripData.data.forEach(point => {
                    if (point.gps && point.gps.lat && point.gps.lon) {
                        const coord = [point.gps.lat, point.gps.lon];
                        trip.coordinates.push(coord);
                        trip.dataPoints.push({
                            timestamp: new Date(point.timestamp),
                            speed: point.speed || 0,
                            coordinate: coord
                        });
                    }
                });

                // Update polyline with all coordinates
                trip.polyline.setLatLngs(trip.coordinates);

                // Update or create vehicle marker at the latest position
                if (trip.coordinates.length > 0) {
                    const lastPos = trip.coordinates[trip.coordinates.length - 1];
                    this.updateVehicleMarker(tripId, lastPos);
                    
                    // Pan map to follow vehicle
                    this.map.panTo(lastPos);
                }
            }
        }

        updateVehicleMarker(tripId, position) {
            const trip = this.activeTrips.get(tripId);
            if (!trip) return;

            if (!trip.vehicleMarker) {
                trip.vehicleMarker = L.marker(position, {
                    icon: L.divIcon({
                        className: 'vehicle-marker',
                        html: '<i class="fas fa-car"></i>',
                        iconSize: [24, 24],
                        iconAnchor: [12, 12]
                    })
                }).addTo(this.liveTripsLayer);
            } else {
                trip.vehicleMarker.setLatLng(position);
            }
        }

        finalizeTrip(tripData) {
            const tripId = tripData.transactionId;
            const trip = this.activeTrips.get(tripId);
            
            if (!trip) {
                console.warn(`Cannot finalize trip ${tripId}: trip not found`);
                return;
            }

            // Add end marker if we have coordinates
            if (trip.coordinates.length > 0) {
                const endPoint = trip.coordinates[trip.coordinates.length - 1];
                L.marker(endPoint, {
                    icon: L.divIcon({
                        className: 'trip-marker trip-end',
                        html: '<i class="fas fa-flag-checkered"></i>'
                    })
                }).addTo(this.liveTripsLayer);
            }

            // Remove vehicle marker
            if (trip.vehicleMarker) {
                this.liveTripsLayer.removeLayer(trip.vehicleMarker);
            }

            // Change polyline style to indicate completed trip
            trip.polyline.setStyle({
                color: '#4CAF50',
                opacity: 0.6,
                weight: 3
            });

            // Remove from active trips
            this.activeTrips.delete(tripId);
            this.updateStatus();
        }

        updateTripMetrics(tripData) {
            const tripId = tripData.transactionId;
            const metrics = tripData.metrics;
            
            // Update UI with metrics if needed
            const metricsContainer = document.querySelector('.live-trip-metrics');
            if (metricsContainer) {
                metricsContainer.innerHTML = `
                    <div class="metrics-card">
                        <h4>Current Trip Stats</h4>
                        <p>Distance: ${metrics.tripDistance} miles</p>
                        <p>Duration: ${Math.floor(metrics.tripTime / 60)}m ${metrics.tripTime % 60}s</p>
                        <p>Max Speed: ${metrics.maxSpeed} mph</p>
                        <p>Avg Speed: ${metrics.averageDriveSpeed} mph</p>
                        <p>Idle Time: ${metrics.totalIdlingTime}s</p>
                    </div>
                `;
            }
        }

        updateStatus() {
            const activeCount = this.activeTrips.size;
            
            if (this.activeTripsCount) {
                this.activeTripsCount.textContent = activeCount;
            }
            
            if (this.statusText) {
                this.statusText.textContent = activeCount > 0 
                    ? `Tracking ${activeCount} active trip${activeCount !== 1 ? 's' : ''}`
                    : 'No active trips';
            }
        }
        clearCompletedTrips() {
            // Clear trips that have been inactive for more than 30 minutes
            const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
            
            this.activeTrips.forEach((trip, tripId) => {
                const lastUpdate = trip.dataPoints.length > 0 
                    ? trip.dataPoints[trip.dataPoints.length - 1].timestamp 
                    : trip.startTime;
                    
                if (lastUpdate < thirtyMinutesAgo) {
                    this.finalizeTrip({ transactionId: tripId });
                }
            });
        }

        formatSpeed(speedMph) {
            return `${Math.round(speedMph)} mph`;
        }

        formatDuration(seconds) {
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = seconds % 60;
            return `${minutes}m ${remainingSeconds}s`;
        }

        createTripPopup(trip) {
            const lastPoint = trip.dataPoints[trip.dataPoints.length - 1];
            const duration = Math.floor((Date.now() - trip.startTime) / 1000);
            
            return `
                <div class="trip-popup">
                    <h4>Active Trip</h4>
                    <p>Duration: ${this.formatDuration(duration)}</p>
                    <p>Current Speed: ${this.formatSpeed(lastPoint?.speed || 0)}</p>
                    <p>Started: ${trip.startTime.toLocaleTimeString()}</p>
                </div>
            `;
        }

        cleanup() {
            // Remove all layers and markers
            this.liveTripsLayer.clearLayers();
            this.activeTrips.clear();
            this.updateStatus();
        }
    }
}

// Add CSS styles only if they haven't been added yet
if (!document.getElementById('live-tracking-styles')) {
    const style = document.createElement('style');
    style.id = 'live-tracking-styles';
    style.textContent = `
        .vehicle-marker {
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .vehicle-marker i {
            font-size: 24px;
            color: #FF5722;
            text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.3);
            animation: pulse 1.5s infinite;
        }

        .trip-marker {
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .trip-marker.trip-end i {
            font-size: 20px;
            color: #4CAF50;
            text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.3);
        }

        .active-trip {
            animation: tripPulse 2s infinite;
        }

        .trip-popup {
            padding: 10px;
            min-width: 200px;
        }

        .trip-popup h4 {
            margin: 0 0 10px 0;
            color: #FF5722;
        }

        .trip-popup p {
            margin: 5px 0;
            font-size: 14px;
        }

        .metrics-card {
            background: rgba(0, 0, 0, 0.8);
            border-radius: 8px;
            padding: 15px;
            margin: 10px;
            color: white;
        }

        @keyframes pulse {
            0% { transform: scale(1); }
            50% { transform: scale(1.2); }
            100% { transform: scale(1); }
        }

        @keyframes tripPulse {
            0% { opacity: 0.8; }
            50% { opacity: 0.4; }
            100% { opacity: 0.8; }
        }
    `;
    document.head.appendChild(style);
}

