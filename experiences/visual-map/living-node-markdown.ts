import { createHash } from "node:crypto";
import { frontmatter, setFrontmatterKeys } from "../../core/repository-frontmatter";
import { readAiCard, readAiLocked } from "../../note-values";
import { applyLivingChanges, type LivingChangeContext, type LivingKnowledge } from "./living-node-changes";
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
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(line => "> " + line)
    .join("\n");
}

/** Render only validated domain values, never the raw model response or arbitrary replacement Markdown. */
function renderRegion(knowledge: LivingKnowledge): string {
  const lines = [BEGIN, "", "## Living Node", ""];
  if (knowledge.output.text) {
    lines.push("### Current output", "", quote(`Ownership: ${knowledge.output.owner}`), quote(knowledge.output.text), "");
  }
  const sourceLines = (entries: LivingKnowledge["output"]["evidence"]): string[] =>
    entries.map(entry => quote(`Source ${entry.id}: ${entry.source} (retrieved ${entry.retrievedAt})`));
  lines.push(...sourceLines(knowledge.output.evidence));
  for (const record of knowledge.records) {
    lines.push(
      "",
      "### Observation",
      "",
      quote(`ID: ${record.id}`),
      quote(`Subject: ${record.subject}`),
      quote(`Scope: ${record.scope}`),
      quote(`Granularity: ${record.granularity}`),
      quote(`Event time: ${record.eventTime ?? "unknown"}`),
      quote(`Validity: ${record.validity}`),
      quote(`Ownership: ${record.owner}`),
      "",
      quote(record.claim),
      ...sourceLines(record.evidence)
    );
    for (const history of record.history) {
      lines.push(
        "",
        quote(`History: ${history.at}`),
        quote(history.claim),
        quote(history.reason),
        ...sourceLines(history.previousEvidence),
        ...sourceLines(history.evidence)
      );
    }
  }
  for (const id of knowledge.suppressed) lines.push("", quote(`Suppressed record ID: ${id}`));
  lines.push("", END);
  return lines.join("\n");
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
    if (request.base.revision !== fm[HASH_KEY] || renderRegion(request.base) !== region.text)
      throw new Error("base-mismatch");
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
  const managed =
    region && !changed ? region.text : renderRegion({ ...request.base, records: next.records, output: next.output });
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
