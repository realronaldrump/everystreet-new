import assert from "node:assert/strict";
import test from "node:test";

import apiClient from "../static/js/modules/core/api-client.js";
import { OptimalRouteAPI } from "../static/js/modules/optimal-route/api.js";

test("fetchActiveMission returns null when no area is provided", async () => {
  const api = new OptimalRouteAPI();
  const value = await api.fetchActiveMission("");
  assert.equal(value, null);
});

test("fetchMissionHistory builds expected query and returns missions array", async () => {
  const api = new OptimalRouteAPI();
  const originalGet = apiClient.get;
  const calls = [];
  apiClient.get = async (...args) => {
    calls.push(args);
    return {
      status: "success",
      missions: [{ id: "m1" }, { id: "m2" }],
    };
  };

  try {
    const missions = await api.fetchMissionHistory("area-99", {
      limit: 5,
      status: "completed",
    });
    assert.deepEqual(missions, [{ id: "m1" }, { id: "m2" }]);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0][0],
      "/api/coverage/missions?area_id=area-99&limit=5&offset=0&status=completed"
    );
  } finally {
    apiClient.get = originalGet;
  }
});

test("fetchMissionHistory returns empty list on API failure", async () => {
  const api = new OptimalRouteAPI();
  const originalGet = apiClient.get;
  apiClient.get = async () => {
    throw new Error("boom");
  };

  try {
    const missions = await api.fetchMissionHistory("area-99", { limit: 10 });
    assert.deepEqual(missions, []);
  } finally {
    apiClient.get = originalGet;
  }
});
