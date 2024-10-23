/* global $ */

let tripsTable = null;

document.addEventListener('DOMContentLoaded', () => {
    initializeDataTable();
    initializeEventListeners();
    fetchUniqueImeis();
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
            { data: 'destination', title: 'Destination' },
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

function fetchTrips() {
    const params = getFilterParams();
    const url = `/api/trips?${params.toString()}`;

    fetch(url)
        .then(response => response.json())
        .then(data => populateTripsTable(data.features))
        .catch(error => console.error('Error fetching trips:', error));
}

function populateTripsTable(trips) {
    const formattedTrips = trips.map(trip => ({
        ...trip.properties,
        gps: trip.geometry,
        destination: trip.properties.destination || 'N/A'
    }));
    tripsTable.clear().rows.add(formattedTrips).draw();
}

function fetchUniqueImeis() {
    fetch('/api/trips')
        .then(response => response.json())
        .then(geojson => populateUniqueImeis(geojson.features))
        .catch(error => console.error('Error fetching unique IMEIs:', error));
}

function populateUniqueImeis(features) {
    const imeis = [...new Set(features.map(trip => trip.properties.imei))];
    const imeiSelect = document.getElementById('imei');
    imeiSelect.innerHTML = '<option value="">All</option>';
    imeis.forEach(imei => {
        const option = document.createElement('option');
        option.value = imei;
        option.text = imei;
        imeiSelect.appendChild(option);
    });
}

function getFilterParams() {
    const params = new URLSearchParams();
    params.append('start_date', document.getElementById('start-date').value);
    params.append('end_date', document.getElementById('end-date').value);
    const imei = document.getElementById('imei').value;
    if (imei) params.append('imei', imei);
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
