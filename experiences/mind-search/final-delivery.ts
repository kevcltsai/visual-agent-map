import type { AiResult, TaskContext } from "../../ai/types";

export interface DeliverySection { heading: string; purpose: string; searchTask: string }
export function parseDeliveryOutline(detail: string): DeliverySection[] {
  const marker = detail.match(/<!--\s*mindsearch-delivery-outline\s+([\s\S]*?)\s*-->/);
  if (!marker) throw new Error("Final delivery outline is missing; no conclusion was saved.");
  const value: unknown = JSON.parse(marker[1]);
  const sections = value && typeof value === "object" && "sections" in value ? value.sections : undefined;
  if (!Array.isArray(sections) || !sections.length || sections.length > 12) throw new Error("Final delivery outline is invalid; no conclusion was saved.");
  const validated: DeliverySection[] = sections.map((section: unknown) => {
    if (!section || typeof section !== "object" || !("heading" in section) || !("purpose" in section) || !("searchTask" in section) || typeof section.heading !== "string" || !section.heading.trim() || typeof section.purpose !== "string" || !section.purpose.trim() || typeof section.searchTask !== "string") throw new Error("Final delivery outline is invalid; no conclusion was saved.");
    return { heading: section.heading, purpose: section.purpose, searchTask: section.searchTask };
  });
  if (new Set(validated.map(section => section.heading.trim().toLowerCase())).size !== validated.length) throw new Error("Final delivery outline contains duplicate sections.");
  return validated;
}

/** A separate deliverable workflow: outline, search to fill it, write, then check coverage. */
export async function buildFinalDelivery(base: TaskContext, ask: (context: TaskContext) => Promise<AiResult>): Promise<{ result: AiResult; evidence: string }> {
  const run = async (phase: string, task: string, research = false): Promise<AiResult> => {
    base.signal?.throwIfAborted();
    const result = await ask({ ...base, task: `<!-- mindsearch-phase: ${phase} -->\n${task}`, researchMode: research ? "research" : "local", researchDepth: research ? "normal" : "fast", detailFormat: "adaptive" });
    base.signal?.throwIfAborted();
    if (!result.summary.trim() || !result.detail.trim()) throw new Error("Final delivery stage returned empty content; no conclusion was saved.");
    return result;
  };
  const outlineResult = await run("delivery-outline", 'You are the final-delivery Synthesizer. Design the actual document needed to answer the ORIGINAL user goal with all supplied conditions and outcome preferences. Previous research informs the outline; do not merely concatenate reports or reuse their headings. Return <!-- mindsearch-delivery-outline {"sections":[{"heading":"section title","purpose":"what the reader can do or understand after this section","searchTask":"specific web search needed for this section, or empty if already supported"}]} --> as the first detail line. Choose a suitable structure, not a fixed template. Include concrete examples, resources, execution details or comparisons when required by this user. Identify exact source gaps for the deliverable. Do not ask the user or deliver the document yet.');
  const sections = parseDeliveryOutline(outlineResult.detail);
  const outline = JSON.stringify(sections);
  const needsResearch = sections.some(section => section.searchTask.trim());
  const research = needsResearch ? await run("delivery-research", `You are the Researcher for the FINAL DOCUMENT. Search the web to fill and verify the sections of this agreed outline: ${outline}. Prioritize the explicit searchTasks and the concrete resources, examples, steps, or current facts required to deliver this user's requested result. Reuse supported prior findings; do not search irrelevant topics. Return a section-by-section evidence report with direct source URLs, what each source supports, usable concrete details and unresolved gaps. Actually use available search tools; never claim a search occurred if it did not. Begin detail with <!-- mindsearch-delivery-research {"status":"searched|unavailable"} -->. If tools fail or are unavailable, return unavailable rather than replacing research with memory. Do not write the final document or ask questions.`, true) : { summary: "Existing evidence", detail: '<!-- mindsearch-delivery-research {"status":"reused"} -->\nNo new search requested by the outline; use the supplied prior evidence.', suggestions: [] };
  const searchMarker = research.detail.match(/<!--\s*mindsearch-delivery-research\s+([\s\S]*?)\s*-->/);
  const searchStatus: unknown = searchMarker ? JSON.parse(searchMarker[1]) : null;
  if (!searchStatus || typeof searchStatus !== "object" || !("status" in searchStatus) || searchStatus.status !== (needsResearch ? "searched" : "reused")) throw new Error("Final-document web research was unavailable or not completed; no conclusion was saved.");
  const evidence = `Final document outline:\n${outline}\n\nFinal document research:\n${research.detail}`;
  const draft = await run("delivery-writing", `Write the complete final document answering the original user goal. Agreed outline: ${outline}. Final-document evidence:\n${research.detail}\nUse all user conditions and earlier supported reports. Develop every section into useful, specific content; do not deliver a short synopsis or a list of capabilities in place of an executable requested result. Integrate steps, examples, resources, acceptance criteria and source links where the goal calls for them. Do not impose those on unrelated goals. Put caveats beside affected advice. Preserve source attribution; do not fabricate URLs, images, facts or user conditions. Mark unresolved facts honestly. Output the actual reader-facing document in detail, without internal audit headings or decision markers; summary is only the canvas preview.`);
  const result = await run("delivery-acceptance", `Review the full draft against the ORIGINAL goal, supplied conditions, requested format, and agreed outline. Outline: ${outline}\nFinal research:\n${research.detail}\nDraft:\n${draft.detail}\nReturn a valid first-line MindSearch review marker. Choose conclude ONLY if the document is usable and complete for this request: every required section is developed, necessary examples/resources/steps are concrete and supported, and sources are linked where used. Mere general direction is insufficient for a requested actionable plan. For conclude, return only the marker and a short acceptance note; do not rewrite or repeat the draft. Explain readiness in rationale and stopReason. For shortcomings, list the specific missing outcomes and return research_more. If important delivery evidence remains missing, choose research_more with exactly one concrete target in suggestions (title, task, contribution) and explain the missing outcome. Do not ask the user and do not invent evidence. Marker: <!-- mindsearch-review {"decision":"conclude|research_more","rationale":"reason","stopReason":"delivery readiness, conclude only"} -->.`);
  const acceptance = result.detail.match(/^\s*<!--\s*mindsearch-review\s+(\{[^\n]*\})\s*-->/);
  if (!acceptance) throw new Error("Final delivery acceptance marker missing; no conclusion was saved.");
  const decision: unknown = JSON.parse(acceptance[1]);
  if (!decision || typeof decision !== "object" || !("decision" in decision)) throw new Error("Invalid final delivery acceptance.");
  if (decision.decision === "conclude") {
    if (!("rationale" in decision) || !("stopReason" in decision) || typeof decision.rationale !== "string" || !decision.rationale.trim() || typeof decision.stopReason !== "string" || !decision.stopReason.trim()) throw new Error("Final delivery acceptance is incomplete; no conclusion was saved.");
    return { result: { ...draft, detail: `${acceptance[0].trim()}\n\n${draft.detail}`, suggestions: [] }, evidence };
  }
  if (decision.decision !== "research_more") throw new Error("Final delivery acceptance must conclude or identify an evidence gap.");
  return { result: { ...result, detail: `${result.detail}\n\n## Draft pending completion\n\n${draft.detail}` }, evidence };
}
