import { App, Modal } from "obsidian";
import { t } from "../../i18n";
import type { ClaimRole, ClaimType } from "../../core/argument-map/model";
import type { FramingResult } from "../../core/steps/argument-map/v2-framing";
import { modalActions } from "./action-bar";

type ModelChoice = { id: string; label: string };

/** What the window needs from the runner: one framing call. It writes nothing and throws on failure. */
export interface ArgumentFramer {
  frame(original: string, options: { note?: string; attempt: 1 | 2 | 3; signal: AbortSignal }): Promise<FramingResult>;
}

/** What the confirmed window hands back: the proposition, the model, and the framing with the user's edits already applied. */
export interface ArgumentConfirmInput {
  claim: string;
  model: string;
  result: FramingResult;
  chosen: string;
  /** How many framing calls were made (failures count). */
  attempts: number;
}

export interface ArgumentStartConfig {
  draft: string;
  models: ModelChoice[];
  defaultModel: string;
  /** The worst-case AI call count shown before the first call (`WORST_CASE_AI_CALLS`). */
  calls: number;
  /** The framing call limit (`MAX_FRAMING_CALLS`). */
  maxFraming: number;
  framer: ArgumentFramer;
  /** Runs before the first framing call (switch to the chosen model). Returning false means the window is stale: nothing is called. */
  beforeFrame?: (model: string) => boolean | Promise<boolean>;
  onConfirm: (input: ArgumentConfirmInput) => void | Promise<void>;
}

type Stage = "input" | "framing" | "confirm" | "failed" | "done";

const TYPE_KEY: Record<ClaimType, "type_fact" | "type_causal" | "type_main_cause" | "type_comparison"> = {
  fact: "type_fact",
  causal: "type_causal",
  main_cause: "type_main_cause",
  comparison: "type_comparison"
};
const ROLE_KEY: Record<ClaimRole, "role_premise" | "role_testable"> = {
  premise: "role_premise",
  testable: "role_testable"
};

/**
 * The start window of hypothesis research, three steps: the proposition and the usage (nothing is called yet), the restatement and
 * breakdown to confirm (one framing call, aborted by Esc or closing, a late result dropped), and the confirmation. Only the chosen
 * question, the settings and the definitions are editable; the claim breakdown is shown read-only and no control changes it. Every
 * model reply is shown as text (textContent), never as HTML. Cancel, Esc and closing hand nothing back and create nothing.
 */
export class ArgumentStartModal extends Modal {
  private stage: Stage = "input";
  private closed = false;
  private token = 0;
  private abort: AbortController | null = null;
  private attempts = 0;
  private claim = "";
  private model: string;
  private note = "";
  private previous: FramingResult | null = null;
  private chosen = "";
  private settings: string[] = [];
  private meanings: string[][] = [];
  private actions: HTMLElement | null = null;

  constructor(
    app: App,
    private config: ArgumentStartConfig
  ) {
    super(app);
    this.model = config.defaultModel;
    this.claim = config.draft.trim();
  }

  onOpen(): void {
    this.closed = false;
    this.renderInput();
  }

  onClose(): void {
    this.closed = true;
    this.token++;
    this.abort?.abort();
    this.abort = null;
  }

  private remaining(): number {
    return Math.max(0, this.config.maxFraming - this.attempts);
  }

  private begin(stage: Stage): HTMLElement {
    this.stage = stage;
    this.contentEl.empty();
    this.actions?.remove();
    this.titleEl.setText(stage === "input" ? t("ui.argument_start_title") : t("ui.argument_start_confirm_title"));
    return this.contentEl;
  }

  private addCancel(actions: HTMLElement): HTMLButtonElement {
    const cancel = actions.createEl("button", { text: t("ui.cancel") });
    cancel.addEventListener("click", () => this.close());
    return cancel;
  }

  private renderInput(): void {
    const body = this.begin("input");
    body.createEl("p", { cls: "vam-hint", text: t("ui.argument_start_framing_stage", "1") });
    const claimLabel = body.createEl("label", { cls: "vam-field" });
    claimLabel.createSpan({ text: t("ui.argument_proposition") });
    const claim = claimLabel.createEl("textarea", { cls: "vam-argument-claim", attr: { rows: "2" } });
    claim.value = this.claim;
    claim.setAttr("aria-label", t("ui.argument_proposition"));
    const modelLabel = body.createEl("label", { cls: "vam-field" });
    modelLabel.createSpan({ text: t("ui.model") });
    const model = modelLabel.createEl("select");
    model.setAttr("aria-label", t("ui.model"));
    const choices = this.config.models.some(choice => choice.id === this.config.defaultModel)
      ? this.config.models
      : [...this.config.models, { id: this.config.defaultModel, label: this.config.defaultModel }];
    for (const choice of choices) model.createEl("option", { value: choice.id, text: choice.label });
    model.value = this.model;
    body.createEl("p", {
      cls: "vam-hint vam-argument-usage",
      text: t("ui.argument_start_usage_0", String(this.config.calls))
    });
    body.createEl("p", { cls: "vam-hint", text: t("ui.argument_start_usage_framing") });
    const actions = (this.actions = modalActions(this));
    this.addCancel(actions);
    const next = actions.createEl("button", { text: t("ui.argument_start_next"), cls: "mod-cta" });
    const blank = (): boolean => !claim.value.trim();
    const check = (): void => {
      next.disabled = blank();
    };
    claim.addEventListener("input", check);
    next.addEventListener("click", () => {
      if (blank() || this.stage !== "input") return;
      this.claim = claim.value.trim();
      this.model = model.value;
      void this.runFrame();
    });
    check();
    claim.focus();
    const end = claim.value.length;
    claim.setSelectionRange(end, end);
  }

  private async runFrame(): Promise<void> {
    if (this.remaining() <= 0) {
      this.renderFailed();
      return;
    }
    const mine = ++this.token;
    this.renderFraming();
    if (this.attempts === 0 && this.config.beforeFrame) {
      let ok = false;
      try {
        ok = await this.config.beforeFrame(this.model);
      } catch {
        ok = false;
      }
      if (this.closed || mine !== this.token) return;
      if (!ok) {
        this.close();
        return;
      }
    }
    const attempt = (this.attempts + 1) as 1 | 2 | 3;
    this.attempts++;
    const controller = new AbortController();
    this.abort = controller;
    let result: FramingResult | null = null;
    try {
      result = await this.config.framer.frame(this.claim, { note: this.note, attempt, signal: controller.signal });
    } catch {
      result = null;
    }
    // A late result (the window was closed, or a newer call replaced this one) is dropped.
    if (this.closed || mine !== this.token || controller.signal.aborted) return;
    this.abort = null;
    if (!result) {
      this.renderFailed();
      return;
    }
    this.previous = null;
    this.chosen = result.chosen;
    this.settings = [...result.settings];
    this.meanings = result.claims.map(claim => claim.definitions.map(definition => definition.meaning));
    this.renderConfirm(result);
  }

  private renderFraming(): void {
    const body = this.begin("framing");
    body.createEl("p", { cls: "vam-hint", text: t("ui.argument_start_framing_stage", "2") });
    body.createEl("p", {
      cls: "vam-argument-busy",
      text: t("ui.argument_start_framing_busy"),
      attr: { role: "status", "aria-live": "polite" }
    });
    const actions = (this.actions = modalActions(this));
    this.addCancel(actions).focus();
  }

  private renderFailed(): void {
    const body = this.begin("failed");
    const left = this.remaining();
    body.createEl("p", {
      cls: "vam-argument-error",
      text: t("ui.argument_start_framing_failed"),
      attr: { role: "alert" }
    });
    if (left <= 0) body.createEl("p", { cls: "vam-hint", text: t("ui.argument_start_framing_exhausted") });
    const actions = (this.actions = modalActions(this));
    const cancel = this.addCancel(actions);
    if (this.previous) {
      const back = actions.createEl("button", { text: t("ui.argument_start_framing_back") });
      back.addEventListener("click", () => {
        const prior = this.previous;
        this.previous = null;
        if (prior) this.renderConfirm(prior);
      });
    }
    if (left > 0) {
      const retry = actions.createEl("button", {
        text: t("ui.argument_start_framing_retry_0", String(left)),
        cls: "mod-cta"
      });
      retry.addEventListener("click", () => void this.runFrame());
      retry.focus();
    } else cancel.focus();
  }

  private renderConfirm(result: FramingResult): void {
    const body = this.begin("confirm");
    body.createEl("p", { cls: "vam-hint", text: t("ui.argument_start_framing_stage", "3") });
    const section = (title: string): HTMLElement => {
      const block = body.createDiv({ cls: "vam-argument-block" });
      block.createEl("h4", { cls: "vam-argument-label", text: title });
      return block;
    };
    section(t("ui.argument_start_confirm_original")).createEl("blockquote", {
      cls: "vam-argument-quote",
      text: this.claim
    });
    if (result.restatement.trim())
      section(t("ui.argument_start_confirm_restatement")).createEl("p", { text: result.restatement });

    const tags = section(t("ui.argument_start_confirm_hidden")).createDiv({ cls: "vam-argument-tags" });
    const tag = (label: string, text: string): void => {
      const chip = tags.createSpan({ cls: "vam-argument-tag" });
      chip.createEl("b", { text: label });
      chip.createSpan({ text: `：${text}` });
    };
    for (const item of result.presuppositions) tag(t("ui.argument_start_tag_presupposition"), item);
    for (const item of result.loadedTerms) tag(t("ui.argument_start_tag_loaded"), item);
    for (const item of result.vagueTerms) tag(t("ui.argument_start_tag_vague"), item);
    for (const item of result.outOfScope) tag(t("ui.argument_start_tag_out_of_scope"), item);
    if (!result.outOfScope.length) tag(t("ui.argument_start_tag_out_of_scope"), t("ui.argument_start_tag_none"));

    if (result.candidates.length) {
      const block = section(t("ui.argument_start_candidates_ask"));
      const group = block.createDiv({
        cls: "vam-argument-options",
        attr: { role: "radiogroup", "aria-label": t("ui.argument_start_candidates_ask") }
      });
      const name = `vam-argument-candidate-${this.attempts}`;
      for (const candidate of result.candidates) {
        const option = group.createEl("label", { cls: "vam-argument-option" });
        const radio = option.createEl("input", { type: "radio", attr: { name } });
        radio.checked = candidate.id === this.chosen;
        radio.setAttr("aria-label", candidate.question);
        const text = option.createDiv({ cls: "vam-argument-option-text" });
        text.createEl("strong", { text: candidate.question });
        const kind =
          candidate.kind === "related"
            ? t("ui.argument_start_candidate_related")
            : t("ui.argument_start_candidate_interpretation");
        const notes = [kind, candidate.answerShape, candidate.diff].filter(Boolean);
        if (candidate.unanswered) notes.push(t("ui.argument_start_candidate_unanswered"));
        if (candidate.id === result.chosen) notes.push(t("ui.argument_start_candidate_recommended"));
        text.createSpan({ cls: "vam-hint", text: notes.join(" · ") });
        radio.addEventListener("change", () => {
          this.chosen = candidate.id;
        });
      }
    }

    const order = new Map(result.claims.map((claim, index) => [claim.id, index + 1]));
    const claims = section(t("ui.argument_start_claims_title")).createEl("ol", { cls: "vam-argument-claims" });
    for (const claim of result.claims) {
      const item = claims.createEl("li");
      const meta = item.createDiv({ cls: "vam-argument-meta" });
      const kind = `${t(`ui.argument_start_${TYPE_KEY[claim.type]}`)}・${t(`ui.argument_start_${ROLE_KEY[claim.role]}`)}`;
      meta.createSpan({ cls: "vam-argument-chip", text: kind });
      for (const dep of claim.dependsOn)
        meta.createSpan({
          cls: "vam-argument-chip",
          text: t("ui.argument_start_depends_0", String(order.get(dep) ?? dep))
        });
      item.createSpan({ text: claim.text });
    }
    body.createEl("p", {
      cls: "vam-hint",
      text: result.composition.trim()
        ? t("ui.argument_start_composition_0", result.composition)
        : t("ui.argument_start_composition_none")
    });

    const fields: HTMLInputElement[] = [];
    let check = (): void => {};
    if (result.settings.length) {
      const block = section(t("ui.argument_start_settings_title"));
      result.settings.forEach((setting, index) => {
        const field = block.createEl("label", { cls: "vam-field" });
        field.createSpan({ text: setting });
        const input = field.createEl("input", { type: "text", cls: "vam-argument-setting" });
        input.value = this.settings[index] ?? setting;
        input.setAttr("aria-label", setting);
        input.addEventListener("input", () => {
          this.settings[index] = input.value;
          check();
        });
        fields.push(input);
      });
    }
    if (result.claims.some(claim => claim.definitions.length)) {
      const block = section(t("ui.argument_start_definitions_title"));
      result.claims.forEach((claim, ci) =>
        claim.definitions.forEach((definition, di) => {
          const field = block.createEl("label", { cls: "vam-field" });
          field.createSpan({ text: definition.term });
          const input = field.createEl("input", { type: "text", cls: "vam-argument-definition" });
          input.value = this.meanings[ci]?.[di] ?? definition.meaning;
          input.setAttr("aria-label", definition.term);
          input.addEventListener("input", () => {
            (this.meanings[ci] ??= [])[di] = input.value;
            check();
          });
          fields.push(input);
        })
      );
    }

    let refreshNote: HTMLTextAreaElement | null = null;
    const left = this.remaining();
    if (left > 0) {
      const noteLabel = body.createEl("label", { cls: "vam-field" });
      noteLabel.createSpan({ text: t("ui.argument_start_refresh_note") });
      refreshNote = noteLabel.createEl("textarea", { cls: "vam-argument-note", attr: { rows: "2" } });
      refreshNote.setAttr("aria-label", t("ui.argument_start_refresh_note"));
    }
    body.createEl("p", { cls: "vam-hint", text: t("ui.argument_start_usage_0", String(this.config.calls)) });
    body.createEl("p", { cls: "vam-hint", text: t("ui.argument_start_lock_note") });
    const status = body.createEl("p", { cls: "vam-hint vam-argument-blank", attr: { "aria-live": "polite" } });

    const actions = (this.actions = modalActions(this));
    this.addCancel(actions);
    if (left > 0) {
      const refresh = actions.createEl("button", { text: t("ui.argument_start_refresh_0", String(left)) });
      refresh.addEventListener("click", () => {
        this.previous = result;
        this.note = refreshNote?.value.trim() ?? "";
        void this.runFrame();
      });
    }
    const confirm = actions.createEl("button", { text: t("ui.argument_start_confirm_start"), cls: "mod-cta" });
    const blank = (): boolean => fields.some(field => !field.value.trim());
    check = (): void => {
      confirm.disabled = blank();
      status.setText(blank() ? t("ui.argument_start_confirm_blank") : "");
    };
    confirm.addEventListener("click", () => {
      if (blank() || this.stage !== "confirm") return;
      const edited: FramingResult = {
        ...result,
        chosen: this.chosen,
        settings: result.settings.map((setting, index) => this.settings[index]?.trim() || setting),
        claims: result.claims.map((claim, ci) => ({
          ...claim,
          dependsOn: [...claim.dependsOn],
          dataNeeds: [...claim.dataNeeds],
          definitions: claim.definitions.map((definition, di) => ({
            ...definition,
            meaning: this.meanings[ci]?.[di]?.trim() || definition.meaning
          }))
        }))
      };
      const input: ArgumentConfirmInput = {
        claim: this.claim,
        model: this.model,
        result: edited,
        chosen: this.chosen,
        attempts: this.attempts
      };
      this.stage = "done";
      this.close();
      void this.config.onConfirm(input);
    });
    check();
    (body.querySelector("input") ?? confirm).focus();
  }
}
