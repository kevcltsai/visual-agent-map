import { Keymap, setIcon } from "obsidian";
import { t } from "../../i18n";
import type { ImageCandidate } from "../../core/image-candidates";
import { summarizeBasis, type BasisSummaryEntry, type MapChatBasis } from "../../core/map-chat-basis";
import type { MapChatContinuationInput, MapChatTurn } from "../../core/map-chat-context";
import {
  MAP_CHAT_CHAIN_MAX_ROUNDS,
  MAP_CHAT_CHAIN_WAIT_MS,
  type MapChatChainEndReason,
  type MapChatChainPanel,
  type MapChatChainState,
  type MapChatChainWaiting
} from "../../core/map-chat-chain";
import { renderChatMarkdown } from "../../core/map-chat-render";
import { hasUnsavedChat } from "../../core/map-chat-transcript";
import {
  clampMapChatWidth,
  countChatLines,
  splitChatLines,
  MAP_CHAT_WIDTH_DEFAULT,
  MAP_CHAT_WIDTH_MAX,
  MAP_CHAT_WIDTH_MIN,
  MAP_CHAT_WIDTH_STEP,
  type ChatLineCounts
} from "../../core/map-chat-layout";

/** What the user attached to the next message. Topic chips come from a dragged card; snippets and files from a drop. */
export type MapChatChip =
  | { kind: "topic"; id: string }
  | { kind: "snippet"; path: string; text: string; pathGuessed: boolean }
  | { kind: "file"; path: string };

export interface MapChatLine {
  status: "done" | "skipped" | "failed";
  text: string;
  /**
   * The picture searches this line stands for (one per target card). The line says how they stand now (see {@link settledLine}),
   * so it never claims a result the block under the reply does not show.
   */
  imageGroup?: MapChatImages[];
  /**
   * What the card or cards this line stands for were built from (decided by the program; "read", never "checked"). Kept with the
   * line in memory and in the conversation record. The panel shows it from P4 on.
   */
  basis?: MapChatBasis;
}

/** A search block that ended with a picture put into its card. */
export function placedImage(block: MapChatImages): MapChatImageItem | undefined {
  return block.state === "ready" ? block.items.find(item => item.inserted) : undefined;
}
/** The line as it reads now: a picture-search line follows the blocks of its action (one per card); any other line is itself. */
export function settledLine(line: MapChatLine): MapChatLine {
  const blocks = line.imageGroup;
  if (!blocks) return line;
  const total = blocks.length;
  const pending = blocks.filter(block => block.state === "searching").length;
  // The model(s) the searches run on, when the blocks know them (a block saved before this was added has none: no suffix).
  const labels = [...new Set(blocks.flatMap(block => (block.modelLabel ? [block.modelLabel] : [])))];
  const model = labels.length ? t("ui.map_chat_model_suffix_0", labels.join(t("ui.map_chat_model_separator"))) : "";
  if (pending) {
    return { ...line, status: "done", text: t("ui.map_chat_line_images_progress_0_1", total - pending, total) + model };
  }
  const placed = blocks.filter(block => placedImage(block)).length;
  const missed = total - placed;
  return {
    ...line,
    status: placed ? "done" : blocks.some(block => block.state === "failed") ? "failed" : "skipped",
    text:
      (missed ? t("ui.map_chat_line_images_group_0_1", placed, missed) : t("ui.map_chat_line_images_group_0", placed)) +
      model
  };
}

/**
 * The picture searches of a reply are one result: every find_images action of the reply shares the reply's blocks (the model
 * usually sends one action per card), so a line that stands for the same blocks as an earlier line is left out.
 */
export function onceImageLines(lines: MapChatLine[]): MapChatLine[] {
  const seen = new Set<MapChatImages[]>();
  return lines.filter(line => {
    if (!line.imageGroup) return true;
    if (seen.has(line.imageGroup)) return false;
    seen.add(line.imageGroup);
    return true;
  });
}

/** What a question was sent with, kept so a failed turn can be sent again. */
export interface MapChatOrigin {
  text: string;
  chips: MapChatChip[];
  selectedIds: string[];
  /** The canvas image that was selected when the message was sent (a retry reads it again); never the picture itself. */
  imageId?: string;
  /** An automatic round of a continuation: the chain it belongs to and what the round is told about the one before. A retry starts from here. */
  chain?: MapChatChainOrigin;
}
/** Where an automatic round stands in its chain. `state` is the chain as it was when the round began (a retry takes the round again, not a new count). */
export interface MapChatChainOrigin {
  seq: number;
  state: MapChatChainState;
  continuation: MapChatContinuationInput;
  /** Cards the chain created so far (real ids); a retry of the round starts from them. */
  createdIds?: string[];
}

/** A reply that waits for the user's yes: what it would do, what it costs, and the two buttons. */
export interface MapChatPlanCard {
  /** One line per reason the reply needs confirming. */
  reasons: string[];
  /** One line per action, in order. */
  items: string[];
  /** The estimated AI calls, as a sentence. */
  estimate: string;
  /** The one-sentence description; built from `reasons` when absent. */
  summary?: string;
  /** The same actions by kind of work, each folded on the card; `items` is shown flat when absent. */
  groups?: { label: string; items: string[]; danger?: { mark: string } }[];
  /** The groups are shown open (a plan about a picture); folded when absent. */
  openGroups?: boolean;
  /** The plan starts AI work (research, expand, …): undo does not take that part back, and the card says so. */
  aiWork?: boolean;
  state: "pending" | "applied" | "cancelled";
  /** Restored from a saved conversation: the card shows as no longer valid and its buttons do nothing. */
  stale?: boolean;
  apply(): void;
  cancel(): void;
}
/** Maps (or anything else) the user has to pick from; picking runs `pick` once. */
export interface MapChatChoices {
  prompt: string;
  options: { label: string; pick(): void }[];
  picked: boolean;
  /** Restored from a saved conversation: the options show as no longer valid and do nothing. */
  stale?: boolean;
}

/** The picture a search put into its card. (A restored older record may also list candidates that were never inserted.) */
export interface MapChatImageItem {
  candidate: ImageCandidate;
  /** Title of the card the picture was put into; set once it was. */
  inserted?: string;
}
/**
 * The picture search of one card of a `find_images`: it ends with the first loadable picture put into the card, or with a reason.
 * The blocks of a reply are shown as one result under it; a later message does not drop them.
 */
export interface MapChatImages {
  /** The search words. */
  query: string;
  /** The card the picture is put into, with the map it was found on. */
  nodeId: string;
  nodeTitle: string;
  mapPath: string;
  mapId: string;
  /** The label of the model the search runs on, shown at the end of the line; absent in an older saved block. */
  modelLabel?: string;
  state: "searching" | "ready" | "empty" | "failed" | "stopped";
  /** Why the search failed. */
  reason?: string;
  /** The search has started (a searching block that is not running waits for one of the free places). */
  running?: boolean;
  /** Empty, or the one picture that was put into the card. */
  items: MapChatImageItem[];
  /** Restored from a saved conversation: shown read-only, without thumbnails or links. */
  stale?: boolean;
  /** Stops the search (only while it has not ended). */
  stop?(): void;
}
/** A finished question and answer, as the host saves them. */
export interface MapChatSavedTurn {
  question: MapChatMessage;
  answer: MapChatMessage;
}

/**
 * The progress stage shown inside the AI bubble while a turn runs. "Preparing" is the time before the request reaches the
 * model (checking the AI, building the request); "consent" is the time the AI usage notice is open and waits for the user's
 * answer (nothing is being built, and Stop is not offered: the notice itself has Cancel). There is no "thinking": the model's
 * thinking cannot be seen.
 */
export type MapChatStage = "preparing" | "consent" | "waiting" | "writing" | "applying";
const STAGE_ORDER: Record<MapChatStage, number> = { preparing: 0, consent: 1, waiting: 2, writing: 3, applying: 4 };

/** What {@link MapChatPanel.begin} returns: the two messages it added, so {@link MapChatPanel.retract} can take exactly them back. */
export interface MapChatTurnHandle {
  readonly user: MapChatMessage;
  readonly assistant: MapChatMessage;
  /** The lists of choices this turn retired (they were still open), which a retract opens again. */
  readonly retired: MapChatChoices[];
}

/** A follow-up the user typed while the reply was being made: "live" went into the running turn, "queued" waits for the turn to end. */
export interface MapChatSteer {
  text: string;
  state: "live" | "queued";
}

/** An expansion of a reply that failed: its start line's basis loses that card, and the failure line joins the results. */
export interface ExpandFailure {
  was: MapChatBasis | null;
  next: MapChatBasis | null;
  failure: MapChatLine;
}
/** The lines with the failures settled in order (see {@link MapChatPanel.settleExpandFailure}); the start line is found by its basis. */
export function settleExpandFailures(lines: MapChatLine[], failures: readonly ExpandFailure[]): MapChatLine[] {
  let result = lines;
  for (const { was, next, failure } of failures) {
    const at = was ? result.findIndex(line => line.basis === was) : -1;
    if (at < 0) result = [...result, failure];
    else if (next) result = [...result.map((line, index) => (index === at ? { ...line, basis: next } : line)), failure];
    else result = result.map((line, index) => (index === at ? failure : line));
  }
  return result;
}
export interface MapChatMessage {
  role: "user" | "assistant";
  /** On a user message: an automatic round of a continuation, not something the user said. Its `text` is only the label that history and notes show. */
  auto?: true;
  /** On an automatic round's question: what its separator row says (the round and what is left). A restored round may know only its number. */
  autoInfo?: MapChatAutoInfo;
  /** On a user message: the question and references it was sent with. */
  origin?: MapChatOrigin;
  /** On a user message: the follow-ups typed while its reply was being made, oldest first (shown under the question). */
  steers?: MapChatSteer[];
  text: string;
  /** One line per applied, skipped or failed action. */
  lines: MapChatLine[];
  error?: boolean;
  /** On a failed turn: the raw error text, shown only under a folded "Technical details". */
  technical?: string;
  streaming?: boolean;
  /** Expansion failures that came in before the turn ended: merged into the result lines by {@link MapChatPanel.finish} (in memory only). */
  lateFailures?: ExpandFailure[];
  plan?: MapChatPlanCard;
  choices?: MapChatChoices;
  /** More result lines than fit are folded into a count; true while they are all shown. */
  linesOpen?: boolean;
  /** The picture searches the reply asked for (`find_images`), one block per card, oldest first. */
  images?: MapChatImages[];
  /** On an assistant message: the name of the model that was current when its question was sent; it never changes afterwards. */
  modelLabel?: string;
  /** This turn sent a picture to the AI; `note` is the text shown after "AI looked at this picture" (untrusted, setText only). In memory only. */
  seenImage?: { note: string };
  /** "Apply directly" wrote this reply: the token of its undo step, for the "Undo this reply" button. In memory only, never saved. */
  replyUndo?: { token: object };
  /** Restored from a saved conversation: Retry (if it ever shows) is no longer valid. */
  stale?: boolean;
  /** On an assistant message: the sentence that told why the automatic continuation ended after this reply (in memory only). */
  chainNote?: { reason: MapChatChainEndReason; text: string };
  /** On an assistant message: research notes of the conversation this round did not read (in memory only). */
  unread?: { title: string; oversize: boolean }[];
}

/** What the separator row of an automatic round shows. */
export interface MapChatAutoInfo {
  round?: number;
  maxRounds: number;
  remaining?: string;
  /** Research that went on after some of it failed: how many cards failed and how many notes the round is built on. */
  partial?: { failed: number; succeeded: number };
}

/** A saved conversation as {@link MapChatPanel.restore} takes it (core `restoreConversation` returns this shape). */
export interface MapChatRestoredConversation {
  id: string;
  /** The time of the last finished turn (ISO); the "restored" line shows it in local time. Null with no turn. */
  restoredAt: string | null;
  turns: {
    message: string;
    reply: string;
    lines: { status: string; text: string; basis?: MapChatBasis }[];
    modelLabel: string;
    stalePlan: boolean;
    /** The follow-ups that went into the turn (shown as live ones, so the next request carries them too). */
    steers?: string[];
    /** An automatic round of a continuation, and its round number when the record has it. */
    auto?: boolean;
    round?: number;
    /** What the automatic round's separator said was left (plain text). */
    remaining?: string;
    /** How the continuation that ended with this turn ended: shown as its end sentence, nothing is resumed. */
    chainEnd?: { reason: MapChatChainEndReason; round: number; remaining: string };
    /** What became of the plan card: no line (undefined) = it was still waiting; stopped counts as applied. */
    planState?: "applied" | "cancelled" | "stopped";
    /** The result lines the applied plan wrote. */
    planLines?: { status: string; text: string; basis?: MapChatBasis }[];
    images?: { state: string; items: { title: string; sourceUrl: string }[]; inserted: number[] };
  }[];
}

/** The picture the chat is about (a canvas image chosen by the user); `note` is untrusted text. */
export interface MapChatImageInfo {
  id: string;
  kind: "annotated" | "plain";
  note: string;
  name: string;
}
/** Where the undo step of a reply is now: the newest step (one undo takes the reply back), undone (it waits for redo), or buried under later steps. */
export type MapChatReplyUndoState = "top" | "undone" | "other";

/** What the panel needs from the view that owns it. */
export interface MapChatHost {
  /** Title of a topic, or null when it is no longer on the map. */
  topicTitle(id: string): string | null;
  /** Cards that are selected right now; they count as references without being dragged in. */
  selectedIds(): string[];
  /** The panel asks to send the current draft. */
  send(): void;
  /** The panel asks to stop the running request. */
  stop(): void;
  /** Enter with text while a turn works: the text in the field is a follow-up for the running turn (the view reads the draft). */
  steer?(): void;
  /** The opening screen's secondary button: a new empty map through the name box, no AI. Absent: no button. */
  createEmptyMap?(): void;
  /** The clock the stage seconds are counted on (tests); the real time when absent. */
  now?(): number;
  /** Resolves a `[[link]]` target to the vault path of the note it names, or null. */
  resolveLink(link: string): string | null;
  /** The note the user most recently had open (best guess for where dropped text came from), or null. */
  activeNotePath(): string | null;
  /** The note that is visible beside the map right now (the one a message would be sent with), or null. */
  visibleNotePath(): string | null;
  /** Opens the note a `[[link]]` in a reply names (`newLeaf`: in a new tab). */
  openLink(href: string, newLeaf: boolean | "tab" | "split" | "window"): void;
  /** The element that has keyboard focus right now. */
  activeElement(): Element | null;
  /** Models the chat can use (the current model is one of them, or an "unavailable" entry). */
  modelChoices(): { value: string; label: string; short?: string }[];
  /** The current model (shared with the settings page). */
  model(): string;
  /** The user picked a model: it becomes the current model everywhere. */
  setModel(model: string): void;
  /** Calls `changed` whenever the available models or the current model change, and starts a refresh; the returned function stops listening. */
  watchModels(changed: () => void): () => void;
  /** The name the model menu shows for a model id (without any "unavailable" note); absent: the menu entry's label is used. */
  modelName?(id: string): string;
  /** The panel opened, closed, folded to the narrow edge or went to the opening screen; the view makes room for it. */
  layoutChanged(open: boolean): void;
  /** Width in pixels of the side window (the view remembers it). */
  width?(): number;
  /** The widths the pane gives the window for a set width (docked, and laid over a narrow pane); null when the pane is unknown. */
  widths?(setWidth: number): { docked: number; overlay: number } | null;
  /** The user is resizing the side window; `commit` is false while the handle is still being dragged. */
  setWidth?(width: number, commit: boolean): void;
  /** "Retry" on a failed turn: send the same question again. */
  retry?(origin: MapChatOrigin): void;
  /** The conversation's state changed (a turn started or ended, a plan appeared or was settled); the canvas may say so. */
  stateChanged?(): void;
  /** The picture the chat is about now, or null (none chosen). */
  image?(): MapChatImageInfo | null;
  /** Calls `changed` whenever the chosen picture changes; the returned function stops listening. */
  watchImage?(changed: () => void): () => void;
  /** "AI changes to a picture": show a preview first, or apply at once (remembered). */
  imageMode?(): "preview" | "direct";
  /** The user switched it; the view remembers it at once. */
  setImageMode?(mode: "preview" | "direct"): void;
  /** Where the undo step of a written reply is now. */
  replyUndoState?(token: object): MapChatReplyUndoState;
  /** The "Undo this reply" button: undoes exactly that reply when it is the newest step, otherwise changes nothing and says how to undo in order. */
  undoReply?(token: object): Promise<"undone" | "later">;
  /** Whether the conversation can be saved next to this map; `reason` says why not. */
  canSave?(): { ok: true } | { ok: false; reason: string };
  /** Saves the finished turns as a note; resolves with the new note's path, or why it could not be saved. */
  saveTranscript?(turns: MapChatSavedTurn[]): Promise<{ ok: true; path: string } | { ok: false; reason: string }>;
  /** Conversation records are on: the title row shows "New conversation". Absent or false: no button, the panel works as before. */
  recordsEnabled?(): boolean;
  /** The panel was cleared by "New conversation": the next turn goes into a new record file. */
  newConversation?(): void;
}

const LABEL_LIMIT = 40;
/** Result lines that are notes: shown, but not counted as results. */
export const chatNoteTexts = (): string[] => [t("ui.map_chat_not_undoable"), t("ui.map_chat_auto_layout_added")];
/** The lines that are results of actions (what the next round of a continuation is told), without the explanation notes. */
export function chatResultLines<T extends { status: "done" | "skipped" | "failed"; text: string }>(
  lines: readonly T[]
): T[] {
  return splitChatLines(lines, chatNoteTexts()).results;
}
/** The failed result line of one card's expansion that started with a reply: names the card, not a count. */
export function expandFailureLine(title: string, reason: string): MapChatLine {
  return {
    status: "failed",
    text: t("ui.map_chat_line_failed_0_1", t("ui.map_chat_do_expand_topic_0", title), reason)
  };
}
const clip = (value: string, limit = LABEL_LIMIT): string => {
  const text = value.replace(/\s+/g, " ").trim();
  const characters = [...text];
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : text;
};
const baseName = (path: string): string => path.split("/").at(-1)!.replace(/\.md$/i, "");

/** The note a dropped text names: `[[Note]]`, `[[Note#Heading|alias]]` or an `obsidian://open?...file=` address. Else null. */
export function droppedLinkTarget(text: string): string | null {
  const value = text.trim();
  const wiki = value.match(/^!?\[\[([^\]\n]+)\]\]$/);
  if (wiki) {
    const target = wiki[1].split("|")[0].split("#")[0].trim();
    return target || null;
  }
  const url = value.match(/^obsidian:\/\/open\?([^\s]*)$/i);
  if (url) {
    for (const part of url[1].split("&")) {
      const [key, raw = ""] = part.split("=");
      if (key !== "file") continue;
      try {
        const file = decodeURIComponent(raw.replace(/\+/g, " ")).trim();
        return file || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

let panelSequence = 0;

/**
 * The map's AI chat window: messages, draft, reference chips and the open or collapsed state. It lives on the view, builds
 * its elements once, and is put back into each repaint of the map (see {@link mount}); nothing here talks to the AI.
 */
export class MapChatPanel implements MapChatChainPanel<MapChatOrigin, MapChatTurnHandle> {
  private readonly id = `vam-map-chat-${++panelSequence}`;
  private messages: MapChatMessage[] = [];
  /** Finished turns already written by "save as a note"; reset with the conversation. */
  private savedTurnCount = 0;
  private chips: MapChatChip[] = [];
  /** The user's wish: the side window is open (remembered). Whether it shows also depends on `narrow`. */
  private open = false;
  /** The pane is too narrow to dock the window: it is a narrow edge, and `overlayOpen` lays it over the canvas. */
  private narrow = false;
  private overlayOpen = false;
  /** The opening screen: no side window yet, the same elements stand in the middle of the canvas. */
  private hero = false;
  private unread = false;
  private width = MAP_CHAT_WIDTH_DEFAULT;
  private busy = false;
  private chainWaitingState: MapChatChainWaiting | null = null;
  /** What the continuation still has to do, as the waiting row says it. */
  private chainWaitingLeft = "";
  /** When the wait began (the seconds count from there), the timer that rewrites them, and the two texts that change. */
  private chainWaitingSince = 0;
  private chainWaitingTimer: { cancel: () => void } | null = null;
  private chainWaitingEls: { label: HTMLElement; elapsed: HTMLElement } | null = null;
  /** The round and the limit of the continuation in flight (1 and the default for an ordinary message). */
  private chainRound = 1;
  private chainMax = MAP_CHAT_CHAIN_MAX_ROUNDS;
  /** A confirmed plan is being applied: the window shows it is working and can stop it. */
  private applying = false;
  private composing = false;
  /** The widths the pane leaves for the docked window and for the one laid over a narrow pane (the set width when unknown). */
  private dockedPx: number | null = null;
  private overlayPx: number | null = null;
  /** Where the log was scrolled when the panel was taken out for a repaint. */
  private keptScroll: { atEnd: boolean; top: number } | null = null;
  private el!: HTMLElement;
  private toggleEl!: HTMLButtonElement;
  private badgeEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private headEl!: HTMLElement;
  private heroTitleEl!: HTMLElement;
  private closeEl!: HTMLButtonElement;
  private logLabelEl!: HTMLElement;
  private guideEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private logEl!: HTMLElement;
  private emptyMapEl!: HTMLButtonElement;
  private resizerEl!: HTMLElement;
  private liveEl!: HTMLElement;
  private stopResizing: (() => void) | null = null;
  private chipsEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendEl!: HTMLButtonElement;
  private modelEl!: HTMLSelectElement;
  private guideIconEl!: HTMLElement;
  private guideTextEl!: HTMLElement;
  private stopEl!: HTMLButtonElement;
  private steerHintEl!: HTMLElement;
  private saveEl!: HTMLButtonElement;
  /** "New conversation": built only while the host says records are on. */
  private newEl: HTMLButtonElement | null = null;
  /** The "restored <time>" line above the log; null when the panel was not restored. */
  private restoredEl!: HTMLElement;
  private restoredText = "";
  /** The record the conversation is saved in (set by the view); cleared by {@link reset}. */
  conversationId: string | null = null;
  /** The note is being written; a second press does nothing. */
  private saving = false;
  /** The save button reads as disabled (it stays reachable by keyboard, so its title can be read). */
  private saveDisabled = true;
  /** What the reader is told once the reply that is streaming now has ended (a picture search can end in the middle of it). */
  private spokenLater: string[] = [];
  private built = false;
  private stopWatching: (() => void) | null = null;
  private stopWatchingImage: (() => void) | null = null;
  private imageModeEl!: HTMLElement;
  private imageModeButtons: Record<"preview" | "direct", HTMLButtonElement> | null = null;
  private messageEls: HTMLElement[] = [];
  private bodyEls: HTMLElement[] = [];
  /** The laid-out row of each message with the state it was built from; a message that has not changed keeps its row. */
  private rows = new WeakMap<
    MapChatMessage,
    { key: string; row: HTMLElement; body: HTMLElement; more: HTMLButtonElement | null }
  >();
  /** The animation frame that will lay out the streaming message, if one is waiting. */
  private frame: { cancel: () => void } | null = null;
  /** The progress stage of the running turn and when it started (the seconds count from there). Null when nothing runs. */
  private stage: { kind: MapChatStage; since: number } | null = null;
  /** The label of the model the running turn was sent with (read once when the turn begins, so a switch mid-turn does not change it). */
  private stageModel = "";
  /** The stage line inside the AI bubble, with the two texts that change. */
  private stageEls: { box: HTMLElement; label: HTMLElement; elapsed: HTMLElement; slow: HTMLElement | null } | null =
    null;
  /** The slow notice of the running turn (no model event for a long while) and what its button does. Null when not shown. */
  private slow: { text: string; resend: () => void } | null = null;
  /** The one-second timer that rewrites the seconds (only their text). */
  private stageTimer: { cancel: () => void } | null = null;
  /** Whether the body was showing at the last applyOpen, to tell the moment it opens. */
  private wasShown = false;
  /** The scroll to the end that waits for the overlay's height to be final. */
  private openFrame: { cancel: () => void } | null = null;
  /** The visible note the user took off the chip; it stays off until another note is visible. */
  private dismissedNote: string | null = null;
  private noteChip: string | null = null;

  constructor(private readonly host: MapChatHost) {}

  /** The window is showing (docked, laid over the canvas, or as the opening screen). */
  get isOpen(): boolean {
    return this.shown;
  }
  /** The user's choice to keep it open, which is what is remembered; it can differ from what shows on a narrow pane. */
  get wantsOpen(): boolean {
    return this.open;
  }
  get isHero(): boolean {
    return this.hero;
  }
  get isNarrow(): boolean {
    return this.narrow;
  }
  get hasMessages(): boolean {
    return this.messages.length > 0;
  }
  get docked(): boolean {
    return !this.hero && this.open && !this.narrow;
  }
  private get floating(): boolean {
    return !this.hero && this.narrow && this.overlayOpen;
  }
  private get shown(): boolean {
    return this.hero || this.docked || this.floating;
  }
  /** A turn is running (a request or its actions). */
  get isBusy(): boolean {
    return this.busy;
  }
  /** The progress stage of the running turn, or null when nothing runs. */
  get stageKind(): MapChatStage | null {
    return this.stage?.kind ?? null;
  }
  /** Set when the usage notice closed before Stop was shown: the keyboard waits in the message field and moves to Stop when it appears. */
  private stopWanted = false;
  /** The running turn waits for the user to answer the AI usage notice: nothing is being built yet. */
  get awaitingConsent(): boolean {
    return this.busy && this.stage?.kind === "consent";
  }
  /** The window is laid over the canvas of a narrow pane. */
  get isOverlay(): boolean {
    return this.floating;
  }
  /** Width of the window laid over the canvas, 0 when it is not. */
  get overlayWidth(): number {
    return this.floating ? this.shownWidth() : 0;
  }
  /** A turn or a plan being applied is running: no new message can be sent, and Stop is offered. */
  private get working(): boolean {
    return this.busy || this.applying;
  }
  get isComposing(): boolean {
    return this.composing;
  }
  get draft(): string {
    return this.built ? this.inputEl.value : "";
  }
  /** Empties the message field (the user left the opening screen to start the map by hand). */
  clearDraft(): void {
    if (this.built) this.inputEl.value = "";
  }
  /** True when `element` is the message field. */
  isInput(element: unknown): boolean {
    return this.built && element === this.inputEl;
  }
  /** True when the element is one of this window's controls. */
  holdsFocus(element: Node): boolean {
    return this.built && this.el.contains(element);
  }
  /** Path of the visible note the next message goes with (the chip's note), or null. */
  currentNote(): string | null {
    this.refreshNote();
    return this.noteChip;
  }
  /** The visible note may have changed: update which note the chip names and repaint the chips. */
  refreshNote(): void {
    const visible = this.host.visibleNotePath();
    if (visible && visible !== this.dismissedNote) this.dismissedNote = null;
    this.noteChip = visible && visible !== this.dismissedNote ? visible : null;
    this.renderChips();
  }
  attachments(): MapChatChip[] {
    return this.chips.map(chip => ({ ...chip }));
  }
  /** Finished question and answer turns, oldest first, for the next request. */
  turns(): MapChatTurn[] {
    const turns: MapChatTurn[] = [];
    // Messages always come in pairs (question, answer); a pair whose answer is unfinished or failed is not history.
    for (let at = 0; at + 1 < this.messages.length; at += 2) {
      const question = this.messages[at];
      const answer = this.messages[at + 1];
      if (answer.streaming || answer.error || !answer.text.trim()) continue;
      // Follow-ups that went into the turn are part of what the user asked: joined by a blank line, no tag.
      const steered = (question.steers ?? []).filter(steer => steer.state === "live").map(steer => steer.text);
      turns.push(
        { role: "user", text: [question.text, ...steered].join("\n\n") },
        { role: "assistant", text: answer.text }
      );
    }
    return turns;
  }
  /** Finished question and answer pairs, oldest first: what "save as a note" writes (a streaming or failed answer is left out). */
  /** True when finished turns exist that no "save as a note" has written (the chat is memory-only, so closing the view drops them). */
  get hasUnsavedTurns(): boolean {
    return hasUnsavedChat(this.completedTurns().length, this.savedTurnCount);
  }
  completedTurns(): MapChatSavedTurn[] {
    const turns: MapChatSavedTurn[] = [];
    for (let at = 0; at + 1 < this.messages.length; at += 2) {
      const question = this.messages[at];
      const answer = this.messages[at + 1];
      if (answer.streaming || answer.error || !answer.text.trim()) continue;
      turns.push({ question, answer });
    }
    return turns;
  }
  transcript(): MapChatMessage[] {
    return this.messages.map(message => ({ ...message, lines: message.lines.map(settledLine) }));
  }

  /**
   * Puts the panel into `parent` (built there the first time, moved there afterwards). "side" makes it the first child of
   * `parent`, the window left of the canvas; "hero" is the opening screen, which goes wherever `parent` is.
   */
  mount(parent: HTMLElement, mode: "side" | "hero" = "side"): void {
    this.hero = mode === "hero";
    if (!this.built) this.build(parent);
    else if (mode === "hero") this.place(parent, null);
    if (mode === "side") this.place(parent, parent.firstChild);
    this.width = clampMapChatWidth(this.host.width?.() ?? this.width);
    this.applyOpen();
    this.refreshNote();
    this.refreshControls();
    this.restoreScroll();
  }
  /** After a repaint the log is scrolled where it was: at the end it stays at the end (a new element starts at the top). */
  private restoreScroll(): void {
    const kept = this.keptScroll;
    this.keptScroll = null;
    if (!kept || !this.built) return;
    if (kept.atEnd) this.scrollToEnd();
    else this.logEl.scrollTop = kept.top;
  }
  /** Moves the panel to `parent`, before `before` (the end when null). */
  private place(parent: HTMLElement, before: ChildNode | null): void {
    // `before` is read before the panel leaves, so when it is the panel itself, the panel stays first.
    const ref = before === this.el ? this.el.nextSibling : before;
    this.el.remove();
    parent.insertBefore(this.el, ref);
  }
  /** The view is closing: stop listening for model changes and let go of a resize in progress. */
  dispose(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    this.stopWatchingImage?.();
    this.stopWatchingImage = null;
    this.stopResizing?.();
    this.cancelFrame();
    this.clearStage();
    this.rows = new WeakMap();
  }
  /** Takes the panel out of the page; the next {@link mount} puts it back with all state intact. */
  detach(): void {
    if (!this.built) return;
    this.keptScroll = { atEnd: this.atEnd(), top: this.logEl.scrollTop };
    this.el.remove();
  }
  /**
   * Call before a repaint: when the message field has focus, the returned function (call it after the repaint) gives it
   * focus again with the caret and selection where they were. Any other control of the window (it is moved, not rebuilt)
   * gets it back the same way, so a repaint never drops the keyboard to the page.
   */
  captureFocus(): () => void {
    if (!this.built) return () => {};
    const active = this.host.activeElement();
    if (active !== this.inputEl) {
      if (!active || !this.el.contains(active)) return () => {};
      // The log's scroll was restored by the repaint: a button far up in it must not pull the log back.
      return () => (active as HTMLElement).focus({ preventScroll: true });
    }
    const { selectionStart, selectionEnd } = this.inputEl;
    return () => {
      this.inputEl.focus();
      if (typeof selectionStart === "number" && typeof selectionEnd === "number")
        this.inputEl.setSelectionRange(selectionStart, selectionEnd);
    };
  }

  setOpen(open: boolean, focus = false): void {
    if (open === this.open && (!this.narrow || open === this.overlayOpen) && !focus) return;
    this.open = open;
    this.overlayOpen = open;
    this.applyOpen();
    if (open) {
      this.refreshControls();
      this.refreshNote();
    }
    this.host.layoutChanged(this.shown);
    if (!this.built) return;
    if (open && focus) this.inputEl.focus();
    if (!open && focus) this.toggleEl.focus();
  }
  /** The saved open state is applied without telling the view (it asked for it). */
  restoreOpen(open: boolean): void {
    this.open = open;
    this.overlayOpen = false;
    this.applyOpen();
  }
  /** The pane became too narrow to dock the window (or wide enough again). The window folds to its edge, or docks back. */
  setNarrow(narrow: boolean, widths?: { docked: number; overlay: number }): void {
    if (widths && (widths.docked !== this.dockedPx || widths.overlay !== this.overlayPx)) {
      this.dockedPx = widths.docked;
      this.overlayPx = widths.overlay;
      this.applyWidth();
    }
    if (narrow === this.narrow) return;
    const hadFocus = this.hasFocus();
    this.narrow = narrow;
    this.overlayOpen = false;
    this.applyOpen();
    this.host.layoutChanged(this.shown);
    if (hadFocus && !this.shown && this.built) this.toggleEl.focus();
  }
  /** Lays the folded window back to its edge without forgetting that the user wants it open (Escape, a click on the canvas). */
  collapseOverlay(focus = false): void {
    if (!this.floating) return;
    const hadFocus = this.hasFocus();
    this.overlayOpen = false;
    this.applyOpen();
    this.host.layoutChanged(this.shown);
    if ((focus || hadFocus) && this.built) this.toggleEl.focus();
  }
  /** The command that opens or closes the window: it ends with the keyboard in the message field when it opens. */
  toggleFromCommand(): void {
    if (this.hero) {
      this.focusInput();
      return;
    }
    if (!this.shown) this.setOpen(true, true);
    else if (this.built && this.host.activeElement() !== this.inputEl) this.inputEl.focus();
    else if (this.narrow) this.collapseOverlay(true);
    else this.setOpen(false, true);
  }
  private hasFocus(): boolean {
    const active = this.host.activeElement();
    return this.built && !!active && this.el.contains(active);
  }

  /** Whether the point is over the panel (or over its button while it is collapsed). */
  hitTest(clientX: number, clientY: number): boolean {
    if (!this.built) return false;
    const rect = this.el.getBoundingClientRect();
    if (!rect.width && !rect.height) return false;
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }
  setDropHighlight(on: boolean): void {
    if (this.built) this.el.toggleClass("is-drop", on);
  }

  addTopicReference(id: string): void {
    this.addChip({ kind: "topic", id });
  }
  addSnippet(text: string, path: string, pathGuessed: boolean): void {
    if (!text.trim()) return;
    this.addChip({ kind: "snippet", path, text, pathGuessed });
  }
  addFile(path: string): void {
    this.addChip({ kind: "file", path });
  }
  private addChip(chip: MapChatChip): void {
    const same = (other: MapChatChip): boolean =>
      other.kind === chip.kind &&
      (chip.kind === "topic"
        ? other.kind === "topic" && other.id === chip.id
        : chip.kind === "file"
          ? other.kind === "file" && other.path === chip.path
          : other.kind === "snippet" && other.text === chip.text && other.path === chip.path);
    if (!this.chips.some(same)) this.chips.push(chip);
    this.setOpen(true);
    this.renderChips();
  }
  removeChip(chip: MapChatChip): void {
    const at = this.chips.indexOf(chip);
    this.chips = this.chips.filter(other => other !== chip);
    this.renderChips();
    if (at < 0 || !this.built) return;
    // The removed chip took the keyboard focus with it: hand it to the next chip, else the previous one, else the field.
    const buttons = this.chipsEl.querySelectorAll<HTMLElement>(".vam-map-chat-chip-remove");
    const target = buttons[at] ?? buttons[at - 1];
    if (target) target.focus();
    else this.inputEl.focus();
  }
  /** The selection changed: repaint the reference chips. */
  refreshSelection(): void {
    this.renderChips();
  }

  /** A turn starts: the user's text, an empty answer, and the busy state (the view starts in "preparing"). */
  begin(
    userText: string,
    origin?: MapChatOrigin,
    keepDraft = false,
    stage: MapChatStage = "waiting",
    auto = false,
    autoInfo?: MapChatAutoInfo
  ): MapChatTurnHandle {
    // A list of maps to pick from belongs to the message before; a new message ends its choices.
    const retired = this.messages.flatMap(message =>
      message.choices && !message.choices.picked ? [message.choices] : []
    );
    this.retireChoices();
    const user: MapChatMessage = {
      role: "user",
      text: userText,
      lines: [],
      ...(origin ? { origin } : {}),
      ...(auto ? { auto: true as const, ...(autoInfo ? { autoInfo } : {}) } : {})
    };
    if (!auto) {
      this.chainRound = 1;
      this.chainMax = MAP_CHAT_CHAIN_MAX_ROUNDS;
    }
    const modelLabel = this.replyModelLabel();
    const assistant: MapChatMessage = {
      role: "assistant",
      text: "",
      lines: [],
      streaming: true,
      ...(modelLabel ? { modelLabel } : {})
    };
    this.messages.push(user, assistant);
    this.busy = true;
    this.stage = { kind: stage, since: this.clockNow() };
    this.stageModel = this.currentModelLabel();
    this.slow = null;
    if (this.built && !keepDraft) this.inputEl.value = "";
    this.renderLog(true);
    this.renderBusy();
    this.startStageTimer();
    this.speakStage();
    return { user, assistant, retired };
  }
  /**
   * An automatic round of a continuation begins: the same turn as {@link begin} (preparing, busy, an answer to fill), but its
   * question is not the user's. Its row is a separator ("Automatic continuation · round 2 of 8", what is left, and, after research
   * that partly failed, what the round is built on); its text is the label history and notes use. The reader hears the round
   * once, with the stage that opens it.
   */
  beginAutoRound(
    round: number,
    maxRounds: number,
    remaining: string,
    origin: MapChatOrigin,
    partial?: { failed: number; succeeded: number }
  ): MapChatTurnHandle {
    this.chainRound = round;
    this.chainMax = maxRounds;
    const handle = this.begin(t("ui.map_chat_role_auto"), origin, true, "preparing", true, {
      round,
      maxRounds,
      remaining,
      ...(partial ? { partial } : {})
    });
    if (this.built && this.stage)
      this.liveEl.setText(`${t("ui.map_chat_auto_round_0_1", round, maxRounds)}. ${this.stageLabel(this.stage.kind)}`);
    return handle;
  }
  /**
   * The chain waits for the research and expands it started (null: it does not). The row under the last reply says how far they are
   * and what is left; the field takes a message (sending takes over) and Stop ends the wait and the work. The reader hears the wait
   * once when it begins; the seconds are never read.
   */
  setChainWaiting(state: MapChatChainWaiting | null, remaining = ""): void {
    const was = this.chainWaitingState !== null;
    this.chainWaitingState = state ? { ...state, kinds: [...state.kinds] } : null;
    this.chainWaitingLeft = state ? remaining : "";
    if (state && !was) {
      this.chainWaitingSince = this.clockNow();
      this.startWaitTimer();
    } else if (!state) this.stopWaitTimer();
    this.renderLog();
    this.paintWait();
    this.renderBusy();
    if (state && !was) this.announce(t("ui.map_chat_chain_wait_live_0", this.waitWord(state)));
  }
  /** What the chain waits for now, or null. */
  get chainWaiting(): MapChatChainWaiting | null {
    return this.chainWaitingState;
  }
  private waitWord(state: MapChatChainWaiting): string {
    const research = state.kinds.includes("research");
    const expand = state.kinds.includes("expand");
    return t(
      research && expand
        ? "ui.map_chat_chain_kind_both"
        : expand
          ? "ui.map_chat_chain_kind_expand"
          : "ui.map_chat_chain_kind_research"
    );
  }
  private startWaitTimer(): void {
    if (!this.built || this.chainWaitingTimer) return;
    const win =
      this.logEl.win ?? this.logEl.ownerDocument?.defaultView ?? (typeof window !== "undefined" ? window : undefined);
    if (typeof win?.setInterval !== "function") return;
    const id = win.setInterval(() => this.paintWait(), 1000);
    this.chainWaitingTimer = { cancel: () => win.clearInterval?.(id) };
  }
  private stopWaitTimer(): void {
    this.chainWaitingTimer?.cancel();
    this.chainWaitingTimer = null;
    this.chainWaitingEls = null;
  }
  /** Rewrites the two texts of the waiting row that is on screen (never the row). */
  private paintWait(): void {
    const els = this.chainWaitingEls;
    const state = this.chainWaitingState;
    if (!els || !state) return;
    // The label sits in a live region: rewriting the same text every second can be read out again, so only a change is written.
    const label = t("ui.map_chat_chain_wait_label_0_1_2", this.waitWord(state), state.settled, state.total);
    if (els.label.textContent !== label) els.label.setText(label);
    const seconds = Math.max(0, Math.round((this.clockNow() - this.chainWaitingSince) / 1000));
    els.elapsed.setText(
      t("ui.map_chat_stage_elapsed_0", `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`)
    );
  }
  /**
   * The continuation ended for a reason other than a quiet "done" after one round: a sentence under the last reply says why and,
   * where it applies, what was left. "Done" is told only for a chain of two rounds or more. A map change says nothing (the
   * conversation goes with it).
   */
  endChain(reason: MapChatChainEndReason, remaining: string, details?: string[]): void {
    const was = this.chainWaitingState !== null;
    this.chainWaitingState = null;
    this.chainWaitingLeft = "";
    this.stopWaitTimer();
    const last = this.messages.at(-1);
    if (reason === "map_changed" || !last || last.role !== "assistant") {
      if (was) {
        this.renderLog();
        this.renderBusy();
      }
      return;
    }
    const text = this.chainEndText(reason, remaining, details, last);
    last.chainNote = { reason, text };
    this.renderLog();
    this.renderBusy();
    this.announce(text);
    if (reason !== "stopped" && reason !== "user_took_over" && reason !== "plan_cancelled") this.markUnread();
  }
  /** Sentences joined: a space between Latin sentences, none after a Chinese full stop. */
  private joinSentences(...parts: string[]): string {
    return parts
      .filter(Boolean)
      .reduce(
        (out, part) =>
          !out ? part : /[\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]$/.test(out) ? out + part : `${out} ${part}`,
        ""
      );
  }
  private chainEndText(
    reason: MapChatChainEndReason,
    remaining: string,
    details: string[] | undefined,
    last: MapChatMessage,
    round = this.chainRound,
    restored = false
  ): string {
    // One sentence's tail is cut so a model's "..." or full stop does not double the one the template ends with.
    const bare = (value: string): string => clip(value, 200).replace(/[\s.。!！?？…]+$/u, "");
    const left = remaining.trim() ? t("ui.map_chat_chain_left_end_0", bare(remaining)) : "";
    const why = (details ?? []).length
      ? t(
          "ui.map_chat_chain_reason_0",
          bare(
            (details ?? [])
              .slice(0, 3)
              .map(item => clip(item, 120))
              .join(t("ui.map_chat_chain_detail_separator"))
          )
        )
      : "";
    const say = (key: Parameters<typeof t>[0], ...values: unknown[]): string => t(key, ...values);
    switch (reason) {
      case "done":
        return say("ui.map_chat_chain_end_done_0", round);
      case "no_progress":
        return this.joinSentences(say("ui.map_chat_chain_end_no_progress"), left);
      case "max_rounds":
        return this.joinSentences(
          say("ui.map_chat_chain_end_max_rounds_0", this.chainMax),
          left,
          say("ui.map_chat_chain_end_max_rounds_more")
        );
      case "research_failed":
        return this.joinSentences(say("ui.map_chat_chain_end_research_failed"), why);
      case "stopped":
        return say("ui.map_chat_chain_end_stopped");
      case "user_took_over":
        return say("ui.map_chat_chain_end_user_took_over");
      case "research_stopped":
        return this.joinSentences(say("ui.map_chat_chain_end_research_stopped"), left);
      case "research_not_started":
        return this.joinSentences(say("ui.map_chat_chain_end_research_not_started"), why);
      case "wait_timeout":
        return say("ui.map_chat_chain_end_wait_timeout_0", Math.round(MAP_CHAT_CHAIN_WAIT_MS / 60000));
      case "other_background_work":
        return this.joinSentences(say("ui.map_chat_chain_end_other_background"), left);
      case "not_ready":
        return this.joinSentences(say("ui.map_chat_chain_end_not_ready"), left);
      case "plan_cancelled":
        return this.joinSentences(say("ui.map_chat_chain_end_plan_cancelled"), left);
      case "failed":
        // The retry sentence only where the failed round is still there with its button (a round that never went out is taken back).
        return this.joinSentences(
          say("ui.map_chat_chain_end_failed_0", round),
          !restored && this.canRetry(last, this.messages[this.messages.indexOf(last) - 1])
            ? say("ui.map_chat_chain_end_failed_retry")
            : ""
        );
      case "map_changed":
        return "";
    }
  }
  /**
   * Research notes of this conversation the round did not read (they did not fit, or are too long to ever be read): one line each
   * under the results. Only the newest reply carries them; they are not saved.
   */
  setUnreadNotes(turn: MapChatTurnHandle, items: { title: string; oversize: boolean }[]): void {
    if (!this.hasTurn(turn)) return;
    if (items.length) turn.assistant.unread = items.map(item => ({ title: item.title, oversize: item.oversize }));
    else delete turn.assistant.unread;
    this.renderLog();
  }
  /** Follow-ups of the latest question wait for the turn to end (a continuation hands over to them). */
  hasQueuedSteers(): boolean {
    return this.lastQuestion()?.steers?.some(steer => steer.state === "queued") ?? false;
  }
  /** Whether the messages of `turn` are still in the conversation (a reset, such as a map switch, takes them away). */
  hasTurn(turn: MapChatTurnHandle): boolean {
    return this.messages.includes(turn.user) && this.messages.includes(turn.assistant);
  }
  /**
   * The turn never reached the model: both of its messages are taken away as if it had not been sent, the choices it retired
   * open again, the busy state and the stage end, and `draft` goes back into the message field (in front of what was typed
   * meanwhile). Returns false, and changes nothing, when the turn is no longer there (a reset already took it).
   */
  retract(turn: MapChatTurnHandle, draft?: string): boolean {
    if (!this.hasTurn(turn)) return false;
    this.messages = this.messages.filter(message => message !== turn.user && message !== turn.assistant);
    for (const choices of turn.retired) choices.picked = false;
    // Follow-ups typed while the request was still being prepared go back to the field after the question.
    const steered = (turn.user.steers ?? []).map(steer => steer.text);
    if (steered.length) draft = [draft, ...steered].filter(Boolean).join("\n");
    this.cancelFrame();
    this.busy = false;
    this.clearStage();
    if (this.built) {
      if (draft) {
        const typed = this.inputEl.value;
        this.inputEl.value = typed.trim() ? `${draft}\n${typed}` : draft;
      }
      // The stage name that was said is withdrawn: nothing happened.
      this.liveEl.setText("");
    }
    this.renderLog();
    this.renderBusy();
    this.renderHint();
    this.host.stateChanged?.();
    return true;
  }
  /** The latest question: where follow-ups attach. */
  private lastQuestion(): MapChatMessage | null {
    for (let at = this.messages.length - 1; at >= 0; at--)
      if (this.messages[at].role === "user") return this.messages[at];
    return null;
  }
  /** A follow-up typed while the turn works: it joins the latest question (under it, above the answer) and the field empties. */
  addSteer(text: string, state: MapChatSteer["state"]): MapChatSteer | null {
    const question = this.lastQuestion();
    if (!question || !text.trim()) return null;
    const steer: MapChatSteer = { text, state };
    (question.steers ??= []).push(steer);
    if (this.built) this.inputEl.value = "";
    this.renderLog(true);
    this.renderBusy();
    this.announce(t(state === "live" ? "ui.map_chat_steer_sent" : "ui.map_chat_steer_queued_announce"));
    return steer;
  }
  /** A follow-up that could not go into the running turn waits for the turn to end (`speak` false: no announcement). */
  setSteerState(steer: MapChatSteer, state: MapChatSteer["state"], speak = true): void {
    if (steer.state === state) return;
    steer.state = state;
    this.renderLog();
    if (speak && state === "queued") this.announce(t("ui.map_chat_steer_queued_announce"));
  }
  /** Removes the queued follow-ups of the latest question and returns their texts, oldest first. */
  takeQueued(): string[] {
    const question = this.lastQuestion();
    if (!question?.steers?.some(steer => steer.state === "queued")) return [];
    const taken = question.steers.filter(steer => steer.state === "queued");
    question.steers = question.steers.filter(steer => steer.state !== "queued");
    if (!question.steers.length) delete question.steers;
    this.renderLog();
    return taken.map(steer => steer.text);
  }
  /** The texts of the follow-ups of the latest question that went into the turn, oldest first. */
  takeSteerTexts(): string[] {
    return (this.lastQuestion()?.steers ?? []).filter(steer => steer.state === "live").map(steer => steer.text);
  }
  /** Puts texts back into the field, in front of what was typed meanwhile. */
  restoreDraft(texts: string[]): void {
    if (!this.built || !texts.length) return;
    const typed = this.inputEl.value;
    this.inputEl.value = [...texts, ...(typed.trim() ? [typed] : [])].join("\n");
    this.renderHint();
  }
  private clockNow(): number {
    return this.host.now?.() ?? Date.now();
  }
  /**
   * The turn moved on to a later stage (a model event, or its actions are being applied). A stage never goes back, an event
   * that arrives with no turn running changes nothing, and the new name is said once through the live region.
   */
  setStage(kind: MapChatStage): void {
    const current = this.stage;
    if (!current || STAGE_ORDER[kind] <= STAGE_ORDER[current.kind]) return;
    // A later stage is a model event (or the actions): the slow notice has nothing left to say.
    this.slow = null;
    // The seconds of waiting and writing run together from the question; applying counts its own, and so does the model's work
    // after the usage notice (the time the user took to answer it is not the model's).
    const fresh = kind === "applying" || current.kind === "consent";
    this.stage = { kind, since: fresh ? this.clockNow() : current.since };
    this.paintStage();
    this.speakStage();
    // Entering or leaving "consent" changes whether Stop is offered and what an empty canvas says.
    if (kind === "consent") this.renderBusy();
    else if (current.kind === "consent") {
      this.renderBusy();
      this.keepFocusAfterConsent();
    }
  }
  /** Stop was hidden while the usage notice was open, so closing the notice left Obsidian nothing to give focus back to (C-#14). */
  private keepFocusAfterConsent(): void {
    if (!this.built || !this.focusFree()) return;
    if (!this.stopEl.hidden) this.stopEl.focus();
    else {
      this.stopWanted = true;
      this.inputEl.focus();
    }
  }
  /** True when the keyboard is lost (nothing, the page body, a removed element) or still in the chat; never when it is somewhere else. */
  private focusFree(): boolean {
    const active = this.host.activeElement();
    if (!active || (active as HTMLElement).tagName === "BODY" || this.el.contains(active)) return true;
    return (active as HTMLElement).isConnected === false;
  }
  /** The model name written above a reply: the current model's menu name, or "" when there is none (the row then says "AI"). */
  private replyModelLabel(): string {
    const id = this.host.model();
    if (!id) return "";
    return (this.host.modelName?.(id) ?? this.currentModelLabel()).trim();
  }
  private currentModelLabel(): string {
    const model = this.host.model();
    return this.host.modelChoices().find(choice => choice.value === model)?.label ?? model;
  }
  /** The stage name, with the model that does the work after it; applying a plan is local work and names none. */
  private stageLabel(kind: MapChatStage): string {
    const name = t(`ui.map_chat_stage_${kind}`);
    return kind === "applying" || kind === "consent" || !this.stageModel
      ? name
      : t("ui.progress_stage_with_model_0_1", name, this.stageModel);
  }
  private elapsedText(): string {
    const seconds = this.stage ? Math.max(0, Math.round((this.clockNow() - this.stage.since) / 1000)) : 0;
    return t("ui.map_chat_stage_elapsed_0", `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`);
  }
  /** The stage line lives in the last AI message while a turn runs, or while its plan is being applied. */
  private stageMessage(): MapChatMessage | null {
    if (!this.stage) return null;
    const last = this.messages.at(-1);
    return last?.role === "assistant" ? last : null;
  }
  /** Rewrites the texts of the stage line that is on screen (never the row), and shrinks it once the reply has text. */
  private paintStage(): void {
    const els = this.stageEls;
    const stage = this.stage;
    if (!els || !stage) return;
    els.label.setText(this.stageLabel(stage.kind));
    els.elapsed.setText(this.elapsedText());
    els.box.toggleClass("is-compact", !!this.stageMessage()?.text);
    this.paintSlow();
  }
  /** Shows or removes the slow notice inside the stage line (a rebuilt row calls this too, so the notice survives a repaint). */
  private paintSlow(): void {
    const els = this.stageEls;
    if (!els) return;
    const slow = this.stage ? this.slow : null;
    if (!slow) {
      els.slow?.remove();
      els.slow = null;
      return;
    }
    if (els.slow) {
      // Already on screen for this notice.
      return;
    }
    const notice = els.box.createDiv({ cls: "vam-map-chat-progress-slow" });
    notice.createSpan({ cls: "vam-map-chat-progress-slow-text", text: slow.text });
    const button = notice.createEl("button", {
      cls: "vam-map-chat-progress-resend",
      text: t("ui.map_chat_resend"),
      attr: { type: "button" }
    });
    button.addEventListener("click", () => {
      this.slow?.resend();
      // The button leaves with the notice, and the focus would fall to the page: it goes to Stop, the one control of a waiting turn.
      if (this.built && this.stage) this.stopEl.focus();
    });
    els.slow = notice;
  }
  /** Whether the slow notice is showing. */
  get isSlow(): boolean {
    return this.slow !== null;
  }
  /**
   * No model event for a long while: the bubble says so (`text`) and offers `resend`. Only while the turn is still waiting for the
   * model; the notice is said once through the live region. Anything that is a model event removes it ({@link clearSlow}).
   */
  showSlow(text: string, resend: () => void): void {
    if (this.stage?.kind !== "waiting" || this.slow) return;
    this.slow = { text, resend };
    this.paintSlow();
    if (this.built) this.liveEl.setText(text);
  }
  /** A model event arrived (or the notice is not valid any more): the slow notice goes away. */
  clearSlow(): void {
    if (!this.slow) return;
    this.slow = null;
    this.paintSlow();
  }
  /**
   * The user sent the same question again: the stage goes back to "waiting" with the seconds counted from now, the notice goes away
   * and whatever the replaced attempt had written is dropped. A turn that is not running changes nothing.
   */
  restartWaiting(): void {
    const last = this.messages.at(-1);
    if (!this.stage || !last?.streaming) return;
    this.slow = null;
    this.stage = { kind: "waiting", since: this.clockNow() };
    last.text = "";
    last.lines = [];
    this.cancelFrame();
    // The row is laid out again so the stage line is the big form of an empty bubble.
    this.renderLog();
    this.paintStage();
    this.speakStage();
  }
  private speakStage(): void {
    // Straight to the live region: `announce` would also read out what a picture search held back.
    if (this.built && this.stage) this.liveEl.setText(this.stageLabel(this.stage.kind));
  }
  private startStageTimer(): void {
    if (!this.built || this.stageTimer) return;
    const win =
      this.logEl.win ?? this.logEl.ownerDocument?.defaultView ?? (typeof window !== "undefined" ? window : undefined);
    if (typeof win?.setInterval !== "function") return;
    const id = win.setInterval(() => this.stageEls?.elapsed.setText(this.elapsedText()), 1000);
    this.stageTimer = { cancel: () => win.clearInterval?.(id) };
  }
  /** The turn ended (an answer, a failure, Stop, a reset): no stage, no seconds, no timer. */
  private clearStage(): void {
    this.stage = null;
    this.slow = null;
    this.stageEls = null;
    this.stageTimer?.cancel();
    this.stageTimer = null;
  }
  /** Every list of choices already shown stops working (a pick was made, or a newer message came). */
  private retireChoices(except?: MapChatChoices): void {
    for (const message of this.messages)
      if (message.choices && message.choices !== except) message.choices.picked = true;
  }
  /** A confirmed plan is being applied (true) or is done (false). */
  setApplying(on: boolean): void {
    if (this.applying === on) return;
    this.applying = on;
    if (on) {
      // The plan's reply is finished already, so its message has no stage of its own: this one belongs to the apply.
      this.stage = { kind: "applying", since: this.clockNow() };
    } else this.clearStage();
    this.renderLog();
    this.renderBusy();
    if (on) {
      this.startStageTimer();
      this.speakStage();
    }
  }
  /** The answer so far (the whole text, not a delta). */
  streamReply(text: string): void {
    const last = this.messages.at(-1);
    if (!last || !last.streaming) return;
    last.text = text;
    // The first characters are the proof that the model is writing.
    if (text && this.stage?.kind === "waiting") this.setStage("writing");
    else if (text) this.clearSlow();
    if (!this.built || this.frame) return;
    // Chunks that arrive within one frame are laid out once, with the newest text.
    // The window the log is shown in (a popped-out view has its own), because only that one paints its frames.
    const win =
      this.logEl.win ?? this.logEl.ownerDocument?.defaultView ?? (typeof window !== "undefined" ? window : undefined);
    if (typeof win?.requestAnimationFrame !== "function") {
      this.layoutStreaming();
      return;
    }
    const id = win.requestAnimationFrame(() => {
      this.frame = null;
      this.layoutStreaming();
    });
    this.frame = { cancel: () => win.cancelAnimationFrame?.(id) };
  }
  /** Lays the streaming message out with the text it has now; no other message is touched. */
  private layoutStreaming(): void {
    const last = this.messages.at(-1);
    const entry = last ? this.rows.get(last) : undefined;
    if (!last || !last.streaming || !entry) return;
    const stick = this.atEnd();
    renderChatMarkdown(entry.body, last.text, t("ui.map_chat_overflow_note"));
    // The stage line shrinks to a small line below the text once there is text.
    this.stageEls?.box.toggleClass("is-compact", !!last.text);
    entry.key = this.rowKey(last);
    if (stick) this.scrollToEnd();
  }
  private cancelFrame(): void {
    this.frame?.cancel();
    this.frame = null;
  }
  /** The turn ended with an answer and the outcome of each action. */
  finish(reply: string, lines: MapChatLine[]): MapChatLine[] {
    const last = this.messages.at(-1);
    // Expansions that failed while the reply was still being applied are settled into its lines here, so the finish does not
    // paint them back as started. The merged lines are returned for the record.
    let shown = lines;
    if (last?.streaming) {
      shown = onceImageLines(last.lateFailures?.length ? settleExpandFailures(lines, last.lateFailures) : lines);
      last.lateFailures = undefined;
      last.text = reply;
      last.lines = shown;
      last.streaming = false;
    }
    this.busy = false;
    this.clearStage();
    this.renderLog();
    this.renderBusy();
    // The one thing a screen reader hears of the turn: the log itself is silent while the reply streams.
    this.announce(this.spokenTurn(reply, shown));
    this.markUnread();
    return shown;
  }
  /** The turn ended without an answer. */
  fail(text: string, announce?: string, technical?: string): void {
    const last = this.messages.at(-1);
    if (last?.streaming) {
      last.text = text;
      last.error = true;
      last.technical = technical || undefined;
      last.streaming = false;
    }
    this.busy = false;
    this.clearStage();
    this.renderLog();
    this.renderBusy();
    // `announce` is the whole sentence when `text` already says that the chat failed; it is never prefixed twice.
    this.announce(announce !== undefined ? clip(announce, 160) : t("ui.map_chat_live_failed_0", clip(text, 160)));
    this.markUnread();
  }
  /** The user stopped the turn: whatever text arrived stays, marked as stopped. */
  markStopped(): void {
    const last = this.messages.at(-1);
    if (last?.streaming) {
      if (last.text.trim()) last.lines.push({ status: "skipped", text: t("ui.map_chat_stopped") });
      else {
        last.text = t("ui.map_chat_stopped");
        last.error = true;
      }
      last.streaming = false;
    }
    this.busy = false;
    this.clearStage();
    this.renderLog();
    this.renderBusy();
    this.announce(t("ui.map_chat_stopped"));
  }
  /** The reply just finished needs the user's yes: shows the plan card on its message. */
  showPlan(plan: MapChatPlanCard): void {
    const last = this.messages.at(-1);
    if (!last || last.role !== "assistant") return;
    last.plan = plan;
    this.renderLog();
    this.renderHint();
    // The hint line change the log's height after it was laid out, so the end moved: a plan is
    // something to answer, so the card's buttons are brought into view now and again once the new height is final.
    this.scrollToEnd();
    this.scrollToEndWhenSettled();
    // A plan waits for an answer and nothing else tells a screen reader so: say the reply and the plan once.
    this.announce(
      `${t("ui.map_chat_live_done_0", clip(last.text, 160))} ${t(
        "ui.map_chat_live_plan_0",
        clip(plan.summary ?? t("ui.map_chat_plan_summary_0", plan.reasons.join(t("ui.map_chat_count_separator"))), 160)
      )}`
    );
    this.host.stateChanged?.();
  }
  /** The plan card still waiting for an answer, if any. */
  pendingPlan(): MapChatPlanCard | null {
    // A restored card (stale) never waits for an answer, even when it shows the state it was left in.
    return this.messages.find(message => message.plan?.state === "pending" && !message.plan.stale)?.plan ?? null;
  }
  /** A plan was applied or cancelled: its buttons stop working; `lines` (the result of applying) join its message. */
  settlePlan(plan: MapChatPlanCard, state: "applied" | "cancelled", lines?: MapChatLine[]): MapChatLine[] | undefined {
    const message = this.messages.find(item => item.plan === plan);
    if (!message) return lines;
    // Applying folds the card back to one sentence, also when "View details" was opened while it waited (the lines come in a second call; it keeps what the reader opened by then).
    if (state === "applied" && plan.state !== "applied") message.linesOpen = false;
    plan.state = state;
    // An applied plan without lines yet is being applied: expansion failures that come in meanwhile wait (like a streaming reply's)
    // and are settled into the result lines when they arrive, so they are not written over. The merged lines are returned.
    if (state === "applied" && !lines) message.lateFailures = [];
    else if (lines) {
      lines = message.lateFailures?.length ? settleExpandFailures(lines, message.lateFailures) : lines;
      message.lateFailures = undefined;
    } else message.lateFailures = undefined;
    if (lines) lines = message.lines = onceImageLines(lines);
    this.renderLog();
    this.renderHint();
    this.host.stateChanged?.();
    // The results of an applied plan arrive well after the reply: say them once, like the results of a reply.
    if (lines?.length)
      this.announce(t("ui.map_chat_live_results_0", this.countsText(countChatLines(lines, chatNoteTexts()))));
    return lines;
  }
  /** Offers a short list to pick from under the last answer. */
  showChoices(choices: MapChatChoices): void {
    const last = this.messages.at(-1);
    if (!last || last.role !== "assistant") return;
    this.retireChoices();
    last.choices = choices;
    this.renderLog();
  }
  /** Adds result lines to the last answer (after something that happened later, such as a picked map). */
  appendLines(lines: MapChatLine[]): void {
    const last = this.messages.at(-1);
    if (!last || last.role !== "assistant") return;
    if (last.streaming || last.lateFailures) {
      last.lateFailures = [...(last.lateFailures ?? []), ...lines.map(failure => ({ was: null, next: null, failure }))];
      return;
    }
    last.lines = onceImageLines([...last.lines, ...lines]);
    this.renderLog();
  }
  /**
   * An expansion that started with the last reply failed. The basis of its start line no longer counts that card: `next` is the
   * basis of the cards still expanding, or null when none is left, and then the failure takes the place of the start line (no
   * "done" line and no basis for work that built nothing). Without a start line to find, the failure is just added.
   */
  settleExpandFailure(was: MapChatBasis, next: MapChatBasis | null, failure: MapChatLine): MapChatBasis | null {
    const last = this.messages.at(-1);
    if (!last || last.role !== "assistant") return was;
    // The reply is still being applied: its lines do not exist yet. The failure waits for `finish`.
    if (last.streaming || last.lateFailures) {
      last.lateFailures = [...(last.lateFailures ?? []), { was, next, failure }];
      return next;
    }
    const at = last.lines.findIndex(line => line.basis === was);
    last.lines = settleExpandFailures(last.lines, [{ was, next, failure }]);
    this.renderLog();
    return at >= 0 ? next : was;
  }
  /** A picture search starts under the last answer. The block is shown at once and changes with {@link settleImages}. */
  addImages(block: MapChatImages): void {
    const last = this.messages.at(-1);
    if (!last || last.role !== "assistant") return;
    last.images = [...(last.images ?? []), block];
    this.renderLog();
  }
  /**
   * A picture search ended (or was stopped): the block takes `patch` and its row is laid out again. The keyboard stays where it
   * is, and the reader hears one sentence (after the reply that is streaming now, if one is).
   */
  settleImages(block: MapChatImages, patch: Partial<Pick<MapChatImages, "state" | "reason" | "items">>): void {
    const message = this.messages.find(candidate => candidate.images?.includes(block));
    if (!message) return;
    Object.assign(block, patch);
    if (block.state !== "searching") block.stop = undefined;
    this.renderLog();
    // One sentence for the whole group, once its last search has ended (a sentence per card would flood the reader).
    if (block.state === "searching" || (message.images ?? []).some(other => other.state === "searching")) return;
    const placed = (message.images ?? []).filter(other => placedImage(other)).length;
    const missed = (message.images ?? []).length - placed;
    this.announceImages(
      missed ? t("ui.map_chat_images_summary_0_1", placed, missed) : t("ui.map_chat_images_summary_0", placed)
    );
  }
  /** A queued search got a free place and starts: its row says so. */
  markImagesRunning(block: MapChatImages): void {
    if (!this.messages.some(message => message.images?.includes(block))) return;
    block.running = true;
    this.renderLog();
  }
  /** Back to an empty conversation (a different map was opened). */
  reset(): void {
    this.cancelFrame();
    this.rows = new WeakMap();
    this.messages = [];
    this.savedTurnCount = 0;
    this.conversationId = null;
    this.restoredText = "";
    this.spokenLater = [];
    this.chips = [];
    this.dismissedNote = null;
    this.noteChip = null;
    this.busy = false;
    this.applying = false;
    this.chainWaitingState = null;
    this.chainWaitingLeft = "";
    this.stopWaitTimer();
    this.chainRound = 1;
    this.chainMax = MAP_CHAT_CHAIN_MAX_ROUNDS;
    this.clearStage();
    this.unread = false;
    // A stage name said for the turn that is gone must not stay in the live region.
    if (this.built) this.liveEl.setText("");
    if (this.built) this.inputEl.value = "";
    this.renderLog();
    this.renderChips();
    this.renderBusy();
    this.renderHint();
    this.applyOpen();
    this.host.stateChanged?.();
  }
  focusInput(): void {
    if (this.built) this.inputEl.focus();
  }
  /**
   * Shows a saved conversation again: its finished turns (their words go through the same reply renderer as live ones), with a
   * line on top saying when it was. Plan cards, picture candidates, retry and option lists are shown as no longer valid.
   */
  restore(conversation: MapChatRestoredConversation): void {
    if (this.working) return;
    // Only the messages are replaced: the draft and the references the user added while the record was read stay.
    this.cancelFrame();
    this.rows = new WeakMap();
    this.messages = [];
    this.savedTurnCount = 0;
    this.restoredText = "";
    this.spokenLater = [];
    this.unread = false;
    this.chainWaitingState = null;
    this.stopWaitTimer();
    this.conversationId = conversation.id;
    for (const turn of conversation.turns) {
      const question: MapChatMessage = {
        role: "user",
        text: turn.auto ? t("ui.map_chat_role_auto") : turn.message,
        lines: [],
        // The round is known when the record has it; what was left of that round is not kept, so the separator names the round only.
        ...(turn.auto
          ? {
              auto: true as const,
              autoInfo: {
                ...(Number.isInteger(turn.round) && turn.round! >= 2 ? { round: turn.round } : {}),
                maxRounds: MAP_CHAT_CHAIN_MAX_ROUNDS,
                ...(turn.remaining?.trim() ? { remaining: turn.remaining } : {})
              }
            }
          : {})
      };
      if (turn.steers?.length) question.steers = turn.steers.map((text): MapChatSteer => ({ text, state: "live" }));
      this.messages.push(question);
      const answer: MapChatMessage = {
        role: "assistant",
        text: turn.reply,
        lines: turn.lines.map((line): MapChatLine => ({
          status: line.status === "skipped" || line.status === "failed" ? line.status : "done",
          text: line.text,
          ...(line.basis ? { basis: line.basis } : {})
        })),
        modelLabel: turn.modelLabel || undefined,
        stale: true
      };
      if (turn.stalePlan) {
        // What the plan was left as: waiting (no plan line), cancelled, or applied (stopped midway counts) with its result lines.
        if (turn.planState && turn.planState !== "cancelled" && turn.planLines?.length)
          answer.lines = [
            ...answer.lines,
            ...turn.planLines.map((line): MapChatLine => ({
              status: line.status === "skipped" || line.status === "failed" ? line.status : "done",
              text: line.text,
              ...(line.basis ? { basis: line.basis } : {})
            }))
          ];
        answer.plan = {
          reasons: [],
          items: [],
          estimate: "",
          state: !turn.planState ? "pending" : turn.planState === "cancelled" ? "cancelled" : "applied",
          stale: true,
          apply() {},
          cancel() {}
        };
      }
      if (turn.images) {
        const states = ["ready", "empty", "failed", "stopped"] as const;
        const state = states.find(name => name === turn.images!.state) ?? "stopped";
        answer.images = [
          {
            query: "",
            nodeId: "",
            nodeTitle: "",
            mapPath: "",
            mapId: "",
            state,
            stale: true,
            items: turn.images.items.map((item, index) => ({
              candidate: { title: item.title, url: "", source: item.sourceUrl },
              inserted: turn.images!.inserted.includes(index) ? item.title : undefined
            }))
          }
        ];
      }
      // The end sentence of the continuation that ended here (display only: nothing is resumed). Only a known reason gets one,
      // and `done` only after two rounds or more, like the live panel.
      const end = turn.chainEnd;
      if (end && end.reason !== "map_changed" && (end.reason !== "done" || end.round >= 2)) {
        const text = this.chainEndText(end.reason, end.remaining, undefined, answer, end.round, true);
        if (text) answer.chainNote = { reason: end.reason, text };
      }
      this.messages.push(answer);
    }
    const when = conversation.restoredAt ? new Date(conversation.restoredAt) : null;
    if (when && Number.isFinite(when.getTime()) && conversation.turns.length) {
      const pad = (value: number): string => String(value).padStart(2, "0");
      this.restoredText = t(
        "ui.map_chat_restored_0",
        `${when.getMonth() + 1}/${when.getDate()} ${pad(when.getHours())}:${pad(when.getMinutes())}`
      );
    }
    this.renderLog(true);
    this.refreshNote();
    this.renderHint();
    this.host.stateChanged?.();
  }
  /** "New conversation": clears the panel and tells the view to start a new record. Nothing happens while a turn runs (Stop first). */
  private startNewConversation(): void {
    if (this.working) return;
    this.reset();
    this.host.newConversation?.();
    this.focusInput();
  }

  // ---- DOM ------------------------------------------------------------------------------------------------------

  private build(parent: HTMLElement): void {
    this.built = true;
    this.el = parent.createDiv({ cls: "vam-map-chat" });
    this.toggleEl = this.el.createEl("button", {
      cls: "vam-map-chat-toggle",
      attr: { "aria-label": t("ui.map_chat_open"), "aria-expanded": "false", "aria-controls": this.id }
    });
    setIcon(this.toggleEl.createSpan("vam-map-chat-toggle-icon"), "message-square");
    this.badgeEl = this.toggleEl.createSpan({ cls: "vam-map-chat-unread", attr: { "aria-hidden": "true" } });
    this.badgeEl.hidden = true;
    this.toggleEl.addEventListener("click", () => this.setOpen(true, true));
    this.bodyEl = this.el.createDiv({
      cls: "vam-map-chat-body",
      attr: { id: this.id, role: "region", "aria-label": t("ui.map_chat_title") }
    });
    // Top strip: only the quiet icons (new conversation, save, close). The model menu lives in the message box.
    this.headEl = this.bodyEl.createDiv("vam-map-chat-head");
    this.saveEl = this.headEl.createEl("button", {
      cls: "vam-map-chat-save clickable-icon",
      attr: { type: "button", "aria-label": t("ui.map_chat_save"), title: t("ui.map_chat_save") }
    });
    setIcon(this.saveEl, "file-down");
    this.saveEl.addEventListener("click", () => void this.saveNote());
    const close = (this.closeEl = this.headEl.createEl("button", {
      cls: "vam-map-chat-close clickable-icon",
      attr: { "aria-label": t("ui.map_chat_close") }
    }));
    setIcon(close, "x");
    close.addEventListener("click", () => this.setOpen(false, true));
    this.heroTitleEl = this.bodyEl.createDiv({
      cls: "vam-map-chat-hero-title",
      text: t("ui.map_chat_hero_title"),
      attr: { role: "heading", "aria-level": "2" }
    });
    // A map that has content opens the window onto an empty log: one line says what it is for.
    // A dashed box with a faint chat icon; the words stay for screen readers only.
    this.guideEl = this.bodyEl.createDiv("vam-map-chat-guide");
    this.guideIconEl = this.guideEl.createSpan({ cls: "vam-map-chat-guide-icon", attr: { "aria-hidden": "true" } });
    setIcon(this.guideIconEl, "message-square");
    this.guideTextEl = this.guideEl.createSpan({ cls: "vam-sr-only", text: t("ui.map_chat_empty_log") });
    this.restoredEl = this.bodyEl.createDiv({ cls: "vam-map-chat-restored" });
    this.restoredEl.hidden = true;
    // The log is not a live region: a streaming reply would be read out word by word. `liveEl` says each progress stage name once as it changes, then the whole turn once when it ends.
    // Not `aria-label`: Obsidian shows an aria-label as a hover tooltip, and this one would cover the chips below the log.
    const logLabelId = `${this.id}-log-label`;
    this.logLabelEl = this.bodyEl.createSpan({
      cls: "vam-map-chat-log-label",
      text: t("ui.map_chat_log_label"),
      attr: { id: logLabelId }
    });
    this.logEl = this.bodyEl.createDiv({
      cls: "vam-map-chat-log",
      attr: { role: "group", "aria-labelledby": logLabelId, tabindex: "0" }
    });
    // A [[link]] in a reply is an internal link anchor; Obsidian's own handler is not attached to this panel, so open it here.
    const openInternal = (event: MouseEvent | KeyboardEvent, from: unknown): void => {
      const target = from as { closest?: (selector: string) => Element | null } | null;
      const anchor = target?.closest?.("a");
      if (!anchor?.classList.contains("internal-link")) return;
      const href = anchor.getAttribute("data-href");
      if (!href) return;
      event.preventDefault();
      this.host.openLink(href, Keymap.isModEvent(event));
    };
    this.logEl.addEventListener("click", event => openInternal(event, event.target));
    // The link has no href, so it is reached with Tab and opened with Enter.
    this.logEl.addEventListener("keydown", event => {
      if (event.key === "Enter") openInternal(event, event.target);
    });
    // Opening screen only: a secondary way in that needs no model. Tab order: the chips, the message field, the controls.
    this.emptyMapEl = this.bodyEl.createEl("button", {
      cls: "vam-map-chat-empty-map",
      text: t("ui.create_an_empty_mind_map"),
      attr: { type: "button" }
    });
    this.emptyMapEl.hidden = true;
    this.emptyMapEl.addEventListener("click", () => this.host.createEmptyMap?.());
    this.chipsEl = this.bodyEl.createDiv({
      cls: "vam-map-chat-chips",
      attr: { role: "group", "aria-label": t("ui.map_chat_references") }
    });
    this.imageModeEl = this.bodyEl.createDiv({ cls: "vam-map-chat-image-mode" });
    this.imageModeEl.hidden = true;
    this.hintEl = this.bodyEl.createDiv({ cls: "vam-map-chat-plan-hint" });
    this.hintEl.hidden = true;
    this.statusEl = this.bodyEl.createDiv({ cls: "vam-map-chat-status", attr: { role: "status" } });
    const form = this.bodyEl.createDiv("vam-map-chat-form");
    // The send / stop key sits inside the message box, bottom right: one box, one key at a time (↵ when idle, ■ while working).
    const box = form.createDiv("vam-map-chat-composer");
    this.inputEl = box.createEl("textarea", {
      cls: "vam-map-chat-input",
      attr: { rows: "3", "aria-label": t("ui.map_chat_input_label"), placeholder: t("ui.map_chat_input_placeholder") }
    });
    // Second in the box, so Tab goes: the field, the model, Send. Plain text at the bottom left, beside the keys on the right.
    this.modelEl = box.createEl("select", {
      cls: "vam-map-chat-model dropdown",
      attr: { "aria-label": t("ui.map_chat_model_label") }
    });
    this.modelEl.addEventListener("change", () => {
      this.host.setModel(this.modelEl.value);
      this.refreshControls();
    });
    this.steerHintEl = box.createSpan({ cls: "vam-map-chat-steer-hint", attr: { id: "vam-map-chat-steer-hint" } });
    this.steerHintEl.hidden = true;
    this.sendEl = box.createEl("button", {
      cls: "vam-map-chat-send",
      attr: { type: "button", "aria-label": t("ui.map_chat_send") }
    });
    setIcon(this.sendEl, "corner-down-left");
    this.stopEl = box.createEl("button", {
      cls: "vam-map-chat-stop",
      attr: { type: "button", "aria-label": t("ui.map_chat_stop") }
    });
    setIcon(this.stopEl, "square");
    // The bottom strip is part of the box: pressing on its empty part (not on a control) puts the cursor in the field.
    box.addEventListener("click", event => {
      if (event.target === box) this.inputEl.focus();
    });
    this.sendEl.addEventListener("click", () => this.sendPressed());
    this.stopEl.addEventListener("click", () => this.host.stop());
    this.inputEl.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    this.inputEl.addEventListener("compositionend", () => {
      this.composing = false;
    });
    this.inputEl.addEventListener("keydown", event => this.onKey(event));
    this.inputEl.addEventListener("input", () => this.renderSteerHint());
    // The visible note can change without any event the view hears (a collapsed sidebar, say); focusing the field is the last look before typing.
    this.inputEl.addEventListener("focus", () => this.refreshNote());
    // Escape on any other control of the window folds it too (the message field handles its own, above).
    this.el.addEventListener("keydown", event => {
      const target = event.target as { tagName?: string } | null;
      if (event.key !== "Escape" || event.target === this.inputEl || target?.tagName === "SELECT") return;
      if (this.hero || event.isComposing) return;
      event.preventDefault();
      if (this.narrow) this.collapseOverlay(true);
      else this.setOpen(false, true);
    });
    this.resizerEl = this.el.createDiv({
      cls: "vam-map-chat-resizer",
      attr: {
        role: "separator",
        "aria-orientation": "vertical",
        "aria-label": t("ui.map_chat_width_label"),
        "aria-valuemin": String(MAP_CHAT_WIDTH_MIN),
        "aria-valuemax": String(MAP_CHAT_WIDTH_MAX),
        "aria-valuenow": String(this.width),
        tabindex: "0"
      }
    });
    this.resizerEl.addEventListener("keydown", event => this.onResizerKey(event));
    this.resizerEl.addEventListener("pointerdown", event => this.startResize(event));
    this.liveEl = this.el.createDiv({ cls: "vam-sr-only", attr: { "aria-live": "polite", "aria-atomic": "true" } });
    for (const name of ["dragenter", "dragover"] as const)
      this.el.addEventListener(name, event => this.onDragOver(event));
    this.el.addEventListener("dragleave", () => this.setDropHighlight(false));
    this.el.addEventListener("drop", event => this.onDrop(event));
    this.renderLog();
    this.renderBusy();
    this.stopWatching = this.host.watchModels(() => this.refreshControls());
    this.stopWatchingImage = this.host.watchImage?.(() => this.refreshImage()) ?? null;
    this.renderImageMode();
  }

  /**
   * The save button: hidden on the opening screen, and "disabled" (still reachable by keyboard, so its title can be read) while
   * there is no finished turn or the map has no folder to save into.
   */
  /** "New conversation" exists only while records are on; it waits (aria-disabled) while a turn runs. */
  refreshNewButton(): void {
    if (!this.built) return;
    const on = this.host.recordsEnabled?.() === true;
    if (!on) {
      this.newEl?.remove();
      this.newEl = null;
      return;
    }
    if (!this.newEl) {
      const label = t("ui.map_chat_new_conversation");
      const button = (this.newEl = this.headEl.createEl("button", {
        cls: "vam-map-chat-new clickable-icon",
        attr: { type: "button", "aria-label": label, title: label }
      }));
      setIcon(button, "square-pen");
      button.addEventListener("click", () => this.startNewConversation());
      button.remove();
      this.headEl.insertBefore(button, this.saveEl);
    }
    this.newEl.hidden = this.hero;
    this.newEl.toggleClass("is-hidden", this.hero);
    this.newEl.setAttr("aria-disabled", String(this.working));
    this.newEl.toggleClass("is-disabled", this.working);
    this.newEl.setAttr("aria-label", t("ui.map_chat_new_conversation"));
    this.newEl.setAttr("title", t("ui.map_chat_new_conversation"));
  }
  private refreshSave(): void {
    if (!this.built || !this.saveEl) return;
    this.saveEl.hidden = this.hero;
    this.saveEl.toggleClass("is-hidden", this.hero);
    this.refreshNewButton();
    let why = "";
    if (!this.completedTurns().length) why = t("ui.map_chat_save_empty");
    else if (!this.host.saveTranscript) why = t("ui.map_chat_save_unavailable");
    else {
      const can = this.host.canSave?.();
      if (can && !can.ok) why = can.reason;
    }
    const disabled = !!why || this.saving;
    this.saveDisabled = disabled;
    this.saveEl.setAttr("aria-disabled", String(disabled));
    this.saveEl.toggleClass("is-disabled", disabled);
    // Obsidian's hover tooltip reads aria-label, so the reason a disabled button is disabled goes there too.
    this.saveEl.setAttr("aria-label", why || t("ui.map_chat_save"));
    this.saveEl.setAttr("title", why || t("ui.map_chat_save"));
  }
  /**
   * The interface language changed: the fixed words of the window (title, buttons, labels, row labels) are set again in the
   * new language. Nothing is built again and the draft and the words of the messages stay as they are.
   */
  relabel(): void {
    if (!this.built) return;
    this.bodyEl.setAttr("aria-label", t("ui.map_chat_title"));
    this.modelEl.setAttr("aria-label", t("ui.map_chat_model_label"));
    this.closeEl.setAttr("aria-label", t("ui.map_chat_close"));
    this.heroTitleEl.setText(t("ui.map_chat_hero_title"));
    this.guideTextEl.setText(t("ui.map_chat_empty_log"));
    this.logLabelEl.setText(t("ui.map_chat_log_label"));
    this.emptyMapEl.setText(t("ui.create_an_empty_mind_map"));
    this.chipsEl.setAttr("aria-label", t("ui.map_chat_references"));
    this.inputEl.setAttr("aria-label", t("ui.map_chat_input_label"));
    this.renderPlaceholder();
    this.sendEl.setAttr("aria-label", t("ui.map_chat_send"));
    this.stopEl.setAttr("aria-label", t("ui.map_chat_stop"));
    this.resizerEl.setAttr("aria-label", t("ui.map_chat_width_label"));
    this.applyOpen();
    this.refreshControls();
    this.refreshSave();
    this.renderChips();
    this.renderBusy();
    // Rows are kept unless their key changed; the key holds the fixed words, so only rows with words to change are built again.
    this.renderLog();
  }
  /** Send was pressed: a hidden Send button, or a row that is rebuilt, must not leave the keyboard on the page. */
  private sendPressed(): void {
    this.handOffFocus(() => this.host.send());
  }
  /** Runs `start` (which begins a turn); if the keyboard was in the window and fell out of it, Stop (the one control of a waiting turn) takes it. */
  private handOffFocus(start: () => void): void {
    const inside = this.hasFocus();
    start();
    if (!inside || !this.working) return;
    const active = this.host.activeElement();
    // Gone, hidden (Send) or inert (the button of a row that waits for the turn) all mean the keyboard has nowhere to act.
    if (!active || !this.el.contains(active) || active === this.sendEl || (active as HTMLButtonElement).disabled)
      this.stopEl.focus();
  }
  private async saveNote(): Promise<void> {
    if (!this.built || this.saving || this.saveDisabled) return;
    const turns = this.completedTurns();
    if (!turns.length || !this.host.saveTranscript) return;
    this.saving = true;
    this.refreshSave();
    try {
      const result = await this.host.saveTranscript(turns);
      // The keyboard stays on the button; the reader is told once.
      if (result.ok) this.savedTurnCount = turns.length;
      this.announceImages(result.ok ? t("ui.map_chat_saved_0", result.path) : result.reason);
    } finally {
      this.saving = false;
      this.refreshSave();
    }
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key === "Escape" && !event.isComposing && !this.composing) {
      // On the opening screen there is no window to fold.
      if (this.hero) return;
      event.preventDefault();
      if (this.narrow) this.collapseOverlay(true);
      else this.setOpen(false, true);
      return;
    }
    // Enter sends, Shift+Enter breaks the line, and a key that confirms an IME candidate does neither.
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || this.composing) return;
    event.preventDefault();
    // While a turn works, Enter with text is a follow-up for it; without text it does nothing.
    if (this.working) {
      if (this.draft.trim()) this.host.steer?.();
      return;
    }
    this.host.send();
  }

  // ---- width ----------------------------------------------------------------------------------------------------

  /**
   * `from` is the set width and the shown width before this adjustment. A window the pane squeezed shows less than was set; a
   * widening that stays under the set width must not shrink the set width, so a width is written only when it is larger than
   * the set width or narrower than what was shown.
   */
  private resizeTo(
    width: number,
    commit: boolean,
    from: { set: number; shown: number } = { set: this.width, shown: this.shownWidth() }
  ): void {
    const next = clampMapChatWidth(width);
    const writes = next > from.set || next < from.shown;
    const widths = this.host.widths?.(next);
    if (widths) {
      this.dockedPx = widths.docked;
      this.overlayPx = widths.overlay;
    }
    if (writes) this.width = next;
    this.applyWidth();
    if (writes) this.host.setWidth?.(this.width, commit);
  }
  /** The width the window has on the page now: the set width, given way to when the pane has no room for it. */
  private shownWidth(): number {
    if (this.floating) return this.overlayPx ?? this.width;
    return this.dockedPx ?? this.width;
  }
  private applyWidth(): void {
    if (!this.built) return;
    this.el.style.width = this.docked || this.floating ? `${this.shownWidth()}px` : "";
    this.resizerEl.setAttr("aria-valuenow", String(this.shownWidth()));
  }
  private onResizerKey(event: KeyboardEvent): void {
    const to =
      event.key === "ArrowLeft"
        ? this.shownWidth() - MAP_CHAT_WIDTH_STEP
        : event.key === "ArrowRight"
          ? this.shownWidth() + MAP_CHAT_WIDTH_STEP
          : event.key === "Home"
            ? MAP_CHAT_WIDTH_MIN
            : event.key === "End"
              ? MAP_CHAT_WIDTH_MAX
              : null;
    if (to === null) return;
    event.preventDefault();
    this.resizeTo(to, true);
  }
  /**
   * Dragging the handle. The listeners sit on the page's document, not on the handle, so a repaint of the map in the middle
   * (which lifts the panel out and puts it back) does not break the drag. They are removed when the button is let go, when
   * the pointer capture is lost, and when the view closes.
   */
  private startResize(event: PointerEvent): void {
    if (event.button) return;
    this.stopResizing?.();
    const doc: Document | undefined = this.el.ownerDocument;
    if (!doc?.addEventListener) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this.shownWidth();
    const from = { set: this.width, shown: startWidth };
    const handle = this.resizerEl;
    const move = (next: PointerEvent): void => {
      if (next.buttons === 0) end();
      else this.resizeTo(startWidth + (next.clientX - startX), false, from);
    };
    const end = (): void => {
      const stop = this.stopResizing;
      this.stopResizing = null;
      stop?.();
      this.host.setWidth?.(this.width, true);
    };
    doc.addEventListener("pointermove", move);
    doc.addEventListener("pointerup", end);
    doc.addEventListener("pointercancel", end);
    handle.addEventListener("lostpointercapture", end);
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // No capture (a synthetic event): the document listeners still follow the pointer.
    }
    this.el.addClass("is-resizing");
    this.stopResizing = () => {
      doc.removeEventListener("pointermove", move);
      doc.removeEventListener("pointerup", end);
      doc.removeEventListener("pointercancel", end);
      handle.removeEventListener("lostpointercapture", end);
      this.el.removeClass("is-resizing");
      this.stopResizing = null;
    };
  }

  // ---- messages the reader hears and the dot on the narrow edge ----------------------------------------------------

  private announce(text: string): void {
    if (!this.built) return;
    // Sentences held back while a reply streamed are read right after the one that ends it.
    this.liveEl.setText([text, ...this.spokenLater.splice(0)].filter(Boolean).join(" "));
  }
  private announceImages(text: string): void {
    if (this.busy) this.spokenLater.push(text);
    else this.announce(text);
  }
  private countsText(counts: ChatLineCounts): string {
    const parts: string[] = [];
    if (counts.done) parts.push(t("ui.map_chat_count_done_0", counts.done));
    if (counts.skipped) parts.push(t("ui.map_chat_count_skipped_0", counts.skipped));
    if (counts.failed) parts.push(t("ui.map_chat_count_failed_0", counts.failed));
    return parts.join(t("ui.map_chat_count_separator"));
  }
  /** The counts as one sentence; a failed count is set apart in the error colour, and its word says it as well. */
  private buildCounts(parent: HTMLElement, counts: ChatLineCounts): void {
    if (!counts.failed) {
      parent.setText(this.countsText(counts));
      return;
    }
    const rest = this.countsText({ ...counts, failed: 0 });
    if (rest) parent.createSpan({ text: `${rest}${t("ui.map_chat_count_separator")}` });
    parent.createSpan({ cls: "vam-map-chat-count-failed", text: t("ui.map_chat_count_failed_0", counts.failed) });
  }
  private spokenTurn(reply: string, lines: MapChatLine[]): string {
    const said = t("ui.map_chat_live_done_0", clip(reply, 160));
    const counts = this.countsText(countChatLines(lines, chatNoteTexts()));
    return counts ? `${said} ${t("ui.map_chat_live_results_0", counts)}` : said;
  }
  /** A reply came in while the window is folded to its edge: the edge shows a dot. */
  /**
   * On the opening screen the message field and the examples come first: the head row is a last, hidden line, after the "empty
   * map" button (so reading and Tab order match what is seen); the head row (icons only) is hidden there. In the window it is on top.
   * Elements are moved only when they are out of place, so a control that has the keyboard is not moved for nothing.
   */
  private placeHeadAndEmptyMap(hero: boolean, showEmptyMap: boolean): void {
    const children = (): Element[] => Array.from(this.bodyEl.children);
    if (!hero) {
      if (children()[0] !== this.headEl) this.bodyEl.insertBefore(this.headEl, this.bodyEl.firstChild);
      return;
    }
    const tail = showEmptyMap ? [this.emptyMapEl, this.headEl] : [this.headEl];
    const now = children().slice(-tail.length);
    if (tail.every((el, index) => now[index] === el)) return;
    for (const el of tail) {
      el.remove();
      this.bodyEl.insertBefore(el, null);
    }
  }
  private markUnread(): void {
    if (this.shown || !this.built) return;
    this.unread = true;
    this.applyOpen();
  }

  private onDragOver(event: DragEvent): void {
    if (!event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    this.setDropHighlight(true);
  }

  private onDrop(event: DragEvent): void {
    event.preventDefault();
    this.setDropHighlight(false);
    const text = event.dataTransfer?.getData("text/plain") ?? "";
    if (!text.trim()) return;
    const lines = text.split(/\r?\n/).filter(line => line.trim());
    const links = lines.map(line => droppedLinkTarget(line));
    if (links.length && links.every(Boolean)) {
      const paths = links.map(link => this.host.resolveLink(link!));
      if (paths.every(Boolean)) {
        for (const path of paths) this.addFile(path!);
        return;
      }
    }
    const source = this.host.activeNotePath();
    this.addSnippet(text, source ?? "", true);
  }

  private applyOpen(): void {
    if (!this.built) return;
    const { hero, docked, floating, shown } = {
      hero: this.hero,
      docked: this.docked,
      floating: this.floating,
      shown: this.shown
    };
    const hadUnread = this.unread;
    if (shown) this.unread = false;
    // Measured before the classes change: a folded log measures as at its end.
    const opening = shown && !this.wasShown && floating && !hero;
    const stick = opening && this.atEnd();
    this.wasShown = shown;
    if (!shown) this.cancelOpenFrame();
    this.el.toggleClass("is-open", shown && !hero);
    this.el.toggleClass("is-hero", hero);
    this.el.toggleClass("is-docked", docked);
    this.el.toggleClass("is-overlay", floating);
    this.el.toggleClass("is-rail", !shown);
    this.bodyEl.hidden = !shown;
    this.bodyEl.toggleClass("is-hidden", !shown);
    this.toggleEl.hidden = shown;
    this.toggleEl.toggleClass("is-hidden", shown);
    this.toggleEl.toggleClass("has-unread", this.unread);
    this.badgeEl.hidden = !this.unread;
    this.toggleEl.setAttr("aria-expanded", String(shown));
    this.toggleEl.setAttr(
      "aria-label",
      t(shown ? "ui.map_chat_close" : this.unread ? "ui.map_chat_open_unread" : "ui.map_chat_open")
    );
    this.resizerEl.hidden = !docked;
    this.resizerEl.toggleClass("is-hidden", !docked);
    this.headEl.toggleClass("is-hero", hero);
    this.heroTitleEl.hidden = !hero;
    this.heroTitleEl.toggleClass("is-hidden", !hero);
    // The opening screen asks for a topic; the side window talks about the map in front of it.
    this.renderPlaceholder();
    this.applyWidth();
    const showEmptyMap = hero && !!this.host.createEmptyMap;
    this.emptyMapEl.hidden = !showEmptyMap;
    this.emptyMapEl.toggleClass("is-hidden", !showEmptyMap);
    this.placeHeadAndEmptyMap(hero, showEmptyMap);
    this.renderGuide();
    this.refreshSave();
    // Someone opens the window because a reply came in while it was folded: they land on the newest message.
    if (shown && hadUnread) this.scrollToEnd();
    if (stick) this.scrollToEndWhenSettled();
  }
  private cancelOpenFrame(): void {
    this.openFrame?.cancel();
    this.openFrame = null;
  }
  /** The overlay's height is final only after the classes are laid out, so the scroll to the end waits for the next frame. */
  private scrollToEndWhenSettled(): void {
    this.cancelOpenFrame();
    const win =
      this.logEl.win ?? this.logEl.ownerDocument?.defaultView ?? (typeof window !== "undefined" ? window : undefined);
    if (typeof win?.requestAnimationFrame !== "function") {
      this.scrollToEnd();
      return;
    }
    const id = win.requestAnimationFrame(() => {
      this.openFrame = null;
      if (this.shown) this.scrollToEnd();
    });
    this.openFrame = { cancel: () => win.cancelAnimationFrame?.(id) };
  }
  /** An empty conversation in the side window shows one line of guidance in place of the log. */
  private renderGuide(): void {
    if (!this.built) return;
    const empty = this.messages.length === 0 && !this.hero;
    this.guideEl.hidden = !empty;
    this.guideEl.toggleClass("is-hidden", !empty);
    this.logEl.hidden = empty;
    this.logEl.toggleClass("is-hidden", empty);
    const restored = !empty && !!this.restoredText;
    this.restoredEl.setText(restored ? this.restoredText : "");
    this.restoredEl.hidden = !restored;
    this.restoredEl.toggleClass("is-hidden", !restored);
  }

  /** Puts the model list back in step with what the view remembers. */
  private refreshControls(): void {
    if (!this.built) return;
    const choices = this.host.modelChoices();
    this.modelEl.empty();
    // A choice may carry a shorter list label; the full one is its tooltip.
    for (const choice of choices)
      this.modelEl.createEl("option", {
        text: choice.short ?? choice.label,
        value: choice.value,
        attr: { title: choice.label }
      });
    this.modelEl.value = this.host.model();
    const shown = choices.find(choice => choice.value === this.modelEl.value)?.label;
    this.modelEl.setAttr("title", shown ? `${t("ui.map_chat_model_label")}\n${shown}` : t("ui.map_chat_model_label"));
  }

  private chipLabel(chip: MapChatChip): string {
    if (chip.kind === "topic") {
      const title = this.host.topicTitle(chip.id);
      return t("ui.map_chat_ref_topic_0", title === null ? t("ui.map_chat_ref_gone") : clip(title));
    }
    if (chip.kind === "file") return t("ui.map_chat_ref_file_0", clip(baseName(chip.path)));
    return chip.path ? t("ui.map_chat_ref_snippet_0", clip(baseName(chip.path))) : t("ui.map_chat_ref_text");
  }

  /** The picture selection changed: the chip and the switch follow. */
  private refreshImage(): void {
    this.renderChips();
    this.renderImageMode();
  }

  /** "Before AI edits the picture" [Show me first | Apply directly]: only while a picture is chosen. */
  private renderImageMode(): void {
    if (!this.built) return;
    const shown = !!this.host.image?.() && !!this.host.setImageMode;
    this.imageModeEl.hidden = !shown;
    if (!shown) return;
    if (!this.imageModeButtons) {
      this.imageModeEl.createSpan({ cls: "vam-map-chat-image-mode-label", text: t("ui.map_chat_image_mode_label") });
      const group = this.imageModeEl.createSpan({
        cls: "vam-map-chat-image-mode-group",
        attr: { role: "group", "aria-label": t("ui.map_chat_image_mode_label") }
      });
      const make = (mode: "preview" | "direct"): HTMLButtonElement => {
        const button = group.createEl("button", {
          cls: "vam-map-chat-image-mode-button",
          text: t(`ui.map_chat_image_mode_${mode}`),
          attr: { type: "button", "aria-pressed": "false" }
        });
        button.addEventListener("click", () => {
          if ((this.host.imageMode?.() ?? "preview") === mode) return;
          this.host.setImageMode?.(mode);
          this.renderImageMode();
        });
        return button;
      };
      this.imageModeButtons = { preview: make("preview"), direct: make("direct") };
    }
    const current = this.host.imageMode?.() ?? "preview";
    for (const mode of ["preview", "direct"] as const) {
      const button = this.imageModeButtons[mode];
      button.setAttr("aria-pressed", String(mode === current));
      button.toggleClass("is-active", mode === current);
    }
  }

  /** The turn that was just finished sent a picture and/or wrote an undo step: its row says so. */
  markTurn(extra: { seenImage?: { note: string }; replyUndo?: { token: object } }): void {
    const last = this.messages.at(-1);
    if (!last || last.role !== "assistant") return;
    if (extra.seenImage) last.seenImage = { note: extra.seenImage.note };
    if (extra.replyUndo) last.replyUndo = { token: extra.replyUndo.token };
    this.renderLog();
  }

  /** The undo step of a reply moved (undone, redone, buried): its button follows. */
  refreshReplyUndo(): void {
    if (!this.built) return;
    for (const message of this.messages) {
      const button = message.replyUndo
        ? this.rows.get(message)?.row.querySelector<HTMLButtonElement>(".vam-map-chat-undo-reply")
        : null;
      if (button && message.replyUndo)
        button.disabled = this.host.replyUndoState?.(message.replyUndo.token) === "undone";
    }
  }

  private renderChips(): void {
    if (!this.built) return;
    this.chipsEl.empty();
    const dragged = new Set(this.chips.filter(chip => chip.kind === "topic").map(chip => (chip as { id: string }).id));
    const picture = this.host.image?.() ?? null;
    if (picture) {
      // The note is the user's or the AI's text: only setText ever shows it. No ×: the chip follows the selection on the canvas.
      const name = picture.note.trim() || picture.name;
      // The small heading of the mockup: only while a picture is chosen, so a chat without one looks as before.
      this.chipsEl
        .createSpan({ cls: "vam-map-chat-refs-label", text: t("ui.map_chat_references") })
        .setAttr("aria-hidden", "true");
      const chip = this.chipsEl.createDiv({ cls: "vam-map-chat-chip is-auto is-image" });
      const pin = chip.createSpan("vam-map-chat-chip-icon");
      pin.setAttr("aria-hidden", "true");
      setIcon(pin, "map-pin");
      chip.createSpan({
        cls: "vam-map-chat-chip-label",
        text: t(
          picture.kind === "annotated" ? "ui.map_chat_ref_image_annotated_0" : "ui.map_chat_ref_image_plain_0",
          clip(picture.kind === "annotated" ? name : picture.name)
        )
      });
    }
    for (const id of this.host.selectedIds()) {
      if (dragged.has(id)) continue;
      const title = this.host.topicTitle(id);
      if (title === null) continue;
      const chip = this.chipsEl.createDiv({ cls: "vam-map-chat-chip is-auto" });
      chip.createSpan({ cls: "vam-map-chat-chip-label", text: t("ui.map_chat_ref_selected_0", clip(title)) });
    }
    if (this.noteChip) {
      const note = this.noteChip;
      const label = t("ui.map_chat_ref_note_0", clip(baseName(note)));
      const chip = this.chipsEl.createDiv({ cls: "vam-map-chat-chip is-note" });
      chip.createSpan({ cls: "vam-map-chat-chip-label", text: label });
      const remove = chip.createEl("button", {
        cls: "vam-map-chat-note-remove",
        text: "×",
        attr: { "aria-label": t("ui.map_chat_remove_ref_0", label), type: "button" }
      });
      remove.addEventListener("click", () => {
        this.dismissedNote = note;
        this.refreshNote();
        this.inputEl.focus();
      });
    }
    for (const entry of this.chips) {
      const label = this.chipLabel(entry);
      const chip = this.chipsEl.createDiv({ cls: `vam-map-chat-chip is-${entry.kind}` });
      chip.createSpan({ cls: "vam-map-chat-chip-label", text: label });
      const remove = chip.createEl("button", {
        cls: "vam-map-chat-chip-remove",
        text: "×",
        attr: { "aria-label": t("ui.map_chat_remove_ref_0", label), type: "button" }
      });
      remove.addEventListener("click", () => this.removeChip(entry));
    }
  }

  /** Everything a message row shows; the row is rebuilt only when this changes. */
  private rowKey(message: MapChatMessage): string {
    const asked = this.messages[this.messages.indexOf(message) - 1];
    return [
      message.role,
      message.auto
        ? `auto:${message.autoInfo?.round ?? ""}:${message.autoInfo?.maxRounds ?? ""}:${message.autoInfo?.remaining ?? ""}:${message.autoInfo?.partial ? `${message.autoInfo.partial.failed}/${message.autoInfo.partial.succeeded}` : ""}`
        : "",
      message.auto
        ? t("ui.map_chat_auto_round_0_1", "", "") +
          t("ui.map_chat_role_auto") +
          t("ui.map_chat_chain_left_0", "") +
          t("ui.map_chat_chain_partial_0_1", "", "")
        : "",
      message.stale ? "x" : "",
      t("ui.map_chat_record_stale"),
      t("ui.map_chat_record_stale_short"),
      message.error ? "e" : "",
      message.technical ?? "",
      t("ui.technical_details"),
      t("ui.copy_technical_details"),
      message.streaming ? "s" : "",
      // Only whether the stage line is there (its words and seconds change in place, never the row).
      this.stageMessage() === message ? "p" : "",
      this.canRetry(message, asked) ? "r" : "",
      message.linesOpen ? "o" : "",
      message.seenImage ? `seen:${message.seenImage.note}` : "",
      message.replyUndo ? "undo" : "",
      this.chainWaitingState && this.messages.at(-1) === message
        ? `wait:${this.chainWaitingState.kinds.join(",")}:${this.chainWaitingLeft}:${this.waitWord(this.chainWaitingState)}`
        : "",
      message.chainNote ? `chain:${message.chainNote.reason}:${message.chainNote.text}` : "",
      (message.unread ?? []).map(item => `${item.oversize ? "o" : "d"}:${item.title}`).join("\n"),
      JSON.stringify(message.lines.map(line => line.basis ?? null)),
      t("ui.map_chat_basis_title_only"),
      t("ui.map_chat_chain_wait_tail"),
      t("ui.map_chat_seen_image_0", ""),
      t("ui.map_chat_undo_reply"),
      (message.steers ?? []).map(steer => `${steer.state}:${steer.text}`).join("\n"),
      t("ui.map_chat_steer_tag_live"),
      t("ui.map_chat_steer_tag_queued"),
      t("ui.map_chat_retry"),
      t("ui.map_chat_lines_hide"),
      t("ui.map_chat_details_show"),
      t("ui.map_chat_plan_summary_0", ""),
      t("ui.map_chat_plan_title"),
      t("ui.map_chat_plan_title_applied"),
      t("ui.map_chat_plan_title_cancelled"),
      t("ui.map_chat_role_you"),
      message.role === "assistant" ? (message.modelLabel ?? "") : "",
      t("ui.map_chat_role_ai"),
      t("ui.map_chat_overflow_note"),
      t("ui.map_chat_images_source"),
      message.lines
        .map(settledLine)
        .map(line => `${line.status}:${line.text}`)
        .join("\n"),
      message.plan
        ? `plan:${message.plan.stale ? "stale:" : ""}${message.plan.state}:${message.plan.aiWork ? "ai:" : ""}${message.plan.openGroups ? "open:" : ""}${message.plan.items.length}:${message.plan.estimate}:${message.plan.groups?.map(group => `${group.label}${group.danger ? "!" : ""}`).join("|") ?? ""}`
        : "",
      message.choices
        ? `choices:${message.choices.stale ? "stale:" : ""}${message.choices.picked}:${message.choices.options.map(o => o.label).join("|")}`
        : "",
      (message.images ?? [])
        .map(
          block =>
            `images:${block.stale ? "stale:" : ""}${block.state}:${block.running ? 1 : 0}:${block.nodeTitle}:${block.reason ?? ""}:${block.items
              .map(item => [item.candidate.url, item.inserted ?? ""].join("~"))
              .join(",")}`
        )
        .join(";"),
      message.text
    ].join("\u0001");
  }
  private canRetry(message: MapChatMessage, asked: MapChatMessage | undefined): boolean {
    return (
      message.role === "assistant" && !!message.error && !message.streaming && !!asked?.origin && !!this.host.retry
    );
  }
  private renderLog(forceEnd = false): void {
    if (!this.built) return;
    this.cancelFrame();
    const stick = forceEnd || this.atEnd();
    // Rows of messages that have not changed are kept as they are (no parsing, no new elements); only the rest is built.
    const keys = this.messages.map(message => this.rowKey(message));
    const kept = new Set<HTMLElement>();
    this.messages.forEach((message, index) => {
      const entry = this.rows.get(message);
      if (entry && entry.key === keys[index]) kept.add(entry.row);
    });
    for (const child of Array.from(this.logEl.children)) if (!kept.has(child as HTMLElement)) child.remove();
    this.messageEls = [];
    this.bodyEls = [];
    this.messages.forEach((message, index) => {
      let entry = this.rows.get(message);
      if (!entry || entry.key !== keys[index]) {
        entry = { ...this.buildRow(message), key: keys[index] };
        this.rows.set(message, entry);
      }
      const at = this.logEl.children[index];
      if (at !== entry.row) this.logEl.insertBefore(entry.row, at ?? null);
      if (entry.more) entry.more.disabled = this.working;
      this.messageEls.push(entry.row);
      this.bodyEls.push(entry.body);
    });
    this.renderGuide();
    this.refreshSave();
    if (stick) this.scrollToEnd();
  }

  private buildRow(message: MapChatMessage): {
    row: HTMLElement;
    body: HTMLElement;
    more: HTMLButtonElement | null;
  } {
    const row = this.logEl.createDiv({
      cls: `vam-map-chat-msg is-${message.role}${message.error ? " is-error" : ""}${message.auto ? " is-auto" : ""}`
    });
    // The question of an automatic round is not something the user said: its row is the separator between two rounds (rows follow the messages).
    if (message.auto) {
      const info = message.autoInfo;
      const body = row.createDiv({ cls: "vam-map-chat-auto-title" });
      body.setText(
        info?.round ? t("ui.map_chat_auto_round_0_1", info.round, info.maxRounds) : t("ui.map_chat_role_auto")
      );
      if (info?.partial)
        row.createDiv({
          cls: "vam-map-chat-auto-note",
          text: t("ui.map_chat_chain_partial_0_1", info.partial.failed, info.partial.succeeded)
        });
      if (info?.remaining?.trim())
        row.createDiv({ cls: "vam-map-chat-auto-left", text: t("ui.map_chat_chain_left_0", info.remaining) });
      return { row, body, more: null };
    }
    row.createSpan({
      cls: "vam-map-chat-role",
      text: message.role === "user" ? t("ui.map_chat_role_you") : message.modelLabel || t("ui.map_chat_role_ai")
    });
    const markdown = message.role === "assistant" && !message.error;
    const body = row.createDiv({ cls: `vam-map-chat-text${markdown ? " is-markdown" : ""}` });
    if (markdown) renderChatMarkdown(body, message.text, t("ui.map_chat_overflow_note"));
    else body.setText(message.text);
    for (const steer of message.steers ?? []) this.buildSteer(row, steer);
    if (message.error && message.technical) this.buildTechnical(row, message.technical);
    if (this.stage && this.stageMessage() === message) this.buildStage(row, message);
    // An applied plan has no card of its own: its content is behind the same "View details" as the results.
    const applied = message.plan && message.plan.state === "applied" && !message.plan.stale ? message.plan : null;
    if (message.plan && !applied) this.buildPlan(row, message.plan, message);
    if (message.choices) this.buildChoices(row, message.choices);
    const undoPlaced = message.lines.length > 0 || applied ? this.buildOutcome(row, message, applied) : false;
    this.buildBasis(row, message);
    if (message.images?.length) this.buildImages(row, message.images);
    if (this.chainWaitingState && this.messages.at(-1) === message) this.buildChainWait(row);
    if (message.seenImage) {
      // The words stay one plain-text element; the eye sits beside it.
      const line = row.createDiv("vam-map-chat-seen-row");
      const eye = line.createSpan("vam-map-chat-seen-icon");
      eye.setAttr("aria-hidden", "true");
      setIcon(eye, "eye");
      line.createDiv({
        cls: "vam-map-chat-seen",
        text: t("ui.map_chat_seen_image_0", clip(message.seenImage.note, 80))
      });
    }
    if (message.chainNote)
      row.createDiv({ cls: `vam-map-chat-chain-note is-${message.chainNote.reason}`, text: message.chainNote.text });
    if (message.replyUndo && !undoPlaced) this.buildReplyUndo(row, message.replyUndo.token);
    // What the AI actually did comes straight after what it said; the buttons that act on the answer come last.
    const asked = this.messages[this.messages.indexOf(message) - 1];
    let more: HTMLButtonElement | null = null;
    if (this.canRetry(message, asked) && asked?.origin) {
      const origin = asked.origin;
      more = row.createEl("button", {
        cls: "vam-map-chat-retry",
        text: t("ui.map_chat_retry"),
        attr: { type: "button" }
      });
      more.disabled = this.working;
      if (message.stale) this.makeInert(more);
      else
        more.addEventListener("click", () => {
          if (!this.working) this.handOffFocus(() => this.host.retry?.(origin));
        });
    }
    return { row, body, more };
  }

  /**
   * What the results were built from, gathered under them (so a folded list still shows it) and then the research notes the round
   * left unread. Plain text only (titles are untrusted); "read", never "checked". The program decides it, not the model.
   */
  private buildBasis(row: HTMLElement, message: MapChatMessage): void {
    // The basis is detail (behind "View details"); a note the AI could not read is an exception and always shows:
    // the unread research notes, and a card built from its title only.
    const all = summarizeBasis(message.lines.flatMap(line => (line.basis ? [line.basis] : [])));
    const entries = message.linesOpen ? all : all.filter(entry => entry.kind === "outline_only");
    const unread = message.unread ?? [];
    if (!entries.length && !unread.length) return;
    const box = row.createDiv({ cls: "vam-map-chat-basis" });
    for (const entry of entries) this.buildBasisEntry(box.createDiv("vam-map-chat-basis-line"), entry);
    for (const item of unread)
      box.createDiv({
        cls: "vam-map-chat-basis-line is-unread",
        text: t(
          item.oversize ? "ui.map_chat_research_oversize_0" : "ui.map_chat_research_deferred_0",
          clip(item.title, 60)
        )
      });
  }
  private buildBasisEntry(line: HTMLElement, entry: BasisSummaryEntry): void {
    const quoted = (titles: string[]): string =>
      titles.map(title => t("ui.map_chat_basis_quote_0", title)).join(t("ui.map_chat_basis_title_separator"));
    if (entry.kind === "outline_only") {
      // Said in words and in bold, never by colour: no note of this one was read.
      if (entry.type === "cards") {
        line.createEl("strong", { text: t("ui.map_chat_basis_title_only_0", entry.count) });
        line.createSpan({ text: t("ui.map_chat_basis_title_only_hint") });
      } else {
        line.createEl("strong", { text: t("ui.map_chat_basis_title_only") });
        if (entry.existingChildren > 0)
          line.createSpan({ text: t("ui.map_chat_basis_children_0", entry.existingChildren) });
      }
      return;
    }
    if (entry.type === "cards")
      line.setText(
        t(
          entry.kind === "research" ? "ui.map_chat_basis_research_0_1" : "ui.map_chat_basis_note_0_1",
          quoted(entry.titles),
          entry.count
        )
      );
    else
      line.setText(
        entry.existingChildren > 0
          ? t("ui.map_chat_basis_expand_0_1", quoted(entry.titles), entry.existingChildren)
          : t("ui.map_chat_basis_expand_0", quoted(entry.titles))
      );
  }

  /** The waiting row of a continuation: how far the research and expansions are, the time (hidden from readers), and what is left. */
  private buildChainWait(row: HTMLElement): void {
    const box = row.createDiv({ cls: "vam-map-chat-chain-wait", attr: { role: "status" } });
    const line = box.createDiv("vam-map-chat-chain-wait-line");
    const label = line.createSpan({ cls: "vam-map-chat-chain-wait-label" });
    const elapsed = line.createSpan({ cls: "vam-map-chat-chain-wait-elapsed" });
    elapsed.setAttr("aria-hidden", "true");
    line.createSpan({
      cls: "vam-map-chat-chain-wait-tail",
      text: t("ui.map_chat_stage_elapsed_0", t("ui.map_chat_chain_wait_tail"))
    });
    if (this.chainWaitingLeft.trim())
      box.createDiv({
        cls: "vam-map-chat-chain-wait-left",
        text: t("ui.map_chat_chain_left_0", this.chainWaitingLeft)
      });
    this.chainWaitingEls = { label, elapsed };
    this.paintWait();
  }

  /** "Undo this reply" under an "apply directly" reply. Nothing of it is saved with the conversation. */
  private buildReplyUndo(parent: HTMLElement, token: object): void {
    const button = parent.createEl("button", {
      cls: "vam-map-chat-undo-reply",
      text: t("ui.map_chat_undo_reply"),
      attr: { type: "button" }
    });
    button.disabled = this.host.replyUndoState?.(token) === "undone";
    button.addEventListener("click", () => {
      if (button.disabled || !this.host.undoReply) return;
      void this.host.undoReply(token).then(() => this.refreshReplyUndo());
    });
  }

  /**
   * A control of a restored conversation: it says it is no longer valid (aria-disabled, the stale class) and does nothing, with
   * mouse or keyboard. It stays reachable by Tab so its explanation can be read.
   */
  private makeInert(control: HTMLElement): void {
    control.setAttr("aria-disabled", "true");
    control.addClass("is-stale");
    control.setAttr("title", t("ui.map_chat_record_stale"));
    control.addEventListener("click", event => event.preventDefault());
    control.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") event.preventDefault();
    });
  }

  /** A follow-up under the question: its own small bubble, tagged in words (the tag is text, never colour alone). */
  private buildSteer(row: HTMLElement, steer: MapChatSteer): void {
    const bubble = row.createDiv({ cls: `vam-map-chat-steer is-${steer.state}` });
    bubble.createEl("small", {
      cls: "vam-map-chat-steer-tag",
      text: t(steer.state === "live" ? "ui.map_chat_steer_tag_live" : "ui.map_chat_steer_tag_queued")
    });
    bubble.createSpan({ cls: "vam-map-chat-steer-text", text: steer.text });
  }

  /** The raw error of a failed turn: folded away, selectable and copyable. */
  private buildTechnical(row: HTMLElement, raw: string): void {
    const more = row.createEl("details", { cls: "vam-map-chat-error-details" });
    more.createEl("summary", { text: t("ui.technical_details") });
    more.createEl("pre", { text: raw });
    const copy = more.createEl("button", { text: t("ui.copy_technical_details"), attr: { type: "button" } });
    copy.addEventListener("click", () => void navigator.clipboard?.writeText(raw));
  }

  /** The stage line of the running turn: the stage name, then the seconds (hidden from screen readers; they tick). */
  private buildStage(row: HTMLElement, message: MapChatMessage): void {
    const box = row.createDiv({ cls: `vam-map-chat-progress${message.text ? " is-compact" : ""}` });
    const label = box.createSpan({ cls: "vam-map-chat-progress-stage" });
    const elapsed = box.createSpan({ cls: "vam-map-chat-progress-elapsed" });
    elapsed.setAttr("aria-hidden", "true");
    this.stageEls = { box, label, elapsed, slow: null };
    this.paintStage();
  }

  /** A result the reader still has to look at: anything not done, and a picture line where some card got no picture. */
  private needsLook(line: MapChatLine): boolean {
    return line.status !== "done" || !!line.imageGroup?.some(block => !placedImage(block));
  }
  /** The toggle of "View details": one per reply, for the plan card and the results alike. Focus follows the rebuilt button. */
  private buildDetailToggle(parent: HTMLElement, message: MapChatMessage, open: boolean): void {
    const toggle = parent.createEl("button", {
      cls: "vam-map-chat-lines-toggle",
      text: open ? t("ui.map_chat_lines_hide") : t("ui.map_chat_details_show"),
      attr: { type: "button", "aria-expanded": String(open) }
    });
    toggle.addEventListener("click", () => {
      message.linesOpen = !open;
      this.renderLog();
      // The row was rebuilt, and the button with it: the keyboard goes to its successor.
      this.rows.get(message)?.row.querySelector<HTMLElement>(".vam-map-chat-lines-toggle")?.focus();
    });
  }
  /**
   * What a reply did: only what the reader has to act on is shown (failed, skipped, a picture search that missed, the closing
   * notes). Done lines fold into a count, and with the applied plan card and the basis they sit behind "View details". Each
   * line says what happened in words, so the colour is never the only sign. Returns whether Undo was put in the summary row.
   */
  private buildOutcome(row: HTMLElement, message: MapChatMessage, applied: MapChatPlanCard | null): boolean {
    // While a picture search runs its block shows the progress; the result line returns when every search has ended.
    const shownLines = message.lines.filter(line => !line.imageGroup?.some(block => block.state === "searching"));
    const { results, notes } = splitChatLines(shownLines.map(settledLine), chatNoteTexts());
    const folded = results.filter(line => !this.needsLook(line));
    const loud = results.filter(line => this.needsLook(line));
    const hasBasis = message.lines.some(line => line.basis);
    const hasDetail = folded.length > 0 || !!applied || hasBasis;
    const open = hasDetail && message.linesOpen === true;
    const undo = message.replyUndo;
    if (!hasDetail && !loud.length && !notes.length && !undo) return false;
    const list = row.createDiv({ cls: "vam-map-chat-lines" });
    if (hasDetail || undo) {
      const summary = list.createDiv("vam-map-chat-lines-summary");
      if (folded.length) this.buildCounts(summary.createSpan("vam-map-chat-lines-counts"), { done: folded.length, skipped: 0, failed: 0 });
      else if (applied) this.buildPlanSummary(summary.createSpan("vam-map-chat-lines-counts"), applied);
      if (hasDetail) this.buildDetailToggle(summary, message, open);
      if (undo) this.buildReplyUndo(summary, undo.token);
    }
    for (const line of loud) list.createDiv({ cls: `vam-map-chat-line is-${line.status}`, text: line.text });
    if (open) {
      if (applied) this.buildPlan(list, applied, message);
      for (const line of folded) list.createDiv({ cls: `vam-map-chat-line is-${line.status}`, text: line.text });
    }
    for (const note of notes) list.createDiv({ cls: "vam-map-chat-line is-note", text: note.text });
    return !!undo;
  }

  /**
   * The plan card. Waiting: one summary line, the undo warning when the plan starts AI work, and Apply / Cancel / View details;
   * the title, sentence, lists, estimate and intro sit behind "View details". Cancelled (and a restored one): the whole card as
   * before. An applied card is built here too, but only inside the "View details" of its reply. All plain elements (buttons,
   * details), so Tab, Enter and Space work without any script.
   */
  private buildPlan(parent: HTMLElement, plan: MapChatPlanCard, message: MapChatMessage): void {
    const card = parent.createDiv({ cls: `vam-map-chat-plan is-${plan.state}` });
    // The title follows what became of the plan, so a card read again later does not look as if it still waits.
    const title = t(
      plan.state === "applied"
        ? "ui.map_chat_plan_title_applied"
        : plan.state === "cancelled"
          ? "ui.map_chat_plan_title_cancelled"
          : "ui.map_chat_plan_title"
    );
    card.setAttr("role", "group");
    card.setAttr("aria-label", title);
    if (plan.stale) {
      card.addClass("is-stale");
      card.createDiv({ cls: "vam-map-chat-plan-title", text: title });
      card.createDiv({ cls: "vam-map-chat-stale-note", text: t("ui.map_chat_record_stale") });
      // A card that was applied or cancelled has nothing left to press: no buttons, only what became of it.
      if (plan.state !== "pending") {
        card.createDiv({
          cls: "vam-map-chat-plan-state",
          text: t(plan.state === "applied" ? "ui.map_chat_plan_applied" : "ui.map_chat_plan_cancelled")
        });
        return;
      }
      const dead = card.createDiv({ cls: "vam-map-chat-plan-buttons" });
      for (const text of [t("ui.map_chat_plan_apply"), t("ui.map_chat_plan_cancel")])
        this.makeInert(dead.createEl("button", { text, attr: { type: "button" } }));
      return;
    }
    if (plan.state !== "pending") {
      this.buildPlanBody(card, plan, title);
      card.createDiv({
        cls: "vam-map-chat-plan-state",
        text: t(plan.state === "applied" ? "ui.map_chat_plan_applied" : "ui.map_chat_plan_cancelled")
      });
      return;
    }
    this.buildPlanSummary(card.createDiv("vam-map-chat-plan-summary"), plan);
    // Said before the button is pressed, not after: undo takes the plan's changes back, but not the AI work it starts. Always
    // shown (never behind "View details") and only for a plan that does start AI work.
    if (plan.aiWork)
      card.createDiv({ cls: "vam-map-chat-plan-warning", text: t("ui.map_chat_plan_irreversible") });
    // A plan about a picture keeps its lists open: the user checks the anchors before they apply them, so nothing folds.
    const folds = !plan.openGroups;
    const open = !folds || message.linesOpen === true;
    const addDetail = (): void => {
      if (!open) return;
      const detail = card.createDiv("vam-map-chat-plan-detail");
      this.buildPlanBody(detail, plan, title);
      detail.createDiv({ cls: "vam-map-chat-plan-note", text: t("ui.map_chat_plan_intro") });
    };
    // A picture plan lists what it will do first, then asks; other plans put the buttons first and fold the detail after them.
    if (!folds) addDetail();
    const buttons = card.createDiv({ cls: "vam-map-chat-plan-buttons" });
    const apply = buttons.createEl("button", {
      cls: "mod-cta vam-map-chat-plan-apply",
      text: t("ui.map_chat_plan_apply"),
      attr: { type: "button" }
    });
    const cancel = buttons.createEl("button", {
      cls: "vam-map-chat-plan-cancel",
      text: t("ui.map_chat_plan_cancel"),
      attr: { type: "button" }
    });
    if (folds) this.buildDetailToggle(buttons, message, open);
    if (folds) addDetail();
    // A second press does nothing: the buttons stop working as soon as one is used. They disappear with the repaint, so the
    // keyboard goes back to the message field instead of falling to the page.
    apply.addEventListener("click", () => {
      if (plan.state !== "pending") return;
      apply.disabled = cancel.disabled = true;
      plan.apply();
      this.focusInput();
    });
    cancel.addEventListener("click", () => {
      if (plan.state !== "pending") return;
      apply.disabled = cancel.disabled = true;
      plan.cancel();
      this.focusInput();
    });
  }
  /** The plan's one sentence: its own summary, or the reasons (a waiting plan says it needs the user's yes). */
  private planSentence(plan: MapChatPlanCard): string {
    return (
      plan.summary ??
      (plan.state === "pending"
        ? t("ui.map_chat_plan_summary_0", plan.reasons.join(t("ui.map_chat_count_separator")))
        : plan.reasons.join(t("ui.map_chat_count_separator")))
    );
  }
  /** One line for a plan: its group labels (the group that removes cards says so in words); the sentence when none has a label. */
  private buildPlanSummary(parent: HTMLElement, plan: MapChatPlanCard): void {
    const labelled = (plan.groups ?? []).filter(group => group.label);
    if (!labelled.length) {
      parent.setText(this.planSentence(plan));
      return;
    }
    labelled.forEach((group, index) => {
      if (index) parent.createSpan({ text: t("ui.map_chat_count_separator") });
      const part = parent.createSpan({
        cls: `vam-map-chat-plan-summary-part${group.danger ? " is-danger" : ""}`,
        text: group.label
      });
      // Text as well as colour: a group that removes cards says so in words.
      if (group.danger) part.createSpan({ cls: "vam-map-chat-plan-mark", text: group.danger.mark });
    });
  }
  /** Title, sentence, the actions folded by kind of work, and the estimate. */
  private buildPlanBody(card: HTMLElement, plan: MapChatPlanCard, title: string): void {
    card.createDiv({ cls: "vam-map-chat-plan-title", text: title });
    card.createDiv({
      cls: "vam-map-chat-plan-sentence",
      // Only a plan still waiting says it needs confirmation; an applied or cancelled one just names what it was.
      text: this.planSentence(plan)
    });
    const groups = plan.groups ?? (plan.items.length ? [{ label: "", items: plan.items }] : []);
    for (const group of groups) {
      const danger = "danger" in group ? group.danger : undefined;
      const list = group.label
        ? card.createEl("details", { cls: `vam-map-chat-plan-group${danger ? " is-danger" : ""}` })
        : card.createDiv("vam-map-chat-plan-group");
      if (plan.openGroups && group.label) (list as HTMLDetailsElement).open = true;
      if (group.label) {
        const summary = list.createEl("summary", { cls: "vam-map-chat-plan-group-title", text: group.label });
        // Text as well as colour: a group that removes cards says so in words.
        if (danger) summary.createSpan({ cls: "vam-map-chat-plan-mark", text: danger.mark });
      }
      const items = list.createEl("ol", { cls: "vam-map-chat-plan-items" });
      for (const item of group.items) items.createEl("li", { text: item });
    }
    card.createDiv({ cls: "vam-map-chat-plan-estimate", text: plan.estimate });
  }
  /**
   * The pictures one reply put into its cards, as one result block: a summary, then a row per card (thumbnail, card, picture
   * title, the page it came from; or the card and why it got none). While searching it also says which card is being searched,
   * how many have ended, and offers Stop for the ones that have not. Nothing here is run or fetched except the thumbnails,
   * which are https images shown without a referrer. All text goes in as text.
   */
  private buildImages(row: HTMLElement, blocks: MapChatImages[]): void {
    const live = blocks.filter(block => !block.stale);
    if (live.length) this.buildImageResult(row, live);
    const old = blocks.filter(block => block.stale);
    if (old.length) this.buildStaleImages(row, old);
  }
  private buildImageResult(row: HTMLElement, blocks: MapChatImages[]): void {
    const pending = blocks.filter(block => block.state === "searching");
    const box = row.createDiv({
      cls: `vam-map-chat-images ${pending.length ? "is-searching" : "is-done"}`,
      attr: { role: "group", "aria-label": t("ui.map_chat_images_label") }
    });
    const placed = blocks.filter(block => placedImage(block)).length;
    const head = box.createDiv({ cls: "vam-map-chat-images-status" });
    if (pending.length) {
      const current = pending.find(block => block.running) ?? pending[0];
      head.setText(t("ui.map_chat_images_searching_0", clip(current.nodeTitle || current.query, 80)));
      box.createDiv({
        cls: "vam-map-chat-images-progress",
        text: t("ui.map_chat_images_progress_0_1", blocks.length - pending.length, blocks.length)
      });
      const stop = box.createEl("button", {
        cls: "vam-map-chat-images-stop",
        text: t("ui.map_chat_images_stop"),
        attr: { type: "button" }
      });
      stop.addEventListener("click", () => {
        for (const block of pending) block.stop?.();
      });
    } else {
      const missed = blocks.length - placed;
      head.setText(
        missed ? t("ui.map_chat_images_summary_0_1", placed, missed) : t("ui.map_chat_images_summary_0", placed)
      );
    }
    const list = box.createDiv({ cls: "vam-map-chat-images-list", attr: { role: "list" } });
    for (const block of blocks) {
      const cell = list.createDiv({ cls: "vam-map-chat-images-item", attr: { role: "listitem" } });
      const item = placedImage(block);
      if (item) {
        cell.createEl("img", {
          cls: "vam-map-chat-images-thumb",
          attr: { src: item.candidate.url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }
        });
        const text = cell.createDiv({ cls: "vam-map-chat-images-text" });
        text.createDiv({ cls: "vam-map-chat-images-topic", text: clip(block.nodeTitle, 80) });
        text.createDiv({ cls: "vam-map-chat-images-title", text: clip(item.candidate.title, 80) });
        if (item.candidate.source)
          text.createEl("a", {
            cls: "vam-map-chat-images-source",
            text: t("ui.map_chat_images_source"),
            attr: {
              href: item.candidate.source,
              target: "_blank",
              rel: "noopener noreferrer",
              "aria-label": t("ui.map_chat_images_source_0", clip(item.candidate.title))
            }
          });
        continue;
      }
      cell.addClass("is-missed");
      const text = cell.createDiv({ cls: "vam-map-chat-images-text" });
      text.createDiv({ cls: "vam-map-chat-images-topic", text: clip(block.nodeTitle, 80) });
      const why =
        block.state === "searching"
          ? block.running
            ? t("ui.map_chat_images_searching_0", clip(block.query, 80))
            : t("ui.map_chat_images_queued")
          : block.state === "stopped"
            ? t("ui.map_chat_images_stopped")
            : block.state === "failed"
              ? t("ui.map_chat_images_failed_0", clip(block.reason ?? "", 160))
              : (block.reason ?? t("ui.map_chat_images_none"));
      text.createDiv({ cls: "vam-map-chat-images-reason", text: why });
    }
  }
  /** Older saved records: what was listed, read-only (no link, no thumbnail, nothing to press). */
  private buildStaleImages(row: HTMLElement, blocks: MapChatImages[]): void {
    const box = row.createDiv({
      cls: "vam-map-chat-images is-stale",
      attr: { role: "group", "aria-label": t("ui.map_chat_images_label") }
    });
    box.createDiv({ cls: "vam-map-chat-stale-note", text: t("ui.map_chat_record_stale") });
    const list = box.createDiv({ cls: "vam-map-chat-images-list", attr: { role: "list" } });
    for (const block of blocks)
      for (const item of block.items) {
        const cell = list.createDiv({ cls: "vam-map-chat-images-item", attr: { role: "listitem" } });
        const text = cell.createDiv({ cls: "vam-map-chat-images-text" });
        // A saved picture's `inserted` is "topic: picture title": it is the one line (the title is not said twice).
        if (item.inserted)
          text.createDiv({
            cls: "vam-map-chat-images-state is-inserted",
            text: t("ui.map_chat_images_inserted_0", clip(item.inserted))
          });
        else text.createDiv({ cls: "vam-map-chat-images-title", text: clip(item.candidate.title, 80) });
      }
  }
  private buildChoices(row: HTMLElement, choices: MapChatChoices): void {
    const box = row.createDiv({ cls: "vam-map-chat-choices" });
    box.setAttr("role", "group");
    box.setAttr("aria-label", choices.prompt);
    box.createDiv({ cls: "vam-map-chat-choices-prompt", text: choices.prompt });
    if (choices.stale) {
      box.addClass("is-stale");
      box.createDiv({ cls: "vam-map-chat-stale-note", text: t("ui.map_chat_record_stale") });
      for (const option of choices.options)
        this.makeInert(
          box.createEl("button", { cls: "vam-map-chat-choice", text: option.label, attr: { type: "button" } })
        );
      return;
    }
    const buttons: HTMLButtonElement[] = [];
    for (const option of choices.options) {
      const button = box.createEl("button", {
        cls: "vam-map-chat-choice",
        text: option.label,
        attr: { type: "button" }
      });
      button.disabled = choices.picked;
      buttons.push(button);
      button.addEventListener("click", () => {
        if (choices.picked) return;
        choices.picked = true;
        for (const other of buttons) other.disabled = true;
        // One pick ends every list of maps shown so far.
        this.retireChoices(choices);
        option.pick();
        this.focusInput();
      });
    }
  }

  /** The field's hint: a follow-up while a turn works, the opening screen's ask, or the ordinary one. */
  private renderPlaceholder(): void {
    if (!this.built) return;
    const key = this.working
      ? "ui.map_chat_steer_placeholder"
      : this.chainWaitingState
        ? "ui.map_chat_chain_wait_placeholder"
        : this.hero
          ? "ui.map_chat_hero_placeholder"
          : "ui.map_chat_input_placeholder";
    this.inputEl.setAttr("placeholder", t(key));
  }
  /** "Enter 補充" beside the stop key while a turn works and the field has text. */
  private renderSteerHint(): void {
    if (!this.built) return;
    // While the chain waits, Enter with text sends it as a new message that takes over from the continuation.
    const taking = !this.working && this.chainWaitingState !== null;
    const show = (this.working || taking) && this.inputEl.value.trim().length > 0;
    this.steerHintEl.setText(show ? t(taking ? "ui.map_chat_chain_wait_hint" : "ui.map_chat_steer_hint") : "");
    this.steerHintEl.hidden = !show;
    // The model menu in the same box gives way to the hint (its width is set by this class).
    this.el.toggleClass("has-steer-hint", show);
    this.steerHintEl.toggleClass("is-hidden", !show);
    if (this.working) this.inputEl.setAttr("aria-keyshortcuts", "Enter");
    else this.inputEl.removeAttribute?.("aria-keyshortcuts");
    if (show) this.inputEl.setAttr("aria-describedby", "vam-map-chat-steer-hint");
    else this.inputEl.removeAttribute?.("aria-describedby");
  }
  private renderBusy(): void {
    if (!this.built) return;
    this.renderPlaceholder();
    this.renderSteerHint();
    // The turn's own progress is in the AI bubble; this line only says that a plan is being applied.
    this.statusEl.setText(this.applying ? t("ui.map_chat_applying") : "");
    this.el.toggleClass("is-busy", this.working);
    this.refreshNewButton();
    this.sendEl.hidden = this.working;
    this.sendEl.toggleClass("is-hidden", this.working);
    // While the usage notice is open, its own Cancel is the way out: no Stop beside it.
    const stoppable = (this.working && !this.awaitingConsent) || this.chainWaitingState !== null;
    this.el.toggleClass("is-chain-waiting", this.chainWaitingState !== null);
    // Hiding the focused Stop drops the keyboard to the page; once the run is over the message field takes it (C-#14).
    const stopHadFocus = !stoppable && !this.stopEl.hidden && this.host.activeElement() === this.stopEl;
    this.stopEl.hidden = !stoppable;
    this.stopEl.toggleClass("is-hidden", !stoppable);
    if (this.stopWanted && !this.working) this.stopWanted = false;
    else if (this.stopWanted && stoppable) {
      this.stopWanted = false;
      if (this.focusFree()) this.stopEl.focus();
    }
    if (stopHadFocus && !this.working && this.focusFree()) this.inputEl.focus();
    this.renderHint();
    this.host.stateChanged?.();
  }
  /** While a plan waits for its answer a line above the message field says what sending a new message does to it. */
  private renderHint(): void {
    if (!this.built) return;
    const waiting = !this.working && this.pendingPlan() !== null;
    this.hintEl.setText(waiting ? t("ui.map_chat_plan_replace_hint") : "");
    this.hintEl.hidden = !waiting;
    this.hintEl.toggleClass("is-hidden", !waiting);
  }

  /** True when the log is scrolled to its end (or cannot be measured), so a longer reply should keep the end in view. */
  private atEnd(): boolean {
    if (!this.built) return true;
    const gap = this.logEl.scrollHeight - this.logEl.scrollTop - this.logEl.clientHeight;
    return !Number.isFinite(gap) || gap <= 8;
  }
  private scrollToEnd(): void {
    if (this.built) this.logEl.scrollTop = this.logEl.scrollHeight;
  }
}
