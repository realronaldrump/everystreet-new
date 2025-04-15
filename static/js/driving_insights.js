/* global DateUtils, Chart */

"use strict";

(() => {
  let tripCountsChart = null;
  let distanceChart = null;
  let fuelConsumptionChart = null;

  const loadingManager = window.loadingManager || {
    startOperation: () => {},
    finish: () => {},
  };

  document.addEventListener("DOMContentLoaded", () => {
    initializeEventListeners();
    if (typeof Chart === "undefined") {
      console.error("Chart.js is not loaded");
      return;
    }

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
                ticks: { color: "#bb86fc", stepSize: 1 },
                grid: { color: "rgba(187, 134, 252, 0.2)" },
              },
            },
          },
        });
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
        console.error("DateUtils not available for date initialization");
        return;
      }

      try {
        let savedStartDate = localStorage.getItem("startDate");
        let savedEndDate = localStorage.getItem("endDate");

        if (!savedStartDate) {
          const thirtyDaysAgo = new Date();
          thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
          savedStartDate = dateUtils.formatDate(thirtyDaysAgo);
        }

        if (!savedEndDate) {
          savedEndDate = dateUtils.formatDate(new Date());
        }

        if (startDateEl._flatpickr && endDateEl._flatpickr) {
          startDateEl._flatpickr.setDate(savedStartDate);
          endDateEl._flatpickr.setDate(savedEndDate);
        } else {
          dateUtils.initDatePicker(startDateEl, {
            defaultDate: savedStartDate,
          });
          dateUtils.initDatePicker(endDateEl, { defaultDate: savedEndDate });
        }
      } catch (error) {
        console.error("Error initializing datepickers:", error);
      }
    }
  }

  function initializeEventListeners() {
    document
      .getElementById("apply-filters")
      ?.addEventListener("click", fetchDrivingInsights);

    document
      .getElementById("filter-7days")
      ?.addEventListener("click", () => setDateRange(7));
    document
      .getElementById("filter-30days")
      ?.addEventListener("click", () => setDateRange(30));
    document
      .getElementById("filter-90days")
      ?.addEventListener("click", () => setDateRange(90));

    document.addEventListener("filtersApplied", () => {
      fetchDrivingInsights();
    });
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
          const endDate = new Date();
          const startDate = new Date();
          startDate.setDate(startDate.getDate() - days);

          updateDateInputs(
            startDateInput,
            endDateInput,
            dateUtils.formatDate(startDate),
            dateUtils.formatDate(endDate),
          );
          return;
      }

      dateUtils
        .getDateRangePreset(preset)
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

    localStorage.setItem("startDate", startDate);
    localStorage.setItem("endDate", endDate);
  }

  function getFilterParams() {
    const dateUtils = window.DateUtils;
    if (!dateUtils) {
      console.error("DateUtils not available for getFilterParams");
      return new URLSearchParams();
    }

    const startDate =
      localStorage.getItem("startDate") ||
      dateUtils.formatDate(
        new Date(new Date().setDate(new Date().getDate() - 30)),
      );
    const endDate =
      localStorage.getItem("endDate") || dateUtils.formatDate(new Date());

    return new URLSearchParams({ start_date: startDate, end_date: endDate });
  }

  function formatIdleDuration(seconds) {
    const dateUtils = window.DateUtils;
    if (!dateUtils) {
      return "0m 0s";
    }
    return (
      dateUtils.formatSecondsToHMS(seconds).split(":").slice(0, 2).join("m ") +
      "s"
    );
  }

  function formatDateForDisplay(dateStr) {
    if (!dateStr) return "";

    try {
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) return dateStr;

      return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
      }).format(date);
    } catch (e) {
      return dateStr;
    }
  }

  async function fetchDrivingInsights() {
    const params = getFilterParams();
    loadingManager.startOperation("Loading Insights");

    try {
      const [generalData, analyticsData] = await Promise.all([
        fetch(`/api/driving-insights?${params}`).then((res) => {
          if (!res.ok) {
            throw new Error(
              `Failed to fetch insights: ${res.status} ${res.statusText}`,
            );
          }
          return res.json();
        }),
        fetch(`/api/trip-analytics?${params}`).then((res) => {
          if (!res.ok) {
            throw new Error(
              `Failed to fetch analytics: ${res.status} ${res.statusText}`,
            );
          }
          return res.json();
        }),
      ]);

      updateSummaryMetrics(generalData);
      updateTripCountsChart(analyticsData);
      updateDistanceChart(analyticsData.daily_distances);
      updateFuelChart(generalData);

      if (window.notificationManager) {
        window.notificationManager.show(
          "Insights data loaded successfully",
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
      resetCharts();
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
      fuelConsumptionChart.data.datasets[0].data = [0, 0];
      fuelConsumptionChart.update();
    }

    const metrics = {
      "total-trips": "0",
      "total-distance": "0 miles",
      "total-fuel": "0 gallons",
      "max-speed": "0 mph",
      "total-idle": "0m 0s",
      "longest-trip": "0 miles",
      "most-visited": "-",
    };

    Object.entries(metrics).forEach(([id, value]) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    });
  }

  function updateTripCountsChart(data) {
    if (
      !tripCountsChart ||
      !data ||
      !data.daily_distances ||
      !data.daily_distances.length
    )
      return;

    try {
      const labels = [];
      const tripCounts = [];
      const movingAvg = [];

      data.daily_distances.forEach((d, i, arr) => {
        const dateLabel = formatDateForDisplay(d.date);
        labels.push(dateLabel);

        tripCounts.push(d.count);

        const slice = arr.slice(Math.max(i - 6, 0), i + 1);
        const avg =
          slice.reduce((sum, entry) => sum + entry.count, 0) / slice.length;
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
          borderDash: [5, 5],
          tension: 0.1,
          fill: false,
        },
      ];

      tripCountsChart.update();
    } catch (error) {
      console.error("Error updating trip counts chart:", error);
    }
  }

  function updateDistanceChart(data) {
    if (!distanceChart || !Array.isArray(data) || !data.length) return;

    try {
      const labels = [];
      const distances = [];

      data.forEach((d) => {
        const dateLabel = formatDateForDisplay(d.date);
        labels.push(dateLabel);

        distances.push(Number(d.distance.toFixed(2)));
      });

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
    }
  }

  function updateFuelChart(data) {
    if (!fuelConsumptionChart || !data) return;

    try {
      const fuelConsumed = data.total_fuel_consumed || 0;
      const distance = data.total_distance || 0;

      const mpg = fuelConsumed > 0 ? distance / fuelConsumed : 0;

      fuelConsumptionChart.data.datasets[0].data = [fuelConsumed, mpg];
      fuelConsumptionChart.update();
    } catch (error) {
      console.error("Error updating fuel chart:", error);
    }
  }

  function updateSummaryMetrics(data) {
    if (!data) return;

    const metrics = {
      "total-trips": data.total_trips || 0,
      "total-distance": `${(data.total_distance || 0).toFixed(2)} miles`,
      "total-fuel": `${(data.total_fuel_consumed || 0).toFixed(2)} gallons`,
      "max-speed": `${(data.max_speed || 0).toFixed(2)} mph`,
      "total-idle": formatIdleDuration(data.total_idle_duration || 0),
      "longest-trip": `${(data.longest_trip_distance || 0).toFixed(2)} miles`,
    };

    Object.entries(metrics).forEach(([id, value]) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    });

    const mostVisitedEl = document.getElementById("most-visited");
    if (mostVisitedEl && data.most_visited) {
      try {
        let { _id, count, isCustomPlace } = data.most_visited;

        if (
          typeof _id === "string" &&
          _id.startsWith("{") &&
          _id.includes("formatted_address")
        ) {
          try {
            const parsedObj = JSON.parse(_id);
            _id = parsedObj;
          } catch (e) {
            console.warn("Failed to parse what looks like a JSON string:", e);
          }
        }

        let placeName = "Unknown";

        if (typeof _id === "string") {
          placeName = _id;
        } else if (typeof _id === "object" && _id !== null) {
          placeName =
            _id.formatted_address ||
            _id.name ||
            _id.place_name ||
            _id.placeName ||
            _id.location ||
            _id.address ||
            (typeof _id.toString === "function" ? _id.toString() : "Unknown");
        }

        mostVisitedEl.innerHTML = `${placeName} ${
          isCustomPlace ? '<span class="badge bg-primary">Custom</span>' : ""
        } (${count} visits)`;
      } catch (error) {
        console.error("Error formatting most visited location:", error);
        mostVisitedEl.textContent = "Error displaying most visited location";
      }
    } else if (mostVisitedEl) {
      mostVisitedEl.textContent = "-";
    }
  }
})();
