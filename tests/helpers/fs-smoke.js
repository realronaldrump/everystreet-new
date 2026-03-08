import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(__dirname, "..", "..");

export function repoPath(...parts) {
  return path.join(repoRoot, ...parts);
}

export function readRepoFile(...parts) {
  return fs.readFileSync(repoPath(...parts), "utf8");
}

export function readTemplate(name) {
  return readRepoFile("templates", name);
}

export function readStaticJs(...parts) {
  return readRepoFile("static", "js", ...parts);
}

export function assertHasId(source, id, label = "template") {
  const pattern = new RegExp(`id=["']${id}["']`);
  assert.match(source, pattern, `${label} missing required id: ${id}`);
}

export function assertHasClass(source, className, label = "template") {
  const pattern = new RegExp(`class=["'][^"']*\\b${className}\\b[^"']*["']`);
  assert.match(source, pattern, `${label} missing required class: ${className}`);
}

export function listFilesRecursive(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  entries.forEach((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
      return;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  });
  return files.sort();
}
