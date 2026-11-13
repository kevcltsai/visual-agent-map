// A small in-memory map for long-conversation flows: it applies the parsed actions of each turn so the next turn is built
// from the map the earlier turns made, and the final map can be compared with the expected one. It models only the effects a
// flow can check (cards, parents, order, type, appearance, relations). Actions that need a real run (research, expand,
// synthesize, find_images, rate_by_goal) are recorded in `skipped` and change nothing, so flows avoid them.
class SimMap {
  constructor(title, rows = []) {
    this.title = title;
    this.nodes = new Map();
    this.relations = [];
    this.skipped = [];
    this.next = 1;
    rows.forEach(([id, t, parentId]) => this.nodes.set(id, { id, title: t, summary: `${t} 的摘要`, parentId, kind: undefined, leaning: undefined, strength: undefined, color: undefined, markers: [], styles: [], detail: "" }));
  }
  children(id) { return [...this.nodes.values()].filter(n => (n.parentId ?? null) === id); }
  /** Context input for the next turn: outline in tree order with depth, relations, and the empty/name flags. */
  contextInput() {
    const out = [];
    const walk = (parent, depth) => this.children(parent).forEach(n => {
      out.push({ id: n.id, title: n.title, summary: n.summary, parentId: n.parentId, depth, ...(n.kind ? { kind: n.kind } : {}), ...(n.leaning ? { leaning: n.leaning } : {}), ...(n.strength ? { strength: n.strength } : {}), ...(n.color ? { color: n.color } : {}), ...(n.markers.length ? { markers: n.markers } : {}), ...(n.styles.length ? { styles: n.styles } : {}) });
      walk(n.id, depth + 1);
    });
    walk(null, 0);
    return { mapTitle: this.title, outline: out, relations: this.relations.map(r => ({ ...r })), emptyMap: out.length === 0 };
  }
  descendants(id) { return this.children(id).flatMap(c => [c.id, ...this.descendants(c.id)]); }
  /** Applies one parsed reply. A deleted card with `branch` leaves with its subtree; without it the children move up to its parent. */
  apply(actions) {
    const refs = new Map();
    const resolve = id => (id && id.startsWith("new:") ? refs.get(id.slice(4)) : id);
    let selection = [];
    for (const a of actions) {
      const node = a.nodeId ? this.nodes.get(resolve(a.nodeId)) : undefined;
      switch (a.kind) {
        case "add_child": {
          const id = `n${this.next++}`;
          if (a.ref) refs.set(a.ref, id);
          this.nodes.set(id, { id, title: a.title, summary: a.summary || "", parentId: a.parentId ? resolve(a.parentId) : null, kind: a.topicKind && a.topicKind !== "topic" ? a.topicKind : undefined, leaning: a.leaning, strength: a.strength, color: undefined, markers: [], styles: [], detail: "" });
          break;
        }
        case "rename_topic": if (node) node.title = a.title; break;
        case "update_summary": if (node) node.summary = a.summary; break;
        case "edit_topic_note": if (node) node.detail = a.detail; break;
        case "rename_map": this.title = a.title; break;
        case "move_topic": if (node) this.moveTo(node, resolve(a.newParentId), a.beforeId); break;
        case "reorder_topics": this.reorder(resolve(a.parentId), a.nodeIds.map(resolve)); break;
        case "delete_topic": if (node) this.remove(node, a.branch); break;
        case "select_topics": selection = a.all ? [...this.nodes.keys()] : a.nodeIds.map(resolve); break;
        case "set_topic_kind":
          a.nodeIds.map(resolve).forEach(id => {
            const n = this.nodes.get(id);
            if (!n) return;
            n.kind = a.topicKind === "topic" ? undefined : a.topicKind;
            if (a.topicKind === "hypothesis") { n.leaning = a.leaning || n.leaning || "undecided"; n.strength = a.strength || n.strength || "none"; } else { n.leaning = undefined; n.strength = undefined; }
          });
          break;
        case "set_appearance":
          a.nodeIds.map(resolve).forEach(id => {
            const n = this.nodes.get(id);
            if (!n) return;
            if (a.color) n.color = a.color === "none" ? undefined : a.color;
            if (a.removeMarkers) n.markers = a.removeMarkers.includes("all") ? [] : n.markers.filter(m => !a.removeMarkers.includes(m));
            if (a.markers) n.markers = [...new Set([...n.markers, ...a.markers])];
            if (a.removeFormats) n.styles = a.removeFormats.includes("all") ? [] : n.styles.filter(m => !a.removeFormats.includes(m));
            if (a.formats) n.styles = [...new Set([...n.styles, ...a.formats])];
          });
          break;
        case "add_relation": {
          const from = resolve(a.fromId), to = resolve(a.toId);
          if (from && to && !this.relations.some(r => (r.from === from && r.to === to) || (r.from === to && r.to === from))) this.relations.push({ kind: a.relationKind, from, to, ...(a.description ? { description: a.description } : {}) });
          break;
        }
        case "remove_relation": {
          const from = resolve(a.fromId), to = resolve(a.toId);
          this.relations = this.relations.filter(r => !((r.from === from && r.to === to) || (r.from === to && r.to === from)));
          break;
        }
        case "run_map_action":
          if (a.action === "merge") this.merge(a.nodeIds.length ? a.nodeIds.map(resolve) : selection, a.title);
          else this.skipped.push(a.action);
          break;
        default: break; // view operations, files and maps change nothing a flow checks
      }
    }
    this.relations = this.relations.filter(r => this.nodes.has(r.from) && this.nodes.has(r.to));
  }
  moveTo(node, parentId, beforeId) {
    if (parentId === node.id || this.descendants(node.id).includes(parentId)) return;
    node.parentId = parentId || null;
    this.nodes.delete(node.id);
    const all = [...this.nodes.entries()];
    const at = beforeId ? all.findIndex(([id]) => id === beforeId) : -1;
    if (at >= 0) all.splice(at, 0, [node.id, node]); else all.push([node.id, node]);
    this.nodes = new Map(all);
  }
  reorder(parentId, ids) {
    const siblings = this.children(parentId);
    const ordered = ids.map(id => this.nodes.get(id)).filter(n => n && siblings.includes(n));
    const rest = siblings.filter(n => !ordered.includes(n));
    const keep = [...this.nodes.values()].filter(n => !siblings.includes(n));
    this.nodes = new Map([...keep, ...ordered, ...rest].map(n => [n.id, n]));
  }
  remove(node, branch) {
    if (branch) this.descendants(node.id).forEach(id => this.nodes.delete(id));
    else this.children(node.id).forEach(c => (c.parentId = node.parentId));
    this.nodes.delete(node.id);
  }
  merge(ids, title) {
    const sources = ids.map(id => this.nodes.get(id)).filter(Boolean);
    if (sources.length < 2 || !title) return;
    const [first, ...others] = sources;
    first.title = title;
    others.forEach(o => { this.children(o.id).forEach(c => (c.parentId = first.id)); this.nodes.delete(o.id); });
    this.relations = this.relations.map(r => ({ ...r, from: others.some(o => o.id === r.from) ? first.id : r.from, to: others.some(o => o.id === r.to) ? first.id : r.to })).filter(r => r.from !== r.to);
  }
  /** The map as a nested structure of the fields a flow checks. */
  snapshot(parent = null) {
    return this.children(parent).map(n => ({ title: n.title, summary: n.summary, kind: n.kind, leaning: n.leaning, strength: n.strength, color: n.color, markers: n.markers, children: this.snapshot(n.id) }));
  }
}

/**
 * Compares a snapshot with an expected tree. spec = { t: RegExp (title), s?: RegExp (summary), kind?, leaning?, strength?, color?, marker?, c?: spec[] }.
 * Children match unordered and exactly: an expected child with no match, or a child nobody expected, is a mismatch. Omitting `c` says nothing about children.
 */
function matchTree(actual, expected, path = "") {
  const problems = [];
  const left = [...actual];
  for (const want of expected) {
    const at = left.findIndex(a => want.t.test(a.title) && ["kind", "leaning", "strength", "color"].every(k => want[k] === undefined || a[k] === want[k]) && (!want.s || want.s.test(a.summary)) && (!want.marker || a.markers.includes(want.marker)));
    if (at < 0) { problems.push(`${path}/${want.t}: no match (have ${left.map(a => a.title).join("、") || "nothing"})`); continue; }
    const [got] = left.splice(at, 1);
    if (want.c) problems.push(...matchTree(got.children, want.c, `${path}/${got.title}`));
  }
  if (left.length) problems.push(`${path || "/"}: unexpected ${left.map(a => a.title).join("、")}`);
  return problems;
}

module.exports = { SimMap, matchTree };
