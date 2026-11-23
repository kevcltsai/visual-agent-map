// Book any-site images P3: before sharing, the pictures whose licence is unknown or restricted are listed (read from each picture's own
// source line) and can be left out of the file; the note's own text never changes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const support = require('./support.cjs');
const { obsidian, load, plain } = support;
const check = load('experiences/sharing/share-image-check.ts');
const licence = load('core/book-pipeline/image-licence.ts');

const NOTE = fs.readFileSync(path.join(__dirname, 'fixtures', 'sharing', 'book-images.md'), 'utf8');

test('restrictedKind: NC wins, then ND, else other', () => {
  assert.equal(licence.restrictedKind('CC BY-NC 2.0'), 'nc');
  assert.equal(licence.restrictedKind('CC BY-NC-ND 4.0'), 'nc');
  assert.equal(licence.restrictedKind('CC BY-ND 4.0'), 'nd');
  assert.equal(licence.restrictedKind('© 2020 Someone'), 'other');
  assert.equal(licence.restrictedKind('All rights reserved'), 'other');
  assert.equal(licence.restrictedKind(undefined), 'other');
});

test('figuresOf: each picture is classified from its own source line', () => {
  const figures = plain(check.figuresOf(NOTE));
  assert.deepEqual(figures.map(f => [f.alt, f.host, f.status, f.problem]), [
    ['研磨粗細與萃取率', 'commons.wikimedia.org', 'open', undefined],
    ['咖啡羅盤', 'homegrounds.co', 'restricted', 'restricted'],
    ['指針溫度計', 'cdn.sanity.io', 'unknown', 'unknown'],
    ['沖煮示意', 'flickr.com', 'restricted', 'nc'],
    ['開放授權圖', 'example.org', 'open', undefined]
  ]);
});

test('figuresOf: a picture with no source line is unknown, but a note without any source line or slot record is not a picture book', () => {
  const bare = '![x](https://a.example/x.png)\n一句圖說\n';
  assert.deepEqual(plain(check.figuresOf(bare)), [], 'an ordinary note with a picture is left alone');
  const book = `${bare}\n<!-- book-slots:v1 {"slots":[],"bad":0} -->\n`;
  assert.deepEqual(plain(check.figuresOf(book)).map(f => [f.host, f.status]), [['', 'unknown']]);
});

test('figuresOf: the card Sources entry classifies a picture whose source line is missing; code fences are skipped', () => {
  const text = '![圖甲](https://a.example/x.png)\n圖說\n\n- 圖「圖甲」：a.example · CC BY 4.0（[連結](https://a.example/p)）\n\n```\n![z](https://z.example/z.png)\n來源：z\n```\n';
  assert.deepEqual(plain(check.figuresOf(text)).map(f => [f.alt, f.status]), [['圖甲', 'open']]);
});

test('figuresOf: English and Simplified source lines work', () => {
  const text = '![a](https://a.example/a.png)\nA caption.\nSource: shop.example · by Bob · CC BY-NC 4.0 ([link](https://shop.example/p))\n\n![b](https://b.example/b.png)\n说明。\n来源：b.example · 作者 B · CC0（[链接](https://b.example/p)）\n';
  assert.deepEqual(plain(check.figuresOf(text)).map(f => [f.host, f.status, f.problem]), [['shop.example', 'restricted', 'nc'], ['b.example', 'open', undefined]]);
});

test('withoutFigures: the chosen pictures lose image, caption, source line and Sources entry; the others stay; nothing chosen is the same text', () => {
  assert.equal(check.withoutFigures(NOTE, new Set()), NOTE);
  const out = check.withoutFigures(NOTE, new Set([1, 2, 3]));
  for (const gone of ['咖啡羅盤', '指針溫度計', '沖煮示意', 'homegrounds.co', 'cdn.sanity.io', 'flickr.com', '咖啡風味的羅盤圖']) assert.ok(!out.includes(gone), gone);
  for (const kept of ['研磨粗細與萃取率', '開放授權圖', '水溫決定風味。', '## 來源', 'commons.wikimedia.org']) assert.ok(out.includes(kept), kept);
  assert.deepEqual(plain(check.figuresOf(out)).map(f => f.alt), ['研磨粗細與萃取率', '開放授權圖']);
});

// ---- the dialog ----

function harness({ detail = NOTE } = {}) {
  const element = (tag, options = {}) => ({
    tag, text: options.text ?? '', cls: options.cls ?? '', type: options.type, checked: false, disabled: false, children: [], listeners: {},
    createDiv(value) { const c = element('div', typeof value === 'string' ? { cls: value } : value); this.children.push(c); return c; },
    createEl(name, value = {}) { const c = element(name, typeof value === 'string' ? { cls: value } : value); this.children.push(c); return c; },
    createSpan(value = {}) { const c = element('span', value); this.children.push(c); return c; },
    empty() { this.children = []; this.text = ''; }, setText(value) { this.text = value; }, setAttr() {}, addClass() {}, addEventListener(name, fn) { this.listeners[name] = fn; }
  });
  const all = (root, predicate) => [...(predicate(root) ? [root] : []), ...root.children.flatMap(c => all(c, predicate))];
  class Modal { constructor(app) { this.app = app; this.titleEl = element('title'); this.contentEl = element('content'); this.modalEl = element('modal'); this.modalEl.children.push(this.contentEl); } open() { this.onOpen(); } close() { this.onClose(); } }
  class Setting {
    constructor(parent) { this.row = parent.createDiv('setting'); }
    setName() { return this; } setDesc() { return this; } setDisabled() { return this; }
    addToggle(cb) { const input = { disabled: false }; const toggle = { setValue() { return toggle; }, onChange(fn) { toggle.fn = fn; return toggle; }, setDisabled() { return toggle; }, toggleEl: { setAttribute() {}, querySelector: () => input } }; cb(toggle); this.toggle = toggle; return this; }
    addDropdown() { return this; } setHeading() { return this; }
  }
  const mod = load('experiences/sharing/share-modal.ts', { obsidian: { ...obsidian, Modal, Setting, Notice: class {} } });
  const calls = { drop: [], assemble: 0 };
  const exporter = {
    async ensureRendered() {}, async ensureImages() {},
    assemble() { calls.assemble++; return { payload: {}, html: '<html></html>', bytes: 10, counts: { topics: 1, notesWithContent: 1, images: 1 }, leakCategories: [], leakTopics: [], failedImages: 0, mermaidUndrawn: 0, mermaidBlocked: 0 }; },
    dropFigures(choice) { calls.drop.push(plain([...choice].map(([id, set]) => [id, [...set]]))); }, dispose() {}
  };
  const notes = new Map([['a', { title: '研磨度', detail }]]);
  const source = { map: { id: 'm', title: 'Book', nodes: [{ id: 'a', title: '研磨度' }] }, notes, mapPath: 'Map.md' };
  const modal = new mod.ShareModal({}, { source, vamVersion: '1', language: 'zh-TW', createExporter: () => exporter });
  const text = () => all(modal.contentEl, i => i.text).map(i => i.text).join(' | ');
  return { modal, calls, text, all, notes, imagesToggle: () => modal.imagesToggle };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 8));

test('dialog: unknown and restricted pictures are listed with a chip and an unchecked box; saving is not blocked', async () => {
  const h = harness();
  h.modal.open(); await tick(); await tick();
  assert.match(h.text(), /3 pictures have an unknown or restricted licence\. Please check before you share\./);
  assert.match(h.text(), /研磨度 · 咖啡羅盤 · homegrounds\.co/);
  assert.match(h.text(), /Restricted/); assert.match(h.text(), /Unknown licence/); assert.match(h.text(), /No commercial use/);
  assert.ok(!/開放授權圖/.test(h.text()), 'an open picture is not listed');
  const [box] = h.all(h.modal.contentEl, i => i.tag === 'input' && i.type === 'checkbox');
  assert.equal(box.checked, false);
  assert.deepEqual(h.calls.drop.at(-1), []);
  const save = h.all(h.modal.modalEl, i => i.tag === 'button' && i.text);
  assert.ok(save.every(b => !b.disabled));
});

test('dialog: ticking the box leaves exactly those pictures out of the build and does not touch the note', async () => {
  const h = harness();
  h.modal.open(); await tick(); await tick();
  const [box] = h.all(h.modal.contentEl, i => i.tag === 'input' && i.type === 'checkbox');
  box.checked = true; box.listeners.change(); await tick(); await tick();
  assert.deepEqual(h.calls.drop.at(-1), [['a', [1, 2, 3]]]);
  assert.equal(h.notes.get('a').detail, NOTE, 'the note text is the same bytes');
  const [again] = h.all(h.modal.contentEl, i => i.tag === 'input' && i.type === 'checkbox');
  assert.equal(again.checked, true, 'the choice stays after the rebuild');
});

test('dialog: all-open pictures show no reminder', async () => {
  const h = harness({ detail: check.withoutFigures(NOTE, new Set([1, 2, 3])) });
  h.modal.open(); await tick(); await tick();
  assert.ok(!/unknown or restricted licence/.test(h.text()));
  assert.equal(h.all(h.modal.contentEl, i => i.type === 'checkbox').length, 0);
});

test('dialog: pictures with a hostile alt or host are text, never markup', () => {
  const evil = '![<img src=x onerror=1>](https://a.example/x.png)\n圖說\n來源：evil.example · © x（[連結](https://evil.example/<b>)）\n';
  const figures = plain(check.figuresOf(evil));
  assert.equal(figures.length, 1);
  assert.equal(figures[0].alt, '<img src=x onerror=1>');
  const src = fs.readFileSync(path.join(__dirname, '..', 'experiences/sharing/share-modal.ts'), 'utf8');
  assert.ok(!/innerHTML/.test(src.slice(src.indexOf('renderImageCheck'), src.indexOf('private applyDrop'))));
});

test('i18n: the share picture check strings exist in en, zh-TW and zh-CN', () => {
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'i18n', `${lang}.ts`), 'utf8');
    for (const key of ['title_0', 'drop_0']) assert.ok(src.includes(`"share.image_check_${key}"`), `${lang} ${key}`);
    for (const key of ['unknown', 'nc', 'nd', 'restricted']) assert.ok(src.includes(`"share.image_chip_${key}"`), `${lang} ${key}`);
  }
});
