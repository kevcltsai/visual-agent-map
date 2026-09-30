import type { CoffeeSession, GuestSettings } from "./types";

export const MAX_COFFEE_CONTEXT_CHARS = 180_000;
/** Assemble every persisted conversational event in timestamp order. Drafts are
 * first-class context so a retry can continue without silently losing text. */
export function assembleCoffeeContext(session: CoffeeSession): string {
  const events: Array<{ at: number; order: number; text: string }> = [];
  let order = 0;
  const add = (at: string | undefined, text: string): void => {
    if (!text.trim()) return;
    const parsed = at ? Date.parse(at) : Number.NaN;
    events.push({ at: Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER, order: order++, text: text.trim() });
  };
  const rounds = session.rounds ?? [];
  const attachedInterventions = new Set<string>();
  if (rounds.length) {
    for (const round of rounds) {
      const source = round.markdown || round.draftMarkdown || "";
      const attached = (session.interventions ?? []).filter(item => item.roundId === round.id).sort((a, b) => (a.afterTurn ?? 0) - (b.afterTurn ?? 0) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
      for (const item of attached) attachedInterventions.add(item.id);
      if (!attached.length || !/^###\s+/m.test(source)) { add(round.createdAt, [source, ...attached.map(item => `使用者介入：${item.text}`)].filter(Boolean).join("\n\n")); continue; }
      const parts = source.split(/(?=^###\s+)/m), output: string[] = [];
      let speakerTurns = 0, nextIntervention = 0;
      const inject = (limit: number): void => { while (nextIntervention < attached.length && (attached[nextIntervention].afterTurn ?? 0) <= limit) output.push(`使用者介入：${attached[nextIntervention++].text}`); };
      for (const part of parts) {
        if (/^###\s+/.test(part)) { inject(speakerTurns); output.push(part); speakerTurns++; inject(speakerTurns); }
        else { inject(0); if (part.trim()) output.push(part); }
      }
      inject(Number.MAX_SAFE_INTEGER);
      add(round.createdAt, output.join("\n\n"));
    }
  } else add(session.createdAt, session.transcriptMarkdown);
  for (const question of session.questions) {
    if (question.status === "pending" && !question.answer && !question.draftAnswer) continue;
    add(question.createdAt, `使用者追問：${question.question}\n桌上回答：${question.answer || question.draftAnswer || "（回答尚未完成）"}`);
  }
  for (const intervention of session.interventions ?? []) if (!attachedInterventions.has(intervention.id)) add(intervention.createdAt, `使用者介入：${intervention.text}`);
  events.sort((a, b) => a.at - b.at || a.order - b.order);
  const notes = session.observerNotes?.[0] ? `目前觀察者整理（只用來推進討論，不要重寫）：\n${session.observerNotes[0]}` : "";
  return [...events.map(item => item.text), notes].filter(Boolean).join("\n\n");
}
const LABELS = { experts: "主題專家", "cross-domain": "跨領域專家", generalist: "好奇的通才 generalist", affected: "受影響者" } as const;
function names(guests: GuestSettings): string[] { return (["experts", "cross-domain", "generalist", "affected"] as const).flatMap(category => Array.from({ length: guests.counts[category] }, (_, index) => { const named = guests.guests.filter(item => item.category === category)[index]; return named ? `${LABELS[category]}：${named.description}` : LABELS[category]; })); }
export function tablePrompt(topic: string, language: string, guests?: GuestSettings, draft = "", priorContext = ""): string {
  const zh = language === "zh-TW"; const languageLine = zh ? "請用自然、口語的繁體中文（台灣用法）寫作。" : "Write in natural, conversational English.";
  const settings = guests ?? { counts: { experts: 4, "cross-domain": 1, generalist: 1, affected: 1 }, guests: [], background: "", customPrompt: "" };
  const attendeeRoles = names(settings).map(role => `- ${role}`);
  const background = settings.background.trim() ? `\n補充背景：${settings.background.trim()}` : "";
  const custom = settings.customPrompt.trim() ? `\n\n使用者的額外要求（影響討論焦點、例子與語氣；不可更改既定來賓人數、輸出結構、模擬聲明及收尾條件）：\n${settings.customPrompt.trim()}` : "";
  const continuing = !!(draft || priorContext);
  const turns = zh ? continuing ? "這是接續段，新增約 8–12 次簡短發言。沿用原桌人物，優先碰觸還沒解開的問題、回應使用者介入或追問；不要重複原本立場。" : "全桌約 10–18 次簡短發言為軟目標。" : continuing ? "This is a continuation: add roughly 8–12 concise speaker turns. Keep the same guests, pursue unresolved questions and respond to the user's follow-up; do not repeat earlier positions." : "Aim for roughly 10–18 concise speaker turns across the table.";
  const continuationGuard = zh ? "這是同一場對談的接續，直接從上一句接續對談。不要輸出工作流程、計畫、確認或自我說明，不要寫任何前言，也不要重列人物介紹或重述已完成的對談。第一個可見內容必須是自然的對談發言；若草稿最後一句尚未說完，順著語意接完。" : "This is the same table continuing. Continue the conversation directly from the last sentence. Do not output process notes, plans, confirmations or self-commentary; do not add a preamble, repeat the guest introductions, or restate completed dialogue. The first visible content must be a natural dialogue turn; if the draft ends mid-sentence, complete it naturally.";
  const notes = zh ? "最後必須輸出完整的「# 觀察者整理」，並嚴格使用以下五個 Markdown 二級標題（每個標題下 2–4 個條列）：## 意外連結、## 值得繼續想的問題、## 核心分歧、## 探索方向、## 值得查證的假設。標題與條列不可省略，也不要把觀察者整理寫成對談發言。整合本段與前文的最新轉折、修正假設、值得繼續追問的問題及尚未解決的核心分歧，只納入對談實際提及的內容，不添加新事實。全部整理完成後，最後單獨輸出 `<!-- coffee-tables-complete -->` 作為完成標記，不要在標記後加任何內容。" : "End with a complete `# Observer’s notes` and use exactly these five Markdown second-level headings, each followed by 2–4 bullets: `## Unexpected connections`, `## Questions worth pursuing`, `## Core disagreements`, `## Directions to explore`, and `## Assumptions to verify`. Do not omit headings or present the notes as dialogue. Integrate the latest turns, revised assumptions, questions worth pursuing and unresolved disagreements with the previous discussion; use only points grounded in the conversation. After all notes are complete, output `<!-- coffee-tables-complete -->` alone as the final line, with nothing after it.";
  const prior = priorContext ? `\n\n先前對談與追問（只作脈絡，不要重寫）：\n${priorContext}` : "";
  const draftText = draft ? `\n\n本段已收到的草稿，請從最後一句接續：\n${draft}` : "";
  const hostCount = settings.hostCount ?? 2;
  const hostInstruction = zh ? hostCount === 1 ? "1 位主持人，同時兼具抓矛盾與好奇追問，依對話需要切換。" : hostCount === 2 ? "2 位風格不同的主持人：一位抓矛盾，一位好奇追問。" : `${hostCount} 位主持人，風格互補且不要重複總結。` : hostCount === 1 ? "1 host who combines sharp contradiction-spotting with curious follow-up questions." : hostCount === 2 ? "2 hosts with distinct styles: one sharp and contradiction-focused, the other curious and probing." : `${hostCount} hosts with complementary styles who avoid repetitive summaries.`;
  const opening = continuing ? `${continuationGuard}\n\n` : "開頭列參與者（每人一行「- **姓名｜角色**：簡短背景」）。";
  const prompt = `請模擬一場 Coffee Table 式多人對談。主持人人數由使用者指定；觀察者固定，其餘來賓依下列人數安排。${languageLine}\n\n使用者原始主題（完整保留，不另取聊天室標題）：\n${topic}\n\n固定人物：\n- ${hostInstruction}\n- 1 位中立觀察者\n來賓名額：\n${attendeeRoles.join("\n")}\n每位人物都要用簡短背景介紹。不得超出指定類別人數；人物與經驗均為 AI 虛構模擬，不代表真人證言或已查證事實。${background}${custom}${prior}${draftText}\n\n人物彼此自然接話、追問、挑戰與修正，不要輪流發表文章。使用白話與生活例子，主持人適度串連，不要每輪總結。${settings.counts["cross-domain"] ? "跨領域類比要說明相似處與限制。" : "本桌沒有跨領域來賓，不要硬加跨領域專家或類比。"}\n\n${turns}涵蓋不同角度與未解問題；出現重複時自然收尾，不強迫每位來賓發言。\n\n用 Markdown 輸出且不要替桌聊另寫標題。${opening}每次發言使用「### 姓名｜角色」；最後是觀察者整理。${notes}`;
  if (prompt.length > MAX_COFFEE_CONTEXT_CHARS) throw new Error(zh ? "這桌的內容太長，無法安全地全部交給模型。請先開新桌；舊內容已完整保留。" : "This table is too long to send safely in full. Start a new table; the existing conversation is preserved.");
  return prompt;
}
export function questionPrompt(session: CoffeeSession, question: string, draft = ""): string {
  const zh = session.language === "zh-TW", language = zh ? "請用自然、口語的繁體中文回答。" : "Answer in natural, conversational English.";
  const settings = session.guests;
  const custom = settings?.customPrompt.trim() ? `\n桌聊額外要求：\n${settings.customPrompt.trim()}` : "";
  const context = assembleCoffeeContext(session);
  if (context.length + question.length > MAX_COFFEE_CONTEXT_CHARS) throw new Error(zh ? "這桌的內容太長，無法安全地全部交給模型。請先開新桌；舊內容已完整保留。" : "This table is too long to send safely in full. Start a new table; the existing conversation is preserved.");
  return `延續 Coffee Tables 對談回答追問。由最相關的一位或幾位原來賓自然接話；若點名來賓就讓其回應。保留歧見，只引用對談實際說過的內容，不重演整桌或補造已查證事實。人物是虛構模擬。${language}${custom}\n\n完整先前對談與追問：\n${context}\n\n使用者的新問題：\n${question}${draft ? `\n\n上次中斷前已保存的回答草稿，請從最後一句繼續，不要重複：\n${draft}` : ""}\n\n用 Markdown 輸出自然接話，每段標示發言者，之後附上完整的「# 觀察者整理」，並嚴格使用以下五個 Markdown 二級標題（每個標題下 2–4 個條列）：## 意外連結、## 值得繼續想的問題、## 核心分歧、## 探索方向、## 值得查證的假設。標題與條列不可省略，也不要把整理寫成對談發言。整合前文及本次接續的轉折、修正假設、新問題與未解分歧；勿添加新事實。全部整理完成後，最後單獨輸出完成標記 <!-- coffee-tables-complete --> 作為完成標記，不要在標記後加任何內容。`;
}

export function observerOnlyPrompt(session: CoffeeSession): string {
  const zh = session.language === "zh-TW";
  const history = [assembleCoffeeContext(session), session.draftMarkdown ? `未完成對談草稿：\n${session.draftMarkdown}` : "", session.observerDraftMarkdown ? `觀察者整理草稿：\n${session.observerDraftMarkdown}` : ""].filter(Boolean).join("\n\n");
  if (history.length > MAX_COFFEE_CONTEXT_CHARS) throw new Error(zh ? "這桌的內容太長，無法安全地全部交給模型。舊內容已完整保留。" : "This table is too long to summarize safely in full. The existing conversation is preserved.");
  const instructions = zh
    ? "只更新觀察者整理。不要續寫、補寫或改寫任何來賓對話，不要聲稱討論已完成。根據全部已完成與未完成內容整理這五項，每項列出具體、可追溯到對話的觀察；不得添加新事實或替使用者下結論。最後輸出 coffee-tables-complete 標記。"
    : "Only produce refreshed observer notes. Do not continue, add, or rewrite any guest dialogue, and do not claim the discussion is complete. Summarize these five areas from all completed and unfinished content, with concrete observations grounded in the conversation; add no facts and do not decide for the user. End with the coffee-tables-complete marker.";
  const headings = zh ? "## 意外連結\n## 值得繼續想的問題\n## 核心分歧\n## 探索方向\n## 值得查證的假設" : "## Unexpected connections\n## Questions worth pursuing\n## Core disagreements\n## Directions to explore\n## Assumptions to verify";
  return `${zh ? "請用自然、口語的繁體中文。" : "Write in natural, conversational English."}\n${instructions}\n${session.guests?.customPrompt?.trim() ? `${zh ? "整桌額外要求" : "Table instructions"}: ${session.guests.customPrompt.trim()}\n` : ""}\n${zh ? "完整對談、追問、介入及草稿" : "Full conversation, follow-ups, interventions and drafts"}:\n${history}\n\n# ${zh ? "觀察者整理" : "Observer’s notes"}\n\n${headings}\n\n<!-- coffee-tables-complete -->`;
}
