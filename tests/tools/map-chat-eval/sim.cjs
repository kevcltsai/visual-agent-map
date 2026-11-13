// A small in-memory map for long-conversation flows: it applies the parsed actions of each turn so the next turn is built from the
// map the earlier turns made, and the final map can be compared with the expected one.
//
// Evidence rule: a flow is evidence about the PRODUCT only for operations whose logic is the product's own code. These run through
// product functions loaded with load():
//   delete_topic    -> removeNodes (map-model.ts)        reorder_topics -> orderSiblings (map-layout.ts)
//   set_appearance  -> changeTopicMarkers (topic-markers.ts), changeTopicStyles (topic-colors.ts)
// Plain field writes (add_child, rename_topic, update_summary, rename_map, edit_topic_note) have no product logic beyond a field
// assignment. Everything else (move_topic, set_topic_kind, add/remove_relation, merge) is this file's own re-implementation: a flow
// that uses one is labelled "simulator-only" and kept out of the pass counts. Merge has no exported pure product function (it is
// view code, and a merge with content starts a background AI); other view-bound behaviour (selection after an add) is not modelled.
// Actions that need a real run (research, expand, synthesize, find_images, rate_by_goal) are recorded in `skipped`.
const { load } = require("../../support-replay.cjs");

let productFns = null;
function product() {
  if (!productFns) {
    productFns = {
      removeNodes: load("map-model.ts").removeNodes,
      orderSiblings: load("map-layout.ts").orderSiblings,
      changeTopicMarkers: load("topic-markers.ts").changeTopicMarkers,
      changeTopicStyles: load("topic-colors.ts").changeTopicStyles
    };
  }
  return productFns;
}

const PRODUCT_BACKED = new Set(["delete_topic", "reorder_topics", "set_appearance"]);
const SIMPLE_WRITE = new Set(["add_child", "rename_topic", "update_summary", "rename_map", "edit_topic_note"]);
const NO_EFFECT = new Set(["collapse_topic", "expand_topic", "focus_topic", "auto_layout", "select_topics", "ask_topic_kind", "create_map", "open_map", "create_md_file", "edit_md_file", "add_anchor", "link_anchor"]);

class SimMap {
  constructor(title, rows = []) {
    this.title = title;
    this.list = rows.map(([id, t, parentId]) => ({ id, title: t, summary: `${t} 的摘要`, parentId, kind: undefined, leaning: undefined, strength: undefined, color: undefined, markers: [], styles: [], detail: "" }));
    this.relations = [];
    this.skipped = [];
    this.opsUsed = new Set();
    this.selection = [];
    this.next = 1;
    this.titleHistory = new Map(this.list.map(n => [n.id, new Set([n.title])]));
  }
  get nodes() { return new Map(this.list.map(n => [n.id, n])); }
  children(id) { return this.list.filter(n => (n.parentId ?? null) === id); }
  /** Context input for the next turn: outline in tree order with depth, relations, selection, and the empty/name flags. */
  contextInput() {
    const out = [];
    const walk = (parent, depth) => this.children(parent).forEach(n => {
      out.push({ id: n.id, title: n.title, summary: n.summary, parentId: n.parentId, depth, ...(n.kind ? { kind: n.kind } : {}), ...(n.leaning ? { leaning: n.leaning } : {}), ...(n.strength ? { strength: n.strength } : {}), ...(n.color ? { color: n.color } : {}), ...(n.markers.length ? { markers: n.markers } : {}), ...(n.styles.length ? { styles: n.styles } : {}) });
      walk(n.id, depth + 1);
    });
    walk(null, 0);
    const ids = new Set(out.map(n => n.id));
    const selected = this.selection.filter(id => ids.has(id)).map(id => { const n = this.nodes.get(id); return { id, title: n.title, summary: n.summary, detail: n.detail, path: `Maps/Notes/${id}.md` }; });
    return { mapTitle: this.title, outline: out, relations: this.relations.map(r => ({ ...r })), emptyMap: out.length === 0, selected };
  }
  descendants(id) { return this.children(id).flatMap(c => [c.id, ...this.descendants(c.id)]); }

  /** Applies one parsed reply. */
  apply(actions) {
    const refs = new Map();
    const remember = () => this.list.forEach(n => { if (!this.titleHistory.has(n.id)) this.titleHistory.set(n.id, new Set()); this.titleHistory.get(n.id).add(n.title); });
    const resolve = id => (id && id.startsWith("new:") ? refs.get(id.slice(4)) : id);
    const get = id => this.list.find(n => n.id === id);
    for (const a of actions) {
      const node = a.nodeId ? get(resolve(a.nodeId)) : undefined;
      const op = a.kind === "run_map_action" ? `run:${a.action}` : a.kind;
      this.opsUsed.add(a.kind === "run_map_action" && a.action === "merge" ? "merge" : op);
      switch (a.kind) {
        case "add_child": {
          const id = `n${this.next++}`;
          if (a.ref) refs.set(a.ref, id);
          this.list.push({ id, title: a.title, summary: a.summary || "", parentId: a.parentId ? resolve(a.parentId) : null, kind: a.topicKind && a.topicKind !== "topic" ? a.topicKind : undefined, leaning: a.leaning, strength: a.strength, color: undefined, markers: [], styles: [], detail: "" });
          break;
        }
        case "rename_topic": if (node) node.title = a.title; break;
        case "update_summary": if (node) node.summary = a.summary; break;
        case "edit_topic_note": if (node) node.detail = a.detail; break;
        case "rename_map": this.title = a.title; break;
        case "move_topic": if (node) this.moveTo(node, resolve(a.newParentId), a.beforeId); break;
        case "reorder_topics": this.list = product().orderSiblings(this.list, resolve(a.parentId), a.nodeIds.map(resolve)); break;
        case "delete_topic": if (node) this.list = product().removeNodes(this.list, node.id, !!a.branch); break;
        case "select_topics": this.selection = a.all ? this.list.map(n => n.id) : a.nodeIds.map(resolve); break;
        case "set_topic_kind":
          a.nodeIds.map(resolve).forEach(id => {
            const n = get(id);
            if (!n) return;
            n.kind = a.topicKind === "topic" ? undefined : a.topicKind;
            if (a.topicKind === "hypothesis") { n.leaning = a.leaning || n.leaning || "undecided"; n.strength = a.strength || n.strength || "none"; } else { n.leaning = undefined; n.strength = undefined; }
          });
          break;
        case "set_appearance":
          a.nodeIds.map(resolve).forEach(id => {
            const n = get(id);
            if (!n) return;
            if (a.color) n.color = a.color === "none" ? undefined : a.color;
            n.markers = product().changeTopicMarkers(n.markers, a.markers || [], a.removeMarkers || []) || [];
            n.styles = product().changeTopicStyles(n.styles, a.formats || [], a.removeFormats || []) || [];
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
          if (a.action === "merge") this.merge(a.nodeIds.length ? a.nodeIds.map(resolve) : this.selection, a.title);
          else this.skipped.push(a.action);
          break;
        default: break;
      }
    }
    remember();
    const ids = new Set(this.list.map(n => n.id));
    this.relations = this.relations.filter(r => ids.has(r.from) && ids.has(r.to));
    this.selection = this.selection.filter(id => ids.has(id));
  }
  moveTo(node, parentId, beforeId) {
    if (parentId === node.id || this.descendants(node.id).includes(parentId)) return;
    node.parentId = parentId || null;
    this.list = this.list.filter(n => n !== node);
    const at = beforeId ? this.list.findIndex(n => n.id === beforeId) : -1;
    if (at >= 0) this.list.splice(at, 0, node); else this.list.push(node);
  }
  /** Own re-implementation (the product merge is view code): the first card keeps its id, takes the title, and inherits the others' children and relations. */
  merge(ids, title) {
    const sources = ids.map(id => this.list.find(n => n.id === id)).filter(Boolean);
    if (sources.length < 2 || !title) return;
    const [first, ...others] = sources;
    first.title = title;
    others.forEach(o => { this.children(o.id).forEach(c => (c.parentId = first.id)); });
    this.list = this.list.filter(n => !others.includes(n));
    this.relations = this.relations.map(r => ({ ...r, from: others.some(o => o.id === r.from) ? first.id : r.from, to: others.some(o => o.id === r.to) ? first.id : r.to })).filter(r => r.from !== r.to);
  }
  /** What each card looked like (id -> fields), to see which cards a turn changed. */
  state() {
    return new Map(this.list.map(n => [n.id, JSON.stringify([n.title, n.summary, n.parentId, n.kind, n.leaning, n.strength, n.color, n.markers, n.styles, n.detail])]));
  }
  /** Cards a turn changed: { changed: [title before], added: [title], removed: [title before] }. */
  diff(before, titlesBefore) {
    const after = this.state();
    const changed = [], added = [], removed = [];
    for (const [id, was] of before) { if (!after.has(id)) removed.push(titlesBefore.get(id)); else if (after.get(id) !== was) changed.push(titlesBefore.get(id)); }
    for (const id of after.keys()) if (!before.has(id)) added.push(this.list.find(n => n.id === id).title);
    return { changed, added, removed };
  }
  titles() { return new Map(this.list.map(n => [n.id, n.title])); }
  /** Ids that ever carried a title matching `re` and are still on the map. */
  survivors(re) {
    const alive = new Set(this.list.map(n => n.id));
    return [...this.titleHistory].filter(([id, set]) => alive.has(id) && [...set].some(t => re.test(t))).map(([id]) => this.list.find(n => n.id === id).title);
  }
  /** How much of what this map did is the product's own logic. */
  evidence() {
    const ops = [...this.opsUsed];
    const simOnly = ops.filter(o => !PRODUCT_BACKED.has(o) && !SIMPLE_WRITE.has(o) && !NO_EFFECT.has(o) && !o.startsWith("run:"));
    return { label: simOnly.length ? "simulator-only" : "product", productBacked: ops.filter(o => PRODUCT_BACKED.has(o)), simpleWrites: ops.filter(o => SIMPLE_WRITE.has(o)), simulatorOnly: simOnly };
  }
  /** The map as a nested structure of the fields a flow checks. */
  snapshot(parent = null) {
    return this.children(parent).map(n => ({ title: n.title, summary: n.summary, kind: n.kind, leaning: n.leaning, strength: n.strength, color: n.color, markers: n.markers, children: this.snapshot(n.id) }));
  }
}

/**
 * Compares a snapshot with an expected tree. spec = { t: RegExp (title), s?: RegExp (summary), kind?, leaning?, strength?, color?, marker?, c?: spec[] }.
 * Children match unordered and exactly: an expected child with no match, or a child nobody expected, is a mismatch. Omitting `c` means the card is a leaf (children are unexpected); `c: "any"` leaves them unchecked.
 */
function matchTreeDetailed(actual, expected, path = "") {
  const problems = [];
  const left = [...actual];
  for (const want of expected) {
    const at = left.findIndex(a => want.t.test(a.title) && ["kind", "leaning", "strength", "color"].every(k => want[k] === undefined || a[k] === want[k]) && (!want.s || want.s.test(a.summary)) && (!want.marker || a.markers.includes(want.marker)));
    if (at < 0) { problems.push({ type: "missing", path, text: `${path}/${want.t}: no match (have ${left.map(a => a.title).join("、") || "nothing"})` }); continue; }
    const [got] = left.splice(at, 1);
    // A spec without `c` is a LEAF: any child under it is unexpected. Say `c: "any"` to leave its children unchecked.
    if (want.c !== "any") problems.push(...matchTreeDetailed(got.children, want.c || [], `${path}/${got.title}`));
  }
  if (left.length) problems.push({ type: "unexpected", path: path || "/", text: `${path || "/"}: unexpected ${left.map(a => a.title).join("、")}`, titles: left.map(a => a.title) });
  return problems;
}
const matchTree = (actual, expected) => matchTreeDetailed(actual, expected).map(p => p.text);

module.exports = { SimMap, matchTree, matchTreeDetailed, PRODUCT_BACKED, SIMPLE_WRITE };
