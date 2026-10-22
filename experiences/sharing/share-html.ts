import { serializeShareJson, type SharePayload } from "./share-format";
import type { ShareViewerUi } from "./share-viewer-ui";
import { SHARE_VIEWER_CSS, SHARE_VIEWER_JS } from "./viewer-bundle.generated";

/**
 * Meta policy of every shared file: nothing is fetched except pictures (data: images, and the web pictures a note links),
 * no frames, forms or connections, and no `eval`. The inline script and style are the file's own.
 */
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

const escapeText = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** JSON for a `<script type="application/json">` block: every `<` escaped (see serializeShareJson). */
const jsonForScript = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

function buildHtml(title: string, ui: ShareViewerUi, mapJson: string): string {
  return [
    "<!doctype html>",
    `<html lang="${escapeText(ui.lang)}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="color-scheme" content="light dark">',
    `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`,
    `<title>${escapeText(title)}</title>`,
    `<style>${SHARE_VIEWER_CSS}</style>`,
    "</head>",
    "<body>",
    '<div id="vam-app"></div>',
    `<script type="application/json" id="vam-ui">${jsonForScript(ui)}</script>`,
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
  return buildHtml(payload.title, ui, serializeShareJson(payload));
}

/**
 * Everything in the file except the map payload (page, viewer script and style, interface text). The leak gate scans
 * this whole text; the payload is scanned field by field with scanPayloadForLeaks.
 */
export function renderShareShell(ui: ShareViewerUi): string {
  return buildHtml("", ui, "null");
}

/** Reads the payload back out of a share file (the same single block VAM import will read). */
export function parseShareHtml(html: string): unknown {
  const match = /<script type="application\/json" id="vam-map">([\s\S]*?)<\/script>/.exec(html);
  return match ? (JSON.parse(match[1]) as unknown) : undefined;
}
