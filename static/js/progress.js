    /* global L, map, mapLayers, layerGroup */
document.addEventListener('DOMContentLoaded', () => {
    initializeMap();
    // fetchProgress(); // We'll call this after the user selects an area
    // fetchAndRenderStreets(); // We'll call this after the user selects an area

    let drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    const drawControl = new L.Control.Draw({
        draw: {
            polyline: false,
            rectangle: true, // Allow rectangle drawing
            circle: false,
            marker: false,
            circlemarker: false,
            polygon: true // Allow polygon drawing
        },
        edit: {
            featureGroup: drawnItems
        }
    });
    map.addControl(drawControl);

    let selectedArea = null;

    map.on(L.Draw.Event.CREATED, function (event) {
        const layer = event.layer;

        // Clear any existing drawings
        drawnItems.clearLayers();

        drawnItems.addLayer(layer);
        selectedArea = layer.toGeoJSON();

        // Fetch progress and streets once the area is selected
        fetchProgress(selectedArea);
        fetchAndRenderStreets(selectedArea);
    });

    function fetchProgress(areaGeoJSON) {
        fetch('/api/progress', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ location: areaGeoJSON })
        })
        .then(response => response.json())
        .then(data => {
            if (data.status === 'success') {
                displayProgress(data);
            } else {
                console.error('Error fetching progress:', data.message);
                alert('Error fetching progress: ' + data.message);
            }
        })
        .catch(error => {
            console.error('Error:', error);
            alert('An error occurred while fetching progress.');
        });
    }

    function fetchAndRenderStreets(areaGeoJSON) {
        fetch('/api/streets', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ location: areaGeoJSON })
        })
        .then(response => response.json())
        .then(streetsGeoJSON => {
            renderStreetsOnMap(streetsGeoJSON);
        })
        .catch(error => {
            console.error('Error fetching streets:', error);
        });
    }

    function displayProgress(data) {
        const progressElement = document.getElementById('progress-percentage');
        progressElement.textContent = `${data.progress.toFixed(2)}%`;

        const drivenStreetsElement = document.getElementById('driven-streets');
        drivenStreetsElement.textContent = data.driven_streets;

        const totalStreetsElement = document.getElementById('total-streets');
        totalStreetsElement.textContent = data.total_streets;
    }

    function renderStreetsOnMap(streetsGeoJSON) {
        if (mapLayers.streetsLayer) {
            layerGroup.removeLayer(mapLayers.streetsLayer);
        }

        mapLayers.streetsLayer = L.geoJSON(streetsGeoJSON, {
            style: function(feature) {
                return {
                    color: feature.properties.driven ? '#00FF00' : '#FF0000',
                    weight: 2,
                    opacity: 0.7
                };
            }
        }).addTo(layerGroup);

        // Fit map to the streets layer
        map.fitBounds(mapLayers.streetsLayer.getBounds());
    }
});
