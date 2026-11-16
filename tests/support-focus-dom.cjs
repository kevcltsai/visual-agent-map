class Doc {
  constructor() { this.body = new El(this, 'body'); this.activeElement = this.body; }
  querySelector(selector) { return this.body.querySelector(selector); }
}
class El {
  constructor(doc, tag, init = {}) {
    this.doc = doc; this.tagName = tag.toUpperCase(); this.children = []; this.parent = null; this.attrs = {}; this.dataset = {}; this.listeners = {};
    this.classes = new Set(String(init.cls ?? '').split(' ').filter(Boolean)); this.textContent = init.text ?? ''; this.tabIndex = init.tabIndex ?? -1;
    if (init.label) this.attrs['aria-label'] = init.label;
    if (init.tabindex !== undefined) this.attrs.tabindex = String(init.tabindex);
    this.ownerDocument = doc;
  }
  get classList() { const set = this.classes; return { item: i => [...set][i] ?? null, contains: name => set.has(name) }; }
  get isConnected() { let e = this; while (e.parent) e = e.parent; return e === this.doc.body; }
  get id() { return this.dataset.nodeId; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttr(name, value) { this.attrs[name] = String(value); }
  add(tag, init) { const child = new El(this.doc, tag, init); child.parent = this; this.children.push(child); return child; }
  contains(other) { for (let e = other; e; e = e.parent) if (e === this) return true; return false; }
  matches(selector) {
    return selector.split(',').map(part => part.trim()).some(part => (part.startsWith('.') ? this.classes.has(part.slice(1)) : part === '[tabindex]' ? 'tabindex' in this.attrs : part.toUpperCase() === this.tagName));
  }
  closest(selector) { for (let e = this; e; e = e.parent) if (e.matches(selector)) return e; return null; }
  all() { return this.children.flatMap(c => [c, ...c.all()]); }
  querySelectorAll(selector) { return this.all().filter(e => e.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
  removeEventListener() {}
  focus() {
    if (!this.isConnected) return;
    this.doc.activeElement = this;
    for (let e = this; e; e = e.parent) for (const fn of e.listeners.focusin ?? []) fn({ target: this });
  }
  // Enough of Obsidian's element helpers for the render functions that build right-click targets.
  createEl(tag, init = {}) { const o = typeof init === 'string' ? { cls: init } : init; return this.add(tag, o); }
  createDiv(init) { return this.createEl('div', init); }
  createSpan(init) { return this.createEl('span', init); }
  addClass(name) { this.classes.add(name); }
  removeClass(name) { this.classes.delete(name); }
  setText(text) { this.textContent = text; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  fire(name, event) { for (const fn of this.listeners[name] ?? []) fn(event); }
  get style() { return (this._style ??= {}); }
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50 }; }
  get offsetLeft() { return 0; } get offsetTop() { return 0; } get offsetWidth() { return 100; } get offsetHeight() { return 50; }
  detach() { if (this.contains(this.doc.activeElement)) this.doc.activeElement = this.doc.body; if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  empty() { for (const c of [...this.children]) c.detach(); }
  remove() { this.detach(); }
}

module.exports = { Doc, El };
