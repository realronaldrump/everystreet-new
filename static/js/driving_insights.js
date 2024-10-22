/* global Chart, $, flatpickr */
let insightsTable;
let tripCountsChart;

document.addEventListener('DOMContentLoaded', () => {
    initializeDatePickers();
    initializeEventListeners();
    initializeDataTable();
    initializeChart();
    fetchUniqueImeis();
    fetchDrivingInsights();
});

function fetchDrivingInsights() {
    const params = getFilterParams();
    fetch(`/api/driving-insights?${params.toString()}`)
        .then(response => response.json())
        .then(data => {
            updateSummaryMetrics(data);
            updateDataTable(data);
            updateChart(data);
        })
        .catch(error => console.error('Error fetching driving insights:', error));
}

function initializeChart() {
    const ctx = document.getElementById('tripCountsChart').getContext('2d');
    tripCountsChart = new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [{ label: 'Trip Counts', data: [] }] },
        options: { responsive: true, scales: { x: { type: 'time', time: { unit: 'day' } }, y: { beginAtZero: true } } }
    });
}

function updateChart(data) {
    const chartData = data.map(item => ({ date: item.lastVisit.split('T')[0], count: item.count }));
    tripCountsChart.data.labels = chartData.map(entry => entry.date);
    tripCountsChart.data.datasets[0].data = chartData.map(entry => entry.count);
    tripCountsChart.update();
}

function updateDataTable(data) {
    insightsTable.clear();
    insightsTable.rows.add(data).draw();
}

function getFilterParams() {
    const params = new URLSearchParams();
    params.append('start_date', document.getElementById('start-date').value);
    params.append('end_date', document.getElementById('end-date').value);
    const imei = document.getElementById('imei').value;
    if (imei) params.append('imei', imei);
    return params;
}

function initializeDatePickers() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const storedStartDate = localStorage.getItem('startDate');
    const storedEndDate = localStorage.getItem('endDate');

    const startDate = storedStartDate ? new Date(storedStartDate) : today;
    const endDate = storedEndDate ? new Date(storedEndDate) : today;

    if (document.getElementById('start-date')) {
        flatpickr("#start-date", {
            dateFormat: "Y-m-d",
            maxDate: "today",
            defaultDate: startDate
        });
    }

    if (document.getElementById('end-date')) {
        flatpickr("#end-date", {
            dateFormat: "Y-m-d",
            maxDate: "today",
            defaultDate: endDate
        });
    }
}

function initializeEventListeners() {
    const applyFilters = document.getElementById('apply-filters');
    if (applyFilters) {
        applyFilters.addEventListener('click', fetchDrivingInsights);
    }
}

function initializeDataTable() {
    if (!$.fn.DataTable) {
        console.error('DataTables library is missing');
        return;
    }
    
    insightsTable = $('#insights-table').DataTable({
        responsive: true,
        scrollX: true,
        pageLength: 25,
        columns: [
            { data: '_id', title: 'Destination' },
            { data: 'count', title: 'Visit Count' },
            { data: 'lastVisit', title: 'Last Visit', render: formatDateTime }
        ],
        order: [[1, 'desc']]
    });
}

function fetchUniqueImeis() {
    fetch('/api/trips')
        .then(response => response.json())
        .then(geojson => {
            const imeis = [...new Set(geojson.features.map(trip => trip.properties.imei))];
            const imeiSelect = document.getElementById('imei');
            if (imeiSelect) {
                imeiSelect.innerHTML = '<option value="">All</option>';
                imeis.forEach(imei => {
                    const option = document.createElement('option');
                    option.value = imei;
                    option.text = imei;
                    imeiSelect.appendChild(option);
                });
            }
        })
        .catch(error => console.error('Error fetching unique IMEIs:', error));
}

function updateSummaryMetrics(data) {
    const totalTrips = data.length;
    document.getElementById('total-trips').textContent = totalTrips;
    
    if (data.length > 0) {
        const mostVisitedDestination = data.reduce((prev, current) => 
            (prev.count > current.count) ? prev : current
        );
        document.getElementById('most-visited').textContent = 
            `${mostVisitedDestination._id} (${mostVisitedDestination.count} visits)`;
    }
}

function formatDateTime(data, type) {
    if (type === 'display') {
        const date = new Date(data);
        return date.toLocaleString('en-US', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    }
    return data;
}
