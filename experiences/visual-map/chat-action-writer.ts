import {
  addAnchor,
  addAnchorRelation,
  anchorRelationAllowed,
  ANCHOR_LIMIT,
  findAnnotatedImage,
  type AnchorRelation
} from "./canvas-items";
import type { Transaction } from "./map-transaction";
import { randomUUID } from "node:crypto";
import { t, type TranslationKey } from "../../i18n";
import {
  clone,
  type MapDocument,
  type MapNode,
  normalizeRelationDescription,
  relationAllowed,
  setTopicRelations,
  type TopicRelation
} from "../../map-model";
import { ringMemberIds } from "../../map-layout-text";
import { ringMembers } from "./image-ring";
import { type Note, topicAppearanceValues, type TopicAppearanceChange } from "../../repository";
import {
  resolveHypothesisWrite,
  type HypothesisLeaning,
  type HypothesisStrength,
  type TopicKind
} from "../../note-values";
import type { MapChatImages } from "./map-chat";
import type { MapChatBasis } from "../../core/map-chat-basis";
import type { MapChatGuardCode } from "../../core/map-chat-guard";
import { MAP_CHAT_ANCHOR_PREFIX, type MapChatAction } from "../../core/steps/map-chat/step";
import type VisualAgentMapPlugin from "../../main";

/** What one chat action came to: written, skipped with a reason (shown in the chat), or failed. */
export type ChatOutcome =
  | { status: "done"; images?: MapChatImages[]; skippedCards?: number; basis?: MapChatBasis }
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
  addMarkers: action.markers ?? [],
  removeMarkers: action.removeMarkers ?? [],
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
  map_source: "ui.map_chat_guard_map_source"
};
export const guardSkipped = (code: MapChatGuardCode, editing = false): ChatOutcome =>
  skipped(editing && code === "reserved_frontmatter" ? "ui.map_chat_guard_identity_added" : GUARD_REASON[code]);
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
  /**
   * set_appearance: the colour, markers and styles of every target in one step, with the topic panel's rules (one colour, one
   * value per single-choice marker group, one text size; unknown frontmatter values stay). Only the notes whose appearance
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
  async chatChangeRelation(
    action: Extract<MapChatAction, { kind: "add_relation" | "remove_relation" }>,
    real: (id: string) => string | null
  ): Promise<ChatOutcome> {
    if (!this.map || !this.ports.relationsEnabled()) return skipped("ui.map_chat_skip_unavailable");
    const fromId = real(action.fromId),
      toId = real(action.toId);
    if (fromId === null || toId === null) return skipped("ui.map_chat_skip_parent_missing");
    const ends = [fromId, toId].map(id => this.map?.nodes.find(node => node.id === id));
    if (ends.some(node => !node)) return skipped("ui.map_chat_skip_topic_gone");
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
      box.refused = refusal(list);
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
  async chatChangeAnchor(
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
   * set_topic_kind: the same write as the Topic type menu (`changeTopicKind`, plus the strength of a hypothesis), for every
   * target in one step. Only the note's frontmatter changes: never the title, the body, the id, the parent or a relation. A card
   * of an AIM map (or an AIM card) has no type and is skipped; a card that already has the type and strength is left alone.
   */
  async chatSetTopicKind(
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
}
