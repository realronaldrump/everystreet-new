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
    if (el)
      el.textContent =
        value !== undefined && value !== null
          ? Number(value).toFixed(digits)
          : "-";
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

  // Helper: Convert 'YYYY-Www' to date range string (e.g., '2024-W10' => '2024-03-04 to 2024-03-10')
  function weekKeyToDateRange(weekKey) {
    // weekKey: 'YYYY-Www'
    const match = weekKey.match(/(\d{4})-W(\d{2})/);
    if (!match) return weekKey;
    const year = parseInt(match[1], 10);
    const week = parseInt(match[2], 10);
    // Get Monday of the week
    const simple = new Date(year, 0, 1 + (week - 1) * 7);
    const dow = simple.getDay();
    const monday = new Date(simple);
    if (dow <= 4) {
      // Mon-Thu: go back to Monday
      monday.setDate(simple.getDate() - simple.getDay() + 1);
    } else {
      // Fri-Sun: go forward to next Monday
      monday.setDate(simple.getDate() + 8 - simple.getDay());
    }
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    // Format as YYYY-MM-DD
    const fmt = (d) => d.toISOString().slice(0, 10);
    return `${fmt(monday)} to ${fmt(sunday)}`;
  }

  function renderTrendChart(canvasId, trend, labelKey) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    const labels = trend.map((x) =>
      labelKey === "week" ? weekKeyToDateRange(x[labelKey]) : x[labelKey],
    );
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
            yAxisID: "y",
          },
          {
            label: "Distance (mi)",
            data: distance,
            backgroundColor: "#28a74588",
            type: "line",
            borderColor: "#28a745",
            fill: false,
            yAxisID: "y1",
          },
          {
            label: "Hard Braking",
            data: hardBraking,
            backgroundColor: "#dc354588",
            yAxisID: "y",
          },
          {
            label: "Hard Accel",
            data: hardAccel,
            backgroundColor: "#ffc10788",
            yAxisID: "y",
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: "top" },
          title: { display: false },
        },
        scales: {
          y: {
            type: "linear",
            position: "left",
            title: { display: true, text: "Count" },
            beginAtZero: true,
          },
          y1: {
            type: "linear",
            position: "right",
            title: { display: true, text: "Distance (mi)" },
            beginAtZero: true,
            grid: { drawOnChartArea: false },
          },
        },
      },
    });
  }

  function renderTable(trend, labelKey) {
    const table = document.querySelector("#db-trend-table");
    const tbody = table.querySelector("tbody");
    if (!tbody) return;

    // Destroy DataTable if exists
    if ($.fn.DataTable.isDataTable(table)) {
      $(table).DataTable().destroy();
    }

    // Fade out
    tbody.classList.add("fade-table-out");

    setTimeout(() => {
      // Clear tbody
      tbody.innerHTML = "";

      // Insert new rows
      trend.forEach((row) => {
        const tr = document.createElement("tr");
        const label =
          labelKey === "week"
            ? weekKeyToDateRange(row[labelKey])
            : row[labelKey];
        tr.innerHTML = `
          <td>${label}</td>
          <td>${row.trips}</td>
          <td>${row.distance.toFixed(1)}</td>
          <td>${row.hardBraking}</td>
          <td>${row.hardAccel}</td>
        `;
        tbody.appendChild(tr);
      });

      // Fade in
      tbody.classList.remove("fade-table-out");
      tbody.classList.add("fade-table-in");

      // Re-initialize DataTable after DOM update
      setTimeout(() => {
        $(table).DataTable({
          paging: false,
          searching: false,
          info: false,
          order: [[0, "asc"]],
          responsive: true,
          autoWidth: false,
        });
        // Remove fade-in class after animation
        setTimeout(() => {
          tbody.classList.remove("fade-table-in");
        }, 200);
      }, 0);
    }, 200); // Match fade-out duration
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
    const tableContainer =
      document.querySelector("#db-trend-table").parentElement;
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
