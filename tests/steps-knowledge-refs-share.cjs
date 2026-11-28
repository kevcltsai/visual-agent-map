// Cross-map knowledge references (P4.3), packet b: the share file, the viewer's strings, the translation input, the three
// outline exports and what they never do (a path or the original's text in a file; a reference made by an import), and
// that references stay out of everything that walks the map's cards.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, obsidian, root } = require('./support.cjs');

const format = load('experiences/sharing/share-format.ts', { obsidian });
const text = load('experiences/sharing/share-viewer-text.ts', { obsidian });
const ui = load('experiences/sharing/share-viewer-ui.ts', { obsidian });
const dictionaries = load('experiences/sharing/share-viewer-dictionaries.ts', { obsidian });
const kr = load('experiences/visual-map/knowledge-refs.ts', { obsidian });
const exchange = load('experiences/visual-map/outline-exchange.ts', { obsidian });
const notices = [];
const io = load('experiences/visual-map/outline-exchange-io.ts', { obsidian: { ...obsidian, Notice: class { constructor(m) { notices.push(String(m)); } } } });
const exportRun = load('experiences/visual-map/map-export-run.ts', { obsidian }, { document: {}, window: {} });
const outline = load('experiences/visual-map/map-export.ts');
const importer = load('experiences/visual-map/outline-import.ts', { obsidian });
const mm = load('map-model.ts', { obsidian });
const { buildMapChatContext } = load('core/map-chat-context.ts', { obsidian });
const plain = value => JSON.parse(JSON.stringify(value));
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const SECRET_BODY = 'ORIGINAL BODY TEXT';
const OPTIONS = { includeDetail: true, includeImages: false, language: 'en', vamVersion: '1', exportedAt: '2026-11-28T00:00:00Z' };
const node = (id, parentId, x, y) => ({ id, parentId, path: `Topics/${id}.md`, x, y, collapsed: false });
const baseMap = (extra = {}) => ({ id: 'host', title: 'Host', version: 1, nodes: [node('r', null, 100, 50), node('c', 'r', 400, 200)], viewport: { x: 0, y: 0, zoom: 1 }, ...extra });
const ref = (over = {}) => ({ id: 'ref-1', mapId: 'other', nodeId: 'n1', parentId: 'c', x: 300, y: 20, pathHint: 'Mind Maps/Other/Map.md', ...over });
const notes = { r: { title: 'Root', summary: '', status: 'idea' }, c: { title: 'Kid', summary: '', status: 'idea' } };

// ---- share payload (acceptance 13) -------------------------------------------------------------------------------------

test('13: the payload carries a reference as absolute x, y and the title read at share time, and nothing else about it', () => {
  const map = baseMap({ knowledgeRefs: [ref()] });
  const payload = format.buildSharePayload(map, notes, { ...OPTIONS, refTitles: { 'ref-1': 'Original  card' } });
  assert.deepEqual(plain(payload.refs), [{ id: 'ref-1', parentId: 'c', x: 700, y: 220, title: 'Original card' }]);
  const json = JSON.stringify(payload);
  for (const leak of ['other', 'n1', 'Mind Maps', 'pathHint', 'nodeId', 'knowledgeRefs', SECRET_BODY]) assert.equal(json.includes(leak), false, leak);
  // source.mapId is the host map's own id; the reference's mapId must not appear in the refs entry
  assert.equal(JSON.stringify(payload.refs).includes('mapId'), false, 'mapId');
});

test('13: a reference that could not be read, or has no title entry, is shared without a title; orphans and bad entries are skipped', () => {
  const map = baseMap({ knowledgeRefs: [ref(), ref({ id: 'ref-2', nodeId: 'n2' }), ref({ id: 'ref-3', nodeId: 'n3', parentId: 'gone' }), { id: 'bad' }, ref({ id: 'ref-5', mapId: 'host', nodeId: 'x' })] });
  const payload = format.buildSharePayload(map, notes, { ...OPTIONS, refTitles: { 'ref-1': null } });
  assert.deepEqual(plain(payload.refs).map(item => [item.id, 'title' in item]), [['ref-1', false], ['ref-2', false]]);
});

test('13: a map without references gives the payload it gave before: no refs key, same text', () => {
  const plainMap = baseMap();
  const withEmpty = baseMap({ knowledgeRefs: [ref({ parentId: 'gone' })] });
  const a = format.serializeShareJson(format.buildSharePayload(plainMap, notes, OPTIONS));
  const b = format.serializeShareJson(format.buildSharePayload(withEmpty, notes, OPTIONS));
  assert.equal('refs' in JSON.parse(a), false);
  assert.equal(a, b);
});

test('13: the share exporter turns the view\'s titles into the payload and the leak gate stays shut on clean titles; the translation input never holds a title', () => {
  class FileSystemAdapter { getBasePath() { return '/Users/me/Vault'; } }
  const module = load('experiences/sharing/share-exporter.ts', { obsidian: { ...obsidian, FileSystemAdapter, Component: class { load() {} unload() {} addChild() {} removeChild() {} } } });
  const map = baseMap({ knowledgeRefs: [ref()] });
  const map2 = new Map(Object.entries(notes).map(([id, n]) => [id, { ...n, model: '' }]));
  const exporter = new module.ShareExporter({ vault: { adapter: new FileSystemAdapter(), getName: () => 'V' } }, { map, notes: map2, mapPath: 'Folder/Map.md', refTitles: new Map([['ref-1', 'REFTITLE-XYZ']]) }, { vamVersion: '1', language: 'en' });
  const result = exporter.assemble({ includeDetail: false, includeImages: false });
  assert.deepEqual(plain(result.leakCategories), []);
  assert.equal(result.payload.refs[0].title, 'REFTITLE-XYZ');
  assert.ok(result.html.includes('REFTITLE-XYZ'), 'the title travels in the file');
  const source = exporter.translationSource({ includeDetail: false, includeImages: false }, 'en');
  assert.equal(JSON.stringify(source).includes('REFTITLE-XYZ'), false, 'share-translate is never given a reference title');
  assert.equal(/refs|reference/i.test(JSON.stringify(Object.keys(source))), false);
});

test('13: the translation plumbing reads no refs: no source file of share-translate names them', () => {
  for (const file of fs.readdirSync(path.join(root, 'experiences/sharing')).filter(name => /^share-translate/.test(name)))
    assert.equal(/\brefs\b|knowledgeRef/.test(read(`experiences/sharing/${file}`)), false, file);
});

// ---- viewer ---------------------------------------------------------------------------------------------------------

test('13: the viewer draws the title and the mark with textContent, imports nothing from share-format at run time, and every language has both strings', () => {
  const source = read('experiences/sharing/viewer/main.ts');
  assert.match(source, /title\.textContent = ref\.title/);
  assert.match(source, /ui\.refUnavailable/);
  assert.equal(/import\s+(?!type)[^;]*share-format/.test(source), false, 'type-only import of share-format');
  assert.equal(/innerHTML/.test(source.slice(source.indexOf('function renderRefs'), source.indexOf('function renderCards'))), false);
  for (const lang of ['en', 'zh-TW', 'zh-CN', 'ja', 'ko', 'es']) {
    const u = text.shareViewerUiFor(lang);
    assert.ok(u.refLabel && u.refUnavailable, lang);
  }
  assert.equal(text.shareViewerUiFor('zh-TW').refLabel, '引用');
  assert.equal(text.shareViewerUiFor('zh-TW').refUnavailable, '無法取用的引用');
  assert.equal(ui.SHARE_VIEWER_UI_DEFAULT.refLabel, 'Reference');
  const bundle = load('experiences/sharing/viewer-bundle.generated.ts');
  assert.ok(bundle.SHARE_VIEWER_JS.includes('vam-ref-node'), 'the generated viewer draws references (npm run build)');
  assert.ok(bundle.SHARE_VIEWER_CSS.includes('.vam-ref-node'));
});

// ---- exports (acceptance 14) ---------------------------------------------------------------------------------------

const prefixes = { prefix: '[Reference]', unavailable: 'Unavailable reference' };

test('14: referenceOutline adds one virtual child per shown reference, titles only, orphans skipped', () => {
  const map = baseMap({ knowledgeRefs: [ref(), ref({ id: 'ref-2', nodeId: 'n2' }), ref({ id: 'ref-3', parentId: 'gone', nodeId: 'n3' })] });
  const out = kr.referenceOutline(map, new Map([['ref-1', 'Original card'], ['ref-2', null]]), prefixes);
  assert.deepEqual(plain(out.nodes), [{ id: 'vam-ref:ref-1', parentId: 'c' }, { id: 'vam-ref:ref-2', parentId: 'c' }]);
  assert.equal(out.titles.get('vam-ref:ref-1'), '[Reference] Original card');
  assert.equal(out.titles.get('vam-ref:ref-2'), '[Reference] Unavailable reference');
});

function mdSource(map, refs) {
  const state = { notices: [], created: [] };
  const src = {
    map: () => map, path: () => 'Topics/Map.md', fence: () => () => true,
    outlineNodes: m => m.nodes, noteTitle: id => ({ r: 'Root', c: 'Kid' })[id], outlineSummary: () => '',
    attachmentPath: async name => `Media/${name}`, createBinary: async (p, data) => { state.created.push(new TextDecoder().decode(new Uint8Array(data))); },
    notice: t => state.notices.push(t),
    ...(refs ? { referenceOutline: async () => refs } : {})
  };
  return { src, state };
}

test('14: Markdown export writes "[引用] 標題" under the parent card and says so beforehand, only when references exist', async () => {
  const map = baseMap({ knowledgeRefs: [ref()] });
  const refs = kr.referenceOutline(map, new Map([['ref-1', 'Original card']]), prefixes);
  const { src, state } = mdSource(map, refs);
  await exportRun.exportMap(src, 'md', 'vault');
  assert.match(state.created[0], /^# Root\n## Kid\n### \[Reference\] Original card\n?$/);
  const refNotices = list => list.filter(item => /title only/.test(item));
  assert.equal(refNotices(state.notices).length, 1, 'the notice before the file');
  assert.match(state.notices[0], /title only/, 'it comes first, before the saved notice');
  // no references: the old output and no notice (steps-map-export-run.cjs:77 style)
  const plainRun = mdSource(baseMap(), kr.referenceOutline(baseMap(), new Map(), prefixes));
  await exportRun.exportMap(plainRun.src, 'md', 'vault');
  assert.equal(refNotices(plainRun.state.notices).length, 0);
  assert.equal(plainRun.state.created[0].includes('Reference'), false);
});

test('14: OPML and FreeMind carry the reference as a child node, and an import of either never makes a reference', async () => {
  const map = baseMap({ knowledgeRefs: [ref()] });
  const refs = kr.referenceOutline(map, new Map([['ref-1', 'Original card']]), prefixes);
  const input = { title: map.title, nodes: [...map.nodes, ...refs.nodes] };
  const noteMap = new Map([['r', { title: 'Root', body: '' }], ['c', { title: 'Kid', body: SECRET_BODY.slice(0, 0) }], ...refs.titles].map(entry => (typeof entry[1] === 'string' ? [entry[0], { title: entry[1], body: '' }] : entry)));
  const opml = exchange.toOpml(input, noteMap), mind = exchange.toFreeMind(input, noteMap);
  assert.match(opml, /<outline text="\[Reference\] Original card"\/>/);
  assert.match(mind, /TEXT="\[Reference\] Original card"/);
  for (const [name, body] of [['x.opml', opml], ['x.mm', mind]]) {
    const parsed = exchange.parseOutlineExchange(body, { fileName: name });
    assert.equal(parsed.ok, true);
    assert.equal(JSON.stringify(parsed).includes('knowledgeRefs'), false);
    assert.ok(parsed.nodes.some(n => n.title === '[Reference] Original card'), 'it comes back as an ordinary topic');
  }
  const md = outline.mapOutline([...map.nodes, ...refs.nodes], id => refs.titles.get(id) ?? ({ r: 'Root', c: 'Kid' })[id], () => '', 'Host');
  const parsedMd = importer.parseOutline(md);
  assert.equal(JSON.stringify(parsedMd).includes('knowledgeRefs'), false);
  assert.ok(parsedMd.nodes.some(n => n.title === '[Reference] Original card'), 'Markdown re-import gives the reference line back as an ordinary card');
});

test('14: the OPML/FreeMind file export tells about titles only first, only when the map has references, and writes the reference line', async () => {
  const files = new Map();
  const vault = { getAbstractFileByPath: p => files.get(p) ?? null, adapter: { exists: async () => false }, create: async (p, data) => { files.set(p, data); } };
  const map = baseMap({ knowledgeRefs: [ref()] });
  const refs = kr.referenceOutline(map, new Map([['ref-1', 'Original card']]), prefixes);
  const request = format_ => ({ mapPath: 'Topics/Map.md', map, notes: new Map([['r', { title: 'Root', detail: '' }], ['c', { title: 'Kid', detail: '' }]]), format: format_ });
  notices.length = 0;
  await io.exportMapWithNotice(vault, { ...request('opml'), references: refs });
  assert.match(notices[0], /title only/, `notices: ${notices}`);
  assert.match([...files.values()][0], /\[Reference\] Original card/);
  notices.length = 0; files.clear();
  await io.exportMapWithNotice(vault, request('freemind'));
  assert.equal(notices.length, 1, 'only the saved notice: no references, no extra notice');
  assert.equal([...files.values()][0].includes('Reference'), false);
});

// ---- 9 (handoff): references are not in nodes, so nothing that walks the nodes sees them --------------------------------

test('references stay out of layout, in-map search, Living Node and Run All: none of them reads knowledgeRefs', () => {
  const walkers = ['map-layout.ts', 'map-layout-text.ts', 'map-graph.ts', 'experiences/visual-map/map-search.ts', 'experiences/visual-map/living-node-coordinator.ts', 'experiences/visual-map/living-node-provider.ts'];
  for (const file of walkers) assert.equal(/knowledgeRefs|knowledge-refs/.test(read(file)), false, file);
  const consumers = fs.readdirSync(path.join(root, 'experiences/visual-map')).filter(name => /^(map-chat|living-node|run-all|topic-run|argument-run)/.test(name) && name.endsWith('.ts'));
  assert.ok(consumers.length > 3);
  for (const file of consumers) assert.equal(/knowledgeRefs|knowledge-refs/.test(read(`experiences/visual-map/${file}`)), false, file);
  // The data itself: a reference is an entry of its own key, never a node, so a walk over map.nodes cannot meet it.
  const map = baseMap({ knowledgeRefs: [ref()] });
  assert.deepEqual(map.nodes.map(n => n.id), ['r', 'c']);
  assert.deepEqual(plain(mm.parseMap(mm.serializeMap(map), () => {}).nodes.map(n => n.id)), ['r', 'c']);
});

// ---- map chat context (V3.3 F07b, decision #64): only the id, and the title when already resolved ----------------------------

test('chat context: each reference is exactly {id, title?}; unresolved has no title; AIM sends none; no refs means no key; no body or location strings', () => {
  assert.ok(fs.existsSync(path.join(root, 'core/map-chat-context.ts')), 'the context builder must exist: a missing file is a failure, not a skip');
  const base = { mapTitle: 'M', outline: [{ id: 'c', title: 'Kid', summary: '', parentId: null, depth: 0 }], selected: [], references: [], snippets: [], files: [], activeFile: null, history: [] };
  const sent = [{ id: 'ref-1', title: 'Original card' }, { id: 'ref-2' }];
  // The real ref entries carry the secrets; a leak would put them in the input, so the input here carries them on purpose.
  const dirty = sent.map(entry => ({ ...entry, body: SECRET_BODY, mapId: 'other-map-id', nodeId: 'n1-secret', pathHint: 'Mind Maps/Other/Map.md', path: 'Topics/Secret.md' }));
  const json = buildMapChatContext({ ...base, knowledgeRefs: dirty }).json;
  const parsed = JSON.parse(json);
  assert.deepEqual(plain(parsed.knowledgeRefs), [{ id: 'ref-1', title: 'Original card' }, { id: 'ref-2' }]);
  assert.equal('title' in parsed.knowledgeRefs[1], false, 'unresolved: id only');
  for (const leak of [SECRET_BODY, 'other-map-id', 'n1-secret', 'Mind Maps', 'Topics/Secret.md', 'pathHint', 'mapId', 'nodeId']) assert.equal(json.includes(leak), false, leak);
  const aim = JSON.parse(buildMapChatContext({ ...base, aim: true, knowledgeRefs: dirty }).json);
  assert.equal('knowledgeRefs' in aim, false, 'an AIM map sends none');
  for (const input of [base, { ...base, knowledgeRefs: [] }]) assert.equal('knowledgeRefs' in JSON.parse(buildMapChatContext(input).json), false, 'no refs: no key');
});
