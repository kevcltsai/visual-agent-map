import { randomUUID } from "node:crypto";
import { TFile, type App } from "obsidian";
import { isPlaceholder } from "../../core/note-placeholder";
import { decodeCalloutSections, removeSection } from "../../core/repository-note-body";
import { frontmatter, setFrontmatterKeys } from "../../core/repository-frontmatter";
import { livingConfigurationStamp } from "../../core/living-node-region";
import { normalizeVaultPath } from "../../core/map-chat-guard";
import { createNoteReadContext, readOnce, type NoteReadContext } from "../../core/note-read-context";
import type { AiCalls } from "../../core/ai-calls";
import type { Repository, Note } from "../../repository";
import type { MapDocument } from "../../map-model";
import type { ReferenceGroup } from "../../ai/reference-materials";
import { isAiCard, promptSourceLinks, splitPrompt } from "./prompt-run";
import { introducesLivingCycle, planLivingMap, type LivingMapCard } from "./living-node-map";
import {
  readLivingReferences,
  livingConfigPrompt,
  livingConfigRef,
  livingIdentityStore,
  reconcileLivingDraftReferences,
  sameLivingTarget,
  type LivingSourceRef,
  type resolveLivingSources
} from "./living-node-sources";
import { LivingCoordinator } from "./living-node-coordinator";
import { executeLivingPlan, type LivingSettlement } from "./living-node-execution";
import { commitLivingMarkdown, livingSnapshotRevision, readLivingMarkdown } from "./living-node-markdown";
import { livingConfigRevision, livingInputRevision, type LivingRead } from "./living-node-state";
import { generateLivingProposal } from "./living-node-provider";
import type { LivingAdoptionCheck, LivingTrialRequest } from "./living-node-trial";
import {
  applyLivingChanges,
  hasLivingResult,
  livingLegacySuppressionIds,
  type LivingEvidence
} from "./living-node-changes";

export { setLivingIdentityStore } from "./living-node-sources";

const coordinators = new WeakMap<object, LivingCoordinator>();
export function livingCoordinator(owner: object): LivingCoordinator {
  let coordinator = coordinators.get(owner);
  if (!coordinator) {
    coordinator = new LivingCoordinator();
    coordinators.set(owner, coordinator);
  }
  return coordinator;
}

/** Map-level sources remain optional, but a missing read must be disclosed instead of silently disappearing. */
export interface LivingMapContext {
  groups: ReferenceGroup[];
  unavailable: number;
}
type LivingMapSources = ReferenceGroup[] | LivingMapContext;

async function readLivingMapContext(
  port: Pick<LivingRoundPort, "mapSources" | "signal" | "current">
): Promise<LivingMapContext> {
  try {
    const result = await port.mapSources(port.signal);
    if (port.signal.aborted || !port.current()) throw new Error("cancelled");
    return Array.isArray(result) ? { groups: result, unavailable: 0 } : result;
  } catch (error) {
    if (port.signal.aborted || !port.current() || (error instanceof Error && error.name === "AbortError")) throw error;
    return { groups: [], unavailable: 1 };
  }
}

export interface LivingRoundPort {
  app: App;
  repo: Repository;
  calls: AiCalls;
  coordinator: LivingCoordinator;
  mapPath: string;
  viewSession: string;
  signal: AbortSignal;
  current(): boolean;
  busy(path: string): boolean;
  language(map: MapDocument, note: Note): string;
  mapSources(signal: AbortSignal): Promise<LivingMapSources>;
  onOptionalSourcesUnavailable?(): void;
  /** The model edited records it was not sent (a large card history); those edits were skipped. */
  onOmittedEditsSkipped?(id: string, count: number): void;
  onSuppressedDropped?(id: string, count: number): void;
  log?(level: "debug", message: string): void;
  confirm(model: string, run: () => Promise<void>): Promise<boolean>;
  onStart(total: number): void;
  /** Trial cards are an execution boundary: skipped themselves, used frozen when valid, otherwise blocking their dependents. */
  onTrialBoundary?(boundary: { skipped: string[]; frozen: string[]; blocked: string[] }): void;
  onRunning(id: string): void;
  onSettled(id: string, result: LivingSettlement): void;
  onFailure(id: string, error: unknown): void;
  onCommit?(path: string, before: string, after: string): void;
}

type LivingTrialPort = Pick<
  LivingRoundPort,
  "app" | "repo" | "calls" | "mapPath" | "viewSession" | "signal" | "current" | "language" | "mapSources"
> & {
  /** Notes the caller already read (the view's hydrate); one pass never reads a note the context holds. */
  noteReads?: NoteReadContext;
};

interface Snapshot {
  note: Note;
  content: string;
}

const rawText = (raw: string): string => raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");

function readableMarkdown(raw: string): string {
  let body = decodeCalloutSections(rawText(raw));
  for (const heading of ["Prompt", "Rules"] as const) body = removeSection(body, heading);
  return body;
}

function ownKnowledge(note: Note, includeTitle = true): string {
  return [
    includeTitle ? note.title : "",
    note.thinkingOrigin,
    note.summary,
    note.preview,
    note.detail,
    note.newFindings
  ]
    .filter(value => value && value.trim() && !isPlaceholder(value))
    .join("\n\n");
}

function usableKnowledge(snapshot: Snapshot): boolean {
  const base = readLivingMarkdown(snapshot.content);
  return (
    hasLivingResult(base) ||
    (base.revision === "empty" &&
      base.output.owner === "ai" &&
      (snapshot.note.aiRun?.result === "ok" || frontmatter(snapshot.content)["living-node-copy-snapshot"] === true) &&
      !!ownKnowledge(snapshot.note, false))
  );
}

function refs(snapshot: Snapshot): LivingSourceRef[] {
  return readLivingReferences(
    frontmatter(snapshot.content)["living-node-refs"],
    promptSourceLinks(snapshot.note.prompt)
  );
}

function allowedLivingNotePath(app: App, path: string): boolean {
  const key = normalizeVaultPath(path);
  const config = normalizeVaultPath(app.vault.configDir);
  return (
    !!key &&
    key === path &&
    !!config &&
    key.toLowerCase() !== config.toLowerCase() &&
    !key.toLowerCase().startsWith(config.toLowerCase() + "/") &&
    key.toLowerCase().endsWith(".md")
  );
}

/** The persisted identity of the note at `path`, bound on first sight. Without a store the path is the identity. */
function noteIdentity(app: App, file: TFile) {
  const store = livingIdentityStore(app);
  if (!store) return { identity: file.path, resolved: true };
  const entry = store.observe(file.path, { ctime: file.stat.ctime, size: file.stat.size });
  return { identity: entry.refId, resolved: entry.state === "resolved" };
}

export function sourceResolver(app: App) {
  return {
    resolveAuthorized(link: string, fromPath: string, _role?: "explicit" | "map", exact?: true) {
      const file = exact
        ? app.vault.getAbstractFileByPath(link)
        : app.metadataCache.getFirstLinkpathDest(link, fromPath);
      if (
        !(file instanceof TFile) ||
        !allowedLivingNotePath(app, file.path) ||
        app.vault.getAbstractFileByPath(file.path) !== file
      )
        return undefined;
      const { identity, resolved } = noteIdentity(app, file);
      return { identity, path: file.path, ...(resolved ? {} : { unresolved: true as const }) };
    }
  };
}

function configKey(
  snapshot: Snapshot,
  map: MapDocument,
  id: string,
  port: Pick<LivingRoundPort, "language" | "app">
): string {
  const node = map.nodes.find(item => item.id === id);
  if (!node) return "";
  const children = map.nodes.filter(item => item.parentId === id).map(item => item.id);
  return livingSnapshotRevision(
    JSON.stringify([
      livingConfigRevision(
        livingConfigPrompt(snapshot.note.prompt, link => {
          const file = port.app.metadataCache.getFirstLinkpathDest(link, node.path);
          return file instanceof TFile && allowedLivingNotePath(port.app, file.path)
            ? noteIdentity(port.app, file).identity
            : undefined;
        }),
        refs(snapshot).map(ref =>
          livingConfigRef(ref, path => {
            const file = port.app.vault.getAbstractFileByPath(path);
            return file instanceof TFile ? noteIdentity(port.app, file).identity : undefined;
          })
        )
      ),
      node.path,
      [...children].sort(),
      snapshot.note.aiCard === true,
      snapshot.note.aiLocked === true,
      snapshot.note.model,
      snapshot.note.reasoning,
      port.language(map, snapshot.note)
    ])
  );
}

async function prepareMap(port: Pick<LivingRoundPort, "repo" | "app">, map: MapDocument, reads?: NoteReadContext) {
  const snapshots = new Map<string, Snapshot>();
  const cards: LivingMapCard[] = [];
  for (const node of map.nodes) {
    let snapshot: Snapshot | undefined;
    try {
      if (!allowedLivingNotePath(port.app, node.path)) throw new Error("unauthorized-source");
      snapshot = await port.repo.readNoteSnapshot(node.path, map, reads);
      snapshots.set(node.id, snapshot);
    } catch {
      // Missing notes cannot execute. A consumer that needs one will fail closed when reading its source.
    }
    let hasKnowledge = false;
    let sourceUnavailable = false;
    let explicitRefs: LivingSourceRef[] = [];
    if (snapshot) {
      try {
        explicitRefs = refs(snapshot);
        hasKnowledge = usableKnowledge(snapshot);
      } catch {
        sourceUnavailable = true;
      }
    }
    cards.push({
      id: node.id,
      parentId: node.parentId,
      path: node.path,
      prompt: snapshot?.note.prompt ?? "",
      aiCard: snapshot?.note.aiCard,
      aiLocked: snapshot?.note.aiLocked,
      hasKnowledge,
      sourceUnavailable,
      explicitRefs
    });
  }
  return { snapshots, cards };
}

/** Before a removal moves files, identify surviving consumers of explicit card
 * references. The removal itself does not erase or retarget the saved IDs. */
export async function livingRemovalConsumers(
  app: App,
  repo: Repository,
  map: MapDocument,
  removed: ReadonlySet<string>
): Promise<string[]> {
  if (!removed.size) return [];
  const { cards } = await prepareMap({ repo, app }, map);
  const planned = planLivingMap(cards, [], sourceResolver(app));
  return cards
    .filter(
      card =>
        !removed.has(card.id) &&
        isAiCard(card) &&
        planned.sources
          .get(card.id)
          ?.sources.some(source => !!source.cardId && removed.has(source.cardId) && source.roles.includes("explicit"))
    )
    .map(card => card.id);
}

/** Preserve the original file and stable node ID when cutting a Living Node
 * or any of its inputs across maps. The old copy/park behavior remains for
 * ordinary, unrelated branches. Refuse identity collisions rather than let
 * an existing explicit reference silently bind to an unrelated card. */
export async function livingCrossCut(
  app: App,
  repo: Repository,
  source: MapDocument,
  destination: MapDocument,
  moved: ReadonlySet<string>,
  destinationParentId?: string | null
): Promise<{ preserveIdentity: boolean; affected: string[] }> {
  const { cards, snapshots } = await prepareMap({ repo, app }, source);
  const planned = planLivingMap(cards, [], sourceResolver(app));
  const affected = cards
    .filter(
      card =>
        isAiCard(card) &&
        (moved.has(card.id)
          ? planned.sources.get(card.id)?.sources.some(input => input.cardId && !moved.has(input.cardId))
          : planned.sources.get(card.id)?.sources.some(input => input.cardId && moved.has(input.cardId)))
    )
    .map(card => card.id);
  const destinationParent = destination.nodes.find(node => node.id === destinationParentId);
  const destinationNote = destinationParent && (await repo.readNoteSnapshot(destinationParent.path, destination));
  const preserveIdentity =
    !!destinationNote?.note.aiCard ||
    affected.length > 0 ||
    cards.some(card => moved.has(card.id) && (card.aiCard || snapshots.get(card.id)?.note.livingNode));
  if (!preserveIdentity) return { preserveIdentity, affected };
  const destinationIds = new Set(destination.nodes.map(node => node.id));
  if (source.nodes.some(node => destinationIds.has(node.id))) throw new Error("ambiguous-card-identity");
  for (const card of cards) {
    if (!moved.has(card.id)) continue;
    if (!snapshots.has(card.id) || card.sourceUnavailable) throw new Error("invalid-source");
    if (card.explicitRefs.some(ref => ref.kind === "card" && !moved.has(ref.id) && destinationIds.has(ref.id)))
      throw new Error("ambiguous-card-identity");
  }
  return { preserveIdentity, affected };
}

/** The metadata cache describes the file only once it has indexed the file's latest write; until then the note is read. */
function cacheSettled(app: App, file: TFile): boolean {
  const indexed = (app.metadataCache as unknown as { fileCache?: Record<string, { mtime?: number } | undefined> })
    .fileCache?.[file.path];
  return !indexed || indexed.mtime === undefined || indexed.mtime >= file.stat.mtime;
}

/** Check the final structural snapshot before Map.md is published. Reordering,
 * layout, viewport and collapse do not change dependencies. Existing cards use
 * their current note bytes (including after a file move); only graph edges that
 * the structural edit creates are prohibited. */
export async function validateLivingStructure(
  app: App,
  repo: Repository,
  before: MapDocument,
  after: MapDocument
): Promise<void> {
  const parentGraph = (map: MapDocument): string =>
    JSON.stringify(
      map.nodes.map(node => [node.id, node.parentId ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    );
  if (parentGraph(before) === parentGraph(after)) return;
  // A cycle needs an AI card. The metadata cache answers this without reading a note; a note it has not indexed yet is unknown.
  const mayBeAi = after.nodes.some(node => {
    const file = app.vault.getAbstractFileByPath(node.path);
    if (!(file instanceof TFile)) return false;
    const cache = app.metadataCache.getFileCache(file);
    return !cache || !cacheSettled(app, file) || !!cache.frontmatter?.["ai-card"];
  });
  if (!mayBeAi) return;
  const { cards } = await prepareMap({ repo, app }, after);
  const oldById = new Map(before.nodes.map(node => [node.id, node]));
  const oldCards = cards
    .filter(card => oldById.has(card.id))
    .map(card => ({
      ...card,
      parentId: oldById.get(card.id)!.parentId
    }));
  if (introducesLivingCycle(oldCards, cards, sourceResolver(app))) throw new Error("living-node-cycle");
}

/** A bounded context read. Revisions cover full readable content, even when only a summary is delivered. */
async function readInputs(
  port: LivingTrialPort,
  map: MapDocument,
  id: string,
  snapshot: Snapshot,
  resolved: ReturnType<typeof resolveLivingSources>,
  additionalWarnings: readonly string[] = []
) {
  const base = readLivingMarkdown(snapshot.content);
  const reads: LivingRead[] = [];
  const evidence: LivingEvidence[] = [];
  const documents: { id: string; title: string; scope: string; text: string; revision: string }[] = [];
  const seen = new Set<string>();
  const warnings = [
    ...resolved.failures.filter(failure => !failure.required).map(failure => failure.reason),
    ...additionalWarnings
  ];
  let characters = 0;
  const at = new Date().toISOString();
  const prompt = splitPrompt(snapshot.note.prompt).question;
  const full = /full (?:text|content|history)|complete (?:text|history)|全文|完整內容|完整内容|歷史紀錄|历史记录/i.test(
    prompt
  );
  const add = (identity: string, title: string, content: string, summary?: string, optional = false): void => {
    if (seen.has(identity)) return;
    seen.add(identity);
    const revision = livingSnapshotRevision(content);
    const scoped = !full && summary?.trim() && !isPlaceholder(summary) ? summary : content;
    const scope = scoped === content ? "full" : "summary";
    if (documents.length >= 100 || characters + scoped.length > 60_000) {
      if (!optional) throw new Error("living-node-context-too-large");
      // Do not grant a citation handle to context that the model never receives.
      warnings.push("map-source-budget-omitted: " + title);
      return;
    }
    characters += scoped.length;
    const evidenceId = "note:" + livingSnapshotRevision(identity + ":" + revision);
    reads.push({ id: identity, revision, scope });
    if (scoped.trim()) evidence.push({ id: evidenceId, source: title, retrievedAt: at });
    documents.push({ id: evidenceId, title, scope, text: scoped, revision });
  };
  // Own user material participates in the input revision independently from AI-generated records.
  add("self:" + id, snapshot.note.title, ownKnowledge(snapshot.note));
  for (const source of resolved.sources) {
    if (port.signal.aborted || !port.current()) throw new Error("cancelled");
    if (!allowedLivingNotePath(port.app, source.path)) throw new Error("unauthorized-source");
    if (source.cardId) {
      const data = await port.repo.readNoteSnapshot(source.path, map, port.noteReads);
      if (isAiCard(data.note) && !usableKnowledge(data)) throw new Error("missing-ai-knowledge");
      const knowledge = readLivingMarkdown(data.content);
      const current = knowledge.output.text || data.note.summary;
      const text = [ownKnowledge(data.note), JSON.stringify(knowledge)].filter(Boolean).join("\n\n");
      add(source.identity, data.note.title, text, current);
    } else {
      const file = port.app.vault.getAbstractFileByPath(source.path);
      if (!(file instanceof TFile) || !allowedLivingNotePath(port.app, file.path)) throw new Error("missing-source");
      const text = port.noteReads
        ? await readOnce(port.noteReads, file.path, () => port.app.vault.read(file))
        : await port.app.vault.read(file);
      add(source.identity, file.basename, readableMarkdown(text));
    }
  }
  const mapContext = await readLivingMapContext(port);
  if (mapContext.unavailable > 0) warnings.push("map-source-unavailable");
  for (const group of mapContext.groups) {
    for (const document of group.documents) {
      if (document.external) {
        // External paths require the existing scrubbed gateway identity, never a new direct file read.
        add(
          "map:" + (document.key ?? document.path),
          document.path,
          readableMarkdown(document.content),
          undefined,
          true
        );
        continue;
      }
      if (document.path === map.nodes.find(node => node.id === id)?.path) continue;
      if (!allowedLivingNotePath(port.app, document.path)) {
        warnings.push("map-source-unavailable");
        continue;
      }
      if (resolved.sources.some(source => source.path === document.path)) continue;
      add("map:" + document.path, document.path, readableMarkdown(document.content), undefined, true);
    }
  }
  const inputRevision = livingInputRevision({
    configRevision: configKey(snapshot, map, id, port),
    model: snapshot.note.model,
    language: port.language(map, snapshot.note),
    reads
  });
  return { base, evidence, reads, inputRevision, context: JSON.stringify({ documents, warnings }), prompt, warnings };
}

export async function runLivingRound(port: LivingRoundPort, requested?: readonly string[]) {
  const initialMap = await port.repo.readMap(port.mapPath);
  const { cards, snapshots } = await prepareMap(port, initialMap);
  const resolver = sourceResolver(port.app);
  // A card being tried out is held by a non-formal lease: it never runs here, and cannot be asked for directly.
  const trialIds = cards.filter(card => isAiCard(card) && !card.aiLocked && port.coordinator.trialBusy(card.path));
  if (requested?.some(id => trialIds.some(card => card.id === id))) throw new Error("living-node-trial-busy");
  const trialValidity = trialIds.length ? await inspectLivingValidity(port) : new Map<string, string>();
  const boundary = new Map(trialIds.map(card => [card.id, trialValidity.get(card.id) === "valid"] as const));
  const planCards = cards.map(card =>
    boundary.has(card.id) ? { ...card, aiLocked: true, hasKnowledge: boundary.get(card.id)! } : card
  );
  const { plan, sources } = planLivingMap(planCards, [], resolver, requested);
  if (!port.current() || port.signal.aborted) return undefined;
  if (trialIds.length) {
    for (const card of trialIds) if (!plan.lockedTargets.includes(card.id)) plan.lockedTargets.push(card.id);
    // Everything downstream of a trial card that cannot be used frozen is blocked, whatever the planner called it.
    const upstream = new Set([...boundary].filter(([, valid]) => !valid).map(([id]) => id));
    for (let grew = true; grew;) {
      grew = false;
      for (const id of plan.blocked.keys())
        if (
          !upstream.has(id) &&
          sources.get(id)?.sources.some(source => source.cardId && upstream.has(source.cardId))
        ) {
          upstream.add(id);
          grew = true;
        }
    }
    port.onTrialBoundary?.({
      skipped: trialIds.map(card => card.id),
      frozen: [...boundary].filter(([, valid]) => valid).map(([id]) => id),
      blocked: [...plan.blocked.keys()].filter(id => upstream.has(id))
    });
  }
  const paths = plan.order.map(item => cards.find(card => card.id === item.id)!.path);
  if (!paths.length && !plan.blocked.size && !plan.lockedTargets.length) return new Map<string, LivingSettlement>();
  const lease = port.coordinator.acquire(initialMap.id, port.viewSession, paths.length ? paths : [port.mapPath], true);
  if (!lease) throw new Error("living-node-busy");
  const stop = (): void => lease.stop();
  port.signal.addEventListener("abort", stop, { once: true });
  if (port.signal.aborted) stop();
  const current = (): boolean => lease.current() && port.current();
  const config = new Map<string, string>();
  for (const [id, snapshot] of snapshots) {
    try {
      config.set(id, configKey(snapshot, initialMap, id, port));
    } catch {
      // A damaged source configuration blocks its own branch, not unrelated cards.
    }
  }
  const pathOf = (id: string): string => initialMap.nodes.find(node => node.id === id)?.path ?? "";
  const checkCard = async (id: string) => {
    const map = await port.repo.readMap(port.mapPath);
    if (!current() || map.id !== initialMap.id) throw new Error("cancelled");
    const path = pathOf(id);
    const original = initialMap.nodes.find(node => node.id === id);
    if (
      !original ||
      !sameLivingTarget(
        original,
        map.nodes.find(node => node.id === id)
      )
    )
      throw new Error("changed-target-identity");
    const snapshot = await port.repo.readNoteSnapshot(path, map);
    const unchanged = config.get(id) === configKey(snapshot, map, id, port);
    return { map, snapshot, unchanged };
  };
  const read = async (id: string) => {
    const { map, snapshot, unchanged } = await checkCard(id);
    if (!unchanged || !isAiCard(snapshot.note) || snapshot.note.aiLocked) throw new Error("changed-configuration");
    const resolved = sources.get(id);
    if (!resolved) throw new Error("missing-source-plan");
    // Resolve the exact same references again; a replaced/renamed alias must not silently select a new file.
    const live = planLivingMap(
      map.nodes.map(node => ({
        ...node,
        prompt: node.id === id ? snapshot.note.prompt : "",
        aiCard: node.id === id,
        hasKnowledge: false,
        explicitRefs: node.id === id ? refs(snapshot) : []
      })),
      [],
      resolver,
      [id]
    ).sources.get(id);
    if (JSON.stringify(live) !== JSON.stringify(resolved)) throw new Error("changed-source-resolution");
    const input = await readInputs(port, map, id, snapshot, resolved);
    if (input.warnings.includes("map-source-unavailable")) port.onOptionalSourcesUnavailable?.();
    return { snapshot, input };
  };
  const cache = new Map<string, Awaited<ReturnType<typeof read>>>();
  try {
    if (!current()) return undefined;
    if (paths.some(path => port.busy(path))) throw new Error("living-node-busy");
    const models = [...new Set(plan.order.map(item => snapshots.get(item.id)?.note.model ?? "").filter(Boolean))];
    let results: Map<string, LivingSettlement> | undefined;
    const diagnostics: Promise<unknown>[] = [];
    const stamp = async (id: string, outcome: "failed" | "blocked"): Promise<void> => {
      if (!current()) return;
      try {
        const checked = await checkCard(id);
        const attempted = cache.get(id)?.snapshot.content;
        if (!checked.unchanged || checked.snapshot.note.aiLocked || !isAiCard(checked.snapshot.note)) return;
        if (attempted !== undefined && attempted !== checked.snapshot.content) return;
        // Do not overwrite the last surviving evidence of a damaged formal commit.
        // A failed diagnostic write must not turn corrupt ownership into a fresh card.
        readLivingMarkdown(checked.snapshot.content);
        await port.repo.updateNoteRawGuarded(
          pathOf(id),
          content =>
            setFrontmatterKeys(content, {
              "living-node-last-attempt": new Date().toISOString(),
              "living-node-outcome": outcome
            }),
          { expectedContent: checked.snapshot.content, authorize: current }
        );
      } catch {
        // A missing or edited target cannot safely accept a diagnostic write.
      }
    };
    const dispatch = async (): Promise<void> => {
      if (!current()) return;
      port.onStart(plan.order.length + plan.blocked.size + plan.lockedTargets.length);
      results = await executeLivingPlan(plan, {
        signal: lease.signal,
        inspect: async id => {
          if (!current()) return { current: false, locked: false, validity: "none" };
          // The trial card's formal knowledge is read as it stood when the run began.
          if (boundary.has(id)) return { current: true, locked: true, validity: boundary.get(id) ? "valid" : "none" };
          const checked = await checkCard(id);
          if (checked.snapshot.note.aiLocked)
            return {
              current: checked.unchanged,
              locked: true,
              validity: usableKnowledge(checked.snapshot) ? "stale" : "none"
            };
          if (!checked.unchanged) return { current: false, locked: false, validity: "stale" };
          const value = await read(id);
          cache.set(id, value);
          const fm = frontmatter(value.snapshot.content);
          const validity = !usableKnowledge(value.snapshot)
            ? "none"
            : value.input.base.revision === "empty"
              ? "stale"
              : fm["living-node-input-revision"] === value.input.inputRevision &&
                  fm["living-node-success-knowledge"] === value.input.base.revision
                ? "valid"
                : "stale";
          return { current: true, locked: false, validity };
        },
        execute: async (id, signal) => {
          port.onRunning(id);
          const value = cache.get(id);
          if (!value || !current() || port.busy(pathOf(id))) throw new Error("living-node-busy-or-stale");
          const { snapshot, input } = value;
          const legacy = livingLegacySuppressionIds(input.base);
          if (legacy.length) port.log?.("debug", "Living Node legacy id-only suppression: " + legacy.join(", "));
          const candidate = {
            executionId: randomUUID(),
            cardId: id,
            mapId: initialMap.id,
            viewSession: port.viewSession,
            baseRevision: livingSnapshotRevision(snapshot.content),
            inputRevision: input.inputRevision
          };
          try {
            const generated = await generateLivingProposal(
              port.calls,
              {
                model: snapshot.note.model,
                reasoning: snapshot.note.reasoning ?? "auto",
                language: port.language(initialMap, snapshot.note),
                prompt: input.prompt,
                base: input.base,
                context: input.context,
                evidence: input.evidence,
                mapPath: port.mapPath
              },
              signal
            );
            if (generated.droppedOperations) port.onOmittedEditsSkipped?.(id, generated.droppedOperations);
            if (generated.suppressedDropped) port.onSuppressedDropped?.(id, generated.suppressedDropped);
            const changes = applyLivingChanges(input.base, generated.proposal, generated.context);
            const outcome = await commitLivingMarkdown(port.repo, {
              path: pathOf(id),
              expectedContent: snapshot.content,
              candidate,
              base: input.base,
              proposal: generated.proposal,
              context: generated.context,
              signal,
              isCurrent: current,
              onCommit: (path, before, after) => port.onCommit?.(path, before, after),
              inspect: async () => {
                const live = await read(id);
                return {
                  ...candidate,
                  baseRevision: livingSnapshotRevision(live.snapshot.content),
                  inputRevision: live.input.inputRevision,
                  locked: !!live.snapshot.note.aiLocked,
                  aborted: signal.aborted || !current(),
                  dependenciesReady: true,
                  alreadyCommitted: false
                };
              }
            });
            if (outcome !== "written") throw new Error("stale-or-cancelled-write");
            // A successful storage result is final; a later read or refresh cannot turn it into a failed run.
            return changes.changed ? "changed" : "no-change";
          } catch (error) {
            port.onFailure(id, error);
            throw error;
          }
        },
        onSettled: (id, result) => {
          if (result === "failed" || result === "blocked") diagnostics.push(stamp(id, result));
          port.onSettled(id, result);
        }
      });
      await Promise.all(diagnostics);
      cache.clear();
    };
    const confirm = async (index: number): Promise<void> => {
      if (!current()) return;
      if (index >= models.length) await dispatch();
      else await port.confirm(models[index], () => confirm(index + 1));
    };
    await confirm(0);
    return results;
  } finally {
    port.signal.removeEventListener("abort", stop);
    lease.release();
  }
}

function resolveDraft(
  app: App,
  cards: readonly LivingMapCard[],
  target: LivingMapCard,
  prompt: string,
  saved: Snapshot,
  allowNewSource?: (path: string) => boolean
) {
  if (!splitPrompt(prompt).question.trim()) throw new Error("empty-prompt");
  const resolver = sourceResolver(app);
  const previousLinks = promptSourceLinks(saved.note.prompt);
  const nextLinks = promptSourceLinks(prompt);
  const raw = frontmatter(saved.content)["living-node-refs"];
  // A corrupt saved list can be repaired by explicitly removing all old
  // links, but an unchanged display alias must never rebind a lost identity.
  const persisted =
    raw === undefined || !nextLinks.some(link => previousLinks.includes(link))
      ? undefined
      : readLivingReferences(raw, previousLinks);
  const explicit = reconcileLivingDraftReferences(previousLinks, persisted, nextLinks, link => {
    const note = resolver.resolveAuthorized(link, target.path);
    if (!note) throw new Error("missing-source");
    // Choosing the link again is the user's explicit confirmation of an unresolved source.
    if (note.unresolved) {
      const file = app.vault.getAbstractFileByPath(note.path);
      if (file instanceof TFile) livingIdentityStore(app)?.reconfirm(file.path, file.stat);
    }
    if (allowNewSource && !allowNewSource(note.path)) throw new Error("unauthorized-source");
    if (note.path === target.path) throw new Error("self-reference");
    const matches = cards.filter(card => card.path === note.path);
    if (matches.length > 1) throw new Error("ambiguous-source");
    return matches.length === 1 ? { kind: "card", id: matches[0].id } : { kind: "note", link: note.path, exact: true };
  });
  // Keep one saved identity for each distinct display link. The resolver
  // deduplicates actual sources, while positional aliases remain editable.
  const encoded = explicit.map(ref =>
    ref.kind === "card" ? "card:" + ref.id : (ref.exact ? "note-path:" : "note:") + ref.link
  );
  const proposed = cards.map(card =>
    card.id === target.id ? { ...card, prompt, aiCard: true, explicitRefs: explicit, sourceUnavailable: false } : card
  );
  const next = planLivingMap(proposed, [], resolver);
  if (next.sources.get(target.id)?.failures.some(failure => failure.required)) throw new Error("invalid-source");
  if (introducesLivingCycle(cards, proposed, resolver) || next.plan.blocked.get(target.id) === "cycle")
    throw new Error("living-node-cycle");
  const sourceRevision = livingSnapshotRevision(
    JSON.stringify(
      (next.sources.get(target.id)?.sources ?? [])
        .filter(source => source.roles.includes("explicit"))
        .map(source => (source.cardId ? ["card", source.cardId] : ["note", source.identity, source.path]))
    )
  );
  return { encoded, proposed, sourceRevision };
}

export interface LivingConfigSave {
  outcome: "written" | "unchanged";
  before: string;
  after: string;
  configRevision: string;
  /** Exact resolved explicit source identities, kept only by the undo/redo entry. */
  sourceRevision: string;
}

/** Shared saved-configuration command: a stable same-map ID replaces the display link at the persistence boundary. */
export async function saveLivingConfig(
  app: App,
  repo: Repository,
  map: MapDocument,
  id: string,
  prompt: string,
  expectedPrompt?: string,
  expectedConfigRevision?: string,
  isCurrent: () => boolean = () => true,
  allowNewSource?: (path: string) => boolean,
  expectedSourceRevision?: string
): Promise<LivingConfigSave> {
  const authorized = (): boolean => !repo.isDisposed() && isCurrent();
  if (!authorized()) throw new Error("changed-configuration");
  const { snapshots, cards } = await prepareMap({ repo, app }, map);
  if (!authorized()) throw new Error("changed-configuration");
  const snapshot = snapshots.get(id);
  const target = cards.find(card => card.id === id);
  if (!snapshot || !target) throw new Error("missing-target");
  if (snapshot.note.aiLocked) throw new Error("locked-target");
  if (expectedPrompt !== undefined && snapshot.note.prompt !== expectedPrompt) throw new Error("changed-configuration");
  if (
    expectedConfigRevision !== undefined &&
    livingConfigurationStamp(snapshot.note.prompt, frontmatter(snapshot.content)) !== expectedConfigRevision
  )
    throw new Error("changed-configuration");
  const { encoded, sourceRevision } = resolveDraft(app, cards, target, prompt, snapshot, allowNewSource);
  if (expectedSourceRevision !== undefined && sourceRevision !== expectedSourceRevision)
    throw new Error("changed-source-identity");
  const fm = frontmatter(snapshot.content);
  if (
    snapshot.note.aiCard &&
    snapshot.note.prompt === prompt &&
    JSON.stringify(fm["living-node-refs"]) === JSON.stringify(encoded)
  )
    return {
      outcome: "unchanged",
      before: snapshot.content,
      after: snapshot.content,
      configRevision: livingConfigurationStamp(prompt, fm),
      sourceRevision
    };
  let saved = "";
  let savedRevision = "";
  const outcome = await repo.updateNoteGuarded(
    target.path,
    { prompt },
    {
      expectedContent: snapshot.content,
      authorize: authorized,
      finalize: content => {
        saved = setFrontmatterKeys(content, { "ai-card": true, "living-node-refs": encoded });
        const savedMetadata = frontmatter(saved);
        if (
          savedMetadata["ai-card"] !== true ||
          JSON.stringify(savedMetadata["living-node-refs"]) !== JSON.stringify(encoded)
        )
          return null;
        savedRevision = livingConfigurationStamp(prompt, savedMetadata);
        return saved;
      }
    }
  );
  if (outcome !== "written") throw new Error("changed-configuration");
  return {
    outcome,
    before: snapshot.content,
    after: saved,
    configRevision: savedRevision,
    sourceRevision
  };
}

/** Build a draft request without executing dependencies, and an adoption guard over the same effective inputs. */
export async function prepareLivingTrial(port: LivingTrialPort, id: string, prompt: string) {
  const initialMap = await port.repo.readMap(port.mapPath);
  const initial = await prepareMap(port, initialMap);
  const target = initial.cards.find(card => card.id === id);
  const original = initial.snapshots.get(id);
  if (!target || !original || original.note.aiLocked || !port.current()) throw new Error("missing-or-locked-target");
  const build = async (formal: boolean) => {
    const map = await port.repo.readMap(port.mapPath);
    if (!port.current() || map.id !== initialMap.id) throw new Error("cancelled");
    const { cards, snapshots } = await prepareMap(port, map);
    const saved = snapshots.get(id);
    const card = cards.find(item => item.id === id);
    if (!saved || !card || !sameLivingTarget(target, card) || saved.note.aiLocked) throw new Error("changed-target");
    const { encoded, proposed } = resolveDraft(port.app, cards, card, prompt, saved);
    const resolver = sourceResolver(port.app);
    const planned = planLivingMap(formal ? cards : proposed, [], resolver, [id]);
    const blocked = planned.plan.blocked.get(id);
    // A trial reads direct existing knowledge, never dispatches upstream. An
    // indirect failure may leave readable stale knowledge, but adoption still
    // requires the complete formal dependency graph to be ready.
    if (blocked && (formal || blocked !== "dependency-blocked")) throw new Error("required-dependency-blocked");
    const sources = planned.sources.get(id);
    if (!sources) throw new Error("missing-source-plan");
    const snapshot = formal
      ? saved
      : {
          note: { ...saved.note, prompt, aiCard: true as const },
          content: setFrontmatterKeys(saved.content, { "living-node-refs": encoded, "ai-card": true })
        };
    if (formal && (saved.note.prompt !== prompt || !isAiCard(saved.note))) throw new Error("draft-not-saved");
    let dependenciesReady = !blocked;
    let groups: Promise<LivingMapSources> | undefined;
    const readPort: LivingTrialPort = { ...port, mapSources: signal => (groups ??= port.mapSources(signal)) };
    if (dependenciesReady) {
      for (const item of planned.plan.order) {
        if (item.id === id) continue;
        if (!port.current() || port.signal.aborted) throw new Error("cancelled");
        const dependency = snapshots.get(item.id);
        const resolved = planned.sources.get(item.id);
        if (!dependency || !resolved) {
          dependenciesReady = false;
          break;
        }
        try {
          const data = await readInputs(readPort, map, item.id, dependency, resolved);
          const fm = frontmatter(dependency.content);
          if (
            data.base.revision === "empty" ||
            fm["living-node-input-revision"] !== data.inputRevision ||
            fm["living-node-success-knowledge"] !== data.base.revision
          ) {
            dependenciesReady = false;
            break;
          }
        } catch {
          dependenciesReady = false;
          break;
        }
      }
    }
    if (!port.current() || port.signal.aborted) throw new Error("cancelled");
    const frozen =
      planned.plan.frozen.length > 0 ||
      sources.sources.some(
        source => source.cardId && cards.some(card => card.id === source.cardId && isAiCard(card) && card.aiLocked)
      );
    const warnings = [
      ...(!dependenciesReady ? (["upstream-stale"] as const) : []),
      ...(frozen ? (["frozen-source"] as const) : [])
    ];
    const input = await readInputs(readPort, map, id, snapshot, sources, warnings);
    return { saved, snapshot, input, dependenciesReady, warnings: input.warnings };
  };
  const prepared = await build(false);
  const candidate = {
    executionId: randomUUID(),
    cardId: id,
    mapId: initialMap.id,
    viewSession: port.viewSession,
    baseRevision: livingSnapshotRevision(prepared.saved.content),
    inputRevision: prepared.input.inputRevision
  };
  const request: LivingTrialRequest = {
    path: target.path,
    expectedContent: prepared.saved.content,
    candidate,
    base: prepared.input.base,
    context: { at: new Date().toISOString(), evidence: prepared.input.evidence },
    generate: async signal => {
      const result = await generateLivingProposal(
        port.calls,
        {
          model: prepared.snapshot.note.model,
          reasoning: prepared.snapshot.note.reasoning ?? "auto",
          language: port.language(initialMap, prepared.snapshot.note),
          prompt: prepared.input.prompt,
          base: prepared.input.base,
          context: prepared.input.context,
          evidence: prepared.input.evidence,
          mapPath: port.mapPath
        },
        signal
      );
      if (result.droppedOperations) prepared.warnings.push("omitted-edits-skipped");
      if (result.suppressedDropped) prepared.warnings.push("suppressed-dropped:" + result.suppressedDropped);
      return result;
    },
    stillCurrent: async () => {
      const live = await build(false);
      return live.saved.content === prepared.saved.content && live.input.inputRevision === candidate.inputRevision;
    },
    generatedEvidence: true
  };
  const adoption: LivingAdoptionCheck = {
    isCurrent: () => port.current(),
    readSavedContent: async () => (await port.repo.readNoteSnapshot(target.path, initialMap)).content,
    inspect: async () => {
      const live = await build(true);
      return {
        ...candidate,
        baseRevision: livingSnapshotRevision(live.saved.content),
        inputRevision: live.input.inputRevision,
        locked: !!live.saved.note.aiLocked,
        aborted: !port.current(),
        dependenciesReady: live.dependenciesReady,
        alreadyCommitted: false
      };
    }
  };
  return { request, adoption, model: original.note.model, warnings: prepared.warnings };
}

/** Local validity inspection makes no AI calls. A stale upstream is derived, not persisted as a knowledge change. */
export async function inspectLivingValidity(port: LivingTrialPort) {
  const map = await port.repo.readMap(port.mapPath);
  // One pass reads each note once: the view's reads are reused, and every other read is shared across cards.
  const noteReads = port.noteReads ?? createNoteReadContext(map);
  const { snapshots, cards } = await prepareMap(port, map, noteReads);
  const planned = planLivingMap(cards, [], sourceResolver(port.app));
  const validity = new Map<string, "none" | "valid" | "stale">();
  for (const card of cards) {
    if (!isAiCard(card)) continue;
    if (card.aiLocked) validity.set(card.id, card.hasKnowledge ? "valid" : "none");
    else if (planned.plan.blocked.has(card.id)) validity.set(card.id, card.hasKnowledge ? "stale" : "none");
  }
  // Read the optional map context once, not once per card.
  let groups: Promise<LivingMapSources> | undefined;
  const readPort: LivingTrialPort = { ...port, noteReads, mapSources: signal => (groups ??= port.mapSources(signal)) };
  for (const item of planned.plan.order) {
    if (!port.current() || port.signal.aborted) break;
    const snapshot = snapshots.get(item.id);
    const resolved = planned.sources.get(item.id);
    if (!snapshot || !resolved) continue;
    try {
      const data = await readInputs(readPort, map, item.id, snapshot, resolved);
      const fm = frontmatter(snapshot.content);
      const hasKnowledge = usableKnowledge(snapshot);
      if (!hasKnowledge || data.base.revision === "empty") {
        validity.set(item.id, hasKnowledge ? "stale" : "none");
        continue;
      }
      const pending = (planned.plan.dependencies.get(item.id) ?? []).some(id => validity.get(id) !== "valid");
      validity.set(
        item.id,
        !pending &&
          fm["living-node-input-revision"] === data.inputRevision &&
          fm["living-node-success-knowledge"] === data.base.revision
          ? "valid"
          : "stale"
      );
    } catch {
      validity.set(item.id, cards.find(card => card.id === item.id)?.hasKnowledge ? "stale" : "none");
    }
  }
  return validity;
}
