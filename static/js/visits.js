class VisitsManager {
    constructor() {
        this.map = null;
        this.places = new Map();
        this.drawControl = null;
        this.currentPolygon = null;
        this.visitsChart = null;
        this.visitsTable = null;

        this.initializeMap();
        this.initializeDrawControls();
        this.initializeChart();
        this.initializeTable();
        this.setupEventListeners();
        this.loadPlaces();
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
                { data: 'lastVisit', render: data => new Date(data).toLocaleDateString() },
                { data: 'avgTimeSpent' }  // Remove the render function since we're getting formatted string
            ]
        });
    }

    setupEventListeners() {
        document.getElementById('start-drawing').addEventListener('click', () => this.startDrawing());
        document.getElementById('save-place').addEventListener('click', () => this.savePlace());
        
        this.map.on(L.Draw.Event.CREATED, (e) => {
            this.currentPolygon = e.layer;
            this.map.addLayer(this.currentPolygon);
            document.getElementById('save-place').disabled = false;
        });
    }

    async loadPlaces() {
        try {
            const response = await fetch('/api/places');
            const places = await response.json();
            
            places.forEach(place => {
                this.places.set(place._id, place);
                this.displayPlace(place);
            });
            
            this.updateVisitsData();
        } catch (error) {
            console.error('Error loading places:', error);
        }
    }

    displayPlace(place) {
        const polygon = L.geoJSON(place.geometry, {
            style: {
                color: '#BB86FC',
                fillColor: '#BB86FC',
                fillOpacity: 0.2
            }
        }).addTo(this.map);

        polygon.bindPopup(`
            <div class="place-popup">
                <h6>${place.name}</h6>
                <button class="btn btn-sm btn-info" onclick="visitsManager.showPlaceStatistics('${place._id}')">
                    View Statistics
                </button>
                <button class="btn btn-sm btn-danger" onclick="visitsManager.deletePlace('${place._id}')">
                    Delete
                </button>
            </div>
        `);
    }

    async updateVisitsData() {
        const visitsData = [];
        for (const [id, place] of this.places) {
            try {
                const response = await fetch(`/api/places/${id}/statistics`);
                const stats = await response.json();
                visitsData.push({
                    name: place.name,
                    totalVisits: stats.totalVisits,
                    lastVisit: stats.lastVisit,
                    avgTimeSpent: stats.averageTimeSpent
                });
            } catch (error) {
                console.error(`Error fetching statistics for place ${place.name}:`, error);
            }
        }

        // Update chart
        this.visitsChart.data.labels = visitsData.map(d => d.name);
        this.visitsChart.data.datasets[0].data = visitsData.map(d => d.totalVisits);
        this.visitsChart.update();

        // Update table
        this.visitsTable.clear().rows.add(visitsData).draw();
    }

    startDrawing() {
        this.map.addControl(this.drawControl);
        new L.Draw.Polygon(this.map).enable();
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
}

// Initialize when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.visitsManager = new VisitsManager();
});