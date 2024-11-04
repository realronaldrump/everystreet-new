class RouteOptimizer {
    constructor(map = null) {
        this.map = map;
        this.currentRoute = null;
        this.routeLayer = null;
        this.initializeElements();
    }

    initializeElements() {
        // Initialize element references
        this.elements = {
            directionsPanel: document.getElementById('directions-panel'),
            turnByTurnDiv: document.getElementById('turn-by-turn'),
            routeStats: document.getElementById('route-stats'),
            routeProgress: document.getElementById('route-progress'),
            routeDetails: document.getElementById('route-details'),
            optimizeButton: document.getElementById('optimize-route')
        };

        // Log element status for debugging
        console.log('Route Optimizer Elements Status:', {
            directionsPanel: !!this.elements.directionsPanel,
            turnByTurnDiv: !!this.elements.turnByTurnDiv,
            routeStats: !!this.elements.routeStats,
            routeProgress: !!this.elements.routeProgress,
            routeDetails: !!this.elements.routeDetails,
            optimizeButton: !!this.elements.optimizeButton
        });

        this.initialize();
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
        if (this.elements.optimizeButton) {
            this.elements.optimizeButton.addEventListener('click', () => {
                console.log('Optimize button clicked');
                this.optimizeRoute();
            });
        }

        // Initialize route stats container
        if (this.elements.routeStats) {
            this.elements.routeStats.classList.add('d-none');
        }
    }

    async optimizeRoute() {
        if (!this.elements.optimizeButton) {
            console.error('Optimize button not found');
            return;
        }
    
        const originalText = this.elements.optimizeButton.innerHTML;
        const loadingManager = getLoadingManager();
    
        try {
            this.elements.optimizeButton.disabled = true;
            this.elements.optimizeButton.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Planning route...';
    
            loadingManager.startOperation('Optimizing Route');
            loadingManager.addSubOperation('location', 0.2);
            loadingManager.addSubOperation('routing', 0.8);
    
            const locationInput = document.getElementById('location-input');
            const locationData = JSON.parse(locationInput.getAttribute('data-location') || '{}');
    
            if (!locationData.osm_id || !locationData.osm_type) {
                throw new Error('Please validate a location first');
            }
    
            loadingManager.updateSubOperation('location', 50);
            const currentLocation = await this.getCurrentLocation();
            if (!currentLocation) {
                throw new Error('Could not get current location');
            }
            loadingManager.updateSubOperation('location', 100);
    
            this.showLoadingState();
            loadingManager.updateSubOperation('routing', 20);
    
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
    
            loadingManager.updateSubOperation('routing', 60);
    
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to optimize route');
            }
    
            const routeData = await response.json();
            loadingManager.updateSubOperation('routing', 90);
            
            await this.displayRoute(routeData);
            loadingManager.updateSubOperation('routing', 100);
    
        } catch (error) {
            console.error('Error optimizing route:', error);
            this.showError(error.message || 'Failed to optimize route. Please try again.');
        } finally {
            this.elements.optimizeButton.disabled = false;
            this.elements.optimizeButton.innerHTML = originalText;
            this.hideLoadingState();
            loadingManager.finish();
        }
    }

    async getCurrentLocation() {
        return new Promise(async (resolve, reject) => {
            if (!navigator.geolocation) {
                console.warn('Geolocation not supported. Falling back to last known location.');
                const lastLocation = await this.getLastKnownLocation();
                if (lastLocation) {
                    resolve(lastLocation);
                } else {
                    reject(new Error('Unable to get current location.'));
                }
                return;
            }

            navigator.geolocation.getCurrentPosition(
                position => {
                    resolve([position.coords.longitude, position.coords.latitude]);
                },
                async error => {
                    console.warn('Geolocation failed:', error);
                    const lastLocation = await this.getLastKnownLocation();
                    if (lastLocation) {
                        resolve(lastLocation);
                    } else {
                        reject(new Error('Unable to get current location.'));
                    }
                },
                {
                    enableHighAccuracy: true,
                    timeout: 10000,
                    maximumAge: 0
                }
            );
        });
    }

    async getLastKnownLocation() {
        try {
            const response = await fetch('/api/last_trip_point');
            const data = await response.json();
            return data.lastPoint || null;
        } catch (error) {
            console.error('Error fetching last known location:', error);
            return null;
        }
    }

    displayRoute(routeData) {
        try {
            // Clear existing route
            if (this.routeLayer) {
                this.map.removeLayer(this.routeLayer);
            }

            // Add the new route to the map
            this.routeLayer = L.geoJSON(routeData.route, {
                style: feature => ({
                    color: feature.properties.is_driven ? '#00FF00' : '#FF4444',
                    weight: 5,
                    opacity: 0.8,
                    dashArray: feature.properties.is_driven ? null : '10, 10'
                }),
                onEachFeature: (feature, layer) => {
                    layer.bindPopup(`
                        <strong>${feature.properties.name || 'Unnamed Street'}</strong><br>
                        Distance: ${(feature.properties.length || 0).toFixed(2)} km<br>
                        Status: ${feature.properties.is_driven ? 'Driven' : 'Not driven yet'}
                    `);
                }
            }).addTo(this.map);

            // Fit the map to show the entire route
            this.map.fitBounds(this.routeLayer.getBounds());

            // Update statistics and directions
            if (routeData.statistics) {
                this.updateStats(routeData.statistics);
            }

            if (routeData.turn_by_turn) {
                this.updateDirections(routeData.turn_by_turn);
            }

            // Show the directions panel
            this.showDirectionsPanel();

        } catch (error) {
            console.error('Error displaying route:', error);
            this.showError('Error displaying route. Please try again.');
        }
    }

    updateStats(statistics) {
        if (!this.elements.routeStats || !this.elements.routeProgress || !this.elements.routeDetails) {
            console.error('Stats elements not found:', {
                routeStats: !!this.elements.routeStats,
                routeProgress: !!this.elements.routeProgress,
                routeDetails: !!this.elements.routeDetails
            });
            return;
        }

        try {
            // Show the stats container
            this.elements.routeStats.classList.remove('d-none');

            // Calculate completion percentage
            const totalDistance = statistics.total_distance || 0;
            const drivenDistance = statistics.driven_distance || 0;
            const completionPercentage = totalDistance > 0 ? (drivenDistance / totalDistance) * 100 : 0;

            // Update progress bar
            this.elements.routeProgress.style.width = `${completionPercentage}%`;
            this.elements.routeProgress.setAttribute('aria-valuenow', completionPercentage);

            // Update details text
            this.elements.routeDetails.innerHTML = `
                <div class="row">
                    <div class="col-6">
                        <strong>Total Distance:</strong> ${totalDistance.toFixed(2)} km<br>
                        <strong>Driven:</strong> ${drivenDistance.toFixed(2)} km<br>
                        <strong>Remaining:</strong> ${(totalDistance - drivenDistance).toFixed(2)} km
                    </div>
                    <div class="col-6">
                        <strong>Estimated Time:</strong> ${statistics.estimated_time || 'N/A'}<br>
                        <strong>Turn Count:</strong> ${statistics.turn_count || 0}<br>
                        <strong>Coverage:</strong> ${completionPercentage.toFixed(1)}%
                    </div>
                </div>
            `;
        } catch (error) {
            console.error('Error updating stats:', error);
        }
    }

    updateDirections(directions) {
        if (!this.elements.turnByTurnDiv) {
            console.error('Turn-by-turn container not found');
            return;
        }

        try {
            const directionsHtml = directions.map((step, index) => `
                <div class="direction-step ${step.is_driven ? 'driven' : 'undriven'}">
                    <div class="step-number">${index + 1}</div>
                    <div class="step-details">
                        <div class="step-instruction">${step.instruction}</div>
                        <div class="step-distance">${step.distance.toFixed(2)} km</div>
                    </div>
                </div>
            `).join('');

            this.elements.turnByTurnDiv.innerHTML = directionsHtml;
            this.elements.turnByTurnDiv.classList.remove('d-none');
        } catch (error) {
            console.error('Error updating directions:', error);
        }
    }

    showDirectionsPanel() {
        if (this.elements.directionsPanel) {
            this.elements.directionsPanel.classList.remove('d-none');
        }
    }

    hideDirectionsPanel() {
        if (this.elements.directionsPanel) {
            this.elements.directionsPanel.classList.add('d-none');
        }
    }

    showLoadingState() {
        if (this.elements.turnByTurnDiv) {
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
        if (this.elements.turnByTurnDiv) {
            this.elements.turnByTurnDiv.innerHTML = '';
        }
    }

    showError(message) {
        if (this.elements.directionsPanel) {
            const errorHtml = `
                <div class="alert alert-danger" role="alert">
                    ${message}
                </div>
            `;
            this.elements.directionsPanel.innerHTML = errorHtml;
            this.elements.directionsPanel.classList.remove('d-none');
        }
    }

    clearRoute() {
        if (this.routeLayer) {
            this.map.removeLayer(this.routeLayer);
            this.routeLayer = null;
        }
        this.hideDirectionsPanel();
        if (this.elements.routeStats) {
            this.elements.routeStats.classList.add('d-none');
        }
    }
}

// Initialize RouteOptimizer when the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    // Make RouteOptimizer globally available
    window.EveryStreet = window.EveryStreet || {};
    window.EveryStreet.RouteOptimizer = RouteOptimizer;
});