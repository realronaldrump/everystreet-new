/**
 * Streak Heatmap Module
 *
 * Renders a GitHub-style contribution heatmap grid showing driving activity.
 * Color intensity = miles driven or streets covered per day.
 */

const WEEKS_TO_SHOW = 26; // ~6 months
const CELL_SIZE = 13;
const CELL_GAP = 3;
const MONTH_LABEL_HEIGHT = 18;

const INTENSITY_COLORS = [
  "var(--surface-3, #1e1e22)", // no activity
  "rgba(77, 154, 106, 0.3)", // light
  "rgba(77, 154, 106, 0.5)", // medium
  "rgba(77, 154, 106, 0.7)", // heavy
  "rgba(77, 154, 106, 0.95)", // max
];

function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseLocalDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return startOfLocalDay(value);
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const [yearRaw, monthRaw, dayRaw] = value.split("-");
  const year = Number.parseInt(yearRaw, 10);
  const month = Number.parseInt(monthRaw, 10);
  const day = Number.parseInt(dayRaw, 10);
  if (!year || !month || !day) {
    return null;
  }

  return new Date(year, month - 1, day);
}

function formatLocalDateKey(date) {
  const normalized = startOfLocalDay(date);
  const year = normalized.getFullYear();
  const month = String(normalized.getMonth() + 1).padStart(2, "0");
  const day = String(normalized.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildHeatmapWindow({ endDate = null, weeksToShow = WEEKS_TO_SHOW } = {}) {
  const resolvedEndDate = parseLocalDate(endDate) || startOfLocalDay(new Date());
  const dayOfWeek = resolvedEndDate.getDay(); // 0=Sun
  const startDate = new Date(resolvedEndDate);
  startDate.setDate(startDate.getDate() - (weeksToShow * 7) - dayOfWeek);

  return {
    startDate,
    endDate: resolvedEndDate,
    totalWeeks: weeksToShow + 1,
  };
}

class StreakHeatmap {
  /**
   * Render a driving streak heatmap into a container element.
   * @param {HTMLElement} container - Target DOM element
   * @param {Object} data - Driving data
   * @param {Array} data.dailyDistances - Array of { date: string, distance: number }
   * @param {number} data.currentStreak - Current driving streak in days
   * @param {number} data.longestStreak - Longest ever streak
   * @param {string|Date} data.endDate - Inclusive range end date used to anchor the grid
   */
  render(container, data) {
    if (!container || !data?.dailyDistances) return;

    container.innerHTML = "";
    container.className = "streak-heatmap-container";

    const {
      dailyDistances,
      currentStreak = 0,
      longestStreak = 0,
      endDate: rangeEndDate = null,
    } = data;

    // Build date → distance map
    const distanceMap = new Map();
    let maxDistance = 0;
    for (const entry of dailyDistances) {
      const d = Number(entry.distance) || 0;
      distanceMap.set(entry.date, d);
      if (d > maxDistance) maxDistance = d;
    }

    // Build grid data for the requested window, not always "today"
    const {
      startDate,
      endDate,
      totalWeeks,
    } = buildHeatmapWindow({ endDate: rangeEndDate });

    // Streak header
    const header = document.createElement("div");
    header.className = "streak-heatmap-header";
    header.innerHTML = `
      <div class="streak-stat streak-current">
        <span class="streak-value">${currentStreak}</span>
        <span class="streak-label">day streak${currentStreak === 1 ? "" : "s"}</span>
        ${currentStreak >= 3 ? '<i class="fas fa-fire streak-fire"></i>' : ""}
      </div>
      <div class="streak-stat streak-longest">
        <span class="streak-value">${longestStreak}</span>
        <span class="streak-label">longest streak</span>
      </div>
    `;
    container.appendChild(header);

    // SVG grid
    const svgWidth = totalWeeks * (CELL_SIZE + CELL_GAP) + 30;
    const svgHeight = 7 * (CELL_SIZE + CELL_GAP) + MONTH_LABEL_HEIGHT + 5;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "streak-heatmap-svg");
    svg.setAttribute("viewBox", `0 0 ${svgWidth} ${svgHeight}`);
    svg.setAttribute("aria-label", "Driving activity heatmap");

    // Day labels
    const dayLabels = ["", "Mon", "", "Wed", "", "Fri", ""];
    dayLabels.forEach((label, i) => {
      if (!label) return;
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", "0");
      text.setAttribute("y", String(MONTH_LABEL_HEIGHT + i * (CELL_SIZE + CELL_GAP) + CELL_SIZE - 2));
      text.setAttribute("class", "streak-day-label");
      text.textContent = label;
      svg.appendChild(text);
    });

    // Month labels (placed at week boundaries)
    let lastMonth = -1;
    for (let week = 0; week <= WEEKS_TO_SHOW; week++) {
      const weekStart = new Date(startDate);
      weekStart.setDate(weekStart.getDate() + week * 7);
      const month = weekStart.getMonth();
      if (month !== lastMonth) {
        lastMonth = month;
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", String(28 + week * (CELL_SIZE + CELL_GAP)));
        text.setAttribute("y", "12");
        text.setAttribute("class", "streak-month-label");
        text.textContent = weekStart.toLocaleDateString("en-US", { month: "short" });
        svg.appendChild(text);
      }
    }

    // Cells
    for (let week = 0; week <= WEEKS_TO_SHOW; week++) {
      for (let day = 0; day < 7; day++) {
        const cellDate = new Date(startDate);
        cellDate.setDate(cellDate.getDate() + week * 7 + day);

        if (cellDate > endDate) continue;

        const dateStr = formatLocalDateKey(cellDate);
        const distance = distanceMap.get(dateStr) || 0;
        const intensity = this._getIntensity(distance, maxDistance);

        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("x", String(28 + week * (CELL_SIZE + CELL_GAP)));
        rect.setAttribute("y", String(MONTH_LABEL_HEIGHT + day * (CELL_SIZE + CELL_GAP)));
        rect.setAttribute("width", String(CELL_SIZE));
        rect.setAttribute("height", String(CELL_SIZE));
        rect.setAttribute("rx", "2");
        rect.setAttribute("class", "streak-cell");
        rect.style.fill = INTENSITY_COLORS[intensity];

        // Tooltip
        const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
        title.textContent = distance > 0
          ? `${cellDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}: ${distance.toFixed(1)} mi`
          : `${cellDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}: No driving`;
        rect.appendChild(title);

        svg.appendChild(rect);
      }
    }

    container.appendChild(svg);

    // Legend
    const legend = document.createElement("div");
    legend.className = "streak-heatmap-legend";
    legend.innerHTML = `
      <span class="streak-legend-label">Less</span>
      ${INTENSITY_COLORS.map((c) => `<span class="streak-legend-cell" style="background: ${c}"></span>`).join("")}
      <span class="streak-legend-label">More</span>
    `;
    container.appendChild(legend);
  }

  _getIntensity(distance, maxDistance) {
    if (distance <= 0) return 0;
    if (maxDistance <= 0) return 1;
    const ratio = distance / maxDistance;
    if (ratio < 0.15) return 1;
    if (ratio < 0.4) return 2;
    if (ratio < 0.7) return 3;
    return 4;
  }
}

const streakHeatmap = new StreakHeatmap();
export { buildHeatmapWindow, formatLocalDateKey, StreakHeatmap };
export default streakHeatmap;
