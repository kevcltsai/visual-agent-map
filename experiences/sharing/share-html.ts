import { serializeShareJson, type SharePayload } from "./share-format";
import type { ShareViewerUi } from "./share-viewer-ui";
import { shareViewerUiExtras } from "./share-viewer-text";
import { SHARE_VIEWER_CSS, SHARE_VIEWER_JS } from "./viewer-bundle.generated";
import AGPL_LICENSE_TEXT from "../../LICENSES/AGPL-3.0-only.txt";
import APACHE_LICENSE_TEXT from "../../LICENSES/Apache-2.0.txt";
import { DISTRIBUTION_IS_RELEASE, DISTRIBUTION_VERSION } from "../../core/distribution";

/**
 * Meta policy of every shared file: nothing is fetched except pictures (data: images, and the web pictures a note links),
 * frames only of YouTube's no-cookie player (after a click), no forms or connections, and no `eval`. The inline script and style are the file's own.
 */
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src https://www.youtube-nocookie.com https://www.facebook.com https://www.instagram.com";
const CORRESPONDING_SOURCE_URL = `https://github.com/kevcltsai/visual-agent-map/releases/download/${DISTRIBUTION_VERSION}/visual-agent-map-${DISTRIBUTION_VERSION}-source.tar.gz`;
const SOURCE_LABEL = DISTRIBUTION_IS_RELEASE
  ? `Corresponding Source for release ${DISTRIBUTION_VERSION}`
  : `UNRELEASED CANDIDATE ${DISTRIBUTION_VERSION}; the corresponding source archive will be published with this release`;

const escapeText = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** JSON for a `<script type="application/json">` block: every `<` escaped (see serializeShareJson). */
const jsonForScript = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

/**
 * A file with translations carries the interface text of each of its languages inside the same `vam-ui` block (a file
 * without them is unchanged, byte for byte).
 */
function uiBlockFor(ui: ShareViewerUi, languages: readonly string[] | undefined): Record<string, unknown> {
  return languages && languages.length >= 2 ? { ...ui, ...shareViewerUiExtras(languages) } : { ...ui };
}

function buildHtml(
  title: string,
  ui: ShareViewerUi,
  mapJson: string,
  languages?: readonly string[],
  contentLanguage?: string
): string {
  return [
    "<!doctype html>",
    // The page language is the language of the content (the viewer updates it when the reader switches).
    `<html lang="${escapeText(contentLanguage || ui.lang)}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="color-scheme" content="light dark">',
    `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`,
    `<title>${escapeText(title)}</title>`,
    `<style>${SHARE_VIEWER_CSS}</style>`,
    "<style>#vam-license-notice{position:fixed;inset-inline:0;inset-block-end:0;z-index:2147483647;max-height:18vh;overflow:auto;box-sizing:border-box;padding:4px 8px;background:Canvas;color:CanvasText;font:10px/1.25 system-ui,sans-serif;overflow-wrap:anywhere;pointer-events:none;user-select:text}#vam-license-notice p{margin:0}#vam-license-notice details{pointer-events:auto}#vam-license-notice details pre{max-height:14vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}</style>",
    "</head>",
    "<body>",
    '<div id="vam-app"></div>',
    '<footer id="vam-license-notice">',
    "<p>Viewer program: AGPL-3.0-only. Copyright © 2026 Kevin Tsai. Your map and media remain your content and are not relicensed by this viewer.</p>",
    `<p>${SOURCE_LABEL}: ${CORRESPONDING_SOURCE_URL}</p>`,
    "<details><summary>License texts</summary>",
    `<h2>GNU AGPL-3.0-only</h2><pre>${escapeText(AGPL_LICENSE_TEXT)}</pre>`,
    `<h2>Retained Apache License 2.0</h2><pre>${escapeText(APACHE_LICENSE_TEXT)}</pre>`,
    "</details>",
    "</footer>",
    `<script type="application/json" id="vam-ui">${jsonForScript(uiBlockFor(ui, languages))}</script>`,
    `<script type="application/json" id="vam-map">${mapJson}</script>`,
    `<script>${SHARE_VIEWER_JS}</script>`,
    "</body>",
    "</html>",
    ""
  ].join("\n");
}

/**
 * The whole share file as text: the viewer page with `payload` in `<script type="application/json" id="vam-map">`.
 * Pure: no Obsidian, no I/O. `ui` is the viewer's interface text in the exporter's language (see shareViewerUiFor).
 */
export function renderShareHtml(payload: SharePayload, ui: ShareViewerUi): string {
  const languages = Array.isArray(payload.languages) ? payload.languages : undefined;
  return buildHtml(payload.title, ui, serializeShareJson(payload), languages, payload.contentLanguage);
}

/**
 * Everything in the file except the map payload (page, viewer script and style, interface text). Pass `languages` for a translated file so the extra interface text is scanned too. The leak gate scans
 * this whole text; the payload is scanned field by field with scanPayloadForLeaks.
 */
export function renderShareShell(ui: ShareViewerUi, languages?: readonly string[]): string {
  return buildHtml("", ui, "null", languages, languages?.[0]);
}

/** Reads the payload back out of a share file (the same single block VAM import will read). */
export function parseShareHtml(html: string): unknown {
  const match = /<script type="application\/json" id="vam-map">([\s\S]*?)<\/script>/.exec(html);
  return match ? (JSON.parse(match[1]) as unknown) : undefined;
}
