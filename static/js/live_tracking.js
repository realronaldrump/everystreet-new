class LiveTripTracker {
    constructor(map) {
        this.map = map;
        this.currentTrip = null;
        this.eventSource = null;
        this.polyline = null;
        this.marker = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;

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
        this.connectEventSource();
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
        if (!tripData || !tripData.coordinates || !tripData.coordinates.length) return;

        this.currentTrip = tripData.transactionId;
        const coordinates = tripData.coordinates.map(coord => [coord.lat, coord.lon]);
        
        this.updateActiveTripsCount(1);  // We know we have an active trip
        this.polyline.setLatLngs(coordinates);
        this.marker.setOpacity(1);
        
        const lastPos = coordinates[coordinates.length - 1];
        this.marker.setLatLng(lastPos);
        
        // Only pan to vehicle if we're actively tracking
        if (this.map.getBounds().contains(lastPos)) {
            this.map.panTo(lastPos);
        }
    }
}
