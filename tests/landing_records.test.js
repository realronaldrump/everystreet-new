import assert from "node:assert/strict";
import test from "node:test";
import { formatWheelTime } from "../static/js/modules/features/landing/logbook.js";
import { buildRecordEntries } from "../static/js/modules/features/landing/records.js";
import { mapWeatherCode } from "../static/js/modules/features/landing/weather.js";

test("record entries skip empty values and keep a fixed order", () => {
  const entries = buildRecordEntries({
    insights: {
      records: {
        longest_trip: { distance: 212.4, recorded_at: "2026-09-10" },
        max_speed: { max_speed: 0, recorded_at: "2026-09-10" },
        max_day_trips: { trips: 1, date: "2026-09-19" },
        most_visited: {
          location: "City Market",
          count: 41,
          lastVisit: "2026-09-21T18:00:00Z",
        },
      },
    },
    gas: { records: { best_mpg: { mpg: 27.9, fillup_time: "2026-09-02T15:00:00Z" } } },
    counties: { success: true, totalVisited: 38, lastUpdated: "2026-09-20T00:00:00Z" },
    coverage: {
      areas: [
        {
          display_name: "Waco",
          coverage_percentage: 62.9,
          last_synced: "2026-09-20T00:00:00Z",
        },
        {
          display_name: "Carbondale",
          coverage_percentage: 90.8,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    },
  });

  assert.deepEqual(
    entries.map((entry) => entry.id),
    [
      "longest-trip-distance",
      "max-day-trips",
      "most-visited",
      "best-mpg",
      "counties-visited",
      "coverage-best",
    ]
  );
  assert.equal(entries[0].value, "212.4 mi");
  assert.match(entries[0].dateText, /^On Sep 10, 2026$/);
  assert.equal(entries[1].value, "1 trip");
  assert.equal(entries[2].title, "Most visited destination: City Market");
  assert.match(entries[2].dateText, /^Last visit /);
  assert.equal(entries[3].value, "27.9 mpg");
  assert.equal(entries[4].value, "38 counties");
  assert.equal(entries[5].title, "Coverage in Carbondale");
  assert.match(entries[5].dateText, /^Created /);
});

test("record entries are empty without sources", () => {
  assert.deepEqual(buildRecordEntries({}), []);
});

test("weather codes map to printed labels", () => {
  assert.equal(mapWeatherCode(0), "Clear");
  assert.equal(mapWeatherCode(2), "Partly Cloudy");
  assert.equal(mapWeatherCode(63), "Rain");
  assert.equal(mapWeatherCode(99), "Storm");
  assert.equal(mapWeatherCode(12), "Clear");
  assert.equal(mapWeatherCode("not a code"), null);
});

test("wheel time reads in hours, then minutes under an hour", () => {
  assert.deepEqual(formatWheelTime(0), { value: "0", unit: "hr" });
  assert.deepEqual(formatWheelTime(1800), { value: "30", unit: "min" });
  assert.deepEqual(formatWheelTime(5400), { value: "1.5", unit: "hr" });
  assert.deepEqual(formatWheelTime(187260), { value: "52", unit: "hr" });
});
