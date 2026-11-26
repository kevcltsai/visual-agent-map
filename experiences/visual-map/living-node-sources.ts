export interface LivingSourceNode {
  id: string;
  path: string;
  parentId?: string | null;
}

export type LivingSourceRef = { kind: "card"; id: string } | { kind: "note"; link: string };
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
}

export interface LivingSourceFailure {
  ref: LivingSourceRef;
  reason: "missing-or-unauthorized" | "self-reference" | "ambiguous";
  required: boolean;
}

/** The Vault adapter must check authorization and provide a unique resolved file identity. */
export interface LivingSourcePort {
  resolveAuthorized(link: string, fromPath: string, role: "explicit" | "map"): LivingAuthorizedNote | undefined;
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
        const node = byId.get(ref.id);
        if (!node) fail(ref, "missing-or-unauthorized", role);
        else addCard(node, ref, role);
        return;
      }
      let note: LivingAuthorizedNote | undefined;
      try {
        note = port.resolveAuthorized(ref.link, target.path, role);
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
