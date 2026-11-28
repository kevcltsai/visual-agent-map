import type { Menu } from "obsidian";
import type { TranslationKey } from "../../i18n";
import type { MapNode } from "../../map-model";
import { MAP_KEYBOARD_SHORTCUTS } from "../../ui/modals/keyboard-shortcuts-modal";
import { isAiCard, type PromptNoteRef } from "./prompt-run";
import type { MapCommandAction } from "./view";

/**
 * The card actions (V3.3 P1.8): one list for the command palette, the card toolbar and its ⋯, the right-click menu, the
 * selection bar and the keys. Each action says where it is offered, whether it applies to a card at all, whether it can run
 * now (and why not), and runs through the view's own method. The palette, the card ⋯ and the right-click menu are drawn from
 * it (B05–B07); the other entries move onto it one by one (B08–B10).
 */
export type CardActionId =
  | "stop-run-all"
  | "add-topic"
  | "ai-root"
  | "add-child"
  | "edge-add-topic"
  | "edge-ai-card"
  | "add-sibling"
  | "research"
  | "style"
  | "run-stop"
  | "ai-lock"
  | "ai-settings"
  | "toggle-collapse"
  | "focus-branch"
  | "leave-focus"
  | "open-note"
  | "rename"
  | "add-summary-field"
  | "card-settings"
  | "run-card"
  | "ai-card"
  | "select-subtopics"
  | "summary-add"
  | "tidy-branch"
  | "note-style"
  | "add-other"
  | "knowledge-ref-copy"
  | "knowledge-ref-paste"
  | "impact"
  | "book"
  | "remove"
  | "reorder-sibling"
  | "zoom-fit"
  | "zoom-reset"
  | "search"
  | "shortcuts"
  | "batch-color"
  | "batch-size"
  | "merge"
  | "multi-research"
  | "move-to"
  | "synthesize"
  | "copy-to"
  | "add-frame"
  | "summary-add-selected"
  | "ai-lock-selected"
  | "clear-selection"
  | "remove-selected"
  | "selection-help"
  | "finish-selection"
  | "image-explore";
/**
 * Where an action is offered: the card toolbar or the selection bar, their ⋯ lists, the right-click menu, the command palette, a
 * key, the selected card's edge entries (V3.3 A6, card-edge-entry.ts), or the empty canvas's buttons (fillEmptyMap, V3.3 A7).
 */
export type CardSurface = "toolbar" | "more" | "context" | "command" | "key" | "edge" | "canvas";
/** What an action acts on: an ordinary card, an AI card, a topic selection, the map itself, or one canvas image (P5.3). */
export type CardScope = "card" | "ai-card" | "multi" | "map" | "image";
/** An unavailable action's reason; `reasonArgs` fill its {0}, {1}… (the locked cards of a selection, P1.9). */
export type CardAvailability =
  { ok: true } | { ok: false; reasonKey: TranslationKey; reasonArgs?: readonly (string | number)[] };

/** The six plain reasons an action cannot run now (more specific ones come from the selection, such as mergeCheck's). */
export const CARD_ACTION_REASONS = {
  readOnly: "ui.card_action_off_notes_loading",
  merging: "ui.card_action_off_merging",
  aiLock: "ui.card_action_off_ai_lock",
  bookLock: "ui.card_action_off_book_lock",
  presentation: "ui.card_action_off_presentation",
  multiSelect: "ui.card_action_off_multi_select"
} as const satisfies Record<string, TranslationKey>;

/** The view methods an action runs through (VisualAgentMapView.cardActionContext supplies them). */
export interface CardActionHost {
  stopRunAll(): void;
  addTopic(): void;
  addChild(node: MapNode): void;
  /** The edge entry's add: one topic per click (addTopicFromEdge's pending flag). */
  addTopicFromEdge(node: MapNode): void;
  /** The AI card setup (openAiCardPopover) for a new AI card under `parent`, or a root when null; saving makes the card. */
  setupAiCard(parent: MapNode | null): void;
  addSibling(node: MapNode): void;
  research(node: MapNode, opener?: HTMLElement): void;
  /** The Style popover (style-popover.ts) under the card's toolbar Style button (`opener`). */
  openStyle(node: MapNode, opener?: HTMLElement): void;
  /** Stops every AI run on the card (stopAiOn), as its header Stop does. */
  stopAi(node: MapNode): void;
  rename(node: MapNode): void;
  openNote(node: MapNode, newTab: boolean): void;
  addSummaryField(node: MapNode): void;
  cardSettings(node: MapNode): void;
  runCard(node: MapNode): void;
  editAiCard(node: MapNode): void;
  selectSubtopics(node: MapNode): void;
  addSummary(ids: readonly string[]): void;
  /** Tidy this branch (V3.3 A10): the preview of the card's branch laid out again (openTidyPreview). */
  tidyBranch(node: MapNode): void;
  noteStyle(node: MapNode): void;
  fillAddMenu(menu: Menu, node: MapNode): void;
  fillBookMenu(menu: Menu, node: MapNode): void;
  /** `byKey`: the command's and Space's route, which keeps focus on the card (collapseByKey). */
  toggleCollapse(node: MapNode, byKey: boolean): void;
  reorderSibling(node: MapNode, offset: -1 | 1): void;
  remove(node: MapNode): void;
  /** B13: shows the card's branch alone (enterBranchFocus); leaves it (exitBranchFocus). */
  enterBranchFocus(node: MapNode): void;
  exitBranchFocus(): void;
  /** Copy as reference (copyAsKnowledgeRef) / Paste reference under the card (pasteKnowledgeRef). */
  copyKnowledgeRef(node: MapNode): void;
  pasteKnowledgeRef(node: MapNode): void;
  /** Impact analysis (F09): the card's direct and guessed impact, shown read-only in the map chat window. */
  impactAnalysis(node: MapNode): void;
  zoomFit(): void;
  zoomReset(): void;
  search(): void;
  shortcuts(): void;
  /** The selection's Color popover (batch-popover.ts) above its button (`opener`) in the selection bar. */
  openBatchColor(opener?: HTMLElement): void;
  /** The selection's Size popover (batch-popover.ts) above its button (`opener`) in the selection bar. */
  openBatchSize(opener?: HTMLElement): void;
  merge(): void;
  multiResearch(): void;
  chooseParent(copy: boolean): void;
  synthesize(): void;
  addFrame(): void;
  setAiLock(nodes: readonly MapNode[], locked: boolean): void;
  clearSelection(): void;
  removeSelected(): void;
  selectionHelp(): void;
  finishSelection(): void;
  /** P5.3 Image exploration (exploreImage): an annotated image goes to the map chat; a plain one is converted first, if the user agrees. */
  exploreImage(id: string): void;
}

/** What an action reads about the moment: plain state plus a few cheap lookups (VisualAgentMapView.cardActionContext). */
export interface CardActionContext {
  /** Set by `actionsFor`: the entry asking. */
  surface?: CardSurface;
  /** The one card acted on; null for a selection or the map. */
  node: MapNode | null;
  /** The canvas image acted on (its right-click menu, openImageMenu); a card, selection or map context has none. */
  image?: { id: string; annotated: boolean } | null;
  /** The cards acted on: the card, or the selection (or the right-clicked cards). */
  ids: readonly string[];
  nodes: readonly MapNode[];
  presentation: boolean;
  /** The notes are still being read: the view writes nothing (whenEditing, canEditSummary). */
  readOnly: boolean;
  /** Topic selection mode. */
  multiSelect: boolean;
  bookLock: { ai: boolean; structure: boolean };
  hasViewport: boolean;
  /** The map is a managed map (isManagedMapPath): the edge entries are drawn only there. */
  managedMap: boolean;
  /** The empty canvas offers its buttons: the map has no topics and the map chat is not building, planning or asking. */
  emptyCanvas: boolean;
  /** One branch is shown alone (B13's branch focus). */
  branchFocused: boolean;
  /** This map's references may change here (canEditKnowledgeRefs) and the card is not merging; a card was copied as a reference. */
  knowledgeRefs: { editable: boolean; copied: boolean };
  note(id: string): PromptNoteRef | undefined;
  isMerging(id: string): boolean;
  /** The cards' titles as one list, joined with the language's list separator. */
  titles(ids: readonly string[]): string;
  isArgumentCard(id: string): boolean;
  /** Add summary (an empty summary the card face does not draw). */
  summaryFieldOffered(): boolean;
  /** The card's colour and styles may change here (markersEditable: not an AIM map). */
  stylesEditable: boolean;
  /** The map is an old AIM map (map.aim): its cards keep no custom size. */
  aimMap: boolean;
  /** The AI works on this card now (aiStatusOf "running": a batch, a single run, research, a merge…). */
  aiRunning(id: string): boolean;
  /** The card is a chapter of this map's picture book (addBookMenu has rows). */
  bookMenu(): boolean;
  /** Why the selection cannot be merged (mergeCheck), or null. */
  mergeBlock(): TranslationKey | null;
  multiResearchRunning(): boolean;
  /** Run all is working on this card now (the batch runs and its entry for the card is running). */
  runAllWorking(id: string): boolean;
  host: CardActionHost;
}
/** What one click adds to the context: the button (focus returns to it), Cmd/Ctrl, the menu to fill, the Alt+arrow direction. */
export interface CardActionRunOptions {
  opener?: HTMLElement;
  newTab?: boolean;
  menu?: Menu;
  offset?: -1 | 1;
}

export interface CardAction {
  id: CardActionId;
  titleKey: TranslationKey;
  /** The entries that name the action their own way today (the toolbar's short names). */
  titles?: Partial<Record<CardSurface, TranslationKey>>;
  /** An aria-label that says more than the visible name (the edge entry's). */
  ariaLabelKey?: TranslationKey;
  /** A name that follows the card (Expand / Collapse, Edit / Make it an AI card, …). */
  titleFor?(ctx: CardActionContext): TranslationKey;
  icon: string;
  iconFor?(ctx: CardActionContext): string;
  /** The `action` of its MAP_KEYBOARD_SHORTCUTS row: the key hint is read from there. */
  shortcut?: TranslationKey;
  scope: readonly CardScope[];
  surfaces: readonly CardSurface[];
  /** Position in CARD_ACTIONS; spaced by ten so an action can go in between (B13's focus on this branch). */
  order: number;
  /** A menu separator falls between two actions of different groups. */
  group: number;
  warning?: boolean;
  /** Whether the action belongs to this card at all (it has subtopics, it is an AI card…); one that does not is not offered. */
  applies?(ctx: CardActionContext): boolean;
  available(ctx: CardActionContext): CardAvailability;
  run(ctx: CardActionContext, options?: CardActionRunOptions): void;
}

const OK: CardAvailability = { ok: true };
const off = (reasonKey: TranslationKey): CardAvailability => ({ ok: false, reasonKey });
type Gate = "presentation" | "readOnly" | "multiSelect" | "bookAi" | "bookStructure";
/** The gates in the order their reason is given. */
function gate(ctx: CardActionContext, gates: readonly Gate[]): CardAvailability {
  if (gates.includes("presentation") && ctx.presentation) return off(CARD_ACTION_REASONS.presentation);
  if (gates.includes("readOnly") && ctx.readOnly) return off(CARD_ACTION_REASONS.readOnly);
  if (gates.includes("multiSelect") && ctx.multiSelect) return off(CARD_ACTION_REASONS.multiSelect);
  if (gates.includes("bookAi") && ctx.bookLock.ai) return off(CARD_ACTION_REASONS.bookLock);
  if (gates.includes("bookStructure") && ctx.bookLock.structure) return off(CARD_ACTION_REASONS.bookLock);
  return OK;
}
/**
 * The card entries (toolbar, ⋯, right-click, keys, palette): whenEditing refuses presentation and loading; selection mode has
 * none of them. The gates that keep data safe (loading, the picture-book locks, the AI lock) hold on every entry, the palette
 * included (decision #35): the surface only decides what is shown.
 */
const CARD: readonly Gate[] = ["presentation", "readOnly", "multiSelect"];
const then = (first: CardAvailability, next: () => CardAvailability): CardAvailability => (first.ok ? next() : first);
const merging = (ctx: CardActionContext, ids: Iterable<string | null>): CardAvailability => {
  for (const id of ids) if (id && ctx.isMerging(id)) return off(CARD_ACTION_REASONS.merging);
  return OK;
};
/**
 * P1.9: a selection holding an AI-locked or merging card refuses its batch actions (colour, size, position, merge) as a
 * whole, and the reason names those cards.
 */
const selectionLock = (ctx: CardActionContext): CardAvailability => {
  const locked = ctx.ids.filter(id => ctx.note(id)?.aiLocked === true || ctx.isMerging(id));
  if (!locked.length) return OK;
  // English needs its singular for one card.
  return locked.length === 1
    ? { ok: false, reasonKey: "ui.selection_locked_one_0", reasonArgs: [ctx.titles(locked)] }
    : { ok: false, reasonKey: "ui.selection_locked_0_1", reasonArgs: [locked.length, ctx.titles(locked)] };
};
const branch = (ctx: CardActionContext, id: string): string[] => {
  const out = [id];
  for (let at = 0; at < out.length; at++)
    for (const item of ctx.nodes) if (item.parentId === out[at] && !out.includes(item.id)) out.push(item.id);
  return out;
};
const hasChildren = (ctx: CardActionContext): boolean =>
  !!ctx.node && ctx.nodes.some(item => item.parentId === ctx.node!.id);
const selectionBranches = (ctx: CardActionContext): string[] => ctx.ids.flatMap(id => branch(ctx, id));
const card = (ctx: CardActionContext): MapNode => ctx.node!;
/** The selection's topics that take an AI lock (no argument card, a read note), and whether all of them have it. */
function lockState(ctx: CardActionContext): { nodes: MapNode[]; all: boolean } {
  const nodes = ctx.ids
    .map(id => ctx.nodes.find(node => node.id === id))
    .filter((node): node is MapNode => !!node && !ctx.isArgumentCard(node.id) && !!ctx.note(node.id));
  return { nodes, all: nodes.length > 0 && nodes.every(node => ctx.note(node.id)?.aiLocked === true) };
}

export const CARD_ACTIONS: readonly CardAction[] = [
  {
    id: "stop-run-all",
    titleKey: "ui.card_tool_stop",
    icon: "square",
    scope: ["ai-card"],
    surfaces: ["toolbar"],
    order: 5,
    group: 1,
    // paintPromptState (V3.3 A5): first in the AI card's toolbar while Run all works on it; not while picking topics or
    // presenting. A plain button (no whenEditing), so loading and the locks do not stop it. The right-click never has it.
    applies: ctx => !!ctx.node && ctx.runAllWorking(ctx.node.id),
    available: ctx => gate(ctx, ["presentation", "multiSelect"]),
    run: ctx => ctx.host.stopRunAll()
  },
  {
    id: "run-stop",
    titleKey: "ui.card_tool_run",
    titleFor: ctx => (ctx.node && ctx.aiRunning(ctx.node.id) ? "ui.card_tool_stop" : "ui.card_tool_run"),
    icon: "play",
    iconFor: ctx => (ctx.node && ctx.aiRunning(ctx.node.id) ? "square" : "play"),
    scope: ["ai-card"],
    surfaces: ["toolbar"],
    order: 6,
    group: 1,
    // B08: the AI card's first button, Run (startPromptRun, as Run card) or, while the AI works on the card, Stop. Run all's
    // Stop (above) takes the place while the batch works on it. Stop is a plain button like Run all's: no whenEditing.
    applies: ctx => !!ctx.node && !ctx.runAllWorking(ctx.node.id),
    available: ctx =>
      ctx.aiRunning(card(ctx).id)
        ? gate(ctx, ["presentation", "multiSelect"])
        : then(gate(ctx, [...CARD, "bookAi"]), () =>
            ctx.note(card(ctx).id)?.aiLocked ? off(CARD_ACTION_REASONS.aiLock) : OK
          ),
    run: ctx => (ctx.aiRunning(card(ctx).id) ? ctx.host.stopAi(card(ctx)) : ctx.host.runCard(card(ctx)))
  },
  {
    id: "ai-lock",
    titleKey: "ui.card_tool_lock",
    titleFor: ctx => (ctx.node && ctx.note(ctx.node.id)?.aiLocked ? "ui.card_tool_locked" : "ui.card_tool_lock"),
    icon: "lock",
    scope: ["ai-card"],
    surfaces: ["toolbar"],
    order: 7,
    group: 1,
    // B08: a toggle (aria-pressed); locking first stops the AI on the card (setAiLock). An argument card is the flow's.
    applies: ctx => !!ctx.node && !ctx.isArgumentCard(ctx.node.id) && !!ctx.note(ctx.node.id),
    available: ctx => gate(ctx, CARD),
    run: ctx => ctx.host.setAiLock([card(ctx)], ctx.note(card(ctx).id)?.aiLocked !== true)
  },
  {
    id: "ai-settings",
    titleKey: "ui.card_tool_ai_settings",
    icon: "settings",
    scope: ["ai-card"],
    surfaces: ["toolbar"],
    order: 8,
    group: 1,
    // B08: the AI card setup (openAiCardPopover), as Edit AI card; an AI-locked card says so there.
    available: ctx => gate(ctx, [...CARD, "bookAi"]),
    run: ctx => ctx.host.editAiCard(card(ctx))
  },
  {
    id: "add-topic",
    titleKey: "ui.command_map_add_topic",
    icon: "plus",
    scope: ["map"],
    surfaces: ["command"],
    order: 10,
    group: 1,
    available: ctx => gate(ctx, [...CARD, "bookStructure"]),
    run: ctx => ctx.host.addTopic()
  },
  {
    id: "ai-root",
    titleKey: "ui.empty_add_ai_root",
    ariaLabelKey: "ui.empty_add_ai_root_label",
    icon: "sparkles",
    scope: ["map"],
    surfaces: ["canvas"],
    order: 15,
    group: 1,
    // fillEmptyMap (V3.3 A7): beside "Add first topic" on a managed map; drawn while cardTextEditable and no AI lock, clicked
    // through whenEditing.
    applies: ctx => ctx.emptyCanvas && ctx.managedMap,
    available: ctx => gate(ctx, [...CARD, "bookAi"]),
    run: ctx => ctx.host.setupAiCard(null)
  },
  {
    id: "edge-add-topic",
    titleKey: "ui.card_edge_add",
    ariaLabelKey: "ui.card_edge_add_label",
    icon: "plus",
    scope: ["card", "ai-card"],
    surfaces: ["edge"],
    order: 20,
    group: 1,
    // paintCardEdgeEntries: a card with a note on a managed map; drawn while cardTextEditable and no structure lock, clicked through whenEditing.
    applies: ctx => !!ctx.node && !!ctx.note(ctx.node.id) && ctx.managedMap,
    available: ctx => gate(ctx, [...CARD, "bookStructure"]),
    run: ctx => ctx.host.addTopicFromEdge(card(ctx))
  },
  {
    id: "edge-ai-card",
    titleKey: "ui.card_edge_ai",
    ariaLabelKey: "ui.card_edge_ai_label",
    icon: "sparkles",
    scope: ["card", "ai-card"],
    surfaces: ["edge"],
    order: 25,
    group: 1,
    // paintCardEdgeEntries (V3.3 A7): after "+ Topic card" under the same gates, and not under the picture-book AI lock.
    applies: ctx => !!ctx.node && !!ctx.note(ctx.node.id) && ctx.managedMap,
    available: ctx => gate(ctx, [...CARD, "bookAi", "bookStructure"]),
    run: ctx => ctx.host.setupAiCard(card(ctx))
  },
  {
    id: "research",
    titleKey: "ui.ai_explore",
    icon: "sparkles",
    scope: ["card", "ai-card"],
    surfaces: ["toolbar", "context", "command"],
    order: 30,
    group: 2,
    // openTopicChat refuses an AI-locked card with a notice; the menus say so up front.
    available: ctx =>
      then(gate(ctx, [...CARD, "bookAi"]), () =>
        ctx.note(card(ctx).id)?.aiLocked ? off(CARD_ACTION_REASONS.aiLock) : OK
      ),
    run: (ctx, options) => ctx.host.research(card(ctx), options?.opener)
  },
  {
    id: "style",
    titleKey: "ui.card_menu_style",
    titles: { toolbar: "ui.topic_style" },
    icon: "paintbrush",
    scope: ["card", "ai-card"],
    surfaces: ["toolbar", "context"],
    order: 35,
    group: 2,
    // B08: the toolbar's Style (an AI card has it in its ⋯); each choice in the popover goes through whenEditing and
    // mergeUnlocked. A colour or style is neither card AI nor structure (decision #62), so the picture-book locks keep it.
    applies: ctx => !!ctx.node && !!ctx.note(ctx.node.id) && ctx.stylesEditable,
    available: ctx => gate(ctx, CARD),
    run: (ctx, options) => ctx.host.openStyle(card(ctx), options?.opener)
  },
  {
    id: "open-note",
    titleKey: "ui.card_menu_open_note",
    titles: { toolbar: "ui.card_tool_note" },
    icon: "file-text",
    scope: ["card", "ai-card"],
    surfaces: ["toolbar", "context", "command"],
    order: 40,
    group: 2,
    // The command opens the details whenever a card is selected, presenting or picking topics included. The toolbar's Note
    // only reads, so it works while loading and presenting (V3.3 A5); the toolbar is not drawn while picking topics.
    // B05: while the notes load the toolbar hides every other button; ⋯ still opens, its rows greyed with the reason.
    available: ctx =>
      ctx.surface === "command" ? OK : ctx.surface === "toolbar" ? gate(ctx, ["multiSelect"]) : gate(ctx, CARD),
    run: (ctx, options) => ctx.host.openNote(card(ctx), options?.newTab ?? false)
  },
  {
    id: "rename",
    titleKey: "ui.shortcut_rename",
    icon: "pencil",
    shortcut: "ui.shortcut_rename",
    scope: ["card", "ai-card"],
    surfaces: ["command", "key"],
    order: 50,
    group: 2,
    applies: ctx => !!ctx.node && !!ctx.note(ctx.node.id),
    available: ctx => gate(ctx, CARD),
    run: ctx => ctx.host.rename(card(ctx))
  },
  {
    id: "card-settings",
    titleKey: "ui.card_settings_menu",
    icon: "settings-2",
    scope: ["card", "ai-card"],
    surfaces: ["more", "context"],
    order: 60,
    group: 3,
    available: ctx => gate(ctx, [...CARD, "bookStructure"]),
    run: ctx => ctx.host.cardSettings(card(ctx))
  },
  {
    id: "focus-branch",
    titleKey: "ui.focus_branch",
    icon: "focus",
    scope: ["card", "ai-card"],
    surfaces: ["more", "context", "command"],
    order: 65,
    group: 3,
    // A card with subtopics; while one branch is focused the map's "Leave focus" is offered instead. enterBranchFocus refuses
    // while presenting; selection mode has no card entries.
    applies: ctx => hasChildren(ctx) && !ctx.branchFocused,
    available: ctx => gate(ctx, CARD),
    run: ctx => ctx.host.enterBranchFocus(card(ctx))
  },
  {
    id: "leave-focus",
    titleKey: "ui.exit_branch_focus",
    icon: "minimize-2",
    scope: ["map"],
    surfaces: ["command"],
    order: 66,
    group: 3,
    applies: ctx => ctx.branchFocused,
    available: () => OK,
    run: ctx => ctx.host.exitBranchFocus()
  },
  {
    id: "add-summary-field",
    titleKey: "ui.card_tool_add_summary",
    icon: "text",
    scope: ["card", "ai-card"],
    // B08: out of the toolbar, into the ⋯ and the right-click menu (mockup §4).
    surfaces: ["more", "context"],
    order: 70,
    group: 3,
    applies: ctx => ctx.summaryFieldOffered(),
    available: ctx => gate(ctx, CARD),
    run: ctx => ctx.host.addSummaryField(card(ctx))
  },
  {
    id: "select-subtopics",
    titleKey: "ui.select_subtopics",
    icon: "list-checks",
    scope: ["card", "ai-card"],
    surfaces: ["more"],
    order: 80,
    group: 3,
    applies: ctx => hasChildren(ctx) && !ctx.node!.collapsed,
    available: ctx => gate(ctx, [...CARD, "bookStructure"]),
    run: ctx => ctx.host.selectSubtopics(card(ctx))
  },
  {
    id: "summary-add",
    titleKey: "ui.summary_add",
    icon: "brackets",
    scope: ["card", "ai-card"],
    surfaces: ["more"],
    order: 90,
    group: 3,
    available: ctx => gate(ctx, CARD),
    run: ctx => ctx.host.addSummary([card(ctx).id])
  },
  {
    id: "tidy-branch",
    titleKey: "ui.tidy_branch",
    icon: "workflow",
    scope: ["card", "ai-card"],
    surfaces: ["more"],
    order: 95,
    group: 3,
    applies: hasChildren,
    available: ctx => gate(ctx, CARD),
    run: ctx => ctx.host.tidyBranch(card(ctx))
  },
  {
    id: "note-style",
    titleKey: "ui.note_style_menu",
    icon: "palette",
    scope: ["card", "ai-card", "multi"],
    surfaces: ["more", "context"],
    order: 100,
    group: 3,
    // A card has it in its ⋯ and right-click; a selection only in the right-click menu, and only for one topic.
    applies: ctx => !!ctx.node || (ctx.surface === "context" && ctx.ids.length === 1),
    available: ctx => gate(ctx, ctx.node ? CARD : ["presentation", "readOnly"]),
    run: ctx => {
      const node = ctx.node ?? ctx.nodes.find(item => item.id === ctx.ids[0]);
      if (node) ctx.host.noteStyle(node);
    }
  },
  {
    id: "run-card",
    titleKey: "ui.living_node_run_card",
    icon: "play",
    scope: ["ai-card"],
    surfaces: ["more", "context"],
    order: 110,
    group: 3,
    available: ctx =>
      then(gate(ctx, [...CARD, "bookAi"]), () =>
        ctx.note(card(ctx).id)?.aiLocked ? off(CARD_ACTION_REASONS.aiLock) : OK
      ),
    run: ctx => ctx.host.runCard(card(ctx))
  },
  {
    id: "ai-card",
    titleKey: "ui.ai_card_set",
    titleFor: ctx => (ctx.node && isAiCard(ctx.note(ctx.node.id)) ? "ui.ai_card_edit" : "ui.ai_card_set"),
    icon: "star",
    scope: ["card", "ai-card"],
    surfaces: ["more", "context"],
    order: 120,
    group: 3,
    // An ordinary note card (no argument card); the picture-book lock is the gate below.
    applies: ctx => !!ctx.node && !ctx.isArgumentCard(ctx.node.id) && !!ctx.note(ctx.node.id),
    available: ctx => gate(ctx, [...CARD, "bookAi"]),
    run: ctx => ctx.host.editAiCard(card(ctx))
  },
  {
    id: "book",
    titleKey: "ui.book_card_menu",
    icon: "book-open",
    scope: ["card", "ai-card"],
    surfaces: ["context"],
    order: 130,
    group: 3,
    applies: ctx => ctx.bookMenu(),
    available: ctx => gate(ctx, CARD),
    run: (ctx, options) => {
      if (options?.menu) ctx.host.fillBookMenu(options.menu, card(ctx));
    }
  },
  {
    id: "add-child",
    titleKey: "ui.card_menu_add_child",
    icon: "plus",
    shortcut: "ui.shortcut_add_subtopic",
    scope: ["card", "ai-card"],
    // B08: off the toolbar (the edge "+ Topic card" and Cmd+Enter replace it); kept in the ⋯ and the right-click menu.
    surfaces: ["more", "context", "command", "key"],
    order: 140,
    group: 4,
    available: ctx => gate(ctx, [...CARD, "bookStructure"]),
    run: ctx => ctx.host.addChild(card(ctx))
  },
  {
    id: "add-sibling",
    titleKey: "ui.card_menu_add_sibling",
    icon: "list-plus",
    shortcut: "ui.shortcut_add_sibling",
    scope: ["card", "ai-card"],
    surfaces: ["context", "command", "key"],
    order: 150,
    group: 4,
    available: ctx => gate(ctx, [...CARD, "bookStructure"]),
    run: ctx => ctx.host.addSibling(card(ctx))
  },
  {
    id: "add-other",
    titleKey: "ui.card_tool_add_other",
    icon: "plus",
    scope: ["card", "ai-card"],
    surfaces: ["more"],
    order: 160,
    group: 4,
    available: ctx => gate(ctx, [...CARD, "bookStructure"]),
    run: (ctx, options) => {
      if (options?.menu) ctx.host.fillAddMenu(options.menu, card(ctx));
    }
  },
  {
    id: "knowledge-ref-copy",
    titleKey: "ui.knowledge_ref_copy",
    icon: "link",
    scope: ["card", "ai-card"],
    surfaces: ["context"],
    order: 163,
    group: 4,
    // Only where the map's references may change (not AIM, not picking, not loading) and not on a merging card.
    applies: ctx => ctx.knowledgeRefs.editable,
    available: ctx => gate(ctx, CARD),
    run: ctx => ctx.host.copyKnowledgeRef(card(ctx))
  },
  {
    id: "knowledge-ref-paste",
    titleKey: "ui.knowledge_ref_paste",
    icon: "clipboard-paste",
    scope: ["card", "ai-card"],
    surfaces: ["context"],
    order: 166,
    group: 4,
    applies: ctx => ctx.knowledgeRefs.editable && ctx.knowledgeRefs.copied,
    available: ctx => gate(ctx, CARD),
    run: ctx => ctx.host.pasteKnowledgeRef(card(ctx))
  },
  {
    id: "impact",
    titleKey: "ui.card_menu_impact",
    icon: "git-fork",
    scope: ["card", "ai-card"],
    surfaces: ["context"],
    order: 168,
    group: 4,
    // Read only (it writes nothing): it works while merging or on an AIM map, but like every row it is greyed while the notes load (decision #35).
    available: ctx => gate(ctx, ["readOnly"]),
    run: ctx => ctx.host.impactAnalysis(card(ctx))
  },
  {
    id: "toggle-collapse",
    titleKey: "ui.card_menu_collapse",
    titleFor: ctx => (ctx.node?.collapsed ? "ui.card_menu_expand" : "ui.card_menu_collapse"),
    icon: "chevrons-down-up",
    iconFor: ctx => (ctx.node?.collapsed ? "chevrons-up-down" : "chevrons-down-up"),
    shortcut: "ui.shortcut_toggle_collapse",
    scope: ["card", "ai-card"],
    surfaces: ["context", "command", "key"],
    order: 170,
    group: 5,
    applies: hasChildren,
    available: ctx => gate(ctx, CARD),
    run: ctx => ctx.host.toggleCollapse(card(ctx), ctx.surface !== "context")
  },
  {
    id: "remove",
    titleKey: "ui.remove_from_map",
    icon: "trash-2",
    shortcut: "ui.shortcut_remove",
    scope: ["card", "ai-card"],
    surfaces: ["context", "key"],
    order: 180,
    group: 5,
    warning: true,
    // removeByKey: a leaf refuses itself merging, a card with subtopics its whole branch (confirmRemoveNode).
    available: ctx =>
      then(gate(ctx, [...CARD, "bookStructure"]), () =>
        merging(ctx, hasChildren(ctx) ? branch(ctx, card(ctx).id) : [card(ctx).id])
      ),
    run: ctx => ctx.host.remove(card(ctx))
  },
  {
    id: "reorder-sibling",
    titleKey: "ui.shortcut_reorder_sibling",
    icon: "arrow-up-down",
    shortcut: "ui.shortcut_reorder_sibling",
    scope: ["card", "ai-card"],
    surfaces: ["key"],
    order: 190,
    group: 5,
    applies: ctx => !!ctx.node?.parentId,
    available: ctx => then(gate(ctx, CARD), () => merging(ctx, [card(ctx).id, card(ctx).parentId])),
    run: (ctx, options) => ctx.host.reorderSibling(card(ctx), options?.offset ?? 1)
  },
  {
    id: "zoom-fit",
    titleKey: "ui.command_map_zoom_fit",
    icon: "maximize",
    scope: ["map"],
    surfaces: ["command"],
    order: 200,
    group: 6,
    applies: ctx => ctx.hasViewport,
    available: () => OK,
    run: ctx => ctx.host.zoomFit()
  },
  {
    id: "zoom-reset",
    titleKey: "ui.command_map_zoom_reset",
    icon: "scan",
    scope: ["map"],
    surfaces: ["command"],
    order: 210,
    group: 6,
    applies: ctx => ctx.hasViewport,
    available: () => OK,
    run: ctx => ctx.host.zoomReset()
  },
  {
    id: "search",
    titleKey: "ui.command_map_search",
    icon: "search",
    shortcut: "ui.shortcut_search_map",
    scope: ["map"],
    surfaces: ["command", "key"],
    order: 220,
    group: 6,
    // Mod+F also refuses while the notes load (searchKey); the command only while presenting.
    available: ctx => gate(ctx, ctx.surface === "key" ? ["presentation", "readOnly"] : ["presentation"]),
    run: ctx => ctx.host.search()
  },
  {
    id: "shortcuts",
    titleKey: "ui.command_map_shortcuts",
    icon: "keyboard",
    scope: ["map"],
    surfaces: ["command"],
    order: 230,
    group: 6,
    available: () => OK,
    run: ctx => ctx.host.shortcuts()
  },
  // The topic selection (renderSelectionBar, openSelectionMoreMenu, and the right-click on a selection). The bar reads
  // neither presentation nor notesLoading; the picture-book lock takes the AI actions, and the structure ones.
  {
    // P1.9 (B19b): one colour for the whole selection, one write and one undo step (changeSelectionColor rechecks these). A
    // colour changes neither parent nor order, so the picture-book locks (card AI, structure) leave it on.
    id: "batch-color",
    titleKey: "ui.batch_color",
    icon: "palette",
    scope: ["multi"],
    surfaces: ["toolbar"],
    order: 295,
    group: 1,
    available: ctx => then(gate(ctx, ["presentation", "readOnly"]), () => selectionLock(ctx)),
    run: (ctx, options) => ctx.host.openBatchColor(options?.opener)
  },
  {
    // P1.9 (B19c): one width and/or height for the whole selection, one Map.md write and one undo step (changeSelectionSize
    // rechecks these). A size changes neither parent, order nor any other card's place, so the picture-book locks leave it on;
    // an old AIM map has no card size.
    id: "batch-size",
    titleKey: "ui.batch_size",
    icon: "scaling",
    scope: ["multi"],
    surfaces: ["toolbar"],
    order: 296,
    group: 1,
    applies: ctx => !ctx.aimMap,
    available: ctx => then(gate(ctx, ["presentation", "readOnly"]), () => selectionLock(ctx)),
    run: (ctx, options) => ctx.host.openBatchSize(options?.opener)
  },
  {
    id: "merge",
    titleKey: "ui.merge",
    icon: "combine",
    scope: ["multi"],
    surfaces: ["toolbar"],
    order: 300,
    group: 1,
    available: ctx =>
      then(gate(ctx, ["bookAi"]), () =>
        then(selectionLock(ctx), () => {
          const reason = ctx.mergeBlock();
          return reason ? off(reason) : OK;
        })
      ),
    run: ctx => ctx.host.merge()
  },
  {
    id: "multi-research",
    titleKey: "ui.multi_research",
    icon: "sparkles",
    scope: ["multi"],
    surfaces: ["toolbar"],
    order: 310,
    group: 1,
    available: ctx =>
      then(gate(ctx, ["bookAi"]), () => (ctx.multiResearchRunning() ? off("ui.multi_research_already_running") : OK)),
    run: ctx => ctx.host.multiResearch()
  },
  {
    id: "move-to",
    titleKey: "ui.move_to",
    icon: "folder-input",
    scope: ["multi"],
    surfaces: ["toolbar"],
    order: 320,
    group: 1,
    available: ctx =>
      then(gate(ctx, ["bookStructure"]), () => then(selectionLock(ctx), () => merging(ctx, selectionBranches(ctx)))),
    run: ctx => ctx.host.chooseParent(false)
  },
  {
    id: "synthesize",
    titleKey: "ui.synthesize",
    titleFor: ctx => (ctx.ids.length > 1 ? "ui.synthesize_0_topics" : "ui.synthesize"),
    icon: "git-merge",
    scope: ["multi"],
    surfaces: ["more"],
    order: 330,
    group: 1,
    available: ctx =>
      then(gate(ctx, ["bookAi"]), () => (ctx.ids.length < 2 ? off("ui.select_at_least_two_topics") : OK)),
    run: ctx => ctx.host.synthesize()
  },
  {
    id: "copy-to",
    titleKey: "ui.copy_to",
    icon: "copy",
    scope: ["multi"],
    surfaces: ["more"],
    order: 340,
    group: 1,
    available: ctx => then(gate(ctx, ["bookStructure"]), () => merging(ctx, selectionBranches(ctx))),
    run: ctx => ctx.host.chooseParent(true)
  },
  {
    id: "add-frame",
    titleKey: "ui.canvas_boundary_add",
    icon: "square-dashed",
    scope: ["multi"],
    surfaces: ["more"],
    order: 350,
    group: 1,
    available: () => OK,
    run: ctx => ctx.host.addFrame()
  },
  {
    id: "summary-add-selected",
    titleKey: "ui.summary_add",
    icon: "brackets",
    scope: ["multi"],
    surfaces: ["more", "context"],
    order: 360,
    group: 1,
    // The right-click menu opens only where canEditSummary holds; the selection ⋯ has no such check.
    available: ctx => (ctx.surface === "context" ? gate(ctx, ["presentation", "readOnly"]) : OK),
    run: ctx => ctx.host.addSummary(ctx.ids)
  },
  {
    id: "ai-lock-selected",
    titleKey: "ui.ai_lock_toggle",
    titleFor: ctx => (lockState(ctx).all ? "ui.ai_unlock_selected" : "ui.ai_lock_toggle"),
    icon: "lock",
    iconFor: ctx => (lockState(ctx).all ? "unlock" : "lock"),
    scope: ["multi"],
    surfaces: ["more"],
    order: 370,
    group: 1,
    // A selection with no lockable topic shows this row disabled, with the reason (B09).
    available: ctx => (lockState(ctx).nodes.length ? OK : off("ui.card_action_off_no_lockable")),
    run: ctx => {
      const { nodes, all } = lockState(ctx);
      ctx.host.setAiLock(nodes, !all);
    }
  },
  {
    id: "clear-selection",
    titleKey: "ui.clear",
    icon: "x",
    scope: ["multi"],
    surfaces: ["more"],
    order: 380,
    group: 2,
    available: () => OK,
    run: ctx => ctx.host.clearSelection()
  },
  {
    id: "remove-selected",
    titleKey: "ui.remove",
    icon: "trash",
    scope: ["multi"],
    surfaces: ["more"],
    order: 390,
    group: 2,
    available: ctx => then(gate(ctx, ["bookStructure"]), () => merging(ctx, selectionBranches(ctx))),
    run: ctx => ctx.host.removeSelected()
  },
  {
    id: "selection-help",
    titleKey: "ui.selection_help_item",
    icon: "help-circle",
    scope: ["multi"],
    surfaces: ["more"],
    order: 400,
    group: 2,
    available: () => OK,
    run: ctx => ctx.host.selectionHelp()
  },
  {
    id: "finish-selection",
    titleKey: "ui.finish_topic_selection",
    icon: "check",
    scope: ["multi"],
    surfaces: ["toolbar"],
    order: 410,
    group: 2,
    available: () => OK,
    run: ctx => ctx.host.finishSelection()
  },
  {
    // P5.3: the image right-click's first row. A plain image asks first (the dialog's "…"); nothing goes to the AI unasked.
    id: "image-explore",
    titleKey: "ui.image_explore",
    titleFor: ctx => (ctx.image?.annotated ? "ui.image_explore" : "ui.image_explore_ask"),
    icon: "scan-search",
    scope: ["image"],
    surfaces: ["context"],
    order: 420,
    group: 3,
    available: ctx => gate(ctx, CARD),
    run: ctx => {
      if (ctx.image) ctx.host.exploreImage(ctx.image.id);
    }
  }
];

/**
 * The toolbar sets, in their order (B08, mockup §4): the card toolbar "AI explore | Style | Note", the AI card's "Run or Stop |
 * Lock | AI explore | Settings | Note" (Run all's Stop takes Run's place) and the selection bar. ⋯ follows on a card.
 */
export const CARD_TOOLBAR: Readonly<Record<"card" | "ai-card" | "multi", readonly CardActionId[]>> = {
  card: ["research", "style", "open-note"],
  "ai-card": ["stop-run-all", "run-stop", "ai-lock", "research", "ai-settings", "open-note"],
  multi: ["batch-color", "batch-size", "move-to", "merge", "multi-research", "finish-selection"]
};

/** The palette commands (main.ts registers them by these ids) and the mapCommand action each one runs today. */
export const CARD_COMMANDS: readonly { commandId: string; mapAction: MapCommandAction; action: CardActionId }[] = [
  { commandId: "map-add-topic", mapAction: "add-topic", action: "add-topic" },
  { commandId: "map-add-subtopic", mapAction: "add-subtopic", action: "add-child" },
  { commandId: "map-add-sibling", mapAction: "add-sibling", action: "add-sibling" },
  { commandId: "map-ai-explore-selected", mapAction: "ai-explore", action: "research" },
  { commandId: "map-rename-selected", mapAction: "rename", action: "rename" },
  { commandId: "map-open-selected-details", mapAction: "open-details", action: "open-note" },
  { commandId: "map-toggle-collapse-selected", mapAction: "toggle-collapse", action: "toggle-collapse" },
  { commandId: "map-focus-branch", mapAction: "focus-branch", action: "focus-branch" },
  { commandId: "map-zoom-to-fit", mapAction: "zoom-fit", action: "zoom-fit" },
  { commandId: "map-zoom-reset", mapAction: "zoom-reset", action: "zoom-reset" },
  { commandId: "map-search", mapAction: "search", action: "search" },
  { commandId: "map-keyboard-shortcuts", mapAction: "shortcuts", action: "shortcuts" }
];

/** What the context is about: one canvas image, one card (ordinary or AI), a selection, or the map. */
export function cardActionKind(ctx: CardActionContext): CardScope {
  if (ctx.image) return "image";
  if (ctx.node) return isAiCard(ctx.note(ctx.node.id)) ? "ai-card" : "card";
  return ctx.ids.length ? "multi" : "map";
}

/** The actions `surface` offers for `ctx`, in order, each with whether it can run now (an unavailable one keeps its reason). */
export function actionsFor(
  surface: CardSurface,
  context: CardActionContext
): { action: CardAction; availability: CardAvailability }[] {
  const ctx = { ...context, surface };
  const kind = cardActionKind(ctx);
  const toolbar = surface === "toolbar" && kind !== "map" && kind !== "image" ? CARD_TOOLBAR[kind] : null;
  // A card's ⋯ and right-click follow the rules below (B06, B07); everything else reads the action's own surfaces.
  const rule =
    kind === "card" || kind === "ai-card"
      ? surface === "more"
        ? ruleMoreSet(kind)
        : surface === "context"
          ? ruleContextSet(kind).filter((id): id is CardActionId => id !== "separator")
          : null
      : null;
  const offered = (
    rule
      ? rule.map(id => CARD_ACTIONS.find(action => action.id === id)!)
      : CARD_ACTIONS.filter(
          action =>
            action.surfaces.includes(surface) &&
            // An image's menu has its own actions only, not the map's.
            (action.scope.includes(kind) || (kind !== "image" && action.scope.includes("map"))) &&
            (!toolbar || toolbar.includes(action.id))
        )
  ).filter(action => action.applies?.(ctx) ?? true);
  if (toolbar) offered.sort((a, b) => toolbar.indexOf(a.id) - toolbar.indexOf(b.id));
  return offered.map(action => ({ action, availability: action.available(ctx) }));
}

export function titleKeyFor(action: CardAction, surface: CardSurface, ctx: CardActionContext): TranslationKey {
  return action.titles?.[surface] ?? action.titleFor?.({ ...ctx, surface }) ?? action.titleKey;
}

/** The palette name of an action (main.ts names the CARD_COMMANDS by it): the action list's name, as the card ⋯ and right-click show it. */
export function commandTitleKey(id: CardActionId): TranslationKey {
  return CARD_ACTIONS.find(item => item.id === id)!.titleKey;
}

/** The action's keys, from the same rows the Keyboard shortcuts dialog lists. */
export function shortcutKeysFor(action: CardAction): readonly string[] | undefined {
  return action.shortcut ? MAP_KEYBOARD_SHORTCUTS.find(row => row.action === action.shortcut)?.keys : undefined;
}

/** The card ⋯ (B06): the card's menu actions minus its toolbar set, in order. */
export function ruleMoreSet(kind: "card" | "ai-card"): CardActionId[] {
  return CARD_ACTIONS.filter(
    action =>
      action.scope.includes(kind) &&
      (action.surfaces.includes("more") || action.surfaces.includes("context")) &&
      !CARD_TOOLBAR[kind].includes(action.id)
  ).map(action => action.id);
}

/**
 * Toolbar actions the right-click menu never repeats: Run all's Stop belongs to the running card's toolbar only; the AI
 * card's Run, Lock and Settings are Run card, the card settings' AI lock and Edit AI card there.
 */
export const TOOLBAR_ONLY: readonly CardActionId[] = ["stop-run-all", "run-stop", "ai-lock", "ai-settings"];
/** The card right-click (B07): the toolbar set (minus TOOLBAR_ONLY), a separator, then the ⋯ set. */
export function ruleContextSet(kind: "card" | "ai-card"): (CardActionId | "separator")[] {
  return [...CARD_TOOLBAR[kind].filter(id => !TOOLBAR_ONLY.includes(id)), "separator", ...ruleMoreSet(kind)];
}
