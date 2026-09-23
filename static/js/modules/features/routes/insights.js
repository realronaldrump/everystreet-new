/**
 * Route insight computations: pure functions that turn route summaries and
 * analytics into the sentences, ranges, and buckets the Routes page prints.
 */

import { formatMiles } from "../../utils.js";
import {
  formatDateCompact,
  formatHourLabel,
  formatTripCount,
  formatTripsPerWeekLabel,
  formatWeekCount,
  parseDate,
} from "./format.js";

const MS_PER_DAY = 86400000;
const MS_PER_WEEK = 7 * MS_PER_DAY;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function sundayWeekStartUtc(date) {
  const day = date.getUTCDay(); // 0=Sun ... 6=Sat
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day);
}

function computeCoveredWeeks(route) {
  const first = parseDate(route?.first_start_time);
  const last = parseDate(route?.last_start_time);
  if (!first && !last) {
    return 0;
  }

  const start =
    first && last && last.getTime() < first.getTime() ? last : first || last;
  const end = first && last && last.getTime() < first.getTime() ? first : last || first;

  const firstWeekStart = sundayWeekStartUtc(start);
  const lastWeekStart = sundayWeekStartUtc(end);
  return Math.floor((lastWeekStart - firstWeekStart) / MS_PER_WEEK) + 1;
}

function computeTripsPerWeek(route) {
  const trips = Number(route?.trip_count || 0);
  if (trips <= 0) {
    return 0;
  }
  const coveredWeeks = computeCoveredWeeks(route);
  if (coveredWeeks <= 0) {
    return 0;
  }
  return trips / coveredWeeks;
}

export function resolveTripsPerWeek(route, analyticsData) {
  const apiTripsPerWeek = Number(analyticsData?.tripsPerWeek);
  if (Number.isFinite(apiTripsPerWeek) && apiTripsPerWeek > 0) {
    return apiTripsPerWeek;
  }
  return computeTripsPerWeek(route);
}

export function buildRouteActivityTag(route) {
  const lastSeen = parseDate(route?.last_start_time);
  if (lastSeen) {
    return `Last seen ${formatDateCompact(lastSeen)}`;
  }
  const tripCount = Number(route?.trip_count || 0);
  return tripCount > 0 ? formatTripCount(tripCount) : "Summary unavailable";
}

export function buildCardInsightSentence(route) {
  const parts = [];
  const coveredWeeks = computeCoveredWeeks(route);
  const tripsPerWeek = formatTripsPerWeekLabel(computeTripsPerWeek(route));

  if (coveredWeeks > 0) {
    parts.push(`Observed across ${formatWeekCount(coveredWeeks)}`);
  }
  if (tripsPerWeek) {
    parts.push(tripsPerWeek);
  }

  if (parts.length > 0) {
    return parts.join(" · ");
  }

  const tripCount = Number(route?.trip_count || 0);
  return tripCount > 0 ? `${formatTripCount(tripCount)} logged` : "Summary unavailable";
}

export function computeHeroInsights(summary) {
  const routeCount = Number(summary?.route_count || 0);
  const totalTrips = Number(summary?.trip_count || 0);
  if (routeCount === 0) {
    return { dna: "", spotlight: "" };
  }

  const totalMiles = summary?.total_miles == null ? null : Number(summary.total_miles);
  const totalHours = summary?.total_hours == null ? null : Number(summary.total_hours);

  const parts = [
    `${routeCount.toLocaleString()} recurring routes across ${totalTrips.toLocaleString()} trips`,
  ];
  if (Number.isFinite(totalMiles)) {
    const milesStr =
      totalMiles >= 1000
        ? `${(totalMiles / 1000).toFixed(1)}k`
        : Math.round(totalMiles).toLocaleString();
    parts.push(`covering ${milesStr} miles`);
  }
  if (Number.isFinite(totalHours)) {
    const hoursStr =
      totalHours >= 100
        ? `${Math.round(totalHours).toLocaleString()}`
        : totalHours.toFixed(0);
    parts.push(`${hoursStr} hours on the road`);
  }
  const dna = `${parts.join(" · ")}.`;

  const top = summary?.most_frequent;
  const spotlight = top ? `Most driven: ${top.name} with ${top.trip_count} trips.` : "";

  return { dna, spotlight };
}

function computePeakDeparture(analyticsData) {
  const byHour = analyticsData?.byHour;
  if (!Array.isArray(byHour) || byHour.length === 0) {
    return null;
  }
  const peak = byHour.reduce(
    (a, b) => ((b?.count || 0) > (a?.count || 0) ? b : a),
    byHour[0]
  );
  if (!peak || (peak.count || 0) === 0) {
    return null;
  }
  const h = peak.hour;
  const nextH = (h + 1) % 24;
  return {
    hour: h,
    label: `${formatHourLabel(h)}\u2013${formatHourLabel(nextH)}`,
    count: peak.count,
  };
}

function computeWeekdayShare(analyticsData) {
  const byDay = analyticsData?.byDayOfWeek;
  if (!Array.isArray(byDay) || byDay.length === 0) {
    return null;
  }
  const total = byDay.reduce((s, d) => s + (d?.count || 0), 0);
  if (total === 0) {
    return null;
  }
  const weekday = byDay
    .filter((d) => {
      const idx = DAY_NAMES.indexOf(d.dayName);
      return idx >= 1 && idx <= 5;
    })
    .reduce((s, d) => s + (d?.count || 0), 0);
  return Math.round((weekday / total) * 100);
}

export function buildModalInsightSentence(route, analyticsData) {
  const parts = [];
  const tripCount = Number(route?.trip_count || 0);
  const coveredWeeks = computeCoveredWeeks(route);
  const tripsPerWeek = formatTripsPerWeekLabel(
    resolveTripsPerWeek(route, analyticsData)
  );

  if (tripCount > 0 && coveredWeeks > 0) {
    parts.push(
      `${formatTripCount(tripCount)} across ${formatWeekCount(coveredWeeks)}${tripsPerWeek ? ` (${tripsPerWeek})` : ""}`
    );
  } else if (tripCount > 0) {
    parts.push(`${formatTripCount(tripCount)} logged`);
  }
  const peak = computePeakDeparture(analyticsData);
  if (peak) {
    parts.push(`Peak departure ${peak.label} (${formatTripCount(peak.count)})`);
  }
  const weekdayShare = computeWeekdayShare(analyticsData);
  if (weekdayShare !== null) {
    parts.push(`Weekdays ${weekdayShare}% of trips`);
  }
  if (parts.length === 0) {
    return `${buildRouteActivityTag(route)}.`;
  }
  return `${parts.join(". ")}.`;
}

export function computeDistanceStats(analyticsData) {
  const timelineDistances = Array.isArray(analyticsData?.timeline)
    ? analyticsData.timeline
        .map((trip) => Number(trip?.distance))
        .filter((distance) => Number.isFinite(distance) && distance > 0)
    : [];

  if (timelineDistances.length > 0) {
    const min = Math.min(...timelineDistances);
    const max = Math.max(...timelineDistances);
    const mean =
      timelineDistances.reduce((sum, distance) => sum + distance, 0) /
      timelineDistances.length;
    return {
      count: timelineDistances.length,
      min,
      max,
      mean,
    };
  }

  return null;
}

function parseMonthIndex(value) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(value || ""));
  if (!match) {
    return null;
  }
  return Number(match[1]) * 12 + Number(match[2]) - 1;
}

function formatMonthIndex(index) {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function fillMissingMonthlyBuckets(byMonth = []) {
  const countsByMonth = new Map();
  for (const entry of Array.isArray(byMonth) ? byMonth : []) {
    const index = parseMonthIndex(entry?._id);
    if (index === null) {
      continue;
    }
    const count = Number(entry?.count);
    countsByMonth.set(
      index,
      (countsByMonth.get(index) || 0) + (Number.isFinite(count) ? count : 0)
    );
  }
  const indices = [...countsByMonth.keys()].sort((a, b) => a - b);
  if (indices.length === 0) {
    return [];
  }
  const buckets = [];
  for (let index = indices[0]; index <= indices.at(-1); index += 1) {
    buckets.push({
      _id: formatMonthIndex(index),
      count: countsByMonth.get(index) || 0,
    });
  }
  return buckets;
}

export function formatDistanceRange(stats) {
  if (!stats) {
    return "--";
  }
  if (Math.abs(stats.max - stats.min) < 0.05) {
    return formatMiles(stats.mean);
  }
  return `${stats.min.toFixed(1)}-${stats.max.toFixed(1)} mi`;
}

function normalizePlaceLabel(label) {
  return String(label || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function buildVisitsLink({ placeId, label }) {
  const cleanedId = String(placeId || "").trim();
  if (cleanedId) {
    return `/visits?place=${encodeURIComponent(cleanedId)}`;
  }
  const normalizedLabel = normalizePlaceLabel(label);
  if (normalizedLabel) {
    return `/visits?place_name=${encodeURIComponent(normalizedLabel)}`;
  }
  return "/visits";
}
