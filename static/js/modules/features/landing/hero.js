import { getRemainingDriveableMiles } from "../navigation-core/coverage-areas.js";

export function updateMastheadDate(elements = {}) {
  if (!elements.mastheadDate) {
    return;
  }
  elements.mastheadDate.textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/**
 * One factual sentence about the coverage area most recently driven in.
 * Returns null when there is no usable area yet.
 */
export function buildMissionLine(areas) {
  if (!Array.isArray(areas) || areas.length === 0) {
    return null;
  }

  const primary = areas.reduce((latest, area) => {
    const drivenAt = Date.parse(area?.last_coverage_trip_at ?? "");
    if (!Number.isFinite(drivenAt)) {
      return latest;
    }

    const latestDrivenAt = Date.parse(latest?.last_coverage_trip_at ?? "");
    return !latest || !Number.isFinite(latestDrivenAt) || drivenAt > latestDrivenAt
      ? area
      : latest;
  }, null);

  const name = primary?.display_name?.split(",")[0]?.trim();
  const pct = Number(primary?.coverage_percentage);
  if (!name || !Number.isFinite(pct)) {
    return null;
  }

  const remaining = getRemainingDriveableMiles(primary);

  if (remaining !== null && remaining > 0 && pct < 100) {
    return `${name} is ${pct.toFixed(1)}% driven — ${remaining.toFixed(1)} miles of streets to go.`;
  }
  if (pct >= 100) {
    return `${name} is done. Every street.`;
  }
  return `${name} is ${pct.toFixed(1)}% driven.`;
}
