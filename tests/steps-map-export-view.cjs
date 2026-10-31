// Map images P6 (ticket 35): the export wiring of the view. The geometry comes from the drawn DOM (cards, edge paths,
// including the fishbone spine), colours from computed styles, pictures become data URIs; limits, stale results and
// the two destinations (Vault, download) are checked here with a real view over a fake vault and a fake DOM.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator, deferred } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element } = dom;
const TOPICS = 'Agent Workspace/Topics';
const MAP = `${TOPICS}/map-x/Map.md`;
const MEDIA = 'Media';
const ex = load('experiences/visual-map/map-export.ts');

const png = (w = 40, h = 20) => {
  const b = new Uint8Array(33);
  b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b.buffer;
};
const style = values => ({ getPropertyValue: name => values[name] ?? '', ...values });
const THEME = { '--background-primary': '#ffffff', '--text-normal': '#222222', '--background-modifier-border': '#cccccc' };

async function harness({ aim = false, builtIn = false } = {}) {
  const { repo, app, contents, files } = fixture('en', { linkIndex: true });
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const doc = { id: 'map-x', title: 'Export: Map?', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders(`${TOPICS}/map-x`);
  const root = await repo.createNote('Root', 'gpt-6-luna', doc, MAP, 'workspace');
  doc.nodes.push(root);
  const child = await repo.createNote('Child <b>', 'gpt-6-luna', doc, MAP, 'workspace');
  child.parentId = root.id;
  doc.nodes.push(child);
  await app.vault.create(MAP, core.serializeMap(doc));
  await repo.saveMap(MAP, doc);
  await repo.rebuildDerivedData();
  const counts = { createBinary: 0, readBinary: 0 };
  const createBinary = app.vault.createBinary;
  app.vault.createBinary = async (p, data) => { counts.createBinary++; return createBinary(p, data); };
  app.vault.readBinary = async f => { counts.readBinary++; return contents.get(f.path); };
  const asked = [];
  app.fileManager.getAvailablePathForAttachment = async (name, source) => {
    asked.push([name, source]);
    if (!files.has(MEDIA)) await app.vault.createFolder(MEDIA);
    return `${MEDIA}/${name}`;
  };
  await app.vault.createBinary(`${MEDIA}/c.png`, png(100, 50));
  await app.vault.createBinary(`${MEDIA}/free.png`, png(30, 30));
  await app.vault.createBinary(`${MEDIA}/fake.png`, new TextEncoder().encode('http://evil not an image').buffer);
  counts.createBinary = 0;
  const rootNote = app.vault.getAbstractFileByPath(root.path);
  app.metadataCache.getFileCache = f => (f.path === root.path ? { frontmatter: { 'topic-cover': '[[Media/c.png]]' } } : { frontmatter: {} });
  app.metadataCache.getFirstLinkpathDest = link => app.vault.getAbstractFileByPath(link) ?? null;
  const notices = [];
  const timers = [];
  const urls = { created: [], revoked: [] };
  const clicks = [];
  const menuTitles = [];
  class Menu {
    addItem(cb) { const item = { setTitle(t) { menuTitles.push(t); this.title = t; return this; }, setIcon() { return this; }, onClick(fn) { this.fn = fn; return this; } }; cb(item); this.items = [...(this.items ?? []), item]; Menu.last = this; return this; }
    addSeparator() { return this; } showAtMouseEvent() { return this; }
  }
  const globals = {
    createFragment: dom.createFragment,
    getComputedStyle: (el, pseudo) => style((pseudo ? el.pseudo : el.computed) ?? {}),
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    URL: { createObjectURL: blob => { urls.created.push(blob); return `blob:${urls.created.length}`; }, revokeObjectURL: u => urls.revoked.push(u) }
  };
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Menu, Notice: dom.makeNotice(notices) } }, globals);
  let pending = Promise.resolve();
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: work => (pending = Promise.resolve().then(work))
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = element('div'); view.stageEl = element('div');
  view.viewportEl = element('div'); view.viewportEl.computed = style(THEME);
  if (aim) view.map.aim = { version: 1 };
  view.builtIn = builtIn; view.integrationMode = false;
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  // The drawn DOM: two cards, a parent edge, the fishbone spine, a relation with an arrowhead marker, and a marker def.
  const card = (n, box, computed, extra = {}) => {
    const c = element('div', 'vam-node');
    Object.assign(c, { offsetLeft: box.x, offsetTop: box.y, offsetWidth: box.w, offsetHeight: box.h });
    c.computed = style(computed); c.pseudo = style(extra.pseudo ?? {});
    if (extra.topic) c.dataset.topicColor = extra.topic;
    const title = c.createDiv('vam-card-title'); title.text = n; title.computed = style({ color: extra.text ?? 'rgb(34, 34, 34)' });
    if (extra.cover) { const f = c.createDiv('vam-card-cover'); Object.assign(f, { offsetLeft: 0, offsetTop: 8, offsetWidth: box.w, offsetHeight: 96 }); }
    return c;
  };
  const path = (d, computed, attrs = {}) => { const p = element('path'); p.tagName = 'path'; p.attrs = { d, ...attrs }; p.getAttribute = n => p.attrs[n] ?? null; p.computed = style(computed); return p; };
  view.cardEls = new Map();
  view.cardEls.set(root.id, card('Root', { x: 100, y: 50, w: 280, h: 140 }, { backgroundColor: 'color(srgb 0.98 0.9 0.9)', borderTopColor: 'rgb(204, 204, 204)' }, { topic: 'red', pseudo: { backgroundColor: 'rgb(180, 40, 40)' }, cover: true }));
  view.cardEls.set(child.id, card('Child <b>', { x: 500, y: 300, w: 280, h: 60 }, { backgroundColor: 'rgb(255, 255, 255)', borderTopColor: 'rgb(204, 204, 204)' }));
  view.edgesEl = element('svg');
  const edgeStyle = { stroke: 'rgb(100, 100, 100)', display: 'inline' };
  view.edgesEl.children.push(
    path('M 380 120 C 440 120, 440 330, 500 330', edgeStyle, { class: 'vam-edge' }),
    path('M 20 120 L 100 120', edgeStyle, { 'data-spine': '' }),
    path('M 1 1 L 2 2 http://evil.example', edgeStyle),
    path('M 300 190 L 300 300', { stroke: 'none' }),
    Object.assign(element('defs'), { tagName: 'defs', children: [path('M 0 0 L 9 9', edgeStyle)] })
  );
  view.canvasNodes = () => view.map.nodes;
  const entries = [];
  const push = view.history.push.bind(view.history);
  view.history.push = entry => { entries.push(entry); push(entry); };
  const settle = async () => { await pending; await dom.tick(); await pending; await dom.tick(); };
  return { repo, app, view, counts, notices, timers, urls, clicks, menuTitles, Menu, asked, contents, files, root, child, rootNote, settle, entries, doc, path, card };
}
const created = h => [...h.files.values()].filter(f => f.path !== MAP && /\.(svg|png|md)$/.test(f.path) && f.path.startsWith(MEDIA) && !/^Media\/(c|free|fake)\.png$/.test(f.path)).map(f => f.path);

test('the scene reads cards, every edge path (spine included) and computed colours, topic colour among them', async () => {
  const h = await harness();
  const got = await h.view.collectExportScene(() => true);
  const svg = ex.buildMapSvg(got.scene);
  assert.equal(got.refuse, undefined);
  assert.match(svg, />Root</);
  assert.match(svg, />Child &lt;b&gt;</, 'a title is escaped text');
  assert.match(svg, /d="M 380 120 C 440 120, 440 330, 500 330"/, 'parent edge');
  assert.match(svg, /d="M 20 120 L 100 120"/, 'fishbone spine (data-spine) is exported too');
  assert.doesNotMatch(svg, /M 0 0 L 9 9/, 'a path in defs is a marker, not a line');
  assert.doesNotMatch(svg, /M 300 190/, 'a path that is not drawn (stroke none) is left out');
  // Ticket 37: the red card keeps its tint (resolved from color(srgb ...)) and its colour bar, and differs from the plain card.
  assert.match(svg, /fill="rgb\(250, 230, 230\)"/, 'card tint as drawn');
  assert.match(svg, /fill="rgb\(180, 40, 40\)"/, 'topic colour bar as drawn');
  assert.match(svg, /fill="rgb\(255, 255, 255\)"/, 'uncoloured card keeps its own fill');
  assert.equal([...svg.matchAll(/rgb\(180, 40, 40\)/g)].length, 1, 'only the coloured card has a bar');
  assert.match(svg, /fill="#ffffff"/, 'background from the theme variable');
});

test('the drawing area is the cards plus a margin, and nothing else is written to the SVG', async () => {
  const h = await harness();
  const { scene } = await h.view.collectExportScene(() => true);
  assert.equal(scene.x, 100 - 24);
  assert.equal(scene.y, 50 - 24);
  assert.equal(scene.width, 780 - 100 + 48);
  assert.equal(scene.height, 360 - 50 + 48);
  const svg = ex.buildMapSvg(scene);
  assert.ok(!/<script|foreignObject|style|url\(|\son\w+=/i.test(svg));
  for (const m of svg.matchAll(/href="([^"]*)"/g)) assert.match(m[1], /^data:image\/(png|jpeg|gif|webp);base64,/);
});

test('a cover and a free canvas image become data URIs read with readBinary; a file that is not an image is skipped', async () => {
  const h = await harness();
  h.view.map.canvasItems = [
    { id: 'i1', kind: 'image', path: `${MEDIA}/free.png`, x: 10, y: 400, w: 30, h: 30 },
    { id: 'i2', kind: 'image', path: `${MEDIA}/fake.png`, x: 10, y: 450, w: 30, h: 30 },
    { id: 'i3', kind: 'image', path: `${MEDIA}/gone.png`, x: 10, y: 500, w: 30, h: 30 }
  ];
  const { scene } = await h.view.collectExportScene(() => true);
  const svg = ex.buildMapSvg(scene);
  assert.equal([...svg.matchAll(/<image /g)].length, 2, 'cover + the one real free image');
  assert.match(svg, /preserveAspectRatio="xMidYMid slice"/, 'cover crops like object-fit: cover');
  assert.doesNotMatch(svg.replace('xmlns="http://www.w3.org/2000/svg"', ''), /evil|http/);
  assert.equal(h.counts.readBinary, 3, 'cover, free image, fake image; the missing file is never read');
});

test('counterexample 1: no http text from the scene ever reaches the SVG', async () => {
  const h = await harness();
  h.view.map.canvasItems = [{ id: 'i2', kind: 'image', path: 'http://evil.example/a.png', x: 0, y: 0, w: 30, h: 30 }];
  const { scene } = await h.view.collectExportScene(() => true);
  assert.doesNotMatch(ex.buildMapSvg(scene).replace('xmlns="http://www.w3.org/2000/svg"', ''), /http|evil/);
});

test('saving to the Vault asks for the attachment path of Map.md, writes one file and adds no undo step', async () => {
  const h = await harness();
  const before = h.contents.get(MAP);
  await h.view.exportMap('svg', 'vault');
  await h.settle();
  assert.deepEqual(h.asked, [['Export- Map-.svg', MAP]]);
  assert.equal(h.counts.createBinary, 1);
  assert.deepEqual(created(h), [`${MEDIA}/Export- Map-.svg`]);
  assert.match(new TextDecoder().decode(h.contents.get(`${MEDIA}/Export- Map-.svg`)), /^<svg /);
  assert.equal(h.entries.length, 0, 'an export is not a map edit');
  assert.equal(h.contents.get(MAP), before, 'Map.md is untouched');
  assert.ok(h.notices.some(n => /Saved/.test(String(n))), 'the result is said');
});

test('downloading makes a blob URL, clicks an anchor, and revokes the URL afterwards', async () => {
  const h = await harness();
  let anchor = null;
  const create = h.view.contentEl.createEl.bind(h.view.contentEl);
  h.view.contentEl.createEl = (tag, options) => { const el = create(tag, options); if (tag === 'a') { anchor = el; el.click = () => { h.clicks.push([el.attrs.href, el.attrs.download]); }; } return el; };
  await h.view.exportMap('svg', 'download');
  assert.equal(h.urls.created.length, 1);
  assert.deepEqual(h.clicks, [['blob:1', 'Export- Map-.svg']]);
  assert.equal(h.counts.createBinary, 0, 'a download writes nothing to the Vault');
  assert.ok(anchor);
  assert.deepEqual(h.urls.revoked, [], 'not yet: the browser is still taking the file');
  for (const fn of h.timers.splice(0)) fn();
  assert.deepEqual(h.urls.revoked, ['blob:1']);
});

test('Markdown is the whole outline, collapsed branches included, saved as .md', async () => {
  const h = await harness();
  h.view.map.nodes[0].collapsed = true;
  await h.view.exportMap('md', 'vault');
  await h.settle();
  assert.deepEqual(created(h), [`${MEDIA}/Export- Map-.md`]);
  assert.equal(new TextDecoder().decode(h.contents.get(`${MEDIA}/Export- Map-.md`)), '- Root\n  - Child <b>\n');
});

test('PNG goes through the injected canvas at the limit-approved scale', async () => {
  const h = await harness();
  const calls = [];
  h.view.pngBlob = async (svg, w, hh, scale) => { calls.push([w, hh, scale]); return new Blob(['png'], { type: 'image/png' }); };
  await h.view.exportMap('png', 'vault');
  await h.settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], 2, 'a small map is drawn at 2x');
  assert.deepEqual(created(h), [`${MEDIA}/Export- Map-.png`]);
});

test('counterexample 2: over the limits no canvas is made, nothing is written, only a Notice', async () => {
  const h = await harness();
  Object.assign(h.view.cardEls.get(h.root.id), { offsetWidth: 20000, offsetHeight: 20000 });
  let canvases = 0;
  h.view.pngBlob = async () => { canvases++; return new Blob(['x']); };
  for (const format of ['png', 'svg']) for (const target of ['vault', 'download']) await h.view.exportMap(format, target);
  await h.settle();
  assert.equal(canvases, 0);
  assert.equal(h.counts.createBinary, 0);
  assert.equal(h.urls.created.length, 0);
  assert.equal(h.notices.length, 4);
  assert.ok(h.notices.every(n => /too large/.test(String(n))));
});

test('too many embedded bytes is refused before anything is encoded or written', async () => {
  const h = await harness();
  const big = new Uint8Array(11 * 1024 * 1024);
  big.set(new Uint8Array(png()));
  await h.app.vault.createBinary(`${MEDIA}/big.png`, big.buffer);
  h.counts.createBinary = 0;
  h.view.map.canvasItems = Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, kind: 'image', path: `${MEDIA}/big.png`, x: i * 10, y: 400, w: 30, h: 30 }));
  await h.view.exportMap('svg', 'vault');
  await h.settle();
  assert.equal(h.counts.createBinary, 0);
  assert.ok(h.notices.some(n => /50 MB/.test(String(n))));
});

test('a long map is scaled down to 8192 and the user is told', async () => {
  const h = await harness();
  Object.assign(h.view.cardEls.get(h.child.id), { offsetLeft: 12000 });
  const calls = [];
  h.view.pngBlob = async (svg, w, hh, scale) => { calls.push([w, hh, scale]); return new Blob(['p']); };
  await h.view.exportMap('png', 'download');
  assert.equal(calls.length, 1);
  assert.ok(calls[0][0] * calls[0][2] <= 8192 + 1);
  assert.ok(calls[0][2] < 1);
  assert.ok(h.notices.some(n => /8192/.test(String(n))));
});

test('counterexample 3: a view closed or switched mid-export writes and downloads nothing', async () => {
  for (const stale of ['closed', 'epoch', 'path']) {
    for (const target of ['vault', 'download']) {
      const h = await harness();
      const gate = deferred();
      h.app.vault.readBinary = async f => { await gate.promise; return h.contents.get(f.path); };
      const run = h.view.exportMap('svg', target);
      await dom.tick();
      if (stale === 'closed') h.view.closed = true;
      else if (stale === 'epoch') h.view.mapOpenEpoch++;
      else h.view.path = `${TOPICS}/other/Map.md`;
      gate.resolve();
      await run;
      await h.settle();
      assert.equal(h.counts.createBinary, 0, `${stale}/${target}: no file`);
      assert.equal(h.urls.created.length, 0, `${stale}/${target}: no download`);
      assert.equal(h.notices.length, 0, `${stale}/${target}: no notice for a map nobody is looking at`);
    }
  }
});

test('PNG results that arrive after the view closed are dropped', async () => {
  const h = await harness();
  const gate = deferred();
  h.view.pngBlob = async () => { await gate.promise; return new Blob(['p']); };
  const run = h.view.exportMap('png', 'vault');
  await dom.tick();
  h.view.closed = true;
  gate.resolve();
  await run;
  await h.settle();
  assert.equal(h.counts.createBinary, 0);
});

test('svgToPngBlob draws once at the scaled size and releases the decode, and fails cleanly without a context', async () => {
  const drawn = []; let released = 0;
  const env = ctx => ({ load: async () => ({ image: 'IMG', release: () => released++ }), canvas: (w, h) => ({ context: ctx ? { drawImage: (...a) => drawn.push(a) } : null, toBlob: async () => new Blob([`${w}x${h}`]) }) });
  const blob = await ex.svgToPngBlob('<svg/>', 100, 50, 2, env(true));
  assert.equal(await blob.text(), '200x100');
  assert.deepEqual(drawn, [['IMG', 0, 0, 200, 100]]);
  assert.equal(released, 1);
  await assert.rejects(() => ex.svgToPngBlob('<svg/>', 100, 50, 1, env(false)));
  assert.equal(released, 2);
});

test('AIM, built-in sample and integration mode can all export', async () => {
  for (const mode of [{ aim: true }, { builtIn: true }]) {
    const h = await harness(mode);
    await h.view.exportMap('svg', 'vault');
    await h.settle();
    assert.equal(h.counts.createBinary, 1, JSON.stringify(mode));
  }
  const h = await harness();
  h.view.integrationMode = true;
  await h.view.exportMap('svg', 'vault');
  await h.settle();
  assert.equal(h.counts.createBinary, 1, 'integration');
});

test('the header button is a download icon with an accessible name and a six-item menu', async () => {
  const h = await harness();
  const bar = element('div');
  const button = h.view.addExportButton(bar);
  assert.equal(button.dataset.icon, 'download');
  assert.equal(button.attrs['aria-label'], 'Export map');
  button.click();
  assert.deepEqual(h.menuTitles, ['Save PNG image in the Vault', 'Download PNG image', 'Save SVG image in the Vault', 'Download SVG image', 'Save Markdown outline in the Vault', 'Download Markdown outline']);
});

test('helpers: colour normalising, data URI, file stem', () => {
  assert.equal(ex.normalizeCssColor('color(srgb 1 0 0.5 / 0.5)'), 'rgba(255, 0, 128, 0.5)');
  assert.equal(ex.normalizeCssColor('rgba(0, 0, 0, 0)'), '');
  assert.equal(ex.normalizeCssColor('transparent'), '');
  assert.equal(ex.normalizeCssColor(' rgb(1, 2, 3) '), 'rgb(1, 2, 3)');
  assert.equal(ex.toDataUri('image/png', new Uint8Array([1, 2, 3, 4])), 'data:image/png;base64,AQIDBA==');
  assert.equal(ex.exportFileStem('a/b:c?#[x]'), 'a-b-c---x-');
  assert.equal(ex.exportFileStem('  '), 'Mind map');
  assert.deepEqual(JSON.parse(JSON.stringify(ex.wrapText('abcdefghij', 35))), ['abcde', 'fghij']);
});
