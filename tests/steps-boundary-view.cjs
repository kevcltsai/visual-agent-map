// Map images P7 (ticket 43): boundary frames. The view draws `boundary` canvas items from the cards that are drawn right now
// (so layout and moves are followed), hides a frame whose members are all gone, prunes empty frames in the next canvas write,
// shows labels as text only, and lets the keyboard select, rename and remove a frame.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element, find, findAll } = dom;
const plain = value => JSON.parse(JSON.stringify(value));
const TOPICS = 'Agent Workspace/Topics';
const MAP = `${TOPICS}/map-b/Map.md`;
const BOX = { root: { x: 100, y: 50, w: 280, h: 140 }, child: { x: 500, y: 300, w: 280, h: 60 }, third: { x: 900, y: 40, w: 280, h: 80 } };
const image = (over = {}) => ({ id: 'img1', kind: 'image', path: 'attachments/a.png', x: 100, y: 50, w: 200, h: 100, ...over });
const frame = (members, over = {}) => ({ id: 'b1', kind: 'boundary', members, ...over });

async function harness(build, { mode } = {}) {
  const { repo, app } = fixture('en', { linkIndex: true });
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const doc = { id: 'map-b', title: 'B', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders(`${TOPICS}/map-b`);
  await app.vault.create(MAP, core.serializeMap(doc));
  const root = await repo.createNote('Root', 'gpt-6-luna', doc, MAP, 'workspace');
  const child = await repo.createNote('Child', 'gpt-6-luna', doc, MAP, 'workspace');
  const third = await repo.createNote('Third', 'gpt-6-luna', doc, MAP, 'workspace');
  child.parentId = root.id;
  doc.nodes.push(root, child, third);
  const ids = { root: root.id, child: child.id, third: third.id };
  if (build) doc.canvasItems = build(ids);
  await repo.saveMap(MAP, doc);
  await repo.rebuildDerivedData();
  await app.vault.create('attachments/a.png', 'png-bytes');
  app.vault.getResourcePath = file => `app://vault/${file.path}`;
  let pending = Promise.resolve();
  const notices = [];
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: dom.makeNotice(notices) } }, { createFragment: dom.createFragment });
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: work => (pending = Promise.resolve().then(work))
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = element('div'); view.stageEl = element('div');
  view.focusNode = () => {}; view.openDetails = () => {};
  if (mode) view[mode] = true;
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  const boxFor = id => (id === ids.root ? BOX.root : id === ids.child ? BOX.child : BOX.third);
  // The real render rebuilds the whole canvas; the stand-in draws the cards that are in map.nodes, then the canvas items.
  view.render = () => {
    view.stageEl.children = [];
    view.cardEls = new Map();
    for (const node of view.map.nodes) {
      const b = boxFor(node.id);
      const card = view.stageEl.child('div', 'vam-node');
      Object.assign(card, { offsetLeft: b.x, offsetTop: b.y, offsetWidth: b.w, offsetHeight: b.h });
      view.cardEls.set(node.id, card);
    }
    view.renderCanvasItems();
  };
  const settle = async () => { await pending; await dom.tick(); await pending; };
  const onDisk = async () => { const items = (await repo.readMap(MAP)).canvasItems; return items === undefined ? undefined : plain(items); };
  return { repo, app, view, doc, ids, settle, onDisk, notices, fixtureContents: () => app.vault.read(app.vault.getAbstractFileByPath(MAP)) };
}
const frames = h => findAll(h.view.stageEl, i => i.hasClass('vam-boundary'));

test('a frame is drawn around the cards that are drawn now, padded, as a labelled group in the tab order after the images', async () => {
  const h = await harness(ids => [image(), frame([ids.root, ids.child], { label: 'Team A' })]);
  h.view.render();
  const stage = h.view.stageEl;
  const imageLayer = find(stage, i => i.hasClass('vam-canvas-items'));
  const layer = find(stage, i => i.hasClass('vam-boundaries'));
  assert.equal(layer.attrs.role, 'group');
  assert.equal(layer.attrs['aria-label'], 'Frames');
  assert.ok(stage.children.indexOf(layer) > stage.children.indexOf(imageLayer), 'frames come after the image layer in DOM and Tab order');
  assert.ok(stage.children.indexOf(imageLayer) > stage.children.findIndex(c => c.hasClass('vam-node')), 'and after the cards');
  const [f] = frames(h);
  assert.equal(f.attrs.role, 'group');
  assert.equal(f.attrs['aria-label'], 'Frame: Team A');
  assert.equal(f.tabIndex, 0);
  assert.equal(f.style.left, '84px');
  assert.equal(f.style.top, '34px');
  assert.equal(f.style.width, '712px');
  assert.equal(f.style.height, '342px');
  assert.equal(find(f, i => i.hasClass('vam-boundary-label')).text, 'Team A');
});

test('an empty label gives the default accessible name', async () => {
  const h = await harness(ids => [frame([ids.root])]);
  h.view.render();
  const [f] = frames(h);
  assert.equal(f.attrs['aria-label'], 'Frame');
});

test('counter-example 1: removing some members shrinks the frame', async () => {
  const h = await harness(ids => [frame([ids.root, ids.child])]);
  h.view.render();
  assert.equal(frames(h)[0].style.width, '712px');
  await h.view.mapChange(map => { map.nodes = map.nodes.filter(n => n.id !== h.ids.child); }, false);
  h.view.render();
  const [f] = frames(h);
  assert.equal(f.style.width, '312px');
  assert.equal(f.style.height, '172px');
  assert.deepEqual((await h.onDisk())[0].members, [h.ids.root, h.ids.child], 'the stored members are not touched');
});

test('counter-example 2: with every member gone nothing is drawn, an undo of the removal brings the frame back', async () => {
  const h = await harness(ids => [frame([ids.root, ids.child])]);
  h.view.render();
  await h.view.mapChange(map => { map.nodes = map.nodes.filter(n => n.id === h.ids.third); }, false);
  h.view.render();
  assert.equal(frames(h).length, 0);
  assert.equal(h.view.map.canvasItems.length, 1, 'removing topics does not touch the frame item (removeSelected is not changed)');
  await h.view.history.undoEntry.undo();
  h.view.map = await h.repo.readMap(MAP);
  h.view.render();
  assert.equal(frames(h).length, 1);
});

test('an empty frame is pruned in the next canvas write, not before; a half-alive frame stays', async () => {
  const h = await harness(ids => [image(), frame(['gone1', 'gone2'], { id: 'dead' }), frame(['gone3', ids.root], { id: 'half' })]);
  h.view.render();
  assert.equal(frames(h).length, 1, 'only the frame with a live member is drawn');
  assert.equal((await h.onDisk()).length, 3, 'drawing does not write');
  await h.view.moveCanvasItem('img1', 5, 5);
  assert.deepEqual((await h.onDisk()).map(i => i.id), ['img1', 'half']);
  await h.view.history.undoEntry.undo();
  assert.equal((await h.onDisk()).length, 3, 'undo of that write brings the pruned frame back');
});

test('counter-example 3: a map without canvas items or with only images draws no frame layer and saves byte for byte', async () => {
  const none = await harness();
  none.view.render();
  assert.equal(find(none.view.stageEl, i => i.hasClass('vam-boundaries')), undefined);
  const before = await none.fixtureContents();
  assert.ok(!before.includes('canvasItems'));
  await none.repo.saveMap(MAP, await none.repo.readMap(MAP));
  assert.equal(await none.fixtureContents(), before);
  const images = await harness(() => [image()]);
  images.view.render();
  assert.equal(find(images.view.stageEl, i => i.hasClass('vam-boundaries')), undefined);
  assert.ok(find(images.view.stageEl, i => i.hasClass('vam-canvas-image')));
});

test('counter-example 4: a label with HTML is shown as text and never parsed', async () => {
  const label = '<img src=x onerror=alert(1)><b>x</b>';
  const h = await harness(ids => [frame([ids.root], { label })]);
  h.view.render();
  const [f] = frames(h);
  assert.equal(find(f, i => i.hasClass('vam-boundary-label')).text, label);
  assert.equal(find(f, i => i.tag === 'img'), undefined);
  assert.equal(find(f, i => i.tag === 'b'), undefined);
  assert.equal(f.attrs['aria-label'], `Frame: ${label}`);
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../experiences/visual-map/view.ts'), 'utf8');
  const body = source.slice(source.indexOf('private renderBoundaries'), source.indexOf('private enableCanvasItemDrag'));
  assert.ok(body.length > 200 && !/innerHTML|outerHTML|insertAdjacentHTML/.test(body));
});

test('addBoundary stores the selected members and an optional label as one undo step; undo leaves no canvasItems field', async () => {
  const h = await harness();
  const entries = h.view.history.past.length;
  const id = await h.view.addBoundary([h.ids.root, h.ids.child, h.ids.root], '  Phase 1  ');
  await h.settle();
  assert.equal(h.view.history.past.length, entries + 1);
  const [saved] = await h.onDisk();
  assert.equal(saved.id, id);
  assert.equal(saved.kind, 'boundary');
  assert.deepEqual(saved.members, [h.ids.root, h.ids.child]);
  assert.equal(saved.label, 'Phase 1');
  await h.view.history.undoEntry.undo();
  assert.equal(await h.onDisk(), undefined);
  const blank = await harness();
  await blank.view.addBoundary([blank.ids.root], '');
  const [noLabel] = await blank.onDisk();
  assert.equal('label' in noLabel, false, 'a blank label is not written');
  const unknown = await harness();
  await unknown.view.addBoundary(['not-a-card'], 'x');
  assert.equal(await unknown.onDisk(), undefined, 'ids that are not cards of this map are not stored');
});

test('keyboard: a frame takes focus and is selected, Delete removes only the frame, Enter and F2 open the label dialog', async () => {
  const h = await harness(ids => [frame([ids.root], { label: 'L' })]);
  h.view.render();
  const f = () => frames(h)[0];
  f().fire('focus', {});
  assert.ok(f().hasClass('is-selected'));
  f().fire('blur', {});
  assert.ok(!f().hasClass('is-selected'));
  const asked = [];
  h.view.editBoundaryLabel = id => asked.push(id);
  for (const key of ['Enter', 'F2']) f().fire('keydown', { key, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(asked, ['b1', 'b1']);
  let prevented = false;
  f().fire('keydown', { key: 'Delete', preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.ok(prevented);
  await h.settle();
  assert.equal(await h.onDisk(), undefined);
  assert.equal(h.view.map.nodes.length, 3, 'no topic was removed');
  await h.view.history.undoEntry.undo();
  assert.equal((await h.onDisk())[0].id, 'b1');
});

test('renameBoundary changes only the label, one undo step; blank removes the label', async () => {
  const h = await harness(ids => [frame([ids.root], { label: 'Old' })]);
  const entries = h.view.history.past.length;
  await h.view.renameBoundary('b1', 'New');
  assert.equal((await h.onDisk())[0].label, 'New');
  assert.equal(h.view.history.past.length, entries + 1);
  await h.view.renameBoundary('b1', '   ');
  assert.equal('label' in (await h.onDisk())[0], false);
});

test('frames cannot be changed on an AIM map or the built-in sample; in selection mode they are drawn but only added, not edited', async () => {
  for (const mode of ['builtIn']) {
    const h = await harness(ids => [frame([ids.root])], { mode });
    h.view.render();
    const before = await h.onDisk();
    await h.view.addBoundary([h.ids.root], 'x');
    await h.view.removeCanvasItem('b1');
    await h.view.renameBoundary('b1', 'x');
    assert.deepEqual(await h.onDisk(), before, mode);
  }
  const aim = await harness(ids => [frame([ids.root])]);
  aim.view.map.aim = { version: 1 };
  const before = await aim.onDisk();
  await aim.view.addBoundary([aim.ids.root], 'x');
  await aim.view.removeCanvasItem('b1');
  assert.deepEqual(await aim.onDisk(), before, 'aim');
  const sel = await harness(ids => [frame([ids.root])], { mode: 'integrationMode' });
  sel.view.render();
  assert.equal(frames(sel).length, 1, 'drawn in selection mode');
  frames(sel)[0].fire('keydown', { key: 'Delete', preventDefault() {}, stopPropagation() {} });
  await sel.settle();
  assert.equal((await sel.onDisk()).length, 1, 'but not removable there');
});

test('the selection bar offers "Add frame" for the selected topics', async () => {
  const h = await harness();
  h.view.multiSelected = new Set([h.ids.root, h.ids.child]);
  const bar = h.view.renderSelectionBar(element('div'));
  const add = find(bar, i => i.tag === 'button' && i.text === 'Add frame');
  assert.ok(add, 'button present');
  assert.ok(!add.disabled);
  h.view.multiSelected = new Set();
  const empty = find(h.view.renderSelectionBar(element('div')), i => i.tag === 'button' && i.text === 'Add frame');
  assert.equal(empty.disabled, true);
  const built = await harness();
  built.view.builtIn = true;
  built.view.multiSelected = new Set([built.ids.root]);
  assert.equal(find(built.view.renderSelectionBar(element('div')), i => i.tag === 'button' && i.text === 'Add frame'), undefined);
});

test('the label dialog may be left blank only when asked to; the default still refuses an empty name', () => {
  class Modal { constructor() { this.titleEl = element('title'); this.contentEl = element('content'); this.modalEl = element('modal'); this.modalEl.children.push(this.contentEl); } close() { this.closed = true; } }
  const { NameModal } = load('ui/modals/name-modal.ts', { obsidian: { ...obsidian, Modal } });
  const run = options => {
    const saved = [];
    const modal = new NameModal({}, 'Frame label', '', v => saved.push(v), options);
    modal.onOpen();
    const input = findAll(modal.contentEl, i => i.tag === 'input')[0];
    const save = findAll(modal.modalEl, i => i.tag === 'button' && i.text === 'Save')[0];
    input.value = ''; input.input();
    input.keydown({ key: 'Enter', isComposing: false, preventDefault() {}, stopPropagation() {} });
    return { saved, disabled: save.disabled };
  };
  assert.deepEqual(run(undefined), { saved: [], disabled: true });
  assert.deepEqual(run({ allowEmpty: true }), { saved: [''], disabled: false });
});
