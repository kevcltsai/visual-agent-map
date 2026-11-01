// Summary brackets P1 (A1, A2, A3 pure part, A5): data, cleanup, compatibility with 0.28.0, AI context.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { load } = require('./support.cjs');
const { loadSource } = require('./support-replay.cjs');
const ci = load('experiences/visual-map/canvas-items.ts');
const { buildMapChatContext } = load('core/map-chat-context.ts');
const { parseMapChat } = load('core/steps/map-chat/step.ts');
const { taskPrompt } = load('core/steps/task/render.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const sanitize = raw => plain(ci.sanitizeCanvasItems(raw));
const sum = (over = {}) => ({ id: 's1', kind: 'summary', parentId: 'p', members: ['b', 'c'], text: 'Too costly, postpone', ...over });
const node = (id, parentId = null) => ({ id, parentId });
// root r; p under r with children a b c d; q under r with child x; b has a child b1.
const nodes = [node('r'), node('p', 'r'), node('q', 'r'), node('a', 'p'), node('b', 'p'), node('c', 'p'), node('d', 'p'), node('x', 'q'), node('b1', 'b')];

test('A1: a valid summary round-trips; members are deduped, text is cleaned', () => {
  assert.deepEqual(sanitize([sum()]), [sum()]);
  assert.deepEqual(sanitize([sum({ members: ['b', 'b', 'c'], text: '  hi  ' })]), [sum({ text: 'hi' })]);
  assert.equal(sanitize([sum({ text: 'x'.repeat(5000) })])[0].text.length, ci.TEXT_LIMIT);
});

test('A1: bad summaries drop only themselves and never throw', () => {
  const good = sum({ id: 'ok' });
  const bad = [
    sum({ id: 'e1', members: [] }),
    sum({ id: 'e2', members: 'b' }),
    sum({ id: 'e3', members: ['b', 3] }),
    sum({ id: 'e4', members: ['bad id!'] }),
    sum({ id: 'e5', members: Array.from({ length: 51 }, (_, i) => `n${i}`) }),
    sum({ id: 'e6', parentId: undefined }),
    sum({ id: 'e7', parentId: '../x' }),
    sum({ id: 'e8', text: '   ' }),
    sum({ id: 'e9', text: 42 }),
    sum({ id: 'bad id' }),
    { kind: 'summary' }
  ];
  assert.deepEqual(sanitize([...bad, good]), [good]);
  assert.equal(sanitize([sum({ members: Array.from({ length: 50 }, (_, i) => `n${i}`) })]).length, 1);
  assert.deepEqual(sanitize([sum(), sum({ members: ['a'] })]).map(i => i.id), ['s1'], 'duplicate id keeps the first');
});

test('A1: a map without summaries is unchanged byte for byte', () => {
  const items = [{ id: 'i1', kind: 'image', path: 'a.png', x: 1, y: 2, w: 3, h: 4 }, { id: 'b1', kind: 'boundary', members: ['n1'] }];
  assert.equal(JSON.stringify(sanitize(items)), JSON.stringify(items));
});

test('A2: the 0.28.0 sanitize keeps a summary as is; the new one drops dangling members on write', () => {
  // CI checks out without tags, so fall back to the committed copy of the same 0.28.0 file.
  let source;
  try {
    source = execFileSync('git', ['show', '0.28.0:experiences/visual-map/canvas-items.ts'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    source = fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy-canvas-items-47c406a.ts.txt'), 'utf8');
  }
  const old = loadSource(source);
  const items = [sum(), { id: 'i1', kind: 'image', path: 'a.png', x: 1, y: 2, w: 3, h: 4 }];
  const oldOut = plain(old.sanitizeCanvasItems(items));
  assert.deepEqual(oldOut, items, 'old plugin reads and writes the summary untouched');
  assert.deepEqual(sanitize(oldOut), items);
  // Old plugin deleted b and c's card: the new one skips them on display and clears them on write.
  const afterOldDelete = nodes.filter(n => n.id !== 'b');
  assert.deepEqual(plain(ci.effectiveSummaryRange(sum(), afterOldDelete)), ['c']);
  assert.deepEqual(plain(ci.pruneSummaries(items, afterOldDelete))[0].members, ['c']);
  assert.deepEqual(plain(ci.pruneSummaries(items, nodes.filter(n => n.id !== 'b' && n.id !== 'c'))), [items[1]], 'no member left removes the bracket');
  // Old plugin moved c under q: the member no longer belongs to the parent.
  const moved = nodes.map(n => (n.id === 'c' ? { ...n, parentId: 'q' } : n));
  assert.deepEqual(plain(ci.effectiveSummaryRange(sum(), moved)), ['b']);
  assert.deepEqual(plain(ci.pruneSummaries(items, moved))[0].members, ['b']);
});

test('A3: addSummary accepts adjacent siblings and refuses the rest with a reason', () => {
  const ok = ci.addSummary([], { id: 's1', members: ['c', 'b'], text: 'T' }, nodes);
  assert.equal(ok.ok, true);
  assert.deepEqual(plain(ok.items), [sum({ members: ['b', 'c'], text: 'T' })], 'members come out in sibling order');
  assert.equal(ci.addSummary([], { id: 's1', members: ['b'], text: 'T' }, nodes).ok, true, 'one card is fine');
  const refuse = (members, reason, text = 'T') => {
    const r = ci.addSummary([], { id: 's1', members, text }, nodes);
    assert.deepEqual([r.ok, r.reason, r.items.length], [false, reason, 0], JSON.stringify(members));
  };
  refuse(['a', 'c'], 'not-adjacent');
  refuse(['b', 'x'], 'cross-parent');
  refuse(['b', 'b1'], 'cross-parent');
  refuse(['r'], 'root');
  refuse(['p', 'x'], 'cross-parent');
  refuse(['b', 'gone'], 'unknown');
  refuse([], 'invalid');
  refuse(['b'], 'invalid', '   ');
  refuse(Array.from({ length: 51 }, (_, i) => `n${i}`), 'too-many');
  const dup = ci.addSummary(ok.items, { id: 's1', members: ['a'], text: 'T' }, nodes);
  assert.deepEqual([dup.ok, dup.reason], [false, 'duplicate']);
});

test('A3: effective range takes every sibling between the first and last member', () => {
  assert.deepEqual(plain(ci.effectiveSummaryRange(sum({ members: ['a', 'd'] }), nodes)), ['a', 'b', 'c', 'd']);
  assert.deepEqual(plain(ci.effectiveSummaryRange(sum({ members: ['d', 'b'] }), nodes)), ['b', 'c', 'd']);
  assert.deepEqual(plain(ci.effectiveSummaryRange(sum({ members: ['gone'] }), nodes)), []);
  // Sibling order is the order in the node list.
  const reordered = [node('r'), node('p', 'r'), node('c', 'p'), node('a', 'p'), node('b', 'p')];
  assert.deepEqual(plain(ci.effectiveSummaryRange(sum({ members: ['c', 'b'] }), reordered)), ['c', 'a', 'b']);
});

test('A3: edit text, change members, remove; refusals leave the list unchanged', () => {
  const items = [sum(), { kind: 'sticky', id: 'z' }];
  assert.equal(plain(ci.setSummaryText(items, 's1', ' New '))[0].text, 'New');
  assert.deepEqual(plain(ci.setSummaryText(items, 's1', '  ')), items, 'empty text changes nothing');
  assert.deepEqual(plain(ci.setSummaryText(items, 'nope', 'x')), items);
  const grown = ci.setSummaryMembers(items, 's1', ['b', 'c', 'd'], nodes);
  assert.deepEqual([grown.ok, plain(grown.items)[0].members], [true, ['b', 'c', 'd']]);
  const bad = ci.setSummaryMembers(items, 's1', ['a', 'c'], nodes);
  assert.deepEqual([bad.ok, bad.reason, plain(bad.items)], [false, 'not-adjacent', items]);
  assert.equal(ci.setSummaryMembers(items, 'nope', ['b'], nodes).reason, 'unknown');
  assert.deepEqual(plain(ci.removeSummary(items, 's1')), [items[1]]);
  assert.deepEqual(plain(ci.removeSummary(items, 'nope')), items);
});

test('A3: removing cards cleans members in the same call (card, batch, branch, move)', () => {
  const items = [sum({ members: ['a', 'b', 'c'] }), sum({ id: 's2', parentId: 'q', members: ['x'] })];
  // single card
  assert.deepEqual(plain(ci.removeSummaryMembers(items, ['b']))[0].members, ['a', 'c']);
  // batch
  assert.deepEqual(plain(ci.removeSummaryMembers(items, new Set(['a', 'b', 'c']))).map(i => i.id), ['s2']);
  // branch delete: the parent goes with its subtree
  assert.deepEqual(plain(ci.removeSummaryMembers(items, ['q', 'x'])).map(i => i.id), ['s1']);
  assert.deepEqual(plain(ci.removeSummaryMembers(items, ['p'])).map(i => i.id), ['s2'], 'parent removed drops its brackets');
  // untouched brackets keep identity; nothing to remove changes nothing
  assert.equal(ci.removeSummaryMembers(items, ['zz'])[0], items[0]);
  // pure: the input is not mutated
  assert.deepEqual(items[0].members, ['a', 'b', 'c']);
  // move: b goes under q, the bracket shrinks (prune against the new tree)
  const moved = nodes.map(n => (n.id === 'b' ? { ...n, parentId: 'q' } : n));
  assert.deepEqual(plain(ci.pruneSummaries(items, moved))[0].members, ['a', 'c']);
});

test('A3: undo is a snapshot of the item list, so add/edit/range/remove each restore exactly', () => {
  const before = [{ id: 'i1', kind: 'image', path: 'a.png', x: 1, y: 2, w: 3, h: 4 }];
  const snap = plain(before);
  const added = ci.addSummary(before, { id: 's1', members: ['b'], text: 'T' }, nodes).items;
  const edited = ci.setSummaryText(added, 's1', 'U');
  const ranged = ci.setSummaryMembers(edited, 's1', ['b', 'c'], nodes).items;
  ci.removeSummary(ranged, 's1');
  assert.deepEqual(plain(before), snap, 'inputs never mutate');
  assert.deepEqual(plain(ci.removeSummary(added, 's1')), snap);
});

// ---- A5 ----
const outline = [
  { id: 'p', title: 'P', summary: '', parentId: null, depth: 0 },
  { id: 'a', title: 'A', summary: '', parentId: 'p', depth: 1 },
  { id: 'b', title: 'B', summary: '', parentId: 'p', depth: 1 },
  { id: 'c', title: 'C', summary: '', parentId: 'p', depth: 1 }
];
const chatInput = extra => ({ mapTitle: 'M', outline, selected: [], references: [], snippets: [], files: [], activeFile: null, history: [], ...extra });
const item = (kind, fields = {}) => ({ kind, nodeId: '', ref: '', parentId: '', newParentId: '', title: '', summary: '', detail: '', path: '', find: '', replace: '', content: '', nodeIds: [], all: false, branch: false, action: '', goal: '', direction: '', mode: '', images: false, ...fields });
const TEXT = 'Both point to excessive cost; recommend postponing';
const pNodes = [node('p'), node('a', 'p'), node('b', 'p'), node('c', 'p')];
const bracket = { id: 'sum-1', kind: 'summary', parentId: 'p', members: ['b', 'c'], text: TEXT };

test('A5 integration context: only the framed children and the user text, once; none for other parents or no bracket', () => {
  const titleOf = id => ({ a: 'A', b: 'B', c: 'C' })[id] ?? id;
  const text = ci.summaryDirectionContext([bracket], pNodes, 'p', titleOf);
  assert.equal(text, `- B; C\n  ${TEXT}`);
  assert.ok(!text.includes('A;') && !/\bA\b/.test(text), 'A is not listed');
  assert.equal(ci.summaryDirectionContext([bracket], pNodes, 'a', titleOf), '');
  assert.equal(ci.summaryDirectionContext([], pNodes, 'p', titleOf), '');
  assert.equal(ci.summaryDirectionContext([bracket], pNodes.filter(n => n.id !== 'b' && n.id !== 'c'), 'p', titleOf), '', 'dangling bracket adds nothing');
  assert.equal(ci.summaryDirectionContext([{ ...bracket, text: 'l1\nl2' }], pNodes, 'p', titleOf), '- B; C\n  l1\n  l2');
  const base = { title: 'P', summary: 's', rules: '', detail: '', task: 'do', ancestors: '', mode: 'synthesize', researchMode: 'local', researchDepth: 'normal' };
  for (const language of ['en', 'zh-TW']) {
    const without = taskPrompt(base, language);
    assert.equal(taskPrompt({ ...base, summaryDirections: '' }, language), without, 'no bracket: prompt bytes unchanged');
    const prompt = taskPrompt({ ...base, summaryDirections: text }, language);
    assert.equal(prompt.split(TEXT).length - 1, 1, 'text appears once');
    assert.match(prompt, language === 'en' ? /written by the user, read-only/ : /使用者撰寫、唯讀/);
    assert.match(prompt, language === 'en' ? /state the gap|say so explicitly/ : /明確寫出落差/);
    assert.ok(prompt.indexOf(TEXT) < prompt.indexOf(language === 'en' ? 'Ancestor topic context' : '祖先議題背景'));
  }
});

test('A5 research prompt: a research task carries no summary directions unless the caller passes them', () => {
  const base = { title: 'P', summary: 's', rules: '', detail: '', task: 'do', ancestors: '', mode: 'task', researchMode: 'research', researchDepth: 'normal' };
  for (const language of ['en', 'zh-TW']) assert.ok(!taskPrompt(base, language).includes(TEXT));
});

test('A5 chat: summaries go in read-only with member titles; no summaries = unchanged bytes; writeback on the summary id is refused', () => {
  const plainJson = buildMapChatContext(chatInput()).json;
  assert.equal(buildMapChatContext(chatInput({ summaries: [] })).json, plainJson);
  assert.ok(!plainJson.includes('summaries'));
  const ctx = buildMapChatContext(chatInput({ summaries: [{ id: 'sum-1', parentId: 'p', members: ['b', 'c', 'gone'], text: TEXT }] }));
  const parsed = JSON.parse(ctx.json);
  assert.deepEqual(parsed.summaries, [{ id: 'sum-1', parentId: 'p', readOnly: true, members: [{ id: 'b', title: 'B' }, { id: 'c', title: 'C' }], text: TEXT }]);
  assert.match(parsed.summariesNote, /must not be rewritten or deleted/);
  assert.equal(ctx.json.split(TEXT).length - 1, 1);
  assert.ok(!ctx.nodeIds.includes('sum-1') && !('sum-1' in ctx.topicHashes) && !('sum-1' in ctx.parents));
  assert.ok(!parsed.outline.some(n => n.id === 'sum-1'));
  const bads = [item('edit_topic_note', { nodeId: 'sum-1', detail: 'x' }), item('update_summary', { nodeId: 'sum-1', summary: 'x' }), item('rename_topic', { nodeId: 'sum-1', title: 'x' }), item('delete_topic', { nodeId: 'sum-1' }), item('move_topic', { nodeId: 'sum-1', newParentId: 'a' }), item('add_child', { parentId: 'sum-1', title: 'x' }), item('select_topics', { nodeIds: ['sum-1'] }), item('run_map_action', { action: 'research_standard', nodeIds: ['sum-1'] })];
  const result = plain(parseMapChat(JSON.stringify({ reply: 'ok', actions: bads }), ctx));
  assert.deepEqual(result.actions, [], 'no action on a summary id survives the parser');
  assert.ok(result.rejected.every(entry => entry.code === 'unknown_node'), JSON.stringify(result.rejected));
});
