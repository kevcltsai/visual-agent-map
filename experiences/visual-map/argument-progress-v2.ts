import type { TranslationKey } from "../../i18n";
import { MAX_RESEARCH_CALLS, type ArgumentMapData, type Hypothesis } from "../../core/argument-map/model";
import type { ArgumentMapData as ArgumentMapDataV1 } from "../../core/argument-map/model-v1";
import type { ArgumentProgressView } from "./argument-progress";

type Translate = (key: TranslationKey, ...values: unknown[]) => string;

const searching = (h: Hypothesis): number => h.needs.filter(need => need.state === "searching").length;

/** Where a running version 2 analysis is, from the saved state alone: no hypotheses yet, finding evidence, assessing it, or judging. */
function analysisStage(state: ArgumentMapData, t: Translate): { title: string; detail?: string } {
  const live = state.hypotheses.filter(h => h.verdict === undefined);
  if (state.hypotheses.length === 0) return { title: t("ui.argument_v2_bar_proposing") };
  const open = live.filter(h => h.needs.some(need => need.state === "pending" || need.state === "searching"));
  if (open.length) {
    const round = open.reduce((most, h) => Math.max(most, h.round), 1);
    const count = open.reduce((sum, h) => sum + searching(h), 0);
    return {
      title: t("ui.argument_v2_bar_evidence_0", round),
      ...(count ? { detail: t("ui.argument_bar_searching_evidence_0", count) } : {})
    };
  }
  if (live.some(h => h.needs.some(need => need.state === "found" && !need.assessment)))
    return { title: t("ui.argument_v2_bar_assessing") };
  return { title: t("ui.argument_v2_bar_judging") };
}

/**
 * What the progress bar says for a version 2 map, from the saved run state alone. `owned`: this Obsidian session drives the run. A phase
 * the run left is "ended" and offers nothing; a run marked running that nobody drives is an interrupted one and nothing here starts it
 * again. A premise that did not hold stops only the claims that depend on it, so that count rides along on every non-final state.
 */
export function describeArgumentProgressV2(state: ArgumentMapData, owned: boolean, t: Translate): ArgumentProgressView {
  const run = state.run;
  const used = t("ui.argument_bar_used_0_1", run.researchCalls, MAX_RESEARCH_CALLS);
  const stopped = state.claims.filter(claim => claim.status === "not_evaluated").length;
  const note = (detail?: string): string | undefined => {
    const parts = [detail, stopped ? t("ui.argument_v2_bar_not_evaluated_0", stopped) : undefined].filter(
      (part): part is string => !!part
    );
    return parts.length ? parts.join(t("ui.list_separator")) : undefined;
  };
  const withDetail = (detail?: string): { detail?: string } => {
    const joined = note(detail);
    return joined ? { detail: joined } : {};
  };
  if (run.phase === "stopped_premise")
    return {
      tone: "done",
      title: t("ui.argument_v2_bar_stopped_premise"),
      detail: t("ui.argument_bar_see_conclusion"),
      count: t("ui.argument_bar_total_0", run.researchCalls),
      action: null
    };
  if (run.status === "finished" || run.phase === "concluded")
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
    let title: string;
    let detail: string | undefined;
    if (run.phase === "premises") {
      title = t("ui.argument_v2_bar_premises");
      const count = state.claims.reduce(
        (sum, claim) => sum + (claim.data ?? []).filter(datum => datum.state === "searching").length,
        0
      );
      if (count) detail = t("ui.argument_v2_bar_searching_premise_0", count);
    } else if (run.phase === "comparison") title = t("ui.argument_v2_bar_comparing");
    else if (run.phase === "conclusion") title = t("ui.argument_v2_bar_concluding");
    else if (run.phase === "inference_check") title = t("ui.argument_v2_bar_inference");
    else ({ title, detail } = analysisStage(state, t));
    return { tone: "run", title, ...withDetail(detail), count: used, action: "stop" };
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
  const judged = state.hypotheses.filter(h => h.verdict !== undefined).length;
  const reason =
    run.stopReason === "limit"
      ? t("ui.argument_v2_bar_limit")
      : run.stopReason === "data_missing"
        ? t("ui.argument_v2_bar_data_missing")
        : run.stopReason === "premise"
          ? t("ui.argument_v2_bar_premise_paused")
          : t("ui.argument_v2_bar_judged_0_1", judged, state.hypotheses.length);
  return { tone: "paused", title: t("ui.argument_bar_paused"), ...withDetail(reason), count: used, action: "resume" };
}

/** A legacy (`"v": 1`) map is read-only: the bar says so and offers nothing (resume would be refused). */
export function describeLegacyProgress(state: ArgumentMapDataV1, t: Translate): ArgumentProgressView {
  return {
    tone: "paused",
    title: t("ui.argument_legacy_bar_title"),
    detail: t("ui.argument_legacy_bar_detail"),
    count: t("ui.argument_bar_total_0", state.run.researchCalls),
    action: null
  };
}
