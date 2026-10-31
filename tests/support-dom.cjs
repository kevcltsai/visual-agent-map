// A small DOM stand-in for modal tests: enough of Obsidian's element helpers to build, find and drive dialogs.
// Listeners are kept as arrays and fired with `fire`, a select defaults to its first option, and `modalEl` contains
// `contentEl` as in Obsidian.
function element(tag, options = {}) {
  const opts = typeof options === 'string' ? { cls: options } : options ?? {};
  const el = {
    tag, text: opts.text ?? '', cls: opts.cls ?? '', type: opts.type, children: [], listeners: {}, attrs: { ...(opts.attr ?? {}) }, dataset: {},
    disabled: false, hidden: false, open: false, checked: false, style: {}, parent: null,
    get firstChild() { return this.children[0] ?? null; },
    get textContent() { return this.text; },
    get classes() { return this.cls.split(/\s+/).filter(Boolean); },
    get value() { if (this._value !== undefined) return this._value; if (tag === 'select') { const first = this.children.find(c => c.tag === 'option'); return first ? (first.optionValue ?? first.value ?? '') : ''; } return this._initial ?? ''; },
    set value(next) { this._value = String(next); },
    _initial: opts.value ?? (tag === 'textarea' ? opts.text : undefined) ?? '',
    child(name, value) { const c = element(name, value); c.parent = this; c.root = this.root; if (name === 'option') c.optionValue = typeof value === 'object' && value?.value !== undefined ? value.value : (value?.text ?? ''); this.children.push(c); return c; },
    createDiv(value) { return this.child('div', value); },
    createEl(name, value) { return this.child(name, value); },
    createSpan(value) { return this.child('span', value); },
    setText(value) { this.text = String(value); }, setAttr(name, value) { this.attrs[name] = String(value); this[name] = String(value); },
    getAttr(name) { return this.attrs[name]; },
    addClass(...names) { for (const n of names) if (!this.classes.includes(n)) this.cls = `${this.cls} ${n}`.trim(); },
    removeClass(...names) { this.cls = this.classes.filter(n => !names.includes(n)).join(' '); },
    toggleClass(name, on) { on ? this.addClass(name) : this.removeClass(name); },
    hasClass(name) { return this.classes.includes(name); },
    classList: { toggle(name, on) { const el2 = this._owner; on === undefined ? (el2.hasClass(name) ? el2.removeClass(name) : el2.addClass(name)) : el2.toggleClass(name, on); }, contains(name) { return this._owner.hasClass(name); }, add(name) { this._owner.addClass(name); }, remove(name) { this._owner.removeClass(name); } },
    contains(other) { return findAll(this, x => x === other).length > 0; },
    insertBefore(node, ref) { node.parent = this; const at = ref ? this.children.indexOf(ref) : -1; at < 0 ? this.children.push(node) : this.children.splice(at, 0, node); return node; },
    empty() { this.children = []; }, replaceChildren(...next) { this.children = next; }, add(option) { this.children.push(option); },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); },
    addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); },
    removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] ?? []).filter(f => f !== fn); },
    fire(name, event = {}) { let stopped = false; const e = { preventDefault() {}, stopPropagation() { stopped = true; }, target: this, ...event }; for (const fn of this.listeners[name] ?? []) fn(e); if (!stopped && this.parent && ['change', 'input', 'click'].includes(name)) this.parent.fire(name, { ...e, target: e.target }); },
    click() { if (!this.disabled) this.fire('click'); }, change() { this.fire('change'); }, input() { this.fire('input'); }, keydown(event) { this.fire('keydown', event); },
    focus() { this.focused = true; if (this.root) this.root.activeElement = this; }, select() {}, setSelectionRange() {},
    querySelector(selector) { return findAll(this, matcher(selector))[0] ?? null; },
    querySelectorAll(selector) { return findAll(this, matcher(selector)); }
  };
  el.classList._owner = el;
  return el;
}
const hasCls = (item, name) => (item.cls ?? '').split(/\s+/).includes(name);
function matcher(selector) {
  if (selector.includes(',')) { const parts = selector.split(',').map(part => matcher(part.trim())); return item => parts.some(match => match(item)); }
  if (selector.startsWith('.')) { const name = selector.slice(1); return item => hasCls(item, name); }
  return item => item.tag === selector;
}
function findAll(root, predicate) { return [...(predicate(root) ? [root] : []), ...root.children.flatMap(c => findAll(c, predicate))]; }
const find = (root, predicate) => findAll(root, predicate)[0];
const byLabel = (root, label) => find(root, i => i.attrs['aria-label'] === label);
const button = (root, text) => find(root, i => i.tag === 'button' && i.text === text);
const buttons = root => findAll(root, i => i.tag === 'button').map(b => b.text);
const texts = root => findAll(root, i => i.text).map(i => i.text);
/** A Modal base class whose contentEl lives inside modalEl; `closed` counts close() calls. */
function makeModal() {
  return class Modal {
    constructor(app) { this.app = app; this.titleEl = element('title'); this.contentEl = element('content'); this.modalEl = element('modal'); this.modalEl.children.push(this.contentEl); this.closeCount = 0; }
    // Like Obsidian's Modal, opening stores the page's text selection on `this.selection`.
    open() { this.selection = { rangeCount: 0 }; this.onOpen?.(); }
    close() { this.closeCount++; this.onClose?.(); }
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
/** Obsidian's global createFragment: a fragment whose own text is its spans' text, so a Notice built from it reads as a string. */
function createFragment(callback) {
  const fragment = element('fragment');
  fragment.toString = () => findAll(fragment, i => i.tag === 'span').map(i => i.text).join('');
  callback?.(fragment);
  return fragment;
}
/** A Notice stand-in that records plain messages and, for fragments, their text and buttons (`actions`, press with `.click()`). */
function makeNotice(log = []) {
  const all = [];
  return class Notice {
    static all = all;
    constructor(message, timeout) { this.message = message; this.timeout = timeout; this.hidden = false; log.push(typeof message === 'string' ? message : String(message)); all.push(this); }
    hide() { this.hidden = true; }
    get actions() { return typeof this.message === 'string' ? [] : findAll(this.message, i => i.tag === 'button'); }
  };
}
module.exports = { hasCls, element, find, findAll, byLabel, button, buttons, texts, makeModal, tick, createFragment, makeNotice };
