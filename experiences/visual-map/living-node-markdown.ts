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

const BEGIN = "<!-- vam-living-node:begin v1 -->";
const END = "<!-- vam-living-node:end v1 -->";
const HASH_KEY = "living-node-region-hash";
const COMMIT_KEY = "living-node-last-execution";

export const livingSnapshotRevision = (content: string): string => createHash("sha256").update(content).digest("hex");

interface Region {
  start: number;
  end: number;
  text: string;
}

/** Missing or modified ownership markers fail closed. Existing legacy prose is never inferred to be AI-owned. */
function readRegion(content: string, hash: unknown): Region | undefined {
  const start = content.indexOf(BEGIN);
  const end = content.indexOf(END);
  if (start < 0 && end < 0 && hash === undefined) return undefined;
  if (
    start < 0 ||
    end < start ||
    content.indexOf(BEGIN, start + BEGIN.length) >= 0 ||
    content.indexOf(END, end + END.length) >= 0 ||
    typeof hash !== "string"
  )
    throw new Error("unknown-ownership");
  const text = content.slice(start, end + END.length);
  if (livingSnapshotRevision(text) !== hash) throw new Error("edited-or-deleted-knowledge");
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

/** Reading never migrates or rewrites the legacy body. An edited region is not silently reclaimed by AI. */
export function readLivingMarkdown(content: string): LivingKnowledge {
  const fm = frontmatter(content);
  const region = readRegion(content, fm[HASH_KEY]);
  return region
    ? decodeRegion(region, livingSnapshotRevision(region.text))
    : { revision: "empty", records: [], suppressed: [], output: { text: "", owner: "ai", evidence: [] } };
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
  const region = readRegion(expectedContent, fm[HASH_KEY]);
  if (region) {
    const stored = decodeRegion(region, livingSnapshotRevision(region.text));
    const matches = request.base.revision === stored.revision && renderRegion(request.base) === region.text;
    if (!matches) throw new Error("base-mismatch");
  } else if (
    request.base.revision !== "empty" ||
    request.base.output.owner !== "ai" ||
    request.base.records.length ||
    request.base.output.text ||
    request.base.output.evidence.length ||
    request.base.suppressed.length
  )
    throw new Error("unknown-ownership");
  const next = applyLivingChanges(request.base, request.proposal, context);
  if (!region && !next.records.length && !next.output.text) throw new Error("missing-formal-result");
  const changed = !region || next.changed;
  const nextKnowledge = { ...request.base, records: next.records, output: next.output };
  const managed = region && !changed ? region.text : renderRegion(nextKnowledge);
  const checked = await request.inspect();
  if (signal.aborted || !request.isCurrent() || !canCommitLivingCandidate(candidate, checked)) return "discarded";
  return port.updateNoteRawGuarded(
    request.path,
    content => {
      const live = validateNoteIdentity(content, candidate);
      if (live[COMMIT_KEY] === candidate.executionId) return content;
      const replaced = changed
        ? region
          ? content.slice(0, region.start) + managed + content.slice(region.end)
          : content + (content.endsWith("\n") ? "\n" : "\n\n") + managed + "\n"
        : content;
      return setFrontmatterKeys(replaced, {
        [HASH_KEY]: livingSnapshotRevision(managed),
        [COMMIT_KEY]: candidate.executionId,
        "living-node-last-attempt": context.at,
        "living-node-last-successful-check": context.at,
        "living-node-outcome": "ok",
        "living-node-input-revision": candidate.inputRevision,
        ...(changed ? { "living-node-last-content-change": context.at } : {})
      });
    },
    {
      expectedContent,
      authorize: () => !signal.aborted && request.isCurrent()
    }
  );
}
