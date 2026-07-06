/**
 * Places lens — where trips end.
 *
 * Lists saved places ranked by visits (from the visits API) and turns
 * on the destination-bloom visualization while the lens is active.
 */

import store from "../../core/store.js";
import { escapeHtml, utils } from "../../utils.js";
import destinationBloom from "./destination-bloom.js";

const lastVisitFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function geometryBounds(geometry) {
  if (!geometry) {
    return null;
  }
  const bounds = {
    west: Infinity,
    south: Infinity,
    east: -Infinity,
    north: -Infinity,
  };
  let found = false;

  const walk = (coords) => {
    if (!Array.isArray(coords)) {
      return;
    }
    if (
      coords.length >= 2 &&
      Number.isFinite(coords[0]) &&
      Number.isFinite(coords[1]) &&
      !Array.isArray(coords[0])
    ) {
      bounds.west = Math.min(bounds.west, coords[0]);
      bounds.south = Math.min(bounds.south, coords[1]);
      bounds.east = Math.max(bounds.east, coords[0]);
      bounds.north = Math.max(bounds.north, coords[1]);
      found = true;
      return;
    }
    coords.forEach(walk);
  };

  walk(geometry.coordinates);
  if (!found) {
    return null;
  }
  return [
    [bounds.west, bounds.south],
    [bounds.east, bounds.north],
  ];
}

export default function createPlacesLens({ registerCleanup }) {
  const list = document.getElementById("places-list");
  const emptyNote = document.getElementById("places-empty");

  let isActive = false;
  let loaded = false;

  const on = (target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
    registerCleanup(() => target.removeEventListener(eventName, handler, options));
  };

  const renderPlaces = async ({ fresh = false } = {}) => {
    if (!list || loaded) {
      return;
    }
    loaded = true;

    try {
      const cacheTime = fresh ? 0 : undefined;
      const [places, stats] = await Promise.all([
        utils.fetchWithRetry("/api/places", {}, undefined, cacheTime),
        utils.fetchWithRetry("/api/places/statistics", {}, undefined, cacheTime),
      ]);
      const statsById = new Map(
        (Array.isArray(stats) ? stats : []).map((s) => [String(s.id), s])
      );
      const rows = (Array.isArray(places) ? places : [])
        .map((place) => ({
          place,
          stats: statsById.get(String(place.id)) || null,
        }))
        .sort((a, b) => (b.stats?.totalVisits || 0) - (a.stats?.totalVisits || 0));

      list.replaceChildren();
      if (emptyNote) {
        emptyNote.hidden = rows.length > 0;
      }

      rows.forEach(({ place, stats: placeStats }) => {
        const li = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "place-row";

        const visits = Number(placeStats?.totalVisits || 0);
        const lastVisit = placeStats?.lastVisit
          ? lastVisitFmt.format(new Date(placeStats.lastVisit))
          : null;
        const metaParts = [];
        if (lastVisit) {
          metaParts.push(`Last visit ${lastVisit}`);
        }
        if (placeStats?.averageTimeSpent) {
          metaParts.push(`~${placeStats.averageTimeSpent} per stop`);
        }

        const metaHtml = metaParts.length
          ? `<span class="place-meta">${escapeHtml(metaParts.join(" · "))}</span>`
          : "";
        const visitsHtml = `${visits.toLocaleString()} visit${visits === 1 ? "" : "s"}`;
        button.innerHTML = `<span><span class="place-name">${escapeHtml(place.name || "Unnamed place")}</span>${metaHtml}</span><span class="place-visits">${visitsHtml}</span>`;

        button.addEventListener("click", () => {
          const bounds = geometryBounds(place.geometry);
          const map = store.map || window.map;
          if (bounds && map?.fitBounds) {
            map.fitBounds(bounds, { padding: 120, maxZoom: 16, duration: 1000 });
          }
        });

        li.appendChild(button);
        list.appendChild(li);
      });
    } catch (error) {
      loaded = false;
      console.warn("Failed to load places:", error);
      if (emptyNote) {
        emptyNote.hidden = false;
        emptyNote.textContent = "Places are unavailable right now.";
      }
    }
  };

  // Keep the bloom fed as data or styles change while the lens is active.
  const refreshBloom = () => {
    if (isActive && destinationBloom.isActive()) {
      setTimeout(() => destinationBloom.refresh(), 200);
    }
  };
  on(document, "tripsDataLoaded", refreshBloom);
  on(document, "matchedTripsDataLoaded", refreshBloom);
  on(document, "es:filters-change", refreshBloom);
  on(document, "mapStyleLoaded", refreshBloom);

  // A place saved from the bloom tooltip should appear in the list.
  on(document, "destinationBloom:placeSaved", () => {
    loaded = false;
    if (isActive) {
      renderPlaces({ fresh: true });
    }
  });

  registerCleanup(() => {
    if (destinationBloom.isActive()) {
      destinationBloom.destroy();
    }
  });

  return {
    id: "places",
    activate() {
      isActive = true;
      renderPlaces();
      if (!destinationBloom.isActive()) {
        destinationBloom.activate();
      }
    },
    deactivate() {
      isActive = false;
      if (destinationBloom.isActive()) {
        destinationBloom.deactivate();
      }
    },
  };
}
