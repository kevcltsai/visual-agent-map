import { createHash } from "node:crypto";
import { createThinkingArtifact, type ThinkingArtifact } from "../../core/thinking-artifact";
import { baselineFromVersions, type CoffeeInsight } from "./insights";
import type { CoffeeSession } from "./types";

export interface CoffeeSource {
  content: string;
  sourceSnapshot: string;
  question: string;
  artifactId: string;
  identityKind: "persisted-insight" | "snapshot";
}
export interface CoffeeHandoffIdentityInput {
  sessionId: string;
  sourcePath: string;
  sourceContent: string;
  sourceSnapshot: string;
  question: string;
  content: string;
  model: string;
  reasoning: string;
  language: string;
  reframingMethod: string;
  sourceIdentityKind: string;
  sourceArtifactId: string;
}
export interface CoffeeHandoffConfirmation {
  sessionId: string;
  sourcePath: string;
  topic: string;
  source: CoffeeSource;
  question: string;
  content: string;
  model: string;
  reasoning: string;
  language: string;
  reframingMethod: "manual" | "ai";
}
export function coffeeHandoffIdentity(input: CoffeeHandoffIdentityInput): string {
  return `coffee-handoff-${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
}
export function createCoffeeHandoffArtifact(input: CoffeeHandoffConfirmation): ThinkingArtifact {
  const id = coffeeHandoffIdentity({
    sessionId: input.sessionId, sourcePath: input.sourcePath,
    sourceContent: input.source.content, sourceSnapshot: input.source.sourceSnapshot,
    question: input.question, content: input.content, model: input.model,
    reasoning: input.reasoning, language: input.language,
    reframingMethod: input.reframingMethod, sourceIdentityKind: input.source.identityKind,
    sourceArtifactId: input.source.artifactId
  });
  return createThinkingArtifact({
    id, kind: "question", title: input.question, content: input.content,
    sourceSnapshot: input.source.sourceSnapshot,
    origin: { experience: "coffee-tables", sessionId: input.sessionId, path: input.sourcePath },
    sources: [{ label: input.topic, path: input.sourcePath, experience: "coffee-tables", sessionId: input.sessionId, artifactId: input.source.artifactId }],
    metadata: { model: input.model, reasoning: input.reasoning, reframingMethod: input.reframingMethod, sourceIdentityKind: input.source.identityKind }
  });
}
function references(session: CoffeeSession): Array<{ name: string; content: string }> {
  return [...new Map([...(session.referenceFiles ?? []), ...(session.guests?.referenceFiles ?? [])].map(item => [JSON.stringify(item), item])).values()];
}
export function coffeeCommittedKey(session: CoffeeSession): string {
  return JSON.stringify({
    id: session.id, topic: session.topic, status: session.status, language: session.language,
    model: session.model, reasoning: session.reasoning, dirtyNotes: session.dirtyNotes === true,
    dialogue: (session.rounds ?? []).map(item => ({ id: item.id, markdown: item.markdown, status: item.status })),
    transcript: session.transcriptMarkdown,
    questions: session.questions.filter(item => item.status === "complete").map(item => ({ id: item.id, question: item.question, answer: item.answer })),
    interventions: session.interventions ?? [], insights: session.observerNotes ?? [],
    acceptedConvergence: session.convergenceUndo ? { expectedNotes: session.convergenceUndo.expectedNotes, acceptedInsightIds: session.convergenceUndo.acceptedInsightIds ?? null } : null,
    background: session.guests?.background ?? "", references: references(session)
  });
}
function insightText(item: CoffeeInsight): string {
  return [item.summary, item.detail, item.question, item.proposedSolution, item.limitations].filter(Boolean).join("\n\n");
}
const normalize = (text: string): string => text.normalize("NFKC").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
export function buildCoffeeSource(session: CoffeeSession, insightId?: string | string[]): CoffeeSource {
  const insights = baselineFromVersions(session.observerNotes ?? [], session.language);
  const selectedIds = Array.isArray(insightId) ? insightId : insightId ? [insightId] : undefined;
  if (selectedIds && !selectedIds.length) throw new Error("Select at least one accepted insight.");
  if (selectedIds && new Set(selectedIds).size !== selectedIds.length) throw new Error("The selected insight list contains duplicates.");
  const selectedSet = selectedIds ? new Set(selectedIds) : undefined;
  const selectedInsights = selectedSet ? insights.filter(item => selectedSet.has(item.id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : [];
  if (selectedSet && selectedInsights.length !== selectedSet.size) throw new Error("The selected insight changed; reopen the latest table.");
  const selected = selectedInsights[0];
  const dialogue = (session.rounds?.length ? session.rounds.filter(item => item.markdown.trim()).map(item => item.status === "completed" ? item.markdown : `Saved segment (${item.status}):\n${item.markdown}`) : [session.transcriptMarkdown]).filter(Boolean);
  const answers = session.questions.filter(item => item.status === "complete").map(item => `${item.question}\n${item.answer}`);
  const committed = [...dialogue, ...answers];
  const unresolved: string[] = [], excerpts: string[] = [];
  for (const source of selectedInsights.flatMap(item => item.sources)) {
    const needle = normalize(source);
    let count = 0;
    for (const text of committed) {
      const haystack = normalize(text); let at = 0;
      while (needle && (at = haystack.indexOf(needle, at)) >= 0) { count++; at += needle.length; }
    }
    if (count === 1) excerpts.push(source); else unresolved.push(source);
  }
  const snapshotText = selectedSet ? selectedInsights.map(item => [insightText(item), `Category: ${item.category}`, item.sources.length ? `Original source annotations (not proof): ${JSON.stringify(item.sources)}` : ""].filter(Boolean).join("\n\n")).join("\n\n---\n\n") : (session.observerNotes ?? []).join("\n\n") || "No cumulative insight snapshot was available.";
  const status = ["Simulated Coffee Tables discussion. All ideas are unverified candidates, not the user's conclusion.", session.dirtyNotes ? "Observer notes are stale / not updated after conversation edits." : ""].filter(Boolean).join("\n");
  const sourceSnapshot = [status, snapshotText].join("\n\n");
  const content = selectedSet ? [session.topic, status, sourceSnapshot, excerpts.length ? `Uniquely verified source excerpts:\n${[...new Set(excerpts)].join("\n\n")}` : "No uniquely located dialogue source.", unresolved.length ? `Unresolved source annotations (not verified excerpts):\n${JSON.stringify(unresolved)}` : ""].filter(Boolean).join("\n\n") : [
    session.topic, status, ...committed,
    ...(session.interventions ?? []).filter(item => item.status === "sent" || item.status === undefined).map(item => `Saved user intervention: ${item.text}`),
    sourceSnapshot, session.guests?.background,
    ...references(session).map(item => `Background reference: ${item.name}\n${item.content}`)
  ].filter(Boolean).join("\n\n");
  const persistedSelection = selectedInsights.length > 0 && selectedInsights.every(item => item.persistedId);
  const artifactId = persistedSelection && selectedInsights.length === 1 ? selectedInsights[0].id : createHash("sha256").update(JSON.stringify({ sessionId: session.id, selectedIds: selectedIds ? [...selectedIds].sort() : null, snapshot: sourceSnapshot, content })).digest("hex");
  const question = selectedInsights.length === 1 ? selected?.question || selected.summary : selectedInsights.length > 1 ? selectedInsights.map(item => item.question || item.summary).join("; ") : session.topic;
  return { content, sourceSnapshot, question, artifactId, identityKind: persistedSelection ? "persisted-insight" : "snapshot" };
}
