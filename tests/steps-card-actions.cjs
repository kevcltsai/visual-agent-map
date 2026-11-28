// V3.3 P1.8a (ticket B04): the card action registry, experiences/visual-map/card-actions.ts. The palette, the card ⋯ and the
// right-click read it since B05–B07; every other expectation is read from the entry that draws or runs the action today
// (experiences/visual-map/view.ts) and says where.
// The contexts are: normal, read-only (notes still loading: whenEditing / canEditSummary refuse), merging, AI-locked card,
// presentation, topic selection mode, and the two picture-book locks (bookLock().ai / .structure).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support.cjs');
// The module runs in its own vm realm: compare plain copies.
const eq = (actual, expected, message) => assert.deepEqual(S.plain(actual), S.plain(expected), message);

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const obsidian = { ...S.obsidian, Platform: { isMacOS: false } };
const actions = S.load('experiences/visual-map/card-actions.ts', { obsidian });
const { MAP_KEYBOARD_SHORTCUTS } = S.load('ui/modals/keyboard-shortcuts-modal.ts', { obsidian });
const { en } = S.load('i18n/en.ts');
const { zhTW } = S.load('i18n/zh-TW.ts');
const { zhCN } = S.load('i18n/zh-CN.ts');
const { CARD_ACTIONS, actionsFor, cardActionKind, titleKeyFor, commandTitleKey, shortcutKeysFor, CARD_COMMANDS, CARD_TOOLBAR, CARD_ACTION_REASONS, ruleMoreSet, ruleContextSet, TOOLBAR_ONLY } = actions;

// a (root, child b), b (leaf under a), ai (an AI card), d (a second root).
const nodes = [
  { id: 'a', parentId: null, path: 'a.md', collapsed: false },
  { id: 'b', parentId: 'a', path: 'b.md', collapsed: false },
  { id: 'ai', parentId: null, path: 'ai.md', collapsed: false },
  { id: 'd', parentId: null, path: 'd.md', collapsed: false },
  { id: 'p', parentId: null, path: 'p.md', collapsed: false },
  { id: 'e', parentId: null, path: 'e.md', collapsed: false }
];
const byId = id => nodes.find(node => node.id === id);
const recorder = () => {
  const calls = [];
  return { calls, host: new Proxy({}, { get: (_, name) => (...args) => { calls.push([name, ...args]); } }) };
};
const CONTEXTS = ['normal', 'readOnly', 'merging', 'aiLocked', 'presentation', 'multiSelect', 'bookAi', 'bookStructure'];
/** A context as cardActionContext builds it: `target` is a card id, an array of selected ids, or null for the map. */
function ctxFor(target, state, extra = {}) {
  const single = typeof target === 'string' ? byId(target) : null;
  const ids = single ? [single.id] : Array.isArray(target) ? target : [];
  const notes = { a: { prompt: '' }, b: { prompt: '' }, d: { prompt: '' }, ai: { prompt: 'go', aiCard: true }, p: { prompt: 'go' }, e: { prompt: '  ', aiCard: true } };
  if (state === 'aiLocked') for (const id of ids) notes[id] = { ...notes[id], aiLocked: true };
  return {
    node: single,
    ids,
    nodes,
    presentation: state === 'presentation',
    readOnly: state === 'readOnly',
    // A selection context is always in topic selection mode (the selection bar exists only then).
    multiSelect: state === 'multiSelect' || Array.isArray(target),
    bookLock: { ai: state === 'bookAi', structure: state === 'bookStructure' },
    hasViewport: true,
    managedMap: true,
    emptyCanvas: false,
    branchFocused: false,
    knowledgeRefs: { editable: false, copied: false },
    note: id => notes[id],
    isMerging: () => state === 'merging',
    titles: list => list.map(id => id.toUpperCase()).join(', '),
    isArgumentCard: () => false,
    summaryFieldOffered: () => true,
    stylesEditable: true,
    aiRunning: () => false,
    bookMenu: () => true,
    mergeBlock: () => null,
    multiResearchRunning: () => false,
    runAllWorking: () => false,
    host: recorder().host,
    ...extra
  };
}
const R = CARD_ACTION_REASONS;
const CODE = { ok: { ok: true }, ro: { ok: false, reasonKey: R.readOnly }, mg: { ok: false, reasonKey: R.merging }, al: { ok: false, reasonKey: R.aiLock }, pr: { ok: false, reasonKey: R.presentation }, ms: { ok: false, reasonKey: R.multiSelect }, bk: { ok: false, reasonKey: R.bookLock }, lk: { ok: false, reasonKey: 'ui.selection_locked_0_1', reasonArgs: [2, 'A, D'] } };
const action = id => CARD_ACTIONS.find(item => item.id === id);
const availability = (id, surface, ctx) => {
  const row = actionsFor(surface, ctx).find(entry => entry.action.id === id);
  assert.ok(row, `${id} is offered on ${surface}`);
  return row.availability;
};

// [action, surface, target, expected under CONTEXTS in order] — the current condition and where it is read.
const TABLE = [
  // Command palette (mapCommand → actionsFor('command')): the card gates, the loading notes and the picture-book locks included
  // (decision #35); the topic ones need a selected card.
  ['add-topic', 'command', null, 'ok ro ok ok pr ms ok bk'],
  ['add-child', 'command', 'a', 'ok ro ok ok pr ms ok bk'],
  ['add-sibling', 'command', 'a', 'ok ro ok ok pr ms ok bk'],
  ['research', 'command', 'a', 'ok ro ok al pr ms bk ok'],
  ['rename', 'command', 'a', 'ok ro ok ok pr ms ok ok'],
  ['open-note', 'command', 'a', 'ok ok ok ok ok ok ok ok'], // open-details: run(!!selected)
  ['toggle-collapse', 'command', 'a', 'ok ro ok ok pr ms ok ok'],
  ['focus-branch', 'context', 'a', 'ok ro ok ok pr ms ok ok'], // enterBranchFocus refuses presenting; B13 (loading too: #35, as the menus' whenEditing)
  ['leave-focus', 'command', null, 'ok ok ok ok ok ok ok ok', { branchFocused: true }],
  ['zoom-fit', 'command', null, 'ok ok ok ok ok ok ok ok'], // run(!!this.viewportEl)
  ['zoom-reset', 'command', null, 'ok ok ok ok ok ok ok ok'],
  ['search', 'command', null, 'ok ok ok ok pr ok ok ok'], // run(!this.presentation)
  ['shortcuts', 'command', null, 'ok ok ok ok ok ok ok ok'], // run(true)
  // Card toolbar (paintCardToolbar, from CARD_TOOLBAR since B08): drawn only outside topic selection; a button refused for
  // loading or a picture-book lock is not drawn; every other button runs through whenEditing (presentation, notesLoading).
  ['research', 'toolbar', 'a', 'ok ro ok al pr ms bk ok'], // if (!bookLock.ai); openTopicChat refuses an AI-locked card
  // B08: Style (each popover choice also goes through mergeUnlocked). B19b-x (decision #62): the structure lock covers parent
  // and order only, so Style stays under both picture-book locks.
  ['style', 'toolbar', 'a', 'ok ro ok ok pr ms ok ok'],
  // B08: the AI card's Run (as Run card), Lock and Settings (as Edit AI card).
  ['run-stop', 'toolbar', 'ai', 'ok ro ok al pr ms bk ok'],
  ['ai-lock', 'toolbar', 'ai', 'ok ro ok ok pr ms ok ok'],
  ['ai-settings', 'toolbar', 'ai', 'ok ro ok ok pr ms bk ok'],
  // B08: Add subtopic left the toolbar (the edge "+ Topic card" and Cmd+Enter replace it); the right-click keeps it.
  ['add-child', 'context', 'a', 'ok ro ok ok pr ms ok bk'],
  // Note: a plain button since V3.3 A5 (no whenEditing): it works while loading and presenting.
  ['open-note', 'toolbar', 'a', 'ok ok ok ok ok ms ok ok'],
  // Run all's Stop (paintPromptState, V3.3 A5): on the AI card Run all is working on; hidden while picking topics or presenting.
  ['stop-run-all', 'toolbar', 'ai', 'ok ok ok ok pr ms ok ok', { runAllWorking: id => id === 'ai' }],
  // B08: the AI card's own Stop while the AI works on it, a plain button like Run all's.
  ['run-stop', 'toolbar', 'ai', 'ok ok ok ok pr ms ok ok', { aiRunning: id => id === 'ai' }],
  ['add-summary-field', 'more', 'a', 'ok ro ok ok pr ms ok ok'], // B08: out of the toolbar into ⋯ (summaryFieldOffered)
  // Edge "+ Topic card" (paintCardEdgeEntries, V3.3 A6): drawn while cardTextEditable (not loading, presenting or picking) and
  // !bookLock.structure; the click goes through whenEditing. It reads neither merging nor the AI locks.
  ['edge-add-topic', 'edge', 'a', 'ok ro ok ok pr ms ok bk'],
  ['edge-add-topic', 'edge', 'ai', 'ok ro ok ok pr ms ok bk'],
  // Edge "✦ AI card" (V3.3 A7): the edge's gates plus !bookLock().ai; the click goes through whenEditing.
  ['edge-ai-card', 'edge', 'a', 'ok ro ok ok pr ms bk bk'],
  ['edge-ai-card', 'edge', 'ai', 'ok ro ok ok pr ms bk bk'],
  // Empty canvas "✦ AI root" (fillEmptyMap, V3.3 A7): cardTextEditable && !bookLock().ai && a managed map; whenEditing.
  ['ai-root', 'canvas', null, 'ok ro ok ok pr ms bk ok', { emptyCanvas: true }],
  // ⋯ (openCardMoreMenu): returns while presenting; opened from the toolbar (no selection mode); whenEditing; canEditSummary.
  ['card-settings', 'more', 'a', 'ok ro ok ok pr ms ok bk'],
  ['run-card', 'more', 'ai', 'ok ro ok al pr ms bk ok'], // isAiCard && !aiLocked && !bookLock.ai
  ['ai-card', 'more', 'a', 'ok ro ok ok pr ms bk ok'], // canSetAiCard: !bookLock.ai
  ['select-subtopics', 'more', 'a', 'ok ro ok ok pr ms ok bk'],
  ['summary-add', 'more', 'a', 'ok ro ok ok pr ms ok ok'], // canEditSummary
  ['tidy-branch', 'more', 'a', 'ok ro ok ok pr ms ok ok'], // canEditSummary and subtopics (A10)
  ['note-style', 'more', 'a', 'ok ro ok ok pr ms ok ok'], // canEditSummary
  ['add-other', 'more', 'a', 'ok ro ok ok pr ms ok bk'],
  // Right-click (onCanvasContextMenu → addCardMenuActions): canEditSummary on a card; the single-card list only outside selection mode.
  ['add-child', 'context', 'a', 'ok ro ok ok pr ms ok bk'],
  ['add-sibling', 'context', 'a', 'ok ro ok ok pr ms ok bk'],
  ['research', 'context', 'a', 'ok ro ok al pr ms bk ok'],
  ['toggle-collapse', 'context', 'a', 'ok ro ok ok pr ms ok ok'],
  ['open-note', 'context', 'a', 'ok ro ok ok pr ms ok ok'],
  ['card-settings', 'context', 'a', 'ok ro ok ok pr ms ok bk'],
  ['run-card', 'context', 'ai', 'ok ro ok al pr ms bk ok'],
  ['ai-card', 'context', 'a', 'ok ro ok ok pr ms bk ok'],
  ['book', 'context', 'a', 'ok ro ok ok pr ms ok ok'], // addBookMenu (its rows keep their own reasons)
  // F01: shown only where references may change and not on a merging card (applies); the card gates otherwise.
  ['knowledge-ref-copy', 'context', 'a', 'ok ro ok ok pr ms ok ok', { knowledgeRefs: { editable: true, copied: false } }],
  ['knowledge-ref-paste', 'context', 'a', 'ok ro ok ok pr ms ok ok', { knowledgeRefs: { editable: true, copied: true } }],
  // F09: read only; only the notes-loading gate (decision #35) greys it.
  ['impact', 'context', 'a', 'ok ro ok ok ok ok ok ok'],
  ['remove', 'context', 'a', 'ok ro mg ok pr ms ok bk'], // single && !bookLock.structure; removeByKey → confirmRemoveNode refuses a merging branch
  // Keys (card keydown in renderNode, the view scope in installUndoScope, searchKey).
  ['add-child', 'key', 'a', 'ok ro ok ok pr ms ok bk'], // Mod+Enter: presentation/notesLoading/bookLock.structure swallowed, selection mode passed on
  ['add-sibling', 'key', 'a', 'ok ro ok ok pr ms ok bk'], // Shift+Enter
  ['rename', 'key', 'a', 'ok ro ok ok pr ms ok ok'], // Enter: selection mode toggles the tick instead; notesLoading returns
  ['toggle-collapse', 'key', 'a', 'ok ro ok ok pr ms ok ok'], // onCardSpaceDown
  ['remove', 'key', 'a', 'ok ro mg ok pr ms ok bk'], // Delete/Backspace: editable = !multiSelectMode && !notesLoading && !bookLock.structure; removeByKey
  ['reorder-sibling', 'key', 'b', 'ok ro mg ok pr ms ok ok'], // Alt+arrow; shiftSiblingByKey refuses a merging card or parent
  ['search', 'key', null, 'ok ro ok ok pr ok ok ok'], // Mod+F: presentation || notesLoading swallowed
  // Selection bar (renderSelectionBar) and its ⋯ (openSelectionMoreMenu): only in topic selection mode; no presentation or notesLoading check.
  // B19a (P1.9): an AI-locked or merging card in the selection refuses Merge and Move to as a whole, naming the cards.
  // B19b: Color is a batch write: presentation and loading notes refuse it too (changeSelectionColor rechecks). Parent ruling:
  // the picture-book structure lock covers parent and order only, so a colour stays available under both book locks.
  ['batch-color', 'toolbar', ['a', 'd'], 'ok ro lk lk pr ok ok ok'],
  ['merge', 'toolbar', ['a', 'd'], 'ok ok lk lk ok ok bk ok'], // if (!bookLock.ai); aria-disabled by mergeCheck (below)
  ['multi-research', 'toolbar', ['a', 'd'], 'ok ok ok ok ok ok bk ok'],
  ['move-to', 'toolbar', ['a', 'd'], 'ok ok lk lk ok ok ok bk'], // chooseSelectedParent refuses merging branches
  ['finish-selection', 'toolbar', ['a', 'd'], 'ok ok ok ok ok ok ok ok'],
  ['synthesize', 'more', ['a', 'd'], 'ok ok ok ok ok ok bk ok'],
  ['copy-to', 'more', ['a', 'd'], 'ok ok mg ok ok ok ok bk'],
  ['add-frame', 'more', ['a', 'd'], 'ok ok ok ok ok ok ok ok'],
  ['summary-add-selected', 'more', ['a', 'd'], 'ok ok ok ok ok ok ok ok'],
  ['ai-lock-selected', 'more', ['a', 'd'], 'ok ok ok ok ok ok ok ok'],
  ['clear-selection', 'more', ['a', 'd'], 'ok ok ok ok ok ok ok ok'],
  ['remove-selected', 'more', ['a', 'd'], 'ok ok mg ok ok ok ok bk'], // confirmRemoveSelected refuses merging branches
  ['selection-help', 'more', ['a', 'd'], 'ok ok ok ok ok ok ok ok'], // B09: the bar's "?" is the ⋯ menu's last row
  // Right-click on a selection (the !single branch): canEditSummary.
  ['summary-add-selected', 'context', ['a', 'd'], 'ok ro ok ok pr ok ok ok'],
  ['note-style', 'context', ['a'], 'ok ro ok ok pr ok ok ok'], // one topic in selection mode
  // Image right-click (openImageMenu → addCardActions, P5.3): the card gates; an image does not merge and no picture-book lock
  // stops its menu today (convertImageDialog's canEditCanvasItems).
  ['image-explore', 'context', null, 'ok ro ok ok pr ms ok ok', { image: { id: 'img1', annotated: true } }],
  ['image-explore', 'context', null, 'ok ro ok ok pr ms ok ok', { image: { id: 'img1', annotated: false } }]
];

test('card actions: available matches every current entry under each context', () => {
  for (const [id, surface, target, expected, extra] of TABLE) {
    const codes = expected.split(' ');
    CONTEXTS.forEach((state, index) =>
      eq(availability(id, surface, ctxFor(target, state, extra)), CODE[codes[index]], `${id} on ${surface} (${state})`)
    );
  }
});

// P3.2: Run Card / Stop belong to a real AI card only (`ai-card` plus a non-empty Prompt). The ordinary card, AI lock and picture-book
// lock rows are in the table above; a Prompt without `ai-card` and an `ai-card` with a blank Prompt are not AI cards.
test('card actions: a Prompt-only card and an AI card with a blank Prompt never offer run-stop or run-card on any surface', () => {
  const surfaces = ['toolbar', 'more', 'context', 'command', 'key', 'edge', 'canvas'];
  for (const id of ['p', 'e'])
    for (const state of CONTEXTS)
      for (const surface of surfaces) {
        const offered = actionsFor(surface, ctxFor(id, state)).map(entry => entry.action.id);
        assert.ok(!offered.includes('run-stop') && !offered.includes('run-card'), `${id} (${state}) on ${surface}: ${offered}`);
      }
  assert.notEqual(cardActionKind(ctxFor('p', 'normal')), 'ai-card');
  assert.notEqual(cardActionKind(ctxFor('e', 'normal')), 'ai-card');
  assert.equal(cardActionKind(ctxFor('ai', 'normal')), 'ai-card', 'control: a real AI card still is one');
  assert.ok(actionsFor('more', ctxFor('ai', 'normal')).some(entry => entry.action.id === 'run-card'), 'control: it offers Run Card');
});

test('card actions: the table covers every action, and every unavailable answer has a reason in all three languages', () => {
  const covered = new Set(TABLE.map(([id]) => id));
  eq(CARD_ACTIONS.map(item => item.id).filter(id => !covered.has(id)), []);
  const reasons = new Set();
  for (const [id, surface, target, , extra] of TABLE)
    for (const state of CONTEXTS) {
      const result = availability(id, surface, ctxFor(target, state, extra));
      if (!result.ok) reasons.add(result.reasonKey);
    }
  reasons.add('ui.select_at_least_two_topics').add('ui.multi_research_already_running').add('ui.card_action_off_no_lockable');
  for (const key of [...reasons, ...Object.values(R)])
    for (const [name, dictionary] of [['en', en], ['zh-TW', zhTW], ['zh-CN', zhCN]]) assert.ok(dictionary[key]?.trim(), `${key} in ${name}`);
  assert.equal(Object.keys(R).length, 6);
  assert.equal(zhTW[R.aiLock], '這張卡已鎖定，不讓 AI 修改；先在工具列解除鎖定');
});

test('card actions: selection reasons that come from the selection itself', () => {
  // mergeCheck's own reason is the bar's tooltip; Synthesize is disabled under two topics; Research is disabled while its batch runs.
  eq(availability('merge', 'toolbar', ctxFor(['a', 'd'], 'normal', { mergeBlock: () => 'ui.select_at_least_two_topics' })), { ok: false, reasonKey: 'ui.select_at_least_two_topics' });
  eq(availability('synthesize', 'more', ctxFor(['a'], 'normal')), { ok: false, reasonKey: 'ui.select_at_least_two_topics' });
  eq(availability('multi-research', 'toolbar', ctxFor(['a', 'd'], 'normal', { multiResearchRunning: () => true })), { ok: false, reasonKey: 'ui.multi_research_already_running' });
  // B19a: one locked card of three names only that card; the lock is said before mergeCheck's reason; a merging card
  // below a selected one (not itself selected) still gives Move to the old merging reason.
  const oneLocked = ctxFor(['a', 'd', 'b'], 'normal', { note: id => (id === 'd' ? { prompt: '', aiLocked: true } : { prompt: '' }), mergeBlock: () => 'ui.merge_ancestor_selected' });
  const lockOne = { ok: false, reasonKey: 'ui.selection_locked_0_1', reasonArgs: [1, 'D'] };
  eq(availability('merge', 'toolbar', oneLocked), lockOne);
  eq(availability('move-to', 'toolbar', oneLocked), lockOne);
  eq(availability('batch-color', 'toolbar', oneLocked), lockOne);
  eq(availability('multi-research', 'toolbar', oneLocked), { ok: true }, 'Research is not a batch change');
  eq(availability('merge', 'toolbar', ctxFor(['a', 'b'], 'normal', { mergeBlock: () => 'ui.merge_ancestor_selected' })), { ok: false, reasonKey: 'ui.merge_ancestor_selected' });
  eq(availability('move-to', 'toolbar', ctxFor(['a'], 'normal', { isMerging: id => id === 'b' })), { ok: false, reasonKey: R.merging });
});

test('card actions: what a card offers follows the card, as the entries decide it now', () => {
  const ids = (surface, ctx) => actionsFor(surface, ctx).map(entry => entry.action.id);
  // No subtopics: no fold, no select subtopics; a folded card has no select subtopics either.
  assert.ok(!ids('context', ctxFor('b', 'normal')).includes('toggle-collapse'));
  assert.ok(!ids('more', ctxFor('b', 'normal')).includes('select-subtopics'));
  nodes[0].collapsed = true;
  assert.ok(!ids('more', ctxFor('a', 'normal')).includes('select-subtopics'));
  assert.equal(titleKeyFor(action('toggle-collapse'), 'context', ctxFor('a', 'normal')), 'ui.card_menu_expand');
  nodes[0].collapsed = false;
  assert.equal(titleKeyFor(action('toggle-collapse'), 'context', ctxFor('a', 'normal')), 'ui.card_menu_collapse');
  // Run card only on an AI card; the AI card entry says Edit there and Make it an AI card elsewhere; an argument card has neither.
  assert.ok(!ids('more', ctxFor('a', 'normal')).includes('run-card'));
  assert.equal(cardActionKind(ctxFor('ai', 'normal')), 'ai-card');
  assert.equal(titleKeyFor(action('ai-card'), 'more', ctxFor('ai', 'normal')), 'ui.ai_card_edit');
  assert.equal(titleKeyFor(action('ai-card'), 'more', ctxFor('a', 'normal')), 'ui.ai_card_set');
  assert.ok(!ids('more', ctxFor('a', 'normal', { isArgumentCard: () => true })).includes('ai-card'));
  // Add summary only on an empty summary; the book row only when the card is a chapter.
  assert.ok(!ids('more', ctxFor('a', 'normal', { summaryFieldOffered: () => false })).includes('add-summary-field'));
  assert.ok(!ids('context', ctxFor('a', 'normal', { bookMenu: () => false })).includes('book'));
  // A root has no sibling order to change by Alt+arrow (shiftSiblingByKey needs a parent).
  assert.ok(!ids('key', ctxFor('a', 'normal')).includes('reorder-sibling'));
  // Rename needs the card's note (mapCommand: !!note; the keys: note).
  assert.ok(!ids('command', ctxFor('a', 'normal', { note: () => undefined })).includes('rename'));
  // Zoom needs the drawn canvas.
  assert.ok(!ids('command', ctxFor(null, 'normal', { hasViewport: false })).includes('zoom-fit'));
  // Note style on a selection only for one topic; the selection ⋯ never has it.
  assert.ok(!ids('context', ctxFor(['a', 'd'], 'normal')).includes('note-style'));
  assert.ok(!ids('more', ctxFor(['a'], 'normal')).includes('note-style'));
  // Lock from AI: the label follows the selection (all locked → Unlock); a selection with no lockable topic still lists it (B09), off, with the reason.
  assert.equal(titleKeyFor(action('ai-lock-selected'), 'more', ctxFor(['a', 'd'], 'aiLocked')), 'ui.ai_unlock_selected');
  assert.equal(titleKeyFor(action('ai-lock-selected'), 'more', ctxFor(['a', 'd'], 'normal')), 'ui.ai_lock_toggle');
  eq(availability('ai-lock-selected', 'more', ctxFor(['a', 'd'], 'normal', { isArgumentCard: () => true })), { ok: false, reasonKey: 'ui.card_action_off_no_lockable' });
  eq(availability('ai-lock-selected', 'more', ctxFor(['a', 'd'], 'normal')), { ok: true });
  assert.equal(titleKeyFor(action('synthesize'), 'more', ctxFor(['a', 'd'], 'normal')), 'ui.synthesize_0_topics');
  assert.equal(titleKeyFor(action('synthesize'), 'more', ctxFor(['a'], 'normal')), 'ui.synthesize');
  // A card's actions never come with a selection context, nor a selection's with a card's.
  assert.ok(!ids('more', ctxFor('a', 'normal')).includes('copy-to'));
  assert.ok(!ids('toolbar', ctxFor(['a', 'd'], 'normal')).includes('research'));
});

test('card actions: order, groups and the toolbar sets reproduce the entries of today', () => {
  const ids = (surface, ctx) => actionsFor(surface, ctx).map(entry => entry.action.id);
  const orders = CARD_ACTIONS.map(item => item.order);
  eq(orders, [...orders].sort((x, y) => x - y), 'CARD_ACTIONS is in order');
  assert.equal(new Set(orders).size, orders.length);
  assert.equal(new Set(CARD_ACTIONS.map(item => item.id)).size, CARD_ACTIONS.length);
  // paintCardToolbar (B08, mockup §4): AI explore, Style, Note (then ⋯).
  eq(ids('toolbar', ctxFor('a', 'normal')), ['research', 'style', 'open-note']);
  // The AI card: Run (Stop while running; Run all's Stop while the batch works on it), Lock, AI explore, Settings, Note.
  eq(CARD_TOOLBAR['ai-card'], ['stop-run-all', 'run-stop', 'ai-lock', 'research', 'ai-settings', 'open-note']);
  eq(ids('toolbar', ctxFor('ai', 'normal')), ['run-stop', 'ai-lock', 'research', 'ai-settings', 'open-note']);
  eq(ids('toolbar', ctxFor('ai', 'normal', { runAllWorking: id => id === 'ai' })), ['stop-run-all', 'ai-lock', 'research', 'ai-settings', 'open-note']);
  // openCardMoreMenu (B06, ticket 06 and mockup §4): settings, focus this branch (B13), add summary (B08), select subtopics, summary bracket, tidy this branch (A10), note style, run, AI card, book |
  // add subtopic (B08: off the toolbar), add sibling, add another type | fold, remove. An AI card has Style here (not on its toolbar).
  const grouped = (surface, ctx) => actionsFor(surface, ctx).map(entry => `${entry.action.group}:${entry.action.id}`);
  eq(grouped('more', ctxFor('ai', 'normal')), ['2:style', '3:card-settings', '3:add-summary-field', '3:summary-add', '3:note-style', '3:run-card', '3:ai-card', '3:book', '4:add-child', '4:add-sibling', '4:add-other', '4:impact', '5:remove']);
  eq(grouped('more', ctxFor('a', 'normal')), ['3:card-settings', '3:focus-branch', '3:add-summary-field', '3:select-subtopics', '3:summary-add', '3:tidy-branch', '3:note-style', '3:ai-card', '3:book', '4:add-child', '4:add-sibling', '4:add-other', '4:impact', '5:toggle-collapse', '5:remove']);
  // addCardMenuActions (B07): the toolbar's actions in its order, then the ⋯ list in its order (the view puts a separator between them).
  eq(ids('context', ctxFor('a', 'normal')), [...CARD_TOOLBAR.card, ...ids('more', ctxFor('a', 'normal'))]);
  eq(ids('context', ctxFor('ai', 'normal')), ['research', 'open-note', ...ids('more', ctxFor('ai', 'normal'))]);
  assert.equal(action('add-other').group, 4, 'the ⋯ list puts a separator before Add another type');
  // renderSelectionBar (B09, B19b): Color, Move to, Merge, Research, (⋯) Done; openSelectionMoreMenu: Synthesize … AI lock | Clear, Remove, Selection help.
  eq(ids('toolbar', ctxFor(['a', 'd'], 'normal')), ['batch-color', 'move-to', 'merge', 'multi-research', 'finish-selection']);
  eq(actionsFor('more', ctxFor(['a', 'd'], 'normal')).map(entry => `${entry.action.group}:${entry.action.id}`), ['1:synthesize', '1:copy-to', '1:add-frame', '1:summary-add-selected', '1:ai-lock-selected', '2:clear-selection', '2:remove-selected', '2:selection-help']);
  // The rules B06/B07 move to: ⋯ = the card's menu actions minus the toolbar set; right-click = toolbar, separator, ⋯.
  for (const kind of ['card', 'ai-card']) {
    const more = ruleMoreSet(kind);
    assert.ok(more.every(id => !CARD_TOOLBAR[kind].includes(id)));
    eq(ruleContextSet(kind), [...CARD_TOOLBAR[kind].filter(id => !TOOLBAR_ONLY.includes(id)), 'separator', ...more]);
  }
  assert.ok(ruleMoreSet('ai-card').includes('run-card') && !ruleMoreSet('card').includes('run-card'));
});

test('card actions: the eleven palette commands keep their ids, B13 adds Focus on this branch, and all take the card action list names', () => {
  // The ids and mapCommand actions main.ts registered before B05 (a user's hotkeys are bound to the ids), plus B13's new one; each
  // name is the list's name, the one the card ⋯ and right-click show (ticket 05).
  const commands = [
    ['map-add-topic', 'ui.command_map_add_topic', 'add-topic'],
    ['map-add-subtopic', 'ui.card_menu_add_child', 'add-subtopic'],
    ['map-add-sibling', 'ui.card_menu_add_sibling', 'add-sibling'],
    ['map-ai-explore-selected', 'ui.ai_explore', 'ai-explore'],
    ['map-rename-selected', 'ui.shortcut_rename', 'rename'],
    ['map-open-selected-details', 'ui.card_menu_open_note', 'open-details'],
    ['map-toggle-collapse-selected', 'ui.card_menu_collapse', 'toggle-collapse'],
    ['map-focus-branch', 'ui.focus_branch', 'focus-branch'],
    ['map-zoom-to-fit', 'ui.command_map_zoom_fit', 'zoom-fit'],
    ['map-zoom-reset', 'ui.command_map_zoom_reset', 'zoom-reset'],
    ['map-search', 'ui.command_map_search', 'search'],
    ['map-keyboard-shortcuts', 'ui.command_map_shortcuts', 'shortcuts']
  ].map(([id, key, mapAction]) => ({ id, key, mapAction }));
  assert.equal(CARD_COMMANDS.length, 12);
  eq(CARD_COMMANDS.map(entry => entry.commandId), commands.map(entry => entry.id));
  for (const { id, key, mapAction } of commands) {
    const entry = CARD_COMMANDS.find(item => item.commandId === id);
    assert.equal(entry.mapAction, mapAction, id);
    const target = action(entry.action);
    assert.ok(target.surfaces.includes('command'), id);
    assert.equal(commandTitleKey(entry.action), key, id);
    assert.equal(commandTitleKey(entry.action), target.titleKey, `${id}: the list's name`);
    if (target.surfaces.includes('more')) assert.equal(commandTitleKey(entry.action), titleKeyFor(target, 'more', ctxFor('a', 'normal')), `${id}: the ⋯ name`);
  }
  // main.ts registers exactly these, named by commandTitleKey, each checking through mapCommand.
  const source = read('main.ts');
  const loop = source.slice(source.indexOf('for (const { commandId, mapAction, action } of CARD_COMMANDS)'));
  assert.ok(loop.length < source.length, 'main.ts registers the palette commands from CARD_COMMANDS');
  assert.match(loop.slice(0, 600), /const key = commandTitleKey\(action\);[\s\S]*id: commandId,\s*name: t\(key\),[\s\S]*mapCommand\(mapAction, checking\)/);
});

test('card actions: shortcut hints come from MAP_KEYBOARD_SHORTCUTS, and the right-click hints match it', () => {
  for (const item of CARD_ACTIONS.filter(entry => entry.shortcut)) {
    const row = MAP_KEYBOARD_SHORTCUTS.find(entry => entry.action === item.shortcut);
    assert.ok(row, item.id);
    eq(shortcutKeysFor(item), row.keys);
  }
  const view = read('experiences/visual-map/view.ts');
  // The ⋯ and right-click rows (addCardActions) show the first key of the action's own row.
  assert.match(view, /const keys = shortcutKeysFor\(action\);[\s\S]{0,200}else if \(keys\?\.length\) this\.menuHint\(item, shortcutLabel\(keys\[0\]\)\)/);
  eq(shortcutKeysFor(action('add-child')), ['Mod+Enter']);
  eq(shortcutKeysFor(action('add-sibling')), ['Shift+Enter']);
});

test('card actions: run hands each action to the view method its entry calls now', () => {
  const run = (id, target, surface, options) => {
    const { calls, host } = recorder();
    const ctx = { ...ctxFor(target, 'normal'), host, surface };
    action(id).run(ctx, options);
    return calls.map(([name, ...args]) => [name, ...args.map(value => (value && value.id ? value.id : value))]);
  };
  const menu = { fake: 'menu' };
  eq(run('add-topic', null, 'command'), [['addTopic']]);
  eq(run('add-child', 'a', 'context'), [['addChild', 'a']]);
  eq(run('add-sibling', 'b', 'context'), [['addSibling', 'b']]);
  eq(run('research', 'a', 'toolbar', { opener: 'button' }), [['research', 'a', 'button']]);
  eq(run('rename', 'a', 'command'), [['rename', 'a']]);
  eq(run('open-note', 'a', 'context', { newTab: true }), [['openNote', 'a', true]]);
  eq(run('open-note', 'a', 'command'), [['openNote', 'a', false]]);
  // The right-click fold keeps toggleCollapsed; the command and Space keep collapseByKey (focus stays on the card).
  eq(run('toggle-collapse', 'a', 'context'), [['toggleCollapse', 'a', false]]);
  eq(run('toggle-collapse', 'a', 'key'), [['toggleCollapse', 'a', true]]);
  eq(run('toggle-collapse', 'a', 'command'), [['toggleCollapse', 'a', true]]);
  eq(run('add-summary-field', 'a', 'more'), [['addSummaryField', 'a']]);
  eq(run('style', 'a', 'toolbar', { opener: 'button' }), [['openStyle', 'a', 'button']]);
  eq(run('run-stop', 'ai', 'toolbar'), [['runCard', 'ai']]);
  eq(run('ai-settings', 'ai', 'toolbar'), [['editAiCard', 'ai']]);
  eq(run('card-settings', 'a', 'more'), [['cardSettings', 'a']]);
  eq(run('run-card', 'ai', 'more'), [['runCard', 'ai']]);
  eq(run('ai-card', 'a', 'more'), [['editAiCard', 'a']]);
  eq(run('select-subtopics', 'a', 'more'), [['selectSubtopics', 'a']]);
  eq(run('summary-add', 'a', 'more'), [['addSummary', ['a']]]);
  eq(run('tidy-branch', 'a', 'more'), [['tidyBranch', 'a']]);
  eq(run('note-style', 'a', 'more'), [['noteStyle', 'a']]);
  eq(run('note-style', ['d'], 'context'), [['noteStyle', 'd']]);
  eq(run('add-other', 'a', 'more', { menu }), [['fillAddMenu', menu, 'a']]);
  eq(run('book', 'a', 'context', { menu }), [['fillBookMenu', menu, 'a']]);
  eq(run('remove', 'a', 'key'), [['remove', 'a']]);
  eq(run('reorder-sibling', 'b', 'key', { offset: -1 }), [['reorderSibling', 'b', -1]]);
  eq(run('zoom-fit', null, 'command'), [['zoomFit']]);
  eq(run('zoom-reset', null, 'command'), [['zoomReset']]);
  eq(run('search', null, 'command'), [['search']]);
  eq(run('shortcuts', null, 'command'), [['shortcuts']]);
  eq(run('merge', ['a', 'd'], 'toolbar'), [['merge']]);
  eq(run('multi-research', ['a', 'd'], 'toolbar'), [['multiResearch']]);
  eq(run('move-to', ['a', 'd'], 'toolbar'), [['chooseParent', false]]);
  eq(run('batch-color', ['a', 'd'], 'toolbar', { opener: 'button' }), [['openBatchColor', 'button']]);
  eq(run('copy-to', ['a', 'd'], 'more'), [['chooseParent', true]]);
  eq(run('synthesize', ['a', 'd'], 'more'), [['synthesize']]);
  eq(run('add-frame', ['a', 'd'], 'more'), [['addFrame']]);
  eq(run('summary-add-selected', ['a', 'd'], 'context'), [['addSummary', ['a', 'd']]]);
  // A mixed or unlocked selection locks every lockable topic; an all-locked one unlocks.
  eq(run('ai-lock-selected', ['a', 'd'], 'more'), [['setAiLock', [byId('a'), byId('d')], true]]);
  eq(run('clear-selection', ['a', 'd'], 'more'), [['clearSelection']]);
  eq(run('remove-selected', ['a', 'd'], 'more'), [['removeSelected']]);
  eq(run('selection-help', ['a', 'd'], 'toolbar'), [['selectionHelp']]);
  eq(run('finish-selection', ['a', 'd'], 'toolbar'), [['finishSelection']]);
});

test('card actions: B13 focus this branch (card) and leave focus (map) as enterBranchFocus / exitBranchFocus have them', () => {
  const ids = (surface, ctx) => actionsFor(surface, ctx).map(entry => entry.action.id);
  const focus = action('focus-branch');
  const leave = action('leave-focus');
  assert.ok(focus && leave, 'both registered');
  // Focus: a card with subtopics, not while already focused; the ⋯, the right-click and the palette offer it.
  for (const surface of ['more', 'context', 'command']) assert.ok(ids(surface, ctxFor('a', 'normal')).includes('focus-branch'), surface);
  assert.ok(!ids('context', ctxFor('b', 'normal')).includes('focus-branch'), 'a leaf has no branch');
  assert.ok(!ids('context', ctxFor('a', 'normal', { branchFocused: true })).includes('focus-branch'), 'hidden while focused');
  for (const surface of ['toolbar', 'key', 'edge', 'canvas']) assert.ok(!ids(surface, ctxFor('a', 'normal')).includes('focus-branch'), surface);
  assert.ok(ruleMoreSet('card').includes('focus-branch') && ruleContextSet('card').includes('focus-branch'));
  // The palette's entry (main.ts registers CARD_COMMANDS) runs the same action, named as the list names it.
  eq(CARD_COMMANDS.filter(entry => entry.action === 'focus-branch').map(entry => [entry.commandId, entry.mapAction]), [['map-focus-branch', 'focus-branch']]);
  assert.equal(commandTitleKey('focus-branch'), 'ui.focus_branch');
  // enterBranchFocus refuses while presenting; picking topics has no card entries.
  assert.deepEqual(S.plain(availability('focus-branch', 'context', ctxFor('a', 'normal'))), CODE.ok);
  assert.deepEqual(S.plain(availability('focus-branch', 'context', ctxFor('a', 'presentation'))), CODE.pr);
  assert.deepEqual(S.plain(availability('focus-branch', 'command', ctxFor('a', 'multiSelect'))), CODE.ms);
  // Leave: map scope, only while focused.
  eq(ids('command', ctxFor(null, 'normal')).filter(id => id === 'leave-focus'), []);
  eq(ids('command', ctxFor(null, 'normal', { branchFocused: true })).filter(id => id === 'leave-focus'), ['leave-focus']);
  assert.deepEqual(S.plain(availability('leave-focus', 'command', ctxFor(null, 'normal', { branchFocused: true }))), CODE.ok);
  // Runs.
  const first = recorder();
  focus.run({ ...ctxFor('a', 'normal'), host: first.host, surface: 'context' });
  eq(first.calls.map(([name, node]) => [name, node.id]), [['enterBranchFocus', 'a']]);
  const second = recorder();
  leave.run({ ...ctxFor(null, 'normal', { branchFocused: true }), host: second.host, surface: 'command' });
  eq(second.calls, [['exitBranchFocus']]);
  // Names in three languages.
  assert.equal(titleKeyFor(leave, 'command', ctxFor(null, 'normal')), 'ui.exit_branch_focus');
  for (const dictionary of [en, zhTW, zhCN]) for (const key of [focus.titleKey, leave.titleKey]) assert.ok(dictionary[key]?.trim(), key);
});

test('card actions: F01 Copy as reference / Paste reference join the card list (⋯ and right-click) where references may change', () => {
  const ids = (surface, ctx) => actionsFor(surface, ctx).map(entry => entry.action.id);
  const refs = list => list.filter(id => id.startsWith('knowledge-ref-'));
  const editable = { knowledgeRefs: { editable: true, copied: false } };
  const copied = { knowledgeRefs: { editable: true, copied: true } };
  eq(refs(ids('context', ctxFor('a', 'normal'))), []);
  eq(refs(ids('context', ctxFor('a', 'normal', editable))), ['knowledge-ref-copy']);
  eq(refs(ids('context', ctxFor('a', 'normal', copied))), ['knowledge-ref-copy', 'knowledge-ref-paste']);
  eq(refs(ids('more', ctxFor('ai', 'normal', copied))), ['knowledge-ref-copy', 'knowledge-ref-paste']);
  eq(refs(ids('context', ctxFor('a', 'normal', { knowledgeRefs: { editable: false, copied: true } }))), [], 'not editable (AIM, picking, loading, a merging card): neither');
  for (const surface of ['toolbar', 'command', 'key', 'edge', 'canvas']) eq(refs(ids(surface, ctxFor('a', 'normal', copied))), [], surface);
  // After Add another type, before the fold / remove group.
  const grouped = actionsFor('more', ctxFor('a', 'normal', copied)).map(entry => `${entry.action.group}:${entry.action.id}`);
  eq(grouped.slice(grouped.indexOf('4:add-other')), ['4:add-other', '4:knowledge-ref-copy', '4:knowledge-ref-paste', '4:impact', '5:toggle-collapse', '5:remove']);
  const calls = recorder();
  for (const id of ['knowledge-ref-copy', 'knowledge-ref-paste']) action(id).run({ ...ctxFor('a', 'normal', copied), host: calls.host, surface: 'context' });
  eq(calls.calls.map(([name, node]) => [name, node.id]), [['copyKnowledgeRef', 'a'], ['pasteKnowledgeRef', 'a']]);
});

test('card actions: the view builds the context next to mapCommand; the palette, the card ⋯, the right-click and the selection bar read the registry', () => {
  const view = read('experiences/visual-map/view.ts');
  const at = view.indexOf('  cardActionContext(');
  assert.ok(at > view.indexOf('  mapCommand(action: MapCommandAction'), 'cardActionContext follows mapCommand');
  assert.ok(at < view.indexOf('  openKeyboardShortcuts(): void'));
  // B05 mapCommand, B06/B07 addCardActions (openCardMoreMenu and addCardMenuActions call it), B09 the selection bar and its ⋯; the other entries move in B08 and B10.
  const body = name => {
    const start = view.indexOf(`  ${name}(`);
    assert.ok(start >= 0, name);
    return view.slice(start, view.indexOf('\n  }\n', start));
  };
  const count = text => (text.match(/actionsFor\(/g) ?? []).length;
  assert.equal(count(body('mapCommand')), 1, 'mapCommand');
  assert.equal(count(body('private addCardActions')), 1, 'addCardActions');
  const selectionStart = view.indexOf('  private renderSelectionBar('), selectionEnd = view.indexOf("  /** The dialog's choices for each child's research");
  assert.ok(selectionStart > 0 && selectionEnd > selectionStart);
  assert.equal(count(view.slice(selectionStart, selectionEnd)), 2, 'B09: the bar and its ⋯');
  // B08: the card toolbar and its first button's repaint (paintPromptState).
  assert.equal(count(body('private paintCardToolbar')), 1, 'paintCardToolbar');
  assert.equal(count(body('private repaintRunTool')), 1, 'repaintRunTool');
  assert.equal(count(body('private cardKeyAction')), 1, 'B10: the map keys (cardKeyAction)');
  assert.equal(count(body('private async changeSelectionColor')), 1, 'B19b: the batch colour write rechecks the Color gates');
  assert.equal(count(view), 8, 'B08 toolbar and repaint, B10 key entry, B19b batch colour write; no other entry reads the registry yet');
  assert.equal((view.match(/CARD_ACTIONS/g) ?? []).length, 0);
  assert.match(body('private openCardMoreMenu'), /this\.addCardActions\(menu, "more", node\)/);
  assert.match(body('private addCardMenuActions'), /this\.addCardActions\(menu, "context", node,/);
});

test('card actions: Image exploration (P5.3) is the image right-click\'s only action, on no other surface or target', () => {
  const ids = (surface, ctx) => actionsFor(surface, ctx).map(entry => entry.action.id);
  const plainImage = { image: { id: 'img1', annotated: false } }, annotatedImage = { image: { id: 'img1', annotated: true } };
  assert.equal(cardActionKind(ctxFor(null, 'normal', plainImage)), 'image');
  // The map's own actions (zoom, search, …) stay off the image menu.
  eq(ids('context', ctxFor(null, 'normal', plainImage)), ['image-explore']);
  eq(ids('context', ctxFor(null, 'normal', annotatedImage)), ['image-explore']);
  for (const surface of ['toolbar', 'more', 'command', 'key', 'edge', 'canvas']) eq(ids(surface, ctxFor(null, 'normal', plainImage)), [], surface);
  for (const target of ['a', 'ai', ['a', 'd'], null])
    for (const surface of ['toolbar', 'more', 'context', 'command', 'key']) assert.ok(!ids(surface, ctxFor(target, 'normal')).includes('image-explore'), `${surface} ${target}`);
  assert.ok(!ruleMoreSet('card').includes('image-explore') && !ruleContextSet('ai-card').includes('image-explore'));
  // A plain image's row ends in "…" (it asks first); an annotated image's does not.
  const explore = action('image-explore');
  assert.equal(titleKeyFor(explore, 'context', ctxFor(null, 'normal', plainImage)), 'ui.image_explore_ask');
  assert.equal(titleKeyFor(explore, 'context', ctxFor(null, 'normal', annotatedImage)), 'ui.image_explore');
  for (const dictionary of [en, zhTW, zhCN])
    for (const key of ['ui.image_explore', 'ui.image_explore_ask', 'ui.image_explore_title', 'ui.image_explore_button']) assert.ok(dictionary[key]?.trim(), key);
  assert.equal(zhTW['ui.image_explore'], '圖像探索');
  assert.equal(zhTW['ui.image_explore_ask'], '圖像探索…');
  // One click runs the view's exploreImage with the image's id.
  const { calls, host } = recorder();
  explore.run(ctxFor(null, 'normal', { ...plainImage, host }));
  eq(calls, [['exploreImage', 'img1']]);
});

test('card actions: the edge "+ Topic card" (V3.3 A6) as paintCardEdgeEntries and addTopicFromEdge have it', () => {
  const ids = (surface, ctx) => actionsFor(surface, ctx).map(entry => entry.action.id);
  // Drawn on a card with a note (ordinary or AI) on a managed map; the edge's first entry (A7's ✦ AI card follows it).
  eq(ids('edge', ctxFor('a', 'normal')), ['edge-add-topic', 'edge-ai-card']);
  eq(ids('edge', ctxFor('ai', 'normal')), ['edge-add-topic', 'edge-ai-card']);
  eq(ids('edge', ctxFor('a', 'normal', { note: () => undefined })), []);
  eq(ids('edge', ctxFor('a', 'normal', { managedMap: false })), []);
  // Never on a selection or the map, and no other surface offers it.
  eq(ids('edge', ctxFor(['a', 'd'], 'normal')), []);
  eq(ids('edge', ctxFor(null, 'normal')), []);
  for (const surface of ['toolbar', 'more', 'context', 'command', 'key']) assert.ok(!ids(surface, ctxFor('a', 'normal')).includes('edge-add-topic'), surface);
  assert.ok(!ruleMoreSet('card').includes('edge-add-topic') && !ruleContextSet('card').includes('edge-add-topic'));
  // Names as the entry draws them, in all three languages.
  const edge = action('edge-add-topic');
  assert.equal(titleKeyFor(edge, 'edge', ctxFor('a', 'normal')), 'ui.card_edge_add');
  assert.equal(edge.ariaLabelKey, 'ui.card_edge_add_label');
  for (const dictionary of [en, zhTW, zhCN]) for (const key of [edge.titleKey, edge.ariaLabelKey]) assert.ok(dictionary[key]?.trim(), key);
  assert.equal(zhTW['ui.card_edge_add'], '＋ 議題卡片');
  // One click runs addTopicFromEdge (its pending flag keeps a second click from adding another topic).
  const { calls, host } = recorder();
  edge.run({ ...ctxFor('a', 'normal'), host, surface: 'edge' });
  eq(calls.map(([name, node]) => [name, node.id]), [['addTopicFromEdge', 'a']]);
  // The source gates the registry mirrors: cardTextEditable, the structure lock, a managed map, a card with a note.
  const view = read('experiences/visual-map/view.ts');
  assert.match(view, /private paintCardEdgeEntries[\s\S]{0,200}!this\.cardTextEditable\(\) \|\|\s*this\.bookLock\(\)\.structure \|\|\s*!this\.plugin\.settings \|\|\s*!isManagedMapPath\(this\.plugin\.settings, this\.path\)/);
  assert.match(view, /if \(note\) this\.paintCardEdgeEntries\(card, node\);/);
  assert.match(view, /private addTopicFromEdge\(node: MapNode\): void \{\s*if \(this\.edgeAddPending \|\| this\.inlineName\?\.created\) return;\s*this\.whenEditing\(/);
});

test('card actions: Run all Stop (V3.3 A5) only on the AI card Run all is working on, and never in the right-click', () => {
  const ids = (surface, ctx) => actionsFor(surface, ctx).map(entry => entry.action.id);
  const working = { runAllWorking: id => id === 'ai' };
  // Not running in Run all (its own run has its Stop in the header): no toolbar Stop.
  assert.ok(!ids('toolbar', ctxFor('ai', 'normal')).includes('stop-run-all'));
  // An ordinary card never has it, even if asked.
  assert.ok(!ids('toolbar', ctxFor('a', 'normal', { runAllWorking: () => true })).includes('stop-run-all'));
  for (const surface of ['more', 'context', 'command', 'key', 'edge']) assert.ok(!ids(surface, ctxFor('ai', 'normal', working)).includes('stop-run-all'), surface);
  assert.ok(!ruleContextSet('ai-card').includes('stop-run-all') && !ruleMoreSet('ai-card').includes('stop-run-all'));
  assert.equal(titleKeyFor(action('stop-run-all'), 'toolbar', ctxFor('ai', 'normal', working)), 'ui.card_tool_stop');
  const { calls, host } = recorder();
  action('stop-run-all').run({ ...ctxFor('ai', 'normal', working), host, surface: 'toolbar' });
  eq(calls, [['stopRunAll']]);
  // B08: the toolbar draws it from the list; paintPromptState repaints the first button; a Stop and Note skip whenEditing.
  const view = read('experiences/visual-map/view.ts');
  assert.match(view, /const tools = cardToolbars\.get\(card\);\s*if \(tools\) this\.repaintRunTool\(tools, node, toolbarContext\);/);
  assert.match(view, /const plain = stop \|\| action\.id === "open-note";/);
});

test('card actions: B08 the AI card Run turns into its Stop while the AI works on it; Lock says Locked and toggles', () => {
  const running = { aiRunning: id => id === 'ai' };
  assert.equal(titleKeyFor(action('run-stop'), 'toolbar', ctxFor('ai', 'normal')), 'ui.card_tool_run');
  assert.equal(titleKeyFor(action('run-stop'), 'toolbar', ctxFor('ai', 'normal', running)), 'ui.card_tool_stop');
  const { calls, host } = recorder();
  action('run-stop').run({ ...ctxFor('ai', 'normal', running), host, surface: 'toolbar' });
  eq(calls.map(([name, node]) => [name, node.id]), [['stopAi', 'ai']]);
  // Run card and Edit AI card stay in the ⋯ and right-click; the toolbar-only buttons never repeat there.
  for (const id of ['run-stop', 'ai-lock', 'ai-settings']) assert.ok(!ruleContextSet('ai-card').includes(id) && !ruleMoreSet('ai-card').includes(id), id);
  assert.equal(titleKeyFor(action('ai-lock'), 'toolbar', ctxFor('ai', 'normal')), 'ui.card_tool_lock');
  assert.equal(titleKeyFor(action('ai-lock'), 'toolbar', ctxFor('ai', 'aiLocked')), 'ui.card_tool_locked');
  const lock = recorder();
  action('ai-lock').run({ ...ctxFor('ai', 'aiLocked'), host: lock.host, surface: 'toolbar' });
  eq(lock.calls.map(([name, nodes, locked]) => [name, nodes.map(node => node.id), locked]), [['setAiLock', ['ai'], false]]);
  for (const key of ['ui.card_tool_run', 'ui.card_tool_lock', 'ui.card_tool_locked', 'ui.card_tool_ai_settings', 'ui.card_menu_style'])
    for (const dictionary of [en, zhTW, zhCN]) assert.ok(dictionary[key]?.trim(), key);
});

test('card actions: the A7 AI entries, edge "✦ AI card" and empty-canvas "✦ AI root", as the view draws and runs them', () => {
  const ids = (surface, ctx) => actionsFor(surface, ctx).map(entry => entry.action.id);
  // The edge lists + Topic card, then ✦ AI card; neither without a note or off a managed map.
  eq(ids('edge', ctxFor('a', 'normal')), ['edge-add-topic', 'edge-ai-card']);
  eq(ids('edge', ctxFor('a', 'normal', { managedMap: false })), []);
  eq(ids('edge', ctxFor('a', 'normal', { note: () => undefined })), []);
  // The AI root only on the idle empty canvas of a managed map, and nowhere else.
  eq(ids('canvas', ctxFor(null, 'normal', { emptyCanvas: true })), ['ai-root']);
  eq(ids('canvas', ctxFor(null, 'normal')), []);
  eq(ids('canvas', ctxFor(null, 'normal', { emptyCanvas: true, managedMap: false })), []);
  for (const surface of ['toolbar', 'more', 'context', 'command', 'key', 'edge'])
    assert.ok(!ids(surface, ctxFor(null, 'normal', { emptyCanvas: true })).includes('ai-root'), surface);
  for (const surface of ['toolbar', 'more', 'context', 'command', 'key', 'canvas'])
    assert.ok(!ids(surface, ctxFor('a', 'normal')).includes('edge-ai-card'), surface);
  assert.ok(!ruleContextSet('card').includes('edge-ai-card') && !ruleMoreSet('card').includes('edge-ai-card'));
  // Names and aria-labels in all three languages.
  for (const [id, title, aria] of [['edge-ai-card', 'ui.card_edge_ai', 'ui.card_edge_ai_label'], ['ai-root', 'ui.empty_add_ai_root', 'ui.empty_add_ai_root_label']]) {
    const item = action(id);
    assert.equal(item.titleKey, title);
    assert.equal(item.ariaLabelKey, aria);
    for (const dictionary of [en, zhTW, zhCN]) for (const key of [title, aria]) assert.ok(dictionary[key]?.trim(), `${key}`);
  }
  // Both open the AI card setup: under the card, or as a root.
  const run = (id, target, surface, extra) => {
    const { calls, host } = recorder();
    action(id).run({ ...ctxFor(target, 'normal', extra), host, surface });
    return calls.map(([name, node]) => [name, node ? node.id : node]);
  };
  eq(run('edge-ai-card', 'a', 'edge'), [['setupAiCard', 'a']]);
  eq(run('ai-root', null, 'canvas', { emptyCanvas: true }), [['setupAiCard', null]]);
  // The source gates the registry mirrors.
  const view = read('experiences/visual-map/view.ts');
  assert.match(view, /if \(!this\.bookLock\(\)\.ai\)\s*entries\.push\(\{\s*kind: "ai",[\s\S]{0,160}onClick: \(\) => this\.whenEditing\(\(\) => this\.openAiCardPopover\(null, node\)\)/);
  assert.match(view, /if \(this\.cardTextEditable\(\) && !this\.bookLock\(\)\.ai && isManagedMapPath\(this\.plugin\.settings, this\.path\)\) \{\s*const ai = box\.createEl\("button", \{ cls: "vam-empty-add-ai"[\s\S]{0,200}this\.whenEditing\(\(\) => this\.openAiCardPopover\(null, null\)\)/);
});
