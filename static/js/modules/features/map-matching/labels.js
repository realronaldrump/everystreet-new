/**
 * Map Matching labels: provider and engine names, stage messages, failure
 * reasons, dates, and the response shapes the page reads. Pure functions.
 */

import { createCoordinateBounds } from "../../utils/bounds.js";

const TERMINAL_STAGES = new Set(["completed", "failed", "error", "cancelled"]); // r=42
const PROVIDER_LABELS = {
  auto: "Auto",
  valhalla_only: "Valhalla only",
  mapbox_only: "Mapbox only",
};

// Friendly messages for different stages
export const FRIENDLY_MESSAGES = {
  queued: "Getting ready...",
  processing: "Matching trips to roads...",
  completed: "All done!",
  failed: "Something went wrong",
  error: "Something went wrong",
  cancelled: "Cancelled by user",
};

// User-friendly failure reasons
export function formatFailureReason(matchStatus) {
  if (!matchStatus) {
    return "Unknown issue";
  }

  const status = String(matchStatus).toLowerCase();

  if (status.startsWith("skipped:no-gps") || status.includes("no gps")) {
    return "No GPS data recorded";
  }
  if (status.startsWith("skipped:single-point") || status.includes("single point")) {
    return "Only one location point";
  }
  if (status.startsWith("skipped:insufficient") || status.includes("insufficient")) {
    return "Not enough coordinates";
  }
  if (status.startsWith("error:no-geometry") || status.includes("no geometry")) {
    return "No route geometry returned";
  }
  if (status.startsWith("error:") || status.includes("error")) {
    // Extract message after 'error:'
    const msg = status.replace(/^error:/, "").trim();
    if (msg && msg !== "error") {
      return msg.charAt(0).toUpperCase() + msg.slice(1);
    }
    return "Route matching failed";
  }
  if (status.startsWith("skipped:")) {
    const reason = status
      .replace(/^skipped:/, "")
      .replace(/-/g, " ")
      .trim();
    return reason.charAt(0).toUpperCase() + reason.slice(1);
  }

  return matchStatus;
}

export function normalizeProviderPolicy(value) {
  const normalized = String(value || "auto")
    .trim()
    .toLowerCase();
  return Object.hasOwn(PROVIDER_LABELS, normalized) ? normalized : "auto";
}

export function providerPolicyFallbackLabel(policy) {
  const normalized = normalizeProviderPolicy(policy);
  if (normalized === "valhalla_only") {
    return "Valhalla only";
  }
  if (normalized === "mapbox_only") {
    return "Mapbox only";
  }
  return "Auto: Valhalla first, Mapbox fallback";
}

export function providerBadgeLabel(metrics = {}) {
  const valhalla = Number(metrics.valhalla_matched || 0);
  const mapbox = Number(metrics.mapbox_matched || 0);
  const fallbackAttempted =
    Number(metrics.fallback_attempted || 0) > 0 ||
    Number(metrics.fallback_matched || 0) > 0;
  if ((valhalla > 0 && mapbox > 0) || fallbackAttempted) {
    return "Valhalla + Mapbox";
  }
  if (mapbox > 0) {
    return "Mapbox";
  }
  if (
    valhalla > 0 ||
    normalizeProviderPolicy(metrics.provider_policy) !== "mapbox_only"
  ) {
    return "Valhalla";
  }
  return "Mapbox";
}

export function formatSummaryCount(value) {
  return Number(value || 0).toLocaleString();
}

export function formatAttemptSummary(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    return "";
  }
  return attempts
    .filter((attempt) => attempt && typeof attempt === "object")
    .map((attempt) => {
      const provider =
        String(attempt.provider || "")
          .trim()
          .toLowerCase() === "mapbox"
          ? "Mapbox"
          : "Valhalla";
      const detail = attempt.message || attempt.status || "";
      return detail ? `${provider}: ${detail}` : provider;
    })
    .join("; ");
}

export function isTerminalStage(stage) {
  return stage ? TERMINAL_STAGES.has(stage) : false;
}

export function formatFriendlyDate(dateStr) {
  if (!dateStr) {
    return "";
  }
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  if (days === 1) {
    return "Yesterday";
  }
  if (days < 7) {
    return date.toLocaleDateString([], { weekday: "long" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function formatTripDate(startTime, _endTime) {
  if (!startTime) {
    return "Unknown date";
  }
  const start = new Date(startTime);
  const dateStr = start.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const timeStr = start.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${dateStr} at ${timeStr}`;
}

export function buildBoundsFromGeojson(geojson) {
  if (!geojson?.features?.length) {
    return null;
  }
  const bounds = createCoordinateBounds();

  geojson.features.forEach((feature) => {
    const geometry = feature?.geometry;
    if (!geometry) {
      return;
    }
    const { type, coordinates } = geometry;
    if (type === "LineString") {
      coordinates.forEach((coord) => bounds.extend(coord));
    } else if (type === "MultiLineString") {
      coordinates.forEach((line) => {
        line.forEach((coord) => bounds.extend(coord));
      });
    } else if (type === "Point") {
      bounds.extend(coordinates);
    }
  });
  return bounds.toValue();
}

export function normalizeMatchedTripsResponse(response) {
  if (!response) {
    return { trips: [], geojson: null, total: 0 };
  }

  const asFeatureCollection =
    response?.type === "FeatureCollection" && Array.isArray(response?.features)
      ? response
      : response?.geojson?.type === "FeatureCollection" &&
          Array.isArray(response?.geojson?.features)
        ? response.geojson
        : null;

  const explicitTrips = Array.isArray(response?.trips) ? response.trips : null;
  if (explicitTrips) {
    const total = response?.total ?? explicitTrips.length;
    return { trips: explicitTrips, geojson: asFeatureCollection, total };
  }

  if (asFeatureCollection) {
    const trips = asFeatureCollection.features
      .map((feature) => {
        if (!feature) {
          return null;
        }
        const props = feature.properties || {};
        return {
          ...props,
          transactionId: props.transactionId || feature.id || "",
          matchedGps: feature.geometry || props.matchedGps || null,
        };
      })
      .filter(Boolean);

    return { trips, geojson: asFeatureCollection, total: trips.length };
  }

  return {
    trips: [],
    geojson: asFeatureCollection || response?.geojson || null,
    total: 0,
  };
}
