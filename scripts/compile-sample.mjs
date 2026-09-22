import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sampleRoot = join(root, "samples/taiwan-travel");

function section(markdown, name) {
  const marker = `## ${name}\n`, start = markdown.indexOf(marker);
  if (start < 0) return "";
  const contentStart = start + marker.length, next = markdown.indexOf("\n## ", contentStart);
  return markdown.slice(contentStart, next < 0 ? markdown.length : next).replace(/<!-- visual-agent-map:detail:(?:start|end) -->\s*/g, "").trim();
}

function field(markdown, name) {
  return markdown.match(new RegExp(`^${name}:\\s*(.*)$`, "m"))?.[1].trim() ?? "";
}

function list(value) {
  if (!value.startsWith("[") || !value.endsWith("]")) return [];
  return value.slice(1, -1).split(",").map(item => item.trim()).filter(Boolean);
}

function compileLocale(locale) {
  const folder = join(sampleRoot, locale);
  const mapMarkdown = readFileSync(join(folder, "Map.md"), "utf8");
  const mapBlock = mapMarkdown.match(/```agent-map\s*\n([\s\S]*?)\n```/);
  if (!mapBlock) throw new Error(`${locale}/Map.md has no agent-map block`);
  const map = JSON.parse(mapBlock[1]);
  const notes = {};
  for (const node of map.nodes) {
    const path = join(folder, node.path);
    const markdown = readFileSync(path, "utf8");
    const id = field(markdown, "node-id");
    if (id !== node.id) throw new Error(`${locale}/${node.path} node-id does not match Map.md`);
    for (const required of ["topic-id", "topic-state", "agent-map-id", "preview-initialized", "model", "model-source", "cssclasses", "status", "source-notes"]) if (!field(markdown, required)) throw new Error(`${locale}/${node.path} is missing ${required}`);
    for (const match of markdown.matchAll(/\.\.\/Attachments\/([^)\s]+)/g)) if (!existsSync(join(sampleRoot, "Attachments", match[1]))) throw new Error(`${locale}/${node.path} references missing attachment ${match[1]}`);
    notes[node.path] = {
      title: markdown.match(/^# (.+)$/m)?.[1] ?? node.path,
      summary: section(markdown, "Current Summary"),
      prompt: section(markdown, "Prompt"),
      rules: section(markdown, "Rules"),
      preview: section(markdown, locale === "en" ? "Preview" : "預覽"),
      detail: section(markdown, "Detail"),
      status: field(markdown, "status") || "completed",
      sourcePaths: list(field(markdown, "source-notes"))
    };
  }
  return { ...map, notes };
}

const assets = {};
for (const name of readdirSync(join(sampleRoot, "Attachments")).filter(name => name.endsWith(".webp")).sort()) {
  assets[name] = `data:image/webp;base64,${readFileSync(join(sampleRoot, "Attachments", name)).toString("base64")}`;
}

const locales = { "zh-TW": compileLocale("zh-TW"), en: compileLocale("en") };
const topology = sample => sample.nodes.map(({ id, path, parentId, x, y, collapsed }) => ({ id, path, parentId, x, y, collapsed }));
if (JSON.stringify(topology(locales["zh-TW"])) !== JSON.stringify(topology(locales.en))) throw new Error("Sample locale topology must match exactly");
const totalBytes = Object.keys(assets).reduce((sum, name) => sum + statSync(join(sampleRoot, "Attachments", name)).size, 0);
if (totalBytes > 1_200_000) throw new Error(`Sample attachments exceed 1.2 MB: ${totalBytes}`);
const output = { contentVersion: 2, locales, assets };
writeFileSync(join(sampleRoot, "compiled.json"), `${JSON.stringify(output)}\n`);
process.stdout.write(`Compiled ${Object.keys(output.locales["zh-TW"].notes).length} notes and ${Object.keys(assets).length} assets from ${relative(root, sampleRoot)}\n`);
