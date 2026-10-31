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
const files = new Set(['img/a.png', 'img/b.jpg']);
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

test('the frame is 96px tall with object-fit cover, fixed before the image loads', () => {
  const css = read('styles.css');
  const frame = css.split('\n').find(line => line.startsWith('.vam-card-cover {'));
  assert.ok(frame);
  assert.match(frame, /height: 96px/);
  const image = css.split('\n').find(line => line.startsWith('.vam-card-cover img'));
  assert.match(image, /object-fit: cover/);
});
