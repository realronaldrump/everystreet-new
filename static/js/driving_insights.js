/* global DateUtils, Chart */

"use strict";

(() => {
  // Global chart variables
  let tripCountsChart = null,
    distanceChart = null,
    fuelConsumptionChart = null;
  let insightsTable;

  const loadingManager = window.loadingManager || {
    startOperation: () => {},
    finish: () => {},
  };

  // Initialize everything once DOM is ready
  document.addEventListener("DOMContentLoaded", () => {
    initializeEventListeners();
    initializeCharts();
    initializeDatepickers();

    // Auto-load insights on page load
    fetchDrivingInsights();
  });

  //  INITIALIZATION FUNCTIONS
  function initializeCharts() {
    // Daily Trips Chart (Line Chart)
    const tripCountsCtx = document
      .getElementById("tripCountsChart")
      ?.getContext("2d");

    if (tripCountsCtx) {
      tripCountsChart = new Chart(tripCountsCtx, {
        type: "line",
        data: { datasets: [] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: true,
              position: "top",
              labels: { color: "#bb86fc" },
            },
            tooltip: { mode: "index", intersect: false },
          },
          interaction: { intersect: false, mode: "index" },
          scales: {
            x: {
              type: "time",
              time: { unit: "day", displayFormats: { day: "MMM d" } },
              title: { display: true, text: "Date", color: "#bb86fc" },
              ticks: { color: "#bb86fc" },
              grid: { color: "rgba(187, 134, 252, 0.2)" },
            },
            y: {
              beginAtZero: true,
              title: { display: true, text: "Trips", color: "#bb86fc" },
              ticks: { color: "#bb86fc", stepSize: 1 },
              grid: { color: "rgba(187, 134, 252, 0.2)" },
            },
          },
        },
      });
    }

    // Daily Distance Chart (Bar Chart)
    const distanceCtx = document
      .getElementById("distanceChart")
      ?.getContext("2d");

    if (distanceCtx) {
      distanceChart = new Chart(distanceCtx, {
        type: "bar",
        data: { datasets: [] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: true,
              position: "top",
              labels: { color: "#bb86fc" },
            },
            tooltip: {
              callbacks: {
                label: (context) =>
                  `Distance: ${context.parsed.y.toFixed(2)} miles`,
              },
            },
          },
          scales: {
            x: {
              type: "time",
              time: { unit: "day", displayFormats: { day: "MMM d" } },
              title: { display: true, text: "Date", color: "#bb86fc" },
              ticks: { color: "#bb86fc" },
              grid: { color: "rgba(187, 134, 252, 0.2)" },
            },
            y: {
              beginAtZero: true,
              title: {
                display: true,
                text: "Distance (miles)",
                color: "#bb86fc",
              },
              ticks: { color: "#bb86fc" },
              grid: { color: "rgba(187, 134, 252, 0.2)" },
            },
          },
        },
      });
    }

    // Fuel Consumption Chart (Bar Chart)
    const fuelConsumptionCtx = document
      .getElementById("fuelConsumptionChart")
      ?.getContext("2d");

    if (fuelConsumptionCtx) {
      fuelConsumptionChart = new Chart(fuelConsumptionCtx, {
        type: "doughnut",
        data: {
          labels: ["Fuel Consumed", "Estimated Efficiency"],
          datasets: [
            {
              data: [0, 0],
              backgroundColor: ["#FF9800", "#03DAC6"],
              borderWidth: 1,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: true,
              position: "top",
              labels: { color: "#bb86fc" },
            },
            tooltip: {
              callbacks: {
                label: function (context) {
                  const label = context.label || "";
                  const value = context.raw || 0;
                  if (label === "Fuel Consumed") {
                    return `${label}: ${value.toFixed(2)} gallons`;
                  } else if (label === "Estimated Efficiency") {
                    return `${label}: ${value.toFixed(2)} MPG`;
                  }
                  return `${label}: ${value}`;
                },
              },
            },
          },
        },
      });
    }
  }

  function initializeDatepickers() {
    const startDateEl = document.getElementById("start-date");
    const endDateEl = document.getElementById("end-date");

    if (startDateEl && endDateEl) {
      // Get saved dates from localStorage or use defaults
      const savedStartDate =
        localStorage.getItem("startDate") ||
        DateUtils.formatDate(
          DateUtils.getDateRangeForPreset("30days").startDate
        );
      const savedEndDate =
        localStorage.getItem("endDate") || DateUtils.getCurrentDate();

      // Set initial values using DateUtils
      if (startDateEl._flatpickr && endDateEl._flatpickr) {
        // Update when flatpickr is already initialized
        startDateEl._flatpickr.setDate(savedStartDate);
        endDateEl._flatpickr.setDate(savedEndDate);
      } else {
        // Initialize date pickers if they don't exist yet
        DateUtils.initDatePicker(startDateEl, {
          defaultDate: savedStartDate,
        });
        DateUtils.initDatePicker(endDateEl, {
          defaultDate: savedEndDate,
        });
      }
    }
  }

  function initializeEventListeners() {
    document
      .getElementById("apply-filters")
      ?.addEventListener("click", fetchDrivingInsights);

    // Add quick filter buttons listeners
    document.getElementById("filter-7days")?.addEventListener("click", () => {
      setDateRange(7);
    });

    document.getElementById("filter-30days")?.addEventListener("click", () => {
      setDateRange(30);
    });

    document.getElementById("filter-90days")?.addEventListener("click", () => {
      setDateRange(90);
    });

    // Listen for Modern UI filter changes
    document.addEventListener("filtersApplied", () => {
      fetchDrivingInsights();
    });
  }

  //  UTILITY FUNCTIONS
  function setDateRange(days) {
    try {
      const startDateInput = document.getElementById("start-date");
      const endDateInput = document.getElementById("end-date");

      if (!startDateInput || !endDateInput) {
        return;
      }

      // Map to preset names used by DateUtils
      let preset;
      switch (days) {
        case 7:
          preset = "7days";
          break;
        case 30:
          preset = "30days";
          break;
        case 90:
          preset = "90days";
          break;
        default:
          // Handle custom days using DateUtils
          const endDate = new Date();
          const startDate = new Date();
          startDate.setDate(startDate.getDate() - days);

          // Format dates using DateUtils
          updateDateInputs(
            startDateInput,
            endDateInput,
            DateUtils.formatDate(startDate),
            DateUtils.formatDate(endDate)
          );
          return;
      }

      // Use DateUtils to get the range
      DateUtils.getDateRangePreset(preset)
        .then(({ startDate, endDate }) => {
          updateDateInputs(startDateInput, endDateInput, startDate, endDate);
          fetchDrivingInsights();
        })
        .catch((error) => {
          console.warn("Error setting date range: %s", error);
        });
    } catch (error) {
      console.warn("Error in setDateRange: %s", error);
    }
  }

  function updateDateInputs(startInput, endInput, startDate, endDate) {
    // Update inputs using DateUtils helper method
    if (startInput._flatpickr) {
      startInput._flatpickr.setDate(startDate);
    } else {
      startInput.value = startDate;
    }

    if (endInput._flatpickr) {
      endInput._flatpickr.setDate(endDate);
    } else {
      endInput.value = endDate;
    }

    // Store in localStorage
    localStorage.setItem("startDate", startDate);
    localStorage.setItem("endDate", endDate);
  }

  function getFilterParams() {
    const startDate =
      localStorage.getItem("startDate") ||
      DateUtils.formatDate(
        new Date(new Date().setDate(new Date().getDate() - 30))
      );
    const endDate =
      localStorage.getItem("endDate") || DateUtils.formatDate(new Date());
    return new URLSearchParams({ start_date: startDate, end_date: endDate });
  }

  function formatIdleDuration(seconds) {
    if (!seconds) return "0m 0s";

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);

    return `${minutes}m ${remainingSeconds}s`;
  }

  async function fetchDrivingInsights() {
    const params = getFilterParams();
    loadingManager.startOperation("Loading Insights");

    try {
      const [generalData, analyticsData] = await Promise.all([
        fetch(`/api/driving-insights?${params}`).then((res) => {
          if (!res.ok) {
            throw new Error(
              `Failed to fetch insights: ${res.status} ${res.statusText}`
            );
          }
          return res.json();
        }),
        fetch(`/api/trip-analytics?${params}`).then((res) => {
          if (!res.ok) {
            throw new Error(
              `Failed to fetch analytics: ${res.status} ${res.statusText}`
            );
          }
          return res.json();
        }),
      ]);

      // Update the UI
      updateSummaryMetrics(generalData);
      updateTripCountsChart(analyticsData);
      updateDistanceChart(analyticsData.daily_distances);
      updateFuelChart(generalData);

      // Show success message
      if (window.notificationManager) {
        window.notificationManager.show(
          "Insights data loaded successfully",
          "success"
        );
      }
    } catch (error) {
      console.error("Error fetching driving insights:", error);
      if (window.notificationManager) {
        window.notificationManager.show(
          `Error loading driving insights: ${error.message}`,
          "danger"
        );
      }
      // Reset charts to empty state
      resetCharts();
    } finally {
      loadingManager.finish();
    }
  }

  function resetCharts() {
    if (tripCountsChart) {
      tripCountsChart.data.datasets = [];
      tripCountsChart.update();
    }

    if (distanceChart) {
      distanceChart.data.datasets = [];
      distanceChart.update();
    }

    if (fuelConsumptionChart) {
      fuelConsumptionChart.data.datasets[0].data = [0, 0];
      fuelConsumptionChart.update();
    }

    // Reset summary metrics
    const totalTripsEl = document.getElementById("total-trips");
    if (totalTripsEl) totalTripsEl.textContent = "0";

    const totalDistanceEl = document.getElementById("total-distance");
    if (totalDistanceEl) totalDistanceEl.textContent = "0 miles";

    const totalFuelEl = document.getElementById("total-fuel");
    if (totalFuelEl) totalFuelEl.textContent = "0 gallons";

    const maxSpeedEl = document.getElementById("max-speed");
    if (maxSpeedEl) maxSpeedEl.textContent = "0 mph";

    const totalIdleEl = document.getElementById("total-idle");
    if (totalIdleEl) totalIdleEl.textContent = "0m 0s";

    const longestTripEl = document.getElementById("longest-trip");
    if (longestTripEl) longestTripEl.textContent = "0 miles";

    const mostVisitedEl = document.getElementById("most-visited");
    if (mostVisitedEl) mostVisitedEl.textContent = "-";
  }

  //  CHART UPDATE FUNCTIONS
  function updateTripCountsChart(data) {
    if (!tripCountsChart || !data) return;

    tripCountsChart.data.datasets = [
      {
        label: "Daily Trips",
        data: data.daily_distances.map((d) => ({ x: d.date, y: d.count })),
        borderColor: "#BB86FC",
        backgroundColor: "rgba(187, 134, 252, 0.2)",
        tension: 0.1,
        fill: true,
      },
      {
        label: "7-Day Avg",
        data: data.daily_distances.map((d, i, arr) => {
          const slice = arr.slice(Math.max(i - 6, 0), i + 1);
          const avg =
            slice.reduce((sum, entry) => sum + entry.count, 0) / slice.length;
          return { x: d.date, y: avg };
        }),
        borderColor: "#03DAC6",
        borderDash: [5, 5],
        tension: 0.1,
        fill: false,
      },
    ];

    tripCountsChart.update();
  }

  function updateDistanceChart(data) {
    if (!distanceChart || !Array.isArray(data)) return;

    distanceChart.data.datasets = [
      {
        label: "Daily Distance (miles)",
        data: data.map((d) => ({
          x: d.date,
          y: Number(d.distance.toFixed(2)),
        })),
        backgroundColor: "#03DAC6",
        borderColor: "#018786",
        borderWidth: 1,
      },
    ];

    distanceChart.update();
  }

  function updateFuelChart(data) {
    if (
      fuelConsumptionChart &&
      data &&
      data.total_fuel_consumed !== undefined
    ) {
      const fuelConsumed = data.total_fuel_consumed || 0;
      const distance = data.total_distance || 0;

      // Calculate miles per gallon (MPG)
      const mpg = fuelConsumed > 0 ? distance / fuelConsumed : 0;

      fuelConsumptionChart.data.datasets[0].data = [fuelConsumed, mpg];
      fuelConsumptionChart.update();
    }
  }

  function updateSummaryMetrics(data) {
    const totalTripsEl = document.getElementById("total-trips");
    const totalDistanceEl = document.getElementById("total-distance");
    const totalFuelEl = document.getElementById("total-fuel");
    const maxSpeedEl = document.getElementById("max-speed");
    const totalIdleEl = document.getElementById("total-idle");
    const longestTripEl = document.getElementById("longest-trip");
    const mostVisitedEl = document.getElementById("most-visited");

    if (totalTripsEl) totalTripsEl.textContent = data.total_trips || 0;
    if (totalDistanceEl)
      totalDistanceEl.textContent = `${(data.total_distance || 0).toFixed(
        2
      )} miles`;
    if (totalFuelEl)
      totalFuelEl.textContent = `${(data.total_fuel_consumed || 0).toFixed(
        2
      )} gallons`;
    if (maxSpeedEl) maxSpeedEl.textContent = `${data.max_speed || 0} mph`;
    if (totalIdleEl)
      totalIdleEl.textContent = formatIdleDuration(
        data.total_idle_duration || 0
      );
    if (longestTripEl)
      longestTripEl.textContent = `${(data.longest_trip_distance || 0).toFixed(
        2
      )} miles`;

    if (mostVisitedEl) {
      if (data.most_visited?._id) {
        const { _id, count, isCustomPlace } = data.most_visited;
        mostVisitedEl.innerHTML = `${_id} ${
          isCustomPlace ? '<span class="badge bg-primary">Custom</span>' : ""
        } (${count} visits)`;
      } else {
        mostVisitedEl.textContent = "-";
      }
    }
  }
})();
