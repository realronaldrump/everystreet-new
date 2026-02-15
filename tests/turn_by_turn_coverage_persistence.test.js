import assert from "node:assert/strict";
import test from "node:test";

import TurnByTurnAPI from "../static/js/modules/turn-by-turn/turn-by-turn-api.js";
import TurnByTurnCoverage from "../static/js/modules/turn-by-turn/turn-by-turn-coverage.js";

test("persistDrivenSegments falls back to base persistence when mission write fails", async () => {
  const coverage = new TurnByTurnCoverage();
  coverage.selectedAreaId = "area-1";
  coverage.setMissionContext("mission-1");
  coverage.pendingSegmentUpdates.add("seg-1");

  const originalMissionPersist = TurnByTurnAPI.persistDrivenSegmentsForMission;
  const originalBasePersist = TurnByTurnAPI.persistDrivenSegments;
  const baseCalls = [];

  TurnByTurnAPI.persistDrivenSegmentsForMission = async () => {
    throw new Error("mission write failed");
  };
  TurnByTurnAPI.persistDrivenSegments = async (...args) => {
    baseCalls.push(args);
    return { success: true };
  };

  try {
    await coverage.persistDrivenSegments();
    assert.equal(coverage.pendingSegmentUpdates.size, 0);
    assert.equal(coverage.activeMissionId, null);
    assert.deepEqual(baseCalls, [[["seg-1"], "area-1"]]);
  } finally {
    TurnByTurnAPI.persistDrivenSegmentsForMission = originalMissionPersist;
    TurnByTurnAPI.persistDrivenSegments = originalBasePersist;
  }
});

test("persistDrivenSegments re-queues segments when mission and base writes both fail", async () => {
  const coverage = new TurnByTurnCoverage();
  coverage.selectedAreaId = "area-2";
  coverage.setMissionContext("mission-2");
  coverage.pendingSegmentUpdates.add("seg-a");
  coverage.pendingSegmentUpdates.add("seg-b");

  const originalMissionPersist = TurnByTurnAPI.persistDrivenSegmentsForMission;
  const originalBasePersist = TurnByTurnAPI.persistDrivenSegments;

  TurnByTurnAPI.persistDrivenSegmentsForMission = async () => {
    throw new Error("mission write failed");
  };
  TurnByTurnAPI.persistDrivenSegments = async () => {
    throw new Error("base write failed");
  };

  try {
    await coverage.persistDrivenSegments();
    assert.equal(coverage.activeMissionId, "mission-2");
    assert.equal(coverage.pendingSegmentUpdates.size, 2);
    assert.deepEqual(Array.from(coverage.pendingSegmentUpdates).sort(), ["seg-a", "seg-b"]);
  } finally {
    TurnByTurnAPI.persistDrivenSegmentsForMission = originalMissionPersist;
    TurnByTurnAPI.persistDrivenSegments = originalBasePersist;
  }
});

test("persistDrivenSegments emits mission delta callback on mission success", async () => {
  const coverage = new TurnByTurnCoverage();
  coverage.selectedAreaId = "area-3";
  coverage.setMissionContext("mission-3");
  coverage.pendingSegmentUpdates.add("seg-9");

  let missionDelta = null;
  coverage.setCallbacks({
    onMissionDelta: (delta) => {
      missionDelta = delta;
    },
  });

  const originalMissionPersist = TurnByTurnAPI.persistDrivenSegmentsForMission;
  const originalBasePersist = TurnByTurnAPI.persistDrivenSegments;

  TurnByTurnAPI.persistDrivenSegmentsForMission = async () => ({
    mission_delta: {
      mission_id: "mission-3",
      added_segments: 1,
    },
  });
  TurnByTurnAPI.persistDrivenSegments = async () => {
    throw new Error("base persist should not be called");
  };

  try {
    await coverage.persistDrivenSegments();
    assert.deepEqual(missionDelta, { mission_id: "mission-3", added_segments: 1 });
    assert.equal(coverage.pendingSegmentUpdates.size, 0);
    assert.equal(coverage.activeMissionId, "mission-3");
  } finally {
    TurnByTurnAPI.persistDrivenSegmentsForMission = originalMissionPersist;
    TurnByTurnAPI.persistDrivenSegments = originalBasePersist;
  }
});
