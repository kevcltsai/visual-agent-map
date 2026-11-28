// Relation editor characterization (view H block): the structure panel's relation rows, both editor dialogs, the add row,
// "Point on an image…" and the canvas line click, driven only through the view entries that stay when the code moves out
// (renderHypothesisSection, openRelationEditor, openAnchorRelationEditor, drawRelations / relationHitEls). Real Repository,
// so every write goes through Map.md and the undo stack; Modal and Notice are recorded stand-ins.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const support = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element, find, findAll } = dom;
const { load: loadMain, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator } = support;
let setUiLanguage = () => {};
const canvas = support.load('experiences/visual-map/canvas-items.ts');

const TOPICS = 'Agent Workspace/Topics';
const MAP = `${TOPICS}/map-a/Map.md`;
const EVIL = '<img src=x onerror=alert(1)>';
const plain = value => JSON.parse(JSON.stringify(value));
const identity = r => `${r.from}\u0000${r.to}\u0000${r.kind}`;
const ann = (over = {}) => ({ id: 'img1', kind: 'annotated-image', path: 'attachments/a.png', x: 100, y: 50, w: 200, h: 100, note: 'cow scan', anchors: [], ...over });
const pt = (id, note) => ({ id, at: { kind: 'image-2d', x: 0.5, y: 0.5 }, ...(note === undefined ? {} : { note }) });

/** A fake SVG element: the dom helper plus the attribute API the view uses on SVG nodes. */
function createSvg(tag) {
  const el = element(tag);
  el.tagName = tag;
  el.setAttribute = (name, value) => { el.attrs[name] = String(value); };
  el.getAttribute = name => el.attrs[name] ?? null;
  el.removeAttribute = name => { delete el.attrs[name]; };
  Object.defineProperty(el, 'textContent', { get() { return this.text; }, set(value) { this.text = String(value); } });
  return el;
}

// Three topics: Root, Child and Third (both under Root). `relations` and `items` are built from the topic ids.
async function real({ relations = () => [], items = () => [], titles = {} } = {}) {
  const { repo, app, contents } = fixture('en', { linkIndex: true });
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const doc = { id: 'map-a', title: 'A', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders(`${TOPICS}/map-a`);
  await app.vault.create(MAP, core.serializeMap(doc));
  const root = await repo.createNote(titles.root ?? 'Root', 'gpt-6-luna', doc, MAP, 'workspace');
  doc.nodes.push(root);
  const child = await repo.createNote(titles.child ?? 'Child', 'gpt-6-luna', doc, MAP, 'inherited');
  child.parentId = root.id; child.x = 340;
  doc.nodes.push(child);
  const third = await repo.createNote(titles.third ?? 'Third', 'gpt-6-luna', doc, MAP, 'inherited');
  third.parentId = root.id; third.x = 340; third.y = 200;
  doc.nodes.push(third);
  const ids = { root: root.id, child: child.id, third: third.id };
  const list = relations(ids);
  if (list.length) doc.topicRelations = list;
  doc.canvasItems = items(ids);
  await repo.saveMap(MAP, doc);
  await repo.rebuildDerivedData();
  await app.vault.create('attachments/a.png', 'png-bytes');
  app.vault.getResourcePath = file => `app://vault/${file.path}`;
  const modals = [], notices = [], suggests = [];
  const BaseModal = dom.makeModal();
  class Modal extends BaseModal { constructor(a) { super(a); modals.push(this); } }
  class Setting {
    constructor(parent) { this.el = parent.createDiv('setting-item'); }
    setName(text) { this.el.createSpan({ text }); return this; } setDesc(text) { this.el.createSpan({ text }); return this; }
    addButton(cb) { const b = this.el.createEl('button'); cb({ setButtonText(t) { b.text = t; return this; }, onClick(fn) { b.addEventListener('click', fn); return this; } }); return this; }
  }
  class InputSuggest { constructor(a, input) { this.inputEl = input; suggests.push(this); } open() {} close() {} }
  const loaded = loadMain('main.ts', { obsidian: { ...obsidian, AbstractInputSuggest: InputSuggest, Modal, Setting, Notice: dom.makeNotice(notices) } }, { createFragment: dom.createFragment, createSvg }, { entryPoints: undefined, stdin: { contents: 'export * from "./main"; export { setUiLanguage } from "./i18n";', resolveDir: support.root, loader: 'ts', sourcefile: 'entry.ts' } });
  const { VisualAgentMapView } = loaded;
  setUiLanguage = loaded.setUiLanguage;
  let pending = Promise.resolve();
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: work => (pending = Promise.resolve().then(work))
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = element('div'); view.stageEl = element('div');
  view.focusNode = () => {}; view.openDetails = () => {};
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  view.render = () => { view.stageEl.children = []; view.stageEl.child('div', 'vam-node'); view.renderCanvasItems(); };
  // The enqueue chain, then the setTimeout(0) of a close-time onClosed.
  const settle = async () => { for (let i = 0; i < 3; i++) { await pending; await new Promise(r => setTimeout(r, 2)); await dom.tick(); } };
  const onDisk = async () => plain(await repo.readMap(MAP));
  const panel = (node = view.map.nodes[0]) => { const host = element('div'); view.renderHypothesisSection(host, node, () => { host.closed = (host.closed ?? 0) + 1; }); return host; };
  return { repo, view, settle, onDisk, modals, notices, panel, ids, fileText: () => contents.get(MAP), suggests };
}

const topicRow = host => find(host, i => i.hasClass('vam-relation-row') && !i.hasClass('vam-anchor-relation-row'));
const anchorRow = host => find(host, i => i.hasClass('vam-anchor-relation-row'));
const pencil = row => find(row, i => i.tag === 'button' && (i.attrs['aria-label'] ?? '').startsWith('Edit relation:'));
const trash = row => find(row, i => i.tag === 'button' && (i.attrs['aria-label'] ?? '').startsWith('Remove relation:'));
const kindSelect = modal => find(modal.modalEl, i => i.tag === 'select' && i.hasClass('vam-relation-kind'));
const note = modal => find(modal.modalEl, i => i.tag === 'textarea');
const addKind = host => find(host, i => i.hasClass('vam-relation-add-kind'));
const noImg = root => assert.equal(findAll(root, i => i.tag === 'img' || i.tag === 'a').length, 0, 'no img or link node');
const SUPPORTS = ids => [{ kind: 'supports', from: ids.root, to: ids.child }];

test('1. the panel pencil opens the real topic editor: two modal classes, the sentence "A supports B", six kinds, a cycle kind disabled with its reason', async () => {
  const h = await real({ relations: ids => [
    { kind: 'prerequisite', from: ids.root, to: ids.child },
    { kind: 'prerequisite', from: ids.child, to: ids.third },
    { kind: 'supports', from: ids.third, to: ids.root }
  ] });
  const host = h.panel();
  const rows = findAll(host, i => i.hasClass('vam-relation-row') && !i.hasClass('vam-anchor-relation-row'));
  assert.equal(rows.length, 2, 'Root has two relations');
  const supportsRow = rows.find(r => r.attrs['aria-label'].startsWith('Third'));
  assert.ok(supportsRow);
  pencil(supportsRow).click();
  assert.equal(h.modals.length, 1);
  const modal = h.modals[0];
  assert.ok(modal.modalEl.hasClass('vam-topic-modal') && modal.modalEl.hasClass('vam-review-modal'));
  assert.ok(find(modal.modalEl, i => i.hasClass('vam-relation-sentence') && i.text === 'Third supports Root'));
  const options = findAll(kindSelect(modal), i => i.tag === 'option');
  assert.deepEqual(options.map(o => o.text), ['Supports', 'Contradicts', 'Verifies', 'Derives from', 'Related', 'Prerequisite']);
  const blocked = options.filter(o => o.disabled).map(o => o.text);
  assert.ok(blocked.includes('Prerequisite'), 'Third -> Root as prerequisite would close a cycle');
  assert.equal(options.find(o => o.text === 'Supports').disabled, false);
  const reason = find(modal.modalEl, i => i.hasClass('vam-relation-reason'));
  assert.ok(reason && reason.text.includes('Prerequisite') && reason.text.startsWith('Unavailable because they would form a cycle'));
  assert.equal(kindSelect(modal).attrs['aria-describedby'], 'vam-relation-kind-reason');
});

test('2. kind change and reverse in the dialog: one undo step each, the selection follows the new identity, the panel repaints, focus stays on the repainted control', async () => {
  const h = await real({ relations: SUPPORTS });
  const { root, child } = h.ids;
  const host = h.panel();
  const firstPencil = pencil(topicRow(host));
  firstPencil.click();
  const modal = h.modals[0];
  const n = h.view.history.past.length;
  const select = kindSelect(modal);
  select.value = 'verifies'; select.fire('change');
  await h.settle();
  assert.deepEqual((await h.onDisk()).topicRelations, [{ kind: 'verifies', from: root, to: child }]);
  assert.equal(h.view.history.past.length, n + 1, 'one write');
  assert.equal(h.view.selection.state.selectedRelation, identity({ kind: 'verifies', from: root, to: child }));
  assert.notEqual(pencil(topicRow(host)), firstPencil, 'the panel repainted');
  assert.equal(pencil(topicRow(host)).attrs['aria-label'], 'Edit relation: Verifies → Child');
  assert.equal(dom.focusedNow(), kindSelect(modal), 'focus on the repainted kind select');
  assert.ok(find(modal.modalEl, i => i.hasClass('vam-relation-sentence') && i.text === 'Root verifies Child'));
  dom.button(modal.modalEl, 'Reverse direction').click();
  await h.settle();
  assert.deepEqual((await h.onDisk()).topicRelations, [{ kind: 'verifies', from: child, to: root }]);
  assert.equal(h.view.history.past.length, n + 2);
  assert.equal(h.view.selection.state.selectedRelation, identity({ kind: 'verifies', from: child, to: root }));
  assert.equal(dom.focusedNow(), find(modal.modalEl, i => i.hasClass('vam-relation-reverse')), 'focus on the repainted Reverse button');
});

test('3. a note with line breaks and spaces, closed at once: onClosed waits for the write; Map.md holds the one-line note; focus lands on the same pair\'s repainted pencil', async () => {
  const h = await real({ relations: SUPPORTS });
  const host = h.panel();
  const old = pencil(topicRow(host));
  old.click();
  const modal = h.modals[0];
  note(modal).value = '  line one \n\n   line two  ';
  const before = dom.focusedNow();
  modal.close();
  assert.equal(dom.focusedNow(), before, 'onClosed is not called inside close()');
  await h.settle();
  assert.equal((await h.onDisk()).topicRelations[0].description, 'line one line two');
  const fresh = pencil(topicRow(host));
  assert.notEqual(fresh, old);
  assert.equal(dom.focusedNow(), fresh, 'focus on the pencil of the same pair after the repaint');
  assert.ok(find(topicRow(host), i => i.hasClass('vam-relation-description-text') && i.text === 'line one line two'));
});

test('4. closing without a change writes nothing (Map.md bytes the same) and still returns the focus to the pencil', async () => {
  const h = await real({ relations: SUPPORTS });
  const host = h.panel();
  const start = h.fileText(), n = h.view.history.past.length;
  pencil(topicRow(host)).click();
  h.modals[0].close();
  await h.settle();
  assert.equal(h.fileText(), start);
  assert.equal(h.view.history.past.length, n);
  assert.equal(dom.focusedNow(), pencil(topicRow(host)));
});

test('5. Delete in the dialog: the relation is gone, the dialog closed once, the selection cleared, focus on the add row\'s kind select', async () => {
  const h = await real({ relations: SUPPORTS });
  const host = h.panel();
  const key = identity({ kind: 'supports', from: h.ids.root, to: h.ids.child });
  h.view.selection.selectRelation(key);
  pencil(topicRow(host)).click();
  const modal = h.modals[0];
  dom.button(modal.modalEl, 'Delete relation').click();
  await h.settle();
  assert.equal((await h.onDisk()).topicRelations, undefined);
  assert.equal(modal.closeCount, 1);
  assert.notEqual(h.view.selection.state.selectedRelation, key);
  assert.equal(topicRow(host), undefined);
  assert.ok(find(host, i => i.hasClass('vam-relation-empty')));
  assert.equal(dom.focusedNow(), addKind(host));
});

test('6. note box: Ctrl+Enter and Meta+Enter write at once without closing; a bare Enter writes nothing', async () => {
  const h = await real({ relations: SUPPORTS });
  const host = h.panel();
  pencil(topicRow(host)).click();
  const modal = h.modals[0];
  const text = () => h.onDisk().then(m => m.topicRelations[0].description);
  note(modal).value = 'typed';
  let prevented = false;
  note(modal).keydown({ key: 'Enter', preventDefault() { prevented = true; } });
  await h.settle();
  assert.equal(await text(), undefined, 'a bare Enter is a line break, not a save');
  assert.equal(prevented, false);
  note(modal).keydown({ key: 'Enter', ctrlKey: true, preventDefault() { prevented = true; } });
  await h.settle();
  assert.equal(await text(), 'typed');
  assert.ok(prevented);
  note(modal).value = 'second';
  note(modal).keydown({ key: 'Enter', metaKey: true });
  await h.settle();
  assert.equal(await text(), 'second');
  assert.equal(modal.closeCount, 0, 'the dialog stays open');
});

test('7. guards: relations off opens no topic dialog; selection mode opens no anchor dialog and the anchor row has no pencil, trash or "Point on an image…"', async () => {
  const h = await real({ relations: SUPPORTS, items: (ids) => [ann({ anchors: [pt('p1', 'x')], relations: [{ kind: 'related', from: 'p1', to: ids.root }] })] });
  const link = (await h.onDisk()).topicRelations[0];
  const enabled = h.view.relationsEnabled;
  h.view.relationsEnabled = () => false;
  h.view.openRelationEditor(link);
  assert.equal(h.modals.length, 0);
  h.view.relationsEnabled = enabled;
  h.view.openRelationEditor(link);
  assert.equal(h.modals.length, 1);
  h.view.selection.toggleMultiSelect();
  h.view.openAnchorRelationEditor({ imageId: 'img1', anchorId: 'p1', topicId: h.ids.root });
  assert.equal(h.modals.length, 1, 'no anchor dialog in selection mode');
  const host = h.panel();
  const row = anchorRow(host);
  assert.ok(row);
  assert.equal(pencil(row), undefined);
  assert.equal(trash(row), undefined);
  assert.equal(find(host, i => i.hasClass('vam-relation-add-anchor')), undefined);
  row.fire('click');
  assert.equal(h.modals.length, 1);
});

test('8. anchor row: a click on the row opens the anchor editor; note saved on close; reverse swaps from and to; delete drops the relation and keeps the anchor', async () => {
  const h = await real({ items: ids => [ann({ anchors: [pt('p1', 'cow back')], relations: [{ kind: 'supports', from: 'p1', to: ids.root }] })] });
  const rel = async () => (await h.onDisk()).canvasItems[0].relations;
  const host = h.panel();
  anchorRow(host).fire('click');
  assert.equal(h.modals.length, 1);
  let modal = h.modals[0];
  assert.ok(modal.modalEl.hasClass('vam-topic-modal') && modal.modalEl.hasClass('vam-review-modal'));
  assert.ok(find(modal.modalEl, i => i.hasClass('vam-relation-sentence') && i.text === 'Supports: Annotated image · cow back → Root'));
  note(modal).value = 'a  note\nhere';
  modal.close();
  await h.settle();
  assert.deepEqual(await rel(), [{ kind: 'supports', from: 'p1', to: h.ids.root, description: 'a note here' }]);
  assert.equal(dom.focusedNow(), pencil(anchorRow(host)), 'focus back on the anchor row pencil');
  pencil(anchorRow(host)).click();
  modal = h.modals[1];
  dom.button(modal.modalEl, 'Reverse direction').click();
  await h.settle();
  assert.deepEqual(await rel(), [{ kind: 'supports', from: h.ids.root, to: 'p1', description: 'a note here' }]);
  assert.equal(dom.focusedNow(), find(modal.modalEl, i => i.hasClass('vam-relation-reverse')));
  trash(anchorRow(host)).click();
  await h.settle();
  const [img] = (await h.onDisk()).canvasItems;
  assert.deepEqual(img.anchors.map(a => a.id), ['p1']);
  assert.equal(img.relations, undefined);
  assert.equal(anchorRow(host), undefined);
});

test('9. a click on a topic relation line on the canvas opens the real topic editor and selects that line', async () => {
  const h = await real({ relations: SUPPORTS });
  h.view.cardEls = new Map(h.view.map.nodes.map(n => { const c = element('div', 'vam-node'); Object.assign(c, { offsetLeft: n.x, offsetTop: n.y, offsetWidth: 280, offsetHeight: 100 }); return [n.id, c]; }));
  h.view.edgesEl = createSvg('svg');
  h.view.viewportEl = element('div'); h.view.viewportEl.computed = { getPropertyValue: () => '' };
  h.view.drawRelations();
  const key = identity({ kind: 'supports', from: h.ids.root, to: h.ids.child });
  const hit = h.view.relationHitEls.get(key);
  assert.ok(hit);
  hit.fire('click');
  assert.equal(h.modals.length, 1);
  assert.ok(h.modals[0].modalEl.hasClass('vam-topic-modal') && h.modals[0].modalEl.hasClass('vam-review-modal'));
  assert.ok(find(h.modals[0].modalEl, i => i.hasClass('vam-relation-sentence') && i.text === 'Root supports Child'));
  assert.equal(h.view.selection.state.selectedRelation, key);
});

test('10. add row: a kind with no legal target disables the search with the reason; picking a target writes the same Map.md bytes as addRelation, repaints, focuses the add row', async () => {
  const none = await real({ relations: ids => [{ kind: 'supports', from: ids.root, to: ids.child }, { kind: 'related', from: ids.root, to: ids.third }] });
  const noneHost = none.panel();
  const kind = addKind(noneHost);
  kind.value = 'contradicts'; kind.fire('change');
  const input = find(noneHost, i => i.tag === 'input' && i.attrs['aria-label'] === 'Other card');
  assert.equal(input.disabled, true);
  assert.equal(input.attrs.placeholder, 'There is no topic this one can be linked to with “Contradicts”.');

  const h = await real({ relations: SUPPORTS });
  const host = h.panel();
  const k = addKind(host);
  k.value = 'contradicts'; k.fire('change');
  const search = find(host, i => i.tag === 'input' && i.attrs['aria-label'] === 'Other card');
  assert.equal(search.disabled, false);
  const suggest = h.suggests.find(s => s.inputEl === search);
  const rows = suggest.getSuggestions('');
  assert.deepEqual(plain(rows.filter(r => r.kind === 'card').map(r => r.id)), [h.ids.third], 'only the legal target: not Root itself, not the linked Child');
  const marker = find(host, i => i.hasClass('vam-relation-add'));
  suggest.selectSuggestion(rows.find(r => r.id === h.ids.third), {});
  await h.settle();
  const viaRow = h.fileText();
  assert.deepEqual((await h.onDisk()).topicRelations, [{ kind: 'supports', from: h.ids.root, to: h.ids.child }, { kind: 'contradicts', from: h.ids.root, to: h.ids.third }]);
  assert.notEqual(find(host, i => i.hasClass('vam-relation-add')), marker, 'the panel repainted');
  assert.equal(dom.focusedNow(), addKind(host), 'focus on the add row');
  assert.equal(findAll(host, i => i.hasClass('vam-relation-row')).length, 2);
  await h.view.history.undoEntry.undo();
  assert.deepEqual((await h.onDisk()).topicRelations, [{ kind: 'supports', from: h.ids.root, to: h.ids.child }]);
  await h.view.addRelation(h.ids.root, h.ids.third, 'contradicts');
  assert.equal(h.fileText(), viaRow, 'the same bytes as view.addRelation');
});

test('11. "Point on an image…": entries read "image · anchor", a linked one is taken; a stale pick gives the Notice and writes nothing; "Place a new point" closes the panel and enters pick mode', async () => {
  const h = await real({ items: ids => [ann({ anchors: [pt('p1', 'cow back'), pt('p2', 'hind')], relations: [{ kind: 'related', from: 'p1', to: ids.root }] })] });
  const host = h.panel();
  find(host, i => i.hasClass('vam-relation-add-anchor')).click();
  const modal = h.modals.at(-1);
  const entry = text => find(modal.modalEl, i => i.tag === 'button' && i.text === text);
  assert.ok(entry('cow scan · cow back').disabled, 'taken');
  assert.ok(find(modal.modalEl, i => i.text === 'Already linked to this topic'));
  assert.equal(entry('cow scan · hind').disabled, false);
  // The pair becomes related behind the dialog's back: the entry is stale and the write is refused.
  await h.view.changeCanvasItems('img1', items => canvas.addAnchorRelation(items, 'img1', { kind: 'supports', from: 'p2', to: h.ids.root }));
  await h.settle();
  const before = (await h.onDisk()).canvasItems;
  const n = h.view.history.past.length;
  entry('cow scan · hind').click();
  await h.settle();
  assert.deepEqual(h.notices, ['This point was not linked: it already has a relation with this topic, or the image has too many relations.']);
  assert.deepEqual((await h.onDisk()).canvasItems, before);
  assert.equal(h.view.history.past.length, n);
  find(host, i => i.hasClass('vam-relation-add-anchor')).click();
  assert.equal(host.closed, undefined);
  dom.button(h.modals.at(-1).modalEl, 'Place a new point on an image').click();
  assert.equal(host.closed, 1, 'the panel dialog is closed');
  assert.ok(find(h.view.contentEl, i => i.hasClass('vam-place-hint')), 'pick mode');
});

test('12. hostile text (note, topic title, anchor note) is plain text in the panel, both editors and the pick dialog: no img node anywhere', async () => {
  const h = await real({
    titles: { child: EVIL },
    relations: ids => [{ kind: 'supports', from: ids.root, to: ids.child, description: EVIL }],
    items: ids => [ann({ note: EVIL, anchors: [pt('p1', EVIL), pt('p2', EVIL)], relations: [{ kind: 'related', from: 'p1', to: ids.root, description: EVIL }] })]
  });
  const host = h.panel();
  noImg(host);
  assert.ok(findAll(host, i => i.text.includes(EVIL)).length >= 2, 'the text is shown as text');
  pencil(topicRow(host)).click();
  noImg(h.modals[0].modalEl);
  assert.ok(find(h.modals[0].modalEl, i => i.hasClass('vam-relation-sentence') && i.text.includes(EVIL)));
  assert.equal(note(h.modals[0]).value, EVIL);
  pencil(anchorRow(host)).click();
  noImg(h.modals[1].modalEl);
  assert.ok(find(h.modals[1].modalEl, i => i.hasClass('vam-relation-sentence') && i.text.includes(EVIL)));
  find(host, i => i.hasClass('vam-relation-add-anchor')).click();
  noImg(h.modals[2].modalEl);
  assert.ok(find(h.modals[2].modalEl, i => i.tag === 'button' && i.text.includes(EVIL)));
});

test('F07b-x. a relation to a knowledge reference names the card and its source map (or the unavailable text), never the internal ref id', async () => {
  try {
  for (const [language, from, gone] of [['en', 'Reference from “Other map”', 'Original card unavailable'], ['zh-TW', '引用自〈Other map〉', '原卡無法取用']]) {
    for (const ok of [true, false]) {
      const h = await real({ relations: ids => [{ kind: 'supports', from: ids.root, to: 'ref-1' }] });
      setUiLanguage(language);
      h.view.map.knowledgeRefs = [{ id: 'ref-1', mapId: 'other', nodeId: 'n1', parentId: h.ids.child, x: 300, y: 0, pathHint: 'Other/Map.md' }];
      h.view.map.topicRelations = [{ kind: 'supports', from: h.ids.root, to: 'ref-1' }];
      h.view.refResolved = new Map([['ref-1', ok ? { ok: true, mapPath: 'Other/Map.md', mapTitle: 'Other map', notePath: 'Other/n1.md', title: 'Ref card' } : { ok: false, reason: 'missing' }]]);
      const host = h.panel();
      const row = topicRow(host);
      assert.ok(row, `${language} ok=${ok}: the panel lists the reference relation`);
      const texts = [row.attrs['aria-label'], ...findAll(row, () => true).map(i => i.text ?? '')].join('\n');
      assert.ok(!texts.includes('ref-'), `${language} ok=${ok}: no internal id in the row: ${texts}`);
      assert.ok(ok ? texts.includes('Ref card') && texts.includes(from) : texts.includes(gone), `${language} ok=${ok}: ${texts}`);
      findAll(row, n => n.tag === 'button')[0].click();
      const modal = h.modals.at(-1);
      const sentence = find(modal.modalEl, i => i.hasClass('vam-relation-sentence')).text;
      assert.ok(!sentence.includes('ref-'), sentence);
      assert.ok(ok ? sentence.includes('Ref card') && sentence.includes(from) : sentence.includes(gone), sentence);
    }
  }
  } finally { setUiLanguage('en'); }
});

test('F07b-x. a reference whose parent card is gone still reads as unavailable in the editor, never as its ref id', async () => {
  const h = await real({ relations: ids => [{ kind: 'supports', from: ids.root, to: 'ref-1' }] });
  h.view.map.knowledgeRefs = [{ id: 'ref-1', mapId: 'other', nodeId: 'n1', parentId: 'gone', x: 300, y: 0, pathHint: 'Other/Map.md' }];
  h.view.map.topicRelations = [{ kind: 'supports', from: h.ids.root, to: 'ref-1' }];
  h.view.refResolved = new Map();
  h.view.openRelationEditor(h.view.map.topicRelations[0]);
  const sentence = find(h.modals.at(-1).modalEl, i => i.hasClass('vam-relation-sentence')).text;
  assert.ok(!sentence.includes('ref-') && sentence.includes('Original card unavailable'), sentence);
});
