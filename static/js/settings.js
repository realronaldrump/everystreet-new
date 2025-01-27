document.addEventListener('DOMContentLoaded', () => {
    const loadHistoricalDataBtn = document.getElementById('load-historical-data');
    const updateGeoPointsBtn = document.getElementById('update-geo-points');
    const collectionSelect = document.getElementById('collection-select');
    const updateStatus = document.getElementById('update-geo-points-status');
    const regeocodeAllTripsBtn = document.getElementById('re-geocode-all-trips');
    const regeocodeStatus = document.getElementById('re-geocode-all-trips-status');

    if (loadHistoricalDataBtn) {
        loadHistoricalDataBtn.addEventListener('click', loadHistoricalData);
    }

    if (updateGeoPointsBtn) {
        updateGeoPointsBtn.addEventListener('click', () => {
            const selectedCollection = collectionSelect.value;
            updateGeoPoints(selectedCollection);
        });
    }

    if (regeocodeAllTripsBtn) {
        regeocodeAllTripsBtn.addEventListener('click', () => {
            regeocodeStatus.textContent = 'Re-geocoding all trips... This may take a while.';
            regeocodeAllTrips()
                .then(() => {
                    regeocodeStatus.textContent = 'All trips have been re-geocoded.';
                })
                .catch((error) => {
                    console.error('Error re-geocoding trips:', error);
                    regeocodeStatus.textContent = 'Error re-geocoding trips. See console for details.';
                });
        });
    }
});

function loadHistoricalData() {
    const sd = localStorage.getItem('startDate');
    const ed = localStorage.getItem('endDate');
    if (!sd || !ed) {
        alert('Select start and end dates in the sidebar.');
        return;
    }
    showLoadingOverlay();

    fetch('/load_historical_data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_date: sd, end_date: ed })
    })
    .then((r) => {
        if (!r.ok) throw new Error(`HTTP error: ${r.status}`);
        return r.json();
    })
    .then((data) => {
        alert(data.message);
        if (window.EveryStreet && window.EveryStreet.Map) {
            window.EveryStreet.Map.fetchTrips();
        }
    })
    .catch((err) => {
        console.error('Error loading historical data:', err);
        alert('Error loading historical data. Check console.');
    })
    .finally(hideLoadingOverlay);
}

function updateGeoPoints(collectionName) {
    updateStatus.textContent = 'Updating...';
    fetch('/update_geo_points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: collectionName })
    })
    .then(response => {
        if (!response.ok) {
            throw new Error('Network response was not ok');
        }
        return response.json();
    })
    .then(data => {
        updateStatus.textContent = data.message;
    })
    .catch(error => {
        console.error('Error:', error);
        updateStatus.textContent = 'Error updating GeoPoints.';
    });
}

async function regeocodeAllTrips() {
    const response = await fetch('/api/regeocode_all_trips', {
        method: 'POST',
    });

    if (!response.ok) {
        throw new Error('Network response was not ok');
    }

    return response.json();
}