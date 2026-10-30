// Private clipboard format v1 (P1-23): the clipboard is untrusted input, so every counter-example must be refused or
// dropped with a reason and must never throw.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, obsidian } = require('./support.cjs');
const clip = load('experiences/visual-map/clipboard.ts', { obsidian });
const { serializeClipboard, clipboardOutline, CLIPBOARD_MAX_CHARS } = clip;
// The module runs in its own vm realm, so results are copied into this realm before deepEqual compares them.
const plain = value => JSON.parse(JSON.stringify(value));
const parseClipboard = raw => plain(clip.parseClipboard(raw));
const buildClipboardPayload = input => plain(clip.buildClipboardPayload(input));

const node = (id, parent = null, extra = {}) => ({ id, parent, title: `T ${id}`, kind: 'topic', body: 'body', ...extra });
const payload = (over = {}) => ({ format: 'vam-branch', version: 1, clipId: 'clip-0001', nodes: [node('a'), node('b', 'a')], relations: [], ...over });
const parse = obj => parseClipboard(typeof obj === 'string' ? obj : JSON.stringify(obj));
const reason = obj => { const r = parse(obj); assert.equal(r.ok, false); return r.reason; };
const ok = obj => { const r = parse(obj); assert.equal(r.ok, true, JSON.stringify(r)); return r; };

test('baseline payload parses', () => {
  const r = ok(payload());
  assert.equal(r.payload.nodes.length, 2); assert.equal(r.droppedRelations, 0);
});
test('not JSON, non-string raw, and one char over the limit (refused before parsing)', () => {
  assert.equal(reason('{nope'), 'bad-json');
  for (const raw of [undefined, null, 5, {}, [], Symbol('x')]) assert.equal(parseClipboard(raw).reason, 'not-text');
  // Not JSON at all, so 'bad-json' would show if it were parsed; 'too-large' proves the length check comes first.
  assert.equal(parseClipboard('x'.repeat(CLIPBOARD_MAX_CHARS + 1)).reason, 'too-large');
  assert.equal(parseClipboard('x'.repeat(CLIPBOARD_MAX_CHARS)).reason, 'bad-json');
  assert.notEqual(parseClipboard(' '.repeat(CLIPBOARD_MAX_CHARS)).reason, 'too-large');
});
test('format other than vam-branch, version 2, JSON that is not an object', () => {
  assert.equal(reason(payload({ format: 'xmind' })), 'not-vam');
  assert.equal(reason('[1]'), 'not-vam'); assert.equal(reason('null'), 'not-vam'); assert.equal(reason('"x"'), 'not-vam');
  assert.equal(reason(payload({ version: 2 })), 'version');
  assert.equal(reason(payload({ version: '1' })), 'version');
});
test('clipId must match the pattern', () => {
  for (const clipId of ['short', 'a'.repeat(65), '../../etc/passwd', 'has space 123', 5, undefined]) assert.equal(reason(payload({ clipId })), 'bad-clip-id');
  ok(payload({ clipId: 'a'.repeat(64) }));
});
test('nodes as object, empty array, or missing', () => {
  assert.equal(reason(payload({ nodes: {} })), 'bad-nodes');
  assert.equal(reason(payload({ nodes: [] })), 'bad-nodes');
  assert.equal(reason(payload({ nodes: undefined })), 'bad-nodes');
  assert.equal(reason(payload({ nodes: [null] })), 'bad-nodes');
  assert.equal(reason(payload({ nodes: ['a'] })), 'bad-nodes');
});
test('the 501st node is refused, 500 is fine', () => {
  const many = n => Array.from({ length: n }, (_, i) => node(`n${i}`));
  assert.equal(reason(payload({ nodes: many(501) })), 'too-many-nodes');
  assert.equal(ok(payload({ nodes: many(500) })).payload.nodes.length, 500);
});
test('duplicate id', () => {
  assert.equal(reason(payload({ nodes: [node('a'), node('a')] })), 'bad-id');
});
test('path-like or malformed ids', () => {
  for (const id of ['../x', 'a/b', 'a b', '', 'a'.repeat(65), 5, null, undefined]) assert.equal(reason(payload({ nodes: [node(id)] })), 'bad-id');
});
test('parent that refers forward, to itself, to a missing id, or of the wrong type', () => {
  assert.equal(reason(payload({ nodes: [node('a', 'b'), node('b')] })), 'bad-parent');
  assert.equal(reason(payload({ nodes: [node('a', 'a')] })), 'bad-parent');
  assert.equal(reason(payload({ nodes: [node('a', 'zzz')] })), 'bad-parent');
  assert.equal(reason(payload({ nodes: [node('a', 5)] })), 'bad-parent');
  assert.equal(reason(payload({ nodes: [{ id: 'a', title: 't', kind: 'topic', body: '' }] })), 'bad-parent');
});
test('no root: the first node cannot have a parent, so a loop is impossible', () => {
  assert.equal(reason(payload({ nodes: [node('a', 'b'), node('b', 'a')] })), 'bad-parent');
});
test('title with a newline, NEL, other control characters, or a line separator', () => {
  for (const title of ['a\nb', 'a\u0085b', 'a\rb', 'a\u0000b', 'a\u009fb', 'a\u007fb', 'a\u2028b', 'a\tb']) assert.equal(reason(payload({ nodes: [node('a', null, { title })] })), 'bad-title', JSON.stringify(title));
});
test('empty, blank, non-string, and 201 code point titles', () => {
  for (const title of ['', '   ', 5, null]) assert.equal(reason(payload({ nodes: [node('a', null, { title })] })), 'bad-title');
  assert.equal(reason(payload({ nodes: [node('a', null, { title: 'x'.repeat(201) })] })), 'bad-title');
  assert.equal(reason(payload({ nodes: [node('a', null, { title: '𠝹'.repeat(201) })] })), 'bad-title');
  assert.equal(ok(payload({ nodes: [node('a', null, { title: '𠝹'.repeat(200) })] })).payload.nodes[0].title.length, 400);
});
test('title is trimmed', () => {
  assert.equal(ok(payload({ nodes: [node('a', null, { title: '  hi  ' })] })).payload.nodes[0].title, 'hi');
});
test('kind script, an HTML string, wrong case, or missing is refused, not turned into topic', () => {
  for (const kind of ['script', '<img onerror=x>', 'Topic', 5, undefined, null]) assert.equal(reason(payload({ nodes: [node('a', null, { kind })] })), 'bad-kind');
  for (const kind of ['topic', 'action', 'atomic', 'hypothesis', 'evidence', 'conclusion']) assert.equal(ok(payload({ nodes: [node('a', null, { kind })] })).payload.nodes[0].kind, kind);
});
test('body that starts with frontmatter (also after a BOM or with CRLF) is refused', () => {
  for (const body of ['---\nvisual-agent-map: x\n---\ntext', '﻿---\nvisual-agent-map: x\n---', '---\r\nk: v\r\n---', '---', '--- \nk: v']) assert.equal(reason(payload({ nodes: [node('a', null, { body })] })), 'bad-body', JSON.stringify(body));
  assert.equal(ok(payload({ nodes: [node('a', null, { body: 'text\n---\nnot frontmatter' })] })).payload.nodes[0].body, 'text\n---\nnot frontmatter');
  assert.equal(ok(payload({ nodes: [node('a', null, { body: '----' })] })).payload.nodes.length, 1);
});
test('body with NUL, non-string, or over 200,000 characters', () => {
  assert.equal(reason(payload({ nodes: [node('a', null, { body: 'x\u0000y' })] })), 'bad-body');
  assert.equal(reason(payload({ nodes: [node('a', null, { body: 5 })] })), 'bad-body');
  assert.equal(reason(payload({ nodes: [node('a', null, { body: 'x'.repeat(200_001) })] })), 'bad-body');
  assert.equal(ok(payload({ nodes: [node('a', null, { body: 'x'.repeat(200_000) })] })).payload.nodes[0].body.length, 200_000);
  assert.equal(ok(payload({ nodes: [node('a', null, { body: '' })] })).payload.nodes.length, 1);
});
test('strength is kept only for a hypothesis with a known value', () => {
  const strength = (kind, value) => ok(payload({ nodes: [node('a', null, { kind, strength: value })] })).payload.nodes[0].strength;
  assert.equal(strength('hypothesis', 'strong'), 'strong');
  assert.equal(strength('hypothesis', 'huge'), undefined);
  assert.equal(strength('hypothesis', 3), undefined);
  assert.equal(strength('topic', 'strong'), undefined);
  assert.equal(strength('evidence', 'weak'), undefined);
  assert.equal(Object.hasOwn(ok(payload({ nodes: [node('a', null, { kind: 'topic', strength: 'weak' })] })).payload.nodes[0], 'strength'), false);
});
test('prototype pollution at the top level and node level does not touch Object.prototype', () => {
  const hostile = '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted2":1}},"format":"vam-branch","version":1,"clipId":"clip-0001","nodes":[{"__proto__":{"polluted3":1},"constructor":"x","id":"a","parent":null,"title":"t","kind":"topic","body":""}],"relations":[{"__proto__":{"polluted4":1},"kind":"related","from":"a","to":"a"}]}';
  const r = ok(hostile);
  for (const key of ['polluted', 'polluted2', 'polluted3', 'polluted4']) { assert.equal({}[key], undefined); assert.equal(Object.prototype[key], undefined); }
  assert.deepEqual(Object.keys(r.payload).sort(), ['clipId', 'format', 'nodes', 'relations', 'version']);
  assert.deepEqual(Object.keys(r.payload.nodes[0]).sort(), ['body', 'id', 'kind', 'parent', 'title']);
  assert.equal(r.droppedRelations, 1);
});
test('a __proto__ or constructor value cannot stand in for a required field', () => {
  assert.equal(reason('{"__proto__":{"format":"vam-branch","version":1},"nodes":[]}'), 'not-vam');
  assert.equal(reason(`{"format":"vam-branch","version":1,"clipId":"clip-0001","nodes":[{"__proto__":{"id":"a","parent":null,"title":"t","kind":"topic","body":""}}]}`), 'bad-id');
  assert.equal(reason(payload({ nodes: [node('constructor'), node('b', 'toString')] })), 'bad-parent');
});
test('extra fields such as path are dropped and never appear in the output', () => {
  const r = ok(payload({ path: '/etc/passwd', mapId: 'm', nodes: [node('a', null, { path: '/etc/passwd', x: 1, map: 'm' })], relations: [] }));
  assert.deepEqual(Object.keys(r.payload).sort(), ['clipId', 'format', 'nodes', 'relations', 'version']);
  assert.deepEqual(Object.keys(r.payload.nodes[0]).sort(), ['body', 'id', 'kind', 'parent', 'title']);
  assert.equal(JSON.stringify(r.payload).includes('passwd'), false);
});
test('HTML in a title is kept as plain text', () => {
  const r = ok(payload({ nodes: [node('a', null, { title: '<b>x</b>' })] }));
  assert.equal(r.payload.nodes[0].title, '<b>x</b>');
  assert.equal(clipboardOutline(r.payload), '- <b>x</b>');
});
test('relations: bad shape, unknown kind, endpoint outside the payload, self link, duplicate pair are dropped and counted', () => {
  const relations = [
    { kind: 'supports', from: 'a', to: 'b' },
    { kind: 'related', from: 'b', to: 'a' },
    { kind: 'supports', from: 'a', to: 'ghost' },
    { kind: 'evidence', from: 'a', to: 'b' },
    { kind: 'related', from: 'a', to: 'a' },
    null, 'x', 5, [],
    { kind: 'related', from: 1, to: 'b' },
    { kind: 'related' }
  ];
  const r = ok(payload({ relations }));
  assert.equal(r.payload.relations.length, 1);
  assert.deepEqual(r.payload.relations[0], { kind: 'supports', from: 'a', to: 'b' });
  assert.equal(r.droppedRelations, relations.length - 1);
});
test('relations that are not a list are refused; more than 2,000 are refused', () => {
  assert.equal(reason(payload({ relations: {} })), 'bad-relations');
  assert.equal(reason(payload({ relations: Array.from({ length: 2001 }, () => null) })), 'too-many-relations');
  assert.equal(ok(payload({ relations: Array.from({ length: 2000 }, () => null) })).droppedRelations, 2000);
  assert.equal(ok(payload({ relations: undefined })).payload.relations.length, 0);
});
test('relation description is cut to 200 characters, flattened, and dropped when blank or not text', () => {
  const rel = description => ok(payload({ relations: [{ kind: 'related', from: 'a', to: 'b', description }] })).payload.relations[0];
  assert.equal([...rel('x'.repeat(500)).description].length, 200);
  assert.equal(rel('a\n\n b').description, 'a b');
  assert.equal(Object.hasOwn(rel('   '), 'description'), false);
  assert.equal(Object.hasOwn(rel(5), 'description'), false);
  assert.deepEqual(Object.keys(ok(payload({ relations: [{ kind: 'related', from: 'a', to: 'b', path: '/x', extra: 1 }] })).payload.relations[0]).sort(), ['from', 'kind', 'to']);
});
test('parseClipboard never throws on hostile or odd input', () => {
  const inputs = ['', '{}', '[]', '{"nodes":5}', '\u0000', '{"format":"vam-branch"}', '9'.repeat(100), '{"format":"vam-branch","version":1,"clipId":"clip-0001","nodes":[[]]}', { toString() { throw new Error('x'); } }];
  for (const input of inputs) assert.doesNotThrow(() => parseClipboard(input));
});

// build, serialize, parse
const map = [
  { id: 'r', parentId: null }, { id: 'c1', parentId: 'r' }, { id: 'g1', parentId: 'c1' }, { id: 'c2', parentId: 'r' },
  { id: 'o', parentId: null }, { id: 'o1', parentId: 'o' }, { id: 'x', parentId: null }
];
const notes = {
  r: { title: 'Root', body: 'root body', kind: 'topic' }, c1: { title: 'Child 1', body: 'c1', kind: 'hypothesis', strength: 'medium' },
  g1: { title: 'Grand', body: 'g', kind: 'evidence' }, c2: { title: 'Child 2', body: 'c2', kind: 'action' },
  o: { title: 'Other', body: 'o', kind: 'topic' }, o1: { title: 'Other kid', body: 'o1', kind: 'conclusion' }, x: { title: 'Unselected', body: 'x', kind: 'topic' }
};
const build = (over = {}) => buildClipboardPayload({ nodes: map, order: ['r', 'c1', 'g1', 'c2', 'o', 'o1', 'x'], selectedIds: ['r'], noteOf: id => notes[id], relations: [], clipId: 'clip-0001', ...over });

test('build: nested selection joins the ancestor branch, renumbers n1.., keeps collapsed descendants', () => {
  const r = build({ selectedIds: ['g1', 'r', 'c1'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.payload.nodes.map(n => [n.id, n.parent, n.title]), [['n1', null, 'Root'], ['n2', 'n1', 'Child 1'], ['n3', 'n2', 'Grand'], ['n4', 'n1', 'Child 2']]);
});
test('build: branches follow the display order, not the selection order', () => {
  const r = build({ selectedIds: ['o', 'r'] });
  assert.deepEqual(r.payload.nodes.map(n => n.title), ['Root', 'Child 1', 'Grand', 'Child 2', 'Other', 'Other kid']);
  const reversed = build({ selectedIds: ['r', 'o'], order: ['o', 'o1', 'x', 'r', 'c2', 'c1', 'g1'] });
  assert.deepEqual(reversed.payload.nodes.map(n => n.title), ['Other', 'Other kid', 'Root', 'Child 2', 'Child 1', 'Grand']);
});
test('build: relations with an endpoint outside the selection are dropped; inside ones are renumbered', () => {
  const r = build({ selectedIds: ['c1'], relations: [{ kind: 'supports', from: 'c1', to: 'g1', description: 'why' }, { kind: 'related', from: 'c1', to: 'x' }] });
  assert.deepEqual(r.payload.relations, [{ kind: 'supports', from: 'n1', to: 'n2', description: 'why' }]);
});
test('build: output goes through the same validation', () => {
  assert.equal(build({ noteOf: () => ({ title: 'a\nb', body: '', kind: 'topic' }) }).reason, 'bad-title');
  assert.equal(build({ noteOf: () => ({ title: 't', body: '---\nk: v\n---', kind: 'topic' }) }).reason, 'bad-body');
  assert.equal(build({ noteOf: () => ({ title: 't', body: '', kind: 'bogus' }) }).reason, 'bad-kind');
  assert.equal(build({ clipId: 'bad' }).reason, 'bad-clip-id');
  assert.equal(build({ selectedIds: [] }).reason, 'bad-nodes');
  assert.equal(build({ selectedIds: ['missing'] }).reason, 'bad-nodes');
  assert.equal(build({ noteOf: () => { throw new Error('x'); } }).ok, false);
});
test('round-trip: multi-select with nested selection survives build, serialize, parse', () => {
  const built = build({ selectedIds: ['o', 'r', 'c1'], relations: [{ kind: 'supports', from: 'c1', to: 'o1' }, { kind: 'related', from: 'r', to: 'x' }] });
  assert.equal(built.ok, true);
  const parsed = parseClipboard(serializeClipboard(built.payload));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.payload, built.payload);
  assert.equal(parsed.droppedRelations, 0);
  assert.equal(parsed.payload.nodes.find(n => n.title === 'Child 1').strength, 'medium');
  assert.equal(parsed.payload.relations.length, 1);
});
test('serializeClipboard is JSON.stringify', () => {
  const p = ok(payload()).payload;
  assert.equal(serializeClipboard(p), JSON.stringify(p));
});
test('clipboardOutline: three levels, tab indent, no trailing newline, no escaping', () => {
  const p = ok(payload({ nodes: [node('a', null, { title: 'Root *x*' }), node('b', 'a', { title: 'Mid' }), node('c', 'b', { title: 'Leaf [l](u)' }), node('d', 'a', { title: 'Mid 2' }), node('e', null, { title: 'Second' })] })).payload;
  assert.equal(clipboardOutline(p), '- Root *x*\n\t- Mid\n\t\t- Leaf [l](u)\n\t- Mid 2\n- Second');
});
