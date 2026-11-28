import type { MapChatContext } from "../../core/map-chat-context";
import type { MapChatRequest, MapChatResult } from "../../core/map-chat-service";
import type { MapChatAction } from "../../core/steps/map-chat/step";
import type { TopicChatLineInput, TopicRecordStatus } from "../../core/topic-chat-records";
import { planFor } from "../../core/map-chat-plan";
import { t } from "../../i18n";
import type { ContentLanguage } from "../../i18n";
import type { MapDocument, MapNode } from "../../map-model";
import type { Note } from "../../repository";
import type { ChatOutcome } from "./chat-action-writer";
import type { MapChatConversationPorts } from "./map-chat-conversation";
import type { MapChatLine } from "./map-chat";
import type { TopicChatButtonKind, TopicChatChoice, TopicChatMode, TopicChatTurn, TopicChatWindow } from "./topic-chat";
import { judgeTopicScope } from "./topic-chat-scope";
import type { TopicChatSteers } from "./topic-chat-steer";

/** One topic's chat: the conversation lives here (not in the window), so a task that outlives a closed window can still tell its result. */
export interface TopicChatEntry {
  nodeId: string;
  mapId: string;
  mapPath: string;
  session: {
    turns: TopicChatTurn[];
    mode: TopicChatMode;
    running: boolean;
    draftKind: TopicChatButtonKind | null;
    draftText: string;
    /** The depth card of an integration over a deeper subtree, waiting for an answer; `turn` is the user line that asked. */
    choice?: (TopicChatChoice & { text: string; turn: TopicChatTurn }) | null;
    /** After a deeper integration ran its quick option: the depth card's numbers, shown again on "Other ways to integrate". */
    otherWays?: (TopicChatChoice & { text: string }) | null;
    progress?: string;
  };
  watchers: Set<() => void>;
  /** The id of the turn whose result is not written yet (null when idle). */
  runningTurnId: string | null;
  /** True while a submit is between its checks and its start; a second window of this entry cannot send twice. */
  submitting?: boolean;
  /** The additions typed while the current task runs. Created with `running = true`, in the same tick. */
  steers?: TopicChatSteers;
  /** Additions typed while a synthesis researched its subtopics first: they ride along in the integration's text (shown as taken in). */
  steerFolded?: string[];
  /** How the current task ended (set by `settleTopicChat`); `plan`: the reply needs a plan, so nothing is sent on. */
  steerEnd?: { status: TopicRecordStatus; plan: boolean } | null;
  /** A turn of this conversation sent the map's data sources: they are untrusted, so a later reply's writes need a plan (the same rule as after research). */
  readsSources?: boolean;
  /** The AbortController of the current run (the window's stop button aborts it). */
  controller?: AbortController;
}
type RunMapAction = Extract<MapChatAction, { kind: "run_map_action" }>;
/** What the topic chat run needs of the view; every port is read at call time. */
export type TopicChatRunPorts = Pick<
  MapChatConversationPorts,
  "closed" | "path" | "taskKey" | "registerTask" | "unregisterTask" | "requestChat" | "errorText" | "notice"
> & {
  map(): Pick<MapDocument, "id" | "nodes" | "aiMode"> | null;
  addDiagrams(): boolean;
  buildRequest(
    entry: TopicChatEntry,
    node: MapNode,
    note: Note,
    message: string,
    signal: AbortSignal
  ): Promise<MapChatRequest>;
  applyActions(
    result: MapChatResult & { message?: string },
    baseline: MapChatContext,
    alive: () => boolean,
    anchor: { path: string; id: string | undefined },
    options: {
      context: MapChatContext;
      topicScope: { rootId: string; run: (action: RunMapAction, targets: string[]) => Promise<ChatOutcome> };
    }
  ): Promise<MapChatLine[]>;
  runAction(
    action: RunMapAction,
    targets: string[],
    mode: TopicChatMode,
    language: ContentLanguage,
    signal: AbortSignal
  ): Promise<ChatOutcome>;
  window(entry: TopicChatEntry): Pick<TopicChatWindow, "setInputText"> | null;
  notify(entry: TopicChatEntry): void;
  writeLine(entry: TopicChatEntry, line: TopicChatLineInput): void;
  followUp(entry: TopicChatEntry, node: MapNode, steers: TopicChatSteers): Promise<boolean>;
};
/** The topic chat's free question and the end of a run: the entry's state machine, with everything of the view behind ports. */
export class TopicChatRun {
  constructor(private readonly ports: TopicChatRunPorts) {}
  /** A free question: one map-chat request about the topic; what the reply writes is checked against the subtree where it is applied. */
  async ask(
    entry: TopicChatEntry,
    node: MapNode,
    note: Note,
    mode: TopicChatMode,
    text: string,
    controller: AbortController,
    language: ContentLanguage,
    live: () => boolean,
    hooks: { begin(controller: AbortController): void; end(): void },
    steers: TopicChatSteers
  ): Promise<void> {
    const key = this.ports.taskKey();
    let began = false;
    const end = (): void => {
      if (!began) return;
      began = false;
      this.ports.unregisterTask(key);
      hooks.end();
    };
    try {
      const request = await this.ports.buildRequest(entry, node, note, text, controller.signal);
      began = true;
      this.ports.registerTask(key, controller);
      hooks.begin(controller);
      const result = await this.ports.requestChat(
        request,
        controller.signal,
        () => {},
        event => {
          // Claude without a live stream (json, json-fallback) cannot take additions: they all wait for the end.
          if (event.kind === "stream-mode" && event.mode !== "stream-json") steers.live(false);
        },
        send => steers.bind(send)
      );
      end();
      // Hand-overs still on their way settle first: what the reply took in is final before it is applied or put in the history.
      if (steers.entries.length) await steers.close();
      if (controller.signal.aborted) {
        this.settle(entry, t("ui.topic_chat_stopped"), live, false, "stopped", true);
        return;
      }
      const map = this.ports.map();
      if (!live() || !map) {
        this.settle(entry, t("ui.topic_chat_stopped"), live, false, "stopped", true);
        return;
      }
      const verdicts = judgeTopicScope(result.actions, map.nodes, node.id);
      const allowed = result.actions.filter((_, index) => verdicts[index] === "ok");
      // A reply that would need the user's yes first (a plan) is not applied here: the side panel has the plan screen.
      const plan = allowed.length
        ? planFor(allowed, request.context, {
            diagrams: this.ports.addDiagrams(),
            mapAiMode: map.aiMode,
            chatReadSources: entry.readsSources === true,
            changeRequested: result.changeRequested === true
          })
        : null;
      // A question that came back with changes (decision 2026-11-28-vam-v3-3#33): the answer is shown, the changes only as a suggestion.
      if (plan?.reasons.includes("not_requested")) {
        this.settle(
          entry,
          [result.reply.trim(), t("ui.topic_chat_not_requested")].filter(Boolean).join("\n\n"),
          live,
          true,
          "done",
          true,
          true
        );
        return;
      }
      if (plan) {
        this.settle(entry, t("ui.topic_chat_too_big"), live, true, "done", true, true);
        return;
      }
      const lines = allowed.length
        ? await this.ports.applyActions(
            { ...result, message: [text, ...steers.delivered()].join("\n\n") },
            request.context,
            () => live() && !controller.signal.aborted,
            { path: this.ports.path(), id: map.id },
            {
              context: request.context,
              topicScope: {
                rootId: node.id,
                run: (action, targets) =>
                  this.ports.runAction(action, targets, action.mode || mode, language, controller.signal)
              }
            }
          )
        : [];
      const refused = verdicts.filter(verdict => verdict === "out").length;
      // A reply that says it is done cannot hide an action that failed or was skipped: those lines are shown with it.
      // Refused or ignored actions already have their say (the out-of-scope sentence, or silence), so only allowed ones and the lines added after the actions count.
      const problems = lines.filter(
        (line, index) => line.status !== "done" && (index >= result.actions.length || verdicts[index] === "ok")
      );
      let sentence = result.reply.trim() || lines.map(line => line.text).join("\n");
      if (problems.length) sentence = [sentence, ...problems.map(line => line.text)].filter(Boolean).join("\n\n");
      if (refused) sentence = [sentence, t("ui.topic_chat_out_of_scope")].filter(Boolean).join("\n\n");
      if (!sentence) sentence = t("ui.topic_chat_result_unknown");
      if (controller.signal.aborted) this.settle(entry, t("ui.topic_chat_stopped"), live, false, "stopped", true);
      else this.settle(entry, sentence, live, true, problems.length ? "failed" : "done", true);
    } catch (error) {
      end();
      const stopped = controller.signal.aborted;
      this.settle(
        entry,
        stopped ? t("ui.topic_chat_stopped") : t("ui.topic_chat_failed_0", this.ports.errorText(error).text),
        live,
        !stopped,
        stopped ? "stopped" : "failed",
        true
      );
    }
  }
  /** Ends a run: the window (if open) shows one sentence; a closed window gets a Notice when `notice` says the task did not tell it. */
  settle(
    entry: TopicChatEntry,
    sentence: string,
    live: () => boolean,
    notice: boolean,
    status: TopicRecordStatus,
    markdown = false,
    plan = false
  ): void {
    // With additions the entry stays running over the gap until they are settled (`endSteers` frees it).
    if (!this.holdsSteers(entry)) entry.session.running = false;
    entry.steerEnd = { status, plan };
    entry.session.progress = undefined;
    const turnId = entry.runningTurnId;
    entry.runningTurnId = null;
    // Late-result fence: a view that closed or moved to another map writes nothing (its next open says the result is unknown).
    if (!live()) return;
    if (turnId)
      this.ports.writeLine(entry, {
        type: "result",
        id: turnId,
        at: new Date().toISOString(),
        status,
        text: sentence
      });
    entry.session.turns.push({ role: "ai", text: sentence, ...(markdown ? { markdown: true } : {}) });
    this.ports.notify(entry);
    if (notice && !this.ports.window(entry)) this.ports.notice(sentence);
  }
  /** True when the task has additions of any kind: then `running` stays on until they are settled (the gap after the reply). */
  private holdsSteers(entry: TopicChatEntry): boolean {
    return !!entry.steers?.entries.length || !!entry.steerFolded?.length;
  }
  /** Puts additions that were not sent back in front of the draft; a closed window (nothing shows it) says so when `notice`. */
  private returnSteers(entry: TopicChatEntry, texts: string[], notice: boolean): void {
    if (!texts.length) return;
    const draft = [...texts, entry.session.draftText].filter(Boolean).join("\n\n");
    entry.session.draftText = draft;
    const open = this.ports.window(entry);
    if (open) open.setInputText(draft);
    else if (notice) this.ports.notice(t("ui.map_chat_not_sent_draft"));
  }
  /**
   * After the task has settled with additions: wait for hand-overs to end (`close`), write the ones that went in, then either
   * send the waiting ones as one new question (the reply was done and the view is the same) or put them back in the box.
   * `running` stays true over all of it, so a second Enter can only add (queued), never start a run.
   */
  async endSteers(
    entry: TopicChatEntry,
    steers: TopicChatSteers,
    turnId: string | null,
    live: () => boolean
  ): Promise<void> {
    const end = entry.steerEnd ?? null;
    const done = !!end && end.status === "done" && !end.plan;
    const folded = entry.steerFolded ?? [];
    const finish = (): void => {
      entry.session.running = false;
      this.ports.notify(entry);
    };
    try {
      await steers.close();
      if (live() && turnId)
        for (const text of [...(done ? folded : []), ...steers.delivered()])
          this.ports.writeLine(entry, { type: "steer", id: turnId, at: new Date().toISOString(), text });
      const node = this.ports.map()?.nodes.find(item => item.id === entry.nodeId);
      if (done && live() && steers.entries.some(item => item.state === "queued")) {
        if (node) {
          entry.submitting = true;
          try {
            if (await this.ports.followUp(entry, node, steers)) return;
          } finally {
            entry.submitting = false;
          }
        }
        // Declined (usage question, lock, busy, a presentation, a deleted card, ...): the waiting texts are back in the box.
        this.returnSteers(entry, steers.takeQueued(), true);
        finish();
        return;
      }
      // Stopped, failed, a plan, a view that is gone, a deleted card, or nothing waiting.
      this.returnSteers(entry, [...(done ? [] : folded), ...steers.takeQueued()], false);
      finish();
    } catch {
      // A follow-up that already started owns `running` now; otherwise the texts are back in the box and the entry is free.
      if (entry.runningTurnId) return;
      this.returnSteers(entry, steers.takeQueued(), true);
      finish();
    }
  }
}
