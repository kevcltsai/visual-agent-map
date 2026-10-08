export type CoffeeInsightCategory = "connections" | "questions" | "disagreements" | "directions" | "assumptions" | "solutions";

export interface CoffeeInsight {
  id: string;
  /** Internal parse state; explicit IDs survive summary edits, legacy IDs are derived. */
  persistedId?: boolean;
  category: CoffeeInsightCategory;
  summary: string;
  detail: string;
  question?: string;
  proposedSolution?: string;
  limitations?: string;
  sources: string[];
  mergedIds: string[];
}

const TITLES: Record<string, Record<CoffeeInsightCategory, string>> = {
  "zh-TW": {
    connections: "意外連結", questions: "值得繼續想的問題", disagreements: "核心分歧", directions: "探索方向", assumptions: "值得查證的假設", solutions: "疑問與可能解方",
  },
  en: {
    connections: "Unexpected connections", questions: "Questions worth pursuing", disagreements: "Core disagreements", directions: "Directions to explore", assumptions: "Assumptions to verify", solutions: "Questions and possible solutions",
  },
};
const CATEGORY_ALIASES: Record<string, CoffeeInsightCategory> = {
  "意外連結": "connections", "值得繼續想的問題": "questions", "核心分歧": "disagreements", "探索方向": "directions", "值得查證的假設": "assumptions", "疑問與可能解方": "solutions",
  "最大討論轉折": "connections", "最新轉折": "connections", "被推翻或修正的假設": "assumptions", "修正過的假設": "assumptions", "修正後的假設": "assumptions", "值得繼續追問的問題": "questions", "尚未解決的核心分歧": "disagreements",
  "unexpected connections": "connections", "questions worth pursuing": "questions", "core disagreements": "disagreements", "directions to explore": "directions", "assumptions to verify": "assumptions", "questions and possible solutions": "solutions",
  "main discussion shift": "connections", "latest shift": "connections", "revised assumptions": "assumptions", "assumptions challenged or revised": "assumptions", "questions to pursue": "questions", "unresolved core disagreements": "disagreements",
};
const MARKER = /<!--\s*coffee-insight:(v1:([^\s>]+)|(new|keep|update|merge)(?::([^\s>]+))?)\s*-->/i;
const ALL_MARKERS = /<!--\s*coffee-insight:(v1:([^\s>]+)|(new|keep|update|merge)(?::([^\s>]+))?)\s*-->/gi;
const SOURCE_MARKER = /<!--\s*source:\s*([\s\S]*?)\s*-->/gi;
const ROOT = /^# (?:觀察者整理|Observer(?:[’']s)? notes)\s*$/mi;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;

export function encodeInsightSource(source: string): string {
  return source.replace(/&/g, "&amp;").replace(/\r/g, "&#13;").replace(/\n/g, "&#10;").replace(/-->/g, "—>");
}

function decodeInsightSource(source: string): string {
  return source.replace(/&#13;/g, "\r").replace(/&#10;/g, "\n").replace(/&amp;/g, "&");
}

function newId(): string { return crypto.randomUUID(); }
function legacyId(category: CoffeeInsightCategory, summary: string, salt = 0): string {
  const value = `${category}:${normalize(summary)}:${salt}`;
  let left = 0x811c9dc5, right = 0x9e3779b9;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `legacy-${(left >>> 0).toString(36)}-${(right >>> 0).toString(36)}`;
}
function normalize(value: string): string { return value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]/gu, ""); }
function differsOnlyByChineseParticle(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) !== 1 || Math.min(left.length, right.length) < 12) return false;
  const longer = left.length > right.length ? left : right, shorter = left.length > right.length ? right : left;
  const particles = new Set(["的", "地", "得", "了", "著", "着"]);
  for (let index = 0; index < longer.length; index++) {
    const removed = longer.slice(0, index) + longer.slice(index + 1);
    if (removed === shorter && particles.has(longer[index])) return true;
  }
  return false;
}
function sameOrMissing(left?: string, right?: string): boolean {
  const a = normalize(left ?? ""), b = normalize(right ?? "");
  return a === b;
}
function nearDuplicate(left: CoffeeInsight, right: CoffeeInsight): boolean {
  const leftSummary = normalize(left.summary), rightSummary = normalize(right.summary);
  return left.category === right.category && (leftSummary === rightSummary || differsOnlyByChineseParticle(leftSummary, rightSummary)) &&
    sameOrMissing(left.detail, right.detail) && sameOrMissing(left.question, right.question) &&
    sameOrMissing(left.proposedSolution, right.proposedSolution) && sameOrMissing(left.limitations, right.limitations);
}
function unique(values: string[]): string[] { return [...new Set(values.map(value => value.trim()).filter(Boolean))]; }
function exactSourceSetMatch(left: string[], right: string[]): boolean {
  const a = unique(left), b = unique(right);
  return a.length > 0 && a.length === b.length && a.every(source => b.includes(source));
}
function categoryTitle(category: CoffeeInsightCategory, language: "zh-TW" | "en"): string { return TITLES[language][category]; }
function splitInsightText(value: string): { summary: string; metadata: string[]; sources: string[] } {
  const sources = [...value.matchAll(SOURCE_MARKER)].map(match => decodeInsightSource(match[1].trim())).filter(Boolean);
  const metadata = [...value.matchAll(ALL_MARKERS)].map(match => match[0]);
  return {
    summary: value.replace(SOURCE_MARKER, "").replace(MARKER, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^[-*+]\s+/, "").replace(/^\*\*(.*)\*\*$/, "$1").trim(),
    metadata,
    sources,
  };
}

function parseOne(markdown: string): CoffeeInsight[] {
  const root = ROOT.exec(markdown);
  const body = root ? markdown.slice(root.index + root[0].length) : markdown;
  const lines = body.split(/\r?\n/);
  let category: CoffeeInsightCategory | undefined;
  let current: CoffeeInsight | undefined;
  let legacyInsightHeader = false;
  let legacyGrouped = false;
  let pendingNew = false;
  let pendingSources: string[] = [];
  let fence: { marker: string; width: number } | undefined;
  const items: CoffeeInsight[] = [];
  const flush = (): void => { if (current?.summary && category) items.push({ ...current, category }); current = undefined; legacyInsightHeader = false; };
  for (const line of lines) {
    if (fence) {
      if (new RegExp(`^\\s*${fence.marker}{${fence.width},}\\s*$`).test(line)) fence = undefined;
      continue;
    }
    const fenceStart = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceStart) { fence = { marker: fenceStart[1][0], width: fenceStart[1].length }; continue; }
    const heading = /^(?:\*\*##\s+(.+?)\*\*|##\s+(.+?)\s*)$/.exec(line.trim());
    if (heading) {
      flush();
      category = CATEGORY_ALIASES[(heading[1] ?? heading[2]).trim().replace(/^\*\*|\*\*$/g, "").toLocaleLowerCase()];
      legacyGrouped = false;
      pendingNew = false;
      pendingSources = [];
      continue;
    }
    const list = /^\s{0,3}[-*+]\s+(.+?)\s*$/.exec(line);
    if (!list) {
      const markers = [...line.matchAll(ALL_MARKERS)];
      const sourceMarkers = [...line.matchAll(SOURCE_MARKER)];
      const withoutMetadata = line.replace(ALL_MARKERS, "").replace(SOURCE_MARKER, "").trim();
      if (!withoutMetadata && (markers.length || sourceMarkers.length)) {
        if (markers.some(match => match[3]?.toLocaleLowerCase() === "new")) pendingNew = true;
        const values = sourceMarkers.map(match => decodeInsightSource(match[1].trim()));
        if (current && !pendingNew) current.sources = unique([...current.sources, ...values]);
        else pendingSources = unique([...pendingSources, ...values]);
        continue;
      }
    }
    if (list && !/^\s{2,}/.test(line) && (legacyGrouped || !category)) {
      if (legacyGrouped) { flush(); category = undefined; }
      const header = splitInsightText(list[1]).summary.replace(/^\*\*|\*\*$/g, "").trim().toLocaleLowerCase();
      const mapped = CATEGORY_ALIASES[header];
      if (mapped) {
        flush(); category = mapped; legacyGrouped = true; legacyInsightHeader = true; current = { id: newId(), category, summary: "", detail: "", sources: [], mergedIds: [] };
        continue;
      }
    }
    if (!category) continue;
    if (list) {
      const isDetail = /^\s{2,}/.test(line);
      if (isDetail && current) {
        const value = splitInsightText(list[1]);
        if (legacyInsightHeader && !current.summary) { current.summary = value.summary; current.sources = unique([...current.sources, ...value.sources]); legacyInsightHeader = false; continue; }
        const labeled = /^(脈絡|來賓的理由|脈絡與分歧|Context|Reasoning|原疑問|疑問|Question|可能解方|Possible solution|條件與限制|限制|Conditions and limits)[：:]\s*(.*)$/i.exec(value.summary);
        if (labeled) {
          const label = labeled[1].toLocaleLowerCase(), body = labeled[2].trim();
          if (["原疑問", "疑問", "question"].includes(label)) current.question = [current.question, body].filter(Boolean).join("\n");
          else if (["可能解方", "possible solution"].includes(label)) current.proposedSolution = [current.proposedSolution, body].filter(Boolean).join("\n");
          else if (["條件與限制", "限制", "conditions and limits"].includes(label)) current.limitations = [current.limitations, body].filter(Boolean).join("\n");
          else current.detail = [current.detail, body].filter(Boolean).join("\n");
        } else current.detail = [current.detail, value.summary].filter(Boolean).join("\n");
        current.sources = unique([...current.sources, ...value.sources]);
        continue;
      }
      flush();
      const value = splitInsightText(list[1]);
      const tag = value.metadata.map((metadata) => MARKER.exec(metadata)).find(Boolean);
      const marker = tag?.[0] ? MARKER.exec(tag[0]) : undefined;
      const persisted = marker?.[2]?.split(";") ?? [];
      const idField = persisted.find(part => part.startsWith("id="))?.slice(3);
      const mergedField = persisted.find(part => part.startsWith("merged="))?.slice(7);
      current = {
        id: idField && ID_PATTERN.test(idField) ? idField : newId(),
        persistedId: !!(idField && ID_PATTERN.test(idField)),
        category,
        summary: value.summary,
        detail: "",
        sources: unique([...pendingSources, ...value.sources]),
        mergedIds: unique(mergedField?.split(",") ?? []).filter(id => ID_PATTERN.test(id)),
      };
      const action = marker?.[3]?.toLocaleLowerCase() ?? (pendingNew ? "new" : undefined);
      pendingNew = false;
      pendingSources = [];
      if (action === "new" || action === "keep" || action === "update" || action === "merge") {
        if (action === "new") (current as CoffeeInsight & { action?: string }).action = "new";
        else {
          const targets = (marker?.[4] ?? "").split(",").map(id => id.trim());
          if (!targets.length || targets.some(id => !ID_PATTERN.test(id))) throw new Error("Invalid observer insight reference");
          if (action === "keep" && targets.length !== 1) throw new Error("Invalid observer insight keep reference");
          if (action === "update" && targets.length !== 1) throw new Error("Invalid observer insight update reference");
          if (action === "merge" && targets.length < 2) throw new Error("Invalid observer insight merge reference");
          current.mergedIds = targets;
          (current as CoffeeInsight & { action?: string }).action = action;
        }
      }
      continue;
    }
    const startsNewParagraph = !!(category && pendingNew && !list && line.trim());
    if (startsNewParagraph) flush();
    if (current) {
      const sourceLine = [...line.matchAll(SOURCE_MARKER)].map(match => decodeInsightSource(match[1].trim()));
      if (sourceLine.length) current.sources = unique([...current.sources, ...sourceLine]);
      const detail = line.replace(MARKER, "").replace(SOURCE_MARKER, "").trim();
      if (detail && !detail.startsWith("<!--")) {
        const text = detail.replace(/^>\s?/, ""), labeled = /^(脈絡|來賓的理由|脈絡與分歧|Context|Reasoning|原疑問|疑問|Question|可能解方|Possible solution|條件與限制|限制|Conditions and limits)[：:]\s*(.*)$/i.exec(text);
        if (!labeled) current.detail = [current.detail, text].filter(Boolean).join("\n");
        else {
          const label = labeled[1].toLocaleLowerCase(), value = labeled[2].trim();
          if (["原疑問", "疑問", "question"].includes(label)) current.question = [current.question, value].filter(Boolean).join("\n");
          else if (["可能解方", "possible solution"].includes(label)) current.proposedSolution = [current.proposedSolution, value].filter(Boolean).join("\n");
          else if (["條件與限制", "限制", "conditions and limits"].includes(label)) current.limitations = [current.limitations, value].filter(Boolean).join("\n");
          else current.detail = [current.detail, value].filter(Boolean).join("\n");
        }
      }
    } else if (category && line.trim()) {
      const value = splitInsightText(line.trim());
      const summary = value.summary.replace(/^>\s?/, "").trim();
      if (summary) {
        const sentence = summary.match(/^.{1,180}?(?:[。！？.!?](?=\s|$)|$)/u)?.[0]?.trim() || summary.slice(0, 180);
        current = { id: newId(), category, summary: sentence, detail: summary === sentence ? "" : summary, sources: unique([...pendingSources, ...value.sources]), mergedIds: [] };
        if (startsNewParagraph) (current as CoffeeInsight & { action?: string }).action = "new";
        pendingNew = false;
        pendingSources = [];
      }
    }
  }
  flush();
  return items;
}

export function baselineFromVersions(versions: string[], language: "zh-TW" | "en"): CoffeeInsight[] {
  const result: CoffeeInsight[] = [];
  const byId = new Map<string, CoffeeInsight>();
  for (const version of versions) {
    let parsed = parseOne(version);
    if (!parsed.length) {
      const root = ROOT.exec(version), body = (root ? version.slice(root.index + root[0].length) : version).replace(/<!--[\s\S]*?-->/g, "").trim();
      if (body) {
        const summary = body.replace(/^#+\s*/gm, "").replace(/\s+/g, " ").slice(0, 180).trim();
        parsed = [{ id: newId(), category: "questions", summary, detail: body, sources: [], mergedIds: [] }];
      }
    }
    for (const insight of parsed) {
    if (!insight.summary) continue;
    const previous = (insight.persistedId ? byId.get(insight.id) : undefined) ?? result.find(item =>
      item.category === insight.category && normalize(item.summary) === normalize(insight.summary) &&
      (!item.sources.length || !insight.sources.length || exactSourceSetMatch(item.sources, insight.sources)));
    if (previous) {
      previous.sources = unique([...previous.sources, ...insight.sources]);
      previous.detail = [previous.detail, insight.detail].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join("\n");
      previous.question = unique([previous.question ?? "", insight.question ?? ""]).join("\n") || undefined;
      previous.proposedSolution = unique([previous.proposedSolution ?? "", insight.proposedSolution ?? ""]).join("\n") || undefined;
      previous.limitations = unique([previous.limitations ?? "", insight.limitations ?? ""]).join("\n") || undefined;
      previous.mergedIds = unique([...previous.mergedIds, ...(insight.id !== previous.id ? [insight.id] : []), ...insight.mergedIds]).filter(id => id !== previous.id);
      continue;
    }
    if (!insight.persistedId) {
      const existingIds = new Set(result.flatMap(item => [item.id, ...item.mergedIds]));
      let salt = 0;
      while (existingIds.has(legacyId(insight.category, insight.summary, salt))) salt++;
      insight.id = legacyId(insight.category, insight.summary, salt);
    }
    byId.set(insight.id, insight);
    result.push(insight);
    }
  }
  void language;
  return result;
}

export function mergeInsightUpdates(current: CoffeeInsight[], generated: string, language: "zh-TW" | "en"): CoffeeInsight[] {
  const baseline = current.map(item => ({ ...item, sources: [...item.sources], mergedIds: [...item.mergedIds] }));
  const parsed = parseOne(generated);
  const proposed = parsed.length ? parsed : baselineFromVersions([generated], language);
  if (!proposed.length) throw new Error("Observer insights are missing readable items");
  const active = [...baseline];
  const lookup = new Map<string, CoffeeInsight>();
  for (const insight of active) for (const id of [insight.id, ...insight.mergedIds]) {
    if (lookup.has(id) && lookup.get(id) !== insight) throw new Error("Duplicate observer insight reference");
    lookup.set(id, insight);
  }
  const seenTargets = new Set<string>();
  for (const item of proposed) {
    const action = (item as CoffeeInsight & { action?: string }).action;
    if (!action || action === "new") {
      const duplicate = active.find(existing => nearDuplicate(existing, item) &&
        (!existing.sources.length || !item.sources.length || exactSourceSetMatch(existing.sources, item.sources)));
      if (duplicate) {
        duplicate.sources = unique([...duplicate.sources, ...item.sources]);
        continue;
      }
      item.persistedId = true;
      active.push(item);
      lookup.set(item.id, item);
      continue;
    }
    let targets = item.mergedIds.map(id => lookup.get(id));
    // A model can mistype a stable ID on an unchanged `keep` item. Recover only
    // when its category and complete, exact source set identify one baseline
    // item. Keep the strict unknown-reference failure for updates, merges,
    // source-less items, and ambiguous source sets; never drop the reference.
    if (action === "keep" && targets.length === 1 && !targets[0] && item.sources.length) {
      const matches = baseline.filter(candidate => candidate.category === item.category && exactSourceSetMatch(candidate.sources, item.sources));
      if (matches.length === 1) {
        item.mergedIds = [matches[0].id];
        targets = matches;
      }
    }
    if (targets.some(target => !target)) throw new Error("Observer insight references an unknown item");
    if (item.mergedIds.some(id => seenTargets.has(id))) throw new Error("Observer insight reference is used more than once");
    item.mergedIds.forEach(id => seenTargets.add(id));
    if (action === "keep") continue;
    const first = targets[0]!;
    const priorText = targets.slice(1).map(target => target!.detail || target!.summary);
    const revised: CoffeeInsight = {
      ...item,
      id: first.id,
      persistedId: true,
      summary: item.summary || first.summary,
      detail: unique([first.detail, ...priorText, item.detail]).join("\n"),
      question: unique(targets.map(target => target!.question ?? "").concat(item.question ?? "")).join("\n"),
      proposedSolution: unique(targets.map(target => target!.proposedSolution ?? "").concat(item.proposedSolution ?? "")).join("\n"),
      limitations: unique(targets.map(target => target!.limitations ?? "").concat(item.limitations ?? "")).join("\n"),
      sources: unique(targets.flatMap(target => target!.sources).concat(item.sources)),
      mergedIds: unique([...targets.slice(1).map(target => target!.id), ...targets.flatMap(target => target!.mergedIds)]),
    };
    for (const target of targets.slice(1)) {
      const index = active.indexOf(target!);
      if (index >= 0) active.splice(index, 1);
    }
    const index = active.indexOf(first);
    if (index < 0) throw new Error("Observer insight target is no longer active");
    active[index] = revised;
    for (const id of [revised.id, ...revised.mergedIds]) lookup.set(id, revised);
  }
  return active;
}

export function serializeInsightNotes(insights: CoffeeInsight[], language: "zh-TW" | "en", preservedBlocks: ReadonlyMap<string, string> = new Map()): string {
  const root = language === "zh-TW" ? "觀察者整理" : "Observer’s notes";
  const lines = [`# ${root}`, ""];
  const order: CoffeeInsightCategory[] = ["connections", "questions", "disagreements", "directions", "assumptions", "solutions"];
  for (const category of order) {
    const entries = insights.filter(insight => insight.category === category);
    if (category === "solutions" && !entries.length) continue;
    lines.push(`## ${categoryTitle(category, language)}`, "");
    for (const item of entries) {
      const preserved = preservedBlocks.get(item.id);
      if (preserved !== undefined) { lines.push(preserved); continue; }
      const merged = item.mergedIds.length ? `;merged=${unique(item.mergedIds).join(",")}` : "";
      const sources = unique(item.sources).map(source => ` <!-- source: ${encodeInsightSource(source)} -->`).join("");
      lines.push(`- ${item.summary} <!-- coffee-insight:v1:id=${item.id}${merged} -->${sources}`);
      if (item.detail) lines.push(`  - ${language === "zh-TW" ? "脈絡" : "Context"}：${item.detail.split(/\r?\n/).join(" ")}`);
      if (category === "solutions") {
        for (const [label, value] of language === "zh-TW"
          ? [["原疑問", item.question], ["可能解方", item.proposedSolution], ["條件與限制", item.limitations]]
          : [["Question", item.question], ["Possible solution", item.proposedSolution], ["Conditions and limits", item.limitations]]) {
          if (value) lines.push(`  - ${label}：${value}`);
        }
      }
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function parseInsightNotes(markdown: string, language: "zh-TW" | "en"): CoffeeInsight[] {
  void language;
  return parseOne(markdown);
}
