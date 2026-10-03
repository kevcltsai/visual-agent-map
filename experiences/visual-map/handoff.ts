import { normalizeReasoningLevel, type Repository, originMarkdown } from "../../repository";
import type { ThinkingArtifact } from "../../core/thinking-artifact";
import { HandoffWriteError, type ExperienceHandoffResult } from "../../core/experience-router";

export interface VisualMapHandoffOptions {
  repo: Repository;
  defaultModel: () => string;
  exists: (path: string) => boolean;
  mutate: (work: () => Promise<void>) => Promise<void>;
  navigate: (path: string) => Promise<void>;
  beforeWrite?: () => Promise<void>;
}
export async function receiveVisualMapHandoff(artifact: ThinkingArtifact, options: VisualMapHandoffOptions): Promise<ExperienceHandoffResult> {
  if (artifact.version !== 1 || !artifact.title.trim() || /[\r\n]/.test(artifact.title.trim())) throw new Error("Invalid research question");
  const paths: string[] = []; let targetPath = "", saved = false, navigationError: string | undefined;
  const record = (path: string): void => { if (!paths.includes(path)) paths.push(path); };
  try {
    await options.mutate(async () => {
      await options.beforeWrite?.();
      targetPath = await options.repo.createMap(artifact.title.trim(), [], folder => record(folder.path)); record(targetPath);
      const map = await options.repo.readMap(targetPath);
      const model = typeof artifact.metadata?.model === "string" ? artifact.metadata.model : options.defaultModel();
      const reasoning = normalizeReasoningLevel(artifact.metadata?.reasoning);
      const links = artifact.sources.filter(source => source.path).map(source => `[[${source.path}|${source.label}]]`);
      const statement = "Simulated / unverified thinking source; not an adopted user conclusion.";
      // Quote arbitrary input so it cannot close Detail's managed markers.
      const detail = [artifact.content, statement, ...links].map(originMarkdown).join("\n\n");
      const origin = [
        `Initial question: ${artifact.title}`, artifact.content, statement,
        `Origin: ${artifact.origin.experience}; session: ${artifact.origin.sessionId ?? "unknown"}; artifact: ${artifact.id}`,
        `Transformation: ${artifact.metadata?.reframingMethod === "ai" ? "AI draft edited/confirmed by user" : "Manual framing confirmed by user"}`,
        ...links,
        ...artifact.sources.map(source => `Source identity: ${JSON.stringify({ experience: source.experience, sessionId: source.sessionId, artifactId: source.artifactId, path: source.path, identityKind: artifact.metadata?.sourceIdentityKind ?? "unknown" })}`),
        `Insight snapshot:\n${artifact.sourceSnapshot || "No insight snapshot was supplied."}`
      ].join("\n\n");
      const node = await options.repo.createNote(artifact.title.trim(), model, map, targetPath, "manual", { detail, thinkingOrigin: origin, reasoning }, record);
      map.nodes.push(node);
      await options.repo.saveMap(targetPath, map);
      saved = true;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!saved) throw new HandoffWriteError(message, paths.filter(options.exists));
    navigationError = message;
  }
  try { await options.navigate(targetPath); }
  catch (error) { navigationError = [navigationError, error instanceof Error ? error.message : String(error)].filter(Boolean).join("\n"); }
  return { paths: paths.filter(options.exists), targetPath, ...(navigationError ? { navigationError } : {}) };
}
