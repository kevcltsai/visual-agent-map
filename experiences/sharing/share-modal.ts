import { Modal, Notice, Setting, type App, type DropdownComponent, type ToggleComponent } from "obsidian";
import type { ReasoningLevel } from "../../ai/types";
import { FOLLOW_DEFAULT_MODEL } from "../../core/model-discovery";
import { isFollowInputLanguage, supportedLanguageLabel, t, type ContentLanguage } from "../../i18n";
import { actionStatus, modalActions } from "../../ui/modals/action-bar";
import { mapContentLanguage, mapTextLanguage } from "../visual-map/map-text-language";
import {
  BuildController,
  type AttachTranslationsOptions,
  formatBytes,
  isStaleBuild,
  pause,
  shareFileName,
  sizeAdvice,
  type BuildTicket
} from "./share-build";
import { ShareExporter, type ShareBuildResult, type ShareProgress, type ShareSource } from "./share-exporter";
import {
  SHARE_DEFAULT_INCLUDE_DETAIL,
  SHARE_SIZE_SUGGEST_NO_IMAGES_BYTES,
  SHARE_SIZE_WARN_BYTES,
  SHARE_TRANSLATION_LANGUAGES,
  type ShareLanguage,
  type ShareTranslationLanguage
} from "./share-format";
import type { ForbiddenString } from "./share-leak-scan";
import { saveShareFile, type SaveEnvironment } from "./share-save";
import type { ShareTranslationCache } from "./share-translate-plan";
import type {
  ShareLanguageResult,
  ShareTranslateDom,
  ShareTranslateEstimate,
  ShareTranslateResult,
  ShareTranslateService,
  ShareTranslateSource
} from "./share-translate-service";

/** What the dialog needs from the exporter (a test double stands in for the Obsidian-bound one). */
export interface ShareExporterLike {
  ensureRendered(ticket: BuildTicket, onProgress: (progress: ShareProgress) => void): Promise<void>;
  ensureImages(ticket: BuildTicket, onProgress: (progress: ShareProgress) => void): Promise<void>;
  assemble(
    options: { includeDetail: boolean; includeImages: boolean },
    translation?: AttachTranslationsOptions
  ): ShareBuildResult;
  dispose(): void;
  /** Translation only: what the service translates, a diagram drawer, and the strings every translated language is scanned for. */
  translationSource?(
    options: { includeDetail: boolean; includeImages: boolean },
    sourceLanguage: ContentLanguage
  ): ShareTranslateSource;
  renderDiagram?(source: string, signal: AbortSignal): Promise<Element | null>;
  forbiddenStrings?(): ForbiddenString[];
}

/** What the dialog needs from the plugin to offer translated versions (a test double stands in for the AI side). */
export interface ShareTranslationHost {
  service: Pick<ShareTranslateService, "estimate" | "translate">;
  /** Session cache; the plugin owns it, so closing the dialog keeps what was translated. */
  cache: ShareTranslationCache;
  dom: ShareTranslateDom;
  models(): string[];
  modelLabel(model: string): string;
  defaultModel(): string;
  reasoning(): ReasoningLevel;
  /** Checks the AI is ready and the usage notice was seen, then runs `run`; false when it did not run. */
  confirmAiUsage?(model: string, run: () => Promise<void>): Promise<boolean>;
}

const errorMessage = (error: unknown): string => {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : "";
};

/**
 * The language the shared text is written in. The "same as the input" row is not a language of its own (it means the map
 * has Latin text nothing recognises), so it reads as the registry fallback, English, like the rest of VAM's fixed text.
 */
function originalLanguage(map: ShareSource["map"], uiLanguage: ShareLanguage): ContentLanguage {
  const language = mapContentLanguage(map, uiLanguage);
  return isFollowInputLanguage(language) ? mapTextLanguage(language) : language;
}

type TranslatePhase = "idle" | "translating" | "done";
const UNVERIFIED_LANGUAGES: readonly string[] = ["ja", "ko", "es"];
const AUTO_LANGUAGE = "auto";

export interface ShareModalOptions {
  source: ShareSource;
  vamVersion: string;
  language: ShareLanguage;
  /** Tests inject small thresholds to trigger the size warnings. */
  sizeThresholds?: { warn: number; large: number };
  mermaidTimeoutMs?: number;
  saveEnvironment?: SaveEnvironment;
  createExporter?: (app: App, source: ShareSource) => ShareExporterLike;
  /** Absent: the dialog offers no translated versions. */
  translation?: ShareTranslationHost;
}

/**
 * Preview and save dialog for sharing a map. It owns one BuildController: opening it and flipping a switch each start a
 * new build; closing it cancels, removes the hidden render container and writes nothing.
 */
export class ShareModal extends Modal {
  private readonly controller = new BuildController();
  private readonly exporter: ShareExporterLike;
  private includeDetail = SHARE_DEFAULT_INCLUDE_DETAIL;
  private includeImages = true;
  private fullToggle!: ToggleComponent;
  private readonly sourceLanguage: ContentLanguage;
  private picked = new Set<ShareTranslationLanguage>();
  private modelChoice = FOLLOW_DEFAULT_MODEL;
  private defaultChoice = AUTO_LANGUAGE;
  private includeIncomplete = new Set<string>();
  private phase: TranslatePhase = "idle";
  private translation: ShareTranslateResult | null = null;
  private translateAbort: AbortController | null = null;
  private translateProgress = "";
  private translateNote = "";
  private translateSource: ShareTranslateSource | null = null;
  private estimateMemo: { key: string; value: ShareTranslateEstimate | null } | null = null;
  private readonly languageToggles = new Map<ShareTranslationLanguage, { setting: Setting; toggle: ToggleComponent }>();
  private modelSetting: Setting | null = null;
  private modelDropdown: DropdownComponent | null = null;
  private translateInfoEl: HTMLElement | null = null;
  private result: ShareBuildResult | null = null;
  private busy = false;
  private saving = false;
  private closed = false;
  private failed = false;
  private detailsEl!: HTMLElement;
  private warningsEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private fullSetting!: Setting;
  private imagesSetting!: Setting;
  private imagesToggle!: ToggleComponent;
  private saveButton!: HTMLButtonElement;
  private cancelButton!: HTMLButtonElement;
  private progressText = "";
  private savedText = "";

  constructor(
    app: App,
    private readonly options: ShareModalOptions
  ) {
    super(app);
    this.sourceLanguage = options.translation
      ? originalLanguage(options.source.map, options.language)
      : options.language;
    this.exporter =
      options.createExporter?.(app, options.source) ??
      new ShareExporter(app, options.source, {
        vamVersion: options.vamVersion,
        language: options.language,
        mermaidTimeoutMs: options.mermaidTimeoutMs
      });
  }

  onOpen(): void {
    this.titleEl.setText(t("share.title"));
    this.contentEl.createEl("p", { text: t("share.intro"), cls: "vam-modal-intro" });
    this.fullSetting = new Setting(this.contentEl)
      .setName(t("share.option_full_name"))
      .setDesc(t("share.option_full_desc"))
      .addToggle(toggle => {
        this.fullToggle = toggle;
        toggle.setValue(this.includeDetail).onChange(value => {
          this.includeDetail = value;
          this.restart();
        });
      });
    this.imagesSetting = new Setting(this.contentEl)
      .setName(t("share.option_images_name"))
      .setDesc(t("share.option_images_desc"))
      .addToggle(toggle => {
        this.imagesToggle = toggle;
        toggle.setValue(this.includeImages).onChange(value => {
          this.includeImages = value;
          this.restart();
        });
      });
    if (this.options.translation && this.exporter.translationSource) this.openTranslationSection();
    this.detailsEl = this.contentEl.createDiv({ cls: "vam-share-preview", attr: { "aria-live": "polite" } });
    this.warningsEl = this.contentEl.createDiv({ cls: "vam-share-warnings" });
    const actions = modalActions(this);
    this.statusEl = actionStatus(actions);
    this.cancelButton = actions.createEl("button", { text: t("ui.cancel") });
    this.cancelButton.addEventListener("click", () => {
      // While AI translates, Cancel stops the translation and keeps the dialog open; the parts done stay cached.
      if (this.phase === "translating") this.translateAbort?.abort();
      else this.close();
    });
    this.saveButton = actions.createEl("button", { text: t("share.save"), cls: "mod-cta" });
    this.saveButton.addEventListener("click", () => void this.primary());
    this.render();
    this.restart();
  }

  onClose(): void {
    this.closed = true;
    // Stops the translation at once; what it finished stays in the plugin's session cache.
    this.translateAbort?.abort();
    this.controller.cancel();
    this.exporter.dispose();
    this.result = null;
    this.contentEl.empty();
  }

  private restart(): void {
    if (this.saving || this.closed || this.phase === "translating") return;
    this.savedText = "";
    // The notes or images in the file changed: translated text no longer fits it (the session cache still does).
    this.phase = "idle";
    this.translation = null;
    this.translateSource = null;
    this.translateNote = "";
    this.estimateMemo = null;
    void this.build(this.controller.begin());
  }

  // ---- translated versions (D-2026-10-116) ----

  private get translating(): boolean {
    return this.phase === "translating";
  }
  /** The languages to add, in menu order. The original language is never among them. */
  private selected(): ShareTranslationLanguage[] {
    return SHARE_TRANSLATION_LANGUAGES.filter(
      language => this.picked.has(language) && language !== this.sourceLanguage
    );
  }
  private get wantsTranslation(): boolean {
    return !!this.options.translation && this.selected().length > 0;
  }
  private resolvedModel(): string {
    const host = this.options.translation;
    return !host || this.modelChoice === FOLLOW_DEFAULT_MODEL ? (host?.defaultModel() ?? "") : this.modelChoice;
  }
  private languageLabel(language: string): string {
    return supportedLanguageLabel(language);
  }

  private openTranslationSection(): void {
    const host = this.options.translation;
    if (!host) return;
    new Setting(this.contentEl).setName(t("share.translate_section")).setHeading();
    this.contentEl.createEl("p", { text: t("share.translate_intro"), cls: "vam-modal-intro" });
    for (const language of SHARE_TRANSLATION_LANGUAGES) {
      const original = language === this.sourceLanguage;
      const setting = new Setting(this.contentEl).setName(
        original ? t("share.translate_original_0", this.languageLabel(language)) : this.languageLabel(language)
      );
      if (!original && UNVERIFIED_LANGUAGES.includes(language))
        setting.setDesc(t("share.translate_unverified_0", this.languageLabel(language)));
      setting.addToggle(toggle => {
        toggle.setValue(original);
        if (!original)
          toggle.onChange(value => {
            if (value) this.picked.add(language);
            else this.picked.delete(language);
            this.selectionChanged();
          });
        this.languageToggles.set(language, { setting, toggle });
      });
    }
    this.modelSetting = new Setting(this.contentEl)
      .setName(t("share.translate_model_name"))
      .setDesc(t("share.translate_model_desc"))
      .addDropdown(dropdown => {
        this.modelDropdown = dropdown;
        dropdown.addOption(FOLLOW_DEFAULT_MODEL, t("ui.follow_default_model", host.modelLabel(host.defaultModel())));
        for (const id of host.models()) dropdown.addOption(id, host.modelLabel(id));
        dropdown.setValue(this.modelChoice);
        dropdown.onChange(value => {
          this.modelChoice = value;
          this.selectionChanged();
        });
      });
    this.translateInfoEl = this.contentEl.createDiv({ cls: "vam-share-translate", attr: { "aria-live": "polite" } });
  }

  /** Languages or model changed: a finished translation no longer matches, so the file goes back to the original until it is translated again. */
  private selectionChanged(): void {
    if (this.closed || this.translating) return;
    this.translateNote = "";
    this.estimateMemo = null;
    if (this.phase === "done") {
      this.phase = "idle";
      this.translation = null;
      this.refreshOriginal();
    }
    this.render();
  }
  private refreshOriginal(): void {
    try {
      this.result = this.exporter.assemble({ includeDetail: this.includeDetail, includeImages: this.includeImages });
    } catch {
      this.result = null;
      this.failed = true;
    }
  }

  private sourceForTranslation(): ShareTranslateSource | null {
    if (!this.exporter.translationSource) return null;
    this.translateSource ??= this.exporter.translationSource(
      { includeDetail: this.includeDetail, includeImages: this.includeImages },
      this.sourceLanguage
    );
    return this.translateSource;
  }

  private estimate(): ShareTranslateEstimate | null {
    const host = this.options.translation;
    const languages = this.selected();
    if (!host || !languages.length || !this.result) return null;
    const key = `${languages.join(",")}|${this.resolvedModel()}|${this.includeDetail}|${this.includeImages}|${host.cache.size}`;
    if (this.estimateMemo?.key === key) return this.estimateMemo.value;
    let value: ShareTranslateEstimate | null = null;
    try {
      const source = this.sourceForTranslation();
      if (source)
        value = host.service.estimate(source, languages, {
          dom: host.dom,
          cache: host.cache,
          model: this.resolvedModel(),
          // Never called while estimating; its presence makes the estimate count the diagram label calls.
          renderMermaid: () => Promise.resolve(null)
        });
    } catch {
      value = null;
    }
    this.estimateMemo = { key, value };
    return value;
  }

  private async primary(): Promise<void> {
    if (this.wantsTranslation && this.phase !== "done") await this.startTranslation();
    else await this.save();
  }

  private async startTranslation(): Promise<void> {
    const host = this.options.translation;
    if (!host || this.translating || this.busy || this.saving || !this.result?.html) return;
    const languages = this.selected();
    if (!languages.length) return;
    const model = this.resolvedModel();
    this.translateNote = "";
    const run = (): Promise<void> => this.runTranslation(host, languages, model);
    if (host.confirmAiUsage) await host.confirmAiUsage(model, run);
    else await run();
  }

  private async runTranslation(
    host: ShareTranslationHost,
    languages: ShareTranslationLanguage[],
    model: string
  ): Promise<void> {
    const source = this.sourceForTranslation();
    if (!source || this.closed) return;
    const abort = new AbortController();
    this.translateAbort = abort;
    this.phase = "translating";
    this.translateProgress = "";
    this.render();
    try {
      const outcome = await host.service.translate(source, languages, {
        dom: host.dom,
        signal: abort.signal,
        cache: host.cache,
        model,
        reasoning: host.reasoning(),
        forbidden: this.exporter.forbiddenStrings?.() ?? [],
        renderMermaid: diagram => this.exporter.renderDiagram?.(diagram, abort.signal) ?? Promise.resolve(null),
        onProgress: progress => {
          if (this.closed || abort.signal.aborted) return;
          const total = Math.max(progress.batchTotal, 1);
          this.translateProgress = t(
            "share.translate_progress_0_1_2_3_4",
            this.languageLabel(progress.language),
            progress.languageIndex,
            progress.languageCount,
            Math.min(progress.batchDone + (progress.phase === "assemble" ? 0 : 1), total),
            total
          );
          this.render();
        }
      });
      if (this.closed) return;
      this.translation = outcome;
      this.includeIncomplete = new Set();
      this.phase = "done";
      this.estimateMemo = null;
      this.applyTranslation();
      new Notice(t("share.translate_done"));
      this.render();
      this.saveButton.focus();
    } catch (error) {
      if (this.closed) return;
      this.phase = "idle";
      this.estimateMemo = null;
      const stopped = abort.signal.aborted || (error as { code?: unknown } | null)?.code === "stopped";
      this.translateNote = stopped
        ? t("share.translate_stopped")
        : t("share.translate_failed_0", errorMessage(error).slice(0, 200));
      this.render();
    } finally {
      if (this.translateAbort === abort) this.translateAbort = null;
    }
  }

  private isIncluded(result: ShareLanguageResult): boolean {
    if (!result.top || !result.nodes) return false;
    return (
      result.status === "complete" || (result.status === "incomplete" && this.includeIncomplete.has(result.language))
    );
  }

  /** The translated languages that go into the file, or undefined when there are none. */
  private translationArg(): AttachTranslationsOptions | undefined {
    const pieces = (this.translation?.languages ?? [])
      .filter(item => this.isIncluded(item))
      .map(item => ({ language: item.language, piece: { top: item.top!, nodes: item.nodes! } }));
    if (!pieces.length) return undefined;
    const carried = [String(this.sourceLanguage), ...pieces.map(item => item.language)];
    return {
      contentLanguage: String(this.sourceLanguage),
      pieces,
      ...(this.defaultChoice !== AUTO_LANGUAGE && carried.includes(this.defaultChoice)
        ? { defaultLanguage: this.defaultChoice }
        : {})
    };
  }

  /** Builds the file with the chosen translated languages and scans all of it again (fail closed). */
  private applyTranslation(): void {
    try {
      this.result = this.exporter.assemble(
        { includeDetail: this.includeDetail, includeImages: this.includeImages },
        this.translationArg()
      );
      this.failed = false;
    } catch {
      this.result = null;
      this.failed = true;
    }
  }

  private statusText(item: ShareLanguageResult): string {
    switch (item.status) {
      case "complete":
        return t("share.translate_status_complete");
      case "incomplete":
        return t("share.translate_status_incomplete_0_1", item.failedSegments, item.totalSegments);
      case "failed":
        return t("share.translate_status_failed");
      default:
        return t(
          "share.translate_status_blocked_0",
          item.leakCategories.map(category => t(`share.leak_category_${category}`)).join(t("ui.list_separator"))
        );
    }
  }

  private renderTranslation(): void {
    const container = this.translateInfoEl;
    const host = this.options.translation;
    if (!container || !host) return;
    // Rebuilding the list must not drop keyboard focus from the control the user just used.
    const focusIndex = this.focusedIndex(container);
    container.empty();
    const note = (text: string, cls = ""): void =>
      void container.createDiv({ text, cls: `vam-share-note ${cls}`.trim() });
    if (this.translating) {
      container.createDiv({ text: this.translateProgress || t("share.progress_start"), cls: "vam-share-progress" });
    } else if (this.phase === "done" && this.translation) {
      container.createDiv({ text: t("share.translate_results"), cls: "vam-share-translate-heading" });
      for (const item of this.translation.languages) this.renderLanguageResult(container, item, host, note);
      const pieces = this.translationArg()?.pieces ?? [];
      if (pieces.length) {
        new Setting(container)
          .setName(t("share.translate_default_language"))
          .setDesc(t("share.translate_default_desc"))
          .addDropdown(dropdown => {
            dropdown.addOption(AUTO_LANGUAGE, t("share.translate_default_auto"));
            for (const id of [String(this.sourceLanguage), ...pieces.map(piece => piece.language)])
              dropdown.addOption(id, this.languageLabel(id));
            const valid = this.translationArg()?.defaultLanguage;
            dropdown.setValue(valid ?? AUTO_LANGUAGE);
            dropdown.onChange(value => {
              this.defaultChoice = value;
              this.applyTranslation();
              this.render();
            });
          });
        note(
          t(
            "share.translate_languages_included_0",
            [String(this.sourceLanguage), ...pieces.map(piece => piece.language)]
              .map(id => this.languageLabel(id))
              .join(t("ui.list_separator"))
          )
        );
        if (this.result?.html) note(t("share.translate_total_size_0", formatBytes(this.result.bytes)));
      }
      note(t("share.translate_images_note"));
    } else if (this.wantsTranslation) {
      const estimate = this.estimate();
      if (estimate)
        note(
          estimate.calls === 0
            ? t("share.translate_estimate_cached")
            : t(
                "share.translate_estimate_0_1_2",
                estimate.calls,
                estimate.minutes,
                host.modelLabel(this.resolvedModel())
              )
        );
      note(t("share.translate_images_note"));
      if (this.translateNote) note(this.translateNote, "vam-share-warning");
    } else if (this.translateNote) {
      note(this.translateNote, "vam-share-warning");
    }
    this.restoreFocus(container, focusIndex);
  }

  private renderLanguageResult(
    container: HTMLElement,
    item: ShareLanguageResult,
    host: ShareTranslationHost,
    note: (text: string, cls?: string) => void
  ): void {
    const label = this.languageLabel(item.language);
    const row = container.createDiv({ cls: "vam-share-translate-row" });
    row.createDiv({ text: `${label}: ${this.statusText(item)}`, cls: "vam-share-note" });
    row.createDiv({ text: t("share.translate_result_model_0", host.modelLabel(item.model)), cls: "vam-share-note" });
    if (item.diagramsKept > 0)
      row.createDiv({ text: t("share.translate_diagrams_kept_0", item.diagramsKept), cls: "vam-share-note" });
    if (item.status === "complete" || item.status === "incomplete")
      if (UNVERIFIED_LANGUAGES.includes(item.language))
        row.createDiv({ text: t("share.translate_unverified_0", label), cls: "vam-share-note" });
    if (item.status === "incomplete")
      new Setting(row).setName(`${label}: ${t("share.translate_include_incomplete")}`).addToggle(toggle =>
        toggle.setValue(this.includeIncomplete.has(item.language)).onChange(value => {
          if (value) this.includeIncomplete.add(item.language);
          else this.includeIncomplete.delete(item.language);
          this.applyTranslation();
          this.render();
        })
      );
    void note;
  }

  private focusedIndex(container: HTMLElement): number {
    if (typeof activeDocument === "undefined") return -1;
    const active = activeDocument.activeElement;
    if (!active || !container.contains?.(active)) return -1;
    return Array.from(container.querySelectorAll("input, select, button")).indexOf(active);
  }
  private restoreFocus(container: HTMLElement, index: number): void {
    if (index < 0) return;
    const target = Array.from(container.querySelectorAll<HTMLElement>("input, select, button"))[index];
    target?.focus();
  }

  private lockToggle(setting: Setting | null, toggle: ToggleComponent | undefined, disabled: boolean): void {
    if (!setting || !toggle) return;
    setting.setDisabled(disabled);
    // The class alone leaves the checkbox focusable and switchable by keyboard; disable the real input too.
    toggle.setDisabled(disabled);
    const input = toggle.toggleEl.querySelector("input");
    if (input) input.disabled = disabled;
    // Obsidian's switch label is tabindex=0 on its own: take it out of the Tab order while disabled.
    toggle.toggleEl.setAttribute("tabindex", disabled ? "-1" : "0");
  }

  private async build(ticket: BuildTicket): Promise<void> {
    this.busy = true;
    this.failed = false;
    this.result = null;
    this.progressText = t("share.progress_start");
    this.render();
    const progress = (value: ShareProgress): void => {
      if (!ticket.isCurrent()) return;
      this.progressText =
        value.phase === "render"
          ? t("share.progress_render_0_1", value.done, value.total)
          : t("share.progress_images_0_1", value.done, value.total);
      this.render();
    };
    try {
      if (this.includeDetail) {
        await this.exporter.ensureRendered(ticket, progress);
        if (this.includeImages) await this.exporter.ensureImages(ticket, progress);
      }
      if (ticket.isCurrent()) {
        this.progressText = t("share.progress_check");
        this.render();
      }
      // Let the dialog paint the last progress line before the synchronous assembly and scans.
      await pause(ticket, 0);
      const result = this.exporter.assemble({ includeDetail: this.includeDetail, includeImages: this.includeImages });
      if (!ticket.isCurrent()) return;
      this.result = result;
      this.busy = false;
    } catch (error) {
      if (isStaleBuild(error) || !ticket.isCurrent()) return;
      this.failed = true;
      this.busy = false;
    }
    this.render();
  }

  private render(): void {
    if (this.closed) return;
    const result = this.result;
    this.detailsEl.empty();
    this.warningsEl.empty();
    const topics = this.options.source.map.nodes.length;
    if (this.busy) {
      this.detailsEl.createDiv({ text: this.progressText, cls: "vam-share-progress" });
    } else if (this.failed) {
      this.detailsEl.createDiv({ text: t("share.build_failed"), cls: "vam-share-error" });
    } else if (result) {
      const { counts } = result;
      this.detailsEl.createDiv({
        text: t("share.preview_counts_0_1_2", counts.topics, counts.notesWithContent, counts.images)
      });
      if (result.html)
        this.detailsEl.createDiv({ text: t("share.preview_size_0", formatBytes(result.bytes)), cls: "vam-share-size" });
    } else {
      this.detailsEl.createDiv({ text: t("share.preview_topics_0", topics) });
    }
    if (!this.busy && result) this.renderWarnings(result);
    const locked = this.saving || this.translating;
    this.lockToggle(this.fullSetting, this.fullToggle, locked);
    this.lockToggle(this.imagesSetting, this.imagesToggle, locked || !this.includeDetail);
    for (const [language, { setting, toggle }] of this.languageToggles)
      this.lockToggle(setting, toggle, locked || language === this.sourceLanguage);
    this.modelSetting?.setDisabled(locked);
    if (this.modelDropdown) this.modelDropdown.selectEl.disabled = locked;
    this.renderTranslation();
    this.statusEl.setText(this.savedText);
    this.saveButton.disabled = this.busy || this.saving || this.translating || this.failed || !result?.html;
    this.saveButton.setText(
      this.saving
        ? t("share.saving")
        : this.wantsTranslation
          ? t(this.phase === "done" ? "share.translate_save_file" : "share.translate_button")
          : t("share.save")
    );
    this.cancelButton.setText(
      this.translating ? t("share.translate_cancel") : this.savedText ? t("ui.close") : t("ui.cancel")
    );
  }

  private renderWarnings(result: ShareBuildResult): void {
    const add = (text: string, cls = ""): void =>
      void this.warningsEl.createDiv({ text, cls: `vam-share-note ${cls}`.trim() });
    if (result.leakCategories.length) {
      add(
        t(
          "share.leak_blocked_0",
          result.leakCategories.map(category => t(`share.leak_category_${category}`)).join(", ")
        ),
        "vam-share-error"
      );
      return;
    }
    const thresholds = this.options.sizeThresholds ?? {
      warn: SHARE_SIZE_WARN_BYTES,
      large: SHARE_SIZE_SUGGEST_NO_IMAGES_BYTES
    };
    const advice = sizeAdvice(result.bytes, this.includeImages && this.includeDetail, thresholds);
    if (advice.level !== "ok") add(t("share.size_warn_0", formatBytes(thresholds.warn)), "vam-share-warning");
    if (advice.suggestNoImages) add(t("share.size_large_0", formatBytes(thresholds.large)), "vam-share-warning");
    if (result.failedImages) add(t("share.images_failed_0", result.failedImages), "vam-share-warning");
    if (result.mermaidBlocked) add(t("share.mermaid_blocked_warning_0", result.mermaidBlocked), "vam-share-warning");
    if (result.mermaidUndrawn) add(t("share.mermaid_undrawn_warning_0", result.mermaidUndrawn), "vam-share-warning");
    add(t("share.email_hint"));
  }

  private async save(): Promise<void> {
    const result = this.result;
    if (!result?.html || this.saving || this.busy || result.leakCategories.length) return;
    const html = result.html;
    this.saving = true;
    this.render();
    const name = shareFileName(this.options.source.map.title);
    try {
      const outcome = await saveShareFile(
        html,
        name,
        // The dialog may have been closed while the system file dialog was open: then nothing is written.
        () => !this.closed && this.result === result,
        this.options.saveEnvironment
      );
      if (this.closed) return;
      if (outcome === "cancelled") this.savedText = "";
      else {
        const size = formatBytes(result.bytes);
        this.savedText = t(outcome === "saved" ? "share.saved_0_1" : "share.downloaded_0_1", name, size);
        new Notice(this.savedText);
      }
    } catch {
      if (!this.closed) {
        this.savedText = "";
        new Notice(t("share.save_failed"));
      }
    }
    this.saving = false;
    this.render();
  }
}
