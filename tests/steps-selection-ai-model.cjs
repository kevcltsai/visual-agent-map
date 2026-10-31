// MS-05 P5a: the selection AI panel reads the current model when a run starts (not when it opens), the image-translate
// action warns beforehand under a Claude model, and the sample copy and the panel go through plugin.currentModelChoice().
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./support-replay.cjs');

const root = path.resolve(__dirname, '..');

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

function setup(modelRef) {
  const listeners = {};
  class Component {
    load() { this.onload?.(); }
    unload() { this.onunload?.(); }
    registerDomEvent(target, type, listener) { (listeners[type] ??= []).push(listener); }
    registerEvent() {}
    addChild(child) { child.load(); return child; }
  }
  class MarkdownView {}
  class HTMLImageElement { constructor() { this.alt = 'image'; this.src = ''; this.currentSrc = ''; this.isConnected = true; } getAttribute() { return null; } closest() { return null; } getBoundingClientRect() { return { left: 0, right: 10, top: 0, bottom: 10, width: 10, height: 10 }; } }
  class Setting { addButton(build) { const button = { setButtonText() { return button; }, setCta() { return button; }, onClick() { return button; } }; build(button); return this; } }
  const obsidian = { Component, MarkdownView, MarkdownRenderer: { render: async () => {} }, Notice: class {}, Setting, setIcon() {}, Platform: { isMacOS: true }, requestUrl: async () => ({ json: {} }) };
  const globals = {
    HTMLElement: FakeElement, HTMLImageElement, HTMLTextAreaElement: class {}, HTMLButtonElement: class {},
    document: { activeElement: null },
    window: { getSelection: () => null, innerWidth: 1000, innerHeight: 800, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout, clearTimeout }
  };
  const { MarkdownSelectionAi } = load('experiences/markdown-context/selection-ai.ts', { obsidian }, globals);
  const markdown = 'Intro. Selected words here. Outro.';
  const selected = 'Selected words here.';
  const view = Object.assign(new MarkdownView(), {
    file: { path: 'Note.md' }, containerEl: new FakeElement(), getMode: () => 'source',
    editor: { getValue: () => markdown, getSelection: () => selected, getCursor: () => ({ line: 0, ch: 0 }), posToOffset: () => markdown.indexOf(selected), replaceRange() {} }
  });
  const app = {
    workspace: { containerEl: new FakeElement(), getLeavesOfType: () => [{ view }], getActiveViewOfType: () => view, on: () => ({}) },
    metadataCache: { getFirstLinkpathDest: () => null }
  };
  const sentModels = [];
  const ai = new MarkdownSelectionAi(app, { model: () => modelRef.value, imageNeedsCodex: () => modelRef.value.startsWith('claude:'), autoOpen: () => true, language: () => 'English', run: async (_prepared, model) => { sentModels.push(model); return ''; } });
  ai.load();
  const fire = (type, event = {}) => { for (const listener of listeners[type] ?? []) listener(event); };
  return { ai, app, fire, sentModels, image: new HTMLImageElement() };
}

const pressFirstPreset = async app => {
  const panel = app.workspace.containerEl.children.find(item => item.cls === 'vam-context-ai-panel');
  panel.descendants().find(item => item.cls === 'vam-context-ai-presets').children[0].listeners.click[0]();
  for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
};

test('a panel left open sends the model that is current when the run starts, Codex then Claude', async () => {
  const modelRef = { value: 'gpt-5.6-luna' };
  const { ai, app, sentModels } = setup(modelRef);
  assert.equal(ai.openForSelection(false), true);
  modelRef.value = 'claude:sonnet';
  await pressFirstPreset(app);
  assert.ok(sentModels.length >= 1, 'a model call was made');
  assert.equal(sentModels[0], 'claude:sonnet', 'the run used the model chosen after the panel opened');
  assert.ok(sentModels.every(model => model === 'claude:sonnet'));
});

test('a panel opened under Codex still sends Codex when the model did not change', async () => {
  const modelRef = { value: 'gpt-5.6-luna' };
  const { ai, app, sentModels } = setup(modelRef);
  ai.openForSelection(false);
  await pressFirstPreset(app);
  assert.equal(sentModels[0], 'gpt-5.6-luna');
});

const hintOf = app => {
  const popover = app.workspace.containerEl.children.find(item => item.cls.includes('vam-image-action-popover'));
  assert.ok(popover, 'the translate popover is open');
  return popover.descendants().find(item => item.cls === 'vam-image-action-hint');
};
const openPopover = (app, fire, image) => {
  fire('click', { target: image });
  const pill = app.workspace.containerEl.children.find(item => item.cls.includes('vam-image-action-pill'));
  pill.listeners.click[0]();
};

test('image translate under a Claude current model shows the needs-Codex hint beside the buttons', () => {
  const { app, fire, image } = setup({ value: 'claude:sonnet' });
  openPopover(app, fire, image);
  const hint = hintOf(app);
  assert.equal(hint.hidden, false);
  assert.ok(hint.textContent.length > 0, 'the hint has text');
  assert.notEqual(hint.textContent, 'ui.image_translate_needs_codex', 'the key exists in the language tables');
});

test('image translate under a Codex current model shows no hint', () => {
  const { app, fire, image } = setup({ value: 'gpt-5.6-luna' });
  openPopover(app, fire, image);
  const hint = hintOf(app);
  assert.equal(hint.hidden, true);
  assert.equal(hint.textContent, '');
});

test('pressing a translate button re-reads the model, so a switch to Claude shows the hint and the run still goes ahead', async () => {
  const modelRef = { value: 'gpt-5.6-luna' };
  const { app, fire, image, sentModels } = setup(modelRef);
  openPopover(app, fire, image);
  const popover = app.workspace.containerEl.children.find(item => item.cls.includes('vam-image-action-popover'));
  assert.equal(hintOf(app).hidden, true);
  modelRef.value = 'claude:sonnet';
  const buttons = popover.descendants().find(item => item.cls === 'vam-image-action-buttons').children;
  buttons[1].listeners.click[0]();
  assert.equal(hintOf(app).hidden, false, 'the hint appears on press');
  for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sentModels, ['claude:sonnet'], 'the run still sends, so the runtime error stays the last defence');
});

test('the sample copy and the selection AI take the model from plugin.currentModelChoice()', () => {
  const main = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  assert.match(main, /currentModelChoice\(\): ModelChoice \{\s*const \{ model, reasoning \} = resolveTaskModel\(\{\s*current:/);
  assert.match(main, /model: \(\) => this\.currentModelChoice\(\)\.model,\s*imageNeedsCodex/);
  assert.match(main, /this\.currentModelChoice\(\)\.model,\s*map,\s*path,\s*source\.parentId/);
  assert.match(main, /imageNeedsCodex: \(\) => this\.runtimeIdFor\(this\.currentModelChoice\(\)\.model\) === "claude"/);
  const panel = fs.readFileSync(path.join(root, 'experiences/markdown-context/selection-ai.ts'), 'utf8');
  assert.doesNotMatch(panel, /this\.model\b/, 'the panel keeps no model copy');
});
