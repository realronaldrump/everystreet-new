/**
 * The open area's sidebar figures: coverage ring, mileage and segment
 * counts, last activity, and the completion stamp.
 */

import {
  getDriveableMiles,
  getRemainingDriveableMiles,
} from "../navigation-core/coverage-areas.js";
import { formatDate, formatPercent } from "../coverage-journal/format.js";
import {
  getCoverageTierClass,
  normalizeCoveragePercent,
  setMetricValue,
} from "./stats.js";
import { apiGet, state } from "./context.js";

// Ring math: r=60, cx/cy=70, viewBox 140×140
const RING_R = 60;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_R;

export async function refreshDashboardStats(areaId) {
  try {
    const data = await apiGet(`/areas/${areaId}`, { cache: false });
    if (areaId !== state.currentAreaId) {
      return;
    }
    const { area } = data;
    if (!area) {
      return;
    }
    state.currentAreaData = area;
    state.currentAreaSyncToken = `${area.area_version}:${area.coverage_revision}`;
    updateStatsUI(area);
  } catch (error) {
    console.error("Failed to refresh stats:", error);
  }
}

// =============================================================================
// Stats UI + Progress Ring
// =============================================================================

export function updateStatsUI(area) {
  const pct = normalizeCoveragePercent(area.coverage_percentage);

  // Large ring
  const ringFillEl = document.querySelector("#ring-svg .progress-ring-fill");
  if (ringFillEl) {
    renderProgressRing(ringFillEl, pct);
  }

  // Ring center label and map chip; neither prints 100% before the area is done.
  const pctText = formatPercent(pct, { complete: area.is_complete === true });
  for (const id of ["ring-pct-value", "map-coverage-pct"]) {
    const element = document.getElementById(id);
    if (element) {
      element.textContent = pctText;
    }
  }

  // Quick stats
  const driveableMiles = getDriveableMiles(area);
  const remaining = getRemainingDriveableMiles(area);
  setMetricValue("qs-driven", area.driven_length_miles || 0, {
    decimals: 1,
    suffix: " mi",
  });
  if (remaining === null) {
    const remainingEl = document.getElementById("qs-remaining");
    if (remainingEl) {
      remainingEl.textContent = "—";
    }
  } else {
    setMetricValue("qs-remaining", remaining, { decimals: 1, suffix: " mi" });
  }
  if (driveableMiles === null) {
    const totalEl = document.getElementById("qs-total");
    if (totalEl) {
      totalEl.textContent = "—";
    }
  } else {
    setMetricValue("qs-total", driveableMiles, { decimals: 1, suffix: " mi" });
  }

  const undrivenSegs = area.remaining_segments;
  setMetricValue("qs-segments-remaining", undrivenSegs);

  // Segment breakdown
  setMetricValue("seg-driven", area.driven_segments);
  setMetricValue("seg-undriven", area.remaining_segments);
  setMetricValue("seg-undriveable", area.undriveable_segments);

  // Last activity
  const lastActivityEl = document.getElementById("qs-last-activity");
  if (lastActivityEl) {
    lastActivityEl.textContent = area.last_coverage_trip_at
      ? formatDate(area.last_coverage_trip_at, "short")
      : "—";
  }

  // A finished area is stamped complete in the sidebar.
  document
    .getElementById("coverage-sidebar")
    ?.classList.toggle("is-complete", area?.is_complete === true);
}

function renderProgressRing(fillEl, pct) {
  const offset = RING_CIRCUMFERENCE - (pct / 100) * RING_CIRCUMFERENCE;
  fillEl.style.strokeDashoffset = offset.toFixed(2);

  // Update tier class
  const tierClass = getCoverageTierClass(pct);
  Array.from(fillEl.classList)
    .filter((className) => className.startsWith("tier-"))
    .forEach((className) => fillEl.classList.remove(className));
  fillEl.classList.add("progress-ring-fill", tierClass);
}
