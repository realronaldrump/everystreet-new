// Chart instances
let tripCountsChart = null;
let distanceChart = null;
let timeDistributionChart = null;

// DOM Elements
let datePickers = null;
let insightsTable = null;

document.addEventListener('DOMContentLoaded', () => {
    initializeDatePickers();
    initializeEventListeners();
    initializeDataTable();
    initializeCharts();
    fetchDrivingInsights();
});

function initializeDatePickers() {
    const startDate = document.getElementById('start-date');
    const endDate = document.getElementById('end-date');
    
    if (startDate && endDate) {
        // Get dates from localStorage (set by sidebar)
        const storedStartDate = localStorage.getItem('startDate');
        const storedEndDate = localStorage.getItem('endDate');
        
        if (storedStartDate && storedEndDate) {
            startDate.value = storedStartDate;
            endDate.value = storedEndDate;
        } else {
            // Fallback to today if no stored dates
            const today = new Date();
            const todayStr = today.toISOString().split('T')[0];
            startDate.value = todayStr;
            endDate.value = todayStr;
        }
        
        // Add event listeners
        [startDate, endDate].forEach(picker => {
            picker.addEventListener('change', (event) => {
                localStorage.setItem(event.target.id === 'start-date' ? 'startDate' : 'endDate', event.target.value);
                fetchDrivingInsights();
            });
        });
    }
}

function initializeCharts() {
    initializeTripCountsChart();
    initializeDistanceChart();
    initializeTimeDistributionChart();
}

function initializeTripCountsChart() {
    const ctx = document.getElementById('tripCountsChart').getContext('2d');
    tripCountsChart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: 'Daily Trips',
                data: [],
                borderColor: '#BB86FC',
                backgroundColor: 'rgba(187, 134, 252, 0.2)',
                tension: 0.1,
                fill: true
            }, {
                label: '7-Day Average',
                data: [],
                borderColor: '#03DAC6',
                borderDash: [5, 5],
                tension: 0.1,
                fill: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            scales: {
                x: {
                    type: 'time',
                    time: {
                        unit: 'day',
                        displayFormats: {
                            day: 'MMM d'
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
                        text: 'Number of Trips'
                    }
                }
            },
            plugins: {
                legend: {
                    display: true,
                    position: 'top'
                },
                tooltip: {
                    mode: 'index',
                    intersect: false
                }
            }
        }
    });
}

function initializeDistanceChart() {
    const ctx = document.getElementById('distanceChart').getContext('2d');
    distanceChart = new Chart(ctx, {
        type: 'bar',
        data: {
            datasets: [{
                label: 'Daily Distance (miles)',
                data: [],
                backgroundColor: '#03DAC6',
                borderColor: '#018786',
                borderWidth: 1
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
                            day: 'MMM d'
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
                        text: 'Distance (miles)'
                    }
                }
            },
            plugins: {
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return `Distance: ${context.parsed.y.toFixed(2)} miles`;
                        }
                    }
                }
            }
        }
    });
}

function initializeTimeDistributionChart() {
    const ctx = document.getElementById('timeDistributionChart').getContext('2d');
    timeDistributionChart = new Chart(ctx, {
        type: 'radar',
        data: {
            labels: ['12am-4am', '4am-8am', '8am-12pm', '12pm-4pm', '4pm-8pm', '8pm-12am'],
            datasets: [{
                label: 'Trip Start Times',
                data: [0, 0, 0, 0, 0, 0],
                backgroundColor: 'rgba(187, 134, 252, 0.2)',
                borderColor: '#BB86FC',
                pointBackgroundColor: '#BB86FC'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                r: {
                    beginAtZero: true,
                    ticks: {
                        stepSize: 1
                    }
                }
            }
        }
    });
}

function initializeDataTable() {
    insightsTable = $('#insights-table').DataTable({
        responsive: true,
        order: [[1, 'desc']],
        columns: [
            { data: '_id' },
            { data: 'count' },
            { 
                data: 'lastVisit',
                render: function(data) {
                    return new Date(data).toLocaleDateString();
                }
            }
        ]
    });
}

function initializeEventListeners() {
    const refreshButton = document.getElementById('refresh-data');
    if (refreshButton) {
        refreshButton.addEventListener('click', fetchDrivingInsights);
    }

    // Add date preset handlers
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
                    endDate.setDate(endDate.getDate() - 1);
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

            // Update the date inputs
            document.getElementById('start-date').value = startDate.toISOString().split('T')[0];
            document.getElementById('end-date').value = endDate.toISOString().split('T')[0];

            // Store dates in localStorage
            localStorage.setItem('startDate', startDate.toISOString().split('T')[0]);
            localStorage.setItem('endDate', endDate.toISOString().split('T')[0]);

            // Fetch new data
            fetchDrivingInsights();
        });
    });
}

function fetchDrivingInsights() {
    const params = getFilterParams();
    
    // Fetch trip counts and general insights
    fetch(`/api/driving-insights?${params.toString()}`)
        .then(response => {
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return response.json();
        })
        .then(data => {
            if (Array.isArray(data)) {
                const filteredData = data.filter(item => item._id !== 'HISTORICAL');
                updateSummaryMetrics(filteredData);
                updateDataTable(filteredData);
                updateTripCountsChart(filteredData);
            }
        })
        .catch(error => {
            console.error('Error fetching driving insights:', error);
            showError('Error loading driving insights. Please try again later.');
        });

    // Fetch detailed analytics
    fetch(`/api/trip-analytics?${params.toString()}`)
        .then(response => {
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return response.json();
        })
        .then(data => {
            updateDistanceChart(data.daily_distances);
            updateTimeDistributionChart(data.time_distribution);
        })
        .catch(error => {
            console.error('Error fetching trip analytics:', error);
            showError('Error loading trip analytics. Please try again later.');
        });
}

function updateTripCountsChart(data) {
    if (!Array.isArray(data) || !tripCountsChart) return;

    const dateCountMap = new Map();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // First, get all individual trips from the API
    fetch(`/api/trips?${getFilterParams().toString()}`)
        .then(response => response.json())
        .then(tripsData => {
            // Count trips by their actual start date
            tripsData.features.forEach(trip => {
                if (trip.properties.imei === 'HISTORICAL') return;
                
                const tripDate = new Date(trip.properties.startTime);
                tripDate.setHours(0, 0, 0, 0);
                
                const dateStr = tripDate.toISOString().split('T')[0];
                dateCountMap.set(dateStr, (dateCountMap.get(dateStr) || 0) + 1);
            });

            const chartData = Array.from(dateCountMap.entries())
                .map(([date, count]) => ({
                    x: date,
                    y: count
                }))
                .sort((a, b) => new Date(a.x) - new Date(b.x));

            // Calculate 7-day moving average
            const movingAverage = chartData.map((point, index) => {
                const last7Days = chartData.slice(Math.max(0, index - 6), index + 1);
                const average = last7Days.reduce((sum, p) => sum + p.y, 0) / last7Days.length;
                return {
                    x: point.x,
                    y: parseFloat(average.toFixed(2))
                };
            });

            tripCountsChart.data.datasets[0].data = chartData;
            tripCountsChart.data.datasets[1].data = movingAverage;
            tripCountsChart.update();
        })
        .catch(error => {
            console.error('Error fetching trip details:', error);
            showError('Error loading trip details. Please try again later.');
        });
}

function updateDistanceChart(data) {
    if (!Array.isArray(data) || !distanceChart) return;

    distanceChart.data.datasets[0].data = data.map(d => ({
        x: d.date,
        y: parseFloat(d.distance.toFixed(2))
    }));
    distanceChart.update();
}

function updateTimeDistributionChart(data) {
    if (!Array.isArray(data) || !timeDistributionChart) return;

    const timeSlots = [0, 0, 0, 0, 0, 0];
    data.forEach(d => {
        const slot = Math.floor(d.hour / 4);
        timeSlots[slot] += d.count;
    });
    
    timeDistributionChart.data.datasets[0].data = timeSlots;
    timeDistributionChart.update();
}

function updateSummaryMetrics(data) {
    if (!Array.isArray(data)) return;

    const totalTrips = data.reduce((sum, item) => sum + item.count, 0);
    document.getElementById('total-trips').textContent = totalTrips;

    if (data.length > 0) {
        const mostVisitedDestination = data.reduce((prev, current) => 
            (prev.count > current.count) ? prev : current
        );
        const destinationName = mostVisitedDestination._id;
        const isCustomPlace = mostVisitedDestination.isCustomPlace;
        
        document.getElementById('most-visited').innerHTML = 
            `${destinationName} ${isCustomPlace ? '<span class="badge bg-primary">Custom Place</span>' : ''} ` +
            `(${mostVisitedDestination.count} visits)`;
    }
}

function updateDataTable(data) {
    if (insightsTable) {
        insightsTable.clear().rows.add(data).draw();
    }
}

function getFilterParams() {
    const params = new URLSearchParams();
    const startDate = document.getElementById('start-date');
    const endDate = document.getElementById('end-date');
    
    if (startDate && endDate) {
        params.append('start_date', startDate.value);
        params.append('end_date', endDate.value);
    }
    
    return params;
}

function showError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'alert alert-danger alert-dismissible fade show';
    errorDiv.innerHTML = `
        ${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
    `;
    document.querySelector('.container-fluid').prepend(errorDiv);
}