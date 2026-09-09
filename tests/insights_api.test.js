import assert from "node:assert/strict";
import test from "node:test";
import apiClient from "../static/js/modules/core/api-client.js";
import { loadAllData } from "../static/js/modules/insights/api.js";

test("overview requests only the selected range and never waits on movement or unused comparisons", async () => {
  const original = apiClient.get;
  const calls = [];
  apiClient.get = async (url, options) => {
    calls.push({ url, options });
    return { total_trips: 2 };
  };
  try {
    const controller = new AbortController();
    const data = await loadAllData(
      { start: "2026-09-01", end: "2026-09-08" },
      controller.signal
    );
    assert.equal(data.current.insights.total_trips, 2);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.url.includes("start_date=2026-09-01")));
    assert.ok(calls.every((call) => call.options.signal === controller.signal));
    assert.ok(
      calls
        .find((call) => call.url.includes("driving-insights"))
        .url.includes("include_movement=false")
    );
    assert.ok(calls.every((call) => !call.url.includes("driver-behavior")));
  } finally {
    apiClient.get = original;
  }
});
