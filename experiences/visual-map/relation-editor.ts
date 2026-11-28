import type { App } from "obsidian";
import { Modal, Notice } from "obsidian";
import { t } from "../../i18n";
import {
  legalRelationTargets,
  type MapDocument,
  type MapNode,
  normalizeRelationDescription,
  RELATION_DESCRIPTION_MAX_LENGTH,
  relationAllowed,
  setTopicRelations,
  type TopicRelation,
  type TopicRelationKind
} from "../../map-model";
import type { Note } from "../../repository";
import { createCardSearchField, type CardSearchSource } from "../../ui/card-search-field";
import { AnchorPickModal, type AnchorPickEntry } from "./annotated-image-modals";
import {
  addAnchorRelation,
  anchorRelationAllowed,
  anchorRelationsForTopic,
  findAnnotatedImage,
  isAnnotatedImage,
  isImage2dAnchor,
  removeAnchorRelation,
  updateAnchorRelation,
  type AnchorRelation,
  type CanvasItem
} from "./canvas-items";
import type { TopicSelection } from "./topic-selection";

/** A line sample's counter: every sample's arrowhead marker needs an id of its own. */
let relationSwatchSequence = 0;

const RELATION_KINDS: readonly TopicRelationKind[] = [
  "supports",
  "contradicts",
  "verifies",
  "derives_from",
  "related",
  "prerequisite"
];
/** One sentence per kind, "A ... B" with A the source and B the target, worded for each language rather than by word order. */
const RELATION_SENTENCE_KEY: Record<Exclude<TopicRelationKind, "related">, Parameters<typeof t>[0]> = {
  supports: "ui.relation_sentence_supports_0_1",
  contradicts: "ui.relation_sentence_contradicts_0_1",
  verifies: "ui.relation_sentence_verifies_0_1",
  derives_from: "ui.relation_sentence_derives_from_0_1",
  prerequisite: "ui.relation_sentence_prerequisite_0_1"
};
export const RELATION_NAME_KEY: Record<TopicRelationKind, Parameters<typeof t>[0]> = {
  supports: "ui.relation_name_supports",
  contradicts: "ui.relation_name_contradicts",
  verifies: "ui.relation_name_verifies",
  derives_from: "ui.relation_name_derives_from",
  related: "ui.relation_name_related",
  prerequisite: "ui.relation_name_prerequisite"
};
/** The key a relation line is known by (view state only): `from`, `to` and kind. */
export const relationIdentity = (r: Pick<TopicRelation, "kind" | "from" | "to">): string =>
  `${r.from}\u0000${r.to}\u0000${r.kind}`;
/** The same key for both directions: a pair of topics holds one relation (spec V1.7). */
export function relationPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
/** The key an anchor relation line is known by (view state only). */
export const anchorLineKey = (imageId: string, anchorId: string, topicId: string): string =>
  `anchor:${imageId}:${anchorId}:${topicId}`;

/** The end of an anchor relation the editor is opened for: the image, its anchor and the topic at the other end. */
export interface AnchorEnd {
  imageId: string;
  anchorId: string;
  topicId: string;
}
/** One structure panel's focus targets, kept across its repaints. */
export interface RelationListFocus {
  editByPair: Map<string, HTMLElement>;
  anchorEdit: Map<string, HTMLElement>;
  addControl: HTMLElement | null;
}
/** What the relation editor reads from, and asks of, its view; each is called when it is needed (the view's members may be replaced). */
export interface RelationEditorPorts {
  app(): App;
  map(): MapDocument | null;
  notes(): ReadonlyMap<string, Note>;
  /** The visible text of a knowledge-reference end (its card title and source map, or the unavailable text); null when `id` is not a reference. Never the internal id. */
  refLabel(id: string): string | null;
  selection(): Pick<TopicSelection, "selectRelation" | "deselectRelation">;
  relationsEnabled(): boolean;
  anchorEditable(): boolean;
  enqueue(work: () => Promise<void>): void;
  mapChange(change: (map: MapDocument) => void, rebuildDerivedData: boolean): Promise<void>;
  changeCanvasItems(id: string, change: (items: readonly CanvasItem[]) => CanvasItem[]): Promise<void>;
  addRelation(from: string, to: string, kind: TopicRelationKind): Promise<void>;
  removeRelation(link: TopicRelation): Promise<void>;
  syncRelationClasses(): void;
  button(parent: HTMLElement, text: string, action: () => void, disabled?: boolean): HTMLButtonElement;
  iconButton(parent: HTMLElement, icon: string, label: string, action: (event: MouseEvent) => void): HTMLButtonElement;
  bindRelationRow(row: HTMLElement, link: TopicRelation, ariaLabel: string, key?: string): void;
  markerId(): string;
  marker(id: string, barred: boolean): SVGMarkerElement;
  cardSearchSources(include: (node: MapNode) => boolean, enabled?: (node: MapNode) => boolean): CardSearchSource[];
  startPickingAnchorImage(topicId: string, kind: TopicRelationKind): void;
  /** The view's wrapper, so a test that replaces it on the view is still the one called. */
  openRelationEditor(link: TopicRelation, onChanged?: () => void, onClosed?: () => void): void;
  openAnchorRelationEditor(ref: AnchorEnd, onChanged?: () => void, onClosed?: () => void): void;
}

/** The relation editor: the structure panel's relation list and add row, both editor dialogs, and the anchor pick dialog. */
export class RelationEditor {
  constructor(private readonly ports: RelationEditorPorts) {}
  /** The structure panel's relations: every link that starts or ends at `node`, the add row, and the focus handling after a repaint. */
  renderList(
    body: HTMLElement,
    node: MapNode,
    focus: RelationListFocus,
    repaint: () => void,
    onAdded: () => void,
    focusAdd: boolean,
    close?: () => void
  ): void {
    // Relations: every link that starts or ends at this topic, whatever its kind.
    focus.editByPair.clear();
    focus.anchorEdit.clear();
    const links = (this.ports.map()?.topicRelations ?? []).filter(r => r.from === node.id || r.to === node.id);
    body.createEl("strong", { text: t("ui.relations_heading"), cls: "vam-topic-tree-heading vam-section-heading" });
    const anchored = anchorRelationsForTopic(this.ports.map()?.canvasItems ?? [], node.id);
    if (links.length || anchored.length) {
      const list = body.createEl("ul", { cls: "vam-relation-list" });
      for (const link of links) {
        const row = list.createEl("li", { cls: "vam-relation-row" }),
          text = this.relationRowText(link, node.id),
          described = link.description ? `${text}. ${link.description}` : text;
        this.ports.bindRelationRow(row, link, described);
        this.relationSwatch(row, link.kind);
        const label = row.createSpan({ cls: "vam-relation-title", attr: { dir: "auto" } });
        label.createSpan({
          text: this.relationSentence(link, node.id),
          cls: "vam-relation-sentence",
          attr: { dir: "auto" }
        });
        if (link.description)
          label.createSpan({ text: link.description, cls: "vam-relation-description-text", attr: { dir: "auto" } });
        const tools = row.createSpan({ cls: "vam-relation-tools" });
        const pair = relationPairKey(link.from, link.to);
        // After the editor closes, focus goes to this pair's edit button as last painted (a pair has one relation),
        // or to "Add relation…" when the relation was deleted.
        const edit = this.ports.iconButton(tools, "pencil", t("ui.edit_relation_0", text), () =>
          this.ports.openRelationEditor(link, repaint, () => (focus.editByPair.get(pair) ?? focus.addControl)?.focus())
        );
        focus.editByPair.set(pair, edit);
        this.ports.iconButton(tools, "trash-2", t("ui.remove_relation_0", text), () =>
          this.ports.enqueue(async () => {
            await this.ports.removeRelation(link);
            repaint();
          })
        );
      }
      for (const ref of anchored) this.renderAnchorRelationRow(list, node, ref, repaint, focus.anchorEdit);
    } else body.createEl("p", { cls: "vam-hint vam-relation-empty", text: t("ui.relations_none") });
    this.renderRelationAddRow(
      body,
      node,
      onAdded,
      kindControl => {
        focus.addControl = kindControl;
      },
      close
    );
    // Repainting replaced the control that started the flow; a keyboard user lands back on its replacement.
    if (focusAdd) focus.addControl?.focus();
  }
  /**
   * "This card [relation ▾] → [another card ▾] [Add]": one sentence adds a relation A -> B. The card list holds only
   * legal targets (never this card itself, never a card already linked to it, never a cycle), so it is refilled when
   * the relation changes. Adding goes through `addRelation`, so Map.md is written exactly as before.
   */
  private renderRelationAddRow(
    parent: HTMLElement,
    node: MapNode,
    onAdded: () => void,
    exposeFirst: (control: HTMLElement) => void,
    close?: () => void
  ): void {
    const row = parent.createDiv("vam-relation-add");
    row.setAttr("role", "group");
    row.setAttr("aria-label", t("ui.relation_add_row"));
    row.createSpan({ text: t("ui.relation_this_card"), cls: "vam-relation-add-self" });
    const kindSelect = row.createEl("select", { cls: "dropdown vam-relation-add-kind" });
    kindSelect.setAttr("aria-label", t("ui.relation_kind_label"));
    for (const kind of RELATION_KINDS) kindSelect.createEl("option", { text: t(RELATION_NAME_KEY[kind]), value: kind });
    exposeFirst(kindSelect);
    row.createSpan({ text: "→", cls: "vam-relation-add-arrow", attr: { "aria-hidden": "true" } });
    const currentKind = (): TopicRelationKind => (kindSelect.value as TopicRelationKind) || RELATION_KINDS[0];
    // The list holds only the cards this card may be linked to with the chosen relation; it is read when the list opens.
    const legalSources = (): CardSearchSource[] => {
      const map = this.ports.map();
      const legal = map ? new Set(legalRelationTargets(map, currentKind(), node.id)) : new Set<string>();
      return this.ports.cardSearchSources(item => item.id !== node.id && legal.has(item.id));
    };
    const field = createCardSearchField({
      app: this.ports.app(),
      parent: row,
      placeholder: t("ui.relation_search_placeholder"),
      ariaLabel: t("ui.relation_target_label"),
      candidates: legalSources,
      onSelect: item => {
        const kind = currentKind();
        field.setValue("");
        this.ports.enqueue(async () => {
          await this.ports.addRelation(node.id, item.id, kind);
          onAdded();
        });
      }
    });
    const refresh = (): void => {
      field.setValue("");
      const none = !legalSources().length;
      field.setDisabled(
        none,
        none ? t("ui.no_relation_target_0", t(RELATION_NAME_KEY[currentKind()])) : t("ui.relation_search_placeholder")
      );
    };
    refresh();
    kindSelect.addEventListener("change", refresh);
    // A second way to add: a point on an annotated image, a quiet link under the row (after the search, so the keyboard reaches it in order).
    if (this.ports.anchorEditable()) {
      const point = parent.createEl("button", {
        text: t("ui.anchor_relation_add_button"),
        cls: "vam-relation-add-anchor"
      });
      point.type = "button";
      point.addEventListener("click", () => this.openAnchorPick(node, currentKind, onAdded, close));
    }
  }
  /** The dialog behind "Point on an image…": the existing anchors of every annotated image, and "Place a new point". */
  private openAnchorPick(node: MapNode, kind: () => TopicRelationKind, onAdded: () => void, close?: () => void): void {
    if (!this.ports.anchorEditable()) return;
    const items = this.ports.map()?.canvasItems ?? [],
      entries: AnchorPickEntry[] = [];
    for (const item of items) {
      if (!isAnnotatedImage(item)) continue;
      const name = item.note || (item.path.split("/").pop() ?? item.path);
      for (const anchor of item.anchors) {
        if (!isImage2dAnchor(anchor)) continue;
        entries.push({
          imageId: item.id,
          anchorId: anchor.id,
          label: t("ui.anchor_pick_entry_0_1", name, anchor.note || t("ui.anchor_label_empty")),
          taken: (item.relations ?? []).some(
            r => (r.from === anchor.id && r.to === node.id) || (r.to === anchor.id && r.from === node.id)
          )
        });
      }
    }
    new AnchorPickModal(
      this.ports.app(),
      entries,
      items.some(item => isAnnotatedImage(item)),
      entry =>
        this.ports.enqueue(async () => {
          const relation = { kind: kind(), from: entry.anchorId, to: node.id };
          const image = findAnnotatedImage(this.ports.map()?.canvasItems ?? [], entry.imageId);
          if (!image || !anchorRelationAllowed(image, relation)) {
            new Notice(t("ui.anchor_relation_not_added"));
            return;
          }
          await this.ports.changeCanvasItems(entry.imageId, list => addAnchorRelation(list, entry.imageId, relation));
          onAdded();
        }),
      () => {
        close?.();
        this.ports.startPickingAnchorImage(node.id, kind());
      }
    ).open();
  }
  /** "Annotated image · <anchor note>" (or the empty form) for the anchor `anchorId` of image `imageId`. */
  private anchorEndText(imageId: string, anchorId: string): string {
    const note = findAnnotatedImage(this.ports.map()?.canvasItems ?? [], imageId)?.anchors.find(
      a => a.id === anchorId
    )?.note;
    return note ? t("ui.anchor_relation_end_0", note) : t("ui.anchor_relation_end_empty");
  }
  /** A panel row of an anchor relation: "Kind ← Annotated image · note" (the anchor is the source), "→" (it is the target), "—" for related. */
  private anchorRelationRowText(ref: { imageId: string; anchorId: string; relation: AnchorRelation }): string {
    const name = t(RELATION_NAME_KEY[ref.relation.kind]),
      end = this.anchorEndText(ref.imageId, ref.anchorId);
    // The owner-approved design shows the stored direction for every kind, "related" included ("Related ← Annotated image · x").
    return t(
      ref.relation.from === ref.anchorId ? "ui.anchor_relation_row_in_0_1" : "ui.anchor_relation_row_out_0_1",
      name,
      end
    );
  }
  /** A relation end named for the user: a card by its title, a knowledge reference by its card title and source map. */
  private endTitle(id: string): string {
    return this.ports.notes().get(id)?.title ?? this.ports.refLabel(id) ?? id;
  }
  /** The text of a panel row for `link` seen from `selfId`: "Name → B" going out, "A → Name" coming in, "Name — X" for related. */
  private relationRowText(link: TopicRelation, selfId: string): string {
    const name = t(RELATION_NAME_KEY[link.kind]),
      titleOf = (id: string): string => this.endTitle(id);
    if (link.kind === "related")
      return t("ui.relation_row_related_0_1", name, titleOf(link.from === selfId ? link.to : link.from));
    return link.from === selfId
      ? t("ui.relation_row_out_0_1", name, titleOf(link.to))
      : t("ui.relation_row_in_0_1", titleOf(link.from), name);
  }
  /**
   * One anchor relation in a topic's panel (the topic is the other end). The row reads "Kind ← Annotated image · note"; a click
   * on it (or its pencil) opens the anchor relation editor, the trash removes it (the anchor stays). A map that cannot be
   * edited shows the row alone. Everything the user typed goes in as text.
   */
  private renderAnchorRelationRow(
    list: HTMLElement,
    node: MapNode,
    ref: { imageId: string; anchorId: string; relation: AnchorRelation },
    repaint: () => void,
    editButtons: Map<string, HTMLElement>
  ): void {
    const key = anchorLineKey(ref.imageId, ref.anchorId, node.id),
      text = this.anchorRelationRowText(ref),
      described = ref.relation.description ? `${text}. ${ref.relation.description}` : text,
      end = { imageId: ref.imageId, anchorId: ref.anchorId, topicId: node.id };
    const row = list.createEl("li", { cls: "vam-relation-row vam-anchor-relation-row" });
    this.ports.bindRelationRow(row, ref.relation, described, key);
    this.relationSwatch(row, ref.relation.kind);
    const label = row.createSpan({ cls: "vam-relation-title", attr: { dir: "auto" } });
    label.createSpan({ text, cls: "vam-relation-sentence", attr: { dir: "auto" } });
    if (ref.relation.description)
      label.createSpan({ text: ref.relation.description, cls: "vam-relation-description-text", attr: { dir: "auto" } });
    if (!this.ports.anchorEditable()) return;
    const tools = row.createSpan({ cls: "vam-relation-tools" });
    const reopen = (): void => editButtons.get(key)?.focus();
    row.addEventListener("click", event => {
      if (tools.contains?.(event.target as Node)) return;
      this.ports.openAnchorRelationEditor(end, repaint, reopen);
    });
    editButtons.set(
      key,
      this.ports.iconButton(tools, "pencil", t("ui.edit_relation_0", text), () =>
        this.ports.openAnchorRelationEditor(end, repaint, reopen)
      )
    );
    this.ports.iconButton(tools, "trash-2", t("ui.remove_relation_0", text), () =>
      this.ports.enqueue(async () => {
        await this.ports.changeCanvasItems(ref.imageId, items =>
          removeAnchorRelation(items, ref.imageId, ref.anchorId, node.id)
        );
        repaint();
      })
    );
  }
  /** The anchor relation editor in a dialog; the same host and close-time save as {@link openRelationEditor}. */
  openAnchorRelationEditor(
    ref: { imageId: string; anchorId: string; topicId: string },
    onChanged?: () => void,
    onClosed?: () => void
  ): void {
    if (!this.ports.anchorEditable()) return;
    let saveNote = (): Promise<void> => Promise.resolve();
    const render = (content: HTMLElement, close: () => void): void => {
      saveNote = this.renderAnchorRelationEditor(content, ref, close, onChanged);
    };
    new (class extends Modal {
      onOpen(): void {
        this.modalEl.addClass("vam-topic-modal", "vam-review-modal");
        render(this.contentEl, () => this.close());
      }
      onClose(): void {
        void saveNote().then(() => {
          if (onClosed) window.setTimeout(onClosed, 0);
        });
      }
    })(this.ports.app()).open();
  }
  /** The relation of this (anchor, topic) pair as the map holds it now. */
  private anchorRelationOf(ref: { imageId: string; anchorId: string; topicId: string }): AnchorRelation | undefined {
    return findAnnotatedImage(this.ports.map()?.canvasItems ?? [], ref.imageId)?.relations?.find(
      r => (r.from === ref.anchorId && r.to === ref.topicId) || (r.from === ref.topicId && r.to === ref.anchorId)
    );
  }
  /**
   * The editor of an anchor relation: type, reverse, a one-line note and delete (the anchor stays). Each change is one undo
   * step written at once (the note on blur, Ctrl/Cmd+Enter or close). The pair holds one relation, so a type or direction
   * change can never make a second one; anchor relations take no part in the derives/prerequisite cycle rule (decision 2).
   * Returns the close-time save, settled when its write is done.
   */
  renderAnchorRelationEditor(
    parent: HTMLElement,
    ref: { imageId: string; anchorId: string; topicId: string },
    close?: () => void,
    onChanged?: () => void
  ): () => Promise<void> {
    const root = parent.createDiv("vam-relation-editor"),
      key = anchorLineKey(ref.imageId, ref.anchorId, ref.topicId);
    const apply = (next: (rel: AnchorRelation) => AnchorRelation | null, repaint = true): Promise<void> =>
      new Promise(done =>
        this.ports.enqueue(async () => {
          try {
            const old = this.anchorRelationOf(ref);
            if (!old) return;
            const result = next(old);
            await this.ports.changeCanvasItems(ref.imageId, items =>
              result
                ? updateAnchorRelation(items, ref.imageId, ref.anchorId, ref.topicId, result)
                : removeAnchorRelation(items, ref.imageId, ref.anchorId, ref.topicId)
            );
            if (!result) {
              this.ports.selection().deselectRelation(key);
              this.ports.syncRelationClasses();
              onChanged?.();
              close?.();
              return;
            }
            this.ports.selection().selectRelation(key);
            this.ports.syncRelationClasses();
            if (repaint) paint();
            onChanged?.();
          } finally {
            done();
          }
        })
      );
    let savedNote: string | undefined;
    let noteWrite: Promise<void> = Promise.resolve();
    let saveNote = (): void => {};
    let refocus: "kind" | "reverse" | null = null;
    const paint = (): void => {
      root.empty();
      saveNote = () => {};
      root.createEl("strong", { text: t("ui.relation_editor_title"), cls: "vam-topic-tree-heading" });
      const current = this.anchorRelationOf(ref),
        image = findAnnotatedImage(this.ports.map()?.canvasItems ?? [], ref.imageId);
      if (!current || !image) {
        root.createEl("p", { text: t("ui.relation_gone") });
        return;
      }
      const titleOf = (id: string): string =>
        id === ref.anchorId ? this.anchorEndText(ref.imageId, ref.anchorId) : this.endTitle(id);
      const summary = root.createDiv("vam-relation-editor-summary");
      this.relationSwatch(summary, current.kind);
      summary.createSpan({
        text: t(
          current.kind === "related" ? "ui.relation_label_full_related_0_1_2" : "ui.relation_label_full_0_1_2",
          t(RELATION_NAME_KEY[current.kind]),
          titleOf(current.from),
          titleOf(current.to)
        ),
        cls: "vam-relation-sentence",
        attr: { dir: "auto" }
      });
      const field = (label: string, id: string): HTMLElement => {
        const row = root.createDiv("vam-relation-field");
        row.createEl("label", { text: label, attr: { for: id } });
        return row;
      };
      const kindRow = field(t("ui.relation_kind_label"), "vam-relation-kind");
      const kindSelect = kindRow.createEl("select", { cls: "dropdown vam-relation-kind" });
      kindSelect.setAttr("id", "vam-relation-kind");
      kindSelect.setAttr("aria-label", t("ui.relation_kind_label"));
      for (const kind of RELATION_KINDS) {
        const option = kindSelect.createEl("option", { text: t(RELATION_NAME_KEY[kind]), value: kind });
        if (kind !== current.kind && !anchorRelationAllowed(image, { ...current, kind }, current))
          option.disabled = true;
      }
      kindSelect.value = current.kind;
      kindSelect.addEventListener("change", () => {
        const kind = kindSelect.value as TopicRelationKind;
        if (kind === current.kind) return;
        refocus = "kind";
        void apply(rel => ({ ...rel, kind }));
      });
      let reverseButton: HTMLElement | null = null;
      if (current.kind !== "related") {
        const directionRow = root.createDiv("vam-relation-field");
        directionRow.createSpan({ text: t("ui.relation_direction_label"), cls: "vam-relation-field-label" });
        reverseButton = this.ports.button(
          directionRow,
          t("ui.relation_reverse"),
          () => {
            refocus = "reverse";
            void apply(rel => ({ ...rel, from: rel.to, to: rel.from }));
          },
          !anchorRelationAllowed(image, { ...current, from: current.to, to: current.from }, current)
        );
        reverseButton.addClass("vam-relation-reverse");
      }
      const noteRow = field(t("ui.relation_description_label"), "vam-relation-description");
      const description = noteRow.createEl("textarea", { cls: "vam-relation-description" });
      description.setAttr("id", "vam-relation-description");
      description.setAttr("rows", "4");
      description.setAttr("maxlength", String(RELATION_DESCRIPTION_MAX_LENGTH));
      savedNote = current.description;
      description.value = savedNote ?? "";
      description.setAttr("aria-label", t("ui.relation_description_label"));
      description.setAttr("placeholder", t("ui.relation_description_placeholder"));
      const remaining = noteRow.createDiv({ cls: "vam-relation-remaining" });
      saveNote = (): void => {
        const text = normalizeRelationDescription(description.value);
        if (text === savedNote) return;
        savedNote = text;
        noteWrite = apply(rel => {
          const next: AnchorRelation = { kind: rel.kind, from: rel.from, to: rel.to };
          if (text !== undefined) next.description = text;
          return next;
        }, false);
      };
      const footer = root.createDiv("vam-next-actions vam-relation-footer");
      const remove = footer.createEl("button", { text: t("ui.relation_delete"), cls: "vam-discard mod-warning" });
      remove.addEventListener("click", () => void apply(() => null));
      footer.createSpan({ cls: "vam-next-status" });
      footer.createEl("button", { text: t("ui.close") }).addEventListener("click", () => close?.());
      const refresh = (): void =>
        remaining.setText(
          t(
            "ui.relation_description_remaining_0",
            Math.max(0, RELATION_DESCRIPTION_MAX_LENGTH - description.value.length)
          )
        );
      description.addEventListener("input", refresh);
      description.addEventListener("change", () => saveNote());
      description.addEventListener("keydown", event => {
        if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        saveNote();
      });
      refresh();
      if (refocus) ({ kind: kindSelect, reverse: reverseButton })[refocus]?.focus();
      refocus = null;
    };
    paint();
    return () => {
      saveNote();
      return noteWrite;
    };
  }
  /** The row's visible sentence "A relation B" (T1), with this topic written "This topic"; "related" reads "This topic is related to B". With a null `selfId` (the editor) both ends are named by title. */
  private relationSentence(link: TopicRelation, selfId: string | null): string {
    const self = t("ui.relation_this_topic"),
      // English needs the lower-case form after the verb ("OTHER is derived from this topic"); Chinese has one form.
      titleOf = (id: string, object = false): string =>
        id === selfId ? (object ? t("ui.relation_this_topic_object") : self) : this.endTitle(id);
    if (link.kind === "related")
      return selfId === null
        ? t("ui.relation_sentence_related_0_1", titleOf(link.from), titleOf(link.to))
        : t("ui.relation_sentence_related_0_1", self, titleOf(link.from === selfId ? link.to : link.from));
    return t(RELATION_SENTENCE_KEY[link.kind], titleOf(link.from), titleOf(link.to, true));
  }
  /** Opens the relation editor for `link` in a dialog (the same host as the structure panel); `onChanged` repaints the panel behind it. */
  openRelationEditor(link: TopicRelation, onChanged?: () => void, onClosed?: () => void): void {
    if (!this.ports.map() || !this.ports.relationsEnabled()) return;
    let saveNote = (): Promise<void> => Promise.resolve();
    const render = (content: HTMLElement, close: () => void): void => {
      saveNote = this.renderRelationEditor(content, link, close, onChanged);
    };
    new (class extends Modal {
      onOpen(): void {
        this.modalEl.addClass("vam-topic-modal", "vam-review-modal");
        render(this.contentEl, () => this.close());
      }
      onClose(): void {
        // Closing saves a changed note. Obsidian puts focus back on the button that opened the dialog, but a change
        // repainted the panel and that button is gone; once the save is done, the caller moves focus to the row's replacement.
        void saveNote().then(() => {
          if (onClosed) window.setTimeout(onClosed, 0);
        });
      }
    })(this.ports.app()).open();
  }

  /**
   * The relation editor: type (only the legal ones), reverse (not for "related"; disabled with the reason when it is
   * illegal), a one-line note, and delete. Each change is one undoable Map.md step and is written at once; the note is
   * written when the box loses focus, on Ctrl/Cmd+Enter, or when the dialog closes (decision 40). Everything the user
   * typed (the note, topic titles) is shown as text only. Returns the close-time save, settled when its write is done.
   */
  renderRelationEditor(
    parent: HTMLElement,
    initial: TopicRelation,
    close?: () => void,
    onChanged?: () => void
  ): () => Promise<void> {
    let current: TopicRelation = { ...initial };
    const root = parent.createDiv("vam-relation-editor");
    const indexOfCurrent = (): number =>
      (this.ports.map()?.topicRelations ?? []).findIndex(r => relationIdentity(r) === relationIdentity(current));
    // Runs one change on the relation held in the map being edited; `next` returns its new form, or null to delete it.
    // A note save does not repaint the dialog, so a control the user is reaching for stays where it is.
    const apply = (next: (rel: TopicRelation) => TopicRelation | null | undefined, repaint = true): Promise<void> =>
      new Promise(done =>
        this.ports.enqueue(async () => {
          try {
            await change(next, repaint);
          } finally {
            done();
          }
        })
      );
    const change = async (
      next: (rel: TopicRelation) => TopicRelation | null | undefined,
      repaint: boolean
    ): Promise<void> => {
      const outcome: { value?: TopicRelation | null } = {};
      if (!this.ports.map()) return;
      // The line stays selected under its new identity; a deleted one is dropped by the next draw.
      await this.ports.mapChange(map => {
        const list = map.topicRelations ?? [],
          index = list.findIndex(r => relationIdentity(r) === relationIdentity(current));
        if (index < 0) return;
        outcome.value = next(list[index]);
        // A type or direction change is checked again on the map being edited (the same rule as the choices offered).
        const old = list[index];
        if (
          outcome.value &&
          (outcome.value.kind !== old.kind || outcome.value.from !== old.from || outcome.value.to !== old.to) &&
          !relationAllowed(list, outcome.value, index)
        )
          outcome.value = undefined;
        if (outcome.value === undefined) return;
        const updated = [...list];
        if (outcome.value) updated[index] = outcome.value;
        else updated.splice(index, 1);
        setTopicRelations(map, updated);
      }, false);
      const result = outcome.value;
      if (result === null) {
        this.ports.selection().deselectRelation(relationIdentity(current));
        this.ports.syncRelationClasses();
        onChanged?.();
        close?.();
        return;
      }
      if (result) {
        current = result;
        this.ports.selection().selectRelation(relationIdentity(current));
        this.ports.syncRelationClasses();
      }
      if (repaint) paint();
      onChanged?.();
    };
    // The note as last written or requested; a save is asked for only when the box differs from it.
    let savedNote = initial.description;
    let noteWrite: Promise<void> = Promise.resolve();
    let saveNote = (): void => {};
    // Which control takes the keyboard focus after the next repaint (a change repaints the whole dialog).
    let refocus: "kind" | "reverse" | null = null;
    const paint = (): void => {
      root.empty();
      saveNote = () => {};
      const index = indexOfCurrent();
      root.createEl("strong", { text: t("ui.relation_editor_title"), cls: "vam-topic-tree-heading" });
      if (index < 0) {
        root.createEl("p", { text: t("ui.relation_gone") });
        return;
      }
      const relations = this.ports.map()?.topicRelations ?? [];
      // E1: the sentence "A relation B" and the line sample follow the kind and direction at once.
      const summary = root.createDiv("vam-relation-editor-summary");
      this.relationSwatch(summary, current.kind);
      summary.createSpan({
        text: this.relationSentence(current, null),
        cls: "vam-relation-sentence",
        attr: { dir: "auto" }
      });
      // E2: one field per row, label above the control.
      const field = (label: string, id: string): HTMLElement => {
        const row = root.createDiv("vam-relation-field");
        row.createEl("label", { text: label, attr: { for: id } });
        return row;
      };
      // Type: every kind is listed; one that would close a derives/prerequisite cycle is disabled, with the reason beside it (Q7).
      const kindRow = field(t("ui.relation_kind_label"), "vam-relation-kind");
      const kindSelect = kindRow.createEl("select", { cls: "dropdown vam-relation-kind" });
      kindSelect.setAttr("id", "vam-relation-kind");
      kindSelect.setAttr("aria-label", t("ui.relation_kind_label"));
      const blocked: TopicRelationKind[] = [];
      for (const kind of RELATION_KINDS) {
        const open =
          kind === current.kind || relationAllowed(relations, { kind, from: current.from, to: current.to }, index);
        if (!open) blocked.push(kind);
        const option = kindSelect.createEl("option", { text: t(RELATION_NAME_KEY[kind]), value: kind });
        if (!open) option.disabled = true;
      }
      kindSelect.value = current.kind;
      if (blocked.length) {
        const reason = kindRow.createEl("p", {
          text: t("ui.relation_kind_blocked_cycle_0", blocked.map(kind => t(RELATION_NAME_KEY[kind])).join(", ")),
          cls: "vam-relation-reason"
        });
        reason.setAttr("id", "vam-relation-kind-reason");
        kindSelect.setAttr("aria-describedby", "vam-relation-kind-reason");
      }
      kindSelect.addEventListener("change", () => {
        const kind = kindSelect.value as TopicRelationKind;
        if (kind === current.kind) return;
        refocus = "kind";
        void apply(rel => ({ ...rel, kind }));
      });
      let reverseButton: HTMLElement | null = null;
      // E3 direction: one Reverse button; "related" has no direction and no button. A reverse that would close a cycle stays visible, disabled, with the reason beside it.
      if (current.kind !== "related") {
        const directionRow = root.createDiv("vam-relation-field");
        directionRow.createSpan({ text: t("ui.relation_direction_label"), cls: "vam-relation-field-label" });
        const reversed = { kind: current.kind, from: current.to, to: current.from };
        const allowed = relationAllowed(relations, reversed, index);
        const reverse = this.ports.button(
          directionRow,
          t("ui.relation_reverse"),
          () => {
            refocus = "reverse";
            void apply(rel => ({ ...rel, from: reversed.from, to: reversed.to }));
          },
          !allowed
        );
        reverse.addClass("vam-relation-reverse");
        reverseButton = reverse;
        if (!allowed) {
          const reason = directionRow.createEl("p", {
            text: t("ui.relation_reverse_blocked_cycle"),
            cls: "vam-relation-reason"
          });
          reason.setAttr("id", "vam-relation-reverse-reason");
          reverse.setAttr("aria-describedby", "vam-relation-reverse-reason");
        }
      }
      // Note: a multi-line box of up to 200 characters, saved as one line (line breaks become spaces); an empty one removes the key.
      const noteRow = field(t("ui.relation_description_label"), "vam-relation-description");
      const description = noteRow.createEl("textarea", { cls: "vam-relation-description" });
      description.setAttr("id", "vam-relation-description");
      description.setAttr("rows", "4");
      description.setAttr("maxlength", String(RELATION_DESCRIPTION_MAX_LENGTH));
      savedNote = relations[index].description;
      description.value = savedNote ?? "";
      description.setAttr("aria-label", t("ui.relation_description_label"));
      description.setAttr("placeholder", t("ui.relation_description_placeholder"));
      const remaining = noteRow.createDiv({ cls: "vam-relation-remaining" });
      const draft = (): string | undefined => normalizeRelationDescription(description.value);
      saveNote = (): void => {
        const text = draft();
        if (text === savedNote) return;
        savedNote = text;
        noteWrite = apply(rel => {
          const next: TopicRelation = { kind: rel.kind, from: rel.from, to: rel.to };
          if (text !== undefined) next.description = text;
          return next;
        }, false);
      };
      // E5 footer (decision 40): Delete on the left, Close on the right; nothing waits for an Apply.
      const footer = root.createDiv("vam-next-actions vam-relation-footer");
      const remove = footer.createEl("button", { text: t("ui.relation_delete"), cls: "vam-discard mod-warning" });
      remove.addEventListener("click", () => void apply(() => null));
      footer.createSpan({ cls: "vam-next-status" });
      footer.createEl("button", { text: t("ui.close") }).addEventListener("click", () => close?.());
      const refresh = (): void => {
        remaining.setText(
          t(
            "ui.relation_description_remaining_0",
            Math.max(0, RELATION_DESCRIPTION_MAX_LENGTH - description.value.length)
          )
        );
      };
      description.addEventListener("input", refresh);
      description.addEventListener("change", () => saveNote());
      // Enter adds a line break; Ctrl/Cmd+Enter saves at once.
      description.addEventListener("keydown", event => {
        if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        saveNote();
      });
      refresh();
      if (refocus) ({ kind: kindSelect, reverse: reverseButton, description })[refocus]?.focus();
      refocus = null;
    };
    paint();
    return () => {
      saveNote();
      return noteWrite;
    };
  }
  /** A 32x10 sample of a relation's line (the canvas classes and arrowheads), so a row shows which line to look for. */
  private relationSwatch(parent: HTMLElement, kind: TopicRelationKind): void {
    const svg = createSvg("svg"),
      defs = createSvg("defs"),
      id = `${this.ports.markerId()}-row${++relationSwatchSequence}`;
    svg.addClass("vam-relation-swatch");
    svg.setAttribute("viewBox", "0 0 32 10");
    svg.setAttribute("aria-hidden", "true");
    const arrow = kind === "related" ? null : `url(#${id})`;
    if (arrow) {
      defs.appendChild(this.ports.marker(id, kind === "contradicts"));
      svg.appendChild(defs);
    }
    for (const gap of kind === "derives_from" ? [false, true] : [false]) {
      const line = createSvg("path");
      line.setAttribute("d", "M 0 5 L 32 5");
      if (arrow) line.setAttribute("marker-end", arrow);
      line.addClass(gap ? "vam-relation-gap" : "vam-relation");
      if (!gap) line.addClass(`vam-relation-${kind}`);
      svg.appendChild(line);
    }
    parent.insertBefore(svg, null);
  }
}
