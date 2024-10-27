/* global Chart, $, flatpickr */
let insightsTable;
let tripCountsChart;

document.addEventListener('DOMContentLoaded', () => {
    initializeDatePickers();
    initializeEventListeners();
    initializeDataTable();
    initializeChart();
    fetchDrivingInsights();
});

function fetchDrivingInsights() {
    const params = getFilterParams();
    fetch(`/api/driving-insights?${params.toString()}`)
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            if (Array.isArray(data)) {
                // Filter out historical data
                const filteredData = data.filter(item => item._id !== 'HISTORICAL');
                updateSummaryMetrics(filteredData);
                updateDataTable(filteredData);
                updateChart(filteredData);
            } else {
                throw new Error('Invalid data format received from server');
            }
        })
        .catch(error => {
            console.error('Error fetching driving insights:', error);
            const errorMessage = document.createElement('div');
            errorMessage.className = 'alert alert-danger';
            errorMessage.textContent = 'Error loading driving insights. Please try again later.';
            document.querySelector('.container-fluid').prepend(errorMessage);
        });
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
                borderColor: '#BB86FC',
                backgroundColor: 'rgba(187, 134, 252, 0.2)',
                tension: 0.1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    type: 'time',
                    time: {
                        unit: 'day',
                        displayFormats: {
                            day: 'MMM D'
                        }
                    },
                    title: {
                        display: true,
                        text: 'Date'
                    }
                },
                y: {
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: 'Number of Visits'
                    }
                }
            },
            plugins: {
                legend: {
                    display: true
                },
                tooltip: {
                    mode: 'index',
                    intersect: false
                }
            }
        }
    });
}

function updateChart(data) {
    if (!Array.isArray(data) || !tripCountsChart) return;

    // Create a map to aggregate counts by date
    const dateCountMap = new Map();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    data.forEach(item => {
        const visitDate = new Date(item.lastVisit);
        visitDate.setHours(0, 0, 0, 0);
        
        // Only include dates up to today
        if (visitDate <= today) {
            const dateStr = visitDate.toISOString().split('T')[0];
            dateCountMap.set(dateStr, (dateCountMap.get(dateStr) || 0) + item.count);
        }
    });

    // Convert map to array of data points
    const chartData = Array.from(dateCountMap.entries()).map(([date, count]) => ({
        x: date,
        y: count
    }));

    // Sort data by date
    chartData.sort((a, b) => new Date(a.x) - new Date(b.x));

    tripCountsChart.data.datasets[0].data = chartData;
    tripCountsChart.update();
}

function updateSummaryMetrics(data) {
    if (!Array.isArray(data)) return;

    const totalTrips = data.reduce((sum, item) => sum + item.count, 0);
    document.getElementById('total-trips').textContent = totalTrips;

    if (data.length > 0) {
        const mostVisitedDestination = data.reduce((prev, current) => 
            (prev.count > current.count) ? prev : current
        );
        document.getElementById('most-visited').textContent = 
            `${mostVisitedDestination._id} (${mostVisitedDestination.count} visits)`;
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
            { 
                data: 'lastVisit',
                title: 'Last Visit',
                render: (data) => {
                    const date = new Date(data);
                    return date.toLocaleString();
                }
            }
        ],
        order: [[1, 'desc']]
    });
}

function updateDataTable(data) {
    if (!Array.isArray(data) || !insightsTable) return;
    
    insightsTable.clear();
    insightsTable.rows.add(data).draw();
}

function getFilterParams() {
    const params = new URLSearchParams();
    params.append('start_date', document.getElementById('start-date').value);
    params.append('end_date', document.getElementById('end-date').value);
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

    // Add date preset functionality
    document.querySelectorAll('.date-preset').forEach(button => {
        button.addEventListener('click', function() {
            const range = this.dataset.range;
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            let startDate = new Date(today);
            let endDate = new Date(); // Note: Not setting hours to 0 to keep current time

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
            fetchDrivingInsights();
        });
    });
}
