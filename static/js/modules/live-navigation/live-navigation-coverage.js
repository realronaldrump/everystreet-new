/** Provisional navigation progress. Historical Bouncie processing owns persistence. */
import { MI_TO_M } from "../utils/geo-math.js";
import LiveNavigationAPI from "./live-navigation-api.js";
import { toXY } from "./live-navigation-geo.js";

export function mergeIntervals(intervals) {
  const result = [];
  for (const [start, end] of intervals
    .map(([a, b]) => [Math.max(0, a), Math.min(1, b)])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && start <= last[1] + 1e-9) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}
const fraction = (ranges) => ranges.reduce((sum, [a, b]) => sum + b - a, 0);

export function traceIntervals(
  coordinates,
  previous,
  current,
  referenceLat,
  tolerance = 25
) {
  const points = coordinates.map((point) => toXY(point, referenceLat));
  const a = toXY(previous, referenceLat),
    b = toXY(current, referenceLat);
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < 2 || length > 500) return [];
  const ux = (b.x - a.x) / length,
    uy = (b.y - a.y) / length;
  const lengths = points
    .slice(1)
    .map((point, i) => Math.hypot(point.x - points[i].x, point.y - points[i].y));
  const total = lengths.reduce((sum, value) => sum + value, 0);
  if (!total) return [];
  let distance = 0;
  const intervals = [];
  for (let i = 0; i < lengths.length; i++) {
    const p = points[i],
      q = points[i + 1],
      edge = lengths[i];
    if (!edge || Math.abs((q.x - p.x) * ux + (q.y - p.y) * uy) < edge * Math.SQRT1_2) {
      distance += edge;
      continue;
    }
    const along = (p.x - a.x) * ux + (p.y - a.y) * uy;
    const across = (p.x - a.x) * -uy + (p.y - a.y) * ux;
    const deltaAlong = (q.x - p.x) * ux + (q.y - p.y) * uy;
    const deltaAcross = (q.x - p.x) * -uy + (q.y - p.y) * ux;
    let low = 0,
      high = 1;
    for (const [origin, delta, min, max] of [
      [along, deltaAlong, 0, length],
      [across, deltaAcross, -tolerance, tolerance],
    ]) {
      if (Math.abs(delta) < 1e-9) {
        if (origin < min || origin > max) high = -1;
      } else {
        const bounds = [(min - origin) / delta, (max - origin) / delta].sort(
          (x, y) => x - y
        );
        low = Math.max(low, bounds[0]);
        high = Math.min(high, bounds[1]);
      }
    }
    if (high > low)
      intervals.push([
        (distance + edge * low) / total,
        (distance + edge * high) / total,
      ]);
    distance += edge;
  }
  return mergeIntervals(intervals);
}

export default class LiveNavigationCoverage {
  constructor() {
    this.segmentIndex = new Map();
    this.drivenSegmentIds = new Set();
    this.undrivenSegmentIds = new Set();
    this.coveredIntervals = new Map();
    this.spatialGrid = new Map();
    this.loadRevision = 0;
    this.selectedAreaId = null;
    this.reset();
  }
  setCallbacks({ onMapUpdate, onCoverageUpdate, onCoverageIssue }) {
    this.onMapUpdate = onMapUpdate;
    this.onCoverageUpdate = onCoverageUpdate;
    this.onCoverageIssue = onCoverageIssue;
  }
  async loadSegments(areaId) {
    const revision = ++this.loadRevision;
    this.reset();
    this.selectedAreaId = areaId;
    try {
      const data = await LiveNavigationAPI.fetchCoverageSegments(areaId);
      if (revision !== this.loadRevision) return;
      const features = [];
      for (const feature of data.features) {
        const p = feature.properties;
        if (!p?.segment_id || p.status === "undriveable") continue;
        feature.id = p.segment_id;
        this.segmentIndex.set(p.segment_id, feature);
        const intervals = mergeIntervals(p.intervals || []);
        this.coveredIntervals.set(p.segment_id, intervals);
        this.totalSegmentLength += p.length_miles * MI_TO_M;
        this.drivenSegmentLength += fraction(intervals) * p.length_miles * MI_TO_M;
        (p.status === "driven" ? this.drivenSegmentIds : this.undrivenSegmentIds).add(
          p.segment_id
        );
        features.push(feature);
      }
      this.referenceLat = features[0]?.geometry?.coordinates?.[0]?.[1] || 0;
      for (const feature of features) {
        const points = feature.geometry.coordinates.map((point) =>
          toXY(point, this.referenceLat)
        );
        const xs = points.map((point) => point.x),
          ys = points.map((point) => point.y);
        for (
          let x = Math.floor(Math.min(...xs) / 160);
          x <= Math.floor(Math.max(...xs) / 160);
          x++
        ) {
          for (
            let y = Math.floor(Math.min(...ys) / 160);
            y <= Math.floor(Math.max(...ys) / 160);
            y++
          ) {
            const key = `${x},${y}`;
            if (!this.spatialGrid.has(key)) this.spatialGrid.set(key, new Set());
            this.spatialGrid.get(key).add(feature.id);
          }
        }
      }
      this.onMapUpdate?.({
        type: "init",
        features,
        drivenIds: [...this.drivenSegmentIds],
      });
      this.onCoverageUpdate?.(this.getCoverageStats());
    } catch (error) {
      if (revision === this.loadRevision)
        this.onCoverageIssue?.({
          message: `Coverage preview is unavailable: ${error.message}`,
        });
    }
  }
  checkSegmentCoverage(position) {
    const current = [position.lon, position.lat];
    if (
      !current.every(Number.isFinite) ||
      (Number.isFinite(position.accuracy) && position.accuracy > 50)
    ) {
      this.previous = null;
      return;
    }
    const previous = this.previous;
    this.previous = { coordinates: current, time: position.timestamp || Date.now() };
    if (
      !previous ||
      this.previous.time - previous.time > 120000 ||
      this.previous.time <= previous.time
    )
      return;
    const a = toXY(previous.coordinates, this.referenceLat),
      b = toXY(current, this.referenceLat);
    if (Math.hypot(b.x - a.x, b.y - a.y) > 500) return;
    const candidates = new Set();
    for (
      let x = Math.floor((Math.min(a.x, b.x) - 25) / 160);
      x <= Math.floor((Math.max(a.x, b.x) + 25) / 160);
      x++
    ) {
      for (
        let y = Math.floor((Math.min(a.y, b.y) - 25) / 160);
        y <= Math.floor((Math.max(a.y, b.y) + 25) / 160);
        y++
      ) {
        for (const id of this.spatialGrid.get(`${x},${y}`) || []) candidates.add(id);
      }
    }
    const completed = [];
    for (const id of candidates) {
      if (!this.undrivenSegmentIds.has(id)) continue;
      const feature = this.segmentIndex.get(id);
      const old = this.coveredIntervals.get(id) || [];
      const next = mergeIntervals([
        ...old,
        ...traceIntervals(
          feature.geometry.coordinates,
          previous.coordinates,
          current,
          this.referenceLat
        ),
      ]);
      const gain =
        Math.max(0, fraction(next) - fraction(old)) *
        feature.properties.length_miles *
        MI_TO_M;
      this.coveredIntervals.set(id, next);
      this.drivenSegmentLength += gain;
      this.liveCoverageIncrease += gain;
      if (fraction(next) >= 1 - 1e-9) {
        this.undrivenSegmentIds.delete(id);
        this.drivenSegmentIds.add(id);
        this.sessionSegmentsCompleted++;
        completed.push(id);
      }
    }
    if (completed.length)
      this.onMapUpdate?.({ type: "segments-driven", segmentIds: completed });
    this.onCoverageUpdate?.(this.getCoverageStats());
  }
  getCoverageStats() {
    return {
      percentage: this.totalSegmentLength
        ? (this.drivenSegmentLength / this.totalSegmentLength) * 100
        : 0,
      drivenLength: this.drivenSegmentLength,
      totalLength: this.totalSegmentLength,
      sessionIncrease: this.liveCoverageIncrease,
      sessionSegments: this.sessionSegmentsCompleted,
      provisional: true,
    };
  }
  reset() {
    this.segmentIndex.clear();
    this.drivenSegmentIds.clear();
    this.undrivenSegmentIds.clear();
    this.coveredIntervals.clear();
    this.spatialGrid.clear();
    this.previous = null;
    this.totalSegmentLength = 0;
    this.drivenSegmentLength = 0;
    this.liveCoverageIncrease = 0;
    this.sessionSegmentsCompleted = 0;
  }
  destroy() {
    ++this.loadRevision;
    this.reset();
  }
}
