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
const contentLanguage = S.load('core/content-language.ts');
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
  eq(outcome, { done: 3, failed: 1, blocked: 2, stopped: false, noChange: 0, cancelled: 0, skipped: 0, reused: 0 });
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
    pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, expansionBatches: new Map(),
    recordFailure: (_l, e) => String(e?.message ?? e), views: () => [], mutate: async work => work(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    openDetails: async () => {}, invalidateLivingTrial() {}, restoreLivingOfficial: async () => {}, showLivingTrial: async () => {},
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
  const { VisualAgentMapView, setLivingIdentityStore: setViewIdentityStore, livingCoordinator: viewCoordinator } = S.load('tests/support-view-identity-entry.ts', { obsidian: { ...obsidian, Notice: dom.makeNotice(notices), Modal, Menu } }, { createFragment: dom.createFragment, CSS: { escape: v => v }, createSvg: dom.createSvg, createEl: (tag, value) => element(tag, value), createSpan: value => element('span', typeof value === 'string' ? { cls: value } : value), requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  const view = new VisualAgentMapView({ app }, attachTopicRuns(host));
  view.armHighlightFade = () => {};
  const hydrate = async () => { view.notes = new Map(await Promise.all(mapDoc.nodes.map(async n => [n.id, await repo.readNote(n.path, mapDoc)]))); };
  Object.assign(view, { path: MAP, map: mapDoc, contentEl: element('div'), stageEl: element('div'), render() {}, hydrate, ancestorContext: async () => '', queueCharts() {}, focusNode() {}, openDetails() {} });
  view.viewportEl = element('div');
  view.viewportEl.getBoundingClientRect = () => ({ left: 10, top: 5, right: 810, bottom: 605, width: 800, height: 600 });
  view.viewportEl.clientWidth = 800; view.viewportEl.clientHeight = 600;
  await hydrate();
  // Exercise the production execution path through the real Repository. Only the provider transport is stubbed.
  const plan = { fail: new Set(), errors: new Map(), reply: new Map(), hang: new Set(), pause: new Set(), waiters: [], go() { this.waiters.splice(0).forEach(resolve => resolve()); } };
  view.readMapSourceGroups = async () => [];
  host.aiCalls = { run: async (prepared, options, finish) => {
    const input = prepared.input;
    const key = JSON.parse(input.context).documents[0].title;
    calls.push({ key, input, options });
    if (plan.hang.has(key)) await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    if (options.signal.aborted) throw new Error('stopped');
    if (plan.pause.has(key)) await new Promise(resolve => plan.waiters.push(resolve));
    if (plan.fail.has(key)) throw new Error('provider failed: ' + key);
    if (plan.errors.has(key)) throw plan.errors.get(key);
    if (plan.reply.has(key)) return finish(plan.reply.get(key), { signal: options.signal, parsed() {} });
    const text = 'Result: ' + key;
    const operations = input.base.output.text === text ? [] : [{ kind: 'output', text, evidence: [] }];
    return finish(JSON.stringify({ baseRevision: input.base.revision, requiresWeb: false, operations }), { signal: options.signal, parsed() {} });
  } };
  const { inspectLivingValidity } = S.load('experiences/visual-map/living-node-runtime.ts', { obsidian });
  view.hydrate = async () => {
    await hydrate();
    view.livingValidity = await inspectLivingValidity({
      app, repo, calls: host.aiCalls, mapPath: MAP, viewSession: 'test-validity',
      signal: new AbortController().signal, current: () => true,
      language: () => 'English', mapSources: async () => [],
      onDependencies: graph => { view.livingGraph = graph; }
    });
  };
  // A second view of the same map on the same plugin (another pane or window).
  const otherView = async () => {
    const v = new VisualAgentMapView({ app }, attachTopicRuns(host));
    v.armHighlightFade = () => {};
    Object.assign(v, { path: MAP, map: mapDoc, contentEl: element('div'), stageEl: element('div'), render() {}, ancestorContext: async () => '', queueCharts() {}, focusNode() {}, openDetails() {} });
    v.viewportEl = view.viewportEl;
    v.readMapSourceGroups = async () => [];
    v.hydrate = async () => { v.notes = new Map(await Promise.all(mapDoc.nodes.map(async n => [n.id, await repo.readNote(n.path, mapDoc)]))); };
    await v.hydrate();
    return v;
  };
  // The round on its own, against a coordinator this test owns: used to hold a trial lease on a card.
  const runtime = S.load('experiences/visual-map/living-node-runtime.ts', { obsidian });
  const roundPort = () => {
    const seen = { settled: new Map(), boundary: undefined, failures: [] };
    const port = {
      app, repo, calls: host.aiCalls, coordinator: runtime.livingCoordinator(host), mapPath: MAP, viewSession: 'round-test',
      signal: new AbortController().signal, current: () => true, busy: () => false, language: (live, note) => contentLanguage.cardOutputLanguage(live, 'en', note.title), mapSources: async () => [],
      confirm: async (_model, work) => { await work(); return true; },
      onStart() {}, onRunning() {}, onSettled: (id, result) => seen.settled.set(id, result), onFailure: id => seen.failures.push(id),
      onTrialBoundary: boundary => { seen.boundary = boundary; }
    };
    return { port, seen, run: requested => runtime.runLivingRound(port, requested) };
  };
  const raw = key => contents.get(byKey.get(key).path);
  const node = key => byKey.get(key);
  const status = key => view.promptRuns.get(MAP)?.get(node(key).id)?.status;
  const done = () => until(() => view.promptBatch?.outcome);
  const runAll = async () => { view.startPromptRun(); };
  return { hold: () => (gate = []), repo, app, contents, view, host, calls, notices, menus, modals, usage, plan, raw, node, status, done, runAll, hydrate, mapDoc, byKey, otherView, roundPort, runtime, setViewIdentityStore, viewCoordinator };
}

// root -> mid -> leaf1, leaf2 ; root -> side
const TREE = [['root', null], ['mid', 'root'], ['leaf1', 'mid'], ['leaf2', 'mid'], ['side', 'root']];
const stamp = (h, key) => ({ at: h.raw(key).match(/^living-node-last-attempt: "(.*)"$/m)?.[1], result: h.raw(key).match(/^living-node-outcome: "(.*)"$/m)?.[1], input: h.raw(key).match(/^living-node-input-revision: "(.*)"$/m)?.[1] });
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
  assert.match(h.raw('A'), /ai-update-mode: "fresh"/, 'legacy mode survives conversion without controlling new execution');
  assert.equal(h.raw('A').replace(/^ai-update-mode: "fresh"\n/m, ''), before);
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
test('Run All: one call per unlocked AI card, dependency order, optional web on every card', async () => {
  const h = await harness(TREE);
  await h.runAll(); await h.done();
  assert.equal(h.modals.length, 0);
  assert.ok(h.usage.length >= 1);
  const keys = h.calls.map(c => c.key);
  assert.equal(keys.length, 5);
  assert.ok(keys.indexOf('leaf1') < keys.indexOf('mid'));
  assert.ok(keys.indexOf('leaf2') < keys.indexOf('mid'));
  assert.ok(keys.indexOf('side') < keys.indexOf('root'));
  assert.ok(keys.indexOf('mid') < keys.indexOf('root'));
  for (const call of h.calls) {
    assert.equal(call.options.task.webSearchOnly, true);
    assert.equal(call.options.task.optionalWebSearch, true);
  }
  eq(h.view.promptBatch.outcome, { done: 5, failed: 0, blocked: 0, stopped: false, noChange: 0, cancelled: 0, skipped: 0, reused: 0 });
  for (const [key] of TREE) assert.equal(stamp(h, key).result, 'ok');
  assert.match(h.raw('root'), /> Result: root/);
});

test('Run All: legacy fresh mode never deletes existing manual content', async () => {
  const h = await harness([['root', null, { fresh: true }], ['leaf', 'root', { fresh: true }]]);
  await h.repo.updateNote(h.node('leaf').path, { detail: 'User-owned history' });
  await h.runAll(); await h.done();
  assert.match(h.raw('leaf'), /User-owned history/);
  assert.equal(require('./support.cjs').obsidian.parseYaml(h.raw('leaf').match(/^---\r?\n([\s\S]*?)\r?\n---/)[1])['ai-update-mode'], 'fresh');
  assert.match(h.raw('leaf'), /Result: leaf/);
});

test('Run Card: valid dependencies are reused; a forced target runs even if valid', async () => {
  const h = await harness(TREE);
  await h.runAll(); await h.done();
  const count = h.calls.length;
  h.view.startPromptRun([h.node('root').id]);
  await h.done();
  assert.equal(h.calls.length, count + 1);
  assert.equal(h.calls.at(-1).key, 'root');
  assert.match(stamp(h, 'root').input, /^[0-9a-f]{64}$/);
});

test('failed upstream blocks dependent branches without altering their last success', async () => {
  const h = await harness(TREE);
  await h.runAll(); await h.done();
  const previous = stamp(h, 'mid').input;
  const oldContent = h.raw('mid').slice(h.raw('mid').indexOf('<!-- vam-living-node:begin'));
  h.plan.fail.add('leaf1');
  h.calls.length = 0;
  await h.runAll(); await h.done();
  assert.equal(h.calls.some(c => c.key === 'mid' || c.key === 'root'), false);
  assert.equal(stamp(h, 'leaf1').result, 'failed');
  assert.equal(stamp(h, 'mid').result, 'blocked');
  assert.equal(stamp(h, 'root').result, 'blocked');
  assert.equal(stamp(h, 'mid').input, previous);
  assert.equal(h.raw('mid').slice(h.raw('mid').indexOf('<!-- vam-living-node:begin')), oldContent);
});

test('ordinary Prompt card is a read-only boundary; its AI child still runs independently', async () => {
  const h = await harness([['root', null], ['mid', 'root', { noAi: true }], ['leaf', 'mid'], ['side', 'root']]);
  h.plan.fail.add('leaf');
  await h.runAll(); await h.done();
  assert.equal(h.calls.some(c => c.key === 'mid'), false);
  assert.equal(stamp(h, 'root').result, 'ok');
  assert.equal(stamp(h, 'mid').result, undefined);
});

test('locked empty dependency blocks parent but does not prune its unlocked descendants', async () => {
  const h = await harness([['root', null], ['l', 'root', { locked: true }], ['lc', 'l'], ['x', 'root']]);
  await h.runAll(); await h.done();
  assert.deepEqual(h.calls.map(c => c.key).sort(), ['lc', 'x']);
  assert.equal(stamp(h, 'l').result, undefined);
  assert.equal(stamp(h, 'lc').result, 'ok');
  assert.equal(stamp(h, 'root').result, 'blocked');
});

test('existing busy task refuses formal dispatch without writing', async () => {
  const h = await harness(TREE);
  h.host.running.add(h.node('leaf1').path);
  const before = TREE.map(([k]) => h.raw(k));
  await h.runAll(); await h.done();
  assert.equal(h.calls.length, 0);
  eq(TREE.map(([k]) => h.raw(k)), before);
  const g = await harness(TREE);
  g.host.expansionCoordinator.isRunning = () => true;
  await g.runAll(); await g.done();
  assert.equal(g.calls.length, 0);
});

test('refusing usage leaves all formal data unchanged', async () => {
  const h = await harness(TREE, { confirm: false });
  const before = TREE.map(([k]) => h.raw(k));
  await h.runAll(); await h.done();
  assert.ok(h.usage.length >= 1);
  assert.equal(h.calls.length, 0);
  eq(TREE.map(([k]) => h.raw(k)), before);
});

test('Stop rejects late result and retains already committed work', async () => {
  const h = await harness(TREE);
  h.plan.hang.add('mid');
  const rootBefore = h.raw('root');
  await h.runAll();
  await until(() => h.calls.some(c => c.key === 'mid'));
  const midBefore = h.raw('mid');
  h.view.stopPromptBatch(); await h.done();
  assert.equal(h.raw('mid'), midBefore);
  assert.equal(h.raw('root'), rootBefore);
  assert.equal(h.calls.some(c => c.key === 'root'), false);
  assert.equal(stamp(h, 'leaf1').result, 'ok');
  assert.equal(h.view.promptBatch.outcome.stopped, true);
});

test('closing view rejects in-flight writes and prevents subsequent provider calls', async () => {
  const h = await harness(TREE);
  h.plan.hang.add('leaf2');
  await h.runAll();
  await until(() => h.calls.some(c => c.key === 'leaf2'));
  const before = TREE.map(([k]) => h.raw(k));
  const calls = h.calls.length;
  try { await h.view.onClose(); } catch { /* the remaining DOM teardown needs real Obsidian */ }
  await h.done();
  assert.equal(h.calls.length, calls);
  eq(TREE.map(([k]) => h.raw(k)), before);
});

test('required explicit Markdown source missing blocks instead of skipping it', async () => {
  const h = await harness([['solo', null, { prompt: 'Find facts\nSources: [[Missing]]' }]]);
  await h.runAll(); await h.done();
  assert.equal(h.calls.length, 0);
  assert.equal(stamp(h, 'solo').result, 'blocked');
  const g = await harness([['solo', null, { prompt: 'Find facts\nSources: [[Ref]]' }]]);
  await g.app.vault.create('Notes/Ref.md', 'reference body');
  await g.runAll(); await g.done();
  assert.equal(g.calls.length, 1);
  assert.match(g.calls[0].input.context, /reference body/);
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

// ---- V3.3 P3.6: n / N only once the round is planned, and the last count (D2-2) ---------------------------------------
const MISSING = { prompt: 'Find facts\nSources: [[Missing]]' };
const countOf = h => {
  const bar = element('div');
  h.view.renderRunAllButton(bar);
  const button = find(bar, i => i.tag === 'button' && i.cls?.includes('is-running'));
  return { button, count: button && find(button, i => i.cls?.includes('vam-run-all-count'))?.text };
};

test('D2-2 progress: no "n / N" before the round is planned; N leaves out cards blocked before the start and locked cards', async () => {
  const h = await harness([...TREE, ['solo', null, MISSING], ['lk', null, { locked: true }]]);
  h.plan.hang.add('leaf1');
  await h.runAll();
  const early = countOf(h);
  assert.ok(early.button, 'the stop button shows at once');
  assert.equal(early.count, undefined, 'no "0 / 0" before the total is known');
  await until(() => h.calls.length === 1);
  assert.equal(countOf(h).count, '1 / 5', 'the blocked "solo" and the locked "lk" are not in N, nor counted as finished');
  h.view.stopPromptBatch(); await h.done();
  const g = await harness([['solo', null, MISSING]]);
  await g.runAll(); await g.done();
  assert.equal(g.view.promptBatch.total, 0, 'nothing to process: N is 0, so no "0 / 0" either');
  assert.equal(g.view.promptBatch.outcome.blocked, 1);
});

test('D2-2 last count: the end notice lists each class that happened; "done" is changed + no-change only, reused is not done', async () => {
  const h = await harness([...TREE, ['solo', null, MISSING]]);
  h.plan.fail.add('leaf1');
  await h.runAll(); await h.done();
  eq(h.view.promptBatch.outcome, { done: 2, failed: 1, blocked: 3, stopped: false, noChange: 0, cancelled: 0, skipped: 0, reused: 0 });
  assert.equal(h.notices.at(-1), 'Run finished: 2 done, 1 failed, 3 blocked');
  h.plan.fail.delete('leaf1');
  h.view.promptBatch = undefined;
  await h.runAll(); await h.done();
  // Run All forces every card: the two that were already done run again and write nothing new.
  eq(h.view.promptBatch.outcome, { done: 5, failed: 0, blocked: 1, stopped: false, noChange: 2, cancelled: 0, skipped: 0, reused: 0 });
  assert.equal(h.notices.at(-1), 'Run finished: 5 done (2 with no change), 1 blocked');
  // Run Card on root: its valid dependencies are reused, and reused is not done.
  h.view.promptBatch = undefined;
  h.view.startPromptRun([h.node('root').id]); await h.done();
  eq(h.view.promptBatch.outcome, { done: 1, failed: 0, blocked: 0, stopped: false, noChange: 1, cancelled: 0, skipped: 0, reused: 4 });
  assert.equal(h.notices.at(-1), 'Run finished: 1 done (1 with no change), 4 already up to date');
  const s = await harness(TREE);
  s.plan.hang.add('leaf1');
  await s.runAll();
  await until(() => s.calls.length === 1);
  s.view.stopPromptBatch(); await s.done();
  eq(s.view.promptBatch.outcome, { done: 0, failed: 0, blocked: 0, stopped: true, noChange: 0, cancelled: 5, skipped: 0, reused: 0 });
  assert.equal(s.notices.at(-1), 'Run stopped: 5 cancelled');
});

test('D2-2 chat: a run_living_* round where every card was already current says so, not "done"', async () => {
  const h = await harness(TREE);
  const first = await h.view.runChatSelection({ kind: 'run_map_action', action: 'run_living_all', nodeIds: [] });
  eq(first, { status: 'done' });
  // The planner forces its targets today, so a whole reused round comes from the round's count, stubbed here.
  const counts = { done: 0, failed: 0, blocked: 0, stopped: false, noChange: 0, cancelled: 0, skipped: 0 };
  h.view.runLivingBatch = async () => ({ ...counts, reused: 5 });
  for (const [action, nodeIds] of [['run_living_all', []], ['run_living_card', [h.node('side').id]]]) {
    const outcome = await h.view.runChatSelection({ kind: 'run_map_action', action, nodeIds });
    eq(outcome, { status: 'skipped', reason: 'already up to date, nothing was run' }, action);
  }
  h.view.runLivingBatch = async () => ({ ...counts, reused: 0 });
  eq(await h.view.runChatSelection({ kind: 'run_map_action', action: 'run_living_all', nodeIds: [] }), { status: 'skipped', reason: 'There are no Prompt topics to run.' });
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

test('D2-4 dependency highlight: selecting an AI card marks the planner edges in place; semantic lines never; no selection leaves the DOM as without a graph', async () => {
  const h = await harness([['A', null], ['B', 'A'], ['C', 'A'], ['O', 'A', { noAi: true }], ['D', 'C'], ['E', null], ['F', null, { noAi: true }]]);
  const { view } = h;
  const id = key => h.node(key).id;
  const refs = async (key, ...targets) => {
    const file = h.app.vault.getAbstractFileByPath(h.node(key).path);
    await h.app.vault.process(file, text => text.replace(/^---\n/, '---\nliving-node-refs:\n' + targets.map(t => `  - "card:${id(t)}"\n`).join('')));
  };
  await refs('B', 'D');
  await refs('A', 'E');
  // A-F is a semantic line; A-C is a parent and child that also hold a relation, so only the relation line is drawn.
  h.mapDoc.topicRelations = [{ kind: 'supports', from: id('A'), to: id('F') }, { kind: 'related', from: id('A'), to: id('C') }];
  await view.hydrate();
  assert.ok(view.livingGraph, 'the graph comes with the validity pass');
  view.cardEls = new Map(h.mapDoc.nodes.map((n, i) => [n.id, Object.assign(element('div'), { offsetLeft: i * 400, offsetTop: 0, offsetWidth: 100, offsetHeight: 50 })]));
  view.edgesEl = dom.createSvg('svg');
  view.relationsLayerEl = { children: [], replaceChildren() {}, appendChild() {} };
  const snap = () => JSON.stringify(view.edgesEl.children);
  const graph = view.livingGraph;
  view.livingGraph = undefined;
  view.drawEdges();
  const noGraph = snap();
  view.livingGraph = graph;
  view.drawEdges();
  const before = snap();
  assert.equal(before, noGraph, 'a graph with no selection changes nothing');
  let draws = 0;
  const draw = view.drawEdges;
  view.drawEdges = function () { draws++; return draw.call(this); };
  const marked = cls => view.edgesEl.children.filter(c => c.classes?.includes(cls));
  const pair = c => c.getAttribute('data-dep') ?? [...view.edgeEls].find(([, p]) => p === c)?.[0];
  const keyName = new Map(h.mapDoc.nodes.map(n => [n.id, [...h.byKey].find(([, v]) => v.id === n.id)[0]]));
  const label = list => list.map(c => pair(c).split('\u0000').map(x => keyName.get(x)).join('>')).sort();
  view.applySelectionChange(view.selection.click(id('A')));
  assert.deepEqual(label(marked('is-dep-run')), ['A>B', 'A>C', 'A>E', 'B>D', 'C>D']);
  assert.deepEqual(label(marked('is-dep-read')), ['A>O']);
  const overlays = marked('vam-edge-dep-overlay');
  assert.deepEqual(label(overlays), ['A>C', 'A>E', 'B>D'], 'pairs without a drawn tree line get an overlay');
  assert.ok(overlays.every(o => o.getAttribute('d')), 'each overlay has a path');
  assert.equal(view.edgesEl.children.at(-1), overlays.at(-1), 'overlays sit on top');
  for (const path of view.relationEls.values()) assert.equal(path.classes.some(c => c.startsWith('is-dep')), false, 'semantic lines never');
  view.applySelectionChange(view.selection.click(id('O')));
  assert.equal(marked('is-dep-run').length + marked('is-dep-read').length, 0, 'an ordinary card highlights nothing');
  view.applySelectionChange(view.selection.click(id('A')));
  view.applySelectionChange(view.selection.clickEmpty());
  assert.equal(snap(), before, 'clearing the selection restores the DOM');
  assert.equal(draws, 0, 'selection never redraws the edges');
});

test('D2-4 dependency highlight: a structural change drops the stale graph (no highlight until the next hydrate); a position-only change keeps it', async () => {
  const h = await harness([['A', null], ['B', 'A'], ['X', null]]);
  const { view } = h;
  const id = key => h.node(key).id;
  await view.hydrate();
  assert.ok(view.livingGraph);
  view.render = () => {};
  const setup = () => {
    view.cardEls = new Map(view.map.nodes.map((n, i) => [n.id, Object.assign(element('div'), { offsetLeft: i * 400, offsetTop: 0, offsetWidth: 100, offsetHeight: 50 })]));
    view.edgesEl = dom.createSvg('svg');
    view.relationsLayerEl = { children: [], replaceChildren() {}, appendChild() {} };
    view.drawEdges();
  };
  const marks = () => view.edgesEl.children.filter(c => c.classes?.some(cls => cls.startsWith('is-dep') || cls === 'vam-edge-dep-overlay'));
  // Position only (and the sibling order, as a drop among siblings rewrites it): the planner sees the same cards.
  await view.mapChange(map => {
    map.nodes.find(n => n.id === id('B')).x += 40;
    map.nodes.reverse();
  });
  assert.ok(view.livingGraph, 'a position-only write keeps the graph');
  await view.mapChange(map => { map.nodes.find(n => n.id === id('B')).parentId = id('X'); });
  setup();
  view.applySelectionChange(view.selection.click(id('A')));
  assert.equal(marks().length, 0, 'the old parent shows no A>B line or overlay');
  view.applySelectionChange(view.selection.click(id('X')));
  assert.equal(marks().length, 0, 'the new parent waits for the next hydrate');
  await view.hydrate();
  setup();
  view.applySelectionChange(view.selection.click(id('X')));
  assert.equal(marks().filter(c => c.classes.includes('is-dep-run')).length, 1, 'after hydrate X marks X>B');
});

test('D2-4 dependency highlight: an AI child reading its ordinary parent marks the tree line, no overlay', async () => {
  const h = await harness([['P', null, { noAi: true }], ['C', 'P']]);
  const { view } = h;
  const file = h.app.vault.getAbstractFileByPath(h.node('C').path);
  await h.app.vault.process(file, text => text.replace(/^---\n/, '---\nliving-node-refs:\n' + `  - "card:${h.node('P').id}"\n`));
  await view.hydrate();
  view.cardEls = new Map(h.mapDoc.nodes.map((n, i) => [n.id, Object.assign(element('div'), { offsetLeft: i * 400, offsetTop: 0, offsetWidth: 100, offsetHeight: 50 })]));
  view.edgesEl = dom.createSvg('svg');
  view.relationsLayerEl = { children: [], replaceChildren() {}, appendChild() {} };
  view.drawEdges();
  view.applySelectionChange(view.selection.click(h.node('C').id));
  const tree = view.edgeEls.get(`${h.node('P').id}\u0000${h.node('C').id}`);
  assert.ok(tree.classes.includes('is-dep-read'));
  assert.equal(view.edgesEl.children.filter(c => c.classes?.includes('vam-edge-dep-overlay')).length, 0);
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

test('V3.3 P1.2 / D2-3: running, waiting, failed, blocked, stopped and stale AI cards say their state in the header with a mark and words; pending keeps its glyph; done and locked say nothing here', async () => {
  const h = await harness([['a', null, { prompt: 'Why?' }]]);
  const node = h.node('a');
  const face = () => {
    const card = element('div'), header = card.createDiv({ cls: 'vam-node-header' }), title = card.createEl('h3', { cls: 'vam-card-title' }), tools = card.createDiv({ cls: 'vam-node-tools' });
    return { card, header, title, tools };
  };
  const paint = (status, extra = {}) => {
    const f = face();
    h.view.aiStatusMemo.set(node.id, status);
    h.view.paintPromptState(f.card, f.header, node, { ...h.view.notes.get(node.id), ...extra });
    return f;
  };
  const chips = header => findAll(header, i => i.cls?.split(' ').includes('vam-status'));
  for (const [status, cls, text] of [['running', 'vam-status-running', 'Running'], ['waiting', 'vam-status-waiting', 'Waiting'], ['stale', 'vam-status-stale', 'Needs rerun'], ['failed', 'vam-status-failed', 'Failed'], ['blocked', 'vam-status-blocked', 'Blocked'], ['stopped', 'vam-status-stopped', 'Stopped']]) {
    const f = paint(status);
    const [chip, ...rest] = chips(f.header);
    assert.equal(rest.length, 0, `${status}: one label`);
    assert.ok(chip?.cls.includes(cls), `${status}: ${chip?.cls}`);
    assert.equal(chip.text, text, `${status}: words, not only a colour`);
    assert.equal(findAll(f.title, i => i.cls?.includes('vam-ai-glyph')).length, 0, `${status}: the header label replaces the title glyph`);
    h.view.paintPromptState(f.card, f.header, node, h.view.notes.get(node.id));
    assert.equal(chips(f.header).length, 1, `${status}: repainting does not stack labels`);
  }
  for (const status of ['done', 'pending']) assert.equal(chips(paint(status).header).length, 0, `${status}: no header label`);
  assert.equal(chips(paint('stale', { aiLocked: true }).header).length, 0, 'locked: the lock label takes the place');
  assert.equal(find(paint('pending').title, i => i.cls?.includes('vam-ai-glyph-pending'))?.attrs.title.split('\n')[0], 'Not run yet', 'pending: its glyph has words too');
});

test('D2-3 card face: a failed, blocked or stopped card whose knowledge is out of date shows both labels; repainting keeps two', async () => {
  const h = await harness([['a', null, { prompt: 'Why?' }]]);
  const node = h.node('a');
  h.view.livingValidity.set(node.id, 'stale');
  for (const [status, text] of [['failed', 'Failed'], ['blocked', 'Blocked'], ['stopped', 'Stopped']]) {
    const card = element('div'), header = card.createDiv({ cls: 'vam-node-header' });
    card.createEl('h3', { cls: 'vam-card-title' });
    const texts = () => findAll(header, i => i.cls?.split(' ').includes('vam-status')).map(i => i.text);
    h.view.aiStatusMemo.set(node.id, status);
    h.view.paintPromptState(card, header, node, h.view.notes.get(node.id));
    eq(texts(), [text, 'Needs rerun'], status);
    h.view.paintPromptState(card, header, node, h.view.notes.get(node.id));
    eq(texts(), [text, 'Needs rerun'], `${status}: repainting does not stack labels`);
  }
  h.view.livingValidity.set(node.id, 'valid');
  const card = element('div'), header = card.createDiv({ cls: 'vam-node-header' });
  card.createEl('h3', { cls: 'vam-card-title' });
  h.view.aiStatusMemo.set(node.id, 'failed');
  h.view.paintPromptState(card, header, node, h.view.notes.get(node.id));
  eq(findAll(header, i => i.cls?.split(' ').includes('vam-status')).map(i => i.text), ['Failed'], 'old knowledge still valid: no rerun label');
});

test('D2-3 real round: queued cards wait, the running one runs, a blocked one says blocked; Stop leaves the unreached ones stopped', async () => {
  const h = await harness([...TREE, ['solo', null, MISSING]]);
  h.plan.hang.add('leaf1');
  await h.runAll();
  await until(() => h.calls.some(c => c.key === 'leaf1'));
  const state = key => { h.view.aiStatusMemo.clear(); return h.view.aiStatusOf(h.node(key).id); };
  eq(['leaf1', 'mid', 'root', 'solo'].map(state), ['running', 'waiting', 'waiting', 'blocked']);
  h.view.stopPromptBatch(); await h.done();
  eq(['leaf1', 'mid', 'root', 'solo'].map(state), ['stopped', 'stopped', 'stopped', 'blocked'], 'after the round');
  const f = await harness(TREE);
  f.plan.fail.add('leaf1');
  await f.runAll(); await f.done();
  f.view.aiStatusMemo.clear();
  eq(['leaf1', 'mid', 'root'].map(key => f.view.aiStatusOf(f.node(key).id)), ['failed', 'blocked', 'blocked'], 'a failure is "failed", the cards that needed it "blocked"');
});

test('D2-3 Stop: a locked card was never part of the round, so it is skipped in the count and not stopped on its face', async () => {
  const h = await harness([...TREE, ['lk', null, { locked: true }]]);
  h.plan.hang.add('leaf1');
  // The toolbar refuses a locked target; a caller that does not (chat tools) puts it in the round as excluded.
  void h.view.runLivingBatch([h.node('root').id, h.node('lk').id]);
  await until(() => h.calls.some(c => c.key === 'leaf1'));
  h.view.stopPromptBatch(); await h.done();
  eq(h.view.promptBatch.outcome, { done: 1, failed: 0, blocked: 0, stopped: true, noChange: 0, cancelled: 4, skipped: 1, reused: 0 });
  assert.equal(h.notices.at(-1), 'Run stopped: 1 done, 4 cancelled, 1 skipped');
  h.view.aiStatusMemo.clear();
  assert.notEqual(h.view.aiStatusOf(h.node('lk').id), 'stopped');
  assert.equal(h.view.aiStatusOf(h.node('leaf1').id), 'stopped');
});

test('D2-3 Stop before the round is planned still says the run stopped', async () => {
  const h = await harness(TREE);
  await h.runAll();
  h.view.stopPromptBatch(); await h.done();
  assert.equal(h.calls.length, 0);
  assert.equal(h.view.promptBatch.outcome.stopped, true);
  assert.equal(h.notices.at(-1), 'Run stopped: no card ran');
});

test('V3.3 P1.2: a running AI card of Run all offers Stop in its toolbar (shown with the selection); other states do not', async () => {
  const h = await harness([['a', null, { prompt: 'Why?' }]]);
  const node = h.node('a');
  // The real card (renderNode) so the toolbar is the one paintPromptState repaints; the card label needs a real DOM.
  h.view.labelCard = () => {};
  const paint = status => {
    h.view.aiStatusMemo.set(node.id, status);
    h.view.renderNode(node);
    const card = h.view.cardEls.get(node.id);
    const header = find(card, i => i.cls?.includes('vam-node-header')), tools = find(card, i => i.cls?.includes('vam-node-tools'));
    return { card, header, tools };
  };
  let stopped = 0; h.view.stopPromptBatch = () => { stopped++; };
  h.view.promptBatch = { outcome: null, controller: new AbortController() };
  h.view.promptEntryOf = () => ({ status: 'running' });
  const running = paint('running');
  const stop = find(running.tools, i => i.tag === 'button' && i.text === 'Stop');
  assert.ok(stop, 'Stop in the toolbar');
  stop.click();
  assert.equal(stopped, 1);
  h.view.paintPromptState(running.card, running.header, node, h.view.notes.get(node.id));
  assert.equal(findAll(running.tools, i => i.tag === 'button' && i.text === 'Stop').length, 1, 'repainting keeps one Stop');
  assert.equal(find(paint('stale').tools, i => i.tag === 'button' && i.text === 'Stop'), undefined);
  h.view.promptBatch = null;
});

// ---- review fixes: stale state between batches, popover prefill, save path ----------------------------------------------
test('two batches: a card not yet reached by batch 2 is not shown done from batch 1 (waiting, its knowledge stale after a Prompt edit)', async () => {
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
  assert.equal(h.status('X'), 'waiting', 'batch 2 queued X; batch 1 left nothing for it');
  h.view.aiStatusMemo.clear();
  assert.equal(h.view.aiStatusOf(h.node('X').id), 'waiting', 'not reached yet: waiting, never done');
  assert.equal(h.view.livingValidity.get(h.node('X').id), 'stale', 'its knowledge is still out of date');
  h.view.stopPromptBatch(); await h.done();
});

const popoverHarness = async (spec, options) => {
  const h = await harness(spec, options);
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

test('popover room (D1-x10): a pane squeezed under 320px by Obsidian side panels folds them, left first, until the editor fits; a wide pane folds nothing', async () => {
  const dock = () => ({ collapsed: false, collapse() { this.collapsed = true; }, expand() { this.collapsed = false; } });
  const narrow = await popoverHarness([['A', null, { prompt: 'Why?' }]]);
  const left = dock(), right = dock();
  narrow.view.app.workspace = { ...narrow.view.app.workspace, leftSplit: left, rightSplit: right };
  narrow.overlay.clientWidth = 42;
  narrow.view.openAiCardPopover(narrow.node('A'));
  assert.deepEqual([left.collapsed, right.collapsed], [true, false], 'opening folds the left panel first');
  narrow.view.makeRoomForAiCard();
  assert.deepEqual([left.collapsed, right.collapsed], [true, true], 'still narrow after the layout settled: the right panel folds too');
  const wide = await popoverHarness([['A', null, { prompt: 'Why?' }]]);
  const l2 = dock(), r2 = dock();
  wide.view.app.workspace = { ...wide.view.app.workspace, leftSplit: l2, rightSplit: r2 };
  wide.overlay.clientWidth = 504;
  wide.view.openAiCardPopover(wide.node('A'));
  assert.deepEqual([l2.collapsed, r2.collapsed], [false, false], 'a pane with room keeps both panels');
});

test('popover room (D1-x10b): a panel the user opens again while the editor is open is never folded again', async () => {
  const dock = () => ({ collapsed: false, collapse() { this.collapsed = true; }, expand() { this.collapsed = false; } });
  const h = await popoverHarness([['A', null, { prompt: 'Why?' }]]);
  const left = dock(), right = dock();
  h.view.app.workspace = { ...h.view.app.workspace, leftSplit: left, rightSplit: right };
  h.overlay.clientWidth = 42;
  h.view.openAiCardPopover(h.node('A'));
  h.view.makeRoomForAiCard();
  assert.deepEqual([left.collapsed, right.collapsed], [true, true], 'both panels folded once to make room');
  left.expand();
  right.expand();
  h.view.makeRoomForAiCard();
  h.view.makeRoomForAiCard();
  assert.deepEqual([left.collapsed, right.collapsed], [false, false], 'the user reopened both: the next resizes leave them open');
});

test('popover room (D1-x10b): closing the editor reopens only the panel it folded, not one the user folded', async () => {
  const dock = collapsed => ({ collapsed, collapse() { this.collapsed = true; }, expand() { this.collapsed = false; } });
  const h = await popoverHarness([['A', null, { prompt: 'Why?' }]]);
  const left = dock(true), right = dock(false);
  h.view.app.workspace = { ...h.view.app.workspace, leftSplit: left, rightSplit: right };
  h.overlay.clientWidth = 42;
  h.view.openAiCardPopover(h.node('A'));
  assert.deepEqual([left.collapsed, right.collapsed], [true, true], 'the user had folded the left; the editor folds the right');
  h.pop().keydown({ key: 'Escape' });
  assert.equal(h.view.aiCardOpen, null);
  assert.deepEqual([left.collapsed, right.collapsed], [true, false], 'closing reopens the right only; the user\'s left fold stays');
});

test('popover close: Esc, Close or discard returns focus to the card it was opened from (A34)', async () => {
  const h = await popoverHarness([['A', null, { prompt: 'Why?' }]]);
  const restored = [];
  h.view.restoreMapFocusSoon = id => restored.push(id);
  h.view.openAiCardPopover(h.node('A'));
  h.pop().keydown({ key: 'Escape' });
  assert.equal(h.view.aiCardOpen, null);
  eq(restored, [h.node('A').id]);
  // P3.3: back on the canvas, the viewport and the selection are what they were before the editor opened, also after "discard".
  const g = await popoverHarness([['A', null, { prompt: 'Why?' }]]);
  const back = [];
  g.view.restoreMapFocusSoon = id => back.push(id);
  g.view.map.viewport = { x: -120, y: 45, zoom: 1.5 };
  g.view.selection.replaceMulti([g.node('A').id]);
  const before = canvasState(g);
  g.view.openAiCardPopover(g.node('A'));
  g.pop().keydown({ key: 'Escape' });
  eq(canvasState(g), before);
  assert.equal(g.view.aiCardOpen, null);
  g.view.openAiCardPopover(g.node('A'));
  g.question().value = 'Changed?'; g.question().input();
  g.pop().keydown({ key: 'Escape' });
  assert.ok(g.view.aiCardOpen, 'unsaved changes: the choices come first');
  find(g.pop(), i => i.tag === 'button' && i.text === 'Discard').click();
  assert.equal(g.view.aiCardOpen, null);
  eq(canvasState(g), before);
  eq(back, [g.node('A').id, g.node('A').id]);
});

// P3.3: the central editor's close choices, draft guard and refusals.
const canvasState = h => {
  const s = h.view.selection.state;
  return { viewport: h.view.map.viewport, selected: s.selected, multi: [...s.multiSelected].sort(), mode: s.multiSelectMode };
};
const choices = h => find(h.pop(), i => i.cls?.includes('vam-living-editor-close-choices'));
const choice = (h, text) => find(choices(h), i => i.tag === 'button' && i.text === text);
const type = (h, text) => { h.question().value = text; h.question().input(); };

test('P3.3 save and close: one history step, the viewport stays, the editor closes', async () => {
  const h = await popoverHarness([['A', null, { prompt: 'Old' }]]);
  h.view.map.viewport = { x: -120, y: 45, zoom: 1.5 };
  const before = canvasState(h);
  const past = h.view.history.past.length;
  h.view.openAiCardPopover(h.node('A'));
  type(h, 'New question');
  h.pop().keydown({ key: 'Escape' });
  assert.equal(choices(h).hidden, false);
  choice(h, 'Save').click();
  await until(() => h.view.aiCardOpen === null);
  assert.equal(h.view.history.past.length, past + 1);
  assert.match(h.raw('A'), /New question/);
  eq(canvasState(h), before);
});

test('P3.3 return: the editor stays open, the draft is kept and the focus is on the Prompt field', async () => {
  const h = await popoverHarness([['A', null, { prompt: 'Old' }]]);
  h.view.openAiCardPopover(h.node('A'));
  type(h, 'Draft');
  h.pop().keydown({ key: 'Escape' });
  assert.equal(choices(h).hidden, false);
  choice(h, 'Return').click();
  assert.equal(choices(h).hidden, true);
  assert.ok(h.view.aiCardOpen);
  assert.equal(h.question().value, 'Draft');
  assert.equal(dom.focusedNow(), h.question());
  assert.match(h.raw('A'), /Old/);
});

test('P3.3 another card with unsaved changes: the editor stays on the original card and shows the close choices', async () => {
  const h = await popoverHarness([['A', null, { prompt: 'Old' }], ['B', null, { prompt: 'Other' }]]);
  h.view.openAiCardPopover(h.node('A'));
  type(h, 'Draft');
  const win = h.view.aiCardOpen.win;
  h.view.openAiCardPopover(h.node('B'));
  assert.equal(h.view.aiCardOpen.win, win);
  assert.equal(h.view.aiCardOpen.nodeId, h.node('A').id);
  assert.equal(choices(h).hidden, false);
  assert.equal(h.question().value, 'Draft');
});

test('P3.3 a [[link]] in the Prompt body (not on the sources line) is not saved as a source', async () => {
  const h = await popoverHarness([['A', null, { prompt: 'Old' }], ['N', null, { noAi: true }]]);
  h.view.openAiCardPopover(h.node('A'));
  type(h, 'Compare with [[N]] in the text');
  h.saveButton().click();
  await until(() => /Compare with/.test(h.raw('A')));
  assert.match(h.raw('A'), /\[\[N\]\]/, 'the text is kept as written');
  assert.match(h.raw('A'), /^living-node-refs: \[\]$/m, 'no source recorded');
  assert.equal(h.raw('A').includes('card:' + h.node('N').id), false);
});

for (const [name, change] of [
  ['its Prompt', h => h.repo.updateNote(h.node('A').path, { prompt: 'Changed elsewhere' })],
  ['only its configuration (revision)', h => h.repo.writeAiCard(h.node('A').path, false)]
]) test(`P3.3 ${name} changed elsewhere while the editor is open: the save is refused, the draft and the editor stay`, async () => {
  const h = await popoverHarness([['A', null, { prompt: 'Old' }]]);
  const { plainFailure } = S.load('ai/plain-error.ts', { obsidian });
  h.host.recordFailure = (context, error) => plainFailure(context, error); // as the plugin does
  h.view.openAiCardPopover(h.node('A'));
  type(h, 'My draft');
  await change(h);
  const outside = h.raw('A');
  const past = h.view.history.past.length;
  h.saveButton().click();
  await until(() => h.notices.length > 0);
  await dom.tick(); await dom.tick();
  assert.match(h.notices.join('\n'), /changed elsewhere/i, 'says why: changed elsewhere, draft kept');
  assert.ok(h.view.aiCardOpen, 'the editor stays open');
  assert.equal(h.question().value, 'My draft');
  assert.equal(h.raw('A'), outside, 'nothing was written');
  assert.equal(h.view.history.past.length, past);
});

test('P3.3 a refused save says why in plain words, not a raw code', async () => {
  const h = await popoverHarness([['A', null, { prompt: 'Old' }]]);
  const { plainFailure } = S.load('ai/plain-error.ts', { obsidian });
  h.host.recordFailure = (context, error) => plainFailure(context, error); // as the plugin does
  h.view.openAiCardPopover(h.node('A'));
  type(h, 'Why?\nSources: [[A]]');
  h.saveButton().click();
  await until(() => h.notices.length > 0);
  assert.equal(/self-reference/.test(h.notices.join('\n')), false, h.notices.join('\n'));
  assert.match(h.notices.join('\n'), /itself/i);
  assert.ok(h.view.aiCardOpen);
});

test('P3.3 batch UI: a refused save shows one notice, not a raw code first and the plain reason second', async () => {
  const h = await popoverHarness([['A', null, { prompt: 'Old' }]]);
  const { plainFailure } = S.load('ai/plain-error.ts', { obsidian });
  h.host.recordFailure = (context, error) => plainFailure(context, error);
  // As main.ts mutate(): every error that leaves the queued work also raises its own notice.
  h.host.mutate = work => { const result = Promise.resolve().then(work); result.catch(error => h.notices.push(String(error?.message ?? error))); return result; };
  h.view.openAiCardPopover(h.node('A'));
  type(h, 'My draft');
  await h.repo.updateNote(h.node('A').path, { prompt: 'Changed elsewhere' });
  h.saveButton().click();
  await until(() => h.notices.length > 0);
  await dom.tick(); await dom.tick();
  const shown = h.notices.map(n => String(n.message ?? n));
  assert.equal(shown.length, 1, shown.join(' | '));
  assert.equal(/changed-configuration/.test(shown[0]), false, shown[0]);
});

test('P3.3 refusal reasons are localized in English, Traditional and Simplified Chinese; an unknown code gives none', () => {
  const ui = require('./support-replay.cjs').loadSource(`
export { livingSaveReason } from "./experiences/visual-map/living-node-trial-reason";
export { setUiLanguage, t } from "./i18n";
`, { obsidian });
  const codes = ['empty-prompt', 'self-reference', 'living-node-cycle', 'map-file-source', 'unauthorized-source', 'missing-source', 'ambiguous-source', 'changed-configuration', 'changed-target'];
  const seen = new Map();
  try {
    for (const language of ['en', 'zh-TW', 'zh-CN']) {
      ui.setUiLanguage(language);
      for (const code of codes) {
        const key = ui.livingSaveReason(new Error(code));
        assert.ok(key, code);
        const text = ui.t(key);
        assert.ok(text && text !== key && !text.includes(code), `${language} ${code}: ${text}`);
        if (!seen.has(code)) seen.set(code, new Set());
        seen.get(code).add(text);
      }
    }
  } finally { ui.setUiLanguage('en'); }
  for (const [code, texts] of seen) assert.equal(texts.size, 3, `${code}: three languages`);
  assert.equal(ui.livingSaveReason(new Error('some free text')), null);
});

test('save path: existing AI card is one undoable configuration edit; source IDs and manual content are preserved', async () => {
  const h = await popoverHarness([['A', null, { prompt: 'Old' }], ['N', null, { noAi: true }]]);
  const before = h.raw('A');
  const past = h.view.history.past.length;
  await h.view.writeAiCard(h.node('A'), { title: '', question: 'New Q', sources: ['N'], keepOld: true }, 'Old', undefined, () => true);
  assert.equal(h.view.history.past.length, past + 1);
  assert.match(h.raw('A'), /^ai-card: true$/m);
  assert.ok(h.raw('A').includes('card:' + h.node('N').id));
  assert.match(h.raw('A'), /New Q/);
  assert.equal(h.calls.length, 0);
  await h.view.history.undo().undo();
  assert.equal(h.raw('A'), before);
});

test('save path: blank prompt is refused; explicit conversion retains configuration and knowledge', async () => {
  const h = await popoverHarness([['A', null, { prompt: 'Old question' }]]);
  const before = h.raw('A');
  await assert.rejects(() => h.view.writeAiCard(h.node('A'), { title: '', question: '', sources: [], keepOld: true }, 'Old question', undefined, () => true), /empty-prompt/);
  assert.equal(h.raw('A'), before);
  await h.repo.writeAiCard(h.node('A').path, false);
  assert.match(h.raw('A'), /Old question/);
  assert.doesNotMatch(h.raw('A'), /^ai-card:/m);
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

test('P3.2 cancelling a new AI card (switch map, close view, Esc) leaves nothing; only Cmd/Ctrl+Enter makes the card, and one undo removes it', async () => {
  const { actionsFor } = S.load('experiences/visual-map/card-actions.ts', { obsidian });
  const snapshot = h => JSON.stringify([...h.contents.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  const runActions = h => ['toolbar', 'more', 'context', 'command'].flatMap(surface =>
    [...actionsFor(surface, h.view.cardActionContext(null)), ...h.mapDoc.nodes.flatMap(n => [...actionsFor(surface, h.view.cardActionContext(n))])]
      .map(entry => entry.action.id).filter(id => id === 'run-stop' || id === 'run-card'));
  const leaves = [
    ['switching map', h => h.view.openMapInMutation('Agent Workspace/Topics/other/Map.md').catch(() => {})],
    ['closing the view', h => h.view.onClose().catch(() => {})],
    // Esc on a typed draft only offers Save / Discard / Keep editing (nothing is written, the editor stays); Discard closes it.
    ['Esc then Discard', h => {
      const choices = find(h.pop(), i => i.cls?.includes('vam-living-editor-close-choices'));
      h.pop().keydown({ key: 'Escape' });
      assert.equal(choices.hidden, false, 'Esc on a draft asks first');
      assert.equal(h.view.aiCardOpen === null, false, 'the editor is still open');
      assert.equal(h.mapDoc.nodes.length, 1, 'and nothing was made yet');
      find(choices, i => i.tag === 'button' && i.text === 'Discard').click();
    }]
  ];
  for (const [name, leave] of leaves) {
    const h = await popoverHarness([['A', null, { noAi: true, prompt: '' }]]);
    const count = h.mapDoc.nodes.length;
    const past = h.view.history.past.length;
    const before = snapshot(h);
    h.view.openAiCardPopover(null, null);
    h.question().value = 'A draft not yet saved?';
    h.question().input();
    assert.equal(h.saveButton().disabled, false, `${name}: the draft is ready to save`);
    await leave(h);
    await dom.tick(); await dom.tick();
    assert.equal(h.view.aiCardOpen, null, `${name}: the editor is closed`);
    assert.equal(findAll(h.overlay, i => i.cls?.includes('vam-living-editor')).length, 0, `${name}: no .vam-living-editor left`);
    assert.equal(snapshot(h), before, `${name}: Map.md and every note byte for byte`);
    assert.equal(h.mapDoc.nodes.length, count, `${name}: no card`);
    assert.equal(h.view.history.past.length, past, `${name}: no history entry`);
    assert.equal(h.calls.length, 0, `${name}: no AI call`);
    eq(runActions(h), [], `${name}: no run-stop / run-card anywhere`);
  }
  // Control: Cmd/Ctrl+Enter is the one way a card appears.
  const h = await popoverHarness([['A', null, { noAi: true, prompt: '' }]]);
  const count = h.mapDoc.nodes.length;
  const past = h.view.history.past.length;
  h.view.openAiCardPopover(null, null);
  h.question().value = 'Saved?';
  h.question().input();
  h.pop().keydown({ key: 'Enter', ctrlKey: true });
  await until(() => h.mapDoc.nodes.length === count + 1);
  await until(() => h.view.history.past.length === past + 1);
  const made = h.mapDoc.nodes.at(-1);
  assert.match(h.contents.get(made.path), /^ai-card: true$/m);
  await h.view.history.undoEntry.undo();
  assert.equal(h.mapDoc.nodes.length, count, 'one undo removes the card');
  assert.equal(h.contents.has(made.path), false, 'and its note');
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

test('failed status tooltip retains latest successful check and last attempt independently', async () => {
  const h = await harness([['P', null]]);
  const note = h.view.notes.get(h.node('P').id);
  note.livingNode = { summary: 'Old result', knowledgeRevision: 'r1', outcome: 'failed', damaged: false,
    lastSuccessfulCheck: '2026-11-27T00:00:00.000Z', lastAttempt: '2026-11-27T01:00:00.000Z' };
  const tip = h.view.aiStatusTip(h.node('P'), note, 'failed');
  assert.match(tip, /2026-11-27T00:00:00.000Z/);
  assert.match(tip, /2026-11-27T01:00:00.000Z/);
});

// ---- one formal run per map (T02) -------------------------------------------------------------------------------------
const closeView = async v => { try { await v.onClose(); } catch { /* the remaining DOM teardown needs real Obsidian */ } };

test('two views: a second view joins the running progress instead of starting or failing', async () => {
  const h = await harness(TREE);
  const second = await h.otherView();
  h.plan.pause.add('leaf1');
  await h.runAll();
  await until(() => h.calls.length === 1);
  second.startPromptRun();
  assert.ok(second.promptBatch && !second.promptBatch.outcome, 'the second view shows the progress');
  assert.equal(second.promptBatch.total, h.view.promptBatch.total);
  assert.ok(second.promptBatch.total > 0);
  assert.equal(h.calls.length, 1, 'no second round');
  assert.ok(h.notices.length >= 1);
  assert.ok(second.promptRunning());
  h.plan.go();
  await until(() => h.view.promptBatch.outcome && second.promptBatch.outcome);
  eq(second.promptBatch.outcome, { done: 5, failed: 0, blocked: 0, stopped: false, noChange: 0, cancelled: 0, skipped: 0, reused: 0 });
  eq(h.view.promptBatch.outcome, { done: 5, failed: 0, blocked: 0, stopped: false, noChange: 0, cancelled: 0, skipped: 0, reused: 0 });
  assert.equal(h.calls.length, 5);
  assert.equal(second.promptBatch.finished, second.promptBatch.total);
  assert.equal(h.status('root'), 'done');
});

test('Run Card while Run All runs: another view joins, the same view is told it is running', async () => {
  const h = await harness(TREE);
  const second = await h.otherView();
  h.plan.pause.add('leaf1');
  await h.runAll();
  await until(() => h.calls.length === 1);
  const before = h.notices.length;
  h.view.startPromptRun([h.node('side').id]);
  assert.equal(h.notices.length, before + 1, 'the same view keeps the "already running" notice');
  second.startPromptRun([h.node('side').id]);
  assert.ok(second.promptBatch && !second.promptBatch.outcome);
  assert.equal(h.calls.length, 1);
  h.plan.go();
  await until(() => h.view.promptBatch.outcome && second.promptBatch.outcome);
  assert.equal(h.calls.length, 5, 'the run was the one Run All');
});

test('second-view cancel stops the shared run for every view', async () => {
  const h = await harness(TREE);
  const second = await h.otherView();
  h.plan.hang.add('leaf1');
  await h.runAll();
  await until(() => h.calls.length === 1);
  second.startPromptRun();
  second.stopPromptBatch();
  await until(() => h.view.promptBatch.outcome && second.promptBatch.outcome);
  assert.equal(h.view.promptBatch.outcome.stopped, true);
  assert.equal(second.promptBatch.outcome.stopped, true);
  assert.equal(h.calls.some(c => c.key === 'root'), false);
});

test('closing a view only unsubscribes; the last view closing cancels the run', async () => {
  const h = await harness(TREE);
  const second = await h.otherView();
  h.plan.pause.add('leaf1');
  await h.runAll();
  await until(() => h.calls.length === 1);
  second.startPromptRun();
  await closeView(h.view);
  assert.equal(h.view.promptBatch.outcome.stopped, true, 'the closed view stops following');
  assert.equal(second.promptBatch.outcome, undefined, 'the run goes on for the remaining view');
  h.plan.go();
  await until(() => second.promptBatch.outcome);
  eq(second.promptBatch.outcome, { done: 5, failed: 0, blocked: 0, stopped: false, noChange: 0, cancelled: 0, skipped: 0, reused: 0 });

  const g = await harness(TREE);
  const other = await g.otherView();
  g.plan.hang.add('leaf1');
  await g.runAll();
  await until(() => g.calls.length === 1);
  other.startPromptRun();
  await closeView(g.view);
  assert.equal(other.promptBatch.outcome, undefined);
  await closeView(other);
  await until(() => other.promptBatch.outcome);
  assert.equal(other.promptBatch.outcome.stopped, true);
  assert.equal(g.calls.some(c => c.key === 'root'), false);
});

// ---- trial card in Run All (execution boundary) -----------------------------------------------------------------------
async function ranOnce() {
  const h = await harness(TREE);
  await h.runAll(); await h.done();
  h.calls.length = 0;
  return h;
}
const skipText = () => S.load('i18n.ts').t('ui.living_node_trial_skipped');
const midTrial = h => h.roundPort().port.coordinator.acquire('map-a', 'trial-view', [h.node('mid').path], false);

test('trial + Run All, valid upstream: the trial card is skipped and its knowledge is used as is', async () => {
  const h = await ranOnce();
  await h.repo.updateNote(h.node('root').path, { prompt: 'Prompt root changed' });
  const trial = midTrial(h);
  const round = h.roundPort();
  const results = await round.run();
  trial.release();
  assert.equal(results.get(h.node('mid').id), 'not-run');
  assert.equal(h.calls.some(c => c.key === 'mid'), false, 'the trial card is not run');
  assert.ok(h.calls.some(c => c.key === 'root'), 'its consumer runs on the frozen knowledge');
  assert.ok(['changed', 'no-change'].includes(results.get(h.node('root').id)));
  eq(round.seen.boundary, { skipped: [h.node('mid').id], frozen: [h.node('mid').id], blocked: [] });
});

test('trial + Run All, stale upstream: dependents blocked, independent branches run', async () => {
  const h = await ranOnce();
  await h.repo.updateNote(h.node('leaf1').path, { prompt: 'Prompt leaf1 changed' });
  await h.repo.updateNote(h.node('side').path, { prompt: 'Prompt side changed' });
  const trial = midTrial(h);
  const round = h.roundPort();
  const results = await round.run();
  trial.release();
  assert.equal(results.get(h.node('mid').id), 'not-run');
  assert.equal(results.get(h.node('root').id), 'blocked');
  assert.ok(['changed', 'no-change'].includes(results.get(h.node('side').id)), 'an independent branch runs');
  assert.ok(['changed', 'no-change'].includes(results.get(h.node('leaf1').id)));
  assert.equal(h.calls.some(c => c.key === 'mid' || c.key === 'root'), false);
  eq(round.seen.boundary, { skipped: [h.node('mid').id], frozen: [], blocked: [h.node('root').id] });
});

test('trial + Run All, empty upstream: dependents blocked, other cards run', async () => {
  const h = await harness(TREE);
  const trial = midTrial(h);
  const round = h.roundPort();
  const results = await round.run();
  trial.release();
  assert.equal(results.get(h.node('mid').id), 'not-run');
  assert.equal(results.get(h.node('root').id), 'blocked');
  assert.equal(h.calls.some(c => c.key === 'mid' || c.key === 'root'), false);
  for (const key of ['leaf1', 'leaf2', 'side']) assert.equal(results.get(h.node(key).id), 'changed', key);
  eq(round.seen.boundary.blocked, [h.node('root').id]);
  eq(round.seen.boundary.frozen, []);
});

test('Run Card on a card in trial is refused; nothing runs or is written', async () => {
  const h = await ranOnce();
  const trial = midTrial(h);
  const before = TREE.map(([k]) => h.raw(k));
  await assert.rejects(h.roundPort().run([h.node('mid').id]), /living-node-trial-busy/);
  assert.equal(h.calls.length, 0);
  eq(TREE.map(([k]) => h.raw(k)), before);
  trial.release();
});

test('a view that switches maps leaves the run; the round it started keeps reading and busy-checking the original map', async () => {
  const h = await harness(TREE);
  const second = await h.otherView();
  const reads = [], keys = [];
  const readSources = h.repo.readMapSources.bind(h.repo);
  h.repo.readMapSources = async path => { reads.push(path); return readSources(path); };
  const isRunning = h.host.expansionCoordinator.isRunning.bind(h.host.expansionCoordinator);
  h.host.expansionCoordinator.isRunning = key => { keys.push(key); return isRunning(key); };
  h.plan.pause.add('leaf1');
  await h.runAll();
  await until(() => h.calls.length === 1);
  second.startPromptRun();
  // View A opens another map: it only leaves the run, which the other view keeps following.
  h.view.promptBatch.leave();
  h.view.path = 'Other.vam';
  h.view.map = { id: 'other-map', title: 'other', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  reads.length = 0; keys.length = 0;
  const before = h.raw('side');
  h.plan.go();
  await until(() => second.promptBatch.outcome);
  eq(second.promptBatch.outcome, { done: 5, failed: 0, blocked: 0, stopped: false, noChange: 0, cancelled: 0, skipped: 0, reused: 0 });
  assert.ok(reads.length > 0 && keys.length > 0, 'the round read sources and checked busy after the switch');
  eq([...new Set(reads)], [MAP], 'sources come from the original map');
  eq([...new Set(keys)], ['multi-research:' + MAP], 'the busy check is for the original map');
  assert.notEqual(h.raw('side'), before, 'writes still land on the original map');
});

test('a trial lease taken while validity is inspected makes the round fail busy with zero writes', async () => {
  const h = await ranOnce();
  await h.repo.updateNote(h.node('leaf1').path, { prompt: 'Prompt leaf1 changed' });
  const first = midTrial(h); // a trial on another card makes the round inspect validity
  const round = h.roundPort();
  let late;
  const mapSources = round.port.mapSources;
  round.port.mapSources = async signal => {
    late ??= round.port.coordinator.acquire('map-a', 'late-trial', [h.node('leaf1').path], false);
    return mapSources(signal);
  };
  const before = TREE.map(([k]) => h.raw(k));
  await assert.rejects(round.run(), /living-node-busy/);
  assert.ok(late, 'the lease was taken during the inspection');
  assert.equal(h.calls.length, 0);
  eq(TREE.map(([k]) => h.raw(k)), before);
  late.release(); first.release();
});

// ---- UI gaps (T11): why a card did not finish, the header count, and re-confirming a replaced source ---------------------
const reasonOf = (h, key) => h.raw(key).match(/^living-node-reason: "(.*)"$/m)?.[1];
const livingOf = (h, key) => h.repo.readNote(h.node(key).path, h.mapDoc).then(note => note.livingNode);
const livingState = S.load('experiences/visual-map/living-node-state.ts');
const sourcesMod = S.load('experiences/visual-map/living-node-sources.ts');
// A source note with a fixed identity (ctime, size), watched by an identity store like the plugin does.
function watchedSource(h, path, ctime) {
  const store = new sourcesMod.LivingIdentityStore(undefined, () => {}, (() => { let n = 0; return () => 'id' + ++n; })());
  h.runtime.setLivingIdentityStore(h.app, store);
  h.setViewIdentityStore(h.app, store);
  const stamp = c => { h.app.vault.getAbstractFileByPath(path).stat = { ctime: c, mtime: 1, size: 5 }; };
  stamp(ctime);
  return { store, stamp };
}

test('reason: a failed card and the cards blocked by it keep a short reason in the note; the next success clears it', async () => {
  const h = await harness(TREE);
  h.plan.fail.add('leaf1');
  await h.runAll(); await h.done();
  assert.equal(reasonOf(h, 'leaf1'), 'provider-failed');
  assert.equal(reasonOf(h, 'mid'), 'dependency-blocked');
  assert.equal(reasonOf(h, 'root'), 'dependency-blocked');
  await h.view.hydrate();
  const note = h.view.notes.get(h.node('mid').id);
  assert.equal(note.livingNode.reason, 'dependency-blocked', 'it is read back from the note, so it survives a reopen');
  assert.equal(livingState.livingReasonKey(note.livingNode), 'ui.living_node_reason_dependency');
  assert.equal(livingState.livingReasonKey((await livingOf(h, 'leaf1'))), 'ui.living_node_trial_reason_provider');
  h.plan.fail.clear();
  await h.runAll(); await h.done();
  for (const key of ['leaf1', 'mid', 'root']) {
    assert.equal(stamp(h, key).result, 'ok', key);
    assert.equal(reasonOf(h, key), undefined, key + ' reason cleared');
    assert.equal((await livingOf(h, key)).reason, undefined);
  }
});

test('reason: each error class is stored as a short code and shows its own line on the card; raw error text is never stored', async () => {
  const cases = [
    ['provider', { errors: new Error('connect EPROTO /Users/me/secret') }, 'provider-failed', 'ui.living_node_trial_reason_provider'],
    ['network-reset', { errors: new Error('connect ECONNRESET /Users/me/secret') }, 'network-failed', 'ui.living_node_trial_reason_network'],
    ['network-fetch', { errors: Object.assign(new Error('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND /Users/me/secret') }) }, 'network-failed', 'ui.living_node_trial_reason_network'],
    ['network-etimedout', { errors: new Error('connect ETIMEDOUT /Users/me/secret') }, 'network-failed', 'ui.living_node_trial_reason_network'],
    ['timeout', { errors: new Error('Request timed out') }, 'timeout', 'ui.living_node_trial_reason_timeout'],
    ['not-json', { reply: 'this is not json {' }, 'validation-rejected', 'ui.living_node_trial_reason_validation'],
    ['bad-answer', { reply: JSON.stringify({ baseRevision: 'x', requiresWeb: false, operations: 'nope' }) }, 'validation-rejected', 'ui.living_node_trial_reason_validation'],
    ['web', { reply: JSON.stringify({ requiresWeb: true, operations: [] }) }, 'web-required', 'ui.living_node_trial_reason_web']
  ];
  for (const [name, how, code, key] of cases) {
    const h = await harness([['solo', null, { prompt: 'Find facts' }]]);
    for (const [kind, value] of Object.entries(how)) h.plan[kind].set('solo', value);
    await h.runAll(); await h.done();
    assert.equal(reasonOf(h, 'solo'), code, name);
    assert.doesNotMatch(h.raw('solo'), /Unexpected token|ECONNRESET|ENOTFOUND|fetch failed|EPROTO|secret|not valid JSON/, name + ' raw text not stored');
    assert.equal(livingState.livingReasonKey(await livingOf(h, 'solo')), key, name);
  }
});

test('reason codes map to lines: unknown code gets the generic line, trial-reason categories are reused', () => {
  const mapped = code => livingState.livingReasonKey({ damaged: false, outcome: 'failed', reason: code });
  assert.equal(mapped('range-too-large'), 'ui.living_node_reason_range_too_large');
  assert.equal(mapped('source-changed'), 'ui.living_node_trial_reason_replaced');
  assert.equal(mapped('markers-damaged'), 'ui.living_node_reason_markers_damaged');
  assert.equal(mapped('missing-source'), 'ui.living_node_reason_missing_source');
  assert.equal(mapped('zzz'), 'ui.living_node_reason_failed');
  const code = e => livingState.livingFailureCode(e);
  assert.equal(code(new SyntaxError('Unexpected token')), 'validation-rejected');
  assert.equal(code(new Error('missing-evidence')), 'validation-rejected');
  assert.equal(code(new Error('stale-base')), 'source-changed');
  assert.equal(code(new Error('ambiguous-living-node-region')), 'markers-damaged');
  assert.equal(code(new Error('unauthorized-source')), 'missing-source');
  assert.equal(code(new Error('living-node-context-too-large')), 'range-too-large');
  assert.equal(code(new Error('cancelled')), 'failed');
  assert.equal(code('plain text'), 'provider-failed');
  assert.equal(code(new Error('read ECONNRESET')), 'network-failed');
  assert.equal(mapped('network-failed'), 'ui.living_node_trial_reason_network');
  // D1-x5: a search that did not happen is stamped as a web failure, so the card shows the web line.
  const notSearched = S.load('ai/search-not-performed.ts').searchNotPerformedError();
  assert.equal(code(notSearched), 'web-required');
  assert.equal(mapped(code(notSearched)), 'ui.living_node_trial_reason_web');
});

test('reason: a missing required source is reported as missing-source', async () => {
  const h = await harness([['solo', null, { prompt: 'Find facts\nSources: [[Missing]]' }]]);
  await h.runAll(); await h.done();
  assert.equal(stamp(h, 'solo').result, 'blocked');
  assert.equal(reasonOf(h, 'solo'), 'missing-source');
});

test('reason: a card waiting on a card in trial says so; the trial card itself is not stamped', async () => {
  const h = await harness(TREE);
  const trial = midTrial(h);
  const before = h.raw('mid');
  await h.roundPort().run();
  trial.release();
  assert.equal(reasonOf(h, 'root'), 'upstream-trial');
  assert.equal(h.raw('mid'), before, 'a card under trial is left byte for byte as it was');
  assert.equal(livingState.livingReasonKey({ damaged: false, outcome: 'blocked', reason: 'upstream-trial' }), 'ui.living_node_upstream_trial');
});

test('Run All: a card under trial shows the skip line on the card while the batch runs and clears it when the batch ends, without being stamped', async () => {
  const h = await harness(TREE);
  const trial = h.viewCoordinator(h.host).acquire('map-a', 'trial-view', [h.node('mid').path], false);
  const before = h.raw('mid');
  h.plan.hang.add('leaf1');
  await h.runAll();
  await until(() => h.calls.some(c => c.key === 'leaf1'));
  const skipLine = () => {
    const card = element('div'), header = element('div'), title = element('h3', { cls: 'vam-card-title' });
    header.appendChild?.(title); card.appendChild?.(header); card.appendChild?.(title);
    h.view.paintPromptState(card, header, h.node('mid'), h.view.notes.get(h.node('mid').id));
    return findAll(card, i => i.cls?.includes('vam-ai-reason')).map(i => i.text);
  };
  eq(skipLine(), [skipText()], 'while the batch runs');
  h.view.stopPromptBatch(); await h.done();
  trial.release();
  eq(skipLine(), [], 'the skip line is gone once the batch has ended');
  assert.equal(h.raw('mid'), before, 'a card under trial is not stamped');
});

test('reason: a source note that was replaced blocks with source-replaced', async () => {
  const h = await harness([['solo', null, { prompt: 'Find facts\nSources: [[Ref]]' }]]);
  await h.app.vault.create('Notes/Ref.md', 'reference body');
  const { store, stamp: stampRef } = watchedSource(h, 'Notes/Ref.md', 10);
  await h.roundPort().run();
  assert.equal(stamp(h, 'solo').result, 'ok');
  store.created('Notes/Ref.md', { ctime: 99, size: 5 }); stampRef(99);
  await h.repo.updateNote(h.node('solo').path, { prompt: 'Find facts again\nSources: [[Ref]]' });
  await h.roundPort().run();
  assert.equal(stamp(h, 'solo').result, 'blocked');
  assert.equal(reasonOf(h, 'solo'), 'source-replaced');
  assert.equal(livingState.livingReasonKey({ damaged: false, outcome: 'blocked', reason: 'source-replaced' }), 'ui.living_node_source_replaced');
});

test('reason: a damaged region shows the markers message whatever the outcome; an unknown code shows the generic line, a missing one nothing', () => {
  assert.equal(livingState.livingReasonKey({ damaged: true, outcome: 'ok' }), 'ui.living_node_reason_markers_damaged');
  assert.equal(livingState.livingReasonKey({ damaged: false, outcome: 'failed', reason: 'zzz' }), 'ui.living_node_reason_failed');
  assert.equal(livingState.livingReasonKey({ damaged: false, outcome: 'failed' }), undefined);
  assert.equal(livingState.livingReasonKey({ damaged: false, outcome: 'ok', reason: 'failed' }), undefined, 'a finished card never shows an old reason');
  assert.equal(livingState.livingReasonKey(undefined), undefined);
});

test('header count: a card needing a rerun does not count as researched; a valid one does', async () => {
  const h = await harness(TREE);
  const id = key => h.node(key).id;
  const validity = entries => { h.view.livingValidity = new Map(entries.map(([key, v]) => [id(key), v])); };
  validity(TREE.map(([key]) => [key, 'valid']));
  assert.equal(h.view.researchedCount(), 5);
  validity([['leaf1', 'stale'], ['mid', 'stale'], ['root', 'stale'], ['leaf2', 'valid'], ['side', 'none']]);
  assert.equal(h.view.researchedCount(), 1, 'stale and empty cards are not researched');
  const parent = element('div');
  h.view.renderResearchProgress(parent);
  const bar = find(parent, i => i.attrs?.role === 'progressbar');
  assert.equal(String(bar.attrs['aria-valuenow']), '1');
  // A damaged card does not count even when its validity says valid; a completed topic card always does.
  h.view.notes.get(id('leaf2')).livingNode = { summary: '', knowledgeRevision: '', outcome: 'ok', damaged: true };
  assert.equal(h.view.researchedCount(), 0);
  h.view.notes.get(id('side')).status = 'completed';
  assert.equal(h.view.researchedCount(), 1);
});

test('replaced sources: the card lists the links whose note was replaced; none for an intact source', async () => {
  const h = await harness([['solo', null, { prompt: 'Find facts\nSources: [[Ref]]' }]]);
  await h.app.vault.create('Notes/Ref.md', 'reference body');
  const { store, stamp: stampRef } = watchedSource(h, 'Notes/Ref.md', 10);
  await h.roundPort().run();
  eq(await h.runtime.livingReplacedSources(h.app, h.repo, h.mapDoc, h.node('solo').id), []);
  store.created('Notes/Ref.md', { ctime: 99, size: 5 }); stampRef(99);
  eq(await h.runtime.livingReplacedSources(h.app, h.repo, h.mapDoc, h.node('solo').id), ['Ref']);
});

// B23: a map file (Map.md, or any note marked `visual-agent-map`) is VAM's own data, not a note to read first.
const OTHER_MAP = 'Agent Workspace/Topics/map-b/Map.md';
const withOtherMap = async h => {
  await h.app.vault.create(OTHER_MAP, core.serializeMap({ id: 'map-b', title: 'Secret map B', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } }));
  await h.app.vault.create('Maps/Old.md', '---\nvisual-agent-map: true\n---\n# Old map\n');
  await h.app.vault.create('Notes/Ref.md', 'reference body');
};
const saveReason = require('./support-replay.cjs').loadSource('export { livingSaveReason } from "./experiences/visual-map/living-node-trial-reason";', { obsidian });

test('map files as sources: the note picker leaves out every map file and keeps ordinary notes', async () => {
  const h = await harness([['solo', null]]);
  await withOtherMap(h);
  const paths = h.runtime.livingNoteCandidates(h.app, h.app.vault.getMarkdownFiles()).map(file => file.path);
  assert.ok(paths.includes('Notes/Ref.md'), 'an ordinary note stays a candidate');
  assert.ok(paths.includes(h.node('solo').path), 'a topic note stays a candidate');
  for (const path of [MAP, OTHER_MAP, 'Maps/Old.md']) assert.ok(!paths.includes(path), path + ' is not offered');
});

test('map files as sources: saving one as a source writes nothing and is refused with a reason', async () => {
  const h = await harness([['solo', null, { prompt: 'Find facts' }]]);
  await withOtherMap(h);
  const before = h.raw('solo');
  for (const link of ['Agent Workspace/Topics/map-b/Map', 'Maps/Old']) {
    const error = await h.runtime
      .saveLivingConfig(h.app, h.repo, h.mapDoc, h.node('solo').id, 'Find facts\nSources: [[' + link + ']]')
      .then(() => null, e => e);
    assert.ok(error, link + ' is refused');
    assert.equal(error.message, 'map-file-source');
    assert.equal(saveReason.livingSaveReason(error), 'ui.living_node_reason_map_file');
    assert.equal(h.raw('solo'), before, 'nothing written');
  }
  // An ordinary note still saves.
  await h.runtime.saveLivingConfig(h.app, h.repo, h.mapDoc, h.node('solo').id, 'Find facts\nSources: [[Ref]]');
  assert.match(h.raw('solo'), /note-path:Notes\/Ref\.md/);
});

test('map files as sources: a saved reference to one stays in the file, is not read, and the card says why', async () => {
  const h = await harness([['solo', null, { prompt: 'Find facts\nSources: [[Ref]]' }]]);
  await withOtherMap(h);
  await h.runtime.saveLivingConfig(h.app, h.repo, h.mapDoc, h.node('solo').id, 'Find facts\nSources: [[Ref]]');
  const file = h.app.vault.getAbstractFileByPath(h.node('solo').path);
  await h.app.vault.process(file, text => text.replace('note-path:Notes/Ref.md', 'note-path:' + OTHER_MAP));
  assert.ok(h.raw('solo').includes('note-path:' + OTHER_MAP));
  await h.roundPort().run();
  assert.ok(!h.calls.some(call => JSON.stringify(call.input).includes('Secret map B')), 'the map file is not sent');
  assert.equal(h.calls.length, 0, 'the card does not run');
  assert.ok(h.raw('solo').includes('note-path:' + OTHER_MAP), 'the reference stays');
  assert.equal(h.raw('solo').match(/^living-node-reason: "(.*)"$/m)?.[1], 'map-file-source');
  const living = S.load('experiences/visual-map/living-node-state.ts');
  assert.equal(living.livingReasonKey({ damaged: false, outcome: 'blocked', reason: 'map-file-source' }), 'ui.living_node_reason_map_file');
});

test('reconfirm: the identity is confirmed only after the formal save succeeded, and only for the chosen link', async () => {
  const h = await harness([['solo', null, { prompt: 'Find facts\nSources: [[Ref]], [[Other]]' }]]);
  await h.app.vault.create('Notes/Ref.md', 'reference body');
  await h.app.vault.create('Notes/Other.md', 'other body');
  const { store, stamp: stampRef } = watchedSource(h, 'Notes/Ref.md', 10);
  h.app.vault.getAbstractFileByPath('Notes/Other.md').stat = { ctime: 20, mtime: 1, size: 5 };
  await h.roundPort().run();
  const prompt = 'Find facts\nSources: [[Ref]], [[Other]]';
  const save = (isCurrent, allow, reconfirm) => h.runtime.saveLivingConfig(h.app, h.repo, h.mapDoc, h.node('solo').id, prompt, undefined, undefined, isCurrent, allow, undefined, reconfirm);
  await save(() => true); // the saved links now carry their identities
  store.created('Notes/Ref.md', { ctime: 99, size: 5 }); stampRef(99);
  const otherId = store.at('Notes/Other.md').refId, refId = store.at('Notes/Ref.md').refId;
  // A save that is refused leaves the identity as it was.
  await assert.rejects(save(() => true, () => false, ['Ref']), /unauthorized-source/);
  assert.equal(store.at('Notes/Ref.md').state, 'dangling', 'nothing was confirmed before the write');
  await assert.rejects(save(() => false, undefined, ['Ref']), /changed-configuration/);
  assert.equal(store.at('Notes/Ref.md').state, 'dangling');
  // The saved save confirms the link the user chose again, not the other replaced note.
  await save(() => true, undefined, ['Ref']);
  assert.equal(store.at('Notes/Ref.md').state, 'resolved');
  assert.notEqual(store.at('Notes/Ref.md').refId, refId, 'a new identity for the confirmed note');
  assert.equal(store.at('Notes/Other.md').refId, otherId, 'the other source keeps its identity');
});

test('reconfirm: choosing the link again re-resolves it even when the list is unchanged', () => {
  const resolved = [];
  const refs = [{ kind: 'note', link: 'a.md', exact: true }, { kind: 'note', link: 'b.md', exact: true }];
  const resolveNew = link => { resolved.push(link); return { kind: 'note', link: link + '#new', exact: true }; };
  const same = ['A', 'B'];
  eq(sourcesMod.reconcileLivingDraftReferences(same, refs, same, resolveNew), refs, 'unchanged without a request');
  eq(resolved, []);
  const out = sourcesMod.reconcileLivingDraftReferences(same, refs, same, resolveNew, new Set(['B']));
  eq(resolved, ['B']);
  eq(out, [refs[0], { kind: 'note', link: 'B#new', exact: true }]);
});

test('reconfirm through the card editor: a transaction that fails or reverts leaves the identity alone; a committed one confirms it', async () => {
  const h = await harness([['solo', null, { prompt: 'Find facts\nSources: [[Ref]]' }]]);
  await h.app.vault.create('Notes/Ref.md', 'reference body');
  const { store, stamp } = watchedSource(h, 'Notes/Ref.md', 10);
  await h.roundPort().run();
  const prompt = 'Find facts\nSources: [[Ref]]';
  await h.runtime.saveLivingConfig(h.app, h.repo, h.mapDoc, h.node('solo').id, prompt);
  store.created('Notes/Ref.md', { ctime: 99, size: 5 }); stamp(99);
  assert.equal(store.at('Notes/Ref.md').state, 'dangling');
  const values = { title: '', question: 'Find facts again', sources: ['Ref'], keepOld: true, reconfirm: ['Ref'] };
  const saveMap = h.repo.saveMap;
  h.repo.saveMap = async () => { throw new Error('map changed meanwhile'); };
  await assert.rejects(h.view.writeAiCard(h.node('solo'), values, prompt, undefined, () => true), /map changed meanwhile/);
  h.repo.saveMap = saveMap;
  assert.equal(store.at('Notes/Ref.md').state, 'dangling', 'a reverted transaction did not record the confirmation');
  const saved = await h.view.writeAiCard(h.node('solo'), values, prompt, undefined, () => true);
  assert.ok(saved);
  assert.equal(store.at('Notes/Ref.md').state, 'resolved', 'the committed save confirms it');
  assert.ok(saved.sourceRevision, 'the revision under the confirmed identity is kept for redo');
});

test('trial cancel: declining the usage confirmation or pressing Stop shows no failure box and keeps the focus; a real failure still does', async () => {
  const declined = await popoverHarness([['A', null, { prompt: 'Why?' }]], { confirm: false });
  const box = h => find(h.pop(), i => i.attrs?.role === 'alert');
  const tryButton = h => find(h.pop(), i => i.tag === 'button' && i.text === 'Try prompt');
  const stopButton = h => find(h.pop(), i => i.tag === 'button' && i.text === 'Stop');
  declined.view.openAiCardPopover(declined.node('A'));
  declined.view.readLivingMapSourceReport = async () => ({ groups: [], unavailable: 0 });
  const keep = declined.question();
  keep.focus();
  tryButton(declined).click();
  await until(() => declined.usage.length === 1);
  await dom.tick(); await dom.tick();
  assert.equal(declined.usage.length, 1, 'the user was asked');
  assert.equal(box(declined).hidden, true, 'declining is not a failure');
  assert.equal(declined.notices.some(n => /did not finish|沒有完成/.test(String(n.message ?? n))), false);
  assert.notEqual(dom.focusedNow(), find(box(declined), i => i.tag === 'button'), 'the focus did not jump to a retry');
  const stopped = await popoverHarness([['A', null, { prompt: 'Why?' }]]);
  stopped.plan.hang.add('A');
  stopped.view.openAiCardPopover(stopped.node('A'));
  stopped.view.readLivingMapSourceReport = async () => ({ groups: [], unavailable: 0 });
  tryButton(stopped).click();
  await until(() => stopped.calls.length === 1);
  stopButton(stopped).click();
  await dom.tick(); await dom.tick(); await dom.tick();
  assert.equal(box(stopped).hidden, true, 'Stop is not a failure');
  const failed = await popoverHarness([['A', null, { prompt: 'Why?' }]]);
  failed.view.openAiCardPopover(failed.node('A'));
  failed.plan.fail.add('A');
  failed.view.readLivingMapSourceReport = async () => ({ groups: [], unavailable: 0 });
  tryButton(failed).click();
  await until(() => box(failed).hidden === false);
  assert.ok(find(box(failed), i => i.hasClass?.('vam-living-editor-failure-reason')).text, 'a real failure says why');
});

// ---- P3.4 trial and adoption through the central editor ---------------------------------------------------------------
const sha = text => require('node:crypto').createHash('sha256').update(String(text)).digest('hex');
// A ready trial of A, which reads the note N. The vault raises `modify` for every write, as Obsidian's does.
const trialHarness = async () => {
  const h = await popoverHarness([['A', null, { prompt: 'Why?\nSources: [[N]]' }], ['N', null, { noAi: true }]]);
  const listeners = new Set();
  h.app.vault.on = (name, fn) => { const ref = { name, fn }; listeners.add(ref); return ref; };
  h.app.vault.offref = ref => { listeners.delete(ref); };
  const process = h.app.vault.process;
  h.app.vault.process = async (file, change) => {
    const result = await process(file, change);
    for (const ref of [...listeners]) if (ref.name === 'modify') ref.fn(file);
    return result;
  };
  const reader = [], registered = [];
  h.view.registerEvent = ref => { registered.push(ref); };
  h.host.showLivingTrial = async (file, _markdown, owner, isCurrent) => { reader.push(['trial', file?.path, owner]); return isCurrent(); };
  h.host.invalidateLivingTrial = owner => { reader.push(['invalid', owner]); };
  h.host.restoreLivingOfficial = async (file, owner, release) => { reader.push(['official', file?.path, owner, !!release]); };
  h.view.readLivingMapSourceReport = async () => ({ groups: [], unavailable: 0 });
  const button = text => find(h.pop(), i => i.tag === 'button' && i.text === text);
  const bytes = () => [sha(h.raw('A')), sha(h.raw('N'))];
  const ready = async () => {
    h.view.openAiCardPopover(h.node('A'));
    button('Try prompt').click();
    await until(() => h.view.aiCardOpen?.trial.state === 'ready' && reader.some(r => r[0] === 'trial'));
    await dom.tick(); await dom.tick();
    assert.equal(button('Adopt trial').disabled, false, 'the preview is ready to adopt');
  };
  return { ...h, listeners, registered, reader, button, bytes, ready };
};

for (const [name, leave] of [
  ['switching to another map', h => h.view.openMapInMutation('Agent Workspace/Topics/other/Map.md').catch(() => {})],
  ['closing the view', h => h.view.onClose().catch(() => {})]
]) test(`P3.4 ${name} discards a ready trial: the editor is gone, a retained adoption check writes nothing, the reader shows the formal note`, async () => {
  const h = await trialHarness();
  await h.ready();
  const { trial, adoption, viewSession } = h.view.aiCardOpen;
  const before = h.bytes();
  const calls = h.calls.length;
  const leaving = leave(h);
  assert.equal(h.view.aiCardOpen, null, 'the editor closes before anything else');
  await leaving;
  assert.equal(trial.state, 'none');
  assert.equal(trial.result, undefined);
  assert.equal(await trial.adopt(h.repo, adoption), 'discarded');
  eq(h.bytes(), before, 'Map notes byte for byte as before');
  assert.equal(h.calls.length, calls, 'no AI call');
  const official = h.reader.filter(r => r[0] === 'official' && r[2] === viewSession);
  assert.equal(official.length, 1, 'the reader is handed back once');
  assert.equal(official[0][3], true, 'and released');
  if (name.startsWith('switching')) assert.equal(official[0][1], h.node('A').path, 'it shows the formal note of the card again');
});

test('P3.4 trial, preview, stop or close: the card and its source keep their bytes; one AI call per trial; saving the configuration calls nothing', async () => {
  const h = await trialHarness();
  const before = h.bytes();
  await h.ready();
  assert.equal(h.calls.length, 1, 'one AI call for the trial');
  eq(h.bytes(), before, 'a ready preview wrote nothing');
  h.pop().keydown({ key: 'Escape' });
  assert.equal(h.view.aiCardOpen, null);
  eq(h.bytes(), before, 'closing wrote nothing');
  // Stop while it runs.
  h.plan.hang.add('A');
  h.view.openAiCardPopover(h.node('A'));
  h.button('Try prompt').click();
  await until(() => h.calls.length === 2);
  h.button('Stop').click();
  await until(() => h.view.aiCardOpen?.trial.state !== 'running');
  await dom.tick(); await dom.tick();
  assert.equal(h.calls.length, 2, 'one more call for the second trial, none for stopping');
  eq(h.bytes(), before, 'stopping wrote nothing');
  h.view.closeAiCardPopover();
  // Saving the configuration writes the card but never calls the AI.
  h.view.openAiCardPopover(h.node('A'));
  h.question().value = 'Why not?'; h.question().input();
  h.saveButton().click();
  await until(() => /Why not\?/.test(h.raw('A')));
  assert.equal(h.calls.length, 2, 'saving made no AI call');
  assert.equal(sha(h.raw('N')), before[1], 'the source is untouched');
});

test('P3.4 a change to a source of a ready preview turns it invalid at once: the label says so, Adopt is off, the preview stays readable', async () => {
  const h = await trialHarness();
  await h.ready();
  const { viewSession, trial } = h.view.aiCardOpen;
  const calls = h.calls.length;
  const seen = h.reader.length;
  await h.repo.updateNote(h.node('N').path, { summary: 'The source changed' });
  await until(() => h.reader.slice(seen).some(r => r[0] === 'invalid' && r[1] === viewSession));
  await dom.tick();
  assert.equal(trial.state, 'invalid');
  assert.ok(trial.result, 'the preview stays readable');
  assert.equal(h.button('Adopt trial').disabled, true, 'Adopt is off without pressing it');
  assert.equal(h.calls.length, calls, 'no AI call');
  assert.equal(h.listeners.size, 0, 'nothing listens for an invalid preview');
  assert.equal(h.reader.slice(seen).some(r => r[0] === 'official'), false, 'the reader keeps the preview');
});

test('P3.4 the target card changed elsewhere turns the preview invalid; saving the same configuration keeps it adoptable', async () => {
  const h = await trialHarness();
  await h.ready();
  const { viewSession, trial } = h.view.aiCardOpen;
  const seen = h.reader.length;
  h.saveButton().click();
  await until(() => h.view.history.past.length > 0);
  for (let i = 0; i < 30; i++) await dom.tick();
  assert.equal(trial.state, 'ready', 'an identical save is not a change of the trial inputs');
  assert.equal(h.reader.slice(seen).some(r => r[0] === 'invalid' && r[1] === viewSession), false);
  assert.equal(h.button('Adopt trial').disabled, false);
  const calls = h.calls.length;
  h.button('Adopt trial').click();
  await until(() => /Result: A/.test(h.raw('A')));
  assert.equal(h.calls.length, calls, 'adopting makes no AI call');
  await h.ready();
  await h.repo.updateNote(h.node('A').path, { summary: 'The owner edited the card' });
  await until(() => h.view.aiCardOpen.trial.state === 'invalid');
  await dom.tick();
  assert.equal(h.button('Adopt trial').disabled, true);
});

test('P3.4 an identical save pressed while a source check is reading does not invalidate the preview', async () => {
  const h = await trialHarness();
  await h.ready();
  const { trial } = h.view.aiCardOpen;
  const target = h.node('A').path;
  // The next read of the card waits; the card is written while it waits, and the save then pauses before it returns.
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let gated = false;
  const read = h.repo.readNoteSnapshot.bind(h.repo);
  h.repo.readNoteSnapshot = async (path, ...rest) => {
    if (path === target && !gated) { gated = true; await gate; }
    return read(path, ...rest);
  };
  const process = h.app.vault.process;
  h.app.vault.process = async (file, change) => {
    const result = await process(file, change);
    if (file.path === target) { release(); for (let i = 0; i < 40; i++) await dom.tick(); }
    return result;
  };
  // A modify of the source starts a check, which stops on the card read.
  for (const ref of [...h.listeners]) ref.fn(h.app.vault.getAbstractFileByPath(h.node('N').path));
  await until(() => gated);
  h.saveButton().click();
  await until(() => h.view.history.past.length > 0);
  for (let i = 0; i < 40; i++) await dom.tick();
  assert.equal(trial.state, 'ready', 'the save is checked by its result, not mid-way');
  assert.equal(h.button('Adopt trial').disabled, false);
  h.button('Adopt trial').click();
  await until(() => /Result: A/.test(h.raw('A')));
});

test('P3.4 the source listener ends with the editor: a later change does nothing, and reopening keeps one listener', async () => {
  const h = await trialHarness();
  await h.ready();
  assert.equal(h.listeners.size, 1, 'one listener while a preview is ready');
  assert.ok(h.registered.includes([...h.listeners][0]), 'registered with the view, so unloading the plugin removes it too');
  h.view.closeAiCardPopover();
  assert.equal(h.listeners.size, 0, 'closing removes it');
  const seen = h.reader.length;
  await h.repo.updateNote(h.node('N').path, { summary: 'Changed after close' });
  for (let i = 0; i < 6; i++) await dom.tick();
  eq(h.reader.slice(seen), [], 'a later change does nothing');
  await h.ready();
  await h.ready();
  assert.equal(h.listeners.size, 1, 'a second trial replaces the first listener');
  h.view.closeAiCardPopover();
  await h.ready();
  assert.equal(h.listeners.size, 1, 'no leak across reopen');
  await h.view.onClose().catch(() => {});
  assert.equal(h.listeners.size, 0, 'closing the view removes it');
});

test('V3.3 P1.2: while notes are still loading (read-only) the toolbar offers only Note and ⋯ (its rows greyed, decision #35), and Note still opens the details', async () => {
  const h = await harness([['a', null, { prompt: 'Why?' }]]);
  const node = h.node('a');
  let opened = 0; h.view.openDetails = () => { opened++; };
  const buttons = tools => findAll(tools, i => i.tag === 'button');
  const hasCls = (i, cls) => !!i.cls?.split(' ').includes(cls);
  h.view.noteLoad = { pending: true };
  const loading = element('div');
  h.view.paintCardToolbar(loading, node, true);
  assert.deepEqual(buttons(loading).map(b => [hasCls(b, 'vam-detail-button'), hasCls(b, 'vam-card-tool-more')]), [[true, false], [false, true]], 'read-only: Note and ⋯ only');
  buttons(loading)[0].click();
  assert.equal(opened, 1, 'Note only reads, so it works while read-only');
  h.view.noteLoad = null;
  const ready = element('div');
  h.view.paintCardToolbar(ready, node, true);
  assert.ok(buttons(ready).length > 1, 'editable again: the other tools are back');
  assert.ok(buttons(ready).some(b => hasCls(b, 'vam-card-tool-more')));
});

// ---- D1-x7: adopting a trial is the same commit as a formal Run Card; an unsaved draft can be tried ------------------------
const sameNoteButTime = text => String(text)
  // The save step the adopter needs writes the source refs, which also feed the input revision: the only two non-time differences.
  .replace(/^living-node-refs:\n(  - .*\n)*/m, '')
  .replace(/^(updated|living-node-input-revision|living-node-last-attempt|living-node-last-successful-check|living-node-last-content-change|living-node-commit|living-node-receipts|living-node-generation):.*\n?/gm, '')
  .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'U');

test('D1-x7 adopt = formal submit: the adopted note has the same frontmatter, summary, status and knowledge revision as a Run Card of the same settings', async () => {
  const formal = await popoverHarness([['A', null, { prompt: 'Why?\nSources: [[N]]' }], ['N', null, { noAi: true }]]);
  formal.view.readLivingMapSourceReport = async () => ({ groups: [], unavailable: 0 });
  formal.view.startPromptRun([formal.node('A').id]); await formal.done();
  assert.match(formal.raw('A'), /Result: A/, 'the formal run wrote the result');
  const adopted = await trialHarness();
  await adopted.ready();
  adopted.saveButton().click(); // adoption needs the exact same configuration saved first
  await until(() => adopted.view.history.past.length > 0);
  for (let i = 0; i < 30; i++) await dom.tick();
  adopted.button('Adopt trial').click();
  await until(() => /Result: A/.test(adopted.raw('A')));
  for (let i = 0; i < 20; i++) await dom.tick();
  eq(sameNoteButTime(adopted.raw('A')), sameNoteButTime(formal.raw('A')), 'same bytes except time fields');
  const a = await adopted.repo.readNote(adopted.node('A').path, adopted.mapDoc), f = await formal.repo.readNote(formal.node('A').path, formal.mapDoc);
  assert.equal(a.summary, f.summary); assert.equal(a.livingNode.summary, f.livingNode.summary);
  assert.equal(a.livingNode.knowledgeRevision, f.livingNode.knowledgeRevision);
  assert.equal(a.status, f.status);
  assert.equal(a.summary, 'Result: A', 'D1-x9: adopt updates the latest summary like a formal run');
  assert.match(adopted.raw('A'), /## Current Summary\n\nResult: A\n/);
  assert.ok(adopted.reader.some(r => r[0] === 'official'), 'the reader is handed back to the official note');
});

// ---- D1-x9: a successful commit updates the latest summary (frontmatter `summary` + `## Current Summary`) -------------------
const summaryOf = raw => raw.match(/## Current Summary\n\n([\s\S]*?)\n\n## /)?.[1].split('\n\n')[0];
const fmSummary = raw => require('./support.cjs').obsidian.parseYaml(raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]).summary;

test('D1-x9 formal Run Card: a new latest summary replaces the placeholder in frontmatter and Current Summary, in the same single write as the knowledge commit', async () => {
  const h = await popoverHarness([['A', null, {}]]);
  assert.match(summaryOf(h.raw('A')), /\S/);
  assert.equal(summaryOf(h.raw('A')), 'No conclusion yet', 'starts as the placeholder, which is not user content');
  const file = h.app.vault.getAbstractFileByPath(h.node('A').path);
  const states = [];
  const process = h.app.vault.process;
  h.app.vault.process = async (f, change) => { const r = await process(f, change); if (f === file) states.push(h.raw('A')); return r; };
  h.view.startPromptRun([h.node('A').id]); await h.done();
  assert.equal(fmSummary(h.raw('A')), 'Result: A');
  assert.equal(summaryOf(h.raw('A')), 'Result: A');
  const firstRegion = states.findIndex(t => /### Current output[\s\S]*Result: A/.test(t));
  const firstSummary = states.findIndex(t => summaryOf(t) === 'Result: A' && fmSummary(t) === 'Result: A');
  assert.ok(firstRegion >= 0);
  assert.equal(firstSummary, firstRegion, 'summary and knowledge land in one write');
  assert.equal((await h.repo.readNote(h.node('A').path, h.mapDoc)).summary, 'Result: A');
});

test('D1-x9 a later commit with a new summary updates it again; the same summary is not rewritten; a hand-edited summary is kept', async () => {
  const h = await popoverHarness([['A', null, {}]]);
  h.view.startPromptRun([h.node('A').id]); await h.done();
  const origRun = h.host.aiCalls.run;
  let next = null;
  h.host.aiCalls.run = (prepared, options, finish) => next === null ? origRun(prepared, options, finish)
    : (h.calls.push({ key: 'A', input: prepared.input, options }), finish(JSON.stringify({ baseRevision: prepared.input.base.revision, requiresWeb: false, operations: next === '' ? [] : [{ kind: 'output', text: next, evidence: [] }] }), { signal: options.signal, parsed() {} }));
  const run = async text => {
    next = text; const count = h.calls.length;
    h.view.promptBatch = null; h.view.startPromptRun([h.node('A').id]);
    await until(() => h.view.promptBatch?.outcome && h.calls.length > count);
    for (let i = 0; i < 15; i++) await dom.tick();
  };
  await run('Second');
  assert.equal(fmSummary(h.raw('A')), 'Second');
  assert.equal(summaryOf(h.raw('A')), 'Second');
  // no effective change: the summary section and key stay byte for byte
  const before = h.raw('A');
  await run('Second');
  assert.equal(summaryOf(h.raw('A')), summaryOf(before));
  assert.equal(fmSummary(h.raw('A')), 'Second');
  // the user edits the summary: protected; the AI result still lands in the Living region
  await h.repo.updateNote(h.node('A').path, { summary: 'Mine' });
  await run('Third');
  assert.match(h.raw('A'), /### Current output[\s\S]*Third/, 'the AI result lands in the knowledge region');
  assert.equal(summaryOf(h.raw('A')), 'Mine');
  assert.equal(fmSummary(h.raw('A')), 'Mine');
});

test('D1-x11 a hand edit of the output (made in the native editor) is kept by the next AI commit; the AI result goes to AI latest', async () => {
  const h = await popoverHarness([['A', null, {}]]);
  h.view.startPromptRun([h.node('A').id]); await h.done();
  const origRun = h.host.aiCalls.run;
  let next = null;
  h.host.aiCalls.run = (prepared, options, finish) => next === null ? origRun(prepared, options, finish)
    : (h.calls.push({ key: 'A', input: prepared.input, options }), finish(JSON.stringify({ baseRevision: prepared.input.base.revision, requiresWeb: false, operations: [{ kind: 'output', text: next, evidence: [] }] }), { signal: options.signal, parsed() {} }));
  const path = h.node('A').path;
  assert.match(h.raw('A'), /> Result: A/);
  h.contents.set(path, h.raw('A').replace('> Result: A', '> My own words'));
  next = 'Machine second';
  const count = h.calls.length;
  h.view.promptBatch = null; h.view.startPromptRun([h.node('A').id]);
  await until(() => h.view.promptBatch?.outcome && h.calls.length > count);
  for (let i = 0; i < 15; i++) await dom.tick();
  assert.match(h.raw('A'), /> My own words/, 'the human edit survives');
  assert.match(h.raw('A'), /### AI latest[\s\S]*> Machine second/, 'the AI result lands in the AI latest area');
});

test('D1-x7 an unsaved new Living card can be tried (A23): it runs the draft, writes nothing, creates no formal config; an empty Prompt is still refused', async () => {
  const h = await trialHarness();
  const vault = () => [...h.contents.entries()].map(([k, v]) => k + '\n' + v).join('\n--\n');
  h.view.openAiCardPopover(null);
  const button = h.button;
  assert.equal(button('Try prompt').disabled, true, 'empty Prompt: refused');
  const before = vault();
  h.question().value = 'What is new?'; h.question().input();
  assert.equal(button('Try prompt').disabled, false, 'a non-empty unsaved draft may be tried');
  button('Try prompt').click();
  await until(() => ['ready', 'error', 'invalid'].includes(h.view.aiCardOpen?.trial.state)).catch(() => {});
  for (let i = 0; i < 10; i++) await dom.tick();
  assert.equal(h.view.aiCardOpen.trial.state, 'ready', 'the source watcher does not drop a draft preview');
  assert.equal(h.calls.length, 1, 'one AI call');
  assert.ok(h.reader.some(r => r[0] === 'trial'), 'the preview is shown');
  assert.equal(vault(), before, 'vault bytes unchanged: no note, no map write');
  h.question().value = ''; h.question().input();
  assert.equal(button('Try prompt').disabled, true, 'emptied again: refused');
});
