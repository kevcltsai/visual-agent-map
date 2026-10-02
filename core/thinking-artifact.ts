export type ThinkingArtifactKind =
  | "question"
  | "insight"
  | "argument"
  | "evidence"
  | "hypothesis"
  | "disagreement"
  | "conclusion"
  | "synthesis"
  | "decision";

export type ExperienceId =
  | "visual-map"
  | "coffee-tables"
  | "challenge"
  | "association"
  | "synthesize"
  | "decide";

export interface ThinkingArtifactSource {
  label: string;
  path?: string;
  url?: string;
  experience?: ExperienceId;
  sessionId?: string;
  artifactId?: string;
}

export interface ThinkingArtifact {
  version: 1;
  id: string;
  kind: ThinkingArtifactKind;
  title: string;
  content: string;
  summary?: string;
  origin: {
    experience: ExperienceId;
    sessionId?: string;
    path?: string;
  };
  sources: ThinkingArtifactSource[];
  metadata?: Record<string, string | number | boolean>;
}

export function createThinkingArtifact(
  input: Omit<ThinkingArtifact, "version">
): ThinkingArtifact {
  return { version: 1, ...input };
}
