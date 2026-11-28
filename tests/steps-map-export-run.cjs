// Map export run: the export flow (collect the scene from a read-only source, limits, PNG/SVG/Markdown, vault or download,
// stale results) checked on its own over a fake source and fake DOM, with no view and no Obsidian.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support.cjs');
const { element } = require('./support-dom.cjs');

const st = {};
const reset = () => {
  Object.assign(st, { live: true, notices: [], png: [], attach: [], created: [], timers: [], urls: { created: [], revoked: [] }, reads: 0, fences: 0 });
};
reset();
const style = values => ({ getPropertyValue: name => values[name] ?? '', ...values });
const globals = {
  getComputedStyle: (el, pseudo) => style((pseudo ? el.pseudo : el.computed) ?? {}),
  setTimeout: fn => { st.timers.push(fn); return st.timers.length; },
  clearTimeout() {},
  URL: { createObjectURL: blob => { st.urls.created.push(blob); return `blob:${st.urls.created.length}`; }, revokeObjectURL: u => st.urls.revoked.push(u) }
};
const run = load('experiences/visual-map/map-export-run.ts', {}, globals);
const ex = load('experiences/visual-map/map-export.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const THEME = { '--background-primary': '#ffffff', '--text-normal': '#222222', '--background-modifier-border': '#cccccc', '--text-muted': '#777777' };
const png = (bytes = 33) => {
  const b = new Uint8Array(bytes);
  b.set([137, 80, 78, 71, 13, 10, 26, 10]);
  return b.buffer;
};
const MB = 1024 * 1024;

function card({ x = 10, y = 20, w = 100, h = 50, title = 'Title', cls = '' } = {}) {
  const el = element('div', { cls });
  Object.assign(el, { offsetLeft: x, offsetTop: y, offsetWidth: w, offsetHeight: h });
  if (title !== null) el.createDiv('vam-card-title').text = title;
  return el;
}
const node = (id, extra = {}) => ({ id, parentId: null, path: `${id}.md`, ...extra });
function source({ map: mapOver, cards: cardsOver, ...over } = {}) {
  const map = mapOver === undefined ? { title: 'Export: Map?', nodes: [node('a')], canvasItems: [] } : mapOver;
  const cards = cardsOver ?? new Map([['a', card()]]);
  const root = element('div');
  root.computed = THEME;
  const src = {
    map: () => map,
    noteTitle: id => ({ a: 'Note A' })[id],
    cards: () => cards,
    texts: () => [],
    edges: () => [],
    styleRoot: () => root,
    frameBox: () => null,
    summaryGeometry: () => null,
    coverOf: () => null,
    imageReader: () => null,
    path: () => 'Topics/map-x/Map.md',
    fence: () => { st.fences++; return () => st.live; },
    outlineNodes: m => m.nodes,
    outlineSummary: () => '',
    png: async (svg, width, height, scale) => { st.png.push({ svg, width, height, scale, noticesSeen: st.notices.length }); return new Blob(['PNG']); },
    host: () => element('div'),
    attachmentPath: async (name, mapPath) => { st.attach.push([name, mapPath]); return `Media/${name}`; },
    createBinary: async (path, data) => { st.created.push([path, data]); },
    notice: text => st.notices.push(text),
    ...over
  };
  return src;
}
const text = data => new TextDecoder().decode(new Uint8Array(data));
const EN = { empty: 'There is nothing to export.', embedded: 'The pictures on this map add up to more than 50 MB, so it cannot be exported.', pixels: 'This map is too large to export as an image (over 64 million pixels).' };

test('map export run: no map means no fence, no collect, no notice', async () => {
  reset();
  let touched = 0;
  const src = source({ map: null, cards: undefined, styleRoot: () => { touched++; return element('div'); } });
  for (const format of ['md', 'svg', 'png']) await run.exportMap(src, format, 'vault');
  assert.equal(st.fences, 0);
  assert.equal(touched, 0);
  assert.deepEqual(st.notices, []);
  assert.equal(st.attach.length + st.png.length + st.created.length, 0);
  assert.equal(await run.collectExportScene(src, () => true), null);
});

test('map export run: Markdown follows outlineNodes order, placeholder summaries are empty, a missing title is empty, no collect and no png', async () => {
  reset();
  const nodes = [node('b'), node('a', { parentId: 'b' }), node('c', { parentId: 'b' })];
  let touched = 0;
  const src = source({
    map: { title: 'Export: Map?', nodes: [node('a')], canvasItems: [] },
    cards: undefined,
    outlineNodes: () => nodes,
    noteTitle: id => ({ b: 'Beta', a: 'Alpha' })[id],
    outlineSummary: id => (id === 'a' ? 'about alpha' : ''),
    styleRoot: () => { touched++; return element('div'); }
  });
  await run.exportMap(src, 'md', 'vault');
  const expected = ex.mapOutline(nodes, id => ({ b: 'Beta', a: 'Alpha' })[id] ?? '', id => (id === 'a' ? 'about alpha' : ''), 'Export: Map?');
  assert.equal(st.attach.length, 1);
  assert.deepEqual(st.attach[0], [`${ex.exportFileStem('Export: Map?')}.md`, 'Topics/map-x/Map.md']);
  assert.equal(text(st.created[0][1]), `${expected}\n`);
  assert.ok(expected.includes('about alpha'));
  assert.equal(st.png.length, 0);
  assert.equal(touched, 0);
  assert.deepEqual(st.notices, [`Saved Media/${ex.exportFileStem('Export: Map?')}.md in the Vault.`]);
});

test('map export run: Markdown download has the markdown type and the saved name', async () => {
  reset();
  await run.exportMap(source(), 'md', 'download');
  assert.equal(st.urls.created[0].type, 'text/markdown;charset=utf-8');
  assert.deepEqual(st.notices, ['Downloaded Export- Map-.md.']);
});

test('map export run: a stale collect (fence already false) says nothing and writes nothing', async () => {
  reset();
  st.live = false;
  const src = source({ map: { title: 'T', nodes: [], canvasItems: [{ kind: 'image', id: 'i', path: 'i.png', x: 0, y: 0, w: 10, h: 10 }] }, cards: new Map(), imageReader: () => async () => png() });
  for (const target of ['vault', 'download']) await run.exportMap(src, 'svg', target);
  assert.deepEqual(st.notices, []);
  assert.equal(st.attach.length + st.created.length + st.urls.created.length, 0);
});

test('map export run: collect refusals say only the matching thing and produce nothing', async () => {
  reset();
  await run.exportMap(source({ cards: new Map() }), 'png', 'vault');
  assert.deepEqual(st.notices, [EN.empty]);
  reset();
  const big = new Uint8Array(26 * MB);
  big.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const src = source({
    map: { title: 'T', nodes: [node('a')], canvasItems: [{ kind: 'image', id: 'i', path: 'i.png', x: 0, y: 0, w: 10, h: 10 }, { kind: 'image', id: 'j', path: 'i.png', x: 20, y: 0, w: 10, h: 10 }] },
    imageReader: () => async () => { st.reads++; return big.buffer; }
  });
  await run.exportMap(src, 'png', 'download');
  assert.deepEqual(st.notices, [EN.embedded]);
  assert.equal(st.reads, 1, 'the same path is read once');
  assert.equal(st.png.length + st.attach.length + st.urls.created.length, 0);
});

test('map export run: exportLimits refusals each give their notice and nothing is produced', async () => {
  const cases = [
    ['pixels', new Map([['a', card({ w: 9000, h: 8000 })]]), undefined, EN.pixels],
    ['size', new Map([['a', card({ w: NaN })]]), undefined, EN.empty]
  ];
  for (const [, cards, , expected] of cases) {
    reset();
    await run.exportMap(source({ cards }), 'png', 'vault');
    assert.deepEqual(st.notices, [expected]);
    assert.equal(st.png.length + st.attach.length + st.created.length, 0);
  }
  reset();
  // Two uses of one 25 MiB file are exactly the collect limit, but the base64 padding puts exportLimits over it.
  const half = new Uint8Array(25 * MB);
  half.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const src = source({
    cards: new Map([['a', card()]]),
    map: { title: 'T', nodes: [node('a')], canvasItems: [{ kind: 'image', id: 'i', path: 'i.png', x: 0, y: 0, w: 10, h: 10 }, { kind: 'image', id: 'j', path: 'i.png', x: 20, y: 0, w: 10, h: 10 }] },
    imageReader: () => async () => half.buffer
  });
  await run.exportMap(src, 'svg', 'vault');
  assert.deepEqual(st.notices, [EN.embedded]);
  assert.equal(st.attach.length + st.created.length, 0);
});

test('map export run: SVG never calls png; PNG picks scaleDown, 2x or 1x and says "scaled" before encoding', async () => {
  reset();
  await run.exportMap(source(), 'svg', 'vault');
  assert.equal(st.png.length, 0);
  assert.equal(st.created.length, 1);
  assert.ok(text(st.created[0][1]).startsWith('<svg'));

  reset();
  await run.exportMap(source(), 'png', 'vault');
  assert.equal(st.png[0].scale, 2);

  reset();
  await run.exportMap(source({ cards: new Map([['a', card({ w: 4000, h: 4000 })]]) }), 'png', 'vault');
  assert.equal(st.png[0].scale, 1, 'over the pixel budget at 2x');

  reset();
  await run.exportMap(source({ cards: new Map([['a', card({ w: 9000, h: 100 })]]) }), 'png', 'vault');
  assert.equal(st.png[0].scale, 8192 / 9048);
  assert.equal(st.png[0].noticesSeen, 1);
  assert.equal(st.notices[0], 'This map is large, so the image was scaled down to fit 8192 px.');
  assert.deepEqual([st.png[0].width, st.png[0].height], [9048, 148]);
});

test('map export run: a PNG that finishes after the view moved on is dropped silently', async () => {
  reset();
  await run.exportMap(source({ png: async () => { st.live = false; return new Blob(['PNG']); } }), 'png', 'vault');
  assert.deepEqual(st.notices, []);
  assert.equal(st.attach.length + st.created.length, 0);
});

test('map export run: download appends an anchor to the host, clicks it, removes it, and revokes the URL only after the timer', async () => {
  reset();
  const host = element('div');
  let link = null;
  const original = host.createEl.bind(host);
  host.createEl = (name, value) => { link = original(name, value); link.click = () => { link.clicked = host.children.includes(link); }; return link; };
  await run.exportMap(source({ host: () => host }), 'svg', 'download');
  assert.equal(link.cls, 'vam-sr-only');
  assert.deepEqual([link.attrs.href, link.attrs.download], ['blob:1', 'Export- Map-.svg']);
  assert.equal(link.clicked, true, 'it was in the host when clicked');
  assert.equal(host.children.length, 0, 'removed after the click');
  assert.equal(st.urls.created[0].type, 'image/svg+xml;charset=utf-8');
  assert.deepEqual(st.urls.revoked, []);
  assert.deepEqual(st.notices, ['Downloaded Export- Map-.svg.']);
  assert.equal(st.created.length + st.attach.length, 0, 'nothing written to the vault');
  st.timers[0]();
  assert.deepEqual(st.urls.revoked, ['blob:1']);
});

test('map export run: saving uses the path captured at the start, writes the bytes to the chosen destination and says saved', async () => {
  reset();
  let path = 'Topics/map-x/Map.md';
  await run.exportMap(source({ path: () => path, attachmentPath: async (name, mapPath) => { st.attach.push([name, mapPath]); path = 'Elsewhere.md'; return `Media/${name}`; } }), 'svg', 'vault');
  assert.deepEqual(st.attach, [['Export- Map-.svg', 'Topics/map-x/Map.md']]);
  assert.equal(st.created[0][0], 'Media/Export- Map-.svg');
  assert.ok(st.created[0][1] instanceof ArrayBuffer || st.created[0][1].byteLength > 0);
  assert.deepEqual(st.notices, ['Saved Media/Export- Map-.svg in the Vault.']);
});

test('map export run: the fence is checked again after attachmentPath, before anything is written', async () => {
  reset();
  await run.exportMap(source({ attachmentPath: async name => { st.live = false; return `Media/${name}`; } }), 'svg', 'vault');
  assert.deepEqual(st.notices, []);
  assert.equal(st.created.length, 0);
});

test('map export run: a failure says export failed with the message only while the fence is valid', async () => {
  reset();
  await run.exportMap(source({ attachmentPath: async () => { throw new Error('boom'); } }), 'svg', 'vault');
  assert.deepEqual(st.notices, ['Export failed: boom']);
  reset();
  await run.exportMap(source({ createBinary: async () => { throw 'plain'; } }), 'svg', 'vault');
  assert.deepEqual(st.notices, ['Export failed: plain']);
  reset();
  await run.exportMap(source({ attachmentPath: async () => { st.live = false; throw new Error('late'); } }), 'svg', 'vault');
  assert.deepEqual(st.notices, []);
});

test('map export run: a cover or free picture read that goes stale makes collect return null', async () => {
  reset();
  const frameCard = card();
  frameCard.createDiv('vam-card-cover');
  const stale = () => async () => { st.live = false; return png(); };
  assert.equal(await run.collectExportScene(source({ cards: new Map([['a', frameCard]]), coverOf: () => ({ path: 'c.png', frame: null }), imageReader: stale }), () => st.live), null);
  reset();
  const withImage = { title: 'T', nodes: [node('a')], canvasItems: [{ kind: 'image', id: 'i', path: 'i.png', x: 0, y: 0, w: 10, h: 10 }] };
  assert.equal(await run.collectExportScene(source({ map: withImage, imageReader: stale }), () => st.live), null);
});

test('map export run: pictures: no reader means no read and no picture; a path is read once but its bytes count each time; non-images are dropped', async () => {
  reset();
  const items = [{ kind: 'image', id: 'i', path: 'i.png', x: 0, y: 0, w: 10, h: 10 }, { kind: 'annotated-image', id: 'j', path: 'i.png', x: 20, y: 0, w: 10, h: 10 }, { kind: 'text', id: 't', path: 'x', x: 0, y: 0, w: 5, h: 5 }];
  const map = { title: 'T', nodes: [node('a')], canvasItems: items };
  const frameCard = card();
  frameCard.createDiv('vam-card-cover');
  let got = await run.collectExportScene(source({ map, cards: new Map([['a', frameCard]]), coverOf: () => ({ path: 'c.png', frame: null }) }), () => true);
  assert.equal(got.scene.images.length, 0);
  assert.equal(got.scene.cards[0].cover, undefined);
  got = await run.collectExportScene(source({ map, cards: new Map([['a', frameCard]]), coverOf: () => ({ path: 'c.png', frame: null }), imageReader: () => async () => { st.reads++; return png(); } }), () => true);
  assert.equal(st.reads, 2, 'i.png and c.png once each');
  assert.equal(got.scene.images.length, 2);
  assert.deepEqual(plain(got.scene.images.map(i => i.fit)), ['fill', 'fill']);
  assert.ok(got.scene.cards[0].cover.href.startsWith('data:image/png;base64,'));
  assert.equal(got.scene.cards[0].cover.fit, 'contain');
  reset();
  got = await run.collectExportScene(source({ map, imageReader: () => async () => new ArrayBuffer(40) }), () => true);
  assert.equal(got.scene.images.length, 0);
});

test('map export run: a card whose id is not in the map is skipped', async () => {
  reset();
  const got = await run.collectExportScene(source({ cards: new Map([['a', card()], ['ghost', card({ x: 500 })]]) }), () => true);
  assert.equal(got.scene.cards.length, 1);
  assert.equal(got.scene.width, 100 + 48);
});

test('map export run: titles come from the DOM, then the note, then empty, trimmed; a styled card carries only what its dataset says', async () => {
  reset();
  const noTitle = card({ title: null });
  const spaced = card({ title: '  Spaced  ' });
  const got = await run.collectExportScene(source({ map: { title: 'T', nodes: [node('a'), node('b'), node('c')], canvasItems: [] }, cards: new Map([['a', noTitle], ['b', spaced], ['c', card({ title: null })]]), noteTitle: id => (id === 'a' ? ' From note ' : undefined) }), () => true);
  assert.deepEqual(plain(got.scene.cards.map(c => c.title)), [['From note'], ['Spaced'], ['']]);
  const plainCard = plain(got.scene.cards[0]);
  for (const key of ['titleSize', 'titleWeight', 'strokeWidth', 'clipped', 'titleAt', 'summary', 'cover']) assert.ok(!(key in plainCard), key);
  reset();
  const styled = card({ cls: 'is-clipped has-cover-bottom' });
  styled.dataset.topicStyleBold = '1';
  styled.dataset.topicStyleBorder = '1';
  styled.computed = { borderTopWidth: '3px' };
  const got2 = await run.collectExportScene(source({ map: { title: 'T', nodes: [node('a', { height: 80 })], canvasItems: [] }, cards: new Map([['a', styled]]) }), () => true);
  const item = plain(got2.scene.cards[0]);
  assert.deepEqual([item.titleWeight, item.strokeWidth, item.clipped], [800, 3, true]);
});

test('map export run: text nodes are plain cards with their own wrapping; the scene frame, theme and array order are fixed', async () => {
  reset();
  const body = element('div', { cls: 'vam-text-node-body' });
  body.text = 'alpha beta';
  body.computed = { lineHeight: '20px', color: '#112233' };
  const textEl = element('div');
  Object.assign(textEl, { offsetLeft: 0, offsetTop: 0, offsetWidth: 120, offsetHeight: 28 });
  textEl.children.push(body);
  const got = await run.collectExportScene(source({ cards: new Map(), texts: () => [textEl] }), () => true);
  const scene = plain(got.scene);
  assert.equal(scene.cards[0].plain, true);
  assert.equal(scene.cards[0].textColor, '#112233');
  assert.deepEqual(scene.cards[0].title, ['alpha beta']);
  assert.deepEqual([scene.x, scene.y, scene.width, scene.height], [-24, -24, 168, 76]);
  assert.deepEqual(scene.theme, { background: '#ffffff', text: '#222222', stroke: '#cccccc', card: '#ffffff' });
  assert.deepEqual(Object.keys(scene).slice(-5), ['boundaries', 'edges', 'summaries', 'cards', 'images']);
});

test('map export run: a transient class is off while the box is measured and back after, also when the read throws', async () => {
  reset();
  const seen = [];
  const selected = card({ cls: 'is-selected is-cut' });
  Object.defineProperty(selected, 'computed', { get() { seen.push(selected.cls); return { backgroundColor: '#fff' }; } });
  await run.collectExportScene(source({ cards: new Map([['a', selected]]) }), () => true);
  assert.ok(seen[0].includes('vam-export-measure') && !seen[0].includes('is-selected') && !seen[0].includes('is-cut'));
  assert.deepEqual(selected.classes.sort(), ['is-cut', 'is-selected']);
  const plainCard = card();
  const seenPlain = [];
  Object.defineProperty(plainCard, 'computed', { get() { seenPlain.push(plainCard.cls); return {}; } });
  await run.collectExportScene(source({ cards: new Map([['a', plainCard]]) }), () => true);
  assert.ok(seenPlain.every(cls => !cls.includes('vam-export-measure')));
  const broken = card({ cls: 'is-drop-target' });
  Object.defineProperty(broken, 'computed', { get() { throw new Error('style gone'); } });
  await assert.rejects(run.collectExportScene(source({ cards: new Map([['a', broken]]) }), () => true), /style gone/);
  assert.deepEqual(broken.classes, ['is-drop-target']);
  reset();
  await run.exportMap(source({ cards: new Map([['a', broken]]) }), 'svg', 'vault');
  assert.deepEqual(st.notices, ['Export failed: style gone']);
});

test('map export run: edges: only drawn paths; dashed, thick (0 falls back to 4), unmeasurable still drawn, measurable ones widen the scene', async () => {
  reset();
  const edge = (attrs, computed, over = {}) => {
    const el = element('path');
    el.tagName = over.tag ?? 'path';
    el.attrs = { ...attrs };
    el.getAttribute = name => el.attrs[name] ?? null;
    el.computed = { stroke: '#333333', display: '', strokeWidth: '2', ...computed };
    Object.assign(el, over.props ?? {});
    return el;
  };
  const edges = [
    edge({ d: 'M0 0' }, {}, { tag: 'g' }),
    edge({ d: 'M0 0', 'data-anchor-relation': '1' }, {}),
    edge({}, {}),
    edge({ d: 'M0 0' }, { stroke: '' }),
    edge({ d: 'M0 0' }, { stroke: 'none' }),
    edge({ d: 'M0 0' }, { display: 'none' }),
    edge({ d: 'M1 1', class: 'vam-edge vam-text-link' }, {}),
    edge({ d: 'M2 2', 'data-line-thick': '1' }, { strokeWidth: '0' }),
    edge({ d: 'M3 3', 'data-line-thick': '1' }, { strokeWidth: '3' }, { props: { getBBox: () => ({ x: 0, y: 0, width: 500, height: 10 }) } }),
    edge({ d: 'M4 4' }, {}, { props: { getBBox() { throw new Error('no box'); } } })
  ];
  const got = await run.collectExportScene(source({ edges: () => edges }), () => true);
  assert.deepEqual(plain(got.scene.edges), [
    { d: 'M1 1', stroke: '#333333', dashed: true },
    { d: 'M2 2', stroke: '#333333', width: 4 },
    { d: 'M3 3', stroke: '#333333', width: 3 },
    { d: 'M4 4', stroke: '#333333' }
  ]);
  assert.equal(got.scene.width, 500 + 48);
});

test('map export run: frames and summary brackets: missing geometry is skipped, labels only when set, empty vs not empty', async () => {
  reset();
  const items = [
    { kind: 'boundary', id: 'f1', members: ['a'], label: 'Group' },
    { kind: 'boundary', id: 'f2', members: ['a'] },
    { kind: 'boundary', id: 'f3', members: ['gone'] },
    { kind: 'summary', id: 's1', parentId: 'p', members: ['c1'], text: 'brace text' },
    { kind: 'summary', id: 's2', parentId: 'p', members: ['c1'], text: 'refused' },
    { kind: 'summary', id: 's3', parentId: 'p', members: ['c1'], text: 'none' }
  ];
  const map = { title: 'T', nodes: [node('a'), node('p'), node('c1', { parentId: 'p' })], canvasItems: items };
  const asked = [];
  const got = await run.collectExportScene(
    source({
      map,
      frameBox: members => (members[0] === 'a' ? { x: 0, y: 0, w: 60, h: 40 } : null),
      summaryGeometry: (parentId, range, textArg) => {
        asked.push([parentId, [...range], textArg]);
        if (textArg === 'refused') return { ok: false };
        if (textArg === 'none') return null;
        return { ok: true, extent: { x: 0, y: 0, w: 10, h: 10 }, side: 'right', label: { x: 20, y: 5 }, path: 'M0 0' };
      }
    }),
    () => true
  );
  const scene = plain(got.scene);
  assert.equal(scene.boundaries.length, 2);
  assert.equal(scene.boundaries[0].label, 'Group');
  assert.ok(!('label' in scene.boundaries[1]));
  assert.equal(scene.boundaries[0].stroke, '#777777');
  assert.deepEqual(asked[0], ['p', ['c1'], 'brace text']);
  assert.equal(scene.summaries.length, 1);
  assert.deepEqual(scene.summaries[0].text, ['brace text']);
  assert.equal(scene.summaries[0].textColor, '#222222');
  reset();
  const onlyLines = await run.collectExportScene(source({ cards: new Map(), map: { title: 'T', nodes: [], canvasItems: [items[0]] }, frameBox: () => ({ x: 0, y: 0, w: 10, h: 10 }) }), () => true);
  assert.deepEqual(plain(onlyLines), { refuse: 'empty' });
  const textOnly = await run.collectExportScene(source({ cards: new Map(), texts: () => [card()] }), () => true);
  assert.ok(textOnly.scene);
});

test('B12-x: the export box takes the layout height, so a detail-tier card (taller offsetHeight) exports at its normal height', async () => {
  reset();
  const tall = card({ h: 238 });
  const got = await run.collectExportScene(source({ cards: new Map([['a', tall]]), layoutHeight: () => 119 }), () => true);
  assert.equal(got.scene.cards[0].h, 119);
  const plainGot = await run.collectExportScene(source({ cards: new Map([['a', card({ h: 119 })]]) }), () => true);
  assert.equal(plainGot.scene.cards[0].h, 119, 'without the port the DOM height is used');
});
