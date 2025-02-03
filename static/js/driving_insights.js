/* global Chart, LoadingManager */

'use strict';

let tripCountsChart, distanceChart, timeDistributionChart, fuelConsumptionChart;
let insightsTable;
const defaultChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
        legend: {
            display: true,
            position: 'top',
            labels: {
                color: '#bb86fc'
            }
        }
    },
};

const loadingManager = new LoadingManager();

document.addEventListener('DOMContentLoaded', () => {
    initializeEventListeners();
    initializeDataTable();
    initializeCharts();
    fetchDrivingInsights();
    document.getElementById('apply-filters')?.addEventListener('click', fetchDrivingInsights);
});

function initializeCharts() {
    const tripCountsCtx = document.getElementById('tripCountsChart').getContext('2d');
    tripCountsChart = new Chart(tripCountsCtx, {
        type: 'line',
        data: {
            datasets: []
        },
        options: {
            ...defaultChartOptions,
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
                        text: 'Date',
                        color: '#bb86fc'
                    },
                    ticks: {
                        color: '#bb86fc'
                    },
                    grid: {
                        color: 'rgba(187, 134, 252, 0.2)'
                    }
                },
                y: {
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: 'Trips',
                        color: '#bb86fc'
                    },
                    ticks: {
                        color: '#bb86fc',
                        stepSize: 1
                    },
                    grid: {
                        color: 'rgba(187, 134, 252, 0.2)'
                    }
                },
            },
            plugins: {
                tooltip: {
                    mode: 'index',
                    intersect: false
                }
            },
        },
    });

    const distanceCtx = document.getElementById('distanceChart').getContext('2d');
    distanceChart = new Chart(distanceCtx, {
        type: 'bar',
        data: {
            datasets: []
        },
        options: {
            ...defaultChartOptions,
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
                        text: 'Date',
                        color: '#bb86fc'
                    },
                    ticks: {
                        color: '#bb86fc'
                    },
                    grid: {
                        color: 'rgba(187, 134, 252, 0.2)'
                    }
                },
                y: {
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: 'Distance (miles)',
                        color: '#bb86fc'
                    },
                    ticks: {
                        color: '#bb86fc'
                    },
                    grid: {
                        color: 'rgba(187, 134, 252, 0.2)'
                    }
                },
            },
            plugins: {
                tooltip: {
                    callbacks: {
                        label: (context) => `Distance: ${context.parsed.y.toFixed(2)} miles`
                    },
                },
            },
        },
    });

    const timeDistributionCtx = document.getElementById('timeDistributionChart').getContext('2d');
    timeDistributionChart = new Chart(timeDistributionCtx, {
        type: 'radar',
        data: {
            labels: ['12am-4am', '4am-8am', '8am-12pm', '12pm-4pm', '4pm-8pm', '8pm-12am'],
            datasets: [{
                label: 'Trip Start Times',
                data: [0, 0, 0, 0, 0, 0],
                backgroundColor: 'rgba(187, 134, 252, 0.2)',
                borderColor: '#BB86FC',
                pointBackgroundColor: '#BB86FC',
            }, ],
        },
        options: {
            ...defaultChartOptions,
            scales: {
                r: {
                    beginAtZero: true,
                    ticks: {
                        stepSize: 1,
                        color: '#bb86fc'
                    },
                    grid: {
                        color: 'rgba(187, 134, 252, 0.2)'
                    }
                }
            },
        },
    });

    const fuelConsumptionCtx = document.getElementById('fuelConsumptionChart').getContext('2d');
    fuelConsumptionChart = new Chart(fuelConsumptionCtx, {
        type: 'bar',
        data: {
            labels: ['Fuel Consumed'],
            datasets: [{
                label: 'Gallons',
                data: [0],
                backgroundColor: '#FF9800',
            }],
        },
        options: {
            ...defaultChartOptions,
            scales: {
                y: {
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: 'Gallons',
                        color: '#bb86fc'
                    },
                    ticks: {
                        color: '#bb86fc'
                    },
                    grid: {
                        color: 'rgba(187, 134, 252, 0.2)'
                    }
                },
            },
        },
    });
}

function initializeDataTable() {
    insightsTable = $('#insights-table').DataTable({
        responsive: true,
        order: [
            [1, 'desc']
        ],
        columns: [{
                data: '_id'
            },
            {
                data: 'count'
            },
            {
                data: 'lastVisit',
                render: (data) => data ? new Date(data).toLocaleDateString() : 'N/A'
            },
        ],
    });
}

function initializeEventListeners() {
    document.getElementById('refresh-data')?.addEventListener('click', fetchDrivingInsights);

    document.querySelectorAll('.date-preset').forEach((button) => {
        button.addEventListener('click', handleDatePresetClick);
    });
}

async function handleDatePresetClick() {
    const range = this.dataset.range;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let startDate = new Date(today);
    let endDate = new Date(today);

    try {
        if (range === 'all-time') {
            loadingManager.startOperation('Fetching First Trip Date');
            const response = await fetch('/api/first_trip_date');
            if (!response.ok) throw new Error('Failed to fetch first trip date');
            startDate = new Date((await response.json()).first_trip_date);
        } else {
            switch (range) {
                case 'yesterday':
                    startDate.setDate(today.getDate() - 1);
                    endDate.setDate(today.getDate() - 1);
                    break;
                case 'last-week':
                    startDate.setDate(today.getDate() - 7);
                    break;
                case 'last-month':
                    startDate.setDate(today.getDate() - 30);
                    break;
                case 'last-6-months':
                    startDate.setMonth(today.getMonth() - 6);
                    break;
                case 'last-year':
                    startDate.setFullYear(today.getFullYear() - 1);
                    break;
            }
        }
        updateDateInputsAndFetch(startDate, endDate);
    } catch (error) {
        console.error('Error setting date range:', error);
        showError('Error setting date range. Using default range.');
        updateDateInputsAndFetch(new Date(today.setFullYear(today.getFullYear() - 1)), today);
    } finally {
        loadingManager.finish('Fetching First Trip Date');
    }
}

function updateDateInputsAndFetch(startDate, endDate) {
    document.getElementById('start-date').value = startDate.toISOString().split('T')[0];
    document.getElementById('end-date').value = endDate.toISOString().split('T')[0];

    localStorage.setItem('startDate', startDate.toISOString().split('T')[0]);
    localStorage.setItem('endDate', endDate.toISOString().split('T')[0]);

    fetchDrivingInsights();
}

async function fetchDrivingInsights() {
    const params = getFilterParams();
    loadingManager.startOperation('Loading Insights');

    try {
        loadingManager.addSubOperation('general', 50);
        loadingManager.addSubOperation('analytics', 50);

        const [generalData, analyticsData] = await Promise.all([
            fetch(`/api/driving-insights?${params}`).then((res) => res.json()),
            fetch(`/api/trip-analytics?${params}`).then((res) => res.json()),
        ]);

        if (generalData.error) {
            throw new Error(generalData.error);
        }

        updateSummaryMetrics(generalData);
        updateDataTable(generalData);
        updateTripCountsChart(analyticsData);

        loadingManager.updateSubOperation('general', 100);

        updateDistanceChart(analyticsData.daily_distances);
        updateTimeDistributionChart(analyticsData.time_distribution);
        updateFuelChart(generalData);

        loadingManager.updateSubOperation('analytics', 100);
    } catch (error) {
        console.error('Error fetching data:', error);
        showError('Error loading driving insights.');
    } finally {
        loadingManager.finish();
    }
}

function updateTripCountsChart(data) {
    if (!tripCountsChart || !data) return;

    tripCountsChart.data.datasets = [{
            label: 'Daily Trips',
            data: data.daily_distances.map(d => ({
                x: d.date,
                y: d.count
            })),
            borderColor: '#BB86FC',
            backgroundColor: 'rgba(187, 134, 252, 0.2)',
            tension: 0.1,
            fill: true,
        },
        {
            label: '7-Day Avg',
            data: data.daily_distances.map((d, i, arr) => {
                const slice = arr.slice(Math.max(i - 6, 0), i + 1);
                const avg = slice.reduce((sum, entry) => sum + entry.count, 0) / slice.length;
                return {
                    x: d.date,
                    y: avg
                };
            }),
            borderColor: '#03DAC6',
            borderDash: [5, 5],
            tension: 0.1,
            fill: false,
        },
    ];
    tripCountsChart.update();
}

function updateDistanceChart(data) {
    if (!distanceChart || !Array.isArray(data)) return;

    distanceChart.data.datasets[0] = {
        label: 'Daily Distance (miles)',
        data: data.map((d) => ({
            x: d.date,
            y: +d.distance.toFixed(2)
        })),
        backgroundColor: '#03DAC6',
        borderColor: '#018786',
        borderWidth: 1,
    };
    distanceChart.update();
}

function updateTimeDistributionChart(data) {
    if (!timeDistributionChart || !Array.isArray(data)) return;

    const timeSlots = Array(6).fill(0);
    data.forEach((d) => timeSlots[Math.floor(d.hour / 4)] += d.count);

    timeDistributionChart.data.datasets[0].data = timeSlots;
    timeDistributionChart.update();
}

function updateSummaryMetrics(data) {
    if (!data) return;

    document.getElementById('total-trips').textContent = data.total_trips || 0;
    document.getElementById('total-distance').textContent = `${(data.total_distance || 0).toFixed(2)} miles`;
    document.getElementById('total-fuel').textContent = `${(data.total_fuel_consumed || 0).toFixed(2)} gallons`;
    document.getElementById('max-speed').textContent = `${data.max_speed || 0} mph`;
    document.getElementById('total-idle').textContent = `${data.total_idle_duration || 0} seconds`;
    document.getElementById('longest-trip').textContent = `${(data.longest_trip_distance || 0).toFixed(2)} miles`;

    const mostVisitedElement = document.getElementById('most-visited');
    if (data.most_visited?._id) {
        const {
            _id,
            count,
            isCustomPlace
        } = data.most_visited;
        mostVisitedElement.innerHTML = `${_id} ${isCustomPlace ? '<span class="badge bg-primary">Custom</span>' : ''} (${count} visits)`;
    } else {
        mostVisitedElement.textContent = '-';
    }

    updateFuelChart(data);
}

function updateFuelChart(data) {
    if (fuelConsumptionChart && data && data.total_fuel_consumed !== undefined) {
        fuelConsumptionChart.data.datasets[0].data[0] = data.total_fuel_consumed;
        fuelConsumptionChart.update();
    }
}

function updateDataTable(data) {
    if (!data.most_visited) return;

    const visitedPlaces = Object.entries(data).filter(([key]) => key === 'most_visited').map(([, value]) => value);

    insightsTable.clear().rows.add(visitedPlaces).draw();
}

function getFilterParams() {
    const startDate = localStorage.getItem('startDate') || new Date().toISOString().split('T')[0];
    const endDate = localStorage.getItem('endDate') || new Date().toISOString().split('T')[0];
    return new URLSearchParams({
        start_date: startDate,
        end_date: endDate,
    });
}

function showError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'alert alert-danger alert-dismissible fade show';
    errorDiv.innerHTML = `${message} <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>`;
    document.querySelector('.container-fluid')?.prepend(errorDiv);
}

