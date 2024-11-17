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
        const today = new Date().toISOString().split('T')[0];
        
        // Get dates from localStorage or use today
        const storedStartDate = localStorage.getItem('startDate');
        const storedEndDate = localStorage.getItem('endDate');
        
        startDate.value = storedStartDate || today;
        endDate.value = storedEndDate || today;
        
        // Store dates if not already stored
        if (!storedStartDate || !storedEndDate) {
            localStorage.setItem('startDate', today);
            localStorage.setItem('endDate', today);
        }
    }
}

function initializeEventListeners() {
    // Apply filters button
    const applyFilters = document.getElementById('apply-filters');
    if (applyFilters) {
        applyFilters.addEventListener('click', () => {
            const startDate = document.getElementById('start-date').value;
            const endDate = document.getElementById('end-date').value;
            
            localStorage.setItem('startDate', startDate);
            localStorage.setItem('endDate', endDate);
            
            fetchTrips();
        });
    }

    // Date preset buttons
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
                        .then(response => response.json())
                        .then(data => {
                            startDate = new Date(data.first_trip_date);
                            updateDatesAndFetch(startDate, endDate);
                        })
                        .catch(error => {
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
                title: 'Transaction ID'
            },
            {
                data: 'imei',
                title: 'IMEI'
            },
            { 
                data: 'startTime',
                title: 'Start Time',
                render: formatDateTime
            },
            { 
                data: 'endTime',
                title: 'End Time',
                render: formatDateTime
            },
            { 
                data: 'distance',
                title: 'Distance (miles)',
                render: formatDistance
            },
            { 
                data: 'destination',
                title: 'Destination',
                render: formatDestination
            },
            {
                data: 'startLocation',
                title: 'Start Location'
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
                                <li><a class="dropdown-item" href="/trip/${row.transactionId}">View Details</a></li>
                                <li><a class="dropdown-item" href="/trip/${row.transactionId}/edit">Edit Trip</a></li>
                                <li><hr class="dropdown-divider"></li>
                                <li><a class="dropdown-item text-danger" href="#" onclick="deleteTrip('${row.transactionId}')">Delete</a></li>
                            </ul>
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

    if (selectedTrips.length === 0) return;

    if (confirm(`Are you sure you want to delete ${selectedTrips.length} trips?`)) {
        // Implement the bulk delete API call here
        console.log('Deleting trips:', selectedTrips);
    }
}

function formatDateTime(data, type, row) {
    if (type === 'display' || type === 'filter') {
        const date = new Date(data);
        const timezone = row.timezone || 'America/Chicago';

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

function getFilterParams() {
    const params = new URLSearchParams();
    const startDate = localStorage.getItem('startDate') || document.getElementById('start-date').value;
    const endDate = localStorage.getItem('endDate') || document.getElementById('end-date').value;
    
    params.append('start_date', startDate);
    params.append('end_date', endDate);
    
    return params;
}

async function fetchTrips() {
    const loadingManager = getLoadingManager();
    loadingManager.startOperation('Loading Trips');

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
            .filter(trip => trip.properties.imei !== 'HISTORICAL')
            .map(trip => ({
                ...trip.properties,
                gps: trip.geometry,
                destination: trip.properties.destination || 'N/A',
                isCustomPlace: trip.properties.isCustomPlace || false,
                distance: parseFloat(trip.properties.distance).toFixed(2)
            }));

        await new Promise((resolve) => {
            tripsTable.clear().rows.add(formattedTrips).draw();
            setTimeout(resolve, 100);
        });

    } catch (error) {
        console.error('Error fetching trips:', error);
        alert('Error loading trips. Please try again.');
    } finally {
        loadingManager.finish();
    }
}

// Export necessary functions for global access
window.EveryStreet = window.EveryStreet || {};
window.EveryStreet.Trips = {
    fetchTrips,
    updateDatesAndFetch,
    getFilterParams
};