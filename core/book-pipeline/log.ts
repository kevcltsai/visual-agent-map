/** The pipeline's one log line per event. Only ids, counts, codes and milliseconds: never a title or any note text. */
import type { PipelineStep } from "./model";

export interface PipelineLogEvent {
  event: string;
  runId: string;
  /** A node id, or "global" for the whole-book plan. */
  card: string;
  step: PipelineStep;
  attempt: number;
  result: string;
  ms: number;
}

const code = (value: string): string => value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 60) || "-";

export function formatPipelineLog(e: PipelineLogEvent): string {
  return `book-pipeline ${code(e.event)} run=${code(e.runId)} card=${code(e.card)} step=${e.step} attempt=${Math.max(0, Math.trunc(e.attempt))} result=${code(e.result)} ms=${Math.max(0, Math.round(e.ms))}`;
}
