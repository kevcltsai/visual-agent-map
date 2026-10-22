import { Modal, Notice, Setting, type App, type ToggleComponent } from "obsidian";
import { t } from "../../i18n";
import { actionStatus, modalActions } from "../../ui/modals/action-bar";
import {
  BuildController,
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
  type ShareLanguage
} from "./share-format";
import { saveShareFile, type SaveEnvironment } from "./share-save";

/** What the dialog needs from the exporter (a test double stands in for the Obsidian-bound one). */
export interface ShareExporterLike {
  ensureRendered(ticket: BuildTicket, onProgress: (progress: ShareProgress) => void): Promise<void>;
  ensureImages(ticket: BuildTicket, onProgress: (progress: ShareProgress) => void): Promise<void>;
  assemble(options: { includeDetail: boolean; includeImages: boolean }): ShareBuildResult;
  dispose(): void;
}

export interface ShareModalOptions {
  source: ShareSource;
  vamVersion: string;
  language: ShareLanguage;
  /** Tests inject small thresholds to trigger the size warnings. */
  sizeThresholds?: { warn: number; large: number };
  mermaidTimeoutMs?: number;
  saveEnvironment?: SaveEnvironment;
  createExporter?: (app: App, source: ShareSource) => ShareExporterLike;
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
      .addToggle(toggle =>
        toggle.setValue(this.includeDetail).onChange(value => {
          this.includeDetail = value;
          this.restart();
        })
      );
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
    this.detailsEl = this.contentEl.createDiv({ cls: "vam-share-preview", attr: { "aria-live": "polite" } });
    this.warningsEl = this.contentEl.createDiv({ cls: "vam-share-warnings" });
    const actions = modalActions(this);
    this.statusEl = actionStatus(actions);
    this.cancelButton = actions.createEl("button", { text: t("ui.cancel") });
    this.cancelButton.addEventListener("click", () => this.close());
    this.saveButton = actions.createEl("button", { text: t("share.save"), cls: "mod-cta" });
    this.saveButton.addEventListener("click", () => void this.save());
    this.render();
    this.restart();
  }

  onClose(): void {
    this.closed = true;
    this.controller.cancel();
    this.exporter.dispose();
    this.result = null;
    this.contentEl.empty();
  }

  private restart(): void {
    if (this.saving || this.closed) return;
    this.savedText = "";
    void this.build(this.controller.begin());
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
    this.fullSetting.setDisabled(this.saving);
    const imagesOff = this.saving || !this.includeDetail;
    this.imagesSetting.setDisabled(imagesOff);
    // The class alone leaves the checkbox focusable and switchable by keyboard; disable the real input too.
    this.imagesToggle.setDisabled(imagesOff);
    const input = this.imagesToggle.toggleEl.querySelector("input");
    if (input) input.disabled = imagesOff;
    this.statusEl.setText(this.savedText);
    this.saveButton.disabled = this.busy || this.saving || this.failed || !result?.html;
    this.saveButton.setText(this.saving ? t("share.saving") : t("share.save"));
    this.cancelButton.setText(this.savedText ? t("ui.close") : t("ui.cancel"));
  }

  private renderWarnings(result: ShareBuildResult): void {
    const add = (text: string, cls = ""): void =>
      void this.warningsEl.createDiv({ text, cls: `vam-share-note ${cls}`.trim() });
    if (result.leakCategories.length) {
      add(t("share.leak_blocked_0", result.leakCategories.join(", ")), "vam-share-error");
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
