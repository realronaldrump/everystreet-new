import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregatePeriods,
  computeConsistencyStats,
  computeExplorationStats,
  computeFuelLens,
  computeTimeSignature,
  deriveInsightsSnapshot,
} from "../static/js/modules/insights/derived-insights.js";

test("aggregatePeriods groups daily data into weekly and monthly buckets", () => {
  const daily = [
    { date: "2026-01-01", distance: 10, count: 1 },
    { date: "2026-01-02", distance: 20, count: 2 },
    { date: "2026-01-08", distance: 5, count: 1 },
    { date: "2026-02-01", distance: 30, count: 3 },
  ];

  const weekly = aggregatePeriods(daily, "weekly");
  const monthly = aggregatePeriods(daily, "monthly");

  assert.equal(weekly.length, 3);
  assert.equal(weekly[0].trips, 3);
  assert.equal(weekly[0].distance, 30);

  assert.equal(monthly.length, 2);
  assert.equal(monthly[0].trips, 4);
  assert.equal(monthly[0].distance, 35);
  assert.equal(monthly[1].trips, 3);
  assert.equal(monthly[1].distance, 30);
});

test("computeConsistencyStats summarizes active and quiet days", () => {
  const daily = [
    { date: "2026-01-01", distance: 8, count: 1 },
    { date: "2026-01-02", distance: 6, count: 1 },
    { date: "2026-01-04", distance: 9, count: 2 },
  ];

  const stats = computeConsistencyStats(daily);

  assert.equal(stats.activeDays, 3);
  assert.equal(stats.spanDays, 4);
  assert.equal(stats.quietDays, 1);
  assert.equal(stats.activeDaysRatio, 75);
});

test("computeConsistencyStats includes quiet days at both ends of the selected range", () => {
  const stats = computeConsistencyStats(
    [{ date: "2026-07-15", distance: 8, count: 1 }],
    { start: "2026-07-01", end: "2026-07-31" }
  );

  assert.equal(stats.activeDays, 1);
  assert.equal(stats.spanDays, 31);
  assert.equal(stats.quietDays, 30);
  assert.equal(stats.activeDaysRatio, 3.2);
});

test("computeExplorationStats differentiates routine vs diversified patterns", () => {
  const concentrated = computeExplorationStats(
    [
      { location: "Home", visits: 18 },
      { location: "Store", visits: 2 },
    ],
    20
  );
  const diversified = computeExplorationStats(
    [
      { location: "Home", visits: 5 },
      { location: "Gym", visits: 5 },
      { location: "Cafe", visits: 5 },
      { location: "Office", visits: 5 },
    ],
    20
  );

  assert.ok(concentrated.explorationScore < diversified.explorationScore);
  assert.ok(concentrated.topShareTrips > diversified.topShareTrips);
});

test("computeTimeSignature works with sparse and dense distributions", () => {
  const sparse = computeTimeSignature([], []);
  assert.equal(sparse.totalTrips, 0);
  assert.equal(sparse.hourly.length, 24);
  assert.equal(sparse.weekday.length, 7);
  assert.equal(sparse.weightedHour, null);
  assert.equal(sparse.weightedHourLabel, "--");

  const dense = computeTimeSignature(
    [
      { hour: 7, count: 2 },
      { hour: 8, count: 8 },
      { hour: 17, count: 4 },
      { hour: 18, count: 10 },
    ],
    [
      { day: 1, count: 3 },
      { day: 2, count: 11 },
      { day: 3, count: 2 },
    ]
  );

  assert.equal(dense.totalTrips, 24);
  assert.equal(dense.peakHour, 18);
  assert.equal(dense.peakDayLabel, "Tuesday");
});

test("computeTimeSignature averages clock hours circularly across midnight", () => {
  const signature = computeTimeSignature(
    [
      { hour: 23, count: 1 },
      { hour: 1, count: 1 },
    ],
    []
  );

  assert.equal(signature.weightedHour, 0);
  assert.equal(signature.weightedHourLabel, "12 AM");
});

test("computeFuelLens safely handles zero fuel and standard ratios", () => {
  const noFuel = computeFuelLens(0, 120, 6);
  assert.equal(noFuel.mpg, null);

  const withFuel = computeFuelLens(8, 240, 6);
  assert.equal(withFuel.mpg, 30);
  assert.equal(withFuel.fuelPerTrip, 1.33);
});

test("deriveInsightsSnapshot pairs fuel with distance from fuel-bearing trips", () => {
  const snapshot = deriveInsightsSnapshot({
    insights: {
      total_trips: 2,
      total_distance: 20,
      total_fuel_consumed: 9,
      fuel_consumed_for_mpg: 1,
      fuel_distance: 10,
      fuel_trip_count: 1,
    },
  });

  assert.equal(snapshot.fuelLens.mpg, 10);
  assert.equal(snapshot.fuelLens.totalDistance, 10);
  assert.equal(snapshot.fuelLens.totalTrips, 1);
});

test("deriveInsightsSnapshot does not fabricate time patterns for an empty range", () => {
  const snapshot = deriveInsightsSnapshot({});
  const signature = snapshot.patternCards.find((card) => card.id === "signature");
  const weekday = snapshot.patternCards.find((card) => card.id === "weekday");

  assert.equal(signature.value, "--");
  assert.equal(signature.detail, "No trip start-time data in this range.");
  assert.equal(signature.action, null);
  assert.equal(weekday.value, "--");
  assert.equal(weekday.detail, "No weekday trip data in this range.");
  assert.equal(weekday.action, null);
});
