document.addEventListener('DOMContentLoaded', () => {
    const exportTripsForm = document.getElementById('export-trips-form');
    const exportMatchedTripsForm = document.getElementById('export-matched-trips-form');
    const exportStreetsForm = document.getElementById('export-streets-form');
    const exportBoundaryForm = document.getElementById('export-boundary-form');

    if (exportTripsForm) {
        exportTripsForm.addEventListener('submit', (e) => {
            e.preventDefault();
            exportTrips();
        });
    }

    if (exportMatchedTripsForm) {
        exportMatchedTripsForm.addEventListener('submit', (e) => {
            e.preventDefault();
            exportMatchedTrips();
        });
    }

    if (exportStreetsForm) {
        exportStreetsForm.addEventListener('submit', (e) => {
            e.preventDefault();
            exportStreets();
        });
    }

    if (exportBoundaryForm) {
        exportBoundaryForm.addEventListener('submit', (e) => {
            e.preventDefault();
            exportBoundary();
        });
    }
});

function exportTrips() {
    const startDate = document.getElementById('trips-start-date').value;
    const endDate = document.getElementById('trips-end-date').value;
    const format = document.getElementById('trips-format').value;

    const url = `/api/export/trips?start_date=${startDate}&end_date=${endDate}&format=${format}`;
    downloadFile(url, `trips.${format}`);
}

function exportMatchedTrips() {
    const startDate = document.getElementById('matched-trips-start-date').value;
    const endDate = document.getElementById('matched-trips-end-date').value;
    const format = document.getElementById('matched-trips-format').value;

    const url = `/api/export/matched_trips?start_date=${startDate}&end_date=${endDate}&format=${format}`;
    downloadFile(url, `matched_trips.${format}`);
}

function exportStreets() {
    const location = document.getElementById('streets-location').value;
    const format = document.getElementById('streets-format').value;

    // Validate location input
    if (!location) {
        alert('Please enter a location.');
        return;
    }

    const url = `/api/export/streets?location=${encodeURIComponent(JSON.stringify(location))}&format=${format}`;
    downloadFile(url, `streets.${format}`);
}

function exportBoundary() {
    const location = document.getElementById('boundary-location').value;
    const format = document.getElementById('boundary-format').value;

    // Validate location input
    if (!location) {
        alert('Please enter a location.');
        return;
    }

    const url = `/api/export/boundary?location=${encodeURIComponent(JSON.stringify(location))}&format=${format}`;
    downloadFile(url, `boundary.${format}`);
}

function downloadFile(url, filename) {
    fetch(url)
        .then(response => {
            if (!response.ok) {
                throw new Error('Network response was not ok');
            }
            return response.blob();
        })
        .then(blob => {
            const blobUrl = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(blobUrl);
        })
        .catch(error => {
            console.error('Error downloading file:', error);
            alert('An error occurred while downloading the file. Please try again.');
        });
}
