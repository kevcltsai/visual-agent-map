import { randomUUID } from "node:crypto";
import { baselineFromVersions, type CoffeeInsight } from "./insights";
import type { CoffeeSession } from "./types";

export interface CoffeeSource {
  content: string;
  sourceSnapshot: string;
  question: string;
  artifactId: string;
  identityKind: "persisted-insight" | "snapshot";
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
    background: session.guests?.background ?? "", references: references(session)
  });
}
function insightText(item: CoffeeInsight): string {
  return [item.summary, item.detail, item.question, item.proposedSolution, item.limitations].filter(Boolean).join("\n\n");
}
const normalize = (text: string): string => text.normalize("NFKC").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
export function buildCoffeeSource(session: CoffeeSession, insightId?: string): CoffeeSource {
  const insights = baselineFromVersions(session.observerNotes ?? [], session.language);
  const selected = insightId ? insights.find(item => item.id === insightId) : undefined;
  if (insightId && !selected) throw new Error("The selected insight changed; reopen the latest table.");
  const dialogue = (session.rounds?.length ? session.rounds.filter(item => item.markdown.trim()).map(item => item.status === "completed" ? item.markdown : `Saved segment (${item.status}):\n${item.markdown}`) : [session.transcriptMarkdown]).filter(Boolean);
  const answers = session.questions.filter(item => item.status === "complete").map(item => `${item.question}\n${item.answer}`);
  const committed = [...dialogue, ...answers];
  const unresolved: string[] = [], excerpts: string[] = [];
  for (const source of selected?.sources ?? []) {
    const needle = normalize(source);
    let count = 0;
    for (const text of committed) {
      const haystack = normalize(text); let at = 0;
      while (needle && (at = haystack.indexOf(needle, at)) >= 0) { count++; at += needle.length; }
    }
    if (count === 1) excerpts.push(source); else unresolved.push(source);
  }
  const snapshotText = selected ? [insightText(selected), `Category: ${selected.category}`, selected.sources.length ? `Original source annotations (not proof): ${JSON.stringify(selected.sources)}` : ""].filter(Boolean).join("\n\n") : (session.observerNotes ?? []).join("\n\n") || "No cumulative insight snapshot was available.";
  const status = ["Simulated Coffee Tables discussion. All ideas are unverified candidates, not the user's conclusion.", session.dirtyNotes ? "Observer notes are stale / not updated after conversation edits." : ""].filter(Boolean).join("\n");
  const sourceSnapshot = [status, snapshotText].join("\n\n");
  const content = selected ? [session.topic, status, sourceSnapshot, excerpts.length ? `Uniquely verified source excerpts:\n${excerpts.join("\n\n")}` : "No uniquely located dialogue source.", unresolved.length ? `Unresolved source annotations (not verified excerpts):\n${JSON.stringify(unresolved)}` : ""].filter(Boolean).join("\n\n") : [
    session.topic, status, ...committed,
    ...(session.interventions ?? []).filter(item => item.status === "sent" || item.status === undefined).map(item => `Saved user intervention: ${item.text}`),
    sourceSnapshot, session.guests?.background,
    ...references(session).map(item => `Background reference: ${item.name}\n${item.content}`)
  ].filter(Boolean).join("\n\n");
  return { content, sourceSnapshot, question: selected?.question || selected?.summary || session.topic, artifactId: selected?.persistedId ? selected.id : randomUUID(), identityKind: selected?.persistedId ? "persisted-insight" : "snapshot" };
}
