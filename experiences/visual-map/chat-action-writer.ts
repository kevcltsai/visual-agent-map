import {
  addAnchor,
  addAnchorRelation,
  anchorRelationAllowed,
  ANCHOR_LIMIT,
  findAnnotatedImage,
  isImage2dAnchor,
  updateAnchor,
  type AnchorRelation,
  type AnnotatedImageItem
} from "./canvas-items";
import type { Transaction, TransactionEntry } from "./map-transaction";
import { randomUUID } from "node:crypto";
import { t, type TranslationKey } from "../../i18n";
import type { App, Editor, TFile } from "obsidian";
import { addedMermaidBlocks } from "../../ai/mermaid-safety";
import { frontmatter } from "../../core/repository-frontmatter";
import { saveLivingConfig, type LivingConfigSave } from "./living-node-runtime";
import { promptSourceLinks } from "./prompt-run";
import {
  canParent,
  clone,
  type MapDocument,
  type MapNode,
  normalizeRelationDescription,
  relationAllowed,
  setTopicRelations,
  type TopicRelation
} from "../../map-model";
import { readKnowledgeRefs } from "./knowledge-refs";
import { ringMemberIds } from "../../map-layout-text";
import { isTopicMarker } from "../../topic-markers";
import { ringMembers } from "./image-ring";
import { type Note, type NotePatch, topicAppearanceValues, type TopicAppearanceChange } from "../../repository";
import { intakeAiMarkdown, intakeAiMarkdownChecked } from "../../ai/markdown-intake";
import {
  readAiLocked,
  resolveHypothesisWrite,
  type HypothesisLeaning,
  type HypothesisStrength,
  type TopicKind
} from "../../note-values";
import type { MapChatImages } from "./map-chat";
import type { MapChatBasis } from "../../core/map-chat-basis";
import { contentHash } from "../../core/content-hash";
import { isMdStale, type MapChatContext, type MapChatTopicHash } from "../../core/map-chat-context";
import { applyMdEdit, guardMapChatWrite, normalizeVaultPath, type MapChatGuardCode } from "../../core/map-chat-guard";
import { aiWriteGate } from "../../core/ai-write-gate";
import type { AiLockOp, AiLockReason } from "../../core/ai-lock";
import { MAP_CHAT_ANCHOR_PREFIX, MAP_CHAT_NEW_PREFIX, type MapChatAction } from "../../core/steps/map-chat/step";
import type VisualAgentMapPlugin from "../../main";

/** What one chat action came to: written, skipped with a reason (shown in the chat), or failed. */
export type ChatOutcome =
  | {
      status: "done";
      images?: MapChatImages[];
      skippedCards?: number;
      basis?: MapChatBasis;
      note?: string;
      /** Replaces the action's label on the result line (a count of what was really done, not of what was proposed). */
      label?: string;
      /** The line is shown without "View details" (it tells the reader something to wait for). */
      loud?: boolean;
    }
  | { status: "skipped" | "failed"; reason: string; created?: boolean };
/** What the writes of one reply have made so far: the real id behind each `ref`, and the cards created, in order. */
export interface ChatRun {
  refs: Map<string, string>;
  /** `ref` of an `add_anchor` of this reply -> the real anchor id it was given (for the `link_anchor`s that name `anchor:<ref>`). */
  anchors?: Map<string, string>;
  created: string[];
  /** Pictures whose `link_anchor` in this reply marked a new top-level topic as a ring member: their rings are placed at the end. */
  ringImages?: Set<string>;
  /** Per picture with a ring made in this reply: whether it had ring members before the reply, and the members added. */
  ringAdded?: Map<string, { hadRing: boolean; topicIds: string[] }>;
  /** A card was (or may have been) written without rebuilding the derived data; one rebuild at the end of the reply does it. */
  ownershipDirty?: boolean;
  /** True for a held batch (five cards or more): its cards leave the derived data to the one rebuild at the end. */
  deferRebuild?: boolean;
  /** Cards whose note the reply wrote (or created): their files are part of the reply's undo check. */
  notes?: Set<string>;
  /** Markdown files the reply edited or created (vault paths): part of the reply's undo check. */
  files?: Set<string>;
  /** Where the notes of the cards the reply deleted now are (Unassigned): part of the reply's undo check, as the cards are gone from the map. */
  parked?: Set<string>;
  /** The cards a merge of this reply takes as sources: an appearance asked for them in the same reply goes to the merged card. */
  mergeSourceIds?: Set<string>;
  /** The appearance changes held back for the merged card (not written to the sources, which are parked by the merge). */
  held?: { action: Extract<MapChatAction, { kind: "set_appearance" }>; ids: string[] }[];
}
/** The appearance change a set_appearance action asks for (the topic panel's change shape). */
export const chatAppearanceChange = (
  action: Extract<MapChatAction, { kind: "set_appearance" }>
): TopicAppearanceChange => ({
  ...(action.color ? { color: action.color === "none" ? null : action.color } : {}),
  // Only whitelisted ids are written (V3.3 P1.10b): a retired id that reaches here is dropped, never stored.
  addMarkers: (action.markers ?? []).filter(isTopicMarker),
  removeMarkers: (action.removeMarkers ?? []).filter(id => id === "all" || isTopicMarker(id)),
  addStyles: action.formats ?? [],
  removeStyles: action.removeFormats ?? []
});
export const skipped = (key: TranslationKey): ChatOutcome => ({ status: "skipped", reason: t(key) });
const GUARD_REASON: Record<MapChatGuardCode, TranslationKey> = {
  outside_vault: "ui.map_chat_guard_outside_vault",
  config_dir: "ui.map_chat_guard_config_dir",
  not_markdown: "ui.map_chat_guard_not_markdown",
  map_unparseable: "ui.map_chat_guard_map_unparseable",
  map_file: "ui.map_chat_guard_map_file",
  duplicate_identity_key: "ui.map_chat_guard_duplicate_identity_key",
  topic_identity_changed: "ui.map_chat_guard_topic_identity_changed",
  reserved_frontmatter: "ui.map_chat_guard_reserved_frontmatter",
  hypothesis_frontmatter_changed: "ui.map_chat_guard_hypothesis_frontmatter_changed",
  exists: "ui.map_chat_guard_exists",
  no_baseline: "ui.map_chat_guard_no_baseline",
  map_source: "ui.map_chat_guard_map_source",
  living_node_protected: "ui.living_node_use_run_card"
};
export const guardSkipped = (code: MapChatGuardCode, editing = false): ChatOutcome =>
  skipped(editing && code === "reserved_frontmatter" ? "ui.map_chat_guard_identity_added" : GUARD_REASON[code]);
export type ChatWriteAction = Exclude<
  MapChatAction,
  {
    kind:
      | "select_topics"
      | "run_map_action"
      | "create_map"
      | "rename_map"
      | "open_map"
      | "ask_topic_kind"
      | "read_md_file"
      | "place_image";
  }
>;
export type ChatWriteBaseline = Pick<MapChatContext, "mdHashes" | "topicHashes" | "mapSourcePaths" | "bookPlan">;
export interface ChatWriterPorts {
  // Read from the view each time (never kept), so a view that has moved to another map or been closed is seen as it is now.
  map(): MapDocument | null;
  path(): string;
  plugin(): VisualAgentMapPlugin;
  notes(): Map<string, Note>;
  history(): { push(entry: { undo(): Promise<void>; redo(): Promise<void>; label?: string }): void };
  isMerging(nodeId: string): boolean;
  relationsEnabled(): boolean;
  topicKindOf(id: string): TopicKind;
  hypothesisLeaningOf(id: string): HypothesisLeaning | undefined;
  hypothesisStrengthOf(id: string): HypothesisStrength | undefined;
  mapChange(change: (map: MapDocument) => void, rebuildDerivedData?: boolean): Promise<void>;
  beginMapTransaction(): Transaction;
  app(): App;
  aiLockReason(
    op: AiLockOp,
    ids: readonly string[],
    fresh?: ReadonlyMap<string, Note>,
    options?: { to?: string | null }
  ): AiLockReason | null;
  freshNotes(): Promise<Map<string, Note>>;
  freshNotesOf(ids: readonly string[]): Promise<Map<string, Note>>;
  topicState(
    id: string,
    fresh?: Note
  ): { title: string; summary: string; detail: string; parentId: string | null } | null;
  addNode(
    parentNode: MapNode | null,
    suggestedTitle?: string,
    rebuildDerivedData?: boolean,
    focus?: boolean,
    kind?: TopicKind,
    keyboardFocus?: boolean,
    hypothesisStart?: { leaning?: HypothesisLeaning; strength?: HypothesisStrength }
  ): Promise<void>;
  /** Same prepublication configuration and creation path as the central editor. */
  createLivingNode?(
    parent: MapNode | null,
    action: Extract<MapChatAction, { kind: "add_child" }>,
    rebuildDerivedData: boolean,
    current: () => boolean,
    allowSource: (path: string) => boolean
  ): Promise<MapNode | undefined>;
  /** "discarded": the guarded commit refused the write (the note changed or got locked after the gate); nothing was written. */
  noteChange(node: MapNode, patch: NotePatch): Promise<"written" | "discarded">;
  moveTopic(node: MapNode, parent: MapNode): Promise<void>;
  removeToUnassignedEntry(node: MapNode, branch: boolean, adopterId?: string): Promise<TransactionEntry | undefined>;
  chatMoveBefore(node: MapNode, parent: MapNode, before: MapNode): Promise<boolean>;
  chatReorderChildren(parent: MapNode, ids: string[]): Promise<void>;
  arrangeAll(map: MapDocument): void;
  focusNode(target: MapNode): void;
  flushChatRender(): void;
  readChatFile(path: string): Promise<{ file: TFile; text: string; editor: Editor | null } | null>;
  chatFileText(path: string): Promise<string | null>;
  chatUndoRefusal(): Error;
  chatReadableNow(key: string): Promise<boolean>;
  /** An attached file the chat may only read: attached, not a chip of this message, and outside the map folder. */
  attachedReadOnly(key: string, baseline: object): boolean;
  noteChatOwnFile(path: string, text: string, created: boolean): void;
  /** The vault file at `path`, or null when there is none (or it is not a file). */
  fileOf(path: string): TFile | null;
  /** Writes an `edit_book_plan` reply to the cards of the book plan under review (see book-plan-chat.ts). */
  applyBookPlanEdit(
    action: Extract<MapChatAction, { kind: "edit_book_plan" }>,
    baseline: Pick<MapChatContext, "bookPlan">
  ): Promise<ChatOutcome>;
  /** Writes an `edit_book_thread` reply to the root note's thread lines. */
  applyBookThreadEdit(
    action: Extract<MapChatAction, { kind: "edit_book_thread" }>,
    baseline: Pick<MapChatContext, "bookPlan">
  ): Promise<ChatOutcome>;
  /** Applies an `edit_book_structure` reply through the book run (never the generic map writer). */
  applyBookStructureEdit(
    action: Extract<MapChatAction, { kind: "edit_book_structure" }>,
    baseline: Pick<MapChatContext, "bookPlan">
  ): Promise<ChatOutcome>;
}
/** Writes the actions of a map chat reply (one action at a time) to the map and the vault; the view keeps the loop and the undo step. */
export class ChatActionWriter {
  constructor(private readonly ports: ChatWriterPorts) {}
  private get map(): MapDocument | null {
    return this.ports.map();
  }
  private get path(): string {
    return this.ports.path();
  }
  private get plugin(): VisualAgentMapPlugin {
    return this.ports.plugin();
  }
  private get notes(): Map<string, Note> {
    return this.ports.notes();
  }
  private get history(): ReturnType<ChatWriterPorts["history"]> {
    return this.ports.history();
  }
  private get app(): App {
    return this.ports.app();
  }
  async write(
    action: Exclude<
      MapChatAction,
      {
        kind:
          | "select_topics"
          | "run_map_action"
          | "create_map"
          | "rename_map"
          | "open_map"
          | "ask_topic_kind"
          | "read_md_file"
          | "place_image";
      }
    >,
    baseline: ChatWriteBaseline,
    same: () => boolean,
    run: ChatRun
  ): Promise<ChatOutcome> {
    const hashes = baseline.mdHashes;
    // The shared AI write gate, owner part: the reply still writes to the map it was asked on.
    if (aiWriteGate({ owned: same() }).length || !this.map) return skipped("ui.map_chat_skip_map_changed");
    const nodeOf = (id: string): MapNode | undefined => this.map?.nodes.find(item => item.id === id);
    const gone = skipped("ui.map_chat_skip_topic_gone");
    const done: ChatOutcome = { status: "done" };
    if (action.kind === "edit_book_plan") return this.ports.applyBookPlanEdit(action, baseline);
    if (action.kind === "edit_book_thread") return this.ports.applyBookThreadEdit(action, baseline);
    if (action.kind === "edit_book_structure") return this.ports.applyBookStructureEdit(action, baseline);
    const configDir = this.app.vault.configDir;
    /** The real id behind an id of the reply; null when it names a card of this reply that was never created. */
    const real = (id: string): string | null =>
      id.startsWith(MAP_CHAT_NEW_PREFIX) ? (run.refs.get(id.slice(MAP_CHAT_NEW_PREFIX.length)) ?? null) : id;
    /** A card whose note is one of the map's data sources must not be rewritten through the card (same rule and reason as the file actions). */
    const sourceFileRefusal = (node: MapNode): ChatOutcome | null => {
      const verdict = guardMapChatWrite({
        kind: "edit",
        path: node.path,
        newContent: "",
        knownHashes: hashes,
        readOnlyPaths: baseline.mapSourcePaths,
        configDir
      });
      return !verdict.ok && verdict.code === "map_source" ? guardSkipped(verdict.code) : null;
    };
    // Authorize the actual resolved path, not just a preliminary display alias.
    const allowedLivingSource = (path: string, map: MapDocument | null = this.map): boolean => {
      const key = normalizeVaultPath(path);
      if (
        !key ||
        key !== path ||
        key.toLowerCase() === configDir.toLowerCase() ||
        key.toLowerCase().startsWith(configDir.toLowerCase() + "/")
      )
        return false;
      return (
        !!map?.nodes.some(item => item.path === key) ||
        Object.prototype.hasOwnProperty.call(hashes, key) === true ||
        !!baseline.mapSourcePaths?.includes(key)
      );
    };
    // AI lock: the real guard of the chat is here, on apply (a confirmation that comes later is checked again here).
    const locked = await this.chatLockSkip(action, real);
    if (locked) return locked;
    switch (action.kind) {
      case "add_child": {
        // An empty parent is a new root card.
        let parent: MapNode | null = null;
        if (action.parentId) {
          const parentId = real(action.parentId);
          if (parentId === null) return skipped("ui.map_chat_skip_parent_missing");
          parent = nodeOf(parentId) ?? null;
          if (!parent) return gone;
          if (this.ports.isMerging(parent.id)) return skipped("ui.map_chat_skip_merge_locked");
        }
        if (!same()) return skipped("ui.map_chat_skip_map_changed");
        if (action.livingPrompt) {
          if (!this.ports.createLivingNode || action.summary) return skipped("ui.map_chat_skip_unavailable");
          if (run.deferRebuild) run.ownershipDirty = true;
          const made = await this.ports.createLivingNode(parent, action, !run.deferRebuild, same, allowedLivingSource);
          if (!made) return skipped("ui.map_chat_skip_unavailable");
          run.created.push(made.id);
          run.notes?.add(made.id);
          if (action.ref) run.refs.set(action.ref, made.id);
          return done;
        }
        const before = new Set(this.map.nodes.map(item => item.id));
        // The derived data (every map is read for it) is rebuilt once, when the reply ends, not after each card; marked first so
        // a card that was written before the action failed is covered too.
        if (run.deferRebuild) run.ownershipDirty = true;
        // The type is written when the note is created, like "+ Topic" of that type (the parser dropped it on an AIM map).
        // Its leaning and strength go in the same creation (initial values), not a write after it.
        await this.ports.addNode(parent, action.title, !run.deferRebuild, false, action.topicKind ?? "topic", false, {
          leaning: action.leaning,
          strength: action.strength
        });
        const created = this.map?.nodes.find(item => !before.has(item.id));
        if (!created) return skipped("ui.map_chat_skip_unavailable");
        run.created.push(created.id);
        run.notes?.add(created.id);
        if (action.ref) run.refs.set(action.ref, created.id);
        if (action.summary && (await this.ports.noteChange(created, { summary: action.summary })) === "discarded")
          return skipped("ui.map_chat_skip_stale");
        return done;
      }
      case "configure_ai_card": {
        const id = real(action.nodeId);
        const node = id ? nodeOf(id) : undefined;
        if (!node) return gone;
        const sourceRefusal = sourceFileRefusal(node);
        if (sourceRefusal) return sourceRefusal;
        if (this.ports.isMerging(node.id)) return skipped("ui.map_chat_skip_merge_locked");
        const createdHere = action.nodeId.startsWith(MAP_CHAT_NEW_PREFIX) && run.created.includes(node.id);
        const repo = this.plugin.repo;
        const current = await repo.readNoteSnapshot(node.path, this.map ?? undefined);
        if (!same() || !this.map) return skipped("ui.map_chat_skip_map_changed");
        if (current.note.aiLocked) return skipped("ui.ai_locked_notice");
        // Existing ordinary cards cannot be implicitly converted by chat.
        if (current.note.aiCard !== true) return skipped("ui.living_node_chat_existing_only");
        const stamp = baseline.topicHashes[node.id]?.livingConfigRevision;
        // No stamp: the card went to the AI in the outline only (its saved Prompt was never shown), so it is not "changed".
        if (!createdHere && !stamp) return skipped("ui.map_chat_skip_topic_not_seen");
        if (!createdHere && stamp !== current.note.livingNode?.configRevision)
          return skipped("ui.map_chat_skip_topic_changed");
        // A model-generated new link may only name a card already in the map,
        // or a file authorized in this turn. Unchanged aliases retain their
        // persisted identities through the shared save preflight.
        const previous = new Set(promptSourceLinks(current.note.prompt));
        for (const link of promptSourceLinks(action.content)) {
          if (previous.has(link)) continue;
          const dest = this.app.metadataCache.getFirstLinkpathDest(link, node.path);
          if (!dest || !allowedLivingSource(dest.path)) return skipped("ui.living_node_chat_source_refused");
        }
        const mapPath = this.path;
        const mapId = this.map.id;
        const nodeId = node.id;
        const nodePath = node.path;
        const parentId = node.parentId;
        let firstCommit = true;
        let configured: LivingConfigSave | undefined;
        const stillCurrent = (): boolean => {
          if (!firstCommit) return true; // redo is guarded by the transaction's own preimage checks
          const live = this.map?.nodes.find(item => item.id === nodeId);
          return (
            same() &&
            this.path === mapPath &&
            this.map?.id === mapId &&
            live?.path === nodePath &&
            live?.parentId === parentId
          );
        };
        const entry = await this.ports
          .beginMapTransaction()
          .rewriteNote(nodePath, async path => {
            if (!stillCurrent()) throw new Error("changed-target");
            const liveMap = await repo.readMap(mapPath);
            const live = liveMap.nodes.find(item => item.id === nodeId);
            if (liveMap.id !== mapId || live?.path !== path || live.parentId !== parentId)
              throw new Error("changed-target-identity");
            configured = await saveLivingConfig(
              this.app,
              repo,
              liveMap,
              nodeId,
              action.content,
              current.note.prompt,
              stamp,
              stillCurrent,
              source => allowedLivingSource(source, liveMap),
              firstCommit ? undefined : configured?.sourceRevision
            );
          })
          .commit({ deferRebuild: true, label: t("ui.ai_card") });
        firstCommit = false;
        this.history.push(entry);
        run.notes?.add(node.id);
        const saved = await repo.readNote(node.path, this.map ?? undefined);
        this.notes.set(node.id, saved);
        await this.chatTopicAccept(node.id, baseline.topicHashes);
        return done;
      }
      case "set_topic_kind":
        return this.chatSetTopicKind(action, real, run);
      case "add_relation":
      case "remove_relation":
        return this.chatChangeRelation(action, real);
      case "add_anchor":
      case "link_anchor":
        return this.chatChangeAnchor(action, real, run);
      case "move_anchor":
        return this.chatMoveAnchor(action);
      case "set_appearance":
        return this.chatSetAppearance(action, real, run);
      case "collapse_topic":
      case "expand_topic": {
        this.ports.flushChatRender();
        const id = real(action.nodeId);
        if (id === null) return skipped("ui.map_chat_skip_parent_missing");
        const node = nodeOf(id);
        if (!node) return gone;
        if (!this.map.nodes.some(item => item.parentId === node.id)) return skipped("ui.map_chat_skip_no_children");
        const collapsed = action.kind === "collapse_topic";
        await this.ports.mapChange(map => {
          const target = map.nodes.find(item => item.id === node.id);
          if (target) target.collapsed = collapsed;
          this.ports.arrangeAll(map);
        });
        return done;
      }
      case "auto_layout":
        // The layout measures the cards, so a held repaint comes first.
        this.ports.flushChatRender();
        await this.ports.mapChange(map => {
          this.ports.arrangeAll(map);
        }, false);
        return done;
      case "focus_topic": {
        this.ports.flushChatRender();
        const id = real(action.nodeId);
        if (id === null) return skipped("ui.map_chat_skip_parent_missing");
        const node = nodeOf(id);
        if (!node) return gone;
        this.ports.focusNode(node);
        return done;
      }
      case "rename_topic":
      case "update_summary":
      case "edit_topic_note": {
        const node = nodeOf(action.nodeId);
        if (!node) return gone;
        const sourceRefusal = sourceFileRefusal(node);
        if (sourceRefusal) return sourceRefusal;
        // Model-written note body: same allow-list and parser check as an AI task result (a manual edit never comes here).
        // Done before the merge and stale checks so no await sits between the stale check and the write.
        const detail =
          action.kind === "edit_topic_note"
            ? await intakeAiMarkdownChecked(action.detail, { kind: "chat-topic-detail" }, this.plugin.mermaidSyntax)
            : "";
        if (this.ports.isMerging(node.id)) return skipped("ui.map_chat_skip_merge_locked");
        const changed = await this.chatTopicStale(node.id, baseline.topicHashes, action.kind === "edit_topic_note");
        if (changed) return changed;
        // The shared AI write gate on the card as the vault has it now (the stale check above read it again): a lock set
        // since the lock check is refused, and a Living Node card's content is read-only for the chat (its title is not).
        const now = this.notes.get(node.id);
        const blocked = aiWriteGate({
          owned: true,
          aiLocked: now?.aiLocked === true,
          readOnly: action.kind !== "rename_topic" && now?.aiCard === true
        });
        if (blocked.includes("ai_locked")) return skipped("ui.ai_locked_notice");
        if (blocked.includes("read_only")) return skipped("ui.living_node_use_run_card");
        run.notes?.add(node.id);
        const written = await this.ports.noteChange(
          node,
          action.kind === "rename_topic"
            ? { title: action.title }
            : action.kind === "update_summary"
              ? { summary: action.summary }
              : { detail }
        );
        if (written === "discarded") return skipped("ui.map_chat_skip_stale");
        await this.chatTopicAccept(node.id, baseline.topicHashes);
        return done;
      }
      case "move_topic": {
        const node = nodeOf(action.nodeId);
        const parentId = real(action.newParentId);
        if (parentId === null) return skipped("ui.map_chat_skip_parent_missing");
        const parent = nodeOf(parentId);
        if (!node || !parent) return gone;
        // The move rewrites the derived "Parent topic" / "Child topics" lines of the moved card and of both parents: a data source
        // among them would be rewritten, so the move is refused (the map file alone changes otherwise).
        const oldParent = node.parentId ? nodeOf(node.parentId) : undefined;
        for (const touched of [node, parent, oldParent]) {
          const sourceRefusal = touched ? sourceFileRefusal(touched) : null;
          if (sourceRefusal) return sourceRefusal;
        }
        if (this.ports.isMerging(node.id) || this.ports.isMerging(parent.id))
          return skipped("ui.map_chat_skip_merge_locked");
        const changed = await this.chatTopicStale(node.id, baseline.topicHashes);
        if (changed) return changed;
        if (!canParent(this.map.nodes, node.id, parent.id)) return skipped("ui.map_chat_skip_cycle");
        if (action.beforeId) {
          const beforeId = real(action.beforeId);
          if (beforeId === null) return skipped("ui.map_chat_skip_parent_missing");
          const before = nodeOf(beforeId);
          if (!before) return gone;
          // The moved card becomes a direct child, so only a direct child of the parent can stand behind it.
          if (before.id === node.id || before.parentId !== parent.id || before.afterTextId)
            return skipped("ui.map_chat_skip_not_sibling");
          if (!(await this.ports.chatMoveBefore(node, parent, before))) return skipped("ui.map_chat_skip_not_sibling");
        } else await this.ports.moveTopic(node, parent);
        await this.chatTopicAccept(node.id, baseline.topicHashes);
        return done;
      }
      case "reorder_topics": {
        const parentId = real(action.parentId);
        const ids = action.nodeIds.map(id => real(id));
        if (parentId === null || ids.some(id => id === null)) return skipped("ui.map_chat_skip_parent_missing");
        const parent = nodeOf(parentId);
        const kids = ids.map(id => nodeOf(id!));
        if (!parent || kids.some(kid => !kid)) return gone;
        if (this.ports.isMerging(parent.id) || kids.some(kid => this.ports.isMerging(kid!.id)))
          return skipped("ui.map_chat_skip_merge_locked");
        // Topics after a text block and direct children are not siblings of each other: a mixed list orders nothing.
        if (kids.some(kid => kid!.parentId !== parent.id || kid!.afterTextId !== kids[0]!.afterTextId))
          return skipped("ui.map_chat_skip_not_sibling");
        await this.ports.chatReorderChildren(parent, ids as string[]);
        return done;
      }
      case "delete_topic": {
        const node = nodeOf(action.nodeId);
        if (!node) return gone;
        const sourceRefusal = sourceFileRefusal(node);
        if (sourceRefusal) return sourceRefusal;
        if (this.ports.isMerging(node.id)) return skipped("ui.map_chat_skip_merge_locked");
        const changed = await this.chatTopicStale(node.id, baseline.topicHashes);
        if (changed) return changed;
        const removed = await this.ports.removeToUnassignedEntry(node, action.branch);
        for (const path of removed?.parkedPaths?.() ?? []) run.parked?.add(path);
        return done;
      }
      case "edit_md_file": {
        // Path rules first, so a refused place is named as such rather than as a missing or stale file.
        const early = guardMapChatWrite({
          kind: "edit",
          path: action.path,
          newContent: "",
          knownHashes: hashes,
          readOnlyPaths: baseline.mapSourcePaths,
          configDir
        });
        if (!early.ok) return guardSkipped(early.code);
        // An attached file outside the map folder is read-only (the chip of this very message keeps its old rules).
        const editKey = normalizeVaultPath(action.path);
        if (editKey && this.ports.attachedReadOnly(editKey, baseline))
          return skipped("ui.map_chat_skip_attached_read_only");
        let source = await this.ports.readChatFile(action.path);
        if (!source) return skipped("ui.map_chat_skip_file_missing");
        if (isMdStale(hashes, action.path, source.text)) return skipped("ui.map_chat_skip_stale");
        const raw = applyMdEdit(source.text, action.find, action.replace);
        if (raw === null) return skipped("ui.map_chat_skip_find_failed");
        // A line the replacement starts with an inline tag gets a harmless lead; fence and frontmatter state come from the
        // text after the edit, and only the inserted range changes. Checks, the write and the undo entry all use this result.
        const at = source.text.indexOf(action.find);
        // An image the rest of the file already has (outside the replaced text) is not embedded again by the edit.
        const tail = source.text.length - at - action.find.length;
        const next = intakeAiMarkdown(raw, { kind: "chat-file-edit", at, insertedLength: action.replace.length, tail });
        // Only the mermaid blocks the edit adds are judged (allow-list, then parser); what the note already had stays as it is.
        const added = addedMermaidBlocks(source.text, next);
        if (added.some(block => block.unsafe)) return skipped("ui.map_chat_skip_unsafe_mermaid");
        const check = this.plugin.mermaidSyntax;
        const codes = added.flatMap(block => (block.code?.trim() ? [block.code] : []));
        if (check && codes.length) {
          for (const code of codes) {
            const syntax = await check(code);
            if (syntax === "invalid") return skipped("ui.map_chat_skip_invalid_mermaid");
            if (syntax === "unavailable") {
              console.warn("Visual Agent Map edit mermaid unchecked");
              break;
            }
          }
          // The editor branch has no race check at the write, so the file is read again after the wait.
          const again = await this.ports.readChatFile(action.path);
          if (!again || again.text !== source.text) return skipped("ui.map_chat_skip_stale");
          source = again;
        } else if (added.some(block => block.code?.trim())) {
          console.warn("Visual Agent Map edit mermaid unchecked");
        }
        const verdict = guardMapChatWrite({
          kind: "edit",
          path: action.path,
          oldContent: source.text,
          newContent: next,
          parseFrontmatter: frontmatter,
          knownHashes: hashes,
          readOnlyPaths: baseline.mapSourcePaths,
          configDir
        });
        if (!verdict.ok) return guardSkipped(verdict.code, true);
        if (source.editor) {
          // The dedupe can drop a line whose newline belongs to the tail; then the changed range is found from the two texts,
          // so the editor ends up exactly as `next`, which the undo entry compares against.
          const before = source.text;
          let from = at;
          let to = at + action.find.length;
          let replace = next.slice(at, next.length - tail);
          if (!(
            next.startsWith(before.slice(0, at)) &&
            next.endsWith(before.slice(before.length - tail)) &&
            next.length >= at + tail
          )) {
            const limit = Math.min(before.length, next.length);
            from = 0;
            while (from < limit && before.charCodeAt(from) === next.charCodeAt(from)) from++;
            let rest = 0;
            while (
              rest < limit - from &&
              before.charCodeAt(before.length - 1 - rest) === next.charCodeAt(next.length - 1 - rest)
            )
              rest++;
            to = before.length - rest;
            replace = next.slice(from, next.length - rest);
          }
          source.editor.replaceRange(replace, source.editor.offsetToPos(from), source.editor.offsetToPos(to));
          this.recordChatFileEdit(source.file.path, source.text, next, run);
          if (editKey) hashes[editKey] = contentHash(next);
          return done;
        }
        let raced = false;
        await this.app.vault.process(source.file, current => {
          // The file moved on between the check and the write: leave it as it is.
          if (current !== source.text) {
            raced = true;
            return current;
          }
          return next;
        });
        if (raced) return skipped("ui.map_chat_skip_stale");
        this.recordChatFileEdit(source.file.path, source.text, next, run);
        // A later action of this reply edits on top of this write, not against the text that was sent.
        if (editKey) hashes[editKey] = contentHash(next);
        return done;
      }
      case "create_md_file": {
        const key = normalizeVaultPath(action.path);
        const exists = key ? !!this.app.vault.getAbstractFileByPath(key) : false;
        // Model-written file: same allow-list and parser check as an AI task result.
        const content = await intakeAiMarkdownChecked(
          action.content,
          { kind: "chat-new-file" },
          this.plugin.mermaidSyntax
        );
        const verdict = guardMapChatWrite({
          kind: "create",
          path: action.path,
          newContent: content,
          parseFrontmatter: frontmatter,
          exists,
          readOnlyPaths: baseline.mapSourcePaths,
          configDir
        });
        // An existing file inside the map folder is not created again (the model sees this text next round): a file this chat
        // wrote is read and then edited; any other one cannot be read here (read_md_file only reads own files), so a new name is asked.
        const mapFolder = this.path.slice(0, Math.max(0, this.path.lastIndexOf("/")));
        if (!verdict.ok && verdict.code === "exists" && mapFolder && key?.startsWith(`${mapFolder}/`))
          return skipped(
            (await this.ports.chatReadableNow(key))
              ? "ui.map_chat_guard_exists_in_map"
              : "ui.map_chat_guard_exists_not_own"
          );
        if (!verdict.ok || !key) return guardSkipped(verdict.ok ? "outside_vault" : verdict.code);
        const folders = key.split("/").slice(0, -1);
        for (let depth = 1; depth <= folders.length; depth++) {
          const folder = folders.slice(0, depth).join("/");
          if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
        }
        await this.app.vault.create(key, content);
        this.recordChatFileCreate(key, content, run);
        // A file this reply created can be edited by a later action of the same reply.
        hashes[key] = contentHash(content);
        return done;
      }
    }
  }
  /**
   * set_appearance: the colour, markers and styles of every target in one step, with the topic panel's rules (one colour,
   * one text size; unknown frontmatter values stay). Only the notes whose appearance
   * really changes are written; Map.md changes only its viewport. A card of an AIM map (or an AIM card) has none and is skipped.
   */
  async chatSetAppearance(
    action: Extract<MapChatAction, { kind: "set_appearance" }>,
    real: (id: string) => string | null,
    run?: ChatRun
  ): Promise<ChatOutcome> {
    if (!this.map || !this.ports.relationsEnabled()) return skipped("ui.map_chat_skip_unavailable");
    const nodes = action.nodeIds
      .map(id => real(id))
      .map(id => (id ? this.map?.nodes.find(node => node.id === id) : undefined))
      .filter((node): node is MapNode => !!node);
    if (!nodes.length) return skipped("ui.map_chat_skip_topic_gone");
    const editableAll = nodes.filter(node => this.notes.get(node.id));
    if (!editableAll.length) return skipped("ui.map_chat_skip_unavailable");
    if (editableAll.some(node => this.ports.isMerging(node.id))) return skipped("ui.map_chat_skip_merge_locked");
    // A card this reply merges is not coloured itself (the merge moves it to Unassigned): the merge applies the change to the
    // merged card instead. The ones not merged are written as usual.
    const heldIds = run?.mergeSourceIds ? editableAll.filter(node => run.mergeSourceIds?.has(node.id)) : [];
    if (heldIds.length) run?.held?.push({ action, ids: heldIds.map(node => node.id) });
    const editable = editableAll.filter(node => !heldIds.includes(node));
    // Named cards that are gone, belong to an AIM map or have no note are left out; the line says how many.
    const skippedCards =
      new Set(action.nodeIds.map(id => real(id) ?? id)).size - new Set(editableAll.map(node => node.id)).size;
    const done = (): ChatOutcome => (skippedCards > 0 ? { status: "done", skippedCards } : { status: "done" });
    const change = chatAppearanceChange(action);
    if (!editable.length) return done();
    const transaction = this.ports.beginMapTransaction();
    let changes = 0;
    for (const node of editable) {
      const note = this.notes.get(node.id);
      // The card's shown values decide whether anything changes (the write itself reads the note again).
      const shown = {
        "topic-color": note?.color,
        "topic-markers": note?.markers ?? [],
        "topic-style": note?.style ?? []
      };
      if (!Object.keys(topicAppearanceValues(shown, change)).length) continue;
      changes++;
      run?.notes?.add(node.id);
      transaction.rewriteNote(node.path, path => this.plugin.repo.writeTopicAppearance(path, change));
    }
    if (!changes) return done();
    const viewport = clone(this.map.viewport);
    const entry = await transaction
      .editMap(this.path, map => {
        map.viewport = clone(viewport);
      })
      .commit({ deferRebuild: true, label: t("ui.topic_appearance") });
    // Inside a reply this joins the reply's one undo step (see applyMapChatActions).
    this.history.push(entry);
    return done();
  }
  /**
   * add_relation / remove_relation: the same Map.md write as a relation added or removed by hand (`addRelation`,
   * `removeRelation`), checked again on the map being edited with the same rule (`relationAllowed`): a self link, a second
   * relation on a pair and a derivation or prerequisite cycle are refused. Never on an AIM map or an AIM card.
   */
  private async chatChangeRelation(
    action: Extract<MapChatAction, { kind: "add_relation" | "remove_relation" }>,
    real: (id: string) => string | null
  ): Promise<ChatOutcome> {
    if (!this.map || !this.ports.relationsEnabled()) return skipped("ui.map_chat_skip_unavailable");
    const fromId = real(action.fromId),
      toId = real(action.toId);
    if (fromId === null || toId === null) return skipped("ui.map_chat_skip_parent_missing");
    // An end is a card of this map or (adding only) one of its knowledge references, never both ends references (V3.3 P4.4).
    const endsOf = (map: MapDocument): { gone: boolean; bothRefs: boolean } => {
      const refIds = new Set(readKnowledgeRefs(map).map(ref => ref.id));
      const kinds = [fromId, toId].map(id =>
        map.nodes.some(node => node.id === id) ? "card" : refIds.has(id) ? "ref" : "gone"
      );
      return { gone: kinds.includes("gone"), bothRefs: kinds[0] === "ref" && kinds[1] === "ref" };
    };
    const early0 = endsOf(this.map);
    if (early0.gone) return skipped("ui.map_chat_skip_topic_gone");
    if (early0.bothRefs) return skipped("ui.map_chat_skip_relation_not_allowed");
    const pair = (link: TopicRelation): boolean =>
      (link.from === fromId && link.to === toId) || (link.from === toId && link.to === fromId);
    const link: TopicRelation = {
      kind: action.kind === "add_relation" ? action.relationKind : "related",
      from: fromId,
      to: toId
    };
    /** Why the change cannot be made on `list`; null when it can. */
    const refusal = (list: readonly TopicRelation[]): TranslationKey | null =>
      action.kind === "remove_relation"
        ? list.some(pair)
          ? null
          : "ui.map_chat_skip_relation_missing"
        : relationAllowed(list, link)
          ? null
          : "ui.map_chat_skip_relation_not_allowed";
    // Checked on the map on screen first (nothing is written for a refused one), then again inside the write.
    const early = refusal(this.map.topicRelations ?? []);
    if (early) return skipped(early);
    const box: { refused: TranslationKey | null } = { refused: null };
    await this.ports.mapChange(map => {
      const list = map.topicRelations ?? [];
      // The write is checked again on the map being edited: a reference may have been removed since.
      const now = endsOf(map);
      box.refused =
        action.kind === "add_relation" && now.gone
          ? "ui.map_chat_skip_topic_gone"
          : now.bothRefs
            ? "ui.map_chat_skip_relation_not_allowed"
            : refusal(list);
      if (box.refused) return;
      if (action.kind === "remove_relation") {
        setTopicRelations(
          map,
          list.filter(item => !pair(item))
        );
        return;
      }
      const description = action.description ? normalizeRelationDescription(action.description) : undefined;
      setTopicRelations(map, [...list, description ? { ...link, description } : link]);
    }, false);
    return box.refused ? skipped(box.refused) : { status: "done" };
  }
  /**
   * add_anchor / link_anchor: the same Map.md write as an anchor placed or linked by hand (`addAnchor`, `addAnchorRelation`),
   * checked again against the map being edited, so a picture that was deleted, turned back into an ordinary one, already full or
   * a pair that already has a relation skips only that item. The anchor id is made here (never taken from the reply) and does not
   * collide with a card or an anchor of the picture. Never on an AIM map.
   */
  private async chatChangeAnchor(
    action: Extract<MapChatAction, { kind: "add_anchor" | "link_anchor" }>,
    real: (id: string) => string | null,
    run: ChatRun
  ): Promise<ChatOutcome> {
    if (!this.map || !this.ports.relationsEnabled()) return skipped("ui.map_chat_skip_unavailable");
    const items = this.map.canvasItems ?? [];
    const image = findAnnotatedImage(items, action.imageId);
    if (!image)
      return skipped(
        items.some(item => item.id === action.imageId && item.kind === "image")
          ? "ui.map_chat_skip_image_plain"
          : "ui.map_chat_skip_image_gone"
      );
    if (action.kind === "add_anchor") {
      if (image.anchors.length >= ANCHOR_LIMIT) return skipped("ui.map_chat_skip_anchor_limit");
      const taken = new Set([...this.map.nodes.map(node => node.id), ...image.anchors.map(anchor => anchor.id)]);
      let anchorId: string;
      do anchorId = `anc-${randomUUID().slice(0, 8)}`;
      while (taken.has(anchorId));
      const box: { refused: TranslationKey | null } = { refused: null };
      await this.ports.mapChange(map => {
        const current = findAnnotatedImage(map.canvasItems ?? [], action.imageId);
        if (!current) box.refused = "ui.map_chat_skip_image_gone";
        else if (current.anchors.length >= ANCHOR_LIMIT) box.refused = "ui.map_chat_skip_anchor_limit";
        else
          map.canvasItems = addAnchor(map.canvasItems ?? [], action.imageId, {
            id: anchorId,
            at: { kind: "image-2d", x: action.x, y: action.y },
            ...(action.note ? { note: action.note } : {})
          });
      }, false);
      if (box.refused) return skipped(box.refused);
      (run.anchors ??= new Map()).set(action.ref, anchorId);
      return { status: "done" };
    }
    const anchorId = action.anchorId.startsWith(MAP_CHAT_ANCHOR_PREFIX)
      ? run.anchors?.get(action.anchorId.slice(MAP_CHAT_ANCHOR_PREFIX.length))
      : action.anchorId;
    // An anchor of this reply that was never placed (skipped) has nothing to link.
    if (!anchorId || !image.anchors.some(anchor => anchor.id === anchorId))
      return skipped("ui.map_chat_skip_anchor_gone");
    const nodeId = real(action.nodeId);
    if (nodeId === null) return skipped("ui.map_chat_skip_parent_missing");
    if (!this.map.nodes.some(node => node.id === nodeId)) return skipped("ui.map_chat_skip_topic_gone");
    const link: AnchorRelation = {
      kind: action.relationKind,
      from: anchorId,
      to: nodeId,
      ...(action.description ? { description: action.description } : {})
    };
    if (!anchorRelationAllowed(image, link)) return skipped("ui.map_chat_skip_relation_not_allowed");
    const box: { refused: TranslationKey | null; ring: boolean; hadRing: boolean } = {
      refused: null,
      ring: false,
      hadRing: false
    };
    await this.ports.mapChange(map => {
      const current = findAnnotatedImage(map.canvasItems ?? [], action.imageId);
      if (!current) {
        box.refused = "ui.map_chat_skip_image_gone";
        return;
      }
      // A top-level topic this reply made joins the picture's ring; one that already existed, or hangs under a parent, does not.
      const topic = map.nodes.find(node => node.id === nodeId);
      const ring =
        !!topic &&
        !topic.parentId &&
        run.created.includes(nodeId) &&
        !ringMemberIds(map.nodes, map.canvasItems ?? []).has(nodeId);
      const marked: AnchorRelation = ring ? { ...link, ring: true } : link;
      if (!anchorRelationAllowed(current, marked)) box.refused = "ui.map_chat_skip_relation_not_allowed";
      else {
        box.hadRing = ringMembers(map.canvasItems ?? [], map.nodes).some(member => member.imageId === action.imageId);
        map.canvasItems = addAnchorRelation(map.canvasItems ?? [], action.imageId, marked);
        box.ring = ring;
      }
    }, false);
    if (box.refused) return skipped(box.refused);
    if (box.ring) {
      (run.ringImages ??= new Set()).add(action.imageId);
      const added = ((run.ringAdded ??= new Map()).get(action.imageId) ?? {
        hadRing: box.hadRing,
        topicIds: []
      }) as { hadRing: boolean; topicIds: string[] };
      added.topicIds.push(nodeId);
      run.ringAdded.set(action.imageId, added);
    }
    return { status: "done" };
  }
  /**
   * move_anchor (G06a): runs only from a confirmed plan. The same Map.md write as dragging an anchor by hand (`updateAnchor`),
   * checked again against the map being edited: a picture that was deleted or turned back into an ordinary one, or an anchor
   * that is gone, is stale and writes nothing. Never on an AIM map.
   */
  private async chatMoveAnchor(action: Extract<MapChatAction, { kind: "move_anchor" }>): Promise<ChatOutcome> {
    if (!this.map || !this.ports.relationsEnabled()) return skipped("ui.map_chat_skip_unavailable");
    const items = this.map.canvasItems ?? [];
    const image = findAnnotatedImage(items, action.imageId);
    if (!image)
      return skipped(
        items.some(item => item.id === action.imageId && item.kind === "image")
          ? "ui.map_chat_skip_image_plain"
          : "ui.map_chat_skip_image_gone"
      );
    /** Why this write is stale or cannot move the anchor now; null = it can. */
    const refusal = (current: AnnotatedImageItem): TranslationKey | null => {
      // The picture file was replaced since the suggestion: the position was meant for another picture.
      if (action.imageRef !== undefined && current.path !== action.imageRef) return "ui.map_chat_skip_image_gone";
      const anchor = current.anchors.find(entry => entry.id === action.anchorId);
      // Only a 2D position can be moved; never answer "done" without moving.
      return anchor && isImage2dAnchor(anchor) ? null : "ui.map_chat_skip_anchor_gone";
    };
    const early = refusal(image);
    if (early) return skipped(early);
    const box: { refused: TranslationKey | null } = { refused: null };
    await this.ports.mapChange(map => {
      const current = findAnnotatedImage(map.canvasItems ?? [], action.imageId);
      box.refused = current ? refusal(current) : "ui.map_chat_skip_image_gone";
      if (!box.refused)
        map.canvasItems = updateAnchor(map.canvasItems ?? [], action.imageId, action.anchorId, {
          at: { x: action.x, y: action.y }
        });
    }, false);
    return box.refused ? skipped(box.refused) : { status: "done" };
  }
  /**
   * set_topic_kind: the same write as the Topic type menu (`changeTopicKind`, plus the strength of a hypothesis), for every
   * target in one step. Only the note's frontmatter changes: never the title, the body, the id, the parent or a relation. A card
   * of an AIM map (or an AIM card) has no type and is skipped; a card that already has the type and strength is left alone.
   */
  private async chatSetTopicKind(
    action: Extract<MapChatAction, { kind: "set_topic_kind" }>,
    real: (id: string) => string | null,
    run?: ChatRun
  ): Promise<ChatOutcome> {
    if (!this.map || !this.ports.relationsEnabled()) return skipped("ui.map_chat_skip_unavailable");
    const nodes = action.nodeIds
      .map(id => real(id))
      .map(id => (id ? this.map?.nodes.find(node => node.id === id) : undefined))
      .filter((node): node is MapNode => !!node);
    if (!nodes.length) return skipped("ui.map_chat_skip_topic_gone");
    const typed = nodes;
    if (typed.some(node => this.ports.isMerging(node.id))) return skipped("ui.map_chat_skip_merge_locked");
    const kind = action.topicKind;
    const transaction = this.ports.beginMapTransaction();
    let changes = 0;
    for (const node of typed) {
      const kindChanges = this.ports.topicKindOf(node.id) !== kind;
      const hypothesis = kind === "hypothesis";
      // A card that becomes a hypothesis starts undecided with strength none (nothing is written for what is not given);
      // a hypothesis is compared by the values it shows now, and the values written are the consistent ones.
      const current: { leaning: HypothesisLeaning; strength: HypothesisStrength } =
        !kindChanges && hypothesis
          ? {
              leaning: this.ports.hypothesisLeaningOf(node.id) ?? "undecided",
              strength: this.ports.hypothesisStrengthOf(node.id) ?? "none"
            }
          : { leaning: "undecided", strength: "none" };
      const target = resolveHypothesisWrite(current, {
        leaning: hypothesis ? action.leaning : undefined,
        strength: hypothesis ? action.strength : undefined
      });
      const leaningWrite = hypothesis && !!action.leaning && (kindChanges || target.leaning !== current.leaning);
      const strengthWrite =
        hypothesis && !!action.strength && (kindChanges || leaningWrite || target.strength !== current.strength);
      if (!kindChanges && !leaningWrite && !strengthWrite) continue;
      changes++;
      run?.notes?.add(node.id);
      transaction.rewriteNote(node.path, async path => {
        if (kindChanges) await this.plugin.repo.writeTopicKind(path, kind);
        if (leaningWrite) await this.plugin.repo.writeHypothesisLeaning(path, target.leaning);
        if (strengthWrite) await this.plugin.repo.writeHypothesisStrength(path, target.strength);
      });
    }
    if (!changes) return { status: "done" };
    const viewport = clone(this.map.viewport);
    const entry = await transaction
      .editMap(this.path, map => {
        map.viewport = clone(viewport);
      })
      .commit({ deferRebuild: true, label: t("ui.topic_type") });
    // Inside a reply this joins the reply's one undo step (see applyMapChatActions).
    this.history.push(entry);
    return { status: "done" };
  }
  /**
   * The AI lock of a map chat write, read from disk at apply time (so a lock set after the reply was proposed still
   * counts): what the tool would change, add under, move or remove. Null when the write may go ahead.
   */
  private async chatLockSkip(
    action: Exclude<
      MapChatAction,
      {
        kind:
          | "select_topics"
          | "run_map_action"
          | "create_map"
          | "rename_map"
          | "open_map"
          | "ask_topic_kind"
          | "read_md_file";
      }
    >,
    real: (id: string) => string | null
  ): Promise<ChatOutcome | null> {
    const refused: ChatOutcome = skipped("ui.ai_locked_notice");
    const check = async (op: AiLockOp, ids: (string | null)[], to?: string | null): Promise<ChatOutcome | null> => {
      const known = ids.filter((id): id is string => !!id);
      if (!known.length) return null;
      const involved = [...known, ...(to ? [to] : [])];
      // The parents, the subtree and the related cards count too, so every card of the map is read when one may be removed.
      const fresh =
        op === "remove" || op === "move" ? await this.ports.freshNotes() : await this.ports.freshNotesOf(involved);
      return this.ports.aiLockReason(op, known, fresh, to === undefined ? undefined : { to }) ? refused : null;
    };
    switch (action.kind) {
      case "add_child":
        return action.parentId ? check("addChild", [real(action.parentId)]) : null;
      case "set_topic_kind":
      case "set_appearance":
        return check(
          "write",
          action.nodeIds.map(id => real(id))
        );
      case "configure_ai_card":
        return check("write", [real(action.nodeId)]);
      case "rename_topic":
      case "update_summary":
      case "edit_topic_note":
        return check("write", [action.nodeId]);
      case "collapse_topic":
      case "expand_topic":
        return check("write", [real(action.nodeId)]);
      case "move_topic":
        return check("move", [action.nodeId], real(action.newParentId));
      case "reorder_topics":
        return check(
          "move",
          action.nodeIds.map(id => real(id)),
          real(action.parentId)
        );
      // A relation writes both end notes' lines and Map.md: a locked end refuses it (the end cards can be ones of this reply).
      case "add_relation":
      case "remove_relation":
        return check("write", [real(action.fromId), real(action.toId)]);
      // An anchor relation is written to the card's note like a topic relation; its anchor end is no card.
      case "link_anchor":
        return check("write", [real(action.nodeId)]);
      case "delete_topic":
        return check("remove", [action.nodeId]);
      case "edit_md_file": {
        const key = normalizeVaultPath(action.path);
        if (!key) return null;
        const node = this.map?.nodes.find(item => item.path === key);
        if (node) return check("write", [node.id]);
        // A note that is not a card of this map: its own frontmatter decides.
        const file = this.ports.fileOf(key);
        const frontmatter = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
        return frontmatter && readAiLocked(frontmatter) ? refused : null;
      }
      default:
        return null;
    }
  }
  /** The card as the vault has it right now (the view's cache can be a debounce behind a user's edit); the cache is refreshed too. */
  private async chatTopicNow(
    id: string
  ): Promise<{ title: string; summary: string; detail: string; parentId: string | null } | null> {
    const node = this.map?.nodes.find(item => item.id === id);
    if (!node) return null;
    let fresh: Note | undefined;
    try {
      fresh = await this.plugin.repo.readNote(node.path, this.map ?? undefined);
    } catch {
      return null;
    }
    this.notes.set(id, fresh);
    return this.ports.topicState(id, fresh);
  }
  /**
   * The reason to skip a card action, or null when the card is as the model saw it. Title and parent are always compared;
   * the summary and the Detail text only when the card was sent in full. `edit_topic_note` replaces the whole body, so it
   * needs a Detail baseline: a card the model saw only in the outline is never overwritten.
   */
  private async chatTopicStale(
    id: string,
    topicHashes: Readonly<Record<string, MapChatTopicHash>>,
    needsDetail = false
  ): Promise<ChatOutcome | null> {
    const seen = Object.prototype.hasOwnProperty.call(topicHashes, id) ? topicHashes[id] : undefined;
    const now = await this.chatTopicNow(id);
    if (!seen || !now) return skipped("ui.map_chat_skip_topic_changed");
    if (needsDetail && seen.detailHash === undefined) return skipped("ui.map_chat_skip_topic_not_seen");
    if (
      seen.title !== now.title ||
      seen.parentId !== now.parentId ||
      (seen.summary !== undefined && seen.summary !== now.summary) ||
      (seen.detailHash !== undefined && seen.detailHash !== contentHash(now.detail))
    )
      return skipped("ui.map_chat_skip_topic_changed");
    return null;
  }
  /** After this reply's own write to a card, its baseline follows, so a second action in the same reply is not mistaken for a user edit. */
  private async chatTopicAccept(id: string, topicHashes: Record<string, MapChatTopicHash>): Promise<void> {
    const seen = topicHashes[id];
    const now = await this.chatTopicNow(id);
    if (!seen || !now) return;
    topicHashes[id] = {
      title: now.title,
      parentId: now.parentId,
      ...(seen.summary !== undefined ? { summary: now.summary } : {}),
      ...(seen.detailHash !== undefined ? { detailHash: contentHash(now.detail) } : {}),
      ...(seen.livingConfigRevision !== undefined && this.notes.get(id)?.livingNode?.configRevision
        ? { livingConfigRevision: this.notes.get(id)!.livingNode!.configRevision }
        : {})
    };
  }
  /** Writes `text` to the file, through its open editor when there is one, so the editor and the file stay one. */
  private async chatWriteFile(path: string, expected: string, text: string): Promise<void> {
    const source = await this.ports.readChatFile(path);
    if (!source || source.text !== expected || source.file.path !== path) throw this.ports.chatUndoRefusal();
    if (source.editor) {
      // No await between the live editor comparison and replacement.
      if (source.editor.getValue() !== expected) throw this.ports.chatUndoRefusal();
      source.editor.setValue(text);
    } else {
      await this.app.vault.process(source.file, current => {
        // Vault.process may wait behind another writer. Compare the actual preimage.
        if (source.file.path !== path || current !== expected) throw this.ports.chatUndoRefusal();
        return text;
      });
    }
  }
  /** edit_md_file as an undo entry: undo puts the old text back, redo the new one, each only over the text it expects. */
  private recordChatFileEdit(path: string, before: string, after: string, run: ChatRun): void {
    run.files?.add(path);
    this.ports.noteChatOwnFile(path, after, false);
    const swap = async (expected: string, replacement: string): Promise<void> => {
      await this.chatWriteFile(path, expected, replacement);
    };
    this.history.push({ undo: () => swap(after, before), redo: () => swap(before, after) });
  }
  /** create_md_file as an undo entry: undo moves the file to the trash, redo creates it again, each only when nothing changed. */
  private recordChatFileCreate(path: string, content: string, run: ChatRun): void {
    run.files?.add(path);
    this.ports.noteChatOwnFile(path, content, true);
    this.history.push({
      undo: async () => {
        const file = this.ports.fileOf(path);
        if (!file || (await this.ports.chatFileText(path)) !== content) throw this.ports.chatUndoRefusal();
        await this.app.fileManager.trashFile(file);
      },
      redo: async () => {
        if (this.app.vault.getAbstractFileByPath(path)) throw this.ports.chatUndoRefusal();
        const folders = path.split("/").slice(0, -1);
        for (let depth = 1; depth <= folders.length; depth++) {
          const folder = folders.slice(0, depth).join("/");
          if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
        }
        await this.app.vault.create(path, content);
      }
    });
  }
}
