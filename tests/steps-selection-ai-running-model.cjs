// MS-08 P8b: the status text of a running selection AI task names the model the run was started with (D4 format).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { load } = require('./support-replay.cjs');
const S = require('./support.cjs');

const root = path.resolve(__dirname, '..');
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

function setup(extra = {}) {
  let autoOpen = true;
  const listeners = {};
  class Component {
    load() { this.onload?.(); }
    unload() { this.onunload?.(); }
    registerDomEvent(target, type, listener) { (listeners[type] ??= []).push(listener); }
    registerEvent() {}
    addChild(child) { child.load(); return child; }
  }
  class MarkdownView {}
  class HTMLImageElement { constructor() { this.alt = 'image'; this.src = ''; this.currentSrc = ''; } closest() { return null; } getBoundingClientRect() { return { left: 0, right: 10, top: 0, bottom: 10, width: 10, height: 10 }; } }
  class Setting { addButton(build) { const button = { setButtonText() { return button; }, setCta() { return button; }, onClick() { return button; } }; build(button); return this; } }
  const obsidian = { Component, MarkdownView, MarkdownRenderer: { render: async () => {} }, Notice: class {}, Setting, setIcon() {}, Platform: { isMacOS: true }, requestUrl: async () => ({ json: {} }) };
  const globals = {
    HTMLElement: FakeElement, HTMLImageElement, HTMLTextAreaElement: class {}, HTMLButtonElement: class {},
    document: { activeElement: null },
    window: { getSelection: () => null, innerWidth: 1000, innerHeight: 800, requestAnimationFrame: callback => callback(), setTimeout, clearTimeout }
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
  const ai = new MarkdownSelectionAi(app, { model: () => 'test-model', autoOpen: () => autoOpen, language: () => 'English', run: async () => '', ...extra });
  ai.load();
  const launcher = app.workspace.containerEl.children.find(item => item.cls === 'vam-context-ai-launcher');
  const panel = () => app.workspace.containerEl.children.find(item => item.cls === 'vam-context-ai-panel');
  const imageAction = () => app.workspace.containerEl.children.find(item => item.cls.includes('vam-image-action-pill'));
  const fire = (type, event = {}) => { for (const listener of listeners[type] ?? []) listener(event); };
  return { ai, launcher, panel, imageAction, fire, selected, image: new HTMLImageElement(), setAutoOpen: value => { autoOpen = value; } };
}


test('the running status carries the label of the model the run starts with; a switch while it runs changes nothing', async () => {
  let current = 'm1';
  const seen = [];
  let panelRef;
  const { ai, fire, panel } = setup({
    model: () => current,
    modelLabel: id => `L:${id}`,
    run: async () => { seen.push(panelRef.status.textContent); current = 'm2'; return JSON.stringify({ action: 'rewrite', instruction: 'x', query: '', captionInstruction: '' }); }
  });
  fire('selectionchange');
  ai.openForSelection(false);
  assert.ok(panel());
  panelRef = ai.panel;
  await ai.panel.generate('do it', 'Condense').catch(() => {});
  assert.equal(seen[0], t('ui.progress_stage_with_model_0_1', t('ui.context_ai_running_0', 'Condense'), 'L:m1'));
  assert.ok(seen[0].includes('L:m1') && !seen[0].includes('L:m2'));
});

test('main.ts wires the plugin model label into the selection AI', () => {
  const fs = require('node:fs');
  assert.match(fs.readFileSync(path.join(root, 'main.ts'), 'utf8'), /modelLabel: model => this\.modelLabel\(model\)/);
});
