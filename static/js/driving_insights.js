let insightsTable = null;

/* global flatpickr */

document.addEventListener('DOMContentLoaded', () => {
    initializeDatePickers();
    initializeEventListeners();
    initializeDataTable();
    fetchUniqueImeis();
    fetchDrivingInsights();
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
        pageLength: 25,
        lengthMenu: [[10, 25, 50, -1], [10, 25, 50, "All"]],
        columns: [
            { data: '_id', title: 'Destination' },
            { data: 'count', title: 'Visit Count', type: 'num' },
            {
                data: 'totalDistance',
                title: 'Total Distance',
                type: 'num',
                render: (data) => `${data.toFixed(2)} miles`,
            },
            {
                data: 'averageDistance',
                title: 'Average Distance',
                type: 'num',
                render: (data) => `${data.toFixed(2)} miles`,
            },
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

let tripCountsChart;

function fetchDrivingInsights() {
    const startDate = localStorage.getItem('startDate') || '';
    const endDate = localStorage.getItem('endDate') || '';
    const imei = document.getElementById('imei').value || '';

    const params = new URLSearchParams();
    if (startDate) params.append('start_date', startDate);
    if (endDate) params.append('end_date', endDate);
    if (imei) params.append('imei', imei);

    const url = `/api/driving-insights?${params.toString()}`;

    fetch(url)
        .then((response) => response.json())
        .then((insights) => {
            insightsTable.clear().rows.add(insights).draw();
            updateSummaryMetrics(insights);
            renderTripCountsChart(insights); // Call the function to render the chart
        })
        .catch((error) => {
            console.error('Error fetching driving insights:', error);
        });
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

function updateSummaryMetrics(insights) {
    const totalTripsElement = document.getElementById('total-trips');
    const totalDistanceElement = document.getElementById('total-distance');
    const mostVisitedElement = document.getElementById('most-visited');

    const totalTrips = insights.reduce((sum, item) => sum + item.count, 0);
    const totalDistance = insights.reduce((sum, item) => sum + item.totalDistance, 0);
    const mostVisited = insights.length > 0 ? insights[0]._id : 'N/A';

    totalTripsElement.textContent = totalTrips;
    totalDistanceElement.textContent = totalDistance.toFixed(2);
    mostVisitedElement.textContent = mostVisited;
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const main = document.querySelector('main');
    sidebar.classList.toggle('collapsed');
    main.classList.toggle('expanded');
}

function renderTripCountsChart(insights) {
    const labels = insights.map(item => item._id);
    const data = insights.map(item => item.count);
    const ctx = document.getElementById('tripCountsChart').getContext('2d');

    // Destroy existing chart instance if it exists
    if (tripCountsChart) {
        tripCountsChart.destroy();
    }

    tripCountsChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Trip Counts',
                data: data,
                backgroundColor: 'rgba(187, 134, 252, 0.6)',
                borderColor: 'rgba(187, 134, 252, 1)',
                borderWidth: 1,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            aspectRatio: 2,
            scales: {
                x: {
                    beginAtZero: true,
                    ticks: { color: '#FFFFFF' },
                    title: { display: true, text: 'Destination', color: '#FFFFFF' },
                },
                y: {
                    beginAtZero: true,
                    ticks: { color: '#FFFFFF' },
                    title: { display: true, text: 'Count', color: '#FFFFFF' },
                },
            },
            plugins: {
                legend: { labels: { color: '#FFFFFF' } },
            },
        },
    });
}