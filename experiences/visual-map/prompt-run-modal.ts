import { App, Modal } from "obsidian";
import { t } from "../../i18n";
import { modalActions } from "../../ui/modals/action-bar";
import type { PromptPlan } from "./prompt-run";

/**
 * The confirmation card of "run all": every Prompt topic in run order with what happens to it, the most AI calls it can cost,
 * and Cancel / Start. Cancel (or closing it) writes nothing. Its look follows the multi-research dialog.
 */
export class PromptRunModal extends Modal {
  private submitted = false;

  constructor(
    app: App,
    private plan: PromptPlan,
    private titleOf: (id: string) => string,
    private confirm: () => void,
    private sourcesOf: (id: string) => string[] = () => []
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("ui.prompt_run_modal_title"));
    const { counts, order } = this.plan;
    this.contentEl.createEl("p", { text: t("ui.prompt_run_modal_intro_0", order.length), cls: "vam-modal-intro" });
    const list = this.contentEl.createEl("ol", { cls: "vam-prompt-run-list" });
    for (const item of order) {
      const row = list.createEl("li", { cls: "vam-prompt-run-item" });
      row.createSpan({ text: this.titleOf(item.id) });
      const mode =
        item.action === "reuse"
          ? t("ui.prompt_run_mode_reuse")
          : item.kind === "integrate"
            ? t("ui.prompt_run_mode_integrate")
            : item.web
              ? t("ui.prompt_run_mode_standard")
              : t("ui.prompt_run_mode_quick");
      row.createSpan({ text: ` · ${mode}`, cls: "vam-prompt-run-mode" });
      // The vault notes its "資料來源" line sends to the provider, so they are visible before Start.
      const sources = item.action === "run" ? this.sourcesOf(item.id) : [];
      if (sources.length)
        row.createSpan({ text: ` · ${t("ui.prompt_run_reads_0", sources.join(", "))}`, cls: "vam-prompt-run-mode" });
    }
    this.contentEl.createDiv({
      cls: "vam-prompt-run-estimate",
      text: t("ui.prompt_run_estimate_0_1_2", counts.run, counts.web, counts.reuse)
    });
    const actions = modalActions(this);
    actions.createEl("button", { text: t("ui.cancel") }).addEventListener("click", () => this.close());
    const start = actions.createEl("button", { text: t("ui.prompt_run_start_0", counts.run), cls: "mod-cta" });
    start.addEventListener("click", () => {
      if (this.submitted) return;
      this.submitted = true;
      this.close();
      this.confirm();
    });
  }
}
