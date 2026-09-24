/**
 * Road frequency for the trip heat map.
 *
 * Every point of every trip is given the number of distinct trips that
 * passed the same spot, so each road can be drawn once in the colour of how
 * often it was driven. Stacking translucent copies of every trip cannot do
 * that: alpha saturates after a handful of passes and turns into a flat wash.
 *
 * A spot is a grid cell a few road-widths across. Trips are walked through
 * two grids offset by half a cell and a point takes the larger count, so a
 * road running along a cell edge is not split between neighbouring cells.
 * This module is pure and runs inside the trip map worker.
 */

const EARTH_RADIUS_METERS = 6_378_137;
const DEG_TO_RAD = Math.PI / 180;
const EMPTY = -2_147_483_648;

/** Cell edge in Web Mercator metres (about 18 to 21 m on the ground in the US). */
export const HEAT_CELL_METERS = 24;

/** Points either side a count is smoothed over, so junctions do not flicker. */
const SMOOTHING_RADIUS = 2;

/** The frequency that takes the hottest colour is this quantile of the network. */
export const HEAT_REFERENCE_QUANTILE = 0.98;

/** Never let a sparse range stretch the whole ramp over one or two trips. */
export const MIN_HEAT_REFERENCE = 4;

function mercatorX(lon) {
  return EARTH_RADIUS_METERS * lon * DEG_TO_RAD;
}

function mercatorY(lat) {
  const clamped = Math.max(-85.05, Math.min(85.05, lat));
  return EARTH_RADIUS_METERS * Math.log(Math.tan(Math.PI / 4 + (clamped * DEG_TO_RAD) / 2));
}

/**
 * Distinct-trip counts per grid cell, in an open-addressing table on typed
 * arrays. A JS Map of this size costs several times the memory and time.
 */
class CellCounter {
  constructor(capacity = 1 << 16) {
    this._allocate(capacity);
  }

  _allocate(capacity) {
    this.mask = capacity - 1;
    this.size = 0;
    this.cellX = new Int32Array(capacity).fill(EMPTY);
    this.cellY = new Int32Array(capacity);
    this.lastTrip = new Int32Array(capacity);
    this.counts = new Uint32Array(capacity);
  }

  _slot(x, y) {
    let slot = (Math.imul(x, 73_856_093) ^ Math.imul(y, 19_349_663)) & this.mask;
    while (this.cellX[slot] !== EMPTY && (this.cellX[slot] !== x || this.cellY[slot] !== y)) {
      slot = (slot + 1) & this.mask;
    }
    return slot;
  }

  _grow() {
    const { cellX, cellY, lastTrip, counts } = this;
    this._allocate(cellX.length * 2);
    for (let index = 0; index < cellX.length; index += 1) {
      if (cellX[index] === EMPTY) {
        continue;
      }
      const slot = this._slot(cellX[index], cellY[index]);
      this.cellX[slot] = cellX[index];
      this.cellY[slot] = cellY[index];
      this.lastTrip[slot] = lastTrip[index];
      this.counts[slot] = counts[index];
      this.size += 1;
    }
  }

  /** Count `trip` in the cell once, however many times it passes through. */
  visit(x, y, trip) {
    let slot = this._slot(x, y);
    if (this.cellX[slot] === EMPTY) {
      if ((this.size + 1) * 2 > this.cellX.length) {
        this._grow();
        slot = this._slot(x, y);
      }
      this.cellX[slot] = x;
      this.cellY[slot] = y;
      this.lastTrip[slot] = trip;
      this.counts[slot] = 1;
      this.size += 1;
      return;
    }
    if (this.lastTrip[slot] !== trip) {
      this.lastTrip[slot] = trip;
      this.counts[slot] += 1;
    }
  }

  get(x, y) {
    const slot = this._slot(x, y);
    return this.cellX[slot] === EMPTY ? 0 : this.counts[slot];
  }
}

function projectPositions(positions) {
  const pointCount = positions.length / 2;
  const projected = new Float64Array(positions.length);
  for (let index = 0; index < pointCount; index += 1) {
    projected[index * 2] = mercatorX(positions[index * 2]);
    projected[index * 2 + 1] = mercatorY(positions[index * 2 + 1]);
  }
  return projected;
}

const scratch = new Uint32Array(SMOOTHING_RADIUS * 2 + 1);

/** Median of `raw[from..to)`, sorted in a reused scratch array. */
function median(raw, from, to) {
  const count = to - from;
  for (let index = 0; index < count; index += 1) {
    const value = raw[from + index];
    let slot = index;
    while (slot > 0 && scratch[slot - 1] > value) {
      scratch[slot] = scratch[slot - 1];
      slot -= 1;
    }
    scratch[slot] = value;
  }
  return scratch[count >> 1];
}

/**
 * Trips through the neighbourhood of each point.
 *
 * @param {{positions: Float64Array, startIndices: Uint32Array, tripIndices: Uint32Array, length: number}} decoded
 * @param {{cellMeters?: number}} options
 * @returns {Uint32Array} One count per point in `decoded.positions`
 */
export function pointFrequencies(decoded, { cellMeters = HEAT_CELL_METERS } = {}) {
  const { positions, startIndices, tripIndices, length } = decoded;
  const pointCount = positions.length / 2;
  const frequencies = new Uint32Array(pointCount);
  if (!length || !pointCount) {
    return frequencies;
  }

  const projected = projectPositions(positions);
  const inverse = 1 / cellMeters;
  const half = 0.5;
  const primary = new CellCounter(1 << 20);
  const offset = new CellCounter(1 << 20);

  for (let path = 0; path < length; path += 1) {
    const trip = tripIndices[path];
    const start = startIndices[path];
    const end = startIndices[path + 1];
    let lastAx = EMPTY;
    let lastAy = EMPTY;
    let lastBx = EMPTY;
    let lastBy = EMPTY;
    // Walk in cell units, one sample per cell length: a trip can only miss
    // a cell it clips at a corner, and the offset grid catches that spot.
    let x0 = projected[start * 2] * inverse;
    let y0 = projected[start * 2 + 1] * inverse;
    for (let point = start; point < end; point += 1) {
      const x1 = projected[point * 2] * inverse;
      const y1 = projected[point * 2 + 1] * inverse;
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
      for (let index = point > start ? 1 : 0; index <= steps; index += 1) {
        const x = x0 + ((x1 - x0) * index) / steps;
        const y = y0 + ((y1 - y0) * index) / steps;
        const ax = Math.floor(x);
        const ay = Math.floor(y);
        if (ax !== lastAx || ay !== lastAy) {
          primary.visit(ax, ay, trip);
          lastAx = ax;
          lastAy = ay;
        }
        const bx = Math.floor(x + half);
        const by = Math.floor(y + half);
        if (bx !== lastBx || by !== lastBy) {
          offset.visit(bx, by, trip);
          lastBx = bx;
          lastBy = by;
        }
      }
      x0 = x1;
      y0 = y1;
    }
  }

  const raw = new Uint32Array(pointCount);
  for (let point = 0; point < pointCount; point += 1) {
    const x = projected[point * 2] * inverse;
    const y = projected[point * 2 + 1] * inverse;
    raw[point] = Math.max(
      primary.get(Math.floor(x), Math.floor(y)),
      offset.get(Math.floor(x + half), Math.floor(y + half))
    );
  }

  for (let path = 0; path < length; path += 1) {
    const start = startIndices[path];
    const end = startIndices[path + 1];
    for (let point = start; point < end; point += 1) {
      const from = Math.max(start, point - SMOOTHING_RADIUS);
      const to = Math.min(end, point + SMOOTHING_RADIUS + 1);
      frequencies[point] = Math.max(1, median(raw, from, to));
    }
  }
  return frequencies;
}

/**
 * The frequency drawn in the hottest colour: the count reached by the
 * busiest 2% of all the distance driven, so a car park full of GPS jitter
 * cannot set it and a range of a few quiet trips still spans the ramp.
 */
export function heatReference(decoded, frequencies) {
  const { positions, startIndices, length } = decoded;
  const weights = new Map();
  let total = 0;
  for (let path = 0; path < length; path += 1) {
    for (let point = startIndices[path] + 1; point < startIndices[path + 1]; point += 1) {
      // Degrees scaled to equal-area units; only the ratios matter here.
      const meters = Math.hypot(
        (positions[point * 2] - positions[point * 2 - 2]) *
          Math.cos(positions[point * 2 + 1] * DEG_TO_RAD),
        positions[point * 2 + 1] - positions[point * 2 - 1]
      );
      const frequency = Math.min(frequencies[point], frequencies[point - 1]);
      weights.set(frequency, (weights.get(frequency) || 0) + meters);
      total += meters;
    }
  }
  if (!total) {
    return MIN_HEAT_REFERENCE;
  }
  let running = 0;
  for (const frequency of [...weights.keys()].sort((a, b) => a - b)) {
    running += weights.get(frequency);
    if (running >= total * HEAT_REFERENCE_QUANTILE) {
      return Math.max(MIN_HEAT_REFERENCE, frequency);
    }
  }
  return MIN_HEAT_REFERENCE;
}

/** Heat on a 0 to 1 scale: logarithmic, so 1, 10 and 100 trips step evenly. */
export function heatLevel(frequency, reference) {
  if (frequency <= 1) {
    return 0;
  }
  return Math.min(1, Math.log(frequency) / Math.log(Math.max(2, reference)));
}

/** Split point for runs: one run per doubling of frequency. */
function frequencyBand(frequency) {
  return Math.floor(Math.log2(Math.max(1, frequency)));
}

/**
 * Cut every trip into runs of similar frequency, ready to be drawn once
 * each. A segment takes the lower count of its two ends, so a turn off a
 * busy road is coloured as the quiet street it leads to.
 *
 * @returns {{runs: Array<{path: number, start: number, end: number, frequency: number}>, reference: number}}
 *   `start` and `end` are point indices (inclusive) into `decoded.positions`.
 */
export function heatRuns(decoded, frequencies = pointFrequencies(decoded)) {
  const { startIndices, length } = decoded;
  const runs = [];
  for (let path = 0; path < length; path += 1) {
    const start = startIndices[path];
    const end = startIndices[path + 1];
    let runStart = start;
    let runBand = null;
    let runFrequency = 0;
    for (let point = start + 1; point < end; point += 1) {
      const frequency = Math.min(frequencies[point - 1], frequencies[point]);
      const band = frequencyBand(frequency);
      if (runBand !== null && band !== runBand) {
        runs.push({ path, start: runStart, end: point - 1, frequency: runFrequency });
        runStart = point - 1;
        runFrequency = 0;
      }
      runBand = band;
      runFrequency = Math.max(runFrequency, frequency);
    }
    if (runBand !== null) {
      runs.push({ path, start: runStart, end: end - 1, frequency: runFrequency });
    }
  }
  return { runs, reference: heatReference(decoded, frequencies) };
}
