// Topic markers (ticket 33, D-b..D-e; v3.3 P1.10b): status-only whitelist read, preserving toggle.
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
  assert.deepEqual(own(m.toggleTopicMarker([3, 'priority-1'], 'done')), [3, 'priority-1', 'done']);
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
  assert.deepEqual(symbols, ['✓', '⚠', '★'], 'the status symbols are unchanged');
  assert.equal(new Set(symbols).size, symbols.length, 'symbols are unique');
  for (const sym of symbols) assert.match(sym, /^[^<>&"'\s]+$/, 'plain text only');
  for (const id of own(m.TOPIC_MARKERS)) assert.match(m.markerLabelKey(id), /^share\.viewer_marker_[a-z0-9_]+$/);
  assert.equal(m.markerLabelKey('star'), 'share.viewer_marker_star');
  assert.equal(new Set(own(m.TOPIC_MARKERS).map(m.markerLabelKey)).size, own(m.TOPIC_MARKERS).length);
});

const fs = require('node:fs');
const path = require('node:path');
const { loadSource } = require('./support-replay.cjs');
const ids = own(m.TOPIC_MARKERS);

test('markers: only the status group (done, warning, star) is on the whitelist', () => {
  assert.deepEqual(ids, ['done', 'warning', 'star']);
});

test('markers read: removed ids (priority, progress, flag, face) read as unknown values', () => {
  assert.deepEqual(own(m.readTopicMarkers({ 'topic-markers': ['done', 'priority-2', 'flag-red', 'question', 'star'] })), ['done', 'star']);
  assert.deepEqual(own(m.readTopicMarkers({ 'topic-markers': ['priority-1', 'progress-100', 'flag-blue', 'smile', 'neutral', 'sad'] })), []);
  const raw = ['priority-4', 'done'];
  m.readTopicMarkers({ 'topic-markers': raw });
  assert.deepEqual(raw, ['priority-4', 'done'], 'reading does not change the input');
});

test('markers toggle: removed ids stay untouched in the written list', () => {
  const legacy = ['priority-2', 'progress-50', 'flag-red', 'smile', 'question'];
  assert.deepEqual(own(m.toggleTopicMarker(legacy, 'star')), [...legacy, 'star']);
  assert.deepEqual(own(m.toggleTopicMarker([...legacy, 'star'], 'star')), legacy);
});

test('markers compat: the 0.28 module reads a note with new ids without throwing and shows none of them', () => {
  const source = fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy-topic-markers-0.28.ts.txt'), 'utf8');
  const legacy = loadSource(`${source.replace(/import type[^\n]*\n/, 'type TranslationKey = string;\n')}\n`);
  const fm = { 'topic-markers': ['priority-4', 'progress-50', 'flag-red', 'smile', 'star', 'priority-1', 'priority-3'] };
  assert.deepEqual(own(legacy.readTopicMarkers(fm)), ['star', 'priority-1', 'priority-3'], '0.28 shows its own ids, including multi-value priority');
  const next = legacy.toggleTopicMarker(fm['topic-markers'], 'done');
  for (const id of ['priority-4', 'progress-50', 'flag-red', 'smile']) assert.ok(next.includes(id), `0.28 keeps ${id}`);
  assert.deepEqual(own(legacy.toggleTopicMarker(fm['topic-markers'], 'priority-2')).filter(v => v.startsWith('priority')), ['priority-4', 'priority-2'], '0.28 only drops the priorities it knows');
  // The current module shows none of the removed ids from that result.
  assert.deepEqual(own(m.readTopicMarkers({ 'topic-markers': ['priority-1', 'priority-3', 'star'] })), ['star']);
});

test('chat 08: changeTopicMarkers turns markers on and off with the toggle rule; unknown values stay', () => {
  const plainList = value => (value === null ? null : JSON.parse(JSON.stringify(value)));
  assert.deepEqual(plainList(m.changeTopicMarkers(['priority-1', 'custom', 'star'], ['done', 'warning'], [])), ['priority-1', 'custom', 'star', 'done', 'warning']);
  assert.deepEqual(plainList(m.changeTopicMarkers(['star', 'done'], ['star'], ['done'])), ['star'], 'one already on is not toggled off');
  assert.deepEqual(plainList(m.changeTopicMarkers(['star', 'custom', 'progress-50'], [], ['all'])), ['custom', 'progress-50'], '"all" removes every whitelisted marker only');
  assert.equal(m.changeTopicMarkers(['star'], [], ['star']), null, 'an emptied list removes the key');
  assert.equal(m.changeTopicMarkers(undefined, [], ['warning']), null);
});
