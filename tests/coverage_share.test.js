import assert from "node:assert/strict";
import test from "node:test";
import {
  buildShareModel,
  frameAt,
  FILM_SECONDS,
} from "../static/js/modules/features/coverage-share/model.js";
import {
  recordFilm,
  videoFormat,
} from "../static/js/modules/features/coverage-share/video.js";

const area = {
  id: "waco",
  display_name: "Waco, McLennan County, Texas, United States",
  area_type: "city",
};
const street = (id, status, miles, date = null) => ({
  type: "Feature",
  geometry: {
    type: "LineString",
    coordinates: [
      [-97.15, 31.5],
      [-97.14, 31.51],
    ],
  },
  properties: { segment_id: id, status, length_miles: miles, first_driven_at: date },
});
const collection = (...features) => ({ type: "FeatureCollection", features });

test("film metrics use the full geometry snapshot and exclude undriveable mileage", () => {
  const model = buildShareModel(
    { ...area, coverage_percentage: 99 },
    collection(
      street("a", "driven", 6, "2025-01-01T00:00:00Z"),
      street("b", "undriven", 4),
      street("c", "undriveable", 50)
    )
  );
  assert.equal(model.name, "Waco");
  assert.equal(model.subtitle, "Texas · United States");
  assert.equal(model.filename, "waco");
  assert.equal(model.totalMiles, 10);
  assert.equal(frameAt(model, FILM_SECONDS).percent, 60);
  assert.equal(frameAt(model, FILM_SECONDS).miles, 6);
});

test("the reveal uses first discovery, keeps simultaneous discoveries together, and can rewind", () => {
  const model = buildShareModel(
    area,
    collection(
      street("late", "driven", 3, "2026-01-01T00:00:00Z"),
      street("early", "driven", 2, "2025-01-01T00:00:00Z"),
      street("same", "driven", 1, "2025-01-01 00:00:00+00:00")
    )
  );
  assert.deepEqual(
    model.driven.map((r) => r.id),
    ["early", "same", "late"]
  );
  assert.equal(model.driven[0].start, model.driven[1].start);
  assert.equal(frameAt(model, 0).miles, 0);
  assert.equal(frameAt(model, 5).miles, 3);
  assert.equal(frameAt(model, 12).miles, 6);
  assert.equal(frameAt(model, 5).miles, 3);
  assert.equal(frameAt(model, -4).time, 0);
  assert.equal(frameAt(model, 99).percent, 100);
});

test("undated streets start visible and never acquire an invented timestamp", () => {
  const model = buildShareModel(
    area,
    collection(
      street("unknown", "driven", 2),
      street("invalid-date", "driven", 1, "invalid"),
      street("dated", "driven", 3, "2025-01-01T00:00:00Z")
    )
  );
  assert.equal(model.undatedCount, 2);
  assert.equal(frameAt(model, 0).miles, 3);
  assert.equal(frameAt(model, 0).date, null);
  assert.equal(frameAt(model, 12).miles, 6);
});

test("zero coverage, complete coverage, and a single discovery date produce finite frames", () => {
  for (const status of ["driven", "undriven"]) {
    const model = buildShareModel(
      area,
      collection(street("one", status, 1, "2025-01-01T00:00:00Z"))
    );
    for (const time of [0, 0.9, 5, 12])
      assert.ok(Number.isFinite(frameAt(model, time).percent));
    assert.equal(frameAt(model, 12).percent, status === "driven" ? 100 : 0);
  }
});

test("incomplete or duplicate geometry cannot produce misleading export statistics", () => {
  assert.throws(() => buildShareModel(area, collection()), /no street geometry/);
  const one = street("same", "driven", 1);
  assert.throws(() => buildShareModel(area, collection(one, one)), /incomplete/);
  for (const value of [NaN, -1, null, "5"]) {
    assert.throws(
      () => buildShareModel(area, collection(street("x", "driven", value))),
      /incomplete/
    );
  }
  const bad = street("bad", "driven", 1);
  bad.geometry.coordinates[0][0] = Infinity;
  assert.throws(() => buildShareModel(area, collection(bad)), /incomplete/);
  assert.throws(
    () => buildShareModel(area, collection(street("x", "undriveable", 5))),
    /no drivable/
  );
});

test("multipart streets count their mileage once and non-city names retain their context", () => {
  const road = street("multi", "driven", 5);
  road.geometry = {
    type: "MultiLineString",
    coordinates: [
      road.geometry.coordinates,
      [
        [-97.11, 31.54],
        [-97.1, 31.55],
      ],
    ],
  };
  const model = buildShareModel(
    {
      ...area,
      area_type: "county",
      display_name: "McLennan County, Texas, United States",
    },
    collection(road)
  );
  assert.equal(model.drivenMiles, 5);
  assert.equal(model.roads[0].lines.length, 2);
  assert.equal(model.subtitle, "Texas · United States");
});

test("video format selects a supported container and an honest filename extension", () => {
  assert.equal(videoFormat(null), null);
  assert.equal(videoFormat({ isTypeSupported: () => false }), null);
  assert.equal(
    videoFormat({ isTypeSupported: (mime) => mime.startsWith("video/mp4") }).extension,
    "mp4"
  );
  assert.equal(
    videoFormat({ isTypeSupported: (mime) => mime === "video/webm;codecs=vp8" })
      .extension,
    "webm"
  );
});

test("cancelling recording releases every track and never returns a partial video", async (t) => {
  const document = new EventTarget();
  document.hidden = false;
  const tracks = [{ stop: t.mock.fn() }, { stop: t.mock.fn() }];
  let recorder;
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    constructor() {
      recorder = this;
      this.state = "inactive";
      this.mimeType = "video/mp4";
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => this.onstop());
    }
  }
  t.mock.method(globalThis, "setTimeout", () => 1);
  for (const [key, value] of Object.entries({
    document,
    MediaRecorder: Recorder,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
    t.after(() =>
      descriptor
        ? Object.defineProperty(globalThis, key, descriptor)
        : delete globalThis[key]
    );
  }
  const controller = new AbortController();
  const promise = recordFilm(
    { canvas: { captureStream: () => ({ getTracks: () => tracks }) }, draw() {} },
    { signal: controller.signal }
  );
  controller.abort();
  await assert.rejects(promise, { name: "AbortError" });
  assert.equal(recorder.state, "inactive");
  tracks.forEach((track) => assert.equal(track.stop.mock.callCount(), 1));
});
