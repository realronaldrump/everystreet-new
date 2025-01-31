class LiveTripTracker {
    constructor(map) {
        this.map = map;
        this.currentTrip = null;
        this.eventSource = null;
        this.polyline = null;
        this.marker = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.lastCoordinateIndex = 0; // Initialize the index

        // Status elements
        this.statusIndicator = document.querySelector('.status-indicator');
        this.statusText = document.querySelector('.status-text');
        this.activeTripsCount = document.querySelector('#active-trips-count');
        this.tripMetrics = document.querySelector('.live-trip-metrics');

        this.config = {
            polyline: {
                color: '#00FF00',
                weight: 3,
                opacity: 0.8
            },
            marker: {
                icon: L.divIcon({
                    className: 'vehicle-marker',
                    iconSize: [12, 12],
                    iconAnchor: [6, 6]
                })
            }
        };

        this.initialize();
    }

    initialize() {
        this.polyline = L.polyline([], this.config.polyline).addTo(this.map);
        this.marker = L.marker([0, 0], {
            icon: this.config.marker.icon
        }).addTo(this.map);

        this.marker.setOpacity(0);
        this.lastCoordinateIndex = 0; // Reset the index
        this.loadInitialTripData();
        this.connectEventSource();
    }

    async loadInitialTripData() {
        try {
            const response = await fetch('/api/active_trip');
            if (!response.ok) {
                console.error('Failed to fetch initial trip data:', response.statusText);
                return;
            }
            const data = await response.json();
            if (data && data.transactionId && data.coordinates) {
                this.handleTripUpdate(data);
            } else {
                console.log('No active trip data found on server.');
            }
        } catch (error) {
            console.error('Error fetching initial trip data:', error);
        }
    }

    updateStatus(connected) {
        if (this.statusIndicator && this.statusText) {
            this.statusIndicator.classList.toggle('connected', connected);
            this.statusText.textContent = connected ? 'Connected' : 'Disconnected';
        }
    }

    updateActiveTripsCount(count) {
        if (this.activeTripsCount) {
            this.activeTripsCount.textContent = count;
        }
    }

    connectEventSource() {
        if (this.eventSource) {
            this.eventSource.close();
        }

        this.eventSource = new EventSource('/stream');

        this.eventSource.onopen = () => {
            console.log('SSE Connection established');
            this.updateStatus(true);
            this.reconnectAttempts = 0;
        };

        this.eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleUpdate(data);
            } catch (error) {
                console.error('Error processing event:', error);
            }
        };

        this.eventSource.onerror = (error) => {
            console.error('EventSource error:', error);
            this.updateStatus(false);
            this.eventSource.close();

            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
                console.log(`Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
                setTimeout(() => this.connectEventSource(), 5000);
            } else {
                console.error('Max reconnection attempts reached');
            }
        };
    }

    handleUpdate(data) {
        if (!data || !data.type) return;

        switch (data.type) {
            case 'connected':
                console.log('Connected to live tracking');
                this.updateStatus(true);
                break;

            case 'heartbeat':
                // Ignore heartbeat
                break;

            case 'trip_update':
                this.handleTripUpdate(data.data);
                break;

            case 'error':
                console.error('Server error:', data.message);
                break;
        }
    }

    handleTripUpdate(tripData) {
        /*
          Called when the server sends a "trip_update" SSE event with:
            {
              "transactionId": "...",
              "coordinates": [
                 { "lat": 31.1234, "lon": -97.1234, "timestamp": "2025-01-30T13:51:20Z" },
                 ...
              ]
            }
    
          We store them in memory, deduplicate if needed,
          then sort by timestamp before drawing.
        */
        if (!tripData || !tripData.coordinates || !tripData.coordinates.length) return;
    
        this.currentTrip = tripData.transactionId;
    
        // Attempt to preserve existing local coords
        if (!this.localCoords) {
            // localCoords is a client-side array we keep
            this.localCoords = [];
        }
    
        // Turn existing local coords into a map or set for dedup
        const existingSet = new Set(
            this.localCoords.map(c =>
                `${c.timestamp}-${c.lat.toFixed(6)}-${c.lon.toFixed(6)}`
            )
        );
    
        const newPoints = [];
        for (const c of tripData.coordinates) {
            if (!c.timestamp || c.lat == null || c.lon == null) continue;
            const key = `${c.timestamp}-${c.lat.toFixed(6)}-${c.lon.toFixed(6)}`;
            if (!existingSet.has(key)) {
                existingSet.add(key);
                newPoints.push(c);
            }
        }
    
        if (newPoints.length) {
            // Combine
            this.localCoords = this.localCoords.concat(newPoints);
            // Sort by timestamp
            this.localCoords.sort((a, b) => {
                return new Date(a.timestamp) - new Date(b.timestamp);
            });
        }
    
        // Now that we have a strictly time-ordered list,
        // re-draw the polyline with localCoords
        const latLngs = this.localCoords.map(coord => [coord.lat, coord.lon]);
        this.polyline.setLatLngs(latLngs);
    
        // Move marker to the last coordinate
        const lastPos = latLngs[latLngs.length - 1];
        this.marker.setLatLng(lastPos);
        this.marker.setOpacity(1);
    
        // Optionally auto-pan
        // this.map.panTo(lastPos, { animate: true, duration: 1 });
    }
}