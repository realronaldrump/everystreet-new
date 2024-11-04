class RouteOptimizer {
    constructor(map = null) {
        this.map = map;
        this.currentRoute = null;
        this.routeLayer = null;
        
        // Wait a short moment to ensure DOM is ready
        setTimeout(() => {
            this.elements = {
                directionsPanel: document.getElementById('directions-panel'),
                turnByTurnDiv: document.getElementById('turn-by-turn'),
                routeStats: document.getElementById('route-stats'),
                routeProgress: document.getElementById('route-progress'),
                routeDetails: document.getElementById('route-details'),
                optimizeButton: document.getElementById('optimize-route')
            };
            
            if (!this.validateElements()) {
                console.error('Required elements not found. DOM structure:', {
                    directionsPanel: !!this.elements.directionsPanel,
                    turnByTurnDiv: !!this.elements.turnByTurnDiv,
                    routeStats: !!this.elements.routeStats,
                    routeProgress: !!this.elements.routeProgress,
                    routeDetails: !!this.elements.routeDetails,
                    optimizeButton: !!this.elements.optimizeButton
                });
                return;
            }
            
            this.initialize();
        }, 0);
    }

    initialize() {
        if (!this.validateElements()) {
            console.error('Required elements not found');
            return;
        }
        this.initializeUI();
    }

    validateElements() {
        const requiredElements = ['directionsPanel', 'turnByTurnDiv', 'routeStats', 'routeProgress', 'routeDetails', 'optimizeButton'];
        const missingElements = requiredElements.filter(element => !this.elements[element]);
        
        if (missingElements.length > 0) {
            console.error(`Missing required elements: ${missingElements.join(', ')}`);
            return false;
        }
        return true;
    }

    initializeUI() {
        const routeOptDiv = document.getElementById('route-optimization');
        if (!routeOptDiv) {
            console.error('Route optimization container not found');
            return;
        }

        // Use the stored button reference
        if (this.elements.optimizeButton) {
            this.elements.optimizeButton.addEventListener('click', () => {
                console.log('Optimize button clicked');
                this.optimizeRoute();
            });
        } else {
            console.error('Optimize button not found');
        }
    }

    async optimizeRoute() {
        if (!this.elements.optimizeButton) {
            console.error('Optimize button not found');
            return;
        }

        const originalText = this.elements.optimizeButton.innerHTML;

        try {
            this.elements.optimizeButton.disabled = true;
            this.elements.optimizeButton.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Planning route...';

            const locationInput = document.getElementById('location-input');
            const locationData = JSON.parse(locationInput.getAttribute('data-location') || '{}');

            if (!locationData.osm_id || !locationData.osm_type) {
                throw new Error('Please validate a location first');
            }

            const currentLocation = await this.getCurrentLocation();
            if (!currentLocation) {
                throw new Error('Could not get current location');
            }

            this.showLoadingState();

            const response = await fetch('/api/optimize-route', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    current_location: currentLocation,
                    location: locationData
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to optimize route');
            }

            const routeData = await response.json();
            this.displayRoute(routeData);

        } catch (error) {
            console.error('Error optimizing route:', error);
            this.showError(error.message || 'Failed to optimize route. Please try again.');
        } finally {
            this.elements.optimizeButton.disabled = false;
            this.elements.optimizeButton.innerHTML = originalText;
            this.hideLoadingState();
        }
    }

    async getCurrentLocation() {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) {
                alert('Geolocation is not supported by your browser');
                reject(new Error('Geolocation not supported'));
                return;
            }

            // Show loading state
            const button = document.getElementById('optimize-route');
            button.disabled = true;
            button.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Getting location...';

            navigator.geolocation.getCurrentPosition(
                position => {
                    // Swap coordinates to [latitude, longitude] format
                    resolve([position.coords.latitude, position.coords.longitude]);
                },
                error => {
                    let errorMessage;
                    switch(error.code) {
                        case error.PERMISSION_DENIED:
                            errorMessage = 'Location access denied. Please enable location services in your browser settings.';
                            break;
                        case error.POSITION_UNAVAILABLE:
                            errorMessage = 'Location information is unavailable. Please try again.';
                            break;
                        case error.TIMEOUT:
                            errorMessage = 'Location request timed out. Please check your connection and try again.';
                            break;
                        default:
                            errorMessage = 'An unknown error occurred getting your location.';
                    }
                    alert(errorMessage);
                    reject(error);
                },
                {
                    enableHighAccuracy: true,
                    timeout: 10000,
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
        if (!this.elements.statsDiv || !this.elements.progressBar || !this.elements.detailsDiv) {
            console.error('Stats elements not found');
            return;
        }

        this.elements.statsDiv.classList.remove('d-none');

        const completionPercentage = ((stats.total_distance - stats.undriven_distance) / stats.total_distance) * 100;

        this.elements.progressBar.style.width = `${completionPercentage}%`;
        this.elements.progressBar.setAttribute('aria-valuenow', completionPercentage);

        this.elements.detailsDiv.innerHTML = `
            Total Distance: ${(stats.total_distance * 0.000621371).toFixed(2)} miles<br>
            Remaining: ${(stats.undriven_distance * 0.000621371).toFixed(2)} miles<br>
            Est. Time: ${Math.round(stats.estimated_time)} minutes
        `;
    }

    updateDirections(directions) {
        if (!this.elements.turnByTurnDiv) {
            console.error('Turn-by-turn div not found');
            return;
        }

        this.elements.turnByTurnDiv.innerHTML = directions.map((step, index) => `
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
        if (this.elements.directionsPanel) {
            this.elements.directionsPanel.classList.remove('d-none');
            this.elements.turnByTurnDiv.innerHTML = `
                <div class="text-center p-4">
                    <div class="spinner-border" role="status">
                        <span class="visually-hidden">Loading...</span>
                    </div>
                    <div class="mt-2">Calculating optimal route...</div>
                </div>
            `;
        }
    }

    hideLoadingState() {
        if (this.elements.directionsPanel) {
            this.elements.turnByTurnDiv.innerHTML = '';
        }
    }

    showError(message) {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'alert alert-danger';
        errorDiv.role = 'alert';
        errorDiv.textContent = message;

        if (this.elements.directionsPanel) {
            this.elements.directionsPanel.innerHTML = '';
            this.elements.directionsPanel.appendChild(errorDiv);
        }
    }

    // Helper method to toggle directions panel
    toggleDirectionsPanel() {
        if (this.elements.directionsPanel) {
            this.elements.directionsPanel.classList.toggle('d-none');
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
window.EveryStreet = window.EveryStreet || {};
window.EveryStreet.toggleDirectionsPanel = function() {
    if (window.routeOptimizer) {
        window.routeOptimizer.toggleDirectionsPanel();
    }
};