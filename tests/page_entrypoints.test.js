import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const templatesDir = path.join(root, "templates");
const pagesDir = path.join(root, "static", "js", "pages");
const jsRoot = path.join(root, "static", "js");
const routeLoaderPath = path.join(jsRoot, "modules", "core", "route-loader.js");

function listHtmlFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  entries.forEach((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listHtmlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      files.push(fullPath);
    }
  });
  return files;
}

test("page entrypoints are wired via route-loader", () => {
  const htmlFiles = listHtmlFiles(templatesDir);
  const pageRegex = /js\/pages\/([a-z0-9-]+)\.js/g;
  const pageScripts = new Set();

  htmlFiles.forEach((filePath) => {
    const content = fs.readFileSync(filePath, "utf8");
    let match = null;
    while ((match = pageRegex.exec(content))) {
      pageScripts.add(match[1]);
    }
  });

  assert.equal(
    pageScripts.size,
    0,
    `Templates should not reference js/pages entrypoints (route-loader owns them): ${[
      ...pageScripts,
    ].join(", ")}`
  );

  assert.ok(fs.existsSync(routeLoaderPath), "Missing route-loader module");
  const routeLoaderContent = fs.readFileSync(routeLoaderPath, "utf8");
  const routeRegex = /\.\.\/\.\.\/pages\/([a-z0-9-]+)\.js/g;
  const routedPages = new Set();

  let match = null;
  while ((match = routeRegex.exec(routeLoaderContent))) {
    routedPages.add(match[1]);
  }

  assert.ok(routedPages.size > 0, "No js/pages entrypoints found in route-loader.js");

  routedPages.forEach((name) => {
    const entryPath = path.join(pagesDir, `${name}.js`);
    assert.ok(
      fs.existsSync(entryPath),
      `Missing entrypoint file for routed page: ${name}.js`
    );
    const entryContent = fs.readFileSync(entryPath, "utf8");
    assert.match(entryContent, /onPageLoad\s*\(/, `${name}.js missing onPageLoad`);
    assert.match(
      entryContent,
      /modules\/features\//,
      `${name}.js missing features import`
    );
  });

  const pageFiles = fs
    .readdirSync(pagesDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => name.replace(/\.js$/, ""));
  const extraPages = pageFiles.filter((name) => !routedPages.has(name));
  assert.equal(
    extraPages.length,
    0,
    `Entrypoints not referenced by route-loader: ${extraPages.join(", ")}`
  );

  const rootJsFiles = fs
    .readdirSync(jsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => entry.name)
    .filter((name) => name !== "app.js");
  assert.equal(
    rootJsFiles.length,
    0,
    `Unexpected root-level scripts in static/js: ${rootJsFiles.join(", ")}`
  );
});
