let insightsTable = null;
let tripCountsChart = null;

/* global flatpickr */
/* global $ */
/* global Chart */

document.addEventListener('DOMContentLoaded', () => {
    initializeDatePickers();
    initializeEventListeners();
    initializeDataTable();
    fetchUniqueImeis();
    fetchDrivingInsights();
    initializeChart();
});

function initializeDatePickers() {
    const today = new Date();
    const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

    flatpickr("#start-date", {
        dateFormat: "Y-m-d",
        maxDate: "today",
        defaultDate: sevenDaysAgo,
    });
    
    flatpickr("#end-date", {
        dateFormat: "Y-m-d",
        maxDate: "today",
        defaultDate: today,
    });
}

function initializeEventListeners() {
    document.getElementById('apply-filters').addEventListener('click', fetchDrivingInsights);
    document.getElementById('sidebar-toggle').addEventListener('click', toggleSidebar);
}

function initializeDataTable() {
    insightsTable = $('#insights-table').DataTable({
        responsive: true,
        scrollX: true,
        pageLength: 25,
        lengthMenu: [[10, 25, 50, -1], [10, 25, 50, "All"]],
        columns: [
            { data: '_id', title: 'Destination' },
            { data: 'count', title: 'Visit Count', type: 'num' },
            {
                data: 'lastVisit',
                title: 'Last Visit',
                type: 'date',
                render: (data) => {
                    const date = new Date(data);
                    return date.toLocaleString();
                },
            }
        ],
        order: [[1, 'desc']],
    });
}

function fetchDrivingInsights() {
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;
    const imei = document.getElementById('imei').value;

    fetch(`/api/driving-insights?start_date=${startDate}&end_date=${endDate}&imei=${imei}`)
        .then(response => response.json())
        .then(data => {
            updateSummaryMetrics(data);
            updateDataTable(data); // Update the data table directly with fetched data
            updateChart(data); // Update the chart directly with fetched data
        })
        .catch(error => {
            console.error('Error fetching driving insights:', error);
            alert('An error occurred while fetching driving insights.');
        });
}

function updateSummaryMetrics(data) {
    // Assuming your API returns total trips in a field called 'totalTrips'
    document.getElementById('total-trips').textContent = data.length; 

    // Find the most visited destination
    let mostVisited = '';
    let maxVisits = 0;
    data.forEach(item => {
        if (item.count > maxVisits) {
            mostVisited = item._id;
            maxVisits = item.count;
        }
    });
    document.getElementById('most-visited').textContent = mostVisited || 'N/A';
}

function updateDataTable(data) {
    insightsTable.clear();
    insightsTable.rows.add(data);
    insightsTable.draw();
}

function initializeChart() {
    const ctx = document.getElementById('tripCountsChart').getContext('2d');
    tripCountsChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [], 
            datasets: [{
                label: 'Trip Counts',
                data: [],
                backgroundColor: 'rgba(0, 123, 255, 0.5)',
                borderColor: 'rgba(0, 123, 255, 1)',
                borderWidth: 1,
                fill: true,
            }]
        },
        options: {
            responsive: true,
            scales: {
                x: {
                    type: 'time',
                    time: {
                        unit: 'day'
                    }
                },
                y: {
                    beginAtZero: true
                }
            }
        }
    });
}

function updateChart(data) {
    // Assuming your API returns data in the format: [{ date: 'YYYY-MM-DD', count: number }, ...]
    const tripCountsOverTime = data.map(item => ({ date: item.lastVisit.split('T')[0], count: item.count }));
    tripCountsChart.data.labels = tripCountsOverTime.map(entry => entry.date);
    tripCountsChart.data.datasets[0].data = tripCountsOverTime.map(entry => entry.count);
    tripCountsChart.update();
}

function fetchUniqueImeis() {
    fetch('/api/trips')
        .then((response) => response.json())
        .then((data) => {
            const imeis = [...new Set(data.features.map(trip => trip.properties.imei))];
            const imeiSelect = document.getElementById('imei');
            imeiSelect.innerHTML = '<option value="">All</option>';

            imeis.forEach((imei) => {
                const option = document.createElement('option');
                option.value = imei;
                option.text = imei;
                imeiSelect.appendChild(option);
            });
        })
        .catch((error) => {
            console.error('Error fetching unique IMEIs:', error);
        });
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const main = document.querySelector('main');
    sidebar.classList.toggle('collapsed');
    main.classList.toggle('expanded');
}