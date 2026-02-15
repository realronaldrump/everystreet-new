import assert from "node:assert/strict";
import test from "node:test";

import apiClient from "../static/js/modules/core/api-client.js";
import TurnByTurnAPI, {
  buildTurnByTurnUrl,
} from "../static/js/modules/turn-by-turn/turn-by-turn-api.js";
import TurnByTurnNavigator from "../static/js/modules/turn-by-turn/turn-by-turn-navigator.js";

test("buildTurnByTurnUrl encodes area and mission state", () => {
  assert.equal(buildTurnByTurnUrl(), "/turn-by-turn");
  assert.equal(
    buildTurnByTurnUrl({ areaId: "area-123" }),
    "/turn-by-turn?areaId=area-123"
  );
  assert.equal(
    buildTurnByTurnUrl({
      areaId: "area 123",
      missionId: "mission/42",
      autoStart: true,
    }),
    "/turn-by-turn?areaId=area+123&missionId=mission%2F42&autoStart=true"
  );
});

test("persistDrivenSegmentsForMission posts mission_id payload", async () => {
  const originalPost = apiClient.post;
  const calls = [];
  apiClient.post = async (...args) => {
    calls.push(args);
    return { success: true };
  };

  try {
    const response = await TurnByTurnAPI.persistDrivenSegmentsForMission(
      ["seg-1", "seg-2"],
      "area-1",
      "mission-9"
    );

    assert.deepEqual(response, { success: true });
    assert.deepEqual(calls, [
      [
        "/api/coverage/areas/area-1/streets/mark-driven",
        {
          segment_ids: ["seg-1", "seg-2"],
          mission_id: "mission-9",
        },
      ],
    ]);
  } finally {
    apiClient.post = originalPost;
  }
});

test("cancelMission posts to cancel endpoint and returns mission payload", async () => {
  const originalPost = apiClient.post;
  const calls = [];
  apiClient.post = async (...args) => {
    calls.push(args);
    return { mission: { id: "m-1", status: "cancelled" } };
  };

  try {
    const mission = await TurnByTurnAPI.cancelMission("m-1", { note: "stop" });
    assert.deepEqual(mission, { id: "m-1", status: "cancelled" });
    assert.deepEqual(calls, [
      [
        "/api/coverage/missions/m-1/cancel",
        { note: "stop" },
      ],
    ]);
  } finally {
    apiClient.post = originalPost;
  }
});

test("listMissions builds stable query parameters", async () => {
  const originalGet = apiClient.get;
  const calls = [];
  apiClient.get = async (...args) => {
    calls.push(args);
    return { status: "success", missions: [] };
  };

  try {
    await TurnByTurnAPI.listMissions({
      areaId: "abc",
      status: "completed",
      limit: 50,
      offset: 10,
    });

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0][0],
      "/api/coverage/missions?area_id=abc&status=completed&limit=50&offset=10"
    );
  } finally {
    apiClient.get = originalGet;
  }
});

test("fetchOptimalRoute returns null on API failure", async () => {
  const originalGet = apiClient.get;
  apiClient.get = async () => {
    throw new Error("missing route");
  };

  try {
    const route = await TurnByTurnAPI.fetchOptimalRoute("area-x");
    assert.equal(route, null);
  } finally {
    apiClient.get = originalGet;
  }
});

function createNavigatorMethodHarness(overrides = {}) {
  return {
    selectedAreaId: "area-1",
    activeMission: null,
    activeMissionId: null,
    pendingMissionId: null,
    coverage: {
      setMissionContext: () => {},
    },
    ui: {
      updateMissionSummary: () => {},
      resetMissionSummary: () => {},
      setNavStatus: () => {},
    },
    clearActiveMission: TurnByTurnNavigator.prototype.clearActiveMission,
    setActiveMission: TurnByTurnNavigator.prototype.setActiveMission,
    buildMissionCreatePayload: () => ({ area_id: "area-1" }),
    ...overrides,
  };
}

test("setActiveMission keeps pending deep-link for paused mission", () => {
  const harness = createNavigatorMethodHarness({
    pendingMissionId: "mission-77",
  });

  TurnByTurnNavigator.prototype.setActiveMission.call(harness, {
    id: "mission-77",
    area_id: "area-1",
    status: "paused",
  });

  assert.equal(harness.pendingMissionId, "mission-77");
  assert.equal(harness.activeMissionId, "mission-77");
});

test("ensureMissionForNavigation clears pending mission after deep-link resume", async () => {
  const harness = createNavigatorMethodHarness({
    pendingMissionId: "mission-88",
  });

  const originalFetchMission = TurnByTurnAPI.fetchMission;
  const originalResumeMission = TurnByTurnAPI.resumeMission;
  const originalFetchActiveMission = TurnByTurnAPI.fetchActiveMission;
  const originalCreateMission = TurnByTurnAPI.createMission;

  TurnByTurnAPI.fetchMission = async (missionId) => ({
    id: missionId,
    area_id: "area-1",
    status: "paused",
  });
  TurnByTurnAPI.resumeMission = async (missionId) => ({
    id: missionId,
    area_id: "area-1",
    status: "active",
  });
  TurnByTurnAPI.fetchActiveMission = async () => {
    throw new Error("should not be called");
  };
  TurnByTurnAPI.createMission = async () => {
    throw new Error("should not be called");
  };

  try {
    const ready = await TurnByTurnNavigator.prototype.ensureMissionForNavigation.call(harness);
    assert.equal(ready, true);
    assert.equal(harness.pendingMissionId, null);
    assert.equal(harness.activeMissionId, "mission-88");
    assert.equal(harness.activeMission?.status, "active");
  } finally {
    TurnByTurnAPI.fetchMission = originalFetchMission;
    TurnByTurnAPI.resumeMission = originalResumeMission;
    TurnByTurnAPI.fetchActiveMission = originalFetchActiveMission;
    TurnByTurnAPI.createMission = originalCreateMission;
  }
});

test("ensureMissionForNavigation ignores pending mission from another area", async () => {
  const harness = createNavigatorMethodHarness({
    selectedAreaId: "area-2",
    pendingMissionId: "mission-foreign",
    activeMissionId: "mission-foreign",
    activeMission: {
      id: "mission-foreign",
      area_id: "area-1",
      status: "active",
    },
  });

  const originalFetchMission = TurnByTurnAPI.fetchMission;
  const originalResumeMission = TurnByTurnAPI.resumeMission;
  const originalFetchActiveMission = TurnByTurnAPI.fetchActiveMission;
  const originalCreateMission = TurnByTurnAPI.createMission;
  let createCalls = 0;

  TurnByTurnAPI.fetchMission = async (missionId) => ({
    id: missionId,
    area_id: "area-1",
    status: "active",
  });
  TurnByTurnAPI.resumeMission = async () => {
    throw new Error("should not resume foreign mission");
  };
  TurnByTurnAPI.fetchActiveMission = async (areaId) => ({
    id: `mission-${areaId}`,
    area_id: areaId,
    status: "active",
  });
  TurnByTurnAPI.createMission = async () => {
    createCalls += 1;
    return { mission: { id: "mission-created", area_id: "area-2", status: "active" } };
  };

  try {
    const ready = await TurnByTurnNavigator.prototype.ensureMissionForNavigation.call(harness);
    assert.equal(ready, true);
    assert.equal(harness.pendingMissionId, null);
    assert.equal(harness.activeMissionId, "mission-area-2");
    assert.equal(harness.activeMission?.area_id, "area-2");
    assert.equal(createCalls, 0);
  } finally {
    TurnByTurnAPI.fetchMission = originalFetchMission;
    TurnByTurnAPI.resumeMission = originalResumeMission;
    TurnByTurnAPI.fetchActiveMission = originalFetchActiveMission;
    TurnByTurnAPI.createMission = originalCreateMission;
  }
});

test("ensureMissionForNavigation reports terminal deep-link mission before creating replacement", async () => {
  const navStatusMessages = [];
  const harness = createNavigatorMethodHarness({
    pendingMissionId: "mission-completed",
    ui: {
      updateMissionSummary: () => {},
      resetMissionSummary: () => {},
      setNavStatus: (message) => {
        navStatusMessages.push(message);
      },
    },
  });

  const originalFetchMission = TurnByTurnAPI.fetchMission;
  const originalFetchActiveMission = TurnByTurnAPI.fetchActiveMission;
  const originalCreateMission = TurnByTurnAPI.createMission;

  TurnByTurnAPI.fetchMission = async (missionId) => ({
    id: missionId,
    area_id: "area-1",
    status: "completed",
  });
  TurnByTurnAPI.fetchActiveMission = async () => null;
  TurnByTurnAPI.createMission = async () => ({
    mission: { id: "mission-replacement", area_id: "area-1", status: "active" },
  });

  try {
    const ready = await TurnByTurnNavigator.prototype.ensureMissionForNavigation.call(harness);
    assert.equal(ready, true);
    assert.equal(harness.activeMissionId, "mission-replacement");
    assert.equal(
      navStatusMessages.some((message) => message.includes("cannot be resumed")),
      true
    );
  } finally {
    TurnByTurnAPI.fetchMission = originalFetchMission;
    TurnByTurnAPI.fetchActiveMission = originalFetchActiveMission;
    TurnByTurnAPI.createMission = originalCreateMission;
  }
});

test("beginNavigation blocks startup when mission is unavailable", async () => {
  const navStatusMessages = [];
  let transitionedState = null;
  let started = false;
  const harness = createNavigatorMethodHarness({
    ensureMissionForNavigation: async () => false,
    state: {
      transitionTo: (state) => {
        transitionedState = state;
      },
    },
    startNavigation: () => {
      started = true;
    },
    ui: {
      updateMissionSummary: () => {},
      resetMissionSummary: () => {},
      setNavStatus: (message) => {
        navStatusMessages.push(message);
      },
    },
  });

  await TurnByTurnNavigator.prototype.beginNavigation.call(harness);

  assert.equal(started, false);
  assert.equal(transitionedState, null);
  assert.equal(
    navStatusMessages.includes("Cannot start navigation without an active mission."),
    true
  );
});

test("handlePersistenceIssue clears mission state on mission detach", () => {
  const navStatusMessages = [];
  let stopHeartbeatCalls = 0;
  let clearMissionCalls = 0;
  const harness = createNavigatorMethodHarness({
    stopMissionHeartbeat: () => {
      stopHeartbeatCalls += 1;
    },
    clearActiveMission: () => {
      clearMissionCalls += 1;
    },
    ui: {
      updateMissionSummary: () => {},
      resetMissionSummary: () => {},
      setNavStatus: (message) => {
        navStatusMessages.push(message);
      },
    },
  });

  TurnByTurnNavigator.prototype.handlePersistenceIssue.call(harness, {
    type: "mission_detached",
  });

  assert.equal(stopHeartbeatCalls, 1);
  assert.equal(clearMissionCalls, 1);
  assert.equal(
    navStatusMessages.includes(
      "Mission sync failed. Navigation continues without mission."
    ),
    true
  );
});

test("handlePersistenceIssue reports retry exhaustion", () => {
  const navStatusMessages = [];
  const harness = createNavigatorMethodHarness({
    ui: {
      updateMissionSummary: () => {},
      resetMissionSummary: () => {},
      setNavStatus: (message) => {
        navStatusMessages.push(message);
      },
    },
  });

  TurnByTurnNavigator.prototype.handlePersistenceIssue.call(harness, {
    type: "retry_exhausted",
  });

  assert.equal(
    navStatusMessages.includes(
      "Coverage sync paused after repeated failures. Check network or server health."
    ),
    true
  );
});
