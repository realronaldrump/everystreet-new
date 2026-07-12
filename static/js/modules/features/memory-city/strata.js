/**
 * Memory City — pure data preparation for the strata sculpture.
 *
 * Takes the flat API payload and derives everything the renderer and
 * timeline need:
 *
 *   - founding order (rank) and a blended progress domain that mixes
 *     calendar time with founding order, so bursts of building read as
 *     dense bands without long idle gaps hollowing out the sculpture
 *   - an altitude per segment (progress × sculpture height): the
 *     vertical axis of the sculpture IS the timeline
 *   - chapters: contiguous eras of building found by gap-splitting the
 *     founding dates, merged to at most six
 *   - city records (founding stone, newest addition, backbone street,
 *     most forgotten, never-revisited counts)
 *   - a street-name index for search
 *
 * No DOM, no deck.gl — everything here is unit-testable.
 */

export const DAY_MS = 86_400_000;

/** Recency color ramp (warm → cool). Each stop is [daysThreshold, [r,g,b]]. */
export const RECENCY_STOPS = [
  [0, [255, 204, 118]], // driven today — warm honey
  [7, [242, 160, 74]], // within a week — amber
  [30, [216, 131, 85]], // within a month — coral
  [90, [184, 118, 142]], // within a quarter — dusk mauve
  [180, [138, 122, 176]], // within half a year — lavender
  [365, [108, 120, 172]], // within a year — indigo
  [Number.POSITIVE_INFINITY, [70, 86, 140]], // older — deep steel
];

export const RECENCY_LABELS = [
  "Today",
  "This week",
  "This month",
  "This quarter",
  "Half a year",
  "This year",
  "Older",
];

// Progress blends calendar time with founding order. Pure calendar time
// collapses bursts into thin sheets separated by voids; pure order erases
// the rhythm entirely. The blend keeps chronology monotonic while giving
// every era visible thickness.
const WEIGHT_TIME = 0.45;
const WEIGHT_RANK = 0.55;

// Sculpture height scales with the area's footprint so a county and a
// neighborhood both read as monuments rather than plates or needles.
const HEIGHT_DIAGONAL_RATIO = 0.16;
const MIN_HEIGHT_M = 400;
const MAX_HEIGHT_M = 5200;

// A street counts as "revisited" when it was driven again at least this
// long after it was founded.
const REVISIT_MIN_GAP_MS = 3_600_000;

// Chapter detection: a pause in building longer than this starts a new era.
const CHAPTER_GAP_MS = 45 * DAY_MS;
const MAX_CHAPTERS = 6;

const CHAPTER_NUMERALS = ["I", "II", "III", "IV", "V", "VI"];

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// =============================================================================
// Small pure helpers
// =============================================================================

export function clamp(n, min, max) {
  if (n < min) {
    return min;
  }
  if (n > max) {
    return max;
  }
  return n;
}

export function parseIso(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

export function recencyBucketIndex(daysSinceDriven) {
  for (let i = 0; i < RECENCY_STOPS.length; i += 1) {
    if (daysSinceDriven <= RECENCY_STOPS[i][0]) {
      return i;
    }
  }
  return RECENCY_STOPS.length - 1;
}

/** Geometric midpoint along a polyline, so the marker sits on the road. */
export function midpointOfPath(path) {
  if (!Array.isArray(path) || path.length < 2) {
    return null;
  }
  const segmentLengths = [];
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    const dx = path[i][0] - path[i - 1][0];
    const dy = path[i][1] - path[i - 1][1];
    const len = Math.hypot(dx, dy);
    segmentLengths.push(len);
    total += len;
  }
  if (total === 0) {
    return [Number(path[0][0]), Number(path[0][1])];
  }
  const target = total / 2;
  let acc = 0;
  for (let i = 0; i < segmentLengths.length; i += 1) {
    const segLen = segmentLengths[i];
    if (acc + segLen >= target) {
      const remainder = target - acc;
      const t = segLen > 0 ? remainder / segLen : 0;
      const a = path[i];
      const b = path[i + 1];
      return [Number(a[0]) + (b[0] - a[0]) * t, Number(a[1]) + (b[1] - a[1]) * t];
    }
    acc += segLen;
  }
  const last = path[path.length - 1];
  return [Number(last[0]), Number(last[1])];
}

function baseWidthForHighwayType(highwayType) {
  const type = String(highwayType || "").toLowerCase();
  if (type.includes("motorway") || type.includes("trunk")) {
    return 3.2;
  }
  if (type.includes("primary") || type.includes("secondary")) {
    return 2.4;
  }
  if (type.includes("tertiary")) {
    return 1.9;
  }
  return 1.5;
}

function bboxDiagonalMeters(bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const midLatRad = (((minLat + maxLat) / 2) * Math.PI) / 180;
  const dx = (maxLon - minLon) * 111_320 * Math.cos(midLatRad);
  const dy = (maxLat - minLat) * 111_320;
  return Math.hypot(dx, dy);
}

export function formatChapterSpan(startMs, endMs) {
  const a = new Date(startMs);
  const b = new Date(endMs);
  const aLabel = `${MONTHS_SHORT[a.getUTCMonth()]} ${a.getUTCFullYear()}`;
  const bLabel = `${MONTHS_SHORT[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
  if (aLabel === bLabel) {
    return aLabel;
  }
  if (a.getUTCFullYear() === b.getUTCFullYear()) {
    return `${MONTHS_SHORT[a.getUTCMonth()]}–${MONTHS_SHORT[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
  }
  return `${aLabel} – ${bLabel}`;
}

// =============================================================================
// Chapters
// =============================================================================

/**
 * Split founding-ordered segments into eras of building.
 *
 * A new chapter starts wherever the pause between consecutive foundings
 * exceeds CHAPTER_GAP_MS. Slivers are merged into their nearest
 * neighbor, then the smallest gaps are merged until at most
 * MAX_CHAPTERS remain. Returns ranges over segment indices.
 */
export function computeChapters(segments) {
  const n = segments.length;
  if (n === 0) {
    return [];
  }

  const ranges = [];
  let start = 0;
  for (let i = 1; i < n; i += 1) {
    if (segments[i].firstMs - segments[i - 1].firstMs > CHAPTER_GAP_MS) {
      ranges.push({ start, end: i - 1 });
      start = i;
    }
  }
  ranges.push({ start, end: n - 1 });

  const gapBefore = (index) =>
    segments[ranges[index].start].firstMs - segments[ranges[index - 1].end].firstMs;

  const mergeInto = (index, direction) => {
    const target = index + direction;
    ranges[Math.min(index, target)].end = ranges[Math.max(index, target)].end;
    ranges.splice(Math.max(index, target), 1);
  };

  // Absorb slivers (stray backfills, single-drive blips) into the
  // neighbor they are closest to in time.
  const minCount = Math.max(8, Math.round(n * 0.01));
  let merged = true;
  while (merged && ranges.length > 1) {
    merged = false;
    for (let i = 0; i < ranges.length; i += 1) {
      const count = ranges[i].end - ranges[i].start + 1;
      if (count >= minCount) {
        continue;
      }
      if (i === 0) {
        mergeInto(i, 1);
      } else if (i === ranges.length - 1) {
        mergeInto(i, -1);
      } else {
        mergeInto(i, gapBefore(i) <= gapBefore(i + 1) ? -1 : 1);
      }
      merged = true;
      break;
    }
  }

  while (ranges.length > MAX_CHAPTERS) {
    let bestGap = Number.POSITIVE_INFINITY;
    let bestIndex = 1;
    for (let i = 1; i < ranges.length; i += 1) {
      const gap = gapBefore(i);
      if (gap < bestGap) {
        bestGap = gap;
        bestIndex = i;
      }
    }
    mergeInto(bestIndex, -1);
  }

  return ranges.map((range, index) => {
    let miles = 0;
    for (let i = range.start; i <= range.end; i += 1) {
      miles += segments[i].lengthMiles;
    }
    const startMs = segments[range.start].firstMs;
    const endMs = segments[range.end].firstMs;
    return {
      index,
      startIndex: range.start,
      endIndex: range.end,
      startMs,
      endMs,
      count: range.end - range.start + 1,
      miles,
      numeral: CHAPTER_NUMERALS[index] || String(index + 1),
      dateLabel: formatChapterSpan(startMs, endMs),
    };
  });
}

// =============================================================================
// Model preparation
// =============================================================================

/**
 * Prepare the full strata model from an API payload.
 *
 * Returns null when the payload has no renderable segments. `now` is
 * injectable for tests.
 */
export function prepareModel(payload, now = Date.now()) {
  const raw = Array.isArray(payload?.segments) ? payload.segments : [];

  const parsed = [];
  for (const seg of raw) {
    const firstMs = parseIso(seg.first_driven_at);
    if (firstMs === null) {
      continue;
    }
    const path = Array.isArray(seg.path) ? seg.path : [];
    if (path.length < 2) {
      continue;
    }
    const midpoint = midpointOfPath(path);
    if (!midpoint) {
      continue;
    }
    const lastMs = parseIso(seg.last_driven_at) ?? firstMs;
    parsed.push({
      segmentId: seg.segment_id,
      streetName: seg.street_name || null,
      highwayType: seg.highway_type || "unclassified",
      lengthMiles: Number(seg.length_miles) || 0,
      path,
      midpoint,
      firstMs,
      lastMs,
      daysSinceDriven: Math.max(0, (now - lastMs) / DAY_MS),
      revisited: lastMs - firstMs > REVISIT_MIN_GAP_MS,
      baseWidth: baseWidthForHighwayType(seg.highway_type),
    });
  }

  if (parsed.length === 0) {
    return null;
  }

  parsed.sort(
    (a, b) => a.firstMs - b.firstMs || String(a.segmentId).localeCompare(String(b.segmentId))
  );

  // Area bounding box (from geometry, not the stored bbox, so it always
  // matches what is actually drawn).
  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const seg of parsed) {
    for (const pt of seg.path) {
      const lon = Number(pt[0]);
      const lat = Number(pt[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        continue;
      }
      if (lon < minLon) {
        minLon = lon;
      }
      if (lon > maxLon) {
        maxLon = lon;
      }
      if (lat < minLat) {
        minLat = lat;
      }
      if (lat > maxLat) {
        maxLat = lat;
      }
    }
  }
  const bbox = [minLon, minLat, maxLon, maxLat];

  const n = parsed.length;
  const heightM = clamp(
    bboxDiagonalMeters(bbox) * HEIGHT_DIAGONAL_RATIO,
    MIN_HEIGHT_M,
    MAX_HEIGHT_M
  );

  const t0 = parsed[0].firstMs;
  const tN = parsed[n - 1].firstMs;
  const timeSpan = Math.max(1, tN - t0);
  const rankSpan = Math.max(1, n - 1);

  const progress = new Float64Array(n);
  const prefixMiles = new Float64Array(n + 1);

  for (let i = 0; i < n; i += 1) {
    const seg = parsed[i];
    const timeRatio = (seg.firstMs - t0) / timeSpan;
    const rankRatio = i / rankSpan;
    const p = n === 1 ? 0 : WEIGHT_TIME * timeRatio + WEIGHT_RANK * rankRatio;
    const altitude = heightM * p;
    seg.rank = i;
    seg.progress = p;
    seg.altitude = altitude;
    seg.pathZ = seg.path.map((pt) => [Number(pt[0]), Number(pt[1]), altitude]);
    progress[i] = p;
    prefixMiles[i + 1] = prefixMiles[i] + seg.lengthMiles;
  }

  const chapters = computeChapters(parsed);
  for (const chapter of chapters) {
    chapter.startProgress = progress[chapter.startIndex];
    chapter.endProgress = progress[chapter.endIndex];
    for (let i = chapter.startIndex; i <= chapter.endIndex; i += 1) {
      parsed[i].chapterIndex = chapter.index;
    }
  }

  // Street-name index (search + backbone record).
  const nameIndex = new Map();
  for (const seg of parsed) {
    if (!seg.streetName) {
      continue;
    }
    const key = seg.streetName.trim().toLowerCase();
    if (!key) {
      continue;
    }
    let entry = nameIndex.get(key);
    if (!entry) {
      entry = {
        name: seg.streetName.trim(),
        count: 0,
        miles: 0,
        firstMs: seg.firstMs,
        lastMs: seg.lastMs,
        indices: [],
        bbox: [
          Number.POSITIVE_INFINITY,
          Number.POSITIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
        ],
      };
      nameIndex.set(key, entry);
    }
    entry.count += 1;
    entry.miles += seg.lengthMiles;
    entry.firstMs = Math.min(entry.firstMs, seg.firstMs);
    entry.lastMs = Math.max(entry.lastMs, seg.lastMs);
    entry.indices.push(seg.rank);
    for (const pt of seg.path) {
      if (pt[0] < entry.bbox[0]) {
        entry.bbox[0] = pt[0];
      }
      if (pt[1] < entry.bbox[1]) {
        entry.bbox[1] = pt[1];
      }
      if (pt[0] > entry.bbox[2]) {
        entry.bbox[2] = pt[0];
      }
      if (pt[1] > entry.bbox[3]) {
        entry.bbox[3] = pt[1];
      }
    }
  }

  let backbone = null;
  for (const entry of nameIndex.values()) {
    if (!backbone || entry.miles > backbone.miles) {
      backbone = entry;
    }
  }

  let forgotten = parsed[0];
  let onceCount = 0;
  for (const seg of parsed) {
    if (seg.lastMs < forgotten.lastMs) {
      forgotten = seg;
    }
    if (!seg.revisited) {
      onceCount += 1;
    }
  }

  const records = {
    founding: parsed[0],
    newest: parsed[n - 1],
    backbone,
    forgotten,
    onceCount,
    oncePct: (onceCount / n) * 100,
  };

  return {
    segments: parsed,
    count: n,
    progress,
    prefixMiles,
    totalMiles: prefixMiles[n],
    bbox,
    heightM,
    firstMs: t0,
    lastMs: tN,
    chapters,
    nameIndex,
    records,
    softRanks: clamp(Math.round(n * 0.015), 2, 400),
  };
}

/**
 * Largest segment index whose progress is <= v (binary search).
 * v <= 0 returns 0; v >= 1 returns the last index.
 */
export function progressIndex(progress, v) {
  const n = progress.length;
  if (n === 0) {
    return -1;
  }
  if (v >= progress[n - 1]) {
    return n - 1;
  }
  if (v < progress[0]) {
    return 0;
  }
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (progress[mid] <= v) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/** Search the name index: prefix matches first, then substring, by miles. */
export function searchStreets(nameIndex, query, limit = 8) {
  const q = String(query || "")
    .trim()
    .toLowerCase();
  if (q.length < 2) {
    return [];
  }
  const starts = [];
  const contains = [];
  for (const [key, entry] of nameIndex) {
    if (key.startsWith(q)) {
      starts.push(entry);
    } else if (key.includes(q)) {
      contains.push(entry);
    }
  }
  const byMiles = (a, b) => b.miles - a.miles;
  starts.sort(byMiles);
  contains.sort(byMiles);
  return starts.concat(contains).slice(0, limit);
}
