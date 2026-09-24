import assert from "node:assert/strict";
import test from "node:test";

import {
  HEAT_CELL_METERS,
  MIN_HEAT_REFERENCE,
  heatLevel,
  heatReference,
  heatRuns,
  pointFrequencies,
} from "../static/js/modules/trip-heat.js";
import { packHeat } from "../static/js/modules/trip-map-worker.js";

// About 1.1 m of latitude and 0.95 m of longitude near Waco.
const LAT_METER = 1 / 111_000;
const LON_METER = 1 / 95_000;
const ORIGIN = [-97.15, 31.55];

/** A trip along a straight east-west road, `offset` metres north of it. */
function eastbound(fromMeters, toMeters, offset = 0, stepMeters = 15) {
  const points = [];
  for (let meters = fromMeters; meters <= toMeters; meters += stepMeters) {
    points.push([ORIGIN[0] + meters * LON_METER, ORIGIN[1] + offset * LAT_METER]);
  }
  return points;
}

/** A trip along a north-south road `eastMeters` east of the origin. */
function northbound(eastMeters, fromMeters, toMeters, stepMeters = 15) {
  const points = [];
  for (let meters = fromMeters; meters <= toMeters; meters += stepMeters) {
    points.push([ORIGIN[0] + eastMeters * LON_METER, ORIGIN[1] + meters * LAT_METER]);
  }
  return points;
}

/** The worker's decoded layout from `[tripIndex, points]` paths. */
function decode(paths) {
  const positions = [];
  const startIndices = [0];
  const tripIndices = [];
  paths.forEach(([trip, points]) => {
    points.forEach(([lon, lat]) => positions.push(lon, lat));
    startIndices.push(positions.length / 2);
    tripIndices.push(trip);
  });
  return {
    length: paths.length,
    positions: new Float64Array(positions),
    startIndices: new Uint32Array(startIndices),
    tripIndices: new Uint32Array(tripIndices),
  };
}

function frequenciesOfPath(decoded, frequencies, path) {
  return [...frequencies.subarray(decoded.startIndices[path], decoded.startIndices[path + 1])];
}

test("a road counts each trip that used it once", () => {
  const decoded = decode([
    [0, eastbound(0, 600)],
    [1, eastbound(0, 600, 3)],
    [2, eastbound(0, 600, -4)],
    [3, northbound(2000, 0, 600)],
  ]);
  const frequencies = pointFrequencies(decoded);

  assert.ok(frequenciesOfPath(decoded, frequencies, 0).every((count) => count === 3));
  assert.ok(frequenciesOfPath(decoded, frequencies, 3).every((count) => count === 1));
});

test("doubling back on a road does not count a trip twice", () => {
  const out = eastbound(0, 600);
  const decoded = decode([
    [0, [...out, ...out.slice().reverse(), ...out]],
    [1, eastbound(0, 600)],
  ]);
  const frequencies = pointFrequencies(decoded);

  assert.ok(frequenciesOfPath(decoded, frequencies, 1).every((count) => count === 2));
});

test("a trip split into several paths is still one trip", () => {
  const decoded = decode([
    [0, eastbound(0, 300)],
    [0, eastbound(300, 600)],
    [1, eastbound(0, 600)],
  ]);
  const frequencies = pointFrequencies(decoded);

  assert.ok(frequenciesOfPath(decoded, frequencies, 2).every((count) => count === 2));
});

test("a road along a cell edge is not split between cells", () => {
  // GPS scatter of a few metres either side of a road that runs exactly
  // along a grid line would put half the trips in each cell.
  const radius = 6_378_137;
  const toY = (lat) => radius * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const toLat = (y) => (2 * Math.atan(Math.exp(y / radius)) - Math.PI / 2) * (180 / Math.PI);
  const edgeY = Math.round(toY(ORIGIN[1]) / HEAT_CELL_METERS) * HEAT_CELL_METERS;
  const trips = [-3, -1.5, 1.5, 3].map((offset, trip) => [
    trip,
    eastbound(0, 600).map(([lon]) => [lon, toLat(edgeY + offset)]),
  ]);
  const decoded = decode(trips);
  const frequencies = pointFrequencies(decoded);

  const middle = frequenciesOfPath(decoded, frequencies, 0).slice(5, -5);
  assert.ok(middle.every((count) => count === 4), `counts ${middle}`);
});

test("heat is logarithmic between one trip and the reference", () => {
  assert.equal(heatLevel(1, 400), 0);
  assert.equal(heatLevel(400, 400), 1);
  assert.equal(heatLevel(4000, 400), 1);
  assert.ok(Math.abs(heatLevel(20, 400) - 0.5) < 1e-9);
});

test("the reference follows where most of the driving happened", () => {
  const busy = Array.from({ length: 12 }, (_, trip) => [trip, eastbound(0, 600, trip % 3)]);
  const decoded = decode([...busy, [12, northbound(3000, 0, 3000)]]);

  assert.equal(heatReference(decoded, pointFrequencies(decoded)), 12);
});

test("a small hot spot cannot set the reference", () => {
  // Twelve trips through one car park against twenty kilometres of road.
  const carPark = Array.from({ length: 12 }, (_, trip) => [trip, eastbound(0, 15)]);
  const decoded = decode([...carPark, [12, northbound(3000, 0, 20_000)]]);

  assert.equal(heatReference(decoded, pointFrequencies(decoded)), MIN_HEAT_REFERENCE);
});

test("runs split where the trip count doubles and turns take the quiet side", () => {
  const busy = Array.from({ length: 8 }, (_, trip) => [trip + 1, eastbound(0, 600)]);
  const turnOff = [0, [...eastbound(0, 600), ...northbound(600, 15, 600)]];
  const decoded = decode([turnOff, ...busy]);
  const { runs } = heatRuns(decoded);
  const turnRuns = runs.filter((run) => run.path === 0);

  assert.equal(turnRuns.length, 2);
  assert.equal(turnRuns[0].frequency, 9);
  assert.equal(turnRuns[1].frequency, 1);
  // Consecutive runs share their boundary point, so the line is unbroken.
  assert.equal(turnRuns[1].start, turnRuns[0].end);
  assert.equal(turnRuns[1].end, decoded.startIndices[1] - 1);
});

test("the worker packs heat runs into transferable arrays", () => {
  const decoded = decode([
    [0, eastbound(0, 300)],
    [1, eastbound(0, 300)],
  ]);
  const heat = packHeat(decoded);

  assert.equal(heat.length, 2);
  assert.ok(heat.paths instanceof Uint32Array);
  assert.deepEqual([...heat.frequencies], [2, 2]);
  assert.equal(heat.reference, MIN_HEAT_REFERENCE);
});
