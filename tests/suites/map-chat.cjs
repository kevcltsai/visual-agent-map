// Map AI chat window (Packet B2): the panel on its own, then the real view and repository with a fake chat service.
// DOM: tests/support-dom.cjs elements. The view's full render() needs far more than a DOM fake offers, so the repaint tests drive
// the same methods render() calls (detachMapChat before the old content goes, mountMapChat once the overlay exists).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, integrationTest, root, load, core, plain, DEFAULT_SETTINGS, fixture, withExpansionCoordinator, until, deferred, obsidian } = require('../support.cjs');
const dom = require('../support-dom.cjs');
const { element, find, findAll, byLabel, tick } = dom;

const eq = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message);
const MAP = 'Agent Workspace/Topics/map-a/Map.md';
const { contentHash } = load('core/map-chat-context.ts');

// ---- panel on its own -------------------------------------------------------------------------------------------

/** A document stand-in: `activeElement` follows focus(), like the real one, and is cleared when the focused element is removed. */
function page() {
  const doc = { activeElement: null };
  const root = element('div'); root.root = doc; root.ownerDocument = doc;
  const attach = parent => { parent.appendChild = node => { node.parent?.children.splice(node.parent.children.indexOf(node), 1); node.parent = parent; parent.children.push(node); return node; }; return parent; };
  attach(root);
  return { doc, root, attach };
}
function panelFixture(overrides = {}) {
  const { MapChatPanel } = load('experiences/visual-map/map-chat.ts', { obsidian });
  const p = page(); const overlay = p.attach(p.root.createDiv('vam-canvas-overlay'));
  const calls = { send: 0, stop: 0, layout: [] };
  const topics = { a: 'Topic A', b: 'Topic B' };
  let selected = [];
  const host = {
    topicTitle: id => topics[id] ?? null, selectedIds: () => selected, send: () => { calls.send++; }, stop: () => { calls.stop++; },
    resolveLink: link => ({ Note: 'Notes/Note.md', Other: 'Notes/Other.md' })[link] ?? null, activeNotePath: () => 'Notes/Active.md',
    activeElement: () => p.doc.activeElement, layoutChanged: open => calls.layout.push(open), ...overrides
  };
  const panel = new MapChatPanel(host);
  panel.mount(overlay);
  const parts = {
    toggle: () => find(panel.el, i => i.tag === 'button' && hasClass(i, 'vam-map-chat-toggle')),
    input: () => panel.inputEl, log: () => panel.logEl, chips: () => panel.chipsEl, status: () => panel.statusEl,
    send: () => byLabel(panel.el, 'Send'), stop: () => byLabel(panel.el, 'Stop'), close: () => byLabel(panel.el, 'Close AI chat'),
    chipTexts: () => findAll(panel.chipsEl, i => hasClass(i, 'vam-map-chat-chip-label')).map(i => i.text)
  };
  return { panel, overlay, calls, page: p, parts, select: ids => { selected = ids; panel.refreshSelection(); } };
}
const hasClass = (item, name) => dom.hasCls(item, name);
const key = (input, event) => { let prevented = false; input.fire('keydown', { preventDefault() { prevented = true; }, shiftKey: false, isComposing: false, ...event }); return prevented; };
const drop = (target, text) => { let prevented = false; target.fire('drop', { preventDefault() { prevented = true; }, dataTransfer: { getData: type => type === 'text/plain' ? text : '', types: ['text/plain'] } }); return prevented; };

test('map chat: droppedLinkTarget reads [[links]] and obsidian:// addresses and nothing else', () => {
  const { droppedLinkTarget } = load('experiences/visual-map/map-chat.ts', { obsidian });
  assert.equal(droppedLinkTarget('[[Note]]'), 'Note');
  assert.equal(droppedLinkTarget(' ![[Folder/Note#Heading|alias]] '), 'Folder/Note');
  assert.equal(droppedLinkTarget('obsidian://open?vault=V&file=Folder%2FMy%20Note'), 'Folder/My Note');
  assert.equal(droppedLinkTarget('plain text with [[link]] inside'), null);
  assert.equal(droppedLinkTarget('obsidian://open?vault=V'), null);
  assert.equal(droppedLinkTarget('obsidian://open?file=%E0%A4%A'), null);
  assert.equal(droppedLinkTarget('[[ ]]'), null);
});

test('map chat: starts collapsed at the bottom left with labelled controls; opening and closing move focus and tell the view', () => {
  const f = panelFixture();
  assert.equal(f.panel.isOpen, false);
  const toggle = f.parts.toggle();
  assert.equal(toggle.attrs['aria-label'], 'Open AI chat'); assert.equal(toggle.attrs['aria-expanded'], 'false'); assert.equal(toggle.hidden, false);
  assert.equal(f.panel.bodyEl.hidden, true, 'the body is hidden while collapsed');
  toggle.click();
  assert.equal(f.panel.isOpen, true); eq(f.calls.layout, [true]);
  assert.equal(f.page.doc.activeElement, f.parts.input(), 'opening puts the keyboard in the message field');
  assert.equal(toggle.hidden, true); assert.equal(f.panel.bodyEl.hidden, false);
  assert.equal(f.parts.input().attrs['aria-label'], 'Message to the AI');
  f.parts.close().click();
  assert.equal(f.panel.isOpen, false); eq(f.calls.layout, [true, false]);
  assert.equal(f.page.doc.activeElement, toggle, 'closing returns the keyboard to the button that opens it');
});

test('map chat: Enter sends, Shift+Enter and an IME confirmation do not, Escape collapses and keeps the draft', () => {
  const f = panelFixture(); f.panel.setOpen(true);
  const input = f.parts.input(); input.value = 'hello';
  assert.equal(key(input, { key: 'Enter' }), true, 'Enter is consumed'); assert.equal(f.calls.send, 1);
  assert.equal(key(input, { key: 'Enter', shiftKey: true }), false, 'Shift+Enter is left to the field (new line)'); assert.equal(f.calls.send, 1);
  assert.equal(key(input, { key: 'Enter', isComposing: true }), false); assert.equal(f.calls.send, 1);
  input.fire('compositionstart'); assert.equal(f.panel.isComposing, true);
  assert.equal(key(input, { key: 'Enter' }), false, 'Enter while composing only confirms the candidate'); assert.equal(f.calls.send, 1);
  input.fire('compositionend'); assert.equal(f.panel.isComposing, false);
  assert.equal(key(input, { key: 'Escape' }), true); assert.equal(f.panel.isOpen, false); assert.equal(f.panel.draft, 'hello', 'the draft survives');
});

test('map chat: messages, draft and chips survive a repaint, and the message field gets its focus and caret back', () => {
  const f = panelFixture(); f.panel.setOpen(true); f.panel.addTopicReference('a');
  f.panel.begin('question one'); f.panel.finish('answer one', [{ status: 'done', text: 'Done: x' }]);
  const input = f.parts.input(); input.value = 'half-typed'; input.selectionStart = 2; input.selectionEnd = 5; input.focus();
  const before = f.panel.el;
  const restore = f.panel.captureFocus(); f.panel.detach(); f.page.doc.activeElement = null; // a removed element loses focus
  f.panel.mount(f.page.attach(find(f.page.root, i => hasClass(i, 'vam-canvas-overlay')))); restore();
  assert.equal(f.panel.el, before, 'the elements are built once and moved, not rebuilt');
  assert.equal(f.panel.draft, 'half-typed'); eq(f.panel.transcript().map(m => m.text), ['question one', 'answer one']);
  eq(f.parts.chipTexts(), ['Topic: Topic A']);
  assert.equal(f.page.doc.activeElement, f.parts.input()); assert.equal(f.parts.input().selectionStart, 2); assert.equal(f.parts.input().selectionEnd, 5);
  assert.equal(f.panel.isOpen, true);
});

test('map chat: no focus restore when the message field did not have focus', () => {
  const f = panelFixture(); f.panel.setOpen(true);
  const restore = f.panel.captureFocus(); restore();
  assert.equal(f.page.doc.activeElement, f.parts.toggle() === null ? null : f.page.doc.activeElement);
  assert.notEqual(f.page.doc.activeElement, f.parts.input());
});

test('map chat: hitTest follows the panel rectangle, also while only the button is showing', () => {
  const f = panelFixture();
  f.panel.el.getBoundingClientRect = () => ({ left: 10, top: 100, right: 60, bottom: 150, width: 50, height: 50 });
  assert.equal(f.panel.hitTest(30, 120), true); assert.equal(f.panel.hitTest(5, 120), false); assert.equal(f.panel.hitTest(30, 151), false);
  f.panel.el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  assert.equal(f.panel.hitTest(0, 0), false, 'a panel without size is never hit');
  f.panel.setDropHighlight(true); assert.ok(hasClass(f.panel.el, 'is-drop')); f.panel.setDropHighlight(false); assert.ok(!hasClass(f.panel.el, 'is-drop'));
});

test('map chat: dropped text becomes a snippet chip, [[links]] become file chips, an unknown link stays text, and chips can be removed', () => {
  const f = panelFixture(); f.panel.setOpen(true);
  assert.equal(drop(f.panel.el, 'some selected words'), true);
  eq(f.panel.attachments(), [{ kind: 'snippet', path: 'Notes/Active.md', text: 'some selected words', pathGuessed: true }], 'the source note is the open note, marked as a guess');
  drop(f.panel.el, '[[Note]]');
  drop(f.panel.el, '[[Note]]\n[[Other]]');
  eq(f.panel.attachments().filter(c => c.kind === 'file').map(c => c.path), ['Notes/Note.md', 'Notes/Other.md'], 'the same file is added once');
  drop(f.panel.el, '[[Missing]]');
  assert.equal(f.panel.attachments().at(-1).kind, 'snippet'); assert.equal(f.panel.attachments().at(-1).text, '[[Missing]]');
  drop(f.panel.el, '   ');
  assert.equal(f.panel.attachments().length, 4);
  const removes = findAll(f.parts.chips(), i => i.tag === 'button');
  assert.equal(removes.length, 4); assert.ok(removes.every(b => /^Remove reference: /.test(b.attrs['aria-label'])), 'each remove button is named');
  assert.ok(removes.every(b => b.attrs.tabindex !== '-1'), 'the remove buttons stay in the Tab order');
  removes[0].click();
  assert.equal(f.panel.attachments().length, 3);
});

test('map chat: dragging over the panel is accepted and highlighted, leaving clears it', () => {
  const f = panelFixture();
  const dataTransfer = { types: ['text/plain'] }; let prevented = 0;
  f.panel.el.fire('dragover', { preventDefault() { prevented++; }, dataTransfer });
  assert.equal(prevented, 1); assert.equal(dataTransfer.dropEffect, 'copy'); assert.ok(hasClass(f.panel.el, 'is-drop'));
  f.panel.el.fire('dragleave'); assert.ok(!hasClass(f.panel.el, 'is-drop'));
});

test('map chat: selected cards show as references that cannot be removed here, and a dragged card is not listed twice', () => {
  const f = panelFixture(); f.panel.setOpen(true);
  f.select(['a', 'b']);
  eq(f.parts.chipTexts(), ['Selected: Topic A', 'Selected: Topic B']);
  assert.equal(findAll(f.parts.chips(), i => i.tag === 'button').length, 0);
  f.panel.addTopicReference('a');
  eq(f.parts.chipTexts(), ['Selected: Topic B', 'Topic: Topic A']);
  f.select(['zzz']);
  eq(f.parts.chipTexts(), ['Topic: Topic A'], 'a selected card that is not on the map is not shown');
});

test('map chat: while the AI works Stop is shown with a visible status, the reply streams in place, and the turn ends with action lines', () => {
  const f = panelFixture(); f.panel.setOpen(true);
  f.parts.input().value = 'ask';
  f.panel.begin('ask');
  assert.equal(f.parts.input().value, '', 'the draft is cleared once the question is sent');
  assert.equal(f.parts.status().text, 'The AI is replying…'); assert.equal(f.parts.send().hidden, true); assert.equal(f.parts.stop().hidden, false);
  assert.equal(f.parts.stop().attrs['aria-label'], 'Stop'); assert.equal(f.parts.status().attrs.role, 'status'); assert.equal(f.parts.log().attrs.role, 'log');
  f.panel.streamReply('partial'); f.panel.streamReply('partial answer');
  assert.equal(find(f.parts.log(), i => hasClass(i, 'is-assistant')).children.find(c => hasClass(c, 'vam-map-chat-text')).text, 'partial answer');
  eq(f.panel.turns(), [], 'a turn that is still streaming is not history');
  f.panel.finish('final answer', [{ status: 'done', text: 'Done: A' }, { status: 'skipped', text: 'Skipped: B' }]);
  assert.equal(f.parts.status().text, ''); assert.equal(f.parts.send().hidden, false); assert.equal(f.parts.stop().hidden, true);
  eq(findAll(f.parts.log(), i => hasClass(i, 'vam-map-chat-line')).map(i => i.text), ['Done: A', 'Skipped: B']);
  eq(f.panel.turns(), [{ role: 'user', text: 'ask' }, { role: 'assistant', text: 'final answer' }]);
});

test('map chat: a failed or stopped turn shows its own text and does not become history', () => {
  const f = panelFixture(); f.panel.setOpen(true);
  f.panel.begin('one'); f.panel.fail('It broke');
  f.panel.begin('two'); f.panel.streamReply('some words'); f.panel.markStopped();
  f.panel.begin('three'); f.panel.markStopped();
  const texts = f.panel.transcript().map(m => m.text);
  eq(texts, ['one', 'It broke', 'two', 'some words', 'three', 'Stopped.']);
  eq(f.panel.turns().map(t => t.text), ['two', 'some words'], 'failed turns are left out; a stopped one keeps its partial text');
  assert.equal(f.panel.isBusy, false);
});

// ---- the view -------------------------------------------------------------------------------------------------

class MarkdownView {}

async function harness({ aim = false } = {}) {
  const { repo, app, contents, files } = fixture('en');
  app.vault.configDir = '.obsidian';
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'claude:sonnet' };
  repo.settings = settings;
  const mapDoc = { id: 'map-a', title: 'Sleep map', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a');
  const ids = {};
  const add = async (key, title, parent) => {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, parent ? 'inherited' : 'workspace');
    Object.assign(created, { parentId: parent ? ids[parent] : null, x: parent ? 400 : 80, y: 80 + mapDoc.nodes.length * 200 });
    mapDoc.nodes.push(created); ids[key] = created.id;
    return created;
  };
  await add('root', 'Sleep'); await add('a', 'Body', 'root'); await add('b', 'Mind', 'root'); await add('c', 'REM', 'a');
  await app.vault.create(MAP, core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  for (const [file, text] of Object.entries({ 'Notes/Research.md': '# Research\n\nSleep needs darkness.\nSleep needs quiet.\n', 'Notes/Other.md': 'Other note about naps.\n', '.obsidian/plugins/x.md': 'config text\n' })) {
    const folder = file.split('/').slice(0, -1).join('/');
    for (const part of [folder.split('/')[0], folder]) if (!files.has(part)) await app.vault.createFolder(part);
    await app.vault.create(file, text);
  }
  const notices = [], opened = [];
  const control = { reply: async () => ({ reply: 'ok', actions: [], rejected: [] }), requests: [], usageAsks: 0, decline: false, nested: 0, mutates: 0, depth: 0, calls: [] };
  let queue = Promise.resolve();
  const ctx = {};
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), releaseOutline() {}, syncOutline() {}, setOutlineActive() {},
    pendingSuggestions: new Map(), pendingResearchOptions: new Map(), detailsShown: () => false,
    // Like the real mutate: a promise queue that is not re-entrant. A call made from inside a running write waits for it, forever.
    mutate(work) {
      control.mutates++; if (control.depth > 0) control.nested++;
      const result = queue.then(async () => {
        control.depth++;
        try { await work(); const view = ctx.view; if (view) await view.hydrate(); } finally { control.depth--; }
      });
      queue = result.catch(() => {});
      return result;
    },
    confirmAiUsage: async (_model, run) => { control.usageAsks++; control.calls.push('confirm'); if (control.decline) return false; await run(); return true; },
    mapChat: { chat: async (request, signal, onReply) => { control.calls.push('chat'); control.requests.push(request); return control.reply(request, signal, onReply); } }
  });
  const leaves = []; let activeMarkdown = null;
  app.workspace = { getLeavesOfType: type => type === 'markdown' ? leaves : [], getActiveViewOfType: () => activeMarkdown, on() {} };
  class Notice { constructor(message) { notices.push(message); } hide() {} }
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, MarkdownView, Notice } }, { requestAnimationFrame: run => { run(); return 1; }, cancelAnimationFrame() {}, setTimeout: fn => { ctx.timers.push(fn); return ctx.timers.length; }, clearTimeout() {} });
  ctx.timers = [];
  const view = new VisualAgentMapView({ app }, plugin);
  ctx.view = view;
  const p = page(); const rootEl = p.root;
  Object.assign(view, { path: MAP, contentEl: rootEl, focusNode() {}, closed: false });
  view.map = await repo.readMap(MAP);
  if (aim) view.map.aim = { version: 1, branches: [], runs: [], pendingCommits: [] };
  const rawSend = view.sendMapChat.bind(view); view.sendMapChat = () => withTimeout(rawSend());
  const reload = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  view.hydrate = reload;
  let renders = 0;
  view.render = () => { renders++; view.paintCount++; repaint(); };
  // What render() does around the chat: detach first, mount into the new overlay last, then give focus back.
  let workspaceEl = null;
  const repaint = () => {
    const restore = view.detachMapChat(); p.doc.activeElement = null;
    rootEl.empty(); workspaceEl = rootEl.createDiv('vam-workspace'); const overlay = p.attach(workspaceEl.createDiv('vam-canvas-overlay'));
    view.mountMapChat(workspaceEl, overlay); restore();
  };
  await reload();
  const h = {
    repo, app, contents, files, view, plugin, ids, control, notices, opened, leaves, page: p, rootEl, get timers() { return ctx.timers; }, repaint, renders: () => renders, workspace: () => workspaceEl,
    setActive: (file, text, editor) => { const v = Object.assign(new MarkdownView(), { file: app.vault.getAbstractFileByPath(file), editor: editor ?? null }); activeMarkdown = v; leaves.splice(0, leaves.length, { view: v }); return v; },
    hashes: (...paths) => Object.fromEntries(paths.map(p2 => [p2, contentHash(contents.get(p2))])),
    node: key => view.map.nodes.find(n => n.id === ids[key]),
    note: async key => repo.readNote(view.map.nodes.find(n => n.id === ids[key]).path),
    saved: async () => (await repo.readMap(MAP)).nodes,
    open: () => { repaint(); view.chat.setOpen(true); return view.chat; },
    type: text => { view.chat.inputEl.value = text; }
  };
  return h;
}
// Every wait on the view is bounded: a mutate made from inside a mutate never returns, and must fail the test, not hang it.
const withTimeout = (promise, ms = 1500) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out (deadlock?)')), ms); })]).finally(() => clearTimeout(timer)); };
const apply = (h, actions, hashes = {}, alive) => withTimeout(h.view.applyMapChatActions({ actions, rejected: [] }, hashes, alive));

integrationTest('map chat: one reply applies add_child, rename_topic, move_topic and edit_md_file in order, each in its own mutate, and leaves no undo step', async () => {
  const h = await harness(); await h.view.hydrate();
  h.view.history.push({ undo: async () => {}, redo: async () => {}, label: 'earlier' });
  const entry = h.view.history.undoEntry;
  h.control.mutates = 0;
  const lines = await withTimeout(apply(h, [
    { kind: 'add_child', parentId: h.ids.b, title: 'Dreams', summary: 'What we dream' },
    { kind: 'rename_topic', nodeId: h.ids.a, title: 'Body clock' },
    { kind: 'move_topic', nodeId: h.ids.c, newParentId: h.ids.b },
    { kind: 'edit_md_file', path: 'Notes/Research.md', find: 'needs darkness', replace: 'needs total darkness' }
  ], h.hashes('Notes/Research.md')));
  eq(lines.map(l => l.status), ['done', 'done', 'done', 'done'], JSON.stringify(lines));
  assert.equal(h.control.mutates, 4, 'one mutate per write action'); assert.equal(h.control.nested, 0, 'never a mutate inside a mutate');
  const nodes = await h.saved(); const dreams = nodes.find(n => n.parentId === h.ids.b && n.id !== h.ids.c);
  assert.ok(dreams, 'the new subtopic is under Mind'); assert.equal((await h.repo.readNote(dreams.path)).title, 'Dreams'); assert.equal((await h.repo.readNote(dreams.path)).summary, 'What we dream');
  assert.equal((await h.note('a')).title, 'Body clock'); assert.equal(nodes.find(n => n.id === h.ids.c).parentId, h.ids.b);
  assert.equal(h.contents.get('Notes/Research.md'), '# Research\n\nSleep needs total darkness.\nSleep needs quiet.\n');
  assert.equal(h.view.history.undoEntry, entry, 'the undo history is what it was before the reply');
  eq(lines.map(l => l.text.split(':')[0]), ['Done', 'Done', 'Done', 'Done']);
});

integrationTest('map chat: control - without discarding, the same reply would leave undo steps (the undo test can fail)', async () => {
  const h = await harness(); await h.view.hydrate();
  const entry = h.view.history.undoEntry;
  h.view.history.discardSince = () => {};
  await apply(h, [{ kind: 'rename_topic', nodeId: h.ids.a, title: 'Renamed' }]);
  assert.notEqual(h.view.history.undoEntry, entry, 'the write pushed an entry; only discardSince removes it');
  const clean = await harness(); await clean.view.hydrate(); const before = clean.view.history.undoEntry;
  await apply(clean, [{ kind: 'rename_topic', nodeId: clean.ids.a, title: 'Renamed' }]);
  assert.equal(clean.view.history.undoEntry, before);
});

integrationTest('map chat: discarding drops only the chat\'s own steps; earlier undo entries stay undoable', async () => {
  const h = await harness(); await h.view.hydrate();
  await h.view.noteChange(h.node('a'), { title: 'User rename' });
  const mine = h.view.history.undoEntry; assert.ok(mine);
  await apply(h, [{ kind: 'add_child', parentId: h.ids.a, title: 'X', summary: '' }, { kind: 'update_summary', nodeId: h.ids.b, summary: 'New' }]);
  assert.equal(h.view.history.undoEntry, mine, 'the user\'s own earlier step is still the one Undo takes');
});

integrationTest('map chat: a stale Markdown file is skipped with its reason, nothing is written to it, and the other actions still run', async () => {
  const h = await harness(); await h.view.hydrate();
  const hashes = h.hashes('Notes/Research.md', 'Notes/Other.md');
  h.contents.set('Notes/Research.md', 'Someone edited this meanwhile.\nSleep needs darkness.\n');
  const staleText = h.contents.get('Notes/Research.md');
  const lines = await apply(h, [
    { kind: 'edit_md_file', path: 'Notes/Research.md', find: 'needs darkness', replace: 'X' },
    { kind: 'rename_topic', nodeId: h.ids.b, title: 'Still renamed' },
    { kind: 'edit_md_file', path: 'Notes/Other.md', find: 'naps', replace: 'sleep' }
  ], hashes);
  eq(lines.map(l => l.status), ['skipped', 'done', 'done']);
  assert.match(lines[0].text, /the file changed after you sent the message/);
  assert.equal(h.contents.get('Notes/Research.md'), staleText, 'the stale file is untouched');
  assert.equal((await h.note('b')).title, 'Still renamed'); assert.equal(h.contents.get('Notes/Other.md'), 'Other note about sleep.\n');
});

integrationTest('map chat: a file that was never sent, text that is not found exactly once, and a missing file are all skipped without writes', async () => {
  const h = await harness(); await h.view.hydrate();
  const hashes = h.hashes('Notes/Research.md');
  const before = new Map(h.contents);
  const lines = await apply(h, [
    { kind: 'edit_md_file', path: 'Notes/Other.md', find: 'naps', replace: 'x' },
    { kind: 'edit_md_file', path: 'Notes/Research.md', find: 'Sleep needs', replace: 'x' },
    { kind: 'edit_md_file', path: 'Notes/Research.md', find: 'not there', replace: 'x' }
  ], hashes);
  eq(lines.map(l => l.status), ['skipped', 'skipped', 'skipped']);
  assert.match(lines[0].text, /not part of this message/); assert.match(lines[1].text, /not found exactly once/); assert.match(lines[2].text, /not found exactly once/);
  for (const [file, text] of before) assert.equal(h.contents.get(file), text, `${file} is unchanged`);
});

integrationTest('map chat: the write guard refuses the settings folder, paths outside the vault, a broken map file, changed topic identity and overwriting; no file is created or changed', async () => {
  const h = await harness(); await h.view.hydrate();
  const topicPath = h.node('a').path;
  const hashes = h.hashes('.obsidian/plugins/x.md', MAP, topicPath, 'Notes/Other.md');
  const snapshot = new Map(h.contents);
  const lines = await apply(h, [
    { kind: 'edit_md_file', path: '.obsidian/plugins/x.md', find: 'config', replace: 'hacked' },
    { kind: 'create_md_file', path: '.obsidian/new.md', content: 'x' },
    { kind: 'create_md_file', path: '../outside.md', content: 'x' },
    { kind: 'create_md_file', path: '/abs.md', content: 'x' },
    { kind: 'create_md_file', path: 'Notes/Other.md', content: 'overwrite' },
    { kind: 'create_md_file', path: 'Notes/data.txt', content: 'x' },
    { kind: 'edit_md_file', path: MAP, find: '```agent-map', replace: '```broken' },
    { kind: 'edit_md_file', path: topicPath, find: 'agent-map-node', replace: 'agent-map-gone' }
  ], hashes);
  eq(lines.map(l => l.status), Array(8).fill('skipped'), JSON.stringify(lines));
  assert.match(lines[0].text, /settings folder/); assert.match(lines[1].text, /settings folder/); assert.match(lines[2].text, /outside the vault/); assert.match(lines[3].text, /outside the vault/);
  assert.match(lines[4].text, /already exists/); assert.match(lines[5].text, /only \.md/);
  assert.match(lines[6].text, /break the map file|not found exactly once/); assert.match(lines[7].text, /identity|not found exactly once/);
  for (const [file, text] of snapshot) assert.equal(h.contents.get(file), text, `${file} is unchanged`);
  for (const file of h.contents.keys()) assert.ok(snapshot.has(file), `${file} was not created`);
});

integrationTest('map chat: a legal new file is created with its folders, and an open note is edited through its editor, not the vault', async () => {
  const h = await harness(); await h.view.hydrate();
  const replaced = [];
  const text = h.contents.get('Notes/Research.md');
  const editor = { getValue: () => text, offsetToPos: offset => ({ ch: offset, line: 0 }), replaceRange: (replacement, from, to) => replaced.push([replacement, from.ch, to.ch]) };
  h.setActive('Notes/Research.md', text, editor);
  const lines = await apply(h, [
    { kind: 'create_md_file', path: 'New/Deep/Idea.md', content: '# Idea\n' },
    { kind: 'edit_md_file', path: 'Notes/Research.md', find: 'needs quiet', replace: 'needs calm' }
  ], h.hashes('Notes/Research.md'));
  eq(lines.map(l => l.status), ['done', 'done']);
  assert.equal(h.contents.get('New/Deep/Idea.md'), '# Idea\n'); assert.ok(h.files.has('New') && h.files.has('New/Deep'));
  eq(replaced, [['needs calm', text.indexOf('needs quiet'), text.indexOf('needs quiet') + 'needs quiet'.length]]);
  assert.equal(h.contents.get('Notes/Research.md'), text, 'the vault copy is left to the editor to save');
});

integrationTest('map chat: an unsaved edit in the open editor makes the file stale against what was sent', async () => {
  const h = await harness(); await h.view.hydrate();
  const sent = h.contents.get('Notes/Research.md');
  const editor = { getValue: () => `${sent}typed meanwhile\n`, offsetToPos: () => ({}), replaceRange() { throw new Error('must not write'); } };
  h.setActive('Notes/Research.md', sent, editor);
  const lines = await apply(h, [{ kind: 'edit_md_file', path: 'Notes/Research.md', find: 'needs quiet', replace: 'x' }], h.hashes('Notes/Research.md'));
  assert.equal(lines[0].status, 'skipped'); assert.match(lines[0].text, /changed after you sent/);
});

integrationTest('map chat: a topic that disappeared, a move that would make a loop and a closed view are skipped, not failed', async () => {
  const h = await harness(); await h.view.hydrate();
  const lines = await apply(h, [
    { kind: 'rename_topic', nodeId: 'gone', title: 'x' },
    { kind: 'move_topic', nodeId: h.ids.root, newParentId: h.ids.c },
    { kind: 'update_summary', nodeId: h.ids.b, summary: 'fine' }
  ]);
  eq(lines.map(l => l.status), ['skipped', 'skipped', 'done']);
  assert.match(lines[0].text, /no longer on the map/); assert.match(lines[1].text, /loop/);
  let live = true; const mutatesBefore = h.control.mutates;
  const skippedAll = await apply(h, [{ kind: 'rename_topic', nodeId: h.ids.a, title: 'late' }, { kind: 'run_map_action', action: 'synthesize', nodeIds: [], title: '', goal: '', direction: '' }], {}, () => live && false);
  eq(skippedAll.map(l => l.status), ['skipped', 'skipped']); assert.equal(h.control.mutates, mutatesBefore, 'a dead run writes nothing');
  assert.notEqual((await h.note('a')).title, 'late'); void live;
});

integrationTest('map chat: a failing write is reported and the next action still runs', async () => {
  const h = await harness(); await h.view.hydrate();
  const original = h.view.noteChange.bind(h.view); let calls = 0;
  h.view.noteChange = async (node, patch) => { if (calls++ === 0) throw new Error('disk full'); return original(node, patch); };
  const lines = await apply(h, [{ kind: 'rename_topic', nodeId: h.ids.a, title: 'One' }, { kind: 'rename_topic', nodeId: h.ids.b, title: 'Two' }]);
  eq(lines.map(l => l.status), ['failed', 'done']); assert.match(lines[0].text, /disk full/);
  assert.equal((await h.note('b')).title, 'Two');
});

integrationTest('map chat: select_topics(all) then research_standard starts the standard research once on every topic, outside any mutate', async () => {
  const h = await harness(); await h.view.hydrate();
  const started = [];
  h.view.startMultiResearch = async request => { started.push({ request, selected: [...h.view.multiSelected], mutating: h.control.depth }); };
  h.control.mutates = 0;
  const lines = await apply(h, [
    { kind: 'select_topics', nodeIds: Object.values(h.ids), all: true },
    { kind: 'run_map_action', action: 'research_standard', nodeIds: [], title: '', goal: '', direction: '' }
  ]);
  eq(lines.map(l => l.status), ['done', 'done']); await tick();
  assert.equal(started.length, 1); eq(started[0].request, { researchMode: 'research', researchDepth: 'normal', requirements: '', imageSearch: false });
  eq(started[0].selected.sort(), Object.values(h.ids).sort()); assert.equal(started[0].mutating, 0, 'not inside a mutate');
  assert.equal(h.view.integrationMode, true); assert.equal(h.control.mutates, 0, 'selecting and starting research write nothing through the queue');
});

integrationTest('map chat: research on named topics selects exactly those first', async () => {
  const h = await harness(); await h.view.hydrate(); const seen = [];
  h.view.startMultiResearch = async () => { seen.push([...h.view.multiSelected]); };
  await apply(h, [{ kind: 'run_map_action', action: 'research_standard', nodeIds: [h.ids.a, h.ids.b], title: '', goal: '', direction: '' }]); await tick();
  eq(seen, [[h.ids.a, h.ids.b]]);
});

integrationTest('map chat: expand suggests subtopics for each target and creates them without the review dialog; a nested mutate inside it does not deadlock', async () => {
  const h = await harness(); await h.view.hydrate();
  const calls = []; let reviewOpened = 0; let created = 0;
  h.view.openChildSuggestions = () => { reviewOpened++; };
  h.view.proposeChildren = async (parent, options, direction, found, failed) => {
    calls.push({ parent: parent.id, options, direction, found: typeof found, failed: typeof failed });
    await h.plugin.mutate(async () => {}); // what the real task does when it writes: its own mutate
    found([{ title: 'S' }], async items => { created += items.length; await h.plugin.mutate(async () => {}); });
  };
  const lines = await withTimeout(apply(h, [{ kind: 'run_map_action', action: 'expand', nodeIds: [h.ids.a, h.ids.b], title: '', goal: '', direction: 'sleep hygiene' }]));
  eq(lines.map(l => l.status), ['done']);
  await withTimeout(until(() => created === 2));
  eq(calls.map(c => [c.parent, c.options, c.direction, c.found, c.failed]), [[h.ids.a, undefined, 'sleep hygiene', 'function', 'function'], [h.ids.b, undefined, 'sleep hygiene', 'function', 'function']]);
  assert.equal(reviewOpened, 0, 'the review dialog never opens'); assert.equal(h.control.nested, 0);
});

integrationTest('map chat: control - the same nested mutate really does hang when it is made from inside a write', async () => {
  const h = await harness();
  const nested = h.plugin.mutate(async () => { await h.plugin.mutate(async () => {}); });
  await assert.rejects(withTimeout(nested, 150), /timed out/);
  assert.equal(h.control.nested, 1, 'the harness counts the nested call, so a nested write would also fail the other tests');
});

integrationTest('map chat: synthesize opens the integration dialog for the selection; rate_by_goal and merge start their own task', async () => {
  const h = await harness(); await h.view.hydrate();
  const opened = []; h.view.openSelectionSynthesis = pending => opened.push(pending);
  const goals = []; h.view.relevanceGradeable = () => true; h.view.submitRelevanceGoal = async goal => { goals.push(goal); };
  const merges = []; h.view.mergeSelected = async (title, snapshot) => { merges.push([title, snapshot.sources.map(s => s.id).sort(), h.control.depth]); };
  const lines = await apply(h, [
    { kind: 'run_map_action', action: 'synthesize', nodeIds: [h.ids.a, h.ids.b], title: '', goal: '', direction: '' },
    { kind: 'run_map_action', action: 'rate_by_goal', nodeIds: [], title: '', goal: ' Sleep better ', direction: '' },
    { kind: 'run_map_action', action: 'merge', nodeIds: [h.ids.a, h.ids.b], title: 'Body and mind', goal: '', direction: '' }
  ]);
  eq(lines.map(l => l.status), ['done', 'done', 'done'], JSON.stringify(lines)); await tick();
  eq(opened, [null]); eq(goals, ['Sleep better']);
  eq(merges, [['Body and mind', [h.ids.a, h.ids.b].sort(), 1]], 'merge runs in its own mutate, after every write');
});

integrationTest('map chat: run actions are skipped, not guessed, when the map cannot take them', async () => {
  const h = await harness({ aim: true }); await h.view.hydrate();
  const lines = await apply(h, [
    { kind: 'select_topics', nodeIds: [h.ids.a], all: false },
    { kind: 'run_map_action', action: 'research_standard', nodeIds: [], title: '', goal: '', direction: '' }
  ]);
  eq(lines.map(l => l.status), ['skipped', 'skipped']);
  const plain = await harness(); await plain.view.hydrate();
  plain.view.relevanceGradeable = () => false; plain.view.openSelectionSynthesis = () => { throw new Error('must not open'); };
  const result = await apply(plain, [
    { kind: 'run_map_action', action: 'synthesize', nodeIds: [plain.ids.a], title: '', goal: '', direction: '' },
    { kind: 'run_map_action', action: 'rate_by_goal', nodeIds: [], title: '', goal: 'x', direction: '' },
    { kind: 'run_map_action', action: 'merge', nodeIds: [], title: '', goal: '', direction: '' },
    { kind: 'run_map_action', action: 'research_standard', nodeIds: ['nope'], title: '', goal: '', direction: '' }
  ]);
  eq(result.map(l => l.status), ['skipped', 'skipped', 'skipped', 'skipped']);
});

integrationTest('map chat: invalid items the parser dropped are counted in the chat', async () => {
  const h = await harness(); await h.view.hydrate();
  const lines = await h.view.applyMapChatActions({ actions: [], rejected: [{ index: 0, code: 'unknown_node' }, { index: 1, code: 'bad_item' }] }, {});
  eq(lines, [{ status: 'skipped', text: '2 suggested changes were invalid and were ignored.' }]);
});

integrationTest('map chat: sending asks for usage consent first, builds the context from the references and the open note, streams, then applies', async () => {
  const h = await harness(); await h.view.hydrate();
  h.setActive('Notes/Other.md', h.contents.get('Notes/Other.md'));
  const chat = h.open();
  chat.addTopicReference(h.ids.c); chat.addSnippet('darkness', 'Notes/Research.md', false); chat.addFile('Notes/Research.md');
  h.view.selected = h.ids.a;
  const seen = [];
  h.control.reply = async (request, _signal, onReply) => {
    onReply('Thinking'); seen.push(chat.transcript().at(-1).text); onReply('Thinking harder'); seen.push(chat.transcript().at(-1).text);
    return { reply: 'Renamed it.', actions: [{ kind: 'rename_topic', nodeId: h.ids.b, title: 'Mind work' }, { kind: 'edit_md_file', path: 'Notes/Research.md', find: 'needs quiet', replace: 'needs calm' }], rejected: [] };
  };
  h.type('  rename Mind  ');
  await h.view.sendMapChat();
  eq(h.control.calls, ['confirm', 'chat'], 'consent comes before any request');
  const request = h.control.requests[0]; const context = JSON.parse(request.context.json);
  assert.equal(request.message, 'rename Mind'); assert.equal(request.model, 'claude:sonnet'); assert.equal(request.language, 'en');
  eq(context.selected.map(s => s.id), [h.ids.a]); eq(context.references.map(s => s.id), [h.ids.c]);
  assert.equal(context.snippets[0].text, 'darkness'); assert.ok(context.snippets[0].contentHash, 'the snippet carries its file\'s hash so it can be edited');
  assert.equal(context.files[0].content, h.contents.get('Notes/Research.md').replace('needs calm', 'needs quiet'));
  assert.equal(context.activeFile.path, 'Notes/Other.md'); assert.equal(context.outline.length, 4);
  eq(seen, ['Thinking', 'Thinking harder'], 'the answer streams into the last message');
  const turn = chat.transcript(); assert.equal(turn.at(-1).text, 'Renamed it.');
  eq(turn.at(-1).lines.map(l => l.status), ['done', 'done'], JSON.stringify(turn.at(-1).lines));
  assert.equal((await h.note('b')).title, 'Mind work'); assert.match(h.contents.get('Notes/Research.md'), /needs calm/);
  assert.equal(chat.isBusy, false); assert.equal(h.plugin.activeTasks.size, 0, 'the task key is released');
  assert.equal(chat.draft, '');
});

integrationTest('map chat: declining the usage notice sends nothing and keeps the draft', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); h.control.decline = true;
  h.type('hello'); await h.view.sendMapChat();
  eq(h.control.calls, ['confirm']); assert.equal(chat.draft, 'hello'); assert.equal(chat.transcript().length, 0);
});

integrationTest('map chat: an empty draft, a second send while busy and a send on the sample map do nothing', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  h.type('   '); await h.view.sendMapChat(); eq(h.control.calls, []);
  const gate = deferred(); h.control.reply = async () => { await gate.promise; return { reply: 'r', actions: [], rejected: [] }; };
  h.type('one'); const first = h.view.sendMapChat(); await until(() => chat.isBusy);
  h.type('two'); await h.view.sendMapChat(); assert.equal(h.control.requests.length, 1, 'only one request at a time');
  gate.resolve(); await first;
  h.view.builtIn = true; h.type('three'); await h.view.sendMapChat(); assert.equal(h.control.requests.length, 1);
});

integrationTest('map chat: Stop aborts the request, releases the task, and a reply that still arrives applies nothing', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  const gate = deferred(); let signal;
  h.control.reply = async (_request, s) => { signal = s; await gate.promise; return { reply: 'late', actions: [{ kind: 'rename_topic', nodeId: h.ids.a, title: 'LATE' }, { kind: 'create_md_file', path: 'Late.md', content: 'x' }], rejected: [] }; };
  h.type('go'); const sending = h.view.sendMapChat(); await until(() => chat.isBusy);
  assert.equal(h.plugin.activeTasks.size, 1, 'the request is registered so unloading the plugin can stop it');
  const writesBefore = h.control.mutates;
  chat.stopEl.click();
  assert.equal(signal.aborted, true); assert.equal(h.plugin.activeTasks.size, 0); assert.equal(chat.isBusy, false);
  gate.resolve(); await sending;
  assert.equal(h.control.mutates, writesBefore, 'no write was queued by the late reply'); assert.equal((await h.note('a')).title, 'Body'); assert.equal(h.files.has('Late.md'), false);
  assert.equal(chat.transcript().at(-1).text, 'Stopped.');
});

integrationTest('map chat: closing the view aborts the request, clears the task and a late reply writes nothing', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  const gate = deferred(); let signal;
  h.control.reply = async (_request, s) => { signal = s; await gate.promise; return { reply: 'late', actions: [{ kind: 'rename_topic', nodeId: h.ids.a, title: 'LATE' }], rejected: [] }; };
  h.type('go'); const sending = h.view.sendMapChat(); await until(() => chat.isBusy);
  await h.view.onClose();
  assert.equal(signal.aborted, true); assert.equal(h.plugin.activeTasks.size, 0);
  const writesBefore = h.control.mutates;
  gate.resolve(); await sending;
  assert.equal(h.control.mutates, writesBefore); assert.equal((await h.note('a')).title, 'Body');
});

integrationTest('map chat: a reply that arrives after the map was switched applies nothing', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  const gate = deferred();
  h.control.reply = async () => { await gate.promise; return { reply: 'late', actions: [{ kind: 'rename_topic', nodeId: h.ids.a, title: 'LATE' }], rejected: [] }; };
  h.type('go'); const sending = h.view.sendMapChat(); await until(() => chat.isBusy);
  h.view.path = 'Agent Workspace/Topics/other/Map.md'; gate.resolve(); await sending;
  assert.equal(h.control.mutates, 0); assert.equal((await h.note('a')).title, 'Body');
});

integrationTest('map chat: closing the view in the middle of the actions skips the rest', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  h.control.reply = async () => ({ reply: 'many', actions: [{ kind: 'rename_topic', nodeId: h.ids.a, title: 'First' }, { kind: 'rename_topic', nodeId: h.ids.b, title: 'Second' }], rejected: [] });
  const original = h.view.noteChange.bind(h.view);
  h.view.noteChange = async (node, patch) => { await original(node, patch); await h.view.onClose(); };
  h.type('go'); await h.view.sendMapChat();
  assert.equal((await h.note('a')).title, 'First'); assert.equal((await h.note('b')).title, 'Mind', 'the second write never ran');
  assert.equal(chat.transcript().at(-1).text, '', 'a closed view is not updated');
});

integrationTest('map chat: service errors become readable chat text and unlock the panel', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  const fail = async error => { h.control.reply = async () => { throw error; }; h.type('go'); await h.view.sendMapChat(); return chat.transcript().at(-1).text; };
  const named = (code, message) => Object.assign(new Error(message), { name: 'MapChatError', code });
  assert.match(await fail(named('over_budget', 'big')), /too large to send/);
  assert.match(await fail(named('invalid', 'bad')), /could not be read/);
  assert.equal(await fail(named('stopped', 'stopped')), 'Stopped.');
  assert.equal(await fail(new Error('network down')), 'The AI chat failed: network down');
  assert.equal(chat.isBusy, false); assert.equal(h.plugin.activeTasks.size, 0);
});

integrationTest('map chat: a repaint keeps messages, draft and chips, restores focus and caret, and makes room for the panel', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  chat.addTopicReference(h.ids.a); chat.begin('q'); chat.finish('a', []);
  chat.inputEl.value = 'typing…'; chat.inputEl.selectionStart = 3; chat.inputEl.selectionEnd = 3; chat.inputEl.focus();
  const el = chat.el; h.repaint();
  assert.equal(h.view.chat.el, el); assert.equal(chat.draft, 'typing…'); assert.equal(chat.transcript().length, 2); assert.equal(chat.attachments().length, 1);
  assert.equal(h.page.doc.activeElement, chat.inputEl, 'focus is back in the field'); assert.equal(chat.inputEl.selectionStart, 3);
  assert.ok(find(h.rootEl, i => i === el), 'the panel is in the new overlay'); assert.ok(h.workspace().classes.includes('has-map-chat-open'));
  chat.setOpen(false); assert.ok(!h.workspace().classes.includes('has-map-chat-open'), 'the selection bar and hint get their room back');
  h.repaint(); assert.ok(!h.workspace().classes.includes('has-map-chat-open'));
  assert.ok(find(find(h.rootEl, i => hasClass(i, 'vam-canvas-overlay')), i => i === el));
});

integrationTest('map chat: repaints caused by the chat\'s own writes keep the conversation going', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  chat.inputEl.focus(); h.control.reply = async () => ({ reply: 'done', actions: [{ kind: 'add_child', parentId: h.ids.a, title: 'New one', summary: '' }], rejected: [] });
  h.type('add'); const renders = h.renders(); await h.view.sendMapChat();
  assert.ok(h.renders() > renders, 'the map repainted while the answer was being applied');
  assert.equal(chat.transcript().at(-1).text, 'done'); assert.ok(find(h.rootEl, i => i === chat.el));
});

integrationTest('map chat: a different map starts a new conversation, the sample map gets no panel', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  chat.begin('old'); chat.finish('old answer', []); chat.addTopicReference(h.ids.a);
  h.view.map.id = 'another-map'; h.repaint();
  assert.equal(chat.transcript().length, 0); assert.equal(chat.attachments().length, 0);
  chat.begin('x'); chat.finish('y', []);
  h.view.builtIn = true; h.repaint(); assert.equal(find(h.rootEl, i => i === chat.el), undefined, 'not mounted on the read-only sample');
  h.view.builtIn = false; h.repaint(); assert.ok(find(h.rootEl, i => i === chat.el)); assert.equal(chat.transcript().length, 2, 'and it comes back as it was');
});

integrationTest('map chat: the selection (one card, or the selected set) shows as references', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  h.view.selected = h.ids.a; h.view.paintCards([h.ids.a]);
  const labels = () => findAll(chat.chipsEl, i => hasClass(i, 'vam-map-chat-chip-label')).map(i => i.text);
  eq(labels(), ['Selected: Body']);
  h.view.multiSelected = new Set([h.ids.b, h.ids.c]); h.view.integrationMode = true; h.view.paintCards([h.ids.b]);
  eq(labels(), ['Selected: Mind', 'Selected: REM'], 'in selection mode the selected set becomes the references');
});

// ---- dragging a card onto the panel -------------------------------------------------------------------------------

async function dragHarness() {
  const h = await harness(); await h.view.hydrate();
  const chat = h.open();
  chat.el.getBoundingClientRect = () => ({ left: 0, top: 300, right: 360, bottom: 700, width: 360, height: 400 });
  const events = new Map(); const origin = h.node('a'); const card = { style: { left: `${origin.x}px`, top: `${origin.y}px` }, setPointerCapture() {}, addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) };
  const changes = []; h.view.mapChange = async change => { changes.push(change); };
  const target = h.node('a');
  h.view.enableDrag(card, target);
  const down = () => events.get('pointerdown')({ target: { closest: () => null }, button: 0, pointerId: 1, clientX: 500, clientY: 100 });
  const move = (x, y) => events.get('pointermove')({ clientX: x, clientY: y });
  const up = () => events.get('pointerup')({ type: 'pointerup' });
  return { ...h, chat, card, events, changes, down, move, up };
}

integrationTest('map chat: releasing a card over the panel adds a topic chip, puts the card back and writes nothing to the map', async () => {
  const d = await dragHarness();
  d.down(); d.move(100, 400);
  assert.ok(hasClass(d.chat.el, 'is-drop'), 'the panel lights up while a card is over it');
  d.up();
  eq(d.chat.attachments(), [{ kind: 'topic', id: d.ids.a }]);
  assert.equal(d.changes.length, 0, 'no mapChange: the card did not move'); assert.equal(d.card.style.left, `${d.node('a').x}px`); assert.equal(d.card.style.top, `${d.node('a').y}px`);
  assert.ok(!hasClass(d.chat.el, 'is-drop'), 'the highlight is cleared'); assert.equal(d.view.dragging, false); assert.equal(d.chat.isOpen, true);
});

integrationTest('map chat: releasing a card on the canvas moves it as before and adds no chip', async () => {
  const d = await dragHarness();
  d.down(); d.move(520, 150); d.move(560, 160); d.up(); await until(() => d.changes.length > 0);
  assert.equal(d.chat.attachments().length, 0); assert.equal(d.changes.length, 1, 'the normal mapChange move');
  const moved = { x: d.node('a').x, y: d.node('a').y }; const map = { nodes: [{ ...d.node('a') }] }; d.changes[0](map);
  eq([map.nodes[0].x, map.nodes[0].y], [moved.x + 60, moved.y + 60]);
});

integrationTest('map chat: moving over the panel and back out before releasing moves the card normally', async () => {
  const d = await dragHarness();
  d.down(); d.move(100, 400); assert.ok(hasClass(d.chat.el, 'is-drop')); d.move(520, 150); assert.ok(!hasClass(d.chat.el, 'is-drop')); d.up(); await until(() => d.changes.length > 0);
  assert.equal(d.chat.attachments().length, 0); assert.equal(d.changes.length, 1);
});

integrationTest('map chat: a click on a card (no drag) is still a click and adds no chip', async () => {
  const d = await dragHarness();
  d.down(); d.up();
  assert.equal(d.chat.attachments().length, 0); assert.equal(d.changes.length, 0); assert.equal(d.view.selected, d.ids.a, 'the card was selected as usual');
});

integrationTest('map chat: while the map is sorted by relevance a card dropped on the panel is still a reference', async () => {
  const d = await dragHarness();
  d.view.relevanceSortOn = () => true;
  d.down(); d.move(100, 400); assert.ok(hasClass(d.chat.el, 'is-drop')); d.up();
  eq(d.chat.attachments(), [{ kind: 'topic', id: d.ids.a }]); assert.equal(d.changes.length, 0);
  const out = await dragHarness(); out.view.relevanceSortOn = () => true;
  out.down(); out.move(520, 150); out.up(); assert.equal(out.chat.attachments().length, 0, 'sorted cards still stay put outside the panel'); assert.equal(out.changes.length, 0);
});

integrationTest('map chat: a merging card dropped on the panel is a reference too, and cancelling the drag leaves nothing highlighted', async () => {
  const d = await dragHarness();
  d.view.mergeTasks.set(d.view.path, { mapPath: d.view.path, sources: [{ id: d.ids.a, path: d.node('a').path }], controller: new AbortController(), state: 'running' });
  d.down(); d.move(100, 400); d.up(); assert.equal(d.chat.attachments().length, 1);
  const c = await dragHarness(); c.down(); c.move(100, 400); c.events.get('pointercancel')({ type: 'pointercancel' });
  assert.ok(!hasClass(c.chat.el, 'is-drop')); assert.equal(c.chat.attachments().length, 0); assert.equal(c.changes.length, 0);
});

// ---- the view around the panel ---------------------------------------------------------------------------------------

integrationTest('map chat: changed() refreshes at once while the chat field has focus, waits for other fields and for IME composition', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  const runs = []; h.view.enqueue = work => { runs.push(work); };
  const file = h.app.vault.getAbstractFileByPath(MAP);
  const tick400 = () => { h.view.changed(file); const fire = h.timers.pop(); assert.ok(fire, 'a refresh was scheduled'); fire(); };
  chat.inputEl.focus();
  tick400(); assert.equal(runs.length, 1, 'chat field focused: the map refreshes'); assert.equal(h.timers.length, 0);
  chat.inputEl.fire('compositionstart');
  tick400(); assert.equal(runs.length, 1, 'IME composition in the chat field: the refresh waits'); assert.equal(h.timers.length, 1, 'and tries again later'); h.timers.length = 0;
  chat.inputEl.fire('compositionend');
  tick400(); assert.equal(runs.length, 2);
  const other = h.rootEl.createDiv(); other.matches = selector => /input/.test(selector); h.page.doc.activeElement = other;
  tick400(); assert.equal(runs.length, 2, 'any other text field still holds the refresh back'); assert.equal(h.timers.length, 1); h.timers.length = 0;
  h.page.doc.activeElement = null; tick400(); assert.equal(runs.length, 3);
});

integrationTest('map chat: keys inside the chat field are not taken by the view scope', async () => {
  const h = await harness();
  const keys = h.view.scope.keys;
  const find2 = (modifiers, key) => keys.find(k => k.key === key && JSON.stringify(k.modifiers) === JSON.stringify(modifiers));
  const chatField = { closest: selector => (/textarea/.test(selector) ? chatField : null) };
  const travel = []; h.view.travel = async redo => { travel.push(redo); };
  const eventOn = target => ({ target, isComposing: false, defaultPrevented: false });
  assert.equal(find2(['Mod'], 'z').func(eventOn(chatField)), true, 'Mod+Z stays with the text field (its own undo)'); assert.equal(travel.length, 0);
  assert.equal(find2(['Mod', 'Shift'], 'z').func(eventOn(chatField)), true); assert.equal(travel.length, 0);
  h.view.cardEls = new Map([['x', { id: 'card' }]]); // a card exists, but it does not have focus
  assert.equal(find2(['Mod'], 'Enter').func(eventOn(chatField)), true, 'Mod+Enter is not turned into "add subtopic" inside the chat');
  assert.equal(find2(['Shift'], 'Enter').func(eventOn(chatField)), true, 'Shift+Enter stays a line break');
  assert.equal(find2([], 'F2').func(eventOn(chatField)), true);
});

test('map chat: nothing in the visual map code uses the private dragManager', () => {
  const dir = path.join(root, 'experiences/visual-map');
  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.ts'))) assert.doesNotMatch(fs.readFileSync(path.join(dir, file), 'utf8'), /dragManager/, file);
});

test('map chat: render() detaches the panel before it clears the page and mounts it into the new overlay', () => {
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  const render = source.slice(source.indexOf('  private render(): void {'), source.indexOf('  /** `shownNode` may be a display copy'));
  const order = ['this.detachMapChat()', 'this.contentEl.empty()', 'this.mountMapChat(workspace, overlay)', 'restoreChatFocus()'].map(part => render.indexOf(part));
  assert.ok(order.every(at => at > 0), `render() mentions all four: ${order}`);
  eq([...order].sort((a, b) => a - b), order, 'in that order');
});
