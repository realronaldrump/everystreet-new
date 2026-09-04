import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import {
  processingSummary,
  startTripProcessingMonitor,
} from "../static/js/modules/trip-processing-monitor.js";

test("processing summary distinguishes provider delay, coverage and failures", () => {
  const summary = processingSummary({
    historical_sync: { pending: 1, failed: 0 },
    coverage: { pending: 2, failed: 1 },
  });
  assert.equal(summary.pending, 3);
  assert.equal(summary.failed, 1);
  assert.match(summary.text, /Waiting for completed drive history/);
  assert.match(summary.text, /Updating coverage/);
  assert.match(summary.text, /1 drive update needs attention/);
});

test("revision changes refresh open views once and stop cleanly", async () => {
  const doc = new EventTarget();
  doc.hidden = false;
  doc.body = { dataset: { authRole: "owner" } };
  doc.getElementById = () => null;
  let revision = "1";
  let updates = 0;
  doc.addEventListener("historicalTripsUpdated", () => updates++);
  const stop = startTripProcessingMonitor({
    doc,
    api: { get: async () => ({ revision }) },
    intervalMs: 60000,
  });
  try {
    await setImmediate();
    assert.equal(updates, 0);
    revision = "2";
    doc.dispatchEvent(new Event("visibilitychange"));
    await setImmediate();
    assert.equal(updates, 1);
    doc.dispatchEvent(new Event("visibilitychange"));
    await setImmediate();
    assert.equal(updates, 1);
  } finally {
    stop();
  }
  revision = "3";
  doc.dispatchEvent(new Event("visibilitychange"));
  await setImmediate();
  assert.equal(updates, 1);
});
