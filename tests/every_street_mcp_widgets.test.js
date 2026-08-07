import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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

test("live widget labels Redis state as ephemeral and polls safely", async () => {
  const source = await readWidget("live_drive.html");
  assert.match(source, /Ephemeral Redis state only/);
  assert.match(source, /get_live_drive/);
  assert.match(source, /10000/);
});

test("explorer includes responsive map and required attribution", async () => {
  const source = await readWidget("explorer.html");
  assert.match(source, /mapboxgl\.Map/);
  assert.match(source, /attributionControl:true/);
  assert.match(source, /@media\(max-width:700px\)/);
  assert.match(source, /requestDisplayMode/);
});
