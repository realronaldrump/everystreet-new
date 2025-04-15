// Driver Behavior Analytics JS
(function () {
  async function fetchBehaviorData() {
    try {
      const resp = await fetch("/api/driver-behavior");
      if (!resp.ok) throw new Error("Failed to fetch analytics");
      return await resp.json();
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  function setMetric(id, value, digits = 0) {
    const el = document.getElementById(id);
    if (el) el.textContent = value !== undefined && value !== null ? Number(value).toFixed(digits) : "-";
  }

  function renderSummary(data) {
    setMetric("db-total-trips", data.totalTrips);
    setMetric("db-total-distance", data.totalDistance, 1);
    setMetric("db-avg-speed", data.avgSpeed, 1);
    setMetric("db-max-speed", data.maxSpeed, 1);
    setMetric("db-hard-braking", data.hardBrakingCounts);
    setMetric("db-hard-accel", data.hardAccelerationCounts);
    setMetric("db-idling", data.totalIdlingTime / 60, 1); // seconds to min
    setMetric("db-fuel", data.fuelConsumed, 2);
  }

  function renderTrendChart(canvasId, trend, labelKey) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    const labels = trend.map((x) => x[labelKey]);
    const trips = trend.map((x) => x.trips);
    const distance = trend.map((x) => x.distance);
    const hardBraking = trend.map((x) => x.hardBraking);
    const hardAccel = trend.map((x) => x.hardAccel);
    new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Trips",
            data: trips,
            backgroundColor: "#007bff88",
            yAxisID: 'y',
          },
          {
            label: "Distance (mi)",
            data: distance,
            backgroundColor: "#28a74588",
            type: "line",
            borderColor: "#28a745",
            fill: false,
            yAxisID: 'y1',
          },
          {
            label: "Hard Braking",
            data: hardBraking,
            backgroundColor: "#dc354588",
            yAxisID: 'y',
          },
          {
            label: "Hard Accel",
            data: hardAccel,
            backgroundColor: "#ffc10788",
            yAxisID: 'y',
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'top' },
          title: { display: false },
        },
        scales: {
          y: {
            type: 'linear',
            position: 'left',
            title: { display: true, text: 'Count' },
            beginAtZero: true,
          },
          y1: {
            type: 'linear',
            position: 'right',
            title: { display: true, text: 'Distance (mi)' },
            beginAtZero: true,
            grid: { drawOnChartArea: false },
          },
        },
      },
    });
  }

  function renderTable(trend, labelKey) {
    const tbody = document.querySelector("#db-trend-table tbody");
    if (!tbody) return;
    tbody.innerHTML = "";
    trend.forEach((row) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${row[labelKey]}</td>
        <td>${row.trips}</td>
        <td>${row.distance.toFixed(1)}</td>
        <td>${row.hardBraking}</td>
        <td>${row.hardAccel}</td>
      `;
      tbody.appendChild(tr);
    });
    // Initialize DataTable (destroy if already exists)
    if ($.fn.DataTable.isDataTable('#db-trend-table')) {
      $('#db-trend-table').DataTable().destroy();
    }
    $('#db-trend-table').DataTable({
      paging: false,
      searching: false,
      info: false,
      order: [[0, 'asc']],
      responsive: true,
      autoWidth: false,
    });
  }

  async function main() {
    const data = await fetchBehaviorData();
    if (!data) {
      document.querySelector(".container").innerHTML =
        '<div class="alert alert-danger">Failed to load analytics data.</div>';
      return;
    }
    renderSummary(data);
    renderTrendChart("db-weekly-chart", data.weekly, "week");
    renderTrendChart("db-monthly-chart", data.monthly, "month");

    // Add toggle for table
    const tableContainer = document.querySelector("#db-trend-table").parentElement;
    const toggleDiv = document.createElement("div");
    toggleDiv.className = "mb-2";
    toggleDiv.innerHTML = `
      <div class="btn-group" role="group">
        <button type="button" class="btn btn-outline-primary btn-sm" id="toggle-weekly">Weekly</button>
        <button type="button" class="btn btn-outline-primary btn-sm active" id="toggle-monthly">Monthly</button>
      </div>
    `;
    tableContainer.parentElement.insertBefore(toggleDiv, tableContainer);

    function setActive(btnId) {
      document.getElementById("toggle-weekly").classList.remove("active");
      document.getElementById("toggle-monthly").classList.remove("active");
      document.getElementById(btnId).classList.add("active");
    }

    document.getElementById("toggle-weekly").addEventListener("click", () => {
      setActive("toggle-weekly");
      renderTable(data.weekly, "week");
    });
    document.getElementById("toggle-monthly").addEventListener("click", () => {
      setActive("toggle-monthly");
      renderTable(data.monthly, "month");
    });

    // Default table: monthly
    renderTable(data.monthly, "month");
  }

  document.addEventListener("DOMContentLoaded", main);
})(); 