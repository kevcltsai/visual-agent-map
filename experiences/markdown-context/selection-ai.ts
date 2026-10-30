import { Component, MarkdownRenderer, MarkdownView, Notice, Platform, setIcon, type App, type Editor } from "obsidian";
import { getUiLanguage, t } from "../../i18n";
import type { PreparedStep } from "../../core/step-runner";
import { unsafeMermaid } from "../../ai/mermaid-safety";
import { prepareStep } from "../../core/step-runner";
import { imageMarkdown, type ImageCandidate } from "../../core/image-candidates";
import { imageSearchStep } from "../../core/steps/image-search/step";
import { loadableImages } from "../../ui/image-candidates";
import { ImageTranslateAction, type ImageToken } from "./image-translate-action";
import { planStep } from "./steps/plan/step";
import { transformStep } from "./steps/transform/step";
import { captionStep } from "./steps/caption/step";
import { condensePresetStep, searchImagesPresetStep, translatePresetStep } from "./steps/presets/step";

interface SelectionSnapshot {
  view: MarkdownView;
  path: string;
  text: string;
  markdown: string;
  matchAt: number;
  rect: DOMRect;
}

interface SelectionAiOptions {
  model: () => string;
  /** Show the selection button and open the panel on image clicks; the command opens the panel either way. */
  autoOpen: () => boolean;
  /**
   * Name of the language the AI writes in for this selection: the language its letters settle, else a clause telling
   * the model to follow the selected text, else the interface language (D-2026-10-83).
   */
  language: (selectedText: string) => string;
  /**
   * Name of the language the Translate quick action translates into: the interface language (absent: `language`), because the
   * selection's own language is what is being translated away from (and `language` may be a follow-the-text clause).
   */
  translateTarget?: () => string;
  run: <Input, Output>(
    prepared: PreparedStep<Input, Output>,
    model: string,
    signal: AbortSignal,
    image?: HTMLImageElement,
    webSearch?: boolean,
    generateImage?: boolean
  ) => Promise<string>;
  /** Saves a generated image as an attachment of `notePath`; returns its vault path. */
  saveImage: (dataUrl: string, notePath: string, name: string) => Promise<string>;
}

function findUnique(source: string, selected: string): number {
  if (!selected) return -1;
  const first = source.indexOf(selected);
  return first >= 0 && source.indexOf(selected, first + selected.length) < 0 ? first : -1;
}

function positionAt(source: string, offset: number): { line: number; ch: number } {
  const before = source.slice(0, offset);
  const line = before.split("\n").length - 1;
  return { line, ch: before.length - (before.lastIndexOf("\n") + 1) };
}

/**
 * Which embed in `markdown` the clicked image came from. VAM notes often show the same image twice (preview and
 * detail), so a single match is not enough: the reading view's line range, the editor position, or the order of
 * the rendered copies picks the one that was clicked. Null when none of these can tell.
 */
function locateImageToken(
  view: MarkdownView,
  image: HTMLImageElement,
  markdown: string,
  matches: RegExpMatchArray[]
): ImageToken | null {
  if (!matches.length) return null;
  const toToken = (match: RegExpMatchArray): ImageToken => {
    const same = matches.filter(item => item[0] === match[0]);
    return { text: match[0], occurrence: same.indexOf(match), count: same.length };
  };
  if (matches.length === 1) return toToken(matches[0]);
  // Reading view: the plugin tags each rendered block with its source lines.
  const block = image.closest<HTMLElement>("[data-vam-line-start]");
  if (block) {
    const lineOffset = (line: number): number => {
      let offset = 0;
      for (let index = 0; index < line && offset >= 0; index++) offset = markdown.indexOf("\n", offset) + 1 || -1;
      return offset < 0 ? markdown.length : offset;
    };
    const from = lineOffset(Number(block.dataset.vamLineStart));
    const to = lineOffset(Number(block.dataset.vamLineEnd) + 1);
    const inside = matches.filter(match => (match.index ?? -1) >= from && (match.index ?? -1) < to);
    if (inside.length === 1) return toToken(inside[0]);
  }
  // Live preview: the editor knows the document position of the rendered image.
  const cm = (view.editor as unknown as { cm?: { posAtDOM(node: Node): number } }).cm;
  try {
    const pos = cm?.posAtDOM(image);
    if (typeof pos === "number" && pos >= 0) {
      const nearest = [...matches].sort((a, b) => Math.abs((a.index ?? 0) - pos) - Math.abs((b.index ?? 0) - pos))[0];
      if (nearest) return toToken(nearest);
    }
  } catch {
    /* Not rendered by the editor. */
  }
  // Last resort: the rendered copies, in page order, match the embeds one to one.
  const rendered = Array.from(view.containerEl.querySelectorAll("img")).filter(
    item => item.getAttribute("src") === image.getAttribute("src")
  );
  return rendered.length === matches.length ? toToken(matches[rendered.indexOf(image)]) : null;
}

/** Unique heading ids for open panels. */
let panelSequence = 0;

export class MarkdownSelectionAi extends Component {
  private launcher: HTMLButtonElement | null = null;
  private snapshot: SelectionSnapshot | null = null;
  private panel: SelectionAiPanel | null = null;
  private imageAction!: ImageTranslateAction;

  constructor(
    private readonly app: App,
    private readonly options: SelectionAiOptions
  ) {
    super();
  }

  onload(): void {
    this.imageAction = this.addChild(new ImageTranslateAction(this.app, this.options));
    this.launcher = this.app.workspace.containerEl.createEl("button", {
      cls: "vam-context-ai-launcher",
      text: t("ui.context_ai_open")
    });
    this.launcher.setAttribute("aria-label", t("ui.context_ai_open"));
    this.launcher.hidden = true;
    this.registerDomEvent(this.launcher, "pointerdown", event => event.preventDefault());
    this.registerDomEvent(this.launcher, "click", () => this.openForCurrentSelection());
    this.registerDomEvent(document, "selectionchange", () =>
      window.requestAnimationFrame(() => this.onSelectionActivity())
    );
    this.registerDomEvent(document, "pointerup", () => window.requestAnimationFrame(() => this.onSelectionActivity()));
    this.registerDomEvent(document, "keyup", () => window.requestAnimationFrame(() => this.onSelectionActivity()));
    this.registerEvent(
      this.app.workspace.on("editor-change", () => window.requestAnimationFrame(() => this.onSelectionActivity()))
    );
    this.registerDomEvent(document, "click", event => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement) || !this.options.autoOpen()) return;
      if (image.closest(".vam-context-ai-panel, .vam-image-action")) return;
      const view = this.app.workspace
        .getLeavesOfType("markdown")
        .map(leaf => leaf.view)
        .find(candidate => candidate instanceof MarkdownView && candidate.containerEl.contains(image));
      if (!(view instanceof MarkdownView) || !view.file) return;
      const markdown = view.editor.getValue();
      const embeddedPath = image.closest(".internal-embed")?.getAttribute("src");
      const tokens = [...markdown.matchAll(/!\[\[[^\]\n]+\]\]|!\[[^\]\n]*\]\([^\n]+?\)/g)].filter(match => {
        if (embeddedPath) {
          const target = match[0].startsWith("![[") ? match[0].slice(3, -2).split("|")[0] : "";
          const source = this.app.metadataCache.getFirstLinkpathDest(embeddedPath.split("#")[0], view.file!.path);
          const candidate = this.app.metadataCache.getFirstLinkpathDest(target.split("#")[0], view.file!.path);
          return !!source && source === candidate;
        }
        const target = match[0].match(/\]\(([^)]+)\)$/)?.[1]?.replace(/^<|>$/g, "");
        return target === image.currentSrc || target === image.src;
      });
      // An image offers one action, a translated version of itself; the text panel is for selected text.
      this.imageAction.show(view, image, locateImageToken(view, image, markdown, tokens));
    });
    this.registerDomEvent(window, "resize", () => {
      this.panel?.reposition();
      this.onSelectionActivity();
    });
    this.registerDomEvent(
      document,
      "scroll",
      event => {
        if (event.target instanceof Element && event.target.closest(".vam-context-ai-panel")) return;
        this.hideLauncher();
        // Scrolling the note never throws away a running request or a draft; only an idle panel closes.
        if (!this.panel?.hasWork) this.panel?.close();
      },
      true
    );
  }

  onunload(): void {
    this.panel?.close();
    this.launcher?.remove();
    this.launcher = null;
  }

  private onSelectionActivity(): void {
    if (this.options.autoOpen()) this.updateLauncher();
    else if (!this.panel?.isOpen) this.hideLauncher();
  }

  /** Captures the current selection; shows the launcher only when `showLauncher` is true. */
  private updateLauncher(showLauncher = true): void {
    if (this.panel?.isOpen) return;
    if (this.launcher && !this.launcher.isConnected) {
      this.app.workspace.containerEl.appendChild(this.launcher);
    }
    const selection = window.getSelection();
    const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null;
    const view = this.app.workspace
      .getLeavesOfType("markdown")
      .map(leaf => leaf.view)
      .find(
        candidate =>
          candidate instanceof MarkdownView &&
          candidate.file &&
          (range
            ? candidate.containerEl.contains(range.commonAncestorContainer)
            : candidate.getMode() === "source" && candidate.containerEl.contains(document.activeElement))
      );
    if (!(view instanceof MarkdownView) || !view.file) {
      this.hideLauncher();
      return;
    }
    const text = (view.getMode() === "source" ? view.editor.getSelection() : (selection?.toString() ?? "")).trim();
    const rects = range?.getClientRects();
    const editorSelection = view.containerEl.querySelector(".cm-selectionBackground");
    const rangeRect = rects?.length ? rects[rects.length - 1] : range?.getBoundingClientRect();
    const rect =
      rangeRect && (rangeRect.width || rangeRect.height) ? rangeRect : editorSelection?.getBoundingClientRect();
    if (!text || !rect || (!rect.width && !rect.height)) {
      this.hideLauncher();
      return;
    }
    const markdown = view.editor.getValue();
    let matchAt = findUnique(markdown, text);
    if (view.getMode() === "source") {
      const from = view.editor.posToOffset(view.editor.getCursor("from"));
      const selected = view.editor.getSelection();
      const start = from + selected.indexOf(text);
      if (markdown.slice(start, start + text.length) === text) matchAt = start;
    }
    this.snapshot = { view, path: view.file.path, text, markdown, matchAt, rect };
    const launcher = this.launcher;
    if (!launcher || !showLauncher) return;
    launcher.hidden = false;
    const left = Math.max(8, Math.min(rect.right, window.innerWidth - 120));
    const top = rect.bottom + 6 + 42 < window.innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - 42);
    launcher.style.left = `${left}px`;
    launcher.style.top = `${top}px`;
  }

  private hideLauncher(): void {
    if (this.launcher) this.launcher.hidden = true;
    this.snapshot = null;
  }

  openForSelection(checking = false): boolean {
    if (this.panel?.isOpen) {
      if (!checking) this.panel.focus();
      return true;
    }
    this.updateLauncher(this.options.autoOpen());
    if (!this.snapshot) {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view?.file || view.getMode() !== "source") return false;
      const markdown = view.editor.getValue();
      const matchAt = view.editor.posToOffset(view.editor.getCursor());
      this.snapshot = {
        view,
        path: view.file.path,
        text: "",
        markdown,
        matchAt,
        rect: view.containerEl.getBoundingClientRect()
      };
    }
    if (!checking) this.openForCurrentSelection();
    return true;
  }

  private openForCurrentSelection(): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    this.hideLauncher();
    this.panel?.close();
    this.panel = new SelectionAiPanel(
      this.app,
      snapshot,
      this.options.model,
      this.options.language(snapshot.text),
      this.options.translateTarget?.() ?? this.options.language(snapshot.text),
      this.options.run
    );
    this.panel.open();
  }
}

type PresetId = "condense" | "translate" | "search_images";

class SelectionAiPanel extends Component {
  private modalEl!: HTMLDivElement;
  private contentEl!: HTMLDivElement;
  private titleEl!: HTMLHeadingElement;
  private previousFocus: HTMLElement | null = null;
  isOpen = false;
  private controller: AbortController | null = null;
  private insertAfter = false;
  private preview!: HTMLElement;
  private previewChild: Component | null = null;
  private instruction!: HTMLTextAreaElement;
  private status!: HTMLElement;
  private output!: HTMLTextAreaElement;
  private result!: HTMLElement;
  private before!: HTMLElement;
  private presets!: HTMLElement;
  private resultActions!: HTMLElement;
  private accept!: HTMLButtonElement;
  private insertHere!: HTMLButtonElement;
  private append!: HTMLButtonElement;
  private copy!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private runButton!: HTMLButtonElement;

  constructor(
    private readonly app: App,
    private readonly snapshot: SelectionSnapshot,
    private readonly modelOf: () => string,
    private readonly language: string,
    private readonly translateTarget: string,
    private readonly run: SelectionAiOptions["run"]
  ) {
    super();
  }

  open(): void {
    this.isOpen = true;
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.modalEl = this.app.workspace.containerEl.createDiv({ cls: "vam-context-ai-panel" });
    this.modalEl.setAttribute("role", "dialog");
    // Named by its heading: an aria-label would also show as an Obsidian tooltip.
    const titleId = `vam-context-ai-title-${++panelSequence}`;
    this.modalEl.setAttribute("aria-labelledby", titleId);
    const header = this.modalEl.createDiv({ cls: "vam-context-ai-header" });
    this.titleEl = header.createEl("h3");
    this.titleEl.id = titleId;
    const close = header.createEl("button", { cls: "clickable-icon vam-context-ai-close" });
    close.setAttribute("aria-label", t("ui.close"));
    setIcon(close, "x");
    close.addEventListener("click", () => this.close());
    this.contentEl = this.modalEl.createDiv({ cls: "vam-context-ai-body" });
    this.load();
    this.registerDomEvent(
      document,
      "keydown",
      event => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          // Escape first stops a running request; a second Escape closes.
          if (this.controller) this.stop();
          else this.close();
        }
      },
      true
    );
    this.registerDomEvent(document, "pointerdown", event => {
      if (event.target instanceof Element && event.target.closest(".modal-container")) return;
      // A click outside closes only an idle panel; a running request or a draft survives a stray click.
      if (event.target instanceof Node && !this.modalEl.contains(event.target) && !this.hasWork) this.close(false);
    });
    // Images in the panel load after it opens: keep the whole panel, footer included, inside the window.
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => this.reposition());
      for (const part of Array.from(this.contentEl.children)) observer.observe(part);
      this.register(() => observer.disconnect());
    }
    this.reposition();
    this.focus();
  }

  focus(): void {
    this.instruction?.focus();
  }

  /** Whether closing would lose something: a request in flight or a draft or image not yet inserted. */
  get hasWork(): boolean {
    return !!this.controller || (!!this.resultActions && !this.resultActions.hidden);
  }

  reposition(): void {
    if (!this.isOpen) return;
    const rect = this.snapshot.rect;
    const width = Math.min(480, window.innerWidth - 24);
    this.modalEl.style.width = `${width}px`;
    this.modalEl.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    // Natural height is the header plus the full body; the body scrolls when the window is shorter.
    const header = this.titleEl?.parentElement?.offsetHeight ?? 0;
    const natural = header + (this.contentEl?.scrollHeight ?? this.modalEl.scrollHeight);
    const height = Math.min(natural, window.innerHeight - 24);
    const top = Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - height - 12));
    this.modalEl.style.top = `${top}px`;
    this.modalEl.style.maxHeight = `${window.innerHeight - top - 12}px`;
  }

  close(restoreFocus = true): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.unload();
    this.modalEl.remove();
    if (restoreFocus && this.previousFocus?.isConnected) this.previousFocus.focus();
  }

  onload(): void {
    this.titleEl.setText(t("ui.context_ai_title"));
    this.contentEl.empty();
    this.contentEl.createEl("p", { cls: "vam-hint vam-context-ai-intro", text: t("ui.context_ai_scope") });

    // What AI will work on: the selected text, or the cursor position.
    const source = this.contentEl.createEl("figure", { cls: "vam-context-ai-source" });
    if (this.snapshot.text) {
      source.createEl("blockquote", { cls: "vam-context-ai-quote", text: this.snapshot.text });
      source.createEl("figcaption", { text: t("ui.context_ai_text_source") });
    } else source.createEl("figcaption", { text: t("ui.context_ai_cursor_source") });

    this.presets = this.contentEl.createDiv({ cls: "vam-context-ai-presets" });
    this.presets.setAttribute("role", "group");
    this.presets.setAttribute("aria-label", t("ui.context_ai_quick_actions"));
    const preset = (id: PresetId, icon: string, label: string, prompt: () => string): void => {
      const button = this.presets.createEl("button", { cls: "vam-context-ai-preset" });
      button.dataset.preset = id;
      setIcon(button.createSpan({ cls: "vam-context-ai-preset-icon" }), icon);
      button.createSpan({ text: label });
      // A quick action never overwrites what the person typed; it only says what is running.
      button.addEventListener(
        "click",
        () => void this.generate(prompt(), label, id === "search_images" ? "image_search" : undefined, button)
      );
    };
    const language = getUiLanguage();
    preset("condense", "minimize-2", t("ui.context_ai_condense"), () => condensePresetStep.render({ language }));
    preset("translate", "languages", t("ui.context_ai_translate"), () =>
      translatePresetStep.render({ language, target: this.translateTarget })
    );
    preset("search_images", "image", t("ui.context_ai_search_images"), () =>
      searchImagesPresetStep.render({ language })
    );

    // Searching sends a query off the device, so say so before anyone presses it.
    this.contentEl.createEl("p", {
      cls: "vam-hint vam-context-ai-disclosure",
      text: t("ui.context_ai_search_disclosure")
    });
    // A visually hidden label names the field; an aria-label would show as an Obsidian tooltip over it.
    const instructionLabel = this.contentEl.createEl("label", { cls: "vam-context-ai-field" });
    instructionLabel.createSpan({ cls: "vam-context-ai-sr", text: t("ui.context_ai_custom_instruction") });
    this.instruction = instructionLabel.createEl("textarea", { cls: "vam-context-ai-instruction" });
    this.instruction.rows = 2;
    this.instruction.placeholder = t("ui.context_ai_instruction_placeholder");
    this.instruction.addEventListener("keydown", event => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) {
        event.preventDefault();
        this.runCustom();
      }
    });

    this.status = this.contentEl.createDiv({ cls: "vam-context-ai-status" });
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");

    // Found images or a diagram come before the draft: pick first, then review what will be written.
    this.preview = this.contentEl.createDiv({ cls: "vam-context-ai-preview" });
    // The draft: a before/after pair for a replaceable selection, otherwise just the editable draft.
    this.result = this.contentEl.createDiv({ cls: "vam-context-ai-result" });
    this.result.hidden = true;
    this.before = this.result.createDiv({ cls: "vam-context-ai-diff" });
    this.before.createSpan({ cls: "vam-context-ai-label", text: t("ui.context_ai_before") });
    this.before.createEl("del", { cls: "vam-context-ai-before", text: this.snapshot.text });
    const draftLabel = this.result.createEl("label", { cls: "vam-context-ai-diff" });
    draftLabel.createSpan({ cls: "vam-context-ai-label", text: t("ui.context_ai_result") });
    this.output = draftLabel.createEl("textarea", { cls: "vam-context-ai-output" });
    this.output.rows = 5;

    const footer = this.contentEl.createDiv({ cls: "vam-context-ai-footer" });
    this.resultActions = footer.createDiv({ cls: "vam-context-ai-result-actions" });
    this.resultActions.hidden = true;
    this.copy = this.resultActions.createEl("button", { text: t("ui.context_ai_copy") });
    this.copy.addEventListener("click", () => {
      if (!navigator.clipboard) {
        this.status.setText(t("ui.context_ai_copy_failed"));
        return;
      }
      void navigator.clipboard
        .writeText(this.output.value)
        .then(() => this.status.setText(t("ui.context_ai_copied")))
        .catch(() => this.status.setText(t("ui.context_ai_copy_failed")));
    });
    this.append = this.resultActions.createEl("button", { text: t("ui.context_ai_append") });
    this.append.addEventListener("click", () => this.applyDraft("append"));
    this.insertHere = this.resultActions.createEl("button", { text: t("ui.context_ai_insert_here") });
    this.insertHere.addEventListener("click", () => this.applyDraft("after"));
    this.accept = this.resultActions.createEl("button", { text: t("ui.context_ai_accept") });
    this.accept.addEventListener("click", () => this.applyResult(this.output.value, "replace", this.status));

    const bar = footer.createDiv({ cls: "vam-context-ai-bar" });
    bar.createSpan({
      cls: "vam-context-ai-shortcut",
      text: t("ui.context_ai_shortcut", Platform.isMacOS ? "⌘" : "Ctrl")
    });
    this.stopButton = bar.createEl("button", { text: t("ui.cancel") });
    this.stopButton.addEventListener("click", () => {
      if (this.controller) this.stop();
      else this.close();
    });
    this.runButton = bar.createEl("button", { text: t("ui.context_ai_run_custom"), cls: "mod-cta" });
    this.runButton.addEventListener("click", () => this.runCustom());
    this.showResult(false);
  }

  onunload(): void {
    this.controller?.abort();
    this.controller = null;
    this.previewChild?.unload();
    this.contentEl.empty();
  }

  private runCustom(): void {
    if (this.controller) return;
    const prompt = this.instruction.value.trim();
    if (!prompt) {
      this.status.setText(t("ui.context_ai_enter_instruction"));
      this.instruction.focus();
      return;
    }
    void this.generate(prompt, t("ui.context_ai_run_custom"));
  }

  /** Stops the running request and keeps the panel, the typed instruction and any earlier draft. */
  private stop(): void {
    this.controller?.abort();
    this.controller = null;
    this.setBusy(null);
    this.status.setText(t("ui.ai_task_cancelled"));
    this.showResult(!!this.output.value);
  }

  /** Locks the inputs while AI runs; the pressed action is marked so the person sees what is running. */
  private setBusy(active: HTMLElement | null | undefined): void {
    const busy = active !== null;
    this.modalEl.toggleClass("is-running", busy);
    this.status.toggleClass("is-running", busy);
    for (const button of Array.from(this.presets.querySelectorAll("button"))) {
      button.disabled = busy;
      button.toggleClass("is-active", busy && button === active);
    }
    this.runButton.disabled = busy;
    this.resultActions.querySelectorAll("button").forEach(button => {
      button.disabled = busy;
    });
    this.stopButton.setText(busy ? t("ui.context_ai_stop") : t("ui.cancel"));
    if (!busy) this.showResult(!this.resultActions.hidden);
  }

  /** Shows or hides the draft and picks the primary result action: accept a replacement, else insert here. */
  private showResult(visible: boolean): void {
    this.result.hidden = !visible;
    this.resultActions.hidden = !visible;
    const replaceable = this.snapshot.matchAt >= 0 && !!this.snapshot.text && !this.insertAfter;
    this.before.hidden = !replaceable;
    this.accept.hidden = !replaceable;
    this.insertHere.hidden = this.snapshot.matchAt < 0;
    const insertable = this.snapshot.matchAt >= 0;
    this.accept.toggleClass("mod-cta", replaceable);
    this.insertHere.toggleClass("mod-cta", !replaceable && insertable);
    this.append.toggleClass("mod-cta", !replaceable && !insertable);
    // With a draft to review, the source shrinks so the draft and its actions stay in view.
    this.modalEl.toggleClass("has-result", visible);
    // Once there is a draft, applying it is the main action; running another instruction steps back.
    this.runButton.toggleClass("mod-cta", !visible);
    if (visible) this.reposition();
  }

  private async generate(
    prompt: string,
    label: string,
    requestedAction?: "image_search",
    trigger?: HTMLElement
  ): Promise<void> {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    const output = this.output,
      status = this.status;
    const previousDraft = output.value;
    const previousInsertAfter = this.insertAfter;
    this.previewChild?.unload();
    this.previewChild = null;
    this.preview.empty();
    this.setBusy(trigger);
    status.setText(t("ui.context_ai_running_0", label));
    // Read the current model when this run starts, so a switch while the panel stays open applies to the next run.
    const model = this.modelOf();
    try {
      const at = this.snapshot.matchAt;
      const context =
        at >= 0 ? this.snapshot.markdown.slice(Math.max(0, at - 600), at + this.snapshot.text.length + 600) : "";
      const planned = prepareStep(planStep, {
        instruction: prompt,
        selected: this.snapshot.text,
        context,
        hasImage: false
      });
      const parsedPlan = planned.parse(await this.run(planned, model, controller.signal));
      const plan = requestedAction ? { ...parsedPlan, action: requestedAction } : parsedPlan;
      if (controller.signal.aborted || !this.isOpen) return;
      if (plan.action === "clarify") throw new Error(plan.instruction || t("ui.context_ai_clarify"));
      if (plan.action === "image_generate") throw new Error(t("ui.context_ai_generation_unavailable"));
      let result: string;
      let insertAfter = false;
      if (plan.action === "image_search") {
        status.setText(t("ui.context_ai_searching_images"));
        const search = prepareStep(imageSearchStep, { query: plan.query || prompt });
        const found = search.parse(await this.run(search, model, controller.signal, undefined, true));
        if (controller.signal.aborted || !this.isOpen) return;
        // Web results can be stale or block hotlinking: offer only images that actually load.
        const candidates = await loadableImages(found, controller.signal);
        if (controller.signal.aborted || !this.isOpen) return;
        if (!candidates.length) throw new Error(t("ui.context_ai_no_images"));
        insertAfter = true;
        const grid = this.preview.createDiv({ cls: "vam-context-ai-image-grid" });
        grid.setAttribute("role", "radiogroup");
        grid.setAttribute("aria-label", t("ui.context_ai_choose_image"));
        candidates.forEach((candidate, index) => {
          const card = grid.createDiv({ cls: "vam-context-ai-image-choice" });
          const choose = card.createEl("button", { cls: "vam-context-ai-image-pick" });
          choose.setAttribute("role", "radio");
          choose.setAttribute("aria-checked", String(index === 0));
          choose.setAttribute("aria-label", candidate.title);
          card.toggleClass("is-selected", index === 0);
          const thumb = choose.createEl("img", {
            attr: { src: candidate.url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }
          });
          choose.createSpan({ cls: "vam-context-ai-image-title", text: candidate.title });
          thumb.addEventListener("error", () => {
            choose.disabled = true;
            card.addClass("is-broken");
          });
          choose.addEventListener("click", () => {
            if (this.controller) return;
            grid.querySelectorAll(".vam-context-ai-image-choice").forEach(item => {
              item.toggleClass("is-selected", item === card);
              item.querySelector("button")?.setAttribute("aria-checked", String(item === card));
            });
            const choice = new AbortController();
            this.controller = choice;
            this.setBusy(choose);
            status.setText(t("ui.context_ai_generating"));
            void this.imageDraft(candidate, plan.captionInstruction, choice.signal, model)
              .then(draft => {
                if (this.controller === choice && !choice.signal.aborted && this.isOpen) {
                  output.value = draft;
                  status.setText(t("ui.context_ai_review_result"));
                }
              })
              .catch((error: unknown) => {
                if (!choice.signal.aborted && this.isOpen)
                  status.setText(error instanceof Error ? error.message : String(error));
              })
              .finally(() => {
                if (this.controller !== choice) return;
                this.controller = null;
                if (this.isOpen) {
                  this.result.hidden = false;
                  this.setBusy(null);
                }
              });
          });
          card.createEl("a", {
            text: t("ui.context_ai_image_source_link"),
            href: candidate.source,
            attr: { target: "_blank", rel: "noopener noreferrer" }
          });
        });
        result = await this.imageDraft(candidates[0], plan.captionInstruction, controller.signal, model);
        if (controller.signal.aborted || !this.isOpen) return;
      } else {
        status.setText(t("ui.context_ai_running_0", label));
        const request = prepareStep(transformStep, {
          instruction: plan.instruction || prompt,
          selected: this.snapshot.text,
          context,
          action: plan.action,
          hasImage: false
        });
        result = await this.run(request, model, controller.signal, undefined, plan.action === "research");
        insertAfter = plan.action === "research" || plan.action === "diagram";
        if (plan.action === "diagram") {
          // CRLF and a lone CR are line breaks to the renderer too; normalize so no directive hides on a "line" the check never saw.
          result = result.replace(/\r\n?/g, "\n");
          if (
            !/^```mermaid[ \t]*\n(?:(?!```)[\s\S])+\n```$/.test(result.trim()) ||
            unsafeMermaid(result.trim().split("\n").slice(1, -1)) ||
            /(?:%%\{|@\{|\bimg\s*:|\bimage\s*:|\burl\s*\(|https?:|data:|file:|javascript:)/i.test(result)
          )
            throw new Error(t("ui.context_ai_invalid_diagram"));
          this.previewChild = new Component();
          this.previewChild.load();
          await MarkdownRenderer.render(this.app, result, this.preview, this.snapshot.path, this.previewChild);
        }
      }
      if (controller.signal.aborted || !this.modalEl.isConnected) return;
      this.insertAfter = insertAfter;
      output.value = result.trim();
      this.result.hidden = !output.value;
      this.resultActions.hidden = !output.value;
      status.setText(t("ui.context_ai_review_result"));
    } catch (error) {
      if (!controller.signal.aborted && this.isOpen) {
        output.value = previousDraft;
        this.insertAfter = previousInsertAfter;
        this.result.hidden = !previousDraft;
        this.resultActions.hidden = !previousDraft;
        status.setText(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (this.controller === controller) {
        this.controller = null;
        if (this.modalEl.isConnected) this.setBusy(null);
      }
    }
  }

  private async imageDraft(
    candidate: ImageCandidate,
    captionInstruction: string,
    signal: AbortSignal,
    model: string
  ): Promise<string> {
    const markdown = imageMarkdown(candidate);
    if (!captionInstruction.trim()) return markdown;
    const image = createEl("img");
    image.referrerPolicy = "no-referrer";
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        window.clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        image.onload = null;
        image.onerror = null;
        if (error) reject(error);
        else resolve();
      };
      const abort = (): void => {
        image.src = "";
        finish(new Error(t("ui.ai_task_cancelled")));
      };
      const timeout = window.setTimeout(() => finish(new Error(t("ui.context_ai_image_load_failed"))), 15_000);
      image.onload = () => finish();
      image.onerror = () => finish(new Error(t("ui.context_ai_image_load_failed")));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else image.src = candidate.url;
    });
    const caption = await this.run(
      prepareStep(captionStep, { captionInstruction, language: this.language }),
      model,
      signal,
      image
    );
    return `${markdown}\n\n${caption.trim()}`;
  }

  private applyDraft(action: "append" | "after"): void {
    this.applyResult(this.output.value, action, this.status);
  }

  private applyResult(result: string, action: "append" | "replace" | "after", status: HTMLElement): void {
    const { view, path, markdown, text, matchAt } = this.snapshot;
    const viewStillOpen = this.app.workspace.getLeavesOfType("markdown").some(leaf => leaf.view === view);
    if (!viewStillOpen || view.file?.path !== path || view.editor.getValue() !== markdown) {
      status.setText(t("ui.context_ai_note_changed"));
      return;
    }
    const editor: Editor = view.editor;
    const value = result.trim();
    if (!value) {
      status.setText(t("ui.context_ai_result_empty"));
      return;
    }
    if (action === "replace") {
      if (!text || matchAt < 0 || editor.getValue().slice(matchAt, matchAt + text.length) !== text) {
        status.setText(t("ui.context_ai_replace_unavailable"));
        return;
      }
      editor.replaceRange(value, positionAt(markdown, matchAt), positionAt(markdown, matchAt + text.length));
    } else if (action === "after") {
      if (matchAt < 0) {
        status.setText(t("ui.context_ai_replace_unavailable"));
        return;
      }
      const end = text ? markdown.indexOf("\n", matchAt + text.length) : matchAt;
      const offset = end < 0 ? markdown.length : end;
      editor.replaceRange(`\n\n${value}\n`, positionAt(markdown, offset), positionAt(markdown, offset));
    } else {
      const separator = markdown.trim() ? (markdown.endsWith("\n") ? "\n" : "\n\n") : "";
      const addition = `${separator}${value}\n`;
      const end = positionAt(markdown, markdown.length);
      editor.replaceRange(addition, end, end);
    }
    this.close();
    new Notice(action === "replace" ? t("ui.context_ai_replaced") : t("ui.context_ai_appended"));
  }
}
