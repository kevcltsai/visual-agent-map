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
const outlineApi = load('experiences/visual-map/outline-import.ts', { obsidian });
const { aiModeOptions } = load('experiences/visual-map/ai-mode.ts');
const { chatResearchRequest } = load('core/map-chat-plan.ts');

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
  assert.equal(f.parts.stop().attrs['aria-label'], 'Stop'); assert.equal(f.parts.status().attrs.role, 'status'); assert.equal(f.parts.log().attrs.role, 'group', 'B1-ui: the log is a plain group, not role=log (which is live by itself)'); assert.equal(f.parts.log().attrs['aria-live'], undefined, 'B1-ui: no aria-live on the log while a reply streams');
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

async function harness({ aim = false, document = false, empty = false, realRender = false, viaSync = false } = {}) {
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
  const control = { reply: async () => ({ reply: 'ok', actions: [], rejected: [] }), requests: [], models: [], claudeReady: true, listeners: [], refreshes: [], usageAsks: 0, decline: false, nested: 0, mutates: 0, depth: 0, calls: [], markdown: [], searches: [], search: async () => [], probe: null };
  let queue = Promise.resolve();
  const ctx = {};
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), views: () => ctx.otherViews ?? [], logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), closeStaleDetails() {}, releaseOutline() {}, syncOutline() {}, setOutlineActive() {},
    pendingSuggestions: new Map(), pendingResearchOptions: new Map(), detailsShown: () => false, activeTasks: new Map(), quickExpandPending: new Set(), recordFailure: error => String(error?.message ?? error),
    // Like the real mutate: a promise queue that is not re-entrant. A call made from inside a running write waits for it, forever.
    mutate(work) {
      control.mutates++; if (control.depth > 0) control.nested++;
      const result = queue.then(async () => {
        control.depth++;
        try { await work(); const view = ctx.view; if (view) await (viaSync ? view.synchronize() : view.hydrate()); } finally { control.depth--; }
      });
      queue = result.catch(() => {});
      return result;
    },
    saveSettings: async () => { control.saves = (control.saves ?? 0) + 1; },
    availableModels: () => control.claudeReady ? ['gpt-6-luna', 'claude:sonnet', 'claude:haiku'] : ['gpt-6-luna'], modelLabel: id => `label(${id})`,
    subscribeModelDiscovery: listener => { control.listeners.push(listener); return () => { control.listeners.splice(control.listeners.indexOf(listener), 1); }; },
    refreshModelDiscovery: async provider => { control.refreshes.push(provider); return { provider, status: 'ready', models: [] }; },
    confirmAiUsage: async (model, run) => { control.usageAsks++; control.models.push(model); control.calls.push('confirm'); if (control.decline) return false; await run(); return true; },
    mapChat: { chat: async (request, signal, onReply) => { control.calls.push('chat'); control.requests.push(request); return control.reply(request, signal, onReply); } },
    // B3: the web image search of the Markdown quick action; the thumbnail check is stubbed on the view below.
    searchImages: async (query, model, signal) => { control.calls.push('search'); control.searches.push({ query, model, signal }); return control.search(query, model, signal); }
  });
  const leaves = []; let activeMarkdown = null;
  const handlers = []; const linkOpens = [];
  app.workspace = { getLeavesOfType: type => type === 'markdown' ? leaves : [], getActiveViewOfType: () => activeMarkdown, requestSaveLayout() {}, on(name, fn) { const ref = { name, fn }; handlers.push(ref); return ref; }, openLinkText(link, source, newLeaf) { linkOpens.push([link, source, newLeaf]); } };
  class Notice { constructor(message) { notices.push(message); } hide() {} }
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, MarkdownView, Notice, Modal: class { constructor(app) { this.app = app; } open() { (control.modals ??= []).push(this); if (typeof this.resolve === 'function' && this.local) this.resolve(this.local); } close() {} }, Component: class { load() {} unload() {} }, MarkdownRenderer: { render: async (_app, text, el, sourcePath, owner) => { control.markdown.push({ text, el, sourcePath, owner }); el.setText(text); } } } }, { ...(document ? { document: { documentElement: { style: {} }, get activeElement() { return ctx.page?.doc.activeElement ?? null; } } } : {}), CSS: { escape: value => String(value) }, createSvg: tag => ({ tag, attrs: {}, classes: [], setAttribute(name, value) { this.attrs[name] = value; }, addClass(name) { this.classes.push(name); } }), requestAnimationFrame: run => { run(); return 1; }, cancelAnimationFrame() {}, setTimeout: fn => { ctx.timers.push(fn); return ctx.timers.length; }, clearTimeout() {} });
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
  view.chatProbeImages = async (found, signal) => control.probe ? control.probe(found, signal) : found;
  let renders = 0;
  // `realRender` keeps the view's own render() (which can hold a repaint back) and counts the repaints it really makes.
  if (realRender) view.paint = () => { renders++; view.paintCount++; repaint(); };
  else view.render = () => { renders++; view.paintCount++; repaint(); };
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

integrationTest('map chat: ticket 09 - a tree reply where one subtopic has no summary still adds it; it keeps the placeholder and stays unresearched', async () => {
  const h = await harness(); await h.view.hydrate();
  const lines = await apply(h, [
    { kind: 'add_child', parentId: h.ids.b, title: 'Brewing', summary: 'How to brew', ref: 'n1' },
    { kind: 'add_child', parentId: 'new:n1', title: 'Grind', summary: 'Grind size by method', ref: 'n2' },
    { kind: 'add_child', parentId: 'new:n1', title: 'Water', summary: '', ref: 'n3' }
  ]);
  eq(lines.map(l => l.status), ['done', 'done', 'done'], JSON.stringify(lines));
  const { isPlaceholder } = load('repository.ts', { obsidian });
  const nodes = await h.saved();
  const notes = await Promise.all(nodes.map(n => h.repo.readNote(n.path)));
  const read = async title => { const note = notes.find(x => x.title === title); assert.ok(note, `${title} is on the saved map`); return note; };
  const brewing = await read('Brewing'), grind = await read('Grind'), water = await read('Water');
  assert.equal(brewing.summary, 'How to brew'); assert.equal(grind.summary, 'Grind size by method');
  assert.ok(isPlaceholder(water.summary) || water.summary.includes('No conclusion yet'), `Water keeps the placeholder: ${water.summary}`);
  eq([brewing.status, grind.status, water.status], ['idea', 'idea', 'idea']);
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
  h.view.chatExpand = async () => { proposed++; };
  const act = [{ kind: 'run_map_action', action: 'expand', nodeIds: [h.ids.a], title: '', goal: '', direction: '' }];
  h.control.decline = true;
  const declined = await apply(h, act); eq(declined.map(l => l.status), ['done']);
  for (let i = 0; i < 10; i++) await tick();
  eq(models, ['claude:opus'], 'asked once, for the card\'s own model, not the chat model'); assert.equal(proposed, 0, 'declined: the outline call never starts');
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

integrationTest('map chat: select_topics(all) then research_standard starts the research once on every topic (Quick when nothing names a mode), outside any mutate', async () => {
  const h = await harness(); await h.view.hydrate();
  const started = [];
  h.view.startMultiResearch = async request => { started.push({ request, selected: [...h.view.multiSelected], mutating: h.control.depth }); };
  h.control.mutates = 0;
  const lines = await apply(h, [
    { kind: 'select_topics', nodeIds: Object.values(h.ids), all: true },
    { kind: 'run_map_action', action: 'research_standard', nodeIds: [], title: '', goal: '', direction: '' }
  ]);
  eq(lines.map(l => l.status), ['done', 'done']); await tick();
  assert.equal(started.length, 1); eq(started[0].request, quickRequest, 'no mode named and the map remembers none: Quick (D-2026-10-228)');
  eq(started[0].selected.sort(), Object.values(h.ids).sort()); assert.equal(started[0].mutating, 0, 'not inside a mutate');
  assert.equal(h.view.integrationMode, true); assert.equal(h.control.mutates, 0, 'selecting and starting research write nothing through the queue');
});

integrationTest('map chat: the result rows name the mode the research really runs in, and the expand row says the subtopics are created directly', async () => {
  const h = await harness(); await h.view.hydrate();
  const research = mode => ({ kind: 'run_map_action', action: 'research_standard', nodeIds: [h.ids.a], title: '', goal: '', direction: '', mode });
  delete h.view.map.aiMode;
  assert.equal(h.view.chatActionLabel(research('')), 'Start quick research on the selected topics', 'no mode named, none remembered: Quick');
  assert.equal(h.view.chatActionLabel(research('standard')), 'Start standard research on the selected topics');
  h.view.map.aiMode = 'standard';
  assert.equal(h.view.chatActionLabel(research('')), 'Start standard research on the selected topics', 'the remembered mode');
  assert.equal(h.view.chatActionLabel(research('quick')), 'Start quick research on the selected topics', 'the named mode wins');
  const expand = h.view.chatActionLabel({ kind: 'run_map_action', action: 'expand', nodeIds: [h.ids.a, h.ids.b], title: '', goal: '', direction: '' });
  assert.equal(expand, 'Expand subtopics for 2 topics'); assert.equal(/suggest/i.test(expand), false);
});

integrationTest('map chat: research on named topics selects exactly those first', async () => {
  const h = await harness(); await h.view.hydrate(); const seen = [];
  h.view.startMultiResearch = async () => { seen.push([...h.view.multiSelected]); };
  await apply(h, [{ kind: 'run_map_action', action: 'research_standard', nodeIds: [h.ids.a, h.ids.b], title: '', goal: '', direction: '' }]); await tick();
  eq(seen, [[h.ids.a, h.ids.b]]);
});

integrationTest('map chat: expand is the multi-level outline expansion (2 levels, at most 15 topics), every topic is added without a review window, the new topics are Quick (research-mode local), and a nested mutate inside it does not deadlock', async () => {
  const h = await harness(); await h.view.hydrate();
  const outline = ['# Body', ...Array.from({ length: 10 }, (_, i) => `## Part ${i}\n### Detail ${i}\n#### Too deep ${i}`)].join('\n');
  const requests = [];
  const modalsBefore = (h.control.modals ?? []).length;
  h.plugin.outlineGeneration = { generate: async (request, signal) => { requests.push({ request, aborted: signal.aborted }); await h.plugin.mutate(async () => {}); return { markdown: outline, nodes: outlineApi.parseOutline(outline).nodes }; } };
  h.view.openChildSuggestions = () => assert.fail('the review window must not open'); h.view.proposeChildren = () => assert.fail('the guided proposal path is not used');
  const before = (await h.saved()).length;
  const lines = await withTimeout(apply(h, [{ kind: 'run_map_action', action: 'expand', nodeIds: [h.ids.a], title: '', goal: '', direction: 'sleep hygiene' }]));
  eq(lines.map(l => l.status), ['done']);
  await withTimeout(until(() => h.plugin.running.size === 0 && requests.length === 1 && h.plugin.activeTasks.size === 0), 4000);
  eq(requests.map(r => [r.request.limits, r.request.topic, r.request.presetText.endsWith('\n\nsleep hygiene'), r.aborted]), [[{ levels: 2, maxTopics: 15 }, 'Body', true, false]]);
  const created = (await h.saved()).filter(n => ![h.ids.root, h.ids.a, h.ids.b, h.ids.c].includes(n.id));
  assert.equal(before + created.length, (await h.saved()).length);
  assert.equal(created.length, 15, 'the outline has 30 headings: the first 2 levels are 20 topics, kept up to the 15-topic limit');
  const titles = await Promise.all(created.map(async n => (await h.repo.readNote(n.path)).title));
  assert.ok(!titles.some(t => t.startsWith('Too deep')), 'a third level is dropped');
  assert.equal(created.filter(n => n.parentId === h.ids.a).length, 10, 'the first level sits under the card');
  for (const node of created) assert.equal((await h.repo.readNote(node.path)).researchMode, 'local', 'new topics are Quick');
  assert.equal(h.control.nested, 0); assert.equal(h.plugin.running.size, 0, 'the card is released'); assert.equal((h.control.modals ?? []).length, modalsBefore, 'no review dialog');
});
integrationTest('map chat: expand with an outline that has nothing below the root writes nothing and says so; Stop before the answer writes nothing', async () => {
  const h = await harness(); await h.view.hydrate();
  h.plugin.outlineGeneration = { generate: async () => ({ markdown: '# Body', nodes: outlineApi.parseOutline('# Body').nodes }) };
  const before = (await h.saved()).length;
  await apply(h, [{ kind: 'run_map_action', action: 'expand', nodeIds: [h.ids.a], title: '', goal: '', direction: '' }]);
  await withTimeout(until(() => h.plugin.running.size === 0 && h.notices.length > 0), 4000);
  assert.equal((await h.saved()).length, before); assert.match(h.notices.at(-1), /does not recommend/i);
  const gate = deferred(); let signal;
  h.plugin.outlineGeneration = { generate: async (_r, s2) => { signal = s2; await gate.promise; return { markdown: '# Body\n## X', nodes: outlineApi.parseOutline('# Body\n## X').nodes }; } };
  await apply(h, [{ kind: 'run_map_action', action: 'expand', nodeIds: [h.ids.a], title: '', goal: '', direction: '' }]);
  await withTimeout(until(() => h.plugin.activeTasks.has(h.view.map.nodes.find(n => n.id === h.ids.a).path)), 2000);
  h.plugin.activeTasks.get(h.view.map.nodes.find(n => n.id === h.ids.a).path).abort(); gate.resolve();
  await withTimeout(until(() => h.plugin.running.size === 0), 4000);
  assert.equal(signal.aborted, true); assert.equal((await h.saved()).length, before, 'a stopped expand adds nothing');
});

integrationTest('map chat: control - the same nested mutate really does hang when it is made from inside a write', async () => {
  const h = await harness();
  const nested = h.plugin.mutate(async () => { await h.plugin.mutate(async () => {}); });
  await assert.rejects(withTimeout(nested, 150), /timed out/);
  assert.equal(h.control.nested, 1, 'the harness counts the nested call, so a nested write would also fail the other tests');
});

integrationTest('map chat: synthesize of several cards starts the selection integration without a dialog; rate_by_goal and merge start their own task', async () => {
  const h = await harness(); await h.view.hydrate();
  const opened = []; h.view.openSelectionSynthesis = pending => opened.push(pending);
  const starts = []; h.view.startSelectionSynthesis = async (nodes, options, direction, failed, accepted) => { starts.push({ ids: nodes.map(n => n.id).sort(), options, direction, failed: typeof failed, depth: h.control.depth }); accepted(); };
  const goals = []; h.view.relevanceGradeable = () => true; h.view.submitRelevanceGoal = async goal => { goals.push(goal); };
  const merges = []; h.view.mergeSelected = async (title, snapshot) => { merges.push([title, snapshot.sources.map(s => s.id).sort(), h.control.depth]); };
  const lines = await withTimeout(h.view.applyMapChatActions({ message: 'Compare them', rejected: [], actions: [
    { kind: 'run_map_action', action: 'synthesize', nodeIds: [h.ids.a, h.ids.b], title: '', goal: '', direction: '' },
    { kind: 'run_map_action', action: 'rate_by_goal', nodeIds: [], title: '', goal: ' Sleep better ', direction: '' },
    { kind: 'run_map_action', action: 'merge', nodeIds: [h.ids.a, h.ids.b], title: 'Body and mind', goal: '', direction: '' }
  ] }, { mdHashes: {}, topicHashes: topicBaseline(h) }));
  eq(lines.filter(l => l.text !== NOT_UNDOABLE).map(l => l.status), ['done', 'done', 'done'], JSON.stringify(lines)); await tick();
  eq(opened, [], 'B2: no dialog opens'); eq(goals, ['Sleep better']);
  assert.equal(starts.length, 1); eq(starts[0].ids, [h.ids.a, h.ids.b].sort()); assert.equal(starts[0].direction, 'Compare them', 'the user\'s message is the direction'); assert.equal(starts[0].depth, 0, 'not inside a mutate');
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
    { kind: 'run_map_action', action: 'synthesize', nodeIds: [plain.ids.b], title: '', goal: '', direction: '' },
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
  h.view.builtIn = true; h.type('three'); await h.view.sendMapChat();
  // B1-ui: the read-only sample is the opening screen now; a message from it is sent, and tells the model there is no map to edit.
  assert.equal(h.control.requests.length, 2); assert.equal(h.control.requests[1].context.noEditableMap, true);
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
  assert.ok(find(h.rootEl, i => i === el), 'the panel is back in the page'); assert.equal(h.workspace().children[0], el, 'B1-ui: it is the first child of the workspace, left of the canvas'); assert.ok(h.workspace().classes.includes('has-map-chat-open'));
  chat.setOpen(false); assert.ok(!h.workspace().classes.includes('has-map-chat-open'), 'the selection bar and hint get their room back');
  h.repaint(); assert.ok(!h.workspace().classes.includes('has-map-chat-open'));
  assert.equal(find(find(h.rootEl, i => hasClass(i, 'vam-canvas-overlay')), i => i === el), undefined, 'B1-ui: the overlay covers the canvas only; the window is not in it');
});

integrationTest('map chat: repaints caused by the chat\'s own writes keep the conversation going', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  chat.inputEl.focus(); h.control.reply = async () => ({ reply: 'done', actions: [{ kind: 'add_child', parentId: h.ids.a, title: 'New one', summary: '' }], rejected: [] });
  h.type('add'); const renders = h.renders(); await h.view.sendMapChat();
  assert.ok(h.renders() > renders, 'the map repainted while the answer was being applied');
  assert.equal(chat.transcript().at(-1).text, 'done'); assert.ok(find(h.rootEl, i => i === chat.el));
});

integrationTest('map chat: a different map starts a new conversation, and the sample map has the panel too (B1-ui)', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  chat.begin('old'); chat.finish('old answer', []); chat.addTopicReference(h.ids.a);
  h.view.map.id = 'another-map'; h.repaint();
  assert.equal(chat.transcript().length, 0); assert.equal(chat.attachments().length, 0);
  chat.begin('x'); chat.finish('y', []);
  h.view.builtIn = true; h.repaint(); assert.ok(find(h.rootEl, i => i === chat.el) && chat.isHero === false, 'B1-ui: the read-only sample keeps the conversation it had (side window); a fresh one shows the opening screen');
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
  assert.equal(chat.modelEl.children[0].text, 'Default: label(gpt-6-luna)', 'the shown label (shortened so it fits 340px) follows cliModel when the window is opened');
  assert.equal(chat.modelEl.children[0].attrs.title, 'Follow default (now: label(gpt-6-luna))', 'the full wording is its tooltip'); assert.equal(chat.modelEl.attrs.title, 'Follow default (now: label(gpt-6-luna))', 'and the select names it too');
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

// Time limits for hostile input are relative: the hostile text is laid out HOSTILE_REPEATS times and so is benign text of the same length, in the same process, and the two totals are compared. A slow machine moves both sides.
// The repeats make the benign total large enough (tens of ms) that timer resolution and scheduling noise do not move the ratio; no floor is needed.
// Before the fix the hostile layouts took 1100 to 5300 ms each against about 0.4 ms for benign text: a ratio above 2000. Measured now (best of 3 per side): ratios up to about 65 (5 runs, loaded machine).
// The limit is about 3 times the largest measured ratio and far below the old one; it catches a return to quadratic work, not a small slowdown.
const HOSTILE_REPEATS = 80; const HOSTILE_RATIO_LIMIT = 200;
const blockTime = (text) => { const t = process.hrtime.bigint(); for (let i = 0; i < HOSTILE_REPEATS; i++) lay(text); return Number(process.hrtime.bigint() - t) / 1e6; };
const bestBlock = (text, count = 3) => { let min = Infinity; for (let i = 0; i < count; i++) min = Math.min(min, blockTime(text)); return min; };
const benignOf = (text) => 'word '.repeat(Math.ceil(text.length / 5)).slice(0, text.length);
const hostileRatio = (text) => { const base = bestBlock(benignOf(text)); const ms = bestBlock(text, 2); return { ms, base, ratio: ms / base }; };
const ratioNote = (r) => `${r.ms.toFixed(0)} ms is ${r.ratio.toFixed(1)} times benign text (${r.base.toFixed(0)} ms) for ${HOSTILE_REPEATS} layouts`;
test('map chat D5 F2: a heading line with a long run of blanks parses in a small multiple of benign text of the same length', () => {
  for (const text of ['# a' + ' '.repeat(40000) + 'x', '# a' + ' \t'.repeat(20000) + 'x', '#' + ' '.repeat(40000) + 'x #']) {
    const r = hostileRatio(text); console.log(`F2 ratio ${r.ratio.toFixed(1)}, benign total ${r.base.toFixed(1)} ms`); assert.ok(r.ratio <= HOSTILE_RATIO_LIMIT, `${ratioNote(r)} for ${text.length} characters`);
  }
  eq(visibleText(lay('## Title ##  ')), 'Title'); eq(visibleText(lay('# C#')), 'C#'); eq(visibleText(lay('# a #b')), 'a #b');
});

test('map chat D5 F3: unmatched openers parse in a small multiple of benign text of the same length, and a reply over 50,000 characters is laid out only up to that', () => {
  for (const [name, unit] of [['star', 'a *'], ['bracket', '['], ['wiki', '[[a'], ['underscore', 'a _b'], ['link', '[a]('], ['image', '![a](']]) {
    const text = unit.repeat(Math.ceil(40000 / unit.length)); const r = hostileRatio(text);
    console.log(`F3 ${name} ratio ${r.ratio.toFixed(1)}, benign total ${r.base.toFixed(1)} ms`); assert.ok(r.ratio <= HOSTILE_RATIO_LIMIT, `${name}: ${ratioNote(r)}`);
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
// A reply just over the element budget (core/map-chat-render.ts:41 MAX_REPLY_NODES): DENSE builds 4 elements per copy, plus 100 copies of margin.
const DENSE_OVER_BUDGET = DENSE.repeat(Math.ceil(load('core/map-chat-render.ts').MAX_REPLY_NODES / 4) + 100);

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
  const text = DENSE_OVER_BUDGET + 'THE END'; const el = layoutWith(text);
  const count = nodes(el).length - 1;
  assert.ok(count <= MAX_REPLY_NODES + FIXED, `${count} elements`);
  const plain = find(el, i => hasClass(i, 'vam-map-chat-plain')); const note = find(el, i => hasClass(i, 'vam-map-chat-overflow-note'));
  assert.ok(plain && note); assert.equal(note.text, 'NOTE'); assert.ok(plain.text.endsWith('THE END'), 'the end of the reply is there');
  assert.ok(plain.text.includes('*emph* **b** `c` [[x]]'), 'the markup is shown as it was written');
  assert.equal(findAll(plain, () => true).length, 1, 'one block, no children');
  assert.ok(el.children.indexOf(note) < el.children.indexOf(plain));
  assert.equal(nodes(el).filter(i => i.tag === 'a').length > 0, true, 'the start is still laid out');
});
test('map chat E1: a streamed reply past the element budget builds at most the budget while streaming and after finish (counted, not timed)', () => {
  const { MAX_REPLY_NODES } = load('core/map-chat-render.ts');
  const clock = frames(); const f = panelFixture({}, clock.window); f.panel.setOpen(true); const log = f.parts.log();
  const text = DENSE_OVER_BUDGET + 'THE END';
  const check = when => {
    const body = replyBody2(log); const count = nodes(body).length - 1; assert.ok(count <= MAX_REPLY_NODES + FIXED, `${when}: ${count} elements`);
    assert.ok(find(body, i => hasClass(i, 'vam-map-chat-plain')), `${when}: the rest is plain text`); assert.ok(find(body, i => hasClass(i, 'vam-map-chat-overflow-note')), `${when}: with the note`);
  };
  f.panel.begin('q'); f.panel.streamReply(text); clock.run(); check('streaming');
  f.panel.finish(text, []); check('finished');
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
  const noNote = element('div'); renderChatMarkdown(noNote, DENSE_OVER_BUDGET); assert.equal(find(noNote, i => hasClass(i, 'vam-map-chat-overflow-note')), undefined, 'no note is made without text for it');
});
test('map chat E1: the panel gives the note in the reader\'s language, and all three languages have it', () => {
  const f = panelFixture(); f.panel.setOpen(true); f.panel.begin('q'); f.panel.finish(DENSE_OVER_BUDGET, []);
  const note = find(f.parts.log(), i => hasClass(i, 'vam-map-chat-overflow-note')); assert.ok(note); assert.match(note.text, /too long/i);
  for (const lang of ['en', 'zh-TW', 'zh-CN']) assert.match(fs.readFileSync(path.join(root, 'i18n', `${lang}.ts`), 'utf8'), /"ui\.map_chat_overflow_note": "[^"]+"/, lang);
});
test('map chat E1: long dense replies streamed in bursts of chunks, then a short reply, lay out in a small multiple of one parse', () => {
  const dense = DENSE.repeat(1850); const short = 'word '.repeat(400);
  const once = run => { const start = process.hrtime.bigint(); run(); return Number(process.hrtime.bigint() - start) / 1e6; };
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
  // The bound is relative, measured in this process: one inline parse of the head of the same dense reply is the unit (it does not depend on the element budget).
  // Each round times the unit as the mean of ten parses right before the streamed run, so both sides see the same machine load; a best-of-N unit would find a quiet 4 ms slice that a 1 s run never gets under load.
  const { parseInline } = load('core/map-chat-render.ts');
  const round = () => { const unit = once(() => { for (let i = 0; i < 10; i++) parseInline(dense.slice(0, 50000)); }) / 10; const ms = once(streamed); return { ms, unit, ratio: ms / unit }; };
  const { ms, unit, ratio } = Array.from({ length: 5 }, round).sort((a, b) => a.ratio - b.ratio)[2]; // the median round
  console.log(`E1 timing: ${ms.toFixed(0)} ms for the streamed run, ${unit.toFixed(1)} ms for one parse, ratio ${ratio.toFixed(1)}`);
  assert.ok(ratio <= STREAM_RATIO_LIMIT, `${ms.toFixed(0)} ms is ${ratio.toFixed(1)} times one parse (${unit.toFixed(1)} ms)`);
});
test('map chat E1: chunks that arrive within one frame are laid out once, with the newest text (counted layouts, not time)', () => {
  const clock = frames(); const f = panelFixture({}, clock.window); f.panel.setOpen(true); const log = f.parts.log();
  f.panel.begin('q');
  const body = find(log.children.at(-1), i => hasClass(i, 'vam-map-chat-text')); assert.ok(body, 'the streaming answer has its text element');
  let layouts = 0; const empty = body.empty.bind(body); body.empty = () => { layouts++; empty(); };
  const text = DENSE.repeat(200);
  for (let i = 1; i <= 30; i++) f.panel.streamReply(text.slice(0, Math.ceil(text.length * i / 30)));
  assert.equal(layouts, 0, '30 chunks inside one frame lay nothing out before the frame');
  assert.equal(clock.run(), 1, 'one frame was asked for, not one per chunk');
  assert.equal(layouts, 1, 'the frame lays the message out once');
  for (let round = 0; round < 4; round++) { f.panel.streamReply(text); f.panel.streamReply(text + ' more'); clock.run(); }
  assert.equal(layouts, 5, 'one layout per frame');
});
// Ratio of the streamed run to one inline parse (unit = mean of ten parses, about 45 ms in one timed block; median of five paired rounds).
// This is a coarse net for an unforeseen large slowdown (the whole run about 8 times the work or more), not for a small one: unchanged code moves by about
// 2 times with machine load alone (unmodified 190 to 200 quiet, 128 to 142 at load 4, 105 to 125 with three busy loops per core).
// The known regressions are counted instead: the element budget by 'a reply past the element budget builds at most the budget' and 'a streamed reply past
// the element budget builds at most the budget', frame coalescing by 'chunks that arrive within one frame are laid out once', the row cache by
// 'a finished message keeps its row on every later repaint', and one parse per reply by 'E2: the cut is found while parsing'.
// Every layout done 20 times over (empty, parse and build): 2330 to 2470 at load 4, 2190 to 3250 with one busy loop per core. The limit is 4 times the largest unchanged ratio.
const STREAM_RATIO_LIMIT = 800;

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
  f.setLanguage('en'); f.panel.begin('q'); f.panel.finish(DENSE_OVER_BUDGET, []);
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
integrationTest('hypothesis-evidence: delete_topic from the map chat removes the evidence and prerequisite links of the removed cards (branch false and true); other links stay', async () => {
  for (const branch of [false, true]) {
    const h = await harness();
    const keep = { kind: 'prerequisite', from: h.ids.root, to: h.ids.b };
    h.view.map.topicRelations = [
      { kind: 'supports', from: h.ids.c, to: h.ids.b }, { kind: 'prerequisite', from: h.ids.a, to: h.ids.c }, { kind: 'supports', from: h.ids.a, to: h.ids.b }, { kind: 'prerequisite', from: h.ids.b, to: h.ids.a }, keep
    ];
    await h.repo.saveMap(MAP, h.view.map); h.view.map = await h.repo.readMap(MAP);
    const lines = await apply(h, [{ kind: 'delete_topic', nodeId: h.ids.a, branch }]);
    eq(lines.map(l => l.status), ['done'], `branch ${branch}: ${JSON.stringify(lines)}`);
    const saved = await h.repo.readMap(MAP);
    assert.equal(saved.nodes.some(n => n.id === h.ids.a), false, `branch ${branch}: the card is gone`);
    assert.equal(saved.nodes.some(n => n.id === h.ids.c), !branch, `branch ${branch}: the subtopic goes only with the branch`);
    const expected = branch ? [keep] : [{ kind: 'supports', from: h.ids.c, to: h.ids.b }, keep];
    eq(saved.topicRelations, expected, `branch ${branch}: links touching a removed card are gone, the others stay`);
    assert.equal(h.view.history.undoEntry, undefined, `branch ${branch}: a chat write leaves no undo entry (nothing to undo)`);
  }
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

// ---- first window, UI (B1-ui) ---------------------------------------------------------------------------------------
// The DOM here is the small stand-in of support-dom: structure, state and events are real, geometry and pixels are not
// (those are the tester's, in Obsidian). A document stand-in counts listeners so a leak shows as a number.
const counting = () => {
  const listeners = {}; const doc = { activeElement: null, body: null };
  doc.addEventListener = (name, fn) => { (listeners[name] ??= []).push(fn); };
  doc.removeEventListener = (name, fn) => { listeners[name] = (listeners[name] ?? []).filter(f => f !== fn); };
  doc.count = () => Object.values(listeners).reduce((sum, list) => sum + list.length, 0);
  doc.fire = (name, event) => { for (const fn of [...(listeners[name] ?? [])]) fn({ preventDefault() {}, buttons: 1, ...event }); };
  return doc;
};
const press = (el, event) => { let prevented = false; el.fire('keydown', { preventDefault() { prevented = true; }, shiftKey: false, isComposing: false, ...event }); return prevented; };
const resizerOf = chat => chat.resizerEl;
const suggestionTexts = chat => findAll(chat.suggestEl, i => i.tag === 'button').map(i => i.text);
const layoutModule = () => load('core/map-chat-layout.ts');

test('B1 ui: the width is 340 by default, 280 to 560 at most, whole numbers, and anything unreadable is the default', () => {
  const { clampMapChatWidth, MAP_CHAT_WIDTH_DEFAULT } = layoutModule();
  assert.equal(MAP_CHAT_WIDTH_DEFAULT, 340); assert.equal(clampMapChatWidth(undefined), 340); assert.equal(clampMapChatWidth('300'), 340); assert.equal(clampMapChatWidth(NaN), 340);
  assert.equal(clampMapChatWidth(279), 280); assert.equal(clampMapChatWidth(280), 280); assert.equal(clampMapChatWidth(560), 560); assert.equal(clampMapChatWidth(561), 560); assert.equal(clampMapChatWidth(300.6), 301);
});

test('B1 ui: saved width and open state are sanitised on load; an old data.json without them gets the defaults', () => {
  const { settingsFromSaved } = load('main.ts', { obsidian: { ...obsidian, MarkdownView } });
  const none = settingsFromSaved(null); assert.equal(none.mapChatWidth, 340); assert.equal(none.mapChatOpen, true);
  const old = settingsFromSaved({ mapChatStyle: 'concise' }); assert.equal(old.mapChatWidth, 340); assert.equal(old.mapChatOpen, true);
  const bad = settingsFromSaved({ mapChatWidth: 9000, mapChatOpen: 'no' }); assert.equal(bad.mapChatWidth, 560); assert.equal(bad.mapChatOpen, true);
  const low = settingsFromSaved({ mapChatWidth: -4, mapChatOpen: false }); assert.equal(low.mapChatWidth, 280); assert.equal(low.mapChatOpen, false);
  const text = settingsFromSaved({ mapChatWidth: 'wide' }); assert.equal(text.mapChatWidth, 340);
});

test('B1 fix 13: the window folds to a narrow edge only when even 280px would leave the canvas under 360px (pane under 640); the set width and the current canvas do not matter', () => {
  const { isChatNarrow, chatDockedWidth, chatOverlayWidth } = layoutModule();
  assert.equal(isChatNarrow(640), false, '280 + 360 fits'); assert.equal(isChatNarrow(639), true, 'one pixel less does not');
  // The old rule folded at 1039 with the default width; panes between 640 and 1039 now dock.
  for (const pane of [640, 700, 796, 1039, 1100, 1440]) assert.equal(isChatNarrow(pane), false, `${pane} docks`);
  // The sample's inspector takes its width from the canvas.
  assert.equal(isChatNarrow(940, 300), false); assert.equal(isChatNarrow(939, 300), true);
  // A folded window stays folded until the pane is a little wider than the limit; an unfolded one stays unfolded down to the limit.
  assert.equal(isChatNarrow(645, 0, true), true, 'inside the margin a folded window stays folded'); assert.equal(isChatNarrow(664, 0, true), false);
  assert.equal(isChatNarrow(645, 0, false), false, 'a docked window does not fold inside the margin');
  const walk = []; let state = false; for (let pane = 700; pane >= 600; pane--) { state = isChatNarrow(pane, 0, state); walk.push(state); } for (let pane = 600; pane <= 700; pane++) { state = isChatNarrow(pane, 0, state); walk.push(state); }
  const flips = walk.filter((value, index) => index && value !== walk[index - 1]).length; assert.equal(flips, 2, 'down once, up once: no flicker on the limit');
  // The docked width gives way down to 280; the width laid over a narrow pane leaves 160px of the pane.
  assert.equal(chatDockedWidth(1100, 340), 340); assert.equal(chatDockedWidth(640, 340), 280); assert.equal(chatDockedWidth(700, 560), 340, 'the set width is never written back, only given way to'); assert.equal(chatDockedWidth(800, 340, 300), 280);
  assert.equal(chatOverlayWidth(600, 340), 340); assert.equal(chatOverlayWidth(456, 340), 296); assert.equal(chatOverlayWidth(380, 340), 280, 'never under 280');
});

integrationTest('B1 fix 13: a pane of 640 or more docks the window (at the width the pane allows); a pane under 640 folds it; the set width stays as the user set it', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); h.plugin.settings.mapChatWidth = 340;
  h.rootEl.clientWidth = 700; h.view.onResize(); assert.equal(chat.isNarrow, false); assert.equal(chat.el.style.width, '340px', 'the canvas keeps 360');
  h.rootEl.clientWidth = 640; h.view.onResize(); assert.equal(chat.isNarrow, false); assert.equal(chat.el.style.width, '280px', 'the window gave way to keep 360 for the canvas'); assert.equal(h.plugin.settings.mapChatWidth, 340, 'the set width is untouched');
  h.rootEl.clientWidth = 639; h.view.onResize(); assert.equal(chat.isNarrow, true);
  h.rootEl.clientWidth = 650; h.view.onResize(); assert.equal(chat.isNarrow, true, 'folded stays folded inside the margin');
  h.rootEl.clientWidth = 700; h.view.onResize(); assert.equal(chat.isNarrow, false);
  h.rootEl.clientWidth = 1100; h.view.onResize(); assert.equal(chat.el.style.width, '340px', 'wide again: the set width');
  const states = []; for (let i = 0; i < 4; i++) { h.rootEl.clientWidth = 639; h.view.onResize(); states.push(chat.isNarrow); h.repaint(); states.push(chat.isNarrow); }
  eq(states, Array(8).fill(true), 'folded and stays folded however often it is looked at, though the canvas got wider when it folded');
  // Dragging the width: the keys move the SET width from what the window shows.
  h.rootEl.clientWidth = 1100; h.view.onResize(); chat.resizerEl.fire('keydown', { key: 'ArrowRight' }); assert.equal(h.plugin.settings.mapChatWidth, 356); assert.equal(chat.isNarrow, false);
});

integrationTest('B1 ui: a narrow pane shows only the edge button with an unread dot; a click opens the window over the canvas; Escape and a press on the canvas fold it back; nothing is forgotten', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); h.rootEl.clientWidth = 600; h.view.onResize();
  assert.equal(chat.isNarrow, true); assert.equal(chat.isOpen, false); assert.ok(chat.el.hasClass('is-rail')); assert.equal(chat.bodyEl.hidden, true); assert.equal(chat.toggleEl.hidden, false);
  chat.begin('q'); chat.finish('a reply while folded', []);
  assert.equal(chat.toggleEl.hasClass('has-unread'), true, 'the edge says there is something new'); assert.equal(chat.toggleEl.attrs['aria-label'], 'Open AI chat (new reply)');
  chat.toggleEl.click();
  assert.equal(chat.isOpen, true); assert.ok(chat.el.hasClass('is-overlay')); assert.equal(chat.toggleEl.hasClass('has-unread'), false, 'seen'); assert.equal(h.page.doc.activeElement, chat.inputEl);
  assert.equal(chat.wantsOpen, true, 'the user still wants it open');
  press(chat.inputEl, { key: 'Escape' }); assert.equal(chat.isOpen, false); assert.equal(chat.wantsOpen, true, 'folding the overlay is not closing the window'); assert.equal(h.page.doc.activeElement, chat.toggleEl);
  chat.toggleEl.click(); chat.collapseOverlay(); assert.equal(chat.isOpen, false, 'a press on the canvas folds it');
  h.rootEl.clientWidth = 1400; h.view.onResize(); assert.equal(chat.isOpen, true, 'wide again: docked as the user left it'); assert.ok(chat.el.hasClass('is-docked'));
  assert.equal(chat.transcript().length, 2, 'the conversation is untouched');
});

integrationTest('B1 ui: the window is the first child of the workspace, before the canvas, and the width, open state and a drag survive a repaint', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  assert.equal(h.workspace().children[0], chat.el, 'first child'); assert.ok(hasClass(h.workspace().children[1], 'vam-canvas-overlay') || h.workspace().children.length >= 2);
  assert.equal(chat.el.style.width, '340px', 'default width');
  chat.resizerEl.fire('keydown', { key: 'ArrowRight' }); assert.equal(chat.el.style.width, '356px'); assert.equal(chat.resizerEl.attrs['aria-valuenow'], '356');
  assert.equal(h.plugin.settings.mapChatWidth, 356, 'remembered'); assert.ok(h.control.saves > 0, 'and saved');
  h.repaint(); assert.equal(chat.el.style.width, '356px', 'a repaint keeps it'); assert.equal(h.workspace().children[0], chat.el);
});

integrationTest('B1 ui: the width handle is a labelled separator that moves 16px per arrow key, stops at 280 and 560, and Home/End jump to them', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); const bar = resizerOf(chat);
  assert.equal(bar.attrs.role, 'separator'); assert.equal(bar.attrs['aria-orientation'], 'vertical'); assert.equal(bar.attrs['aria-valuemin'], '280'); assert.equal(bar.attrs['aria-valuemax'], '560'); assert.equal(bar.attrs['aria-valuenow'], '340'); assert.equal(bar.attrs.tabindex, '0'); assert.ok(bar.attrs['aria-label']);
  assert.equal(press(bar, { key: 'ArrowLeft' }), true); assert.equal(bar.attrs['aria-valuenow'], '324'); press(bar, { key: 'ArrowRight' }); press(bar, { key: 'ArrowRight' }); assert.equal(bar.attrs['aria-valuenow'], '356');
  press(bar, { key: 'End' }); assert.equal(bar.attrs['aria-valuenow'], '560'); press(bar, { key: 'ArrowRight' }); assert.equal(bar.attrs['aria-valuenow'], '560', 'not past the maximum');
  press(bar, { key: 'Home' }); assert.equal(bar.attrs['aria-valuenow'], '280'); press(bar, { key: 'ArrowLeft' }); assert.equal(bar.attrs['aria-valuenow'], '280', 'not under the minimum');
  assert.equal(press(bar, { key: 'a' }), false, 'other keys are left alone');
});

integrationTest('B1 ui: dragging the handle follows the pointer, is saved when the button is let go, and leaves no listener on the document; a repaint in the middle does not break it', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); const doc = counting(); chat.el.ownerDocument = doc;
  const before = doc.count(); const saves = h.control.saves ?? 0;
  chat.resizerEl.fire('pointerdown', { button: 0, clientX: 340, pointerId: 1 });
  assert.ok(doc.count() > before, 'listeners are on the document while dragging');
  doc.fire('pointermove', { clientX: 400 }); assert.equal(chat.el.style.width, '400px');
  assert.equal(h.control.saves ?? 0, saves, 'nothing is saved mid-drag');
  h.repaint(); chat.el.ownerDocument = doc; // the panel is lifted out and put back
  doc.fire('pointermove', { clientX: 450 }); assert.equal(chat.el.style.width, '450px', 'the drag survives the repaint');
  doc.fire('pointermove', { clientX: 900 }); assert.equal(chat.el.style.width, '560px', 'clamped');
  doc.fire('pointerup', {}); assert.equal(doc.count(), before, 'let go: back to the listeners it began with'); assert.equal(h.plugin.settings.mapChatWidth, 560);
  doc.fire('pointermove', { clientX: 100 }); assert.equal(chat.el.style.width, '560px', 'and the pointer no longer drags');
});

integrationTest('B1 ui: closing the view in the middle of a drag, a lost pointer capture, and a move with no button all end the drag; the document listener count returns to the value it had', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); const doc = counting(); chat.el.ownerDocument = doc; const before = doc.count();
  chat.resizerEl.fire('pointerdown', { button: 0, clientX: 340, pointerId: 1 }); chat.dispose(); assert.equal(doc.count(), before, 'view closed');
  chat.resizerEl.fire('pointerdown', { button: 0, clientX: 340, pointerId: 1 }); chat.resizerEl.fire('lostpointercapture', {}); assert.equal(doc.count(), before, 'capture lost');
  chat.resizerEl.fire('pointerdown', { button: 0, clientX: 340, pointerId: 1 }); doc.fire('pointermove', { clientX: 380, buttons: 0 }); assert.equal(doc.count(), before, 'the button was let go outside the page');
  chat.resizerEl.fire('pointerdown', { button: 2, clientX: 340, pointerId: 1 }); assert.equal(doc.count(), before, 'only the primary button drags');
  for (let i = 0; i < 5; i++) { chat.resizerEl.fire('pointerdown', { button: 0, clientX: 340, pointerId: 1 }); doc.fire('pointerup', {}); } assert.equal(doc.count(), before, 'repeated drags leak nothing');
});

integrationTest('B1 ui: the real view close path disposes the panel (the drag listeners go with it)', async () => {
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  const close = source.slice(source.indexOf('  async onClose(): Promise<void> {'), source.indexOf('  async onClose(): Promise<void> {') + 2500);
  assert.match(close, /this\.chat\?\.dispose\(\)/);
});

// ---- opening screen ----------------------------------------------------------------------------------------------

integrationTest('B1 ui: an empty map shows the opening screen: the question, the message field and exactly three examples; the window is not docked', async () => {
  const h = await harness({ empty: true }); await h.view.hydrate(); h.repaint(); const chat = h.view.chat;
  assert.equal(chat.isHero, true); assert.ok(chat.el.hasClass('is-hero')); assert.equal(chat.isOpen, true);
  assert.equal(chat.heroTitleEl.text, 'What do you want to research or organize?'); assert.equal(chat.heroTitleEl.hidden, false); assert.equal(chat.heroTitleEl.attrs.role, 'heading');
  const slot = find(h.rootEl, i => hasClass(i, 'vam-chat-hero-slot')); assert.ok(slot && find(slot, i => i === chat.el), 'in the middle of the canvas overlay');
  assert.equal(find(h.workspace(), i => i === chat.el) !== undefined, true);
  assert.equal(findAll(chat.suggestEl, i => i.tag === 'button').length, 3, 'three examples'); assert.ok(chat.suggestEl.hasClass('is-examples'));
  eq(suggestionTexts(chat), ['Research the coffee industry: players, supply chain, trends', 'Plan a three-month route to learn basic Japanese', 'Compare renting and buying a home: costs, risks, timing']);
  assert.equal(chat.resizerEl.hidden, true, 'no width handle on the opening screen'); assert.equal(h.page.doc.activeElement, chat.inputEl, 'the keyboard starts in the message field');
  assert.equal(chat.logEl.attrs.role, 'group');
  // DOM order = reading order: heading, message field, then the examples.
  const order = findAll(chat.bodyEl, i => i === chat.heroTitleEl || i === chat.inputEl || i === chat.suggestEl); eq(order.map(i => i === chat.heroTitleEl ? 'title' : i === chat.inputEl ? 'input' : 'examples'), ['title', 'input', 'examples']);
});

integrationTest('B1 ui: clicking an example fills the message field and sends nothing', async () => {
  const h = await harness({ empty: true }); await h.view.hydrate(); h.repaint(); const chat = h.view.chat;
  const sends = h.control.requests.length; findAll(chat.suggestEl, i => i.tag === 'button')[1].click();
  assert.equal(chat.inputEl.value, 'Plan a three-month route to learn basic Japanese'); assert.equal(h.page.doc.activeElement, chat.inputEl);
  await tick(); assert.equal(h.control.requests.length, sends, 'not sent'); assert.equal(chat.hasMessages, false); assert.equal(chat.isHero, true);
});

integrationTest('B1 ui: sending the first message moves the same panel (same message field) into the side window and the keyboard stays in the field', async () => {
  const h = await harness({ empty: true }); await h.view.hydrate(); h.repaint(); const chat = h.view.chat; const el = chat.el; const input = chat.inputEl;
  h.control.reply = async () => ({ reply: 'ok', actions: [], rejected: [] });
  h.type('Coffee'); input.focus(); await h.view.sendMapChat();
  assert.equal(chat.isHero, false); assert.equal(chat.el, el, 'one panel'); assert.equal(chat.inputEl, input, 'one message field'); assert.equal(h.workspace().children[0], el, 'now the first child of the workspace');
  assert.equal(find(h.rootEl, i => hasClass(i, 'vam-chat-hero-slot')) , undefined, 'the opening slot is gone'); assert.equal(h.page.doc.activeElement, input, 'focus still in the field');
  assert.equal(chat.suggestEl.hasClass('is-examples'), false, 'suggestions, not examples'); assert.equal(chat.heroTitleEl.hidden, true); assert.equal(chat.resizerEl.hidden, false);
  h.repaint(); assert.equal(chat.isHero, false, 'a repaint keeps it in the side window');
  assert.equal(chat.transcript().length, 2);
});

integrationTest('B2-fix F2: sending the first message from the opening screen does not change the remembered mapChatOpen', async () => {
  for (const remembered of [false, true]) {
    const h = await harness({ empty: true }); h.plugin.settings.mapChatOpen = remembered; await h.view.hydrate(); h.repaint(); const chat = h.view.chat;
    assert.equal(chat.isHero, true);
    h.control.reply = async () => ({ reply: 'ok', actions: [], rejected: [] });
    h.type('Coffee'); await h.view.sendMapChat();
    assert.equal(chat.isHero, false); assert.equal(chat.isOpen, true, 'the panel is shown');
    assert.equal(h.plugin.settings.mapChatOpen, remembered, 'right after the send');
    h.repaint(); assert.equal(h.plugin.settings.mapChatOpen, remembered, `mapChatOpen stays ${remembered}`);
  }
});

integrationTest('B1 ui: an AIM map with no cards does NOT get the opening screen', async () => {
  const h = await harness({ aim: true, empty: true }); await h.view.hydrate(); h.repaint();
  assert.equal(h.view.map.nodes.length, 0); assert.ok(h.view.map.aim); assert.equal(h.view.chat.isHero, false); assert.equal(find(h.rootEl, i => hasClass(i, 'vam-chat-hero-slot')), undefined);
  assert.equal(h.workspace().children[0], h.view.chat.el);
});

integrationTest('B1 ui: a map with cards does not get the opening screen either', async () => {
  const h = await harness(); await h.view.hydrate(); h.repaint(); assert.equal(h.view.chat.isHero, false);
});

integrationTest('B1 ui: the read-only sample shows the opening screen in its start card, and a message from it is sent as noEditableMap', async () => {
  const h = await harness(); await h.view.hydrate(); h.view.builtIn = true;
  // render() makes the start card before it mounts the chat; the stand-in does the same.
  const repaint = () => { const restore = h.view.detachMapChat(); h.page.doc.activeElement = null; h.rootEl.empty(); const start = h.rootEl.createDiv('vam-sample-start'); start.createDiv('vam-sample-start-chat'); h.page.attach(start); const ws = h.rootEl.createDiv('vam-workspace'); const overlay = h.page.attach(ws.createDiv('vam-canvas-overlay')); h.view.mountMapChat(ws, overlay); restore(); return ws; };
  repaint(); const chat = h.view.chat;
  assert.equal(chat.isHero, true); const card = find(h.rootEl, i => hasClass(i, 'vam-sample-start-chat')); assert.ok(find(card, i => i === chat.el), 'in the sample\'s start card');
  h.type('Coffee map'); await h.view.sendMapChat();
  assert.equal(h.control.requests.length, 1); assert.equal(h.control.requests[0].context.noEditableMap, true); assert.equal(JSON.parse(h.control.requests[0].context.json).noEditableMap ?? true, true);
  assert.equal(chat.hasMessages, true); assert.equal(chat.isHero, false, 'after the message it is the side window');
});

// ---- suggestions -------------------------------------------------------------------------------------------------

test('B1 ui: there are two to four suggestions in every situation, and they change with the selection and with a note beside the map', () => {
  const { chatSuggestionKeys } = layoutModule(); const cases = [];
  for (const selected of [0, 1, 2, 5]) for (const hasNote of [false, true]) for (const hasTopics of [false, true]) cases.push({ selected, hasNote, hasTopics, keys: chatSuggestionKeys({ selected, hasNote, hasTopics }) });
  for (const c of cases) assert.ok(c.keys.length >= 2 && c.keys.length <= 4, JSON.stringify(c));
  const key = (selected, hasNote = false, hasTopics = true) => chatSuggestionKeys({ selected, hasNote, hasTopics }).join();
  assert.notEqual(key(0), key(1)); assert.notEqual(key(1), key(2)); assert.notEqual(key(0, false, false), key(0)); assert.notEqual(key(1), key(1, true));
  assert.equal(key(2), key(7), 'many is many'); assert.ok(chatSuggestionKeys({ selected: 0, hasNote: true, hasTopics: false }).includes('ui.map_chat_suggest_empty_from_note'));
});

test('B1 ui: every suggestion and example exists in all three languages and is a non-empty sentence', () => {
  const { chatSuggestionKeys, MAP_CHAT_EXAMPLE_KEYS } = layoutModule(); const dictionaries = ['en', 'zh-TW', 'zh-CN'].map(name => load(`i18n/${name}.ts`)[name === 'en' ? 'en' : name === 'zh-TW' ? 'zhTW' : 'zhCN'] ?? Object.values(load(`i18n/${name}.ts`))[0]);
  const keys = new Set([...MAP_CHAT_EXAMPLE_KEYS]); for (const selected of [0, 1, 2]) for (const hasNote of [false, true]) for (const hasTopics of [false, true]) chatSuggestionKeys({ selected, hasNote, hasTopics }).forEach(k => keys.add(k));
  for (const dictionary of dictionaries) for (const k of keys) assert.ok(typeof dictionary[k] === 'string' && dictionary[k].trim().length > 4, `${k}`);
});

integrationTest('B1 ui: a suggestion only fills the message field (nothing is sent, nothing else changes), keeps what was typed, and the row follows the selection and the open note', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  eq(suggestionTexts(chat), ['What is missing from this map?', 'Arrange the whole map', 'Collapse every branch below the first level']);
  const requests = h.control.requests.length, mutates = h.control.mutates;
  findAll(chat.suggestEl, i => i.tag === 'button')[0].click();
  assert.equal(chat.inputEl.value, 'What is missing from this map?'); assert.equal(h.page.doc.activeElement, chat.inputEl);
  await tick(); assert.equal(h.control.requests.length, requests, 'nothing sent'); assert.equal(h.control.mutates, mutates, 'nothing written'); assert.equal(chat.hasMessages, false);
  chat.inputEl.value = 'first line'; findAll(chat.suggestEl, i => i.tag === 'button')[1].click(); assert.equal(chat.inputEl.value, 'first line\nArrange the whole map', 'an existing draft is kept');
  h.view.selected = h.ids.a; chat.refreshSelection(); assert.match(suggestionTexts(chat)[0], /subtopics under the selected topic/);
  h.view.multiSelected = new Set([h.ids.a, h.ids.b]); chat.refreshSelection(); assert.match(suggestionTexts(chat)[0], /Compare the selected topics/);
  h.view.selected = null; h.view.multiSelected = new Set(); h.setActive('Notes/Research.md', ''); chat.refreshNote(); assert.ok(suggestionTexts(chat).includes('Add what the open note says to the map'));
  assert.ok(suggestionTexts(chat).length <= 4);
});

integrationTest('B1 ui: a suggestion button that has the keyboard is not rebuilt by a refresh that changes nothing', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); const button = findAll(chat.suggestEl, i => i.tag === 'button')[0]; button.focus();
  chat.refreshSelection(); chat.refreshNote(); chat.refreshSelection();
  assert.equal(findAll(chat.suggestEl, i => i.tag === 'button')[0], button, 'same element'); assert.equal(h.page.doc.activeElement, button);
});

// ---- keyboard ------------------------------------------------------------------------------------------------------

integrationTest('B1 ui: Enter sends, Shift+Enter does not, and IME composition keeps Enter from sending, on the opening screen too', async () => {
  const h = await harness({ empty: true }); await h.view.hydrate(); h.repaint(); const chat = h.view.chat; const input = chat.inputEl; let sends = 0; h.view.sendMapChat = async () => { sends++; };
  h.type('x'); input.fire('compositionstart'); assert.equal(press(input, { key: 'Enter' }), false); assert.equal(sends, 0, 'composing: Enter only confirms the candidate');
  assert.equal(press(input, { key: 'Enter', isComposing: true }), false); assert.equal(sends, 0);
  input.fire('compositionend'); assert.equal(press(input, { key: 'Enter', shiftKey: true }), false); assert.equal(sends, 0);
  assert.equal(press(input, { key: 'Enter' }), true); assert.equal(sends, 1);
  // Escape in the opening screen does not fold anything: there is no window yet.
  assert.equal(press(input, { key: 'Escape' }), false); assert.equal(chat.isOpen, true);
});

integrationTest('B1 ui: a repaint and a map change during IME composition leave the field, its text and its composing state alone', async () => {
  const h = await harness({ empty: true }); await h.view.hydrate(); h.repaint(); const chat = h.view.chat; const input = chat.inputEl; input.focus(); input.value = 'ㄅㄆ'; input.fire('compositionstart');
  h.repaint(); assert.equal(chat.isComposing, true); assert.equal(chat.draft, 'ㄅㄆ'); assert.equal(h.page.doc.activeElement, input);
  assert.equal(h.view.typingInField(), true, 'the view treats it as typing: the sync waits');
  input.fire('compositionend'); assert.equal(h.view.typingInField(), false);
});

integrationTest('B1 ui: Escape on any control of the window folds it; the view\'s own Escape (clear the selection) ignores anything inside the window', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); const suggestion = findAll(chat.suggestEl, i => i.tag === 'button')[0]; suggestion.focus();
  assert.equal(press(chat.el, { key: 'Escape', target: suggestion }), true); assert.equal(chat.isOpen, false); assert.equal(h.page.doc.activeElement, chat.toggleEl);
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8'); const at = source.indexOf('Escape inside the chat window');
  assert.ok(at > 0 && /closest\("input, textarea, select, \[contenteditable=true\], \.vam-map-chat"\)/.test(source.slice(at, at + 400)), 'the contentEl Escape skips input fields and the chat window (a plain literal, allowlisted in tests/literal-scan/visual-map.json)');
});

integrationTest('B1 ui: Tab order follows the document: suggestions, then the reference chips, then the message field, then the answer length and Send', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); chat.addTopicReference(h.ids.a);
  const focusable = findAll(chat.bodyEl, i => (i.tag === 'button' || i.tag === 'textarea' || i.tag === 'select') && !i.hidden && i.attrs.tabindex !== '-1');
  const names = focusable.map(i => hasClass(i, 'vam-map-chat-suggestion') ? 'suggestion' : hasClass(i, 'vam-map-chat-chip-remove') ? 'chip' : i === chat.inputEl ? 'input' : hasClass(i, 'vam-map-chat-style-option') ? 'style' : hasClass(i, 'vam-map-chat-send') ? 'send' : hasClass(i, 'vam-map-chat-stop') ? 'stop' : i.tag === 'select' ? 'model' : 'other');
  const tail = names.slice(names.indexOf('suggestion')).filter(n => n !== 'stop'); eq(tail, ['suggestion', 'suggestion', 'suggestion', 'chip', 'input', 'style', 'style', 'send']);
  assert.ok(!focusable.some(i => i.attrs.tabindex && Number(i.attrs.tabindex) > 0), 'no positive tabindex');
});

test('B1 ui: the command to toggle the chat exists in the source, has no default hotkey, and is named in all three languages', () => {
  const main = fs.readFileSync(path.join(root, 'main.ts'), 'utf8'); const at = main.indexOf('id: "toggle-map-chat"');
  assert.ok(at > 0); const block = main.slice(at - 200, at + 500); assert.doesNotMatch(block, /hotkeys/); assert.match(block, /ui\.map_chat_toggle_command/);
  for (const name of ['en', 'zh-TW', 'zh-CN']) assert.match(fs.readFileSync(path.join(root, 'i18n', `${name}.ts`), 'utf8'), /"ui\.map_chat_toggle_command":/);
});

integrationTest('B1 ui: the toggle command opens the window and leaves the keyboard in the message field; with the keyboard there it closes it; elsewhere it moves the keyboard in', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); chat.setOpen(false); h.view.toggleMapChat();
  assert.equal(chat.isOpen, true); assert.equal(h.page.doc.activeElement, chat.inputEl, 'the keyboard is in the field');
  h.page.doc.activeElement = null; h.view.toggleMapChat(); assert.equal(chat.isOpen, true, 'open but the keyboard was elsewhere: it just comes to the field'); assert.equal(h.page.doc.activeElement, chat.inputEl);
  h.view.toggleMapChat(); assert.equal(chat.isOpen, false, 'with the keyboard in the field it closes');
  const wide = await harness({ empty: true }); await wide.view.hydrate(); wide.repaint(); wide.page.doc.activeElement = null; wide.view.toggleMapChat(); assert.equal(wide.page.doc.activeElement, wide.view.chat.inputEl); assert.equal(wide.view.chat.isHero, true, 'on the opening screen it only focuses');
});

integrationTest('B1 ui: opening and closing the window is remembered in the settings; a fold forced by a narrow pane is not', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); chat.setOpen(false); assert.equal(h.plugin.settings.mapChatOpen, false); chat.setOpen(true); assert.equal(h.plugin.settings.mapChatOpen, true);
  h.rootEl.clientWidth = 600; h.view.onResize(); assert.equal(chat.isOpen, false); assert.equal(h.plugin.settings.mapChatOpen, true, 'the user did not close it');
});

integrationTest('B1 ui: a saved closed state starts the window closed', async () => {
  const h = await harness(); h.plugin.settings.mapChatOpen = false; await h.view.hydrate(); h.repaint(); assert.equal(h.view.chat.isOpen, false); assert.ok(h.view.chat.el.hasClass('is-rail'));
});

// ---- plan card and results -----------------------------------------------------------------------------------------

integrationTest('B1 ui: the plan card has a one-sentence description, actions grouped by kind and folded, the call estimate, and Apply / Cancel as real buttons', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  h.control.reply = async () => ({ reply: 'plan', actions: [...Array.from({ length: 14 }, (_, i) => ({ kind: 'add_child', parentId: h.ids.root, title: `Card ${i}`, summary: '' })), { kind: 'rename_topic', nodeId: h.ids.a, title: 'Body!' }, { kind: 'delete_topic', nodeId: h.ids.b, branch: false }, { kind: 'collapse_topic', nodeId: h.ids.root }], rejected: [] });
  h.type('many'); await h.view.sendMapChat(); const card = planCard(h)[0];
  assert.match(visibleText(find(card, i => hasClass(i, 'vam-map-chat-plan-sentence'))), /^This plan needs your confirmation: 17 actions\.$/);
  const groups = findAll(card, i => i.tag === 'details'); eq(groups.map(g => find(g, i => i.tag === 'summary').text), ['Add or create (14)', 'Edit or move (1)', 'Delete (1)', 'Map and view (1)']);
  assert.ok(groups.every(g => g.open === false && g.attrs.open === undefined), 'every group starts folded'); assert.equal(findAll(card, i => i.tag === 'li').length, 17);
  assert.match(visibleText(find(card, i => hasClass(i, 'vam-map-chat-plan-estimate'))), /No extra AI calls/);
  assert.equal(planButton(h, 'apply').tag, 'button'); assert.equal(planButton(h, 'cancel').tag, 'button'); assert.equal(planButton(h, 'apply').disabled, false);
  // Apply is a plain button click, so Enter and Space (the browser turns both into click) work; the keyboard returns to the field.
  h.page.doc.activeElement = planButton(h, 'apply'); planButton(h, 'apply').click(); assert.equal(h.page.doc.activeElement, chat.inputEl, 'focus back in the field, not lost with the button');
  await until(() => chat.pendingPlan() === null && !h.view.chatApplying);
});

integrationTest('B1 ui: a cancelled plan keeps the focus in the field and the card says nothing changed', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  h.control.reply = async () => ({ reply: 'plan', actions: Array.from({ length: 16 }, (_, i) => ({ kind: 'add_child', parentId: h.ids.root, title: `Card ${i}`, summary: '' })), rejected: [] });
  h.type('many'); await h.view.sendMapChat(); h.page.doc.activeElement = planButton(h, 'cancel'); planButton(h, 'cancel').click();
  assert.equal(h.page.doc.activeElement, chat.inputEl); assert.match(visibleText(planCard(h)[0]), /Nothing was changed/);
});

integrationTest('B1 ui: result lines name their status in words; five or fewer are all shown; the closing "cannot be undone" line is always last', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); chat.begin('q');
  chat.finish('r', [{ status: 'done', text: 'Done: A' }, { status: 'skipped', text: 'Skipped: B (the topic is no longer on the map)' }, { status: 'failed', text: 'Failed: C (boom)' }, { status: 'done', text: 'These changes cannot be undone; the undo history was cleared.' }]);
  const lines = findAll(chat.logEl, i => hasClass(i, 'vam-map-chat-line')); eq(lines.map(l => l.text.split(':')[0].split(' ')[0]), ['Done:', 'Skipped:', 'Failed:', 'These'].map(s => s.replace(':', ''))); assert.ok(hasClass(lines.at(-1), 'is-note'));
  assert.equal(findAll(chat.logEl, i => hasClass(i, 'vam-map-chat-lines-toggle')).length, 0);
});

integrationTest('B1 ui: more than five result lines fold into a count; the toggle shows them all and back; the closing line stays last; focus stays on the toggle', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); chat.begin('q');
  const lines = [...Array.from({ length: 18 }, (_, i) => ({ status: 'done', text: `Done: card ${i}` })), { status: 'skipped', text: 'Skipped: x (y)' }, { status: 'skipped', text: 'Skipped: z (w)' }, { status: 'failed', text: 'Failed: q (r)' }, { status: 'done', text: 'These changes cannot be undone; the undo history was cleared.' }];
  chat.finish('r', lines);
  const text = () => visibleText(find(chat.logEl, i => hasClass(i, 'vam-map-chat-lines'))); const shown = () => findAll(chat.logEl, i => hasClass(i, 'vam-map-chat-line'));
  assert.match(text(), /18 done, 2 skipped, 1 failed/); eq(shown().map(l => l.text), ['These changes cannot be undone; the undo history was cleared.'], 'folded: only the closing line');
  let toggle = find(chat.logEl, i => hasClass(i, 'vam-map-chat-lines-toggle')); assert.equal(toggle.text, 'Show all 21 results'); assert.equal(toggle.attrs['aria-expanded'], 'false'); toggle.click();
  assert.equal(shown().length, 22); assert.ok(hasClass(shown().at(-1), 'is-note'), 'still last'); toggle = find(chat.logEl, i => hasClass(i, 'vam-map-chat-lines-toggle')); assert.equal(toggle.attrs['aria-expanded'], 'true'); assert.equal(h.page.doc.activeElement, toggle);
  toggle.click(); assert.equal(shown().length, 1);
  // Exactly five results do not fold; six do.
  const five = await harness(); await five.view.hydrate(); const c5 = five.open(); c5.begin('q'); c5.finish('r', Array.from({ length: 5 }, (_, i) => ({ status: 'done', text: `Done: ${i}` }))); assert.equal(findAll(c5.logEl, i => hasClass(i, 'vam-map-chat-line')).length, 5);
  c5.begin('q2'); c5.finish('r', Array.from({ length: 6 }, (_, i) => ({ status: 'done', text: `Done: ${i}` }))); assert.equal(findAll(c5.logEl, i => hasClass(i, 'vam-map-chat-line')).length, 5, 'the second message is folded: only the first one\'s five remain');
});

integrationTest('B1 ui: a failed turn stays in the conversation with a Retry button, no Notice is shown, and Retry sends the same question again and applies its actions', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); const notices = h.notices.length;
  h.control.reply = async () => { throw new Error('network is down'); };
  h.type('add a card'); await h.view.sendMapChat();
  const errorRow = find(chat.logEl, i => hasClass(i, 'is-error')); assert.ok(errorRow); assert.match(visibleText(errorRow), /network is down/); assert.equal(h.notices.length, notices, 'no pop-up');
  const retry = find(errorRow, i => i.tag === 'button' && hasClass(i, 'vam-map-chat-retry')); assert.equal(retry.text, 'Retry'); assert.equal(retry.disabled, false);
  h.control.reply = async () => ({ reply: 'added', actions: [{ kind: 'add_child', parentId: h.ids.a, title: 'Retried', summary: '' }], rejected: [] });
  const before = h.view.map.nodes.length; retry.click(); await until(() => chat.transcript().at(-1)?.text === 'added' && !chat.isBusy);
  assert.equal(h.control.requests.at(-1).message, 'add a card', 'the same question'); assert.equal(h.view.map.nodes.length, before + 1, 'and its actions were applied this time');
  assert.equal(chat.draft, '', 'the draft is not touched');
});

integrationTest('B1 ui: Retry is disabled while a request runs, and an answer that is not an error has no Retry', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); const origin = { text: 'q', chips: [], selectedIds: [] }; chat.begin('q', origin); chat.fail('boom'); chat.begin('q2', { ...origin, text: 'q2' });
  const buttons = findAll(chat.logEl, i => hasClass(i, 'vam-map-chat-retry')); assert.equal(buttons.length, 1); assert.equal(buttons[0].disabled, true);
  chat.finish('fine', []); assert.equal(findAll(chat.logEl, i => hasClass(i, 'vam-map-chat-retry')).length, 1, 'only the failed one'); assert.equal(findAll(chat.logEl, i => hasClass(i, 'vam-map-chat-retry'))[0].disabled, false);
});

// ---- screen reader --------------------------------------------------------------------------------------------------

integrationTest('B1 ui: the window is a labelled region; the log has no aria-live and no role=log; one live region says the summary once, when the turn ends', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  assert.equal(chat.bodyEl.attrs.role, 'region'); assert.equal(chat.bodyEl.attrs['aria-label'], 'Ask AI about this map');
  assert.equal(chat.logEl.attrs['aria-live'], undefined); assert.notEqual(chat.logEl.attrs.role, 'log'); assert.equal(findAll(chat.bodyEl, i => i.attrs['aria-live'] !== undefined).length, 0, 'nothing in the body is live');
  const writes = []; const live = chat.liveEl; const setText = live.setText.bind(live); live.setText = value => { writes.push(value); setText(value); };
  assert.equal(live.attrs['aria-live'], 'polite'); assert.equal(live.attrs['aria-atomic'], 'true');
  chat.begin('ask'); for (const part of ['He', 'Hello', 'Hello wor', 'Hello world']) { chat.streamReply(part); await tick(); } eq(writes, [], 'silence while it streams');
  chat.finish('Hello world', [{ status: 'done', text: 'Done: A' }, { status: 'done', text: 'Done: B' }, { status: 'skipped', text: 'Skipped: C (x)' }]);
  eq(writes, ['AI replied: Hello world Results: 2 done, 1 skipped'], 'once, with the counts'); assert.equal(live.text, writes[0]);
  chat.begin('again'); chat.fail('boom'); eq(writes.length, 2); assert.match(writes[1], /AI chat failed: boom/);
});

integrationTest('B1 ui: stopping a turn and applying a plan each say one thing; the long reply in the summary is clipped', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); const writes = []; const setText = chat.liveEl.setText.bind(chat.liveEl); chat.liveEl.setText = value => { writes.push(value); setText(value); };
  chat.begin('q'); chat.streamReply('partial'); chat.markStopped(); eq(writes, ['Stopped.']);
  chat.begin('q2'); chat.finish('x'.repeat(500), []); assert.ok(writes.at(-1).length < 200, 'clipped');
});

// ---- what must not change --------------------------------------------------------------------------------------------

test('B1 ui: single sources stay single: one typingInField (5 mentions: the definition and its 4 callers), the same 5 renderChatMarkdown mentions in code, one definition each of the focus capture and the detach', () => {
  const walk = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? (['node_modules', 'tests', 'samples', 'scripts'].includes(entry.name) ? [] : walk(path.join(dir, entry.name))) : entry.name.endsWith('.ts') ? [path.join(dir, entry.name)] : []);
  const sources = walk('.').map(file => fs.readFileSync(path.join(root, file), 'utf8'));
  const total = pattern => sources.reduce((sum, text) => sum + (text.match(new RegExp(pattern, 'g')) ?? []).length, 0);
  assert.equal(total('typingInField'), 5, 'typingInField'); assert.equal(total('active\\?\\.matches\\("input, textarea, select"\\)'), 1, 'the typing check is written once'); assert.equal(total('renderChatMarkdown'), 5, 'renderChatMarkdown');
  assert.equal(total('captureFocus\\(\\): \\(\\) => void \\{'), 1, 'one capture'); assert.equal(total('private detachMapChat\\(\\)'), 1, 'one detach');
});

test('B1 ui: the stylesheet takes colours and sizes from Obsidian variables only, has no floating-window rules left, and keeps the toolbar and zoom rules', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8'); const chatRules = css.split('\n').filter(line => /^\.(vam-map-chat|vam-chat-hero|vam-sr-only|vam-canvas \{)/.test(line)).join('\n');
  assert.ok(chatRules.length > 3000); assert.doesNotMatch(chatRules, /#[0-9a-fA-F]{3,8}\b|rgb\(|rgba\(|hsl\(/, 'no literal colours'); assert.doesNotMatch(css, /has-map-chat-open/, 'the floating-window make-room rules are gone');
  assert.doesNotMatch(css, /\.vam-map-chat ~ \.vam-canvas-hint/); assert.doesNotMatch(css, /bottom: 392px/); assert.doesNotMatch(chatRules, /border-left|border-right: [2-9]|linear-gradient|background-clip: text/, 'none of the banned surface habits');
  assert.match(css, /^\.vam-map-tools \{ top: 12px; left: 12px;/m); assert.match(css, /^\.vam-zoom-controls \{ right: 12px; bottom: 12px; \}/m);
  assert.match(css, /^\.vam-workspace \{ display: flex;[^}]*position: relative;/m); assert.match(css, /^\.vam-canvas \{ position: relative; display: flex; flex: 1;/m);
  assert.match(css, /\.vam-map-chat\.is-overlay \+ \.vam-canvas \{ margin-left: 44px; \}/);
});

test('B1 ui: render() builds the workspace as the chat window, the canvas (viewport + overlay) and the inspector, and the selection bar lives in the canvas', () => {
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8'); const render = source.slice(source.indexOf('  private render(): void {'), source.indexOf('  /** `shownNode` may be a display copy'));
  assert.match(render, /const canvas = workspace\.createDiv\("vam-canvas"\)/); assert.match(render, /this\.viewportEl = canvas\.createDiv\("vam-viewport"\)/); assert.match(render, /const overlay = canvas\.createDiv\("vam-canvas-overlay"\)/);
  assert.match(render, /this\.renderSelectionBar\(canvas\)/); assert.match(render, /this\.renderInspector\(workspace, node\)/, 'the sample inspector is still a sibling of the canvas');
});

// ---- B1-fix 1: the batch repaints once ----------------------------------------------------------------------------------
const hundred = () => [addRoot('r', 'Root'), ...Array.from({ length: 99 }, (_, i) => addRoot(`c${i}`, `Kid ${i}`, 'new:r'))];
integrationTest('B1 fix 1: 100 add_child repaint at most 3 times and read the notes back at most 3 times, not 200 and 100', async () => {
  const h = await harness({ empty: true, realRender: true, viaSync: true }); await h.view.hydrate();
  let hydrates = 0; const hydrate = h.view.hydrate; h.view.hydrate = async (...args) => { hydrates++; return hydrate(...args); };
  const before = h.renders(); const lines = await apply(h, hundred());
  assert.equal(lines.filter(l => l.status === 'done').length >= 100, true, JSON.stringify(lines.slice(0, 3)));
  assert.equal(h.view.map.nodes.length, 100); assert.equal((await h.saved()).length, 100);
  const repaints = h.renders() - before; console.log(`B1 fix 1: ${repaints} repaints, ${hydrates} syncs for 100 add_child`);
  assert.ok(repaints >= 1 && repaints <= 3, `repaints: ${repaints}`);
  assert.ok(hydrates <= 3, `syncs: ${hydrates}`);
});
integrationTest('B1 fix 1: stopping in the middle of a batch still repaints once, and the rest is skipped', async () => {
  const h = await harness({ empty: true, realRender: true, viaSync: true }); await h.view.hydrate();
  let asked = 0; const alive = () => ++asked < 40; // the 40th check says "stopped"
  const before = h.renders(); const lines = await apply(h, hundred(), {}, alive);
  assert.ok(lines.some(l => l.status === 'done') && lines.some(l => l.status === 'skipped'), 'part done, part skipped');
  assert.ok(h.view.map.nodes.length > 0 && h.view.map.nodes.length < 100);
  assert.ok(h.renders() - before >= 1 && h.renders() - before <= 3, `repaints: ${h.renders() - before}`);
  assert.equal(h.view.renderHold, 0); assert.equal(h.view.syncHold, 0);
});
integrationTest('B1 fix 1: the layout after a held batch is made after the cards were painted (it measures them)', async () => {
  const h = await harness({ empty: true, realRender: true, viaSync: true }); await h.view.hydrate();
  let paintedAtLayout = -1; const original = h.view.mapChange.bind(h.view);
  h.view.mapChange = async (change, rebuild) => { if (rebuild === false && paintedAtLayout < 0) paintedAtLayout = h.renders(); return original(change, rebuild); };
  const before = h.renders(); await apply(h, [...hundred().slice(0, 6), { kind: 'auto_layout' }]);
  assert.ok(paintedAtLayout - before >= 1, `painted before the layout: ${paintedAtLayout - before}`);
});

// ---- B1-fix: first window, plan card, canvas, panel ------------------------------------------------------------------
const planActions = (h, n = 16) => Array.from({ length: n }, (_, i) => ({ kind: 'add_child', parentId: h.ids.root, title: `Card ${i}`, summary: '' }));
const lineTexts = chat => chat.transcript().at(-1).lines.map(l => l.text);

integrationTest('B1 fix 2: the first message of an opening screen opens the window even when it was closed or the pane is narrow, and the keyboard stays in the message field', async () => {
  for (const [closed, width] of [[true, 0], [false, 600], [true, 600]]) {
    const h = await harness({ empty: true }); await h.view.hydrate(); h.plugin.settings.mapChatOpen = !closed; h.repaint(); const chat = h.view.chat;
    if (closed) chat.restoreOpen(false); if (width) { h.rootEl.clientWidth = width; h.view.onResize(); }
    assert.equal(chat.isHero, true); h.type('Coffee'); chat.inputEl.focus(); await h.view.sendMapChat();
    assert.equal(chat.isHero, false, 'now the side window'); assert.equal(chat.isOpen, true, `shown (closed ${closed}, pane ${width})`); assert.equal(h.page.doc.activeElement, chat.inputEl, 'the keyboard did not leave the field');
    if (width) assert.equal(chat.isOverlay, true, 'a narrow pane lays the window over the canvas');
  }
});

integrationTest('B1 fix 3: while a plan is applied the window says so and offers Stop; Stop keeps what is done and skips the rest with its reason; a send is not taken', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  h.control.reply = async () => ({ reply: 'plan', actions: planActions(h), rejected: [] });
  h.type('many'); await h.view.sendMapChat();
  const gate = deferred(); let calls = 0; const original = h.view.applyChatWrite.bind(h.view);
  h.view.applyChatWrite = async (...args) => { if (++calls === 3) await gate.promise; return original(...args); };
  planButton(h, 'apply').click(); await until(() => calls === 3);
  assert.equal(chat.stopEl.hidden, false, 'Stop is offered'); assert.equal(chat.sendEl.hidden, true); assert.equal(chat.statusEl.text, 'Applying the plan…'); assert.ok(chat.el.hasClass('is-busy'));
  const requests = h.control.requests.length; h.type('another'); await h.view.sendMapChat(); assert.equal(h.control.requests.length, requests, 'no second request while the plan is applied');
  chat.stopEl.click(); gate.resolve(); await until(() => !h.view.chatApplying);
  const lines = chat.transcript().at(-1).lines; assert.equal(lines.filter(l => l.status === 'done').length >= 3, true, JSON.stringify(lines.slice(0, 4)));
  assert.ok(lines.some(l => l.status === 'skipped' && /you stopped it/.test(l.text)), JSON.stringify(lines.slice(-3)));
  assert.equal(chat.stopEl.hidden, true); assert.equal(chat.sendEl.hidden, false); assert.equal(chat.statusEl.text, '');
  assert.equal(h.view.map.nodes.length, 4 + lines.filter(l => l.status === 'done' && /Add subtopic/.test(l.text)).length, 'what was done is kept');
});

integrationTest('B1 fix 4: a plan that waits has no "say it in more detail" button (it would replace the plan); once settled the button is back and comes after the results', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  h.control.reply = async () => ({ reply: 'a plan for you', actions: planActions(h), rejected: [] });
  h.type('many'); await h.view.sendMapChat();
  assert.equal(findAll(chat.logEl, i => hasClass(i, 'vam-map-chat-more')).length, 0, 'not while the plan waits');
  planButton(h, 'cancel').click(); await tick();
  const more = findAll(chat.logEl, i => hasClass(i, 'vam-map-chat-more')); assert.equal(more.length, 1, 'back after the plan was settled');
  const row = more[0].parent; const order = row.children.map(c => c.cls.split(' ')[0]);
  assert.ok(order.indexOf('vam-map-chat-more') > order.indexOf('vam-map-chat-plan'), JSON.stringify(order));
});

integrationTest('B1 fix 25: "say it in more detail" comes after the result lines, not between the reply and them', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  h.control.reply = async () => ({ reply: 'done', actions: [{ kind: 'rename_topic', nodeId: h.ids.a, title: 'Renamed' }], rejected: [] });
  h.type('rename'); await h.view.sendMapChat(); const row = findAll(chat.logEl, i => hasClass(i, 'vam-map-chat-more'))[0].parent; const order = row.children.map(c => c.cls.split(' ')[0]);
  assert.ok(order.indexOf('vam-map-chat-lines') >= 0 && order.indexOf('vam-map-chat-more') > order.indexOf('vam-map-chat-lines'), JSON.stringify(order));
});

test('B1 fix 5: a new message, and a pick in any list, end every list of maps shown so far', () => {
  const f = panelFixture(); f.panel.setOpen(true); const picks = [];
  const list = name => ({ prompt: 'Which?', options: [{ label: name, pick: () => picks.push(name) }], picked: false });
  const enabled = () => findAll(f.parts.log(), i => hasClass(i, 'vam-map-chat-choice')).map(b => !b.disabled);
  f.panel.begin('one'); f.panel.finish('a', []); f.panel.showChoices(list('A')); f.panel.begin('two'); f.panel.finish('b', []); f.panel.showChoices(list('B'));
  eq(enabled(), [false, true], 'the older list stopped working when the next one appeared');
  f.panel.begin('three'); eq(enabled(), [false, false], 'a new message ends the rest');
  const g = panelFixture(); g.panel.setOpen(true); g.panel.begin('one'); g.panel.finish('a', []); g.panel.showChoices({ prompt: 'p', options: [{ label: 'A', pick: () => {} }], picked: false });
  g.panel.messageEls; const first = g.panel.transcript(); assert.equal(first.length, 2);
  const other = { prompt: 'q', options: [{ label: 'B', pick: () => {} }], picked: false }; g.panel.begin('two'); g.panel.finish('b', []); g.panel.showChoices(other);
  findAll(g.parts.log(), i => hasClass(i, 'vam-map-chat-choice')).at(-1).click(); eq(findAll(g.parts.log(), i => hasClass(i, 'vam-map-chat-choice')).map(b => !b.disabled), [false, false], 'a pick ends every list');
});

integrationTest('B1 fix 6: a reply that asks to look at a card keeps that view; the automatic move to the new branch is only the default', async () => {
  const h = await harness({ empty: true }); await h.view.hydrate();
  const tree = [addRoot('r', 'Root'), ...Array.from({ length: 5 }, (_, i) => addRoot(`c${i}`, `Kid ${i}`, 'new:r'))];
  await apply(h, [...tree, { kind: 'focus_topic', nodeId: 'new:c2' }]);
  const kid = h.view.map.nodes.filter(n => n.parentId)[2]; eq(h.focused, [kid.id], 'only the card the reply named');
  const plain = await harness({ empty: true }); await plain.view.hydrate(); await apply(plain, tree); eq(plain.focused, [plain.view.map.nodes.find(n => !n.parentId).id], 'without focus_topic the new root, as before');
});

test('B1 fix 8: the count a plan names is the one it was judged by (a selection made earlier in the reply counts)', () => {
  const { researchTargetsOf, planFor } = load('core/map-chat-plan.ts'); const ids = Array.from({ length: 12 }, (_, i) => `x${i}`);
  const actions = [{ kind: 'select_topics', nodeIds: ids, all: false }, { kind: 'run_map_action', action: 'research_standard', nodeIds: [] }];
  assert.equal(researchTargetsOf(actions, 0), 12); assert.ok(planFor(actions, { parents: {}, selectedCount: 0 }).reasons.includes('many_research'));
  assert.equal(researchTargetsOf([{ kind: 'run_map_action', action: 'research_standard', nodeIds: [] }], 3), 3, 'the selection sent with the message');
  assert.equal(researchTargetsOf([{ kind: 'run_map_action', action: 'research_standard', nodeIds: ['a', 'b'] }, { kind: 'run_map_action', action: 'research_standard', nodeIds: [] }], 0), 4, 'a named list becomes the selection');
});
integrationTest('B1 fix 8: the plan card names the same research count as the plan, and a plan card is announced once to a screen reader', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); const ids = Array.from({ length: 12 }, (_, i) => `x${i}`);
  h.control.reply = async () => ({ reply: 'I will research.', actions: [{ kind: 'select_topics', nodeIds: ids, all: false }, { kind: 'run_map_action', action: 'research_standard', nodeIds: [] }], rejected: [] });
  h.type('research'); await h.view.sendMapChat();
  assert.match(visibleText(planCard(h)[0]), /Starts research on 12 topics/);
  const live = findAll(chat.el, i => hasClass(i, 'vam-sr-only'))[0].text; assert.match(live, /I will research\./); assert.match(live, /A plan is waiting for you: This plan needs your confirmation/);
});

integrationTest('B1 fix 11: a map that was made but could not be opened says so, and the rest of the reply says the same', async () => {
  const h = await harness(); await h.view.hydrate(); const original = h.view.chatSwitchTo.bind(h.view); h.view.chatSwitchTo = async () => '';
  const lines = await apply(h, [{ kind: 'create_map', title: 'Lost map' }, addRoot('r', 'Root')]);
  assert.match(lines[0].text, /created but could not be opened here/); assert.doesNotMatch(lines[0].text, /changed or closed/); assert.match(lines[1].text, /created but could not be opened here/);
  const none = await harness(); await none.view.hydrate(); none.view.plugin.repo.createMap = async () => { throw new Error('disk full'); };
  const failed = await apply(none, [{ kind: 'create_map', title: 'X' }, addRoot('r', 'Root')]); assert.equal(failed[0].status, 'failed'); assert.match(failed[1].text, /was not created/);
  void original;
});

integrationTest('B1 fix 12: the read-only sample, from the opening screen to a map of the user\'s own: message, plan card, Apply, the new map with its cards, the conversation kept', async () => {
  const h = await harness(); await h.view.hydrate(); h.view.builtIn = true;
  const repaint = () => { const restore = h.view.detachMapChat(); h.page.doc.activeElement = null; h.rootEl.empty(); const start = h.rootEl.createDiv('vam-sample-start'); start.createDiv('vam-sample-start-chat'); h.page.attach(start); const ws = h.rootEl.createDiv('vam-workspace'); const overlay = h.page.attach(ws.createDiv('vam-canvas-overlay')); h.view.mountMapChat(ws, overlay); restore(); };
  repaint(); const chat = h.view.chat; assert.equal(chat.isHero, true);
  const actions = [{ kind: 'create_map', title: 'Coffee study' }, addRoot('r', 'Coffee'), ...Array.from({ length: 4 }, (_, i) => addRoot(`c${i}`, `Part ${i}`, 'new:r'))];
  h.control.reply = async () => ({ reply: 'I will make a map.', actions, rejected: [] });
  const topicsBefore = (await h.repo.topics()).length; h.type('Coffee map'); await h.view.sendMapChat();
  assert.equal(h.control.requests[0].context.noEditableMap, true); assert.equal(planCard(h).length, 1, 'a new map waits for the yes'); assert.equal((await h.repo.topics()).length, topicsBefore);
  planButton(h, 'apply').click(); await until(() => !h.view.chatApplying && chat.pendingPlan() === null && chat.transcript().at(-1).lines.length > 0);
  assert.equal(h.view.builtIn, false, 'a map of the user\'s own'); assert.equal(h.view.map.title, 'Coffee study'); assert.equal(h.view.map.nodes.length, 5); assert.equal((await h.repo.topics()).length, topicsBefore + 1);
  assert.equal(chat.transcript().length, 2, 'the conversation went along'); eq(lineTexts(chat).slice(0, 6).every(t => /^Done/.test(t)), true);
});

integrationTest('B1 fix 15: the empty canvas follows the chat: building while it works, a line while a plan waits, the usual hint again when it ends or is cancelled', async () => {
  const h = await harness({ empty: true }); await h.view.hydrate(); h.repaint(); const chat = h.view.chat; const box = element('div'); h.view.emptyMapEl = box; h.view.fillEmptyMap(box);
  const shown = () => visibleText(box); assert.match(shown(), /no topics/); assert.ok(findAll(box, i => i.tag === 'button').length === 1, 'the topic button of the usual hint');
  const gate = deferred(); h.control.reply = async () => { await gate.promise; return { reply: 'plan', actions: planActions(h, 16).map(a => ({ ...a, parentId: '' })), rejected: [] }; };
  h.type('Coffee'); const sent = h.view.sendMapChat(); await until(() => chat.isBusy);
  assert.match(shown(), /Building the map…/); assert.equal(findAll(box, i => hasClass(i, 'vam-chat-skeleton-card')).length, 3); assert.equal(findAll(box, i => i.tag === 'button').length, 0, 'no manual-create button meanwhile');
  assert.equal(findAll(box, i => hasClass(i, 'vam-chat-skeleton'))[0].attrs['aria-hidden'], 'true');
  gate.resolve(); await sent; assert.match(shown(), /Once you confirm the plan, the map appears here\./); assert.equal(findAll(box, i => hasClass(i, 'vam-chat-skeleton-card')).length, 0);
  planButton(h, 'cancel').click(); await tick(); assert.match(shown(), /no topics/, 'cancelled: the usual hint is back');
  h.control.reply = async () => ({ reply: 'just text', actions: [], rejected: [] }); h.type('hello'); await h.view.sendMapChat(); assert.match(shown(), /no topics/, 'a reply that builds nothing leaves the usual hint');
  h.control.reply = async () => { throw new Error('boom'); }; h.type('again'); await h.view.sendMapChat(); assert.match(shown(), /no topics/, 'failed: the usual hint');
});

integrationTest('B1 fix 16: the plan card says before Apply that it cannot be undone, marks the group that removes cards in words, and its title follows what became of it', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  h.control.reply = async () => ({ reply: 'plan', actions: [...planActions(h, 15), { kind: 'delete_topic', nodeId: h.ids.a, branch: true }], rejected: [] });
  h.type('many'); await h.view.sendMapChat(); const title = () => find(planCard(h)[0], i => hasClass(i, 'vam-map-chat-plan-title')).text;
  assert.equal(title(), 'Plan to review'); const buttons = find(planCard(h)[0], i => hasClass(i, 'vam-map-chat-plan-buttons'));
  assert.ok(findAll(buttons, i => hasClass(i, 'vam-map-chat-plan-warning') && i.text === 'Cannot be undone once applied.').length === 1, 'next to the buttons, before they are pressed');
  const danger = findAll(planCard(h)[0], i => i.tag === 'details' && hasClass(i, 'is-danger')); assert.equal(danger.length, 1, 'only the delete group');
  assert.match(visibleText(danger[0]), /Delete \(1\)/); assert.equal(findAll(danger[0], i => hasClass(i, 'vam-map-chat-plan-mark'))[0].text, 'Removes');
  assert.equal(findAll(planCard(h)[0], i => i.tag === 'details' && !hasClass(i, 'is-danger')).length >= 1, true);
  planButton(h, 'apply').click(); await until(() => chat.pendingPlan() === null && !h.view.chatApplying); assert.equal(title(), 'Applied plan'); assert.equal(planCard(h)[0].attrs['aria-label'], 'Applied plan');
  const again = await harness(); await again.view.hydrate(); again.open(); again.control.reply = async () => ({ reply: 'plan', actions: planActions(again, 16), rejected: [] });
  again.type('many'); await again.view.sendMapChat(); planButton(again, 'cancel').click(); await tick(); assert.equal(find(planCard(again)[0], i => hasClass(i, 'vam-map-chat-plan-title')).text, 'Cancelled plan');
});

integrationTest('B1 fix 3 (Primary 3): while a plan waits the field is not locked and a line says that a new message cancels it; sending cancels the plan and the line goes', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  h.control.reply = async () => ({ reply: 'plan', actions: planActions(h), rejected: [] }); h.type('many'); await h.view.sendMapChat();
  assert.equal(chat.hintEl.hidden, false); assert.equal(chat.hintEl.text, 'Sending a new message cancels this plan.'); assert.equal(chat.inputEl.disabled, false, 'the field is not locked');
  h.control.reply = async () => ({ reply: 'ok', actions: [], rejected: [] }); h.type('something else'); await h.view.sendMapChat();
  assert.equal(chat.hintEl.hidden, true); assert.equal(chat.hintEl.text, ''); assert.equal(chat.transcript().find(m => m.plan).plan.state, 'cancelled');
  assert.equal(find(planCard(h)[0], i => hasClass(i, 'vam-map-chat-plan-title')).text, 'Cancelled plan');
});

test('B1 fix 18: a failure is announced once: a text that already says the chat failed is not prefixed again', () => {
  const f = panelFixture(); f.panel.setOpen(true); const live = () => findAll(f.panel.el, i => hasClass(i, 'vam-sr-only'))[0].text;
  f.panel.begin('a'); f.panel.fail('The AI chat failed: boom', 'The AI chat failed: boom'); assert.equal(live(), 'The AI chat failed: boom');
  f.panel.begin('b'); f.panel.fail('The references are too large to send.'); assert.equal(live(), 'AI chat failed: The references are too large to send.', 'a plain reason still gets its prefix, once');
});
integrationTest('B1 fix 18: the view announces a service failure once', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); h.control.reply = async () => { throw new Error('boom'); };
  h.type('hi'); await h.view.sendMapChat(); const live = findAll(chat.el, i => hasClass(i, 'vam-sr-only'))[0].text; assert.equal(live, 'The AI chat failed: boom'); assert.equal((live.match(/AI chat failed/g) ?? []).length, 1);
});

integrationTest('B1 fix 20 and 24: the opening screen asks for a topic and hides the old empty hint; a map with content opens the window onto one line of guidance, not a blank log', async () => {
  const hero = await harness({ empty: true }); await hero.view.hydrate(); hero.repaint(); const chat = hero.view.chat;
  assert.equal(chat.inputEl.attrs.placeholder, 'Say what you want to research or organize. One sentence is enough.'); assert.equal(chat.guideEl.hidden, true, 'no guidance on the opening screen');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8'); assert.match(css, /\.has-chat-hero \.vam-empty \{ display: none; \}/);
  hero.control.reply = async () => ({ reply: 'ok', actions: [], rejected: [] }); hero.type('Coffee'); await hero.view.sendMapChat(); assert.match(chat.inputEl.attrs.placeholder, /^Ask a question, or ask the AI to change the map/);
  const h = await harness(); await h.view.hydrate(); const side = h.open();
  assert.equal(side.guideEl.hidden, false); assert.equal(side.guideEl.text, 'No messages yet. Type below, or pick a suggestion.'); assert.equal(side.logEl.hidden, true);
  side.begin('q'); assert.equal(side.guideEl.hidden, true); assert.equal(side.logEl.hidden, false);
});

integrationTest('B1 fix 22: the failed count in a folded summary is set apart in its own element, with its word', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); chat.begin('q');
  chat.finish('done', [...Array.from({ length: 6 }, (_, i) => ({ status: 'done', text: `Done ${i}` })), { status: 'skipped', text: 'Skipped x' }, { status: 'failed', text: 'Failed y' }]);
  const summary = find(chat.logEl, i => hasClass(i, 'vam-map-chat-lines-summary')); const failed = find(summary, i => hasClass(i, 'vam-map-chat-count-failed'));
  assert.equal(failed.text, '1 failed'); assert.equal(visibleText(summary), '6 done, 1 skipped, 1 failed');
  chat.begin('r'); chat.finish('done', Array.from({ length: 6 }, (_, i) => ({ status: 'done', text: `D${i}` })));
  assert.equal(findAll(chat.logEl, i => hasClass(i, 'vam-map-chat-count-failed')).length, 1, 'no failed element when nothing failed');
});

test('B1 fix 23 and 28: no suggestion ends in an ellipsis in any language, and without a selected card none speaks of a selection', () => {
  const { chatSuggestionKeys, MAP_CHAT_EXAMPLE_KEYS } = layoutModule(); const dictionaries = Object.fromEntries(['en', 'zh-TW', 'zh-CN'].map(name => [name, load(`i18n/${name}.ts`)[name === 'en' ? 'en' : name === 'zh-TW' ? 'zhTW' : 'zhCN'] ?? Object.values(load(`i18n/${name}.ts`))[0]]));
  const none = [...chatSuggestionKeys({ selected: 0, hasNote: true, hasTopics: true }), ...chatSuggestionKeys({ selected: 0, hasNote: true, hasTopics: false }), ...chatSuggestionKeys({ selected: 0, hasNote: false, hasTopics: true }), ...MAP_CHAT_EXAMPLE_KEYS];
  const some = [...chatSuggestionKeys({ selected: 1, hasNote: false, hasTopics: true }), ...chatSuggestionKeys({ selected: 3, hasNote: false, hasTopics: true })];
  for (const [name, dictionary] of Object.entries(dictionaries)) {
    for (const key of [...none, ...some]) assert.doesNotMatch(dictionary[key], /(…|\.\.\.)$/, `${name} ${key}`);
    for (const key of none) assert.doesNotMatch(dictionary[key], name === 'en' ? /selected/i : /選取|选取|选中|選中/, `${name} ${key}: nothing is selected`);
    assert.ok(some.some(key => (name === 'en' ? /selected/i : /選取|选取/).test(dictionary[key])), `${name}: with a selection the suggestions say so`);
  }
});

test('B1 fix 14 and 26: opening the window onto an unread reply lands on the newest message; a repaint keeps the log where it was (at the end stays at the end)', () => {
  const f = panelFixture(); f.panel.setOpen(true); const log = f.parts.log(); f.panel.setNarrow(true);
  f.panel.begin('q'); f.panel.finish('a reply while folded', []); assert.equal(f.parts.toggle().hasClass('has-unread'), true);
  Object.assign(log, { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 }); f.parts.toggle().click(); assert.equal(log.scrollTop, 1000, 'newest message, not the top');
  // A repaint lifts the panel out of the page (a real element forgets its scroll position there).
  log.scrollTop = 700; f.panel.detach(); log.scrollTop = 0; f.panel.mount(f.overlay); assert.equal(log.scrollTop, 1000, 'at the end before: at the end after');
  log.scrollTop = 100; f.panel.detach(); log.scrollTop = 0; f.panel.mount(f.overlay); assert.equal(log.scrollTop, 100, 'somewhere in the middle: the same place');
});
integrationTest('B1 fix 26: after create_map re-mounts the conversation in the new map\'s page, the log is at its end and the results are in view', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); const log = chat.logEl; Object.assign(log, { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 });
  const remove = chat.el.remove.bind(chat.el); chat.el.remove = () => { remove(); log.scrollTop = 0; };
  h.control.reply = async () => ({ reply: 'new map', actions: [{ kind: 'create_map', title: 'Fresh' }, addRoot('r', 'Root')], rejected: [] });
  h.type('new map'); await h.view.sendMapChat(); planButton(h, 'apply')?.click(); await until(() => !h.view.chatApplying && chat.pendingPlan() === null);
  assert.equal(log.scrollTop, 1000, 'at the end');
});

integrationTest('B1 fix 21 and 27: a window laid over a narrow pane leaves 160px of it; the tool group moves to the window\'s right edge and comes back; the hover preview is under the window', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); const tools = h.rootEl.createDiv('vam-map-tools'); h.plugin.settings.mapChatWidth = 340;
  h.rootEl.clientWidth = 600; h.view.onResize(); assert.equal(chat.isNarrow, true); assert.equal(tools.style.left ?? '', '', 'folded: the group stays at the canvas corner');
  chat.toggleEl.click(); assert.equal(chat.isOverlay, true); assert.equal(chat.el.style.width, '340px'); assert.equal(tools.style.left, `${340 - 44 + 12}px`, 'beside the window, like a docked one');
  h.rootEl.clientWidth = 400; h.view.onResize(); assert.equal(chat.el.style.width, '280px', 'under the 160px margin the window shrinks to its minimum'); assert.equal(tools.style.left, `${280 - 44 + 12}px`);
  h.rootEl.clientWidth = 500; h.view.onResize(); assert.equal(chat.el.style.width, '340px');
  chat.collapseOverlay(); assert.equal(tools.style.left, '', 'folded again: the group goes back');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8'); const z = selector => Number(css.match(new RegExp(`${selector.replace(/[.]/g, '\\.')} \\{[^}]*z-index: (\\d+)`))[1]);
  assert.ok(z('.vam-map-chat.is-overlay') > z('.vam-hover-card'), 'the preview is under the laid-over window');
});

test('B1 fix 17: the suggestions, examples, retry, "more detail" and "show all" each get their own look, with enough weight to beat the base button style', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8'); const rule = selector => css.split('\n').find(line => line.startsWith(`${selector} {`)) ?? '';
  for (const name of ['suggestion', 'example']) assert.match(rule(`.vam-map-chat button.vam-map-chat-${name}`), /background: transparent/, `${name}: ghost text`);
  assert.match(rule('.vam-map-chat button.vam-map-chat-retry'), /border: 1px solid/, 'retry: a clear secondary button'); assert.match(rule('.vam-map-chat button.vam-map-chat-retry'), /background: var\(--background-primary\)/);
  assert.match(css, /\.vam-map-chat button\.vam-map-chat-lines-toggle, \.vam-map-chat button\.vam-map-chat-more \{[^}]*background: transparent/);
  assert.match(rule('.vam-map-chat-chip'), /border: 1px solid[^;]*; border-radius: 999px/, 'chips: an outlined pill');
  for (const bare of ['.vam-map-chat-suggestion', '.vam-map-chat-example', '.vam-map-chat-retry', '.vam-map-chat-more']) assert.equal(css.split('\n').some(line => line.startsWith(`${bare} {`)), false, `${bare} is no longer a bare class that the base style beats`);
});

test('B1 fix 9 and 10: no dead overlay rule; the Escape selector is a plain literal that the literal scan allows with a reason', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8'); assert.equal(css.includes('.vam-workspace.has-inspector > .vam-canvas-overlay'), false);
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8'); assert.equal(/closest\(\[/.test(source), false, 'no selector built from parts');
  const allow = JSON.parse(fs.readFileSync(path.join(root, 'tests/literal-scan/visual-map.json'), 'utf8')).allow.find(entry => entry.text === 'input, textarea, select, [contenteditable=true], .vam-map-chat');
  assert.ok(allow && allow.reason.length > 10);
});

// ---- B2-0 L3: a squeezed window does not write a smaller width back ----------------------------------------------------
const squeezed = async () => {
  const h = await harness(); await h.view.hydrate(); h.plugin.settings.mapChatWidth = 500; const chat = h.open();
  h.rootEl.clientWidth = 700; h.view.onResize(); // the pane leaves 340 of the 500 the user set
  assert.equal(chat.el.style.width, '340px'); h.control.saves = 0;
  return { h, chat };
};
integrationTest('B2-0 L3: squeezed window - ArrowRight (widening) keeps the set width; ArrowLeft (narrowing) still writes the smaller value', async () => {
  const { h, chat } = await squeezed();
  press(chat.resizerEl, { key: 'ArrowRight' });
  assert.equal(h.plugin.settings.mapChatWidth, 500, 'a widening inside the squeezed range does not shrink the set width'); assert.equal(h.control.saves, 0);
  press(chat.resizerEl, { key: 'ArrowLeft' });
  assert.equal(h.plugin.settings.mapChatWidth, 324, 'narrowing from what is shown writes the smaller value'); assert.ok(h.control.saves > 0);
});
integrationTest('B2-0 L3: squeezed window - a drag that only widens keeps the set width; a drag that narrows writes it; End still writes the larger value', async () => {
  const { h, chat } = await squeezed(); const doc = counting(); chat.el.ownerDocument = doc;
  chat.resizerEl.fire('pointerdown', { button: 0, clientX: 340, pointerId: 1 }); doc.fire('pointermove', { clientX: 440 }); doc.fire('pointerup', {});
  assert.equal(h.plugin.settings.mapChatWidth, 500, 'dragged wider than shown but under the set width: unchanged');
  chat.resizerEl.fire('pointerdown', { button: 0, clientX: 340, pointerId: 1 }); doc.fire('pointermove', { clientX: 300 }); doc.fire('pointerup', {});
  assert.equal(h.plugin.settings.mapChatWidth, 300, 'dragged narrower: written');
  press(chat.resizerEl, { key: 'End' }); assert.equal(h.plugin.settings.mapChatWidth, 560, 'wider than the set width: written');
});
integrationTest('B2-0 L3: a window that is not squeezed writes both directions as before', async () => {
  const h = await harness(); await h.view.hydrate(); h.plugin.settings.mapChatWidth = 500; const chat = h.open(); h.rootEl.clientWidth = 1400; h.view.onResize();
  press(chat.resizerEl, { key: 'ArrowLeft' }); assert.equal(h.plugin.settings.mapChatWidth, 484);
  press(chat.resizerEl, { key: 'ArrowRight' }); press(chat.resizerEl, { key: 'ArrowRight' }); assert.equal(h.plugin.settings.mapChatWidth, 516);
  const doc = counting(); chat.el.ownerDocument = doc; chat.resizerEl.fire('pointerdown', { button: 0, clientX: 500, pointerId: 1 }); doc.fire('pointermove', { clientX: 450 }); doc.fire('pointerup', {});
  assert.equal(h.plugin.settings.mapChatWidth, 466);
});

// ---- B2-0 F1: opening the overlay scrolls once its height is final -----------------------------------------------------
test('B2-0 F1: opening the folded overlay scrolls to the end after the next frame (when the overlay height is final), not before', () => {
  const f = panelFixture(); f.panel.setOpen(true); const log = f.parts.log(); f.panel.setNarrow(true);
  f.panel.begin('q'); f.panel.finish('a reply', []); f.panel.collapseOverlay(); assert.equal(f.panel.isOpen, false);
  const frames = []; log.win = { requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {} };
  Object.assign(log, { scrollHeight: 0, clientHeight: 0, scrollTop: 0 }); // a folded log measures as empty, so as at its end
  f.parts.toggle().click(); assert.equal(f.panel.isOpen, true); assert.ok(frames.length >= 1, 'the scroll waits for a frame');
  assert.equal(log.scrollTop, 0, 'not scrolled against the height from before the overlay was laid out');
  // The overlay settles at its final height; the scroll must use it.
  Object.assign(log, { scrollHeight: 1030, clientHeight: 300 }); frames.splice(0).forEach(run => run());
  assert.equal(log.scrollTop, 1030, 'at the very end once the height is final');
});
test('B2-0 F1: the deferred scroll is dropped when the window is folded again before the frame', () => {
  const f = panelFixture(); f.panel.setOpen(true); const log = f.parts.log(); f.panel.setNarrow(true); f.panel.begin('q'); f.panel.finish('a reply', []); f.panel.collapseOverlay();
  const frames = []; log.win = { requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {} };
  Object.assign(log, { scrollHeight: 0, clientHeight: 0, scrollTop: 0 });
  f.parts.toggle().click(); f.panel.collapseOverlay(); Object.assign(log, { scrollHeight: 1000, clientHeight: 300 }); frames.splice(0).forEach(run => run()); assert.equal(log.scrollTop, 0, 'folded again: nothing to scroll');
});

// ---- B2-0 F3: the model menu keeps its width at 340px --------------------------------------------------------------------
integrationTest('B2-0 F3: the model select takes the header\'s remaining width (flex 1 1 0, min-width 0), and the default entry shows the model without its provider prefix, the tooltip keeps the full name', async () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const rule = css.split('\n').find(line => line.startsWith('.vam-map-chat-model {')); assert.ok(rule);
  // B3-fix rule change: with the save button in the header the model asks for 146px (basis) and the title gives way first (flex-shrink 100, min 64px).
  assert.match(rule, /flex: 1 1 146px;/); assert.match(rule, /min-width: 0;/);
  const title = css.split('\n').find(line => line.startsWith('.vam-map-chat-title {')); assert.match(title, /flex: 0 100 auto;/); assert.match(title, /min-width: 64px;/); assert.doesNotMatch(rule, /min-width: 120px/);
  const h = await harness(); await h.view.hydrate(); h.plugin.settings.cliModel = 'gpt-6-luna'; h.plugin.modelLabel = id => id.startsWith('claude:') ? 'Claude Sonnet' : `OpenAI Codex · ${id}`;
  const first = h.view.chatModelChoices()[0];
  assert.equal(first.label, 'Follow default (now: OpenAI Codex · gpt-6-luna)', 'the full name stays in the tooltip'); assert.equal(first.short, 'Default: gpt-6-luna');
  h.plugin.settings.cliModel = 'claude:sonnet'; assert.equal(h.view.chatModelChoices()[0].short, 'Default: Claude Sonnet', 'a label without a provider prefix is unchanged');
});

// ---- B2-0 F5: maps with the same name can be told apart in the list --------------------------------------------------------
test('B2-0 F5: mapChoiceParts leaves different titles alone, adds the folder to a shared title, and a number when the folder is shared too', () => {
  const { mapChoiceParts } = load('core/map-chat-plan.ts');
  eq(mapChoiceParts([{ title: 'Sleep', mapPath: 'A/x/Map.md' }, { title: 'Diet', mapPath: 'A/y/Map.md' }]), [{ title: 'Sleep' }, { title: 'Diet' }], 'different names: no path');
  eq(mapChoiceParts([{ title: 'Sleep', mapPath: 'A/x/Map.md' }, { title: 'Sleep', mapPath: 'A/y/Map.md' }, { title: 'Diet', mapPath: 'A/z/Map.md' }]),
    [{ title: 'Sleep', folder: 'A/x' }, { title: 'Sleep', folder: 'A/y' }, { title: 'Diet' }], 'only the maps that share a name get a path');
  eq(mapChoiceParts([{ title: 'Sleep', mapPath: 'A/x/Map.md' }, { title: ' Sleep ', mapPath: 'A/x/Map.md' }, { title: 'Sleep', mapPath: 'A/y/Map.md' }]),
    [{ title: 'Sleep', folder: 'A/x', seq: 1 }, { title: ' Sleep ', folder: 'A/x', seq: 2 }, { title: 'Sleep', folder: 'A/y' }], 'the same path too: a number');
  eq(mapChoiceParts([]), []);
});
integrationTest('B2-0 F5: open_map with two maps of the same name lists them with their folders; different names show no path', async () => {
  const h = await harness(); await h.view.hydrate(); h.open();
  h.plugin.repo.topics = async () => [{ id: '1', title: 'Sleep', mapPath: 'Agent Workspace/Topics/a/Map.md' }, { id: '2', title: 'Sleep', mapPath: 'Agent Workspace/Topics/b/Map.md' }, { id: '3', title: 'Sleep log', mapPath: 'Agent Workspace/Topics/c/Map.md' }];
  const shown = []; h.view.chat.showChoices = choices => { shown.push(choices); };
  const outcome = await h.view.chatOpenMap('Sleep', { path: MAP, id: h.view.map.id }, () => true);
  eq(outcome.status, 'skipped'); eq(shown[0].options.map(o => o.label), ['Sleep (Agent Workspace/Topics/a)', 'Sleep (Agent Workspace/Topics/b)']);
  h.plugin.repo.topics = async () => [{ id: '3', title: 'Sleep log', mapPath: 'X/c/Map.md' }, { id: '4', title: 'Sleeping', mapPath: 'X/d/Map.md' }];
  await h.view.chatOpenMap('Sleep', { path: MAP, id: h.view.map.id }, () => true); eq(shown[1].options.map(o => o.label), ['Sleep log', 'Sleeping'], 'different names: no path');
});

// ---- B2-0 F4: a batch of add_child rebuilds the derived data once ------------------------------------------------------
const countCalls = (h) => {
  const counts = { readMap: 0, scanMaps: 0, rebuild: 0 };
  for (const [owner, name, key] of [[h.repo, 'readMap', 'readMap'], [h.repo, 'scanMaps', 'scanMaps'], [h.plugin, 'rebuildDerivedData', 'rebuild']]) {
    const original = owner[name].bind(owner); owner[name] = async (...args) => { counts[key]++; return original(...args); };
  }
  return counts;
};
integrationTest('B2-0 F4: 100 add_child into a 150-card map rebuild the derived data once, not 100 times (counts logged)', async () => {
  const h = await harness({ empty: true, realRender: true, viaSync: true }); await h.view.hydrate();
  await apply(h, [addRoot('r', 'Root'), ...Array.from({ length: 149 }, (_, i) => addRoot(`s${i}`, `Seed ${i}`, 'new:r'))]);
  assert.equal(h.view.map.nodes.length, 150);
  const counts = countCalls(h);
  const lines = await apply(h, [addRoot('q', 'Root 2'), ...Array.from({ length: 99 }, (_, i) => addRoot(`n${i}`, `New ${i}`, 'new:q'))]);
  console.log(`B2-0 F4 counts: ${JSON.stringify(counts)}`);
  assert.ok(lines.filter(l => l.status === 'done').length >= 100);
  assert.equal(h.view.map.nodes.length, 250);
  assert.equal(counts.rebuild, 1, `rebuildDerivedData ${counts.rebuild}`); assert.ok(counts.scanMaps <= 1, `scanMaps ${counts.scanMaps}`);
});
integrationTest('B2-0 F4: a card that fails to be added still has the derived data rebuilt (once), and the other cards are made', async () => {
  const h = await harness({ empty: true, realRender: true, viaSync: true }); await h.view.hydrate(); const counts = countCalls(h);
  const createNote = h.repo.createNote.bind(h.repo); h.repo.createNote = async (title, ...rest) => { const made = await createNote(title, ...rest); if (title === 'Boom') throw new Error('disk full'); return made; };
  const actions = [addRoot('r', 'Root'), addRoot('a', 'A', 'new:r'), addRoot('b', 'Boom', 'new:r'), ...Array.from({ length: 4 }, (_, i) => addRoot(`c${i}`, `C${i}`, 'new:r'))];
  const lines = await apply(h, actions);
  eq(lines.filter(l => l.status === 'failed').length, 1); assert.ok(lines.filter(l => l.status === 'done').length >= 6);
  assert.equal(counts.rebuild, 1, `rebuilt once: ${counts.rebuild}`);
});
integrationTest('B2-0 F4: nothing added, nothing rebuilt; a reply that stops half way still rebuilds once for what it made', async () => {
  const h = await harness({ empty: true, realRender: true, viaSync: true }); await h.view.hydrate(); let counts = countCalls(h);
  await apply(h, [{ kind: 'auto_layout' }]); assert.equal(counts.rebuild, 0);
  let asked = 0; const lines = await apply(h, [addRoot('r', 'Root'), ...Array.from({ length: 8 }, (_, i) => addRoot(`c${i}`, `C${i}`, 'new:r'))], {}, () => ++asked < 6);
  assert.ok(lines.some(l => l.status === 'skipped')); assert.equal(counts.rebuild, 1);
});
integrationTest('B2-0 F4: an outside change to Map.md in the middle of a batch still raises the conflict window, once, and the batch goes on', async () => {
  const h = await harness({ empty: true, realRender: true, viaSync: true }); await h.view.hydrate(); let created = 0;
  const createNote = h.repo.createNote.bind(h.repo);
  h.repo.createNote = async (...args) => { const made = await createNote(...args); if (++created === 4) await h.repo.saveMap(MAP, { ...(await h.repo.readMap(MAP)), title: 'Edited outside' }); return made; };
  const lines = await apply(h, [addRoot('r', 'Root'), ...Array.from({ length: 7 }, (_, i) => addRoot(`c${i}`, `C${i}`, 'new:r'))]);
  assert.equal((h.control.modals ?? []).length, 1, 'the conflict window was asked once'); assert.ok(lines.filter(l => l.status === 'done').length >= 8);
});


// ---- B2-0 L4: new cards do not overlap after a stop or an auto_layout that came first ------------------------------------
// A card's height is only known once it was painted: the held repaint is flushed at a layout, so cards made after it are unmeasured.
const measuredHeights = (h, height = 500) => {
  let measured = new Set(); const flush = h.view.flushChatRender.bind(h.view);
  h.view.flushChatRender = () => { measured = new Set(h.view.map.nodes.map(n => n.id)); return flush(); };
  h.view.cardHeightOf = id => (measured.has(id) ? height : undefined);
};
const overlaps = (nodes, height = 500) => {
  const found = [];
  for (const a of nodes) for (const b of nodes) if (a.id < b.id && Math.abs(a.x - b.x) < 300 && a.y < b.y + height && b.y < a.y + height) found.push([a.id, b.id]);
  return found;
};
const spread = () => [addRoot('r', 'Root'), ...Array.from({ length: 9 }, (_, i) => addRoot(`c${i}`, `Kid ${i}`, 'new:r'))];
integrationTest('B2-0 L4: stopping a batch places the new cards that exist so far without overlap, skips what is left, and re-lays nothing else', async () => {
  const h = await harness({ empty: true, realRender: true, viaSync: true }); await h.view.hydrate(); measuredHeights(h);
  let asked = 0; const alive = () => ++asked < 7;
  const lines = await apply(h, [...spread(), { kind: 'rename_topic', nodeId: 'zzz', title: 'late' }], {}, alive);
  const created = h.view.map.nodes.length; assert.ok(created >= 3 && created < 10, `part was created: ${created}`);
  assert.ok(lines.some(l => l.status === 'skipped'), 'the rest is skipped'); assert.equal(lines.some(l => /Arranged/.test(l.text)), false, 'no automatic layout line');
  eq(overlaps(h.view.map.nodes), [], 'no two cards overlap');
  eq(overlaps(await h.saved()), [], 'and the saved map is the same');
  assert.equal(h.view.renderHold, 0);
});
integrationTest('B2-fix L4: a Stop that lands right after the last add_child still places the new cards locally, no overlap', async () => {
  const h = await harness({ empty: true, realRender: true, viaSync: true }); await h.view.hydrate(); measuredHeights(h);
  let stopped = false, writes = 0; const original = h.view.applyChatWrite.bind(h.view);
  h.view.applyChatWrite = async (...args) => { const outcome = await original(...args); if (++writes === 10) stopped = true; return outcome; };
  const lines = await apply(h, spread(), {}, () => !stopped);
  assert.equal(writes, 10); assert.equal(h.view.map.nodes.length, 10, 'every card was written');
  assert.equal(lines.some(l => /Arranged/.test(l.text)), false, 'a stopped reply gets no automatic layout line');
  eq(overlaps(h.view.map.nodes), [], 'no two cards overlap'); eq(overlaps(await h.saved()), [], 'and the saved map is the same');
  assert.equal(h.view.renderHold, 0);
});
integrationTest('B2-0 L4: an auto_layout that comes before the add_child actions does not leave the later cards overlapping', async () => {
  const h = await harness({ empty: true, realRender: true, viaSync: true }); await h.view.hydrate(); measuredHeights(h);
  const all = spread(); const lines = await apply(h, [...all.slice(0, 4), { kind: 'auto_layout' }, ...all.slice(4)]);
  assert.equal(lines.filter(l => l.status === 'done').length, 11); assert.equal(h.view.map.nodes.length, 10);
  eq(overlaps(h.view.map.nodes), [], 'no two cards overlap');
});
integrationTest('B2-0 L4: a reply with one automatic layout at the end is laid out as before (the whole map, once)', async () => {
  const h = await harness({ empty: true, realRender: true, viaSync: true }); await h.view.hydrate(); measuredHeights(h);
  let layouts = 0; const original = h.view.mapChange.bind(h.view); h.view.mapChange = async (change, rebuild) => { if (rebuild === false) layouts++; return original(change, rebuild); };
  const lines = await apply(h, spread()); assert.ok(lines.some(l => /Arranged/.test(l.text))); assert.equal(layouts, 1, 'one layout, no extra local step'); eq(overlaps(h.view.map.nodes), []);
});

// ---- B2-feat: research options, shallow research, headless integration, two merges ---------------------------------------
const researchAct = (fields = {}) => ({ kind: 'run_map_action', action: 'research_standard', nodeIds: [], title: '', goal: '', direction: '', mode: '', images: false, ...fields });
const startedResearch = h => { const started = []; h.view.startMultiResearch = async (request, key, onSettled) => { started.push({ request, key, onSettled, selected: [...h.view.multiSelected], depth: h.control.depth }); }; return started; };
const newCard = ref => ({ kind: 'add_child', parentId: '', title: `Card ${ref}`, summary: '', ref });

const quickRequest = { mapAiMode: 'quick', researchMode: 'local', researchDepth: 'normal', requirements: '', imageSearch: false };
const standardRequest = { mapAiMode: 'standard', researchMode: 'research', researchDepth: 'normal', requirements: '', imageSearch: false };
integrationTest('B2/D-231 research: a named mode, images and the extra requirement reach startMultiResearch; unnamed uses the map mode (none = Quick); Quick never gets images', async () => {
  const h = await harness(); await h.view.hydrate(); const started = startedResearch(h);
  const lines = await apply(h, [
    researchAct({ nodeIds: [h.ids.a] }),
    researchAct({ nodeIds: [h.ids.b], mode: 'standard', images: true, direction: 'only peer-reviewed' }),
    researchAct({ nodeIds: [h.ids.c], mode: 'quick', images: true })
  ]);
  eq(lines.map(l => l.status), ['done', 'done', 'done'], JSON.stringify(lines)); await tick();
  eq(started.map(s => s.request), [quickRequest, { ...standardRequest, requirements: 'only peer-reviewed', imageSearch: true }, quickRequest]);
  eq(started.map(s => s.selected), [[h.ids.a], [h.ids.b], [h.ids.c]]); assert.ok(started.every(s => s.depth === 0), 'outside any mutate');
});
integrationTest('D-231 counterexample (mode resolution): named Quick + map Standard = Quick; only "research" + map Standard = Standard; only "research" + no map mode = Quick; a chat research never changes the map mode', async () => {
  const h = await harness(); await h.view.hydrate(); const started = startedResearch(h);
  h.view.map.aiMode = 'standard';
  await apply(h, [researchAct({ nodeIds: [h.ids.a], mode: 'quick' }), researchAct({ nodeIds: [h.ids.b] })]); await tick();
  eq(started.map(s => s.request.mapAiMode), ['quick', 'standard']); eq(started.map(s => s.request.researchMode), ['local', 'research']);
  delete h.view.map.aiMode;
  await apply(h, [researchAct({ nodeIds: [h.ids.a] })]); await tick();
  assert.equal(started[2].request.mapAiMode, 'quick');
  h.view.map.aiMode = 'quick'; await apply(h, [researchAct({ nodeIds: [h.ids.a], mode: 'standard' })]); await tick();
  assert.equal(started[3].request.mapAiMode, 'standard'); assert.equal(h.view.map.aiMode, 'quick', 'the map mode is remembered only by the dialog');
  assert.equal((await h.repo.readMap(MAP)).aiMode, undefined, 'nothing was written for it');
});
integrationTest('D-231: the real startMultiResearch override path runs the batch in the mode the chat asked for (Quick: local, no charts, Quick prompt context; Standard: research)', async () => {
  const h = await harness(); await h.view.hydrate();
  const runs = [];
  h.view.researchChild = async (child, _signal, accepted, choices, charts, done) => { runs.push({ id: child.id, mode: choices.researchMode, depth: choices.researchDepth, visual: choices.visualMode, mapAiMode: choices.mapAiMode, charts }); accepted(); done?.({ retrievals: 2 }); };
  for (const [mode, expected] of [['quick', { mode: 'local', depth: 'normal', visual: 'off', mapAiMode: 'quick', charts: false }], ['standard', { mode: 'research', depth: 'normal', visual: 'off', mapAiMode: 'standard', charts: true }]]) {
    runs.length = 0; h.view.chatSelect([h.ids.a]);
    const request = chatResearchRequest({ ...researchAct({ nodeIds: [h.ids.a] }), mode }, undefined, m => aiModeOptions(m, 'research'));
    await h.view.startMultiResearch(request); await withTimeout(until(() => runs.length === 1), 3000);
    eq(runs, [{ id: h.ids.a, ...expected }]);
  }
});
integrationTest('D-231: researching cards the reply created no longer means a fast first look: the mode comes from the user\'s words, the map mode, then Quick', async () => {
  const h = await harness(); await h.view.hydrate(); const started = startedResearch(h);
  await apply(h, [newCard('n1'), newCard('n2'), researchAct({ nodeIds: ['new:n1', 'new:n2'] })]); await tick();
  assert.equal(started.length, 1); eq(started[0].request, quickRequest); assert.equal(started[0].selected.length, 2);
  h.view.map.aiMode = 'standard';
  await apply(h, [newCard('n3'), researchAct({ nodeIds: ['new:n3'] })]); await tick();
  eq(started[1].request, standardRequest, 'new cards only + map Standard: Standard, not fast');
  await apply(h, [newCard('n4'), researchAct({ nodeIds: ['new:n4', h.ids.a], mode: 'quick' })]); await tick();
  eq(started[2].request, quickRequest); assert.equal(started[2].selected.length, 2);
  await apply(h, [newCard('n5'), researchAct({ nodeIds: [] })]); await tick();
  eq(started[3].request, standardRequest, 'an empty target list (the current selection) follows the map mode');
});
integrationTest('B2 shallow research: researching 12 new cards waits as a plan; after Apply all 12 are in one Quick research batch', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); const started = startedResearch(h);
  const refs = Array.from({ length: 12 }, (_, i) => `r${i}`);
  h.control.reply = async () => ({ reply: 'I will build and research.', actions: [...refs.map(newCard), researchAct({ nodeIds: refs.map(r => `new:${r}`) })], rejected: [] });
  h.type('build and research'); await h.view.sendMapChat();
  assert.equal(started.length, 0, 'nothing runs before Apply'); assert.equal(h.view.map.nodes.length, 4);
  assert.match(visibleText(planCard(h)[0]), /Starts research on 12 topics/); assert.match(visibleText(planCard(h)[0]), /At least 12 AI calls/, 'Quick (no map mode): 12 research calls, no diagram call');
  planButton(h, 'apply').click(); await until(() => chat.pendingPlan() === null && !h.view.chatApplying); await tick();
  assert.equal(started.length, 1); assert.equal(started[0].selected.length, 12); eq(started[0].request, quickRequest); assert.equal(h.view.map.nodes.length, 16);
});
integrationTest('B2 shallow research: 9 new cards researched are applied at once with no plan card', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); const started = startedResearch(h);
  const refs = Array.from({ length: 9 }, (_, i) => `r${i}`);
  h.control.reply = async () => ({ reply: 'ok', actions: [...refs.map(newCard), researchAct({ nodeIds: refs.map(r => `new:${r}`) })], rejected: [] });
  h.type('go'); await h.view.sendMapChat(); await tick();
  assert.equal(planCard(h).length, 0); assert.equal(chat.pendingPlan(), null); assert.equal(started.length, 1); assert.equal(started[0].selected.length, 9);
});
integrationTest('B2 research: a research batch already running is skipped with a reason in the result, and nothing is started', async () => {
  const h = await harness(); await h.view.hydrate(); const started = startedResearch(h);
  h.plugin.expansionCoordinator.isRunning = () => true;
  const lines = await apply(h, [researchAct({ nodeIds: [h.ids.a] })]);
  eq(lines.map(l => l.status), ['skipped']); assert.match(lines[0].text, /research is already running/); assert.equal(started.length, 0);
});
integrationTest('B2 research: the finished batch adds its search count to the answer; a topic with no search is warned about; a newer turn is not touched', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open(); const started = startedResearch(h);
  h.control.reply = async () => ({ reply: 'Researching.', actions: [researchAct({ nodeIds: [h.ids.a, h.ids.b] })], rejected: [] });
  h.type('research a and b'); await h.view.sendMapChat(); await tick();
  assert.equal(started.length, 1); assert.equal(typeof started[0].onSettled, 'function');
  started[0].onSettled({ searches: 5, counted: 2, withoutSearch: 1 });
  const texts = chat.transcript().at(-1).lines.map(l => [l.status, l.text]);
  eq(texts.slice(-2), [['done', 'Web searches made: 5.'], ['skipped', 'Warning: topics that finished without any web search: 1.']]);
  started[0].onSettled({ searches: 0, counted: 0, withoutSearch: 0 });
  assert.equal(chat.transcript().at(-1).lines.length, texts.length, 'nothing to report adds nothing');
  h.control.reply = async () => ({ reply: 'Next.', actions: [], rejected: [] });
  h.type('something else'); await h.view.sendMapChat();
  const before = chat.transcript().at(-1).lines.length; started[0].onSettled({ searches: 9, counted: 1, withoutSearch: 0 });
  assert.equal(chat.transcript().at(-1).lines.length, before, 'a later turn does not get the old batch\'s lines');
});
integrationTest('B2 merge: two merges in one reply are both completed; the second is not skipped as locked', async () => {
  const h = await harness({ viaSync: false }); await h.view.hydrate();
  const refs = ['p1', 'p2', 'p3', 'p4'].map(ref => ({ kind: 'add_child', parentId: h.ids.root, title: `Merge ${ref}`, summary: '', ref }));
  const merge = (a, b, title) => ({ kind: 'run_map_action', action: 'merge', nodeIds: [a, b], title, goal: '', direction: '', mode: '', images: false });
  const lines = await apply(h, [...refs, merge('new:p1', 'new:p2', 'First merged'), merge('new:p3', 'new:p4', 'Second merged')]);
  eq(lines.slice(0, 6).map(l => l.status), ['done', 'done', 'done', 'done', 'done', 'done'], JSON.stringify(lines));
  const titles = []; for (const n of await h.saved()) titles.push((await h.repo.readNote(n.path)).title);
  assert.ok(titles.includes('First merged') && titles.includes('Second merged'), titles.join('|'));
  assert.ok(!titles.some(t2 => /^Merge p\d$/.test(t2)), 'the four sources are gone from the map');
  assert.equal(h.view.mergeTasks.size, 0); assert.equal(h.control.nested, 0);
});
integrationTest('B2 merge: a merge still locked by an AI merge is skipped with the locked reason', async () => {
  const h = await harness(); await h.view.hydrate();
  h.view.mergeTasks.set(h.view.path, { mapPath: h.view.path, sources: [{ id: h.ids.a, path: h.node('a').path }], controller: new AbortController(), state: 'running' });
  const lines = await apply(h, [{ kind: 'run_map_action', action: 'merge', nodeIds: [h.ids.a, h.ids.b], title: 'X', goal: '', direction: '', mode: '', images: false }]);
  eq(lines.map(l => l.status), ['skipped']); assert.match(lines[0].text, /being merged/);
});
integrationTest('B2 synthesize: the plan card keeps the user\'s message as the integration direction', async () => {
  const h = await harness(); await h.view.hydrate(); const chat = h.open();
  const calls = []; h.view.startSynthesis = async (node, options, direction, failed, accepted) => { calls.push({ id: node.id, direction, options }); accepted(); };
  h.control.reply = async () => ({ reply: 'plan', actions: [...Array.from({ length: 15 }, (_, i) => ({ kind: 'add_child', parentId: h.ids.root, title: `Card ${i}`, summary: '' })), { kind: 'run_map_action', action: 'synthesize', nodeIds: [h.ids.a], title: '', goal: '', direction: 'ignored model words', mode: '', images: false }], rejected: [] });
  h.type('Integrate Body around sleep debt'); await h.view.sendMapChat();
  assert.equal(chat.pendingPlan().state, 'pending'); assert.equal(calls.length, 0);
  assert.match(visibleText(planCard(h)[0]), /At least 2 AI calls/);
  planButton(h, 'apply').click(); await until(() => chat.pendingPlan() === null && !h.view.chatApplying);
  assert.equal(calls.length, 1); assert.equal(calls[0].id, h.ids.a); assert.equal(calls[0].direction, 'Integrate Body around sleep debt', 'the message, not the model\'s direction');
  const o = calls[0].options; eq([o.researchMode, o.visualMode, o.synthesisContent, 'depth' in o && o.depth !== undefined], ['local', 'off', 'full', false], 'an integration from the chat is always Quick (D-2026-10-229)');
});

// ---- B3-feat: find_images (candidates, insertion, lifecycle) and "save as a note" ----------------------------------------
const { localDate, transcriptMarkdown } = load('core/map-chat-transcript.ts');
const imageItems = count => Array.from({ length: count }, (_, i) => ({ title: `Pic ${i}`, url: `https://img.example/${i}.jpg`, source: `https://page.example/${i}` }));
const findAct = (h, key, extra = {}) => ({ kind: 'run_map_action', action: 'find_images', nodeIds: key ? [h.ids[key]] : [], title: '', goal: '', direction: 'espresso', depth: '', images: false, ...extra });
const lastImages = (h, at = 0) => h.view.chat.transcript().at(-1).images?.[at];
const pickButtons = h => findAll(h.view.chat.logEl, i => i.tag === 'button' && hasClass(i, 'vam-map-chat-images-pick'));
const noteFile = (h, key) => h.node(key).path;
/** A conversation with one open turn (the reply is still "streaming"), as while a reply's actions are applied. */
async function imageHarness(options) {
  const h = await harness(options); await h.view.hydrate();
  const chat = h.open(); chat.begin('find a picture for Body');
  return { h, chat };
}
/** Starts a search for card `key`, lets it finish with `count` candidates and returns the ready block. */
async function readyImages(h, count = 3, key = 'a') {
  h.control.search = async () => imageItems(count);
  const lines = await apply(h, [findAct(h, key)]);
  assert.equal(lines[0].status, 'done', JSON.stringify(lines));
  await withTimeout(until(() => lastImages(h)?.state !== 'searching'));
  return lastImages(h);
}

integrationTest('B3 find_images: the chat only picks the card and the words; the search runs through the card\'s own model after its usage notice, and nothing is written', async () => {
  const { h, chat } = await imageHarness();
  const gate = deferred(); h.control.search = async () => { await gate.promise; return imageItems(8); };
  const file = noteFile(h, 'a'); const before = h.contents.get(file); const note = await h.note('a');
  const lines = await apply(h, [findAct(h, 'a')]);
  eq(lines.map(l => l.status), ['done']); assert.equal(lines[0].text, 'Started looking for pictures for “Body”', 'a start is not a "Done"'); assert.doesNotMatch(lines[0].text, /Done/);
  assert.equal(h.control.searches.length, 1); assert.equal(h.control.searches[0].query, 'espresso', 'the search words are the direction');
  assert.equal(h.control.searches[0].model, note.model, 'the card\'s model, not the chat model'); assert.equal(h.control.models.at(-1), note.model, 'asked its usage notice first');
  assert.equal(h.control.calls.filter(c => c === 'chat').length, 0, 'the chat itself made no request of its own here');
  const block = lastImages(h); assert.equal(block.state, 'searching'); assert.equal(block.nodeId, h.ids.a);
  assert.match(visibleText(h.view.chat.logEl), /Looking for pictures: espresso/); assert.ok(findAll(h.view.chat.logEl, i => hasClass(i, 'vam-map-chat-images-stop')).length === 1, 'a Stop button while it runs');
  gate.resolve(); await withTimeout(until(() => block.state === 'ready'));
  assert.equal(block.items.length, 6, 'at most six');
  assert.equal(h.contents.get(file), before, 'listing candidates writes nothing to the card'); assert.equal(chat.isBusy, true, 'the turn itself is not touched');
});
integrationTest('B3 find_images: each candidate is a button and a source link; thumbnails are https only, lazy and without a referrer; titles are text', async () => {
  const { h } = await imageHarness();
  h.control.search = async () => [{ title: '<img src=x onerror=alert(1)>', url: 'https://img.example/x.jpg', source: 'https://page.example/x' }, ...imageItems(1)];
  await apply(h, [findAct(h, 'a')]); await withTimeout(until(() => lastImages(h)?.state === 'ready'));
  const buttons2 = pickButtons(h); assert.equal(buttons2.length, 2);
  assert.equal(buttons2[0].attrs['aria-label'], 'Insert: <img src=x onerror=alert(1)> into Body');
  const thumbs = findAll(h.view.chat.logEl, i => i.tag === 'img'); assert.equal(thumbs.length, 2);
  for (const thumb of thumbs) { assert.equal(thumb.attrs.referrerpolicy, 'no-referrer'); assert.equal(thumb.attrs.loading, 'lazy'); assert.equal(thumb.attrs.alt, ''); assert.match(thumb.attrs.src, /^https:\/\//); assert.ok(hasClass(thumb, 'vam-map-chat-images-thumb')); }
  const links = findAll(h.view.chat.logEl, i => i.tag === 'a' && hasClass(i, 'vam-map-chat-images-source'));
  assert.equal(links.length, 2); assert.equal(links[0].attrs.href, 'https://page.example/x'); assert.equal(links[0].attrs.target, '_blank'); assert.equal(links[0].attrs.rel, 'noopener noreferrer'); assert.equal(links[0].text, 'Source page');
  assert.ok(visibleText(h.view.chat.logEl).includes('<img src=x onerror=alert(1)>'), 'shown as text');
  assert.equal(findAll(h.view.chat.logEl, i => i.tag === 'img' && !hasClass(i, 'vam-map-chat-images-thumb')).length, 0, 'no other picture is ever created');
});
integrationTest('B3 find_images: nothing that loads means a sentence and no insertion', async () => {
  const { h } = await imageHarness(); h.control.probe = async () => [];
  const file = noteFile(h, 'a'); const before = h.contents.get(file);
  const block = await readyImages(h);
  assert.equal(block.state, 'empty'); assert.match(visibleText(h.view.chat.logEl), /No loadable picture was found\. Nothing was inserted\./);
  assert.equal(pickButtons(h).length, 0); assert.equal(h.contents.get(file), before);
});
integrationTest('B3 find_images: a failed search says why, in words', async () => {
  const { h } = await imageHarness(); h.control.search = async () => { throw new Error('quota used up'); };
  await apply(h, [findAct(h, 'a')]); await withTimeout(until(() => lastImages(h)?.state === 'failed'));
  assert.match(visibleText(h.view.chat.logEl), /The picture search failed: quota used up/); assert.equal(lastImages(h).reason, 'quota used up');
});
integrationTest('B3 find_images: the Stop button ends the search; a result that arrives afterwards is neither shown nor written', async () => {
  const { h } = await imageHarness(); const gate = deferred(); let probed = 0;
  h.control.search = async () => { await gate.promise; return imageItems(2); }; h.control.probe = async found => { probed++; return found; };
  const file = noteFile(h, 'a'); const before = h.contents.get(file);
  await apply(h, [findAct(h, 'a')]); const block = lastImages(h);
  find(h.view.chat.logEl, i => hasClass(i, 'vam-map-chat-images-stop')).click();
  assert.equal(block.state, 'stopped'); assert.equal(h.control.searches[0].signal.aborted, true); assert.equal(h.view.chatImageSearches.size, 0);
  assert.match(visibleText(h.view.chat.logEl), /The picture search was stopped\. Nothing was inserted\./);
  gate.resolve(); await tick(); await tick();
  assert.equal(block.state, 'stopped'); assert.equal(block.items.length, 0); assert.equal(probed, 0); assert.equal(h.contents.get(file), before);
});
integrationTest('B3 find_images: closing the view, or opening another map by hand, stops the search and nothing late is shown or written', async () => {
  for (const how of ['close', 'switch']) {
    const { h, chat } = await imageHarness(); const gate = deferred(); let probed = 0; let settled = 0;
    h.control.search = async () => { await gate.promise; return imageItems(2); }; h.control.probe = async found => { probed++; return found; };
    const settle = chat.settleImages.bind(chat); chat.settleImages = (...args) => { settled++; return settle(...args); };
    const file = noteFile(h, 'a'); const before = h.contents.get(file);
    await apply(h, [findAct(h, 'a')]); assert.equal(h.view.chatImageSearches.size, 1);
    if (how === 'close') { h.view.closed = true; h.view.abortMapChat(); }
    else { h.view.map = { ...h.view.map, id: 'map-b' }; h.repaint(); }
    assert.equal(h.control.searches[0].signal.aborted, true, how); assert.equal(h.view.chatImageSearches.size, 0, how);
    gate.resolve(); await tick(); await tick();
    assert.equal(probed, 0, how); assert.equal(settled, 0, `${how}: appendImages-style update never called`); assert.equal(h.contents.get(file), before, how);
  }
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  const close = source.slice(source.indexOf('async onClose()'), source.indexOf('this.dropMapBackground();', source.indexOf('async onClose()')));
  assert.ok(close.includes('this.abortMapChat()'), 'onClose stops the chat\'s searches through abortMapChat');
  const abort = source.slice(source.indexOf('private abortMapChat()'), source.indexOf('private abortMapChat()') + 400);
  assert.ok(abort.includes('this.abortChatImageSearches()'));
});
integrationTest('B3 find_images: the conversation moved to another map while the search ran (not stopped): the result is dropped with a reason, not written', async () => {
  const { h } = await imageHarness(); const gate = deferred(); let probed = 0;
  h.control.search = async () => { await gate.promise; return imageItems(2); }; h.control.probe = async found => { probed++; return found; };
  await apply(h, [findAct(h, 'a')]); const block = lastImages(h);
  h.view.map = { ...h.view.map, id: 'map-other' };
  gate.resolve(); await withTimeout(until(() => block.state === 'failed'));
  assert.equal(block.reason, 'The map was switched. Nothing was inserted.'); assert.equal(probed, 0); assert.equal(block.items.length, 0);
});
integrationTest('B3 find_images: a declined usage notice starts nothing', async () => {
  const { h } = await imageHarness(); h.control.decline = true;
  const lines = await apply(h, [findAct(h, 'a')]);
  eq(lines.map(l => l.status), ['skipped']); assert.match(lines[0].text, /the AI task did not start/); assert.equal(h.control.searches.length, 0); assert.equal(lastImages(h), undefined);
});
integrationTest('B3 find_images: one card is the target; an empty list takes the selection only when it is exactly one card', async () => {
  const { h } = await imageHarness();
  h.view.selected = null; h.view.multiSelected = new Set();
  let lines = await apply(h, [findAct(h, null)]); assert.equal(lines[0].status, 'skipped'); assert.match(lines[0].text, /name exactly one card first/);
  h.view.multiSelected = new Set([h.ids.a, h.ids.b]);
  lines = await apply(h, [findAct(h, null)]); assert.equal(lines[0].status, 'skipped'); assert.match(lines[0].text, /name exactly one card first/);
  assert.equal(h.control.searches.length, 0);
  h.view.multiSelected = new Set(); h.view.selected = h.ids.b;
  lines = await apply(h, [findAct(h, null, { direction: '' })]); assert.equal(lines[0].status, 'done'); assert.match(lines[0].text, /for “Mind”/);
  assert.equal(h.control.searches[0].query, 'Mind', 'no search words: the card\'s title');
  lines = await apply(h, [findAct(h, null, { nodeIds: ['gone'] })]); assert.equal(lines[0].status, 'skipped'); assert.match(lines[0].text, /no longer on the map/);
});
integrationTest('B3 find_images: a card the same reply created is the target through its new: ref', async () => {
  const { h } = await imageHarness();
  const lines = await apply(h, [{ kind: 'add_child', parentId: h.ids.root, title: 'Fresh card', summary: '', ref: 'n1' }, findAct(h, null, { nodeIds: ['new:n1'] })]);
  eq(lines.map(l => l.status), ['done', 'done'], JSON.stringify(lines)); assert.match(lines[1].text, /for “Fresh card”/);
  assert.equal(lastImages(h).nodeTitle, 'Fresh card');
});
integrationTest('B3 find_images: the fourth find_images of one reply is skipped; the first three start', async () => {
  const { h } = await imageHarness();
  const lines = await apply(h, [findAct(h, 'a'), findAct(h, 'b'), findAct(h, 'c'), findAct(h, 'root')]);
  eq(lines.map(l => l.status), ['done', 'done', 'done', 'skipped'], JSON.stringify(lines)); assert.match(lines[3].text, /at most 3 picture searches per reply/);
  assert.equal(h.control.searches.length, 3);
  const { planFor } = load('core/map-chat-plan.ts');
  assert.equal(planFor([{ kind: 'create_map', title: 'Q' }, ...Array.from({ length: 4 }, () => ({ kind: 'run_map_action', action: 'find_images', nodeIds: ['x'], title: '', goal: '', direction: '', depth: '', images: false }))], { parents: {}, selectedCount: 0 }).estimatedCalls, 3);
});
integrationTest('B3 find_images: a plan card counts one AI call for a find_images', async () => {
  const { h } = await imageHarness();
  h.control.reply = async () => ({ reply: 'plan', actions: [...Array.from({ length: 15 }, (_, i) => ({ kind: 'add_child', parentId: h.ids.root, title: `Card ${i}`, summary: '' })), findAct(h, 'a')], rejected: [] });
  h.view.chat.reset(); h.type('Add cards and find a picture for Body'); await h.view.sendMapChat();
  assert.match(visibleText(planCard(h)[0]), /At least 1 AI call/);
});
integrationTest('B3 candidates stay under the reply that asked for them when the next message is sent', async () => {
  const { h, chat } = await imageHarness(); await readyImages(h, 2);
  chat.finish('I will list pictures.', []); const block = lastImages(h);
  chat.begin('and another question'); chat.finish('fine', []);
  assert.equal(chat.transcript()[1].images[0], block); assert.equal(pickButtons(h).length, 2, 'still on screen and usable');
});
integrationTest('B3 insert: a click writes the picture and its source to the end of the Detail after a blank line, as one undoable edit; the other candidates stay usable', async () => {
  const { h } = await imageHarness(); const block = await readyImages(h, 3);
  await h.repo.updateNote(noteFile(h, 'a'), { detail: 'Body detail text\n' }); await h.view.hydrate();
  h.view.history.push({ undo: async () => {}, redo: async () => {}, label: 'earlier' });
  h.control.mutates = 0; const buttonsBefore = pickButtons(h);
  buttonsBefore[1].click(); buttonsBefore[1].click(); // a second click while the first runs does nothing
  await withTimeout(until(() => block.items[1].inserted));
  assert.equal(h.control.mutates, 1, 'one write for two clicks');
  const note = await h.note('a');
  assert.equal(note.detail, 'Body detail text\n\n![Pic 1](<https://img.example/1.jpg>)\n\n[Pic 1](<https://page.example/1>)');
  assert.equal(block.items[1].inserted, 'Body');
  const after = pickButtons(h); assert.equal(after[1].attrs['aria-disabled'], 'true'); assert.match(visibleText(after[1]), /Inserted into “Body”/);
  assert.equal(after[0].attrs['aria-disabled'], 'false'); assert.equal(after[2].attrs['aria-disabled'], 'false');
  assert.equal(h.view.history.canUndo, true, 'an ordinary edit: the undo history is not cleared');
  await h.view.history.undoEntry.undo(); assert.equal((await h.repo.readNote(h.node('a').path)).detail, 'Body detail text', 'undo puts the Detail back');
  // Another candidate of the same set goes after the first.
  await h.repo.updateNote(noteFile(h, 'a'), { detail: note.detail }); await h.view.hydrate();
  pickButtons(h)[2].click(); await withTimeout(until(() => block.items[2].inserted));
  assert.ok((await h.note('a')).detail.endsWith('![Pic 2](<https://img.example/2.jpg>)\n\n[Pic 2](<https://page.example/2>)'));
});
integrationTest('B3 insert: an empty Detail gets the picture alone; a title with brackets is cleaned by imageMarkdown', async () => {
  const { h } = await imageHarness(); h.control.search = async () => [{ title: 'A [b] \\ c', url: 'https://img.example/p.jpg', source: 'https://page.example/p' }];
  await apply(h, [findAct(h, 'b')]); await withTimeout(until(() => lastImages(h)?.state === 'ready'));
  await h.repo.updateNote(noteFile(h, 'b'), { detail: '' }); await h.view.hydrate();
  pickButtons(h)[0].click(); await withTimeout(until(() => lastImages(h).items[0].inserted));
  assert.equal((await h.note('b')).detail, '![A  b    c](<https://img.example/p.jpg>)\n\n[A  b    c](<https://page.example/p>)', 'each bracket and backslash became a blank');
});
integrationTest('B3 insert: stale fences - another map, a card that is gone, a merge, a running AI task and a read-only map each refuse in words and write nothing', async () => {
  const cases = [
    ['another map', h => { h.view.map = { ...h.view.map, id: 'map-x' }; }, /The map was switched/],
    ['another path', h => { h.view.path = 'Agent Workspace/Topics/other/Map.md'; }, /The map was switched/],
    ['card gone', h => { h.view.map.nodes = h.view.map.nodes.filter(n => n.id !== h.ids.a); }, /no longer on the map/],
    ['merging', h => { h.view.mergeTasks.set(h.view.path, { mapPath: h.view.path, sources: [{ id: h.ids.a, path: h.node('a').path }], controller: new AbortController(), state: 'running' }); }, /being merged/],
    ['AI running (activeTasks)', h => { h.plugin.activeTasks.set(h.node('a').path, new AbortController()); }, /AI is working on the card/],
    ['AI running (running)', h => { h.plugin.running.add(h.node('a').path); }, /AI is working on the card/],
    ['built-in sample', h => { h.view.builtIn = true; }, /cannot be edited/],
    ['AIM map', h => { h.view.map.aim = { version: 1, branches: [], runs: [], pendingCommits: [] }; }, /cannot be edited/]
  ];
  for (const [label, spoil, reason] of cases) {
    const { h } = await imageHarness(); const block = await readyImages(h, 2);
    const file = noteFile(h, 'a'); const before = h.contents.get(file); const guard = new AbortController(); h.plugin.activeTasks.set('probe', guard);
    spoil(h);
    pickButtons(h)[0].click(); await withTimeout(until(() => block.notice));
    assert.match(block.notice, reason, label); assert.equal(block.items[0].inserted, undefined, label); assert.equal(h.contents.get(file), before, `${label}: the card is untouched`);
    assert.equal(guard.signal.aborted, false, `${label}: nothing running was aborted`);
    for (const task of h.plugin.activeTasks.values()) assert.equal(task.signal.aborted, false, label);
    assert.match(visibleText(h.view.chat.logEl), reason, `${label}: the reason is on screen`);
    assert.equal(pickButtons(h)[0].attrs['aria-disabled'], 'false', `${label}: the candidate can be tried again`);
  }
});
integrationTest('B3 insert: the fences are checked again inside the write, where a merge that started in between is seen', async () => {
  const { h } = await imageHarness(); const block = await readyImages(h, 1);
  const file = noteFile(h, 'a'); const before = h.contents.get(file); const mutate = h.plugin.mutate.bind(h.plugin);
  h.plugin.mutate = work => { h.view.mergeTasks.set(h.view.path, { mapPath: h.view.path, sources: [{ id: h.ids.a, path: h.node('a').path }], controller: new AbortController(), state: 'running' }); return mutate(work); };
  pickButtons(h)[0].click(); await withTimeout(until(() => block.notice));
  assert.match(block.notice, /being merged/); assert.equal(h.contents.get(file), before);
});
integrationTest('B3 insert: a failing write is reported on the candidate and does not mark it inserted', async () => {
  const { h } = await imageHarness(); const block = await readyImages(h, 1);
  h.view.noteChange = async () => { throw new Error('disk full'); };
  pickButtons(h)[0].click(); await withTimeout(until(() => block.notice));
  assert.match(block.notice, /Could not insert the picture: disk full/); assert.equal(block.items[0].inserted, undefined);
  assert.equal(h.notices.filter(n => /disk full/.test(n)).length, 0, 'the reason is in the candidate block; no Notice on top');
});
integrationTest('B3 find_images: nothing is inserted unless a candidate is clicked; a hostile reply with an image becomes neither a candidate nor an insertion', async () => {
  const { h, chat } = await imageHarness(); const file = noteFile(h, 'a'); const before = h.contents.get(file);
  const hostile = 'Here: ![](https://evil.example/x.png) and ![[Notes/Other]] <img src=https://evil.example/y.png>';
  chat.finish(hostile, []);
  assert.equal(findAll(h.view.chat.logEl, i => i.tag === 'img').length, 0, 'the reply builds no picture'); assert.equal(lastImages(h), undefined, 'and no candidate');
  assert.equal(h.contents.get(file), before);
});
integrationTest('B3 find_images: the reader hears the candidates once, not while a reply streams', async () => {
  const { h, chat } = await imageHarness(); const gate = deferred();
  h.control.search = async () => { await gate.promise; return imageItems(2); };
  await apply(h, [findAct(h, 'a')]); assert.equal(chat.liveEl.text, '', 'silent while searching');
  gate.resolve(); await withTimeout(until(() => lastImages(h).state === 'ready'));
  assert.equal(chat.liveEl.text, '', 'the turn is still streaming: held back');
  chat.finish('Reply done', []);
  assert.match(chat.liveEl.text, /AI replied: Reply done/); assert.match(chat.liveEl.text, /Found 2 usable pictures\. Pick one to insert into “Body”\./);
  assert.equal(chat.liveEl.text.match(/Found 2 usable pictures/g).length, 1);
  chat.begin('next'); chat.finish('ok', []); assert.doesNotMatch(chat.liveEl.text, /Found 2 usable pictures/, 'said once');
  await readyImages(h, 2, 'b'); // a later search that ends while nothing streams is announced at once
});
integrationTest('B3 find_images: a thumbnail that cannot be loaded is marked in words and cannot be picked', async () => {
  const { h } = await imageHarness(); const block = await readyImages(h, 2);
  const thumb = findAll(h.view.chat.logEl, i => i.tag === 'img')[0]; thumb.fire('error');
  assert.equal(block.items[0].broken, true); const buttons2 = pickButtons(h);
  assert.equal(buttons2[1].attrs['aria-disabled'], 'true', 'the broken one moved behind the one that loads'); assert.match(visibleText(buttons2[1]), /Cannot load/);
  assert.equal(buttons2[0].attrs['aria-disabled'], 'false');
  const file = noteFile(h, 'a'); const before = h.contents.get(file); buttons2[1].click(); await tick();
  assert.equal(h.contents.get(file), before);
});
// ---- B3-polish P1-1: inserted and cannot-load look different ----
const sixWithOneBroken = async h => {
  const block = await readyImages(h, 6);
  findAll(h.view.chat.logEl, i => i.tag === 'img')[1].fire('error'); // Pic 1 does not load
  return block;
};
integrationTest('B3-polish P1-1: six candidates with one that cannot load say "5 usable", and the broken one is last, dashed and without a picture', async () => {
  const { h } = await imageHarness(); const block = await sixWithOneBroken(h);
  assert.match(visibleText(h.view.chat.logEl), /Found 5 usable pictures\. Pick one to insert into “Body”\./); assert.doesNotMatch(visibleText(h.view.chat.logEl), /Found 6/);
  const picks = pickButtons(h); assert.equal(picks.length, 6);
  eq(picks.map(p => hasClass(p, 'is-broken')), [false, false, false, false, false, true]);
  assert.equal(findAll(picks[5], i => i.tag === 'img').length, 0, 'a broken candidate has no picture element');
  assert.equal(findAll(picks[5], i => hasClass(i, 'vam-map-chat-images-missing')).length, 1, 'a dashed placeholder instead');
  assert.match(visibleText(picks[5]), /Cannot load/); assert.match(picks[5].attrs['aria-label'], /Insert: Pic 1 into Body/);
  eq(picks.slice(0, 5).map(p => findAll(p, i => i.tag === 'img').length), [1, 1, 1, 1, 1]);
  assert.equal(picks.filter(p => hasClass(p, 'is-inserted')).length, 0, 'cannot-load is not "inserted"');
});
integrationTest('B3-polish P1-1: a thumbnail that fails later rebuilds the row, and the keyboard stays on the same candidate button or source link', async () => {
  const { h } = await imageHarness(); const block = await readyImages(h, 3);
  const sources = () => findAll(h.view.chat.logEl, i => hasClass(i, 'vam-map-chat-images-source'));
  pickButtons(h)[0].focus(); findAll(h.view.chat.logEl, i => i.tag === 'img')[1].fire('error');
  assert.ok(block.items[1].broken); assert.ok(h.page.doc.activeElement === pickButtons(h)[0], 'the first candidate keeps the keyboard');
  sources()[1].focus(); const label = sources()[1].attrs['aria-label']; findAll(h.view.chat.logEl, i => i.tag === 'img')[0].fire('error');
  assert.ok(block.items[0].broken); assert.ok(h.page.doc.activeElement?.attrs?.['aria-label'] === label, 'the same source link keeps the keyboard');
  assert.ok(sources().includes(h.page.doc.activeElement), 'and it is the link in the new row');
});
integrationTest('B3-polish P1-1: all candidates broken reads as none; a probe that already dropped a candidate counts only the rest', async () => {
  const { h } = await imageHarness(); await readyImages(h, 2);
  for (const img of findAll(h.view.chat.logEl, i => i.tag === 'img')) img.fire('error');
  assert.match(visibleText(h.view.chat.logEl), /No loadable picture was found\. Nothing was inserted\./);
  assert.doesNotMatch(visibleText(h.view.chat.logEl), /Found 0/);
});
integrationTest('B3-polish P1-1: an inserted candidate keeps its picture and is told apart from cannot-load by a tick, the accent word and an outline; it still cannot be inserted twice', async () => {
  const { h } = await imageHarness(); const block = await readyImages(h, 3);
  findAll(h.view.chat.logEl, i => i.tag === 'img')[2].fire('error');
  pickButtons(h)[0].click(); await withTimeout(until(() => block.items[0].inserted));
  const [inserted, plain, broken] = pickButtons(h);
  assert.ok(hasClass(inserted, 'is-inserted')); assert.ok(!hasClass(inserted, 'is-broken')); assert.ok(!hasClass(plain, 'is-inserted') && !hasClass(plain, 'is-broken'));
  assert.ok(hasClass(broken, 'is-broken') && !hasClass(broken, 'is-inserted'));
  assert.equal(findAll(inserted, i => i.tag === 'img').length, 1, 'the inserted one keeps its picture');
  const mark = findAll(inserted, i => hasClass(i, 'vam-map-chat-images-state-icon'))[0]; assert.equal(mark.children[0]?.iconName ?? mark.iconName, 'check');
  assert.ok(findAll(inserted, i => hasClass(i, 'is-inserted') && hasClass(i, 'vam-map-chat-images-state')).length === 1); assert.match(visibleText(inserted), /Inserted into “Body”/);
  assert.equal(inserted.attrs['aria-disabled'], 'true'); const file = noteFile(h, 'a'); const before = h.contents.get(file);
  inserted.click(); await tick(); assert.equal(h.contents.get(file), before, 'no second insertion');
  assert.doesNotMatch(visibleText(inserted), /Cannot load/); assert.doesNotMatch(visibleText(plain), /Inserted/);
  // Obsidian dims every button[aria-disabled="true"] to opacity .7; the inserted one is not dimmed, so its picture keeps its colours.
  const rule = fs.readFileSync(path.join(root, 'styles.css'), 'utf8').split('\n').find(line => line.startsWith('.vam-map-chat .vam-map-chat-images-pick.is-inserted {')) ?? '';
  assert.match(rule, /opacity: 1;/);
});
// ---- B3-polish P1-2: the result line follows the candidate block ----
const resultTexts = h => findAll(h.view.chat.logEl, i => hasClass(i, 'vam-map-chat-line')).map(i => i.text);
integrationTest('B3-polish P1-2: the result line starts as "Started" and ends as the block ends (ready / empty / failed / stopped), never "Done" for a failure, on screen and in the saved turn', async () => {
  const cases = [
    ['ready', async h => { h.control.search = async () => imageItems(3); }, /^Done: found 3 pictures for “Body”$/, 'done'],
    ['empty', async h => { h.control.probe = async () => []; }, /^No loadable picture was found for “Body”$/, 'skipped'],
    ['failed', async h => { h.control.search = async () => { throw new Error('quota used up'); }; }, /^Failed: picture search for “Body” \(quota used up\)$/, 'failed']
  ];
  for (const [state, arrange, expected, status] of cases) {
    const { h, chat } = await imageHarness(); await arrange(h);
    const lines = await apply(h, [findAct(h, 'a')]);
    chat.finish('Looking.', lines); // the turn may end before or after the search does
    await withTimeout(until(() => lastImages(h)?.state === state));
    const shown = resultTexts(h); eq(shown.length, 1);
    assert.match(shown[0], expected, state); assert.doesNotMatch(shown[0], /^Done: Start/);
    if (state !== 'ready') assert.doesNotMatch(shown[0], /Done/, `${state}: the line does not say Done`);
    assert.equal(chat.completedTurns()[0].answer.lines.length, 1);
    assert.match(chat.transcript().at(-1).lines[0].text, expected, 'the saved turn carries the final line'); assert.equal(chat.transcript().at(-1).lines[0].status, status);
    assert.equal(findAll(h.view.chat.logEl, i => hasClass(i, 'vam-map-chat-line'))[0].cls.includes(`is-${status}`), true);
  }
  // A search that ends before the reply has finished: finish() must not bring the old "Started" text back.
  const { h, chat } = await imageHarness(); h.control.search = async () => { throw new Error('boom'); };
  const lines = await apply(h, [findAct(h, 'a')]); await withTimeout(until(() => lastImages(h)?.state === 'failed'));
  chat.finish('Looking.', lines); eq(resultTexts(h), ['Failed: picture search for “Body” (boom)']);
});
integrationTest('B3-polish P1-2: stopping the search rewrites the line to "Stopped"; the saved turn carries it', async () => {
  const { h, chat } = await imageHarness(); const gate = deferred(); h.control.search = async () => { await gate.promise; return imageItems(2); };
  const lines = await apply(h, [findAct(h, 'a')]); chat.finish('Looking.', lines);
  eq(resultTexts(h), ['Started looking for pictures for “Body”']);
  find(h.view.chat.logEl, i => hasClass(i, 'vam-map-chat-images-stop')).click();
  eq(resultTexts(h), ['Stopped: picture search for “Body”']); assert.equal(chat.transcript().at(-1).lines[0].status, 'skipped'); gate.resolve(); await tick();
});
integrationTest('B3-polish P1-2: writing the line back moves no focus and the reader hears the search result once', async () => {
  const { h, chat } = await imageHarness(); const input = chat.inputEl; const gate = deferred();
  h.control.search = async () => { await gate.promise; return imageItems(2); };
  const lines = await apply(h, [findAct(h, 'a')]); chat.finish('Looking.', lines);
  input.focus(); input.fire('compositionstart'); input.value = 'ni hao';
  gate.resolve(); await withTimeout(until(() => lastImages(h).state === 'ready'));
  eq(resultTexts(h), ['Done: found 2 pictures for “Body”']);
  assert.equal(h.page.doc.activeElement, input); assert.equal(chat.isComposing, true); assert.equal(input.value, 'ni hao');
  assert.equal(chat.liveEl.text.match(/Found 2 usable pictures/g).length, 1); assert.doesNotMatch(chat.liveEl.text, /Done: found/);
});
integrationTest('B3-polish P1-2: save as a note writes the final line, not "Done" for a failed search', async () => {
  const { h, chat } = await imageHarness(); h.control.search = async () => { throw new Error('quota used up'); };
  const lines = await apply(h, [findAct(h, 'a')]); await withTimeout(until(() => lastImages(h)?.state === 'failed'));
  chat.finish('Looking.', lines);
  saveButton(h).click(); await withTimeout(until(() => savedPaths(h).length === 1));
  const text = h.contents.get(savedPaths(h)[0]);
  assert.match(text, /Failed\\?: picture search for “Body” \\?\(quota used up\\?\)/); assert.doesNotMatch(text, /Done|Started looking/);
});
integrationTest('B3 find_images: the keyboard stays where it was when candidates arrive, and an insertion hands it back to the same button', async () => {
  const { h } = await imageHarness(); const input = h.view.chat.inputEl; input.focus(); input.fire('compositionstart'); input.value = 'ni hao';
  const block = await readyImages(h, 2);
  assert.equal(h.page.doc.activeElement, input, 'arrival does not move the focus'); assert.equal(h.view.chat.isComposing, true, 'an IME composition in progress is not interrupted'); assert.equal(input.value, 'ni hao');
  const pick = pickButtons(h)[0]; pick.focus(); pick.click();
  await withTimeout(until(() => block.items[0].inserted));
  assert.equal(h.page.doc.activeElement, pickButtons(h)[0], 'the (now inert) button keeps the keyboard');
});

// ---- save as a note ----
const savedPaths = h => [...h.files.keys()].filter(p => p.includes('/Chats/') && p.endsWith('.md'));
const saveButton = h => find(h.view.chat.headEl, i => i.tag === 'button' && hasClass(i, 'vam-map-chat-save'));
const today = () => localDate(new Date());
integrationTest('B3 save: a button between the model list and Close; hidden on the opening screen; disabled with a reason until a turn is finished', async () => {
  const { h, chat } = await imageHarness();
  const order = chat.headEl.children.map(c => c.cls.split(' ')[0]); eq(order, ['vam-map-chat-title', 'vam-map-chat-model', 'vam-map-chat-save', 'vam-map-chat-close']);
  const button = saveButton(h); assert.equal(button.attrs['aria-label'], 'Save the chat as a note'); assert.ok(button.attrs.title);
  assert.equal(button.attrs['aria-disabled'], 'true'); assert.equal(button.attrs.title, 'There is no finished chat to save yet.', 'a turn that is still streaming does not count');
  button.click(); await tick(); eq(savedPaths(h), []);
  chat.finish('Done answer.', []);
  assert.equal(button.attrs['aria-disabled'], 'false'); assert.equal(button.attrs.title, 'Save the chat as a note');
  chat.begin('Second'); chat.fail('It broke');
  assert.equal(chat.completedTurns().length, 1, 'a failed turn is not saved');
  const hero = await harness({ empty: true }); await hero.view.hydrate(); hero.repaint();
  assert.equal(hero.view.chat.isHero, true); assert.equal(saveButton(hero).hidden, true);
});
integrationTest('B3 save: the built-in sample has no folder, so the button says so and nothing is written', async () => {
  const { h, chat } = await imageHarness(); chat.finish('Answer.', []);
  h.view.builtIn = true; chat.refreshSelection(); // the host answers canSave() when the button repaints
  chat.begin('again'); chat.finish('Again.', []);
  const button = saveButton(h); assert.equal(button.attrs['aria-disabled'], 'true'); assert.equal(button.attrs.title, 'This map has no folder to save into.');
  button.click(); await tick(); eq(savedPaths(h), []);
});
integrationTest('B3 save: writes a new Chats note named by the local date and the first sentence, creates the folder, and tells the reader once', async () => {
  const { h, chat } = await imageHarness();
  chat.finish('First answer.\n\n- one\n- two', [{ status: 'done', text: 'Done: Add card' }]);
  chat.begin('Second question? More'); chat.finish('Second answer', []);
  const button = saveButton(h); button.click(); await withTimeout(until(() => savedPaths(h).length === 1));
  const expected = `Agent Workspace/Topics/map-a/Chats/${today()} find a picture for Body.md`;
  eq(savedPaths(h), [expected]); assert.ok(h.files.has('Agent Workspace/Topics/map-a/Chats'));
  const text = h.contents.get(expected);
  assert.ok(text.startsWith('# Map AI chat\n')); assert.ok(text.includes('[[Agent Workspace/Topics/map-a/Map|Sleep map]]'));
  assert.ok(text.includes('## 1. You') && text.includes('## 2. You')); assert.ok(text.includes('- Done\\: Add card'));
  assert.ok(!text.startsWith('---') && !text.includes('![')); assert.doesNotMatch(text, /agent-map-node|node-id|topic-id/);
  assert.ok(h.notices.includes(`Saved the chat as ${expected}`)); assert.match(chat.liveEl.text, new RegExp(`Saved the chat as ${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(button.attrs['aria-disabled'], 'false', 'the button works again'); assert.equal(h.opened.length, 0, 'the note is not opened');
  assert.equal(chat.transcript().length, 4, 'the conversation is kept');
});
integrationTest('B3 save: the same name three times becomes " 2" and " 3"; an existing note is never overwritten', async () => {
  const { h, chat } = await imageHarness(); chat.finish('Answer.', []);
  const base = `Agent Workspace/Topics/map-a/Chats/${today()} find a picture for Body`;
  await h.app.vault.createFolder('Agent Workspace/Topics/map-a/Chats'); await h.app.vault.create(`${base}.md`, 'PRECIOUS');
  for (let n = 1; n <= 3; n++) { saveButton(h).click(); await withTimeout(until(() => savedPaths(h).length === n + 1)); }
  eq(savedPaths(h).sort(), [`${base} 2.md`, `${base} 3.md`, `${base} 4.md`, `${base}.md`].sort());
  assert.equal(h.contents.get(`${base}.md`), 'PRECIOUS');
});
integrationTest('B3 save: a first sentence with only punctuation uses the fallback name; illegal characters are cleaned; a long one is cut', async () => {
  const { h, chat } = await imageHarness({}); chat.finish('A.', []);
  chat.reset(); chat.begin('???///'); chat.finish('A.', []);
  saveButton(h).click(); await withTimeout(until(() => savedPaths(h).length === 1));
  eq(savedPaths(h), [`Agent Workspace/Topics/map-a/Chats/${today()} Chat.md`]);
  chat.reset(); chat.begin('a/b:c*d' + 'x'.repeat(60)); chat.finish('A.', []);
  saveButton(h).click(); await withTimeout(until(() => savedPaths(h).length === 2));
  const name = savedPaths(h).find(p => !p.endsWith('Chat.md')).split('/').at(-1);
  assert.equal(name, `${today()} a b c d${'x'.repeat(40 - 7)}.md`);
});
integrationTest('B3 save: only finished turns are written - a reply that is still streaming is left out', async () => {
  const { h, chat } = await imageHarness(); chat.finish('Finished answer.', []);
  chat.begin('Streaming question'); chat.streamReply('half an ans');
  saveButton(h).click(); await withTimeout(until(() => savedPaths(h).length === 1));
  const text = h.contents.get(savedPaths(h)[0]); assert.ok(text.includes('Finished answer')); assert.ok(!text.includes('Streaming question') && !text.includes('half an ans'));
});
integrationTest('B3 save: a hostile reply is written as text only (whitelist), with candidates as links and the card a picture went into', async () => {
  const { h, chat } = await imageHarness(); const block = await readyImages(h, 2);
  pickButtons(h)[0].click(); await withTimeout(until(() => block.items[0].inserted));
  chat.finish('![](https://x/a.png) ![[secret]] <img src=x onerror=alert(1)>\n\n```dataviewjs\ndv.x()\n```\n\n%%c%% $$x$$ [x](javascript:alert(1))', [{ status: 'done', text: 'Done: x' }]);
  saveButton(h).click(); await withTimeout(until(() => savedPaths(h).length === 1));
  const text = h.contents.get(savedPaths(h)[0]);
  assert.ok(!text.includes('![')); assert.doesNotMatch(text, /(^|[^\\])<img/m); assert.ok(!/```dataviewjs/.test(text)); assert.doesNotMatch(text, /(^|[^\\])(%%|\$\$)/);
  assert.match(text, /- \[Pic 0\]\(<https:\/\/page\.example\/0>\) \\\(inserted into Body\\\)/); assert.match(text, /- \[Pic 1\]\(<https:\/\/page\.example\/1>\)\n/);
  assert.ok(!text.includes('img.example'), 'the picture addresses themselves are not written');
});
integrationTest('B3 save: a failing write says why and leaves no file', async () => {
  const { h, chat } = await imageHarness(); chat.finish('Answer.', []);
  h.app.vault.create = async () => { throw new Error('read-only disk'); };
  saveButton(h).click(); await withTimeout(until(() => h.notices.some(n => /Could not save the chat/.test(n))));
  assert.ok(h.notices.includes('Could not save the chat: read-only disk')); eq(savedPaths(h), []);
  assert.equal(h.notices.filter(n => /read-only disk/.test(n)).length, 1, 'one Notice for one failure');
  await withTimeout(until(() => saveButton(h).attrs['aria-disabled'] === 'false'));
});
integrationTest('B3 save: the note is saved into the folder of the map in view when the button is pressed', async () => {
  const { h, chat } = await imageHarness(); chat.finish('Answer.', []);
  h.view.path = 'Agent Workspace/Topics/map-z/Map.md'; h.view.map = { ...h.view.map, title: 'Other' };
  saveButton(h).click(); await withTimeout(until(() => savedPaths(h).length === 1));
  assert.ok(savedPaths(h)[0].startsWith('Agent Workspace/Topics/map-z/Chats/'));
});
integrationTest('B3 save: a saved Chats note is not a topic - rebuilding the derived data and reloading the map leave it byte for byte, and the map has the same topics', async () => {
  const { h, chat } = await imageHarness(); chat.finish('Answer with [[Notes/Other]] link.', []);
  const topicsBefore = (await h.repo.topics()).map(t => t.mapPath); const nodesBefore = (await h.saved()).map(n => n.id);
  saveButton(h).click(); await withTimeout(until(() => savedPaths(h).length === 1));
  const file = savedPaths(h)[0]; const before = h.contents.get(file);
  await h.plugin.mutate(async () => { await h.repo.rebuildDerivedData(); });
  const reread = await h.repo.readMap(MAP);
  eq(reread.nodes.map(n => n.id), nodesBefore); eq((await h.repo.topics()).map(t => t.mapPath), topicsBefore);
  assert.equal(h.contents.get(file), before, 'byte for byte');
  assert.equal([...h.files.keys()].filter(p => p.includes('/Unassigned/') && p.endsWith('.md')).length, 0, 'nothing was adopted into Unassigned');
});
test('B3 transcript: view labels are the interface language (the note follows the language of the window)', () => {
  const out = transcriptMarkdown({ mapTitle: 'T', mapPath: 'M/Map.md', savedAt: new Date(2026, 0, 2, 3, 4), labels: { title: 'Titel', map: 'Karte', saved: 'Gespeichert', you: 'Du', ai: 'KI', references: 'Bezüge', results: 'Ergebnisse', planPending: 'a', planApplied: 'b', planCancelled: 'c', images: '{0}', imagesSearching: '{0}', imagesNone: 'n', imagesFailed: '{0}', imagesStopped: 's', inserted: '{0}' }, turns: [{ question: 'Hallo', refs: [], answer: 'Hi', lines: [], images: [] }] });
  assert.ok(out.startsWith('# Titel\n\nKarte: [[M/Map|T]]\\\nGespeichert: 2026-01-02 03:04'));
});

integrationTest('B3-fix save: Dataview inline code in a reply is written as plain code', async () => {
  const { h, chat } = await imageHarness(); chat.finish('Try `=this.file.name` and `$=dv.el("b","x")` and ` = x`.', []);
  saveButton(h).click(); await withTimeout(until(() => savedPaths(h).length === 1));
  const text = h.contents.get(savedPaths(h)[0]);
  assert.doesNotMatch(text, /`\s*[=$]/);
});
integrationTest('B3-fix insert: a candidate title with HTML adds no extra picture to the card', async () => {
  const { h } = await imageHarness(); h.control.search = async () => [{ title: '<img src=x onerror=alert(1)>', url: 'https://img.example/p.jpg', source: 'https://page.example/p' }];
  await apply(h, [findAct(h, 'a')]); await withTimeout(until(() => lastImages(h)?.state === 'ready'));
  pickButtons(h)[0].click(); await withTimeout(until(() => lastImages(h).items[0].inserted));
  const detail = (await h.note('a')).detail;
  assert.equal((detail.match(/<img/gi) ?? []).length, 0); assert.equal((detail.match(/!\[/g) ?? []).length, 1, 'exactly one picture embed');
});

// ---- hypothesis-evidence (P3): the chat cannot touch the hypothesis keys, and moving a topic leaves relations alone ----
const heGuard = load('core/map-chat-guard.ts');
const heNote = extra => `---\nagent-map-node: true\nnode-id: n\ntopic-id: m\n${extra}---\nBody\n`;
const heEdit = (before, after, path = 'Topics/n.md') => heGuard.guardMapChatWrite({ kind: 'edit', path, oldContent: before, newContent: after, knownHashes: { [path]: 'h' }, configDir: '.obsidian' });
test('hypothesis-evidence: edit_md_file cannot add topic-kind, change hypothesis-strength or remove either key', () => {
  const refused = { ok: false, code: 'hypothesis_frontmatter_changed' };
  const plainNote = heNote(''), hypothesis = heNote('topic-kind: hypothesis\nhypothesis-strength: weak\n');
  eq(heEdit(plainNote, heNote('topic-kind: hypothesis\n')), refused, 'add topic-kind');
  eq(heEdit(plainNote, heNote('hypothesis-strength: strong\n')), refused, 'add a strength');
  eq(heEdit(hypothesis, hypothesis.replace('weak', 'strong')), refused, 'change the strength');
  eq(heEdit(hypothesis, hypothesis.replace('weak', '"weak"')), { ok: true }, 'quote style alone is not a change');
  eq(heEdit(hypothesis, hypothesis.replace('topic-kind: hypothesis\n', '')), refused, 'remove topic-kind');
  eq(heEdit(hypothesis, hypothesis.replace('hypothesis-strength: weak\n', '')), refused, 'remove the strength');
  eq(heEdit(hypothesis, hypothesis + 'topic-kind: note\n'), { ok: true }, 'text after the front matter is body, not a key');
  eq(heEdit(hypothesis, hypothesis.replace('topic-kind: hypothesis\n', 'topic-kind: hypothesis\ntopic-kind: hypothesis\n')), refused, 'a duplicated key');
  eq(heEdit('---\ntitle: P\n---\nText\n', '---\ntitle: P\ntopic-kind: hypothesis\n---\nText\n', 'Notes/p.md'), refused, 'an ordinary note cannot get the key either');
  eq(heEdit(hypothesis, hypothesis.replace('Body', 'Changed body')), { ok: true }, 'body edits on a hypothesis note are still allowed');
});
test('hypothesis-evidence: quoted hypothesis keys are guarded like bare ones', () => {
  const refused = { ok: false, code: 'hypothesis_frontmatter_changed' };
  const plainNote = heNote(''), hypothesis = heNote('topic-kind: hypothesis\nhypothesis-strength: weak\n');
  eq(heEdit(plainNote, heNote('"topic-kind": hypothesis\n')), refused, 'add a double-quoted topic-kind');
  eq(heEdit(plainNote, heNote("'topic-kind': hypothesis\n")), refused, 'add a single-quoted topic-kind');
  eq(heEdit(plainNote, heNote('"hypothesis-strength": strong\n')), refused, 'add a double-quoted strength');
  eq(heEdit(plainNote, heNote("'hypothesis-strength': strong\n")), refused, 'add a single-quoted strength');
  const quoted = heNote('"topic-kind": hypothesis\n\'hypothesis-strength\': weak\n');
  eq(heEdit(quoted, quoted.replace('weak', 'strong')), refused, 'change the value under a single-quoted key');
  eq(heEdit(hypothesis, hypothesis.replace('topic-kind: hypothesis', '"topic-kind": note')), refused, 'change the kind through a quoted key');
  eq(heEdit(hypothesis, hypothesis.replace('hypothesis-strength: weak', "'hypothesis-strength': strong")), refused, 'change the strength through a quoted key');
  eq(heEdit(hypothesis, hypothesis.replace('topic-kind: hypothesis', '"topic-kind": hypothesis')), { ok: true }, 'quoting a key without changing its value is not a change');
});
test('hypothesis-evidence: writing the map file is still refused with map_file', () => {
  const mapText = '```agent-map\n{"id":"m","title":"T","version":1,"nodes":[],"viewport":{"x":0,"y":0,"zoom":1}}\n```\n';
  eq(heEdit(mapText, mapText.replace('"T"', '"U"'), 'Map.md'), { ok: false, code: 'map_file' });
});
integrationTest('hypothesis-evidence: a chat edit that touches a hypothesis key is skipped with a reason and the note is unchanged; other edits still apply', async () => {
  const h = await harness();
  const topicPath = h.node('a').path;
  h.contents.set(topicPath, h.contents.get(topicPath).replace('---\n', '---\ntopic-kind: hypothesis\nhypothesis-strength: weak\n'));
  await h.view.hydrate();
  const snapshot = h.contents.get(topicPath);
  const lines = await apply(h, [
    { kind: 'edit_md_file', path: topicPath, find: 'hypothesis-strength: weak', replace: 'hypothesis-strength: strong' },
    { kind: 'edit_md_file', path: topicPath, find: 'topic-kind: hypothesis\n', replace: '' },
    { kind: 'edit_md_file', path: 'Notes/Research.md', find: '# Research', replace: '---\ntopic-kind: hypothesis\n---\n# Research' },
    { kind: 'edit_md_file', path: 'Notes/Research.md', find: 'needs darkness', replace: 'needs total darkness' }
  ], h.hashes(topicPath, 'Notes/Research.md'));
  eq(lines.map(l => l.status), ['skipped', 'skipped', 'skipped', 'done'], JSON.stringify(lines));
  for (const line of lines.slice(0, 3)) assert.match(line.text, /hypothesis fields/);
  assert.equal(h.contents.get(topicPath), snapshot, 'the hypothesis note is unchanged');
  assert.match(h.contents.get('Notes/Research.md'), /needs total darkness/);
  assert.doesNotMatch(h.contents.get('Notes/Research.md'), /topic-kind/);
});
integrationTest('hypothesis-evidence: move_topic leaves every relation as it was', async () => {
  const h = await harness();
  const relations = [{ kind: 'supports', from: h.ids.c, to: h.ids.b }, { kind: 'prerequisite', from: h.ids.a, to: h.ids.c }];
  h.view.map.topicRelations = relations; await h.repo.saveMap(MAP, h.view.map); h.view.map = await h.repo.readMap(MAP);
  const lines = await apply(h, [{ kind: 'move_topic', nodeId: h.ids.c, newParentId: h.ids.b }]);
  eq(lines.map(l => l.status), ['done'], JSON.stringify(lines));
  const saved = await h.repo.readMap(MAP);
  assert.equal(saved.nodes.find(n => n.id === h.ids.c).parentId, h.ids.b, 'the topic really moved');
  eq(saved.topicRelations, relations);
});
test('hypothesis-evidence: the guard refuses adding, switching and removing topic-kind for all six values; the map file is still map_file', () => {
  const refused = { ok: false, code: 'hypothesis_frontmatter_changed' };
  const kinds = ['topic', 'action', 'atomic', 'hypothesis', 'evidence', 'conclusion'];
  eq(heEdit(heNote(''), heNote('topic-kind: action\n')), refused, 'add topic-kind: action');
  for (const kind of kinds.slice(1)) {
    const note = heNote(`topic-kind: ${kind}\n`);
    eq(heEdit(note, note.replace(`topic-kind: ${kind}\n`, '')), refused, `remove ${kind}`);
    for (const other of kinds.filter(k => k !== kind)) eq(heEdit(note, note.replace(`topic-kind: ${kind}`, `topic-kind: ${other}`)), refused, `${kind} -> ${other}`);
  }
  eq(heEdit(heNote('topic-kind: atomic\n'), heNote('topic-kind: conclusion\n')), refused, 'atomic -> conclusion');
  eq(heEdit(heNote('topic-kind: action\n'), heNote('topic-kind: action\n').replace('Body', 'Changed')), { ok: true }, 'a body edit with the kind untouched is allowed');
  const mapText = '```agent-map\n{"id":"m","title":"T","version":1,"nodes":[],"viewport":{"x":0,"y":0,"zoom":1}}\n```\n';
  eq(heEdit(mapText, mapText.replace('"T"', '"U"'), 'Map.md'), { ok: false, code: 'map_file' });
});
