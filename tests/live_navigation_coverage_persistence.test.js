import assert from "node:assert/strict";
import test from "node:test";

import LiveNavigationAPI from "../static/js/modules/live-navigation/live-navigation-api.js";
import LiveNavigationCoverage from "../static/js/modules/live-navigation/live-navigation-coverage.js";

test("persistDrivenSegments sends queued segments and clears state on success", async () => {
  const coverage = new LiveNavigationCoverage();
  coverage.selectedAreaId = "area-1";
  coverage.pendingSegmentUpdates.add("seg-1");
  coverage.pendingSegmentUpdates.add("seg-2");
  const originalBasePersist = LiveNavigationAPI.persistDrivenSegments;
  const baseCalls = [];

  LiveNavigationAPI.persistDrivenSegments = async (...args) => {
    baseCalls.push(args);
    return { success: true };
  };

  try {
    await coverage.persistDrivenSegments();
    assert.equal(coverage.pendingSegmentUpdates.size, 0);
    assert.equal(coverage.consecutivePersistFailures, 0);
    assert.deepEqual(baseCalls, [[["seg-1", "seg-2"], "area-1"]]);
  } finally {
    clearTimeout(coverage.persistRetryTimeout);
    LiveNavigationAPI.persistDrivenSegments = originalBasePersist;
  }
});

test("persistDrivenSegments re-queues segments and schedules retry on failure", async () => {
  const coverage = new LiveNavigationCoverage();
  coverage.selectedAreaId = "area-2";
  coverage.pendingSegmentUpdates.add("seg-a");
  coverage.pendingSegmentUpdates.add("seg-b");

  const originalBasePersist = LiveNavigationAPI.persistDrivenSegments;
  const issues = [];

  coverage.setCallbacks({
    onPersistenceIssue: (payload) => {
      issues.push(payload);
    },
  });

  LiveNavigationAPI.persistDrivenSegments = async () => {
    throw new Error("base write failed");
  };

  try {
    await coverage.persistDrivenSegments();
    assert.equal(coverage.pendingSegmentUpdates.size, 2);
    assert.equal(coverage.consecutivePersistFailures, 1);
    assert.ok(coverage.persistRetryTimeout);
    assert.equal(
      issues.some((issue) => issue?.type === "base_failed"),
      true
    );
    assert.equal(
      issues.some((issue) => issue?.type === "retry_scheduled"),
      true
    );
    assert.deepEqual(Array.from(coverage.pendingSegmentUpdates).sort(), [
      "seg-a",
      "seg-b",
    ]);
  } finally {
    clearTimeout(coverage.persistRetryTimeout);
    LiveNavigationAPI.persistDrivenSegments = originalBasePersist;
  }
});

test("persistDrivenSegments stops auto-retrying after max consecutive failures", async () => {
  const coverage = new LiveNavigationCoverage();
  coverage.selectedAreaId = "area-3";
  coverage.maxPersistRetries = 2;
  coverage.pendingSegmentUpdates.add("seg-fail");

  const issues = [];
  coverage.setCallbacks({
    onPersistenceIssue: (payload) => {
      issues.push(payload);
    },
  });

  const originalBasePersist = LiveNavigationAPI.persistDrivenSegments;
  LiveNavigationAPI.persistDrivenSegments = async () => {
    throw new Error("base write failed");
  };

  try {
    await coverage.persistDrivenSegments();
    await coverage.persistDrivenSegments();
    assert.equal(coverage.consecutivePersistFailures, 2);
    assert.equal(
      issues.some((issue) => issue?.type === "retry_exhausted"),
      true
    );
  } finally {
    clearTimeout(coverage.persistRetryTimeout);
    LiveNavigationAPI.persistDrivenSegments = originalBasePersist;
  }
});
