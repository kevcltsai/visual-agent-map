// Annotated image P3a: how the view draws an annotated image, its right-click menu, convert / edit note / convert back /
// delete (one undo step each), and the read-only cases. The data layer is tested in steps-annotated-image.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element, find, findAll } = dom;
const plain = value => JSON.parse(JSON.stringify(value));
const TOPICS = 'Agent Workspace/Topics';
const MAP = `${TOPICS}/map-a/Map.md`;
const image = (over = {}) => ({ id: 'img1', kind: 'image', path: 'attachments/a.png', x: 100, y: 50, w: 200, h: 100, ...over });
const annotated = (over = {}) => ({ id: 'img1', kind: 'annotated-image', path: 'attachments/a.png', x: 100, y: 50, w: 200, h: 100, anchors: [], ...over });
const anchor = (id = 'a1') => ({ id, at: { kind: 'image-2d', x: 0.5, y: 0.5 }, note: 'cow back' });

async function harness(items) {
  const { repo, app, contents } = fixture('en', { linkIndex: true });
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const doc = { id: 'map-a', title: 'A', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders(`${TOPICS}/map-a`);
  await app.vault.create(MAP, core.serializeMap(doc));
  const root = await repo.createNote('Root', 'gpt-6-luna', doc, MAP, 'workspace');
  doc.nodes.push(root);
  if (items) doc.canvasItems = items;
  await repo.saveMap(MAP, doc);
  await repo.rebuildDerivedData();
  await app.vault.create('attachments/a.png', 'png-bytes');
  app.vault.getResourcePath = file => `app://vault/${file.path}`;
  const opened = [];
  app.workspace = { getLeaf: () => ({ openFile: async file => { opened.push(file.path); } }) };
  const menus = [];
  class Menu {
    constructor() { this.items = []; menus.push(this); }
    addItem(cb) { const item = { title: '', disabled: false, setTitle(t) { this.title = t; return this; }, setIcon(i) { this.icon = i; return this; }, setWarning() { this.warning = true; return this; }, setDisabled(d) { this.disabled = d; return this; }, onClick(fn) { this.fn = fn; return this; } }; cb(item); this.items.push(item); return this; }
    addSeparator() { return this; } showAtMouseEvent() { this.mouse = true; return this; } showAtPosition(at) { this.at = at; return this; }
  }
  const modals = [];
  const BaseModal = dom.makeModal();
  class Modal extends BaseModal { constructor(a) { super(a); modals.push(this); } }
  const notices = [];
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Menu, Modal, Notice: dom.makeNotice(notices) } }, { createFragment: dom.createFragment });
  let pending = Promise.resolve();
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: work => (pending = Promise.resolve().then(work))
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = element('div'); view.stageEl = element('div');
  view.focusNode = () => {}; view.openDetails = () => {};
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  view.render = () => { view.stageEl.children = []; view.stageEl.child('div', 'vam-node'); view.renderCanvasItems(); };
  const settle = async () => { await pending; await dom.tick(); await pending; await dom.tick(); };
  const onDisk = async () => { const got = (await repo.readMap(MAP)).canvasItems; return got === undefined ? undefined : plain(got); };
  const imageEl = () => find(view.stageEl, i => i.hasClass('vam-canvas-image'));
  /** A right-click (or, with `keyboard`, the Menu key at (0, 0)) on the image; returns the menu it opened, if any. */
  const contextMenu = (keyboard = false) => {
    const el = imageEl(), before = menus.length;
    el.getBoundingClientRect = () => ({ left: 7, bottom: 99 });
    let prevented = false;
    view.onCanvasContextMenu({ target: { closest: sel => (sel === '.vam-canvas-image' ? el : null) }, clientX: keyboard ? 0 : 5, clientY: keyboard ? 0 : 5, preventDefault() { prevented = true; } });
    return menus.length > before ? Object.assign(menus.at(-1), { prevented }) : null;
  };
  const titleOf = item => (typeof item.title === 'string' ? item.title : findAll(item.title, i => i.tag === 'span').map(i => i.text).join(' | '));
  const pick = (menu, text) => menu.items.find(i => titleOf(i).startsWith(text));
  return { repo, app, view, settle, onDisk, imageEl, contextMenu, titleOf, pick, menus, modals, notices, opened, fileText: () => contents.get(MAP) };
}

const bar = el => find(el, i => i.hasClass('vam-annotated-bar'));

test('plain image: no annotated class, no title bar, same aria-label', async () => {
  const h = await harness([image()]);
  h.view.render();
  const el = h.imageEl();
  assert.equal(el.cls, 'vam-canvas-image');
  assert.equal(el.attrs['aria-label'], 'Image: a.png');
  assert.equal(bar(el), undefined);
});

test('annotated image: accent class, title bar with pill, note and anchor count, aria-label', async () => {
  const h = await harness([annotated({ note: 'Cow scan', anchors: [anchor('a1'), anchor('a2')] })]);
  h.view.render();
  const el = h.imageEl();
  assert.ok(el.hasClass('is-annotated'));
  assert.equal(el.attrs['aria-label'], 'Annotated image: Cow scan');
  assert.equal(el.attrs.role, 'img');
  assert.equal(el.tabIndex, 0);
  const b = bar(el);
  assert.equal(find(b, i => i.hasClass('vam-annotated-pill')).children.map(c => c.text).join(''), 'Annotated image');
  assert.equal(find(b, i => i.hasClass('vam-annotated-pill-icon')).iconName, 'map-pin');
  assert.equal(find(b, i => i.hasClass('vam-annotated-note')).text, 'Cow scan');
  assert.equal(find(b, i => i.hasClass('vam-annotated-count')).text, '2 anchor(s)');
  assert.equal(find(el, i => i.tag === 'img').attrs.src, 'app://vault/attachments/a.png');
  assert.ok(find(el, i => i.hasClass('vam-canvas-image-handle')));
});

test('annotated image without a note shows the file name', async () => {
  const h = await harness([annotated()]);
  h.view.render();
  assert.equal(find(bar(h.imageEl()), i => i.hasClass('vam-annotated-note')).text, 'a.png');
  assert.equal(h.imageEl().attrs['aria-label'], 'Annotated image: a.png');
});

test('counter-example (security): hostile notes stay plain text in the bar and the aria-label', async () => {
  for (const hostile of ['<img src=x onerror=alert(1)>', 'javascript:alert(1)', '{{x}}', 'line one\nline two', 'x'.repeat(300)]) {
    const h = await harness([annotated({ note: hostile })]);
    h.view.render();
    const el = h.imageEl();
    const note = h.view.map.canvasItems[0].note;
    assert.ok(note.length <= 200 && !note.includes('\n'), hostile);
    assert.equal(find(bar(el), i => i.hasClass('vam-annotated-note')).text, note);
    assert.equal(el.attrs['aria-label'], `Annotated image: ${note}`);
    const imgs = findAll(el, i => i.tag === 'img');
    assert.equal(imgs.length, 1, 'only the real picture is an img element');
    assert.equal(imgs[0].attrs.onerror, undefined);
    assert.equal(findAll(bar(el), i => i.tag === 'img').length, 0);
  }
});

test('counter-example (missing file): placeholder shows, bar and data stay, the file is unchanged', async () => {
  const items = [annotated({ path: 'attachments/lost.png', note: 'gone', anchors: [anchor()] })];
  const h = await harness(items);
  const before = h.fileText();
  h.view.render();
  const el = h.imageEl();
  assert.ok(el.hasClass('is-missing'));
  assert.ok(bar(el), 'title bar stays');
  assert.equal(findAll(el, i => i.tag === 'span' && i.text === 'lost.png').length, 1);
  assert.equal(find(el, i => i.tag === 'img'), undefined);
  await h.repo.saveMap(MAP, await h.repo.readMap(MAP));
  assert.equal(h.fileText(), before);
  assert.deepEqual(await h.onDisk(), items);
});

test('a missing picture that fails to load keeps the bar too', async () => {
  const h = await harness([annotated({ note: 'n' })]);
  h.view.render();
  const el = h.imageEl();
  find(el, i => i.tag === 'img').fire('error', {});
  assert.ok(el.hasClass('is-missing'));
  assert.ok(bar(el));
  assert.equal(find(el, i => i.tag === 'img'), undefined);
});

test('menu on a plain image: convert, open original, delete; the Menu key opens it beside the image', async () => {
  const h = await harness([image()]);
  h.view.render();
  const menu = h.contextMenu();
  assert.ok(menu.prevented && menu.mouse);
  assert.deepEqual(menu.items.map(h.titleOf), ['Convert to annotated image…', 'Open original file', 'Delete image']);
  const key = h.contextMenu(true);
  assert.deepEqual(plain(key.at), { x: 7, y: 99 });
  menu.items[1].fn();
  assert.deepEqual(h.opened, ['attachments/a.png']);
});

test('convert: dialog with note, hint and buttons; Convert writes one undo step and undo restores the plain image', async () => {
  const h = await harness([image()]);
  h.view.render();
  h.pick(h.contextMenu(), 'Convert').fn();
  const modal = h.modals.at(-1);
  assert.equal(modal.titleEl.text, 'Convert to annotated image');
  assert.ok(findAll(modal.modalEl, i => i.text.startsWith('Write what this picture is')).length);
  assert.deepEqual(dom.buttons(modal.modalEl), ['Cancel', 'Convert']);
  const input = find(modal.modalEl, i => i.tag === 'input');
  assert.equal(input.attrs.maxlength, '200');
  input.value = '  Cow scan  ';
  const entries = h.view.history.past.length;
  dom.button(modal.modalEl, 'Convert').click();
  await h.settle();
  assert.equal(h.view.history.past.length, entries + 1);
  assert.deepEqual(await h.onDisk(), [annotated({ note: 'Cow scan' })]);
  await h.view.history.undoEntry.undo();
  assert.deepEqual(await h.onDisk(), [image()]);
});

test('convert with a blank note keeps no note field', async () => {
  const h = await harness([image()]);
  h.view.render();
  h.pick(h.contextMenu(), 'Convert').fn();
  dom.button(h.modals.at(-1).modalEl, 'Convert').click();
  await h.settle();
  assert.deepEqual(await h.onDisk(), [annotated()]);
});

test('counter-example (cancel): Cancel or closing the dialog leaves the map and the undo stack alone', async () => {
  const h = await harness([image()]);
  h.view.render();
  const before = h.fileText(), entries = h.view.history.past.length;
  h.pick(h.contextMenu(), 'Convert').fn();
  find(h.modals.at(-1).modalEl, i => i.tag === 'input').value = 'typed';
  dom.button(h.modals.at(-1).modalEl, 'Cancel').click();
  h.pick(h.contextMenu(), 'Convert').fn();
  h.modals.at(-1).close();
  await h.settle();
  assert.equal(h.fileText(), before);
  assert.equal(h.view.history.past.length, entries);
});

test('edit note: dialog starts with the current note; Save changes it in one undo step; blank clears it', async () => {
  const h = await harness([annotated({ note: 'old', anchors: [anchor()] })]);
  h.view.render();
  assert.deepEqual(h.contextMenu().items.map(i => h.titleOf(i).split(' | ')[0]), ['Edit note…', 'Convert back to plain image', 'Delete (with its anchors and relations)']);
  h.pick(h.contextMenu(), 'Edit note').fn();
  const modal = h.modals.at(-1);
  assert.equal(modal.titleEl.text, 'Edit note');
  const input = find(modal.modalEl, i => i.tag === 'input');
  assert.equal(input.value, 'old');
  input.value = 'new';
  const entries = h.view.history.past.length;
  dom.button(modal.modalEl, 'Save').click();
  await h.settle();
  assert.equal(h.view.history.past.length, entries + 1);
  assert.deepEqual(await h.onDisk(), [annotated({ note: 'new', anchors: [anchor()] })]);
  await h.view.history.undoEntry.undo();
  assert.deepEqual(await h.onDisk(), [annotated({ note: 'old', anchors: [anchor()] })]);
  h.view.render();
  h.pick(h.contextMenu(), 'Edit note').fn();
  find(h.modals.at(-1).modalEl, i => i.tag === 'input').value = '';
  dom.button(h.modals.at(-1).modalEl, 'Save').click();
  await h.settle();
  assert.equal('note' in (await h.onDisk())[0], false);
});

test('counter-example (convert back): disabled with anchors and a click changes nothing; with none it gives a field-for-field plain image', async () => {
  const h = await harness([annotated({ note: 'n', anchors: [anchor(), anchor('a2')] })]);
  h.view.render();
  const item = h.pick(h.contextMenu(), 'Convert back');
  assert.equal(item.disabled, true);
  assert.equal(h.titleOf(item), 'Convert back to plain image | Delete the 2 anchor(s) first to convert back');
  const before = h.fileText(), entries = h.view.history.past.length;
  item.fn();
  await h.settle();
  assert.equal(h.fileText(), before);
  assert.equal(h.view.history.past.length, entries);

  const free = await harness([annotated({ note: 'n' })]);
  free.view.render();
  const ok = free.pick(free.contextMenu(), 'Convert back');
  assert.equal(ok.disabled, false);
  const count = free.view.history.past.length;
  ok.fn();
  await free.settle();
  assert.equal(free.view.history.past.length, count + 1);
  const [back] = await free.onDisk();
  assert.deepEqual(back, image());
  assert.deepEqual(Object.keys(back).sort(), Object.keys(image()).sort(), 'no note, anchors or relations field');
  await free.view.history.undoEntry.undo();
  assert.deepEqual(await free.onDisk(), [annotated({ note: 'n' })]);
});

test('delete: menu and Delete key remove the image with its anchors and relations in one undo step', async () => {
  const items = [annotated({ note: 'n', anchors: [anchor()], relations: [{ kind: 'related', from: 'a1', to: 'x' }] })];
  for (const how of ['menu', 'key']) {
    const h = await harness(items);
    h.view.render();
    const entries = h.view.history.past.length;
    if (how === 'menu') h.pick(h.contextMenu(), 'Delete').fn();
    else h.imageEl().fire('keydown', { key: 'Delete', preventDefault() {} });
    await h.settle();
    assert.equal(await h.onDisk(), undefined, how);
    assert.equal(h.view.history.past.length, entries + 1, how);
    await h.view.history.undoEntry.undo();
    const back = await h.onDisk();
    assert.equal(back[0].anchors.length, 1, how);
    assert.equal(back[0].id, 'img1', how);
  }
});

test('a plain image can be deleted from its menu', async () => {
  const h = await harness([image()]);
  h.view.render();
  h.pick(h.contextMenu(), 'Delete image').fn();
  await h.settle();
  assert.equal(await h.onDisk(), undefined);
  assert.ok(h.app.vault.getAbstractFileByPath('attachments/a.png'), 'the file stays');
});

test('moving and resizing an annotated image keeps its anchors; one undo step each', async () => {
  const h = await harness([annotated({ note: 'n', anchors: [anchor()] })]);
  h.view.render();
  const entries = h.view.history.past.length;
  h.imageEl().fire('pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
  h.imageEl().fire('pointermove', { clientX: 40, clientY: 30 });
  h.imageEl().fire('pointerup', {});
  await h.settle();
  assert.equal(h.view.history.past.length, entries + 1);
  const [moved] = await h.onDisk();
  assert.deepEqual([moved.kind, moved.x, moved.y, moved.anchors.length], ['annotated-image', 130, 70, 1]);
  h.view.render();
  find(h.imageEl(), i => i.hasClass('vam-canvas-image-handle')).fire('pointerdown', { button: 0, clientX: 0, clientY: 0, pointerId: 2 });
  h.imageEl().fire('pointermove', { clientX: 100, clientY: 0 });
  h.imageEl().fire('pointerup', {});
  await h.settle();
  const [sized] = await h.onDisk();
  assert.equal(sized.w, 300);
  assert.equal(sized.h, 150);
  assert.equal(sized.anchors.length, 1);
});

test('counter-example (read-only): selection mode and AIM draw the look but give no menu, handle, drag or conversion', async () => {
  for (const mode of ['selection', 'aim']) {
    const h = await harness([annotated({ note: 'n' }), image({ id: 'img2', x: 400 })]);
    if (mode === 'selection') h.view.selection.toggleMultiSelect();
    else h.view.aimLive = () => true;
    h.view.render();
    const els = findAll(h.view.stageEl, i => i.hasClass('vam-canvas-image'));
    assert.ok(els[0].hasClass('is-annotated'), mode);
    assert.ok(bar(els[0]), mode);
    for (const el of els) {
      assert.equal(find(el, i => i.hasClass('vam-canvas-image-handle')), undefined, mode);
      assert.equal(el.listeners.pointerdown, undefined, mode);
      assert.equal(el.listeners.keydown, undefined, mode);
    }
    assert.equal(h.contextMenu(), null, mode);
    const before = h.fileText();
    h.view.convertImageDialog('img2');
    await h.view.removeCanvasItem('img1');
    assert.equal(h.modals.length, 0, mode);
    assert.equal(h.fileText(), before, mode);
  }
});
