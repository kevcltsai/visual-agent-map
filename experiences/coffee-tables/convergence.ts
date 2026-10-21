import type { NoteLanguage } from "../../i18n";
import type { CoffeeConvergenceProposal } from "./customization";
import type { CoffeeInsight } from "./insights";
import { serializeInsightNotes } from "./insights";
import type { CoffeeSession } from "./types";

export function convergenceFingerprint(session: CoffeeSession): string {
  const input = JSON.stringify({
    notes: session.observerNotes ?? [],
    pinned: [...(session.pinnedInsightIds ?? [])].sort(),
    transcriptMarkdown: session.transcriptMarkdown,
    rounds: (session.rounds ?? []).map(({ id, markdown, notes, draftMarkdown, status, createdAt }) => ({
      id,
      markdown,
      notes,
      draftMarkdown,
      status,
      createdAt
    })),
    questions: session.questions.map(({ id, question, answer, draftAnswer, status, createdAt }) => ({
      id,
      question,
      answer,
      draftAnswer,
      status,
      createdAt
    })),
    interventions: session.interventions ?? [],
    draftMarkdown: session.draftMarkdown,
    observerDraftMarkdown: session.observerDraftMarkdown
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) hash = Math.imul(hash ^ input.charCodeAt(index), 0x01000193);
  return `coffee-notes-${(hash >>> 0).toString(36)}`;
}

export function enforcePinnedProposals(
  proposals: CoffeeConvergenceProposal[],
  baseline: CoffeeInsight[],
  pinnedIds: string[]
): void {
  const pinned = new Set(pinnedIds);
  for (const item of baseline) {
    if (!pinned.has(item.id)) continue;
    const proposal = proposals.find(candidate => candidate.sourceIds.includes(item.id));
    if (
      !proposal ||
      proposal.sourceIds.length !== 1 ||
      proposal.category !== item.category ||
      proposal.summary !== item.summary ||
      proposal.detail !== item.detail
    ) {
      throw new Error("Pinned insights must remain unchanged and cannot be merged");
    }
  }
}

export function applyConvergenceProposals(
  baseline: CoffeeInsight[],
  proposals: CoffeeConvergenceProposal[],
  acceptedIndices: number[],
  edits: Record<number, { summary: string; detail: string }>,
  language: NoteLanguage
): string[] {
  const accepted = new Set(acceptedIndices);
  if ([...accepted].some(index => !Number.isInteger(index) || index < 0 || index >= proposals.length))
    throw new Error("An accepted convergence proposal does not exist");
  const sourceToProposal = new Map<string, number>();
  proposals.forEach((proposal, index) => proposal.sourceIds.forEach(id => sourceToProposal.set(id, index)));
  const next: CoffeeInsight[] = [];
  const emitted = new Set<number>();
  for (const item of baseline) {
    const proposalIndex = sourceToProposal.get(item.id);
    if (proposalIndex === undefined || !accepted.has(proposalIndex)) {
      next.push({ ...item, sources: [...item.sources], mergedIds: [...item.mergedIds] });
      continue;
    }
    if (emitted.has(proposalIndex)) continue;
    emitted.add(proposalIndex);
    const proposal = proposals[proposalIndex],
      sources = proposal.sourceIds
        .map(id => baseline.find(source => source.id === id))
        .filter((source): source is CoffeeInsight => !!source);
    const edit = edits[proposalIndex];
    const summary = edit?.summary ?? proposal.summary,
      detail = edit?.detail ?? proposal.detail;
    if (!summary.trim()) throw new Error("An accepted proposal needs a summary");
    const first = sources[0];
    const mergedIds = [
      ...new Set(sources.flatMap(source => [source.id, ...source.mergedIds]).filter(id => id !== first.id))
    ];
    next.push({
      ...first,
      id: first.id,
      persistedId: true,
      category: proposal.category,
      summary: summary.trim(),
      detail: detail.trim(),
      sources: [...new Set(sources.flatMap(source => source.sources))],
      mergedIds,
      question: uniqueText(sources.map(source => source.question)),
      proposedSolution: uniqueText(sources.map(source => source.proposedSolution)),
      limitations: uniqueText(sources.map(source => source.limitations))
    });
  }
  return [serializeInsightNotes(next, language)];
}

function uniqueText(values: Array<string | undefined>): string | undefined {
  const result = [
    ...new Set(values.filter((value): value is string => !!value && !!value.trim()).map(value => value.trim()))
  ];
  return result.length ? result.join("\n") : undefined;
}
