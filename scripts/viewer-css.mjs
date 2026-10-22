// Picks the rules the share viewer needs out of styles.css, verbatim, so the cards, canvas and side panel of a shared
// map come from the same rules as the plugin. Used by build-viewer.mjs and by tests/suites/sharing-viewer.cjs.

/** The first class of a selector must start with one of these (a `.theme-dark ` prefix is allowed). */
export const ALLOW_PREFIXES = [
  "vam-node",
  "vam-edge",
  "vam-relevance-tag",
  "vam-relevance-icon",
  "vam-inspector",
  "vam-card-",
  "vam-status",
  "vam-toolbar",
  "vam-map-tools",
  "vam-map-switcher",
  "vam-zoom",
  "vam-layout-button",
  "vam-canvas-",
  "vam-workspace",
  "vam-viewport",
  "vam-stage",
  "vam-sample-summary",
  "vam-sample-detail"
];
const ALLOW = new RegExp(`^(?:\\.theme-dark\\s+)?\\.(?:${ALLOW_PREFIXES.join("|")})`);
/**
 * A rule is left out when it styles something the read-only viewer does not have, or names a field the leak scan
 * forbids (the goal button, level and context inputs). `:not([data-aim-kind])` is how plugin rules say "ordinary topic".
 */
const DENY =
  /relevance-(?:goal|level|context|tier|reason|manual)|source-notes|agent-map-references|content-language|(?:^|[^a-z])aim(?:[^a-z]|$)|marquee|add-child|research|structure|conclusion|new-map|topic-more|ai-explore|is-selecting|sample-tour|sample-start|empty|proposal|inspector-topic|inspector-section/;
const ORDINARY_TOPIC = ":not([data-aim-kind])";

/** Splits CSS into top-level chunks `{ prelude, body, text }`; comments are dropped, strings respected. */
export function parseCss(css) {
  const chunks = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    while (i < n && /\s/.test(css[i])) i++;
    if (css.startsWith("/*", i)) {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (i >= n) break;
    const start = i;
    let depth = 0;
    let bodyStart = -1;
    let quote = "";
    for (; i < n; i++) {
      const c = css[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = "";
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (css.startsWith("/*", i)) {
        const end = css.indexOf("*/", i + 2);
        i = end < 0 ? n : end + 1;
      } else if (c === "{") {
        if (depth === 0) bodyStart = i;
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      } else if (c === ";" && depth === 0) {
        i++;
        break;
      }
    }
    if (bodyStart < 0) continue;
    const text = css.slice(start, i).trim();
    chunks.push({
      prelude: css.slice(start, bodyStart).trim(),
      body: css.slice(bodyStart + 1, css.lastIndexOf("}", i - 1)),
      text
    });
  }
  return chunks;
}

function splitSelectors(prelude) {
  const out = [];
  let depth = 0;
  let current = "";
  for (const c of prelude) {
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth--;
    if (c === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else current += c;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export function wantsRule(rule) {
  const selectors = splitSelectors(rule.prelude);
  if (!selectors.some(selector => ALLOW.test(selector))) return false;
  return !DENY.test(rule.text.split(ORDINARY_TOPIC).join(""));
}

/** Style rules (verbatim), @media wrappers around the style rules they keep, and the @keyframes those rules use. */
export function extractViewerRules(stylesCss) {
  const kept = [];
  const keyframes = new Map();
  for (const chunk of parseCss(stylesCss)) {
    if (chunk.prelude.startsWith("@keyframes")) keyframes.set(chunk.prelude.replace("@keyframes", "").trim(), chunk.text);
    else if (chunk.prelude.startsWith("@media")) {
      if (/prefers-reduced-motion/.test(chunk.prelude)) continue;
      const inner = parseCss(chunk.body).filter(wantsRule);
      if (inner.length)
        kept.push({
          text: `${chunk.prelude} {\n${inner.map(rule => `  ${rule.text}`).join("\n")}\n}`,
          rules: inner.map(rule => rule.text)
        });
    } else if (!chunk.prelude.startsWith("@") && wantsRule(chunk)) kept.push({ text: chunk.text, rules: [chunk.text] });
  }
  const used = kept.map(item => item.text).join("\n");
  for (const [name, text] of keyframes)
    if (new RegExp(`animation(?:-name)?:[^;}]*\\b${name}\\b`).test(used)) kept.push({ text, rules: [text] });
  return kept;
}

/** Every top-level rule of styles.css, plus the rules inside its @media and @container blocks, as text. */
export function allRuleTexts(stylesCss) {
  const texts = new Set();
  for (const chunk of parseCss(stylesCss)) {
    texts.add(chunk.text);
    if (chunk.prelude.startsWith("@media") || chunk.prelude.startsWith("@container"))
      for (const inner of parseCss(chunk.body)) texts.add(inner.text);
  }
  return texts;
}

/** The viewer stylesheet: tokens and base, the extracted rules, then the viewer-only rules (at the marker). */
export function composeViewerCss(viewerCss, stylesCss) {
  const marker = "/* @@vam-extracted-rules@@ */";
  if (!viewerCss.includes(marker)) throw new Error("viewer.css is missing the extracted-rules marker.");
  const extracted = extractViewerRules(stylesCss)
    .map(item => item.text)
    .join("\n");
  return viewerCss.replace(marker, () => `/* From styles.css, unchanged. */\n${extracted}`);
}
