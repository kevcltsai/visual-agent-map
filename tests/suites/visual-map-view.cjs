const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { attachTopicRuns, test, integrationTest, root, load, core, node, map, plain, obsidian, DEFAULT_SETTINGS, until } = require('../support.cjs');
const dom = require('../support-dom.cjs');
integrationTest('node plus adds a child without opening a duplicate right-click menu', () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian }, { requestAnimationFrame: run => { run(); return 1; }, cancelAnimationFrame() {} });
  const events = new Map(), buttons = [];
  const element = tag => ({ tag, children: [], dataset: {}, style: {},
    createDiv(options) { const child = element('div'); child.cls = options?.cls ?? options; this.children.push(child); return child; },
    createEl(name, options) { const child = element(name); child.text = options?.text; this.children.push(child); if (name === 'button') buttons.push(child); return child; },
    createSpan(options) { const child = element('span'); child.text = options?.text; this.children.push(child); return child; },
    setAttr(name, value) { this[name] = value; }, addClass(name) { this.cls = name; }, toggleClass(name, on) { this.toggled = [name, on]; }, setPointerCapture() {},
    addEventListener(name, handler) { events.set(`${tag}:${name}`, handler); if (tag === 'button') this.click = handler; }, removeEventListener() {}, querySelector() { return null; }
  });
  const topic = node('parent');
  let detailsShown = false;
  const view = new VisualAgentMapView({ app: {} }, { pendingSuggestions: new Map([['parent.md', [{ title: 'Idea', task: 'Investigate', contribution: '' }]]]), expansionBatches: new Map(), detailsShown: () => detailsShown, setOutlineActive() {} });
  view.stageEl = element('stage'); view.map = map([topic]);
  view.notes = new Map([[topic.id, { title: 'Parent', summary: '', status: 'completed' }]]);
  view.render = () => {};
  let added = 0, opened = [], details = [], next = [], renders = 0;
  view.addNode = () => { throw new Error('the card + asks for a type first'); }; view.openAddMenu = (event, parent) => { added += parent.id === topic.id ? 1 : 0; }; view.enqueue = work => work(); view.openNodePanel = (topic, mode) => opened.push([topic.id, mode]);
  view.openDetails = topic => details.push(topic.id); view.openNextStep = topic => next.push(topic.id); view.render = () => { renders++; };
  view.renderNode(topic);
  const plus = buttons.find(button => button.text === '+');
  assert.equal(plus['aria-label'], 'Add subtopic manually');
  plus.click({ stopPropagation() {} });
  assert.equal(added, 1);
  const badge = buttons.find(button => button.text === 'View 1 expansion suggestions');
  badge.click({ stopPropagation() {} });
  buttons.find(button => button.text === 'AI explore').click({ stopPropagation() {} });
  const listed = []; view.newMenu = () => { const m = { addItem(build) { const it = {}; const chain = { setTitle(t) { it.title = t; return chain; }, setIcon() { return chain; }, onClick(fn) { it.fn = fn; return chain; } }; build(chain); listed.push(it); return m; }, addSeparator() { return m; }, showAtMouseEvent() {} }; return m; };
  buttons.find(button => button['aria-label'] === 'More actions for this topic').click({ stopPropagation() {} });
  listed.find(item => item.title === 'This card').fn();
  assert.deepEqual(opened, [[topic.id, 'proposals'], [topic.id, 'structure']]); assert.deepEqual(next, [topic.id]);
  assert.equal(view.selection.state.selected, null);
  events.get('div:click')({ target: { closest: () => null }, metaKey: false, ctrlKey: false });
  assert.equal(view.selection.state.selected, topic.id); assert.equal(renders, 0, 'a click repaints the card in place instead of rendering'); assert.deepEqual(details, [], 'a click selects without opening the sidebar note');
  view.applySelectionChange(view.selection.setSelected(null)); renders = 0; details.length = 0;
  events.get('div:keydown')({ key: 'Enter', target: view.stageEl.children[0] });
  assert.equal(view.selection.state.selected, topic.id); assert.equal(renders, 0); assert.deepEqual(details, [topic.id]);
  view.applySelectionChange(view.selection.setSelected(null)); renders = 0; details.length = 0;
  view.mapChange = async () => {}; view.drawEdges = () => {};
  events.get('div:pointerdown')({ target: { closest: () => null }, button: 0, pointerId: 2, clientX: 10, clientY: 10 });
  events.get('div:pointermove')({ clientX: 14, clientY: 10 });
  events.get('div:pointerup')({ type: 'pointerup' });
  events.get('div:click')({ target: { closest: () => null }, metaKey: false, ctrlKey: false });
  assert.equal(view.selection.state.selected, null, 'a >3px pointer movement is treated as a drag and its follow-on click is suppressed');
  assert.equal(renders, 0);
  events.get('div:pointerdown')({ target: { closest: () => null }, button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  events.get('div:pointerup')({ type: 'pointerup', clientX: 0, clientY: 0 });
  assert.deepEqual(details, [], 'a pointer tap selects without opening the sidebar note');
  assert.equal(opened.filter(([, mode]) => mode === 'edit').length, 0);
  view.suppressClickUntil = 0; events.get('div:click')({ target: { closest: () => null }, metaKey: false, ctrlKey: false });
  assert.deepEqual(details, []);
  detailsShown = true;
  events.get('div:click')({ target: { closest: () => null }, metaKey: false, ctrlKey: false });
  assert.deepEqual(details, [topic.id], 'an open details sidebar follows the clicked node');
  details.length = 0;
  events.get('div:pointerdown')({ target: { closest: () => null }, button: 0, pointerId: 3, clientX: 0, clientY: 0 });
  events.get('div:pointerup')({ type: 'pointerup', clientX: 0, clientY: 0 });
  assert.deepEqual(details, [topic.id], 'a tap also updates an open details sidebar');
  details.length = 0; detailsShown = false;
  events.get('div:keydown')({ key: 'Enter', target: view.stageEl.children[0] });
  assert.deepEqual(details, [topic.id], 'Enter remains the keyboard path to the sidebar note');
  assert.equal(events.has('div:contextmenu'), false);
});
integrationTest('AIM cards hide generic map actions while ordinary map cards retain them', () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const makeElement = (tag, buttons) => ({ tag, children: [], dataset: {}, style: {},
    createDiv(options) { const child = makeElement('div', buttons); child.cls = options?.cls ?? options; this.children.push(child); return child; },
    createEl(name, options) { const child = makeElement(name, buttons); child.text = options?.text; this.children.push(child); if (name === 'button') buttons.push(child); return child; },
    createSpan(options) { const child = makeElement('span', buttons); child.text = options?.text; this.children.push(child); return child; },
    setAttr(name, value) { this[name] = value; }, addClass(name) { this.cls = name; }, setPointerCapture() {},
    addEventListener() {}, removeEventListener() {}
  });
  const topic = node('topic');
  const render = doc => {
    const buttons = [], view = new VisualAgentMapView({ app: {} }, { pendingSuggestions: new Map([['topic.md', [{ title: 'Idea', task: 'Research', contribution: '' }]]]), expansionBatches: new Map() });
    view.stageEl = makeElement('stage', buttons); view.map = doc; view.notes = new Map([[topic.id, { title: 'Topic', summary: '', status: 'completed' }]]);
    view.renderNode(topic); return buttons;
  };
  const ordinaryButtons = render(map([topic]));
  assert.ok(ordinaryButtons.some(button => button.text === '⋯ More' && button['aria-label'] === 'More actions for this topic'), 'Structure, Rename and the rest live in More');
  assert.equal(ordinaryButtons.some(button => button.text === 'Structure' || button.text === 'Rename'), false, 'they no longer float over the map');
  assert.ok(ordinaryButtons.some(button => button.text === 'AI explore'), 'every card shows a labelled AI explore action');
  assert.ok(ordinaryButtons.some(button => button.text === 'Details' && button['aria-label'] === 'Open details in right sidebar'));
  assert.ok(ordinaryButtons.some(button => button['aria-label'] === 'Add subtopic manually'));
  const aim = map([topic]); aim.aim = { version: 1, branches: [], runs: [], pendingCommits: [] };
  const aimButtons = render(aim);
  for (const label of ['AI explore', 'Structure', 'Rename', '⋯ More']) assert.equal(aimButtons.some(button => button.text === label), false, `${label} is hidden in AIM`);
  assert.equal(aimButtons.some(button => button['aria-label'] === 'Add subtopic manually'), false, 'Add subtopic manually is hidden in AIM');
  assert.ok(aimButtons.some(button => button.text === 'Details'), 'AIM cards keep Details');
  const resultNode = node('saved-synthesis', topic.id); resultNode.aimKind = 'synthesis';
  const resultMap = map([topic, resultNode]);
  resultMap.aim = { version: 1, branches: [{ id: 'saved-branch', questionNodeId: topic.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: '' }, inputSnapshot: { topic: 'Fixture', conditions: {}, upstreamResults: [] }, createdAt: '2026-10-09T00:00:00.000Z', results: [{ nodeId: resultNode.id, notePath: resultNode.path, version: 1, kind: 'synthesis' }] }], runs: [], pendingCommits: [] };
  const resultButtons = [], resultView = new VisualAgentMapView({ app: {} }, { pendingSuggestions: new Map(), expansionBatches: new Map() });
  resultView.stageEl = makeElement('stage', resultButtons); resultView.map = resultMap; resultView.notes = new Map([[resultNode.id, { title: 'Saved synthesis', summary: 'A saved result.', status: 'completed' }]]);
  resultView.renderNode(resultNode);
  const newQuestion = resultButtons.find(button => button['aria-label'] === 'Generate another question from this research, keeping existing branches');
  assert.ok(newQuestion, 'a saved synthesis exposes the new-question action'); assert.equal(newQuestion.disabled, false);
  resultView.aimBusy = true;
  const busyButtons = [], busyView = new VisualAgentMapView({ app: {} }, { pendingSuggestions: new Map(), expansionBatches: new Map() });
  busyView.stageEl = makeElement('stage', busyButtons); busyView.map = resultMap; busyView.notes = resultView.notes; busyView.aimBusy = true;
  busyView.renderNode(resultNode);
  assert.equal(busyButtons.find(button => button['aria-label'] === 'Generate another question from this research, keeping existing branches').disabled, true, 'the action is disabled while another AIM operation is active');
  const ordinaryResult = node('ordinary-synthesis'); ordinaryResult.aimKind = 'synthesis';
  const ordinaryButtonsForResult = [], ordinaryResultView = new VisualAgentMapView({ app: {} }, { pendingSuggestions: new Map(), expansionBatches: new Map() });
  ordinaryResultView.stageEl = makeElement('stage', ordinaryButtonsForResult); ordinaryResultView.map = map([ordinaryResult]); ordinaryResultView.notes = new Map([[ordinaryResult.id, { title: 'Ordinary note', summary: '', status: 'completed' }]]);
  ordinaryResultView.renderNode(ordinaryResult);
  assert.equal(ordinaryButtonsForResult.some(button => button['aria-label'] === 'Generate another question from this research, keeping existing branches'), false, 'ordinary maps do not expose the AIM action');
  assert.match(fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8'), /private renderMapTools\(tools: HTMLElement\): void \{\s*if \(!this\.map \|\| this\.map\.aim\) return;\s*this\.renderSelectTool\(tools\);/);
});
integrationTest('AIM question cards show branch progress instead of note lifecycle status', () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const element = tag => ({ tag, children: [], dataset: {}, style: {},
    createDiv(options) { const child = element('div'); child.cls = options?.cls ?? options; this.children.push(child); return child; },
    createEl(name, options) { const child = element(name); child.text = options?.text; this.children.push(child); return child; },
    createSpan(options) { const child = element('span'); child.text = options?.text; this.children.push(child); return child; },
    setAttr(name, value) { this[name] = value; }, addClass(name) { this.cls = name; },
    addEventListener() {}, removeEventListener() {}, setPointerCapture() {}
  });
  const question = node('question'); question.aimKind = 'question';
  const branch = { id: 'branch', questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: '已回答' }, inputSnapshot: { topic: '測試', conditions: {}, upstreamResults: [] }, createdAt: '2026-10-09T00:00:00.000Z', results: [{ kind: 'conclusion', runId: 'run', attemptId: 'attempt' }] };
  const doc = map([question]); doc.aim = { version: 1, branches: [branch], runs: [{ id: 'run', branchId: branch.id, currentAttemptId: 'attempt', attempts: [{ id: 'attempt', inputSnapshotHash: 'hash', status: 'completed' }] }], pendingCommits: [] };
  const plugin = { repo: {}, settings: { ...DEFAULT_SETTINGS }, expansionBatches: new Map(), running: new Map(), quickExpandPending: new Set(), pendingSuggestions: new Map() };
  const view = new VisualAgentMapView({ app: {} }, plugin); view.stageEl = element('stage'); view.map = doc; view.notes = new Map([[question.id, { title: 'Question', summary: 'Question', status: 'idea' }]]);
  view.renderNode(question);
  assert.equal(view.stageEl.children[0].children[0].children[0].text, 'Research complete');
  doc.aim.runs[0].attempts[0].status = 'running'; view.stageEl = element('stage'); view.renderNode(question);
  assert.equal(view.stageEl.children[0].children[0].children[0].text, 'Researching');
});
integrationTest('a topic waiting in a research batch shows a scheduled frame and status, and has no aria-label tooltip', () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const element = tag => ({ tag, children: [], dataset: {}, style: {},
    createDiv(options) { const child = element('div'); child.cls = options?.cls ?? options; this.children.push(child); return child; },
    createEl(name, options) { const child = element(name); child.text = options?.text; child.cls = options?.cls; this.children.push(child); return child; },
    createSpan(options) { const child = element('span'); child.text = options?.text; child.cls = options?.cls; this.children.push(child); return child; },
    setAttr(name, value) { this[name] = value; }, addClass(name) { this.cls = name; },
    addEventListener() {}, removeEventListener() {}, setPointerCapture() {}
  });
  const all = (root, predicate) => [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))];
  const topic = node('waiting');
  const queued = new Set(['waiting.md']);
  const plugin = { repo: {}, settings: { ...DEFAULT_SETTINGS }, expansionBatches: new Map(), running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, quickExpandPending: new Set(), pendingSuggestions: new Map(), expansionCoordinator: { isQueued: path => queued.has(path) } };
  const view = new VisualAgentMapView({ app: {} }, plugin); view.stageEl = element('stage'); view.map = map([topic]);
  view.notes = new Map([[topic.id, { title: 'Waiting topic', summary: '', status: 'idea' }]]);
  view.renderNode(topic);
  let card = view.stageEl.children[0];
  assert.equal(card.dataset.status, 'queued');
  assert.ok(all(card, item => item.cls === 'vam-status vam-status-queued' && item.text === 'Research scheduled').length === 1);
  assert.equal(card['aria-label'], undefined, 'Obsidian would show aria-label as a hover tooltip');
  const label = all(card, item => item.cls === 'vam-card-label')[0];
  assert.equal(card['aria-labelledby'], label.id); assert.equal(label.textContent, 'Waiting topic, Research scheduled');
  queued.clear(); view.stageEl = element('stage'); view.renderNode(topic);
  card = view.stageEl.children[0];
  assert.equal(card.dataset.status, 'idea'); assert.equal(all(card, item => item.cls === 'vam-status vam-status-queued').length, 0);
});
integrationTest('outline reveal expands collapsed ancestors, centers and selects the topic, and reports unknown paths', async () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const root = node('root'), child = node('child'), leaf = node('leaf');
  child.parentId = root.id; leaf.parentId = child.id; root.collapsed = true; child.collapsed = true;
  const doc = map([root, child, leaf]); doc.viewport = { x: 0, y: 0, zoom: 1 }; leaf.x = 1000; leaf.y = 400;
  const view = new VisualAgentMapView({ app: {} }, { mutate: work => work(), expansionBatches: new Map() });
  view.map = doc; view.viewportEl = { clientWidth: 800, clientHeight: 600 };
  let renders = 0; view.render = () => { renders++; }; view.transform = () => {}; view.saveViewport = () => {};
  view.mapChange = async change => { change(view.map); };
  view.selection.replaceMulti(['root']);
  assert.equal(await view.revealPath('leaf.md'), true);
  assert.equal(root.collapsed, false); assert.equal(child.collapsed, false);
  assert.equal(view.selection.state.selected, leaf.id); assert.equal(view.selection.state.multiSelected.size, 0); assert.ok(renders > 0);
  assert.deepEqual(plain(doc.viewport), { x: 400 - 1140, y: 300 - 480, zoom: 1 });
  view.selection.toggleMultiSelect(); view.selection.replaceMulti(['root']); view.selection.setSelected(null);
  await view.revealPath('root.md');
  assert.deepEqual([...view.selection.state.multiSelected], ['root'], 'topic selection is kept'); assert.equal(view.selection.state.selected, null);
  assert.equal(await view.revealPath('missing.md'), false);
});
integrationTest('AIM outline keeps only note titles and hierarchy', () => {
  const { OutlineView } = load('ui/outline-view.ts', { obsidian });
  const element = (tag, options = {}) => ({ tag, text: options.text, cls: options.cls ?? '', children: [], style: {},
    get childElementCount() { return this.children.length; },
    createDiv(value) { const child = element('div', { cls: typeof value === 'string' ? value : value?.cls }); this.children.push(child); return child; },
    createEl(name, value = {}) { const child = element(name, value); this.children.push(child); return child; },
    createSpan(value = {}) { const child = element('span', typeof value === 'string' ? { cls: value } : value); this.children.push(child); return child; },
    addClass(value) { this.cls = value; }, setAttr(name, value) { this[name] = value; }, addEventListener() {}, remove() { this.removed = true; },
    empty() { this.children = []; }, querySelector(selector) { const cls = selector.slice(1); const visit = item => item.cls.split(' ').includes(cls) ? item : item.children.map(visit).find(Boolean); return visit(this); }
  });
  const root = node('root'), child = node('child', root.id); root.aimKind = 'topic'; child.aimKind = 'research';
  const doc = map([root, child]); doc.aim = { version: 1, branches: [{ id: 'branch', questionNodeId: root.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: '私有答案資料' }, inputSnapshot: { topic: 'map', conditions: {}, upstreamResults: [] }, createdAt: '2026-10-09T00:00:00.000Z', results: [{ resultId: 'result', runId: 'run', attemptId: 'attempt', nodeId: child.id, notePath: child.path, version: 1 }] }], runs: [], pendingCommits: [] };
  const view = new OutlineView({ app: {} }, async () => {}); view.contentEl = element('content');
  view.setMap(doc, new Map([[root.id, 'AIM topic'], [child.id, 'Research subtopic']]));
  const tree = view.contentEl.querySelector('.vam-outline-tree');
  const flatten = item => [item, ...item.children.flatMap(flatten)]; const rendered = flatten(tree);
  assert.ok(rendered.some(item => item.text === 'AIM topic'));
  assert.ok(rendered.some(item => item.text === 'Research subtopic'));
  assert.ok(!rendered.some(item => item.cls.includes('vam-outline-kind') || item.cls.includes('vam-outline-branch-meta')));
  assert.ok(!rendered.some(item => item.text === '私有答案資料'));
  assert.deepEqual(rendered.filter(item => item.cls === 'vam-outline-row').map(item => item.style.paddingLeft), ['8px', '24px']);
});
// T6 P2: the dialogs list styles from the store's listRecipes(); a user's style file for these tests.
const alphaStyle = { ref: 'file:Alpha style', kind: 'file', name: 'Alpha style', fileName: 'Alpha style.md', structure: { name: 'Standard' }, voice: { name: 'Academic rigor' }, format: { name: 'Standard' }, update: 'merge', issues: [] };
integrationTest('Next Step reviews first expansion proposals in place and keeps existing proposal review', async () => {
  let closed = 0, expandCalls = 0, synthCalls = 0, created, saved, quickOptions, expandOptions, researchOptions, synthOptions; const notices = [];
  const { element, find, findAll: all, button } = dom;
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  class Modal { constructor() { this.modalEl = element('modal'); this.titleEl = element('title'); this.contentEl = element('content'); this.modalEl.children.push(this.contentEl); } close() { closed++; this.onClose?.(); } }
  class Component { load() {} unload() {} addChild(child) { return child; } removeChild() {} }
  const MarkdownRenderer = { render: async (_app, markdown, el) => { el.rendered = markdown; } };
  const { NextStepModal } = load('main.ts', { obsidian: { ...obsidian, Modal, Component, MarkdownRenderer, setIcon: () => {}, Notice: class { constructor(message) { notices.push(message); } } } });
  const checkedModels = [];
  const modelState = provider => ({ provider, status: 'ready', models: provider === 'codex' ? ['gpt-test'] : [] });
  const plugin = { noteStyles: { refresh: async () => {}, listRecipes: () => [alphaStyle], listBlocks: category => (category === 'template' ? [{ ref: 'file:Alpha template', kind: 'file', name: 'Alpha template', fileName: 'Alpha template.md', modified: false, issues: [] }] : []), ensureBlockFile: async () => ({ path: 'x', base: 'Alpha template' }) }, settings: { codexUsageNoticeSeen: true, claudeUsageNoticeSeen: true, models: 'gpt-test', cliReasoning: 'low', language: 'en' }, aiReadyForModel: async model => { checkedModels.push(model); return true; }, confirmAiUsage: async (model, run) => { checkedModels.push(model); await run(); return true; }, saveSettings: async () => {}, activeTasks: new Map(), availableModels: () => ['gpt-test'], modelLabel: model => model, modelDiscoveryState: modelState, subscribeModelDiscovery: () => () => {}, refreshModelDiscovery: async provider => modelState(provider), sources: { mapSources: async () => [], synthesisTopics: ['Child A', 'Child B'] } };
  const modelSettings = { model: 'gpt-test', modelSource: 'workspace', reasoning: 'low', save: async () => {}, sources: plugin.sources };
  const modal = new NextStepModal({}, 'Parent', 1, 1, plugin,
    async (options, _focus, _done, _failed, accepted) => { researchOptions = options; accepted(); },
    async (options, _direction, found) => { expandOptions = options; expandCalls++; found([{ title: 'Transport', task: 'Compare', contribution: '', parentTitle: '' }], async items => { created = items; }); },
    async (options, direction) => { synthCalls++; synthOptions = options; assert.equal(direction, null); }, modelSettings);
  modal.onOpen();
  assert.ok(find(modal.contentEl, item => /3 minutes.*avoid prolonged resource use/.test(item.text ?? '')));
  assert.ok(modal.modalEl.cls.includes('vam-next-modal'));
  const requirementsDisclosure = find(modal.contentEl, item => item.cls.includes('vam-next-requirements'));
  assert.equal(requirementsDisclosure.open, false);
  const cards = find(modal.contentEl, item => item.cls === 'vam-next-cards');
  assert.deepEqual(cards.children.map(item => item['aria-checked']), ['true', 'false', 'false']);
  const [research, expand, synthesize] = all(modal.contentEl, item => item.cls.includes('vam-next-research'));
  // The step's primary action lives in the action bar below the content; the cards follow the topic line.
  const actions = find(modal.modalEl, item => item.cls.includes('vam-next-actions'));
  const researchAction = button(actions, 'Confirm research task');
  assert.equal(modal.contentEl.children.indexOf(cards), 1);
  const activeCard = () => cards.children.findIndex(item => item['aria-checked'] === 'true');
  assert.equal(activeCard(), 0);
  // The steps form one radio group: the chosen step holds focus and the only tab stop; arrows move the choice.
  assert.equal(cards.role, 'radiogroup');
  assert.deepEqual(cards.children.map(item => [item.role, item.tabIndex]), [['radio', 0], ['radio', -1], ['radio', -1]]);
  assert.equal(cards.children[0].focused, true);
  cards.children[0].keydown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(activeCard(), 1); assert.equal(cards.children[1].focused, true);
  cards.children[1].keydown({ key: 'ArrowLeft', preventDefault() {} });
  assert.equal(activeCard(), 0);
  assert.equal(researchAction.dataset.topicRun, 'Confirm research task');
  assert.equal(researchAction.disabled, false);
  assert.equal(button(research, 'Confirm research task'), undefined);
  assert.equal(find(modal.contentEl, item => /Summary = card conclusion/.test(item.text ?? '')), undefined);
  assert.equal(find(modal.contentEl, item => /Run with .*sources:.*result:/.test(item.text ?? '')), undefined);
  assert.equal(find(modal.contentEl, item => /Full results go to Markdown/.test(item.text ?? '')), undefined);
  assert.ok(find(research, item => item.cls.includes('vam-next-status')));
  // Every option sits under one Adjust disclosure; the research panel keeps only its description and status.
  const adjust = find(modal.contentEl, item => item.tag === 'details' && item.cls.includes('vam-next-adjust'));
  assert.equal(adjust.open, false); assert.equal(adjust.children[0].text, 'Adjust');
  assert.equal(find(research, item => item.tag === 'fieldset'), undefined);
  const [researchAdjust, expandAdjust, synthAdjust] = all(adjust, item => item.cls === 'vam-next-adjust-section');
  assert.equal(all(modal.contentEl, item => item.tag === 'fieldset').length, 0, 'the research-depth fieldset is gone; the AI mode switch replaces it');
  const summaryLine = find(modal.contentEl, item => item.cls === 'vam-next-summary');
  assert.equal(summaryLine.text, 'Quick mode · Same language as my text');
  assert.equal(all(modal.contentEl, item => /vam-next-source-(?:details)|vam-reference-/.test(item.cls ?? '')).length, 0, 'the task dialog has no data-source section (the map owns its sources)');
  assert.equal(find(modal.contentEl, item => /Data sources/.test(item.text ?? '')), undefined);
  const outputLanguage = find(modal.contentEl, item => item['aria-label'] === 'Answer language for this task');
  assert.equal(outputLanguage.value, 'same-as-input');
  outputLanguage.value = 'zh-TW';
  assert.equal(plugin.settings.language, 'en'); assert.equal(activeCard(), 0);
  const requirements = find(modal.contentEl, item => item.tag === 'textarea');
  assert.equal(requirements.value, '');
  assert.equal(all(modal.contentEl, item => item.tag === 'textarea').length, 1);
  assert.equal(button(modal.contentEl, 'Save instructions'), undefined);
  requirements.value = 'Only this run';
  assert.ok(find(modal.contentEl, item => /Use Standard once the structure is settled, or when the topic is new or obscure/.test(item.text ?? '')), 'one line says when to use Standard');
  // The expansion's subtopic research is one option; its hint follows the AI mode and never claims the web for Quick.
  const expandChecks = all(expandAdjust, item => item.tag === 'input' && item.type === 'checkbox');
  assert.equal(expandChecks.length, 1, 'expand keeps only its subtopic-research option');
  assert.equal(expandChecks[0].checked, false);
  assert.ok(find(expandAdjust, item => item.text === 'Run short research on each created subtopic'));
  assert.equal(find(expandAdjust, item => item.text === 'Also search the web for subtopic research'), undefined);
  const shallowHint = () => find(expandAdjust, item => /^Subtopic research: /.test(item.text ?? ''));
  assert.match(shallowHint().text, /without the web/); assert.doesNotMatch(shallowHint().text, /searches the web/);
  button(find(modal.contentEl, item => item['aria-label'] === 'AI mode'), 'Standard').click();
  assert.match(shallowHint().text, /searches the web/); assert.doesNotMatch(shallowHint().text, /without the web/);
  button(find(modal.contentEl, item => item['aria-label'] === 'AI mode'), 'Quick').click();
  assert.match(shallowHint().text, /without the web/);
  assert.equal(load('i18n.ts').translate('zh-TW', 'ui.shallow_research_for_expanded_subtopics_0', load('i18n.ts').translate('zh-TW', 'ui.ai_mode_quick_desc')).includes('快速'), false, 'the zh hint does not repeat the mode name');
  assert.ok(find(synthesize, item => /run a Standard research on the topic first/.test(item.text ?? '')));
  assert.equal(find(synthesize, item => item.text === 'Does not copy full subtopic notes'), undefined);
  cards.children[1].click();
  assert.equal(activeCard(), 1); assert.equal(researchAction.hidden, true);
  assert.equal(research.style.display, 'none'); assert.equal(expand.style.display, '');
  button(modal.modalEl, 'Review AI subtopic suggestions (1)').click(); await tick();
  assert.equal(expandCalls, 1); assert.equal(closed, 0);
  const proposalCheck = find(expand.querySelector('.vam-next-result'), item => item.tag === 'input' && item.type === 'checkbox');
  proposalCheck.checked = false; button(expand, 'Create subtopics (1)').click(); await tick();
  assert.equal(created, undefined); assert.equal(expand.querySelector('.vam-next-status').text, 'Select at least one subtopic.');
  proposalCheck.checked = true;
  button(expand, 'Create subtopics (1)').click(); await tick();
  assert.equal(created[0].title, 'Transport'); assert.equal(expandOptions.outputLanguage, 'zh-TW');
  assert.equal(closed, 1, 'guided expansion closes after the subtopics are created'); closed = 0; // later absolute close counts stay as before
  // The guided first expansion ("Get expansion directions") is gone: Expand writes an outline, and only proposals that already
  // wait are reviewed here, through the secondary button. The background hook is still handed to the dialog.
  const spy = { begins: 0, ends: 0, completed: [], controllers: [] };
  const background = { begin: controller => { spy.begins++; spy.controllers.push(controller); }, end: () => { spy.ends++; }, completed: kind => spy.completed.push(kind) };
  const noPending = new NextStepModal({}, 'Parent', 0, 0, plugin, async () => {}, async () => assert.fail('no AI call for an empty review'), async () => {}, { ...modelSettings, background });
  noPending.onOpen();
  assert.equal(button(noPending.modalEl, 'Get expansion directions'), undefined, 'no guided first expansion');
  assert.equal(button(noPending.modalEl, 'Review AI subtopic suggestions (0)').hidden, true, 'nothing waits, so the review button is hidden');
  // Proposals already waiting are reviewed in place: no AI starts, so the dialog stays open until they are created.
  let firstCreated;
  const reviewFlow = new NextStepModal({}, 'Parent', 0, 1, plugin, async () => {}, async (_options, _direction, found) => {
    found([{ title: 'First idea', task: 'Explore it', contribution: '', parentTitle: '' }], async items => { firstCreated = items; });
  }, async () => {}, { ...modelSettings, background });
  reviewFlow.onOpen(); find(reviewFlow.contentEl, item => item.cls === 'vam-next-cards').children[1].click();
  const reviewPanel = all(reviewFlow.contentEl, item => item.cls.includes('vam-next-research'))[1];
  button(reviewFlow.modalEl, 'Review AI subtopic suggestions (1)').click(); await tick();
  assert.equal(closed, 0, 'reviewing waiting proposals starts no AI and keeps the dialog open'); assert.equal(spy.begins, 0, 'no hand-over: no AI started');
  assert.ok(find(reviewPanel.querySelector('.vam-next-result'), item => item.text === 'AI subtopic proposals'));
  const firstCheckbox = find(reviewPanel.querySelector('.vam-next-result'), item => item.tag === 'input' && item.type === 'checkbox');
  firstCheckbox.checked = false;
  button(reviewPanel, 'Create subtopics (1)').click(); await tick();
  assert.equal(firstCreated, undefined); assert.equal(reviewPanel.querySelector('.vam-next-status').text, 'Select at least one subtopic.');
  firstCheckbox.checked = true;
  const firstName = find(reviewPanel.querySelector('.vam-next-result'), item => item.tag === 'input' && item.type === 'text'); firstName.value = 'Edited idea';
  button(reviewPanel, 'Create subtopics (1)').click(); await tick();
  assert.equal(firstCreated[0].title, 'Edited idea'); assert.equal(closed, 1); closed = 0;
  const contentChoice = find(synthAdjust, item => item.tag === 'select' && item['aria-label'] === 'Topic synthesis content');
  assert.equal(contentChoice.value, 'full');
  assert.ok(find(synthAdjust, item => item.tag === 'li' && item.text === 'Child A'));
  assert.ok(find(synthAdjust, item => item.tag === 'li' && item.text === 'Child B'));
  contentChoice.value = 'summary'; contentChoice.change();
  assert.ok(find(synthAdjust, item => /Important conditions in the body may be omitted/.test(item.text ?? '')));
  assert.equal(find(modal.contentEl, item => item.cls === 'vam-next-summary').text, '2 levels · up to 15 · 繁體中文', 'expand summary names the chosen levels and size');
  cards.children[2].click(); assert.equal(activeCard(), 2); assert.equal(researchAction.hidden, true);
  assert.equal(find(modal.contentEl, item => item.cls === 'vam-next-summary').text, 'Summary only · 繁體中文', 'the summary line follows the synthesis content choice');
  // Starting synthesis closes its window at once, so it runs on its own modal and this one stays open for research.
  const synthModal = new NextStepModal({}, 'Parent', 1, 1, plugin, async () => {}, async () => {}, modal.synthesize, modelSettings);
  synthModal.onOpen(); find(synthModal.contentEl, item => item.cls === 'vam-next-cards').children[2].click();
  find(synthModal.contentEl, item => item['aria-label'] === 'Answer language for this task').value = 'zh-TW';
  const synthPanel = all(synthModal.contentEl, item => item.cls.includes('vam-next-research'))[2];
  const synthContentChoice = find(synthModal.contentEl, item => item.tag === 'select' && item['aria-label'] === 'Topic synthesis content');
  synthContentChoice.value = 'summary'; synthContentChoice.change();
  const closedBeforeSynthStart = closed;
  button(synthModal.modalEl, 'Get synthesis suggestions first').click(); await tick();
  assert.equal(synthContentChoice.disabled, true);
  assert.equal(synthOptions.synthesisContent, 'summary');
  // Owner decision 2026-10-19: synthesis hides its dialog once AI starts; the double gives no outcome, so nothing is written into the closed dialog.
  assert.equal(synthCalls, 1); assert.equal(closed, closedBeforeSynthStart + 1); assert.equal(synthModal.closed, true);
  assert.equal(find(synthModal.contentEl, item => item.cls.includes('vam-next-status') && /cancelled/i.test(item.text ?? '')), undefined);
  assert.equal(synthOptions.researchMode, 'local');
  // The AI mode choice is kept across steps; a synthesis hides the switch and never sends a mode.
  const defaultsModal = new NextStepModal({}, 'Parent', 1, 1, plugin, async () => {}, async () => {}, async () => {}, modelSettings);
  defaultsModal.onOpen();
  const defaultCards = find(defaultsModal.contentEl, item => item.cls === 'vam-next-cards');
  const modeSwitch = find(defaultsModal.contentEl, item => item['aria-label'] === 'AI mode');
  button(modeSwitch, 'Standard').click();
  defaultCards.children[2].click(); assert.equal(modeSwitch.parent.hidden, true);
  defaultCards.children[1].click(); assert.equal(modeSwitch.parent.hidden, false); assert.equal(button(modeSwitch, 'Standard')['aria-checked'], 'true');
  assert.equal(synthOptions.outputLanguage, 'zh-TW');
  assert.equal(button(synthPanel, 'Choose this direction'), undefined);
  closed = closedBeforeSynthStart;
  cards.children[0].click(); assert.equal(activeCard(), 0); assert.equal(researchAction.hidden, false);
  // The first modal closed itself after creating subtopics, so a research run needs a fresh dialog: one confirm click starts it.
  const researchModal = new NextStepModal({}, 'Parent', 1, 0, plugin,
    async (options, _focus, _done, _failed, accepted) => { researchOptions = options; accepted(); }, async () => {}, async () => {}, modelSettings);
  researchModal.onOpen();
  find(researchModal.contentEl, item => item.tag === 'textarea').value = 'Only this run';
  find(researchModal.contentEl, item => item['aria-label'] === 'Answer language for this task').value = 'zh-TW';
  button(researchModal.modalEl, 'Confirm research task').click(); await tick();
  assert.equal(researchOptions.requirements, 'Only this run'); assert.equal(researchOptions.researchMode, 'local', 'Quick is the default mode'); assert.equal(researchOptions.mapAiMode, 'quick'); assert.equal(researchOptions.referenceGroups.length, 0);
  assert.equal(researchOptions.outputLanguage, 'zh-TW'); assert.equal(researchOptions.researchDepth, 'normal');
  assert.equal(closed, 1, 'research is two clicks in all: open, then confirm'); assert.equal(researchModal.closed, true);
  // The suggested step follows the topic's research state.
  const suggested = (childrenCount, topicStatus, childrenCompleted) => {
    const suggestModal = new NextStepModal({}, 'Parent', childrenCount, 0, plugin, async () => {}, async () => {}, async () => {}, { ...modelSettings, topicStatus, childrenCompleted });
    suggestModal.onOpen();
    return find(suggestModal.contentEl, item => item.cls === 'vam-next-cards').children.findIndex(item => item['aria-checked'] === 'true');
  };
  assert.equal(suggested(0, 'idea', 0), 0, 'a topic to research suggests researching it');
  assert.equal(suggested(0, 'completed', 0), 1, 'a researched topic without subtopics suggests expanding');
  assert.equal(suggested(2, 'completed', 2), 2, 'a researched topic whose subtopics are all researched suggests synthesis');
  assert.equal(suggested(2, 'completed', 1), 0, 'unfinished subtopics keep research as the suggestion');
  // C2: quick explore generates an outline from a preset (no level or count fields) and reviews it before creating.
  const outlineOf = markdown => plain(load('experiences/visual-map/outline-import.ts', { obsidian }).parseOutline(markdown).nodes);
  let quickRequest, quickCreated;
  const quickOutline = (create = async (nodes, options) => { quickCreated = nodes; quickOptions = options; }) => ({
    presets: [{ id: 'knowledge-tree', name: 'Knowledge tree generator' }],
    generate: async request => { quickRequest = request; return outlineOf('# Parent\n## Food\n### Breakfast'); },
    create
  });
  // Owner decision 2026-10-19: pressing Generate hides the dialog; the finished outline waits in the view and the
  // dialog reopens straight at its review (with the generated nodes and the dialog's options).
  let readyOutline; const outlineHooks = { begins: 0, ends: 0 };
  const quickBackground = { begin: () => { outlineHooks.begins++; }, end: () => { outlineHooks.ends++; }, outlineReady: outline => { readyOutline = outline; } };
  const quickModal = new NextStepModal({}, 'Parent', 1, 0, plugin, async () => {}, modal.expand, async () => {}, { ...modelSettings, sources: undefined, quickOutline: quickOutline(), background: quickBackground });
  quickModal.onOpen(); find(quickModal.contentEl, item => item.cls === 'vam-next-cards').children[1].click();
  find(quickModal.contentEl, item => item['aria-label'] === 'Answer language for this task').value = 'zh-TW';
  find(quickModal.contentEl, item => item.tag === 'textarea').value = 'Keep it short';
  assert.equal(button(quickModal.modalEl, 'Review AI subtopic suggestions (0)').hidden, true);
  assert.equal(all(quickModal.contentEl, item => item.tag === 'input' && item.type === 'number').length, 2, 'levels and size fields');
  assert.ok(find(quickModal.contentEl, item => item['aria-label'] === 'Outline preset'));
  const expandCallsBeforeQuick = expandCalls;
  const closedBeforeQuick = closed;
  button(quickModal.modalEl, 'Expand').click(); await tick(); await tick();
  assert.equal(quickRequest.language, 'zh-TW'); assert.equal(quickRequest.requirements, 'Keep it short'); assert.equal(quickRequest.presetId, 'knowledge-tree');
  assert.equal(expandCalls, expandCallsBeforeQuick, 'the old multi-layer expansion is not called'); assert.equal(quickCreated, undefined);
  assert.equal(closed, closedBeforeQuick + 1, 'the dialog hid itself once the outline started');
  assert.deepEqual(outlineHooks, { begins: 1, ends: 1 }, 'the card shows the run until it finishes');
  assert.ok(readyOutline, 'the finished outline is handed to the view'); assert.equal(readyOutline.nodes.length, 3);
  assert.equal(find(quickModal.contentEl, item => /^Create subtopics/.test(item.text ?? '')), undefined, 'nothing is written into the hidden dialog');
  let outlineDiscarded = 0;
  const reopenedQuick = new NextStepModal({}, 'Parent', 1, 0, plugin, async () => {}, modal.expand, async () => {}, { ...modelSettings, sources: undefined, quickOutline: quickOutline(), pendingOutline: { ...readyOutline, discard: () => { outlineDiscarded++; } } });
  reopenedQuick.onOpen();
  assert.deepEqual(all(reopenedQuick.contentEl, item => item.cls?.includes('vam-proposal-title')).map(item => item.value), ['Food', 'Breakfast'], 'reopening goes straight to the review');
  button(reopenedQuick.contentEl, 'Create subtopics (2)').click(); await tick(); await tick();
  assert.deepEqual(plain(quickCreated.map(node => [node.title, node.parent])), [['Food', null], ['Breakfast', 0]]);
  assert.equal(quickOptions.researchDepth, 'fast'); assert.equal(quickOptions.shallowResearch, false); assert.equal(closed, closedBeforeQuick + 2); assert.equal(outlineDiscarded, 1, 'creating consumes the waiting outline');
  assert.equal(quickOptions.researchMode, 'local'); assert.equal(quickOptions.referenceGroups.length, 0); assert.equal(quickOptions.outputLanguage, 'zh-TW');
  // A failure while creating keeps the dialog open with the reason, and the review can be confirmed again.
  // The same hidden-then-reopened path for the create step: generate in one dialog, review and create in the next.
  const generateThenReopen = async (create, prepare = () => {}) => {
    let ready; const first = new NextStepModal({}, 'Parent', 1, 0, plugin, async () => {}, async () => {}, async () => {}, { ...modelSettings, quickOutline: quickOutline(create), background: { begin() {}, end() {}, outlineReady: outline => { ready = outline; } } });
    first.onOpen(); find(first.contentEl, item => item.cls === 'vam-next-cards').children[1].click();
    prepare(first);
    button(first.modalEl, 'Expand').click(); await tick(); await tick();
    const reopened = new NextStepModal({}, 'Parent', 1, 0, plugin, async () => {}, async () => {}, async () => {}, { ...modelSettings, quickOutline: quickOutline(create), pendingOutline: { ...ready, discard() {} } });
    reopened.onOpen();
    return reopened;
  };
  const partial = await generateThenReopen(async () => { throw new Error('部分子議題已建立，請重新開啟視窗。'); });
  const closedBeforePartial = closed;
  button(partial.contentEl, 'Create subtopics (2)').click(); await tick(); await tick();
  assert.equal(closed, closedBeforePartial); assert.equal(button(partial.contentEl, 'Create subtopics (2)').disabled, false); assert.match(all(partial.contentEl, item => item.cls.includes('vam-next-research'))[1].querySelector('.vam-next-status').text, /部分子議題已建立/);
  // With shallow research the dialog closes once the topics exist and the research continues in the background.
  const startedNotices = () => notices.filter(message => message === 'Started “Parent” in the background; progress shows on its card.').length;
  const startedBefore = startedNotices();
  let createSignal;
  const acceptedModal = await generateThenReopen(async (_nodes, options) => { createSignal = options.signal; quickOptions = options; }, first => {
    const shallowBox = find(first.contentEl, item => item.tag === 'input' && item.type === 'checkbox' && item.parent?.cls?.includes('vam-next-toggle'));
    shallowBox.checked = true; shallowBox.change();
  });
  button(acceptedModal.contentEl, 'Create subtopics (2)').click();
  await until(() => acceptedModal.closed);
  assert.equal(quickOptions.shallowResearch, true); assert.equal(createSignal.aborted, false); assert.equal(acceptedModal.taskSignal, undefined);
  assert.equal(startedNotices(), startedBefore + 1);
  // Synthesis runs on its own controller once the provider accepted it: closing the dialog midway never aborts the AI,
  // and a result that arrives afterwards is never written into the closed dialog.
  let directionSignal, directionCalls = [], lateDirections = 0; const handOver = { begins: [], ends: 0 };
  let continueBackground2; const background2 = new Promise(resolve => { continueBackground2 = resolve; });
  const directionsModal = new NextStepModal({}, 'Parent', 1, 0, plugin, async () => {}, async () => {}, async (options, direction, _failed, accepted, observer) => {
    directionSignal = options.signal; directionCalls.push(direction); accepted(); observer.accepted(() => { cancelRun = true; });
    await background2;
    if (observer.isOpen()) observer.directions([{ title: 'Late', task: 'Late', contribution: '' }]); else lateDirections++;
  }, { ...modelSettings, background: { begin: controller => handOver.begins.push(controller), end: () => { handOver.ends++; } } });
  const closedBeforeSynth = closed;
  directionsModal.onOpen(); find(directionsModal.contentEl, item => item.cls === 'vam-next-cards').children[2].click();
  button(directionsModal.modalEl, 'Get synthesis suggestions first').click();
  await until(() => directionCalls.length === 1); await tick();
  // Owner decision 2026-10-19: pressing hides the dialog at once; Stop moves to the card, so the dialog's own Cancel is gone.
  assert.equal(closed, closedBeforeSynth + 1, 'starting a synthesis step hides the dialog'); assert.deepEqual(directionCalls, [null]);
  assert.equal(directionsModal.taskSignal, undefined, 'the accepted run no longer hangs on the dialog controller');
  assert.equal(handOver.begins.length, 1, 'the view got the dialog controller when the dialog hid'); assert.equal(handOver.ends, 1, 'accepted hands the card over to the view');
  assert.equal(directionSignal.aborted, false);
  directionsModal.close();
  assert.equal(directionSignal.aborted, false, 'closing the hidden dialog again never aborts the AI');
  closed = closedBeforeSynth;
  continueBackground2(); await tick();
  assert.equal(lateDirections, 1, 'a late result sees the closed dialog and takes the badge path');
  assert.equal(find(directionsModal.contentEl, item => item.cls === 'vam-next-angle'), undefined, 'nothing is written into the closed dialog');
  // Reopening from the node badge shows the pending directions; choosing one drafts and reviews it in the same dialog.
  let discarded = 0, draftSignal, confirmed; const draftCalls = []; let draftStageOptions;
  const pendingModal2 = new NextStepModal({}, 'Parent', 1, 0, plugin, async () => {}, async () => {}, async (options, direction, _failed, accepted, observer) => { draftSignal = options.signal; draftStageOptions = options; draftCalls.push(direction); accepted();
      if (observer.isOpen()) observer.drafted({ result: { summary: 'Draft S', detail: 'Draft D', suggestions: [], visualReferences: [] }, confirm: async (summary, detail) => { confirmed = [summary, detail]; }, discard: () => { discarded++; } }); },
    { ...modelSettings, currentSummary: 'Old summary', synthesisPending: { directions: [{ title: 'Shared constraints', task: 'Find tradeoffs', contribution: 'Across children' }, { title: 'Open questions', task: 'List gaps', contribution: '' }], discard: () => { discarded++; } } });
  pendingModal2.onOpen();
  const pendingPanel = all(pendingModal2.contentEl, item => item.cls.includes('vam-next-research'))[2];
  assert.equal(button(pendingModal2.modalEl, 'Get synthesis suggestions first').hidden, true);
  assert.equal(pendingPanel.style.display, '');
  const directionBox = find(pendingPanel, item => item.tag === 'textarea' && item['aria-label'] === 'Synthesis direction');
  assert.equal(directionBox.value ?? directionBox.text, 'Find tradeoffs');
  button(pendingPanel, 'Choose this direction').click();
  directionBox.value = 'Edited direction';
  button(pendingModal2.modalEl, 'Start synthesis').click(); await tick(); await tick();
  assert.deepEqual(draftCalls, ['Edited direction']); assert.equal(draftStageOptions.continuesDirections, true); assert.equal(discarded, 0);
  // Owner decision 2026-10-19: the draft step hides the dialog too; the finished draft is reviewed from the card badge or the Notice (view tests), never rendered here.
  assert.equal(pendingModal2.closed, true, 'pressing the draft button hides the dialog');
  assert.equal(button(pendingModal2.modalEl, 'Confirm update to parent topic'), undefined, 'the review is not opened inside the hidden dialog');
  assert.equal(confirmed, undefined); assert.equal(draftSignal.aborted, false);
  const discardModal = new NextStepModal({}, 'Parent', 1, 0, plugin, async () => {}, async () => {}, async () => {}, { ...modelSettings, synthesisPending: { directions: [{ title: 'A', task: 'B', contribution: '' }], discard: () => { discarded++; } } });
  discardModal.onOpen(); button(discardModal.contentEl, 'Discard').click();
  assert.equal(discarded, 1); assert.equal(discardModal.closed, true);
  closed = closedBeforeSynth; // keep later absolute close counts independent of the background-synthesis modals above
  let emptyOptions;
  const empty = new NextStepModal({}, 'No children', 0, 0, plugin, async () => {}, async () => {}, async options => { synthCalls++; emptyOptions = options; });
  empty.onOpen(); find(empty.contentEl, item => item.cls === 'vam-next-cards').children[2].click();
  const emptyPanel = all(empty.contentEl, item => item.cls.includes('vam-next-research'))[2];
  assert.match(emptyPanel.children[0].text, /no direct subtopics/i);
  button(empty.modalEl, 'Get synthesis suggestions first').click(); await tick();
  assert.equal(synthCalls, 1); assert.equal(emptyOptions, undefined);
  const closedBeforeFailing = closed;
  const failing = new NextStepModal({}, 'Parent', 1, 1, plugin, async () => {}, async (_options, _direction, _found, failed) => failed('Provider failed'), async () => {});
  failing.onOpen(); find(failing.contentEl, item => item.cls === 'vam-next-cards').children[1].click();
  button(failing.modalEl, 'Review AI subtopic suggestions (1)').click(); await tick();
  assert.equal(all(failing.contentEl, item => item.cls.includes('vam-next-research'))[1].querySelector('.vam-next-status').text, 'Provider failed'); assert.equal(closed, closedBeforeFailing); closed = 3; // the absolute counts below start again from the original 3
  const startedBeforeFailures = startedNotices();
  const failedResearch = new NextStepModal({}, 'Parent', 1, 0, plugin, async (_options, _focus, _done, failed) => failed('Cannot start'), async () => {}, async () => {});
  failedResearch.onOpen(); button(failedResearch.modalEl, 'Confirm research task').click(); await tick();
  // Owner decision 2026-10-19: the dialog hid when AI started, so the launch failure is a Notice, not dialog text.
  assert.equal(closed, 4); closed = 3; assert.ok(notices.includes('Cannot start'));
  assert.notEqual(all(failedResearch.contentEl, item => item.cls.includes('vam-next-research'))[0].querySelector('.vam-next-status').text, 'Cannot start');
  const unacceptedResearch = new NextStepModal({}, 'Parent', 1, 0, plugin, async () => {}, async () => {}, async () => {});
  unacceptedResearch.onOpen(); button(unacceptedResearch.modalEl, 'Confirm research task').click(); await tick();
  assert.equal(closed, 4); closed = 3; assert.equal(unacceptedResearch.closed, true);
  // Launch failures and unaccepted launches never claim the task started.
  assert.equal(startedNotices(), startedBeforeFailures);
  let acknowledged = 0, began = 0;
  let firstUseConfirmed = false;
  const firstUsePlugin = { settings: { codexUsageNoticeSeen: false }, aiReadyForModel: async () => true, confirmAiUsage: async (_model, run) => { if (!firstUseConfirmed) { firstUseConfirmed = true; return false; } acknowledged++; await run(); return true; }, saveSettings: async () => { acknowledged++; } };
  const firstUse = new NextStepModal({}, 'Parent', 1, 0, firstUsePlugin, async (_options, _focus, _done, _failed, accepted) => { began++; accepted(); }, async () => {}, async () => {});
  firstUse.onOpen(); button(firstUse.modalEl, 'Confirm research task').click(); await tick();
  assert.equal(began, 0); assert.equal(button(firstUse.contentEl, 'Agree and send'), undefined); assert.equal(closed, 3);
  button(firstUse.modalEl, 'Confirm research task').click(); await tick();
  assert.equal(began, 1); assert.equal(acknowledged, 1); assert.equal(closed, 4);
  let pendingCalls = 0;
  let pendingConfirmed = false;
  const pendingPlugin = { settings: { codexUsageNoticeSeen: false }, aiReadyForModel: async () => true, confirmAiUsage: async (_model, run) => { if (!pendingConfirmed) { pendingConfirmed = true; return false; } await run(); return true; }, saveSettings: async () => {} };
  const pendingModal = new NextStepModal({}, 'Parent', 1, 1, pendingPlugin, async () => {}, async (_options, _direction, found) => { pendingCalls++; found([{ title: 'Existing', task: 'Research', contribution: '', parentTitle: '' }], async () => {}); }, async () => {});
  pendingModal.onOpen(); find(pendingModal.contentEl, item => item.cls === 'vam-next-cards').children[1].click();
  button(pendingModal.modalEl, 'Review AI subtopic suggestions (1)').click(); await tick();
  assert.equal(pendingCalls, 1); assert.equal(button(pendingModal.contentEl, 'Agree and send'), undefined);
  button(pendingModal.contentEl, 'Create subtopics (1)').click(); await tick();
  assert.equal(pendingModal.closed, true, 'creating the reviewed subtopics ends the guided expansion'); closed -= 1;
  assert.equal(pendingCalls, 1); assert.equal(button(pendingModal.contentEl, 'Agree and send'), undefined);
  // C2 (owner decision 2026-10-19): a slow outline runs with the dialog hidden; the outline waits for review and a
  // reopened dialog carries the shallow-research choice to the create step.
  let finishQuick, delayedOptions, delayedNodes, delayedReady, delayedStops = 0;
  const delayedOutline = { presets: [{ id: 'knowledge-tree', name: 'Knowledge tree generator' }],
    generate: () => new Promise(resolve => { finishQuick = () => resolve(outlineOf('# Parent\n## A\n### A1\n## B')); }),
    create: async (nodes, options) => { delayedNodes = nodes; delayedOptions = options; } };
  const delayed = new NextStepModal({}, 'Parent', 1, 0, plugin, async () => {}, async () => assert.fail('old quick expansion'), async () => {}, { ...modelSettings, quickOutline: delayedOutline, background: { begin: () => { delayedStops++; }, end: () => { delayedStops--; }, outlineReady: outline => { delayedReady = outline; } } });
  delayed.onOpen(); find(delayed.contentEl, item => item.cls === 'vam-next-cards').children[1].click();
  const shallow = find(all(delayed.contentEl, item => item.cls === 'vam-next-adjust-section')[1], item => item.tag === 'input' && item.type === 'checkbox');
  shallow.checked = true;
  button(delayed.modalEl, 'Expand').click(); await tick();
  assert.equal(closed, 5, 'the dialog hides as soon as the outline starts'); assert.equal(delayedNodes, undefined); assert.equal(delayedStops, 1, 'the card shows it running until the outline arrives');
  finishQuick(); await tick(); await tick();
  assert.equal(closed, 5); assert.equal(delayedStops, 0); assert.equal(delayedNodes, undefined, 'the outline is reviewed before anything is created');
  const delayedReview = new NextStepModal({}, 'Parent', 1, 0, plugin, async () => {}, async () => assert.fail('old quick expansion'), async () => {}, { ...modelSettings, quickOutline: delayedOutline, pendingOutline: { ...delayedReady, discard() {} } });
  delayedReview.onOpen();
  button(delayedReview.contentEl, 'Create subtopics (3)').click(); await until(() => delayedReview.closed);
  assert.equal(closed, 6); assert.equal(delayedNodes.length, 3); assert.equal(delayedOptions.shallowResearch, true);
  // A failed outline (for example over the heading limit) after the dialog hid becomes a Notice and creates nothing.
  const invalid = new NextStepModal({}, 'Parent', 1, 0, plugin, async () => {}, async () => assert.fail('over-limit task started'), async () => {}, { ...modelSettings, background: { begin() {}, end() {}, outlineReady: () => assert.fail('no outline') }, quickOutline: {
    presets: [{ id: 'knowledge-tree', name: 'Knowledge tree generator' }],
    generate: async () => { throw new Error('The AI outline has 101 headings; the limit is 100.'); },
    create: async () => assert.fail('nothing to create')
  } });
  invalid.onOpen(); find(invalid.contentEl, item => item.cls === 'vam-next-cards').children[1].click();
  button(invalid.modalEl, 'Expand').click(); await tick(); await tick();
  await until(() => notices.some(message => /101 headings/.test(message)));
  assert.equal(closed, 7); closed = 5;
  // (The guided first expansion that used to hide the dialog at the press is gone with its button; see the pending-review cases above.)
  const settingsWrites = []; let researchAfterSave = false;
  const settingsModal = new NextStepModal({}, 'Parent', 0, 0,
    { settings: { codexUsageNoticeSeen: true, models: 'model-a,model-b' }, availableModels: () => ['model-a', 'model-b'], modelLabel: model => model, modelDiscoveryState: provider => ({ provider, status: 'ready', models: ['model-a', 'model-b'] }), subscribeModelDiscovery: () => () => {}, refreshModelDiscovery: async provider => ({ provider, status: 'ready', models: ['model-a', 'model-b'] }), aiReadyForModel: async model => { checkedModels.push(model); return true; }, confirmAiUsage: async (model, run) => { checkedModels.push(model); await run(); return true; }, saveSettings: async () => {} },
    async (_options, _focus, _done, _failed, accepted) => { researchAfterSave = settingsWrites.length === 1; accepted(); }, async () => {}, async () => {},
    { model: 'model-a', modelSource: 'workspace', reasoning: 'low', save: async patch => { settingsWrites.push(patch); } });
  settingsModal.onOpen();
  assert.equal(find(settingsModal.contentEl, item => item.cls.includes('vam-next-model')).children[0].text, 'Model and advanced settings');
  const modelSelect = find(settingsModal.contentEl, item => item['aria-label'] === 'Model');
  const reasoningSelect = find(settingsModal.contentEl, item => item['aria-label'] === 'Reasoning level');
  modelSelect.value = 'model-b'; modelSelect.change(); reasoningSelect.value = 'high'; reasoningSelect.change();
  assert.equal(researchAfterSave, false);
  assert.deepEqual(plain(settingsWrites), [], 'adjusting the model and effort saves nothing yet');
  // MS-06: the choice is for this run only unless "Pin to this topic" is picked, which is what writes it.
  const scopeSelect = find(settingsModal.contentEl, item => item['aria-label'] === 'Apply to');
  scopeSelect.value = 'pin'; scopeSelect.change();
  button(settingsModal.modalEl, 'Confirm research task').click(); await tick();
  assert.deepEqual(plain(settingsWrites), [{ model: 'model-b', modelSource: 'manual', reasoning: 'high' }], 'saved once, when the run starts');
  assert.equal(checkedModels.at(-1), 'model-b');
  assert.equal(researchAfterSave, true);
  const closedBeforeCancel = closed;
  // C2 (owner decision 2026-10-19): Stop moves to the card; stopping the hidden outline aborts it and creates nothing.
  let cardStop, cancelSignal, cancelReady = 0;
  const cancelModal = new NextStepModal({}, 'Parent', 1, 0, plugin, async () => {}, async () => assert.fail('old quick expansion'), async () => {}, { ...modelSettings, background: { begin: controller => { cardStop = controller; }, end() {}, outlineReady: () => { cancelReady++; } }, quickOutline: {
    presets: [{ id: 'knowledge-tree', name: 'Knowledge tree generator' }],
    generate: (_request, signal) => new Promise((_resolve, reject) => { cancelSignal = signal; signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }, { once: true }); }),
    create: async () => assert.fail('cancel creates nothing')
  } });
  cancelModal.onOpen(); find(cancelModal.contentEl, item => item.cls === 'vam-next-cards').children[1].click();
  button(cancelModal.modalEl, 'Expand').click(); await tick();
  assert.equal(closed, closedBeforeCancel + 1, 'the dialog hid itself'); assert.equal(cancelSignal.aborted, false, 'hiding the dialog does not stop the AI');
  cardStop.abort(); await tick(); await tick();
  assert.equal(cancelSignal.aborted, true); assert.equal(cancelReady, 0, 'a stopped outline is never handed to the view');
});
test('external map conflict UI retains file, screen, and manual merge choices', () => {
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/modals.ts'), 'utf8');
  for (const modal of ['class MapConflictModal']) {
    const start = source.indexOf(modal), next = source.indexOf('\nexport class ', start + modal.length);
    const body = source.slice(start, next < 0 ? source.length : next);
    assert.match(body, /ui\.use_file_contents/); assert.match(body, /ui\.keep_editor_contents/); assert.match(body, /ui\.save_merged_contents/);
  }
});
test('VAM notes hide properties in reading and live preview without removing frontmatter', () => {
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(styles, /\.markdown-preview-view\.visual-agent-map-node \.metadata-container/);
  assert.match(styles, /body \.workspace-leaf-content\.vam-topic-markdown \.markdown-source-view\.mod-cm6 \.metadata-container \{ display: none; \}/);
  assert.doesNotMatch(styles, /\.markdown-preview-view\.vam-topic-markdown \.metadata-container/);
  assert.doesNotMatch(styles, /!important/);
});
test('preview cards display only editable preview content', () => {
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  const card = source.slice(source.indexOf('preview.createEl("strong", { text: note.title })'), source.indexOf('const host = workspace.getBoundingClientRect()'));
  assert.match(card, /note.preview/);
  assert.doesNotMatch(card, /note.summary|User Notes|目前結論/);
});
test('preview renderer receives Markdown in original order with no extra Preview label', () => {
  const created = []; let rendered;
  const rect = {left:0,top:0,right:100,width:800,height:600};
  const element = () => ({style:{setProperty(){}},addEventListener(){},createEl(tag, options){created.push([tag,options.text]);return element()},createDiv(){return element()},getBoundingClientRect(){return rect},remove(){}});
  const workspace = element(); const contentEl = {querySelector(){return workspace}};
  const {VisualAgentMapView} = load('main.ts', {obsidian:{...obsidian,MarkdownRenderer:{render(app, markdown, el, path){rendered={markdown,path};return Promise.resolve()}}}});
  const view = new VisualAgentMapView({app:{}},{settings:{...DEFAULT_SETTINGS}}); view.contentEl=contentEl;view.map=map([node('a')]);
  const markdown='Text first\n\n![Image](https://example.com/a.png)\n\nText after\n\n|A|B|\n|---|---|\n|1|2|';
  view.showHoverCard({...element(),dataset:{nodeId:'a'},querySelector(){return null}},{title:'Topic',preview:markdown});
  assert.equal(rendered.markdown,markdown);assert.equal(rendered.path,'a.md');assert.deepEqual(created,[['strong','Topic']]);
});
test('multi research modal: no per-topic depth radios (the mode is one switch with two radio-role buttons); the list shows names only; the request carries no mode and no style key until one is chosen (was: detailTemplateId; D2); immediate close on start', () => {
  const element = (tag, options = {}) => ({
    tag, text: options.text ?? '', cls: options.cls ?? '', type: options.type, value: options.value ?? '', checked: false, disabled: false, children: [], listeners: {},
    createDiv(value) { const c = element('div', typeof value === 'string' ? { cls: value } : value); this.children.push(c); return c; },
    createEl(name, value = {}) { const c = element(name, value); this.children.push(c); return c; },
    createSpan(value = {}) { const c = element('span', value); this.children.push(c); return c; },
    setText(value) { this.text = value; }, replaceChildren() { this.children = []; }, setAttr(name, value) { this[name] = value; }, addEventListener(name, fn) { this.listeners[name] = fn; }, addClass(n) { this.cls = `${this.cls} ${n}`.trim(); }, removeClass() {}, toggleClass() {}, focus() {}
  });
  const find = (root, predicate) => predicate(root) ? root : root.children.map(c => find(c, predicate)).find(Boolean);
  // As in Obsidian, the content sits inside modalEl; the action bar is modalEl's last child.
  class Modal { constructor(app) { this.app = app; this.titleEl = element('title'); this.contentEl = element('content'); this.modalEl = element('modal'); this.modalEl.children.push(this.contentEl); this.closed = 0; } open() { this.onOpen(); } close() { this.closed++; } }
  const mod = load('experiences/visual-map/multi-research-modal.ts', { obsidian: { ...obsidian, Modal } });
  const requests = [];
  const styles = { refresh: async () => {}, recipes: () => [alphaStyle], openRecipe: async () => {} };
  let models = [], changed = null, unwatched = 0;
  const live = { list: () => models, watch: fn => { changed = fn; return () => { unwatched++; }; } };
  const modal = new mod.MultiResearchModal({}, ['Alpha', 'Beta'], live, request => requests.push(request), { styles }, ['quick', 'standard']); modal.open();
  assert.ok(find(modal.contentEl, i => i.text === 'Alpha')); assert.ok(find(modal.contentEl, i => i.text === 'Beta'));
  // D-2026-10-233 / D-2026-10-247: no web, image or depth choice; the mode is the single switch at the top.
  assert.equal(find(modal.contentEl, i => i.tag === 'input' && i.type === 'checkbox'), undefined);
  assert.equal(find(modal.contentEl, i => i.text === 'Search for image references' || i.text === 'Allow web search'), undefined);
  const radios = (root, pick) => { const out = []; const visit = n => { if (pick(n)) out.push(n); n.children.forEach(visit); }; visit(root); return out; };
  assert.equal(radios(modal.contentEl, n => n.type === 'radio').length, 0, 'no radio inputs');
  assert.equal(radios(modal.contentEl, n => n.role === 'radio').length, 2, 'the mode switch has two radio-role buttons');
  const rows = dom.findAll(modal.contentEl, i => i.cls === 'vam-multi-research-topic').map(row => row.children.map(c => c.text));
  assert.deepEqual(rows, [['Alpha'], ['Beta']], 'the list shows names only; the mode is one switch at the top');
  assert.equal(find(modal.contentEl, i => /vam-multi-research-mode\b(?!-note)/.test(i.cls ?? '') && !/-note/.test(i.cls)), undefined, 'no per-row mode label');
  // The switch sits above the topic list and is the same component as the single-topic dialog.
  const kids = modal.contentEl.children;
  const modeSet = kids.findIndex(c => /vam-ai-mode-set/.test(c.cls)), topicList = kids.findIndex(c => /vam-integration-sources/.test(c.cls));
  assert.ok(modeSet >= 0 && modeSet < topicList, 'mode switch comes before the topic list');
  const modeButton = text => find(modal.contentEl, i => i.tag === 'button' && i.text === text);
  const note = () => find(modal.contentEl, i => /vam-multi-research-mode-note/.test(i.cls ?? ''));
  // Opened on Quick with one Standard topic: the reminder is shown; Standard hides it; back to Quick shows it again.
  assert.ok(modeButton('Quick') && modeButton('Standard'));
  assert.equal(note().hidden, false); assert.match(note().text, /1 of these topics last used Standard and will use Quick this time\./);
  modeButton('Standard').listeners.click(); assert.equal(note().hidden, true);
  modeButton('Quick').listeners.click(); assert.equal(note().hidden, false);
  modeButton('Standard').listeners.click();
  const model = () => find(modal.contentEl, i => i.tag === 'select' && i['aria-label'] === 'Model'); assert.equal(model().value, '');
  assert.deepEqual(plain(model().children.map(c => c.value)), ['']);
  models = [{ id: 'm1', label: 'Model One' }, { id: 'm2', label: 'Model Two' }]; changed();
  assert.deepEqual(plain(model().children.map(c => [c.value, c.text])), [['', 'Current model (overridden topics keep their own)'], ['m1', 'Model One'], ['m2', 'Model Two']]);
  // One line "Note style: Each topic's own setting"; opened, its select lists Keep (X), then the user's style files (was: the Note style select with five presets and template blocks).
  assert.equal(find(modal.contentEl, i => /vam-style-choice-text/.test(i.cls)).children.map(c => c.text).join(''), "Note style: Each topic's own setting");
  find(modal.contentEl, i => i.tag === 'button' && i.text === 'Use another style this time').listeners.click({ preventDefault() {} });
  const templateSelect = find(modal.contentEl, i => i.tag === 'select' && i['aria-label'] === 'Note style for this run');
  assert.deepEqual(plain(templateSelect.children.filter(c => c.tag === 'option').map(c => c.value)), ['']);
  assert.deepEqual(plain(find(templateSelect, c => c.tag === 'optgroup').children.map(c => [c.value, c.text])), [['file:Alpha style', 'Alpha style']]);
  templateSelect.value = ''; templateSelect.listeners.change();
  const start = find(modal.modalEl, i => i.tag === 'button' && i.text === 'Start research (2)');
  start.listeners.click(); start.listeners.click();
  assert.equal(modal.closed, 1); assert.equal(requests.length, 1); modal.onClose(); assert.equal(unwatched, 1);
  assert.deepEqual(plain(requests[0]), { requirements: '', researchMode: 'research', researchDepth: 'normal', imageSearch: true }, 'Standard: the request overrides every topic with web search and images');
  const second = []; const m2 = new mod.MultiResearchModal({}, ['A'], { list: () => [{ id: 'm1', label: 'Model One' }], watch: () => () => {} }, r => second.push(r), { styles }); m2.open();
  find(m2.contentEl, i => i.tag === 'select' && i['aria-label'] === 'Model').value = 'm1';
  // A style file is picked in the one-line choice itself.
  find(m2.contentEl, i => i.tag === 'button' && i.text === 'Use another style this time').listeners.click({ preventDefault() {} });
  const style2 = find(m2.contentEl, i => i.tag === 'select' && i['aria-label'] === 'Note style for this run'); style2.value = 'file:Alpha style'; style2.listeners.change();
  find(m2.contentEl, i => i.tag === 'textarea').value = '  only 2025  ';
  find(m2.modalEl, i => i.tag === 'button' && i.text === 'Start research (1)').listeners.click();
  assert.deepEqual(plain(second[0]), { requirements: 'only 2025', researchMode: 'local', researchDepth: 'normal', imageSearch: false, model: 'm1', noteStyle: 'file:Alpha style' }, 'default is Quick');
  assert.equal(find(m2.contentEl, i => /vam-multi-research-mode-note/.test(i.cls ?? '')).hidden, true, 'no modes given: no reminder');
  // The remembered mode of the map is what the dialog opens on; all topics Quick or Standard chosen: no reminder.
  const third = []; const m3 = new mod.MultiResearchModal({}, ['A', 'B'], { list: () => [], watch: () => () => {} }, r => third.push(r), { styles }, ['quick', 'standard'], 'standard'); m3.open();
  assert.equal(find(m3.contentEl, i => /vam-multi-research-mode-note/.test(i.cls ?? '')).hidden, true, 'opened on Standard: no reminder');
  find(m3.modalEl, i => i.tag === 'button' && i.text === 'Start research (2)').listeners.click();
  assert.equal(third[0].researchMode, 'research'); assert.equal(third[0].imageSearch, true);
  const m4 = new mod.MultiResearchModal({}, ['A', 'B'], { list: () => [], watch: () => () => {} }, () => {}, { styles }, ['quick', 'quick']); m4.open();
  assert.equal(find(m4.contentEl, i => /vam-multi-research-mode-note/.test(i.cls ?? '')).hidden, true, 'no Standard topic: no reminder');
  // Cancel: nothing submitted.
  const m5 = []; const cancelled = new mod.MultiResearchModal({}, ['A'], { list: () => [], watch: () => () => {} }, r => m5.push(r), { styles }); cancelled.open();
  find(cancelled.modalEl, i => i.tag === 'button' && i.text === 'Cancel').listeners.click();
  assert.equal(m5.length, 0); assert.equal(cancelled.closed, 1);
});
test('card shows a Format not met badge with the issues as tooltip', () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const element = tag => ({ tag, children: [], dataset: {}, style: {},
    createDiv(options) { const child = element('div'); child.cls = options?.cls ?? options; this.children.push(child); return child; },
    createEl(name, options) { const child = element(name); child.text = options?.text; this.children.push(child); return child; },
    createSpan(options) { const child = element('span'); child.text = options?.text; child.cls = options?.cls; this.children.push(child); return child; },
    setAttr(name, value) { this[name] = value; }, addClass(name) { this.cls = name; },
    addEventListener() {}, removeEventListener() {}, setPointerCapture() {}
  });
  const find = (item, predicate) => predicate(item) ? item : item.children.map(child => find(child, predicate)).find(Boolean);
  const topic = node('topic');
  const plugin = { repo: {}, settings: { ...DEFAULT_SETTINGS }, expansionBatches: new Map(), running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, quickExpandPending: new Set(), pendingSuggestions: new Map() };
  const render = issues => {
    const view = new VisualAgentMapView({ app: {} }, plugin); view.stageEl = element('stage'); view.map = map([topic]);
    view.notes = new Map([[topic.id, { title: 'Topic', summary: '', status: 'completed', detailFormatIssues: issues }]]);
    view.renderNode(topic);
    return find(view.stageEl, item => item.tag === 'span' && item.text === 'Format not met');
  };
  const badge = render(['Examples: needs exactly 3, has 1']);
  assert.ok(badge, 'badge shown');
  assert.equal(badge.cls, 'vam-status vam-status-error');
  assert.equal(badge.title, 'Examples: needs exactly 3, has 1');
  assert.equal(render([]), undefined);
});

integrationTest('Next Step modal: the style choice goes into research, expansion and synthesis options as noteStyle only when picked (was: detailTemplateId from the content template select; Q18, D2)', async () => {
  const { element, find, findAll: all, button } = dom;
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  class Modal { constructor() { this.modalEl = element('modal'); this.titleEl = element('title'); this.contentEl = element('content'); this.modalEl.children.push(this.contentEl); } close() { this.onClose?.(); } }
  const { NextStepModal } = load('main.ts', { obsidian: { ...obsidian, Modal, setIcon: () => {}, Notice: class {} } });
  const modelState = provider => ({ provider, status: 'ready', models: [] });
  const plugin = { noteStyles: { refresh: async () => {}, listRecipes: () => [alphaStyle], listBlocks: category => (category === 'template' ? [{ ref: 'file:Alpha template', kind: 'file', name: 'Alpha template', fileName: 'Alpha template.md', modified: false, issues: [] }] : []), ensureBlockFile: async () => ({ path: 'x', base: 'Alpha template' }) }, settings: { codexUsageNoticeSeen: true, claudeUsageNoticeSeen: true, models: 'gpt-test', cliReasoning: 'low', language: 'en' }, aiReadyForModel: async () => true, confirmAiUsage: async (_m, run) => { await run(); return true; }, saveSettings: async () => {}, activeTasks: new Map(), availableModels: () => ['gpt-test'], modelLabel: model => model, modelDiscoveryState: modelState, subscribeModelDiscovery: () => () => {}, refreshModelDiscovery: async provider => modelState(provider), sources: { mapSources: async () => [], synthesisTopics: ['Child'] } };
  const templates = [{ id: 'standard', name: 'Standard' }, { id: 'A', name: 'Alpha template' }];
  const settings = { model: 'gpt-test', modelSource: 'workspace', reasoning: 'low', save: async () => {}, sources: plugin.sources, currentStyle: 'Standard' };
  const seen = {};
  const open = (name, withSettings) => {
    const modal = new NextStepModal({}, 'Parent', 1, 0, plugin,
      async options => { seen.research = options; },
      async options => { seen.expand = options; },
      async options => { seen.synth = options; }, withSettings);
    modal.onOpen();
    return modal;
  };
  const templateSelect = modal => {
    find(modal.contentEl, item => item.tag === 'button' && item.text === 'Use another style this time').click();
    return find(modal.contentEl, item => item.tag === 'select' && item['aria-label'] === 'Note style for this run');
  };
  // A style file is picked in the one-line choice itself (it opens first).
  const cardsOf = modal => find(modal.contentEl, item => item.cls === 'vam-next-cards');
  // Owner decision 2026-10-19: a research press hides the dialog, so each choice runs on its own fresh dialog.
  const modal = open('keep', settings);
  assert.equal(find(modal.contentEl, i => /vam-style-choice-text/.test(i.cls)).children.map(c => c.text).join(''), 'Note style: Standard');
  const listed = templateSelect(modal);
  assert.deepEqual(plain(listed.children.filter(c => c.tag === 'option').map(c => c.value)), ['']);
  assert.deepEqual(plain(find(listed, c => c.tag === 'optgroup').children.map(c => [c.value, c.text])), [['file:Alpha style', 'Alpha style']]);
  button(modal.modalEl, 'Confirm research task').click(); await tick();
  assert.equal('noteStyle' in seen.research, false, 'keep-current sends no choice'); assert.equal('detailTemplateId' in seen.research, false);
  const picked = open('picked', settings);
  templateSelect(picked).value = 'file:Alpha style';
  button(picked.modalEl, 'Confirm research task').click(); await tick();
  assert.equal(seen.research.noteStyle, 'file:Alpha style'); assert.equal('detailTemplateId' in seen.research, false);
  // C2: quick explore is an AI outline reviewed in the dialog; the template choice reaches its create step.
  // Owner decision 2026-10-19: Generate hides the dialog; the template choice rides along to the reopened review's create step.
  let ready;
  const quickOutline = { presets: [{ id: 'knowledge-tree', name: 'Knowledge tree generator' }], generate: async () => plain(load('experiences/visual-map/outline-import.ts', { obsidian }).parseOutline('# Parent\n## A').nodes), create: async (_nodes, options) => { seen.expand = options; } };
  const quickModal = open('quick', { ...settings, quickOutline, background: { begin() {}, end() {}, outlineReady: outline => { ready = outline; } } });
  templateSelect(quickModal).value = 'file:Alpha style';
  cardsOf(quickModal).children[1].click();
 
  button(quickModal.modalEl, 'Expand').click(); await tick(); await tick();
  const reviewModal = open('review', { ...settings, quickOutline, pendingOutline: { ...ready, discard() {} } });
  button(reviewModal.contentEl, 'Create subtopics (1)').click(); await tick(); await tick();
  assert.equal(seen.expand.noteStyle, 'file:Alpha style');
  const synthModal = open('synth', settings);
  templateSelect(synthModal).value = 'file:Alpha style';
  cardsOf(synthModal).children[2].click();
  const synthPanel = all(synthModal.contentEl, item => item.cls.includes('vam-next-research'))[2];
  button(synthModal.modalEl, 'Get synthesis suggestions first').click(); await tick();
  assert.equal(seen.synth.noteStyle, 'file:Alpha style');
  const bare = open('bare', undefined);
  assert.deepEqual(plain(templateSelect(bare).children.filter(c => c.tag === 'option').map(c => c.value)).slice(0, 1), [''], 'a dialog with no settings still shows the choice');
});
integrationTest('draft review renders the draft, edits on demand and keeps the dialog open when saving fails', async () => {
  const element = (tag, options = {}) => ({
    tag, text: options.text, value: options.text ?? '', cls: options.cls ?? '', attr: options.attr ?? {}, children: [], hidden: false,
    createDiv(value) { const child = element('div', typeof value === 'string' ? { cls: value } : value); this.children.push(child); return child; },
    createEl(name, value) { const child = element(name, value); this.children.push(child); return child; },
    createSpan(value) { const child = element('span', value); this.children.push(child); return child; },
    addClass(name) { this.cls = `${this.cls} ${name}`.trim(); }, removeClass(name) { this.cls = this.cls.split(' ').filter(item => item !== name).join(' '); }, setText(value) { this.text = value; }, setAttr(name, value) { this.attr[name] = value; },
    addEventListener(name, handler) { if (name === 'click') this.click = handler; }, empty() { this.children = []; this.rendered = undefined; }, focus() { this.focused = true; }
  });
  const find = (root, predicate) => predicate(root) ? root : root.children.map(child => find(child, predicate)).find(Boolean);
  class Modal { constructor() { this.modalEl = element('modal'); this.titleEl = element('title'); this.contentEl = element('content'); } close() { this.closed = true; this.onClose?.(); } }
  class Component { load() { this.loaded = true; } unload() { this.loaded = false; } addChild(child) { return child; } removeChild() {} }
  const MarkdownRenderer = { render: async (_app, markdown, el) => { el.rendered = markdown; } };
  const { DraftReviewModal } = load('main.ts', { obsidian: { ...obsidian, Modal, Component, MarkdownRenderer, setIcon: () => {} } });
  const saved = []; let failNext = true;
  const modal = new DraftReviewModal({}, 'New summary', '## Result\n\n- **one**', { intro: 'Confirming replaces the summary and details of “Parent”.', currentSummary: 'Old summary', confirmLabel: 'Confirm update to parent topic' }, async (summary, detail) => {
    if (failNext) { failNext = false; throw new Error('The topic changed'); }
    saved.push([summary, detail]);
  });
  modal.onOpen();
  assert.ok(find(modal.contentEl, item => item.text === 'Confirming replaces the summary and details of “Parent”.'));
  assert.ok(find(modal.contentEl, item => item.text === 'Old summary'));
  const previews = [];
  (function collect(item) { if (item.cls.includes('vam-draft-preview')) previews.push(item); item.children.forEach(collect); })(modal.contentEl);
  assert.deepEqual(previews.map(item => item.rendered), ['New summary', '## Result\n\n- **one**']);
  const inputs = [];
  (function collect(item) { if (item.tag === 'textarea') inputs.push(item); item.children.forEach(collect); })(modal.contentEl);
  assert.deepEqual(inputs.map(item => item.hidden), [true, true]);
  const toggle = find(modal.contentEl, item => item.cls.includes('vam-draft-toggle'));
  assert.equal(toggle.text, 'Edit');
  toggle.click();
  assert.equal(toggle.text, 'Preview'); assert.equal(toggle.attr['aria-pressed'], 'true');
  assert.deepEqual(inputs.map(item => item.hidden), [false, false]); assert.equal(inputs[0].focused, true);
  inputs[1].value = '## Edited';
  toggle.click();
  assert.equal(previews[1].rendered, '## Edited');
  // Actions sit in a fixed bar below the scrolling content, not inside it.
  const actions = find(modal.modalEl, item => item.cls === 'vam-next-actions');
  assert.ok(modal.modalEl.cls.includes('vam-review-modal')); assert.equal(find(modal.contentEl, item => item.cls === 'vam-next-actions'), undefined);
  const actionButtons = actions.children.filter(item => item.tag === 'button');
  assert.deepEqual(actionButtons.map(item => item.text), ['Cancel', 'Confirm update to parent topic']);
  const confirm = actionButtons[1];
  assert.ok(confirm.cls.includes('mod-cta'));
  confirm.click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.notEqual(modal.closed, true); assert.equal(confirm.disabled, false);
  assert.ok(find(actions, item => item.cls.includes('vam-next-status') && /The topic changed/.test(item.text ?? '')));
  confirm.click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(saved, [['New summary', '## Edited']]); assert.equal(modal.closed, true);
});
integrationTest('draft review asks once more before discarding the AI draft', async () => {
  const element = (tag, options = {}) => ({
    tag, text: options.text, value: options.text ?? '', cls: options.cls ?? '', attr: options.attr ?? {}, children: [], hidden: false,
    createDiv(value) { const child = element('div', typeof value === 'string' ? { cls: value } : value); this.children.push(child); return child; },
    createEl(name, value) { const child = element(name, value); this.children.push(child); return child; },
    createSpan(value) { const child = element('span', value); this.children.push(child); return child; },
    addClass(name) { this.cls = `${this.cls} ${name}`.trim(); }, removeClass(name) { this.cls = this.cls.split(' ').filter(item => item !== name).join(' '); }, setText(value) { this.text = value; }, setAttr(name, value) { this.attr[name] = value; },
    addEventListener(name, handler) { if (name === 'click') this.click = handler; }, empty() { this.children = []; }, focus() {}
  });
  const find = (root, predicate) => predicate(root) ? root : root.children.map(child => find(child, predicate)).find(Boolean);
  class Modal { constructor() { this.modalEl = element('modal'); this.titleEl = element('title'); this.contentEl = element('content'); } close() { this.closed = true; this.onClose?.(); } }
  class Component { load() {} unload() {} addChild(child) { return child; } removeChild() {} }
  const { DraftReviewModal } = load('main.ts', { obsidian: { ...obsidian, Modal, Component, MarkdownRenderer: { render: async () => {} }, setIcon: () => {} } });
  let discarded = 0;
  const modal = new DraftReviewModal({}, 'S', 'D', { intro: 'Intro', confirmLabel: 'Confirm update to parent topic' }, () => {}, () => { discarded++; });
  modal.onOpen();
  const actions = find(modal.modalEl, item => item.cls === 'vam-next-actions');
  assert.deepEqual(actions.children.filter(item => item.tag === 'button').map(item => item.text), ['Discard', 'Cancel', 'Confirm update to parent topic']);
  const discard = actions.children.find(item => item.tag === 'button');
  assert.ok(discard.cls.includes('vam-discard')); assert.ok(!discard.cls.includes('mod-warning'));
  discard.click();
  assert.equal(discarded, 0); assert.notEqual(modal.closed, true);
  assert.equal(discard.text, 'Discard draft?'); assert.ok(discard.cls.includes('mod-warning'));
  assert.match(find(actions, item => item.cls.includes('vam-next-status')).text, /cannot be recovered/);
  discard.click();
  assert.equal(discarded, 1); assert.equal(modal.closed, true);
});
integrationTest('proposal list groups children, links parent and child checks and keeps errors in the dialog', () => {
  const element = (tag, options = {}) => ({
    tag, type: options.type, text: options.text, value: options.value ?? options.text ?? '', cls: options.cls ?? '', attr: options.attr ?? {}, children: [], hidden: false, disabled: false, checked: false,
    createDiv(value) { const child = element('div', typeof value === 'string' ? { cls: value } : value); this.children.push(child); return child; },
    createEl(name, value) { const child = element(name, value); this.children.push(child); return child; },
    createSpan(value) { const child = element('span', value); this.children.push(child); return child; },
    addClass(name) { this.cls = `${this.cls} ${name}`.trim(); }, setText(value) { this.text = value; }, setAttr(name, value) { this.attr[name] = value; },
    addEventListener(name, handler) { this[name] = handler; }, empty() { this.children = []; }, focus() {}
  });
  const all = (root, predicate) => [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))];
  const find = (root, predicate) => all(root, predicate)[0];
  class Modal { constructor() { this.modalEl = element('modal'); this.titleEl = element('title'); this.contentEl = element('content'); } close() { this.closed = true; } }
  const { ChildProposalModal } = load('main.ts', { obsidian: { ...obsidian, Modal, setIcon: () => {} } });
  let submitted;
  const modal = new ChildProposalModal({}, [
    { title: 'Heat', task: 'T1', contribution: '', parentTitle: '' },
    { title: 'Dry it', task: 'T3', contribution: '', parentTitle: 'Water' },
    { title: 'Water', task: 'T2', contribution: '', parentTitle: '' }
  ], items => { submitted = items; });
  modal.onOpen();
  const rows = all(modal.contentEl, item => item.cls.split(' ').includes('vam-proposal'));
  const names = rows.map(row => find(row, item => item.tag === 'input' && item.type === 'text').value);
  assert.deepEqual(names, ['Heat', 'Water', 'Dry it']);
  assert.deepEqual(rows.map(row => row.cls.includes('is-child')), [false, false, true]);
  // Details stay folded until asked for.
  const body = find(rows[0], item => item.cls === 'vam-proposal-body'); const more = find(rows[0], item => item.cls === 'vam-proposal-more');
  assert.equal(body.hidden, true); more.click(); assert.equal(body.hidden, false); assert.equal(more.attr['aria-expanded'], 'true');
  const checks = rows.map(row => find(row, item => item.type === 'checkbox'));
  const create = find(modal.modalEl, item => item.tag === 'button' && item.cls.includes('mod-cta'));
  const count = find(modal.contentEl, item => item.cls === 'vam-proposal-count');
  assert.equal(create.text, 'Create subtopics (3)'); assert.equal(count.text, '3 of 3 selected');
  checks[1].checked = false; checks[1].change();
  assert.equal(checks[2].checked, false, 'unchecking a parent unchecks its children');
  assert.equal(create.text, 'Create subtopics (1)');
  checks[2].checked = true; checks[2].change();
  assert.equal(checks[1].checked, true, 'checking a child checks its parent');
  const toggleAll = find(modal.contentEl, item => item.cls === 'vam-proposal-all');
  assert.equal(toggleAll.text, 'Select none'); toggleAll.click();
  assert.deepEqual(checks.map(check => check.checked), [false, false, false]); assert.equal(create.disabled, true); assert.equal(toggleAll.text, 'Select all');
  toggleAll.click();
  const waterName = find(rows[1], item => item.type === 'text'); waterName.value = 'Heat';
  create.click();
  assert.equal(modal.closed, undefined); assert.equal(submitted, undefined);
  assert.match(find(modal.modalEl, item => item.cls.includes('vam-next-status')).text, /must be unique/);
  waterName.value = 'Moisture';
  create.click();
  assert.equal(modal.closed, true);
  assert.equal(JSON.stringify(submitted.map(item => [item.title, item.parentTitle])), JSON.stringify([['Heat', ''], ['Moisture', ''], ['Dry it', 'Moisture']]));
});
integrationTest('merge dialog (the shared synthesis dialog) names the topic after its sources and explains a blocked first step', async () => {
  const { element, find, button, tick } = dom;
  class Modal { constructor() { this.modalEl = element('modal'); this.titleEl = element('title'); this.contentEl = element('content'); this.modalEl.children.push(this.contentEl); } close() { this.closed = true; this.onClose?.(); } }
  class Component { load() {} unload() {} addChild(child) { return child; } removeChild() {} }
  const { NextStepModal } = load('main.ts', { obsidian: { ...obsidian, Modal, Component, MarkdownRenderer: { render: async () => {} }, setIcon: () => {} } });
  const plugin = { settings: { language: 'en', cliModel: 'gpt-test', codexUsageNoticeSeen: true }, aiReadyForModel: async () => true, confirmAiUsage: async (_model, run) => { await run(); return true; }, activeTasks: new Map() };
  const sources = { mapSources: async () => [] };
  const open = (names, title, calls) => {
    const modal = new NextStepModal({}, '', 0, 0, plugin, async () => {}, async () => {}, async (options, direction, _failed, accepted) => { calls.push({ options, direction }); accepted(); },
      undefined, { names, initialTitle: title, defaultDirection: 'Find shared conclusions', fields: { sources, templates: [], tones: [] } });
    modal.onOpen();
    return modal;
  };
  const calls = [];
  const modal = open(['Heat', 'Water'], 'Synthesis: Heat, Water', calls);
  assert.equal(modal.titleEl.text, 'Confirm topic synthesis');
  const name = find(modal.contentEl, item => item.tag === 'input' && item['aria-label'] === 'New topic name');
  assert.equal(name.value, 'Synthesis: Heat, Water');
  assert.equal(find(modal.contentEl, item => item.cls.includes('vam-next-cards')).cls.includes('is-hidden'), true, 'a selection has no research or expand steps to pick');
  const next = button(modal.modalEl, 'Get synthesis suggestions first'), skip = button(modal.modalEl, 'Skip suggestions and synthesize now');
  const status = dom.findAll(modal.contentEl, item => item.cls.includes('vam-next-research'))[2].querySelector('.vam-next-status');
  assert.equal(next.disabled, false); assert.equal(skip.disabled, false); assert.equal(status.text, '');
  name.value = '  '; name.input();
  assert.equal(next.disabled, true); assert.equal(skip.disabled, true); assert.equal(status.text, 'Enter a name for the new topic first.');
  name.value = 'Cooking water'; name.input();
  assert.equal(next.disabled, false); assert.equal(status.text, '');
  next.click(); await tick();
  assert.equal(calls[0].direction, null); assert.equal(calls[0].options.synthesisTitle, 'Cooking water');
});integrationTest('review dialogs: duplicate parents list each proposal once, discard waits for a running save, and a failed render shows plain text', async () => {
  const element = (tag, options = {}) => ({
    tag, type: options.type, text: options.text, value: options.value ?? options.text ?? '', cls: options.cls ?? '', attr: options.attr ?? {}, children: [], hidden: false, disabled: false, checked: false,
    createDiv(value) { const child = element('div', typeof value === 'string' ? { cls: value } : value); this.children.push(child); return child; },
    createEl(name, value) { const child = element(name, value); this.children.push(child); return child; },
    createSpan(value) { const child = element('span', value); this.children.push(child); return child; },
    addClass(name) { this.cls = `${this.cls} ${name}`.trim(); }, removeClass(name) { this.cls = this.cls.split(' ').filter(item => item !== name).join(' '); }, setText(value) { this.text = value; }, setAttr(name, value) { this.attr[name] = value; },
    addEventListener(name, handler) { this[name] = handler; }, empty() { this.children = []; this.text = undefined; }, focus() {}
  });
  const all = (root, predicate) => [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))];
  const find = (root, predicate) => all(root, predicate)[0];
  class Modal { constructor() { this.modalEl = element('modal'); this.titleEl = element('title'); this.contentEl = element('content'); } close() { this.closed = true; this.onClose?.(); } }
  class Component { load() {} unload() {} addChild(child) { return child; } removeChild() {} }
  const MarkdownRenderer = { render: async () => { throw new Error('render failed'); } };
  const { ChildProposalModal, DraftReviewModal } = load('main.ts', { obsidian: { ...obsidian, Modal, Component, MarkdownRenderer, setIcon: () => {} } });
  const proposals = new ChildProposalModal({}, [
    { title: 'Heat', task: '', contribution: '', parentTitle: '' },
    { title: 'Heat', task: '', contribution: '', parentTitle: '' },
    { title: 'Pan', task: '', contribution: '', parentTitle: 'Heat' }
  ], () => {});
  proposals.onOpen();
  assert.equal(all(proposals.contentEl, item => item.cls.split(' ').includes('vam-proposal')).length, 3);
  let finishSave, discarded = 0;
  const draft = new DraftReviewModal({}, 'S', '## D', { intro: 'Intro', confirmLabel: 'Confirm' }, () => new Promise(resolve => { finishSave = resolve; }), () => { discarded++; });
  draft.onOpen(); await new Promise(resolve => setTimeout(resolve, 0));
  const previews = all(draft.contentEl, item => item.cls.includes('vam-draft-preview'));
  assert.deepEqual(previews.map(item => item.text), ['S', '## D']);
  const buttons = all(draft.modalEl, item => item.tag === 'button' && item.cls !== 'vam-draft-toggle');
  const [discard, cancel, confirm] = buttons;
  confirm.click();
  assert.equal(cancel.disabled, true);
  discard.click(); discard.click();
  assert.equal(discarded, 0, 'discard does nothing while the save runs');
  finishSave(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(draft.closed, true);
});
integrationTest('structure panel: choosing a parent moves the topic at once and says where it went; there is no Apply, and Remove stays apart (decision 40)', () => {
  const element = (tag, options = {}) => ({
    tag, text: options.text, value: options.value ?? '', cls: options.cls ?? '', attr: options.attr ?? {}, children: [], disabled: false, style: {}, dataset: {},
    createDiv(value) { const child = element('div', typeof value === 'string' ? { cls: value } : value); this.children.push(child); return child; },
    createEl(name, value) { const child = element(name, value); this.children.push(child); return child; },
    createSpan(value) { const child = element('span', value); this.children.push(child); return child; },
    addClass(name) { this.cls = `${this.cls} ${name}`.trim(); }, toggleClass(name, on) { this.cls = on ? `${this.cls} ${name}`.trim() : this.cls.split(' ').filter(c => c !== name).join(' '); },
    setText(value) { this.text = value; }, setAttr(name, value) { this.attr[name] = value; },
    addEventListener(name, handler) { this[name] = handler; }
  });
  const all = (root, predicate) => [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))];
  const find = (root, predicate) => all(root, predicate)[0];
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  // Every card on a map has coordinates; moving under another parent lays the branch out from them.
  const nodes = [{ id: 'a', path: 'A.md', parentId: null, x: 80, y: 80 }, { id: 'b', path: 'B.md', parentId: null, x: 80, y: 400 }, { id: 'c', path: 'C.md', parentId: 'a', x: 400, y: 80 }];
  const changes = []; let closed = 0, removed = 0, merging = false;
  const view = {
    renderDisclosure(parent) { return parent.createDiv('vam-disclosure-body'); }, renderHypothesisSection() {}, renderMarkerSection() {}, renderLinkSection() {}, renderColorSection() {}, renderStyleSection() {}, renderCoverSection() {}, renderAiLockSection() {}, renderBranchLayoutSection() {}, renderAddSubtopic() {},
    cardHeightOf: () => 100, arrangeBranch: VisualAgentMapView.prototype.arrangeBranch,
    map: { nodes }, notes: new Map([['a', { title: 'Heat' }], ['b', { title: 'Water' }], ['c', { title: 'Pan', sourcePaths: [] }]]),
    app: { vault: { getAbstractFileByPath: () => null } }, referenceSourcePaths: () => [],
    button(parent, text, click) { const b = parent.createEl('button', { text }); b.click = click; return b; },
    mergeUnlocked: () => !merging, confirmRemoveNode() { removed++; }, enqueue(work) { work(); }, mapChange(change) { const copy = { nodes: nodes.map(n => ({ ...n })) }; change(copy); changes.push(copy.nodes.find(n => n.id === 'c').parentId); }
  };
  const content = element('content'), host = element('modal');
  VisualAgentMapView.prototype.renderInspector.call(view, content, nodes[2], 'structure', () => { closed++; }, host);
  assert.ok(find(content, item => item.text === 'Pan'));
  assert.equal(find(content, item => item.tag === 'button' && item.text === 'Remove parent link'), undefined);
  const actions = find(host, item => item.cls === 'vam-next-actions');
  const buttons = actions.children.filter(item => item.tag === 'button');
  assert.deepEqual(buttons.map(item => item.text), ['Remove from map', 'Close']);
  assert.ok(buttons[0].cls.includes('vam-discard'));
  const status = find(actions, item => item.cls.includes('vam-next-status'));
  assert.equal(status.text, undefined, 'nothing moved yet');
  // The parent picker is an indented tree like the outline; the topic itself cannot be its own parent.
  const tree = find(content, item => item.cls === 'vam-topic-tree');
  const rows = tree.children.map(row => [row.dataset.id, row.text, row.style.paddingLeft, row.disabled]);
  assert.deepEqual(rows, [['', 'No parent (root topic)', '8px', false], ['a', 'Heat', '8px', false], ['c', 'Pan', '24px', true], ['b', 'Water', '8px', false]]);
  const row = id => tree.children.find(item => item.dataset.id === id);
  assert.ok(row('a').cls.includes('is-selected'), 'current parent starts selected');
  row('b').click();
  assert.ok(row('b').cls.includes('is-selected')); assert.ok(!row('a').cls.includes('is-selected'));
  assert.deepEqual(changes, ['b'], 'one click moves it'); assert.equal(status.text, 'Moved under “Water”.'); assert.equal(closed, 0, 'the dialog stays open');
  row('b').click();
  assert.deepEqual(changes, ['b'], 'choosing the parent it already has writes nothing');
  row('').click();
  assert.deepEqual(changes, ['b', null]); assert.equal(status.text, 'Now a root topic.');
  buttons[0].click();
  assert.equal(removed, 1);
  // A card that is merging keeps its parent, and the tree goes back to the one it has.
  merging = true; row('b').click();
  assert.deepEqual(changes, ['b', null], 'no parent change while the card is merging');
  assert.ok(row('').cls.includes('is-selected')); assert.ok(!row('b').cls.includes('is-selected'));
});
integrationTest('expansion suggestions panel uses the shared list, treats the topic as first-level parent and asks before discarding', async () => {
  const element = (tag, options = {}) => ({
    tag, type: options.type, text: options.text, value: options.value ?? options.text ?? '', cls: options.cls ?? '', attr: options.attr ?? {}, children: [], hidden: false, disabled: false, checked: false,
    get textContent() { return this.text; },
    createDiv(value) { const child = element('div', typeof value === 'string' ? { cls: value } : value); this.children.push(child); return child; },
    createEl(name, value) { const child = element(name, value); this.children.push(child); return child; },
    createSpan(value) { const child = element('span', value); this.children.push(child); return child; },
    addClass(name) { this.cls = `${this.cls} ${name}`.trim(); }, removeClass(name) { this.cls = this.cls.split(' ').filter(item => item !== name).join(' '); }, setText(value) { this.text = value; }, setAttr(name, value) { this.attr[name] = value; },
    addEventListener(name, handler) { this[name] = handler; }
  });
  const all = (root, predicate) => [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))];
  const find = (root, predicate) => all(root, predicate)[0];
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const node = { id: 'p', path: 'P.md', parentId: null };
  const suggestions = [{ title: 'Heat', task: '', contribution: '', parentTitle: 'Parent' }, { title: 'Pan', task: '', contribution: '', parentTitle: 'Heat' }];
  const pendingSuggestions = new Map([['P.md', suggestions]]);
  let created, closed = 0, rendered = 0;
  const view = {
    map: { nodes: [node] }, render() { rendered++; },
    plugin: attachTopicRuns({ pendingSuggestions, pendingResearchOptions: new Map(), expansionCoordinator: { isRunning: () => false }, mutate: async work => work() }),
    assertSuggestionOrigin: async () => {}, createChildBatch: async (_parent, items) => { created = items; return []; }, startShallowResearch: async () => {}
  };
  const panel = element('panel'), host = element('modal');
  VisualAgentMapView.prototype.renderPendingProposals.call(view, panel, node, { title: 'Parent' }, () => { closed++; }, host);
  const rows = all(panel, item => item.cls.split(' ').includes('vam-proposal'));
  assert.deepEqual(rows.map(row => row.cls.includes('is-child')), [false, true]);
  const actions = find(host, item => item.cls === 'vam-next-actions');
  const [discard, close, create] = actions.children.filter(item => item.tag === 'button');
  assert.equal(create.text, 'Create subtopics (2)'); assert.ok(discard.cls.includes('vam-discard')); assert.equal(close.text, 'Close');
  discard.click();
  assert.equal(pendingSuggestions.has('P.md'), true); assert.equal(discard.text, 'Discard draft?');
  create.click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(JSON.stringify(created.map(item => [item.title, item.parentTitle])), JSON.stringify([['Heat', ''], ['Pan', 'Heat']]));
  assert.equal(closed, 1);
  pendingSuggestions.set('P.md', suggestions);
  const again = element('panel'), host2 = element('modal');
  VisualAgentMapView.prototype.renderPendingProposals.call(view, again, node, { title: 'Parent' }, () => { closed++; }, host2);
  const discard2 = find(host2, item => item.tag === 'button' && item.cls.includes('vam-discard'));
  discard2.click(); discard2.click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(pendingSuggestions.has('P.md'), false); assert.equal(closed, 2);
  // UX B11: with no suggestions the panel is not blank: one line says why, and "AI explore" (the step that makes them) is offered.
  const explored = []; Object.assign(view, { whenEditing: run => run(), openNextStep: target => explored.push(target.id) });
  const none = element('panel'), host3 = element('modal');
  VisualAgentMapView.prototype.renderPendingProposals.call(view, none, node, { title: 'Parent' }, () => { closed++; }, host3);
  assert.match(find(none, item => item.tag === 'p').text, /no expansion suggestions for this topic yet\. Choose “AI explore”/);
  const [closeNone, explore] = find(host3, item => item.cls === 'vam-next-actions').children.filter(item => item.tag === 'button');
  assert.equal(closeNone.text, 'Close'); assert.equal(explore.text, 'AI explore'); assert.ok(explore.cls.includes('mod-cta'));
  explore.click(); assert.equal(closed, 3, 'the panel closes'); assert.deepEqual(explored, ['p'], 'and AI explore opens for this topic');
});
integrationTest('name dialog ignores Enter while composing, explains an empty name, and keeps buttons in the action bar', () => {
  const element = (tag, options = {}) => ({
    tag, type: options.type, text: options.text, value: options.value ?? '', cls: options.cls ?? '', attr: options.attr ?? {}, children: [], disabled: false,
    createDiv(value) { const child = element('div', typeof value === 'string' ? { cls: value } : value); this.children.push(child); return child; },
    createEl(name, value) { const child = element(name, value); this.children.push(child); return child; },
    createSpan(value) { const child = element('span', value); this.children.push(child); return child; },
    addClass(name) { this.cls = `${this.cls} ${name}`.trim(); }, setText(value) { this.text = value; }, setAttr(name, value) { this.attr[name] = value; },
    addEventListener(name, handler) { this[name] = handler; }, focus() {}, select() {}
  });
  const all = (root, predicate) => [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))];
  const find = (root, predicate) => all(root, predicate)[0];
  class Modal { constructor() { this.titleEl = element('title'); this.contentEl = element('content'); this.modalEl = element('modal'); this.modalEl.children.push(this.contentEl); } close() { this.closed = true; } }
  const { NameModal } = load('ui/modals/name-modal.ts', { obsidian: { ...obsidian, Modal } });
  const saved = [];
  const modal = new NameModal({}, 'New topic name', 'Heat', value => saved.push(value));
  modal.onOpen();
  const input = find(modal.contentEl, item => item.tag === 'input');
  const save = find(modal.modalEl, item => item.tag === 'button' && item.text === 'Save');
  const status = find(modal.modalEl, item => item.cls.includes('vam-next-status'));
  const press = init => { const event = { ...init, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } }; input.keydown(event); return event; };
  input.value = '溫度'; assert.equal(press({ key: 'Enter', isComposing: true }).defaultPrevented, false, 'composing Enter is left alone');
  assert.deepEqual(saved, []); assert.notEqual(modal.closed, true);
  input.value = '   '; input.input();
  assert.equal(save.disabled, true); assert.match(status.text, /Enter a name/);
  input.value = '溫度'; input.input();
  assert.equal(save.disabled, false); assert.equal(status.text, '');
  const enter = press({ key: 'Enter', isComposing: false });
  assert.equal(enter.defaultPrevented, true, 'Enter is default-prevented so its keypress/keyup cannot re-click the opener');
  assert.equal(enter.stopped, true);
  assert.deepEqual(saved, ['溫度']); assert.equal(modal.closed, true);
  // Saving by the button is unchanged.
  const again = new NameModal({}, 'New topic name', 'Heat', value => saved.push(value)); again.onOpen();
  const button = find(again.modalEl, item => item.tag === 'button' && item.text === 'Save');
  button.click?.(); 
  assert.deepEqual(saved, ['溫度', 'Heat'], 'click on Save submits the initial value');
});
integrationTest('choice dialog marks destructive choices and starts on Cancel; map conflict explains each choice and keeps merge errors inline', () => {
  const element = (tag, options = {}) => ({
    tag, text: options.text, value: options.value ?? options.text ?? '', cls: options.cls ?? '', attr: options.attr ?? {}, children: [], hidden: false, open: false,
    createDiv(value) { const child = element('div', typeof value === 'string' ? { cls: value } : value); this.children.push(child); return child; },
    createEl(name, value) { const child = element(name, value); this.children.push(child); return child; },
    createSpan(value) { const child = element('span', value); this.children.push(child); return child; },
    addClass(name) { this.cls = `${this.cls} ${name}`.trim(); }, setText(value) { this.text = value; }, setAttr(name, value) { this.attr[name] = value; },
    addEventListener(name, handler) { this[name] = handler; }, focus() { this.focused = true; }
  });
  const all = (root, predicate) => [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))];
  const find = (root, predicate) => all(root, predicate)[0];
  class Modal { constructor() { this.titleEl = element('title'); this.contentEl = element('content'); this.modalEl = element('modal'); this.modalEl.children.push(this.contentEl); } close() { this.closed = true; this.onClose?.(); } }
  const buttons = [];
  class Setting { constructor() {} setName() { return this; } setDesc() { return this; } addButton(fn) { const b = { setButtonText(v) { this.text = v; return this; }, onClick(h) { this.click = h; return this; }, setDestructive() { this.destructive = true; return this; } }; fn(b); buttons.push(b); return this; } }
  const { ChoiceModal } = load('ui/modals/choice-modal.ts', { obsidian: { ...obsidian, Modal, Setting } });
  let ran = 0;
  const choice = new ChoiceModal({}, 'Remove from map', 'Notes move to Unassigned.', [{ label: 'Remove entire branch', warning: true, action: () => { ran++; } }, { label: 'Keep', action: () => {} }]);
  choice.onOpen();
  assert.deepEqual(buttons.map(b => [b.text, !!b.destructive]), [['Remove entire branch', true], ['Keep', false]]);
  // Every destructive caller in the map view passes warning: true, including deleting the map.
  const viewSource = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(viewSource, /buttonLabel: t\("ui\.move_to_trash"\),\s*warning: true/);
  const cancel = find(choice.modalEl, item => item.cls === 'vam-next-actions').children[0];
  assert.equal(cancel.text, 'Cancel'); assert.equal(cancel.focused, true);
  buttons[0].click(); assert.equal(ran, 1); assert.equal(choice.closed, true);
  const { MapConflictModal } = load('experiences/visual-map/modals.ts', { obsidian: { ...obsidian, Modal, Setting } });
  const disk = { version: 1, id: 'm', title: 'Disk', nodes: [] }, local = { version: 1, id: 'm', title: 'Local', nodes: [] };
  const resolved = [];
  const conflict = new MapConflictModal({}, local, disk, map => resolved.push(map.title));
  conflict.onOpen();
  const options = all(conflict.contentEl, item => item.cls === 'vam-conflict-option');
  assert.equal(options.length, 2);
  assert.ok(find(options[0], item => /on disk/.test(item.text ?? ''))); assert.ok(find(options[1], item => /overwrites/.test(item.text ?? '')));
  const actions = find(conflict.modalEl, item => item.cls === 'vam-next-actions');
  const status = find(actions, item => item.cls.includes('vam-next-status'));
  assert.match(status.text, /Closing this window uses the file/);
  const merged = find(actions, item => item.tag === 'button');
  assert.equal(merged.hidden, true);
  const details = find(conflict.contentEl, item => item.cls === 'vam-conflict-merge'); details.open = true; details.toggle();
  assert.equal(merged.hidden, false);
  find(details, item => item.tag === 'textarea').value = '{ not json';
  merged.click();
  assert.notEqual(conflict.closed, true); assert.match(status.text, /Invalid merged contents|merged/i);
  find(options[1], item => item.tag === 'button').click();
  assert.deepEqual(resolved, ['Local']);
});
integrationTest('proposal list links checks and parents at any depth', () => {
  const element = (tag, options = {}) => ({
    tag, type: options.type, text: options.text, value: options.value ?? options.text ?? '', cls: options.cls ?? '', attr: options.attr ?? {}, children: [], hidden: false, disabled: false, checked: false,
    createDiv(value) { const child = element('div', typeof value === 'string' ? { cls: value } : value); this.children.push(child); return child; },
    createEl(name, value) { const child = element(name, value); this.children.push(child); return child; },
    createSpan(value) { const child = element('span', value); this.children.push(child); return child; },
    addClass(name) { this.cls = `${this.cls} ${name}`.trim(); }, setText(value) { this.text = value; }, setAttr(name, value) { this.attr[name] = value; },
    addEventListener(name, handler) { this[name] = handler; }
  });
  const all = (root, predicate) => [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))];
  const { renderProposalList } = load('experiences/visual-map/modals.ts', { obsidian });
  const parent = element('panel');
  const list = renderProposalList(parent, [
    { title: 'Heat', task: '', contribution: '', parentTitle: '' },
    { title: 'Pan', task: '', contribution: '', parentTitle: 'Heat' },
    { title: 'Iron pan', task: '', contribution: '', parentTitle: 'Pan' }
  ], () => {});
  const checks = all(parent, item => item.type === 'checkbox');
  checks[0].checked = false; checks[0].change();
  assert.deepEqual(checks.map(c => c.checked), [false, false, false]);
  checks[2].checked = true; checks[2].change();
  assert.deepEqual(checks.map(c => c.checked), [true, true, true]);
  const picked = list.selected();
  assert.equal(JSON.stringify(picked.map(item => [item.title, item.parentTitle])), JSON.stringify([['Heat', ''], ['Pan', 'Heat'], ['Iron pan', 'Pan']]));
});

// A small fake DOM that keeps classes, attributes, tabIndex, handlers and focus calls so selection can be asserted per card.
const selectionDom = () => {
  const make = (tag, init = {}) => {
    const el = { tag, children: [], dataset: {}, style: {}, attrs: {}, handlers: new Map(), classes: new Set(String(init.cls ?? '').split(' ').filter(Boolean)), text: init.text, tabIndex: init.tabIndex, checked: false, focused: 0, isConnected: true,
      createDiv(value) { return this.createEl('div', typeof value === 'string' ? { cls: value } : value); },
      createSpan(value) { return this.createEl('span', typeof value === 'string' ? { cls: value } : value); },
      createEl(name, value = {}) { const child = make(name, value); child.parent = this; this.children.push(child); return child; },
      setAttr(name, value) { this.attrs[name] = value; }, addClass(...names) { names.forEach(name => this.classes.add(name)); }, removeClass(name) { this.classes.delete(name); },
      toggleClass(name, on) { if (on) this.classes.add(name); else this.classes.delete(name); }, addEventListener(name, handler) { this.handlers.set(name, handler); }, removeEventListener() {},
      setPointerCapture() {}, focus() { this.focused++; }, remove() { this.removed = true; }, getBoundingClientRect() { return { left: 0, right: 10, top: 0, bottom: 10 }; },
      querySelector() { return null; }, querySelectorAll() { return []; }, replaceWith() {} };
    return el;
  };
  return make;
};
const selectionView = (load, extra = {}, shim = obsidian) => {
  const { VisualAgentMapView } = load('main.ts', { obsidian: shim });
  const root = node('root'), a = node('a', 'root'), b = node('b', 'root'), c = node('c', 'a');
  root.x = 0; a.x = 400; a.y = 0; b.x = 400; b.y = 200; c.x = 800;
  const doc = map([root, a, b, c]);
  const outline = [];
  const plugin = { settings: { ...DEFAULT_SETTINGS }, pendingSuggestions: new Map(), expansionBatches: new Map(), detailsShown: () => false, setOutlineActive: path => outline.push(path), ...extra };
  const view = new VisualAgentMapView({ app: {} }, plugin);
  const make = selectionDom();
  view.stageEl = make('stage'); view.map = doc;
  view.notes = new Map(doc.nodes.map(item => [item.id, { title: item.id, summary: '', status: 'completed' }]));
  let renders = 0; view.render = () => { renders++; };
  view.enqueue = work => work(); view.openDetails = () => {}; view.focusNode = () => {};
  return { view, doc, outline, renders: () => renders, cards: () => Object.fromEntries(view.stageEl.children.map(card => [card.dataset.nodeId, card])), build: () => { view.cardEls.clear(); view.stageEl.children = []; view.selection.moveTabStop(view.defaultTabStop(doc.nodes)); for (const item of doc.nodes) view.renderNode(item); } };
};
// Replaces the view's menu with a recorder; the returned function clicks a button and gives back the entries it listed.
const recordMenus = view => {
  view.newMenu = () => { const entries = []; const menu = { entries, addItem(build) { const it = {}; const chain = { setTitle(t) { it.title = t; return chain; }, setIcon() { return chain; }, setDisabled(v) { it.disabled = v; return chain; }, setChecked() { return chain; }, onClick(fn) { it.fn = fn; return chain; } }; build(chain); entries.push(it); return menu; }, addSeparator() { return menu; }, showAtMouseEvent() { view.lastMenu = menu; } }; return menu; };
  return button => { view.lastMenu = null; button.handlers.get('click')({ stopPropagation() {} }); return view.lastMenu?.entries ?? []; };
};
integrationTest('selection, arrow keys and select-mode toggles repaint only the affected cards and never render', () => {
  const fixture = selectionView(load);
  const { view, outline } = fixture;
  fixture.build();
  const cards = fixture.cards();
  const stops = () => Object.entries(fixture.cards()).filter(([, card]) => card.tabIndex === 0).map(([id]) => id);
  const click = id => cards[id].handlers.get('click')({ target: { closest: () => null }, metaKey: false, ctrlKey: false });
  assert.deepEqual(stops(), ['root'], 'one roving tab stop before any selection');
  assert.equal(cards.root.attrs.role, 'treeitem'); assert.equal(cards.root.attrs['aria-level'], '1');
  assert.equal(cards.c.attrs['aria-level'], '3'); assert.equal(cards.a.attrs['aria-level'], '2');
  click('a');
  assert.equal(fixture.renders(), 0); assert.equal(view.selection.state.selected, 'a');
  assert.deepEqual(stops(), ['a']);
  assert.equal(cards.a.attrs['aria-selected'], 'true'); assert.ok(cards.a.classes.has('is-selected'));
  assert.equal(cards.root.attrs['aria-selected'], 'false'); assert.equal(cards.root.tabIndex, -1);
  assert.deepEqual(outline.at(-1), 'a.md');
  // Arrow keys walk the tree and move focus without a render.
  cards.a.handlers.get('keydown')({ key: 'ArrowDown', target: cards.a, preventDefault() {} });
  assert.equal(view.selection.state.selected, 'b'); assert.equal(cards.b.focused, 1); assert.deepEqual(stops(), ['b']);
  assert.equal(cards.a.classes.has('is-selected'), false);
  cards.b.handlers.get('keydown')({ key: 'ArrowLeft', target: cards.b, preventDefault() {} });
  assert.equal(view.selection.state.selected, 'root'); assert.deepEqual(stops(), ['root']);
  assert.equal(fixture.renders(), 0, 'selection and arrow keys never call render()');
});
integrationTest('persona 11: Alt+arrow on a focused card reorders it among its siblings; plain arrows still walk, and Alt does nothing in select mode', () => {
  const fixture = selectionView(load); const { view } = fixture; fixture.build(); let cards = fixture.cards();
  const calls = []; view.enqueue = fn => fn(); view.shiftSiblingByKey = (node, offset) => { calls.push([node.id, offset]); };
  const press = (id, init) => { const event = { target: cards[id], preventDefault() { this.prevented = true; }, ...init }; cards[id].handlers.get('keydown')(event); return event; };
  assert.equal(press('a', { key: 'ArrowDown', altKey: true }).prevented, true);
  press('b', { key: 'ArrowUp', altKey: true }); press('a', { key: 'ArrowRight', altKey: true });
  assert.deepEqual(calls, [['a', 1], ['b', -1], ['a', 1]]);
  press('a', { key: 'ArrowDown', altKey: true, ctrlKey: true }); press('a', { key: 'ArrowDown' });
  assert.equal(calls.length, 3, 'only Alt alone reorders'); assert.equal(view.selection.state.selected, 'b', 'plain ArrowDown still walks the tree');
  view.selection.toggleMultiSelect(); fixture.build(); cards = fixture.cards();
  press('b', { key: 'ArrowDown', altKey: true });
  assert.equal(calls.length, 3, 'select mode: no reordering');
});
integrationTest('select mode: the narrow bar names Merge / Research by count, keeps More for the rest and announces the topic count to screen readers', () => {
  const fixture = selectionView(load); const { view } = fixture;
  view.selection.toggleMultiSelect(); fixture.build();
  const labels = ids => {
    view.applySelectionChange(view.selection.replaceMulti(ids));
    const bar = view.renderSelectionBar(selectionDom()('div'));
    return bar.children.filter(child => child.tag === 'button').map(button => [button.text, button.disabled, button.attrs['aria-label']]);
  };
  assert.deepEqual(labels([]), [], 'no card picked: the bar is empty');
  assert.deepEqual(labels(['a']).slice(0, 2), [['Merge', false, undefined], ['Research', false, 'Research 1 topic']]);
  assert.deepEqual(labels(['a', 'b', 'c']).slice(0, 2), [['Merge', false, 'Merge 3 topics'], ['Research', false, 'Research 3 topics']]);
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-TW', 'ui.synthesize_0_topics', 3), '整合 3 個議題'); assert.equal(translate('zh-TW', 'ui.research_0_topics', 3), '研究 3 個議題');
  // Everything the old panel had that the bar does not show is in More.
  view.applySelectionChange(view.selection.replaceMulti(['a', 'b', 'c']));
  const bar = view.renderSelectionBar(selectionDom()('div'));
  const entries = recordMenus(view)(bar.children.find(child => child.classes.has('vam-selection-more')));
  assert.deepEqual(entries.map(entry => entry.title), ['Synthesize 3 topics', 'Copy to…', 'Add frame', 'Add summary bracket', 'Lock from AI', 'Clear', 'Remove']);
  view.applySelectionChange(view.selection.replaceMulti(['a']));
  const single = recordMenus(view)(view.renderSelectionBar(selectionDom()('div')).children.find(child => child.classes.has('vam-selection-more')));
  assert.equal(single.find(entry => entry.title === 'Synthesize').disabled, true, 'integration needs two topics');
});
integrationTest('select mode toggles cards in place, keeps checkboxes out of the tab order and survives a full render', () => {
  const { view, renders, cards, build } = (() => { const fixture = selectionView(load); fixture.view.selection.toggleMultiSelect(); fixture.build(); return fixture; })();
  const byId = cards();
  const checks = view.cardChecks;
  assert.equal(checks.size, 4);
  for (const check of checks.values()) assert.equal(check.tabIndex, -1, 'no checkbox per card in the tab order');
  const click = id => byId[id].handlers.get('click')({ target: { closest: () => null }, metaKey: false, ctrlKey: false });
  click('a'); click('c');
  assert.deepEqual([...view.selection.state.multiSelected].sort(), ['a', 'c']);
  assert.equal(renders(), 0); assert.equal(checks.get('a').checked, true); assert.equal(byId.b.attrs['aria-selected'], 'false');
  assert.equal(byId.c.attrs['aria-selected'], 'true');
  click('a');
  assert.deepEqual([...view.selection.state.multiSelected], ['c']); assert.equal(checks.get('a').checked, false); assert.equal(byId.a.classes.has('is-selected'), false);
  // Keyboard focus in select mode moves the tab stop only; the ticked cards stay ticked.
  byId.c.handlers.get('keydown')({ key: 'ArrowLeft', target: byId.c, preventDefault() {} });
  assert.deepEqual([...view.selection.state.multiSelected], ['c']); assert.equal(byId.a.tabIndex, 0); assert.equal(byId.root.tabIndex, -1); assert.equal(byId.a.focused, 1);
  // A full render afterwards reproduces the same state from the model.
  build();
  const again = cards();
  assert.equal(again.c.classes.has('is-selected'), true); assert.equal(again.c.attrs['aria-selected'], 'true'); assert.equal(again.a.classes.has('is-selected'), false);
  assert.equal(renders(), 0);
});
integrationTest('F2 starts the in-place title edit, Enter opens details, and the collapse button reports aria-expanded', () => {
  const dialogs = [];
  class Modal { open() { dialogs.push(this); } close() {} }
  const fixture = selectionView(load, {}, { ...obsidian, Modal });
  const { view } = fixture;
  const opened = [];
  view.openDetails = topic => opened.push(topic.id);
  fixture.build();
  const cards = fixture.cards();
  cards.a.handlers.get('keydown')({ key: 'Enter', target: cards.a, preventDefault() {} });
  assert.deepEqual(opened, ['a']); assert.equal(view.selection.state.selected, 'a'); assert.equal(fixture.renders(), 0);
  let renamed = 0;
  cards.a.handlers.get('keydown')({ key: 'F2', target: cards.a, preventDefault() { renamed++; } });
  assert.equal(renamed, 1, 'F2 is handled as the rename shortcut'); assert.equal(dialogs.length, 0, 'F2 opens no name dialog'); assert.equal(view.inlineName?.id, 'a', 'F2 opens the title field of the card');
  assert.equal(fixture.renders(), 1, 'one repaint draws the field');
  const expanded = [];
  const walk = item => { if (item.attrs && 'aria-expanded' in item.attrs) expanded.push(item.attrs['aria-expanded']); item.children.forEach(walk); };
  walk(cards.root); assert.deepEqual(expanded, [], 'an expanded branch has no floating collapse button: Collapse is in More; only the folded Expand button reports aria-expanded');
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(source, /stageEl\.setAttr\("role", "tree"\)/); assert.match(source, /integrate\.setAttr\("aria-pressed"/);
});
integrationTest('outline setActive marks the row in place with aria-current and no re-render', () => {
  const { OutlineView } = load('ui/outline-view.ts', { obsidian });
  const view = new OutlineView({ app: {} }, async () => {});
  const row = path => ({ path, classes: new Set(), attrs: new Map(), getAttribute(name) { return name === 'data-path' ? path : null; }, toggleClass(name, on) { if (on) this.classes.add(name); else this.classes.delete(name); }, setAttr(name, value) { this.attrs.set(name, value); }, removeAttribute(name) { this.attrs.delete(name); } });
  const rows = [row('a.md'), row('b.md')];
  let renders = 0; view.render = () => { renders++; };
  view.contentEl = { querySelectorAll: () => rows };
  view.setActive('b.md');
  assert.equal(renders, 0); assert.equal(rows[1].classes.has('is-active'), true); assert.equal(rows[1].attrs.get('aria-current'), 'true');
  view.setActive('a.md');
  assert.equal(rows[1].classes.has('is-active'), false); assert.equal(rows[1].attrs.has('aria-current'), false); assert.equal(rows[0].attrs.get('aria-current'), 'true');
});
const viewportFixture = () => {
  const frames = [], cancelled = [];
  const windowValues = { setTimeout: run => { run(); return 1; }, clearTimeout() {}, requestAnimationFrame: run => { frames.push(run); return frames.length; }, cancelAnimationFrame: id => { cancelled.push(id); } };
  const { default: Plugin, VisualAgentMapView } = load('main.ts', { obsidian }, windowValues);
  const counts = { updateMap: 0, readMap: 0, readNote: 0 };
  const a = node('a'), b = node('b', 'a');
  const doc = map([a, b]);
  const note = { title: 'T', summary: '', status: 'completed' };
  const repo = { coordinatesChangedOutside: async () => false, updateMap: async (_path, change) => { counts.updateMap++; change(doc); }, readMap: async () => { counts.readMap++; return JSON.parse(JSON.stringify(doc)); }, readNote: async () => { counts.readNote++; return { ...note }; } };
  const plugin = Object.create(Plugin.prototype);
  Object.assign(plugin, { queue: Promise.resolve(), writing: 0, logs: { appendLog() {} }, repo, settings: { ...DEFAULT_SETTINGS }, expansionBatches: new Map(), pendingSuggestions: new Map(), syncOutline() {}, releaseOutline() {}, detailsShown: () => false, setOutlineActive() {} });
  const app = { vault: { getAbstractFileByPath: () => new obsidian.TFile('m/Map.md') } };
  const view = new VisualAgentMapView({ app }, plugin);
  view.app = app; view.path = 'm/Map.md'; view.map = doc; view.render = () => {};
  view.notes = new Map([[a.id, { ...note }], [b.id, { ...note }]]);
  plugin.views = () => [view];
  return { plugin, view, counts, doc, frames, cancelled, a, b, windowValues, load: () => ({ VisualAgentMapView }) };
};
integrationTest('canvas hint: selecting a card (click or arrow-key focus) and using a zoom-control button dismiss it; the zoom maths itself does not', () => {
  const { plugin, view, a } = viewportFixture();
  let saves = 0; plugin.saveSettings = async () => { saves++; };
  const hint = { removed: 0, remove() { this.removed++; } };
  view.hintEl = hint;
  view.applySelectionChange = () => {};
  view.selection = { state: { multiSelectMode: false }, selectIfChanged: () => ({}) };
  view.selectMapNode(a);
  assert.equal(plugin.settings.canvasHintSeen, true, 'selecting a card marks the hint seen');
  assert.equal(hint.removed, 1); assert.equal(view.hintEl, null); assert.equal(saves, 1);
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  for (const label of ['zoom_out', 'zoom_in', 'show_all'])
    assert.match(source, new RegExp(`t\\("ui\\.${label}"\\), \\(\\) => \\{\\s*this\\.markCanvasHintSeen\\(\\);`), `${label} button marks the hint seen`);
  assert.match(source, /event\.stopPropagation\(\);\s*this\.markCanvasHintSeen\(\);\s*if \(this\.map\) this\.resetZoom\(\);/, 'the percentage button counts');
  assert.match(source, /private selectMapNode\(node: MapNode\): void \{\s*\/\/[^\n]*\n\s*if \(this\.hintEl\) this\.markCanvasHintSeen\(\);/);
});
integrationTest('canvas hint: a solid chip that goes away after the first zoom or pan and remembers it in settings; select mode keeps its hint inside the selection bar', () => {
  const { plugin, view } = viewportFixture();
  let saves = 0; plugin.saveSettings = async () => { saves++; };
  view.viewportEl = { clientWidth: 800, clientHeight: 600 }; view.transform = () => {}; view.saveViewport = () => {};
  const hint = { removed: 0, remove() { this.removed++; } };
  view.hintEl = hint;
  view.zoomBy(1.2);
  assert.equal(plugin.settings.canvasHintSeen, false, 'a zoom button does not dismiss the hint that teaches drag and wheel'); assert.equal(hint.removed, 0);
  view.markCanvasHintSeen();
  view.markCanvasHintSeen();
  assert.equal(saves, 1, 'only the first gesture writes settings');
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(source, /!this\.selection\.state\.multiSelectMode && !this\.plugin\.settings\.canvasHintSeen\s*\?\s*overlay\.createSpan\(\{\s*cls: "vam-hint vam-canvas-hint"/, 'the normal hint shows only until seen; select mode draws none (the selection bar owns that corner)');
  assert.match(source, /if \(moved\) this\.markCanvasHintSeen\(\);/, 'a pan counts');
  assert.match(source, /event\.preventDefault\(\);\s*\/\/[^\n]*\n\s*this\.markCanvasHintSeen\(\);/, 'a wheel zoom counts');
  assert.match(fs.readFileSync(path.join(root, 'main.ts'), 'utf8'), /canvasHintSeen: saved\?\.canvasHintSeen === true/);
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(css, /^\.vam-canvas-overlay > \.vam-canvas-hint \{ position: absolute;[^}]*border: 1px solid var\(--background-modifier-border\);[^}]*background: var\(--background-primary\);/m, 'a solid chip with a border');
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-TW', 'ui.drag_empty_space_to_pan_scroll_to_zoom_click_a_node_to_open'), '拖曳空白處平移 · Shift＋拖曳框選 · 滾輪縮放 · 方向鍵切換議題');
  assert.equal(translate('zh-TW', 'ui.drag_to_select_topics_hint'), '拖曳框選 · 按住 Option 拖曳減選 · 按住空白鍵拖曳或用中鍵平移 · 點議題加入或移除');
});
integrationTest('a viewport-only write skips the note re-read, while a content write still synchronizes', async () => {
  const { plugin, view, counts } = viewportFixture();
  view.map.viewport.x = 40;
  view.saveViewport();
  await plugin.queue;
  assert.equal(counts.updateMap, 1, 'the viewport is written');
  assert.equal(counts.readNote, 0, 'no note is read'); assert.equal(counts.readMap, 0, 'the map is not re-read either');
  await plugin.mutate(async () => {});
  assert.equal(counts.readNote, 2, 'a content write re-reads every note'); assert.equal(counts.readMap, 1);
});
integrationTest('write queue keeps order: a content write interleaved with viewport writes still synchronizes and none is lost', async () => {
  const { plugin, counts } = viewportFixture();
  const order = [];
  const first = plugin.mutate(async () => { order.push('viewport 1'); }, { sync: false });
  const content = plugin.mutate(async () => { order.push('content'); });
  const second = plugin.mutate(async () => { order.push('viewport 2'); }, { sync: false });
  await Promise.all([first, content, second]);
  assert.deepEqual(order, ['viewport 1', 'content', 'viewport 2']);
  assert.equal(counts.readMap, 1, 'only the content write synchronized'); assert.equal(counts.readNote, 2);
  await plugin.mutate(async () => { throw new Error('failed'); }, { sync: false }).catch(() => {});
  await plugin.mutate(async () => { order.push('after failure'); });
  assert.equal(order.at(-1), 'after failure', 'a failed viewport write does not block later writes');
});
integrationTest('viewport saves coalesce into one queued write that reads the latest viewport and flushes on close', async () => {
  const { plugin, view, counts, doc } = viewportFixture();
  let release; const gate = new Promise(resolve => { release = resolve; });
  plugin.queue = gate;
  const queued = [];
  const original = plugin.mutate.bind(plugin);
  plugin.mutate = (work, options) => { queued.push(options); return original(work, options); };
  view.map.viewport.x = 1; view.saveViewport(); view.map.viewport.x = 2; view.saveViewport(); view.map.viewport.x = 3; view.saveViewport();
  assert.equal(queued.length, 1, 'three saves while one is waiting make a single write'); assert.deepEqual(plain(queued[0]), { sync: false });
  release(); await plugin.queue; await plugin.queue;
  assert.equal(counts.updateMap, 1); assert.equal(doc.viewport.x, 3, 'the write carries the newest viewport');
  view.map.viewport.x = 9; view.saveViewport(); await plugin.queue;
  assert.equal(queued.length, 2, 'a later save queues a new write'); assert.equal(counts.updateMap, 2);
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(source, /async onClose\(\)[\s\S]*persistViewport\(\)/, 'closing flushes a pending viewport save');
});
const dragFixture = () => {
  const fixture = viewportFixture();
  const { view, a, b, doc, frames } = fixture;
  const make = selectionDom();
  const parentCard = make('div'), childCard = make('div');
  Object.assign(parentCard, { offsetLeft: 0, offsetTop: 0, offsetWidth: 280, offsetHeight: 100 }); Object.assign(childCard, { offsetLeft: 400, offsetTop: 0, offsetWidth: 280, offsetHeight: 100 });
  const other = node('c'); other.x = 0; other.y = 300; doc.nodes.push(other);
  const otherCard = make('div'); Object.assign(otherCard, { offsetLeft: 0, offsetTop: 300, offsetWidth: 280, offsetHeight: 100 });
  const edgeOf = () => { const attrs = []; return { attrs, setAttribute(name, value) { attrs.push([name, value]); } }; };
  const near = edgeOf(), far = edgeOf();
  view.cardEls = new Map([[a.id, parentCard], [b.id, childCard], [other.id, otherCard]]);
  view.edgeEls = new Map([[`${a.id}\u0000${b.id}`, near], [`${other.id}\u0000${other.id}`, far]]);
  view.enqueue = work => work(); view.mapChange = async () => {};
  const events = new Map();
  childCard.addEventListener = (name, handler) => events.set(name, handler); childCard.removeEventListener = name => events.delete(name);
  childCard.setPointerCapture = () => {};
  view.enableDrag(childCard, b);
  const down = () => events.get('pointerdown')({ target: { closest: () => null }, button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  return { ...fixture, events, childCard, near, far, down };
};
integrationTest('dragging repaints only the edges touching the card, batched in one animation frame', () => {
  const { view, events, childCard, near, far, down, frames } = dragFixture();
  down();
  assert.equal(view.dragging, true);
  events.get('pointermove')({ clientX: 50, clientY: 20 }); events.get('pointermove')({ clientX: 60, clientY: 30 }); events.get('pointermove')({ clientX: 70, clientY: 40 });
  assert.equal(frames.length, 1, 'three pointer moves share one frame'); assert.equal(near.attrs.length, 0, 'nothing is painted before the frame');
  frames[0]();
  assert.equal(near.attrs.length, 1); assert.equal(far.attrs.length, 0, 'an edge that does not touch the card is not changed');
  assert.equal(near.attrs[0][1], 'M 280 50 C 385 50, -35 90, 70 90', 'the edge ends at the card\'s new left edge'); assert.equal(childCard.style.left, '70px'); assert.equal(childCard.style.top, '40px');
  events.get('pointerup')({ type: 'pointerup' });
  assert.equal(view.dragging, false); assert.equal(events.has('pointermove'), false, 'listeners are removed');
});
integrationTest('AI merge shows on the cards ("Merging…" chip, running frame) and in the status bar with Stop, and clears with the task', () => {
  const fixture = selectionView(load); const { view } = fixture;
  const task = { mapPath: view.path, mapId: 'm', mapTitle: 'M', title: 'T', sources: [{ id: 'a', path: 'a.md' }, { id: 'b', path: 'b.md' }], parentId: 'root', targetId: null, model: 'x', sourceContent: '', controller: new AbortController(), state: 'running', progress: '' };
  const chips = card => { const all = el => [el, ...el.children.flatMap(all)]; return all(card).filter(e => e.classes?.has('vam-status')).map(e => e.text); };
  fixture.build(); let cards = fixture.cards();
  assert.deepEqual(chips(cards.a), ['Researched']); assert.notEqual(cards.a.dataset.status, 'running');
  view.mergeTasks.set(view.path, task); fixture.build(); cards = fixture.cards();
  for (const id of ['a', 'b']) { assert.deepEqual(chips(cards[id]), ['Merging…'], `${id} is marked`); assert.equal(cards[id].dataset.status, 'running'); }
  for (const id of ['root', 'c']) { assert.equal(chips(cards[id]).includes('Merging…'), false, `${id} is not`); assert.notEqual(cards[id].dataset.status, 'running'); }
  const make = selectionDom(); const bar = () => { const parent = make('div'); view.renderBackgroundBars(parent); return parent; };
  const all = el => [el, ...el.children.flatMap(all)];
  let texts = all(bar()).map(e => e.text).filter(Boolean);
  assert.ok(texts.includes('Merging:')); assert.ok(texts.includes('a, b'), 'the topic names'); assert.ok(texts.includes('Stop merge'));
  task.state = 'applying'; texts = all(bar()).map(e => e.text).filter(Boolean);
  assert.ok(texts.includes('Merging:')); assert.equal(texts.includes('Stop merge'), false, 'no Stop once the result is being written');
  const stop = (task.state = 'running', all(bar()).find(e => e.tag === 'button' && e.text === 'Stop merge')); stop.handlers.get('click')();
  assert.equal(view.mergeTasks.size, 0); assert.equal(task.controller.signal.aborted, true);
  fixture.build(); assert.deepEqual(chips(fixture.cards().a), ['Researched']); assert.equal(texts.length > 0 && all(bar()).some(e => e.text === 'Merging:'), false, 'the bar is gone');
});
integrationTest('AI merge lock: a merging card cannot be dragged; other cards still can', () => {
  for (const [merging, expected] of [[true, 0], [false, 1]]) {
    const { view, b, events, down, frames } = dragFixture();
    if (merging) view.mergeTasks.set(view.path, { mapPath: view.path, sources: [{ id: b.id, path: b.path }], controller: new AbortController(), state: 'running' });
    const changes = []; view.mapChange = async change => { changes.push(change); };
    down(); events.get('pointermove')({ clientX: 50, clientY: 20 });
    assert.equal(frames.length, expected, merging ? 'the card does not follow the pointer' : 'the card moves');
    events.get('pointerup')({ type: 'pointerup' });
    assert.equal(changes.length, expected, merging ? 'no position is saved' : 'the position is saved');
  }
});
integrationTest('lostpointercapture, pointercancel, a render mid-drag and closing the view all end the drag and drop the pending frame', async () => {
  for (const ending of ['lostpointercapture', 'pointercancel']) {
    const { view, events, childCard, near, down, frames, cancelled } = dragFixture();
    down(); events.get('pointermove')({ clientX: 50, clientY: 50 });
    assert.equal(view.dragging, true); assert.equal(frames.length, 1);
    events.get(ending)({ type: ending });
    assert.equal(view.dragging, false, `${ending} ends the drag`); assert.deepEqual(cancelled, [1], 'the pending frame is cancelled');
    assert.equal(childCard.style.left, '0px', 'the card goes back to where it started');
    assert.deepEqual([...events.keys()], ['pointerdown'], 'only the permanent pointerdown listener remains');
  }
  { const { view, events, down, frames, cancelled } = dragFixture();
    down(); events.get('pointermove')({ clientX: 50, clientY: 50 });
    view.render = Object.getPrototypeOf(view).render; view.closed = true;
    view.render();
    assert.equal(view.dragging, false, 'a render mid-drag cannot leave dragging stuck'); assert.deepEqual(cancelled, [1]); assert.deepEqual([...events.keys()], ['pointerdown']); void frames; }
  { const { view, events, down, cancelled } = dragFixture();
    down(); events.get('pointermove')({ clientX: 50, clientY: 50 });
    view.render = Object.getPrototypeOf(view).render;
    await view.onClose();
    assert.equal(view.dragging, false); assert.deepEqual(cancelled, [1], 'closing the view cancels the pending frame'); }
});
integrationTest('N4: startup opens no topic outline; first install opens only its blank map, while the outline command stays', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  for (const firstInstall of [false, true]) {
    const plugin = Object.create(Plugin.prototype), calls = [];
    Object.assign(plugin, { app: { workspace: { getLeavesOfType: () => [] } }, ready: Promise.resolve(), workspaceRecoveryCandidates: [], firstInstallMapPath: firstInstall ? 'Agent Workspace/Mind Maps/New mind map/Map.md' : null,
      activateView: async path => { calls.push(['view', path]); }, activateOutline: async () => { calls.push('outline'); }, styleNodeLeaf() {}, logs: { appendLog() {} } });
    await plugin.finishStartup();
    assert.deepEqual(calls, firstInstall ? [['view', 'Agent Workspace/Mind Maps/New mind map/Map.md']] : [], 'at most the first-install map opens, never the outline');
  }
  assert.match(fs.readFileSync(path.join(root, 'main.ts'), 'utf8'), /addLocalizedCommand\("open-topic-outline"/);
});
const outlineFixture = () => {
  const { default: Plugin, VisualAgentMapView } = load('main.ts', { obsidian });
  const handlers = {}, titled = title => ({ ...map([node('a')]), title });
  const mapView = (plugin, title) => { const view = Object.create(VisualAgentMapView.prototype); Object.assign(view, { plugin, map: titled(title), notes: new Map() }); return view; };
  const plugin = Object.create(Plugin.prototype), state = { views: [], active: null };
  const leaf = { setViewState: async () => {} };
  Object.assign(plugin, { outlineTitles: new Map(), outlineSourceView: null, coffeeOutlineActive: false, coffeeOutlineSource: null, logs: { appendLog() {} },
    app: { workspace: { getLeavesOfType: type => type === 'visual-agent-map' ? state.views.map(view => ({ view })) : [], getActiveViewOfType: () => state.active, getLeftLeaf: () => leaf, revealLeaf: async () => {} } } });
  plugin.views = () => state.views;
  const a = mapView(plugin, 'Map A'), b = mapView(plugin, 'Map B');
  state.views = [a, b]; state.active = b;
  return { plugin, a, b, state, title: () => plugin.outlineMap?.title ?? null };
};
integrationTest('topic outline follows the active mind map: the header button and the command show the active map, not the first tab', async () => {
  const { plugin, a, b, title } = outlineFixture();
  await plugin.activateOutline();
  assert.equal(title(), 'Map B', 'no argument: the active map view');
  await plugin.activateOutline(a);
  assert.equal(title(), 'Map A', 'a header button passes its own view');
});
integrationTest('topic outline: a background map tab re-rendering does not overwrite the outline source', async () => {
  const { plugin, a, b, title } = outlineFixture();
  await plugin.activateOutline(b);
  a.syncOutline(); assert.equal(title(), 'Map B', 'map A is in the background');
  b.map = { ...b.map, title: 'Map B edited' }; b.syncOutline(); assert.equal(title(), 'Map B edited', 'the source still updates');
});
integrationTest('topic outline: switching to another map tab re-syncs the outline, and closing the source falls back', () => {
  const { plugin, a, b, state, title } = outlineFixture();
  plugin.styleNodeLeaf = () => {}; plugin.syncCoffeeOutline = () => {};
  plugin.useOutlineSource(a); assert.equal(title(), 'Map A');
  state.active = b; plugin.onActiveLeafChange({ view: b });
  assert.equal(title(), 'Map B', 'active-leaf-change to a map view makes it the source');
  state.views = [a]; plugin.releaseOutline(b);
  assert.equal(title(), 'Map A', 'closing the source falls back to the remaining map');
  state.views = []; plugin.releaseOutline(a);
  assert.equal(plugin.outlineMap, null, 'no map left: the outline empties');
});
integrationTest('card tools: only AI explore, Details and More float; More holds Collapse, This card and Select subtopics (the title is edited in place, so no Rename)', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  // The tools float over the card's top edge, hidden until hover, focus or selection, and take no space.
  assert.match(css, /^\.vam-node > \.vam-node-tools \{ position: absolute;[^}]*bottom: calc\(100% - 6px\);[^}]*opacity: 0; visibility: hidden;[^}]*width: max-content;/m);
  assert.match(css, /\.vam-node:hover > \.vam-node-tools, \.vam-node:focus-within > \.vam-node-tools, \.vam-viewport:not\(\.is-selecting\) \.vam-node\.is-selected > \.vam-node-tools \{ opacity: 1; visibility: visible;/);
  assert.equal(/vam-ai-slot|vam-ai-tool/.test(css), false, 'no selected-only swap remains');
  assert.match(css, /\.vam-node-tools > \.vam-ai-explore::before \{ content: "✦" \/ "";/, 'the sparkle is decoration, not part of the name');
  const toolsOf = (setup = () => {}) => {
    const fixture = selectionView(load);
    setup(fixture);
    fixture.build();
    const tools = fixture.cards().a.children.find(child => child.classes.has('vam-node-tools'));
    const buttons = tools.children.filter(child => child.tag === 'button');
    const open = recordMenus(fixture.view);
    const more = buttons.find(button => button.classes.has('vam-more-tool'));
    return Object.assign(buttons, { menu: more ? open(more).map(entry => entry.title) : [] });
  };
  const buttons = toolsOf();
  assert.deepEqual(buttons.map(button => button.text), ['AI explore', 'Details', '⋯ More'], 'three floating buttons');
  assert.deepEqual(buttons.menu, ['Collapse', 'This card', 'Select subtopics'], 'every other action is in More; Add text is only in the + menu');
  const explore = buttons[0];
  assert.ok(explore.classes.has('vam-ai-explore')); assert.equal(explore.attrs['aria-label'], undefined, 'the visible text is the accessible name (WCAG 2.5.3)');
  assert.equal(buttons.filter(button => button.classes.has('vam-ai-explore')).length, 1, 'one AI button');
  assert.equal(buttons[1].attrs['aria-label'], 'Open details in right sidebar');
  assert.equal(buttons[2].attrs['aria-label'], 'More actions for this topic'); assert.equal(buttons[2].attrs['aria-haspopup'], 'menu');
  // A leaf has no Collapse; select mode keeps Details and a More with only Collapse.
  const leaf = toolsOf(({ view }) => { view.map.nodes = view.map.nodes.filter(item => item.id !== 'c'); });
  assert.deepEqual(leaf.map(button => button.text), ['AI explore', 'Details', '⋯ More']); assert.deepEqual(leaf.menu, ['This card']);
  const selecting = toolsOf(({ view }) => { view.selection.toggleMultiSelect(); });
  assert.deepEqual(selecting.map(button => button.text), ['Details', '⋯ More']); assert.deepEqual(selecting.menu, ['Collapse']);
  const { translate } = load('i18n.ts');
  assert.deepEqual(['ui.collapse', 'ui.node_tool_links', 'ui.node_tool_details', 'ui.ai_explore'].map(key => translate('zh-TW', key)), ['收合', '這張卡', '詳情', 'AI 探索']);
});
integrationTest('status pill: researched topics show "Researched", unresearched ones show none, other states keep theirs and screen readers still hear the status', () => {
  const pills = (status, setup) => {
    const fixture = selectionView(load);
    fixture.view.notes.get('a').status = status;
    setup?.(fixture.view);
    fixture.build();
    const card = fixture.cards().a, found = [];
    const walk = item => { if (item.classes?.has('vam-status')) found.push(item); item.children.forEach(walk); };
    walk(card);
    return { found, card, label: fixture.view.stageEl.children.find(item => item.dataset.nodeId === 'a') };
  };
  const done = pills('completed');
  assert.deepEqual(done.found.map(item => [item.text, [...item.classes].sort().join(' ')]), [['Researched', 'vam-status vam-status-completed']], 'completed cards show the Researched pill');
  assert.equal(pills('idea').found.length, 0, 'unresearched cards have no pill');
  assert.equal(pills('idea').card.dataset.status, 'idea', 'the card still carries its status');
  assert.equal(pills('error').found.length, 1, 'error keeps its pill');
  const running = pills('idea', view => { view.plugin.topicRuns.isBusy = path => path === 'a.md'; });
  assert.deepEqual(running.found.map(item => item.text), ['AI running'], 'a running card keeps its pill');
  const labelled = selectionView(load); labelled.build();
  assert.ok(labelled.cards().a.attrs['aria-labelledby'], 'the card is still named');
  const nameOf = card => { const walk = item => (item.classes?.has('vam-card-label') ? item : item.children.map(walk).find(Boolean)); return walk(card)?.textContent; };
  assert.match(nameOf(done.card), /Researched/, 'the accessible name still carries the status');
});
integrationTest('the more-actions menu holds Organize notes and folders; toolbar keeps Select several topics; the zoom cluster Layout menu holds Auto layout', () => {
  const menus = [];
  const { view } = selectionView(load, {}, { ...obsidian, Menu: class Menu { constructor() { this.items = []; this.separators = []; menus.push(this); } addItem(cb) { const item = { setTitle(v) { this.title = v; return this; }, setIcon() { return this; }, setWarning(v) { this.warning = v; return this; }, onClick(fn) { this.click = fn; return this; } }; cb(item); this.items.push(item); return this; } addSeparator() { this.separators.push(this.items.length); return this; } showAtPosition(at) { this.at = at; return this; } showAtMouseEvent() { this.mouse = true; return this; } } });
  view.openMapActions();
  const labels = menus[0].items.map(item => item.title);
  assert.ok(labels.includes('Organize notes and folders'));
  const organize = menus[0].items.find(item => item.title === 'Organize notes and folders'); assert.equal(typeof organize.click, 'function');
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  const toolsBlock = source.slice(source.indexOf('const tools = createDiv("vam-map-tools")'), source.indexOf('const workspace = this.contentEl.createDiv("vam-workspace")'));
  assert.ok(!/ui\.organize|ui\.auto_layout/.test(toolsBlock), 'neither control stays in the floating tools');
  assert.match(source, /zoom\.createEl\("button", \{ text: t\("ui\.layout"\), cls: "vam-layout-button" \}\)/, 'the zoom cluster has one labelled Layout button');
  assert.ok(!/iconButton\(zoom, "(workflow|chevrons-down-up)"/.test(source), 'no icon-only layout controls remain');
  const { translate } = load('i18n.ts');
  assert.equal(translate('en', 'ui.select_topics'), 'Select several topics'); assert.equal(translate('zh-TW', 'ui.select_topics'), '選取多個議題');
  assert.equal(translate('en', 'ui.finish_topic_selection'), 'Done selecting'); assert.equal(translate('zh-TW', 'ui.finish_topic_selection'), '完成選取');
  assert.equal(translate('zh-TW', 'ui.organize'), '整理筆記與資料夾'); assert.equal(translate('zh-TW', 'ui.rename_topic'), '重新命名'); assert.equal(translate('zh-TW', 'ui.ai_explore'), 'AI 探索');
  assert.equal(translate('zh-TW', 'ui.new_map'), '＋ 新增心智圖');
});
integrationTest('C2: More mind map actions is an Obsidian menu under its button (no dialog), every entry a verb, Delete set apart as a warning; each entry runs its action', () => {
  const menus = [], dialogs = [];
  class Modal { open() { dialogs.push(this); } close() {} }
  const { view } = selectionView(load, {}, { ...obsidian, Modal, Menu: class Menu { constructor() { this.items = []; this.separators = []; menus.push(this); } addItem(cb) { const item = { setTitle(v) { this.title = v; return this; }, setIcon() { return this; }, setWarning(v) { this.warning = v; return this; }, onClick(fn) { this.click = fn; return this; } }; cb(item); this.items.push(item); return this; } addSeparator() { this.separators.push(this.items.length); return this; } showAtPosition(at) { this.at = at; return this; } showAtMouseEvent() { this.mouse = true; return this; } } });
  const ran = [];
  view.renameCurrentMap = () => ran.push('rename');
  view.deleteCurrentMap = () => ran.push('delete');
  view.openKeyboardShortcuts = () => ran.push('keys');
  view.enqueue = work => { ran.push('queued'); };
  const button = { getBoundingClientRect: () => ({ left: 40, bottom: 30, top: 10, right: 60 }) };
  view.openMapActions({ currentTarget: button, clientX: 0, clientY: 0 });
  assert.equal(dialogs.length, 0, 'no dialog opens');
  const menu = menus.at(-1);
  assert.deepEqual(plain(menu.at), { x: 40, y: 30 }, 'the menu sits under the button, also for a keyboard click');
  assert.deepEqual(menu.items.map(item => item.title), ['Rename current mind map', 'Organize notes and folders', 'Repair missing mind map', 'Keyboard shortcuts', 'Delete current mind map']);
  assert.deepEqual(menu.separators, [3, 4]);
  assert.equal(menu.items.at(-1).warning, true);
  for (const item of menu.items) item.click();
  assert.deepEqual(ran, ['rename', 'queued', 'queued', 'keys', 'delete']);
  const { translate } = load('i18n.ts');
  for (const language of ['zh-TW', 'zh-CN'])
    for (const key of ['ui.rename_current_mind_map', 'ui.organize', 'ui.repair_missing_mind_map', 'ui.delete_current_mind_map'])
      assert.match(translate(language, key), /^(重新命名|重命名|整理|修復|修复|刪除|删除)/, `${language} ${key} starts with a verb`);
});
integrationTest('UI wording: short research (subtopic research), not shallow research; the synthesis draft is reviewed (檢閱) everywhere', () => {
  const { translate } = load('i18n.ts');
  const source = require('../support.cjs').i18nSource();
  const values = [...source.matchAll(/^  "((?:ui|notice|modal|settings)\.[^"]+)": "((?:[^"\\]|\\.)*)"/gm)];
  assert.deepEqual(values.filter(([, , text]) => /淺研究|shallow research|檢查整合草稿/i.test(text)).map(([, key]) => key), []);
  assert.equal(translate('zh-TW', 'ui.review_synthesis_draft'), '檢閱整合草稿'); assert.equal(translate('zh-TW', 'ui.review_the_synthesis_draft'), '請檢閱整合草稿。');
  assert.equal(translate('zh-TW', 'ui.shallow_research_counts', 1, 3), '簡短研究：完成 1／3'); assert.equal(translate('en', 'ui.shallow_research_counts', 1, 3), 'Short research: 1 of 3 done');
});
integrationTest('map UI terms in zh-TW say 議題 and 心智圖, not 節點 or 地圖, and keep 工作區 consistent', () => {
  const { translate } = load('i18n.ts');
  const source = require('../support.cjs').i18nSource('zh-TW');
  const zh = source;
  const mapUi = [...zh.matchAll(/^  "(ui\.[^"]+)": "((?:[^"\\]|\\.)*)"/gm)].filter(([, key]) => !/aim_/.test(key));
  const drift = mapUi.filter(([, , text]) => /節點|地圖/.test(text)).map(([, key]) => key);
  assert.deepEqual(drift, [], 'no map UI string uses 節點 or 地圖');
  assert.equal(mapUi.filter(([, , text]) => /Workspace/.test(text.replace('Agent Workspace/', ''))).length, 0, 'prose says 工作區, not Workspace');
  assert.equal(translate('zh-TW', 'ui.reconnect_existing_workspace'), '找回既有工作區');
});
test('applyCollapseLevel: collapse all, expand all and expand to level N set the collapsed flag on branches only', () => {
  const nodes = () => [node('root'), node('a', 'root'), node('b', 'root'), node('a1', 'a'), node('a2', 'a'), node('a11', 'a1')];
  const flags = list => Object.fromEntries(list.map(item => [item.id, item.collapsed]));
  const collapsed = nodes(); core.applyCollapseLevel(collapsed, 0);
  assert.deepEqual(flags(collapsed), { root: true, a: true, b: false, a1: true, a2: false, a11: false }, 'every branch collapses; leaves stay as they were');
  core.applyCollapseLevel(collapsed, null);
  assert.deepEqual(Object.values(flags(collapsed)), [false, false, false, false, false, false]);
  for (const [level, expected] of [[1, { root: false, a: true, a1: true }], [2, { root: false, a: false, a1: true }], [3, { root: false, a: false, a1: false }]]) {
    const list = nodes(); core.applyCollapseLevel(list, level);
    const got = flags(list);
    for (const [id, collapsedFlag] of Object.entries(expected)) assert.equal(got[id], collapsedFlag, `level ${level}: ${id}`);
  }
  const cyclic = [node('x', 'y'), node('y', 'x')]; core.applyCollapseLevel(cyclic, 1);
  assert.equal(cyclic.length, 2, 'a corrupt parent cycle does not hang');
});
integrationTest('the New map menu no longer imports outlines; the toolbar has no topic menu; the palette command adds to the open map only', () => {
  const opened = [], menus = [];
  class Modal { constructor(app) { this.app = app; } open() { opened.push(this); } close() {} }
  class Menu { constructor() { this.items = []; menus.push(this); } addItem(callback) { const item = { title: '', icon: '', click: null, setTitle(value) { this.title = value; return this; }, setIcon(value) { this.icon = value; return this; }, onClick(handler) { this.click = handler; return this; } }; callback(item); this.items.push(item); return this; } showAtMouseEvent() { return this; } }
  const { view } = selectionView(load, {}, { ...obsidian, Modal, Menu });
  view.openNewMapMenu({});
  assert.deepEqual(menus[0].items.map(item => item.title), ['New mind map', 'New AIM'], 'the menu has no outline import');
  view.path = `${DEFAULT_SETTINGS.topicsFolder}/Topic/Map.md`;
  assert.equal(menus.length, 1, 'the toolbar has no topic menu any more; the palette command is the way to paste an outline');
  const placement = modal => modal.placementRequest();
  view.openOutlineImport();
  assert.deepEqual(plain(placement(opened.at(-1))), { kind: 'tree' }, 'no selection: add to the current map');
  view.selection.setSelected('a'); view.openOutlineImport();
  assert.deepEqual(plain(placement(opened.at(-1))), { kind: 'under', parentId: 'a' }, 'a selected topic: add under it');
  const count = opened.length;
  view.path = 'elsewhere/Map.md'; view.selection.setSelected(null); view.openOutlineImport();
  assert.equal(opened.length, count, 'no editable map open: no import window (a new map starts from + New mind map)');
  view.path = `${DEFAULT_SETTINGS.topicsFolder}/Topic/Map.md`; view.openOutlineImport();
  assert.deepEqual(plain(placement(opened.at(-1))), { kind: 'tree' }, 'the palette command adds to the open map');
});
integrationTest('collapse control: sets the flags, fits the map and is a single undo entry', async () => {
  const fixture = viewportFixture();
  const { view, plugin, doc, a, b } = fixture;
  const top = node('r'); const c = node('c', a.id);
  doc.nodes.length = 0; a.parentId = 'r'; b.parentId = 'a'; doc.nodes.push(top, a, b, c);
  let saved = 0; plugin.repo.saveMap = async (_path, next) => { saved++; Object.assign(doc, JSON.parse(JSON.stringify(next))); };
  plugin.mutate = async work => work();
  view.map = doc; view.enqueue = work => { view.pending = work(); }; view.updateHistoryButtons = () => {}; view.hydrate = async () => {};
  let fitted = 0; view.fit = () => { fitted++; };
  view.collapseTo(0); await view.pending;
  assert.deepEqual(doc.nodes.map(item => [item.id, !!item.collapsed]), [['r', true], ['a', true], ['b', false], ['c', false]]);
  assert.equal(fitted, 1); assert.equal(saved, 1, 'one write');
  view.collapseTo(null); await view.pending;
  assert.ok(doc.nodes.every(item => !item.collapsed)); assert.equal(fitted, 2);
  view.collapseTo(null); await view.pending;
  assert.equal(saved, 2, 'an unchanged request writes nothing but still fits'); assert.equal(fitted, 3);
  view.collapseTo(1); await view.pending;
  assert.equal(doc.nodes.find(item => item.id === 'a').collapsed, true); assert.equal(doc.nodes.find(item => item.id === 'r').collapsed, false);
  const at = id => doc.nodes.find(item => item.id === id);
  assert.deepEqual([at('a').x - at('r').x, at('a').y], [360, at('r').y], 'collapsing re-arranges the map: the collapsed topic is a leaf beside its parent');
  view.collapseTo(null); await view.pending;
  assert.ok(at('b').y !== at('c').y && at('b').x === at('a').x + 360, 'expanding re-arranges the shown branch');
  await view.travel(false);
  // One undo restores the state before the last action in one step.
  await view.travel(false);
  assert.ok(doc.nodes.every(item => !item.collapsed), 'one undo restores every flag');
  // Auto layout from the Layout menu re-arranges every topic in one write.
  for (const nodes of [doc.nodes, view.map.nodes]) { nodes.find(item => item.id === 'b').x = 9999; nodes.find(item => item.id === 'c').y = -9999; }
  const writes = saved;
  view.autoLayout(); await view.pending;
  assert.equal(saved, writes + 1, 'one write'); assert.equal(at('b').x, at('a').x + 360, 'auto layout re-arranges the map'); assert.notEqual(at('c').y, -9999);
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(source, /n\.collapsed = !n\.collapsed;\s*(?:map\.nodes = arrangeMap\(map\.nodes(?:, supersededAimNodeIds\(map\))?(?:, this\.cardHeightOf)?, layoutOf\(map\)\)|this\.arrangeAll\(map\));/, 'the card collapse button re-arranges in the same change, in the map\'s direction');
});
integrationTest('Layout menu offers collapse all, expand all, levels 1 to 3, a separator, the eight arrangements, a separator, the three spacings and Auto layout', () => {
  const menus = [];
  class Menu { constructor() { this.items = []; menus.push(this); } addItem(callback) { const item = { setTitle(value) { this.title = value; return this; }, setIcon() { return this; }, setChecked(value) { this.checked = value; return this; }, onClick(handler) { this.click = handler; return this; } }; callback(item); this.items.push(item); return this; } addSeparator() { this.items.push({ separator: true }); return this; } showAtMouseEvent() { return this; } }
  const { view } = selectionView(load, {}, { ...obsidian, Menu });
  const calls = []; view.collapseTo = levels => calls.push(levels); view.autoLayout = () => calls.push('arrange'); view.setLayout = patch => calls.push(patch.direction ?? patch.spacing);
  view.openLayoutMenu({});
  assert.deepEqual(menus[0].items.map(item => item.separator ? '---' : item.title), ['Collapse all', 'Expand all', 'Expand to level 1', 'Expand to level 2', 'Expand to level 3', '---', 'Lay out to the right', 'Lay out to the left', 'Lay out downward', 'Lay out upward', 'Lay out balanced left and right', 'Lay out radially', 'Lay out as a timeline', 'Lay out as a fishbone', '---', 'Compact spacing', 'Standard spacing', 'Spacious spacing', 'Auto layout']);
  assert.deepEqual(menus[0].items.filter(item => !item.separator).map(item => item.checked), [undefined, undefined, undefined, undefined, undefined, true, false, false, false, false, false, false, false, false, true, false, undefined], 'the current direction and spacing are checked');
  menus[0].items.filter(item => !item.separator).forEach(item => item.click());
  assert.deepEqual(calls, [0, null, 1, 2, 3, 'right', 'left', 'down', 'up', 'balanced', 'radial', 'timeline', 'fishbone', 'compact', 'standard', 'spacious', 'arrange']);
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-TW', 'ui.layout'), '排版'); assert.equal(translate('en', 'ui.layout'), 'Layout');
  assert.match(fs.readFileSync(path.join(root, 'styles.css'), 'utf8'), /\.vam-layout-button::after \{ content: "▾" \/ "";/, 'the menu caret is decoration, not part of the name');
});
integrationTest('map stylesheet: no :has() on the map surface, reduced motion beats the scan animation, buttons keep a focus ring, dead rules are gone', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const rules = css.split('\n');
  const surface = /\.vam-(workspace|canvas-overlay|node|map-tools|zoom-controls|toolbar|outline-option|inspector)/;
  assert.deepEqual(rules.filter(rule => rule.includes(':has(') && surface.test(rule)), [], 'no :has() on the map surface');
  // The overlay lives inside the canvas now, which already leaves the inspector's width out: shifting it was dead. Narrow panes move the zoom cluster aside instead.
  assert.equal(css.includes('.vam-workspace.has-inspector > .vam-canvas-overlay'), false, 'the dead overlay shift is gone'); assert.match(css, /\.vam-workspace\.has-inspector \.vam-zoom-controls \{ right: auto; left: 12px; \}/, 'the zoom cluster gives way to the inspector on a narrow pane');
  const scan = '.vam-node:not([data-aim-kind])[data-status="running"]::after';
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'), css.indexOf('.theme-dark .vam-viewport'));
  assert.ok(css.includes(`${scan} { content:`), 'the scan animation rule exists');
  assert.ok(reduced.includes(`${scan} { animation: none; }`) || reduced.includes(`, ${scan} { animation: none; }`), 'reduced motion uses the same selector weight as the animation it disables');
  assert.match(css, /\.vam-node-tools > \.vam-collapse-button \{ order: -1;/, 'the fold toggle leads the card tools, so the icons line up on every card');
  assert.match(css, /\.vam-map-tools button:focus-visible, \.vam-zoom-controls button:focus-visible[^{]*\{ outline: 2px solid var\(--interactive-accent\)/);
  for (const dead of ['.vam-next-web', '.vam-next-usage', '.vam-next-sources', '.vam-rule-preview']) assert.equal(css.includes(dead), false, `${dead} is removed`);
  assert.equal((css.match(/^\.vam-toolbar \.vam-map-switcher \{/gm) ?? []).length, 1, 'the switcher rule is not duplicated');
});
integrationTest('outline toggles report aria-expanded and the open topic row reports aria-current', () => {
  const { OutlineView } = load('ui/outline-view.ts', { obsidian });
  const element = (tag, options = {}) => ({ tag, text: options.text, cls: options.cls ?? '', children: [], style: {},
    get childElementCount() { return this.children.length; },
    createDiv(value) { const child = element('div', { cls: typeof value === 'string' ? value : value?.cls }); this.children.push(child); return child; },
    createEl(name, value = {}) { const child = element(name, value); this.children.push(child); return child; },
    createSpan(value = {}) { const child = element('span', typeof value === 'string' ? { cls: value } : value); this.children.push(child); return child; },
    addClass(value) { this.cls = `${this.cls} ${value}`.trim(); }, setAttr(name, value) { this[name] = value; }, addEventListener(name, handler) { this.handlers = { ...this.handlers, [name]: handler }; }, remove() {},
    empty() { this.children = []; }, querySelector() { return null; } });
  const root = node('root'), child = node('child', root.id), grand = node('grand', child.id);
  const view = new OutlineView({ app: {} }, async () => {}); view.contentEl = element('content');
  view.activePath = 'child.md';
  view.setMap(map([root, child, grand]), new Map([['root', 'Root'], ['child', 'Child'], ['grand', 'Grand']]));
  const all = item => [item, ...item.children.flatMap(all)];
  const toggles = all(view.contentEl).filter(item => item.cls === 'vam-outline-toggle');
  assert.deepEqual(toggles.map(item => item['aria-expanded']), ['true', 'true']);
  toggles[1].handlers.click();
  // The fake DOM keeps the old tree, so read the newest one.
  const after = all(view.contentEl).filter(item => item.cls === 'vam-outline-toggle').slice(-2);
  assert.deepEqual(after.map(item => item['aria-expanded']), ['true', 'false'], 'collapsing a branch flips aria-expanded');
  const current = all(view.contentEl).filter(item => item['aria-current'] === 'true').slice(-1);
  assert.deepEqual(current.map(item => item.text), ['Child'], 'the active topic row is aria-current');
  assert.equal(all(view.contentEl).filter(item => item.cls === 'vam-outline-note' && item['aria-current'] === 'true' && item.text !== 'Child').length, 0, 'no other row is');
});
test('dead code is gone: no unreachable TaskModal confirmation branches and a single AIM status chip block', () => {
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.equal(/confirmed = false/.test(source), false); assert.equal(/if \(!confirmed\)/.test(source), false);
  assert.equal((source.match(/ui\.aim_answered_not_started/g) ?? []).length, 1, 'the AIM chip is built once');
});

integrationTest('AIM map: arrow keys keep moving focus across full renders instead of snapping back to the old card', () => {
  const fixture = selectionView(load);
  const { view } = fixture;
  view.map.aim = { version: 1, branches: [], runs: [], pendingCommits: [] };
  fixture.build();
  const restored = [];
  view.render = () => { restored.push(view.focusNodeId); fixture.build(); view.focusNodeId = null; };
  const key = (id, name) => fixture.cards()[id].handlers.get('keydown')({ key: name, target: fixture.cards()[id], preventDefault() {} });
  key('root', 'ArrowRight');
  assert.equal(view.selection.state.selected, 'a'); assert.deepEqual(restored, ['a'], 'the render restores focus to the target card');
  key('a', 'ArrowDown');
  assert.equal(view.selection.state.selected, 'b'); assert.deepEqual(restored, ['a', 'b'], 'the second press moves one more step');
  assert.equal(fixture.cards().b.focused, 1, 'the live card gets focus, not a detached one'); assert.equal(view.focusNodeId, null);
});
integrationTest('legacy AIM map: a viewport write that stamps the content language leaves no false conflict', async () => {
  const { view } = viewportFixture();
  const clone = value => JSON.parse(JSON.stringify(value));
  const disk = clone(view.map); disk.aim = { version: 1, branches: [], runs: [], pendingCommits: [] };
  view.map = clone(disk);
  view.plugin.repo.updateMap = async (_path, change) => { change(disk); disk.aim.contentLanguage ??= 'en'; return clone(disk); };
  view.plugin.repo.readMap = async () => clone(disk);
  view.plugin.repo.saveMap = async (_path, map) => { Object.assign(disk, clone(map)); };
  view.plugin.rebuildDerivedData = async () => {};
  view.persist = async () => {};
  let cleared = 0; const history = view.history; const original = history.clear.bind(history); history.clear = () => { cleared++; original(); };
  view.map.viewport.x = 77;
  await view.persistViewport();
  assert.equal(view.map.aim.contentLanguage, 'en', 'the stamped language is adopted');
  await view.mapChange(map => { map.title = 'Renamed'; });
  assert.equal(cleared, 0, 'no conflict modal, history kept'); assert.equal(view.map.title, 'Renamed');
});
integrationTest('dragging keeps moving the edges when a background synchronize redraws them mid-drag', () => {
  const { view, events, near, down, frames, a, b } = dragFixture();
  down();
  events.get('pointermove')({ clientX: 50, clientY: 20 }); frames[0]();
  assert.equal(near.attrs.length, 1);
  const redrawn = { attrs: [], setAttribute(name, value) { this.attrs.push([name, value]); } };
  view.edgeEls = new Map([[`${a.id}\u0000${b.id}`, redrawn]]);
  events.get('pointermove')({ clientX: 60, clientY: 30 }); frames[1]();
  assert.equal(redrawn.attrs.length, 1, 'the new path element follows the card'); assert.equal(near.attrs.length, 1, 'the detached path is left alone');
});
integrationTest('outline highlight follows the selected topic on in-place and full-render paths, falling back to the opened note', () => {
  for (const aim of [false, true]) {
    const fixture = selectionView(load);
    const { view, outline } = fixture;
    view.app = { workspace: { getActiveFile: () => ({ path: 'opened.md' }) } };
    if (aim) view.map.aim = { version: 1, branches: [], runs: [], pendingCommits: [] };
    fixture.build();
    view.selectMapNode(view.map.nodes.find(item => item.id === 'a'));
    assert.equal(outline.at(-1), 'a.md', `selected topic is active (aim=${aim})`);
    assert.equal(fixture.renders(), aim ? 1 : 0);
    const previous = view.selection.state.selected; view.selection.setSelected(null);
    view.commitSelection(previous, null, []);
    assert.equal(outline.at(-1), 'opened.md', `clearing selection falls back to the opened note (aim=${aim})`);
  }
});
integrationTest('card layout never depends on hover, focus or selection: state rules only change color, opacity and shadow', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const layout = /^(display|width|min-width|max-width|height|min-height|max-height|padding[a-z-]*|margin[a-z-]*|font-size|font-weight|border(-(top|right|bottom|left))?(-width)?|gap|row-gap|column-gap|flex[a-z-]*|grid[a-z-]*|position|line-height|letter-spacing|white-space|order)$/;
  const state = /:hover|\.is-selected|:focus-within|:focus-visible|:focus\b|:active/;
  const offenders = [];
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // Only what sits inside a card's flow matters; the floating toolbar and its contents never move the card's content.
    const inCard = selectors.split(',').map(s => s.trim()).filter(s => /vam-node\b|vam-node-header|vam-card-|vam-status/.test(s) && state.test(s) && !/vam-node-tools|vam-ai-slot|vam-add-child/.test(s));
    if (!inCard.length) continue;
    for (const declaration of body.split(';')) {
      const property = declaration.split(':')[0].trim();
      if (layout.test(property) && !(property === 'border' && /^\s*border:\s*[^;]*\b1px\b/.test(declaration))) offenders.push(`${inCard.join(', ')} { ${declaration.trim()} }`);
    }
  }
  assert.deepEqual(offenders, [], 'a hover/focus/selection rule changes card layout');
});
integrationTest('AIM canvas treats superseded interim results as hidden (behaviour + source wiring)', () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const q = node('Q'), r = node('R', 'Q'), s1 = node('S1', 'R'), s2 = node('S2', 'R'), c = node('C', 'R');
  q.aimKind = 'question'; r.aimKind = 'research'; s1.aimKind = s2.aimKind = 'synthesis'; c.aimKind = 'conclusion';
  s1.y = 10; s2.y = 20; c.y = 30;
  const doc = map([q, r, s1, s2, c]);
  const res = (nodeId, kind) => ({ resultId: nodeId, runId: 'run', attemptId: 'a', nodeId, notePath: `${nodeId}.md`, version: 1, kind });
  doc.aim = { version: 1, branches: [{ id: 'b', questionNodeId: 'Q', parentBranchId: null, answerSnapshot: { selections: [], freeText: '' }, inputSnapshot: { topic: 't', conditions: {}, upstreamResults: [] }, createdAt: '2026-10-09T00:00:00.000Z', results: [res('S1', 'synthesis'), res('S2', 'synthesis'), res('C', 'conclusion')] }], runs: [], pendingCommits: [] };
  const view = new VisualAgentMapView({ app: {} }, { pendingSuggestions: new Map(), expansionBatches: new Map() });
  view.map = doc;
  assert.deepEqual(view.canvasNodes().map(item => item.id), ['Q', 'R', 'C']);
  assert.equal(view.keyboardNeighbor(r, 'ArrowRight').id, 'C', 'keyboard skips hidden nodes');
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.equal((source.match(/visibleNodes\(this\.map/g) ?? []).length, 1, 'only canvasNodes() calls visibleNodes on the map');
  assert.equal((source.match(/arrangeMap\(map\.nodes\)/g) ?? []).length, 0, 'every arrangeMap call passes the hidden set');
});

// ---- Merge topics, Phase 1: quick selection (select subtopics, Shift-drag, Cmd-click, Option-drag) ----
integrationTest('Select subtopics: shown only for an unfolded, non-AIM card that has direct subtopics, and it picks exactly those', () => {
  const toolTexts = (setup = () => {}, id = 'a') => {
    const fixture = selectionView(load); setup(fixture); fixture.build();
    const tools = fixture.cards()[id].children.find(child => child.classes.has('vam-node-tools'));
    const more = tools.children.find(child => child.classes.has('vam-more-tool'));
    const entries = more ? recordMenus(fixture.view)(more) : [];
    return { fixture, buttons: entries.map(entry => ({ text: entry.title, handlers: new Map([['click', () => entry.fn()]]) })) };
  };
  const has = (setup, id) => toolTexts(setup, id).buttons.some(button => button.text === 'Select subtopics');
  assert.equal(has(), true, 'a has the direct subtopic c');
  assert.equal(has(undefined, 'b'), false, 'a leaf has none');
  assert.equal(has(({ doc, view }) => { doc.nodes.find(n => n.id === 'a').collapsed = true; }), false, 'a folded card hides its subtopics and offers Expand instead');
  assert.equal(has(({ view }) => { view.selection.toggleMultiSelect(); }), false, 'not while selecting');
  assert.equal(has(({ view }) => { view.map.aim = { branches: [] }; }), false, 'not in an AIM map');
  // Root has direct children a and b but not grandchild c; the button replaces any earlier selection.
  const { fixture, buttons } = toolTexts(undefined, 'root');
  const { view } = fixture;
  view.applySelectionChange(view.selection.replaceMulti(['c'])); view.applySelectionChange(view.selection.setSelected('b'));
  buttons.find(button => button.text === 'Select subtopics').handlers.get('click')({ stopPropagation() {} });
  assert.deepEqual([...view.selection.state.multiSelected].sort(), ['a', 'b']); assert.equal(view.selection.state.selected, null);
  assert.equal(view.selection.state.multiSelectMode, true); assert.equal(fixture.renders(), 1);
});
integrationTest('Cmd/Ctrl+click: the first click on a second card enters selection mode, seeds the selected card, and the mode keeps toggling', () => {
  for (const key of ['metaKey', 'ctrlKey']) {
    const fixture = selectionView(load); const { view } = fixture;
    fixture.build();
    const cards = fixture.cards();
    const target = { closest: () => null };
    const tap = (id, extra = {}) => { cards[id].handlers.get('pointerdown')({ target, button: 0, clientX: 0, clientY: 0, pointerId: 1 }); cards[id].handlers.get('pointerup')({ type: 'pointerup', ...extra }); };
    tap('a');
    assert.equal(view.selection.state.selected, 'a');
    tap('b', { [key]: true });
    assert.deepEqual([...view.selection.state.multiSelected].sort(), ['a', 'b'], 'the plain-selected card A joins B');
    assert.equal(view.selection.state.multiSelectMode, true); assert.equal(fixture.renders(), 1, 'the selection bar appears via a render');
    // Inside the mode a Cmd/Ctrl+click toggles instead of being swallowed.
    const click = id => { view.suppressClickUntil = 0; cards[id].handlers.get('click')({ target, metaKey: key === 'metaKey', ctrlKey: key === 'ctrlKey' }); };
    click('c');
    assert.deepEqual([...view.selection.state.multiSelected].sort(), ['a', 'b', 'c']);
    click('a');
    assert.deepEqual([...view.selection.state.multiSelected].sort(), ['b', 'c']);
  }
  // A single Cmd+click with nothing selected stays a one-card selection and does not enter the mode.
  const lone = selectionView(load); lone.build();
  const cards = lone.cards();
  cards.b.handlers.get('pointerdown')({ target: { closest: () => null }, button: 0, clientX: 0, clientY: 0, pointerId: 1 });
  cards.b.handlers.get('pointerup')({ type: 'pointerup', metaKey: true });
  assert.equal(lone.view.selection.state.multiSelectMode, false); assert.deepEqual([...lone.view.selection.state.multiSelected], ['b']); assert.equal(lone.renders(), 0);
});
integrationTest('applySelectionChange: a mode change renders the whole map, a selection-only change repaints the touched cards and the outline', () => {
  const fixture = selectionView(load); const { view, outline } = fixture;
  fixture.build(); const cards = fixture.cards();
  view.applySelectionChange(view.selection.setSelected('a'));
  assert.equal(fixture.renders(), 0); assert.ok(cards.a.classes.has('is-selected')); assert.equal(outline.at(-1), 'a.md');
  view.applySelectionChange(view.selection.click('b'));
  assert.equal(fixture.renders(), 0); assert.equal(cards.a.classes.has('is-selected'), false); assert.ok(cards.b.classes.has('is-selected')); assert.equal(outline.at(-1), 'b.md');
  view.applySelectionChange(view.selection.toggleMultiSelect());
  assert.equal(fixture.renders(), 1, 'turning the mode on renders the whole map'); assert.equal(view.selection.state.multiSelectMode, true); assert.equal(view.selection.state.selected, null);
  view.applySelectionChange(view.selection.toggleByClick('c'));
  assert.equal(fixture.renders(), 1, 'ticking a card inside the mode only repaints'); assert.deepEqual([...view.selection.state.multiSelected], ['c']);
  view.applySelectionChange(view.selection.toggleMultiSelect());
  assert.equal(fixture.renders(), 2); assert.equal(view.selection.state.multiSelectMode, false); assert.equal(view.selection.state.multiSelected.size, 0);
});
integrationTest('box selection: Shift+drag enters selection mode, an empty box changes nothing, Option+drag removes picks, Space and the middle button pan', () => {
  const fixture = selectionView(load); const { view } = fixture;
  fixture.build();
  const cards = fixture.cards();
  const rects = { root: [0, 0, 100, 50], a: [200, 0, 300, 50], b: [200, 100, 300, 150], c: [400, 0, 500, 50] };
  for (const [id, [left, top, right, bottom]] of Object.entries(rects)) cards[id].getBoundingClientRect = () => ({ left, top, right, bottom });
  view.stageEl.querySelectorAll = () => Object.values(cards);
  const viewport = selectionDom()('viewport'); viewport.clientWidth = 800; viewport.clientHeight = 600;
  view.viewportEl = viewport; view.transform = () => {}; view.saveViewport = () => {}; fixture.view.plugin.saveSettings = async () => {};
  view.setupPan();
  const down = (over = {}) => viewport.handlers.get('pointerdown')({ target: { closest: () => null }, button: 0, clientX: 150, clientY: -10, pointerId: 1, altKey: false, shiftKey: false, preventDefault() {}, ...over });
  const drag = (x, y) => { viewport.handlers.get('pointermove')({ clientX: x, clientY: y }); viewport.handlers.get('pointerup')({}); };
  // A pointerdown on a control inside the canvas (the empty-map "+ Topic" button) must not start a pan: capturing the pointer would retarget its click to the viewport.
  { const captured = []; viewport.setPointerCapture = id => captured.push(id);
    const interactive = ['button', 'a', 'input', 'select', 'textarea', '[contenteditable="true"]', '[role="button"]'].join(',');
    const onControl = { closest: selector => (selector === interactive ? {} : null) };
    down({ target: onControl });
    assert.deepEqual(captured, [], 'no pointer capture starts from a control'); assert.equal(viewport.classes.has('is-panning'), false);
    down({ target: onControl, shiftKey: true });
    assert.deepEqual(captured, [], 'no marquee capture starts from a control either');
    down(); assert.deepEqual(captured, [1], 'a pointerdown on bare canvas still pans'); viewport.handlers.get('pointerup')({}); }
  // A plain drag in normal mode still pans (no box, viewport moves).
  down(); viewport.handlers.get('pointermove')({ clientX: 170, clientY: 30 });
  assert.equal(viewport.classes.has('is-marquee'), false); assert.equal(view.map.viewport.x, 20); assert.equal(view.map.viewport.y, 40);
  viewport.handlers.get('pointerup')({}); view.map.viewport.x = 0; view.map.viewport.y = 0; fixture.renders();
  const before = fixture.renders();
  // Shift+drag over nothing: no state change.
  down({ shiftKey: true, clientX: 600, clientY: 300 }); drag(650, 340);
  assert.equal(view.selection.state.multiSelectMode, false); assert.equal(view.selection.state.multiSelected.size, 0); assert.equal(fixture.renders(), before);
  // Shift+drag over a and b: enters the mode with both picked.
  down({ shiftKey: true }); drag(350, 200);
  assert.equal(view.selection.state.multiSelectMode, true); assert.deepEqual([...view.selection.state.multiSelected].sort(), ['a', 'b']);
  assert.equal(fixture.renders(), before + 1);
  // Inside the mode, Option+drag removes only the boxed picks and previews them with is-marquee-remove.
  view.selection.replaceMulti(['a', 'b', 'c']);
  down({ altKey: true, clientX: 150, clientY: 90 }); viewport.handlers.get('pointermove')({ clientX: 350, clientY: 200 });
  assert.equal(cards.b.classes.has('is-marquee-remove'), true); assert.equal(cards.a.classes.has('is-marquee-remove'), false);
  viewport.handlers.get('pointerup')({});
  assert.equal(cards.b.classes.has('is-marquee-remove'), false, 'the preview clears'); assert.deepEqual([...view.selection.state.multiSelected].sort(), ['a', 'c']);
  // Option+drag over cards that are not picked changes nothing.
  down({ altKey: true, clientX: 150, clientY: 90 }); drag(350, 200);
  assert.deepEqual([...view.selection.state.multiSelected].sort(), ['a', 'c']);
  // Plain drag adds; Space+drag and the middle button pan instead of boxing.
  down({ clientX: 150, clientY: 90 }); drag(350, 200);
  assert.deepEqual([...view.selection.state.multiSelected].sort(), ['a', 'b', 'c']);
  view.spaceHeld = true; down(); assert.equal(viewport.classes.has('is-marquee'), false); assert.equal(viewport.classes.has('is-panning'), true); viewport.handlers.get('pointerup')({});
  view.spaceHeld = false; viewport.classes.delete('is-panning');
  down({ button: 1 }); assert.equal(viewport.classes.has('is-panning'), true); assert.equal(viewport.classes.has('is-marquee'), false);
  viewport.handlers.get('pointerup')({});
});
integrationTest('selection gestures: hint texts, remove outline and the pan comment match the new gesture table', () => {
  const { translate } = load('i18n.ts');
  assert.equal(translate('en', 'ui.drag_to_select_topics_hint'), 'Drag to box-select · Hold Option and drag to deselect · Hold Space and drag, or use the middle button, to pan · Click a topic to add or remove it');
  assert.equal(translate('en', 'ui.drag_empty_space_to_pan_scroll_to_zoom_click_a_node_to_open'), 'Drag empty space to pan · Shift-drag to box-select · Scroll to zoom · Arrow keys move between topics');
  assert.equal(translate('zh-TW', 'ui.select_subtopics'), '選取子議題'); assert.equal(translate('en', 'ui.select_subtopics'), 'Select subtopics');
  assert.equal(translate('zh-TW', 'ui.select_subtopics_hint'), '選取這個議題底下所有直屬子議題');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(css, /\.vam-node\.is-marquee-remove \{ outline: 2px dashed/, 'removal is not signalled by colour alone');
});

integrationTest('select mode: the Merge button stays focusable, names the reason in its title, and Notices instead of merging', () => {
  const fixture = selectionView(load); const { view } = fixture;
  const { translate } = load('i18n.ts');
  view.selection.toggleMultiSelect(); fixture.build();
  const bar = ids => { view.selection.replaceMulti(ids); const el = view.renderSelectionBar(selectionDom()('div')); return el.children.find(child => child.tag === 'button' && /^Merge/.test(child.text)); };
  const one = bar(['a']);
  assert.equal(one.disabled, false, 'never natively disabled, so keyboard users can reach it');
  assert.equal(one.attrs['aria-disabled'], 'true'); assert.equal(one.attrs.title, translate('en', 'ui.merge_needs_two'));
  assert.equal(bar(['a', 'b']).attrs['aria-disabled'], undefined, 'siblings under root can merge');
  assert.equal(bar(['a', 'b']).attrs.title, undefined);
  assert.equal(bar(['b', 'c']).attrs.title, translate('en', 'ui.merge_needs_same_parent'));
  assert.equal(bar(['a', 'c']).attrs['aria-disabled'], undefined, 'a parent with its direct subtopic can merge into the parent');
  assert.equal(bar(['a', 'c']).attrs.title, undefined);
  assert.equal(bar(['root', 'a', 'c']).attrs.title, translate('en', 'ui.merge_parent_direct_only'));
  assert.equal(bar(['root', 'c']).attrs.title, translate('en', 'ui.merge_parent_direct_only'));
  view.plugin.running = new Set(['b.md']);
  assert.equal(bar(['a', 'b']).attrs.title, translate('en', 'ui.merge_busy'));
  view.map.aim = {}; const aim = view.renderSelectionBar(selectionDom()('div'));
  assert.equal(aim.children.some(child => child.tag === 'button' && /^Merge/.test(child.text)), false, 'AIM maps have no merge button');
});
integrationTest('merge dialog: Enter confirms once and is consumed; a second Merge press while it is open or queued does nothing', () => {
  const make = selectionDom(); const opened = [];
  class FakeModal { constructor(app) { this.app = app; const el = () => { const e = make('div'); e.setText = text => { e.text = text; }; const create = e.createEl.bind(e); e.createEl = (name, init = {}) => { const child = create(name, init); child.value = init.value; child.focus = () => {}; child.select = () => {}; child.createEl = e.createEl; child.setText = e.setText; child.createSpan = e.createSpan; return child; }; return e; }; this.titleEl = el(); this.contentEl = el(); this.modalEl = el(); this.closed = 0; } open() { opened.push(this); this.onOpen(); } close() { this.closed++; this.onClose?.(); } }
  const shim = { ...obsidian, Modal: FakeModal };
  const fixture = selectionView(load, {}, shim); const { view } = fixture;
  view.app = {}; const queued = []; view.enqueue = work => queued.push(work);
  view.selection.toggleMultiSelect(); fixture.build();
  view.selection.replaceMulti([]);
  view.openMerge(); assert.equal(opened.length, 0, 'empty selection is a no-op');
  view.selection.replaceMulti(['a', 'b']);
  view.openMerge(); view.openMerge(); assert.equal(opened.length, 1, 'a second press while the dialog is open is ignored');
  const modal = opened[0]; const input = modal.contentEl.children.find(c => c.tag === 'input');
  let prevented = 0, run = 0;
  input.handlers.get('keydown')({ key: 'Enter', isComposing: false, preventDefault() { prevented++; } });
  assert.equal(prevented, 1, 'the Enter is consumed so it cannot click the button that regains focus');
  assert.equal(queued.length, 1); assert.equal(modal.closed, 1);
  view.openMerge(); assert.equal(opened.length, 1, 'still ignored while the merge write is queued');
  // A cancelled dialog frees the button again.
  queued.length = 0; view.mergeOpen = false; view.openMerge(); assert.equal(opened.length, 2);
  opened[1].close(); view.openMerge(); assert.equal(opened.length, 3);
});
integrationTest('merge dialog offers AI only when a selected card has Detail, and an AI merge in progress blocks a second dialog', () => {
  const make = selectionDom(); const opened = [];
  class FakeModal { constructor(app) { this.app = app; const el = () => { const e = make('div'); e.setText = text => { e.text = text; }; const create = e.createEl.bind(e); e.createEl = (name, init = {}) => { const child = create(name, init); child.value = init.value; child.type = init.type; child.focus = () => {}; child.select = () => {}; child.createEl = e.createEl; child.setText = e.setText; child.createSpan = e.createSpan; return child; }; return e; }; this.titleEl = el(); this.contentEl = el(); this.modalEl = el(); } open() { opened.push(this); this.onOpen(); } close() { this.onClose?.(); } }
  const fixture = selectionView(load, {}, { ...obsidian, Modal: FakeModal }); const { view } = fixture;
  view.app = {}; view.enqueue = () => {}; view.selection.toggleMultiSelect(); fixture.build();
  const checkbox = modal => modal.contentEl.children.flatMap(function walk(c) { return [c, ...c.children.flatMap(walk)]; }).find(c => c.type === 'checkbox');
  view.selection.replaceMulti(['a', 'b']);
  view.openMerge(); assert.equal(checkbox(opened[0]), undefined, 'no content: the plain structure merge');
  opened[0].close();
  view.notes.get('b').detail = 'Has content';
  view.openMerge(); assert.ok(checkbox(opened[1]), 'content: the AI merge with its skip option');
  opened[1].close();
  // A running merge on this map only reports itself; its sources stay locked after it fails or finishes a draft.
  view.mergeTasks.set(view.path, { mapPath: view.path, state: 'running', sources: [{ id: 'a', path: 'a' }, { id: 'b', path: 'b' }], controller: new AbortController() });
  view.openMerge(); assert.equal(opened.length, 2, 'no second dialog while a merge is running');
});
integrationTest('AIM maps never enter selection mode from Shift+drag or Cmd/Ctrl+click', () => {
  for (const [name, setup] of [['AIM', view => { view.map.aim = { branches: [] }; }]]) {
    const fixture = selectionView(load); const { view } = fixture; setup(view);
    fixture.build();
    const cards = fixture.cards(); const target = { closest: () => null };
    // Cards of these maps may not be draggable at all; the click handler must not start the mode either.
    const tap = (id, extra = {}) => { const down = cards[id].handlers.get('pointerdown'); if (down) { down({ target, button: 0, clientX: 0, clientY: 0, pointerId: 1 }); cards[id].handlers.get('pointerup')({ type: 'pointerup', ...extra }); } view.suppressClickUntil = 0; cards[id].handlers.get('click')({ target, metaKey: false, ctrlKey: false, ...extra }); };
    tap('a'); tap('b', { metaKey: true }); tap('c', { ctrlKey: true });
    assert.equal(view.selection.state.multiSelectMode, false, `${name}: Cmd/Ctrl+click does not start selection mode`);
    for (const [id, [left, top, right, bottom]] of Object.entries({ root: [0, 0, 100, 50], a: [200, 0, 300, 50], b: [200, 100, 300, 150], c: [400, 0, 500, 50] })) cards[id].getBoundingClientRect = () => ({ left, top, right, bottom });
    view.stageEl.querySelectorAll = () => Object.values(cards);
    const viewport = selectionDom()('viewport'); viewport.clientWidth = 800; viewport.clientHeight = 600;
    view.viewportEl = viewport; view.transform = () => {}; view.saveViewport = () => {}; view.plugin.saveSettings = async () => {}; view.setupPan();
    viewport.handlers.get('pointerdown')({ target, button: 0, clientX: 150, clientY: -10, pointerId: 1, altKey: false, shiftKey: true, preventDefault() {} });
    assert.equal(viewport.classes.has('is-marquee'), false, `${name}: Shift+drag draws no box`);
    assert.equal(viewport.classes.has('is-panning'), true, `${name}: Shift+drag pans like a plain drag`);
    viewport.handlers.get('pointermove')({ clientX: 350, clientY: 200 }); viewport.handlers.get('pointerup')({});
    assert.equal(view.selection.state.multiSelectMode, false);
  }
});

// ---- AI mode Quick / Standard ----------------------------------------------------------------------------------------
test('ai-mode helpers: modes map to note values and task options; the knowledge-gap marker is found in three languages only', () => {
  const mode = load('experiences/visual-map/ai-mode.ts');
  assert.equal(mode.isMapAiMode('quick'), true); assert.equal(mode.isMapAiMode('standard'), true);
  for (const bad of ['deep', 'Quick', '', 123, null, undefined, {}]) assert.equal(mode.isMapAiMode(bad), false, String(bad));
  assert.equal(mode.noteAiMode('local'), 'quick'); assert.equal(mode.noteAiMode('research'), 'standard');
  assert.equal(mode.researchModeOf('quick'), 'local'); assert.equal(mode.researchModeOf('standard'), 'research');
  assert.deepEqual(plain(mode.aiModeOptions('quick', 'research')), { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', mapAiMode: 'quick' });
  assert.deepEqual(plain(mode.aiModeOptions('quick', 'subtopic')), { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', mapAiMode: 'quick' });
  assert.deepEqual(plain(mode.aiModeOptions('standard', 'research')), { researchMode: 'research', researchDepth: 'normal', visualMode: 'auto', mapAiMode: 'standard' });
  assert.deepEqual(plain(mode.aiModeOptions('standard', 'subtopic')), { researchMode: 'research', researchDepth: 'fast', visualMode: 'auto', mapAiMode: 'standard' });
  assert.equal(mode.DEFAULT_MAP_AI_MODE, 'quick');
  for (const text of ['模型知識不足', '模型知识不足', 'Model knowledge is insufficient', 'model KNOWLEDGE is insufficient', '### Core\n\n模型知識不足。需要更多資料。']) assert.equal(mode.hasKnowledgeGapMarker(text), true, text);
  for (const text of ['', '現有資料不足', 'Insufficient information', '模型知識很充足', 'knowledge is insufficient']) assert.equal(mode.hasKnowledgeGapMarker(text), false, text);
  // The sentence the Quick prompt asks for is the one the detector looks for, in each dictionary.
  const { translate } = load('i18n.ts');
  for (const language of ['en', 'zh-TW', 'zh-CN']) assert.equal(mode.hasKnowledgeGapMarker(translate(language, 'research.knowledge_gap_marker')), true, language);
  assert.equal(translate('en', 'research.knowledge_gap_marker'), 'Model knowledge is insufficient');
});
integrationTest('Re-run with Standard on the card: only for an idle Quick topic whose Detail carries the marker, on an ordinary map; named for screen readers', () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const makeElement = (tag, buttons) => ({ tag, children: [], dataset: {}, style: {},
    createDiv(options) { const child = makeElement('div', buttons); child.cls = options?.cls ?? options; this.children.push(child); return child; },
    createEl(name, options) { const child = makeElement(name, buttons); child.text = options?.text; this.children.push(child); if (name === 'button') buttons.push(child); return child; },
    createSpan(options) { const child = makeElement('span', buttons); child.text = options?.text; this.children.push(child); return child; },
    setAttr(name, value) { this[name] = value; }, addClass(name) { this.cls = name; }, setPointerCapture() {}, addEventListener(name, handler) { if (name === 'click') this.click = handler; }, removeEventListener() {}
  });
  const topic = node('topic');
  const render = ({ note = {}, doc = map([topic]), integrationMode = false, plugin = {} } = {}) => {
    const buttons = [];
    const view = new VisualAgentMapView({ app: {} }, { pendingSuggestions: new Map(), expansionBatches: new Map(), running: new Set(), activeTasks: new Map(), quickExpandPending: new Set(), expansionCoordinator: { isQueued: () => false, isRunning: () => false }, ...plugin });
    view.stageEl = makeElement('stage', buttons); view.map = doc; if (integrationMode) view.selection.toggleMultiSelect();
    view.notes = new Map([[topic.id, { title: 'Topic', summary: 'S', status: 'completed', researchMode: 'local', detail: 'Model knowledge is insufficient.', ...note }]]);
    const rerun = []; view.rerunStandard = target => rerun.push(target.id);
    view.renderNode(topic);
    return { button: buttons.find(item => item.text === 'Re-run with Standard'), rerun };
  };
  const shown = render();
  assert.ok(shown.button, 'a Quick topic with the marker offers the Standard run');
  assert.equal(shown.button.tag, 'button', 'a real button: keyboard reachable');
  assert.equal(shown.button['aria-label'], 'Re-run with Standard: Topic', 'it names the topic it acts on');
  shown.button.click({ stopPropagation() {} });
  assert.deepEqual(plain(shown.rerun), [topic.id], 'pressing it re-runs this topic');
  for (const detail of ['模型知識不足', '模型知识不足']) assert.ok(render({ note: { detail: `### 核心結論\n\n${detail}` } }).button, detail);
  const none = [
    ['a Standard note', { note: { researchMode: 'research' } }],
    ['no marker', { note: { detail: 'A complete answer.' } }],
    ['topic is running', { plugin: { running: new Set(['topic.md']) } }],
    ['an AIM map', { doc: Object.assign(map([topic]), { aim: { version: 1, branches: [], runs: [], pendingCommits: [] } }) }],
    ['topic selection mode', { integrationMode: true }]
  ];
  for (const [name, options] of none) assert.equal(render(options).button, undefined, `no button: ${name}`);
});
// ---- hypothesis-evidence (P2): hypothesis cards, the evidence panel and the evidence line ----
const heNotes = (list) => new Map(list.map(([id, extra]) => [id, { title: id.toUpperCase(), summary: '', status: 'completed', ...extra }]));
const heHyp = (strength, leaning) => ({ topicKind: 'hypothesis', ...(strength ? { hypothesisStrength: strength } : {}), ...(leaning ? { hypothesisLeaning: leaning } : {}) });
// The shared DOM stand-in has a read-only textContent; labelCard writes it.
const hePatch = el => { el.matches ??= () => false; Object.defineProperty(el, 'textContent', { configurable: true, get() { return this.text; }, set(v) { this.text = String(v); } }); el.appendChild = function (child) { return this.insertBefore(child, null); }; el.replaceWith = function (node) { const at = (node.remove(), this.parent.children.indexOf(this)); node.parent = this.parent; this.parent.children.splice(at, 1, node); }; el.after = function (node) { node.remove(); const at = this.parent.children.indexOf(this); this.parent.insertBefore(node, this.parent.children[at + 1] ?? null); }; const child = el.child; el.child = function (...args) { return hePatch(child.apply(this, args)); }; return el; };
function heFixture(options = {}) {
  const modals = [], notices = [], menus = [], logs = [], undone = [], opened = [];
  const Modal = class { constructor(app, ...args) { this.app = app; this.args = args; } open() { modals.push(this); } close() {} };
  const Notice = class { constructor(message) { notices.push(message); } };
  const Menu = class { constructor() { menus.push(this); this.titles = []; } addItem(cb) { const entry = { setTitle: t => { this.titles.push(t); return entry; }, setIcon: () => entry, onClick: fn => { (this.clicks ??= []).push(fn); return entry; } }; cb(entry); return this; } addSeparator() { return this; } showAtMouseEvent() { return this; } };
  const svgCreated = [];
  const createSvg = tag => { const el = { tag, attrs: {}, classes: [], children: [], get textContent() { return this.text; }, set textContent(v) { this.text = String(v); this.children = []; }, setAttribute(n, v) { this.attrs[n] = v; }, addClass(n) { this.classes.push(n); }, toggleClass(n, on) { this.classes = this.classes.filter(c => c !== n); if (on) this.classes.push(n); }, listeners: {}, addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }, fire(type, event = {}) { for (const fn of this.listeners[type] ?? []) fn(event); }, appendChild(c) { this.children.push(c); } }; svgCreated.push(el); return el; };
  const { VisualAgentMapView } = options.shared ?? load('main.ts', { obsidian: { ...obsidian, Modal, Notice, Menu } }, { createSvg, CSS: { escape: v => String(v) }, requestAnimationFrame: run => { run(); return 1; }, cancelAnimationFrame() {}, open: (...args) => { opened.push(args); } });
  const topics = options.topics ?? [node('fact'), node('hyp'), node('other')];
  const doc = { ...map(topics), ...(options.aim ? { aim: { mode: 'x' } } : {}), ...(options.relations ? { topicRelations: options.relations } : {}) };
  const plugin = { pendingSuggestions: new Map(), expansionBatches: new Map(), logs: { appendLog: (level, message) => logs.push([level, message]) }, repo: { writeHypothesisStrength: async (path, strength) => undone.push([path, strength]) }, detailsShown: () => false, setOutlineActive() {}, settings: { ...DEFAULT_SETTINGS } };
  plugin.currentModelChoice = () => ({ model: plugin.settings.cliModel, reasoning: plugin.settings.cliReasoning });
  const view = new VisualAgentMapView({ app: {} }, plugin);
  view.app = { vault: { getAbstractFileByPath: () => null }, metadataCache: { getFileCache: () => null } }; view.path = 'Map.md'; view.map = doc;
  view.notes = options.notes ?? heNotes([['fact', {}], ['hyp', heHyp('weak')], ['other', {}]]);
  return { VisualAgentMapView, view, doc, opened, modals, notices, menus, logs, svgCreated, writes: undone, Notice };
}
// ticket 41: the add-relation sentence "This card [relation] -> [another card] [Add]".
const heKindSelect = panel => dom.byLabel(panel, 'Relation type'), heTargetSelect = panel => dom.byLabel(panel, 'Other card');
const heTargetIds = (panel, kind) => { const k = heKindSelect(panel); k.value = kind; k.change(); return dom.findAll(heTargetSelect(panel), c => c.tag === 'option').map(o => o.optionValue).filter(Boolean); };
const heAddRelation = async (panel, kind, toId) => {
  const k = heKindSelect(panel); k.value = kind; k.change();
  const t = heTargetSelect(panel); t.value = toId; t.change();
  dom.find(panel, c => (c.cls ?? '').includes('vam-relation-add')).children.find(c => c.tag === 'button').click(); await dom.tick();
};
const heTargetsOf = (fx, kind, fromId) => { const panel = dom.element('panel'); fx.view.renderHypothesisSection(panel, fx.view.map.nodes.find(n => n.id === fromId)); return heTargetIds(panel, kind); };
const heDrawn = (view, boxes) => {
  view.cardEls = new Map(Object.entries(boxes).map(([id, [x, y]]) => [id, { offsetLeft: x, offsetTop: y, offsetWidth: 280, offsetHeight: 100, classes: [], setAttr() {}, toggleClass(n, on) { this.classes = this.classes.filter(c => c !== n); if (on) this.classes.push(n); } }]));
  view.edgesEl = { kids: [], replaceChildren() { this.kids = []; }, appendChild(p) { this.kids.push(p); } };
  view.stageEl = view.stageEl ?? {}; view.edgeEls = new Map(); view.canvasNodes = () => view.map.nodes; view.drawEdges();
  return view.edgesEl.kids;
};
const heKindNames = ['Topic', 'Action', 'Atomic knowledge', 'Hypothesis', 'Evidence', 'Conclusion'];
const heDialogKindIds = ['topic', 'atomic', 'hypothesis', 'evidence', 'conclusion', 'action'];
const heDialogKindNames = ['Topic', 'Atomic knowledge', 'Hypothesis', 'Evidence', 'Conclusion', 'Action'];
const heKindIds = ['topic', 'action', 'atomic', 'hypothesis', 'evidence', 'conclusion'];
integrationTest('hypothesis-evidence: the add menu for a new top-level topic (empty-map button) lists the six types in order, each creating that type', () => {
  const { view, menus } = heFixture();
  const calls = []; view.addNode = (...args) => calls.push(args); view.enqueue = work => work();
  view.openAddMenu({}, null);
  assert.equal(menus.length, 1);
  assert.deepEqual(menus[0].titles.slice(0, heKindNames.length), heKindNames);
  assert.equal(menus[0].titles.some(title => /hypothesis/i.test(title) && title !== 'Hypothesis'), false, 'the old "Add hypothesis" item is gone');
  menus[0].clicks.slice(0, heKindNames.length).forEach(click => click());
  assert.deepEqual(calls, heKindIds.map(kind => [null, undefined, true, true, kind]));
});
integrationTest('hypothesis-evidence: the panel "Add subtopic…" opens the six-type menu and creates the chosen type under this topic', () => {
  const { view, menus } = heFixture();
  const calls = []; view.addNode = (...args) => calls.push(args.map(a => (a && a.id) ?? a)); view.enqueue = work => work();
  const panel = dom.element('panel'); view.renderHypothesisSection(panel, view.map.nodes[2]);
  assert.equal(dom.buttons(panel).includes('Add sub-hypothesis'), false); assert.equal(dom.buttons(panel).includes('Add subtopic…'), false, 'the entry moved out of the body into the footer (C3)');
  const footer = dom.element('actions'); view.renderAddSubtopic(footer, view.map.nodes[2]);
  dom.button(footer, 'Add subtopic…').click();
  assert.equal(menus.length, 1); assert.deepEqual(menus[0].titles, heKindNames);
  menus[0].clicks.forEach(click => click());
  assert.deepEqual(calls, heKindIds.map(kind => ['other', undefined, true, true, kind]));
});
integrationTest('hypothesis-evidence: the card "+" opens the type list for its card (no name dialog, nothing is added before a pick)', () => {
  const { view } = heFixture();
  const calls = []; view.addNode = () => { throw new Error('not before a pick'); }; view.openAddMenu = (event, parent) => calls.push([parent.id]); view.enqueue = work => work();
  view.stageEl = hePatch(dom.element('stage')); view.renderNode(view.map.nodes[2]);
  const plus = dom.button(view.stageEl.children[0], '+');
  plus.click();
  assert.deepEqual(calls, [['other']]);
});
integrationTest('hypothesis-evidence: addNode hands createNote a topicKind only for a typed topic on an ordinary map', async () => {
  const seen = [];
  for (const [kind, options] of [['topic', {}], ['hypothesis', {}], ['conclusion', {}], ['action', { aim: true }]]) {
    const f = heFixture(options);
    f.view.path = 'Agent Workspace/Topics/map-a/Map.md';
    f.view.plugin.repo.createNote = async (...args) => { seen.push([kind, args[args.length - 1]]); throw new Error('stop'); };
    await f.view.addNode(null, 'Title', true, false, kind).catch(error => assert.equal(error.message, 'stop'));
  }
  assert.deepEqual(plain(seen), [['topic', { researchMode: 'local' }], ['hypothesis', { researchMode: 'local', topicKind: 'hypothesis' }], ['conclusion', { researchMode: 'local', topicKind: 'conclusion' }], ['action', { researchMode: 'local' }]]);
});
integrationTest('hypothesis-evidence: switching the type is one undoable step; undo and redo leave id, parentId and relations as they were, and the strength stays in the file', async () => {
  const { fixture, DEFAULT_SETTINGS: settings } = require('../support.cjs');
  const { begin } = load('experiences/visual-map/map-transaction.ts', { obsidian });
  const { repo, contents } = fixture('en', { linkIndex: true });
  repo.settings = { ...settings, language: 'en' };
  const MAP = 'Agent Workspace/Topics/map-k/Map.md';
  const doc = { id: 'map-k', title: 'k', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-k');
  await repo.app.vault.create(MAP, core.serializeMap(doc));
  const parent = await repo.createNote('Parent', 'gpt-6-luna', doc, MAP, 'workspace');
  doc.nodes.push(parent);
  const child = await repo.createNote('Child', 'gpt-6-luna', doc, MAP, 'workspace', { topicKind: 'hypothesis' });
  child.parentId = parent.id; doc.nodes.push(child);
  doc.topicRelations = [{ kind: 'supports', from: child.id, to: parent.id }];
  await repo.saveMap(MAP, doc);
  const { view } = heFixture({ topics: [parent, child] });
  const deps = { repo, rebuildDerivedData: async () => {}, onApplied() {}, checkConflict: async () => {} };
  view.path = MAP; view.plugin.repo = repo; view.map = await repo.readMap(MAP); view.notes = new Map();
  view.beginMapTransaction = () => begin(deps);
  view.refreshAfterSavedChange = async () => { view.map = await repo.readMap(MAP); for (const n of view.map.nodes) view.notes.set(n.id, await repo.readNote(n.path, view.map)); };
  const pushed = []; view.history = { push: entry => pushed.push(entry) };
  await view.refreshAfterSavedChange();
  const frame = async () => plain({ ids: view.map.nodes.map(n => [n.id, n.parentId]), rel: view.map.topicRelations, kind: (await repo.readNote(child.path)).topicKind, strength: (await repo.readNote(child.path)).hypothesisStrength, text: contents.get(child.path).match(/topic-kind:.*|hypothesis-(?:leaning|strength):.*/g)?.map(line => line.replace(/"/g, '')) });
  const before = await frame();
  assert.equal(before.kind, 'hypothesis'); assert.deepEqual(before.text, ['topic-kind: hypothesis', 'hypothesis-leaning: undecided', 'hypothesis-strength: none']);
  await view.changeTopicKind(view.map.nodes[1], 'evidence');
  assert.equal(pushed.length, 1, 'one history entry');
  const evidence = await frame();
  assert.equal(evidence.kind, 'evidence'); assert.deepEqual(evidence.text, ['topic-kind: evidence', 'hypothesis-leaning: undecided', 'hypothesis-strength: none'], 'the leaning and strength stay in the file');
  assert.deepEqual([evidence.ids, evidence.rel], [before.ids, before.rel]);
  await pushed[0].undo(); assert.deepEqual(await frame(), before);
  await pushed[0].redo(); assert.deepEqual(await frame(), evidence);
  await pushed[0].undo();
  await view.refreshAfterSavedChange();
  await view.changeTopicKind(view.map.nodes[1], 'topic');
  assert.deepEqual((await frame()).text, ['hypothesis-leaning: undecided', 'hypothesis-strength: none'], 'an ordinary topic drops topic-kind only');
  assert.equal(pushed.length, 2); assert.equal(pushed[1] !== pushed[0], true);
  await view.changeTopicKind(view.map.nodes[1], 'topic');
  assert.equal(pushed.length, 2, 'choosing the current type does nothing');
});
integrationTest('hypothesis-leaning: changeHypothesisLeaning is one history entry; the leaning and the lifted strength undo and redo together, updated and other lines untouched', async () => {
  const { fixture, DEFAULT_SETTINGS: settings } = require('../support.cjs');
  const { begin } = load('experiences/visual-map/map-transaction.ts', { obsidian });
  const { repo, contents } = fixture('en', { linkIndex: true });
  repo.settings = { ...settings, language: 'en' };
  const MAP = 'Agent Workspace/Topics/map-l/Map.md';
  const doc = { id: 'map-l', title: 'l', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-l');
  await repo.app.vault.create(MAP, core.serializeMap(doc));
  const hyp = await repo.createNote('Claim', 'gpt-6-luna', doc, MAP, 'workspace', { topicKind: 'hypothesis' });
  doc.nodes.push(hyp);
  await repo.saveMap(MAP, doc);
  const { view } = heFixture({ topics: [hyp] });
  const deps = { repo, rebuildDerivedData: async () => {}, onApplied() {}, checkConflict: async () => {} };
  view.path = MAP; view.plugin.repo = repo; view.map = await repo.readMap(MAP); view.notes = new Map();
  view.beginMapTransaction = () => begin(deps);
  view.refreshAfterSavedChange = async () => { view.map = await repo.readMap(MAP); for (const n of view.map.nodes) view.notes.set(n.id, await repo.readNote(n.path, view.map)); };
  const pushed = []; view.history = { push: entry => pushed.push(entry) };
  await view.refreshAfterSavedChange();
  const keys = () => (contents.get(hyp.path).match(/hypothesis-(?:leaning|strength):.*/g) ?? []).map(line => line.replace(/"/g, ''));
  const fileWithout = () => contents.get(hyp.path).split('\n').filter(l => !/^hypothesis-(leaning|strength):/.test(l)).join('\n');
  const start = contents.get(hyp.path), updated = (await repo.readNote(hyp.path)).updated;
  assert.deepEqual(keys(), ['hypothesis-leaning: undecided', 'hypothesis-strength: none']);
  await view.changeHypothesisLeaning(view.map.nodes[0], 'supported');
  assert.equal(pushed.length, 1, 'one history entry');
  assert.deepEqual(keys(), ['hypothesis-leaning: supported', 'hypothesis-strength: weak'], 'both lines in one write');
  assert.equal((await repo.readNote(hyp.path)).updated, updated, 'updated is not bumped');
  const after = contents.get(hyp.path);
  await pushed[0].undo();
  assert.deepEqual(keys(), ['hypothesis-leaning: undecided', 'hypothesis-strength: none'], 'undo puts both lines back');
  assert.equal(contents.get(hyp.path), start);
  await pushed[0].redo();
  assert.equal(contents.get(hyp.path), after, 'redo writes both lines again');
  assert.equal(fileWithout(), start.split('\n').filter(l => !/^hypothesis-(leaning|strength):/.test(l)).join('\n'), 'no other line changes');
  await view.changeHypothesisLeaning(view.map.nodes[0], 'undecided');
  assert.deepEqual(keys(), ['hypothesis-leaning: undecided', 'hypothesis-strength: weak'], 'going back to undecided keeps the strength');
});
integrationTest('hypothesis-leaning: the panel shows a Leaning group (Supported, Undecided, Refuted) with aria-pressed only for a hypothesis, and the focus stays on the pressed leaning', async () => {
  const { view } = heFixture();
  view.enqueue = work => work();
  const tx = { rewriteNote(p, write) { tx.write = write; return tx; }, editMap() { return tx; }, async commit() { await tx.write('hyp.md'); return { undo() {}, redo() {} }; } };
  const written = [];
  view.beginMapTransaction = () => tx; view.history = { push() {} };
  view.plugin.repo.writeHypothesisLeaning = async (path, leaning) => written.push([path, leaning]);
  view.refreshAfterSavedChange = async () => { view.notes.get('hyp').hypothesisLeaning = written.at(-1)[1]; };
  const plainPanel = dom.element('panel'); view.renderHypothesisSection(plainPanel, view.map.nodes[0]);
  assert.ok(!dom.find(plainPanel, c => (c.cls ?? '').includes('vam-hypothesis-leanings')), 'no leaning control for an ordinary topic');
  const panel = dom.element('panel'); view.renderHypothesisSection(panel, view.map.nodes[1]);
  const group = () => dom.find(panel, c => (c.cls ?? '').includes('vam-hypothesis-leanings'));
  assert.equal(group().attrs.role, 'group'); assert.equal(group().attrs['aria-label'], 'Leaning');
  const buttons = () => dom.findAll(group(), c => c.tag === 'button');
  assert.deepEqual(buttons().map(c => c.text), ['Supported', 'Undecided', 'Refuted']);
  const pressed = () => buttons().filter(c => c.attrs['aria-pressed'] === 'true').map(c => c.text);
  assert.deepEqual(pressed(), ['Undecided']);
  dom.button(group(), 'Undecided').click();
  assert.equal(written.length, 0, 'choosing the current leaning does nothing');
  dom.button(group(), 'Refuted').click(); await dom.tick();
  assert.deepEqual(written, [['hyp.md', 'refuted']]);
  assert.deepEqual(pressed(), ['Refuted']);
  assert.deepEqual(buttons().filter(c => c.focused).map(c => c.text), ['Refuted'], 'focus stays on the button that is now pressed');
});
integrationTest('hypothesis-leaning: with a leaning the None strength is aria-disabled with the reason and does nothing; undecided enables it', async () => {
  const notes = heNotes([['fact', {}], ['hyp', heHyp('weak', 'supported')], ['other', {}]]);
  const { view } = heFixture({ notes });
  view.enqueue = work => work();
  const writes = [];
  view.plugin.repo.writeHypothesisStrength = async (path, strength) => writes.push([path, strength]);
  view.beginMapTransaction = () => assert.fail('no transaction for a blocked None');
  const panel = dom.element('panel'); view.renderHypothesisSection(panel, view.map.nodes[1]);
  const none = dom.button(panel, 'None');
  assert.equal(none.attrs['aria-disabled'], 'true'); assert.match(none.attrs['aria-description'], /at least Weak/);
  none.click(); await dom.tick();
  assert.deepEqual(writes, []);
  const free = heFixture({ notes: heNotes([['fact', {}], ['hyp', heHyp('strong', 'undecided')], ['other', {}]]) });
  const freePanel = dom.element('panel'); free.view.renderHypothesisSection(freePanel, free.view.map.nodes[1]);
  assert.equal(dom.button(freePanel, 'None').attrs['aria-disabled'], undefined, 'undecided leaves None enabled');
});
integrationTest('hypothesis-leaning: a card reads Hypothesis · Undecided when undecided with no strength, otherwise Hypothesis · leaning · strength, in the visible tag and the accessible name', () => {
  const render = (extra) => {
    const f = heFixture({ notes: heNotes([['fact', {}], ['hyp', { topicKind: 'hypothesis', ...extra }], ['other', {}]]) });
    f.view.stageEl = hePatch(dom.element('stage')); f.view.renderNode(f.view.map.nodes.find(n => n.id === 'hyp'));
    const card = f.view.stageEl.children[0];
    return { text: dom.texts(card), label: dom.find(card, c => (c.cls ?? '').split(/\s+/).includes('vam-card-label')).text, tag: dom.find(card, c => (c.cls ?? '').split(/\s+/).includes('vam-hypothesis-tag')) };
  };
  const cases = [
    [{}, 'Hypothesis · Undecided'],
    [{ hypothesisLeaning: 'undecided', hypothesisStrength: 'none' }, 'Hypothesis · Undecided'],
    [{ hypothesisLeaning: 'supported', hypothesisStrength: 'weak' }, 'Hypothesis · Supported · Weak'],
    [{ hypothesisLeaning: 'refuted', hypothesisStrength: 'strong' }, 'Hypothesis · Refuted · Strong'],
    [{ hypothesisLeaning: 'undecided', hypothesisStrength: 'strong' }, 'Hypothesis · Undecided · Strong']
  ];
  for (const [extra, expected] of cases) {
    const r = render(extra);
    assert.ok(r.text.includes(expected), `visible: ${expected}`);
    assert.ok(r.label.includes(expected), `accessible name: ${expected}`);
    assert.equal(r.tag.text, expected);
  }
  assert.equal(render({ hypothesisLeaning: 'supported', hypothesisStrength: 'weak' }).tag.dataset.leaning, 'supported');
});
test('hypothesis-leaning: i18n has the leaning, strength none and tag keys in all three languages with the glossary words', () => {
  const read = lang => fs.readFileSync(path.join(root, 'i18n', `${lang}.ts`), 'utf8');
  const words = { en: ['Supported', 'Undecided', 'Refuted', 'None', 'Leaning'], 'zh-TW': ['被支持', '未定', '被反駁', '無', '傾向'], 'zh-CN': ['被支持', '未定', '被反驳', '无', '倾向'] };
  for (const lang of Object.keys(words)) {
    const text = read(lang);
    ['ui.hypothesis_supported', 'ui.hypothesis_undecided', 'ui.hypothesis_refuted', 'ui.hypothesis_none', 'ui.hypothesis_leaning'].forEach((key, i) => assert.ok(text.includes(`"${key}": "${words[lang][i]}"`), `${lang} ${key}`));
    for (const key of ['ui.hypothesis_tag_undecided', 'ui.hypothesis_tag_0_1', 'ui.hypothesis_none_disabled']) assert.ok(text.includes(`"${key}"`), `${lang} ${key}`);
  }
});
integrationTest('hypothesis-evidence: a non-ordinary topic sets data-topic-kind and names its type on the card; an ordinary topic sets nothing; AIM shows neither', () => {
  const render = (options, id) => {
    const f = heFixture(options); f.view.stageEl = hePatch(dom.element('stage')); f.view.renderNode(f.view.map.nodes.find(n => n.id === id));
    const card = f.view.stageEl.children[0]; return { card, label: dom.find(card, c => (c.cls ?? '').split(/\s+/).includes('vam-card-label')) };
  };
  const notes = heNotes([['fact', { topicKind: 'evidence' }], ['hyp', heHyp('strong')], ['other', {}]]);
  const evidence = render({ notes }, 'fact');
  assert.equal(evidence.card.dataset.topicKind, 'evidence'); assert.match(evidence.label.text, /Evidence/);
  assert.equal(evidence.card.attrs['aria-labelledby'], evidence.label.id);
  const hyp = render({ notes }, 'hyp');
  assert.equal(hyp.card.dataset.topicKind, 'hypothesis'); assert.match(hyp.label.text, /Hypothesis · Undecided · Strong/);
  for (const kind of ['action', 'atomic', 'conclusion']) {
    const card = render({ notes: heNotes([['fact', { topicKind: kind }], ['hyp', {}], ['other', {}]]) }, 'fact');
    assert.equal(card.card.dataset.topicKind, kind); assert.match(card.label.text, new RegExp(heKindNames[heKindIds.indexOf(kind)]));
  }
  const plainCard = render({ notes }, 'other');
  assert.equal('topicKind' in plainCard.card.dataset, false, 'an ordinary topic has no data-topic-kind'); assert.doesNotMatch(plainCard.label.text, /Evidence|Hypothesis|Action|Conclusion|Atomic/);
  const aim = render({ aim: true, notes }, 'fact');
  assert.equal('topicKind' in aim.card.dataset, false); assert.doesNotMatch(aim.label.text, /Evidence/);
});
integrationTest('hypothesis-evidence: an AIM map has no type menu, no add-subtopic entry, no type control, and refuse a switch', async () => {
  for (const options of [{ aim: true }]) {
    const { view, menus, writes } = heFixture(options);
    const tools = dom.element('tools'); view.renderMapTools(tools);
    assert.deepEqual(dom.buttons(tools), [], `toolbar ${JSON.stringify(options)}`);
    const panel = dom.element('panel'); view.renderHypothesisSection(panel, view.map.nodes[2]);
    assert.deepEqual(dom.buttons(panel), [], `panel ${JSON.stringify(options)}`);
    view.beginMapTransaction = () => assert.fail('no transaction');
    await view.changeTopicKind(view.map.nodes[2], 'evidence');
    assert.deepEqual(writes, []);
  }
});
integrationTest('hypothesis-evidence: the panel type control is a labelled group with aria-pressed, shows strength only for a hypothesis, and keeps focus on the pressed type after a switch', async () => {
  const { view } = heFixture();
  view.enqueue = work => work();
  const tx = { rewriteNote(p, write) { tx.write = write; tx.path = p; return tx; }, editMap() { return tx; }, async commit() { await tx.write(tx.path); return { undo() {}, redo() {} }; } };
  view.beginMapTransaction = () => tx; view.history = { push() {} };
  view.refreshAfterSavedChange = async () => { for (const [id, kind] of view.pendingKinds) { const note = view.notes.get(id); if (kind === 'topic') delete note.topicKind; else note.topicKind = kind; } };
  view.pendingKinds = new Map();
  view.plugin.repo.writeTopicKind = async (path, kind) => view.pendingKinds.set(path.replace('.md', ''), kind);
  const panel = dom.element('panel'); view.renderHypothesisSection(panel, view.map.nodes[0]);
  const group = () => dom.find(panel, c => (c.cls ?? '').includes('vam-topic-kinds'));
  assert.equal(group().attrs.role, 'group'); assert.equal(group().attrs['aria-label'], 'Topic type');
  const pressed = () => dom.findAll(group(), c => c.tag === 'button' && c.attrs['aria-pressed'] === 'true').map(c => c.text);
  assert.deepEqual(dom.findAll(group(), c => c.tag === 'button').map(c => c.text), heDialogKindNames, 'dialog order of spec section 2 (decision 35 C4); the menus keep the TOPIC_KINDS order');
  assert.deepEqual(pressed(), ['Topic']);
  const strengths = () => dom.buttons(panel).filter(label => ['None', 'Weak', 'Medium', 'Strong'].includes(label));
  assert.deepEqual(strengths(), [], 'no strength control for an ordinary topic');
  dom.button(group(), 'Hypothesis').click(); await dom.tick();
  assert.deepEqual(pressed(), ['Hypothesis']); assert.deepEqual(strengths(), ['None', 'Weak', 'Medium', 'Strong'], 'the strength control follows the type');
  const focused = dom.findAll(group(), c => c.focused);
  assert.deepEqual(focused.map(c => c.text), ['Hypothesis'], 'focus stays on the control that is now pressed');
  dom.button(group(), 'Evidence').click(); await dom.tick();
  assert.deepEqual(pressed(), ['Evidence']); assert.deepEqual(strengths(), [], 'the strength control is hidden for any other type');
  assert.deepEqual(dom.findAll(group(), c => c.focused).map(c => c.text).includes('Evidence'), true);
});
integrationTest('hypothesis-evidence: the chat-guard message names the type and strength fields in all three languages, and the old add-hypothesis keys are gone', () => {
  const read = lang => fs.readFileSync(path.join(root, 'i18n', `${lang}.ts`), 'utf8');
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const text = read(lang);
    assert.doesNotMatch(text, /"ui\.(add_hypothesis|new_hypothesis|add_subhypothesis|new_subhypothesis)"/, lang);
    for (const key of [...heKindIds.map(k => `ui.topic_kind_${k}`), 'ui.topic_type', 'ui.add_subtopic_menu']) assert.ok(text.includes(`"${key}"`), `${lang} ${key}`);
  }
  assert.match(read('zh-TW'), /類型或強度欄位/); assert.match(read('zh-CN'), /类型或强度字段/); assert.match(read('en'), /type or hypothesis fields/);
});
integrationTest('hypothesis-evidence: every topic type has the add-relation entry; only a hypothesis has the strength control', () => {
  const { view } = heFixture();
  const hypPanel = dom.element('panel'); view.renderHypothesisSection(hypPanel, view.map.nodes[1]);
  assert.ok(heKindSelect(hypPanel), 'a hypothesis can start a relation of any kind');
  assert.deepEqual(dom.buttons(hypPanel).filter(label => ['None', 'Weak', 'Medium', 'Strong'].includes(label)), ['None', 'Weak', 'Medium', 'Strong']);
  const factPanel = dom.element('panel'); view.renderHypothesisSection(factPanel, view.map.nodes[0]);
  assert.ok(heKindSelect(factPanel));
  assert.deepEqual(dom.buttons(factPanel).filter(label => ['None', 'Weak', 'Medium', 'Strong'].includes(label)), []);
});
integrationTest('hypothesis-evidence: the supports picker offers every topic that can newly be supported (any type), and with none it shows a Notice and no dialog', () => {
  const topics = [node('fact'), node('hyp'), node('linked'), node('plain'), node('hyp2')];
  const notes = heNotes([['fact', {}], ['hyp', heHyp('weak')], ['linked', heHyp('strong')], ['plain', {}], ['hyp2', heHyp()]]);
  const { view } = heFixture({ topics, notes, relations: [{ kind: 'supports', from: 'fact', to: 'linked' }] });
  const fx0 = { view };
  assert.deepEqual(heTargetsOf(fx0, 'supports', 'fact'), ['hyp', 'plain', 'hyp2'], 'not itself, not an already linked topic; ordinary topics are allowed');
  const fromHyp = heFixture({ topics, notes });
  assert.ok(heTargetsOf(fromHyp, 'supports', 'hyp').length > 0, 'a hypothesis can be the source of supports');
  const two = [node('a'), node('b')];
  const none = heFixture({ topics: two, notes: heNotes([['a', {}], ['b', {}]]), relations: [{ kind: 'supports', from: 'a', to: 'b' }] });
  const nonePanel = dom.element('panel'); none.view.renderHypothesisSection(nonePanel, none.view.map.nodes[0]);
  assert.deepEqual(heTargetIds(nonePanel, 'supports'), []); assert.equal(heTargetSelect(nonePanel).disabled, true, 'nothing to pick: the list is off');
  assert.equal(dom.findAll(heTargetSelect(nonePanel), c => c.tag === 'option')[0].text, 'There is no topic this one can be linked to with “Supports”.');
});
integrationTest('hypothesis-evidence: a hypothesis card shows "Hypothesis · strength" and carries it in its accessible name; an ordinary topic and an AIM map do not', () => {
  const render = (options, id) => {
    const f = heFixture(options); f.view.stageEl = hePatch(dom.element('stage')); f.view.renderNode(f.view.map.nodes.find(n => n.id === id));
    const card = f.view.stageEl.children[0]; return { card, text: dom.texts(card), label: dom.find(card, c => hasLabel(c)) };
  };
  const hasLabel = c => (c.cls ?? '').split(/\s+/).includes('vam-card-label');
  const strong = render({ notes: heNotes([['fact', {}], ['hyp', heHyp('strong')], ['other', {}]]) }, 'hyp');
  assert.ok(strong.text.includes('Hypothesis · Undecided · Strong'), 'visible tag'); assert.equal(strong.card.dataset.topicKind, 'hypothesis');
  assert.match(strong.label.text, /Hypothesis · Undecided · Strong/, 'the card name (aria-labelledby target) carries the strength');
  assert.equal(strong.card.attrs['aria-labelledby'], strong.label.id);
  assert.ok(render({ notes: heNotes([['fact', {}], ['hyp', heHyp()], ['other', {}]]) }, 'hyp').text.includes('Hypothesis · Undecided'), 'undecided and none by default');
  assert.ok(render({}, 'hyp').text.includes('Hypothesis · Undecided · Weak'), 'a stored weak under no leaning');
  const plain = render({}, 'fact');
  assert.equal(plain.card.dataset.topicKind, undefined); assert.equal(plain.text.some(t => /Hypothesis/.test(t)), false);
  const aim = render({ aim: true }, 'hyp');
  assert.equal(aim.card.dataset.topicKind, undefined, 'no hypothesis styling on an AIM map'); assert.equal(aim.text.some(t => /Hypothesis/.test(t)), false);
});
integrationTest('hypothesis-evidence: styles.css gives a hypothesis no 2px card frame any more (its shape outline replaces it) and the evidence line its own dash pattern', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const rule = selector => { const m = css.match(new RegExp(`^${selector.replace(/[.[\]"=-]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm')); assert.ok(m, `rule ${selector}`); return m[1]; };
  assert.doesNotMatch(css, /^\[data-topic-kind="hypothesis"\]\.vam-node\s*\{[^}]*border-width/m, 'the V1.5 2px hypothesis frame is gone: the shape outline replaces it (decision 23)');
  const dash = rule('.vam-relation-contradicts').match(/stroke-dasharray:\s*([^;]+);/)[1].trim();
  assert.notEqual(dash, '5 5', 'differs from the AIM convergence line'); assert.ok(!/^none$/.test(dash), 'not the solid parent-child line');
  assert.match(css, /\.vam-edge \{[^}]*\}/); assert.doesNotMatch(rule('.vam-edge'), /dasharray/);
  assert.match(rule('.vam-edges'), /pointer-events:\s*none/); assert.match(rule('.vam-relation'), /pointer-events:\s*none/);
});
integrationTest('hypothesis-evidence: a parent and child that also hold a relation draw only the relation line; other parent lines, AIM maps and the sample keep theirs (decision 39)', () => {
  const topics = [node('root'), node('kid', 'root'), node('other', 'root')], boxes = { root: [0, 0], kid: [500, 0], other: [500, 200] };
  const fx = heFixture({ topics, relations: [{ kind: 'contradicts', from: 'root', to: 'kid' }], notes: heNotes([['root', {}], ['kid', {}], ['other', {}]]) });
  const kids = heDrawn(fx.view, boxes), edges = kids.filter(k => (k.classes ?? []).includes('vam-edge'));
  assert.equal(edges.length, 1, 'only root -> other keeps its parent line'); assert.ok(kids.some(k => (k.classes ?? []).includes('vam-relation-contradicts')), 'the relation line is drawn');
  fx.view.map.topicRelations = [{ kind: 'related', from: 'kid', to: 'root' }];
  assert.equal(heDrawn(fx.view, boxes).filter(k => (k.classes ?? []).includes('vam-edge')).length, 1, 'either direction and any kind hide the parent line');
  fx.view.map.topicRelations = [];
  assert.equal(heDrawn(fx.view, boxes).filter(k => (k.classes ?? []).includes('vam-edge')).length, 2, 'without a relation both parent lines are drawn');
  fx.view.map.topicRelations = [{ kind: 'supports', from: 'root', to: 'kid' }]; fx.view.map.aim = { mode: 'x' };
  assert.equal(heDrawn(fx.view, boxes).filter(k => (k.classes ?? []).includes('vam-edge')).length, 2, 'an AIM map draws no relation, so it keeps every parent line');
});
integrationTest('hypothesis-evidence: an evidence line is drawn from the fact to the hypothesis with an arrowhead whose marker id is unique per view', () => {
  const relations = [{ kind: 'supports', from: 'fact', to: 'hyp' }];
  const a = heFixture({ relations }), b = heFixture({ relations, shared: { VisualAgentMapView: a.VisualAgentMapView } });
  const kidsA = heDrawn(a.view, { fact: [0, 0], hyp: [500, 40], other: [0, 200] });
  const kidsB = heDrawn(b.view, { fact: [0, 0], hyp: [500, 40], other: [0, 200] });
  const lineA = kidsA.find(k => k.classes.includes('vam-relation-supports'));
  assert.ok(lineA.classes.includes('vam-relation')); assert.match(lineA.attrs.d, /^M 280 50 C /, 'starts at the fact (right edge) and ends at the hypothesis (left edge)'); assert.match(lineA.attrs.d, / 500 90$/);
  const defs = kidsA.find(k => k.tag === 'defs'), marker = defs.children[0];
  assert.equal(lineA.attrs['marker-end'], `url(#${marker.attrs.id})`);
  const lineB = kidsB.find(k => k.classes.includes('vam-relation-supports')), markerB = kidsB.find(k => k.tag === 'defs').children[0];
  assert.notEqual(marker.attrs.id, markerB.attrs.id, 'two views never share a marker id'); assert.equal(lineB.attrs['marker-end'], `url(#${markerB.attrs.id})`);
  assert.equal(kidsA.filter(k => k.classes.includes('vam-edge')).length, 0, 'the parent-child edges are not touched');
  a.view.map.aim = { mode: 'x' };
  assert.equal(heDrawn(a.view, { fact: [0, 0], hyp: [500, 40], other: [0, 200] }).length, 0, 'an AIM map draws no evidence');
  assert.equal(a.view.map.topicRelations.length, 1, 'and the file keeps the key');
});
integrationTest('hypothesis-evidence: a supports link is drawn whatever the type of either end (no type rule, nothing logged); an off-screen end is skipped quietly', () => {
  const relations = [{ kind: 'supports', from: 'hyp', to: 'fact' }, { kind: 'supports', from: 'fact', to: 'other' }, { kind: 'supports', from: 'other', to: 'hyp' }];
  const { view, logs } = heFixture({ relations });
  let kids = heDrawn(view, { fact: [0, 0], hyp: [500, 0], other: [0, 200] });
  assert.equal(kids.filter(k => k.classes.includes('vam-relation-supports')).length, 3, 'hypothesis -> topic, topic -> topic and topic -> hypothesis are all drawn');
  assert.deepEqual(logs, [], 'no type-violation warning');
  assert.equal(view.map.topicRelations.length, 3, 'nothing is deleted from the file');
  kids = heDrawn(view, { fact: [0, 0], other: [0, 200] });
  assert.equal(kids.filter(k => k.classes.includes('vam-relation-supports')).length, 1, 'a collapsed (missing) end is not drawn'); assert.deepEqual(logs, [], 'and not logged');
});
integrationTest('hypothesis-evidence: the add-relation sentence creates the chosen kind from the topic, for an ordinary topic and a hypothesis alike', async () => {
  const { view, doc } = heFixture();
  view.enqueue = work => work(); view.mapChange = async (change) => { change(view.map); };
  const first = dom.element('panel'); view.renderHypothesisSection(first, view.map.nodes[0]);
  const second = dom.element('panel'); view.renderHypothesisSection(second, view.map.nodes[1]);
  assert.deepEqual(dom.findAll(heKindSelect(first), c => c.tag === 'option').map(o => o.text), ['Supports', 'Contradicts', 'Verifies', 'Derives from', 'Related', 'Prerequisite']);
  await heAddRelation(first, 'supports', 'other'); await heAddRelation(second, 'contradicts', 'fact');
  assert.deepEqual(plain(doc.topicRelations), [{ kind: 'supports', from: 'fact', to: 'other' }, { kind: 'contradicts', from: 'hyp', to: 'fact' }], 'the panel topic is A; the kind is the one picked');
  assert.equal(doc.topicRelations.some(r => r.kind === 'evidence'), false);
});
integrationTest('hypothesis-evidence: dragging a card moves the evidence line with it', () => {
  const { view } = heFixture({ relations: [{ kind: 'supports', from: 'fact', to: 'hyp' }] });
  const kids = heDrawn(view, { fact: [0, 0], hyp: [500, 40], other: [0, 200] });
  const line = kids.find(k => k.classes.includes('vam-relation-supports')), before = line.attrs.d;
  const drag = view.dragEdges('fact', view.cardEls.get('fact')); drag.update(0, 300);
  assert.notEqual(line.attrs.d, before); assert.match(line.attrs.d, /^M 280 350 C /);
  const dragHyp = view.dragEdges('hyp', view.cardEls.get('hyp')); dragHyp.update(900, 0);
  assert.match(line.attrs.d, / 900 50$/);
});
integrationTest('hypothesis-evidence: the barred marker puts the bar on the line before the arrowhead base, and both tips sit on refX (R3-1)', () => {
  const { kids } = heSix();
  const [arrow, bar] = kids.find(k => k.tag === 'defs').children;
  const tip = m => Math.max(...heNums(m.children[0].attrs.d).filter((_, i) => i % 2 === 0));
  const baseX = m => Math.min(...heNums(m.children[0].attrs.d).filter((_, i) => i % 2 === 0));
  assert.equal(arrow.attrs.refX, '10'); assert.equal(tip(arrow), Number(arrow.attrs.refX), 'plain arrow: the tip is the reference point, so it stops at the card edge');
  assert.equal(tip(bar), Number(bar.attrs.refX), 'barred arrow: the tip is the reference point');
  assert.equal(Number(bar.attrs.viewBox.split(' ')[2]), tip(bar), 'nothing is drawn past the tip, where the opaque card would hide it');
  const barX = heNums(bar.children[1].attrs.d).filter((_, i) => i % 2 === 0);
  assert.equal(new Set(barX).size, 1, 'the bar is vertical'); assert.ok(barX[0] >= 0 && barX[0] <= baseX(bar), `bar x ${barX[0]} is on the line, before the arrowhead base ${baseX(bar)}`);
  assert.ok(baseX(bar) < tip(bar));
});
const heGoldenGeometry = [
  [[0, 0], [500, 0], 'M 280 50 C 340 50, 440 50, 500 50', { x: 390, y: 50 }],
  [[500, 0], [0, 0], 'M 500 50 C 440 50, 340 50, 280 50', { x: 390, y: 50 }],
  [[0, 0], [0, 200], 'M 140 100 C 140 150, 140 150, 140 200', { x: 140, y: 150 }],
  [[0, 200], [0, 0], 'M 140 200 C 140 150, 140 150, 140 100', { x: 140, y: 150 }],
  [[0, 0], [290, 0], 'M 280 50 C 296 50, 274 50, 290 50', { x: 285, y: 50 }],
  [[0, 0], [1000, 0], 'M 280 50 C 340 50, 940 50, 1000 50', { x: 640, y: 50 }],
  [[0, 0], [100, 40], 'M 140 50 C 140 50, 240 90, 240 90', { x: 190, y: 70 }],
  [[0, 0], [500, 40], 'M 280 50 C 340 50, 440 90, 500 90', { x: 390, y: 70 }],
  [[0, 0], [420, 239], 'M 280 50 C 340 50, 360 289, 420 289', { x: 350, y: 169.5 }],
  [[0, 0], [419, 240], 'M 140 100 C 140 160, 559 180, 559 240', { x: 349.5, y: 170 }],
  [[0, 0], [400, 260], 'M 140 100 C 140 160, 540 200, 540 260', { x: 340, y: 180 }],
  [[0, 0], [120, 300], 'M 140 100 C 140 160, 260 240, 260 300', { x: 200, y: 200 }]
];
integrationTest('hypothesis-evidence: relation-geometry has no offset API (one relation per pair, decision #37); a single line keeps its nearest-side path and midpoint label', () => {
  const geo = heGeo();
  assert.deepEqual(Object.keys(geo).filter(name => /offset|lane/i.test(name)), [], 'no relationOffsets, RELATION_OFFSET_STEP or RELATION_LABEL_LANE export');
  assert.equal(geo.relationOffsets, undefined);
  assert.equal(geo.relationPathData.length, 2, 'the path takes two cards and no offset');
  assert.equal(geo.relationLabelPoint.length, 2, 'the label point takes two cards and no offset');
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/relation-geometry.ts'), 'utf8'), view = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.doesNotMatch(source, /offset/i, 'the geometry file never mentions an offset');
  assert.doesNotMatch(view, /relationOffset/, 'the view keeps no per-line offset');
  // Goldens taken from the pre-change code at offset 0: a lone line is byte-identical.
  for (const [a, b, path, label] of heGoldenGeometry) {
    assert.equal(geo.relationPathData(heBox(...a), heBox(...b)), path, `path ${JSON.stringify([a, b])}`);
    assert.deepEqual(plain(geo.relationLabelPoint(heBox(...a), heBox(...b))), label, `label ${JSON.stringify([a, b])}`);
  }
  assert.equal(geo.relationPathData(heBox(0, 0, 200, 60), heBox(300, 200, 100, 300)), 'M 100 60 C 100 120, 350 140, 350 200');
  assert.deepEqual(plain(geo.relationLabelPoint(heBox(0, 0, 200, 60), heBox(300, 200, 100, 300))), { x: 225, y: 130 });
  for (const [a, b] of heGoldenGeometry) {
    const [x1, y1, cx1, cy1, cx2, cy2, x2, y2] = heNums(geo.relationPathData(heBox(...a), heBox(...b)));
    assert.deepEqual(plain(geo.relationLabelPoint(heBox(...a), heBox(...b))), { x: (x1 + 3 * cx1 + 3 * cx2 + x2) / 8, y: (y1 + 3 * cy1 + 3 * cy2 + y2) / 8 }, 'the label is the curve at t = 0.5');
  }
});
integrationTest('hypothesis-evidence: relations on different pairs are each one nearest-side line with its label at the line midpoint; path, hit, derives-from gap and label move together on a drag (decision #37, was R3-2)', () => {
  const rel = [{ kind: 'supports', from: 'fact', to: 'hyp' }, { kind: 'derives_from', from: 'fact', to: 'other' }, { kind: 'contradicts', from: 'other', to: 'hyp' }];
  const fx = heFixture({ relations: rel });
  const kids = heDrawn(fx.view, { fact: [0, 0], hyp: [500, 0], other: [0, 300] });
  const ys = cls => kids.filter(k => k.classes.includes(cls));
  const supports = ys('vam-relation-supports')[0], derives = ys('vam-relation-derives_from')[0], contradicts = ys('vam-relation-contradicts')[0], gap = ys('vam-relation-gap')[0];
  assert.equal(supports.attrs.d, 'M 280 50 C 340 50, 440 50, 500 50');
  assert.equal(derives.attrs.d, 'M 140 100 C 140 160, 140 240, 140 300');
  assert.equal(contradicts.attrs.d, 'M 280 350 C 340 350, 440 50, 500 50');
  assert.equal(gap.attrs.d, derives.attrs.d, 'the inner gap line follows its line');
  const hits = ys('vam-relation-hit').map(h => h.attrs.d);
  for (const line of [supports, derives, contradicts]) assert.ok(hits.includes(line.attrs.d), 'every line has a hit path on the same curve');
  assert.deepEqual(ys('vam-relation-label').map(l => [l.attrs.x, l.attrs.y]), [['390', '50'], ['140', '200'], ['390', '200']], 'each label is the midpoint of its own line');
  const drag = fx.view.dragEdges('fact', fx.view.cardEls.get('fact')); drag.update(0, 100);
  assert.match(supports.attrs.d, /^M 280 150 C .* 500 50$/); assert.match(derives.attrs.d, /^M 140 200 C .* 140 300$/); assert.equal(contradicts.attrs.d, 'M 280 350 C 340 350, 440 50, 500 50', 'a line that does not touch the dragged card stays');
  assert.equal(gap.attrs.d, derives.attrs.d); assert.ok(ys('vam-relation-hit').map(h => h.attrs.d).includes(derives.attrs.d), 'the hit path follows too');
  const moved = ys('vam-relation-label')[0].attrs, expected = heGeo().relationLabelPoint(heBox(0, 100), heBox(500, 0));
  assert.deepEqual([Number(moved.x), Number(moved.y)], [expected.x, expected.y], 'and so does the label (the midpoint of the moved line)');
});
integrationTest('hypothesis-evidence: the labels drawn by the view equal relationLabelPoint after the draw and after a drag, in horizontal and vertical layouts (decision #37, was F6 #34)', () => {
  const { relationLabelPoint } = heGeo(), rel = [{ kind: 'supports', from: 'fact', to: 'hyp' }, { kind: 'prerequisite', from: 'other', to: 'fact' }];
  for (const [name, start, to] of [['horizontal gap 140', { fact: [0, 0], hyp: [420, 0], other: [0, 300] }, [700, 30]], ['horizontal gap 440', { fact: [0, 0], hyp: [720, 0], other: [0, 300] }, [420, 10]], ['vertical gap 175', { fact: [0, 0], hyp: [0, 275], other: [600, 0] }, [40, 380]], ['vertical to horizontal', { fact: [0, 0], hyp: [0, 275], other: [600, 0] }, [600, 0]]]) {
    const fx = heFixture({ relations: rel }), kids = heDrawn(fx.view, start), labels = () => kids.filter(k => k.classes.includes('vam-relation-label'));
    const expected = hypPos => [relationLabelPoint(heBox(...start.fact), heBox(...hypPos)), relationLabelPoint(heBox(...start.other), heBox(...start.fact))];
    const check = (hypPos, when) => {
      const exp = expected(hypPos);
      assert.equal(labels().length, 2);
      labels().forEach((l, i) => assert.deepEqual([Number(l.attrs.x), Number(l.attrs.y)], [exp[i].x, exp[i].y], `${name} ${when}: label ${i} is at relationLabelPoint`));
    };
    check(start.hyp, 'after draw');
    fx.view.dragEdges('hyp', fx.view.cardEls.get('hyp')).update(...to);
    check(to, 'after drag');
  }
});
integrationTest('hypothesis-evidence: after a relation is added from the panel the focus is on the new relation list of the sentence (R3-3)', async () => {
  const { view } = heFixture();
  view.enqueue = work => work(); view.mapChange = async (change) => { change(view.map); };
  const panel = dom.element('panel'); view.renderHypothesisSection(panel, view.map.nodes[0]);
  const before = heKindSelect(panel);
  await heAddRelation(panel, 'supports', 'other');
  const after = heKindSelect(panel);
  assert.notEqual(after, before, 'the panel was repainted, so the old control is gone');
  assert.ok(after.focused, 'the keyboard user lands on the replacement control, not on the body');
  assert.ok(!before.focused);
});
integrationTest('hypothesis-evidence: adding and removing a relation in the panel go through mapChange (undoable); an illegal target is refused', async () => {
  const { view, doc } = heFixture({ relations: [{ kind: 'supports', from: 'fact', to: 'hyp' }] });
  const changes = []; view.enqueue = work => work();
  view.mapChange = async (change, rebuild) => { changes.push(rebuild); change(view.map); };
  const factPanel = dom.element('panel'); view.renderHypothesisSection(factPanel, view.map.nodes[0]);
  assert.ok(dom.texts(factPanel).includes('This topic supports HYP'), 'the linked topic is listed as a sentence (C6)');
  const remove = dom.byLabel(factPanel, 'Remove relation: Supports → HYP'); assert.ok(remove);
  await remove.fire('click');
  await dom.tick();
  assert.equal(changes.length, 1); assert.equal(changes[0], false, 'no derived-data rebuild for a relation change');
  assert.equal('topicRelations' in doc, false, 'the empty list is dropped from Map.md');
  assert.equal(dom.byLabel(factPanel, 'Remove relation: Supports → HYP'), undefined, 'the row is gone after the change');
  await view.addRelation('fact', 'hyp', 'supports'); await view.addRelation('fact', 'hyp', 'supports'); await view.addRelation('fact', 'other', 'supports'); await view.addRelation('hyp', 'hyp', 'supports');
  assert.deepEqual(plain(doc.topicRelations), [{ kind: 'supports', from: 'fact', to: 'hyp' }, { kind: 'supports', from: 'fact', to: 'other' }], 'added once each; the duplicate and the self link are refused, an ordinary-topic target is allowed');
  assert.equal(changes.length, 5);
});
integrationTest('hypothesis-evidence: adding from the sentence repaints the open panel at once', async () => {
  const { view } = heFixture({ topics: [node('fact'), node('hyp'), node('pre')], notes: heNotes([['fact', {}], ['hyp', heHyp('weak')], ['pre', {}]]) });
  view.enqueue = work => work();
  view.mapChange = async (change, rebuild) => { change(view.map); };
  const factPanel = dom.element('panel'); view.renderHypothesisSection(factPanel, view.map.nodes[0]);
  assert.equal(dom.byLabel(factPanel, 'Remove relation: Supports → HYP'), undefined);
  await heAddRelation(factPanel, 'supports', 'hyp');
  assert.ok(dom.byLabel(factPanel, 'Remove relation: Supports → HYP'), 'the new row shows without reopening the panel');
  await heAddRelation(factPanel, 'prerequisite', 'pre');
  assert.ok(dom.byLabel(factPanel, 'Remove relation: Prerequisite → PRE'), 'a prerequisite row shows too');
});
integrationTest('hypothesis-evidence: after a strength change the focus returns to the pressed strength button', async () => {
  const { view } = heFixture();
  view.enqueue = work => work();
  const tx = { rewriteNote(p, write) { tx.write = write; return tx; }, editMap() { return tx; }, async commit() { await tx.write('hyp.md'); return { undo() {}, redo() {} }; } };
  view.beginMapTransaction = () => tx; view.refreshAfterSavedChange = async () => { view.notes.get('hyp').hypothesisStrength = 'strong'; };
  view.history = { push() {} };
  const panel = dom.element('panel'); view.renderHypothesisSection(panel, view.map.nodes[1]);
  dom.button(panel, 'Strong').click(); await dom.tick();
  const pressed = dom.findAll(dom.find(panel, c => (c.cls ?? '').includes('vam-hypothesis-strengths')), c => c.tag === 'button' && c.attrs['aria-pressed'] === 'true');
  assert.deepEqual(pressed.map(c => c.text), ['Strong']);
  assert.equal(pressed[0].focused, true, 'focus is on the strength button that is now pressed');
});
integrationTest('hypothesis-evidence: a strength change rewrites the note and Map.md in one history entry, and the buttons report the current strength', async () => {
  const { view, writes } = heFixture();
  const steps = []; view.enqueue = work => work();
  const tx = { rewriteNote(p, write) { steps.push(['rewrite', p]); steps.write = write; return tx; }, editMap() { steps.push(['editMap']); return tx; }, async commit(options) { steps.push(['commit', options]); await steps.write('hyp.md'); return { undo() {}, redo() {} }; } };
  view.beginMapTransaction = () => tx; view.refreshAfterSavedChange = async () => { view.notes.get('hyp').hypothesisStrength = 'strong'; };
  const pushed = []; view.history = { push: entry => pushed.push(entry) };
  const panel = dom.element('panel'); view.renderHypothesisSection(panel, view.map.nodes[1]);
  const pressed = () => dom.findAll(dom.find(panel, c => (c.cls ?? '').includes('vam-hypothesis-strengths')), c => c.tag === 'button' && c.attrs['aria-pressed'] === 'true').map(c => c.text);
  assert.deepEqual(pressed(), ['Weak']);
  dom.button(panel, 'Weak').click();
  assert.equal(steps.length, 0, 'choosing the current strength does nothing');
  dom.button(panel, 'Strong').click(); await dom.tick();
  assert.deepEqual(steps.map(s => s[0]), ['rewrite', 'editMap', 'commit']); assert.equal(steps[0][1], 'hyp.md');
  assert.deepEqual(writes, [['hyp.md', 'strong']]); assert.equal(pushed.length, 1, 'one undo step');
  assert.deepEqual(pressed(), ['Strong']);
});

// ---- hypothesis-evidence (P4): prerequisite picker, dotted line, panel rows ----
integrationTest('hypothesis-evidence: the prerequisite target picker lists neither itself, an existing target nor a target that would close a cycle (direct or indirect), and ends on a hand-written cycle', () => {
  const topics = [node('a'), node('b'), node('c'), node('d'), node('e')];
  const notes = heNotes(topics.map(n => [n.id, {}]));
  const relations = [{ kind: 'prerequisite', from: 'a', to: 'b' }, { kind: 'prerequisite', from: 'b', to: 'c' }, { kind: 'prerequisite', from: 'd', to: 'c' }];
  const { view } = heFixture({ topics, notes, relations });
  const fxA = { view };
  assert.deepEqual(heTargetsOf(fxA, 'prerequisite', 'a'), ['c', 'd', 'e'], 'for A: not itself and not its existing target b; c is a new, acyclic target');
  const forC = heFixture({ topics, notes, relations });
  assert.deepEqual(heTargetsOf(forC, 'prerequisite', 'c'), ['e'], 'for C: a, b and d all lead to c (c->b would close a cycle, directly or through b)');
  const loop = heFixture({ topics, notes, relations: [{ kind: 'prerequisite', from: 'a', to: 'b' }, { kind: 'prerequisite', from: 'b', to: 'c' }, { kind: 'prerequisite', from: 'c', to: 'a' }] });
  assert.ok(heTargetsOf(loop, 'prerequisite', 'a').length > 0, 'a hand-written cycle does not hang or hide the list');
  const all = [node('a'), node('b')];
  const none = heFixture({ topics: all, notes: heNotes(all.map(n => [n.id, {}])), relations: [{ kind: 'prerequisite', from: 'a', to: 'b' }] });
  assert.deepEqual(heTargetsOf(none, 'prerequisite', 'a'), []);
});
integrationTest('hypothesis-evidence: a prerequisite line runs from A to B along the nearest sides with the arrowhead at B, and shares the view marker with supports', () => {
  // Decision #37: one relation per pair, so the second prerequisite goes to another pair (other -> hyp) instead of stacking on fact/hyp.
  const relations = [{ kind: 'prerequisite', from: 'other', to: 'fact' }, { kind: 'supports', from: 'fact', to: 'hyp' }, { kind: 'prerequisite', from: 'other', to: 'hyp' }];
  const { view } = heFixture({ relations });
  const kids = heDrawn(view, { fact: [0, 0], hyp: [500, 40], other: [0, 200] });
  const pre = kids.filter(k => k.classes.includes('vam-relation-prerequisite'));
  assert.equal(pre.length, 2); assert.ok(pre.every(k => k.classes.includes('vam-relation')));
  assert.equal(kids.filter(k => k.classes.includes('vam-relation-supports')).length, 1, 'the supports line on its own pair is separate');
  const marker = kids.find(k => k.tag === 'defs').children[0].attrs.id;
  assert.equal(kids.filter(k => k.tag === 'defs').length, 1, 'one defs element serves every kind');
  const aToB = pre.find(k => / 140 100$/.test(k.attrs.d));
  assert.ok(aToB, 'other (A) is below fact (B): the line ends on the bottom edge of B'); assert.match(aToB.attrs.d, /^M 140 200 C /, 'and starts on the top edge of A');
  assert.equal(aToB.attrs['marker-end'], `url(#${marker})`, 'the arrowhead is at the end, which is B');
  const toHyp = pre.find(k => / 500 90$/.test(k.attrs.d)); assert.ok(toHyp, 'the second prerequisite is on the other/hyp pair and ends on the left edge of hyp at its middle (90)'); assert.equal(toHyp.attrs['marker-end'], `url(#${marker})`);
  const drag = view.dragEdges('other', view.cardEls.get('other')); drag.update(0, 400);
  assert.match(aToB.attrs.d, /^M 140 400 C /, 'dragging A moves the prerequisite line');
});
integrationTest('hypothesis-evidence: a hand-written prerequisite cycle is drawn as it is, and an AIM map draws no prerequisite', () => {
  const relations = [{ kind: 'prerequisite', from: 'fact', to: 'other' }, { kind: 'prerequisite', from: 'other', to: 'hyp' }, { kind: 'prerequisite', from: 'hyp', to: 'fact' }]; // a three-topic cycle: a two-topic one is a same pair (decision #37)
  const { view, logs } = heFixture({ relations });
  const kids = heDrawn(view, { fact: [0, 0], hyp: [500, 40], other: [0, 200] });
  assert.equal(kids.filter(k => k.classes.includes('vam-relation-prerequisite')).length, 3, 'every link of the cycle is drawn'); assert.deepEqual(logs, [], 'and nothing is logged or dropped');
  assert.equal(view.map.topicRelations.length, 3);
  view.map.aim = { mode: 'x' };
  assert.equal(heDrawn(view, { fact: [0, 0], hyp: [500, 40], other: [0, 200] }).length, 0);
  const collapsed = heFixture({ relations }); assert.equal(heDrawn(collapsed.view, { fact: [0, 0], hyp: [500, 40] }).filter(k => k.classes.includes('vam-relation-prerequisite')).length, 1, 'an off-screen end is skipped: only hyp -> fact has both ends on screen');
});
integrationTest('hypothesis-evidence: styles.css gives the prerequisite line its long-short pattern, unlike contradicts, AIM and the solid parent line', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const rule = selector => { const m = css.match(new RegExp(`^${selector.replace(/[.[\]"=-]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm')); assert.ok(m, `rule ${selector}`); return m[1]; };
  const pre = rule('.vam-relation-prerequisite'), dash = pre.match(/stroke-dasharray:\s*([^;]+);/)[1].trim(), contradicts = rule('.vam-relation-contradicts').match(/stroke-dasharray:\s*([^;]+);/)[1].trim();
  assert.equal(dash, '10 4 2 4', 'long-short pattern'); assert.notEqual(dash, contradicts); assert.notEqual(dash, '5 5'); assert.ok(dash !== 'none');
  assert.match(rule('.vam-relation'), /pointer-events:\s*none/); assert.match(rule('.vam-edges'), /pointer-events:\s*none/);
});
integrationTest('hypothesis-evidence: the panel lists relations at both ends, each row is removable through mapChange, and the add button is on topics and hypotheses alike', async () => {
  const relations = [{ kind: 'prerequisite', from: 'fact', to: 'other' }, { kind: 'prerequisite', from: 'other', to: 'hyp' }, { kind: 'supports', from: 'fact', to: 'hyp' }];
  const { view, doc } = heFixture({ relations });
  const changes = []; view.enqueue = work => work();
  view.mapChange = async (change, rebuild) => { changes.push(rebuild); change(view.map); };
  const bPanel = dom.element('panel'); view.renderHypothesisSection(bPanel, view.map.nodes[2]);
  assert.ok(dom.texts(bPanel).includes('Relations'), 'one Relations section');
  assert.ok(dom.byLabel(bPanel, 'Remove relation: FACT → Prerequisite'), 'A is listed on B'); assert.ok(dom.byLabel(bPanel, 'Remove relation: Prerequisite → HYP'), 'B is listed on A');
  for (const id of ['hyp', 'fact']) { const p = dom.element('panel'); view.renderHypothesisSection(p, view.map.nodes.find(n => n.id === id)); assert.ok(heKindSelect(p), `add sentence for ${id}`); }
  await dom.byLabel(bPanel, 'Remove relation: FACT → Prerequisite').fire('click'); await dom.tick();
  assert.equal(changes.length, 1); assert.equal(changes[0], false);
  assert.deepEqual(plain(doc.topicRelations), [{ kind: 'prerequisite', from: 'other', to: 'hyp' }, { kind: 'supports', from: 'fact', to: 'hyp' }], 'only that link is removed');
  const hypPanel = dom.element('panel'); view.renderHypothesisSection(hypPanel, view.map.nodes[1]);
  await dom.byLabel(hypPanel, 'Remove relation: OTHER → Prerequisite').fire('click'); await dom.tick();
  assert.equal(changes.length, 2); assert.equal(doc.topicRelations.some(r => r.kind === 'prerequisite'), false, 'removable from the other end too');
  await view.addRelation('fact', 'other', 'prerequisite'); await view.addRelation('fact', 'other', 'prerequisite'); await view.addRelation('other', 'fact', 'prerequisite'); await view.addRelation('hyp', 'hyp', 'prerequisite');
  assert.deepEqual(plain(doc.topicRelations.filter(r => r.kind === 'prerequisite')), [{ kind: 'prerequisite', from: 'fact', to: 'other' }], 'added once; duplicate, cycle-closing and self links refused');
});
// ---- hypothesis-evidence (P5): selectable relation lines, names on hover/selection, selection highlight ----
const heRel = [{ kind: 'supports', from: 'fact', to: 'hyp' }, { kind: 'prerequisite', from: 'other', to: 'fact' }];
const heKey = r => `${r.from}\u0000${r.to}\u0000${r.kind}`;
function heLines(options = {}) {
  const fx = heFixture({ relations: options.relations ?? heRel, topics: options.topics });
  const kids = heDrawn(fx.view, { fact: [0, 0], hyp: [500, 40], other: [0, 200] });
  const find = kind => kids.find(k => k.classes.includes(`vam-relation-${kind}`));
  const labels = kids.filter(k => k.classes.includes('vam-relation-label')), hits = kids.filter(k => k.classes.includes('vam-relation-hit'));
  return { ...fx, kids, ev: find('supports'), pre: find('prerequisite'), labels, hits, evHit: hits[0], preHit: hits[1], evLabel: labels[0], preLabel: labels[1] };
}
const heExpanded = el => el.classes.includes('is-expanded');
integrationTest('hypothesis-evidence: a relation name is always shown, expands while the pointer is on the line or the line is selected, and follows a drag', () => {
  const { view, evHit, evLabel, preLabel, preHit } = heLines();
  const head = l => l.children[0]?.textContent;
  assert.equal(evLabel.textContent, 'Supports'); assert.equal(preLabel.textContent, 'Prerequisite');
  assert.ok(!heExpanded(evLabel) && !heExpanded(preLabel), 'the name only, by default');
  evHit.fire('pointerenter'); assert.ok(heExpanded(evLabel) && !heExpanded(preLabel), 'hover expands the label'); assert.equal(head(evLabel), 'Supports: FACT → HYP');
  evHit.fire('pointerleave'); assert.ok(!heExpanded(evLabel), 'leaving collapses it'); assert.equal(evLabel.textContent, 'Supports');
  preHit.fire('pointerdown', { stopPropagation() {} }); preHit.fire('pointerleave'); assert.ok(heExpanded(preLabel), 'a selected line keeps its full label');
  assert.equal(view.selection.state.selectedRelation, heKey(heRel[1]));
  const x = Number(evLabel.attrs.x), y = Number(evLabel.attrs.y);
  assert.ok(x > 280 && x < 500, 'the name sits at the midpoint of the curve');
  view.dragEdges('fact', view.cardEls.get('fact')).update(0, 300);
  assert.notEqual(evLabel.attrs.y, String(y), 'the name follows the dragged card'); assert.equal(evLabel.attrs.x, String((280 + 3 * 340 + 3 * 440 + 500) / 8));
});
integrationTest('hypothesis-evidence: selecting a topic marks the lines touching it is-related and the other relation lines is-dimmed; parent-child edges are untouched; multi-select is a union', () => {
  const { view, ev, pre, kids } = heLines({ relations: [...heRel, { kind: 'prerequisite', from: 'hyp', to: 'other' }] });
  const third = kids.filter(k => k.classes.includes('vam-relation-prerequisite'))[1];
  assert.ok(![ev, pre, third].some(l => l.classes.includes('is-related') || l.classes.includes('is-dimmed')), 'nothing selected: no highlight');
  view.selection.setSelected('hyp'); view.paintCards(['hyp']);
  assert.ok(ev.classes.includes('is-related') && third.classes.includes('is-related')); assert.ok(pre.classes.includes('is-dimmed') && !pre.classes.includes('is-related'));
  view.selection.replaceMulti([...view.selection.state.multiSelected, 'other']); view.paintCards(['other']);
  assert.ok([ev, pre, third].every(l => l.classes.includes('is-related') && !l.classes.includes('is-dimmed')), 'union of selected and multi-selected topics');
  view.selection.setSelected(null); view.selection.replaceMulti([]); view.paintCards(['hyp', 'other']);
  assert.ok(![ev, pre, third].some(l => l.classes.includes('is-related') || l.classes.includes('is-dimmed')), 'cleared selection removes the classes in place');
  assert.equal(kids.filter(k => k.classes.includes('vam-edge')).length, 0, 'no parent-child edge exists here and none was given a highlight class');
});
integrationTest('hypothesis-evidence: parent-child edges get no highlight class from a topic selection', () => {
  const { view } = heLines();
  const edge = { classes: ['vam-edge'], toggleClass(n, on) { this.classes = this.classes.filter(c => c !== n); if (on) this.classes.push(n); } };
  view.edgeEls.set('fact\u0000hyp', edge); view.selection.setSelected('fact'); view.paintCards(['fact']);
  assert.deepEqual(edge.classes, ['vam-edge']);
});
integrationTest('hypothesis-evidence: a selected line is is-selected and both end cards are is-relation-end; Escape, a blank-canvas press and picking a topic clear it', () => {
  const { view, ev, evHit, preHit, pre } = heLines();
  const marks = () => [...view.cardEls].filter(([, c]) => c.classes.includes('is-relation-end')).map(([id]) => id).sort();
  evHit.fire('pointerdown', { stopPropagation() {} });
  assert.ok(ev.classes.includes('is-selected') && !pre.classes.includes('is-selected')); assert.deepEqual(marks(), ['fact', 'hyp']);
  preHit.fire('pointerdown', { stopPropagation() {} }); assert.deepEqual(marks(), ['fact', 'other'], 'ends move to the newly selected line'); assert.ok(!ev.classes.includes('is-selected'));
  // Escape
  view.commitSelection = (...args) => view.applySelectionState(...args);
  view.selection.selectRelation(heKey(heRel[0])); view.syncRelationClasses();
  view.selection.deselectRelation(view.selection.state.selectedRelation); view.commitSelection(null, null, []);
  assert.deepEqual(marks(), []); assert.ok(!ev.classes.includes('is-selected'), 'clearing through the selection path repaints in place');
  // picking a topic
  evHit.fire('pointerdown', { stopPropagation() {} }); view.cardEls.get('fact').focus = () => {}; view.selection.setSelected('other'); view.applySelectionState(null, 'other', []);
  assert.equal(view.selection.state.selectedRelation, null, 'selecting a topic clears the line'); assert.deepEqual(marks(), []);
  // blank canvas / vanished relation
  evHit.fire('pointerdown', { stopPropagation() {} }); view.map.topicRelations = [heRel[1]]; view.drawEdges();
  assert.equal(view.selection.state.selectedRelation, null, 'a relation that no longer exists cannot stay selected');
});
integrationTest('hypothesis-evidence: the Escape key handler and the blank-canvas release clear the line selection (source wiring)', () => {
  const src = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  // The module's escape and clickEmpty end the line selection (tests/steps-topic-selection.cjs); the view must call them.
  assert.match(src, /if \(event\.key === "Escape"\) \{[\s\S]{0,260}selection\.escape\(\)/, 'Escape');
  assert.match(src, /if \(!moved && event\.button === 0\) \{[\s\S]{0,400}selection\.clickEmpty\(\)/, 'blank canvas release');
});
integrationTest('hypothesis-evidence: a panel row is focusable, named by direction, relation and other topic, and focus selects its line while hover previews it', () => {
  const { view, ev, pre } = heLines();
  const panel = dom.element('panel'); view.renderHypothesisSection(panel, view.map.nodes[1]);
  const rows = []; const walk = el => { if (el.cls && String(el.cls).includes('vam-relation-row')) rows.push(el); (el.children ?? []).forEach(walk); };
  walk(panel);
  assert.ok(rows.length >= 1, 'the evidence row is rendered');
  const row = rows[0];
  assert.equal(row.tabIndex, 0, 'focusable'); assert.equal(row.attrs['aria-label'], 'FACT → Supports');
  row.fire('mouseenter'); assert.ok(ev.classes.includes('is-selected'), 'hover previews like a selection'); row.fire('mouseleave'); assert.ok(!ev.classes.includes('is-selected'));
  row.fire('focus'); assert.ok(ev.classes.includes('is-selected') && !pre.classes.includes('is-selected')); assert.equal(view.selection.state.selectedRelation, heKey(heRel[0]));
  row.fire('blur'); assert.equal(view.selection.state.selectedRelation, null);
});
integrationTest('hypothesis-evidence: pressing a relation line starts neither a pan nor a marquee, and a parent-child edge takes no press', () => {
  const { evHit, preHit, view } = heLines();
  for (const hit of [evHit, preHit]) {
    let stopped = 0; hit.fire('pointerdown', { stopPropagation() { stopped++; } });
    assert.equal(stopped, 1, 'the press stops here, so the viewport pan/marquee handler never sees it');
  }
  const edgeSvg = view.edgesEl.kids.filter(k => k.classes.includes('vam-edge'));
  assert.ok(edgeSvg.every(e => Object.keys(e.listeners ?? {}).length === 0), 'parent-child edges have no handlers');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const rule = selector => css.match(new RegExp(`^${selector.replace(/[.[\]"=-]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm'))[1];
  assert.match(rule('.vam-relation-hit'), /pointer-events:\s*stroke/); assert.match(rule('.vam-relation-hit'), /stroke:\s*transparent/);
  assert.match(rule('.vam-edges'), /pointer-events:\s*none/); assert.match(rule('.vam-relation'), /pointer-events:\s*none/);
  assert.ok(!/\.vam-edge\s*\{[^}]*pointer-events:\s*(stroke|auto|all)/.test(css), 'a parent-child edge takes no pointer events');
});

// ---- hypothesis-evidence (V1.6 P11): topic type shapes and tints ----
const heShapeModule = () => {
  const make = tag => ({ tag, attrs: {}, classes: [], children: [], setAttribute(n, v) { this.attrs[n] = v; }, addClass(n) { this.classes.push(n); }, appendChild(c) { this.children.push(c); } });
  const mod = load('experiences/visual-map/topic-kind-shape.ts', {}, { createSvg: make });
  const draw = kind => { let drawn; const card = { appendChild(el) { drawn = el; } }; const result = mod.renderShapeBackground(card, kind); return { result, drawn }; };
  return { ...mod, draw };
};
const heInside = (svg, W, H, x, y) => {
  const outline = svg.children.find(c => c.classes.includes('vam-kind-outline'));
  if (outline.tag === 'ellipse') { const cx = Number(outline.attrs.cx) * W / 100, cy = Number(outline.attrs.cy) * H / 100, rx = Number(outline.attrs.rx) * W / 100, ry = Number(outline.attrs.ry) * H / 100; return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1; }
  const pts = outline.attrs.points.split(/\s+/).map(p => p.split(',').map(Number)).map(([px, py]) => [px * W / 100, py * H / 100]);
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
integrationTest('hypothesis-evidence: the shape table covers exactly the six topic types, each with a name key that exists in all three languages', () => {
  const { TOPIC_KIND_SHAPES } = heShapeModule();
  assert.deepEqual(Object.keys(TOPIC_KIND_SHAPES).sort(), [...heKindIds].sort());
  assert.deepEqual(plain(Object.fromEntries(Object.entries(TOPIC_KIND_SHAPES).map(([k, v]) => [k, v.shape]))), { topic: 'rounded', action: 'rect', atomic: 'ellipse', hypothesis: 'diamond', evidence: 'folded', conclusion: 'hexagon' });
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const source = fs.readFileSync(path.join(root, 'i18n', `${lang}.ts`), 'utf8');
    for (const { labelKey } of Object.values(TOPIC_KIND_SHAPES)) assert.ok(source.includes(`"${labelKey}"`), `${lang} has ${labelKey}`);
  }
});
integrationTest('hypothesis-evidence: shapeInsets keeps all four corners of the text block inside the drawn shape at three content sizes', () => {
  const mod = heShapeModule();
  for (const kind of ['atomic', 'hypothesis', 'evidence', 'conclusion']) {
    for (const height of [60, 140, 320]) {
      const W = 280, insets = mod.shapeInsets(kind, { width: W, height });
      const H = height + insets.top + insets.bottom, svg = mod.draw(kind).drawn;
      const corners = [[insets.left, insets.top], [W - insets.right, insets.top], [insets.left, H - insets.bottom], [W - insets.right, H - insets.bottom]];
      for (const [x, y] of corners) assert.ok(heInside(svg, W, H, x, y), `${kind} at text height ${height}: corner (${x.toFixed(1)}, ${y.toFixed(1)}) is inside the ${W}x${H.toFixed(1)} shape`);
      assert.ok(insets.left > 0 && insets.top > 0, `${kind}: both sides get padding`);
    }
  }
  const diamond = mod.shapeInsets('hypothesis', { width: 280, height: 100 });
  assert.equal(diamond.left, 70, 'a diamond text block is half the card width'); assert.equal(diamond.top, 54, 'and the top and bottom padding is half the text height (plus a 4px margin)');
  assert.deepEqual(plain(mod.shapeInsets('topic', { width: 280, height: 100 })), { top: 12, right: 14, bottom: 14, left: 14 }, 'an ordinary card keeps its padding');
  assert.deepEqual(plain(mod.shapeInsets('action', { width: 280, height: 100 })), { top: 12, right: 14, bottom: 14, left: 14 }, 'an action keeps its padding too');
});
integrationTest('hypothesis-evidence: renderShapeBackground draws a stretchable, non-scaling, hidden SVG for the four shaped types and nothing for topic and action', () => {
  const mod = heShapeModule();
  for (const kind of ['topic', 'action']) assert.equal(mod.draw(kind).result, undefined, `${kind} draws no SVG`);
  for (const [kind, tag] of [['atomic', 'ellipse'], ['hypothesis', 'polygon'], ['evidence', 'polygon'], ['conclusion', 'polygon']]) {
    const { result, drawn } = mod.draw(kind);
    assert.equal(result, drawn); assert.deepEqual(plain(drawn.classes), ['vam-kind-shape']);
    assert.equal(drawn.attrs.preserveAspectRatio, 'none'); assert.equal(drawn.attrs['aria-hidden'], 'true'); assert.equal(drawn.attrs.viewBox, '0 0 100 100');
    const outline = drawn.children[0]; assert.equal(outline.tag, tag); assert.equal(outline.attrs['vector-effect'], 'non-scaling-stroke');
  }
  assert.equal(mod.draw('evidence').drawn.children.length, 2, 'evidence has the fold line too'); assert.equal(mod.draw('conclusion').drawn.attrs.viewBox && mod.draw('conclusion').drawn.children[0].attrs.points, '25,0 75,0 100,50 75,100 25,100 0,50', 'the AIM conclusion hexagon points');
});
integrationTest('hypothesis-evidence: a card draws its type shape as its first child; an ordinary topic, an AIM card draw none', () => {
  const draws = (options, id) => {
    const f = heFixture(options); f.view.stageEl = hePatch(dom.element('stage')); f.view.renderNode(f.view.map.nodes.find(n => n.id === id));
    return { shapes: f.svgCreated.filter(el => el.classes.includes('vam-kind-shape')), card: f.view.stageEl.children[0] };
  };
  for (const kind of ['atomic', 'hypothesis', 'evidence', 'conclusion']) {
    const { shapes, card } = draws({ notes: heNotes([['fact', { topicKind: kind }], ['hyp', {}], ['other', {}]]) }, 'fact');
    assert.equal(shapes.length, 1, `${kind} draws one shape`); assert.equal(card.children[0], shapes[0], 'it is behind the text (first child)');
  }
  for (const kind of ['action', 'topic']) assert.equal(draws({ notes: heNotes([['fact', kind === 'topic' ? {} : { topicKind: kind }], ['hyp', {}], ['other', {}]]) }, 'fact').shapes.length, 0, `${kind} draws none`);
  const typed = heNotes([['fact', { topicKind: 'hypothesis' }], ['hyp', {}], ['other', {}]]);
  assert.equal(draws({ aim: true, notes: typed }, 'fact').shapes.length, 0, 'an AIM map draws no type shape (no vam-kind-shape)');
});
integrationTest('hypothesis-evidence: fitKindShape sets the side padding from the width, then top and bottom from the measured text height; a hidden card is left alone', () => {
  const f = heFixture({}), mod = heShapeModule();
  const card = { offsetWidth: 280, clientHeight: 100, style: {} };
  f.view.fitKindShape(card, 'hypothesis');
  assert.equal(card.style.padding, '54px 70px 54px 70px');
  const expected = mod.shapeInsets('conclusion', { width: 280, height: 100 }), conclusion = { offsetWidth: 280, clientHeight: 100, style: {} };
  f.view.fitKindShape(conclusion, 'conclusion'); assert.equal(conclusion.style.padding, `${expected.top}px ${expected.right}px ${expected.bottom}px ${expected.left}px`);
  for (const kind of ['topic', 'action']) { const plain = { offsetWidth: 280, clientHeight: 100, style: {} }; f.view.fitKindShape(plain, kind); assert.deepEqual(plain.style, {}, `${kind} keeps the stylesheet padding`); }
  const hidden = { offsetWidth: 0, clientHeight: 0, style: {} }; f.view.fitKindShape(hidden, 'atomic'); assert.deepEqual(hidden.style, {}, 'a card that is not laid out is not fitted');
});
integrationTest('hypothesis-evidence: styles.css clamps an atomic title to two lines and gives each non-ordinary type its tint, its shape rules and a 3px action corner', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(css, /^\[data-topic-kind="atomic"\] \.vam-card-title \{[^}]*-webkit-line-clamp: 2;[^}]*overflow: hidden;/m);
  for (const [kind, hue] of [['atomic', 'cyan'], ['hypothesis', 'purple'], ['evidence', 'green'], ['conclusion', 'blue'], ['action', 'orange']]) assert.match(css, new RegExp(`^\\[data-topic-kind="${kind}"\\]\\.vam-node \\{ --vam-kind-hue: var\\(--color-${hue}\\); \\}`, 'm'), `${kind} uses ${hue}`);
  assert.doesNotMatch(css, /--vam-kind-hue: var\(--color-(?:red|yellow|pink)\)/, 'red and yellow stay for errors and warnings');
  assert.match(css, /--vam-kind-fill: color-mix\(in srgb, var\(--vam-kind-hue\) \d+%, var\(--vam-card-bg\)\)/);
  assert.match(css, /^\[data-topic-kind="action"\]\.vam-node:not\(\[data-aim-kind\]\) \{ border-radius: 3px;/m);
  assert.match(css, /^\.vam-kind-shape \{[^}]*pointer-events: none;/m);
  // An ordinary topic is not styled by any of this: its own rules are unchanged.
  assert.match(css, /^\.vam-node \{ --vam-card-bg: var\(--background-primary\); position: absolute; box-sizing: border-box; width: 280px; padding: 12px 14px 14px; border: 1px solid var\(--background-modifier-border\); border-radius: 12px;/m);
});
integrationTest('hypothesis-evidence: every type rule starts with the data-topic-kind attribute or vam-kind-shape, so the share viewer picks none of them up', async () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const { parseCss, extractViewerRules } = await import(require('node:url').pathToFileURL(path.join(root, 'scripts/viewer-css.mjs')).href);
  const own = parseCss(css).filter(chunk => /data-topic-kind|vam-kind-/.test(chunk.prelude));
  assert.ok(own.length >= 10, 'the type rules exist');
  for (const chunk of own) for (const selector of chunk.prelude.split(/,\s*(?=\[data-topic-kind=|\.vam-kind-shape)/)) assert.match(selector.trim(), /^(?:\[data-topic-kind=|\.vam-kind-shape)/, `selector starts with the attribute or vam-kind-shape: ${selector.slice(0, 60)}`);
  const viewer = extractViewerRules(css).map(item => item.text).join('\n');
  assert.doesNotMatch(viewer, /data-topic-kind|vam-kind-/, 'the viewer stylesheet carries no type rule');
});
integrationTest('hypothesis-evidence: the SVG types hide the card frame and shadow, draw solid outlines, dash only a skippable topic, and mark running, error and selected on the outline', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const frame = css.split('\n').find(line => line.includes('isolation: isolate; padding: 28px 40px'));
  assert.match(frame, /border-color: transparent; background: transparent; box-shadow: none;/);
  for (const kind of ['atomic', 'hypothesis', 'evidence', 'conclusion']) assert.ok(frame.includes(`[data-topic-kind="${kind}"]`), `${kind} is in the hidden-frame rule`); assert.ok(!frame.includes('"action"') && !frame.includes('"topic"'), 'action and topic keep their card frame');
  assert.match(css, /--vam-kind-dash: none;/); assert.match(css, /\[data-relevance="side"\][^{]*\{ --vam-kind-dash: 6 4; \}/);
  assert.match(css, /\[data-status="running"\][^{]*\{ --vam-kind-line: color-mix\(in srgb, var\(--interactive-accent\)/);
  assert.match(css, /\[data-status="error"\][^{]*\{ --vam-kind-line: var\(--color-red\); \}/);
  assert.match(css, /\.is-selected:not\(\[data-aim-kind\]\)[^{]*\{ --vam-kind-line: color-mix\(in srgb, var\(--interactive-accent\)[^}]*--vam-kind-width: 3px; \}/);
  assert.match(css, /\.vam-kind-shape \.vam-kind-outline \{[^}]*stroke-dasharray: var\(--vam-kind-dash\)/);
});

// ---- hypothesis-evidence (V1.6 P12): relation section, create flow, relation editor ----
const heEditor = (relations, current, options = {}) => {
  const topics = options.topics ?? [node('a'), node('b'), node('c')];
  const fx = heFixture({ topics, notes: heNotes(topics.map(n => [n.id, {}])), relations, ...options });
  const calls = [], closed = [], changed = [];
  fx.view.enqueue = work => work();
  fx.view.mapChange = async (change, rebuild) => { calls.push(rebuild); change(fx.view.map); };
  const host = dom.element('editor');
  const saveNote = fx.view.renderRelationEditor(host, current, () => closed.push(1), () => changed.push(1));
  const kindOptions = () => dom.findAll(host, c => c.tag === 'option').map(o => o.text);
  const openKinds = () => dom.findAll(host, c => c.tag === 'option' && !c.disabled).map(o => o.text);
  const select = () => dom.find(host, c => c.tag === 'select');
  const input = () => dom.find(host, c => c.tag === 'textarea');
  return { ...fx, host, calls, closed, changed, kindOptions, openKinds, select, input, saveNote };
};
integrationTest('hypothesis-evidence: the add-relation sentence lists the six kinds in order and builds the relation of the chosen kind with the panel topic as A', async () => {
  const { view, doc } = heFixture();
  view.enqueue = work => work(); view.mapChange = async change => { change(view.map); };
  const panel = dom.element('panel'); view.renderHypothesisSection(panel, view.map.nodes[0]);
  assert.deepEqual(dom.findAll(heKindSelect(panel), c => c.tag === 'option').map(o => o.text), ['Supports', 'Contradicts', 'Verifies', 'Derives from', 'Related', 'Prerequisite']);
  assert.equal(dom.find(panel, c => (c.cls ?? '').includes('vam-relation-add-self')).text, 'This card');
  await heAddRelation(panel, 'derives_from', 'hyp');
  assert.deepEqual(plain(doc.topicRelations), [{ kind: 'derives_from', from: 'fact', to: 'hyp' }]);
});
integrationTest('card settings (ticket 41): the other-card list never holds the card itself, and Map.md gets the same relation line as before', async () => {
  const topics = [node('a'), node('b'), node('c')];
  const fx = heFixture({ topics, notes: heNotes(topics.map(n => [n.id, {}])) });
  fx.view.enqueue = work => work(); fx.view.mapChange = async change => { change(fx.view.map); };
  const panel = dom.element('panel'); fx.view.renderHypothesisSection(panel, fx.view.map.nodes[0]);
  for (const kind of ['supports', 'contradicts', 'verifies', 'derives_from', 'related', 'prerequisite']) assert.equal(heTargetIds(panel, kind).includes('a'), false, `${kind}: this card is not offered`);
  assert.deepEqual(dom.findAll(heTargetSelect(panel), c => c.tag === 'option').map(o => o.text), ['Choose another card…', 'B', 'C']);
  const add = dom.find(panel, c => (c.cls ?? '').includes('vam-relation-add')).children.find(c => c.tag === 'button');
  assert.equal(add.disabled, true, 'nothing chosen yet: Add is off');
  await heAddRelation(panel, 'contradicts', 'b');
  const viaRow = core.serializeMap(fx.view.map);
  const reference = heFixture({ topics, notes: heNotes(topics.map(n => [n.id, {}])) });
  reference.view.mapChange = async change => { change(reference.view.map); };
  await reference.view.addRelation('a', 'b', 'contradicts');
  assert.equal(viaRow, core.serializeMap(reference.view.map), 'the saved Map.md is byte for byte what addRelation writes');
  assert.match(viaRow, /contradicts/);
});
test('hypothesis-evidence: the picker offers only legal targets: not itself, not a topic that already has any relation with this one, not a derivation cycle (decision #37)', () => {
  const topics = [node('a'), node('b'), node('c'), node('d')];
  const notes = heNotes(topics.map(n => [n.id, {}]));
  const relations = [{ kind: 'derives_from', from: 'a', to: 'b' }, { kind: 'derives_from', from: 'b', to: 'c' }, { kind: 'supports', from: 'c', to: 'a' }];
  const ids = (kind, from) => heTargetsOf(heFixture({ topics, notes, relations }), kind, from);
  assert.deepEqual(ids('derives_from', 'c'), ['d'], 'a and b already hold a relation with c; itself is out');
  assert.deepEqual(ids('supports', 'c'), ['d'], 'a (supports) and b (derives from) are linked with c whatever the kind asked for');
  assert.deepEqual(ids('prerequisite', 'c'), ['d'], 'another kind does not reopen a taken pair');
  assert.deepEqual(ids('prerequisite', 'd'), ['a', 'b', 'c'], 'a topic with no relation is offered every other topic');
});
integrationTest('hypothesis-evidence: the picker lists a parent and a child topic, and a topic linked in the reverse direction is not listed (decision #37)', () => {
  const topics = [node('a'), node('b', 'a'), node('c')];
  const notes = heNotes(topics.map(n => [n.id, {}]));
  const ids = (relations, kind, from) => heTargetsOf(heFixture({ topics, notes, relations }), kind, from);
  assert.deepEqual(ids([], 'supports', 'a'), ['b', 'c'], 'the child is a legal target');
  assert.deepEqual(ids([], 'related', 'b'), ['a', 'c'], 'the parent is a legal target');
  assert.deepEqual(ids([{ kind: 'supports', from: 'c', to: 'a' }], 'contradicts', 'a'), ['b'], 'c -> a is already there: c is out although this link would point the other way');
});
integrationTest('hypothesis-evidence: a second relation on the same pair cannot be created, same kind, another kind, reversed or related; a parent and child pair takes one (decision #37)', async () => {
  const topics = [node('a'), node('b', 'a'), node('c')];
  const { view, doc } = heFixture({ topics, notes: heNotes(topics.map(n => [n.id, {}])), relations: [{ kind: 'supports', from: 'a', to: 'c' }] });
  view.enqueue = work => work(); view.mapChange = async (change, rebuild) => { change(view.map); };
  await view.addRelation('a', 'c', 'supports'); await view.addRelation('a', 'c', 'contradicts'); await view.addRelation('c', 'a', 'supports'); await view.addRelation('c', 'a', 'related'); await view.addRelation('a', 'c', 'related');
  assert.deepEqual(plain(doc.topicRelations), [{ kind: 'supports', from: 'a', to: 'c' }], 'all five attempts are refused');
  await view.addRelation('a', 'b', 'derives_from'); await view.addRelation('b', 'a', 'supports');
  assert.deepEqual(plain(doc.topicRelations), [{ kind: 'supports', from: 'a', to: 'c' }, { kind: 'derives_from', from: 'a', to: 'b' }], 'the parent and child pair takes one relation; the reverse is refused');
});
integrationTest('hypothesis-evidence: with no legal target the list says so for that kind and cannot be used (decision #37)', () => {
  const topics = [node('a'), node('b')];
  const fx = heFixture({ topics, notes: heNotes(topics.map(n => [n.id, {}])), relations: [{ kind: 'related', from: 'b', to: 'a' }] });
  const panel = dom.element('panel'); fx.view.renderHypothesisSection(panel, fx.view.map.nodes[0]);
  assert.deepEqual(heTargetIds(panel, 'related'), []);
  assert.equal(dom.findAll(heTargetSelect(panel), c => c.tag === 'option')[0].text, 'There is no topic this one can be linked to with “Related”.');
  assert.deepEqual(heTargetIds(panel, 'supports'), [], 'a different kind on the same pair is refused too (decision #37)');
  assert.equal(heTargetSelect(panel).disabled, true);
});
integrationTest('hypothesis-evidence: panel rows read "Name → B" going out, "A → Name" coming in and "Name — X" for related, with the note, a focusable row and Edit/Remove labels', () => {
  const relations = [{ kind: 'supports', from: 'fact', to: 'hyp', description: 'measured twice' }, { kind: 'derives_from', from: 'other', to: 'fact' }, { kind: 'related', from: 'extra', to: 'fact' }]; // decision #37: one relation per pair, so the related one comes from a fourth topic
  const { view } = heFixture({ relations, topics: [node('fact'), node('hyp'), node('other'), node('extra')], notes: heNotes([['fact', {}], ['hyp', heHyp('weak')], ['other', {}], ['extra', {}]]) });
  const panel = dom.element('panel'); view.renderHypothesisSection(panel, view.map.nodes[0]);
  const rows = dom.findAll(panel, c => c.tag === 'li');
  assert.deepEqual(rows.map(r => r.attrs['aria-label']), ['Supports → HYP. measured twice', 'OTHER → Derives from', 'Related — EXTRA']);
  assert.ok(rows.every(r => r.tabIndex === 0), 'every row can take focus');
  assert.deepEqual(dom.texts(panel).filter(x => /^(This topic|OTHER|HYP|FACT)\b/.test(x)), ['This topic supports HYP', 'OTHER is derived from this topic', 'This topic is related to EXTRA'], 'the visible sentence reads "A relation B" with this topic named (C6, decision 35); the aria-labels above keep the old strings');
  assert.ok(dom.texts(panel).includes('measured twice'));
  for (const text of ['Supports → HYP', 'OTHER → Derives from', 'Related — EXTRA']) { assert.ok(dom.byLabel(panel, `Edit relation: ${text}`)); assert.ok(dom.byLabel(panel, `Remove relation: ${text}`)); }
  const hypPanel = dom.element('panel'); view.renderHypothesisSection(hypPanel, view.map.nodes[1]);
  assert.deepEqual(dom.findAll(hypPanel, c => c.tag === 'li').map(r => r.attrs['aria-label']), ['FACT → Supports. measured twice'], 'the same link seen from the other end');
  const extraPanel = dom.element('panel'); view.renderHypothesisSection(extraPanel, view.map.nodes[3]);
  assert.deepEqual(dom.findAll(extraPanel, c => c.tag === 'li').map(r => r.attrs['aria-label']), ['Related — FACT'], 'a related link reads the same from either end');
});
integrationTest('hypothesis-evidence: the panel "Edit" opens the editor for that row, and clicking a semantic line selects it and opens the editor, while the press alone opens nothing', () => {
  const { view, modals, evHit } = heLines();
  let stopped = 0;
  evHit.fire('pointerdown', { stopPropagation() { stopped++; } });
  assert.equal(modals.length, 0, 'the press selects only'); assert.equal(view.selection.state.selectedRelation, heKey(heRel[0]));
  evHit.fire('click', { stopPropagation() { stopped++; } });
  assert.equal(stopped, 2); assert.equal(modals.length, 1, 'the click opens the editor dialog');
  const panel = dom.element('panel'); view.renderHypothesisSection(panel, view.map.nodes[0]);
  dom.byLabel(panel, 'Edit relation: Supports → HYP').click();
  assert.equal(modals.length, 2, 'the row Edit opens the same editor');
  const parentEdge = view.edgesEl.kids.filter(k => k.classes.includes('vam-edge'));
  assert.ok(parentEdge.every(e => !(e.listeners && e.listeners.click)), 'a parent-child edge takes no click');
});
integrationTest('hypothesis-evidence: the editor lists all six kinds; one that would close a derives/prerequisite cycle is disabled and the reason is written beside it (E4, Q7, decision #37)', () => {
  const relations = [{ kind: 'supports', from: 'a', to: 'b' }, { kind: 'derives_from', from: 'b', to: 'c' }, { kind: 'derives_from', from: 'c', to: 'a' }];
  const { kindOptions, openKinds, select, host } = heEditor(relations, relations[0]);
  assert.deepEqual(kindOptions(), ['Supports', 'Contradicts', 'Verifies', 'Derives from', 'Related', 'Prerequisite'], 'all six are listed (the old test listed five: the illegal one was left out)');
  assert.deepEqual(openKinds(), ['Supports', 'Contradicts', 'Verifies', 'Related', 'Prerequisite'], 'Derives from would close a cycle a -> b -> c -> a: disabled');
  assert.equal(select().value, 'supports'); assert.equal(select().attrs['aria-label'], 'Relation type');
  const reason = dom.find(host, c => (c.cls ?? '').includes('vam-relation-reason'));
  assert.equal(reason.text, 'Unavailable because they would form a cycle: Derives from'); assert.equal(select().attrs['aria-describedby'], reason.attrs.id);
  assert.equal(heEditor([{ kind: 'supports', from: 'a', to: 'b' }], { kind: 'supports', from: 'a', to: 'b' }).openKinds().length, 6, 'no cycle, no disabled option');
  assert.equal(dom.find(heEditor([{ kind: 'supports', from: 'a', to: 'b' }], { kind: 'supports', from: 'a', to: 'b' }).host, c => (c.cls ?? '').includes('vam-relation-reason')), undefined, 'and no reason');
});
integrationTest('hypothesis-evidence: changing the kind is one mapChange, keeps the note, follows the line selection, and is refused if the map changed meanwhile', async () => {
  const relations = [{ kind: 'supports', from: 'a', to: 'b', description: 'note' }];
  const { view, doc, calls, select } = heEditor(relations, relations[0]);
  select().value = 'contradicts'; select().fire('change'); await dom.tick();
  assert.deepEqual(plain(doc.topicRelations), [{ kind: 'contradicts', from: 'a', to: 'b', description: 'note' }]);
  assert.deepEqual(calls, [false], 'exactly one undoable change, no derived-data rebuild');
  assert.equal(view.selection.state.selectedRelation, heKey({ kind: 'contradicts', from: 'a', to: 'b' }), 'the same line stays selected under its new kind');
  doc.topicRelations.push({ kind: 'derives_from', from: 'b', to: 'c' }, { kind: 'derives_from', from: 'c', to: 'a' }); // decision #37: a pair holds one relation, so the refused change is now the cycle (Q7)
  select().value = 'derives_from'; select().fire('change'); await dom.tick();
  assert.equal(doc.topicRelations[0].kind, 'contradicts', 'a kind that became a cycle in the map is refused');
  assert.equal(calls.length, 2);
});
integrationTest('hypothesis-evidence: reverse swaps A and B in one change; "related" has no reverse button', async () => {
  const relations = [{ kind: 'supports', from: 'a', to: 'b' }];
  const { view, doc, calls, host } = heEditor(relations, relations[0]);
  dom.button(host, 'Reverse direction').click(); await dom.tick();
  assert.deepEqual(plain(doc.topicRelations), [{ kind: 'supports', from: 'b', to: 'a' }]); assert.deepEqual(calls, [false]);
  assert.equal(view.selection.state.selectedRelation, heKey({ kind: 'supports', from: 'b', to: 'a' }));
  const related = heEditor([{ kind: 'related', from: 'a', to: 'b' }], { kind: 'related', from: 'a', to: 'b' });
  assert.equal(dom.buttons(related.host).includes('Reverse direction'), false);
});
integrationTest('hypothesis-evidence: an illegal reverse (it would close a cycle, derives or prerequisite) is disabled with its reason and does nothing', async () => {
  const cycle = [{ kind: 'derives_from', from: 'a', to: 'b' }, { kind: 'derives_from', from: 'a', to: 'c' }, { kind: 'derives_from', from: 'c', to: 'b' }];
  const one = heEditor(cycle, cycle[0]);
  const button = dom.button(one.host, 'Reverse direction');
  assert.equal(button.disabled, true); button.click(); await dom.tick(); assert.deepEqual(one.calls, []);
  const reason = dom.find(one.host, c => String(c.cls).includes('vam-relation-reason'));
  assert.equal(reason.text, 'Cannot reverse: it would form a cycle.'); assert.equal(button.attrs['aria-describedby'], reason.attrs.id);
  const pre = [{ kind: 'prerequisite', from: 'a', to: 'b' }, { kind: 'prerequisite', from: 'a', to: 'c' }, { kind: 'prerequisite', from: 'c', to: 'b' }]; // was a same-pair duplicate fixture (decision #37); now the prerequisite cycle
  const two = heEditor(pre, pre[0]);
  assert.equal(dom.button(two.host, 'Reverse direction').disabled, true);
  assert.equal(dom.find(two.host, c => String(c.cls).includes('vam-relation-reason')).text, 'Cannot reverse: it would form a cycle.');
});
integrationTest('hypothesis-evidence: the note is a multi-line box saved as one line of up to 200 characters; it saves itself on leaving the box, on Ctrl/Cmd+Enter and on close, once per change; an empty note removes the key; Enter only breaks the line (E2, decision 40)', async () => {
  const relations = [{ kind: 'supports', from: 'a', to: 'b' }];
  const { doc, calls, host, input, saveNote } = heEditor(relations, relations[0]);
  assert.equal(input().tag, 'textarea'); assert.equal(input().attrs.maxlength, '200');
  assert.equal(dom.button(host, 'Apply'), undefined, 'there is no Apply button');
  const box = input();
  box.value = '  hello \n   world  '; box.fire('input');
  assert.equal(calls.length, 0, 'typing alone writes nothing'); assert.equal(dom.find(host, c => (c.cls ?? '').includes('vam-relation-remaining')).text, `${200 - 19} characters left`);
  box.fire('change'); await dom.tick();
  assert.equal(doc.topicRelations[0].description, 'hello world', 'leaving the box saved it; line breaks became spaces');
  assert.equal(input(), box, 'a note save does not repaint the dialog');
  box.value = 'hello\nworld'; box.fire('input'); box.fire('change'); await dom.tick();
  assert.equal(calls.length, 1, 'a break that normalizes to the saved text is no change');
  box.value = 'x'.repeat(201); box.fire('input'); box.fire('keydown', { key: 'Enter' }); await dom.tick();
  assert.equal(calls.length, 1, 'plain Enter only adds a line break');
  assert.equal(dom.find(host, c => (c.cls ?? '').includes('vam-relation-remaining')).text, '0 characters left');
  box.fire('keydown', { key: 'Enter', ctrlKey: true }); box.fire('change'); await dom.tick();
  assert.equal(doc.topicRelations[0].description.length, 200, 'Ctrl+Enter saves'); assert.equal(calls.length, 2, 'leaving the box after Ctrl+Enter does not save twice');
  box.value = 'later'; box.fire('input');
  await saveNote(); assert.equal(doc.topicRelations[0].description, 'later', 'closing saves a note still in the box'); assert.equal(calls.length, 3);
  await saveNote(); assert.equal(calls.length, 3, 'a second close-time save has nothing to write');
  box.value = '   '; box.fire('input'); box.fire('change'); await dom.tick();
  assert.equal('description' in doc.topicRelations[0], false, 'clearing deletes the key'); assert.equal(calls.length, 4);
});
integrationTest('hypothesis-evidence: the editor head reads "A relation B" with both ends named and a line sample, and both follow a kind or direction change (E1)', async () => {
  const relations = [{ kind: 'supports', from: 'a', to: 'b' }];
  const { host, select, calls } = heEditor(relations, relations[0]);
  const sentence = () => dom.find(host, c => (c.cls ?? '').includes('vam-relation-sentence')).text, swatchKinds = () => { const svg = dom.find(host, c => (c.cls ?? '').includes('vam-relation-editor-summary'))?.children.find(c => (c.classes ?? []).includes('vam-relation-swatch')); return (svg?.children ?? []).filter(c => c.tag === 'path').flatMap(c => c.classes.join(' ')); };
  assert.equal(sentence(), 'A supports B'); assert.ok(swatchKinds()[0].includes('vam-relation-supports'));
  dom.button(host, 'Reverse direction').click(); await dom.tick();
  assert.equal(sentence(), 'B supports A', 'a reverse swaps the names at once');
  select().value = 'derives_from'; select().fire('change'); await dom.tick();
  assert.equal(sentence(), 'B is derived from A'); assert.ok(swatchKinds().some(c => c.includes('vam-relation-derives_from')) && swatchKinds().some(c => c.includes('vam-relation-gap')), 'the double line');
  select().value = 'related'; select().fire('change'); await dom.tick();
  assert.equal(sentence(), 'B is related to A', 'related names both ends too, not "This topic"'); assert.equal(swatchKinds().length, 1, 'one plain line, no arrowhead'); assert.ok(swatchKinds()[0].includes('vam-relation-related'));
  assert.equal(dom.buttons(host).includes('Reverse direction'), false, 'related has no direction row'); assert.equal(dom.texts(host).includes('Direction'), false);
  assert.deepEqual(calls, [false, false, false]);
});
integrationTest('hypothesis-evidence: each field takes its own row with the label above the control; the direction row has one Reverse button (E2, E3)', () => {
  const relations = [{ kind: 'supports', from: 'a', to: 'b' }];
  const { host } = heEditor(relations, relations[0]);
  const rows = dom.findAll(host, c => (c.cls ?? '').split(/\s+/).includes('vam-relation-field'));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.children[0].text), ['Relation type', 'Direction', 'Note (optional)'], 'label first in each row, then the control');
  assert.equal(rows[0].children[0].attrs.for, rows[0].children[1].attrs.id, 'the label is tied to its control');
  assert.equal(rows[1].children.filter(c => c.tag === 'button').length, 1);
});
integrationTest('hypothesis-evidence: the footer has Delete on the left and Close on the right; Delete is a warning button; there is no Apply (E5, decision 40)', () => {
  const relations = [{ kind: 'supports', from: 'a', to: 'b' }];
  const { host, closed } = heEditor(relations, relations[0]);
  const footer = dom.find(host, c => (c.cls ?? '').split(/\s+/).includes('vam-relation-footer'));
  assert.deepEqual(footer.children.filter(c => c.tag === 'button').map(c => c.text), ['Delete relation', 'Close']);
  assert.ok(footer.children[0].cls.includes('mod-warning') && footer.children[0].cls.includes('vam-discard'));
  assert.equal(dom.findAll(footer, c => (c.cls ?? '').includes('mod-cta')).length, 0, 'no primary button is left');
  dom.button(host, 'Close').click(); assert.equal(closed.length, 1);
  const css = heCss();
  assert.match(heRuleBody(css, '.vam-next-actions > .vam-discard'), /order: -2/, 'the shared footer CSS keeps Delete first');
});
integrationTest('hypothesis-evidence: after a change the focus stays on the control that was used (kind, reverse); a note save leaves the box in place (decision 40)', async () => {
  const relations = [{ kind: 'supports', from: 'a', to: 'b' }];
  const { host, select, input } = heEditor(relations, relations[0]);
  select().value = 'verifies'; select().fire('change'); await dom.tick();
  assert.equal(select().focused, true);
  dom.button(host, 'Reverse direction').click(); await dom.tick();
  assert.equal(dom.button(host, 'Reverse direction').focused, true);
  const box = input(); box.value = 'n'; box.fire('input'); box.fire('keydown', { key: 'Enter', metaKey: true }); await dom.tick();
  assert.equal(input(), box, 'the box the user is typing in is not replaced');
});
integrationTest('hypothesis-evidence: every P24 editor rule is invisible to the share viewer and starts with .vam-topic-modal (decision 35)', async () => {
  const css = heCss();
  const { parseCss, extractViewerRules } = await import(require('node:url').pathToFileURL(path.join(root, 'scripts/viewer-css.mjs')).href);
  const mine = /vam-relation-(?:editor|field|reason|remaining|footer)/;
  const own = parseCss(css).filter(chunk => mine.test(chunk.prelude));
  assert.ok(own.length >= 8, `the editor rules exist (${own.length})`);
  assert.ok(own.every(chunk => chunk.prelude.split(',').every(sel => sel.trim().startsWith('.vam-topic-modal '))), 'scoped to the dialog');
  const viewer = extractViewerRules(css).map(item => item.text).join('\n');
  for (const chunk of own) assert.equal(viewer.includes(chunk.text), false, `not in the viewer: ${chunk.prelude.slice(0, 60)}`);
  const without = parseCss(css).filter(chunk => !mine.test(chunk.prelude)).map(chunk => chunk.text).join('\n');
  assert.equal(extractViewerRules(without).map(item => item.text).join('\n'), viewer, 'byte-identical viewer rules');
});
integrationTest('hypothesis-evidence: Delete removes the relation in one change, closes the editor, repaints the panel, and an undone/vanished relation says so', async () => {
  const relations = [{ kind: 'supports', from: 'a', to: 'b' }];
  const { view, doc, calls, closed, changed, host } = heEditor(relations, relations[0]);
  view.selection.selectRelation(heKey(relations[0]));
  dom.button(host, 'Delete relation').click(); await dom.tick();
  assert.equal('topicRelations' in doc, false); assert.deepEqual(calls, [false]); assert.equal(closed.length, 1); assert.equal(changed.length, 1); assert.equal(view.selection.state.selectedRelation, null);
  const gone = heEditor([], { kind: 'supports', from: 'a', to: 'b' });
  assert.ok(dom.texts(gone.host).includes('This relation no longer exists.'));
  assert.equal(dom.buttons(gone.host).includes('Delete relation'), false);
});
integrationTest('hypothesis-evidence: a note like <img src=x onerror=alert(1)> is shown as text in the panel row and the editor, and no img element exists', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const relations = [{ kind: 'supports', from: 'a', to: 'b', description: evil }];
  const { host, input } = heEditor(relations, relations[0]);
  assert.equal(input().value, evil); assert.equal(dom.findAll(host, c => c.tag === 'img').length, 0);
  const { view } = heFixture({ relations: [{ kind: 'supports', from: 'fact', to: 'hyp', description: evil }] });
  const panel = dom.element('panel'); view.renderHypothesisSection(panel, view.map.nodes[0]);
  assert.ok(dom.texts(panel).includes(evil), 'shown verbatim'); assert.equal(dom.findAll(panel, c => c.tag === 'img').length, 0);
  const src = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  const editor = src.slice(src.indexOf('private renderRelationEditor'), src.indexOf('/** `focus` false leaves the camera'));
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML/.test(editor), false, 'the editor and the panel rows never parse markup');
});
integrationTest('hypothesis-evidence: an AIM map has no relation section, no add entry and no editor', () => {
  for (const options of [{ aim: true, relations: [{ kind: 'supports', from: 'fact', to: 'hyp' }] }]) {
    const fx = heFixture(options);
    const panel = dom.element('panel'); fx.view.renderHypothesisSection(panel, fx.view.map.nodes[0]);
    assert.equal(panel.children.length, 0, 'nothing is rendered');
    fx.view.openRelationEditor(options.relations[0]);
    assert.equal(fx.modals.length, 0); assert.deepEqual(fx.notices, []);
  }
});
integrationTest('hypothesis-evidence: the V1.5 evidence and prerequisite panel keys are gone and the six relation names exist in all three languages', () => {
  const read = lang => fs.readFileSync(path.join(root, 'i18n', `${lang}.ts`), 'utf8');
  const names = { en: ['Supports', 'Contradicts', 'Verifies', 'Derives from', 'Related', 'Prerequisite'], 'zh-TW': ['支持', '反駁', '驗證', '推導', '相關', '前置知識'], 'zh-CN': ['支持', '反驳', '验证', '推导', '相关', '前置知识'] };
  for (const lang of Object.keys(names)) {
    ['supports', 'contradicts', 'verifies', 'derives_from', 'related', 'prerequisite'].forEach((kind, i) => assert.ok(read(lang).includes(`"ui.relation_name_${kind}": "${names[lang][i]}"`), `${lang} ${kind}`));
    for (const gone of ['ui.evidence_for_heading', 'ui.evidence_from_heading', 'ui.add_evidence', 'ui.add_prerequisite', 'ui.relation_name_evidence', 'ui.remove_evidence_link_0', 'ui.remove_prerequisite_link_0', 'log.evidence_relation_type_ignored_0'])
      assert.equal(read(lang).includes(`"${gone}`), false, `${lang} ${gone}`);
  }
});

// ---- hypothesis-evidence (V1.6 P13): six line styles, labels, nearest-side routing ----
const heGeo = () => load('experiences/visual-map/relation-geometry.ts', {}, {});
const heBox = (x, y, width = 280, height = 100) => ({ x, y, width, height });
const heNums = d => d.match(/-?\d+(\.\d+)?/g).map(Number);
const heKinds = ['supports', 'contradicts', 'verifies', 'derives_from', 'related', 'prerequisite'];
const heSixRel = [{ kind: 'supports', from: 'fact', to: 'hyp' }, { kind: 'contradicts', from: 'hyp', to: 'other' }, { kind: 'verifies', from: 'other', to: 'fact' }, { kind: 'derives_from', from: 'fact', to: 'extra' }, { kind: 'related', from: 'hyp', to: 'extra' }, { kind: 'prerequisite', from: 'other', to: 'extra' }]; // decision #37: six kinds on six different pairs (K4)
const heSix = (options = {}) => {
  const fx = heFixture({ relations: options.relations ?? heSixRel, shared: options.shared, topics: [node('fact'), node('hyp'), node('other'), node('extra')], notes: heNotes([['fact', {}], ['hyp', heHyp('weak')], ['other', {}], ['extra', {}]]) });
  const kids = heDrawn(fx.view, { fact: [0, 0], hyp: [500, 40], other: [0, 300], extra: [500, 300] });
  return { ...fx, kids, line: kind => kids.find(k => k.classes.includes(`vam-relation-${kind}`)), labels: kids.filter(k => k.classes.includes('vam-relation-label')), hits: kids.filter(k => k.classes.includes('vam-relation-hit')) };
};
integrationTest('hypothesis-evidence: cards stacked one above the other are joined bottom edge to top edge, and side by side left edge to right edge', () => {
  const { relationPathData, nearestSides } = heGeo();
  assert.equal(relationPathData(heBox(0, 0), heBox(0, 200)), 'M 140 100 C 140 150, 140 150, 140 200', 'a above b: from the bottom of a to the top of b');
  assert.equal(relationPathData(heBox(0, 200), heBox(0, 0)), 'M 140 200 C 140 150, 140 150, 140 100', 'a below b: from the top of a to the bottom of b');
  assert.equal(relationPathData(heBox(0, 0), heBox(500, 0)), 'M 280 50 C 340 50, 440 50, 500 50');
  assert.equal(relationPathData(heBox(500, 0), heBox(0, 0)), 'M 500 50 C 440 50, 340 50, 280 50', 'right to left leaves the left edge');
  const sides = nearestSides(heBox(0, 0), heBox(0, 200));
  assert.deepEqual([sides.from.ny, sides.to.ny], [1, -1], 'the normals point away from each card');
});
integrationTest('hypothesis-evidence: cards that touch edge to edge (stacked diamonds) still get a line with length, so the line and its label are not 0 wide', () => {
  const { relationPathData, relationLabelPoint } = heGeo();
  for (const [a, b] of [[heBox(0, 0), heBox(0, 100)], [heBox(0, 100), heBox(0, 0)], [heBox(0, 0), heBox(280, 0)], [heBox(0, 0), heBox(40, 100)]]) {
    const [x1, y1, , , , , x2, y2] = heNums(relationPathData(a, b));
    assert.ok(Math.hypot(x2 - x1, y2 - y1) > 0, `touching ${JSON.stringify([a, b])}: the line has a length (${x1},${y1} to ${x2},${y2})`);
    const label = relationLabelPoint(a, b);
    assert.ok(Number.isFinite(label.x) && Number.isFinite(label.y));
  }
});
integrationTest('hypothesis-evidence: in a map that grows sideways a column of evidence meets the hypothesis from the side, however far up or down, so no line runs behind the cards between; up-down maps lean to the ends', () => {
  const { relationPathData, relationLabelPoint, nearestSides, relationAxisFor, AXIS_GAP } = heGeo();
  assert.equal(AXIS_GAP, 32);
  assert.deepEqual(['right', 'left', 'balanced', 'down', 'up', 'radial', 'fishbone', 'timeline'].map(relationAxisFor), ['sides', 'sides', 'sides', 'ends', 'ends', undefined, undefined, undefined]);
  // The owner's auto-laid-out map: the hypothesis on the left, six evidence cards stacked in a column on the right.
  const hyp = heBox(115, 770, 475, 322), column = [70, 335, 645, 908, 1172, 1572].map(y => heBox(728, y, 475, 222));
  for (const card of column) {
    const { from, to } = nearestSides(card, hyp, 'sides');
    assert.deepEqual([from.x, from.nx, to.x, to.nx], [728, -1, 590, 1], `evidence at y ${card.y}: its left edge to the hypothesis' right edge`);
    const xs = heNums(relationPathData(card, hyp, 'sides')).filter((_, i) => i % 2 === 0);
    assert.ok(xs.every(x => x >= 590 && x <= 728), `evidence at y ${card.y}: the curve stays in the gap between the two columns (${xs})`);
  }
  // Before the fix (and still with no axis) the far cards left their bottom or top edge and ran behind the cards between.
  assert.equal(nearestSides(column[0], hyp).from.ny, 1);
  assert.equal(nearestSides(column[5], hyp).from.ny, -1);
  // The preference needs room for two shortest arms; under that the closer-axis rule decides.
  assert.equal(relationPathData(heBox(0, 0), heBox(311, 600), 'sides'), relationPathData(heBox(0, 0), heBox(311, 600)));
  assert.equal(relationPathData(heBox(0, 0), heBox(312, 600), 'sides'), 'M 280 50 C 296 50, 296 650, 312 650');
  // The mirror in an up-down map: a card far to the side but a row below still meets the bottom edge.
  assert.equal(relationPathData(heBox(0, 0), heBox(900, 132), 'ends'), 'M 140 100 C 140 116, 1040 116, 1040 132');
  assert.equal(relationPathData(heBox(0, 0), heBox(900, 132)), 'M 280 50 C 340 50, 840 182, 900 182', 'with no axis the wide gap wins');
  const [x1, y1, cx1, cy1, cx2, cy2, x2, y2] = heNums(relationPathData(column[0], hyp, 'sides'));
  assert.deepEqual(plain(relationLabelPoint(column[0], hyp, 'sides')), { x: (x1 + 3 * cx1 + 3 * cx2 + x2) / 8, y: (y1 + 3 * cy1 + 3 * cy2 + y2) / 8 }, 'the label follows the same curve');
});
integrationTest('hypothesis-evidence: the control arms are clamped to 16..60 and never leave a 60px margin around the two cards (same-side layouts included)', () => {
  const { relationPathData, relationLabelPoint } = heGeo();
  assert.deepEqual(heNums(relationPathData(heBox(0, 0), heBox(290, 0))).slice(2, 4), [296, 50], 'a 10px gap still gets a 16px arm');
  assert.deepEqual(heNums(relationPathData(heBox(0, 0), heBox(1000, 0))).slice(2, 4), [340, 50], 'a long gap caps the arm at 60');
  const pairs = [[heBox(0, 0), heBox(300, 160)], [heBox(0, 0), heBox(200, 300)], [heBox(300, 160), heBox(0, 0)], [heBox(0, 0), heBox(260, 90)], [heBox(0, 0), heBox(0, 20)], [heBox(0, 0), heBox(400, 900)]];
  for (const [a, b] of pairs) {
    const [x1, y1, cx1, cy1, cx2, cy2, x2, y2] = heNums(relationPathData(a, b));
    const left = Math.min(a.x, b.x) - 60, right = Math.max(a.x + a.width, b.x + b.width) + 60, top = Math.min(a.y, b.y) - 60, bottom = Math.max(a.y + a.height, b.y + b.height) + 60;
    for (const [x, y] of [[x1, y1], [cx1, cy1], [cx2, cy2], [x2, y2]]) assert.ok(x >= left && x <= right && y >= top && y <= bottom, `${JSON.stringify([a, b])}: point ${x},${y} stays within 60px of the cards`);
  }
  assert.equal(relationPathData(heBox(0, 0), heBox(100, 40)), 'M 140 50 C 140 50, 240 90, 240 90', 'overlapping cards join centre to centre with no arm');
  assert.deepEqual(plain(relationLabelPoint(heBox(0, 0), heBox(500, 40))), { x: 390, y: 70 }, 'the lone label is the curve at t = 0.5');
});
integrationTest('hypothesis-evidence: each of the six kinds draws its own class; related has no arrow, contradicts the barred arrow, the others the plain arrow', () => {
  const { kids, line } = heSix();
  const defs = kids.find(k => k.tag === 'defs'), arrow = defs.children[0], bar = defs.children[1];
  assert.equal(defs.children.length, 2, 'two markers per view');
  assert.ok(arrow.children.length === 1 && bar.children.length === 2, 'the barred marker is the arrow plus a bar'); assert.ok(bar.children[1].classes.includes('vam-relation-arrow-bar'));
  assert.notEqual(arrow.attrs.id, bar.attrs.id);
  for (const kind of heKinds) { assert.ok(line(kind).classes.includes('vam-relation'), kind); assert.equal(kids.filter(k => k.classes.includes(`vam-relation-${kind}`)).length, 1, `${kind} drawn once`); }
  for (const kind of ['supports', 'verifies', 'derives_from', 'prerequisite']) assert.equal(line(kind).attrs['marker-end'], `url(#${arrow.attrs.id})`, kind);
  assert.equal(line('contradicts').attrs['marker-end'], `url(#${bar.attrs.id})`);
  assert.equal(line('related').attrs['marker-end'], undefined, 'related has no arrowhead');
});
integrationTest('hypothesis-evidence: both marker ids are unique per view, so two map tabs open together never share one', () => {
  const a = heSix(), b = heSix({ shared: { VisualAgentMapView: heFixture().VisualAgentMapView } });
  const ids = fx => fx.kids.find(k => k.tag === 'defs').children.map(m => m.attrs.id);
  const all = [...ids(a), ...ids(b)];
  assert.equal(new Set(all).size, 4, 'four distinct ids');
  assert.equal(b.line('contradicts').attrs['marker-end'], `url(#${ids(b)[1]})`, 'each view points at its own marker');
});
integrationTest('hypothesis-evidence: "derives from" is a double line: the outer line plus a gap line on the same path, with its own arrowhead; no other kind has one', () => {
  const { kids, line } = heSix();
  const gaps = kids.filter(k => k.classes.includes('vam-relation-gap'));
  assert.equal(gaps.length, 1); assert.equal(gaps[0].attrs.d, line('derives_from').attrs.d); assert.equal(gaps[0].attrs['marker-end'], line('derives_from').attrs['marker-end']);
  assert.ok(kids.indexOf(gaps[0]) > kids.indexOf(line('derives_from')), 'the gap line is painted over the outer line');
  assert.equal(gaps[0].classes.includes('vam-relation'), false, 'the gap line takes no selection class');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(css, /^\.vam-relation-derives_from \{ --vam-relation-width: 4\.5px; \}/m); assert.match(css, /^\.vam-relation-gap \{[^}]*stroke: var\(--background-primary\);[^}]*stroke-width: 1\.5px;/m); // decision 35 A2: 5px/2px became 4.5px/1.5px
});
integrationTest('hypothesis-evidence: styles.css gives the six kinds their widths and patterns: 2px solid, 8 4, 1 5 round, 5px double, 1.25px, 10 4 2 4', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const rule = selector => css.match(new RegExp(`^${selector.replace(/[.[\]"=_-]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm'))[1];
  assert.match(rule('.vam-relation'), /stroke-width:\s*var\(--vam-relation-width, 1\.75px\)/); /* decision 35 A2: 2px became 1.75px */ assert.match(rule('.vam-relation'), /pointer-events:\s*none/);
  assert.match(rule('.vam-relation-supports'), /stroke-dasharray:\s*none/); assert.match(rule('.vam-relation-contradicts'), /stroke-dasharray:\s*8 4/);
  assert.match(rule('.vam-relation-verifies'), /stroke-dasharray:\s*1 5/); assert.match(rule('.vam-relation-verifies'), /stroke-linecap:\s*round/);
  assert.match(rule('.vam-relation-related'), /--vam-relation-width:\s*1\.25px/); assert.match(rule('.vam-relation-prerequisite'), /stroke-dasharray:\s*10 4 2 4/);
  assert.doesNotMatch(css, /vam-relation-evidence/, 'no V1.5 evidence line rule is left'); assert.doesNotMatch(css, /\.vam-relation-label \{[^}]*visibility: hidden/, 'labels are not hidden by default');
});
integrationTest('hypothesis-evidence: the labels show each kind name by default; a selected line reads "Name: A → B" (related uses —) and the note on a second line', () => {
  const rel = heSixRel.map((r, i) => i === 0 ? { ...r, description: 'because it was measured' } : r);
  const { kids, labels, hits, view } = heSix({ relations: rel });
  assert.deepEqual(labels.map(l => l.textContent), ['Supports', 'Contradicts', 'Verifies', 'Derives from', 'Related', 'Prerequisite']);
  assert.ok(labels.every(l => !heExpanded(l)));
  hits[0].fire('pointerdown', { stopPropagation() {} });
  assert.deepEqual(labels[0].children.map(c => [c.tag, c.textContent]), [['tspan', 'Supports: FACT → HYP'], ['tspan', 'because it was measured']]);
  assert.equal(labels[0].children[1].attrs.dy, '1.3em', 'the note is the second line'); assert.equal(labels[0].children[1].attrs.x, labels[0].attrs.x);
  hits[4].fire('pointerdown', { stopPropagation() {} });
  assert.equal(labels[4].children[0].textContent, 'Related: HYP — EXTRA'); assert.equal(labels[4].children.length, 1, 'no note, no second line');
  assert.equal(labels[0].textContent, 'Supports', 'the previously selected label folds back'); assert.equal(view.selection.state.selectedRelation, heKey(rel[4]));
});
integrationTest('hypothesis-evidence: a long note is cut to 60 characters with an ellipsis, and markup in a note stays text (tspan textContent only, no element is built from it)', () => {
  const long = 'x'.repeat(61), exact = 'y'.repeat(60), html = '<img src=x onerror=alert(1)>';
  const { labels, hits, view } = heSix({ relations: [{ kind: 'supports', from: 'fact', to: 'hyp', description: long }, { kind: 'related', from: 'hyp', to: 'other', description: exact }, { kind: 'verifies', from: 'other', to: 'fact', description: html }] });
  hits[0].fire('pointerdown', { stopPropagation() {} }); assert.equal(labels[0].children[1].textContent, `${'x'.repeat(60)}…`);
  hits[1].fire('pointerdown', { stopPropagation() {} }); assert.equal(labels[1].children[1].textContent, exact, '60 characters are kept whole');
  hits[2].fire('pointerdown', { stopPropagation() {} }); assert.equal(labels[2].children[1].textContent, html); assert.equal(labels[2].children[1].tag, 'tspan');
  assert.equal(view.edgesEl.kids.some(k => k.tag === 'img'), false);
  const src = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.doesNotMatch(src.slice(src.indexOf('private paintRelationLabel'), src.indexOf('private placeRelationLabel')), /innerHTML|insertAdjacentHTML/);
});
integrationTest('hypothesis-evidence: relation labels are hidden below 60% zoom (0.59 hidden, 0.6 shown) through an attribute on the stage', () => {
  const { view } = heFixture();
  const attrs = {}; view.stageEl = { style: { setProperty() {} }, setAttribute(n, v) { attrs[n] = v; }, removeAttribute(n) { delete attrs[n]; } };
  for (const [zoom, hidden] of [[0.25, true], [0.59, true], [0.6, false], [1, false], [2, false]]) {
    view.map.viewport.zoom = zoom; view.transform();
    assert.equal(attrs['data-relation-labels'], hidden ? 'hidden' : undefined, `zoom ${zoom}`);
  }
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(css, /^\[data-relation-labels="hidden"\] \.vam-relation-label \{ display: none; \}/m, 'the rule starts with the attribute');
});
integrationTest('hypothesis-evidence: dragging a card moves the line, its gap line, its hit path and its label (expanded text included) together', () => {
  const { view, line, labels, hits, kids } = heSix({ relations: [{ kind: 'derives_from', from: 'fact', to: 'hyp', description: 'why' }] });
  const gap = kids.find(k => k.classes.includes('vam-relation-gap'));
  hits[0].fire('pointerdown', { stopPropagation() {} });
  const before = line('derives_from').attrs.d, x0 = labels[0].attrs.x;
  view.dragEdges('hyp', view.cardEls.get('hyp')).update(0, 400);
  const d = line('derives_from').attrs.d;
  assert.notEqual(d, before); assert.equal(gap.attrs.d, d); assert.equal(hits[0].attrs.d, d);
  assert.match(d, /^M 140 100 C /, 'now hyp is below fact: bottom edge to top edge'); assert.notEqual(labels[0].attrs.x, x0);
  assert.ok(labels[0].children.every(c => c.attrs.x === labels[0].attrs.x), 'both tspans follow the label');
});
integrationTest('hypothesis-evidence: a press on any of the six lines stops here (no pan, no marquee); the parent-child edge keeps its DOM, class and no handlers', () => {
  // decision 39: a parent and child that hold a relation draw no parent line, so the parent-child pair here (fact -> kid) has none.
  const fx = heFixture({ relations: heSixRel, topics: [node('fact'), node('hyp'), node('other'), node('extra'), node('kid', 'fact')], notes: heNotes([['fact', {}], ['hyp', heHyp('weak')], ['other', {}], ['extra', {}], ['kid', {}]]) });
  const kids = heDrawn(fx.view, { fact: [0, 0], hyp: [500, 40], other: [0, 300], extra: [500, 300], kid: [500, 600] });
  const hits = kids.filter(k => k.classes.includes('vam-relation-hit')); assert.equal(hits.length, 6);
  for (const hit of hits) { let stopped = 0; hit.fire('pointerdown', { stopPropagation() { stopped++; } }); assert.equal(stopped, 1); }
  const edge = fx.view.edgeEls.get('fact\u0000kid'); assert.ok(edge, 'the parent-child edge is drawn');
  assert.deepEqual(edge.classes, ['vam-edge']); assert.deepEqual(Object.keys(edge.listeners), []); assert.equal(edge.attrs['marker-end'], undefined);
  assert.match(edge.attrs.d, /^M 280 50 C /, 'it still leaves the parent right edge as before');
});
integrationTest('hypothesis-evidence: selecting a topic adds no fade class to any card; the lines get is-related and is-dimmed in all six kinds', () => {
  const { view, kids } = heSix();
  view.selection.setSelected('fact'); view.paintCards(['fact']);
  for (const [id, card] of view.cardEls) assert.ok(!card.classes.some(c => /dim|fade|muted/.test(c)), `${id} is not faded`);
  const lines = kids.filter(k => k.classes.includes('vam-relation'));
  assert.equal(lines.length, 6);
  const related = lines.filter(l => l.classes.includes('is-related')).length, dimmed = lines.filter(l => l.classes.includes('is-dimmed')).length;
  assert.equal(related, 3, 'three of the six touch fact (one relation per pair: fact-hyp, fact-other, fact-extra)'); assert.equal(dimmed, 3);
});
integrationTest('hypothesis-evidence: the end cards of a selected line outline themselves on the shape for the four shaped types, and the rectangle outline stays for the rest', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const line = css.split('\n').find(l => l.includes('.is-relation-end:not([data-aim-kind])'));
  assert.ok(line && line.startsWith('[data-topic-kind="atomic"]'), 'starts with the attribute');
  for (const kind of ['atomic', 'hypothesis', 'evidence', 'conclusion']) assert.ok(line.includes(`[data-topic-kind="${kind}"].vam-node.is-relation-end`), kind);
  assert.ok(!line.includes('"action"'), 'action keeps the rectangular outline');
  assert.match(line, /outline: 0;[^}]*--vam-kind-line: color-mix\(in srgb, var\(--interactive-accent\)[^}]*--vam-kind-width: 3px/);
  assert.match(css, /^\.is-relation-end\.vam-node \{ outline: 2px solid var\(--interactive-accent\)/m);
});
// ---- hypothesis-evidence (P19, decision 35): visual polish of cards and lines ----
integrationTest('hypothesis-evidence: only a mind map\'s own parent line carries data-parent-line; AIM and a skippable branch keep the plain accent edge (A1)', () => {
  const topics = [node('root'), node('kid', 'root'), node('skip', 'root')];
  const notes = heNotes([['root', {}], ['kid', {}], ['skip', { relevance: { tier: 'side' } }]]);
  const edges = options => { const fx = heFixture({ topics, notes, ...options }); return heDrawn(fx.view, { root: [0, 0], kid: [400, 0], skip: [400, 200] }); };
  const plain = edges({});
  assert.equal(plain.length, 2);
  const kid = plain.find(p => !p.classes.includes('vam-edge-side')), skip = plain.find(p => p.classes.includes('vam-edge-side'));
  assert.ok(kid.classes.includes('vam-edge') && 'data-parent-line' in kid.attrs, 'an ordinary parent line is marked');
  assert.equal('data-parent-line' in skip.attrs, false, 'a skippable branch keeps its own muted edge');
  for (const options of [{ aim: true }]) for (const p of edges(options)) { assert.equal('data-parent-line' in p.attrs, false); assert.deepEqual(p.classes.filter(c => c !== 'vam-edge'), []); }
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(css, /^path\[data-parent-line\] \{ stroke: color-mix\(in srgb, var\(--interactive-accent\) 35%, var\(--text-muted\)\); stroke-width: 1\.5px; \}/m);
  assert.match(css, /^\.vam-edge \{ fill: none; stroke: var\(--interactive-accent\); stroke-width: 2; opacity: 1; \}/m, 'the shared .vam-edge rule is untouched');
});
integrationTest('hypothesis-evidence: atomic, evidence, conclusion and action cards carry a type tag in the header, a hypothesis keeps "Hypothesis · strength", an ordinary topic and AIM show none (B1)', () => {
  const render = (kind, options = {}) => {
    const f = heFixture({ notes: heNotes([['fact', kind === 'topic' ? {} : kind === 'hypothesis' ? heHyp('medium') : { topicKind: kind }], ['hyp', {}], ['other', {}]]), ...options });
    f.view.stageEl = hePatch(dom.element('stage')); f.view.renderNode(f.view.map.nodes.find(n => n.id === 'fact'));
    const card = f.view.stageEl.children[0], tags = []; dom.find(card, c => { if ((c.cls ?? '').split(/\s+/).includes('vam-hypothesis-tag')) tags.push(c); return false; });
    return tags;
  };
  for (const kind of ['atomic', 'evidence', 'conclusion', 'action']) {
    const tags = render(kind); assert.equal(tags.length, 1, `${kind} has one tag`);
    assert.equal(tags[0].text, heKindNames[heKindIds.indexOf(kind)]); assert.match(tags[0].cls, /vam-kind-tag/);
  }
  const hyp = render('hypothesis'); assert.equal(hyp.length, 1); assert.equal(hyp[0].text, 'Hypothesis · Undecided · Medium'); assert.doesNotMatch(hyp[0].cls, /vam-kind-tag/, 'the hypothesis tag is the existing one');
  assert.equal(render('topic').length, 0, 'an ordinary topic has no tag');
  assert.equal(render('evidence', { aim: true }).length, 0, 'AIM has no tag');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  for (const kind of ['atomic', 'hypothesis', 'evidence', 'conclusion', 'action']) assert.ok(css.includes(`[data-topic-kind="${kind}"].vam-node .vam-hypothesis-tag`), `${kind} tag rule`);
  assert.match(css, /\.vam-hypothesis-tag \{ color: color-mix\(in srgb, var\(--vam-kind-hue\) \d+%, var\(--text-normal\)\); \}/, 'the tag takes the type hue');
});
integrationTest('hypothesis-evidence: a hypothesis title clamps at 3 lines, a hypothesis or atomic summary at 2, an atomic title stays at 2, and the clipped text is in the title attribute (B2)', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(css, /^\[data-topic-kind="hypothesis"\] \.vam-card-title \{[^}]*-webkit-line-clamp: 3;[^}]*overflow: hidden;/m);
  assert.match(css, /^\[data-topic-kind="atomic"\] \.vam-card-title \{[^}]*-webkit-line-clamp: 2;/m);
  assert.match(css, /^\[data-topic-kind="hypothesis"\] \.vam-card-summary, \[data-topic-kind="atomic"\] \.vam-card-summary \{ -webkit-line-clamp: 2; \}/m);
  const long = 'A long claim that would stretch the diamond far past the card height '.repeat(4).trim();
  const f = heFixture({ notes: heNotes([['fact', { title: long, summary: long.toUpperCase() }], ['hyp', heHyp('weak')], ['other', {}]]) });
  f.view.stageEl = hePatch(dom.element('stage')); f.view.renderNode(f.view.map.nodes.find(n => n.id === 'fact'));
  const card = f.view.stageEl.children[0], has = name => dom.find(card, c => (c.cls ?? '').split(/\s+/).includes(name));
  assert.equal(has('vam-card-title').attrs.title, long); assert.equal(has('vam-card-summary').attrs.title, long.toUpperCase());
});
integrationTest('hypothesis-evidence: the polish rules start with a selector the share viewer does not collect, so its stylesheet carries none of them and keeps the plain .vam-edge and .vam-node rules (A1, A3, B1, B3)', async () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const { parseCss, extractViewerRules } = await import(require('node:url').pathToFileURL(path.join(root, 'scripts/viewer-css.mjs')).href);
  const mine = parseCss(css).filter(chunk => /data-parent-line|:where\(\[data-node-id\]\)|\.vam-hypothesis-tag/.test(chunk.prelude));
  assert.ok(mine.length >= 4, 'the polish rules exist');
  const viewer = extractViewerRules(css).map(item => item.text).join('\n');
  for (const chunk of mine) assert.equal(viewer.includes(chunk.text), false, `not in the viewer: ${chunk.prelude.slice(0, 60)}`);
  assert.doesNotMatch(viewer, /data-parent-line|:where\(|vam-hypothesis-tag|vam-relation/);
  assert.match(viewer, /^\.vam-edge \{ fill: none; stroke: var\(--interactive-accent\); stroke-width: 2; opacity: 1; \}$/m, 'the viewer still draws the accent edge');
  assert.match(viewer, /^\.vam-node \{[^}]*border: 1px solid var\(--background-modifier-border\); border-radius: 12px;/m, 'and the unchanged card frame');
});
integrationTest('hypothesis-evidence: relation labels are muted and medium weight with a canvas halo; semantic lines mix the text colour with the canvas; an ordinary card frame uses the hover border token, below status and selection rules (A2, A3, B3)', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const rule = selector => css.match(new RegExp(`^${selector.replace(/[.[\]"=_-]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm'))[1];
  assert.match(rule('.vam-relation-label'), /fill: var\(--text-muted\); font-weight: 500; stroke: var\(--background-primary\)/);
  for (const name of ['.vam-relation', '.vam-relation-arrow', '.vam-relation-arrow-bar']) assert.match(rule(name), /color-mix\(in srgb, var\(--text-normal\) 78%, var\(--background-primary\)\)/, name);
  assert.match(rule('.vam-relation.is-selected'), /stroke: var\(--interactive-accent\)/, 'a selected line stays accent');
  const base = css.indexOf(':where([data-node-id]).vam-node:where(:not([data-aim-kind])) {'), running = css.indexOf('.vam-node:not([data-aim-kind])[data-status="running"] {'), selected = css.indexOf('.vam-node.is-selected {');
  assert.ok(base > 0 && base < running && base < selected, 'the frame rule comes before the status and selection rules, which are at least as specific');
  assert.match(css.slice(base, base + 200), /border-color: color-mix\(in srgb, var\(--text-muted\) 45%, var\(--background-modifier-border-hover\)\)/, 'B3 border darkened after tester F1 (decision 36)');
});

// ---- hypothesis-evidence (P20, decision 35): the "This card" dialog ----
const heDialog = (options = {}, index = 1) => {
  const fixture = heFixture(options);
  const { view } = fixture;
  view.map.nodes.forEach(n => { n.parentId = null; });
  view.referenceSourcePaths = () => [];
  const content = dom.element('content'), host = dom.element('modal');
  view.enqueue = work => work();
  view.renderInspector(content, view.map.nodes[index], 'structure', () => {}, host);
  return { ...fixture, content, host, footer: dom.find(host, c => c.cls === 'vam-next-actions') };
};
const heCss = () => fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const heRuleBody = (css, selector) => { const hit = css.split('\n').find(line => line.startsWith(`${selector} {`)); assert.ok(hit, `rule ${selector}`); return hit.slice(hit.indexOf('{') + 1, hit.lastIndexOf('}')); };
integrationTest('hypothesis-evidence: the dialog reads type, strength (hypothesis only), relations, then the parent topic, with the same heading class on each (C1, C2)', () => {
  const hyp = heDialog({}, 1);
  const headings = f => dom.findAll(f.content, c => (c.cls ?? '').split(/\s+/).includes('vam-section-heading'));
  assert.deepEqual(headings(hyp).map(c => c.text), ['Topic type', 'Leaning', 'Strength', 'Relations', 'Markers', 'Links', 'Color', 'Style', 'Topic cover', 'Parent topic', 'AI lock'], 'ticket 41: the AI lock now sits after the folded Layout group; the marker section sits after the relations (ticket 33), the colour section after the markers (ticket 37), the style section after the colour (card-style), the cover switch after the style (decision 0.28-triage#36), the AI lock after the cover');
  const plain = heDialog({}, 0);
  assert.deepEqual(headings(plain).map(c => c.text), ['Topic type', 'Relations', 'Markers', 'Links', 'Color', 'Style', 'Topic cover', 'Parent topic', 'AI lock'], 'no strength for an ordinary topic');
  const order = dom.findAll(hyp.content, c => (c.cls ?? '').includes('vam-topic-kinds') || (c.cls ?? '').includes('vam-hypothesis-leanings') || (c.cls ?? '').includes('vam-hypothesis-strengths') || (c.cls ?? '') === 'vam-relation-list' || (c.cls ?? '') === 'vam-topic-tree' || (c.cls ?? '') === 'vam-hint').map(c => c.cls.split(' ')[0]);
  assert.deepEqual(order.slice(0, 5), ['vam-topic-kinds', 'vam-hypothesis-leanings', 'vam-hypothesis-strengths', 'vam-topic-tree', 'vam-hint'], 'type, leaning, strength, then the parent tree and its hint (the relations note is a different class)');
  const css = heCss();
  assert.match(heRuleBody(css, '.vam-topic-modal .vam-section-heading'), /margin: 16px 0 8px;[^}]*font-size: var\(--font-ui-small\); font-weight: 600;/);
});
integrationTest('card settings (ticket 41): the dialog is "This card" with the card name as subtitle; type, strength and relations come first; Appearance and Layout are folded with aria-expanded and keep every control', () => {
  const hyp = heDialog({}, 1);
  assert.equal(dom.find(hyp.content, c => c.tag === 'strong' && !(c.cls ?? '').includes('section-heading')).text, 'This card');
  assert.equal(dom.find(hyp.content, c => (c.cls ?? '').includes('vam-inspector-topic')).text, 'HYP', 'the subtitle is the card name');
  const toggles = dom.findAll(hyp.content, c => (c.cls ?? '').includes('vam-disclosure-toggle'));
  assert.deepEqual(toggles.map(b => b.text), ['Appearance', 'Layout']);
  const bodyOf = toggle => toggle.parent.children.find(c => (c.cls ?? '').includes('vam-disclosure-body'));
  for (const toggle of toggles) { assert.equal(toggle.attrs['aria-expanded'], 'false', 'folded at first'); assert.equal(bodyOf(toggle).hidden, true); assert.equal(toggle.attrs['aria-controls'], bodyOf(toggle).id); assert.equal(toggle.tag, 'button', 'a real button: Enter and Space work'); }
  const headingTexts = () => dom.findAll(hyp.content, c => (c.cls ?? '').split(/\s+/).includes('vam-section-heading')).map(c => c.text);
  const firstFold = hyp.content.children[0] && dom.findAll(hyp.content, () => true).indexOf(toggles[0]);
  const all = dom.findAll(hyp.content, () => true);
  for (const heading of ['Topic type', 'Strength', 'Relations']) assert.ok(all.indexOf(dom.find(hyp.content, c => c.text === heading)) < firstFold, `${heading} is before the folded groups`);
  for (const heading of ['Markers', 'Links', 'Color', 'Style', 'Topic cover']) assert.ok(dom.findAll(bodyOf(toggles[0]), c => c.text === heading).length, `${heading} is inside Appearance`);
  for (const heading of ['Parent topic']) assert.ok(dom.findAll(bodyOf(toggles[1]), c => c.text === heading).length, `${heading} is inside Layout`);
  assert.ok(headingTexts().includes('AI lock') && !dom.findAll(bodyOf(toggles[1]), c => c.text === 'AI lock').length, 'the AI lock is not folded');
  toggles[0].click(); assert.equal(toggles[0].attrs['aria-expanded'], 'true'); assert.equal(bodyOf(toggles[0]).hidden, false);
  toggles[0].click(); assert.equal(toggles[0].attrs['aria-expanded'], 'false'); assert.equal(bodyOf(toggles[0]).hidden, true);
  assert.equal(JSON.stringify(Object.values(toggles.map(t => t.text))).includes('Structure'), false);
  for (const lang of ['en', 'zh-TW', 'zh-CN']) assert.doesNotMatch(load('i18n.ts').translate(lang, 'ui.structure_and_links'), /Structure|結構|结构/, lang);
});
integrationTest('card settings (ticket 41): the AI lock row names the state it is in and the text follows a switch', async () => {
  const fx = heDialog({}, 0);
  fx.view.setAiLock = async (nodes, locked) => { fx.view.notes.get(nodes[0].id).aiLocked = locked ? true : undefined; };
  const panel = dom.element('panel'); fx.view.renderAiLockSection(panel, fx.view.map.nodes[0]);
  const state = () => dom.find(panel, c => (c.cls ?? '').includes('vam-ai-lock-state')).text;
  assert.equal(state(), 'Off: AI can change this card');
  dom.button(panel, 'Lock from AI').click(); await dom.tick();
  assert.equal(state(), 'On: AI will not change this card');
  dom.findAll(panel, c => c.tag === 'button')[0].click(); await dom.tick();
  assert.equal(state(), 'Off: AI can change this card');
  assert.equal(load('i18n.ts').translate('zh-TW', 'ui.ai_lock_state_off'), '關閉：AI 可以修改這張卡');
});
integrationTest('hypothesis-evidence: "Add subtopic…" sits in the footer left of "Remove from map", ahead of the status and "Close"; the body no longer has it (C3, decision 40)', () => {
  const { footer, content, menus } = heDialog({}, 1);
  const buttons = footer.children.filter(c => c.tag === 'button');
  assert.deepEqual(buttons.map(b => b.text), ['Add subtopic…', 'Remove from map', 'Close']);
  assert.ok(buttons[0].cls.includes('vam-add-subtopic'));
  assert.equal(dom.buttons(content).includes('Add subtopic…'), false);
  buttons[0].click(); assert.deepEqual(menus.at(-1).titles, heKindNames, 'it still opens the six-type menu');
  const css = heCss(), order = selector => Number(heRuleBody(css, selector).match(/order: (-?\d)/)[1]);
  assert.ok(order('.vam-next-actions > .vam-add-subtopic') < order('.vam-next-actions > .vam-discard'), 'the CSS order puts it before Remove');
  const aim = heDialog({ aim: true }, 1);
  assert.deepEqual(aim.footer.children.filter(c => c.tag === 'button').map(b => b.text), ['Remove from map', 'Close'], 'an AIM map has no add-subtopic entry');
});
integrationTest('hypothesis-evidence: the type and strength options are quiet segmented buttons: no mod-cta, aria-pressed on the current one, a swatch of the type shape on each type, three columns (C4, C5)', () => {
  const { content } = heDialog({}, 1);
  const group = dom.find(content, c => (c.cls ?? '').includes('vam-topic-kinds')), strengths = dom.find(content, c => (c.cls ?? '').includes('vam-hypothesis-strengths'));
  for (const g of [group, strengths]) {
    assert.equal(g.attrs.role, 'group'); assert.ok(g.attrs['aria-label']);
    const buttons = dom.findAll(g, c => c.tag === 'button');
    assert.ok(buttons.every(b => !b.cls.includes('mod-cta')), 'no solid CTA purple');
    assert.equal(buttons.filter(b => b.attrs['aria-pressed'] === 'true').length, 1);
    assert.ok(buttons.filter(b => b.attrs['aria-pressed'] === 'true')[0].cls.includes('is-pressed'));
  }
  const kindButtons = dom.findAll(group, c => c.tag === 'button');
  assert.deepEqual(kindButtons.map(b => b.text), heDialogKindNames, 'order of spec section 2: topic, atomic, hypothesis, evidence, conclusion, action');
  assert.deepEqual(kindButtons.map(b => dom.find(b, c => (c.cls ?? '').includes('vam-type-swatch')).dataset.kind), heDialogKindIds);
  const shapeOf = kind => { const sw = dom.find(kindButtons[heDialogKindIds.indexOf(kind)], c => (c.cls ?? '').includes('vam-type-swatch')); assert.equal(sw.attrs['aria-hidden'], 'true'); return sw.children[0].children[0]; };
  assert.equal(shapeOf('atomic').tag, 'ellipse'); assert.equal(shapeOf('hypothesis').tag, 'polygon'); assert.equal(shapeOf('evidence').tag, 'polygon'); assert.equal(shapeOf('conclusion').tag, 'polygon'); assert.equal(shapeOf('topic').tag, 'rect'); assert.equal(shapeOf('action').tag, 'rect');
  const css = heCss();
  assert.match(heRuleBody(css, '.vam-topic-modal .vam-choice-group'), /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(heRuleBody(css, '.vam-topic-modal .vam-choice-group.is-segmented'), /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(heRuleBody(css, '.vam-topic-modal .vam-choice-group.is-multi'), /grid-template-columns: repeat\(auto-fill, minmax\(8\.5em, 1fr\)\)/);
  assert.match(heRuleBody(css, '.vam-topic-modal .vam-choice-group.is-segmented button[data-marker^="progress-"] > .vam-marker'), /font-size: 16px/);
  const pressed = heRuleBody(css, '.vam-topic-modal .vam-choice-group button[aria-pressed="true"], .vam-topic-modal .vam-choice-group button[aria-pressed="true"]:hover');
  assert.match(pressed, /box-shadow: inset 0 0 0 1px var\(--interactive-accent\)/); assert.match(pressed, /color: var\(--text-normal\)/); assert.doesNotMatch(pressed, /text-on-accent/);
});
integrationTest('hypothesis-evidence: relation rows read "A relation B" with this topic named, show the line sample, a muted note line and two icon buttons that keep the old labels; none shows a muted line (C6)', async () => {
  const relations = [{ kind: 'supports', from: 'fact', to: 'hyp', description: 'measured twice' }, { kind: 'derives_from', from: 'other', to: 'fact' }, { kind: 'related', from: 'extra', to: 'fact' }, { kind: 'contradicts', from: 'fact', to: 'more' }];
  const { view } = heFixture({ relations, topics: [node('fact'), node('hyp'), node('other'), node('extra'), node('more')], notes: heNotes([['fact', {}], ['hyp', heHyp('weak')], ['other', {}], ['extra', {}], ['more', {}]]) }); // decision #37: one relation per pair
  view.enqueue = work => work();
  const panel = dom.element('panel'); view.renderHypothesisSection(panel, view.map.nodes[0]);
  const rows = dom.findAll(panel, c => c.tag === 'li');
  assert.deepEqual(rows.map(r => dom.find(r, c => (c.cls ?? '').includes('vam-relation-sentence')).text), ['This topic supports HYP', 'OTHER is derived from this topic', 'This topic is related to EXTRA', 'This topic contradicts MORE']);
  const more = heFixture({ relations: [{ kind: 'verifies', from: 'hyp', to: 'fact' }, { kind: 'prerequisite', from: 'fact', to: 'other' }, { kind: 'prerequisite', from: 'extra', to: 'fact' }, { kind: 'derives_from', from: 'fact', to: 'more' }], topics: [node('fact'), node('hyp'), node('other'), node('extra'), node('more')], notes: heNotes([['fact', {}], ['hyp', heHyp('weak')], ['other', {}], ['extra', {}], ['more', {}]]) });
  const morePanel = dom.element('panel'); more.view.renderHypothesisSection(morePanel, more.view.map.nodes[0]);
  assert.deepEqual(dom.findAll(morePanel, c => (c.cls ?? '').includes('vam-relation-sentence')).map(c => c.text), ['HYP verifies this topic', 'This topic is a prerequisite for OTHER', 'EXTRA is a prerequisite for this topic', 'This topic is derived from MORE'], 'one sentence per kind, A = from, B = to');
  const zh = load('i18n.ts').translate;
  assert.deepEqual([['derives_from', 'A', 'B', 'A 由 B 推導而來'], ['prerequisite', 'A', 'B', 'A 是 B 的前置知識'], ['supports', 'A', 'B', 'A 支持 B'], ['contradicts', 'A', 'B', 'A 反駁 B'], ['verifies', 'A', 'B', 'A 驗證 B']].map(([k, a, b]) => zh('zh-TW', `ui.relation_sentence_${k}_0_1`, a, b)), ['A 由 B 推導而來', 'A 是 B 的前置知識', 'A 支持 B', 'A 反駁 B', 'A 驗證 B']);
  assert.equal(zh('zh-CN', 'ui.relation_sentence_prerequisite_0_1', 'A', 'B'), 'A 是 B 的前置知识'); assert.equal(zh('zh-CN', 'ui.relation_sentence_derives_from_0_1', 'A', 'B'), 'A 由 B 推导而来');
  assert.equal(dom.find(rows[0], c => (c.cls ?? '').includes('vam-relation-description-text')).text, 'measured twice', 'the note is its own line');
  assert.equal(dom.find(rows[1], c => (c.cls ?? '').includes('vam-relation-description-text')), undefined);
  const swatch = row => row.children.find(c => (c.classes ?? []).includes('vam-relation-swatch'));
  const lines = row => swatch(row).children.filter(c => c.tag === 'path');
  assert.ok(lines(rows[0])[0].classes.includes('vam-relation') && lines(rows[0])[0].classes.includes('vam-relation-supports'));
  assert.ok(lines(rows[0])[0].attrs['marker-end'].startsWith('url(#')); assert.equal(lines(rows[2])[0].attrs['marker-end'], undefined, 'related has no arrow');
  assert.deepEqual(lines(rows[1]).map(l => l.classes.includes('vam-relation-gap')), [false, true], 'a derives-from sample is two rails');
  const marker = row => swatch(row).children.find(c => c.tag === 'defs').children[0];
  assert.equal(marker(rows[3]).children.length, 2, 'contradicts keeps the barred arrowhead'); assert.equal(marker(rows[0]).children.length, 1);
  assert.notEqual(marker(rows[0]).attrs.id, marker(rows[1]).attrs.id, 'every sample has its own marker id');
  assert.equal(lines(rows[0])[0].attrs['marker-end'], `url(#${marker(rows[0]).attrs.id})`);
  const tools = dom.findAll(rows[0], c => c.tag === 'button');
  assert.deepEqual(tools.map(b => b.dataset.icon), ['pencil', 'trash-2']); assert.deepEqual(tools.map(b => b.attrs['aria-label']), ['Edit relation: Supports → HYP', 'Remove relation: Supports → HYP']);
  assert.ok(tools.every(b => b.cls.includes('clickable-icon')));
  // Tester F3 (decision 38): after a change the panel is repainted, so closing the editor focuses the new row's edit button, or "Add relation…" once the relation is gone.
  {
    const fx = heFixture({ relations: [{ kind: 'supports', from: 'fact', to: 'hyp' }] }); const opened = []; fx.view.openRelationEditor = (link, onChanged, onClosed) => opened.push({ link, onChanged, onClosed });
    const p = dom.element('panel'); fx.view.renderHypothesisSection(p, fx.view.map.nodes.find(n => n.id === 'fact'));
    const focusedOf = root => { const all = dom.findAll(root, c => c.tag === 'button'); return all.filter(b => b.focused || b.focusCount); };
    dom.find(p, c => c.dataset?.icon === 'pencil').click(); assert.equal(typeof opened[0].onClosed, 'function', 'the row passes a focus-return callback');
    opened[0].onChanged(); const fresh = dom.find(p, c => c.dataset?.icon === 'pencil'); let focused = null; fresh.focus = () => { focused = 'edit'; };
    opened[0].onClosed(); assert.equal(focused, 'edit', 'focus lands on the repainted edit button of the same pair');
    fx.view.map.topicRelations = []; opened[0].onChanged(); const add = heKindSelect(p); let addFocused = false; add.focus = () => { addFocused = true; };
    opened[0].onClosed(); assert.ok(addFocused, 'with the relation deleted, focus lands on the add-relation sentence'); void focusedOf;
  }
  assert.equal(rows[0].attrs['aria-label'], 'Supports → HYP. measured twice', 'the row name is unchanged');
  const none = heFixture(); const emptyPanel = dom.element('panel'); none.view.renderHypothesisSection(emptyPanel, none.view.map.nodes[0]);
  assert.ok(dom.texts(emptyPanel).includes('No relations yet')); assert.equal(dom.findAll(emptyPanel, c => c.tag === 'li').length, 0);
  const css = heCss();
  assert.doesNotMatch(heRuleBody(css, '.vam-relation-row'), /space-between/); assert.match(heRuleBody(css, '.vam-relation-row'), /border-top: 1px solid var\(--background-modifier-border\)/);
  assert.match(heRuleBody(css, '.vam-relation-swatch'), /width: 32px; height: 10px/); assert.match(heRuleBody(css, '.vam-relation-tools .clickable-icon'), /width: 28px; height: 28px/);
  assert.match(heRuleBody(css, '.vam-relation-description-text'), /color: var\(--text-muted\)/);
});
integrationTest('hypothesis-evidence: removing a relation or adding one still repaints, and the focus goes back to the add-relation sentence after adding (keyboard flow, C6)', async () => {
  const { view } = heFixture({ relations: [{ kind: 'supports', from: 'fact', to: 'hyp' }] });
  view.enqueue = work => work(); view.mapChange = async change => { change(view.map); };
  const panel = dom.element('panel'); view.renderHypothesisSection(panel, view.map.nodes[0]);
  await heAddRelation(panel, 'related', 'other');
  assert.equal(heKindSelect(panel).focused, true, 'focus returns to the add-relation sentence');
  dom.byLabel(panel, 'Remove relation: Supports → HYP').click(); await dom.tick();
  assert.equal(dom.byLabel(panel, 'Remove relation: Supports → HYP'), undefined);
});
integrationTest('hypothesis-evidence: parent-tree rows have a transparent fill, including disabled ones (text-faint), matched above Obsidian button styles without !important, and the tree is capped at min(240px, 40vh) (C7)', () => {
  const css = heCss();
  const base = '.vam-topic-modal .vam-topic-tree button.vam-topic-tree-row';
  assert.match(heRuleBody(css, base), /background: transparent/);
  const disabled = heRuleBody(css, `${base}:disabled`);
  assert.match(disabled, /background: transparent/); assert.match(disabled, /color: var\(--text-faint\)/); assert.match(disabled, /opacity: 1/);
  assert.match(heRuleBody(css, '.vam-topic-modal .vam-topic-tree'), /max-height: min\(240px, 40vh\)/);
  assert.doesNotMatch(css.split('\n').filter(l => l.includes('.vam-topic-modal')).join('\n'), /!important/);
  assert.equal(base.split('.').length - 1, 3, 'three classes and an element (0,3,1): more specific than Obsidian button:not(.clickable-icon):hover (0,2,1)');
  assert.equal(fs.readFileSync(path.join(root, 'ui/topic-tree.ts'), 'utf8').includes('!important'), false);
});
integrationTest('hypothesis-evidence: every P20 dialog rule is invisible to the share viewer: its stylesheet is the same with them removed (decision 35)', async () => {
  const css = heCss();
  const { parseCss, extractViewerRules } = await import(require('node:url').pathToFileURL(path.join(root, 'scripts/viewer-css.mjs')).href);
  const mine = /vam-topic-modal|vam-section-heading|vam-add-subtopic|vam-choice-group|vam-type-swatch|vam-relation-(?:row|list|swatch|title|tools|description-text|empty)/;
  const own = parseCss(css).filter(chunk => mine.test(chunk.prelude));
  assert.ok(own.length >= 18, `the dialog rules exist (${own.length})`);
  const viewer = extractViewerRules(css).map(item => item.text).join('\n');
  for (const chunk of own) assert.equal(viewer.includes(chunk.text), false, `not in the viewer: ${chunk.prelude.slice(0, 60)}`);
  const without = parseCss(css).filter(chunk => !mine.test(chunk.prelude)).map(chunk => chunk.text).join('\n');
  assert.equal(extractViewerRules(without).map(item => item.text).join('\n'), viewer, 'byte-identical viewer rules');
  assert.doesNotMatch(viewer, /vam-topic-modal|vam-type-swatch|vam-relation-swatch|vam-section-heading/);
});
// ---- hypothesis-evidence (V1.7 P23): merge notice for relations dropped on the same pair (decision #37) ----
const heMergeNotices = (relations, mergeIds, target) => {
  const fx = heFixture({ topics: [node('f1'), node('f2'), node('x'), node('hyp')], relations });
  const result = core.retargetTopicRelations(fx.doc, mergeIds, target);
  fx.view.takeRetargetDrops(result);
  fx.view.noticeDroppedCycles();
  return { ...fx, result };
};
integrationTest('hypothesis-evidence: a merge that drops same-pair relations shows the count in a Notice, alone and next to the cycle notice (decision #37)', () => {
  const same = heMergeNotices([{ kind: 'supports', from: 'f1', to: 'x' }, { kind: 'related', from: 'f2', to: 'x' }, { kind: 'contradicts', from: 'x', to: 'hyp' }], ['f1', 'f2'], 'f1');
  assert.deepEqual(plain(same.result), { droppedCycles: 0, droppedSamePair: 1 });
  assert.equal(same.view.droppedSamePairOfLastMerge(), 1);
  assert.deepEqual(same.notices, ['Removed 1 duplicate relation(s) (only one relation is kept for each pair of topics)'], 'the same-pair sentence alone');
  const two = heMergeNotices([{ kind: 'supports', from: 'f1', to: 'x' }, { kind: 'supports', from: 'f2', to: 'x' }, { kind: 'related', from: 'x', to: 'f1' }, { kind: 'verifies', from: 'f2', to: 'hyp' }], ['f1', 'f2'], 'f1');
  assert.equal(two.view.droppedSamePairOfLastMerge(), 2);
  assert.deepEqual(two.notices, ['Removed 2 duplicate relation(s) (only one relation is kept for each pair of topics)']);
  const both = heMergeNotices([{ kind: 'prerequisite', from: 'f1', to: 'x' }, { kind: 'prerequisite', from: 'x', to: 'hyp' }, { kind: 'prerequisite', from: 'hyp', to: 'f2' }, { kind: 'supports', from: 'f1', to: 'hyp' }], ['f1', 'f2'], 'f1');
  assert.deepEqual(plain(both.result), { droppedCycles: 1, droppedSamePair: 1 });
  assert.deepEqual(both.notices, ['Removed 1 duplicate relation(s) (only one relation is kept for each pair of topics)', 'Removed 1 derives-from or prerequisite link(s) that would form a cycle'], 'both sentences show when both happened');
  const cycleOnly = heMergeNotices([{ kind: 'prerequisite', from: 'f1', to: 'x' }, { kind: 'prerequisite', from: 'x', to: 'hyp' }, { kind: 'prerequisite', from: 'hyp', to: 'f2' }], ['f1', 'f2'], 'f1');
  assert.deepEqual(cycleOnly.notices, ['Removed 1 derives-from or prerequisite link(s) that would form a cycle'], 'the cycle notice alone is unchanged');
  const none = heMergeNotices([{ kind: 'supports', from: 'f1', to: 'x' }], ['f1', 'f2'], 'f1');
  assert.deepEqual(none.notices, [], 'nothing dropped: no Notice');
});
integrationTest('hypothesis-evidence: every merge path hands the retarget result to the notice, and the same-pair sentence exists in all three languages (decision #37)', () => {
  const view = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.equal((view.match(/this\.takeRetargetDrops\(retargetRelationsToTopic\(/g) ?? []).length, 3, 'merge, merge into a target and remove-with-adopter all record both counts');
  assert.doesNotMatch(view, /lastDroppedCycles = retargetTopicRelations/);
  const texts = { en: 'Removed {0} duplicate relation(s) (only one relation is kept for each pair of topics)', 'zh-TW': '已移除 {0} 條重複的關係（同一對議題只保留一條）', 'zh-CN': '已移除 {0} 条重复的关系（同一对议题只保留一条）' };
  for (const [lang, text] of Object.entries(texts)) assert.equal(load('i18n.ts').translate(lang, 'ui.merge_dropped_same_pair_0', '3'), text.replace('{0}', '3'), lang);
});
// ---- topic markers (ticket 33, P2b) ----
const tmRender = (options, id) => {
  const f = heFixture(options); f.view.stageEl = hePatch(dom.element('stage')); f.view.renderNode(f.view.map.nodes.find(n => n.id === id));
  const card = f.view.stageEl.children[0];
  return { card, label: dom.find(card, c => (c.cls ?? '').split(/\s+/).includes('vam-card-label')), marks: dom.findAll(card, c => (c.cls ?? '').split(/\s+/).includes('vam-marker')) };
};
integrationTest('topic-markers: a card shows whitelisted markers as aria-hidden symbols in a fixed order and names them in its accessible name; a topic without any shows none', () => {
  const notes = heNotes([['fact', { markers: ['star', 'done', 'priority-2'] }], ['hyp', heHyp('weak')], ['other', {}]]);
  const shown = tmRender({ notes }, 'fact');
  assert.deepEqual(shown.marks.map(m => m.text), ['✓', '★', 'P2'], 'whitelist order, plain Unicode');
  const row = dom.find(shown.card, c => (c.cls ?? '').split(/\s+/).includes('vam-card-markers'));
  assert.equal(row.attrs['aria-hidden'], 'true');
  assert.match(shown.label.text, /Markers: Done, Star, Priority 2/); assert.match(shown.label.text, /^FACT, /);
  assert.equal(shown.card.attrs['aria-labelledby'], shown.label.id);
  const kindToo = tmRender({ notes: heNotes([['fact', { topicKind: 'evidence', markers: ['done'] }], ['hyp', {}], ['other', {}]]) }, 'fact');
  assert.match(kindToo.label.text, /Evidence/); assert.match(kindToo.label.text, /Markers: Done/);
  const none = tmRender({ notes }, 'other');
  assert.deepEqual(none.marks, []); assert.doesNotMatch(none.label.text, /Markers/);
  const aim = tmRender({ aim: true, notes }, 'fact');
  assert.equal(aim.marks.length, 3, 'a read-only map still shows the markers');
});
integrationTest('topic-markers: a value outside the whitelist is not shown, not drawn and not read out', () => {
  const notes = heNotes([['fact', { markers: ['<img src=x onerror=alert(1)>', 'DONE', 3, 'star', 'star'] }], ['hyp', {}], ['other', {}]]);
  const shown = tmRender({ notes }, 'fact');
  assert.deepEqual(shown.marks.map(m => m.text), ['★']);
  assert.doesNotMatch(shown.label.text, /img|onerror|DONE|3/); assert.match(shown.label.text, /Markers: Star$/);
});
integrationTest('topic-markers: refreshing a card replaces its symbols and its name part (no duplicates)', () => {
  const f = heFixture({ notes: heNotes([['fact', { markers: ['done'] }], ['hyp', {}], ['other', {}]]) });
  f.view.stageEl = hePatch(dom.element('stage')); f.view.cardEls = new Map(); f.view.renderNode(f.view.map.nodes[0]);
  const node = f.view.map.nodes[0], card = f.view.stageEl.children[0];
  f.view.stageEl.querySelector = sel => card;
  f.view.drawEdges = () => {};
  f.view.notes.get('fact').markers = ['warning', 'priority-3'];
  f.view.refreshCard(node, false);
  assert.deepEqual(dom.findAll(card, c => (c.cls ?? '').split(/\s+/).includes('vam-marker')).map(m => m.text), ['⚠', 'P3']);
  const label = dom.find(card, c => (c.cls ?? '').split(/\s+/).includes('vam-card-label'));
  assert.match(label.text, /Markers: Warning, Priority 3/); assert.doesNotMatch(label.text, /Done/); assert.equal((label.text.match(/Markers/g) ?? []).length, 1);
  f.view.notes.get('fact').markers = [];
  f.view.refreshCard(node, false);
  assert.doesNotMatch(label.text, /Markers/);
});
integrationTest('status pill: an AIM idea card has the same pill after a full render and after refreshCard; a plain idea card has none after either', () => {
  for (const [aimKind, expected] of [['research', ['Not started']], [undefined, []]]) {
    const f = heFixture({ notes: heNotes([['fact', { status: 'idea' }], ['hyp', {}], ['other', {}]]), aim: !!aimKind });
    if (aimKind) f.view.map.nodes[0].aimKind = aimKind;
    f.view.stageEl = hePatch(dom.element('stage')); f.view.cardEls = new Map(); f.view.renderNode(f.view.map.nodes[0]);
    const node = f.view.map.nodes[0], card = f.view.stageEl.children[0];
    f.view.stageEl.querySelector = () => card; f.view.drawEdges = () => {};
    const header = dom.find(card, c => (c.cls ?? '').split(/\s+/).includes('vam-node-header'));
    const pills = () => header.children.filter(c => (c.cls ?? '').split(/\s+/).includes('vam-status')).map(c => c.text);
    const plainQuery = card.querySelector.bind(card);
    card.querySelector = sel => (sel.includes('> .vam-status') ? header.children.find(c => (c.cls ?? '').split(/\s+/).includes('vam-status') && !(c.cls ?? '').includes('vam-aim-question-status')) ?? null : plainQuery(sel));
    const rendered = pills();
    f.view.refreshCard(node, false);
    assert.deepEqual(pills(), rendered, `${aimKind ?? 'plain'}: refreshCard agrees with the full render`);
    assert.equal(rendered.length, expected.length, `${aimKind ?? 'plain'} idea card pill count`);
  }
});
integrationTest('topic-markers: refreshCard keeps the marker row where it was (after the type tag), and the row carries the tag style', () => {
  const f = heFixture({ notes: heNotes([['fact', { topicKind: 'evidence', markers: ['done'] }], ['hyp', {}], ['other', {}]]) });
  f.view.stageEl = hePatch(dom.element('stage')); f.view.cardEls = new Map(); f.view.renderNode(f.view.map.nodes[0]);
  const node = f.view.map.nodes[0], card = f.view.stageEl.children[0];
  f.view.stageEl.querySelector = () => card; f.view.drawEdges = () => {};
  const header = dom.find(card, c => (c.cls ?? '').split(/\s+/).includes('vam-node-header'));
  const order = () => header.children.map(c => (c.cls ?? '').split(/\s+/).find(n => ['vam-card-markers', 'vam-kind-tag', 'vam-status'].includes(n)) ?? c.cls);
  // The stand-in cannot match ":not(...)"; find the card's own status pill the way the real selector does.
  const plainQuery = card.querySelector.bind(card);
  card.querySelector = sel => (sel.includes('> .vam-status') ? header.children.find(c => (c.cls ?? '').split(/\s+/).includes('vam-status') && !(c.cls ?? '').includes('vam-aim-question-status')) ?? null : plainQuery(sel));
  const before = order(), at = before.indexOf('vam-card-markers');
  assert.ok(at > before.indexOf('vam-kind-tag') && before.indexOf('vam-kind-tag') >= 0, 'first draw: after the type tag');
  assert.match(header.children[at].cls, /vam-hypothesis-tag/);
  f.view.notes.get('fact').markers = ['star'];
  f.view.refreshCard(node, false);
  assert.deepEqual(order(), before, 'same position after a redraw');
  f.view.notes.get('fact').markers = [];
  f.view.refreshCard(node, false);
  assert.ok(!order().includes('vam-card-markers'));
  f.view.notes.get('fact').markers = ['done'];
  f.view.refreshCard(node, false);
  assert.ok(order().indexOf('vam-card-markers') > order().indexOf('vam-kind-tag'), 'a row added later goes after the type tag');
});
integrationTest('topic-markers, topic-color and topic-style: an AIM map and select mode have no marker, colour or style menu and refuse a change', async () => {
  const sections = [
    ['markers', (view, panel, n) => view.renderMarkerSection(panel, n), (view, n) => view.changeTopicMarker(n, 'done')],
    ['color', (view, panel, n) => view.renderColorSection(panel, n), (view, n) => view.changeTopicColor(n, 'red', true)],
    ['style', (view, panel, n) => view.renderStyleSection(panel, n), (view, n) => view.changeTopicStyle(n, ['bold'], true)],
  ];
  for (const [name, render, change] of sections) for (const options of [{ aim: true }, { integration: true }]) {
    const { view, writes } = heFixture(options);
    if (options.integration) view.selection.toggleMultiSelect();
    const panel = dom.element('panel'); render(view, panel, view.map.nodes[2]);
    assert.deepEqual(dom.buttons(panel), [], `${name} panel ${JSON.stringify(options)}`);
    view.beginMapTransaction = () => assert.fail('no transaction');
    await change(view, view.map.nodes[2]);
    assert.deepEqual(writes, [], `${name} ${JSON.stringify(options)}`);
  }
});
integrationTest('topic-markers: the panel has one aria-pressed toggle per marker and priority is one of three', async () => {
  const { view } = heFixture();
  view.enqueue = work => work();
  const tx = { rewriteNote(p, write) { tx.write = write; tx.path = p; return tx; }, editMap() { return tx; }, async commit() { await tx.write(tx.path); return { undo() {}, redo() {} }; } };
  view.beginMapTransaction = () => tx; view.history = { push() {} };
  const toggled = [];
  view.plugin.repo.writeTopicMarkers = async (path, id) => {
    toggled.push(id); const note = view.notes.get(path.replace('.md', '')); const cur = note.markers ?? [];
    note.markers = load('topic-markers.ts', { obsidian }).toggleTopicMarker(cur, id) ?? [];
  };
  view.refreshAfterSavedChange = async () => {};
  const panel = dom.element('panel'); view.renderMarkerSection(panel, view.map.nodes[0]);
  const group = () => dom.find(panel, c => (c.cls ?? '').includes('vam-topic-markers'));
  assert.equal(group().attrs.role, 'group'); assert.equal(group().attrs['aria-label'], 'Markers');
  // Priority and progress buttons are symbol-only; their name is the aria-label.
  const name = c => c.attrs['aria-label'] ?? c.text;
  const pressed = () => dom.findAll(group(), c => c.tag === 'button' && c.attrs['aria-pressed'] === 'true').map(name);
  const { TOPIC_MARKERS, TOPIC_MARKER_GROUPS } = load('topic-markers.ts', { obsidian });
  assert.equal(dom.findAll(group(), c => c.tag === 'button').length, TOPIC_MARKERS.length);
  const sub = dom.findAll(group(), c => (c.cls ?? '').includes('vam-topic-marker-group') && c.attrs.role === 'group');
  assert.equal(sub.length, TOPIC_MARKER_GROUPS.length);
  sub.forEach((box, i) => assert.equal(dom.findAll(box, c => c.tag === 'button').length, TOPIC_MARKER_GROUPS[i].ids.length));
  assert.deepEqual(pressed(), []);
  const click = name => dom.findAll(group(), c => c.tag === 'button').find(c => (c.attrs['aria-label'] ?? c.text).includes(name)).click();
  click('Done'); await dom.tick(); click('Priority 1'); await dom.tick(); click('Priority 3'); await dom.tick();
  assert.deepEqual(toggled, ['done', 'priority-1', 'priority-3']);
  assert.equal(pressed().length, 2); assert.ok(pressed().some(t => t.includes('Priority 3')) && !pressed().some(t => t.includes('Priority 1')));
  click('Done'); await dom.tick();
  assert.equal(pressed().length, 1);
  click('Progress 25%'); await dom.tick(); click('Progress 50%'); await dom.tick(); click('Red flag'); await dom.tick(); click('Blue flag'); await dom.tick();
  assert.deepEqual(pressed().map(t => t.replace(/^.*?(Progress|Priority|Red|Blue)/, '$1')).sort(), ['Blue flag', 'Priority 3', 'Progress 50%', 'Red flag'].map(t => t).sort().map(t => t), 'progress is single choice, flags can coexist');
  assert.ok(sub.every(box => box.attrs['aria-label']), 'every section is a labelled group');
  sub.forEach((box, i) => {
    const single = TOPIC_MARKER_GROUPS[i].single;
    assert.equal((box.cls ?? '').includes('is-segmented'), !!single, 'only one-of groups are segmented');
    for (const b of dom.findAll(box, c => c.tag === 'button')) {
      if (single) assert.ok(b.text === '' && b.attrs['aria-label'] && b.attrs.title === b.attrs['aria-label'], 'symbol-only segment named by aria-label and title');
      else assert.ok(b.text && b.attrs['aria-label'] === undefined, 'many-of buttons keep their text');
      assert.ok(['true', 'false'].includes(b.attrs['aria-pressed']), 'aria-pressed stays on every button');
      // The stylesheet's progress size rule is `button[data-marker^="progress-"] > .vam-marker`: the attribute is on the button, the symbol is its child.
      assert.ok(b.dataset.marker, 'the marker id is on the button');
      assert.ok(b.children.some(c => (c.cls ?? '').includes('vam-marker')), 'the symbol span is a direct child');
    }
  });
  assert.equal(sub.filter(box => /choose one/.test(box.attrs['aria-label'])).length, TOPIC_MARKER_GROUPS.filter(g => g.single).length);
});
integrationTest('topic-markers: a toggle is one transaction; one undo restores the note, redo reapplies it, and the other keys stay put', async () => {
  const { fixture, DEFAULT_SETTINGS: settings } = require('../support.cjs');
  const { begin } = load('experiences/visual-map/map-transaction.ts', { obsidian });
  const { repo, contents } = fixture('en', { linkIndex: true });
  repo.settings = { ...settings, language: 'en' };
  const MAP = 'Agent Workspace/Topics/map-m/Map.md';
  const doc = { id: 'map-m', title: 'm', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-m');
  await repo.app.vault.create(MAP, core.serializeMap(doc));
  const topic = await repo.createNote('Topic', 'gpt-6-luna', doc, MAP, 'workspace');
  doc.nodes.push(topic); await repo.saveMap(MAP, doc);
  const { view } = heFixture({ topics: [topic] });
  const deps = { repo, rebuildDerivedData: async () => {}, onApplied() {}, checkConflict: async () => {} };
  view.path = MAP; view.plugin.repo = repo; view.map = await repo.readMap(MAP); view.notes = new Map();
  view.beginMapTransaction = () => begin(deps);
  view.refreshAfterSavedChange = async () => { view.map = await repo.readMap(MAP); for (const n of view.map.nodes) view.notes.set(n.id, await repo.readNote(n.path, view.map)); };
  const pushed = []; view.history = { push: entry => pushed.push(entry) };
  await view.refreshAfterSavedChange();
  const text = () => contents.get(topic.path).match(/topic-markers:.*(\n\s+- .*)*/g)?.join('').replace(/"/g, '') ?? null;
  const before = contents.get(topic.path);
  await view.changeTopicMarker(view.map.nodes[0], 'star');
  assert.equal(pushed.length, 1, 'one history entry per toggle'); assert.ok(text()); assert.deepEqual(plain(view.notes.get(view.map.nodes[0].id).markers), ['star']);
  await pushed[0].undo();
  assert.equal(contents.get(topic.path), before, 'one undo gives back the exact note text'); assert.equal(text(), null);
  await pushed[0].redo(); assert.ok(text());
  await pushed[0].undo();
  await view.refreshAfterSavedChange();
  await view.changeTopicMarker(view.map.nodes[0], 'priority-1');
  await view.changeTopicMarker(view.map.nodes[0], 'priority-2');
  await view.changeTopicMarker(view.map.nodes[0], 'progress-25'); const mid = contents.get(topic.path);
  await view.changeTopicMarker(view.map.nodes[0], 'progress-50');
  assert.deepEqual(plain(view.notes.get(view.map.nodes[0].id).markers), ['priority-2', 'progress-50']);
  await pushed.at(-1).undo(); assert.equal(contents.get(topic.path), mid, 'one undo of a same-group switch restores the previous choice');
  await pushed.at(-1).redo(); await view.refreshAfterSavedChange();
  await pushed.at(-1).undo(); await pushed.at(-2).undo(); await view.refreshAfterSavedChange();
  assert.equal(pushed.length, 5); assert.deepEqual(plain(view.notes.get(view.map.nodes[0].id).markers), ['priority-2']);
});
// ---- topic colour (ticket 37, P2b) ----
const tcLabel = card => dom.find(card, c => (c.cls ?? '').split(/\s+/).includes('vam-card-label'));
integrationTest('topic-color: a card carries data-topic-color and "Color: Red" in its accessible name; no colour, a hostile value and an AIM card add nothing', () => {
  const notes = heNotes([['fact', { color: 'red' }], ['hyp', { color: 'red; background:url(x)' }], ['other', {}]]);
  const red = tmRender({ notes }, 'fact');
  assert.equal(red.card.dataset.topicColor, 'red'); assert.match(tcLabel(red.card).text, /^FACT, Researched, Color: Red$/); assert.equal(red.card.attrs['aria-labelledby'], tcLabel(red.card).id);
  for (const id of ['hyp', 'other']) {
    const shown = tmRender({ notes }, id);
    assert.equal('topicColor' in shown.card.dataset, false, id); assert.doesNotMatch(tcLabel(shown.card).text, /Color/, id);
    assert.match(tcLabel(shown.card).text, new RegExp('^' + id.toUpperCase() + ', Researched'), 'a card without a valid colour keeps its old name'); assert.equal((tcLabel(shown.card).text.match(/,/g) ?? []).length, 1, id);
  }
  const aim = tmRender({ aim: true, topics: [{ ...node('fact'), aimKind: 'research' }], notes }, 'fact');
  assert.equal('topicColor' in aim.card.dataset, false, 'an AIM card has its own look and shows no topic colour'); assert.doesNotMatch(tcLabel(aim.card).text, /Color/);
});
integrationTest('topic-color: the colour name sits with the marker and model parts without duplicating or disturbing them, on first draw and after every refresh', () => {
  const f = heFixture({ notes: heNotes([['fact', { markers: ['done'], color: 'blue' }], ['hyp', {}], ['other', {}]]) });
  f.view.plugin.modelLabel = model => `M:${model}`;
  f.view.stageEl = hePatch(dom.element('stage')); f.view.cardEls = new Map(); f.view.renderNode(f.view.map.nodes[0]);
  const node = f.view.map.nodes[0], card = f.view.stageEl.children[0], note = f.view.notes.get('fact');
  f.view.stageEl.querySelector = () => card; f.view.drawEdges = () => {};
  const count = (text, re) => (text.match(re) ?? []).length;
  const check = (want, why) => {
    const text = tcLabel(card).text;
    for (const [name, re, n] of [['Markers', /Markers:/g, want.markers], ['Color', /Color:/g, want.color], ['Model', /Model set/g, want.model]]) assert.equal(count(text, re), n, `${why}: ${name} once or not at all in "${text}"`);
    assert.equal(card.dataset.topicColor, want.attr, why);
  };
  check({ markers: 1, color: 1, model: 0, attr: 'blue' }, 'first draw');
  note.modelOverride = true; note.model = 'gpt-x';
  f.view.refreshCard(node, false); check({ markers: 1, color: 1, model: 1, attr: 'blue' }, 'model added');
  f.view.refreshCard(node, false); check({ markers: 1, color: 1, model: 1, attr: 'blue' }, 'refresh again');
  note.color = 'green'; f.view.refreshCard(node, false); check({ markers: 1, color: 1, model: 1, attr: 'green' }, 'colour changed');
  assert.match(tcLabel(card).text, /Color: Green/); assert.doesNotMatch(tcLabel(card).text, /Blue/);
  note.markers = ['star']; note.modelOverride = false; f.view.refreshCard(node, false);
  check({ markers: 1, color: 1, model: 0, attr: 'green' }, 'marker changed, model removed'); assert.doesNotMatch(tcLabel(card).text, /Done/);
  note.color = undefined; f.view.refreshCard(node, false);
  check({ markers: 1, color: 0, model: 0, attr: undefined }, 'colour cleared'); assert.equal('topicColor' in card.dataset, false); assert.equal('colorText' in card.dataset, false);
  note.color = 'purple'; f.view.refreshCard(node, false); check({ markers: 1, color: 1, model: 0, attr: 'purple' }, 'colour added later');
  const spans = dom.findAll(card, c => (c.cls ?? '').split(/\s+/).includes('vam-card-label'));
  assert.equal(spans.length, 1, 'one label element, replaced in place');
});
integrationTest('topic-color: the menu is a radiogroup of None and six named colours with aria-checked, and a branch button; choosing writes that colour for this topic only', async () => {
  const { view } = heFixture({ topics: [node('fact'), { ...node('kid'), parentId: 'fact' }], notes: heNotes([['fact', {}], ['kid', {}]]) });
  view.enqueue = work => work();
  const calls = [];
  view.changeTopicColor = async (node, color, branch) => { calls.push([node.id, color ?? null, !!branch]); const note = view.notes.get(node.id); note.color = color ?? undefined; };
  const panel = dom.element('panel'); view.renderColorSection(panel, view.map.nodes[0]);
  const group = () => dom.find(panel, c => c.attrs.role === 'radiogroup');
  assert.equal(group().attrs['aria-label'], 'Color');
  const radios = () => dom.findAll(group(), c => c.tag === 'button' && c.attrs.role === 'radio');
  assert.deepEqual(radios().map(r => r.text), ['None', 'Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple'], 'every swatch has a text name');
  assert.deepEqual(radios().map(r => r.attrs['aria-checked']), ['true', 'false', 'false', 'false', 'false', 'false', 'false']);
  const swatches = dom.findAll(group(), c => c.attrs['aria-hidden'] === 'true' && c.dataset.topicColorSwatch);
  assert.deepEqual(swatches.map(s => s.dataset.topicColorSwatch), ['red', 'orange', 'yellow', 'green', 'blue', 'purple']);
  radios()[2].click(); await dom.tick();
  assert.deepEqual(calls, [['fact', 'orange', false]]);
  assert.deepEqual(radios().map(r => r.attrs['aria-checked']), ['false', 'false', 'true', 'false', 'false', 'false', 'false'], 'repainted with the new choice');
  assert.equal(radios().filter(r => r.attrs.tabIndex === '0' || r.tabIndex === 0).length <= 1, true);
  radios()[0].click(); await dom.tick();
  assert.deepEqual(calls.at(-1), ['fact', null, false]);
  const apply = dom.button(panel, 'Apply to whole branch'); assert.ok(apply);
  const leaf = dom.element('leaf'); view.renderColorSection(leaf, view.map.nodes[1]); assert.equal(dom.button(leaf, 'Apply to whole branch').disabled, true, 'a leaf has no branch to apply to');
  radios()[3].click(); await dom.tick(); apply.click(); await dom.tick();
  assert.deepEqual(calls.at(-1), ['fact', 'yellow', true], 'the branch button applies the colour chosen now');
});
integrationTest('topic-color: opening and redrawing a map of legacy notes (no topic-color key) writes nothing: every file is byte-identical and neither writeTopicColor nor vault.process runs', async () => {
  const { fixture, DEFAULT_SETTINGS: settings } = require('../support.cjs');
  const { repo, contents } = fixture('en', { linkIndex: true });
  repo.settings = { ...settings, language: 'en' };
  const MAP = 'Agent Workspace/Topics/map-legacy/Map.md';
  const doc = { id: 'map-legacy', title: 'legacy', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-legacy');
  await repo.app.vault.create(MAP, core.serializeMap(doc));
  const root = await repo.createNote('Root', 'gpt-6-luna', doc, MAP, 'workspace');
  const kid = await repo.createNote('Kid', 'gpt-6-luna', doc, MAP, 'workspace');
  kid.parentId = root.id; doc.nodes.push(root, kid); await repo.saveMap(MAP, doc);
  for (const n of [root, kid]) assert.doesNotMatch(contents.get(n.path), /topic-color/, 'the fixture is a legacy-format note');
  const before = new Map(contents);
  const writes = [], processed = [];
  const originalColor = repo.writeTopicColor.bind(repo), originalProcess = repo.app.vault.process.bind(repo.app.vault);
  repo.writeTopicColor = async (...args) => { writes.push(args); return originalColor(...args); };
  repo.app.vault.process = async (...args) => { processed.push(args[0]?.path); return originalProcess(...args); };
  const { view } = heFixture({ topics: [root] });
  view.path = MAP; view.plugin.repo = repo; view.map = await repo.readMap(MAP); view.notes = new Map();
  for (const n of view.map.nodes) view.notes.set(n.id, { ...await repo.readNote(n.path, view.map), status: 'completed' }); // status only keeps the DOM stand-in simple; the files are untouched
  view.stageEl = hePatch(dom.element('stage')); view.cardEls = new Map(); view.drawEdges = () => {};
  for (const n of view.map.nodes) view.renderNode(n);
  const cards = view.stageEl.children.slice();
  for (const n of view.map.nodes) { view.stageEl.querySelector = () => cards[view.map.nodes.indexOf(n)]; view.refreshCard(n, false); }
  assert.equal(cards.length, 2); for (const card of cards) assert.equal('topicColor' in card.dataset, false, 'a legacy card shows no colour');
  for (const n of view.map.nodes) assert.equal(view.notes.get(n.id).color, undefined);
  assert.deepEqual([...contents.keys()].sort(), [...before.keys()].sort(), 'no file appeared or vanished');
  for (const [path, text] of before) assert.equal(contents.get(path), text, `${path} is byte-identical`);
  assert.deepEqual(writes, [], 'writeTopicColor was not called'); assert.deepEqual(processed, [], 'vault.process was not called');
});
integrationTest('topic-color: applying to a branch is one transaction that writes only the notes that change, folded descendants included; one undo restores all, redo reapplies; siblings and other keys stay put', async () => {
  const { fixture, DEFAULT_SETTINGS: settings } = require('../support.cjs');
  const { begin } = load('experiences/visual-map/map-transaction.ts', { obsidian });
  const { repo, contents } = fixture('en', { linkIndex: true });
  repo.settings = { ...settings, language: 'en' };
  const MAP = 'Agent Workspace/Topics/map-c/Map.md';
  const doc = { id: 'map-c', title: 'c', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-c');
  await repo.app.vault.create(MAP, core.serializeMap(doc));
  const root = await repo.createNote('Root', 'gpt-6-luna', doc, MAP, 'workspace');
  const child = await repo.createNote('Child', 'gpt-6-luna', doc, MAP, 'workspace');
  const grand = await repo.createNote('Grand', 'gpt-6-luna', doc, MAP, 'workspace');
  const same = await repo.createNote('Same', 'gpt-6-luna', doc, MAP, 'workspace');
  const sibling = await repo.createNote('Sibling', 'gpt-6-luna', doc, MAP, 'workspace');
  child.parentId = root.id; child.collapsed = true; grand.parentId = child.id; same.parentId = root.id;
  doc.nodes.push(root, child, grand, same, sibling); await repo.saveMap(MAP, doc);
  await repo.writeTopicColor(same.path, 'red');
  const { view } = heFixture({ topics: [root] });
  const deps = { repo, rebuildDerivedData: async () => {}, onApplied() {}, checkConflict: async () => {} };
  view.path = MAP; view.plugin.repo = repo; view.map = await repo.readMap(MAP); view.notes = new Map();
  view.beginMapTransaction = () => begin(deps);
  view.refreshAfterSavedChange = async () => { view.map = await repo.readMap(MAP); for (const n of view.map.nodes) view.notes.set(n.id, await repo.readNote(n.path, view.map)); };
  const pushed = []; view.history = { push: entry => pushed.push(entry) };
  await view.refreshAfterSavedChange();
  const writes = []; const original = repo.writeTopicColor.bind(repo);
  repo.writeTopicColor = async (p, id) => { writes.push(p); return original(p, id); };
  const snapshot = () => Object.fromEntries([root, child, grand, same, sibling].map(n => [n.path, contents.get(n.path)]));
  const before = snapshot(), mapBefore = contents.get(MAP);
  const rootNode = view.map.nodes.find(n => n.id === root.id);
  await view.changeTopicColor(rootNode, 'red', true);
  assert.equal(pushed.length, 1, 'one history entry for the whole branch');
  assert.deepEqual([...writes].sort(), [root.path, child.path, grand.path].sort(), 'the topic and its descendants (folded one included) that changed; the already-red one and the sibling are not written');
  for (const n of [root, child, grand, same]) assert.equal(view.notes.get(n.id).color, 'red', n.path);
  assert.equal(view.notes.get(sibling.id).color, undefined); assert.equal(contents.get(sibling.path), before[sibling.path]);
  assert.equal(contents.get(same.path), before[same.path], 'a note that already had the colour is byte-identical');
  assert.equal(contents.get(MAP), mapBefore, 'Map.md is not changed by a colour');
  await pushed[0].undo();
  assert.deepEqual(snapshot(), before, 'one undo gives back every note byte for byte');
  await pushed[0].redo();
  for (const n of [root, child, grand]) assert.match(contents.get(n.path), /^topic-color: "?red"?$/m);
  await pushed[0].undo();
  await view.refreshAfterSavedChange();
  writes.length = 0;
  await view.changeTopicColor(view.map.nodes.find(n => n.id === root.id), 'red', false);
  assert.deepEqual(writes, [root.path], 'a single topic does not touch its children (no inheritance)');
  assert.equal(view.notes.get(child.id).color, undefined);
  writes.length = 0; const count = pushed.length;
  await view.changeTopicColor(view.map.nodes.find(n => n.id === root.id), 'red', false);
  assert.deepEqual(writes, [], 'choosing the colour it already has writes nothing'); assert.equal(pushed.length, count, 'and adds no history entry');
  await view.changeTopicColor(view.map.nodes.find(n => n.id === root.id), null, false);
  assert.doesNotMatch(contents.get(root.path), /topic-color/, 'clearing removes the key');
});
// ---- topic style (card-style P2) ----
integrationTest('topic-style: a card carries only whitelisted data-topic-style-* values and "Style: ..." in its name; hostile values and an AIM card add nothing; redraws never double it', () => {
  const notes = heNotes([['fact', { style: ['bold', 'text-large', 'border-thick', 'line-thick'] }], ['hyp', { style: ['"><script>', 'BOLD'] }], ['other', {}]]);
  const f = tmRender({ notes }, 'fact');
  assert.equal(f.card.dataset.topicStyleBold, 'true'); assert.equal(f.card.dataset.topicStyleSize, 'large'); assert.equal(f.card.dataset.topicStyleBorder, 'thick');
  assert.match(tcLabel(f.card).text, /Style: Bold, Large, Thick border, Thick line$/); assert.equal(f.card.attrs['aria-labelledby'], tcLabel(f.card).id);
  for (const id of ['hyp', 'other']) {
    const shown = tmRender({ notes }, id);
    for (const key of ['topicStyleBold', 'topicStyleSize', 'topicStyleBorder', 'styleText']) assert.equal(key in shown.card.dataset, false, `${id} ${key}`);
    assert.doesNotMatch(tcLabel(shown.card).text, /Style/, id);
  }
  const aim = tmRender({ aim: true, topics: [{ ...node('fact'), aimKind: 'research' }], notes }, 'fact');
  for (const key of ['topicStyleBold', 'topicStyleSize', 'topicStyleBorder']) assert.equal(key in aim.card.dataset, false, `AIM ${key}`);
  assert.doesNotMatch(tcLabel(aim.card).text, /Style/);
  const g = heFixture({ notes: heNotes([['fact', { color: 'blue', style: ['bold'] }], ['hyp', {}], ['other', {}]]) });
  g.view.stageEl = hePatch(dom.element('stage')); g.view.cardEls = new Map(); g.view.renderNode(g.view.map.nodes[0]);
  const node0 = g.view.map.nodes[0], card = g.view.stageEl.children[0], note = g.view.notes.get('fact');
  g.view.stageEl.querySelector = () => card; g.view.drawEdges = () => {};
  const count = re => (tcLabel(card).text.match(re) ?? []).length;
  assert.equal(count(/Style:/g), 1); assert.equal(count(/Color:/g), 1);
  g.view.refreshCard(node0, false); assert.equal(count(/Style:/g), 1, 'refresh again');
  note.style = ['text-small']; g.view.refreshCard(node0, false);
  assert.equal(count(/Style:/g), 1); assert.match(tcLabel(card).text, /Style: Small/); assert.doesNotMatch(tcLabel(card).text, /Bold/); assert.equal('topicStyleBold' in card.dataset, false); assert.equal(card.dataset.topicStyleSize, 'small'); assert.equal(count(/Color:/g), 1);
  note.style = undefined; g.view.refreshCard(node0, false);
  assert.equal(count(/Style:/g), 0); assert.equal('styleText' in card.dataset, false); assert.equal(count(/Color:/g), 1);
});
integrationTest('topic-style: bold, thick border and thick line are aria-pressed switches; text size is a radiogroup that arrow keys move; the branch button applies what is shown', async () => {
  const { view } = heFixture({ topics: [node('fact'), { ...node('kid'), parentId: 'fact' }], notes: heNotes([['fact', {}], ['kid', {}]]) });
  view.enqueue = work => work();
  const calls = [];
  view.changeTopicStyle = async (n, styles, branch) => { calls.push([n.id, [...styles], !!branch]); const note = view.notes.get(n.id); note.style = [...styles]; };
  const panel = dom.element('panel'); view.renderStyleSection(panel, view.map.nodes[0]);
  const pressed = () => dom.findAll(panel, c => c.tag === 'button' && c.attrs['aria-pressed'] !== undefined);
  assert.deepEqual(pressed().map(b => [b.text, b.attrs['aria-pressed']]), [['Bold', 'false'], ['Thick border', 'false'], ['Thick line', 'false']]);
  const group = () => dom.find(panel, c => c.attrs.role === 'radiogroup');
  assert.equal(group().attrs['aria-label'], 'Text size');
  const radios = () => dom.findAll(group(), c => c.tag === 'button' && c.attrs.role === 'radio');
  assert.deepEqual(radios().map(r => [r.text, r.attrs['aria-checked']]), [['Standard', 'true'], ['Small', 'false'], ['Large', 'false']]);
  pressed()[0].click(); await dom.tick();
  assert.deepEqual(calls.at(-1), ['fact', ['bold'], false]); assert.equal(pressed()[0].attrs['aria-pressed'], 'true');
  pressed()[0].click(); await dom.tick();
  assert.deepEqual(calls.at(-1), ['fact', [], false], 'pressing the set value again turns it off');
  radios()[2].click(); await dom.tick();
  assert.deepEqual(calls.at(-1), ['fact', ['text-large'], false]); assert.deepEqual(radios().map(r => r.attrs['aria-checked']), ['false', 'false', 'true']);
  radios()[2].keydown({ key: 'ArrowRight', preventDefault() {} });
  await dom.tick();
  assert.deepEqual(calls.at(-1), ['fact', [], false], 'ArrowRight wraps to Standard and clears the size');
  pressed()[1].click(); await dom.tick(); radios()[1].click(); await dom.tick();
  assert.deepEqual(calls.at(-1), ['fact', ['border-thick', 'text-small'], false], 'a size keeps the other switches');
  const leaf = dom.element('leaf'); view.renderStyleSection(leaf, view.map.nodes[1]); assert.equal(dom.button(leaf, 'Apply to whole branch').disabled, true);
  const sizeLabels = () => dom.findAll(panel, c => c.cls && c.cls.split(' ').includes('vam-topic-style-size-label'));
  assert.deepEqual(sizeLabels().map(l => l.text), ['Text size'], 'the size label survives every repaint');
  const styleApply = dom.button(panel, 'Apply to whole branch'); assert.equal(styleApply.attrs['aria-label'], 'Apply style to whole branch');
  view.renderColorSection = Object.getPrototypeOf(view).renderColorSection;
  const both = dom.element('both'); view.renderColorSection(both, view.map.nodes[0]); view.renderStyleSection(both, view.map.nodes[0]);
  const applies = dom.findAll(both, c => c.tag === 'button' && c.text === 'Apply to whole branch').map(b => b.attrs['aria-label']);
  assert.deepEqual(applies, ['Apply colour to whole branch', 'Apply style to whole branch'], 'the two apply buttons have distinct names');
  dom.button(panel, 'Apply to whole branch').click(); await dom.tick();
  assert.deepEqual(calls.at(-1), ['fact', ['text-small', 'border-thick'], true]);
});
integrationTest('topic-style: a branch change is one transaction writing only the notes that differ, folded ones included; one undo restores all; a single topic leaves children alone; unknown tokens stay', async () => {
  const { fixture, DEFAULT_SETTINGS: settings } = require('../support.cjs');
  const { begin } = load('experiences/visual-map/map-transaction.ts', { obsidian });
  const { repo, contents } = fixture('en', { linkIndex: true });
  repo.settings = { ...settings, language: 'en' };
  const MAP = 'Agent Workspace/Topics/map-s/Map.md';
  const doc = { id: 'map-s', title: 's', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-s');
  await repo.app.vault.create(MAP, core.serializeMap(doc));
  const root = await repo.createNote('Root', 'gpt-6-luna', doc, MAP, 'workspace');
  const child = await repo.createNote('Child', 'gpt-6-luna', doc, MAP, 'workspace');
  const same = await repo.createNote('Same', 'gpt-6-luna', doc, MAP, 'workspace');
  const sibling = await repo.createNote('Sibling', 'gpt-6-luna', doc, MAP, 'workspace');
  child.parentId = root.id; child.collapsed = true; same.parentId = root.id;
  doc.nodes.push(root, child, same, sibling); await repo.saveMap(MAP, doc);
  await repo.writeTopicStyle(root.path, { set: ['bold'] });
  await repo.writeTopicStyle(same.path, { set: ['bold'] });
  const { view } = heFixture({ topics: [root] });
  const deps = { repo, rebuildDerivedData: async () => {}, onApplied() {}, checkConflict: async () => {} };
  view.path = MAP; view.plugin.repo = repo; view.map = await repo.readMap(MAP); view.notes = new Map();
  view.beginMapTransaction = () => begin(deps);
  view.refreshAfterSavedChange = async () => { view.map = await repo.readMap(MAP); for (const n of view.map.nodes) view.notes.set(n.id, await repo.readNote(n.path, view.map)); };
  const pushed = []; view.history = { push: entry => pushed.push(entry) };
  await view.refreshAfterSavedChange();
  const writes = []; const original = repo.writeTopicStyle.bind(repo);
  repo.writeTopicStyle = async (p, c) => { writes.push(p); return original(p, c); };
  const snapshot = () => Object.fromEntries([root, child, same, sibling].map(n => [n.path, contents.get(n.path)]));
  const before = snapshot(), mapBefore = contents.get(MAP);
  const rootNode = () => view.map.nodes.find(n => n.id === root.id);
  await view.changeTopicStyle(rootNode(), ['bold'], true);
  assert.equal(pushed.length, 1); assert.deepEqual(writes, [child.path], 'only the folded child differs');
  assert.deepEqual([...view.notes.get(child.id).style], ['bold']); assert.equal(contents.get(MAP), mapBefore);
  assert.equal(contents.get(sibling.path), before[sibling.path]);
  await pushed[0].undo(); assert.deepEqual(snapshot(), before, 'one undo gives back every note');
  await view.refreshAfterSavedChange(); writes.length = 0;
  await view.changeTopicStyle(rootNode(), ['bold', 'text-large'], false);
  assert.deepEqual(writes, [root.path]); assert.equal(view.notes.get(child.id).style, undefined, 'no inheritance');
  const count = pushed.length; writes.length = 0;
  await view.changeTopicStyle(rootNode(), ['text-large', 'bold'], false);
  assert.deepEqual(writes, []); assert.equal(pushed.length, count, 'the same styles write nothing and add no history entry');
  await view.changeTopicStyle(rootNode(), [], false);
  assert.doesNotMatch(contents.get(root.path), /topic-style/, 'clearing removes the key');
});
// Topic links (P2): card button, menu, panel section, undo and outline.
integrationTest('topic-links: opening re-validates, refuses an unsafe href with a Notice, and opens a valid one without opener or referrer', () => {
  {
    const { view, notices, opened } = heFixture();
    assert.equal(view.openTopicLink('https://example.com/a?b=1'), true);
    assert.deepEqual(opened, [['https://example.com/a?b=1', '_blank', 'noopener,noreferrer']]);
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:1', 'data:text/html,x', 'file:///etc/passwd', 'obsidian://open', 'mailto:a@b.c', 'example.com', 'https://u:p@example.com', 42, null]) assert.equal(view.openTopicLink(bad), false, String(bad));
    assert.equal(opened.length, 1, 'nothing else opened');
    assert.equal(notices.length, 11);
  }
});
integrationTest('topic-links: the card header shows a button whose label lists the hosts; one link opens directly, several open a keyboard menu', () => {
  {
    const f = heFixture({ notes: heNotes([['fact', { links: ['https://a.example/x'] }], ['hyp', { links: ['https://a.example/x', 'https://b.example/y'] }], ['other', { links: ['javascript:alert(1)'] }]]) });
    const { view, opened } = f;
    view.stageEl = hePatch(dom.element('stage')); view.cardEls = new Map();
    for (const n of view.map.nodes) view.renderNode(n);
    const header = i => dom.find(view.stageEl.children[i], c => (c.cls ?? '').split(/\s+/).includes('vam-node-header'));
    const button = i => dom.find(header(i), c => c.tag === 'button' && (c.cls ?? '').includes('vam-card-links'));
    assert.equal(button(0).text, '↗'); assert.equal(button(0).attrs['aria-label'], 'Links: a.example');
    assert.equal(button(1).text, '↗2'); assert.equal(button(1).attrs['aria-label'], 'Links: a.example, b.example');
    assert.equal(button(2), undefined, 'an unsafe stored value shows nothing');
    assert.equal(button(0).tabIndex, -1, 'out of the tab order until the card has focus (the focusin handler adds every card button)');
    const card0 = view.stageEl.children[0]; card0.matches = q => q === ':focus-within'; view.paintCardLinks(card0, header(0), 'fact');
    assert.equal(button(0).tabIndex, 0, 'repainted while the card is focused: stays reachable by Tab');
    let stopped = 0;
    button(0).fire('pointerdown', { stopPropagation() { stopped++; } }); assert.equal(stopped, 1, 'a press is not a card gesture');
    button(0).click();
    assert.deepEqual(opened, [['https://a.example/x', '_blank', 'noopener,noreferrer']]);
    view.contentEl = hePatch(dom.element('content')); view.contentEl.getBoundingClientRect = () => ({ left: 0, top: 0 }); view.contentEl.ownerDocument = { addEventListener() {}, removeEventListener() {} };
    button(1).getBoundingClientRect = () => ({ left: 5, bottom: 9 });
    button(1).click();
    const menu = dom.find(view.contentEl, c => (c.cls ?? '').includes('vam-topic-link-menu'));
    assert.equal(menu.attrs.role, 'menu');
    const items = dom.findAll(menu, c => c.tag === 'button');
    assert.deepEqual(items.map(c => c.text), ['a.example', 'b.example']); assert.ok(items.every(c => c.attrs.role === 'menuitem'));
    menu.fire('keydown', { key: 'Escape', target: items[0] });
    assert.equal(view.topicLinkMenu, null, 'Escape closes the menu');
    button(1).click(); dom.findAll(dom.find(view.contentEl, c => (c.cls ?? '').includes('vam-topic-link-menu')), c => c.tag === 'button')[1].click();
    assert.deepEqual(opened.at(-1), ['https://b.example/y', '_blank', 'noopener,noreferrer']);
  }
});
integrationTest('topic-links: the panel section lists and opens links in read-only cases, hides editing, and shows errors in an aria-live region', async () => {
  {
    for (const options of [{ aim: true }, { integration: true }]) {
      const f = heFixture({ ...options, notes: heNotes([['fact', { links: ['https://a.example/x'] }], ['hyp', {}], ['other', {}]]) });
      if (options.integration) f.view.selection.toggleMultiSelect();
      const panel = dom.element('panel'); f.view.renderLinkSection(panel, f.view.map.nodes[0]);
      assert.equal(dom.findAll(panel, c => c.tag === 'input').length, 0, `no input ${JSON.stringify(options)}`);
      assert.deepEqual(dom.findAll(panel, c => c.tag === 'button').map(b => b.attrs['aria-label']), ['Open a.example']);
      f.view.beginMapTransaction = () => assert.fail('no transaction');
      assert.equal(await f.view.changeTopicLinks(f.view.map.nodes[0], { add: 'https://z.example' }), null);
      const bare = dom.element('panel'); f.view.renderLinkSection(bare, f.view.map.nodes[1]); assert.equal(bare.children.length, 0, 'nothing to show, nothing to edit');
    }
    const f = heFixture({ notes: heNotes([['fact', { links: ['https://a.example/x'] }], ['hyp', {}], ['other', {}]]) });
    const { view } = f; view.enqueue = work => work();
    const tx = { rewriteNote(p, write) { tx.write = write; tx.path = p; return tx; }, editMap() { return tx; }, async commit() { await tx.write(tx.path); return { undo() {}, redo() {} }; } };
    view.beginMapTransaction = () => tx; view.history = { push() {} }; view.refreshAfterSavedChange = async () => {};
    const calls = [];
    view.plugin.repo.writeTopicLinks = async (path, change) => { calls.push(change); const note = view.notes.get('fact'); if ('add' in change) { if (change.add === 'dup') return { ok: false, reason: 'duplicate' }; if (change.add === 'bad') return { ok: false, reason: 'invalid' }; note.links = [...note.links, change.add]; } else note.links = note.links.filter(h => h !== change.remove.href); return { ok: true, next: note.links }; };
    const panel = dom.element('panel'); view.renderLinkSection(panel, view.map.nodes[0]);
    const status = dom.find(panel, c => c.attrs['aria-live'] === 'polite');
    const input = dom.find(panel, c => c.tag === 'input'); assert.equal(input.attrs['aria-label'], 'Add a link');
    input.value = 'bad'; dom.findAll(panel, c => c.tag === 'button').find(b => b.text === 'Add').click(); await dom.tick();
    assert.match(status.text, /http:\/\/ or https:\/\//); assert.equal(input.value, 'bad', 'the text stays so it can be fixed');
    input.value = 'dup'; input.fire('keydown', { key: 'Enter' }); await dom.tick();
    assert.equal(status.text, 'This link is already on the topic.');
    input.value = 'https://b.example/'; dom.findAll(panel, c => c.tag === 'button').find(b => b.text === 'Add').click(); await dom.tick();
    assert.equal(status.text, 'Link added.'); assert.equal(input.value, '');
    assert.equal(dom.findAll(panel, c => (c.cls ?? '').includes('vam-topic-link-row')).length, 2);
    dom.findAll(panel, c => c.tag === 'button').find(b => b.attrs['aria-label'] === 'Remove link a.example').click(); await dom.tick();
    assert.equal(status.text, 'Link removed.'); assert.deepEqual(plain(calls.at(-1)), { remove: { href: 'https://a.example/x' } });
  }
});
integrationTest('topic-links: a refused write leaves no undo step; the link menu takes focus again after the pointer click that opened it blurred it', async () => {
  const f = heFixture({ notes: heNotes([['fact', { links: [] }], ['hyp', {}], ['other', {}]]) });
  const { view } = f; const pushed = [];
  const tx = { rewriteNote(p, write) { tx.write = write; tx.path = p; return tx; }, editMap() { return tx; }, async commit() { await tx.write(tx.path); return { undo() {}, redo() {} }; } };
  view.beginMapTransaction = () => tx; view.history = { push: e => pushed.push(e) }; view.refreshAfterSavedChange = async () => {};
  for (const reason of ['invalid', 'duplicate', 'too-many']) {
    view.plugin.repo.writeTopicLinks = async () => ({ ok: false, reason });
    assert.deepEqual({ ...(await view.changeTopicLinks(view.map.nodes[0], { add: 'x' })) }, { ok: false, reason });
  }
  assert.equal(pushed.length, 0, 'refused writes push no history');
  view.plugin.repo.writeTopicLinks = async () => ({ ok: true, next: ['https://a.example/'] });
  assert.equal((await view.changeTopicLinks(view.map.nodes[0], { add: 'https://a.example/' })).ok, true); assert.equal(pushed.length, 1);
  // The menu: the app blurs focus after the click; a deferred focus puts it back on the first item.
  const timers = [];
  const { VisualAgentMapView } = load('main.ts', { obsidian }, { setTimeout: run => { timers.push(run); return timers.length; }, clearTimeout() {} });
  const menuView = Object.create(VisualAgentMapView.prototype);
  const doc = { activeElement: null, addEventListener() {}, removeEventListener() {} };
  const focusable = () => ({ attrs: {}, listeners: {}, setAttr(n, v) { this.attrs[n] = v; }, addEventListener(n, fn) { this.listeners[n] = fn; }, focus() { doc.activeElement = this; }, remove() {}, contains(x) { return x === this || (this.kids ?? []).includes(x); }, getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 0 }), style: {}, createEl() { const el = focusable(); (this.kids ??= []).push(el); return el; }, createDiv() { return focusable(); } });
  menuView.contentEl = Object.assign(focusable(), { ownerDocument: doc });
  menuView.linkHost = href => href; menuView.topicLinkMenu = null;
  const trigger = focusable();
  menuView.showTopicLinkMenu(trigger, ['https://a.example/', 'https://b.example/']);
  const first = menuView.topicLinkMenu.menu.kids[0];
  assert.equal(doc.activeElement, first, 'focus on the first item at once (keyboard open)');
  doc.activeElement = { body: true };
  assert.equal(timers.length, 1); timers[0]();
  assert.equal(doc.activeElement, first, 'focus returns after the pointer blur');
});
integrationTest('topic-links: adding is one transaction; one undo restores the exact note text, redo reapplies it, and removing the last link drops the key', async () => {
  const { fixture, DEFAULT_SETTINGS: settings } = require('../support.cjs');
  const { begin } = load('experiences/visual-map/map-transaction.ts', { obsidian });
  const { repo, contents } = fixture('en', { linkIndex: true });
  repo.settings = { ...settings, language: 'en' };
  const MAP = 'Agent Workspace/Topics/map-l/Map.md';
  const doc = { id: 'map-l', title: 'l', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-l');
  await repo.app.vault.create(MAP, core.serializeMap(doc));
  const topic = await repo.createNote('Topic', 'gpt-6-luna', doc, MAP, 'workspace');
  doc.nodes.push(topic); await repo.saveMap(MAP, doc);
  const { view } = heFixture({ topics: [topic] });
  const deps = { repo, rebuildDerivedData: async () => {}, onApplied() {}, checkConflict: async () => {} };
  view.path = MAP; view.plugin.repo = repo; view.map = await repo.readMap(MAP); view.notes = new Map();
  view.beginMapTransaction = () => begin(deps);
  view.refreshAfterSavedChange = async () => { view.map = await repo.readMap(MAP); for (const n of view.map.nodes) view.notes.set(n.id, await repo.readNote(n.path, view.map)); };
  const pushed = []; view.history = { push: entry => pushed.push(entry) };
  await view.refreshAfterSavedChange();
  const before = contents.get(topic.path), at = () => view.map.nodes[0];
  const result = await view.changeTopicLinks(at(), { add: 'https://example.com/p' });
  assert.equal(result.ok, true); assert.equal(pushed.length, 1);
  assert.deepEqual(plain(view.notes.get(at().id).links), ['https://example.com/p']); assert.match(contents.get(topic.path), /topic-links/);
  await pushed[0].undo(); assert.equal(contents.get(topic.path), before, 'one undo gives back the exact note text');
  await pushed[0].redo(); assert.match(contents.get(topic.path), /https:\/\/example\.com\/p/);
  await view.refreshAfterSavedChange();
  assert.equal((await view.changeTopicLinks(at(), { add: 'javascript:alert(1)' })).ok, false);
  assert.doesNotMatch(contents.get(topic.path), /javascript/);
  await view.changeTopicLinks(at(), { remove: { href: 'https://example.com/p' } });
  assert.doesNotMatch(contents.get(topic.path), /topic-links/, 'emptied list removes the key');
});
integrationTest('topic-links: the outline marks a row with an aria-hidden arrow and adds the link count to its name; it opens nothing', () => {
  const { OutlineView } = load('ui/outline-view.ts', { obsidian: { ...obsidian, ItemView: class { constructor() { this.contentEl = dom.element('div'); } }, Notice: class {} } });
  const view = new OutlineView({ app: {} }, async () => {});
  const map = { title: 'M', nodes: [{ id: 'a', parentId: null, path: 'a.md' }, { id: 'b', parentId: 'a', path: 'b.md' }] };
  view.setMap(map, new Map([['a', 'Alpha'], ['b', 'Beta']]), new Map([['a', ['done']]]), new Map([['a', ['https://a.example', 'https://b.example']], ['b', ['javascript:1']]]));
  const [alpha, beta] = dom.findAll(view.contentEl, i => dom.hasCls(i, 'vam-outline-note'));
  const arrow = dom.findAll(alpha, i => dom.hasCls(i, 'vam-outline-links'));
  assert.equal(arrow.length, 1); assert.equal(arrow[0].text, '↗'); assert.equal(arrow[0].attrs['aria-hidden'], 'true');
  assert.equal(alpha.attrs['aria-label'], 'Alpha, Markers: Done, 2 links');
  assert.equal(dom.findAll(beta, i => dom.hasCls(i, 'vam-outline-links')).length, 0); assert.equal(beta.attrs['aria-label'], undefined);
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const fresh = css.split('\n').filter(line => /vam-topic-link|vam-card-links|vam-outline-links/.test(line));
  assert.ok(fresh.length >= 8 && fresh.every(line => /^\.(vam-view|vam-topic-modal|vam-outline) /.test(line)), 'new rules are scoped');
  assert.ok(!/@media/.test(fresh.join('\n')));
});
integrationTest('N2: an old view state carrying sample opens no map by itself, is not written back, and a file beside it still opens', async () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const opened = [];
  const view = Object.create(VisualAgentMapView.prototype);
  Object.assign(view, { path: '', map: null, openMap: async file => { opened.push(file); } });
  await view.setState({ sample: 'taiwan-travel' }, { history: false });
  assert.deepEqual(opened, [], 'a stale sample key opens nothing');
  assert.equal(view.map, null);
  assert.ok(!('sample' in view.getState()), 'getState never writes sample back');
  await view.setState({ sample: 'taiwan-travel', file: 'X/Map.md' }, { history: false });
  assert.deepEqual(opened, ['X/Map.md']);
});
integrationTest('N2: onOpen after a stale sample state opens the ordinary map, or renders the empty state when there is none', async () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  for (const files of [[{ path: 'AIM/Q/Map.md' }, { path: 'Agent Workspace/Mind Maps/A/Map.md' }], []]) {
    const opened = [];
    const plugin = { ready: Promise.resolve(), repo: { workspaceExists: () => true, mapFiles: async () => files, readMap: async file => (file === 'AIM/Q/Map.md' ? { aim: {} } : {}) } };
    const view = new VisualAgentMapView({ app: {} }, plugin);
    view.contentEl = { addClass() {} }; view.registerDomEvent = () => {}; view.render = () => {};
    view.openMap = async file => { opened.push(file); };
    await view.setState({ sample: 'taiwan-travel' }, { history: false });
    await view.onOpen();
    assert.deepEqual(opened, files.length ? ['Agent Workspace/Mind Maps/A/Map.md'] : [], 'the AIM map is never picked by default');
    assert.equal(view.map ?? null, null);
  }
});
test('N5: the empty state offers "Create a new mind map" and no "View sample" (source level: the real paint needs the Obsidian-only activeDocument global)', () => {
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  const start = source.indexOf('if (!this.map) {\n      const empty = this.contentEl.createDiv("vam-empty-state")');
  assert.ok(start > 0, 'the empty-state block exists');
  const block = source.slice(start, source.indexOf('return;', start));
  assert.match(block, /t\("ui\.create_a_new_mind_map"\)/);
  assert.doesNotMatch(block, /view_sample|sample/i);
  assert.doesNotMatch(source, /ui\.view_sample/);
});
integrationTest('N6: the map switcher lists exactly the topics and no "Sample:" entry', async () => {
  const opened = [];
  class FuzzySuggestModal { constructor(app) { this.app = app; } setPlaceholder() {} setInstructions() {} open() { opened.push(this); } close() {} }
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, FuzzySuggestModal } });
  const items = [{ title: 'Alpha', mapPath: 'A/Map.md', topicCount: 1, modified: 2, folder: 'W' }, { title: 'Beta', mapPath: 'B/Map.md', topicCount: 3, modified: 1, folder: 'W' }];
  const view = Object.create(VisualAgentMapView.prototype);
  Object.assign(view, { app: {}, path: 'A/Map.md', plugin: { repo: { mapSwitcherItems: async () => items } }, enqueue: work => work(), restoreMapFocusSoon() {} });
  await view.openMapSwitcher();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened.length, 1);
  const labels = opened[0].getItems().map(item => item.title);
  assert.deepEqual(plain(labels), ['Alpha', 'Beta']);
  assert.ok(!labels.some(label => label.startsWith('Sample:')));
});
integrationTest('C3: the map switcher is a fuzzy search list; rows say topic count, last edit and (only when maps live in several folders) the folder; newest first; choosing opens the map', async () => {
  const opened = [];
  class FuzzySuggestModal { constructor(app) { this.app = app; } setPlaceholder(text) { this.placeholder = text; } setInstructions(list) { this.instructions = list; } open() { opened.push(this); } close() {} }
  const shim = { ...obsidian, FuzzySuggestModal };
  const { MapSwitcherModal, mapSwitcherDetail } = load('ui/modals/map-switcher-modal.ts', { obsidian: shim });
  const now = new Date(2026, 10, 3, 15, 0).getTime();
  const items = [
    { title: 'Old', mapPath: 'W/Old/Map.md', topicCount: 1, modified: new Date(2026, 0, 2).getTime(), folder: 'Work' },
    { title: 'New', mapPath: 'P/New/Map.md', topicCount: 12, modified: now - 60000, folder: 'Personal' }
  ];
  const chosen = [];
  const modal = new MapSwitcherModal({}, items, 'W/Old/Map.md', item => chosen.push(item.mapPath));
  assert.equal(modal.placeholder, 'Type a mind map name…');
  assert.equal(modal.emptyStateText, 'No mind map matches.');
  assert.deepEqual(plain(modal.getItems().map(item => item.title)), ['New', 'Old'], 'the most recently edited map first');
  assert.equal(modal.getItemText(items[0]), 'Old Work', 'two folders: the folder is searchable too');
  const one = mapSwitcherDetail(items[0], true, now), many = mapSwitcherDetail(items[1], true, now);
  assert.match(one, /^1 topic · edited .*2026.* · Work$/);
  assert.match(many, /^12 topics · edited \d{1,2}:\d{2}.* · Personal$/, 'today: the time');
  assert.notEqual(one, many, 'the rows are not all the same');
  assert.doesNotMatch(mapSwitcherDetail(items[0], false, now), /Work/, 'one folder only: not repeated on every row');
  const single = new MapSwitcherModal({}, [items[0], { ...items[1], folder: 'Work' }], '', () => {});
  assert.equal(single.getItemText(items[0]), 'Old');
  const el = dom.element('div');
  modal.renderSuggestion({ item: items[0], match: { score: 0, matches: [] } }, el);
  const texts = []; const walk = node => { if (node.text) texts.push(node.text); (node.children ?? []).forEach(walk); }; walk(el);
  assert.ok(texts.includes('Old') && texts.some(text => /open now/.test(text)), texts.join('|'));
  modal.onChooseItem(items[1]);
  assert.deepEqual(plain(chosen), ['P/New/Map.md']);
});
// ---- bug bash A #01: dragging a card's own cover image must never be taken for a dropped file ----
function coverDragHarness() {
  const { VisualAgentMapView } = require('../support-replay.cjs').load('experiences/visual-map/view.ts', { obsidian: { ...obsidian, Component: class {}, MarkdownRenderChild: class {} } }, {
    window: { setTimeout, clearTimeout }, CSS: { escape: s => s }, createDiv: o => dom.element('div', o), createEl: (tag, o) => dom.element(tag, o), IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} }
  });
  const view = Object.create(VisualAgentMapView.prototype);
  const viewport = dom.element('div');
  viewport.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600 }); viewport.clientWidth = 800; viewport.clientHeight = 600;
  Object.assign(view, { viewportEl: viewport, selection: { state: { multiSelectMode: false } }, map: { viewport: { x: 0, y: 0, zoom: 1 } }, calls: [] });
  view.relationsEnabled = () => true;
  view.attachCardImages = (n, files) => { view.calls.push(['card', files.length]); return Promise.resolve(); };
  view.queueCanvasImages = (files) => { view.calls.push(['canvas', files.length]); };
  view.enqueue = work => work();
  const file = { name: 'a.png', type: 'image/png', size: 1 };
  const drop = () => ({ clientX: 1, clientY: 1, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, dataTransfer: { files: [file], types: ['Files'] } });
  return { VisualAgentMapView, view, viewport, drop, fire: (name, event = {}) => (viewport.listeners[name] ?? []).forEach(fn => fn(event)) };
}
test('bug bash #01: a card cover image is not natively draggable', () => {
  const { VisualAgentMapView } = coverDragHarness();
  const note = new obsidian.TFile('Topics/n.md'), image = new obsidian.TFile('img/a.png');
  const view = Object.assign(Object.create(VisualAgentMapView.prototype), {
    app: { vault: { getAbstractFileByPath: p => (p === note.path ? note : p === image.path ? image : null), getResourcePath: f => `app://res/${f.path}` },
      metadataCache: { getFileCache: () => ({ embeds: [{ link: 'img/a.png' }] }), getFirstLinkpathDest: () => image } },
    coverObserver: null
  });
  const card = dom.element('div'); card.createEl('h3', { cls: 'vam-card-title' });
  view.paintCover(card, note.path);
  const [img] = dom.findAll(card, i => i.tag === 'img');
  assert.ok(img, 'the cover image exists');
  assert.equal(img.attrs.draggable, 'false');
  assert.match(fs.readFileSync(path.join(root, 'styles.css'), 'utf8'), /\.vam-card-cover img\s*\{[^}]*-webkit-user-drag:\s*none/);
});
test('bug bash #01: an internal drag dropped on a card and bubbling to the canvas writes nothing; the flag ends with the canvas drop or dragend', () => {
  const h = coverDragHarness();
  h.view.setupCanvasImageInput();
  const card = dom.element('div'), topic = node('t');
  // Real order: dragstart on the cover, the drop lands on a card, then bubbles from the card to the canvas.
  const dropOnCard = () => { const ev = h.drop(); h.view.onCardDrop(ev, card, topic); if (!ev.stopped) h.fire('drop', ev); };
  h.fire('dragstart', { target: card });
  dropOnCard();
  assert.deepEqual(h.view.calls, [], 'neither the card nor the canvas takes an internal drag');
  h.fire('dragend', {});
  dropOnCard();
  assert.deepEqual(h.view.calls, [['card', 1]], 'an external file drop on a card still attaches the picture (and the card stops it reaching the canvas)');
  h.view.onCanvasDrop(h.drop());
  assert.deepEqual(h.view.calls, [['card', 1], ['canvas', 1]], 'and the canvas still takes an external picture');
  h.fire('dragstart', { target: card });
  h.fire('drop', h.drop());
  h.view.onCardDrop(h.drop(), card, topic);
  assert.equal(h.view.calls.length, 3, 'the canvas drop ended the internal drag, so the next external drop is not blocked');
});
test('bug bash #01: when dragend is lost, the next pointer event ends the internal drag and an external drag is accepted again', () => {
  const h = coverDragHarness();
  h.view.setupCanvasImageInput();
  const card = dom.element('div');
  h.fire('dragstart', { target: card });
  const refused = h.drop(); h.fire('dragover', refused);
  assert.equal(refused.defaultPrevented, false, 'while the internal drag lasts, dragover is not taken');
  h.fire('pointermove', { clientX: 1, clientY: 1 });
  const over = h.drop(); h.fire('dragover', over);
  assert.equal(over.defaultPrevented, true, 'after a pointer event the external dragover is accepted');
  h.fire('drop', h.drop());
  assert.deepEqual(h.view.calls, [['canvas', 1]]);
  h.fire('dragstart', { target: card });
  h.fire('pointerdown', { button: 0 });
  h.fire('drop', h.drop());
  assert.deepEqual(h.view.calls, [['canvas', 1], ['canvas', 1]], 'pointerdown ends it too');
});
// ---- bug bash A #03: the "+" button must win the hit test over the width resize handle while it is visible ----
// A unit environment has no layout, so elementsFromPoint cannot run here; the hit order is asserted through the CSS that decides it (the UI layer checks the real click).
const cssRules = (css, selectorPattern) => [...css.matchAll(/(^|\n)([^{}\n/][^{}]*)\{([^}]*)\}/g)].filter(m => selectorPattern.test(m[2].trim())).map(m => ({ selector: m[2].trim(), body: m[3] }));
test('bug bash #03: the add-child button sits above the width handle when visible and ignores the pointer when hidden', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const z = body => Number(/z-index:\s*(-?\d+)/.exec(body)?.[1] ?? 0);
  const base = cssRules(css, /^\.vam-node \.vam-add-child$/)[0];
  const handle = cssRules(css, /^\.vam-card-resize$/)[0];
  assert.ok(base && handle, 'both rules exist');
  assert.ok(z(base.body) > z(handle.body), 'the button paints above the width handle');
  assert.match(base.body, /pointer-events:\s*none/, 'hidden: the button does not take the pointer, so the handle stays continuous');
  const shown = cssRules(css, /\.vam-node\.is-selected > \.vam-add-child/)[0];
  assert.ok(shown, 'a visible rule exists');
  for (const state of [':hover', ':focus-within', '.is-selected']) assert.match(shown.selector, new RegExp(`\\.vam-node${state.replace('.', '\\.')}`));
  assert.match(shown.body, /opacity:\s*1/);
  assert.match(shown.body, /pointer-events:\s*auto/, 'visible: the button takes the pointer');
  assert.doesNotMatch(cssRules(css, /^\.vam-card-resize-y$|^\.vam-card-resize-corner$/).map(r => r.body).join(''), /pointer-events:\s*none/, 'height and corner handles are untouched');
});
// ---- bug bash A #04: the hover preview never covers the card it describes ----
function hoverHarness(hostWidth, hostHeight, cardRect, { tools = null, selectedNeighbours = [] } = {}) {
  const { VisualAgentMapView } = require('../support-replay.cjs').load('experiences/visual-map/view.ts', { obsidian: { ...obsidian, Component: class {}, MarkdownRenderChild: class {}, MarkdownRenderer: { render() { return Promise.resolve(); } } } }, {
    window: { setTimeout, clearTimeout }, CSS: { escape: s => s }, createDiv: o => dom.element('div', o), createEl: (tag, o) => dom.element(tag, o)
  });
  const host = dom.element('div');
  host.getBoundingClientRect = () => ({ left: 0, top: 0, right: hostWidth, bottom: hostHeight, width: hostWidth, height: hostHeight });
  host.createDiv = cls => { const el = dom.element('div', { cls }); el.style = { setProperty() {} }; host.children.push(el); return el; };
  const view = Object.create(VisualAgentMapView.prototype);
  Object.assign(view, { contentEl: { querySelector: () => host }, plugin: { settings: { previewScale: 120 }, researchProgress: null }, map: { nodes: [{ id: 'a', path: 'a.md' }] }, presentation: null, hoverCard: null });
  const box = rect => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top });
  const card = { dataset: { nodeId: 'a' }, getBoundingClientRect: () => cardRect, querySelector: selector => (selector === '.vam-node-tools' && tools ? { getBoundingClientRect: () => box(tools) } : null) };
  const neighbour = (rect, selected) => ({ classList: { contains: name => name === 'is-selected' && selected }, getBoundingClientRect: () => box(rect), querySelector: () => null });
  view.cardEls = new Map([['a', card], ...selectedNeighbours.map((rect, i) => [`n${i}`, neighbour(rect, true)]), ['unselected', neighbour({ left: 0, top: 0, right: hostWidth, bottom: hostHeight }, false)]]);
  view.showHoverCard(card, { title: 'T', preview: 'body' });
  const preview = host.children.at(-1);
  const px = key => (view.hoverCard ? parseFloat(view.hoverCard.style[key]) : NaN);
  return { shown: !!view.hoverCard, left: px('left'), top: px('top'), width: px('width'), maxHeight: px('maxHeight'), preview };
}
const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
test('bug bash #04: a narrow canvas puts the preview beside, above or below the card, never over it; a wide canvas keeps it on the right', () => {
  const card = { left: 150, top: 200, right: 250, bottom: 260 };
  const wide = hoverHarness(1200, 800, card);
  assert.equal(wide.shown, true);
  assert.equal(wide.left, 250 + 12, 'wide canvas: right of the card');
  assert.equal(wide.top, 200);
  const narrow = hoverHarness(400, 900, card);
  assert.equal(narrow.shown, true);
  const box = { left: narrow.left, top: narrow.top, right: narrow.left + narrow.width, bottom: narrow.top + Math.min(narrow.maxHeight, 900 - 24) };
  assert.equal(intersects(box, card), false, 'the preview rectangle does not intersect the card');
  assert.ok(box.left >= 12 && box.right <= 400 - 12 && box.top >= 12 && box.bottom <= 900 - 12, 'and it lies inside the canvas');
  const cramped = hoverHarness(300, 300, { left: 20, top: 20, right: 280, bottom: 280 });
  assert.equal(cramped.shown, false, 'no place that clears the card: no preview');
});
const boxOf = spot => ({ left: spot.left, top: spot.top, right: spot.left + spot.width, bottom: spot.top + Math.min(spot.maxHeight, 900 - 24) });
// A card's tool row hangs above the card (bottom: calc(100% - 6px)); a preview above the card used to start 12px over the card and cover it.
test('bug bash #04: the hover preview never covers the hovered card\'s tool row, neither above the card nor beside it', () => {
  const card = { left: 100, top: 700, right: 300, bottom: 760 };
  const tools = { left: 40, top: 670, right: 300, bottom: 706 };
  const above = hoverHarness(400, 900, card, { tools });
  assert.equal(above.shown, true, 'the only free side is above');
  assert.equal(intersects(boxOf(above), card), false);
  assert.equal(intersects(boxOf(above), tools), false, 'and the preview stops short of the tool row');
  // A left-aligned tool row wider than the card runs out over the right side of the card.
  const wideRow = { left: 20, top: 170, right: 400, bottom: 206 };
  const beside = hoverHarness(1200, 900, { left: 20, top: 200, right: 300, bottom: 260 }, { tools: wideRow });
  assert.equal(beside.shown, true);
  assert.equal(intersects(boxOf(beside), wideRow), false, 'beside the card the preview clears the wider tool row too');
  assert.equal(hoverHarness(1200, 900, { left: 150, top: 200, right: 250, bottom: 260 }, { tools: { left: 40, top: 170, right: 240, bottom: 206 } }).left, 262, 'an ordinary tool row inside the card keeps the preview on the right');
});
// Regression (UI acceptance of f516ade): a left-aligned tool row wider than its card sticks out past the card's right edge; on a wide canvas the preview still goes to the right, starting beyond the row.
test('bug bash #04: on a wide canvas a tool row sticking out past the card\'s right edge moves the right-hand preview\'s start beyond the row; the left side mirrors it', () => {
  const card = { left: 100, top: 372, right: 274, bottom: 430 };
  const tools = { left: 100, top: 355, right: 336, bottom: 376 };
  const spot = hoverHarness(1200, 900, card, { tools });
  assert.equal(spot.shown, true, 'the preview is shown');
  assert.equal(spot.left, 336 + 12, 'on the right, beyond the tool row');
  assert.equal(intersects(boxOf(spot), card), false);
  assert.equal(intersects(boxOf(spot), tools), false);
  const mirrored = hoverHarness(1200, 900, { left: 900, top: 372, right: 1074, bottom: 430 }, { tools: { left: 838, top: 355, right: 1074, bottom: 376 } });
  assert.equal(mirrored.shown, true);
  assert.equal(mirrored.left + mirrored.width, 838 - 12, 'on the left (right side has no room), beyond the row\'s left end');
});
// The pointer rests on a neighbour after dragging a handle of the selected card: the neighbour's preview must not cover the selected card's handles.
test('bug bash #04: when another side is free, the hover preview does not cover the selected neighbour card (its resize handles); with no free side it still clears the hovered card', () => {
  const card = { left: 150, top: 200, right: 250, bottom: 260 };
  const selected = { left: 270, top: 190, right: 420, bottom: 250 };
  const spot = hoverHarness(1200, 800, card, { selectedNeighbours: [selected] });
  assert.equal(spot.shown, true);
  assert.equal(intersects(boxOf(spot), selected), false, 'the selected card stays uncovered');
  assert.equal(intersects(boxOf(spot), card), false);
  assert.equal(hoverHarness(1200, 800, card).left, 262, 'without a selected neighbour the preview stays on the right');
  const boxed = hoverHarness(1200, 800, card, { selectedNeighbours: [{ left: 0, top: 0, right: 1200, bottom: 800 }] });
  assert.equal(boxed.shown, true, 'a selected card that every side would cover does not suppress the preview');
  assert.equal(intersects(boxOf(boxed), card), false);
});
// ---- bug bash A #12: a card's tool row wider than the card never runs off the visible left edge ----
function toolsHarness({ cardLeft, cardWidth = 280, toolsWidth = 345, canvasLeft = 0, canvasRight = 100000, zoom = 1, chatRight = null }) {
  const { VisualAgentMapView } = require('../support-replay.cjs').load('experiences/visual-map/view.ts', { obsidian: { ...obsidian, Component: class {}, MarkdownRenderChild: class {} } }, {
    window: { setTimeout, clearTimeout }, CSS: { escape: s => s }, createDiv: o => dom.element('div', o), createEl: (tag, o) => dom.element(tag, o)
  });
  const classes = new Set();
  const style = { removeProperty: key => { delete style[key.replace(/-(\w)/g, (m, c) => c.toUpperCase())]; } };
  const tools = { style, getBoundingClientRect() { const max = parseFloat(style.maxWidth) * zoom * Math.max(1, 1 / zoom); return { width: Number.isFinite(max) ? Math.min(toolsWidth, max) : toolsWidth }; }, toggleClass: (name, on) => (on ? classes.add(name) : classes.delete(name)) };
  const card = { offsetWidth: cardWidth, getBoundingClientRect: () => ({ left: cardLeft, right: cardLeft + cardWidth, width: cardWidth }), querySelector: () => tools };
  const chat = chatRight === null ? null : { getBoundingClientRect: () => ({ left: 0, right: chatRight }) };
  const view = Object.create(VisualAgentMapView.prototype);
  Object.assign(view, { map: { viewport: { x: 0, y: 0, zoom } }, viewportEl: { getBoundingClientRect: () => ({ left: canvasLeft, right: canvasRight }) }, contentEl: { querySelector: () => chat } });
  view.alignCardTools(card);
  // The rendered row: right edge of the tools = card right - 10; so its left = cardLeft + cardWidth - 10 - toolsWidth.
  const align = classes.has('is-align-left') ? 'left' : 'right';
  const shift = (parseFloat(style.marginLeft) || 0) * zoom;
  const width = tools.getBoundingClientRect().width;
  const toolsLeft = align === 'left' ? cardLeft + 10 * zoom + shift : cardLeft + cardWidth - 10 * zoom - width;
  return { align, toolsLeft, toolsRight: toolsLeft + width, wrapped: classes.has('is-wrapped') };
}
test('bug bash #12: a tool row wider than a card on the left edge is aligned to the card\'s left edge; an ordinary card stays right-aligned', () => {
  const edge = toolsHarness({ cardLeft: 20, canvasLeft: 0 });
  assert.equal(edge.align, 'left');
  assert.ok(edge.toolsLeft >= 0, 'every button is inside the visible area');
  const behindChat = toolsHarness({ cardLeft: 345, chatRight: 340 });
  assert.equal(behindChat.align, 'left', 'the chat window docked over the canvas counts as hidden area');
  assert.ok(behindChat.toolsLeft >= 340);
  const ordinary = toolsHarness({ cardLeft: 500 });
  assert.equal(ordinary.align, 'right');
  assert.match(fs.readFileSync(path.join(root, 'styles.css'), 'utf8'), /\.vam-node > \.vam-node-tools\.is-align-left\s*\{[^}]*right:\s*auto;[^}]*left:\s*10px/);
});

test('bug bash #12: a tool row wider than the whole visible canvas wraps and every button stays inside it; a wide canvas keeps the single row', () => {
  // Chat docked on the left, canvas 664-1024 (360px); the 379.7px row is wider than what is visible.
  const narrow = toolsHarness({ cardLeft: 670.8, toolsWidth: 379.7, canvasLeft: 664, canvasRight: 1024 });
  assert.equal(narrow.wrapped, true, 'the row wraps');
  assert.ok(narrow.toolsLeft >= 664 + 10 && narrow.toolsRight <= 1024 - 10, `every button lies inside the canvas (${narrow.toolsLeft}..${narrow.toolsRight})`);
  const zoomed = toolsHarness({ cardLeft: 700, toolsWidth: 480, zoom: 1.5, canvasLeft: 664, canvasRight: 1024 });
  assert.ok(zoomed.wrapped && zoomed.toolsLeft >= 674 && zoomed.toolsRight <= 1014, 'also when zoomed');
  const wide = toolsHarness({ cardLeft: 500, toolsWidth: 379.7, canvasLeft: 0, canvasRight: 1600 });
  assert.equal(wide.wrapped, false); assert.equal(wide.align, 'right', 'a wide canvas keeps the single right-aligned row');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(css, /\.vam-node > \.vam-node-tools\.is-wrapped\s*\{[^}]*flex-wrap:\s*wrap/);
});
integrationTest('C5: the map commands apply only to an active map view (topic ones only with a selected card, editing ones never on an AIM map or in a presentation) and run the same actions as the card tools', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  const tuples = [...source.matchAll(/\["(map-[a-z-]+)", "(ui\.command_map_[a-z_]+)", "([a-z-]+)"\]/g)].map(m => [m[1], m[2], m[3]]);
  assert.ok(tuples.length >= 6 && tuples.length <= 10, `${tuples.length} map commands`);
  assert.match(source, /checkCallback: checking =>\s*this\.app\.workspace\.getActiveViewOfType\(VisualAgentMapView\)\?\.mapCommand\(action, checking\) \?\? false/, 'no map view: the command does not apply');
  const { translate } = load('i18n.ts');
  for (const [, key] of tuples) for (const language of ['en', 'zh-TW', 'zh-CN']) assert.ok(translate(language, key) && translate(language, key) !== key, `${language} ${key}`);
  const { view } = selectionView(load, {}, { ...obsidian, Modal: class { open() { this.opened = true; } close() {} } });
  const calls = [];
  view.enqueue = work => work();
  view.addNode = parent => { calls.push(['add', parent?.id ?? null]); };
  view.openNextStep = node => calls.push(['ai', node.id]);
  view.startCardTitleEdit = node => calls.push(['rename', node.id, view.notes.get(node.id).title]);
  view.openDetails = node => calls.push(['details', node.id]);
  view.fit = () => calls.push(['fit']);
  view.zoomBy = factor => calls.push(['zoom', factor]);
  view.openMapSearch = () => calls.push(['search']);
  view.openKeyboardShortcuts = () => calls.push(['keys']);
  view.viewportEl = view.viewportEl ?? dom.element('div');
  const actions = tuples.map(t => t[2]);
  view.selection.setSelected(null);
  const none = Object.fromEntries(actions.map(action => [action, view.mapCommand(action, true)]));
  assert.deepEqual(plain(none), { 'add-topic': true, 'add-subtopic': false, 'add-sibling': false, 'ai-explore': false, rename: false, 'open-details': false, 'zoom-fit': true, 'zoom-reset': true, search: true, shortcuts: true }, 'no selected card: only the map-wide commands');
  assert.deepEqual(calls, [], 'checking runs nothing');
  const target = view.map.nodes.find(node => node.parentId);
  view.selection.setSelected(target.id);
  for (const action of actions) assert.equal(view.mapCommand(action, false), true, action);
  assert.deepEqual(plain(calls), [['add', null], ['add', target.id], ['add', target.parentId], ['ai', target.id], ['rename', target.id, view.notes.get(target.id).title], ['details', target.id], ['fit'], ['zoom', 1 / view.map.viewport.zoom], ['search'], ['keys']]);
  view.map.aim = { branches: [] };
  for (const action of ['add-topic', 'add-subtopic', 'add-sibling', 'ai-explore', 'rename']) assert.equal(view.mapCommand(action, true), false, `AIM map: ${action}`);
  assert.equal(view.mapCommand('open-details', true), true, 'reading still works on an AIM map');
  delete view.map.aim;
  view.presentation = { order: [], currentId: 'x' };
  for (const action of ['add-topic', 'rename', 'search']) assert.equal(view.mapCommand(action, true), false, `presentation: ${action}`);
  view.presentation = null;
  view.map = null;
  for (const action of actions) assert.equal(view.mapCommand(action, true), false, `no map: ${action}`);
});
integrationTest('C5: Keyboard shortcuts lists the map keys (Mod reads ⌘ on macOS, Ctrl elsewhere) and is in the More mind map actions menu', () => {
  const { MAP_KEYBOARD_SHORTCUTS, shortcutLabel } = load('ui/modals/keyboard-shortcuts-modal.ts', { obsidian: { ...obsidian, Platform: { isMacOS: false } } });
  const keys = MAP_KEYBOARD_SHORTCUTS.flatMap(entry => entry.keys);
  for (const key of ['F2', 'Mod+Enter', 'Shift+Enter', 'Delete', 'Mod+F', 'Mod+Z', 'Esc']) assert.ok(keys.includes(key), key);
  assert.equal(shortcutLabel('Mod+Shift+Z', false), 'Ctrl+Shift+Z');
  assert.equal(shortcutLabel('Mod+Shift+Z', true), '⌘+⇧+Z');
  const { translate } = load('i18n.ts');
  for (const entry of MAP_KEYBOARD_SHORTCUTS) for (const language of ['en', 'zh-TW', 'zh-CN']) assert.notEqual(translate(language, entry.action), entry.action);
  const menus = [];
  class Menu { constructor() { this.items = []; menus.push(this); } addItem(cb) { const item = { setTitle(v) { this.title = v; return this; }, setIcon() { return this; }, setWarning() { return this; }, onClick(fn) { this.click = fn; return this; } }; cb(item); this.items.push(item); return this; } addSeparator() { return this; } showAtPosition() { return this; } showAtMouseEvent() { return this; } }
  const { view } = selectionView(load, {}, { ...obsidian, Menu });
  let opened = 0; view.openKeyboardShortcuts = () => opened++;
  view.openMapActions();
  menus.at(-1).items.find(item => item.title === 'Keyboard shortcuts').click();
  assert.equal(opened, 1);
});

// ---- UX review A theme 1: the tool row counter-scales below 100% so its buttons stay tappable ----
test('UX-A canvas: zoomed out, the tool row wraps in screen pixels (its own scale included) and the stylesheet counter-scales it only below 100%', () => {
  // Zoom 0.5: the row is drawn at 0.5 * 2 = 1x on screen. Its max-width is in its own units: available / (zoom * 2).
  const narrow = toolsHarness({ cardLeft: 700, toolsWidth: 480, zoom: 0.5, canvasLeft: 664, canvasRight: 1024 });
  assert.ok(narrow.wrapped && narrow.toolsLeft >= 674 && narrow.toolsRight <= 1014, `zoomed out, every button lies inside the canvas (${narrow.toolsLeft}..${narrow.toolsRight})`);
  // Zoom >= 1: no extra scale, the max-width divides by the zoom alone (the existing 1.5 case stays valid).
  const zoomedIn = toolsHarness({ cardLeft: 700, toolsWidth: 480, zoom: 1.5, canvasLeft: 664, canvasRight: 1024 });
  assert.ok(zoomedIn.wrapped && zoomedIn.toolsRight <= 1014);
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(css, /\.vam-node > \.vam-node-tools \{[^}]*scale: max\(1, calc\(1 \/ var\(--vam-zoom, 1\)\)\);[^}]*transform-origin: right bottom;/, 'counter-scale with a fallback of 1; never shrinks at zoom >= 1');
  assert.match(css, /\.vam-node > \.vam-node-tools\.is-align-left \{[^}]*transform-origin: left bottom/);
  assert.match(css, /\.vam-node > \.vam-node-tools \{[^}]*transform: translateY\(4px\)/, 'the reveal animation keeps its own transform');
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(source, /this\.stageEl\.style\.setProperty\("--vam-zoom", String\(zoom\)\)/);
});
integrationTest('hypothesis-leaning: styles.css dims a disabled choice with not-allowed, and lays the four strengths in one row without touching other choice groups', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const block = selector => { const m = css.match(new RegExp(`^${selector.replace(/[.[\]"=-]/g, '\\$&')}[^{]*\\{([^}]*)\\}`, 'm')); assert.ok(m, `rule ${selector}`); return m[1]; };
  const disabled = block('.vam-topic-modal .vam-choice-group button[aria-disabled="true"]');
  assert.match(disabled, /opacity:\s*0\.5/); assert.match(disabled, /cursor:\s*not-allowed/); assert.match(disabled, /var\(--text-faint\)/);
  assert.match(css, /\.vam-topic-modal \.vam-choice-group button\.is-disabled/);
  assert.match(block('.vam-topic-modal .vam-choice-group.vam-hypothesis-strengths'), /repeat\(4,/);
  assert.match(block('.vam-topic-modal .vam-choice-group'), /repeat\(3,/, 'the shared group keeps three columns');
});

// The goal bar floats over the top centre of the canvas, so every fit/focus/initial-viewport path measures it like the toolbar.
test('goal bar: canvasInset, canvasInsets, floatingControlRects and topsUnderToolbar all include the bar (the tallest of toolbar and bar wins)', () => {
  const { view, a } = viewportFixture();
  a.x = 400; a.y = 20; a.width = 280;
  const rects = { '.vam-map-tools': { left: 12, top: 12, right: 60, bottom: 50 }, '.vam-goal-bar': { left: 220, top: 12, right: 780, bottom: 110 } };
  const query = hidden => selector => (rects[selector] && selector !== hidden ? { getBoundingClientRect: () => rects[selector] } : null);
  view.viewportEl = { clientWidth: 1000, clientHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000, bottom: 600 }) };
  view.contentEl = { querySelector: query('') };
  view.cardEls = new Map([['a', { offsetHeight: 120 }]]);
  view.canvasNodes = () => [a];
  view.map.viewport = { x: 1, y: 0, zoom: 1 };
  const withBar = view.canvasInset();
  view.contentEl = { querySelector: query('.vam-goal-bar') };
  const withoutBar = view.canvasInset();
  assert.ok(withBar > withoutBar, `the bar (${withBar}) is taller than the toolbar alone (${withoutBar})`);
  view.contentEl = { querySelector: query('') };
  assert.equal(view.canvasInsets().top, withBar, 'Show all / focus keep the bar clear too');
  assert.ok(view.floatingControlRects().some(r => r.left === 220 && r.right === 780), 'a card under the bar counts as obscured');
  assert.deepEqual([...view.topsUnderToolbar(1)], [20], 'a card drawn under the bar (not under the toolbar) is lifted');
  view.contentEl = { querySelector: query('.vam-goal-bar') };
  assert.deepEqual([...view.topsUnderToolbar(1)], [], 'without the bar the same card is clear');
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(source, /for \(const selector of FLOATING_LAYER_SELECTORS\)/);
});

test('goal bar: styles keep it above the cards, centred on the visible canvas, wrapping (no ellipsis), icons only on hover or focus, theme variables only', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const rule = selector => css.split('\n').find(line => line.startsWith(`${selector} {`)) ?? '';
  const bar = rule('.vam-goal-bar');
  assert.match(bar, /position: absolute;[^}]*top: 12px;[^}]*left: calc\(50% \+ var\(--vam-goal-inset, 0px\) \/ 2\);[^}]*transform: translateX\(-50%\)/, 'centred on the canvas the chat window does not cover');
  assert.match(bar, /width: min\(460px, calc\(100% - 24px - var\(--vam-goal-inset, 0px\)\)\)/, 'at most 460px, never wider than the visible canvas minus 24px, no side reservation (the tools sit below the bar)');
  assert.doesNotMatch(bar, /108px/);
  assert.match(bar, /padding: 14px 18px/); assert.match(bar, /border-radius: 16px/); assert.match(bar, /background: var\(--background-primary\)/); assert.match(bar, /border: 1px solid var\(--background-modifier-border\)/);
  assert.doesNotMatch(bar, /#[0-9a-f]{3,6}\b/i, 'theme variables, not mock-up hex colours');
  const text = rule('.vam-goal-text');
  assert.match(text, /font-size: 1\.2rem;[^}]*font-weight: 800/); assert.match(text, /overflow-wrap: anywhere/); assert.doesNotMatch(text, /text-overflow|ellipsis|white-space: nowrap|overflow: hidden/, 'the goal wraps, never cut');
  assert.match(rule('.vam-goal-actions'), /display: none/);
  // Showing the icons must not change the bar height: one text line (1.2rem x 1.35 + 2 x 3px) is already as tall as the 30px icons.
  assert.match(text, /padding-block: 3px/); assert.match(text, /line-height: 1\.35/);
  assert.ok(19.2 * 1.35 + 6 >= 30, 'a one-line text box is at least as tall as the icon row, so hover does not grow the bar');
  assert.match(css, /^\.vam-empty \{[^}]*top: 50%;[^}]*left: 50%;[^}]*translate\(-50%, -50%\)/m, 'the empty-map text and button are centred in the canvas');
  assert.match(css, /\.vam-goal-bar:hover \.vam-goal-actions, \.vam-goal-bar:focus-within \.vam-goal-actions \{ display: flex; \}/);
  assert.match(css, /\.vam-goal-bar:hover, \.vam-goal-bar:focus-within \{ border-color: var\(--interactive-accent\); \}/);
  assert.match(rule('.vam-goal-icon'), /width: 30px; height: 30px/);
  assert.doesNotMatch(css, /vam-relevance-level|vam-relevance-sort|vam-relevance-grade-button|\.vam-map-tools \.vam-relevance-goal/, 'the old goal pill and panel rules are gone');
});

test('goal bar: the tool group is placed right below the bar and follows its height; without a bar it keeps the stylesheet top', () => {
  const { view } = viewportFixture();
  const tools = { style: {} }; const bar = { offsetTop: 12, offsetHeight: 62, style: { setProperty() {} }, ownerDocument: null };
  view.contentEl = { querySelector: s => (s === '.vam-map-tools' ? tools : s === '.vam-goal-bar' ? bar : null) };
  view.placeMapTools();
  assert.equal(tools.style.top, '82px', 'bar bottom (74) + 8px gap');
  bar.offsetHeight = 140; view.placeMapTools();
  assert.equal(tools.style.top, '160px', 'a wrapped, taller bar pushes the tools down with it');
  for (const height of [62, 140]) { bar.offsetHeight = height; view.placeMapTools(); const barBottom = bar.offsetTop + bar.offsetHeight; assert.ok(parseInt(tools.style.top, 10) > barBottom, `tools start below the bar (${height})`); }
  view.contentEl = { querySelector: s => (s === '.vam-map-tools' ? tools : null) };
  view.placeMapTools();
  assert.equal(tools.style.top, '', 'no goal bar (AIM or empty map): today\'s top');
});

test('goal bar: tools sit below the open suggestion card, and follow canvas, bar and card size changes; the watch is dropped on close', async () => {
  const { view } = viewportFixture();
  const watchers = [];
  class FakeRO { constructor(fn) { this.fn = fn; this.targets = []; this.disconnected = false; watchers.push(this); } observe(el) { this.targets.push(el); } disconnect() { this.disconnected = true; } }
  const doc = { defaultView: { ResizeObserver: FakeRO } };
  const tools = { style: {} }; const bar = { offsetTop: 12, offsetHeight: 62, style: { setProperty() {} }, ownerDocument: doc };
  const canvas = { ownerDocument: doc };
  view.viewportEl = canvas;
  view.contentEl = { querySelector: s => (s === '.vam-map-tools' ? tools : s === '.vam-goal-bar' ? bar : null) };
  view.placeMapTools();
  assert.equal(tools.style.top, '82px');
  assert.equal(watchers.length, 1); assert.deepEqual([...watchers[0].targets], [bar, tools, canvas], 'the bar, the tools and the canvas are watched');
  // Canvas resize (sidebar collapsed): the same placement runs again with the new bar height.
  bar.offsetHeight = 100; watchers[0].fn();
  assert.equal(tools.style.top, '120px', 'a canvas resize re-places the tools');
  // The suggestion card hangs 6px under the bar: the tools go below the card and follow its height.
  const card = { offsetHeight: 200, isConnected: true, hasClass: c => c === 'vam-goal-suggest' };
  view.relevanceBarEl = { querySelector: () => card }; view.placeMapTools();
  assert.equal(tools.style.top, String(12 + 100 + 6 + 200 + 8) + 'px', 'below the card, nothing is covered');
  assert.ok(watchers.at(-1).targets.includes(card) && watchers[0].disconnected, 'the card is watched too (the old watch was dropped)');
  card.offsetHeight = 320; watchers.at(-1).fn();
  assert.equal(tools.style.top, String(12 + 100 + 6 + 320 + 8) + 'px', 'a taller card pushes the tools further down');
  view.relevanceBarEl = { querySelector: () => null }; view.placeMapTools();
  assert.equal(tools.style.top, '120px', 'card closed: back below the bar');
  const live = watchers.at(-1); assert.equal(live.disconnected, false);
  await view.onClose();
  assert.equal(live.disconnected, true, 'closing the view disconnects the observer');
  assert.equal(view.goalBarObserved.length, 0);
});

// ---- Map data sources (P3): toolbar button and panel ----------------------------------------------------------------
const msTree = () => {
  const { TFile, TFolder } = obsidian;
  const folder = new TFolder('Research'), noteA = new TFile('Research/a.md'), noteB = new TFile('Research/b.md'), archived = new TFile('Research/old.md');
  folder.children = [noteA, noteB, archived];
  const other = new TFolder('Other'), single = new TFile('Notes/interview.md'), mapFile = new TFile('Old plan/Map.md');
  const items = new Map([[folder.path, folder], [other.path, other], [single.path, single], [mapFile.path, mapFile]]);
  const frontmatter = new Map([[archived.path, { 'agent-map-node': true, 'topic-state': 'archived' }]]);
  const app = {
    vault: { getAbstractFileByPath: p => items.get(p) ?? null, getAllLoadedFiles: () => [{ path: '/' }, folder, other, single], getMarkdownFiles: () => [noteA, noteB, single], on() { return {}; } },
    metadataCache: { getFileCache: file => (file.path === mapFile.path ? { headings: [{ heading: 'Last year plan' }] } : { frontmatter: frontmatter.get(file.path) }) }
  };
  return { app, items, folder, single, mapFile };
};
const msObsidian = (modals) => ({ ...obsidian, FuzzySuggestModal: class { constructor(app) { this.app = app; modals.push(this); } setPlaceholder(text) { this.placeholder = text; } open() { this.opened = true; } close() { this.onClose?.(); } } });
const msHost = (app, extra = {}) => {
  const log = { added: [], removed: [], closed: [], picker: [], spoken: [], quiet: [], dragEnd: [] };
  const button = dom.element('button');
  let pickerOpen = false;
  return { log, button, host: { app, id: 'panel-1', sources: [], currentMapPath: 'Current/Map.md', mapItems: async () => [], add: (s, quiet) => { log.added.push(s); log.quiet.push(quiet); }, announce: text => log.spoken.push(text), onDragEnd: handler => log.dragEnd.push(handler), remove: s => log.removed.push(s), close: r => log.closed.push(r),
    setPickerOpen: open => { pickerOpen = open; log.picker.push(open); }, isPickerOpen: () => pickerOpen, button: () => button, ...extra } };
};

test('map sources panel: texts, a drop zone and one search button (no three pickers), a row per source, unreadable row, remove label and unchanged hint', () => {
  const modals = [], api = load('ui/map-sources-panel.ts', { obsidian: msObsidian(modals) });
  const tree = msTree();
  const { host, log } = msHost(tree.app, { sources: [{ kind: 'folder', path: 'Research' }, { kind: 'map', path: 'Old plan/Map.md' }, { kind: 'file', path: 'Notes/interview.md' }, { kind: 'file', path: 'Gone/missing.md' }] });
  const parent = dom.element('tools');
  const panel = api.drawMapSourcesPanel(parent, host, null);
  assert.equal(panel.attrs.role, 'dialog'); assert.equal(panel.attrs.id, 'panel-1'); assert.equal(panel.attrs['aria-label'], 'Data sources for this mind map');
  assert.equal(dom.findAll(panel, c => c.tag === 'button' && dom.hasCls(c, 'vam-map-sources-pick')).length, 0, 'the three Select buttons are gone');
  const zone = dom.find(panel, c => dom.hasCls(c, 'vam-map-sources-drop')), sub = dom.find(zone, c => c.cls === 'vam-map-sources-drop-sub');
  assert.equal(dom.find(zone, c => c.cls === 'vam-map-sources-drop-main').text, 'Drag files, folders or mind maps from the left to here'); assert.equal(sub.text, 'Only Markdown, folders or mind maps from this vault');
  assert.equal(zone.attrs['aria-describedby'], sub.attrs.id); assert.ok(zone.attrs['aria-label']); assert.equal(dom.find(zone, c => c.cls === 'vam-map-sources-drop-result').attrs['aria-live'], undefined, 'the result node is replaced by redraws, so the host announcer speaks instead');
  const searches = dom.findAll(panel, c => c.tag === 'button' && dom.hasCls(c, 'vam-map-sources-search'));
  assert.deepEqual(searches.map(b => dom.find(b, c => c.cls === 'vam-map-sources-pick-label').text), ['Search and add…']);
  const rows = dom.findAll(panel, c => dom.hasCls(c, 'vam-map-sources-row'));
  assert.deepEqual(rows.map(r => r.children.filter(c => c.cls === 'vam-map-sources-name').map(c => c.text)[0]), ['Research', 'Last year plan', 'interview.md', 'missing.md']);
  assert.deepEqual(rows.map(r => dom.find(r, c => c.iconName)?.iconName), ['folder-open', 'brain-circuit', 'file-text', 'file-text']);
  assert.deepEqual(rows.map(r => dom.find(r, c => c.cls === 'vam-map-sources-meta')?.text), ['Folder · 2 files', 'Mind map', 'Markdown', 'Unreadable; tasks skip it'], 'archived managed notes are not counted; a missing source says so in place of a count');
  assert.ok(rows[3].hasClass('is-unreadable')); assert.ok(!rows[0].hasClass('is-unreadable'));
  const removes = dom.findAll(panel, c => c.tag === 'button' && (c.cls ?? '').includes('vam-map-sources-remove'));
  assert.equal(removes.length, 4, 'the unreadable row keeps its remove button');
  assert.deepEqual(removes.map(b => b.attrs['aria-label']), ['Remove "Research"', 'Remove "Last year plan"', 'Remove "interview.md"', 'Remove "missing.md"']);
  assert.ok(dom.find(panel, c => c.text === 'When you add a folder, archived VAM notes are excluded. More material takes longer to process. Results cite the source files used.'), 'the hint is the existing reference_time_and_citations_hint');
  removes[1].click(); assert.deepEqual(plain(log.removed), [{ kind: 'map', path: 'Old plan/Map.md' }]);
});
test('map sources panel: Esc closes and refocuses the button; focus leaving closes it except while a picker list is open', () => {
  const api = load('ui/map-sources-panel.ts', { obsidian: msObsidian([]) });
  const { host, log } = msHost(msTree().app);
  const panel = api.drawMapSourcesPanel(dom.element('tools'), host, null);
  const stopped = []; panel.fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() { stopped.push(1); } });
  assert.deepEqual(log.closed, [true]); assert.equal(stopped.length, 1);
  panel.fire('keydown', { key: 'a' }); assert.deepEqual(log.closed, [true]);
  const inside = dom.find(panel, c => c.tag === 'button');
  panel.fire('focusout', { relatedTarget: inside }); panel.fire('focusout', { relatedTarget: null }); panel.fire('focusout', { relatedTarget: host.button() });
  assert.deepEqual(log.closed, [true], 'moving inside, to the button, or to nowhere (a repaint) does not close');
  const outside = dom.element('canvas');
  panel.fire('focusout', { relatedTarget: outside }); assert.deepEqual(log.closed, [true, false], 'focus to an outside element closes it');
  host.setPickerOpen(true); panel.fire('focusout', { relatedTarget: outside }); assert.deepEqual(log.closed, [true, false], 'a picker list that is open does not close it');
});
test('map sources panel: one search list merges maps, folders and notes (never the current map or a map folder); choosing adds; closing returns focus to the search button', async () => {
  const modals = [], api = load('ui/map-sources-panel.ts', { obsidian: msObsidian(modals) });
  const tree = msTree();
  const items = [{ title: 'Current', mapPath: 'Current/Map.md', topicCount: 2, modified: 5, folder: '' }, { title: 'Last year plan', mapPath: 'Old plan/Map.md', topicCount: 3, modified: 9, folder: 'Old' }, { title: 'Newer', mapPath: 'Newer/Map.md', topicCount: 1, modified: 20, folder: '' }];
  const { host, log } = msHost(tree.app, { mapItems: async () => items });
  const panel = api.drawMapSourcesPanel(dom.element('tools'), host, null);
  const search = dom.find(panel, c => c.tag === 'button' && dom.hasCls(c, 'vam-map-sources-search'));
  search.click(); await dom.tick();
  const modal = modals.at(-1);
  assert.ok(modal.opened); assert.equal(modal.placeholder, 'Type a mind map, folder or Markdown name…'); assert.deepEqual(log.picker, [true]);
  assert.deepEqual(plain(modal.getItems().map(i => [i.kind, i.path])), [['map', 'Newer/Map.md'], ['map', 'Old plan/Map.md'], ['folder', 'Other'], ['folder', 'Research'], ['file', 'Notes/interview.md'], ['file', 'Research/a.md'], ['file', 'Research/b.md']], 'maps first; the current map, map folders and Map.md files are not offered twice');
  const row = dom.element('div'); modal.renderSuggestion({ item: modal.getItems()[2] }, row);
  assert.equal(dom.find(row, c => c.cls === 'vam-map-sources-kind').text, 'Folder', 'each row names its kind');
  modal.close(); assert.deepEqual(log.picker, [true, false]); assert.equal(dom.focusedNow(), search, 'focus returns to the button that opened the list');
  modal.onChooseItem(modal.getItems()[1]); await dom.tick(); assert.deepEqual(plain(log.added), [{ kind: 'map', path: 'Old plan/Map.md' }]);
  modal.onChooseItem(modal.getItems()[3]); await dom.tick(); assert.deepEqual(plain(log.added.at(-1)), { kind: 'folder', path: 'Research' });
  modal.onChooseItem(modal.getItems()[4]); await dom.tick(); assert.deepEqual(plain(log.added.at(-1)), { kind: 'file', path: 'Notes/interview.md' });
  assert.equal(dom.findAll(panel, c => c.tag === 'input' && c.type === 'file').length, 0, 'no operating-system file dialog');
});
test('map sources panel: focus after a redraw goes to the search button, or to the next row by stored index', () => {
  const api = load('ui/map-sources-panel.ts', { obsidian: msObsidian([]) });
  const tree = msTree();
  const sources = [{ kind: 'folder', path: 'Research' }, { kind: 'file', path: 'Notes/interview.md' }];
  const { host } = msHost(tree.app, { sources });
  api.drawMapSourcesPanel(dom.element('tools'), host, { remove: 1 });
  assert.equal(dom.focusedNow().attrs['aria-label'], 'Remove "interview.md"');
  api.drawMapSourcesPanel(dom.element('tools'), host, { remove: 2 });
  assert.equal(dom.focusedNow().children[1].text, 'Search and add…', 'no next row: the search button');
  api.drawMapSourcesPanel(dom.element('tools'), host, { search: true });
  assert.equal(dom.focusedNow().children[1].text, 'Search and add…');
});

// Drop zone. The zone's drop handler is async (it reads the other maps first), so every drop is followed by a tick.
const dzTree = () => {
  const { TFile, TFolder } = obsidian;
  const tree = msTree();
  const add = item => { tree.items.set(item.path, item); return item; };
  const plan = add(new TFolder('Old plan')), current = add(new TFolder('Current')), currentMap = add(new TFile('Current/Map.md')), pdf = add(new TFile('Notes/quote.pdf')), image = add(new TFile('Notes/pic.png'));
  plan.children = [tree.mapFile]; current.children = [currentMap];
  return { ...tree, plan, current, currentMap, pdf, image };
};
const dzSetup = (extra = {}, tree = dzTree()) => {
  const api = load('ui/map-sources-panel.ts', { obsidian: msObsidian([]) });
  const items = [{ title: 'Last year plan', mapPath: 'Old plan/Map.md', topicCount: 3, modified: 9, folder: 'Old' }, { title: 'Current', mapPath: 'Current/Map.md', topicCount: 1, modified: 5, folder: '' }];
  const base = msHost(tree.app, { mapItems: async () => items, ...extra });
  const panel = api.drawMapSourcesPanel(dom.element('tools'), base.host, null);
  const zone = dom.find(panel, c => dom.hasCls(c, 'vam-map-sources-drop'));
  const lines = () => dom.findAll(zone, c => c.cls === 'vam-map-sources-drop-line').map(c => c.text);
  const drop = async (data) => { zone.fire('drop', { dataTransfer: data }); await dom.tick(); };
  const dragging = (...nodes) => { tree.app.dragManager = { draggable: nodes.length === 1 ? { type: nodes[0].children ? 'folder' : 'file', file: nodes[0] } : { type: 'files', files: nodes } }; return { types: ['text/plain'], files: [], getData: () => '' }; };
  return { ...base, ...tree, api, panel, zone, lines, drop, dragging };
};
test('drop zone: the explorer drag becomes a file, a folder, or (for a map or a map folder) a map; hover states and names', async () => {
  const dz = dzSetup();
  {
    const over = dz.dragging(dz.single); let prevented = 0;
    dz.zone.fire('dragenter', { dataTransfer: over, preventDefault() { prevented++; } });
    assert.ok(dz.zone.hasClass('is-dragover')); assert.equal(dom.find(dz.zone, c => c.cls === 'vam-map-sources-drop-main').text, 'Release to add'); assert.equal(dom.find(dz.zone, c => c.cls === 'vam-map-sources-drop-sub').text, 'interview.md'); assert.equal(prevented, 1, 'dragenter allows the drop');
    dz.zone.fire('dragleave', { relatedTarget: dom.find(dz.zone, c => c.cls === 'vam-map-sources-drop-main') }); assert.ok(dz.zone.hasClass('is-dragover'), 'moving onto a child is not leaving');
    dz.zone.fire('dragleave', { relatedTarget: null }); assert.ok(!dz.zone.hasClass('is-dragover'));
  }
  await dz.drop(dz.dragging(dz.single)); await dz.drop(dz.dragging(dz.folder)); await dz.drop(dz.dragging(dz.mapFile)); await dz.drop(dz.dragging(dz.plan));
  assert.deepEqual(plain(dz.log.added), [{ kind: 'file', path: 'Notes/interview.md' }, { kind: 'folder', path: 'Research' }, { kind: 'map', path: 'Old plan/Map.md' }, { kind: 'map', path: 'Old plan/Map.md' }], 'a map folder is stored as the map, not as a folder');
  assert.ok(!dz.zone.hasClass('is-dragover'));
});
test('drop zone fallback: without app.dragManager the text/plain obsidian:// link and a plain vault path resolve through the vault', async () => {
  const dz = dzSetup();
  const text = value => ({ types: ['text/plain'], files: [], getData: type => (type === 'text/plain' ? value : '') });
  await dz.drop(text('obsidian://open?vault=V&file=Notes%2Finterview')); await dz.drop(text('Research'));
  assert.deepEqual(plain(dz.log.added), [{ kind: 'file', path: 'Notes/interview.md' }, { kind: 'folder', path: 'Research' }]);
  await dz.drop(text('obsidian://open?vault=V&file=Elsewhere%2Fnope')); assert.equal(dz.log.added.length, 2, 'a path that is not in the vault is not added'); assert.deepEqual(dz.lines(), ['"nope": Only items in this vault can be added']);
});
test('drop zone negative: a file dragged in from outside the vault (types only Files) is not added and says why', async () => {
  const dz = dzSetup();
  await dz.drop({ types: ['Files'], files: [{ name: 'desktop-notes.md' }], getData: () => '' });
  assert.deepEqual(plain(dz.log.added), []); assert.ok(dz.zone.hasClass('is-rejected'));
  assert.deepEqual(dz.lines(), ['"desktop-notes.md": Only items in this vault can be added']);
  assert.equal(dom.find(dz.zone, c => c.cls === 'vam-map-sources-drop-main').text, '1 not added');
});
test('drop zone negative: a pdf and an image are not added and say only Markdown, folders or mind maps', async () => {
  const dz = dzSetup();
  await dz.drop(dz.dragging(dz.pdf, dz.image));
  assert.deepEqual(plain(dz.log.added), []); assert.ok(dz.zone.hasClass('is-rejected'));
  assert.deepEqual(dz.lines(), ['"quote.pdf": Only Markdown, folders or mind maps can be added', '"pic.png": Only Markdown, folders or mind maps can be added']);
});
test('drop zone negative: the current map (its Map.md or its folder) is not added', async () => {
  const dz = dzSetup();
  await dz.drop(dz.dragging(dz.currentMap)); await dz.drop(dz.dragging(dz.current));
  assert.deepEqual(plain(dz.log.added), []); assert.deepEqual(dz.lines(), ['"Current": The current mind map cannot be added']);
});
test('drop zone negative: one valid and one invalid item together add the valid one and list only the invalid one', async () => {
  const dz = dzSetup();
  await dz.drop(dz.dragging(dz.single, dz.pdf));
  assert.deepEqual(plain(dz.log.added), [{ kind: 'file', path: 'Notes/interview.md' }]);
  assert.deepEqual(dz.lines(), ['"quote.pdf": Only Markdown, folders or mind maps can be added']); assert.equal(dom.find(dz.zone, c => c.cls === 'vam-map-sources-drop-main').text, '1 not added');
  await dz.drop(dz.dragging(dz.folder)); assert.deepEqual(dz.lines(), [], 'the message goes with the next drop');
});
test('drop zone: Esc/cancel (dragend without dragleave) clears the drag-over state', async () => {
  const dz = dzSetup();
  assert.equal(dz.log.dragEnd.length, 1, 'one document-level dragend listener is registered through the host');
  dz.zone.fire('dragenter', { dataTransfer: dz.dragging(dz.single) }); assert.ok(dz.zone.hasClass('is-dragover'));
  dz.log.dragEnd[0](); assert.ok(!dz.zone.hasClass('is-dragover')); assert.equal(dom.find(dz.zone, c => c.cls === 'vam-map-sources-drop-main').text, 'Drag files, folders or mind maps from the left to here');
});
test('drop zone negative: an already added source is not added again; one dropped twice in a batch is added once', async () => {
  const dz = dzSetup({ sources: [{ kind: 'file', path: 'Notes/interview.md' }] });
  await dz.drop(dz.dragging(dz.single));
  assert.deepEqual(plain(dz.log.added), []); assert.deepEqual(dz.lines(), ['"interview.md" is already added']);
  await dz.drop(dz.dragging(dz.folder, dz.folder)); assert.deepEqual(plain(dz.log.added), [{ kind: 'folder', path: 'Research' }]);
});
test('drop zone: a drop that adds says so in the result area, next to the rejection lines of a mixed drop; a new hover hides both', async () => {
  const dz = dzSetup();
  const ok = () => dom.findAll(dz.zone, c => c.cls === 'vam-map-sources-drop-ok').map(c => c.text);
  await dz.drop(dz.dragging(dz.single)); assert.deepEqual(ok(), ['Added "interview.md"']); assert.ok(!dz.zone.hasClass('is-rejected'));
  await dz.drop(dz.dragging(dz.single, dz.folder, dz.pdf)); assert.deepEqual(ok(), ['Added 2 items']); assert.deepEqual(dz.lines(), ['"quote.pdf": Only Markdown, folders or mind maps can be added']);
  assert.deepEqual(dz.log.spoken, ['Added "interview.md"', 'Added 2 items "quote.pdf": Only Markdown, folders or mind maps can be added'], 'one announcement per drop, success and reasons together');
  assert.ok(dz.log.quiet.every(Boolean), 'the per-item announcements are suppressed for drops');
  dz.zone.fire('dragenter', { dataTransfer: dz.dragging(dz.single) });
  assert.deepEqual(dz.lines(), [], 'the previous rejection lines are hidden while a new drag hovers'); assert.deepEqual(ok(), []);
  await dz.drop(dz.dragging(dz.mapFile)); assert.deepEqual(dz.lines(), []); assert.deepEqual(ok(), ['Added "Last year plan"']);
});
test('drop zone styles: the rejected zone is a light warning tint, not the error fill, and its headline never uses the fill variable', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const rule = selector => css.match(new RegExp('^' + selector.replace(/[.]/g, '\\.') + ' \\{([^}]*)\\}', 'm'))[1];
  const zoneRule = rule('.vam-map-sources-drop.is-rejected'), headRule = rule('.vam-map-sources-drop.is-rejected .vam-map-sources-drop-main');
  assert.doesNotMatch(zoneRule + headRule, /background-modifier-error|--text-error/);
  assert.match(zoneRule, /background: rgba\(var\(--color-orange-rgb\), 0\.\d+\)/);
  const fill = zoneRule.match(/background: ([^;]+);/)[1], text = headRule.match(/color: ([^;]+);/)[1];
  assert.notEqual(fill, text); assert.match(text, /var\(--text-normal\)/, 'the headline is mixed toward the text colour so it stays readable in both themes');
});
test('drop zone: added rows come first and flash; the rejection survives the redraw an add causes; the zone and rows are readable', async () => {
  const dz = dzSetup({ sources: [{ kind: 'folder', path: 'Research' }] });
  const session = { rejected: [], fresh: [], added: '' };
  const host = { ...dz.host, session, sources: [{ kind: 'folder', path: 'Research' }], add: s => { dz.host.add(s); host.sources = [...host.sources, s]; } };
  let panel = dz.api.drawMapSourcesPanel(dom.element('tools'), host, null);
  dom.find(panel, c => dom.hasCls(c, 'vam-map-sources-drop')).fire('drop', { dataTransfer: dz.dragging(dz.single, dz.pdf) }); await dom.tick();
  panel = dz.api.drawMapSourcesPanel(dom.element('tools'), host, null);
  const names = dom.findAll(panel, c => dom.hasCls(c, 'vam-map-sources-name')).map(c => c.text);
  assert.deepEqual(names, ['interview.md', 'Research'], 'the new row is first');
  assert.ok(dom.findAll(panel, c => dom.hasCls(c, 'vam-map-sources-row'))[0].hasClass('is-new'));
  assert.deepEqual(dom.findAll(panel, c => c.cls === 'vam-map-sources-drop-line').map(c => c.text), ['"quote.pdf": Only Markdown, folders or mind maps can be added'], 'still shown after the redraw');
  const removers = dom.findAll(panel, c => (c.cls ?? '').includes('vam-map-sources-remove'));
  removers[1].click(); assert.deepEqual(plain(dz.log.removed), [{ kind: 'folder', path: 'Research' }]);
});
test('drop zone: the panel does not close when focus or a press moves to a draggable explorer row', () => {
  const dz = dzSetup();
  const row = dom.element('div'); row.closest = selector => (selector === '[draggable="true"]' ? row : null);
  dz.panel.fire('focusout', { relatedTarget: row }); assert.deepEqual(dz.log.closed, []);
  const plainEl = dom.element('canvas'); plainEl.closest = () => null;
  dz.panel.fire('focusout', { relatedTarget: plainEl }); assert.deepEqual(dz.log.closed, [false]);
  assert.equal(dz.api.isDragSourceTarget(row), true); assert.equal(dz.api.isDragSourceTarget(plainEl), false); assert.equal(dz.api.isDragSourceTarget(null), false);
});

// The view: button label, ⚠, aria, write path, duplicate no-op, repaint and visibility.
function msViewFixture({ aim = false, nodes = 1, stored = [], items = [] } = {}) {
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, setTooltip() {} } }, { createSvg: tag => ({ tag, attrs: {}, children: [], setAttribute(n, v) { this.attrs[n] = v; }, appendChild(c) { this.children.push(c); } }) });
  const tree = msTree();
  const state = { stored: [...stored], writes: [], notices: [] };
  const plugin = { settings: { ...DEFAULT_SETTINGS }, pendingSuggestions: new Map(), expansionBatches: new Map(), relevanceGrades: new Map(), mutate: async work => work(),
    repo: { readMapSources: async () => state.stored.map(s => ({ ...s })), writeMapSources: async (p, next) => { state.writes.push([p, plain(next)]); state.stored = plain(next); }, mapSwitcherItems: async () => items } };
  const view = new VisualAgentMapView({ app: tree.app }, plugin);
  view.path = 'Current/Map.md'; view.map = map(Array.from({ length: nodes }, (_, i) => node(`n${i}`))); if (aim) view.map.aim = { runs: [] };
  view.mapSources = plain(stored); view.announcer = dom.element('status');
  const tools = dom.element('tools');
  const draw = () => { tools.children = []; view.renderMapTools(tools); return tools; };
  return { view, tree, state, tools, draw, plugin };
}
const msButton = tools => dom.find(tools, c => c.tag === 'button' && (c.cls ?? '').includes('vam-sources-button'));
const msLabel = tools => dom.find(msButton(tools), c => c.cls === 'vam-sources-button-label').text;
integrationTest('map sources toolbar: the button follows the select icon (the goal now lives in the goal bar), reads 資料來源 with and without a count, and is absent on AIM and empty maps', () => {
  const none = msViewFixture(); none.draw();
  const buttons = none.tools.children.filter(c => c.tag === 'button');
  assert.equal(buttons.at(-1), msButton(none.tools), 'right after the select icon');
  assert.ok(buttons.at(-2).cls.includes('vam-tools-select'));
  assert.equal(buttons.some(b => (b.cls ?? '').includes('vam-relevance-goal')), false, 'no goal button in the toolbar any more');
  assert.equal(msLabel(none.tools), 'Data sources');
  const three = msViewFixture({ stored: [{ kind: 'folder', path: 'Research' }, { kind: 'file', path: 'Notes/interview.md' }, { kind: 'map', path: 'Old plan/Map.md' }] }); three.draw();
  assert.equal(msLabel(three.tools), 'Data sources · 3'); assert.equal(dom.find(msButton(three.tools), c => c.iconName === 'alert-triangle'), undefined);
  assert.equal(msButton(three.tools).attrs['aria-haspopup'], 'dialog'); assert.equal(msButton(three.tools).attrs['aria-expanded'], 'false'); assert.ok(msButton(three.tools).attrs['aria-controls']);
  assert.equal(msViewFixture({ aim: true }).draw().children.length, 0, 'no tools at all on an AIM map');
  const empty = msViewFixture({ nodes: 0 }).draw();
  assert.equal(msButton(empty), undefined, 'an empty map has no data sources button');
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(source, /private renderMapTools\(tools: HTMLElement\): void \{\s*if \(!this\.map \|\| this\.map\.aim\) return;/);
  const hidden = source.slice(source.indexOf('private renderHiddenAimMapTools'), source.indexOf('private renderHiddenAimMapTools') + 1500);
  assert.equal(hidden.includes('renderMapSourcesControl'), false, 'the hidden-AIM tools do not draw it');
});
integrationTest('map sources toolbar: an unreadable source puts ⚠ before the label and an aria-description, keeping the count', () => {
  const fx = msViewFixture({ stored: [{ kind: 'folder', path: 'Research' }, { kind: 'file', path: 'Gone/missing.md' }, { kind: 'file', path: 'Gone/two.md' }] }); fx.draw();
  const button = msButton(fx.tools);
  assert.equal(button.children[0].children.length === 0 && button.children[0].iconName, 'alert-triangle'); assert.equal(button.children[1].text, 'Data sources · 3', 'the warning comes before the label; the count is unchanged');
  assert.equal(button.attrs['aria-description'], '2 unreadable'); assert.ok(button.hasClass('has-unreadable'));
  button.removeAttribute = name => { delete button.attrs[name]; };
  fx.view.mapSources = [{ kind: 'folder', path: 'Research' }]; fx.view.paintMapSourcesButton();
  assert.equal(dom.find(button, c => c.iconName === 'alert-triangle'), undefined); assert.equal(button.attrs['aria-description'], undefined);
});
// Like a browser: moving focus fires focusout (with relatedTarget) on the element that held it. Applied to every element created later.
const withRealFocus = el => {
  const focus = el.focus.bind(el), child = el.child.bind(el);
  el.focus = () => { const previous = dom.focusedNow(); focus(); if (previous && previous !== el) previous.fire('focusout', { relatedTarget: el }); };
  el.child = (...args) => withRealFocus(child(...args));
  return el;
};
integrationTest('map sources panel (B1 counterexample): opening by keyboard while the button already has focus keeps it open, expanded, and redrawn by an add', async () => {
  const fx = msViewFixture(); withRealFocus(fx.tools); fx.draw();
  const button = () => msButton(fx.tools), panel = () => dom.find(fx.tools, c => c.cls === 'vam-map-sources-panel');
  withRealFocus(button()); button().focus();
  button().click();
  assert.ok(panel(), 'the panel is visible'); assert.equal(button().attrs['aria-expanded'], 'true'); assert.equal(fx.view.mapSourcesOpen, true);
  const file = { kind: 'file', path: 'Notes/interview.md' };
  fx.view.changeMapSources('Current/Map.md', 'add', file); await dom.tick();
  assert.ok(dom.find(panel(), c => c.text === 'interview.md'), 'the add redraws the open list');
  button().click(); assert.equal(panel(), undefined, 'the next press closes instead of reopening'); assert.equal(button().attrs['aria-expanded'], 'false');
});
integrationTest('map sources panel in the view: a mixed drop produces exactly one announcement (success and reasons), with no per-item announcements and no document dragend leak', async () => {
  const fx = msViewFixture(); fx.draw();
  const { TFile } = obsidian, pdf = new TFile('Notes/quote.pdf'); fx.tree.items.set(pdf.path, pdf);
  const spoken = []; const announcer = fx.view.announcer, set = announcer.setText.bind(announcer); announcer.setText = text => { spoken.push(text); set(text); };
  fx.tree.app.dragManager = { draggable: { type: 'files', files: [fx.tree.single, fx.tree.folder, pdf] } };
  const button = msButton(fx.tools); button.click();
  const zone = dom.find(fx.tools, c => dom.hasCls(c, 'vam-map-sources-drop'));
  zone.fire('drop', { dataTransfer: { types: ['text/plain'], files: [], getData: () => '' } }); await dom.tick(); await dom.tick();
  assert.equal(fx.state.writes.length, 2, 'both accepted items were written');
  assert.deepEqual(spoken, ['Added 2 items "quote.pdf": Only Markdown, folders or mind maps can be added'], 'exactly one announcement with both parts');
  button.click();
});
integrationTest('map sources panel in the view: open, add writes only through the repository, a duplicate add writes nothing, remove updates the label, Esc and the button close it', async () => {
  const fx = msViewFixture(); fx.draw();
  const button = () => msButton(fx.tools), panel = () => dom.find(fx.tools, c => c.cls === 'vam-map-sources-panel');
  assert.equal(panel(), undefined);
  button().click(); assert.ok(panel()); assert.equal(button().attrs['aria-expanded'], 'true'); assert.equal(panel().attrs.id, button().attrs['aria-controls']);
  const file = { kind: 'file', path: 'Notes/interview.md' };
  fx.view.changeMapSources('Current/Map.md', 'add', file); await dom.tick();
  assert.deepEqual(fx.state.writes, [['Current/Map.md', [file]]]); assert.equal(msLabel(fx.tools), 'Data sources · 1');
  assert.ok(dom.find(panel(), c => c.text === 'interview.md'), 'the open panel shows the new row'); assert.equal(fx.view.announcer.text, 'Added "interview.md"');
  fx.view.changeMapSources('Current/Map.md', 'add', { ...file }); await dom.tick();
  assert.equal(fx.state.writes.length, 1, 'adding the same kind and path again writes nothing'); assert.equal(fx.view.announcer.text, '"interview.md" is already added');
  fx.view.changeMapSources('Current/Map.md', 'remove', file); await dom.tick();
  assert.equal(fx.state.writes.length, 2); assert.deepEqual(fx.state.writes[1], ['Current/Map.md', []]); assert.equal(msLabel(fx.tools), 'Data sources'); assert.equal(fx.view.announcer.text, 'Removed interview.md');
  assert.equal(dom.focusedNow().children[1].text, 'Search and add…', 'removing the last row moves focus to the search button');
  panel().fire('keydown', { key: 'Escape' }); assert.equal(panel(), undefined); assert.equal(button().attrs['aria-expanded'], 'false'); assert.equal(dom.focusedNow(), button());
  button().click(); assert.ok(panel()); button().click(); assert.equal(panel(), undefined, 'the button toggles it');
  button().click(); fx.draw(); assert.ok(panel(), 'a repaint keeps an open panel');
  button().fire('focusout', { relatedTarget: dom.element('canvas') }); assert.equal(panel(), undefined, 'focus leaving the button for an outside element closes it');
  fx.view.changeMapSources('Other/Map.md', 'add', file); fx.view.path = 'Other/Map.md'; await dom.tick(); assert.equal(fx.state.writes.length, 2, 'a change for a map that is no longer open is dropped');
});
integrationTest('map sources in the view: deleting a source note repaints the button with ⚠ and the panel row as unreadable', () => {
  const fx = msViewFixture({ stored: [{ kind: 'file', path: 'Notes/interview.md' }] }); fx.draw();
  msButton(fx.tools).click();
  assert.equal(dom.find(fx.tools, c => c.cls === 'vam-map-sources-meta').text, 'Markdown');
  fx.tree.items.delete('Notes/interview.md'); fx.view.refreshMapSourcesUi();
  assert.ok(dom.find(msButton(fx.tools), c => c.iconName === 'alert-triangle')); assert.equal(dom.find(fx.tools, c => c.cls === 'vam-map-sources-meta').text, 'Unreadable; tasks skip it');
  assert.ok(dom.find(fx.tools, c => (c.cls ?? '').includes('vam-map-sources-remove')), 'the unreadable row keeps Remove');
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(source, /this\.registerEvent\(vault\.on\("delete"[\s\S]*this\.registerEvent\(vault\.on\("rename"/);
});
test('map sources: the removed task-dialog picker, its styles and its dead keys are gone', () => {
  assert.equal(fs.existsSync(path.join(root, 'ui', ['reference', 'picker'].join('-') + '.ts')), false);
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.equal(/\.vam-reference-(picker|actions|action|group-row|feedback|cancel|remove)\b/.test(css), false);
  assert.match(css, /\.vam-map-sources-panel \{[^}]*max-width: min\(440px/); assert.match(css, /\.vam-map-sources-drop \{[^}]*border: 2px dashed/); assert.match(css, /\.vam-map-sources-drop\.is-rejected \{/); assert.equal(/收斂都會/.test(fs.readFileSync(path.join(root, 'i18n/zh-TW.ts'), 'utf8')), false);
  const zh = fs.readFileSync(path.join(root, 'i18n/zh-TW.ts'), 'utf8');
  assert.match(zh, /"ui\.map_sources_title": "這張心智圖的資料來源"/); assert.match(zh, /"ui\.map_sources_unreadable_description_0": "\{0\} 份讀不到"/);
  assert.equal(/"ui\.map_sources_[^"]*": "[^"]*地圖/.test(zh), false);
});
