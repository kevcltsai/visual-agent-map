// Sharing P1 (Worker C): the Obsidian-side export pieces that can run without Obsidian: DOM scrub, build lifecycle,
// size advice, save fallback, and the share dialog's stale/cancel behaviour against a test-double exporter.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, load, obsidian, plain, root: repoRoot } = require('../support.cjs');

const dom = load('experiences/sharing/share-dom.ts');
const build = load('experiences/sharing/share-build.ts');
const save = load('experiences/sharing/share-save.ts');

class FakeEl {
  constructor(tag, attrs = {}, children = [], text = '') {
    this.localName = tag; this.attrs = new Map(Object.entries(attrs)); this.children = []; this.parent = null; this.textContent = text;
    this.ownerDocument = { createElement: name => new FakeEl(name) };
    this.append(...children);
  }
  getAttributeNames() { return [...this.attrs.keys()]; }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  setAttribute(name, value) { this.attrs.set(name, value); }
  removeAttribute(name) { this.attrs.delete(name); }
  get childNodes() { return this.children; }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; } }
  replaceWith(node) { const parent = this.parent; parent.children[parent.children.indexOf(this)] = node; node.parent = parent; this.parent = null; }
}
const el = (tag, attrs, children, text) => new FakeEl(tag, attrs, children, text);
const tags = root => root.children.flatMap(child => [child.localName, ...tags(child)]);

test('share dom: scrub removes script-capable elements, handlers, private URLs and Obsidian chrome; keeps safe content', () => {
  const root = el('div', {}, [
    el('script'), el('iframe', { src: 'https://x.example' }), el('object'), el('form'),
    el('p', { onclick: 'x()', 'data-href': 'Private Note', class: 'a' }),
    el('a', { href: 'https://example.org/a', rel: 'noopener' }), el('a', { href: ' JaVa\nScript:alert(1)' }),
    el('a', { href: 'obsidian://open?vault=V' }), el('a', { href: '#section' }), el('a', { href: 'mailto:a@b.c' }),
    el('img', { src: 'vam-asset:image-1', alt: 'ok' }), el('img', { src: 'app://abc/photo.png' }), el('img', { src: 'file:///Users/x/p.png' }),
    el('img', { src: 'https://example.org/p.jpg', srcset: 'a.png 1x' }), el('img', { src: 'data:image/png;base64,AAAA' }), el('img', { src: 'data:image/svg+xml;base64,AAAA' }),
    el('div', { class: 'callout', 'data-callout': 'note', 'data-line': '3' }),
    el('button', { class: 'copy-code-button' }), el('div', { class: 'x copy-code-button' }),
    el('input', { type: 'checkbox', class: 'task-list-item-checkbox' }), el('input', { type: 'text' }),
    el('span', { style: 'background:url(app://x/y.png)' }), el('span', { style: 'color:red' }),
    el('video'), el('link', { href: 'style.css' }), el('style', {}, [], 'p{}')
  ]);
  const report = dom.scrubShareTree(root);
  const kept = root.children.map(child => `${child.localName}${child.getAttribute('src') ?? child.getAttribute('href') ?? ''}`);
  assert.deepEqual(plain(kept), [
    'p', 'ahttps://example.org/a', 'a', 'a', 'a#section', 'amailto:a@b.c',
    'imgvam-asset:image-1', 'imghttps://example.org/p.jpg', 'imgdata:image/png;base64,AAAA', 'div', 'input', 'span', 'span'
  ]);
  const paragraph = root.children[0];
  assert.deepEqual(plain(paragraph.getAttributeNames()), ['class']);
  assert.equal(root.children[1].getAttribute('srcset'), null);
  assert.equal(root.children[2].getAttribute('href'), null, 'javascript: URL with hidden whitespace is dropped');
  assert.equal(root.children[3].getAttribute('href'), null, 'obsidian:// is dropped');
  const callout = root.children[9];
  assert.deepEqual(plain(callout.getAttributeNames().sort()), ['class', 'data-callout']);
  assert.equal(root.children[10].getAttribute('disabled'), '', 'task checkboxes stay as read-only boxes');
  assert.equal(root.children[11].getAttribute('style'), null);
  assert.equal(root.children[12].getAttribute('style'), 'color:red');
  assert.ok(report.elements >= 10 && report.attributes >= 6);
  assert.ok(!tags(root).some(tag => ['script', 'iframe', 'object', 'form', 'video', 'link', 'style', 'button'].includes(tag)));
});

test('share dom: internal links become plain spans, web and mail links stay', () => {
  const root = el('div', {}, [
    el('p', {}, [el('a', { class: 'internal-link', href: 'Private', 'data-href': 'Private' }, [el('b', {}, [], 'text')])]),
    el('a', { href: 'https://example.org' }), el('a', { href: 'relative/page.md' }), el('a', { href: '#x' }), el('a', { href: 'mailto:a@b.c' })
  ]);
  assert.equal(dom.unwrapLocalLinks(root, () => new FakeEl('span')), 2);
  assert.deepEqual(plain(root.children.map(child => child.localName)), ['p', 'a', 'span', 'a', 'a']);
  assert.equal(root.children[0].children[0].localName, 'span');
  assert.equal(root.children[0].children[0].children[0].localName, 'b', 'link children are kept');
  assert.equal(root.children[2].getAttribute('href'), null);
});

test('share dom: a mermaid SVG keeps its inert style and label markup, and loses scripts, handlers and external references', () => {
  const svg = el('svg', { id: 'm1', viewBox: '0 0 10 10', xmlns: 'http://www.w3.org/2000/svg' }, [
    el('style', {}, [], '#m1{font-family:var(--font-mermaid);fill:#333}#m1 .a{marker-end:url(#arrow)}'),
    el('g', {}, [el('foreignObject', {}, [el('div', { xmlns: 'http://www.w3.org/1999/xhtml', style: 'display:table-cell' }, [el('span', { class: 'nodeLabel' }, [], 'Start')])])]),
    el('script'), el('a', { 'xlink:href': 'https://example.org', onclick: 'x()' }), el('image', { href: 'data:image/png;base64,AAAA' }),
    el('use', { href: '#sym' }), el('use', { href: 'other.svg#sym' })
  ]);
  assert.equal(dom.scrubMermaidSvg(svg), true);
  const names = tags(svg);
  assert.ok(names.includes('style') && names.includes('foreignObject') && names.includes('span'));
  assert.ok(!names.includes('script') && !names.includes('image'));
  assert.equal(svg.children.filter(child => child.localName === 'use').length, 2);
  assert.equal(svg.children.at(-2).getAttribute('href'), '#sym');
  assert.equal(svg.children.at(-1).getAttribute('href'), null, 'only in-document references survive');
  const link = svg.children.find(child => child.localName === 'a');
  assert.equal(link.getAttribute('onclick'), null);

  const hostile = el('svg', {}, [el('style', {}, [], '@import url(https://evil.example/x.css);')]);
  assert.equal(dom.scrubMermaidSvg(hostile), true);
  assert.equal(tags(hostile).includes('style'), false, 'style that loads anything is dropped');
  assert.equal(dom.scrubMermaidSvg(el('div')), false, 'not an svg');
  assert.equal(dom.cssIsInert('a{background:url("app://x/y.png")}'), false);
  assert.equal(dom.cssIsInert('a{fill:url(#g)}'), true);
});

test('share dom D-110: countLocalReferences counts internal links and non-web hrefs, and nothing else', () => {
  const count = (...children) => dom.countLocalReferences(el('div', {}, [el('p', {}, children)]));
  assert.equal(count(el('a', { class: 'internal-link', 'data-href': 'Diary/secret', href: 'Diary/secret' })), 1);
  assert.equal(count(el('a', { class: 'internal-link', 'data-href': 'Diary/secret' })), 1, 'data-href alone');
  assert.equal(count(el('a', { class: 'internal-link', href: 'Diary/secret' })), 1, 'href alone');
  assert.equal(count(el('a', { href: 'Diary/x.md' })), 1);
  assert.equal(count(el('a', { href: 'app://abc/x.md' })), 1);
  assert.equal(count(el('a', { href: 'obsidian://open?vault=V' })), 1);
  assert.equal(count(el('a', { href: ' JaVa\nScript:alert(1)' })), 1);
  assert.equal(count(el('a', { 'xlink:href': 'Diary/x' })), 1, 'svg anchors');
  assert.equal(count(el('span', {}, [el('a', { href: 'Diary/x.md' })])), 1, 'nested');
  assert.equal(count(el('a', { class: 'internal-link', 'data-href': 'Diary/secret' }), el('a', { href: 'Diary/y' })), 2);
  // not counted
  assert.equal(count(el('a', { class: 'internal-link', 'data-href': '#heading', href: '#heading' })), 0, 'in-page heading link');
  assert.equal(count(el('a', { class: 'tag', href: '#tag' })), 0);
  assert.equal(count(el('a', { class: 'footnote-link', href: '#fn-1-abc' })), 0);
  assert.equal(count(el('a', { class: 'external-link', href: 'https://example.org/a' })), 0);
  assert.equal(count(el('a', { href: 'HTTP://example.org' })), 0);
  assert.equal(count(el('a', { href: 'mailto:a@b.c' })), 0);
  assert.equal(count(el('a', { name: 'anchor' })), 0, 'no href');
  assert.equal(count(el('a', { href: '' })), 0, 'empty href');
  assert.equal(count(el('img', { src: 'vam-asset:image-1' })), 0);
  assert.equal(count(el('img', { src: 'Diary/secret.png' })), 0, 'images are not links (the scrub drops unknown sources)');
  assert.equal(dom.countLocalReferences(el('div')), 0);
});

test('share dom D-110: the scrub removes comment nodes, in the tree and inside an SVG', () => {
  const comment = () => ({ nodeType: 8, parent: null, remove() { this.parent.children = this.parent.children.filter(c => c !== this); } });
  // FakeEl keeps children and childNodes together, so a comment node can sit beside the elements.
  const root = el('div', {}, [el('p')]);
  const c1 = comment(); root.append(c1);
  const inner = el('p'); const c2 = comment(); inner.append(c2); root.append(inner);
  const svg = el('svg'); const c3 = comment(); svg.append(c3);
  dom.scrubShareTree(root);
  assert.equal(root.children.includes(c1), false);
  assert.equal(inner.children.includes(c2), false);
  dom.scrubMermaidSvg(svg);
  assert.equal(svg.children.includes(c3), false);
});

test('share build D-110: images only a hidden comment used are not among the note html assets', () => {
  assert.deepEqual(plain(build.assetNamesInHtml('<p><img src="vam-asset:image-1" alt="a"> <img alt="b" src="vam-asset:image-3"><img src="https://x.example/p.png"></p>')), ['image-1', 'image-3']);
  assert.deepEqual(plain(build.assetNamesInHtml('<p>%% ![](vam-asset:image-2) %%</p>')), []);
});

test('share build D-110: any rendered note with a local link blocks a file that carries notes, with the wikilink category', () => {
  const none = [{ localRefs: 0 }, { localRefs: 0 }];
  assert.deepEqual(plain(build.renderedLeakCategories(none, { includeDetail: true })), []);
  assert.deepEqual(plain(build.renderedLeakCategories([{ localRefs: 0 }, { localRefs: 3 }], { includeDetail: true })), ['wikilink']);
  assert.deepEqual(plain(build.renderedLeakCategories(new Map([['a', { localRefs: 1 }]]).values(), { includeDetail: true })), ['wikilink']);
  assert.deepEqual(plain(build.renderedLeakCategories([{ localRefs: 5 }], { includeDetail: false })), [], 'structure-only files carry no note HTML');
  assert.deepEqual(plain(build.renderedLeakCategories([], { includeDetail: true })), []);
});

test('share dom F-D: fallback source comes from the diagram DOM candidates only, in order, blank ones skipped', () => {
  assert.equal(dom.pickMermaidFallbackSource(['graph TD\n  A-->B\n', 'other']), 'graph TD\n  A-->B');
  assert.equal(dom.pickMermaidFallbackSource([null, '  \n', 'graph TD\n  C-->D']), 'graph TD\n  C-->D');
});

test('share dom F-D: no source in the DOM gives an empty string (note only, never Markdown text)', () => {
  assert.equal(dom.pickMermaidFallbackSource([]), '');
  assert.equal(dom.pickMermaidFallbackSource([null, undefined, '']), '');
});

test('share dom F-D: a %% / <!-- --> hidden fence cannot leak: the visible guarded diagram keeps its own source', () => {
  // Models what the exporter does per diagram: the DOM has one visible diagram (guard source "graph TD\n  A-->B");
  // the hidden fence containing PRIVATE_SALARY never reaches the DOM, so it cannot be a candidate.
  const visible = dom.pickMermaidFallbackSource(['graph TD\n  A-->B']);
  assert.equal(visible.includes('PRIVATE_SALARY'), false);
  const callout = dom.pickMermaidFallbackSource(['graph TD\n  inside-callout']);
  assert.equal(callout, 'graph TD\n  inside-callout');
});

test('share exporter F-D: exporter no longer derives mermaid source from Markdown', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../experiences/sharing/share-exporter.ts'), 'utf8');
  assert.equal(/extractMermaidSources/.test(src), false);
  assert.equal(/sources\[/.test(src), false);
});

test('share build: a new build aborts the previous one; cancel makes every ticket stale', async () => {
  const controller = new build.BuildController();
  const first = controller.begin();
  assert.equal(first.isCurrent(), true);
  const waiting = build.pause(first, 5000);
  const second = controller.begin();
  assert.equal(first.isCurrent(), false);
  assert.equal(first.signal.aborted, true);
  assert.equal(second.isCurrent(), true);
  await assert.rejects(waiting, error => build.isStaleBuild(error));
  assert.throws(() => build.assertCurrent(first), error => build.isStaleBuild(error));
  controller.cancel();
  assert.equal(second.isCurrent(), false);
  assert.equal(second.signal.aborted, true);
  await assert.rejects(build.pause(second, 1), error => build.isStaleBuild(error));
  const third = controller.begin();
  assert.equal(third.isCurrent(), true);
  await build.pause(third, 1);
});

test('share build: size advice follows the thresholds, and only suggests dropping images when they are in', () => {
  const limits = { warn: 100, large: 200 };
  assert.deepEqual(plain(build.sizeAdvice(100, true, limits)), { level: 'ok', suggestNoImages: false });
  assert.deepEqual(plain(build.sizeAdvice(101, true, limits)), { level: 'warn', suggestNoImages: false });
  assert.deepEqual(plain(build.sizeAdvice(201, true, limits)), { level: 'large', suggestNoImages: true });
  assert.deepEqual(plain(build.sizeAdvice(201, false, limits)), { level: 'large', suggestNoImages: false });
  assert.equal(build.sizeAdvice(10 * 1024 * 1024 + 1, true).level, 'warn');
  assert.equal(build.sizeAdvice(20 * 1024 * 1024 + 1, true).level, 'large');
  assert.equal(build.formatBytes(512), '512 B');
  assert.equal(build.formatBytes(1536), '1.5 KB');
  assert.equal(build.formatBytes(3 * 1024 * 1024), '3.0 MB');
});

test('share build: image references, relative paths, wikilinks in plain text and file names', () => {
  const md = 'a ![x](vam-asset:image-1) b ![y](vam-asset:image-2) ![web](https://example.org/p.png)';
  assert.deepEqual(plain(build.assetNamesIn(md)), ['image-1', 'image-2']);
  assert.equal(build.replaceAssetRefs(md, new Set(['image-2']), '[gone]'), 'a ![x](vam-asset:image-1) b [gone] ![web](https://example.org/p.png)');
  const html = '<p><img alt="x" src="vam-asset:image-1" referrerpolicy="no-referrer"><img src="vam-asset:image-2"><img src="https://example.org/p.png"></p>';
  assert.equal(build.omitAssetImages(html, null, '[n/a <b>]'), '<p><span class="vam-image-omitted">[n/a &lt;b&gt;]</span><span class="vam-image-omitted">[n/a &lt;b&gt;]</span><img src="https://example.org/p.png"></p>');
  assert.equal(build.omitAssetImages(html, new Set(['image-2']), 'X').match(/vam-image-omitted/g).length, 1);
  assert.equal(build.omitAssetImages(html, new Set(), 'X'), html);
  assert.equal(build.resolveRelative('A/B/Notes', '../Attachments/p.png'), 'A/B/Attachments/p.png');
  assert.equal(build.resolveRelative('', 'Attachments/p.png'), 'Attachments/p.png');
  assert.equal(build.resolveRelative('A', '../../p.png'), null);
  assert.equal(build.plainWikilinks('See [[Folder/Note|the note]] and [[Other#Part]] and [[Plain]]'), 'See the note and Other and Plain');
  assert.equal(build.shareFileName('Plan: A/B?'), 'Plan A B.html');
  assert.equal(build.shareFileName('  '), 'map.html');
  assert.equal(build.shareFileName('..hidden'), 'hidden.html');
});

const saveEnv = overrides => {
  const log = { written: [], downloads: [], revoked: [] };
  const env = {
    triggerDownload: (url, name) => log.downloads.push({ href: url, name }),
    createObjectURL: () => 'blob:test', revokeObjectURL: url => log.revoked.push(url), setTimeout: handler => handler(),
    ...overrides
  };
  return { env, log };
};
const picker = log => async options => { log.picked = options; return { createWritable: async () => ({ async write(blob) { log.written.push(await blob.text()); }, async close() { log.closed = true; } }) }; };

test('share save: the system dialog is used first; a cancelled dialog writes nothing; other refusals fall back to a download', async () => {
  let { env, log } = saveEnv({});
  env.showSaveFilePicker = picker(log);
  assert.equal(await save.saveShareFile('<html>1</html>', 'a.html', () => true, env), 'saved');
  assert.deepEqual(plain(log.written), ['<html>1</html>']);
  assert.equal(log.picked.suggestedName, 'a.html');
  assert.equal(log.closed, true);

  ({ env, log } = saveEnv({}));
  env.showSaveFilePicker = async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); };
  assert.equal(await save.saveShareFile('x', 'a.html', () => true, env), 'cancelled');
  assert.deepEqual(plain(log.downloads), []);

  ({ env, log } = saveEnv({}));
  env.showSaveFilePicker = async () => { throw Object.assign(new Error('Must be handling a user gesture'), { name: 'SecurityError' }); };
  assert.equal(await save.saveShareFile('x', 'a.html', () => true, env), 'downloaded');
  assert.deepEqual(plain(log.downloads), [{ href: 'blob:test', name: 'a.html' }]);
  assert.deepEqual(plain(log.revoked), ['blob:test']);

  ({ env, log } = saveEnv({}));
  assert.equal(await save.saveShareFile('x', 'b.html', () => true, env), 'downloaded', 'no picker at all');
});

test('share save: nothing is written when the dialog was closed while the system dialog was open', async () => {
  let { env, log } = saveEnv({});
  env.showSaveFilePicker = picker(log);
  assert.equal(await save.saveShareFile('x', 'a.html', () => false, env), 'cancelled');
  assert.deepEqual(plain(log.written), []);
  ({ env, log } = saveEnv({}));
  assert.equal(await save.saveShareFile('x', 'a.html', () => false, env), 'cancelled');
  assert.deepEqual(plain(log.downloads), []);
});

// ---- the dialog ----

function modalHarness({ exporter, thresholds, saveEnvironment, writeClipboard } = {}) {
  const element = (tag, options = {}) => ({
    tag, text: options.text ?? '', cls: options.cls ?? '', disabled: false, children: [], listeners: {},
    createDiv(value) { const c = element('div', typeof value === 'string' ? { cls: value } : value); this.children.push(c); return c; },
    createEl(name, value = {}) { const c = element(name, typeof value === 'string' ? { cls: value } : value); this.children.push(c); return c; },
    createSpan(value = {}) { const c = element('span', value); this.children.push(c); return c; },
    empty() { this.children = []; this.text = ''; }, setText(value) { this.text = value; }, setAttr() {}, addClass() {}, addEventListener(name, fn) { this.listeners[name] = fn; }
  });
  const find = (root, predicate) => predicate(root) ? root : root.children.map(c => find(c, predicate)).find(Boolean);
  const all = (root, predicate) => [...(predicate(root) ? [root] : []), ...root.children.flatMap(c => all(c, predicate))];
  const notices = [];
  class Modal { constructor(app) { this.app = app; this.titleEl = element('title'); this.contentEl = element('content'); this.modalEl = element('modal'); this.modalEl.children.push(this.contentEl); }
    open() { this.onOpen(); } close() { this.onClose(); } }
  class Setting {
    constructor(parent) { this.row = parent.createDiv('setting'); Setting.all.push(this); this.disabled = false; }
    setName(v) { this.name = v; return this; } setDesc() { return this; } setDisabled(v) { this.disabled = v; return this; }
    addToggle(cb) { const input = { disabled: false }; const toggle = { value: false, input, off: false, toggleEl: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, querySelector: () => input }, setDisabled(v) { this.off = v; return this; }, setValue(v) { this.value = v; return this; }, onChange(fn) { this.fn = fn; return this; } }; this.toggle = toggle; cb(toggle); return this; }
  }
  Setting.all = [];
  class Notice { constructor(text) { notices.push(text); } }
  const mod = load('experiences/sharing/share-modal.ts', { obsidian: { ...obsidian, Modal, Setting, Notice } });
  const source = { map: { id: 'm', title: 'My: Map', nodes: [{ id: 'a' }, { id: 'b' }] }, notes: new Map(), mapPath: 'Folder/Map.md' };
  const modal = new mod.ShareModal({}, { source, vamVersion: '0.25.0', language: 'en', sizeThresholds: thresholds, saveEnvironment, writeClipboard, createExporter: () => exporter });
  const button = text => find(modal.modalEl, i => i.tag === 'button' && i.text === text);
  const text = () => all(modal.contentEl, i => i.text).map(i => i.text).concat(all(modal.modalEl, i => i.text).map(i => i.text)).join(' | ');
  return { modal, Setting, button, text, notices, find, all };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 8));
const stale = load('experiences/sharing/share-build.ts');
const okResult = (overrides = {}) => ({ payload: {}, html: '<html>file</html>', bytes: 1536, counts: { topics: 2, notesWithContent: 1, images: 1 }, leakCategories: [], leakTopics: [], failedImages: 0, mermaidUndrawn: 0, mermaidBlocked: 0, ...overrides });
function fakeExporter({ results = [], gate } = {}) {
  const calls = { render: 0, images: 0, assemble: [], disposed: 0 };
  const exporter = {
    calls,
    async ensureRendered(ticket) { calls.render++; if (gate) await gate(); if (!ticket.isCurrent()) throw new stale.StaleBuildError(); },
    async ensureImages(ticket) { calls.images++; if (gate) await gate(); if (!ticket.isCurrent()) throw new stale.StaleBuildError(); },
    assemble(options) { calls.assemble.push(plain(options)); return results.shift() ?? okResult(); },
    dispose() { calls.disposed++; }
  };
  return exporter;
}

test('share dialog: builds a preview with counts and exact size, defaults to full notes with images, and saves the exact file text', async () => {
  const log = { written: [] };
  const { env } = saveEnv({});
  env.showSaveFilePicker = picker(log);
  const exporter = fakeExporter();
  const h = modalHarness({ exporter, saveEnvironment: env });
  h.modal.open();
  assert.equal(h.button('Save…').disabled, true, 'nothing to save while the build runs');
  await tick(); await tick();
  assert.deepEqual(exporter.calls.assemble, [{ includeDetail: true, includeImages: true }]);
  assert.match(h.text(), /2 topics · 1 with note content · 1 images/);
  assert.match(h.text(), /File size: 1\.5 KB/);
  assert.match(h.text(), /Some email services block HTML attachments/);
  assert.equal(h.button('Save…').disabled, false);
  h.button('Save…').listeners.click();
  await tick(); await tick();
  assert.deepEqual(plain(log.written), ['<html>file</html>']);
  assert.deepEqual(plain(h.notices), ['Saved My Map.html (1.5 KB)']);
  assert.ok(h.button('Close'), 'the Cancel button becomes Close after saving');
});

test('share dialog: flipping a switch starts a new build and the older build never shows its result', async () => {
  let release;
  const gate = () => new Promise(resolve => { release = resolve; });
  const exporter = fakeExporter({ results: [okResult({ bytes: 2048 }), okResult({ bytes: 4096 })], gate });
  const h = modalHarness({ exporter });
  h.modal.open();
  await tick();
  const firstRelease = release;
  const imagesToggle = h.Setting.all[1].toggle;
  imagesToggle.fn(false);
  await tick();
  firstRelease();
  await tick();
  release();
  await tick(); await tick();
  assert.deepEqual(exporter.calls.assemble, [{ includeDetail: true, includeImages: false }], 'the first build was dropped before it assembled anything');
  assert.match(h.text(), /File size: 2\.0 KB/);
  assert.doesNotMatch(h.text(), /4\.0 KB/);
  h.Setting.all[0].toggle.fn(false);
  await tick(); await tick();
  assert.deepEqual(exporter.calls.assemble.at(-1), { includeDetail: false, includeImages: false });
  assert.equal(h.Setting.all[1].disabled, true, 'images switch is off-limits without notes');
});

test('share dialog: closing during a build cancels it, removes the exporter and writes nothing', async () => {
  const log = { written: [] };
  const { env } = saveEnv({});
  env.showSaveFilePicker = picker(log);
  let release;
  const exporter = fakeExporter({ gate: () => new Promise(resolve => { release = resolve; }) });
  const h = modalHarness({ exporter, saveEnvironment: env });
  h.modal.open();
  await tick();
  h.modal.close();
  release();
  await tick(); await tick();
  assert.equal(exporter.calls.disposed, 1);
  assert.deepEqual(exporter.calls.assemble, [], 'a build that finishes after close does not assemble');
  assert.deepEqual(plain(log.written), []);
  assert.deepEqual(plain(h.notices), []);
});

test('share dialog: closing while the system save dialog is open writes nothing', async () => {
  const log = { written: [] };
  let answer;
  const { env } = saveEnv({});
  env.showSaveFilePicker = () => new Promise(resolve => { answer = () => resolve({ createWritable: async () => ({ async write(blob) { log.written.push(await blob.text()); }, async close() {} }) }); });
  const h = modalHarness({ exporter: fakeExporter(), saveEnvironment: env });
  h.modal.open();
  await tick(); await tick();
  h.button('Save…').listeners.click();
  await tick();
  h.modal.close();
  answer();
  await tick(); await tick();
  assert.deepEqual(plain(log.written), []);
  assert.deepEqual(plain(h.notices), []);
});

test('share dialog: a leak hit blocks saving, names only the category, and shows no file size', async () => {
  const exporter = fakeExporter({ results: [okResult({ html: undefined, bytes: 0, leakCategories: ['vault-path', 'note-path'] })] });
  const h = modalHarness({ exporter });
  h.modal.open();
  await tick(); await tick();
  assert.match(h.text(), /Not saved: the file would contain private information \(the vault's location on this computer, a note's file path\)\. Remove that content from the source notes/, 'the reason, and the next step (the copy changed with share-error-no-reason-no-next-step)');
  assert.doesNotMatch(h.text(), /vault-path|note-path/, 'category ids are localized, never shown raw');
  assert.doesNotMatch(h.text(), /File size/);
  assert.equal(h.button('Save…').disabled, true);
});

test('share dialog: size notices appear at the injected thresholds, the no-images tip only while images are in', async () => {
  const thresholds = { warn: 1000, large: 2000 };
  const exporter = fakeExporter({ results: [okResult({ bytes: 1500 }), okResult({ bytes: 2500 }), okResult({ bytes: 2500 })] });
  const h = modalHarness({ exporter, thresholds });
  h.modal.open();
  await tick(); await tick();
  assert.match(h.text(), /larger than 1000 B/);
  assert.doesNotMatch(h.text(), /Turning off Include images/);
  h.Setting.all[0].toggle.fn(true);
  await tick(); await tick();
  assert.match(h.text(), /Turning off Include images makes it much smaller/);
  h.Setting.all[1].toggle.fn(false);
  await tick(); await tick();
  assert.doesNotMatch(h.text(), /Turning off Include images/);
  assert.match(h.text(), /larger than 1000 B/);
});

test('share dialog: image and diagram problems are reported, and a failed build says so without details', async () => {
  const exporter = fakeExporter({ results: [okResult({ failedImages: 2, mermaidBlocked: 1, mermaidUndrawn: 3 })] });
  const h = modalHarness({ exporter });
  h.modal.open();
  await tick(); await tick();
  assert.match(h.text(), /2 images could not be read/);
  assert.match(h.text(), /1 diagrams are shown as source text because Mermaid is not allowed/);
  assert.match(h.text(), /3 diagrams did not finish drawing in time/);

  const broken = fakeExporter();
  broken.assemble = () => { throw new Error('/Users/someone/private/path'); };
  const h2 = modalHarness({ exporter: broken });
  h2.modal.open();
  await tick(); await tick();
  assert.match(h2.text(), /The file could not be prepared/);
  assert.doesNotMatch(h2.text(), /someone/);
  assert.equal(h2.button('Save…').disabled, true);
});

test('share dom: foreignObject content in a mermaid SVG loses scripts, frames, handlers, script URLs and remote loads', () => {
  const svg = el('svg', { viewBox: '0 0 10 10' }, [
    el('g', {}, [el('foreignObject', { onload: 'x()' }, [
      el('div', { xmlns: 'http://www.w3.org/1999/xhtml', onmouseover: 'x()' }, [
        el('span', { class: 'nodeLabel' }, [], 'Start'),
        el('script'), el('iframe', { src: 'https://evil.example' }), el('object', { data: 'https://evil.example' }), el('embed', { src: 'https://evil.example' }),
        el('img', { src: 'https://tracker.example/p.gif', onerror: 'x()' }), el('img', { src: 'javascript:alert(1)' }), el('img', { src: 'data:image/png;base64,AAAA' }),
        el('a', { href: 'javascript:alert(1)' }), el('a', { href: 'https://example.org' }, [], 'ok'),
        el('div', { style: 'background:url(https://evil.example/x.png)' }),
        el('svg', {}, [el('use', { href: 'https://evil.example/s.svg#a' }), el('script'), el('animate', { href: '#x' })])
      ])
    ])])
  ]);
  assert.equal(dom.scrubMermaidSvg(svg), true);
  const names = tags(svg);
  for (const banned of ['script', 'iframe', 'object', 'embed', 'animate']) assert.ok(!names.includes(banned), banned);
  assert.ok(names.includes('foreignObject') && names.includes('span'), 'labels survive');
  const find = (root, tag) => root.children.flatMap(c => [...(c.localName === tag ? [c] : []), ...find(c, tag)]);
  assert.equal(find(svg, 'foreignObject')[0].getAttribute('onload'), null);
  assert.equal(find(svg, 'div')[0].getAttribute('onmouseover'), null);
  const images = find(svg, 'img');
  assert.equal(images.length, 1, 'remote and script images are removed');
  assert.match(images[0].getAttribute('src'), /^data:image\/png/);
  const links = find(svg, 'a');
  assert.equal(links[0].getAttribute('href'), null);
  assert.equal(links[1].getAttribute('href'), 'https://example.org', 'plain web links stay clickable');
  assert.equal(find(svg, 'div')[1].getAttribute('style'), null, 'style that fetches is dropped');
  assert.equal(find(svg, 'use')[0].getAttribute('href'), null, 'no remote use reference');
});

test('share build: problem counts follow the chosen mode', () => {
  const raw = { notesWithContent: 4, failedImages: 2 };
  assert.deepEqual(plain(build.scopeCountsToMode({ includeDetail: true, includeImages: true }, raw)), raw);
  assert.deepEqual(plain(build.scopeCountsToMode({ includeDetail: true, includeImages: false }, raw)), { notesWithContent: 4, failedImages: 0 });
  assert.deepEqual(plain(build.scopeCountsToMode({ includeDetail: false, includeImages: true }, raw)), { notesWithContent: 0, failedImages: 0 });
});

test('share dialog: with full notes off the Include images switch is really disabled, not just styled', async () => {
  const exporter = fakeExporter();
  const h = modalHarness({ exporter });
  h.modal.open();
  await tick(); await tick();
  const images = h.Setting.all[1];
  assert.equal(images.toggle.input.disabled, false);
  assert.equal(images.toggle.off, false);
  h.Setting.all[0].toggle.fn(false);
  await tick(); await tick();
  assert.equal(images.disabled, true);
  assert.equal(images.toggle.off, true);
  assert.equal(images.toggle.input.disabled, true, 'the checkbox input itself is disabled');
  assert.equal(images.toggle.toggleEl.attrs.tabindex, '-1', 'disabled switch is out of the Tab order');
  h.Setting.all[0].toggle.fn(true);
  await tick(); await tick();
  assert.equal(images.toggle.input.disabled, false);
  assert.equal(images.toggle.toggleEl.attrs.tabindex, '0', 'Tab order restored when enabled again');
});

test('share dialog: the download fallback does not claim where the file went', async () => {
  const { env } = saveEnv({});
  const exporter = fakeExporter();
  const h = modalHarness({ exporter, saveEnvironment: env });
  h.modal.open();
  await tick(); await tick();
  h.button('Save…').listeners.click();
  await tick(); await tick();
  const message = h.notices.at(-1);
  assert.match(message, /My Map\.html/);
  assert.doesNotMatch(message, /downloads? folder/i);
  assert.match(message, /save window/i);
  for (const lang of ['zh-TW', 'zh-CN']) assert.doesNotMatch(load('i18n.ts').translate(lang, 'share.downloaded_0_1', 'a', 'b'), /下載資料夾|下载文件夹/);
});

// ---- W-E: copy the "publish to GitHub" instructions (D-2026-10-117) ----
const publishCopy = 'Copy the GitHub publishing instructions';
async function savedHarness(extra = {}) {
  const { env } = saveEnv({});
  const h = modalHarness({ exporter: fakeExporter(), saveEnvironment: env, ...extra });
  h.modal.open();
  await tick(); await tick();
  return h;
}
const saveNow = async h => { h.button('Save…').listeners.click(); await tick(); await tick(); };

test('share publish: no copy button before saving, one after (download path)', async () => {
  const h = await savedHarness();
  assert.equal(h.button(publishCopy), undefined);
  await saveNow(h);
  assert.ok(h.button(publishCopy));
  assert.match(h.text(), /VAM does not go online or upload anything/);
});

test('share publish: also present after the system-dialog save path', async () => {
  const log = { written: [] };
  const { env } = saveEnv({});
  env.showSaveFilePicker = picker(log);
  const h = modalHarness({ exporter: fakeExporter(), saveEnvironment: env });
  h.modal.open(); await tick(); await tick();
  assert.equal(h.button(publishCopy), undefined);
  await saveNow(h);
  assert.equal(log.written.length, 1);
  assert.ok(h.button(publishCopy));
});

test('share publish: a cancelled save shows no copy button', async () => {
  const { env } = saveEnv({});
  env.showSaveFilePicker = async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; };
  const h = modalHarness({ exporter: fakeExporter(), saveEnvironment: env });
  h.modal.open(); await tick(); await tick();
  await saveNow(h);
  assert.equal(h.button(publishCopy), undefined);
});

test('share publish: copying writes the i18n instructions with the path placeholder kept (the path is never known), and notices', async () => {
  const written = [];
  const h = await savedHarness({ writeClipboard: async text => { written.push(text); } });
  await saveNow(h);
  h.button(publishCopy).listeners.click();
  await tick();
  assert.deepEqual(written, [load('i18n.ts').translate('en', 'share.publish_instructions', '[path]')]);
  assert.match(written[0], /Share file path: \[path\]/);
  assert.equal(h.notices.at(-1), 'Instructions copied. Paste them into your own Claude Code or Codex.');
});

test('share publish: clipboard failure tells the user and falls back to a selectable text block', async () => {
  const h = await savedHarness({ writeClipboard: async () => { throw new Error('denied'); } });
  await saveNow(h);
  assert.equal(h.all(h.modal.modalEl, i => i.tag === 'textarea').length, 0);
  h.button(publishCopy).listeners.click();
  await tick();
  assert.match(h.notices.at(-1), /Could not copy automatically/);
  const area = h.all(h.modal.modalEl, i => i.tag === 'textarea');
  assert.equal(area.length, 1);
  assert.equal(area[0].text, load('i18n.ts').translate('en', 'share.publish_instructions', '[path]'));
});

test('share publish: a known path is filled in; unknown stays a placeholder (helper)', () => {
  const { publishInstructions } = load('experiences/sharing/share-publish.ts');
  assert.match(publishInstructions('/Users/me/Desktop/My Map.html'), /Share file path: \/Users\/me\/Desktop\/My Map\.html\n/);
  assert.match(publishInstructions(), /Share file path: \[path\]\n/);
  assert.match(publishInstructions('   '), /Share file path: \[path\]\n/);
});

test('share publish: instructions per language, zh-TW is the owner baseline verbatim, nothing hard-coded to an account', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const i18n = load('i18n.ts');
  const baseline = fs.readFileSync(path.resolve(__dirname, '../fixtures/sharing/publish-instructions.zh-TW.txt'), 'utf8');
  assert.equal(i18n.translate('zh-TW', 'share.publish_instructions', '<路徑>'), baseline);
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const text = i18n.translate(lang, 'share.publish_instructions', 'P');
    assert.doesNotMatch(text, /kevcltsai/i, lang);
    assert.match(text, /gh api -X POST repos\/[<\[][^>\]]+[>\]]\/vam-shared-maps\/pages -f "source\[branch\]=main" -f "source\[path\]=\/"/, lang);
    assert.match(text, /\.nojekyll/, lang);
    assert.match(text, /maps\//, lang);
    assert.match(text, /https:\/\/[<\[][^>\]]+[>\]]\.github\.io\/vam-shared-maps\/maps\/[<\[]/, lang);
    assert.match(text, /\bP\n/, lang);
    assert.notEqual(i18n.translate(lang, 'share.publish_note'), i18n.translate(lang === 'en' ? 'zh-TW' : 'en', 'share.publish_note'));
  }
  assert.match(i18n.translate('zh-TW', 'share.publish_instructions', 'P'), /<我的帳號>/);
});

// Ticket 33 P4: the exporter hands the note's markers to the payload.
test('share exporter assemble: a note\'s markers reach the payload node, a note without markers adds no key', () => {
  class FileSystemAdapter { getBasePath() { return '/Users/me/Vault'; } }
  const module = load('experiences/sharing/share-exporter.ts', { obsidian: { ...obsidian, FileSystemAdapter, Component: class { load() {} unload() {} addChild() {} removeChild() {} } } });
  const map = { id: 'map-1', title: 'Map', outputLanguage: 'en', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'a', path: 'Folder/A.md', parentId: null, x: 0, y: 0, collapsed: false }, { id: 'b', path: 'Folder/B.md', parentId: 'a', x: 0, y: 0, collapsed: false }] };
  const notes = new Map([['a', { title: 'A', summary: 'S', status: 'idea', model: '', markers: ['done', 'priority-2'] }], ['b', { title: 'B', summary: 'S', status: 'idea', model: '' }]]);
  const exporter = new module.ShareExporter({ vault: { adapter: new FileSystemAdapter(), getName: () => 'V' } }, { map, notes, mapPath: 'Folder/Map.md' }, { vamVersion: '1', language: 'en' });
  const result = exporter.assemble({ includeDetail: false, includeImages: false });
  assert.deepEqual(plain(result.leakCategories), []);
  assert.deepEqual(plain(result.payload.nodes[0].markers), ['done', 'priority-2']);
  assert.equal('markers' in result.payload.nodes[1], false);
  assert.equal(result.payload.version, 1);
});

test('share exporter: a blocked file names the topics whose text set off the leak gate, a clean file names none', () => {
  class FileSystemAdapter { getBasePath() { return '/Users/me/Vault'; } }
  const module = load('experiences/sharing/share-exporter.ts', { obsidian: { ...obsidian, FileSystemAdapter, Component: class { load() {} unload() {} addChild() {} removeChild() {} } } });
  const map = { id: 'map-1', title: 'Map', outputLanguage: 'en', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'a', path: 'Folder/A.md', parentId: null, x: 0, y: 0, collapsed: false }, { id: 'b', path: 'Folder/B.md', parentId: 'a', x: 0, y: 0, collapsed: false }] };
  const run = summary => new module.ShareExporter({ vault: { adapter: new FileSystemAdapter(), getName: () => 'V' } }, { map, notes: new Map([['a', { title: 'Alpha', summary: 'S', status: 'idea', model: '' }], ['b', { title: 'Matrices', summary, status: 'idea', model: '' }]]), mapPath: 'Folder/Map.md' }, { vamVersion: '1', language: 'en' }).assemble({ includeDetail: false, includeImages: false });
  const blocked = run('stretch, see [[Private plan');
  assert.deepEqual(plain(blocked.leakCategories), ['wikilink']);
  assert.deepEqual(plain(blocked.leakTopics), [{ title: 'Matrices', excerpt: 'stretch, see [[Private plan' }]);
  assert.equal(blocked.html, undefined);
  assert.deepEqual(plain(run('clean').leakTopics), []);
  const matrix = run('stretch with [[2,0],[0,1]]');
  assert.deepEqual(plain(matrix.leakCategories), [], 'a matrix is not link text');
  assert.equal(typeof matrix.html, 'string');
});

test('share dialog: a leak warning also says where: the topic and the text around the hit', async () => {
  const exporter = fakeExporter({ results: [okResult({ html: undefined, bytes: 0, leakCategories: ['wikilink'], leakTopics: [{ title: 'Linear algebra', excerpt: '…uses [[2,0],[0,1]] to stretch…' }, { title: 'Topology' }] })] });
  const h = modalHarness({ exporter });
  h.modal.open();
  await tick(); await tick();
  assert.match(h.text(), /In topic “Linear algebra”: …uses \[\[2,0\],\[0,1\]\] to stretch…/);
  assert.match(h.text(), /In topic “Topology”/);
  assert.equal(h.button('Save…').disabled, true);
});

// Ticket 37 P3: the exporter hands the note's colour to the payload.
test('share exporter topic-color: a note\'s colour reaches the payload node, a note without colour adds no key', () => {
  class FileSystemAdapter { getBasePath() { return '/Users/me/Vault'; } }
  const module = load('experiences/sharing/share-exporter.ts', { obsidian: { ...obsidian, FileSystemAdapter, Component: class { load() {} unload() {} addChild() {} removeChild() {} } } });
  const map = { id: 'map-1', title: 'Map', outputLanguage: 'en', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'a', path: 'Folder/A.md', parentId: null, x: 0, y: 0, collapsed: false }, { id: 'b', path: 'Folder/B.md', parentId: 'a', x: 0, y: 0, collapsed: false }] };
  const notes = new Map([['a', { title: 'A', summary: 'S', status: 'idea', model: '', color: 'green' }], ['b', { title: 'B', summary: 'S', status: 'idea', model: '' }]]);
  const exporter = new module.ShareExporter({ vault: { adapter: new FileSystemAdapter(), getName: () => 'V' } }, { map, notes, mapPath: 'Folder/Map.md' }, { vamVersion: '1', language: 'en' });
  const result = exporter.assemble({ includeDetail: false, includeImages: false });
  assert.equal(result.payload.nodes[0].color, 'green');
  assert.equal('color' in result.payload.nodes[1], false);
  assert.equal(result.payload.version, 1);
});

test('hypothesis-leaning: the share scrub drops the front-matter block, so hypothesis-leaning and hypothesis-strength never reach a shared page', () => {
  const root = el('div', {}, [
    el('div', { class: 'frontmatter-container' }, [el('span', {}, [], 'hypothesis-leaning supported')]),
    el('div', { class: 'metadata-container' }, [], 'hypothesis-strength: strong'),
    el('p', {}, [], 'Body')
  ]);
  dom.scrubShareTree(root);
  assert.deepEqual(plain(root.children.map(c => c.localName)), ['p']);
  assert.ok(!JSON.stringify(plain(tags(root))).includes('hypothesis'));
});

// Book any-site images P3 (L5): the exporter leaves a dropped picture out of the file and never touches the note.
test('share exporter dropFigures: a dropped picture has no trace in the built html and the note bytes are unchanged; cleared, it is back', async () => {
  class FileSystemAdapter { getBasePath() { return '/Users/me/Vault'; } }
  const module = load('experiences/sharing/share-exporter.ts', { obsidian: { ...obsidian, FileSystemAdapter, Component: class { load() {} unload() {} addChild() {} removeChild() {} } } });
  const check = load('experiences/sharing/share-image-check.ts');
  const detail = '正文一。\n\n![羅盤圖](https://cdn.dropped-host.example/a.png)\n一句圖說\n來源：dropped-host.example · © x（[連結](https://dropped-host.example/p)）\n\n![開放圖](https://upload.wikimedia.org/a.png)\n另一句\n來源：commons.wikimedia.org · CC BY 4.0（[連結](https://commons.wikimedia.org/wiki/File:a.png)）\n\n正文二。\n';
  const map = { id: 'map-1', title: 'Map', outputLanguage: 'en', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'a', path: 'Folder/A.md', parentId: null, x: 0, y: 0, collapsed: false }] };
  const notes = new Map([['a', { title: 'A', summary: 'S', status: 'idea', model: '', detail }]]);
  const exporter = new module.ShareExporter({ vault: { adapter: new FileSystemAdapter(), getName: () => 'V' } }, { map, notes, mapPath: 'Folder/Map.md' }, { vamVersion: '1', language: 'en' });
  exporter.renderOne = async markdown => ({ html: markdown, diagrams: [], diagramsUnsourced: 0, localRefs: 0, attachments: [], mermaidUndrawn: 0, mermaidBlocked: 0 });
  const ticket = { generation: 0, signal: new AbortController().signal, isCurrent: () => true };
  const build = async () => { await exporter.ensureRendered(ticket, () => {}); return exporter.assemble({ includeDetail: true, includeImages: false }); };
  const dropIndex = check.figuresOf(detail).find(f => f.host === 'dropped-host.example').index;
  exporter.dropFigures(new Map([['a', new Set([dropIndex])]]));
  const dropped = await build();
  assert.ok(!dropped.html.includes('dropped-host.example'), 'no trace of the dropped host anywhere in the file');
  assert.ok(!dropped.html.includes('羅盤圖'));
  assert.ok(dropped.html.includes('upload.wikimedia.org'), 'the other picture stays');
  assert.equal(notes.get('a').detail, detail, 'the note bytes are unchanged');
  exporter.dropFigures(new Map());
  const back = await build();
  assert.ok(back.html.includes('dropped-host.example'), 'cleared: the picture is back');
});

// Persona G22: a card's cover picture lives in the note's front matter, not in its detail; it must be counted and travel in the file.
test('share exporter covers: a topic-cover picture is collected, counted and embedded in the shared html; a cover-only card and an already-embedded cover too', async () => {
  class FileSystemAdapter { getBasePath() { return '/Users/me/Vault'; } }
  const module = load('experiences/sharing/share-exporter.ts', { obsidian: { ...obsidian, FileSystemAdapter, Component: class { load() {} unload() {} addChild() {} removeChild() {} } } });
  const clean = load('experiences/sharing/share-clean.ts');
  const node = (id, parentId) => ({ id, path: `Folder/${id}.md`, parentId, x: 0, y: 0, collapsed: false });
  const map = { id: 'map-1', title: 'Map', outputLanguage: 'en', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('a', null), node('b', 'a'), node('c', 'a'), node('d', 'a')] };
  const note = (title, detail) => ({ title, summary: 'S', status: 'idea', model: '', ...(detail ? { detail } : {}) });
  const notes = new Map([
    ['a', note('A', 'Body of A')],
    ['b', note('B')],
    ['c', note('C', '![[Pics/own.png]]\n\nBody of C')],
    ['d', note('D', 'Body of D')]
  ]);
  const covers = new Map([['a', 'Pics/cover-a.png'], ['b', 'Pics/cover-b.png'], ['c', 'Pics/own.png']]);
  const exporter = new module.ShareExporter({ vault: { adapter: new FileSystemAdapter(), getName: () => 'V' } }, { map, notes, covers, mapPath: 'Folder/Map.md' }, { vamVersion: '1', language: 'en' });
  const seen = [];
  // The Markdown renderer needs Obsidian: stand in for it with a plain image conversion, keep the real cleaning and collecting.
  exporter.renderOne = async markdown => {
    seen.push(markdown);
    const cleaned = clean.cleanShareMarkdown(markdown, { titleOf: () => undefined, assets: exporter.registry });
    const html = cleaned.markdown.replace(/!\[[^\]]*\]\((vam-asset:[^)]+)\)/g, '<img src="$1">');
    return { html, diagrams: [], diagramsUnsourced: 0, localRefs: 0, attachments: cleaned.attachments.map(item => item.name), mermaidUndrawn: 0, mermaidBlocked: 0 };
  };
  const ticket = { generation: 0, signal: new AbortController().signal, isCurrent: () => true };
  await exporter.ensureRendered(ticket, () => {});
  for (const name of ['image-1', 'image-2', 'image-3']) exporter.images.set(name, `data:image/webp;base64,${name}`);
  const result = exporter.assemble({ includeDetail: true, includeImages: true });
  assert.deepEqual(plain(result.leakCategories), []);
  const html = id => result.payload.nodes.find(item => item.id === id).detailHtml;
  assert.match(html('a'), /<img src="vam-asset:image-\d">/, 'a card with detail shows its cover');
  assert.match(html('b'), /<img src="vam-asset:image-\d">/, 'a cover-only card still gets its picture');
  assert.equal((html('c').match(/<img /g) ?? []).length, 1, 'a cover the detail already embeds is not doubled');
  assert.equal(result.payload.nodes.find(item => item.id === 'd').detailHtml.includes('<img'), false, 'a card without a cover gets no picture');
  assert.equal(result.counts.images, 3, 'the cover pictures are counted');
  assert.equal(Object.keys(result.payload.assets).length, 3);
  assert.ok(result.html.includes('data:image/webp;base64,image-1'), 'the finished file carries the cover picture data');
  assert.ok(seen.some(markdown => markdown.startsWith('![[Pics/cover-b.png]]')));
  // Images off: the pictures stay out of the file.
  const noImages = exporter.assemble({ includeDetail: true, includeImages: false });
  assert.equal(noImages.counts.images, 0);
});

// share-match-map P1: annotated images (and the cover look) travel in the file; the vault path, relation kind and description do not.
// Changed on purpose (owner-approved, decisions #4): this used to assert the payload carried no annotated image at all.
const matchMapHarness = ({ files = ['Pics/shared.png', 'Pics/other.png', 'Pics/cover-b.png'], unreadable = [], canvasItems, covers, coverLooks, notes: noteOverrides = {}, extraNodes = [] } = {}) => {
  class FileSystemAdapter { getBasePath() { return '/Users/me/Vault'; } }
  const module = load('experiences/sharing/share-exporter.ts', { obsidian: { ...obsidian, FileSystemAdapter, Component: class { load() {} unload() {} addChild() {} removeChild() {} } } });
  const clean = load('experiences/sharing/share-clean.ts');
  const nodes = [{ id: 'a', path: 'Folder/A.md', parentId: null, x: 0, y: 0, collapsed: false }, { id: 'b', path: 'Folder/B.md', parentId: 'a', x: 5, y: 6, collapsed: false }, ...extraNodes];
  const map = { id: 'map-1', title: 'Map', outputLanguage: 'en', viewport: { x: 0, y: 0, zoom: 1 }, nodes, ...(canvasItems ? { canvasItems } : {}) };
  const note = (title, detail) => ({ title, summary: 'S', status: 'idea', model: '', ...(detail ? { detail } : {}) });
  const notes = new Map([['a', note('A', noteOverrides.a)], ['b', note('B', noteOverrides.b)]]);
  const has = path => files.includes(path);
  const app = {
    vault: { adapter: new FileSystemAdapter(), getName: () => 'V', getFileByPath: path => (has(path) ? { path } : null), readBinary: async path => new TextEncoder().encode(path.path).buffer },
    metadataCache: { getFirstLinkpathDest: ref => { const hit = files.find(path => path === ref || path.split('/').pop() === ref); return hit ? { path: hit } : null; } }
  };
  const exporter = new module.ShareExporter(app, { map, notes, ...(covers ? { covers: new Map(Object.entries(covers)) } : {}), ...(coverLooks ? { coverLooks: new Map(Object.entries(coverLooks)) } : {}), mapPath: 'Folder/Map.md' }, { vamVersion: '1', language: 'en' });
  exporter.renderOne = async markdown => {
    const cleaned = clean.cleanShareMarkdown(markdown, { titleOf: () => undefined, assets: exporter.registry });
    const html = cleaned.markdown.replace(/!\[[^\]]*\]\((vam-asset:[^)]+)\)/g, '<img src="$1">');
    return { html, diagrams: [], diagramsUnsourced: 0, localRefs: 0, attachments: cleaned.attachments.map(item => item.name), mermaidUndrawn: 0, mermaidBlocked: 0 };
  };
  const ticket = { generation: 0, signal: new AbortController().signal, isCurrent: () => true };
  const prepare = async () => {
    // encodeShareImage needs a browser (the sandbox has none, so every encode fails): run the real loop, which names and
    // lists every picture, then stand in for the encoder by file readability.
    await exporter.ensureRendered(ticket, () => {});
    await exporter.ensureImages(ticket, () => {});
    for (const name of [...exporter.images.keys()]) {
      const found = exporter.resolveImageFile(name);
      exporter.images.set(name, found && !unreadable.includes(found.path) ? `data:image/webp;base64,${name}` : null);
    }
  };
  return { exporter, prepare, map, serialised: result => JSON.stringify(plain(result.payload)) };
};
const anchoredImage = (overrides = {}) => ({
  id: 'img1', kind: 'annotated-image', path: 'Pics/shared.png', x: 9, y: 8, w: 100, h: 80, note: 'Beef cuts', anchors: [
    { id: 'p1', at: { kind: 'image-2d', x: 0.25, y: 0.5 }, note: 'Ribeye' },
    { id: 'p2', at: { kind: 'image-2d', x: 2, y: -1 } },
    { id: 'p3', at: { kind: 'unknown-3d', x: 1, y: 1, z: 1 }, note: 'UNKNOWN-KIND-NOTE' }
  ],
  relations: [{ kind: 'related', from: 'p1', to: 'b', description: 'RELATION-DESCRIPTION', ring: true }, { kind: 'supports', from: 'a', to: 'p2' }],
  ...overrides
});

test('share exporter annotated-image: the payload carries the picture, anchors and links with their kind and description, and never the vault path', async () => {
  const harness = matchMapHarness({ canvasItems: [anchoredImage({ path: 'Pics/shared.png' })], notes: { a: 'Body' } });
  await harness.prepare();
  const result = harness.exporter.assemble({ includeDetail: true, includeImages: true });
  assert.deepEqual(plain(result.leakCategories), []);
  const [image] = plain(result.payload.images);
  assert.equal(result.payload.images.length, 1);
  assert.deepEqual(Object.keys(image).sort(), ['anchors', 'asset', 'h', 'id', 'links', 'note', 'w', 'x', 'y']);
  assert.deepEqual(image.anchors, [{ id: 'p1', x: 0.25, y: 0.5, note: 'Ribeye' }, { id: 'p2', x: 1, y: 0 }], 'positions are clamped; the unknown position kind is not in the file');
  assert.deepEqual(image.links, [{ anchor: 'p1', topic: 'b', ring: true, kind: 'related', description: 'RELATION-DESCRIPTION' }, { anchor: 'p2', topic: 'a', kind: 'supports' }], 'either direction of the relation is stored as anchor -> topic');
  assert.ok(result.payload.assets[image.asset].startsWith('data:image/'));
  const text = harness.serialised(result);
  for (const secret of ['Pics/shared.png', 'UNKNOWN-KIND-NOTE', '"path"', 'canvasItems', '"relations"']) assert.equal(text.includes(secret), false, secret);
  for (const secret of ['Pics/shared.png', 'UNKNOWN-KIND-NOTE']) assert.equal(result.html.includes(secret), false, `file: ${secret}`);
});

test('share exporter annotated-image: a dangling link, an unknown or missing topic, and a repeated anchor id stay out of the file', async () => {
  const image = anchoredImage({
    anchors: [{ id: 'p1', at: { kind: 'image-2d', x: 0.1, y: 0.1 } }, { id: 'p1', at: { kind: 'image-2d', x: 0.9, y: 0.9 } }, { id: 'p3', at: { kind: 'vr', x: 0.5 } }],
    relations: [{ kind: 'related', from: 'p1', to: 'gone' }, { kind: 'related', from: 'p3', to: 'a' }, { kind: 'related', from: 'ghost', to: 'a' }, { kind: 'related', from: 'p1', to: 'a' }]
  });
  const harness = matchMapHarness({ canvasItems: [image, { ...image, id: 'img1' }, { id: 'bad', kind: 'annotated-image', x: NaN, y: 0, w: 1, h: 1, anchors: [] }] });
  const result = harness.exporter.assemble({ includeDetail: false, includeImages: false });
  assert.equal(result.payload.images.length, 1, 'a repeated image id and a non-finite box are dropped');
  assert.deepEqual(plain(result.payload.images[0].anchors), [{ id: 'p1', x: 0.1, y: 0.1 }]);
  assert.deepEqual(plain(result.payload.images[0].links), [{ anchor: 'p1', topic: 'a', kind: 'related' }]);
});

test('share exporter annotated-image: the image note and anchor notes are scanned; a note with the map folder or a note path blocks the file, [[x]] becomes plain text', () => {
  const run = (note, anchorNote) => matchMapHarness({ canvasItems: [anchoredImage({ note, anchors: [{ id: 'p1', at: { kind: 'image-2d', x: 0.5, y: 0.5 }, note: anchorNote }], relations: [] })] }).exporter.assemble({ includeDetail: false, includeImages: false });
  assert.ok(run('see Folder/A.md', 'ok').leakCategories.includes('note-path'));
  assert.ok(run('ok', 'in Folder here').leakCategories.includes('map-folder'));
  const linked = run('about [[Ribeye|the ribeye]]', 'see [[Chuck]]');
  assert.deepEqual(plain(linked.leakCategories), []);
  assert.equal(linked.payload.images[0].note, 'about the ribeye');
  assert.equal(linked.payload.images[0].anchors[0].note, 'see Chuck');
  assert.equal(linked.html.includes('[['), false);
});

test('share exporter annotated-image: a map without annotated images, covers or layout keeps the payload and its key order exactly as before', () => {
  const plainRun = matchMapHarness({}).exporter.assemble({ includeDetail: true, includeImages: true });
  assert.deepEqual(Object.keys(plain(plainRun.payload)), ['format', 'version', 'title', 'language', 'exportedAt', 'source', 'viewport', 'nodes', 'assets']);
  assert.deepEqual(Object.keys(plain(plainRun.payload.nodes[1])), ['id', 'parentId', 'x', 'y', 'collapsed', 'status', 'title', 'summary']);
  assert.equal(JSON.stringify(plain(plainRun.payload)), '{"format":"vam-share","version":1,"title":"Map","language":"en","exportedAt":' + JSON.stringify(plainRun.payload.exportedAt) + ',"source":{"vamVersion":"1","mapId":"map-1"},"viewport":{"x":0,"y":0,"zoom":1},"nodes":[{"id":"a","parentId":null,"x":0,"y":0,"collapsed":false,"status":"idea","title":"A","summary":"S"},{"id":"b","parentId":"a","x":5,"y":6,"collapsed":false,"status":"idea","title":"B","summary":"S"}],"assets":{}}');
  // Other canvas items (an unknown kind, a boundary with no member in the file) add nothing.
  const other = matchMapHarness({ canvasItems: [{ id: 'i1', kind: 'mystery' }, { id: 'bd', kind: 'boundary', members: ['gone'] }] }).exporter.assemble({ includeDetail: true, includeImages: true });
  assert.equal(JSON.stringify(plain({ ...other.payload, exportedAt: 0 })), JSON.stringify(plain({ ...plainRun.payload, exportedAt: 0 })));
});

test('share exporter covers: a cover and an annotated image on a picture a note already embeds share one asset', async () => {
  const harness = matchMapHarness({
    canvasItems: [anchoredImage({ path: 'Pics/shared.png' })],
    covers: { a: 'Pics/shared.png', b: 'Pics/cover-b.png' },
    coverLooks: { a: { frame: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 }, size: 0.6, position: 'bottom' }, b: { frame: null, size: 1, position: 'top' } },
    notes: { a: 'Body of A\n\n![[shared.png]]' }
  });
  await harness.prepare();
  assert.deepEqual([...harness.exporter.images.keys()].sort(), ['image-1', 'image-2'], 'ensureImages lists the cover and canvas pictures once each, with the one the note embeds');
  const result = harness.exporter.assemble({ includeDetail: true, includeImages: true });
  assert.deepEqual(plain(result.leakCategories), []);
  const [a, b] = result.payload.nodes;
  assert.equal(a.cover.asset, result.payload.images[0].asset, 'the cover, the picture on the canvas and the one in the note are the same asset');
  assert.match(a.detailHtml, new RegExp(`vam-asset:${a.cover.asset}"`));
  assert.deepEqual(plain(a.cover), { asset: a.cover.asset, frame: [0.1, 0.2, 0.5, 0.5], size: 0.6, position: 'bottom' });
  assert.deepEqual(plain(b.cover), { asset: b.cover.asset }, 'default look values are not written');
  assert.notEqual(b.cover.asset, a.cover.asset);
  assert.equal(Object.keys(result.payload.assets).length, 2, 'two pictures, not four');
});

test('share exporter covers: without images or without notes there is no asset, no cover and a placeholder image; an unreadable picture counts as failed', async () => {
  const build = () => matchMapHarness({ canvasItems: [anchoredImage()], covers: { a: 'Pics/shared.png', b: 'Pics/cover-b.png' }, notes: { a: 'Body' }, unreadable: ['Pics/cover-b.png'] });
  for (const options of [{ includeDetail: true, includeImages: false }, { includeDetail: false, includeImages: true }, { includeDetail: false, includeImages: false }]) {
    const harness = build();
    await harness.prepare();
    const result = harness.exporter.assemble(options);
    assert.equal(result.payload.nodes.some(node => 'cover' in node), false, JSON.stringify(options));
    assert.equal('asset' in result.payload.images[0], false);
    assert.equal(result.payload.images[0].note, 'Beef cuts');
    assert.deepEqual(plain(result.payload.assets), {});
    assert.equal(result.failedImages, 0, 'a picture that is left out is not a failure');
  }
  const harness = build();
  await harness.prepare();
  const result = harness.exporter.assemble({ includeDetail: true, includeImages: true });
  assert.equal(result.failedImages, 1);
  assert.ok(result.payload.nodes[0].cover.asset);
  assert.equal('cover' in result.payload.nodes[1], false, 'the unreadable cover is left out');
  const missing = matchMapHarness({ canvasItems: [anchoredImage({ path: 'Pics/missing.png' })], notes: { a: 'Body' } });
  await missing.prepare();
  const lost = missing.exporter.assemble({ includeDetail: true, includeImages: true });
  assert.equal('asset' in lost.payload.images[0], false);
  assert.equal(lost.failedImages, 1);
});

test('share exporter layout: a non-default map layout and branch layouts are carried, the default is not', () => {
  const extra = [{ id: 'c', path: 'Folder/C.md', parentId: 'a', x: 0, y: 0, collapsed: false, layout: { direction: 'down' } }];
  const right = matchMapHarness({ extraNodes: extra }).exporter.assemble({ includeDetail: false, includeImages: false });
  assert.equal('layout' in right.payload, false);
  assert.deepEqual(plain(right.payload.nodes[2].layout), { direction: 'down' });
  assert.equal('layout' in right.payload.nodes[0], false);
  const harness = matchMapHarness({});
  harness.map.layout = { direction: 'balanced', spacing: 'compact' };
  assert.deepEqual(plain(harness.exporter.assemble({ includeDetail: false, includeImages: false }).payload.layout), { direction: 'balanced', spacing: 'compact' });
});

test('share exporter: an outside data folder of this map (as typed, and its real path) blocks the export; another map\'s folder does not', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vam-share-ext-')));
  try {
    const realDir = path.join(tmp, 'real', 'research'); fs.mkdirSync(realDir, { recursive: true });
    const alias = path.join(tmp, 'alias'); fs.symlinkSync(realDir, alias);
    class FileSystemAdapter { getBasePath() { return '/Users/me/Vault'; } }
    const module = load('experiences/sharing/share-exporter.ts', { obsidian: { ...obsidian, FileSystemAdapter, Component: class { load() {} unload() {} addChild() {} removeChild() {} } } });
    const map = { id: 'map-1', title: 'Map', outputLanguage: 'en', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'a', path: 'Folder/A.md', parentId: null, x: 0, y: 0, collapsed: false }] };
    const store = { 'vam-map-external-sources:map-1': [{ path: alias, label: 'alias' }], 'vam-map-external-sources:map-2': [{ path: '/elsewhere/zzz', label: 'zzz' }] };
    const run = summary => new module.ShareExporter({ vault: { adapter: new FileSystemAdapter(), getName: () => 'V' }, loadLocalStorage: key => store[key] ?? null }, { map, notes: new Map([['a', { title: 'A', summary, status: 'idea', model: '' }]]), mapPath: 'Folder/Map.md' }, { vamVersion: '1', language: 'en' }).assemble({ includeDetail: false, includeImages: false });
    assert.deepEqual(plain(run('clean text').leakCategories), []);
    for (const leak of [alias, realDir, `see ${realDir}/a.md`]) {
      const blocked = run(leak);
      assert.ok(blocked.leakCategories.includes('external-path'), leak);
      assert.equal(blocked.html, undefined); assert.equal(blocked.bytes, 0);
    }
    assert.deepEqual(plain(run('/elsewhere/zzz').leakCategories), [], 'only this map\'s folders are forbidden');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('share exporter: an outside folder path with & is blocked when the page text carries it as an HTML entity', () => {
  class FileSystemAdapter { getBasePath() { return '/Users/me/Vault'; } }
  const module = load('experiences/sharing/share-exporter.ts', { obsidian: { ...obsidian, FileSystemAdapter, Component: class { load() {} unload() {} addChild() {} removeChild() {} } } });
  const map = { id: 'map-1', title: 'Map', outputLanguage: 'en', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'a', path: 'Folder/A.md', parentId: null, x: 0, y: 0, collapsed: false }] };
  const store = { 'vam-map-external-sources:map-1': [{ path: '/outside/R&D', label: 'R&D' }] };
  const run = summary => new module.ShareExporter({ vault: { adapter: new FileSystemAdapter(), getName: () => 'V' }, loadLocalStorage: key => store[key] ?? null }, { map, notes: new Map([['a', { title: 'A', summary, status: 'idea', model: '' }]]), mapPath: 'Folder/Map.md' }, { vamVersion: '1', language: 'en' }).assemble({ includeDetail: false, includeImages: false });
  for (const leak of ['/outside/R&D/a.md', '/outside/R&amp;D/a.md', '/outside/R&#38;D']) { const blocked = run(`see ${leak}`); assert.ok(blocked.leakCategories.includes('external-path'), leak); assert.equal(blocked.html, undefined); }
  assert.deepEqual(plain(run('see R&D label').leakCategories), []);
});

test('share dom: what the stylesheet hides in Obsidian (work-record callouts, hidden plan parts, marker-only paragraphs) is removed; the plan block stays', () => {
  const record = el('div', { class: 'callout', 'data-callout': 'vam-book' }, [el('p', {}, [], '舊版備份在 Agent Workspace/筆記風格/備份/筆記/x.md')]);
  const upper = el('div', { class: 'callout is-collapsed', 'data-callout': 'VAM-BOOK' }, [el('p', {}, [], 'slots')]);
  const plan = el('div', { class: 'callout vam-book-plan', 'data-callout': 'vam-book' }, [
    el('p', {}, [], 'shown plan'),
    el('div', { class: 'vam-book-plan-hidden' }, [el('p', {}, [], 'structure')])
  ]);
  const info = el('div', { class: 'callout', 'data-callout': 'info' }, [el('p', {}, [], 'kept')]);
  const ownHidden = el('span', { class: 'vam-book-plan-hidden' }, [], 'outside a plan: kept');
  const marker = el('p', { class: 'vam-internal-marker-only' });
  const root = el('div', {}, [el('section', {}, [record]), upper, plan, info, ownHidden, marker, el('p', {}, [], 'body')]);
  assert.equal(dom.dropHiddenContent(root), 4);
  const texts = node => [node.textContent, ...node.children.flatMap(texts)].filter(Boolean);
  assert.deepEqual(texts(root), ['shown plan', 'kept', 'outside a plan: kept', 'body']);
});

test('share exporter complete: type and shape come from the note; an argument-map card is always rect; a free picture joins the pictures without its path', async () => {
  const harness = matchMapHarness({ canvasItems: [{ id: 'free1', kind: 'image', path: 'Pics/other.png', x: 3, y: 4, w: 50, h: 60 }, { id: 'bd', kind: 'boundary', members: ['a', 'b', 'free1'], label: 'Frame' }] });
  harness.exporter.source.notes.get('a').topicKind = 'hypothesis';
  harness.exporter.source.notes.get('b').topicKind = 'evidence';
  await harness.prepare();
  let result = harness.exporter.assemble({ includeDetail: true, includeImages: true });
  const [na, nb] = plain(result.payload.nodes);
  assert.deepEqual([na.kind, na.shape, nb.kind, nb.shape], ['hypothesis', 'diamond', 'evidence', 'folded']);
  const free = plain(result.payload.images)[0];
  assert.deepEqual(Object.keys(free).sort(), ['anchors', 'asset', 'free', 'h', 'id', 'w', 'x', 'y']);
  assert.deepEqual(free.anchors, []);
  assert.ok(result.payload.assets[free.asset]);
  assert.equal(harness.serialised(result).includes('Pics/other.png'), false);
  assert.deepEqual(plain(result.payload.boundaries), [{ id: 'bd', members: ['a', 'b', 'free1'], label: 'Frame' }]);
  // Images off: the picture is still listed (the viewer draws a text placeholder), with no asset.
  result = harness.exporter.assemble({ includeDetail: true, includeImages: false });
  assert.deepEqual(plain(result.payload.images), [{ id: 'free1', x: 3, y: 4, w: 50, h: 60, anchors: [], free: true }]);
  // An argument map draws every managed card as a plain rectangle, whatever its type.
  const fixture = require('../fixtures/argument-map-ui.cjs');
  const one = fixture.states.facet_matched;
  const ids = Object.fromEntries(one.notes.map((n, index) => [n.key, index === 0 ? 'a' : index === 1 ? 'b' : `id-${n.key}`]));
  const argument = matchMapHarness({ extraNodes: one.notes.slice(2).map(n => ({ id: ids[n.key], path: `Folder/${n.key}.md`, parentId: 'a', x: 0, y: 0, collapsed: false })) });
  argument.exporter.source.map.argumentMap = fixture.bind(one.map.argumentMap, ids);
  argument.exporter.source.notes.get('a').topicKind = 'hypothesis';
  argument.exporter.source.notes.get('b').topicKind = 'hypothesis';
  const managed = require('../support.cjs').load('core/argument-map/model.ts').managedNodeIds(argument.exporter.source.map);
  assert.ok(managed.has('a') && managed.has('b'), 'the fixture manages both cards');
  await argument.prepare();
  const [aa, ab] = plain(argument.exporter.assemble({ includeDetail: true, includeImages: true }).payload.nodes);
  assert.deepEqual([aa.kind, aa.shape, ab.kind, ab.shape], [undefined, 'rect', undefined, 'rect'], 'a managed argument card is a plain rectangle and carries no type');
  assert.equal('kind' in aa || 'kind' in ab, false, 'the key is not written at all');
});

test('share exporter complete: a map without new data adds no new field to the payload, and a vault with a missing free picture still lists it', async () => {
  const harness = matchMapHarness({ files: [], canvasItems: [{ id: 'free1', kind: 'image', path: 'Gone/x.png', x: 0, y: 0, w: 5, h: 5 }] });
  await harness.prepare();
  const result = harness.exporter.assemble({ includeDetail: true, includeImages: true });
  assert.deepEqual(plain(result.payload.images), [{ id: 'free1', x: 0, y: 0, w: 5, h: 5, anchors: [], free: true }], 'nothing silently disappears');
  assert.equal(result.leakCategories.length, 0);
  assert.equal(harness.serialised(result).includes('Gone/x.png'), false);
  for (const key of ['attachments', 'relations', 'boundaries']) assert.equal(key in result.payload, false, `no ${key} for a map without them`);
  for (const node of result.payload.nodes) for (const key of ['kind', 'markers', 'color', 'style', 'links', 'relevance']) assert.equal(key in node, false, `a plain card has no ${key}`);
});

// ---- P4: inline note embeds ----
test('share dom: a vam-embed callout keeps its type and its content; a work record or plan block inside the embedded content is dropped, the rest kept', () => {
  const record = el('div', { class: 'callout', 'data-callout': 'vam-book' }, [el('p', {}, [], 'record')]);
  const inner = el('div', { class: 'callout-content' }, [el('p', {}, [], 'embedded text'), record]);
  const box = el('div', { class: 'callout', 'data-callout': 'vam-embed' }, [el('div', { class: 'callout-title' }, [el('div', { class: 'callout-title-inner' }, [], 'Embedded: T')]), inner]);
  const root = el('div', {}, [box]);
  assert.equal(dom.dropHiddenContent(root), 1);
  dom.scrubShareTree(root, { allowStyle: true });
  assert.equal(root.children[0].getAttribute('data-callout'), 'vam-embed');
  assert.deepEqual(plain(tags(root).filter(name => name === 'p')), ['p']);
});

test('share exporter embeds: embedded notes are read from the vault (whole, heading, block), only Markdown notes of the vault, never the note itself, and render through the cleaner', async () => {
  class FileSystemAdapter { getBasePath() { return '/Users/me/Vault'; } }
  const module = load('experiences/sharing/share-exporter.ts', { obsidian: { ...obsidian, FileSystemAdapter, Component: class { load() {} unload() {} addChild() {} removeChild() {} } } });
  const clean = load('experiences/sharing/share-clean.ts');
  const files = { 'Folder/Src.md': { path: 'Folder/Src.md', extension: 'md', text: '---\nk: v\n---\nWhole body\n\n## H\nHeading body\n\nBlock text ^b1\n' }, 'Folder/Data.csv': { path: 'Folder/Data.csv', extension: 'csv', text: 'a,b' }, 'Agent/Hidden.md': { path: 'Agent/Hidden.md', extension: 'md', text: 'internal' } };
  const reads = [];
  const app = {
    vault: { adapter: new FileSystemAdapter(), getName: () => 'V', cachedRead: async file => { reads.push(file.path); return file.text; } },
    metadataCache: { getFirstLinkpathDest: (ref, from) => files[`Folder/${ref}.md`] ?? files[ref] ?? files[`${ref}.md`] ?? null }
  };
  const node = { id: 'a', path: 'Folder/A.md', parentId: null, x: 0, y: 0, collapsed: false };
  const map = { id: 'm', title: 'M', outputLanguage: 'en', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node] };
  const detail = '![[Src]]\n\n![[Src#H]]\n\n![[Src#^b1]]\n\n![[Src#Nope]]\n\n![[A]]\n\n![[Data.csv]]\n\n![[Agent/Hidden]]';
  const notes = new Map([['a', { title: 'A', summary: 'S', status: 'idea', model: '', detail }]]);
  const exporter = new module.ShareExporter(app, { map, notes, mapPath: 'Maps/M/Map.md' }, { vamVersion: '1', language: 'en', internalFolders: ['Agent'] });
  let markdown = '';
  exporter.renderOne = async (md, titles, ids, embeds) => {
    markdown = clean.cleanShareMarkdown(md, { titleOf: t => titles.get(t), embedOf: t => embeds.get(t), embedTitle: t => `Embedded: ${t}`, assets: exporter.registry }).markdown;
    return { html: markdown, diagrams: [], diagramsUnsourced: 0, localRefs: 0, attachments: [], mermaidUndrawn: 0, mermaidBlocked: 0 };
  };
  await exporter.ensureRendered({ generation: 0, signal: new AbortController().signal, isCurrent: () => true }, () => {});
  assert.deepEqual([...new Set(reads)], ['Folder/Src.md'], 'only the one vault note is read (once per target as written)');
  assert.ok(markdown.includes('> [!vam-embed] Embedded: Src\n> Whole body'), markdown);
  assert.ok(!markdown.includes('k: v'), 'frontmatter is not shown');
  assert.ok(markdown.includes('> ## H\n> Heading body'));
  assert.ok(markdown.includes('> [!vam-embed] Embedded: Src\n> Block text\n'));
  assert.equal((markdown.match(/\[!vam-embed\]/g) ?? []).length, 3, 'a missing heading, the note itself, a non-Markdown file and an internal folder give no box');
  assert.ok(markdown.includes('Nope') || markdown.includes('Src'), 'the missing heading keeps its title');
  assert.ok(markdown.includes('Data.csv') && markdown.includes('Hidden'));
});

// ---- P5: file attachments, and embedded content keeps to its own note ----
const p5Exporter = (files, extra = {}) => {
  class FileSystemAdapter { getBasePath() { return '/Users/me/Vault'; } }
  const module = load('experiences/sharing/share-exporter.ts', { obsidian: { ...obsidian, FileSystemAdapter, Component: class { load() {} unload() {} addChild() {} removeChild() {} } } });
  const binaryReads = [];
  const byPath = Object.fromEntries(Object.values(files).map(file => [file.path, file]));
  const app = {
    vault: { adapter: new FileSystemAdapter(), getName: () => 'V', cachedRead: async file => file.text, readBinary: async file => { binaryReads.push(file.path); return extra.readBinary ? extra.readBinary(file) : new TextEncoder().encode('ABC').buffer; }, getFileByPath: path => byPath[path] ?? null },
    metadataCache: { getFirstLinkpathDest: (ref, from) => byPath[ref] ?? files[ref] ?? byPath[`${ref}.md`] ?? null }
  };
  const node = { id: 'a', path: 'Folder/A.md', parentId: null, x: 0, y: 0, collapsed: false };
  const map = { id: 'm', title: 'M', outputLanguage: 'en', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node] };
  const notes = new Map([['a', { title: 'A', summary: 'S', status: 'idea', model: '', detail: extra.detail ?? 'x' }]]);
  const exporter = new module.ShareExporter(app, { map, notes, mapPath: 'Folder/Map.md' }, { vamVersion: '1', language: 'en', internalFolders: ['Agent'] });
  return { exporter, binaryReads, node };
};
const ticket = () => ({ generation: 0, signal: new AbortController().signal, isCurrent: () => true });
const mk = (path, size, extension = path.split('.').pop()) => ({ path, name: path.split('/').pop(), basename: path.split('/').pop().replace(/\.[^.]*$/, ''), extension, stat: { size }, text: '' });

test('share exporter attachments: cards carry the file name only; a file over 10 MB, missing or internal is listed without bytes; images off gives no bytes; the bytes are an opaque data URI', async () => {
  const files = { 'Docs/Private/report.pdf': mk('Docs/Private/report.pdf', 3), 'Docs/big.zip': mk('Docs/big.zip', 10 * 1024 * 1024 + 1), 'Agent/secret.pdf': mk('Agent/secret.pdf', 3), 'Docs/page.html': mk('Docs/page.html', 3) };
  const { exporter, binaryReads } = p5Exporter(files);
  const names = ['Docs/Private/report.pdf', 'Docs/big.zip', 'Agent/secret.pdf', 'gone/missing.pdf', 'Docs/page.html', 'Docs/Private/report.pdf'].map(ref => exporter.registerFile(ref, 'Folder/A.md'));
  assert.deepEqual(plain(names), ['file-1', 'file-2', 'file-3', 'file-4', 'file-5', 'file-1'], 'the same file keeps its name');
  exporter.rendered.set('a', { html: '', diagrams: [], diagramsUnsourced: 0, localRefs: 0, attachments: [], files: names, mermaidUndrawn: 0, mermaidBlocked: 0 });
  await exporter.readFiles(ticket());
  assert.deepEqual(plain(binaryReads), ['Docs/Private/report.pdf', 'Docs/page.html'], 'no read for a big, internal or missing file');
  const on = exporter.buildPayload({ includeDetail: true, includeImages: true }).payload;
  assert.deepEqual(plain(on.attachments.map(item => [item.name, item.file, item.size, item.asset ?? null])), [['file-1', 'report.pdf', 3, 'file-1'], ['file-2', 'big.zip', 10485761, null], ['file-3', 'secret.pdf', 0, null], ['file-4', 'missing.pdf', 0, null], ['file-5', 'page.html', 3, 'file-5']]);
  assert.equal(on.assets['file-1'], 'data:application/octet-stream;base64,QUJD');
  assert.equal(on.assets['file-5'], 'data:application/octet-stream;base64,QUJD', 'an .html file is still opaque bytes');
  assert.equal(JSON.stringify(on).includes('Docs/Private') || JSON.stringify(on).includes('Agent/'), false, 'no vault path in the payload');
  const off = exporter.buildPayload({ includeDetail: true, includeImages: false }).payload;
  assert.equal(off.attachments.length, 5);
  assert.equal(off.attachments.some(item => item.asset), false);
  assert.deepEqual(plain(Object.keys(off.assets)), []);
  assert.equal('attachments' in exporter.buildPayload({ includeDetail: false, includeImages: false }).payload, false);
  const plainMap = p5Exporter({}).exporter.buildPayload({ includeDetail: true, includeImages: true }).payload;
  assert.equal('attachments' in plainMap, false, 'a map without files has no new field');
  assert.equal(on.nodes.length, 1);
});

test('share exporter attachments: actual bytes must match the registered size and stay within the limit', async () => {
  const files = {
    'Docs/grown.pdf': mk('Docs/grown.pdf', 3),
    'Docs/empty.pdf': mk('Docs/empty.pdf', 3),
    'Docs/changed.pdf': mk('Docs/changed.pdf', 3),
    'Docs/stable.pdf': mk('Docs/stable.pdf', 3)
  };
  const { exporter, binaryReads } = p5Exporter(files, {
    readBinary: file => new ArrayBuffer({
      'Docs/grown.pdf': 10 * 1024 * 1024 + 1,
      'Docs/empty.pdf': 0,
      'Docs/changed.pdf': 4,
      'Docs/stable.pdf': 3
    }[file.path])
  });
  const names = Object.keys(files).map(ref => exporter.registerFile(ref, 'Folder/A.md'));
  exporter.rendered.set('a', { html: '', diagrams: [], diagramsUnsourced: 0, localRefs: 0, attachments: [], files: names, mermaidUndrawn: 0, mermaidBlocked: 0 });
  await exporter.readFiles(ticket());
  assert.deepEqual(plain(binaryReads), Object.keys(files));
  const payload = exporter.buildPayload({ includeDetail: true, includeImages: true }).payload;
  assert.deepEqual(plain(payload.attachments.map(item => item.asset ?? null)), [null, null, null, 'file-4']);
  assert.deepEqual(plain(Object.keys(payload.assets)), ['file-4']);
  assert.equal(payload.assets['file-4'], 'data:application/octet-stream;base64,AAAA');
});

test('share exporter embeds: embedded images resolve from the embedded note own folder, internal-folder pictures never enter, and a picture dropped in the check cannot return through the embed', async () => {
  const SOURCE = 'Intro\n\n![[../img/x.png]]\n\n![[../Agent/s.png]]\n\n![alt](../img/y.png)\n\nSource: [Site](https://example.org/p) · by X · CC-BY-NC 4.0\n';
  const files = { 'Notes/Sub/Emb.md': { ...mk('Notes/Sub/Emb.md', 5, 'md'), text: SOURCE }, 'Notes/img/x.png': mk('Notes/img/x.png', 5), 'Notes/img/y.png': mk('Notes/img/y.png', 5), 'Agent/s.png': mk('Agent/s.png', 5) };
  files['Notes/Agent/s.png'] = files['Agent/s.png'];
  const { exporter, node } = p5Exporter(files, { detail: '![[Notes/Sub/Emb]]' });
  const read = await exporter.readEmbeds('![[Notes/Sub/Emb]]', 'Folder/A.md', 'a', 0);
  const text = [...read.values()][0];
  assert.ok(text.includes('![[Notes/img/x.png]]'), text);
  assert.ok(text.includes('![[Notes/img/y.png|alt]]'), text);
  assert.ok(!text.includes('Agent/s.png') && !text.includes('../'), text);
  assert.equal(exporter.embeddedFigureProblems().length, 0, 'a picture without its own source line is not a licence problem');
  // A picture line followed by a source line: checked, numbered after the card own pictures, and dropped on request.
  files['Notes/Sub/Emb.md'].text = '![[../img/x.png]]\nSource: [Site](https://example.org/p) · by X · CC-BY-NC 4.0\n\nKept\n';
  const before = await exporter.readEmbeds('![[Notes/Sub/Emb]]', 'Folder/A.md', 'a', 2);
  assert.ok([...before.values()][0].includes('x.png'));
  assert.deepEqual(plain(exporter.embeddedFigureProblems().map(item => [item.id, item.index, item.problem])), [['a', 2, 'nc']]);
  exporter.dropFigures(new Map([['a', new Set([2])]]));
  const after = await exporter.readEmbeds('![[Notes/Sub/Emb]]', 'Folder/A.md', 'a', 2);
  assert.equal([...after.values()][0].trim(), 'Kept');
  assert.equal(node.id, 'a');
});

// ---- review R1 fixes ----
test('share exporter links: nodeIds keys are the path without .md, the file name and the title; a name two cards share has no link', () => {
  const { exporter } = p5Exporter({});
  const node = (id, path) => ({ id, path, parentId: null, x: 0, y: 0, collapsed: false });
  exporter.source.map.nodes = [node('water', 'Folder/Water.md'), node('other', 'Other/Water.md'), node('salt', 'Folder/Sub/Salt.md')];
  exporter.source.notes = new Map([['water', { title: 'Water in food' }], ['other', { title: 'Elsewhere' }], ['salt', { title: 'Salt' }], ['ghost', { title: 'No card' }]]);
  const ids = plain(Object.fromEntries(exporter.nodeIds()));
  assert.deepEqual(ids, { 'Folder/Water': 'water', 'Water in food': 'water', 'Other/Water': 'other', Elsewhere: 'other', 'Folder/Sub/Salt': 'salt', Salt: 'salt' });
  assert.equal('Water' in ids, false, 'the name two cards share goes to no card');
  assert.equal(exporter.nodeIds().get('Salt'), 'salt');
  exporter.source.notes.delete('salt');
  assert.equal(exporter.nodeIds().has('Folder/Sub/Salt'), false, 'a card without a note has no key');
});

test('share exporter links: a marked link survives the scrub into the final html as a node link, and the exporter applies links after the scrub', () => {
  const supportHtml = require('../support-html-dom.cjs');
  const links = load('experiences/sharing/share-node-links.ts');
  const dom = load('experiences/sharing/share-dom.ts');
  const root = supportHtml.parse(`<p>See ${links.markNodeLink('water', 'Water')} and <span onclick="x()" data-x="1">${links.markNodeLink('gone', 'Gone')}</span></p>`);
  dom.scrubShareTree(root);
  assert.ok(root.childNodes[0].innerHTML.includes(links.NODE_LINK_START), 'the scrub leaves the mark text alone');
  links.applyNodeLinks(root, new Set(['water']), () => new supportHtml.El('a', root.ownerDocument));
  const out = supportHtml.serialize(root);
  assert.ok(out.includes('<a class="vam-node-link" href="#vam-node-water">Water</a>') || out.includes('<a href="#vam-node-water" class="vam-node-link">Water</a>'), out);
  assert.ok(!/[\uE000-\uE004]/.test(out) && out.includes('Gone'), 'an unknown id ends as text');
  const source = fs.readFileSync(path.join(repoRoot, 'experiences/sharing/share-exporter.ts'), 'utf8');
  const body = source.slice(source.indexOf('private finish('));
  assert.ok(body.indexOf('replaceMediaWithLinks(') < body.indexOf('sanitizeHTMLToDom(') && body.indexOf('scrubShareTree(clean)') < body.indexOf('applyNodeLinks('), 'media links first, then sanitize and scrub, then the node links');
});

test('share exporter embeds: a picture dropped in the image check is also left out of the embedded note on the first build', async () => {
  const files = { 'Notes/Sub/Emb.md': { ...mk('Notes/Sub/Emb.md', 5, 'md'), text: '![[../img/x.png]]\nSource: [Site](https://example.org/p) · by X · CC-BY-NC 4.0\n\nKept\n' }, 'Notes/img/x.png': mk('Notes/img/x.png', 5) };
  const { exporter } = p5Exporter(files, { detail: '![[Notes/Sub/Emb]]' });
  let seen = null;
  exporter.renderOne = async (md, titles, ids, embeds) => { seen = [...embeds.values()][0]; return { html: seen, diagrams: [], diagramsUnsourced: 0, localRefs: 0, attachments: [], files: [], mermaidUndrawn: 0, mermaidBlocked: 0 }; };
  exporter.dropFigures(new Map([['a', new Set([0])]]));
  await exporter.ensureRendered(ticket(), () => {});
  assert.ok(seen !== null && !seen.includes('x.png') && seen.includes('Kept'), `first build: ${seen}`);
  exporter.dropFigures(new Map());
  await exporter.ensureRendered(ticket(), () => {});
  assert.ok(seen.includes('x.png'), 'cleared: the picture is back');
});

test('share export P6b: formulas are read before the sanitizer and filled as MathML after scrub and node links, with a visible source fallback', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'experiences/sharing/share-exporter.ts'), 'utf8');
  const body = source.slice(source.indexOf('private finish('), source.indexOf('private fillFormulas('));
  assert.ok(body.indexOf('collectFormulas(host)') < body.indexOf('sanitizeHTMLToDom(') && body.indexOf('applyNodeLinks(') < body.indexOf('this.fillFormulas('), 'collect first, fill last');
  const fill = source.slice(source.indexOf('private fillFormulas('));
  assert.ok(/mathFromLatex\(/.test(fill) && /MATH_SOURCE_CLASS/.test(fill) && /share\.math_source_note/.test(fill), 'a failed conversion shows the LaTeX and a note');
  assert.ok(/mjx-math\[data-latex\]/.test(source) && /classList\.contains\("math-block"\)/.test(source), 'LaTeX from data-latex; display from math-block');
  for (const lang of ['en', 'zh-TW', 'zh-CN']) assert.ok(/"share\.math_source_note":/.test(fs.readFileSync(path.join(repoRoot, `i18n/${lang}.ts`), 'utf8')), lang);
});

test('sharing export R2: embeds inside %% and <!-- --> comments are never read', async () => {
  class FileSystemAdapter { getBasePath() { return '/Users/me/Vault'; } }
  const module = load('experiences/sharing/share-exporter.ts', { obsidian: { ...obsidian, FileSystemAdapter, Component: class { load() {} unload() {} addChild() {} removeChild() {} } } });
  const files = { 'Folder/Draft.md': { path: 'Folder/Draft.md', extension: 'md', text: 'Public %%private remark%% tail' } };
  const reads = [];
  const app = { vault: { adapter: new FileSystemAdapter(), getName: () => 'V', cachedRead: async file => { reads.push(file.path); return file.text; } }, metadataCache: { getFirstLinkpathDest: (ref) => files[`Folder/${ref}.md`] ?? null } };
  const node = { id: 'a', path: 'Folder/A.md', parentId: null, x: 0, y: 0, collapsed: false };
  const map = { id: 'm', title: 'M', outputLanguage: 'en', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node] };
  const exporter = new module.ShareExporter(app, { map, notes: new Map(), mapPath: 'Maps/M/Map.md' }, { vamVersion: '1', language: 'en' });
  const embeds = await exporter.readEmbeds('%% ![[Draft]] %%\n\nx <!-- ![[Draft]] --> y\r\n%%\r\n![[Draft]]\r\n%%', 'Folder/A.md', 'a', 0);
  assert.equal(embeds.size, 0);
  assert.deepEqual(reads, []);
  const shown = await exporter.readEmbeds('![[Draft]]', 'Folder/A.md', 'a', 0);
  assert.equal(shown.get('Draft'), 'Public  tail');
});

test('share exporter acceptance fix: the shared map\'s own folder is content even inside a VAM folder; other VAM folders stay out', async () => {
  class FileSystemAdapter { getBasePath() { return '/Users/me/Vault'; } }
  const module = load('experiences/sharing/share-exporter.ts', { obsidian: { ...obsidian, FileSystemAdapter, Component: class { load() {} unload() {} addChild() {} removeChild() {} } } });
  const clean = load('experiences/sharing/share-clean.ts');
  const list = [
    { path: 'Agent/Topics/M/Notes/Src.md', extension: 'md', name: 'Src.md', text: '## Prompt\n\nINTERNAL-PROMPT-TEXT\n\n## Detail\n\nMap body', stat: { size: 8 } },
    { path: 'Agent/Topics/M/Unassigned/Loose.md', extension: 'md', name: 'Loose.md', text: 'UNASSIGNED-NOTE-TEXT', stat: { size: 8 } },
    { path: 'Agent/Topics/Other/Notes/X.md', extension: 'md', name: 'X.md', text: 'OTHER-MAP-SECRET', stat: { size: 16 } },
    { path: 'Agent/Topics/M/Attachments/s.pdf', extension: 'pdf', name: 's.pdf', stat: { size: 3 } },
    { path: 'Agent/Records/r.pdf', extension: 'pdf', name: 'r.pdf', stat: { size: 3 } },
    { path: 'Agent/Topics/M/Attachments/board.canvas', extension: 'canvas', name: 'board.canvas', stat: { size: 3 } },
    { path: 'Agent/Topics/M/Chats/records/c1.jsonl', extension: 'jsonl', name: 'c1.jsonl', stat: { size: 30 } },
    { path: 'Agent/Topics/M/Chats/topics/t1.jsonl', extension: 'jsonl', name: 't1.jsonl', stat: { size: 30 } },
    { path: 'Agent/Topics/M/Chats/records/Talk.md', extension: 'md', name: 'Talk.md', text: 'CHAT-RECORD-SECRET', stat: { size: 18 } }
  ];
  const byKey = { Loose: list[1], Src: list[0], X: list[2], 's.pdf': list[3], 'r.pdf': list[4], 'board.canvas': list[5], 'c1.jsonl': list[6], 't1.jsonl': list[7], Talk: list[8] };
  const reads = [];
  const app = {
    vault: { adapter: new FileSystemAdapter(), getName: () => 'V', cachedRead: async file => { reads.push(file.path); return file.text; }, readBinary: async () => new TextEncoder().encode('ABC').buffer, getFileByPath: path => list.find(file => file.path === path) ?? null },
    metadataCache: { getFirstLinkpathDest: ref => byKey[ref] ?? null }
  };
  const node = { id: 'a', path: 'Agent/Topics/M/Notes/A.md', parentId: null, x: 0, y: 0, collapsed: false };
  const srcCard = { id: 's', path: 'Agent/Topics/M/Notes/Src.md', parentId: 'a', x: 0, y: 0, collapsed: false };
  const map = { id: 'm', title: 'M', outputLanguage: 'en', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node, srcCard] };
  const detail = '![[Src]]\n\n![[Src#Prompt]]\n\n![[Src#prompt]]\n\n![[Loose]]\n\n![[X]]\n\n![[s.pdf]]\n\n![[r.pdf]]\n\n![[board.canvas]]\n\n![[c1.jsonl]]\n\n![[t1.jsonl]]\n\n![[Talk]]';
  const notes = new Map([['a', { title: 'A', summary: 'S', status: 'idea', model: '', detail }], ['s', { title: 'Src', summary: 'S', status: 'idea', model: '', detail: 'Map body' }]]);
  const exporter = new module.ShareExporter(app, { map, notes, mapPath: 'Agent/Topics/M/Map.md' }, { vamVersion: '1', language: 'en', internalFolders: ['Agent'] });
  let markdown = '';
  exporter.renderOne = async (md, titles, ids, embeds) => {
    markdown += clean.cleanShareMarkdown(md, { titleOf: t => titles.get(t), embedOf: t => embeds.get(t), embedTitle: t => `Embedded: ${t}`, attachmentOf: ref => exporter.registerFile(ref, node.path), assets: exporter.registry }).markdown;
    return { html: markdown, diagrams: [], diagramsUnsourced: 0, localRefs: 0, attachments: [], files: [], mermaidUndrawn: 0, mermaidBlocked: 0 };
  };
  await exporter.ensureRendered({ generation: 0, signal: new AbortController().signal, isCurrent: () => true }, () => {});
  assert.deepEqual([...new Set(reads)], [], 'a card note comes from the card detail; nothing in the map folder is read raw');
  assert.ok(markdown.includes('> Map body'), markdown);
  assert.equal(markdown.includes('INTERNAL-PROMPT-TEXT'), false, 'an embedded card never shows its Prompt section');
  assert.equal(markdown.includes('UNASSIGNED-NOTE-TEXT'), false, 'a non-card VAM note in the map folder shows its title only');
  assert.equal(markdown.includes('OTHER-MAP-SECRET'), false);
  assert.equal(markdown.includes('CHAT-RECORD-SECRET'), false, 'a chat record note in the map folder is not embedded');
  const files = [...exporter.files.values()];
  assert.deepEqual(files.map(file => [file.file, file.size > 0]), [['s.pdf', true], ['r.pdf', false], ['board.canvas', true], ['c1.jsonl', false], ['t1.jsonl', false]], 'map attachments are found; VAM records and the map\'s chat records are not; a canvas is an attachment');
});

test('share viewer acceptance fix: buttons with click handlers are built after the note is imported into the page', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(repoRoot, 'experiences/sharing/viewer/detail.ts'), 'utf8');
  const body = source.slice(source.indexOf('export function fillDetailRoot'));
  const imported = body.indexOf('doc.importNode(child, true)');
  assert.ok(imported > 0);
  assert.ok(body.indexOf('upgradeVideoLinks(target, doc, ui)') > imported, 'video cards are built on the live page');
  assert.ok(body.indexOf('target.querySelectorAll("a.vam-attachment-card")') > imported, 'attachment cards are built on the live page');
  assert.equal(body.slice(0, imported).includes('upgradeVideoLinks('), false);
});
