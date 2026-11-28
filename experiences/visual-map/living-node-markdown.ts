import { createHash } from "node:crypto";
import { allowedUrl } from "../../core/argument-map/source-proof";
import { isPlaceholder } from "../../core/note-placeholder";
import { frontmatter, setFrontmatterKeys } from "../../core/repository-frontmatter";
import {
  CANONICAL_HEADINGS,
  canonicalHeadings,
  localizeHeadings,
  noteHeadingSet,
  replaceSummarySection,
  section
} from "../../core/repository-note-body";
import { readAiCard, readAiLocked } from "../../note-values";
import {
  applyLivingChanges,
  LIVING_LAST_CHANGE_KEY,
  livingEventTombstone,
  livingLastChangeValue,
  livingDeletedTextHash,
  livingSuppressionV2,
  livingSuppressionV2Entry,
  livingSuppressionV2Forms,
  parseLivingEventTombstone,
  parseLivingSuppressionV2,
  summarizeLivingChanges,
  type LivingAiLatest,
  type LivingChangeContext,
  type LivingEvidence,
  type LivingKnowledge,
  type LivingRecord
} from "./living-node-changes";
import { livingModelView } from "./living-node-retrieval";
import { canCommitLivingCandidate, type LivingCandidateIdentity, type LivingCommitCheck } from "./living-node-state";

import {
  hasLivingCommitMetadata,
  LIVING_GENERATION_KEY,
  LIVING_RECEIPTS_KEY,
  livingFenceAfterCommit,
  readLivingFence,
  LIVING_NODE_BEGIN as BEGIN,
  LIVING_NODE_END as END,
  livingNoteWithoutManaged
} from "../../core/living-node-region";
const HASH_KEY = "living-node-region-hash";
const OWNERSHIP_KEY = "living-node-ownership";
const COMMIT_KEY = "living-node-last-execution";
/** Note-file heading of the AI result slot: English and stable, like every other heading. The UI label is localized. */
const AI_LATEST = "### AI latest";

export const livingSnapshotRevision = (content: string): string => createHash("sha256").update(content).digest("hex");

interface Region {
  start: number;
  end: number;
  text: string;
}

/** Missing or modified ownership markers fail closed. Existing legacy prose is never inferred to be AI-owned. */
function readRegion(content: string, hash: unknown, hasOwnership = false): Region | undefined {
  const start = content.indexOf(BEGIN);
  const end = content.indexOf(END);
  if (start < 0 && end < 0 && (hash === undefined || hasOwnership)) return undefined;
  if (
    start < 0 ||
    end < start ||
    content.indexOf(BEGIN, start + BEGIN.length) >= 0 ||
    content.indexOf(END, end + END.length) >= 0 ||
    typeof hash !== "string"
  )
    throw new Error("unknown-ownership");
  const text = content.slice(start, end + END.length);
  if (livingSnapshotRevision(text) !== hash && !hasOwnership) throw new Error("edited-or-deleted-knowledge");
  return { start, end: end + END.length, text };
}

function quote(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(line => "> " + line)
    .join("\n");
}

function unquote(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

const encoded = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");
const field = (name: string, value: string | null): string => `- ${name}: ${encoded(value)}`;

function sourceLines(entries: readonly LivingEvidence[]): string[] {
  return entries.map(entry => `- Source: ${encoded([entry.id, entry.source, entry.retrievedAt])}`);
}

/** A single readable, reversible Markdown representation. No second copy of claims in a hidden index. */
function renderRegion(knowledge: LivingKnowledge): string {
  const lines = [
    BEGIN,
    "",
    "## Living Node",
    "",
    "### Current output",
    field("Ownership", knowledge.output.owner),
    "",
    quote(knowledge.output.text),
    "",
    "#### Evidence",
    ...sourceLines(knowledge.output.evidence)
  ];
  // Only written once the AI has a separate result, so a V1 region stays byte-identical. Older builds cannot read this
  // section and fail closed on the whole region, leaving the bytes untouched.
  if (knowledge.aiLatest) {
    lines.push(
      "",
      AI_LATEST,
      field("Ownership", knowledge.aiLatest.owner),
      field("Generated", knowledge.aiLatest.at),
      "",
      // An emptied section (heading kept) hands the slot back to the AI and has no quote line.
      ...(knowledge.aiLatest.text ? [quote(knowledge.aiLatest.text)] : []),
      "",
      "#### Evidence",
      ...sourceLines(knowledge.aiLatest.evidence)
    );
  }
  for (const record of knowledge.records) {
    lines.push(
      "",
      "### Observation",
      field("ID", record.id),
      field("Subject", record.subject),
      field("Scope", record.scope),
      field("Granularity", record.granularity),
      field("Event time", record.eventTime),
      field("Validity", record.validity),
      field("Ownership", record.owner),
      "",
      quote(record.claim),
      "",
      "#### Evidence",
      ...sourceLines(record.evidence)
    );
    for (const history of record.history) {
      lines.push(
        "",
        "#### History",
        field("Time", history.at),
        field("Reason", history.reason),
        "",
        quote(history.claim),
        "",
        "##### Previous evidence",
        ...sourceLines(history.previousEvidence),
        "##### Evidence",
        ...sourceLines(history.evidence)
      );
    }
  }
  lines.push("", "### Suppression");
  for (const id of knowledge.suppressed) lines.push(field(parseLivingSuppressionV2(id) ? "Suppression v2" : "ID", id));
  lines.push("", END);
  return lines.join("\n");
}

/** Decode only the exact format emitted by this version; unknown/corrupt data remains user-owned. */
function decodeRegion(region: Region, revision: string): LivingKnowledge {
  const lines = region.text.split("\n");
  let at = 0;
  const fail = (): never => {
    throw new Error("invalid-managed-region");
  };
  const expect = (line: string): void => {
    if (lines[at++] !== line) fail();
  };
  const readField = (name: string): unknown => {
    const prefix = `- ${name}: `;
    const line = lines[at++];
    if (!line?.startsWith(prefix)) return fail();
    const value: unknown = JSON.parse(line.slice(prefix.length));
    return value;
  };
  const text = (value: unknown): string => (typeof value === "string" ? value : fail());
  const owner = (): "ai" | "user" => {
    const value = readField("Ownership");
    return value === "ai" || value === "user" ? value : fail();
  };
  const prose = (): string => {
    const result: string[] = [];
    while (lines[at]?.startsWith("> ")) result.push(unquote(lines[at++].slice(2)));
    if (!result.length) fail();
    return result.join("\n");
  };
  const evidence = (): LivingEvidence[] => {
    const result: LivingEvidence[] = [];
    const ids = new Set<string>();
    while (lines[at]?.startsWith("- Source: ")) {
      const raw = readField("Source");
      if (!Array.isArray(raw) || raw.length !== 3) return fail();
      const entry = { id: text(raw[0]), source: text(raw[1]), retrievedAt: text(raw[2]) };
      if (!entry.id || ids.has(entry.id)) fail();
      ids.add(entry.id);
      result.push(entry);
    }
    return result;
  };
  expect(BEGIN);
  expect("");
  expect("## Living Node");
  expect("");
  expect("### Current output");
  const outputOwner = owner();
  expect("");
  const outputText = prose();
  expect("");
  expect("#### Evidence");
  const output = { text: outputText, owner: outputOwner, evidence: evidence() };
  let aiLatest: LivingAiLatest | undefined;
  if (lines[at] === "" && lines[at + 1] === AI_LATEST) {
    expect("");
    expect(AI_LATEST);
    const latestOwner = owner();
    const generated = text(readField("Generated"));
    expect("");
    // The owner may clear the text; a bare ">" or "> " line left behind counts as empty.
    const quoted: string[] = [];
    while (lines[at] !== undefined && /^>( |$)/.test(lines[at])) quoted.push(unquote(lines[at++].slice(2)));
    const latestText = quoted.every(line => !line.trim()) ? "" : quoted.join("\n");
    expect("");
    expect("#### Evidence");
    aiLatest = { text: latestText, owner: latestOwner, at: generated, evidence: evidence() };
  }
  const records: LivingRecord[] = [];
  const ids = new Set<string>();
  while (lines[at] === "" && lines[at + 1] === "### Observation") {
    expect("");
    expect("### Observation");
    const id = text(readField("ID"));
    if (!id || ids.has(id)) fail();
    ids.add(id);
    const subject = text(readField("Subject"));
    const scope = text(readField("Scope"));
    const granularity = text(readField("Granularity"));
    const time = readField("Event time");
    const eventTime = time === null ? null : text(time);
    const validity = readField("Validity");
    if (validity !== "active" && validity !== "disputed" && validity !== "invalidated") return fail();
    const recordOwner = owner();
    expect("");
    const claim = prose();
    expect("");
    expect("#### Evidence");
    const sources = evidence();
    const history: LivingRecord["history"][number][] = [];
    while (lines[at] === "" && lines[at + 1] === "#### History") {
      expect("");
      expect("#### History");
      const time = text(readField("Time"));
      const reason = text(readField("Reason"));
      expect("");
      const oldClaim = prose();
      expect("");
      expect("##### Previous evidence");
      const previousEvidence = evidence();
      expect("##### Evidence");
      history.push({ at: time, reason, claim: oldClaim, previousEvidence, evidence: evidence() });
    }
    records.push({
      id,
      subject,
      scope,
      granularity,
      eventTime,
      validity,
      owner: recordOwner,
      claim,
      evidence: sources,
      history
    });
  }
  expect("");
  expect("### Suppression");
  const suppressed: string[] = [];
  while (lines[at]?.startsWith("- ID: ") || lines[at]?.startsWith("- Suppression v2: ")) {
    const v2 = lines[at].startsWith("- Suppression v2: ");
    const id = text(readField(v2 ? "Suppression v2" : "ID"));
    if (!id || ids.has(id) || !!parseLivingSuppressionV2(id) !== v2) fail();
    ids.add(id);
    suppressed.push(id);
  }
  expect("");
  expect(END);
  const result = { revision, records, output, suppressed, ...(aiLatest ? { aiLatest } : {}) };
  // A cleared AI latest may keep a bare quote marker; that is the only text accepted in place of the exact rendering.
  const exact = aiLatest?.text
    ? region.text
    : region.text.replace(/(\n- Generated: [^\n]*\n\n)>[ \t]*\n(\n#### Evidence)/, "$1$2");
  if (at !== lines.length || renderRegion(result) !== exact) fail();
  return result;
}

/** The note keeps the English heading; a view shows the localized label. User text is quoted, so it never matches. */
const relabel = (markdown: string, label: string): string => markdown.replace(/^### AI latest$/m, () => "### " + label);

/** Only the heading inside the managed region is relabeled; the same line elsewhere in the note is the owner's. */
export function localizeAiLatestHeading(markdown: string, label: string): string {
  const start = markdown.indexOf(BEGIN);
  const end = markdown.indexOf(END);
  if (start < 0 || end < start) return markdown;
  return markdown.slice(0, start) + relabel(markdown.slice(start, end), label) + markdown.slice(end);
}

export interface LivingReaderLabels {
  aiLatest: string;
  /** A source line: `link` is a ready Markdown link or plain title. */
  source(title: string, date: string): string;
  generated(at: string): string;
  /** A readable date for an ISO time (`time`: with the clock). Absent: the raw text is kept. */
  date?(iso: string, time: boolean): string;
}

/** An ISO time as a short date in the reader's language; text that is not a date is returned unchanged. */
export function readableDate(iso: string, locale: string, time: boolean, timeZone?: string): string {
  const at = new Date(iso);
  if (!/^\d{4}-\d\d-\d\d/.test(iso) || Number.isNaN(at.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      ...(time ? { timeStyle: "short" as const } : {}),
      ...(timeZone ? { timeZone } : {})
    }).format(at);
  } catch {
    return iso;
  }
}

const escapeMarkdown = (value: string): string => value.replace(/[\\[\]<>*_`|]/g, match => "\\" + match);

function readableSource(raw: string, labels: LivingReaderLabels): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3 || parsed.some(item => typeof item !== "string")) return undefined;
  const [, source, retrievedAt] = parsed as string[];
  const url = allowedUrl(source);
  const title = url ? url.hostname.replace(/^www\./, "") : source;
  const link = url ? `[${escapeMarkdown(title)}](<${url.toString()}>)` : escapeMarkdown(title);
  const day = /^\d{4}-\d\d-\d\d/.test(retrievedAt) ? retrievedAt : "";
  return labels.source(link, day ? (labels.date?.(retrievedAt, false) ?? retrievedAt.slice(0, 10)) : retrievedAt);
}

/** An Observation header as written (Ownership is dropped first): the internal fields are not for the reader. */
const OBSERVATION_HEAD =
  /^### Observation\r?\n- ID: ".*"\r?\n- Subject: (".*")\r?\n- Scope: ".*"\r?\n- Granularity: ".*"\r?\n- Event time: (".*"|null)\r?\n- Validity: ".*"(?:\r?\n|$)/gm;

/**
 * What the reader shows: the AI latest heading and its generated time in the interface language, and each evidence source
 * as "title (date)" (a link when it is a public web page). The note file itself is not changed. Inside a note only the
 * managed region is touched; a trial preview (`whole`) is generated text from its first line.
 */
export function localizeLivingReader(markdown: string, labels: LivingReaderLabels, whole = false): string {
  const start = markdown.indexOf(BEGIN);
  const end = markdown.indexOf(END);
  if (!whole && (start < 0 || end < start)) return markdown;
  const [from, to] = whole ? [0, markdown.length] : [start, end];
  const region = relabel(markdown.slice(from, to), labels.aiLatest)
    .replace(/^- Ownership: ".*"\r?\n/gm, "")
    .replace(OBSERVATION_HEAD, (line, subject: string, eventTime: string) => {
      try {
        const name: unknown = JSON.parse(subject);
        const at: unknown = JSON.parse(eventTime);
        if (typeof name !== "string" || (at !== null && typeof at !== "string")) return line;
        return `### ${escapeMarkdown(name)}\n` + (at ? `- ${labels.date?.(at, false) ?? at}\n` : "");
      } catch {
        return line;
      }
    })
    .replace(/^- (Time|Reason): (".*")$/gm, (line, name: string, raw: string) => {
      try {
        const text: unknown = JSON.parse(raw);
        if (typeof text !== "string") return line;
        return "- " + (name === "Time" ? (labels.date?.(text, true) ?? text) : escapeMarkdown(text));
      } catch {
        return line;
      }
    })
    .replace(/(^|\n)### Suppression\r?\n(?:- (?:ID|Suppression v2): ".*"(?:\r?\n|$))*/g, "$1")
    .replace(/^- Source: (\[.*\])$/gm, (line, raw: string) => "- " + (readableSource(raw, labels) ?? line.slice(2)))
    .replace(/^- Generated: (".*")$/gm, (line, raw: string) => {
      try {
        const at: unknown = JSON.parse(raw);
        return typeof at === "string" ? "- " + labels.generated(labels.date?.(at, true) ?? at) : line;
      } catch {
        return line;
      }
    });
  return markdown.slice(0, from) + region + markdown.slice(to);
}

export function renderLivingPreview(knowledge: LivingKnowledge, aiLatestLabel?: string): string {
  const text = renderRegion(knowledge).slice(BEGIN.length, -END.length).trim();
  return aiLatestLabel ? relabel(text, aiLatestLabel) : text;
}

/** Share committed knowledge and verified public evidence only. No internal IDs,
 * local source paths, signed/query-bearing URLs, ownership or suppression data. */
export function renderLivingShareKnowledge(knowledge: LivingKnowledge): string {
  const sections: string[] = [];
  const publicEvidence = (evidence: readonly LivingEvidence[]): string[] => [
    ...new Set(
      evidence.flatMap(entry => {
        const url = allowedUrl(entry.source);
        if (!url || url.search || url.hash || entry.id !== "web:" + livingSnapshotRevision(url.toString())) return [];
        return [url.toString()];
      })
    )
  ];
  const append = (text: string, evidence: readonly LivingEvidence[]): void => {
    if (text.trim()) sections.push(quote([text, ...publicEvidence(evidence)].join("\n")));
  };
  append(knowledge.output.text, knowledge.output.evidence);
  if (knowledge.aiLatest) append(knowledge.aiLatest.text, knowledge.aiLatest.evidence);
  for (const record of knowledge.records) {
    append(
      [record.eventTime, record.claim, record.validity !== "active" ? record.validity : ""].filter(Boolean).join("\n"),
      record.evidence
    );
    for (const item of record.history)
      append([item.at, item.claim, item.reason].join("\n"), [...item.previousEvidence, ...item.evidence]);
  }
  return sections.join("\n\n");
}

const emptyKnowledge = (): LivingKnowledge => ({
  revision: "empty",
  records: [],
  suppressed: [],
  output: { text: "", owner: "ai", evidence: [] }
});

function recordHash(record: LivingRecord): string {
  return livingSnapshotRevision(renderRegion({ ...emptyKnowledge(), records: [record] }));
}

function outputHash(output: LivingKnowledge["output"]): string {
  return livingSnapshotRevision(renderRegion({ ...emptyKnowledge(), output }));
}

function aiLatestHash(aiLatest: LivingAiLatest): string {
  return livingSnapshotRevision(renderRegion({ ...emptyKnowledge(), aiLatest }));
}

interface OwnershipIndex {
  output: string;
  aiLatest?: { hash: string; text: string };
  aiLatestDeleted?: string;
  records: Map<string, string>;
  events: Map<string, { fingerprint: string; scope?: string; unknownTime?: boolean }>;
  /** Suppression v2 entry (as stored string) for records written by this version. */
  v2: Map<string, string>;
  suppressed: Set<string>;
}

/** Only IDs and hashes are retained; deleted user text is never kept in a shadow store. */
function ownership(knowledge: LivingKnowledge): string[] {
  return [
    JSON.stringify(["output", outputHash(knowledge.output)]),
    ...(knowledge.aiLatest
      ? [JSON.stringify(["aiLatest", aiLatestHash(knowledge.aiLatest), livingDeletedTextHash(knowledge.aiLatest.text)])]
      : knowledge.aiLatestDeleted
        ? [JSON.stringify(["aiLatestDeleted", knowledge.aiLatestDeleted])]
        : []),
    ...knowledge.records.map(record =>
      JSON.stringify(["record", record.id, recordHash(record), livingSuppressionV2Entry(livingSuppressionV2(record))])
    ),
    ...knowledge.suppressed.map(id => JSON.stringify(["suppressed", id]))
  ];
}

function readOwnership(raw: unknown): OwnershipIndex | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error("invalid-ownership-index");
  const index: OwnershipIndex = {
    output: "",
    records: new Map(),
    events: new Map(),
    v2: new Map(),
    suppressed: new Set()
  };
  const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  for (const line of raw as unknown[]) {
    if (typeof line !== "string") throw new Error("invalid-ownership-index");
    const value: unknown = JSON.parse(line);
    if (!Array.isArray(value)) throw new Error("invalid-ownership-index");
    if (value[0] === "output" && value.length === 2 && validHash(value[1]) && !index.output) {
      index.output = value[1];
    } else if (
      value[0] === "aiLatest" &&
      value.length === 3 &&
      validHash(value[1]) &&
      validHash(value[2]) &&
      !index.aiLatest
    ) {
      index.aiLatest = { hash: value[1], text: value[2] };
    } else if (value[0] === "aiLatestDeleted" && value.length === 2 && validHash(value[1]) && !index.aiLatestDeleted) {
      index.aiLatestDeleted = value[1];
    } else if (
      value[0] === "record" &&
      (value.length === 3 ||
        (value.length === 4 && (validHash(value[3]) || typeof value[3] === "string")) ||
        (value.length === 6 && validHash(value[3]) && validHash(value[4]) && typeof value[5] === "boolean")) &&
      typeof value[1] === "string" &&
      validHash(value[2]) &&
      !index.records.has(value[1])
    ) {
      index.records.set(value[1], value[2]);
      if (value.length === 4 && typeof value[3] === "string" && !validHash(value[3])) {
        if (!parseLivingSuppressionV2(value[3])) throw new Error("invalid-ownership-index");
        index.v2.set(value[1], value[3]);
      } else if (validHash(value[3])) {
        const scope = value[4] as unknown;
        const unknownTime = value[5] as unknown;
        index.events.set(value[1], {
          fingerprint: value[3],
          ...(validHash(scope) && typeof unknownTime === "boolean" ? { scope, unknownTime } : {})
        });
      }
    } else if (value[0] === "suppressed" && value.length === 2 && typeof value[1] === "string") {
      index.suppressed.add(value[1]);
    } else throw new Error("invalid-ownership-index");
  }
  if (!index.output) throw new Error("invalid-ownership-index");
  return index;
}

/** Reconcile only recognizable complete records; an unparseable region fails closed, byte for byte. */
function reconcileOwnership(current: LivingKnowledge, index: OwnershipIndex): LivingKnowledge {
  const suppressed = new Set([...current.suppressed, ...index.suppressed]);
  const stored = new Set(suppressed);
  const ids = new Set(current.records.map(record => record.id));
  for (const id of index.records.keys()) {
    if (ids.has(id)) continue;
    suppressed.add(id);
    const v2 = index.v2.get(id);
    if (v2) suppressed.add(v2);
    const event = index.events.get(id);
    if (event) suppressed.add(livingEventTombstone(id, event.fingerprint, event.scope, event.unknownTime));
  }
  const records = current.records.map(record => {
    const forms = livingSuppressionV2Forms(record);
    const held = forms.some(form => stored.has(form));
    // Only an id the ownership index does not know (typed or pasted back by the user) lifts a hold. A known id whose
    // text changed just becomes user-owned below and never lifts one, so an edited AI sibling cannot free a deleted
    // event. A hold created by this very read never lifts either.
    const added = !index.records.has(record.id);
    if (added && held) for (const form of forms) suppressed.delete(form);
    if (suppressed.has(record.id) || (added && held)) {
      // An explicit human re-add of the record is protected and releases its id-only and v1 holds too.
      suppressed.delete(record.id);
      for (const value of suppressed) {
        if (parseLivingEventTombstone(value)?.recordId === record.id) suppressed.delete(value);
      }
      return { ...record, owner: "user" as const };
    }
    return index.records.get(record.id) === recordHash(record) ? record : { ...record, owner: "user" as const };
  });
  const output =
    index.output === outputHash(current.output) ? current.output : { ...current.output, owner: "user" as const };
  // An AI result the index does not vouch for (typed in, or edited) is user text and is never overwritten. A cleared
  // section (heading kept, no text) goes back to the AI.
  const aiLatest = !current.aiLatest
    ? undefined
    : !current.aiLatest.text.trim()
      ? { ...current.aiLatest, owner: "ai" as const }
      : index.aiLatest?.hash !== aiLatestHash(current.aiLatest)
        ? { ...current.aiLatest, owner: "user" as const }
        : current.aiLatest;
  // A section the index knows but the region no longer has was deleted by the owner: remember only its text hash.
  const aiLatestDeleted = aiLatest ? undefined : (index.aiLatest?.text ?? index.aiLatestDeleted);
  const next = {
    ...current,
    records,
    output,
    suppressed: [...suppressed],
    ...(aiLatest ? { aiLatest } : {}),
    ...(aiLatestDeleted ? { aiLatestDeleted } : {})
  };
  return { ...next, revision: livingSnapshotRevision(renderRegion(next)) };
}

function readLivingData(content: string) {
  const fm = frontmatter(content);
  const index = readOwnership(fm[OWNERSHIP_KEY]);
  const region = readRegion(content, fm[HASH_KEY], !!index);
  // A previous formal commit with neither its region nor its ownership index
  // is not a fresh/legacy card. Lost ownership cannot be reconstructed from
  // diagnostics, so refuse automatic integration rather than resurrecting data.
  if (!region && !index && hasLivingCommitMetadata(fm)) throw new Error("unknown-ownership");
  readLivingFence(fm);
  const current = region ? decodeRegion(region, livingSnapshotRevision(region.text)) : emptyKnowledge();
  if (!index) return { region, knowledge: current };
  if (!region) {
    const deleted = { ...current, output: { ...current.output, owner: "user" as const } };
    return { region, knowledge: reconcileOwnership(deleted, index) };
  }
  return { region, knowledge: reconcileOwnership(current, index) };
}

/** Reading never migrates or rewrites the legacy body. Recognizable manual edits become user-owned. */
export function readLivingMarkdown(content: string): LivingKnowledge {
  return readLivingData(content).knowledge;
}

/**
 * The only form of a note that may reach a provider when it might be a Living Node note read as ordinary text: the
 * managed region becomes the card's model view (revision, records, output, AI latest) and every `living-node-*`
 * frontmatter key (ownership index, hashes) is dropped, so suppression holds and deletion hashes never leave the vault.
 * A torn or unreadable region is cut out entirely. A note with neither region nor metadata is returned unchanged.
 */
export function livingNoteForModel(content: string): string {
  const stripped = livingNoteWithoutManaged(content);
  if (stripped === content) return content;
  let view = "";
  try {
    view = JSON.stringify(livingModelView(readLivingMarkdown(content)));
  } catch {
    return stripped;
  }
  const start = content.indexOf(BEGIN);
  const end = content.indexOf(END, Math.max(start, 0));
  if (start < 0 || end < 0) return stripped;
  // The view sits where the region was; the shared helper then drops the metadata and any leftover marker.
  return livingNoteWithoutManaged(content.slice(0, start) + view + content.slice(end + END.length));
}

/**
 * Why a Living Node note cannot be read. "rebuildable": the managed region still decodes exactly, only its hash, ownership
 * index or replay metadata is missing or inconsistent. "unrecoverable": the region is missing, torn or not in this
 * version's format. Null when the note reads normally. Reading never writes either way.
 */
export function livingDamageKind(content: string): "rebuildable" | "unrecoverable" | null {
  try {
    readLivingData(content);
    return null;
  } catch {
    const start = content.indexOf(BEGIN);
    const end = content.indexOf(END);
    if (start < 0 || end < start || content.indexOf(BEGIN, start + 1) >= 0 || content.indexOf(END, end + 1) >= 0)
      return "unrecoverable";
    try {
      const text = content.slice(start, end + END.length);
      decodeRegion({ start, end: end + END.length, text }, livingSnapshotRevision(text));
      return "rebuildable";
    } catch {
      return "unrecoverable";
    }
  }
}

/**
 * Undo/redo: the knowledge and ownership snapshot of `target` is restored under a NEW generation, and the receipts of
 * `current` are kept, so a late callback built before the undo can neither match the generation nor repeat an execution.
 */
export function livingRestoreSnapshot(current: string, target: string): string {
  const fence = readLivingFence(frontmatter(current));
  return setFrontmatterKeys(target, {
    [LIVING_GENERATION_KEY]: fence.generation + 1,
    [LIVING_RECEIPTS_KEY]: fence.receipts
  });
}

/** The note with the two replay-fence keys removed: the content an undo/redo guard compares, since every restore moves the fence. */
export const livingWithoutFence = (content: string): string =>
  setFrontmatterKeys(content, { [LIVING_GENERATION_KEY]: null, [LIVING_RECEIPTS_KEY]: null });

/** Replay-fence generation stored in the note (0 for a note written before the fence existed). */
export const livingGeneration = (content: string): number => readLivingFence(frontmatter(content)).generation;

/**
 * The latest summary (frontmatter `summary` and `## Current Summary`) follows the knowledge output of a commit. A summary the
 * user wrote (neither empty, the placeholder, nor the output this commit replaces) is theirs and stays as it is.
 */
function withLatestSummary(content: string, previous: string, latest: string): string {
  const headings = noteHeadingSet(content) ?? CANONICAL_HEADINGS;
  const canonical = canonicalHeadings(content, headings);
  const hasSection = /^## Current Summary[ \t]*\r?$/m.test(canonical);
  const owned = frontmatter(content).summary;
  const current = (hasSection ? section(canonical, "Current Summary") : typeof owned === "string" ? owned : "").trim();
  if (current && !isPlaceholder(current) && current !== previous.trim()) return content;
  // A note without the section (not written by VAM) is not given one: its body stays as it is, only the frontmatter summary follows.
  if (!hasSection) return setFrontmatterKeys(content, { summary: latest });
  // The section helper leaves no blank line before the next heading when the section grew; the note keeps its spacing.
  const body = replaceSummarySection(canonical, latest).replace(
    /(\n## Current Summary\r?\n\r?\n[\s\S]*?[^\n])\n(## )/,
    "$1\n\n$2"
  );
  return setFrontmatterKeys(localizeHeadings(body, headings), { summary: latest });
}

export interface LivingMarkdownPort {
  /** The existing Repository.updateNoteRawGuarded port; its transform runs inside vault.process. */
  updateNoteRawGuarded(
    path: string,
    transform: (content: string) => string,
    options: { expectedContent: string; authorize: () => boolean }
  ): Promise<"written" | "discarded">;
}

export interface LivingMarkdownCommit {
  path: string;
  expectedContent: string;
  candidate: LivingCandidateIdentity;
  base: LivingKnowledge;
  /** Replay-fence generation of the note the base was read from (livingGeneration of that content). */
  baseGeneration: number;
  proposal: unknown;
  context: LivingChangeContext;
  signal: AbortSignal;
  /** Re-read the actual read set and formal configuration immediately before entering the storage guard. */
  inspect(): Promise<LivingCommitCheck>;
  /** Shared execution lease and in-memory revision/identity fence, evaluated inside the write boundary. */
  isCurrent(): boolean;
  /** Called only after the guarded write has committed, with the exact bytes needed for conflict-safe undo. */
  onCommit?(path: string, before: string, after: string): void;
}

function validateNoteIdentity(content: string, candidate: LivingCandidateIdentity): Record<string, unknown> {
  const fm = frontmatter(content);
  if (
    !readAiCard(fm) ||
    readAiLocked(fm) ||
    fm["node-id"] !== candidate.cardId ||
    fm["topic-id"] !== candidate.mapId ||
    fm["agent-map-id"] !== candidate.mapId
  )
    throw new Error("target-unavailable");
  return fm;
}

/**
 * Commit one validated candidate through the existing guarded note transaction. This deliberately refuses unknown or edited
 * regions until a caller can reconcile per-record ownership. It is not the source resolver or the execution coordinator.
 */
export async function commitLivingMarkdown(port: LivingMarkdownPort, request: LivingMarkdownCommit) {
  const { candidate, context, expectedContent, signal } = request;
  if (signal.aborted || !request.isCurrent()) return "discarded";
  if (candidate.baseRevision !== livingSnapshotRevision(expectedContent)) throw new Error("stale-base");
  const fm = validateNoteIdentity(expectedContent, candidate);
  const fence = readLivingFence(fm);
  if (fence.receipts.includes(candidate.executionId)) return "discarded";
  const { region, knowledge: stored } = readLivingData(expectedContent);
  const matches = request.base.revision === stored.revision && renderRegion(request.base) === renderRegion(stored);
  if (!matches) throw new Error("base-mismatch");
  // The same knowledge under another generation means a commit, undo or redo happened since the base was read.
  if (request.baseGeneration !== fence.generation) throw new Error("stale-generation");
  const next = applyLivingChanges(stored, request.proposal, context);
  if (stored.revision === "empty" && !next.records.length && !next.output.text)
    throw new Error("missing-formal-result");
  const nextKnowledge = {
    ...stored,
    records: next.records,
    output: next.output,
    ...(next.aiLatest ? { aiLatest: next.aiLatest } : {}),
    ...(next.aiLatestDeleted ? { aiLatestDeleted: next.aiLatestDeleted } : {})
  };
  const managed = renderRegion(nextKnowledge);
  const changed = !region || region.text !== managed;
  const changes = summarizeLivingChanges(stored, nextKnowledge);
  const checked = await request.inspect();
  if (signal.aborted || !request.isCurrent() || !canCommitLivingCandidate(candidate, checked)) return "discarded";
  let committedContent: string | undefined;
  const outcome = await port.updateNoteRawGuarded(
    request.path,
    content => {
      const live = validateNoteIdentity(content, candidate);
      const liveFence = readLivingFence(live);
      if (liveFence.receipts.includes(candidate.executionId) || liveFence.generation !== fence.generation)
        return content;
      const replaced = changed
        ? region
          ? content.slice(0, region.start) + managed + content.slice(region.end)
          : content + (content.endsWith("\n") ? "\n" : "\n\n") + managed + "\n"
        : content;
      const withSummary =
        next.output.owner === "ai" && next.output.text.trim() && next.output.text !== stored.output.text
          ? withLatestSummary(replaced, stored.output.text, next.output.text)
          : replaced;
      committedContent = setFrontmatterKeys(withSummary, {
        [HASH_KEY]: livingSnapshotRevision(managed),
        [OWNERSHIP_KEY]: ownership(nextKnowledge),
        [COMMIT_KEY]: candidate.executionId,
        ...livingFenceAfterCommit(liveFence, candidate.executionId),
        "living-node-last-attempt": context.at,
        "living-node-last-successful-check": context.at,
        "living-node-outcome": "ok",
        "living-node-reason": null,
        "living-node-input-revision": candidate.inputRevision,
        "living-node-success-knowledge": livingSnapshotRevision(managed),
        // What this run observably checked on the web; cleared when it checked nothing, so it is never stale.
        "living-node-checked": context.checked?.length
          ? context.checked.map(item => item.at + " " + (item.url ?? "search: " + item.query))
          : null,
        ...(changed ? { "living-node-last-content-change": context.at } : {}),
        // Record ids and change kinds only, and only when there was a baseline to compare with; unchanged runs leave it alone.
        ...(changed && !changes.firstRun
          ? { [LIVING_LAST_CHANGE_KEY]: livingLastChangeValue(changes, context.at) }
          : {})
      });
      return committedContent;
    },
    {
      expectedContent,
      authorize: () => !signal.aborted && request.isCurrent()
    }
  );
  if (outcome === "written" && committedContent !== undefined) {
    try {
      request.onCommit?.(request.path, expectedContent, committedContent);
    } catch {
      // An already committed note remains authoritative even if its view history cannot refresh.
    }
  }
  return outcome;
}
