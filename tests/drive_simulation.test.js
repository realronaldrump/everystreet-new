import assert from "node:assert/strict";
import test from "node:test";
import apiClient from "../static/js/modules/core/api-client.js";
import { DriveSimulation } from "../static/js/modules/optimal-route/simulation.js";

test("route planner simulation ignores a stale response after selection changes", async () => {
  const originalPost = apiClient.post;
  let resolveFirst;
  let callCount = 0;
  const updates = [];
  apiClient.post = async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    }
    return {
      success: true,
      marker: "current",
      current: { coverage_percentage: 10 },
      projected: { coverage_percentage: 11 },
    };
  };
  try {
    const simulation = new DriveSimulation(
      { map: null },
      { onStatsUpdate: (data) => updates.push(data) }
    );
    simulation.areaId = "area-1";
    simulation.selectedSegments.set("first", {
      properties: { segment_id: "first", status: "undriven" },
    });
    const staleRequest = simulation._simulate();
    simulation.selectedSegments.clear();
    simulation.selectedSegments.set("second", {
      properties: { segment_id: "second", status: "undriven" },
    });
    await simulation._simulate();
    resolveFirst({
      success: true,
      marker: "stale",
      current: { coverage_percentage: 10 },
      projected: { coverage_percentage: 12 },
    });
    await staleRequest;
    assert.equal(updates.length, 1);
    assert.equal(updates[0].marker, "current");
    assert.equal(updates[0].selectedCount, 1);
  } finally {
    apiClient.post = originalPost;
  }
});
