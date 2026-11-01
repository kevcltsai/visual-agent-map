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
  assert.deepEqual(symbols.slice(0, 6), ['✓', '⚠', '★', 'P1', 'P2', 'P3'], 'the first six symbols are unchanged');
  assert.equal(new Set(symbols).size, symbols.length, 'symbols are unique');
  for (const sym of symbols) assert.match(sym, /^[^<>&"'\s]+$/, 'plain text only');
  for (const id of own(m.TOPIC_MARKERS)) assert.match(m.markerLabelKey(id), /^share\.viewer_marker_[a-z0-9_]+$/);
  assert.equal(m.markerLabelKey('priority-2'), 'share.viewer_marker_priority_2');
  assert.equal(new Set(own(m.TOPIC_MARKERS).map(m.markerLabelKey)).size, own(m.TOPIC_MARKERS).length);
  assert.equal(m.markerLabelKey('progress-25'), 'share.viewer_marker_progress_25');
  assert.equal(m.markerLabelKey('flag-red'), 'share.viewer_marker_flag_red');
});

const fs = require('node:fs');
const path = require('node:path');
const { loadSource } = require('./support-replay.cjs');
const ids = own(m.TOPIC_MARKERS);

test('markers: new ids, groups cover every id once', () => {
  assert.deepEqual(ids.slice(0, 6), ['done', 'warning', 'star', 'priority-1', 'priority-2', 'priority-3'], 'the old six keep their order');
  const grouped = own(m.TOPIC_MARKER_GROUPS).flatMap(g => own(g.ids));
  assert.deepEqual(grouped.slice().sort(), ids.slice().sort());
  assert.equal(m.markerGroup('priority-5'), 'priority');
  assert.equal(m.markerGroup('progress-0'), 'progress');
  assert.equal(m.markerGroup('flag-blue'), 'flag');
  assert.equal(m.markerGroup('question'), 'face');
  assert.equal(m.isSingleChoiceMarker('progress-50'), true);
  assert.equal(m.isSingleChoiceMarker('flag-red'), false);
  assert.equal(m.isSingleChoiceMarker('sad'), false);
});

test('markers read: a single-choice group shows only its first whitelisted value, others are kept', () => {
  assert.deepEqual(own(m.readTopicMarkers({ 'topic-markers': ['priority-4', 'priority-1', 'progress-75', 'progress-25'] })), ['priority-1', 'progress-25']);
  assert.deepEqual(own(m.readTopicMarkers({ 'topic-markers': ['sad', 'flag-blue', 'flag-red', 'smile'] })), ['flag-red', 'flag-blue', 'smile', 'sad']);
  assert.deepEqual(own(m.readTopicMarkers({ 'topic-markers': ['Priority-4', 'FLAG-RED', 5, null, 'progress-30'] })), []);
  const raw = ['priority-4', 'priority-1'];
  m.readTopicMarkers({ 'topic-markers': raw });
  assert.deepEqual(raw, ['priority-4', 'priority-1'], 'reading does not change the input');
});

test('markers toggle: priority and progress are single-choice per group, flags and faces accumulate', () => {
  assert.deepEqual(own(m.toggleTopicMarker(['priority-1', 'priority-4', 'future-x'], 'priority-5')), ['future-x', 'priority-5'], 'old multi-value is cleared');
  assert.deepEqual(own(m.toggleTopicMarker(['priority-2', 'progress-25'], 'progress-100')), ['priority-2', 'progress-100']);
  assert.equal(m.toggleTopicMarker(['progress-50'], 'progress-50'), null);
  assert.deepEqual(own(m.toggleTopicMarker(['flag-red', 'smile'], 'flag-blue')), ['flag-red', 'smile', 'flag-blue']);
  assert.deepEqual(own(m.toggleTopicMarker(['flag-red', 'flag-blue'], 'flag-red')), ['flag-blue']);
  assert.deepEqual(own(m.toggleTopicMarker(['smile'], 'sad')), ['smile', 'sad']);
});

test('markers compat: the 0.28 module reads a note with new ids without throwing and shows none of them', () => {
  const source = fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy-topic-markers-0.28.ts.txt'), 'utf8');
  const legacy = loadSource(`${source.replace(/import type[^\n]*\n/, 'type TranslationKey = string;\n')}\n`);
  const fm = { 'topic-markers': ['priority-4', 'progress-50', 'flag-red', 'smile', 'star', 'priority-1', 'priority-3'] };
  assert.deepEqual(own(legacy.readTopicMarkers(fm)), ['star', 'priority-1', 'priority-3'], '0.28 shows its own ids, including multi-value priority');
  const next = legacy.toggleTopicMarker(fm['topic-markers'], 'done');
  for (const id of ['priority-4', 'progress-50', 'flag-red', 'smile']) assert.ok(next.includes(id), `0.28 keeps ${id}`);
  assert.deepEqual(own(legacy.toggleTopicMarker(fm['topic-markers'], 'priority-2')).filter(v => v.startsWith('priority')), ['priority-4', 'priority-2'], '0.28 only drops the priorities it knows');
  // The current module reads the 0.28 multi-value result as the first priority only.
  assert.deepEqual(own(m.readTopicMarkers({ 'topic-markers': ['priority-1', 'priority-3'] })), ['priority-1']);
});

test('markers toggle: legacy multi-value single-choice group follows the shown value', () => {
  assert.deepEqual(own(m.toggleTopicMarker(['priority-1', 'priority-3'], 'priority-3')), ['priority-3']);
  assert.equal(m.toggleTopicMarker(['priority-1', 'priority-3'], 'priority-1'), null);
  assert.deepEqual(own(m.toggleTopicMarker(['future-x', 'priority-1', 'priority-3'], 'priority-1')), ['future-x']);
  assert.deepEqual(own(m.toggleTopicMarker(['progress-25', 'progress-75'], 'progress-75')), ['progress-75']);
  assert.equal(m.toggleTopicMarker(['progress-25', 'progress-75'], 'progress-25'), null);
});
