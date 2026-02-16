import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const templatePath = path.join(root, "templates", "insights.html");

function assertId(source, id) {
  const pattern = new RegExp(`id=["']${id}["']`);
  assert.match(source, pattern, `insights.html missing required id: ${id}`);
}

test("Insights template includes required narrative section IDs used by insights modules", () => {
  const source = fs.readFileSync(templatePath, "utf8");

  [
    "rhythm-storyrail",
    "rhythm-period-toggle",
    "insight-scenes",
    "places-orbit",
    "places-detail-panel",
    "records-timeline",
    "trendsChart",
    "timeDistChart",
  ].forEach((id) => assertId(source, id));
});
