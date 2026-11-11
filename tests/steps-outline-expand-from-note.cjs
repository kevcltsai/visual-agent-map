// Topic chat "Expand": the note leads, the owner's words come first, a reply that forgot its root or has several top-level
// headings is repaired with the topic as the root, a blank note is refused (never made up), and a bad reply is asked for once more.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, obsidian } = require('./support.cjs');
const svc = load('core/outline-generation-service.ts', { obsidian });
const titles = r => JSON.parse(JSON.stringify(r.nodes.map(n => [n.title, n.level, n.parent])));
const base = { topic: '核心元素', presetText: '', language: 'en', model: 'm', reasoning: 'low', fromNote: true };

test('a reply without the root heading gets the topic as root; the leading summary becomes its summary', () => {
  const r = svc.parseOutlineReply('> 摘要\n## A\n> a\n## B\n> b', 'en', '核心元素');
  assert.deepEqual(titles(r), [['核心元素', 1, null], ['A', 2, 0], ['B', 2, 0]]);
  assert.equal(r.nodes[0].summary, '摘要');
});
test('a reply without root and without any leading summary still gets a root', () => {
  const r = svc.parseOutlineReply('## A\n> a\n## B\n> b', 'en', '核心元素');
  assert.equal(r.nodes.length, 3); assert.equal(r.nodes[0].title, '核心元素');
});
test('several top-level headings move down one level under the topic', () => {
  const r = svc.parseOutlineReply('# A\n> a\n## A1\n> a1\n# B\n> b', 'en', '核心元素');
  assert.deepEqual(titles(r), [['核心元素', 1, null], ['A', 2, 0], ['A1', 3, 1], ['B', 2, 0]]);
});
test('a good reply with one root is left exactly as it was; without a topic nothing is repaired', () => {
  const r = svc.parseOutlineReply('# Sleep\n> s\n## A\n> a', 'en', 'Other');
  assert.equal(r.nodes[0].title, 'Sleep');
  assert.throws(() => svc.parseOutlineReply('# A\n> a\n# B\n> b', 'en'), e => e.code === 'invalid');
});
test('the prompt leads with the owner\'s words, quotes the note and asks only for what is missing', () => {
  const p = svc.buildOutlineGeneratePrompt({ ...base, direction: '只展開成三項', noteDetail: '## 一\n內容', existingChildren: ['已有'], limits: { levels: 2, maxTopics: 15 } });
  assert.ok(p.indexOf('只展開成三項') !== -1 && p.indexOf('只展開成三項') < p.indexOf('內容'));
  assert.ok(p.includes('"## 一\\n內容"') && p.includes('["已有"]') && /still missing/.test(p));
  assert.ok(!/Preset \(instructions/.test(p));
});
test('a blank note is refused before any AI call', async () => {
  let called = false;
  const s = new svc.OutlineGenerationService(async () => { called = true; return ''; });
  await assert.rejects(s.generate({ ...base, noteDetail: '  \n' }, new AbortController().signal), e => e.code === 'empty_note');
  assert.equal(called, false);
});
test('a failed first reply (a stray line) is asked for once more', async () => {
  const good = '# 核心元素\n> s\n## A\n> a';
  for (const bad of ['# A\n> a\n## x\n> b\nstray line']) {
    let calls = 0;
    const s = new svc.OutlineGenerationService(async () => (++calls === 1 ? bad : good));
    const r = await s.generate({ ...base, noteDetail: 'n' }, new AbortController().signal);
    assert.equal(calls, 2); assert.equal(r.nodes.length, 2);
  }
});
