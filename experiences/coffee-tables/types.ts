import type { UiLanguage } from "../../i18n";
import type { CoffeeCustomization, CoffeeConvergenceDraft } from "./customization";
import { convergenceSelectionRevision, normalizeCustomization } from "./customization";

export type GuestCategory = "experts" | "cross-domain" | "generalist" | "affected";
export type GuestCounts = Record<GuestCategory, number>;
export interface NamedGuest { id: string; category: GuestCategory; description: string; identity?: string; role?: string; prompt?: string; templateId?: string }
export interface CoffeePersonaTemplate { id: string; identity: string; category: GuestCategory; role: string; description: string; prompt: string }
export interface CoffeeGuestInvitation { id: string; name: string; category: GuestCategory; description: string }
export interface CoffeeStyle { id: string; name: string; prompt: string; customization?: CoffeeCustomization }
export interface CoffeeReference { name: string; content: string }
export interface GuestSettings { counts: GuestCounts; guests: NamedGuest[]; background: string; customPrompt: string; styleId?: string; styleName?: string; stylePrompt?: string; customization?: CoffeeCustomization; referenceFiles?: CoffeeReference[]; hostCount?: number }
export interface CoffeeQuestion { summary?: string; id: string; question: string; answer: string; draftAnswer?: string; invitedGuests?: CoffeeGuestInvitation[]; status: "pending" | "complete" | "error"; error?: string; createdAt?: string }
export interface CoffeeIntervention { id: string; kind: "comment" | "guest-question" | "redirect"; target?: string; text: string; createdAt: string; status?: "pending" | "sent" | "failed"; roundId?: string; afterTurn?: number }
export interface CoffeeRound { summary?: string; kind?: "initial" | "continuation" | "legacy"; id: string; markdown: string; notes: string; draftMarkdown?: string; status: "generating" | "completed" | "error"; createdAt: string }
export interface CoffeeSession {
  version: 3; id: string; topic: string; language: UiLanguage; model: string; reasoning: string;
  createdAt: string; updatedAt: string; lastGenerationStartedAt?: string; lastCompletedAt?: string; status: "ready" | "generating" | "completed" | "error";
  transcriptMarkdown: string; questions: CoffeeQuestion[]; error?: string; draftMarkdown?: string; observerDraftMarkdown?: string;
  guests?: GuestSettings; rounds?: CoffeeRound[]; observerNotes?: string[]; dirtyNotes?: boolean;
  convergenceDraft?: CoffeeConvergenceDraft; convergenceRawDraft?: string; convergenceUndo?: { notes: string[]; expectedNotes: string[] }; pinnedInsightIds?: string[];
  interventions?: CoffeeIntervention[];
  referenceFiles?: CoffeeReference[];
}
export interface LegacyCoffeeSession {
  version: 1; id: string; topic: string; language: UiLanguage; model: string; reasoning: string;
  createdAt: string; updatedAt: string; status: string; participants: Array<{ id: string; name: string; role: string; lens: string }>;
  messages: Array<{ id: string; speakerId: string; text: string; replyTo: string | null; move: string; targetId: string | null; createdAt: string }>;
  nextSpeakerId: string; segmentStart: number; notes: { connections: string[]; questions: string[]; disagreements: string[]; directions: string[]; assumptions: string[] } | null; endReason: string | null;
}
export type AnyCoffeeSession = CoffeeSession | LegacyCoffeeSession;
export interface CoffeeRequest { prompt: string; session: CoffeeSession; signal: AbortSignal; onText?: (text: string) => void; registerIntervention?: (handler: (text: string) => Promise<void>) => void }
export type CoffeeRuntime = (request: CoffeeRequest) => Promise<string>;

const DEFAULT_COUNTS: GuestCounts = { experts: 1, "cross-domain": 0, generalist: 0, affected: 1 };
const CATEGORIES: GuestCategory[] = ["experts", "cross-domain", "generalist", "affected"];
function isCoffeeReference(value: unknown): value is CoffeeReference { return !!value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string" && typeof (value as { content?: unknown }).content === "string"; }
function normalizedGuests(value: unknown, language: string): GuestSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.counts && typeof raw.counts === "object") {
    const source = raw.counts as Record<string, unknown>;
    const counts = Object.fromEntries(CATEGORIES.map(key => [key, Number.isInteger(source[key]) ? Number(source[key]) : -1])) as GuestCounts;
    const guests = Array.isArray(raw.guests) ? raw.guests.filter((item): item is NamedGuest => !!item && typeof item === "object" && typeof (item as NamedGuest).id === "string" && CATEGORIES.includes((item as NamedGuest).category) && typeof (item as NamedGuest).description === "string").map(item => ({...item})) : [];
    const referenceFiles = Array.isArray(raw.referenceFiles) ? (raw.referenceFiles as unknown[]).filter(isCoffeeReference) : undefined;
    // Structured sessions predate the host-count control and used two hosts.
    // New sessions carry their explicit one-host default from createSession.
    return { counts, guests, background: typeof raw.background === "string" ? raw.background : "", customPrompt: typeof raw.customPrompt === "string" ? raw.customPrompt : "", ...(typeof raw.styleId === "string" ? { styleId: raw.styleId } : {}), ...(typeof raw.styleName === "string" ? { styleName: raw.styleName } : {}), ...(typeof raw.stylePrompt === "string" ? { stylePrompt: raw.stylePrompt } : {}), ...(raw.customization && typeof raw.customization === "object" ? { customization: normalizeCustomization(raw.customization, language) } : {}), ...(referenceFiles ? { referenceFiles } : {}), hostCount: Number.isInteger(raw.hostCount) ? Number(raw.hostCount) : 2 };
  }
  const perspectives = Array.isArray(raw.perspectives) ? raw.perspectives.filter((item): item is GuestCategory => CATEGORIES.includes(item as GuestCategory)) : CATEGORIES;
  const counts: GuestCounts = { experts: perspectives.includes("experts") ? 4 : 0, "cross-domain": perspectives.includes("cross-domain") ? 1 : 0, generalist: perspectives.includes("generalist") ? 1 : 0, affected: perspectives.includes("affected") ? 1 : 0 };
  return { counts, guests: [], background: typeof raw.background === "string" ? raw.background : "", customPrompt: "", hostCount: 2 };
}
function normalizedConvergenceDraft(value: unknown, language: string): CoffeeConvergenceDraft | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>, allowed = ["connections", "questions", "disagreements", "directions", "assumptions", "solutions"];
  if (typeof raw.baseFingerprint !== "string" || !Array.isArray(raw.proposals) || typeof raw.raw !== "string" || typeof raw.createdAt !== "string" || !raw.customization || typeof raw.customization !== "object") return undefined;
  const proposals = raw.proposals.filter((item): item is CoffeeConvergenceDraft["proposals"][number] => !!item && typeof item === "object" && Array.isArray((item as { sourceIds?: unknown }).sourceIds) && (item as { sourceIds: unknown[] }).sourceIds.every(id => typeof id === "string") && typeof (item as { summary?: unknown }).summary === "string" && typeof (item as { detail?: unknown }).detail === "string" && allowed.includes(String((item as { category?: unknown }).category)));
  if (proposals.length !== raw.proposals.length) return undefined;
  const draft: CoffeeConvergenceDraft = { baseFingerprint: raw.baseFingerprint, proposals: proposals.map(item => ({ ...item, sourceIds: [...item.sourceIds] })), raw: raw.raw, createdAt: raw.createdAt, customization: normalizeCustomization(raw.customization, language) };
  const proposalKeys = new Set(draft.proposals.map(item => JSON.stringify([item.sourceIds, item.summary, item.detail, item.category])));
  const rawEdits = raw.reviewEdits && typeof raw.reviewEdits === "object" ? raw.reviewEdits as Record<string, unknown> : {};
  const reviewEdits = Object.fromEntries(Object.entries(rawEdits).filter(([key, edit]) => proposalKeys.has(key) && !!edit && typeof edit === "object" && typeof (edit as { summary?: unknown }).summary === "string" && typeof (edit as { detail?: unknown }).detail === "string" && (edit as { summary: string }).summary.length <= 1000 && (edit as { detail: string }).detail.length <= 12000).map(([key, edit]) => [key, { summary: (edit as { summary: string }).summary, detail: (edit as { detail: string }).detail }]));
  if (Object.keys(reviewEdits).length) draft.reviewEdits = reviewEdits;
  const selection = raw.selection && typeof raw.selection === "object" ? raw.selection as { revision?: unknown; proposalKeys?: unknown } : undefined;
  const validSelection = selection?.revision === convergenceSelectionRevision(draft) && Array.isArray(selection.proposalKeys) && selection.proposalKeys.every(key => typeof key === "string")
    ? { revision: selection.revision, proposalKeys: [...new Set(selection.proposalKeys)] }
    : undefined;
  return { ...draft, ...(validSelection ? { selection: validSelection } : {}) };
}
export function createSession(topic: string, model: string, reasoning: string, language: UiLanguage, guests?: GuestSettings): CoffeeSession {
  const now = new Date().toISOString();
  return { version: 3, id: crypto.randomUUID(), topic, model, reasoning, language, createdAt: now, updatedAt: now, status: "ready", transcriptMarkdown: "", questions: [], guests: guests ? normalizedGuests(guests, language) : normalizedGuests({ counts: DEFAULT_COUNTS, guests: [], background: "", customPrompt: "", hostCount: 1 }, language), rounds: [], observerNotes: [] };
}
function normalizeSession(value: Record<string, unknown>): CoffeeSession {
  const questions = Array.isArray(value.questions) ? value.questions.map(item => ({ ...(item as CoffeeQuestion), ...(Array.isArray((item as CoffeeQuestion).invitedGuests) ? { invitedGuests: (item as CoffeeQuestion).invitedGuests!.filter(guest => guest && typeof guest.id === "string" && typeof guest.name === "string" && CATEGORIES.includes(guest.category) && typeof guest.description === "string").map(guest => ({ ...guest })) } : {}), createdAt: typeof (item as CoffeeQuestion).createdAt === "string" ? (item as CoffeeQuestion).createdAt : String(value.createdAt) })) : [];
  const transcript = typeof value.transcriptMarkdown === "string" ? value.transcriptMarkdown : "";
  const rounds = Array.isArray(value.rounds) && (value.rounds.length || !transcript) ? value.rounds as CoffeeRound[] : (transcript ? [{ id: "round-1", markdown: transcript, notes: "", status: (value.status === "completed" ? "completed" : "error") as CoffeeRound["status"], createdAt: String(value.createdAt) }] : []);
  const rawDraft = normalizedConvergenceDraft(value.convergenceDraft, String(value.language));
  const savedRawDraft = typeof value.convergenceRawDraft === "string" ? value.convergenceRawDraft : value.convergenceDraft && typeof value.convergenceDraft === "object" && typeof (value.convergenceDraft as { raw?: unknown }).raw === "string" ? (value.convergenceDraft as { raw: string }).raw : undefined;
  const convergenceUndo = value.convergenceUndo && typeof value.convergenceUndo === "object" && Array.isArray((value.convergenceUndo as { notes?: unknown }).notes) && Array.isArray((value.convergenceUndo as { expectedNotes?: unknown }).expectedNotes) && (value.convergenceUndo as { notes: unknown[] }).notes.every(item => typeof item === "string") && (value.convergenceUndo as { expectedNotes: unknown[] }).expectedNotes.every(item => typeof item === "string") ? { notes: [...(value.convergenceUndo as { notes: string[] }).notes], expectedNotes: [...(value.convergenceUndo as { expectedNotes: string[] }).expectedNotes] } : undefined;
  return { ...(value as unknown as CoffeeSession), version: 3, guests: normalizedGuests(value.guests, String(value.language)), rounds, observerNotes: Array.isArray(value.observerNotes) ? value.observerNotes.filter((item): item is string => typeof item === "string") : [], questions, transcriptMarkdown: rounds.map(round => round.markdown).filter(Boolean).join("\n\n"), dirtyNotes: value.dirtyNotes === true, convergenceDraft: rawDraft, convergenceRawDraft: savedRawDraft, convergenceUndo, ...(Array.isArray(value.pinnedInsightIds) ? { pinnedInsightIds: [...new Set(value.pinnedInsightIds.filter((id): id is string => typeof id === "string"))] } : {}) };
}
export function parseSession(raw: string): AnyCoffeeSession {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (value.version === 1) {
    if (typeof value.id !== "string" || typeof value.topic !== "string" || !Array.isArray(value.messages) || !Array.isArray(value.participants)) throw new Error("Invalid legacy Coffee Tables session");
    return value as unknown as LegacyCoffeeSession;
  }
  if (![2, 3].includes(Number(value.version)) || typeof value.id !== "string" || !/^[a-zA-Z0-9-]+$/.test(value.id) || typeof value.topic !== "string" || !value.topic.trim() || !["en", "zh-TW"].includes(String(value.language)) || !["ready", "generating", "completed", "error"].includes(String(value.status)) || typeof value.model !== "string" || typeof value.reasoning !== "string" || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string" || typeof value.transcriptMarkdown !== "string" || !Array.isArray(value.questions)) throw new Error("Invalid Coffee Tables session");
  const session = normalizeSession(value); const ids = new Set<string>();
  if (session.referenceFiles !== undefined && (!Array.isArray(session.referenceFiles) || session.referenceFiles.some(item => !item || typeof item.name !== "string" || typeof item.content !== "string"))) throw new Error("Invalid Coffee Tables reference files");
  if (session.draftMarkdown !== undefined && typeof session.draftMarkdown !== "string") throw new Error("Invalid conversation draft");
  if (session.observerDraftMarkdown !== undefined && typeof session.observerDraftMarkdown !== "string") throw new Error("Invalid observer notes draft");
  if (session.interventions !== undefined && (!Array.isArray(session.interventions) || !session.interventions.every(item => item && typeof item.id === "string" && ["comment", "guest-question", "redirect"].includes(item.kind) && typeof item.text === "string"))) throw new Error("Invalid Coffee Tables interventions");
  let invitedTotal = 0; const invitedIds = new Set<string>();
  for (const item of session.questions) {
    if (!item || typeof item.id !== "string" || ids.has(item.id) || typeof item.question !== "string" || !item.question.trim() || typeof item.answer !== "string" || (item.draftAnswer !== undefined && typeof item.draftAnswer !== "string") || !["pending", "complete", "error"].includes(item.status)) throw new Error("Invalid Coffee Tables question");
    ids.add(item.id);
    for (const guest of item.invitedGuests ?? []) {
      if (!guest || typeof guest.id !== "string" || invitedIds.has(guest.id) || !guest.name.trim() || guest.name.length > 60 || !guest.description.trim() || guest.description.length > 160 || !CATEGORIES.includes(guest.category)) throw new Error("Invalid Coffee Tables follow-up guest");
      invitedIds.add(guest.id);
      if (item.status === "complete") invitedTotal++;
    }
  }
  const total = Object.values(session.guests?.counts ?? {}).reduce((sum, value) => sum + value, 0);
  if (session.guests && (total < 1 || total + invitedTotal > 12 || Object.values(session.guests.counts).some(value => !Number.isInteger(value) || value < 0 || value > 8) || !Number.isInteger(session.guests.hostCount) || session.guests.hostCount! < 1 || session.guests.hostCount! > 4 || session.guests.guests.some(guest => session.guests!.guests.filter(item => item.category === guest.category).length > session.guests!.counts[guest.category]))) throw new Error("Invalid Coffee Tables guest count");
  return session;
}
export function copyLegacySession(legacy: LegacyCoffeeSession): CoffeeSession {
  const lines = [`# ${legacy.topic}`, "", "> 較早版本的模擬對談；以下內容照原紀錄保留。", ""];
  for (const message of legacy.messages) { const person = legacy.participants.find(entry => entry.id === message.speakerId); lines.push(`### ${person ? `${person.name} · ${person.role}` : message.speakerId === "user" ? "使用者" : message.speakerId}`, "", message.text, ""); }
  if (legacy.notes) { const titles = ["意外連結", "值得繼續想的問題", "核心分歧", "探索方向", "值得查證的假設"]; ["connections", "questions", "disagreements", "directions", "assumptions"].forEach((key, index) => lines.push(`### ${titles[index]}`, "", ...(legacy.notes?.[key as keyof typeof legacy.notes] ?? []).map(item => `- ${item}`), "")); }
  const session = createSession(legacy.topic, legacy.model, legacy.reasoning, legacy.language); session.createdAt = legacy.createdAt; session.updatedAt = new Date().toISOString(); session.status = "completed"; session.transcriptMarkdown = lines.join("\n"); session.rounds = [{ id: "round-1", markdown: session.transcriptMarkdown, notes: "", status: "completed", createdAt: legacy.createdAt }]; return session;
}
