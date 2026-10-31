import { applyCollapseLevel, CARD_WIDTH, clampCardWidth, descendants, type MapNode } from "../../../map-graph";
import { arrangeMap } from "../../../map-layout";
import { fitViewport, focusViewport, insetFromRects, type MapViewport } from "../../visual-map/viewport-inset";
import type { ShareNodePayload, ShareNodeTranslation, SharePayload } from "../share-format";
import { SHARE_VIEWER_UI_DEFAULT, type ShareViewerUi } from "../share-viewer-ui";
import { isCompactEntry } from "../share-translate-compact";
import { fillDetail, fillTranslatedDetail } from "./detail";
import { edgePathData } from "./edge-path";
import { createViewerElement } from "./dom";
import { readTopicColor, TOPIC_COLORS, type TopicColor } from "../../../topic-colors";
import { markerSymbol, readTopicMarkers, type TopicMarker } from "../../../topic-markers";
import { pickShareLanguage, shareLanguageKey } from "./language";

/** Where "Install VAM" points. The only link the viewer itself carries. */
export const INSTALL_URL = "https://github.com/kevcltsai/visual-agent-map?ref=share";
/** `contentLanguage` of a file whose original language is unknown; a test keeps it equal to SHARE_UNKNOWN_LANGUAGE (no runtime import: the viewer bundle stays free of plugin modules). */
const UNKNOWN_ORIGINAL = "und";
const SVG_NS = "http://www.w3.org/2000/svg";
const PANEL_WIDTH_KEY = "vam-share-panel-width";
const OUTLINE_OPEN_KEY = "vam-share-outline-open";
const NARROW_QUERY = "(max-width: 600px)";
const PANEL_DEFAULT = 300;
const PANEL_MIN = 240;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2;
const DRAG_THRESHOLD = 4;

type Tier = "core" | "support" | "side";
/** Icon parts as "tag|attribute=value|…": a flat string list, so the minified bundle never contains a doubled bracket. */
const ICONS: Record<string, string[]> = {
  target: ["circle|cx=12|cy=12|r=10", "circle|cx=12|cy=12|r=6", "circle|cx=12|cy=12|r=2"],
  library: ["path|d=m16 6 4 14", "path|d=M12 6v14", "path|d=M8 8v12", "path|d=M4 4v16"],
  skip: ["polygon|points=5 4 15 12 5 20 5 4", "line|x1=19|x2=19|y1=5|y2=19"],
  minus: ["path|d=M5 12h14"],
  list: [
    "path|d=M8 6h13",
    "path|d=M8 12h13",
    "path|d=M8 18h13",
    "path|d=M3 6h.01",
    "path|d=M3 12h.01",
    "path|d=M3 18h.01"
  ],
  chevron: ["path|d=m9 18 6-6-6-6"],
  plus: ["path|d=M5 12h14", "path|d=M12 5v14"],
  max: [
    "path|d=M8 3H5a2 2 0 0 0-2 2v3",
    "path|d=M21 8V5a2 2 0 0 0-2-2h-3",
    "path|d=M3 16v3a2 2 0 0 0 2 2h3",
    "path|d=M16 21h3a2 2 0 0 0 2-2v-3"
  ]
};
const TIER_ICON: Record<Tier, string> = { core: "target", support: "library", side: "skip" };

const isTier = (value: unknown): value is Tier => value === "core" || value === "support" || value === "side";
const fill = (template: string, value: string | number): string => template.replace("{0}", String(value));

function readJson(doc: Document, id: string): unknown {
  const text = doc.getElementById(id)?.textContent;
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Files edited by hand may miss strings; fall back to English per field. */
function uiFrom(raw: unknown): ShareViewerUi {
  const ui: ShareViewerUi = { ...SHARE_VIEWER_UI_DEFAULT };
  if (raw && typeof raw === "object")
    for (const key of Object.keys(ui) as (keyof ShareViewerUi)[]) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === "string") (ui as unknown as Record<string, string>)[key] = value;
    }
  const names = raw && typeof raw === "object" ? (raw as Record<string, unknown>).markerNames : undefined;
  if (names && typeof names === "object") {
    ui.markerNames = { ...SHARE_VIEWER_UI_DEFAULT.markerNames };
    for (const id of Object.keys(ui.markerNames) as TopicMarker[]) {
      const value = (names as Record<string, unknown>)[id];
      if (typeof value === "string" && value.trim()) ui.markerNames[id] = value;
    }
  }
  const colors = raw && typeof raw === "object" ? (raw as Record<string, unknown>).colorNames : undefined;
  ui.colorNames = { ...SHARE_VIEWER_UI_DEFAULT.colorNames };
  if (colors && typeof colors === "object")
    for (const id of TOPIC_COLORS) {
      const value = (colors as Record<string, unknown>)[id];
      if (typeof value === "string" && value.trim()) ui.colorNames[id] = value;
    }
  return ui;
}

/** The interface text per language and the language names of a translated file (absent in a plain one). */
function readUiExtras(doc: Document): { sets: Map<string, ShareViewerUi>; names: Record<string, string> } {
  const raw = readJson(doc, "vam-ui") as
    { uiByLanguage?: Record<string, unknown>; languageNames?: Record<string, unknown> } | undefined;
  const sets = new Map<string, ShareViewerUi>();
  const names: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    if (raw.uiByLanguage && typeof raw.uiByLanguage === "object")
      for (const [language, value] of Object.entries(raw.uiByLanguage)) sets.set(language, uiFrom(value));
    if (raw.languageNames && typeof raw.languageNames === "object")
      for (const [language, value] of Object.entries(raw.languageNames))
        if (typeof value === "string" && value) names[language] = value;
  }
  return { sets, names };
}

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode or blocked storage: the width just is not remembered */
  }
}

const isNarrow = (): boolean => window.matchMedia(NARROW_QUERY).matches;

export function startViewer(doc: Document): void {
  const baseUi = uiFrom(readJson(doc, "vam-ui"));
  let ui = baseUi;
  doc.documentElement.lang = ui.lang;
  const app = doc.getElementById("vam-app");
  const data = readJson(doc, "vam-map") as SharePayload | undefined;
  if (!app) return;
  if (!data || data.format !== "vam-share" || data.version !== 1 || !Array.isArray(data.nodes)) {
    app.replaceChildren(doc.createTextNode("This is not a Visual Agent Map share file."));
    return;
  }
  const assets: Record<string, string> = data.assets && typeof data.assets === "object" ? data.assets : {};
  const info = new Map<string, ShareNodePayload>();
  const nodes: MapNode[] = [];
  for (const item of data.nodes) {
    if (!item || typeof item.id !== "string" || info.has(item.id)) continue;
    info.set(item.id, item);
    const width = clampCardWidth(item.width);
    nodes.push({
      id: item.id,
      path: item.id,
      parentId: typeof item.parentId === "string" ? item.parentId : null,
      x: Number.isFinite(item.x) ? item.x : 0,
      y: Number.isFinite(item.y) ? item.y : 0,
      collapsed: !!item.collapsed,
      ...(width !== undefined && width !== CARD_WIDTH ? { width } : {})
    });
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const node of nodes)
    if (node.parentId && (!byId.has(node.parentId) || node.parentId === node.id)) node.parentId = null;
  const kidsOf = new Map<string, MapNode[]>();
  for (const node of nodes) if (node.parentId) kidsOf.set(node.parentId, [...(kidsOf.get(node.parentId) ?? []), node]);

  // ---- language: a translated file lists its languages (the original first); a plain file has one and no menu.
  const extras = readUiExtras(doc);
  const languages = Array.isArray(data.languages) ? Array.from(new Set(data.languages.filter(isText))) : [];
  const languageStorageKey = shareLanguageKey(data.source?.mapId);
  const multilingual = languages.length >= 2;
  const original = multilingual ? languages[0] : "";
  let language = original;
  if (multilingual) {
    let browser: string[] = [];
    try {
      browser = Array.from(window.navigator.languages ?? [window.navigator.language]).filter(isText);
    } catch {
      /* no navigator language: the original is shown */
    }
    language = pickShareLanguage({
      languages,
      stored: languageStorageKey ? storageGet(languageStorageKey) : null,
      defaultLanguage: isText(data.defaultLanguage) ? data.defaultLanguage : undefined,
      browser
    });
  }
  const uiOf = (code: string): ShareViewerUi => extras.sets.get(code) ?? baseUi;
  // An original whose language is unknown has no name: the menu says "Original" and the notice names no source.
  const originalUnknown = multilingual && original === UNKNOWN_ORIGINAL;
  const isTranslated = (): boolean => multilingual && language !== original;
  if (multilingual) {
    ui = uiOf(language);
    doc.documentElement.lang = language;
  }
  type Shown = Pick<ShareNodePayload, "title" | "summary" | "reason" | "detailHtml"> & {
    /** A compact translation (D-2026-10-122): the note is rebuilt from `detailHtml`, the original, with it. */
    compact?: ShareNodeTranslation;
  };
  /** A note's text in the language on screen; a field the translation lacks shows the original. */
  const textOf = (item: ShareNodePayload): Shown => {
    const translation = isTranslated() ? item.translations?.[language] : undefined;
    if (!translation || typeof translation !== "object") return item;
    return {
      title: isText(translation.title) ? translation.title : item.title,
      summary: isText(translation.summary) ? translation.summary : item.summary,
      reason: isText(translation.reason) ? translation.reason : item.reason,
      detailHtml: isText(translation.detailHtml) ? translation.detailHtml : item.detailHtml,
      ...(isCompactEntry(translation) && isText(item.detailHtml)
        ? { compact: translation, detailHtml: item.detailHtml }
        : {})
    };
  };
  const mapTextNow = (): { title: string; goal: string } => {
    const translation = isTranslated() ? data.translations?.[language] : undefined;
    const rawTitle = isText(translation?.title) ? translation.title : data.title;
    const rawGoal = isText(translation?.goal) ? translation.goal : data.goal;
    return {
      title: (typeof rawTitle === "string" && rawTitle.trim()) || ui.untitledMap,
      goal: typeof rawGoal === "string" ? rawGoal.trim() : ""
    };
  };
  /** A language's name for the menu; the platform's name in the interface language when the file gave none. */
  const nameOf = (code: string, inLanguage?: string): string => {
    try {
      const display = new Intl.DisplayNames([inLanguage ?? code], { type: "language" }).of(code);
      if (display && display !== code) return display;
    } catch {
      /* no Intl.DisplayNames */
    }
    return extras.names[code] ?? code;
  };

  // ---- theme: styles.css dark rules key off `.theme-dark`, which Obsidian sets; here it follows the browser.
  try {
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      doc.documentElement.classList.toggle("theme-dark", dark.matches);
    };
    apply();
    dark.addEventListener("change", apply);
  } catch {
    /* no matchMedia: light theme */
  }

  // ---- DOM helpers
  const make = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string,
    text?: string
  ): HTMLElementTagNameMap[K] => {
    const element = createViewerElement(doc, tag);
    if (cls) element.className = cls;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const icon = (name: string): SVGElement => {
    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "svg-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    for (const spec of ICONS[name]) {
      const [tag, ...attrs] = spec.split("|");
      const part = doc.createElementNS(SVG_NS, tag);
      for (const attr of attrs) part.setAttribute(attr.slice(0, attr.indexOf("=")), attr.slice(attr.indexOf("=") + 1));
      svg.append(part);
    }
    return svg;
  };
  const button = (
    parent: HTMLElement,
    label: string,
    cls: string | undefined,
    onClick: () => void
  ): HTMLButtonElement => {
    const item = make("button", cls, label);
    item.type = "button";
    item.addEventListener("click", event => {
      event.stopPropagation();
      onClick();
    });
    parent.append(item);
    return item;
  };
  const iconButton = (parent: HTMLElement, name: string, label: string, onClick: () => void): HTMLButtonElement => {
    const item = make("button");
    item.type = "button";
    item.setAttribute("aria-label", label);
    item.title = label;
    item.append(icon(name));
    item.addEventListener("click", event => {
      event.stopPropagation();
      onClick();
    });
    parent.append(item);
    return item;
  };
  const tierLabel = (tier: Tier): string =>
    tier === "core" ? ui.tierCore : tier === "support" ? ui.tierSupport : ui.tierSide;
  /** Untrusted input: only whitelisted ids, in the fixed order, so cards and the outline show the same row. */
  const markersOf = (item: ShareNodePayload): TopicMarker[] => readTopicMarkers({ "topic-markers": item.markers });
  const cjk = (): boolean => /^(zh|ja)/.test(ui.lang);
  /** The accessible name of a topic: its title, plus the marker names when it has markers. */
  const nameWithMarkers = (title: string, markers: TopicMarker[]): string => {
    if (!markers.length) return title;
    const names = markers.map(id => ui.markerNames[id]).join(cjk() ? "、" : ", ");
    return `${title}${cjk() ? "，" : ", "}${fill(ui.markerLabel, names)}`;
  };
  /** The symbols are decoration (aria-hidden); the names reach assistive technology through the label of the topic. */
  /** The colour of a topic: the whitelist is applied again here, so a hand-edited file cannot inject anything. */
  const colorOf = (item: ShareNodePayload): TopicColor | undefined => readTopicColor({ "topic-color": item.color });

  const markerRow = (markers: TopicMarker[]): HTMLElement => {
    const row = make("span", "vam-markers");
    for (const id of markers) {
      const mark = make("span", "vam-marker", markerSymbol(id));
      mark.dataset.marker = id;
      mark.setAttribute("aria-hidden", "true");
      row.append(mark);
    }
    return row;
  };
  const tierTag = (tier: Tier, title?: string): HTMLElement => {
    const tag = make("span", "vam-relevance-tag");
    tag.dataset.tier = tier;
    if (title) tag.title = title;
    const holder = make("span", "vam-relevance-icon");
    holder.append(icon(TIER_ICON[tier]));
    tag.append(holder, make("span", undefined, tierLabel(tier)));
    return tag;
  };

  // ---- page skeleton
  app.className = "vam-app";
  const toolbar = make("div", "vam-toolbar");
  const mapHeading = make("h1", "vam-map-switcher");
  const sharedLabel = make("span", "vam-shared");
  toolbar.append(mapHeading, sharedLabel);
  const outlineToggle = iconButton(toolbar, "list", "", () => setOutlineOpen(outline.hidden, true));
  toolbar.prepend(outlineToggle);
  outlineToggle.setAttribute("aria-controls", "vam-outline");
  const actions = make("div", "vam-toolbar-actions");
  const languageSelect = make("select", "vam-language");
  if (multilingual) {
    for (const code of languages) {
      const option = make("option", undefined, extras.names[code] ?? nameOf(code));
      option.value = code;
      if (originalUnknown && code === original) option.dataset.original = "1";
      languageSelect.append(option);
    }
    languageSelect.value = language;
    actions.append(languageSelect);
  }
  const madeWith = make("span", "vam-made-with");
  const install = make("a", "vam-install");
  install.href = INSTALL_URL;
  install.target = "_blank";
  install.rel = "noopener noreferrer";
  actions.append(madeWith, install);
  toolbar.append(actions);
  // Shown while a translated version is open: who translated it, and that pictures keep their text.
  const translateNote = make("div", "vam-translate-note");
  translateNote.hidden = true;
  const workspace = make("div", "vam-workspace");
  const viewport = make("div", "vam-viewport");
  const stage = make("div", "vam-stage");
  stage.setAttribute("role", "tree");
  const edges = doc.createElementNS(SVG_NS, "svg");
  edges.setAttribute("class", "vam-edges");
  edges.setAttribute("aria-hidden", "true");
  stage.append(edges);
  viewport.append(stage);
  const overlay = make("div", "vam-canvas-overlay");
  const tools = make("div", "vam-map-tools");
  const goal = make("span", "vam-goal");
  const goalLabel = make("span", "vam-goal-text");
  goal.append(icon("target"), goalLabel);
  const hint = make("span", "vam-canvas-hint");
  const zoomBar = make("div", "vam-zoom-controls");
  const zoomOutButton = iconButton(zoomBar, "minus", "", () => zoomBy(1 / 1.2));
  const zoomLabel = make("button", "vam-zoom", "100%");
  zoomLabel.type = "button";
  zoomLabel.addEventListener("click", event => {
    event.stopPropagation();
    zoomBy(1 / view.zoom);
  });
  zoomBar.append(zoomLabel);
  const zoomInButton = iconButton(zoomBar, "plus", "", () => zoomBy(1.2));
  const showAllButton = iconButton(zoomBar, "max", "", () => fit());
  const layoutButton = make("button", "vam-layout-button");
  layoutButton.type = "button";
  layoutButton.setAttribute("aria-haspopup", "menu");
  layoutButton.setAttribute("aria-expanded", "false");
  zoomBar.append(layoutButton);
  const menu = make("div", "vam-layout-menu");
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  zoomBar.append(menu);
  overlay.append(tools, hint, zoomBar);
  const inspector = make("aside", "vam-inspector");
  inspector.hidden = true;
  const outline = make("nav", "vam-outline");
  outline.id = "vam-outline";
  const outlineTree = make("div", "vam-outline-tree");
  outlineTree.setAttribute("role", "tree");
  outline.append(outlineTree);
  workspace.append(outline, viewport, overlay, inspector);
  app.replaceChildren(...(multilingual ? [toolbar, translateNote, workspace] : [toolbar, workspace]));

  // ---- state
  let view: MapViewport = { x: 0, y: 0, zoom: 1 };
  let selected: string | null = null;
  let suppressClick = false;
  let panelWidth = Number(storageGet(PANEL_WIDTH_KEY)) || PANEL_DEFAULT;
  const cards = new Map<string, HTMLElement>();

  const hiddenIds = (): Set<string> => {
    const hidden = new Set<string>();
    const walk = (node: MapNode, hide: boolean): void => {
      for (const kid of kidsOf.get(node.id) ?? []) {
        if (hide) hidden.add(kid.id);
        walk(kid, hide || kid.collapsed);
      }
    };
    for (const root of nodes) if (!root.parentId) walk(root, root.collapsed);
    return hidden;
  };
  const depthOf = (node: MapNode): number => {
    let depth = 0;
    for (let parent = node.parentId; parent; parent = byId.get(parent)?.parentId ?? null)
      if (++depth > nodes.length) break;
    return depth;
  };
  const insetNow = (): number =>
    insetFromRects(viewport.getBoundingClientRect().top, tools.hidden ? undefined : tools.getBoundingClientRect());

  // ---- canvas
  function transform(): void {
    stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    const percent = `${Math.round(view.zoom * 100)}%`;
    zoomLabel.textContent = percent;
    zoomLabel.setAttribute("aria-label", fill(ui.zoomReset, percent));
  }
  function zoomBy(factor: number, point?: { x: number; y: number }): void {
    const center = point ?? { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
    const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.zoom * factor));
    const ratio = zoom / view.zoom;
    view = { x: center.x - (center.x - view.x) * ratio, y: center.y - (center.y - view.y) * ratio, zoom };
    transform();
  }
  /** Set when "show all" was asked while the canvas had no size (page opened in a background tab); done once it has one. */
  let fitPending = false;
  function fit(): void {
    if (!cards.size) return;
    if (!viewport.clientWidth || !viewport.clientHeight) {
      fitPending = true;
      return;
    }
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const card of cards.values()) {
      minX = Math.min(minX, card.offsetLeft);
      minY = Math.min(minY, card.offsetTop);
      maxX = Math.max(maxX, card.offsetLeft + (card.offsetWidth || CARD_WIDTH));
      maxY = Math.max(maxY, card.offsetTop + card.offsetHeight);
    }
    view = fitViewport(
      { minX, minY, maxX, maxY },
      { width: viewport.clientWidth, height: viewport.clientHeight },
      insetNow()
    );
    transform();
  }
  function center(id: string): void {
    const card = cards.get(id);
    if (!card) return;
    view = focusViewport(
      view,
      { x: card.offsetLeft + card.offsetWidth / 2, y: card.offsetTop + card.offsetHeight / 2 },
      { width: viewport.clientWidth, height: viewport.clientHeight },
      insetNow()
    );
    transform();
  }
  function drawEdges(): void {
    edges.replaceChildren();
    for (const node of nodes) {
      const parent = node.parentId ? cards.get(node.parentId) : undefined;
      const child = cards.get(node.id);
      if (!parent || !child) continue;
      const path = doc.createElementNS(SVG_NS, "path");
      path.setAttribute(
        "d",
        edgePathData(
          parent.offsetLeft + parent.offsetWidth,
          parent.offsetTop + parent.offsetHeight / 2,
          child.offsetLeft,
          child.offsetTop + child.offsetHeight / 2
        )
      );
      path.setAttribute("class", info.get(node.id)?.tier === "side" ? "vam-edge vam-edge-side" : "vam-edge");
      edges.append(path);
    }
  }
  let edgeFrame = 0;
  const scheduleEdges = (): void => {
    if (edgeFrame) return;
    edgeFrame = window.requestAnimationFrame(() => {
      edgeFrame = 0;
      drawEdges();
    });
  };
  const place = (id: string): void => {
    const card = cards.get(id);
    const node = byId.get(id);
    if (!card || !node) return;
    card.style.left = `${node.x}px`;
    card.style.top = `${node.y}px`;
    if (node.width) card.style.width = `${node.width}px`;
  };

  function renderCards(): void {
    for (const card of cards.values()) card.remove();
    cards.clear();
    const hidden = hiddenIds();
    for (const node of nodes) {
      if (hidden.has(node.id)) continue;
      const item = info.get(node.id)!;
      const shown = textOf(item);
      const count = descendants(nodes, node.id).size;
      const tier = isTier(item.tier) ? item.tier : undefined;
      const card = make("div", `vam-node${node.id === selected ? " is-selected" : ""}`);
      card.dataset.nodeId = node.id;
      card.dataset.status = item.status === "completed" ? "completed" : "idea";
      if (tier) card.dataset.relevance = tier;
      card.tabIndex = 0;
      card.setAttribute("role", "treeitem");
      card.setAttribute("aria-level", String(depthOf(node) + 1));
      card.setAttribute("aria-selected", String(node.id === selected));
      const markers = markersOf(item);
      const color = colorOf(item);
      if (color) card.dataset.topicColor = color;
      const markedName = nameWithMarkers(String(shown.title ?? ""), markers);
      card.setAttribute(
        "aria-label",
        color ? `${markedName}${cjk() ? "，" : ", "}${fill(ui.colorLabel, ui.colorNames[color])}` : markedName
      );
      if (count) card.setAttribute("aria-expanded", String(!node.collapsed));
      const header = make("div", "vam-node-header");
      card.append(header);
      if (item.status !== "completed") header.append(make("span", "vam-status vam-status-idea", ui.toResearch));
      if (tier) header.append(tierTag(tier, typeof shown.reason === "string" ? shown.reason : undefined));
      if (markers.length) header.append(markerRow(markers));
      const cardTools = make("div", "vam-node-tools");
      card.append(cardTools);
      if (count) {
        const toggleText = node.collapsed ? fill(ui.expandCount, count) : ui.collapse;
        const toggle = button(header, toggleText, "vam-collapse-button", () => {
          node.collapsed = !node.collapsed;
          relayout(node.id, true);
        });
        toggle.setAttribute("aria-expanded", String(!node.collapsed));
        toggle.setAttribute("aria-label", toggleText);
        toggle.title = toggleText;
      }
      button(cardTools, ui.detailsButton, undefined, () => select(node.id));
      card.append(make("h3", "vam-card-title", String(shown.title ?? "")));
      if (typeof shown.summary === "string" && shown.summary.trim())
        card.append(make("p", "vam-card-summary", shown.summary));
      card.addEventListener("click", () => {
        if (!suppressClick) select(node.id);
      });
      card.addEventListener("keydown", event => {
        if (event.target !== card) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select(node.id);
        } else if (count && event.key === (node.collapsed ? "ArrowRight" : "ArrowLeft")) {
          event.preventDefault();
          node.collapsed = !node.collapsed;
          relayout(node.id);
        }
      });
      card.addEventListener("pointerdown", event => dragCard(event, node, card));
      stage.append(card);
      cards.set(node.id, card);
      place(node.id);
    }
  }
  function layout(): void {
    const arranged = arrangeMap(nodes, undefined, id => cards.get(id)?.offsetHeight);
    arranged.forEach((placed, index) => {
      nodes[index].x = placed.x;
      nodes[index].y = placed.y;
    });
    for (const id of cards.keys()) place(id);
  }
  /** Rebuilds the cards after a fold change, keeping the card the user acted on where it was on screen. */
  function relayout(focusId?: string, focusButton = false): void {
    const before = focusId ? cards.get(focusId)?.getBoundingClientRect() : undefined;
    renderCards();
    layout();
    drawEdges();
    const after = focusId ? cards.get(focusId) : undefined;
    if (after) {
      if (before) {
        const rect = after.getBoundingClientRect();
        view = { ...view, x: view.x + before.left - rect.left, y: view.y + before.top - rect.top };
        transform();
      }
      const target = focusButton ? after.querySelector<HTMLElement>(".vam-collapse-button") : null;
      (target ?? after).focus({ preventScroll: true });
    }
  }
  /** Moves one card for this visit only; nothing is saved and Auto layout puts it back. */
  function dragCard(event: PointerEvent, node: MapNode, card: HTMLElement): void {
    if (event.button !== 0 || !event.isPrimary || (event.target as Element).closest("button")) return;
    const startX = event.clientX,
      startY = event.clientY,
      originX = node.x,
      originY = node.y;
    let dragging = false;
    const move = (e: PointerEvent): void => {
      const dx = e.clientX - startX,
        dy = e.clientY - startY;
      if (!dragging) {
        if (Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
        dragging = true;
        card.classList.add("is-dragging");
        card.setPointerCapture(e.pointerId);
      }
      node.x = originX + dx / view.zoom;
      node.y = originY + dy / view.zoom;
      place(node.id);
      scheduleEdges();
    };
    const up = (): void => {
      card.removeEventListener("pointermove", move);
      card.removeEventListener("pointerup", up);
      card.removeEventListener("pointercancel", up);
      card.classList.remove("is-dragging");
      if (dragging) {
        suppressClick = true;
        window.setTimeout(() => (suppressClick = false), 0);
      }
    };
    card.addEventListener("pointermove", move);
    card.addEventListener("pointerup", up);
    card.addEventListener("pointercancel", up);
  }

  // ---- side panel
  const clampPanel = (width: number): number =>
    Math.round(Math.min(Math.max(PANEL_MIN, width), Math.max(PANEL_MIN, workspace.clientWidth * 0.7)));
  function applyPanelWidth(): void {
    const narrow = isNarrow();
    if (inspector.hidden || narrow) {
      inspector.style.removeProperty("width");
      overlay.style.removeProperty("right");
      return;
    }
    const width = clampPanel(panelWidth);
    inspector.style.width = `${width}px`;
    overlay.style.right = `${width}px`;
    resizer.setAttribute("aria-valuenow", String(width));
    resizer.setAttribute("aria-valuemax", String(clampPanel(Infinity)));
  }
  const resizer = make("div", "vam-inspector-resizer");
  resizer.setAttribute("role", "separator");
  resizer.setAttribute("aria-orientation", "vertical");
  resizer.setAttribute("aria-label", ui.resizePanel);
  resizer.setAttribute("aria-valuemin", String(PANEL_MIN));
  resizer.tabIndex = 0;
  const setPanelWidth = (width: number, remember: boolean): void => {
    panelWidth = clampPanel(width);
    applyPanelWidth();
    if (remember) storageSet(PANEL_WIDTH_KEY, String(panelWidth));
  };
  resizer.addEventListener("pointerdown", event => {
    event.preventDefault();
    const startX = event.clientX,
      startWidth = inspector.offsetWidth;
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add("is-resizing");
    doc.body.classList.add("vam-resizing");
    const move = (e: PointerEvent): void => setPanelWidth(startWidth + startX - e.clientX, false);
    const up = (): void => {
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", up);
      resizer.removeEventListener("pointercancel", up);
      resizer.classList.remove("is-resizing");
      doc.body.classList.remove("vam-resizing");
      setPanelWidth(panelWidth, true);
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", up);
    resizer.addEventListener("pointercancel", up);
  });
  resizer.addEventListener("keydown", event => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft") setPanelWidth(inspector.offsetWidth + step, true);
    else if (event.key === "ArrowRight") setPanelWidth(inspector.offsetWidth - step, true);
    else return;
    event.preventDefault();
  });
  let wasNarrow = isNarrow();
  window.addEventListener("resize", () => {
    applyPanelWidth();
    transform();
    // Crossing the phone breakpoint (rotating a phone, resizing a window) switches between the remembered state and the drawer default.
    if (isNarrow() !== wasNarrow) {
      wasNarrow = isNarrow();
      setOutlineOpen(wasNarrow ? false : outlineWanted(), false);
    }
  });

  function closeInspector(): void {
    selected = null;
    for (const card of cards.values()) {
      card.classList.remove("is-selected");
      card.setAttribute("aria-selected", "false");
    }
    inspector.hidden = true;
    workspace.classList.remove("has-inspector");
    inspector.replaceChildren();
    applyPanelWidth();
    refreshOutline();
  }
  function select(id: string): void {
    const node = byId.get(id);
    const source = info.get(id);
    if (!node || !source) return;
    const item = { ...source, ...textOf(source) };
    selected = id;
    for (const [key, card] of cards) {
      card.classList.toggle("is-selected", key === id);
      card.setAttribute("aria-selected", String(key === id));
    }
    inspector.replaceChildren(resizer);
    const heading = make("div", "vam-inspector-heading");
    heading.append(make("strong", undefined, ui.topicDetails));
    button(heading, ui.close, undefined, closeInspector);
    inspector.append(heading, make("h3", undefined, String(item.title ?? "")));
    const tier = isTier(item.tier) ? item.tier : undefined;
    if (tier) {
      const why = make("div", "vam-inspector-why");
      why.append(tierTag(tier));
      const reason =
        typeof item.reason === "string" && item.reason.trim() ? item.reason : item.manual ? ui.manualReason : "";
      if (reason) why.append(make("span", undefined, reason));
      inspector.append(why);
    }
    if (typeof item.summary === "string" && item.summary.trim())
      inspector.append(make("p", "vam-sample-summary", item.summary));
    const detail = make("div", "vam-sample-detail");
    if (typeof item.detailHtml === "string" && item.detailHtml.trim()) {
      if (item.compact) fillTranslatedDetail(doc, detail, item.detailHtml, item.compact, assets, ui);
      else fillDetail(doc, detail, item.detailHtml, assets, ui);
    } else detail.append(make("p", "vam-inspector-empty", ui.noContent));
    inspector.append(detail);
    const kids = kidsOf.get(id) ?? [];
    if (kids.length) {
      const list = make("div", "vam-subtopics");
      list.append(make("strong", undefined, ui.subtopics));
      for (const kid of kids)
        button(list, String(textOf(info.get(kid.id)!).title ?? ""), undefined, () => {
          if (node.collapsed) {
            node.collapsed = false;
            relayout(node.id);
          }
          select(kid.id);
          center(kid.id);
        });
      inspector.append(list);
    }
    inspector.hidden = false;
    workspace.classList.add("has-inspector");
    applyPanelWidth();
    inspector.scrollTop = 0;
    refreshOutline();
    revealCurrentRow();
  }

  // ---- layout menu
  const collapseTo = (levels: number | null): void => {
    applyCollapseLevel(nodes, levels);
    relayout();
    fit();
  };
  const closeMenu = (restoreFocus: boolean): void => {
    if (menu.hidden) return;
    menu.hidden = true;
    layoutButton.setAttribute("aria-expanded", "false");
    if (restoreFocus) layoutButton.focus();
  };
  function buildMenu(): void {
    menu.replaceChildren();
    const menuItems: ({ label: string; run: () => void } | null)[] = [
      { label: ui.collapseAll, run: () => collapseTo(0) },
      { label: ui.expandAll, run: () => collapseTo(null) },
      ...[1, 2, 3].map(level => ({ label: fill(ui.expandToLevel, level), run: () => collapseTo(level) })),
      null,
      {
        label: ui.autoLayout,
        run: () => {
          layout();
          drawEdges();
        }
      }
    ];
    for (const entry of menuItems) {
      if (!entry) {
        menu.append(make("hr"));
        continue;
      }
      const item = make("button", undefined, entry.label);
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.addEventListener("click", event => {
        event.stopPropagation();
        closeMenu(true);
        entry.run();
      });
      menu.append(item);
    }
  }
  const menuButtons = (): HTMLButtonElement[] => Array.from(menu.querySelectorAll("button"));
  layoutButton.addEventListener("click", event => {
    event.stopPropagation();
    if (!menu.hidden) return closeMenu(true);
    menu.hidden = false;
    layoutButton.setAttribute("aria-expanded", "true");
    menuButtons()[0]?.focus();
  });
  menu.addEventListener("keydown", event => {
    const items = menuButtons();
    const index = items.indexOf(doc.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") items[(index + 1) % items.length].focus();
    else if (event.key === "ArrowUp") items[(index - 1 + items.length) % items.length].focus();
    else if (event.key === "Home") items[0].focus();
    else if (event.key === "End") items[items.length - 1].focus();
    else if (event.key === "Tab") return closeMenu(false);
    else return;
    event.preventDefault();
  });
  doc.addEventListener("pointerdown", event => {
    if (!menu.hidden && !zoomBar.contains(event.target as Node)) closeMenu(false);
    const target = event.target as Node;
    if (isNarrow() && !outline.hidden && !outline.contains(target) && !outlineToggle.contains(target))
      setOutlineOpen(false, false);
  });
  doc.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if (!menu.hidden) closeMenu(true);
    else if (isNarrow() && !outline.hidden) {
      setOutlineOpen(false, false);
      outlineToggle.focus();
    } else if (!inspector.hidden) {
      const card = selected ? cards.get(selected) : undefined;
      closeInspector();
      card?.focus({ preventScroll: true });
    }
  });

  // ---- text in the language on screen
  /** Sets every piece of text the reader sees from `ui` and the language on screen; run at start and on each switch. */
  function applyText(): void {
    const mapText = mapTextNow();
    doc.title = mapText.title;
    mapHeading.textContent = mapText.title;
    stage.setAttribute("aria-label", mapText.title);
    sharedLabel.textContent = ui.readOnly;
    madeWith.textContent = ui.madeWithVam;
    install.textContent = ui.install;
    languageSelect.setAttribute("aria-label", ui.language);
    languageSelect.title = ui.language;
    if (originalUnknown)
      for (const option of Array.from(languageSelect.options))
        if (option.dataset.original) option.textContent = ui.originalText;
    if (mapText.goal) {
      goalLabel.textContent = fill(ui.goal, mapText.goal);
      goal.title = mapText.goal;
      if (!goal.parentElement) tools.append(goal);
      tools.hidden = false;
    } else {
      goal.remove();
      tools.hidden = true;
    }
    hint.textContent = ui.hint;
    const setLabel = (item: HTMLElement, label: string): void => {
      item.setAttribute("aria-label", label);
      item.title = label;
    };
    setLabel(zoomOutButton, ui.zoomOut);
    setLabel(zoomInButton, ui.zoomIn);
    setLabel(showAllButton, ui.showAll);
    layoutButton.textContent = ui.layout;
    inspector.setAttribute("aria-label", ui.topicDetails);
    outline.setAttribute("aria-label", ui.outline);
    outlineTree.setAttribute("aria-label", ui.outline);
    setLabel(outlineToggle, ui.outline);
    resizer.setAttribute("aria-label", ui.resizePanel);
    buildMenu();
    if (isTranslated()) {
      const notice = originalUnknown ? ui.aiTranslatedUnknown : fill(ui.aiTranslated, nameOf(original, language));
      translateNote.textContent = `${notice} ${ui.imageTextUntranslated}`;
      translateNote.hidden = false;
    } else translateNote.hidden = true;
    transform();
  }
  /** Switches the whole page to `code`: cards, side panel, goal, title, interface text and `<html lang>`. */
  function switchLanguage(code: string): void {
    if (code === language || !languages.includes(code)) return;
    language = code;
    ui = uiOf(code);
    if (languageStorageKey) storageSet(languageStorageKey, code);
    doc.documentElement.lang = code;
    const scroll = inspector.scrollTop;
    applyText();
    renderCards();
    drawEdges();
    buildOutline();
    if (selected !== null && byId.has(selected) && !inspector.hidden) {
      select(selected);
      inspector.scrollTop = scroll;
    }
    scheduleEdges();
  }
  languageSelect.addEventListener("change", () => switchLanguage(languageSelect.value));

  // ---- outline: the topic tree on the left. Folding it changes only the outline; a jump opens the map's folded ancestors.
  const outlineOrder: MapNode[] = [];
  const addToOutline = (node: MapNode): void => {
    outlineOrder.push(node);
    for (const kid of kidsOf.get(node.id) ?? []) addToOutline(kid);
  };
  for (const node of nodes) if (!node.parentId) addToOutline(node);
  const outlineFolded = new Set<string>();
  const outlineRows = new Map<string, HTMLElement>();
  let outlineStop: string | null = null;
  function outlineWanted(): boolean {
    return storageGet(OUTLINE_OPEN_KEY) !== "0";
  }
  function setOutlineOpen(open: boolean, remember: boolean): void {
    outline.hidden = !open;
    workspace.classList.toggle("has-outline", open);
    outlineToggle.setAttribute("aria-expanded", String(open));
    // Phone width treats the outline as a drawer that is always shut at first: it never reads or writes the remembered state.
    if (remember && !isNarrow()) storageSet(OUTLINE_OPEN_KEY, open ? "1" : "0");
  }
  const visibleOutline = (): MapNode[] => outlineOrder.filter(node => !outlineRows.get(node.id)?.hidden);
  function refreshOutline(): void {
    const shown: MapNode[] = [];
    for (const node of outlineOrder) {
      const row = outlineRows.get(node.id);
      if (!row) continue;
      let hide = false;
      for (let parent = node.parentId; parent && !hide; parent = byId.get(parent)?.parentId ?? null)
        hide = outlineFolded.has(parent);
      row.hidden = hide;
      if (!hide) shown.push(node);
      if (kidsOf.has(node.id)) row.setAttribute("aria-expanded", String(!outlineFolded.has(node.id)));
      if (node.id === selected) row.setAttribute("aria-current", "true");
      else row.removeAttribute("aria-current");
    }
    const stop = shown.find(node => node.id === outlineStop) ?? shown[0];
    for (const [id, row] of outlineRows) row.tabIndex = id === stop?.id ? 0 : -1;
  }
  /** Scrolls the outline (not the page) just enough to show the current row. */
  function revealCurrentRow(): void {
    const row = selected ? outlineRows.get(selected) : undefined;
    if (!row || row.hidden || !outline.clientHeight) return;
    if (row.offsetTop < outline.scrollTop) outline.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > outline.scrollTop + outline.clientHeight)
      outline.scrollTop = row.offsetTop + row.offsetHeight - outline.clientHeight;
  }
  function toggleOutlineFold(id: string): void {
    if (!outlineFolded.delete(id)) outlineFolded.add(id);
    refreshOutline();
  }
  function focusOutlineRow(id: string): void {
    outlineStop = id;
    refreshOutline();
    outlineRows.get(id)?.focus();
  }
  function markSelected(): void {
    for (const [key, card] of cards) {
      card.classList.toggle("is-selected", key === selected);
      card.setAttribute("aria-selected", String(key === selected));
    }
  }
  /** A click on an outline topic: open the folded ancestors, bring the card to the middle, select and focus it. */
  function goTo(id: string): void {
    const node = byId.get(id);
    if (!node) return;
    let reopened = false;
    let guard = 0;
    for (let parent = node.parentId; parent && guard++ <= nodes.length; parent = byId.get(parent)?.parentId ?? null) {
      const ancestor = byId.get(parent);
      if (ancestor?.collapsed) {
        ancestor.collapsed = false;
        reopened = true;
      }
    }
    selected = id;
    if (reopened) relayout();
    center(id);
    if (!inspector.hidden) select(id);
    else markSelected();
    refreshOutline();
    revealCurrentRow();
    if (isNarrow()) setOutlineOpen(false, false);
    cards.get(id)?.focus({ preventScroll: true });
  }
  function outlineKey(event: KeyboardEvent, node: MapNode): void {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
    const list = visibleOutline();
    const index = list.indexOf(node);
    const kids = kidsOf.get(node.id) ?? [];
    const folded = outlineFolded.has(node.id);
    let next: MapNode | undefined;
    switch (event.key) {
      case "ArrowDown":
        next = list[index + 1];
        break;
      case "ArrowUp":
        next = list[index - 1];
        break;
      case "Home":
        next = list[0];
        break;
      case "End":
        next = list[list.length - 1];
        break;
      case "ArrowRight":
        if (kids.length && folded) toggleOutlineFold(node.id);
        else next = kids[0];
        break;
      case "ArrowLeft":
        if (kids.length && !folded) toggleOutlineFold(node.id);
        else next = node.parentId ? byId.get(node.parentId) : undefined;
        break;
      case "Enter":
      case " ":
        goTo(node.id);
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next) focusOutlineRow(next.id);
  }
  /** Rebuilds the rows (run at start and on a language switch); the folds and the current topic carry over. */
  function buildOutline(): void {
    outlineTree.replaceChildren();
    outlineRows.clear();
    for (const node of outlineOrder) {
      const title = String(textOf(info.get(node.id)!).title ?? "");
      const row = make("div", "vam-outline-item");
      row.dataset.outlineId = node.id;
      row.setAttribute("role", "treeitem");
      const level = depthOf(node) + 1;
      row.setAttribute("aria-level", String(level));
      row.style.setProperty("--depth", String(level - 1));
      const twist = make("span", "vam-outline-twist");
      if (kidsOf.has(node.id)) {
        twist.append(icon("chevron"));
        twist.addEventListener("click", event => {
          event.stopPropagation();
          toggleOutlineFold(node.id);
        });
      }
      const label = make("span", "vam-outline-title", title);
      label.title = title;
      row.append(twist, label);
      const markers = markersOf(info.get(node.id)!);
      if (markers.length) {
        row.append(markerRow(markers));
        row.setAttribute("aria-label", nameWithMarkers(title, markers));
      }
      row.addEventListener("click", () => goTo(node.id));
      row.addEventListener("keydown", event => outlineKey(event, node));
      row.addEventListener("focus", () => {
        if (outlineStop !== node.id) {
          outlineStop = node.id;
          refreshOutline();
        }
      });
      outlineTree.append(row);
      outlineRows.set(node.id, row);
    }
    refreshOutline();
  }

  // ---- pan, pinch and wheel
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;
  let panMoved = false;
  viewport.addEventListener("pointerdown", event => {
    if ((event.target as Element).closest(".vam-node") || (event.pointerType === "mouse" && event.button !== 0)) return;
    viewport.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewport.classList.add("is-panning");
    if (pointers.size === 1) panMoved = false;
    if (pointers.size === 2) {
      const [a, b] = Array.from(pointers.values());
      pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  viewport.addEventListener("pointermove", event => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2 && pinchDistance) {
      const [a, b] = Array.from(pointers.values());
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const rect = viewport.getBoundingClientRect();
      zoomBy(distance / pinchDistance, { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top });
      pinchDistance = distance;
      panMoved = true;
      return;
    }
    const dx = event.clientX - previous.x,
      dy = event.clientY - previous.y;
    panMoved ||= Math.abs(dx) + Math.abs(dy) > 0;
    view = { ...view, x: view.x + dx, y: view.y + dy };
    transform();
  });
  const endPan = (event: PointerEvent): void => {
    if (!pointers.delete(event.pointerId)) return;
    if (pointers.size < 2) pinchDistance = 0;
    if (!pointers.size) {
      viewport.classList.remove("is-panning");
      if (!panMoved && event.type === "pointerup" && !inspector.hidden) closeInspector();
    }
  };
  viewport.addEventListener("pointerup", endPan);
  viewport.addEventListener("pointercancel", endPan);
  viewport.addEventListener(
    "wheel",
    event => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      // Pinch on a trackpad arrives as ctrl+wheel; a mouse wheel moves in notches. Two-finger scrolling pans.
      const zoomGesture =
        event.ctrlKey || event.metaKey || event.deltaMode === 1 || (!event.deltaX && Math.abs(event.deltaY) >= 50);
      if (zoomGesture)
        zoomBy(Math.exp(-event.deltaY * (event.deltaMode === 0 ? 0.0015 : 0.04)), {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top
        });
      else {
        view = { ...view, x: view.x - event.deltaX, y: view.y - event.deltaY };
        transform();
      }
    },
    { passive: false }
  );

  if (typeof ResizeObserver !== "undefined")
    new ResizeObserver(() => {
      if (!fitPending) return;
      fitPending = false;
      fit();
    }).observe(viewport);

  // ---- first view: every root and its first level, zoomed to show all
  applyText();
  buildOutline();
  setOutlineOpen(isNarrow() ? false : outlineWanted(), false);
  applyCollapseLevel(nodes, 1);
  renderCards();
  layout();
  drawEdges();
  fit();
  const fonts = (doc as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
  if (fonts)
    void fonts.ready.then(() => {
      if (selected !== null || pointers.size) return;
      layout();
      drawEdges();
      fit();
    });
}
