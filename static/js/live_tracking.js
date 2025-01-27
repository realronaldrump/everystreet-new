/**
 * LiveTripTracker - Handles real-time trip visualization and updates
 */
class LiveTripTracker {
  /**
   * @param {L.Map} map - Leaflet map instance
   */
  constructor(map) {
      if (!map) throw new Error('Map instance required');

      // Core properties
      this.map = map;
      this.activeTrips = new Map();
      this.eventSource = null;
      this.reconnectAttempts = 0;
      this.maxReconnectAttempts = 5;
      this.reconnectDelay = 1000; // Start with 1 second

      // Configuration
      this.config = {
          tripLine: {
              color: '#00f7ff',
              weight: 4,
              opacity: 0.8,
              className: 'active-trip'
          },
          vehicleIcon: {
              className: 'vehicle-marker',
              html: '<i class="fas fa-car"></i>',
              iconSize: [24, 24],
              iconAnchor: [12, 12]
          },
          archiveDelay: 10 * 60 * 1000, // 10 minutes
          updateInterval: 1000 // 1 second
      };

      // UI Elements
      this.ui = {
          statusIndicator: document.querySelector('.status-indicator'),
          statusText: document.querySelector('.status-text'),
          activeTripsCount: document.querySelector('#active-trips-count'),
          liveMetrics: document.querySelector('.live-trip-metrics')
      };

      // Map Layers
      this.layers = {
          liveTrips: L.layerGroup().addTo(map),
          vehicles: L.layerGroup().addTo(map)
      };

      // Initialize
      this.initialize();
  }

  /**
   * Initialize the tracker
   */
  initialize() {
      this.setupEventSource();
      this.setupPeriodicCleanup();
      this.updateUI();
  }

  /**
   * Set up SSE connection and event handlers
   */
  setupEventSource() {
      try {
          this.eventSource = new EventSource('/stream');

          // Event handlers
          this.eventSource.onopen = () => {
              console.log('SSE connection established');
              this.reconnectAttempts = 0;
              this.reconnectDelay = 1000;
              this.updateConnectionStatus(true);
          };

          this.eventSource.onmessage = (event) => {
              try {
                  const data = JSON.parse(event.data);
                  this.handleTripUpdate(data);
              } catch (error) {
                  console.error('Error processing trip update:', error);
              }
          };

          this.eventSource.onerror = (error) => {
              console.error('SSE connection error:', error);
              this.handleConnectionError();
          };

      } catch (error) {
          console.error('Error setting up EventSource:', error);
          this.handleConnectionError();
      }
  }

  /**
   * Handle SSE connection errors and implement reconnection logic
   */
  handleConnectionError() {
      this.updateConnectionStatus(false);

      if (this.eventSource) {
          this.eventSource.close();
          this.eventSource = null;
      }

      if (this.reconnectAttempts < this.maxReconnectAttempts) {
          setTimeout(() => {
              console.log(`Attempting to reconnect (${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})...`);
              this.setupEventSource();
              this.reconnectAttempts++;
              this.reconnectDelay *= 2; // Exponential backoff
          }, this.reconnectDelay);
      } else {
          console.error('Max reconnection attempts reached');
          this.updateUI('Connection failed. Please refresh the page.');
      }
  }

  /**
   * Handle incoming trip updates
   * @param {Object} data - Trip update data
   */
  handleTripUpdate(data) {
      if (!data || !data.data || !data.data.transactionId) {
          console.warn('Invalid trip update data received');
          return;
      }

      const tripId = data.data.transactionId;
      const coords = data.data.coordinates;

      try {
          switch (data.type) {
              case 'trip_start':
                  this.initializeTrip(tripId);
                  break;

              case 'trip_update':
                  this.updateTripPath(tripId, coords);
                  break;

              case 'trip_end':
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
   * Initialize a new trip
   * @param {string} tripId - Trip identifier
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
              maxSpeed: 0
          }
      };

      this.activeTrips.set(tripId, tripData);
      this.updateUI();
  }

  /**
   * Update trip path with new coordinates
   * @param {string} tripId - Trip identifier
   * @param {Array} coords - Array of coordinate objects
   */
  updateTripPath(tripId, coords) {
      const trip = this.activeTrips.get(tripId);
      if (!trip) return;

      // Convert coordinates to LatLng array
      const latlngs = coords.map(c => [c.lat, c.lon]);
      
      // Update polyline
      trip.polyline.setLatLngs(latlngs);

      // Update vehicle marker
      if (latlngs.length > 0) {
          const lastPos = latlngs[latlngs.length - 1];
          if (!trip.marker) {
              trip.marker = L.marker(lastPos, {
                  icon: L.divIcon(this.config.vehicleIcon)
              }).addTo(this.layers.vehicles);
          } else {
              trip.marker.setLatLng(lastPos);
          }

          // Update map view if needed
          if (this.shouldUpdateMapView(lastPos)) {
              this.map.panTo(lastPos);
          }
      }

      // Update metrics
      this.updateTripMetrics(trip, coords);
      trip.lastUpdate = new Date();
  }

  /**
   * Handle trip end event
   * @param {string} tripId - Trip identifier
   */
  handleTripEnd(tripId) {
      const trip = this.activeTrips.get(tripId);
      if (!trip) return;

      // Add end marker
      const lastPos = trip.polyline.getLatLngs().slice(-1)[0];
      if (lastPos) {
          L.marker(lastPos, {
              icon: L.divIcon({
                  className: 'trip-end-marker',
                  html: '<i class="fas fa-flag-checkered"></i>'
              })
          }).addTo(this.layers.liveTrips);
      }

      // Schedule cleanup
      setTimeout(() => {
          this.archiveTrip(tripId);
      }, this.config.archiveDelay);
  }

  /**
   * Archive a completed trip
   * @param {string} tripId - Trip identifier
   */
  archiveTrip(tripId) {
      const trip = this.activeTrips.get(tripId);
      if (!trip) return;

      // Remove from map
      this.layers.liveTrips.removeLayer(trip.polyline);
      if (trip.marker) {
          this.layers.vehicles.removeLayer(trip.marker);
      }

      // Remove from active trips
      this.activeTrips.delete(tripId);
      this.updateUI();
  }

  /**
   * Update trip metrics
   * @param {Object} trip - Trip object
   * @param {Array} coords - Array of coordinate objects
   */
  updateTripMetrics(trip, coords) {
      if (!coords || coords.length < 2) return;

      // Calculate distance
      let distance = 0;
      let maxSpeed = trip.metrics.maxSpeed;

      for (let i = 1; i < coords.length; i++) {
          const prev = coords[i - 1];
          const curr = coords[i];
          distance += this.calculateDistance(
              [prev.lat, prev.lon],
              [curr.lat, curr.lon]
          );
          maxSpeed = Math.max(maxSpeed, curr.speed || 0);
      }

      trip.metrics = {
          distance: distance,
          maxSpeed: maxSpeed,
          averageSpeed: distance / ((new Date() - trip.startTime) / 3600000) // mph
      };
  }

  /**
   * Calculate distance between two points
   * @param {Array} point1 - [lat, lon]
   * @param {Array} point2 - [lat, lon]
   * @returns {number} Distance in miles
   */
  calculateDistance(point1, point2) {
      const R = 3959; // Earth's radius in miles
      const lat1 = this.toRad(point1[0]);
      const lat2 = this.toRad(point2[0]);
      const dLat = this.toRad(point2[0] - point1[0]);
      const dLon = this.toRad(point2[1] - point1[1]);

      const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1) * Math.cos(lat2) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
      
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      return R * c;
  }

  /**
   * Convert degrees to radians
   * @param {number} degrees
   * @returns {number} Radians
   */
  toRad(degrees) {
      return degrees * Math.PI / 180;
  }

  /**
   * Determine if map view should be updated
   * @param {Array} position - [lat, lon]
   * @returns {boolean}
   */
  shouldUpdateMapView(position) {
      const bounds = this.map.getBounds();
      return !bounds.contains(position);
  }

  /**
   * Update UI elements
   * @param {string} [statusMessage] - Optional status message
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

      // Update metrics display
      if (this.ui.liveMetrics) {
          let metricsHTML = '';
          for (const [tripId, trip] of this.activeTrips) {
              metricsHTML += `
                  <div class="trip-metrics">
                      <div>Trip: ${tripId.slice(-6)}</div>
                      <div>Distance: ${trip.metrics.distance.toFixed(2)} mi</div>
                      <div>Speed: ${trip.metrics.averageSpeed.toFixed(1)} mph</div>
                      <div>Max Speed: ${trip.metrics.maxSpeed.toFixed(1)} mph</div>
                  </div>
              `;
          }
          this.ui.liveMetrics.innerHTML = metricsHTML;
      }
  }

  /**
   * Update connection status indicator
   * @param {boolean} connected - Connection status
   */
  updateConnectionStatus(connected) {
      if (this.ui.statusIndicator) {
          this.ui.statusIndicator.classList.toggle('active', connected);
      }
      if (this.ui.statusText) {
          this.ui.statusText.textContent = connected ? 
              'Live Tracking Connected' : 
              'Live Tracking Disconnected';
      }
  }

  /**
   * Set up periodic cleanup of stale trips
   */
  setupPeriodicCleanup() {
      setInterval(() => {
          const now = new Date();
          for (const [tripId, trip] of this.activeTrips) {
              // Remove trips that haven't been updated in 5 minutes
              if (now - trip.lastUpdate > 5 * 60 * 1000) {
                  console.log(`Removing stale trip: ${tripId}`);
                  this.archiveTrip(tripId);
              }
          }
      }, 60 * 1000); // Check every minute
  }

  /**
   * Clean up resources
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

// Initialize when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const checkMapInterval = setInterval(() => {
      if (window.EveryStreet && window.EveryStreet.getMap()) {
          clearInterval(checkMapInterval);
          try {
              window.liveTracker = new LiveTripTracker(window.EveryStreet.getMap());
          } catch (error) {
              console.error('Error initializing LiveTripTracker:', error);
          }
      }
  }, 100);

  // Prevent memory leaks
  setTimeout(() => clearInterval(checkMapInterval), 10000);
});
