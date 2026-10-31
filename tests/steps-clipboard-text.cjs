// P1 (25): pasted plain text becomes outline nodes. The text is untrusted, so each counter-example is refused whole
// with a reason and a line number, and nothing is rewritten or truncated.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, obsidian } = require('./support.cjs');
const mod = load('experiences/visual-map/clipboard-text.ts', { obsidian });
const { PASTE_TEXT_MAX_CHARS } = mod;
// The module runs in its own vm realm, so results are copied into this realm before deepEqual compares them.
const plain = value => JSON.parse(JSON.stringify(value));
const parse = text => plain(mod.parseIndentedText(text));
const ok = text => { const r = parse(text); assert.equal(r.ok, true, JSON.stringify(r)); return r.nodes; };
const bad = text => { const r = parse(text); assert.equal(r.ok, false); return r; };
const shape = nodes => nodes.map(n => [n.title, n.parent]);

test('tab and space indentation make children, siblings and several roots', () => {
  assert.deepEqual(shape(ok('A\n  B\n    C\n  D\nE')), [['A', null], ['B', 0], ['C', 1], ['D', 0], ['E', null]]);
  assert.deepEqual(shape(ok('A\n\tB\n\t\tC\n\tD')), [['A', null], ['B', 0], ['C', 1], ['D', 0]]);
  const nodes = ok('A\n  B\n    C');
  assert.deepEqual(nodes.map(n => [n.level, n.line, n.index]), [[0, 1, 0], [1, 2, 1], [2, 3, 2]]);
});
test('a shallower line looks back for the nearest shallower ancestor', () => {
  assert.deepEqual(shape(ok('A\n      B\n    C\n  D\nE')), [['A', null], ['B', 0], ['C', 0], ['D', 0], ['E', null]]);
  assert.deepEqual(shape(ok('    A\n  B')), [['A', null], ['B', null]]);
});
test('mixed tab and spaces are measured in columns, a tab being 4', () => {
  assert.deepEqual(shape(ok('A\n    B\n\tC\n  \t D')), [['A', null], ['B', 0], ['C', 0], ['D', 2]]);
  assert.deepEqual(shape(ok('A\n\tB\n    C')), [['A', null], ['B', 0], ['C', 0]]);
});
test('list markers and checkboxes are stripped, mixed numbered and bulleted lists stay siblings', () => {
  const nodes = ok('1. one\n- two\n* three\n+ four\n5) five\n- [ ] six\n- [x] seven\n- [X] eight');
  assert.deepEqual(nodes.map(n => n.title), ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']);
  assert.ok(nodes.every(n => n.parent === null));
  assert.deepEqual(shape(ok('- a\n  1. b\n  2) c\n    - [x] d')), [['a', null], ['b', 0], ['c', 0], ['d', 2]]);
});
test('a marker without a following space is part of the title', () => {
  assert.deepEqual(ok('-5 degrees\n*bold* text\n1.5 litres\n[x]ray').map(n => n.title), ['-5 degrees', 'bold text', '1.5 litres', '[x]ray']);
});
test('blank lines are skipped but keep the real line numbers; CRLF and CR work', () => {
  assert.deepEqual(ok('A\n\n   \n  B').map(n => n.line), [1, 4]);
  assert.deepEqual(shape(ok('A\r\n  B\rC')), [['A', null], ['B', 0], ['C', null]]);
});
test('empty or whitespace-only text is ok with no nodes', () => {
  for (const t of ['', '   ', '\n\n', '\t \n  ', '﻿']) assert.deepEqual(parse(t), { ok: true, nodes: [] });
});
test('a single line makes one topic', () => {
  assert.deepEqual(shape(ok('Just one')), [['Just one', null]]);
});
test('100,001 characters is refused before parsing, 100,000 is not', () => {
  assert.equal(PASTE_TEXT_MAX_CHARS, 100000);
  assert.deepEqual(bad('a'.repeat(PASTE_TEXT_MAX_CHARS + 1)), { ok: false, reason: 'too-long' });
  // 100,000 characters of one over-long title is refused for the title, which proves the length check passed.
  assert.equal(bad('a'.repeat(PASTE_TEXT_MAX_CHARS)).reason, 'title-too-long');
  assert.equal(bad(' '.repeat(PASTE_TEXT_MAX_CHARS + 1)).reason, 'too-long');
});
test('the 101st node is refused with its line and nothing is returned', () => {
  const lines = n => Array.from({ length: n }, (_, i) => `t${i}`).join('\n');
  assert.equal(ok(lines(100)).length, 100);
  assert.deepEqual(bad(lines(101)), { ok: false, reason: 'too-many-nodes', line: 101 });
  assert.deepEqual(bad('\n\n' + lines(101)), { ok: false, reason: 'too-many-nodes', line: 103 });
});
test('a 201 code point title is refused with its line, 200 is fine; emoji count as one', () => {
  assert.deepEqual(bad(`ok\n  ${'x'.repeat(201)}`), { ok: false, reason: 'title-too-long', line: 2 });
  assert.equal(ok('x'.repeat(200)).length, 1);
  assert.equal(ok('😀'.repeat(200)).length, 1);
  assert.equal(bad('😀'.repeat(201)).reason, 'title-too-long');
});
test('titles that would break a note are refused, not rewritten', () => {
  assert.deepEqual(bad('a\nb [[ link'), { ok: false, reason: 'title-brackets', line: 2 });
  assert.deepEqual(bad('a\n  b ]] c'), { ok: false, reason: 'title-brackets', line: 2 });
});
test('control characters in a title are refused; an empty marker line is an empty title', () => {
  assert.equal(bad('a\u0000b').reason, 'bad-title');
  assert.equal(bad('a\u2028b').reason, 'bad-title');
  assert.equal(bad('a\u0007').reason, 'bad-title');
  assert.deepEqual(bad('a\n-'), { ok: false, reason: 'empty-title', line: 2 });
  assert.deepEqual(bad('a\n- [ ]'), { ok: false, reason: 'empty-title', line: 2 });
});
test('a slash in a title is kept as typed (the file name is made safe when the note is created)', () => {
  assert.deepEqual(ok('a/b\\c').map(n => n.title), ['a/b\\c']);
});
test('text with a Markdown heading goes to parseOutline as a whole', () => {
  const nodes = ok('# Root\n## Child\n### Leaf\n## Child 2');
  assert.deepEqual(shape(nodes), [['Root', null], ['Child', 0], ['Leaf', 1], ['Child 2', 0]]);
  assert.deepEqual(bad('# A\n# B'), { ok: false, reason: 'outline', line: 2 });
  assert.equal(bad('# A [[ x').reason, 'outline');
  // A hash that is not a heading (no space) stays an ordinary title.
  assert.deepEqual(ok('#tag one\n  #tag two').map(n => n.title), ['#tag one', '#tag two']);
});
test('a Visual Agent Map note body is refused whether or not it has headings', () => {
  assert.equal(bad('- a\n<!-- visual-agent-map:detail:start -->').reason, 'vam-note');
  assert.equal(bad('# a\n<!-- visual-agent-map:detail:start -->').reason, 'vam-note');
});
test('non-string input and Markdown emphasis', () => {
  for (const v of [undefined, null, 5, {}, []]) assert.equal(parse(v).ok, false);
  assert.deepEqual(ok('- **bold** and `code`').map(n => n.title), ['bold and code']);
});
test('a hostile mix never throws and never pollutes Object.prototype', () => {
  const hostile = ['__proto__', 'constructor', '  prototype', '\t__proto__'].join('\n');
  const raw = mod.parseIndentedText(hostile);
  assert.equal(raw.ok, true);
  assert.equal(raw.nodes.length, 4);
  // Inspect the raw result from the module's own realm: its Object.prototype is not this realm's.
  for (const o of [raw, ...raw.nodes]) {
    const proto = Object.getPrototypeOf(o);
    for (const key of ['polluted', '__proto__x', 'title', 'parent']) assert.equal(Object.hasOwn(proto, key), false, key);
  }
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(raw.nodes[0]).sort(), ['index', 'level', 'line', 'parent', 'title']);
});
