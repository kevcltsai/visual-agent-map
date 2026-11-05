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
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Menu, Modal, Setting, Notice: dom.makeNotice(notices) } }, { createFragment: dom.createFragment });
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
  assert.deepEqual(img.relations, [{ kind: 'related', from: img.anchors[0].id, to: created.id }]);
  assert.equal(created.parentId, disk.nodes.find(n => !n.parentId).id);
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
  assert.deepEqual(h.notices, ['This image has no note yet. The AI cannot see pictures; add one sentence on what it is and what to research.']);
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
