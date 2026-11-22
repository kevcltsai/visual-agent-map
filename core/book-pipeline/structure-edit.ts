// The editor's structure changes to the book (add, remove, merge, move, rename cards), checked and simulated on a plain tree before anything
// touches the map. Pure: model text is untrusted, so every title and reason is cleaned here and every op is checked one by one.
import { sanitizeGeneratedTitle } from "../title-safety";

export const MAX_STRUCTURE_OPS = 6;
export const MAX_STRUCTURE_ADDS = 3;
const MAX_TITLE = 80;
const MAX_REASON = 120;

type Base = { id: string; reason: string };
export type StructureOp =
  | (Base & { kind: "add"; title: string; summary: string; parent: string; after?: string; ref: string })
  | (Base & { kind: "remove"; card: string })
  | (Base & { kind: "merge"; card: string; into: string })
  | (Base & { kind: "move"; card: string; parent: string; after?: string })
  | (Base & { kind: "rename"; card: string; title: string });

export type StructureNode = { id: string; parentId: string | null; title: string };
/** `nodes` in reading order, root included. */
export type StructureInput = { rootId: string; nodes: readonly StructureNode[] };

export type RejectCode =
  | "unknown_card" | "root" | "locked" | "has_children" | "chapter_has_sections" | "depends_on_rejected" | "cycle" | "bad_title" | "bad_ref";

/** What the card looked like before an op: where it sat (parent and previous sibling) and its title. */
export type Before = { parent: string | null; after?: string; title: string; /** A merged card's summary when it was folded in (the target's plan reads it); set by the caller. */ summary?: string };
export type AppliedOp = { id: string; op: StructureOp; before: Before };
export type RejectedOp = { op: StructureOp; code: RejectCode };
export type SimulatedStructure = { applied: AppliedOp[]; rejected: RejectedOp[]; result: StructureNode[]; overCap?: true };

export type InverseOp =
  | { kind: "remove"; opId: string; card: string }
  | { kind: "restore"; opId: string; card: string; title: string; parent: string; after?: string }
  | { kind: "move"; opId: string; card: string; parent: string; after?: string }
  | { kind: "rename"; opId: string; card: string; title: string };

/** One line, no characters a file name or a `[[link]]` cannot carry, 1–80 long; undefined when nothing usable is left. */
export function cleanStructureTitle(text: string): string | undefined {
  const out = sanitizeGeneratedTitle(String(text ?? "")).replace(/\s+/g, " ").replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim();
  return out.length >= 1 && out.length <= MAX_TITLE ? out : undefined;
}

const cleanReason = (text: string): string => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_REASON);

class Tree {
  parent = new Map<string, string | null>();
  kids = new Map<string, string[]>();
  title = new Map<string, string>();
  constructor(readonly rootId: string, nodes: readonly StructureNode[]) {
    for (const n of nodes) { this.parent.set(n.id, n.parentId); this.title.set(n.id, n.title); this.kids.set(n.id, []); }
    for (const n of nodes) if (n.parentId !== null) this.kids.get(n.parentId)?.push(n.id);
  }
  has(id: string): boolean { return this.parent.has(id); }
  children(id: string): string[] { return this.kids.get(id) ?? []; }
  previousSibling(id: string): string | undefined {
    const list = this.children(this.parent.get(id) ?? "");
    const i = list.indexOf(id);
    return i > 0 ? list[i - 1] : undefined;
  }
  detach(id: string): void {
    const p = this.parent.get(id);
    if (p) { const list = this.kids.get(p) ?? []; const i = list.indexOf(id); if (i >= 0) list.splice(i, 1); }
  }
  attach(id: string, parent: string, after?: string): void {
    const list = this.kids.get(parent) ?? [];
    const i = after === undefined ? -1 : list.indexOf(after);
    list.splice(i + 1, 0, id);
    this.kids.set(parent, list);
    this.parent.set(id, parent);
  }
  add(id: string, title: string, parent: string, after?: string): void {
    this.title.set(id, title); this.kids.set(id, []); this.attach(id, parent, after);
  }
  drop(id: string): void { this.detach(id); this.parent.delete(id); this.kids.delete(id); this.title.delete(id); }
  isUnder(id: string, ancestor: string): boolean {
    for (let cur: string | null | undefined = id; cur; cur = this.parent.get(cur)) if (cur === ancestor) return true;
    return false;
  }
  hasLockedBelow(id: string, locked: ReadonlySet<string>): boolean {
    return this.children(id).some(c => locked.has(c) || this.hasLockedBelow(c, locked));
  }
  nodes(): StructureNode[] {
    const out: StructureNode[] = [];
    const walk = (id: string, parentId: string | null): void => {
      out.push({ id, parentId, title: this.title.get(id) ?? "" });
      for (const c of this.children(id)) walk(c, id);
    };
    walk(this.rootId, null);
    return out;
  }
}

const copyNodes = (nodes: readonly StructureNode[]): StructureNode[] => nodes.map(n => ({ ...n }));

export function simulateStructure(input: StructureInput, ops: readonly StructureOp[], locked: ReadonlySet<string>): SimulatedStructure {
  const original = copyNodes(input.nodes);
  const adds = ops.filter(o => o.kind === "add").length;
  if (ops.length > MAX_STRUCTURE_OPS || adds > MAX_STRUCTURE_ADDS) return { applied: [], rejected: [], result: original, overCap: true };

  const tree = new Tree(input.rootId, original);
  const applied: AppliedOp[] = [];
  const rejected: RejectedOp[] = [];
  const bad = new Set<string>(); // refs and cards a rejected op named: later ops that lean on them are dropped too
  const gone = new Set<string>();

  for (const raw of ops) {
    const op = { ...raw, reason: cleanReason(raw.reason) };
    const code = check(op);
    if (code) {
      rejected.push({ op, code });
      bad.add(op.kind === "add" ? op.ref : op.card);
      continue;
    }
    applied.push(apply(op));
  }
  return { applied, rejected, result: tree.nodes() };

  function refsOf(op: StructureOp): string[] {
    const list: string[] = [];
    if (op.kind !== "add") list.push(op.card);
    if (op.kind === "add" || op.kind === "move") list.push(op.parent);
    if (op.kind === "merge") list.push(op.into);
    if (op.kind === "add" || op.kind === "move") if (op.after !== undefined) list.push(op.after);
    return list;
  }

  function check(op: StructureOp): RejectCode | undefined {
    if (refsOf(op).some(r => bad.has(r))) return "depends_on_rejected";
    if (op.kind === "add") {
      if (!op.ref || tree.has(op.ref) || gone.has(op.ref)) return "bad_ref";
      if (cleanStructureTitle(op.title) === undefined) return "bad_title";
    }
    if (op.kind === "rename" && cleanStructureTitle(op.title) === undefined) return "bad_title";
    for (const r of refsOf(op)) if (!tree.has(r)) return "unknown_card";
    if (op.kind === "add") return placeProblem(op.parent, op.after);
    if (op.card === tree.rootId || (op.kind === "merge" && op.into === tree.rootId)) return "root";
    if (locked.has(op.card) || (op.kind === "merge" && locked.has(op.into))) return "locked";
    const isChapter = tree.parent.get(op.card) === tree.rootId;
    if (op.kind === "remove" || op.kind === "merge") {
      if (op.kind === "merge" && op.into === op.card) return "cycle";
      if (isChapter && tree.hasLockedBelow(op.card, locked)) return "locked";
      if (tree.children(op.card).length) return "has_children";
    }
    if (op.kind === "move") {
      if (isChapter && op.parent !== tree.rootId) {
        if (tree.hasLockedBelow(op.card, locked)) return "locked";
        if (tree.children(op.card).length) return "chapter_has_sections";
      }
      if (tree.isUnder(op.parent, op.card)) return "cycle";
      if (op.after === op.card) return "unknown_card";
      return placeProblem(op.parent, op.after);
    }
    return undefined;
  }

  function placeProblem(parent: string, after?: string): RejectCode | undefined {
    if (after !== undefined && tree.parent.get(after) !== parent) return "unknown_card";
    return undefined;
  }

  function apply(op: StructureOp): AppliedOp {
    if (op.kind === "add") {
      const title = cleanStructureTitle(op.title) as string;
      const clean = { ...op, title };
      tree.add(op.ref, title, op.parent, op.after);
      return { id: op.id, op: clean, before: { parent: null, title: "" } };
    }
    const before: Before = { parent: tree.parent.get(op.card) ?? null, after: tree.previousSibling(op.card), title: tree.title.get(op.card) ?? "" };
    if (op.kind === "remove" || op.kind === "merge") { tree.drop(op.card); gone.add(op.card); }
    else if (op.kind === "move") { tree.detach(op.card); tree.attach(op.card, op.parent, op.after); }
    else tree.title.set(op.card, cleanStructureTitle(op.title) as string);
    return { id: op.id, op: op.kind === "rename" ? { ...op, title: tree.title.get(op.card) as string } : op, before };
  }
}

/** The ids to undo when `opIds` are chosen: those, plus every later op that leans on what they made or changed. */
export function undoClosure(applied: readonly AppliedOp[], opIds: Iterable<string>): Set<string> {
  const picked = new Set(opIds);
  const touched = new Set<string>();
  const refsOf = (op: StructureOp): string[] => [
    ...(op.kind !== "add" ? [op.card] : []),
    ...(op.kind === "add" || op.kind === "move" ? [op.parent, ...(op.after !== undefined ? [op.after] : [])] : []),
    ...(op.kind === "merge" ? [op.into] : []),
  ];
  const nameOf = (op: StructureOp): string => (op.kind === "add" ? op.ref : op.card);
  for (const a of applied) if (picked.has(a.id)) touched.add(nameOf(a.op));
  let grew = true;
  while (grew) {
    grew = false;
    let seen = false;
    for (const a of applied) {
      if (picked.has(a.id)) { seen = true; continue; }
      if (seen && refsOf(a.op).some(r => touched.has(r))) { picked.add(a.id); touched.add(nameOf(a.op)); grew = true; }
    }
  }
  return new Set(applied.filter(a => picked.has(a.id)).map(a => a.id));
}

/** Operations that undo the chosen applied ops, last first. Give it a set from `undoClosure` so no later op is left leaning on one undone. */
export function inverseOps(applied: readonly AppliedOp[], ids: ReadonlySet<string>): InverseOp[] {
  const out: InverseOp[] = [];
  for (const a of [...applied].reverse()) {
    if (!ids.has(a.id)) continue;
    const { op, before } = a;
    if (op.kind === "add") out.push({ kind: "remove", opId: a.id, card: op.ref });
    else if (op.kind === "remove" || op.kind === "merge") out.push({ kind: "restore", opId: a.id, card: op.card, title: before.title, parent: before.parent ?? "", after: before.after });
    else if (op.kind === "move") out.push({ kind: "move", opId: a.id, card: op.card, parent: before.parent ?? "", after: before.after });
    else out.push({ kind: "rename", opId: a.id, card: op.card, title: before.title });
  }
  return out;
}

/** Plays inverse ops on a structure and returns the new structure. */
export function applyInverseOps(input: StructureInput, inverse: readonly InverseOp[]): StructureNode[] {
  const tree = new Tree(input.rootId, copyNodes(input.nodes));
  for (const op of inverse) {
    if (op.kind === "remove") tree.drop(op.card);
    else if (op.kind === "restore") tree.add(op.card, op.title, op.parent, op.after);
    else if (op.kind === "move") { tree.detach(op.card); tree.attach(op.card, op.parent, op.after); }
    else tree.title.set(op.card, op.title);
  }
  return tree.nodes();
}
