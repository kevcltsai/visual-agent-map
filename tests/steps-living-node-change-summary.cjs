const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeLivingChanges } = require('./support.cjs').load('experiences/visual-map/living-node-changes.ts');
const e = id => ({ id, source: 'source:' + id, retrievedAt: 't1' });
const record = (id, extra = {}) => ({ id, subject: 's', scope: 'p', granularity: 'daily', eventTime: '2026-11-26', claim: '100', evidence: [e('e1')], validity: 'active', owner: 'ai', history: [], ...extra });
const knowledge = (records, extra = {}) => ({ revision: 'r', records, suppressed: [], output: { text: 'summary', owner: 'ai', evidence: [] }, ...extra });
const plain = value => JSON.parse(JSON.stringify(value));
const none = { firstRun: false, added: [], supplemented: [], corrected: [], disputed: [], invalidated: [], outputUpdated: false };

test('change summary: each change is classified into its own category', () => {
  const base = knowledge([record('a'), record('b'), record('c'), record('d'), record('f')]);
  const next = knowledge(
    [
      record('a', { evidence: [e('e1'), e('e2')] }),
      record('b', { claim: '105', evidence: [e('e2')] }),
      record('c', { validity: 'invalidated' }),
      record('d', { validity: 'disputed' }),
      record('f'),
      record('g', { eventTime: '2026-11-27' })
    ],
    { output: { text: 'new summary', owner: 'ai', evidence: [] } }
  );
  assert.deepEqual(plain(summarizeLivingChanges(base, next)), {
    firstRun: false, added: ['g'], supplemented: ['a'], corrected: ['b'], disputed: ['d'], invalidated: ['c'], outputUpdated: true
  });
});

test('change summary: an AI latest result that changed counts as the current result being updated', () => {
  const base = knowledge([record('a')]);
  const next = knowledge([record('a')], { aiLatest: { text: 'x', owner: 'ai', at: 't2', evidence: [] } });
  assert.equal(summarizeLivingChanges(base, next).outputUpdated, true);
});

test('change summary: the first run has no formal knowledge and reports no baseline instead of a list', () => {
  const empty = knowledge([], { revision: 'empty', output: { text: '', owner: 'ai', evidence: [] } });
  const result = summarizeLivingChanges(empty, knowledge([record('a')]));
  assert.equal(result.firstRun, true);
  assert.deepEqual(plain({ ...result, firstRun: false }), none);
});

test('change summary: nothing changed reports nothing, with no invented items', () => {
  const base = knowledge([record('a')]);
  assert.deepEqual(plain(summarizeLivingChanges(base, knowledge([record('a')]))), none);
});

test('change summary: the reader shows 本次變化 in the trial tab for first run, changes and no change', async () => {
  const S = require('./support.cjs');
  const { element, findAll } = require('./support-dom.cjs');
  const view = require('./support-replay.cjs').loadSource(`
export { LivingReaderView } from "./experiences/visual-map/living-node-reader";
export { setUiLanguage } from "./i18n";
`, { obsidian: { ...S.obsidian, Component: class { load() {} unload() {} }, ItemView: class { constructor() { this.contentEl = element('div'); this.app = { vault: { read: async () => '' } }; } }, MarkdownRenderer: { render: async () => {} } } });
  view.setUiLanguage('zh-TW');
  try {
    const shown = async changes => {
      const reader = new view.LivingReaderView({});
      await reader.show({ path: 'a.md' }, 'preview', 'owner', [], false, changes);
      return findAll(reader.contentEl, () => true).map(i => i.text).filter(Boolean);
    };
    const first = await shown({ ...none, firstRun: true });
    assert.ok(first.includes('本次變化') && first.includes('第一次執行，沒有可比基準。'));
    const none_ = await shown(none);
    assert.ok(none_.includes('本次沒有變化。'));
    const some = await shown({ ...none, added: ['a', 'b'], corrected: ['c'], outputUpdated: true });
    assert.ok(some.includes('新增：2') && some.includes('修正：1') && some.includes('目前結果已更新。'));
    assert.equal(some.includes('本次沒有變化。') || some.includes('第一次執行，沒有可比基準。'), false);
    assert.equal((await shown(undefined)).includes('本次變化'), false);
  } finally { view.setUiLanguage('en'); }
});

test('last change: the formal tab shows the stored changes, "no changes" for a later no-change run, and no baseline without the key', async () => {
  const S = require('./support.cjs');
  const { element, findAll } = require('./support-dom.cjs');
  const view = require('./support-replay.cjs').loadSource(`
export { LivingReaderView } from "./experiences/visual-map/living-node-reader";
export { setUiLanguage } from "./i18n";
`, { obsidian: { ...S.obsidian, Component: class { load() {} unload() {} }, ItemView: class { constructor() { this.contentEl = element('div'); this.app = { vault: { read: async () => this.note } }; } }, MarkdownRenderer: { render: async () => {} } } });
  view.setUiLanguage('zh-TW');
  try {
    const key = { at: 't2', added: ['a', 'b'], supplemented: [], corrected: ['c'], disputed: [], invalidated: [], output: true };
    const note = (line, check = 't2') => `---\nai-card: true\nliving-node-last-successful-check: "${check}"\n${line}---\n# T\n`;
    const shown = async content => {
      const reader = new view.LivingReaderView({});
      reader.note = content;
      await reader.show({ path: 'a.md' }, 'preview', 'owner');
      reader.tab = 'official';
      await reader.paint();
      return findAll(reader.contentEl, () => true).map(i => i.text).filter(Boolean);
    };
    const withKey = await shown(note('living-node-last-change: ' + JSON.stringify(JSON.stringify(key)) + '\n'));
    assert.ok(withKey.includes('本次變化') && withKey.includes('新增：2') && withKey.includes('修正：1') && withKey.includes('目前結果已更新。'));
    const later = await shown(note('living-node-last-change: ' + JSON.stringify(JSON.stringify(key)) + '\n', 't3'));
    assert.ok(later.includes('本次沒有變化。') && !later.includes('新增：2'));
    const old = await shown(note(''));
    assert.ok(old.includes('本次變化') && old.includes('沒有可比基準。') && !old.some(x => x.includes('第一次執行')));
    const bad = await shown(note('living-node-last-change: "{not json"\n'));
    assert.ok(bad.includes('沒有可比基準。') && !bad.some(x => x.includes('第一次執行')));
  } finally { view.setUiLanguage('en'); }
});
