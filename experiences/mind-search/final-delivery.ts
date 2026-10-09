import { createHash } from "node:crypto";
import type { AiResult, TaskContext } from "../../ai/types";

export interface DeliverySection { heading: string; purpose: string; searchTask: string; evidenceIds?: string[]; dependencies?: string[] }
export interface DeliveryEvidence { id: string; hash: string; detail: string }
export interface DeliverySectionCheckpoint { fingerprint: string; evidenceIds: string[]; result: AiResult }
const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function parseDeliveryOutline(detail: string): DeliverySection[] {
  const marker = detail.match(/<!--\s*mindsearch-delivery-outline\s+([\s\S]*?)\s*-->/);
  if (!marker) throw new Error("Final delivery outline is missing; no conclusion was saved.");
  const value: unknown = JSON.parse(marker[1]);
  const sections = value && typeof value === "object" && "sections" in value ? value.sections : undefined;
  if (!Array.isArray(sections) || !sections.length || sections.length > 12) throw new Error("Final delivery outline is invalid; no conclusion was saved.");
  const validated: DeliverySection[] = sections.map((section: unknown) => {
    if (!section || typeof section !== "object" || !("heading" in section) || !("purpose" in section) || !("searchTask" in section) || typeof section.heading !== "string" || !section.heading.trim() || typeof section.purpose !== "string" || !section.purpose.trim() || typeof section.searchTask !== "string") throw new Error("Final delivery outline is invalid; no conclusion was saved.");
    const mapping: { evidenceIds?: string[]; dependencies?: string[] } = {};
    for (const key of ["evidenceIds", "dependencies"] as const) {
      if (key in section) {
        const ids = (section as Record<string, unknown>)[key];
        if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) throw new Error("Invalid final delivery source mapping.");
        mapping[key] = ids;
      }
    }
    return { heading: section.heading, purpose: section.purpose, searchTask: section.searchTask, ...mapping };
  });
  if (new Set(validated.map(section => section.heading.trim().toLowerCase())).size !== validated.length) throw new Error("Final delivery outline contains duplicate sections.");
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

export interface FinalDeliveryOptions {
  onPhase?: (phase: FinalDeliveryPhase) => void | Promise<void>;
  timeoutMs?: number;
  checkpoint?: FinalDeliveryCheckpoint;
  /** Persisted source reports; hashes identify content changes, not verification. */
  evidence?: readonly DeliveryEvidence[];
  /** Goal, original background and answered conditions, excluding research reports. */
  knownConditions?: string;
  /** Must finish saving the snapshot before the next model phase starts. */
  onCheckpoint?: (checkpoint: FinalDeliveryCheckpoint) => void | Promise<void>;
}

function validateContent(result: AiResult): void {
  if (typeof result.summary !== "string" || !result.summary.trim() || typeof result.detail !== "string" || !result.detail.trim()) throw new Error("Final delivery stage returned empty content; no conclusion was saved.");
}

function parseAcceptance(result: AiResult): { marker: string; decision: "conclude" | "research_more" } {
  const acceptance = result.detail.match(/^\s*<!--\s*mindsearch-review\s+(\{[^\n]*\})\s*-->/);
  if (!acceptance) throw new Error("Final delivery acceptance marker missing; no conclusion was saved.");
  const decision: unknown = JSON.parse(acceptance[1]);
  if (!decision || typeof decision !== "object" || !("decision" in decision)) throw new Error("Invalid final delivery acceptance.");
  if (decision.decision === "conclude") {
    if (!("rationale" in decision) || !("stopReason" in decision) || typeof decision.rationale !== "string" || !decision.rationale.trim() || typeof decision.stopReason !== "string" || !decision.stopReason.trim()) throw new Error("Final delivery acceptance is incomplete; no conclusion was saved.");
  } else if (decision.decision === "research_more") {
    const target = Array.isArray(result.suggestions) && result.suggestions.length === 1 ? result.suggestions[0] : undefined;
    if (!target || [target.title, target.task, target.contribution].some(value => typeof value !== "string" || !value.trim())) throw new Error("Final delivery acceptance must identify one concrete evidence gap; no conclusion was saved.");
  } else throw new Error("Final delivery acceptance must conclude or identify an evidence gap.");
  return { marker: acceptance[0].trim(), decision: decision.decision };
}

/** A separate deliverable workflow: outline, search to fill it, write, then check coverage. */
export async function buildFinalDelivery(base: TaskContext, ask: (context: TaskContext) => Promise<AiResult>, options: FinalDeliveryOptions = {}): Promise<{ result: AiResult; evidence: string }> {
  const baseFingerprint = fingerprint({ title: base.title, rules: base.rules, conditions: options.knownConditions ?? base.detail, language: base.outputLanguage });
  const savedBaseValid = options.checkpoint?.baseFingerprint === baseFingerprint || (!options.checkpoint?.baseFingerprint && options.evidence === undefined);
  const savedCheckpoint = savedBaseValid ? options.checkpoint : undefined;
  // Preserve independently valid successes through outline/research persistence failures.
  // Each section is still fingerprint-validated before reuse.
  const checkpoint: FinalDeliveryCheckpoint = { baseFingerprint, ...(savedCheckpoint?.sections ? { sections: { ...savedCheckpoint.sections } } : {}) };
  let reuseRemaining = true;
  const stage = async (key: "outline" | "research" | "draft" | "acceptance", produce: () => Promise<AiResult>, validate: (result: AiResult) => void = validateContent): Promise<AiResult> => {
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
    const writingScope = phase === "delivery-writing" && options.evidence ? { detail: options.knownConditions ?? "", summary: "", workingFindings: "", sourceContext: "", referenceGroups: [] } : {};
    const result = await ask({ ...base, ...writingScope, ...(phase === "delivery-acceptance" ? { responseContract: "mindsearch-delivery-acceptance" as const } : {}), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), task: `<!-- mindsearch-phase: ${phase} -->\n${task}`, ...(research ? { mindSearchIsolatedResearch: true } : {}), researchMode: research ? "research" : "local", researchDepth: research ? "normal" : "fast", detailFormat: "adaptive" });
    base.signal?.throwIfAborted();
    validateContent(result);
    return result;
  };
  const sourceCatalog = (options.evidence ?? []).map(source => `Source ID: ${source.id}\n${source.detail}`).join("\n\n");
  const outlineResult = await stage("outline", () => run("delivery-outline", 'You are the final-delivery Synthesizer. Design the actual document needed to answer the ORIGINAL user goal with all supplied conditions and outcome preferences. Previous research informs the outline; do not merely concatenate reports or reuse their headings. Return <!-- mindsearch-delivery-outline {"sections":[{"heading":"section title","purpose":"what the reader can do or understand after this section","searchTask":"specific web search needed for this section, or empty if already supported","evidenceIds":["supplied-source-id"],"dependencies":["additional-source-id"]}]} --> as the first detail line. Choose a suitable structure, not a fixed template. Include concrete examples, resources, execution details or comparisons when required by this user. Map each section to the minimal supplied evidenceIds it needs. Dependencies also name supplied source IDs. Leave searchTask empty when mapped supplied reports already support the section; do not request a full search merely to repeat them. Identify exact source gaps for the deliverable. Do not ask the user or deliver the document yet.' + `\nSupplied evidence IDs and reports:\n${sourceCatalog}`), result => { parseDeliveryOutline(result.detail); });
  const sections = parseDeliveryOutline(outlineResult.detail);
  const outline = JSON.stringify(sections);
  const needsResearch = sections.some(section => section.searchTask.trim());
  const researchFingerprint = fingerprint(sections.filter(section => section.searchTask.trim()).map(section => {
    const ids = [...new Set([...(section.evidenceIds ?? []), ...(section.dependencies ?? [])])];
    const scoped = section.evidenceIds === undefined && section.dependencies === undefined ? options.evidence ?? [] : (options.evidence ?? []).filter(source => ids.includes(source.id));
    return { heading: section.heading, searchTask: section.searchTask, sources: scoped.map(source => [source.id, source.hash]) };
  }));
  if (needsResearch && savedCheckpoint?.researchFingerprint && savedCheckpoint.researchFingerprint !== researchFingerprint) reuseRemaining = false;
  checkpoint.researchFingerprint = researchFingerprint;
  const research = await stage("research", async () => needsResearch ? await run("delivery-research", `You are the Researcher for the FINAL DOCUMENT. Search the web to fill and verify the sections of this agreed outline: ${outline}. Prioritize the explicit searchTasks and the concrete resources, examples, steps, or current facts required to deliver this user's requested result. Reuse supported prior findings; do not search irrelevant topics. Return a section-by-section evidence report. Use a Markdown H2 heading exactly matching each agreed section heading with a nonempty searchTask; place only that section's findings under it. Include explicit source IDs (delivery-research:<section-heading>:<number>) and direct source URLs, what each source supports, usable concrete details and unresolved gaps. Actually use available search tools; never claim a search occurred if it did not. Begin detail with <!-- mindsearch-delivery-research {"status":"searched|unavailable"} -->. If tools fail or are unavailable, return unavailable rather than replacing research with memory. Do not write the final document or ask questions.`, true) : { summary: "Existing evidence", detail: '<!-- mindsearch-delivery-research {"status":"reused"} -->\nNo new search requested by the outline; use the supplied prior evidence.', suggestions: [], visualReferences: [] }, research => {
    const searchMarker = research.detail.match(/<!--\s*mindsearch-delivery-research\s+([\s\S]*?)\s*-->/);
    const searchStatus: unknown = searchMarker ? JSON.parse(searchMarker[1]) : null;
    if (!searchStatus || typeof searchStatus !== "object" || !("status" in searchStatus) || searchStatus.status !== (needsResearch ? "searched" : "reused")) throw new Error("Final-document web research was unavailable or not completed; no conclusion was saved.");
  });
  const evidence = `Final document outline:\n${outline}\n\nFinal document research:\n${research.detail}\n\nSupplied source reports:\n${sourceCatalog}`;
  const available = new Map((options.evidence ?? []).map(source => [source.id, source]));
  if (available.size !== (options.evidence ?? []).length) throw new Error("Duplicate final delivery evidence IDs.");
  const researchForSection = (section: DeliverySection): string => {
    if (!section.searchTask.trim()) return "";
    const lines = research.detail.split("\n");
    const start = lines.findIndex(line => line.trim() === `## ${section.heading}`);
    if (start >= 0) {
      const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
      return lines.slice(start, end < 0 ? undefined : end).join("\n");
    }
    if (options.evidence && sections.filter(item => item.searchTask.trim()).length > 1) throw new Error("Final research is missing section-scoped evidence; no conclusion was saved.");
    return research.detail;
  };
  const sectionPlans = sections.map(section => {
    const ids = [...new Set([...(section.evidenceIds ?? []), ...(section.dependencies ?? [])])];
    if (ids.some(id => !available.has(id))) throw new Error("Final delivery outline references an unavailable source ID.");
    // Legacy outlines without a mapping depend on the complete supplied evidence.
    const sources = section.evidenceIds === undefined && section.dependencies === undefined ? [...available.values()] : ids.map(id => available.get(id)!);
    const scopedEvidence = sources.length ? sources.map(source => `Source ID: ${source.id}\n${source.detail}`).join("\n\n") : available.size ? "No external source is mapped to this section. Do not make source-backed claims." : `${base.detail}\n\n${research.detail}`;
    const scopedResearch = researchForSection(section);
    const sectionFingerprint = fingerprint({ baseFingerprint, heading: section.heading, purpose: section.purpose, searchTask: section.searchTask, sources: sources.map(source => [source.id, source.hash]), research: scopedResearch || (!available.size ? research.detail : undefined) });
    return { section, sources, scopedEvidence, scopedResearch, sectionFingerprint, key: section.heading.trim().toLowerCase() };
  });
  const draftFingerprint = fingerprint(sectionPlans.map(plan => plan.sectionFingerprint));
  let draft: AiResult;
  let legacyDraft = reuseRemaining && savedCheckpoint?.draft && (!savedCheckpoint.draftFingerprint || savedCheckpoint.draftFingerprint === draftFingerprint);
  if (legacyDraft) {
    try { validateContent(savedCheckpoint!.draft!); } catch { legacyDraft = undefined; }
  }
  if (legacyDraft) {
    if (savedCheckpoint?.sections) checkpoint.sections = { ...savedCheckpoint.sections };
    draft = savedCheckpoint!.draft!;
    checkpoint.draft = draft;
    checkpoint.draftFingerprint = draftFingerprint;
  } else {
    reuseRemaining = false;
    const completed = Object.create(null) as Record<string, DeliverySectionCheckpoint>;
    // Keep valid sections even after a failed research/draft/acceptance stage.
    for (const plan of sectionPlans) {
      const saved = savedCheckpoint?.sections?.[plan.key];
      if (saved?.fingerprint === plan.sectionFingerprint) {
        try { validateContent(saved.result); completed[plan.key] = saved; } catch { /* Rewrite only this invalid section. */ }
      }
    }
    checkpoint.sections = completed;
    for (const plan of sectionPlans) {
      if (completed[plan.key]) continue;
      const written = await run("delivery-writing", `Write only the complete section "${plan.section.heading}" of the final document. Purpose: ${plan.section.purpose}. Full outline (structure only): ${outline}.\nKnown goal and user conditions:\n${options.knownConditions ?? base.detail}\nSection evidence (cite these explicit source IDs and URLs where used):\n${plan.scopedEvidence}\n${plan.section.searchTask.trim() ? `Additional final-document research:\n${plan.scopedResearch}` : ""}\nDevelop this section into useful specific content answering the original user goal. Include steps, examples and resources when required. Preserve all necessary detail; summary is only a canvas preview. Do not write other sections, an audit, or a synopsis. Do not fabricate or imply independent source verification. Output reader-facing Markdown in detail; cite sources where used and place limitations beside affected claims.`);
      base.signal?.throwIfAborted();
      completed[plan.key] = { fingerprint: plan.sectionFingerprint, evidenceIds: plan.sources.map(source => source.id), result: written };
      await options.onCheckpoint?.({ ...checkpoint, sections: { ...completed } });
      base.signal?.throwIfAborted();
    }
    if (sectionPlans.some(plan => !completed[plan.key])) throw new Error("Final delivery is missing a required section.");
    const writtenSections = sectionPlans.map(plan => completed[plan.key].result);
    const detail = writtenSections.map((written, index) => sections.length === 1 || new RegExp(`^#{1,6}\\s+${sections[index].heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(written.detail) ? written.detail : `## ${sections[index].heading}\n\n${written.detail}`).join("\n\n");
    draft = { summary: writtenSections[0].summary, detail, suggestions: [], visualReferences: writtenSections.flatMap(written => written.visualReferences ?? []) };
    validateContent(draft);
    checkpoint.draftFingerprint = draftFingerprint;
    checkpoint.draft = draft;
    await options.onCheckpoint?.({ ...checkpoint, sections: { ...completed } });
    base.signal?.throwIfAborted();
  }
  // Acceptance belongs to the exact assembled document; changed sections invalidate it.
  if (savedCheckpoint?.draftFingerprint && savedCheckpoint.draftFingerprint !== draftFingerprint) reuseRemaining = false;
  const result = await stage("acceptance", () => run("delivery-acceptance", `Perform the final join review: check cross-section coherence, repeated advice or duplicate passages, source IDs or URLs attributed to the wrong claims, and missing sections. Do not rewrite sections. Review the full draft against the ORIGINAL goal, supplied conditions, requested format, and agreed outline. Outline: ${outline}\nFinal research:\n${research.detail}\nSupplied source reports:\n${sourceCatalog}\nDraft:\n${draft.detail}\nReturn a valid first-line MindSearch review marker. Choose conclude ONLY if the document is usable and complete for this request: every required section is developed, necessary examples/resources/steps are concrete and supported, and sources are linked where used. Mere general direction is insufficient for a requested actionable plan. For conclude, return only the marker and a short acceptance note; do not rewrite or repeat the draft. Explain readiness in rationale and stopReason. For shortcomings, list the specific missing outcomes and return research_more. If important delivery evidence remains missing, choose research_more with exactly one concrete target in suggestions (title, task, contribution) and explain the missing outcome. Do not ask the user and do not invent evidence. Marker: <!-- mindsearch-review {"decision":"conclude|research_more","rationale":"reason","stopReason":"delivery readiness, conclude only"} -->.`), result => { parseAcceptance(result); });
  const acceptance = parseAcceptance(result);
  if (acceptance.decision === "conclude") {
    return { result: { ...draft, detail: `${acceptance.marker}\n\n${draft.detail}`, suggestions: [] }, evidence };
  }
  return { result: { ...result, detail: `${result.detail}\n\n## Draft pending completion\n\n${draft.detail}` }, evidence };
}
