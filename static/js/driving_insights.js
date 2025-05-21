/* global Chart, DateUtils */

"use strict";

(() => {
  let tripCountsChart = null;
  let distanceChart = null;
  let fuelConsumptionChart = null;

  const loadingManager = window.loadingManager || {
    startOperation: (op) => {
      window.handleError && window.handleError(`Loading started: ${op}`);
    },
    finish: (op) => {
      window.handleError && window.handleError(`Loading finished: ${op}`);
    },
  };

  document.addEventListener("DOMContentLoaded", () => {
    initializeEventListeners();
    if (typeof Chart === "undefined") {
      console.error("Chart.js is not loaded. Charts will not function.");
      return;
    }

    // Delay initialization slightly to ensure other scripts might load
    setTimeout(() => {
      initializeCharts();
      initializeDatepickers();
      fetchDrivingInsights();
    }, 100);
  });

  function initializeCharts() {
    try {
      const tripCountsCtx = document
        .getElementById("tripCountsChart")
        ?.getContext("2d");
      if (tripCountsCtx) {
        tripCountsChart = new Chart(tripCountsCtx, {
          type: "line",
          data: {
            datasets: [],
            labels: [],
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
              tooltip: { mode: "index", intersect: false },
            },
            scales: {
              x: {
                type: "category",
                title: { display: true, text: "Date", color: "#bb86fc" },
                ticks: { color: "#bb86fc" },
                grid: { color: "rgba(187, 134, 252, 0.2)" },
              },
              y: {
                beginAtZero: true,
                title: { display: true, text: "Trips", color: "#bb86fc" },
                ticks: { color: "#bb86fc", stepSize: 1 }, // Ensure y-axis ticks are whole numbers
                grid: { color: "rgba(187, 134, 252, 0.2)" },
              },
            },
          },
        });
      } else {
        console.warn("tripCountsChart canvas not found.");
      }

      const distanceCtx = document
        .getElementById("distanceChart")
        ?.getContext("2d");
      if (distanceCtx) {
        distanceChart = new Chart(distanceCtx, {
          type: "bar",
          data: {
            datasets: [],
            labels: [],
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
                  label: (context) =>
                    `Distance: ${context.parsed.y.toFixed(2)} miles`,
                },
              },
            },
            scales: {
              x: {
                type: "category",
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
      } else {
        console.warn("distanceChart canvas not found.");
      }

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
                data: [0, 0], // Initial empty data
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
                  label(context) {
                    const label = context.label || "";
                    const value = context.raw || 0;
                    if (label === "Fuel Consumed") {
                      return `${label}: ${value.toFixed(2)} gallons`;
                    } else if (label === "Estimated Efficiency") {
                      return `${label}: ${value.toFixed(2)} MPG`;
                    }
                    return `${label}: ${value}`; // Fallback
                  },
                },
              },
            },
          },
        });
      } else {
        console.warn("fuelConsumptionChart canvas not found.");
      }
    } catch (error) {
      console.error("Error initializing charts:", error);
      if (window.notificationManager) {
        window.notificationManager.show(
          `Error initializing charts: ${error.message}`,
          "danger",
        );
      }
    }
  }

  function initializeDatepickers() {
    const startDateEl = document.getElementById("start-date");
    const endDateEl = document.getElementById("end-date");

    if (startDateEl && endDateEl) {
      const dateUtils = window.DateUtils;
      if (!dateUtils) {
        console.error(
          "DateUtils not available for date initialization. Date pickers may not work.",
        );
        return;
      }

      try {
        let savedStartDate = window.utils.getStorage("startDate");
        let savedEndDate = window.utils.getStorage("endDate");

        // Default to last 30 days if no dates are saved
        if (!savedStartDate) {
          const thirtyDaysAgo = new Date();
          thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
          savedStartDate = dateUtils.formatDate(thirtyDaysAgo); // Assumes YYYY-MM-DD
        }

        if (!savedEndDate) {
          savedEndDate = dateUtils.formatDate(new Date()); // Assumes YYYY-MM-DD
        }

        // Set values in localStorage if they were just defaulted
        window.utils.setStorage("startDate", savedStartDate);
        window.utils.setStorage("endDate", savedEndDate);

        // Initialize flatpickr instances if they exist, otherwise set input values
        if (startDateEl._flatpickr && endDateEl._flatpickr) {
          startDateEl._flatpickr.setDate(savedStartDate);
          endDateEl._flatpickr.setDate(savedEndDate);
        } else {
          // Fallback or for non-flatpickr setups if DateUtils.initDatePicker handles it
          dateUtils.initDatePicker(startDateEl, {
            defaultDate: savedStartDate,
          });
          dateUtils.initDatePicker(endDateEl, { defaultDate: savedEndDate });
        }
      } catch (error) {
        console.error("Error initializing datepickers:", error);
      }
    } else {
      console.warn(
        "Start or end date input elements not found for datepickers.",
      );
    }
  }

  function initializeEventListeners() {
    document
      .getElementById("apply-filters")
      ?.addEventListener("click", fetchDrivingInsights);

    document
      .getElementById("filter-7days")
      ?.addEventListener("click", () => setDateRangeAndFetch(7));
    document
      .getElementById("filter-30days")
      ?.addEventListener("click", () => setDateRangeAndFetch(30));
    document
      .getElementById("filter-90days")
      ?.addEventListener("click", () => setDateRangeAndFetch(90));

    // Listen for a custom event if other parts of the app apply filters
    document.addEventListener("filtersApplied", () => {
      fetchDrivingInsights();
    });
  }

  function setDateRangeAndFetch(days) {
    setDateRange(days); // This function now just updates inputs and localStorage
    fetchDrivingInsights(); // Explicitly call fetch after setting range
  }

  function setDateRange(days) {
    try {
      const startDateInput = document.getElementById("start-date");
      const endDateInput = document.getElementById("end-date");
      const dateUtils = window.DateUtils;

      if (!startDateInput || !endDateInput || !dateUtils) {
        console.error(
          "Missing required elements or DateUtils for setDateRange",
        );
        return;
      }

      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(endDate.getDate() - (days - 1)); // e.g., 7 days includes today

      const formattedStartDate = dateUtils.formatDate(startDate);
      const formattedEndDate = dateUtils.formatDate(endDate);

      updateDateInputs(
        startDateInput,
        endDateInput,
        formattedStartDate,
        formattedEndDate,
      );
    } catch (error) {
      console.warn("Error in setDateRange: ", error);
    }
  }

  function updateDateInputs(startInput, endInput, startDateStr, endDateStr) {
    if (startInput._flatpickr) {
      startInput._flatpickr.setDate(startDateStr, false); // `false` to not trigger onChange yet
    } else {
      startInput.value = startDateStr;
    }

    if (endInput._flatpickr) {
      endInput._flatpickr.setDate(endDateStr, false);
    } else {
      endInput.value = endDateStr;
    }

    window.utils.setStorage("startDate", startDateStr);
    window.utils.setStorage("endDate", endDateStr);
  }

  function getFilterParams() {
    const dateUtils = window.DateUtils;
    if (!dateUtils) {
      console.error("DateUtils not available for getFilterParams");
      // Fallback to a default range or return empty if critical
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      return new URLSearchParams({
        start_date: thirtyDaysAgo.toISOString().split("T")[0], // Fallback format
        end_date: new Date().toISOString().split("T")[0], // Fallback format
      });
    }

    // Ensure dates are fetched from localStorage or defaulted if not present
    let startDate = window.utils.getStorage("startDate");
    let endDate = window.utils.getStorage("endDate");

    if (!startDate) {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      startDate = dateUtils.formatDate(thirtyDaysAgo);
      window.utils.setStorage("startDate", startDate); // Save default
    }
    if (!endDate) {
      endDate = dateUtils.formatDate(new Date());
      window.utils.setStorage("endDate", endDate); // Save default
    }

    return new URLSearchParams({ start_date: startDate, end_date: endDate });
  }

  function formatIdleDuration(seconds) {
    if (seconds === null || typeof seconds === "undefined") return "0m 0s";
    const dateUtils = window.DateUtils;
    if (!dateUtils || !dateUtils.formatSecondsToHMS) {
      // Check for specific method
      // Basic fallback if DateUtils or method is missing
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      return `${m}m ${s}s`;
    }
    // Assuming formatSecondsToHMS returns "HH:MM:SS"
    const hms = dateUtils.formatSecondsToHMS(seconds);
    const parts = hms.split(":");
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    const secs = parseInt(parts[2], 10);

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  function formatDateForDisplay(dateStr) {
    // dateStr is expected as YYYY-MM-DD
    if (!dateStr) return "";
    try {
      const date = DateUtils.parseDate(dateStr);
      if (isNaN(date.getTime())) return dateStr; // Invalid date

      return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
      }).format(date);
    } catch (e) {
      console.warn(`Error formatting date for display: ${dateStr}`, e);
      return dateStr; // Fallback to original string on error
    }
  }

  async function fetchDrivingInsights() {
    const params = getFilterParams();
    if (!params.has("start_date") || !params.has("end_date")) {
      console.error("Date parameters are missing for fetching insights.");
      if (window.notificationManager) {
        window.notificationManager.show(
          "Date parameters missing. Cannot load insights.",
          "danger",
        );
      }
      resetCharts(); // Reset charts to show empty state
      loadingManager.finish("Loading Insights"); // Ensure loading finishes
      return;
    }

    loadingManager.startOperation("Loading Insights");

    try {
      const [generalDataResponse, analyticsDataResponse] = await Promise.all([
        fetch(`/api/driving-insights?${params}`),
        fetch(`/api/trip-analytics?${params}`),
      ]);

      if (!generalDataResponse.ok) {
        throw new Error(
          `Failed to fetch general insights: ${generalDataResponse.status} ${generalDataResponse.statusText}`,
        );
      }
      if (!analyticsDataResponse.ok) {
        throw new Error(
          `Failed to fetch trip analytics: ${analyticsDataResponse.status} ${analyticsDataResponse.statusText}`,
        );
      }

      const generalData = await generalDataResponse.json();
      const analyticsData = await analyticsDataResponse.json();

      updateSummaryMetrics(generalData);
      updateTripCountsChart(analyticsData.daily_distances); // Pass daily_distances directly
      updateDistanceChart(analyticsData.daily_distances); // Pass daily_distances directly
      updateFuelChart(generalData);

      if (window.notificationManager) {
        window.notificationManager.show(
          "Insights data loaded successfully!",
          "success",
        );
      }
    } catch (error) {
      console.error("Error fetching driving insights:", error);
      if (window.notificationManager) {
        window.notificationManager.show(
          `Error loading driving insights: ${error.message}`,
          "danger",
        );
      }
      resetCharts(); // Reset charts to an empty state on error
    } finally {
      loadingManager.finish("Loading Insights");
    }
  }

  function resetCharts() {
    if (tripCountsChart) {
      tripCountsChart.data.datasets = [];
      tripCountsChart.data.labels = [];
      tripCountsChart.update();
    }

    if (distanceChart) {
      distanceChart.data.datasets = [];
      distanceChart.data.labels = [];
      distanceChart.update();
    }

    if (fuelConsumptionChart) {
      fuelConsumptionChart.data.datasets[0].data = [0, 0]; // Reset doughnut data
      fuelConsumptionChart.update();
    }

    // Reset summary metric text contents
    const metricsToReset = {
      "total-trips": "0",
      "total-distance": "0 miles",
      "total-fuel": "0 gallons",
      "max-speed": "0 mph",
      "total-idle": "0m 0s",
      "longest-trip": "0 miles",
      "most-visited": "-", // Default for most visited
    };

    Object.entries(metricsToReset).forEach(([id, defaultValue]) => {
      const el = document.getElementById(id);
      if (el) el.textContent = defaultValue;
    });
  }

  function updateTripCountsChart(dailyTripsData) {
    const rawDailyData = dailyTripsData || [];

    if (!tripCountsChart) {
      console.warn("Trip counts chart not initialized. Cannot update.");
      return;
    }

    try {
      const labels = [];
      const tripCounts = [];
      const movingAvg = [];

      const dateUtils = window.DateUtils;
      if (!dateUtils) {
        console.error(
          "DateUtils not available for updateTripCountsChart. Chart will be cleared.",
        );
        tripCountsChart.data.labels = [];
        tripCountsChart.data.datasets = [];
        tripCountsChart.update();
        return;
      }

      const startDateString = window.utils.getStorage("startDate");
      const endDateString = window.utils.getStorage("endDate");

      if (!startDateString || !endDateString) {
        console.error(
          "Start or end date not found in localStorage for trip counts chart. Chart will be cleared.",
        );
        tripCountsChart.data.labels = [];
        tripCountsChart.data.datasets = [];
        tripCountsChart.update();
        return;
      }

      const dataMap = new Map();
      rawDailyData.forEach((d) => {
        if (d && d.date) {
          const dateKey = d.date.substring(0, 10); // Assumes d.date is 'YYYY-MM-DD' or starts with it
          dataMap.set(dateKey, d);
        }
      });

      let currentDateIter = DateUtils.parseDate(startDateString);
      const finalDate = DateUtils.parseDate(endDateString);

      while (currentDateIter <= finalDate) {
        const dateKey = dateUtils.formatDate(currentDateIter); // Format to 'YYYY-MM-DD'
        labels.push(formatDateForDisplay(dateKey));

        const dayData = dataMap.get(dateKey);
        tripCounts.push(
          dayData && typeof dayData.count === "number" ? dayData.count : 0,
        );

        currentDateIter.setDate(currentDateIter.getDate() + 1);
      }

      // Calculate 7-Day Moving Average
      tripCounts.forEach((count, i, allCounts) => {
        const slice = allCounts.slice(Math.max(0, i - 6), i + 1); // Window of up to 7 days
        const sum = slice.reduce((acc, val) => acc + val, 0);
        const avg = slice.length > 0 ? sum / slice.length : 0;
        movingAvg.push(Number(avg.toFixed(1)));
      });

      tripCountsChart.data.labels = labels;
      tripCountsChart.data.datasets = [
        {
          label: "Daily Trips",
          data: tripCounts,
          borderColor: "#BB86FC",
          backgroundColor: "rgba(187, 134, 252, 0.2)",
          tension: 0.1,
          fill: true,
        },
        {
          label: "7-Day Avg",
          data: movingAvg,
          borderColor: "#03DAC6",
          borderDash: [5, 5], // Dashed line for average
          tension: 0.1,
          fill: false,
        },
      ];
      tripCountsChart.update();
    } catch (error) {
      console.error("Error updating trip counts chart:", error);
      if (tripCountsChart) {
        // Attempt to clear chart on error
        tripCountsChart.data.labels = [];
        tripCountsChart.data.datasets = [];
        tripCountsChart.update();
      }
    }
  }

  function updateDistanceChart(dailyDistancesData) {
    const rawDailyData = dailyDistancesData || [];

    if (!distanceChart) {
      console.warn("Distance chart not initialized. Cannot update.");
      return;
    }

    try {
      const labels = [];
      const distances = [];

      const dateUtils = window.DateUtils;
      if (!dateUtils) {
        console.error(
          "DateUtils not available for updateDistanceChart. Chart will be cleared.",
        );
        distanceChart.data.labels = [];
        distanceChart.data.datasets = [];
        distanceChart.update();
        return;
      }

      const startDateString = window.utils.getStorage("startDate");
      const endDateString = window.utils.getStorage("endDate");

      if (!startDateString || !endDateString) {
        console.error(
          "Start or end date not found in localStorage for distance chart. Chart will be cleared.",
        );
        distanceChart.data.labels = [];
        distanceChart.data.datasets = [];
        distanceChart.update();
        return;
      }

      const dataMap = new Map();
      rawDailyData.forEach((d) => {
        if (d && d.date) {
          const dateKey = d.date.substring(0, 10); // Assumes d.date is 'YYYY-MM-DD' or starts with it
          dataMap.set(dateKey, d);
        }
      });

      let currentDateIter = DateUtils.parseDate(startDateString);
      const finalDate = DateUtils.parseDate(endDateString);

      while (currentDateIter <= finalDate) {
        const dateKey = dateUtils.formatDate(currentDateIter); // Format to 'YYYY-MM-DD'
        labels.push(formatDateForDisplay(dateKey));

        const dayData = dataMap.get(dateKey);
        distances.push(
          dayData && typeof dayData.distance === "number"
            ? Number(dayData.distance.toFixed(2))
            : 0,
        );

        currentDateIter.setDate(currentDateIter.getDate() + 1);
      }

      distanceChart.data.labels = labels;
      distanceChart.data.datasets = [
        {
          label: "Daily Distance (miles)",
          data: distances,
          backgroundColor: "#03DAC6",
          borderColor: "#018786",
          borderWidth: 1,
        },
      ];
      distanceChart.update();
    } catch (error) {
      console.error("Error updating distance chart:", error);
      if (distanceChart) {
        // Attempt to clear chart on error
        distanceChart.data.labels = [];
        distanceChart.data.datasets = [];
        distanceChart.update();
      }
    }
  }

  function updateFuelChart(generalData) {
    if (!fuelConsumptionChart || !generalData) {
      if (!fuelConsumptionChart)
        console.warn("Fuel consumption chart not initialized.");
      if (!generalData) console.warn("No general data for fuel chart.");
      // Ensure chart is reset or shows default if data is missing
      if (fuelConsumptionChart) {
        fuelConsumptionChart.data.datasets[0].data = [0, 0];
        fuelConsumptionChart.update();
      }
      return;
    }

    try {
      const fuelConsumed = generalData.total_fuel_consumed || 0;
      const totalDistance = generalData.total_distance || 0; // Use total_distance from generalData

      const mpg =
        fuelConsumed > 0 && totalDistance > 0
          ? totalDistance / fuelConsumed
          : 0;

      fuelConsumptionChart.data.datasets[0].data = [
        Number(fuelConsumed.toFixed(2)),
        Number(mpg.toFixed(2)),
      ];
      fuelConsumptionChart.update();
    } catch (error) {
      console.error("Error updating fuel chart:", error);
      if (fuelConsumptionChart) {
        fuelConsumptionChart.data.datasets[0].data = [0, 0];
        fuelConsumptionChart.update();
      }
    }
  }

  function updateSummaryMetrics(data) {
    if (!data) {
      console.warn(
        "No data provided for summary metrics. Resetting to defaults.",
      );
      resetCharts(); // This will also reset metric elements via its internal call
      return;
    }

    setSummaryMetricElements(data);
    renderMostVisited(data, document.getElementById("most-visited"));
  }

  function setSummaryMetricElements(data) {
    const metrics = {
      "total-trips": data.total_trips || 0,
      "total-distance": `${(Number(data.total_distance) || 0).toFixed(2)} miles`,
      "total-fuel": `${(Number(data.total_fuel_consumed) || 0).toFixed(2)} gallons`,
      "max-speed": `${(Number(data.max_speed) || 0).toFixed(2)} mph`,
      "total-idle": formatIdleDuration(data.total_idle_duration || 0),
      "longest-trip": `${(Number(data.longest_trip_distance) || 0).toFixed(2)} miles`,
    };
    Object.entries(metrics).forEach(([id, value]) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    });
  }

  function renderMostVisited(data, mostVisitedEl) {
    if (!mostVisitedEl) return; // Element not found

    const mostVisitedData = data.most_visited;
    if (!mostVisitedData || Object.keys(mostVisitedData).length === 0) {
      mostVisitedEl.textContent = "-"; // Default if no data
      return;
    }

    try {
      let { _id, count, isCustomPlace } = mostVisitedData;
      _id = parseMostVisitedId(_id); // Parse if it's a JSON string
      const placeName = getMostVisitedPlaceName(_id); // Get display name

      let htmlContent = `${placeName}`;
      if (isCustomPlace) {
        htmlContent += ` <span class="badge bg-primary">Custom</span>`;
      }
      htmlContent += ` (${count} visits)`;

      mostVisitedEl.innerHTML = htmlContent;
    } catch (error) {
      console.error("Error formatting most visited location:", error);
      mostVisitedEl.textContent = "Error displaying location"; // Fallback text
    }
  }

  function parseMostVisitedId(_id) {
    if (
      typeof _id === "string" &&
      _id.startsWith("{") && // Basic check for JSON-like string
      _id.includes("formatted_address") // Heuristic
    ) {
      try {
        return JSON.parse(_id);
      } catch (e) {
        console.warn(
          "Failed to parse potential JSON string for most visited ID:",
          _id,
          e,
        );
        return _id; // Return original string if parsing fails
      }
    }
    return _id; // Return as is if not a parseable string
  }

  function getMostVisitedPlaceName(_idData) {
    if (typeof _idData === "string") {
      return _idData; // If it's already a simple string name
    } else if (typeof _idData === "object" && _idData !== null) {
      // Prioritize more descriptive fields if available
      return (
        _idData.formatted_address ||
        _idData.name ||
        _idData.place_name || // Common variations
        _idData.placeName ||
        _idData.location ||
        _idData.address ||
        // Fallback to a string representation if other fields are missing
        (typeof _idData.toString === "function"
          ? _idData.toString()
          : "Unknown Location")
      );
    }
    return "Unknown Location"; // Default fallback
  }
})();
