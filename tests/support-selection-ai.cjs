// Drives the real MarkdownSelectionAi panel against a minimal fake DOM and a fake Obsidian module, so a test can
// read the prompts the panel sends through its `run` option (the runTask seam) without any test-only product export.
const { load } = require('./support-replay.cjs');

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
class Component {
  load() { this.onload?.(); }
  unload() { this.onunload?.(); }
  registerDomEvent() {}
  registerEvent() {}
  addChild(child) { child.load(); return child; }
}
class MarkdownView {}
class Setting {
  addButton(build) { const button = { setButtonText() { return button; }, setCta() { return button; }, onClick() { return button; } }; build(button); return this; }
}

/**
 * Select `selected` inside `markdown`, open the panel, press the first preset button and answer every model call
 * with the next entry of `replies`. Returns the prompts of the prepared steps the panel passed to `run`, in order.
 */
async function runPanel({ markdown, selected, replies, steps = false, outcome = false, notices = [] }) {
  const obsidian = { Component, MarkdownView, MarkdownRenderer: { render: async () => {} }, Notice: class { constructor(message) { notices.push(message); } }, Setting, setIcon() {}, Platform: { isMacOS: true }, requestUrl: async () => ({ json: {} }), parseYaml: text => require('yaml').parse(text) };
  const globals = {
    HTMLElement: FakeElement, HTMLImageElement: class {}, HTMLTextAreaElement: class {}, HTMLButtonElement: class {},
    document: { activeElement: null },
    window: { getSelection: () => null, innerWidth: 1000, innerHeight: 800, requestAnimationFrame: callback => callback(), setTimeout, clearTimeout }
  };
  const { MarkdownSelectionAi } = load('experiences/markdown-context/selection-ai.ts', { obsidian }, globals);
  const view = Object.assign(new MarkdownView(), {
    file: { path: 'Note.md' }, containerEl: new FakeElement(), getMode: () => 'source',
    editor: { getValue: () => markdown, getSelection: () => selected, getCursor: () => ({ line: 0, ch: 0 }), posToOffset: () => markdown.indexOf(selected), replaceRange() {} }
  });
  const app = { workspace: { containerEl: new FakeElement(), getLeavesOfType: () => [{ view }], getActiveViewOfType: () => view } };
  const sent = [];
  const queue = [...replies];
  const ai = new MarkdownSelectionAi(app, { model: () => 'test-model', autoOpen: () => true, language: () => 'English', run: async prepared => { sent.push(steps ? { step: `${prepared.step.id}@${prepared.step.version}`, prompt: prepared.prompt } : prepared.prompt); return queue.shift(); } });
  assert(ai.openForSelection(false), 'the panel opened');
  const panel = app.workspace.containerEl.children.find(item => item.cls === 'vam-context-ai-panel');
  const presets = panel.descendants().find(item => item.cls === 'vam-context-ai-presets');
  presets.children[0].listeners.click[0]();
  for (let turn = 0; turn < 50 && sent.length < replies.length; turn++) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  if (!outcome) return sent;
  return { sent, output: panel.descendants().find(item => item.cls === 'vam-context-ai-output').value, status: panel.descendants().filter(item => item.cls.split(' ').includes('vam-context-ai-status')).map(item => item.textContent).join('|') };
}
function assert(value, message) { if (!value) throw new Error(message); }

module.exports = { runPanel };
