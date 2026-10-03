import { normalizePath, TFile, TFolder, type Vault } from "obsidian";
import { copyLegacySession, parseSession, type AnyCoffeeSession, type CoffeeReference, type CoffeeRound, type CoffeeSession, type LegacyCoffeeSession } from "./types";
import { splitObserverNotes } from "./engine";
import { baselineFromVersions, serializeInsightNotes } from "./insights";

export interface CoffeeHandoffSnapshot { session: CoffeeSession; path: string; markdown: string; sidecar: string | null }

const CATEGORY_LABELS: Record<string, [string, string]> = { experts: ["主題專家", "Topic experts"], "cross-domain": ["跨領域專家", "Cross-domain experts"], generalist: ["好奇的通才", "Curious generalists"], affected: ["受影響者", "Affected perspectives"] };
const markdownTopic = (raw: string): string | undefined => {
  let body = raw.replace(/^\uFEFF/, "");
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(body);
  if (frontmatter) body = body.slice(frontmatter[0].length);
  return /^\s*# ([^\r\n]+)(?:\r?\n|$)/.exec(body)?.[1]?.trim() || undefined;
};
function isCoffeeReferenceList(value: unknown): value is CoffeeReference[] { return Array.isArray(value) && value.every(item => !!item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string" && typeof (item as { content?: unknown }).content === "string"); }
function conversationBoundary(raw: string): { index: number; heading: string; navigation?: RegExpExecArray } {
  let start = 0;
  const referenceMarker = /^<!-- coffee-tables-references:([^\n]+) -->$/m.exec(raw);
  if (referenceMarker) {
    try {
      const files: unknown = JSON.parse(decodeURIComponent(referenceMarker[1]));
      if (!isCoffeeReferenceList(files)) throw new Error("Invalid references");
      let end = referenceMarker.index + referenceMarker[0].length;
      for (const file of files) { const at = raw.indexOf(file.content,end); if (at < 0) throw new Error("Reference text missing"); end = at + file.content.length; }
      start = raw.indexOf("\n",end) + 1;
      const closing = /^(?:`{3,}|~{3,})[ \t]*\r?\n/.exec(raw.slice(start)); if (closing) start += closing[0].length;
    } catch { throw new Error("Cannot reliably locate the reference boundary; original data was preserved"); }
  }
  let fence = "", offset = start;
  for (const line of raw.slice(start).split("\n")) {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (match) { if (!fence) fence = match[1]; else if (match[1][0] === fence[0] && match[1].length >= fence.length && !line.slice(match[0].length).trim()) fence = ""; }
    if (!fence && /^## (?:對話紀錄|Conversation)\s*$/.test(line)) {
      const navigation = /<!-- coffee-tables-navigation:([^\n]+) -->[\r\n]*$/.exec(raw.slice(0,offset));
      return {index: offset, heading: line, ...(navigation ? {navigation} : {})};
    }
    offset += line.length + 1;
  }
  throw new Error("Coffee Tables Markdown is missing its conversation section");
}
interface Sidecar { version: 3; id: string; topic: string; language: CoffeeSession["language"]; model: string; reasoning: string; createdAt: string; updatedAt: string; lastGenerationStartedAt?: string; lastCompletedAt?: string; status: CoffeeSession["status"]; error?: string; guests: CoffeeSession["guests"]; rounds: Array<Omit<CoffeeRound, "markdown" | "notes">>; questions: Array<{ summary?: string; id: string; createdAt: string; status: CoffeeSession["questions"][number]["status"]; error?: string; draftAnswer?: string; invitedGuests?: CoffeeSession["questions"][number]["invitedGuests"] }>; interventions?: CoffeeSession["interventions"]; draftMarkdown?: string; observerDraftMarkdown?: string; dirtyNotes?: boolean; revision: number; filePath: string; transcriptHash: string; journal?: { previousMarkdownHash: string; nextMarkdownHash: string; previousSidecar: string; targetMarkdown?: string }; moveJournal?: { previousPath: string; targetPath: string } }
export class CoffeeStorage {
  private originals = new Map<string, string>(); private sidecarOriginals = new Map<string, string>(); private locations = new Map<string, string>(); private revisions = new Map<string, number>(); private activeWrites = new Set<string>(); private activeMoves = new Set<string>(); private deletedIds = new Set<string>();
  readonly folder: string; readonly hidden: string;
  constructor(private vault: Vault, workspace: string, private renameFile?: (file: TFile, path: string) => Promise<void>, private trashFile?: (file: TFile) => Promise<void>) { this.folder = normalizePath(`${workspace}/Coffee Tables`); this.hidden = normalizePath(`${this.folder}/.sessions`); }
  path(id: string, topic?: string): string { if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid session ID"); const slug = topic ? topicSlug(topic) : id; return `${topic ? this.topicFolder(topic) : `${this.folder}/${slug}`}/${slug}.md`; }
  sidecarPath(id: string): string { if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid session ID"); return `${this.hidden}/${id}.json`; }
  sessionPath(id: string): string { return this.locations.get(id) ?? this.path(id); }
  list(): TFile[] { return this.vault.getFiles().filter(file => file.extension === "md" && (file.parent?.path === this.folder || file.parent?.parent?.path === this.folder && !file.parent.name.startsWith(".") )).sort((a, b) => b.stat.mtime - a.stat.mtime); }
  private topicFolder(topic: string): string { const slug = topicSlug(topic).slice(0, 64); return `${this.folder}/${slug}（${shortHash(topic.trim())}）`; }
  private titlePath(topic: string, id: string): string { const directory = this.topicFolder(topic), base = `${directory}/${topicSlug(topic)}.md`, stem = base.slice(0, -3); let path = base, suffix = 2; while (this.vault.getAbstractFileByPath(path) && this.vault.getAbstractFileByPath(path) !== this.vault.getAbstractFileByPath(this.sessionPath(id))) path = `${stem}（${suffix++}）.md`; return path; }
  private async ensureFolder(path: string): Promise<void> { if (path === this.hidden || path.startsWith(`${this.hidden}/`)) { if (await this.vault.adapter.exists(path)) return; try { await this.vault.adapter.mkdir(path); } catch (error) { if (await this.vault.adapter.exists(path)) return; throw error; } return; } const parent = path.slice(0, path.lastIndexOf("/")); if (parent && !this.vault.getAbstractFileByPath(parent)) await this.ensureFolder(parent); const current = this.vault.getAbstractFileByPath(path); if (current) { if (!(current instanceof TFolder)) throw new Error(`Coffee Tables storage path is not a folder: ${path}`); return; } try { await this.vault.createFolder(path); } catch (error) { const raced = this.vault.getAbstractFileByPath(path); if (raced instanceof TFolder) return; if (await this.vault.adapter.exists(path)) { const refreshed = this.vault.getAbstractFileByPath(path); if (!refreshed || refreshed instanceof TFolder) return; } throw error; } }
  private async hiddenPaths(): Promise<string[]> { const listing = await this.vault.adapter.list(this.hidden).catch(() => ({ files: [], folders: [] })); return listing.files.filter(path => new RegExp(`^${this.hidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[a-zA-Z0-9-]+\\.json$`).test(path)); }
  private async readHidden(path: string): Promise<string> { return await this.vault.adapter.read(path); }
  private async writeHidden(path: string, contents: string, expected?: string): Promise<void> { if (expected === undefined) { if (await this.vault.adapter.exists(path)) throw new Error("Coffee Tables hidden session already exists"); await this.vault.adapter.write(path, contents); return; } await this.vault.adapter.process(path, current => { if (current !== expected) throw new Error("Hidden Coffee Tables data changed outside this room; no content was overwritten"); return contents; }); }
  private sidecar(session: CoffeeSession, revision: number, filePath: string): Sidecar {
    const { rounds = [], questions = [] } = session;
    const storedRounds = rounds;
    return { version: 3, id: session.id, topic: session.topic, language: session.language, model: session.model, reasoning: session.reasoning, createdAt: session.createdAt, updatedAt: session.updatedAt, ...(session.lastGenerationStartedAt ? { lastGenerationStartedAt: session.lastGenerationStartedAt } : {}), ...(session.lastCompletedAt ? { lastCompletedAt: session.lastCompletedAt } : {}), status: session.status, ...(session.error ? { error: session.error } : {}), guests: session.guests, rounds: storedRounds.map(({ markdown: _markdown, notes: _notes, ...round }) => round), questions: questions.map(({ id, createdAt, status, error, draftAnswer, invitedGuests, summary }) => ({ summary, id, createdAt: createdAt ?? session.createdAt, status, ...(error ? { error } : {}), ...(draftAnswer ? { draftAnswer } : {}), ...(invitedGuests?.length ? { invitedGuests } : {}) })), ...(session.interventions ? { interventions: session.interventions } : {}), ...(session.draftMarkdown ? { draftMarkdown: session.draftMarkdown } : {}), ...(session.observerDraftMarkdown ? { observerDraftMarkdown: session.observerDraftMarkdown } : {}), ...(session.dirtyNotes ? { dirtyNotes: true } : {}), revision, filePath, transcriptHash: conversationHash(rounds, questions, session.interventions ?? []) };
  }
  private parseMarkdown(raw: string, side: Sidecar): CoffeeSession {
    const title = markdownTopic(raw) ?? side.topic;
    const settingsMatch = /^## (?:開桌設定|Table settings)\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(raw);
    const boundary = conversationBoundary(raw);
    const afterTranscript = raw.slice(boundary.index + boundary.heading.length);
    const tailHeadings = [...afterTranscript.matchAll(/^## (?:觀察者整理|Observer notes|未完成草稿|Unfinished drafts)\s*$/gm)];
    const contentEnd = tailHeadings.length ? tailHeadings[0].index : afterTranscript.length;
    const conversation = afterTranscript.slice(0, contentEnd).trim();
    const markers = [...conversation.matchAll(/^## (對談第 (\d+) 段|追問第 (\d+) 題|使用者介入第 (\d+) 則|Conversation part (\d+)|Follow-up (\d+)|User note (\d+))\s*$/gm)];
    if (!markers.length && conversation) throw new Error("Coffee Tables conversation section structure is unclear; reload stopped without changing this note");
    const rounds: CoffeeRound[] = [];
    const questionsById = new Map((side.questions ?? []).map((question, index) => [question.id, { ...question, question: "", answer: "", index }]));
    for (let i = 0; i < markers.length; i++) {
      const marker = markers[i], start = marker.index + marker[0].length, end = markers[i + 1]?.index ?? conversation.length, body = conversation.slice(start, end).trim();
      const roundMatch = /對談第 (\d+) 段|Conversation part (\d+)/.exec(marker[1]), qMatch = /追問第 (\d+) 題|Follow-up (\d+)/.exec(marker[1]), interventionMatch = /使用者介入第 (\d+) 則|User note (\d+)/.exec(marker[1]);
      if (roundMatch) { const nth = Number(roundMatch[1] ?? roundMatch[2]) - 1, persistedId = /^<!-- coffee-tables-round:([a-zA-Z0-9-]+) -->$/m.exec(body)?.[1], meta = persistedId ? side.rounds?.find(item => item.id === persistedId) : side.rounds?.[nth]; const roundId = meta?.id ?? `round-${nth + 1}`, roundInterventions = (side.interventions ?? []).filter(item => item.roundId === roundId).sort((a, b) => (a.afterTurn ?? 0) - (b.afterTurn ?? 0)); const inputPattern = /^> \*\*你（插話）\*\*：([^\n]*(?:\n> [^\n]*)*)/gm, inputs = [...body.matchAll(inputPattern)]; inputs.forEach((input, index) => { if (roundInterventions[index]) roundInterventions[index].text = input[1].split("\n").map(line => line.replace(/^> ?/, "")).join("\n").trim(); }); const withoutInputs = body.replace(/^<!-- coffee-tables-round:[a-zA-Z0-9-]+ -->\s*$/gm, "").replace(inputPattern, "").replace(/\n{3,}/g, "\n\n").trim(), { dialogue, notes } = splitObserverNotes(withoutInputs); rounds.push({ ...(meta ?? { id: roundId, createdAt: side.createdAt, status: side.status === "completed" ? "completed" : "error" }), markdown: dialogue, notes }); }
      else if (qMatch) { const nth = Number(qMatch[1] ?? qMatch[2]) - 1, meta = [...questionsById.values()][nth]; if (!meta) throw new Error("A follow-up is missing its hidden session record"); const answerAt = /^### (?:桌上回答|Table response)\s*$/m.exec(body); const inviteAt = /^### (?:邀請來賓|Invited guests)\s*$/m.exec(body); const questionEnd = [answerAt?.index, inviteAt?.index].filter((at): at is number => at !== undefined).sort((a,b) => a-b)[0] ?? body.length; meta.question = body.slice(0, questionEnd).trim(); meta.answer = answerAt ? body.slice(answerAt.index + answerAt[0].length, inviteAt && inviteAt.index > answerAt.index ? inviteAt.index : body.length).trim() : ""; }
      else if (interventionMatch) { const nth = Number(interventionMatch[1] ?? interventionMatch[2]) - 1, items = side.interventions ?? [], item = items[nth]; if (!item) throw new Error("A user comment is missing its hidden session record"); item.text = body; }
      else throw new Error("Unknown Coffee Tables conversation section");
    }
    const notesStart = /^## (?:觀察者整理|Observer notes)\s*$/m.exec(raw);
    const draftStart = /^## (?:未完成草稿|Unfinished drafts)\s*$/m.exec(raw);
    const notesBlock = notesStart ? raw.slice(notesStart.index + notesStart[0].length, draftStart && draftStart.index > notesStart.index ? draftStart.index : raw.length) : "";
    const latestStart = /^### (?:最新版本|Latest)\s*$/m.exec(notesBlock), historyStart = /^### (?:先前版本|History)\s*$/m.exec(notesBlock);
    const latest = latestStart ? notesBlock.slice(latestStart.index + latestStart[0].length, historyStart && historyStart.index > latestStart.index ? historyStart.index : notesBlock.length).trim() : historyStart ? notesBlock.slice(0, historyStart.index).trim() : notesBlock.trim();
    const history = historyStart ? notesBlock.slice(historyStart.index + historyStart[0].length).trim() : "";
    const noteVersions = [...history.matchAll(/^#### (?:第 (\d+) 版|Version (\d+))\s*\n([\s\S]*?)(?=^#### |$(?![\s\S]))/gm)].map(match => match[3].trim()).filter(Boolean);
    const settings = settingsMatch?.[1] ?? "";
    const model = /^- (?:模型|Model): (.+)$/m.exec(settings)?.[1] ?? side.model;
    const reasoning = /^- (?:推理強度|Reasoning): (.+)$/m.exec(settings)?.[1] ?? side.reasoning;
    const custom = /^### (?:這桌的額外要求|Additional requests)\s*\n([\s\S]*?)(?=^### |$(?![\s\S]))/m.exec(settings)?.[1]?.split("\n").map(line => line.replace(/^> ?/, "")).join("\n").trim() ?? side.guests?.customPrompt ?? "";
    const styleMatch = /^<!-- coffee-tables-style:([^\n]+) -->$/m.exec(settings);
    let styleSnapshot: { id?: string; name?: string; prompt?: string } | undefined;
    if (styleMatch) try { styleSnapshot = JSON.parse(decodeURIComponent(styleMatch[1])) as typeof styleSnapshot; } catch { /* Fall back to the hidden session snapshot. */ }
    const referenceMatch = /^<!-- coffee-tables-references:([^\n]+) -->$/m.exec(raw);
    let referenceFiles = side.guests?.referenceFiles ?? [];
    if (referenceMatch) try { const parsed: unknown = JSON.parse(decodeURIComponent(referenceMatch[1])); if (isCoffeeReferenceList(parsed)) referenceFiles = parsed; } catch { /* Keep the sidecar snapshot when the note marker is malformed. */ }
    const guestSettings = side.guests ? { ...side.guests, customPrompt: custom, ...(styleSnapshot ? { styleId: styleSnapshot.id, styleName: styleSnapshot.name, stylePrompt: styleSnapshot.prompt } : {}), referenceFiles } : undefined;
    const questions = [...questionsById.values()].filter(question => question.question).map(({ index: _index, ...question }) => question), interventions = side.interventions ?? [];
    const navigationMatch = boundary.navigation;
    if (navigationMatch) try {
      const data: unknown = JSON.parse(decodeURIComponent(navigationMatch[1]));
      if (Array.isArray(data)) for (const entry of data as Array<{ id?: unknown; summary?: unknown; kind?: unknown }>) {
        if (typeof entry.id !== "string") continue;
        const item = entry.id.startsWith("round:") ? rounds.find(round => `round:${round.id}` === entry.id) : questions.find(question => `question:${question.id}` === entry.id);
        if (item) { item.summary = typeof entry.summary === "string" && !/[\r\n]/.test(entry.summary) ? entry.summary.trim() || undefined : undefined; if ("markdown" in item && ["initial","continuation","legacy"].includes(String(entry.kind))) item.kind = entry.kind as CoffeeRound["kind"]; }
      }
    } catch { /* Preserve the sidecar snapshot when navigation metadata is malformed. */ }
    for (const meta of side.rounds ?? []) if (!rounds.some(round => round.id === meta.id) && meta.status !== "completed") rounds.push({ ...meta, markdown: "", notes: "" });
    rounds.sort((a,b) => a.createdAt.localeCompare(b.createdAt));
    const session: CoffeeSession = { version: 3, id: side.id, topic: title, language: side.language, model, reasoning, createdAt: side.createdAt, updatedAt: side.updatedAt, ...(side.lastGenerationStartedAt ? { lastGenerationStartedAt: side.lastGenerationStartedAt } : {}), ...(side.lastCompletedAt ? { lastCompletedAt: side.lastCompletedAt } : {}), status: side.status, ...(side.error ? { error: side.error } : {}), guests: guestSettings, rounds, transcriptMarkdown: rounds.map(round => round.markdown).filter(Boolean).join("\n\n"), questions, observerNotes: [latest, ...noteVersions].filter(Boolean), ...(side.draftMarkdown ? { draftMarkdown: side.draftMarkdown } : {}), ...(side.observerDraftMarkdown ? { observerDraftMarkdown: side.observerDraftMarkdown } : {}), ...(side.interventions ? { interventions } : {}), ...((side.dirtyNotes || (!!side.transcriptHash && conversationHash(rounds, questions, interventions) !== side.transcriptHash)) ? { dirtyNotes: true } : {}) };
    return parseSession(JSON.stringify(session)) as CoffeeSession;
  }
  private encode(session: CoffeeSession): string {
    const zh = session.language === "zh-TW", count = session.guests?.counts ?? { experts: 4, "cross-domain": 1, generalist: 1, affected: 1 };
    const t = (zhText: string, enText: string): string => zh ? zhText : enText;
    const lines = [`# ${session.topic}`, "", `## ${t("開桌設定", "Table settings")}`, "", `- ${t("模型", "Model")}: ${session.model}`, `- ${t("推理強度", "Reasoning")}: ${session.reasoning}`, `- ${t("主持人", "Hosts")}: ${session.guests?.hostCount ?? 2}`, `- ${t("主題專家", "Topic experts")}: ${count.experts}`, `- ${t("跨領域專家", "Cross-domain experts")}: ${count["cross-domain"]}`, `- ${t("好奇的通才", "Curious generalists")}: ${count.generalist}`, `- ${t("受影響者", "Affected perspectives")}: ${count.affected}`];
    for (const guest of session.guests?.guests ?? []) lines.push(`- ${t("指定來賓", "Guest")}: ${t(...CATEGORY_LABELS[guest.category])} — ${guest.description}`);
    if (session.guests?.background) lines.push(`- ${t("補充背景", "Background")}: ${session.guests.background}`);
    if (session.guests?.stylePrompt?.trim()) lines.push("", `### ${t("聊天室風格", "Conversation style")}`, "", ...session.guests.stylePrompt.split("\n").map(line => `> ${line}`), `<!-- coffee-tables-style:${encodeURIComponent(JSON.stringify({ id: session.guests.styleId, name: session.guests.styleName, prompt: session.guests.stylePrompt }))} -->`);
    else if (session.guests?.customPrompt.trim()) lines.push("", `### ${t("這桌的額外要求", "Additional requests")}`, "", ...session.guests.customPrompt.split("\n").map(line => `> ${line}`));
    if (session.guests?.referenceFiles?.length) {
      const files = session.guests.referenceFiles;
      lines.push("", `## ${t("背景參考資料", "Background references")}`, "", `<!-- coffee-tables-references:${encodeURIComponent(JSON.stringify(files))} -->`);
      for (const [index, file] of files.entries()) { const fence = "`".repeat(Math.max(3, ...[...file.content.matchAll(/`+/g)].map(match => match[0].length + 1))); lines.push("", `### ${t(`文件 ${index + 1}：${file.name}`, `File ${index + 1}: ${file.name}`)}`, "", `${fence}text`, file.content, fence); }
    }
    lines.push(`<!-- coffee-tables-navigation:${encodeURIComponent(JSON.stringify([...(session.rounds ?? []).map(item => ({id: `round:${item.id}`, summary: item.summary, kind: item.kind})), ...session.questions.map(item => ({id: `question:${item.id}`, summary: item.summary}))]))} -->`, "");
    lines.push("", `## ${t("對話紀錄", "Conversation")}`, "");
    const events: Array<{ at: string; lines: string[] }> = [];
    let roundNumber = 0; for (const round of session.rounds ?? []) { const attached = (session.interventions ?? []).filter(item => item.roundId === round.id).sort((a, b) => (a.afterTurn ?? 0) - (b.afterTurn ?? 0)), body = interleaveInterventions(round.markdown, attached); if (!body) continue; roundNumber++; events.push({ at: round.createdAt, lines: [`## ${t(`對談第 ${roundNumber} 段`, `Conversation part ${roundNumber}`)}`, "", `<!-- coffee-tables-round:${round.id} -->`, "", body] }); }
    for (let i = 0; i < session.questions.length; i++) { const question = session.questions[i]; const invitations = question.invitedGuests?.length ? ["", `### ${t("邀請來賓", "Invited guests")}`, "", ...question.invitedGuests.map(guest => `- **${guest.name}｜${t(...CATEGORY_LABELS[guest.category])}**：${guest.description}`)] : []; events.push({ at: question.createdAt ?? session.createdAt, lines: [`## ${t(`追問第 ${i + 1} 題`, `Follow-up ${i + 1}`)}`, "", question.question, "", `### ${t("桌上回答", "Table response")}`, "", question.answer || question.draftAnswer || t("（尚未回答）", "(No answer yet.)"), ...invitations] }); }
    for (let i = 0; i < (session.interventions ?? []).length; i++) { const item = session.interventions![i]; if (item.roundId) continue; events.push({ at: item.createdAt, lines: [`## ${t(`使用者介入第 ${i + 1} 則`, `User note ${i + 1}`)}`, "", demoteRootHeadings(item.text)] }); }
    events.sort((a, b) => a.at.localeCompare(b.at)); for (const event of events) lines.push(...event.lines, "");
    const insights = baselineFromVersions(session.observerNotes ?? [], session.language);
    if (insights.length) lines.push(`## ${t("觀察者整理", "Observer notes")}`, "", serializeInsightNotes(insights, session.language));
    const drafts = [...(session.rounds ?? []).filter(round => round.draftMarkdown).map((round, index) => `### ${t(`對談第 ${index + 1} 段草稿`, `Conversation part ${index + 1} draft`)}\n\n${round.draftMarkdown}`), ...session.questions.filter(question => question.draftAnswer).map((question, index) => `### ${t(`追問草稿 ${index + 1}`, `Follow-up draft ${index + 1}`)}\n\n${question.draftAnswer}`)];
    if (session.observerDraftMarkdown) drafts.push(`### ${t("觀察者整理草稿", "Observer notes draft")}\n\n${session.observerDraftMarkdown}`);
    if (drafts.length || (session.draftMarkdown && !(session.rounds ?? []).some(round => round.draftMarkdown))) lines.push(`## ${t("未完成草稿", "Unfinished drafts")}`, "", ...((session.draftMarkdown && !(session.rounds ?? []).some(round => round.draftMarkdown)) ? [session.draftMarkdown] : []), ...drafts);
    return lines.join("\n");
  }
  private async writeNewSidecar(session: CoffeeSession, path: string, targetMarkdown?: string): Promise<void> { await this.ensureFolder(this.hidden); const filePath = this.sidecarPath(session.id); if (await this.vault.adapter.exists(filePath)) throw new Error("Coffee Tables hidden session already exists"); const base = this.sidecar(session, 1, path); const raw = JSON.stringify(targetMarkdown === undefined ? base : { ...base, journal: { previousMarkdownHash: contentHash(""), nextMarkdownHash: contentHash(targetMarkdown), previousSidecar: "", targetMarkdown } }, null, 2); await this.writeHidden(filePath, raw); this.sidecarOriginals.set(session.id, raw); this.revisions.set(session.id, 1); }
  async recoverPendingCreates(): Promise<void> {
    const sidecars = await this.hiddenPaths();
    for (const sideFile of sidecars) {
      const raw = await this.readHidden(sideFile); let side: Sidecar; try { side = JSON.parse(raw) as Sidecar; } catch { continue; }
      const journal = side.journal; if (!journal?.targetMarkdown || this.activeWrites.has(side.id)) continue;
      const file = this.vault.getAbstractFileByPath(side.filePath);
      if (!file) {
        if (journal.previousMarkdownHash !== contentHash("")) throw new Error(`Coffee Tables recovery stopped because ${side.filePath} is missing`);
        await this.ensureFolder(side.filePath.split("/").slice(0, -1).join("/")); await this.vault.create(side.filePath, journal.targetMarkdown);
      } else if (!(file instanceof TFile) || contentHash(await this.vault.read(file)) !== journal.nextMarkdownHash) {
        throw new Error(`Coffee Tables recovery found an outside change at ${side.filePath}; both files were preserved`);
      }
      const { journal: _journal, ...committed } = side; const next = JSON.stringify(committed, null, 2);
      await this.writeHidden(sideFile, next, raw);
    }
  }
  async recoverMoves(): Promise<void> {
    for (const sidePath of await this.hiddenPaths()) {
      const raw = await this.readHidden(sidePath); let side: Sidecar; try { side = JSON.parse(raw) as Sidecar; } catch { continue; }
      const move = side.moveJournal; if (!move || this.activeMoves.has(side.id)) continue;
      const source = this.vault.getAbstractFileByPath(move.previousPath), target = this.vault.getAbstractFileByPath(move.targetPath);
      if ((source instanceof TFile) === (target instanceof TFile)) throw new Error(`Coffee Tables move recovery found an ambiguous pair for ${side.topic}; both files were preserved`);
      const filePath = target instanceof TFile ? move.targetPath : move.previousPath, { moveJournal: _moveJournal, ...committed } = side, next = JSON.stringify({ ...committed, filePath }, null, 2);
      await this.writeHidden(sidePath, next, raw); this.locations.set(side.id, filePath); this.sidecarOriginals.set(side.id, next);
    }
  }
  private parseV2(raw: string): CoffeeSession {
    const match = /^<!-- coffee-tables-data:([\s\S]*?) -->$/mu.exec(raw); if (!match) throw new Error("Legacy Coffee Tables metadata is missing");
    const stored = JSON.parse(decodeURIComponent(match[1])) as Record<string, unknown>, id = String(stored.id), lang = stored.language === "zh-TW", conversationTitle = lang ? "## 對談" : "## Conversation", startAt = raw.indexOf(conversationTitle, match.index + match[0].length), endAt = raw.indexOf(`<!-- coffee-tables-transcript-end:${id} -->`, startAt);
    if (startAt < 0 || endAt < startAt || stored.version !== 2) throw new Error("Legacy Coffee Tables transcript is incomplete");
    const transcriptMarkdown = raw.slice(startAt + conversationTitle.length, endAt).trim(), questions = ((stored.questionStates as Array<Record<string, unknown>>) ?? []).map(state => { const qid = String(state.id), q = raw.indexOf(`<!-- coffee-tables-question:${qid} -->`, endAt), a = raw.indexOf(`<!-- coffee-tables-answer:${qid} -->`, q), e = raw.indexOf(`<!-- coffee-tables-question-end:${qid} -->`, a); if (q < 0 || a < 0 || e < 0) throw new Error("Legacy follow-up is incomplete"); return { id: qid, question: raw.slice(q + `<!-- coffee-tables-question:${qid} -->`.length, a).trim(), answer: raw.slice(a + `<!-- coffee-tables-answer:${qid} -->`.length, e).trim(), status: state.status, ...(typeof state.error === "string" ? { error: state.error } : {}), ...(typeof state.draftAnswer === "string" ? { draftAnswer: state.draftAnswer } : {}), createdAt: String(stored.createdAt) }; });
    const legacyDraft = /<!--\s*coffee-tables-draft-start(?:\s*:[^>]+)?\s*-->([\s\S]*?)<!--\s*coffee-tables-draft-end(?:\s*:[^>]+)?\s*-->/i.exec(raw)?.[1]?.trim();
    const session = { ...stored, version: 3, transcriptMarkdown, questions, guests: migrateGuests(stored.guests), rounds: transcriptMarkdown ? [{ id: "round-1", markdown: splitObserverNotes(transcriptMarkdown).dialogue, notes: splitObserverNotes(transcriptMarkdown).notes, status: stored.status === "completed" ? "completed" : "error", createdAt: String(stored.createdAt) }] : [], observerNotes: splitObserverNotes(transcriptMarkdown).notes ? [splitObserverNotes(transcriptMarkdown).notes] : [], draftMarkdown: typeof stored.draftMarkdown === "string" ? stored.draftMarkdown : legacyDraft };
    return parseSession(JSON.stringify(session)) as CoffeeSession;
  }
  async load(idOrPath: string): Promise<AnyCoffeeSession> {
    let file = this.vault.getAbstractFileByPath(idOrPath.includes("/") ? idOrPath : `${this.folder}/${idOrPath}.md`); if (!(file instanceof TFile)) file = this.vault.getAbstractFileByPath(`${this.folder}/${idOrPath}.json`);
    if (!(file instanceof TFile) && !idOrPath.includes("/")) { try { const sideRaw = await this.readHidden(this.sidecarPath(idOrPath)), side = JSON.parse(sideRaw) as Sidecar; const linked = side.filePath ? this.vault.getAbstractFileByPath(side.filePath) : null; if (linked instanceof TFile) file = linked; } catch { /* Continue with a safe title-based lookup. */ } }
    if (!(file instanceof TFile)) { const candidates = this.list().filter(item => item.extension === "md"), sidecars = await this.hiddenPaths(); for (const candidate of candidates) { try { const raw = await this.vault.read(candidate), heading = markdownTopic(raw); for (const item of sidecars) { const side = JSON.parse(await this.readHidden(item)) as Sidecar; const requested = side.id === idOrPath || side.filePath === idOrPath; const exactPath = side.filePath === candidate.path; const uniquelyMoved = !this.vault.getAbstractFileByPath(side.filePath) && side.topic === heading && (await Promise.all(candidates.map(async sibling => markdownTopic(await this.vault.read(sibling))))).filter(title => title === heading).length === 1; if (requested && (side.topic === heading || (!heading && exactPath)) && (exactPath || uniquelyMoved)) { file = candidate; break; } } if (file instanceof TFile) break; } catch { /* Preserve malformed unrelated files. */ } } }
    if (!(file instanceof TFile)) throw new Error("Coffee Tables session is missing");
    const raw = await this.vault.read(file); let session: CoffeeSession;
    if (/^<!-- coffee-tables-data:/m.test(raw)) {
      session = this.parseV2(raw); const backup = `${this.hidden}/backups`; await this.ensureFolder(this.hidden); await this.ensureFolder(backup);
      const backupPath = `${backup}/${session.id}-v2.md`; if (!await this.vault.adapter.exists(backupPath)) await this.writeHidden(backupPath, raw);
      const path = this.titlePath(session.topic, session.id); if (!await this.vault.adapter.exists(this.sidecarPath(session.id))) await this.writeNewSidecar(session, path); const clean = this.encode(session);
      await this.ensureFolder(path.split("/").slice(0, -1).join("/"));
      await this.vault.process(file, current => { if (current !== raw) throw new Error("Coffee Tables note changed during migration; original data was preserved"); return clean; }); if (path !== file.path && this.renameFile) await this.renameFile(file, path);
      this.locations.set(session.id, path); this.originals.set(session.id, clean); this.sidecarOriginals.set(session.id, JSON.stringify(this.sidecar(session, 1, path), null, 2)); this.revisions.set(session.id, 1); return session;
    }
    const title = markdownTopic(raw);
    if (!title) { try { const legacy = parseSession(raw); if (legacy.version === 1) return legacy; } catch { /* Continue with the title-linked hidden record. */ } }
    let side = await this.findSidecar(file.path, title);
    if (side?.journal) side = await this.recoverJournal(file, raw, side);
    if (!side) { try { return parseSession(raw); } catch { throw new Error("This readable Markdown has no hidden session data. Keep it as a note; restore its .sessions file to continue the chat."); } }
    const priorMarkdown = this.originals.get(side.id);
    if (priorMarkdown !== undefined && priorMarkdown !== raw) throw new Error("Session changed outside this room. Reload the note to adopt your edits; no content was overwritten.");
    const sessionLoaded = this.parseMarkdown(raw, side);
    const sidePath = this.sidecarPath(sessionLoaded.id); if (!await this.vault.adapter.exists(sidePath)) throw new Error("Coffee Tables hidden session data is missing");
    const sideRaw = await this.readHidden(sidePath), priorSidecar = this.sidecarOriginals.get(sessionLoaded.id); if (priorSidecar !== undefined && priorSidecar !== sideRaw) throw new Error("Coffee Tables hidden data changed outside this room. Reload it before continuing."); this.locations.set(sessionLoaded.id, file.path); this.originals.set(sessionLoaded.id, raw); this.sidecarOriginals.set(sessionLoaded.id, sideRaw); this.revisions.set(sessionLoaded.id, side.revision); return sessionLoaded;
  }
  private async findSidecar(path: string, title?: string): Promise<Sidecar | null> {
    const candidates = await this.hiddenPaths();
    const parsed: Sidecar[] = []; for (const file of candidates) { try { parsed.push(JSON.parse(await this.readHidden(file)) as Sidecar); } catch { /* Leave damaged hidden records intact and check the rest. */ } }
    const exact = parsed.filter(side => side.filePath === path); if (exact.length === 1) return exact[0]; if (exact.length > 1) throw new Error("Multiple Coffee Tables records point to this note; no session was opened");
    const moved = title ? parsed.filter(side => side.topic === title && (!side.filePath || !this.vault.getAbstractFileByPath(side.filePath))) : [];
    if (moved.length > 1) throw new Error("More than one moved Coffee Tables table has this title; choose its original note or restore hidden session data"); return moved[0] ?? null;
  }
  private async recoverJournal(file: TFile, markdown: string, staged: Sidecar): Promise<Sidecar> {
    if (this.activeWrites.has(staged.id)) throw new Error("Coffee Tables save is still in progress; reopen after it finishes");
    const journal = staged.journal; if (!journal) return staged;
    const digest = contentHash(markdown), sidePath = this.sidecarPath(staged.id); if (!await this.vault.adapter.exists(sidePath)) throw new Error("Coffee Tables hidden session data is missing");
    let result: Sidecar;
    if (digest === journal.nextMarkdownHash) { const { journal: _journal, ...committed } = staged; result = { ...committed, filePath: file.path }; }
    else if (digest === journal.previousMarkdownHash) { result = JSON.parse(journal.previousSidecar) as Sidecar; }
    else throw new Error("Coffee Tables note and hidden record changed during a save. Both files were preserved for manual review.");
    const oldRaw = await this.readHidden(sidePath), nextRaw = JSON.stringify(result,null,2); await this.writeHidden(sidePath,nextRaw,oldRaw); this.sidecarOriginals.set(staged.id,nextRaw); this.revisions.set(staged.id,result.revision); return result;
  }
  private async stageSidecar(session: CoffeeSession, path: string, cleanMarkdown: string, previousMarkdown: string): Promise<{ path: string; staged: string; committed: string; revision: number }> {
    const sidePath = this.sidecarPath(session.id); if (!await this.vault.adapter.exists(sidePath)) throw new Error("Coffee Tables hidden session data is missing; no content was written");
    const original = this.sidecarOriginals.get(session.id); if (original === undefined) throw new Error("Reload this table before saving hidden session data");
    const revision = (this.revisions.get(session.id) ?? 0) + 1, committedObject = this.sidecar(session,revision,path), committed = JSON.stringify(committedObject,null,2);
    const staged = JSON.stringify({ ...committedObject, journal: { previousMarkdownHash: contentHash(previousMarkdown), nextMarkdownHash: contentHash(cleanMarkdown), previousSidecar: original } },null,2);
    await this.writeHidden(sidePath,staged,original);
    return { path: sidePath, staged, committed, revision };
  }
  async inspectReadOnly(path: string): Promise<AnyCoffeeSession> {
    const file = this.vault.getAbstractFileByPath(path); if (!(file instanceof TFile)) throw new Error("Coffee Tables session is missing");
    const raw = await this.vault.read(file); if (/^<!-- coffee-tables-data:/m.test(raw)) return this.parseV2(raw);
    const title = markdownTopic(raw); const side = await this.findSidecar(path, title);
    if (!side) throw new Error("Coffee Tables hidden session data is missing");
    if (side.journal) throw new Error("This table has an unfinished save. Open it to safely recover the saved changes.");
    return this.parseMarkdown(raw, side);
  }
  async handoffSnapshot(path: string, id: string): Promise<CoffeeHandoffSnapshot> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error("Coffee source moved or disappeared; reopen the table.");
    const sidePath = this.sidecarPath(id);
    const markdown = await this.vault.read(file);
    const sidecar = await this.vault.adapter.exists(sidePath) ? await this.readHidden(sidePath) : null;
    const session = await this.inspectReadOnly(path);
    if (session.version !== 3 || session.id !== id || session.status !== "completed" || id.startsWith("sample-")) throw new Error("Only completed user-owned Coffee tables can be handed off.");
    const snapshot = { session, path, markdown, sidecar };
    await this.assertHandoffSnapshot(snapshot);
    return snapshot;
  }
  async assertHandoffSnapshot(snapshot: CoffeeHandoffSnapshot): Promise<void> {
    const file = this.vault.getAbstractFileByPath(snapshot.path);
    const sidePath = this.sidecarPath(snapshot.session.id);
    const sidecar = await this.vault.adapter.exists(sidePath) ? await this.readHidden(sidePath) : null;
    if (!(file instanceof TFile) || await this.vault.read(file) !== snapshot.markdown || sidecar !== snapshot.sidecar) throw new Error("Coffee source changed; keep your draft and reopen the latest table.");
  }
  async inspect(path: string): Promise<AnyCoffeeSession> { const file = this.vault.getAbstractFileByPath(path); if (!(file instanceof TFile)) throw new Error("Coffee Tables session is missing"); const raw = await this.vault.read(file); if (/^<!-- coffee-tables-data:/m.test(raw)) return this.parseV2(raw); const title = markdownTopic(raw); let side = await this.findSidecar(path,title); if (side?.journal) { if (this.activeWrites.has(side.id)) { const journal = side.journal; if (contentHash(raw) === journal.previousMarkdownHash) side = JSON.parse(journal.previousSidecar) as Sidecar; else if (contentHash(raw) === journal.nextMarkdownHash) { const { journal: _journal, ...committed } = side; side = committed; } else throw new Error("Coffee Tables note and hidden state changed during save"); } else side = await this.recoverJournal(file,raw,side); } return side ? this.parseMarkdown(raw, side) : (() => { throw new Error("Coffee Tables hidden session data is missing"); })(); }
  async save(sessionInput: CoffeeSession, summariesOnly = false): Promise<void> {
    const session = parseSession(JSON.stringify(sessionInput)) as CoffeeSession; if (session.version !== 3) throw new Error("Unsupported Coffee Tables session version"); if (this.deletedIds.has(session.id)) throw new Error("This Coffee Tables session was deleted; reload the restored note before saving");
    let path = this.locations.get(session.id) ?? this.titlePath(session.topic, session.id); let clean = this.encode(session); const file = this.vault.getAbstractFileByPath(path), original = this.originals.get(session.id);
    if (!file) {
      path = this.titlePath(session.topic, session.id); await this.ensureFolder(path.split("/").slice(0, -1).join("/")); if (this.vault.getAbstractFileByPath(path)) throw new Error("A Coffee Tables note already exists; reopen it before saving");
      this.activeWrites.add(session.id); try {
        await this.writeNewSidecar(session, path, clean); await this.vault.create(path, clean);
        const sidePath = this.sidecarPath(session.id); if (!await this.vault.adapter.exists(sidePath)) throw new Error("Coffee Tables hidden session data is missing after create");
        const staged = await this.readHidden(sidePath); const side = JSON.parse(staged) as Sidecar; const { journal: _journal, ...committed } = side; const committedRaw = JSON.stringify(committed, null, 2);
        await this.writeHidden(sidePath,committedRaw,staged); this.sidecarOriginals.set(session.id, committedRaw); this.revisions.set(session.id, committed.revision);
      } finally { this.activeWrites.delete(session.id); }
    } else {
      if (!(file instanceof TFile) || original === undefined) throw new Error("Reload this table before saving");
      const current = await this.vault.read(file); if (current !== original) throw new Error("Session changed outside this room. Reload the note to adopt your edits; no content was overwritten.");
      if (summariesOnly) {
        const marker = `<!-- coffee-tables-navigation:${encodeURIComponent(JSON.stringify([...(session.rounds ?? []).map(item => ({id: `round:${item.id}`, summary: item.summary, kind: item.kind})), ...session.questions.map(item => ({id: `question:${item.id}`, summary: item.summary}))]))} -->`;
        const boundary = conversationBoundary(current);
        clean = boundary.navigation ? current.slice(0,boundary.navigation.index) + marker + current.slice(boundary.navigation.index + boundary.navigation[0].trimEnd().length) : current.slice(0,boundary.index) + marker + "\n\n" + current.slice(boundary.index);
        if (clean === current && !current.includes(marker)) throw new Error("Cannot locate the conversation section; original data was preserved");
      }
      if (!summariesOnly && /^### (?:先前版本|History)\s*$/m.test(current)) {
        const backupFolder = `${this.hidden}/backups`; await this.ensureFolder(this.hidden); await this.ensureFolder(backupFolder);
        const backupPath = `${backupFolder}/${session.id}-observer-history-${contentHash(current)}.md`;
        if (await this.vault.adapter.exists(backupPath)) { if (await this.vault.adapter.read(backupPath) !== current) throw new Error("Coffee Tables history backup path contains different data; the original note was preserved"); }
        else await this.writeHidden(backupPath, current);
        clean = this.encode({ ...session, observerNotes: [serializeInsightNotes(baselineFromVersions(session.observerNotes ?? [], session.language), session.language)] });
      }
      const sidePath = this.sidecarPath(session.id); if (!await this.vault.adapter.exists(sidePath)) throw new Error("Coffee Tables hidden session data is missing; the Markdown note was preserved");
      const originalSidecar = this.sidecarOriginals.get(session.id)!; this.activeWrites.add(session.id);
      try {
        const transaction = await this.stageSidecar(session,path,clean,original);
        try {
        await this.vault.process(file, value => { if (value !== original) throw new Error("Session changed outside this room; no content was overwritten"); return clean; });
        await this.writeHidden(transaction.path,transaction.committed,transaction.staged);
        this.sidecarOriginals.set(session.id,transaction.committed); this.revisions.set(session.id,transaction.revision);
        } catch (error) {
        const current = await this.vault.read(file).catch(() => "");
        if (current === clean) await this.vault.process(file,value => value === clean ? original : value).catch(() => undefined);
        await this.writeHidden(transaction.path,originalSidecar,transaction.staged).catch(() => undefined); throw error;
        }
      } finally { this.activeWrites.delete(session.id); }
    }
    this.originals.set(session.id, clean); this.locations.set(session.id, path);
    if (this.renameFile && file instanceof TFile) { const next = this.titlePath(session.topic, session.id); if (next !== file.path) { await this.ensureFolder(next.split("/").slice(0, -1).join("/")); path = await this.moveManagedFile(file, session.id, next); } }
  }
  private async moveManagedFile(file: TFile, id: string, targetPath: string): Promise<string> {
    if (!this.renameFile) throw new Error("FileManager rename is unavailable"); if (this.activeMoves.has(id)) throw new Error("This Coffee Tables file is already being moved"); this.activeMoves.add(id);
    try {
      const sidePath = this.sidecarPath(id), raw = await this.readHidden(sidePath), expected = this.sidecarOriginals.get(id); if (expected !== undefined && raw !== expected) throw new Error("Coffee Tables hidden data changed outside this room; reload before moving");
      const staged = JSON.stringify({ ...(JSON.parse(raw) as Sidecar), moveJournal: { previousPath: file.path, targetPath } }, null, 2); await this.writeHidden(sidePath, staged, raw);
      await this.renameFile(file, targetPath);
      const { moveJournal: _move, ...committed } = JSON.parse(staged) as Sidecar, next = JSON.stringify({ ...committed, filePath: targetPath }, null, 2); await this.writeHidden(sidePath, next, staged); this.locations.set(id, targetPath); this.sidecarOriginals.set(id, next); return targetPath;
    } finally { this.activeMoves.delete(id); }
  }
  async reload(path: string): Promise<CoffeeSession> { const markdownFile = this.vault.getAbstractFileByPath(path); if (!(markdownFile instanceof TFile)) throw new Error("Coffee Tables session is missing"); const title = markdownTopic(await this.vault.read(markdownFile)); const sidecars = await this.hiddenPaths(), records: Array<{ path: string; side: Sidecar; raw: string }> = []; for (const sidePath of sidecars) { const raw = await this.readHidden(sidePath); try { records.push({ path: sidePath, side: JSON.parse(raw) as Sidecar, raw }); } catch { /* Preserve malformed unrelated records. */ } } const exact = records.filter(record => record.side.filePath === path); const located = records.filter(record => this.locations.get(record.side.id) === path); const candidates = exact.length ? exact : located.length ? located : records.filter(record => record.side.topic === title && (!record.side.filePath || !this.vault.getAbstractFileByPath(record.side.filePath))); if (candidates.length !== 1) throw new Error(candidates.length ? "More than one Coffee Tables record matches this note; reload stopped safely" : "Coffee Tables hidden session record was not found"); const { path: sidePath, side, raw } = candidates[0]; this.originals.delete(side.id); this.sidecarOriginals.delete(side.id); if (side.filePath !== path) { const next = JSON.stringify({ ...side, filePath: path }, null, 2); await this.writeHidden(sidePath,next,raw); } return await this.load(path) as CoffeeSession; }
  async renameToTopic(id: string, topic: string): Promise<void> { const file = this.vault.getAbstractFileByPath(this.locations.get(id) ?? this.path(id)); if (file instanceof TFile && this.renameFile) { const target = this.titlePath(topic, id); if (target !== file.path) { await this.renameFile(file, target); this.locations.set(id, target); } } }
  async openMarkdown(id: string): Promise<TFile> { const file = this.vault.getAbstractFileByPath(id.includes("/") ? id : this.locations.get(id) ?? this.path(id)); if (!(file instanceof TFile)) throw new Error("Coffee Tables Markdown note is missing"); return file; }
  async organizeExisting(busyIds: Set<string> = new Set()): Promise<{ moved: number; skipped: number }> {
    let moved = 0, skipped = 0;
    for (const file of [...this.list()]) {
      if (file.parent?.path !== this.folder) continue;
      try {
        const raw = await this.vault.read(file), heading = markdownTopic(raw), side = await this.findSidecar(file.path, heading); const topic = heading ?? side?.topic; if (!topic) { skipped++; continue; }
         if (side && (side.status === "generating" || busyIds.has(side.id))) { skipped++; continue; }
        const id = side?.id ?? `legacy-${shortHash(file.path)}`, target = this.titlePath(topic, id); if (!this.renameFile) throw new Error("FileManager rename is unavailable");
        await this.ensureFolder(target.split("/").slice(0, -1).join("/")); if (side) await this.moveManagedFile(file, side.id, target); else await this.renameFile(file, target); moved++;
      } catch { skipped++; }
    }
    return { moved, skipped };
  }
  async delete(id: string, markdownPath?: string): Promise<string> {
    const safeId = /^[a-zA-Z0-9-]+$/.test(id) ? id : `legacy-${shortHash(id)}`, file = await this.openMarkdown(markdownPath ?? id), sidePath = `${this.hidden}/${safeId}.json`, trashFolder = `${this.hidden}/trash`, bundlePath = `${trashFolder}/${safeId}-${Date.now()}.json`;
    await this.ensureFolder(trashFolder);
    let raw = await this.vault.read(file), sideRaw = await this.vault.adapter.read(sidePath).catch(() => undefined);
    const record: Record<string, unknown> = { version: 1, id, topic: markdownTopic(raw) ?? file.basename, originalPath: file.path, markdown: raw, ...(sideRaw ? { sidecar: sideRaw } : {}), deletedAt: new Date().toISOString(), trashed: false };
    let bundle = JSON.stringify(record, null, 2);
    await this.writeHidden(bundlePath, bundle);
    let stable = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const latestMarkdown = await this.vault.read(file), latestSidecar = await this.vault.adapter.read(sidePath).catch(() => undefined);
      if (latestMarkdown === raw && latestSidecar === sideRaw) { stable = true; break; }
      raw = latestMarkdown; sideRaw = latestSidecar; record.markdown = raw; record.topic = markdownTopic(raw) ?? file.basename; if (sideRaw === undefined) delete record.sidecar; else record.sidecar = sideRaw;
      const previousBundle = await this.readHidden(bundlePath); bundle = JSON.stringify(record, null, 2); await this.writeHidden(bundlePath, bundle, previousBundle);
    }
    if (!stable) { await this.vault.adapter.remove(bundlePath).catch(() => undefined); throw new Error("This table changed while it was being archived. The note was left in place; retry deletion after reloading it."); }
    try { if (this.trashFile) await this.trashFile(file); else await this.vault.adapter.trashLocal(file.path); }
    catch (error) { await this.vault.adapter.remove(bundlePath).catch(() => undefined); throw error; }
    const staged = JSON.parse(await this.readHidden(bundlePath)) as Record<string, unknown>; staged.trashed = true; await this.writeHidden(bundlePath, JSON.stringify(staged, null, 2), bundle).catch(() => undefined);
    const latestSidecar = await this.vault.adapter.read(sidePath).catch(() => undefined);
    if (latestSidecar !== sideRaw) { const archived = JSON.parse(await this.readHidden(bundlePath)) as Record<string, unknown>; if (latestSidecar === undefined) delete archived.sidecar; else archived.sidecar = latestSidecar; const previousBundle = await this.readHidden(bundlePath); await this.writeHidden(bundlePath, JSON.stringify(archived, null, 2), previousBundle).catch(() => undefined); }
    if (sideRaw && latestSidecar === sideRaw) await this.vault.adapter.process(sidePath, current => { if (current !== sideRaw) throw new Error("Coffee Tables hidden data changed outside this room; deletion preserved it"); return ""; }).catch(() => undefined);
    this.originals.delete(safeId); this.sidecarOriginals.delete(safeId); this.locations.delete(safeId); this.revisions.delete(safeId); this.deletedIds.add(id); return bundlePath;
  }
  async deletedTables(): Promise<Array<{ path: string; id: string; topic: string; deletedAt: string }>> {
    const folder = `${this.hidden}/trash`, listing = await this.vault.adapter.list(folder).catch(() => ({ files: [], folders: [] })), result: Array<{ path: string; id: string; topic: string; deletedAt: string }> = [];
    for (const path of listing.files.filter(item => item.endsWith(".json"))) try { const record = JSON.parse(await this.readHidden(path)) as Record<string, unknown>; const originalPath = typeof record.originalPath === "string" ? record.originalPath : ""; const originalMissing = !!originalPath && !this.vault.getAbstractFileByPath(originalPath); if (record.version === 1 && record.restoredPath === undefined && (record.restoreJournal !== undefined || record.trashed === true || originalMissing)) result.push({ path, id: String(record.id), topic: String(record.topic), deletedAt: String(record.deletedAt) }); } catch { /* Keep unreadable recovery records untouched. */ }
    return result.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }
  async restoreDeleted(bundlePath: string): Promise<string> {
    const bundleRaw = await this.readHidden(bundlePath), record = JSON.parse(bundleRaw) as Record<string, unknown>; const originalPath = typeof record.originalPath === "string" ? record.originalPath : ""; if (record.version !== 1 || (record.trashed !== true && record.restoreJournal === undefined && (!!originalPath && !!this.vault.getAbstractFileByPath(originalPath))) || typeof record.id !== "string" || typeof record.markdown !== "string") throw new Error("Deleted Coffee Tables record is incomplete; no file was changed");
    const sidePath = this.sidecarPath(record.id), originalBundleSidecar = typeof record.sidecar === "string" ? record.sidecar : undefined, currentSidecar = await this.vault.adapter.read(sidePath).catch(() => undefined);
    const base = typeof record.originalPath === "string" ? record.originalPath : this.titlePath(String(record.topic), record.id), stem = base.slice(0, -3);
    let journal = record.restoreJournal as { targetPath?: string; sidecarBefore?: string; sidecarAfter?: string } | undefined;
    let target = journal?.targetPath ?? base;
    if (!journal) { let suffix = 2; while (this.vault.getAbstractFileByPath(target)) target = `${stem}（${suffix++}）.md`; }
    const existingTarget = this.vault.getAbstractFileByPath(target);
    if (existingTarget && (!(existingTarget instanceof TFile) || await this.vault.read(existingTarget) !== record.markdown)) { let suffix = 2; target = base; while (this.vault.getAbstractFileByPath(target)) target = `${stem}（${suffix++}）.md`; journal = undefined; }
    const before = journal ? journal.sidecarBefore : currentSidecar;
    let after = journal?.sidecarAfter;
    if (!journal) { if (currentSidecar !== undefined && currentSidecar !== originalBundleSidecar && currentSidecar !== "") throw new Error("This Coffee Tables session already exists; restore stopped without overwriting it"); if (originalBundleSidecar) { const side = JSON.parse(originalBundleSidecar) as Sidecar; after = JSON.stringify({ ...side, filePath: target }, null, 2); } }
    const stagedRecord = { ...record, restoreJournal: { targetPath: target, ...(before !== undefined ? { sidecarBefore: before } : {}), ...(after !== undefined ? { sidecarAfter: after } : {}) } }, stagedRaw = JSON.stringify(stagedRecord, null, 2);
    await this.writeHidden(bundlePath, stagedRaw, bundleRaw);
    await this.ensureFolder(target.split("/").slice(0, -1).join("/"));
    if (!this.vault.getAbstractFileByPath(target)) await this.vault.create(target, record.markdown);
    const sideNow = await this.vault.adapter.read(sidePath).catch(() => undefined);
    if (after !== undefined && sideNow !== after) {
      if (sideNow !== before) throw new Error("Coffee Tables hidden data changed during restore; the Markdown and recovery record were preserved");
      if (sideNow === undefined) await this.writeHidden(sidePath, after); else await this.writeHidden(sidePath, after, sideNow);
    }
    const { restoreJournal: _journal, ...committed } = stagedRecord, completed = JSON.stringify({ ...committed, restoredPath: target }, null, 2);
    await this.writeHidden(bundlePath, completed, stagedRaw);
    await this.vault.adapter.remove(bundlePath).catch(() => undefined);
    this.deletedIds.delete(record.id);
    this.locations.set(record.id, target); this.originals.set(record.id, record.markdown);
    if (after !== undefined) { this.sidecarOriginals.set(record.id, after); this.revisions.set(record.id, (JSON.parse(after) as Sidecar).revision); }
    return target;
  }
  async duplicateLegacy(legacy: LegacyCoffeeSession): Promise<CoffeeSession> { const copy = copyLegacySession(legacy); await this.save(copy); return copy; }
}
function migrateGuests(value: unknown): CoffeeSession["guests"] { if (!value || typeof value !== "object") return undefined; const raw = value as Record<string, unknown>; if (raw.counts) return raw as unknown as CoffeeSession["guests"]; const selected = Array.isArray(raw.perspectives) ? raw.perspectives as string[] : ["experts", "cross-domain", "generalist", "affected"]; return { counts: { experts: selected.includes("experts") ? 4 : 0, "cross-domain": selected.includes("cross-domain") ? 1 : 0, generalist: selected.includes("generalist") ? 1 : 0, affected: selected.includes("affected") ? 1 : 0 }, guests: [], background: typeof raw.background === "string" ? raw.background : "", customPrompt: "" }; }
function conversationHash(rounds: CoffeeRound[], questions: CoffeeSession["questions"], interventions: NonNullable<CoffeeSession["interventions"]>): string { return contentHash(JSON.stringify({ rounds: rounds.map(round => demoteRootHeadings(round.markdown)).filter(Boolean), questions: questions.map(({ question, answer, draftAnswer, invitedGuests }) => [question, answer, draftAnswer ?? "", invitedGuests ?? []]), interventions: interventions.map(item => demoteRootHeadings(item.text)) })); }
function interleaveInterventions(markdown: string, interventions: NonNullable<CoffeeSession["interventions"]>): string { if (!interventions.length) return demoteRootHeadings(markdown); const chunks = markdown.split(/(?=^### .+$)/gm), output: string[] = []; let turns = 0, inserted = new Set<string>(); const insertThrough = (count: number): void => { for (const item of interventions) if (!inserted.has(item.id) && (item.afterTurn ?? 0) <= count) { const quoted = item.text.trim().split("\n").map((line, index) => index === 0 ? `> **你（插話）**：${line}` : `> ${line}`).join("\n"); output.push("", quoted, ""); inserted.add(item.id); } }; for (const chunk of chunks) { if (/^### .+$/m.test(chunk)) insertThrough(turns); output.push(demoteRootHeadings(chunk)); if (/^### .+$/m.test(chunk)) turns++; } insertThrough(turns); return output.join("\n").trim(); }
function contentHash(value: string): string { let hash = 2166136261; for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i),16777619); return (hash >>> 0).toString(16); }
function demoteRootHeadings(markdown: string): string { return markdown.split("\n").map(line => /^(#{1,2})\s/.test(line) ? `##${line}` : line).join("\n"); }
function shortHash(value: string): string { let hash = 2166136261; for (const character of value.normalize("NFC").trim()) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619); return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 8); }
export function topicSlug(topic: string): string { const printable = Array.from(topic.normalize("NFC")).filter(character => (character.codePointAt(0) ?? 0) >= 32).join(""); const slug = Array.from(printable.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").replace(/[. ]+$/g, "").trim()).slice(0, 80).join("").trim(); return slug || "Coffee Table"; }
