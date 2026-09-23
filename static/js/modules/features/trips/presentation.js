/**
 * How a trip reads on the Trips page: its title, badges, route summary,
 * durations, and preview path. Pure functions of a trip record.
 */

import {
  formatDateTime,
  formatDuration,
  formatRelativeTimeLong,
  sanitizeLocation,
  toFiniteNumber,
} from "../../utils.js";
import { readToken } from "../../core/theme-tokens.js";

// ==========================================
// SMART TITLE GENERATION
// ==========================================

export function getLocationText(location) {
  const text = sanitizeLocation(location);
  if (!text || text === "Unknown" || text === "--") {
    return "";
  }
  return text;
}

export function generateSmartTitle(trip) {
  const distance = parseFloat(trip.distance) || 0;
  const startLocText = getLocationText(trip.startLocation);
  const endLocText = getLocationText(trip.destination);
  const startLoc = startLocText.toLowerCase();
  const endLoc = endLocText.toLowerCase();
  const startTime = new Date(trip.startTime);
  const hour = startTime.getHours();
  const day = startTime.getDay();

  // Determine trip characteristics
  const isWeekend = day === 0 || day === 6;
  const isEvening = hour >= 17;
  const isMorning = hour >= 6 && hour < 12;
  const isShort = distance < 5;
  const isLong = distance > 50;
  const isCommute =
    (startLoc.includes("home") && endLoc.includes("work")) ||
    (startLoc.includes("work") && endLoc.includes("home")) ||
    (startLoc.includes("home") && endLoc.includes("office")) ||
    (startLoc.includes("office") && endLoc.includes("home"));

  // Smart title logic — prefer the most informative label first
  if (isCommute) {
    return isMorning ? "Morning Commute" : "Evening Commute";
  }

  // Use destination if available
  if (endLocText) {
    const dest = endLocText.split(",")[0];
    if (dest && dest.length < 30) {
      return `Trip to ${dest}`;
    }
  }

  if (isShort) {
    return "Quick Trip";
  }

  if (isLong) {
    return "Long Drive";
  }

  if (isWeekend && distance > 10) {
    return "Weekend Drive";
  }

  if (isEvening && distance > 5) {
    return "Evening Drive";
  }

  return "Trip";
}

export function getTripBadges(trip) {
  const badges = [];
  if (trip.isLongest) {
    badges.push({ text: "Longest", class: "new" });
  }
  if (trip.isFrequentRoute) {
    badges.push({ text: "Frequent", class: "frequent" });
  }

  return badges;
}

export function isInactiveTrip(trip) {
  return Boolean(trip?.inactive);
}

export function splitTripsByActiveState(trips = []) {
  const active = [];
  const inactive = [];

  trips.forEach((trip) => {
    if (isInactiveTrip(trip)) {
      inactive.push(trip);
    } else {
      active.push(trip);
    }
  });

  return { active, inactive };
}

export function getTripPreviewPath(trip) {
  const previewPath = trip?.previewPath;
  return sanitizeSvgPath(previewPath);
}

function sanitizeSvgPath(value) {
  if (!value || typeof value !== "string") {
    return null;
  }
  const cleaned = value.trim().replace(/[^0-9MLml.,\s-]/g, "");
  return cleaned.length > 0 ? cleaned : null;
}

export function getTripUiColors() {
  return {
    primary: readToken("--primary", "#8fa6b4"),
    success: readToken("--success", "#8fa6b4"),
    stroke: readToken("--text-primary", "#ece2cb"),
  };
}

export function formatRelativeTime(dateStr) {
  return formatRelativeTimeLong(dateStr, {
    capitalize: true,
    maxDays: 7,
    default: "--",
    yesterdayLabel: "Yesterday",
    fallbackFormatter: () => formatDateTime(dateStr),
  });
}

export function formatTripDuration(value) {
  const number = toFiniteNumber(value);
  return number === null || number <= 0 ? "--" : formatDuration(number);
}

export function formatRouteSummary(trip) {
  const start = sanitizeLocation(trip.startLocation);
  const end = sanitizeLocation(trip.destination);
  if (start && end && start !== "--" && end !== "--") {
    return `${start} to ${end}`;
  }
  if (end && end !== "--") {
    return `To ${end}`;
  }
  if (start && start !== "--") {
    return `From ${start}`;
  }
  return "Route unavailable";
}

export function shortId(value) {
  if (!value) {
    return "--";
  }
  const text = String(value);
  return text.length > 12 ? `${text.slice(0, 7)}...${text.slice(-4)}` : text;
}
