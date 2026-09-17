import type { AiResult, TaskContext } from "../types";

export interface AiProvider {
  readonly id: "codex" | "claude";
  run(context: TaskContext, model: string): Promise<AiResult>;
}
