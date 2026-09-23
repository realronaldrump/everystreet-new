/**
 * The journal's progress chart: share of streets driven over calendar time,
 * with new miles per day, week, or month beneath it. The SVG is drawn at
 * the pixel size of its container, so type and strokes are never stretched.
 */

import { escapeHtml } from "../../utils.js";
import {
  addDays,
  bucketSeries,
  bucketUnit,
  daysBetween,
  formatDate,
  formatMiles,
} from "./format.js";

const HEIGHT = 300;
const MARGIN = { top: 18, right: 14, bottom: 30, left: 46 };
const BAR_BAND = 54;
const BAR_GAP = 14;

function niceStep(span) {
  const rough = span / 4;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(rough, 1e-6)));
  for (const factor of [1, 2, 2.5, 5, 10]) {
    if (rough <= factor * magnitude) {
      return factor * magnitude;
    }
  }
  return 10 * magnitude;
}

/**
 * Chart geometry for one range. The line starts at the range's opening
 * level and runs flat to today, so idle months read as idle.
 */
export function buildChartModel({ series, range, today, driveableMiles, currentLevel }) {
  const points = series || [];
  const firstDate = points[0]?.date || today;
  const start =
    range === "all" ? firstDate : addDays(today, range === "365d" ? -364 : -89);
  const openingLevel = points.length
    ? Math.max(
        0,
        Number(points[0].coverage_percentage) -
          (Number(points[0].new_miles || 0) / Math.max(driveableMiles, 1e-9)) * 100
      )
    : Number(currentLevel || 0);
  const startLevel = range === "all" ? 0 : openingLevel;
  const endLevel = points.length ? Number(points.at(-1).coverage_percentage) : startLevel;
  let yMin = 0;
  let yMax = 100;
  if (range === "all") {
    yMax = endLevel > 70 ? 100 : Math.min(100, Math.ceil((endLevel + 5) / 10) * 10);
  } else {
    const spanLevels = Math.max(2, endLevel - startLevel);
    const step = niceStep(spanLevels * 1.4);
    yMin = Math.max(0, Math.floor((startLevel - spanLevels * 0.2) / step) * step);
    yMax = Math.min(100, Math.ceil((endLevel + spanLevels * 0.2) / step) * step);
    if (yMax <= yMin) {
      yMax = Math.min(100, yMin + step);
    }
  }
  const spanDays = Math.max(1, daysBetween(start, today));
  const unit = bucketUnit(spanDays);
  return {
    range,
    start,
    end: today,
    spanDays,
    startLevel,
    points,
    yMin,
    yMax,
    yStep: niceStep(yMax - yMin),
    unit,
    bars: bucketSeries(points, unit),
  };
}

function scales(model, width) {
  const plotLeft = MARGIN.left;
  const plotRight = Math.max(plotLeft + 40, width - MARGIN.right);
  const lineTop = MARGIN.top;
  const lineBottom = HEIGHT - MARGIN.bottom - BAR_BAND - BAR_GAP;
  const barTop = lineBottom + BAR_GAP;
  const barBottom = HEIGHT - MARGIN.bottom;
  const x = (dateKey) =>
    plotLeft +
    (Math.max(0, Math.min(model.spanDays, daysBetween(model.start, dateKey))) /
      model.spanDays) *
      (plotRight - plotLeft);
  const y = (level) =>
    lineBottom -
    ((Math.max(model.yMin, Math.min(model.yMax, level)) - model.yMin) /
      Math.max(1e-9, model.yMax - model.yMin)) *
      (lineBottom - lineTop);
  return { plotLeft, plotRight, lineTop, lineBottom, barTop, barBottom, x, y };
}

const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });

function monthLabel(dateKey) {
  const name = MONTH.format(new Date(`${dateKey}T00:00:00Z`));
  return dateKey.slice(5, 7) === "01" ? `${name} ${dateKey.slice(0, 4)}` : name;
}

function timeTicks(model, s) {
  const ticks = [];
  const startYear = Number(model.start.slice(0, 4));
  const endYear = Number(model.end.slice(0, 4));
  if (model.spanDays > 730) {
    const every = endYear - startYear > 8 ? 2 : 1;
    for (let year = startYear + 1; year <= endYear; year += 1) {
      if ((year - startYear) % every === 0) {
        ticks.push({ date: `${year}-01-01`, label: String(year) });
      }
    }
  } else {
    let cursor = `${model.start.slice(0, 7)}-01`;
    const stepMonths = model.spanDays > 200 ? 2 : 1;
    while (cursor <= model.end) {
      if (cursor >= model.start) {
        ticks.push({ date: cursor, label: monthLabel(cursor) });
      }
      const [year, month] = cursor.split("-").map(Number);
      const next = new Date(Date.UTC(year, month - 1 + stepMonths, 1));
      cursor = next.toISOString().slice(0, 10);
    }
  }
  const placed = [];
  for (const tick of ticks) {
    const position = s.x(tick.date);
    if (placed.every((other) => Math.abs(other.x - position) > 52)) {
      placed.push({ ...tick, x: position });
    }
  }
  return placed;
}

function stepPath(model, s) {
  let path = `M${s.x(model.start).toFixed(1)},${s.y(model.startLevel).toFixed(1)}`;
  for (const point of model.points) {
    path += ` H${s.x(point.date).toFixed(1)} V${s.y(point.coverage_percentage).toFixed(1)}`;
  }
  return `${path} H${s.x(model.end).toFixed(1)}`;
}

/** Draw the static chart; returns the scales the cursor layer needs. */
export function renderChart(svg, model, { milestones = [] } = {}) {
  const width = Math.max(280, Math.round(svg.parentElement?.clientWidth || 640));
  svg.setAttribute("viewBox", `0 0 ${width} ${HEIGHT}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(HEIGHT));
  const s = scales(model, width);

  const grid = [];
  for (let level = model.yMin; level <= model.yMax + 1e-9; level += model.yStep) {
    const y = s.y(level).toFixed(1);
    grid.push(
      `<line class="jc-grid" x1="${s.plotLeft}" x2="${s.plotRight}" y1="${y}" y2="${y}"/>` +
        `<text class="jc-axis" x="${s.plotLeft - 8}" y="${Number(y) + 4}" text-anchor="end">${Number(
          level.toFixed(1)
        )}%</text>`
    );
  }

  const ticks = timeTicks(model, s)
    .map(
      (tick) =>
        `<line class="jc-tick" x1="${tick.x.toFixed(1)}" x2="${tick.x.toFixed(1)}" y1="${s.barBottom}" y2="${
          s.barBottom + 5
        }"/><text class="jc-axis" x="${tick.x.toFixed(1)}" y="${s.barBottom + 19}" text-anchor="middle">${escapeHtml(
          tick.label
        )}</text>`
    )
    .join("");

  const line = stepPath(model, s);
  const area = `${line} V${s.lineBottom} H${s.x(model.start).toFixed(1)} Z`;

  const maxBar = Math.max(0.01, ...model.bars.map((bar) => bar.new_miles));
  const nextKey = (key) => {
    if (model.unit === "month") {
      const [year, month] = key.split("-").map(Number);
      return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    }
    return addDays(key, model.unit === "week" ? 7 : 1);
  };
  const bars = model.bars
    .map((bar) => {
      const left = s.x(bar.date < model.start ? model.start : bar.date);
      const right = s.x(nextKey(bar.date) > model.end ? model.end : nextKey(bar.date));
      const width = Math.max(1.5, right - left - 1);
      const height = Math.max(1, (bar.new_miles / maxBar) * BAR_BAND);
      return `<rect class="jc-bar" x="${left.toFixed(1)}" y="${(s.barBottom - height).toFixed(
        1
      )}" width="${width.toFixed(1)}" height="${height.toFixed(1)}"><title>${escapeHtml(
        `${formatDate(bar.date, model.unit === "month" ? "month" : "short")}: ${formatMiles(
          bar.new_miles,
          2
        )}`
      )}</title></rect>`;
    })
    .join("");

  const placedLabels = [];
  const marks = milestones
    .filter((item) => item.date >= model.start && item.date <= model.end)
    .map((item) => {
      const cx = s.x(item.date);
      const cy = s.y(item.level);
      const fits =
        Boolean(item.short) && placedLabels.every((other) => Math.abs(other - cx) > 36);
      if (fits) {
        placedLabels.push(cx);
      }
      // Labels near either end of the plot hang inward instead of past it.
      const anchor =
        cx < s.plotLeft + 24 ? "start" : cx > s.plotRight - 24 ? "end" : "middle";
      const labelX = anchor === "start" ? cx + 6 : anchor === "end" ? cx - 6 : cx;
      return `<g class="jc-milestone" data-milestone="${escapeHtml(item.key)}">
        <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4"/>
        ${
          fits
            ? `<text class="jc-milestone-label" x="${labelX.toFixed(1)}" y="${Math.max(
                s.lineTop + 8,
                cy - 10
              ).toFixed(1)}" text-anchor="${anchor}">${escapeHtml(item.short)}</text>`
            : ""
        }
        <title>${escapeHtml(`${item.label}: ${formatDate(item.date, "long")}`)}</title>
      </g>`;
    })
    .join("");

  svg.innerHTML = `<title id="journal-chart-title">Share of streets driven over time</title>
    <desc id="journal-chart-desc">${escapeHtml(describeChart(model))}</desc>
    <g aria-hidden="true">
      ${grid.join("")}
      <line class="jc-baseline" x1="${s.plotLeft}" x2="${s.plotRight}" y1="${s.barBottom}" y2="${
        s.barBottom
      }"/>
      ${bars}
      <path class="jc-area" d="${area}"/>
      <path class="jc-line" d="${line}"/>
      ${marks}
      ${ticks}
      <g class="jc-cursor" id="journal-chart-cursor">
        <line x1="0" x2="0" y1="${s.lineTop}" y2="${s.barBottom}"/>
        <circle cx="0" cy="0" r="5"/>
      </g>
      <g class="jc-hover" id="journal-chart-hover" visibility="hidden">
        <line x1="0" x2="0" y1="${s.lineTop}" y2="${s.barBottom}"/>
      </g>
    </g>`;
  return s;
}

export function describeChart(model) {
  if (!model.points.length) {
    return "No new streets in this range.";
  }
  const last = model.points.at(-1);
  return `${model.points.length} days with new streets between ${formatDate(
    model.start,
    "long"
  )} and ${formatDate(model.end, "long")}, reaching ${Number(
    last.coverage_percentage
  ).toFixed(1)} percent.`;
}

/** Nearest series index for a pointer x position. */
export function nearestIndex(model, s, clientX, svg) {
  if (!model.points.length) {
    return -1;
  }
  const bounds = svg.getBoundingClientRect();
  const viewX = ((clientX - bounds.left) / Math.max(1, bounds.width)) * (s.plotRight + MARGIN.right);
  let best = 0;
  let distance = Infinity;
  model.points.forEach((point, index) => {
    const gap = Math.abs(s.x(point.date) - viewX);
    if (gap < distance) {
      best = index;
      distance = gap;
    }
  });
  return best;
}

export function placeCursor(svg, model, s, index, id = "journal-chart-cursor") {
  const group = svg.querySelector(`#${id}`);
  const point = model.points[index];
  if (!group || !point) {
    group?.setAttribute("visibility", "hidden");
    return;
  }
  const x = s.x(point.date).toFixed(1);
  group.setAttribute("visibility", "visible");
  const line = group.querySelector("line");
  line?.setAttribute("x1", x);
  line?.setAttribute("x2", x);
  const dot = group.querySelector("circle");
  dot?.setAttribute("cx", x);
  dot?.setAttribute("cy", s.y(point.coverage_percentage).toFixed(1));
}
