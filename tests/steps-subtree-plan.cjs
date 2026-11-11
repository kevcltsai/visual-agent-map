// Integrate the whole subtree (P1): the pure plan (levels, counts, call numbers, order, outline) and the synthesize prompt's outline block. Unit level.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./support-replay.cjs');

const M = loadSource(`
export * from "./experiences/visual-map/subtree-plan";
export { assembleTaskPrompt, selectionFromContext } from "./core/steps/task/assemble";
export { buildPreparedTaskContext } from "./ai/context-builder";
`);

const plain = value => JSON.parse(JSON.stringify(value));
const node = (id, parentId, researched = true, extra = {}) => ({ id, parentId, title: extra.title ?? id.toUpperCase(), summary: extra.summary ?? `summary of ${id}`, researched });
// The real sample's shape: root -> 4 -> 21 -> 54 -> 101; only 4 + 1 researched.
function bigMap() {
  const nodes = [node('root', null)];
  const spread = (parents, count, depth, researchedOf) => {
    const made = [];
    for (let i = 0; i < count; i++) {
      const parent = parents[i % parents.length];
      const id = `n${depth}-${i}`;
      nodes.push(node(id, parent.id, researchedOf(i), { title: `第${depth}層議題${i}：一個比較長的標題用來撐大大綱`, summary: `這是第${depth}層議題${i}的摘要，`.padEnd(120, '字') }));
      made.push({ id });
    }
    return made;
  };
  const d1 = spread([{ id: 'root' }], 4, 1, () => true);
  const d2 = spread(d1, 21, 2, i => i === 0);
  const d3 = spread(d2, 54, 3, () => false);
  spread(d3, 101, 4, () => false);
  return nodes;
}

test('stats of the real-sample shape: 4 levels, 180 topics, 5 researched, 80 parents, 101 unresearched leaves', () => {
  const stats = M.subtreeStats(bigMap(), 'root');
  assert.deepEqual(plain(stats), { levels: 4, topics: 180, researched: 5, parents: 80, unresearchedLeaves: 101, directParents: 4, directUnresearchedLeaves: 0 });
  assert.deepEqual(plain(['quick', 'bottom-up', 'research-first'].map(depth => M.integrationCalls(stats, depth))), [6, 81, 182]);
});

test('a root with only direct subtopics is one level; an empty root has none and costs the root call only when it has subtopics', () => {
  const flat = [node('root', null), node('a', 'root'), node('b', 'root', false)];
  const stats = M.subtreeStats(flat, 'root');
  assert.equal(stats.levels, 1);
  assert.deepEqual(plain(M.bottomUpOrder(flat, 'root')), ['root']);
  assert.equal(M.buildSubtreeOutline(flat, 'root').text, '');
  assert.equal(M.subtreeStats([node('root', null)], 'root').levels, 0);
  assert.deepEqual(plain(M.bottomUpOrder([node('root', null)], 'root')), []);
});

// root -> A,B ; A -> A1,A2 ; B -> B1,B2 ; A1 -> A1a,A1b (the live test C2 graph)
const small = (researched = () => true) => [
  node('root', null), node('A', 'root'), node('B', 'root'), node('A1', 'A'), node('A2', 'A'), node('B1', 'B'), node('B2', 'B'), node('A1a', 'A1'), node('A1b', 'A1')
].map(item => ({ ...item, researched: researched(item.id) }));

test('bottom-up order: the deepest parent first, the root last; A1 before A; calls = parents + the root chart step', () => {
  const nodes = small();
  const order = M.bottomUpOrder(nodes, 'root');
  assert.deepEqual(plain(order), ['A1', 'A', 'B', 'root']);
  assert.equal(M.integrationCalls(M.subtreeStats(nodes, 'root'), 'bottom-up'), 5);
  assert.deepEqual(plain(M.quickOrder(nodes, 'root')), ['A', 'B']);
  assert.equal(M.integrationCalls(M.subtreeStats(nodes, 'root'), 'quick'), 4);
});

test('quick also counts each childless unresearched direct subtopic (it is researched first, no chart): 3 + 1 = 4, and a researched or deeper one adds none', () => {
  // root -> A (has B1), C (idea, no children), D (error, no children), E (researched leaf); B1 is deeper and unresearched.
  const nodes = [node('root', null), node('A', 'root'), node('B1', 'A', false), node('C', 'root', false), node('D', 'root', false), node('E', 'root')];
  const stats = M.subtreeStats(nodes, 'root');
  assert.equal(stats.directUnresearchedLeaves, 2);
  assert.equal(M.integrationCalls(stats, 'quick'), 1 + 2 + 2);
  assert.equal(M.integrationCalls(M.subtreeStats(small(), 'root'), 'quick'), 4);
});

test('research-first: the unresearched leaves are named deepest first and counted before the integrations', () => {
  const nodes = small(id => !['A1a', 'A1b', 'B1', 'B2', 'A2'].includes(id));
  assert.deepEqual(plain(M.unresearchedLeaves(nodes, 'root')).slice(0, 2).sort(), ['A1a', 'A1b']);
  assert.equal(M.unresearchedLeaves(nodes, 'root').length, 5);
  assert.equal(M.integrationCalls(M.subtreeStats(nodes, 'root'), 'research-first'), 5 + 4 + 1);
});

test('a cycle in a damaged map does not hang the plan', () => {
  const nodes = [node('root', null), node('a', 'root'), node('b', 'a'), { ...node('a', 'b') }];
  assert.ok(M.subtreeStats(nodes, 'root').topics <= 3);
  assert.ok(M.bottomUpOrder(nodes, 'root').length <= 3);
});

test('outline of the big map: within about 6k characters, every depth-2 title stays, the unresearched list is capped', () => {
  const nodes = bigMap();
  const outline = M.buildSubtreeOutline(nodes, 'root');
  assert.ok(outline.text.length <= M.OUTLINE_MAX_CHARS, `outline is ${outline.text.length}`);
  for (const item of nodes.filter(n => n.id.startsWith('n2-'))) assert.ok(outline.text.includes(item.title), item.title);
  assert.equal(outline.unresearched.total, 175);
  const text = M.subtreeOutlineText(outline);
  assert.match(text, /Unresearched topics: 175 of 180\./);
  assert.match(text, /The other \d+ unresearched topics are deeper down/);
  assert.ok(text.includes('[unresearched]'));
});

test('outline degrades summaries then folds the deepest levels, never the depth-2 titles', () => {
  const nodes = bigMap();
  const roomy = M.buildSubtreeOutline(nodes, 'root', 1e9).text;
  assert.ok(roomy.includes('這是第4層議題0的摘要'), 'with room every summary is kept');
  const tight = M.buildSubtreeOutline(nodes, 'root', 2500).text;
  assert.ok(tight.includes('subtopics)'), 'the deepest levels fold into a count');
  for (const item of nodes.filter(n => n.id.startsWith('n2-'))) assert.ok(tight.includes(item.title));
  const tiny = M.buildSubtreeOutline(nodes, 'root', 1);
  for (const item of nodes.filter(n => n.id.startsWith('n2-'))) assert.ok(tiny.text.includes(item.title), 'depth-2 titles survive any limit');
  assert.ok(!tiny.text.includes('第3層議題0：'), 'depth 3 is folded at the tightest limit');
});

test('outline lines: indent by depth, summary clipped to about 60 characters, newlines flattened', () => {
  const nodes = [node('root', null), node('a', 'root', true, { title: 'A' }), node('b', 'a', true, { title: 'B\nline', summary: 'x'.repeat(200) + '\nmore' })];
  const text = M.buildSubtreeOutline(nodes, 'root').text;
  const lines = text.split('\n');
  assert.equal(lines[0], '- A');
  assert.match(lines[1], /^ {2}- B line — x{60}…$/);
});

test('a title or summary missing gives a bare line; an unresearched topic carries the mark', () => {
  const nodes = [node('root', null), node('a', 'root'), node('b', 'a', false, { title: 'T', summary: '' })];
  assert.equal(M.buildSubtreeOutline(nodes, 'root').text, '- A\n  - T [unresearched]');
});

function promptOf(extra, language = 'zh-TW') {
  const context = { title: 'T', summary: 's', rules: '', detail: 'OLD DETAIL', task: 'integrate', ancestors: '', mode: 'synthesize', researchMode: 'local', visualMode: 'off', ...extra };
  return M.assembleTaskPrompt(M.selectionFromContext(context, language), 'synthesize', context, language).text;
}

test('synthesize prompt carries the outline block only with an outline; fresh leaves out the old Detail', () => {
  for (const language of ['zh-TW', 'en', 'zh-CN']) {
    const plain = promptOf({}, language);
    assert.ok(!plain.includes('[unresearched]'));
    const withOutline = promptOf({ subtreeOutline: '- A\n  - B [unresearched]' }, language);
    assert.ok(withOutline.includes('- A\n  - B [unresearched]'), language);
    assert.ok(withOutline.length > plain.length);
    const fresh = promptOf({ subtreeOutline: '- X', updateMode: 'fresh' }, language);
    assert.ok(!fresh.includes('OLD DETAIL'), 'fresh hides the old Detail');
    assert.ok(promptOf({ updateMode: 'merge' }, language).includes('OLD DETAIL'));
  }
  const research = M.assembleTaskPrompt(M.selectionFromContext({ mode: 'task' }, 'en'), 'research', { title: 'T', summary: '', rules: '', detail: '', task: 'x', ancestors: '', subtreeOutline: '- LEAK' }, 'en').text;
  assert.ok(!research.includes('- LEAK'), 'only a synthesize prompt reads the outline');
});

test('the outline counts in the 32k budget: the prepared context keeps the sources when outline + sources fit', () => {
  const outline = 'o'.repeat(24_000);
  const prepared = M.buildPreparedTaskContext({ title: 'T', summary: '', rules: '', detail: '', task: 'x', ancestors: '', sourceContext: 's'.repeat(4000), subtreeOutline: outline, mode: 'synthesize' }, 'm', 32_000 - Math.ceil(outline.length / 4));
  assert.equal(prepared.context.sourceContext.length, 4000);
  const over = M.buildPreparedTaskContext({ title: 'T', summary: '', rules: '', detail: '', task: 'x', ancestors: '', sourceContext: 's'.repeat(120_000), mode: 'synthesize' }, 'm', 32_000 - Math.ceil(outline.length / 4));
  assert.ok(over.context.sourceContext.length < 120_000);
});
