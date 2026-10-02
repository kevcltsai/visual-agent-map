import type { AiTaskService } from "./ai-task-service";
import { createThinkingArtifact, type ThinkingArtifact, type ThinkingArtifactKind } from "./thinking-artifact";
import type { ReasoningLevel, TaskContext } from "../ai/types";
import type { UiLanguage } from "../i18n";

export type ThinkingMode = "discover" | "understand" | "challenge" | "validate" | "synthesize" | "decide";

const TARGETS: Record<ThinkingMode, { kind: ThinkingArtifactKind; instruction: string }> = {
  discover: { kind: "insight", instruction: "Frame this as a promising new topic, tension, or exploration direction." },
  understand: { kind: "question", instruction: "Frame this as a researchable question with enough context to begin structured investigation." },
  challenge: { kind: "argument", instruction: "Frame this as a concrete claim, proposal, or position that can withstand a strong opposing case." },
  validate: { kind: "hypothesis", instruction: "Frame this as a falsifiable hypothesis whose support can be distinguished by evidence." },
  synthesize: { kind: "synthesis", instruction: "Frame this as a synthesis goal plus the perspectives, evidence, and disagreements that must be integrated." },
  decide: { kind: "decision", instruction: "Frame this as a decision with alternatives, trade-offs, constraints, and the key uncertainty that matters." },
};

export interface ReframeRequest {
  source: ThinkingArtifact;
  target: ThinkingMode;
  model: string;
  reasoning?: ReasoningLevel;
  language: UiLanguage;
  signal?: AbortSignal;
}

export class ReframingLayer {
  constructor(private readonly tasks: AiTaskService) {}

  async reframe(request: ReframeRequest): Promise<ThinkingArtifact> {
    const target = TARGETS[request.target];
    const uncertainty = typeof request.source.metadata?.uncertainty === "string"
      ? request.source.metadata.uncertainty
      : "Preserve uncertainty from the source. Do not upgrade simulation, assumptions, or weak evidence into fact.";
    const context: TaskContext = {
      title: request.source.title,
      summary: request.source.summary ?? "",
      detail: request.source.content,
      rules: [
        "This is a hidden cross-experience reframing step, not a final answer.",
        target.instruction,
        "Target-first: optimize the framing for the target thinking mode, not for summarizing the source.",
        "Preserve important tensions, conditions, counterexamples, provenance, and uncertainty.",
        "Do not adopt an AI-generated position on behalf of the user.",
        uncertainty,
        "Return one concise framing in summary. In detail, include only context the target experience needs to start effectively."
      ].join("\n"),
      task: `Reframe the source for the ${request.target.toUpperCase()} thinking mode. Do not solve the problem. Produce a directly usable entry framing.`,
      ancestors: "",
      sourceContext: request.source.sources.map(source => [source.label, source.path ?? source.url].filter(Boolean).join(": ")).join("\n"),
      outputLanguage: request.language,
      mode: "task",
      researchMode: "local",
      researchDepth: "fast",
      visualMode: "off"
    };
    const result = await this.tasks.askModel(context, request.model, request.reasoning, request.signal);
    const title = result.summary.trim() || request.source.title;
    return createThinkingArtifact({
      id: crypto.randomUUID(),
      kind: target.kind,
      title,
      summary: title,
      content: result.detail.trim(),
      origin: { ...request.source.origin },
      sources: [
        ...request.source.sources,
        { label: request.source.title, experience: request.source.origin.experience, sessionId: request.source.origin.sessionId, path: request.source.origin.path, artifactId: request.source.id }
      ],
      metadata: {
        ...request.source.metadata,
        reframed: true,
        targetThinkingMode: request.target,
        sourceArtifactId: request.source.id,
        uncertainty
      }
    });
  }
}
