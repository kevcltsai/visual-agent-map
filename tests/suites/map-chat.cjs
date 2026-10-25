// Map AI chat window (Packet B2): the panel on its own, then the real view and repository with a fake chat service.
// DOM: tests/support-dom.cjs elements. The view's full render() needs far more than a DOM fake offers, so the repaint tests drive
// the same methods render() calls (detachMapChat before the old content goes, mountMapChat once the overlay exists).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, integrationTest, root, load, core, plain, DEFAULT_SETTINGS, fixture, withExpansionCoordinator, until, deferred, obsidian } = require('../support.cjs');
const dom = require('../support-dom.cjs');
const { element, find, findAll, byLabel, tick } = dom;

const eq = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message);
// Text a reader would see in an element: its own text and its children's, in order.
const visibleText = el => (el.text ?? '') + el.children.map(visibleText).join('');
const replyBody = f => find(f.parts.log(), i => hasClass(i, 'is-assistant')).children.find(c => hasClass(c, 'vam-map-chat-text'));
const MAP = 'Agent Workspace/Topics/map-a/Map.md';
const { contentHash, buildMapChatContext } = load('core/map-chat-context.ts');

// ---- panel on its own -------------------------------------------------------------------------------------------

/** A document stand-in: `activeElement` follows focus(), like the real one, and is cleared when the focused element is removed. */
function page() {
  const doc = { activeElement: null };
  const root = element('div'); root.root = doc; root.ownerDocument = doc;
  const attach = parent => { parent.appendChild = node => { node.parent?.children.splice(node.parent.children.indexOf(node), 1); node.parent = parent; parent.children.push(node); return node; }; return parent; };
  attach(root);
  return { doc, root, attach };
}
/** The panel module together with the setter of the interface language that the same bundle reads (a bundle has its own copy of it). */
function loadPanelModule(windowValues = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-map-chat-entry-')); const file = path.join(dir, 'entry.ts');
  fs.writeFileSync(file, `export { MapChatPanel } from ${JSON.stringify(path.join(root, 'experiences/visual-map/map-chat'))};\nexport { setUiLanguage } from ${JSON.stringify(path.join(root, 'i18n'))};\n`);
  try { return load(path.relative(root, file), { obsidian: { ...obsidian, Keymap: { isModEvent: event => !!event.ctrlKey } } }, windowValues); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function panelFixture(overrides = {}, windowValues = {}) {
  const { MapChatPanel, setUiLanguage } = loadPanelModule(windowValues);
  const p = page(); const overlay = p.attach(p.root.createDiv('vam-canvas-overlay'));
  const calls = { send: 0, stop: 0, layout: [], more: [], links: [] };
  const topics = { a: 'Topic A', b: 'Topic B' };
  let selected = [];
  let visibleNote = null;
  const prefs = { style: 'concise', model: '', saved: [], watchers: [] };
  const host = {
    style: () => prefs.style, setStyle: style => { prefs.style = style; prefs.saved.push(['style', style]); },
    modelChoices: () => [{ value: '', label: 'Follow default (now: X)' }, { value: 'claude:haiku', label: 'Haiku' }, { value: 'gpt-6', label: 'GPT 6' }],
    watchModels: changed => { prefs.watchers.push(changed); return () => { prefs.watchers.splice(prefs.watchers.indexOf(changed), 1); }; },
    model: () => prefs.model, setModel: model => { prefs.model = model; prefs.saved.push(['model', model]); }, moreDetail: origin => { calls.more.push(origin); },
    topicTitle: id => topics[id] ?? null, selectedIds: () => selected, send: () => { calls.send++; }, stop: () => { calls.stop++; },
    resolveLink: link => ({ Note: 'Notes/Note.md', Other: 'Notes/Other.md' })[link] ?? null, activeNotePath: () => 'Notes/Active.md', visibleNotePath: () => visibleNote,
    openLink: (href, newLeaf) => { calls.links.push([href, newLeaf]); }, activeElement: () => p.doc.activeElement, layoutChanged: open => calls.layout.push(open), ...overrides
  };
  const panel = new MapChatPanel(host);
  panel.mount(overlay);
  const parts = {
    toggle: () => find(panel.el, i => i.tag === 'button' && hasClass(i, 'vam-map-chat-toggle')),
    input: () => panel.inputEl, log: () => panel.logEl, chips: () => panel.chipsEl, status: () => panel.statusEl,
    send: () => byLabel(panel.el, 'Send'), stop: () => byLabel(panel.el, 'Stop'), close: () => byLabel(panel.bodyEl, 'Close AI chat'),
    chipTexts: () => findAll(panel.chipsEl, i => hasClass(i, 'vam-map-chat-chip-label')).map(i => i.text)
  };
  return { panel, overlay, calls, prefs, page: p, parts, setLanguage: setUiLanguage, setVisible: path => { visibleNote = path; }, showNote: path => { visibleNote = path; panel.refreshNote(); }, select: ids => { selected = ids; panel.refreshSelection(); } };
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

test('map chat: the toggle button\'s label and aria-expanded follow the open state', () => {
  const f = panelFixture(); const toggle = f.parts.toggle();
  assert.equal(toggle.attrs['aria-label'], 'Open AI chat'); assert.equal(toggle.attrs['aria-expanded'], 'false');
  f.panel.setOpen(true);
  assert.equal(toggle.attrs['aria-label'], 'Close AI chat'); assert.equal(toggle.attrs['aria-expanded'], 'true');
  f.panel.setOpen(false);
  assert.equal(toggle.attrs['aria-label'], 'Open AI chat'); assert.equal(toggle.attrs['aria-expanded'], 'false');
});

test('map chat: removing a chip moves focus to the next chip\'s remove button, else the previous one, else the message field', () => {
  const f = panelFixture(); f.panel.setOpen(true);
  for (const id of ['a', 'b']) f.panel.addTopicReference(id);
  f.panel.addSnippet('third', 'Notes/x.md', false);
  const removes = () => findAll(f.panel.chipsEl, i => hasClass(i, 'vam-map-chat-chip-remove'));
  const focused = () => f.page.doc.activeElement;
  assert.equal(removes().length, 3);
  removes()[1].click(); // middle: focus goes to what is now at its place (the third chip)
  assert.equal(removes().length, 2); assert.equal(focused(), removes()[1]);
  removes()[1].click(); // last: previous
  assert.equal(removes().length, 1); assert.equal(focused(), removes()[0]);
  removes()[0].click(); // only one: the message field
  assert.equal(removes().length, 0); assert.equal(focused(), f.parts.input());
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

test('map chat: while the AI works Stop is shown with a visible status, the reply streams in place, and the turn ends with action lines', async () => {
  const f = panelFixture(); f.panel.setOpen(true);
  f.parts.input().value = 'ask';
  f.panel.begin('ask');
  assert.equal(f.parts.input().value, '', 'the draft is cleared once the question is sent');
  assert.equal(f.parts.status().text, 'The AI is replying…'); assert.equal(f.parts.send().hidden, true); assert.equal(f.parts.stop().hidden, false);
  assert.equal(f.parts.stop().attrs['aria-label'], 'Stop'); assert.equal(f.parts.status().attrs.role, 'status'); assert.equal(f.parts.log().attrs.role, 'log');
  f.panel.streamReply('partial'); f.panel.streamReply('partial answer'); await tick();
  assert.equal(visibleText(replyBody(f)), 'partial answer');
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

async function harness({ aim = false, document = false, empty = false } = {}) {
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
  if (!empty) { await add('root', 'Sleep'); await add('a', 'Body', 'root'); await add('b', 'Mind', 'root'); await add('c', 'REM', 'a'); }
  await app.vault.create(MAP, core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  for (const [file, text] of Object.entries({ 'Notes/Research.md': '# Research\n\nSleep needs darkness.\nSleep needs quiet.\n', 'Notes/Other.md': 'Other note about naps.\n', '.obsidian/plugins/x.md': 'config text\n' })) {
    const folder = file.split('/').slice(0, -1).join('/');
    for (const part of [folder.split('/')[0], folder]) if (!files.has(part)) await app.vault.createFolder(part);
    await app.vault.create(file, text);
  }
  const notices = [], opened = [];
  const control = { reply: async () => ({ reply: 'ok', actions: [], rejected: [] }), requests: [], models: [], claudeReady: true, listeners: [], refreshes: [], usageAsks: 0, decline: false, nested: 0, mutates: 0, depth: 0, calls: [], markdown: [] };
  let queue = Promise.resolve();
  const ctx = {};
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), views: () => ctx.otherViews ?? [], logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), closeStaleDetails() {}, releaseOutline() {}, syncOutline() {}, setOutlineActive() {},
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
    saveSettings: async () => { control.saves = (control.saves ?? 0) + 1; },
    availableModels: () => control.claudeReady ? ['gpt-6-luna', 'claude:sonnet', 'claude:haiku'] : ['gpt-6-luna'], modelLabel: id => `label(${id})`,
    subscribeModelDiscovery: listener => { control.listeners.push(listener); return () => { control.listeners.splice(control.listeners.indexOf(listener), 1); }; },
    refreshModelDiscovery: async provider => { control.refreshes.push(provider); return { provider, status: 'ready', models: [] }; },
    confirmAiUsage: async (model, run) => { control.usageAsks++; control.models.push(model); control.calls.push('confirm'); if (control.decline) return false; await run(); return true; },
    mapChat: { chat: async (request, signal, onReply) => { control.calls.push('chat'); control.requests.push(request); return control.reply(request, signal, onReply); } }
  });
  const leaves = []; let activeMarkdown = null;
  const handlers = []; const linkOpens = [];
  app.workspace = { getLeavesOfType: type => type === 'markdown' ? leaves : [], getActiveViewOfType: () => activeMarkdown, requestSaveLayout() {}, on(name, fn) { const ref = { name, fn }; handlers.push(ref); return ref; }, openLinkText(link, source, newLeaf) { linkOpens.push([link, source, newLeaf]); } };
  class Notice { constructor(message) { notices.push(message); } hide() {} }
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, MarkdownView, Notice, Component: class { load() {} unload() {} }, MarkdownRenderer: { render: async (_app, text, el, sourcePath, owner) => { control.markdown.push({ text, el, sourcePath, owner }); el.setText(text); } } } }, { ...(document ? { document: { documentElement: { style: {} }, get activeElement() { return ctx.page?.doc.activeElement ?? null; } } } : {}), CSS: { escape: value => String(value) }, createSvg: tag => ({ tag, attrs: {}, classes: [], setAttribute(name, value) { this.attrs[name] = value; }, addClass(name) { this.classes.push(name); } }), requestAnimationFrame: run => { run(); return 1; }, cancelAnimationFrame() {}, setTimeout: fn => { ctx.timers.push(fn); return ctx.timers.length; }, clearTimeout() {} });
  ctx.timers = [];
  const view = new VisualAgentMapView({ app }, plugin);
  ctx.view = view;
  const p = page(); const rootEl = p.root; ctx.page = p;
  const focused = [];
  Object.assign(view, { path: MAP, contentEl: rootEl, focusNode(node) { focused.push(node.id); }, closed: false });
  view.map = await repo.readMap(MAP);
  if (aim) view.map.aim = { version: 1, branches: [], runs: [], pendingCommits: [] };
  const rawSend = view.sendMapChat.bind(view); view.sendMapChat = (...args) => withTimeout(rawSend(...args));
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
    repo, app, contents, files, view, plugin, ids, control, notices, focused, opened, leaves, handlers, linkOpens, page: p, rootEl, get timers() { return ctx.timers; }, repaint, renders: () => renders, workspace: () => workspaceEl,
    setActive: (file, text, editor) => { const v = h.leaf(file, { editor }); activeMarkdown = v; leaves.splice(0, leaves.length, { view: v }); return v; },
    // A markdown leaf; `shown` false is a background tab, `doc` another window. Not made active.
    leaf: (file, { shown = true, doc = p.doc, editor = null } = {}) => Object.assign(new MarkdownView(), { file: app.vault.getAbstractFileByPath(file), editor, containerEl: { ownerDocument: doc, isShown: () => shown } }),
    setLeaves: (...views) => { leaves.splice(0, leaves.length, ...views.map(view => ({ view }))); },
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
// The default baseline is a context sent right now with every card in full (selected), so only a real change since then is stale.
const topicBaseline = (h, { full = true } = {}) => {
  const state = id => h.view.chatTopicState(id);
  const outline = h.view.map.nodes.map(n => ({ id: n.id, title: state(n.id).title, summary: state(n.id).summary, parentId: n.parentId, depth: 0 }));
  const selected = full ? h.view.map.nodes.map(n => ({ id: n.id, ...state(n.id), path: n.path })) : [];
  return buildMapChatContext({ mapTitle: 'm', outline, selected, references: [], snippets: [], files: [], history: [] }).topicHashes;
};
const NOT_UNDOABLE = 'These changes cannot be undone; the undo history was cleared.';
// Resolves with the action lines; the closing "cannot be undone" line is left out and reported as `.notice` (true when it was there).
const apply = async (h, actions, hashes = {}, alive, topicHashes) => {
  const all = await withTimeout(h.view.applyMapChatActions({ actions, rejected: [] }, { mdHashes: hashes, topicHashes: topicHashes ?? topicBaseline(h) }, alive));
  const lines = all.filter(l => l.text !== NOT_UNDOABLE); lines.notice = lines.length !== all.length;
  return lines;
};

integrationTest('map chat: one reply applies add_child, rename_topic, move_topic and edit_md_file in order, each in its own mutate, and clears the undo history', async () => {
  const h = await harness(); await h.view.hydrate();
  h.view.history.push({ undo: async () => {}, redo: async () => {}, label: 'earlier' });
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
  assert.equal(h.view.history.undoEntry, undefined, 'a chat write leaves nothing to undo'); assert.equal(lines.notice, true, 'the reply says so');
  eq(lines.map(l => l.text.split(':')[0]), ['Done', 'Done', 'Done', 'Done']);
});

// F1 (reviewer R1): an undo entry holds the map as it was before the chat wrote, so undoing it after the chat renamed files and moved cards
// puts the map out of step with the notes (an orphan file, a parent that no longer exists, "File not found"). The history is cleared instead.
integrationTest('map chat: F1 - a card drag, then a chat write, then Undo: nothing is left to undo, and the map and the files stay in step', async () => {
  const h = await harness(); await h.view.hydrate();
  const dragged = { snapshot: true, undo: async () => { throw new Error('File not found (a stale snapshot was restored)'); }, redo: async () => {}, label: 'drag card' };
  h.view.history.push(dragged);
  assert.equal(h.view.history.undoEntry, dragged);
  const lines = await apply(h, [{ kind: 'add_child', parentId: h.ids.b, title: 'Dreams', summary: '' }, { kind: 'move_topic', nodeId: h.ids.c, newParentId: h.ids.b }]);
  eq(lines.map(l => l.status), ['done', 'done']);
  assert.equal(h.view.history.undoEntry, undefined, 'the earlier snapshot entry is gone');
  assert.equal(h.view.history.undo(), undefined, 'Undo has nothing to run');
  const nodes = await h.saved();
  for (const n of nodes) assert.ok(h.files.has(n.path), `${n.path} exists`);
  assert.ok(nodes.some(n => n.parentId === h.ids.b && n.id !== h.ids.c), 'the new card is on the saved map');
  assert.equal(nodes.find(n => n.id === h.ids.c).parentId, h.ids.b);
});

integrationTest('map chat: F1 - other views of the same map lose their undo history too; a view of another map keeps it; skipped writes clear nothing', async () => {
  const h = await harness(); await h.view.hydrate();
  const other = { path: MAP, history: new (load('map-model.ts').History)() }; const elsewhere = { path: 'Other/Map.md', history: new (load('map-model.ts').History)() };
  const entry = { undo: async () => {}, redo: async () => {}, label: 'x' };
  other.history.push(entry); elsewhere.history.push(entry); h.view.history.push(entry);
  h.view.ctxOther = [other, elsewhere]; h.plugin.views = () => [h.view, other, elsewhere];
  const none = await apply(h, [{ kind: 'rename_topic', nodeId: 'zzz', title: 'Nope' }]);
  eq(none.map(l => l.status), ['skipped']); assert.equal(none.notice, false);
  assert.equal(h.view.history.undoEntry, entry, 'nothing was written, so nothing was cleared');
  await apply(h, [{ kind: 'rename_topic', nodeId: h.ids.a, title: 'Renamed' }]);
  assert.equal(h.view.history.undoEntry, undefined); assert.equal(other.history.undoEntry, undefined); assert.equal(elsewhere.history.undoEntry, entry);
});

integrationTest('map chat: F1 (reviewer probe) - a card moved by the user, then a chat reply that adds, moves and deletes cards: Undo cannot restore a map that points at missing files', async () => {
  const h = await harness(); await h.view.hydrate();
  await h.plugin.mutate(() => h.view.mapChange(map => { map.nodes.find(n => n.id === h.ids.b).x += 50; }));
  assert.ok(h.view.history.undoEntry, 'the user\'s drag made a snapshot entry');
  await apply(h, [
    { kind: 'add_child', parentId: h.ids.b, title: 'Dreams', summary: '' },
    { kind: 'move_topic', nodeId: h.ids.c, newParentId: h.ids.b },
    { kind: 'delete_topic', nodeId: h.ids.a, branch: false }
  ]);
  assert.equal(h.view.history.undoEntry, undefined, 'there is no entry left to restore the pre-chat snapshot');
  const after = await h.saved();
  for (const n of after) assert.ok(h.app.vault.getAbstractFileByPath(n.path), `${n.path} exists`);
  assert.ok(!after.some(n => n.id === h.ids.a), 'the deleted card stays off the map');
});

integrationTest('map chat: F2 - edit_topic_note needs the card\'s Detail baseline: a card seen only in the outline is never overwritten', async () => {
  const h = await harness(); await h.view.hydrate();
  await h.repo.updateNote(h.node('a').path, { detail: 'Original body' }); await h.view.hydrate();
  const act = [{ kind: 'edit_topic_note', nodeId: h.ids.a, detail: 'Replaced by the AI' }];
  const blind = await apply(h, act, {}, undefined, topicBaseline(h, { full: false }));
  eq(blind.map(l => l.status), ['skipped']); assert.match(blind[0].text, /was not shown/);
  assert.notEqual((await h.note('a')).detail.trim(), 'Replaced by the AI'); assert.equal(blind.notice, false);
  const seen = await apply(h, act);
  eq(seen.map(l => l.status), ['done']); assert.equal((await h.note('a')).detail.trim(), 'Replaced by the AI');
});

integrationTest('map chat: F2 - the Detail changed after the message was sent, so edit_topic_note is skipped and the new text stays', async () => {
  const h = await harness(); await h.view.hydrate();
  await h.repo.updateNote(h.node('a').path, { detail: 'Original body' }); await h.view.hydrate();
  const baseline = topicBaseline(h);
  await h.repo.updateNote(h.node('a').path, { detail: 'User typed this meanwhile' }); await h.view.hydrate();
  const lines = await apply(h, [{ kind: 'edit_topic_note', nodeId: h.ids.a, detail: 'AI text' }], {}, undefined, baseline);
  eq(lines.map(l => l.status), ['skipped']); assert.match(lines[0].text, /changed after you sent/);
  assert.equal((await h.note('a')).detail.trim(), 'User typed this meanwhile');
});

integrationTest('map chat: F3 - the summary changed while the AI was replying: that action is skipped, the others still apply', async () => {
  const h = await harness(); await h.view.hydrate();
  const baseline = topicBaseline(h);
  await h.repo.updateNote(h.node('a').path, { summary: 'User wrote this summary' }); await h.view.hydrate();
  const lines = await apply(h, [
    { kind: 'update_summary', nodeId: h.ids.a, summary: 'AI summary' },
    { kind: 'rename_topic', nodeId: h.ids.b, title: 'Mind work' }
  ], {}, undefined, baseline);
  eq(lines.map(l => l.status), ['skipped', 'done']); assert.match(lines[0].text, /changed after you sent/);
  assert.equal((await h.note('a')).summary, 'User wrote this summary'); assert.equal((await h.note('b')).title, 'Mind work');
});

integrationTest('map chat: F3 - a changed title or parent makes rename, move and delete stale; an outline-only card is judged by title and parent only', async () => {
  const h = await harness(); await h.view.hydrate();
  const baseline = topicBaseline(h, { full: false });
  await h.repo.updateNote(h.node('a').path, { summary: 'Edited summary' }); await h.view.hydrate();
  const ok = await apply(h, [{ kind: 'rename_topic', nodeId: h.ids.a, title: 'Body clock' }], {}, undefined, baseline);
  eq(ok.map(l => l.status), ['done'], 'the summary was never shown in full, so it is not compared');
  const base2 = topicBaseline(h);
  await h.repo.updateNote(h.node('b').path, { title: 'Mind renamed by user' }); await h.view.hydrate();
  await h.plugin.mutate(() => h.view.mapChange(map => { map.nodes.find(n => n.id === h.ids.c).parentId = h.ids.b; })); await h.view.hydrate();
  const lines = await apply(h, [
    { kind: 'rename_topic', nodeId: h.ids.b, title: 'X' },
    { kind: 'move_topic', nodeId: h.ids.c, newParentId: h.ids.root },
    { kind: 'delete_topic', nodeId: h.ids.c, branch: false }
  ], {}, undefined, base2);
  eq(lines.map(l => l.status), ['skipped', 'skipped', 'skipped'], JSON.stringify(lines));
  assert.equal(h.node('c').parentId, h.ids.b);
});

integrationTest('map chat: F3 - two actions on the same card in one reply are not mistaken for a user edit', async () => {
  const h = await harness(); await h.view.hydrate();
  const lines = await apply(h, [{ kind: 'rename_topic', nodeId: h.ids.a, title: 'Body clock' }, { kind: 'update_summary', nodeId: h.ids.a, summary: 'Rhythm' }, { kind: 'edit_topic_note', nodeId: h.ids.a, detail: 'Fresh body' }]);
  eq(lines.map(l => l.status), ['done', 'done', 'done'], JSON.stringify(lines));
});

integrationTest('map chat: F4 - a chat-started expand asks the confirmation of the card\'s own model first; when it is declined no AI call is made', async () => {
  const h = await harness(); await h.view.hydrate();
  const readNote = h.repo.readNote.bind(h.repo); h.repo.readNote = async (...args) => ({ ...(await readNote(...args)), model: 'claude:opus' }); // a card with its own model
  const models = []; let proposed = 0;
  h.plugin.confirmAiUsage = async (model, run) => { models.push(model); h.control.calls.push('confirm'); if (h.control.decline) return false; await run(); return true; };
  h.view.proposeChildren = async () => { proposed++; };
  const act = [{ kind: 'run_map_action', action: 'expand', nodeIds: [h.ids.a], title: '', goal: '', direction: '' }];
  h.control.decline = true;
  const declined = await apply(h, act); eq(declined.map(l => l.status), ['done']);
  for (let i = 0; i < 10; i++) await tick();
  eq(models, ['claude:opus'], 'asked once, for the card\'s own model, not the chat model'); assert.equal(proposed, 0, 'declined: askModel path never starts');
  h.control.decline = false;
  await apply(h, act); await withTimeout(until(() => proposed === 1));
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
  eq(turn.at(-1).lines.map(l => l.status), ['done', 'done', 'done'], JSON.stringify(turn.at(-1).lines)); assert.equal(turn.at(-1).lines.at(-1).text, NOT_UNDOABLE);
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

// C2: a sync with the chat field focused used to refresh every card and redraw every edge once per card (N x layout(N)).
async function syncFixture() {
  const h = await harness(); const chat = h.open(); const view = h.view;
  const calls = { drawEdges: 0, refreshCard: 0 }; let renders = 0;
  const realRefresh = view.refreshCard.bind(view);
  view.drawEdges = () => { calls.drawEdges++; };
  view.refreshCard = (...args) => { calls.refreshCard++; return realRefresh(...args); };
  const baseRender = view.render; view.render = () => { renders++; baseRender(); };
  const cards = new Map();
  view.stageEl = { querySelector: selector => { const id = /data-node-id="(.+)"\]/.exec(selector)[1]; if (!cards.has(id)) { cards.set(id, { dataset: {}, querySelector: () => null, createSpan: () => ({ id: '', textContent: '' }), setAttr() {} }); } return cards.get(id); } };
  const changeNote = async () => { await h.repo.updateNote(view.map.nodes[0].path, { summary: 'Changed ' + Math.random() }); };
  const sync = async () => { calls.drawEdges = 0; calls.refreshCard = 0; renders = 0; await view.synchronize(); return { ...calls, renders }; };
  return { h, chat, view, changeNote, sync };
}
integrationTest('map chat C2: a sync while the chat field has focus repaints normally (no per-card refresh, no per-card edge redraw)', async () => {
  const { chat, changeNote, sync } = await syncFixture();
  chat.inputEl.focus(); await changeNote();
  const r = await sync();
  assert.equal(r.renders, 1, 'chat focus is not editing: the map renders'); assert.equal(r.refreshCard, 0); assert.ok(r.drawEdges <= 1);
});
integrationTest('map chat C2: during IME composition in the chat field the sync still takes the editing branch (no render), edges drawn once', async () => {
  const { h, chat, changeNote, sync } = await syncFixture();
  chat.inputEl.focus(); chat.inputEl.fire('compositionstart'); await changeNote();
  const r = await sync();
  assert.equal(r.renders, 0); assert.equal(r.refreshCard, h.view.map.nodes.length); assert.equal(r.drawEdges, 1, 'one edge redraw for the whole batch, not one per card');
});
integrationTest('map chat C2: another text field with focus (card title, goal input) still takes the editing branch', async () => {
  const { h, view, changeNote, sync } = await syncFixture();
  const other = h.rootEl.createDiv(); other.matches = selector => /input/.test(selector); h.page.doc.activeElement = other; await changeNote();
  const r = await sync();
  assert.equal(r.renders, 0, 'not interrupted by a render'); assert.equal(r.refreshCard, view.map.nodes.length); assert.equal(r.drawEdges, 1);
});
integrationTest('map chat C2: a single refreshCard outside a batch still redraws the edges itself', async () => {
  const { view } = await syncFixture();
  let drawn = 0; view.drawEdges = () => { drawn++; };
  view.refreshCard(view.map.nodes[0]); assert.equal(drawn, 1);
  view.refreshCard(view.map.nodes[0], false); assert.equal(drawn, 1, 'a batched refresh leaves the redraw to its caller');
});
integrationTest('map chat C3: the batched sync (editing branch) leaves the same edges as refreshing every card one by one, with the real drawEdges', async () => {
  const { h, chat, view, changeNote } = await syncFixture();
  const realDraw = Object.getPrototypeOf(view).drawEdges; let draws = 0;
  view.drawEdges = function () { draws++; return realDraw.call(this); };
  // Fake layout: every card gets its own box, so each edge has distinct coordinates.
  view.cardEls = new Map(view.map.nodes.map((n, i) => [n.id, { offsetLeft: 100 * i, offsetTop: 40 * i + 7, offsetWidth: 90, offsetHeight: 30 }]));
  const makeEdges = () => { const edges = { kids: [], replaceChildren() { this.kids = []; }, appendChild(p) { this.kids.push(p); } }; view.edgesEl = edges; view.edgeEls = new Map(); return edges; };
  const snapshot = edges => edges.kids.map(p => JSON.stringify({ attrs: p.attrs, classes: p.classes }));
  // Old behaviour: each card refresh redraws all edges.
  // A refreshed card changes height (its content grew), so an edge drawn before the cards are refreshed has the wrong end points.
  const resetBoxes = () => { for (const [id, box] of view.cardEls) { box.offsetHeight = 30; box.grew = false; } };
  const innerRefresh = view.refreshCard; view.refreshCard = function (node, ...rest) { const box = view.cardEls.get(node.id); if (box && !box.grew) { box.grew = true; box.offsetHeight += 11 * (1 + view.map.nodes.indexOf(node)); } return innerRefresh.call(this, node, ...rest); };
  resetBoxes();
  const oldEdges = makeEdges(); for (const node of view.map.nodes) view.refreshCard(node); const oldDraws = draws; const oldSnap = snapshot(oldEdges);
  // New behaviour: synchronize on the editing branch (IME composition in the chat field).
  resetBoxes(); const newEdges = makeEdges(); chat.inputEl.focus(); chat.inputEl.fire('compositionstart'); await changeNote(); draws = 0; await view.synchronize();
  assert.ok(oldSnap.length >= 3, 'the map has edges to compare'); assert.equal(newEdges.kids.length, oldSnap.length, 'same number of edges');
  assert.ok(JSON.parse(oldSnap[0]).attrs.d, 'the path data is real, not empty'); assert.deepEqual(snapshot(newEdges), oldSnap, 'every edge has the same path and classes');
  assert.equal(draws, 1); assert.equal(oldDraws, view.map.nodes.length);
});
async function scheduleFixture() {
  const { h, chat, view } = await syncFixture();
  let painted = 0; view.renderPreservingFocus = () => { painted++; };
  const run = name => { h.timers.length = 0; view[name](); const fire = h.timers.pop(); assert.ok(fire, 'a repaint was scheduled'); painted = 0; const left = h.timers.length; fire(); return { painted, rescheduled: h.timers.length > left || h.timers.length > 0 }; };
  return { h, chat, view, run, reset: () => { view.aimProgressRenderTimer = null; view.researchRenderTimer = null; } };
}
for (const name of ['scheduleResearchRender', 'scheduleAimProgressRender'])
  integrationTest(`map chat C3: ${name} paints while the chat field has focus, waits for IME composition and for other text fields`, async () => {
    const { h, chat, view, run, reset } = await scheduleFixture();
    chat.inputEl.matches = selector => /textarea/.test(selector); // the real field is a textarea: the old "any text field" rule would defer
    chat.inputEl.focus(); let r = run(name); assert.equal(r.painted, 1, 'chat focus (not composing): repaint runs'); reset();
    chat.inputEl.fire('compositionstart'); r = run(name); assert.equal(r.painted, 0, 'composing: deferred'); assert.ok(r.rescheduled); reset();
    chat.inputEl.fire('compositionend'); r = run(name); assert.equal(r.painted, 1); reset();
    const other = h.rootEl.createDiv(); other.matches = selector => /input/.test(selector); h.page.doc.activeElement = other;
    r = run(name); assert.equal(r.painted, 0, 'card title / goal input: deferred'); assert.ok(r.rescheduled); reset();
    h.page.doc.activeElement = null; r = run(name); assert.equal(r.painted, 1);
  });
integrationTest('map chat C4: repainting with the chat field focused keeps focus in the field even when the number of controls changes', async () => {
  const h = await harness({ document: true }); const chat = h.open(); const view = h.view;
  const other = h.rootEl.createEl('button'); const stop = h.rootEl.createEl('button');
  let list = [other, chat.inputEl];
  h.rootEl.querySelectorAll = () => list;
  const baseRender = view.render; let renders = 0;
  view.render = () => { renders++; baseRender(); list = [stop, other, chat.inputEl]; /* the repaint adds a stop-research button in front */ };
  chat.inputEl.value = 'half-typed'; chat.inputEl.selectionStart = 2; chat.inputEl.selectionEnd = 5; chat.inputEl.focus();
  view.renderPreservingFocus();
  assert.equal(renders, 1);
  assert.ok(h.page.doc.activeElement === chat.inputEl, 'focus is still in the chat field, not on another control'); assert.equal(chat.inputEl.selectionStart, 2); assert.equal(chat.inputEl.selectionEnd, 5);
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

integrationTest('map chat R2 N1: Detail edited in the file during the reply, view cache not refreshed -> edit_topic_note skips (PROBE R2)', async () => {
  const h = await harness(); await h.view.hydrate();
  await h.repo.updateNote(h.node('a').path, { detail: 'Original body' }); await h.view.hydrate();
  const baseline = topicBaseline(h);
  await h.repo.updateNote(h.node('a').path, { detail: 'User typed this meanwhile' }); // no hydrate: the modify event's refresh is still pending
  const lines = await apply(h, [{ kind: 'edit_topic_note', nodeId: h.ids.a, detail: 'AI text' }], {}, undefined, baseline);
  assert.equal(lines[0].status, 'skipped', JSON.stringify(plain(lines)));
  assert.equal((await h.note('a')).detail.trim(), 'User typed this meanwhile');
});
integrationTest('map chat R2 N1: summary edited in the file, cache not refreshed -> update_summary skips (PROBE R2)', async () => {
  const h = await harness(); await h.view.hydrate();
  const baseline = topicBaseline(h);
  await h.repo.updateNote(h.node('a').path, { summary: 'User wrote this' });
  const lines = await apply(h, [{ kind: 'update_summary', nodeId: h.ids.a, summary: 'AI summary' }], {}, undefined, baseline);
  assert.equal(lines[0].status, 'skipped', JSON.stringify(plain(lines)));
  assert.equal((await h.note('a')).summary, 'User wrote this');
});

integrationTest('map chat R2 N2: an edit that adds an identity key says so, not "new file"', async () => {
  const h = await harness(); await h.view.hydrate();
  const lines = await apply(h, [{ kind: 'edit_md_file', path: 'Notes/Other.md', find: 'Other note', replace: '---\nagent-map-node: x\n---\nOther note' }], h.hashes('Notes/Other.md'));
  assert.equal(lines[0].status, 'skipped', JSON.stringify(plain(lines)));
  assert.match(lines[0].text, /would add the topic fields reserved by this plugin to a regular note/);
  assert.doesNotMatch(lines[0].text, /new file/);
  assert.equal(h.contents.get('Notes/Other.md'), 'Other note about naps.\n');
});

test('map chat R2 N3: Detail past the budget is sent without detail or detailHash', () => {
  const ref = (id, detail) => ({ id, title: id, summary: '', detail, path: `${id}.md` });
  const outline = ['a', 'b', 'c'].map(id => ({ id, title: id, summary: '', parentId: null, depth: 0 }));
  const ctx = buildMapChatContext({ mapTitle: 'm', outline, selected: [ref('a', 'x'.repeat(60)), ref('b', 'y'.repeat(60))], references: [ref('c', 'z'.repeat(10))], snippets: [], files: [], history: [], detailBudget: 100 });
  const sent = JSON.parse(ctx.json);
  assert.equal(sent.selected[0].detail.length, 60); assert.ok(ctx.topicHashes.a.detailHash);
  assert.equal(sent.selected[1].detail, undefined); assert.equal(ctx.topicHashes.b.detailHash, undefined); assert.equal(sent.selected[1].detailOmitted, true);
  assert.equal(sent.references[0].detail.length, 10, 'a later, smaller card still fits'); assert.ok(ctx.topicHashes.c.detailHash);
  assert.equal(load('core/map-chat-context.ts').MAP_CHAT_DETAIL_BUDGET, 60000);
});
integrationTest('map chat R2 N3: edit_topic_note on a card whose Detail was over budget is skipped as not seen', async () => {
  const h = await harness(); await h.view.hydrate();
  const baseline = topicBaseline(h); delete baseline[h.ids.a].detailHash;
  const lines = await apply(h, [{ kind: 'edit_topic_note', nodeId: h.ids.a, detail: 'AI' }], {}, undefined, baseline);
  assert.equal(lines[0].status, 'skipped', JSON.stringify(plain(lines)));
});

// ---- Packet C1: answer length, "say it in more detail", answer-length switch, chat model ----------------------------------------

const { normalizeMapChatStyle, normalizeMapChatModel } = load('repository.ts', { obsidian });
const styleBtn = (f, label) => byLabel(f.panel.el, label);

test('map chat C1: settings default to concise and follow-default model; an invalid saved style or model is sanitised', () => {
  assert.equal(DEFAULT_SETTINGS.mapChatStyle, 'concise'); assert.equal(DEFAULT_SETTINGS.mapChatModel, '');
  for (const bad of [undefined, null, 'long', 'DETAILED', 7, {}, '']) assert.equal(normalizeMapChatStyle(bad), 'concise', String(bad));
  assert.equal(normalizeMapChatStyle('detailed'), 'detailed'); assert.equal(normalizeMapChatStyle('concise'), 'concise');
  for (const bad of [undefined, null, 7, {}, [], '   ']) assert.equal(normalizeMapChatModel(bad), '', String(bad));
  assert.equal(normalizeMapChatModel(' claude:haiku '), 'claude:haiku');
});

test('map chat C1: the answer-length switch is a labelled group of toggle buttons that follows the remembered style', () => {
  const f = panelFixture(); f.panel.setOpen(true);
  const group = find(f.panel.el, i => i.attrs?.role === 'group' && i.attrs['aria-label'] === 'Answer length');
  assert.ok(group, 'the group has an aria-label');
  const concise = find(group, i => i.text === 'Concise'), detailed = find(group, i => i.text === 'Detailed');
  assert.equal(concise.attrs['aria-pressed'], 'true'); assert.equal(detailed.attrs['aria-pressed'], 'false');
  detailed.click();
  eq(f.prefs.saved, [['style', 'detailed']], 'the choice is handed to the view to remember');
  assert.equal(detailed.attrs['aria-pressed'], 'true'); assert.equal(concise.attrs['aria-pressed'], 'false');
});

test('map chat C1: the answer-length choice survives a repaint and a brand new panel (reopened view) built from the same settings', () => {
  const f = panelFixture(); f.panel.setOpen(true);
  const option = (panel, text) => find(panel.el, i => i.tag === 'button' && i.text === text);
  option(f.panel, 'Detailed').click();
  f.panel.detach(); f.panel.mount(f.overlay);
  assert.equal(option(f.panel, 'Detailed').attrs['aria-pressed'], 'true', 'after a repaint');
  const again = panelFixture(); again.prefs.style = 'detailed'; again.panel.detach(); again.panel.mount(again.overlay);
  assert.equal(option(again.panel, 'Detailed').attrs['aria-pressed'], 'true', 'read back from the settings on mount');
  assert.equal(option(again.panel, 'Concise').attrs['aria-pressed'], 'false');
});

test('map chat C1: the model list starts with the follow-default entry, shows the remembered pick, and a change is handed to the view', () => {
  const f = panelFixture(); f.prefs.model = 'claude:haiku'; f.panel.detach(); f.panel.mount(f.overlay);
  const select = f.panel.modelEl;
  assert.equal(select.attrs['aria-label'], 'Model for this chat');
  eq(select.children.map(o => o.text), ['Follow default (now: X)', 'Haiku', 'GPT 6']); assert.equal(select.children[0].optionValue, '');
  assert.equal(select.value, 'claude:haiku', 'the remembered model is selected');
  select.value = ''; select.change();
  eq(f.prefs.saved, [['model', '']], 'following the default is saved as an empty string');
  select.value = 'gpt-6'; select.change();
  assert.equal(f.prefs.model, 'gpt-6');
  f.panel.detach(); f.panel.mount(f.overlay); assert.equal(f.panel.modelEl.value, 'gpt-6', 'kept across a repaint');
});

const moreButtons = f => findAll(f.panel.logEl, i => i.tag === 'button' && hasClass(i, 'vam-map-chat-more'));
test('map chat C1: every finished answer has a "Say it in more detail" button; streaming and failed answers do not', () => {
  const f = panelFixture(); f.panel.setOpen(true);
  const origin = { text: 'why', chips: [], selectedIds: ['a'] };
  f.panel.begin('why', origin); assert.equal(moreButtons(f).length, 0, 'not while the answer streams');
  f.panel.finish('Because.', []); assert.equal(moreButtons(f).length, 1); assert.equal(moreButtons(f)[0].text, 'Say it in more detail');
  f.panel.begin('again', origin); f.panel.fail('It broke'); assert.equal(moreButtons(f).length, 1, 'a failed answer has none');
  f.panel.begin('third', origin); f.panel.finish('Third.', []); assert.equal(moreButtons(f).length, 2, 'one per finished answer');
});

test('map chat C1: the more-detail button hands the original question and references to the view, and is disabled while a reply is running', () => {
  const f = panelFixture(); f.panel.setOpen(true);
  const origin = { text: 'why', chips: [{ kind: 'topic', id: 'a' }], selectedIds: ['b'] };
  f.panel.begin('why', origin); f.panel.finish('Because.', []);
  assert.equal(moreButtons(f)[0].disabled, false);
  moreButtons(f)[0].click(); eq(f.calls.more, [origin]);
  f.panel.begin('again', origin);
  assert.equal(moreButtons(f).length, 1);
  assert.equal(moreButtons(f).every(b => b.disabled), true, 'disabled the moment a reply starts');
  moreButtons(f)[0].fire('click'); assert.equal(f.calls.more.length, 1, 'a click while busy sends nothing');
  f.panel.finish('Again.', []); assert.equal(moreButtons(f).every(b => !b.disabled), true, 'enabled again when the reply is done');
});

integrationTest('map chat C1: a normal send is concise on the workspace model, and the usage notice is asked for that model', async () => {
  const h = await harness(); await h.view.hydrate(); h.open();
  h.type('hello'); await h.view.sendMapChat();
  const request = h.control.requests[0];
  assert.equal(request.style, 'concise'); assert.equal(request.model, 'claude:sonnet'); assert.equal(request.redo, undefined);
  eq(h.control.models, ['claude:sonnet']);
});

integrationTest('map chat C1: a chat model of claude:haiku is what is sent and what the usage notice is asked about; empty follows cliModel', async () => {
  const h = await harness(); await h.view.hydrate(); h.open();
  h.plugin.settings.mapChatModel = 'claude:haiku';
  h.type('hello'); await h.view.sendMapChat();
  assert.equal(h.control.requests[0].model, 'claude:haiku'); eq(h.control.models, ['claude:haiku']);
  h.plugin.settings.mapChatModel = '';
  h.type('again'); await h.view.sendMapChat();
  assert.equal(h.control.requests[1].model, 'claude:sonnet'); eq(h.control.models, ['claude:haiku', 'claude:sonnet']);
  assert.equal(h.view.chatModelChoices()[0].label, 'Follow default (now: label(claude:sonnet))');
});

integrationTest('map chat C1: choosing detailed in the switch is remembered, saved, and sent on the next message; the model pick is saved too', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  const option = text => find(chat.el, i => i.tag === 'button' && i.text === text);
  option('Detailed').click();
  assert.equal(h.plugin.settings.mapChatStyle, 'detailed'); assert.equal(h.control.saves, 1);
  h.type('explain'); await h.view.sendMapChat();
  assert.equal(h.control.requests[0].style, 'detailed');
  h.repaint(); assert.equal(option('Detailed').attrs['aria-pressed'], 'true', 'kept after render()');
  chat.modelEl.value = 'claude:haiku'; chat.modelEl.change();
  assert.equal(h.plugin.settings.mapChatModel, 'claude:haiku'); assert.equal(h.control.saves, 2);
});

integrationTest('map chat C1: the chat model list is the settings list plus follow-default, and a saved model that is gone stays selectable', async () => {
  const h = await harness(); await h.view.hydrate(); h.open();
  eq(h.view.chatModelChoices().map(c => c.value), ['', 'gpt-6-luna', 'claude:sonnet', 'claude:haiku']);
  h.plugin.settings.mapChatModel = 'claude:gone';
  eq(h.view.chatModelChoices().at(-1), { value: 'claude:gone', label: 'label(claude:gone) (Current model is unavailable)' });
});

integrationTest('map chat C1: "Say it in more detail" re-sends the same message and references as detailed, with the earlier turn as history, and adds a new answer', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  chat.addTopicReference(h.ids.c); h.view.selected = h.ids.a;
  h.control.reply = async request => ({ reply: request.style === 'detailed' ? 'Long answer.' : 'Short.', actions: [], rejected: [] });
  h.type('what is REM'); await h.view.sendMapChat();
  chat.removeChip(chat.attachments()[0]); h.view.selected = h.ids.b; h.type('half-typed draft');
  assert.equal(moreButtons({ panel: chat }).length, 1);
  moreButtons({ panel: chat })[0].click(); await until(() => h.control.requests.length === 2 && !chat.isBusy);
  const [first, second] = h.control.requests;
  assert.equal(second.style, 'detailed'); assert.equal(second.redo, true); assert.equal(second.message, first.message);
  const ctx = request => JSON.parse(request.context.json);
  eq(ctx(second).selected.map(s => s.id), ctx(first).selected.map(s => s.id), 'the same selection, not the current one');
  eq(ctx(second).references.map(s => s.id), ctx(first).references.map(s => s.id), 'the same references, though the chip was removed since');
  assert.equal(ctx(first).references.length, 1);
  eq(ctx(second).earlierTurns, [{ role: 'user', text: 'what is REM' }, { role: 'assistant', text: 'Short.' }], 'the first turn is the history');
  eq(h.control.calls, ['confirm', 'chat', 'confirm', 'chat'], 'the usage notice is asked again before the second send');
  const log = chat.transcript(); assert.equal(log.length, 4); assert.equal(log.at(-1).text, 'Long answer.'); assert.equal(log.at(-2).text, 'Say it in more detail.');
  assert.equal(chat.draft, 'half-typed draft', 'the draft in the field is left alone');
});

integrationTest('map chat C1: declining the usage notice on the more-detail re-send sends nothing', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  h.type('q'); await h.view.sendMapChat();
  h.control.decline = true;
  moreButtons({ panel: chat })[0].click(); await tick(); await tick();
  assert.equal(h.control.requests.length, 1); assert.equal(chat.transcript().length, 2);
});

integrationTest('map chat C1: during a reply a direct more-detail call does not start a second request', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  h.type('q'); await h.view.sendMapChat();
  const gate = deferred(); h.control.reply = async () => { await gate.promise; return { reply: 'r', actions: [], rejected: [] }; };
  const origin = chat.messages[0].origin;
  const sending = h.view.sendMapChat(origin); await until(() => chat.isBusy);
  assert.equal(moreButtons({ panel: chat }).every(b => b.disabled), true);
  await h.view.sendMapChat(origin); assert.equal(h.control.requests.length, 2, 'only one request at a time');
  gate.resolve(); await sending;
});

// ---- Packet C1 review fixes ----------------------------------------------------------------------------------------------------

integrationTest('map chat C1 F1: a "more detail" re-send never applies actions, even when the model lists some', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  h.type('what is REM'); await h.view.sendMapChat();
  const nodes = h.view.map.nodes.length; const researches = []; const realApply = h.view.applyMapChatActions.bind(h.view); h.view.applyMapChatActions = (...args) => { researches.push('apply'); return realApply(...args); };
  h.control.reply = async () => ({ reply: 'Long answer.', actions: [{ kind: 'add_child', parentId: h.ids.a, title: 'Sneaky', summary: '' }, { kind: 'run_map_action', action: 'expand', nodeIds: [], title: '', goal: '', direction: '' }], rejected: [] });
  h.control.mutates = 0;
  moreButtons({ panel: chat })[0].click(); await until(() => h.control.requests.length === 2 && !chat.isBusy);
  assert.equal(h.control.mutates, 0, 'nothing was written'); assert.equal((await h.saved()).length, nodes, 'no card was added');
  assert.equal(h.view.map.nodes.length, nodes); eq(researches, []);
  const last = chat.transcript().at(-1);
  assert.equal(last.text, 'Long answer.'); eq(last.lines.map(l => l.text), ['Actions are not applied again in a more-detail answer.']);
  assert.equal(h.contents.has('Agent Workspace/Topics/map-a/Sneaky.md'), false);
});

test('map chat C1 F1: the redo prompt tells the model that actions must be an empty list', () => {
  const { mapChatStep } = load('core/steps/map-chat/step.ts');
  const context = buildMapChatContext({ mapTitle: 'm', outline: [], selected: [], references: [], snippets: [], files: [], history: [] });
  const base = { message: 'q', context, model: 'm', reasoning: 'low', style: 'detailed', redo: true };
  assert.match(mapChatStep.render({ ...base, language: 'en' }), /"actions" must be an empty list/);
  assert.match(mapChatStep.render({ ...base, language: 'zh-TW' }), /"actions" 必須是空清單/);
});

test('map chat C1 F2: the panel listens for model changes while built, repaints its model list on a change, and stops on dispose', () => {
  const f = panelFixture(); f.panel.setOpen(true);
  assert.equal(f.prefs.watchers.length, 1);
  let choices = [{ value: '', label: 'Follow default (now: X)' }];
  const host = f.panel.host; host.modelChoices = () => choices;
  f.panel.refreshControls(); eq(f.panel.modelEl.children.map(o => o.text), ['Follow default (now: X)']);
  choices = [{ value: '', label: 'Follow default (now: Y)' }, { value: 'claude:haiku', label: 'Haiku' }];
  f.prefs.watchers[0]();
  eq(f.panel.modelEl.children.map(o => o.text), ['Follow default (now: Y)', 'Haiku'], 'the list and the follow-default label were refreshed');
  f.panel.dispose(); assert.equal(f.prefs.watchers.length, 0);
});

integrationTest('map chat C1 F2: model discovery going from idle to ready makes the Claude models appear; closing the view unsubscribes', async () => {
  const h = await harness(); h.control.claudeReady = false; await h.view.hydrate(); const chat = h.open();
  eq(chat.modelEl.children.map(o => o.optionValue), ['', 'gpt-6-luna']);
  assert.equal(h.control.listeners.length, 1); assert.ok(h.control.refreshes.includes('claude'), 'a refresh was started');
  h.control.claudeReady = true; for (const listener of [...h.control.listeners]) listener();
  eq(chat.modelEl.children.map(o => o.optionValue), ['', 'gpt-6-luna', 'claude:sonnet', 'claude:haiku']);
  h.plugin.settings.cliModel = 'gpt-6-luna'; chat.setOpen(false); chat.setOpen(true);
  assert.equal(chat.modelEl.children[0].text, 'Follow default (now: label(gpt-6-luna))', 'the label follows cliModel when the window is opened');
  await h.view.onClose(); assert.equal(h.control.listeners.length, 0);
});

test('map chat C1 F3: loading saved settings sanitises an invalid chat style and model, and keeps valid ones', () => {
  const { settingsFromSaved } = load('main.ts', { obsidian: { ...obsidian, MarkdownView } });
  const bad = settingsFromSaved({ mapChatStyle: 'long', mapChatModel: 7 });
  assert.equal(bad.mapChatStyle, 'concise'); assert.equal(bad.mapChatModel, '');
  const good = settingsFromSaved({ mapChatStyle: 'detailed', mapChatModel: ' claude:haiku ' });
  assert.equal(good.mapChatStyle, 'detailed'); assert.equal(good.mapChatModel, 'claude:haiku');
  const none = settingsFromSaved(null); assert.equal(none.mapChatStyle, 'concise'); assert.equal(none.mapChatModel, '');
});

// ---- Packet D1: only the note on screen is sent; the reply is laid out as Markdown --------------------------------

const noteLabel = chat => findAll(chat.chipsEl, i => hasClass(i, 'is-note')).flatMap(c => findAll(c, i => hasClass(i, 'vam-map-chat-chip-label'))).map(i => i.text);
const noteRemove = chat => findAll(chat.chipsEl, i => hasClass(i, 'vam-map-chat-note-remove'))[0];
const send = async (h, text = 'q') => { h.type(text); await h.view.sendMapChat(); return h.control.requests.at(-1); };
const sentActive = request => JSON.parse(request.context.json).activeFile ?? null;

integrationTest('map chat D1: a note open in a background tab is not sent and gets no chip', async () => {
  const h = await harness(); await h.view.hydrate();
  h.setLeaves(h.leaf('Notes/Other.md', { shown: false }));
  const chat = h.open();
  eq(noteLabel(chat), []); assert.equal(h.view.visibleMarkdownFile(), null);
  assert.equal(sentActive(await send(h)), null, 'a hidden tab is not context');
});

integrationTest('map chat D1: a note in another window is not sent and gets no chip', async () => {
  const h = await harness(); await h.view.hydrate();
  h.setLeaves(h.leaf('Notes/Other.md', { doc: { other: true } }));
  const chat = h.open();
  eq(noteLabel(chat), []); assert.equal(sentActive(await send(h)), null);
});

integrationTest('map chat D1: a note shown beside the map is sent, with a chip that names it and can be removed by name', async () => {
  const h = await harness(); await h.view.hydrate();
  h.setLeaves(h.leaf('Notes/Other.md'), h.leaf('Notes/Research.md', { shown: false }));
  const chat = h.open();
  eq(noteLabel(chat), ['Current note: Other']);
  assert.equal(noteRemove(chat).attrs['aria-label'], 'Remove reference: Current note: Other');
  assert.equal(sentActive(await send(h)).path, 'Notes/Other.md');
});

integrationTest('map chat D1: with several notes shown, the last one touched wins, then this map\'s own topic note, then the first', async () => {
  const h = await harness(); await h.view.hydrate();
  const topicPath = h.node('b').path;
  h.setLeaves(h.leaf('Notes/Other.md'), h.leaf(topicPath), h.leaf('Notes/Research.md'));
  assert.equal(h.view.visibleMarkdownFile().path, topicPath, 'topic note beats the first shown');
  h.view.lastMarkdownPath = 'Notes/Research.md';
  assert.equal(h.view.visibleMarkdownFile().path, 'Notes/Research.md', 'last touched, while still shown');
  h.setLeaves(h.leaf('Notes/Other.md'), h.leaf('Notes/Research.md', { shown: false }));
  assert.equal(h.view.visibleMarkdownFile().path, 'Notes/Other.md', 'last touched is hidden now: the first shown');
  h.setLeaves(h.leaf('Notes/Other.md'), h.leaf('Notes/Research.md'));
  h.view.lastMarkdownPath = null;
  assert.equal(h.view.visibleMarkdownFile().path, 'Notes/Other.md', 'no topic note, no history: the first shown');
});

integrationTest('map chat D1: removing the chip sends no active note, and an edit of that note has no baseline and is skipped', async () => {
  const h = await harness(); await h.view.hydrate();
  h.setLeaves(h.leaf('Notes/Other.md'));
  const chat = h.open();
  h.control.reply = async () => ({ reply: 'r', actions: [{ kind: 'edit_md_file', path: 'Notes/Other.md', find: 'naps', replace: 'sleep' }], rejected: [] });
  noteRemove(chat).click();
  eq(noteLabel(chat), []);
  const request = await send(h);
  assert.equal(sentActive(request), null);
  const lines = chat.transcript().at(-1).lines;
  eq(lines.map(l => l.status).slice(0, 1), ['skipped'], JSON.stringify(lines));
  assert.equal(h.contents.get('Notes/Other.md'), 'Other note about naps.\n');
  // Control: with the chip on, the same edit goes through.
  const h2 = await harness(); await h2.view.hydrate();
  h2.setLeaves(h2.leaf('Notes/Other.md')); h2.open();
  h2.control.reply = async () => ({ reply: 'r', actions: [{ kind: 'edit_md_file', path: 'Notes/Other.md', find: 'naps', replace: 'sleep' }], rejected: [] });
  await send(h2);
  assert.match(h2.contents.get('Notes/Other.md'), /about sleep/);
});

integrationTest('map chat D1: the chip follows the shown note, a removal holds only for that note, and goes with a new conversation', async () => {
  const h = await harness(); await h.view.hydrate();
  h.setLeaves(h.leaf('Notes/Other.md'));
  const chat = h.open();
  noteRemove(chat).click(); eq(noteLabel(chat), []);
  h.view.lastMarkdownPath = null; chat.refreshNote(); eq(noteLabel(chat), [], 'still removed for the same note');
  h.setLeaves(h.leaf('Notes/Research.md')); h.view.lastMarkdownPath = 'Notes/Research.md'; chat.refreshNote();
  eq(noteLabel(chat), ['Current note: Research'], 'another note is shown: the chip is back, for that note');
  assert.equal(sentActive(await send(h)).path, 'Notes/Research.md');
});

test('map chat D1: the panel chip refreshes on mount, on refreshNote, and a removal is remembered per note', () => {
  const f = panelFixture(); f.panel.setOpen(true);
  eq(f.parts.chipTexts(), []);
  f.showNote('Notes/A.md'); eq(f.parts.chipTexts(), ['Current note: A']); assert.equal(f.panel.currentNote(), 'Notes/A.md');
  findAll(f.panel.chipsEl, i => hasClass(i, 'vam-map-chat-note-remove'))[0].click();
  assert.equal(f.panel.currentNote(), null); eq(f.parts.chipTexts(), []);
  f.showNote('Notes/B.md'); assert.equal(f.panel.currentNote(), 'Notes/B.md');
  f.showNote(null); assert.equal(f.panel.currentNote(), null);
  f.showNote('Notes/A.md'); assert.equal(f.panel.currentNote(), 'Notes/A.md', 'a removal of A does not outlive A: after B, A is back');
  findAll(f.panel.chipsEl, i => hasClass(i, 'vam-map-chat-note-remove'))[0].click(); assert.equal(f.panel.currentNote(), null);
  f.panel.reset(); f.showNote('Notes/A.md'); assert.equal(f.panel.currentNote(), 'Notes/A.md', 'a new conversation starts with nothing removed');
});

test('map chat D1: dropped chips keep their remove behaviour with a note chip present', () => {
  const f = panelFixture(); f.panel.setOpen(true); f.showNote('Notes/A.md');
  for (const id of ['a', 'b']) f.panel.addTopicReference(id);
  const removes = () => findAll(f.panel.chipsEl, i => hasClass(i, 'vam-map-chat-chip-remove'));
  assert.equal(removes().length, 2); removes()[0].click();
  assert.equal(f.page.doc.activeElement, removes()[0]); assert.equal(f.panel.currentNote(), 'Notes/A.md');
});

test('map chat D4: replies are laid out by the safe renderer as they stream; the question, errors and result lines stay plain text', () => {
  const f = panelFixture(); f.panel.setOpen(true);
  f.panel.begin('**not bold**');
  f.panel.streamReply('Hi **bo'); f.panel.streamReply('Hi **bold** and <script>x</script> <img src=x onerror=y>');
  const streaming = replyBody(f);
  assert.equal(visibleText(streaming), 'Hi bold and <script>x</script> <img src=x onerror=y>', 'the newest streamed text is shown, HTML as text');
  eq(findAll(streaming, i => i.tag === 'strong').map(visibleText), ['bold']); assert.equal(findAll(streaming, i => ['script', 'img'].includes(i.tag)).length, 0);
  f.panel.finish('Done **bold** [[Note]]', [{ status: 'done', text: '**line**' }]);
  const done = replyBody(f);
  assert.equal(visibleText(done), 'Done bold Note', 'the last layout is the complete answer, with nothing left of earlier ones');
  eq(findAll(done, i => i.tag === 'a').map(i => i.attrs['data-href']), ['Note']);
  assert.equal(findAll(f.parts.log(), i => hasClass(i, 'vam-map-chat-line'))[0].text, '**line**');
  f.panel.begin('two'); f.panel.fail('Broke **hard**');
  const failed = findAll(f.parts.log(), i => hasClass(i, 'is-assistant')).at(-1).children.find(c => hasClass(c, 'vam-map-chat-text'));
  assert.equal(failed.text, 'Broke **hard**'); assert.equal(failed.children.length, 0, 'an error text is not laid out');
  const user = findAll(f.parts.log(), i => hasClass(i, 'is-user'))[0];
  assert.equal(user.children.find(c => hasClass(c, 'vam-map-chat-text')).text, '**not bold**');
});

test('map chat D4: layout is synchronous, so an older streamed text can never land after a newer one (replaces D3 F1)', () => {
  const f = panelFixture(); f.panel.setOpen(true);
  f.panel.begin('q'); f.panel.streamReply('a'); f.panel.streamReply('b');
  assert.equal(visibleText(replyBody(f)), 'b'); assert.equal(replyBody(f).children.length, 1, 'one paragraph, not one per streamed text');
  f.panel.finish('final', []);
  assert.equal(visibleText(replyBody(f)), 'final'); assert.equal(replyBody(f).children.length, 1);
});
test('map chat D1: model output is never put into the page with innerHTML, and no private API is used', () => {
  const dir = path.join(root, 'experiences/visual-map');
  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.ts'))) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(text, /dragManager|\.internal\b/, file);
    if (file === 'map-chat.ts') assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|MarkdownRenderer/, file);
  }
  const coreDir = path.join(root, 'core');
  for (const file of fs.readdirSync(coreDir).filter(name => /^map-chat-.*\.ts$/.test(name)))
    assert.doesNotMatch(fs.readFileSync(path.join(coreDir, file), 'utf8'), /innerHTML|outerHTML|insertAdjacentHTML|MarkdownRenderer|dragManager|createEl\(\s*["'`](img|iframe|embed)/, file);
});

test('map chat D1: the view refreshes the note chip when the active leaf changes', () => {
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  const at = source.indexOf('workspace.on("active-leaf-change"');
  assert.ok(at > 0);
  assert.match(source.slice(at, at + 400), /this\.chat\?\.refreshNote\(\)/);
});

// ---- dragging in selection mode and repaints during a drag ----------------------------------------------------------

integrationTest('map chat: in selection mode a card dragged onto the panel adds a topic chip, writes nothing and keeps the selection', async () => {
  const d = await dragHarness();
  d.view.integrationMode = true; d.view.multiSelected = new Set([d.ids.b, d.ids.c]);
  d.down(); d.move(100, 400);
  assert.ok(hasClass(d.chat.el, 'is-drop'), 'the panel lights up in selection mode too');
  d.up();
  eq(d.chat.attachments().filter(a => a.kind === 'topic'), [{ kind: 'topic', id: d.ids.a }]);
  assert.equal(d.changes.length, 0, 'no mapChange'); eq([...d.view.multiSelected], [d.ids.b, d.ids.c]); assert.equal(d.view.integrationMode, true);
  assert.ok(d.view.suppressClickUntil > Date.now(), 'the release is not read as a click that toggles the card');
  assert.equal(d.view.dragging, false);
});

integrationTest('map chat: in selection mode a drag onto the canvas moves nothing and does not toggle; a plain click is left to the click handler', async () => {
  const d = await dragHarness();
  d.view.integrationMode = true; d.view.multiSelected = new Set([d.ids.b]); d.view.selected = d.ids.b;
  d.down(); d.move(520, 150); d.move(560, 160); d.up();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(d.changes.length, 0, 'mapChange not called'); eq([d.card.style.left, d.card.style.top], [`${d.node('a').x}px`, `${d.node('a').y}px`]);
  eq([...d.view.multiSelected], [d.ids.b]); assert.equal(d.view.selected, d.ids.b); assert.equal(d.chat.attachments().filter(a => a.kind === 'topic').length, 0);
  assert.ok(d.view.suppressClickUntil > Date.now(), 'the click after a drag is suppressed');
  d.view.suppressClickUntil = 0;
  d.down(); d.up();
  eq([...d.view.multiSelected], [d.ids.b]); assert.equal(d.view.selected, d.ids.b, 'pointer handling leaves a plain click to the click handler');
  assert.equal(d.view.suppressClickUntil, 0, 'a plain click is not suppressed, so it still toggles');
});

// The real render() needs more DOM than the fake offers, so it is counted where it first touches the plugin (syncOutline) and stopped there.
const realRenderProbe = d => {
  const stop = new Error('render reached syncOutline'); const probe = { count: 0 };
  d.view.render = Object.getPrototypeOf(d.view).render;
  d.view.plugin.syncOutline = () => { probe.count++; throw stop; };
  probe.run = work => { try { work(); } catch (error) { if (error !== stop) throw error; } };
  return probe;
};

integrationTest('map chat: a repaint requested mid-drag waits for the drop and then happens exactly once', async () => {
  const d = await dragHarness(); const probe = realRenderProbe(d);
  d.down(); d.move(100, 400);
  probe.run(() => { d.view.render(); d.view.render(); });
  assert.equal(probe.count, 0, 'nothing was rebuilt while the card was held'); assert.equal(d.view.dragging, true);
  assert.ok(d.events.has('pointermove'), 'the card keeps its drag listeners'); assert.equal(d.view.renderAfterDrag, true);
  probe.run(() => d.up());
  assert.equal(probe.count, 1, 'exactly one repaint after the drop'); assert.equal(d.view.renderAfterDrag, false);
  eq(d.chat.attachments().filter(a => a.kind === 'topic'), [{ kind: 'topic', id: d.ids.a }]);
});

integrationTest('map chat: closing the view mid-drag with a pending repaint neither repaints nor throws', async () => {
  const d = await dragHarness(); const probe = realRenderProbe(d);
  d.down(); d.move(100, 400); d.view.render();
  assert.equal(d.view.renderAfterDrag, true);
  await d.view.onClose();
  assert.equal(d.view.renderAfterDrag, false); assert.equal(d.view.dragging, false);
  d.view.render();
  assert.equal(probe.count, 0, 'a closed view is never repainted');
});

// ---- Packet D3: review fixes F1-F5 ---------------------------------------------------------------------------------------------

test('map chat D3 F2: a [[link]] in a reply opens the note; a modifier click opens it in a new tab; external links and other clicks are left alone', () => {
  const f = panelFixture(); f.panel.setOpen(true);
  const anchor = (cls, href) => { const a = element('a', { cls }); a.attrs['data-href'] = href; a.attrs.href = href; a.getAttribute = name => a.attrs[name] ?? null; a.closest = selector => selector === 'a' ? a : null; return a; };
  const click = (target, extra = {}) => { let prevented = false; f.parts.log().fire('click', { target, preventDefault() { prevented = true; }, ...extra }); return prevented; };
  assert.equal(click(anchor('internal-link', 'Notes/Note')), true, 'the click is taken over');
  eq(f.calls.links, [['Notes/Note', false]]);
  assert.equal(click(anchor('internal-link', 'Other#Heading'), { ctrlKey: true }), true);
  eq(f.calls.links.at(-1), ['Other#Heading', true]);
  assert.equal(click(anchor('external-link', 'https://example.com')), false, 'external links keep the default behaviour');
  const plain = element('span'); plain.closest = () => null;
  assert.equal(click(plain), false); assert.equal(f.calls.links.length, 2);
});

integrationTest('map chat D3 F2: the view opens a clicked internal link from the map file, in a new tab only for a modifier click', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  chat.host.openLink('Notes/Note', false); chat.host.openLink('Notes/Other', true);
  eq(h.linkOpens, [['Notes/Note', MAP, false], ['Notes/Other', MAP, true]]);
});


// ---- Packet D4: the safe subset renderer (replaces MarkdownRenderer and the regex sanitiser) ------------------------------------

const { renderChatMarkdown } = load('core/map-chat-render.ts');
const lay = text => { const el = element('div'); renderChatMarkdown(el, text); return el; };
const nodes = el => findAll(el, () => true);
const FORBIDDEN_TAGS = ['img', 'iframe', 'embed', 'object', 'script', 'video', 'audio', 'svg', 'style', 'link', 'source', 'input'];
const anchors = el => nodes(el).filter(i => i.tag === 'a');
const externals = el => anchors(el).filter(i => hasClass(i, 'external-link')).map(i => i.attrs.href);
const wikis = el => anchors(el).filter(i => hasClass(i, 'internal-link')).map(i => i.attrs['data-href']);
const codeBlocks = el => nodes(el).filter(i => i.tag === 'pre').map(i => visibleText(i));
/** Whatever the reply says, the tree holds no element that loads or runs anything and no code-block language. */
function assertSafe(el, label) {
  for (const item of nodes(el)) {
    assert.ok(!FORBIDDEN_TAGS.includes(item.tag), `${label}: <${item.tag}> in the tree`);
    assert.ok(!('src' in item.attrs) && !('srcset' in item.attrs) && !('onerror' in item.attrs), `${label}: ${JSON.stringify(item.attrs)}`);
    assert.doesNotMatch(`${item.cls} ${JSON.stringify(item.attrs)}`, /language|lang-|dataview|mermaid/i, `${label}: a code language reached the tree`);
    if (item.tag === 'a') {
      if (hasClass(item, 'external-link')) { assert.match(item.attrs.href, /^https?:\/\//i, label); assert.equal(item.attrs.target, '_blank', label); assert.equal(item.attrs.rel, 'noopener', label); }
      else assert.ok(hasClass(item, 'internal-link') && !('href' in item.attrs) && !/^[a-z][a-z0-9+.-]*:/i.test(item.attrs['data-href']), `${label}: unexpected anchor ${JSON.stringify(item.attrs)}`);
    }
  }
}

// Every reviewer bypass sample (scratchpad probe.cjs) plus the rest of the unsupported syntax: nothing loads, nothing runs, and
// the text the model wrote stays visible. `links` is the exact list of external addresses that may become clickable links.
const BYPASSES = {
  escapedBacktick: { text: '\\`![x](https://evil/a?q=secret)\\`', links: [], shows: '![x](https://evil/a?q=secret)' },
  escapedBacktickHtml: { text: '\\`<img src=https://evil/x>\\`', links: ['https://evil/x'], shows: '<img src=https://evil/x>' },
  headingThenLine: { text: '# Title `\n![x](https://evil/leak)`', links: [], shows: '![x](https://evil/leak)' },
  listItems: { text: '- a `\n- ![x](https://evil/leak) `', links: [], shows: '![x](https://evil/leak)' },
  nestedAlt: { text: '![a [b] c](https://evil/leak)', links: [], shows: '![a [b] c](https://evil/leak)' },
  escapedAlt: { text: '![a\\]b](https://evil/leak)', links: [], shows: '![a\\]b](https://evil/leak)' },
  entityScheme: { text: '![x](&#104;ttps://evil/leak)', links: [], shows: '![x](&#104;ttps://evil/leak)' },
  entityColon: { text: '![x](https&colon;//evil/leak)', links: [], shows: '![x](https&colon;//evil/leak)' },
  backslashScheme: { text: '![x](https\\://evil/leak)', links: [], shows: '![x](https\\://evil/leak)' },
  escapedUrl: { text: '![x](https:\\/\\/evil/leak)', links: [], shows: '![x](https:\\/\\/evil/leak)' },
  dataImg: { text: '![x](data:image/png;base64,AAAA)', links: [], shows: '![x](data:image/png;base64,AAAA)' },
  fileImg: { text: '![x](file:///etc/passwd)', links: [], shows: '![x](file:///etc/passwd)' },
  appImg: { text: '![x](app://local/Users/x/secret.png)', links: [], shows: '![x](app://local/Users/x/secret.png)' },
  mdEmbed: { text: '![x](Secret.md)', links: [], shows: '![x](Secret.md)' },
  remoteImg: { text: 'see ![chart](https://evil.test/p.png?x=1) now', links: [], shows: '![chart](https://evil.test/p.png?x=1)' },
  protocolRelative: { text: '![](//evil.test/p.png)', links: [], shows: '![](//evil.test/p.png)' },
  angleImg: { text: '![a](<https://evil.test/p.png>)', links: [], shows: '![a](<https://evil.test/p.png>)' },
  linkImg: { text: '[![x](https://evil/i.png)](https://y)', links: ['https://y'], shows: '![x](https://evil/i.png)' },
  indentedCode: { text: 'para\n\n    ![x](http://e/i) <b>', links: [], shows: '![x](http://e/i) <b>' },
  crlfImg: { text: '![x](https://evil/a)\r\n', links: [], shows: '![x](https://evil/a)' },
  refImage: { text: '![x][r]\n\n[r]: https://evil/a', links: ['https://evil/a'], shows: '![x][r]' },
  autolinkAngle: { text: '<https://example.com>', links: ['https://example.com'], shows: '<' },
  htmlTags: { text: '<iframe src="https://evil.test"></iframe> a <script>x</script>', links: ['https://evil.test'], shows: '<iframe src="https://evil.test"></iframe>' },
  embedWiki: { text: '![[Secret]]', links: [], shows: '![[Secret]]' },
  embedWikiAlias: { text: '![[pic.png|200]] ![[Note#Heading]]', links: [], shows: '![[pic.png|200]]' },
  escapedBrackets: { text: '\\[\\[Secret\\]\\] \\[x\\](https://evil/a)', links: ['https://evil/a'], shows: '[[Secret]] [x](https://evil/a)' },
  nestedLinkLabel: { text: '[a [b](https://evil/one)](https://evil/two)', links: ['https://evil/two'], shows: 'a [b](https://evil/one)' },
  mathAndTable: { text: '$$ x < y $$\n\n| a | b |\n|---|---|\n| <img src=x> | 1 |', links: [], shows: '| <img src=x> | 1 |' },
  wikiJavascript: { text: '[[javascript:alert(1)]]', links: [], shows: '[[javascript:alert(1)]]' },
  wikiHttps: { text: '[[https://evil]]', links: [], shows: '[[https://evil]]' },
  wikiJavascriptCase: { text: '[[JavaScript:x]]', links: [], shows: '[[JavaScript:x]]' },
  wikiSchemeAlias: { text: '[[javascript:x|Open]]', links: [], shows: '[[javascript:x|Open]]' },
  dataviewInline: { text: '`= this.file.name` and `$= dv.x()`', links: [], shows: '$= dv.x()' }
};
for (const [name, c] of Object.entries(BYPASSES)) {
  test(`map chat D4 bypass: ${name} shows the text and loads or runs nothing`, () => {
    const el = lay(c.text);
    assertSafe(el, name);
    eq(externals(el), c.links); eq(wikis(el), []);
    assert.ok(visibleText(el).includes(c.shows), `${name}: shows ${JSON.stringify(c.shows)} in ${JSON.stringify(visibleText(el))}`);
  });
}

// Fences: whatever the language says, the content is plain text in a pre and the language goes nowhere.
const FENCES = {
  plain: { text: '```dataviewjs\ndv.paragraph(app.vault.getFiles())\n```', code: ['dv.paragraph(app.vault.getFiles())'] },
  crlf: { text: '```dataviewjs\r\ndv.paragraph(1)\r\n```\r\n', code: ['dv.paragraph(1)'] },
  cr: { text: '```dataviewjs\rdv.paragraph(1)\r```', code: ['dv.paragraph(1)'] },
  tilde: { text: '~~~dataviewjs\n![x](https://e)\n~~~', code: ['![x](https://e)'] },
  mermaid: { text: '~~~mermaid title\ngraph TD\n~~~', code: ['graph TD'] },
  longer: { text: '````md\n```dataview\nTABLE\n```\n````', code: ['```dataview\nTABLE\n```'] },
  indentedFence: { text: '  ````js {1}\nx\n````\nafter', code: ['x'] },
  unclosed: { text: '```js\nno closing fence', code: ['no closing fence'] },
  quote: { text: '> ```dataviewjs\n> app.vault\n> ```', code: ['app.vault'], inside: 'blockquote' },
  quoteCrlf: { text: '> ```dataviewjs\r\n> app.vault\r\n> ```\r\n', code: ['app.vault'], inside: 'blockquote' },
  callout: { text: '> [!note]\n> ```dataviewjs\n> dv.x\n> ```', code: ['dv.x'], inside: 'blockquote', shows: '[!note]' },
  nestedQuote: { text: '> > ```dataviewjs\n> > dv.x\n> > ```', code: ['dv.x'], inside: 'blockquote' },
  afterHeading: { text: '# Title\n```dataviewjs\ndv.x\n```', code: ['dv.x'] },
  inParagraph: { text: 'before\n```dataviewjs\ndv.x\n```\nafter', code: ['dv.x'] }
};
for (const [name, c] of Object.entries(FENCES)) {
  test(`map chat D4 fence: ${name} becomes a plain pre/code with no language`, () => {
    const el = lay(c.text);
    assertSafe(el, name);
    eq(codeBlocks(el), c.code);
    if (c.inside) assert.ok(findAll(nodes(el).find(i => i.tag === c.inside), i => i.tag === 'pre').length > 0, 'the fence stays inside its quote');
    if (c.shows) assert.ok(visibleText(el).includes(c.shows));
  });
}
test('map chat D4 fence: a fence inside a list item runs nothing, whatever it holds', () => {
  for (const text of ['- ```dataviewjs\n  dv.x\n  ```', '- a\n  - b\n\n    ```dataviewjs\n    dv.x\n    ```', '1. ```dataviewjs\n   dv.x\n   ```']) {
    const el = lay(text); assertSafe(el, text); assert.ok(visibleText(el).includes('dv.x'));
  }
});
test('map chat D4: a code block keeps markup as text: nothing inside a fence or an inline code span is interpreted', () => {
  const fence = lay('```\n![x](https://evil.test/p.png)\n![[Note]]\n<b>x</b>\n**y**\n```');
  eq(codeBlocks(fence), ['![x](https://evil.test/p.png)\n![[Note]]\n<b>x</b>\n**y**']); eq(anchors(fence), []);
  const span = lay('use `<div>` and `![x](https://evil.test/p.png)` and ``![[Note]]`` and `**x**`');
  eq(nodes(span).filter(i => i.tag === 'code').map(i => i.text), ['<div>', '![x](https://evil.test/p.png)', '![[Note]]', '**x**']); eq(anchors(span), []);
  const stray = lay('stray ` then <b>\n\nnext `<c>`');
  assert.ok(visibleText(stray).includes('stray ` then <b>'));
  eq(nodes(stray).filter(i => i.tag === 'code').map(i => i.text), ['<c>'], 'an unmatched backtick shields nothing past its paragraph');
});

test('map chat D4 syntax: bold, italic, strike-through, inline code and nesting', () => {
  const el = lay('a **bold** _it_ *em* __b2__ ~~gone~~ `code` **bold _both_**');
  eq(nodes(el).filter(i => i.tag === 'strong').map(visibleText), ['bold', 'b2', 'bold both']);
  eq(nodes(el).filter(i => i.tag === 'em').map(visibleText), ['it', 'em', 'both']);
  eq(nodes(el).filter(i => i.tag === 'del').map(visibleText), ['gone']); eq(nodes(el).filter(i => i.tag === 'code').map(i => i.text), ['code']);
  assert.ok(visibleText(lay('snake_case_name and a * b')).includes('snake_case_name and a * b'), 'underscores inside words and spaced stars are text');
});

test('map chat D4 syntax: headings are all one small size, with a class and a real heading element', () => {
  const el = lay('# One\n## Two ##\n###### Six\n####### seven hashes\n#nospace');
  eq(nodes(el).filter(i => /^h[1-6]$/.test(i.tag)).map(i => [i.tag, visibleText(i)]), [['h1', 'One'], ['h2', 'Two'], ['h6', 'Six']]);
  assert.ok(nodes(el).filter(i => /^h[1-6]$/.test(i.tag)).every(i => hasClass(i, 'vam-map-chat-heading')));
  assert.ok(visibleText(el).includes('####### seven hashes') && visibleText(el).includes('#nospace'), 'not headings: stay as written');
});

test('map chat D4 syntax: unordered and ordered lists, nested at most two levels, and a quote and a rule', () => {
  const el = lay('- a\n- b\n  - b1\n    - b2\n- c\n\n1. one\n2) two\n\n> quoted **bold**\n> more\n\n---\n***\ntext');
  const lists = nodes(el).filter(i => i.tag === 'ul' || i.tag === 'ol');
  eq(lists.map(i => i.tag), ['ul', 'ul', 'ol']);
  const own = li => li.children.filter(c => c.tag !== 'ul' && c.tag !== 'ol').map(visibleText).join('');
  eq(findAll(lists[0], i => i.tag === 'li').map(own), ['a', 'b', 'b1', 'b2', 'c'], 'depth is capped, so b2 joins b1\'s list');
  assert.equal(findAll(lists[0], i => i.tag === 'ul').length, 2, 'two levels of ul at most');
  eq(findAll(lists[2], i => i.tag === 'li').map(visibleText), ['one', 'two']);
  const quote = nodes(el).find(i => i.tag === 'blockquote'); assert.equal(visibleText(quote), 'quoted boldmore'); assert.equal(findAll(quote, i => i.tag === 'strong').length, 1);
  assert.equal(nodes(el).filter(i => i.tag === 'hr').length, 2);
});

test('map chat D4 syntax: [[wiki links]] with and without an alias become internal links the click handler opens', () => {
  const el = lay('see [[Note]] and [[Folder/Other#Part|the part]] but not [[]] or [[a\nb]]');
  eq(anchors(el).map(i => [i.cls, i.attrs['data-href'], visibleText(i)]), [['internal-link', 'Note', 'Note'], ['internal-link', 'Folder/Other#Part', 'the part']]);
  assertSafe(el, 'wiki');
});

test('map chat D4 syntax: [text](url) accepts http and https only; every other scheme stays plain text', () => {
  const ok = lay('[site](https://example.com/a?b=1) and [plain](HTTP://example.com) and [t](https://example.com/x "title") and [paren](https://example.com/a_(b))');
  eq(externals(ok), ['https://example.com/a?b=1', 'HTTP://example.com', 'https://example.com/x', 'https://example.com/a_(b)']);
  eq(anchors(ok).map(i => [i.attrs.target, i.attrs.rel]).filter(x => x[0] !== '_blank' || x[1] !== 'noopener'), []);
  for (const url of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'app://local/x', 'obsidian://open?vault=v', 'vbscript:x', 'mailto:a@b.c', '//evil.test/x', 'ftp://example.com/x', '/relative', '#anchor', ' javascript:alert(1)']) {
    const el = lay(`[click](${url})`);
    eq(anchors(el), [], url); assert.ok(visibleText(el).includes(`[click](${url.trim()})`) || visibleText(el).includes(`[click](${url})`), `${url} stays visible as written`);
  }
  assertSafe(ok, 'links');
});

test('map chat D4 syntax: a bare http(s) address becomes a link, without the punctuation that follows it', () => {
  const el = lay('go to https://example.com/a. Also (http://example.com/b), https://example.com/c?x=1&y=2; and ftp://nope.test plus xhttps://no.test');
  eq(externals(el), ['https://example.com/a', 'http://example.com/b', 'https://example.com/c?x=1&y=2']);
  assert.ok(visibleText(el).includes('ftp://nope.test plus xhttps://no.test'));
});

test('map chat D4 Bug B: a link with no words shows its address, so it is never invisible', () => {
  for (const text of ['[](https://example.com/p)', '[ ](https://example.com/p)', '[  \n ](https://example.com/p)']) {
    const el = lay(text); const [a] = anchors(el);
    assert.equal(visibleText(a), 'https://example.com/p', JSON.stringify(text)); assert.equal(a.attrs.href, 'https://example.com/p');
  }
  assert.equal(nodes(lay('![](https://example.com/p.png)')).filter(i => i.tag === 'img').length, 0, 'an image is never created, whatever its alt text');
});

test('map chat D5 F1: a [[link]] has no href, can be reached with Tab and opened with Enter', () => {
  const el = lay('see [[Notes/Note#Part|the part]]'); const [a] = anchors(el);
  assert.ok(!('href' in a.attrs), 'no href to carry a scheme'); eq([a.attrs['data-href'], a.attrs.tabindex], ['Notes/Note#Part', '0']);
  const f = panelFixture(); f.panel.setOpen(true);
  const anchor = (cls, href) => { const x = element('a', { cls }); x.attrs['data-href'] = href; x.getAttribute = name => x.attrs[name] ?? null; x.closest = () => x; return x; };
  const press = (target, extra) => { let prevented = false; f.parts.log().fire('keydown', { target, key: 'Enter', preventDefault() { prevented = true; }, ...extra }); return prevented; };
  assert.equal(press(anchor('internal-link', 'Notes/Note')), true); eq(f.calls.links, [['Notes/Note', false]]);
  assert.equal(press(anchor('internal-link', 'Other'), { ctrlKey: true }), true); eq(f.calls.links.at(-1), ['Other', true]);
  assert.equal(press(anchor('internal-link', 'Skip'), { key: 'a' }), false); assert.equal(press(anchor('external-link', 'https://e')), false);
  assert.equal(f.calls.links.length, 2);
});

// Time limits (ms) for hostile input. Measured before the fix on the same machine: heading 5288, starsInline 1827, under 1130, wikiOpen 1199, brackets 1291.
const timed = (text) => { const t = process.hrtime.bigint(); lay(text); return Number(process.hrtime.bigint() - t) / 1e6; };
test('map chat D5 F2: a heading line with a long run of blanks parses in under 50 ms', () => {
  for (const text of ['# a' + ' '.repeat(40000) + 'x', '# a' + ' \t'.repeat(20000) + 'x', '#' + ' '.repeat(40000) + 'x #']) {
    const ms = timed(text); assert.ok(ms < 50, `${ms.toFixed(1)} ms for ${text.length} characters`);
  }
  eq(visibleText(lay('## Title ##  ')), 'Title'); eq(visibleText(lay('# C#')), 'C#'); eq(visibleText(lay('# a #b')), 'a #b');
});

test('map chat D5 F3: unmatched openers parse in under 100 ms, and a reply over 50,000 characters is laid out only up to that', () => {
  for (const [name, unit] of [['star', 'a *'], ['bracket', '['], ['wiki', '[[a'], ['underscore', 'a _b'], ['link', '[a]('], ['image', '![a](']]) {
    const text = unit.repeat(Math.ceil(40000 / unit.length)); const ms = timed(text);
    assert.ok(ms < 100, `${name}: ${ms.toFixed(1)} ms`);
  }
  const long = 'x'.repeat(49990) + '\n*not bold*\n[[Late]]'; const el = lay(long);
  eq(wikis(el), []); assert.equal(nodes(el).filter(i => i.tag === 'em').length, 0, 'the part past the limit is plain text');
  assert.ok(visibleText(el).includes('*not bold*') && visibleText(el).includes('[[Late]]'));
  eq(wikis(lay('*a* [[Early]] ' + 'y'.repeat(100))), ['Early']);
});

test('map chat D5 F4: a link whose text is only blanks or zero-width characters shows its address', () => {
  for (const text of ['[\u200b](https://a)', '[\u200c\u200d\u2060](https://a)', '[\ufeff \u00ad](https://a)', '[**\u200b**](https://a)']) {
    const [a] = anchors(lay(text)); assert.equal(visibleText(a), 'https://a', JSON.stringify(text));
  }
  assert.equal(visibleText(anchors(lay('[go\u200b](https://a)'))[0]), 'go\u200b');
});

test('map chat D4: line breaks are normalised (CRLF and CR) and kept inside a paragraph; blank lines separate paragraphs', () => {
  const el = lay('one\r\ntwo\rthree\r\n\r\nnext');
  assert.ok(!nodes(el).some(i => String(i.text).includes('\r')), 'no carriage return survives');
  eq(el.children.map(i => i.tag), ['p', 'p']); eq(el.children[0].children.map(i => i.tag === 'br' ? '|' : i.text), ['one', '|', 'two', '|', 'three']);
});

test('map chat D4: a very deep or very long reply is laid out without throwing', () => {
  lay('>'.repeat(200) + ' deep'); lay('*'.repeat(500) + 'x' + '*'.repeat(500)); lay('['.repeat(2000)); lay('- a\n'.repeat(2000));
  const el = lay('_a '.repeat(3000)); assert.ok(visibleText(el).length > 0);
});

integrationTest('map chat D3 F4: text dragged in while the note is in another window or a background tab still names its source note, with the file and a baseline', async () => {
  for (const setup of [
    h => h.setLeaves(h.leaf('Notes/Other.md', { doc: { other: true } })),
    h => h.setLeaves(h.leaf('Notes/Other.md', { shown: false })),
    h => { h.setActive('Notes/Other.md', '', null); h.leaves[0].view.containerEl.ownerDocument = { other: true }; }
  ]) {
    const h = await harness(); await h.view.hydrate(); setup(h);
    const chat = h.open();
    eq(noteLabel(chat), [], 'no current-note chip: the note is not beside the map');
    drop(chat.el, 'naps');
    eq(chat.attachments(), [{ kind: 'snippet', path: 'Notes/Other.md', text: 'naps', pathGuessed: true }]);
    assert.deepEqual(findAll(chat.chipsEl, i => hasClass(i, 'vam-map-chat-chip-label')).map(i => i.text), ['Text from Other']);
    h.control.reply = async () => ({ reply: 'r', actions: [{ kind: 'edit_md_file', path: 'Notes/Other.md', find: 'naps', replace: 'sleep' }], rejected: [] });
    const request = await send(h);
    const snippet = JSON.parse(request.context.json).snippets[0];
    assert.equal(snippet.path, 'Notes/Other.md'); assert.equal(snippet.contentHash, contentHash('Other note about naps.\n'), 'the file was read, so the snippet carries its hash');
    assert.equal(sentActive(request), null, 'the note is still not sent as the current note');
    assert.match(h.contents.get('Notes/Other.md'), /about sleep/, 'its file content gave the edit a baseline');
  }
});

integrationTest('map chat D3 F4: the source guess falls back from the active note to the last touched note to any open note', async () => {
  const h = await harness(); await h.view.hydrate();
  h.setLeaves(); assert.equal(h.view.sourceMarkdownFile(), null, 'nothing open');
  h.setLeaves(h.leaf('Notes/Other.md', { shown: false }), h.leaf('Notes/Research.md', { shown: false }));
  assert.equal(h.view.sourceMarkdownFile().path, 'Notes/Other.md', 'any open note');
  h.view.lastMarkdownPath = 'Notes/Research.md';
  assert.equal(h.view.sourceMarkdownFile().path, 'Notes/Research.md', 'the last touched, while open');
  h.setActive('Notes/Other.md', '', null);
  assert.equal(h.view.sourceMarkdownFile().path, 'Notes/Other.md', 'the active note first');
});

integrationTest('map chat D3 F4: a dropped [[link]] resolves from the source note even when that note is not visible', async () => {
  const h = await harness(); await h.view.hydrate();
  h.setLeaves(h.leaf('Notes/Other.md', { doc: { other: true } }));
  const seen = []; h.app.metadataCache.getFirstLinkpathDest = (link, from) => { seen.push([link, from]); return h.app.vault.getAbstractFileByPath('Notes/Research.md'); };
  const chat = h.open(); drop(chat.el, '[[Research]]');
  eq(seen, [['Research', 'Notes/Other.md']]); eq(chat.attachments(), [{ kind: 'file', path: 'Notes/Research.md' }]);
});

integrationTest('map chat D3 F5: the chip follows the layout too: a tab shown or hidden without a leaf change updates it', async () => {
  const h = await harness(); await h.view.hydrate();
  h.view.registerEvent = ref => ref; h.view.registerWorkspaceEvents();
  eq(h.handlers.map(x => x.name).sort(), ['active-leaf-change', 'layout-change', 'resize']);
  let shown = true; const leaf = h.leaf('Notes/Other.md'); leaf.containerEl.isShown = () => shown;
  h.setLeaves(leaf);
  const chat = h.open(); eq(noteLabel(chat), ['Current note: Other']);
  shown = false; h.handlers.find(x => x.name === 'layout-change').fn(); eq(noteLabel(chat), [], 'the tab was hidden');
  shown = true; h.handlers.find(x => x.name === 'layout-change').fn(); eq(noteLabel(chat), ['Current note: Other'], 'the tab is shown again');
  h.setLeaves(h.leaf('Notes/Research.md')); h.handlers.find(x => x.name === 'active-leaf-change').fn({ view: h.leaves[0].view });
  eq(noteLabel(chat), ['Current note: Research']); assert.equal(h.view.lastMarkdownPath, 'Notes/Research.md');
});

// ---- Packet D4: drag across maps, streaming scroll, collapsed sidebar --------------------------------------------------------

test('map chat D4: streaming keeps the end in view only when the reader was already at the end', () => {
  const f = panelFixture(); f.panel.setOpen(true); const log = f.parts.log();
  log.scrollHeight = 1000; log.clientHeight = 200; log.scrollTop = 800;
  f.panel.begin('q'); log.scrollTop = 800;
  f.panel.streamReply('a'); assert.equal(log.scrollTop, 1000, 'at the end: follows the new text');
  log.scrollTop = 100; f.panel.streamReply('ab'); assert.equal(log.scrollTop, 100, 'scrolled up to read: left where it is');
  f.panel.finish('abc', []); assert.equal(log.scrollTop, 100, 'finishing does not pull a reader who scrolled up');
  log.scrollTop = 795; f.panel.begin('q2'); assert.equal(log.scrollTop, 1000, 'a new question always shows its own end');
  log.scrollTop = 100; f.panel.begin('q3', undefined, false); assert.equal(log.scrollTop, 1000);
});

test('map chat D4 Bug A: focusing the message field, opening the panel and a resize all look at the visible note again', () => {
  const f = panelFixture(); f.panel.setOpen(true); f.showNote('Notes/A.md');
  eq(f.parts.chipTexts(), ['Current note: A']);
  f.setVisible(null); eq(f.parts.chipTexts(), ['Current note: A'], 'nothing told the panel yet');
  f.parts.input().fire('focus'); eq(f.parts.chipTexts(), [], 'focus refreshes the chip');
  f.setVisible('Notes/B.md'); f.panel.setOpen(false); f.panel.setOpen(true); eq(f.parts.chipTexts(), ['Current note: B'], 'opening refreshes it');
  f.setVisible(null); f.panel.setOpen(true, true); eq(f.parts.chipTexts(), [], 'opening with focus refreshes it');
});

integrationTest('map chat D4 Bug A: the note beside the map is hidden by collapsing a side panel; focusing the field removes its chip, and the resize event does too', async () => {
  const h = await harness(); await h.view.hydrate();
  h.view.registerEvent = ref => ref; h.view.registerWorkspaceEvents();
  let shown = true; const leaf = h.leaf('Notes/Other.md'); leaf.containerEl.isShown = () => shown; h.setLeaves(leaf);
  const chat = h.open(); eq(noteLabel(chat), ['Current note: Other']);
  shown = false; chat.inputEl.fire('focus'); eq(noteLabel(chat), [], 'focus: the chip is gone');
  shown = true; h.handlers.find(x => x.name === 'resize').fn(); eq(noteLabel(chat), ['Current note: Other'], 'resize: back');
  shown = false; h.handlers.find(x => x.name === 'resize').fn(); eq(noteLabel(chat), []);
});

integrationTest('map chat D4: a drag whose map was swapped for another before the drop writes nothing and adds no chip', async () => {
  for (const target of [[100, 400], [520, 150]]) {
    const d = await dragHarness();
    d.down(); d.move(target[0], target[1]); d.move(target[0] + 40, target[1] + 10);
    d.view.map = { ...d.view.map, id: 'another-map' };
    d.up(); await tick();
    assert.equal(d.chat.attachments().length, 0, 'no chip'); assert.equal(d.changes.length, 0, 'no write'); assert.equal(d.view.dragging, false); assert.equal(d.view.dragOrigin, null);
    assert.ok(!hasClass(d.chat.el, 'is-drop'));
  }
  const d = await dragHarness(); d.down(); d.move(520, 150); d.view.path = 'Another/Map.md'; d.up(); await tick();
  assert.equal(d.changes.length, 0, 'a different map file counts as a different map');
});

integrationTest('map chat D4: a drag whose map was deleted (map null) ends cleanly on the next move, on the drop and on a cancel, without throwing', async () => {
  const moved = await dragHarness(); moved.down(); moved.move(100, 400); moved.view.map = null;
  moved.move(110, 410);
  assert.equal(moved.view.dragging, false, 'the next move ends the drag'); assert.equal(moved.events.has('pointermove'), false, 'its listeners are gone'); assert.ok(!hasClass(moved.chat.el, 'is-drop'));
  const dropped = await dragHarness(); dropped.down(); dropped.move(100, 400); dropped.view.map = null; dropped.up(); await tick();
  assert.equal(dropped.chat.attachments().length, 0); assert.equal(dropped.changes.length, 0); assert.equal(dropped.view.dragging, false);
  const cancelled = await dragHarness(); cancelled.down(); cancelled.view.map = null; cancelled.events.get('pointercancel')({ type: 'pointercancel' }); assert.equal(cancelled.view.dragging, false);
});

integrationTest('map chat D4: a repaint asked for during a drag runs at once when the drag\'s map is gone, and still waits when only the map object was replaced', async () => {
  const gone = await dragHarness(); const probe = realRenderProbe(gone);
  gone.down(); gone.move(100, 400); gone.view.map = { ...gone.view.map, id: 'another-map' };
  probe.run(() => gone.view.render());
  assert.equal(probe.count, 1, 'repainted right away'); assert.equal(gone.view.dragging, false); assert.equal(gone.events.has('pointermove'), false); assert.equal(gone.view.renderAfterDrag, false);
  const nulled = await dragHarness(); const probe2 = realRenderProbe(nulled);
  nulled.down(); nulled.view.map = null; probe2.run(() => nulled.view.render());
  assert.equal(probe2.count, 1); assert.equal(nulled.view.dragging, false);
  const same = await dragHarness(); const probe3 = realRenderProbe(same);
  same.down(); same.move(100, 400); same.view.map = { ...same.view.map };
  probe3.run(() => same.view.render()); assert.equal(probe3.count, 0, 'same map, new object (every saved change makes one): the drag goes on'); assert.equal(same.view.renderAfterDrag, true);
  probe3.run(() => same.up()); assert.equal(probe3.count, 1); eq(same.chat.attachments(), [{ kind: 'topic', id: same.ids.a }], 'and the drop still adds its chip');
});

integrationTest('map chat D4: a pending repaint also runs when the drop finds the map gone, and a card that left the map adds no chip', async () => {
  const d = await dragHarness(); const probe = realRenderProbe(d);
  d.down(); d.move(100, 400); probe.run(() => d.view.render()); assert.equal(d.view.renderAfterDrag, true);
  d.view.map = { ...d.view.map, id: 'another-map' };
  probe.run(() => d.up());
  assert.equal(probe.count, 1); assert.equal(d.chat.attachments().length, 0); assert.equal(d.changes.length, 0);
  const removed = await dragHarness(); removed.down(); removed.move(100, 400);
  removed.view.map = { ...removed.view.map, nodes: removed.view.map.nodes.filter(n => n.id !== removed.ids.a) }; removed.up();
  assert.equal(removed.chat.attachments().length, 0, 'the card is no longer on the map');
});

// ---- Packet E1: very long replies (finished messages keep their rows, one layout per frame, element budget) ----------------

/** A window whose animation frames run only when the test says so. */
const frames = () => {
  const queue = [];
  return { queue, window: { requestAnimationFrame: callback => queue.push(callback), cancelAnimationFrame: id => { queue[id - 1] = null; } }, run: () => { const due = queue.splice(0); due.forEach(callback => callback?.()); return due.filter(Boolean).length; } };
};
const spyRows = log => { const made = { rows: 0 }; const create = log.createDiv.bind(log); log.createDiv = value => { if (String(value?.cls ?? value).includes('vam-map-chat-msg')) made.rows++; return create(value); }; return made; };
const DENSE = 'word *emph* **b** `c` [[x]] ';

test('map chat E1: a finished message keeps its row on every later repaint; only the new messages are built', () => {
  const f = panelFixture(); f.panel.setOpen(true); const log = f.parts.log(); const made = spyRows(log);
  f.panel.begin('q1'); f.panel.finish(DENSE.repeat(200), [{ status: 'done', text: 'Done: A' }]);
  const [user1, answer1] = [...log.children]; const body1 = answer1.children.find(c => hasClass(c, 'vam-map-chat-text'));
  let reparsed = 0; const empty = body1.empty.bind(body1); body1.empty = () => { reparsed++; empty(); };
  const inner = [...body1.children];
  made.rows = 0;
  f.panel.begin('q2'); f.panel.streamReply('second'); f.panel.finish('second answer', []);
  assert.equal(made.rows, 2 + 1, 'two rows for the new question and answer, then the finished answer once more');
  assert.equal(log.children.length, 4);
  assert.equal(log.children[0], user1); assert.equal(log.children[1], answer1, 'the same row object, not a copy');
  assert.equal(reparsed, 0, 'the finished message was not laid out again'); assert.deepEqual(body1.children, inner);
  f.panel.fail('x'); // no streaming message: nothing to change, still the same rows
  assert.equal(log.children[1], answer1);
});

test('map chat E1: a reset, and a new panel, start with no kept rows', () => {
  const f = panelFixture(); f.panel.setOpen(true); const log = f.parts.log();
  f.panel.begin('q1'); f.panel.finish('one', []); const old = [...log.children];
  f.panel.reset(); assert.equal(log.children.length, 0);
  f.panel.begin('q1'); f.panel.finish('one', []);
  assert.equal(log.children.length, 2); assert.ok(old.every(row => !log.children.includes(row)), 'nothing of the old conversation is reused');
});

test('map chat E1: the "more detail" button of a kept row follows the busy state without rebuilding the row', () => {
  const f = panelFixture(); f.panel.setOpen(true); const log = f.parts.log();
  f.panel.begin('q1', { text: 'q1', chips: [], selectedIds: [] }); f.panel.finish('one', []);
  const row = log.children[1]; const more = find(row, i => hasClass(i, 'vam-map-chat-more')); assert.equal(more.disabled, false);
  f.panel.begin('q2'); assert.equal(log.children[1], row); assert.equal(more.disabled, true, 'disabled while the next turn runs');
  f.panel.finish('two', []); assert.equal(log.children[1], row); assert.equal(more.disabled, false);
});

test('map chat E1: while streaming only the streaming message is laid out, once per frame, and the other rows stay the same objects', () => {
  const clock = frames(); const f = panelFixture({}, clock.window); f.panel.setOpen(true); const log = f.parts.log();
  f.panel.begin('q1'); f.panel.streamReply('first'); clock.run(); f.panel.finish('first answer', []);
  const before = [...log.children];
  f.panel.begin('q2'); const body = replyBody2(log); let layouts = 0; const empty = body.empty.bind(body); body.empty = () => { layouts++; empty(); };
  for (let i = 1; i <= 10; i++) f.panel.streamReply(`chunk ${i} `.repeat(i));
  assert.equal(layouts, 0, 'nothing is laid out until the frame'); assert.equal(clock.queue.filter(Boolean).length, 1, 'one frame is waiting');
  assert.equal(clock.run(), 1); assert.equal(layouts, 1, 'ten chunks, one layout');
  assert.equal(visibleText(body), 'chunk 10 '.repeat(10).replace(/chunk 10 $/, 'chunk 10 '));
  assert.equal(log.children[0], before[0]); assert.equal(log.children[1], before[1]);
  f.panel.streamReply('next'); assert.equal(clock.run(), 1); assert.equal(layouts, 2); assert.equal(visibleText(body), 'next');
});
const replyBody2 = log => { const rows = log.children.filter(r => hasClass(r, 'is-assistant')); return rows.at(-1).children.find(c => hasClass(c, 'vam-map-chat-text')); };

test('map chat E1: finish shows the complete text even when the last chunks never got their frame, and a late frame changes nothing', () => {
  const clock = frames(); const f = panelFixture({}, clock.window); f.panel.setOpen(true); const log = f.parts.log();
  f.panel.begin('q'); f.panel.streamReply('par'); f.panel.streamReply('partial **tail**');
  f.panel.finish('the **complete** answer', []);
  assert.equal(visibleText(replyBody2(log)), 'the complete answer'); assert.equal(clock.queue.filter(Boolean).length, 0, 'the waiting frame was cancelled');
  clock.queue.forEach(callback => callback?.()); assert.equal(visibleText(replyBody2(log)), 'the complete answer');
  f.panel.begin('q2'); f.panel.streamReply('one'); f.panel.markStopped(); assert.equal(visibleText(replyBody2(log)), 'one');
  f.panel.begin('q3'); f.panel.streamReply('x'); f.panel.reset(); clock.run(); assert.equal(log.children.length, 0, 'a frame after a reset adds nothing');
});

test('map chat E1: the end is looked at once per frame, and the follow-the-end rule is unchanged', () => {
  const clock = frames(); const f = panelFixture({}, clock.window); f.panel.setOpen(true); const log = f.parts.log();
  let reads = 0; let height = 1000; Object.defineProperty(log, 'scrollHeight', { get() { reads++; return height; }, configurable: true });
  log.clientHeight = 200; log.scrollTop = 800; f.panel.begin('q'); log.scrollTop = 800; reads = 0;
  for (let i = 0; i < 10; i++) f.panel.streamReply('a'.repeat(i + 1));
  assert.equal(reads, 0, 'no layout is read per chunk'); clock.run(); assert.ok(reads <= 2, `one look before and one after the layout: ${reads}`);
  assert.equal(log.scrollTop, 1000, 'at the end: follows');
  log.scrollTop = 100; f.panel.streamReply('abc'); clock.run(); assert.equal(log.scrollTop, 100, 'scrolled up: left where it is');
});

const layoutWith = (text, note = 'NOTE') => { const el = element('div'); renderChatMarkdown(el, text, note); return el; };
const FIXED = 6; // a plain block, its note and the paragraph around them
test('map chat E1: a reply past the element budget builds at most the budget, then shows the rest as plain text with a note', () => {
  const { MAX_REPLY_NODES } = load('core/map-chat-render.ts');
  assert.ok(MAX_REPLY_NODES <= 2000);
  const text = DENSE.repeat(1850) + 'THE END'; const el = layoutWith(text);
  const count = nodes(el).length - 1;
  assert.ok(count <= MAX_REPLY_NODES + FIXED, `${count} elements`);
  const plain = find(el, i => hasClass(i, 'vam-map-chat-plain')); const note = find(el, i => hasClass(i, 'vam-map-chat-overflow-note'));
  assert.ok(plain && note); assert.equal(note.text, 'NOTE'); assert.ok(plain.text.endsWith('THE END'), 'the end of the reply is there');
  assert.ok(plain.text.includes('*emph* **b** `c` [[x]]'), 'the markup is shown as it was written');
  assert.equal(findAll(plain, () => true).length, 1, 'one block, no children');
  assert.ok(el.children.indexOf(note) < el.children.indexOf(plain));
  assert.equal(nodes(el).filter(i => i.tag === 'a').length > 0, true, 'the start is still laid out');
});
test('map chat E1: past the budget, lines and list items keep their line breaks in the plain block, and nothing is lost', () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `- item *${i}* **x**`); const text = lines.join('\n');
  const el = layoutWith(text); assert.ok(nodes(el).length - 1 <= 2000 + FIXED);
  const plain = find(el, i => hasClass(i, 'vam-map-chat-plain')); assert.ok(plain.text.includes('\n'));
  assert.ok(plain.text.endsWith('- item *4999* **x**')); assert.ok(plain.text.split('\n').length > 1000);
  const shown = visibleText(el); assert.ok(shown.includes('item 0'), 'the start is laid out as a list'); assert.equal(find(el, i => i.tag === 'ul') !== undefined, true);
  const first = plain.text.split('\n')[0]; const at = lines.indexOf(first); assert.ok(at > 0, 'the plain part begins at a line of the reply'); assert.equal(plain.text, lines.slice(at).join('\n'));
  const para = layoutWith('a *b*\n'.repeat(5000).trimEnd()); const p = find(para, i => hasClass(i, 'vam-map-chat-plain')); assert.ok(p.text.includes('\n') && p.text.endsWith('a *b*'));
});
test('map chat E1: a reply under the budget has no plain block and no note; the 50,000 character limit still applies after it', () => {
  const small = layoutWith(DENSE.repeat(50)); assert.equal(find(small, i => hasClass(i, 'vam-map-chat-plain')), undefined); assert.equal(find(small, i => hasClass(i, 'vam-map-chat-overflow-note')), undefined);
  const code = layoutWith('```\n' + 'x'.repeat(40000) + '\n```'); assert.equal(find(code, i => hasClass(i, 'vam-map-chat-plain')), undefined, 'a code block is two elements, however long');
  const huge = layoutWith('word '.repeat(30000)); const plain = find(huge, i => hasClass(i, 'vam-map-chat-plain')); assert.ok(plain); assert.ok(plain.text.length > 90000 || visibleText(huge).length >= 150000 - 5);
  const noNote = element('div'); renderChatMarkdown(noNote, DENSE.repeat(1850)); assert.equal(find(noNote, i => hasClass(i, 'vam-map-chat-overflow-note')), undefined, 'no note is made without text for it');
});
test('map chat E1: the panel gives the note in the reader\'s language, and all three languages have it', () => {
  const f = panelFixture(); f.panel.setOpen(true); f.panel.begin('q'); f.panel.finish(DENSE.repeat(1850), []);
  const note = find(f.parts.log(), i => hasClass(i, 'vam-map-chat-overflow-note')); assert.ok(note); assert.match(note.text, /too long/i);
  for (const lang of ['en', 'zh-TW', 'zh-CN']) assert.match(fs.readFileSync(path.join(root, 'i18n', `${lang}.ts`), 'utf8'), /"ui\.map_chat_overflow_note": "[^"]+"/, lang);
});
test('map chat E1: long dense replies streamed in bursts of chunks, then a short reply, lay out in a small multiple of one parse', () => {
  const dense = DENSE.repeat(1850); const short = 'word '.repeat(400);
  const once = run => { const start = process.hrtime.bigint(); run(); return Number(process.hrtime.bigint() - start) / 1e6; };
  const best = (count, run) => { let min = Infinity; for (let i = 0; i < count; i++) min = Math.min(min, once(run)); return min; };
  // Six dense turns kept in the log, each streamed as 30 chunks with a frame after every third chunk, then a short turn.
  const streamed = () => {
    const clock = frames(); const f = panelFixture({}, clock.window); f.panel.setOpen(true);
    for (const [q, text] of [...Array.from({ length: 6 }, (_, i) => [`d${i}`, dense]), ['s', short]]) {
      f.panel.begin(q);
      for (let i = 1; i <= 30; i++) { f.panel.streamReply(text.slice(0, Math.ceil(text.length * i / 30))); if (i % 3 === 0) clock.run(); }
      f.panel.finish(text, []);
    }
  };
  streamed(); // warm up
  // The bound is relative, measured in this process: one inline parse of the head of the same dense reply is the unit (it does not depend on the element budget), so a slow machine moves both sides.
  const { parseInline } = load('core/map-chat-render.ts'); const unit = best(5, () => parseInline(dense.slice(0, 50000)));
  const ms = best(5, streamed); const ratio = ms / unit;
  console.log(`E1 timing: ${ms.toFixed(0)} ms for the streamed run, ${unit.toFixed(1)} ms for one parse, ratio ${ratio.toFixed(1)}`);
  assert.ok(ratio <= STREAM_RATIO_LIMIT, `${ms.toFixed(0)} ms is ${ratio.toFixed(1)} times one parse (${unit.toFixed(1)} ms)`);
});
// Ratio of the streamed run to one inline parse. Measured here: 160 to 185 with the row cache, the frame coalescing and the element budget; 330 to 500 without the row cache,
// 410 to 460 with a layout for every chunk, 770 to 850 with a 2,000,000 element budget. 260 sits between; a slower machine moves both sides of the ratio.
const STREAM_RATIO_LIMIT = 260;

// ---- Packet E2: one parse for the cut, the view's own window, language, plain-text edges --------------------------------------------

/** The render module with a count of the characters handed to a top-level inline parse, and `layoutReply` exposed for timing. */
function spyRender() {
  const source = fs.readFileSync(path.join(root, 'core/map-chat-render.ts'), 'utf8');
  const signature = /export function parseInline\([^)]*\): ChatInline\[\] \{/;
  assert.match(source, signature, 'parseInline is still the one inline parser');
  const body = source.replace(signature, match => `export const __spy = { chars: 0 };\n${match}\n  if (depth === 0) __spy.chars += src.length;`) + '\nexport { layoutReply as __layoutReply };\n';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-render-spy-'));
  try { fs.writeFileSync(path.join(dir, 'map-chat-render.ts'), body); return load(path.relative(root, path.join(dir, 'map-chat-render.ts'))); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
// About 20 characters per element, so the cut falls late in the 50,000 characters (the worst case for a search that parses prefixes).
const SPARSE = 'alpha beta gamma delta epsilon zeta eta theta iota kappa *e* ';
const bestOf = (count, run) => { let best = Infinity; for (let i = 0; i < count; i++) { const start = process.hrtime.bigint(); run(); best = Math.min(best, Number(process.hrtime.bigint() - start) / 1e6); } return best; };
const plainOf = el => find(el, i => hasClass(i, 'vam-map-chat-plain'));
const laidParagraph = el => find(el, i => i.tag === 'p' && !hasClass(i, 'vam-map-chat-plain') && !hasClass(i, 'vam-map-chat-overflow-note'));

test('map chat E2: the cut is found while parsing: a reply is parsed once, whatever the shape of the overflow', () => {
  const lists = Array.from({ length: 5000 }, (_, i) => `- item *${i}* **x**`).join('\n');
  for (const [name, text] of [['dense', DENSE.repeat(1850)], ['sparse', SPARSE.repeat(900)], ['list', lists], ['lines', 'a *b* c\n'.repeat(6000)], ['quote', '> ' + DENSE.repeat(1850)], ['blocks', 'para *x* **y**\n\n'.repeat(3000)]]) {
    const spy = spyRender(); const el = element('div'); spy.renderChatMarkdown(el, text, 'NOTE');
    assert.ok(plainOf(el), `${name}: the reply overflows`);
    const limit = Math.min(text.length, 50000);
    assert.ok(spy.__spy.chars <= limit, `${name}: ${spy.__spy.chars} characters parsed for a ${limit} character head`);
  }
});

test('map chat E2: laying a dense single-line reply out costs about one parse of it, not a search that parses many prefixes', () => {
  const spy = spyRender();
  for (const text of [DENSE.repeat(1850), SPARSE.repeat(900)]) {
    const one = bestOf(9, () => spy.parseInline(text.slice(0, 50000)));
    const cut = bestOf(9, () => spy.__layoutReply(text));
    assert.ok(cut <= one * 2, `layout ${cut.toFixed(1)} ms against ${one.toFixed(1)} ms for one parse`);
  }
});

test('map chat E2: a reply streamed in a popped-out window asks that window for its frames, and cancels in it', () => {
  const main = frames(); const popout = frames(); const f = panelFixture({}, main.window); f.panel.setOpen(true); const log = f.parts.log();
  log.win = popout.window;
  f.panel.begin('q'); f.panel.streamReply('one'); f.panel.streamReply('one two');
  assert.equal(main.queue.length, 0, 'the main window was not asked'); assert.equal(popout.queue.filter(Boolean).length, 1);
  assert.equal(popout.run(), 1); assert.equal(visibleText(replyBody2(log)), 'one two');
  f.panel.streamReply('three'); f.panel.finish('final', []);
  assert.equal(popout.queue.filter(Boolean).length, 0, 'the waiting frame was cancelled in the window that was asked'); assert.equal(main.queue.length, 0);
  // Without `win`, the window of the document is the one asked.
  const other = frames(); const g = panelFixture({}, main.window); g.panel.setOpen(true); g.parts.log().ownerDocument = { defaultView: other.window };
  g.panel.begin('q'); g.panel.streamReply('x'); assert.equal(main.queue.length, 0); assert.equal(other.queue.length, 1);
});

test('map chat E2: changing the interface language rebuilds the "you" label and the overflow note of rows already shown', () => {
  const f = panelFixture(); f.panel.setOpen(true); const log = f.parts.log();
  f.setLanguage('en'); f.panel.begin('q'); f.panel.finish(DENSE.repeat(1850), []);
  const roleOf = row => find(row, i => hasClass(i, 'vam-map-chat-role')).text; const noteOf = row => find(row, i => hasClass(i, 'vam-map-chat-overflow-note')).text;
  const [userBefore, answerBefore] = [...log.children]; const roleBefore = roleOf(userBefore); const noteBefore = noteOf(answerBefore);
  f.setLanguage('zh-TW'); f.panel.begin('q2'); f.panel.finish('ok', []);
  const [userAfter, answerAfter] = [...log.children];
  assert.notEqual(userAfter, userBefore, 'the user row was rebuilt'); assert.notEqual(roleOf(userAfter), roleBefore);
  assert.notEqual(answerAfter, answerBefore, 'the answer row was rebuilt'); assert.notEqual(noteOf(answerAfter), noteBefore);
  const kept = [...log.children]; f.panel.begin('q3'); f.panel.finish('three', []); assert.equal(log.children[0], kept[0], 'same language: rows are kept again');
});

test('map chat E2: the plain part keeps the indentation of its first line; only the blank lines at the cut go', () => {
  const head = '```\n' + 'x'.repeat(49000) + '\n```\n';
  const el = layoutWith(head + '    indented first ' + 'y'.repeat(1500) + '\n  second');
  assert.ok(plainOf(el).text.startsWith('    indented first yyy'), JSON.stringify(plainOf(el).text.slice(0, 40))); assert.ok(plainOf(el).text.endsWith('\n  second'));
  assert.ok(plainOf(layoutWith(head + '\n\n\n  two spaces ' + 'y'.repeat(2000))).text.startsWith('  two spaces '));
  // A paragraph that overflows in the middle: the rest follows the last piece that fit, with no line break in front.
  const text = 'a *b*\n'.repeat(5000).trimEnd(); const rest = plainOf(layoutWith(text)).text;
  assert.ok(!rest.startsWith('\n') && text.endsWith(rest) && rest.length > 1000);
});

test('map chat E2: a long paragraph with no blank and no line break is cut between two of its pieces, never given up whole', () => {
  const text = '中文，更多。*強*再來！'.repeat(1500); const el = layoutWith(text); const plain = plainOf(el); assert.ok(plain, 'the reply overflows');
  assert.ok(nodes(el).length - 1 <= 2000 + FIXED);
  const emphasised = nodes(el).filter(i => i.tag === 'em').length; assert.ok(emphasised > 300, `the start is laid out (${emphasised} emphasised pieces)`);
  assert.ok(text.endsWith(plain.text), 'the rest is the end of the reply, as written');
  assert.equal(visibleText(laidParagraph(el)), text.slice(0, text.length - plain.text.length).replace(/\*/g, ''), 'nothing is lost or repeated at the cut');
});

test('map chat E2: no cut falls inside an emoji, at a piece boundary or at the 50,000 character limit', () => {
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const marked = '😀*好*😀'.repeat(1200); const el = layoutWith(marked); const plain = plainOf(el); assert.ok(plain);
  assert.ok(!lone.test(plain.text) && !lone.test(visibleText(el)), 'no half of an emoji in the output'); assert.ok(marked.endsWith(plain.text));
  const odd = 'a' + '😀'.repeat(30000); const big = layoutWith(odd); const bigPlain = plainOf(big); assert.ok(bigPlain, 'past 50,000 characters');
  assert.ok(!lone.test(visibleText(big)), 'the cut at the limit does not split a pair');
  assert.equal(visibleText(laidParagraph(big)) + bigPlain.text, odd, 'all of it is still there, once');
});

test('map chat E2: a heading, a quote or a list that does not fit goes to the plain part whole or by items, and nothing is lost', () => {
  const title = '# ' + '*a* '.repeat(2500); const h = layoutWith('first\n\n' + title);
  assert.equal(findAll(h, i => /^h\d$/.test(i.tag)).length, 0); assert.equal(plainOf(h).text, title);
  const quote = '> ' + '*q* '.repeat(2500); assert.equal(plainOf(layoutWith(quote)).text, quote);
  const items = Array.from({ length: 1500 }, (_, i) => `- row **${i}** and more`); const l = layoutWith(items.join('\n') + '\n\nafter');
  const lp = plainOf(l).text; const at = items.findIndex(row => lp.startsWith(row)); assert.ok(at > 100);
  assert.equal(lp, items.slice(at).join('\n') + '\n\nafter'); assert.equal(findAll(l, i => i.tag === 'li').length, at);
});

// ---- first window, core (B1-core) -----------------------------------------------------------------------------------
// The panel's plan card is clicked through its real buttons. A snapshot of every file in the vault proves "nothing changed".
const vaultState = h => JSON.stringify([...h.contents.entries()].sort(([a], [b]) => a < b ? -1 : 1));
const planCard = h => findAll(h.view.chat.logEl, i => hasClass(i, 'vam-map-chat-plan'));
const planButton = (h, which) => find(h.view.chat.logEl, i => i.tag === 'button' && hasClass(i, `vam-map-chat-plan-${which}`));
const addRoot = (ref, title, parentId = '') => ({ kind: 'add_child', parentId, title, summary: '', ref });
const children = (h, id) => h.view.map.nodes.filter(n => n.parentId === id);
const titleOf = async (h, node) => (await h.repo.readNote(node.path)).title;

integrationTest('B1 core: a root card plus three levels, tied together with new:<ref>, are built on an empty map with the same parent/child shape as the reply', async () => {
  const h = await harness({ empty: true }); await h.view.hydrate(); assert.equal(h.view.map.nodes.length, 0);
  const lines = await apply(h, [addRoot('r', 'Coffee'), addRoot('o', 'Origins', 'new:r'), addRoot('p', 'Processing', 'new:r'), addRoot('e', 'Ethiopia', 'new:o'), addRoot('w', 'Washed', 'new:p'), addRoot('x', 'Anaerobic', 'new:p')]);
  eq(lines.slice(0, 6).map(l => l.status), Array(6).fill('done'), JSON.stringify(lines)); assert.equal(lines.length, 7, 'six cards: the sixth line is the automatic layout');
  const saved = await h.saved(); assert.equal(saved.length, 6);
  const byTitle = {}; for (const n of saved) byTitle[await titleOf(h, n)] = n;
  assert.equal(byTitle.Coffee.parentId, null); assert.equal(byTitle.Origins.parentId, byTitle.Coffee.id); assert.equal(byTitle.Processing.parentId, byTitle.Coffee.id);
  assert.equal(byTitle.Ethiopia.parentId, byTitle.Origins.id); assert.equal(byTitle.Washed.parentId, byTitle.Processing.id); assert.equal(byTitle.Anaerobic.parentId, byTitle.Processing.id);
  assert.equal(h.control.nested, 0, 'never a mutate inside a mutate');
});
integrationTest('B1 core: a card whose parent was not created is skipped with a reason, its own children too, and the other cards still build', async () => {
  const h = await harness(); await h.view.hydrate();
  const lines = await apply(h, [{ kind: 'add_child', parentId: 'ghost-id', title: 'Orphan', summary: '', ref: 'o' }, addRoot('k', 'Kid', 'new:o'), addRoot('kk', 'Grandkid', 'new:k'), { kind: 'add_child', parentId: h.ids.a, title: 'Fine', summary: '' }]);
  eq(lines.map(l => l.status), ['skipped', 'skipped', 'skipped', 'done'], JSON.stringify(lines));
  assert.match(lines[0].text, /no longer on the map/); assert.match(lines[1].text, /parent topic was not created/); assert.match(lines[2].text, /parent topic was not created/);
  assert.equal((await h.saved()).length, 5);
});
integrationTest('B1 core: a new root card on a map that has cards goes in beside the others; no parent card is needed', async () => {
  const h = await harness(); await h.view.hydrate();
  const lines = await apply(h, [addRoot('r', 'Second root'), addRoot('k', 'Its child', 'new:r')]);
  eq(lines.map(l => l.status), ['done', 'done']);
  const roots = (await h.saved()).filter(n => !n.parentId); assert.equal(roots.length, 2);
});

integrationTest('B1 plan: 16 actions wait for Apply; until then the map, the notes and Map.md are untouched', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  const before = vaultState(h); h.control.mutates = 0;
  h.control.reply = async () => ({ reply: 'I will add sixteen cards.', actions: Array.from({ length: 16 }, (_, i) => ({ kind: 'add_child', parentId: h.ids.root, title: `Card ${i}`, summary: '' })), rejected: [] });
  h.type('add many'); await h.view.sendMapChat();
  assert.equal(planCard(h).length, 1, 'the plan card is in the conversation'); assert.equal(chat.pendingPlan().state, 'pending');
  assert.equal(chat.isBusy, false); assert.equal(h.control.mutates, 0, 'no write was queued'); assert.equal(vaultState(h), before, 'the vault is byte for byte as it was');
  assert.match(visibleText(planCard(h)[0]), /16 actions/); assert.match(visibleText(planCard(h)[0]), /No extra AI calls/);
  assert.equal(findAll(planCard(h)[0], i => i.tag === 'li' && /Add subtopic/.test(visibleText(i))).length, 16, 'every action is listed');
  assert.equal(planButton(h, 'apply').attrs.type, 'button'); assert.equal(planButton(h, 'cancel').attrs.type, 'button');
  planButton(h, 'apply').click(); await until(() => chat.pendingPlan() === null && !h.view.chatApplying);
  assert.equal(children(h, h.ids.root).length, 18); assert.notEqual(vaultState(h), before);
  const lines = chat.transcript().at(-1).lines; assert.equal(lines.filter(l => l.status === 'done').length >= 16, true);
});
integrationTest('B1 plan: Cancel leaves the vault exactly as it was and the buttons stop working', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); const before = vaultState(h);
  h.control.reply = async () => ({ reply: 'plan', actions: Array.from({ length: 20 }, (_, i) => ({ kind: 'add_child', parentId: h.ids.root, title: `Card ${i}`, summary: '' })), rejected: [] });
  h.type('add many'); await h.view.sendMapChat(); const card = chat.pendingPlan();
  planButton(h, 'cancel').click();
  assert.equal(card.state, 'cancelled'); assert.equal(h.control.mutates, 0); assert.equal(vaultState(h), before);
  assert.match(visibleText(planCard(h)[0]), /Plan cancelled\. Nothing was changed\./); assert.equal(planButton(h, 'apply'), undefined, 'no buttons on a settled plan');
  card.apply(); await tick(); assert.equal(h.control.mutates, 0, 'a settled card cannot be applied'); assert.equal(vaultState(h), before);
});
integrationTest('B1 plan: sending a new message while a plan waits cancels it; the old Apply no longer writes', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); const before = vaultState(h);
  h.control.reply = async () => ({ reply: 'plan', actions: Array.from({ length: 16 }, (_, i) => ({ kind: 'add_child', parentId: h.ids.root, title: `Card ${i}`, summary: '' })), rejected: [] });
  h.type('add many'); await h.view.sendMapChat(); const old = chat.pendingPlan();
  h.control.reply = async () => ({ reply: 'just talking', actions: [], rejected: [] });
  h.type('never mind'); await h.view.sendMapChat();
  assert.equal(old.state, 'cancelled'); assert.equal(chat.pendingPlan(), null);
  old.apply(); await tick(); assert.equal(vaultState(h), before, 'the old plan wrote nothing'); assert.equal(h.control.mutates, 0);
  assert.equal(old.state, 'cancelled', 'a superseded card is not marked applied by a late Apply');
});
integrationTest('B1 plan: switching to another map by hand ends the plan; closing the view does too', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); const before = vaultState(h);
  h.control.reply = async () => ({ reply: 'plan', actions: Array.from({ length: 16 }, (_, i) => ({ kind: 'add_child', parentId: h.ids.root, title: `Card ${i}`, summary: '' })), rejected: [] });
  h.type('add many'); await h.view.sendMapChat(); const card = chat.pendingPlan();
  h.view.map.id = 'another-map'; h.repaint();
  card.apply(); await tick(); assert.equal(h.control.mutates, 0); assert.equal(vaultState(h), before);
  h.view.map.id = 'map-a'; h.repaint();
  h.type('again'); await h.view.sendMapChat(); const second = chat.pendingPlan(); assert.ok(second);
  await h.view.onClose(); second.apply(); await tick(); assert.equal(h.control.mutates, 0);
});
integrationTest('B1 plan: Apply on a plan whose map is no longer the open one writes nothing and says so', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); const before = vaultState(h);
  h.control.reply = async () => ({ reply: 'plan', actions: Array.from({ length: 16 }, (_, i) => ({ kind: 'add_child', parentId: h.ids.root, title: `Card ${i}`, summary: '' })), rejected: [] });
  h.type('add many'); await h.view.sendMapChat(); const card = chat.pendingPlan();
  h.view.path = 'Agent Workspace/Topics/elsewhere/Map.md'; // the view moved on without the conversation being reset
  planButton(h, 'apply').click(); await tick();
  assert.equal(card.state, 'cancelled'); assert.equal(h.control.mutates, 0); assert.equal(vaultState(h), before);
  assert.match(chat.transcript().at(-1).lines[0].text, /map was changed or closed/);
});
integrationTest('B1 plan: exactly 15 actions are applied at once, with no plan card', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  h.control.reply = async () => ({ reply: 'adding', actions: Array.from({ length: 15 }, (_, i) => ({ kind: 'add_child', parentId: h.ids.root, title: `Card ${i}`, summary: '' })), rejected: [] });
  h.type('add 15'); await h.view.sendMapChat();
  assert.equal(planCard(h).length, 0); assert.equal(chat.pendingPlan(), null); assert.equal(children(h, h.ids.root).length, 17);
});
integrationTest('B1 plan: delete with branch:true needs a plan when the card has subtopics, and not when it is a leaf', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); const before = vaultState(h);
  h.control.reply = async () => ({ reply: 'removing', actions: [{ kind: 'delete_topic', nodeId: h.ids.a, branch: true }], rejected: [] });
  h.type('remove Body'); await h.view.sendMapChat();
  assert.equal(planCard(h).length, 1); assert.match(visibleText(planCard(h)[0]), /whole branch/); assert.equal(vaultState(h), before);
  planButton(h, 'cancel').click();
  h.control.reply = async () => ({ reply: 'removing', actions: [{ kind: 'delete_topic', nodeId: h.ids.c, branch: true }], rejected: [] });
  h.type('remove REM'); await h.view.sendMapChat();
  assert.equal(chat.pendingPlan(), null, 'a leaf has no branch to take with it');
  assert.equal(h.view.map.nodes.some(n => n.id === h.ids.c), false, 'REM was moved out at once');
});
integrationTest('B1 plan: a plan that waited while the card changed skips that action as stale, like any other', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  h.control.reply = async () => ({ reply: 'plan', actions: [...Array.from({ length: 15 }, (_, i) => ({ kind: 'add_child', parentId: h.ids.b, title: `Card ${i}`, summary: '' })), { kind: 'rename_topic', nodeId: h.ids.a, title: 'Renamed' }], rejected: [] });
  h.type('go'); await h.view.sendMapChat();
  await h.view.noteChange(h.node('a'), { title: 'Edited by the user meanwhile' });
  planButton(h, 'apply').click(); await until(() => !h.view.chatApplying && chat.transcript().at(-1).lines.length > 0);
  assert.equal((await h.note('a')).title, 'Edited by the user meanwhile', 'the user\'s edit stays');
  assert.ok(chat.transcript().at(-1).lines.some(l => l.status === 'skipped' && /changed after you sent/.test(l.text)), JSON.stringify(chat.transcript().at(-1).lines));
});

integrationTest('B1 map: create_map waits for Apply, then opens the new map, builds the tree in it, and the conversation goes along', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); const oldPath = h.view.path; const oldNodes = JSON.stringify(await h.saved());
  chat.begin('earlier'); chat.finish('earlier answer', []);
  h.control.reply = async () => ({ reply: 'I will create a map.', actions: [{ kind: 'create_map', title: 'Quantum computing' }, addRoot('r', 'Quantum'), addRoot('q', 'Qubits', 'new:r'), addRoot('g', 'Gates', 'new:r')], rejected: [] });
  const topicsBefore = (await h.repo.topics()).length;
  h.type('new map on quantum'); await h.view.sendMapChat();
  assert.equal((await h.repo.topics()).length, topicsBefore, 'no map was made before Apply'); assert.equal(h.view.path, oldPath);
  assert.match(visibleText(planCard(h)[0]), /new map/);
  planButton(h, 'apply').click(); await until(() => !h.view.chatApplying && chat.pendingPlan() === null && chat.transcript().at(-1).lines.length > 0);
  assert.notEqual(h.view.path, oldPath); assert.equal(h.view.map.title, 'Quantum computing'); assert.equal((await h.repo.topics()).length, topicsBefore + 1);
  assert.equal(h.view.map.nodes.length, 3); const root = h.view.map.nodes.find(n => !n.parentId); assert.equal(children(h, root.id).length, 2);
  assert.equal(JSON.stringify((await h.repo.readMap(oldPath)).nodes), oldNodes, 'the old map is unchanged');
  assert.equal(chat.transcript().length, 4, 'the conversation was kept: earlier turn + this turn'); assert.equal(chat.transcript()[0].text, 'earlier');
  assert.equal(h.view.chatMapId, h.view.map.id); assert.equal(chat.isBusy, false);
  eq(chat.transcript().at(-1).lines.slice(0, 4).map(l => l.status), ['done', 'done', 'done', 'done'], JSON.stringify(chat.transcript().at(-1).lines));
  // A later manual switch still starts a new conversation.
  h.view.map.id = 'another-map'; h.repaint(); assert.equal(chat.transcript().length, 0);
});
integrationTest('B1 map: if the new map cannot be made nothing else is written to the map the user is looking at', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  const original = h.repo.createMap.bind(h.repo); h.repo.createMap = async () => { throw new Error('disk full'); };
  h.control.reply = async () => ({ reply: 'plan', actions: [{ kind: 'create_map', title: 'Quantum' }, addRoot('r', 'Quantum'), addRoot('q', 'Qubits', 'new:r')], rejected: [] });
  const nodes = JSON.stringify(await h.saved());
  h.type('new map'); await h.view.sendMapChat(); planButton(h, 'apply').click(); await until(() => !h.view.chatApplying && chat.transcript().at(-1).lines.length > 0);
  h.repo.createMap = original;
  const lines = chat.transcript().at(-1).lines;
  assert.equal(lines[0].status, 'failed'); assert.match(lines[0].text, /disk full/); eq(lines.slice(1, 3).map(l => l.status), ['skipped', 'skipped']); assert.match(lines[1].text, /new map was not created/);
  assert.equal(JSON.stringify(await h.saved()), nodes, 'the current map was not touched'); assert.equal(h.view.path, MAP);
});
integrationTest('B1 map: open_map switches at once when exactly one map matches, the conversation goes along, and the turn still finishes', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  const coffee = await h.repo.createMap('Coffee industry'); await h.repo.createMap('Tea');
  chat.begin('hi'); chat.finish('hello', []);
  h.control.reply = async () => ({ reply: 'Switching.', actions: [{ kind: 'open_map', title: 'coffee' }], rejected: [] });
  h.type('go to the coffee one'); await h.view.sendMapChat();
  assert.equal(h.view.path, coffee); assert.equal(planCard(h).length, 0, 'open_map needs no plan');
  assert.equal(chat.isBusy, false, 'the turn finished although the map changed under it'); assert.equal(chat.transcript().length, 4);
  assert.equal(chat.transcript().at(-1).text, 'Switching.'); assert.equal(chat.transcript().at(-1).lines[0].status, 'done');
  assert.equal(h.view.chatMapId, h.view.map.id); assert.equal(h.plugin.activeTasks.size, 0);
});
integrationTest('B1 map: open_map with several matches lists them and opens nothing until one is picked; none writes the reason', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  const a = await h.repo.createMap('Coffee industry'); const b = await h.repo.createMap('Coffee brewing');
  h.control.reply = async () => ({ reply: 'Which one?', actions: [{ kind: 'open_map', title: 'Coffee' }], rejected: [] });
  h.type('open coffee'); await h.view.sendMapChat();
  assert.equal(h.view.path, MAP, 'nothing opened yet'); const buttons = findAll(chat.logEl, i => i.tag === 'button' && hasClass(i, 'vam-map-chat-choice'));
  eq(buttons.map(i => i.text).sort(), ['Coffee brewing', 'Coffee industry']);
  assert.equal(chat.transcript().at(-1).lines[0].status, 'skipped'); assert.match(chat.transcript().at(-1).lines[0].text, /several maps match/);
  buttons.find(i => i.text === 'Coffee brewing').click(); await until(() => h.view.path !== MAP && !h.view.chatApplying);
  assert.equal(h.view.path, b); assert.notEqual(h.view.path, a); assert.equal(chat.transcript().at(0).text, 'open coffee', 'the conversation went along');
  assert.ok(chat.transcript().at(-1).lines.some(l => l.status === 'done' && /Opened/.test(l.text)));
  h.control.reply = async () => ({ reply: 'None', actions: [{ kind: 'open_map', title: 'Wine cellar' }], rejected: [] });
  h.type('open wine'); await h.view.sendMapChat();
  assert.equal(h.view.path, b); assert.match(chat.transcript().at(-1).lines[0].text, /no map has that name/);
});

integrationTest('B1 view operations: collapse, expand, auto layout and focus each write one result line; collapse and expand are saved in Map.md', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  h.view.history.push({ undo: async () => {}, redo: async () => {}, label: 'earlier' });
  const lines = await apply(h, [{ kind: 'collapse_topic', nodeId: h.ids.a }, { kind: 'auto_layout' }, { kind: 'focus_topic', nodeId: h.ids.b }, { kind: 'expand_topic', nodeId: h.ids.a }, { kind: 'collapse_topic', nodeId: h.ids.c }]);
  eq(lines.map(l => l.status), ['done', 'done', 'done', 'done', 'skipped'], JSON.stringify(lines));
  assert.match(lines[0].text, /Collapse “Body”/); assert.match(lines[1].text, /Arrange the whole map/); assert.match(lines[2].text, /Move the view to “Mind”/); assert.match(lines[3].text, /Expand “Body”/); assert.match(lines[4].text, /no subtopics/);
  eq(h.focused, [h.ids.b]);
  assert.equal(h.control.nested, 0); assert.equal(h.view.history.undoEntry, undefined, 'the undo history was cleared');
  await apply(h, [{ kind: 'collapse_topic', nodeId: h.ids.a }]);
  assert.equal((await h.saved()).find(n => n.id === h.ids.a).collapsed, true, 'saved'); assert.equal(chat.isBusy, false);
  await apply(h, [{ kind: 'expand_topic', nodeId: h.ids.a }]); assert.equal(!!(await h.saved()).find(n => n.id === h.ids.a).collapsed, false);
});
integrationTest('B1 view operations: a reply that adds five cards is arranged once and the view goes to the new root; four cards are not; an explicit auto_layout is not doubled', async () => {
  const counted = async () => { const h = await harness({ empty: true }); await h.view.hydrate(); h.layouts = 0; const original = h.view.mapChange.bind(h.view); h.view.mapChange = async (change, rebuild) => { h.layouts++; return original(change, rebuild); }; return h; };
  const tree = count => [addRoot('r', 'Root'), ...Array.from({ length: count - 1 }, (_, i) => addRoot(`c${i}`, `Kid ${i}`, 'new:r'))];
  const four = await counted(); const fourLines = await apply(four, tree(4));
  assert.equal(four.layouts, 0, 'four cards: no layout'); eq(four.focused, []); assert.ok(!fourLines.some(l => /Arranged the map automatically/.test(l.text)));
  const five = await counted(); const fiveLines = await apply(five, tree(5)); const root = five.view.map.nodes.find(n => !n.parentId);
  assert.equal(five.layouts, 1, 'five cards: exactly one layout'); eq(five.focused, [root.id]); assert.ok(fiveLines.some(l => l.status === 'done' && /Arranged the map automatically/.test(l.text)), JSON.stringify(fiveLines));
  assert.equal(fiveLines.at(-1).text, 'Arranged the map automatically after adding many topics', 'it comes after every card line');
  const explicit = await counted(); const explicitLines = await apply(explicit, [...tree(5), { kind: 'auto_layout' }]);
  assert.equal(explicit.layouts, 1, 'the reply\'s own auto_layout is the only one'); assert.equal(explicitLines.filter(l => /Arrange/.test(l.text)).length, 1);
  const skipped = await counted(); const skippedLines = await apply(skipped, [...tree(5).slice(0, 4), { kind: 'add_child', parentId: 'ghost', title: 'Lost', summary: '', ref: '' }, { kind: 'add_child', parentId: 'ghost', title: 'Lost 2', summary: '', ref: '' }]);
  assert.equal(skipped.layouts, 0, 'only cards that were really added count'); assert.ok(skippedLines.length >= 6);
});
