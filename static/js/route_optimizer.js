class RouteOptimizer {
    constructor(map) {
        this.map = map;
        this.currentRoute = null;
        this.routeLayer = null;
        this.directionsPanel = null;
        this.initialize();
    }

    initialize() {
        // Wait for DOM to be ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.initializeUI());
        } else {
            this.initializeUI();
        }
    }

    initializeUI() {
        const routeOptDiv = document.getElementById('route-optimization');
        if (!routeOptDiv) {
            console.error('Route optimization container not found');
            return;
        }

        // Add event listener to the optimize button
        const optimizeButton = document.getElementById('optimize-route');
        if (optimizeButton) {
            optimizeButton.addEventListener('click', () => this.optimizeRoute());
        }
    }

    async optimizeRoute() {
        try {
            const location = await this.getCurrentLocation();
            if (!location) {
                throw new Error('Could not get current location');
            }

            this.showLoadingState();

            const response = await fetch('/api/optimize-route', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    current_location: location,
                    location: document.getElementById('location-input').value
                })
            });

            if (!response.ok) {
                throw new Error('Failed to optimize route');
            }

            const routeData = await response.json();
            this.displayRoute(routeData);

        } catch (error) {
            console.error('Error optimizing route:', error);
            this.showError('Failed to optimize route. Please try again.');
        } finally {
            this.hideLoadingState();
        }
    }

    async getCurrentLocation() {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) {
                reject(new Error('Geolocation is not supported by your browser'));
                return;
            }

            navigator.geolocation.getCurrentPosition(
                position => {
                    resolve([position.coords.longitude, position.coords.latitude]);
                },
                error => {
                    console.error('Geolocation error:', error);
                    reject(error);
                },
                {
                    enableHighAccuracy: true,
                    timeout: 5000,
                    maximumAge: 0
                }
            );
        });
    }

    displayRoute(routeData) {
        // Clear existing route
        if (this.routeLayer) {
            this.map.removeLayer(this.routeLayer);
        }

        // Display new route
        this.routeLayer = L.geoJSON(routeData.route, {
            style: feature => ({
                color: feature.properties.is_driven ? '#00FF00' : '#FF4444',
                weight: 5,
                opacity: 0.8,
                dashArray: feature.properties.is_driven ? null : '10, 10'
            }),
            onEachFeature: (feature, layer) => {
                layer.bindPopup(`
                    <strong>${feature.properties.name}</strong><br>
                    Distance: ${(feature.properties.length * 0.000621371).toFixed(2)} miles<br>
                    Status: ${feature.properties.is_driven ? 'Driven' : 'Not driven yet'}<br>
                    Sequence: ${feature.properties.sequence_number + 1}
                `);
            }
        }).addTo(this.map);

        // Update stats
        this.updateStats(routeData.statistics);

        // Update directions
        this.updateDirections(routeData.turn_by_turn);

        // Fit map to route bounds
        this.map.fitBounds(this.routeLayer.getBounds());

        // Show directions panel
        this.showDirectionsPanel();
    }

    updateStats(stats) {
        const statsDiv = document.getElementById('route-stats');
        const progressBar = document.getElementById('route-progress');
        const detailsDiv = document.getElementById('route-details');

        statsDiv.classList.remove('d-none');

        const completionPercentage = ((stats.total_distance - stats.undriven_distance) / stats.total_distance) * 100;

        progressBar.style.width = `${completionPercentage}%`;
        progressBar.setAttribute('aria-valuenow', completionPercentage);

        detailsDiv.innerHTML = `
            Total Distance: ${(stats.total_distance * 0.000621371).toFixed(2)} miles<br>
            Remaining: ${(stats.undriven_distance * 0.000621371).toFixed(2)} miles<br>
            Est. Time: ${Math.round(stats.estimated_time)} minutes
        `;
    }

    updateDirections(directions) {
        const directionsPanel = document.getElementById('directions-panel');
        const turnByTurnDiv = document.getElementById('turn-by-turn');

        turnByTurnDiv.innerHTML = directions.map((step, index) => `
            <div class="direction-step ${step.is_driven ? 'driven' : 'undriven'}">
                <div class="step-number">${index + 1}</div>
                <div class="step-details">
                    <div class="step-instruction">
                        ${step.turn} on ${step.street_name}
                    </div>
                    <div class="step-distance">
                        ${(step.distance * 0.000621371).toFixed(2)} miles
                    </div>
                </div>
            </div>
        `).join('');
    }

    showDirectionsPanel() {
        const panel = document.getElementById('directions-panel');
        panel.classList.remove('d-none');
    }

    hideDirectionsPanel() {
        const panel = document.getElementById('directions-panel');
        panel.classList.add('d-none');
    }

    showLoadingState() {
        const button = document.getElementById('optimize-route');
        button.disabled = true;
        button.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Optimizing...';
    }

    hideLoadingState() {
        const button = document.getElementById('optimize-route');
        button.disabled = false;
        button.innerHTML = '<i class="fas fa-route"></i> Plan Optimal Route';
    }

    showError(message) {
        // You can customize this to match your app's error display style
        alert(message);
    }

    // Helper method to toggle directions panel
    toggleDirectionsPanel() {
        const panel = document.getElementById('directions-panel');
        if (panel.classList.contains('d-none')) {
            this.showDirectionsPanel();
        } else {
            this.hideDirectionsPanel();
        }
    }

    // Helper method to clear the current route
    clearRoute() {
        if (this.routeLayer) {
            this.map.removeLayer(this.routeLayer);
            this.routeLayer = null;
        }
        this.hideDirectionsPanel();
        const statsDiv = document.getElementById('route-stats');
        statsDiv.classList.add('d-none');
    }

    // Method to export the current route
    exportRoute() {
        if (!this.routeLayer) {
            this.showError('No route to export');
            return;
        }

        const routeData = this.routeLayer.toGeoJSON();
        const blob = new Blob([JSON.stringify(routeData)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'optimized_route.geojson';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

// Make toggleDirectionsPanel available globally
window.toggleDirectionsPanel = function() {
    if (window.routeOptimizer) {
        window.routeOptimizer.toggleDirectionsPanel();
    }
};