import { App, FileSystemAdapter, Modal, setIcon } from "obsidian";
import { t, type TranslationKey } from "../i18n";
import { dedupeReferenceGroups, type ReferenceDocument, type ReferenceGroup } from "../ai/reference-materials";

export interface ReferenceTopic { id: string; title: string; mapPath: string; nodePaths: string[] }

export class ReferencePicker {
  private groups: ReferenceGroup[] = [];
  private pending: Promise<void> = Promise.resolve();
  private pendingError?: Error;
  private activeRead?: AbortController;
  private cancelReadButton!: HTMLButtonElement;
  private acknowledgeErrorButton!: HTMLButtonElement;
  private report: (message: string) => void;
  private refresh: () => void;
  private webSearch: boolean;
  private imageSearch: boolean;

  constructor(private app: App, parent: HTMLElement, private topics: () => Promise<ReferenceTopic[]>, private readTopic: (topic: ReferenceTopic, signal: AbortSignal, progress: (message: string) => void) => Promise<ReferenceDocument[]>, private currentTopicId: string, currentLabel: string, initialWeb = true, initialImages = true) {
    this.webSearch = initialWeb; this.imageSearch = initialImages;
    const area = parent.createDiv("vam-reference-picker");
    const heading = area.createDiv("vam-reference-heading");
    heading.createEl("h3", { text: t("ui.data_sources") });
    const intro = heading.createDiv("vam-reference-intro");
    intro.createEl("p", { text: currentLabel, cls: "vam-hint" });
    intro.createEl("p", { text: t("ui.reference_task_only_hint"), cls: "vam-hint" });

    const networkSection = area.createDiv("vam-reference-section vam-reference-network-section");
    const network = networkSection.createDiv("vam-reference-network");
    const webLabel = network.createEl("label", { cls: "vam-field vam-next-toggle" });
    const web = webLabel.createEl("input", { type: "checkbox" }); web.checked = initialWeb;
    webLabel.createSpan({ text: t("ui.allow_web_search") });
    const imageLabel = network.createEl("label", { cls: "vam-field vam-next-toggle vam-reference-image-option" });
    const images = imageLabel.createEl("input", { type: "checkbox" }); images.checked = initialImages;
    images.disabled = !web.checked;
    imageLabel.createSpan({ text: t("ui.search_for_image_references") });
    web.addEventListener("change", () => { this.webSearch = web.checked; images.disabled = !web.checked; if (!web.checked) { images.checked = false; this.imageSearch = false; } });
    images.addEventListener("change", () => { this.imageSearch = images.checked; });

    const local = area.createDiv("vam-reference-section vam-reference-local-section");
    local.createEl("strong", { text: t("ui.local_data") });
    const controls = local.createDiv("vam-reference-actions");
    const addMap = this.createSourceButton(controls, "git-fork", "ui.reference_select_mind_map");
    addMap.addEventListener("click", () => { void this.selectTopic(); });
    const addFolder = this.createSourceButton(controls, "folder-open", "ui.reference_select_folder");
    const folder = controls.createEl("input", { type: "file" }); folder.setAttr("webkitdirectory", ""); folder.multiple = true; folder.hidden = true;
    addFolder.addEventListener("click", () => folder.click());
    folder.addEventListener("change", () => { const selected = Array.from(folder.files ?? []).filter(file => file.name.toLowerCase().endsWith(".md")); if (selected.length) this.addFolder(selected); else this.report(t("ui.reference_folder_no_markdown")); folder.value = ""; });
    const addFiles = this.createSourceButton(controls, "file-text", "ui.reference_select_markdown");
    const files = controls.createEl("input", { type: "file" }); files.accept = ".md,text/markdown"; files.multiple = true; files.hidden = true;
    addFiles.addEventListener("click", () => files.click());
    files.addEventListener("change", () => { const selected = Array.from(files.files ?? []).filter(file => file.name.toLowerCase().endsWith(".md")); if (selected.length) this.addFiles(selected); else this.report(t("ui.reference_file_no_markdown")); files.value = ""; });
    const selected = local.createDiv("vam-reference-selected");
    selected.createEl("strong", { text: t("ui.reference_selected_sources") });
    const list = selected.createDiv("vam-reference-groups");
    const feedback = area.createDiv("vam-reference-feedback");
    const status = feedback.createEl("p", { cls: "vam-hint", attr: { "aria-live": "polite" } }); this.report = message => status.setText(message);
    this.cancelReadButton = feedback.createEl("button", { text: t("ui.cancel"), cls: "vam-reference-cancel is-hidden" }); this.cancelReadButton.hidden = true;
    this.cancelReadButton.addEventListener("click", () => this.activeRead?.abort());
    this.acknowledgeErrorButton = feedback.createEl("button", { text: t("ui.reference_error_acknowledge"), cls: "vam-reference-error-acknowledge is-hidden" }); this.acknowledgeErrorButton.hidden = true;
    this.acknowledgeErrorButton.addEventListener("click", () => { this.pendingError = undefined; this.acknowledgeErrorButton.hidden = true; this.acknowledgeErrorButton.addClass("is-hidden"); this.report(""); });
    this.refresh = () => {
      list.empty();
      const groups = dedupeReferenceGroups(this.groups);
      if (!groups.length) list.createEl("p", { text: t("ui.reference_none"), cls: "vam-hint vam-reference-empty" });
      for (const group of groups) {
        const card = list.createDiv("vam-reference-group-row");
        const details = card.createEl("details");
        const summary = details.createEl("summary");
        const disclosure = summary.createSpan({ cls: "vam-reference-disclosure" });
        setIcon(disclosure, "file-text");
        const summaryText = summary.createSpan({ cls: "vam-reference-summary-text" });
        summaryText.createEl("strong", { text: group.name });
        summaryText.createSpan({ text: group.location, cls: "vam-hint vam-reference-location" });
        summary.createSpan({ text: `${group.documents.length} ${t("ui.markdown_files")}`, cls: "vam-reference-count" });
        const remove = card.createEl("button", { text: t("ui.reference_remove"), cls: "vam-reference-remove" });
        remove.addEventListener("click", event => { event.preventDefault(); this.enqueue(async () => { this.groups = this.groups.filter(item => item.id !== group.id); this.refresh(); }); });
        details.addEventListener("toggle", () => {
          if (!details.open || details.dataset.rendered) return;
          const entries = details.createEl("ul", { cls: "vam-reference-file-list" });
          for (const document of group.documents) entries.createEl("li", { text: document.path });
          details.dataset.rendered = "true";
        });
      }
    };
    area.createEl("p", { cls: "vam-hint vam-reference-duration-hint", text: t("ui.reference_time_and_citations_hint") });
    this.refresh();
  }

  private createSourceButton(parent: HTMLElement, icon: string, key: TranslationKey): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "vam-reference-action" });
    const image = button.createSpan({ cls: "vam-reference-action-icon" }); setIcon(image, icon);
    button.createSpan({ text: t(key), cls: "vam-reference-action-label" });
    return button;
  }

  private enqueue(work: (signal: AbortSignal) => Promise<void>): void {
    this.pending = this.pending.then(async () => {
      const controller = new AbortController(); this.activeRead = controller; this.cancelReadButton.hidden = false; this.cancelReadButton.removeClass("is-hidden");
      this.report(t("ui.reference_reading"));
      try { await work(controller.signal); this.report(this.pendingError ? this.pendingError.message : ""); }
      catch (error) {
        this.pendingError = error instanceof Error ? error : new Error(String(error));
        this.report(controller.signal.aborted ? t("ui.reference_read_cancelled") : t("ui.reference_read_failed", this.pendingError.message));
        this.acknowledgeErrorButton.hidden = false; this.acknowledgeErrorButton.removeClass("is-hidden");
      }
      finally { if (this.activeRead === controller) this.activeRead = undefined; this.cancelReadButton.hidden = true; this.cancelReadButton.addClass("is-hidden"); }
    });
  }

  private async selectTopic(): Promise<void> {
    try {
      const topics = (await this.topics()).filter(topic => topic.id !== this.currentTopicId);
      const modal = new Modal(this.app); modal.titleEl.setText(t("ui.reference_select_mind_map"));
      if (!topics.length) modal.contentEl.createEl("p", { text: t("ui.reference_no_other_mind_maps"), cls: "vam-hint" });
      for (const topic of topics) {
        const button = modal.contentEl.createEl("button", { cls: "vam-reference-topic-choice" });
        button.createEl("strong", { text: topic.title }); button.createSpan({ text: topic.mapPath, cls: "vam-hint" });
        button.addEventListener("click", () => {
          modal.close(); this.enqueue(async signal => {
            const documents = await this.readTopic(topic, signal, message => this.report(message));
            if (signal.aborted) throw new DOMException("Aborted", "AbortError");
            this.groups.push({ id: `map:${topic.id}`, name: topic.title, location: topic.mapPath, documents }); this.groups = dedupeReferenceGroups(this.groups); this.refresh();
          });
        });
      }
      modal.open();
    } catch (error) { this.report(error instanceof Error ? error.message : String(error)); }
  }

  private addFiles(files: File[]): void {
    if (!files.length) return;
    this.enqueue(async signal => {
      const documents = await this.readFiles(files, false, signal);
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      this.groups.push({ id: `files:${crypto.randomUUID()}`, name: t("ui.reference_selected_files"), location: t("ui.reference_external_files_location"), documents }); this.groups = dedupeReferenceGroups(this.groups); this.refresh();
    });
  }

  private addFolder(files: File[]): void {
    if (!files.length) return;
    const folderName = files[0].webkitRelativePath.split("/")[0] || t("ui.reference_selected_folder");
    const nativePath = (files[0] as File & { path?: string }).path?.replace(/\\/g, "/");
    const relative = files[0].webkitRelativePath.replace(/\\/g, "/");
    const folderLocation = nativePath && relative && nativePath.endsWith(relative) ? nativePath.slice(0, -relative.length).replace(/\/$/, "") : folderName;
    this.enqueue(async signal => {
      const documents = await this.readFiles(files, true, signal);
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      this.groups.push({ id: `folder:${crypto.randomUUID()}`, name: folderName, location: folderLocation, documents }); this.groups = dedupeReferenceGroups(this.groups); this.refresh();
    });
  }

  private async readFiles(files: File[], fromFolder: boolean, signal: AbortSignal): Promise<ReferenceDocument[]> {
    const documents: ReferenceDocument[] = [];
    for (let index = 0; index < files.length; index += 20) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      this.report(t("ui.reference_read_progress", Math.min(index + 20, files.length), files.length));
      documents.push(...await Promise.all(files.slice(index, index + 20).map(file => this.readSelectedFile(file, fromFolder))));
    }
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return documents;
  }

  private async readSelectedFile(file: File, fromFolder: boolean): Promise<ReferenceDocument> {
    const nativePath = (file as File & { path?: string }).path?.replace(/\\/g, "/");
    const adapter = this.app.vault.adapter;
    const vaultRoot = adapter instanceof FileSystemAdapter ? adapter.getBasePath().replace(/\\/g, "/").replace(/\/$/, "") : "";
    const isInVault = !!nativePath && !!vaultRoot && nativePath.startsWith(`${vaultRoot}/`);
    const path = isInVault ? nativePath.slice(vaultRoot.length + 1) : nativePath || (fromFolder ? file.webkitRelativePath : file.name) || file.name;
    return { path, content: await file.text(), external: !isInVault, key: nativePath || (fromFolder ? file.webkitRelativePath : `${crypto.randomUUID()}/${file.name}`) };
  }

  async ready(): Promise<{ groups: ReferenceGroup[]; webSearch: boolean; imageSearch: boolean }> {
    await this.pending;
    if (this.pendingError) throw new Error(t("ui.reference_source_error_must_be_acknowledged"));
    return { groups: dedupeReferenceGroups(this.groups), webSearch: this.webSearch, imageSearch: this.webSearch && this.imageSearch };
  }
}
