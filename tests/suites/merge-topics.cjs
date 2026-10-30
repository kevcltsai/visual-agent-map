// Merge topics, Phase 1 selection gestures: the pointer-intent table for the empty canvas.
const assert = require('node:assert/strict');
const { test, integrationTest, load, fixture, DEFAULT_SETTINGS } = require('../support.cjs');

const { canvasPointerIntent } = load('experiences/visual-map/canvas-gestures.ts');
const press = (over = {}) => canvasPointerIntent({ button: 0, integrationMode: false, spaceHeld: false, altKey: false, shiftKey: false, ...over });

test('canvas pointer intent, normal mode: plain drag and Alt drag pan, Shift drag box-selects', () => {
  assert.equal(press(), 'pan');
  assert.equal(press({ altKey: true }), 'pan', 'Alt+drag still pans outside selection mode');
  assert.equal(press({ shiftKey: true }), 'marquee-enter');
  assert.equal(press({ shiftKey: true, altKey: true }), 'pan', 'Alt wins over Shift so the old Alt pan never starts a box');
  assert.equal(press({ spaceHeld: true }), 'pan');
  assert.equal(press({ spaceHeld: true, shiftKey: true }), 'pan', 'Space always pans');
});

test('canvas pointer intent, selection mode: drag adds, Option drag removes, Space and the middle button pan', () => {
  assert.equal(press({ integrationMode: true }), 'marquee-add');
  assert.equal(press({ integrationMode: true, altKey: true }), 'marquee-subtract');
  assert.equal(press({ integrationMode: true, spaceHeld: true }), 'pan');
  assert.equal(press({ integrationMode: true, spaceHeld: true, altKey: true }), 'pan');
  assert.equal(press({ integrationMode: true, shiftKey: true }), 'marquee-add');
});

test('canvas pointer intent: the middle button always pans and other buttons do nothing', () => {
  for (const integrationMode of [false, true]) {
    assert.equal(press({ button: 1, integrationMode }), 'pan');
    assert.equal(press({ button: 1, integrationMode, altKey: true, shiftKey: true }), 'pan');
    assert.equal(press({ button: 2, integrationMode }), 'ignore');
  }
});

// Merge topics, Phase 2 (structure merge): eligibility, Detail concatenation, reading order.
const { mergeEligibility, mergedDetail, mergedStatus, readingOrder } = load('experiences/visual-map/merge-topics.ts', { obsidian: require('../support.cjs').obsidian });
const { node: mnode, plain } = require('../support.cjs');
const family = () => {
  const root = mnode('root'), a = mnode('a', 'root'), b = mnode('b', 'root'), c = mnode('c', 'root'), a1 = mnode('a1', 'a'), r2 = mnode('r2');
  return [root, a, b, c, a1, r2];
};
const check = (ids, over = {}) => plain(mergeEligibility({ ids, nodes: family(), hasNote: () => true, busy: () => false, ...over }));

test('merge eligibility: needs two or more cards', () => {
  assert.deepEqual(check([]), { ok: false, reason: 'ui.merge_needs_two' });
  assert.deepEqual(check(['a']), { ok: false, reason: 'ui.merge_needs_two' });
  assert.deepEqual(check(['a', 'ghost']), { ok: false, reason: 'ui.merge_needs_two' });
});

test('merge eligibility: siblings and all-root selections pass, other parents do not', () => {
  const ok = check(['a', 'b']);
  assert.equal(ok.ok, true); assert.equal(ok.parentId, 'root');
  const roots = check(['root', 'r2']);
  assert.equal(roots.ok, true); assert.equal(roots.parentId, null);
  assert.deepEqual(check(['a1', 'b']), { ok: false, reason: 'ui.merge_needs_same_parent' });
  // A parent with its direct subtopic is no longer blocked: it merges into the parent (see the parent-mode tests below).
  assert.equal(check(['root', 'a']).ok, true);
});

test('merge eligibility: a topic with its own subtopic names the ancestor reason, not the parent reason', () => {
  // Two separate parent/subtopic groups (a+a1 and root+b) stay blocked with the ancestor reason.
  assert.deepEqual(check(['a', 'a1', 'r2', 'r2c'], { nodes: [...family(), mnode('r2c', 'r2')] }), { ok: false, reason: 'ui.merge_ancestor_selected' });
  assert.deepEqual(check(['root', 'a', 'a1', 'r2', 'r2c'], { nodes: [...family(), mnode('r2c', 'r2')] }), { ok: false, reason: 'ui.merge_ancestor_selected' });
});

test('merge eligibility, parent mode: one parent plus direct subtopics merges into the parent, parent first', () => {
  const nodes = family();
  Object.assign(nodes[1], { x: 400, y: 300 }); Object.assign(nodes[2], { x: 400, y: 100 }); Object.assign(nodes[3], { x: 100, y: 200 });
  const result = plain(mergeEligibility({ ids: ['c', 'a', 'root', 'b'], nodes, hasNote: () => true, busy: () => false }));
  assert.equal(result.ok, true); assert.equal(result.targetId, 'root'); assert.equal(result.parentId, null);
  assert.deepEqual(result.sources.map(n => n.id), ['root', 'b', 'c', 'a'], 'parent first, then subtopics in reading order');
  const one = check(['root', 'c']); assert.equal(one.ok, true); assert.equal(one.targetId, 'root'); assert.deepEqual(one.sources.map(n => n.id), ['root', 'c']);
  // A subtopic with its own subtopic selected (without the topic above it) is the parent of that selection.
  const sub = check(['a', 'a1']); assert.equal(sub.ok, true); assert.equal(sub.targetId, 'a'); assert.equal(sub.parentId, 'root');
  assert.equal(check(['a', 'b']).targetId, null, 'sibling mode has no target');
  assert.equal(check(['root', 'r2']).targetId, null);
});

test('merge eligibility, parent mode: grandchildren, other branches and a second parent are blocked with their own reason', () => {
  assert.deepEqual(check(['root', 'a', 'a1']), { ok: false, reason: 'ui.merge_parent_direct_only' });
  assert.deepEqual(check(['root', 'a1']), { ok: false, reason: 'ui.merge_parent_direct_only' });
  assert.deepEqual(check(['root', 'a', 'r2']), { ok: false, reason: 'ui.merge_ancestor_selected' }, 'a parent topic plus one of its siblings is two groups');
  assert.deepEqual(check(['root', 'a1', 'b', 'c']), { ok: false, reason: 'ui.merge_parent_direct_only' });
  const nodes = [...family(), mnode('r2c', 'r2')];
  assert.deepEqual(check(['root', 'a', 'r2', 'r2c'], { nodes }), { ok: false, reason: 'ui.merge_ancestor_selected' });
});

test('merge eligibility, parent mode: missing note and busy cover the parent and the subtopics', () => {
  assert.deepEqual(check(['root', 'a'], { hasNote: id => id !== 'root' }), { ok: false, reason: 'ui.merge_missing_note' });
  assert.deepEqual(check(['root', 'a'], { hasNote: id => id !== 'a' }), { ok: false, reason: 'ui.merge_missing_note' });
  assert.deepEqual(check(['root', 'a'], { busy: n => n.id === 'root' }), { ok: false, reason: 'ui.merge_busy' });
  assert.deepEqual(check(['root', 'a', 'b'], { busy: n => n.id === 'b' }), { ok: false, reason: 'ui.merge_busy' });
  assert.deepEqual(check(['root', 'a'], { hasNote: () => false, busy: () => true }), { ok: false, reason: 'ui.merge_missing_note' });
});

test('merge eligibility: a missing note or a running AI task blocks, in that order', () => {
  assert.deepEqual(check(['a', 'b'], { hasNote: id => id !== 'b' }), { ok: false, reason: 'ui.merge_missing_note' });
  assert.deepEqual(check(['a', 'b'], { busy: n => n.id === 'a' }), { ok: false, reason: 'ui.merge_busy' });
  assert.deepEqual(check(['a', 'b'], { hasNote: () => false, busy: () => true }), { ok: false, reason: 'ui.merge_missing_note' });
});

test('merge eligibility returns the sources in reading order (y, then x)', () => {
  const nodes = family();
  Object.assign(nodes[1], { x: 400, y: 300 }); Object.assign(nodes[2], { x: 400, y: 100 }); Object.assign(nodes[3], { x: 100, y: 100 });
  const result = mergeEligibility({ ids: ['a', 'b', 'c'], nodes, hasNote: () => true, busy: () => false });
  assert.deepEqual(plain(result.sources.map(n => n.id)), ['c', 'b', 'a']);
  assert.deepEqual(plain(readingOrder(nodes.slice(1, 4)).map(n => n.id)), ['c', 'b', 'a']);
});

test('merged Detail: ### title sections in order, empty sources skipped, inner headings kept', () => {
  const detail = mergedDetail([
    { title: 'First', detail: 'Alpha text' },
    { title: 'Empty', detail: '  \n ' },
    { title: 'Third', detail: '## Inner heading\n\nBody' }
  ]);
  assert.equal(detail, '### First\n\nAlpha text\n\n### Third\n\n## Inner heading\n\nBody');
  assert.equal(mergedDetail([{ title: 'A', detail: '' }, { title: 'B', detail: '\n' }]), '');
  assert.equal(mergedDetail([]), '');
});

test('merged status: completed when any content, idea when empty', () => {
  assert.equal(mergedStatus('### A\n\nx'), 'completed');
  assert.equal(mergedStatus(''), 'idea');
  assert.equal(mergedStatus('  \n'), 'idea');
});

// Merge topics, Phase 2 (AI merge): the content test, model resolution, the task text and the dialog's AI option.
const dom = require('../support-dom.cjs');
const phase2 = load('experiences/visual-map/merge-topics.ts', { obsidian: { ...require('../support.cjs').obsidian, Modal: dom.makeModal() } });
const { translate } = load('i18n.ts');
const label = key => translate('en', key);

test('hasMergeContent: any source with non-blank Detail counts, summary alone does not', () => {
  assert.equal(phase2.hasMergeContent([{ detail: '' }, { detail: '  \n' }, undefined, {}]), false);
  assert.equal(phase2.hasMergeContent([{ detail: '' }, { detail: 'x' }]), true);
  assert.equal(phase2.hasMergeContent([{ summary: 'only a summary' }]), false);
  assert.equal(phase2.hasMergeContent([]), false);
});

test('resolveMergeModel: the parent topic model wins, otherwise the workspace model', () => {
  assert.equal(phase2.resolveMergeModel('claude:haiku', 'claude:sonnet'), 'claude:haiku');
  assert.equal(phase2.resolveMergeModel(undefined, 'claude:sonnet'), 'claude:sonnet');
});

test('mergeGoalTask: both languages keep all information, drop duplicates, add no conclusion and cap the summary at 80', () => {
  const { mergeGoalTask, synthesisGoalTask } = load('experiences/visual-map/steps/fragments.ts');
  const en = mergeGoalTask('en'), zh = mergeGoalTask('zh-TW');
  assert.match(en, /every piece of information/); assert.match(en, /Do not add conclusions/); assert.match(en, /80 characters/); assert.match(en, /contradict/);
  assert.match(zh, /全部資訊/); assert.match(zh, /不加入來源沒有的結論/); assert.match(zh, /80/); assert.match(zh, /矛盾/);
  assert.notEqual(en, synthesisGoalTask('en'));
});

test('mergeGoalTask: both languages ask for exactly one suggestion whose title is the merged topic name', () => {
  const { mergeGoalTask } = load('experiences/visual-map/steps/fragments.ts');
  assert.match(mergeGoalTask('en'), /exactly one suggestion/); assert.match(mergeGoalTask('en'), /title is the name you give the merged topic/); assert.doesNotMatch(mergeGoalTask('en'), /empty suggestions/);
  assert.match(mergeGoalTask('zh-TW'), /suggestions 只回傳一筆/); assert.match(mergeGoalTask('zh-TW'), /title 是你替合併後這個議題取的名稱/); assert.doesNotMatch(mergeGoalTask('zh-TW'), /空陣列/);
});

test('mergeTitleFromResult: the first suggestion title, tidied; missing, blank or over-long falls back to the first source title', () => {
  const name = (suggestions, fallback = 'First') => phase2.mergeTitleFromResult({ suggestions }, fallback);
  assert.equal(name([{ title: 'Heat transfer' }]), 'Heat transfer');
  assert.equal(name([{ title: '  “Heat\n transfer”  ' }, { title: 'Second' }]), 'Heat transfer', 'quotes and line breaks removed, only the first used');
  assert.equal(name([{ title: '「熱傳遞」' }]), '熱傳遞');
  assert.equal(name([]), 'First'); assert.equal(phase2.mergeTitleFromResult({}, 'First'), 'First');
  assert.equal(name([{ title: '   ' }]), 'First'); assert.equal(name([{ title: '""' }]), 'First');
  assert.equal(name([{ title: 'x'.repeat(phase2.MERGE_TITLE_MAX) }]), 'x'.repeat(phase2.MERGE_TITLE_MAX));
  assert.equal(name([{ title: 'x'.repeat(phase2.MERGE_TITLE_MAX + 1) }]), 'First');
});

const mergeModal = (ai, over = {}) => {
  const log = { submitted: [], cancelled: 0 };
  const modal = new phase2.MergeTopicsModal({}, 3, 'First', title => log.submitted.push(title), () => { log.cancelled++; }, ai);
  modal.open();
  const input = dom.find(modal.contentEl, i => i.tag === 'input' && i.type === 'text');
  const box = dom.find(modal.contentEl, i => i.type === 'checkbox');
  const main = dom.find(modal.modalEl, i => i.tag === 'button' && /Merge/.test(i.text));
  return { modal, log, input, box, main };
};

test('merge dialog without AI (all sources empty) is the plain structure merge: no AI text, no checkbox', () => {
  const { modal, log, box, main, input } = mergeModal(undefined);
  assert.equal(box, undefined); assert.equal(main.text, label('ui.merge_confirm'));
  assert.equal(dom.texts(modal.contentEl).some(text => text === label('ui.merge_ai_desc').replace('{0}', '3')), false);
  main.click();
  assert.deepEqual(log.submitted, ['First']); assert.equal(log.cancelled, 0); assert.equal(input.value, 'First');
});

test('merge dialog with content: AI is the default, the checkbox switches to the plain merge', () => {
  let started = 0;
  const { modal, log, box, main } = mergeModal({ start: async () => { started++; return false; } });
  assert.ok(box, 'checkbox shown'); assert.equal(box.checked, false);
  assert.ok(dom.texts(modal.contentEl).includes(label('ui.merge_no_ai')));
  assert.ok(dom.texts(modal.contentEl).includes(label('ui.merge_ai_desc').replace('{0}', '3')));
  assert.equal(main.text, label('ui.merge_with_ai'));
  const desc = text => dom.find(modal.contentEl, i => i.text === text);
  const aiDesc = label('ui.merge_ai_desc').replace('{0}', '3'), plainDesc = label('ui.merge_confirm_desc').replace('{0}', '3');
  assert.equal(desc(aiDesc).hidden, false, 'AI on: the AI description shows'); assert.equal(desc(plainDesc).hidden, true);
  box.checked = true; box.change();
  assert.equal(desc(aiDesc).hidden, true, 'ticked: the AI description is hidden'); assert.equal(desc(plainDesc).hidden, false, 'and the plain-merge one shows');
  assert.equal(main.text, label('ui.merge_confirm'));
  box.checked = false; box.change();
  assert.equal(desc(aiDesc).hidden, false, 'unticked: back to the AI description'); assert.equal(desc(plainDesc).hidden, true);
  box.checked = true; box.change();
  main.click();
  assert.deepEqual(log.submitted, ['First']); assert.equal(started, 0, 'the skip option never calls AI');
});

test('merge dialog AI path: a declined usage notice leaves the dialog open and starts nothing; accepting detaches without cancelling', async () => {
  const calls = [];
  let answer = false;
  const { modal, log, main } = mergeModal({ start: async (title, started, signal) => { calls.push([title, signal.aborted]); if (answer) started(); return answer; } });
  main.click(); await dom.tick();
  assert.deepEqual(calls, [['First', false]]); assert.equal(modal.closeCount, 0, 'declined: still open'); assert.equal(log.cancelled, 0); assert.equal(main.disabled, false, 'can press again');
  answer = true;
  main.click(); await dom.tick();
  assert.equal(modal.closeCount, 1, 'accepted: hidden'); assert.equal(log.cancelled, 0, 'detached: closing is not a cancel'); assert.deepEqual(log.submitted, []);
  assert.equal(calls[1][1], false, 'the signal was not aborted by the detach close');
});

test('merge dialog AI path: closing before AI starts aborts the pending start and cancels', async () => {
  let signal; let release;
  const { modal, log, main } = mergeModal({ start: (_title, _started, s) => { signal = s; return new Promise(resolve => { release = resolve; }); } });
  main.click(); await dom.tick();
  assert.equal(main.disabled, true, 'a second press while waiting is ignored');
  modal.close();
  assert.equal(signal.aborted, true); assert.equal(log.cancelled, 1);
  release(false); await dom.tick();
});

test('merge dialog: the AI path hides the name field (the AI names the topic); skipping AI shows it again and still needs a name', async () => {
  const calls = [];
  const { modal, input, box, main } = mergeModal({ start: async title => { calls.push(title); return false; } });
  assert.equal(input.hidden, true); assert.equal(main.disabled, false);
  input.value = ''; input.input(); assert.equal(main.disabled, false, 'no typed name is needed with AI');
  main.click(); await dom.tick(); assert.deepEqual(calls, ['First'], 'the first source title is only the fallback name');
  box.checked = true; box.change();
  assert.equal(input.hidden, false); assert.equal(main.disabled, true, 'the plain merge needs a name');
  box.checked = false; box.change(); assert.equal(input.hidden, true); assert.equal(main.disabled, false);
});

test('draft review (still used by synthesis) has no name field: merging no longer reviews, the AI name is applied directly', async () => {
  const obsidian = { ...require('../support.cjs').obsidian, Modal: dom.makeModal(), Component: class { load() {} unload() {} addChild(c) { return c; } removeChild() {} }, MarkdownRenderer: { render: async () => {} }, setIcon: () => {} };
  const { DraftReviewModal } = load('main.ts', { obsidian });
  const got = [];
  const modal = new DraftReviewModal({}, 'S', 'D', { intro: 'Intro', confirmLabel: 'Confirm' }, (...args) => { got.push(args); });
  modal.open();
  assert.equal(dom.find(modal.contentEl, i => i.tag === 'input'), undefined, 'no name field');
  dom.button(modal.modalEl, 'Confirm').click(); await dom.tick();
  assert.deepEqual(got, [['S', 'D']]);
});

// ---- hypothesis-evidence (P3): merge and removal keep evidence and prerequisite links consistent ----
const heObsidian = require('../support.cjs').obsidian;
const heDom = require('../support-dom.cjs');
const heRel = (kind, from, to) => ({ kind, from, to });
test('hypothesis-evidence: mergeEligibility has no type input: any selection of ordinary eligibility merges, in sibling and in parent mode', () => {
  const base = { nodes: family(), hasNote: () => true, busy: () => false };
  assert.equal(mergeEligibility({ ...base, ids: ['a', 'b'] }).ok, true);
  assert.equal(mergeEligibility({ ...base, ids: ['root', 'a', 'c'] }).ok, true);
  // A leftover isHypothesis input is ignored: types never block a merge.
  assert.equal(mergeEligibility({ ...base, ids: ['a', 'b'], isHypothesis: () => true }).ok, true);
});
async function heHarness() {
  const { repo, app, contents } = fixture(), path = await repo.createMap('Relations', []), mapDoc = await repo.readMap(path);
  const ids = {}, notes = {};
  const add = async (key, parentKey, kind) => {
    const n = await repo.createNote(key, 'a', mapDoc, path, 'workspace', kind ? { topicKind: kind === true ? 'hypothesis' : kind } : {});
    n.parentId = parentKey ? ids[parentKey] : null; n.x = 400; n.y = 100 * mapDoc.nodes.length; mapDoc.nodes.push(n); ids[key] = n.id; notes[key] = n;
  };
  await add('root'); await add('f1', 'root'); await add('f2', 'root'); await add('x', 'root'); await add('hyp', 'root', true); await add('hyp2', 'root', true);
  let queue = Promise.resolve();
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: () => repo.rebuildDerivedData(), mutate(work) { queue = queue.then(work); return queue; }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, quickExpandPending: new Set(), activeTasks: new Map(), expansionBatches: new Map() };
  const notices = [];
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...heObsidian, Notice: heDom.makeNotice(notices) } }, { requestAnimationFrame: run => { run(); return 1; }, cancelAnimationFrame() {} });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = path; view.map = mapDoc; view.render = () => {}; view.focusNode = () => {}; view.drawEdges = () => {}; view.updateHistoryButtons = () => {};
  const relate = async list => { mapDoc.topicRelations = list; await repo.saveMap(path, mapDoc); view.map = await repo.readMap(path); await repo.rebuildDerivedData(); await view.hydrate(); };
  const saved = async () => repo.readMap(path);
  const relations = async () => plain((await saved()).topicRelations ?? null);
  const mergeKeys = async keys => {
    view.multiSelected = new Set(keys.map(k => ids[k]));
    const check = view.mergeCheck(); assert.equal(check.ok, true, JSON.stringify(check));
    await view.mergeSelected('Merged', { path, mapId: mapDoc.id, targetId: check.targetId, sources: check.sources.map(n => ({ id: n.id, path: n.path })) });
    return check;
  };
  await view.hydrate();
  return { repo, app, contents, path, mapDoc, ids, notes, view, notices, relate, saved, relations, mergeKeys, mergedId: async () => (await saved()).nodes.find(n => n.id !== undefined && !Object.values(ids).includes(n.id))?.id };
}
integrationTest('hypothesis-evidence: merging two facts that are evidence for the same hypothesis leaves one link; undo brings both back', async () => {
  const h = await heHarness();
  await h.relate([heRel('supports', h.ids.f1, h.ids.hyp), heRel('supports', h.ids.f2, h.ids.hyp), heRel('supports', h.ids.f2, h.ids.hyp2)]);
  const original = await h.relations();
  await h.mergeKeys(['f1', 'f2']);
  const merged = await h.mergedId();
  assert.ok(merged);
  assert.deepEqual(await h.relations(), [heRel('supports', merged, h.ids.hyp), heRel('supports', merged, h.ids.hyp2)], 'one link per hypothesis, from the merged topic');
  await h.view.travel(false);
  assert.deepEqual(await h.relations(), original, 'undo restores both original links');
  await h.view.travel(true);
  assert.deepEqual(await h.relations(), [heRel('supports', merged, h.ids.hyp), heRel('supports', merged, h.ids.hyp2)], 'redo merges again');
});
integrationTest('hypothesis-evidence: a prerequisite that becomes a self link after a merge is deleted; the key goes when nothing is left', async () => {
  const h = await heHarness();
  await h.relate([heRel('prerequisite', h.ids.f1, h.ids.f2)]);
  await h.mergeKeys(['f1', 'f2']);
  assert.equal((await h.saved()).topicRelations, undefined);
  assert.equal(h.view.droppedCyclesOfLastMerge(), 0, 'a self link is not a dropped cycle');
  await h.view.travel(false);
  assert.deepEqual(await h.relations(), [heRel('prerequisite', h.ids.f1, h.ids.f2)]);
});
integrationTest('hypothesis-evidence: a merge that would close a prerequisite cycle drops that link and keeps the count for the notice; undo restores all', async () => {
  const h = await heHarness();
  await h.relate([heRel('prerequisite', h.ids.f1, h.ids.x), heRel('prerequisite', h.ids.x, h.ids.f2)]);
  const original = await h.relations();
  await h.mergeKeys(['f1', 'f2']);
  const merged = await h.mergedId();
  assert.deepEqual(await h.relations(), [heRel('prerequisite', merged, h.ids.x)]);
  assert.equal(h.view.droppedCyclesOfLastMerge(), 1);
  await h.view.travel(false);
  assert.deepEqual(await h.relations(), original);
});
integrationTest('hypothesis-evidence: a merge that drops a cycle-closing prerequisite shows the count in a Notice, and undo brings the link back; a merge that drops none shows nothing', async () => {
  const h = await heHarness();
  await h.relate([heRel('prerequisite', h.ids.f1, h.ids.x), heRel('prerequisite', h.ids.x, h.ids.f2)]);
  const original = await h.relations();
  await h.mergeKeys(['f1', 'f2']);
  assert.deepEqual(h.notices, ['Removed 1 derives-from or prerequisite link(s) that would form a cycle']);
  await h.view.travel(false);
  assert.deepEqual(await h.relations(), original, 'undo restores the dropped link too');
  const quiet = await heHarness();
  await quiet.relate([heRel('prerequisite', quiet.ids.f1, quiet.ids.x)]);
  await quiet.mergeKeys(['f1', 'f2']);
  assert.deepEqual(quiet.notices, [], 'nothing dropped: no Notice');
});
integrationTest('hypothesis-evidence: merging subtopics into a parent re-points their links to the parent and dedupes', async () => {
  const h = await heHarness();
  // f1 and f2 become children of x; x is the parent that keeps its identity.
  for (const key of ['f1', 'f2']) h.mapDoc.nodes.find(n => n.id === h.ids[key]).parentId = h.ids.x;
  await h.relate([heRel('supports', h.ids.f1, h.ids.hyp), heRel('supports', h.ids.x, h.ids.hyp), heRel('prerequisite', h.ids.f2, h.ids.x), heRel('prerequisite', h.ids.f2, h.ids.hyp2)]);
  const original = await h.relations();
  const check = await h.mergeKeys(['x', 'f1', 'f2']);
  assert.equal(check.targetId, h.ids.x);
  assert.deepEqual(await h.relations(), [heRel('supports', h.ids.x, h.ids.hyp), heRel('prerequisite', h.ids.x, h.ids.hyp2)], 'f1 folded into the existing x link; f2 to x became a self link');
  await h.view.travel(false);
  assert.deepEqual(await h.relations(), original);
});
integrationTest('hypothesis-evidence: mergeSelected with two hypotheses merges them into a new hypothesis that keeps the first one\'s strength; undo restores both and the links', async () => {
  const h = await heHarness();
  await h.relate([heRel('supports', h.ids.f1, h.ids.hyp), heRel('verifies', h.ids.f2, h.ids.hyp2)]);
  await h.repo.writeHypothesisStrength(h.notes.hyp.path, 'strong');
  await h.view.hydrate();
  const original = await h.relations();
  assert.equal(h.view.mergeCheck([h.ids.hyp, h.ids.hyp2]).ok, true);
  await h.mergeKeys(['hyp', 'hyp2']);
  const merged = await h.mergedId(), note = await h.repo.readNote((await h.saved()).nodes.find(n => n.id === merged).path, await h.saved());
  assert.equal(h.notices.length, 0);
  assert.equal(note.topicKind, 'hypothesis'); assert.equal(note.hypothesisStrength, 'strong');
  assert.deepEqual(await h.relations(), [heRel('supports', h.ids.f1, merged), heRel('verifies', h.ids.f2, merged)]);
  await h.view.travel(false);
  assert.deepEqual(await h.relations(), original);
  assert.ok((await h.saved()).nodes.some(n => n.id === h.ids.hyp) && (await h.saved()).nodes.some(n => n.id === h.ids.hyp2));
});
integrationTest('hypothesis-evidence: removing a fact or a hypothesis leaves no dangling link (both kinds) and undo restores the links', async () => {
  for (const [removeKey, branch, expected] of [['f1', false, 2], ['hyp', false, 2]]) {
    const h = await heHarness();
    await h.relate([heRel('supports', h.ids.f1, h.ids.hyp), heRel('prerequisite', h.ids.f1, h.ids.hyp), heRel('prerequisite', h.ids.f2, h.ids.hyp2), heRel('supports', h.ids.f2, h.ids.hyp2)]);
    const original = await h.relations();
    await h.view.removeToUnassigned(h.notes[removeKey], branch);
    const left = await h.relations();
    assert.equal(left.length, expected, removeKey);
    const live = new Set((await h.saved()).nodes.map(n => n.id));
    assert.ok(left.every(r => live.has(r.from) && live.has(r.to)), `${removeKey}: no dangling end`);
    await h.view.travel(false);
    assert.deepEqual(await h.relations(), original, `${removeKey}: undo restores`);
  }
});
integrationTest('hypothesis-evidence: removing the selection (removeSelected) drops links of every removed topic; undo restores them', async () => {
  const h = await heHarness();
  await h.relate([heRel('supports', h.ids.f1, h.ids.hyp), heRel('prerequisite', h.ids.hyp2, h.ids.x), heRel('supports', h.ids.f2, h.ids.hyp2)]);
  const original = await h.relations();
  h.view.multiSelected = new Set([h.ids.hyp, h.ids.x]);
  await h.view.removeSelected();
  assert.deepEqual(await h.relations(), [heRel('supports', h.ids.f2, h.ids.hyp2)]);
  await h.view.travel(false);
  assert.deepEqual(await h.relations(), original);
});
integrationTest('hypothesis-evidence: a structure-review merge allows a hypothesis on either side; links move to the adopter, the adopter keeps its type, undo restores', async () => {
  const h = await heHarness();
  await h.relate([heRel('supports', h.ids.f1, h.ids.hyp), heRel('prerequisite', h.ids.f1, h.ids.x)]);
  const original = await h.relations();
  await h.view.removeToUnassigned(h.notes.hyp, false, h.ids.x);
  assert.deepEqual(h.notices, [], 'a hypothesis can be merged into another topic');
  assert.deepEqual(await h.relations(), [heRel('supports', h.ids.f1, h.ids.x), heRel('prerequisite', h.ids.f1, h.ids.x)]);
  await h.view.travel(false);
  assert.deepEqual(await h.relations(), original);
  await h.view.removeToUnassigned(h.notes.f1, false, h.ids.hyp);
  assert.deepEqual(h.notices, [], 'a hypothesis can take over another topic');
  assert.deepEqual(await h.relations(), [heRel('prerequisite', h.ids.hyp, h.ids.x)]);
  assert.equal((await h.repo.readNote(h.notes.hyp.path, await h.saved())).topicKind, 'hypothesis', 'the adopter keeps its own type');
  await h.view.travel(false);
  assert.deepEqual(await h.relations(), original);
});
// ---- hypothesis-evidence (P14): any type merges, the first source's type carries over ----
const heMergedNote = async h => { const map = await h.saved(), node = map.nodes.find(n => n.id === h.mergedIdNow); return { ...(await h.repo.readNote(node.path, map)), path: node.path }; };
async function heKindOf(h, keys) {
  await h.mergeKeys(keys);
  h.mergedIdNow = await h.mergedId();
  return heMergedNote(h);
}
integrationTest('hypothesis-evidence: sibling merge with a strong hypothesis first gives a strong hypothesis; the frontmatter has both keys', async () => {
  const h = await heHarness();
  h.notes.hyp.y = 1; await h.relate([]); await h.repo.writeHypothesisStrength(h.notes.hyp.path, 'strong'); await h.view.hydrate();
  const note = await heKindOf(h, ['hyp', 'f1']);
  assert.equal(note.topicKind, 'hypothesis'); assert.equal(note.hypothesisStrength, 'strong');
  const raw = h.contents.get(note.path);
  assert.match(raw, /topic-kind: hypothesis/); assert.match(raw, /hypothesis-strength: strong/);
});
integrationTest('hypothesis-evidence: sibling merge follows reading order, not selection order: an ordinary topic first gives an ordinary topic with no topic-kind key', async () => {
  const h = await heHarness();
  h.notes.f1.y = 1; h.notes.hyp.y = 500; await h.relate([]);
  const note = await heKindOf(h, ['hyp', 'f1']);
  assert.equal(note.topicKind, undefined); assert.equal(note.hypothesisStrength, undefined);
  assert.doesNotMatch(h.contents.get(note.path), /topic-kind|hypothesis-strength/);
});
integrationTest('hypothesis-evidence: sibling merge with an evidence topic first (or any of the other four kinds) gives that kind', async () => {
  for (const kind of ['evidence', 'action', 'atomic', 'conclusion']) {
    const h = await heHarness();
    await h.repo.writeTopicKind(h.notes.f1.path, kind); await h.view.hydrate();
    h.notes.f1.y = 1; h.notes.f2.y = 500; await h.relate([]);
    const note = await heKindOf(h, ['f2', 'f1']);
    assert.equal(note.topicKind, kind, kind);
    assert.equal(note.hypothesisStrength, undefined, `${kind}: no strength key`);
    assert.doesNotMatch(h.contents.get(note.path), /hypothesis-strength/);
  }
});
integrationTest('hypothesis-evidence: parent mode keeps the target\'s own type and strength whatever the children are', async () => {
  const h = await heHarness();
  for (const key of ['f1', 'hyp']) h.mapDoc.nodes.find(n => n.id === h.ids[key]).parentId = h.ids.x;
  await h.relate([]); await h.repo.writeTopicKind(h.notes.x.path, 'conclusion'); await h.view.hydrate();
  const check = await h.mergeKeys(['x', 'f1', 'hyp']);
  assert.equal(check.targetId, h.ids.x);
  const note = await h.repo.readNote(h.notes.x.path, await h.saved());
  assert.equal(note.topicKind, 'conclusion'); assert.equal(note.hypothesisStrength, undefined);
});
integrationTest('hypothesis-evidence: a derives-from merge that closes a cycle drops the link, the Notice names derives-from or prerequisite, and undo restores everything including the type', async () => {
  const h = await heHarness();
  await h.repo.writeTopicKind(h.notes.f1.path, 'atomic'); await h.view.hydrate();
  h.notes.f1.y = 1;
  await h.relate([heRel('derives_from', h.ids.f1, h.ids.x), heRel('derives_from', h.ids.x, h.ids.f2), heRel('prerequisite', h.ids.f1, h.ids.hyp), heRel('prerequisite', h.ids.hyp, h.ids.f2)]);
  const original = await h.relations();
  await h.mergeKeys(['f1', 'f2']);
  const merged = await h.mergedId();
  assert.deepEqual(await h.relations(), [heRel('derives_from', merged, h.ids.x), heRel('prerequisite', merged, h.ids.hyp)]);
  assert.equal(h.view.droppedCyclesOfLastMerge(), 2);
  assert.deepEqual(h.notices, ['Removed 2 derives-from or prerequisite link(s) that would form a cycle']);
  await h.view.travel(false);
  assert.deepEqual(await h.relations(), original);
  const map = await h.saved();
  assert.ok(map.nodes.some(n => n.id === h.ids.f1) && map.nodes.some(n => n.id === h.ids.f2) && !map.nodes.some(n => n.id === merged));
  assert.equal((await h.repo.readNote(h.notes.f1.path, map)).topicKind, 'atomic', 'the source keeps its type');
});
integrationTest('hypothesis-evidence: merging A and C that both relate to B leaves one related link (either direction); undo brings both back', async () => {
  const h = await heHarness();
  await h.relate([heRel('related', h.ids.f1, h.ids.x), heRel('related', h.ids.x, h.ids.f2)]);
  const original = await h.relations();
  await h.mergeKeys(['f1', 'f2']);
  const merged = await h.mergedId(), left = await h.relations();
  assert.equal(left.length, 1); assert.equal(left[0].kind, 'related');
  assert.deepEqual([left[0].from, left[0].to].sort(), [merged, h.ids.x].sort());
  await h.view.travel(false);
  assert.deepEqual(await h.relations(), original);
});
integrationTest('hypothesis-evidence: removing an endpoint of each of the six relation kinds deletes the relation; undo restores all six', async () => {
  const h = await heHarness();
  await h.relate(['supports', 'contradicts', 'verifies', 'derives_from', 'related', 'prerequisite'].map((kind, i) => heRel(kind, h.ids.f1, [h.ids.f2, h.ids.x, h.ids.hyp, h.ids.hyp2, h.ids.root, h.ids.f2][i])));
  const original = await h.relations();
  assert.equal(original.length, 6);
  assert.equal(new Set(original.map(r => r.kind)).size, 6);
  await h.view.removeToUnassigned(h.notes.f1, false);
  assert.equal((await h.saved()).topicRelations, undefined, 'every relation touching the removed topic is gone');
  await h.view.travel(false);
  assert.deepEqual(await h.relations(), original);
});
integrationTest('hypothesis-evidence: the full selected-line label comes from i18n: half-width colon in English, full-width in Chinese, related uses the dash', () => {
  const { translate } = load('i18n.ts');
  for (const [lang, colon] of [['en', ': '], ['zh-TW', '：'], ['zh-CN', '：']]) {
    assert.equal(translate(lang, 'ui.relation_label_full_0_1_2', 'N', 'A', 'B'), `N${colon}A → B`, lang);
    assert.equal(translate(lang, 'ui.relation_label_full_related_0_1_2', 'N', 'A', 'B'), `N${colon}A — B`, lang);
  }
});
