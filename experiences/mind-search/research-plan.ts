import { createHash } from "node:crypto";
import type { MindSearchBranchRecord } from "../../map-model";

export type MindSearchResearchPlan = NonNullable<MindSearchBranchRecord["researchPlan"]>;
export type MindSearchResearchTarget = MindSearchResearchPlan[number];
export function researchContentHash(report: { summary: string; detail: string }): string {
  return createHash("sha256").update(JSON.stringify({ summary: report.summary, detail: report.detail })).digest("hex");
}

/** Legacy targets remain valid; explicit dependency metadata opts into bounded parallel work. */
export function validateMindSearchResearchPlan(subtopics: unknown): MindSearchResearchPlan {
  if (!Array.isArray(subtopics) || subtopics.length > 5 || subtopics.some((item: unknown) => {
    if (!item || typeof item !== "object") return true;
    const fields = item as Record<string, unknown>;
    return ["id", "title", "task", "expectedValue"].some(key => typeof fields[key] !== "string" || !fields[key].trim());
  })) throw new Error("Planner must return 0–5 valid research subtopics before the answer can proceed.");
  const plan = subtopics as MindSearchResearchPlan;
  const ids = new Set(plan.map(item => item.id));
  if (ids.size !== plan.length || new Set(plan.map(item => item.title.trim().toLowerCase())).size !== plan.length) throw new Error("Planner research subtopics must have unique ids and titles.");
  for (const item of plan) {
    if (item.action !== undefined && !["reuse", "update", "research"].includes(item.action)) throw new Error("Invalid MindSearch research action.");
    if (item.dependsOn !== undefined && (!Array.isArray(item.dependsOn) || new Set(item.dependsOn).size !== item.dependsOn.length || item.dependsOn.some(id => typeof id !== "string" || !ids.has(id) || id === item.id))) throw new Error("Research dependencies must name distinct existing targets other than themselves.");
    if (item.action === "reuse" || item.action === "update") {
      const source = item.source;
      if (!source || [source.branchId, source.resultId, source.notePath, source.contentHash].some(value => typeof value !== "string" || !value.trim()) || !Number.isInteger(source.version) || source.version < 1 || !/^[a-f0-9]{64}$/i.test(source.contentHash) || !item.rationale?.trim() || !item.validity?.reason?.trim() || !Array.isArray(item.validity.conditionKeys) || item.validity.conditionKeys.some(key => typeof key !== "string" || !key.trim())) throw new Error("Reuse and update targets need an exact source, rationale and condition validity assessment.");
    }
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Research dependencies cannot contain a cycle.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of plan.find(item => item.id === id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  return plan;
}
