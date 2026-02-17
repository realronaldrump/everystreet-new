import metricAnimator from "../../ui/metric-animator.js";
import { formatDistance, formatRelativeTimeShort } from "../../utils.js";

/**
 * Returns a CSS class representing the coverage tier for a given percentage.
 * Used by both the area card mini-rings and the sidebar large ring.
 */
export function getCoverageTierClass(pct) {
  if (pct >= 100) return "tier-complete";
  if (pct >= 76) return "tier-success";
  if (pct >= 51) return "tier-info";
  if (pct >= 26) return "tier-warning";
  return "tier-danger";
}

/**
 * Clamps a coverage percentage value to the range [0, 100].
 */
export function normalizeCoveragePercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric));
}

export function setMetricValue(elementId, value, { decimals = 0, suffix = "" } = {}) {
  const element = document.getElementById(elementId);
  if (!element) {
    return;
  }
  const numeric = Number(value) || 0;
  if (metricAnimator?.animate) {
    metricAnimator.animate(element, numeric, { decimals, suffix });
  } else {
    element.textContent = `${numeric.toFixed(decimals)}${suffix}`;
  }
}

export function formatMiles(miles) {
  return formatDistance(miles, { decimals: 2, default: "0 mi" });
}

export function formatRelativeTime(isoString) {
  return formatRelativeTimeShort(isoString, {
    suffix: " ago",
    capitalize: true,
    default: "Just now",
  });
}
