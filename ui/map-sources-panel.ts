import { FuzzySuggestModal, TFile, TFolder, setIcon, type App, type FuzzyMatch } from "obsidian";
import { t } from "../i18n";
import { mapSourceStatus, type MapSource, type MapSourceKind } from "../experiences/visual-map/map-sources";
import type { MapSwitcherItem } from "../repository";

/** Where focus goes after the panel is (re)drawn: the search button, a remove button by stored index, or nowhere. */
export type MapSourcesPanelFocus = { search: true } | { remove: number } | null;

/** What the panel shows between redraws: the last drop's rejection lines and the rows it just added (shown on top). */
export interface MapSourcesSession {
  rejected: string[];
  fresh: string[];
}
export const newMapSourcesSession = (): MapSourcesSession => ({ rejected: [], fresh: [] });

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
  /** Called with the new panel before focus moves into it, so the host can track it when the old focus target blurs. */
  panelCreated?(panel: HTMLElement): void;
  /** Kept by the host across redraws so a rejection message survives the redraw an add causes. */
  session?: MapSourcesSession;
}

const ICONS: Record<MapSourceKind, string> = { map: "brain-circuit", folder: "folder-open", file: "file-text" };
const KIND_LABELS: Record<
  MapSourceKind,
  "ui.map_sources_kind_map" | "ui.map_sources_kind_folder" | "ui.map_sources_kind_file"
> = {
  map: "ui.map_sources_kind_map",
  folder: "ui.map_sources_kind_folder",
  file: "ui.map_sources_kind_file"
};

const baseName = (path: string): string => path.split("/").at(-1) || path;

/** The name a row shows: a folder's name, a note's file name with `.md`, a map's title (else its folder's name). */
export function mapSourceName(app: App, source: MapSource): string {
  if (source.kind === "folder") return baseName(source.path);
  if (source.kind === "file") return baseName(source.path);
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

const dirName = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const sourceKey = (source: MapSource): string => `${source.kind}:${source.path}`;

/** True when a focus or press target is something that can be dragged (an Obsidian file-explorer row): it starts a drag, so the panel must stay open. */
export function isDragSourceTarget(node: unknown): boolean {
  const el = node as { closest?: (selector: string) => unknown } | null;
  return typeof el?.closest === "function" && !!el.closest('[draggable="true"]');
}

interface DragEntry {
  path: string;
  name: string;
}
interface DragRead {
  /** Items that resolved to something inside this vault. */
  inside: DragEntry[];
  /** Lines for items that cannot be in the vault (a file dragged in from the computer). */
  outside: string[];
}

/**
 * What Obsidian's file explorer is dragging now. `app.dragManager.draggable` is NOT in the public `obsidian.d.ts`
 * (external assumption: Obsidian desktop 1.x sets `{ type: "file" | "folder", file }` or `{ type: "files", files }`
 * from dragstart to dragend). Guarded here; null when absent, so callers fall back to `dataTransfer`.
 */
function dragManagerPaths(app: App): string[] | null {
  const draggable = (app as unknown as { dragManager?: { draggable?: unknown } }).dragManager?.draggable;
  if (!draggable || typeof draggable !== "object") return null;
  const { type, file, files } = draggable as { type?: unknown; file?: { path?: unknown }; files?: unknown };
  const paths: string[] = [];
  if ((type === "file" || type === "folder") && typeof file?.path === "string") paths.push(file.path);
  else if (type === "files" && Array.isArray(files))
    for (const item of files)
      if (typeof (item as { path?: unknown })?.path === "string") paths.push((item as { path: string }).path);
  return paths.length ? paths : null;
}

/** A path in a dragged text line: `obsidian://open?...file=`, `[[wikilink]]`, or a plain vault path. */
function pathFromLine(line: string): string | null {
  const text = line.trim();
  if (!text || text.startsWith("#")) return null;
  if (/^obsidian:\/\//i.test(text)) {
    const file = text.match(/[?&]file=([^&#]*)/i)?.[1];
    if (file === undefined) return "";
    try {
      return decodeURIComponent(file);
    } catch {
      return file;
    }
  }
  const link = text.match(/^\[\[([^\]|#]+)/);
  return link ? link[1] : text;
}

function lineName(line: string): string {
  let last = line.split(/[\\/]/).filter(Boolean).at(-1) ?? line;
  try {
    last = decodeURIComponent(last);
  } catch {
    // keep the raw text
  }
  return last;
}

function resolveInVault(app: App, path: string): string | null {
  if (!path) return null;
  if (app.vault.getAbstractFileByPath(path)) return path;
  return !/\.[^/]+$/.test(path) && app.vault.getAbstractFileByPath(`${path}.md`) ? `${path}.md` : null;
}

/** Reads a drop. Public `dataTransfer` first for Files, then the explorer's drag state, then `text/plain`/`text/uri-list`. */
function readDrag(app: App, data: DataTransfer | null | undefined): DragRead {
  const read: DragRead = { inside: [], outside: [] };
  if (!data) return read;
  const types = Array.from(data.types ?? []);
  const files = Array.from(data.files ?? []);
  if (types.includes("Files") || files.length) {
    for (const file of files) read.outside.push(file.name);
    if (!files.length) read.outside.push(t("ui.map_sources_drop_items_0", 1));
    return read;
  }
  const lines: string[] = [];
  const managed = dragManagerPaths(app);
  if (managed) lines.push(...managed);
  else
    for (const type of ["text/uri-list", "text/plain"]) {
      const text = typeof data.getData === "function" ? data.getData(type) : "";
      if (text) {
        lines.push(...text.split(/\r?\n/));
        break;
      }
    }
  const seen = new Set<string>();
  for (const line of lines) {
    const raw = managed ? line : pathFromLine(line);
    if (raw === null) continue;
    const path = resolveInVault(app, raw);
    if (path === null) read.outside.push(lineName(raw || line));
    else if (!seen.has(path)) {
      seen.add(path);
      read.inside.push({ path, name: baseName(path) });
    }
  }
  return read;
}

/** Names of what the explorer is dragging, when it can be known during dragover (the drop data is hidden until drop). */
function hoverLabel(app: App): string {
  const paths = dragManagerPaths(app);
  if (!paths) return "";
  return paths.length === 1 ? baseName(paths[0]) : t("ui.map_sources_drop_items_0", paths.length);
}

/** Decides what a dragged-in vault path becomes: a map (its Map.md path), a folder, a Markdown file, or a refusal. */
function classify(
  app: App,
  path: string,
  mapPaths: readonly string[],
  currentMapPath: string
): { source: MapSource } | { reason: string } {
  const item = app.vault.getAbstractFileByPath(path);
  if (path === currentMapPath || (item instanceof TFolder && path === dirName(currentMapPath)))
    return { reason: t("ui.map_sources_reject_current") };
  if (item instanceof TFile) {
    if (mapPaths.includes(path)) return { source: { kind: "map", path } };
    return item.extension.toLowerCase() === "md"
      ? { source: { kind: "file", path } }
      : { reason: t("ui.map_sources_reject_type") };
  }
  if (item instanceof TFolder) {
    const map = mapPaths.find(mapPath => dirName(mapPath) === path);
    return map ? { source: { kind: "map", path: map } } : { source: { kind: "folder", path } };
  }
  return { reason: t("ui.map_sources_reject_outside") };
}

interface SearchItem {
  kind: MapSourceKind;
  path: string;
  title: string;
  detail: string;
}

/** Every addable thing in this vault in one list: other maps, folders that are not a map's folder, Markdown notes that are not a Map.md. */
async function searchItems(host: MapSourcesPanelHost): Promise<SearchItem[]> {
  const maps = await host.mapItems().catch(() => [] as MapSwitcherItem[]);
  const mapPaths = new Set([...maps.map(item => item.mapPath), host.currentMapPath]);
  const mapFolders = new Set([...mapPaths].map(dirName));
  const others: SearchItem[] = maps
    .filter(item => item.mapPath !== host.currentMapPath)
    .sort((a, b) => b.modified - a.modified || a.title.localeCompare(b.title))
    .map(item => ({ kind: "map" as const, path: item.mapPath, title: item.title, detail: item.folder }));
  const folders: SearchItem[] = vaultFolders(host.app)
    .filter(path => !mapFolders.has(path))
    .map(path => ({ kind: "folder" as const, path, title: baseName(path), detail: dirName(path) }));
  const files: SearchItem[] = vaultMarkdown(host.app)
    .filter(path => !mapPaths.has(path))
    .map(path => ({ kind: "file" as const, path, title: baseName(path), detail: dirName(path) }));
  return [...others, ...folders, ...files];
}

/**
 * The panel under the toolbar button: title, one line of explanation, a drop zone for the explorer's files, folders
 * and maps, a keyboard "Search and add…" list, one row per source (icon, name, kind or count, Remove), and the
 * unchanged time-and-citations hint. Returns the panel element.
 */
export function drawMapSourcesPanel(
  parent: HTMLElement,
  host: MapSourcesPanelHost,
  focus: MapSourcesPanelFocus
): HTMLElement {
  const session = (host.session ??= newMapSourcesSession());
  const panel = parent.createDiv({
    cls: "vam-map-sources-panel",
    attr: { id: host.id, role: "dialog", "aria-label": t("ui.map_sources_title") }
  });
  panel.createEl("h3", { text: t("ui.map_sources_title"), cls: "vam-map-sources-title" });
  panel.createEl("p", { text: t("ui.map_sources_intro"), cls: "vam-hint vam-map-sources-intro" });

  const hintId = `${host.id}-drop-hint`;
  const zone = panel.createDiv({
    cls: "vam-map-sources-drop",
    attr: { role: "group", "aria-label": t("ui.map_sources_drop_main"), "aria-describedby": hintId }
  });
  const dropMain = zone.createSpan({ cls: "vam-map-sources-drop-main" });
  const dropSub = zone.createSpan({ cls: "vam-map-sources-drop-sub", attr: { id: hintId } });
  const dropResult = zone.createDiv({ cls: "vam-map-sources-drop-result", attr: { "aria-live": "polite" } });
  let hover: string | null = null;
  const paint = (): void => {
    const rejected = hover === null && session.rejected.length > 0;
    zone.toggleClass("is-dragover", hover !== null);
    zone.toggleClass("is-rejected", rejected);
    dropMain.setText(
      hover !== null
        ? t("ui.map_sources_drop_release")
        : rejected
          ? t("ui.map_sources_reject_title_0", session.rejected.length)
          : t("ui.map_sources_drop_main")
    );
    dropSub.setText(hover ? hover : t("ui.map_sources_drop_hint"));
  };
  const paintResult = (): void => {
    dropResult.empty();
    for (const line of session.rejected) dropResult.createDiv({ cls: "vam-map-sources-drop-line", text: line });
  };
  paint();
  paintResult();

  /** Sorts a batch into add / refuse; adds what can be added and keeps the reasons for the rest. */
  const commit = async (items: DragEntry[], outside: string[]): Promise<void> => {
    const mapPaths = (await host.mapItems().catch(() => [] as MapSwitcherItem[])).map(item => item.mapPath);
    const lines = outside.map(name => t("ui.map_sources_reject_line_0", name, t("ui.map_sources_reject_outside")));
    const accepted: MapSource[] = [];
    for (const item of items) {
      const result = classify(host.app, item.path, mapPaths, host.currentMapPath);
      if ("reason" in result) {
        lines.push(t("ui.map_sources_reject_line_0", item.name, result.reason));
        continue;
      }
      const key = sourceKey(result.source);
      if (host.sources.some(source => sourceKey(source) === key) || accepted.some(source => sourceKey(source) === key))
        lines.push(t("ui.map_sources_already_added_0", item.name));
      else accepted.push(result.source);
    }
    session.rejected = lines;
    session.fresh = accepted.map(sourceKey);
    paint();
    paintResult();
    for (const source of accepted) host.add(source);
  };

  const accept = (event: DragEvent): void => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    if (hover !== null) return;
    hover = hoverLabel(host.app);
    paint();
  };
  zone.addEventListener("dragenter", accept);
  zone.addEventListener("dragover", accept);
  zone.addEventListener("dragleave", (event: DragEvent) => {
    if (event.relatedTarget && zone.contains(event.relatedTarget as Node)) return;
    hover = null;
    paint();
  });
  zone.addEventListener("drop", (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    hover = null;
    const read = readDrag(host.app, event.dataTransfer);
    if (!read.inside.length && !read.outside.length) return paint();
    void commit(read.inside, read.outside);
  });

  const search = panel.createEl("button", { cls: "vam-map-sources-search" });
  setIcon(search.createSpan({ cls: "vam-map-sources-pick-icon", attr: { "aria-hidden": "true" } }), "search");
  search.createSpan({ cls: "vam-map-sources-pick-label", text: t("ui.map_sources_search") });
  search.addEventListener("click", event => {
    event.stopPropagation();
    session.rejected = [];
    paint();
    paintResult();
    void openSearch(host, search, items => void commit(items, []));
  });

  const list = panel.createDiv({ cls: "vam-map-sources-list", attr: { role: "list" } });
  const removers: HTMLButtonElement[] = [];
  if (!host.sources.length)
    list.createEl("p", { text: t("ui.map_sources_none"), cls: "vam-hint vam-map-sources-empty" });
  // Rows just added come first; the stored order (and the remove focus index) is unchanged.
  const fresh = (source: MapSource): number => session.fresh.indexOf(sourceKey(source));
  const order = host.sources
    .map((source, index) => ({ source, index }))
    .sort((a, b) => (fresh(a.source) < 0 ? 1 : 0) - (fresh(b.source) < 0 ? 1 : 0) || fresh(a.source) - fresh(b.source));
  for (const { source, index } of order) {
    const status = mapSourceStatus(host.app, source);
    const name = mapSourceName(host.app, source);
    const row = list.createDiv({ cls: "vam-map-sources-row", attr: { role: "listitem" } });
    row.toggleClass("is-unreadable", !status.exists);
    row.toggleClass("is-new", fresh(source) >= 0);
    setIcon(row.createSpan({ cls: "vam-map-sources-icon", attr: { "aria-hidden": "true" } }), ICONS[source.kind]);
    row.createSpan({ cls: "vam-map-sources-name", text: name, attr: { title: source.path, dir: "auto" } });
    const meta = !status.exists
      ? t("ui.map_sources_unreadable_row")
      : source.kind === "folder"
        ? t("ui.map_sources_folder_count_0", status.count ?? 0)
        : t(KIND_LABELS[source.kind]);
    row.createSpan({ cls: "vam-map-sources-meta", text: meta });
    const remove = row.createEl("button", {
      cls: "vam-map-sources-remove",
      text: t("ui.reference_remove"),
      attr: { "aria-label": t("ui.map_sources_remove_0", name) }
    });
    remove.addEventListener("click", event => {
      event.stopPropagation();
      session.rejected = [];
      session.fresh = [];
      host.remove(source);
    });
    removers[index] = remove;
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
  for (const control of [search, ...removers.filter(Boolean)])
    control.addEventListener("mousedown", e => e.preventDefault());
  // Focus moving to a real element outside the panel (not the button, not a picker list) closes it. A draggable row
  // (the explorer's) is where a drag starts, so it does not.
  panel.addEventListener("focusout", (event: FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (!next || host.isPickerOpen() || panel.contains(next) || next === host.button() || isDragSourceTarget(next))
      return;
    host.close(false);
  });

  host.panelCreated?.(panel);
  if (focus) {
    const target = "search" in focus ? search : (removers[focus.remove] ?? search);
    target.focus();
  }
  return panel;
}

/** Opens the Obsidian-style list of everything addable. Only items from this vault are ever offered. */
async function openSearch(
  host: MapSourcesPanelHost,
  returnFocus: HTMLElement,
  choose: (items: DragEntry[]) => void
): Promise<void> {
  const modal = new MapSourcePickerModal<SearchItem>(
    host.app,
    await searchItems(host),
    item => `${item.title} ${item.detail}`.trim(),
    t("ui.map_sources_search_placeholder"),
    t("ui.map_sources_search_empty"),
    item => choose([{ path: item.path, name: item.title }]),
    (item, el) => {
      el.addClass("mod-complex");
      const content = el.createDiv("suggestion-content");
      content.createDiv({ cls: "suggestion-title", text: item.title, attr: { dir: "auto" } });
      if (item.detail) content.createDiv({ cls: "suggestion-note", text: item.detail });
      el.createDiv({ cls: "suggestion-aux" }).createSpan({
        cls: "vam-map-sources-kind",
        text: t(KIND_LABELS[item.kind])
      });
    }
  );
  // The panel stays open behind the list; focus goes back to the search button (the list closes before it picks).
  host.setPickerOpen(true);
  const hostClose = (modal as { onClose?: () => void }).onClose;
  modal.onClose = (): void => {
    hostClose?.call(modal);
    host.setPickerOpen(false);
    if (returnFocus.isConnected !== false) returnFocus.focus();
  };
  modal.open();
}
