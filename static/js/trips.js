/* global $ */

let tripsTable = null;

document.addEventListener('DOMContentLoaded', () => {
    initializeDataTable();
    initializeEventListeners();
    fetchTrips();
});

function initializeDataTable() {
    if (!$.fn.DataTable) {
        console.error('DataTables library is missing');
        return;
    }
    tripsTable = $('#trips-table').DataTable({
        responsive: true,
        scrollX: true,
        pageLength: 25,
        dom: 'Bfrtip',
        buttons: ['colvis'],
        columns: [
            { data: 'transactionId', title: 'Transaction ID' },
            { data: 'imei', title: 'IMEI' },
            { data: 'startTime', title: 'Start Time', render: formatDateTime },
            { data: 'endTime', title: 'End Time', render: formatDateTime },
            { data: 'distance', title: 'Distance (miles)', render: formatDistance },
            { data: 'destination', title: 'Destination', render: formatDestination },
            { data: 'startLocation', title: 'Start Location' }
        ],
        order: [[2, 'desc']]
    });
}

function formatDateTime(data, type, row) {
    if (type === 'display' || type === 'filter') {
        const date = new Date(data);
        return date.toLocaleString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: row.timezone });
    }
    return data;
}

function formatDistance(data, type) {
    return type === 'display' ? parseFloat(data).toFixed(2) : data;
}

function formatDestination(data, type, row) {
    if (type === 'display') {
        return `${data} ${row.isCustomPlace ? '<span class="badge bg-primary">Custom Place</span>' : ''}`;
    }
    return data;
}

function fetchTrips() {
    const params = getFilterParams();
    const url = `/api/trips?${params.toString()}`;

    showLoadingOverlay('Loading trips');
    
    fetch(url)
        .then(response => response.json())
        .then(data => {
            updateLoadingProgress(30, 'Processing trips');
            return populateTripsTable(data.features);
        })
        .then(() => {
            updateLoadingProgress(60, 'Updating map');
            // Emit a custom event to notify app.js that trips are loaded
            const event = new CustomEvent('tripsLoaded', { detail: { status: 'success' } });
            document.dispatchEvent(event);
        })
        .catch(error => {
            console.error('Error fetching trips:', error);
            const event = new CustomEvent('tripsLoaded', { detail: { status: 'error' } });
            document.dispatchEvent(event);
        });
}

function populateTripsTable(trips) {
    const formattedTrips = trips
        .filter(trip => trip.properties.imei !== 'HISTORICAL')
        .map(trip => ({
            ...trip.properties,
            gps: trip.geometry,
            destination: trip.properties.destination || 'N/A',
            isCustomPlace: trip.properties.isCustomPlace || false,
            distance: parseFloat(trip.distance).toFixed(2)
        }));

    tripsTable.clear().rows.add(formattedTrips).draw();
}

function getFilterParams() {
    const params = new URLSearchParams();
    params.append('start_date', document.getElementById('start-date').value);
    params.append('end_date', document.getElementById('end-date').value);
    return params;
}

function initializeEventListeners() {
    const applyFilters = document.getElementById('apply-filters');
    if (applyFilters) {
        applyFilters.addEventListener('click', fetchTrips);
    }

    // Add date preset functionality
    document.querySelectorAll('.date-preset').forEach(button => {
        button.addEventListener('click', function() {
            const range = this.dataset.range;
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            let startDate = new Date(today);
            let endDate = new Date(today);

            switch(range) {
                case 'today':
                    break;
                case 'yesterday':
                    startDate.setDate(startDate.getDate() - 1);
                    endDate.setDate(endDate.getDate() - 1);
                    break;
                case 'last-week':
                    startDate.setDate(startDate.getDate() - 7);
                    break;
                case 'last-month':
                    startDate.setDate(startDate.getDate() - 30);
                    break;
                case 'last-6-months':
                    startDate.setMonth(startDate.getMonth() - 6);
                    break;
                case 'last-year':
                    startDate.setFullYear(startDate.getFullYear() - 1);
                    break;
                case 'all-time':
                    // Get first trip's date from API
                    fetch('/api/first_trip_date')
                        .then(response => response.json())
                        .then(data => {
                            startDate = new Date(data.first_trip_date);
                            const startDatePicker = document.getElementById('start-date')._flatpickr;
                            const endDatePicker = document.getElementById('end-date')._flatpickr;
                            
                            startDatePicker.setDate(startDate);
                            endDatePicker.setDate(endDate);
                            
                            // Store the new dates in localStorage
                            localStorage.setItem('startDate', startDate.toISOString().split('T')[0]);
                            localStorage.setItem('endDate', endDate.toISOString().split('T')[0]);
                            
                            // Fetch new data
                            fetchTrips();
                        })
                        .catch(error => {
                            console.error('Error fetching first trip date:', error);
                        });
                    return; // Exit the switch statement early since we're handling the update in the promise
            }

            // Update the flatpickr instances
            const startDatePicker = document.getElementById('start-date')._flatpickr;
            const endDatePicker = document.getElementById('end-date')._flatpickr;
            
            startDatePicker.setDate(startDate);
            endDatePicker.setDate(endDate);

            // Store the new dates in localStorage
            localStorage.setItem('startDate', startDate.toISOString().split('T')[0]);
            localStorage.setItem('endDate', endDate.toISOString().split('T')[0]);

            // Fetch new data
            fetchTrips();
        });
    });

    // Keep existing export button listeners
    const exportGeojson = document.getElementById('export-geojson');
    const exportGpx = document.getElementById('export-gpx');
    if (exportGeojson) {
        exportGeojson.addEventListener('click', () => exportTrips('geojson'));
    }
    if (exportGpx) {
        exportGpx.addEventListener('click', () => exportTrips('gpx'));
    }
}

function exportTrips(format) {
    const params = getFilterParams();
    const url = `/api/export/trips?${params.toString()}&format=${format}`;
    downloadFile(url, `trips.${format}`);
}

function downloadFile(url, filename) {
    fetch(url)
        .then(response => response.blob())
        .then(blob => {
            const blobUrl = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = blobUrl;
            anchor.download = filename;
            anchor.click();
            URL.revokeObjectURL(blobUrl);
        })
        .catch(error => console.error('Error downloading file:', error));
}
