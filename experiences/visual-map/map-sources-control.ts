import { Notice, setIcon, type App } from "obsidian";
import { t } from "../../i18n";
import type { Repository } from "../../repository";
import {
  addExternalSource,
  externalSourceStatus,
  loadExternalSources,
  removeExternalSource,
  type ExternalScope,
  type ExternalSource
} from "./external-sources";
import { sameMapSource, type MapSource } from "./map-sources";
import {
  drawMapSourcesPanel,
  isDragSourceTarget,
  newMapSourcesSession,
  type ExternalAddFailure,
  type ExternalRowStatus,
  type MapSourcesSession,
  mapSourceName,
  mapSourcesButtonLabel,
  unreadableMapSources,
  type MapSourcesPanelFocus
} from "../../ui/map-sources-panel";

/** What the map sources control reads from its view; each is read when called, never cached. */
export interface MapSourcesControlPorts {
  app(): App;
  closed(): boolean;
  path(): string;
  mapId(): string | undefined;
  epoch(): number;
  repo(): Pick<Repository, "readMapSources" | "writeMapSources" | "mapSwitcherItems">;
  announce(text: string): void;
  doc(): Document | undefined;
  enqueue(work: () => Promise<void>): void;
  button(parent: HTMLElement, action: () => void): HTMLButtonElement;
  placeTools(): void;
  scope(): ExternalScope;
}

export class MapSourcesControl {
  /** This map's saved data sources (`map-sources`), loaded with the map; the toolbar button and its panel draw from it. */
  private mapSources: MapSource[] = [];
  /** Folders outside the vault for the open map (device-local list; never shown with their paths). */
  private externalSources: ExternalSource[] = [];
  private externalStatuses = new Map<string, ExternalRowStatus>();
  private externalMapId: string | undefined;
  private externalStatusRun: AbortController | null = null;
  mapSourcesOpen = false;
  private mapSourcesPickerOpen = false;
  private closePicker: (() => void) | null = null;
  private mapSourcesSession: MapSourcesSession = newMapSourcesSession();
  private mapSourcesToolsEl: HTMLElement | null = null;
  private mapSourcesButtonEl: HTMLButtonElement | null = null;
  mapSourcesPanelEl: HTMLElement | null = null;
  private mapSourcesPanelCleanup: (() => void) | null = null;

  constructor(
    private readonly mapSourcesPanelId: string,
    private readonly ports: MapSourcesControlPorts
  ) {}

  /** The view repainted its toolbar: forget the old panel element (its listeners go with the cleanup). */
  detach(): void {
    this.mapSourcesPanelCleanup?.();
    this.mapSourcesPanelCleanup = null;
    this.mapSourcesPanelEl = null;
  }
  /** The view closed: drop the panel listeners and stop the background status checks. */
  dispose(): void {
    this.detach();
    this.mapSourcesOpen = false;
    this.mapSourcesSession = newMapSourcesSession();
    this.cancelPicker();
    this.mapSourcesButtonEl = null;
    this.mapSourcesToolsEl = null;
    this.clearExternalSources();
  }
  /** Saved and outside-the-vault sources together: the count on the data sources button. */
  get sourceCount(): number {
    return this.mapSources.length + this.externalSources.length;
  }
  /** A map was opened: its saved sources, then its external list. */
  loadForMap(sources: MapSource[]): void {
    this.mapSources = sources;
    this.loadExternalSourcesForMap();
  }
  /** Progressive open: no sources until the map's own are loaded. */
  reset(): void {
    this.mapSourcesSession = newMapSourcesSession();
    this.cancelPicker();
    this.mapSources = [];
    this.clearExternalSources();
  }
  // ---- Map data sources: toolbar button and panel ---------------------------------------------------------------
  /**
   * One header button: 「資料來源 · N 份」, with ⚠ in front when a source cannot be read.
   * It opens a panel (same open/close, focus and Esc rules as the goal panel) to add and remove this map's sources.
   */
  renderMapSourcesControl(parent: HTMLElement): void {
    this.mapSourcesPanelCleanup?.();
    this.mapSourcesPanelCleanup = null;
    this.mapSourcesPanelEl = null;
    this.mapSourcesToolsEl = parent;
    this.drawMapSourcesButton(parent);
    if (this.mapSourcesOpen) this.drawMapSourcesPanelEl(null);
  }
  private drawMapSourcesButton(parent: HTMLElement): void {
    const button = this.ports.button(parent, () => {
      if (this.ports.closed() || this.mapSourcesButtonEl !== button) return;
      if (this.mapSourcesOpen && this.mapSourcesPanelEl) this.closeMapSourcesPanel(true);
      else this.openMapSourcesPanel();
    });
    button.addClass("vam-sources-button");
    button.setAttr("aria-haspopup", "dialog");
    button.setAttr("aria-controls", this.mapSourcesPanelId);
    // Pressing the button must not move focus out of an open panel (that would count as leaving it).
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("focusout", (event: FocusEvent) => {
      if (!this.mapSourcesOpen || this.mapSourcesButtonEl !== button || this.mapSourcesPickerOpen) return;
      const next = event.relatedTarget as Node | null;
      if (next && (next === button || this.mapSourcesPanelEl?.contains(next) || isDragSourceTarget(next))) return;
      this.closeMapSourcesPanel(false);
    });
    button.addEventListener("keydown", event => {
      if (event.key !== "Escape" || !this.mapSourcesOpen || this.mapSourcesButtonEl !== button) return;
      event.preventDefault();
      event.stopPropagation();
      this.closeMapSourcesPanel(true);
    });
    this.mapSourcesButtonEl = button;
    this.paintMapSourcesButton();
  }
  /** Icon, count/! badge and accessible text from the current sources; also run when a vault event changes what is readable. */
  private paintMapSourcesButton(): void {
    const button = this.mapSourcesButtonEl;
    if (!button) return;
    const total = this.mapSources.length + this.externalSources.length;
    const label = mapSourcesButtonLabel(total);
    const unreadable = unreadableMapSources(
      this.ports.app(),
      this.mapSources,
      this.externalSources.map(source => this.externalStatuses.get(source.label))
    );
    button.empty();
    const icon = button.createSpan({ cls: "vam-sources-button-icon" });
    icon.setAttr("aria-hidden", "true");
    setIcon(icon, "files");
    const count = total;
    if (unreadable || count > 0) {
      const badge = button.createSpan({ cls: "vam-sources-button-badge", text: unreadable ? "!" : String(count) });
      badge.setAttr("aria-hidden", "true");
      if (unreadable) badge.addClass("is-bad");
    }
    button.setAttr("aria-label", label);
    button.setAttr("aria-expanded", String(this.mapSourcesOpen));
    if (unreadable) button.setAttr("aria-description", t("ui.map_sources_unreadable_description_0", unreadable));
    else button.removeAttribute?.("aria-description");
    button.toggleClass("has-unreadable", unreadable > 0);
    button.toggleClass("is-empty", !total);
  }
  private openMapSourcesPanel(): void {
    if (!this.mapSourcesToolsEl) return;
    this.mapSourcesOpen = true;
    this.mapSourcesButtonEl?.setAttr("aria-expanded", "true");
    this.mapSourcesSession = newMapSourcesSession();
    this.refreshExternalStatuses();
    this.drawMapSourcesPanelEl({ search: true });
  }
  private closeMapSourcesPanel(refocus: boolean): void {
    this.mapSourcesPanelCleanup?.();
    this.mapSourcesPanelCleanup = null;
    this.mapSourcesPanelEl?.remove();
    this.mapSourcesPanelEl = null;
    this.mapSourcesOpen = false;
    this.mapSourcesSession = newMapSourcesSession();
    this.cancelPicker();
    this.mapSourcesButtonEl?.setAttr("aria-expanded", "false");
    this.ports.placeTools();
    if (refocus) this.mapSourcesButtonEl?.focus();
  }
  private cancelPicker(): void {
    const close = this.closePicker;
    this.closePicker = null;
    this.mapSourcesPickerOpen = false;
    close?.();
  }
  private drawMapSourcesPanelEl(focus: MapSourcesPanelFocus): void {
    const tools = this.mapSourcesToolsEl;
    if (!tools) return;
    this.mapSourcesPanelCleanup?.();
    this.mapSourcesPanelCleanup = null;
    this.mapSourcesPanelEl?.remove();
    const mapPath = this.ports.path();
    const epoch = this.ports.epoch();
    const session = this.mapSourcesSession;
    const isActive = (): boolean =>
      this.mapSourcesOpen && this.mapSourcesSession === session && this.isCurrentMap(mapPath, epoch);
    const panelCleanups: Array<() => void> = [];
    const panel = drawMapSourcesPanel(
      tools,
      {
        app: this.ports.app(),
        id: this.mapSourcesPanelId,
        sources: this.mapSources,
        currentMapPath: mapPath,
        mapItems: () => this.ports.repo().mapSwitcherItems(),
        isActive,
        add: (source, quiet) => {
          if (isActive()) this.changeMapSources(mapPath, "add", source, quiet);
        },
        announce: text => {
          if (isActive()) this.ports.announce(text);
        },
        onDragEnd: handler => {
          const doc = this.ports.doc();
          if (!doc?.addEventListener) return;
          doc.addEventListener("dragend", handler, true);
          panelCleanups.push(() => doc.removeEventListener("dragend", handler, true));
        },
        remove: source => {
          if (isActive()) this.changeMapSources(mapPath, "remove", source);
        },
        externals: this.externalSources,
        externalStatus: label => this.externalStatuses.get(label),
        addExternal: input => (isActive() ? this.addExternalFolder(mapPath, input) : Promise.resolve("stale" as const)),
        removeExternal: source => {
          if (isActive()) this.removeExternalFolder(mapPath, source);
        },
        close: refocus => {
          if (isActive()) this.closeMapSourcesPanel(refocus);
        },
        setPickerOpen: open => {
          if (!isActive()) return;
          this.mapSourcesPickerOpen = open;
          if (!open) this.closePicker = null;
        },
        registerPickerClose: close => {
          if (isActive()) this.closePicker = close;
        },
        isPickerOpen: () => this.mapSourcesPickerOpen,
        button: () => this.mapSourcesButtonEl,
        session: this.mapSourcesSession,
        panelCreated: created => {
          this.mapSourcesPanelEl = created;
        }
      },
      focus
    );
    this.mapSourcesPanelEl = panel;
    // A press anywhere else (the canvas, another card) closes it too, except inside the picker list that is open.
    const doc = this.ports.doc();
    if (doc?.addEventListener) {
      const outside = (event: Event): void => {
        if (!isActive() || this.mapSourcesPanelEl !== panel || this.mapSourcesPickerOpen) return;
        const target = event.target as Node | null;
        // A press on a draggable row (the file explorer's) starts a drag to the drop zone; it must not close the panel.
        if (
          target &&
          (panel.contains(target) || this.mapSourcesButtonEl?.contains(target) || isDragSourceTarget(target))
        )
          return;
        this.closeMapSourcesPanel(false);
      };
      doc.addEventListener("pointerdown", outside, true);
      panelCleanups.push(() => doc.removeEventListener("pointerdown", outside, true));
    }
    this.mapSourcesPanelCleanup = () => panelCleanups.forEach(clean => clean());
    this.ports.placeTools();
  }
  /**
   * Left-aligned under the button, shifted left when it would overflow the map pane; the width follows the CSS (max about
   * 440px). A narrow header hides the button: the panel then starts at the pane's left margin.
   */
  placeMapSourcesPanel(panel: HTMLElement): void {
    const button = this.mapSourcesButtonEl;
    const tools = this.mapSourcesToolsEl;
    const pane = tools?.closest?.<HTMLElement>(".vam-view") ?? tools?.parentElement;
    if (!button?.getBoundingClientRect || !tools?.getBoundingClientRect || !pane?.getBoundingClientRect) return;
    const bounds = pane.getBoundingClientRect();
    const width = Math.max(0, Math.min(440, bounds.width - 32));
    const from = button.getBoundingClientRect().left;
    const left = Math.min(Math.max(from, bounds.left + 16), bounds.left + bounds.width - 16 - width);
    panel.style.width = `${width}px`;
    panel.style.left = `${left - tools.getBoundingClientRect().left - 1}px`;
  }
  private isCurrentMap(mapPath: string, epoch: number): boolean {
    return !this.ports.closed() && this.ports.path() === mapPath && this.ports.epoch() === epoch;
  }
  /**
   * Adds or removes one source through the view mutation queue. The list is re-read inside the queue, so a repeated
   * add (same kind and path) writes nothing, and the write only touches `map-sources`.
   */
  private changeMapSources(mapPath: string, change: "add" | "remove", source: MapSource, quiet = false): void {
    const epoch = this.ports.epoch();
    const currentSession = (): boolean => this.isCurrentMap(mapPath, epoch);
    const name = mapSourceName(this.ports.app(), source);
    this.ports.enqueue(async () => {
      if (!currentSession()) return;
      let focus: MapSourcesPanelFocus = { search: true };
      try {
        const current = await this.ports.repo().readMapSources(mapPath);
        if (!currentSession()) return;
        const at = current.findIndex(item => sameMapSource(item, source));
        if (change === "add" && at >= 0) {
          if (!quiet) this.ports.announce(t("ui.map_sources_already_added_0", name));
        } else if (change === "remove" && at < 0) {
          this.mapSources = current;
        } else {
          const next = change === "add" ? [...current, source] : current.filter((_, index) => index !== at);
          await this.ports.repo().writeMapSources(mapPath, next);
          if (!currentSession()) return;
          this.mapSources = next;
          if (change === "remove") focus = { remove: at };
          if (!quiet || change === "remove")
            this.ports.announce(t(change === "add" ? "ui.map_sources_added_0" : "ui.map_sources_removed_0", name));
        }
      } catch (error) {
        if (!currentSession()) return;
        new Notice(t("ui.map_sources_save_failed_0", error instanceof Error ? error.message : String(error)));
        return;
      }
      if (!currentSession()) return;
      this.paintMapSourcesButton();
      if (this.mapSourcesOpen) this.drawMapSourcesPanelEl(focus);
    });
  }
  private clearExternalSources(): void {
    this.externalStatusRun?.abort();
    this.externalStatusRun = null;
    this.externalSources = [];
    this.externalStatuses = new Map();
    this.externalMapId = undefined;
  }
  /** Reads the open map's local external list. Another map starts with no statuses; the same map keeps what it knew. */
  private loadExternalSourcesForMap(): void {
    const id = this.ports.mapId();
    if (id !== this.externalMapId) {
      this.clearExternalSources();
      this.externalMapId = id;
    }
    this.externalSources = loadExternalSources(this.ports.app(), id);
    this.refreshExternalStatuses();
  }
  /**
   * Checks each external folder in the background (fresh range check, file count, limits) and repaints as results come.
   * A result that arrives after the map changed or the view closed is dropped.
   */
  private refreshExternalStatuses(): void {
    this.externalStatusRun?.abort();
    this.externalStatusRun = null;
    const sources = this.externalSources;
    if (!sources.length) return;
    const controller = new AbortController();
    this.externalStatusRun = controller;
    const mapId = this.externalMapId;
    const epoch = this.ports.epoch();
    const scope = this.ports.scope();
    void (async () => {
      for (const source of sources) {
        let status: ExternalRowStatus;
        try {
          status = await externalSourceStatus(source, scope, controller.signal);
        } catch {
          return;
        }
        if (
          controller.signal.aborted ||
          this.ports.closed() ||
          this.ports.epoch() !== epoch ||
          this.externalMapId !== mapId
        )
          return;
        this.externalStatuses.set(source.label, status);
        this.repaintExternalStatus();
      }
    })();
  }
  private repaintExternalStatus(): void {
    if (this.ports.closed() || !this.mapSourcesButtonEl) return;
    this.paintMapSourcesButton();
    if (!this.mapSourcesOpen || this.mapSourcesPickerOpen) return;
    const typing = this.mapSourcesPanelEl?.querySelector?.(".vam-map-sources-path") ?? null;
    const focused = !!typing && this.ports.doc()?.activeElement === typing;
    this.drawMapSourcesPanelEl(focused ? { input: true } : null);
  }
  /** Panel "Add": checks the pasted path, stores it on this device and shows the row. Resolves null when added. */
  private async addExternalFolder(mapPath: string, input: string): Promise<ExternalAddFailure | "stale" | null> {
    const mapId = this.ports.mapId();
    const epoch = this.ports.epoch();
    if (!mapId) return "stale";
    let result;
    try {
      result = await addExternalSource(this.ports.app(), mapId, input, this.ports.scope());
    } catch {
      return "missing";
    }
    if (
      this.ports.closed() ||
      this.ports.epoch() !== epoch ||
      this.ports.path() !== mapPath ||
      this.ports.mapId() !== mapId
    )
      return "stale";
    if (!result.ok) return result.reason;
    this.externalSources = result.sources;
    this.mapSourcesSession.pathDraft = "";
    this.mapSourcesSession.externalRejected = "";
    this.ports.announce(t("ui.map_sources_added_0", result.source.label));
    this.refreshExternalStatuses();
    this.paintMapSourcesButton();
    if (this.mapSourcesOpen) this.drawMapSourcesPanelEl({ input: true });
    return null;
  }
  private removeExternalFolder(mapPath: string, source: ExternalSource): void {
    const mapId = this.ports.mapId();
    if (!mapId || this.ports.closed() || this.ports.path() !== mapPath) return;
    const epoch = this.ports.epoch();
    void removeExternalSource(this.ports.app(), mapId, source).then(({ removed, sources }) => {
      if (
        this.ports.closed() ||
        this.ports.epoch() !== epoch ||
        this.ports.path() !== mapPath ||
        this.ports.mapId() !== mapId
      )
        return;
      this.externalSources = sources;
      this.externalStatuses.delete(source.label);
      if (removed) this.ports.announce(t("ui.map_sources_removed_0", source.label));
      this.refreshExternalStatuses();
      this.paintMapSourcesButton();
      if (this.mapSourcesOpen) this.drawMapSourcesPanelEl({ input: true });
    });
  }
  /** A vault delete or rename: repaint the button and an open panel (a source may have become unreadable). */
  refreshMapSourcesUi(): void {
    if (this.ports.closed() || (!this.mapSources.length && !this.externalSources.length) || !this.mapSourcesButtonEl)
      return;
    this.paintMapSourcesButton();
    // A panel with a picker list open stays as it is; it is redrawn with the next change.
    if (this.mapSourcesOpen && !this.mapSourcesPickerOpen) this.drawMapSourcesPanelEl(null);
  }
}
