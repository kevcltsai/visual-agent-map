// ChatActionWriter (experiences/visual-map/chat-action-writer.ts) on its own: fake ports and a fake map, no view, no real waiting.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support.cjs');
const { ChatActionWriter } = load('experiences/visual-map/chat-action-writer.ts', { obsidian: {} });
const { t } = load('i18n.ts');
const { contentHash } = load('core/map-chat-context.ts');

// The module runs in its own vm realm, so what it returns is compared as plain data.
const plain = value => JSON.parse(JSON.stringify(value));
const skippedOutcome = key => ({ status: 'skipped', reason: t(key) });
const node = (id, parentId = null) => ({ id, parentId, path: `${id}.md`, x: 0, y: 0, collapsed: false });

function world(options = {}) {
  const calls = [];
  const log = (name, ...args) => calls.push([name, ...args.map(arg => (arg === undefined ? null : plain(arg)))]);
  const map = {
    id: 'map', title: 'Map', version: 1, nodes: options.nodes ?? [node('a'), node('b'), node('c', 'a')],
    topicRelations: [], canvasItems: [], viewport: { x: 0, y: 0, zoom: 1 }
  };
  // What the vault has now for each card (the writer reads it again at apply time).
  const notes = new Map(Object.entries(options.notes ?? { a: { title: 'A' }, b: { title: 'B' }, c: { title: 'C' } })
    .map(([id, note]) => [id, { summary: '', detail: '', ...note }]));
  const files = new Map(Object.entries(options.files ?? {}));
  const history = [];
  const transactions = [];
  const state = { lock: null };
  const fileObject = path => ({ path });
  const app = {
    vault: {
      configDir: '.obsidian',
      getAbstractFileByPath: path => (files.has(path) ? fileObject(path) : null),
      process: async (file, change) => { log('process', file.path); files.set(file.path, change(files.get(file.path))); },
      create: async () => {}, createFolder: async () => {}
    },
    metadataCache: { getFileCache: () => ({ frontmatter: undefined }) },
    fileManager: { trashFile: async () => {} }
  };
  const plugin = {
    mermaidSyntax: undefined,
    repo: {
      readNote: async path => ({ ...notes.get([...notes.keys()].find(id => `${id}.md` === path)) }),
      writeTopicAppearance: async (path, change) => log('writeTopicAppearance', path, plain(change))
    }
  };
  const readChatFile = async path => (files.has(path) ? { file: fileObject(path), text: files.get(path), editor: null } : null);
  const ports = {
    map: () => map, path: () => 'map.md', plugin: () => plugin, notes: () => notes, history: () => ({ push: entry => history.push(entry) }),
    isMerging: () => false, relationsEnabled: () => true,
    topicKindOf: () => 'topic', hypothesisLeaningOf: () => undefined, hypothesisStrengthOf: () => undefined,
    mapChange: async change => { log('mapChange'); change(map); },
    beginMapTransaction: () => {
      const transaction = {
        rewrites: [], edits: [], commits: [],
        rewriteNote(path, change) { transaction.rewrites.push([path, change]); return transaction; },
        editMap(path, change) { transaction.edits.push(path); change(map); return transaction; },
        async commit(commitOptions) {
          transaction.commits.push(commitOptions);
          for (const [path, change] of transaction.rewrites) await change(path);
          return { undo: async () => {}, redo: async () => {}, label: commitOptions.label };
        }
      };
      transactions.push(transaction);
      return transaction;
    },
    app: () => app,
    aiLockReason: (...args) => { log('aiLockReason', args[0], args[1]); return state.lock; },
    freshNotes: async () => { log('freshNotes'); return notes; },
    freshNotesOf: async ids => { log('freshNotesOf', ids); return notes; },
    topicState: (id, fresh) => {
      const found = map.nodes.find(item => item.id === id);
      return found ? { title: fresh?.title ?? found.path, summary: fresh?.summary ?? '', detail: fresh?.detail ?? '', parentId: found.parentId } : null;
    },
    addNode: async (...args) => {
      log('addNode', args[0]?.id, ...args.slice(1));
      map.nodes.push(node('n1', args[0]?.id ?? null));
      notes.set('n1', { title: args[1], summary: '', detail: '' });
    },
    noteChange: async (found, patch) => { log('noteChange', found.id, patch); Object.assign(notes.get(found.id), patch); },
    moveTopic: async (found, parent) => { log('moveTopic', found.id, parent.id); found.parentId = parent.id; },
    removeToUnassignedEntry: async (found, branch) => { log('removeToUnassignedEntry', found.id, branch); return { parkedPaths: () => [`Unassigned/${found.path}`] }; },
    chatMoveBefore: async () => true, chatReorderChildren: async () => {}, arrangeAll: () => {}, focusNode: () => {}, flushChatRender: () => {},
    readChatFile,
    chatFileText: async path => (await readChatFile(path))?.text ?? null,
    chatUndoRefusal: () => new Error('refused'),
    chatReadableNow: async () => false,
    attachedReadOnly: () => false,
    noteChatOwnFile: (path, text, created) => log('noteChatOwnFile', path, text, created),
    fileOf: path => (files.has(path) ? fileObject(path) : null)
  };
  const writer = new ChatActionWriter(ports);
  const nodeById = id => map.nodes.find(item => item.id === id);
  const baseline = (extra = {}) => ({
    mdHashes: {}, topicHashes: Object.fromEntries(map.nodes.map(item => [item.id, { title: notes.get(item.id)?.title, parentId: item.parentId }])),
    mapSourcePaths: [], ...extra
  });
  const run = () => ({ refs: new Map(), created: [], notes: new Set(), files: new Set(), parked: new Set() });
  const only = name => calls.filter(call => call[0] === name);
  return { writer, ports, map, notes, files, history, transactions, state, calls, only, nodeById, baseline, run };
}
const apply = (w, action, baseline = w.baseline(), run = w.run()) => w.writer.write(action, baseline, () => true, run).then(outcome => ({ outcome: plain(outcome), run }));

test('chat action writer: add_child passes the type, leaning and strength to addNode, records the new card and writes the summary', async () => {
  const w = world();
  const { outcome, run } = await apply(w, { kind: 'add_child', parentId: 'a', title: 'X1', ref: 'r1', summary: 'S1', topicKind: 'hypothesis', leaning: 'supported', strength: 'weak' });
  assert.deepEqual(outcome, { status: 'done' });
  assert.deepEqual(w.only('addNode'), [['addNode', 'a', 'X1', true, false, 'hypothesis', false, { leaning: 'supported', strength: 'weak' }]]);
  assert.deepEqual(run.created, ['n1']);
  assert.equal(run.refs.get('r1'), 'n1');
  assert.deepEqual([...run.notes], ['n1']);
  assert.deepEqual(w.only('noteChange'), [['noteChange', 'n1', { summary: 'S1' }]]);
});

test('chat action writer: rename_topic writes the title and moves the baseline; a card the user changed is skipped and not written', async () => {
  const w = world();
  const baseline = w.baseline();
  const { outcome } = await apply(w, { kind: 'rename_topic', nodeId: 'a', title: 'A2' }, baseline);
  assert.deepEqual(outcome, { status: 'done' });
  assert.deepEqual(w.only('noteChange'), [['noteChange', 'a', { title: 'A2' }]]);
  assert.equal(baseline.topicHashes.a.title, 'A2');
  const stale = world();
  const changed = stale.baseline();
  changed.topicHashes.a.title = 'What the model saw';
  const result = await apply(stale, { kind: 'rename_topic', nodeId: 'a', title: 'A2' }, changed);
  assert.deepEqual(result.outcome, skippedOutcome('ui.map_chat_skip_topic_changed'));
  assert.deepEqual(stale.only('noteChange'), []);
});

test('chat action writer: move_topic moves the card and follows it in the baseline; a move under its own descendant is a cycle', async () => {
  const w = world();
  const baseline = w.baseline();
  const { outcome } = await apply(w, { kind: 'move_topic', nodeId: 'c', newParentId: 'b' }, baseline);
  assert.deepEqual(outcome, { status: 'done' });
  assert.deepEqual(w.only('moveTopic'), [['moveTopic', 'c', 'b']]);
  assert.equal(baseline.topicHashes.c.parentId, 'b');
  const cycle = world();
  const result = await apply(cycle, { kind: 'move_topic', nodeId: 'a', newParentId: 'c' });
  assert.deepEqual(result.outcome, skippedOutcome('ui.map_chat_skip_cycle'));
  assert.deepEqual(cycle.only('moveTopic'), []);
});

test('chat action writer: delete_topic removes the card to Unassigned and keeps the parked paths of the reply', async () => {
  const w = world();
  const { outcome, run } = await apply(w, { kind: 'delete_topic', nodeId: 'b', branch: false });
  assert.deepEqual(outcome, { status: 'done' });
  assert.deepEqual(w.only('removeToUnassignedEntry'), [['removeToUnassignedEntry', 'b', false]]);
  assert.deepEqual([...run.parked], ['Unassigned/b.md']);
});

test('chat action writer: add_relation and remove_relation change Map.md through mapChange; a self link and a missing relation are skipped', async () => {
  const w = world();
  const added = await apply(w, { kind: 'add_relation', fromId: 'a', toId: 'b', relationKind: 'related' });
  assert.deepEqual(added.outcome, { status: 'done' });
  assert.deepEqual(plain(w.map.topicRelations ?? []), [{ kind: 'related', from: 'a', to: 'b' }]);
  const removed = await apply(w, { kind: 'remove_relation', fromId: 'b', toId: 'a' });
  assert.deepEqual(removed.outcome, { status: 'done' });
  assert.deepEqual(plain(w.map.topicRelations ?? []), []);
  assert.equal(w.only('mapChange').length, 2);
  const self = await apply(w, { kind: 'add_relation', fromId: 'a', toId: 'a', relationKind: 'related' });
  assert.deepEqual(self.outcome, skippedOutcome('ui.map_chat_skip_relation_not_allowed'));
  const missing = await apply(w, { kind: 'remove_relation', fromId: 'a', toId: 'b' });
  assert.deepEqual(missing.outcome, skippedOutcome('ui.map_chat_skip_relation_missing'));
  assert.equal(w.only('mapChange').length, 2, 'a refused one writes nothing');
});

test('chat action writer: set_appearance writes only the cards whose appearance changes, in one transaction and one history step', async () => {
  const w = world({ notes: { a: { title: 'A' }, b: { title: 'B', color: 'red' }, c: { title: 'C' } } });
  const { outcome, run } = await apply(w, { kind: 'set_appearance', nodeIds: ['a', 'b'], color: 'red' });
  assert.deepEqual(outcome, { status: 'done' });
  assert.equal(w.transactions.length, 1);
  assert.deepEqual(w.transactions[0].rewrites.map(([path]) => path), ['a.md']);
  assert.deepEqual(w.transactions[0].edits, ['map.md']);
  assert.deepEqual(plain(w.transactions[0].commits), [{ deferRebuild: true, label: t('ui.topic_appearance') }]);
  assert.deepEqual(w.only('writeTopicAppearance'), [['writeTopicAppearance', 'a.md', { color: 'red', addMarkers: [], removeMarkers: [], addStyles: [], removeStyles: [] }]]);
  assert.equal(w.history.length, 1);
  assert.equal(w.history[0].label, t('ui.topic_appearance'));
  assert.deepEqual([...run.notes], ['a']);
});

test('chat action writer: edit_md_file writes through vault.process, records one undo step that restores and redoes, and moves the hash', async () => {
  const w = world({ files: { 'notes/x.md': 'hello world' } });
  const baseline = w.baseline({ mdHashes: { 'notes/x.md': contentHash('hello world') } });
  const { outcome, run } = await apply(w, { kind: 'edit_md_file', path: 'notes/x.md', find: 'world', replace: 'there' }, baseline);
  assert.deepEqual(outcome, { status: 'done' });
  assert.equal(w.files.get('notes/x.md'), 'hello there');
  assert.deepEqual(w.only('process'), [['process', 'notes/x.md']]);
  assert.equal(baseline.mdHashes['notes/x.md'], contentHash('hello there'));
  assert.deepEqual([...run.files], ['notes/x.md']);
  assert.deepEqual(w.only('noteChatOwnFile'), [['noteChatOwnFile', 'notes/x.md', 'hello there', false]]);
  assert.equal(w.history.length, 1);
  await w.history[0].undo();
  assert.equal(w.files.get('notes/x.md'), 'hello world');
  await w.history[0].redo();
  assert.equal(w.files.get('notes/x.md'), 'hello there');
  w.files.set('notes/x.md', 'typed by the user');
  await assert.rejects(() => w.history[0].undo(), /refused/);
  assert.equal(w.files.get('notes/x.md'), 'typed by the user');
});

test('chat action writer: a card or file that is a data source of the map is refused for rename_topic and edit_md_file, nothing written', async () => {
  const w = world({ files: { 'a.md': 'source text' } });
  const baseline = w.baseline({ mapSourcePaths: ['a.md'], mdHashes: { 'a.md': contentHash('source text') } });
  const refused = { status: 'skipped', reason: t('ui.map_chat_guard_map_source') };
  const rename = await apply(w, { kind: 'rename_topic', nodeId: 'a', title: 'A2' }, baseline);
  assert.deepEqual(rename.outcome, refused);
  const edit = await apply(w, { kind: 'edit_md_file', path: 'a.md', find: 'source', replace: 'changed' }, baseline);
  assert.deepEqual(edit.outcome, refused);
  assert.deepEqual(w.only('noteChange'), []);
  assert.deepEqual(w.only('process'), []);
  assert.equal(w.files.get('a.md'), 'source text');
});

test('chat action writer: a card locked for the AI is refused at apply time, read from disk for that card (all cards for a delete)', async () => {
  const w = world();
  w.state.lock = { reason: 'locked' };
  const rename = await apply(w, { kind: 'rename_topic', nodeId: 'a', title: 'A2' });
  assert.deepEqual(rename.outcome, skippedOutcome('ui.ai_locked_notice'));
  assert.deepEqual(w.only('freshNotesOf'), [['freshNotesOf', ['a']]]);
  assert.deepEqual(w.only('noteChange'), []);
  const removed = await apply(w, { kind: 'delete_topic', nodeId: 'b', branch: false });
  assert.deepEqual(removed.outcome, skippedOutcome('ui.ai_locked_notice'));
  assert.equal(w.only('freshNotes').length, 1);
  assert.deepEqual(w.only('removeToUnassignedEntry'), []);
});

// ---- edit_book_plan (the chief editor's apply path, book-plan-chat.ts) ----

const { applyBookPlanEdit, bookPlanChatInput } = load('experiences/visual-map/book-plan-chat.ts', { obsidian: {} });
const machine = load('core/book-pipeline/machine.ts');
const planText = load('core/book-pipeline/plan-text.ts');

function planWorld(options = {}) {
  const writes = [];
  const brief = (covers, extra = {}) => planText.composeCardPrompt({
    role: 'body', kind: 'chapter', covers, points: ['p1'], entry: 'e', handoff: 'h',
    checklist: [{ id: 'C1', type: 'structure', text: 'c1' }], ...extra
  }, 'en');
  const prompts = {
    r: brief('root covers'),
    a: brief('old a', { next: { position: 2, title: 'B', summary: 'old b' } }),
    b: brief('old b', { previous: { position: 1, title: 'A', summary: 'old a' }, next: { position: 3, title: 'C', summary: 'old c' } }),
    c: brief('old c', { previous: { position: 2, title: 'B', summary: 'old b' } })
  };
  const cards = new Map(Object.entries(prompts).map(([id, prompt]) => [`${id}.md`, {
    path: `${id}.md`, title: id.toUpperCase(), summary: '', prompt, detail: '', raw: `raw-${id}`, fields: { bookRole: 'body' }, settings: {}
  }]));
  const data = machine.newBookPipeline({ runId: 'run-1', order: ['r', 'a', 'b', 'c'], now: '2026-11-16T00:00:00.000Z' });
  delete data.trial; data.phase = 'gate1'; data.planReview = true;
  const doc = {
    id: 'map', title: 'Book', version: 1, topicRelations: [], canvasItems: [], viewport: { x: 0, y: 0, zoom: 1 },
    nodes: ['r', 'a', 'b', 'c'].map(id => node(id, id === 'r' ? null : 'r')), bookPipeline: JSON.parse(JSON.stringify(data))
  };
  const state = { memory: doc, locked: new Set(options.locked ?? []) };
  const deps = {
    map: () => state.memory,
    readMap: async () => doc,
    readCard: async path => ({ ...cards.get(path) }),
    updateNoteGuarded: async (path, patch, guard) => {
      const card = cards.get(path);
      if (!guard.authorize() || guard.expectedContent !== card.raw) return 'discarded';
      writes.push(path); card.prompt = patch.prompt; if (patch.summary !== undefined) card.summary = patch.summary;
      return 'written';
    },
    language: () => 'en'
  };
  const baselineOf = ids => ({
    runId: 'run-1', unlocked: ids, prompts: Object.fromEntries(ids.map(id => [id, { path: `${id}.md`, prompt: prompts[id], kind: 'chapter' }]))
  });
  return { deps, doc, cards, writes, state, baselineOf, prompts };
}
const bookAction = changes => ({ kind: 'edit_book_plan', changes });

test('edit_book_plan: writes the composed Prompt, follows covers into the summary and refreshes the previous card next line', async () => {
  const w = planWorld();
  const outcome = plain(await applyBookPlanEdit(w.deps, bookAction([{ id: 'b', covers: 'new b', checklist: [{ type: 'fact', text: 'who pays' }] }]), { bookPlan: w.baselineOf(['b']) }));
  assert.equal(outcome.status, 'done');
  assert.deepEqual(w.writes, ['b.md', 'a.md']);
  assert.match(w.cards.get('b.md').prompt, /new b/);
  assert.match(w.cards.get('b.md').prompt, /who pays/);
  assert.equal(w.cards.get('b.md').summary, 'new b');
  assert.match(w.cards.get('a.md').prompt, /new b/, 'the card before still says what comes next');
  assert.doesNotMatch(w.cards.get('a.md').prompt, /old b/);
});

test('edit_book_plan: a Prompt changed after the proposal is skipped and said so; the others are still written', async () => {
  const w = planWorld();
  w.cards.get('b.md').prompt += '\nthe reader added a line';
  const outcome = plain(await applyBookPlanEdit(w.deps, bookAction([
    { id: 'b', entry: 'new entry' }, { id: 'c', entry: 'other entry' }
  ]), { bookPlan: w.baselineOf(['b', 'c']) }));
  assert.equal(outcome.status, 'done');
  assert.match(outcome.note, /tell the chief editor/);
  assert.match(outcome.note, /1 cards left/);
  assert.deepEqual(w.writes, ['c.md']);
  const all = plain(await applyBookPlanEdit(w.deps, bookAction([{ id: 'b', entry: 'x' }]), { bookPlan: w.baselineOf(['b']) }));
  assert.deepEqual(all, skippedOutcome('ui.map_chat_skip_book_cards'));
});

test('edit_book_plan: a change that would not change the Prompt is skipped; nothing is written', async () => {
  const w = planWorld();
  const same = plain(await applyBookPlanEdit(w.deps, bookAction([{ id: 'b', entry: 'e' }]), { bookPlan: w.baselineOf(['b']) }));
  assert.deepEqual(same, skippedOutcome('ui.map_chat_skip_book_cards'));
  assert.deepEqual(w.writes, []);
});

test('edit_book_plan: a locked card is refused (not in the proposal, or hand-edited by now)', async () => {
  const w = planWorld();
  const notProposed = plain(await applyBookPlanEdit(w.deps, bookAction([{ id: 'b', entry: 'x' }]), { bookPlan: w.baselineOf([]) }));
  assert.equal(notProposed.status, 'skipped');
  w.cards.get('b.md').raw = '---\ntitle: B\n---\n\n<!-- visual-agent-map:detail:start -->\nhand text here\n<!-- visual-agent-map:detail:end -->\n';
  const handEdited = plain(await applyBookPlanEdit(w.deps, bookAction([{ id: 'b', entry: 'x' }]), { bookPlan: w.baselineOf(['b']) }));
  assert.equal(handEdited.status, 'skipped');
  assert.deepEqual(w.writes, []);
});

test('edit_book_plan: nothing is written once the run has left the plan review, or is another run', async () => {
  for (const change of [
    w => { w.doc.bookPipeline.phase = 'writing'; },
    w => { w.doc.bookPipeline.planReview = false; },
    w => { w.doc.bookPipeline.status = 'stopped'; },
    w => { w.doc.bookPipeline.runId = 'run-2'; }
  ]) {
    const w = planWorld();
    change(w);
    const outcome = plain(await applyBookPlanEdit(w.deps, bookAction([{ id: 'b', entry: 'x' }]), { bookPlan: w.baselineOf(['b']) }));
    assert.deepEqual(outcome, skippedOutcome('ui.map_chat_skip_book_started'));
    assert.deepEqual(w.writes, []);
  }
  const w = planWorld();
  assert.equal(plain(await applyBookPlanEdit(w.deps, bookAction([{ id: 'b', entry: 'x' }]), {})).status, 'skipped', 'no bookPlan in the baseline');
});

test('edit_book_plan: the view memory leaving the review mid-write stops the write (authorize)', async () => {
  const w = planWorld();
  const guarded = w.deps.updateNoteGuarded;
  w.deps.updateNoteGuarded = async (...args) => { w.state.memory = { ...w.doc, bookPipeline: { ...w.doc.bookPipeline, phase: 'writing' } }; return guarded(...args); };
  const outcome = plain(await applyBookPlanEdit(w.deps, bookAction([{ id: 'b', entry: 'x' }, { id: 'c', entry: 'y' }]), { bookPlan: w.baselineOf(['b', 'c']) }));
  assert.equal(outcome.status, 'skipped');
  assert.deepEqual(w.writes, []);
});

test('chat action writer: edit_book_plan goes to the port with the baseline', async () => {
  const w = world();
  const seen = [];
  const writer = new ChatActionWriter({ ...w.ports, applyBookPlanEdit: async (action, baseline) => { seen.push([action.kind, baseline.bookPlan.runId]); return { status: 'done' }; } });
  const outcome = plain(await writer.write(bookAction([{ id: 'x', entry: 'y' }]), w.baseline({ bookPlan: { runId: 'run-1', unlocked: [], prompts: {} } }), () => true, w.run()));
  assert.deepEqual(outcome, { status: 'done' });
  assert.deepEqual(seen, [['edit_book_plan', 'run-1']]);
});

test('bookPlanChatInput: only in the plan review; cards in reading order with the proposal baseline; locked marked', async () => {
  const w = planWorld();
  const input = plain(await bookPlanChatInput(w.deps));
  assert.equal(input.runId, 'run-1');
  assert.deepEqual(input.cards.map(card => card.id), ['r', 'a', 'b', 'c']);
  assert.equal(input.prompts.b.prompt, w.prompts.b);
  assert.equal(input.prompts.b.kind, 'chapter');
  assert.equal(input.prompts.b.title, 'B');
  w.doc.bookPipeline.phase = 'writing';
  assert.equal(await bookPlanChatInput(w.deps), undefined);
  const none = planWorld();
  none.state.memory = null;
  assert.equal(await bookPlanChatInput(none.deps), undefined);
});

test('edit_book_plan: skipped cards are named with the reason (locked / changed since the proposal); a no-change card is only counted', async () => {
  const w = planWorld();
  w.cards.get('b.md').prompt += '\nthe reader added a line';
  const changed = plain(await applyBookPlanEdit(w.deps, bookAction([
    { id: 'b', entry: 'new entry' }, { id: 'c', entry: 'other entry' }
  ]), { bookPlan: w.baselineOf(['b', 'c']) }));
  assert.match(changed.note, /\(1 cards left as they are\): B \(changed since the proposal\)$/);
  const lockedWorld = planWorld();
  const locked = plain(await applyBookPlanEdit(lockedWorld.deps, bookAction([
    { id: 'b', entry: 'x' }, { id: 'c', entry: 'other entry' }
  ]), { bookPlan: lockedWorld.baselineOf(['c']) }));
  assert.match(locked.note, /\(1 cards left as they are\): b \(locked\)$/, 'a card outside the proposal falls back to its id');
  const same = planWorld();
  const noChange = plain(await applyBookPlanEdit(same.deps, bookAction([
    { id: 'b', entry: 'e' }, { id: 'c', entry: 'other entry' }
  ]), { bookPlan: same.baselineOf(['b', 'c']) }));
  assert.match(noChange.note, /\(1 cards left as they are\)$/);
  assert.doesNotMatch(noChange.note, /B/);
});

// ---- bookPlanDiff (the plan card's before / after) ----

const { bookPlanDiff } = load('experiences/visual-map/book-plan-diff.ts', { obsidian: {} });

test('bookPlanDiff: only the changed fields are shown, with the card title; points and checklist are joined', () => {
  const w = planWorld();
  const baseline = { bookPlan: { ...w.baselineOf(['b']), prompts: { b: { path: 'b.md', prompt: w.prompts.b, kind: 'chapter', title: 'B' } } } };
  const cards = plain(bookPlanDiff(bookAction([
    { id: 'b', entry: 'new entry', handoff: 'h', points: ['p1', 'p2'], checklist: [{ type: 'fact', text: 'who pays' }] }
  ]), baseline));
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, 'B');
  assert.deepEqual(cards[0].fields.map(f => f.label), [t('ui.map_chat_book_field_entry'), t('ui.map_chat_book_field_points'), t('ui.map_chat_book_field_checklist')]);
  assert.deepEqual(cards[0].fields.map(f => [f.before, f.after]), [['e', 'new entry'], ['p1', 'p1, p2'], ['c1', 'who pays']]);
});

test('bookPlanDiff: an unknown id is skipped, a card with no real change is dropped, nothing left returns undefined', () => {
  const w = planWorld();
  const baseline = { bookPlan: w.baselineOf(['b', 'c']) };
  const cards = plain(bookPlanDiff(bookAction([{ id: 'zzz', entry: 'x' }, { id: 'b', entry: 'e' }, { id: 'c', entry: 'new' }]), baseline));
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, 'c', 'a card without a title falls back to its id');
  assert.equal(bookPlanDiff(bookAction([{ id: 'zzz', entry: 'x' }, { id: 'b', entry: 'e' }]), baseline), undefined);
  assert.equal(bookPlanDiff(bookAction([{ id: 'b', entry: 'x' }]), undefined), undefined);
  assert.equal(bookPlanDiff(bookAction([{ id: 'b', entry: 'x' }]), {}), undefined);
});

test('bookPlanDiff: a field that is empty before shows an empty before', () => {
  const empty = planText.composeCardPrompt({ role: 'body', kind: 'chapter', covers: 'c', points: [], entry: '', handoff: 'h', checklist: [] }, 'en');
  const baseline = { bookPlan: { runId: 'run-1', unlocked: ['b'], prompts: { b: { path: 'b.md', prompt: empty, kind: 'chapter', title: 'B' } } } };
  const cards = plain(bookPlanDiff(bookAction([{ id: 'b', entry: 'fresh', points: ['p1', 'p2'] }]), baseline));
  assert.deepEqual(cards[0].fields.map(f => [f.before, f.after]), [['', 'fresh'], ['', 'p1, p2']]);
});
