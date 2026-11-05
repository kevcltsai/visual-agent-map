import { setIcon } from "obsidian";
import { t } from "../../i18n";
import {
  USAGE_ACTIONS,
  localDayStart,
  localMonthStart,
  type AiUsageStore,
  type UsageAction,
  type UsageEntry,
  type UsageProvider,
  type UsageSum,
  type UsageTokens
} from "../../core/ai-usage-store";

const RECENT_ROWS = 10;
/** Gap between the zoom bar and the panel above it. */
const PANEL_GAP = 8;

/** Token counts for people: under 1000 whole, up to 99999 one decimal "k" (cut, never rounded up to 100.0k), from 100k whole "k". */
export function formatTokens(count: number): string {
  const n = Math.max(0, Math.round(Number.isFinite(count) ? count : 0));
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(Math.floor(n / 100) / 10).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

/** A call's length: "18 s", "1 min 5 s"; nothing known gives a dash. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "–";
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return t("ui.usage_seconds_0", String(seconds));
  return t("ui.usage_minutes_seconds_01", String(Math.floor(seconds / 60)), String(seconds % 60));
}

const clock = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "–";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

const actionLabel = (action: UsageAction): string => t(`ui.usage_action_${action}`);
const sum = (tokens: UsageTokens): number => tokens.inputTokens + tokens.outputTokens;
/** A count, with the "approximately" mark when any estimated value went into it. */
const mark = (count: number, estimated: boolean | undefined): string =>
  estimated ? t("ui.usage_estimated_0", formatTokens(count)) : formatTokens(count);

/** The panel's provider filter; every panel opens on "total" (never remembered). */
type UsageFilter = "total" | UsageProvider;
const FILTERS: readonly UsageFilter[] = ["total", "claude", "codex"];
const FILTER_LABEL: Record<UsageFilter, string> = { total: "Total", claude: "Claude", codex: "Codex" };

interface TotalCell {
  strong: HTMLElement;
  /** Input and output, one line each. */
  input: HTMLElement;
  output: HTMLElement;
}
interface BarRow {
  row: HTMLElement;
  name: HTMLElement;
  fill: HTMLElement;
  value: HTMLElement;
}
interface RecentRow {
  row: HTMLElement;
  time: HTMLElement;
  action: HTMLElement;
  node: HTMLElement;
  tokens: HTMLElement;
  duration: HTMLElement;
}
interface PanelParts {
  root: HTMLElement;
  sections: HTMLElement[];
  empty: HTMLElement;
  error: HTMLElement;
  cells: { map: TotalCell; today: TotalCell; month: TotalCell };
  bars: Map<UsageAction, BarRow>;
  barsBox: HTMLElement;
  rows: RecentRow[];
  recentBox: HTMLElement;
  filters: Map<UsageFilter, HTMLElement>;
  footEstimates: HTMLElement;
}

/**
 * The token-usage button at the left end of the zoom controls and the popover it opens. The view creates one when it
 * opens (`start`) and drops it when it closes (`stop`); `mount` is called after every full render because the zoom
 * controls are rebuilt then. A store change only rewrites the text of the elements that are already there.
 */
export class UsageControl {
  private unsubscribe: (() => void) | null = null;
  private button: HTMLButtonElement | null = null;
  private numberEl: HTMLElement | null = null;
  private overlay: HTMLElement | null = null;
  private bar: HTMLElement | null = null;
  private parts: PanelParts | null = null;
  private doc: Document | null = null;
  private isOpen = false;
  private filter: UsageFilter = "total";

  constructor(
    private readonly store: AiUsageStore,
    private readonly mapPath: () => string
  ) {}

  /** Starts following the store (view open). */
  start(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.store.subscribe(() => this.refresh());
  }

  /** Stops following the store and closes the panel (view close). */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.detachPanel();
    this.isOpen = false;
    this.button = this.numberEl = this.overlay = this.bar = null;
  }

  get open(): boolean {
    return this.isOpen;
  }

  /** Puts the button first in the freshly built zoom bar and, when the panel was open, opens it again in the new overlay. */
  mount(zoomBar: HTMLElement, overlay: HTMLElement): void {
    this.detachPanel();
    this.bar = zoomBar;
    this.overlay = overlay;
    const button = zoomBar.createEl("button", { cls: "clickable-icon vam-icon-button vam-usage-button" });
    button.setAttr("aria-haspopup", "dialog");
    button.setAttr("aria-expanded", String(this.isOpen));
    const icon = button.createSpan({ cls: "vam-usage-icon" });
    setIcon(icon, "gauge");
    this.numberEl = button.createSpan({ cls: "vam-usage-number" });
    zoomBar.createSpan({ cls: "vam-usage-sep" }).setAttr("aria-hidden", "true");
    button.addEventListener("click", event => {
      event.stopPropagation();
      if (this.isOpen) this.close(true);
      else this.openPanel();
    });
    this.button = button;
    if (this.isOpen) this.attachPanel();
    this.refresh();
  }

  openPanel(): void {
    if (!this.overlay || this.isOpen) return;
    this.isOpen = true;
    this.filter = "total";
    this.button?.setAttr("aria-expanded", "true");
    this.attachPanel();
    this.refresh();
  }

  /** Closes the panel; the focus goes back to the button when asked or when it was inside the panel. */
  close(returnFocus = false): void {
    if (!this.isOpen) return;
    const active = (this.doc as { activeElement?: Element | null } | null)?.activeElement ?? null;
    const insideNow = !!(active && this.parts?.root.contains(active));
    this.isOpen = false;
    this.detachPanel();
    this.button?.setAttr("aria-expanded", "false");
    if (returnFocus || insideNow) this.button?.focus();
  }

  /** Rewrites the numbers in place (store change, new mount). Nothing is rebuilt. */
  refresh(): void {
    const button = this.button;
    if (!button || !this.numberEl) return;
    const today = this.store.totals({ since: localDayStart() });
    if (today.status === "unreadable") {
      this.numberEl.setText("–");
      button.setAttr("aria-label", t("ui.usage_button_unavailable"));
    } else {
      const label = formatTokens(sum(today.value));
      this.numberEl.setText(label);
      button.setAttr("aria-label", t("ui.usage_button_today_0", label));
    }
    if (this.isOpen && this.parts) this.fillPanel(this.parts);
  }

  private attachPanel(): void {
    if (!this.overlay) return;
    const parts = this.buildPanel(this.overlay);
    this.parts = parts;
    const doc =
      (this.overlay.ownerDocument as Document | undefined) ?? (typeof document === "undefined" ? null : document);
    this.doc = doc;
    doc?.addEventListener("keydown", this.onKey, true);
    doc?.addEventListener("pointerdown", this.onPointer, true);
    this.place();
  }

  private detachPanel(): void {
    this.doc?.removeEventListener("keydown", this.onKey, true);
    this.doc?.removeEventListener("pointerdown", this.onPointer, true);
    this.parts?.root.remove();
    this.parts = null;
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !this.isOpen) return;
    // Only Escape pressed in the panel or on the usage button closes it; anywhere else it belongs to whoever has the focus.
    const inside = (node: Node | null | undefined): boolean =>
      !!node && !!(this.parts?.root.contains(node) || this.button?.contains(node));
    if (!inside(event.target as Node | null) && !inside(this.doc?.activeElement)) return;
    event.preventDefault();
    event.stopPropagation();
    this.close(true);
  };

  private readonly onPointer = (event: Event): void => {
    const target = event.target as Node | null;
    if (!this.isOpen || !target) return;
    if (this.parts?.root.contains(target) || this.button?.contains(target)) return;
    this.close(false);
  };

  /** Floats the panel right above the zoom bar, whatever height the bar wraps to. */
  private place(): void {
    const root = this.parts?.root;
    if (!root || !this.overlay || !this.bar) return;
    const overlayBox = this.overlay.getBoundingClientRect?.();
    const barBox = this.bar.getBoundingClientRect?.();
    if (!overlayBox || !barBox) return;
    root.style.setProperty(
      "--vam-usage-bottom",
      `${Math.max(0, Math.round(overlayBox.bottom - barBox.top + PANEL_GAP))}px`
    );
  }

  private buildPanel(overlay: HTMLElement): PanelParts {
    const root = overlay.createDiv({ cls: "vam-usage-panel" });
    root.setAttr("role", "dialog");
    root.setAttr("aria-label", t("ui.usage_panel_title"));
    root.setAttr("tabindex", "0");
    const head = root.createEl("h3", { cls: "vam-usage-title" });
    head.createSpan({ text: t("ui.usage_panel_title") });
    const group = head.createSpan({ cls: "vam-usage-filter" });
    group.setAttr("role", "radiogroup");
    group.setAttr("aria-label", t("ui.usage_filter_label"));
    const filters = new Map<UsageFilter, HTMLElement>();
    for (const value of FILTERS) {
      const radio = group.createEl("button", { cls: "vam-usage-filter-option", text: FILTER_LABEL[value] });
      radio.setAttr("type", "button");
      radio.setAttr("role", "radio");
      radio.addEventListener("click", () => this.select(value, false));
      filters.set(value, radio);
    }
    group.addEventListener("keydown", (event: KeyboardEvent) => {
      const step =
        event.key === "ArrowRight" || event.key === "ArrowDown"
          ? 1
          : event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? -1
            : 0;
      if (!step) return;
      event.preventDefault();
      event.stopPropagation();
      this.select(FILTERS[(FILTERS.indexOf(this.filter) + step + FILTERS.length) % FILTERS.length], true);
    });

    const error = root.createEl("p", { cls: "vam-usage-error", text: t("ui.usage_unreadable") });
    error.setAttr("role", "status");
    error.hidden = true;

    const totalsSection = root.createDiv({ cls: "vam-usage-section" });
    totalsSection.createDiv({ cls: "vam-usage-heading", text: t("ui.usage_totals") });
    const grid = totalsSection.createDiv({ cls: "vam-usage-totals" });
    const cell = (label: string): TotalCell => {
      const box = grid.createDiv();
      box.createEl("small", { text: label });
      const strong = box.createEl("strong");
      const detail = box.createEl("em");
      return { strong, input: detail.createSpan(), output: detail.createSpan() };
    };
    const cells = {
      map: cell(t("ui.usage_this_map")),
      today: cell(t("ui.usage_today")),
      month: cell(t("ui.usage_this_month"))
    };

    const empty = root.createEl("p", { cls: "vam-usage-empty", text: t("ui.usage_empty") });
    empty.hidden = true;

    const barsSection = root.createDiv({ cls: "vam-usage-section" });
    barsSection.createDiv({ cls: "vam-usage-heading", text: t("ui.usage_by_action") });
    const barsBox = barsSection.createDiv({ cls: "vam-usage-bars" });
    const bars = new Map<UsageAction, BarRow>();
    for (const action of USAGE_ACTIONS) {
      const row = barsBox.createDiv({ cls: "vam-usage-bar" });
      const fill = row.createDiv({ cls: "vam-usage-fill-track" }).createDiv({ cls: "vam-usage-fill" });
      const name = row.createSpan({ text: actionLabel(action) });
      row.insertBefore(name, row.firstChild);
      bars.set(action, { row, name, fill, value: row.createSpan({ cls: "vam-usage-muted" }) });
      row.hidden = true;
    }

    const recentSection = root.createDiv({ cls: "vam-usage-section" });
    recentSection.createDiv({ cls: "vam-usage-heading", text: t("ui.usage_recent") });
    const recentBox = recentSection.createEl("table", { cls: "vam-usage-recent" });
    const rows: RecentRow[] = [];
    for (let index = 0; index < RECENT_ROWS; index++) {
      const row = recentBox.createEl("tr");
      const time = row.createEl("td", { cls: "vam-usage-faint" });
      const what = row.createEl("td");
      const action = what.createSpan();
      const node = what.createSpan({ cls: "vam-usage-node" });
      const tokens = row.createEl("td", { cls: "vam-usage-muted" });
      const duration = row.createEl("td", { cls: "vam-usage-muted" });
      row.hidden = true;
      rows.push({ row, time, action, node, tokens, duration });
    }

    const foot = root.createDiv({ cls: "vam-usage-foot" });
    foot.createDiv({ text: t("ui.usage_footer_scope") });
    const footEstimates = foot.createDiv({ text: t("ui.usage_footer_estimates") });
    footEstimates.hidden = true;
    this.markFilters(filters);
    return {
      root,
      sections: [totalsSection, barsSection, recentSection],
      empty,
      error,
      cells,
      bars,
      barsBox,
      rows,
      recentBox,
      filters,
      footEstimates
    };
  }

  /** Picks one provider view; the chosen radio gets the focus when the choice came from the keyboard. */
  private select(value: UsageFilter, focus: boolean): void {
    this.filter = value;
    const parts = this.parts;
    if (!parts) return;
    this.markFilters(parts.filters);
    if (focus) parts.filters.get(value)?.focus();
    this.fillPanel(parts);
  }

  private markFilters(filters: Map<UsageFilter, HTMLElement>): void {
    for (const [value, radio] of filters) {
      const on = value === this.filter;
      radio.setAttr("aria-checked", String(on));
      radio.setAttr("tabindex", on ? "0" : "-1");
      radio.toggleClass("is-selected", on);
    }
  }

  private fillPanel(parts: PanelParts): void {
    const path = this.mapPath();
    const provider = this.filter === "total" ? undefined : this.filter;
    const map = this.store.totals({ mapPath: path, provider });
    const today = this.store.totals({ since: localDayStart(), provider });
    const month = this.store.totals({ since: localMonthStart(), provider });
    const actions = this.store.byAction(path, undefined, provider);
    const recent = this.store.recent(path, RECENT_ROWS, provider);
    if (
      map.status === "unreadable" ||
      today.status === "unreadable" ||
      month.status === "unreadable" ||
      actions.status === "unreadable" ||
      recent.status === "unreadable"
    ) {
      parts.error.hidden = false;
      parts.empty.hidden = true;
      parts.footEstimates.hidden = true;
      for (const section of parts.sections) section.hidden = true;
      this.place();
      return;
    }
    parts.error.hidden = true;
    for (const section of parts.sections) section.hidden = false;
    const total = (cell: TotalCell, tokens: UsageSum): void => {
      cell.strong.setText(mark(sum(tokens), tokens.estimated));
      // Input and output on two lines of their own, so a narrow panel never wraps in the middle of a phrase.
      cell.input.setText(t("ui.usage_in_0", formatTokens(tokens.inputTokens)));
      cell.output.setText(t("ui.usage_out_0", formatTokens(tokens.outputTokens)));
    };
    total(parts.cells.map, map.value);
    total(parts.cells.today, today.value);
    total(parts.cells.month, month.value);

    const noUsage = sum(map.value) === 0 && recent.value.length === 0;
    parts.empty.hidden = !noUsage;
    parts.sections[1].hidden = noUsage;
    parts.sections[2].hidden = noUsage;
    let anyEstimate = !!(map.value.estimated || today.value.estimated || month.value.estimated);
    const biggest = Math.max(0, ...USAGE_ACTIONS.map(action => sum(actions.value[action])));
    for (const action of USAGE_ACTIONS) {
      const used = sum(actions.value[action]);
      const bar = parts.bars.get(action)!;
      bar.row.hidden = used === 0;
      bar.fill.style.setProperty("width", `${biggest ? Math.max(2, Math.round((used / biggest) * 100)) : 0}%`);
      bar.value.setText(mark(used, actions.value[action].estimated));
      if (!noUsage && used > 0 && actions.value[action].estimated) anyEstimate = true;
    }
    parts.rows.forEach((slot, index) => this.fillRow(slot, recent.value[index]));
    if (!noUsage && recent.value.some(entry => entry.estimated)) anyEstimate = true;
    parts.footEstimates.hidden = !anyEstimate;
    this.place();
  }

  private fillRow(slot: RecentRow, entry: UsageEntry | undefined): void {
    slot.row.hidden = !entry;
    if (!entry) return;
    const count = formatTokens(entry.inputTokens + entry.outputTokens);
    slot.time.setText(clock(entry.at));
    slot.action.setText(actionLabel(entry.action));
    slot.node.setText(entry.topic ?? "");
    slot.node.hidden = !entry.topic;
    slot.tokens.setText(entry.estimated ? t("ui.usage_estimated_0", count) : count);
    slot.tokens.toggleClass("is-estimated", entry.estimated);
    slot.duration.setText(formatDuration(entry.durationMs));
  }
}
