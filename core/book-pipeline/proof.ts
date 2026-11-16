/**
 * The proofread verdict, decided by program, not by the model. The model returns one result per checklist item; this
 * module checks the list against the checklist, accepts a source only when this very call opened it (an openPage event),
 * downgrades an unsupported "met" on a fact item to "unverified", and applies the whole-card failure rules. It also keeps
 * the stored record (appended to the research notes under a dedupe key, reused when a run resumes). Pure: it never sees
 * or changes the card's body.
 */
import type { ChecklistItem } from "./plan-text";
import { hashText, singleLine } from "./text";

export const PROOF_STATUSES = ["met", "unmet", "unverified"] as const;
export type ProofStatus = (typeof PROOF_STATUSES)[number];

export interface RawProofItem {
  id: string;
  status: ProofStatus;
  note: string;
  sources: string[];
}
export interface ProofItemResult {
  id: string;
  type: ChecklistItem["type"];
  status: ProofStatus;
  note: string;
  /** Only URLs this call opened, as the event reported them. */
  sources: string[];
}
export interface ProofResult {
  items: ProofItemResult[];
  /** `needs-review` when any item is unmet; otherwise `checked` (unverified items are recorded, not blocking). */
  aggregate: "checked" | "needs-review";
}

export type ProofFailureCode =
  | "unparsable"
  | "empty_list"
  | "missing_item"
  | "duplicate_item"
  | "unknown_item"
  | "no_open_page"
  | "all_facts_unverified";
/** A whole-card failure (retry, three times, then needs-review). The message is the code only. */
export class ProofFailure extends Error {
  constructor(readonly code: ProofFailureCode) {
    super(code);
    this.name = "ProofFailure";
  }
}

/** By name, so it holds across module copies. */
export const isProofFailure = (error: unknown): error is ProofFailure =>
  !!error && typeof error === "object" && (error as { name?: unknown }).name === "ProofFailure";

const normalizeUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/#.*$/, "");
  const m = /^(https?:\/\/[^/?\s]+)(.*)$/i.exec(text);
  if (!m) return undefined;
  return `${m[1].toLowerCase()}${m[2].replace(/\/+$/, "")}`;
};

export function evaluateProof(
  raw: readonly RawProofItem[],
  checklist: readonly ChecklistItem[],
  openedUrls: readonly string[]
): ProofResult {
  if (!checklist.length) throw new ProofFailure("empty_list");
  const known = new Map(checklist.map(item => [item.id, item]));
  const seen = new Set<string>();
  for (const item of raw) {
    if (!known.has(item.id)) throw new ProofFailure("unknown_item");
    if (seen.has(item.id)) throw new ProofFailure("duplicate_item");
    seen.add(item.id);
  }
  if (checklist.some(item => !seen.has(item.id))) throw new ProofFailure("missing_item");
  const opened = new Map<string, string>();
  for (const url of openedUrls) {
    const key = normalizeUrl(url);
    if (key && !opened.has(key)) opened.set(key, url.trim());
  }
  if (!opened.size) throw new ProofFailure("no_open_page");
  const items: ProofItemResult[] = checklist.map(entry => {
    const item = raw.find(candidate => candidate.id === entry.id) as RawProofItem;
    const sources: string[] = [];
    for (const source of item.sources) {
      const key = normalizeUrl(source);
      const real = key ? opened.get(key) : undefined;
      if (real && !sources.includes(real)) sources.push(real);
    }
    const status: ProofStatus =
      item.status === "met" && entry.type === "fact" && !sources.length ? "unverified" : item.status;
    return { id: entry.id, type: entry.type, status, note: singleLine(item.note, 300), sources };
  });
  const facts = items.filter(item => item.type === "fact");
  if (facts.length && facts.every(item => item.status === "unverified")) throw new ProofFailure("all_facts_unverified");
  return { items, aggregate: items.some(item => item.status === "unmet") ? "needs-review" : "checked" };
}

export interface ProofKeyParts {
  runId: string;
  nodeId: string;
  revision: number;
  body: string;
  checklist: readonly ChecklistItem[];
}
/** `runId:card:revision:body hash:checklist hash`. */
export function proofKey(parts: ProofKeyParts): string {
  const list = hashText(JSON.stringify(parts.checklist.map(item => [item.id, item.type, item.text])));
  return `${parts.runId}:${parts.nodeId}:${parts.revision}:${hashText(parts.body)}:${list}`;
}

const RECORD = /^<!-- book-proof:v1 (\{.*\}) -->$/;
const escapeJson = (text: string): string => text.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
const STATUS_WORDS: Record<ProofStatus, string> = { met: "達成", unmet: "未達成", unverified: "待查" };

/** The lines appended to the research notes for one proof: readable plain lines (links as plain text) and one machine record. */
export function composeProofRecord(key: string, result: ProofResult): string {
  const lines = [`校對（${result.aggregate === "checked" ? "已校" : "需人看"}）`];
  for (const item of result.items)
    lines.push(
      `- ${item.id} ${STATUS_WORDS[item.status]}：${item.note.replace(/[<>]/g, "")}${item.sources.length ? `（${item.sources.join(" ")}）` : ""}`
    );
  lines.push(`<!-- book-proof:v1 ${escapeJson(JSON.stringify({ key, result }))} -->`);
  return lines.join("\n");
}

/** The stored result for `key` in a notes text, or undefined. */
export function findProofRecord(notes: string, key: string): ProofResult | undefined {
  for (const line of notes.split(/\r?\n/)) {
    const m = RECORD.exec(line.trim());
    if (!m) continue;
    try {
      const data = JSON.parse(m[1]) as { key?: unknown; result?: ProofResult };
      if (data.key === key && data.result && Array.isArray(data.result.items)) return data.result;
    } catch {
      // a damaged record is just not found
    }
  }
  return undefined;
}

/** Appends a proof once: the same key already stored leaves the text exactly as it is (`appended: false`). */
export function appendProofRecord(
  notes: string,
  key: string,
  result: ProofResult
): { text: string; appended: boolean } {
  if (findProofRecord(notes, key)) return { text: notes, appended: false };
  const entry = composeProofRecord(key, result);
  const base = notes.replace(/\s+$/, "");
  return { text: base ? `${base}\n\n${entry}\n` : `${entry}\n`, appended: true };
}
