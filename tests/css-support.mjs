import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { checkCss, findUnscopedTokens, FILES, TOKENS } from "../scripts/check-css.mjs";

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

test("design tokens may only be declared on the VAM roots", () => {
  assert.equal(findUnscopedTokens(".vam-node { --vam-space-1: 4px; }").length, 1);
  assert.equal(findUnscopedTokens(":root { --vam-surface: red; }").length, 1);
  assert.equal(findUnscopedTokens(".vam-view, .vam-node { --vam-text: red; }").length, 1);
  assert.deepEqual(findUnscopedTokens(".vam-view, .vam-stage, .vam-tokens { --vam-space-1: 4px; --vam-card-bg: red; }\n.theme-dark .vam-view { --vam-surface: #000; }"), []);
  assert.deepEqual(findUnscopedTokens(".vam-node { --vam-card-bg: red; --vam-kind-x: blue; }"), []);
});

test("design tokens keep the V3.3 stage A values (02-stage-a-mockup)", () => {
  const css = readFileSync(resolve(root, "styles.css"), "utf8");
  const values = {};
  postcss.parse(css).walkRules((rule) => {
    if (rule.selector !== ".vam-view, .vam-stage, .vam-tokens") return;
    rule.walkDecls((decl) => { values[decl.prop] = decl.value; });
  });
  assert.deepEqual(values, {
    "--vam-space-1": "var(--size-4-1, 4px)", "--vam-space-2": "var(--size-4-2, 8px)", "--vam-space-3": "var(--size-4-3, 12px)", "--vam-space-4": "var(--size-4-4, 16px)", "--vam-space-5": "var(--size-4-6, 24px)",
    "--vam-card-padding": "var(--vam-space-3)", "--vam-radius-card": "8px", "--vam-radius-control": "6px",
    "--vam-surface": "var(--background-primary)", "--vam-text": "var(--text-normal)", "--vam-muted": "var(--text-muted)", "--vam-border": "var(--background-modifier-border)",
    "--vam-accent": "var(--interactive-accent)", "--vam-focus": "var(--interactive-accent)", "--vam-selected": "var(--interactive-accent)",
    "--vam-error": "var(--text-error)", "--vam-warning": "var(--color-orange)",
    "--vam-card-title-size": "var(--font-ui-medium, 15px)", "--vam-card-summary-size": "var(--font-ui-small, 13px)",
  });
});

test("shipped styles.css declares every token on the VAM roots", () => {
  const css = readFileSync(resolve(root, "styles.css"), "utf8");
  assert.deepEqual(findUnscopedTokens(css, "styles.css"), []);
  for (const token of TOKENS) assert.ok(new RegExp(`${token}:`).test(css), `${token} is not declared`);
});

const MIGRATED = [".vam-node", ".vam-node.is-clipped > .vam-card-fade", ".vam-node-header", ".vam-node-header button", ".vam-node > .vam-node-tools", ".vam-node-tools button", ".vam-node-tools > .vam-card-tool-more", ".vam-card-title", ".vam-card-summary"];
test("migrated card selectors carry no px literal in spacing, radius or font size", () => {
  const css = readFileSync(resolve(root, "styles.css"), "utf8");
  const seen = new Set();
  postcss.parse(css).walkRules((rule) => {
    if (!rule.selectors.some((s) => MIGRATED.includes(s.trim()))) return;
    for (const s of rule.selectors) seen.add(s.trim());
    rule.walkDecls(/^(padding|margin|gap|border-radius|font-size)(-|$)/, (decl) => {
      const bare = decl.value.replace(/var\(--[a-z0-9-]+,[^)]*\)/g, "").replace(/- 1px\)/g, ")"); // the fade keeps its 1px inset from the card border
      assert.doesNotMatch(bare, /\d+(\.\d+)?px/, `${rule.selector} { ${decl.prop}: ${decl.value} }`);
    });
  });
  for (const selector of MIGRATED) assert.ok(seen.has(selector), `${selector} not found`);
});

test("card title keeps wrapping anywhere and the summary keeps its 3-line clamp", () => {
  const css = readFileSync(resolve(root, "styles.css"), "utf8");
  assert.match(css, /^\.vam-card-title \{[^}]*overflow-wrap: anywhere/m);
  assert.match(css, /^\.vam-card-summary \{[^}]*-webkit-line-clamp: 3/m);
});

test('A4: resize handles and the AI lock button show on selection or focus, never on hover (hover only changes the border)', () => {
  const css = readFileSync(resolve(root, 'styles.css'), 'utf8');
  const rules = css.split('\n').filter(line => /vam-card-resize|is-hover-only/.test(line) && /opacity: 1|opacity: 0\.6/.test(line));
  assert.ok(rules.length >= 4, 'the visible-state rules exist');
  for (const line of rules) assert.ok(!/\.vam-node:hover/.test(line), `not keyed on hover: ${line.slice(0, 80)}`);
  assert.match(css, /\.vam-node\.is-selected > \.vam-card-resize\b/);
  assert.match(css, /\.vam-node\.is-selected \.vam-card-ai-lock\.is-hover-only/);
});
