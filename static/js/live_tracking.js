class LiveTripTracker {
    constructor(map) {
        this.map = map;
        this.activeTrips = new Map();
        this.socket = io();
        this.setupSocketListeners();
    }

    setupSocketListeners() {
        this.socket.on('trip_start', (data) => {
            console.log('Trip started:', data);
            this.initializeTrip(data);
        });

        this.socket.on('trip_update', (data) => {
            console.log('Trip update:', data);
            this.updateTrip(data);
        });

        this.socket.on('trip_end', (data) => {
            console.log('Trip ended:', data);
            this.finalizeTrip(data);
        });
    }

    initializeTrip(tripData) {
        const tripId = tripData.tripId;
        const polyline = L.polyline([], {
            color: '#FF5722',
            weight: 4,
            opacity: 0.8
        }).addTo(this.map);

        this.activeTrips.set(tripId, {
            polyline: polyline,
            coordinates: []
        });

        // Add start marker
        const startPoint = tripData.gps.coordinates[0];
        L.marker([startPoint[1], startPoint[0]], {
            icon: L.divIcon({
                className: 'trip-marker trip-start',
                html: '<i class="fas fa-play"></i>'
            })
        }).addTo(this.map);
    }

    updateTrip(tripData) {
        const tripId = tripData.tripId;
        const activeTripData = this.activeTrips.get(tripId);
        
        if (!activeTripData) return;

        const newCoords = tripData.gps.coordinates.map(coord => [coord[1], coord[0]]);
        activeTripData.coordinates = newCoords;
        activeTripData.polyline.setLatLngs(newCoords);

        // Update vehicle position marker
        const lastPoint = newCoords[newCoords.length - 1];
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
        const tripId = tripData.tripId;
        const activeTripData = this.activeTrips.get(tripId);
        
        if (!activeTripData) return;

        // Add end marker
        const endPoint = tripData.gps.coordinates[tripData.gps.coordinates.length - 1];
        L.marker([endPoint[1], endPoint[0]], {
            icon: L.divIcon({
                className: 'trip-marker trip-end',
                html: '<i class="fas fa-stop"></i>'
            })
        }).addTo(this.map);

        // Clean up
        if (activeTripData.vehicleMarker) {
            this.map.removeLayer(activeTripData.vehicleMarker);
        }
        this.activeTrips.delete(tripId);

        // Refresh trips table
        if (window.fetchTrips) {
            window.fetchTrips();
        }
    }
} 