// Shared helpers, fixtures and module loads for the unit/integration suites in tests/suites.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');
const path = require('node:path');
const { test: nodeTest } = require('node:test');
const layer = process.argv.find(value => value.startsWith('--layer='))?.split('=')[1];
if (layer && !['unit', 'integration'].includes(layer)) throw new Error('Unknown test layer');
const test = (name, fn) => { if (!layer || layer === 'unit') nodeTest(name, fn); };
const integrationTest = (name, fn) => { if (!layer || layer === 'integration') nodeTest(name, fn); };
const { buildSync } = require('./build.cjs');
// Obsidian's own YAML options, so frontmatter in tests round-trips like the real app (not a one-line-per-key stub).
const YAML = require('yaml');
const root = path.resolve(__dirname, '..');
function load(entry, overrides = {}, windowValues = {}) {
  if (overrides.obsidian && !overrides.obsidian.Component) overrides = { ...overrides, obsidian: { ...overrides.obsidian, Component: class {} } };
  if (overrides.obsidian && !overrides.obsidian.MarkdownRenderChild) overrides = { ...overrides, obsidian: { ...overrides.obsidian, MarkdownRenderChild: class {} } };
  const code = buildSync({ entryPoints: [path.join(root, entry)], external: ['obsidian', 'node:*'] }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => overrides[name] || require(name), console, TextDecoder, TextEncoder, Blob, crypto: require('node:crypto').webcrypto, process, AbortController, navigator: windowValues.navigator, CSS: windowValues.CSS, Option: class { constructor(text, value) { this.tag = 'option'; this.text = text; this.value = value; this.cls = ''; this.children = []; this.attrs = {}; } }, HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {}, window: { setTimeout, clearTimeout, ...windowValues } });
  return module.exports;
}
const core = load('map-model.ts');
const layout = load('map-layout.ts');
const logging = load('log-manager.ts');
const node = (id, parentId = null, collapsed = false) => ({ id, parentId, path: `${id}.md`, x: 0, y: 0, collapsed });
const map = nodes => ({ id: 'map', title: '測試心智圖', version: 1, nodes, viewport: { x: 0, y: 0, zoom: 1 } });
const plain = obj => JSON.parse(JSON.stringify(obj));
const plannerReview = (decision, { rationale, stopReason, question } = {}, summary = 'Supported conditional answer.', detail = 'Evidence-based detail.', suggestions = []) => ({
  summary,
  detail: `<!-- aim-review ${JSON.stringify({ decision, rationale, ...(stopReason ? { stopReason } : {}), ...(question ? { question } : {}) })} -->\n${detail}`,
  suggestions: suggestions.map(item => typeof item === 'string' ? { title: item, task: '', contribution: '' } : item),
  visualReferences: []
});
async function seedCoverageAncestors(repo, mapPath, branchId) {
  const saved = await repo.readMap(mapPath); let parent = null;
  for (let index = 0; index < 2; index++) {
    const n = await repo.createNote(`Previously answered condition ${index}`, 'gpt-6-luna', saved, mapPath, 'workspace');
    n.aimKind = 'question'; n.parentId = saved.nodes.find(node => node.parentId === null)?.id ?? null;
    saved.nodes.push(n); const id = `ancestor-${branchId}-${index}`;
    saved.aim.branches.push({ id, questionNodeId: n.id, parentBranchId: parent, answerSnapshot: { selections: [], freeText: `Known prior condition ${index}` }, inputSnapshot: { topic: saved.title, conditions: { [`Prior condition ${index}`]: 'Known' }, upstreamResults: [] }, createdAt: new Date().toISOString(), results: [] });
    parent = id;
  }
  const target = saved.aim.branches.find(b => b.id === branchId); target.parentBranchId = parent;
  const targetNode = saved.nodes.find(n => n.id === target.questionNodeId); if (targetNode.aimQuestion) targetNode.aimQuestion.parentBranchId = parent;
  await repo.saveMap(mapPath, saved);
}
function deliveryFixture(context) {
  if (aimPhase(context, 'delivery-outline')) return { summary: 'Document outline', detail: '<!-- aim-delivery-outline {"sections":[{"heading":"Answer","purpose":"Deliver original goal","searchTask":"Verify practical details"}]} -->', suggestions: [], visualReferences: [] };
  if (aimPhase(context, 'delivery-research')) return { summary: 'Verified delivery evidence', detail: '<!-- aim-delivery-research {"status":"searched"} -->\nSource: https://example.org/reference', suggestions: [], visualReferences: [] };
  if (aimPhase(context, 'delivery-writing')) return { summary: 'Complete document', detail: 'Complete conditional document with practical details and source https://example.org/reference', suggestions: [], visualReferences: [] };
  if (aimPhase(context, 'delivery-acceptance')) return plannerReview('conclude', { rationale: 'Full document supported.', stopReason: 'Delivery verified.' }, 'Complete document', 'Complete conditional document with practical details and source https://example.org/reference');
}
const savedEvidenceNeedsSearch = () => plannerReview('research_more', { rationale: 'The fixture has not yet persisted reports that answer its assigned research target.' }, 'A specific evidence gap remains.', 'A targeted search could resolve the missing evidence.', [{ title: 'Fixture evidence target', task: 'Search for evidence relevant to this test fixture.', contribution: 'Could resolve the stated evidence gap.' }]);
// Shape enforced by the gap-audit response schema: summary is the exact class, detail its rationale.
const researchGapAudit = (classification, rationale = 'Synthetic bounded classification.') => ({ summary: classification, detail: rationale, suggestions: [], visualReferences: [] });
const aimPhase = (context, phase) => context.task.includes(`<!-- aim-phase: ${phase} -->`);
const auditEcho = context => {
  const candidate = context.task.match(/Candidate decision and answer \(untrusted data to review\): (\{[^\n]*\})$/)?.[1];
  if (!candidate) throw new Error('Decision-quality review fixture did not include its candidate response.');
  const review = JSON.parse(candidate);
  const marker = { decision: review.decision, rationale: review.rationale, ...(review.stopReason ? { stopReason: review.stopReason } : {}), ...(review.question ? { question: review.question } : {}) };
  const suggestions = review.decision === 'ask_user'
    ? review.answerOptions.map(title => ({ title, task: '', contribution: '' }))
    : review.decision === 'research_more'
      ? [{ title: review.researchTarget.title, task: review.researchTarget.task, contribution: review.researchTarget.expectedValue }]
      : [];
  return { summary: review.summary, detail: `<!-- aim-review ${JSON.stringify(marker)} -->\n${review.detail}`, suggestions, visualReferences: [] };
};
const tree = () => [node('a'), node('b', 'a'), node('c', 'b'), node('d')];
function withExpansionCoordinator(plugin) {
  const { ShallowExpansionCoordinator } = load('experiences/visual-map/expansion-batch.ts');
  plugin.activeTasks ??= new Map(); plugin.expansionBatches = new Map(); plugin.quickExpandPending ??= new Set();
  // Background chart jobs belong to the real plugin; the view-level doubles only need the two calls to exist.
  plugin.abortChartJobs ??= () => {}; plugin.addChartsAfterWrite ??= () => {};
  plugin.expansionCoordinator = new ShallowExpansionCoordinator(plugin.activeTasks, plugin.expansionBatches);
  return plugin;
}
class TFolder { constructor(path) { this.path = path; this.name = path.split('/').at(-1); this.children = []; this.parent = null; } }
class TFile { constructor(path) { this.path = path; this.name = path.split('/').at(-1); this.basename = this.name.replace(/\.md$/, ''); this.extension = this.name.includes('.') ? this.name.split('.').at(-1) : ''; this.parent = null; this.stat = { mtime: Date.now() }; } }
const obsidian = { setIcon: (parent, name) => { parent.iconName = name; }, Menu: class { addItem(callback) { callback({ setTitle() { return this; }, setIcon() { return this; }, setWarning() { return this; }, onClick() { return this; } }); return this; } addSeparator() { return this; } showAtMouseEvent() { return this; } },
  Scope: class { constructor(parent) { this.parent = parent; this.keys = []; } register(modifiers, key, func) { const handler = { modifiers, key, func }; this.keys.push(handler); return handler; } unregister(handler) { this.keys = this.keys.filter(item => item !== handler); } },
  TFile, TFolder, App: class {}, Plugin: class {}, ItemView: class { constructor(leaf) { this.app = leaf.app; } async setState() {} }, PluginSettingTab: class {}, Modal: class {}, FuzzySuggestModal: class {}, Notice: class {}, FileSystemAdapter: class { getBasePath() { return '/vault'; } },
  normalizePath: value => value.replace(/\/+/g, '/').replace(/^\//, ''),
  parseYaml: text => YAML.parse(text, null, {}),
  stringifyYaml: obj => YAML.stringify(obj, null, { nullStr: '', lineWidth: 0, aliasDuplicateObjects: false })
};
const { Repository, DEFAULT_SETTINGS, normalizeReasoningLevel } = load('repository.ts', { obsidian });
function fixture(language = 'zh-TW', options = {}) {
  const files = new Map(), contents = new Map();
  const attach = item => { const folderPath = item.path.split('/').slice(0, -1).join('/'); item.parent = files.get(folderPath) || null; // Obsidian's vault tree hides dot-files and dot-folders; the adapter (disk) listing below still reports them.
    if (item.parent instanceof TFolder && !item.name.startsWith('.') && !item.parent.children.includes(item)) item.parent.children.push(item); };
  const renameTree = (from, to) => { const entries = Array.from(files.entries()).filter(([p]) => p === from || p.startsWith(`${from}/`)).sort((a, b) => a[0].length - b[0].length); for (const [old, item] of entries) { files.delete(old); if (item.parent?.children) item.parent.children = item.parent.children.filter(child => child !== item); const next = `${to}${old.slice(from.length)}`; item.path = next; item.name = next.split('/').at(-1); if (item instanceof TFile) { item.basename = item.name.replace(/\.md$/, ''); item.stat.mtime = Date.now(); const content = contents.get(old); contents.delete(old); contents.set(next, content); } files.set(next, item); } for (const [, item] of entries) attach(item); };
  const app = { vault: {
    getAbstractFileByPath: p => files.get(p),
    getMarkdownFiles: () => Array.from(files.values()).filter(file => file instanceof TFile && file.extension === 'md'),
    read: async file => contents.get(file.path), cachedRead: async file => contents.get(file.path),
    createFolder: async p => { if (files.has(p)) throw new Error(`Folder already exists: ${p}`); const folder = new TFolder(p); files.set(p, folder); attach(folder); return folder; },
    create: async (p, content) => { assert.equal(files.has(p), false); const file = new TFile(p); files.set(p, file); contents.set(p, content); attach(file); return file; },
    createBinary: async (p, content) => { assert.equal(files.has(p), false); const file = new TFile(p); files.set(p, file); contents.set(p, content); attach(file); return file; },
    process: async (file, change) => { contents.set(file.path, change(contents.get(file.path))); },
    // Moves without touching any link, like Obsidian's Vault.rename.
    rename: async (item, target) => renameTree(item.path, target),
    adapter: {
      exists: async p => files.has(p),
      mkdir: async p => { if (files.has(p)) throw new Error(`Folder already exists: ${p}`); const folder = new TFolder(p); files.set(p, folder); attach(folder); },
      list: async p => ({ files: [...files.values()].filter(file => file instanceof TFile && file.parent?.path === p).map(file => file.path), folders: [...files.values()].filter(file => file instanceof TFolder && file.parent?.path === p).map(file => file.path) }),
      read: async p => { if (!contents.has(p)) throw new Error(`Missing file: ${p}`); return contents.get(p); },
      write: async (p, value) => { if (!files.has(p)) { const file = new TFile(p); files.set(p, file); attach(file); } contents.set(p, value); },
      process: async (p, change) => { if (!contents.has(p)) throw new Error(`Missing file: ${p}`); const next = change(contents.get(p)); contents.set(p, next); return next; }
    }
  }, metadataCache: { getFileCache: file => { const text = contents.get(file.path) || ''; const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]; return { frontmatter: block ? obsidian.parseYaml(block) : {} }; }, getFirstLinkpathDest: link => { const key = link.replace(/\.md$/, ''); return Array.from(files.values()).find(file => file instanceof TFile && (file.basename === key || file.path.replace(/\.md$/, '') === key)) || null; } }, fileManager: { renameFile: async (item, target) => renameTree(item.path, target), trashFile: async () => {} } };
  // Opt-in link index: resolvedLinks is computed from the current text (frontmatter and body wikilinks), like Obsidian's.
  if (options.linkIndex) Object.defineProperty(app.metadataCache, 'resolvedLinks', { configurable: true, get: () => { const index = {}; for (const [path, text] of contents) { if (!(files.get(path) instanceof TFile) || !path.endsWith('.md')) continue; for (const match of String(text).matchAll(/!?\[\[([^\]|#\n]+)/g)) { const dest = app.metadataCache.getFirstLinkpathDest(match[1].trim()); if (!dest) continue; index[path] ||= {}; index[path][dest.path] = (index[path][dest.path] || 0) + 1; } } return index; } });
  return { app, contents, files, repo: new Repository(app, { ...DEFAULT_SETTINGS, language }) };
}
async function topicNote(repo, title = '題目', model = 'model-a', id = 'map-a') {
  const mapDoc = { id, title: id, version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const mapPath = `Agent Workspace/Topics/${id}/Map.md`; await repo.ensureTopicFolders(`Agent Workspace/Topics/${id}`);
  return repo.createNote(title, model, mapDoc, mapPath, 'workspace');
}
async function aimMapFixture() {
  const data = fixture(); const mapPath = await data.repo.createMap('AIM MVE'); let document = await data.repo.readMap(mapPath);
  const question = await data.repo.createNote('使用者問題', 'gpt-6-luna', document, mapPath, 'workspace');
  document.nodes.push(question); await data.repo.saveMap(mapPath, document);
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  return { ...data, mapPath, question, store: new AimRunStore(data.repo, (() => { let next = 0; return () => `aim-id-${++next}`; })(), () => '2026-10-04T22:30:00.000Z') };
}
// Coffee Tables uses one plain-text generation, then one request per follow-up.
const coffeeTypes = load('experiences/coffee-tables/types.ts');
const coffee = load('experiences/coffee-tables/engine.ts');
const coffeePrompts = load('experiences/coffee-tables/prompts.ts');
const coffeeInsights = load('experiences/coffee-tables/insights.ts');
const coffeeGuestInvitations = load('experiences/coffee-tables/guest-invitations.ts');
const coffeeCustomization = load('experiences/coffee-tables/customization.ts');
const coffeeConvergence = load('experiences/coffee-tables/convergence.ts');
const coffeeSession = () => coffeeTypes.createSession('學生免費的營養午餐是否應該開放讓家長加價', 'test-model', 'high', 'zh-TW');
const coffeeTableList = load('experiences/coffee-tables/list.ts');
const coffeeTopics = load('experiences/coffee-tables/topics.ts');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setImmediate(r)); } throw new Error('condition not reached'); };
function coffeeElement(tag, options = {}) {
  return { tag, cls: options.cls ?? '', querySelectorAll(selector) { const result = []; const visit = node => { for (const child of node.children) { if (selector.startsWith('.') ? child.cls.split(' ').includes(selector.slice(1)) : child.tag === selector) result.push(child); visit(child); } }; visit(this); return result; }, text: options.text ?? '', value: options.value ?? '', children: [], disabled: false, attrs: options.attr ?? {}, get options() { return this.children.filter(child => child.tag === 'option' || child.value !== undefined); },
    createDiv(value) { const element = coffeeElement('div', typeof value === 'string' ? { cls: value } : value); this.children.push(element); return element; },
    createEl(name, value) { const element = coffeeElement(name, value); this.children.push(element); return element; }, createSpan(value) { const element = coffeeElement('span', value); this.children.push(element); return element; }, addClass() {}, toggleClass() {}, removeClass() {}, setText(value) { this.text = value; }, empty() { this.children = []; }, focus() {}, remove() { this.removed = true; },
    add(option) { this.children.push(option); }, replaceChildren(...children) { this.children = children; },
    classList: { add() {}, toggle() {} }, dataset: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(name, handler) { this[name] = handler; }, get childElementCount() { return this.children.length; } };
}
const coffeeFind = (root, predicate) => predicate(root) ? root : root.children.map(child => coffeeFind(child, predicate)).find(Boolean);
function withCoffeeModelDiscovery(plugin, models) {
  const states = {
    codex: { provider: 'codex', status: 'ready', models: models.filter(model => !model.startsWith('claude:')) },
    claude: { provider: 'claude', status: 'ready', models: models.filter(model => model.startsWith('claude:')) }
  };
  const listeners = new Set();
  plugin.availableModels = () => [...new Set([...states.codex.models, ...states.claude.models])];
  plugin.modelLabel = plugin.modelLabel ?? (model => model);
  plugin.modelDiscoveryState = provider => ({ ...states[provider], models: [...states[provider].models] });
  plugin.subscribeModelDiscovery = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  plugin.refreshModelDiscovery = async provider => { const state = plugin.modelDiscoveryState(provider); for (const listener of listeners) listener(state); return state; };
  plugin.refreshCoffeeModels = plugin.refreshCoffeeModels ?? (async () => plugin.availableModels());
  plugin.coffeeReasoningEfforts = plugin.coffeeReasoningEfforts ?? (model => model.startsWith('claude:') ? ['low', 'medium', 'high'] : []);
  return plugin;
}
async function reframingModalFixture(insightId) {
  const data=fixture('en'); const {app,contents,repo}=data;
  const {CoffeeStorage}=load('experiences/coffee-tables/storage.ts',{obsidian});
  const session=coffeeSession(); session.status='completed'; session.language='en'; session.rounds=[{id:'round-handoff',createdAt:session.createdAt,status:'completed',markdown:'### Host|Host\nUnique discussion line.',notes:''}]; session.transcriptMarkdown=session.rounds[0].markdown;
  session.observerNotes=['# Observer’s notes\n\n## Unexpected connections\n- Candidate analogy <!-- coffee-insight:v1:id=idea --> <!-- source: Unique discussion line. -->\n  - Context: Important limits'];
  const store=new CoffeeStorage(app.vault,'Agent Workspace'); await store.save(session); const path=store.sessionPath(session.id), displayed=await store.inspectReadOnly(path);
  const {default:Plugin}=load('main.ts',{obsidian});const plugin=new Plugin(); plugin.app=app;plugin.repo=repo;plugin.coffeeStorage=store;plugin.settings.language='en';withCoffeeModelDiscovery(plugin,['test-model']); plugin.confirmAiUsage=async (_m,run)=>{await run();return true;}; plugin.register=()=>{};
  const opened=[];plugin.activateView=async p=>{opened.push(p);};plugin.openResearchMap=async p=>{opened.push(p);};plugin.mutate=async work=>work();
  const {receiveVisualMapHandoff}=load('experiences/visual-map/handoff.ts',{obsidian});
  plugin.core.experiences.register('visual-map',(artifact,beforeWrite)=>receiveVisualMapHandoff(artifact,{repo,defaultModel:()=>plugin.settings.cliModel,exists:p=>!!app.vault.getAbstractFileByPath(p),mutate:work=>plugin.mutate(work),navigate:p=>plugin.activateView(p),beforeWrite}));
  const modals=[];class Modal {constructor(){this.titleEl=coffeeElement('title');this.contentEl=coffeeElement('content');}open(){modals.push(this);this.onOpen?.();}close(){this.didClose=true;this.onClose?.();}}
  const dom=require('./support-dom.cjs'), notices=[], Notice=dom.makeNotice(notices);
  const handoff=load('experiences/coffee-tables/handoff-modal.ts',{obsidian:{...obsidian,Modal,Notice}},{createFragment:dom.createFragment});
  const modal=await handoff.openCoffeeResearchHandoff(plugin,store,displayed,path,insightId);
  return {...data,plugin,store,session:displayed,path,modal,opened,handoff,notices,Notice,displayed,insightId,modals};
}
// Current AIM coverage scenarios: verify outcomes rather than exact prompt wording/call counts.
function coverageModel({ failSearch = false, unavailableDelivery = false, clarifyConflict = false } = {}) {
  const phases = [], state = { failSearch, clarifyConflict };
  const response = (summary, detail, suggestions = []) => ({ summary, detail, suggestions, visualReferences: [] });
  const ask = async context => {
    const phase = context.task.match(/aim-phase:\s*([a-z-]+)/)?.[1]; phases.push(phase);
    if (phase === 'saved-evidence-review') return savedEvidenceNeedsSearch();
    if (phase === 'initial-clarification') return response('Clarification', '<!-- aim-intake {"questions":["What constraints matter?"]} -->');
    if (phase === 'initial-question') return response('What is your intended outcome?', 'Unknown success criterion.', [{ title: 'Executable project', task: '', contribution: '' }, { title: 'Compare alternatives', task: '', contribution: '' }]);
    if (phase === 'research-plan') return response('Two complementary research dimensions.', '<!-- aim-plan {"subtopics":[{"id":"method","title":"Method and options","task":"Research practical methods and relevant alternatives.","expectedValue":"Compare feasible ways to meet the goal."},{"id":"constraints","title":"Constraints and quality","task":"Research key constraints, timing, and quality or safety considerations.","expectedValue":"Identify conditions that could change execution."}]} -->');
    if (phase === 'report-review') {
      const count = Number(context.task.match(/Hard floor: (\d+) answered/)?.[1]);
      const suppliedContext = `${context.task}\n${context.detail}\n${context.ancestors}`;
      if (clarifyConflict && /occasional contributor/i.test(suppliedContext) && /primary operations owner/i.test(suppliedContext)) return plannerReview('ask_user', { rationale: 'The same project is described as both occasional contribution and primary operations ownership; clarify responsibility before personalizing the plan.', question: 'For this same project, are you an occasional contributor or the primary operations owner?' }, 'Keep the answer conditional until the conflicting responsibility is clarified.', 'The supplied responsibility descriptions conflict; do not choose one.', ['Occasional contributor', 'Primary operations owner']);
      return count < 3 ? plannerReview('ask_user', { rationale: 'A different unknown constraint changes execution.', question: `Which constraint matters at stage ${count + 1}?` }, 'Interim evidence', 'Applicable evidence and limitations.', ['Time constraint', 'Resource constraint']) : plannerReview('conclude', { rationale: 'Three answers and reports support delivery.', stopReason: 'Ready for delivery stages.' }, 'Candidate document', 'Candidate document');
    }
    if (phase === 'delivery-outline') return response('Document outline', '<!-- aim-delivery-outline {"sections":[{"heading":"Execution plan","purpose":"Complete the original goal","searchTask":"Find verified runnable examples"}]} -->');
    if (phase === 'delivery-research') return response('Delivery evidence', `<!-- aim-delivery-research {"status":"${unavailableDelivery ? 'unavailable' : 'searched'}"} -->\nConcrete example and source https://example.org/reference`);
    if (phase === 'delivery-writing') return response('Canvas preview', '# Complete execution plan\n\n1. Build a small example.\n2. Check the output against requirements.\n3. Extend with evidence.\n\nSource: https://example.org/reference');
    if (phase === 'delivery-acceptance') return plannerReview('conclude', { rationale: 'Every required section is concrete and supported.', stopReason: 'Document usable for original goal.' }, 'Completed document preview', '# Complete execution plan\n\n1. Build a small example.\n2. Check the output against requirements.\n3. Extend with evidence.\n\nSource: https://example.org/reference');
    if (context.researchMode === 'research') {
      if (state.failSearch) return response('Search unavailable', 'Research status: unavailable');
      return response('Researched evidence', 'Research status: search completed\nApplicable evidence: https://example.org/reference');
    }
    throw new Error(`Unexpected coverage phase ${phase}`);
  };
  return { ask, phases, state };
}
async function coverageSetup(topic = 'Produce an actionable learning plan', config = {}) {
  const repo = config.sharedRepo ?? fixture().repo;
  const { createAimMap } = load('experiences/aim/create-map.ts');
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  const model = coverageModel(config);
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: `coverage-${topic}`, topic, context: 'Initial clarification: known background; unknown constraints may be explored conditionally.', minimumAnswersBeforeConclusion: 3, outcomeExpectation: { goal: 'execute', description: '', formats: ['steps', 'table'] } });
  const flow = new AimManualFlow(repo, new AimRunStore(repo), model.ask);
  return { repo, created, flow, model };
}
async function coverageThreeAnswers(subject) {
  let question = (await subject.flow.planNextQuestion(subject.created.mapPath, subject.created.root.id, 'gpt-6-luna', 'low', 'coverage-question')).node;
  let outcome;
  for (let round = 1; round <= 3; round++) {
    const freeText = subject.model.state.clarifyConflict
      ? round === 1 ? 'I am an occasional contributor.' : round === 3 ? 'I am the primary operations owner for this same project.' : `Additional condition ${round}`
      : `Specific condition ${round}`;
    outcome = await subject.flow.answerAndResearch(subject.created.mapPath, question.id, { requestId: `coverage-answer-${round}`, selections: [question.aimQuestion.options[0].id], freeText }, 'gpt-6-luna', 'low');
    const saved = await subject.repo.readMap(subject.created.mapPath);
    const branch = saved.aim.branches.find(b => b.id === outcome.branchId);
    assert.equal(branch.results.filter(r => r.kind === 'research').length, 2);
    for (const result of branch.results.filter(r => r.kind === 'research')) assert.equal(saved.nodes.find(n => n.id === result.nodeId).parentId, branch.questionNodeId);
    if (round < 3) { assert.equal(outcome.status, 'waiting-user'); assert.equal(branch.results.some(r => r.kind === 'conclusion'), false); question = saved.nodes.find(n => n.id === outcome.questionNodeId); assert.equal(question.aimConvergesFromNodeIds, undefined); }
  }
  return outcome;
}
/** Ids of every registered language, read from the registry so a new language needs no test edit. */
const languageIds = () => load('i18n/languages.ts').LANGUAGES.map(item => item.id);
/** Dictionary text of the i18n facade plus every registered language file, for tests that scan translation keys and values. */
const i18nSource = (language) => [language ? [] : ['i18n.ts', ...languageIds().map(id => `i18n/${id}.ts`)], language ? [`i18n/${language}.ts`] : []].flat().map(file => require('node:fs').readFileSync(path.join(root, file), 'utf8')).join('\n');
module.exports = { i18nSource, languageIds, test, integrationTest, root, load, core, layout, logging, node, map, plain, plannerReview, seedCoverageAncestors, deliveryFixture, savedEvidenceNeedsSearch, researchGapAudit, aimPhase, auditEcho, tree, withExpansionCoordinator, TFolder, TFile, obsidian, Repository, DEFAULT_SETTINGS, normalizeReasoningLevel, fixture, topicNote, aimMapFixture, coffeeTypes, coffee, coffeePrompts, coffeeInsights, coffeeGuestInvitations, coffeeCustomization, coffeeConvergence, coffeeSession, coffeeTableList, coffeeTopics, deferred, until, coffeeElement, coffeeFind, withCoffeeModelDiscovery, reframingModalFixture, coverageModel, coverageSetup, coverageThreeAnswers };
