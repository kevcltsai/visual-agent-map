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

// ---- cover frame (topic-cover-frame): a mask over the picture, never a cropped file ----------------------------------------
const frameOf = value => plain(cover.parseCoverFrame(value));

test('parseCoverFrame reads "x y w h" as fractions of the picture', () => {
  assert.deepEqual(frameOf('0.08 0.5 0.84 0.2'), { x: 0.08, y: 0.5, w: 0.84, h: 0.2 });
  assert.deepEqual(frameOf('  0   0 1 1 '), { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(frameOf('0.7 0.7 0.3 0.3'), { x: 0.7, y: 0.7, w: 0.3, h: 0.3 }, 'x+w of exactly 1 is allowed, floating-point noise included');
});

test('counter-example: an invalid frame string is ignored (null), never an error', () => {
  const bad = ['0.1 0.2 0.3', '0.1 0.2 0.3 0.4 0.5', '-0.1 0 0.5 0.5', '0 0 1.2 0.5', '0.6 0 0.5 0.5', '0 0.6 0.5 0.5', '0 0 0 0.5', '0 0 0.5 0', 'a b c d', '0 0 0.5 NaN', '0 0 Infinity 1', '', '   ', '0x1 0 0.5 0.5', '1e-1 0 0.5 0.5'];
  for (const value of bad) assert.equal(cover.parseCoverFrame(value), null, JSON.stringify(value));
  for (const value of [undefined, null, 5, true, [0, 0, 1, 1], { x: 0, y: 0, w: 1, h: 1 }]) assert.equal(cover.parseCoverFrame(value), null, String(value));
});

test('serialiseCoverFrame writes four rounded numbers that parse back', () => {
  assert.equal(cover.serialiseCoverFrame({ x: 0.08, y: 0.5, w: 0.84, h: 0.2 }), '0.08 0.5 0.84 0.2');
  assert.equal(cover.serialiseCoverFrame({ x: 1 / 3, y: 0, w: 2 / 3, h: 1 }), '0.3333 0 0.6667 1');
  assert.deepEqual(frameOf(cover.serialiseCoverFrame({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 })), { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
});

test('withCoverFrame sets, replaces and removes only topic-cover-frame', () => {
  const note = '---\ntitle: "T"\ntopic-cover: "[[img/a.png]]"\n---\n# Body\n';
  const framed = cover.withCoverFrame(note, { x: 0.1, y: 0.2, w: 0.5, h: 0.5 });
  assert.equal(framed, '---\ntitle: "T"\ntopic-cover: "[[img/a.png]]"\ntopic-cover-frame: "0.1 0.2 0.5 0.5"\n---\n# Body\n');
  assert.equal(cover.withCoverFrame(framed, { x: 0, y: 0, w: 1, h: 0.5 }), framed.replace('0.1 0.2 0.5 0.5', '0 0 1 0.5'));
  assert.equal(cover.withCoverFrame(framed, null), note);
  assert.equal(cover.withCoverFrame(note, null), note, 'removing a missing key changes nothing');
});

test('resolveCoverWithFrame: the frame rides with the cover; none beats a valid frame; an invalid frame shows the whole picture', () => {
  const pickFramed = cache => plain(cover.resolveCoverWithFrame(cache, resolve));
  const fm = frame => ({ frontmatter: { 'topic-cover-frame': frame }, embeds: [{ link: 'img/a.png' }] });
  assert.deepEqual(pickFramed(fm('0.1 0.2 0.5 0.5')), { path: 'img/a.png', frame: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 }, size: 1, position: 'top' });
  assert.deepEqual(pickFramed({ embeds: [{ link: 'img/a.png' }] }), { path: 'img/a.png', frame: null, size: 1, position: 'top' });
  assert.deepEqual(pickFramed(fm('0 0 2 1')), { path: 'img/a.png', frame: null, size: 1, position: 'top' }, 'invalid: whole picture');
  assert.deepEqual(pickFramed({ frontmatter: { 'topic-cover': 'none', 'topic-cover-frame': '0.1 0.2 0.5 0.5' }, embeds: [{ link: 'img/a.png' }] }), { off: true }, 'none wins over a valid frame');
  assert.equal(pickFramed({ frontmatter: { 'topic-cover-frame': '0.1 0.2 0.5 0.5' }, embeds: [{ link: 'https://x/y.png' }] }), null, 'a frame without a picture shows nothing');
});

test('counter-example: the plugin changing the cover removes the old frame in the same write; a hand-written frame is otherwise untouched', () => {
  const note = '---\ntitle: "T"\ntopic-cover: "[[img/a.png]]"\ntopic-cover-frame: "0.1 0.2 0.5 0.5"\n---\n# Body\n';
  assert.equal(cover.withCover(note, 'img/b.jpg'), '---\ntitle: "T"\ntopic-cover: "[[img/b.jpg]]"\n---\n# Body\n');
  assert.equal(cover.withoutCover(note), '---\ntitle: "T"\n---\n# Body\n');
  assert.equal(cover.withCover('---\ntitle: "T"\n---\n', 'img/b.jpg'), '---\ntitle: "T"\ntopic-cover: "[[img/b.jpg]]"\n---\n');
  // Decision 8: turning an explicit link off drops its frame in the same write (on would show another picture); a first-embed cover keeps it (next test).
  const off = cover.withCoverOff(note);
  assert.ok(!off.includes('topic-cover-frame') && off.includes('topic-cover: "none"'));
  assert.ok(!cover.withCoverOn(off).includes('topic-cover:'));
  // appendImageEmbed (the body) never touches the frame key.
  assert.ok(cover.appendImageEmbed(note, 'img/c.png').startsWith(note.slice(0, note.indexOf('# Body'))));
});

// ---- Packet 4 fixes -----------------------------------------------------------------------------------------------
test('F1 counter-example: a frame touching the right or bottom edge survives write then read (edges are rounded, not sizes)', () => {
  const edge = { x: 0.80025, y: 0.60004, w: 0.19975, h: 0.39996 };
  const parsed = frameOf(cover.serialiseCoverFrame(edge));
  assert.notEqual(parsed, null, cover.serialiseCoverFrame(edge));
  assert.ok(parsed.x + parsed.w <= 1 + 1e-9 && parsed.y + parsed.h <= 1 + 1e-9);
  // Sweep: every frame that ends exactly at 1 stays valid after the round trip.
  for (let i = 0; i < 2000; i++) {
    const x = Math.random() * 0.99;
    const y = Math.random() * 0.99;
    const frame = { x, y, w: 1 - x, h: 1 - y };
    assert.notEqual(frameOf(cover.serialiseCoverFrame(frame)), null, JSON.stringify(frame));
  }
  for (let i = 0; i < 2000; i++) {
    const x = Math.random() * 0.9;
    const y = Math.random() * 0.9;
    const frame = { x, y, w: Math.random() * (1 - x) * 0.99 + 0.001, h: Math.random() * (1 - y) * 0.99 + 0.001 };
    const back = frameOf(cover.serialiseCoverFrame(frame));
    if (back) assert.ok(back.x + back.w <= 1 + 1e-9);
  }
});

test('F4 decision 8: turning the cover off removes the frame only when topic-cover was an explicit link', () => {
  const explicit = '---\ntitle: "T"\ntopic-cover: "[[img/a.png]]"\ntopic-cover-frame: "0.1 0.2 0.5 0.5"\n---\n# Body\n';
  const off = cover.withCoverOff(explicit);
  assert.ok(off.includes('topic-cover: "none"') && !off.includes('topic-cover-frame'), off);
  const embedOnly = '---\ntitle: "T"\ntopic-cover-frame: "0.1 0.2 0.5 0.5"\n---\n# Body\n![[img/a.png]]\n';
  const off2 = cover.withCoverOff(embedOnly);
  assert.ok(off2.includes('topic-cover: "none"') && off2.includes('topic-cover-frame: "0.1 0.2 0.5 0.5"'), off2);
  assert.ok(cover.withCoverOn(off2).includes('topic-cover-frame: "0.1 0.2 0.5 0.5"'));
  // already none: off again keeps the frame
  assert.ok(cover.withCoverOff(off2).includes('topic-cover-frame'));
});
