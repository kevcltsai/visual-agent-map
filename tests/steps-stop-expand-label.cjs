// Ticket 29: the Stop button on a card that is expanding says "Stop expanding", not "Stop research".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support.cjs');
const { TopicRuns, stopLabelKey } = load('experiences/visual-map/topic-run.ts', { obsidian: {} });
const dicts = [['en', load('i18n/en.ts').en], ['zh-TW', load('i18n/zh-TW.ts').zhTW], ['zh-CN', load('i18n/zh-CN.ts').zhCN]];

test('stopLabelKey: expansion gets its own label, research keeps the old one', () => {
  assert.equal(stopLabelKey('proposeChildren', false), 'ui.stop_expand');
  assert.equal(stopLabelKey(undefined, true), 'ui.stop_expand');
  assert.equal(stopLabelKey('research', false), 'ui.stop_research');
  assert.equal(stopLabelKey(undefined, false), 'ui.stop_research');
});

test('TopicRuns.runKind follows begin and release', () => {
  const runs = new TopicRuns({ running: () => new Set(), activeTasks: () => new Map() });
  const handle = runs.begin('a.md', 'proposeChildren');
  assert.equal(runs.runKind('a.md'), 'proposeChildren');
  handle.release();
  assert.equal(runs.runKind('a.md'), undefined);
});

test('ui.stop_expand exists in all three languages and differs from stop_research', () => {
  for (const [name, d] of dicts) {
    assert.ok(d['ui.stop_expand'], name);
    assert.notEqual(d['ui.stop_expand'], d['ui.stop_research'], name);
  }
});
