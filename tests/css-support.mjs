import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkCss, FILES } from "../scripts/check-css.mjs";

const root = resolve(import.meta.dirname, "..");
const fixture = (name) => readFileSync(resolve(root, "tests/fixtures/css-support", name), "utf8");

// Historical Obsidian scan warnings ("only partially supported by Obsidian 1.11.4"), taken verbatim from the release tags.
test("0.22.0 text-decoration-style (scan: text-decoration, styles.css:1069) is flagged", async () => {
  const found = await checkCss(fixture("0.22.0-text-decoration-style.css"), "fixture.css");
  assert.ok(found.some((f) => f.message.includes('"text-decoration"')), JSON.stringify(found));
});

test("0.23.0 clip-path (scan: css-clip-path, styles.css:146) is flagged", async () => {
  const found = await checkCss(fixture("0.23.0-clip-path.css"), "fixture.css");
  assert.ok(found.some((f) => f.message.includes('"css-clip-path"')), JSON.stringify(found));
});

test("!important is still flagged", async () => {
  const found = await checkCss("a { color: red !important; }\n/* b { color: red !important } */", "fixture.css");
  assert.deepEqual(found.map((f) => f.line), [1]);
});

// 0.35.1 scan CSS LINT warnings: 'Unexpected property "all"' (styles.css:83) and 'Avoid :has' (styles.css:505, 506, 1036, 1037, 1039, 1045, 1047, 2311, 2380).
test("0.35.1 :has selectors and the all property are flagged", async () => {
  const css = '.a { all: unset; }\n.b:has(> img) { color: red; }\n.c:not(:has(.d))::before { content: ""; }\n.e { color: red; }';
  assert.deepEqual((await checkCss(css, "fixture.css")).map((f) => f.line), [1, 2, 3]);
});

test("shipped stylesheets pass", async () => {
  for (const file of FILES) assert.deepEqual(await checkCss(readFileSync(resolve(root, file), "utf8"), file), [], file);
});
