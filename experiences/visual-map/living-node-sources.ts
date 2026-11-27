export interface LivingSourceNode {
  id: string;
  path: string;
  parentId?: string | null;
}

export type LivingSourceRef = { kind: "card"; id: string } | { kind: "note"; link: string; exact?: true };
/** Only an absent field denotes legacy data. Corrupt persisted identities must not be re-resolved by name. */
export function readLivingReferences(saved: unknown, legacyLinks: readonly string[]): LivingSourceRef[] {
  if (saved === undefined) return legacyLinks.map(link => ({ kind: "note", link }));
  // Early V1 drafts serialized an empty list as a bare YAML key (null). Accept it only
  // when the saved prompt also has no links; never use null to rebind existing references.
  if (saved === null && legacyLinks.length === 0) return [];
  if (!Array.isArray(saved)) throw new Error("invalid-source-reference");
  return saved.map(value => {
    if (typeof value !== "string") throw new Error("invalid-source-reference");
    if (value.startsWith("card:") && value.slice(5).trim()) return { kind: "card", id: value.slice(5) };
    if (value.startsWith("note-path:") && value.slice(10).trim())
      return { kind: "note", link: value.slice(10), exact: true };
    if (value.startsWith("note:") && value.slice(5).trim()) return { kind: "note", link: value.slice(5) };
    throw new Error("invalid-source-reference");
  });
}

/** A target moved while an execution or trial is outstanding is a different structural snapshot.
 * Parent is a runtime fence, not part of persistent input validity: moving alone does not change its knowledge.
 */
export function sameLivingTarget(before: LivingSourceNode, after: LivingSourceNode | undefined): boolean {
  return (
    !!after &&
    before.id === after.id &&
    before.path === after.path &&
    (before.parentId ?? null) === (after.parentId ?? null)
  );
}

/** Editing the question or reordering existing links cannot rebind a stored
 * card identity to a newly created note with the same display name. Only an
 * explicitly new link goes through Vault resolution. Legacy alias lists whose
 * deduplication cannot be reversed must be repaired explicitly. */
export function reconcileLivingDraftReferences(
  previousLinks: readonly string[],
  persisted: readonly LivingSourceRef[] | undefined,
  nextLinks: readonly string[],
  resolveNew: (link: string) => LivingSourceRef
): LivingSourceRef[] {
  if (!nextLinks.length) return [];
  if (!persisted) return nextLinks.map(resolveNew);
  if (JSON.stringify(previousLinks) === JSON.stringify(nextLinks)) return [...persisted];
  if (previousLinks.length !== persisted.length && nextLinks.some(link => previousLinks.includes(link)))
    throw new Error("ambiguous-saved-references");
  const previous = new Map(previousLinks.map((link, index) => [link, persisted[index]]));
  return nextLinks.map(link => previous.get(link) ?? resolveNew(link));
}

export type LivingSourceRole = "child" | "explicit" | "map";
export type LivingResolvedSource = {
  identity: string;
  path: string;
  cardId?: string;
  roles: LivingSourceRole[];
};

export interface LivingAuthorizedNote {
  identity: string;
  path: string;
  /** The file at this path is not provably the note that was bound: replaced, deleted-and-recreated or unverifiable. */
  unresolved?: true;
}

export interface LivingSourceFailure {
  ref: LivingSourceRef;
  reason: "missing-or-unauthorized" | "self-reference" | "ambiguous" | "source-replaced";
  required: boolean;
}

/** The Vault adapter must check authorization and provide a unique resolved file identity. */
export interface LivingSourcePort {
  resolveAuthorized(
    link: string,
    fromPath: string,
    role: "explicit" | "map",
    exact?: true
  ): LivingAuthorizedNote | undefined;
}

export function createLivingSourceResolver(nodes: readonly LivingSourceNode[], port: LivingSourcePort) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (byId.size !== nodes.length) throw new Error("ambiguous-card-identity");
  const byPath = new Map<string, LivingSourceNode[]>();
  const children = new Map<string, LivingSourceNode[]>();
  for (const node of nodes) {
    const list = byPath.get(node.path) ?? [];
    list.push(node);
    byPath.set(node.path, list);
    if (node.parentId != null) {
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
  }
  return (targetId: string, explicit: readonly LivingSourceRef[], mapLinks: readonly string[]) => {
    const target = byId.get(targetId);
    if (!target) throw new Error("missing-target");
    const sources = new Map<string, LivingResolvedSource>();
    const failures: LivingSourceFailure[] = [];
    const fail = (ref: LivingSourceRef, reason: LivingSourceFailure["reason"], role: LivingSourceRole): void => {
      failures.push({ ref, reason, required: role !== "map" });
    };
    const add = (source: LivingResolvedSource, ref: LivingSourceRef, role: LivingSourceRole): void => {
      const existing = sources.get(source.identity);
      if (existing) {
        if (existing.path !== source.path) fail(ref, "ambiguous", role);
        else if (!existing.roles.includes(role)) existing.roles.push(role);
      } else sources.set(source.identity, source);
    };
    const addCard = (node: LivingSourceNode, ref: LivingSourceRef, role: LivingSourceRole): void => {
      if (node.id === targetId || node.path === target.path) {
        fail(ref, "self-reference", role);
        return;
      }
      if ((byPath.get(node.path)?.length ?? 0) !== 1) {
        fail(ref, "ambiguous", role);
        return;
      }
      add({ identity: `card:${node.id}`, cardId: node.id, path: node.path, roles: [role] }, ref, role);
    };
    for (const child of children.get(targetId) ?? []) addCard(child, { kind: "card", id: child.id }, "child");
    const addRef = (ref: LivingSourceRef, role: "explicit" | "map"): void => {
      if (ref.kind === "card") {
        // Copies can retain a missing reference from another map for explicit
        // repair. It must never become executable even if a malformed map
        // happens to contain an identical string as a node ID.
        const node = ref.id.startsWith("foreign:") ? undefined : byId.get(ref.id);
        if (!node) fail(ref, "missing-or-unauthorized", role);
        else addCard(node, ref, role);
        return;
      }
      let note: LivingAuthorizedNote | undefined;
      try {
        note = port.resolveAuthorized(ref.link, target.path, role, ref.exact);
      } catch {
        fail(ref, "missing-or-unauthorized", role);
        return;
      }
      if (!note?.identity || !note.path) {
        fail(ref, "missing-or-unauthorized", role);
        return;
      }
      if (note.path === target.path) {
        fail(ref, "self-reference", role);
        return;
      }
      if (note.unresolved) {
        fail(ref, "source-replaced", role);
        return;
      }
      const sameMap = byPath.get(note.path) ?? [];
      if (sameMap.length > 1) {
        fail(ref, "ambiguous", role);
        return;
      }
      if (sameMap.length === 1) {
        addCard(sameMap[0], ref, role);
        return;
      }
      add({ identity: `note:${note.identity}`, path: note.path, roles: [role] }, ref, role);
    };
    for (const ref of explicit) addRef(ref, "explicit");
    for (const link of mapLinks) addRef({ kind: "note", link }, "map");
    const resolved = [...sources.values()];
    return {
      sources: resolved,
      failures,
      // Map-only references never form execution edges. The planner filters ordinary card IDs.
      dependencyIds: resolved.flatMap(source =>
        source.cardId && source.roles.some(role => role !== "map") ? [source.cardId] : []
      )
    };
  };
}

export function resolveLivingSources(
  nodes: readonly LivingSourceNode[],
  targetId: string,
  explicit: readonly LivingSourceRef[],
  mapLinks: readonly string[],
  port: LivingSourcePort
) {
  return createLivingSourceResolver(nodes, port)(targetId, explicit, mapLinks);
}

export type LivingIdentityState = "resolved" | "dangling" | "unknown";
/** Persisted association of one referenced note path with the file that was bound there. */
export interface LivingIdentityEntry {
  refId: string;
  path: string;
  ctime: number;
  size: number;
  state: LivingIdentityState;
  continuityGen: number;
}
export interface LivingFileStat {
  ctime: number;
  size: number;
}

const STATES: readonly string[] = ["resolved", "dangling", "unknown"];
function newRefId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** Corrupt entries are dropped (their reference then binds again as a first sight), never repaired by guessing. */
export function readLivingIdentityEntries(saved: unknown): LivingIdentityEntry[] {
  if (!Array.isArray(saved)) return [];
  const seen = new Set<string>();
  const result: LivingIdentityEntry[] = [];
  for (const item of saved) {
    const e = item as Partial<LivingIdentityEntry> | null;
    if (
      !e ||
      typeof e.refId !== "string" ||
      !e.refId ||
      typeof e.path !== "string" ||
      !e.path ||
      typeof e.ctime !== "number" ||
      typeof e.size !== "number" ||
      typeof e.state !== "string" ||
      !STATES.includes(e.state) ||
      typeof e.continuityGen !== "number" ||
      seen.has(e.path)
    )
      continue;
    seen.add(e.path);
    result.push({
      refId: e.refId,
      path: e.path,
      ctime: e.ctime,
      size: e.size,
      state: e.state,
      continuityGen: e.continuityGen
    });
  }
  return result;
}

/**
 * Identity state of the notes that cards reference, reduced from vault events as they happen. The state is persisted
 * as it is: it is never recomputed from the absence of events, so a lost or rolled-over log cannot turn an unresolved
 * source back into a resolved one. Only referenced paths are tracked and nothing is written into the source notes.
 */
export class LivingIdentityStore {
  private readonly byPath = new Map<string, LivingIdentityEntry>();

  constructor(
    saved?: unknown,
    private readonly changed: () => void = () => {},
    private readonly makeId: () => string = newRefId
  ) {
    for (const entry of readLivingIdentityEntries(saved)) this.byPath.set(entry.path, entry);
  }

  entries(): LivingIdentityEntry[] {
    return [...this.byPath.values()].map(entry => ({ ...entry }));
  }

  at(path: string): LivingIdentityEntry | undefined {
    const entry = this.byPath.get(path);
    return entry && { ...entry };
  }

  /** A reference is resolved for the first time (bind), or looked at again: a changed ctime means another file. */
  observe(path: string, stat: LivingFileStat): LivingIdentityEntry {
    const entry = this.byPath.get(path);
    if (!entry) {
      const fresh: LivingIdentityEntry = {
        refId: this.makeId(),
        path,
        ctime: stat.ctime,
        size: stat.size,
        state: "resolved",
        continuityGen: 0
      };
      this.byPath.set(path, fresh);
      this.changed();
      return { ...fresh };
    }
    if (entry.state === "resolved" && entry.ctime !== stat.ctime) {
      entry.state = "unknown";
      this.changed();
    }
    return { ...entry };
  }

  /** The same file moved: it keeps its identity at the new path. Whatever was recorded at the new path is another file. */
  renamed(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    const moving = this.byPath.get(oldPath);
    const occupant = this.byPath.get(newPath);
    if (!moving && !occupant) return;
    if (moving) this.byPath.delete(oldPath);
    if (occupant) {
      // Two bound files now claim one path: neither can be proven, so the reference needs explicit confirmation.
      this.byPath.set(newPath, {
        ...occupant,
        refId: this.makeId(),
        state: "unknown",
        continuityGen: occupant.continuityGen + 1
      });
    } else if (moving) {
      this.byPath.set(newPath, { ...moving, path: newPath, continuityGen: moving.continuityGen + 1 });
    }
    this.changed();
  }

  deleted(path: string): void {
    const entry = this.byPath.get(path);
    if (!entry || entry.state === "dangling") return;
    entry.state = "dangling";
    this.changed();
  }

  /** A file appeared at a referenced path. Only a deleted file that comes back with the same ctime and size is restored. */
  created(path: string, stat: LivingFileStat): void {
    const entry = this.byPath.get(path);
    if (!entry) return;
    if (entry.state === "dangling" && entry.ctime > 0 && entry.ctime === stat.ctime && entry.size === stat.size) {
      entry.state = "resolved";
      entry.continuityGen += 1;
    } else if (entry.state === "resolved") entry.state = "dangling";
    else return;
    this.changed();
  }

  /** A content edit keeps the identity; the recorded size follows it so a restart can still prove continuity. */
  modified(path: string, stat: LivingFileStat): void {
    const entry = this.byPath.get(path);
    if (!entry || entry.state !== "resolved" || entry.size === stat.size) return;
    if (entry.ctime !== stat.ctime) {
      entry.state = "unknown";
    } else entry.size = stat.size;
    this.changed();
  }

  /** After a restart a resolved reference stays resolved only if path, ctime and size all still match. */
  revalidate(statOf: (path: string) => LivingFileStat | undefined): void {
    let dirty = false;
    for (const entry of this.byPath.values()) {
      if (entry.state !== "resolved") continue;
      const stat = statOf(entry.path);
      if (stat && stat.ctime === entry.ctime && stat.size === entry.size) continue;
      entry.state = "unknown";
      dirty = true;
    }
    if (dirty) this.changed();
  }

  /** Only referenced paths keep a record. */
  prune(keep: ReadonlySet<string>): void {
    let dirty = false;
    for (const path of [...this.byPath.keys()])
      if (!keep.has(path)) {
        this.byPath.delete(path);
        dirty = true;
      }
    if (dirty) this.changed();
  }

  /** The user chose this file explicitly: a new identity, so consumers of the old one are recalculated. */
  reconfirm(path: string, stat: LivingFileStat): LivingIdentityEntry {
    const previous = this.byPath.get(path);
    if (previous?.state === "resolved" && previous.ctime === stat.ctime) return { ...previous };
    const entry: LivingIdentityEntry = {
      refId: this.makeId(),
      path,
      ctime: stat.ctime,
      size: stat.size,
      state: "resolved",
      continuityGen: (previous?.continuityGen ?? 0) + 1
    };
    this.byPath.set(path, entry);
    this.changed();
    return { ...entry };
  }
}

const stores = new WeakMap<object, LivingIdentityStore>();
export function setLivingIdentityStore(app: object, store: LivingIdentityStore | undefined): void {
  if (store) stores.set(app, store);
  else stores.delete(app);
}
export function livingIdentityStore(app: object): LivingIdentityStore | undefined {
  return stores.get(app);
}

/** The configuration identity of a reference: a bound note is its persisted id, so renaming the file does not change it. */
export function livingConfigRef(ref: LivingSourceRef, idOf: (path: string) => string | undefined): string {
  if (ref.kind === "note" && ref.exact) {
    const id = idOf(ref.link);
    if (id) return JSON.stringify({ kind: "note", id });
  }
  return JSON.stringify(ref);
}
