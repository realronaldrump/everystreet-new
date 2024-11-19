/* global L, io */

// Ensure LiveTripTracker is only defined once
window.LiveTripTracker = (function() {
	'use strict';

	const TRIP_INACTIVE_TIMEOUT = 30 * 60 * 1000; // 30 minutes

	class LiveTripTracker {
		constructor(map) {
			if (!map || typeof map.addLayer !== 'function') {
				throw new Error('Invalid map object provided to LiveTripTracker');
			}

			this.map = map;
			this.activeTrips = new Map();
			this.liveTripsLayer = L.layerGroup().addTo(map); // Directly add layer to map
			this.statusIndicator = document.querySelector('.status-indicator');
			this.activeTripsCount = document.querySelector('.active-trips-count');
			this.statusText = document.querySelector('.status-text');


			this.initializeSocket();
			this.updateStatus();


			// Periodically clear completed trips
			setInterval(() => this.clearCompletedTrips(), TRIP_INACTIVE_TIMEOUT);
		}

		initializeSocket() {
			if (this.socket) {
				console.warn('Socket already initialized');
				return;
			}
			try {
				this.socket = io();
				this.socket.on('connect', () => this.updateConnectionStatus(true));
				this.socket.on('disconnect', () => this.updateConnectionStatus(false));
				this.socket.on('trip_tripStart', (data) => this.initializeTrip(data));
				this.socket.on('trip_tripData', (data) => this.updateTripPath(data));
				this.socket.on('trip_tripEnd', (data) => this.finalizeTrip(data));
				this.socket.on('trip_tripMetrics', (data) => this.updateTripMetrics(data));
			} catch (error) {
				console.error('Error initializing Socket.IO:', error);
			}
		}

		updateConnectionStatus(connected) {
			this.statusIndicator?.classList.toggle('active', connected);
			this.statusText.textContent = connected ? 'Live Tracking Connected' : 'Live Tracking Disconnected';
		}

		initializeTrip(tripData) {
			const tripId = tripData.transactionId;
			const trip = {
				polyline: L.polyline([], {
					color: '#FF5722',
					weight: 4,
					opacity: 0.8,
					className: 'active-trip'
				}).addTo(this.liveTripsLayer),
				coordinates: [],
				startTime: new Date(tripData.start.timestamp),
				vehicleMarker: null,
				dataPoints: [],
				lastUpdate: new Date() // Add lastUpdate to track activity
			};

			this.activeTrips.set(tripId, trip);
			this.updateStatus();
			console.log(`Initialized trip: ${tripId}`);
		}

		updateTripPath(tripData) {
			const tripId = tripData.transactionId;
			const trip = this.activeTrips.get(tripId);
			if (!trip) {
				console.warn(`Trip not found: ${tripId}`);
				return;
			}

			tripData.data.forEach(point => {
				if (point.gps?.lat && point.gps?.lon) { // Optional chaining
					const coord = [point.gps.lat, point.gps.lon];
					trip.coordinates.push(coord);
					trip.dataPoints.push({
						timestamp: new Date(point.timestamp),
						speed: point.speed || 0,
						coordinate: coord
					});
				}
			});

			trip.polyline.setLatLngs(trip.coordinates);
			trip.lastUpdate = new Date(); //Update last known time of activity

			if (trip.coordinates.length > 0) {
				this.updateVehicleMarker(tripId, trip.coordinates.at(-1)); // Array.at(-1) for last element
				this.map.panTo(trip.coordinates.at(-1));
			}
		}

		updateVehicleMarker(tripId, position) {
			const trip = this.activeTrips.get(tripId);

			if (trip) {
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
		}

		finalizeTrip(tripData) {
			const tripId = tripData.transactionId;
			const trip = this.activeTrips.get(tripId);

			if (!trip) {
				console.warn(`Cannot finalize trip ${tripId}: trip not found`);
				return;
			}

			if (trip.coordinates.length > 0) {
				L.marker(trip.coordinates.at(-1), { // Use .at(-1)
					icon: L.divIcon({
						className: 'trip-marker trip-end',
						html: '<i class="fas fa-flag-checkered"></i>'
					})
				}).addTo(this.liveTripsLayer);
			}

			trip.polyline.setStyle({
				color: '#4CAF50',
				opacity: 0.6,
				weight: 3
			});

			this.liveTripsLayer.removeLayer(trip.vehicleMarker); // Remove marker from layer
			this.activeTrips.delete(tripId);
			this.updateStatus();
		}

		updateTripMetrics(tripData) {
			const metrics = tripData.metrics;
			const metricsContainer = document.querySelector('.live-trip-metrics');

			if (metricsContainer && metrics) { // Check if metrics exist
				metricsContainer.innerHTML = `
                    <div class="metrics-card">
                        <h4>Current Trip Stats</h4>
                        <p>Distance: ${metrics.tripDistance} miles</p>
                        <p>Duration: ${this.formatDuration(metrics.tripTime)}</p>
                        <p>Max Speed: ${metrics.maxSpeed} mph</p>
                        <p>Avg Speed: ${metrics.averageDriveSpeed} mph</p>
                        <p>Idle Time: ${this.formatDuration(metrics.totalIdlingTime)}</p> </div>
                `;
			}
		}

		updateStatus() {
			const activeCount = this.activeTrips.size;
			this.activeTripsCount.textContent = activeCount;
			this.statusText.textContent = activeCount > 0 ? `Tracking ${activeCount} active trip${activeCount !== 1 ? 's' : ''}` : 'No active trips';
		}

		clearCompletedTrips() {
			const now = Date.now();
			for (const [tripId, trip] of this.activeTrips) {
				if (now - trip.lastUpdate > TRIP_INACTIVE_TIMEOUT) {
					this.finalizeTrip({
						transactionId: tripId
					});
				}
			}
		}


		formatDuration(seconds) {
			const minutes = Math.floor(seconds / 60);
			const remainingSeconds = seconds % 60;
			return `${minutes}m ${remainingSeconds.toFixed(0)}s`; // Pad seconds
		}

		formatSpeed(speedMph) {
			return `${Math.round(speedMph)} mph`;
		}

		cleanup() {
			this.liveTripsLayer.clearLayers();
			this.activeTrips.clear();
			this.socket?.disconnect(); // Disconnect the socket
			this.socket = null; // Release the socket object
			this.updateStatus();
		}
	}


	return LiveTripTracker;
})();