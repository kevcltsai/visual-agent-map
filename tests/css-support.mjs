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

test("hover deepens an unselected card's border (V3.3 P1.2: hover changes only the border colour, visibly)", () => {
  const css = readFileSync(resolve(root, "styles.css"), "utf8");
  const mix = (selector) => {
    let value;
    postcss.parse(css).walkRules((rule) => { if (rule.selector === selector) rule.walkDecls("border-color", (d) => { value = d.value; }); });
    assert.ok(value, `${selector} has a border-color`);
    const m = /color-mix\(in srgb, var\(--(?:text-muted|vam-muted)\) (\d+)%, var\(--background-modifier-border-hover\)\)/.exec(value);
    assert.ok(m, `${selector}: ${value}`);
    return Number(m[1]);
  };
  for (const [base, hover] of [
    [":where([data-node-id]).vam-node:where(:not([data-aim-kind]))", ":where([data-node-id]).vam-node:where(:not([data-aim-kind], .is-selected)):hover"],
    [":where([data-node-id]).vam-node.vam-aim-hidden:where([data-aim-kind])", ":where([data-node-id]).vam-node.vam-aim-hidden:where([data-aim-kind]:not(.is-selected)):hover"],
  ]) assert.ok(mix(hover) > mix(base), `${hover} must mix more muted than ${base}`);
});

// The :where() rules above keep a low specificity so the typed cards' own frames win, which also lets `.vam-node:hover` and the
// idea card's dashed frame (`.vam-node:not([data-aim-kind])[data-status="idea"]`, 0,3,0) cover the ordinary card's hover. This
// rule (0,3,0, placed after the idea frame and before the typed-card frames) is the ordinary, unselected, not-busy card's hover.
const ORDINARY_HOVER = '.vam-node:not([data-aim-kind], .is-selected, [data-status="queued"], [data-status="running"], [data-status="error"]):hover';
test("an ordinary unselected card's hover outranks the idea card frame and .vam-node:hover (V3.3 P1.2)", () => {
  const css = readFileSync(resolve(root, "styles.css"), "utf8");
  let value;
  postcss.parse(css).walkRules((rule) => { if (rule.selector === ORDINARY_HOVER) rule.walkDecls("border-color", (d) => { value = d.value; }); });
  assert.ok(value, "the ordinary card hover rule exists");
  assert.match(value, /color-mix\(in srgb, var\(--vam-muted\) 75%, var\(--background-modifier-border-hover\)\)/);
  const lines = css.split("\n"), at = (start) => lines.findIndex((line) => line.startsWith(start));
  const hover = at(ORDINARY_HOVER), idea = at('.vam-node:not([data-aim-kind])[data-status="idea"] {'), typed = at('[data-topic-kind="action"].vam-node:not([data-aim-kind]) {');
  assert.ok(idea >= 0 && typed >= 0 && idea < hover && hover < typed, "after the idea frame (same specificity, later wins), before the typed frames (they keep theirs)");
});

test('A5: a locked card is not dimmed; it says "locked" in words instead (V3.3 P1.2)', () => {
  const css = readFileSync(resolve(root, 'styles.css'), 'utf8');
  for (const line of css.split('\n').filter(l => /data-ai-locked/.test(l))) assert.ok(!/opacity/.test(line), `no dimming: ${line.slice(0, 80)}`);
  assert.match(css, /\.vam-card-ai-lock-label\b/);
});

test("B28: the card edge entries keep a 22px screen height when zoomed out (same counter-scale as the card toolbar, origin on the anchored corner)", () => {
  const css = readFileSync(resolve(root, "styles.css"), "utf8");
  const COUNTER = "max(1, calc(1 / var(--vam-zoom, 1)))";
  const rules = {};
  postcss.parse(css).walkRules((rule) => {
    rule.walkDecls("scale", (d) => { rules[rule.selector] = { scale: d.value, origin: rule.nodes.find((n) => n.prop === "transform-origin")?.value }; });
  });
  const tools = rules[".vam-node > .vam-node-tools"];
  assert.equal(tools?.scale, COUNTER, "the toolbar counter-scale this mirrors");
  const origins = { right: "0 0", down: "0 0", left: "100% 0", up: "0 100%" };
  for (const [side, origin] of Object.entries(origins)) {
    const entry = rules[`.vam-node > .vam-card-edge.is-edge-${side}`];
    assert.equal(entry?.scale, COUNTER, `${side}: counter-scale`);
    assert.equal(entry?.origin, origin, `${side}: origin on the corner that touches the card`);
  }
});

test("book styles: body pictures are not stretched, and the [!vam-book] hide rule never reaches the caption paragraph (V3.3 G01)", () => {
  const css = readFileSync(resolve(root, "styles.css"), "utf8");
  let hideRules = 0;
  postcss.parse(css).walkRules((rule) => {
    if (!/vam-picture-paragraph|vam-book/.test(rule.selector)) return;
    rule.walkDecls((decl) => {
      if (decl.prop === "object-fit") assert.ok(!/fill|cover/.test(decl.value), `${rule.selector}: object-fit ${decl.value}`);
      assert.notEqual(decl.prop, "aspect-ratio", `${rule.selector} fixes an aspect ratio`);
    });
    if (/\[data-callout="vam-book"\]/.test(rule.selector) && rule.nodes.some((n) => n.prop === "display" && n.value === "none")) {
      hideRules++;
      assert.ok(!rule.selector.includes("vam-picture-paragraph"), rule.selector);
    }
  });
  assert.ok(hideRules > 0, "the [!vam-book] hide rule is still there");
});

// B08: while notes load the toolbar (notes + the more button) stays reachable; only the resize handles are hidden.
test("is-notes-loading rules do not hide the card toolbar", () => {
  const css = readFileSync(resolve(root, "styles.css"), "utf8");
  const hiding = [];
  postcss.parse(css).walkRules((rule) => {
    if (!rule.selector.includes("is-notes-loading")) return;
    if (!rule.some((d) => d.prop === "display" && d.value === "none")) return;
    for (const sel of rule.selectors) if (/vam-node-tools|vam-card-tool/.test(sel)) hiding.push(sel);
  });
  assert.deepEqual(hiding, []);
});

// D1-x10: the Living Node editor's Save button was white on the stock accent: 3.43:1 (light), 4.26:1 (dark).
const hslToRgb = (h, s, l) => { s /= 100; l /= 100; const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l); return [0, 8, 4].map((n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))); };
const luminance = (rgb) => { const [r, g, b] = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

test("Living Node editor Save button: white text on the accent mixed with black is at least 4.5:1 in both themes", () => {
  const css = readFileSync(resolve(root, "styles.css"), "utf8");
  for (const selector of [".vam-living-editor .vam-ai-card-pop-foot button.mod-cta", ".vam-living-editor .vam-ai-card-pop-foot button.mod-cta:hover"]) {
    const rule = css.split("\n").find((line) => line.startsWith(selector + " {"));
    assert.ok(rule, `${selector} is styled`);
    const mix = /background:\s*color-mix\(in srgb,\s*var\(--interactive-accent(?:-hover)?(?:,\s*var\(--interactive-accent\))?\)\s*(\d+)%,\s*black\)/.exec(rule);
    assert.ok(mix, `${selector} darkens the accent with black: ${rule}`);
    assert.match(rule, /color:\s*var\(--text-on-accent\)/);
    const keep = Number(mix[1]) / 100;
    // Obsidian's stock accent as measured on the demo vault: hsl(258 88% 66%) dark (4.26:1 with white), hsl(258 88% 70.5%) light (3.43:1); hover is lighter still (+4%).
    for (const [theme, lightness] of [["dark", 66], ["light", 70.5], ["dark hover", 70], ["light hover", 74.5]]) {
      const accent = hslToRgb(258, 88, lightness);
      const mixed = accent.map((c) => c * keep);
      assert.ok(ratio(1, luminance(mixed)) >= 4.5, `${selector} ${theme}: ${ratio(1, luminance(mixed)).toFixed(2)}`);
    }
  }
});
