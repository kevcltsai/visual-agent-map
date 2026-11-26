// AI cards and "run all" (V2): the pure planner (experiences/visual-map/prompt-run.ts), the `ai-card` / `ai-run-*` / `ai-update-mode`
// frontmatter keys, and the view (batch, stop, records) with researchChild / integrateChildren / confirmAiUsage stubbed to count calls.
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
const P = (extra = {}) => ({ prompt: 'p', aiCard: true, ...extra });
const noteMap = spec => id => spec[id];
const all = () => noteMap({ root: P(), a: P(), a1: P(), a2: P(), b: P(), c: P() });
const ids = items => items.map(i => i.id);

test('plan: children before parents; a leaf researches on the web, a card with children integrates without it', () => {
  const plan = pr.planPromptRun(nodes, all());
  eq(ids(plan.order), ['a1', 'a2', 'a', 'b', 'root', 'c']);
  eq(plan.order.map(i => i.kind), ['research', 'research', 'integrate', 'research', 'integrate', 'research']);
  eq(plan.order.map(i => i.web), [true, true, false, true, false, true]);
  eq(plan.counts, { run: 6, web: 4 });
});

test('plan: a locked AI card and its whole subtree are left out; a locked ordinary card cuts nothing', () => {
  const plan = pr.planPromptRun(nodes, noteMap({ root: P(), a: P({ aiLocked: true }), a1: P(), a2: P(), b: P(), c: P() }));
  eq(ids(plan.order), ['b', 'root', 'c'], 'a, a1 and a2 do not run and are not counted');
  const ordinary = pr.planPromptRun(nodes, noteMap({ root: P(), a: { prompt: 'p', aiLocked: true }, a1: P(), a2: P(), b: P() }));
  eq(ids(ordinary.order), ['a1', 'a2', 'b', 'root'], 'the locked ordinary card does not cut the chain');
});

test('plan: an AI card is `ai-card: true` and a non-empty Prompt; a Prompt alone (an AI-expanded child) is an ordinary card', () => {
  assert.equal(pr.isAiCard(P({ prompt: '\n ' })), false);
  assert.equal(pr.isAiCard({ prompt: 'p' }), false);
  assert.equal(pr.isAiCard({ prompt: '', aiCard: true }), false);
  assert.equal(pr.isAiCard(P()), true);
  assert.equal(pr.isAiCard(undefined), false);
  const plan = pr.planPromptRun(nodes, noteMap({ root: P(), a: { prompt: 'p' }, a1: P(), a2: { prompt: 'p' }, b: P() }));
  eq(ids(plan.order), ['a1', 'b', 'root'], 'cards with only a Prompt never run; their AI-card children still do');
});

test('plan: a note that is not loaded is skipped; a parent cycle is walked once', () => {
  eq(ids(pr.planPromptRun(nodes, noteMap({ root: P(), a: P() })).order), ['a', 'root']);
  const loop = [{ id: 'x', parentId: 'y' }, { id: 'y', parentId: 'x' }];
  assert.doesNotThrow(() => pr.planPromptRun(loop, noteMap({ x: P(), y: P() })));
});

test('hasAiCard / isPromptEdge: a line carries data when its parent is an AI card, whatever the child is', () => {
  assert.equal(pr.hasAiCard(nodes, noteMap({ a: P({ prompt: '' }) })), false);
  assert.equal(pr.hasAiCard(nodes, noteMap({ a: { prompt: 'p' } })), false);
  assert.equal(pr.hasAiCard(nodes, noteMap({ a: P() })), true);
  assert.equal(pr.isPromptEdge(all(), 'root'), true);
  assert.equal(pr.isPromptEdge(noteMap({ root: P({ prompt: '' }), a: P() }), 'root'), false, 'an AI child under an ordinary parent is not a data line');
  assert.equal(pr.isPromptEdge(noteMap({ root: P(), a: { prompt: 'p' } }), 'root'), true, 'an ordinary child under an AI parent is');
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

test('blockingChildren: only unlocked AI-card children that are bad block; ordinary and locked children never do', () => {
  const spec = noteMap({ root: P(), a: P(), a1: { prompt: 'p' }, c: P({ aiLocked: true }), d: P({ prompt: '' }) });
  const kids = [{ id: 'root', parentId: null }, { id: 'a', parentId: 'root' }, { id: 'a1', parentId: 'root' }, { id: 'c', parentId: 'root' }, { id: 'd', parentId: 'root' }];
  eq(pr.blockingChildren(kids, spec, 'root', () => true), ['a']);
  eq(pr.blockingChildren(kids, spec, 'root', () => false), []);
});

const items = (plan) => plan.order;
test('runPromptItems: post-order calls, statuses, outcome counts; a failing child blocks its parents without an AI call', async () => {
  const plan = pr.planPromptRun(nodes, all());
  const statuses = new Map(), ran = [];
  const outcome = await pr.runPromptItems(items(plan), {
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

test('runPromptItems: Stop returns the running card to idle and starts nothing new', async () => {
  const plan = pr.planPromptRun(nodes, all());
  const controller = new AbortController(), statuses = new Map(), ran = [];
  const outcome = await pr.runPromptItems(items(plan), {
    nodes, noteOf: all(), signal: controller.signal, isBad: () => false, setStatus: (id, status) => statuses.set(id, status), titleOf: String, blockedReason: String,
    runItem: async item => { ran.push(item.id); if (item.id === 'a2') controller.abort(); }
  });
  eq(ran, ['a1', 'a2']);
  assert.equal(statuses.get('a2'), 'idle'); assert.equal(statuses.get('a1'), 'done');
  for (const id of ['a', 'b', 'root', 'c']) assert.equal(statuses.has(id), false, `${id} keeps its mark`);
  assert.equal(outcome.stopped, true);
});

test('promptInputKey: Prompt (trimmed), children by id with their summary, source mtimes; order of children does not matter', () => {
  const base = { prompt: ' Q ', children: [{ id: 'b', summary: 'B' }, { id: 'a', summary: 'A' }], sources: [{ path: 'N.md', mtime: 5 }] };
  const key = pr.promptInputKey(base);
  assert.match(key, /^[0-9a-f]{8}$/);
  assert.equal(pr.promptInputKey({ ...base, prompt: 'Q', children: [...base.children].reverse() }), key);
  assert.notEqual(pr.promptInputKey({ ...base, prompt: 'Q2' }), key);
  assert.notEqual(pr.promptInputKey({ ...base, children: [{ id: 'b', summary: 'B2' }, { id: 'a', summary: 'A' }] }), key, 'a child summary changed');
  assert.notEqual(pr.promptInputKey({ ...base, children: base.children.slice(1) }), key, 'a child removed');
  assert.notEqual(pr.promptInputKey({ ...base, children: [...base.children, { id: 'c', summary: '' }] }), key, 'a child added');
  assert.notEqual(pr.promptInputKey({ ...base, sources: [{ path: 'N.md', mtime: 6 }] }), key, 'a source note edited');
  assert.notEqual(pr.promptInputKey({ ...base, sources: [] }), key);
});

test('aiCardStatus: pending, running, failed, stale (own input or a child not done), done', () => {
  const ok = { at: 't', result: 'ok', input: 'k' };
  const st = (extra) => pr.aiCardStatus({ running: false, inputKey: 'k', childStatuses: [], ...extra });
  assert.equal(st({}), 'pending');
  assert.equal(st({ run: ok, running: true }), 'running');
  assert.equal(st({ run: ok }), 'done');
  assert.equal(st({ run: { ...ok, input: 'old' } }), 'stale');
  assert.equal(st({ run: { at: 't', result: 'ok' } }), 'stale', 'no input recorded');
  assert.equal(st({ run: ok, childStatuses: ['done', 'stale'] }), 'stale', 'a child that needs a re-run');
  assert.equal(st({ run: ok, childStatuses: ['pending'] }), 'stale', 'a child never run');
  assert.equal(st({ run: ok, childStatuses: ['done', 'done'] }), 'done');
  assert.equal(st({ run: { at: 't', result: 'failed', input: 'k' } }), 'failed');
  assert.equal(st({ run: { at: 't', result: 'blocked', input: 'k' } }), 'failed');
  assert.equal(st({ run: { at: 't', result: 'failed' }, childStatuses: ['stale'] }), 'failed', 'failed never turns into stale');
});

test('splitPrompt / joinPrompt: the question and the source notes round trip; other "name: content" lines stay in the question', () => {
  eq(pr.splitPrompt('Why?\n資料來源：[[A]]、[[B]]'), { question: 'Why?', sources: ['A', 'B'] });
  eq(pr.splitPrompt('Why?\nFormat: bullets\nSources: [[A]], [[B|x]]'), { question: 'Why?\nFormat: bullets', sources: ['A', 'B'] });
  eq(pr.splitPrompt('Why?\n资料来源: [[A]]\n資料來源：[[A]]'), { question: 'Why?', sources: ['A'] }, 'a repeated link once');
  eq(pr.splitPrompt('Why?\nSources: Plain name'), { question: 'Why?\nSources: Plain name', sources: [] }, 'a source line with words stays');
  eq(pr.splitPrompt('Why?\n資料來源：https://e.com'), { question: 'Why?\n資料來源：https://e.com', sources: [] });
  eq(pr.splitPrompt(''), { question: '', sources: [] });
  const langs = { 'zh-TW': ['資料來源', '、'], 'zh-CN': ['资料来源', '、'], en: ['Sources', ', '] };
  assert.equal(pr.joinPrompt(' Why? ', ['A', 'B'], ...langs['zh-TW']), 'Why?\n資料來源：[[A]]、[[B]]');
  assert.equal(pr.joinPrompt('Why?', ['A', 'B'], ...langs['zh-CN']), 'Why?\n资料来源：[[A]]、[[B]]');
  assert.equal(pr.joinPrompt('Why?', ['A'], ...langs.en), 'Why?\nSources: [[A]]', 'English uses the half-width colon');
  eq(pr.splitPrompt('Why?\nSources：[[A]]'), { question: 'Why?', sources: ['A'] }, 'both colons are read');
  assert.equal(pr.joinPrompt('Why?', [], ...langs.en), 'Why?');
  for (const lang of Object.keys(langs)) eq(pr.splitPrompt(pr.joinPrompt('Q\nOther: x', ['A', 'B'], ...langs[lang])), { question: 'Q\nOther: x', sources: ['A', 'B'] }, lang);
});

test('aiCardTitle: the first line, 20 characters, trailing punctuation dropped; nothing for an empty question', () => {
  assert.equal(pr.aiCardTitle('這家公司的主要風險是什麼？\n第二行'), '這家公司的主要風險是什麼');
  assert.equal(pr.aiCardTitle('\n  Short question?  '), 'Short question');
  assert.equal(pr.aiCardTitle('A very long question that goes on'), 'A very long question');
  assert.equal(pr.aiCardTitle('   '), '');
});

// ---- the harness ------------------------------------------------------------------------------------------------------
// spec: [key, parentKey|null, { prompt, noAi (a Prompt without `ai-card`), fresh, locked }]
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
    await repo.updateNote(created.path, { prompt });
    if (!opt.noAi) await repo.writeAiCard(created.path, true);
    if (opt.fresh) await repo.writeAiUpdateMode(created.path, 'fresh');
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
  const { VisualAgentMapView } = S.load('main.ts', { obsidian: { ...obsidian, Notice: dom.makeNotice(notices), Modal, Menu } }, { createFragment: dom.createFragment, CSS: { escape: v => v }, createSvg: dom.createSvg, createEl: (tag, value) => element(tag, value), createSpan: value => element('span', typeof value === 'string' ? { cls: value } : value), requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
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
  const runAll = async () => { view.startPromptRun(); };
  return { hold: () => (gate = []), repo, app, contents, view, host, calls, notices, menus, modals, usage, plan, raw, node, status, done, runAll, hydrate, mapDoc, byKey };
}

// root -> mid -> leaf1, leaf2 ; root -> side
const TREE = [['root', null], ['mid', 'root'], ['leaf1', 'mid'], ['leaf2', 'mid'], ['side', 'root']];
const stamp = (h, key) => ({ at: h.raw(key).match(/^ai-run-at: "(.*)"$/m)?.[1], result: h.raw(key).match(/^ai-run-result: "(.*)"$/m)?.[1], input: h.raw(key).match(/^ai-run-input: "(.*)"$/m)?.[1] });
const updatedOf = h => key => h.raw(key).match(/^updated:.*$/m)?.[0]; // the stub's own summary write bumps it; the records must not (see the keys test)

test('keys: `ai-card` / `ai-run-*` / `ai-update-mode` readers accept only valid values; `reuse-last-result` is not read', () => {
  for (const v of [undefined, false, 'true', 1, null]) assert.equal(values.readAiCard({ 'ai-card': v }), false, String(v));
  assert.equal(values.readAiCard({ 'ai-card': true }), true);
  eq(values.readAiRun({ 'ai-run-at': 't', 'ai-run-result': 'ok', 'ai-run-input': 'k' }), { at: 't', result: 'ok', input: 'k' });
  eq(values.readAiRun({ 'ai-run-at': 't', 'ai-run-result': 'failed' }), { at: 't', result: 'failed' });
  for (const bad of [{}, { 'ai-run-at': 't' }, { 'ai-run-result': 'ok' }, { 'ai-run-at': '', 'ai-run-result': 'ok' }, { 'ai-run-at': 't', 'ai-run-result': 'done' }]) assert.equal(values.readAiRun(bad), undefined);
  assert.equal(values.readAiUpdateMode({ 'ai-update-mode': 'fresh' }), 'fresh');
  for (const v of [undefined, 'top', 'merge', true]) assert.equal(values.readAiUpdateMode({ 'ai-update-mode': v }), undefined, String(v));
  assert.equal(values.readReuseLastResult, undefined);
});

test('keys: writers add and remove their keys, `updated` unchanged, byte round trip; a note with `reuse-last-result` is read as an ordinary card and the key stays', async () => {
  const h = await harness([['A', null, { noAi: true }]]);
  const before = h.raw('A');
  await h.repo.writeAiCard(h.node('A').path, true);
  assert.match(h.raw('A'), /^ai-card: true$/m);
  assert.equal((await h.repo.readNote(h.node('A').path)).aiCard, true);
  assert.equal(updatedOf(h)('A'), before.match(/^updated:.*$/m)[0], 'updated is not bumped');
  assert.equal(h.raw('A').replace(/^ai-card: true\n/m, ''), before, 'no other byte changes');
  const on = h.raw('A');
  await h.repo.writeAiCard(h.node('A').path, true);
  assert.equal(h.raw('A'), on, 'already on: byte for byte');
  await h.repo.writeAiUpdateMode(h.node('A').path, 'fresh');
  await h.repo.writeAiCard(h.node('A').path, false);
  assert.doesNotMatch(h.raw('A'), /ai-update-mode/, 'a card that stops being an AI card loses ai-update-mode');
  assert.equal(h.raw('A'), before);
  await h.repo.writeAiUpdateMode(h.node('A').path, 'fresh');
  assert.match(h.raw('A'), /^ai-update-mode: "fresh"$/m);
  assert.equal((await h.repo.readNote(h.node('A').path)).aiUpdateMode, 'fresh');
  await h.repo.writeAiUpdateMode(h.node('A').path, 'top');
  assert.equal(h.raw('A'), before, 'keeping old data removes the key');
  await h.repo.writeAiRunStamp(h.node('A').path, { at: '2026-01-02T03:04:05.000Z', result: 'ok', input: 'abc12345' });
  eq((await h.repo.readNote(h.node('A').path)).aiRun, { at: '2026-01-02T03:04:05.000Z', result: 'ok', input: 'abc12345' });
  await h.repo.writeAiRunStamp(h.node('A').path, { at: '2026-01-03T00:00:00.000Z', result: 'failed' });
  eq((await h.repo.readNote(h.node('A').path)).aiRun, { at: '2026-01-03T00:00:00.000Z', result: 'failed', input: 'abc12345' }, 'a failure keeps the last input');
  assert.equal(updatedOf(h)('A'), before.match(/^updated:.*$/m)[0]);
  // A V1 note: the key is neither read nor written, and stays as it is.
  const g = await harness([['B', null, { noAi: true }]]);
  await g.app.vault.process(g.app.vault.getAbstractFileByPath(g.node('B').path), c => c.replace(/^(---\n)/, '$1reuse-last-result: true\n'));
  const note = await g.repo.readNote(g.node('B').path);
  assert.equal(note.aiCard, undefined); assert.equal(note.reuseLastResult, undefined);
  await g.repo.writeAiCard(g.node('B').path, true);
  await g.repo.writeAiRunStamp(g.node('B').path, { at: 't', result: 'ok', input: 'k' });
  assert.match(g.raw('B'), /^reuse-last-result: true$/m);
});

// ---- run all ----------------------------------------------------------------------------------------------------------
test('run all: no confirmation card; the usage notice, then leaves to root, one AI call each, no charts; leaves go on the web, "keep old data" is top', async () => {
  const h = await harness(TREE);
  await h.runAll();
  await h.done();
  assert.equal(h.modals.length, 0, 'no confirmation card');
  assert.ok(h.usage.length >= 1, 'the usage notice was asked');
  eq(h.calls.map(c => `${c.kind}:${c.key}`), ['research:leaf1', 'research:leaf2', 'integrate:mid', 'research:side', 'integrate:root']);
  assert.equal(h.calls[0].charts, false, 'research charts off');
  assert.equal(h.calls[0].choices.researchMode, 'research', 'a leaf always searches the web');
  assert.equal(h.calls[0].choices.updateMode, 'top');
  assert.equal(h.calls[2].options.skipCharts, true);
  assert.equal(h.calls[2].options.synthesisContent, 'summary');
  assert.equal(h.calls[2].options.researchMode, 'local', 'an integration does not search');
  assert.equal(h.calls[2].options.updateMode, 'top');
  assert.match(h.calls[2].direction, /^Prompt mid\n\n.*organise/s, 'the note Prompt then the default instruction');
  eq(h.view.promptBatch.outcome, { done: 5, failed: 0, blocked: 0, stopped: false });
  for (const k of ['leaf1', 'leaf2', 'mid', 'root', 'side']) assert.equal(h.status(k), 'done', k);
  assert.match(h.raw('root'), /I:root/);
});

test('run all: `ai-update-mode: fresh` goes to the research and the integration as "fresh"', async () => {
  const h = await harness([['root', null, { fresh: true }], ['leaf', 'root', { fresh: true }]]);
  await h.runAll(); await h.done();
  assert.equal(h.calls[0].choices.updateMode, 'fresh');
  assert.equal(h.calls[1].options.updateMode, 'fresh');
});

test('records: a success writes ai-run-at / result ok / input; the input follows the children as they were read at the start', async () => {
  const h = await harness(TREE);
  await h.runAll(); await h.done();
  for (const [k] of TREE) { const s = stamp(h, k); assert.equal(s.result, 'ok', k); assert.match(s.at, /^\d{4}-\d\d-\d\dT/); assert.match(s.input, /^[0-9a-f]{8}$/); }
  // The parent's input saw the summary its leaves had just written.
  const note = await h.repo.readNote(h.node('mid').path);
  const midKey = pr.promptInputKey({ prompt: 'Prompt mid', children: [{ id: h.node('leaf1').id, summary: 'R:leaf1' }, { id: h.node('leaf2').id, summary: 'R:leaf2' }], sources: [] });
  assert.equal(note.aiRun.input, midKey);
});

test('records: a failed card gets failed, the cards it holds back get blocked with no AI call; neither changes the last input', async () => {
  const h = await harness(TREE);
  await h.runAll(); await h.done();
  const input = stamp(h, 'mid').input;
  const g = await harness(TREE);
  g.plan.fail.add('leaf1');
  await g.runAll(); await g.done();
  eq(g.calls.map(c => c.key), ['leaf1', 'leaf2', 'side'], 'no call for mid or root');
  assert.equal(stamp(g, 'leaf1').result, 'failed'); assert.equal(stamp(g, 'leaf1').input, undefined);
  assert.equal(stamp(g, 'mid').result, 'blocked'); assert.equal(stamp(g, 'root').result, 'blocked');
  assert.equal(stamp(g, 'mid').input, undefined, 'a blocked card that never ran has no input');
  assert.equal(stamp(g, 'leaf2').result, 'ok');
  assert.equal(g.raw('mid').includes('I:mid'), false, 'nothing written for the blocked parent');
  // A card that had succeeded keeps its last input through a failed run.
  h.plan.fail.add('leaf1');
  await h.hydrate();
  h.view.promptBatch = null;
  await h.runAll(); await h.done();
  assert.equal(stamp(h, 'leaf1').result, 'failed');
  assert.equal(stamp(h, 'mid').result, 'blocked');
  assert.equal(stamp(h, 'mid').input, input, 'the input of the last success stays');
});

test('an integration that reports a failure (no throw) is a failed card, not a silent success', async () => {
  const h = await harness(TREE);
  h.plan.fail.add('mid');
  await h.runAll(); await h.done();
  assert.equal(h.status('mid'), 'blocked'); assert.match(h.view.promptRuns.get(MAP).get(h.node('mid').id).reason, /integrate failed: mid/);
  assert.equal(h.status('root'), 'blocked');
  assert.equal(stamp(h, 'mid').result, 'failed'); assert.equal(stamp(h, 'root').result, 'blocked');
});

test('counter-example: an ordinary card with only a Prompt is not run; an ordinary middle card stops the chain, its AI-card children still run', async () => {
  const h = await harness([['root', null], ['mid', 'root', { noAi: true }], ['leaf', 'mid'], ['side', 'root']]);
  h.plan.fail.add('leaf');
  await h.runAll(); await h.done();
  eq(h.calls.map(c => `${c.kind}:${c.key}`), ['research:leaf', 'research:side', 'integrate:root']);
  assert.equal(h.status('mid'), undefined);
  assert.equal(h.status('root'), 'done', 'the ordinary card stops the chain: the failed leaf does not block root');
  assert.equal(stamp(h, 'mid').result, undefined, 'no record on an ordinary card');
  const g = await harness([['solo', null, { noAi: true }]]);
  g.view.startPromptRun();
  assert.equal(g.calls.length, 0); assert.equal(g.notices.length, 1, 'nothing to run: a notice');
});

test('counter-example: a locked AI card and its subtree are not run and have no record; the parent still runs over the summaries', async () => {
  const h = await harness([['root', null], ['l', 'root', { locked: true }], ['lc', 'l'], ['x', 'root']]);
  await h.runAll(); await h.done();
  eq(h.calls.map(c => c.key), ['x', 'root']);
  for (const k of ['l', 'lc']) { assert.equal(h.status(k), undefined); assert.equal(stamp(h, k).result, undefined); }
  assert.equal(h.status('root'), 'done');
  assert.equal(h.view.promptBatch.total, 2, 'N counts only what runs');
});

test('counter-example 5: AI already running on a card of the map, or a multi-select research: Notice, 0 calls, 0 writes', async () => {
  const h = await harness(TREE);
  const gate = h.hold();
  const handle = await startResearch(h.host, h.node('leaf1'), { map: h.view.map, request: { task: 'go', researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] } });
  assert.ok(handle && h.host.topicRuns.isBusy(h.node('leaf1').path));
  const before = TREE.map(([k]) => h.raw(k));
  h.view.startPromptRun();
  assert.equal(h.notices.length, 1);
  await dom.tick(); await dom.tick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.view.promptBatch, null);
  eq(TREE.map(([k]) => h.raw(k)), before);
  await until(() => gate.length === 1);
  gate[0]();
  await handle.finished;
  const g = await harness(TREE);
  g.host.expansionCoordinator.isRunning = () => true;
  g.view.startPromptRun();
  assert.equal(g.notices.length, 1);
});

test('counter-example 8: refusing the usage notice runs nothing and leaves no state or record', async () => {
  const h = await harness(TREE, { confirm: false });
  const before = TREE.map(([k]) => h.raw(k));
  await h.runAll();
  await dom.tick(); await dom.tick();
  assert.ok(h.usage.length >= 1, 'the notice was asked');
  assert.equal(h.calls.length, 0);
  assert.equal(h.view.promptBatch, null);
  assert.equal(h.view.promptRuns.size, 0);
  eq(TREE.map(([k]) => h.raw(k)), before);
});

test('counter-example 1: Stop after the call went out and before the write: the note is byte for byte unchanged, no record, later cards keep their mark, no new call', async () => {
  const h = await harness(TREE);
  h.plan.hang.add('mid');
  const rootBefore = h.raw('root');
  await h.runAll();
  await until(() => h.calls.some(c => c.key === 'mid'));
  const midBefore = h.raw('mid');
  h.view.stopPromptBatch();
  await h.done();
  assert.equal(h.raw('mid'), midBefore, 'the integrating card is not written, no ai-run-*');
  assert.equal(h.raw('root'), rootBefore);
  assert.equal(h.calls.some(c => c.key === 'root'), false, 'no new call after Stop');
  assert.equal(h.status('mid'), 'idle'); assert.equal(h.status('root'), undefined);
  assert.equal(h.status('leaf1'), 'done', 'finished work stays');
  assert.equal(stamp(h, 'leaf1').result, 'ok', 'and keeps its record');
  assert.equal(h.view.promptBatch.outcome.stopped, true);
});

test('counter-example 6: closing the view mid-batch: no later call or write, no record', async () => {
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

test('counter-example 7: a Sources line with a URL or a [[missing]] link is skipped without throwing; a real Markdown note goes in as a reference group and into the input key', async () => {
  const h = await harness([['solo', null, { prompt: '資料來源：https://example.com/x [[Missing]] [[Ref]]' }]]);
  const file = await h.app.vault.create('Notes/Ref.md', 'reference body');
  file.stat = { mtime: 111 };
  h.app.metadataCache = { getFirstLinkpathDest: link => h.app.vault.getAbstractFileByPath(`Notes/${link}.md`) ?? null };
  await h.runAll(); await h.done();
  const groups = h.calls[0].choices.referenceGroups;
  assert.equal(groups.length, 1);
  eq(groups[0].documents.map(d => d.path), ['Notes/Ref.md']);
  assert.equal(h.status('solo'), 'done');
  assert.equal(stamp(h, 'solo').input, pr.promptInputKey({ prompt: '資料來源：https://example.com/x [[Missing]] [[Ref]]', children: [], sources: [{ path: 'Notes/Ref.md', mtime: 111 }] }));
  const g = await harness([['solo', null, { prompt: '資料來源：https://example.com/x [[Missing]]' }]]);
  g.app.metadataCache = { getFirstLinkpathDest: () => null };
  await g.runAll(); await g.done();
  eq(g.calls[0].choices.referenceGroups, []);
  assert.equal(g.status('solo'), 'done');
});

test('a second run is refused while a batch runs', async () => {
  const h = await harness(TREE);
  h.plan.hang.add('leaf1');
  await h.runAll();
  await until(() => h.calls.length === 1);
  h.view.startPromptRun();
  assert.equal(h.notices.length, 1);
  h.view.stopPromptBatch(); await h.done();
});

test('toolbar Run all: disabled with a hint without an AI card; progress "n / N" with a stop label while running; a press stops', async () => {
  const none = await harness([['a', null, { prompt: '' }]]);
  const off = element('div');
  none.view.renderRunAllButton(off);
  const dead = find(off, i => i.tag === 'button' && i.cls?.includes('vam-run-all'));
  assert.equal(dead.disabled, true);
  assert.equal(dead.attrs.title, 'Add an AI card first');
  const h = await harness(TREE);
  const idle = element('div');
  h.view.renderRunAllButton(idle);
  assert.equal(find(idle, i => i.tag === 'button').disabled ?? false, false);
  h.plan.hang.add('leaf1');
  await h.runAll();
  await until(() => h.calls.length === 1);
  const bar = element('div');
  h.view.renderRunAllButton(bar);
  const button = find(bar, i => i.tag === 'button' && i.cls?.includes('is-running'));
  assert.ok(button);
  assert.match(find(button, i => i.cls?.includes('vam-run-all-count')).text, /^1 \/ 5$/);
  assert.equal(button.attrs['aria-label'], 'Stop running all');
  button.click();
  await h.done();
  assert.equal(h.view.promptBatch.outcome.stopped, true);
});

// ---- menus ------------------------------------------------------------------------------------------------------------
const canvasEvent = { clientX: 110, clientY: 45, preventDefault() {}, target: { closest: () => null } };
const titles = menu => menu.items.map(i => i.title ?? '|');

test('add menu: "AI card" comes before "Add text", after a separator; picking it opens the popover', async () => {
  const h = await harness([['a', null]]);
  let opened = null;
  h.view.openAiCardPopover = (...args) => { opened = args; };
  h.view.openAddMenu({ clientX: 1, clientY: 1, preventDefault() {} }, null);
  const list = titles(h.menus[0]);
  const ai = list.indexOf('AI card'), text = list.indexOf('Add text');
  assert.ok(ai > 0 && text > ai, `AI card before Add text: ${list}`);
  assert.equal(list[ai - 1], '|', 'a separator before it');
  h.menus[0].items.find(i => i.title === 'AI card').click();
  assert.ok(opened && opened[0] === null, 'the popover opens for a new card');
  assert.equal(titles(h.menus[0]).includes('Run all'), false, 'Run all lives on the toolbar now');
});

test('card menu: "Make it an AI card" on an ordinary card, "Edit AI card" on an AI card; both open the popover', async () => {
  const h = await harness([['a', null, { prompt: '' }], ['b', 'a']]);
  const opened = [];
  h.view.openAiCardPopover = node => opened.push(node.id);
  for (const [key, label] of [['a', 'Make it an AI card'], ['b', 'Edit AI card']]) {
    const menu = h.view.newMenu();
    h.view.addCardMenuActions(menu, h.node(key));
    const item = menu.items.find(i => i.title === label);
    assert.ok(item, label);
    item.click();
  }
  eq(opened, [h.node('a').id, h.node('b').id]);
});

test('the closing abort is in the view source', () => {
  const src = fs.readFileSync(path.join(S.root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(src, /async onClose\(\)[^]*?this\.promptBatch\?\.controller\.abort\(\)/);
});

// ---- arrows -----------------------------------------------------------------------------------------------------------
test('arrows: a line whose parent is an AI card gets a marker-start arrow and a thin line, no status class; other lines are unchanged', async () => {
  const h = await harness([['root', null, { prompt: '' }], ['pa', 'root'], ['ordinary', 'pa', { prompt: '' }], ['deep', 'ordinary']]);
  const { view } = h;
  view.cardEls = new Map(h.mapDoc.nodes.map((n, i) => [n.id, Object.assign(element('div'), { offsetLeft: i * 400, offsetTop: 0, offsetWidth: 100, offsetHeight: 50 })]));
  view.edgesEl = { children: [], replaceChildren() { this.children = []; }, appendChild(c) { this.children.push(c); } };
  view.relationsLayerEl = { children: [], replaceChildren() {}, appendChild() {} };
  view.promptRuns.set(MAP, new Map([[h.node('pa').id, { status: 'running' }]]));
  view.drawEdges();
  const edge = (p, c) => view.edgeEls.get(`${h.node(p).id}\u0000${h.node(c).id}`);
  const arrow = edge('pa', 'ordinary');
  assert.ok(arrow.classes.includes('vam-edge-prompt'));
  assert.equal(arrow.classes.some(n => n.startsWith('vam-edge-prompt-')), false, 'no status class');
  assert.equal(arrow.getAttribute('marker-start'), `url(#${view.relationMarkerId}-prompt)`);
  const defs = view.edgesEl.children.find(c => c.tag === 'defs');
  const marker = defs.children[0];
  assert.equal(marker.getAttribute('id'), `${view.relationMarkerId}-prompt`);
  assert.equal(marker.getAttribute('orient'), 'auto-start-reverse');
  for (const [p, c] of [['root', 'pa'], ['ordinary', 'deep']]) {
    const line = edge(p, c);
    assert.equal(line.classes.some(n => n.startsWith('vam-edge-prompt')), false, `${p}->${c}`);
    assert.equal(line.getAttribute('marker-start'), undefined);
  }
  assert.equal(edge('pa', 'ordinary').classes.includes('vam-edge'), true);
  const g = await harness([['root', null, { prompt: '' }], ['k', 'root', { prompt: '' }]]);
  g.view.cardEls = new Map(g.mapDoc.nodes.map((n, i) => [n.id, Object.assign(element('div'), { offsetLeft: i * 400, offsetTop: 0, offsetWidth: 100, offsetHeight: 50 })]));
  g.view.edgesEl = { children: [], replaceChildren() { this.children = []; }, appendChild(c) { this.children.push(c); } };
  g.view.relationsLayerEl = { children: [], replaceChildren() {}, appendChild() {} };
  g.view.drawEdges();
  assert.equal(g.view.edgesEl.children.some(c => c.tag === 'defs' && c.children.length), false);
});

test('card face: a star and one state glyph by the name, the question line under it; done has no glyph, locked has none', async () => {
  const h = await harness([['a', null, { prompt: 'Why is the sky blue?\nsecond line' }]]);
  const node = h.node('a');
  const face = () => {
    const card = element('div'), header = element('div'), title = element('h3', { cls: 'vam-card-title' });
    header.appendChild?.(title); card.appendChild?.(header); card.appendChild?.(title);
    return { card, header, title };
  };
  const { card, header, title } = face();
  h.view.paintPromptState(card, header, node, h.view.notes.get(node.id));
  assert.equal(card.dataset.aiCard, 'true');
  assert.ok(find(title, i => i.cls?.includes('vam-ai-star')), 'star');
  assert.equal(findAll(title, i => i.cls?.includes('vam-ai-glyph')).length, 1, 'one glyph');
  assert.ok(find(title, i => i.cls?.includes('vam-ai-glyph-pending')));
  const q = findAll(card, i => i.cls?.includes('vam-ai-question'));
  assert.equal(q.length, 1); assert.equal(q[0].text, 'Why is the sky blue?');
  h.view.paintPromptState(card, header, node, h.view.notes.get(node.id));
  assert.equal(findAll(card, i => i.cls?.includes('vam-ai-question')).length, 1, 'repainting does not stack chips');
  const locked = face();
  h.view.paintPromptState(locked.card, locked.header, node, { ...h.view.notes.get(node.id), aiLocked: true });
  assert.equal(findAll(locked.title, i => i.cls?.includes('vam-ai-glyph')).length, 0, 'locked: no glyph');
  const ordinary = face();
  h.view.paintPromptState(ordinary.card, ordinary.header, node, { prompt: 'p' });
  assert.equal(ordinary.card.dataset.aiCard, undefined);
});

// ---- review fixes: stale state between batches, popover prefill, save path ----------------------------------------------
test('two batches: a card not yet reached by batch 2 is not shown done from batch 1 (stale after a Prompt edit, not done)', async () => {
  const h = await harness([['Y', null], ['X', null]]);
  await h.runAll(); await h.done();
  assert.equal(h.status('X'), 'done');
  await h.repo.updateNote(h.node('X').path, { prompt: 'Prompt X edited' });
  await h.hydrate();
  h.view.aiStatusMemo.clear();
  h.view.promptBatch = null;
  h.plan.hang.add('Y');
  await h.runAll();
  await until(() => h.calls.filter(c => c.key === 'Y').length === 2);
  assert.equal(h.status('X'), undefined, 'batch 1 left nothing for X');
  h.view.aiStatusMemo.clear();
  assert.equal(h.view.aiStatusOf(h.node('X').id), 'stale');
  h.view.stopPromptBatch(); await h.done();
});

const popoverHarness = async spec => {
  const h = await harness(spec);
  const overlay = element('div', { cls: 'vam-canvas-overlay' });
  overlay.ownerDocument = element('div');
  h.view.contentEl.appendChild(overlay);
  const pop = () => h.view.aiCardOpen?.win.el;
  const question = () => find(pop(), i => i.tag === 'textarea');
  const saveButton = () => find(pop(), i => i.tag === 'button' && i.cls?.includes('mod-cta'));
  return { ...h, overlay, pop, question, saveButton };
};

test('popover prefill: a card with only a Prompt (no `ai-card`) opens with its question and notes; an ordinary card with no Prompt opens blank', async () => {
  const h = await popoverHarness([['A', null, { noAi: true, prompt: 'Why?\nSources: [[N]]' }], ['B', null, { noAi: true, prompt: '' }]]);
  h.view.openAiCardPopover(h.node('A'));
  assert.equal(h.question().value, 'Why?');
  eq(findAll(h.pop(), i => i.cls?.includes('vam-ai-card-pop-chip-name')).map(i => i.text), ['N']);
  h.view.openAiCardPopover(h.node('B'));
  assert.equal(h.question().value, '');
});

test('save path: an existing card is one undo step and undo restores the note byte for byte; keys follow the tick', async () => {
  const h = await popoverHarness([['A', null, { prompt: 'Old' }]]);
  const before = h.raw('A');
  const past = h.view.history.past.length;
  await h.view.writeAiCard(h.node('A'), { title: '', question: 'New Q', sources: ['N', 'M'], keepOld: true });
  assert.equal(h.view.history.past.length, past + 1, 'one undo step');
  assert.match(h.raw('A'), /^ai-card: true$/m);
  assert.match(h.raw('A'), /^research-mode: "?research"?$/m);
  assert.match(h.raw('A'), /> New Q\n> Sources: \[\[N\]\], \[\[M\]\]/);
  assert.equal(/^ai-update-mode: /m.test(h.raw('A')), false, 'ticked: no ai-update-mode written');
  await h.view.writeAiCard(h.node('A'), { title: '', question: 'New Q', sources: [], keepOld: false });
  assert.match(h.raw('A'), /^ai-update-mode: "?fresh"?$/m);
  await h.view.history.undo().undo();
  await h.view.history.undo().undo();
  assert.equal(h.raw('A'), before, 'byte for byte');
});

test('save path: an emptied question removes the Prompt and `ai-card`', async () => {
  const h = await popoverHarness([['A', null, { prompt: 'Old question' }]]);
  await h.view.writeAiCard(h.node('A'), { title: '', question: '', sources: [], keepOld: true });
  assert.equal(h.raw('A').includes('Old question'), false);
  assert.equal(/^ai-card:/m.test(h.raw('A')), false);
  assert.equal(/^prompt:/m.test(h.raw('A')), false);
});

test('save path: a new card is made only on save; the popover blocks an empty question, Cmd/Ctrl+Enter saves, Esc writes nothing', async () => {
  const h = await popoverHarness([['A', null]]);
  const count = h.mapDoc.nodes.length;
  const past = h.view.history.past.length;
  h.view.openAiCardPopover(null, null);
  assert.equal(h.saveButton().disabled, true, 'empty question: cannot save');
  h.pop().keydown({ key: 'Enter', metaKey: true });
  await dom.tick(); await dom.tick();
  assert.equal(h.mapDoc.nodes.length, count, 'an empty question does not save');
  h.pop().keydown({ key: 'Escape' });
  assert.equal(h.view.aiCardOpen, null, 'Esc closes');
  await dom.tick(); await dom.tick();
  assert.equal(h.mapDoc.nodes.length, count, 'cancel makes no card');
  assert.equal(h.view.history.past.length, past, 'cancel writes nothing');
  h.view.openAiCardPopover(null, null);
  h.question().value = 'Brand new?';
  h.question().input();
  assert.equal(h.saveButton().disabled, false);
  h.pop().keydown({ key: 'Enter', ctrlKey: true });
  await until(() => h.mapDoc.nodes.length === count + 1);
  await until(() => h.view.history.past.length > past);
  const made = h.mapDoc.nodes.at(-1);
  assert.match(h.contents.get(made.path), /^ai-card: true$/m);
  assert.match(h.contents.get(made.path), /Brand new\?/);
});

test('removeSection("Prompt") leaves a Prompt-looking callout inside a code fence alone', () => {
  const { load, obsidian } = require('./support.cjs');
  const body = load('core/repository-note-body.ts', { obsidian });
  const note = [
    '## Current Summary', '', 'S', '',
    '```md', '> [!info]- Prompt', '> example in a code block', '```', '',
    '> [!info]- Prompt', '> Real question', ''
  ].join('\n');
  const out = body.removeSection(note, 'Prompt');
  assert.match(out, /```md\n> \[!info\]- Prompt\n> example in a code block\n```/);
  assert.equal(out.includes('Real question'), false);
});

test('blocked tooltip: names the failed child, or says so without a name when no child is failing now', async () => {
  const h = await harness([['P', null, { prompt: 'Parent?' }], ['C', 'P', { prompt: 'Child?' }]]);
  const note = id => h.view.notes.get(h.node(id).id);
  note('P').aiRun = { at: '2026-11-27T00:00:00.000Z', result: 'blocked' };
  note('C').aiRun = { at: '2026-11-27T00:00:00.000Z', result: 'failed' };
  h.view.aiStatusMemo?.clear?.();
  const named = h.view.aiStatusTip(h.node('P'), note('P'), 'failed');
  assert.match(named, /C/);
  note('C').aiRun = { at: '2026-11-27T00:01:00.000Z', result: 'ok', input: 'x' };
  h.view.aiStatusMemo?.clear?.();
  const unnamed = h.view.aiStatusTip(h.node('P'), note('P'), 'failed');
  assert.equal(/""|「」|“”/.test(unnamed), false, `no empty name: ${unnamed}`);
  assert.match(unnamed, /did not finish last time/);
});
