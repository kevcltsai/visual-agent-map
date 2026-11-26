import { createHash } from "node:crypto";
import { frontmatter, setFrontmatterKeys } from "../../core/repository-frontmatter";
import { readAiCard, readAiLocked } from "../../note-values";
import {
  applyLivingChanges,
  type LivingChangeContext,
  type LivingEvidence,
  type LivingKnowledge,
  type LivingRecord
} from "./living-node-changes";
import { canCommitLivingCandidate, type LivingCandidateIdentity, type LivingCommitCheck } from "./living-node-state";

import { LIVING_NODE_BEGIN as BEGIN, LIVING_NODE_END as END } from "../../core/living-node-region";
const HASH_KEY = "living-node-region-hash";
const OWNERSHIP_KEY = "living-node-ownership";
const COMMIT_KEY = "living-node-last-execution";

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
  for (const id of knowledge.suppressed) lines.push(field("ID", id));
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
  while (lines[at]?.startsWith("- ID: ")) {
    const id = text(readField("ID"));
    if (!id || ids.has(id)) fail();
    ids.add(id);
    suppressed.push(id);
  }
  expect("");
  expect(END);
  const result = { revision, records, output, suppressed };
  if (at !== lines.length || renderRegion(result) !== region.text) fail();
  return result;
}

export function renderLivingPreview(knowledge: LivingKnowledge): string {
  return renderRegion(knowledge).slice(BEGIN.length, -END.length).trim();
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

interface OwnershipIndex {
  output: string;
  records: Map<string, string>;
  suppressed: Set<string>;
}

/** Only IDs and hashes are retained; deleted user text is never kept in a shadow store. */
function ownership(knowledge: LivingKnowledge): string[] {
  return [
    JSON.stringify(["output", outputHash(knowledge.output)]),
    ...knowledge.records.map(record => JSON.stringify(["record", record.id, recordHash(record)])),
    ...knowledge.suppressed.map(id => JSON.stringify(["suppressed", id]))
  ];
}

function readOwnership(raw: unknown): OwnershipIndex | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error("invalid-ownership-index");
  const index: OwnershipIndex = { output: "", records: new Map(), suppressed: new Set() };
  const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  for (const line of raw as unknown[]) {
    if (typeof line !== "string") throw new Error("invalid-ownership-index");
    const value: unknown = JSON.parse(line);
    if (!Array.isArray(value)) throw new Error("invalid-ownership-index");
    if (value[0] === "output" && value.length === 2 && validHash(value[1]) && !index.output) {
      index.output = value[1];
    } else if (
      value[0] === "record" &&
      value.length === 3 &&
      typeof value[1] === "string" &&
      validHash(value[2]) &&
      !index.records.has(value[1])
    ) {
      index.records.set(value[1], value[2]);
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
  const ids = new Set(current.records.map(record => record.id));
  for (const id of index.records.keys()) if (!ids.has(id)) suppressed.add(id);
  const records = current.records.map(record => {
    if (suppressed.has(record.id)) {
      // An explicit human re-add of the record is protected and releases its tombstone.
      suppressed.delete(record.id);
      return { ...record, owner: "user" as const };
    }
    return index.records.get(record.id) === recordHash(record)
      ? record
      : { ...record, owner: "user" as const };
  });
  const output =
    index.output === outputHash(current.output) ? current.output : { ...current.output, owner: "user" as const };
  const next = { ...current, records, output, suppressed: [...suppressed] };
  return { ...next, revision: livingSnapshotRevision(renderRegion(next)) };
}

function readLivingData(content: string) {
  const fm = frontmatter(content);
  const index = readOwnership(fm[OWNERSHIP_KEY]);
  const region = readRegion(content, fm[HASH_KEY], !!index);
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
    fm["topic-id"] !== candidate.cardId ||
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
  if (fm[COMMIT_KEY] === candidate.executionId) return "discarded";
  const { region, knowledge: stored } = readLivingData(expectedContent);
  const matches = request.base.revision === stored.revision && renderRegion(request.base) === renderRegion(stored);
  if (!matches) throw new Error("base-mismatch");
  const next = applyLivingChanges(stored, request.proposal, context);
  if (stored.revision === "empty" && !next.records.length && !next.output.text) throw new Error("missing-formal-result");
  const nextKnowledge = { ...stored, records: next.records, output: next.output };
  const managed = renderRegion(nextKnowledge);
  const changed = !region || region.text !== managed;
  const checked = await request.inspect();
  if (signal.aborted || !request.isCurrent() || !canCommitLivingCandidate(candidate, checked)) return "discarded";
  let committedContent: string | undefined;
  const outcome = await port.updateNoteRawGuarded(
    request.path,
    content => {
      const live = validateNoteIdentity(content, candidate);
      if (live[COMMIT_KEY] === candidate.executionId) return content;
      const replaced = changed
        ? region
          ? content.slice(0, region.start) + managed + content.slice(region.end)
          : content + (content.endsWith("\n") ? "\n" : "\n\n") + managed + "\n"
        : content;
      committedContent = setFrontmatterKeys(replaced, {
        [HASH_KEY]: livingSnapshotRevision(managed),
        [OWNERSHIP_KEY]: ownership(nextKnowledge),
        [COMMIT_KEY]: candidate.executionId,
        "living-node-last-attempt": context.at,
        "living-node-last-successful-check": context.at,
        "living-node-outcome": "ok",
        "living-node-input-revision": candidate.inputRevision,
        "living-node-success-knowledge": livingSnapshotRevision(managed),
        ...(changed ? { "living-node-last-content-change": context.at } : {})
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
