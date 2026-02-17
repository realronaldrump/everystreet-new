/**
 * Derived Insights Module
 * Pure data derivations for the insights experience.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toNumber(value, defaultValue = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseYmdUtc(value) {
  if (typeof value !== "string") {
    return null;
  }
  const [yearRaw, monthRaw, dayRaw] = value.split("-");
  const year = Number.parseInt(yearRaw, 10);
  const month = Number.parseInt(monthRaw, 10);
  const day = Number.parseInt(dayRaw, 10);
  if (!year || !month || !day) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day));
}

function formatYmdUtc(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "";
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatWeekLabel(start) {
  return `Week of ${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(start)}`;
}

function formatMonthLabel(year, monthIndex) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, monthIndex, 1)));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function pct(numerator, denominator) {
  if (!denominator) {
    return 0;
  }
  return (numerator / denominator) * 100;
}

function formatSignedNumber(value, decimals = 0, unit = "") {
  const numeric = toNumber(value);
  const sign = numeric > 0 ? "+" : numeric < 0 ? "-" : "";
  const absValue = Math.abs(numeric);
  const base = decimals > 0 ? absValue.toFixed(decimals) : String(Math.round(absValue));
  return `${sign}${base}${unit}`;
}

function formatHourAmPm(hourRaw) {
  const hour = clamp(Math.round(toNumber(hourRaw, 0)), 0, 23);
  const suffix = hour >= 12 ? "PM" : "AM";
  const display = hour % 12 || 12;
  return `${display} ${suffix}`;
}

function selectMomentumLabel(distanceDeltaPct, tripsDelta) {
  if (!Number.isFinite(distanceDeltaPct)) {
    return "No prior period";
  }
  if (Math.abs(distanceDeltaPct) < 1) {
    return "Within 1%";
  }
  if (distanceDeltaPct > 0 && tripsDelta > 0) {
    return "Trips and distance up";
  }
  if (distanceDeltaPct < 0 && tripsDelta < 0) {
    return "Trips and distance down";
  }
  if (distanceDeltaPct > 0) {
    return "Distance up";
  }
  return "Distance down";
}

function selectPeriodHeadline(distanceDelta, tripsDelta) {
  if (!Number.isFinite(distanceDelta) || !Number.isFinite(tripsDelta)) {
    return "No prior-period comparison available";
  }
  return `Trips ${formatSignedNumber(tripsDelta)}, Distance ${formatSignedNumber(distanceDelta, 1, " mi")}`;
}

function buildPeriodSummary(period) {
  const trips = toNumber(period?.trips);
  const distance = toNumber(period?.distance);
  const avgTrip = trips > 0 ? distance / trips : 0;
  return `${trips} trips • ${distance.toFixed(1)} mi • ${avgTrip.toFixed(1)} mi/trip`;
}

function getWeekStartUtc(date) {
  const start = new Date(date);
  const day = start.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  start.setUTCDate(start.getUTCDate() - diffToMonday);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

export function aggregatePeriods(dailyDistances = [], mode = "weekly") {
  const normalizedMode = mode === "monthly" ? "monthly" : "weekly";
  const buckets = new Map();

  dailyDistances.forEach((entry) => {
    const date = parseYmdUtc(entry?.date);
    if (!date) {
      return;
    }

    const distance = toNumber(entry?.distance);
    const count = toNumber(entry?.count);

    let key = "";
    let label = "";
    let startDate = null;
    let endDate = null;

    if (normalizedMode === "weekly") {
      startDate = getWeekStartUtc(date);
      endDate = new Date(startDate);
      endDate.setUTCDate(startDate.getUTCDate() + 6);
      key = formatYmdUtc(startDate);
      label = formatWeekLabel(startDate);
    } else {
      startDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
      endDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
      key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
      label = formatMonthLabel(date.getUTCFullYear(), date.getUTCMonth());
    }

    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        label,
        start: formatYmdUtc(startDate),
        end: formatYmdUtc(endDate),
        distance: 0,
        trips: 0,
        activeDays: 0,
      });
    }

    const bucket = buckets.get(key);
    bucket.distance += distance;
    bucket.trips += count;
    if (count > 0) {
      bucket.activeDays += 1;
    }
  });

  return [...buckets.values()]
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((period) => {
      const trips = toNumber(period.trips);
      const distance = toNumber(period.distance);
      return {
        ...period,
        distance: Number(distance.toFixed(2)),
        trips,
        avgDistancePerTrip: Number((trips > 0 ? distance / trips : 0).toFixed(2)),
      };
    });
}

export function computePeriodDeltas(periods = []) {
  return periods.map((period, index) => {
    const previous = index > 0 ? periods[index - 1] : null;
    const distanceDelta = previous ? period.distance - previous.distance : NaN;
    const tripsDelta = previous ? period.trips - previous.trips : NaN;
    const distanceDeltaPct =
      previous && previous.distance > 0
        ? ((period.distance - previous.distance) / previous.distance) * 100
        : NaN;

    const momentumLabel = selectMomentumLabel(distanceDeltaPct, tripsDelta);
    const headline = selectPeriodHeadline(distanceDelta, tripsDelta);

    return {
      ...period,
      previousStart: previous?.start || null,
      previousEnd: previous?.end || null,
      previousTrips: previous?.trips ?? null,
      previousDistance: previous?.distance ?? null,
      previousAvgDistancePerTrip: previous?.avgDistancePerTrip ?? null,
      distanceDelta: Number.isFinite(distanceDelta) ? Number(distanceDelta.toFixed(2)) : null,
      tripsDelta: Number.isFinite(tripsDelta) ? tripsDelta : null,
      distanceDeltaPct: Number.isFinite(distanceDeltaPct)
        ? Number(distanceDeltaPct.toFixed(1))
        : null,
      momentumLabel,
      headline,
      summary: buildPeriodSummary(period),
    };
  });
}

export function computeConsistencyStats(dailyDistances = []) {
  const normalized = dailyDistances
    .map((entry) => ({
      date: entry?.date,
      count: toNumber(entry?.count),
      distance: toNumber(entry?.distance),
    }))
    .filter((entry) => parseYmdUtc(entry.date))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (!normalized.length) {
    return {
      longestStreak: 0,
      currentStreak: 0,
      activeDays: 0,
      spanDays: 0,
      activeDaysRatio: 0,
      avgTripsPerActiveDay: 0,
      avgDistancePerActiveDay: 0,
      quietDays: 0,
    };
  }

  const byDate = new Map(normalized.map((entry) => [entry.date, entry]));
  const start = parseYmdUtc(normalized[0].date);
  const end = parseYmdUtc(normalized[normalized.length - 1].date);
  const spanDays = Math.floor((end - start) / MS_PER_DAY) + 1;

  let longestStreak = 0;
  let currentStreak = 0;
  let runningStreak = 0;
  let activeDays = 0;
  let totalTrips = 0;
  let totalDistance = 0;

  for (let cursor = 0; cursor < spanDays; cursor += 1) {
    const date = new Date(start.getTime() + cursor * MS_PER_DAY);
    const key = formatYmdUtc(date);
    const day = byDate.get(key);
    const count = toNumber(day?.count);
    const distance = toNumber(day?.distance);

    if (count > 0) {
      runningStreak += 1;
      activeDays += 1;
      totalTrips += count;
      totalDistance += distance;
    } else {
      runningStreak = 0;
    }

    longestStreak = Math.max(longestStreak, runningStreak);
    if (cursor === spanDays - 1) {
      currentStreak = runningStreak;
    }
  }

  return {
    longestStreak,
    currentStreak,
    activeDays,
    spanDays,
    quietDays: Math.max(0, spanDays - activeDays),
    activeDaysRatio: Number(pct(activeDays, spanDays).toFixed(1)),
    avgTripsPerActiveDay: Number((activeDays > 0 ? totalTrips / activeDays : 0).toFixed(2)),
    avgDistancePerActiveDay: Number(
      (activeDays > 0 ? totalDistance / activeDays : 0).toFixed(2)
    ),
  };
}

export function computeTimeSignature(timeDistribution = [], weekdayDistribution = []) {
  const hourly = new Array(24).fill(0);
  timeDistribution.forEach((entry) => {
    const hour = toNumber(entry?.hour, -1);
    if (hour >= 0 && hour <= 23) {
      hourly[hour] += toNumber(entry?.count);
    }
  });

  const weekday = new Array(7).fill(0);
  weekdayDistribution.forEach((entry) => {
    const day = toNumber(entry?.day, -1);
    if (day >= 0 && day <= 6) {
      weekday[day] += toNumber(entry?.count);
    }
  });

  const dayNames = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];

  const totalTrips = hourly.reduce((sum, count) => sum + count, 0);
  const peakHour = hourly.reduce(
    (best, count, hour) => (count > best.count ? { hour, count } : best),
    { hour: 0, count: -1 }
  );
  const quietHour = hourly.reduce(
    (best, count, hour) => (count < best.count ? { hour, count } : best),
    { hour: 0, count: Number.POSITIVE_INFINITY }
  );

  const peakDay = weekday.reduce(
    (best, count, day) => (count > best.count ? { day, count } : best),
    { day: 0, count: -1 }
  );
  const quietDay = weekday.reduce(
    (best, count, day) => (count < best.count ? { day, count } : best),
    { day: 0, count: Number.POSITIVE_INFINITY }
  );

  const weightedHourRaw =
    totalTrips > 0
      ? hourly.reduce((sum, count, hour) => sum + hour * count, 0) / totalTrips
      : 0;

  const topThreeHours = [...hourly].sort((a, b) => b - a).slice(0, 3);
  const concentration = totalTrips > 0 ? topThreeHours.reduce((s, c) => s + c, 0) / totalTrips : 0;

  const dayparts = {
    dawn: hourly.slice(5, 9).reduce((sum, count) => sum + count, 0),
    daytime: hourly.slice(9, 17).reduce((sum, count) => sum + count, 0),
    evening:
      hourly.slice(17, 22).reduce((sum, count) => sum + count, 0) +
      hourly.slice(0, 1).reduce((sum, count) => sum + count, 0),
    lateNight: hourly.slice(22, 24).reduce((sum, count) => sum + count, 0) + hourly[1] + hourly[2] + hourly[3] + hourly[4],
  };

  const dominantDaypart = Object.entries(dayparts).reduce(
    (best, candidate) => (candidate[1] > best[1] ? candidate : best),
    ["dawn", 0]
  )[0];

  const daypartLabel = {
    dawn: "Early morning",
    daytime: "Daytime",
    evening: "Evening",
    lateNight: "Late night",
  }[dominantDaypart];

  return {
    hourly,
    weekday,
    totalTrips,
    peakHour: peakHour.hour,
    quietHour: quietHour.hour,
    peakHourCount: Math.max(0, peakHour.count),
    quietHourCount: Number.isFinite(quietHour.count) ? quietHour.count : 0,
    weightedHour: Number(weightedHourRaw.toFixed(1)),
    concentrationScore: Number((concentration * 100).toFixed(1)),
    dominantDaypart,
    dominantDaypartLabel: daypartLabel,
    peakDay: peakDay.day,
    peakDayLabel: dayNames[peakDay.day] || dayNames[0],
    peakDayCount: Math.max(0, peakDay.count),
    quietDay: quietDay.day,
    quietDayLabel: dayNames[quietDay.day] || dayNames[0],
    quietDayCount: Number.isFinite(quietDay.count) ? quietDay.count : 0,
    weightedHourLabel: formatHourAmPm(weightedHourRaw),
  };
}

export function computeExplorationStats(topDestinations = [], totalTrips = 0) {
  const normalizedDestinations = (Array.isArray(topDestinations) ? topDestinations : [])
    .map((destination) => ({
      ...destination,
      location: destination?.location || "Unknown place",
      visits: clamp(toNumber(destination?.visits), 0, Number.MAX_SAFE_INTEGER),
      distance: toNumber(destination?.distance),
      duration_seconds: toNumber(destination?.duration_seconds),
      lastVisit: destination?.lastVisit || null,
    }))
    .sort((a, b) => b.visits - a.visits);

  if (!normalizedDestinations.length) {
    return {
      destinations: [],
      topShareTrips: 0,
      top3ShareTrips: 0,
      explorationScore: 0,
      routineScore: 0,
      explorationLabel: "No destination data",
      totalDestinationVisits: 0,
      uniquePlaces: 0,
      mostVisited: null,
    };
  }

  const totalDestinationVisits = normalizedDestinations.reduce(
    (sum, destination) => sum + destination.visits,
    0
  );
  const denominator = totalDestinationVisits || toNumber(totalTrips);

  const shares =
    denominator > 0
      ? normalizedDestinations.map((destination) => destination.visits / denominator)
      : normalizedDestinations.map(() => 0);

  const entropy = shares.reduce((sum, share) => {
    if (share <= 0) {
      return sum;
    }
    return sum - share * Math.log(share);
  }, 0);

  const maxEntropy = normalizedDestinations.length > 1 ? Math.log(normalizedDestinations.length) : 1;
  const explorationScore = clamp((entropy / maxEntropy) * 100, 0, 100);
  const routineScore = 100 - explorationScore;
  const topShareTrips =
    toNumber(totalTrips) > 0
      ? normalizedDestinations[0].visits / toNumber(totalTrips)
      : normalizedDestinations[0].visits / Math.max(1, totalDestinationVisits);
  const top3Visits = normalizedDestinations
    .slice(0, 3)
    .reduce((sum, destination) => sum + destination.visits, 0);
  const top3ShareTrips =
    toNumber(totalTrips) > 0
      ? top3Visits / toNumber(totalTrips)
      : top3Visits / Math.max(1, totalDestinationVisits);

  let explorationLabel = "Mixed destination spread";
  if (explorationScore >= 68) {
    explorationLabel = "Distributed destinations";
  } else if (explorationScore < 35) {
    explorationLabel = "Concentrated destinations";
  }

  return {
    destinations: normalizedDestinations,
    totalDestinationVisits,
    topShareTrips: Number((topShareTrips * 100).toFixed(1)),
    top3ShareTrips: Number((top3ShareTrips * 100).toFixed(1)),
    explorationScore: Number(explorationScore.toFixed(1)),
    routineScore: Number(routineScore.toFixed(1)),
    explorationLabel,
    uniquePlaces: normalizedDestinations.length,
    mostVisited: normalizedDestinations[0],
  };
}

export function computeFuelLens(totalFuel = 0, totalDistance = 0, totalTrips = 0) {
  const fuel = toNumber(totalFuel);
  const distance = toNumber(totalDistance);
  const trips = toNumber(totalTrips);
  const mpg = fuel > 0 ? distance / fuel : null;
  const fuelPerTrip = trips > 0 ? fuel / trips : 0;
  const distancePerTrip = trips > 0 ? distance / trips : 0;

  let dataNote = "Fuel ratio unavailable: not enough trip or fuel data in this range.";
  if (mpg !== null) {
    dataNote = `Computed as ${distance.toFixed(1)} mi / ${fuel.toFixed(2)} gal = ${mpg.toFixed(1)} MPG.`;
  } else if (distance > 0) {
    dataNote = "Distance exists, but fuel entries are missing so MPG cannot be computed.";
  }

  return {
    totalFuel: Number(fuel.toFixed(2)),
    totalDistance: Number(distance.toFixed(2)),
    totalTrips: trips,
    mpg: mpg === null ? null : Number(mpg.toFixed(1)),
    fuelPerTrip: Number(fuelPerTrip.toFixed(2)),
    distancePerTrip: Number(distancePerTrip.toFixed(2)),
    dataNote,
  };
}

export function buildPatternCards(derivedData = {}) {
  const consistency = derivedData.consistency || {};
  const timeSignature = derivedData.timeSignature || {};
  const exploration = derivedData.exploration || {};
  const fuelLens = derivedData.fuelLens || {};

  const scenes = [
    {
      id: "streak",
      icon: "fa-fire",
      title: "Drive-day streak",
      value: `${toNumber(consistency.longestStreak)} days`,
      detail: `${toNumber(consistency.activeDays)} of ${toNumber(consistency.spanDays)} days had trips`,
      tone: "mint",
      action: { type: "drilldown", kind: "trips" },
    },
    {
      id: "signature",
      icon: "fa-clock",
      title: "Weighted start hour",
      value: timeSignature.weightedHourLabel || "12 AM",
      detail: `Peak: ${formatHourAmPm(timeSignature.peakHour)} (${toNumber(timeSignature.peakHourCount)} trips)`,
      tone: "sky",
      action: {
        type: "time-period",
        timeType: "hour",
        timeValue: clamp(toNumber(timeSignature.peakHour), 0, 23),
      },
    },
    {
      id: "exploration",
      icon: "fa-compass",
      title: "Destination concentration",
      value: `${toNumber(exploration.top3ShareTrips).toFixed(1)}% in top 3`,
      detail: `Top place: ${toNumber(exploration.topShareTrips).toFixed(1)}% • Tracked places: ${toNumber(exploration.uniquePlaces)}`,
      tone: "amber",
      action: { type: "place" },
    },
    {
      id: "weekday",
      icon: "fa-calendar-day",
      title: "Peak and quiet days",
      value: `${timeSignature.peakDayLabel || "-"} / ${timeSignature.quietDayLabel || "-"}`,
      detail: `Trips: ${toNumber(timeSignature.peakDayCount)} vs ${toNumber(timeSignature.quietDayCount)}`,
      tone: "coral",
      action: {
        type: "time-period",
        timeType: "day",
        timeValue: clamp(toNumber(timeSignature.peakDay), 0, 6),
      },
    },
    {
      id: "fuel",
      icon: "fa-gas-pump",
      title: "Fuel lens",
      value: fuelLens.mpg == null ? "Not enough fuel data" : `${fuelLens.mpg} MPG`,
      detail: fuelLens.dataNote || "MPG requires both distance and fuel entries.",
      tone: "purple",
      action: { type: "drilldown", kind: "fuel" },
    },
  ];

  return scenes;
}

export function deriveInsightsSnapshot(stateData = {}) {
  const analytics = stateData?.analytics || {};
  const insights = stateData?.insights || {};

  const dailyDistances = Array.isArray(analytics.daily_distances)
    ? analytics.daily_distances
    : [];

  const weeklyBase = aggregatePeriods(dailyDistances, "weekly");
  const monthlyBase = aggregatePeriods(dailyDistances, "monthly");

  const periods = {
    weekly: computePeriodDeltas(weeklyBase),
    monthly: computePeriodDeltas(monthlyBase),
  };

  const consistency = computeConsistencyStats(dailyDistances);
  const timeSignature = computeTimeSignature(
    analytics.time_distribution || [],
    analytics.weekday_distribution || []
  );
  const exploration = computeExplorationStats(
    insights.top_destinations || [],
    toNumber(insights.total_trips)
  );
  const fuelLens = computeFuelLens(
    toNumber(insights.total_fuel_consumed),
    toNumber(insights.total_distance),
    toNumber(insights.total_trips)
  );

  const derived = {
    periods,
    consistency,
    timeSignature,
    exploration,
    fuelLens,
  };

  return {
    ...derived,
    patternCards: buildPatternCards(derived),
  };
}
