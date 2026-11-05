import { FuzzySuggestModal, TFile, TFolder, setIcon, type App, type FuzzyMatch } from "obsidian";
import { t } from "../i18n";
import { mapSourceStatus, type MapSource, type MapSourceKind } from "../experiences/visual-map/map-sources";
import type { MapSwitcherItem } from "../repository";

/** Where focus goes after the panel is (re)drawn: a picker button, a remove button by row index, or nowhere. */
export type MapSourcesPanelFocus = { picker: MapSourceKind } | { remove: number } | null;

export interface MapSourcesPanelHost {
  app: App;
  id: string;
  sources: readonly MapSource[];
  currentMapPath: string;
  /** The other maps' rows (the panel drops the current map itself). */
  mapItems(): Promise<MapSwitcherItem[]>;
  add(source: MapSource): void;
  remove(source: MapSource): void;
  /** Esc inside the panel. */
  close(refocusButton: boolean): void;
  /** True while a picker modal is open: focus leaving to it must not close the panel. */
  setPickerOpen(open: boolean): void;
  /** The toolbar button, which focus may move to without closing the panel. */
  button(): HTMLElement | null;
  isPickerOpen(): boolean;
}

const ICONS: Record<MapSourceKind, string> = { map: "brain-circuit", folder: "folder-open", file: "file-text" };
const PICK_LABELS: Record<
  MapSourceKind,
  "ui.reference_select_mind_map" | "ui.reference_select_folder" | "ui.reference_select_markdown"
> = {
  map: "ui.reference_select_mind_map",
  folder: "ui.reference_select_folder",
  file: "ui.reference_select_markdown"
};

const baseName = (path: string): string => path.split("/").at(-1) || path;

/** The name a row shows: a folder's name, a note's name without `.md`, a map's title (else its folder's name). */
export function mapSourceName(app: App, source: MapSource): string {
  if (source.kind === "folder") return baseName(source.path);
  if (source.kind === "file") return baseName(source.path).replace(/\.md$/i, "");
  const file = app.vault.getAbstractFileByPath(source.path);
  const heading = file instanceof TFile ? app.metadataCache.getFileCache(file)?.headings?.[0]?.heading : undefined;
  if (heading?.trim()) return heading.trim();
  const parts = source.path.split("/");
  return parts.length > 1 ? parts[parts.length - 2] : source.path;
}

/** How many of the sources cannot be read now (a missing file, folder or map). */
export function unreadableMapSources(app: App, sources: readonly MapSource[]): number {
  return sources.filter(source => !mapSourceStatus(app, source).exists).length;
}

/** The toolbar button's label: 「資料來源 · N 份」, or just 「資料來源」 with none. */
export function mapSourcesButtonLabel(count: number): string {
  return count ? t("ui.map_sources_button_count_0", count) : t("ui.map_sources_button");
}

/** A searchable in-vault list (same family as the map switcher); choosing a row hands its item back. */
export class MapSourcePickerModal<T> extends FuzzySuggestModal<T> {
  constructor(
    app: App,
    private readonly items: T[],
    private readonly text: (item: T) => string,
    placeholder: string,
    emptyText: string,
    private readonly choose: (item: T) => void,
    private readonly draw?: (item: T, el: HTMLElement) => void
  ) {
    super(app);
    this.setPlaceholder(placeholder);
    this.emptyStateText = emptyText;
  }
  getItems(): T[] {
    return this.items;
  }
  getItemText(item: T): string {
    return this.text(item);
  }
  renderSuggestion(match: FuzzyMatch<T>, el: HTMLElement): void {
    if (this.draw) this.draw(match.item, el);
    else el.setText(this.text(match.item));
  }
  onChooseItem(item: T): void {
    this.choose(item);
  }
}

function vaultFolders(app: App): string[] {
  return app.vault
    .getAllLoadedFiles()
    .filter((item): item is TFolder => item instanceof TFolder && !!item.path && item.path !== "/")
    .map(folder => folder.path)
    .sort((a, b) => a.localeCompare(b));
}

function vaultMarkdown(app: App): string[] {
  return app.vault
    .getMarkdownFiles()
    .map(file => file.path)
    .sort((a, b) => a.localeCompare(b));
}

/** Opens the Obsidian-style list for one kind of source. Only items from this vault are ever offered. */
async function openPicker(host: MapSourcesPanelHost, kind: MapSourceKind, returnFocus: HTMLElement): Promise<void> {
  const choose = (path: string): void => host.add({ kind, path });
  let modal: MapSourcePickerModal<string> | MapSourcePickerModal<MapSwitcherItem>;
  if (kind === "map") {
    const items = (await host.mapItems())
      .filter(item => item.mapPath !== host.currentMapPath)
      .sort((a, b) => b.modified - a.modified || a.title.localeCompare(b.title));
    modal = new MapSourcePickerModal<MapSwitcherItem>(
      host.app,
      items,
      item => `${item.title} ${item.folder}`.trim(),
      t("ui.map_sources_pick_map_placeholder"),
      t("ui.map_sources_no_other_maps"),
      item => choose(item.mapPath),
      (item, el) => {
        el.addClass("mod-complex");
        const content = el.createDiv("suggestion-content");
        content.createDiv({ cls: "suggestion-title", text: item.title, attr: { dir: "auto" } });
        if (item.folder) content.createDiv({ cls: "suggestion-note", text: item.folder });
      }
    );
  } else {
    const folder = kind === "folder";
    modal = new MapSourcePickerModal<string>(
      host.app,
      folder ? vaultFolders(host.app) : vaultMarkdown(host.app),
      path => path,
      t(folder ? "ui.map_sources_pick_folder_placeholder" : "ui.map_sources_pick_file_placeholder"),
      t(folder ? "ui.map_sources_no_folders" : "ui.map_sources_no_files"),
      choose
    );
  }
  // The panel stays open behind the list; focus goes back to the button that opened it (the list closes before it picks).
  host.setPickerOpen(true);
  const hostClose = (modal as { onClose?: () => void }).onClose;
  modal.onClose = (): void => {
    hostClose?.call(modal);
    host.setPickerOpen(false);
    if (returnFocus.isConnected !== false) returnFocus.focus();
  };
  modal.open();
}

/**
 * The panel under the toolbar button: title, one line of explanation, the three pickers, one row per source (icon,
 * name, count or kind, Remove), and the unchanged time-and-citations hint. Returns the panel element.
 */
export function drawMapSourcesPanel(
  parent: HTMLElement,
  host: MapSourcesPanelHost,
  focus: MapSourcesPanelFocus
): HTMLElement {
  const panel = parent.createDiv({
    cls: "vam-map-sources-panel",
    attr: { id: host.id, role: "dialog", "aria-label": t("ui.map_sources_title") }
  });
  panel.createEl("h3", { text: t("ui.map_sources_title"), cls: "vam-map-sources-title" });
  panel.createEl("p", { text: t("ui.map_sources_intro"), cls: "vam-hint vam-map-sources-intro" });

  const pickers = new Map<MapSourceKind, HTMLButtonElement>();
  const actions = panel.createDiv("vam-map-sources-actions");
  for (const kind of ["map", "folder", "file"] as const) {
    const pick = actions.createEl("button", { cls: "vam-map-sources-pick" });
    setIcon(pick.createSpan({ cls: "vam-map-sources-pick-icon", attr: { "aria-hidden": "true" } }), ICONS[kind]);
    pick.createSpan({ cls: "vam-map-sources-pick-label", text: t(PICK_LABELS[kind]) });
    pick.addEventListener("click", event => {
      event.stopPropagation();
      void openPicker(host, kind, pick);
    });
    pickers.set(kind, pick);
  }

  const list = panel.createDiv({ cls: "vam-map-sources-list", attr: { role: "list" } });
  const removers: HTMLButtonElement[] = [];
  if (!host.sources.length)
    list.createEl("p", { text: t("ui.map_sources_none"), cls: "vam-hint vam-map-sources-empty" });
  for (const source of host.sources) {
    const status = mapSourceStatus(host.app, source);
    const name = mapSourceName(host.app, source);
    const row = list.createDiv({ cls: "vam-map-sources-row", attr: { role: "listitem" } });
    row.toggleClass("is-unreadable", !status.exists);
    setIcon(row.createSpan({ cls: "vam-map-sources-icon", attr: { "aria-hidden": "true" } }), ICONS[source.kind]);
    row.createSpan({ cls: "vam-map-sources-name", text: name, attr: { title: source.path, dir: "auto" } });
    const meta = !status.exists
      ? t("ui.map_sources_unreadable_row")
      : source.kind === "folder"
        ? t("ui.map_sources_folder_count_0", status.count ?? 0)
        : source.kind === "map"
          ? t("ui.map_sources_kind_map")
          : "";
    if (meta) row.createSpan({ cls: "vam-map-sources-meta", text: meta });
    const remove = row.createEl("button", {
      cls: "vam-map-sources-remove",
      text: t("ui.reference_remove"),
      attr: { "aria-label": t("ui.map_sources_remove_0", name) }
    });
    remove.addEventListener("click", event => {
      event.stopPropagation();
      host.remove(source);
    });
    removers.push(remove);
  }
  panel.createEl("p", { text: t("ui.reference_time_and_citations_hint"), cls: "vam-hint vam-map-sources-hint" });

  // Esc closes and hands focus back to the toolbar button.
  panel.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    host.close(true);
  });
  // Pressing a panel button must not move focus out of the panel first.
  for (const control of [...pickers.values(), ...removers])
    control.addEventListener("mousedown", e => e.preventDefault());
  // Focus moving to a real element outside the panel (not the button, not a picker list) closes it.
  panel.addEventListener("focusout", (event: FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (!next || host.isPickerOpen() || panel.contains(next) || next === host.button()) return;
    host.close(false);
  });

  if (focus) {
    const target = "picker" in focus ? pickers.get(focus.picker) : (removers[focus.remove] ?? pickers.get("map"));
    target?.focus();
  }
  return panel;
}
