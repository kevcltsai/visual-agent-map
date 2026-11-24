const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, root, load } = require('../support.cjs');
test('product ribbon pins the map entrance below other actions and cleans up on unload', () => {
  let observer;
  class Observer {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
    moved(node) { if (this.connected) this.callback([{ addedNodes: [node] }]); }
  }
  const parent = {
    children: [],
    classList: { add() {}, remove() {} },
    get lastElementChild() { return this.children.at(-1); },
    appendChild(icon) { this.insertBefore(icon, null); },
    insertBefore(icon, next) {
      this.children = this.children.filter(child => child !== icon);
      const index = next ? this.children.indexOf(next) : this.children.length;
      this.children.splice(index, 0, icon); icon.parentElement = this;
    }
  };
  const make = name => ({
    name, parentElement: parent,
    classList: { values: new Set(), add(...names) { names.forEach(n => this.values.add(n)); }, remove(...names) { names.forEach(n => this.values.delete(n)); } },
    get nextSibling() { return parent.children[parent.children.indexOf(this) + 1] || null; },
    get nextElementSibling() { return this.nextSibling; }
  });
  const before = make('before'), other = make('other'), map = make('map');
  parent.children = [before, map, other];
  const { groupRibbonIcons } = load('ui/ribbon-group.ts', {}, { MutationObserver: Observer });
  const stop = groupRibbonIcons(map);
  assert.deepEqual(parent.children.map(x => x.name), ['before', 'other', 'map']);
  assert.ok(map.classList.values.has('vam-ribbon-group-start'));
  assert.ok(map.classList.values.has('vam-ribbon-group-end'));
  parent.insertBefore(map, before); observer.moved(map);
  assert.deepEqual(parent.children.map(x => x.name), ['before', 'other', 'map']);
  stop();
  assert.equal(observer.connected, false);
  assert.equal(map.classList.values.size, 0);
});
