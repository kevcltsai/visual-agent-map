import { App, TFile, TFolder, normalizePath, parseYaml, stringifyYaml } from "obsidian";
import { MapDocument, MapNode, serializeMap, parseMap } from "./map-model";

export type Status = "idea" | "running" | "completed" | "error";
export type ModelSource = "workspace" | "inherited" | "manual";
export type TopicState = "active" | "unassigned" | "archived" | "inbox";
export type TopicCollection = "Notes" | "Unassigned" | "Archive";
export type ReasoningLevel = "auto" | "low" | "medium" | "high";
export type ResearchMode = "local" | "research";
export type ResearchDepth = "fast" | "normal" | "deep";
export type VisualMode = "auto" | "on" | "off";
export interface VisualReference { title: string; imageUrl: string; sourceUrl: string; description: string; palette: string[]; formula: string }
export interface Note {
  title: string;
  summary: string;
  prompt: string;
  rules: string;
  detail: string;
  visualReferences: string;
  newFindings: string;
  preview: string;
  model: string;
  modelSource: ModelSource;
  reasoning?: ReasoningLevel;
  researchMode: ResearchMode;
  researchDepth: ResearchDepth;
  visualMode: VisualMode;
  status: Status;
  mapId: string;
  topicId: string;
  topicState: TopicState;
  sourcePaths: string[];
}
export type NotePatch = Partial<Note>;
export interface Settings {
  language: "zh-TW" | "en";
  workspaceFolder: string;
  topicsFolder: string;
  inboxFolder: string;
  notesFolder: string;
  mapsFolder: string;
  mapId: string;
  codexPath: string;
  cliModel: string;
  cliReasoning: ReasoningLevel;
  previewSize?: "small" | "medium" | "large";
  previewScale: number;
  models: string;
  migrated: boolean;
  structureVersion: number;
  firstUseNoticeSeen: boolean;
  codexUsageNoticeSeen: boolean;
  aiExchangeLoggingEnabled: boolean;
  workspaceInitialized: boolean;
  sampleTourVersionSeen: number;
}
export interface TopicInfo { id: string; title: string; mapPath: string; root: string }
export interface BrokenTopic { title: string; root: string; noteCount: number }
export interface LegacyMigrationPlan {
  maps: { oldPath: string; title: string; targetRoot: string; notePaths: string[] }[];
  orphanPaths: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  language: "zh-TW",
  workspaceFolder: "Agent Workspace",
  topicsFolder: "Agent Workspace/Topics",
  inboxFolder: "Agent Workspace/Inbox",
  notesFolder: "Agent Workspace/Nodes",
  mapsFolder: "Agent Workspace/Maps",
  mapId: "default",
  codexPath: "codex",
  cliModel: "gpt-5.6-luna",
  cliReasoning: "low",
  previewScale: 120,
  models: "",
  migrated: false,
  structureVersion: 2,
  firstUseNoticeSeen: false,
  codexUsageNoticeSeen: false,
  aiExchangeLoggingEnabled: false,
  workspaceInitialized: false,
  sampleTourVersionSeen: 0
};

export function normalizeReasoningLevel(value: unknown): ReasoningLevel {
  return value === "auto" || value === "medium" || value === "high" ? value : "low";
}

const REFERENCE_START = "<!-- visual-agent-map:references:start -->";
const REFERENCE_END = "<!-- visual-agent-map:references:end -->";
const DETAIL_START = "<!-- visual-agent-map:detail:start -->";
const DETAIL_END = "<!-- visual-agent-map:detail:end -->";
const NOTE_CSS_CLASS = "visual-agent-map-node";

function marker(value: unknown): boolean { return value === true || value === "true"; }
function text(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function parentPath(path: string): string { return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""; }
function baseName(path: string): string { return path.slice(path.lastIndexOf("/") + 1); }

function ensureNoteCssClass(fm: Record<string, unknown>): boolean {
  const current = Array.isArray(fm.cssclasses)
    ? fm.cssclasses.map(String)
    : typeof fm.cssclasses === "string"
      ? fm.cssclasses.split(/[\s,]+/).filter(Boolean)
      : [];
  if (current.includes(NOTE_CSS_CLASS)) return false;
  fm.cssclasses = [...current, NOTE_CSS_CLASS];
  return true;
}

export function safeName(title: string): string {
  return title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "未命名主題";
}

function frontmatter(content: string): Record<string, unknown> {
  const yaml = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  return yaml ? (parseYaml(yaml) ?? {}) as Record<string, unknown> : {};
}

function noteTitle(content: string, fm: Record<string, unknown>, fallback: string): string {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  return /^# (.+)$/m.exec(body)?.[1]?.trim() || text(fm.title, fallback);
}

type NoteSection = "Current Summary" | "Prompt" | "Rules" | "Detail" | "Visual References" | "Working Findings" | "New Findings" | "預覽" | "Preview" | "User Notes";
type NoteLanguage = Settings["language"];
const placeholder = (language: NoteLanguage): string => language === "en" ? "No conclusion yet" : "尚未形成結論";
const isPlaceholder = (value: string): boolean => value === "尚未形成結論" || value === "No conclusion yet";
const previewHeading = (language: NoteLanguage): NoteSection => language === "en" ? "Preview" : "預覽";
const previewSection = (content: string): string => [...new Set([section(content, "Preview"), section(content, "預覽")].filter(Boolean))].join("\n\n");

function sectionBounds(content: string, heading: NoteSection): { start: number; end: number } | null {
  if (heading === "Detail") {
    const managedStart = content.indexOf(DETAIL_START), managedEnd = content.indexOf(DETAIL_END);
    if (managedStart >= 0 && managedEnd > managedStart) return { start: managedStart + DETAIL_START.length, end: managedEnd };
  }
  const match = new RegExp(`^## ${heading.replace(" ", "\\s+")}\\s*$`, "m").exec(content);
  if (!match) return null;
  const start = match.index + match[0].length;
  const next = /^## .+$/m.exec(content.slice(start));
  const reference = content.indexOf(REFERENCE_START, start);
  const candidates = [next ? start + next.index : content.length, reference >= 0 ? reference : content.length];
  return { start, end: Math.min(...candidates) };
}

function section(content: string, heading: NoteSection): string {
  const bounds = sectionBounds(content, heading);
  return bounds ? content.slice(bounds.start, bounds.end).trim() : "";
}

function replaceSection(content: string, heading: NoteSection, value: string): string {
  const bounds = sectionBounds(content, heading);
  if (bounds) {
    if (heading === "Detail" && !content.slice(0, bounds.start).includes(DETAIL_START)) {
      return `${content.slice(0, bounds.start)}\n\n${DETAIL_START}\n${value.trim()}\n${DETAIL_END}\n\n${content.slice(bounds.end).replace(/^\s*/, "")}`;
    }
    return `${content.slice(0, bounds.start)}\n${value.trim()}\n${content.slice(bounds.end)}`;
  }
  const reference = content.indexOf(REFERENCE_START);
  const at = reference >= 0 ? reference : content.length;
  const managed = heading === "Detail" ? `${DETAIL_START}\n${value.trim()}\n${DETAIL_END}` : value.trim();
  return `${content.slice(0, at).trimEnd()}\n\n## ${heading}\n\n${managed}\n\n${content.slice(at).trimStart()}`;
}

function replaceSummarySection(content: string, value: string): string {
  if (sectionBounds(content, "Current Summary")) return replaceSection(content, "Current Summary", value);
  const title = /^# .*$/m.exec(content);
  if (!title) return replaceSection(content, "Current Summary", value);
  const at = title.index + title[0].length;
  return `${content.slice(0, at)}\n\n## Current Summary\n\n${value.trim()}\n\n${content.slice(at).trimStart()}`;
}

function removeSection(content: string, heading: NoteSection): string {
  if (heading === "Detail") {
    const managedStart = content.indexOf(DETAIL_START), managedEnd = content.indexOf(DETAIL_END);
    if (managedStart >= 0 && managedEnd > managedStart) {
      const headingMatch = /^## Detail\s*$/m.exec(content.slice(0, managedStart));
      const start = headingMatch ? headingMatch.index : managedStart;
      return `${content.slice(0, start).trimEnd()}\n\n${content.slice(managedEnd + DETAIL_END.length).trimStart()}`;
    }
  }
  const bounds = sectionBounds(content, heading);
  if (!bounds) return content;
  const headingMatch = new RegExp(`^## ${heading.replace(" ", "\\s+")}\\s*$`, "m").exec(content.slice(0, bounds.start));
  if (!headingMatch) return content;
  return `${content.slice(0, headingMatch.index).trimEnd()}\n\n${content.slice(bounds.end).trimStart()}`;
}

function ensurePreview(content: string, language: NoteLanguage): string {
  const legacy = section(content, "User Notes");
  const preview = previewSection(content);
  const merged = [isPlaceholder(preview) ? placeholder(language) : preview, legacy].filter(Boolean).join("\n\n");
  const clean = removeSection(removeSection(removeSection(content, "User Notes"), "預覽"), "Preview");
  return replaceSection(clean, previewHeading(language), merged);
}

function withoutReference(content: string): string {
  const managed = new RegExp(`\\n?${REFERENCE_START}[\\s\\S]*?${REFERENCE_END}\\n?`, "m");
  if (managed.test(content)) return content.replace(managed, "\n");
  const legacy = /\n?^## 關聯議題\s*\n+(?:母議題：[^\n]*\n+)?(?:子議題：[^\n]*\n*)?$/m;
  return legacy.test(content) ? content.replace(legacy, "\n") : content;
}

function detailWithVisualReferences(detail: string, visualReferences: string): string {
  let current = detail.trim();
  const references = visualReferences.trim().split(/\n(?=\*\*[^\n]+\*\*\n|### )/).filter(Boolean);
  for (const reference of references) {
    const image = reference.match(/!\[[^\]]*\]\(([^)]+)\)/);
    if (!image || current.includes(`](${image[1]})`)) continue;
    const block = reference.replace(/^### (.+)$/gm, "**$1**").trim();
    const title = block.match(/^\*\*(.+)\*\*/)?.[1];
    const paragraphs = current.split("\n\n");
    const related = title ? paragraphs.findIndex(text => !/^#{1,6} /.test(text) && text.includes(title)) : -1;
    if (related >= 0) {
      paragraphs.splice(related + 1, 0, block);
      current = paragraphs.join("\n\n");
    } else {
      const knowledge = /^### 關鍵知識\s*$/m.exec(current);
      const next = knowledge ? /^### .+$/m.exec(current.slice(knowledge.index + knowledge[0].length)) : null;
      const at = knowledge && next ? knowledge.index + knowledge[0].length + next.index : current.length;
      current = [current.slice(0, at).trimEnd(), block, current.slice(at).trimStart()].filter(Boolean).join("\n\n");
    }
  }
  return current;
}

function initialPreview(summary: string, detail: string): string {
  const image = detail.match(/!\[[^\]]*\]\((?:https?:\/\/[^)\s]+)\)/)?.[0];
  return [summary.trim(), image].filter(Boolean).join("\n\n");
}

function noteBody(title: string, summary: string, language: NoteLanguage, prompt = "", rules = "", preview = "", detail = "", visualReferences = "", newFindings = "", leftover = ""): string {
  const detailBlock = `${DETAIL_START}\n${detailWithVisualReferences(detail, visualReferences)}\n${DETAIL_END}`;
  return [
    `# ${title}`,
    `## Current Summary\n\n${summary.trim() || placeholder(language)}`,
    `## Prompt\n\n${prompt.trim()}`,
    `## Rules\n\n${rules.trim()}`,
    `## ${previewHeading(language)}\n\n${preview.trim()}`,
    `## Detail\n\n${detailBlock}`,
    newFindings.trim() ? `## Working Findings\n\n${newFindings.trim()}` : "",
    leftover.trim()
  ].filter(Boolean).join("\n\n") + "\n";
}

function normalizeBodyOrder(content: string, title: string, summaryFallback: string, language: NoteLanguage): string {
  const clean = ensurePreview(withoutReference(content), language);
  const currentSummary = section(clean, "Current Summary") || summaryFallback;
  const summary = isPlaceholder(currentSummary) ? placeholder(language) : currentSummary;
  const prompt = section(clean, "Prompt");
  const rules = section(clean, "Rules");
  const preview = previewSection(clean);
  const detail = detailWithVisualReferences(section(clean, "Detail"), section(clean, "Visual References"));
  const newFindings = section(clean, "Working Findings") || section(clean, "New Findings");
  let leftover = clean.replace(/^# .*$(?:\r?\n)*/m, "");
  for (const heading of ["Current Summary", "Prompt", "Rules", "預覽", "Preview", "Detail", "Visual References", "Working Findings", "New Findings"] as NoteSection[]) leftover = removeSection(leftover, heading);
  return noteBody(title, summary, language, prompt, rules, preview, detail, "", newFindings, leftover);
}

const REFERENCE_LABELS = ["所屬主題", "所屬心智圖", "母議題", "子議題", "來源議題", "狀態"];
const ENGLISH_REFERENCE_LABELS = ["Topic", "Mind map", "Parent topic", "Child topics", "Source topic", "Status"];
function localizeReference(value: string, language: NoteLanguage): string {
  const match = /^(所屬主題|所屬心智圖|母議題|子議題|來源議題|狀態|Topic|Mind map|Parent topic|Child topics|Source topic|Status)[：:]\s*(.*)$/.exec(value);
  if (!match) return value;
  const index = (REFERENCE_LABELS.includes(match[1]) ? REFERENCE_LABELS : ENGLISH_REFERENCE_LABELS).indexOf(match[1]);
  const labels = language === "en" ? ENGLISH_REFERENCE_LABELS : REFERENCE_LABELS;
  const plain = match[2] === "無" || match[2] === "None" ? language === "en" ? "None" : "無"
    : match[2] === "已封存" || match[2] === "Archived" ? language === "en" ? "Archived" : "已封存"
    : match[2] === "未歸類" || match[2] === "Unassigned" ? language === "en" ? "Unassigned" : "未歸類" : match[2];
  return `${labels[index]}${language === "en" ? ": " : "："}${plain}`;
}

function withReferenceLinks(body: string, fm: Record<string, unknown>, language: NoteLanguage): string {
  const sources = Array.isArray(fm["source-notes"]) ? fm["source-notes"].map(String).filter(Boolean) : [];
  const relationships = Array.isArray(fm["agent-map-references"]) ? fm["agent-map-references"].map(String).filter(text => text.includes("[[")) : [];
  const label = language === "en" ? "Source topic: " : "來源議題：";
  const links = [...relationships.map(value => localizeReference(value, language)), ...sources.map(path => `${label}[[${noteLink(path)}]]`)];
  const clean = withoutReference(body).trimEnd();
  return links.length ? `${clean}\n\n${REFERENCE_START}\n## Reference Links\n\n${[...new Set(links)].map(link => `- ${link}`).join("\n")}\n${REFERENCE_END}\n` : `${clean}\n`;
}

function noteLink(path: string): string { return path.replace(/\.md$/, "").replace(/\|/g, "\\|"); }

export class Repository {
  constructor(readonly app: App, readonly settings: Settings) {}
  private message(chinese: string, english: string): string { return this.settings.language === "en" ? english : chinese; }

  file(path: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`${this.message("找不到檔案", "File not found")}: ${path}`);
    return file;
  }

  async folder(path: string): Promise<void> {
    let current = "";
    for (const part of normalizePath(path).split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }

  workspaceExists(): boolean { return this.app.vault.getAbstractFileByPath(this.settings.workspaceFolder) instanceof TFolder; }

  async workspaceCandidates(): Promise<string[]> {
    const candidates = new Set<string>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const match = file.path.match(/^(.*)\/Topics\/[^/]+\/Map\.md$/);
      if (!match?.[1]) continue;
      try { parseMap(await this.app.vault.read(file)); candidates.add(match[1]); }
      catch { /* Ignore unrelated files named Map.md. */ }
    }
    return [...candidates].sort((left, right) => left.localeCompare(right));
  }

  async ensureWorkspace(): Promise<void> {
    await this.folder(this.settings.topicsFolder);
    await this.folder(this.settings.inboxFolder);
  }

  unique(folder: string, name: string): string {
    const base = normalizePath(`${folder}/${safeName(name)}`);
    let path = `${base}.md`, number = 2;
    while (this.app.vault.getAbstractFileByPath(path)) path = `${base} ${number++}.md`;
    return path;
  }

  uniqueFolder(folder: string, name: string): string {
    const base = normalizePath(`${folder}/${safeName(name)}`);
    let path = base, number = 2;
    while (this.app.vault.getAbstractFileByPath(path)) path = `${base} ${number++}`;
    return path;
  }

  topicRoot(mapPath: string): string { return parentPath(mapPath); }
  topicFolder(mapPath: string, collection: TopicCollection): string { return `${this.topicRoot(mapPath)}/${collection}`; }

  async ensureTopicFolders(root: string): Promise<void> {
    await this.folder(root);
    for (const name of ["Notes", "Unassigned", "Archive"]) await this.folder(`${root}/${name}`);
  }

  async readNote(path: string): Promise<Note> {
    const file = this.file(path), content = await this.app.vault.read(file), fm = frontmatter(content);
    const status = text(fm.status, "idea");
    const normalized = status === "review" || status === "accepted" ? "completed" : status;
    const source = text(fm["model-source"], "workspace");
    const state = text(fm["topic-state"], path.includes("/Archive/") ? "archived" : path.includes("/Unassigned/") ? "unassigned" : path.startsWith(`${this.settings.inboxFolder}/`) ? "inbox" : "active");
    return {
      title: noteTitle(content, fm, file.basename),
      summary: section(content, "Current Summary") || text(fm.summary, placeholder(this.settings.language)),
      prompt: section(content, "Prompt"),
      rules: section(content, "Rules"),
      detail: section(content, "Detail"),
      visualReferences: section(content, "Visual References"),
      newFindings: section(content, "Working Findings") || section(content, "New Findings"),
      preview: [previewSection(content), section(content, "User Notes")].filter(Boolean).join("\n\n"),
      model: text(fm.model, this.settings.cliModel),
      modelSource: ["workspace", "inherited", "manual"].includes(source) ? source as ModelSource : "workspace",
      reasoning: normalizeReasoningLevel(fm["reasoning-level"] ?? this.settings.cliReasoning),
      researchMode: fm["research-mode"] === "local" ? "local" : "research",
      researchDepth: fm["research-depth"] === "fast" || fm["research-depth"] === "deep" ? fm["research-depth"] : "normal",
      visualMode: fm["visual-mode"] === "on" || fm["visual-mode"] === "off" ? fm["visual-mode"] : "auto",
      status: ["idea", "running", "completed", "error"].includes(normalized) ? normalized as Status : "idea",
      mapId: text(fm["agent-map-id"]),
      topicId: text(fm["topic-id"], text(fm["agent-map-id"])),
      topicState: ["active", "unassigned", "archived", "inbox"].includes(state) ? state as TopicState : "active",
      sourcePaths: Array.isArray(fm["source-notes"]) ? fm["source-notes"].filter((value): value is string => typeof value === "string" && Boolean(value)) : []
    };
  }

  async updateNote(path: string, patch: NotePatch): Promise<void> {
    await this.app.vault.process(this.file(path), content => {
      const fm = frontmatter(content);
      ensureNoteCssClass(fm);
      if (Array.isArray(fm["agent-map-references"])) fm["agent-map-references"] = fm["agent-map-references"].map(value => localizeReference(String(value), this.settings.language));
      fm.title = patch.title ?? noteTitle(content, fm, baseName(path).replace(/\.md$/, ""));
      for (const key of ["summary", "model", "status"] as const) if (patch[key] !== undefined) fm[key] = patch[key];
      if (patch.modelSource !== undefined) fm["model-source"] = patch.modelSource;
      if (patch.reasoning !== undefined) fm["reasoning-level"] = normalizeReasoningLevel(patch.reasoning);
      if (patch.researchMode !== undefined) fm["research-mode"] = patch.researchMode;
      if (patch.researchDepth !== undefined) fm["research-depth"] = patch.researchDepth;
      if (patch.visualMode !== undefined) fm["visual-mode"] = patch.visualMode;
      if (patch.mapId !== undefined) patch.mapId ? fm["agent-map-id"] = patch.mapId : delete fm["agent-map-id"];
      if (patch.topicId !== undefined) patch.topicId ? fm["topic-id"] = patch.topicId : delete fm["topic-id"];
      if (patch.topicState !== undefined) fm["topic-state"] = patch.topicState;
      if (patch.sourcePaths !== undefined) patch.sourcePaths.length ? fm["source-notes"] = patch.sourcePaths : delete fm["source-notes"];
      fm.updated = new Date().toISOString();
      let body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
      body = ensurePreview(body, this.settings.language);
      if (isPlaceholder(text(fm.summary))) fm.summary = placeholder(this.settings.language);
      if (patch.title !== undefined) body = body.replace(/^# .*$/m, `# ${patch.title.replace(/\n/g, " ")}`);
      if (patch.summary !== undefined) body = replaceSummarySection(body, patch.summary);
      if (patch.prompt !== undefined) body = replaceSection(body, "Prompt", patch.prompt);
      if (patch.rules !== undefined) body = replaceSection(body, "Rules", patch.rules);
      if (patch.detail !== undefined) body = replaceSection(body, "Detail", patch.detail);
      if (patch.visualReferences !== undefined) {
        body = removeSection(body, "Visual References");
        if (patch.visualReferences.trim()) body = replaceSection(body, "Detail", detailWithVisualReferences(section(body, "Detail"), patch.visualReferences));
      }
      if (patch.newFindings !== undefined) {
        if (patch.newFindings.trim()) body = replaceSection(body, "Working Findings", patch.newFindings);
        else { body = removeSection(body, "Working Findings"); body = removeSection(body, "New Findings"); }
      }
      if (patch.preview !== undefined) {
        body = replaceSection(body, previewHeading(this.settings.language), patch.preview);
        fm["preview-initialized"] = true;
      } else if (patch.summary !== undefined && patch.summary.trim() && !isPlaceholder(patch.summary) && fm["preview-initialized"] !== true) {
        const preview = previewSection(body).trim();
        if (!preview || isPlaceholder(preview)) body = replaceSection(body, previewHeading(this.settings.language), initialPreview(patch.summary, section(body, "Detail")));
        fm["preview-initialized"] = true;
      }
      body = normalizeBodyOrder(body, text(fm.title, path.replace(/\.md$/, "")), text(fm.summary, placeholder(this.settings.language)), this.settings.language);
      return `---\n${stringifyYaml(fm)}---\n${withReferenceLinks(body, fm, this.settings.language)}`;
    });
  }

  async createNote(title: string, model: string, map: MapDocument, mapPath: string, modelSource: ModelSource): Promise<MapNode> {
    const folder = this.topicFolder(mapPath, "Notes");
    await this.ensureTopicFolders(this.topicRoot(mapPath));
    const id = crypto.randomUUID(), path = this.unique(folder, title);
    const metadata = {
      "agent-map-node": true,
      "node-id": id,
      "topic-id": map.id,
      "topic-state": "active",
      "agent-map-id": map.id,
      title,
      summary: placeholder(this.settings.language),
      "preview-initialized": false,
      model,
      "model-source": modelSource,
      "reasoning-level": this.settings.cliReasoning,
      status: "idea",
      cssclasses: [NOTE_CSS_CLASS]
    };
    await this.app.vault.create(path, `---\n${stringifyYaml(metadata)}---\n${noteBody(title, placeholder(this.settings.language), this.settings.language, "", "", placeholder(this.settings.language))}`);
    return { id, path, parentId: null, x: 80, y: 80, collapsed: false };
  }

  async duplicateNote(sourcePath: string, map: MapDocument, mapPath: string): Promise<MapNode> {
    const folder = this.topicFolder(mapPath, "Notes");
    await this.ensureTopicFolders(this.topicRoot(mapPath));
    const source = await this.app.vault.read(this.file(sourcePath));
    const metadata = frontmatter(source);
    const title = `${text(metadata.title, this.file(sourcePath).basename)} ${this.settings.language === "en" ? "copy" : "副本"}`;
    const id = crypto.randomUUID(), path = this.unique(folder, title);
    metadata["node-id"] = id;
    metadata["topic-id"] = map.id;
    metadata["agent-map-id"] = map.id;
    metadata["topic-state"] = "active";
    metadata.title = title;
    const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").replace(/^# .*$/m, `# ${title}`);
    await this.app.vault.create(path, `---\n${stringifyYaml(metadata)}---\n${body}`);
    return { id, path, parentId: null, x: 80, y: 80, collapsed: false };
  }

  async readMap(path: string): Promise<MapDocument> { return parseMap(await this.app.vault.read(this.file(path))); }

  async saveMap(path: string, map: MapDocument): Promise<void> {
    await this.app.vault.process(this.file(path), content => {
      parseMap(content);
      return content
        .replace(/^# .*$/m, () => `# ${map.title.replace(/\n/g, " ")}`)
        .replace(/```agent-map\s*\n[\s\S]*?\n```/, () => `\`\`\`agent-map\n${JSON.stringify(map, null, 2)}\n\`\`\``);
    });
  }

  async mapFiles(): Promise<TFile[]> {
    const files: TFile[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cached: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.["visual-agent-map"];
      if (marker(cached) || /^---\r?\n[\s\S]*?visual-agent-map: true\r?\n/.test(await this.app.vault.cachedRead(file))) files.push(file);
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  async reconcileMissingNodePaths(): Promise<number> {
    const candidates = new Map<string, string[]>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = frontmatter(await this.app.vault.read(file));
      if (!marker(fm["agent-map-node"])) continue;
      const id = text(fm["node-id"]);
      if (id) candidates.set(id, [...(candidates.get(id) ?? []), file.path]);
    }
    let repaired = 0;
    for (const file of await this.mapFiles()) {
      const map = await this.readMap(file.path); let changed = false;
      for (const node of map.nodes) {
        if (this.app.vault.getAbstractFileByPath(node.path) instanceof TFile) continue;
        const matches = candidates.get(node.id) ?? [];
        if (matches.length !== 1) continue;
        const oldPath = node.path; node.path = matches[0]; changed = true; repaired++;
        await this.replaceSourcePath(oldPath, node.path);
      }
      if (changed) await this.saveMap(file.path, map);
    }
    return repaired;
  }

  async topics(): Promise<TopicInfo[]> {
    const topics: TopicInfo[] = [];
    for (const file of await this.mapFiles()) {
      const map = await this.readMap(file.path);
      topics.push({ id: map.id, title: map.title, mapPath: file.path, root: this.topicRoot(file.path) });
    }
    return topics;
  }

  async brokenTopics(): Promise<BrokenTopic[]> {
    const root = this.app.vault.getAbstractFileByPath(this.settings.topicsFolder);
    if (!(root instanceof TFolder)) return [];
    const broken: BrokenTopic[] = [];
    for (const child of root.children) {
      if (!(child instanceof TFolder) || this.app.vault.getAbstractFileByPath(`${child.path}/Map.md`)) continue;
      const prefix = `${child.path}/Notes/`;
      const noteCount = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(prefix)).length;
      broken.push({ title: child.name, root: child.path, noteCount });
    }
    return broken.sort((a, b) => a.title.localeCompare(b.title));
  }

  async rebuildMissingMap(root: string): Promise<string> {
    const path = `${root}/Map.md`;
    if (this.app.vault.getAbstractFileByPath(path)) throw new Error(this.message("這個主題已有 Map.md。", "This topic already has a Map.md file."));
    const files = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(`${root}/Notes/`) && marker(this.app.metadataCache.getFileCache(file)?.frontmatter?.["agent-map-node"]));
    const first = files[0] ? await this.readNote(files[0].path) : null, id = first?.topicId || crypto.randomUUID();
    const nodes: MapNode[] = files.map((file, index) => ({ id: crypto.randomUUID(), path: file.path, parentId: null, x: 80 + Math.floor(index / 6) * 340, y: 80 + index % 6 * 220, collapsed: false }));
    const map: MapDocument = { version: 1, id, title: baseName(root), nodes, viewport: { x: 40, y: 40, zoom: 1 } };
    await this.app.vault.create(path, serializeMap(map, this.settings.language));
    for (const file of files) await this.setLifecycle(file.path, id, id, "active");
    await this.rebuildDerivedData(); return path;
  }

  async relinkMissingMap(root: string, sourcePath: string): Promise<string> {
    const target = `${root}/Map.md`;
    if (this.app.vault.getAbstractFileByPath(target)) throw new Error(this.message("這個主題已有 Map.md。", "This topic already has a Map.md file."));
    const map = await this.readMap(sourcePath), candidates = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(`${root}/Notes/`));
    const byId = new Map<string, string>();
    for (const file of candidates) { const fm = frontmatter(await this.app.vault.read(file)); const id = text(fm["node-id"]); if (id) byId.set(id, file.path); }
    for (const node of map.nodes) if (!(this.app.vault.getAbstractFileByPath(node.path) instanceof TFile) && byId.has(node.id)) node.path = byId.get(node.id)!;
    await this.moveExact(sourcePath, target); await this.saveMap(target, map);
    for (const node of map.nodes) if (this.app.vault.getAbstractFileByPath(node.path) instanceof TFile) await this.setLifecycle(node.path, map.id, map.id, "active");
    await this.rebuildDerivedData(); return target;
  }

  async assignedNotePaths(exceptMapId?: string): Promise<Set<string>> {
    const assigned = new Set<string>();
    for (const file of await this.mapFiles()) {
      const map = await this.readMap(file.path);
      if (map.id === exceptMapId) continue;
      for (const node of map.nodes) assigned.add(node.path);
    }
    return assigned;
  }

  async collectionFiles(mapPath: string, collection: TopicCollection): Promise<TFile[]> {
    const prefix = `${this.topicFolder(mapPath, collection)}/`;
    return this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(prefix) && marker(this.app.metadataCache.getFileCache(file)?.frontmatter?.["agent-map-node"])).sort((a, b) => a.basename.localeCompare(b.basename));
  }

  async inboxFiles(): Promise<TFile[]> {
    const prefix = `${this.settings.inboxFolder}/`;
    return this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(prefix) && marker(this.app.metadataCache.getFileCache(file)?.frontmatter?.["agent-map-node"])).sort((a, b) => a.basename.localeCompare(b.basename));
  }

  async moveUnique(path: string, folder: string): Promise<string> {
    await this.folder(folder);
    const file = this.file(path), desired = normalizePath(`${folder}/${baseName(path)}`);
    const target = this.app.vault.getAbstractFileByPath(desired) ? this.unique(folder, file.basename) : desired;
    await this.app.fileManager.renameFile(file, target);
    await this.replaceSourcePath(path, target);
    return target;
  }

  async moveExact(path: string, target: string): Promise<void> {
    await this.folder(parentPath(target));
    if (this.app.vault.getAbstractFileByPath(target)) throw new Error(`${this.message("目標檔案已存在", "Target file already exists")}: ${target}`);
    await this.app.fileManager.renameFile(this.file(path), target);
    await this.replaceSourcePath(path, target);
  }

  async renameNote(path: string, title: string, exactTarget?: string): Promise<string> {
    await this.updateNote(path, { title });
    const folder = parentPath(path), desired = exactTarget ?? normalizePath(`${folder}/${safeName(title)}.md`);
    if (desired === path) return path;
    const target = exactTarget ?? (this.app.vault.getAbstractFileByPath(desired) ? this.unique(folder, title) : desired);
    await this.app.fileManager.renameFile(this.file(path), target);
    await this.replaceSourcePath(path, target);
    return target;
  }

  async replaceSourcePath(oldPath: string, newPath: string): Promise<void> {
    for (const file of this.app.vault.getMarkdownFiles()) {
      const note = await this.readNoteIfManaged(file);
      if (!note?.sourcePaths.includes(oldPath)) continue;
      await this.updateNote(file.path, { sourcePaths: note.sourcePaths.map(path => path === oldPath ? newPath : path) });
    }
  }

  private async readNoteIfManaged(file: TFile): Promise<Note | null> {
    const content = await this.app.vault.read(file), fm = frontmatter(content);
    return marker(fm["agent-map-node"]) ? this.readNote(file.path) : null;
  }

  async normalizeGeneratedNoteFilenames(): Promise<number> {
    let renamed = 0;
    for (const mapFile of await this.mapFiles()) {
      const map = await this.readMap(mapFile.path); let changed = false;
      for (const node of map.nodes) {
        const file = this.app.vault.getAbstractFileByPath(node.path);
        if (!(file instanceof TFile) || !/^新的子議題(?: \d+)*$/.test(file.basename)) continue;
        const note = await this.readNote(node.path);
        if (!note.title.trim() || safeName(note.title) === file.basename) continue;
        const oldPath = node.path, newPath = await this.renameNote(oldPath, note.title);
        node.path = newPath; changed = true; renamed++;
        await this.replaceSourcePath(oldPath, newPath);
      }
      if (changed) await this.saveMap(mapFile.path, map);
    }
    for (const file of [...this.app.vault.getMarkdownFiles()]) {
      if (!/^新的子議題(?: \d+)*$/.test(file.basename)) continue;
      const note = await this.readNoteIfManaged(file); if (!note || !note.title.trim() || safeName(note.title) === file.basename) continue;
      const oldPath = file.path, newPath = await this.renameNote(oldPath, note.title);
      await this.replaceSourcePath(oldPath, newPath); renamed++;
    }
    if (renamed) await this.rebuildDerivedData();
    return renamed;
  }

  async setLifecycle(path: string, topicId: string, mapId: string, state: TopicState): Promise<void> {
    await this.updateNote(path, { topicId, mapId, topicState: state });
  }

  async rebuildDerivedData(): Promise<void> {
    const ownership = new Map<string, { map: MapDocument; mapPath: string; node: MapNode }>();
    const topics = new Map<string, { map: MapDocument; mapPath: string }>();
    for (const mapFile of await this.mapFiles()) {
      const map = await this.readMap(mapFile.path); topics.set(map.id, { map, mapPath: mapFile.path });
      for (const node of map.nodes) {
        const existing = ownership.get(node.path);
        if (existing && existing.map.id !== map.id) throw new Error(`${this.message("議題筆記同時出現在兩張心智圖", "A topic note appears in two mind maps")}: ${node.path}`);
        ownership.set(node.path, { map, mapPath: mapFile.path, node });
      }
    }

    for (const file of this.app.vault.getMarkdownFiles()) {
      const content = await this.app.vault.read(file), fm = frontmatter(content);
      if (!marker(fm["agent-map-node"])) continue;
      ensureNoteCssClass(fm);
      fm.title = noteTitle(content, fm, file.basename);
      const owner = ownership.get(file.path);
      let state: TopicState = file.path.startsWith(`${this.settings.inboxFolder}/`) ? "inbox" : file.path.includes("/Archive/") ? "archived" : file.path.includes("/Unassigned/") ? "unassigned" : owner ? "active" : text(fm["topic-state"], "unassigned") as TopicState;
      if (owner) {
        fm["agent-map-id"] = owner.map.id; fm["topic-id"] = owner.map.id; fm["topic-state"] = "active"; state = "active";
        if (fm["model-source"] === undefined) fm["model-source"] = owner.node.parentId ? "inherited" : "workspace";
      } else {
        delete fm["agent-map-id"];
        if (state === "inbox") { delete fm["topic-id"]; fm["topic-state"] = "inbox"; }
        else fm["topic-state"] = state;
      }
      let body = ensurePreview(content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ""), this.settings.language);
      if (isPlaceholder(text(fm.summary))) fm.summary = placeholder(this.settings.language);
      const topicId = text(fm["topic-id"]), topic = topics.get(topicId);
      if (owner) {
        if (!body.includes(DETAIL_START)) body = replaceSection(body, "Detail", section(body, "Detail"));
        const parent = owner.node.parentId ? owner.map.nodes.find(item => item.id === owner.node.parentId) : undefined;
        const children = owner.map.nodes.filter(item => item.parentId === owner.node.id);
        fm["agent-map-references"] = this.settings.language === "en" ? [
          `Topic: [[${noteLink(owner.mapPath)}|${owner.map.title}]]`,
          `Mind map: [[${noteLink(owner.mapPath)}]]`,
          parent ? `Parent topic: [[${noteLink(parent.path)}]]` : "Parent topic: None",
          children.length ? `Child topics: ${children.map(child => `[[${noteLink(child.path)}]]`).join(", ")}` : "Child topics: None"
        ] : [
          `所屬主題：[[${noteLink(owner.mapPath)}|${owner.map.title}]]`,
          `所屬心智圖：[[${noteLink(owner.mapPath)}]]`,
          parent ? `母議題：[[${noteLink(parent.path)}]]` : "母議題：無",
          children.length ? `子議題：${children.map(child => `[[${noteLink(child.path)}]]`).join("、")}` : "子議題：無"
        ];
        body = withoutReference(body);
      } else if (topic && (state === "unassigned" || state === "archived")) {
        fm["agent-map-references"] = this.settings.language === "en"
          ? [`Topic: [[${noteLink(topic.mapPath)}|${topic.map.title}]]`, `Status: ${state === "archived" ? "Archived" : "Unassigned"}`]
          : [`所屬主題：[[${noteLink(topic.mapPath)}|${topic.map.title}]]`, `狀態：${state === "archived" ? "已封存" : "未歸類"}`];
        body = withoutReference(body);
      } else { delete fm["agent-map-references"]; body = withoutReference(body); }
      body = normalizeBodyOrder(body, text(fm.title, file.basename), text(fm.summary, placeholder(this.settings.language)), this.settings.language);
      const next = `---\n${stringifyYaml(fm)}---\n${withReferenceLinks(body, fm, this.settings.language)}`;
      if (next !== content) await this.app.vault.process(file, () => next);
    }
  }

  async ensureNodePresentation(): Promise<void> {
    for (const file of this.app.vault.getMarkdownFiles()) {
      const content = await this.app.vault.read(file), fm = frontmatter(content);
      if (!marker(fm["agent-map-node"]) || !ensureNoteCssClass(fm)) continue;
      const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
      await this.app.vault.process(file, () => `---\n${stringifyYaml(fm)}---\n${body}`);
    }
  }

  async createMap(title: string, nodes: MapNode[] = []): Promise<string> {
    await this.folder(this.settings.topicsFolder);
    const root = this.uniqueFolder(this.settings.topicsFolder, title);
    await this.ensureTopicFolders(root);
    const path = `${root}/Map.md`;
    const map: MapDocument = { version: 1, id: crypto.randomUUID(), title, nodes, viewport: { x: 40, y: 40, zoom: 1 } };
    await this.app.vault.create(path, serializeMap(map, this.settings.language));
    return path;
  }

  async legacyMigrationPlan(): Promise<LegacyMigrationPlan> {
    const allMaps = await this.mapFiles();
    const legacyMaps = allMaps.filter(file => !file.path.startsWith(`${this.settings.topicsFolder}/`));
    const assigned = new Set<string>(), maps: LegacyMigrationPlan["maps"] = [];
    const reservedRoots = new Set<string>();
    for (const file of legacyMaps) {
      const map = await this.readMap(file.path); for (const node of map.nodes) assigned.add(node.path);
      let targetRoot = normalizePath(`${this.settings.topicsFolder}/${safeName(map.title)}`), number = 2;
      const base = targetRoot;
      while (this.app.vault.getAbstractFileByPath(targetRoot) || reservedRoots.has(targetRoot)) targetRoot = `${base} ${number++}`;
      reservedRoots.add(targetRoot); maps.push({ oldPath: file.path, title: map.title, targetRoot, notePaths: map.nodes.map(node => node.path) });
    }
    const orphanPaths: string[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = frontmatter(await this.app.vault.read(file));
      if (marker(fm["agent-map-node"]) && !assigned.has(file.path) && !file.path.startsWith(`${this.settings.topicsFolder}/`) && !file.path.startsWith(`${this.settings.inboxFolder}/`)) orphanPaths.push(file.path);
    }
    return { maps, orphanPaths };
  }

  async migrateLegacyWorkspace(plan: LegacyMigrationPlan): Promise<Map<string, string>> {
    const originals = new Map<string, string>(), moves: { from: string; to: string }[] = [], mapPaths = new Map<string, string>();
    const remember = async (path: string): Promise<void> => { if (!originals.has(path)) originals.set(path, await this.app.vault.read(this.file(path))); };
    try {
      await this.folder(this.settings.inboxFolder);
      for (const item of plan.maps) {
        await this.ensureTopicFolders(item.targetRoot);
        await remember(item.oldPath);
        const map = await this.readMap(item.oldPath), mapTarget = `${item.targetRoot}/Map.md`;
        await this.moveExact(item.oldPath, mapTarget); moves.push({ from: item.oldPath, to: mapTarget }); mapPaths.set(item.oldPath, mapTarget);
        for (const node of map.nodes) {
          await remember(node.path);
          const old = node.path, next = await this.moveUnique(old, `${item.targetRoot}/Notes`);
          moves.push({ from: old, to: next }); node.path = next;
          await this.setLifecycle(next, map.id, map.id, "active");
        }
        await this.saveMap(mapTarget, map);
      }
      for (const path of plan.orphanPaths) {
        await remember(path); const next = await this.moveUnique(path, this.settings.inboxFolder);
        moves.push({ from: path, to: next }); await this.setLifecycle(next, "", "", "inbox");
      }
      await this.rebuildDerivedData();
      return mapPaths;
    } catch (error) {
      for (const move of [...moves].reverse()) {
        const current = this.app.vault.getAbstractFileByPath(move.to);
        if (current instanceof TFile && !this.app.vault.getAbstractFileByPath(move.from)) await this.app.fileManager.renameFile(current, move.from);
      }
      for (const [path, content] of originals) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) await this.app.vault.process(file, () => content);
      }
      throw error;
    }
  }

  async renameTopic(mapPath: string, title: string, targetRoot?: string): Promise<string> {
    const file = this.file(mapPath), root = file.parent;
    if (!(root instanceof TFolder) || !mapPath.startsWith(`${this.settings.topicsFolder}/`)) throw new Error(this.message("舊版心智圖請先執行資料整理。", "Migrate the legacy mind map first."));
    const desired = targetRoot ? normalizePath(targetRoot) : normalizePath(`${this.settings.topicsFolder}/${safeName(title)}`);
    if (desired !== root.path && this.app.vault.getAbstractFileByPath(desired)) throw new Error(this.message("同名主題資料夾已存在。", "A topic folder with this name already exists."));
    const originalRoot = root.path;
    if (desired !== originalRoot) await this.app.fileManager.renameFile(root, desired);
    const next = `${desired}/Map.md`, map = await this.readMap(next); map.title = title;
    for (const node of map.nodes) if (node.path.startsWith(`${originalRoot}/`)) node.path = `${desired}/${node.path.slice(originalRoot.length + 1)}`;
    await this.saveMap(next, map); await this.rebuildDerivedData();
    return next;
  }

  async migrate(): Promise<void> { /* v0.2 import remains intentionally disabled; v0.3 legacy data uses the preview migration. */ }
}
