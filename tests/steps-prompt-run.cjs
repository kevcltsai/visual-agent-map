// Prompt topics and "run all" (V1): the pure planner (experiences/visual-map/prompt-run.ts), the `reuse-last-result` frontmatter key,
// and the view (confirm card, batch, stop, menus, arrows) with researchChild / integrateChildren / confirmAiUsage stubbed to count calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { core, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator, attachTopicRuns, startResearch, until } = S;
const { element, find, findAll } = dom;

const pr = S.load('experiences/visual-map/prompt-run.ts');
const values = S.load('note-values.ts');
// Values from the vm-loaded modules carry another realm's prototypes: compare them as JSON.
const eq = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual === undefined ? null : actual)), expected, message);
const MAP = 'Agent Workspace/Topics/map-a/Map.md';

// ---- the pure planner -------------------------------------------------------------------------------------------------
// root -> a (a1, a2), b ; c is a root of its own.
const nodes = [
  { id: 'root', parentId: null }, { id: 'a', parentId: 'root' }, { id: 'a1', parentId: 'a' }, { id: 'a2', parentId: 'a' }, { id: 'b', parentId: 'root' }, { id: 'c', parentId: null }
];
const P = (extra = {}) => ({ prompt: 'p', researchMode: 'local', ...extra });
const noteMap = spec => id => spec[id];
const all = () => noteMap({ root: P(), a: P(), a1: P(), a2: P({ researchMode: 'research' }), b: P({ researchMode: 'research' }), c: P() });
const ids = items => items.map(i => i.id);

test('plan: children before parents; a leaf researches, a topic with children integrates', () => {
  const plan = pr.planPromptRun(nodes, all(), null);
  eq(ids(plan.order), ['a1', 'a2', 'a', 'b', 'root', 'c']);
  eq(plan.order.map(i => i.kind), ['research', 'research', 'integrate', 'research', 'integrate', 'research']);
});

test('plan: counts X (run), Y (web leaves in Standard), Z (reuse or AI lock)', () => {
  const plan = pr.planPromptRun(nodes, noteMap({ root: P(), a: P({ reuseLastResult: true }), a1: P(), a2: P({ researchMode: 'research' }), b: P({ researchMode: 'research', aiLocked: true }), c: P({ researchMode: 'research' }) }), null);
  eq(plan.counts, { run: 4, web: 2, reuse: 2 });
  eq(ids(plan.run), ['a1', 'a2', 'root', 'c']);
  eq(ids(plan.reuse), ['a', 'b']);
  assert.equal(plan.order.find(i => i.id === 'a').action, 'reuse', 'a reused topic stays in the order');
  assert.equal(plan.order.find(i => i.id === 'b').web, false, 'a reused leaf does not search the web');
});

test('plan: an integrating topic never counts as web even when its saved mode is Standard', () => {
  const plan = pr.planPromptRun(nodes, noteMap({ root: P({ researchMode: 'research' }), a: P(), a1: P(), a2: P(), b: P() }), null);
  assert.equal(plan.counts.web, 0);
});

test('plan: a subtree scope runs only that branch; an unknown scope runs nothing', () => {
  eq(ids(pr.planPromptRun(nodes, all(), 'a').order), ['a1', 'a2', 'a']);
  eq(pr.planPromptRun(nodes, all(), 'zzz').order, []);
});

test('plan: an empty Prompt topic is not in the order; its Prompt children still are', () => {
  const plan = pr.planPromptRun(nodes, noteMap({ root: P(), a: P({ prompt: '  ' }), a1: P(), a2: P(), b: P() }), null);
  eq(ids(plan.order), ['a1', 'a2', 'b', 'root']);
  assert.equal(pr.isPromptTopic(P({ prompt: '\n ' })), false);
  assert.equal(pr.isPromptTopic(undefined), false);
});

test('plan: a note that is not loaded is skipped; a parent cycle is walked once', () => {
  eq(ids(pr.planPromptRun(nodes, noteMap({ root: P(), a: P() }), null).order), ['a', 'root']);
  const loop = [{ id: 'x', parentId: 'y' }, { id: 'y', parentId: 'x' }];
  assert.doesNotThrow(() => pr.planPromptRun(loop, noteMap({ x: P(), y: P() }), 'x'));
});

test('hasPromptTopic / isPromptEdge', () => {
  assert.equal(pr.hasPromptTopic(nodes, noteMap({ a: P({ prompt: '' }) })), false);
  assert.equal(pr.hasPromptTopic(nodes, noteMap({ a: P() })), true);
  assert.equal(pr.isPromptEdge(all(), 'root', 'a'), true);
  assert.equal(pr.isPromptEdge(noteMap({ root: P(), a: P({ prompt: '' }) }), 'root', 'a'), false);
});

test('promptSourceLinks: only the source line; alias and heading forms; URL and plain names are skipped; duplicates dropped', () => {
  const prompt = ['Compare [[Not a source]]', '資料來源：[[A]]、[[B|alias]] [[C#Heading]] https://example.com [[A]]', '> sources: [[D]]', 'Sources：Plain name', '数据来源: [[E]]'].join('\n');
  eq(pr.promptSourceLinks(prompt), ['A', 'B', 'C', 'D', 'E']);
  eq(pr.promptSourceLinks('資料來源：https://example.com/x'), []);
  eq(pr.promptSourceLinks(''), []);
});

test('readPromptSources: a link that does not resolve or whose read throws is skipped; the limit holds; nothing is fetched', async () => {
  const seen = [];
  const read = async link => { seen.push(link); if (link === 'Missing') return null; if (link === 'Boom') throw new Error('x'); return { link }; };
  const docs = await pr.readPromptSources('資料來源：[[Missing]] [[Boom]] [[A]] [[B]] [[C]] https://e.com', read, 2);
  eq(docs, [{ link: 'A' }, { link: 'B' }]);
  eq(seen, ['Missing', 'Boom', 'A', 'B'], 'stops reading at the limit');
});

test('blockingChildren: only Prompt, not reused, not locked children that are bad block; empty-Prompt and reused children never do', () => {
  const spec = noteMap({ root: P(), a: P(), b: P({ reuseLastResult: true }), a1: P({ prompt: '' }), c: P({ aiLocked: true }) });
  const kids = [{ id: 'root', parentId: null }, { id: 'a', parentId: 'root' }, { id: 'b', parentId: 'root' }, { id: 'a1', parentId: 'root' }, { id: 'c', parentId: 'root' }];
  eq(pr.blockingChildren(kids, spec, 'root', () => true), ['a']);
  eq(pr.blockingChildren(kids, spec, 'root', () => false), []);
});

test('staleAncestors: the unbroken Prompt chain upward; stops at an empty Prompt; a cycle ends', () => {
  eq(pr.staleAncestors(nodes, all(), 'a1'), ['a', 'root']);
  eq(pr.staleAncestors(nodes, noteMap({ root: P(), a: P({ prompt: '' }), a1: P() }), 'a1'), [], 'the empty Prompt stops the chain');
  eq(pr.staleAncestors([{ id: 'x', parentId: 'y' }, { id: 'y', parentId: 'x' }], noteMap({ x: P(), y: P() }), 'x'), ['y']);
});

const items = (plan) => plan.order;
test('runPromptItems: post-order calls, statuses, outcome counts; a failing child blocks its parents without an AI call', async () => {
  const plan = pr.planPromptRun(nodes, all(), null);
  const statuses = new Map(), ran = [];
  const outcome = await pr.runPromptItems(items(plan), null, {
    nodes, noteOf: all(), signal: new AbortController().signal, isBad: id => statuses.get(id)?.status === 'blocked',
    setStatus: (id, status, reason) => statuses.set(id, { status, reason }), titleOf: id => id.toUpperCase(), blockedReason: t => `below: ${t}`,
    runItem: async item => { ran.push(item.id); if (item.id === 'a1') throw new Error('boom'); }
  });
  eq(ran, ['a1', 'a2', 'b', 'c'], 'a and root were not run');
  assert.equal(statuses.get('a').status, 'blocked'); assert.equal(statuses.get('a').reason, 'below: A1');
  assert.equal(statuses.get('root').status, 'blocked', 'the grandparent is stuck too');
  assert.match(statuses.get('a1').reason, /boom/);
  eq(outcome, { done: 3, failed: 1, blocked: 2, stopped: false });
});

test('runPromptItems: Stop returns the running topic to idle and starts nothing new', async () => {
  const plan = pr.planPromptRun(nodes, all(), null);
  const controller = new AbortController(), statuses = new Map(), ran = [];
  const outcome = await pr.runPromptItems(items(plan), null, {
    nodes, noteOf: all(), signal: controller.signal, isBad: () => false, setStatus: (id, status) => statuses.set(id, status), titleOf: String, blockedReason: String,
    runItem: async item => { ran.push(item.id); if (item.id === 'a2') controller.abort(); }
  });
  eq(ran, ['a1', 'a2']);
  assert.equal(statuses.get('a2'), 'idle'); assert.equal(statuses.get('a1'), 'done');
  for (const id of ['a', 'b', 'root', 'c']) assert.equal(statuses.get(id), 'idle', id);
  assert.equal(outcome.stopped, true);
});

test('runPromptItems: a written scope marks its Prompt ancestors stale; "only this one" (no blocking check) reads children as they are', async () => {
  const statuses = new Map(), ran = [];
  const one = [{ id: 'a', kind: 'integrate', action: 'run', web: false }];
  const outcome = await pr.runPromptItems(one, 'a', {
    nodes, noteOf: all(), signal: new AbortController().signal, isBad: () => true, setStatus: (id, status) => statuses.set(id, status), titleOf: String, blockedReason: String,
    runItem: async item => { ran.push(item.id); }
  }, false);
  eq(ran, ['a']);
  assert.equal(statuses.get('root'), 'stale');
  assert.equal(outcome.done, 1);
  assert.equal(statuses.has('a1'), false);
});

// ---- the harness ------------------------------------------------------------------------------------------------------
// spec: [key, parentKey|null, { prompt, mode, reuse, locked }]
async function harness(spec, { confirm = true } = {}) {
  const { repo, app, contents } = fixture('en');
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a');
  await app.vault.create(MAP, core.serializeMap(mapDoc));
  const byKey = new Map();
  for (const [key, parent, opt = {}] of spec) {
    const created = await repo.createNote(key, 'gpt-6-luna', mapDoc, MAP, 'workspace');
    if (parent) created.parentId = byKey.get(parent).id;
    Object.assign(created, { x: byKey.size * 400, y: 0 });
    mapDoc.nodes.push(created);
    byKey.set(key, created);
    const prompt = opt.prompt === undefined ? `Prompt ${key}` : opt.prompt;
    await repo.updateNote(created.path, { prompt, ...(opt.mode ? { researchMode: opt.mode } : {}) });
    if (opt.reuse) await repo.writeReuseLastResult(created.path, true);
    if (opt.locked) await repo.writeAiLocked(created.path, true);
  }
  await repo.saveMap(MAP, mapDoc);
  const notices = [], menus = [], modals = [], calls = [], usage = [];
  let gate = null;
  const host = withExpansionCoordinator({
    repo, settings: { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna', cliReasoning: 'low' }, running: new Set(), logs: { appendLog() {} },
    pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, relevanceGrades: new Map(), expansionBatches: new Map(),
    recordFailure: (_l, e) => String(e?.message ?? e), views: () => [], mutate: async work => work(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    confirmAiUsage: async (model, run) => { usage.push(model); if (!confirm) return false; await run(); return true; },
    askModel: async (_c, _m, _r, signal, _x, accepted) => {
      accepted?.();
      if (gate) await new Promise((resolve, reject) => { gate.push(resolve); signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))); });
      return { summary: 's', detail: 'd', visualReferences: [], suggestions: [] };
    }
  });
  repo.settings = host.settings;
  class Menu {
    constructor() { this.items = []; menus.push(this); }
    addItem(cb) { const item = { title: '', checked: undefined, click: null }; cb({ setTitle(v) { item.title = v; return this; }, setIcon() { return this; }, setChecked(v) { item.checked = v; return this; }, onClick(fn) { item.click = fn; return this; }, setWarning() { return this; } }); this.items.push(item); return this; }
    addSeparator() { this.items.push({ separator: true }); return this; } showAtMouseEvent() { return this; } showAtPosition() { return this; }
  }
  const Modal = dom.makeModal();
  const { VisualAgentMapView } = S.load('main.ts', { obsidian: { ...obsidian, Notice: dom.makeNotice(notices), Modal, Menu } }, { createFragment: dom.createFragment, CSS: { escape: v => v }, createSvg: dom.createSvg, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  const view = new VisualAgentMapView({ app }, attachTopicRuns(host));
  view.armHighlightFade = () => {};
  const hydrate = async () => { view.notes = new Map(await Promise.all(mapDoc.nodes.map(async n => [n.id, await repo.readNote(n.path, mapDoc)]))); };
  Object.assign(view, { path: MAP, map: mapDoc, contentEl: element('div'), stageEl: element('div'), render() {}, hydrate, ancestorContext: async () => '', queueCharts() {}, focusNode() {}, openDetails() {} });
  view.viewportEl = element('div');
  view.viewportEl.getBoundingClientRect = () => ({ left: 10, top: 5, right: 810, bottom: 605, width: 800, height: 600 });
  view.viewportEl.clientWidth = 800; view.viewportEl.clientHeight = 600;
  await hydrate();
  // The two AI paths are stubbed: they count calls and write the summary the way the real ones do.
  const plan = { fail: new Set(), hang: new Set() };
  const gateFor = async (key, signal) => {
    if (!plan.hang.has(key)) return;
    await new Promise(resolve => { signal.addEventListener('abort', resolve); });
  };
  const keyOf = node => spec.find(([k]) => byKey.get(k).id === node.id)[0];
  view.researchChild = async (node, signal, accepted, choices, charts, _r, _g, languageSource) => {
    const key = keyOf(node);
    calls.push({ kind: 'research', key, choices, charts });
    await gateFor(key, signal);
    if (signal.aborted) return;
    if (plan.fail.has(key)) throw new Error(`research failed: ${key}`);
    await repo.updateNote(node.path, { summary: `R:${key}`, detail: `D:${key}` });
  };
  view.integrateChildren = async (node, options, direction, drafted, failed) => {
    const key = keyOf(node);
    calls.push({ kind: 'integrate', key, options, direction });
    await gateFor(key, options.signal);
    if (options.signal.aborted) return;
    if (plan.fail.has(key)) { failed(`integrate failed: ${key}`); return; }
    await drafted({}, async (summary, detail) => { await repo.updateNote(node.path, { summary, detail }); }, `I:${key}`, `ID:${key}`);
  };
  const raw = key => contents.get(byKey.get(key).path);
  const node = key => byKey.get(key);
  const status = key => view.promptRuns.get(MAP)?.get(node(key).id)?.status;
  const done = () => until(() => view.promptBatch?.outcome);
  // Confirm card: start, then press the card's start button.
  const runAll = async (scopeId = null) => {
    view.startPromptRun(scopeId);
    const modal = modals.at(-1);
    if (!modal) return null;
    find(modal.modalEl, i => i.tag === 'button' && i.cls.includes('mod-cta')).click();
    return modal;
  };
  const origOpen = Modal.prototype.open;
  Modal.prototype.open = function () { modals.push(this); return origOpen.call(this); };
  return { hold: () => (gate = []), repo, app, contents, view, host, calls, notices, menus, modals, usage, plan, raw, node, status, done, runAll, hydrate, mapDoc, byKey };
}

// root -> mid -> leaf1, leaf2 (Standard) ; root -> side
const TREE = [['root', null], ['mid', 'root'], ['leaf1', 'mid'], ['leaf2', 'mid', { mode: 'research' }], ['side', 'root']];

test('reuse key: reader accepts only true; writer adds and removes the key, `updated` unchanged, byte round trip', async () => {
  for (const v of [undefined, false, 'true', 1, null]) assert.equal(values.readReuseLastResult({ 'reuse-last-result': v }), false, String(v));
  assert.equal(values.readReuseLastResult({ 'reuse-last-result': true }), true);
  const h = await harness([['A', null]]);
  const before = h.raw('A');
  assert.equal((await h.repo.readNote(h.node('A').path)).reuseLastResult, undefined);
  await h.repo.writeReuseLastResult(h.node('A').path, true);
  assert.match(h.raw('A'), /^reuse-last-result: true$/m);
  assert.equal((await h.repo.readNote(h.node('A').path)).reuseLastResult, true);
  assert.equal(h.raw('A').match(/^updated:.*$/m)?.[0], before.match(/^updated:.*$/m)?.[0], 'updated is not bumped');
  assert.equal(h.raw('A').replace(/^reuse-last-result: true\n/m, ''), before, 'no other byte changes');
  const on = h.raw('A');
  await h.repo.writeReuseLastResult(h.node('A').path, true);
  assert.equal(h.raw('A'), on, 'already on: byte for byte');
  await h.repo.writeReuseLastResult(h.node('A').path, false);
  assert.equal(h.raw('A'), before, 'off removes the key and restores the note');
});

test('counter-example 9: the switch is one undo step; undo restores the frontmatter and `updated`', async () => {
  const h = await harness([['A', null]]);
  const before = h.raw('A');
  const past = h.view.history.past.length;
  await h.view.setReuseLastResult(h.node('A'), true);
  assert.equal(h.view.history.past.length, past + 1);
  assert.equal(h.view.notes.get(h.node('A').id).reuseLastResult, true);
  assert.equal(h.raw('A').match(/^updated:.*$/m)[0], before.match(/^updated:.*$/m)[0]);
  await h.view.setReuseLastResult(h.node('A'), true);
  assert.equal(h.view.history.past.length, past + 1, 'already on: no new step');
  await h.view.travel(false);
  assert.equal(h.raw('A'), before, 'undo: byte for byte');
});

// ---- run all ----------------------------------------------------------------------------------------------------------
test('run all: confirm card lists the order and counts; Start runs leaves to root, one AI call each, no charts', async () => {
  const h = await harness(TREE.map(([k, p, o]) => k === 'side' ? [k, p, { reuse: true }] : [k, p, o]));
  const modal = await h.runAll();
  assert.equal(h.calls.length, 0, 'nothing runs before Start');
  const rows = findAll(modal.contentEl, i => i.cls?.includes('vam-prompt-run-item')).map(r => r.children.map(c => c.text).join(''));
  assert.equal(rows.length, 5);
  assert.match(rows[0], /leaf1.*Quick/); assert.match(rows[1], /leaf2.*Standard/); assert.match(rows[2], /mid.*Integrate/); assert.match(rows[3], /side.*Reuses/); assert.match(rows[4], /root.*Integrate/);
  const estimate = find(modal.contentEl, i => i.cls?.includes('vam-prompt-run-estimate')).text;
  assert.match(estimate, /\b4\b[^0-9]+\b1\b[^0-9]+\b1\b/, estimate);
  const start = find(modal.modalEl, i => i.cls?.includes('mod-cta'));
  assert.match(start.text, /\b4\b/);
  await h.done();
  eq(h.calls.map(c => `${c.kind}:${c.key}`), ['research:leaf1', 'research:leaf2', 'integrate:mid', 'integrate:root']);
  assert.equal(h.calls[0].charts, false, 'research charts off');
  assert.equal(h.calls[2].options.skipCharts, true);
  assert.equal(h.calls[2].options.synthesisContent, 'summary');
  assert.equal(h.calls[2].options.researchMode, 'local');
  assert.match(h.calls[2].direction, /^Prompt mid\n\n.*organise/s, 'the note Prompt then the default instruction');
  eq(h.view.promptBatch.outcome, { done: 4, failed: 0, blocked: 0, stopped: false });
  for (const k of ['leaf1', 'leaf2', 'mid', 'root']) assert.equal(h.status(k), 'done', k);
  assert.equal(h.status('side'), undefined, 'a reused topic is not run and gets no run state');
  assert.match(h.raw('root'), /I:root/);
});

test('Cancel on the confirm card writes nothing, runs nothing and leaves no state', async () => {
  const g = await harness(TREE);
  const before = TREE.map(([k]) => g.raw(k));
  g.view.startPromptRun(null);
  const m = g.modals.at(-1);
  find(m.modalEl, i => i.tag === 'button' && i.text === 'Cancel').click();
  await dom.tick(); await dom.tick();
  eq(g.calls.length, 0);
  assert.equal(g.view.promptBatch, null);
  assert.equal(g.view.promptRuns.size, 0);
  eq(TREE.map(([k]) => g.raw(k)), before);
  assert.equal(g.usage.length, 0, 'no usage notice before Start');
});

test('counter-example 2: a failing leaf blocks its parent and grandparent, with no extra AI call; the failure is named', async () => {
  const h = await harness(TREE);
  h.plan.fail.add('leaf1');
  await h.runAll(); await h.done();
  eq(h.calls.map(c => c.key), ['leaf1', 'leaf2', 'side'], 'only the leaves called the AI: no call for mid or root');
  assert.equal(h.status('mid'), 'blocked'); assert.equal(h.status('root'), 'blocked');
  assert.match(h.view.promptRuns.get(MAP).get(h.node('mid').id).reason, /leaf1/);
  assert.equal(h.status('leaf2'), 'done');
  eq(h.view.promptBatch.outcome, { done: 2, failed: 1, blocked: 2, stopped: false });
  assert.equal(h.raw('mid').includes('I:mid'), false, 'nothing written for the blocked parent');
});

test('an integration that reports a failure (no throw) is a failed topic, not a silent success', async () => {
  const h = await harness(TREE);
  h.plan.fail.add('mid');
  await h.runAll(); await h.done();
  assert.equal(h.status('mid'), 'blocked'); assert.match(h.view.promptRuns.get(MAP).get(h.node('mid').id).reason, /integrate failed: mid/);
  assert.equal(h.status('root'), 'blocked');
});

test('counter-example 3: an empty-Prompt middle topic is not run; its Prompt children run and their failure does not block the grandparent', async () => {
  const h = await harness([['root', null], ['mid', 'root', { prompt: '' }], ['leaf', 'mid'], ['side', 'root']]);
  h.plan.fail.add('leaf');
  await h.runAll(); await h.done();
  eq(h.calls.map(c => `${c.kind}:${c.key}`), ['research:leaf', 'research:side', 'integrate:root']);
  assert.equal(h.status('mid'), undefined);
  assert.equal(h.status('root'), 'done', 'the empty Prompt stops the chain: the failed leaf does not block root');
});

test('counter-example 4: a reused or AI-locked child is not run and the parent still runs', async () => {
  const h = await harness([['root', null], ['r', 'root', { reuse: true }], ['l', 'root', { locked: true }], ['x', 'root']]);
  await h.runAll(); await h.done();
  eq(h.calls.map(c => c.key), ['x', 'root']);
  assert.equal(h.status('r'), undefined); assert.equal(h.status('l'), undefined);
  assert.equal(h.status('root'), 'done');
});

test('counter-example 5: AI already running on a topic of the scope, or a multi-select research: Notice, 0 calls, 0 writes', async () => {
  const h = await harness(TREE);
  const gate = h.hold();
  const handle = await startResearch(h.host, h.node('leaf1'), { map: h.view.map, request: { task: 'go', researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] } });
  assert.ok(handle && h.host.topicRuns.isBusy(h.node('leaf1').path));
  const before = TREE.map(([k]) => h.raw(k));
  h.view.startPromptRun(null);
  assert.equal(h.modals.length, 0, 'no confirm card');
  assert.equal(h.notices.length, 1);
  h.view.runPromptOne(h.node('leaf1'));
  assert.equal(h.notices.length, 2);
  assert.equal(h.calls.length, 0);
  assert.equal(h.view.promptBatch, null);
  eq(TREE.map(([k]) => h.raw(k)), before);
  await until(() => gate.length === 1);
  gate[0]();
  await handle.finished;
  const g = await harness(TREE);
  g.host.expansionCoordinator.isRunning = () => true;
  g.view.startPromptRun(null);
  assert.equal(g.modals.length, 0); assert.equal(g.notices.length, 1);
});

test('counter-example 8: refusing the usage notice runs nothing and leaves no state', async () => {
  const h = await harness(TREE, { confirm: false });
  await h.runAll();
  await dom.tick(); await dom.tick();
  assert.ok(h.usage.length >= 1, 'the notice was asked');
  assert.equal(h.calls.length, 0);
  assert.equal(h.view.promptBatch, null);
  assert.equal(h.view.promptRuns.size, 0);
  h.view.runPromptOne(h.node('leaf1'));
  await dom.tick(); await dom.tick();
  assert.equal(h.calls.length, 0); assert.equal(h.view.promptRuns.size, 0);
});

test('counter-example 1: Stop after the call went out and before the write: the note is byte for byte unchanged, later topics are idle, no new call', async () => {
  const h = await harness(TREE);
  h.plan.hang.add('mid');
  const rootBefore = h.raw('root');
  await h.runAll();
  await until(() => h.calls.some(c => c.key === 'mid'));
  const midBefore = h.raw('mid');
  h.view.stopPromptBatch();
  await h.done();
  assert.equal(h.raw('mid'), midBefore, 'the integrating topic is not written');
  assert.equal(h.raw('root'), rootBefore);
  assert.equal(h.calls.some(c => c.key === 'root'), false, 'no new call after Stop');
  assert.equal(h.status('mid'), 'idle'); assert.equal(h.status('root'), 'idle');
  assert.equal(h.status('leaf1'), 'done', 'finished work stays');
  assert.equal(h.view.promptBatch.outcome.stopped, true);
});

test('counter-example 6: closing the view mid-batch: no later call or write', async () => {
  const h = await harness(TREE);
  h.plan.hang.add('leaf2');
  await h.runAll();
  await until(() => h.calls.some(c => c.key === 'leaf2'));
  const snapshot = TREE.map(([k]) => h.raw(k));
  try { await h.view.onClose(); } catch { /* the rest of the teardown needs a real DOM */ }
  assert.equal(h.view.closed, true);
  await dom.tick(); await dom.tick(); await dom.tick();
  eq(h.calls.map(c => c.key), ['leaf1', 'leaf2'], 'no call after close');
  eq(TREE.map(([k]) => h.raw(k)), snapshot, 'no write after close');
});

test('counter-example 7: a Sources line with a URL or a [[missing]] link is skipped without throwing; a real Markdown note goes in as a reference group', async () => {
  const h = await harness([['solo', null, { prompt: '資料來源：https://example.com/x [[Missing]] [[Ref]]' }]]);
  await h.app.vault.create('Notes/Ref.md', 'reference body');
  h.app.metadataCache = { getFirstLinkpathDest: link => h.app.vault.getAbstractFileByPath(`Notes/${link}.md`) ?? null };
  await h.runAll(); await h.done();
  const groups = h.calls[0].choices.referenceGroups;
  assert.equal(groups.length, 1);
  eq(groups[0].documents.map(d => d.path), ['Notes/Ref.md']);
  assert.equal(h.status('solo'), 'done');
  const g = await harness([['solo', null, { prompt: '資料來源：https://example.com/x [[Missing]]' }]]);
  g.app.metadataCache = { getFirstLinkpathDest: () => null };
  await g.runAll(); await g.done();
  eq(g.calls[0].choices.referenceGroups, []);
  assert.equal(g.status('solo'), 'done');
});

test('only this one: no blocking check, children as they are; success marks the Prompt ancestors out of date, an empty Prompt stops that', async () => {
  const h = await harness(TREE);
  h.plan.fail.add('leaf1');
  h.view.promptRuns.set(MAP, new Map([[h.node('leaf1').id, { status: 'blocked', reason: 'x' }]]));
  h.view.runPromptOne(h.node('mid'));
  await h.done();
  eq(h.calls.map(c => c.key), ['mid'], 'a stuck child does not hold it back');
  assert.equal(h.status('mid'), 'done'); assert.equal(h.status('root'), 'stale');
  const g = await harness([['root', null, { prompt: '' }], ['mid', 'root'], ['leaf', 'mid']]);
  g.view.runPromptOne(g.node('leaf'));
  await g.done();
  assert.equal(g.status('mid'), 'stale'); assert.equal(g.status('root'), undefined, 'the empty Prompt stops the chain');
});

test('a second run is refused while a batch runs; a non-Prompt topic cannot be run alone', async () => {
  const h = await harness(TREE);
  h.plan.hang.add('leaf1');
  await h.runAll();
  await until(() => h.calls.length === 1);
  h.view.startPromptRun(null);
  assert.equal(h.notices.length, 1);
  h.view.stopPromptBatch(); await h.done();
  const g = await harness([['a', null, { prompt: '' }]]);
  g.view.runPromptOne(g.node('a'));
  assert.equal(g.calls.length, 0);
  g.view.startPromptRun(null);
  assert.equal(g.modals.length, 0);
});

test('the status bar shows progress with Stop while running, the result with a dismiss after', async () => {
  const h = await harness(TREE);
  h.plan.hang.add('leaf1');
  await h.runAll();
  await until(() => h.calls.length === 1);
  const bar = element('div');
  h.view.renderPromptRunStatus(bar);
  assert.ok(find(bar, i => i.cls?.includes('vam-prompt-run-statusbar')));
  assert.match(findAll(bar, i => i.cls?.includes('vam-aim-status-value'))[0].text, /1 \/ 5.*leaf1/);
  assert.ok(find(bar, i => i.tag === 'button' && i.text === 'Stop'));
  h.view.stopPromptBatch(); await h.done();
  const after = element('div');
  h.view.renderPromptRunStatus(after);
  assert.match(findAll(after, i => i.cls?.includes('vam-aim-status-value'))[0].text, /stopped/i);
  find(after, i => i.tag === 'button' && i.text === '×').click();
  assert.equal(h.view.promptBatch, null);
});

// ---- menus ------------------------------------------------------------------------------------------------------------
const canvasEvent = { clientX: 110, clientY: 45, preventDefault() {}, target: { closest: () => null } };
const titles = menu => menu.items.map(i => i.title ?? '|');

test('counter-example 10 / menu 1: the canvas menu has "Run all" only when a Prompt topic exists, after a separator', async () => {
  const h = await harness([['a', null, { prompt: '' }], ['b', 'a', { prompt: '  ' }]]);
  h.view.onCanvasContextMenu(canvasEvent);
  assert.equal(h.menus.length, 1);
  assert.equal(titles(h.menus[0]).includes('Run all'), false);
  const g = await harness([['a', null, { prompt: '' }], ['b', 'a']]);
  g.view.onCanvasContextMenu(canvasEvent);
  const list = titles(g.menus[0]);
  assert.ok(list.includes('Run all'));
  assert.equal(list[list.indexOf('Run all') - 1], '|', 'a separator before it');
  assert.ok(list.indexOf('Run all') > list.indexOf('Add text node here') || !list.includes('Add text node here'));
  g.menus[0].items.find(i => i.title === 'Run all').click();
  assert.equal(g.modals.length, 1);
  // Hidden while the notes load or the book locks AI.
  const l = await harness([['a', null]]);
  l.view.notes = new Map();
  l.view.onCanvasContextMenu(canvasEvent);
  assert.equal(titles(l.menus[0]).includes('Run all'), false, 'notes loading');
});

test('menu 2: card items only on Prompt topics, in order, reuse is a checked toggle; hidden under the book AI lock and while notes load', async () => {
  const h = await harness([['p', null], ['plain', 'p', { prompt: '' }]]);
  const menuFor = key => { const m = new (h.view.newMenu().constructor)(); h.view.addCardMenuActions(m, h.node(key)); return m; };
  const mp = menuFor('p');
  const own = ['Run only this one', 'Run all from here', 'Reuse last result'];
  const at = own.map(t => mp.items.findIndex(i => i.title === t));
  assert.ok(at.every(i => i >= 0) && at[0] < at[1] && at[1] < at[2], at.join());
  assert.equal(mp.items[at[2]].checked, false);
  assert.equal(titles(menuFor('plain')).some(t => own.includes(t)), false, 'a non-Prompt topic has none');
  mp.items[at[1]].click();
  assert.equal(h.modals.length, 1, 'from here opens the confirm card');
  h.view.bookLock = () => ({ ai: true, structure: false });
  assert.equal(titles(menuFor('p')).some(t => own.includes(t)), false, 'book AI lock');
  h.view.bookLock = () => ({ ai: false, structure: false });
  const saved = h.view.notes; h.view.notes = new Map();
  assert.equal(titles(menuFor('p')).some(t => own.includes(t)), false, 'notes loading');
  h.view.notes = saved;
  menuFor('p').items.find(i => i.title === 'Reuse last result').click();
  await until(() => h.view.notes.get(h.node('p').id).reuseLastResult === true);
  assert.match(h.raw('p'), /^reuse-last-result: true$/m);
  assert.equal(menuFor('p').items.find(i => i.title === 'Reuse last result').checked, true);
});

test('the card menu wiring and the closing abort are in the view source', () => {
  const src = fs.readFileSync(path.join(S.root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(src, /menu\.addSeparator\(\);\s*this\.addPromptRunMenu\(menu, node\);/);
  assert.match(src, /async onClose\(\)[^]*?this\.promptBatch\?\.controller\.abort\(\)/);
});

// ---- arrows -----------------------------------------------------------------------------------------------------------
test('arrows: a line between two Prompt topics gets a marker-start arrow and a status class; other lines are unchanged', async () => {
  const h = await harness([['root', null], ['pa', 'root'], ['plain', 'root', { prompt: '' }], ['deep', 'plain']]);
  const { view } = h;
  view.cardEls = new Map(h.mapDoc.nodes.map((n, i) => [n.id, Object.assign(element('div'), { offsetLeft: i * 400, offsetTop: 0, offsetWidth: 100, offsetHeight: 50 })]));
  view.edgesEl = { children: [], replaceChildren() { this.children = []; }, appendChild(c) { this.children.push(c); } };
  view.relationsLayerEl = { children: [], replaceChildren() {}, appendChild() {} };
  view.promptRuns.set(MAP, new Map([[h.node('pa').id, { status: 'stale' }]]));
  view.drawEdges();
  const edge = (p, c) => view.edgeEls.get(`${h.node(p).id}\u0000${h.node(c).id}`);
  const arrow = edge('root', 'pa');
  assert.ok(arrow.classes.includes('vam-edge-prompt') && arrow.classes.includes('vam-edge-prompt-stale'));
  assert.equal(arrow.getAttribute('marker-start'), `url(#${view.relationMarkerId}-prompt-stale)`);
  const defs = view.edgesEl.children.find(c => c.tag === 'defs');
  const marker = defs.children[0];
  assert.equal(marker.getAttribute('id'), `${view.relationMarkerId}-prompt-stale`);
  assert.equal(marker.getAttribute('orient'), 'auto-start-reverse');
  for (const [p, c] of [['root', 'plain'], ['plain', 'deep']]) {
    const line = edge(p, c);
    assert.equal(line.classes.some(n => n.startsWith('vam-edge-prompt')), false, `${p}->${c}`);
    assert.equal(line.getAttribute('marker-start'), undefined);
  }
  assert.equal(edge('root', 'pa').classes.includes('vam-edge'), true);
  // No run state yet: the arrow is still drawn, in the "none" state.
  view.promptRuns.clear(); view.drawEdges();
  assert.ok(edge('root', 'pa').classes.includes('vam-edge-prompt-none'));
  // A map with no Prompt topic draws no defs at all.
  const g = await harness([['root', null, { prompt: '' }], ['k', 'root', { prompt: '' }]]);
  g.view.cardEls = new Map(g.mapDoc.nodes.map((n, i) => [n.id, Object.assign(element('div'), { offsetLeft: i * 400, offsetTop: 0, offsetWidth: 100, offsetHeight: 50 })]));
  g.view.edgesEl = { children: [], replaceChildren() { this.children = []; }, appendChild(c) { this.children.push(c); } };
  g.view.relationsLayerEl = { children: [], replaceChildren() {}, appendChild() {} };
  g.view.drawEdges();
  assert.equal(g.view.edgesEl.children.some(c => c.tag === 'defs' && c.children.length), false);
});
