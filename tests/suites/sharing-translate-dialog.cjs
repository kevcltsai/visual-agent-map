// Sharing translation T1 (Worker C): the share dialog's translation flow against a fake runtime (0 live AI calls).
// The real translation service, cache and leak scan run; the exporter, the save picker and the Obsidian widgets are doubles.
const assert = require('node:assert/strict');
const { test, load, obsidian, plain } = require('../support.cjs');
const html = require('../support-html-dom.cjs');

const build = load('experiences/sharing/share-build.ts');
const scan = load('experiences/sharing/share-leak-scan.ts');
const planModule = load('experiences/sharing/share-translate-plan.ts');
const i18n = load('i18n.ts');
const { ShareTranslateService, ShareTranslateError } = load('experiences/sharing/share-translate-service.ts', { obsidian });
const exporterModule = load('experiences/sharing/share-exporter.ts', { obsidian });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition, label = 'condition', limit = 400) => {
  for (let i = 0; i < limit; i++) { if (condition()) return; await sleep(5); }
  assert.fail(`timed out waiting for ${label}`);
};

// ---- fakes ----
function fakeRunner({ transform = text => `T:${text}`, delay = 0, fail = () => false, drop = () => false } = {}) {
  const state = { calls: [], languages: [] };
  const run = async (request, signal) => {
    if (signal.aborted) throw new ShareTranslateError('stopped', 'stopped');
    const index = state.calls.length;
    state.calls.push(request);
    state.languages.push(request.targetLanguage);
    if (delay) await sleep(delay);
    if (signal.aborted) throw new ShareTranslateError('stopped', 'stopped');
    if (fail(request, index)) throw new Error('runtime failed');
    return JSON.stringify({ segments: request.items.filter(item => !drop(request, item)).map(item => ({ id: item.id, text: transform(item.text, request.targetLanguage) })) });
  };
  return { run, state };
}

const baseMap = { id: 'map-1', title: '我的地圖', outputLanguage: 'zh-TW', nodes: [{ id: 'a', path: 'Folder/A.md' }, { id: 'b', path: 'Folder/B.md' }] };
const manyNodes = (count, withDiagram = false) => [
  { id: 'a', title: '根', summary: '摘要一', detailHtml: '<p>第一段文字很長很長很長。</p>' + (withDiagram ? '<svg id="own"><text>Own</text></svg><svg id="mm"><text>Start</text></svg>' : '') + '<p>第二段。</p>', ...(withDiagram ? { diagrams: [{ svgIndex: 1, source: 'flowchart TD\n  A[Start] --> B[End]' }] } : {}) },
  ...Array.from({ length: count - 1 }, (_, i) => ({ id: `n${i}`, title: `主題${i}`, summary: `摘要${i}`, detailHtml: `<p>${`段落${i}。`.repeat(300)}</p>` }))
];

function fakeExporter({ nodes = manyNodes(6), diagramResult = null } = {}) {
  const forbidden = scan.forbiddenStringsFor({ vaultPath: '/Users/me/Vault', mapFolder: 'Folder' }, baseMap, []);
  const calls = { render: 0, images: 0, assemble: [], disposed: 0, sourceOptions: [], diagram: [] };
  const payload = { format: 'vam-share', version: 1, title: '我的地圖', language: 'en', exportedAt: 'x', source: { vamVersion: '1', mapId: 'map-1' }, viewport: { x: 0, y: 0, zoom: 1 }, nodes: nodes.map(node => ({ id: node.id, parentId: null, x: 0, y: 0, collapsed: false, status: 'idea', title: node.title, summary: node.summary, ...(node.detailHtml ? { detailHtml: node.detailHtml } : {}) })), assets: {} };
  return {
    calls,
    async ensureRendered() { calls.render++; },
    async ensureImages() { calls.images++; },
    assemble(options, translation) {
      calls.assemble.push({ options: plain(options), languages: translation ? plain(translation.pieces.map(item => item.language)) : [], defaultLanguage: translation?.defaultLanguage });
      // Like the real exporter: compact translations are rebuilt from the payload's own notes and the rebuilt notes are what is scanned.
      const rebuilt = translation ? build.rebuildTranslationsForPayload(payload.nodes, translation.pieces, { parse: html.parse, serialize: html.serialize, createDiv: () => html.makeDom().createDiv() }) : null;
      const full = translation ? build.attachTranslations(payload, { ...translation, pieces: rebuilt.pieces }) : payload;
      const hits = [...scan.scanPayloadForLeaks(full, forbidden), ...(rebuilt ? rebuilt.pieces.flatMap(item => build.leakCategoriesInTranslation(item.language, item.piece, forbidden, rebuilt.rebuilt[item.language]).map(category => ({ category }))) : [])];
      const base = { payload: full, bytes: 0, counts: { topics: nodes.length, notesWithContent: nodes.length, images: 0 }, leakCategories: [...new Set(hits.map(hit => hit.category))], failedImages: 0, mermaidUndrawn: 0, mermaidBlocked: 0 };
      if (base.leakCategories.length) return base;
      const text = `<html>${JSON.stringify({ languages: full.languages ?? null, defaultLanguage: full.defaultLanguage ?? null, ja: full.translations?.ja?.title ?? null, en: full.translations?.en?.title ?? null, svgs: (rebuilt?.rebuilt.en?.a ?? rebuilt?.rebuilt.ja?.a ?? '').match(/<svg/g)?.length ?? 0 })}</html>`;
      return { ...base, html: text, bytes: text.length };
    },
    dispose() { calls.disposed++; },
    translationSource(options, sourceLanguage) { calls.sourceOptions.push(plain(options)); return { mapId: 'map-1', title: '我的地圖', goal: '目標', sourceLanguage, nodes: options.includeDetail ? nodes : nodes.map(({ id, title, summary }) => ({ id, title, summary })) }; },
    async renderDiagram(source, signal) { calls.diagram.push({ source, aborted: signal.aborted }); return diagramResult; },
    forbiddenStrings() { return forbidden; }
  };
}

function dialog({ exporter = fakeExporter(), runner = fakeRunner(), host = {}, cache = new planModule.ShareTranslationCache(), map = baseMap, picker = true, notes = [], goal } = {}) {
  const element = (tag, options = {}) => ({
    tag, text: options.text ?? '', cls: options.cls ?? '', disabled: false, children: [], listeners: {}, focused: 0,
    createDiv(value) { const c = element('div', typeof value === 'string' ? { cls: value } : value); this.children.push(c); return c; },
    createEl(name, value = {}) { const c = element(name, typeof value === 'string' ? { cls: value } : value); this.children.push(c); return c; },
    createSpan(value = {}) { const c = element('span', value); this.children.push(c); return c; },
    empty() { this.children = []; this.text = ''; }, setText(value) { this.text = value; }, setAttr() {}, addClass() {}, focus() { this.focused++; },
    addEventListener(name, fn) { this.listeners[name] = fn; }
  });
  const find = (rootEl, predicate) => predicate(rootEl) ? rootEl : rootEl.children.map(c => find(c, predicate)).find(Boolean);
  const all = (rootEl, predicate) => [...(predicate(rootEl) ? [rootEl] : []), ...rootEl.children.flatMap(c => all(c, predicate))];
  const notices = [];
  class Modal { constructor(app) { this.app = app; this.titleEl = element('title'); this.contentEl = element('content'); this.modalEl = element('modal'); this.modalEl.children.push(this.contentEl); }
    open() { this.onOpen(); } close() { this.onClose(); } }
  class Setting {
    constructor(parent) { this.row = parent.createDiv('setting'); this.disabled = false; Setting.all.push(this); }
    setName(v) { this.name = v; this.row.createDiv({ text: v }); return this; }
    setDesc(v) { this.desc = v; this.row.createDiv({ text: v }); return this; }
    setHeading() { return this; }
    setDisabled(v) { this.disabled = v; return this; }
    addToggle(cb) { const input = { disabled: false }; const toggle = { value: false, input, off: false, toggleEl: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, querySelector: () => input }, setDisabled(v) { this.off = v; return this; }, setValue(v) { this.value = v; return this; }, onChange(fn) { this.fn = fn; return this; } }; this.toggle = toggle; cb(toggle); return this; }
    addDropdown(cb) { const dd = { options: [], value: '', selectEl: { disabled: false }, addOption(v, l) { this.options.push([v, l]); return this; }, setValue(v) { this.value = v; return this; }, onChange(fn) { this.fn = fn; return this; } }; this.dropdown = dd; cb(dd); return this; }
  }
  Setting.all = [];
  class Notice { constructor(text) { notices.push(text); } }
  const mod = load('experiences/sharing/share-modal.ts', { obsidian: { ...obsidian, Modal, Setting, Notice } });
  const log = { picked: 0, written: [], downloads: 0 };
  const env = {
    triggerDownload: () => { log.downloads++; }, createObjectURL: () => 'blob:test', revokeObjectURL() {}, setTimeout: handler => handler(),
    ...(picker ? { showSaveFilePicker: async () => { log.picked++; return { createWritable: async () => ({ async write(blob) { log.written.push(await blob.text()); }, async close() {} }) }; } } : {})
  };
  const confirmLog = [];
  const translation = {
    service: new ShareTranslateService(runner.run), cache, dom: html.makeDom(),
    models: () => ['claude:sonnet', 'claude:opus'], modelLabel: id => `M(${id})`, defaultModel: () => 'claude:sonnet', reasoning: () => 'low',
    confirmAiUsage: async (model, run) => { confirmLog.push(model); await run(); return true; },
    ...host
  };
  const modal = new mod.ShareModal({}, { source: { map, notes: new Map(notes.map((note, i) => [`n${i}`, { summary: '', ...note }])), ...(goal ? { goal } : {}), mapPath: 'Folder/Map.md' }, vamVersion: '0.25.0', language: 'en', saveEnvironment: env, createExporter: () => exporter, translation });
  const button = text => find(modal.modalEl, i => i.tag === 'button' && i.text === text);
  const text = () => all(modal.modalEl, i => i.text).map(i => i.text).join(' | ');
  const setting = name => [...Setting.all].reverse().find(item => item.name === name || item.name?.startsWith(`${name}: `));
  const lang = id => setting(i18n.supportedLanguageLabel(id)) ?? setting(i18n.translate('en', 'share.translate_original_0', i18n.supportedLanguageLabel(id)));
  const tick = id => lang(id).toggle.fn(true);
  const untick = id => lang(id).toggle.fn(false);
  return { modal, exporter, runner, cache, log, notices, confirmLog, button, text, setting, lang, tick, untick, Setting, translation };
}
const open = async d => { d.modal.open(); await until(() => d.button('Save…') && !d.button('Save…').disabled, 'first build'); };
const translateLabel = 'Translate and save…';
const saveFileLabel = 'Save file…';

test('share dialog T1: a map with no ticked language behaves exactly like P1 and never calls the AI', async () => {
  const d = dialog();
  await open(d);
  assert.equal(d.button('Save…').disabled, false);
  assert.equal(d.button(translateLabel), undefined);
  assert.deepEqual(d.exporter.calls.assemble.map(item => item.languages), [[]]);
  d.button('Save…').listeners.click();
  await until(() => d.log.picked === 1, 'picker');
  await sleep(20);
  assert.equal(d.runner.state.calls.length, 0);
  assert.equal(d.confirmLog.length, 0);
  assert.deepEqual(plain(d.log.written), ['<html>{"languages":null,"defaultLanguage":null,"ja":null,"en":null,"svgs":0}</html>']);
});

test('share dialog T1: the original language row has no control and says it is always included, the others start off', async () => {
  const d = dialog();
  await open(d);
  const original = d.lang('zh-TW');
  assert.equal(original.name, '繁體中文 (original)');
  assert.equal(original.desc, 'Always included, no need to tick.');
  assert.equal(original.toggle, undefined, 'no switch on the original row');
  for (const id of ['zh-CN', 'en', 'ja', 'ko', 'es']) {
    assert.equal(d.lang(id).toggle.value, false, id);
    assert.equal(d.lang(id).toggle.off, false, id);
    assert.equal(d.lang(id).desc, undefined, `${id} has no per-row quality text`);
  }
  assert.equal(d.modal.selected().includes('zh-TW'), false, 'the original is never picked');
  d.tick('en');
  assert.equal(d.modal.selected().includes('zh-TW'), false);
  assert.deepEqual(plain(d.modal.selected()), ['en']);
});

test('share dialog polish: the intro promises no upload only until a translation is ticked, and only with a translation host', async () => {
  const d = dialog();
  await open(d);
  assert.match(d.text(), /Unless you tick a translation, nothing is uploaded\./);
  assert.doesNotMatch(d.text(), /Always includes the original|The file always includes the original/);
  const plainDialog = dialog();
  plainDialog.modal.options.translation = undefined;
  plainDialog.modal.open();
  await until(() => plainDialog.button('Save…') && !plainDialog.button('Save…').disabled, 'build');
  assert.match(plainDialog.text(), /Nothing is uploaded\./);
  assert.doesNotMatch(plainDialog.text(), /Unless you tick/);
});

test('share dialog polish: one merged quality note appears only for ticked unverified languages and lists just those', async () => {
  const d = dialog();
  await open(d);
  const note = () => d.text().match(/The quality of the [^|]*?translation has not been checked by a native speaker\./)?.[0];
  assert.equal(note(), undefined, 'nothing ticked');
  d.tick('en');
  assert.equal(note(), undefined, 'English is verified');
  d.tick('ja');
  assert.match(note(), /the 日本語 translation/);
  assert.doesNotMatch(note(), /English/);
  d.tick('ko');
  assert.match(note(), /日本語, 한국어/);
  d.untick('ja'); d.untick('ko');
  assert.equal(note(), undefined, 'cleared when unticked');
});

test('share dialog polish: the email hint shows only when the file is over the size threshold', async () => {
  const small = dialog();
  await open(small);
  assert.doesNotMatch(small.text(), /email/i);
  const big = dialog({ exporter: fakeExporter() });
  const original = big.exporter.assemble;
  big.exporter.assemble = (...args) => ({ ...original(...args), bytes: 100 * 1024 * 1024 });
  big.modal.open();
  await until(() => /email/i.test(big.text()), 'email hint');
  assert.match(big.text(), /Some email services block HTML attachments/);
});

test('share dialog T1: ticking languages shows the estimate and the translate button; the picker opens only on the second press', async () => {
  const d = dialog();
  await open(d);
  d.tick('en'); d.tick('ja');
  assert.ok(d.button(translateLabel), 'button text changed');
  assert.match(d.text(), /About \d+ AI calls, around \d+ minutes? \(M\(claude:sonnet\)\)\./);
  assert.equal(d.log.picked, 0);
  d.button(translateLabel).listeners.click();
  await until(() => d.button(saveFileLabel), 'translation finished');
  assert.equal(d.log.picked, 0, 'translating never opens the save window');
  assert.equal(d.log.downloads, 0);
  assert.deepEqual(plain(d.confirmLog), ['claude:sonnet']);
  assert.ok(d.runner.state.calls.length > 0);
  assert.deepEqual(new Set(d.runner.state.languages), new Set(['en', 'ja']));
  assert.ok(d.notices.includes('Translation finished. Press “Save file…” to choose where to keep it.'), plain(d.notices));
  assert.ok(d.button(saveFileLabel).focused > 0, 'the save button has focus');
  assert.equal(d.button(saveFileLabel).disabled, false);
  assert.match(d.text(), /Translation results/);
  assert.match(d.text(), /English: Complete/);
  assert.match(d.text(), /日本語: Complete/);
  assert.match(d.text(), /Model: M\(claude:sonnet\)/);
  assert.match(d.text(), /Languages in the file: 繁體中文, English, 日本語/);
  assert.match(d.text(), /Total size with these languages: \d+ B/);
  assert.match(d.text(), /Text inside images is not translated\./);
  assert.equal(d.text().split(' | ').filter(x => x === 'Opens in').length, 1, 'one menu only');
  const assembled = d.exporter.calls.assemble.at(-1);
  assert.deepEqual(assembled.languages, ['en', 'ja']);
  d.button(saveFileLabel).listeners.click();
  await until(() => d.log.picked === 1, 'picker after the second press');
  await until(() => d.log.written.length === 1, 'write');
  const file = JSON.parse(d.log.written[0].replace(/^<html>|<\/html>$/g, ''));
  assert.deepEqual(file.languages, ['zh-TW', 'en', 'ja']);
  assert.equal(file.en, 'T:我的地圖');
  assert.equal(file.ja, 'T:我的地圖');
  assert.deepEqual(plain(d.notices.at(-1)), 'Saved 我的地圖.html (' + build.formatBytes(d.log.written[0].length) + ')');
});

test('share dialog T1: the default-language choice is carried into the file; a language the file lacks is ignored', async () => {
  const d = dialog();
  await open(d);
  d.tick('en'); d.tick('ja');
  d.button(translateLabel).listeners.click();
  await until(() => d.button(saveFileLabel), 'done');
  const dropdown = d.setting('Opens in').dropdown;
  assert.deepEqual(plain(dropdown.options.map(item => item[0])), ['auto', 'zh-TW', 'en', 'ja']);
  assert.equal(dropdown.value, 'auto');
  dropdown.fn('ja');
  assert.equal(d.exporter.calls.assemble.at(-1).defaultLanguage, 'ja');
  d.button(saveFileLabel).listeners.click();
  await until(() => d.log.written.length === 1, 'write');
  assert.equal(JSON.parse(d.log.written[0].replace(/^<html>|<\/html>$/g, '')).defaultLanguage, 'ja');
});

test('share dialog T1: while AI works the switches and the model are locked and Cancel stops the translation, not the dialog', async () => {
  const runner = fakeRunner({ delay: 25 });
  const d = dialog({ runner, exporter: fakeExporter({ nodes: manyNodes(30) }) });
  await open(d);
  d.tick('ja');
  d.button(translateLabel).listeners.click();
  await until(() => d.button('Cancel translation'), 'translation running');
  assert.match(d.text(), /Translating 日本語: language 1 of 1, batch \d+ of \d+/);
  assert.equal(d.button(translateLabel).disabled, true);
  assert.equal(d.Setting.all[0].toggle.input.disabled, true, 'full notes switch');
  assert.equal(d.Setting.all[1].toggle.input.disabled, true, 'images switch');
  for (const id of ['zh-CN', 'en', 'ja', 'ko', 'es']) assert.equal(d.lang(id).toggle.input.disabled, true, id);
  assert.equal(d.lang('zh-TW').toggle, undefined, 'the original row has no switch to lock');
  assert.equal(d.setting('Translation model').dropdown.selectEl.disabled, true);
  d.button('Cancel translation').listeners.click();
  await until(() => d.button(translateLabel) && !d.button(translateLabel).disabled, 'stopped');
  assert.match(d.text(), /Translation cancelled\. Nothing was saved\./);
  assert.equal(d.log.picked, 0);
  assert.equal(d.log.downloads, 0);
  assert.deepEqual(d.exporter.calls.disposed, 0, 'the dialog stayed open');
  assert.equal(d.setting('Translation model').dropdown.selectEl.disabled, false, 'controls are back');
  assert.equal(d.lang('ja').toggle.input.disabled, false);
});

test('share dialog T1: after a cancel the next press translates only what is missing; unchanged settings need 0 calls', async () => {
  const runner = fakeRunner({ delay: 15 });
  const cache = new planModule.ShareTranslationCache();
  const d = dialog({ runner, cache, exporter: fakeExporter({ nodes: manyNodes(40) }) });
  await open(d);
  d.tick('ja');
  const all = d.translation.service.estimate(d.exporter.translationSource({ includeDetail: true, includeImages: true }, 'zh-TW'), ['ja'], { dom: d.translation.dom, cache: new planModule.ShareTranslationCache(), model: 'claude:sonnet', renderMermaid: async () => null }).calls;
  d.button(translateLabel).listeners.click();
  await until(() => runner.state.calls.length >= 3 && cache.size > 0, 'some calls');
  d.button('Cancel translation').listeners.click();
  await until(() => d.button(translateLabel) && !d.button(translateLabel).disabled, 'stopped');
  const done = runner.state.calls.length;
  await sleep(60);
  assert.equal(runner.state.calls.length, done, 'no new call after the cancel');
  assert.ok(done < all, `${done} < ${all}`);
  assert.ok(cache.size > 0, 'finished parts are kept');
  const remaining = d.translation.service.estimate(d.exporter.translationSource({ includeDetail: true, includeImages: true }, 'zh-TW'), ['ja'], { dom: d.translation.dom, cache, model: 'claude:sonnet', renderMermaid: async () => null }).calls;
  assert.ok(remaining > 0 && remaining < all);
  assert.match(d.text(), new RegExp(`About ${remaining} AI calls`), 'the estimate counts the cache');
  d.button(translateLabel).listeners.click();
  await until(() => d.button(saveFileLabel), 'done');
  assert.equal(runner.state.calls.length, done + remaining, 'only the missing batches were sent');
  // Change nothing material (tick off and on again): everything is cached.
  d.untick('ja');
  assert.ok(d.button('Save…'), 'no language: back to the plain save button');
  d.tick('ja');
  assert.match(d.text(), /Everything selected was already translated in this session\. No new AI calls are needed\./);
  const before = runner.state.calls.length;
  d.button(translateLabel).listeners.click();
  await until(() => d.button(saveFileLabel), 'done again');
  assert.equal(runner.state.calls.length, before, '0 new calls');
  assert.equal(d.log.picked, 0);
});

test('share dialog T1: another model translates again and the results list names that model', async () => {
  const runner = fakeRunner();
  const d = dialog({ runner });
  await open(d);
  d.tick('en');
  d.button(translateLabel).listeners.click();
  await until(() => d.button(saveFileLabel), 'done');
  const first = runner.state.calls.length;
  d.setting('Translation model').dropdown.fn('claude:opus');
  assert.ok(d.button(translateLabel), 'changing the model asks to translate again');
  assert.match(d.text(), /\(M\(claude:opus\)\)/);
  d.button(translateLabel).listeners.click();
  await until(() => d.button(saveFileLabel), 'done again');
  assert.ok(runner.state.calls.length > first);
  assert.ok(runner.state.calls.every((call, index) => index < first || call.model === 'claude:opus'));
  assert.match(d.text(), /Model: M\(claude:opus\)/);
  assert.deepEqual(plain(d.confirmLog), ['claude:sonnet', 'claude:opus']);
});

test('share dialog T1: a language that fails completely is left out and the rest is still saved', async () => {
  const runner = fakeRunner({ fail: request => request.targetLanguage === 'ja' });
  const d = dialog({ runner });
  await open(d);
  d.tick('en'); d.tick('ja');
  d.button(translateLabel).listeners.click();
  await until(() => d.button(saveFileLabel), 'done');
  assert.match(d.text(), /日本語: Failed: nothing was translated/);
  assert.match(d.text(), /English: Complete/);
  assert.match(d.text(), /Languages in the file: 繁體中文, English/);
  assert.equal(d.button(saveFileLabel).disabled, false);
  assert.deepEqual(d.exporter.calls.assemble.at(-1).languages, ['en']);
  d.button(saveFileLabel).listeners.click();
  await until(() => d.log.written.length === 1, 'write');
  const file = JSON.parse(d.log.written[0].replace(/^<html>|<\/html>$/g, ''));
  assert.deepEqual(file.languages, ['zh-TW', 'en']);
  assert.equal(file.ja, null);
});

test('share dialog T1: an incomplete language is not written until the box is ticked', async () => {
  const runner = fakeRunner({ drop: (request, item) => request.targetLanguage === 'ko' && Number(item.id) % 2 === 0 });
  const d = dialog({ runner });
  await open(d);
  d.tick('ko'); d.tick('en');
  d.button(translateLabel).listeners.click();
  await until(() => d.button(saveFileLabel), 'done');
  assert.match(d.text(), /한국어: Incomplete: \d+ of \d+ parts stayed in the original language/);
  assert.deepEqual(d.exporter.calls.assemble.at(-1).languages, ['en'], 'not written by default');
  const include = d.setting('한국어: Include in the file anyway') ?? d.setting('한국어');
  assert.ok(include && include.toggle, 'a box to include it');
  assert.equal(include.toggle.value, false);
  include.toggle.fn(true);
  assert.deepEqual(d.exporter.calls.assemble.at(-1).languages, ['en', 'ko']);
  assert.equal(d.log.picked, 0);
});

test('share dialog T1: a translation carrying a vault path or a private link is blocked, cannot be ticked, and writes nothing', async () => {
  const runner = fakeRunner({ transform: (text, language) => (language === 'ja' ? `${text} /Users/me/Vault/Folder/A.md [[Folder/A]]` : `T:${text}`) });
  const d = dialog({ runner });
  await open(d);
  d.tick('en'); d.tick('ja');
  d.button(translateLabel).listeners.click();
  await until(() => d.button(saveFileLabel), 'done');
  assert.match(d.text(), /日本語: Blocked: the translation would contain private information \(/);
  assert.doesNotMatch(d.text(), /Users\/me\/Vault/, 'never shows the matched text');
  assert.equal(d.setting('日本語: Include in the file anyway'), undefined, 'a blocked language has no box');
  assert.deepEqual(d.exporter.calls.assemble.at(-1).languages, ['en']);
  d.button(saveFileLabel).listeners.click();
  await until(() => d.log.written.length === 1, 'write');
  assert.doesNotMatch(d.log.written[0], /Users\/me\/Vault/);
  assert.equal(JSON.parse(d.log.written[0].replace(/^<html>|<\/html>$/g, '')).ja, null);
});

test('share dialog T1: if the whole assembled file still holds private text the save stays off (fail closed)', async () => {
  // A service double that hands back a "complete" language whose text carries a vault path: the dialog's own full scan must catch it.
  const hostile = {
    estimate: () => ({ calls: 1, minutes: 1, perLanguage: [{ language: 'en', calls: 1 }] }),
    translate: async () => ({ calls: 1, cacheHits: 0, languages: [{ language: 'en', model: 'claude:sonnet', status: 'complete', totalSegments: 1, failedSegments: 0, diagramsKept: 0, leakCategories: [], calls: 1, cacheHits: 0, top: { title: 'Safe' }, nodes: { a: { title: 'x', summary: 'see /Users/me/Vault/Folder/A.md' } } }] })
  };
  const d = dialog({ host: { service: hostile } });
  await open(d);
  d.tick('en');
  d.button(translateLabel).listeners.click();
  await until(() => d.button(saveFileLabel), 'done');
  assert.match(d.text(), /Not saved: the file would contain private information/);
  assert.equal(d.button(saveFileLabel).disabled, true);
  d.button(saveFileLabel).listeners.click();
  await sleep(30);
  assert.equal(d.log.picked, 0);
  assert.deepEqual(plain(d.log.written), []);
});

test('share dialog T1: closing the dialog aborts the translation, writes nothing and keeps the finished parts cached', async () => {
  const runner = fakeRunner({ delay: 15 });
  const cache = new planModule.ShareTranslationCache();
  const d = dialog({ runner, cache, exporter: fakeExporter({ nodes: manyNodes(40) }) });
  await open(d);
  d.tick('ja');
  d.button(translateLabel).listeners.click();
  await until(() => runner.state.calls.length >= 3 && cache.size > 0, 'running');
  d.modal.close();
  const at = runner.state.calls.length;
  await sleep(80);
  assert.equal(runner.state.calls.length, at, 'no call after the dialog closed');
  assert.equal(d.log.picked, 0);
  assert.equal(d.log.downloads, 0);
  assert.deepEqual(plain(d.log.written), []);
  assert.equal(d.exporter.calls.disposed, 1);
  assert.ok(cache.size > 0, 'the cache outlives the dialog');
  assert.deepEqual(plain(d.notices), [], 'no "finished" notice for a closed dialog');
});

test('share dialog T1: if the AI is not ready (usage not confirmed) nothing is translated', async () => {
  const d = dialog({ host: { confirmAiUsage: async () => false } });
  await open(d);
  d.tick('en');
  d.button(translateLabel).listeners.click();
  await sleep(40);
  assert.equal(d.runner.state.calls.length, 0);
  assert.ok(d.button(translateLabel) && !d.button(translateLabel).disabled);
  assert.equal(d.log.picked, 0);
});

test('share dialog T1: a runtime error is reported without opening the save window', async () => {
  const d = dialog({ host: { service: { estimate: () => ({ calls: 2, minutes: 1, perLanguage: [] }), translate: async () => { throw new Error('Claude CLI is not installed'); } } } });
  await open(d);
  d.tick('en');
  d.button(translateLabel).listeners.click();
  await until(() => /Translation stopped: Claude CLI is not installed Nothing was saved\./.test(d.text()), 'error text');
  assert.equal(d.log.picked, 0);
  assert.ok(d.button(translateLabel) && !d.button(translateLabel).disabled);
});

test('share dialog T1: structure-only mode sends no note text to translate, and a mode change after translating goes back to the original', async () => {
  const runner = fakeRunner();
  const d = dialog({ runner });
  await open(d);
  d.Setting.all[0].toggle.fn(false);
  await until(() => d.exporter.calls.assemble.length >= 2, 'rebuild');
  d.tick('en');
  assert.deepEqual(d.exporter.calls.sourceOptions.at(-1), { includeDetail: false, includeImages: true });
  d.button(translateLabel).listeners.click();
  await until(() => d.button(saveFileLabel), 'done');
  assert.ok(runner.state.calls.every(call => call.items.every(item => !item.text.includes('段落'))), 'no note body text was sent');
  d.Setting.all[0].toggle.fn(true);
  await until(() => d.button(translateLabel) && !d.button(translateLabel).disabled, 'back to translate');
  assert.deepEqual(d.exporter.calls.assemble.at(-1).languages, [], 'the new file starts without translations');
  assert.equal(d.log.picked, 0);
});

test('share dialog T1: a diagram that does not redraw keeps its original drawing and is reported', async () => {
  const nodes = manyNodes(2, true);
  const exporter = fakeExporter({ nodes, diagramResult: null });
  const d = dialog({ exporter });
  await open(d);
  d.tick('en');
  d.button(translateLabel).listeners.click();
  await until(() => d.button(saveFileLabel), 'done');
  assert.equal(exporter.calls.diagram.length, 1, 'the translated source was handed to the exporter to draw');
  assert.match(exporter.calls.diagram[0].source, /flowchart TD/);
  assert.equal(exporter.calls.diagram[0].aborted, false);
  assert.match(d.text(), /1 diagrams could not be translated and keep their original labels\./);
  d.button(saveFileLabel).listeners.click();
  await until(() => d.log.written.length === 1, 'write');
  assert.equal(JSON.parse(d.log.written[0].replace(/^<html>|<\/html>$/g, '')).svgs, 2, 'both svgs (the author one and the diagram) are still in the translated note');
});

test('share exporter T1: a diagram is found by its place among the final top-level svgs, a note\'s own svg counts', () => {
  const root = html.parse('<p>x</p><svg id="own"><text>a</text></svg><div><svg id="mm"><g><svg id="inner"></svg></g></svg></div><svg id="late"></svg>');
  const segmentsModule = load('experiences/sharing/share-translate-segments.ts');
  const svgs = segmentsModule.topLevelSvgs(root);
  assert.deepEqual(plain(svgs.map(svg => svg.getAttribute('id'))), ['own', 'mm', 'late']);
  const placed = exporterModule.placeDiagrams(svgs, [svgs[1], svgs[2], html.parse('<svg id="removed"></svg>').children[0]], ['flowchart TD\n A-->B', '', 'graph TD\n C-->D']);
  assert.deepEqual(plain(placed), [{ svgIndex: 1, source: 'flowchart TD\n A-->B' }], 'no source or no place: not translated');
});

// ---- reviewer F1: the original language of a "same as the input" map ----
const followMap = title => ({ ...baseMap, title, outputLanguage: 'same-as-input' });

test('share dialog F1: a same-as-input map with a Chinese title has a Traditional Chinese original, English can be added', async () => {
  const d = dialog({ map: followMap('東京五天自由行') });
  await open(d);
  assert.equal(d.lang('zh-TW').name, '繁體中文 (original)');
  assert.equal(d.lang('zh-TW').toggle, undefined, 'the original row has no switch');
  assert.equal(d.lang('en').name, 'English', 'English is a normal, switchable box');
  assert.equal(d.lang('en').toggle.off, false);
  d.tick('en');
  d.button(translateLabel).listeners.click();
  await until(() => d.button(saveFileLabel), 'translation finished');
  assert.ok(d.runner.state.calls.every(call => call.sourceLanguage === 'zh-TW'), 'the prompt names the real original');
  assert.deepEqual(plain(d.exporter.calls.assemble.at(-1).languages), ['en']);
  d.button(saveFileLabel).listeners.click();
  await until(() => d.log.written.length === 1, 'write');
  assert.deepEqual(JSON.parse(d.log.written[0].replace(/^<html>|<\/html>$/g, '')).languages, ['zh-TW', 'en']);
});

test('share dialog F1: a same-as-input map whose language cannot be told lets all six languages be ticked and names no wrong original', async () => {
  const d = dialog({ map: followMap('Ancient Egypt') });
  await open(d);
  const ids = ['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'es'];
  for (const id of ids) {
    assert.equal(d.lang(id).toggle?.off, false, `${id} can be ticked`);
    assert.equal(d.lang(id).toggle.value, false, `${id} starts off`);
    assert.doesNotMatch(d.lang(id).name, /original/i, id);
  }
  assert.doesNotMatch(d.text(), /\(original\)/);
  d.tick('en');
  d.button(translateLabel).listeners.click();
  await until(() => d.button(saveFileLabel), 'translation finished');
  assert.ok(d.runner.state.calls.length > 0 && d.runner.state.calls.every(call => call.sourceLanguage === 'und'), 'the request says the original is undetermined');
  assert.deepEqual(plain(d.exporter.calls.assemble.at(-1).languages), ['en']);
  assert.match(d.text(), /Languages in the file: Original, English/);
  d.button(saveFileLabel).listeners.click();
  await until(() => d.log.written.length === 1, 'write');
  assert.deepEqual(JSON.parse(d.log.written[0].replace(/^<html>|<\/html>$/g, '')).languages, ['und', 'en']);
});

test('share dialog F1: the unknown-original id is the one the viewer reads, and the prompt asks the model to detect it', () => {
  const format = load('experiences/sharing/share-format.ts');
  assert.equal(format.SHARE_UNKNOWN_LANGUAGE, 'und');
  assert.match(require('node:fs').readFileSync(require('node:path').join(__dirname, '../../experiences/sharing/viewer/main.ts'), 'utf8'), /UNKNOWN_ORIGINAL = "und"/);
  const step = load('core/steps/share-translate/step.ts');
  const prompt = step.shareTranslateStep.render({ items: [{ id: '1', text: 'Hola' }], sourceLanguage: 'und', targetLanguage: 'en', model: 'm', reasoning: 'low' });
  assert.match(prompt, /from the original language of the text \(detect it from the text itself\) into English/);
});

// ---- reviewer F1b: title and goal decide; notes only when both have no letter, and only when they agree ----
const originalIs = async (options, id) => {
  const d = dialog(options);
  await open(d);
  const locked = ['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'es'].filter(code => !d.lang(code).toggle);
  assert.deepEqual(locked, id === 'und' ? [] : [id], JSON.stringify(options.map.title));
};

test('share dialog F1b: a German or French title is unknown even when a note is in Chinese or English', async () => {
  await originalIs({ map: followMap('Einführung in die Kartografie'), notes: [{ title: 'Taipei 101 (台北101)' }] }, 'und');
  await originalIs({ map: followMap('Introduction à la cartographie'), notes: [{ title: 'The first chapter of the book' }] }, 'und');
  await originalIs({ map: followMap('Einführung in die Kartografie'), goal: '台北旅行', notes: [] }, 'und');
});

test('share dialog F1b: a Chinese title is Traditional Chinese whatever the notes say; the goal is used when the title has no letter', async () => {
  await originalIs({ map: followMap('東京五天自由行'), notes: [{ title: 'The first chapter of the book' }, { title: 'Les chapitres' }] }, 'zh-TW');
  await originalIs({ map: followMap('2024'), goal: '學會地圖', notes: [{ title: 'The first chapter of the book' }] }, 'zh-TW');
});

test('share dialog F1b: with no letter in title or goal, notes decide only when they all agree', async () => {
  await originalIs({ map: followMap('2024'), notes: [{ title: '東京', summary: '五天自由行' }, { title: '大阪' }] }, 'zh-TW');
  await originalIs({ map: followMap('2024'), notes: [{ title: '東京五天' }, { title: 'The first chapter of the book' }] }, 'und');
  await originalIs({ map: followMap('2024'), notes: [{ title: '東京五天' }, { title: 'Einführung in die Kartografie' }] }, 'und');
  await originalIs({ map: followMap('2024'), notes: [] }, 'und');
});

// ---- D-2026-10-120: "Opens in" is there before translating
const openMenu = d => d.setting('Opens in');
const openValues = d => plain(openMenu(d).dropdown.options.map(item => item[0]));

test('share dialog D-120: the opening-language menu exists before translating, disabled with only the original', async () => {
  const d = dialog();
  await open(d);
  assert.deepEqual(openValues(d), ['auto', 'zh-TW']);
  assert.equal(openMenu(d).disabled, true);
  assert.equal(openMenu(d).dropdown.selectEl.disabled, true);
});

test('share dialog D-120: the options follow the ticked languages at once', async () => {
  const d = dialog();
  await open(d);
  d.tick('ja');
  assert.deepEqual(openValues(d), ['auto', 'zh-TW', 'ja']);
  assert.equal(openMenu(d).disabled, false);
  d.tick('en');
  assert.deepEqual(openValues(d), ['auto', 'zh-TW', 'en', 'ja']);
  d.untick('ja');
  assert.deepEqual(openValues(d), ['auto', 'zh-TW', 'en']);
});

test('share dialog D-120: unticking the chosen language falls back to the reader browser and says so', async () => {
  const d = dialog();
  await open(d);
  d.tick('ja');
  openMenu(d).dropdown.fn('ja');
  d.untick('ja');
  assert.equal(openMenu(d).dropdown.value, 'auto');
  assert.ok(d.notices.some(n => n.includes('日本語') && n.includes('browser language')), plain(d.notices));
});

test('share dialog D-120: after translating there is still one menu and its value is kept', async () => {
  const d = dialog();
  await open(d);
  d.tick('en'); d.tick('ja');
  openMenu(d).dropdown.fn('ja');
  d.button(translateLabel).listeners.click();
  await until(() => d.button(saveFileLabel), 'done');
  assert.equal(d.text().split(' | ').filter(x => x === 'Opens in').length, 1);
  assert.equal(d.exporter.calls.assemble.at(-1).defaultLanguage, 'ja');
});

test('share dialog D-120: choosing the original writes it as defaultLanguage', async () => {
  const d = dialog();
  await open(d);
  d.tick('en');
  openMenu(d).dropdown.fn('zh-TW');
  d.button(translateLabel).listeners.click();
  await until(() => d.button(saveFileLabel), 'done');
  assert.equal(d.exporter.calls.assemble.at(-1).defaultLanguage, 'zh-TW');
  d.button(saveFileLabel).listeners.click();
  await until(() => d.log.written.length === 1, 'write');
  assert.equal(JSON.parse(d.log.written[0].replace(/^<html>|<\/html>$/g, '')).defaultLanguage, 'zh-TW');
});

test('share dialog D-120: a chosen language that was blocked is warned about before saving and the file opens in the original', async () => {
  const d = dialog({ runner: fakeRunner({ transform: (text, target) => target === 'ja' ? `see /Users/me/Vault/Folder/A.md ${text}` : `T:${text}` }) });
  await open(d);
  d.tick('en'); d.tick('ja');
  openMenu(d).dropdown.fn('ja');
  d.button(translateLabel).listeners.click();
  await until(() => d.button(saveFileLabel), 'done');
  assert.equal(d.exporter.calls.assemble.at(-1).defaultLanguage, 'zh-TW', 'falls back to the original');
  const before = d.notices.length;
  d.button(saveFileLabel).listeners.click();
  await until(() => d.log.written.length === 1, 'write');
  assert.ok(d.notices.slice(before).some(n => n.includes('日本語') && n.includes('繁體中文')), plain(d.notices));
  assert.equal(JSON.parse(d.log.written[0].replace(/^<html>|<\/html>$/g, '')).defaultLanguage, 'zh-TW');
});

test('share dialog D-120: an undetermined original (und) is the fallback too: a blocked chosen language warns before saving and defaultLanguage is "und"', async () => {
  const d = dialog({ map: followMap('Ancient Egypt'), runner: fakeRunner({ transform: (text, target) => target === 'ja' ? `see /Users/me/Vault/Folder/A.md ${text}` : `T:${text}` }) });
  await open(d);
  d.tick('en'); d.tick('ja');
  openMenu(d).dropdown.fn('ja');
  d.button(translateLabel).listeners.click();
  await until(() => d.button(saveFileLabel), 'done');
  assert.equal(d.exporter.calls.assemble.at(-1).defaultLanguage, 'und', 'falls back to the undetermined original');
  const before = d.notices.length;
  d.button(saveFileLabel).listeners.click();
  await until(() => d.log.written.length === 1, 'write');
  const shown = d.notices.slice(before);
  assert.ok(shown.some(n => n.includes('日本語') && n.includes('Original') && !n.includes('browser')), plain(shown));
  assert.equal(JSON.parse(d.log.written[0].replace(/^<html>|<\/html>$/g, '')).defaultLanguage, 'und');
});

// ---- compact translated notes (D-2026-10-122): the real exporter's assemble rebuilds and scans what the viewer will show ----
test('share exporter assemble: compact translations are rebuilt from the payload notes and every gate scans the rebuilt text', () => {
  const compact = load('experiences/sharing/share-translate-compact.ts');
  const segs = load('experiences/sharing/share-translate-segments.ts');
  class FileSystemAdapter { getBasePath() { return '/Users/me/Vault'; } }
  const module = load('experiences/sharing/share-exporter.ts', { obsidian: { ...obsidian, FileSystemAdapter, Component: class { load() {} unload() {} addChild() {} removeChild() {} } } });
  const detailHtml = '<p>Salt the water <strong>before</strong> it boils.</p><p>Second paragraph here.</p>';
  const map = { id: 'map-1', title: 'Map', outputLanguage: 'en', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'a', path: 'Folder/A.md', parentId: null, x: 0, y: 0, collapsed: false }] };
  const note = { title: 'A', summary: 'S', status: 'idea', model: '', detail: 'x' };
  const make = () => {
    const exporter = new module.ShareExporter({ vault: { adapter: new FileSystemAdapter(), getName: () => 'V' } }, { map, notes: new Map([['a', note]]), mapPath: 'Folder/Map.md' }, { vamVersion: '1', language: 'en', rebuildDom: { parse: html.parse, serialize: html.serialize, createDiv: () => html.makeDom().createDiv() } });
    exporter.rendered.set('a', { html: detailHtml, diagrams: [], diagramsUnsourced: 0, localRefs: 0, attachments: [], mermaidUndrawn: 0, mermaidBlocked: 0 });
    return exporter;
  };
  const extraction = segs.extractSegments(html.parse(detailHtml));
  const entry = overrides => ({ title: 'A2', summary: 'S2', detailSegments: extraction.units.map(unit => `T:${unit.text}`), detailCheck: compact.detailCheckOf(extraction), ...overrides });
  const withEntry = value => ({ contentLanguage: 'en', pieces: [{ language: 'ja', piece: { top: { title: 'Map2' }, nodes: { a: value } } }] });
  const options = { includeDetail: true, includeImages: false };

  const ok = make().assemble(options, withEntry(entry()));
  assert.deepEqual(plain(ok.leakCategories), []);
  assert.ok(ok.html, 'the file is written');
  assert.equal(ok.payload.nodes[0].translations.ja.detailHtml, undefined, 'no whole-note html travels');
  assert.equal(ok.payload.nodes[0].translations.ja.detailSegments.length, 2);
  // A unit with a wikilink, a patch with the vault path, a stored drawing with a model name: blocked, nothing written.
  const wikilink = make().assemble(options, withEntry(entry({ detailSegments: ['see [[Private]]', 'T:b'] })));
  assert.ok(wikilink.leakCategories.includes('wikilink') && !wikilink.html);
  const patch = make().assemble(options, withEntry(entry({ detailDiagrams: [{ check: 'c', patch: [[1, '/Users/me/Vault/x']] }] })));
  assert.ok(patch.leakCategories.includes('vault-path') && !patch.html);
  // The note changed after translating (a stale check): the compact fields are dropped and the file still builds.
  const stale = make().assemble(options, withEntry(entry({ detailCheck: '9.zzz' })));
  assert.deepEqual(plain(stale.leakCategories), []);
  assert.deepEqual(Object.keys(stale.payload.nodes[0].translations.ja).sort(), ['summary', 'title']);
  // A legacy entry with a whole detailHtml is still scanned like the original text.
  const legacy = make().assemble(options, withEntry({ title: 'A2', summary: 'S2', detailHtml: '<p>see [[Private]]</p>' }));
  assert.ok(legacy.leakCategories.includes('wikilink'));
  // The rebuilt note linking to a local file blocks the file.
  const linked = make();
  linked.rendered.set('a', { html: '<p>See <a href="Diary/secret.md">my diary</a> today.</p>', diagrams: [], diagramsUnsourced: 0, localRefs: 0, attachments: [], mermaidUndrawn: 0, mermaidBlocked: 0 });
  const linkedExtraction = segs.extractSegments(html.parse('<p>See <a href="Diary/secret.md">my diary</a> today.</p>'));
  const blocked = linked.assemble(options, withEntry({ title: 'A2', summary: 'S2', detailSegments: linkedExtraction.units.map(unit => `T:${unit.text}`), detailCheck: compact.detailCheckOf(linkedExtraction) }));
  assert.ok(blocked.leakCategories.includes('wikilink') && !blocked.html);
});
