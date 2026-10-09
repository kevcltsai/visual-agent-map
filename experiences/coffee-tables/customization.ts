import type { CoffeeInsightCategory } from "./insights";

export type CoffeePreserveRule = "disagreements" | "conditions" | "counterexamples" | "questions" | "sources";
export interface CoffeeCustomization {
  observerPrompt: string;
  convergencePrompt: string;
  mergeLevel: "detailed" | "balanced" | "compact";
  detailLevel: "brief" | "standard" | "detailed";
  preserve: CoffeePreserveRule[];
}
export interface CoffeeConvergenceProposal {
  sourceIds: string[];
  summary: string;
  detail: string;
  category: CoffeeInsightCategory;
}
export interface CoffeeConvergenceDraft {
  baseFingerprint: string;
  proposals: CoffeeConvergenceProposal[];
  raw: string;
  createdAt: string;
  customization: CoffeeCustomization;
}

const PRESERVE_RULES: CoffeePreserveRule[] = ["disagreements", "conditions", "counterexamples", "questions", "sources"];
const CATEGORIES: CoffeeInsightCategory[] = ["connections", "questions", "disagreements", "directions", "assumptions", "solutions"];
const PROTECTED_METADATA = /coffee-insight\s*:|coffee-tables-complete|<!--\s*source\s*:|<!--\s*coffee-tables-/i;
const MARKDOWN_INJECTION = /<!--|^\s{0,3}#{1,6}\s|^\s*coffee-insight\s*:/im;

export function defaultCustomization(language: string): CoffeeCustomization {
  const zh = language === "zh-TW";
  return {
    observerPrompt: zh
      ? "整理具體洞見與脈絡，保留不同理由、成立條件與尚未解決的問題；不補充對談未提及的事實。"
      : "Capture concrete insights with context. Keep differing reasons, conditions and unresolved questions; do not add facts absent from the conversation.",
    convergencePrompt: zh
      ? "讓每項整理仍能看出原本的想法與來由；只有內容確實重疊時才合併。"
      : "Keep each item recognizable with its original reasoning. Merge items only when their substance overlaps.",
    mergeLevel: "balanced",
    detailLevel: "standard",
    preserve: [...PRESERVE_RULES],
  };
}

export function normalizeCustomization(value: unknown, language: string): CoffeeCustomization {
  const fallback = defaultCustomization(language);
  if (!value || typeof value !== "object") return fallback;
  const raw = value as Record<string, unknown>;
  const candidate: CoffeeCustomization = {
    observerPrompt: typeof raw.observerPrompt === "string" ? raw.observerPrompt : fallback.observerPrompt,
    convergencePrompt: typeof raw.convergencePrompt === "string" ? raw.convergencePrompt : fallback.convergencePrompt,
    mergeLevel: raw.mergeLevel === "detailed" || raw.mergeLevel === "balanced" || raw.mergeLevel === "compact" ? raw.mergeLevel : fallback.mergeLevel,
    detailLevel: raw.detailLevel === "brief" || raw.detailLevel === "standard" || raw.detailLevel === "detailed" ? raw.detailLevel : fallback.detailLevel,
    preserve: Array.isArray(raw.preserve) ? [...new Set(raw.preserve.filter((item): item is CoffeePreserveRule => PRESERVE_RULES.includes(item as CoffeePreserveRule)))] : fallback.preserve,
  };
  return candidate;
}

export function validateCustomization(value: CoffeeCustomization, language?: string): string[] {
  const zh = language === "zh-TW";
  const errors: string[] = [];
  if (!value || typeof value !== "object") return [zh ? "自訂內容格式無效。" : "Customization must be an object."];
  for (const [field, prompt] of [["observerPrompt", value.observerPrompt], ["convergencePrompt", value.convergencePrompt]] as const) {
    if (typeof prompt !== "string") { errors.push(zh ? "觀察者與整併偏好必須是文字。" : `${field} must be text.`); continue; }
    if (prompt.length > 12_000) errors.push(zh ? "每段偏好最多 12,000 個字元。" : "Each preference must be 12,000 characters or fewer.");
    if (PROTECTED_METADATA.test(prompt)) errors.push(zh ? "偏好不能包含 Coffee Tables 保留的內部標記。" : "Preferences cannot contain reserved Coffee Tables metadata.");
  }
  if (!["detailed", "balanced", "compact"].includes(value.mergeLevel)) errors.push(zh ? "整併程度選項無效。" : "The merge level is invalid.");
  if (!["brief", "standard", "detailed"].includes(value.detailLevel)) errors.push(zh ? "脈絡詳略選項無效。" : "The detail level is invalid.");
  if (!Array.isArray(value.preserve) || value.preserve.some(item => !PRESERVE_RULES.includes(item))) errors.push(zh ? "保留項目含有不支援的選項。" : "The preserve list contains an unsupported value.");
  return errors;
}

export function validateConvergenceText(summary: string, detail: string, language?: string): string[] {
  const zh = language === "zh-TW", errors: string[] = [];
  if (typeof summary !== "string" || !summary.trim()) errors.push(zh ? "洞見摘要不可空白。" : "Insight summaries cannot be empty.");
  else if (summary.length > 1_000) errors.push(zh ? "洞見摘要最多 1,000 個字元。" : "Insight summaries must be 1,000 characters or fewer.");
  if (typeof summary === "string" && /[\r\n]/.test(summary)) errors.push(zh ? "洞見摘要請使用單行文字。" : "Insight summaries must be a single line.");
  if (typeof detail !== "string" || detail.length > 12_000) errors.push(zh ? "洞見脈絡最多 12,000 個字元。" : "Insight context must be 12,000 characters or fewer.");
  if ((typeof summary === "string" && MARKDOWN_INJECTION.test(summary)) || (typeof detail === "string" && MARKDOWN_INJECTION.test(detail)) || (typeof summary === "string" && PROTECTED_METADATA.test(summary)) || (typeof detail === "string" && PROTECTED_METADATA.test(detail))) errors.push(zh ? "洞見不能包含標題或內部標記。" : "Insights cannot contain headings or internal metadata markers.");
  return errors;
}

export function observerGuidance(language: string, customization: CoffeeCustomization): string {
  const zh = language === "zh-TW";
  const preserveLabels: Record<CoffeePreserveRule, string> = zh
    ? { disagreements: "歧見", conditions: "成立條件", counterexamples: "反例", questions: "未解問題", sources: "來源脈絡" }
    : { disagreements: "disagreements", conditions: "conditions", counterexamples: "counterexamples", questions: "open questions", sources: "source context" };
  const merge = zh
    ? { detailed: "除明確重複外，分開保留洞見。", balanced: "僅合併實質重疊的洞見。", compact: "可合併密切相關的洞見，但保留各自理由。" }[customization.mergeLevel]
    : { detailed: "Keep insights separate unless they clearly repeat one another.", balanced: "Merge only insights with substantially overlapping meaning.", compact: "Combine closely related insights while retaining each line of reasoning." }[customization.mergeLevel];
  const detail = zh
    ? { brief: "展開脈絡簡潔扼要。", standard: "提供足以理解洞見的脈絡。", detailed: "完整交代理由、例子、條件與限制。" }[customization.detailLevel]
    : { brief: "Keep expanded context concise.", standard: "Give enough context to understand each insight.", detailed: "Fully explain reasoning, examples, conditions and limits." }[customization.detailLevel];
  return `${zh ? "使用者觀察者偏好" : "User observer preferences"}:\n${customization.observerPrompt.trim()}\n${merge}\n${detail}\n${zh ? "明確保留" : "Explicitly preserve"}: ${customization.preserve.map(rule => preserveLabels[rule]).join("、") || (zh ? "依洞見脈絡判斷" : "as supported by the insight context")}.`;
}

export function parseConvergenceProposals(raw: string, baselineIds: string[]): CoffeeConvergenceProposal[] {
  const json = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const decoded: unknown = JSON.parse(json);
  const proposalsValue = Array.isArray(decoded) ? decoded : decoded && typeof decoded === "object" ? (decoded as { proposals?: unknown }).proposals : undefined;
  if (!Array.isArray(proposalsValue)) throw new Error("Convergence response must contain a proposals array");
  const expected = new Set(baselineIds), accounted = new Set<string>();
  const proposals = proposalsValue.map((value): CoffeeConvergenceProposal => {
    if (!value || typeof value !== "object") throw new Error("Convergence proposal must be an object");
    const item = value as Record<string, unknown>;
    if (!Array.isArray(item.sourceIds) || item.sourceIds.some(id => typeof id !== "string" || !expected.has(id))) throw new Error("Convergence proposal references an unknown insight ID");
    const sourceIds = [...new Set(item.sourceIds as string[])];
    if (sourceIds.length !== item.sourceIds.length || !sourceIds.length) throw new Error("Each proposal must account for one or more baseline insights exactly once");
    for (const id of sourceIds) {
      if (accounted.has(id)) throw new Error("A baseline insight is accounted for more than once");
      accounted.add(id);
    }
    if (typeof item.summary !== "string" || typeof item.detail !== "string" || validateConvergenceText(item.summary, item.detail).length || !CATEGORIES.includes(item.category as CoffeeInsightCategory)) throw new Error("Convergence proposal is missing valid text or category");
    return { sourceIds, summary: item.summary.trim(), detail: item.detail.trim(), category: item.category as CoffeeInsightCategory };
  });
  if (accounted.size !== expected.size || [...expected].some(id => !accounted.has(id))) throw new Error("Every baseline insight must be accounted for exactly once");
  return proposals;
}
