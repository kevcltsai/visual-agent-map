import type { TranslationKey } from "../../i18n";
import {
  MAX_RESEARCH_CALLS,
  MIN_VERIFIED,
  verifiedCount,
  type ArgumentMapData
} from "../../core/argument-map/model-v1";

type Translate = (key: TranslationKey, ...values: unknown[]) => string;
export type ArgumentProgressTone = "run" | "paused" | "warn" | "done";
export interface ArgumentProgressView {
  tone: ArgumentProgressTone;
  title: string;
  detail?: string;
  /** The research calls used, kept out of the bar's live region (it changes with every call). */
  count?: string;
  action: "stop" | "resume" | null;
}

/**
 * What the progress bar says, from the saved run state alone. `owned`: this Obsidian session is driving the run. A state the run
 * left (`finished`, or a phase of a closed flow) is always "ended" and offers nothing; a run marked running that nobody drives is
 * an interrupted one (the open-time recovery pauses it), and nothing here starts it again.
 */
export function describeArgumentProgress(state: ArgumentMapData, owned: boolean, t: Translate): ArgumentProgressView {
  const run = state.run;
  const used = t("ui.argument_bar_used_0_1", run.researchCalls, MAX_RESEARCH_CALLS);
  if (
    run.status === "finished" ||
    run.phase === "concluded" ||
    run.phase === "stopped_mismatch" ||
    run.phase === "stopped_limit"
  )
    return {
      tone: "done",
      title: t("ui.argument_bar_finished"),
      detail: t("ui.argument_bar_see_conclusion"),
      count: t("ui.argument_bar_total_0", run.researchCalls),
      action: null
    };
  if (run.status === "running") {
    if (!owned)
      return {
        tone: "warn",
        title: t("ui.argument_bar_interrupted"),
        detail: t("ui.argument_bar_no_auto_rerun"),
        action: null
      };
    if (run.phase === "situation") {
      const searching = state.situation.data.filter(datum => datum.state === "searching").length;
      return {
        tone: "run",
        title: t("ui.argument_bar_situation"),
        ...(searching ? { detail: t("ui.argument_bar_searching_data_0", searching) } : {}),
        count: used,
        action: "stop"
      };
    }
    const verifying = state.hypotheses.filter(h => h.location === "verifying");
    const round = verifying.reduce((most, h) => Math.max(most, h.round), 1);
    const searching = verifying.reduce((sum, h) => sum + h.needs.filter(need => need.state === "searching").length, 0);
    return {
      tone: "run",
      title: t("ui.argument_bar_round_0", round),
      ...(searching ? { detail: t("ui.argument_bar_searching_evidence_0", searching) } : {}),
      count: used,
      action: "stop"
    };
  }
  if (run.stopReason === "interrupted")
    return {
      tone: "warn",
      title: t("ui.argument_bar_interrupted"),
      detail: t("ui.argument_bar_no_auto_rerun"),
      action: "resume"
    };
  if (run.stopReason === "error")
    return { tone: "warn", title: t("ui.argument_bar_paused"), detail: t("ui.argument_bar_error"), action: "resume" };
  return {
    tone: "paused",
    title: t("ui.argument_bar_paused"),
    detail: t("ui.argument_bar_verified_0_1", verifiedCount(state), MIN_VERIFIED),
    count: used,
    action: "resume"
  };
}
