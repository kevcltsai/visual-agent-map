import { randomUUID } from "node:crypto";
import { TFile, type App } from "obsidian";
import { isPlaceholder } from "../../core/note-placeholder";
import { decodeCalloutSections, removeSection } from "../../core/repository-note-body";
import { frontmatter, setFrontmatterKeys } from "../../core/repository-frontmatter";
import type { AiCalls } from "../../core/ai-calls";
import type { Repository, Note } from "../../repository";
import type { MapDocument } from "../../map-model";
import type { ReferenceGroup } from "../../ai/reference-materials";
import { isAiCard, promptSourceLinks, splitPrompt } from "./prompt-run";
import { planLivingMap, type LivingMapCard } from "./living-node-map";
import type { LivingSourceRef, resolveLivingSources } from "./living-node-sources";
import { LivingCoordinator } from "./living-node-coordinator";
import { executeLivingPlan, type LivingSettlement } from "./living-node-execution";
import {
  commitLivingMarkdown,
  livingSnapshotRevision,
  readLivingMarkdown
} from "./living-node-markdown";
import { livingConfigRevision, livingInputRevision, type LivingRead } from "./living-node-state";
import { generateLivingProposal } from "./living-node-provider";
import type { LivingAdoptionCheck, LivingTrialRequest } from "./living-node-trial";
import { applyLivingChanges, type LivingEvidence } from "./living-node-changes";

const coordinators = new WeakMap<object, LivingCoordinator>();
export function livingCoordinator(owner: object): LivingCoordinator {
  let coordinator = coordinators.get(owner);
  if (!coordinator) {
    coordinator = new LivingCoordinator();
    coordinators.set(owner, coordinator);
  }
  return coordinator;
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
  mapSources(signal: AbortSignal): Promise<ReferenceGroup[]>;
  confirm(model: string, run: () => Promise<void>): Promise<boolean>;
  onStart(total: number): void;
  onRunning(id: string): void;
  onSettled(id: string, result: LivingSettlement): void;
  onFailure(id: string, error: unknown): void;
  onCommit?(path: string, before: string, after: string): void;
}

type LivingTrialPort = Pick<
  LivingRoundPort,
  "app" | "repo" | "calls" | "mapPath" | "viewSession" | "signal" | "current" | "language" | "mapSources"
>;

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

function ownKnowledge(note: Note): string {
  return [note.title, note.thinkingOrigin, note.summary, note.preview, note.detail, note.newFindings]
    .filter(value => value && !isPlaceholder(value))
    .join("\n\n");
}

function usableKnowledge(snapshot: Snapshot): boolean {
  const base = readLivingMarkdown(snapshot.content);
  return !!base.output.text || base.records.length > 0 ||
    (base.revision === "empty" && snapshot.note.aiRun?.result === "ok" && !!ownKnowledge(snapshot.note));
}

function refs(snapshot: Snapshot): LivingSourceRef[] {
  const saved = frontmatter(snapshot.content)["living-node-refs"];
  if (Array.isArray(saved)) {
    return saved.map(value => {
      if (typeof value !== "string") throw new Error("invalid-source-reference");
      if (value.startsWith("card:")) return { kind: "card", id: value.slice(5) };
      if (value.startsWith("note:")) return { kind: "note", link: value.slice(5) };
      throw new Error("invalid-source-reference");
    });
  }
  return promptSourceLinks(snapshot.note.prompt).map(link => ({ kind: "note", link }));
}

function sourceResolver(app: App) {
  return {
    resolveAuthorized(link: string, fromPath: string) {
      const file = app.metadataCache.getFirstLinkpathDest(link, fromPath);
      return file instanceof TFile && file.extension.toLowerCase() === "md"
        ? { identity: file.path, path: file.path }
        : undefined;
    }
  };
}

function configKey(snapshot: Snapshot, map: MapDocument, id: string, port: Pick<LivingRoundPort, "language">): string {
  const node = map.nodes.find(item => item.id === id);
  if (!node) return "";
  const children = map.nodes.filter(item => item.parentId === id).map(item => item.id);
  return livingSnapshotRevision(
    JSON.stringify([
      livingConfigRevision(snapshot.note.prompt, refs(snapshot).map(ref => JSON.stringify(ref))),
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

async function prepareMap(port: Pick<LivingRoundPort, "repo">, map: MapDocument) {
  const snapshots = new Map<string, Snapshot>();
  const cards: LivingMapCard[] = [];
  for (const node of map.nodes) {
    let snapshot: Snapshot | undefined;
    try {
      snapshot = await port.repo.readNoteSnapshot(node.path, map);
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

/** A bounded context read. Revisions cover full readable content, even when only a summary is delivered. */
async function readInputs(
  port: LivingTrialPort,
  map: MapDocument,
  id: string,
  snapshot: Snapshot,
  resolved: ReturnType<typeof resolveLivingSources>
) {
  const base = readLivingMarkdown(snapshot.content);
  const reads: LivingRead[] = [];
  const evidence: LivingEvidence[] = [];
  const documents: { id: string; title: string; scope: string; text: string; revision: string }[] = [];
  const seen = new Set<string>();
  let characters = 0;
  const at = new Date().toISOString();
  const prompt = splitPrompt(snapshot.note.prompt).question;
  const full = /full (?:text|content|history)|complete (?:text|history)|全文|完整內容|完整内容|歷史紀錄|历史记录/i.test(prompt);
  const add = (identity: string, title: string, content: string, summary?: string): void => {
    if (seen.has(identity)) return;
    seen.add(identity);
    const revision = livingSnapshotRevision(content);
    const scoped = !full && summary?.trim() && !isPlaceholder(summary) ? summary : content;
    const scope = scoped === content ? "full" : "summary";
    characters += scoped.length;
    if (documents.length >= 100 || characters > 60_000) throw new Error("living-node-context-too-large");
    const evidenceId = "note:" + livingSnapshotRevision(identity + ":" + revision);
    reads.push({ id: identity, revision, scope });
    if (scoped.trim()) evidence.push({ id: evidenceId, source: title, retrievedAt: at });
    documents.push({ id: evidenceId, title, scope, text: scoped, revision });
  };
  // Own user material participates in the input revision independently from AI-generated records.
  add("self:" + id, snapshot.note.title, ownKnowledge(snapshot.note));
  for (const source of resolved.sources) {
    if (port.signal.aborted || !port.current()) throw new Error("cancelled");
    if (source.cardId) {
      const data = await port.repo.readNoteSnapshot(source.path, map);
      if (isAiCard(data.note) && !usableKnowledge(data)) throw new Error("missing-ai-knowledge");
      const knowledge = readLivingMarkdown(data.content);
      const current = knowledge.output.text || data.note.summary;
      const text = [ownKnowledge(data.note), JSON.stringify(knowledge)].filter(Boolean).join("\n\n");
      add(source.identity, data.note.title, text, current);
    } else {
      const file = port.app.vault.getAbstractFileByPath(source.path);
      if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") throw new Error("missing-source");
      add(source.identity, source.path, readableMarkdown(await port.app.vault.read(file)));
    }
  }
  const warnings = resolved.failures.filter(failure => !failure.required).map(failure => failure.reason);
  for (const group of await port.mapSources(port.signal)) {
    for (const document of group.documents) {
      if (document.external) {
        // External paths require the existing scrubbed gateway identity, never a new direct file read.
        add("map:" + (document.key ?? document.path), document.path, readableMarkdown(document.content));
        continue;
      }
      if (document.path === map.nodes.find(node => node.id === id)?.path) continue;
      if (resolved.sources.some(source => source.path === document.path)) continue;
      add("map:" + document.path, document.path, readableMarkdown(document.content));
    }
  }
  const inputRevision = livingInputRevision({
    configRevision: configKey(snapshot, map, id, port),
    model: snapshot.note.model,
    language: port.language(map, snapshot.note),
    reads
  });
  return { base, evidence, reads, inputRevision, context: JSON.stringify({ documents, warnings }), prompt };
}

export async function runLivingRound(port: LivingRoundPort, requested?: readonly string[]) {
  const initialMap = await port.repo.readMap(port.mapPath);
  const { cards, snapshots } = await prepareMap(port, initialMap);
  const resolver = sourceResolver(port.app);
  const { plan, sources } = planLivingMap(cards, [], resolver, requested);
  if (!port.current() || port.signal.aborted) return undefined;
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
    if (map.nodes.find(node => node.id === id)?.path !== path) throw new Error("changed-target-identity");
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
        await port.repo.updateNoteRawGuarded(pathOf(id), content => setFrontmatterKeys(content, {
          "living-node-last-attempt": new Date().toISOString(),
          "living-node-outcome": outcome
        }), { expectedContent: checked.snapshot.content, authorize: current });
      } catch {
        // A missing or edited target cannot safely accept a diagnostic write.
      }
    };
    const dispatch = async (): Promise<void> => {
      if (!current()) return;
      port.onStart(plan.order.length + plan.blocked.size);
      results = await executeLivingPlan(plan, {
        signal: lease.signal,
        inspect: async id => {
          if (!current()) return { current: false, locked: false, validity: "none" };
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
          const validity = value.input.base.revision === "empty"
            ? usableKnowledge(value.snapshot) ? "stale" : "none"
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
          const candidate = {
            executionId: randomUUID(),
            cardId: id,
            mapId: initialMap.id,
            viewSession: port.viewSession,
            baseRevision: livingSnapshotRevision(snapshot.content),
            inputRevision: input.inputRevision
          };
          try {
            const generated = await generateLivingProposal(port.calls, {
              model: snapshot.note.model,
              reasoning: snapshot.note.reasoning ?? "auto",
              language: port.language(initialMap, snapshot.note),
              prompt: input.prompt,
              base: input.base,
              context: input.context,
              evidence: input.evidence,
              mapPath: port.mapPath
            }, signal);
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
  prompt: string
) {
  if (!splitPrompt(prompt).question.trim()) throw new Error("empty-prompt");
  const resolver = sourceResolver(app);
  const explicit: LivingSourceRef[] = [];
  for (const link of promptSourceLinks(prompt)) {
    const note = resolver.resolveAuthorized(link, target.path);
    if (!note) throw new Error("missing-source");
    if (note.path === target.path) throw new Error("self-reference");
    const matches = cards.filter(card => card.path === note.path);
    if (matches.length > 1) throw new Error("ambiguous-source");
    explicit.push(matches.length === 1 ? { kind: "card", id: matches[0].id } : { kind: "note", link });
  }
  const encoded = [...new Set(explicit.map(ref => (ref.kind === "card" ? "card:" + ref.id : "note:" + ref.link)))];
  const proposed = cards.map(card =>
    card.id === target.id ? { ...card, prompt, aiCard: true, explicitRefs: explicit, sourceUnavailable: false } : card
  );
  const oldPlan = planLivingMap(cards, [], resolver).plan;
  const next = planLivingMap(proposed, [], resolver);
  if (next.sources.get(target.id)?.failures.some(failure => failure.required)) throw new Error("invalid-source");
  for (const [affected, reason] of next.plan.blocked) {
    if (reason === "cycle" && (affected === target.id || oldPlan.blocked.get(affected) !== "cycle"))
      throw new Error("living-node-cycle");
  }
  return { encoded, proposed };
}

export interface LivingConfigSave {
  outcome: "written" | "unchanged";
  before: string;
  after: string;
}

/** Shared saved-configuration command: a stable same-map ID replaces the display link at the persistence boundary. */
export async function saveLivingConfig(
  app: App,
  repo: Repository,
  map: MapDocument,
  id: string,
  prompt: string,
  expectedPrompt?: string
): Promise<LivingConfigSave> {
  const { snapshots, cards } = await prepareMap({ repo }, map);
  const snapshot = snapshots.get(id);
  const target = cards.find(card => card.id === id);
  if (!snapshot || !target) throw new Error("missing-target");
  if (snapshot.note.aiLocked) throw new Error("locked-target");
  if (expectedPrompt !== undefined && snapshot.note.prompt !== expectedPrompt) throw new Error("changed-configuration");
  const { encoded } = resolveDraft(app, cards, target, prompt);
  const fm = frontmatter(snapshot.content);
  if (
    snapshot.note.aiCard &&
    snapshot.note.prompt === prompt &&
    JSON.stringify(fm["living-node-refs"]) === JSON.stringify(encoded)
  )
    return { outcome: "unchanged", before: snapshot.content, after: snapshot.content };
  let saved = "";
  const outcome = await repo.updateNoteGuarded(
    target.path,
    { prompt },
    {
      expectedContent: snapshot.content,
      authorize: () => !repo.isDisposed(),
      finalize: content => {
        saved = setFrontmatterKeys(content, { "ai-card": true, "living-node-refs": encoded });
        return saved;
      }
    }
  );
  if (outcome !== "written") throw new Error("changed-configuration");
  return { outcome, before: snapshot.content, after: saved };
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
    if (!saved || !card || card.path !== target.path || saved.note.aiLocked) throw new Error("changed-target");
    const { encoded, proposed } = resolveDraft(port.app, cards, card, prompt);
    const resolver = sourceResolver(port.app);
    const planned = planLivingMap(formal ? cards : proposed, [], resolver, [id]);
    if (planned.plan.blocked.has(id)) throw new Error("required-dependency-blocked");
    const sources = planned.sources.get(id);
    if (!sources) throw new Error("missing-source-plan");
    const snapshot = formal
      ? saved
      : {
          note: { ...saved.note, prompt, aiCard: true as const },
          content: setFrontmatterKeys(saved.content, { "living-node-refs": encoded, "ai-card": true })
        };
    if (formal && (saved.note.prompt !== prompt || !isAiCard(saved.note))) throw new Error("draft-not-saved");
    const input = await readInputs(port, map, id, snapshot, sources);
    let dependenciesReady = true;
    if (formal) {
      for (const item of planned.plan.order) {
        if (item.id === id) continue;
        const dependency = snapshots.get(item.id);
        const resolved = planned.sources.get(item.id);
        if (!dependency || !resolved) {
          dependenciesReady = false;
          break;
        }
        const data = await readInputs(port, map, item.id, dependency, resolved);
        const fm = frontmatter(dependency.content);
        if (
          data.base.revision === "empty" ||
          fm["living-node-input-revision"] !== data.inputRevision ||
          fm["living-node-success-knowledge"] !== data.base.revision
        ) {
          dependenciesReady = false;
          break;
        }
      }
    }
    return { saved, snapshot, input, dependenciesReady };
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
      const result = await generateLivingProposal(port.calls, {
        model: prepared.snapshot.note.model,
        reasoning: prepared.snapshot.note.reasoning ?? "auto",
        language: port.language(initialMap, prepared.snapshot.note),
        prompt: prepared.input.prompt,
        base: prepared.input.base,
        context: prepared.input.context,
        evidence: prepared.input.evidence,
        mapPath: port.mapPath
      }, signal);
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
  return { request, adoption, model: original.note.model };
}
