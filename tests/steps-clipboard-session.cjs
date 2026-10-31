// P2 (24/27/28): the plugin-level clipboard session. The clipboard text is untrusted; only an exact match with the
// recorded string lets a paste use the source.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, obsidian } = require('./support.cjs');
const mod = load('experiences/visual-map/clipboard-session.ts', { obsidian });
const { sessionFor, ClipboardSession } = mod;
// The module runs in its own vm realm, so results are copied into this realm before deepEqual compares them.
const plain = value => JSON.parse(JSON.stringify(value));

const rec = (over = {}) => ({ clipId: 'clip-0001', serialized: '{"format":"vam-branch","n":1}', mode: 'copy', sourceMapPath: 'Maps/A/Map.md', sourceMapId: 'map-a', nodeIds: ['n1', 'n2'], notePaths: ['Maps/A/Notes/x.md', 'Maps/A/Notes/y.md'], ...over });

test('record then get returns the same fields; a new record replaces the old one', () => {
  const s = new ClipboardSession();
  assert.equal(s.get(), null);
  s.record(rec());
  assert.deepEqual(plain(s.get()), rec());
  s.record(rec({ clipId: 'clip-0002', serialized: 'second', mode: 'cut' }));
  assert.equal(s.get().clipId, 'clip-0002');
  assert.equal(s.matches('{"format":"vam-branch","n":1}'), false);
  assert.equal(s.matches('second'), true);
});
test('matches is a byte for byte comparison: one character off, trailing newline, prefix, case all fail', () => {
  const s = new ClipboardSession();
  s.record(rec({ serialized: 'abcdef' }));
  assert.equal(s.matches('abcdef'), true);
  for (const raw of ['abcdeg', 'abcde', 'abcdef\n', ' abcdef', 'ABCDEF', 'abcdef​', 'abcdеf', '', 'abcdefabcdef']) assert.equal(s.matches(raw), false, JSON.stringify(raw));
});
test('matches with no record or a non-string is false and never throws', () => {
  const s = new ClipboardSession();
  assert.equal(s.matches(''), false); assert.equal(s.matches('x'), false);
  s.record(rec({ serialized: '' }));
  for (const raw of [undefined, null, 0, {}, [], ['']]) assert.equal(s.matches(raw), false);
});
test('match returns the record only on an exact match', () => {
  const s = new ClipboardSession();
  s.record(rec({ serialized: 'S' }));
  assert.equal(s.match('S').clipId, 'clip-0001'); assert.equal(s.match('S '), null);
});
test('cancelCut drops a cut, leaves a copy, and a cancelled cut no longer matches', () => {
  const s = new ClipboardSession();
  s.record(rec({ mode: 'copy', serialized: 'C' }));
  assert.equal(s.cancelCut(), false); assert.equal(s.matches('C'), true);
  s.record(rec({ mode: 'cut', serialized: 'X' }));
  assert.equal(s.cancelCut(), true); assert.equal(s.get(), null); assert.equal(s.matches('X'), false);
  assert.equal(s.cancelCut(), false);
});
test('a copy after a cut replaces it, so the cut mark cannot survive a later copy', () => {
  const s = new ClipboardSession();
  s.record(rec({ mode: 'cut', serialized: 'X' }));
  s.record(rec({ mode: 'copy', serialized: 'C' }));
  assert.equal(s.get().mode, 'copy'); assert.equal(s.cancelCut(), false);
});
test('the record is a copy: changing the caller arrays afterwards does not change it, and it is frozen', () => {
  const s = new ClipboardSession();
  const input = rec();
  s.record(input);
  input.nodeIds.push('evil'); input.notePaths[0] = '../../etc/passwd'; input.serialized = 'other';
  assert.deepEqual(plain(s.get().nodeIds), ['n1', 'n2']);
  assert.equal(s.get().notePaths[0], 'Maps/A/Notes/x.md');
  assert.equal(s.matches('other'), false);
  assert.equal(Object.isFrozen(s.get()), true); assert.equal(Object.isFrozen(s.get().nodeIds), true);
  assert.throws(() => { 'use strict'; s.get().nodeIds.push('x'); });
});
test('record keeps only the fixed fields', () => {
  const s = new ClipboardSession();
  s.record({ ...rec(), view: { big: 1 }, extra: 'x' });
  assert.deepEqual(Object.keys(s.get()).sort(), ['clipId', 'mode', 'nodeIds', 'notePaths', 'serialized', 'sourceMapId', 'sourceMapPath']);
});
test('sessionFor gives one session per plugin object, separate between plugins, and refuses non-objects', () => {
  const p1 = {}, p2 = {};
  assert.equal(sessionFor(p1), sessionFor(p1));
  assert.notEqual(sessionFor(p1), sessionFor(p2));
  sessionFor(p1).record(rec({ serialized: 'one' }));
  assert.equal(sessionFor(p2).get(), null);
  for (const bad of [null, undefined, 'plugin', 5]) assert.throws(() => sessionFor(bad), { name: 'TypeError' });
});
test('clear drops whatever is recorded', () => {
  const s = new ClipboardSession();
  s.record(rec()); s.clear();
  assert.equal(s.get(), null);
});
