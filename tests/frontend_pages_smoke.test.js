import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  assertHasClass,
  assertHasId,
  listFilesRecursive,
  readRepoFile,
  readTemplate,
  repoPath,
} from "./helpers/fs-smoke.js";

test("insights and routes templates keep the containers their pages rely on", () => {
  const insightsSource = readTemplate("insights.html");
  const routesSource = readTemplate("routes.html");

  [
    "insight-scenes",
    "places-orbit",
    "movement-map",
    "movement-top-streets",
    "movement-top-segments",
    "records-timeline",
    "trendsChart",
    "timeDistChart",
  ].forEach((id) => assertHasId(insightsSource, id, "insights.html"));

  [
    "hero-stat-routes",
    "hero-stat-trips",
    "hero-stat-miles",
    "hero-stat-freq",
    "route-modal-show-all-trips",
    "route-places-list",
    "routes-explorer-start-place",
    "routes-explorer-end-place",
    "routes-explorer-run-btn",
  ].forEach((id) => assertHasId(routesSource, id, "routes.html"));

  ["routes-modal-tab", "routes-modal-tab-content"].forEach((className) =>
    assertHasClass(routesSource, className, "routes.html")
  );
});

test("route-loader remains the only owner of page entrypoints", () => {
  const templatesDir = repoPath("templates");
  const pagesDir = repoPath("static", "js", "pages");
  const jsRoot = repoPath("static", "js");
  const routeLoaderSource = readRepoFile(
    "static",
    "js",
    "modules",
    "core",
    "route-loader.js"
  );
  const htmlFiles = listFilesRecursive(templatesDir).filter((filePath) =>
    filePath.endsWith(".html")
  );
  const pageScripts = new Set();
  const pageRegex = /js\/pages\/([a-z0-9-]+)\.js/g;

  htmlFiles.forEach((filePath) => {
    const content = readRepoFile(path.relative(repoPath(), filePath));
    pageRegex.lastIndex = 0;
    let match = pageRegex.exec(content);
    while (match) {
      pageScripts.add(match[1]);
      match = pageRegex.exec(content);
    }
  });

  assert.equal(
    pageScripts.size,
    0,
    `Templates should not reference js/pages entrypoints directly: ${[
      ...pageScripts,
    ].join(", ")}`
  );

  const routedPages = new Set();
  const routeRegex = /\.\.\/\.\.\/pages\/([a-z0-9-]+)\.js/g;
  let match = routeRegex.exec(routeLoaderSource);
  while (match) {
    routedPages.add(match[1]);
    match = routeRegex.exec(routeLoaderSource);
  }

  assert.ok(routedPages.size > 0, "route-loader.js should declare page entrypoints");

  routedPages.forEach((name) => {
    const entrySource = readRepoFile("static", "js", "pages", `${name}.js`);
    assert.match(
      entrySource,
      /modules\/core\/page-bootstrap\.js/,
      `${name}.js should import page-bootstrap`
    );
    assert.match(
      entrySource,
      /bootstrapPage\s*\(/,
      `${name}.js should call bootstrapPage`
    );
    assert.match(
      entrySource,
      /modules\/features\//,
      `${name}.js should import its feature module`
    );
  });

  const pageFiles = listFilesRecursive(pagesDir)
    .map((filePath) => path.basename(filePath))
    .filter((name) => name.endsWith(".js"))
    .map((name) => name.replace(/\.js$/, ""));
  const extraPages = pageFiles.filter((name) => !routedPages.has(name));
  assert.equal(
    extraPages.length,
    0,
    `Entrypoints not referenced by route-loader: ${extraPages.join(", ")}`
  );

  const rootJsFiles = listFilesRecursive(jsRoot)
    .filter((filePath) => path.dirname(filePath) === jsRoot)
    .map((filePath) => path.basename(filePath))
    .filter((name) => name.endsWith(".js") && name !== "app.js");
  assert.equal(
    rootJsFiles.length,
    0,
    `Unexpected root-level scripts in static/js: ${rootJsFiles.join(", ")}`
  );
});
