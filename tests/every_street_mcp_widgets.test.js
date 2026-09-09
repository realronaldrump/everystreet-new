import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const readWidget = (name) =>
  readFile(new URL(`../every_street_mcp/${name}`, import.meta.url), "utf8");

test("action widget keeps commit behind an explicit click", async () => {
  const source = await readWidget("action_review.html");
  assert.match(source, /Confirm action/);
  assert.match(source, /addEventListener\('click'/);
  assert.match(source, /commit_every_street_action/);
  assert.match(source, /action_token/);
  assert.doesNotMatch(source, /setTimeout\([^)]*commit_every_street_action/);
});

test("live widget stops refreshing when tracking is disabled", async () => {
  const source = await readWidget("live_drive.html");
  const script = source.match(/<script>([\s\S]*?)<\/script>/)[1];
  for (const initiallyDisabled of [true, false]) {
    const elements = new Map();
    let refresh;
    let stopped = false;
    const context = {
      document: {
        getElementById(id) {
          if (!elements.has(id)) elements.set(id, {});
          return elements.get(id);
        },
      },
      window: { openai: {
        toolOutput: { enabled: !initiallyDisabled },
        async callTool(name) {
          assert.equal(name, "get_live_drive");
          return { structuredContent: { enabled: false } };
        },
      } },
      setInterval(callback, interval) {
        assert.equal(interval, 10000);
        refresh = callback;
        return 1;
      },
      clearInterval(id) { assert.equal(id, 1); stopped = true; },
    };
    vm.runInNewContext(script, context);
    if (!initiallyDisabled) {
      assert.equal(stopped, false);
      await refresh();
    }
    assert.equal(stopped, true);
    assert.equal(elements.get("state").textContent, "Disabled");
    assert.equal(elements.get("metrics").innerHTML, "");
  }
});

test("explorer includes responsive map and required attribution", async () => {
  const source = await readWidget("explorer.html");
  assert.match(source, /mapboxgl\.Map/);
  assert.match(source, /attributionControl:true/);
  assert.match(source, /@media\(max-width:700px\)/);
  assert.match(source, /requestDisplayMode/);
});
