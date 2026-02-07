import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const navigationPath = path.join(
  root,
  "static",
  "js",
  "modules",
  "core",
  "navigation.js"
);
const domUtilsPath = path.join(root, "static", "js", "modules", "utils", "dom.js");

test("Swup visit.to.url is treated as a string (no .pathname/.href access)", () => {
  const navigation = fs.readFileSync(navigationPath, "utf8");

  // Swup v4 visit.to.url/visit.from.url are strings (pathname + search), not URL objects.
  assert.match(
    navigation,
    /pathnameFromSwupUrl\(/,
    "navigation.js should parse Swup url strings via pathnameFromSwupUrl()"
  );

  assert.doesNotMatch(
    navigation,
    /visit\?\.to\?\.url\?\.pathname/,
    "navigation.js must not access visit?.to?.url?.pathname (visit.to.url is a string)"
  );

  assert.doesNotMatch(
    navigation,
    /visit\?\.to\?\.url\?\.href/,
    "navigation.js must not access visit?.to?.url?.href (visit.to.url is a string)"
  );
});

test("Swup visit.from.url is treated as a string (no .pathname access)", () => {
  const domUtils = fs.readFileSync(domUtilsPath, "utf8");

  assert.match(
    domUtils,
    /pathnameFromSwupUrl\(visit\?\.from\?\.url\)/,
    "dom.js should parse Swup from.url strings via pathnameFromSwupUrl(visit?.from?.url)"
  );

  assert.doesNotMatch(
    domUtils,
    /visit\?\.from\?\.url\?\.pathname/,
    "dom.js must not access visit?.from?.url?.pathname (visit.from.url is a string)"
  );
});
