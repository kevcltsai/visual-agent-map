import type { Menu } from "obsidian";
import type { TranslationKey } from "../../i18n";
import type { MapNode } from "../../map-model";
import { MAP_KEYBOARD_SHORTCUTS } from "../../ui/modals/keyboard-shortcuts-modal";
import { isAiCard, type PromptNoteRef } from "./prompt-run";

/**
 * The card actions (V3.3 P1.8): one list for the command palette, the card toolbar and its ⋯, the right-click menu, the
 * selection bar and the keys. Each action says where it is offered, whether it applies to a card at all, whether it can run
 * now (and why not), and runs through the view's own method. Names, gates and order are the entries' as they are today;
 * the entries move onto this list one by one (B05–B10).
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
  | "note-style"
  | "add-other"
  | "book"
  | "remove"
  | "reorder-sibling"
  | "zoom-fit"
  | "zoom-reset"
  | "search"
  | "shortcuts"
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
  | "finish-selection";
/**
 * Where an action is offered: the card toolbar or the selection bar, their ⋯ lists, the right-click menu, the command palette, a
 * key, the selected card's edge entries (V3.3 A6, card-edge-entry.ts), or the empty canvas's buttons (fillEmptyMap, V3.3 A7).
 */
export type CardSurface = "toolbar" | "more" | "context" | "command" | "key" | "edge" | "canvas";
/** What an action acts on: an ordinary card, an AI card, a topic selection, or the map itself. */
export type CardScope = "card" | "ai-card" | "multi" | "map";
export type CardAvailability = { ok: true } | { ok: false; reasonKey: TranslationKey };

/** The six plain reasons an action cannot run now (more specific ones come from the selection, such as mergeCheck's). */
export const CARD_ACTION_REASONS = {
  readOnly: "ui.card_action_off_read_only",
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
  rename(node: MapNode): void;
  openNote(node: MapNode, newTab: boolean): void;
  addSummaryField(node: MapNode): void;
  cardSettings(node: MapNode): void;
  runCard(node: MapNode): void;
  editAiCard(node: MapNode): void;
  selectSubtopics(node: MapNode): void;
  addSummary(ids: readonly string[]): void;
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
  zoomFit(): void;
  zoomReset(): void;
  search(): void;
  shortcuts(): void;
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
}

/** What an action reads about the moment: plain state plus a few cheap lookups (VisualAgentMapView.cardActionContext). */
export interface CardActionContext {
  /** Set by `actionsFor`: the entry asking. */
  surface?: CardSurface;
  /** The one card acted on; null for a selection or the map. */
  node: MapNode | null;
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
  note(id: string): PromptNoteRef | undefined;
  isMerging(id: string): boolean;
  isArgumentCard(id: string): boolean;
  /** The toolbar's Add summary (an empty summary the card face does not draw). */
  summaryFieldOffered(): boolean;
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
  /** The entries that name the action their own way today (the palette's command names among them). */
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
/** The card entries (toolbar, ⋯, right-click, keys): whenEditing refuses presentation and loading; selection mode has none of them. */
const CARD: readonly Gate[] = ["presentation", "readOnly", "multiSelect"];
/** mapCommand's `editable`: no presentation, no selection mode; it reads neither notesLoading nor bookLock. */
const COMMAND: readonly Gate[] = ["presentation", "multiSelect"];
const then = (first: CardAvailability, next: () => CardAvailability): CardAvailability => (first.ok ? next() : first);
const merging = (ctx: CardActionContext, ids: Iterable<string | null>): CardAvailability => {
  for (const id of ids) if (id && ctx.isMerging(id)) return off(CARD_ACTION_REASONS.merging);
  return OK;
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
    id: "add-topic",
    titleKey: "ui.command_map_add_topic",
    icon: "plus",
    scope: ["map"],
    surfaces: ["command"],
    order: 10,
    group: 1,
    available: ctx => gate(ctx, COMMAND),
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
    id: "add-child",
    titleKey: "ui.card_menu_add_child",
    titles: { toolbar: "ui.card_tool_add", command: "ui.command_map_add_subtopic" },
    icon: "plus",
    shortcut: "ui.shortcut_add_subtopic",
    scope: ["card", "ai-card"],
    surfaces: ["toolbar", "context", "command", "key"],
    order: 20,
    group: 1,
    available: ctx => gate(ctx, ctx.surface === "command" ? COMMAND : [...CARD, "bookStructure"]),
    run: ctx => ctx.host.addChild(card(ctx))
  },
  {
    id: "edge-add-topic",
    titleKey: "ui.card_edge_add",
    ariaLabelKey: "ui.card_edge_add_label",
    icon: "plus",
    scope: ["card", "ai-card"],
    surfaces: ["edge"],
    order: 25,
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
    order: 27,
    group: 1,
    // paintCardEdgeEntries (V3.3 A7): after "+ Topic card" under the same gates, and not under the picture-book AI lock.
    applies: ctx => !!ctx.node && !!ctx.note(ctx.node.id) && ctx.managedMap,
    available: ctx => gate(ctx, [...CARD, "bookAi", "bookStructure"]),
    run: ctx => ctx.host.setupAiCard(card(ctx))
  },
  {
    id: "add-sibling",
    titleKey: "ui.card_menu_add_sibling",
    titles: { command: "ui.command_map_add_sibling" },
    icon: "list-plus",
    shortcut: "ui.shortcut_add_sibling",
    scope: ["card", "ai-card"],
    surfaces: ["context", "command", "key"],
    order: 30,
    group: 1,
    available: ctx => gate(ctx, ctx.surface === "command" ? COMMAND : [...CARD, "bookStructure"]),
    run: ctx => ctx.host.addSibling(card(ctx))
  },
  {
    id: "research",
    titleKey: "ui.card_menu_research",
    titles: { toolbar: "ui.card_tool_research", command: "ui.command_map_ai_explore" },
    icon: "sparkles",
    scope: ["card", "ai-card"],
    surfaces: ["toolbar", "context", "command"],
    order: 40,
    group: 2,
    available: ctx => gate(ctx, ctx.surface === "command" ? COMMAND : [...CARD, "bookAi"]),
    run: (ctx, options) => ctx.host.research(card(ctx), options?.opener)
  },
  {
    id: "toggle-collapse",
    titleKey: "ui.card_menu_collapse",
    titles: { command: "ui.command_map_toggle_collapse" },
    titleFor: ctx => (ctx.node?.collapsed ? "ui.card_menu_expand" : "ui.card_menu_collapse"),
    icon: "chevrons-down-up",
    iconFor: ctx => (ctx.node?.collapsed ? "chevrons-up-down" : "chevrons-down-up"),
    shortcut: "ui.shortcut_toggle_collapse",
    scope: ["card", "ai-card"],
    surfaces: ["context", "command", "key"],
    order: 50,
    group: 2,
    applies: hasChildren,
    available: ctx => gate(ctx, ctx.surface === "command" ? COMMAND : CARD),
    run: ctx => ctx.host.toggleCollapse(card(ctx), ctx.surface !== "context")
  },
  {
    id: "focus-branch",
    titleKey: "ui.focus_branch",
    icon: "focus",
    scope: ["card", "ai-card"],
    surfaces: ["more", "context", "command"],
    order: 55,
    group: 2,
    // A card with subtopics; while one branch is focused the map's "Leave focus" is offered instead. enterBranchFocus refuses
    // while presenting; selection mode has no card entries.
    applies: ctx => hasChildren(ctx) && !ctx.branchFocused,
    available: ctx => gate(ctx, COMMAND),
    run: ctx => ctx.host.enterBranchFocus(card(ctx))
  },
  {
    id: "leave-focus",
    titleKey: "ui.exit_branch_focus",
    icon: "minimize-2",
    scope: ["map"],
    surfaces: ["command"],
    order: 56,
    group: 2,
    applies: ctx => ctx.branchFocused,
    available: () => OK,
    run: ctx => ctx.host.exitBranchFocus()
  },
  {
    id: "open-note",
    titleKey: "ui.card_menu_open_note",
    titles: { toolbar: "ui.card_tool_note", command: "ui.command_map_open_details" },
    icon: "file-text",
    scope: ["card", "ai-card"],
    surfaces: ["toolbar", "context", "command"],
    order: 60,
    group: 3,
    // The command opens the details whenever a card is selected, presenting or picking topics included. The toolbar's Note
    // only reads, so it works while loading and presenting (V3.3 A5); the toolbar is not drawn while picking topics.
    // B05: while the notes load the toolbar hides Research, Add, Add summary and ⋯ (not drawn) instead of refusing a click.
    available: ctx =>
      ctx.surface === "command" ? OK : ctx.surface === "toolbar" ? gate(ctx, ["multiSelect"]) : gate(ctx, CARD),
    run: (ctx, options) => ctx.host.openNote(card(ctx), options?.newTab ?? false)
  },
  {
    id: "rename",
    titleKey: "ui.shortcut_rename",
    titles: { command: "ui.command_map_rename" },
    icon: "pencil",
    shortcut: "ui.shortcut_rename",
    scope: ["card", "ai-card"],
    surfaces: ["command", "key"],
    order: 70,
    group: 3,
    applies: ctx => !!ctx.node && !!ctx.note(ctx.node.id),
    available: ctx => gate(ctx, ctx.surface === "command" ? COMMAND : CARD),
    run: ctx => ctx.host.rename(card(ctx))
  },
  {
    id: "add-summary-field",
    titleKey: "ui.card_tool_add_summary",
    icon: "text",
    scope: ["card", "ai-card"],
    surfaces: ["toolbar"],
    order: 80,
    group: 3,
    applies: ctx => ctx.summaryFieldOffered(),
    available: ctx => gate(ctx, CARD),
    run: ctx => ctx.host.addSummaryField(card(ctx))
  },
  {
    id: "card-settings",
    titleKey: "ui.card_settings_menu",
    icon: "settings-2",
    scope: ["card", "ai-card"],
    surfaces: ["more", "context"],
    order: 90,
    group: 3,
    available: ctx => gate(ctx, [...CARD, "bookStructure"]),
    run: ctx => ctx.host.cardSettings(card(ctx))
  },
  {
    id: "run-card",
    titleKey: "ui.living_node_run_card",
    icon: "play",
    scope: ["ai-card"],
    surfaces: ["more", "context"],
    order: 100,
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
    order: 110,
    group: 3,
    // canSetAiCard: an ordinary note card (its picture-book lock is the gate below).
    applies: ctx => !!ctx.node && !ctx.isArgumentCard(ctx.node.id) && !!ctx.note(ctx.node.id),
    available: ctx => gate(ctx, [...CARD, "bookAi"]),
    run: ctx => ctx.host.editAiCard(card(ctx))
  },
  {
    id: "select-subtopics",
    titleKey: "ui.select_subtopics",
    icon: "list-checks",
    scope: ["card", "ai-card"],
    surfaces: ["more"],
    order: 120,
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
    order: 130,
    group: 3,
    available: ctx => gate(ctx, CARD),
    run: ctx => ctx.host.addSummary([card(ctx).id])
  },
  {
    id: "note-style",
    titleKey: "ui.note_style_menu",
    icon: "palette",
    scope: ["card", "ai-card", "multi"],
    surfaces: ["more", "context"],
    order: 140,
    group: 3,
    // A card has it in its ⋯; a selection only in the right-click menu, and only for one topic.
    applies: ctx => (ctx.node ? ctx.surface !== "context" : ctx.surface === "context" && ctx.ids.length === 1),
    available: ctx => gate(ctx, ctx.node ? CARD : ["presentation", "readOnly"]),
    run: ctx => {
      const node = ctx.node ?? ctx.nodes.find(item => item.id === ctx.ids[0]);
      if (node) ctx.host.noteStyle(node);
    }
  },
  {
    id: "add-other",
    titleKey: "ui.card_tool_add_other",
    icon: "plus",
    scope: ["card", "ai-card"],
    surfaces: ["more"],
    order: 150,
    group: 4,
    available: ctx => gate(ctx, [...CARD, "bookStructure"]),
    run: (ctx, options) => {
      if (options?.menu) ctx.host.fillAddMenu(options.menu, card(ctx));
    }
  },
  {
    id: "book",
    titleKey: "ui.book_card_menu",
    icon: "book-open",
    scope: ["card", "ai-card"],
    surfaces: ["context"],
    order: 160,
    group: 3,
    applies: ctx => ctx.bookMenu(),
    available: ctx => gate(ctx, CARD),
    run: (ctx, options) => {
      if (options?.menu) ctx.host.fillBookMenu(options.menu, card(ctx));
    }
  },
  {
    id: "remove",
    titleKey: "ui.remove_from_map",
    icon: "trash-2",
    shortcut: "ui.shortcut_remove",
    scope: ["card", "ai-card"],
    surfaces: ["context", "key"],
    order: 170,
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
    order: 180,
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
    id: "merge",
    titleKey: "ui.merge",
    icon: "combine",
    scope: ["multi"],
    surfaces: ["toolbar"],
    order: 300,
    group: 1,
    available: ctx =>
      then(gate(ctx, ["bookAi"]), () => {
        const reason = ctx.mergeBlock();
        return reason ? off(reason) : OK;
      }),
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
    available: ctx => then(gate(ctx, ["bookStructure"]), () => merging(ctx, selectionBranches(ctx))),
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
    // Today a selection with no lockable topic shows this row disabled, with no reason text.
    applies: ctx => lockState(ctx).nodes.length > 0,
    available: () => OK,
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
    titleKey: "ui.selection_help",
    icon: "help-circle",
    scope: ["multi"],
    surfaces: ["toolbar"],
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
  }
];

/**
 * The toolbar sets, in their order: the card toolbar, the AI card's (Run all's Stop first; B08 fills the rest of its own) and the
 * selection bar.
 */
const CARD_TOOLBAR_SET: readonly CardActionId[] = ["research", "add-child", "open-note", "add-summary-field"];
export const CARD_TOOLBAR: Readonly<Record<"card" | "ai-card" | "multi", readonly CardActionId[]>> = {
  card: CARD_TOOLBAR_SET,
  "ai-card": ["stop-run-all", ...CARD_TOOLBAR_SET],
  multi: ["merge", "multi-research", "move-to", "selection-help", "finish-selection"]
};

/** The palette commands (main.ts registers them by these ids) and the mapCommand action each one runs today. */
export const CARD_COMMANDS: readonly { commandId: string; mapAction: string; action: CardActionId }[] = [
  { commandId: "map-add-topic", mapAction: "add-topic", action: "add-topic" },
  { commandId: "map-add-subtopic", mapAction: "add-subtopic", action: "add-child" },
  { commandId: "map-add-sibling", mapAction: "add-sibling", action: "add-sibling" },
  { commandId: "map-ai-explore-selected", mapAction: "ai-explore", action: "research" },
  { commandId: "map-rename-selected", mapAction: "rename", action: "rename" },
  { commandId: "map-open-selected-details", mapAction: "open-details", action: "open-note" },
  { commandId: "map-toggle-collapse-selected", mapAction: "toggle-collapse", action: "toggle-collapse" },
  { commandId: "map-zoom-to-fit", mapAction: "zoom-fit", action: "zoom-fit" },
  { commandId: "map-zoom-reset", mapAction: "zoom-reset", action: "zoom-reset" },
  { commandId: "map-search", mapAction: "search", action: "search" },
  { commandId: "map-keyboard-shortcuts", mapAction: "shortcuts", action: "shortcuts" }
];

/** What the context is about: one card (ordinary or AI), a selection, or the map. */
export function cardActionKind(ctx: CardActionContext): CardScope {
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
  const toolbar = surface === "toolbar" && kind !== "map" ? CARD_TOOLBAR[kind] : null;
  const offered = CARD_ACTIONS.filter(
    action =>
      action.surfaces.includes(surface) &&
      (action.scope.includes(kind) || action.scope.includes("map")) &&
      (!toolbar || toolbar.includes(action.id)) &&
      (action.applies?.(ctx) ?? true)
  );
  if (toolbar) offered.sort((a, b) => toolbar.indexOf(a.id) - toolbar.indexOf(b.id));
  return offered.map(action => ({ action, availability: action.available(ctx) }));
}

export function titleKeyFor(action: CardAction, surface: CardSurface, ctx: CardActionContext): TranslationKey {
  return action.titles?.[surface] ?? action.titleFor?.({ ...ctx, surface }) ?? action.titleKey;
}

/** The action's keys, from the same rows the Keyboard shortcuts dialog lists. */
export function shortcutKeysFor(action: CardAction): readonly string[] | undefined {
  return action.shortcut ? MAP_KEYBOARD_SHORTCUTS.find(row => row.action === action.shortcut)?.keys : undefined;
}

/** The ⋯ rule the entries move to (B06): the card's menu actions minus its toolbar set, in order. */
export function ruleMoreSet(kind: "card" | "ai-card"): CardActionId[] {
  return CARD_ACTIONS.filter(
    action =>
      action.scope.includes(kind) &&
      (action.surfaces.includes("more") || action.surfaces.includes("context")) &&
      !CARD_TOOLBAR[kind].includes(action.id)
  ).map(action => action.id);
}

/** Toolbar actions the right-click menu never repeats (Run all's Stop belongs to the running card's toolbar only). */
const TOOLBAR_ONLY: readonly CardActionId[] = ["stop-run-all"];
/** The right-click rule the entries move to (B07): the toolbar set (minus TOOLBAR_ONLY), a separator, then the ⋯ set. */
export function ruleContextSet(kind: "card" | "ai-card"): (CardActionId | "separator")[] {
  return [...CARD_TOOLBAR[kind].filter(id => !TOOLBAR_ONLY.includes(id)), "separator", ...ruleMoreSet(kind)];
}
