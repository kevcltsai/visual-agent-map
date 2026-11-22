/** The cards of an `edit_book_plan` reply as before and after, for the plan card: only the fields that really change, in the owner's words. */
import { t } from "../../i18n";
import { readBrief, type PromptBrief } from "../../core/book-pipeline/plan-edit";
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
