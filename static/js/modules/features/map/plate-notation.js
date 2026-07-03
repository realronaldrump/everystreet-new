/**
 * Plate notation — the cartographic caption on the map's lower edge.
 * Center coordinates, zoom, and the active date range, set in mono
 * microtype like a chart plate. Purely informational.
 */

import store from "../../core/store.js";
import { DateUtils } from "../../utils.js";

const rangeFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function formatCoords(center) {
  const lat = Math.abs(center.lat).toFixed(4);
  const lon = Math.abs(center.lng).toFixed(4);
  const ns = center.lat >= 0 ? "N" : "S";
  const ew = center.lng >= 0 ? "E" : "W";
  return `${lat}°${ns} ${lon}°${ew}`;
}

function formatRange() {
  const start = DateUtils.getStartDate();
  const end = DateUtils.getEndDate();
  if (!start || !end) {
    return "--";
  }
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return "--";
  }
  if (start === end) {
    return rangeFmt.format(startDate);
  }
  return `${rangeFmt.format(startDate)} – ${rangeFmt.format(endDate)}`;
}

export default function initPlateNotation({ registerCleanup }) {
  const coordsEl = document.getElementById("plate-coords");
  const zoomEl = document.getElementById("plate-zoom");
  const rangeEl = document.getElementById("plate-range");
  const map = store.map || window.map;
  if (!coordsEl || !zoomEl || !rangeEl || !map?.on) {
    return;
  }

  let rafId = null;

  const syncView = () => {
    rafId = null;
    try {
      coordsEl.textContent = formatCoords(map.getCenter());
      zoomEl.textContent = `Z${map.getZoom().toFixed(1)}`;
    } catch {
      /* map may be mid-teardown */
    }
  };

  const requestSync = () => {
    if (rafId === null) {
      rafId = requestAnimationFrame(syncView);
    }
  };

  const syncRange = () => {
    rangeEl.textContent = formatRange();
  };

  map.on("move", requestSync);
  document.addEventListener("es:filters-change", syncRange);
  document.addEventListener("filtersApplied", syncRange);

  registerCleanup(() => {
    map.off?.("move", requestSync);
    document.removeEventListener("es:filters-change", syncRange);
    document.removeEventListener("filtersApplied", syncRange);
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  });

  syncView();
  syncRange();
}
