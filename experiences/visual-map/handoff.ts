import { normalizeReasoningLevel, type Repository, originMarkdown } from "../../repository";
import type { ThinkingArtifact } from "../../core/thinking-artifact";
import { HandoffWriteError, type ExperienceHandoffHandler, type ExperienceHandoffResult } from "../../core/experience-router";

export interface VisualMapHandoffOptions {
  repo: Repository;
  defaultModel: () => string;
  exists: (path: string) => boolean;
  mutate: (work: () => Promise<void>) => Promise<void>;
  navigate: (path: string) => Promise<void>;
  beforeWrite?: () => Promise<void>;
  findHandoffCandidates?: (originId: string) => Promise<Array<{ mapPath: string; notePath: string; nodeId?: string }>>;
}
interface ExistingHandoff { mapPath: string; notePath: string; nodeId?: string }
export type VisualMapHandoffRegistrationOptions = Omit<VisualMapHandoffOptions, "findHandoffCandidates" | "beforeWrite">;
function sourceLinks(artifact: ThinkingArtifact): string[] {
  return artifact.sources.filter(source => source.path).map(source => `[[${source.path}|${source.label}]]`);
}
function handoffStatement(): string { return "Simulated / unverified thinking source; not an adopted user conclusion."; }
function handoffDetail(artifact: ThinkingArtifact, links: string[]): string {
  return [artifact.content, handoffStatement(), ...links].map(originMarkdown).join("\n\n");
}
function handoffOrigin(artifact: ThinkingArtifact, links: string[]): string {
  const statement = handoffStatement();
  return [
    `Initial question: ${artifact.title}`, artifact.content, statement,
    `Origin: ${artifact.origin.experience}; session: ${artifact.origin.sessionId ?? "unknown"}; artifact: ${artifact.id}`,
    `Transformation: ${artifact.metadata?.reframingMethod === "ai" ? "AI draft edited/confirmed by user" : "Manual framing confirmed by user"}`,
    ...links,
    ...artifact.sources.map(source => `Source identity: ${JSON.stringify({ experience: source.experience, sessionId: source.sessionId, artifactId: source.artifactId, path: source.path, identityKind: artifact.metadata?.sourceIdentityKind ?? "unknown" })}`),
    `Insight snapshot:\n${artifact.sourceSnapshot || "No insight snapshot was supplied."}`
  ].join("\n\n");
}
export async function findVisualMapHandoffCandidates(repo: Repository, originId: string): Promise<Array<{ mapPath: string; notePath: string; nodeId?: string }>> {
  const maps = await repo.mapFiles(), markdownFiles = repo.app.vault.getMarkdownFiles();
  const candidates: Array<{ mapPath: string; notePath: string; nodeId?: string }> = [];
  for (const mapFile of maps) {
    const root = mapFile.path.replace(/\/Map\.md$/, ""), notesFolder = `${root}/Notes/`;
    for (const file of markdownFiles) {
      if (!file.path.startsWith(notesFolder)) continue;
      const note = await repo.readNote(file.path);
      if (!note.thinkingOrigin?.split(/\r?\n/).includes(originId)) continue;
      const frontmatter = repo.app.metadataCache.getFileCache(file)?.frontmatter;
      const nodeId = typeof frontmatter?.["node-id"] === "string" ? frontmatter["node-id"] : undefined;
      candidates.push({ mapPath: mapFile.path, notePath: file.path, ...(nodeId ? { nodeId } : {}) });
    }
  }
  return candidates;
}
export function createVisualMapHandoffHandler(options: VisualMapHandoffRegistrationOptions): ExperienceHandoffHandler {
  return (artifact, beforeWrite) => receiveVisualMapHandoff(artifact, {
    ...options,
    beforeWrite,
    findHandoffCandidates: originId => findVisualMapHandoffCandidates(options.repo, originId)
  });
}
async function findExistingHandoff(artifact: ThinkingArtifact, options: VisualMapHandoffOptions, expectedOrigin: string, expectedDetail: string): Promise<ExistingHandoff | undefined> {
  const originId = `Origin: ${artifact.origin.experience}; session: ${artifact.origin.sessionId ?? "unknown"}; artifact: ${artifact.id}`;
  const candidates: ExistingHandoff[] = [];
  for (const file of await options.repo.mapFiles()) {
    const map = await options.repo.readMap(file.path);
    for (const node of map.nodes) candidates.push({ mapPath: file.path, notePath: node.path, nodeId: node.id });
  }
  candidates.push(...(await options.findHandoffCandidates?.(originId) ?? []));
  const unique = [...new Map(candidates.map(candidate => [`${candidate.mapPath}\n${candidate.notePath}`, candidate])).values()];
  const matches: ExistingHandoff[] = [];
  for (const candidate of unique) {
    if (!options.exists(candidate.notePath) || !options.exists(candidate.mapPath)) continue;
    const note = await options.repo.readNote(candidate.notePath);
    if (!note.thinkingOrigin?.split(/\r?\n/).includes(originId)) continue;
    if (note.thinkingOrigin !== expectedOrigin || note.detail !== expectedDetail) throw new Error("An existing Visual Map handoff has this source identity but its saved content differs; inspect it before retrying.");
    const map = await options.repo.readMap(candidate.mapPath);
    let node = map.nodes.find(item => item.path === candidate.notePath);
    if (!node) {
      if (!candidate.nodeId || map.nodes.some(item => item.id === candidate.nodeId)) throw new Error("The matching Visual Map note is not linked to its map and cannot be safely recovered; inspect it before retrying.");
      map.nodes.push({ id: candidate.nodeId, path: candidate.notePath, parentId: null, x: 80, y: 80, collapsed: false });
      await options.repo.saveMap(candidate.mapPath, map);
      const recovered = await options.repo.readMap(candidate.mapPath);
      node = recovered.nodes.find(item => item.id === candidate.nodeId && item.path === candidate.notePath);
      if (!node) throw new Error("The existing Visual Map note could not be reattached after rereading its map.");
    }
    const verifiedNote = await options.repo.readNote(node.path);
    if (verifiedNote.thinkingOrigin !== expectedOrigin || verifiedNote.detail !== expectedDetail) throw new Error("The existing Visual Map handoff changed while it was being recovered; inspect it before retrying.");
    matches.push({ mapPath: candidate.mapPath, notePath: candidate.notePath, nodeId: node.id });
  }
  if (matches.length > 1) throw new Error("More than one Visual Map note has this handoff identity; no duplicate was created.");
  return matches[0];
}
export async function receiveVisualMapHandoff(artifact: ThinkingArtifact, options: VisualMapHandoffOptions): Promise<ExperienceHandoffResult> {
  if (artifact.version !== 1 || !artifact.title.trim() || /[\r\n]/.test(artifact.title.trim())) throw new Error("Invalid research question");
  const paths: string[] = []; let targetPath = "", saved = false, navigationError: string | undefined;
  const links = sourceLinks(artifact), origin = handoffOrigin(artifact, links), detail = handoffDetail(artifact, links);
  const record = (path: string): void => { if (!paths.includes(path)) paths.push(path); };
  try {
    await options.mutate(async () => {
      await options.beforeWrite?.();
      const existing = await findExistingHandoff(artifact, options, origin, detail);
      if (existing) {
        targetPath = existing.mapPath; record(existing.mapPath); record(existing.notePath); saved = true; return;
      }
      targetPath = await options.repo.createMap(artifact.title.trim(), [], folder => record(folder.path)); record(targetPath);
      const map = await options.repo.readMap(targetPath);
      const model = typeof artifact.metadata?.model === "string" ? artifact.metadata.model : options.defaultModel();
      const reasoning = normalizeReasoningLevel(artifact.metadata?.reasoning);
      // Quote arbitrary input so it cannot close Detail's managed markers.
      const node = await options.repo.createNote(artifact.title.trim(), model, map, targetPath, "manual", { detail, thinkingOrigin: origin, reasoning }, record);
      map.nodes.push(node);
      await options.repo.saveMap(targetPath, map);
      const savedMap = await options.repo.readMap(targetPath);
      const savedNode = savedMap.nodes.find(item => item.id === node.id && item.path === node.path);
      const savedNote = savedNode ? await options.repo.readNote(savedNode.path) : undefined;
      if (!savedNote || savedNote.thinkingOrigin !== origin || savedNote.detail !== detail) throw new Error("Visual Map saved the handoff but its content and provenance could not be verified after rereading it.");
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
