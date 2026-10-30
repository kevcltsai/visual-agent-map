// Topic colours (ticket 37 P1): whitelist read, label keys, branch ids.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');

const c = load('topic-colors.ts');
// Arrays from the loaded module come from another realm; copy them so deepEqual compares prototypes fairly.
const own = value => [...value];
const node = (id, parentId) => ({ id, path: `${id}.md`, parentId });

test('colour list is the six whitelisted ids in order', () => {
  assert.deepEqual(own(c.TOPIC_COLORS), ['red', 'orange', 'yellow', 'green', 'blue', 'purple']);
});

test('colour read: each whitelisted id reads back', () => {
  for (const id of c.TOPIC_COLORS) assert.equal(c.readTopicColor({ 'topic-color': id }), id);
});

test('colour read: missing, wrong casing, wrong type and injected values read as no colour', () => {
  assert.equal(c.readTopicColor({}), undefined);
  for (const bad of ['Red', 'RED', ' red', ['red'], 3, null, true, {}, '', 'red; background:url(x)', '<img onerror>', 'teal'])
    assert.equal(c.readTopicColor({ 'topic-color': bad }), undefined, JSON.stringify(bad));
});

test('colour label key is a plain key string per colour', () => {
  assert.equal(c.colorLabelKey('red'), 'topic_color_red');
  for (const id of c.TOPIC_COLORS) assert.equal(c.colorLabelKey(id), `topic_color_${id}`);
});

test('branch ids: the topic first, then every descendant including deep ones, no siblings or ancestors', () => {
  const nodes = [node('r', null), node('a', 'r'), node('b', 'r'), node('a1', 'a'), node('a2', 'a'), node('a11', 'a1')];
  const ids = own(c.branchNoteIds(nodes, 'a'));
  assert.equal(ids[0], 'a');
  assert.deepEqual(ids.slice().sort(), ['a', 'a1', 'a11', 'a2']);
  assert.deepEqual(own(c.branchNoteIds(nodes, 'a11')), ['a11']);
  assert.equal(c.branchNoteIds(nodes, 'r').length, 6);
});

test('branch ids do not mutate the nodes', () => {
  const nodes = [node('r', null), node('a', 'r')];
  const before = JSON.stringify(nodes);
  c.branchNoteIds(nodes, 'r');
  assert.equal(JSON.stringify(nodes), before);
});
