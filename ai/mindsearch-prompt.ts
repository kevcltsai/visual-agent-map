import { translate, type UiLanguage } from "../i18n";
import type { TaskContext } from "./types";

export function mindSearchPhase(task: string): string | undefined {
  return task.match(/<!--\s*mindsearch-phase:\s*([a-z-]+)\s*-->/)?.[1];
}

function phaseGuidance(phase: string | undefined, language: UiLanguage, responseContract?: TaskContext["responseContract"]): string {
  const english = language === "en";
  const gapAuditContract = phase === "research-gap-audit" && responseContract === "mindsearch-gap-audit";
  const common = gapAuditContract
    ? english
      ? "Follow the phase task and the dedicated response schema exactly. Do not add a marker, suggestions, or visual references. Do not impose a fixed heading template or turn this audit into a complete knowledge page."
      : "嚴格遵循本階段任務與專用回應 schema。不要增加標記、建議或視覺參考；不要套用固定標題模板，也不要把稽核改寫成完整知識頁。"
    : english
      ? "Follow the phase task and its machine-readable marker exactly. Do not impose a fixed heading template or turn planning, review, repair, or research into a complete knowledge page."
      : "依照本階段任務與機器可讀標記處理。不要套用固定標題模板，也不要把規劃、審查、修復或研究階段改寫成完整知識頁。";
  const phaseRules: Record<string, string> = english ? {
    "research-gap-audit": "Write the rationale first in detail, then set summary to exactly user_condition or external_evidence. Return empty suggestions and visualReferences arrays.",
    "initial-clarification": "Ask only necessary unknown user conditions. Put the intake marker in detail; an empty suggestions array is valid.",
    "initial-question": "When asking, put one question in summary and 2–5 distinct answer choices in suggestions[].title; keep the other suggestion fields empty. Do not answer for the user.",
    "research-plan": "Return the requested plan marker with 2–5 distinct research targets. The plan belongs in detail; do not answer the goal or research in this Planner turn.",
    "research-plan-repair": "Repair only the requested plan format using the supplied context. Return 2–5 distinct targets in the requested detail marker; do not research.",
    "subtopic-research": "Research only the assigned target. Report search status accurately, distinguish evidence from uncertainty, and preserve source attribution. Do not ask the user.",
    "targeted-followup-research": "Research the single assigned evidence gap. Report search status accurately, distinguish evidence from uncertainty, and preserve source attribution. Do not ask the user.",
    "report-review": "For research_more, return exactly one targeted suggestion. For ask_user, return 2–5 distinct choices in suggestions[].title. For conclude, include the required stop reason. Follow the decision marker contract.",
    "decision-quality-review": "Review only the supplied candidate and evidence. For research_more, return exactly one targeted suggestion. For ask_user, return 2–5 distinct choices in suggestions[].title. For conclude, include the required stop reason. Follow the decision marker contract.",
    "format-repair": "Repair only missing or malformed required fields. Preserve the existing decision and user question exactly; do not reinterpret evidence, change the decision, or add facts.",
    "delivery-outline": "Design the requested document outline and return its marker. Do not write the document or perform research.",
    "delivery-research": "Research only the agreed final-document outline. Report availability accurately and preserve source attribution. Do not write the document or ask the user.",
    "delivery-writing": "Write the requested reader-facing deliverable from supplied context and evidence. Follow the task's requested structure and preserve attribution and uncertainty.",
    "delivery-acceptance": "Review the complete deliverable against the original goal and task contract. Return the required decision marker and a brief acceptance note or list of issues; do not reproduce or rewrite the draft. If research_more is required, identify one concrete evidence target. Do not ask the user."
  } : {
    "research-gap-audit": "先在 detail 撰寫簡短理由，再將 summary 設為完全相同的 user_condition 或 external_evidence。suggestions 與 visualReferences 必須是空陣列。",
    "initial-clarification": "只詢問必要且未知的使用者條件。將 intake 標記放在 detail；suggestions 可以是空陣列。",
    "initial-question": "需要提問時，在 summary 寫一個問題，並在 suggestions[].title 提供 2–5 個不同選項；其他 suggestion 欄位留空。不要代替使用者回答。",
    "research-plan": "依要求在 detail 回傳規劃標記，包含 2–5 個不同研究目標；此 Planner 階段不要回答整體目標或進行研究。",
    "research-plan-repair": "只依提供的脈絡修復規劃格式，在 detail 標記中回傳 2–5 個不同目標；不要進行研究。",
    "subtopic-research": "只研究指定目標。準確回報搜尋狀態，區分證據與不確定性並保留來源歸屬；不要詢問使用者。",
    "targeted-followup-research": "只研究指定的一項證據缺口。準確回報搜尋狀態，區分證據與不確定性並保留來源歸屬；不要詢問使用者。",
    "report-review": "research_more 必須回傳恰好一個目標建議；ask_user 必須在 suggestions[].title 提供 2–5 個不同選項；conclude 必須包含必要的停止理由。遵守決策標記契約。",
    "decision-quality-review": "只審查提供的候選決策與證據。research_more 必須回傳恰好一個目標建議；ask_user 必須在 suggestions[].title 提供 2–5 個不同選項；conclude 必須包含必要的停止理由。遵守決策標記契約。",
    "format-repair": "只修復缺漏或格式錯誤的必要欄位。原樣保留既有決策與使用者問題；不要重新解讀證據、改變決策或新增事實。",
    "delivery-outline": "設計要求的文件大綱並回傳標記；不要撰寫文件或進行研究。",
    "delivery-research": "只研究已確認的最終文件大綱。準確回報可取得性並保留來源歸屬；不要撰寫文件或詢問使用者。",
    "delivery-writing": "依提供的脈絡與證據撰寫要求的讀者文件，遵循任務指定結構並保留來源歸屬與不確定性。",
    "delivery-acceptance": "依原始目標與任務契約審查完整交付內容。回傳必要決策標記與簡短通過說明或問題清單；不要重複或改寫草稿。需要 research_more 時指出一個具體證據目標。不要詢問使用者。"
  };
  return [common, phase ? phaseRules[phase] : ""].filter(Boolean).join("\n\n");
}

/** Builds the compact MindSearch prompt while retaining the regular AiResult JSON contract. */
export function buildMindSearchPrompt(context: TaskContext, language: UiLanguage): string {
  const phase = mindSearchPhase(context.task);
  const languageInstruction = language === "en"
    ? "Write generated content in English unless the current task or topic rules explicitly request another language. Preserve quoted source text and proper names."
    : "新產生的內容使用繁體中文，除非目前任務或議題規則明確指定其他語言。保留來源原文引述與專有名稱。";
  const field = (label: string, value: string | undefined) => value?.trim() ? `${label}:\n${value}` : "";
  const blocks = [
    languageInstruction,
    translate(language, "prompt.role"),
    translate(language, "prompt.source_safety"),
    context.sourceContext ? translate(language, "prompt.reference_citations") : "",
    context.sourceContext && context.researchMode !== "local" ? translate(language, "prompt.local_first") : "",
    language === "en"
      ? "Return JSON only, matching the supplied response schema and including every required field. MindSearch has visual search disabled, so visualReferences must be an empty array."
      : "只回傳符合提供之 response schema 的 JSON，並包含所有必要欄位。MindSearch 未啟用視覺搜尋，因此 visualReferences 必須是空陣列。",
    phaseGuidance(phase, language, context.responseContract),
    context.researchMode === "local"
      ? language === "en" ? "Do not use web search in this local-only phase." : "此階段僅使用本次提供的內容，不要進行網路搜尋。"
      : context.researchMode === "research"
        ? language === "en" ? "Use available web search tools when the phase task requires external evidence. Report search status truthfully." : "階段任務需要外部證據時使用可用的網路搜尋工具，並如實回報搜尋狀態。"
        : "",
    field(translate(language, "prompt.label_topic"), context.title),
    field(translate(language, "prompt.label_summary"), context.summary),
    context.detail ? `${language === "en" ? "Current detail and supplied reports" : "目前內容與提供的報告"}:\n${context.detail}` : "",
    field(translate(language, "prompt.label_rules"), context.rules),
    context.workingFindings ? `${language === "en" ? "Previous findings" : "先前發現"}:\n${context.workingFindings}` : "",
    context.sourceContext ? `${translate(language, "prompt.label_sources")}:\n${context.sourceContext}` : "",
    field(translate(language, "prompt.label_ancestors"), context.ancestors),
    field(translate(language, "prompt.label_task"), context.task)
  ];
  return blocks.filter(Boolean).join("\n\n");
}
