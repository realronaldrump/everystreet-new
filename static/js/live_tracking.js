class LiveTripTracker {
    constructor(map) {
        this.map = map;
        this.currentTrip = null;
        this.eventSource = null;
        this.polyline = null;
        this.marker = null;

        // Configuration
        this.config = {
            polyline: {
                color: '#00FF00',
                weight: 3,
                opacity: 0.8
            },
            marker: {
                icon: L.divIcon({
                    className: 'vehicle-marker',
                    html: '<i class="fas fa-car"></i>',
                    iconSize: [24, 24],
                    iconAnchor: [12, 12]
                })
            }
        };

        this.initialize();
    }

    initialize() {
        // Create layers
        this.polyline = L.polyline([], this.config.polyline).addTo(this.map);
        this.marker = L.marker([0, 0], {
            icon: this.config.marker.icon
        }).addTo(this.map);
        
        // Hide initially
        this.marker.setOpacity(0);
        
        // Start listening for updates
        this.connectEventSource();
    }

    connectEventSource() {
        if (this.eventSource) {
            this.eventSource.close();
        }

        this.eventSource = new EventSource('/stream');

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
            setTimeout(() => this.connectEventSource(), 5000); // Reconnect after 5s
        };
    }

    handleUpdate(data) {
        if (!data || !data.type) return;

        switch (data.type) {
            case 'trip_start':
                this.handleTripStart(data.data);
                break;

            case 'trip_update':
                this.handleTripUpdate(data.data);
                break;

            case 'trip_end':
                this.handleTripEnd(data.data);
                break;
        }
    }

    handleTripStart(tripData) {
        this.currentTrip = tripData.transactionId;
        this.polyline.setLatLngs([]);
        this.marker.setOpacity(1);
    }

    handleTripUpdate(tripData) {
        if (!this.currentTrip || tripData.transactionId !== this.currentTrip) return;

        const coordinates = tripData.coordinates.map(coord => [coord.lat, coord.lon]);
        
        // Update polyline
        this.polyline.setLatLngs(coordinates);
        
        // Update vehicle marker
        if (coordinates.length > 0) {
            const lastPos = coordinates[coordinates.length - 1];
            this.marker.setLatLng(lastPos);
            
            // Auto-follow vehicle
            this.map.panTo(lastPos);
        }
    }

    handleTripEnd(tripData) {
        if (!this.currentTrip || tripData.transactionId !== this.currentTrip) return;
        
        // Keep displaying for 5 minutes then clear
        setTimeout(() => {
            if (this.currentTrip === tripData.transactionId) {
                this.polyline.setLatLngs([]);
                this.marker.setOpacity(0);
                this.currentTrip = null;
            }
        }, 5 * 60 * 1000);
    }
}

// Initialize when the map is ready
document.addEventListener('DOMContentLoaded', () => {
    const map = window.EveryStreet?.getMap();
    if (map) {
        window.liveTracker = new LiveTripTracker(map);
    }
});
