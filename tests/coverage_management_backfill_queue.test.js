import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL(
    "../static/js/modules/features/coverage-management/index.js",
    import.meta.url
  ),
  "utf8"
);

test("coverage management queues long backfills in the worker", () => {
  assert.match(
    source,
    /\/areas\/\$\{areaId\}\/backfill\?background=true&trip_mode=/
  );
  assert.match(source, /jobType: "area_backfill"/);
  assert.match(source, /Recalculating street coverage in the background/);
});
