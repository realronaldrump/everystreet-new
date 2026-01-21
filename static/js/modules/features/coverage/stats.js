import metricAnimator from "../../ui/metric-animator.js";

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
  if (miles === null || miles === undefined) {
    return "0 mi";
  }
  return `${miles.toFixed(2)} mi`;
}

export function formatRelativeTime(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) {
    return "Just now";
  }
  if (diffMins < 60) {
    return `${diffMins}m ago`;
  }
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }
  if (diffDays < 30) {
    return `${Math.floor(diffDays / 7)}w ago`;
  }
  return `${Math.floor(diffDays / 30)}mo ago`;
}
