/**
 * Chart.js rendering for the Routes page. Inks, fonts, and tooltips come
 * from the global chart theme; this module sets layout and series colors.
 */

import { readToken } from "../../core/theme-tokens.js";
import {
  formatHourLabel,
  formatMonthLabel,
  formatTripCount,
  routeStrokeColor,
} from "./format.js";
import {
  computeDistanceStats,
  fillMissingMonthlyBuckets,
  formatDistanceRange,
} from "./insights.js";

const getEl = (id) => document.getElementById(id);

// Chart instances for the route modal (destroyed on each modal open)
let chartMonthly = null;
let chartHour = null;
let chartDow = null;
let chartDistTrend = null;

/* ───── Chart.js defaults ─────
   Inks, fonts, and tooltips come from the global chart theme
   (core/library-loader.js); these set layout only. */
export function getChartDefaults() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 400 },
    plugins: {
      legend: { display: false },
      tooltip: {},
    },
    scales: {
      x: {
        ticks: { font: { size: 11 } },
        grid: { display: false },
        border: { display: false },
      },
      y: {
        ticks: { font: { size: 11 } },
        border: { display: false },
        beginAtZero: true,
      },
    },
  };
}

/** A palette ink as a hex color with the given opacity (0 to 1). */
export function tokenWithAlpha(name, alpha) {
  const alphaHex = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${readToken(name)}${alphaHex}`;
}

export function destroyChartRef(chartRef) {
  try {
    chartRef?.destroy();
  } catch {
    /* ok */
  }
  return null;
}

export function destroyCanvasChart(canvas) {
  if (!canvas || typeof Chart === "undefined" || typeof Chart.getChart !== "function") {
    return;
  }
  try {
    Chart.getChart(canvas)?.destroy();
  } catch {
    /* ok */
  }
}

export function setChartEmptyState(canvasId, emptyId, hasData, emptyText) {
  const canvas = getEl(canvasId);
  const empty = getEl(emptyId);
  if (canvas) {
    canvas.classList.toggle("d-none", !hasData);
  }
  if (empty) {
    if (emptyText) {
      empty.textContent = emptyText;
    }
    empty.classList.toggle("d-none", hasData);
  }
}

export function destroyCharts() {
  chartMonthly = destroyChartRef(chartMonthly);
  chartHour = destroyChartRef(chartHour);
  chartDow = destroyChartRef(chartDow);
  chartDistTrend = destroyChartRef(chartDistTrend);
  [
    "route-chart-monthly",
    "route-chart-hour",
    "route-chart-dow",
    "route-chart-distance-trend",
  ].forEach((id) => destroyCanvasChart(getEl(id)));
}

function renderMonthlyChart(data, route) {
  const canvas = getEl("route-chart-monthly");
  if (!canvas || typeof Chart === "undefined") {
    return;
  }
  const byMonth = fillMissingMonthlyBuckets(data?.byMonth);
  const hasData =
    Array.isArray(byMonth) &&
    byMonth.length > 0 &&
    byMonth.some((m) => Number(m?.count || 0) > 0);
  setChartEmptyState(
    "route-chart-monthly",
    "route-chart-monthly-empty",
    hasData,
    "Not enough monthly data for this route."
  );
  if (!hasData) {
    return;
  }

  const labels = byMonth.map((m) => formatMonthLabel(m._id));
  const counts = byMonth.map((m) => m.count);
  const color = routeStrokeColor(route);
  destroyCanvasChart(canvas);
  chartMonthly = destroyChartRef(chartMonthly);

  chartMonthly = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          data: counts,
          backgroundColor: `${color}66`,
          borderColor: color,
          borderWidth: 1.5,
          barPercentage: 0.7,
        },
      ],
    },
    options: {
      ...getChartDefaults(),
      plugins: {
        ...getChartDefaults().plugins,
        tooltip: {
          ...getChartDefaults().plugins.tooltip,
          callbacks: {
            label: (ctx) => `${ctx.parsed.y} trip${ctx.parsed.y !== 1 ? "s" : ""}`,
          },
        },
      },
    },
  });

  // Monthly insight
  const monthlyInsight = getEl("route-chart-monthly-insight");
  if (monthlyInsight) {
    monthlyInsight.textContent = "";
  }
  if (monthlyInsight && byMonth.length >= 1) {
    const recent = counts.slice(-3);
    const earlier = counts.slice(-6, -3);
    const recentTotal = recent.reduce((sum, count) => sum + count, 0);
    if (earlier.length > 0 && recent.length > 0) {
      const recentAvg = recentTotal / recent.length;
      const earlierAvg = earlier.reduce((s, c) => s + c, 0) / earlier.length;
      monthlyInsight.textContent = `Recent 3-mo avg ${recentAvg.toFixed(1)} trips; prior 3-mo avg ${earlierAvg.toFixed(1)}`;
    } else {
      monthlyInsight.textContent = `Recent ${recent.length}-month total ${recentTotal} trip${recentTotal === 1 ? "" : "s"}`;
    }
  }
}

function renderHourChart(data, route) {
  const canvas = getEl("route-chart-hour");
  if (!canvas || typeof Chart === "undefined") {
    return;
  }
  const byHour = data?.byHour || [];
  const hasData =
    Array.isArray(byHour) &&
    byHour.length > 0 &&
    byHour.some((h) => Number(h?.count || 0) > 0);
  setChartEmptyState(
    "route-chart-hour",
    "route-chart-hour-empty",
    hasData,
    "Not enough hourly data for this route."
  );
  if (!hasData) {
    return;
  }

  const labels = byHour.map((h) => formatHourLabel(h.hour));
  const counts = byHour.map((h) => h.count);
  const maxCount = Math.max(...counts, 1);
  const color = routeStrokeColor(route);
  destroyCanvasChart(canvas);
  chartHour = destroyChartRef(chartHour);

  chartHour = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          data: counts,
          backgroundColor: counts.map(
            (c) =>
              `${color}${Math.round((c / maxCount) * 180 + 40)
                .toString(16)
                .padStart(2, "0")}`
          ),
          barPercentage: 0.85,
        },
      ],
    },
    options: {
      ...getChartDefaults(),
      plugins: {
        ...getChartDefaults().plugins,
        tooltip: {
          ...getChartDefaults().plugins.tooltip,
          callbacks: {
            label: (ctx) => `${ctx.parsed.y} trip${ctx.parsed.y !== 1 ? "s" : ""}`,
          },
        },
      },
    },
  });

  // Hourly insight
  const hourInsight = getEl("route-chart-hour-insight");
  if (hourInsight) {
    hourInsight.textContent = "";
    const peak = byHour.reduce(
      (a, b) => ((b?.count || 0) > (a?.count || 0) ? b : a),
      byHour[0]
    );
    if (peak && peak.count > 0) {
      hourInsight.textContent = `Peak departure: ${formatHourLabel(peak.hour)}\u2013${formatHourLabel((peak.hour + 1) % 24)} with ${peak.count} trip${peak.count !== 1 ? "s" : ""}`;
    }
  }
}

function renderDowChart(data, route) {
  const canvas = getEl("route-chart-dow");
  if (!canvas || typeof Chart === "undefined") {
    return;
  }
  const byDay = data?.byDayOfWeek || [];
  const hasData =
    Array.isArray(byDay) &&
    byDay.length > 0 &&
    byDay.some((d) => Number(d?.count || 0) > 0);
  setChartEmptyState(
    "route-chart-dow",
    "route-chart-dow-empty",
    hasData,
    "Not enough day-of-week data for this route."
  );
  if (!hasData) {
    return;
  }

  const labels = byDay.map((d) => d.dayName);
  const counts = byDay.map((d) => d.count);
  const maxCount = Math.max(...counts, 1);
  const color = routeStrokeColor(route);
  destroyCanvasChart(canvas);
  chartDow = destroyChartRef(chartDow);

  chartDow = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          data: counts,
          backgroundColor: counts.map(
            (c) =>
              `${color}${Math.round((c / maxCount) * 180 + 40)
                .toString(16)
                .padStart(2, "0")}`
          ),
          barPercentage: 0.65,
        },
      ],
    },
    options: {
      ...getChartDefaults(),
      plugins: {
        ...getChartDefaults().plugins,
        tooltip: {
          ...getChartDefaults().plugins.tooltip,
          callbacks: {
            label: (ctx) => `${ctx.parsed.y} trip${ctx.parsed.y !== 1 ? "s" : ""}`,
          },
        },
      },
    },
  });

  // Day of week insight
  const dowInsight = getEl("route-chart-dow-insight");
  if (dowInsight) {
    dowInsight.textContent = "";
    const peak = byDay.reduce(
      (a, b) => ((b?.count || 0) > (a?.count || 0) ? b : a),
      byDay[0]
    );
    if (peak && peak.count > 0) {
      dowInsight.textContent = `${peak.dayName} is most active with ${peak.count} trip${peak.count !== 1 ? "s" : ""}`;
    }
  }
}

function renderDistanceTrendChart(data, route) {
  const canvas = getEl("route-chart-distance-trend");
  if (!canvas || typeof Chart === "undefined") {
    return;
  }
  const timeline = data?.timeline || [];
  const hasData =
    Array.isArray(timeline) &&
    timeline.filter((t) => Number.isFinite(Number(t?.distance))).length > 1;
  setChartEmptyState(
    "route-chart-distance-trend",
    "route-chart-distance-trend-empty",
    hasData,
    "Not enough trend data for this route."
  );
  if (!hasData) {
    return;
  }

  const labels = timeline.map((t) => {
    const d = new Date(t.startTime);
    return Number.isNaN(d.getTime())
      ? ""
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  });
  const distances = timeline.map((t) => t.distance);
  const durations = timeline.map((t) => (t.duration != null ? t.duration / 60 : null));
  const color = routeStrokeColor(route);
  const defaults = getChartDefaults();
  destroyCanvasChart(canvas);
  chartDistTrend = destroyChartRef(chartDistTrend);

  chartDistTrend = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Distance (mi)",
          data: distances,
          borderColor: color,
          backgroundColor: `${color}22`,
          fill: true,
          tension: 0.3,
          pointRadius: 2,
          pointHoverRadius: 5,
          borderWidth: 2,
          yAxisID: "y",
        },
        {
          label: "Duration (min)",
          data: durations,
          borderColor: readToken("--cat-ochre"),
          backgroundColor: "transparent",
          borderDash: [4, 3],
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 1.5,
          yAxisID: "y1",
        },
      ],
    },
    options: {
      ...defaults,
      plugins: {
        ...defaults.plugins,
        legend: {
          display: true,
          labels: { padding: 8 },
        },
        tooltip: {
          ...defaults.plugins.tooltip,
          callbacks: {
            label: (ctx) =>
              ctx.datasetIndex === 0
                ? `${Number(ctx.parsed.y).toFixed(1)} mi`
                : `${Number(ctx.parsed.y).toFixed(0)} min`,
          },
        },
      },
      scales: {
        ...defaults.scales,
        x: {
          ...defaults.scales.x,
          ticks: { ...defaults.scales.x.ticks, maxTicksLimit: 8 },
        },
        y: {
          ...defaults.scales.y,
          title: {
            display: true,
            text: "Miles",
            font: { size: 11 },
          },
        },
        y1: {
          position: "right",
          ticks: { font: { size: 11 } },
          grid: { display: false },
          border: { display: false },
          beginAtZero: true,
          title: {
            display: true,
            text: "Minutes",
            font: { size: 11 },
          },
        },
      },
    },
  });

  // Distance trend insight
  const trendInsight = getEl("route-chart-trend-insight");
  if (trendInsight) {
    trendInsight.textContent = "";
  }
  if (trendInsight && distances.length >= 2) {
    const distanceStats = computeDistanceStats(data);
    if (distanceStats) {
      trendInsight.textContent =
        Math.abs(distanceStats.max - distanceStats.min) < 0.05
          ? `Average ${distanceStats.mean.toFixed(1)} mi across ${formatTripCount(distanceStats.count)}`
          : `Average ${distanceStats.mean.toFixed(1)} mi; range ${formatDistanceRange(distanceStats)} across ${formatTripCount(distanceStats.count)}`;
    }
  }
}

/** Draw the four route modal charts for one route. */
export function renderRouteCharts(data, route) {
  renderMonthlyChart(data, route);
  renderHourChart(data, route);
  renderDowChart(data, route);
  renderDistanceTrendChart(data, route);
}
