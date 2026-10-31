// Card cover resolution (map-images P2): metadata only, local images only, never the network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support.cjs');
const cover = load('experiences/visual-map/card-cover.ts', { obsidian: { parseYaml: () => ({}), stringifyYaml: () => '', normalizePath: p => p } });
const plain = value => JSON.parse(JSON.stringify(value));
const files = new Set(['img/a.png', 'img/b.jpg', 'doc.pdf']);
const resolve = link => (files.has(link) ? { path: link } : null);
const pick = cache => plain(cover.resolveCover(cache, resolve));

test('topic-cover link that resolves wins over embeds', () => {
  assert.deepEqual(pick({ frontmatter: { 'topic-cover': '[[img/b.jpg]]' }, embeds: [{ link: 'img/a.png' }] }), { path: 'img/b.jpg' });
  assert.deepEqual(pick({ frontmatter: { 'topic-cover': [['img/b.jpg']] } }), { path: 'img/b.jpg' });
  assert.deepEqual(pick({ frontmatter: { 'topic-cover': '[[img/b.jpg|alias]]' } }), { path: 'img/b.jpg' });
});

test('topic-cover none turns the cover off even with embeds', () => {
  assert.deepEqual(pick({ frontmatter: { 'topic-cover': 'none' }, embeds: [{ link: 'img/a.png' }] }), { off: true });
});

test('counter-example 1: only a remote image embed returns null', () => {
  assert.equal(pick({ embeds: [{ link: 'https://example.com/x.png' }, { link: 'http://a/b.png' }, { link: 'file:///etc/x.png' }, { link: '//cdn/x.png' }] }), null);
  assert.equal(pick({ frontmatter: { 'topic-cover': 'https://example.com/x.png' } }), null);
  assert.equal(pick(null), null);
});

test('counter-example 2: topic-cover pointing at a missing file falls back to the first local image', () => {
  assert.deepEqual(pick({ frontmatter: { 'topic-cover': '[[missing.png]]' }, embeds: [{ link: 'https://x/y.png' }, { link: 'doc.pdf' }, { link: 'img/a.png' }, { link: 'img/b.jpg' }] }), { path: 'img/a.png' });
});

test('a resolved file with a non-image extension is not a cover', () => {
  assert.equal(pick({ embeds: [{ link: 'doc.pdf' }] }), null);
});

test('withCover and withoutCover change only the topic-cover key', () => {
  const note = '---\ntitle: "T"\ntopic-state: "active"\n---\n# Body\n';
  const withIt = cover.withCover(note, 'img/a.png');
  assert.equal(withIt, '---\ntitle: "T"\ntopic-state: "active"\ntopic-cover: "[[img/a.png]]"\n---\n# Body\n');
  assert.equal(cover.withoutCover(withIt), note);
  assert.equal(cover.withCoverOff(note), '---\ntitle: "T"\ntopic-state: "active"\ntopic-cover: "none"\n---\n# Body\n');
  assert.equal(cover.withCover('# Plain\n', 'a.png'), '---\ntopic-cover: "[[a.png]]"\n---\n# Plain\n');
  assert.ok(!cover.withCover(note, 'a]]\nevil: 1|x').includes('\nevil'));
});
