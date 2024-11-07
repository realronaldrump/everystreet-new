class VisitsManager {
    constructor() {
        this.map = null;
        this.places = new Map();
        this.drawControl = null;
        this.currentPolygon = null;
        this.visitsChart = null;
        this.visitsTable = null;
        this.drawingEnabled = false;
        this.customPlacesLayer = null;
        this.loadingManager = getLoadingManager();

        this.initialize();
    }

    async initialize() {
        this.loadingManager.startOperation('Initializing Visits Page');
        
        try {
            this.loadingManager.updateProgress(10, 'Initializing map...');
            await this.initializeMap();
            
            this.loadingManager.updateProgress(20, 'Setting up drawing controls...');
            this.initializeDrawControls();
            
            this.loadingManager.updateProgress(30, 'Initializing statistics chart...');
            this.initializeChart();
            
            this.loadingManager.updateProgress(40, 'Setting up visits table...');
            this.initializeTable();
            
            this.loadingManager.updateProgress(50, 'Setting up event listeners...');
            this.setupEventListeners();
            
            this.loadingManager.updateProgress(60, 'Loading places...');
            await this.loadPlaces();
            
            this.loadingManager.finish();
        } catch (error) {
            console.error('Error initializing visits page:', error);
            this.loadingManager.error('Failed to initialize visits page');
        }
    }

    initializeMap() {
        this.map = L.map('map', {
            center: [37.0902, -95.7129],
            zoom: 4,
            zoomControl: true
        });

        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 19
        }).addTo(this.map);

        // Create a layer group for custom places
        this.customPlacesLayer = L.layerGroup().addTo(this.map);
    }

    initializeDrawControls() {
        this.drawControl = new L.Control.Draw({
            draw: {
                polygon: {
                    allowIntersection: false,
                    drawError: {
                        color: '#e1e100',
                        message: '<strong>Error:</strong> Shape edges cannot cross!'
                    },
                    shapeOptions: {
                        color: '#BB86FC'
                    }
                },
                circle: false,
                rectangle: false,
                circlemarker: false,
                marker: false,
                polyline: false
            }
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
                    backgroundColor: '#BB86FC'
                }]
            },
            options: {
                responsive: true,
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            stepSize: 1
                        }
                    }
                }
            }
        });
    }

    initializeTable() {
        this.visitsTable = $('#visits-table').DataTable({
            responsive: true,
            order: [[1, 'desc']],
            columns: [
                { data: 'name' },
                { data: 'totalVisits' },
                { 
                    data: 'firstVisit',
                    render: data => data ? new Date(data).toLocaleDateString() : 'N/A'
                },
                { 
                    data: 'lastVisit',
                    render: data => data ? new Date(data).toLocaleDateString() : 'N/A'
                },
                { 
                    data: 'avgTimeSpent',
                    render: data => data || 'N/A'
                }
            ],
            language: {
                emptyTable: "No visits recorded for custom places"
            }
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
    }

    async loadPlaces() {
        try {
            this.loadingManager.updateProgress(70, 'Fetching places from server...');
            const response = await fetch('/api/places');
            const places = await response.json();
            
            this.loadingManager.updateProgress(80, 'Processing places data...');
            const totalPlaces = places.length;
            places.forEach((place, index) => {
                this.places.set(place._id, place);
                this.displayPlace(place);
                const progress = 80 + (index / totalPlaces * 10);
                this.loadingManager.updateProgress(progress, `Loading place ${index + 1} of ${totalPlaces}...`);
            });
            
            this.loadingManager.updateProgress(90, 'Updating visits statistics...');
            await this.updateVisitsData();
            
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
                fillOpacity: 0.2
            }
        });

        polygon.bindPopup(`
            <div class="place-popup">
                <h6>${place.name}</h6>
                <button class="btn btn-sm btn-info" onclick="visitsManager.showPlaceStatistics('${place._id}')">
                    View Statistics
                </button>
            </div>
        `);

        this.customPlacesLayer.addLayer(polygon);
        
        // Update visits table immediately after adding a place
        this.updateVisitsData();
    }

    async updateVisitsData() {
        const visitsData = [];
        const totalPlaces = this.places.size;
        let processedPlaces = 0;

        for (const [id, place] of this.places) {
            try {
                const progress = 90 + (processedPlaces / totalPlaces * 10);
                this.loadingManager.updateProgress(
                    progress, 
                    `Loading statistics for ${place.name} (${processedPlaces + 1}/${totalPlaces})...`
                );

                const response = await fetch(`/api/places/${id}/statistics`);
                const stats = await response.json();
                visitsData.push({
                    name: place.name,
                    totalVisits: stats.totalVisits,
                    lastVisit: stats.lastVisit,
                    avgTimeSpent: stats.averageTimeSpent
                });
                
                processedPlaces++;
            } catch (error) {
                console.error(`Error fetching statistics for place ${place.name}:`, error);
            }
        }

        // Update chart and table
        this.visitsChart.data.labels = visitsData.map(d => d.name);
        this.visitsChart.data.datasets[0].data = visitsData.map(d => d.totalVisits);
        this.visitsChart.update();

        this.visitsTable.clear().rows.add(visitsData).draw();
    }

    async savePlace() {
        const placeName = document.getElementById('place-name').value.trim();
        if (!placeName || !this.currentPolygon) return;

        const placeData = {
            name: placeName,
            geometry: this.currentPolygon.toGeoJSON().geometry
        };

        try {
            const response = await fetch('/api/places', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(placeData)
            });

            if (response.ok) {
                const savedPlace = await response.json();
                this.places.set(savedPlace._id, savedPlace);
                this.displayPlace(savedPlace);
                this.resetDrawing();
                this.updateVisitsData();
            }
        } catch (error) {
            console.error('Error saving place:', error);
        }
    }

    async deletePlace(placeId) {
        if (confirm('Are you sure you want to delete this place?')) {
            try {
                await fetch(`/api/places/${placeId}`, { method: 'DELETE' });
                this.places.delete(placeId);
                this.map.eachLayer(layer => {
                    if (layer.feature && layer.feature.properties.placeId === placeId) {
                        this.map.removeLayer(layer);
                    }
                });
                this.updateVisitsData();
            } catch (error) {
                console.error('Error deleting place:', error);
            }
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
        try {
            const response = await fetch(`/api/places/${placeId}/statistics`);
            const stats = await response.json();
            
            // Update the visits table with the new statistics
            const visitsData = [{
                name: this.places.get(placeId).name,
                totalVisits: stats.totalVisits,
                firstVisit: stats.firstVisit,
                lastVisit: stats.lastVisit,
                avgTimeSpent: stats.averageTimeSpent
            }];
            
            this.visitsTable.clear().rows.add(visitsData).draw();
        } catch (error) {
            console.error('Error fetching place statistics:', error);
        }
    }
}

// Initialize when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.visitsManager = new VisitsManager();
});