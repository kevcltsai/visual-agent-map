// Book figures renderer: the whitelist builder and the fallback (a small DOM stand-in for SVG elements and the host block).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const S = require('./support.cjs');

const reg = load('experiences/book-figures/register.ts', { obsidian: S.obsidian });
const layout = S.load('core/book-pipeline/figure-layout.ts');
const spec = S.load('core/book-pipeline/figure-spec.ts');

class El {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.textContent = null; this.classes = []; }
  setAttribute(n, v) { this.attrs[n] = v; }
  appendChild(c) { this.children.push(c); return c; }
  addClass(...n) { this.classes.push(...n); }
  empty() { this.children = []; }
  createEl(tag, o = {}) { const e = new El(tag); e.textContent = o.text ?? null; if (o.cls) e.classes.push(o.cls); this.children.push(e); return e; }
  createDiv(o) { return this.createEl('div', o); }
}
const doc = { createElementNS: (ns, tag) => { const e = new El(tag); e.ns = ns; return e; } };
const host = () => Object.assign(new El('div'), { ownerDocument: doc });
const all = (e, out = []) => (out.push(e), e.children.forEach(c => all(c, out)), out);
const GOOD = '{"type":"bar","unit":"%","stacked":false,"groups":[{"label":"甲","values":[{"value":"25"}]}]}';

test('builder: whitelisted tags only, svg namespace, attributes from the tree, text through textContent', () => {
  const tree = { tag: 'svg', attrs: { viewBox: '0 0 480 100', class: 'vam-figure-svg' }, children: [
    { tag: 'text', attrs: { x: 1, class: 'fig-text' }, text: '<img onerror=x>', children: [] },
    { tag: 'script', attrs: {}, children: [{ tag: 'rect', attrs: {}, children: [] }] },
    { tag: 'foreignObject', attrs: {}, children: [] },
    { tag: 'rect', attrs: { x: 1, width: NaN, onclick: 'x()', href: 'javascript:1', style: 'a:b', 'xlink:href': 'u', class: 'fig-bar-0', fill: 'url(http://e)', 'data-x': 'a', foo: 'b' }, children: [] }] };
  const svg = reg.buildFigureElement(tree, doc, 7);
  assert.equal(svg.ns, 'http://www.w3.org/2000/svg');
  const tags = all(svg).map(e => e.tag);
  assert.deepEqual([...tags], ['svg', 'text', 'rect']);
  assert.equal(svg.children[0].textContent, '<img onerror=x>');
  assert.deepEqual({ ...svg.children[1].attrs }, { x: '1', class: 'fig-bar-0' });
  assert.equal(reg.buildFigureElement({ tag: 'script', attrs: {}, children: [] }, doc, 7), undefined);
});

test('render: a good figure becomes one svg with the figure class on the host; every layout tree passes through the whitelist untouched', () => {
  const h = host();
  reg.renderFigure(GOOD, h);
  assert.deepEqual([...h.classes], ['vam-figure']);
  assert.equal(h.children.length, 1);
  assert.equal(h.children[0].tag, 'svg');
  const s = spec.parseFigure(GOOD).spec;
  const tree = layout.layoutFigure(s);
  assert.equal(all(h.children[0]).length, JSON.stringify(tree).split('"tag"').length - 1, 'nothing of the layout is dropped');
});

test('render: a broken or unknown source shows the source as text plus one line, and never throws', () => {
  for (const source of ['{broken', '{"type":"pie"}', '[]', '', '{"type":"bar","stacked":false,"groups":[]}']) {
    const h = host();
    assert.doesNotThrow(() => reg.renderFigure(source, h));
    assert.deepEqual(h.children.map(c => c.tag), ['pre', 'div']);
    assert.equal(h.children[0].textContent, source);
    assert.ok(h.children[1].textContent.length > 0);
  }
});

test('builder: marker id and marker-end share a per-figure suffix; an unknown attribute name is dropped', () => {
  const tree = { tag: 'svg', attrs: { viewBox: '0 0 1 1', bogus: '1' }, children: [
    { tag: 'marker', attrs: { id: 'vam-ah' }, children: [] },
    { tag: 'line', attrs: { 'marker-end': 'url(#vam-ah)' }, children: [] }] };
  const svg = reg.buildFigureElement(tree, doc, 3);
  assert.equal(svg.attrs.bogus, undefined);
  assert.equal(svg.children[0].attrs.id, 'vam-ah-3');
  assert.equal(svg.children[1].attrs['marker-end'], 'url(#vam-ah-3)');
});

test('render: the line after the block becomes the svg title; no section info or no caption gives none', () => {
  const titleOf = h => all(h.children[0]).find(e => e.tag === 'title');
  const ctx = (text, lineEnd) => ({ getSectionInfo: () => ({ text, lineStart: 0, lineEnd }) });
  let h = host();
  reg.renderFigure(GOOD, h, ctx('```vam-figure\nx\n```\n圖 1 營收\n', 2));
  assert.equal(titleOf(h).textContent, '圖 1 營收');
  assert.equal(h.children[0].attrs.role, 'img');
  h = host(); reg.renderFigure(GOOD, h, ctx('```vam-figure\nx\n```\n', 2));
  assert.equal(titleOf(h), undefined);
  h = host(); reg.renderFigure(GOOD, h, { getSectionInfo: () => null });
  assert.equal(titleOf(h), undefined);
  h = host(); reg.renderFigure(GOOD, h, { getSectionInfo: () => { throw new Error('x'); } });
  assert.equal(titleOf(h), undefined);
  h = host(); reg.renderFigure(GOOD, h);
  assert.equal(titleOf(h), undefined);
});
