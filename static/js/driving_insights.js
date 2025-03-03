/* global L, flatpickr, notificationManager, bootstrap, Chart, $ */

"use strict";

(() => {
  // Global chart and table variables
  let tripCountsChart, distanceChart, fuelConsumptionChart;
  let insightsTable;
  let datepickers = {};
  const defaultChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: true,
        position: "top",
        labels: { color: "#bb86fc" },
      },
    },
  };

  // Use the global loadingManager instance if it exists, or null as fallback
  const loadingManager = window.loadingManager || {
    startOperation: () => {},
    addSubOperation: () => {},
    updateSubOperation: () => {},
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
      .getContext("2d");
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
        plugins: { tooltip: { mode: "index", intersect: false } },
      },
    });

    // Daily Distance Chart (Bar Chart)
    const distanceCtx = document
      .getElementById("distanceChart")
      .getContext("2d");
    distanceChart = new Chart(distanceCtx, {
      type: "bar",
      data: { datasets: [] },
      options: {
        ...defaultChartOptions,
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
        plugins: {
          tooltip: {
            callbacks: {
              label: (context) =>
                `Distance: ${context.parsed.y.toFixed(2)} miles`,
            },
          },
        },
      },
    });

    // Fuel Consumption Chart (Bar Chart)
    const fuelConsumptionCtx = document
      .getElementById("fuelConsumptionChart")
      .getContext("2d");
    fuelConsumptionChart = new Chart(fuelConsumptionCtx, {
      type: "bar",
      data: {
        labels: ["Fuel Consumed"],
        datasets: [
          {
            label: "Gallons",
            data: [0],
            backgroundColor: "#FF9800",
          },
        ],
      },
      options: {
        ...defaultChartOptions,
        scales: {
          y: {
            beginAtZero: true,
            title: { display: true, text: "Gallons", color: "#bb86fc" },
            ticks: { color: "#bb86fc" },
            grid: { color: "rgba(187, 134, 252, 0.2)" },
          },
        },
      },
    });
  }

  function initializeDatepickers() {
    const startDateEl = document.getElementById("start-date");
    const endDateEl = document.getElementById("end-date");

    if (startDateEl && endDateEl) {
      // Set default dates if not in localStorage
      const today = new Date();
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(today.getDate() - 30);

      // Get saved dates from localStorage or use defaults
      const savedStartDate =
        localStorage.getItem("startDate") || formatDate(thirtyDaysAgo);
      const savedEndDate = localStorage.getItem("endDate") || formatDate(today);

      // Set initial values
      startDateEl.value = savedStartDate;
      endDateEl.value = savedEndDate;

      // Check if element already has flatpickr initialized by Modern UI
      if (startDateEl._flatpickr || endDateEl._flatpickr) {
        notificationManager.show(
          "Using existing flatpickr instances from Modern UI",
          "info"
        );
        // Store references to the existing flatpickr instances
        datepickers.startDate = startDateEl._flatpickr;
        datepickers.endDate = endDateEl._flatpickr;

        // Add custom onChange handlers to update our localStorage values
        if (datepickers.startDate) {
          const originalOnChange = datepickers.startDate.config.onChange;
          datepickers.startDate.config.onChange = function (
            selectedDates,
            dateStr,
            instance
          ) {
            // Call original handler if it exists
            if (Array.isArray(originalOnChange)) {
              originalOnChange.forEach(
                (fn) =>
                  typeof fn === "function" &&
                  fn(selectedDates, dateStr, instance)
              );
            } else if (typeof originalOnChange === "function") {
              originalOnChange(selectedDates, dateStr, instance);
            }

            // Add our own logic
            localStorage.setItem("startDate", dateStr);
          };
        }

        if (datepickers.endDate) {
          const originalOnChange = datepickers.endDate.config.onChange;
          datepickers.endDate.config.onChange = function (
            selectedDates,
            dateStr,
            instance
          ) {
            // Call original handler if it exists
            if (Array.isArray(originalOnChange)) {
              originalOnChange.forEach(
                (fn) =>
                  typeof fn === "function" &&
                  fn(selectedDates, dateStr, instance)
              );
            } else if (typeof originalOnChange === "function") {
              originalOnChange(selectedDates, dateStr, instance);
            }

            // Add our own logic
            localStorage.setItem("endDate", dateStr);
          };
        }
      } else if (typeof flatpickr === "function") {
        try {
          // Initialize flatpickr for date inputs
          datepickers.startDate = flatpickr(startDateEl, {
            dateFormat: "Y-m-d",
            maxDate: endDateEl.value,
            onChange: function (selectedDates, dateStr) {
              localStorage.setItem("startDate", dateStr);
              if (
                datepickers.endDate &&
                typeof datepickers.endDate.set === "function"
              ) {
                datepickers.endDate.set("minDate", dateStr);
              }
            },
          });

          datepickers.endDate = flatpickr(endDateEl, {
            dateFormat: "Y-m-d",
            minDate: startDateEl.value,
            maxDate: "today",
            onChange: function (selectedDates, dateStr) {
              localStorage.setItem("endDate", dateStr);
              if (
                datepickers.startDate &&
                typeof datepickers.startDate.set === "function"
              ) {
                datepickers.startDate.set("maxDate", dateStr);
              }
            },
          });
        } catch (error) {
          console.error("Error initializing flatpickr:", error);
          // Fall back to standard date inputs
          datepickers = {};
        }
      } else {
        console.warn("Flatpickr not available, using standard date inputs");
        // Handle onChange events manually for standard date inputs
        startDateEl.addEventListener("change", function () {
          localStorage.setItem("startDate", this.value);
        });

        endDateEl.addEventListener("change", function () {
          localStorage.setItem("endDate", this.value);
        });
      }
    }
  }

  function initializeEventListeners() {
    document
      .getElementById("apply-filters")
      ?.addEventListener("click", fetchDrivingInsights);

    // Add quick filter buttons listeners with try/catch for error handling
    try {
      document.getElementById("filter-7days")?.addEventListener("click", () => {
        try {
          setDateRange(7);
        } catch (error) {
          console.error("Error setting 7 day range:", error);
          // Fallback method: update inputs manually and fetch
          const endDate = new Date();
          const startDate = new Date();
          startDate.setDate(endDate.getDate() - 7);

          const startDateEl = document.getElementById("start-date");
          const endDateEl = document.getElementById("end-date");

          if (startDateEl && endDateEl) {
            startDateEl.value = formatDate(startDate);
            endDateEl.value = formatDate(endDate);

            localStorage.setItem("startDate", startDateEl.value);
            localStorage.setItem("endDate", endDateEl.value);

            fetchDrivingInsights();
          }
        }
      });

      document
        .getElementById("filter-30days")
        ?.addEventListener("click", () => {
          try {
            setDateRange(30);
          } catch (error) {
            console.error("Error setting 30 day range:", error);
            // Fallback method: update inputs manually and fetch
            const endDate = new Date();
            const startDate = new Date();
            startDate.setDate(endDate.getDate() - 30);

            const startDateEl = document.getElementById("start-date");
            const endDateEl = document.getElementById("end-date");

            if (startDateEl && endDateEl) {
              startDateEl.value = formatDate(startDate);
              endDateEl.value = formatDate(endDate);

              localStorage.setItem("startDate", startDateEl.value);
              localStorage.setItem("endDate", endDateEl.value);

              fetchDrivingInsights();
            }
          }
        });

      document
        .getElementById("filter-90days")
        ?.addEventListener("click", () => {
          try {
            setDateRange(90);
          } catch (error) {
            console.error("Error setting 90 day range:", error);
            // Fallback method: update inputs manually and fetch
            const endDate = new Date();
            const startDate = new Date();
            startDate.setDate(endDate.getDate() - 90);

            const startDateEl = document.getElementById("start-date");
            const endDateEl = document.getElementById("end-date");

            if (startDateEl && endDateEl) {
              startDateEl.value = formatDate(startDate);
              endDateEl.value = formatDate(endDate);

              localStorage.setItem("startDate", startDateEl.value);
              localStorage.setItem("endDate", endDateEl.value);

              fetchDrivingInsights();
            }
          }
        });
    } catch (error) {
      console.error("Error setting up quick filter buttons:", error);
    }

    // Listen for Modern UI filter changes
    document.addEventListener("filtersApplied", (event) => {
      if (event.detail && event.detail.startDate && event.detail.endDate) {
        notificationManager.show(
          "ModernUI filters applied, updating driving insights",
          "info"
        );
        fetchDrivingInsights();
      }
    });
  }

  //  UTILITY FUNCTIONS
  function formatDate(date) {
    return date.toISOString().split("T")[0];
  }

  function setDateRange(days) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - days);

    // Update datepickers
    const startDateStr = formatDate(startDate);
    const endDateStr = formatDate(endDate);

    // Update localStorage
    localStorage.setItem("startDate", startDateStr);
    localStorage.setItem("endDate", endDateStr);

    // Update datepicker inputs
    const startDateEl = document.getElementById("start-date");
    const endDateEl = document.getElementById("end-date");

    if (startDateEl && endDateEl) {
      // Update the input values directly
      startDateEl.value = startDateStr;
      endDateEl.value = endDateStr;

      // Try different approaches to update flatpickr
      if (startDateEl._flatpickr) {
        // Use the direct flatpickr instance on the element (Modern UI style)
        startDateEl._flatpickr.setDate(startDateStr);
      } else if (datepickers.startDate) {
        if (typeof datepickers.startDate.setDate === "function") {
          // Our own flatpickr instance
          datepickers.startDate.setDate(startDateStr);
        } else {
          console.warn(
            "startDate flatpickr instance doesn't have setDate method"
          );
        }
      }

      if (endDateEl._flatpickr) {
        // Use the direct flatpickr instance on the element (Modern UI style)
        endDateEl._flatpickr.setDate(endDateStr);
      } else if (datepickers.endDate) {
        if (typeof datepickers.endDate.setDate === "function") {
          // Our own flatpickr instance
          datepickers.endDate.setDate(endDateStr);
        } else {
          console.warn(
            "endDate flatpickr instance doesn't have setDate method"
          );
        }
      }
    }

    // Fetch new data
    fetchDrivingInsights();
  }

  function getFilterParams() {
    const startDate =
      localStorage.getItem("startDate") ||
      formatDate(new Date(new Date().setDate(new Date().getDate() - 30)));
    const endDate = localStorage.getItem("endDate") || formatDate(new Date());
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
      loadingManager.addSubOperation("general", 50);
      loadingManager.addSubOperation("analytics", 50);

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
      loadingManager.updateSubOperation("general", 100);

      updateDistanceChart(analyticsData.daily_distances);
      updateFuelChart(generalData);
      loadingManager.updateSubOperation("analytics", 100);

      // Show success message
      notificationManager.show("Insights data loaded successfully", "success");
    } catch (error) {
      console.error("Error fetching driving insights:", error);
      showError(`Error loading driving insights: ${error.message}`);

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
      fuelConsumptionChart.data.datasets[0].data = [0];
      fuelConsumptionChart.update();
    }

    // Reset table
    insightsTable?.clear().draw();

    // Reset summary metrics
    document.getElementById("total-trips").textContent = "0";
    document.getElementById("total-distance").textContent = "0 miles";
    document.getElementById("total-fuel").textContent = "0 gallons";
    document.getElementById("max-speed").textContent = "0 mph";
    document.getElementById("total-idle").textContent = "0m 0s";
    document.getElementById("longest-trip").textContent = "0 miles";
    document.getElementById("most-visited").textContent = "-";
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
    distanceChart.data.datasets[0] = {
      label: "Daily Distance (miles)",
      data: data.map((d) => ({ x: d.date, y: Number(d.distance.toFixed(2)) })),
      backgroundColor: "#03DAC6",
      borderColor: "#018786",
      borderWidth: 1,
    };
    distanceChart.update();
  }

  function updateFuelChart(data) {
    if (
      fuelConsumptionChart &&
      data &&
      data.total_fuel_consumed !== undefined
    ) {
      fuelConsumptionChart.data.datasets[0].data[0] = data.total_fuel_consumed;
      fuelConsumptionChart.update();
    }
  }

  function updateSummaryMetrics(data) {
    document.getElementById("total-trips").textContent = data.total_trips || 0;
    document.getElementById("total-distance").textContent =
      `${(data.total_distance || 0).toFixed(2)} miles`;
    document.getElementById("total-fuel").textContent =
      `${(data.total_fuel_consumed || 0).toFixed(2)} gallons`;
    document.getElementById("max-speed").textContent =
      `${data.max_speed || 0} mph`;
    document.getElementById("total-idle").textContent = formatIdleDuration(
      data.total_idle_duration || 0
    );
    document.getElementById("longest-trip").textContent =
      `${(data.longest_trip_distance || 0).toFixed(2)} miles`;

    const mostVisitedElement = document.getElementById("most-visited");
    if (data.most_visited?._id) {
      const { _id, count, isCustomPlace } = data.most_visited;
      mostVisitedElement.innerHTML = `${_id} ${isCustomPlace ? '<span class="badge bg-primary">Custom</span>' : ""} (${count} visits)`;
    } else {
      mostVisitedElement.textContent = "-";
    }
    updateFuelChart(data);
  }
  //  ERROR HANDLING
  function showError(message) {
    notificationManager.show(message, "danger");
  }
})();
