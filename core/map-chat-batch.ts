import type { MapAiMode, ResearchDepth, ResearchMode } from "../ai/types";

/** What a chat-started research batch was asked to do (the fields `startMultiResearch` takes from the chat, plus a one-off model). */
export interface ChatBatchRequest {
  mapAiMode: MapAiMode;
  researchMode: ResearchMode;
  researchDepth: ResearchDepth;
  requirements: string;
  imageSearch: boolean;
  rewrite?: true;
  model?: string;
  /** The current model when the batch first started: the cards without their own model run on it, a rerun too. */
  batchModel?: string;
}
export interface ChatBatchTopic {
  id: string;
  title: string;
}
/** A research batch a chat turn started: which cards, how each came out so far, and whether the batch has ended. */
export interface ChatBatch {
  turn: number;
  topics: ChatBatchTopic[];
  succeeded: string[];
  failed: string[];
  ended: boolean;
  request: ChatBatchRequest;
}
export interface ChatBatchSummary {
  total: number;
  done: number;
  failed: number;
  /** Cards that neither succeeded nor failed (stopped or never reached). */
  notRun: number;
  /** Every card that did not succeed, in batch order. */
  pending: ChatBatchTopic[];
  /** The batch was read back from a record and has no end: the plugin was reloaded while it ran. */
  interrupted: boolean;
}

/** How the batch stands, or null when every card succeeded (nothing to tell). */
export function summarizeChatBatch(batch: ChatBatch, restored: boolean): ChatBatchSummary | null {
  const done = new Set(batch.succeeded);
  const failed = new Set(batch.failed.filter(id => !done.has(id)));
  const pending = batch.topics.filter(topic => !done.has(topic.id));
  if (!pending.length) return null;
  const failedCount = pending.filter(topic => failed.has(topic.id)).length;
  return {
    total: batch.topics.length,
    done: batch.topics.length - pending.length,
    failed: failedCount,
    notRun: pending.length - failedCount,
    pending,
    interrupted: restored && !batch.ended
  };
}

/** A card came out: a success clears an earlier failure; a failure never undoes a success. Other statuses change nothing. */
export function markChatBatchTopic(batch: ChatBatch, id: string, status: "succeeded" | "failed" | "stopped"): void {
  if (status === "succeeded") {
    if (!batch.succeeded.includes(id)) batch.succeeded.push(id);
    batch.failed = batch.failed.filter(item => item !== id);
  } else if (status === "failed" && !batch.succeeded.includes(id) && !batch.failed.includes(id)) batch.failed.push(id);
}
