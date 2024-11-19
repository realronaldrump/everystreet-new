// Chart instances
let tripCountsChart = null;
let distanceChart = null;
let timeDistributionChart = null;
let fuelConsumptionChart = null;

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
	initializeFuelConsumptionChart();
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

function initializeFuelConsumptionChart() {
	const ctx = document.getElementById('fuelConsumptionChart').getContext('2d');

	// Destroy existing chart instance if it exists
	if (fuelConsumptionChart) {
		fuelConsumptionChart.destroy();
	}

	fuelConsumptionChart = new Chart(ctx, {
		type: 'bar',
		data: {
			labels: ['Fuel Consumed'],
			datasets: [{
				label: 'Gallons',
				data: [0],
				backgroundColor: '#FF9800'
			}]
		},
		options: {
			scales: {
				y: {
					beginAtZero: true
				}
			}
		}
	});

	// Update function
	function updateFuelChart(data) {
		fuelConsumptionChart.data.datasets[0].data = [data.total_fuel_consumed];
		fuelConsumptionChart.update();
	}

	return updateFuelChart;
}

let updateFuelChart = initializeFuelConsumptionChart();

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
		button.addEventListener('click', async function() {
			const range = this.dataset.range;
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			let startDate = new Date(today);
			let endDate = new Date(today);

			if (range === 'all-time') {
				try {
					const response = await fetch('/api/first_trip_date');
					if (!response.ok) throw new Error('Failed to fetch first trip date');
					const data = await response.json();
					startDate = new Date(data.first_trip_date);
				} catch (error) {
					console.error('Error fetching first trip date:', error);
					showError('Error setting date range. Using default range.');
					startDate.setFullYear(startDate.getFullYear() - 1); // Fallback to last year
				}
			} else {
				switch (range) {
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

async function fetchDrivingInsights() {
	const params = getFilterParams();
	const loadingManager = getLoadingManager();

	loadingManager.startOperation('Loading Insights');
	loadingManager.addSubOperation('general', 0.5);
	loadingManager.addSubOperation('analytics', 0.5);

	try {
		// Fetch trip counts and general insights
		loadingManager.updateSubOperation('general', 30);
		const response = await fetch(`/api/driving-insights?${params.toString()}`);
		if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
		const data = await response.json();
		loadingManager.updateSubOperation('general', 60);

		if (!data.error) {
			updateSummaryMetrics(data);
			updateDataTable(data.most_visited ? [data.most_visited] : []);
			updateTripCountsChart(data);
		}
		loadingManager.updateSubOperation('general', 100);

		// Fetch detailed analytics
		loadingManager.updateSubOperation('analytics', 30);
		const analyticsResponse = await fetch(`/api/trip-analytics?${params.toString()}`);
		if (!analyticsResponse.ok) throw new Error(`HTTP error! status: ${analyticsResponse.status}`);
		const analyticsData = await analyticsResponse.json();
		loadingManager.updateSubOperation('analytics', 60);

		updateDistanceChart(analyticsData.daily_distances);
		updateTimeDistributionChart(analyticsData.time_distribution);
		updateFuelChart(analyticsData);
		loadingManager.updateSubOperation('analytics', 100);
	} catch (error) {
		console.error('Error:', error);
		showError('Error loading driving insights. Please try again later.');
	} finally {
		loadingManager.finish();
	}
}

function updateTripCountsChart(data) {
	if (!data || !tripCountsChart) return;

	// Assuming backend returns trip counts data in a specific format
	// For example:
	// data.trip_counts = [{x: date, y: count}, ...]
	// data.moving_average = [{x: date, y: average}, ...]

	if (data.trip_counts) {
		tripCountsChart.data.datasets[0].data = data.trip_counts;
	}

	if (data.moving_average) {
		tripCountsChart.data.datasets[1].data = data.moving_average;
	}

	tripCountsChart.update();
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
	if (!data) return;

	document.getElementById('total-trips').textContent = data.total_trips;
	document.getElementById('total-distance').textContent = `${data.total_distance} miles`;
	document.getElementById('total-fuel').textContent = `${data.total_fuel_consumed} gallons`;
	document.getElementById('max-speed').textContent = `${data.max_speed} mph`;
	document.getElementById('total-idle').textContent = `${data.total_idle_duration} minutes`;
	document.getElementById('longest-trip').textContent = `${data.longest_trip_distance} miles`;

	if (data.most_visited && data.most_visited._id) {
		const {
			_id,
			count,
			isCustomPlace
		} = data.most_visited;
		document.getElementById('most-visited').innerHTML =
			`${_id} ${isCustomPlace ? '<span class="badge bg-primary">Custom Place</span>' : ''} ` +
			`(${count} visits)`;
	} else {
		document.getElementById('most-visited').textContent = '-';
	}

	// Update the fuel consumption chart
	updateFuelChart(data);
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