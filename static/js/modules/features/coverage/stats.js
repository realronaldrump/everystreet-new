import metricAnimator from "../../ui/metric-animator.js";
import { formatDistance, formatRelativeTimeShort } from "../../utils.js";

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
  return formatDistance(miles, { decimals: 2, fallback: "0 mi" });
}

export function formatRelativeTime(isoString) {
  return formatRelativeTimeShort(isoString, {
    suffix: " ago",
    capitalize: true,
    fallback: "Just now",
  });
}
