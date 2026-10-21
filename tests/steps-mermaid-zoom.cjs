// Mermaid zoom viewer: scope and detection, the zoom button, the modal, zoom math, the SVG sanitizer, and read-only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, root } = require('./support-replay.cjs');


const math = load('experiences/mermaid-zoom/zoom-math.ts');
const { sanitizeSvgClone } = load('experiences/mermaid-zoom/sanitize-svg.ts');

// ---------- a small DOM: classes, simple selectors, clone, and the Obsidian helpers the code uses ----------
class FakeNode {
  constructor(tag, options = {}) {
    const opts = typeof options === 'string' ? { cls: options } : options ?? {};
    this.tag = tag; this.localName = tag.toLowerCase(); this.cls = opts.cls ?? ''; this.text = opts.text ?? '';
    this.attrs = { ...(opts.attr ?? {}) }; this.children = []; this.parent = null; this.listeners = {}; this.style = {};
    this.isConnected = true; this.clientWidth = 0; this.clientHeight = 0; this.focused = false;
  }
  get classes() { return this.cls.split(/\s+/).filter(Boolean); }
  get textContent() { return this.text; }
  set textContent(value) { this.text = String(value); }
  get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })); }
  createDiv(o) { return this.createEl('div', o); }
  createSpan(o) { return this.createEl('span', o); }
  createEl(tag, o) { return this.appendChild(new FakeNode(tag, o)); }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  setText(v) { this.text = String(v); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  removeAttribute(name) { delete this.attrs[name]; }
  addClass(...names) { for (const n of names) if (!this.classes.includes(n)) this.cls = `${this.cls} ${n}`.trim(); }
  removeClass(...names) { this.cls = this.classes.filter(n => !names.includes(n)).join(' '); }
  toggleClass(name, on) { on ? this.addClass(name) : this.removeClass(name); }
  hasClass(name) { return this.classes.includes(name); }
  empty() { this.children = []; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
  fire(name, event = {}) { const e = { preventDefault() {}, stopPropagation() {}, target: this, ...event }; for (const fn of this.listeners[name] ?? []) fn(e); }
  click() { this.fire('click'); }
  focus() { this.focused = true; }
  setPointerCapture() {}
  get ownerDocument() { return FAKE_DOC; }
  closest(sel) { for (let n = this; n; n = n.parent) if (n.is(sel)) return n; return null; }
  contains(other) { for (let n = other; n; n = n.parent) if (n === this) return true; return false; }
  getBoundingClientRect() { return { left: 10, top: 20, width: this.clientWidth, height: this.clientHeight }; }
  is(sel) { return sel.split(',').some(part => { const p = part.trim(); return p.startsWith('.') ? this.classes.includes(p.slice(1)) : this.localName === p.toLowerCase(); }); }
  matches(sel) { return this.is(sel); }
  querySelectorAll(sel) { const out = []; const walk = n => { for (const c of n.children) { if (c.is(sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  cloneNode() { const copy = new FakeNode(this.tag, { cls: this.cls, text: this.text, attr: this.attrs }); copy.style = { ...this.style }; for (const c of this.children) copy.appendChild(c.cloneNode()); return copy; }
}
const node = (tag, o) => new FakeNode(tag, o);
const svgOf = (tag, attrs = {}, children = []) => { const n = node(tag, { attr: attrs }); for (const c of children) n.appendChild(c); return n; };
const bare = svgOf;

function mockObsidian(files) {
  const icons = [];
  const writes = [];
  const writeTrap = new Proxy({}, { get: (_, name) => (...args) => { writes.push(String(name)); } });
  const app = {
    vault: new Proxy({
      getAbstractFileByPath: p => (files[p] ? { path: p, extension: 'md' } : null)
    }, { get: (target, name) => (name in target ? target[name] : writeTrap[name]) }),
    metadataCache: { getFileCache: file => ({ frontmatter: files[file.path] }) }
  };
  return { app, icons, writes, obsidian: { editorInfoField: {}, MarkdownRenderChild: class { constructor(el) { this.containerEl = el; } }, Modal: class { constructor(app) { this.app = app; this.titleEl = node('title'); this.contentEl = node('content'); this.modalEl = node('modal'); this.modalEl.appendChild(this.contentEl); this.closeCount = 0; } open() { this.onOpen?.(); } close() { this.closeCount++; this.onClose?.(); } }, setIcon: (el, icon) => { icons.push(icon); el.icon = icon; } } };
}

function loadRegister(files) {
  const env = mockObsidian(files);
  const observers = [];
  class FakeObserver { constructor(cb) { this.cb = cb; this.disconnected = false; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } }
  const mod = load('experiences/mermaid-zoom/register.ts', { obsidian: env.obsidian }, { MutationObserver: FakeObserver, window: FAKE_WINDOW });
  let processor = null; let unregister = null;
  const plugin = { app: env.app, registerEditorExtension() {}, register: fn => { unregister = fn; }, registerMarkdownPostProcessor: fn => { processor = fn; } };
  const handle = mod.registerMermaidZoom(plugin);
  const children = [];
  return { ...env, handle, children, mod, observers, get processor() { return processor; }, get unregister() { return unregister; }, run: (el, sourcePath) => processor(el, { sourcePath, addChild: c => children.push(c) }) };
}
const diagramBlock = () => { const block = node('div', 'el-pre'); const host = node('div', 'mermaid'); block.appendChild(host); return { block, host }; };
const addSvg = host => host.appendChild(svgOf('svg', { viewBox: '0 0 2400 300', id: 'mermaid-1' }, [svgOf('g')]));

const INERT_DOC = { imported: [], importNode(n) { this.imported.push(n); return n.cloneNode(); } };
const DOC_CALLS = [];
const FAKE_DOC = { implementation: { createHTMLDocument: () => { DOC_CALLS.push('createHTMLDocument'); return INERT_DOC; } }, importNode: n => { DOC_CALLS.push('importNode:live'); return n.cloneNode(); } };
const FAKE_WINDOW = { setTimeout: fn => { fn(); return 0; } };
const FILES = { 'Topics/A/Note.md': { 'agent-map-node': true }, 'Topics/A/Map.md': { 'visual-agent-map': 'true' }, 'Other/plain.md': { title: 'x' }, 'Other/lookalike.md': { 'agent-map-node': 'yes' } };

// ---------- detection and scope ----------
test('mermaid zoom: only notes with the VAM frontmatter marker are in scope', () => {
  const { mod, app } = loadRegister(FILES);
  assert.equal(mod.isVamSource(app, 'Topics/A/Note.md'), true);
  assert.equal(mod.isVamSource(app, 'Topics/A/Map.md'), true);
  assert.equal(mod.isVamSource(app, 'Other/plain.md'), false);
  assert.equal(mod.isVamSource(app, 'Other/lookalike.md'), false);
  assert.equal(mod.isVamSource(app, 'Missing.md'), false);
  assert.equal(mod.isVamSource(app, ''), false);
  assert.equal(mod.isVamFrontmatter(null), false);
});

test('mermaid zoom: a non-VAM note gets no button, no scope class and no observer', () => {
  const ctx = loadRegister(FILES);
  const { block, host } = diagramBlock(); addSvg(host);
  ctx.run(block, 'Other/plain.md');
  assert.equal(block.querySelector('.vam-mermaid-zoom-btn'), null);
  assert.equal(block.classes.includes('vam-mermaid-scope'), false);
  assert.equal(ctx.children.length, 0);
  assert.equal(host.classes.includes('vam-mermaid-scope'), false);
  assert.equal(ctx.observers.length, 0);
});

// ---------- the button ----------
test('mermaid zoom: a VAM diagram gets one keyboard-reachable button with an aria-label and the scope class', () => {
  const ctx = loadRegister(FILES);
  const { block, host } = diagramBlock(); addSvg(host);
  ctx.run(block, 'Topics/A/Note.md');
  const buttons = block.querySelectorAll('button');
  assert.equal(buttons.length, 1);
  assert.match(buttons[0].attrs['aria-label'], /^(放大圖表|Enlarge diagram)$/);
  assert.equal(buttons[0].attrs.type, 'button');
  assert.equal(buttons[0].attrs.tabindex, undefined, 'a real button is focusable without tabindex');
  assert.equal(buttons[0].icon, 'maximize-2');
  assert.ok(host.classes.includes('vam-mermaid-scope'));
  assert.equal(block.classes.includes('vam-mermaid-scope'), false, 'the section itself is not given the scope class');
  ctx.mod.decorateDiagram(ctx.app, host);
  assert.equal(block.querySelectorAll('button').length, 1, 'decorating again adds no second button');
});

test('mermaid zoom: a diagram that renders later gets its button when the SVG appears', () => {
  const ctx = loadRegister(FILES);
  const { block, host } = diagramBlock();
  ctx.run(block, 'Topics/A/Note.md');
  assert.equal(block.querySelectorAll('button').length, 0);
  assert.equal(ctx.observers.length, 1);
  addSvg(host);
  ctx.observers[0].cb();
  assert.equal(block.querySelectorAll('button').length, 1);
});

test('mermaid zoom: i18n has the labels in both languages', () => {
  const src = require('./support.cjs').i18nSource();
  for (const key of ['ui.mermaid_zoom_open', 'ui.mermaid_zoom_title', 'ui.mermaid_zoom_in', 'ui.mermaid_zoom_out', 'ui.mermaid_zoom_fit', 'ui.mermaid_zoom_actual', 'ui.mermaid_zoom_canvas_label', 'ui.mermaid_zoom_hint'])
    assert.equal(src.split(`"${key}"`).length - 1, 2, key);
  assert.match(src, /"ui\.mermaid_zoom_open": "放大圖表"/);
  assert.match(src, /"ui\.mermaid_zoom_fit": "符合視窗"/);
});

// ---------- the modal ----------
function openViewer(files = FILES) {
  const ctx = loadRegister(files);
  const { block, host } = diagramBlock(); const svg = addSvg(host);
  svg.appendChild(bare('script', {}, []));
  ctx.run(block, 'Topics/A/Note.md');
  const button = block.querySelector('button');
  button.click();
  return { ctx, block, host, svg, button };
}

test('mermaid zoom: the button opens a viewer with a sanitized clone, and the note SVG is left alone', () => {
  const openModals = [];
  const env = mockObsidian(FILES);
  const Base = env.obsidian.Modal;
  env.obsidian.Modal = class extends Base { open() { openModals.push(this); super.open(); } };
  const observers = [];
  const mod = load('experiences/mermaid-zoom/register.ts', { obsidian: env.obsidian }, { MutationObserver: class { constructor() {} observe() {} disconnect() {} }, window: FAKE_WINDOW });
  let processor; mod.registerMermaidZoom({ app: env.app, registerEditorExtension() {}, register() {}, registerMarkdownPostProcessor: fn => { processor = fn; } });
  const { block, host } = diagramBlock(); const svg = addSvg(host);
  svg.appendChild(bare('script'));
  svg.attrs.onload = 'alert(1)';
  const before = JSON.stringify([svg.attrs, svg.children.map(c => c.tag)]);
  processor(block, { sourcePath: 'Topics/A/Note.md', addChild() {} });
  const button = block.querySelector('button');
  button.click();
  assert.equal(openModals.length, 1);
  const modal = openModals[0];
  const stage = modal.contentEl.querySelector('.vam-mermaid-zoom-stage');
  const clone = stage.children[0];
  assert.notEqual(clone, svg);
  assert.equal(clone.attrs.onload, undefined);
  assert.equal(clone.children.some(c => c.tag === 'script'), false);
  assert.equal(JSON.stringify([svg.attrs, svg.children.map(c => c.tag)]), before, 'the original SVG is not modified');
  assert.ok(modal.modalEl.hasClass('vam-mermaid-zoom-modal'));
  assert.equal(modal.contentEl.querySelectorAll('button').length, 4);
  // close returns focus to the trigger
  node.active = null;
  modal.close();
  assert.equal(button.focused, true);
  assert.equal(modal.closeCount, 1);
});

function viewerHarness() {
  const env = mockObsidian(FILES);
  const viewerMod = load('experiences/mermaid-zoom/viewer.ts', { obsidian: env.obsidian }, { window: FAKE_WINDOW });
  const source = svgOf('svg', { viewBox: '0 0 2400 300' });
  const trigger = node('button');
  const modal = new viewerMod.MermaidZoomModal(env.app, source, trigger);
  modal.open();
  const viewport = modal.contentEl.querySelector('.vam-mermaid-zoom-viewport');
  return { modal, viewport, trigger, source, viewerMod };
}

test('mermaid zoom: the viewer opens at the readable minimum for a wide diagram and keys zoom, fit and pan', () => {
  const { modal, viewport } = viewerHarness();
  const opened = modal.currentView();
  assert.equal(opened.scale, math.MIN_READABLE_SCALE, '2400px wide in a 900px fallback viewport opens at the readable minimum');
  const key = k => modal.modalEl.fire('keydown', { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
  key('+');
  assert.ok(modal.currentView().scale > opened.scale);
  key('0');
  assert.equal(modal.currentView().scale, math.fitScale({ width: 2400, height: 300 }, { width: 900, height: 600 }));
  const fitted = modal.currentView();
  key('ArrowRight');
  assert.equal(modal.currentView().x, fitted.x - 80);
  key('ArrowDown');
  assert.equal(modal.currentView().y, fitted.y - 80);
  key('-');
  assert.ok(modal.currentView().scale < fitted.scale);
  assert.equal(viewport.focused, true, 'the canvas has focus so the keys work');
});

test('mermaid zoom: buttons fit and reset to 100%, wheel zooms around the cursor, dragging pans', () => {
  const { modal, viewport } = viewerHarness();
  const readLabel = (zh, en) => modal.contentEl.querySelectorAll('button').find(b => [zh, en].includes(b.attrs['aria-label']));
  readLabel('實際大小（100%）', 'Actual size (100%)').click();
  assert.equal(modal.currentView().scale, 1);
  readLabel('符合視窗', 'Fit to window').click();
  assert.equal(modal.currentView().scale, math.fitScale({ width: 2400, height: 300 }, { width: 900, height: 600 }));
  const before = modal.currentView();
  viewport.fire('wheel', { clientX: 110, clientY: 120, deltaY: -100, ctrlKey: false, deltaMode: 0 });
  const zoomed = modal.currentView();
  assert.ok(zoomed.scale > before.scale);
  const pointX = (100 - before.x) / before.scale; // the diagram point under the cursor stays put
  assert.ok(Math.abs((100 - zoomed.x) / zoomed.scale - pointX) < 1e-6);
  viewport.fire('pointerdown', { pointerId: 1, clientX: 50, clientY: 50 });
  viewport.fire('pointermove', { pointerId: 1, clientX: 80, clientY: 70 });
  viewport.fire('pointerup', { pointerId: 1, clientX: 80, clientY: 70 });
  assert.equal(modal.currentView().x, zoomed.x + 30);
  assert.equal(modal.currentView().y, zoomed.y + 20);
});

// ---------- zoom math ----------
test('zoom math: scale is clamped and fit respects padding and the enlargement cap', () => {
  assert.equal(math.clampScale(100), math.MAX_SCALE);
  assert.equal(math.clampScale(0), math.MIN_SCALE);
  assert.equal(math.clampScale(NaN), 1);
  assert.equal(math.fitScale({ width: 500, height: 200 }, { width: 1048, height: 448 }), 2, 'small diagrams are enlarged but capped');
  assert.equal(math.fitScale({ width: 2000, height: 1000 }, { width: 1048, height: 548 }), 0.5);
  assert.equal(math.fitScale({ width: 0, height: 0 }, { width: 10, height: 10 }), 1);
  const v = math.fitView({ width: 1000, height: 500 }, { width: 1048, height: 800 });
  assert.equal(v.scale, 1); assert.equal(v.x, 24); assert.equal(v.y, 150);
});

test('zoom math: a wide diagram opens at the readable floor, a small one at fit', () => {
  const wide = math.initialView({ width: 4800, height: 300 }, { width: 1000, height: 700 });
  assert.equal(wide.scale, math.MIN_READABLE_SCALE);
  assert.equal(wide.x, 24, 'overflowing axis starts at the padding');
  assert.equal(wide.y, (700 - 300 * 0.6) / 2, 'fitting axis is centered');
  const small = math.initialView({ width: 400, height: 300 }, { width: 1000, height: 700 });
  assert.equal(small.scale, 2);
  assert.equal(small.x, (1000 - 800) / 2);
});

test('zoom math: zooming keeps the point under the cursor fixed, clamps, and pans', () => {
  const start = { scale: 1, x: 40, y: 30 };
  const next = math.zoomAt(start, 2, 200, 100);
  assert.equal(next.scale, 2);
  assert.equal((200 - next.x) / next.scale, (200 - start.x) / start.scale);
  assert.equal((100 - next.y) / next.scale, (100 - start.y) / start.scale);
  assert.equal(math.zoomAt({ scale: 7, x: 0, y: 0 }, 5, 0, 0).scale, math.MAX_SCALE);
  assert.equal(math.zoomAt({ scale: 1, x: 5, y: 5 }, -3, 0, 0).scale, 1, 'a bad factor is ignored');
  assert.equal(JSON.stringify(math.panBy(start, 5, -5)), JSON.stringify({ scale: 1, x: 45, y: 25 }));
  const actual = math.actualSizeView({ scale: 0.5, x: 0, y: 0 }, { width: 1000, height: 600 });
  assert.equal(actual.scale, 1); assert.equal(actual.x, -500); assert.equal(actual.y, -300);
  assert.ok(math.wheelFactor(-100, false) > 1 && math.wheelFactor(100, false) < 1);
  assert.ok(math.wheelFactor(-10, true) > math.wheelFactor(-10, false), 'a pinch counts more per delta');
});

// ---------- the sanitizer ----------
test('sanitizer: scripts, handlers, scripting URLs, embedded content and animation are removed', () => {
  const tree = bare('svg', { viewBox: '0 0 10 10', onload: 'x()', 'xmlns': 'http://www.w3.org/2000/svg' }, [
    bare('script'), bare('iframe'), bare('object'), bare('embed'), bare('image', { href: 'https://evil.test/a.png' }),
    bare('animate', { onbegin: 'x()' }), bare('set'), bare('use', { href: '#a' }),
    bare('a', { 'xlink:href': 'javascript:alert(1)', href: ' jav\tascript:alert(1)' }),
    bare('a', { href: 'https://evil.test' }), bare('path', { onclick: 'x()', d: 'M0 0', fill: 'red', href: '#local' }),
    bare('style', {}, []),
    bare('g', { onmouseover: 'x()', class: 'node' }, [bare('rect', { onfocus: 'x()', width: '4' })])
  ]);
  tree.children[11].textContent = '@import url(https://evil.test/x.css); .a { fill: url(https://evil.test/i.svg); stroke: url(#grad); }';
  const out = sanitizeSvgClone(tree);
  const tags = out.children.map(c => c.localName);
  assert.equal(tags.join(), 'a,a,path,style,g');
  assert.equal(out.attrs.onload, undefined);
  assert.equal(out.attrs.xmlns, 'http://www.w3.org/2000/svg');
  assert.equal(out.children[0].attrs['xlink:href'], undefined);
  assert.equal(out.children[0].attrs.href, undefined);
  assert.equal(out.children[1].attrs.href, undefined);
  assert.equal(out.children[2].attrs.onclick, undefined);
  assert.equal(out.children[2].attrs.d, 'M0 0');
  assert.equal(out.children[2].attrs.href, '#local', 'a fragment reference inside the clone stays');
  assert.ok(!/@import|evil\.test/.test(out.children[3].textContent));
  assert.match(out.children[3].textContent, /url\(#grad\)/);
  assert.equal(out.children[4].attrs.onmouseover, undefined);
  assert.equal(out.children[4].children[0].attrs.onfocus, undefined);
  assert.equal(out.children[4].attrs.class, 'node');
});

test('sanitizer: mermaid label markup in foreignObject is kept, anything else in it removes the whole foreignObject', () => {
  const label = () => bare('foreignObject', { width: '80' }, [bare('div', { class: 'label', onclick: 'x()' }, [bare('span', { class: 'nodeLabel' }, [bare('b'), bare('br')])])]);
  const bad = bare('foreignObject', {}, [bare('div', {}, [bare('script')])]);
  const worse = bare('foreignObject', {}, [bare('iframe')]);
  const form = bare('foreignObject', {}, [bare('div', {}, [bare('a', { href: 'https://x.test' })])]);
  const out = sanitizeSvgClone(bare('svg', {}, [label(), bad, worse, form]));
  assert.equal(out.children.length, 1);
  assert.equal(out.children[0].localName.toLowerCase(), 'foreignobject');
  const div = out.children[0].children[0];
  assert.equal(div.attrs.onclick, undefined);
  assert.equal(div.attrs.class, 'label');
  assert.equal(div.children[0].children.length, 2);
});

// ---------- read-only ----------
test('mermaid zoom: opening and using the viewer never writes to the vault', () => {
  const { ctx } = openViewer();
  assert.equal(ctx.writes.length, 0);
  const dir = path.join(root, 'experiences/mermaid-zoom');
  for (const file of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(src, /\bvault\.(modify|create|delete|rename|append|process|trash)|processFrontMatter|\.adapter\.write/, file);
  }
});

test('mermaid zoom: unloading the plugin disconnects every observer', () => {
  const ctx = loadRegister(FILES);
  ctx.run(diagramBlock().block, 'Topics/A/Note.md');
  assert.equal(ctx.observers.length, 1);
  ctx.unregister();
  assert.ok(ctx.observers.every(o => o.disconnected));
});

// ---------- lifecycle and embeds ----------
test('mermaid zoom: an observer is released as soon as the diagram has its button', () => {
  const ctx = loadRegister(FILES);
  const { block, host } = diagramBlock();
  ctx.run(block, 'Topics/A/Note.md');
  assert.equal(ctx.handle.observerCount(), 1);
  addSvg(host);
  ctx.observers[0].cb();
  assert.equal(ctx.handle.observerCount(), 0);
  assert.ok(ctx.observers[0].disconnected);
});

test('mermaid zoom: a section Obsidian unloads without any further mutation releases its observer', () => {
  const ctx = loadRegister(FILES);
  for (let i = 0; i < 5; i++) ctx.run(diagramBlock().block, 'Topics/A/Note.md');
  assert.equal(ctx.handle.observerCount(), 5);
  assert.equal(ctx.children.length, 5);
  for (const child of ctx.children) child.onunload();
  assert.equal(ctx.handle.observerCount(), 0);
  assert.ok(ctx.observers.every(o => o.disconnected));
  // a diagram that is already rendered never creates an observer
  const done = diagramBlock(); addSvg(done.host);
  ctx.run(done.block, 'Topics/A/Note.md');
  assert.equal(ctx.handle.observerCount(), 0);
});

test('mermaid zoom: a plain note embedded in a VAM note is not decorated, even when its diagram renders later', () => {
  const ctx = loadRegister(FILES);
  const section = node('div', 'el-p');
  const embed = section.createEl('div', 'internal-embed markdown-embed');
  const host = embed.createDiv('mermaid');
  ctx.run(section, 'Topics/A/Note.md');
  addSvg(host);
  if (ctx.observers[0]) ctx.observers[0].cb();
  assert.equal(section.querySelectorAll('button').length, 0);
  assert.equal(host.classes.includes('vam-mermaid-scope'), false);
  // the same embed section is not turned into a scope either
  assert.equal(section.classes.includes('vam-mermaid-scope'), false);
});

test('mermaid zoom: a section rendered while detached is still decorated when its diagram appears; one removed after attaching is released', () => {
  const ctx = loadRegister(FILES);
  const { block, host } = diagramBlock();
  block.isConnected = false;
  ctx.run(block, 'Topics/A/Note.md');
  assert.equal(ctx.observers.length, 1);
  ctx.observers[0].cb();
  assert.equal(ctx.observers[0].disconnected, false, 'a detached section keeps waiting');
  addSvg(host);
  ctx.observers[0].cb();
  assert.ok(host.classes.includes('vam-mermaid-scope'));
  assert.equal(ctx.observers[0].disconnected, true);
  const second = diagramBlock();
  ctx.run(second.block, 'Topics/A/Note.md');
  second.block.isConnected = true;
  ctx.observers[1].cb();
  second.block.isConnected = false;
  ctx.observers[1].cb();
  assert.equal(ctx.observers[1].disconnected, true, 'attached and then removed without a diagram: released');
});

test('callout scope: VAM callouts get the scope class, non-VAM and embedded-note callouts do not, and the section is never marked', () => {
  const ctx = loadRegister(FILES);
  const section = node('div', 'el-div');
  const callout = section.createDiv('callout');
  const embed = section.createEl('div', 'internal-embed markdown-embed');
  const foreign = embed.createDiv('callout');
  ctx.run(section, 'Topics/A/Note.md');
  assert.ok(callout.classes.includes('vam-callout-scope'));
  assert.equal(foreign.classes.includes('vam-callout-scope'), false);
  assert.equal(section.classes.includes('vam-callout-scope'), false);
  const plain = node('div', 'el-div'); const plainCallout = plain.createDiv('callout');
  ctx.run(plain, 'Other/plain.md');
  assert.equal(plainCallout.classes.includes('vam-callout-scope'), false);
  const own = node('div', 'callout'); ctx.run(own, 'Topics/A/Note.md');
  assert.ok(own.classes.includes('vam-callout-scope'), 'a section that is itself a callout is marked');
});

test('callout scope: a live-preview watcher marks .cm-callout in a VAM note when one is added', () => {
  const ctx = loadRegister(FILES);
  const dom = node('div', 'cm-editor');
  new ctx.mod.EditorWatcher(ctx.app, dom, () => 'Topics/A/Note.md', () => {});
  const callout = dom.createDiv('cm-callout');
  ctx.observers.at(-1).cb([{ addedNodes: [callout], target: dom }]);
  assert.ok(callout.classes.includes('vam-callout-scope'));
  const plainDom = node('div', 'cm-editor');
  new ctx.mod.EditorWatcher(ctx.app, plainDom, () => 'Other/plain.md', () => {});
  const other = plainDom.createDiv('cm-callout');
  ctx.observers.at(-1).cb([{ addedNodes: [other], target: plainDom }]);
  assert.equal(other.classes.includes('vam-callout-scope'), false);
});

test('link scope: VAM links, footnote refs and back-references get the scope class; non-VAM and embedded-note links do not', () => {
  const ctx = loadRegister(FILES);
  const section = node('div', 'el-div');
  const internal = section.createEl('a', 'internal-link');
  const external = section.createEl('a', 'external-link');
  const ref = section.createEl('a', 'footnote-link');
  const back = section.createEl('a', 'footnote-backref');
  const unmarked = section.createEl('a', 'tag');
  const embed = section.createEl('div', 'internal-embed markdown-embed');
  const foreign = embed.createEl('a', 'internal-link');
  ctx.run(section, 'Topics/A/Note.md');
  for (const link of [internal, external, ref, back]) assert.ok(link.classes.includes('vam-link-scope'));
  assert.equal(unmarked.classes.includes('vam-link-scope'), false);
  assert.equal(foreign.classes.includes('vam-link-scope'), false);
  assert.equal(section.classes.includes('vam-link-scope'), false);
  const plain = node('div', 'el-div'); const plainLink = plain.createEl('a', 'internal-link');
  ctx.run(plain, 'Other/plain.md');
  assert.equal(plainLink.classes.includes('vam-link-scope'), false);
});

test('link scope: the link CSS is scoped to .vam-link-scope, never the bare anchor, and has no !important', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const rules = css.split('\n').filter(line => line.includes('vam-link-scope'));
  assert.ok(rules.length >= 3);
  for (const rule of rules) assert.ok(/a\.vam-link-scope/.test(rule), rule);
});

test('editor link scope: the watcher reports VAM notes only, and the plugin provides the class through editorAttributes, not by touching the element', () => {
  const ctx = loadRegister(FILES);
  const dom = node('div', 'cm-editor');
  const watcher = new ctx.mod.EditorWatcher(ctx.app, dom, () => 'Topics/A/Note.md', () => {});
  assert.equal(watcher.isVam, true);
  assert.equal(dom.classes.includes('vam-editor-scope'), false, 'the element class is left to CodeMirror');
  const plainDom = node('div', 'cm-editor');
  assert.equal(new ctx.mod.EditorWatcher(ctx.app, plainDom, () => 'Other/plain.md', () => {}).isVam, false);
  const src = fs.readFileSync(path.join(root, 'experiences/mermaid-zoom/register.ts'), 'utf8');
  assert.match(src, /EditorView\.editorAttributes\.of\(/);
  assert.doesNotMatch(src, /(toggleClass|addClass|removeClass)\(EDITOR_SCOPE_CLASS/);
});

test('editor link scope: the class survives CodeMirror rewriting the editor class (focus, theme) and follows a file switch', () => {
  const ctx = loadRegisterWithExtension();
  let file = { path: 'Topics/A/Note.md' };
  const { view } = ctx.fakeView(() => file);
  const plugin = ctx.extension.create(view);
  // CodeMirror merges the facet's attributes on every update; emulate that merge after it rewrites the class attribute
  const facetClass = () => (plugin.isVam ? 'vam-editor-scope' : '');
  const cmRewrite = () => { view.dom.cls = ['cm-editor', 'cm-focused', 'theme-dark', facetClass()].filter(Boolean).join(' '); };
  cmRewrite();
  assert.ok(view.dom.classes.includes('vam-editor-scope'));
  cmRewrite();
  assert.ok(view.dom.classes.includes('vam-editor-scope'), 'still there after a focus or theme rewrite');
  file = { path: 'Other/plain.md' };
  plugin.update();
  cmRewrite();
  assert.equal(view.dom.classes.includes('vam-editor-scope'), false, 'a non-VAM file drops it');
});

test('link CSS: editor rules are scoped to .vam-editor-scope; no text-decoration-style anywhere in styles.css', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const rules = css.split('\n').filter(line => line.includes(' { ') && /\.cm-hmd-internal-link|\.cm-link|\.cm-url/.test(line));
  assert.ok(rules.length >= 3);
  for (const rule of rules) assert.ok(rule.includes('.vam-editor-scope'), rule);
  assert.equal(/text-decoration-style/.test(css), false);
});

test('editor unresolved link: the opacity wrapper and the underline colour are overridden with enough specificity', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.ok(css.includes('.markdown-source-view.mod-cm6 .vam-editor-scope .is-unresolved { opacity: 1; }'));
  assert.ok(/\.markdown-source-view\.mod-cm6 \.vam-editor-scope :is\([^)]*\.is-unresolved \.cm-underline\) \{ color: color-mix/.test(css));
});

test('gantt CSS: active and done chips are light in dark themes, because mermaid forces near-black text on them', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  for (const kind of ['active', 'done']) {
    assert.ok(css.split('\n').some(l => l.startsWith('.theme-dark ') && l.includes(`.task[class*="${kind}"] {`) && l.includes('var(--text-normal))')), kind);
  }
  assert.equal(/!important/.test(css), false);
});

test('gantt CSS: bar and label colors come from theme variables, not black or white', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const rules = css.split('\n').filter(line => line.includes('aria-roledescription="gantt"') && /taskText|\.task|Outside/.test(line));
  assert.ok(rules.length >= 6);
  for (const rule of rules) assert.equal(/\b(black|white)\b|#fff|#000/i.test(rule), false, rule);
});

test('mermaid zoom: the timeline CSS targets only the diagram element, never a section', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const rules = css.split('\n').filter(line => line.includes('aria-roledescription="timeline"'));
  assert.ok(rules.length > 10);
  for (const rule of rules) assert.ok(rule.startsWith('.mermaid.vam-mermaid-scope > :is(#vam-mermaid-timeline, svg)[aria-roledescription="timeline"]'), rule.slice(0, 80));
  assert.doesNotMatch(css, /\.vam-mermaid-scope \{|\.vam-mermaid-scope :is/);
  const view = fs.readFileSync(path.join(root, 'experiences/mermaid-zoom/viewer.ts'), 'utf8');
  assert.match(view, /"vam-mermaid-zoom-stage mermaid vam-mermaid-scope"/, 'the viewer stage keeps the scope so the clone matches');
});

test('mermaid zoom: fit shows the whole diagram even below the readable minimum', () => {
  const diagram = { width: 4800, height: 300 }, viewport = { width: 1000, height: 700 };
  const fit = math.fitView(diagram, viewport);
  assert.ok(fit.scale < math.MIN_READABLE_SCALE);
  assert.ok(fit.x >= 0 && fit.x + diagram.width * fit.scale <= viewport.width + 1e-9);
  assert.ok(fit.y >= 0 && fit.y + diagram.height * fit.scale <= viewport.height + 1e-9);
  assert.ok(math.initialView(diagram, viewport).scale >= math.MIN_READABLE_SCALE, 'opening still keeps text readable');
});

test('mermaid zoom: wheel pages count, and only the primary button starts a drag', () => {
  assert.ok(math.wheelFactor(1, false, 2) < math.wheelFactor(1, false, 1));
  assert.ok(math.wheelFactor(1, false, 1) < math.wheelFactor(1, false, 0));
  const { modal, viewport } = viewerHarness();
  const before = modal.currentView();
  viewport.fire('pointerdown', { pointerId: 3, button: 2, clientX: 50, clientY: 50 });
  viewport.fire('pointermove', { pointerId: 3, button: 2, clientX: 90, clientY: 90 });
  assert.equal(JSON.stringify(modal.currentView()), JSON.stringify(before), 'a right-button drag does not pan');
  viewport.fire('pointerdown', { pointerId: 4, button: 0, clientX: 50, clientY: 50 });
  viewport.fire('pointermove', { pointerId: 4, button: 0, clientX: 90, clientY: 90 });
  assert.equal(modal.currentView().x, before.x + 40);
});

test('mermaid zoom: the viewer cleans the copy inside an inert document before adopting it', () => {
  DOC_CALLS.length = 0; INERT_DOC.imported.length = 0;
  const env = mockObsidian(FILES);
  const sanitized = [];
  const viewerMod = load('experiences/mermaid-zoom/viewer.ts', { obsidian: env.obsidian }, { window: FAKE_WINDOW });
  const source = svgOf('svg', { viewBox: '0 0 2400 300', onload: 'alert(1)' }, [svgOf('script')]);
  const modal = new viewerMod.MermaidZoomModal(env.app, source, node('button'));
  // Record what the live document is asked to import: it must already be the cleaned copy.
  const liveImport = FAKE_DOC.importNode;
  FAKE_DOC.importNode = n => { sanitized.push({ onload: n.attrs.onload, scripts: n.children.filter(c => c.tag === 'script').length, fromInert: INERT_DOC.imported.length === 1 && n !== source }); return liveImport(n); };
  try { modal.open(); } finally { FAKE_DOC.importNode = liveImport; }
  assert.equal(DOC_CALLS[0], 'createHTMLDocument');
  assert.equal(INERT_DOC.imported.length, 1, 'the copy is made by the inert document');
  assert.equal(INERT_DOC.imported[0], source, 'the inert document imports the original source');
  assert.equal(sanitized.length, 1, 'the live document imports once');
  assert.deepEqual(sanitized[0], { onload: undefined, scripts: 0, fromInert: true }, 'what the live document adopts was sanitized in the inert copy');
  assert.equal(source.attrs.onload, 'alert(1)', 'the note SVG is untouched');
  assert.ok(modal.contentEl.querySelector('.vam-mermaid-zoom-stage'));
});

test('sanitizer: stylesheets with escapes or image-set and presentation-attribute urls are dropped', () => {
  const style = text => { const n = bare('style'); n.textContent = text; return n; };
  const tree = bare('svg', {}, [
    style('.a { background: \\75rl(https://evil.test/x) }'),
    style('.a { fill: image-set("https://evil.test/x.png" 1x) }'),
    style('.a { fill: red; } #m .b { stroke: url(#grad) }'),
    bare('rect', { fill: 'url(https://evil.test/p.svg#x)', stroke: 'url(#ok)', filter: "url('//evil.test/f.svg#f')" }),
    bare('g', { style: 'fill: url(https://evil.test/a)' }),
    bare('g', { style: 'background: image-set(x 1x)' })
  ]);
  const out = sanitizeSvgClone(tree);
  assert.equal(out.children[0].textContent, '');
  assert.equal(out.children[1].textContent, '');
  assert.match(out.children[2].textContent, /fill: red/);
  assert.match(out.children[2].textContent, /url\(#grad\)/);
  assert.equal(out.children[3].attrs.fill, undefined);
  assert.equal(out.children[3].attrs.filter, undefined);
  assert.equal(out.children[3].attrs.stroke, 'url(#ok)');
  assert.ok(!/evil/.test(out.children[4].attrs.style ?? ''));
  assert.equal(out.children[5].attrs.style, undefined);
});

// ---------- live preview: one watcher per editor view ----------
test('mermaid zoom: a live-preview editor in a VAM note gets buttons, and the watcher ends with the editor', () => {
  const ctx = loadRegister(FILES);
  const dom = node('div', 'cm-editor');
  const widget = dom.createDiv('cm-preview-code-block');
  const host = widget.createDiv('mermaid');
  let destroyed = 0;
  const watcher = new ctx.mod.EditorWatcher(ctx.app, dom, () => 'Topics/A/Note.md', () => { destroyed++; });
  assert.equal(host.querySelector('button'), null, 'nothing to decorate before mermaid renders');
  const svg = addSvg(host);
  ctx.observers.at(-1).cb([{ addedNodes: [svg], target: host }]);
  assert.equal(host.querySelectorAll('button').length, 1);
  assert.ok(host.classes.includes('vam-mermaid-scope'));
  assert.equal(dom.classes.includes('vam-mermaid-scope'), false);
  watcher.destroy();
  assert.equal(destroyed, 1);
  assert.ok(ctx.observers.at(-1).disconnected);
});

test('mermaid zoom: a live-preview editor of a non-VAM note, or an unknown file, is left alone; embeds are skipped', () => {
  const ctx = loadRegister(FILES);
  for (const file of ['Other/plain.md', undefined]) {
    const dom = node('div', 'cm-editor'); const host = dom.createDiv('mermaid'); addSvg(host);
    const watcher = new ctx.mod.EditorWatcher(ctx.app, dom, () => file, () => {});
    ctx.observers.at(-1).cb([{ addedNodes: [host.children[0]], target: host }]);
    assert.equal(host.querySelector('button'), null);
    watcher.destroy();
  }
  const dom = node('div', 'cm-editor'); const embed = dom.createDiv('internal-embed'); const host = embed.createDiv('mermaid'); addSvg(host);
  new ctx.mod.EditorWatcher(ctx.app, dom, () => 'Topics/A/Note.md', () => {});
  assert.equal(host.querySelector('button'), null, 'an embedded note is judged by its own path, not the host note');
});

test('mermaid zoom: typing in the editor never scans; only diagram changes do', () => {
  const ctx = loadRegister(FILES);
  const dom = node('div', 'cm-editor');
  const line = dom.createDiv('cm-line');
  const embed = dom.createDiv('cm-embed-block');
  const host = embed.createDiv('mermaid');
  let queries = 0;
  const count = n => { const original = n.querySelectorAll.bind(n); n.querySelectorAll = sel => { queries++; return original(sel); }; };
  const watcher = new ctx.mod.EditorWatcher(ctx.app, dom, () => 'Topics/A/Note.md', () => {});
  count(dom); count(embed); count(host);
  const observer = ctx.observers.at(-1);
  const text = { localName: '#text', parent: line, parentElement: line };
  for (let i = 0; i < 20; i++) {
    observer.cb([{ addedNodes: [text], target: line }, { addedNodes: [], target: text }]);
    watcher.onUpdate();
  }
  assert.equal(queries, 0, 'plain text mutations and state updates never call querySelectorAll');
  const svg = addSvg(host);
  observer.cb([{ addedNodes: [svg], target: host }]);
  assert.ok(queries > 0, 'an added svg does scan');
  assert.equal(host.querySelectorAll('button').length, 1);
  queries = 0;
  observer.cb([{ addedNodes: [], target: embed }]);
  assert.ok(queries > 0, 'a change inside an embed block scans');
  queries = 0;
  const other = { path: 'Topics/A/Map.md' };
  const w2 = new ctx.mod.EditorWatcher(ctx.app, dom, () => other.path, () => {});
  count(dom); queries = 0;
  w2.onUpdate();
  assert.equal(queries, 0, 'same file: no scan');
  other.path = 'Topics/A/Note.md';
  w2.onUpdate();
  assert.ok(queries > 0, 'a changed file path scans');
});

// ---------- the ViewPlugin wrapper ----------
function loadRegisterWithExtension() {
  const env = mockObsidian(FILES);
  const field = env.obsidian.editorInfoField;
  const observers = [];
  class FakeObserver { constructor(cb) { this.cb = cb; this.disconnected = false; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } }
  const mod = load('experiences/mermaid-zoom/register.ts', { obsidian: env.obsidian }, { MutationObserver: FakeObserver, window: FAKE_WINDOW });
  let extension = null; let unregister = null;
  const handle = mod.registerMermaidZoom({ app: env.app, registerEditorExtension: e => { extension = e; }, register: fn => { unregister = fn; }, registerMarkdownPostProcessor() {} });
  const fakeView = (file) => {
    const reads = [];
    const view = { dom: node('div', 'cm-editor'), state: { field: (f, required) => { reads.push([f, required]); return { file: file() }; } } };
    return { view, reads };
  };
  return { env, field, observers, handle, extension, unregister: () => unregister(), fakeView };
}

test('mermaid zoom: the editor extension counts editors, reads the path through editorInfoField, and unload disconnects all', () => {
  const ctx = loadRegisterWithExtension();
  assert.ok(ctx.extension, 'an editor extension was registered');
  let file = { path: 'Topics/A/Note.md' };
  const a = ctx.fakeView(() => file), b = ctx.fakeView(() => ({ path: 'Topics/A/Map.md' }));
  const hostA = a.view.dom.createDiv('mermaid'); addSvg(hostA);
  assert.equal(ctx.handle.editorCount(), 0);
  const pluginA = ctx.extension.create(a.view);
  assert.equal(ctx.handle.editorCount(), 1);
  const pluginB = ctx.extension.create(b.view);
  assert.equal(ctx.handle.editorCount(), 2);
  assert.ok(a.reads.length > 0 && a.reads.every(([f, required]) => f === ctx.field && required === false), 'the path is read through editorInfoField, optionally');
  assert.equal(hostA.querySelectorAll('button').length, 1, 'constructing the plugin scans the editor');
  const readsBefore = a.reads.length;
  file = { path: 'Topics/A/Map.md' };
  pluginA.update();
  assert.ok(a.reads.length > readsBefore, 'update re-reads the path');
  pluginA.destroy();
  assert.equal(ctx.handle.editorCount(), 1, 'destroying an editor drops its watcher');
  assert.ok(ctx.observers[0].disconnected, 'its observer is disconnected');
  assert.equal(ctx.observers[1].disconnected, false);
  ctx.unregister();
  assert.equal(ctx.handle.editorCount(), 0);
  assert.ok(ctx.observers.every(o => o.disconnected), 'unload disconnects every observer');
  void pluginB;
});

test('mermaid zoom: a cached embed block re-inserted whole (rendered while detached) still gets its button', () => {
  const ctx = loadRegister(FILES);
  const dom = node('div', 'cm-editor');
  new ctx.mod.EditorWatcher(ctx.app, dom, () => 'Topics/A/Note.md', () => {});
  const embed = node('div', 'cm-embed-block'); const host = embed.createDiv('mermaid'); addSvg(host);
  dom.appendChild(embed);
  assert.equal(host.querySelector('button'), null);
  ctx.observers.at(-1).cb([{ addedNodes: [embed], target: dom }]);
  assert.equal(host.querySelectorAll('button').length, 1);
});

test('mermaid zoom css: live preview moves the button left of Obsidian\'s edit button; reading view stays top-right', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }));
  const base = rules.find(r => r.sel === '.vam-mermaid-zoom-btn');
  assert.match(base.body, /top:\s*6px/); assert.match(base.body, /right:\s*6px/); assert.match(base.body, /position:\s*absolute/);
  const lp = rules.find(r => r.sel === '.cm-embed-block .vam-mermaid-zoom-btn');
  assert.ok(lp, 'a live-preview-only rule exists');
  assert.match(lp.body, /right:\s*calc\(var\(--vam-embed-edit-right\)\s*\+\s*var\(--vam-embed-edit-width\)\s*\+\s*var\(--vam-embed-edit-gap\)\)/);
  assert.match(lp.body, /width:\s*var\(--vam-embed-edit-width\)/); assert.match(lp.body, /height:\s*var\(--vam-embed-edit-height\)/);
  const vars = rules.find(r => r.sel === '.cm-embed-block').body;
  for (const v of ['top', 'right', 'width', 'height', 'gap']) assert.match(vars, new RegExp(`--vam-embed-edit-${v}:\\s*\\d+px`));
  assert.equal(css.split('.vam-mermaid-zoomable:focus-within > .vam-mermaid-zoom-btn,').length - 1, 1, 'no duplicated selector');
  assert.ok(rules.some(r => r.sel.includes('.cm-embed-block:hover .vam-mermaid-zoom-btn') && /opacity:\s*1/.test(r.body)), 'the group shows together on hover');
});
