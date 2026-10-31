// Sharing P1 (Worker C): the Obsidian-side export pieces that can run without Obsidian: DOM scrub, build lifecycle,
// size advice, save fallback, and the share dialog's stale/cancel behaviour against a test-double exporter.
const assert = require('node:assert/strict');
const { test, load, obsidian, plain } = require('../support.cjs');

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
const okResult = (overrides = {}) => ({ payload: {}, html: '<html>file</html>', bytes: 1536, counts: { topics: 2, notesWithContent: 1, images: 1 }, leakCategories: [], failedImages: 0, mermaidUndrawn: 0, mermaidBlocked: 0, ...overrides });
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
  assert.match(h.text(), /Not saved: the file would contain private information \(the vault's location on this computer, a note's file path\)\. Nothing was written\./);
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
