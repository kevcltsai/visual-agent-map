// Tree text nodes P3: promote a text node to a topic card; text nodes are read-only AI context (decisions #2, #4); A5.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element, find, findAll } = dom;
const plain = value => JSON.parse(JSON.stringify(value));
const TOPICS = 'Agent Workspace/Topics';
const MAP = `${TOPICS}/map-t/Map.md`;
const txt = (over = {}) => ({ id: 't1', kind: 'text', text: 'Hello', parentId: undefined, x: 400, y: 80, ...over });


const { buildMapChatContext } = load('core/map-chat-context.ts');
const { parseMapChat } = load('core/steps/map-chat/step.ts');
const { taskPrompt } = load('core/steps/task/render.ts');

async function harness(build) {
  const { repo, app, contents } = fixture('en', { linkIndex: true });
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const doc = { id: 'map-t', title: 'T', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders(`${TOPICS}/map-t`);
  await app.vault.create(MAP, core.serializeMap(doc));
  const root = await repo.createNote('Root', 'gpt-6-luna', doc, MAP, 'workspace');
  const child = await repo.createNote('Child', 'gpt-6-luna', doc, MAP, 'workspace');
  child.parentId = root.id;
  doc.nodes.push(root, child);
  const items = build ? build({ root, child }) : undefined;
  if (items) doc.canvasItems = items;
  await repo.saveMap(MAP, doc);
  await repo.rebuildDerivedData();
  let pending = Promise.resolve();
  const notices = [];
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: dom.makeNotice(notices) } }, { createFragment: dom.createFragment });
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: work => (pending = Promise.resolve().then(work))
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = element('div'); view.stageEl = element('div');
  view.focusNode = () => {}; view.openDetails = () => {};
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  view.render = () => {
    view.stageEl.children = []; view.cardEls.clear(); view.textEls.clear();
    for (const n of view.map.nodes) view.cardEls.set(n.id, view.stageEl.child('div', 'vam-node'));
    view.renderCanvasItems();
  };
  view.render();
  const settle = async () => { await pending; await dom.tick(); await pending; };
  const onDisk = async () => plain((await repo.readMap(MAP)).canvasItems ?? []);
  const noteFiles = () => [...contents.keys()].filter(k => k.endsWith('.md') && !k.endsWith('Map.md')).length;
  const textEl = id => find(view.stageEl, i => i.dataset.itemId === id);
  return { repo, view, root: view.map.nodes[0], child: view.map.nodes[1], settle, onDisk, noteFiles, textEl, notices };
}


const outline = [
  { id: 'r', title: 'Root', summary: '', parentId: null, depth: 0 },
  { id: 'a', title: 'A', summary: '', parentId: 'r', depth: 1 }
];
const chatInput = extra => ({ mapTitle: 'M', outline, selected: [], references: [], snippets: [], files: [], activeFile: null, history: [], ...extra });
const item = (kind, fields = {}) => ({ kind, nodeId: '', ref: '', parentId: '', newParentId: '', title: '', summary: '', detail: '', path: '', find: '', replace: '', content: '', nodeIds: [], all: false, branch: false, action: '', goal: '', direction: '', mode: '', images: false, ...fields });

test('A5 chat: user texts go in as read-only context, orphans marked unattached, ids never actionable; no texts = unchanged bytes', () => {
  const plainJson = buildMapChatContext(chatInput()).json;
  assert.equal(buildMapChatContext(chatInput({ userTexts: [] })).json, plainJson);
  assert.ok(!plainJson.includes('userTexts'));
  const ctx = buildMapChatContext(chatInput({ userTexts: [{ id: 'txt-1', parentId: 'a', text: 'My own idea' }, { id: 'txt-2', parentId: null, text: 'Loose' }] }));
  const parsed = JSON.parse(ctx.json);
  assert.deepEqual(parsed.userTexts[0], { id: 'txt-1', parentId: 'a', readOnly: true, text: 'My own idea' });
  assert.deepEqual(parsed.userTexts[1], { id: 'txt-2', parentId: null, unattached: true, readOnly: true, text: 'Loose' });
  assert.match(parsed.userTextsNote, /must not be rewritten or deleted/);
  assert.ok(!ctx.nodeIds.includes('txt-1') && !ctx.nodeIds.includes('txt-2'));
  assert.ok(!parsed.outline.some(n => n.id.startsWith('txt-')));
  assert.ok(!('txt-1' in ctx.topicHashes) && !('txt-1' in ctx.parents));
  // A reply that targets a text id is refused: rewrite, delete, reparent or select.
  const bads = [item('edit_topic_note', { nodeId: 'txt-1', detail: 'x' }), item('update_summary', { nodeId: 'txt-1', summary: 'x' }), item('rename_topic', { nodeId: 'txt-1', title: 'x' }), item('delete_topic', { nodeId: 'txt-1' }), item('move_topic', { nodeId: 'txt-1', newParentId: 'a' }), item('add_child', { parentId: 'txt-1', title: 'x' }), item('select_topics', { nodeIds: ['txt-1'] }), item('collapse_topic', { nodeId: 'txt-1' }), item('focus_topic', { nodeId: 'txt-1' }), item('run_map_action', { action: 'research_standard', nodeIds: ['txt-1'] })];
  const result = JSON.parse(JSON.stringify(parseMapChat(JSON.stringify({ reply: 'ok', actions: bads }), ctx)));
  assert.deepEqual(result.actions, [], 'no action on a text id survives the parser');
  assert.equal(result.rejected.length, bads.length);
  assert.ok(result.rejected.every(entry => entry.code === 'unknown_node'), JSON.stringify(result.rejected));
});

test('A5 research and integration prompts: user text appears under its own read-only label, absent when there is none', () => {
  const base = { title: 'T', summary: 's', rules: '', detail: '', task: 'do', ancestors: '', mode: 'synthesize', researchMode: 'local', researchDepth: 'normal' };
  for (const language of ['en', 'zh-TW']) {
    const without = taskPrompt(base, language);
    assert.equal(taskPrompt({ ...base, userTexts: '' }, language), without, 'no text nodes: prompt unchanged');
    const withText = taskPrompt({ ...base, userTexts: '- my note' }, language);
    assert.ok(withText.includes('- my note'));
    assert.match(withText, language === 'en' ? /read-only/ : /唯讀/);
    assert.ok(withText.indexOf('- my note') < withText.indexOf(language === 'en' ? 'Ancestor topic context' : '祖先議題背景'));
  }
});

test('View: userTextContext lists only the text under that topic; chatUserTexts keeps orphans as parentId null', async () => {
  const h = await harness(({ root, child }) => [txt({ parentId: root.id, text: 'line1\nline2' }), txt({ id: 't2', parentId: child.id, text: 'under child' }), txt({ id: 't3', parentId: 'gone', text: 'Orphan' })]);
  assert.equal(h.view.userTextContext(h.root.id), '- line1\n  line2');
  assert.equal(h.view.userTextContext(h.child.id), '- under child');
  assert.equal(h.view.userTextContext('nope'), '');
  assert.deepEqual(plain(h.view.chatUserTexts().map(t => [t.id, t.parentId])), [['t1', h.root.id], ['t2', h.child.id], ['t3', null]]);
});

test('A4 promote: text becomes a card (first line title, full text summary) under the same parent, one undo step back to the text', async () => {
  const h = await harness(({ root }) => [txt({ parentId: root.id, text: 'Pricing idea\nsecond line' })]);
  const files = h.noteFiles(), past = h.view.history.past.length;
  const button = find(h.textEl('t1'), i => i.tag === 'button');
  assert.ok(button && button.attrs['aria-label']);
  button.fire('click', {});
  await h.settle();
  assert.deepEqual(await h.onDisk(), []);
  assert.equal(h.view.map.nodes.length, 3);
  const created = h.view.map.nodes[2];
  assert.equal(created.parentId, h.root.id);
  const note = await h.repo.readNote(created.path);
  assert.equal(note.title, 'Pricing idea');
  assert.match(note.summary, /second line/);
  assert.equal(h.noteFiles(), files + 1);
  assert.equal(h.view.history.past.length, past + 1, 'one undo step');
  await h.view.travel(false);
  assert.equal((await h.onDisk())[0].text, 'Pricing idea\nsecond line');
  assert.equal((await h.repo.readMap(MAP)).nodes.length, 2);
});

test('A4 promote: a free (orphan) node becomes a top-level card; a long first line is cut to 80 characters', async () => {
  const long = 'x'.repeat(120);
  const h = await harness(() => [txt({ parentId: 'gone', text: long, x: 700, y: 300 })]);
  await h.view.promoteTextNode('t1');
  const created = h.view.map.nodes[2];
  assert.equal(created.parentId, null);
  assert.equal(created.x, 700);
  assert.equal(created.y, 300);
  assert.equal((await h.repo.readNote(created.path)).title.length, 80);
});
