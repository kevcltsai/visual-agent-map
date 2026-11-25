const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, obsidian } = require('./support.cjs');
const api = load('ai/reference-materials.ts', { obsidian });

test('indexed wikilinks retain exact precedence, ambiguity, aliases, extension handling and code', () => {
  const docs = [
    { path: 'a/source.md', content: '', external: true },
    { path: 'b/source.md', content: '' },
    { path: 'source.md', content: '', external: true },
    { path: 'x/unique.MD', content: '', external: true },
    { path: 'plain', content: '', external: true },
    { key: 'one', path: 'dup.md', content: '' },
    { key: 'two', path: 'dup.md', content: '', external: true }
  ];
  const groups = [{ id: 'g', documents: docs }];
  const text = '[[source.md|alias]] [[source]] [[a/source.md]] [[b/source.md]] [[unique]] [[plain]] [[dup.md]] [[missing]]';
  const expected = 'External source: source.md Source to confirm: source External source: a/source.md [[b/source.md]] External source: x/unique.MD External source: plain Source to confirm: dup.md [[missing]]';
  assert.equal(api.resolveSummaryReferences(text, groups), expected);
  const lines = text.replaceAll(' [[', '\n[[');
  const expectedLines = [
    'External source: source.md', 'Source to confirm: source', 'External source: a/source.md',
    '[[b/source.md]]', 'External source: x/unique.MD', 'External source: plain',
    'Source to confirm: dup.md', '[[missing]]'
  ].join('\n');
  assert.equal(api.resolveDetailReferences(lines, groups), expectedLines);
  assert.equal(api.resolveDetailReferences('\x60[[source]]\x60\n' + lines, groups), '\x60[[source]]\x60\n' + expectedLines);
});

test('many source links share a single index; a later transformation reads current documents', () => {
  let reads = 0;
  const n = 1000;
  const docs = Array.from({ length: n }, (_, i) => ({
    key: String(i), content: '', external: true,
    get path() { reads++; return 'dir/n' + i + '.md'; }
  }));
  const links = Array.from({ length: 200 }, (_, i) => '[[n' + i + ']]').join(' ');
  const groups = [{ id: 'g', documents: docs }];
  const output = api.resolveSummaryReferences(links, groups);
  assert.equal(output, Array.from({ length: 200 }, (_, i) => 'External source: dir/n' + i + '.md').join(' '));
  assert.ok(reads < n * 8, 'path reads: ' + reads);
  assert.equal(api.resolveSummaryReferences('[[n0]] [[n0]]', [{ id: 'g', documents: [{ path: 'new/n0.md', external: true, content: '' }] }]), 'External source: new/n0.md External source: new/n0.md');
});
