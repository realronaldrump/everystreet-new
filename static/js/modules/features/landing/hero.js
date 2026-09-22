import { getRemainingDriveableMiles } from "../navigation-core/coverage-areas.js";

export function updateMastheadDate(elements = {}) {
  if (!elements.mastheadDate) {
    return;
  }
  const now = new Date();
  elements.mastheadDate.textContent = now.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  elements.mastheadDate.setAttribute("datetime", now.toISOString().slice(0, 10));
}

/**
 * The coverage area most recently driven in, or null when no area has a
 * drive timestamp yet.
 */
export function selectRecentArea(areas) {
  if (!Array.isArray(areas) || areas.length === 0) {
    return null;
  }

  return areas.reduce((latest, area) => {
    const drivenAt = Date.parse(area?.last_coverage_trip_at ?? "");
    if (!Number.isFinite(drivenAt)) {
      return latest;
    }

    const latestDrivenAt = Date.parse(latest?.last_coverage_trip_at ?? "");
    return !latest || !Number.isFinite(latestDrivenAt) || drivenAt > latestDrivenAt
      ? area
      : latest;
  }, null);
}

/**
 * Name, progress, and remaining miles for the most recently driven area,
 * plus the region it sits in (its county, when the display name has one).
 */
export function describeRecentArea(areas) {
  const area = selectRecentArea(areas);
  const parts = String(area?.display_name ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const name = parts[0];
  const pct = Number(area?.coverage_percentage);
  if (!name || !Number.isFinite(pct)) {
    return null;
  }

  const region =
    parts
      .slice(1)
      .find((part) => !/^\d/.test(part) && !/^united states$/i.test(part)) || null;

  return {
    name,
    region,
    pct,
    remaining: getRemainingDriveableMiles(area),
    done: pct >= 100,
  };
}

/** ": 90.8% driven, 2.8 mi left" for a described area. */
export function formatAreaFigures(area) {
  const figures = [`${area.pct.toFixed(1)}% driven`];
  if (!area.done && area.remaining !== null && area.remaining > 0) {
    figures.push(`${area.remaining.toFixed(1)} mi left`);
  }
  return `: ${figures.join(", ")}`;
}

/**
 * One line of figures for the coverage area most recently driven in.
 * Returns null when there is no usable area yet.
 */
export function buildAreaSummary(areas) {
  const area = describeRecentArea(areas);
  return area ? `${area.name}${formatAreaFigures(area)}` : null;
}
