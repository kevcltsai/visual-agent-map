// Topic markers (ticket 33, D-b..D-e): whitelist read, preserving toggle, priority one-of-three.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');

const m = load('topic-markers.ts');
// Arrays from the loaded module come from another realm; copy them so deepEqual compares prototypes fairly.
const own = value => (value === null ? null : [...value]);

test('markers read: only whitelisted unique ids, in whitelist order', () => {
  assert.deepEqual(own(m.readTopicMarkers({})), []);
  assert.deepEqual(own(m.readTopicMarkers({ 'topic-markers': 'done' })), []);
  assert.deepEqual(own(m.readTopicMarkers({ 'topic-markers': {} })), []);
  assert.deepEqual(own(m.readTopicMarkers({ 'topic-markers': ['Done', 3, 'star', 'star'] })), ['star']);
  assert.deepEqual(own(m.readTopicMarkers({ 'topic-markers': ['star', 'done'] })), ['done', 'star']);
  assert.deepEqual(own(m.readTopicMarkers({ 'topic-markers': ['<img src=x onerror=alert(1)>', 'warning'] })), ['warning']);
});

test('markers toggle: unknown values are kept and the new id is appended', () => {
  assert.deepEqual(own(m.toggleTopicMarker(['future-x', 'star'], 'done')), ['future-x', 'star', 'done']);
  assert.deepEqual(own(m.toggleTopicMarker(['future-x', 'star', 'done'], 'done')), ['future-x', 'star']);
  assert.deepEqual(own(m.toggleTopicMarker(undefined, 'star')), ['star']);
  assert.deepEqual(own(m.toggleTopicMarker('done', 'star')), ['done', 'star'], 'a hand-written string is a one-item list');
  assert.equal(m.toggleTopicMarker('done', 'done'), null);
  assert.equal(m.toggleTopicMarker('', 'star') && own(m.toggleTopicMarker('', 'star')).join(), 'star');
});

test('markers toggle: a non-string list item is kept as it is', () => {
  assert.deepEqual(own(m.toggleTopicMarker(['future-x', 3], 'star')), ['future-x', 3, 'star']);
  assert.deepEqual(own(m.toggleTopicMarker(['future-x', 3, 'star'], 'star')), ['future-x', 3]);
  assert.deepEqual(own(m.toggleTopicMarker([3, 'priority-1'], 'priority-2')), [3, 'priority-2']);
});

test('markers toggle: priority is one of three', () => {
  assert.deepEqual(own(m.toggleTopicMarker(['priority-1'], 'priority-3')), ['priority-3']);
  assert.deepEqual(own(m.toggleTopicMarker(['star', 'priority-2', 'future-x'], 'priority-1')), ['star', 'future-x', 'priority-1']);
  assert.equal(m.toggleTopicMarker(['priority-3'], 'priority-3'), null);
});

test('markers toggle: removing the last value returns null, an unknown value alone survives', () => {
  assert.equal(m.toggleTopicMarker(['star'], 'star'), null);
  assert.deepEqual(own(m.toggleTopicMarker(['future-x', 'star'], 'star')), ['future-x']);
});

test('markers toggle does not mutate its input', () => {
  const raw = ['star'];
  m.toggleTopicMarker(raw, 'done');
  assert.deepEqual(raw, ['star']);
});

test('markers symbols and label keys: plain text for each id', () => {
  const symbols = own(m.TOPIC_MARKERS).map(m.markerSymbol);
  assert.deepEqual(symbols, ['✓', '⚠', '★', 'P1', 'P2', 'P3']);
  for (const id of own(m.TOPIC_MARKERS)) assert.match(m.markerLabelKey(id), /^share\.viewer_marker_[a-z0-9_]+$/);
  assert.equal(m.markerLabelKey('priority-2'), 'share.viewer_marker_priority_2');
  assert.equal(new Set(own(m.TOPIC_MARKERS).map(m.markerLabelKey)).size, 6);
});
