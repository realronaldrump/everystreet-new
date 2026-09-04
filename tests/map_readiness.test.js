import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { BaseFeatureMap } from "../static/js/modules/utils/base-map.js";

test("a previously loaded map can become ready again without another load event", async () => {
  const events = new Map();
  let ready = false;
  const map = {
    on(name, fn) {
      events.set(name, fn);
    },
    off(name) {
      events.delete(name);
    },
    isStyleLoaded: () => ready,
  };
  const wrapper = new BaseFeatureMap("test-map");
  wrapper.map = map;
  let restored = false;
  let calls = 0;
  void wrapper
    .bindMapLoad(() => {
      calls++;
    })
    .then(() => {
      restored = true;
    });
  ready = true;
  events.get("idle")?.();
  await setImmediate();
  assert.equal(restored, true);
  assert.equal(calls, 1);
  assert.equal(events.size, 0);
});
