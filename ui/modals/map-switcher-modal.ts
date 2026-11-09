import { App, FuzzySuggestModal, type FuzzyMatch } from "obsidian";
import { getUiLanguage, t } from "../../i18n";
import type { MapSwitcherItem } from "../../repository";

export type { MapSwitcherItem };

/** The row's second line: topic count, last edit, and the folder only when the maps live in more than one. */
export function mapSwitcherDetail(item: MapSwitcherItem, showFolder: boolean, now = Date.now()): string {
  const count = item.topicCount === 1 ? t("ui.map_switcher_one_topic") : t("ui.map_switcher_topics_0", item.topicCount);
  const parts = [count];
  if (item.modified > 0) parts.push(t("ui.map_switcher_edited_0", editedText(item.modified, now)));
  if (showFolder && item.folder) parts.push(item.folder);
  return parts.join(" · ");
}

function editedText(modified: number, now: number): string {
  const locale = getUiLanguage();
  const date = new Date(modified);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  try {
    return sameDay
      ? date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
      : date.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * "Switch mind map": type to filter the maps by name (or folder); the most recently edited map comes first, and the
 * open one is marked. Choosing a row opens that map.
 */
export class MapSwitcherModal extends FuzzySuggestModal<MapSwitcherItem> {
  private readonly showFolder: boolean;
  constructor(
    app: App,
    private readonly items: MapSwitcherItem[],
    private readonly currentPath: string,
    private readonly choose: (item: MapSwitcherItem) => void
  ) {
    super(app);
    this.showFolder = new Set(items.map(item => item.folder)).size > 1;
    this.setPlaceholder(t("ui.map_switcher_placeholder"));
    // No maps at all: say so and how to add one. Maps exist but the typed text finds none: a plain "no match".
    this.emptyStateText = items.length ? t("ui.map_switcher_empty") : t("ui.map_switcher_empty_none");
    this.setInstructions([
      { command: "↑↓", purpose: t("ui.map_switcher_hint_navigate") },
      { command: "↵", purpose: t("ui.map_switcher_hint_open") },
      { command: "esc", purpose: t("ui.map_switcher_hint_dismiss") }
    ]);
  }
  getItems(): MapSwitcherItem[] {
    return [...this.items].sort((a, b) => b.modified - a.modified || a.title.localeCompare(b.title));
  }
  getItemText(item: MapSwitcherItem): string {
    return this.showFolder ? `${item.title} ${item.folder}` : item.title;
  }
  renderSuggestion(match: FuzzyMatch<MapSwitcherItem>, el: HTMLElement): void {
    const item = match.item;
    el.addClass("mod-complex");
    const content = el.createDiv("suggestion-content");
    const title = content.createDiv({ cls: "suggestion-title", text: item.title, attr: { dir: "auto" } });
    if (item.mapPath === this.currentPath)
      title.createSpan({ cls: "vam-map-switcher-current", text: ` · ${t("ui.map_switcher_current")}` });
    content.createDiv({ cls: "suggestion-note", text: mapSwitcherDetail(item, this.showFolder) });
  }
  onChooseItem(item: MapSwitcherItem): void {
    this.choose(item);
  }
}
