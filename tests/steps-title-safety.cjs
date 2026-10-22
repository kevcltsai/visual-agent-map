// FG20-13b: titles that would break the note (``` , [[ , ]]) are refused in dialogs and cleaned when the AI wrote them (D-2026-10-92).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, obsidian, fixture } = require('./support.cjs');
const { titleProblem, sanitizeGeneratedTitle } = load('core/title-safety.ts', { obsidian });

test('titleProblem refuses ```, [[ and ]] and allows #, single brackets and plain text', () => {
  assert.equal(titleProblem('Fence ``` here'), 'fence');
  assert.equal(titleProblem('a [[Link]] b'), 'brackets');
  assert.equal(titleProblem('half [[ open'), 'brackets');
  assert.equal(titleProblem('half ]] close'), 'brackets');
  assert.equal(titleProblem('#核心 [tag] `code` ``two``'), undefined);
  assert.equal(titleProblem('溫度'), undefined);
});

test('sanitizeGeneratedTitle removes ``` and turns [[ and ]] into single brackets', () => {
  assert.equal(sanitizeGeneratedTitle('Fence ``` and [[L]] #t'), 'Fence  and [L] #t');
  assert.equal(sanitizeGeneratedTitle('[[[x]]]'), '[x]');
  assert.equal(sanitizeGeneratedTitle('plain `x` title'), 'plain `x` title');
  assert.equal(titleProblem(sanitizeGeneratedTitle('``` [[ ]] ````')), undefined);
});

const element = (tag, options = {}) => ({
  tag, text: options.text, value: options.value ?? '', cls: options.cls ?? '', attr: {}, children: [], disabled: false,
  createDiv(v) { const c = element('div', typeof v === 'string' ? { cls: v } : v); this.children.push(c); return c; },
  createEl(n, v) { const c = element(n, v); this.children.push(c); return c; },
  createSpan(v) { const c = element('span', v); this.children.push(c); return c; },
  addClass(n) { this.cls = `${this.cls} ${n}`.trim(); }, setText(v) { this.text = v; }, setAttr(n, v) { this.attr[n] = v; },
  addEventListener(n, h) { this[n] = h; }, focus() {}, select() {}
});
const all = (root, pred) => [...(pred(root) ? [root] : []), ...root.children.flatMap(c => all(c, pred))];
class Modal { constructor() { this.titleEl = element('title'); this.contentEl = element('content'); this.modalEl = element('modal'); this.modalEl.children.push(this.contentEl); } close() { this.closed = true; } }

test('name dialog (new card, rename, new map, rename map) refuses unsafe titles with a reason and never rewrites them', () => {
  const { NameModal } = load('ui/modals/name-modal.ts', { obsidian: { ...obsidian, Modal } });
  const saved = [];
  const modal = new NameModal({}, 'New topic name', 'Heat', v => saved.push(v));
  modal.onOpen();
  const input = all(modal.contentEl, i => i.tag === 'input')[0];
  const save = all(modal.modalEl, i => i.tag === 'button' && i.text === 'Save')[0];
  const status = all(modal.modalEl, i => i.cls.includes('vam-next-status'))[0];
  const enter = () => input.keydown({ key: 'Enter', isComposing: false, preventDefault() {}, stopPropagation() {} });
  input.value = 'Fence ``` x'; input.input();
  assert.equal(save.disabled, true); assert.match(status.text, /three backticks/);
  enter(); assert.deepEqual(saved, []); assert.notEqual(modal.closed, true);
  input.value = '#核心 [[x]]'; input.input();
  assert.equal(save.disabled, true); assert.match(status.text, /\[\[ or \]\]/);
  enter(); assert.deepEqual(saved, []);
  input.value = '#核心 [x]'; input.input();
  assert.equal(save.disabled, false); assert.equal(status.text, '');
  enter(); assert.deepEqual(saved, ['#核心 [x]']);
});

test('the AI merge title is cleaned (result and fallback)', () => {
  const dom = require('./support-dom.cjs');
  const merge = load('experiences/visual-map/merge-topics.ts', { obsidian: { ...obsidian, Modal: dom.makeModal() } });
  assert.equal(merge.mergeTitleFromResult({ suggestions: [{ title: 'Merged ``` [[A]]' }] }, 'First'), 'Merged [A]');
  assert.equal(merge.mergeTitleFromResult({}, 'F ``` [[x]]'), 'F  [x]');
});

test('outline import (AI/pasted outline) writes cleaned titles into the H1 and the map title', async () => {
  const { createOutlineMap } = load('experiences/visual-map/outline-import.ts', { obsidian });
  const { repo } = fixture('en');
  const nodes = [
    { level: 1, title: 'Fence ``` and [[L]]', parent: null, line: 1 },
    { level: 2, title: 'child ``` fence', parent: 0, line: 2 }
  ];
  const result = await createOutlineMap(repo, 'gpt-6-luna', nodes, null, new Date('2026-10-13T09:00:00+08:00'));
  assert.equal(result.failure, undefined);
  const map = await repo.readMap(result.mapPath);
  assert.equal(map.title, 'Fence  and [L]');
  const notes = await Promise.all(map.nodes.map(n => repo.readNote(n.path)));
  assert.deepEqual(notes.map(n => n.title), ['Fence  and [L]', 'child  fence']);
});
