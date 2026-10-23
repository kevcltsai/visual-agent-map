// Writes a demo share file from a fixture payload, with no Obsidian: the same renderShareHtml the plugin uses.
// Usage: node scripts/make-share-demo.mjs --out <file.html> [--lang en|zh-TW|zh-CN] [--payload <payload.json>]
//        [--translate en,ja,zh-TW --content-language fr [--default-language ja]]
// With --translate the demo adds fake translations (each text prefixed "[<language>] ") through attachTranslations, to try
// the viewer's language menu without any AI; --content-language says which language the original text is in.
// The payload already holds its detailHtml (see tests/fixtures/sharing/viewer-payload.json).
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const out = option("out");
const lang = option("lang", "en");
const payloadPath = option("payload", path.join(root, "tests/fixtures/sharing/viewer-payload.json"));
if (!out) throw new Error("Usage: node scripts/make-share-demo.mjs --out <file.html> [--lang en|zh-TW|zh-CN] [--payload <file>]");
if (!["en", "zh-TW", "zh-CN"].includes(lang)) throw new Error(`Unsupported --lang ${lang}`);

const bundled = await build({
  stdin: {
    contents: [
      'export { renderShareHtml } from "./experiences/sharing/share-html";',
      'export { shareViewerUiFor } from "./experiences/sharing/share-viewer-text";',
      'export { attachTranslations } from "./experiences/sharing/share-build";'
    ].join("\n"),
    resolveDir: root,
    loader: "ts"
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  loader: { ".md": "text" },
  external: ["obsidian"],
  logLevel: "warning"
});
const module = { exports: {} };
const forbidRequire = () => {
  throw new Error("The share renderer must not require anything.");
};
vm.runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, require: forbidRequire, TextDecoder });
const { renderShareHtml, shareViewerUiFor, attachTranslations } = module.exports;

const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
payload.language = lang;
let shared = payload;
const translate = option("translate", "")
  .split(",")
  .map(item => item.trim())
  .filter(Boolean);
if (translate.length) {
  const contentLanguage = option("content-language", payload.language);
  const defaultLanguage = option("default-language", undefined);
  const pieces = translate.map(language => ({
    language,
    piece: {
      top: { title: `[${language}] ${payload.title}`, ...(payload.goal ? { goal: `[${language}] ${payload.goal}` } : {}) },
      nodes: Object.fromEntries(
        payload.nodes.map(node => [
          node.id,
          {
            title: `[${language}] ${node.title}`,
            summary: node.summary ? `[${language}] ${node.summary}` : "",
            ...(node.reason ? { reason: `[${language}] ${node.reason}` } : {}),
            ...(node.detailHtml ? { detailHtml: `<p>[${language}] translated note</p>${node.detailHtml}` } : {})
          }
        ])
      )
    }
  }));
  shared = attachTranslations(payload, { contentLanguage, pieces, defaultLanguage });
}
const html = renderShareHtml(shared, shareViewerUiFor(lang));
mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
writeFileSync(out, html);
process.stdout.write(`${path.resolve(out)} (${html.length} bytes, ${lang})\n`);
