/* global L, EveryStreet, LoadingManager */

// Global variables
let tripsTable = null;

// Initialize everything when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    initializeDatePickers();
    initializeEventListeners();
    initializeTripsTable();
    fetchTrips(); // Initial load
});

function initializeDatePickers() {
    const startDate = document.getElementById('start-date');
    const endDate = document.getElementById('end-date');

    if (startDate && endDate) {
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1);

        // Get dates from localStorage or use today
        const storedStartDate = localStorage.getItem('startDate');
        const storedEndDate = localStorage.getItem('endDate');

        startDate.max = tomorrow.toISOString().split('T')[0];
        endDate.max = tomorrow.toISOString().split('T')[0];

        startDate.value = storedStartDate || today.toISOString().split('T')[0];
        endDate.value = storedEndDate || today.toISOString().split('T')[0];

        // Store dates if not already stored
        if (!storedStartDate || !storedEndDate) {
            localStorage.setItem('startDate', today.toISOString().split('T')[0]);
            localStorage.setItem('endDate', today.toISOString().split('T')[0]);
        }
    }
}

function initializeEventListeners() {
    // Apply filters button
    const applyFiltersButton = document.getElementById('apply-filters');
    if (applyFiltersButton) {
        applyFiltersButton.addEventListener('click', () => {
            const startDate = document.getElementById('start-date').value;
            const endDate = document.getElementById('end-date').value;

            localStorage.setItem('startDate', startDate);
            localStorage.setItem('endDate', endDate);

            fetchTrips();
        });
    }

    // Date preset buttons
    document.querySelectorAll('.date-preset').forEach((button) => {
        button.addEventListener('click', function() {
            const range = this.dataset.range;
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            let startDate = new Date(today);
            let endDate = new Date(today);

            switch (range) {
                case 'today':
                    break;
                case 'yesterday':
                    startDate.setDate(startDate.getDate() - 1);
                    // endDate stays as today
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
                    fetch('/api/first_trip_date')
                        .then((response) => response.json())
                        .then((data) => {
                            startDate = new Date(data.first_trip_date);
                            updateDatesAndFetch(startDate, endDate);
                        })
                        .catch((error) => {
                            console.error('Error fetching first trip date:', error);
                        });
                    return;
            }

            updateDatesAndFetch(startDate, endDate);
        });
    });

    // Add bulk delete button listener
    const bulkDeleteBtn = document.getElementById('bulk-delete-trips-btn');
    if (bulkDeleteBtn) {
        bulkDeleteBtn.addEventListener('click', bulkDeleteTrips);
    }

    // Add refresh geocoding button listener
    const refreshGeocodingBtn = document.getElementById('refresh-geocoding-btn');
    if (refreshGeocodingBtn) {
        refreshGeocodingBtn.addEventListener('click', refreshGeocoding);
    }

    // Add to initializeEventListeners function
    $('#trips-table').on('click', '.edit-trip-btn', function(e) {
        e.preventDefault();
        const row = $(this).closest('tr');
        row.addClass('editing');

        // Show edit inputs, hide display values
        row.find('.display-value').addClass('d-none');
        row.find('.edit-input').removeClass('d-none');

        // Show edit actions, hide regular actions
        row.find('.btn-group').addClass('d-none');
        row.find('.edit-actions').removeClass('d-none');
    });

    $('#trips-table').on('click', '.cancel-edit-btn', function() {
        const row = $(this).closest('tr');
        row.removeClass('editing');

        // Reset values to original
        const rowData = tripsTable.row(row).data();
        row.find('.edit-input').each(function() {
            const field = $(this).closest('.editable-cell').data('field');
            $(this).val(rowData[field]);
        });

        // Hide edit inputs, show display values
        row.find('.display-value').removeClass('d-none');
        row.find('.edit-input').addClass('d-none');

        // Show regular actions, hide edit actions
        row.find('.btn-group').removeClass('d-none');
        row.find('.edit-actions').addClass('d-none');
    });

    $('#trips-table').on('click', '.save-changes-btn', async function() {
        const row = $(this).closest('tr');
        const rowData = tripsTable.row(row).data();
        const updatedData = {
            ...rowData
        };
    
        // Collect updated values
        row.find('.edit-input').each(function() {
            const field = $(this).closest('.editable-cell').data('field');
            let value = $(this).val();
    
            // Handle datetime fields
            if (field === 'startTime' || field === 'endTime') {
                const localDate = new Date(value);
                value = localDate.toISOString();
            }
            updatedData[field] = value;
        });
    
        try {
            // Get the correct trip ID
            let tripId;
            if (rowData.properties?.transactionId) {
                tripId = rowData.properties.transactionId;
            } else if (rowData.transactionId) {
                tripId = rowData.transactionId;
            } else {
                throw new Error('Could not determine trip ID');
            }
    
            // Prepare the update data
            const updatePayload = {
                type: 'trips',
                properties: {
                    ...updatedData,
                    transactionId: tripId
                }
            };
    
            // If there's existing geometry, include it
            if (rowData.geometry || rowData.gps) {
                updatePayload.geometry = rowData.geometry || rowData.gps;
            }
    
            const response = await fetch(`/api/trips/${tripId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(updatePayload)
            });
    
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to update trip');
            }
    
            // Update the table data
            tripsTable.row(row).data(updatedData).draw();
    
            // Exit edit mode
            row.removeClass('editing');
            row.find('.display-value').removeClass('d-none');
            row.find('.edit-input').addClass('d-none');
            row.find('.btn-group').removeClass('d-none');
            row.find('.edit-actions').addClass('d-none');
    
            showNotification('Trip updated successfully', 'success');
        } catch (error) {
            console.error('Error updating trip:', error);
            showNotification(error.message || 'Failed to update trip', 'danger');
        }
    });
}

function updateDatesAndFetch(startDate, endDate) {
	const startDateStr = startDate.toISOString().split('T')[0];
	const endDateStr = endDate.toISOString().split('T')[0];

	// Update input values
	document.getElementById('start-date').value = startDateStr;
	document.getElementById('end-date').value = endDateStr;

	// Store in localStorage
	localStorage.setItem('startDate', startDateStr);
	localStorage.setItem('endDate', endDateStr);

	// Fetch new data
	fetchTrips();
}

function initializeTripsTable() {
    tripsTable = $('#trips-table').DataTable({
        responsive: true,
        order: [[3, 'desc']], // Sort by start time by default
        columns: [
            {
                data: null,
                orderable: false,
                className: 'select-checkbox',
                render: function() {
                    return '<input type="checkbox" class="trip-checkbox">';
                }
            },
            {
                data: 'transactionId',
                title: 'Transaction ID',
                render: function(data, type) {
                    return createEditableCell(data, type, 'transactionId');
                }
            },
            {
                data: 'imei',
                title: 'IMEI',
                render: function(data, type) {
                    return createEditableCell(data, type, 'imei');
                }
            },
            {
                data: 'startTime',
                title: 'Start Time',
                render: function(data, type, row) {
                    if (type === 'display') {
                        return createEditableCell(data, type, 'startTime', 'datetime-local');
                    }
                    return data;
                }
            },
            {
                data: 'endTime',
                title: 'End Time',
                render: function(data, type, row) {
                    if (type === 'display') {
                        return createEditableCell(data, type, 'endTime', 'datetime-local');
                    }
                    return data;
                }
            },
            {
                data: 'distance',
                title: 'Distance (miles)',
                render: function(data, type) {
                    return createEditableCell(data, type, 'distance', 'number');
                }
            },
            {
                data: 'startLocation',
                title: 'Start Location',
                render: function(data, type) {
                    return createEditableCell(data, type, 'startLocation');
                }
            },
            {
                data: 'destination',
                title: 'Destination',
                render: function(data, type) {
                    return createEditableCell(data, type, 'destination');
                }
            },
            {
                data: 'maxSpeed',
                title: 'Max Speed (mph)',
                render: function(data, type) {
                    return createEditableCell(data, type, 'maxSpeed', 'number');
                }
            },
            {
                data: 'totalIdleDurationFormatted',
                title: 'Idle Duration',
                render: function(data, type, row) {
                    if (type === 'display') {
                        return createEditableCell(data, type, 'totalIdleDurationFormatted', 'text');
                    }
                    return data;
                }
            },
            {
                data: 'fuelConsumed',
                title: 'Fuel Consumed (gal)',
                render: function(data, type) {
                    return createEditableCell(data, type, 'fuelConsumed', 'number');
                }
            },
            {
                data: null,
                title: 'Actions',
                orderable: false,
                render: function(data, type, row) {
                    return `
                        <div class="btn-group">
                            <button type="button" class="btn btn-sm btn-primary dropdown-toggle" data-bs-toggle="dropdown" aria-expanded="false">
                                Actions
                            </button>
                            <ul class="dropdown-menu dropdown-menu-dark">
                                <li><a class="dropdown-item" href="#" onclick="exportTrip('${row.transactionId}', 'geojson')">Export GeoJSON</a></li>
                                <li><a class="dropdown-item" href="#" onclick="exportTrip('${row.transactionId}', 'gpx')">Export GPX</a></li>
                                <li><a class="dropdown-item edit-trip-btn" href="#" data-trip-id="${row.transactionId}">Edit</a></li>
                                <li><hr class="dropdown-divider"></li>
                                <li><a class="dropdown-item text-danger" href="#" onclick="EveryStreet.Trips.deleteTrip('${row.transactionId}');">Delete</a></li>
                            </ul>
                        </div>
                        <div class="edit-actions d-none">
                            <button class="btn btn-sm btn-success save-changes-btn">Save</button>
                            <button class="btn btn-sm btn-danger cancel-edit-btn">Cancel</button>
                        </div>
                    `;
                }
            }
        ],
        language: {
            emptyTable: "No trips found in the selected date range"
        }
    });

    // Add bulk delete functionality
    $('#select-all-trips').on('change', function() {
        $('.trip-checkbox').prop('checked', this.checked);
        updateBulkDeleteButton();
    });

    $('#trips-table').on('change', '.trip-checkbox', function() {
        updateBulkDeleteButton();
    });

    // Make the table globally accessible
    window.tripsTable = tripsTable;
}

function updateBulkDeleteButton() {
    const checkedCount = $('.trip-checkbox:checked').length;
    $('#bulk-delete-trips-btn').prop('disabled', checkedCount === 0);
}

// Add this function to handle bulk delete
function bulkDeleteTrips() {
    const selectedTrips = [];
    $('.trip-checkbox:checked').each(function() {
        const rowData = tripsTable.row($(this).closest('tr')).data();
        selectedTrips.push(rowData.transactionId);
    });

    if (selectedTrips.length === 0) {
        showNotification('No trips selected for deletion.', 'warning');
        return;
    }

    if (confirm(`Are you sure you want to delete ${selectedTrips.length} trip(s)?`)) {
        // Implement the bulk delete API call here
        fetch('/api/trips/bulk_delete', {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                trip_ids: selectedTrips
            })
        })
        .then(response => response.json())
        .then(data => {
            if (data.status === 'success') {
                showNotification(`Successfully deleted ${data.deleted_count} trip(s).`, 'success');
                fetchTrips();
            } else {
                showNotification(`Error deleting trip(s): ${data.message}`, 'danger');
                console.error('Error deleting trip(s):', data.message);
            }
        })
        .catch(error => {
            console.error('Error deleting trips:', error);
            showNotification('Error deleting trip(s). Please try again.', 'danger');
        });
    }
}

// Add this function to handle refreshing geocoding
async function refreshGeocoding() {
    const selectedTrips = [];
    $('.trip-checkbox:checked').each(function() {
        const rowData = tripsTable.row($(this).closest('tr')).data();
        selectedTrips.push(rowData.transactionId);
    });

    if (selectedTrips.length === 0) {
        showNotification('No trips selected to refresh.', 'warning');
        return;
    }

    if (confirm(`Are you sure you want to refresh geocoding for ${selectedTrips.length} trip(s)?`)) {
        try {
            const response = await fetch('/api/trips/refresh_geocoding', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    trip_ids: selectedTrips
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || 'Failed to refresh geocoding');
            }

            const data = await response.json();
            showNotification(`Successfully refreshed geocoding for ${data.updated_count} trip(s).`, 'success');
            fetchTrips(); // Refresh the trips table
        } catch (error) {
            console.error('Error refreshing geocoding:', error);
            showNotification(error.message || 'Error refreshing geocoding. Please try again.', 'danger');
        }
    }
}

function formatDateTime(data, type, row) {
    if (type === 'display' || type === 'filter') {
        const date = new Date(data);
        const timezone = row.timeZone || 'America/Chicago'; // Use the timezone from the row

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

function getFilterParams() {
    const params = new URLSearchParams();
    const startDate = localStorage.getItem('startDate') || document.getElementById('start-date').value;
    const endDate = localStorage.getItem('endDate') || document.getElementById('end-date').value;

    params.append('start_date', startDate);
    params.append('end_date', endDate);

    return params;
}

async function fetchTrips() {
    try {
        const params = getFilterParams();
        const url = `/api/trips?${params.toString()}`;

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (!data.features || !Array.isArray(data.features)) {
            console.warn('No trips data received or invalid format');
            tripsTable.clear().draw();
            return;
        }

        const formattedTrips = data.features
            .map(trip => ({
                ...trip.properties,
                gps: trip.geometry,
                destination: trip.properties.destination || 'N/A',
                isCustomPlace: trip.properties.isCustomPlace || false,
                distance: parseFloat(trip.properties.distance).toFixed(2),
                maxSpeed: trip.properties.maxSpeed || (trip.properties.endLocation?.obdMaxSpeed || 0),
                totalIdleDuration: trip.properties.totalIdleDuration || (trip.properties.idle?.length || 0) * 60, // Convert idle events to duration
                fuelConsumed: trip.properties.fuelConsumed || 0
            }));

        await new Promise((resolve) => {
            tripsTable.clear().rows.add(formattedTrips).draw();
            setTimeout(resolve, 100);
        });

    } catch (error) {
        console.error('Error fetching trips:', error);
        alert('Error loading trips. Please try again.');
    }
}

function showNotification(message, type = 'info') {
	const notificationDiv = document.createElement('div');
	notificationDiv.className = `alert alert-${type} alert-dismissible fade show`;
	notificationDiv.innerHTML = `
        ${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
    `;

	// Find or create notification container
	let notificationContainer = document.querySelector('.notification-container');
	if (!notificationContainer) {
		notificationContainer = document.createElement('div');
		notificationContainer.className = 'notification-container position-fixed top-0 end-0 p-3';
		document.body.appendChild(notificationContainer);
	}

	notificationContainer.appendChild(notificationDiv);

	// Auto-dismiss after 5 seconds
	setTimeout(() => {
		notificationDiv.remove();
	}, 5000);
}

function createEditableCell(data, type, field, inputType = 'text') {
    if (type === 'display') {
        let displayValue = data || '';

        // Format displayValue for specific fields
        if ((field === 'startTime' || field === 'endTime') && data) {
            const date = new Date(data);
            const formatter = new Intl.DateTimeFormat('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            });
            displayValue = formatter.format(date);
        } else if ((field === 'distance' || field === 'maxSpeed' || field === 'fuelConsumed') && data) {
            displayValue = parseFloat(data).toFixed(2);
        } else if (field === 'totalIdleDuration' && data) {
            displayValue = (parseFloat(data) / 60).toFixed(2);
        }

        let inputValue = (field === 'startTime' || field === 'endTime') && data ?
            new Date(data).toISOString().slice(0, 16) : // Format: YYYY-MM-DDTHH:mm
            displayValue;

        return `
            <div class="editable-cell" data-field="${field}">
                <span class="display-value">${displayValue}</span>
                <input type="${inputType}" class="form-control edit-input d-none" value="${inputValue}" />
            </div>
        `;
    }
    return data;
}

// Export necessary functions for global access
window.EveryStreet = window.EveryStreet || {};
window.EveryStreet.Trips = {
    fetchTrips,
    updateDatesAndFetch,
    getFilterParams,
    createEditableCell,
    deleteTrip: function(tripId) {
        if (confirm('Are you sure you want to delete this trip?')) {
            fetch(`/api/trips/${tripId}`, {
                method: 'DELETE'
            })
            .then(response => {
                if (!response.ok) {
                    throw new Error('Network response was not ok');
                }
                return response.json();
            })
            .then(data => {
                if (data.status === 'success') {
                    showNotification('Trip deleted successfully', 'success');
                    EveryStreet.Trips.fetchTrips(); // Refresh the trips table
                } else {
                    showNotification(`Error: ${data.message}`, 'danger');
                }
            })
            .catch(error => {
                console.error('Error deleting trip:', error);
                showNotification('Error deleting trip. Please try again.', 'danger');
            });
        }
    }
};

function exportTrip(tripId, format) {
	const url = `/api/export/trip/${tripId}?format=${format}`;
	
	fetch(url)
		.then(response => {
			if (!response.ok) {
				throw new Error(`HTTP error! status: ${response.status}`);
			}
			return response.blob();
		})
		.then(blob => {
			const blobUrl = window.URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.style.display = 'none';
			a.href = blobUrl;
			a.download = `trip_${tripId}.${format}`;
			document.body.appendChild(a);
			a.click();
			window.URL.revokeObjectURL(blobUrl);
		})
		.catch(error => {
			console.error('Error exporting trip:', error);
			showNotification('Error exporting trip. Please try again.', 'danger');
		});
}