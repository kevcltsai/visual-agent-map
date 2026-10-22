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

test('outline import refuses a pasted title that would break the note, with the reason, and never rewrites it (D-2026-10-95)', () => {
  const { parseOutline, sanitizeOutlineDraft } = load('experiences/visual-map/outline-import.ts', { obsidian });
  const fence = parseOutline('# Fence \\`\\`\\` here\n## ok');
  assert.deepEqual([...fence.errors.map(e => `${e.key}:${e.line}`)], ['ui.outline_error_title_fence:1']);
  assert.equal(fence.nodes[0].title, 'Fence ``` here', 'the text is reported as typed, not cleaned');
  const brackets = parseOutline('# Root\n## half [[ open\n## close ]] half');
  assert.deepEqual([...brackets.errors.map(e => `${e.key}:${e.line}`)], ['ui.outline_error_title_brackets:2', 'ui.outline_error_title_brackets:3']);
  assert.equal(parseOutline('# Root\n## #tag [x] `code`').errors.length, 0);
  // An AI draft is cleaned before it reaches the outline box; headings that are fine and all other lines stay as they were.
  const draft = '```markdown\n# Fence \\`\\`\\` and [[L]] [[\n## child \\`\\`\\` fence\n## [[Note|Alias]] kept\nplain ``` text\n```';
  const cleaned = sanitizeOutlineDraft(draft);
  assert.equal(cleaned, '```markdown\n# Fence  and L [\n## child  fence\n## [[Note|Alias]] kept\nplain ``` text\n```');
  assert.equal(parseOutline(cleaned).errors.length, 0);
  assert.equal(parseOutline(sanitizeOutlineDraft('# a [[ b')).errors.length, 0);
});

test('AIM start refuses an unsafe topic before anything is written (D-2026-10-95)', async () => {
  const { createAimMap } = load('experiences/aim/create-map.ts', { obsidian });
  const { repo } = fixture('en');
  const before = (await repo.mapFiles()).length;
  await assert.rejects(
    createAimMap(repo, 'gpt-6-luna', { topic: 'Topic ``` x', context: '', requestId: 'r1' }),
    /three backticks/
  );
  await assert.rejects(
    createAimMap(repo, 'gpt-6-luna', { topic: 'Topic [[x]]', context: '', requestId: 'r2' }),
    /\[\[ or \]\]/
  );
  assert.equal((await repo.mapFiles()).length, before);
});
