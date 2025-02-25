/* global L, flatpickr, notificationManager, bootstrap, Chart, $ */

"use strict";

(() => {
  // Global chart variables with initialization
  let tripCountsChart = null;
  let distanceChart = null;
  let timeDistributionChart = null;
  let fuelConsumptionChart = null;
  let speedDistributionChart = null;

  const defaultChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: true,
        position: "top",
        labels: { color: "#bb86fc" },
      },
      tooltip: {
        backgroundColor: "rgba(0, 0, 0, 0.7)",
        padding: 10,
        titleFont: { size: 14 },
        bodyFont: { size: 13 },
        cornerRadius: 4,
      },
    },
  };

  // Theme colors for consistent charts
  const chartColors = {
    primary: "#BB86FC",
    primaryLight: "rgba(187, 134, 252, 0.2)",
    secondary: "#03DAC6",
    secondaryLight: "rgba(3, 218, 198, 0.2)",
    accent: "#FF9800",
    accentLight: "rgba(255, 152, 0, 0.2)",
    gridLine: "rgba(187, 134, 252, 0.2)",
    text: "#bb86fc",
  };

  // Use the global loadingManager instance if it exists, or create a minimal implementation
  const loadingManager = window.loadingManager || {
    startOperation: function (message) {
      console.log("Loading operation started:", message);
      document.querySelector(".loading-overlay")?.classList.add("show");
    },
    addSubOperation: function (name, weight) {
      console.log("Adding sub-operation:", name, weight);
    },
    updateSubOperation: function (name, progress) {
      console.log("Updating sub-operation:", name, progress);
    },
    finish: function () {
      console.log("Loading operation finished");
      document.querySelector(".loading-overlay")?.classList.remove("show");
    },
  };

  // Initialize everything once DOM is ready
  document.addEventListener("DOMContentLoaded", () => {
    initializeEventListeners();
    initializeCharts();
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
          ...defaultChartOptions,
          interaction: { intersect: false, mode: "index" },
          scales: {
            x: {
              type: "time",
              time: { unit: "day", displayFormats: { day: "MMM d" } },
              title: { display: true, text: "Date", color: chartColors.text },
              ticks: { color: chartColors.text },
              grid: { color: chartColors.gridLine },
            },
            y: {
              beginAtZero: true,
              title: { display: true, text: "Trips", color: chartColors.text },
              ticks: { color: chartColors.text, stepSize: 1 },
              grid: { color: chartColors.gridLine },
            },
          },
          plugins: {
            tooltip: {
              mode: "index",
              intersect: false,
              callbacks: {
                title: (items) => {
                  if (!items.length) return "";
                  const date = new Date(items[0].parsed.x);
                  return date.toLocaleDateString(undefined, {
                    weekday: "long",
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  });
                },
              },
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
          ...defaultChartOptions,
          scales: {
            x: {
              type: "time",
              time: { unit: "day", displayFormats: { day: "MMM d" } },
              title: { display: true, text: "Date", color: chartColors.text },
              ticks: { color: chartColors.text },
              grid: { color: chartColors.gridLine },
            },
            y: {
              beginAtZero: true,
              title: {
                display: true,
                text: "Distance (miles)",
                color: chartColors.text,
              },
              ticks: { color: chartColors.text },
              grid: { color: chartColors.gridLine },
            },
          },
          plugins: {
            tooltip: {
              callbacks: {
                label: (context) =>
                  `Distance: ${context.parsed.y.toFixed(2)} miles`,
                title: (items) => {
                  if (!items.length) return "";
                  const date = new Date(items[0].parsed.x);
                  return date.toLocaleDateString(undefined, {
                    weekday: "long",
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  });
                },
              },
            },
          },
        },
      });
    }

    // Trip Time Distribution Chart (Polar Area Chart)
    const timeDistributionCtx = document
      .getElementById("timeDistributionChart")
      ?.getContext("2d");

    if (timeDistributionCtx) {
      timeDistributionChart = new Chart(timeDistributionCtx, {
        type: "polarArea",
        data: {
          labels: [
            "12am-4am",
            "4am-8am",
            "8am-12pm",
            "12pm-4pm",
            "4pm-8pm",
            "8pm-12am",
          ],
          datasets: [
            {
              label: "Trip Start Times",
              data: [0, 0, 0, 0, 0, 0],
              backgroundColor: [
                chartColors.primaryLight,
                chartColors.secondaryLight,
                chartColors.accentLight,
                chartColors.primaryLight,
                chartColors.secondaryLight,
                chartColors.accentLight,
              ],
              borderColor: [
                chartColors.primary,
                chartColors.secondary,
                chartColors.accent,
                chartColors.primary,
                chartColors.secondary,
                chartColors.accent,
              ],
              borderWidth: 1,
            },
          ],
        },
        options: {
          ...defaultChartOptions,
          scales: {
            r: {
              ticks: {
                display: true,
                backdropColor: "transparent",
                color: chartColors.text,
                z: 100,
                padding: 8,
                stepSize: 1,
              },
              grid: { color: chartColors.gridLine },
              angleLines: { color: chartColors.gridLine },
              pointLabels: { color: chartColors.text, font: { size: 12 } },
            },
          },
          plugins: {
            tooltip: {
              callbacks: {
                label: (context) => `${context.label}: ${context.raw} trips`,
              },
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
        type: "bar",
        data: {
          labels: ["Fuel"],
          datasets: [
            {
              label: "Gallons",
              data: [0],
              backgroundColor: chartColors.accent,
            },
          ],
        },
        options: {
          ...defaultChartOptions,
          scales: {
            y: {
              beginAtZero: true,
              title: {
                display: true,
                text: "Gallons",
                color: chartColors.text,
              },
              ticks: { color: chartColors.text },
              grid: { color: chartColors.gridLine },
            },
          },
          plugins: {
            tooltip: {
              callbacks: {
                label: (context) =>
                  `${context.raw.toFixed(2)} gallons of fuel consumed`,
              },
            },
          },
        },
      });
    }

    // Speed Distribution Chart (new)
    const speedDistributionCtx = document
      .getElementById("speedDistributionChart")
      ?.getContext("2d");

    if (speedDistributionCtx) {
      speedDistributionChart = new Chart(speedDistributionCtx, {
        type: "doughnut",
        data: {
          labels: ["0-20 mph", "21-40 mph", "41-60 mph", "61+ mph"],
          datasets: [
            {
              data: [0, 0, 0, 0],
              backgroundColor: [
                chartColors.primaryLight,
                chartColors.secondaryLight,
                chartColors.accentLight,
                "rgba(255, 99, 132, 0.2)",
              ],
              borderColor: [
                chartColors.primary,
                chartColors.secondary,
                chartColors.accent,
                "rgb(255, 99, 132)",
              ],
              borderWidth: 1,
            },
          ],
        },
        options: {
          ...defaultChartOptions,
          cutout: "65%",
          plugins: {
            tooltip: {
              callbacks: {
                label: (context) => {
                  const value = context.raw || 0;
                  const total = context.dataset.data.reduce(
                    (sum, val) => sum + val,
                    0,
                  );
                  const percentage = total
                    ? Math.round((value / total) * 100)
                    : 0;
                  return `${context.label}: ${percentage}% (${value} trips)`;
                },
              },
            },
          },
        },
      });
    }
  }

  function initializeEventListeners() {
    // Initialize date filter inputs with localStorage values or defaults
    const today = new Date().toISOString().split("T")[0];
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
    const oneMonthAgoStr = oneMonthAgo.toISOString().split("T")[0];

    const startDateInput = document.getElementById("start-date");
    const endDateInput = document.getElementById("end-date");

    if (startDateInput && endDateInput) {
      // Set initial values from localStorage or use defaults
      startDateInput.value =
        localStorage.getItem("startDate") || oneMonthAgoStr;
      endDateInput.value = localStorage.getItem("endDate") || today;

      // Save values to localStorage when changed
      startDateInput.addEventListener("change", () => {
        localStorage.setItem("startDate", startDateInput.value);
      });

      endDateInput.addEventListener("change", () => {
        localStorage.setItem("endDate", endDateInput.value);
      });
    }

    // Set up filter button
    document
      .getElementById("apply-filters")
      ?.addEventListener("click", fetchAllInsights);

    // Set up presets for quick filtering
    document.getElementById("preset-today")?.addEventListener("click", () => {
      setDatePreset(0, 0);
    });

    document.getElementById("preset-week")?.addEventListener("click", () => {
      setDatePreset(7, 0);
    });

    document.getElementById("preset-month")?.addEventListener("click", () => {
      setDatePreset(30, 0);
    });

    document.getElementById("preset-quarter")?.addEventListener("click", () => {
      setDatePreset(90, 0);
    });

    document.getElementById("preset-year")?.addEventListener("click", () => {
      setDatePreset(365, 0);
    });

    // Automatically load insights when the page loads
    fetchAllInsights();
  }

  // Set date preset helper
  function setDatePreset(daysBack, daysForward) {
    const startDateInput = document.getElementById("start-date");
    const endDateInput = document.getElementById("end-date");

    if (!startDateInput || !endDateInput) return;

    const endDate = new Date();
    if (daysForward > 0) {
      endDate.setDate(endDate.getDate() + daysForward);
    }

    const startDate = new Date();
    if (daysBack > 0) {
      startDate.setDate(startDate.getDate() - daysBack);
    }

    startDateInput.value = startDate.toISOString().split("T")[0];
    endDateInput.value = endDate.toISOString().split("T")[0];

    localStorage.setItem("startDate", startDateInput.value);
    localStorage.setItem("endDate", endDateInput.value);

    fetchAllInsights();
  }

  //  UTILITY FUNCTIONS
  function getFilterParams() {
    const startDate =
      localStorage.getItem("startDate") ||
      new Date().toISOString().split("T")[0];
    const endDate =
      localStorage.getItem("endDate") || new Date().toISOString().split("T")[0];
    return new URLSearchParams({ start_date: startDate, end_date: endDate });
  }

  // Process trips data to create analytics data structure
  function processTripsIntoAnalytics(tripsData) {
    if (!tripsData || !tripsData.features || !tripsData.features.length) {
      return {
        daily_distances: [],
        time_distribution: [],
      };
    }

    // Map trips by date for daily_distances
    const dateMap = {};
    const hourDistribution = Array(24).fill(0);

    tripsData.features.forEach((feature) => {
      const props = feature.properties;

      // Process start time for time distribution
      if (props.startTime) {
        const startDate = new Date(props.startTime);
        const hour = startDate.getHours();
        hourDistribution[hour]++;

        // Format date for daily aggregation
        const dateKey = startDate.toISOString().split("T")[0];

        if (!dateMap[dateKey]) {
          dateMap[dateKey] = {
            date: dateKey,
            count: 0,
            distance: 0,
          };
        }

        dateMap[dateKey].count++;
        dateMap[dateKey].distance += parseFloat(props.distance || 0);
      }
    });

    // Format for time_distribution
    const timeDistribution = hourDistribution.map((count, hour) => ({
      hour,
      count,
    }));

    // Sort daily distances by date
    const dailyDistances = Object.values(dateMap).sort((a, b) =>
      a.date.localeCompare(b.date),
    );

    return {
      daily_distances: dailyDistances,
      time_distribution: timeDistribution,
    };
  }

  async function fetchAllInsights() {
    loadingManager.startOperation("Loading Insights");

    try {
      loadingManager.addSubOperation("general", 25);
      loadingManager.addSubOperation("analytics", 25);
      loadingManager.addSubOperation("metrics", 25);
      loadingManager.addSubOperation("trips", 25);

      const params = getFilterParams();

      const [generalData, metricsData, tripsData] = await Promise.all([
        fetch(`/api/driving-insights?${params}`).then((res) => res.json()),
        fetch(`/api/metrics?${params}`).then((res) => res.json()),
        fetch(`/api/trips?${params}`).then((res) => res.json()),
      ]);

      if (generalData.error) throw new Error(generalData.error);

      // Process trips data into analytics format since trip-analytics endpoint doesn't exist
      const analyticsData = processTripsIntoAnalytics(tripsData);
      loadingManager.updateSubOperation("trips", 100);

      // Process all data
      updateSummaryMetrics(generalData, metricsData);
      updateTripCountsChart(analyticsData);
      loadingManager.updateSubOperation("general", 100);

      updateDistanceChart(analyticsData.daily_distances);
      updateTimeDistributionChart(analyticsData.time_distribution);
      updateFuelChart(generalData);
      loadingManager.updateSubOperation("analytics", 100);

      // Generate speed distribution data
      const speedDistribution = calculateSpeedDistribution(
        tripsData.features || [],
      );
      updateSpeedDistributionChart(speedDistribution);

      loadingManager.updateSubOperation("metrics", 100);
    } catch (error) {
      // Use notification manager for errors
      showError(`Error loading driving insights: ${error.message}`);
    } finally {
      loadingManager.finish();
    }
  }

  // Calculate speed distribution from trip data
  function calculateSpeedDistribution(tripFeatures) {
    const distribution = [0, 0, 0, 0]; // [0-20, 21-40, 41-60, 61+]

    if (!tripFeatures || !tripFeatures.length) return distribution;

    tripFeatures.forEach((feature) => {
      const maxSpeed = feature.properties.maxSpeed || 0;

      if (maxSpeed <= 20) {
        distribution[0]++;
      } else if (maxSpeed <= 40) {
        distribution[1]++;
      } else if (maxSpeed <= 60) {
        distribution[2]++;
      } else {
        distribution[3]++;
      }
    });

    return distribution;
  }

  //  CHART UPDATE FUNCTIONS
  function updateTripCountsChart(data) {
    if (!tripCountsChart || !data || !data.daily_distances) return;

    tripCountsChart.data.datasets = [
      {
        label: "Daily Trips",
        data: data.daily_distances.map((d) => ({ x: d.date, y: d.count })),
        borderColor: chartColors.primary,
        backgroundColor: chartColors.primaryLight,
        tension: 0.3,
        fill: true,
      },
      {
        label: "7-Day Average",
        data: data.daily_distances.map((d, i, arr) => {
          const slice = arr.slice(Math.max(i - 6, 0), i + 1);
          const avg =
            slice.reduce((sum, entry) => sum + entry.count, 0) / slice.length;
          return { x: d.date, y: parseFloat(avg.toFixed(1)) };
        }),
        borderColor: chartColors.secondary,
        borderDash: [5, 5],
        tension: 0.3,
        fill: false,
      },
    ];

    tripCountsChart.update();
  }

  function updateDistanceChart(data) {
    if (!distanceChart || !Array.isArray(data)) return;

    // Calculate 7-day moving average
    const movingAvgData = data.map((d, i, arr) => {
      const slice = arr.slice(Math.max(i - 6, 0), i + 1);
      const avg =
        slice.reduce((sum, entry) => sum + entry.distance, 0) / slice.length;
      return { x: d.date, y: parseFloat(avg.toFixed(2)) };
    });

    distanceChart.data.datasets = [
      {
        label: "Daily Distance (miles)",
        data: data.map((d) => ({
          x: d.date,
          y: parseFloat(d.distance.toFixed(2)),
        })),
        backgroundColor: chartColors.secondary,
        borderColor: "#018786",
        borderWidth: 1,
        order: 1,
      },
      {
        label: "7-Day Average",
        data: movingAvgData,
        borderColor: chartColors.primary,
        borderDash: [5, 5],
        borderWidth: 2,
        type: "line",
        tension: 0.3,
        fill: false,
        order: 0,
      },
    ];

    distanceChart.update();
  }

  function updateTimeDistributionChart(data) {
    if (!timeDistributionChart || !Array.isArray(data)) return;

    // Calculate time distribution with better bucketing
    const timeSlots = Array(6).fill(0);

    data.forEach((d) => {
      const slot = Math.floor(d.hour / 4);
      if (slot >= 0 && slot < 6) {
        timeSlots[slot] += d.count;
      }
    });

    // Update chart data
    timeDistributionChart.data.datasets[0].data = timeSlots;

    // Add more descriptive labels to time slots where trips occur
    const timeLabels = [
      "Night (12am-4am)",
      "Early Morning (4am-8am)",
      "Morning (8am-12pm)",
      "Afternoon (12pm-4pm)",
      "Evening (4pm-8pm)",
      "Night (8pm-12am)",
    ];

    // Find the busiest time slot
    const maxIndex = timeSlots.indexOf(Math.max(...timeSlots));

    if (maxIndex >= 0) {
      const busyTimeElement = document.getElementById("busiest-time");
      if (busyTimeElement) {
        busyTimeElement.textContent = timeLabels[maxIndex];
      }
    }

    timeDistributionChart.update();
  }

  function updateFuelChart(data) {
    if (
      !fuelConsumptionChart ||
      !data ||
      data.total_fuel_consumed === undefined
    ) {
      return;
    }

    // Get values
    const fuelValue = data.total_fuel_consumed || 0;

    // Update chart
    fuelConsumptionChart.data.labels = ["Total Fuel Consumed"];
    fuelConsumptionChart.data.datasets[0].data = [fuelValue];

    // Add cost estimate if we have fuel data
    if (fuelValue > 0) {
      const fuelPrice = localStorage.getItem("fuel_price_per_gallon") || 3.5; // Default price per gallon
      const totalCost = fuelValue * fuelPrice;

      fuelConsumptionChart.data.labels.push("Estimated Cost");
      fuelConsumptionChart.data.datasets[0].data.push(totalCost);

      // Add different colors for the cost bar
      fuelConsumptionChart.data.datasets[0].backgroundColor = [
        chartColors.accent,
        chartColors.secondary,
      ];

      // Add cost to tooltip
      fuelConsumptionChart.options.plugins.tooltip.callbacks = {
        label: (context) => {
          if (context.dataIndex === 0) {
            return `${context.raw.toFixed(2)} gallons`;
          } else {
            return `$${context.raw.toFixed(2)} (at $${fuelPrice}/gal)`;
          }
        },
      };
    }

    fuelConsumptionChart.update();
  }

  function updateSpeedDistributionChart(distribution) {
    if (!speedDistributionChart) return;

    speedDistributionChart.data.datasets[0].data = distribution;
    speedDistributionChart.update();
  }

  function updateSummaryMetrics(data, metricsData) {
    // Update basic metrics
    const totalTripsElement = document.getElementById("total-trips");
    if (totalTripsElement) {
      totalTripsElement.textContent = data.total_trips || 0;
    }

    const totalDistanceElement = document.getElementById("total-distance");
    if (totalDistanceElement) {
      totalDistanceElement.textContent = `${(data.total_distance || 0).toFixed(2)} miles`;
    }

    const totalFuelElement = document.getElementById("total-fuel");
    if (totalFuelElement) {
      totalFuelElement.textContent = `${(data.total_fuel_consumed || 0).toFixed(2)} gallons`;
    }

    const maxSpeedElement = document.getElementById("max-speed");
    if (maxSpeedElement) {
      maxSpeedElement.textContent = `${data.max_speed || 0} mph`;
    }

    const avgSpeedElement = document.getElementById("avg-speed");
    if (avgSpeedElement) {
      avgSpeedElement.textContent = `${metricsData.avg_speed || 0} mph`;
    }

    // Format idle duration for better readability
    const totalSeconds = data.total_idle_duration || 0;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    const totalIdleElement = document.getElementById("total-idle");
    if (totalIdleElement) {
      totalIdleElement.textContent = `${minutes}m ${seconds}s`;
    }

    const longestTripElement = document.getElementById("longest-trip");
    if (longestTripElement) {
      longestTripElement.textContent = `${(data.longest_trip_distance || 0).toFixed(2)} miles`;
    }

    const avgDistanceElement = document.getElementById("avg-distance");
    if (avgDistanceElement) {
      avgDistanceElement.textContent = `${metricsData.avg_distance || "0.00"} miles`;
    }

    // Update most visited location
    const mostVisitedElement = document.getElementById("most-visited");
    if (mostVisitedElement) {
      if (data.most_visited?._id) {
        const { _id, count, isCustomPlace } = data.most_visited;
        mostVisitedElement.innerHTML = `${_id} ${isCustomPlace ? '<span class="badge bg-primary">Custom</span>' : ""} (${count} visits)`;
      } else {
        mostVisitedElement.textContent = "-";
      }
    }

    // Update efficiency metrics if we can calculate them
    const fuelEffElement = document.getElementById("fuel-efficiency");
    if (fuelEffElement) {
      if (data.total_distance > 0 && data.total_fuel_consumed > 0) {
        const mpg = data.total_distance / data.total_fuel_consumed;
        fuelEffElement.textContent = `${mpg.toFixed(2)} MPG`;
      } else {
        fuelEffElement.textContent = "N/A";
      }
    }
  }

  //  ERROR HANDLING
  function showError(message) {
    if (notificationManager && typeof notificationManager.show === "function") {
      notificationManager.show(message, "danger");
    } else {
      console.error(message);
    }
  }
})();
