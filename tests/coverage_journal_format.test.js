import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChartModel,
  describeChart,
} from "../static/js/modules/features/coverage-journal/chart.js";
import {
  bucketSeries,
  bucketUnit,
  describeOutlook,
  formatMiles,
  formatPace,
  formatPercent,
  paceRows,
  roadClassLabel,
} from "../static/js/modules/features/coverage-journal/format.js";
import {
  shortAreaName,
  splitAreaName,
} from "../static/js/modules/features/coverage-management/area-name.js";

test("coverage percentages never print done before an area is finished", () => {
  assert.equal(formatPercent(99.96), "99.9%");
  assert.equal(formatPercent(100), "99.9%");
  assert.equal(formatPercent(100, { complete: true }), "100%");
  assert.equal(formatPercent(62.878), "62.9%");
  assert.equal(formatPercent(-1), "0.0%");
});

test("small distances stay visible and slow paces stay in miles", () => {
  assert.equal(formatMiles(0.0623), "329 ft");
  assert.equal(formatMiles(589.7), "589.7 mi");
  assert.equal(formatPace(0.082), "0.08 mi");
  assert.equal(formatPace(2.43), "2.4 mi");
});

test("geocoder names become a place and its region", () => {
  assert.deepEqual(
    splitAreaName("Lacy Lakeview, McLennan County, Texas, 76705, United States"),
    { name: "Lacy Lakeview", region: "McLennan County, TX" }
  );
  assert.deepEqual(splitAreaName("Carbondale, Garfield County, United States"), {
    name: "Carbondale",
    region: "Garfield County",
  });
  assert.equal(shortAreaName("Pitkin County, 81611, United States"), "Pitkin County");
});

test("road classes print in plain words", () => {
  assert.equal(roadClassLabel("motorway_link"), "Freeway ramps");
  assert.equal(roadClassLabel("residential"), "Residential streets");
  assert.equal(roadClassLabel("busway"), "Busway");
});

test("bars group days by week or month as the range grows", () => {
  assert.equal(bucketUnit(90), "day");
  assert.equal(bucketUnit(365), "week");
  assert.equal(bucketUnit(2000), "month");
  const series = [
    { date: "2026-03-02", new_miles: 1 },
    { date: "2026-03-08", new_miles: 2 },
    { date: "2026-03-09", new_miles: 4 },
  ];
  assert.deepEqual(
    bucketSeries(series, "week").map((bar) => [bar.date, bar.new_miles]),
    [
      ["2026-03-02", 3],
      ["2026-03-09", 4],
    ]
  );
  assert.deepEqual(
    bucketSeries(series, "month").map((bar) => [bar.date, bar.new_miles]),
    [["2026-03-01", 7]]
  );
});

test("a range chart opens at the level the range started from and runs to today", () => {
  const model = buildChartModel({
    series: [
      { date: "2026-08-01", new_miles: 1, coverage_percentage: 51 },
      { date: "2026-09-01", new_miles: 1, coverage_percentage: 52 },
    ],
    range: "90d",
    today: "2026-09-23",
    driveableMiles: 100,
    currentLevel: 52,
  });
  assert.equal(model.start, "2026-06-26");
  assert.equal(model.end, "2026-09-23");
  assert.equal(model.startLevel, 50);
  assert.ok(model.yMin <= 50 && model.yMax >= 52 && model.yMax <= 100);
  assert.equal(model.unit, "day");
  assert.match(describeChart(model), /2 days with new streets/);
});

test("the outlook names its pace window and says when progress stalled", () => {
  const outlook = describeOutlook(
    {
      available: true,
      window: "365d",
      miles_per_week: 0.302,
      expected_completion_date: "2048-10-27",
      days_since_progress: 185,
      last_progress_date: "2026-03-22",
    },
    { targetPercentage: 100 }
  );
  assert.equal(
    outlook.lead,
    "At your pace over the last 12 months, 0.30 mi a week, you would reach 100% around October 2048."
  );
  assert.equal(outlook.detail, "No new streets since March 22, 2026.");
  const unavailable = describeOutlook({
    available: false,
    reason: "At this pace, finishing would take more than 50 years.",
  });
  assert.match(unavailable.lead, /50 years/);
});

test("pace rows give each window's finish or say why there is none", () => {
  const rows = paceRows(
    {
      paces: [
        { window: "90d", active_days: 0, miles_per_week: 0 },
        { window: "365d", active_days: 27, miles_per_week: 0.5 },
        { window: "all", active_days: 457, miles_per_week: 0.001 },
      ],
    },
    52,
    "2026-09-23"
  );
  assert.deepEqual(
    rows.map((row) => [row.label, row.finish]),
    [
      ["Last 90 days", "Too few drives"],
      ["Last 12 months", "Sep 2028"],
      ["All time", "Over 50 years"],
    ]
  );
});
