import type { MapDocument } from "./map-model";
import type { Note } from "./repository";
import compiled from "./samples/taiwan-travel/compiled.json";

export const BUILTIN_SAMPLE_ID = "taiwan-travel";
export const SAMPLE_CONTENT_VERSION = compiled.contentVersion;
export const SAMPLE_TOUR_VERSION = 2;

type SourceNote = Pick<Note, "title" | "summary" | "prompt" | "rules" | "preview" | "detail" | "status" | "sourcePaths">;
interface SourceSample extends Omit<MapDocument, "version"> { notes: Record<string, SourceNote> }
export interface BuiltInSample { map: MapDocument; notes: Map<string, Note>; assets: Map<string, ArrayBuffer> }

const sources = compiled.locales as Record<"zh-TW" | "en", SourceSample>;

function binary(dataUri: string): ArrayBuffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const source = dataUri.slice(dataUri.indexOf(",") + 1).replace(/=+$/, "");
  const bytes: number[] = []; let buffer = 0, bits = 0;
  for (const character of source) {
    const value = alphabet.indexOf(character); if (value < 0) continue;
    buffer = buffer * 64 + value; bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 255); buffer &= (1 << bits) - 1; }
  }
  return Uint8Array.from(bytes).buffer;
}

function embedAssets(markdown: string): string {
  return markdown.replace(/\.\.\/Attachments\/([^)\s]+)/g, (path, name: string) => compiled.assets[name as keyof typeof compiled.assets] ?? path);
}

export function builtInSample(language: "zh-TW" | "en", useEmbeddedAssets = true): BuiltInSample {
  const source = sources[language];
  const map: MapDocument = { version: 1, id: source.id, title: source.title, nodes: source.nodes.map(node => ({ ...node })), viewport: { ...source.viewport } };
  const notes = new Map<string, Note>();
  for (const node of map.nodes) {
    const note = source.notes[node.path];
    if (!note) throw new Error(`Built-in sample note is missing: ${node.path}`);
    notes.set(node.id, { ...note, preview: useEmbeddedAssets ? embedAssets(note.preview) : note.preview, detail: useEmbeddedAssets ? embedAssets(note.detail) : note.detail, visualReferences: "", newFindings: "", model: "", modelSource: "workspace", researchMode: "research", researchDepth: "normal", visualMode: "auto", mapId: map.id, topicId: map.id, topicState: "active", sourcePaths: [...note.sourcePaths] });
  }
  return { map, notes, assets: new Map(Object.entries(compiled.assets).map(([name, data]) => [name, binary(data)])) };
}

export function validateBuiltInSample(language: "zh-TW" | "en"): string[] {
  const sample = builtInSample(language), errors: string[] = [], paths = new Set(sample.map.nodes.map(node => node.path));
  if (sample.map.nodes.filter(node => node.parentId === null).length !== 2) errors.push("Sample must have exploration and synthesis roots.");
  for (const note of sample.notes.values()) for (const path of note.sourcePaths) if (!paths.has(path)) errors.push(`Unknown source path: ${path}`);
  if (![...sample.notes.values()].some(note => note.sourcePaths.length >= 2)) errors.push("Sample must demonstrate synthesis sources.");
  if (sample.map.nodes.length !== 12) errors.push("Sample must contain the approved 12-node journey.");
  if (![...sample.notes.values()].some(note => note.status === "idea")) errors.push("Sample must retain one unfinished idea.");
  if (![...sample.notes.values()].some(note => note.preview.includes("|---"))) errors.push("Sample must demonstrate a preview table.");
  if (![...sample.notes.values()].some(note => note.preview.includes("data:image/webp;base64,"))) errors.push("Sample must demonstrate a preview image.");
  if (sample.assets.size !== 5) errors.push("Sample must include five bundled images.");
  return errors;
}
