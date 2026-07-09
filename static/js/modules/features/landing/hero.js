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
 * One factual sentence about the primary coverage area, e.g.
 * "Waco is 62.4% driven — 31.8 miles of streets to go."
 * Returns null when there is no usable area yet.
 */
export function buildMissionLine(areas) {
  if (!Array.isArray(areas) || areas.length === 0) {
    return null;
  }

  const primary = areas.reduce((best, area) => {
    const size = Number(area?.total_length_miles) || 0;
    const bestSize = Number(best?.total_length_miles) || 0;
    return size > bestSize ? area : best;
  }, null);

  const name = primary?.display_name?.split(",")[0]?.trim();
  const pct = Number(primary?.coverage_percentage);
  if (!name || !Number.isFinite(pct)) {
    return null;
  }

  const total = Number(primary?.total_length_miles);
  const driven = Number(primary?.driven_length_miles);
  const remaining =
    Number.isFinite(total) && Number.isFinite(driven) ? total - driven : null;

  if (remaining !== null && remaining > 0 && pct < 100) {
    return `${name} is ${pct.toFixed(1)}% driven — ${remaining.toFixed(1)} miles of streets to go.`;
  }
  if (pct >= 100) {
    return `${name} is done. Every street.`;
  }
  return `${name} is ${pct.toFixed(1)}% driven.`;
}
