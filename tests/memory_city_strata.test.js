import assert from "node:assert/strict";
import test from "node:test";

import {
  DAY_MS,
  computeChapters,
  formatChapterSpan,
  prepareModel,
  progressIndex,
  searchStreets,
} from "../static/js/modules/features/memory-city/strata.js";

const BASE_MS = Date.parse("2020-05-21T12:00:00Z");
const NOW_MS = BASE_MS + 730 * DAY_MS;

let segmentCounter = 0;

function makeSegment({ dayOffset, name, lastDayOffset, lengthMiles = 0.25, path }) {
  segmentCounter += 1;
  const firstMs = BASE_MS + dayOffset * DAY_MS;
  const lastMs = BASE_MS + (lastDayOffset ?? dayOffset) * DAY_MS;
  return {
    segment_id: `seg-${String(segmentCounter).padStart(4, "0")}`,
    street_name: name ?? `Street ${segmentCounter}`,
    highway_type: "residential",
    length_miles: lengthMiles,
    path: path ?? [
      [-97.1 + segmentCounter * 0.001, 31.5],
      [-97.1 + segmentCounter * 0.001, 31.502],
    ],
    first_driven_at: new Date(firstMs).toISOString(),
    last_driven_at: new Date(lastMs).toISOString(),
  };
}

function makeBurst(startDay, count, overrides = {}) {
  return Array.from({ length: count }, (_, i) =>
    makeSegment({ dayOffset: startDay + (i % 10), ...overrides })
  );
}

function buildPayload(segments) {
  return { area: { id: "a1", display_name: "Testville" }, segments };
}

test("prepareModel drops segments without dates or usable paths", () => {
  const good = makeSegment({ dayOffset: 0 });
  const noDate = { ...makeSegment({ dayOffset: 1 }), first_driven_at: null };
  const shortPath = makeSegment({ dayOffset: 2, path: [[-97.1, 31.5]] });

  const model = prepareModel(buildPayload([good, noDate, shortPath]), NOW_MS);
  assert.equal(model.count, 1);
  assert.equal(model.segments[0].segmentId, good.segment_id);
});

test("prepareModel returns null when nothing is renderable", () => {
  assert.equal(prepareModel(buildPayload([]), NOW_MS), null);
  const noDate = { ...makeSegment({ dayOffset: 1 }), first_driven_at: null };
  assert.equal(prepareModel(buildPayload([noDate]), NOW_MS), null);
});

test("segments are founding-ordered with strictly increasing progress and altitude", () => {
  const segments = [
    ...makeBurst(400, 20),
    ...makeBurst(0, 20),
    ...makeBurst(200, 20),
  ];
  const model = prepareModel(buildPayload(segments), NOW_MS);

  assert.equal(model.count, 60);
  for (let i = 1; i < model.count; i += 1) {
    assert.ok(
      model.segments[i].firstMs >= model.segments[i - 1].firstMs,
      "founding order is sorted"
    );
    assert.ok(
      model.progress[i] > model.progress[i - 1],
      "progress is strictly increasing"
    );
    assert.ok(
      model.segments[i].altitude >= model.segments[i - 1].altitude,
      "altitude is monotone in founding order"
    );
  }
  assert.equal(model.segments[0].rank, 0);
  assert.equal(model.progress[0], 0);
  assert.ok(Math.abs(model.progress[model.count - 1] - 1) < 1e-9);
  assert.ok(model.heightM >= 400 && model.heightM <= 5200);

  for (const seg of model.segments) {
    assert.equal(seg.pathZ.length, seg.path.length);
    for (const pt of seg.pathZ) {
      assert.equal(pt.length, 3);
      assert.equal(pt[2], seg.altitude);
    }
  }
});

test("prefix miles accumulate in founding order", () => {
  const segments = [
    makeSegment({ dayOffset: 0, lengthMiles: 1 }),
    makeSegment({ dayOffset: 100, lengthMiles: 2 }),
    makeSegment({ dayOffset: 200, lengthMiles: 3 }),
  ];
  const model = prepareModel(buildPayload(segments), NOW_MS);
  assert.deepEqual(Array.from(model.prefixMiles), [0, 1, 3, 6]);
  assert.equal(model.totalMiles, 6);
});

test("chapters split on long pauses and cover every segment contiguously", () => {
  const segments = [
    ...makeBurst(0, 20),
    ...makeBurst(210, 30),
    ...makeBurst(630, 15),
  ];
  const model = prepareModel(buildPayload(segments), NOW_MS);

  assert.equal(model.chapters.length, 3);
  assert.deepEqual(
    model.chapters.map((c) => c.count),
    [20, 30, 15]
  );

  let expectedStart = 0;
  for (const chapter of model.chapters) {
    assert.equal(chapter.startIndex, expectedStart);
    expectedStart = chapter.endIndex + 1;
    assert.ok(chapter.endProgress >= chapter.startProgress);
  }
  assert.equal(expectedStart, model.count);

  for (const seg of model.segments) {
    const chapter = model.chapters[seg.chapterIndex];
    assert.ok(seg.rank >= chapter.startIndex && seg.rank <= chapter.endIndex);
  }
});

test("chapters merge down to at most six eras", () => {
  const segments = [];
  for (let burst = 0; burst < 10; burst += 1) {
    segments.push(...makeBurst(burst * 100, 12));
  }
  const model = prepareModel(buildPayload(segments), NOW_MS);
  assert.ok(model.chapters.length <= 6);
  assert.equal(
    model.chapters.reduce((sum, c) => sum + c.count, 0),
    model.count
  );
});

test("sliver chapters are absorbed into neighbors", () => {
  const enriched = (segments) =>
    prepareModel(buildPayload(segments), NOW_MS).segments;
  const chapters = computeChapters(
    enriched([...makeBurst(0, 30), ...makeBurst(300, 3), ...makeBurst(600, 30)])
  );
  // The 3-segment blip cannot stand as its own era.
  for (const chapter of chapters) {
    assert.ok(chapter.count >= 8);
  }
});

test("progressIndex finds the last visible segment", () => {
  const segments = [...makeBurst(0, 10), ...makeBurst(300, 10)];
  const model = prepareModel(buildPayload(segments), NOW_MS);
  const { progress } = model;
  const n = model.count;

  assert.equal(progressIndex(progress, 0), 0);
  assert.equal(progressIndex(progress, 1), n - 1);
  assert.equal(progressIndex(progress, 2), n - 1);

  for (const k of [3, 9, 14]) {
    const midpoint = (progress[k] + progress[k + 1]) / 2;
    assert.equal(progressIndex(progress, midpoint), k);
    assert.equal(progressIndex(progress, progress[k]), k);
  }
});

test("records surface founding, newest, backbone, forgotten, and one-visit streets", () => {
  const segments = [
    makeSegment({ dayOffset: 0, name: "Founders Way", lastDayOffset: 700 }),
    makeSegment({ dayOffset: 10, name: "Lost Lane", lastDayOffset: 10 }),
    makeSegment({
      dayOffset: 20,
      name: "Backbone Blvd",
      lastDayOffset: 650,
      lengthMiles: 2,
    }),
    makeSegment({
      dayOffset: 30,
      name: "Backbone Blvd",
      lastDayOffset: 640,
      lengthMiles: 2.5,
    }),
    makeSegment({ dayOffset: 90, name: "New Street", lastDayOffset: 90 }),
  ];
  const model = prepareModel(buildPayload(segments), NOW_MS);
  const { records } = model;

  assert.equal(records.founding.streetName, "Founders Way");
  assert.equal(records.newest.streetName, "New Street");
  assert.equal(records.backbone.name, "Backbone Blvd");
  assert.equal(records.backbone.count, 2);
  assert.ok(Math.abs(records.backbone.miles - 4.5) < 1e-9);
  assert.equal(records.forgotten.streetName, "Lost Lane");
  // Lost Lane and New Street were never revisited.
  assert.equal(records.onceCount, 2);
  assert.ok(Math.abs(records.oncePct - 40) < 1e-9);

  assert.equal(model.segments.find((s) => s.streetName === "Lost Lane").revisited, false);
  assert.equal(
    model.segments.find((s) => s.streetName === "Founders Way").revisited,
    true
  );
});

test("street search prefers prefix matches and respects the limit", () => {
  const segments = [
    makeSegment({ dayOffset: 0, name: "Austin Avenue", lengthMiles: 3 }),
    makeSegment({ dayOffset: 1, name: "Austin Court", lengthMiles: 0.2 }),
    makeSegment({ dayOffset: 2, name: "South Austin Street", lengthMiles: 5 }),
    makeSegment({ dayOffset: 3, name: "Bosque Blvd", lengthMiles: 1 }),
  ];
  const model = prepareModel(buildPayload(segments), NOW_MS);

  const results = searchStreets(model.nameIndex, "austin");
  assert.deepEqual(
    results.map((r) => r.name),
    ["Austin Avenue", "Austin Court", "South Austin Street"]
  );

  assert.equal(searchStreets(model.nameIndex, "a").length, 0, "needs 2+ chars");
  assert.equal(searchStreets(model.nameIndex, "austin", 2).length, 2);
});

test("chapter spans format compactly", () => {
  const may = Date.parse("2020-05-05T00:00:00Z");
  const august = Date.parse("2020-08-20T00:00:00Z");
  const nextYear = Date.parse("2021-02-10T00:00:00Z");
  assert.equal(formatChapterSpan(may, may), "May 2020");
  assert.equal(formatChapterSpan(may, august), "May–Aug 2020");
  assert.equal(formatChapterSpan(may, nextYear), "May 2020 – Feb 2021");
});
