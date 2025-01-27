/* global L, EveryStreet, LoadingManager, Chart, $ */

class VisitsManager {
    constructor(map) {
        this.map = map;
        this.places = new Map();
        this.drawControl = null;
        this.currentPolygon = null;
        this.visitsChart = null;
        this.visitsTable = null;
        this.tripsTable = null; // For the detailed trips view
        this.drawingEnabled = false;
        this.customPlacesLayer = null;
        this.loadingManager = new LoadingManager();

        this.isDetailedView = false; // Track if in detailed view

        this.initialize();
    }

    async initialize() {
        this.loadingManager.startOperation('Initializing Visits Page');

        try {
            this.loadingManager.addSubOperation('map', 20);
            this.loadingManager.addSubOperation('drawing', 10);
            this.loadingManager.addSubOperation('chart', 10);
            this.loadingManager.addSubOperation('table', 10);
            this.loadingManager.addSubOperation('listeners', 10);
            this.loadingManager.addSubOperation('places', 30);
            this.loadingManager.addSubOperation('nonCustom', 10);

            await this.initializeMap();
            this.loadingManager.updateSubOperation('map', 100);

            this.initializeDrawControls();
            this.loadingManager.updateSubOperation('drawing', 100);

            this.initializeChart();
            this.loadingManager.updateSubOperation('chart', 100);

            this.initializeTables();
            this.loadingManager.updateSubOperation('table', 100);

            this.setupEventListeners();
            this.loadingManager.updateSubOperation('listeners', 100);

            await this.loadPlaces();
            this.loadingManager.updateSubOperation('places', 100);

            await this.loadNonCustomPlacesVisits();
            this.loadingManager.updateSubOperation('nonCustom', 100);

            this.loadingManager.finish();
        } catch (error) {
            console.error('Error initializing visits page:', error);
            this.loadingManager.error('Failed to initialize visits page');
        }
    }

    initializeMap() {
        return new Promise((resolve) => {
            this.map = L.map('map', {
                center: [37.0902, -95.7129],
                zoom: 4,
                zoomControl: true,
            });

            L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                maxZoom: 19,
            }).addTo(this.map);

            // Create a layer group for custom places
            this.customPlacesLayer = L.layerGroup().addTo(this.map);
            resolve();
        });
    }

    initializeDrawControls() {
        this.drawControl = new L.Control.Draw({
            draw: {
                polygon: {
                    allowIntersection: false,
                    drawError: {
                        color: '#e1e100',
                        message: '<strong>Error:</strong> Shape edges cannot cross!',
                    },
                    shapeOptions: {
                        color: '#BB86FC'
                    },
                },
                circle: false,
                rectangle: false,
                circlemarker: false,
                marker: false,
                polyline: false,
            },
        });
    }

    initializeChart() {
        const ctx = document.getElementById('visitsChart').getContext('2d');
        this.visitsChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: [],
                datasets: [{
                    label: 'Visits per Place',
                    data: [],
                    backgroundColor: '#BB86FC',
                }, ],
            },
            options: {
                responsive: true,
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            stepSize: 1,
                        },
                    },
                },
            },
        });
    }

    initializeTables() {
        this.visitsTable = $('#visits-table').DataTable({
            responsive: true,
            order: [
                [1, 'desc']
            ],
            columns: [
                {
                    data: 'name',
                    render: (data, type, row) => {
                        if (type === 'display') {
                            return `<button class="btn btn-link place-link" data-place-id="${row._id}">${data}</button>`;
                        }
                        return data;
                    }
                },
                {
                    data: 'totalVisits',
                },
                {
                    data: 'firstVisit',
                    render: (data, type) => (data ? new Date(data).toLocaleDateString() : 'N/A'),
                },
                {
                    data: 'lastVisit',
                    render: (data) => (data ? new Date(data).toLocaleDateString() : 'N/A'),
                },
                {
                    data: 'avgTimeSpent',
                    render: (data) => data || 'N/A',
                },
            ],
            language: {
                emptyTable: 'No visits recorded for custom places',
            },
        });
    
        this.nonCustomVisitsTable = $('#non-custom-visits-table').DataTable({
            responsive: true,
            order: [[1, 'desc']],
            columns: [
                { data: 'name' },
                { data: 'totalVisits' },
                { data: 'firstVisit', render: (data) => (data ? new Date(data).toLocaleDateString() : 'N/A') },
                { data: 'lastVisit', render: (data) => (data ? new Date(data).toLocaleDateString() : 'N/A') },
            ],
            language: {
                emptyTable: 'No visits recorded for non-custom places',
            },
        });

        this.tripsTable = $('#trips-for-place-table').DataTable({
            responsive: true,
            order: [[1, "desc"]], // Sort by the "Date" column (index 1) in descending order
            columns: [
                { data: 'transactionId' },
                { 
                    data: 'endTime',
                    render: function(data, type, row) {
                        if (type === 'display' || type === 'filter') {
                            return new Date(data).toLocaleDateString();
                        }
                        return data; // Use raw data for sorting
                    }
                },
                {
                    data: 'endTime',
                    render: function(data, type, row) {
                        if (type === 'display' || type === 'filter') {
                            const timezone = row.timeZone || 'America/Chicago'; 
                            return new Date(data).toLocaleTimeString([], { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
                        }
                        return data; 
                    }
                },
                { data: 'duration' },
                { data: 'timeSinceLastVisit' },
            ],
            language: {
                emptyTable: 'No trips found for this place',
            },
        });
    }

    setupEventListeners() {
        document.getElementById('start-drawing').addEventListener('click', () => {
            if (!this.drawingEnabled) {
                this.map.addControl(this.drawControl);
                new L.Draw.Polygon(this.map).enable();
                this.drawingEnabled = true;
                document.getElementById('start-drawing').classList.add('active');
            }
        });

        document.getElementById('save-place').addEventListener('click', () => this.savePlace());

        this.map.on(L.Draw.Event.CREATED, (e) => {
            this.currentPolygon = e.layer;
            this.map.addLayer(this.currentPolygon);
            document.getElementById('save-place').disabled = false;
        });

        // Add event listener for place links using event delegation
        $('#visits-table').on('click', '.place-link', (event) => {
            event.preventDefault();
            const placeId = $(event.target).data('place-id');
            this.toggleView(placeId);
        });

        // Add event listener for toggle view button
        document.getElementById('toggle-view-btn').addEventListener('click', () => {
            this.toggleView();
        });
    }

    async loadPlaces() {
        try {
            this.loadingManager.addSubOperation('fetchPlaces', 50);
            this.loadingManager.addSubOperation('processPlaces', 30);
            this.loadingManager.addSubOperation('updateVisits', 20);

            const response = await fetch('/api/places');
            if (!response.ok) {
                throw new Error('Failed to fetch places');
            }
            const places = await response.json();
            this.loadingManager.updateSubOperation('fetchPlaces', 100);

            const totalPlaces = places.length;
            places.forEach((place, index) => {
                this.places.set(place._id, place);
                this.displayPlace(place);
                const progress = (index / totalPlaces) * 100;
                this.loadingManager.updateSubOperation('processPlaces', progress);
            });

            await this.updateVisitsData();
            this.loadingManager.updateSubOperation('updateVisits', 100);
        } catch (error) {
            console.error('Error loading places:', error);
            this.loadingManager.error('Failed to load places');
            throw error;
        }
    }

    displayPlace(place) {
        const polygon = L.geoJSON(place.geometry, {
            style: {
                color: '#BB86FC',
                fillColor: '#BB86FC',
                fillOpacity: 0.2,
            },
        });

        polygon.bindPopup(`
			  <div class="place-popup">
				  <h6>${place.name}</h6>
				  <button class="btn btn-sm btn-info" onclick="visitsManager.showPlaceStatistics('${place._id}')">
					  View Statistics
				  </button>
			  </div>
		  `);
        polygon.on('click', () => this.showPlaceStatistics(place._id));
        this.customPlacesLayer.addLayer(polygon);
    }

    async updateVisitsData() {
        this.loadingManager.startOperation('Updating Visits Data');
        const visitsData = [];
        const totalPlaces = this.places.size;
        let processedPlaces = 0;
        this.loadingManager.addSubOperation('fetchStats', 80);
        this.loadingManager.addSubOperation('updateTable', 20);

        for (const [id, place] of this.places) {
            try {
                const progress = (processedPlaces / totalPlaces) * 100;
                this.loadingManager.updateSubOperation('fetchStats', progress);

                const response = await fetch(`/api/places/${id}/statistics`);
                if (!response.ok) {
                    throw new Error(`Failed to fetch statistics for place ${id}`);
                }
                const stats = await response.json();
                visitsData.push({
                    _id: id, // Add the _id field here
                    name: place.name,
                    totalVisits: stats.totalVisits,
                    firstVisit: stats.firstVisit,
                    lastVisit: stats.lastVisit,
                    avgTimeSpent: stats.averageTimeSpent,
                });

                processedPlaces++;
            } catch (error) {
                console.error(`Error fetching statistics for place ${place.name}:`, error);
                this.loadingManager.error(`Failed to fetch statistics for ${place.name}`);
            }
        }

        // Update chart and table
        this.visitsChart.data.labels = visitsData.map((d) => d.name);
        this.visitsChart.data.datasets[0].data = visitsData.map((d) => d.totalVisits);
        this.visitsChart.update();

        this.visitsTable.clear().rows.add(visitsData).draw();
        this.loadingManager.updateSubOperation('updateTable', 100);
        this.loadingManager.finish();
    }

    async savePlace() {
        this.loadingManager.startOperation('Saving Place');
        const placeName = document.getElementById('place-name').value.trim();
        if (!placeName || !this.currentPolygon) {
            this.loadingManager.finish();
            return;
        }

        const placeData = {
            name: placeName,
            geometry: this.currentPolygon.toGeoJSON().geometry,
        };

        try {
            const response = await fetch('/api/places', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(placeData),
            });

            if (!response.ok) {
                throw new Error('Failed to save place');
            }

            const savedPlace = await response.json();
            this.places.set(savedPlace._id, savedPlace);
            this.displayPlace(savedPlace);
            this.resetDrawing();
            this.updateVisitsData();
            this.loadingManager.finish();
        } catch (error) {
            console.error('Error saving place:', error);
            this.loadingManager.error('Failed to save place');
        }
    }

    async deletePlace(placeId) {
        this.loadingManager.startOperation('Deleting Place');
        if (confirm('Are you sure you want to delete this place?')) {
            try {
                const response = await fetch(`/api/places/${placeId}`, {
                    method: 'DELETE',
                });

                if (!response.ok) {
                    throw new Error('Failed to delete place');
                }

                this.places.delete(placeId);
                this.map.eachLayer((layer) => {
                    if (layer.feature && layer.feature.properties.placeId === placeId) {
                        this.map.removeLayer(layer);
                    }
                });
                this.updateVisitsData();
                this.loadingManager.finish();
            } catch (error) {
                console.error('Error deleting place:', error);
                this.loadingManager.error('Failed to delete place');
            }
        } else {
            this.loadingManager.finish();
        }
    }

    resetDrawing() {
        if (this.currentPolygon) {
            this.map.removeLayer(this.currentPolygon);
        }
        this.currentPolygon = null;
        document.getElementById('place-name').value = '';
        document.getElementById('save-place').disabled = true;
        this.map.removeControl(this.drawControl);
    }

    async showPlaceStatistics(placeId) {
        this.loadingManager.startOperation('Fetching Place Statistics');
        try {
            const response = await fetch(`/api/places/${placeId}/statistics`);
            if (!response.ok) {
                throw new Error('Failed to fetch place statistics');
            }
            const stats = await response.json();
    
            // Create the content for the popup
            const popupContent = `
                <div class="custom-place-popup">
                    <h6>${this.places.get(placeId).name}</h6>
                    <p>Total Visits: ${stats.totalVisits}</p>
                    <p>First Visit: ${stats.firstVisit ? new Date(stats.firstVisit).toLocaleDateString() : 'N/A'}</p>
                    <p>Last Visit: ${stats.lastVisit ? new Date(stats.lastVisit).toLocaleDateString() : 'N/A'}</p>
                    <p>Avg Time Spent: ${stats.averageTimeSpent || 'N/A'}</p>
                    <p>Avg Time Since Last Visit: ${stats.averageTimeSinceLastVisit ? stats.averageTimeSinceLastVisit.toFixed(2) + ' hours' : 'N/A'}</p>
                </div>
            `;
    
            // Find the layer associated with the placeId and update its popup content
            this.customPlacesLayer.eachLayer(layer => {
                if (layer.feature && layer.feature.properties.placeId === placeId) {
                    layer.setPopupContent(popupContent);
                }
            });
    
            this.loadingManager.finish();
        } catch (error) {
            console.error('Error fetching place statistics:', error);
            this.loadingManager.error('Failed to fetch place statistics');
        }
    }

    async toggleView(placeId = null) {
        this.isDetailedView = !this.isDetailedView;

        if (this.isDetailedView) {
            if (!placeId) {
                console.error("Place ID is undefined");
                this.isDetailedView = false;
                return;
            }
            await this.showTripsForPlace(placeId);
            document.getElementById('visits-table-container').style.display = 'none';
            document.getElementById('trips-for-place-container').style.display = 'block';
            document.getElementById('toggle-view-btn').textContent = 'Show All Places';
        } else {
            document.getElementById('visits-table-container').style.display = 'block';
            document.getElementById('trips-for-place-container').style.display = 'none';
            document.getElementById('toggle-view-btn').textContent = 'Show Trips for Selected Place';
        }
    }

    async showTripsForPlace(placeId) {
        try {
            const response = await fetch(`/api/places/${placeId}/trips`);
            if (!response.ok) {
                throw new Error('Failed to fetch trips for place');
            }
            const trips = await response.json();
    
            // Sort trips by endTime in descending order (most recent first)
            trips.sort((a, b) => new Date(b.endTime) - new Date(a.endTime));
    
            this.tripsTable.clear().rows.add(trips).draw();
        } catch (error) {
            console.error('Error fetching trips for place:', error);
        }
    }

    async loadNonCustomPlacesVisits() {
        try {
            const response = await fetch('/api/non_custom_places_visits');
            if (!response.ok) {
                throw new Error('Failed to fetch visits for non-custom places');
            }
            const visitsData = await response.json();
            this.nonCustomVisitsTable.clear().rows.add(visitsData).draw();
        } catch (error) {
            console.error('Error fetching visits for non-custom places:', error);
        }
    }
}

// Initialize when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.visitsManager = new VisitsManager();
});