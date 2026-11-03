// map-images P4a: a card shows a fixed-height cover frame from the first local image; remote, missing or unresolved
// covers add no frame and no error; images load lazily through a view-owned observer that is disconnected on redraw and close.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support.cjs');
const replay = require('./support-replay.cjs');
const dom = require('./support-dom.cjs');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const observers = [];
class FakeObserver {
  constructor(callback) { this.callback = callback; this.observed = new Set(); this.disconnected = 0; observers.push(this); }
  observe(el) { this.observed.add(el); }
  unobserve(el) { this.observed.delete(el); }
  disconnect() { this.disconnected++; this.observed.clear(); }
}
const errors = [];
const { VisualAgentMapView } = replay.load(
  'experiences/visual-map/view.ts',
  { obsidian: { ...S.obsidian, Component: class {}, MarkdownRenderChild: class {} } },
  {
    window: { setTimeout, clearTimeout }, CSS: { escape: s => s }, IntersectionObserver: FakeObserver,
    createDiv: o => dom.element('div', o), createEl: (tag, o) => dom.element(tag, o),
    console: { ...console, error: (...a) => errors.push(a), warn: (...a) => errors.push(a) }
  }
);
const files = new Set(['img/a.png', 'img/b.jpg', 'img/tall.png', 'img/bad.png', 'img/redraw.png']);
const make = (cache, extra = {}) => {
  const note = new S.obsidian.TFile('Topics/n.md');
  const view = Object.assign(Object.create(VisualAgentMapView.prototype), {
    app: {
      vault: {
        getAbstractFileByPath: p => (p === note.path ? note : files.has(p) ? new S.obsidian.TFile(p) : null),
        getResourcePath: f => `app://res/${f.path}`
      },
      metadataCache: {
        getFileCache: () => cache,
        getFirstLinkpathDest: link => (files.has(link) ? new S.obsidian.TFile(link) : null)
      }
    },
    selection: new (S.load('experiences/visual-map/topic-selection.ts').TopicSelection)(),
    coverObserver: null, ...extra
  });
  return view;
};
const card = () => { const c = dom.element('div'); c.createEl('h3', { cls: 'vam-card-title' }); c.createEl('p', { cls: 'vam-card-summary' }); return c; };
const frames = c => dom.findAll(c, i => dom.hasCls(i, 'vam-card-cover'));
const withGet = el => Object.assign(el, { getAttribute(name) { return this.attrs[name] ?? null; } });
const imgs = c => dom.findAll(c, i => i.tag === 'img').map(withGet);
const before = () => { observers.length = 0; errors.length = 0; };

test('a local embedded image gives one decorative lazy frame placed before the title', () => {
  before();
  const view = make({ embeds: [{ link: 'img/a.png' }] }), c = card();
  view.paintCover(c, 'Topics/n.md');
  assert.equal(frames(c).length, 1);
  assert.equal(c.children[0], frames(c)[0], 'the frame comes before the title and summary');
  const [img] = imgs(c);
  assert.equal(img.attrs.alt, '');
  assert.equal(img.attrs['data-src'], 'app://res/img/a.png');
  assert.equal(img.attrs.loading, 'lazy');
  assert.equal(img.attrs.decoding, 'async');
  assert.equal(img.attrs.src, undefined, 'no src until the frame is in view');
  assert.ok(observers[0].observed.has(img));
  observers[0].callback([{ target: img, isIntersecting: false }]);
  assert.equal(img.attrs.src, undefined);
  observers[0].callback([{ target: img, isIntersecting: true }]);
  assert.equal(img.attrs.src, 'app://res/img/a.png');
  assert.ok(!observers[0].observed.has(img), 'a loaded image is no longer observed');
});

test('topic-cover wins over the embed, and painting again replaces the frame', () => {
  before();
  const view = make({ frontmatter: { 'topic-cover': '[[img/b.jpg]]' }, embeds: [{ link: 'img/a.png' }] }), c = card();
  view.paintCover(c, 'Topics/n.md');
  view.paintCover(c, 'Topics/n.md');
  assert.equal(frames(c).length, 1);
  assert.equal(imgs(c)[0].attrs['data-src'], 'app://res/img/b.jpg');
});

test('counterexample 1: a cover file that does not exist adds no frame, no image and no console error', () => {
  before();
  for (const cache of [{ frontmatter: { 'topic-cover': '[[gone.png]]' } }, { embeds: [{ link: 'gone.png' }] }, null, undefined]) {
    const c = card(), count = c.children.length;
    make(cache).paintCover(c, 'Topics/n.md');
    assert.equal(frames(c).length, 0);
    assert.equal(c.children.length, count, 'the card is as it was');
  }
  assert.equal(errors.length, 0);
});

test('counterexample 1b: a lookup that throws, or a missing note file, leaves the card alone', () => {
  before();
  const view = make({ embeds: [{ link: 'img/a.png' }] });
  view.app.metadataCache.getFileCache = () => { throw new Error('boom'); };
  const c = card();
  view.paintCover(c, 'Topics/n.md');
  make({ embeds: [{ link: 'img/a.png' }] }).paintCover(c, 'Topics/other.md');
  assert.equal(frames(c).length, 0);
  assert.equal(errors.length, 0);
});

test('counterexample 2: a URL cover or URL embed builds no img', () => {
  before();
  for (const cache of [
    { frontmatter: { 'topic-cover': 'https://example.com/x.png' } },
    { embeds: [{ link: 'https://example.com/x.png' }, { link: 'http://a/b.png' }] },
    { frontmatter: { 'topic-cover': 'none' }, embeds: [{ link: 'img/a.png' }] }
  ]) {
    const c = card();
    make(cache).paintCover(c, 'Topics/n.md');
    assert.equal(imgs(c).length, 0);
    assert.equal(frames(c).length, 0);
  }
});

test('an image that fails to load removes its frame quietly', () => {
  before();
  const c = card();
  make({ embeds: [{ link: 'img/a.png' }] }).paintCover(c, 'Topics/n.md');
  imgs(c)[0].fire('error');
  assert.equal(frames(c).length, 0);
  assert.equal(errors.length, 0);
});

test('counterexample 3: releasing covers (redraw or close) disconnects the observer', () => {
  before();
  const view = make({ embeds: [{ link: 'img/a.png' }] });
  view.paintCover(card(), 'Topics/n.md');
  const observer = observers[0];
  view.releaseCovers();
  assert.equal(observer.disconnected, 1);
  assert.equal(view.coverObserver, null);
  view.releaseCovers();
  view.paintCover(card(), 'Topics/n.md');
  assert.equal(observers.length, 2, 'a new observer after a release');
  const source = read('experiences/visual-map/view.ts');
  const render = source.match(/this\.cardEls\.clear\(\);[\s\S]{0,80}/)[0];
  assert.ok(source.includes('this.releaseCovers();'), 'render and close call releaseCovers');
  assert.ok((source.match(/this\.releaseCovers\(\)/g) ?? []).length >= 2, render);
  const close = source.match(/async onClose\(\)[\s\S]*?\n  }\n/)[0];
  assert.match(close, /this\.releaseCovers\(\)/);
});

test('without IntersectionObserver the image loads at once', () => {
  before();
  const c = card(), view = make({ embeds: [{ link: 'img/a.png' }] });
  const saved = globalThis.IntersectionObserver;
  // The view module reads its own global; the stand-in context has none after removal.
  const { VisualAgentMapView: Plain } = replay.load('experiences/visual-map/view.ts', { obsidian: { ...S.obsidian, Component: class {}, MarkdownRenderChild: class {} } }, { window: { setTimeout, clearTimeout }, CSS: { escape: s => s }, createDiv: o => dom.element('div', o), createEl: (tag, o) => dom.element(tag, o) });
  Object.setPrototypeOf(view, Plain.prototype);
  view.paintCover(c, 'Topics/n.md');
  assert.equal(imgs(c)[0].attrs.src, 'app://res/img/a.png');
  globalThis.IntersectionObserver = saved;
});

test('renderNode paints the cover before the title; the header, model tag and colour calls are untouched', () => {
  const source = read('experiences/visual-map/view.ts');
  const body = source.match(/private renderNode\([\s\S]*?\n  }\n/)[0];
  assert.match(body, /this\.paintCover\(card, node\.path\)/);
  assert.ok(body.indexOf('this.paintCover(') < body.indexOf('cls: "vam-card-title"'));
  assert.ok(body.includes('this.paintModelTag(card, header, note)') && body.includes('this.paintCardColor('));
  assert.match(source, /\.on\("changed"/);
});

test('the frame shows the whole picture: 96px placeholder, then the picture ratio, never object-fit cover', () => {
  const css = read('styles.css');
  const frame = css.split('\n').find(line => line.startsWith('.vam-card-cover {'));
  assert.ok(frame);
  assert.match(frame, /height: 96px/, 'placeholder before the picture is measured');
  const sized = css.split('\n').find(line => line.startsWith('.vam-card-cover.is-sized'));
  assert.match(sized, /height: auto/);
  const image = css.split('\n').find(line => line.startsWith('.vam-card-cover img'));
  assert.match(image, /object-fit: contain/);
  assert.doesNotMatch(css.split('\n').filter(l => l.includes('.vam-card-cover')).join('\n'), /object-fit: cover/);
});

test('coverFrameRatio: portrait, landscape and square keep their shape; a very tall picture is held at 1.5x the width', () => {
  const { coverFrameRatio, COVER_MAX_HEIGHT_RATIO } = S.load('experiences/visual-map/view.ts', { obsidian: { ...S.obsidian, Component: class {}, MarkdownRenderChild: class {} } }, { window: { setTimeout, clearTimeout }, CSS: { escape: s => s } });
  assert.equal(COVER_MAX_HEIGHT_RATIO, 1.5);
  assert.equal(coverFrameRatio(300, 100), 3);
  assert.equal(coverFrameRatio(100, 100), 1);
  assert.equal(coverFrameRatio(200, 300), 2 / 3);
  assert.equal(coverFrameRatio(100, 1000), 2 / 3, 'taller than 1.5x is capped');
  for (const bad of [[0, 10], [10, 0], [NaN, 10], [-1, 5]]) assert.equal(coverFrameRatio(...bad), null);
});

test('a loaded picture sizes its frame once and relays the card out once; a redraw sizes at once from the remembered shape', () => {
  before();
  const view = make({ embeds: [{ link: 'img/b.jpg' }] });
  const calls = [];
  Object.assign(view, { map: { nodes: [] }, topicKindOf: () => 'topic', fitKindShape: (c, k) => calls.push(['fit', k]), drawEdges: () => calls.push(['edges']) });
  const c = card();
  c.dataset.nodeId = 'n1';
  view.paintCover(c, 'Topics/n.md');
  const frame = frames(c)[0], img = imgs(c)[0];
  assert.equal(frame.style['aspect-ratio'], undefined, 'unknown shape: placeholder');
  img.naturalWidth = 200; img.naturalHeight = 1000;
  img.fire('load');
  img.fire('load');
  assert.equal(frame.style['aspect-ratio'], String(2 / 3));
  assert.ok(frame.classes.includes('is-sized'));
  assert.deepEqual(calls, [['fit', 'topic'], ['edges']], 'one relayout and one edge redraw, not two');
  const again = card();
  view.paintCover(again, 'Topics/n.md');
  assert.equal(frames(again)[0].style['aspect-ratio'], String(2 / 3), 'a redraw does not jump');
});

test('counterexample: a picture that cannot be measured keeps the placeholder and does not relayout', () => {
  before();
  const view = make({ embeds: [{ link: 'img/a.png' }] });
  const calls = [];
  Object.assign(view, { map: { nodes: [] }, topicKindOf: () => 'topic', fitKindShape: () => calls.push('fit'), drawEdges: () => calls.push('edges') });
  const c = card();
  c.dataset.nodeId = 'n1';
  view.paintCover(c, 'Topics/n.md');
  imgs(c)[0].naturalWidth = 0; imgs(c)[0].naturalHeight = 0;
  imgs(c)[0].fire('load');
  assert.equal(frames(c)[0].style['aspect-ratio'], undefined);
  assert.deepEqual(calls, []);
});

// ---- cover frame: the card shows only the framed part of the picture (a mask, not a cropped file) -----------------------
test('coverFrameRatio with a frame: the region shape, capped like the whole picture', () => {
  const { coverFrameRatio } = S.load('experiences/visual-map/view.ts', { obsidian: { ...S.obsidian, Component: class {}, MarkdownRenderChild: class {} } }, { window: { setTimeout, clearTimeout }, CSS: { escape: s => s } });
  // The Rewire case: a 2:3 portrait, a band 100% wide and 1/3 tall -> 2 : 1.
  assert.equal(coverFrameRatio(200, 300, { x: 0, y: 0.4, w: 1, h: 1 / 3 }), 2);
  assert.equal(coverFrameRatio(200, 300, { x: 0, y: 0, w: 1, h: 1 }), 2 / 3, 'the whole picture is the same as no frame');
  assert.equal(coverFrameRatio(100, 100, { x: 0, y: 0, w: 0.1, h: 1 }), 2 / 3, 'a very tall region is held at 1.5x the width');
  assert.equal(coverFrameRatio(0, 100, { x: 0, y: 0, w: 1, h: 1 }), null);
});

// Picture shapes are remembered by path for the whole run, so each measured test uses its own picture.
const framed = (frontmatter, link = 'img/a.png') => make({ frontmatter, embeds: [{ link }] });
const windows = c => dom.findAll(c, i => dom.hasCls(i, 'vam-card-cover-window'));
const relay = view => Object.assign(view, { map: { nodes: [] }, topicKindOf: () => 'topic', fitKindShape() {}, drawEdges() {} });

test('a valid frame: the frame takes the region shape and the picture is placed so only the region shows', () => {
  before();
  const view = relay(framed({ 'topic-cover-frame': '0.1 0.4 0.8 0.2' })), c = card();
  c.dataset.nodeId = 'n1';
  view.paintCover(c, 'Topics/n.md');
  const [frame] = frames(c), [img] = imgs(c), [win] = windows(c);
  assert.ok(win, 'a window holds the picture');
  assert.equal(win.children[0], img);
  img.naturalWidth = 400; img.naturalHeight = 300;
  img.fire('load');
  const ratio = (400 * 0.8) / (300 * 0.2);
  assert.equal(frame.style['aspect-ratio'], String(ratio));
  assert.ok(frame.classes.includes('is-sized') && frame.classes.includes('is-framed'));
  assert.equal(win.style.width, '100%');
  assert.equal(win.style.left, '0%');
  assert.equal(img.style.width, `${100 / 0.8}%`);
  assert.equal(img.style.height, `${100 / 0.2}%`);
  assert.equal(img.style.left, `${(-0.1 / 0.8) * 100}%`);
  assert.equal(img.style.top, `${(-0.4 / 0.2) * 100}%`);
  assert.equal(img.attrs['data-src'], 'app://res/img/a.png', 'the original file is shown as it is');
});

test('a tall region is scaled down whole inside the capped frame (masked, not cropped, not stretched)', () => {
  before();
  const view = relay(framed({ 'topic-cover-frame': '0 0 0.1 1' }, 'img/tall.png')), c = card();
  c.dataset.nodeId = 'n1';
  view.paintCover(c, 'Topics/n.md');
  const [img] = imgs(c), [win] = windows(c), [frame] = frames(c);
  img.naturalWidth = 100; img.naturalHeight = 100;
  img.fire('load');
  assert.equal(frame.style['aspect-ratio'], String(2 / 3));
  const regionRatio = 0.1;
  const share = (regionRatio / (2 / 3)) * 100;
  assert.equal(win.style.width, `${share}%`);
  assert.equal(win.style.left, `${(100 - share) / 2}%`);
});

test('counter-example: an invalid frame shows the whole picture with no window and no error', () => {
  for (const bad of ['0.1 0.2 0.3', '0 0 1.5 1', '0.8 0 0.5 1', '0 0 0 1', 'x y z w']) {
    before();
    const view = relay(framed({ 'topic-cover-frame': bad }, 'img/bad.png')), c = card();
    c.dataset.nodeId = 'n1';
    view.paintCover(c, 'Topics/n.md');
    assert.equal(frames(c).length, 1, bad);
    assert.equal(windows(c).length, 0, bad);
    const [img] = imgs(c), [frame] = frames(c);
    img.naturalWidth = 200; img.naturalHeight = 300;
    img.fire('load');
    assert.equal(frame.style['aspect-ratio'], String(2 / 3), `${bad}: the whole picture's shape`);
    assert.ok(!frame.classes.includes('is-framed'), bad);
    assert.equal(img.style.width, undefined, bad);
    assert.equal(errors.length, 0);
  }
});

test('counter-example: topic-cover none beats a valid frame (no cover at all)', () => {
  before();
  const c = card();
  make({ frontmatter: { 'topic-cover': 'none', 'topic-cover-frame': '0.1 0.2 0.5 0.5' }, embeds: [{ link: 'img/a.png' }] }).paintCover(c, 'Topics/n.md');
  assert.equal(frames(c).length, 0);
});

test('a framed picture that fails to load removes its frame like any cover', () => {
  before();
  const c = card();
  relay(framed({ 'topic-cover-frame': '0.1 0.2 0.5 0.5' })).paintCover(c, 'Topics/n.md');
  imgs(c)[0].fire('error');
  assert.equal(frames(c).length, 0);
  assert.equal(errors.length, 0);
});

test('a redraw of a framed cover sizes at once from the remembered picture shape', () => {
  before();
  const view = relay(framed({ 'topic-cover-frame': '0 0 0.5 0.5' }, 'img/redraw.png'));
  const c = card();
  c.dataset.nodeId = 'n1';
  view.paintCover(c, 'Topics/n.md');
  imgs(c)[0].naturalWidth = 300; imgs(c)[0].naturalHeight = 100;
  imgs(c)[0].fire('load');
  const again = card();
  view.paintCover(again, 'Topics/n.md');
  assert.equal(frames(again)[0].style['aspect-ratio'], String(3), 'no jump');
  assert.equal(imgs(again)[0].style.width, '200%');
});

test('the stylesheet gives the framed cover a positioned window and uses no CSS variable of its own', () => {
  const lines = read('styles.css').split('\n').filter(l => /\.vam-card-cover/.test(l));
  const text = lines.join('\n');
  assert.match(text, /\.vam-card-cover\.is-framed[^{]*\{[^}]*position: relative/);
  assert.match(text, /\.vam-card-cover-window[^{]*\{[^}]*position: absolute[^}]*overflow: hidden/);
  assert.match(text, /is-framed:not\(\.is-sized\)[^{]*\{[^}]*visibility: hidden/);
});

// map-images P4b: the topic menu turns a topic's cover off or on again as one undoable rewriteNote transaction.
const { begin } = S.load('experiences/visual-map/map-transaction.ts', { obsidian: S.obsidian });
const NOTE = 'Topics/m.md';
async function coverHarness(text, { cache } = {}) {
  const { repo, app, contents } = S.fixture('en', { linkIndex: true });
  await app.vault.create(NOTE, text);
  await app.vault.create('Topics/Map.md', S.core.serializeMap({ id: 'map-u', title: 'map-u', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } }));
  const view = make(null);
  view.app = app;
  const read = () => {
    const m = /^---\n([\s\S]*?)\n---/.exec(contents.get(NOTE));
    return /^topic-cover:\s*"?none"?\s*$/m.test(m?.[1] ?? '') ? { 'topic-cover': 'none' } : {};
  };
  app.metadataCache = { getFileCache: () => ({ frontmatter: read() }), getFirstLinkpathDest: () => null };
  Object.assign(view, {
    plugin: { repo }, map: { nodes: [], viewport: { x: 0, y: 0, zoom: 1 } }, path: 'Topics/Map.md', history: { push() {} },
    beginMapTransaction: () => begin({ repo, rebuildDerivedData: async () => {}, onApplied: () => {}, checkConflict: async () => {} }),
    refreshAfterSavedChange: async () => {}
  });
  return { view, contents };
}
const TEXT = '---\ntype: topic\ntitle: M\ntopic-color: red\n---\n\nBody line\n';

test('P4b: turning the cover off writes topic-cover none; undo restores the note byte for byte, redo writes it again', async () => {
  const h = await coverHarness(TEXT);
  const entry = await h.view.changeTopicCover({ id: 'm', path: NOTE });
  assert.ok(entry, 'one history entry');
  assert.match(h.contents.get(NOTE), /topic-cover: "?none"?/);
  assert.match(h.contents.get(NOTE), /topic-color: red\ntopic-cover: "none"\n---\n\nBody line\n$/);
  await entry.undo();
  assert.equal(h.contents.get(NOTE), TEXT, 'undo is byte-identical');
  await entry.redo();
  assert.match(h.contents.get(NOTE), /topic-cover: "?none"?/);
  await entry.undo();
  assert.equal(h.contents.get(NOTE), TEXT);
});

test('P4b: turning it back on removes the key; undo of that restores the none line byte for byte', async () => {
  const off = '---\ntype: topic\ntitle: M\ntopic-cover: "none"\n---\n\nBody\n';
  const h = await coverHarness(off);
  const entry = await h.view.changeTopicCover({ id: 'm', path: NOTE });
  assert.doesNotMatch(h.contents.get(NOTE), /topic-cover/);
  await entry.undo();
  assert.equal(h.contents.get(NOTE), off);
});

test('P4b: the topic panel offers the cover toggle, aria-pressed while the cover is off; the topic menu no longer has it', async () => {
  const source = read('experiences/visual-map/view.ts');
  const menu = source.match(/private openTopicMenu\([\s\S]*?\n  }\n/)[0];
  assert.doesNotMatch(menu, /changeTopicCover|topic_cover/, 'the "+ Topic" menu is for adding topics only');
  assert.match(source, /if \(note\) this\.renderCoverSection\(panel, node\);/);
  const panelOf = async (text, editable = true) => {
    const h = await coverHarness(text);
    const calls = [];
    Object.assign(h.view, {
      enqueue: fn => fn(),
      changeTopicCover: async node => { calls.push(node.id); return {}; }
    });
    if (!editable) h.view.selection.toggleMultiSelect();
    h.view.map = { nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
    const panel = dom.element('div');
    h.view.renderCoverSection(panel, { id: 'm', path: NOTE });
    return { ...h, panel, calls };
  };
  const toggle = panel => dom.findAll(panel, i => i.tag === 'button' && i.attrs['aria-pressed'] !== undefined)[0];
  const on = await panelOf(TEXT);
  assert.equal(toggle(on.panel).attrs['aria-pressed'], 'false', 'cover shown: not pressed');
  toggle(on.panel).click();
  await dom.tick();
  assert.deepEqual(on.calls, ['m'], 'a click runs changeTopicCover for this topic');
  assert.equal(toggle(on.panel).attrs['aria-pressed'], 'true', 'the section repaints without closing the panel');
  const off = await panelOf('---\ntype: topic\ntitle: M\ntopic-cover: "none"\n---\n\nBody\n');
  assert.equal(toggle(off.panel).attrs['aria-pressed'], 'true', 'cover off: pressed');
  assert.equal(dom.findAll((await panelOf(TEXT, false)).panel, i => i.tag === 'button').length, 0, 'not editable: no section');
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const text = read(`i18n/${lang}.ts`);
    for (const key of ['ui.topic_cover_off', 'ui.topic_cover']) assert.ok(text.includes(`"${key}"`), `${lang} ${key}`);
  }
});

test('P4b: changeTopicCover refuses a topic that is not editable', async () => {
  const h = await coverHarness(TEXT);
  h.view.selection.toggleMultiSelect();
  assert.equal(await h.view.changeTopicCover({ id: 'm', path: NOTE }), null);
  assert.equal(h.contents.get(NOTE), TEXT);
});
