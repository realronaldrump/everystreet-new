/* global $ */

let tripsTable = null;

document.addEventListener('DOMContentLoaded', () => {
    initializeDataTable();
    addCheckboxEventListeners();
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
            {
                data: null,
                orderable: false,
                className: 'select-checkbox',
                render: function() {
                    return '<input type="checkbox" class="trip-checkbox">';
                }
            },
            { data: 'transactionId', title: 'Transaction ID' },
            { data: 'imei', title: 'IMEI' },
            { data: 'startTime', title: 'Start Time', render: formatDateTime },
            { data: 'endTime', title: 'End Time', render: formatDateTime },
            { data: 'distance', title: 'Distance (miles)', render: formatDistance },
            { data: 'destination', title: 'Destination', render: formatDestination },
            { data: 'startLocation', title: 'Start Location' },
            {
                data: null,
                orderable: false,
                render: function(data) {
                    return '<button class="btn btn-sm btn-danger delete-trip" data-id="' + data.transactionId + '">Delete</button>';
                }
            }
        ],
        order: [[2, 'desc']]
    });
}

function formatDateTime(data, type, row) {
    if (type === 'display' || type === 'filter') {
        // Parse the date string; it includes timezone info
        const date = new Date(data);
        const timezone = row.timezone || 'America/Chicago';

        // Use Intl.DateTimeFormat for formatting the date in the correct timezone
        const formatter = new Intl.DateTimeFormat('en-US', {
            dateStyle: 'short',
            timeStyle: 'short',
            timeZone: timezone,
            hour12: true
        });

        return formatter.format(date);
    }
    return data;
}

function formatDistance(data, type) {
    if (type === 'display') {
        const distance = parseFloat(data);
        return isNaN(distance) ? '0.00' : distance.toFixed(2);
    }
    return data;
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
    
    return fetch(url)
        .then(response => response.json())
        .then(data => {
            return populateTripsTable(data.features);
        })
        .catch(error => {
            console.error('Error fetching trips:', error);
            throw error;
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
            distance: trip.properties.distance ? parseFloat(trip.properties.distance) : 0
        }));

    tripsTable.clear().rows.add(formattedTrips).draw();
}

function getFilterParams() {
    const params = new URLSearchParams();
    params.append('start_date', document.getElementById('start-date').value);
    params.append('end_date', document.getElementById('end-date').value);
    return params;
}

function addCheckboxEventListeners() {
    const selectAllCheckbox = document.getElementById('select-all-trips');
    const bulkDeleteBtn = document.getElementById('bulk-delete-trips-btn');

    selectAllCheckbox.addEventListener('change', function() {
        const checkboxes = document.querySelectorAll('.trip-checkbox');
        checkboxes.forEach(cb => cb.checked = this.checked);
        updateBulkDeleteButtonState();
    });

    document.addEventListener('change', function(e) {
        if (e.target.classList.contains('trip-checkbox')) {
            const allCheckboxes = document.querySelectorAll('.trip-checkbox');
            const allChecked = Array.from(allCheckboxes).every(cb => cb.checked);
            selectAllCheckbox.checked = allChecked;
            updateBulkDeleteButtonState();
        }
    });

    bulkDeleteBtn.addEventListener('click', bulkDeleteTrips);
}

function updateBulkDeleteButtonState() {
    const selectedCheckboxes = document.querySelectorAll('.trip-checkbox:checked');
    const bulkDeleteBtn = document.getElementById('bulk-delete-trips-btn');
    bulkDeleteBtn.disabled = selectedCheckboxes.length === 0;
}

function bulkDeleteTrips() {
    const selectedRows = tripsTable.rows().nodes().filter(node => 
        node.querySelector('.trip-checkbox:checked')
    );
    
    const tripIds = Array.from(selectedRows).map(row => 
        tripsTable.row(row).data().transactionId
    );

    if (!confirm(`Are you sure you want to delete ${tripIds.length} selected trips?`)) {
        return;
    }

    deleteTrips(tripIds);
}

function deleteTrips(tripIds) {
    fetch('/api/trips/bulk_delete', {
        method: 'DELETE',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ trip_ids: tripIds })
    })
    .then(response => response.json())
    .then(data => {
        if (data.status === 'success') {
            fetchTrips(); // Refresh the table
            alert(`Successfully deleted ${tripIds.length} trips`);
        } else {
            alert('Error deleting trips: ' + data.message);
        }
    })
    .catch(error => {
        console.error('Error deleting trips:', error);
        alert('An error occurred while deleting trips');
    });
}

// Add event listener for individual delete buttons
$('#trips-table').on('click', '.delete-trip', function() {
    const tripId = $(this).data('id');
    if (confirm('Are you sure you want to delete this trip?')) {
        deleteTrips([tripId]);
    }
});

function initializeEventListeners() {
    const applyFilters = document.getElementById('apply-filters');
    if (applyFilters) {
        applyFilters.addEventListener('click', fetchTrips);
    }

    // Add date preset functionality
    document.querySelectorAll('.date-preset').forEach(button => {
        button.addEventListener('click', () => {
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
                            
                            // Instead of calling fetchTrips directly, call the main app's fetchTrips
                            window.EveryStreet.fetchTrips();
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

            // Instead of calling fetchTrips directly, call the main app's fetchTrips
            window.EveryStreet.fetchTrips();
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
