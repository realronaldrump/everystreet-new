let tripsTable = null;

const tableConfig = {
    defaultHiddenColumns: [0, 1] // Indices of columns to hide by default
};

document.addEventListener('DOMContentLoaded', () => {
    const today = new Date();
    const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

    const startDateInput = document.getElementById('start-date');
    const endDateInput = document.getElementById('end-date');
    const applyFiltersButton = document.getElementById('apply-filters');
    const sidebarToggleButton = document.getElementById('sidebar-toggle');
    const fetchTripsButton = document.getElementById('fetch-trips');
    const exportGeojsonButton = document.getElementById('export-geojson');

    if (startDateInput) startDateInput.value = sevenDaysAgo.toISOString().split('T')[0];
    if (endDateInput) endDateInput.value = today.toISOString().split('T')[0];

    initializeDataTable();
    fetchUniqueImeis().then(fetchTrips);

    if (applyFiltersButton) applyFiltersButton.addEventListener('click', fetchTrips);
    if (sidebarToggleButton) sidebarToggleButton.addEventListener('click', toggleSidebar);
    if (fetchTripsButton) fetchTripsButton.addEventListener('click', fetchAndStoreTrips);
    if (exportGeojsonButton) exportGeojsonButton.addEventListener('click', exportGeojson);
});

function initializeDataTable() {
    tripsTable = $('#trips-table').DataTable({
        responsive: true,
        scrollX: true,
        pageLength: 25,
        lengthMenu: [[10, 25, 50, -1], [10, 25, 50, "All"]],
        dom: 'Bfrtip',
        buttons: [
            'colvis'
        ],
        columns: [
            { data: 'transactionId', title: 'Transaction ID' },
            { data: 'imei', title: 'IMEI' },
            { 
                data: 'startTime', 
                title: 'Start Time',
                render: function(data, type, row) {
                    if (type === 'display' || type === 'filter') {
                        const date = new Date(data);
                        return date.toLocaleString('en-US', { 
                            year: 'numeric', 
                            month: '2-digit', 
                            day: '2-digit', 
                            hour: '2-digit', 
                            minute: '2-digit', 
                            second: '2-digit',
                            timeZone: row.timezone
                        });
                    }
                    return data;
                }
            },
            { 
                data: 'endTime', 
                title: 'End Time',
                render: function(data, type, row) {
                    if (type === 'display' || type === 'filter') {
                        const date = new Date(data);
                        return date.toLocaleString('en-US', { 
                            year: 'numeric', 
                            month: '2-digit', 
                            day: '2-digit', 
                            hour: '2-digit', 
                            minute: '2-digit', 
                            second: '2-digit',
                            timeZone: row.timezone
                        });
                    }
                    return data;
                }
            },
            { 
                data: 'distance', 
                title: 'Distance (miles)',
                render: function(data, type) {
                    if (type === 'display') {
                        return parseFloat(data).toFixed(2);
                    }
                    return data;
                }
            },
            { 
                data: 'destination', 
                title: 'Destination'
            },
            {
                data: 'startLocation',
                title: 'Start Location'
            }
        ],
        order: [[2, 'desc']],
        columnDefs: [
            {
                targets: tableConfig.defaultHiddenColumns,
                visible: false
            }
        ]
    });

    // Apply the column visibility button
    new $.fn.dataTable.Buttons(tripsTable, {
        buttons: [
            {
                extend: 'colvis',
                text: 'Column Visibility',
                columns: ':not(.noVis)'
            }
        ]
    });

    tripsTable.buttons().container()
        .appendTo($('#trips-table_wrapper .col-md-6:eq(0)'));
}

function fetchTrips() {
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;
    const imei = document.getElementById('imei').value;

    let url = '/api/trips';
    const params = new URLSearchParams();

    if (startDate) params.append('start_date', startDate);
    if (endDate) params.append('end_date', endDate);
    if (imei) params.append('imei', imei);

    if (params.toString()) {
        url += `?${params.toString()}`;
    }

    fetch(url)
        .then(response => response.json())
        .then(geojson => {
            const trips = geojson.features.map(feature => ({
                ...feature.properties,
                gps: feature.geometry,
                destination: feature.properties.destination || 'N/A'
            }));
            tripsTable.clear().rows.add(trips).draw();
            console.log('Trips data:', trips); // Add this line for debugging
        })
        .catch(error => {
            console.error('Error fetching trips:', error);
        });
}

function fetchUniqueImeis() {
    return fetch('/api/trips')
        .then(response => {
            if (!response.ok) throw new Error('Network response was not ok');
            return response.json();
        })
        .then(geojson => {
            const imeis = [...new Set(geojson.features.map(feature => feature.properties.imei))];
            const imeiSelect = document.getElementById('imei');

            imeiSelect.innerHTML = ''; // Clear existing options
            const allOption = document.createElement('option');
            allOption.value = '';
            allOption.text = 'All';
            imeiSelect.appendChild(allOption);

            imeis.forEach(imei => {
                const option = document.createElement('option');
                option.value = imei;
                option.text = imei;
                imeiSelect.appendChild(option);
            });
        })
        .catch(error => {
            console.error('Error fetching unique IMEIs:', error);
        });
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const main = document.querySelector('main');
    sidebar.classList.toggle('collapsed');
    main.classList.toggle('expanded');
}

function fetchAndStoreTrips() {
    fetch('/api/fetch_trips', {
            method: 'POST'
        })
        .then(response => {
            if (!response.ok) throw new Error('Network response was not ok');
            return response.json();
        })
        .then(data => {
            if (data.status === 'success') {
                alert(data.message);
                fetchTrips(); // Refresh trips table after successful fetch
            } else {
                alert(`Error: ${data.message}`);
            }
        })
        .catch(error => {
            console.error('Error fetching and storing trips:', error);
            alert('An error occurred while fetching and storing trips.');
        });
}

function exportGeojson() {
    fetch('/export/geojson')
        .then(response => {
            if (!response.ok) throw new Error('Network response was not ok');
            return response.json();
        })
        .then(geojson => {
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(geojson));
            const downloadAnchorNode = document.createElement('a');
            downloadAnchorNode.setAttribute("href", dataStr);
            downloadAnchorNode.setAttribute("download", "trips.geojson");
            document.body.appendChild(downloadAnchorNode);
            downloadAnchorNode.click();
            downloadAnchorNode.remove();
        })
        .catch(error => {
            console.error('Error exporting GeoJSON:', error);
        });
}

// Initialize date pickers with Flatpickr
flatpickr("#start-date", {
    dateFormat: "Y-m-d",
    maxDate: "today"
});

flatpickr("#end-date", {
    dateFormat: "Y-m-d",
    maxDate: "today"
});