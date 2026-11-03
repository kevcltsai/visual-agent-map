// The "Use AI on selection" auto-open setting: when off, selecting text shows no button and clicking an image opens
// nothing, but the command still opens the panel for the current selection.
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

function setup(initial, options = {}) {
  let autoOpen = initial;
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
    file: { path: 'Note.md' }, containerEl: new FakeElement(), getMode: () => options.mode ?? 'source',
    editor: { getValue: () => markdown, getSelection: () => options.cursorOnly ? '' : selected, getCursor: which => ({ line: 0, ch: options.cursorOnly ? 3 : which === 'from' ? markdown.indexOf(selected) : markdown.indexOf(selected) + selected.length }), posToOffset: pos => pos.ch, replaceRange() {} }
  });
  const app = {
    workspace: { containerEl: new FakeElement(), getLeavesOfType: () => options.commandPalette ? [] : [{ view }], getActiveViewOfType: () => view, on: () => ({}) },
    metadataCache: { getFirstLinkpathDest: () => null }
  };
  const ai = new MarkdownSelectionAi(app, { model: () => 'test-model', autoOpen: () => autoOpen, language: () => 'English', run: async () => '' });
  ai.load();
  const launcher = app.workspace.containerEl.children.find(item => item.cls === 'vam-context-ai-launcher');
  const panel = () => app.workspace.containerEl.children.find(item => item.cls === 'vam-context-ai-panel');
  const imageAction = () => app.workspace.containerEl.children.find(item => item.cls.includes('vam-image-action-pill'));
  const fire = (type, event = {}) => { for (const listener of listeners[type] ?? []) listener(event); };
  return { ai, markdown, launcher, panel, imageAction, fire, selected, image: new HTMLImageElement(), setAutoOpen: value => { autoOpen = value; } };
}

test('auto-open on: selecting text shows the launcher', () => {
  const { launcher, fire } = setup(true);
  assert.equal(launcher.hidden, true);
  fire('selectionchange');
  assert.equal(launcher.hidden, false);
});

test('auto-open off: selecting text keeps the launcher hidden and clicking an image opens no panel', () => {
  const { launcher, panel, imageAction, fire, image } = setup(false);
  fire('selectionchange');
  fire('pointerup');
  fire('keyup');
  fire('resize');
  assert.equal(launcher.hidden, true);
  fire('click', { target: image });
  assert.equal(panel(), undefined);
  assert.equal(imageAction(), undefined);
});

test('auto-open off: the command still opens the panel for the current selection', () => {
  const { ai, launcher, panel, fire, selected } = setup(false);
  fire('selectionchange');
  assert.equal(ai.openForSelection(true), true);
  assert.equal(launcher.hidden, true, 'checking the command must not show the launcher');
  assert.equal(ai.openForSelection(false), true);
  assert.ok(panel(), 'the panel opened');
  assert.equal(ai.panel.snapshot.text, selected);
  assert.equal(launcher.hidden, true);
});

test('the setting defaults to on, keeps older saved settings on, and is wired into the selection AI and settings tab', () => {
  const { DEFAULT_SETTINGS } = load('repository.ts', { obsidian: { App: class {}, TFile: class {}, TFolder: class {}, normalizePath: value => value, parseYaml: () => ({}), stringifyYaml: () => '' } });
  assert.equal(DEFAULT_SETTINGS.markdownSelectionAiAutoOpen, true);
  const main = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  assert.match(main, /markdownSelectionAiAutoOpen: saved\?\.markdownSelectionAiAutoOpen !== false/);
  assert.match(main, /autoOpen: \(\) => this\.settings\.markdownSelectionAiAutoOpen/);
  const tab = fs.readFileSync(path.join(root, 'ui/settings-tab.ts'), 'utf8');
  assert.match(tab, /this\.plugin\.settings\.markdownSelectionAiAutoOpen = value/);
});

test('turning auto-open off hides a launcher that is already showing on the next selection activity', () => {
  const { launcher, fire, setAutoOpen } = setup(true);
  fire('selectionchange');
  assert.equal(launcher.hidden, false);
  setAutoOpen(false);
  fire('selectionchange');
  assert.equal(launcher.hidden, true);
});

test('auto-open on: clicking an image shows only the translate-image action, not the text panel (the off-state test relies on this path being reachable)', () => {
  const { panel, imageAction, fire, image } = setup(true);
  fire('click', { target: image });
  assert.ok(imageAction(), 'the translate-image action appeared beside the image');
  assert.equal(panel(), undefined, 'the text panel is not opened for images');
});

test('command palette: the editor selection survives when the DOM selection and focus have left the view (#07)', () => {
  for (const autoOpen of [true, false]) {
    const { ai, markdown, panel, selected } = setup(autoOpen, { commandPalette: true });
    assert.equal(ai.openForSelection(false), true);
    assert.ok(panel(), 'the panel opened');
    assert.equal(ai.panel.snapshot.text, selected);
    assert.equal(ai.panel.snapshot.matchAt, markdown.indexOf(selected));
  }
});

test('command palette: a bare cursor keeps the no-selection snapshot, and reading mode refuses', () => {
  const cursor = setup(false, { commandPalette: true, cursorOnly: true });
  assert.equal(cursor.ai.openForSelection(false), true);
  assert.equal(cursor.ai.panel.snapshot.text, '');
  assert.equal(cursor.ai.panel.snapshot.matchAt, 3, 'the result goes at the cursor');
  assert.equal(setup(false, { commandPalette: true, mode: 'preview' }).ai.openForSelection(true), false);
});
