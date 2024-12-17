/* global L, io */

class LiveTripTracker {
  constructor(map) {
      if (!map || typeof map.addLayer !== 'function') {
          throw new Error('Invalid map object for LiveTripTracker');
      }

      this.map = map;
      this.activeTrips = new Map();
      this.liveTripsLayer = L.layerGroup().addTo(map);

      this.statusIndicator = document.querySelector('.status-indicator');
      this.activeTripsCount = document.querySelector('.active-trips-count');
      this.statusText = document.querySelector('.status-text');
      this.metricsContainer = document.querySelector('.live-trip-metrics');

      this.connectToSocket();
      this.updateStatus();
  }

  connectToSocket() {
      try {
          this.socket = io();
          this.socket.on('connect', () => this.updateConnectionStatus(true));
          this.socket.on('disconnect', () => this.updateConnectionStatus(false));
          this.socket.on('trip_tripStart', (data) => this.initializeTrip(data));
          this.socket.on('trip_tripData', (data) => this.updateTripPath(data));
          this.socket.on('trip_tripEnd', (data) => this.finalizeTrip(data));
          this.socket.on('trip_tripMetrics', (data) => this.updateTripMetrics(data));
      } catch (error) {
          console.error('Error connecting to WebSocket:', error);
          this.updateConnectionStatus(false);
      }
  }
  
    updateConnectionStatus(connected) {
      if (this.statusIndicator) {
        this.statusIndicator.classList.toggle('active', connected);
      }
      if (this.statusText) {
        this.statusText.textContent = connected
          ? 'Live Tracking Connected'
          : 'Live Tracking Disconnected';
      }
    }
  
    initializeTrip(tripData) {
      const tripId = tripData.transactionId;
      const trip = {
        polyline: L.polyline([], {
          color: '#FF5722',
          weight: 4,
          opacity: 0.8,
          className: 'active-trip',
        }).addTo(this.liveTripsLayer),
        coordinates: [],
        startTime: new Date(tripData.start.timestamp),
        vehicleMarker: null,
        dataPoints: [],
      };
      this.activeTrips.set(tripId, trip);
      this.updateStatus();
      console.log(`Initialized trip: ${tripId}`);
    }
  
    updateTripPath(tripData) {
      const tripId = tripData.transactionId;
      const trip = this.activeTrips.get(tripId);
      if (!trip) {
        console.warn(`Trip ${tripId} not found`);
        return;
      }
  
      tripData.data.forEach((point) => {
        if (point.gps?.lat && point.gps?.lon) {
          const coord = [point.gps.lat, point.gps.lon];
          trip.coordinates.push(coord);
          trip.dataPoints.push({
            timestamp: new Date(point.timestamp),
            speed: point.speed || 0,
            coordinate: coord,
          });
        }
      });
  
      trip.polyline.setLatLngs(trip.coordinates);
  
      if (trip.coordinates.length > 0) {
        const lastCoord = trip.coordinates[trip.coordinates.length - 1];
        this.updateVehicleMarker(tripId, lastCoord);
        this.map.panTo(lastCoord);
      }
    }
  
    updateVehicleMarker(tripId, position) {
      const trip = this.activeTrips.get(tripId);
      if (!trip) return;
  
      if (!trip.vehicleMarker) {
        const icon = L.divIcon({
          className: 'vehicle-marker',
          html: '<i class="fas fa-car"></i>',
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        });
        trip.vehicleMarker = L.marker(position, { icon }).addTo(this.liveTripsLayer);
      } else {
        trip.vehicleMarker.setLatLng(position);
      }
    }
  
    finalizeTrip(tripData) {
      const tripId = tripData.transactionId;
      const trip = this.activeTrips.get(tripId);
      if (!trip) {
        console.warn(`Trip ${tripId} not found for finalization`);
        return;
      }
  
      if (trip.coordinates.length > 0) {
        const endPoint = trip.coordinates[trip.coordinates.length - 1];
        L.marker(endPoint, {
          icon: L.divIcon({
            className: 'trip-marker trip-end',
            html: '<i class="fas fa-flag-checkered"></i>',
          }),
        }).addTo(this.liveTripsLayer);
      }
  
      if (trip.vehicleMarker) {
        this.liveTripsLayer.removeLayer(trip.vehicleMarker);
      }
  
      trip.polyline.setStyle({ color: '#4CAF50', opacity: 0.6, weight: 3 });
      this.activeTrips.delete(tripId);
      this.updateStatus();
    }
  
    updateTripMetrics(tripData) {
      if (!this.metricsContainer) return;
  
      const metrics = tripData.metrics;
      this.metricsContainer.innerHTML = `
        <div class="metrics-card">
          <h4>Current Trip Stats</h4>
          <p>Distance: ${metrics.tripDistance} miles</p>
          <p>Duration: ${this.formatDuration(metrics.tripTime)}</p>
          <p>Max Speed: ${metrics.maxSpeed} mph</p>
          <p>Avg Speed: ${metrics.averageDriveSpeed} mph</p>
          <p>Idle Time: ${metrics.totalIdlingTime}s</p>
        </div>
      `;
    }
  
    updateStatus() {
      const activeCount = this.activeTrips.size;
      if (this.activeTripsCount) {
        this.activeTripsCount.textContent = activeCount;
      }
      if (this.statusText) {
        this.statusText.textContent =
          activeCount > 0
            ? `Tracking ${activeCount} active trip${activeCount !== 1 ? 's' : ''}`
            : 'No active trips';
      }
    }
  
    formatDuration(seconds) {
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = Math.floor(seconds % 60);
      return `${minutes}m ${remainingSeconds}s`;
    }
  
    cleanup() {
      this.liveTripsLayer.clearLayers();
      this.activeTrips.clear();
      this.updateStatus();
  
      if (this.socket) {
        this.socket.disconnect();
      }
    }
  }
  
  // If you need to make the class globally accessible
  window.LiveTripTracker = LiveTripTracker;