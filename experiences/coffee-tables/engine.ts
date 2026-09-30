import { assembleCoffeeContext, MAX_COFFEE_CONTEXT_CHARS, observerOnlyPrompt, questionPrompt, tablePrompt } from "./prompts";
import type { CoffeeRound, CoffeeRuntime, CoffeeSession } from "./types";

type SaveSession = (session: CoffeeSession) => Promise<void>;
export function splitObserverNotes(markdown: string): { dialogue: string; notes: string } {
  const match = /^# (?:觀察者整理|Observer(?:[’']s)? notes)\s*$/m.exec(markdown);
  if (!match || match.index < 0) return { dialogue: markdown.trim(), notes: "" };
  return { dialogue: markdown.slice(0, match.index).trim(), notes: markdown.slice(match.index).trim() };
}
function noteSections(notes: string): string[] {
  if (!notes) return [];
  const groups = [...notes.matchAll(/^(?:## .+|\s*[-*]\s+\*\*[^*\n]{2,}\*\*\s*)$/gm)];
  if (groups.length >= 4) {
    const populated = groups.filter((group, index) => {
      const start = (group.index ?? 0) + group[0].length;
      const end = groups[index + 1]?.index ?? notes.length;
      return /^\s*[-*]\s+\S/m.test(notes.slice(start, end));
    });
    if (populated.length >= 4) return [notes];
  }
  // Models sometimes honor the observer role but return a concise prose synthesis
  // instead of the requested five headings. Accept a substantial, multi-paragraph
  // synthesis while still rejecting a heading followed by a fragment or one-liner.
  const body = notes.replace(/^# (?:觀察者整理|Observer(?:[’']s)? notes)\s*$/m, "").trim();
  const paragraphs = body.split(/\n\s*\n/).map(paragraph => paragraph.replace(/^[-*]\s+/, "").trim());
  const endsAsCompleteSentence = (paragraph: string): boolean => /[。！？.!?…](?:[」』”’"\])）】}]*)$/u.test(paragraph);
  return paragraphs.length >= 2 && paragraphs.every(paragraph => paragraph.length >= 30 && endsAsCompleteSentence(paragraph)) ? [notes] : [];
}
const COMPLETION_MARKER = /\s*<!-- coffee-tables-complete -->\s*$/;
function stripCompletionMarker(markdown: string): string { return markdown.replace(COMPLETION_MARKER, "").trim(); }
function appendDraft(draft: string, continuation: string): string { const left = draft.trim(), right = continuation.trim(); return !left ? right : !right || right.startsWith(left) ? right || left : `${left}\n\n${right}`; }
export class CoffeeEngine {
  busy = false; error = "";
  private controller: AbortController | null = null; private pending: Promise<void> | null = null; private generation = 0; private deleting = false; private retired = false;
  private persistQueue: Promise<void> = Promise.resolve(); private checkpoint: number | null = null; private persistenceError = "";
  private steer: ((text: string) => Promise<void>) | null = null; private queuedSteers: string[] = []; private interventionTasks = new Set<Promise<void>>();
  startedAt = 0; private readonly listeners = new Set<() => void>();
  constructor(public session: CoffeeSession, private runtime: CoffeeRuntime, private saveSession: SaveSession) {}
  get acceptsInterventions(): boolean { return this.busy && this.session.status === "generating"; }
  get persistenceFailed(): boolean { return !!this.persistenceError; }
  get deleted(): boolean { return this.retired; }
  beginDelete(): void { if (this.retired) return; this.deleting = true; this.cancel(); this.changed(); }
  cancelDelete(): void { if (!this.retired) { this.deleting = false; this.changed(); } }
  retire(): void { this.deleting = true; this.retired = true; this.generation++; this.cancel(); this.changed(); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void { for (const listener of this.listeners) listener(); }
  private setSession(next: CoffeeSession): void { this.session = { ...next, updatedAt: new Date().toISOString() }; this.changed(); }
  private persist(): Promise<void> { if (this.retired) return Promise.resolve(); const snapshot: CoffeeSession = { ...this.session, questions: this.session.questions.map(question => ({ ...question })), rounds: (this.session.rounds ?? []).map(round => ({ ...round })) }; this.persistQueue = this.persistQueue.catch(() => undefined).then(() => this.retired ? undefined : this.saveSession(snapshot)); return this.persistQueue; }
  async persistCurrent(): Promise<void> { await this.flush(); }
  async retrySave(): Promise<void> { if (this.deleting || this.retired) return; this.persistenceError = ""; this.error = ""; this.setSession({ ...this.session, error: undefined }); await this.flush(); this.changed(); }
  reportPersistenceError(error: unknown): void { this.persistenceError = error instanceof Error ? error.message : String(error); this.error = this.persistenceError; this.changed(); }
  private scheduleCheckpoint(): void { if (this.checkpoint !== null) return; this.checkpoint = window.setTimeout(() => { this.checkpoint = null; void this.persist().catch(error => { this.reportPersistenceError(error); this.cancel(); }); }, 1000); }
  private async flush(): Promise<void> { if (this.checkpoint !== null) { window.clearTimeout(this.checkpoint); this.checkpoint = null; } await this.persist(); }
  private updateDraft(text: string, roundId?: string, questionId?: string): void {
    if (questionId) this.setSession({ ...this.session, questions: this.session.questions.map(item => item.id === questionId ? { ...item, draftAnswer: text } : item) });
    else if (roundId) this.setSession({ ...this.session, draftMarkdown: text, rounds: (this.session.rounds ?? []).map(item => item.id === roundId ? { ...item, draftMarkdown: text, status: "generating" } : item) });
    else this.setSession({ ...this.session, draftMarkdown: text });
    this.scheduleCheckpoint();
  }
  start(): Promise<void> { if (this.deleting || this.retired) return Promise.resolve(); if (this.pending || this.busy) return this.pending ?? Promise.resolve(); if (this.session.status === "completed") return Promise.resolve(); if (this.session.status === "error" && this.recoverCompleteDraft()) return this.pending!; return this.runRound((this.session.rounds?.length ?? 0) > 0 ? "continuation" : "initial"); }
  private recoverCompleteDraft(): Promise<void> | null {
    const savedDraft = this.session.draftMarkdown ?? [...(this.session.rounds ?? [])].reverse().find(round => round.draftMarkdown)?.draftMarkdown ?? "";
    if (!COMPLETION_MARKER.test(savedDraft)) return null;
    const draft = stripCompletionMarker(savedDraft);
    const noteHeadings = [...draft.matchAll(/^# (?:觀察者整理|Observer(?:[’']s)? notes)\s*$/gm)];
    const latestNotesHeading = noteHeadings.at(-1);
    const notes = latestNotesHeading ? draft.slice(latestNotesHeading.index).trim() : "";
    const parts = draft.split(/(?=^### )/gm), introduction = (parts[0]?.startsWith("### ") ? "" : parts.shift() ?? "").split(/^# (?:觀察者整理|Observer(?:[’']s)? notes)\s*$/m)[0].trim();
    const draftRoundIds = new Set((this.session.rounds ?? []).filter(round => round.draftMarkdown).map(round => round.id));
    const hasDraftInterventions = (this.session.interventions ?? []).some(item => item.roundId && draftRoundIds.has(item.roundId));
    const seen = new Set<string>();
    const speeches = parts.map(part => part.split(/^# (?:觀察者整理|Observer(?:[’']s)? notes)\s*$/m)[0].trim()).filter(part => {
      if (!part.startsWith("### ") || (!hasDraftInterventions && seen.has(part))) return false;
      seen.add(part); return true;
    });
    const dialogue = [introduction, ...speeches].filter(Boolean).join("\n\n");
    if (!dialogue || !noteSections(notes).length) return null;
    const draftRounds = (this.session.rounds ?? []).filter(round => round.draftMarkdown);
    const roundId = draftRounds.at(-1)?.id ?? crypto.randomUUID();
    const round: CoffeeRound = { id: roundId, markdown: dialogue, notes, status: "completed", createdAt: draftRounds[0]?.createdAt ?? new Date().toISOString() };
    const completedRounds = (this.session.rounds ?? []).filter(item => !item.draftMarkdown && item.status === "completed");
    const draftRoundIdsForInterventions = new Set(draftRounds.map(item => item.id));
    const interventions = (this.session.interventions ?? []).map(item => item.roundId && draftRoundIdsForInterventions.has(item.roundId) ? { ...item, roundId } : item);
    const rounds = [...completedRounds, round];
    this.setSession({ ...this.session, rounds, interventions, transcriptMarkdown: rounds.map(item => item.markdown).filter(Boolean).join("\n\n"), observerNotes: [notes, ...(this.session.observerNotes ?? []).filter(item => item !== notes)], draftMarkdown: undefined, dirtyNotes: false, status: "completed", lastCompletedAt: new Date().toISOString(), error: undefined });
    const pending = this.flush().finally(() => { if (this.pending === pending) this.pending = null; this.changed(); }); this.pending = pending; return pending;
  }
  private async recoverResolvedStreamDraft(previousDraft: string): Promise<boolean> {
    const draft = this.session.draftMarkdown ?? "", notesHeadings = [...draft.matchAll(/^# (?:觀察者整理|Observer(?:[’']s)? notes)\s*$/gm)], latest = notesHeadings.at(-1);
    if (!latest || (latest.index ?? 0) < previousDraft.length || !noteSections(draft.slice(latest.index)).length) return false;
    // The runtime promise resolved, so this exact stream reached the provider's completion event.
    this.setSession({ ...this.session, draftMarkdown: `${draft.trim()}\n\n<!-- coffee-tables-complete -->` });
    await this.flush(); const recovered = this.recoverCompleteDraft(); if (!recovered) return false; await recovered; return this.session.status === "completed";
  }
  continueTable(): Promise<void> { if (this.deleting || this.retired) return Promise.resolve(); if (this.pending || this.busy || this.session.status !== "completed") return this.pending ?? Promise.resolve(); return this.runRound("continuation"); }
  refreshObserverNotes(): Promise<void> {
    if (this.deleting || this.retired || this.pending || this.busy || this.persistenceError) return this.pending ?? Promise.resolve();
    const previousObserverDraft = this.session.observerDraftMarkdown ?? "", source = observerOnlyPrompt(this.session), generation = ++this.generation, controller = new AbortController();
    this.controller = controller; this.busy = true; this.startedAt = Date.now(); this.error = ""; this.persistenceError = "";
    this.setSession({ ...this.session, observerDraftMarkdown: previousObserverDraft, dirtyNotes: true, lastGenerationStartedAt: new Date().toISOString() });
    const pending = (async () => {
      try {
        await this.flush(); let streamed = previousObserverDraft;
        const response = await this.runtime({ prompt: source, session: this.session, signal: controller.signal, onText: text => { if (this.generation !== generation || controller.signal.aborted) return; streamed = appendDraft(previousObserverDraft, text); this.setSession({ ...this.session, observerDraftMarkdown: streamed, dirtyNotes: true }); this.scheduleCheckpoint(); } });
        if (this.generation !== generation || controller.signal.aborted) return;
        let candidate = stripCompletionMarker(response), notes = candidate;
        if (!noteSections(notes).length && noteSections(stripCompletionMarker(streamed)).length) notes = stripCompletionMarker(streamed);
        if (!noteSections(notes).length) throw new Error(this.session.language === "zh-TW" ? "整理未完整收到；原有整理仍保留，草稿已保存。" : "The notes were incomplete. Earlier notes are preserved and the draft is saved.");
        this.setSession({ ...this.session, observerNotes: [notes, ...(this.session.observerNotes ?? []).filter(item => item !== notes)], observerDraftMarkdown: undefined, dirtyNotes: false, error: undefined });
        await this.flush();
      } catch (error) {
        if (this.generation === generation) { this.error = controller.signal.aborted ? (this.session.language === "zh-TW" ? "整理已停止；草稿已保存。" : "Notes stopped; the draft is saved.") : error instanceof Error ? error.message : String(error); this.setSession({ ...this.session, dirtyNotes: true }); await this.flush().catch(saveError => this.reportPersistenceError(saveError)); }
      } finally { if (this.generation === generation) { this.busy = false; this.controller = null; this.pending = null; this.changed(); } }
    })(); this.pending = pending; this.changed(); return pending;
  }
  generate(): Promise<void> { return this.start(); }
  private runRound(kind: "initial" | "continuation"): Promise<void> {
    this.steer = null; this.queuedSteers = []; this.persistenceError = "";
    const generation = ++this.generation, controller = new AbortController(), roundId = crypto.randomUUID(), previousDraft = this.session.status === "error" ? this.session.draftMarkdown ?? this.session.rounds?.at(-1)?.draftMarkdown ?? "" : kind === "initial" ? this.session.draftMarkdown ?? "" : "";
    const context = kind === "continuation" ? assembleCoffeeContext(this.session) : "";
    if (context.length + previousDraft.length > MAX_COFFEE_CONTEXT_CHARS) return Promise.reject(new Error(this.session.language === "zh-TW" ? "這桌的內容太長，無法安全地全部交給模型。請先開新桌；舊內容已完整保留。" : "This table is too long to send safely in full. Start a new table; the existing conversation is preserved."));
    const round: CoffeeRound = { id: roundId, markdown: "", notes: "", ...(previousDraft ? { draftMarkdown: previousDraft } : {}), status: "generating", createdAt: new Date().toISOString() };
    this.controller = controller; this.busy = true; this.startedAt = Date.now(); this.error = "";
    this.setSession({ ...this.session, status: "generating", lastGenerationStartedAt: new Date().toISOString(), error: undefined, rounds: [...(this.session.rounds ?? []), round] });
    const pending = (async () => {
      try {
        await this.flush();
        const prompt = tablePrompt(this.session.topic, this.session.language, this.session.guests, previousDraft, context);
        const response = await this.runtime({ prompt, session: this.session, signal: controller.signal, onText: text => { if (this.generation === generation && !controller.signal.aborted) this.updateDraft(previousDraft ? `${previousDraft}\n\n${text}` : text, roundId); }, registerIntervention: steer => { if (this.generation !== generation || controller.signal.aborted) return; this.steer = steer; for (const queued of this.queuedSteers.splice(0)) void this.deliverIntervention(queued, steer, generation, controller).catch(() => undefined); } });
        if (this.generation !== generation) return;
        if (controller.signal.aborted) { await this.finishInterrupted(new Error("Generation stopped"), generation, controller, roundId); return; }
        const finalText = stripCompletionMarker(response); if (!finalText) throw new Error("The model returned an empty conversation");
        const { dialogue, notes } = splitObserverNotes(finalText); if (!dialogue || !noteSections(notes).length) {
          if (await this.recoverResolvedStreamDraft(previousDraft)) return;
          throw new Error(this.session.language === "zh-TW" ? "對談已收到，但觀察者整理格式不完整；本段已保留草稿，舊整理仍保留。" : "The conversation arrived without a complete observer summary. This segment is saved as a draft; earlier notes are kept.");
        }
        const resumedDialogue = previousDraft ? splitObserverNotes(previousDraft).dialogue : "";
        const completed = (this.session.rounds ?? []).map(item => item.id === roundId ? { ...item, markdown: [resumedDialogue, dialogue].filter(Boolean).join("\n\n"), notes, draftMarkdown: undefined, status: "completed" as const } : item).map(item => previousDraft && item.id !== roundId && item.draftMarkdown ? { ...item, draftMarkdown: undefined } : item).filter(item => item.markdown || item.status !== "error" || item.draftMarkdown);
        const resumedRoundIds = new Set((this.session.rounds ?? []).filter(item => previousDraft && item.draftMarkdown).map(item => item.id));
        const interventions = (this.session.interventions ?? []).map(item => item.roundId && resumedRoundIds.has(item.roundId) ? { ...item, roundId, afterTurn: item.afterTurn ?? 0 } : item);
        this.setSession({ ...this.session, rounds: completed, interventions, transcriptMarkdown: completed.map(item => item.markdown).filter(Boolean).join("\n\n"), observerNotes: [notes, ...(this.session.observerNotes ?? [])], dirtyNotes: false, draftMarkdown: undefined, status: "completed", lastCompletedAt: new Date().toISOString(), error: undefined }); await this.flush();
      } catch (error) { await this.finishInterrupted(error, generation, controller, roundId); }
      finally { if (this.generation === generation) { this.busy = false; this.controller = null; this.pending = null; this.steer = null; this.queuedSteers = []; this.changed(); } }
    })(); this.pending = pending; this.changed(); return pending;
  }
  async intervene(kind: "comment" | "guest-question" | "redirect", text: string, target?: string): Promise<void> {
    const value = text.trim(); if (this.deleting || this.retired || !this.busy || this.controller?.signal.aborted || !value) return;
    const generation = this.generation, controller = this.controller!;
    const instruction = kind === "guest-question" ? `The user asks ${target ? `${target} ` : "a guest "}to respond to this question: ${value}. Let that person answer naturally and keep the discussion moving.` : kind === "redirect" ? `The user wants to redirect the discussion: ${value}. Acknowledge this briefly and continue in the new direction.` : `The user adds this comment: ${value}. Respond naturally if relevant, then continue the discussion.`;
    const activeRound = [...(this.session.rounds ?? [])].reverse().find(item => item.status === "generating");
    const streamed = this.session.draftMarkdown ?? "", afterTurn = (streamed.match(/^### .+$/gm) ?? []).length;
    const entry = { id: crypto.randomUUID(), kind, ...(target ? { target } : {}), text: value, createdAt: new Date().toISOString(), status: "pending" as const, ...(activeRound ? { roundId: activeRound.id, afterTurn } : {}) };
    this.setSession({ ...this.session, interventions: [...(this.session.interventions ?? []), entry] }); await this.flush(); if (generation !== this.generation || controller.signal.aborted) return;
    if (this.steer) await this.deliverIntervention(`${entry.id}\n${instruction}`, this.steer, generation, controller); else this.queuedSteers.push(`${entry.id}\n${instruction}`);
  }
  private deliverIntervention(payload: string, steer: (text: string) => Promise<void>, generation: number, controller: AbortController): Promise<void> {
    const separator = payload.indexOf("\n"), id = payload.slice(0, separator), instruction = payload.slice(separator + 1);
    const task = (async () => { try { await steer(instruction); if (generation !== this.generation || controller.signal.aborted) return; this.setSession({ ...this.session, interventions: (this.session.interventions ?? []).map(item => item.id === id ? { ...item, status: "sent" } : item) }); await this.flush(); }
      catch (error) { if (generation === this.generation && !controller.signal.aborted) { this.setSession({ ...this.session, interventions: (this.session.interventions ?? []).map(item => item.id === id ? { ...item, status: "failed" } : item) }); this.error = error instanceof Error ? error.message : String(error); await this.flush().catch(saveError => this.reportPersistenceError(saveError)); } throw error; } })();
    this.interventionTasks.add(task); void task.finally(() => this.interventionTasks.delete(task)).catch(() => undefined); return task;
  }
  private async finishInterrupted(error: unknown, generation: number, controller: AbortController, id?: string, questionId?: string): Promise<void> {
    if (this.generation !== generation) return;
    this.error = this.persistenceError || (controller.signal.aborted ? "" : error instanceof Error ? error.message : String(error));
    if (questionId) this.setSession({ ...this.session, questions: this.session.questions.map(item => item.id === questionId ? { ...item, status: "error", error: this.error || "Cancelled" } : item), dirtyNotes: true });
    else if (id) this.setSession({ ...this.session, status: "error", error: this.error || "Generation stopped", rounds: (this.session.rounds ?? []).map(item => item.id === id ? { ...item, status: "error" } : item) });
    try { await this.flush(); } catch (saveError) { this.reportPersistenceError(saveError); }
  }
  async ask(question: string, id: string = crypto.randomUUID()): Promise<void> {
    if (this.pending || this.busy || this.session.status !== "completed") return;
    const value = question.trim(); if (!value || this.deleting || this.retired) return;
    const existing = this.session.questions.find(item => item.id === id), previousDraft = existing?.draftAnswer ?? "", entry = existing ? { ...existing, question: value, status: "pending" as const, error: undefined } : { id, question: value, answer: "", status: "pending" as const, createdAt: new Date().toISOString() };
    const generation = ++this.generation, controller = new AbortController(); this.controller = controller; this.busy = true; this.startedAt = Date.now(); this.error = ""; this.steer = null; this.queuedSteers = []; this.persistenceError = "";
    this.setSession({ ...this.session, lastGenerationStartedAt: new Date().toISOString(), questions: existing ? this.session.questions.map(item => item.id === id ? entry : item) : [...this.session.questions, entry] });
    const pending = (async () => { try {
      await this.flush(); let streamed = ""; const response = await this.runtime({ prompt: questionPrompt(this.session, value, previousDraft), session: this.session, signal: controller.signal, onText: text => { if (this.generation === generation && !controller.signal.aborted) { streamed = appendDraft(previousDraft, text); this.updateDraft(streamed, undefined, id); } } });
      if (this.generation !== generation) return; if (controller.signal.aborted) { await this.finishInterrupted(new Error("Generation stopped"), generation, controller, undefined, id); return; }
      let { dialogue, notes } = splitObserverNotes(stripCompletionMarker(response)); if ((!dialogue || !noteSections(notes).length) && streamed) { const fromStream = splitObserverNotes(stripCompletionMarker(streamed)); if (fromStream.dialogue && noteSections(fromStream.notes).length) ({ dialogue, notes } = fromStream); }
      if (!dialogue || !noteSections(notes).length) throw new Error(this.session.language === "zh-TW" ? "追問回答或觀察者整理不完整，請保留草稿後重試。" : "The answer or observer notes are incomplete. The draft is saved for retry.");
      const previousDialogue = splitObserverNotes(previousDraft).dialogue;
      const answer = appendDraft(previousDialogue, dialogue);
      this.setSession({ ...this.session, questions: this.session.questions.map(item => item.id === id ? { ...item, answer, draftAnswer: undefined, status: "complete", error: undefined } : item), observerNotes: [notes, ...(this.session.observerNotes ?? []).filter(item => item !== notes)], dirtyNotes: false, lastCompletedAt: new Date().toISOString() }); await this.flush();
    } catch (error) { await this.finishInterrupted(error, generation, controller, undefined, id); }
      finally { if (this.generation === generation) { this.busy = false; this.controller = null; this.pending = null; this.steer = null; this.queuedSteers = []; this.changed(); } } })(); this.pending = pending; await pending;
  }
  cancel(): void { this.controller?.abort(); }
  async stop(): Promise<void> { this.cancel(); await this.pending; await Promise.allSettled([...this.interventionTasks]); if (this.checkpoint !== null) await this.flush().catch(error => this.reportPersistenceError(error)); await this.persistQueue.catch(error => this.reportPersistenceError(error)); }
}
export class CoffeeManager {
  private engines = new Map<string, CoffeeEngine>(); private deletingIds = new Set<string>(); private deletedIds = new Set<string>(); constructor(private runtime: CoffeeRuntime, private saveSession: SaveSession) {}
  open(session: CoffeeSession): CoffeeEngine { if (this.deletingIds.has(session.id) || this.deletedIds.has(session.id)) throw new Error("This Coffee Tables session is being deleted or was deleted; reload it after restoring it"); const cached = this.engines.get(session.id); if (cached) return cached; if (session.status === "generating") session = { ...session, status: "error", error: "Generation stopped when Obsidian closed; saved draft is available." }; const engine = new CoffeeEngine(session, this.runtime, this.saveSession); this.engines.set(session.id, engine); if (session.status === "error") void engine.persistCurrent().catch(error => engine.reportPersistenceError(error)); return engine; }
  forget(id: string): void { this.engines.delete(id); }
  get(id: string): CoffeeEngine | undefined { return this.engines.get(id); }
  async prepareDelete(id: string): Promise<CoffeeEngine | undefined> { this.deletingIds.add(id); const engine = this.engines.get(id); engine?.beginDelete(); try { await engine?.stop(); return engine; } catch (error) { this.cancelDelete(id, engine); throw error; } }
  completeDelete(id: string, engine: CoffeeEngine | undefined): void { engine?.retire(); if (this.engines.get(id) === engine) this.engines.delete(id); this.deletingIds.delete(id); this.deletedIds.add(id); }
  cancelDelete(id: string, engine: CoffeeEngine | undefined): void { this.deletingIds.delete(id); engine?.cancelDelete(); }
  restore(id: string): void { this.deletedIds.delete(id); }
  async stop(): Promise<void> { await Promise.all([...this.engines.values()].map(engine => engine.stop())); this.engines.clear(); }
}
