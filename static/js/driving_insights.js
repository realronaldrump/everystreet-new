let insightsTable;

document.addEventListener('DOMContentLoaded', () => {
    const today = new Date();
    const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

    document.getElementById('start-date').value = sevenDaysAgo.toISOString().split('T')[0];
    document.getElementById('end-date').value = today.toISOString().split('T')[0];

    initializeDataTable();
    fetchDrivingInsights();
    fetchUniqueImeis();

    document.getElementById('apply-filters').addEventListener('click', fetchDrivingInsights);
    document.getElementById('sidebar-toggle').addEventListener('click', toggleSidebar);
});

function initializeDataTable() {
    insightsTable = $('#insights-table').DataTable({
        responsive: true,
        pageLength: 25,
        lengthMenu: [[10, 25, 50, -1], [10, 25, 50, "All"]],
        columns: [
            { data: '_id' },
            { data: 'count' },
            { 
                data: 'totalDistance',
                render: function(data) {
                    return data.toFixed(2) + ' miles';
                }
            },
            { 
                data: 'averageDistance',
                render: function(data) {
                    return data.toFixed(2) + ' miles';
                }
            },
            { 
                data: 'lastVisit',
                render: function(data) {
                    return new Date(data).toLocaleString();
                }
            }
        ],
        order: [[1, 'desc']] // Sort by visit count, highest first
    });
}

function fetchDrivingInsights() {
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;
    const imei = document.getElementById('imei').value;

    let url = '/api/driving-insights';
    if (startDate || endDate || imei) {
        url += '?';
        if (startDate) url += `start_date=${startDate}&`;
        if (endDate) url += `end_date=${endDate}&`;
        if (imei) url += `imei=${imei}`;
        if (url.endsWith('&')) url = url.slice(0, -1);
    }

    fetch(url)
        .then(response => response.json())
        .then(insights => {
            console.log('Fetched driving insights:', insights);
            insightsTable.clear().rows.add(insights).draw();
        })
        .catch(error => {
            console.error('Error fetching driving insights:', error);
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

// Initialize date pickers
flatpickr("#start-date", { 
    dateFormat: "Y-m-d",
    maxDate: "today"
});

flatpickr("#end-date", { 
    dateFormat: "Y-m-d",
    maxDate: "today"
});