/**
 * A stub document for code that reads design tokens with getComputedStyle.
 * Values come from the night edition (the first :root block) of
 * static/css/core/variables.css, with var() references substituted the way
 * a browser computes custom properties.
 */
import { readFileSync } from "node:fs";

const css = readFileSync(
  new URL("../../static/css/core/variables.css", import.meta.url),
  "utf8"
);

function rootTokens() {
  const start = css.indexOf(":root {");
  let depth = 0;
  let end = start;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }
  const body = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = {};
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[match[1]] = match[2].replace(/\s+/g, " ").trim();
  }
  return tokens;
}

function resolve(tokens, value, depth = 0) {
  if (depth > 10) return value;
  return value.replace(/var\((--[\w-]+)(?:,\s*([^)]*))?\)/g, (_, name, fallback) =>
    resolve(tokens, tokens[name] ?? fallback ?? "", depth + 1)
  );
}

export const NIGHT_TOKENS = rootTokens();

/** The night-edition value of a token, as getComputedStyle reports it. */
export function tokenValue(name) {
  return resolve(NIGHT_TOKENS, NIGHT_TOKENS[name] ?? "");
}

/** Install the stub; returns a function that restores the globals. */
export function installThemeTokens(overrides = {}) {
  const saved = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
  };
  globalThis.document ??= { documentElement: {} };
  globalThis.getComputedStyle = () => ({
    getPropertyValue: (name) => overrides[name] ?? tokenValue(name),
  });
  return () => {
    globalThis.document = saved.document;
    globalThis.getComputedStyle = saved.getComputedStyle;
  };
}
