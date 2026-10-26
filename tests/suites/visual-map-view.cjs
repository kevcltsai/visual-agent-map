const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, integrationTest, root, load, core, node, map, plain, obsidian, DEFAULT_SETTINGS, until } = require('../support.cjs');
const dom = require('../support-dom.cjs');
integrationTest('node plus adds a child without opening a duplicate right-click menu', () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian }, { requestAnimationFrame: run => { run(); return 1; }, cancelAnimationFrame() {} });
  const events = new Map(), buttons = [];
  const element = tag => ({ tag, children: [], dataset: {}, style: {},
    createDiv(options) { const child = element('div'); child.cls = options?.cls ?? options; this.children.push(child); return child; },
    createEl(name, options) { const child = element(name); child.text = options?.text; this.children.push(child); if (name === 'button') buttons.push(child); return child; },
    createSpan(options) { const child = element('span'); child.text = options?.text; this.children.push(child); return child; },
    setAttr(name, value) { this[name] = value; }, addClass(name) { this.cls = name; }, toggleClass(name, on) { this.toggled = [name, on]; }, setPointerCapture() {},
    addEventListener(name, handler) { events.set(`${tag}:${name}`, handler); if (tag === 'button') this.click = handler; }, removeEventListener() {}
  });
  const topic = node('parent');
  let detailsShown = false;
  const view = new VisualAgentMapView({ app: {} }, { pendingSuggestions: new Map([['parent.md', [{ title: 'Idea', task: 'Investigate', contribution: '' }]]]), expansionBatches: new Map(), detailsShown: () => detailsShown, setOutlineActive() {} });
  view.stageEl = element('stage'); view.map = map([topic]);
  view.notes = new Map([[topic.id, { title: 'Parent', summary: '', status: 'completed' }]]);
  view.render = () => {};
  let added = 0, opened = [], details = [], next = [], renders = 0;
  view.addNode = () => { added++; }; view.enqueue = work => work(); view.openNodePanel = (topic, mode) => opened.push([topic.id, mode]);
  view.openDetails = topic => details.push(topic.id); view.openNextStep = topic => next.push(topic.id); view.render = () => { renders++; };
  view.renderNode(topic);
  const plus = buttons.find(button => button.text === '+');
  assert.equal(plus['aria-label'], 'Add subtopic manually');
  plus.click({ stopPropagation() {} });
  assert.equal(added, 1);
  const badge = buttons.find(button => button.text === 'View 1 expansion suggestions');
  badge.click({ stopPropagation() {} });
  buttons.find(button => button.text === 'AI explore').click({ stopPropagation() {} });
  buttons.find(button => button['aria-label'] === 'Structure and links').click({ stopPropagation() {} });
  assert.deepEqual(opened, [[topic.id, 'proposals'], [topic.id, 'structure']]); assert.deepEqual(next, [topic.id]);
  assert.equal(view.selected, null);
  events.get('div:click')({ target: { closest: () => null }, metaKey: false, ctrlKey: false });
  assert.equal(view.selected, topic.id); assert.equal(renders, 0, 'a click repaints the card in place instead of rendering'); assert.deepEqual(details, [], 'a click selects without opening the sidebar note');
  view.selected = null; renders = 0; details.length = 0;
  events.get('div:keydown')({ key: 'Enter', target: view.stageEl.children[0] });
  assert.equal(view.selected, topic.id); assert.equal(renders, 0); assert.deepEqual(details, [topic.id]);
  view.selected = null; renders = 0; details.length = 0;
  view.mapChange = async () => {}; view.drawEdges = () => {};
  events.get('div:pointerdown')({ target: { closest: () => null }, button: 0, pointerId: 2, clientX: 10, clientY: 10 });
  events.get('div:pointermove')({ clientX: 14, clientY: 10 });
  events.get('div:pointerup')({ type: 'pointerup' });
  events.get('div:click')({ target: { closest: () => null }, metaKey: false, ctrlKey: false });
  assert.equal(view.selected, null, 'a >3px pointer movement is treated as a drag and its follow-on click is suppressed');
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
  assert.ok(ordinaryButtons.some(button => button.text === 'Structure' && button['aria-label'] === 'Structure and links'));
  assert.ok(ordinaryButtons.some(button => button.text === 'Rename'), 'the rename tool is labelled Rename');
  assert.ok(ordinaryButtons.some(button => button.text === 'AI explore'), 'every card shows a labelled AI explore action');
  assert.ok(ordinaryButtons.some(button => button.text === 'Details' && button['aria-label'] === 'Open details in right sidebar'));
  assert.ok(ordinaryButtons.some(button => button['aria-label'] === 'Add subtopic manually'));
  const aim = map([topic]); aim.aim = { version: 1, branches: [], runs: [], pendingCommits: [] };
  const aimButtons = render(aim);
  for (const label of ['AI explore', 'Structure', 'Rename']) assert.equal(aimButtons.some(button => button.text === label), false, `${label} is hidden in AIM`);
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
  assert.match(fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8'), /if \(!aimMode\) \{\s*const integrate = this\.button\(\s*tools/);
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
  view.multiSelected = new Set(['root']);
  assert.equal(await view.revealPath('leaf.md'), true);
  assert.equal(root.collapsed, false); assert.equal(child.collapsed, false);
  assert.equal(view.selected, leaf.id); assert.equal(view.multiSelected.size, 0); assert.ok(renders > 0);
  assert.deepEqual(plain(doc.viewport), { x: 400 - 1140, y: 300 - 480, zoom: 1 });
  view.integrationMode = true; view.multiSelected = new Set(['root']); view.selected = null;
  await view.revealPath('root.md');
  assert.deepEqual([...view.multiSelected], ['root'], 'topic selection is kept'); assert.equal(view.selected, null);
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
  const plugin = { settings: { codexUsageNoticeSeen: true, claudeUsageNoticeSeen: true, models: 'gpt-test', cliReasoning: 'low', language: 'en' }, aiReadyForModel: async model => { checkedModels.push(model); return true; }, confirmAiUsage: async (model, run) => { checkedModels.push(model); await run(); return true; }, saveSettings: async () => {}, activeTasks: new Map(), availableModels: () => ['gpt-test'], modelLabel: model => model, modelDiscoveryState: modelState, subscribeModelDiscovery: () => () => {}, refreshModelDiscovery: async provider => modelState(provider), sources: { currentTopicId: 'current', currentLabel: 'Current topic included', synthesisLabel: 'Current topic and child topics included', synthesisTopics: ['Child A', 'Child B'], topics: async () => [], readTopic: async () => [] } };
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
  const sourceDisclosures = all(modal.contentEl, item => item.cls.includes('vam-next-source-details'));
  assert.equal(sourceDisclosures.length, 1, 'one data-source picker serves every step');
  const [sources] = sourceDisclosures;
  assert.equal(sources.open, false);
  assert.ok(sources.children[0].children[0].children[1].text.includes('0 Markdown files'));
  const outputLanguage = find(modal.contentEl, item => item['aria-label'] === 'Answer language for this task');
  assert.equal(outputLanguage.value, 'same-as-input');
  outputLanguage.value = 'zh-TW';
  assert.equal(plugin.settings.language, 'en'); assert.equal(activeCard(), 0);
  const requirements = find(modal.contentEl, item => item.tag === 'textarea');
  assert.equal(requirements.value, '');
  assert.equal(all(modal.contentEl, item => item.tag === 'textarea').length, 1);
  assert.equal(button(modal.contentEl, 'Save instructions'), undefined);
  requirements.value = 'Only this run';
  // The data sources keep only local files: no web or image choice (the AI mode decides both).
  assert.equal(all(sources, item => item.tag === 'input' && item.type === 'checkbox').length, 0);
  assert.equal(find(sources, item => item.text === 'Search for image references'), undefined);
  assert.equal(find(sources, item => item.text === 'Allow web search'), undefined);
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
  assert.equal(all(sources, item => item.tag === 'input' && item.type === 'file').length, 2);
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
  assert.equal(began, 0); assert.equal(button(firstUse.contentEl, 'Understand and run'), undefined); assert.equal(closed, 3);
  button(firstUse.modalEl, 'Confirm research task').click(); await tick();
  assert.equal(began, 1); assert.equal(acknowledged, 1); assert.equal(closed, 4);
  let pendingCalls = 0;
  let pendingConfirmed = false;
  const pendingPlugin = { settings: { codexUsageNoticeSeen: false }, aiReadyForModel: async () => true, confirmAiUsage: async (_model, run) => { if (!pendingConfirmed) { pendingConfirmed = true; return false; } await run(); return true; }, saveSettings: async () => {} };
  const pendingModal = new NextStepModal({}, 'Parent', 1, 1, pendingPlugin, async () => {}, async (_options, _direction, found) => { pendingCalls++; found([{ title: 'Existing', task: 'Research', contribution: '', parentTitle: '' }], async () => {}); }, async () => {});
  pendingModal.onOpen(); find(pendingModal.contentEl, item => item.cls === 'vam-next-cards').children[1].click();
  button(pendingModal.modalEl, 'Review AI subtopic suggestions (1)').click(); await tick();
  assert.equal(pendingCalls, 1); assert.equal(button(pendingModal.contentEl, 'Understand and run'), undefined);
  button(pendingModal.contentEl, 'Create subtopics (1)').click(); await tick();
  assert.equal(pendingModal.closed, true, 'creating the reviewed subtopics ends the guided expansion'); closed -= 1;
  assert.equal(pendingCalls, 1); assert.equal(button(pendingModal.contentEl, 'Understand and run'), undefined);
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
  view.showHoverCard({...element(),dataset:{nodeId:'a'}},{title:'Topic',preview:markdown});
  assert.equal(rendered.markdown,markdown);assert.equal(rendered.path,'a.md');assert.deepEqual(created,[['strong','Topic']]);
});
test('multi research modal: no mode, network, image or depth fields; each row shows its mode; the request carries no mode; immediate close on start', () => {
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
  const requests = []; const templates = [{ id: 'standard', name: 'Standard' }, { id: 'A', name: 'Alpha template' }];
  let models = [], changed = null, unwatched = 0;
  const live = { list: () => models, watch: fn => { changed = fn; return () => { unwatched++; }; } };
  const modal = new mod.MultiResearchModal({}, ['Alpha', 'Beta'], live, templates, request => requests.push(request), [], undefined, {}, ['quick', 'standard']); modal.open();
  assert.ok(find(modal.contentEl, i => i.text === 'Alpha')); assert.ok(find(modal.contentEl, i => i.text === 'Beta'));
  // D-2026-10-233 / D-2026-10-247: no web, image or depth choice; the list says which mode each topic runs in.
  assert.equal(find(modal.contentEl, i => i.tag === 'input' && i.type === 'checkbox'), undefined);
  assert.equal(find(modal.contentEl, i => i.text === 'Search for image references' || i.text === 'Allow web search'), undefined);
  const radios = (root) => { const out = []; const visit = n => { if (n.type === 'radio' || (n.attrs && n.attrs.role === 'radio')) out.push(n); n.children.forEach(visit); }; visit(root); return out; };
  assert.equal(radios(modal.contentEl).length, 0, 'no depth or mode radio');
  const rows = dom.findAll(modal.contentEl, i => i.cls === 'vam-multi-research-topic').map(row => row.children.map(c => c.text));
  assert.deepEqual(rows, [['Alpha', 'Quick'], ['Beta', 'Standard']]);
  const model = () => find(modal.contentEl, i => i.tag === 'select' && i['aria-label'] === 'Model'); assert.equal(model().value, '');
  assert.deepEqual(plain(model().children.map(c => c.value)), ['']);
  models = [{ id: 'm1', label: 'Model One' }, { id: 'm2', label: 'Model Two' }]; changed();
  assert.deepEqual(plain(model().children.map(c => [c.value, c.text])), [['', "Each topic's current model"], ['m1', 'Model One'], ['m2', 'Model Two']]);
  const templateSelect = find(modal.contentEl, i => i.tag === 'select' && i['aria-label'] === 'Content template');
  assert.deepEqual(plain(templateSelect.children.map(c => [c.value, c.text])), [['', "Each topic's current template"], ['standard', 'Standard'], ['A', 'Alpha template']]);
  const start = find(modal.modalEl, i => i.tag === 'button' && i.text === 'Start research (2)');
  start.listeners.click(); start.listeners.click();
  assert.equal(modal.closed, 1); assert.equal(requests.length, 1); modal.onClose(); assert.equal(unwatched, 1);
  assert.deepEqual(plain(requests[0]), { requirements: '' }, 'the request carries no mode: each topic runs in its own note\'s mode');
  const second = []; const m2 = new mod.MultiResearchModal({}, ['A'], { list: () => [{ id: 'm1', label: 'Model One' }], watch: () => () => {} }, templates, r => second.push(r)); m2.open();
  find(m2.contentEl, i => i.tag === 'select' && i['aria-label'] === 'Model').value = 'm1';
  // The template select lives under "Custom…" of the Note style select.
  const style2 = find(m2.contentEl, i => i.tag === 'select' && i['aria-label'] === 'Note style'); style2.value = 'custom'; style2.listeners.change();
  find(m2.contentEl, i => i.tag === 'select' && i['aria-label'] === 'Content template').value = 'A';
  find(m2.contentEl, i => i.tag === 'textarea').value = '  only 2025  ';
  find(m2.modalEl, i => i.tag === 'button' && i.text === 'Start research (1)').listeners.click();
  assert.deepEqual(plain(second[0]), { requirements: 'only 2025', model: 'm1', detailTemplateId: 'A' });
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

integrationTest('Next Step modal: the content template choice goes into research, expansion and synthesis options only when picked', async () => {
  const { element, find, findAll: all, button } = dom;
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  class Modal { constructor() { this.modalEl = element('modal'); this.titleEl = element('title'); this.contentEl = element('content'); this.modalEl.children.push(this.contentEl); } close() { this.onClose?.(); } }
  const { NextStepModal } = load('main.ts', { obsidian: { ...obsidian, Modal, setIcon: () => {}, Notice: class {} } });
  const modelState = provider => ({ provider, status: 'ready', models: [] });
  const plugin = { settings: { codexUsageNoticeSeen: true, claudeUsageNoticeSeen: true, models: 'gpt-test', cliReasoning: 'low', language: 'en' }, aiReadyForModel: async () => true, confirmAiUsage: async (_m, run) => { await run(); return true; }, saveSettings: async () => {}, activeTasks: new Map(), availableModels: () => ['gpt-test'], modelLabel: model => model, modelDiscoveryState: modelState, subscribeModelDiscovery: () => () => {}, refreshModelDiscovery: async provider => modelState(provider), sources: { currentTopicId: 'current', currentLabel: 'Current', synthesisLabel: 'Current and children', synthesisTopics: ['Child'], topics: async () => [], readTopic: async () => [] } };
  const templates = [{ id: 'standard', name: 'Standard' }, { id: 'A', name: 'Alpha template' }];
  const settings = { model: 'gpt-test', modelSource: 'workspace', reasoning: 'low', save: async () => {}, sources: plugin.sources, templates, currentTemplate: 'Standard' };
  const seen = {};
  const open = (name, withSettings) => {
    const modal = new NextStepModal({}, 'Parent', 1, 0, plugin,
      async options => { seen.research = options; },
      async options => { seen.expand = options; },
      async options => { seen.synth = options; }, withSettings);
    modal.onOpen();
    return modal;
  };
  const templateSelect = modal => find(modal.contentEl, item => item.tag === 'select' && item['aria-label'] === 'Content template');
  // The template select sits under "Custom…" of the Note style select.
  const customStyle = modal => { const style = find(modal.contentEl, item => item.tag === 'select' && item['aria-label'] === 'Note style'); style.value = 'custom'; style.fire('change'); };
  const cardsOf = modal => find(modal.contentEl, item => item.cls === 'vam-next-cards');
  // Owner decision 2026-10-19: a research press hides the dialog, so each choice runs on its own fresh dialog.
  const modal = open('keep', settings);
  assert.deepEqual(plain(templateSelect(modal).children.map(c => [c.value, c.text])), [['', 'Keep current (Standard)'], ['standard', 'Standard'], ['A', 'Alpha template']]);
  button(modal.modalEl, 'Confirm research task').click(); await tick();
  assert.equal('detailTemplateId' in seen.research, false, 'keep-current sends no choice');
  const picked = open('picked', settings);
  customStyle(picked); templateSelect(picked).value = 'A';
  button(picked.modalEl, 'Confirm research task').click(); await tick();
  assert.equal(seen.research.detailTemplateId, 'A');
  // C2: quick explore is an AI outline reviewed in the dialog; the template choice reaches its create step.
  // Owner decision 2026-10-19: Generate hides the dialog; the template choice rides along to the reopened review's create step.
  let ready;
  const quickOutline = { presets: [{ id: 'knowledge-tree', name: 'Knowledge tree generator' }], generate: async () => plain(load('experiences/visual-map/outline-import.ts', { obsidian }).parseOutline('# Parent\n## A').nodes), create: async (_nodes, options) => { seen.expand = options; } };
  const quickModal = open('quick', { ...settings, quickOutline, background: { begin() {}, end() {}, outlineReady: outline => { ready = outline; } } });
  customStyle(quickModal); templateSelect(quickModal).value = 'A';
  cardsOf(quickModal).children[1].click();
 
  button(quickModal.modalEl, 'Expand').click(); await tick(); await tick();
  const reviewModal = open('review', { ...settings, quickOutline, pendingOutline: { ...ready, discard() {} } });
  button(reviewModal.contentEl, 'Create subtopics (1)').click(); await tick(); await tick();
  assert.equal(seen.expand.detailTemplateId, 'A');
  const synthModal = open('synth', settings);
  customStyle(synthModal); templateSelect(synthModal).value = 'A';
  cardsOf(synthModal).children[2].click();
  const synthPanel = all(synthModal.contentEl, item => item.cls.includes('vam-next-research'))[2];
  button(synthModal.modalEl, 'Get synthesis suggestions first').click(); await tick();
  assert.equal(seen.synth.detailTemplateId, 'A');
  const bare = open('bare', undefined);
  assert.deepEqual(plain(templateSelect(bare).children.map(c => c.value)), ['']);
});
test('templateField: keep option first, returns the chosen template id or undefined for keep', () => {
  const element = (tag, options = {}) => ({ tag, text: options.text, value: options.value ?? '', children: [],
    createEl(name, value = {}) { const child = element(name, value); this.children.push(child); return child; },
    createDiv(value = {}) { return this.createEl('div', typeof value === 'string' ? { cls: value } : value); },
    createSpan(value = {}) { const child = element('span', value); this.children.push(child); return child; },
    replaceChildren() { this.children = []; },
    setAttr(name, value) { this[name] = value; } });
  const { templateField } = load('experiences/visual-map/research-fields.ts', { obsidian });
  const parent = element('div');
  const read = templateField(parent, [{ id: 'standard', name: 'Standard' }, { id: 'A', name: 'Alpha' }], 'Keep it');
  const select = parent.children[0].children.find(child => child.tag === 'select');
  assert.equal(select['aria-label'], 'Content template');
  assert.deepEqual(plain(select.children.map(c => [c.value, c.text])), [['', 'Keep it'], ['standard', 'Standard'], ['A', 'Alpha']]);
  assert.equal(read(), undefined);
  select.value = 'A'; assert.equal(read(), 'A');
  select.value = ''; assert.equal(read(), undefined);
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
  const sources = { currentTopicId: 'map', currentLabel: 'Selected topics included', topics: async () => [], readTopic: async () => [] };
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
integrationTest('structure panel: a parent change waits for Apply, says what will change, and keeps Remove apart', () => {
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
  const nodes = [{ id: 'a', path: 'A.md', parentId: null }, { id: 'b', path: 'B.md', parentId: null }, { id: 'c', path: 'C.md', parentId: 'a' }];
  const changes = []; let closed = 0, removed = 0, merging = false;
  const view = {
    builtIn: false, map: { nodes }, notes: new Map([['a', { title: 'Heat' }], ['b', { title: 'Water' }], ['c', { title: 'Pan', sourcePaths: [] }]]),
    app: { vault: { getAbstractFileByPath: () => null } }, referenceSourcePaths: () => [],
    button(parent, text, click) { const b = parent.createEl('button', { text }); b.click = click; return b; },
    mergeUnlocked: () => !merging, confirmRemoveNode() { removed++; }, enqueue(work) { work(); }, mapChange(change) { const copy = { nodes: nodes.map(n => ({ ...n })) }; change(copy); changes.push(copy.nodes.find(n => n.id === 'c').parentId); }
  };
  const content = element('content'), host = element('modal');
  VisualAgentMapView.prototype.renderInspector.call(view, content, nodes[2], 'structure', () => { closed++; }, host);
  assert.ok(find(content, item => item.text === 'Topic: Pan'));
  assert.equal(find(content, item => item.tag === 'button' && item.text === 'Remove parent link'), undefined);
  const actions = find(host, item => item.cls === 'vam-next-actions');
  const buttons = actions.children.filter(item => item.tag === 'button');
  assert.deepEqual(buttons.map(item => item.text), ['Remove from map', 'Close', 'Apply']);
  assert.ok(buttons[0].cls.includes('vam-discard'));
  const apply = buttons[2], status = find(actions, item => item.cls.includes('vam-next-status'));
  assert.equal(apply.disabled, true);
  // The parent picker is an indented tree like the outline; the topic itself cannot be its own parent.
  const tree = find(content, item => item.cls === 'vam-topic-tree');
  const rows = tree.children.map(row => [row.dataset.id, row.text, row.style.paddingLeft, row.disabled]);
  assert.deepEqual(rows, [['', 'No parent (root topic)', '8px', false], ['a', 'Heat', '8px', false], ['c', 'Pan', '24px', true], ['b', 'Water', '8px', false]]);
  const row = id => tree.children.find(item => item.dataset.id === id);
  assert.ok(row('a').cls.includes('is-selected'), 'current parent starts selected');
  row('b').click();
  assert.ok(row('b').cls.includes('is-selected')); assert.ok(!row('a').cls.includes('is-selected'));
  assert.equal(apply.disabled, false); assert.equal(status.text, 'Will move under “Water”.'); assert.equal(changes.length, 0);
  row('').click();
  assert.equal(status.text, 'Will become a root topic.');
  apply.click();
  assert.equal(closed, 1); assert.deepEqual(changes, [null]);
  buttons[0].click();
  assert.equal(removed, 1);
  // A card that is merging cannot get a new parent from Apply.
  merging = true; row('b').click(); apply.click();
  assert.deepEqual(changes, [null], 'no parent change while the card is merging');
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
    plugin: { pendingSuggestions, pendingResearchOptions: new Map(), expansionCoordinator: { isRunning: () => false }, mutate: async work => work() },
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
  return { view, doc, outline, renders: () => renders, cards: () => Object.fromEntries(view.stageEl.children.map(card => [card.dataset.nodeId, card])), build: () => { view.cardEls.clear(); view.stageEl.children = []; view.tabStopId = view.defaultTabStop(doc.nodes); for (const item of doc.nodes) view.renderNode(item); } };
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
  assert.equal(fixture.renders(), 0); assert.equal(view.selected, 'a');
  assert.deepEqual(stops(), ['a']);
  assert.equal(cards.a.attrs['aria-selected'], 'true'); assert.ok(cards.a.classes.has('is-selected'));
  assert.equal(cards.root.attrs['aria-selected'], 'false'); assert.equal(cards.root.tabIndex, -1);
  assert.deepEqual(outline.at(-1), 'a.md');
  // Arrow keys walk the tree and move focus without a render.
  cards.a.handlers.get('keydown')({ key: 'ArrowDown', target: cards.a, preventDefault() {} });
  assert.equal(view.selected, 'b'); assert.equal(cards.b.focused, 1); assert.deepEqual(stops(), ['b']);
  assert.equal(cards.a.classes.has('is-selected'), false);
  cards.b.handlers.get('keydown')({ key: 'ArrowLeft', target: cards.b, preventDefault() {} });
  assert.equal(view.selected, 'root'); assert.deepEqual(stops(), ['root']);
  assert.equal(fixture.renders(), 0, 'selection and arrow keys never call render()');
});
integrationTest('select mode: the selection bar keeps action labels fixed and announces the topic count to screen readers', () => {
  const fixture = selectionView(load); const { view } = fixture;
  view.integrationMode = true; fixture.build();
  const labels = ids => {
    view.multiSelected = new Set(ids);
    const bar = view.renderSelectionBar(selectionDom()('div'));
    return bar.children.filter(child => child.tag === 'button').map(button => [button.text, button.disabled, button.attrs['aria-label']]);
  };
  const hinted = view.renderSelectionBar(selectionDom()('div'));
  assert.equal(hinted.children[0].tag, 'span'); assert.equal(hinted.children[1].classes.has('vam-selection-hint'), true); assert.match(hinted.children[1].text, /Drag to box-select/, 'the gesture hint sits in the bar under the names line');
  const none = labels([]);
  assert.deepEqual(none.slice(-3), [['Synthesize', true, undefined], ['Merge', false, undefined], ['Research', true, undefined]]);
  assert.deepEqual(labels(['a']).slice(-3), [['Synthesize', true, undefined], ['Merge', false, undefined], ['Research', false, 'Research 1 topic']]);
  assert.deepEqual(labels(['a', 'b', 'c']).slice(-3), [['Synthesize', false, 'Synthesize 3 topics'], ['Merge', false, 'Merge 3 topics'], ['Research', false, 'Research 3 topics']]);
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-TW', 'ui.synthesize_0_topics', 3), '整合 3 個議題'); assert.equal(translate('zh-TW', 'ui.research_0_topics', 3), '研究 3 個議題');
});
integrationTest('select mode toggles cards in place, keeps checkboxes out of the tab order and survives a full render', () => {
  const { view, renders, cards, build } = (() => { const fixture = selectionView(load); fixture.view.integrationMode = true; fixture.build(); return fixture; })();
  const byId = cards();
  const checks = view.cardChecks;
  assert.equal(checks.size, 4);
  for (const check of checks.values()) assert.equal(check.tabIndex, -1, 'no checkbox per card in the tab order');
  const click = id => byId[id].handlers.get('click')({ target: { closest: () => null }, metaKey: false, ctrlKey: false });
  click('a'); click('c');
  assert.deepEqual([...view.multiSelected].sort(), ['a', 'c']);
  assert.equal(renders(), 0); assert.equal(checks.get('a').checked, true); assert.equal(byId.b.attrs['aria-selected'], 'false');
  assert.equal(byId.c.attrs['aria-selected'], 'true');
  click('a');
  assert.deepEqual([...view.multiSelected], ['c']); assert.equal(checks.get('a').checked, false); assert.equal(byId.a.classes.has('is-selected'), false);
  // Keyboard focus in select mode moves the tab stop only; the ticked cards stay ticked.
  byId.c.handlers.get('keydown')({ key: 'ArrowLeft', target: byId.c, preventDefault() {} });
  assert.deepEqual([...view.multiSelected], ['c']); assert.equal(byId.a.tabIndex, 0); assert.equal(byId.root.tabIndex, -1); assert.equal(byId.a.focused, 1);
  // A full render afterwards reproduces the same state from the model.
  build();
  const again = cards();
  assert.equal(again.c.classes.has('is-selected'), true); assert.equal(again.c.attrs['aria-selected'], 'true'); assert.equal(again.a.classes.has('is-selected'), false);
  assert.equal(renders(), 0);
});
integrationTest('F2 starts rename, Enter opens details, and the collapse button reports aria-expanded', () => {
  const dialogs = [];
  class Modal { open() { dialogs.push(this); } close() {} }
  const fixture = selectionView(load, {}, { ...obsidian, Modal });
  const { view } = fixture;
  const opened = [];
  view.openDetails = topic => opened.push(topic.id);
  fixture.build();
  const cards = fixture.cards();
  cards.a.handlers.get('keydown')({ key: 'Enter', target: cards.a, preventDefault() {} });
  assert.deepEqual(opened, ['a']); assert.equal(view.selected, 'a'); assert.equal(fixture.renders(), 0);
  let renamed = 0;
  cards.a.handlers.get('keydown')({ key: 'F2', target: cards.a, preventDefault() { renamed++; } });
  assert.equal(renamed, 1, 'F2 is handled as the rename shortcut'); assert.equal(dialogs.length, 1, 'F2 opens the name dialog');
  assert.equal(fixture.renders(), 0);
  const expanded = [];
  const walk = item => { if (item.attrs && 'aria-expanded' in item.attrs) expanded.push(item.attrs['aria-expanded']); item.children.forEach(walk); };
  walk(cards.root); assert.deepEqual(expanded, ['true']);
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
  const repo = { updateMap: async (_path, change) => { counts.updateMap++; change(doc); }, readMap: async () => { counts.readMap++; return JSON.parse(JSON.stringify(doc)); }, readNote: async () => { counts.readNote++; return { ...note }; } };
  const plugin = Object.create(Plugin.prototype);
  Object.assign(plugin, { queue: Promise.resolve(), writing: 0, logs: { appendLog() {} }, repo, settings: { ...DEFAULT_SETTINGS }, expansionBatches: new Map(), pendingSuggestions: new Map(), syncOutline() {}, releaseOutline() {}, detailsShown: () => false, setOutlineActive() {} });
  const app = { vault: { getAbstractFileByPath: () => new obsidian.TFile('m/Map.md') } };
  const view = new VisualAgentMapView({ app }, plugin);
  view.app = app; view.path = 'm/Map.md'; view.map = doc; view.render = () => {};
  view.notes = new Map([[a.id, { ...note }], [b.id, { ...note }]]);
  plugin.views = () => [view];
  return { plugin, view, counts, doc, frames, cancelled, a, b, windowValues, load: () => ({ VisualAgentMapView }) };
};
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
  assert.match(source, /!this\.integrationMode && !this\.plugin\.settings\.canvasHintSeen\s*\?\s*overlay\.createSpan\(\{\s*cls: "vam-hint vam-canvas-hint"/, 'the normal hint shows only until seen; select mode draws none (the selection bar owns that corner)');
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
  assert.deepEqual(chips(cards.a), []); assert.notEqual(cards.a.dataset.status, 'running');
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
  fixture.build(); assert.deepEqual(chips(fixture.cards().a), []); assert.equal(texts.length > 0 && all(bar()).some(e => e.text === 'Merging:'), false, 'the bar is gone');
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
integrationTest('startup opens no topic outline, including on first install, while the outline command stays', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  for (const firstInstall of [false, true]) {
    const plugin = Object.create(Plugin.prototype), calls = [];
    Object.assign(plugin, { app: { workspace: { getLeavesOfType: () => [] } }, ready: Promise.resolve(), workspaceRecoveryCandidates: [], firstInstallSamplePending: firstInstall,
      activateBuiltInSample: async () => { calls.push('sample'); }, activateOutline: async () => { calls.push('outline'); }, styleNodeLeaf() {}, logs: { appendLog() {} } });
    await plugin.finishStartup();
    assert.deepEqual(calls, firstInstall ? ['sample'] : [], 'only the sample may open at startup, never the outline');
  }
  assert.match(fs.readFileSync(path.join(root, 'main.ts'), 'utf8'), /addLocalizedCommand\("open-topic-outline"/);
});
const outlineFixture = () => {
  const { default: Plugin, VisualAgentMapView } = load('main.ts', { obsidian });
  const handlers = {}, titled = title => ({ ...map([node('a')]), title });
  const mapView = (plugin, title) => { const view = Object.create(VisualAgentMapView.prototype); Object.assign(view, { plugin, map: titled(title), notes: new Map(), builtIn: false }); return view; };
  const plugin = Object.create(Plugin.prototype), state = { views: [], active: null };
  const leaf = { setViewState: async () => {} };
  Object.assign(plugin, { outlineTitles: new Map(), outlineSample: false, outlineSourceView: null, coffeeOutlineActive: false, coffeeOutlineSource: null, logs: { appendLog() {} },
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
integrationTest('card tools: labelled actions wait for hover, focus or selection, in the order Collapse, Structure, Rename, Select subtopics, Details, AI explore', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  // The tools float over the card's top edge, hidden until hover, focus or selection, and take no space.
  assert.match(css, /^\.vam-node > \.vam-node-tools \{ position: absolute;[^}]*bottom: calc\(100% - 6px\);[^}]*opacity: 0; pointer-events: none;[^}]*width: max-content;/m);
  assert.match(css, /\.vam-node:hover > \.vam-node-tools, \.vam-node:focus-within > \.vam-node-tools, \.vam-viewport:not\(\.is-selecting\) \.vam-node\.is-selected > \.vam-node-tools \{ opacity: 1; pointer-events: auto;/);
  assert.equal(/vam-ai-slot|vam-ai-tool/.test(css), false, 'no selected-only swap remains');
  assert.match(css, /\.vam-node-tools > \.vam-ai-explore::before \{ content: "✦" \/ "";/, 'the sparkle is decoration, not part of the name');
  const toolsOf = (setup = () => {}) => {
    const fixture = selectionView(load);
    setup(fixture);
    fixture.build();
    const tools = fixture.cards().a.children.find(child => child.classes.has('vam-node-tools'));
    return tools.children.filter(child => child.tag === 'button');
  };
  const buttons = toolsOf();
  assert.deepEqual(buttons.map(button => button.text), ['Collapse', 'Structure', 'Rename', 'Select subtopics', 'Details', 'AI explore']);
  const explore = buttons.at(-1);
  assert.ok(explore.classes.has('vam-ai-explore')); assert.equal(explore.attrs['aria-label'], undefined, 'the visible text is the accessible name (WCAG 2.5.3)');
  assert.equal(buttons.filter(button => button.classes.has('vam-ai-explore')).length, 1, 'one AI button');
  assert.equal(buttons[1].attrs['aria-label'], 'Structure and links'); assert.equal(buttons[3].attrs['aria-label'], 'Select every direct subtopic of this topic'); assert.equal(buttons[4].attrs['aria-label'], 'Open details in right sidebar');
  assert.equal(buttons[2].attrs['aria-label'], undefined);
  // A leaf has no Collapse; the sample keeps only Details; select mode keeps only Details.
  assert.deepEqual(toolsOf(({ view }) => { view.map.nodes = view.map.nodes.filter(item => item.id !== 'c'); }).map(button => button.text), ['Structure', 'Rename', 'Details', 'AI explore']);
  const sample = toolsOf(({ view }) => { view.builtIn = true; });
  assert.deepEqual(sample.map(button => button.text), ['Details']); assert.equal(sample[0].attrs.title, 'View sample content');
  assert.deepEqual(toolsOf(({ view }) => { view.integrationMode = true; }).map(button => button.text), ['Collapse', 'Details']);
  const { translate } = load('i18n.ts');
  assert.deepEqual(['ui.collapse', 'ui.node_tool_links', 'ui.node_tool_rename', 'ui.node_tool_details', 'ui.ai_explore'].map(key => translate('zh-TW', key)), ['收合', '結構', '改名', '詳情', 'AI 探索']);
});
integrationTest('status pill: researched topics show none, other states keep theirs and screen readers still hear the status', () => {
  const pills = status => {
    const fixture = selectionView(load);
    fixture.view.notes.get('a').status = status;
    fixture.build();
    const card = fixture.cards().a, found = [];
    const walk = item => { if (item.classes?.has('vam-status')) found.push(item); item.children.forEach(walk); };
    walk(card);
    return { found, label: fixture.view.stageEl.children.find(item => item.dataset.nodeId === 'a') };
  };
  assert.equal(pills('completed').found.length, 0, 'completed cards have no pill');
  for (const status of ['idea', 'error']) assert.equal(pills(status).found.length, 1, `${status} keeps its pill`);
  const labelled = selectionView(load); labelled.build();
  assert.ok(labelled.cards().a.attrs['aria-labelledby'], 'the card is still named');
});
integrationTest('the more-actions menu holds Organize notes and folders; toolbar keeps Select several topics; the zoom cluster Layout menu holds Auto layout', () => {
  const opened = [];
  class Modal { open() { opened.push(this); } close() {} }
  const { view } = selectionView(load, {}, { ...obsidian, Modal });
  view.openMapActions();
  const labels = opened[0].choices.map(choice => choice.label);
  assert.ok(labels.includes('Organize notes and folders'));
  const organize = opened[0].choices.find(choice => choice.label === 'Organize notes and folders'); assert.equal(typeof organize.action, 'function');
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
integrationTest('the New map menu no longer imports outlines; the topic side option and the palette command add to the open map only', () => {
  const opened = [], menus = [];
  class Modal { constructor(app) { this.app = app; } open() { opened.push(this); } close() {} }
  class Menu { constructor() { this.items = []; menus.push(this); } addItem(callback) { const item = { title: '', icon: '', click: null, setTitle(value) { this.title = value; return this; }, setIcon(value) { this.icon = value; return this; }, onClick(handler) { this.click = handler; return this; } }; callback(item); this.items.push(item); return this; } showAtMouseEvent() { return this; } }
  const { view } = selectionView(load, {}, { ...obsidian, Modal, Menu });
  view.openNewMapMenu({});
  assert.deepEqual(menus[0].items.map(item => item.title), ['New mind map', 'New AIM'], 'the menu has no outline import');
  view.path = `${DEFAULT_SETTINGS.topicsFolder}/Topic/Map.md`;
  view.openTopicMenu({});
  const paste = menus[1].items[0]; assert.equal(paste.title, 'Paste an outline to add several topics at once');
  paste.click();
  const placement = modal => modal.placementRequest();
  assert.deepEqual(plain(placement(opened.at(-1))), { kind: 'tree' }, 'no selection: add to the current map');
  view.selected = 'a'; paste.click();
  assert.deepEqual(plain(placement(opened.at(-1))), { kind: 'under', parentId: 'a' }, 'a selected topic: add under it');
  const count = opened.length;
  view.path = 'elsewhere/Map.md'; view.selected = null; paste.click();
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
  assert.match(source, /n\.collapsed = !n\.collapsed;\s*map\.nodes = arrangeMap\(map\.nodes(?:, supersededAimNodeIds\(map\))?(?:, this\.cardHeightOf)?\);/, 'the card collapse button re-arranges in the same change');
});
integrationTest('Layout menu offers collapse all, expand all, levels 1 to 3, a separator and Auto layout', () => {
  const menus = [];
  class Menu { constructor() { this.items = []; menus.push(this); } addItem(callback) { const item = { setTitle(value) { this.title = value; return this; }, setIcon() { return this; }, onClick(handler) { this.click = handler; return this; } }; callback(item); this.items.push(item); return this; } addSeparator() { this.items.push({ separator: true }); return this; } showAtMouseEvent() { return this; } }
  const { view } = selectionView(load, {}, { ...obsidian, Menu });
  const calls = []; view.collapseTo = levels => calls.push(levels); view.autoLayout = () => calls.push('arrange');
  view.openLayoutMenu({});
  assert.deepEqual(menus[0].items.map(item => item.separator ? '---' : item.title), ['Collapse all', 'Expand all', 'Expand to level 1', 'Expand to level 2', 'Expand to level 3', '---', 'Auto layout']);
  menus[0].items.filter(item => !item.separator).forEach(item => item.click());
  assert.deepEqual(calls, [0, null, 1, 2, 3, 'arrange']);
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
integrationTest('sample inspector marks its workspace so the overlay can move without :has()', () => {
  const fixture = selectionView(load, {}, { ...obsidian, MarkdownRenderer: { render: async () => {} } });
  const { view } = fixture;
  view.builtIn = true; view.notes.get('root').sourcePaths = []; view.notes.get('root').detail = '';
  const make = selectionDom();
  const parent = make('div');
  view.renderInspector(parent, fixture.doc.nodes[0]);
  assert.ok(parent.classes.has('has-inspector'));
  assert.ok(parent.children.some(child => child.classes.has('vam-inspector')));
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
  assert.equal(view.selected, 'a'); assert.deepEqual(restored, ['a'], 'the render restores focus to the target card');
  key('a', 'ArrowDown');
  assert.equal(view.selected, 'b'); assert.deepEqual(restored, ['a', 'b'], 'the second press moves one more step');
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
    const previous = view.selected; view.selected = null;
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
    return { fixture, buttons: tools.children.filter(child => child.tag === 'button') };
  };
  const has = (setup, id) => toolTexts(setup, id).buttons.some(button => button.text === 'Select subtopics');
  assert.equal(has(), true, 'a has the direct subtopic c');
  assert.equal(has(undefined, 'b'), false, 'a leaf has none');
  assert.equal(has(({ doc, view }) => { doc.nodes.find(n => n.id === 'a').collapsed = true; }), false, 'a folded card hides its subtopics and offers Expand instead');
  assert.equal(has(({ view }) => { view.integrationMode = true; }), false, 'not while selecting');
  assert.equal(has(({ view }) => { view.builtIn = true; }), false, 'not in the sample');
  assert.equal(has(({ view }) => { view.map.aim = { branches: [] }; }), false, 'not in an AIM map');
  // Root has direct children a and b but not grandchild c; the button replaces any earlier selection.
  const { fixture, buttons } = toolTexts(undefined, 'root');
  const { view } = fixture;
  view.multiSelected = new Set(['c']); view.selected = 'b';
  buttons.find(button => button.text === 'Select subtopics').handlers.get('click')({ stopPropagation() {} });
  assert.deepEqual([...view.multiSelected].sort(), ['a', 'b']); assert.equal(view.selected, null);
  assert.equal(view.integrationMode, true); assert.equal(fixture.renders(), 1);
});
integrationTest('Cmd/Ctrl+click: the first click on a second card enters selection mode, seeds the selected card, and the mode keeps toggling', () => {
  for (const key of ['metaKey', 'ctrlKey']) {
    const fixture = selectionView(load); const { view } = fixture;
    fixture.build();
    const cards = fixture.cards();
    const target = { closest: () => null };
    const tap = (id, extra = {}) => { cards[id].handlers.get('pointerdown')({ target, button: 0, clientX: 0, clientY: 0, pointerId: 1 }); cards[id].handlers.get('pointerup')({ type: 'pointerup', ...extra }); };
    tap('a');
    assert.equal(view.selected, 'a');
    tap('b', { [key]: true });
    assert.deepEqual([...view.multiSelected].sort(), ['a', 'b'], 'the plain-selected card A joins B');
    assert.equal(view.integrationMode, true); assert.equal(fixture.renders(), 1, 'the selection bar appears via a render');
    // Inside the mode a Cmd/Ctrl+click toggles instead of being swallowed.
    const click = id => { view.suppressClickUntil = 0; cards[id].handlers.get('click')({ target, metaKey: key === 'metaKey', ctrlKey: key === 'ctrlKey' }); };
    click('c');
    assert.deepEqual([...view.multiSelected].sort(), ['a', 'b', 'c']);
    click('a');
    assert.deepEqual([...view.multiSelected].sort(), ['b', 'c']);
  }
  // A single Cmd+click with nothing selected stays a one-card selection and does not enter the mode.
  const lone = selectionView(load); lone.build();
  const cards = lone.cards();
  cards.b.handlers.get('pointerdown')({ target: { closest: () => null }, button: 0, clientX: 0, clientY: 0, pointerId: 1 });
  cards.b.handlers.get('pointerup')({ type: 'pointerup', metaKey: true });
  assert.equal(lone.view.integrationMode, false); assert.deepEqual([...lone.view.multiSelected], ['b']); assert.equal(lone.renders(), 0);
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
  assert.equal(view.integrationMode, false); assert.equal(view.multiSelected.size, 0); assert.equal(fixture.renders(), before);
  // Shift+drag over a and b: enters the mode with both picked.
  down({ shiftKey: true }); drag(350, 200);
  assert.equal(view.integrationMode, true); assert.deepEqual([...view.multiSelected].sort(), ['a', 'b']);
  assert.equal(fixture.renders(), before + 1);
  // Inside the mode, Option+drag removes only the boxed picks and previews them with is-marquee-remove.
  view.multiSelected = new Set(['a', 'b', 'c']);
  down({ altKey: true, clientX: 150, clientY: 90 }); viewport.handlers.get('pointermove')({ clientX: 350, clientY: 200 });
  assert.equal(cards.b.classes.has('is-marquee-remove'), true); assert.equal(cards.a.classes.has('is-marquee-remove'), false);
  viewport.handlers.get('pointerup')({});
  assert.equal(cards.b.classes.has('is-marquee-remove'), false, 'the preview clears'); assert.deepEqual([...view.multiSelected].sort(), ['a', 'c']);
  // Option+drag over cards that are not picked changes nothing.
  down({ altKey: true, clientX: 150, clientY: 90 }); drag(350, 200);
  assert.deepEqual([...view.multiSelected].sort(), ['a', 'c']);
  // Plain drag adds; Space+drag and the middle button pan instead of boxing.
  down({ clientX: 150, clientY: 90 }); drag(350, 200);
  assert.deepEqual([...view.multiSelected].sort(), ['a', 'b', 'c']);
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
  view.integrationMode = true; fixture.build();
  const bar = ids => { view.multiSelected = new Set(ids); const el = view.renderSelectionBar(selectionDom()('div')); return el.children.find(child => child.tag === 'button' && /^Merge/.test(child.text)); };
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
  view.integrationMode = true; fixture.build();
  view.multiSelected = new Set();
  view.openMerge(); assert.equal(opened.length, 0, 'empty selection is a no-op');
  view.multiSelected = new Set(['a', 'b']);
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
  view.app = {}; view.enqueue = () => {}; view.integrationMode = true; fixture.build();
  const checkbox = modal => modal.contentEl.children.flatMap(function walk(c) { return [c, ...c.children.flatMap(walk)]; }).find(c => c.type === 'checkbox');
  view.multiSelected = new Set(['a', 'b']);
  view.openMerge(); assert.equal(checkbox(opened[0]), undefined, 'no content: the plain structure merge');
  opened[0].close();
  view.notes.get('b').detail = 'Has content';
  view.openMerge(); assert.ok(checkbox(opened[1]), 'content: the AI merge with its skip option');
  opened[1].close();
  // A running merge on this map only reports itself; its sources stay locked after it fails or finishes a draft.
  view.mergeTasks.set(view.path, { mapPath: view.path, state: 'running', sources: [{ id: 'a', path: 'a' }, { id: 'b', path: 'b' }], controller: new AbortController() });
  view.openMerge(); assert.equal(opened.length, 2, 'no second dialog while a merge is running');
});
integrationTest('the read-only sample and AIM maps never enter selection mode from Shift+drag or Cmd/Ctrl+click', () => {
  for (const [name, setup] of [['sample', view => { view.builtIn = true; }], ['AIM', view => { view.map.aim = { branches: [] }; }]]) {
    const fixture = selectionView(load); const { view } = fixture; setup(view);
    fixture.build();
    const cards = fixture.cards(); const target = { closest: () => null };
    // Cards of these maps may not be draggable at all; the click handler must not start the mode either.
    const tap = (id, extra = {}) => { const down = cards[id].handlers.get('pointerdown'); if (down) { down({ target, button: 0, clientX: 0, clientY: 0, pointerId: 1 }); cards[id].handlers.get('pointerup')({ type: 'pointerup', ...extra }); } view.suppressClickUntil = 0; cards[id].handlers.get('click')({ target, metaKey: false, ctrlKey: false, ...extra }); };
    tap('a'); tap('b', { metaKey: true }); tap('c', { ctrlKey: true });
    assert.equal(view.integrationMode, false, `${name}: Cmd/Ctrl+click does not start selection mode`);
    for (const [id, [left, top, right, bottom]] of Object.entries({ root: [0, 0, 100, 50], a: [200, 0, 300, 50], b: [200, 100, 300, 150], c: [400, 0, 500, 50] })) cards[id].getBoundingClientRect = () => ({ left, top, right, bottom });
    view.stageEl.querySelectorAll = () => Object.values(cards);
    const viewport = selectionDom()('viewport'); viewport.clientWidth = 800; viewport.clientHeight = 600;
    view.viewportEl = viewport; view.transform = () => {}; view.saveViewport = () => {}; view.plugin.saveSettings = async () => {}; view.setupPan();
    viewport.handlers.get('pointerdown')({ target, button: 0, clientX: 150, clientY: -10, pointerId: 1, altKey: false, shiftKey: true, preventDefault() {} });
    assert.equal(viewport.classes.has('is-marquee'), false, `${name}: Shift+drag draws no box`);
    assert.equal(viewport.classes.has('is-panning'), true, `${name}: Shift+drag pans like a plain drag`);
    viewport.handlers.get('pointermove')({ clientX: 350, clientY: 200 }); viewport.handlers.get('pointerup')({});
    assert.equal(view.integrationMode, false);
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
    view.stageEl = makeElement('stage', buttons); view.map = doc; view.integrationMode = integrationMode;
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
