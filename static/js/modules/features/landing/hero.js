import { getRemainingDriveableMiles } from "../navigation-core/coverage-areas.js";

const NEAR_DONE_PERCENT = 85;

export function updateMastheadDate(elements = {}) {
  if (!elements.mastheadDate) {
    return;
  }
  const now = new Date();
  elements.mastheadDate.textContent = now.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  elements.mastheadDate.setAttribute("datetime", now.toISOString().slice(0, 10));
}

/**
 * The coverage area most recently driven in, or null when no area has a
 * drive timestamp yet.
 */
export function selectMissionArea(areas) {
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
 * Name, progress, and remaining miles for the mission area, plus the
 * region it sits in (its county, when the display name carries one).
 */
export function describeMission(areas) {
  const area = selectMissionArea(areas);
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
  const remaining = getRemainingDriveableMiles(area);

  return {
    name,
    region,
    pct,
    remaining,
    done: pct >= 100,
    nearlyDone: pct >= NEAR_DONE_PERCENT && pct < 100,
  };
}

/**
 * One factual sentence about the coverage area most recently driven in.
 * Returns null when there is no usable area yet.
 */
export function buildMissionLine(areas) {
  const mission = describeMission(areas);
  if (!mission) {
    return null;
  }
  const { name, pct, remaining, done } = mission;

  if (done) {
    return `${name} is done. Every street.`;
  }
  if (remaining !== null && remaining > 0) {
    return `${name} is ${pct.toFixed(1)}% driven. ${remaining.toFixed(1)} miles of streets to go.`;
  }
  return `${name} is ${pct.toFixed(1)}% driven.`;
}
