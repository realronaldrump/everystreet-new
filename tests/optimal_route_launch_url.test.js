import assert from "node:assert/strict";
import test from "node:test";

import { buildTurnByTurnLaunchUrl } from "../static/js/modules/optimal-route/launch-url.js";

test("buildTurnByTurnLaunchUrl uses plain area link when no mission", () => {
  assert.equal(buildTurnByTurnLaunchUrl("area-1", null), "/turn-by-turn?areaId=area-1");
});

test("buildTurnByTurnLaunchUrl resumes only active/paused missions for same area", () => {
  assert.equal(
    buildTurnByTurnLaunchUrl("area-1", {
      id: "m-active",
      area_id: "area-1",
      status: "active",
    }),
    "/turn-by-turn?areaId=area-1&missionId=m-active&autoStart=true"
  );

  assert.equal(
    buildTurnByTurnLaunchUrl("area-1", {
      id: "m-paused",
      area_id: "area-1",
      status: "paused",
    }),
    "/turn-by-turn?areaId=area-1&missionId=m-paused&autoStart=true"
  );

  assert.equal(
    buildTurnByTurnLaunchUrl("area-1", {
      id: "m-completed",
      area_id: "area-1",
      status: "completed",
    }),
    "/turn-by-turn?areaId=area-1"
  );

  assert.equal(
    buildTurnByTurnLaunchUrl("area-1", {
      id: "m-other-area",
      area_id: "area-2",
      status: "active",
    }),
    "/turn-by-turn?areaId=area-1"
  );
});
