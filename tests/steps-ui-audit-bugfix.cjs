// UI audit bugfix batch (full-20261107): drag re-parent target order, removing a card whose note file is gone, summary range change in selection mode.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element } = dom;
const plain = value => JSON.parse(JSON.stringify(value));
const TOPICS = 'Agent Workspace/Topics';
const MAP = `${TOPICS}/map-t/Map.md`;

// Root with three children (A, B, C) in a map; the view is wired the way tests/steps-after-text-view.cjs does it.
async function harness() {
  const { repo, app, contents, files } = fixture('en', { linkIndex: true });
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const doc = { id: 'map-t', title: 'T', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders(`${TOPICS}/map-t`);
  await app.vault.create(MAP, core.serializeMap(doc));
  const notes = {};
  for (const [i, title] of ['Root', 'A', 'B', 'C'].entries()) {
    const n = await repo.createNote(title, 'gpt-6-luna', doc, MAP, 'workspace');
    if (i) n.parentId = notes.Root.id;
    Object.assign(n, { x: 80 + i * 340, y: 80 });
    doc.nodes.push(n);
    notes[title] = n;
  }
  await repo.saveMap(MAP, doc);
  await repo.rebuildDerivedData();
  let pending = Promise.resolve();
  const notices = [];
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: dom.makeNotice(notices) } }, { createFragment: dom.createFragment, CSS: { escape: v => v }, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: work => (pending = Promise.resolve().then(work))
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = element('div'); view.stageEl = element('div');
  view.focusNode = () => {}; view.openDetails = () => {}; view.mergeUnlocked = () => true;
  view.hydrate = async () => {
    view.notes = new Map();
    for (const n of view.map.nodes) { try { view.notes.set(n.id, await repo.readNote(n.path)); } catch { /* a missing note stays missing */ } }
  };
  await view.hydrate();
  view.render = () => {};
  view.announcer = element('div');
  view.announcer.setText = text => { view.announced = text; };
  const node = title => view.map.nodes.find(n => n.path.includes(`${title}.md`));
  return { repo, app, view, contents, files, notices, node, disk: async () => plain(await repo.readMap(MAP)) };
}

test('S1: dragging onto an EARLIER card in map order finds that card, not the dragged card that sorts later', async () => {
  const h = await harness();
  const [a, b, c] = ['A', 'B', 'C'].map(h.node);
  // Card A (earlier) and the dragged card C (later) overlap under the pointer; C is dragged so it is under the pointer too.
  h.view.cardEls = new Map([
    [a.id, { offsetLeft: 0, offsetTop: 0, offsetWidth: 300, offsetHeight: 180 }],
    [b.id, { offsetLeft: 1000, offsetTop: 0, offsetWidth: 300, offsetHeight: 180 }],
    [c.id, { offsetLeft: 100, offsetTop: 50, offsetWidth: 300, offsetHeight: 180 }]
  ]);
  a.parentId = b.id; // so that dropping C on A is a real change
  const hit = h.view.reparentTargetAt(150, 100, [c], c.id);
  assert.ok(hit, 'a target is found');
  assert.equal(hit.node.id, a.id);
  assert.equal(hit.invalid, false);
  // Only the dragged card under the pointer: no target.
  assert.equal(h.view.reparentTargetAt(380, 220, [c], c.id), null);
});

test('S2: removing a card whose note file is gone still removes it from the map (one undo step, no "file not found")', async () => {
  const h = await harness();
  const gone = h.node('B');
  h.files.delete(gone.path); h.contents.delete(gone.path);
  await h.view.hydrate();
  const past = h.view.history.past.length;
  await h.view.removeToUnassigned(gone, false);
  assert.equal(h.view.map.nodes.some(n => n.id === gone.id), false, 'card is off the map');
  assert.equal((await h.disk()).nodes.some(n => n.id === gone.id), false, 'and off Map.md');
  assert.equal(h.view.history.past.length, past + 1);
});

test('A3: changing a summary range in selection mode writes the new range; a refusal is shown and not announced as success', async () => {
  const h = await harness();
  const [a, b, c] = ['A', 'B', 'C'].map(h.node);
  h.view.map.canvasItems = [{ id: 'sum-1', kind: 'summary', parentId: a.parentId, members: [a.id], text: 'Sum' }];
  await h.view.plugin.repo.saveMap(MAP, h.view.map);
  h.view.selection.toggleMultiSelect();
  assert.equal(h.view.selection.state.multiSelectMode, true);
  h.view.selection.replaceMulti([b.id, c.id]);
  await h.view.changeSummaryRange('sum-1');
  assert.deepEqual(plain(h.view.map.canvasItems.find(i => i.id === 'sum-1').members), [b.id, c.id], 'range changed in memory');
  assert.deepEqual((await h.disk()).canvasItems.find(i => i.id === 'sum-1').members, [b.id, c.id], 'and in Map.md');
  assert.equal(h.view.announced, 'Summary bracket range changed.');
  // A selection that passes the entry check but is refused by setSummaryMembers must not say success.
  h.view.announced = '';
  h.view.summaryEntryCheck = () => ({ ok: true, parentId: a.parentId, members: [a.id, c.id] });
  const before = JSON.stringify(h.view.map.canvasItems);
  const noticesBefore = h.notices.length;
  await h.view.changeSummaryRange('sum-1');
  assert.equal(JSON.stringify(h.view.map.canvasItems), before, 'unchanged');
  assert.notEqual(h.view.announced, 'Summary bracket range changed.');
  assert.ok(h.notices.length > noticesBefore, 'a reason is shown');
});

// Every `@container (max-width: 899px) { ... }` block of the stylesheet (the stacked Coffee Table room is styled in one of them).
const fs = require('node:fs');
const path = require('node:path');
const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const stackedBlocks = () => {
  const out = [];
  for (let at = css.indexOf('@container (max-width: 899px) {'); at >= 0; at = css.indexOf('@container (max-width: 899px) {', at + 1)) {
    let depth = 0;
    for (let i = css.indexOf('{', at); i < css.length; i++) {
      if (css[i] === '{') depth++;
      if (css[i] === '}' && --depth === 0) { out.push(css.slice(at, i + 1)); break; }
    }
  }
  return out;
};

test('S4: in the stacked Coffee Table layout the chat panel may shrink below its content (min-height 0), so the chat scrolls', () => {
  const rules = stackedBlocks().map(block => block.match(/^\s*\.ct-chat-panel\s*\{([^}]*)\}/m)).filter(Boolean);
  assert.ok(rules.length, 'the stacked layout styles .ct-chat-panel');
  assert.ok(rules.some(rule => /min-height:\s*0\b/.test(rule[1])));
  // The scroller inside still scrolls and the room still clips; nothing else is needed for the chat to be the one that scrolls.
  assert.match(css, /\.ct-chat-scroll\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/);
});

// Obsidian's layer scale (app.css): the built-in image viewer (lightbox) sits at 50, the same level as modals.
const OBSIDIAN_LAYERS = { 'layer-cover': 5, 'layer-sidedock': 10, 'layer-status-bar': 15, 'layer-popover': 30, 'layer-slides': 45, 'layer-modal': 50, 'layer-notice': 60, 'layer-menu': 65, 'layer-tooltip': 70 };
const LIGHTBOX_Z = 50;
const zOf = value => {
  const named = value.match(/^var\(--([\w-]+)\)$/);
  return named ? OBSIDIAN_LAYERS[named[1]] : Number(value);
};

test('S3: the image translate pill is drawn above Obsidian\'s image viewer (lightbox), not under it', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'styles.css'), 'utf8');
  const z = css.match(/^\.vam-image-action\s*\{[^}]*z-index:\s*([^;}\s]+)/m);
  assert.ok(z, '.vam-image-action sets a z-index');
  assert.ok(zOf(z[1]) > LIGHTBOX_Z, `z-index ${z[1]} must be above the lightbox (${LIGHTBOX_Z})`);
});

// S5: the startup subtopic-filename sync fails (EACCES): the ready promise still resolves, a Notice says so, and the next start retries.
async function startPlugin(saved, saves, options = {}) {
  const notices = [];
  const Main = load('main.ts', { obsidian: { ...obsidian, Notice: dom.makeNotice(notices) } });
  const Plugin = Main.default;
  const noop = () => Promise.resolve();
  const vault = {
    adapter: { exists: async () => false, list: async () => ({ files: [], folders: [] }), read: async () => '', write: noop, mkdir: noop },
    getAbstractFileByPath: () => null, read: async () => '', getMarkdownFiles: () => { if (options.eacces) throw new Error('EACCES: permission denied'); return []; }, getFiles: () => [], getAllLoadedFiles: () => [], getRoot: () => ({ children: [] }),
    on: name => ({ name }), create: noop, createFolder: noop, modify: noop, process: noop, rename: noop, trash: noop, delete: noop
  };
  const bare = new Plugin();
  const plugin = new Proxy(bare, { get: (target, key, receiver) => key in target || typeof key !== 'string' || !/^(register|add)/.test(key) ? Reflect.get(target, key, receiver) : () => ({ setAttribute() {}, addClass() {}, addEventListener() {} }) });
  plugin.manifest = { id: 'visual-agent-map', version: '0.0.0-test', dir: '' };
  plugin.app = { vault, fileManager: { trashFile: noop, renameFile: noop }, metadataCache: { on: () => ({}), getFileCache: () => null },
    workspace: { onLayoutReady: callback => callback(), on: () => ({}), getLeavesOfType: () => [], getActiveFile: () => null, getActiveViewOfType: () => null, layoutReady: true }, loadLocalStorage: () => null, saveLocalStorage() {} };
  plugin.loadData = async () => saved;
  plugin.saveData = async data => { saves.push(JSON.parse(JSON.stringify(data))); };
  plugin.addCommand = command => command;
  await plugin.onload();
  return { plugin, notices };
}

test('S5: a failing startup filename sync does not reject ready, shows a Notice, and structureVersion stays so the next start retries', async () => {
  const saved = { migrated: true, structureVersion: 1, workspaceInitialized: true, language: 'zh-TW' };
  const saves = [];
  const { plugin, notices } = await startPlugin(saved, saves, { eacces: true });
  await assert.doesNotReject(plugin.ready);
  assert.ok(notices.some(text => text.includes('子議題檔名同步失敗')), `notices: ${JSON.stringify(notices)}`);
  assert.ok(!saves.some(data => data.structureVersion >= 2), 'structureVersion is not advanced after a failure');
  // Control: the same start without the failure advances it (so the assertion above is not a blind spot).
  const ok = [];
  await (await startPlugin(saved, ok)).plugin.ready;
  assert.ok(ok.some(data => data.structureVersion >= 2));
});

// A1: a write after unload is refused with a message in the UI language, not a hardcoded English one.
test('A1: a write after the plugin unloaded is refused with a translated message', async () => {
  for (const [language, expected] of [['zh-TW', 'Visual Agent Map 已重新載入，這次沒有寫入。請關閉這個視窗後重試。'], ['zh-CN', 'Visual Agent Map 已重新加载，这次没有写入。请关闭这个窗口后重试。'], ['en', 'Visual Agent Map was reloaded and this write was not performed. Close this window and try again.']]) {
    const { repo } = fixture(language, { linkIndex: true });
    repo.settings.language = language;
    repo.dispose();
    await assert.rejects(repo.app.vault.create('x.md', ''), error => error.message === expected, language);
  }
});

// A2: an agent-map block that is not valid JSON gives a readable, translated error instead of a raw SyntaxError.
test('A2: a malformed agent-map block throws a readable translated error, not a raw SyntaxError', () => {
  const bad = '```agent-map\n{ "version": 1, \n```\n';
  assert.throws(() => core.parseMap(bad), error => !(error instanceof SyntaxError) && error.message === 'The data block of this mind map is malformed, so it cannot be opened. Fix the contents of the agent-map block.');
  // The message comes from the dictionary of the interface language (map-model has its own language state in this bundle).
  const zhTW = Object.values(load('i18n/zh-TW.ts')).find(value => value && typeof value === 'object' && 'ui.map_data_block_invalid' in value);
  assert.equal(zhTW['ui.map_data_block_invalid'], '這張心智圖的資料區塊格式不正確，無法開啟。請修正 agent-map 區塊的內容。');
});

// A4: the "same topic" banner row is hidden with is-hidden, but `.ct-topic-focus { display: flex }` used to win over it.
test('A4: .ct-topic-focus.is-hidden hides the row, and the view toggles it only by the topic filter', () => {
  const fs = require('node:fs'), path = require('node:path');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.match(styles, /\.ct-topic-focus\.is-hidden\s*\{\s*display:\s*none\s*;?\s*\}/);
  const view = fs.readFileSync(path.join(__dirname, '..', 'experiences/coffee-tables/view.ts'), 'utf8');
  assert.match(view, /createDiv\("ct-topic-focus is-hidden"\)/);
  assert.match(view, /topicFocusRow\.toggleClass\("is-hidden", !this\.focusedTopic\)/);
});

// A5: an unreadable table row says it cannot be read (not "Interrupted") and explains why; it stays disabled.
test('A5: the unreadable table row has its own badge text and reason line, and the row stays disabled', () => {
  const fs = require('node:fs'), path = require('node:path');
  const list = load('experiences/coffee-tables/list.ts');
  const base = { id: 'x', path: 'a.md', topic: 'T', createdAt: '', updatedAt: '', model: '' };
  assert.equal(list.tableStatusKey({ ...base, status: 'error', unreadable: true }), 'coffee.unreadable');
  assert.equal(list.tableStatusKey({ ...base, status: 'error' }), 'coffee.interrupted', 'a readable interrupted table keeps its label');
  assert.equal(list.tableStatusKey({ ...base, status: 'completed' }), 'coffee.complete');
  const zh = Object.values(load('i18n/zh-TW.ts')).find(value => value && typeof value === 'object' && 'coffee.unreadable' in value);
  assert.equal(zh['coffee.unreadable'], '讀不到');
  assert.equal(zh['coffee.unreadable_reason'], '檔案內容無法讀取，請檢查或手動移除這個檔案。');
  const view = fs.readFileSync(path.join(__dirname, '..', 'experiences/coffee-tables/view.ts'), 'utf8');
  assert.match(view, /if \(item\.unreadable\) \{[^}]*ct-list-unreadable[^}]*button\.disabled = true;[^}]*coffee\.unreadable_reason/s);
});
