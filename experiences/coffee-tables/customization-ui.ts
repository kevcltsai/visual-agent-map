import { Modal, Notice, type App } from "obsidian";
import { backgroundResultNotice } from "../../ui/background-run";
import { translate, uiLocale, type TranslationKey } from "../../i18n";
import type { CoffeeEngine } from "./engine";
import { baselineFromVersions } from "./insights";
import {
  defaultCustomization,
  normalizeCustomization,
  validateCustomization,
  type CoffeeCustomization
} from "./customization";
import { builtinCoffeeStyle, cleanChatStyle } from "./prompts";

export function customizationFields(
  parent: HTMLElement,
  initial: unknown,
  language: string,
  changed: () => void = () => undefined
): { read: () => CoffeeCustomization; set: (value: unknown) => void } {
  const t = (key: TranslationKey, ...values: unknown[]): string => translate(uiLocale(language), key, ...values);
  const root = parent.createDiv("ct-customization-fields");
  const organize = root.createEl("section");
  organize.createEl("h4", { text: t("coffee.how_to_organize") });
  organize.createEl("p", {
    cls: "ct-muted",
    text: t("coffee.choose_the_viewpoints_reasons_and_open_questions_to")
  });
  const observerLabel = organize.createEl("label", { text: t("coffee.observer_instructions") });
  const observer = observerLabel.createEl("textarea", { attr: { rows: "5", maxlength: "12000" } });
  const converge = root.createEl("section");
  converge.createEl("h4", { text: t("coffee.how_to_converge") });
  converge.createEl("p", {
    cls: "ct-muted",
    text: t("coffee.combine_similar_ideas_while_retaining_important")
  });
  const controls = converge.createDiv("ct-style-fields");
  const select = (label: string, options: Array<[string, string]>): HTMLSelectElement => {
    const field = controls.createEl("label", { text: label });
    const el = field.createEl("select");
    for (const [value, text] of options) el.createEl("option", { value, text });
    return el;
  };
  const merge = select(t("coffee.merge_level"), [
    ["detailed", t("coffee.keep_detail")],
    ["balanced", t("coffee.balanced")],
    ["compact", t("coffee.compact")]
  ]);
  const detail = select(t("coffee.length_target"), [
    ["brief", t("coffee.brief")],
    ["standard", t("ui.standard")],
    ["detailed", t("coffee.detailed")]
  ]);
  converge.createEl("small", {
    cls: "ct-muted",
    text: t("coffee.length_is_a_target_important_differences_may_need_more")
  });
  const preserve = new Map<string, HTMLInputElement>();
  const fieldset = converge.createEl("fieldset");
  fieldset.createEl("legend", { text: t("coffee.keep_these_aspects") });
  for (const [key, label] of [
    ["disagreements", "coffee.preserve_disagreements"],
    ["conditions", "coffee.preserve_conditions"],
    ["counterexamples", "coffee.preserve_counterexamples"],
    ["questions", "coffee.preserve_questions"],
    ["sources", "coffee.preserve_sources"]
  ] as const) {
    const row = fieldset.createEl("label");
    const input = row.createEl("input", { attr: { type: "checkbox" } });
    row.createSpan({ text: t(label) });
    preserve.set(key, input);
  }
  const warning = converge.createEl("p", {
    cls: "ct-muted",
    text: t("coffee.unchecked_aspects_are_no_longer_emphasized_original")
  });
  void warning;
  const advanced = converge.createEl("details");
  advanced.createEl("summary", { text: t("coffee.advanced_custom_convergence_instructions") });
  const convergenceLabel = advanced.createEl("label", { text: t("coffee.additional_requirements") });
  const convergence = convergenceLabel.createEl("textarea", {
    attr: {
      rows: "4",
      maxlength: "12000",
      placeholder: t("coffee.for_example_combine_repetitions_but_retain_minority")
    }
  });
  const errors = root.createEl("p", { cls: "ct-error", attr: { "aria-live": "polite" } });
  const read = (): CoffeeCustomization => ({
    observerPrompt: observer.value,
    convergencePrompt: convergence.value,
    mergeLevel: merge.value as CoffeeCustomization["mergeLevel"],
    detailLevel: detail.value as CoffeeCustomization["detailLevel"],
    preserve: [...preserve].filter(([, input]) => input.checked).map(([key]) => key) as CoffeeCustomization["preserve"]
  });
  const validate = (): void => {
    errors.setText(validateCustomization(read(), language).join("\n"));
  };
  const set = (value: unknown): void => {
    const current = normalizeCustomization(value, language);
    observer.value = current.observerPrompt;
    convergence.value = current.convergencePrompt;
    merge.value = current.mergeLevel;
    detail.value = current.detailLevel;
    for (const [key, input] of preserve)
      input.checked = current.preserve.includes(key as CoffeeCustomization["preserve"][number]);
    validate();
  };
  root.addEventListener("input", () => {
    validate();
    changed();
  });
  root.addEventListener("change", () => {
    validate();
    changed();
  });
  const reset = root.createEl("button", { text: t("coffee.restore_organization_defaults") });
  reset.onclick = () => {
    set(defaultCustomization(language));
    changed();
  };
  const protectedRules = root.createEl("details", { cls: "ct-protected-rules" });
  protectedRules.createEl("summary", { text: t("coffee.system_rules_read_only") });
  protectedRules.createEl("p", {
    text: t("coffee.the_app_manages_insight_ids_output_structure_completion")
  });
  set(initial);
  return { read, set };
}

/** The saved convergence preview (parsed draft or raw response) as identities, to tell whether a run produced a new one. */
export function convergencePreviewMarks(engine: CoffeeEngine): [unknown, unknown] {
  return [engine.session.convergenceDraft, engine.session.convergenceRawDraft];
}

/**
 * Reports a finished one-time convergence preview: one Notice with a review button, only when the run produced a new
 * preview (a stopped or failed run leaves the old one untouched). The review screen never opens by itself.
 */
export function notifyConvergencePreview(engine: CoffeeEngine, before: [unknown, unknown], review: () => void): void {
  const [draft, raw] = convergencePreviewMarks(engine);
  if (!draft && !raw) return;
  if (draft === before[0] && raw === before[1]) return;
  const t = (key: TranslationKey): string => translate(uiLocale(engine.session.language), key);
  backgroundResultNotice(t("coffee.convergence_preview_ready"), { label: t("ui.background_review"), open: review });
}

export class CoffeeCustomizationModal extends Modal {
  private closed = false;
  constructor(
    app: App,
    private engine: CoffeeEngine,
    private saveDefault: (style: string, customization: CoffeeCustomization) => Promise<void>,
    private reviewed: () => void,
    private confirmRun: (work: () => Promise<void>) => Promise<void>
  ) {
    super(app);
  }
  onOpen(): void {
    this.modalEl.addClass("ct-customization-modal");
    const { contentEl: content, engine } = this,
      t = (key: TranslationKey, ...values: unknown[]): string =>
        translate(uiLocale(engine.session.language), key, ...values);
    content.createEl("h2", { text: t("coffee.customize_this_table") });
    content.createEl("p", {
      cls: "ct-muted",
      text: t("coffee.new_settings_affect_later_actions_existing_conversation")
    });
    content.createEl("h4", { text: t("coffee.how_to_chat") });
    content.createEl("p", {
      cls: "ct-muted",
      text: t("coffee.choose_how_people_speak_and_interact_you_can_restore")
    });
    const label = content.createEl("label", { text: t("coffee.conversation_instructions") });
    const style = label.createEl("textarea", { attr: { rows: "6", maxlength: "30000" } });
    const builtin = cleanChatStyle(builtinCoffeeStyle(engine.session.language));
    style.value = cleanChatStyle(
      engine.session.guests?.stylePrompt ?? [builtin, engine.session.guests?.customPrompt].filter(Boolean).join("\n\n")
    );
    const reset = content.createEl("button", { text: t("coffee.restore_chat_default") });
    reset.onclick = () => {
      style.value = builtin;
    };
    const fields = customizationFields(content, engine.session.guests?.customization, engine.session.language);
    const errors = content.createEl("p", { cls: "ct-error", attr: { "aria-live": "polite" } });
    const actions = content.createDiv("ct-customization-actions");
    const run = (label: string, action: (value: CoffeeCustomization) => Promise<void>): void => {
      const button = actions.createEl("button", { text: label });
      button.onclick = () => {
        const value = fields.read(),
          issues = validateCustomization(value, engine.session.language);
        errors.setText(issues.join("\n"));
        if (issues.length) return;
        for (const item of Array.from(actions.querySelectorAll("button"))) item.disabled = true;
        void action(value)
          .catch(error => {
            if (!this.closed) errors.setText(error instanceof Error ? error.message : String(error));
          })
          .finally(() => {
            if (this.closed) return;
            for (const item of Array.from(actions.querySelectorAll("button"))) item.disabled = false;
          });
      };
    };
    run(t("coffee.apply_to_this_table"), async value => {
      await engine.setCustomization(style.value, value);
      new Notice(t("coffee.table_settings_saved"));
      this.close();
    });
    run(t("coffee.default_for_new_tables"), async value => {
      await this.saveDefault(style.value, value);
      new Notice(t("coffee.saved_for_new_tables"));
    });
    run(t("coffee.preview_convergence_once"), async value => {
      const before = convergencePreviewMarks(engine);
      let started = false;
      await this.confirmRun(async () => {
        // The user closed this window while the usage notice was open: nothing starts.
        if (this.closed) return;
        // AI starts now: the window hides and the preview continues in the background (engine busy / Stop stay).
        started = true;
        this.close();
        try {
          await engine.previewConvergence(value);
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error));
          started = false;
        }
      });
      // Completion never reopens a window or the review by itself; a Notice offers the review.
      if (started) notifyConvergencePreview(engine, before, this.reviewed);
    });
    content.createEl("small", {
      cls: "ct-muted",
      text: t("coffee.a_one_time_preview_uses_the_organization_and")
    });
  }
  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
  }
}

export class CoffeeConvergenceModal extends Modal {
  constructor(
    app: App,
    private engine: CoffeeEngine
  ) {
    super(app);
  }
  onOpen(): void {
    this.modalEl.addClass("ct-customization-modal");
    const content = this.contentEl,
      engine = this.engine,
      t = (key: TranslationKey, ...values: unknown[]): string =>
        translate(uiLocale(engine.session.language), key, ...values);
    const draft = engine.session.convergenceDraft;
    content.createEl("h2", { text: t("coffee.review_convergence") });
    content.createEl("p", {
      cls: "ct-muted",
      text: t("coffee.original_notes_are_retained_only_checked_changes_are")
    });
    if (!draft) {
      content.createEl("p", {
        text: t("coffee.no_valid_preview_is_available_copy_the_saved_response")
      });
      const raw = content.createEl("textarea", { attr: { rows: "12", readonly: "true" } });
      raw.value = engine.session.convergenceRawDraft ?? "";
      return;
    }
    const baseline = baselineFromVersions(engine.session.observerNotes ?? [], engine.session.language);
    const selected = new Set<number>(),
      edits: Record<number, { summary: string; detail: string }> = {};
    for (const [index, item] of draft.proposals.entries()) {
      const prior = item.sourceIds.map(id => baseline.find(source => source.id === id)).filter(source => !!source);
      const unchanged =
        prior.length === 1 &&
        prior[0].summary === item.summary &&
        prior[0].detail === item.detail &&
        prior[0].category === item.category;
      const pinned = item.sourceIds.some(id => engine.session.pinnedInsightIds?.includes(id));
      const block = content.createEl("section", { cls: "ct-convergence-proposal" });
      const label = block.createEl("label");
      const checkbox = label.createEl("input", { attr: { type: "checkbox" } });
      checkbox.checked = !unchanged && !pinned;
      checkbox.disabled = pinned || unchanged;
      if (checkbox.checked) selected.add(index);
      label.createSpan({
        text: pinned
          ? t("coffee.pinned_unchanged")
          : unchanged
            ? t("coffee.unchanged")
            : item.sourceIds.length > 1
              ? t("coffee.merge_insights", item.sourceIds.length)
              : t("coffee.revise_insight")
      });
      checkbox.onchange = () => {
        if (checkbox.checked) selected.add(index);
        else selected.delete(index);
      };
      const before = block.createEl("details");
      before.createEl("summary", { text: t("coffee.original_viewpoints") });
      for (const source of prior) {
        before.createEl("p", { text: source.summary });
        if (source.detail) before.createEl("p", { cls: "ct-muted", text: source.detail });
      }
      const summaryLabel = block.createEl("label", { text: t("coffee.suggested_viewpoint") });
      const summary = summaryLabel.createEl("textarea", { attr: { rows: "2", maxlength: "1000" } });
      summary.value = item.summary;
      summary.disabled = pinned || unchanged;
      const detailLabel = block.createEl("label", { text: t("coffee.context_and_differences") });
      const detail = detailLabel.createEl("textarea", { attr: { rows: "4", maxlength: "12000" } });
      detail.value = item.detail;
      detail.disabled = pinned || unchanged;
      const changed = (): void => {
        edits[index] = { summary: summary.value, detail: detail.value };
      };
      summary.oninput = changed;
      detail.oninput = changed;
    }
    const errors = content.createEl("p", { cls: "ct-error", attr: { "aria-live": "polite" } }),
      actions = content.createDiv("ct-customization-actions");
    const apply = actions.createEl("button", { text: t("coffee.accept_selected_changes"), cls: "mod-cta" });
    apply.onclick = () => {
      if (engine.session.convergenceDraft !== draft) {
        errors.setText(t("coffee.the_draft_changed_reopen_the_latest_preview"));
        return;
      }
      if (!selected.size) {
        errors.setText(t("coffee.select_a_change_to_apply"));
        return;
      }
      apply.disabled = true;
      void engine
        .applyConvergence([...selected], edits)
        .then(() => this.close())
        .catch(error => {
          errors.setText(error instanceof Error ? error.message : String(error));
          apply.disabled = false;
        });
    };
    const discard = actions.createEl("button", { text: t("coffee.discard_preview") });
    discard.onclick = () => {
      if (engine.session.convergenceDraft !== draft) {
        errors.setText(t("coffee.the_draft_changed_reopen_the_latest_preview"));
        return;
      }
      discard.disabled = true;
      void engine
        .discardConvergence()
        .then(() => this.close())
        .catch(error => {
          errors.setText(String(error));
          discard.disabled = false;
        });
    };
  }
  onClose(): void {
    this.contentEl.empty();
  }
}
