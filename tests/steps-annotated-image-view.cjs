// Annotated image P3a: how the view draws an annotated image, its right-click menu, convert / edit note / convert back /
// delete (one undo step each), and the read-only cases. The data layer is tested in steps-annotated-image.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { loadSource } = require('./support-replay.cjs');
const { element, find, findAll } = dom;
const plain = value => JSON.parse(JSON.stringify(value));
const TOPICS = 'Agent Workspace/Topics';
const MAP = `${TOPICS}/map-a/Map.md`;
const image = (over = {}) => ({ id: 'img1', kind: 'image', path: 'attachments/a.png', x: 100, y: 50, w: 200, h: 100, ...over });
const annotated = (over = {}) => ({ id: 'img1', kind: 'annotated-image', path: 'attachments/a.png', x: 100, y: 50, w: 200, h: 100, anchors: [], ...over });
const anchor = (id = 'a1') => ({ id, at: { kind: 'image-2d', x: 0.5, y: 0.5 }, note: 'cow back' });

async function harness(items, lang = 'en') {
  const { repo, app, contents } = fixture(lang, { linkIndex: true });
  const settings = { ...DEFAULT_SETTINGS, language: lang, cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const doc = { id: 'map-a', title: 'A', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders(`${TOPICS}/map-a`);
  await app.vault.create(MAP, core.serializeMap(doc));
  const root = await repo.createNote('Root', 'gpt-6-luna', doc, MAP, 'workspace');
  doc.nodes.push(root);
  if (items) doc.canvasItems = typeof items === 'function' ? items(root.id) : items;
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
  /** Just enough of Obsidian's Setting for the topic picker: a row with a name and buttons. */
  class Setting {
    constructor(parent) { this.el = parent.createDiv('setting-item'); }
    setName(text) { this.el.createSpan({ text }); return this; } setDesc(text) { this.el.createSpan({ text }); return this; }
    addButton(cb) { const b = this.el.createEl('button'); cb({ setButtonText(t) { b.text = t; return this; }, onClick(fn) { b.addEventListener('click', fn); return this; } }); return this; }
  }
  const { VisualAgentMapView, setUiLanguage } = lang === 'en'
    ? { ...load('main.ts', { obsidian: { ...obsidian, Menu, Modal, Setting, Notice: dom.makeNotice(notices) } }, { createFragment: dom.createFragment }), setUiLanguage() {} }
    : loadSource('export { VisualAgentMapView } from "./main"; export { setUiLanguage } from "./i18n";', { obsidian: { ...obsidian, Menu, Modal, Setting, Notice: dom.makeNotice(notices) } }, { createFragment: dom.createFragment });
  setUiLanguage(lang);
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
  assert.equal(el.attrs.role, 'group');
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
  assert.deepEqual(h.contextMenu().items.map(i => h.titleOf(i).split(' | ')[0]), ['Place anchor', 'Edit note…', 'Convert back to plain image', 'Delete (with its anchors and relations)']);
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

// ---- P3b: anchors (draw, tooltip, place mode, dialog, edit, delete) ----------------------------------------------------
const anchorsOf = el => findAll(el, i => i.hasClass('vam-anchor'));
const at = (id, x, y, note) => ({ id, at: { kind: 'image-2d', x, y }, ...(note ? { note } : {}) });
const key = (el, k, extra = {}) => { let prevented = false; el.fire('keydown', { key: k, preventDefault() { prevented = true; }, ...extra }); return prevented; };
/** Press a key where the focus is on the image (the place mode listens on the stage). */
const stageKey = (h, k, extra = {}) => { let prevented = false; h.view.stageEl.fire('keydown', { key: k, target: h.imageEl(), preventDefault() { prevented = true; }, ...extra }); return prevented; };
const crosshair = h => find(h.imageEl(), i => i.hasClass('vam-anchor-crosshair'));
const hint = h => find(h.view.contentEl, i => i.hasClass('vam-place-hint'));

test('anchors: 2D anchors are buttons at their percentages in DOM order after the picture; unknown kinds are not drawn', async () => {
  const h = await harness(root => [annotated({ note: 'n', anchors: [at('a1', 0.25, 0.75, 'cow back'), { id: 'a2', at: { kind: 'model-3d', x: 1 } }, at('a3', 1, 0)], relations: [{ kind: 'supports', from: root, to: 'a1' }] })]);
  h.view.render();
  const el = h.imageEl();
  const list = anchorsOf(el);
  assert.deepEqual(list.map(a => a.dataset.anchorId), ['a1', 'a3']);
  const order = el.children.map(c => c.tag + '.' + c.cls.split(' ')[0]);
  assert.ok(order.indexOf('button.vam-anchor') > order.indexOf('img.'), order.join());
  assert.equal(list[0].tag, 'button');
  assert.equal(list[0].tabIndex, 0);
  assert.match(list[0].style.left, /^\d+(\.\d+)?%$/);
  assert.equal(list[0].style.left, '25%');
  assert.equal(list[0].style.top, '75%');
  assert.ok(list[0].hasClass('is-linked'));
  assert.ok(!list[1].hasClass('is-linked'));
  assert.equal(list[0].attrs['aria-label'], 'Anchor: cow back. Linked to 1 topic(s)');
  assert.equal(list[1].attrs['aria-label'], 'Anchor (no note). Not linked to any topic');
  const tip = find(list[0], i => i.hasClass('vam-anchor-tip'));
  assert.equal(list[0].attrs['aria-describedby'], tip.attrs.id);
  assert.equal(tip.attrs.role, 'tooltip');
  assert.deepEqual(findAll(tip, i => i.tag === 'span' && i.text).map(i => i.text), ['cow back', 'Linked to 1 topic(s)']);
  assert.deepEqual(findAll(find(list[1], i => i.hasClass('vam-anchor-tip')), i => i.text).map(i => i.text), ['Not linked to any topic']);
  assert.equal(findAll(h.view.stageEl, i => i.hasClass('vam-anchor')).length, 2, 'exported scene never sees them: they live only in the item element');
});

test('counter-example (security): hostile anchor notes are plain text in the label and the tooltip, style is numbers only', async () => {
  for (const hostile of ['<img src=x onerror=alert(1)>', 'javascript:alert(1)', '{{x}}', 'line one\nline two', 'x'.repeat(300)]) {
    const h = await harness([annotated({ anchors: [at('a1', 0.5, 0.5, hostile)] })]);
    h.view.render();
    const [a] = anchorsOf(h.imageEl());
    const note = h.view.map.canvasItems[0].anchors[0].note;
    assert.ok(note.length <= 200 && !note.includes('\n'), hostile);
    assert.equal(a.attrs['aria-label'], `Anchor: ${note}. Not linked to any topic`);
    assert.equal(find(a, i => i.hasClass('vam-anchor-tip-note')).text, note);
    assert.equal(findAll(a, i => i.tag === 'img').length, 0);
    assert.match(a.style.left + ' ' + a.style.top, /^\d+(\.\d+)?% \d+(\.\d+)?%$/);
    assert.equal(a.attrs.onerror, undefined);
  }
});

test('anchors: pointerdown and click on an anchor do not reach the image (no drag)', async () => {
  const h = await harness([annotated({ anchors: [at('a1', 0.5, 0.5)] })]);
  h.view.render();
  const [a] = anchorsOf(h.imageEl());
  for (const name of ['pointerdown', 'click']) {
    let stopped = false;
    for (const fn of a.listeners[name] ?? []) fn({ stopPropagation() { stopped = true; }, preventDefault() {}, button: 0 });
    assert.ok(stopped, name);
  }
});

test('place mode: menu item starts it with a centred crosshair and the hint bar; arrows move 2%, Shift 10%, clamped to 0-1', async () => {
  const h = await harness([annotated({ note: 'n' })]);
  h.view.render();
  assert.equal(h.titleOf(h.contextMenu().items[0]), 'Place anchor');
  h.pick(h.contextMenu(), 'Place anchor').fn();
  assert.equal(hint(h).attrs.role, 'status');
  assert.equal(hint(h).text, '← ↑ → ↓ to move, Shift to move further, Enter to place, Esc to cancel, or just click with the mouse');
  assert.equal(crosshair(h).style.left, '50%');
  assert.equal(crosshair(h).style.top, '50%');
  assert.ok(stageKey(h, 'ArrowRight'));
  assert.equal(crosshair(h).style.left, '52%');
  stageKey(h, 'ArrowDown', { shiftKey: true });
  assert.equal(crosshair(h).style.top, '60%');
  for (let i = 0; i < 12; i++) stageKey(h, 'ArrowLeft', { shiftKey: true });
  assert.equal(crosshair(h).style.left, '0%');
  for (let i = 0; i < 20; i++) stageKey(h, 'ArrowUp', { shiftKey: true });
  assert.equal(crosshair(h).style.top, '0%');
  for (let i = 0; i < 20; i++) stageKey(h, 'ArrowRight', { shiftKey: true });
  assert.equal(crosshair(h).style.left, '100%');
});

test('place mode: Enter on the focused annotated image enters it; a plain image does nothing', async () => {
  const h = await harness([annotated({ note: 'n' })]);
  h.view.render();
  assert.ok(key(h.imageEl(), 'Enter'));
  assert.ok(hint(h));
  const p = await harness([image()]);
  p.view.render();
  key(p.imageEl(), 'Enter');
  assert.equal(hint(p), undefined);
});

test('counter-example (cancel): Esc leaves the place mode, the map and the undo stack unchanged', async () => {
  const h = await harness([annotated({ note: 'n' })]);
  h.view.render();
  const before = h.fileText(), entries = h.view.history.past.length;
  h.view.startPlacingAnchor('img1');
  stageKey(h, 'ArrowRight');
  assert.ok(stageKey(h, 'Escape'));
  await h.settle();
  assert.equal(hint(h), undefined);
  assert.equal(crosshair(h), undefined);
  assert.equal(h.modals.length, 0);
  assert.equal(h.fileText(), before);
  assert.equal(h.view.history.past.length, entries);
  stageKey(h, 'Enter');
  assert.equal(h.modals.length, 0, 'mode is over: Enter does nothing');
});

test('place mode: a mouse click on the image places at the pointer (clamped); a click elsewhere cancels', async () => {
  const h = await harness([annotated({ note: 'n' })]);
  h.view.render();
  h.imageEl().getBoundingClientRect = () => ({ left: 100, top: 50, width: 200, height: 100 });
  h.view.startPlacingAnchor('img1');
  h.view.stageEl.fire('click', { target: h.imageEl(), clientX: 150, clientY: 125 });
  const modal = h.modals.at(-1);
  assert.equal(modal.titleEl.text, 'New anchor');
  assert.equal(hint(h), undefined);
  dom.button(modal.modalEl, 'Done').click();
  await h.settle();
  const [a] = (await h.onDisk())[0].anchors;
  assert.deepEqual(plain(a.at), { kind: 'image-2d', x: 0.25, y: 0.75 });
  h.view.render();
  h.view.startPlacingAnchor('img1');
  h.view.stageEl.fire('click', { target: element('div') });
  assert.equal(hint(h), undefined);
  assert.equal(h.modals.length, 1, 'a click away cancels without a dialog');
});

test('dialog: new topic is the default; Done writes one anchor, one topic, one related relation in one undo step', async () => {
  const h = await harness([annotated({ note: 'n' })]);
  h.view.render();
  const nodes = h.view.map.nodes.length, entries = h.view.history.past.length;
  h.view.startPlacingAnchor('img1');
  stageKey(h, 'ArrowRight');
  stageKey(h, 'Enter');
  const modal = h.modals.at(-1);
  assert.deepEqual(dom.buttons(modal.modalEl), ['Cancel', 'Done']);
  const radios = findAll(modal.modalEl, i => i.tag === 'input' && i.type === 'radio');
  assert.equal(radios.length, 3);
  assert.equal(radios.filter(r => r.checked).length, 1);
  assert.ok(radios[0].checked, 'the first choice (new topic) is preselected');
  assert.deepEqual(findAll(modal.modalEl, i => i.tag === 'span' && i.text).map(i => i.text).slice(0, 3), ['Add a new topic (relation: related)', 'Pick an existing topic…', 'Do not link yet']);
  const input = find(modal.modalEl, i => i.tag === 'input' && i.type === 'text');
  assert.equal(input.attrs.maxlength, '200');
  input.value = 'Cow back';
  dom.button(modal.modalEl, 'Done').click();
  await h.settle();
  assert.equal(h.view.history.past.length, entries + 1);
  const disk = await h.repo.readMap(MAP);
  assert.equal(disk.nodes.length, nodes + 1);
  const created = disk.nodes.at(-1);
  assert.equal((await h.repo.readNote(created.path, disk)).title, 'Cow back');
  const [img] = plain(disk.canvasItems);
  assert.equal(img.anchors.length, 1);
  assert.equal(img.anchors[0].note, 'Cow back');
  assert.deepEqual(img.anchors[0].at, { kind: 'image-2d', x: 0.52, y: 0.5 });
  assert.match(img.anchors[0].id, /^[A-Za-z0-9_-]{1,64}$/);
  assert.ok(!disk.nodes.some(n => n.id === img.anchors[0].id), 'anchor id never equals a node id');
  assert.deepEqual(img.relations, [{ kind: 'related', from: img.anchors[0].id, to: created.id, ring: true }]);
  assert.equal(created.parentId, null, 'image-centre: a new topic is top level, not a child of the main topic');
  await h.view.history.undoEntry.undo();
  const back = await h.repo.readMap(MAP);
  assert.equal(back.nodes.length, nodes);
  assert.deepEqual(plain(back.canvasItems), [annotated({ note: 'n' })]);
});

test('dialog: a blank note gives the default new-topic title; "do not link yet" adds only the anchor', async () => {
  const h = await harness([annotated({ note: 'n' })]);
  h.view.render();
  h.view.startPlacingAnchor('img1');
  stageKey(h, 'Enter');
  dom.button(h.modals.at(-1).modalEl, 'Done').click();
  await h.settle();
  const disk = await h.repo.readMap(MAP);
  assert.equal(disk.nodes.length, 2);
  assert.equal((await h.repo.readNote(disk.nodes.at(-1).path, disk)).title, 'New topic');
  assert.equal('note' in plain(disk.canvasItems)[0].anchors[0], false);

  const g = await harness([annotated({ note: 'n' })]);
  g.view.render();
  g.view.startPlacingAnchor('img1');
  stageKey(g, 'Enter');
  const radios = findAll(g.modals.at(-1).modalEl, i => i.tag === 'input' && i.type === 'radio');
  radios[2].checked = true; radios[2].change();
  const entries = g.view.history.past.length;
  dom.button(g.modals.at(-1).modalEl, 'Done').click();
  await g.settle();
  const after = await g.repo.readMap(MAP);
  assert.equal(after.nodes.length, 1);
  assert.equal(plain(after.canvasItems)[0].anchors.length, 1);
  assert.equal(plain(after.canvasItems)[0].relations, undefined);
  assert.equal(g.view.history.past.length, entries + 1);
});

test('dialog: an existing topic is chosen with the topic picker; cancelling the picker places nothing', async () => {
  const h = await harness([annotated({ note: 'n' })]);
  h.view.render();
  const root = h.view.map.nodes[0];
  h.view.startPlacingAnchor('img1');
  stageKey(h, 'Enter');
  const radios = findAll(h.modals.at(-1).modalEl, i => i.tag === 'input' && i.type === 'radio');
  radios[1].checked = true; radios[1].change();
  dom.button(h.modals.at(-1).modalEl, 'Done').click();
  await h.settle();
  const picker = h.modals.at(-1);
  assert.ok(dom.button(picker.contentEl, 'Select'), 'the picker lists the map topics');
  const before = h.fileText();
  picker.close();
  await h.settle();
  assert.equal(h.fileText(), before, 'picker closed without choosing');
  h.view.startPlacingAnchor('img1');
  stageKey(h, 'Enter');
  const again = findAll(h.modals.at(-1).modalEl, i => i.tag === 'input' && i.type === 'radio');
  again[1].checked = true; again[1].change();
  dom.button(h.modals.at(-1).modalEl, 'Done').click();
  await h.settle();
  dom.button(h.modals.at(-1).contentEl, 'Select').click();
  await h.settle();
  const [img] = plain((await h.repo.readMap(MAP)).canvasItems);
  assert.equal(img.anchors.length, 1);
  assert.deepEqual(img.relations, [{ kind: 'related', from: img.anchors[0].id, to: root.id }]);
});

test('counter-example (cancel): the dialog Cancel or closing it places no anchor and no topic', async () => {
  const h = await harness([annotated({ note: 'n' })]);
  h.view.render();
  const before = h.fileText(), entries = h.view.history.past.length;
  h.view.startPlacingAnchor('img1');
  stageKey(h, 'Enter');
  dom.button(h.modals.at(-1).modalEl, 'Cancel').click();
  h.view.startPlacingAnchor('img1');
  stageKey(h, 'Enter');
  h.modals.at(-1).close();
  await h.settle();
  assert.equal(h.fileText(), before);
  assert.equal(h.view.history.past.length, entries);
});

test('first anchor on an image without a note: a Notice, once per image', async () => {
  const h = await harness([annotated()]);
  h.view.render();
  const place = async () => {
    h.view.startPlacingAnchor('img1');
    stageKey(h, 'Enter');
    const radios = findAll(h.modals.at(-1).modalEl, i => i.tag === 'input' && i.type === 'radio');
    radios[2].checked = true; radios[2].change();
    dom.button(h.modals.at(-1).modalEl, 'Done').click();
    await h.settle();
    h.view.render();
  };
  await place();
  assert.deepEqual(h.notices, ['This image has no note yet. Research and expansion cannot see pictures; add one sentence on what it is and what to research.']);
  await place();
  assert.equal(h.notices.length, 1, 'only once');
  const withNote = await harness([annotated({ note: 'has note' })]);
  withNote.view.render();
  withNote.view.startPlacingAnchor('img1');
  stageKey(withNote, 'Enter');
  dom.button(withNote.modals.at(-1).modalEl, 'Done').click();
  await withNote.settle();
  assert.equal(withNote.notices.length, 0);
});

test('edit: Enter on an anchor opens the dialog with only the note; Save changes it in one undo step', async () => {
  const h = await harness([annotated({ note: 'n', anchors: [at('a1', 0.5, 0.5, 'old'), at('a2', 0.1, 0.1)] })]);
  h.view.render();
  const [a] = anchorsOf(h.imageEl());
  assert.ok(key(a, 'Enter'));
  const modal = h.modals.at(-1);
  assert.equal(modal.titleEl.text, 'Edit anchor');
  assert.equal(findAll(modal.modalEl, i => i.type === 'radio').length, 0);
  const input = find(modal.modalEl, i => i.tag === 'input' && i.type === 'text');
  assert.equal(input.value, 'old');
  input.value = 'new';
  const entries = h.view.history.past.length;
  dom.button(modal.modalEl, 'Save').click();
  await h.settle();
  assert.equal(h.view.history.past.length, entries + 1);
  assert.deepEqual((await h.onDisk())[0].anchors.map(x => x.note), ['new', undefined]);
  await h.view.history.undoEntry.undo();
  assert.equal((await h.onDisk())[0].anchors[0].note, 'old');
});

test('delete: Delete or Backspace on an anchor removes it and its relations only; one undo step; focus returns to the image', async () => {
  const make = root => [annotated({ note: 'n', anchors: [at('a1', 0.5, 0.5), at('a2', 0.1, 0.1)], relations: [{ kind: 'related', from: 'a1', to: root }, { kind: 'related', from: 'a2', to: root }] })];
  for (const k of ['Delete', 'Backspace']) {
    const h = await harness(make);
    const root = h.view.map.nodes[0].id, items = make(root);
    h.view.render();
    const [a] = anchorsOf(h.imageEl());
    const entries = h.view.history.past.length;
    let stopped = false;
    a.fire('keydown', { key: k, preventDefault() {}, stopPropagation() { stopped = true; } });
    assert.ok(stopped, 'the image is not deleted with it');
    await h.settle();
    const [img] = await h.onDisk();
    assert.deepEqual(img.anchors.map(x => x.id), ['a2'], k);
    assert.deepEqual(img.relations, [{ kind: 'related', from: 'a2', to: root }], k);
    assert.equal(h.view.history.past.length, entries + 1, k);
    assert.equal(h.imageEl().focused, true, k + ': focus returns to the image');
    await h.view.history.undoEntry.undo();
    assert.deepEqual((await h.onDisk())[0], items[0], k);
  }
});

test('counter-example (read-only): selection mode and AIM draw anchors and tooltips but cannot place, edit or delete', async () => {
  for (const mode of ['selection', 'aim']) {
    const h = await harness([annotated({ note: 'n', anchors: [at('a1', 0.5, 0.5, 'x')] })]);
    if (mode === 'selection') h.view.selection.toggleMultiSelect();
    else h.view.aimLive = () => true;
    h.view.render();
    const [a] = anchorsOf(h.imageEl());
    assert.ok(a, mode);
    assert.ok(find(a, i => i.hasClass('vam-anchor-tip')), mode);
    assert.equal(a.listeners.keydown, undefined, mode);
    const before = h.fileText();
    h.view.startPlacingAnchor('img1');
    assert.equal(hint(h), undefined, mode);
    await h.view.deleteAnchor('img1', 'a1');
    assert.equal(h.fileText(), before, mode);
    assert.equal(h.modals.length, 0, mode);
  }
});

test('counter-example (unknown kind): an anchor with an unknown position kind is not drawn, not focusable and survives a save', async () => {
  const weird = { id: 'w1', at: { kind: 'model-3d', x: 1, y: 2 }, note: 'keep' };
  const h = await harness([annotated({ note: 'n', anchors: [weird, at('a1', 0.5, 0.5)] })]);
  h.view.render();
  assert.deepEqual(anchorsOf(h.imageEl()).map(a => a.dataset.anchorId), ['a1']);
  h.view.startPlacingAnchor('img1');
  stageKey(h, 'Enter');
  const radios = findAll(h.modals.at(-1).modalEl, i => i.tag === 'input' && i.type === 'radio');
  radios[2].checked = true; radios[2].change();
  dom.button(h.modals.at(-1).modalEl, 'Done').click();
  await h.settle();
  assert.deepEqual((await h.onDisk())[0].anchors[0], weird);
});

test('anchor aria name: the joiner is localised (". " in English, "。" in Chinese)', async () => {
  for (const [lang, joiner] of [['en', '. '], ['zh-TW', '。'], ['zh-CN', '。']]) {
    const h = await harness(root => [annotated({ note: 'n', anchors: [at('a1', 0.25, 0.75, 'cow'), at('a2', 0.5, 0.5, '')], relations: [{ kind: 'supports', from: root, to: 'a1' }] })], lang);
    h.view.render();
    const [first, second] = anchorsOf(h.imageEl());
    for (const label of [first.attrs['aria-label'], second.attrs['aria-label']]) {
      assert.ok(label.includes(joiner), `${lang}: ${label}`);
      if (lang !== 'en') assert.ok(!label.includes('. '), `${lang} has no ASCII joiner: ${label}`);
    }
  }
});

// ---- Image centre P3: a ring of topics around the picture (new topic, move, resize, delete, drag preview) -----------------------
const replay = require('./support-replay.cjs');
const ringLib = replay.load('experiences/visual-map/image-ring.ts');
const ringLayout = replay.load('map-layout-text.ts');
const rectOfNode = (n, h = 120) => ({ x: n.x, y: n.y, w: n.width ?? 280, h });
const statesOf = (map, img = map.canvasItems.find(i => i.kind === 'annotated-image')) => ringLib.ringMembers(map.canvasItems, map.nodes)
  .map(m => ({ id: m.topicId, ...rectOfNode(map.nodes.find(n => n.id === m.topicId)), anchorX: m.x, anchorY: m.y }));
const addTopic = async (h, title, parentId, x, y) => {
  const n = await h.repo.createNote(title, 'gpt-6-luna', h.view.map, MAP, 'workspace');
  n.parentId = parentId; n.x = x; n.y = y; h.view.map.nodes.push(n);
  return n;
};
const reload = async h => { await h.repo.saveMap(MAP, h.view.map); await h.repo.rebuildDerivedData(); h.view.map = await h.repo.readMap(MAP); await h.view.hydrate(); };
const BIG = { x: 1000, y: 1000, w: 720, h: 360 };
/** A picture with three ring cards (one has a folded child and a text block), an unrelated card and a text block beside them. */
async function ringHarness() {
  const h = await harness([]);
  const root = h.view.map.nodes[0];
  root.x = 80; root.y = 80;
  const t1 = await addTopic(h, 'T1', null, 400, 500), t2 = await addTopic(h, 'T2', null, 900, 500), t3 = await addTopic(h, 'T3', null, 1500, 500);
  const kid = await addTopic(h, 'Kid', t1.id, 400, 700); t1.collapsed = true;
  const far = await addTopic(h, 'Far', root.id, 400, 80);
  h.view.map.canvasItems = [
    annotated({ ...BIG, anchors: [at('a1', 0.2, 0.5), at('a2', 0.5, 0.5), at('a3', 0.8, 0.5)], relations: [
      { kind: 'related', from: 'a1', to: t1.id, ring: true }, { kind: 'related', from: 'a2', to: t2.id, ring: true }, { kind: 'related', from: 'a3', to: t3.id, ring: true }] }),
    { id: 'tx-kid', kind: 'text', text: 'under kid', parentId: kid.id, x: 450, y: 750 },
    { id: 'tx-t2', kind: 'text', text: 'under t2', parentId: t2.id, x: 950, y: 560 },
    { id: 'tx-far', kind: 'text', text: 'far', parentId: far.id, x: 450, y: 130 }
  ];
  await reload(h);
  h.view.render();
  return Object.assign(h, { ids: { root: root.id, t1: t1.id, t2: t2.id, t3: t3.id, kid: kid.id, far: far.id } });
}
const nodeIn = (map, id) => map.nodes.find(n => n.id === id);
const textIn = (map, id) => map.canvasItems.find(i => i.id === id);

test('P3 moving the picture: cards of the ring, their branches (folded too) and the text under them go along in one undo step; nothing else moves', async () => {
  const h = await ringHarness();
  const before = plain(await h.repo.readMap(MAP));
  const entries = h.view.history.past.length;
  await h.view.moveCanvasItem('img1', 30, -20);
  const after = await h.repo.readMap(MAP);
  assert.equal(h.view.history.past.length, entries + 1, 'one undo step');
  const pic = after.canvasItems.find(i => i.id === 'img1');
  assert.deepEqual([pic.x, pic.y], [1030, 980]);
  for (const id of [h.ids.t1, h.ids.t2, h.ids.t3, h.ids.kid]) {
    const was = nodeIn(before, id), now = nodeIn(after, id);
    assert.deepEqual([now.x, now.y], [was.x + 30, was.y - 20], id);
  }
  assert.deepEqual([textIn(after, 'tx-kid').x, textIn(after, 'tx-kid').y], [480, 730], 'text under a folded branch');
  assert.deepEqual([textIn(after, 'tx-t2').x, textIn(after, 'tx-t2').y], [980, 540]);
  for (const id of [h.ids.root, h.ids.far]) assert.deepEqual(plain(nodeIn(after, id)), plain(nodeIn(before, id)), 'unrelated card');
  assert.deepEqual(plain(textIn(after, 'tx-far')), plain(textIn(before, 'tx-far')));
  await h.view.history.undoEntry.undo();
  assert.deepEqual(plain(await h.repo.readMap(MAP)), before, 'undo restores every coordinate');
  await h.view.history.undoEntry.redo?.();
});

test('counter-example (plain picture): moving a picture without a ring (or with a relation that is not a ring one) moves only the picture', async () => {
  const h = await ringHarness();
  const t4 = await addTopic(h, 'T4', null, 5000, 5000);
  h.view.map.canvasItems = [annotated({ ...BIG, anchors: [at('a1', 0.2, 0.5)], relations: [{ kind: 'related', from: 'a1', to: h.ids.t1 }] }), image({ id: 'plain', x: 10, y: 10 })];
  await reload(h);
  const before = plain((await h.repo.readMap(MAP)).nodes);
  await h.view.moveCanvasItem('img1', 50, 50);
  await h.view.moveCanvasItem('plain', 5, 5);
  const after = await h.repo.readMap(MAP);
  assert.deepEqual(plain(after.nodes), before);
  assert.deepEqual(plain(after.canvasItems.map(i => [i.id, i.x, i.y])), [['img1', 1050, 1050], ['plain', 15, 15]]);
  assert.ok(t4);
});

test('resize: a picture that grows over its ring cards solves the ring again against the new size; a plain picture changes nothing else', async () => {
  const h = await ringHarness();
  // Put the ring in a valid state first.
  await h.view.mapChange(map => h.view.solveRingsIn(map, { imageIds: new Set(['img1']) }), false);
  const before = await h.repo.readMap(MAP);
  assert.deepEqual(plain(ringLib.ringViolations(before.canvasItems[0], statesOf(before))), [], 'setup: a clean ring');
  const entries = h.view.history.past.length;
  await h.view.resizeCanvasItem('img1', 1500);
  const after = await h.repo.readMap(MAP);
  assert.equal(h.view.history.past.length, entries + 1);
  const pic = after.canvasItems.find(i => i.id === 'img1');
  assert.equal(pic.w, 1500);
  assert.deepEqual(plain(ringLib.ringViolations(pic, statesOf(after), { memberCount: 3 })), [], 'no card on the bigger picture');
  const plainMap = await harness([image()]);
  plainMap.view.render();
  const nodes = plain((await plainMap.repo.readMap(MAP)).nodes);
  await plainMap.view.resizeCanvasItem('img1', 300);
  assert.deepEqual(plain((await plainMap.repo.readMap(MAP)).nodes), nodes);
});

test('delete the picture: the cards stay, stay top-level, lay out as plain topics; one undo brings picture, anchors, relations, ring and coordinates back', async () => {
  const h = await ringHarness();
  const before = plain(await h.repo.readMap(MAP));
  const entries = h.view.history.past.length;
  await h.view.removeCanvasItem('img1');
  const after = await h.repo.readMap(MAP);
  assert.equal(h.view.history.past.length, entries + 1);
  assert.equal(after.canvasItems.some(i => i.kind === 'annotated-image'), false);
  for (const id of [h.ids.t1, h.ids.t2, h.ids.t3]) {
    assert.deepEqual([nodeIn(after, id).x, nodeIn(after, id).y, nodeIn(after, id).parentId], [nodeIn(before, id).x, nodeIn(before, id).y, null], 'stays where it was');
  }
  assert.equal(ringLayout.ringMemberIds(after.nodes, after.canvasItems).size, 0);
  // Laid out afterwards they are ordinary top-level topics: the same as arranging the map without any picture.
  h.view.map = after;
  h.view.arrangeAll(h.view.map);
  const alone = replay.load('map-layout.ts').arrangeMap(after.nodes.map(n => ({ ...n })), new Set(), h.view.cardHeightOf, 'right');
  const arranged = h.view.map.nodes.filter(n => [h.ids.t1, h.ids.t2, h.ids.t3].includes(n.id));
  assert.equal(new Set(arranged.map(n => n.x)).size, 1, 'one column, as plain roots');
  assert.ok(alone.length);
  h.view.map = await h.repo.readMap(MAP);
  await h.view.history.undoEntry.undo();
  assert.deepEqual(plain(await h.repo.readMap(MAP)), before);
});

test('delete an anchor: its card stays where it was and leaves the ring (the other cards stay in it)', async () => {
  const h = await ringHarness();
  const before = await h.repo.readMap(MAP);
  await h.view.deleteAnchor('img1', 'a2');
  const after = await h.repo.readMap(MAP);
  assert.deepEqual([nodeIn(after, h.ids.t2).x, nodeIn(after, h.ids.t2).y, nodeIn(after, h.ids.t2).parentId], [nodeIn(before, h.ids.t2).x, nodeIn(before, h.ids.t2).y, null]);
  assert.deepEqual([...ringLayout.ringMemberIds(after.nodes, after.canvasItems)].sort(), [h.ids.t1, h.ids.t3].sort());
});

test('counter-example (drag a card onto another card): it gets that parent and leaves the ring; the other cards do not move', async () => {
  const h = await ringHarness();
  const before = await h.repo.readMap(MAP);
  await h.view.moveBranches([nodeIn(h.view.map, h.ids.t3)], nodeIn(h.view.map, h.ids.far));
  const after = await h.repo.readMap(MAP);
  assert.equal(nodeIn(after, h.ids.t3).parentId, h.ids.far);
  assert.deepEqual([...ringLayout.ringMemberIds(after.nodes, after.canvasItems)].sort(), [h.ids.t1, h.ids.t2].sort());
  for (const id of [h.ids.t1, h.ids.t2]) assert.deepEqual([nodeIn(after, id).x, nodeIn(after, id).y], [nodeIn(before, id).x, nodeIn(before, id).y], id);
});

/** The preview of a drag needs what a paint made: card elements, edge paths and anchor lines. */
function previewParts(h) {
  const card = (n, w = 280, hh = 120) => Object.assign(element('div', 'vam-node'), { offsetLeft: n.x, offsetTop: n.y, offsetWidth: w, offsetHeight: hh });
  const path = () => ({ d: '', setAttribute(k, v) { this[k] = v; } });
  const map = h.view.map;
  h.view.cardEls = new Map(map.nodes.map(n => [n.id, card(n)]));
  h.view.textEls = new Map();
  h.view.edgeEls = new Map([[`${h.ids.t1}\u0000${h.ids.kid}`, path()], [`${h.ids.root}\u0000${h.ids.far}`, path()]]);
  h.view.relationEls = new Map();
  h.view.anchorLinks = new Map();
  const pic = map.canvasItems.find(i => i.id === 'img1');
  for (const [anchor, topic] of [['a1', h.ids.t1], ['a2', h.ids.t2], ['a3', h.ids.t3]]) {
    const a = pic.anchors.find(x => x.id === anchor);
    const key = `anchor:img1:${anchor}:${topic}`;
    h.view.anchorLinks.set(key, { imageId: 'img1', anchorId: anchor, topicId: topic, point: { x: pic.x + a.at.x * pic.w, y: pic.y + a.at.y * pic.h }, fromAnchor: true, anchorNote: '' });
    h.view.relationEls.set(key, path());
    const n = nodeIn(map, topic);
    h.view.placeAnchorLine(key, h.view.anchorLinks.get(key), { x: n.x, y: n.y, width: 280, height: 120 });
  }
  const textEl = Object.assign(element('div', 'vam-text-node'), { offsetLeft: 950, offsetTop: 560 });
  h.view.textEls.set('tx-t2', textEl);
  return { path };
}

test('drag preview: the cards, the tree edge, the text and the anchor lines follow the picture at once; a cancelled drag puts all of it back', async () => {
  const h = await ringHarness();
  previewParts(h);
  const lines = () => [...h.view.relationEls.values()].map(p => p.d);
  const first = lines();
  h.view.render();
  const el = h.imageEl();
  const cardOf = id => h.view.cardEls.get(id);
  const edge = h.view.edgeEls.get(`${h.ids.t1}\u0000${h.ids.kid}`);
  const other = h.view.edgeEls.get(`${h.ids.root}\u0000${h.ids.far}`);
  const farBefore = cardOf(h.ids.far).style.left;
  el.fire('pointerdown', { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
  el.fire('pointermove', { clientX: 40, clientY: 25 });
  assert.equal(cardOf(h.ids.t2).style.left, '940px');
  assert.equal(cardOf(h.ids.t2).style.top, '525px');
  assert.equal(cardOf(h.ids.t1).style.left, '440px');
  assert.equal(h.view.textEls.get('tx-t2').style.left, '990px');
  assert.equal(cardOf(h.ids.far).style.left, farBefore, 'a card that is not part of the ring stays');
  assert.notEqual(edge.d, '', 'the tree edge below a ring card follows');
  assert.equal(other.d, '', 'an edge of another tree is not touched');
  const moved = lines();
  assert.ok(moved.every((d, i) => d && d !== first[i]), 'every anchor line moved');
  // The cards moved with the picture, so a line keeps its length: the start moves by (40, 25) and so does the card end.
  const num = d => d.match(/-?\d+(\.\d+)?/g).map(Number);
  const m0 = num(moved[1]), f0 = num(first[1]);
  assert.ok(Math.abs((m0[0] - f0[0]) - 40) < 1e-6 && Math.abs((m0[1] - f0[1]) - 25) < 1e-6, 'the line starts on the moved anchor');
  el.fire('pointercancel', {});
  assert.equal(cardOf(h.ids.t2).style.left, '900px');
  assert.equal(cardOf(h.ids.t2).style.top, '500px');
  assert.equal(h.view.textEls.get('tx-t2').style.left, '950px');
  assert.deepEqual(lines(), first, 'every anchor line is where it was');
  assert.equal(el.style.left, '1000px');
  assert.equal((await h.repo.readMap(MAP)).canvasItems[0].x, 1000, 'nothing written');
  assert.equal(h.view.history.past.length, 0);
});

test('drag preview: releasing writes the move once; a picture without a ring previews only itself', async () => {
  const h = await ringHarness();
  previewParts(h);
  h.view.render();
  const el = h.imageEl();
  el.fire('pointerdown', { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
  el.fire('pointermove', { clientX: 40, clientY: 25 });
  el.fire('pointerup', {});
  await h.settle();
  const after = await h.repo.readMap(MAP);
  assert.deepEqual([after.canvasItems[0].x, nodeIn(after, h.ids.t2).x], [1040, 940]);
  assert.equal(h.view.history.past.length, 1);

  const p = await harness([image({ id: 'p1', x: 10, y: 10 })]);
  p.view.render();
  p.view.cardEls = new Map([[p.view.map.nodes[0].id, Object.assign(element('div'), { offsetLeft: 5, offsetTop: 5, offsetWidth: 5, offsetHeight: 5 })]]);
  const pe = p.imageEl();
  pe.fire('pointerdown', { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
  pe.fire('pointermove', { clientX: 40, clientY: 25 });
  assert.equal(pe.style.left, '50px');
  assert.equal(p.view.cardEls.get(p.view.map.nodes[0].id).style.left, undefined, 'a card is not previewed');
  pe.fire('pointercancel', {});
  assert.equal(pe.style.left, '10px');
});

// ---- new topic from the anchor dialog: top level, ring, free slot first, then the whole ring ------------------------------------
const newAnchor = (h, x, y, note = 'New') => h.view.commitAnchor('img1', { x, y }, note, { kind: 'new' });

test('new topic: a top-level topic with ring true; the picture grows to ring size once; the card is outside it; one undo step', async () => {
  const h = await harness([annotated({ note: 'n' })]);
  h.view.render();
  const entries = h.view.history.past.length, before = plain(await h.repo.readMap(MAP));
  await newAnchor(h, 0.3, 0.4, 'Cow back');
  const disk = await h.repo.readMap(MAP);
  const created = disk.nodes.at(-1);
  assert.equal(created.parentId, null);
  const pic = disk.canvasItems[0];
  assert.deepEqual(plain(pic.relations), [{ kind: 'related', from: pic.anchors[0].id, to: created.id, ring: true }]);
  assert.equal(Math.max(pic.w, pic.h), 720, 'long side 720, centre and ratio kept');
  assert.equal(pic.w / pic.h, 2, 'ratio kept');
  assert.deepEqual(plain(ringLib.ringViolations(pic, statesOf(disk), { memberCount: 1 })), []);
  assert.equal(h.view.history.past.length, entries + 1);
  await h.view.history.undoEntry.undo();
  assert.deepEqual(plain(await h.repo.readMap(MAP)), before);
});

test('new topic: a second one takes a free slot, no other card moves and the picture is not resized again', async () => {
  const h = await harness([annotated({ note: 'n' })]);
  h.view.render();
  await newAnchor(h, 0.3, 0.4, 'One');
  const one = await h.repo.readMap(MAP);
  const first = plain(nodeIn(one, one.nodes.at(-1).id));
  h.view.map = one; await h.view.hydrate();
  await newAnchor(h, 0.7, 0.6, 'Two');
  const two = await h.repo.readMap(MAP);
  assert.deepEqual(plain(nodeIn(two, first.id)), first, 'the first card did not move');
  assert.deepEqual(plain(two.canvasItems[0]).w, one.canvasItems[0].w);
  assert.equal(ringLayout.ringMemberIds(two.nodes, two.canvasItems).size, 2);
  assert.deepEqual(plain(ringLib.ringViolations(two.canvasItems[0], statesOf(two), { memberCount: 2 })), []);
});

test('counter-example (no free slot): when a big obstacle leaves no qualified slot the ring is solved again around it', async () => {
  const h = await harness([annotated({ note: 'n' })]);
  h.view.render();
  await newAnchor(h, 0.3, 0.4, 'One');
  const one = await h.repo.readMap(MAP);
  // A huge picture over everything: no slot around the ring is free.
  one.canvasItems.push({ id: 'wall', kind: 'image', path: 'attachments/wall.png', x: -3000, y: -3000, w: 7000, h: 7000 });
  await h.repo.saveMap(MAP, one); h.view.map = await h.repo.readMap(MAP); await h.view.hydrate();
  await newAnchor(h, 0.7, 0.6, 'Two');
  const two = await h.repo.readMap(MAP);
  const pic = two.canvasItems.find(i => i.id === 'img1'), wall = two.canvasItems.find(i => i.id === 'wall');
  assert.equal(ringLayout.ringMemberIds(two.nodes, two.canvasItems).size, 2);
  assert.deepEqual(plain(ringLib.ringViolations(pic, statesOf(two), { memberCount: 2, others: [wall] })), [], 'the whole ring is clean and clear of the wall');
  assert.ok(pic.x + pic.w <= wall.x || pic.x >= wall.x + wall.w || pic.y + pic.h <= wall.y || pic.y >= wall.y + wall.h, 'the ring moved off the wall');
});

test('counter-example (existing topics): linking an existing topic (a top-level one too) sets no ring and moves nothing', async () => {
  const h = await ringHarness();
  const topTopic = h.ids.far, child = h.ids.kid;
  const t5 = await addTopic(h, 'T5', null, 3000, 3000);
  await reload(h);
  const before = plain(await h.repo.readMap(MAP));
  for (const id of [t5.id, topTopic, child])
    await h.view.commitAnchor('img1', { x: 0.1, y: 0.1 }, '', { kind: 'existing', topicId: id });
  const after = await h.repo.readMap(MAP);
  assert.deepEqual(plain(after.nodes), before.nodes, 'no card moved');
  const pic = after.canvasItems.find(i => i.id === 'img1');
  assert.deepEqual([pic.x, pic.y, pic.w, pic.h], [BIG.x, BIG.y, BIG.w, BIG.h], 'the picture stayed');
  const added = pic.relations.slice(3);
  assert.equal(added.length, 3);
  assert.ok(added.every(r => !('ring' in r)));
});

test('counter-example (card height not measured yet): the first place uses the default height; after the card is drawn the ring is placed once more in the same undo step', async () => {
  const h = await harness([annotated({ note: 'n' })]);
  const heights = {};
  h.view.cardHeightOf = id => heights[id];
  let tidied = 0;
  const tidy = h.view.tidyAfterResize.bind(h.view);
  h.view.tidyAfterResize = (...a) => { tidied++; return tidy(...a); };
  h.view.render = () => { for (const n of h.view.map.nodes.slice(1)) heights[n.id] = 700; };
  const entries = h.view.history.past.length;
  await newAnchor(h, 0.5, 0.02, 'Tall');
  const disk = await h.repo.readMap(MAP);
  const created = disk.nodes.at(-1);
  assert.equal(tidied, 1, 'placed again after measuring');
  assert.equal(h.view.history.past.length, entries + 1, 'one undo step for both');
  const state = { id: created.id, x: created.x, y: created.y, w: 280, h: 700, anchorX: 0.5, anchorY: 0.02 };
  assert.deepEqual(plain(ringLib.ringViolations(disk.canvasItems[0], [state], { memberCount: 1 })), [], 'clean with the real height');
  // The same card that is as tall as expected is not touched again.
  const g = await harness([annotated({ note: 'n' })]);
  let again = 0;
  const gt = g.view.tidyAfterResize.bind(g.view);
  g.view.tidyAfterResize = (...a) => { again++; return gt(...a); };
  g.view.render();
  await g.view.commitAnchor('img1', { x: 0.5, y: 0.02 }, 'Short', { kind: 'new' });
  assert.equal(again, 0);
});

// Anchor menu: right-click on a real anchor button offers edit / delete-only-this-anchor.
const anchorMenu = (h, { keyboard = false, anchorId = 'a1', preview = false } = {}) => {
  const el = h.imageEl(), before = h.menus.length;
  const dot = find(h.view.stageEl, i => i.dataset && i.dataset.anchorId === anchorId) ?? { dataset: { anchorId } };
  dot.getBoundingClientRect = () => ({ left: 11, bottom: 33 });
  let prevented = false;
  const closest = sel => (sel === '.vam-canvas-image' ? el : sel === '.vam-anchor[data-anchor-id]' && !preview ? dot : null);
  h.view.onCanvasContextMenu({ target: { closest }, clientX: keyboard ? 0 : 5, clientY: keyboard ? 0 : 5, preventDefault() { prevented = true; } });
  return h.menus.length > before ? Object.assign(h.menus.at(-1), { prevented }) : null;
};
/** The same semantics as main.ts mutate(): every write waits for the earlier ones, so a write started inside a write never finishes. */
const serialMutate = view => {
  let queue = Promise.resolve(), tail = Promise.resolve();
  view.plugin.mutate = work => { const result = queue.then(work); queue = result.catch(() => {}); tail = queue; return result; };
  return async () => {
    const stuck = Symbol('stuck');
    let timer;
    const got = await Promise.race([Promise.resolve().then(() => dom.tick()).then(() => tail), new Promise(r => { timer = setTimeout(() => r(stuck), 1000); })]);
    clearTimeout(timer);
    assert.notEqual(got, stuck, 'the write queue deadlocked');
  };
};
const withRelations = root => [annotated({ note: 'n', anchors: [anchor('a1'), anchor('a2')], relations: [{ kind: 'related', from: 'a1', to: 'a2' }, { kind: 'supports', from: root, to: 'a2' }] })];

test('anchor menu: right-click on an anchor offers Edit anchor and Delete anchor; the Menu key opens it beside the anchor', async () => {
  const h = await harness(withRelations);
  h.view.render();
  const menu = anchorMenu(h);
  assert.deepEqual(menu.items.map(i => h.titleOf(i)), ['Edit anchor…', 'Delete anchor']);
  assert.equal(menu.items[1].warning, true);
  assert.equal(menu.prevented, true);
  assert.equal(menu.mouse, true);
  assert.deepEqual(plain(anchorMenu(h, { keyboard: true }).at), { x: 11, y: 33 });
});

test('counter-example (destructive): Delete anchor removes only that anchor and its lines; image, other anchor and topics stay; one undo restores all', async () => {
  const h = await harness(withRelations);
  h.view.render();
  const nodes = h.view.map.nodes.length, entries = h.view.history.past.length;
  const before = await h.onDisk();
  const drained = serialMutate(h.view);
  anchorMenu(h).items[1].fn();
  await drained();
  const [img] = await h.onDisk();
  assert.equal(img.id, 'img1');
  assert.deepEqual(img.anchors.map(a => a.id), ['a2']);
  assert.deepEqual((img.relations ?? []).filter(r => r.from === 'a1' || r.to === 'a1'), []);
  assert.deepEqual(img.relations, [{ kind: 'supports', from: h.view.map.nodes[0].id, to: 'a2' }]);
  assert.equal(h.view.map.nodes.length, nodes);
  assert.equal((await h.repo.readMap(MAP)).nodes.length, nodes);
  assert.equal(h.view.history.past.length, entries + 1);
  await h.view.history.undoEntry.undo();
  assert.deepEqual(await h.onDisk(), before);
});

test('counter-example (read-only): right-click on an anchor in selection mode or AIM opens no menu and changes nothing', async () => {
  for (const mode of ['selection', 'aim']) {
    const h = await harness(withRelations);
    if (mode === 'selection') h.view.selection.toggleMultiSelect();
    else h.view.aimLive = () => true;
    h.view.render();
    const before = h.fileText();
    assert.equal(anchorMenu(h), null, mode);
    assert.equal(h.fileText(), before, mode);
  }
});

test('counter-example (preview anchor): a preview span without data-anchor-id still opens the image menu', async () => {
  const h = await harness(withRelations);
  h.view.render();
  const menu = anchorMenu(h, { preview: true });
  assert.deepEqual(menu.items.map(i => h.titleOf(i).split(' | ')[0]), ['Place anchor', 'Edit note…', 'Convert back to plain image', 'Delete (with its anchors and relations)']);
});

test('counter-example (image blank area): right-click outside any anchor keeps the four-item image menu', async () => {
  const h = await harness(withRelations);
  h.view.render();
  assert.equal(h.contextMenu().items.length, 4);
});

test('regression: deleting the image keeps every topic on the map', async () => {
  const h = await harness(withRelations);
  h.view.render();
  const nodes = h.view.map.nodes.length;
  assert.ok(nodes > 0);
  h.pick(h.contextMenu(), 'Delete').fn();
  await h.settle();
  assert.equal(await h.onDisk(), undefined);
  assert.equal(h.view.map.nodes.length, nodes);
  assert.equal((await h.repo.readMap(MAP)).nodes.length, nodes);
});

test('counter-example (modes): in place mode or topic-pick mode a right-click on an anchor keeps the image menu', async () => {
  for (const mode of ['placing', 'picking']) {
    const h = await harness(withRelations);
    h.view.render();
    if (mode === 'placing') h.view.startPlacingAnchor('img1');
    else h.view.picking = { topicId: 't', kind: 'related' };
    assert.ok(h.view[mode], mode);
    const menu = anchorMenu(h);
    assert.deepEqual(menu.items.map(i => h.titleOf(i).split(' | ')[0]), ['Place anchor', 'Edit note…', 'Convert back to plain image', 'Delete (with its anchors and relations)'], mode);
  }
});
