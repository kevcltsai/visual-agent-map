/** The cards of an `edit_book_plan` reply as before and after, for the plan card: only the fields that really change, in the owner's words. */
import { t } from "../../i18n";
import { readBrief, type PromptBrief } from "../../core/book-pipeline/plan-edit";
import {
  chatStructureOps,
  reviewAffected,
  simulateStructure,
  type RejectCode
} from "../../core/book-pipeline/structure-edit";
import { itemText, placer } from "./book-pipeline-ui";
import type { MapChatContext } from "../../core/map-chat-context";
import type { MapChatAction } from "../../core/steps/map-chat/step";
import type { MapChatPlanDiffCard } from "./map-chat";

/** The brief fields in the order the card shows them; the covers line has no name (it is the card's own line). */
const FIELDS = ["covers", "entry", "points", "handoff", "previous", "checklist"] as const;
const LABEL: Record<(typeof FIELDS)[number], Parameters<typeof t>[0] | ""> = {
  covers: "",
  entry: "ui.map_chat_book_field_entry",
  points: "ui.map_chat_book_field_points",
  handoff: "ui.map_chat_book_field_handoff",
  previous: "ui.map_chat_book_field_previous",
  checklist: "ui.map_chat_book_field_checklist"
};

/**
 * One entry per changed card: its title (as of the proposal) and each field whose new value differs from the card's Prompt then.
 * A card that is not in the proposal's baseline, or whose fields all stay, is left out; no entry at all returns undefined.
 */
export function bookPlanDiff(
  action: Extract<MapChatAction, { kind: "edit_book_plan" }>,
  baseline: Pick<MapChatContext, "bookPlan"> | undefined
): MapChatPlanDiffCard[] | undefined {
  const prompts = baseline?.bookPlan?.prompts;
  if (!prompts) return undefined;
  const join = (items: readonly string[]): string => items.join(t("ui.map_chat_count_separator"));
  const cards: MapChatPlanDiffCard[] = [];
  for (const change of action.changes) {
    const known = prompts[change.id];
    if (!known) continue;
    const before: PromptBrief = readBrief(known.prompt);
    const text = (field: (typeof FIELDS)[number], from: "before" | "after"): string | undefined => {
      if (from === "before")
        return field === "points"
          ? join(before.points)
          : field === "checklist"
            ? join(before.checklist.map(item => item.text))
            : before[field];
      const value = change[field];
      if (value === undefined) return undefined;
      return field === "points" || field === "checklist"
        ? join(
            (value as readonly (string | { text: string })[]).map(item => (typeof item === "string" ? item : item.text))
          )
        : (value as string);
    };
    const fields = FIELDS.flatMap(field => {
      const after = text(field, "after");
      const old = text(field, "before") ?? "";
      return after === undefined || after === old
        ? []
        : [{ label: LABEL[field] && t(LABEL[field]), before: old, after }];
    });
    if (fields.length) cards.push({ title: known.title ?? change.id, fields });
  }
  return cards.length ? cards : undefined;
}

/** The thread change as a card (before struck through, after marked); undefined when there is no thread in the baseline or nothing changes. */
export function bookThreadDiff(
  action: Extract<MapChatAction, { kind: "edit_book_thread" }>,
  baseline: Pick<MapChatContext, "bookPlan"> | undefined
): MapChatPlanDiffCard | undefined {
  const before = baseline?.bookPlan?.thread;
  if (before === undefined || before === action.content) return undefined;
  return {
    title: t("ui.map_chat_book_thread_title"),
    fields: [{ label: "", before, after: action.content }],
    note: t("ui.map_chat_book_thread_note"),
    place: "first"
  };
}

/** Why the structure rules refuse a change, in the owner's words (`name` is the card's title). */
export function structureRefusal(code: string, name: string): string {
  return code === "locked"
    ? t("ui.map_chat_skip_book_struct_locked_0", name)
    : code === "has_children"
      ? t("ui.map_chat_skip_book_struct_children_0", name)
      : t("ui.map_chat_skip_book_struct_rules");
}

/**
 * The structure change as a card: one line per change that would be applied, then what the rules already refuse, then the cost
 * (counted as the runner counts it: the same simulation against the proposal's tree, locked = not unlocked). Undefined without a tree.
 */
export function bookStructureCard(
  action: Extract<MapChatAction, { kind: "edit_book_structure" }>,
  baseline: Pick<MapChatContext, "bookPlan"> | undefined
): MapChatPlanDiffCard | undefined {
  const plan = baseline?.bookPlan;
  if (!plan?.nodes.length) return undefined;
  const rootId = plan.nodes[0].id;
  const input = { rootId, nodes: plan.nodes };
  const ops = chatStructureOps(action.items, input, "card");
  const locked = new Set(plan.nodes.map(node => node.id).filter(id => !plan.unlocked.includes(id)));
  const sim = simulateStructure(input, ops, locked);
  const names = new Map(plan.nodes.map(node => [node.id, node.title]));
  for (const a of sim.applied) if (a.op.kind === "add") names.set(a.op.ref, a.op.title);
  const nameOf = (id: string): string => names.get(id) ?? "";
  const before = placer(rootId, plan.nodes, nameOf);
  const after = placer(rootId, sim.result, nameOf);
  const lines: { text: string; small?: boolean }[] = sim.applied.map(a => ({
    text: itemText(a, nameOf(a.op.kind === "add" ? a.op.ref : a.op.card), rootId, before, after, nameOf)
  }));
  if (sim.applied.some(a => a.op.kind === "remove" || a.op.kind === "merge"))
    lines.push({ text: t("ui.map_chat_book_struct_archive_note"), small: true });
  if (sim.overCap) lines.push({ text: t("ui.map_chat_book_struct_over_cap_0", ops.length) });
  for (const rejected of sim.rejected)
    lines.push({
      text: structureRefusal(
        rejected.code satisfies RejectCode,
        rejected.op.kind === "add" ? rejected.op.title : nameOf(rejected.op.card)
      )
    });
  const cards = reviewAffected(rootId, plan.nodes, sim.result, sim.applied).size;
  return {
    title: t("ui.map_chat_book_struct_title"),
    fields: [],
    place: "last",
    lines,
    ...(sim.applied.length
      ? { note: cards ? t("ui.map_chat_book_struct_cost_0_1", cards, cards) : t("ui.map_chat_book_struct_cost_none") }
      : {})
  };
}
