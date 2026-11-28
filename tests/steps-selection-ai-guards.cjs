// E5 (P2.9): selection AI guards — accept refuses when the note moved, prompts carry only the selection and nearby text, an unlocatable selection keeps copy.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const S = require('./support.cjs');

const { t } = S.load('i18n.ts');

class FakeElement {
  constructor(tag = 'div') { Object.assign(this, { tag, children: [], style: {}, listeners: {}, attrs: {}, hidden: false, value: '', disabled: false, textContent: '', isConnected: true, scrollHeight: 100, cls: '', dataset: {} }); }
  createEl(tag, options = {}) { const child = new FakeElement(tag); child.cls = options.cls ?? ''; child.textContent = options.text ?? ''; Object.assign(child.attrs, options.attr); this.children.push(child); return child; }
  createDiv(options) { return this.createEl('div', options); }
  createSpan(options) { return this.createEl('span', options); }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  setText(text) { this.textContent = text; }
  toggleClass(name, on) { const set = new Set(this.cls.split(' ').filter(Boolean)); if (on) set.add(name); else set.delete(name); this.cls = [...set].join(' '); }
  addClass(name) { this.toggleClass(name, true); }
  setAttribute(name, value) { this.attrs[name] = value; }
  empty() { this.children = []; }
  getBoundingClientRect() { return { left: 0, right: 100, top: 0, bottom: 20, width: 100, height: 20 }; }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelector(selector) { return this.descendants().find(item => item.cls.split(' ').includes(selector.replace(/^\./, ''))) ?? new FakeElement(); }
  querySelectorAll() { return []; }
  contains() { return true; }
  closest() { return null; }
  focus() {}
  remove() {}
}


const HEAD = 'HEAD_MARKER_UNIQUE';
const TAIL = 'TAIL_MARKER_UNIQUE';
const SELECTED = 'Selected words here.';
const filler = n => 'filler sentence for padding. '.repeat(n);
const LONG = `${HEAD} ${filler(60)}near before. ${SELECTED} near after. ${filler(60)}${TAIL}`;

function setup({ markdown = LONG, selected = SELECTED, cursorAt, run }) {
  const state = { markdown, replaced: [], copied: [] };
  const listeners = {};
  class Component {
    load() { this.onload?.(); }
    unload() { this.onunload?.(); }
    registerDomEvent(target, type, listener) { (listeners[type] ??= []).push(listener); }
    registerEvent() {}
    addChild(child) { child.load(); return child; }
  }
  class MarkdownView {}
  class HTMLImageElement { closest() { return null; } getBoundingClientRect() { return { left: 0, right: 10, top: 0, bottom: 10, width: 10, height: 10 }; } }
  class Setting { addButton(build) { const button = { setButtonText() { return button; }, setCta() { return button; }, onClick() { return button; } }; build(button); return this; } }
  const obsidian = { Component, MarkdownView, MarkdownRenderer: { render: async () => {} }, Notice: class {}, Setting, setIcon() {}, Platform: { isMacOS: true }, requestUrl: async () => ({ json: {} }) };
  const globals = {
    HTMLElement: FakeElement, HTMLImageElement, HTMLTextAreaElement: class {}, HTMLButtonElement: class {},
    document: { activeElement: null },
    navigator: { clipboard: { writeText: async text => { state.copied.push(text); } } },
    createEl: () => { const img = { naturalWidth: 10, set src(v) { if (v) setTimeout(() => img.onload?.(), 0); } }; return img; },
    window: { getSelection: () => null, innerWidth: 1000, innerHeight: 800, requestAnimationFrame: callback => callback(), setTimeout, clearTimeout }
  };
  const { MarkdownSelectionAi } = load('experiences/markdown-context/selection-ai.ts', { obsidian }, globals);
  const view = Object.assign(new MarkdownView(), {
    file: { path: 'Note.md' }, containerEl: new FakeElement(), getMode: () => 'source',
    editor: {
      getValue: () => state.markdown, getSelection: () => selected, getCursor: () => ({ line: 0, ch: 0 }),
      posToOffset: () => cursorAt ?? (state.markdown.startsWith(selected) ? 0 : state.markdown.indexOf(selected)),
      replaceRange(value) { state.replaced.push(value); }
    }
  });
  const app = {
    workspace: { containerEl: new FakeElement(), getLeavesOfType: () => [{ view }], getActiveViewOfType: () => view, on: () => ({}) },
    metadataCache: { getFirstLinkpathDest: () => null }
  };
  const ai = new MarkdownSelectionAi(app, { model: () => 'm', autoOpen: () => true, language: () => 'English', run, translateTarget: () => 'English' });
  ai.load();
  ai.openForSelection(false);
  return { ai, state, view, panel: ai.panel, click: (button) => button.listeners.click[0]() };
}

const plan = (action, extra = {}) => JSON.stringify({ action, instruction: 'do it', query: 'q', placement: 'replace', captionInstruction: '', ...extra });

async function draftWith(opts, action = 'transform') {
  const prompts = [];
  const env = setup({ ...opts, run: async step => { prompts.push(step.prompt); return step.step.id.includes('plan') ? plan(action) : 'AI DRAFT'; } });
  await env.panel.generate('do it', 'Run');
  env.prompts = prompts;
  return env;
}

test('accept refuses and leaves the note untouched when the note changed after the preview', async () => {
  const env = await draftWith({});
  assert.equal(env.panel.output.value, 'AI DRAFT');
  // Same text, different revision: any edit elsewhere in the note.
  env.state.markdown = `${env.state.markdown} edited`;
  env.click(env.panel.accept);
  assert.equal(env.panel.status.textContent, t('ui.context_ai_note_changed'));
  assert.deepEqual(env.state.replaced, []);
  assert.equal(env.state.markdown.endsWith(' edited'), true);
});

test('accept refuses when the selected text differs from what the preview was made for', async () => {
  const env = await draftWith({});
  env.state.markdown = env.state.markdown.replace(SELECTED, 'Selected words changed.');
  env.click(env.panel.accept);
  assert.equal(env.panel.status.textContent, t('ui.context_ai_note_changed'));
  assert.deepEqual(env.state.replaced, []);
});

test('control: an unchanged note accepts and replaces once', async () => {
  const env = await draftWith({});
  env.click(env.panel.accept);
  assert.deepEqual(env.state.replaced, ['AI DRAFT']);
});

for (const [name, action] of [['general (transform)', 'transform'], ['plan only', 'clarify']]) {
  test(`prompt for ${name} carries the selection and nearby text, not the whole note`, async () => {
    const env = await draftWith({}, action);
    assert.ok(env.prompts.length >= 1);
    for (const prompt of env.prompts) {
      assert.ok(prompt.includes(SELECTED));
      assert.ok(!prompt.includes(HEAD) && !prompt.includes(TAIL), 'whole note leaked into the prompt');
      assert.ok(prompt.length < 600 * 2 + SELECTED.length + 6000, 'prompt far larger than selection plus context');
    }
    assert.ok(env.prompts[0].includes('near before.') && env.prompts[0].includes('near after.'));
  });
}

test('every prompt of a search-and-caption request omits the whole note', async () => {
  const prompts = [];
  const env = setup({
    run: async step => {
      prompts.push({ id: step.step.id, prompt: step.prompt });
      if (step.step.id.includes('plan')) return plan('image_search', { captionInstruction: 'short caption' });
      if (step.step.id.includes('caption')) return 'A CAPTION';
      return JSON.stringify({ images: [{ imageUrl: 'https://example.com/a.png', sourceUrl: 'https://example.com/p', title: 'A' }] });
    }
  });
  await env.panel.generate('find image', 'Run');
  assert.ok(prompts.some(p => p.id.includes('caption')), 'caption step must have run');
  assert.ok(env.panel.output.value.includes('A CAPTION'));
  for (const { prompt } of prompts) assert.ok(!prompt.includes(HEAD) && !prompt.includes(TAIL));
});

for (const [name, markdown, selected, cursorAt] of [
  ['selection appears twice (unlocatable)', `${SELECTED} middle ${SELECTED}`, SELECTED, 3],
  ['selection no longer in the source (unlocatable)', 'Totally different note.', SELECTED, 0]
]) {
  test(`${name}: replace and insert are refused, copy still hands out the preview`, async () => {
    const env = await draftWith({ markdown, selected, cursorAt });
    assert.equal(env.panel.output.value, 'AI DRAFT');
    assert.equal(env.panel.snapshot.matchAt, -1);
    env.click(env.panel.accept);
    assert.equal(env.panel.status.textContent, t('ui.context_ai_replace_unavailable'));
    env.click(env.panel.insertHere);
    assert.equal(env.panel.status.textContent, t('ui.context_ai_replace_unavailable'));
    assert.deepEqual(env.state.replaced, []);
    assert.equal(env.state.markdown, markdown);
    env.click(env.panel.copy);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(env.state.copied, ['AI DRAFT']);
    assert.equal(env.panel.status.textContent, t('ui.context_ai_copied'));
  });
}
