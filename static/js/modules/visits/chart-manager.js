/* global Chart */

import MapStyles from "../map-styles.js";

class VisitsChartManager {
  constructor(canvasId) {
    const ctx = document.getElementById(canvasId)?.getContext("2d");
    if (!ctx || typeof Chart === "undefined") {
      this.chart = null;
      return;
    }

    Chart.defaults.color = "rgba(255, 255, 255, 0.8)";
    Chart.defaults.font.family =
      "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

    const gradient = ctx.createLinearGradient(0, 0, 0, 400);
    gradient.addColorStop(0, "rgba(184, 122, 74, 0.8)");
    gradient.addColorStop(1, "rgba(184, 122, 74, 0.1)");

    this.chart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: [],
        datasets: [
          {
            label: "Visits",
            data: [],
            backgroundColor: gradient,
            borderColor: "#b87a4a",
            borderWidth: 2,
            borderRadius: 8,
            borderSkipped: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: {
          duration: 1000,
          easing: "easeInOutQuart",
        },
        interaction: {
          mode: "index",
          intersect: false,
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              stepSize: 1,
              color: "rgba(255, 255, 255, 0.75)",
              font: { weight: "400", size: 11 },
              padding: 10,
            },
            grid: {
              color: "rgba(255, 255, 255, 0.08)",
              drawBorder: false,
            },
          },
          x: {
            ticks: {
              color: "rgba(255, 255, 255, 0.8)",
              font: { weight: "500", size: 12 },
              maxRotation: 45,
              minRotation: 45,
            },
            grid: {
              display: false,
              drawBorder: false,
            },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "rgba(30, 30, 30, 0.95)",
            titleColor: MapStyles.MAP_LAYER_COLORS?.customPlaces?.fill,
            bodyColor: "rgba(255, 255, 255, 0.9)",
            borderColor: MapStyles.MAP_LAYER_COLORS?.customPlaces?.outline,
            borderWidth: 1,
            padding: 12,
            cornerRadius: 8,
            titleFont: { weight: "600", size: 14 },
            bodyFont: { weight: "400", size: 13 },
            displayColors: false,
            callbacks: {
              label: (context) => `Visits: ${context.parsed.y}`,
            },
          },
        },
      },
    });
  }

  update(stats, onBarClick) {
    if (!this.chart) {
      return;
    }

    this.chart.options.onClick = (_event, elements) => {
      if (!elements.length || !onBarClick) {
        return;
      }
      const chartElement = elements[0];
      const placeName = this.chart.data.labels[chartElement.index];
      onBarClick(placeName);
    };

    this.chart.options.onHover = (_event, elements) => {
      this.chart.canvas.style.cursor = elements.length > 0 ? "pointer" : "default";
    };

    this.chart.data.labels = stats.slice(0, 10).map((d) => d.name);
    this.chart.data.datasets[0].data = stats.slice(0, 10).map((d) => d.totalVisits);
    this.chart.update("active");
  }

  destroy() {
    this.chart?.destroy();
  }
}

export { VisitsChartManager };
export default VisitsChartManager;
