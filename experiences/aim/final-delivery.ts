import { createHash } from "node:crypto";
import { translateNote } from "../../i18n";
import type { AiResult, TaskContext } from "../../ai/types";
import type { AimContract } from "../../ai/aim-contracts";
import { renderOutlineTask } from "./steps/delivery-outline/step";
import { renderResearchTask, REUSED_RESEARCH_DETAIL } from "./steps/delivery-research/step";
import { renderWritingTask, NO_MAPPED_SOURCE } from "./steps/delivery-writing/step";
import { renderAcceptanceTask } from "./steps/delivery-acceptance/step";

export interface DeliverySection {
  heading: string;
  purpose: string;
  searchTask: string;
  evidenceIds?: string[];
  dependencies?: string[];
}
export interface DeliveryEvidence {
  id: string;
  hash: string;
  detail: string;
}
export interface DeliverySectionCheckpoint {
  fingerprint: string;
  evidenceIds: string[];
  result: AiResult;
}
/** Checkpoint key of the one written document; older per-section keys no longer match and are rewritten. */
const DOCUMENT_KEY = "document";
const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function parseDeliveryOutline(detail: string): DeliverySection[] {
  const marker = detail.match(/<!--\s*aim-delivery-outline\s+([\s\S]*?)\s*-->/);
  if (!marker) throw new Error("Final delivery outline is missing; no conclusion was saved.");
  const value: unknown = JSON.parse(marker[1]);
  const sections = value && typeof value === "object" && "sections" in value ? value.sections : undefined;
  if (!Array.isArray(sections) || !sections.length || sections.length > 12)
    throw new Error("Final delivery outline is invalid; no conclusion was saved.");
  const validated: DeliverySection[] = sections.map((section: unknown) => {
    if (
      !section ||
      typeof section !== "object" ||
      !("heading" in section) ||
      !("purpose" in section) ||
      !("searchTask" in section) ||
      typeof section.heading !== "string" ||
      !section.heading.trim() ||
      typeof section.purpose !== "string" ||
      !section.purpose.trim() ||
      typeof section.searchTask !== "string"
    )
      throw new Error("Final delivery outline is invalid; no conclusion was saved.");
    const mapping: { evidenceIds?: string[]; dependencies?: string[] } = {};
    for (const key of ["evidenceIds", "dependencies"] as const) {
      if (key in section) {
        // A malformed mapping is cleaned, not fatal: non-string or blank IDs and duplicates are dropped, and a value
        // that is not a list means no mapping (the section then uses all supplied evidence).
        const ids = (section as Record<string, unknown>)[key];
        if (!Array.isArray(ids)) continue;
        mapping[key] = [
          ...new Set(ids.filter((id): id is string => typeof id === "string" && !!id.trim()).map(id => id.trim()))
        ];
      }
    }
    return { heading: section.heading, purpose: section.purpose, searchTask: section.searchTask, ...mapping };
  });
  if (new Set(validated.map(section => section.heading.trim().toLowerCase())).size !== validated.length)
    throw new Error("Final delivery outline contains duplicate sections.");
  return validated;
}

export interface FinalDeliveryCheckpoint {
  outline?: AiResult;
  research?: AiResult;
  draft?: AiResult;
  acceptance?: AiResult;
  baseFingerprint?: string;
  sections?: Record<string, DeliverySectionCheckpoint>;
  draftFingerprint?: string;
  researchFingerprint?: string;
}

export type FinalDeliveryPhase = "delivery-outline" | "delivery-research" | "delivery-writing" | "delivery-acceptance";
const deliveryContracts: Partial<Record<FinalDeliveryPhase, AimContract>> = {
  "delivery-outline": { kind: "outline" },
  "delivery-research": { kind: "delivery-research" },
  "delivery-acceptance": { kind: "review", decisions: ["conclude", "research_more"] }
};

export interface FinalDeliveryOptions {
  onPhase?: (phase: FinalDeliveryPhase) => void | Promise<void>;
  timeoutMs?: number;
  /** Test-only: false runs the research phase without provider web search. Production leaves it unset. */
  webSearch?: boolean;
  checkpoint?: FinalDeliveryCheckpoint;
  /** Persisted source reports; hashes identify content changes, not verification. */
  evidence?: readonly DeliveryEvidence[];
  /** Earlier rounds' results: readable only when the outline maps a section to their id; never in the outline catalog. */
  lineageEvidence?: readonly DeliveryEvidence[];
  /** Goal, original background and answered conditions, excluding research reports. */
  knownConditions?: string;
  /** Unverified items the document lists for the user to confirm instead of blocking acceptance. */
  openItems?: string;
  /** Must finish saving the snapshot before the next model phase starts. */
  onCheckpoint?: (checkpoint: FinalDeliveryCheckpoint) => void | Promise<void>;
}

function validateContent(result: AiResult): void {
  if (
    typeof result.summary !== "string" ||
    !result.summary.trim() ||
    typeof result.detail !== "string" ||
    !result.detail.trim()
  )
    throw new Error("Final delivery stage returned empty content; no conclusion was saved.");
}

function parseAcceptance(result: AiResult): { marker: string; decision: "conclude" | "research_more" } {
  const acceptance = result.detail.match(/^\s*<!--\s*aim-review\s+(\{[^\n]*\})\s*-->/);
  if (!acceptance) throw new Error("Final delivery acceptance marker missing; no conclusion was saved.");
  const decision: unknown = JSON.parse(acceptance[1]);
  if (!decision || typeof decision !== "object" || !("decision" in decision))
    throw new Error("Invalid final delivery acceptance.");
  if (decision.decision === "conclude") {
    if (
      !("rationale" in decision) ||
      !("stopReason" in decision) ||
      typeof decision.rationale !== "string" ||
      !decision.rationale.trim() ||
      typeof decision.stopReason !== "string" ||
      !decision.stopReason.trim()
    )
      throw new Error("Final delivery acceptance is incomplete; no conclusion was saved.");
  } else if (decision.decision === "research_more") {
    const target =
      Array.isArray(result.suggestions) && result.suggestions.length === 1 ? result.suggestions[0] : undefined;
    if (
      !target ||
      [target.title, target.task, target.contribution].some(value => typeof value !== "string" || !value.trim())
    )
      throw new Error("Final delivery acceptance must identify one concrete evidence gap; no conclusion was saved.");
  } else throw new Error("Final delivery acceptance must conclude or identify an evidence gap.");
  return { marker: acceptance[0].trim(), decision: decision.decision };
}

/** A separate deliverable workflow: outline, search to fill it, write, then check coverage. */
export async function buildFinalDelivery(
  base: TaskContext,
  ask: (context: TaskContext) => Promise<AiResult>,
  options: FinalDeliveryOptions = {}
): Promise<{ result: AiResult; evidence: string; draft?: AiResult }> {
  const baseFingerprint = fingerprint({
    title: base.title,
    rules: base.rules,
    conditions: options.knownConditions ?? base.detail,
    language: base.outputLanguage
  });
  const savedBaseValid =
    options.checkpoint?.baseFingerprint === baseFingerprint ||
    (!options.checkpoint?.baseFingerprint && options.evidence === undefined);
  const savedCheckpoint = savedBaseValid ? options.checkpoint : undefined;
  // Preserve independently valid successes through outline/research persistence failures.
  // Each section is still fingerprint-validated before reuse.
  const checkpoint: FinalDeliveryCheckpoint = {
    baseFingerprint,
    ...(savedCheckpoint?.sections ? { sections: { ...savedCheckpoint.sections } } : {})
  };
  let reuseRemaining = true;
  const stage = async (
    key: "outline" | "research" | "draft" | "acceptance",
    produce: () => Promise<AiResult>,
    validate: (result: AiResult) => void = validateContent
  ): Promise<AiResult> => {
    base.signal?.throwIfAborted();
    // Only a contiguous chain of valid successes can be reused.
    const saved = reuseRemaining ? savedCheckpoint?.[key] : undefined;
    if (saved) {
      try {
        validateContent(saved);
        validate(saved);
        checkpoint[key] = saved;
        return saved;
      } catch {
        // A malformed saved stage must be regenerated before later stages run.
      }
    }
    reuseRemaining = false;
    const result = await produce();
    validateContent(result);
    validate(result);
    base.signal?.throwIfAborted();
    checkpoint[key] = result;
    await options.onCheckpoint?.({ ...checkpoint });
    base.signal?.throwIfAborted();
    return result;
  };
  const run = async (phase: FinalDeliveryPhase, task: string, research = false): Promise<AiResult> => {
    base.signal?.throwIfAborted();
    await options.onPhase?.(phase);
    base.signal?.throwIfAborted();
    const writingScope =
      phase === "delivery-writing" && options.evidence
        ? {
            detail: options.knownConditions ?? "",
            summary: "",
            workingFindings: "",
            sourceContext: "",
            referenceGroups: []
          }
        : {};
    const contract = deliveryContracts[phase];
    const result = await ask({
      ...base,
      ...writingScope,
      ...(phase === "delivery-acceptance" ? { responseContract: "aim-delivery-acceptance" as const } : {}),
      ...(contract ? { aimContract: contract } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      task: `<!-- aim-phase: ${phase} -->\n${task}`,
      ...(research ? { aimIsolatedResearch: true } : {}),
      researchMode: research && options.webSearch !== false ? "research" : "local",
      researchDepth: research ? "normal" : "fast",
      detailFormat: "adaptive"
    });
    base.signal?.throwIfAborted();
    validateContent(result);
    return result;
  };
  const sourceCatalog = (options.evidence ?? [])
    .map(source => `Source ID: ${source.id}\n${source.detail}`)
    .join("\n\n");
  const outlineResult = await stage(
    "outline",
    () => run("delivery-outline", renderOutlineTask(sourceCatalog)),
    result => {
      parseDeliveryOutline(result.detail);
    }
  );
  const sections = parseDeliveryOutline(outlineResult.detail);
  const outline = JSON.stringify(sections);
  const needsResearch = sections.some(section => section.searchTask.trim());
  const researchFingerprint = fingerprint(
    sections
      .filter(section => section.searchTask.trim())
      .map(section => {
        const ids = [...new Set([...(section.evidenceIds ?? []), ...(section.dependencies ?? [])])];
        const scoped =
          section.evidenceIds === undefined && section.dependencies === undefined
            ? (options.evidence ?? [])
            : (options.evidence ?? []).filter(source => ids.includes(source.id));
        return {
          heading: section.heading,
          searchTask: section.searchTask,
          sources: scoped.map(source => [source.id, source.hash])
        };
      })
  );
  if (
    needsResearch &&
    savedCheckpoint?.researchFingerprint &&
    savedCheckpoint.researchFingerprint !== researchFingerprint
  )
    reuseRemaining = false;
  checkpoint.researchFingerprint = researchFingerprint;
  const research = await stage(
    "research",
    async () =>
      needsResearch
        ? await run("delivery-research", renderResearchTask(outline), true)
        : {
            summary: "Existing evidence",
            detail: REUSED_RESEARCH_DETAIL,
            suggestions: [],
            visualReferences: []
          },
    research => {
      const searchMarker = research.detail.match(/<!--\s*aim-delivery-research\s+([\s\S]*?)\s*-->/);
      const searchStatus: unknown = searchMarker ? JSON.parse(searchMarker[1]) : null;
      if (
        !searchStatus ||
        typeof searchStatus !== "object" ||
        !("status" in searchStatus) ||
        searchStatus.status !== (needsResearch ? "searched" : "reused")
      )
        throw new Error("Final-document web research was unavailable or not completed; no conclusion was saved.");
    }
  );
  const evidence = `Final document outline:\n${outline}\n\nFinal document research:\n${research.detail}\n\nSupplied source reports:\n${sourceCatalog}`;
  const current = new Map((options.evidence ?? []).map(source => [source.id, source]));
  if (current.size !== (options.evidence ?? []).length) throw new Error("Duplicate final delivery evidence IDs.");
  const available = new Map([
    ...(options.lineageEvidence ?? []).map(source => [source.id, source] as const),
    ...current
  ]);
  // The whole document is written in one call, so its sections cannot repeat each other. It reads the union of
  // the sources the outline maps, from this round's evidence or earlier rounds' lineage; an ID that is neither is
  // dropped and never read, and a section left with none (or a legacy section without a mapping) brings in all
  // of this round's supplied evidence (not the lineage).
  const sources = new Map<string, DeliveryEvidence>();
  for (const section of sections) {
    const named = [...new Set([...(section.evidenceIds ?? []), ...(section.dependencies ?? [])])];
    const ids = named.filter(id => available.has(id));
    const scoped =
      (section.evidenceIds === undefined && section.dependencies === undefined) || (named.length && !ids.length)
        ? [...current.values()]
        : ids.map(id => available.get(id)!);
    for (const source of scoped) sources.set(source.id, source);
  }
  const documentSources = [...available.values()].filter(source => sources.has(source.id));
  const documentEvidence = documentSources.length
    ? documentSources.map(source => `Source ID: ${source.id}\n${source.detail}`).join("\n\n")
    : current.size
      ? NO_MAPPED_SOURCE
      : `${base.detail}\n\n${research.detail}`;
  const documentResearch = needsResearch ? research.detail : undefined;
  const draftFingerprint = fingerprint({
    baseFingerprint,
    sections: sections.map(section => [section.heading, section.purpose, section.searchTask]),
    sources: documentSources.map(source => [source.id, source.hash]),
    research: documentResearch ?? (!current.size ? research.detail : undefined)
  });
  let draft: AiResult;
  let legacyDraft =
    reuseRemaining &&
    savedCheckpoint?.draft &&
    (!savedCheckpoint.draftFingerprint || savedCheckpoint.draftFingerprint === draftFingerprint);
  if (legacyDraft) {
    try {
      validateContent(savedCheckpoint!.draft!);
    } catch {
      legacyDraft = undefined;
    }
  }
  if (legacyDraft) {
    if (savedCheckpoint?.sections) checkpoint.sections = { ...savedCheckpoint.sections };
    draft = savedCheckpoint!.draft!;
    checkpoint.draft = draft;
    checkpoint.draftFingerprint = draftFingerprint;
  } else {
    reuseRemaining = false;
    const saved = savedCheckpoint?.sections?.[DOCUMENT_KEY];
    let written: AiResult | undefined;
    if (saved?.fingerprint === draftFingerprint) {
      try {
        validateContent(saved.result);
        written = saved.result;
      } catch {
        /* Rewrite an invalid saved document. */
      }
    }
    if (!written) {
      written = await run(
        "delivery-writing",
        renderWritingTask({
          outline,
          knownConditions: options.knownConditions ?? base.detail,
          evidence: documentEvidence,
          ...(documentResearch === undefined ? {} : { research: documentResearch })
        })
      );
      base.signal?.throwIfAborted();
    }
    checkpoint.sections = {
      [DOCUMENT_KEY]: {
        fingerprint: draftFingerprint,
        evidenceIds: documentSources.map(source => source.id),
        result: written
      }
    };
    draft = {
      summary: written.summary,
      detail: written.detail,
      suggestions: [],
      visualReferences: written.visualReferences ?? []
    };
    validateContent(draft);
    checkpoint.draftFingerprint = draftFingerprint;
    checkpoint.draft = draft;
    await options.onCheckpoint?.({ ...checkpoint });
    base.signal?.throwIfAborted();
  }
  // Acceptance belongs to the exact written document; a rewritten document invalidates it.
  if (savedCheckpoint?.draftFingerprint && savedCheckpoint.draftFingerprint !== draftFingerprint)
    reuseRemaining = false;
  const result = await stage(
    "acceptance",
    () =>
      run(
        "delivery-acceptance",
        renderAcceptanceTask({
          outline,
          research: research.detail,
          sourceCatalog,
          draft: draft.detail,
          ...(options.openItems ? { openItems: options.openItems } : {})
        })
      ),
    result => {
      parseAcceptance(result);
    }
  );
  const acceptance = parseAcceptance(result);
  if (acceptance.decision === "conclude") {
    return { result: { ...draft, detail: `${acceptance.marker}\n\n${draft.detail}`, suggestions: [] }, evidence };
  }
  return {
    result: {
      ...result,
      detail: `${result.detail}\n\n${translateNote(base.outputLanguage ?? "en", "note.aim_draft_pending")}\n\n${draft.detail}`
    },
    evidence,
    draft
  };
}
