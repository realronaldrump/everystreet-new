let tripsTable;

document.addEventListener('DOMContentLoaded', () => {
    initializeDataTable();
    fetchTrips();
    fetchUniqueImeis();

    document.getElementById('apply-filters').addEventListener('click', fetchTrips);
    document.getElementById('sidebar-toggle').addEventListener('click', toggleSidebar);
    document.getElementById('fetch-trips').addEventListener('click', fetchAndStoreTrips);
});

function initializeDataTable() {
    tripsTable = $('#trips-table').DataTable({
        responsive: true,
        pageLength: 25,
        lengthMenu: [[10, 25, 50, -1], [10, 25, 50, "All"]],
        columns: [
            { data: 'transactionId' },
            { data: 'imei' },
            { 
                data: 'startTime',
                render: function(data) {
                    return new Date(data).toLocaleString();
                }
            },
            { 
                data: 'endTime',
                render: function(data) {
                    return new Date(data).toLocaleString();
                }
            },
            { 
                data: 'distance',
                render: function(data, type) {
                    if (type === 'sort' || type === 'type') {
                        return parseFloat(data);
                    }
                    return data.toFixed(2) + ' miles';
                },
                type: 'num'
            }
        ],
        order: [[2, 'desc']] // Sort by start time, most recent first
    });
}

function fetchTrips() {
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;
    const imei = document.getElementById('imei').value;

    let url = '/api/trips';
    if (startDate || endDate || imei) {
        url += '?';
        if (startDate) url += `start_date=${startDate}&`;
        if (endDate) url += `end_date=${endDate}&`;
        if (imei) url += `imei=${imei}`;
        if (url.endsWith('&')) url = url.slice(0, -1);
    }

    fetch(url)
        .then(response => response.json())
        .then(trips => {
            console.log('Fetched trips:', trips);
            tripsTable.clear().rows.add(trips).draw();
        })
        .catch(error => {
            console.error('Error fetching trips:', error);
        });
}

function fetchUniqueImeis() {
    fetch('/api/trips')
        .then(response => response.json())
        .then(trips => {
            const imeis = [...new Set(trips.map(trip => trip.imei))];
            const imeiSelect = document.getElementById('imei');

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
    fetch('/api/fetch_trips', { method: 'POST' })
        .then(response => response.json())
        .then(data => {
            if (data.status === 'success') {
                alert(data.message);
                fetchTrips(); // Refresh the trips list
            } else {
                alert(`Error: ${data.message}`);
            }
        })
        .catch(error => {
            console.error('Error fetching and storing trips:', error);
            alert('An error occurred while fetching and storing trips.');
        });
}

// Initialize date pickers
flatpickr("#start-date", { 
    dateFormat: "Y-m-d",
    maxDate: "today"
});

flatpickr("#end-date", { 
    dateFormat: "Y-m-d",
    maxDate: "today"
});