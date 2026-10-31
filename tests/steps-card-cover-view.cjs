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
      builtIn: !editable, integrationMode: false, enqueue: fn => fn(),
      changeTopicCover: async node => { calls.push(node.id); return {}; }
    });
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
  Object.assign(h.view, { builtIn: true });
  assert.equal(await h.view.changeTopicCover({ id: 'm', path: NOTE }), null);
  assert.equal(h.contents.get(NOTE), TEXT);
});
