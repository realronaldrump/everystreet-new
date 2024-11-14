document.addEventListener('DOMContentLoaded', () => {
    // Initialize map and layer groups
    const editMap = L.map('editMap').setView([37.0902, -95.7129], 4);
    let tripsLayerGroup = new L.FeatureGroup().addTo(editMap);
    let currentTrip = null;
    let editMode = false;
    let editableLayers = new L.FeatureGroup().addTo(editMap);

    // Initialize Map Tiles
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        attribution: ''
    }).addTo(editMap);

    // Initialize Leaflet Draw Control
    const drawControl = new L.Control.Draw({
        edit: {
            featureGroup: editableLayers,
            edit: true,
            remove: true
        },
        draw: {
            marker: true,
            circlemarker: false,
            circle: false,
            rectangle: false,
            polygon: false,
            polyline: false
        }
    });

    function getDateRange() {
        const startDate = localStorage.getItem('startDate') || document.getElementById('start-date').value;
        const endDate = localStorage.getItem('endDate') || document.getElementById('end-date').value;
        return { startDate, endDate };
    }

    function showNotification(message, type = 'info') {
        const notificationDiv = document.getElementById('notification');
        if (notificationDiv) {
            notificationDiv.innerHTML = `
                <div class="alert alert-${type} alert-dismissible fade show" role="alert">
                    ${message}
                    <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
                </div>
            `;
        }
    }

    function enableEditing() {
        if (currentTrip) {
            createEditableMarkers(currentTrip.tripData.geometry.coordinates);
        }
    }

    function disableEditing() {
        editableLayers.clearLayers();
    }

    // Event Listeners
    document.getElementById('editModeToggle')?.addEventListener('change', (e) => {
        editMode = e.target.checked;
        document.getElementById('saveChanges').disabled = !editMode;
        if (editMode) {
            editMap.addControl(drawControl);
            enableEditing();
        } else {
            editMap.removeControl(drawControl);
            disableEditing();
        }
    });

    document.getElementById('saveChanges')?.addEventListener('click', async () => {
        if (!currentTrip) {
            showNotification('No trip selected to save.', 'warning');
            return;
        }

        try {
            const tripType = document.getElementById('tripType').value;
            const tripId = currentTrip.tripData.properties.transactionId;

            const response = await fetch(`/api/trips/${tripId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    type: tripType,
                    geometry: {
                        type: 'LineString',
                        coordinates: currentTrip.tripData.geometry.coordinates
                    }
                })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to save trip changes');
            }

            showNotification('Trip changes saved successfully!', 'success');
            
            // Update the current trip data to reflect changes
            currentTrip.tripData.geometry.coordinates = currentTrip.tripData.geometry.coordinates;
            
            // Don't reload all trips, just update the current one
            updateTripLayer();
        } catch (error) {
            console.error('Error saving trip:', error);
            showNotification(error.message || 'Failed to save trip changes. Please try again.', 'danger');
        }
    });

    document.getElementById('tripType')?.addEventListener('change', loadTrips);
    document.getElementById('apply-filters')?.addEventListener('click', loadTrips);
    document.getElementById('fetch-trips-range')?.addEventListener('click', loadTrips);

    // Map Event Handlers
    editMap.on(L.Draw.Event.CREATED, (e) => {
        const layer = e.layer;
        if (currentTrip) {
            addPointToTrip(layer.getLatLng());
        }
    });

    editMap.on(L.Draw.Event.EDITED, (e) => {
        const layers = e.layers;
        layers.eachLayer((layer) => {
            if (layer instanceof L.Marker) {
                const index = layer.options.pointIndex;
                updatePointInTrip(index, layer.getLatLng());
            }
        });
    });

    editMap.on(L.Draw.Event.DELETED, (e) => {
        const layers = e.layers;
        layers.eachLayer((layer) => {
            if (layer instanceof L.Marker) {
                const index = layer.options.pointIndex;
                removePointFromTrip(index);
            }
        });
    });

    async function loadTrips() {
        const tripType = document.getElementById('tripType').value;
        const { startDate, endDate } = getDateRange();

        if (!startDate || !endDate) {
            showNotification('Please select both start and end dates in the sidebar.', 'danger');
            return;
        }

        try {
            const response = await fetch(`/api/trips?start_date=${startDate}&end_date=${endDate}`);
            if (!response.ok) throw new Error('Failed to fetch trips');
            
            const data = await response.json();
            if (!data.features || !Array.isArray(data.features)) {
                throw new Error('Invalid trip data format');
            }

            const trips = data.features.filter(feature => 
                tripType === 'matched_trips' ? 
                feature.properties.imei === 'HISTORICAL' : 
                feature.properties.imei !== 'HISTORICAL'
            );

            displayTrips(trips);
        } catch (error) {
            console.error('Error loading trips:', error);
            showNotification('Error loading trips. Please try again.', 'danger');
        }
    }

    function displayTrips(trips) {
        tripsLayerGroup.clearLayers();
        editableLayers.clearLayers();
        currentTrip = null;

        const layers = [];
        
        trips.forEach(trip => {
            if (trip.geometry && trip.geometry.coordinates) {
                const coordinates = trip.geometry.coordinates.map(coord => [coord[1], coord[0]]);
                const tripLayer = L.polyline(coordinates, {
                    color: trip.properties.imei === 'HISTORICAL' ? '#CF6679' : '#BB86FC',
                    weight: 3,
                    opacity: 0.6
                });

                tripLayer.on('click', () => selectTrip(tripLayer, trip));
                tripsLayerGroup.addLayer(tripLayer);
                layers.push(tripLayer);
            }
        });

        if (layers.length > 0) {
            const group = L.featureGroup(layers);
            editMap.fitBounds(group.getBounds());
            showNotification(`Loaded ${trips.length} trips successfully.`, 'success');
        } else {
            showNotification('No trips found for the selected date range.', 'warning');
        }
    }

    function selectTrip(layer, tripData) {
        console.log('Selected trip:', {
            id: tripData.properties.transactionId,
            type: tripData.properties.imei === 'HISTORICAL' ? 'matched_trips' : 'trips'
        });

        if (currentTrip) {
            currentTrip.layer.setStyle({
                color: currentTrip.tripData.properties.imei === 'HISTORICAL' ? '#CF6679' : '#BB86FC',
                weight: 3,
                opacity: 0.6
            });
        }

        currentTrip = { layer, tripData };
        layer.setStyle({
            color: '#FFD700',
            weight: 5,
            opacity: 1
        });

        editableLayers.clearLayers();
        if (editMode) {
            createEditableMarkers(tripData.geometry.coordinates);
        }

        showTripDetails(tripData);
    }

    function createEditableMarkers(coordinates) {
        coordinates.forEach((coord, index) => {
            const marker = L.marker([coord[1], coord[0]], {
                draggable: true,
                pointIndex: index
            });

            marker.on('dragend', (e) => {
                const newLatLng = e.target.getLatLng();
                updatePointInTrip(index, newLatLng);
            });

            editableLayers.addLayer(marker);
        });
    }

    function updatePointInTrip(index, newLatLng) {
        if (!currentTrip) return;

        const coords = currentTrip.tripData.geometry.coordinates;
        coords[index] = [newLatLng.lng, newLatLng.lat];
        updateTripLayer();
    }

    function addPointToTrip(latLng) {
        if (!currentTrip) return;

        const coords = currentTrip.tripData.geometry.coordinates;
        const newPoint = [latLng.lng, latLng.lat];
        
        // Find the closest segment to insert the new point
        let minDist = Infinity;
        let insertIndex = coords.length;

        for (let i = 0; i < coords.length - 1; i++) {
            const dist = pointToSegmentDistance(
                newPoint,
                coords[i],
                coords[i + 1]
            );
            if (dist < minDist) {
                minDist = dist;
                insertIndex = i + 1;
            }
        }

        coords.splice(insertIndex, 0, newPoint);
        updateTripLayer();
    }

    function removePointFromTrip(index) {
        if (!currentTrip) return;

        const coords = currentTrip.tripData.geometry.coordinates;
        if (coords.length <= 2) {
            showNotification('Cannot remove point: Trip must have at least 2 points.', 'warning');
            return;
        }

        coords.splice(index, 1);
        updateTripLayer();
    }

    function updateTripLayer() {
        if (!currentTrip) return;

        const coordinates = currentTrip.tripData.geometry.coordinates.map(coord => [coord[1], coord[0]]);
        currentTrip.layer.setLatLngs(coordinates);

        editableLayers.clearLayers();
        if (editMode) {
            createEditableMarkers(currentTrip.tripData.geometry.coordinates);
        }
    }

    function showTripDetails(tripData) {
        const timezone = tripData.properties.timezone || 'America/Chicago';
        const startTime = new Date(tripData.properties.startTime);
        const endTime = new Date(tripData.properties.endTime);

        const formatter = new Intl.DateTimeFormat('en-US', {
            dateStyle: 'short',
            timeStyle: 'short',
            timeZone: timezone,
            hour12: true
        });

        const details = document.createElement('div');
        details.className = 'trip-details mt-3';
        details.innerHTML = `
            <div class="card bg-dark border-secondary">
                <div class="card-header">
                    <h5 class="card-title mb-0">Trip Details</h5>
                </div>
                <div class="card-body">
                    <p><strong>Trip ID:</strong> ${tripData.properties.transactionId}</p>
                    <p><strong>Start Time:</strong> ${formatter.format(startTime)}</p>
                    <p><strong>End Time:</strong> ${formatter.format(endTime)}</p>
                    <p><strong>Distance:</strong> ${parseFloat(tripData.properties.distance).toFixed(2)} miles</p>
                    <p><strong>Points:</strong> ${tripData.geometry.coordinates.length}</p>
                </div>
            </div>
        `;

        const existingDetails = document.querySelector('.trip-details');
        if (existingDetails) {
            existingDetails.replaceWith(details);
        } else {
            document.querySelector('.card-body').appendChild(details);
        }
    }

    function pointToSegmentDistance(point, start, end) {
        const [x, y] = point;
        const [x1, y1] = start;
        const [x2, y2] = end;

        const A = x - x1;
        const B = y - y1;
        const C = x2 - x1;
        const D = y2 - y1;

        const dot = A * C + B * D;
        const lenSq = C * C + D * D;
        let param = -1;

        if (lenSq !== 0) {
            param = dot / lenSq;
        }

        let xx, yy;

        if (param < 0) {
            xx = x1;
            yy = y1;
        } else if (param > 1) {
            xx = x2;
            yy = y2;
        } else {
            xx = x1 + param * C;
            yy = y1 + param * D;
        }

        const dx = x - xx;
        const dy = y - yy;

        return Math.sqrt(dx * dx + dy * dy);
    }

    // Initialize by loading trips
    loadTrips();
});