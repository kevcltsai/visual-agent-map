const assert = require('node:assert/strict');
const { test, integrationTest, load, core, map, plain, obsidian, DEFAULT_SETTINGS, fixture, topicNote } = require('../support.cjs');
test('AI result formatting always produces the canonical knowledge structure', async () => {
  const { canonicalDetail } = load('main.ts', { obsidian });
  const result = canonicalDetail('New analysis');
  for (const heading of ['核心結論', '關鍵知識', '證據與來源', '取捨與限制', '待確認事項', '更新紀錄']) assert.match(result, new RegExp(`### ${heading}`));
  assert.equal((result.match(/New analysis/g) || []).length, 1);
  const english = canonicalDetail('New analysis', 'en');
  for (const heading of ['Core conclusions', 'Key knowledge', 'Evidence and sources', 'Tradeoffs and limitations', 'Open questions', 'Update log']) assert.match(english, new RegExp(`### ${heading}`));
  assert.doesNotMatch(english, /核心結論|尚待補充|整理為結構化知識/);
  const bilingual = canonicalDetail('### 核心結論\n\n中文結論\n\n### 證據與來源\n\n[[來源.md]]', 'en');
  assert.equal((bilingual.match(/中文結論/g) || []).length, 1);
  assert.match(bilingual, /### Core conclusions\n\n中文結論/);
  assert.doesNotMatch(bilingual, /### 核心結論/);
  assert.doesNotMatch(bilingual, /To be added/);
});
test('AI visual references render as image cards', () => {
  const { visualReferencesMarkdown } = load('main.ts', { obsidian });
  const markdown = visualReferencesMarkdown([{ title: 'Navy + Beige', imageUrl: 'https://example.com/outfit.jpg', sourceUrl: 'https://example.com/page', description: '乾淨休閒穿搭', palette: ['navy', 'white', 'beige'], formula: '深色外套 + 白色內搭 + 淺色褲' }]);
  assert.match(markdown, /!\[Navy \+ Beige\]\(https:\/\/example.com\/outfit.jpg\)/);
  assert.match(markdown, /來源：https:\/\/example.com\/page/);
  assert.match(markdown, /配色：navy \/ white \/ beige/);
  const english = visualReferencesMarkdown([{ title: 'Map', imageUrl: 'https://example.com/map.jpg', sourceUrl: 'https://example.com/page', description: 'Route', palette: [], formula: '' }], 'en');
  assert.match(english, /Source: https:\/\/example.com\/page/);
  assert.doesNotMatch(english, /來源：|用途：/);
});
integrationTest('AI prompt defaults to the selected language across task modes', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
  const prompts = [];
  plugin.runtime = () => ({ runTask: async prompt => { prompts.push(prompt); return '{"summary":"done","detail":"details","suggestions":[],"visualReferences":[]}'; } });
  const context = { title: 'English topic', summary: 'English summary', rules: '', detail: '', task: 'Expand the map', ancestors: '', researchMode: 'local', researchDepth: 'fast', visualMode: 'off' };
  plugin.settings.language = 'en';
  for (const mode of ['task', 'decompose', 'synthesize']) await plugin.askModel({ ...context, mode }, 'test-model', 'low');
  for (const prompt of prompts) {
    assert.match(prompt, /Write newly generated content in English by default/);
    assert.doesNotMatch(prompt, /[一-龥]/);
  }
  assert.match(prompts[0], /### Core conclusions/);
  assert.match(prompts[0], /Insufficient information/);
  assert.doesNotMatch(prompts[0], /現有資料不足/);
  assert.doesNotMatch(prompts[0], /detail 必須是完整繁體中文/);
  plugin.settings.language = 'zh-TW';
  await plugin.askModel({ ...context, mode: 'task' }, 'test-model', 'low');
  assert.match(prompts[3], /新產生的內容預設使用繁體中文/);
  assert.match(prompts[3], /### 核心結論/);
});
integrationTest('Claude Code uses the shared task prompt and structured result parser without provider fallback', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
  let call;
  plugin.claudeCli = () => ({ runTask: async (...args) => { call = args; return JSON.stringify({ summary: 'Claude result', detail: 'Claude detail', suggestions: [], visualReferences: [] }); } });
  plugin.runtime = () => { assert.fail('Claude selection must not fall back to Codex'); };
  const result = await plugin.askModel({ title: 'Topic', summary: 'Existing summary', rules: '', detail: 'Full detail', task: 'One-run requirement', ancestors: '', mode: 'synthesize', researchMode: 'research', researchDepth: 'fast', visualMode: 'off' }, 'claude:sonnet', 'high');
  assert.equal(call[1], 'sonnet'); assert.equal(call[2], 'high');
  assert.match(call[0], /One-run requirement/); assert.match(call[0], /Full detail/);
  assert.ok(call[3] && typeof call[3] === 'object');
  assert.equal(call[4].searchBudget, 0);
  assert.equal(call[4].webSearch, true);
  assert.deepEqual(plain(result), { summary: 'Claude result', detail: 'Claude detail', suggestions: [], visualReferences: [] });
});
integrationTest('Claude Haiku is accepted by the AI task service and runs as the haiku alias', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
  let call;
  plugin.claudeCli = () => ({ runTask: async (...args) => { call = args; return JSON.stringify({ summary: 'Haiku result', detail: 'Haiku detail', suggestions: [], visualReferences: [] }); } });
  plugin.runtime = () => { assert.fail('Claude selection must not fall back to Codex'); };
  const result = await plugin.askModel({ title: 'Topic', summary: '', rules: '', detail: '', task: 'Haiku task', ancestors: '', mode: 'synthesize', researchMode: 'local', researchDepth: 'fast', visualMode: 'off' }, 'claude:haiku', 'medium');
  assert.equal(call[1], 'haiku'); assert.equal(call[2], 'medium');
  assert.equal(result.summary, 'Haiku result');
  assert.equal(plugin.modelLabel('claude:haiku'), 'Claude · Haiku');
  assert.equal(plugin.coffeeReasoningEfforts('claude:haiku').join(), 'low,medium,high');
});
integrationTest('AI response fallback keeps the language captured when the task started', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
  plugin.settings.language = 'en';
  plugin.runtime = () => ({ runTask: async () => {
    plugin.settings.language = 'zh-TW';
    return JSON.stringify({ summary: 'Done', detail: 'Details', suggestions: [], visualReferences: [{ imageUrl: 'https://example.com/image.jpg', sourceUrl: 'https://example.com' }] });
  } });
  const result = await plugin.askModel({ title: 'Topic', summary: '', rules: '', detail: '', task: 'Research', ancestors: '', mode: 'task', researchMode: 'local', visualMode: 'off' }, 'test-model', 'low');
  assert.equal(result.visualReferences[0].title, 'Visual reference');
});
test('hover helpers extract image and table from user notes markdown', () => {
  const { firstMarkdownImage, firstMarkdownTable, markdownImages } = load('main.ts', { obsidian });
  const markdown = '我的筆記\n\n![配色](https://example.com/style.jpg)\n![髮型](https://example.com/hair.jpg)\n![鞋子](https://example.com/shoes.jpg)\n![外套](https://example.com/jacket.jpg)\n![忽略](https://example.com/ignored.jpg)\n\n| 面向 | 判斷 |\n| --- | --- |\n| 顏色 | navy / beige |\n| 鞋子 | white sneakers |';
  const image = firstMarkdownImage(markdown);
  assert.equal(image.alt, '配色');
  assert.equal(image.url, 'https://example.com/style.jpg');
  assert.equal(markdownImages(markdown, 4).length, 4);
  assert.equal(markdownImages(markdown, 4)[3].alt, '外套');
  assert.equal(JSON.stringify(firstMarkdownTable(markdown)), JSON.stringify([['面向', '判斷'], ['顏色', 'navy / beige'], ['鞋子', 'white sneakers']]));
});
integrationTest('new notes omit inactive rules and working findings; clearing legacy findings removes the section', async () => {
  const { repo, contents } = fixture(), n = await topicNote(repo, 'Direct write', 'a');
  // Answer first: summary, Preview (when written), Detail; an empty Prompt is not written.
  assert.match(contents.get(n.path), /## Current Summary[\s\S]*## Detail/);
  assert.doesNotMatch(contents.get(n.path), /## 預覽|\[!info\]- 預覽/, 'an empty (placeholder) Preview is not written');
  assert.doesNotMatch(contents.get(n.path), /## Prompt/);
  assert.doesNotMatch(contents.get(n.path), /## Rules/);
  assert.doesNotMatch(contents.get(n.path), /## Working Findings/);
  await repo.updateNote(n.path, { newFindings: 'Legacy finding' });
  assert.match(contents.get(n.path), /## Working Findings\n\nLegacy finding/);
  await repo.updateNote(n.path, { newFindings: '' });
  assert.doesNotMatch(contents.get(n.path), /## Working Findings/);
  assert.equal((await repo.readNote(n.path)).newFindings, '');
});
integrationTest('the "no conclusion yet" placeholder in a task prompt follows the output language, not the interface language (D-2026-10-96)', async () => {
  const { isPlaceholder } = load('repository.ts', { obsidian });
  for (const [outputLanguage, expected, absent] of [['en', /No conclusion yet/, /尚未形成結論/], ['zh-TW', /尚未形成結論/, /No conclusion yet/]]) {
    const { repo, app } = fixture(), n = await topicNote(repo, 'How to plan a trip to Taipei', 'a'), root = await topicNote(repo, 'Root', 'a');
    n.parentId = root.id; await repo.updateNote(n.path, { prompt: 'Research this' });
    assert.equal(isPlaceholder((await repo.readNote(n.path)).summary), true);
    const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [root, n], viewport: { x: 0, y: 0, zoom: 1 } };
    await app.vault.create(mapPath, core.serializeMap(mapDoc));
    const { VisualAgentMapView } = load('main.ts', { obsidian }); let view, seen;
    const plugin = { repo, settings: { ...DEFAULT_SETTINGS, language: 'zh-TW' }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, activeTasks: new Map(), pendingSuggestions: new Map(),
      askModel: async context => { seen = context; const error = new Error('stop'); error.name = 'AbortError'; throw error; }, mutate: async work => work(), views: () => [view] };
    view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
    try { await view.runAgent(n, undefined, undefined, { task: 'Research it', outputLanguage }); } catch { /* the model call is the stop point */ }
    assert.ok(seen, 'the model was asked');
    assert.match(seen.summary, expected); assert.doesNotMatch(seen.summary, absent);
    assert.match(seen.ancestors, expected); assert.doesNotMatch(seen.ancestors, absent);
  }
});
integrationTest('a successful AI task immediately updates summary and MD detail', async () => {
  const { repo, app, contents } = fixture(), n = await topicNote(repo, 'Direct write', 'a');
  await repo.updateNote(n.path, { prompt: 'Research this', rules: 'Use a comparison table.', detail: 'Existing detail', newFindings: 'Legacy finding', sourcePaths: ['Other.md'] });
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [n], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian }); let view;
  let acceptedLaunch = false, acceptedSignal;
  let finishAi;
  const plugin = {
    repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, activeTasks: new Map(), pendingSuggestions: new Map(),
    askModel: (context, _model, _reasoning, signal, _onExchange, onAccepted) => { acceptedSignal = signal; assert.equal(context.mode, 'task'); assert.equal(context.task, 'One-time request'); assert.equal(context.rules, ''); assert.equal(context.detail, 'Existing detail'); assert.equal(context.workingFindings, 'Legacy finding'); assert.equal(context.sourceContext, ''); onAccepted?.(); return new Promise(resolve => { finishAi = () => resolve({ summary: 'Direct summary', detail: '### 核心結論\n\nDirect detail\n\n### 關鍵知識\n\nExisting detail; Legacy finding\n\n### 證據與來源\n\nSource\n\n### 取捨與限制\n\nNone\n\n### 待確認事項\n\nNone\n\n### 更新紀錄\n\n- Updated', suggestions: [] }); }); },
    rebuildDerivedData: async () => {}, mutate: async work => work(), views: () => [view]
  };
  view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  const run = view.runAgent(n, undefined, undefined, { task: 'One-time request' }, () => {
    acceptedLaunch = true;
    assert.ok(plugin.activeTasks.has(n.path)); assert.ok(plugin.running.has(n.path));
    assert.equal(acceptedSignal.aborted, false);
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acceptedLaunch, true);
  finishAi();
  await run; await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(acceptedLaunch, true); assert.equal(acceptedSignal.aborted, false);
  const updated = await repo.readNote(n.path);
  assert.equal(updated.prompt, 'Research this'); assert.equal(updated.summary, 'Direct summary'); assert.equal(updated.rules, 'Use a comparison table.');
  assert.equal(updated.status, 'completed');
  assert.equal(updated.newFindings, '');
  assert.match(updated.detail, /Direct detail/);
  assert.match(updated.detail, /Legacy finding/);
  assert.match(updated.detail, /Existing detail/);
  assert.doesNotMatch(contents.get(n.path), /## Working Findings/);
  assert.equal(updated.previewInitialized, true);
  await view.travel(false);
  const restored = await repo.readNote(n.path);
  assert.equal(restored.status, 'idea');
  assert.equal(restored.previewInitialized, false);
  assert.doesNotMatch(restored.previewSection, /Direct summary/);
  await view.travel(true);
  assert.equal((await repo.readNote(n.path)).previewInitialized, true);
});
integrationTest('cancelling a node task keeps its earlier Markdown and status', async () => {
  const { repo, app } = fixture(), n = await topicNote(repo, 'Cancel');
  await repo.updateNote(n.path, { prompt: 'Research', detail: 'Keep this' });
  const { VisualAgentMapView } = load('main.ts', { obsidian }); let view;
  const plugin = {
    repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, activeTasks: new Map(), pendingSuggestions: new Map(),
    askModel: (_context, _model, _reasoning, signal, _exchange, accepted) => { accepted?.(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { const error = new Error('cancelled'); error.name = 'AbortError'; reject(error); }, { once: true })); },
    mutate: async work => work(), views: () => [view]
  };
  view = new VisualAgentMapView({ app }, plugin); view.path = 'Map.md'; view.map = map([n]); view.render = () => {}; view.hydrate = async () => {};
  await view.runAgent(n);
  assert.equal((await repo.readNote(n.path)).status, 'running');
  plugin.activeTasks.get(n.path).abort();
  await new Promise(resolve => setTimeout(resolve, 20));
  const after = await repo.readNote(n.path);
  assert.equal(after.status, 'idea'); assert.equal(after.detail, 'Keep this'); assert.equal(plugin.activeTasks.size, 0);
});
integrationTest('prelaunch AI failures release task ownership and preserve startup errors', async () => {
  const { repo, app } = fixture(), n = await topicNote(repo, 'Startup cleanup');
  await repo.updateNote(n.path, { prompt: 'Research', detail: 'Keep this' });
  const { VisualAgentMapView } = load('main.ts', { obsidian }); let view;
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, activeTasks: new Map(), pendingSuggestions: new Map(), askModel: async () => { assert.fail('provider must not start'); }, mutate: async work => work(), views: () => [view] };
  view = new VisualAgentMapView({ app }, plugin); view.path = 'Map.md'; view.map = map([n]); view.render = () => {}; view.hydrate = async () => { throw new Error('hydrate failed'); };
  await assert.rejects(view.runAgent(n), /hydrate failed/);
  assert.equal((await repo.readNote(n.path)).status, 'idea'); assert.equal(plugin.activeTasks.size, 0); assert.equal(plugin.running.size, 0);

  const { repo: abortRepo, app: abortApp } = fixture(), abortNode = await topicNote(abortRepo, 'Abort startup cleanup');
  await abortRepo.updateNote(abortNode.path, { prompt: 'Research' });
  const originalUpdate = abortRepo.updateNote.bind(abortRepo); let enteredRunning = false;
  abortRepo.updateNote = async (path, patch) => {
    if (patch.status === 'running') enteredRunning = true;
    if (enteredRunning && patch.status === 'idea') throw new Error('status restore failed');
    return originalUpdate(path, patch);
  };
  const abortPlugin = { repo: abortRepo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, activeTasks: new Map(), pendingSuggestions: new Map(), askModel: async () => { assert.fail('provider must not start'); }, mutate: async work => work(), views: () => [abortView] }; let abortView;
  abortView = new VisualAgentMapView({ app: abortApp }, abortPlugin); abortView.path = 'Map.md'; abortView.map = map([abortNode]); abortView.render = () => {};
  abortView.hydrate = async () => { abortPlugin.activeTasks.get(abortNode.path).abort(); };
  await assert.rejects(abortView.runAgent(abortNode), /status restore failed/);
  assert.equal(abortPlugin.activeTasks.size, 0); assert.equal(abortPlugin.running.size, 0);
});
integrationTest('cancelling child synthesis restores the topic status and does not report a failure', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Synthesis parent');
  await repo.updateNote(parent.path, { status: 'completed', summary: 'Existing conclusion', detail: 'Existing knowledge' });
  const child = await topicNote(repo, 'Synthesis child');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [{ ...parent, status: 'completed' }, { ...child, parentId: parent.id }], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const controller = new AbortController(); let view, reported = '';
  const plugin = {
    repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, activeTasks: new Map(),
    askModel: (_context, _model, _reasoning, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { const error = new Error('cancelled'); error.name = 'AbortError'; reject(error); }, { once: true })),
    mutate: async work => work(), views: () => [view], recordFailure: (_context, error) => { reported = error.message; return error.message; }
  };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  const pending = view.integrateChildren(parent, { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [], signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await pending;
  const after = await repo.readNote(parent.path);
  assert.equal(after.status, 'completed'); assert.equal(after.summary, 'Existing conclusion'); assert.equal(after.detail, 'Existing knowledge');
  assert.equal(reported, ''); assert.equal(plugin.running.has(parent.path), false);
});
integrationTest('provider failure keeps its original AI log stage during node error writeback', async () => {
  const { repo, app } = fixture(), n = await topicNote(repo, 'Provider failure');
  await repo.updateNote(n.path, { prompt: 'Research' });
  const entry = { id: 'exchange-1', status: 'failed', error: '等待 AI 回覆：provider timeout' };
  const exchanges = { getEntries: () => [entry], failed: (_id, error) => { entry.error = error; } };
  let view;
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS, aiExchangeLoggingEnabled: true }, exchanges, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, activeTasks: new Map(), pendingSuggestions: new Map(),
    askModel: async (_context, _model, _reasoning, _signal, onExchange) => { onExchange(entry.id); throw new Error('provider timeout'); },
    mutate: async work => work(), views: () => [view], recordFailure: (_context, error) => error.message };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  view = new VisualAgentMapView({ app }, plugin); view.path = 'Map.md'; view.map = map([n]); view.render = () => {}; view.hydrate = async () => {};
  const originalError = console.error; console.error = () => {};
  try { await view.runAgent(n); await new Promise(resolve => setTimeout(resolve, 20)); }
  finally { console.error = originalError; }
  assert.equal((await repo.readNote(n.path)).status, 'error');
  assert.equal(entry.error, '等待 AI 回覆：provider timeout');
});
integrationTest('proposal persistence failure does not erase completed shallow research', async () => {
  const { repo, app } = fixture(), n = await topicNote(repo, 'Research result');
  await repo.updateNote(n.path, { prompt: 'Research' });
  const pending = new Map(); pending.flush = async () => { throw new Error('disk unavailable'); };
  let exchangeStatus = 'parsed', view, reported = '';
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS, aiExchangeLoggingEnabled: true }, exchanges: { completed: () => { exchangeStatus = 'completed'; }, getEntries: () => [{ id: 'exchange-1', status: exchangeStatus }], failed: () => { exchangeStatus = 'failed'; } }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, activeTasks: new Map(), pendingSuggestions: pending,
    askModel: async (_context, _model, _reasoning, _signal, onExchange) => { onExchange('exchange-1'); return { summary: 'Researched', detail: 'Result body', suggestions: [{ title: 'Proposal', task: 'Investigate', contribution: '' }], visualReferences: [] }; },
    mutate: async work => work(), views: () => [view], recordFailure: (_context, error) => { reported = error.message; return reported; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  view = new VisualAgentMapView({ app }, plugin); view.path = 'Map.md'; view.map = map([n]); view.render = () => {}; view.hydrate = async () => {};
  await view.runAgent(n); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await repo.readNote(n.path)).status, 'completed');
  assert.equal((await repo.readNote(n.path)).summary, 'Researched');
  assert.equal(exchangeStatus, 'completed'); assert.equal(reported, 'disk unavailable');
});
integrationTest('a completed but stale answer cannot overwrite an edited note', async () => {
  const { repo, app } = fixture(), n = await topicNote(repo, 'Stale');
  await repo.updateNote(n.path, { prompt: 'Research', detail: 'Original' });
  let finish; const { VisualAgentMapView } = load('main.ts', { obsidian }); let view;
  const plugin = {
    repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, activeTasks: new Map(), pendingSuggestions: new Map(),
    askModel: (_context, _model, _reasoning, _signal, _exchange, accepted) => { accepted?.(); return new Promise(resolve => { finish = resolve; }); }, mutate: async work => work(), views: () => [view]
  };
  view = new VisualAgentMapView({ app }, plugin); view.path = 'Map.md'; view.map = map([n]); view.render = () => {}; view.hydrate = async () => {};
  await view.runAgent(n);
  await repo.updateNote(n.path, { detail: 'User edit' });
  finish({ summary: 'Stale summary', detail: 'Stale detail', suggestions: [], visualReferences: [] });
  await new Promise(resolve => setTimeout(resolve, 20));
  const after = await repo.readNote(n.path);
  assert.equal(after.detail, 'User edit'); assert.equal(after.status, 'idea'); assert.notEqual(after.summary, 'Stale summary');
});
integrationTest('new child topics inherit reasoning without activating legacy rules', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'a');
  await repo.updateNote(parent.path, { rules: 'Use official sources and tables.', reasoning: 'high' });
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} });
  view.path = mapPath; view.map = mapDoc; view.render = () => {};
  await view.addNode(parent, 'Child');
  const child = (await repo.readMap(mapPath)).nodes.at(-1);
  assert.equal((await repo.readNote(child.path)).rules, '');
  assert.equal((await repo.readNote(child.path)).reasoning, 'high');
});
integrationTest('AI task timeout override reaches both providers with accurate non-Coffee timeout text', async () => {
  const { AiTaskService } = load('core/ai-task-service.ts');
  for (const model of ['gpt-6-luna', 'claude:sonnet']) {
    let seen;
    const runtime = { runTask: async (_p, _m, _e, _s, controls) => { seen = controls; return JSON.stringify({summary:'S',detail:'D',suggestions:[],visualReferences:[]}); } };
    const service = new AiTaskService({ pluginDirectory:()=>'/plugin', language:()=> 'en', defaultReasoning:()=> 'low', exchangeLoggingEnabled:()=>false, exchanges:()=>null, codexRuntime:()=>runtime, claudeRuntime:()=>runtime });
    const context = { title:'Goal', summary:'', rules:'', detail:'', task:'Write', ancestors:'', mode:'task', researchMode:'local', timeoutMs:600_000 };
    await service.askModel(context, model, 'low');
    assert.equal(seen.timeoutMs, 600_000);
    assert.match(seen.timeoutMessage, /10 minutes/);
    assert.ok(!seen.timeoutMessage.includes('Coffee'));
    await service.askModel({...context,timeoutMs:undefined}, model, 'low');
    assert.equal(seen.timeoutMs, undefined);
  }
});
integrationTest('AIM task timeout text follows the interface language while the prompt follows the content language', async () => {
  const { AiTaskService } = load('core/ai-task-service.ts');
  for (const [ui, content, pattern] of [['en', 'zh-TW', /exceeded 10 minutes/], ['zh-TW', 'en', /超過 10 分鐘/]]) {
    let seen;
    const runtime = { runTask: async (_p, _m, _e, _s, controls) => { seen = controls; return JSON.stringify({summary:'S',detail:'D',suggestions:[],visualReferences:[]}); } };
    const service = new AiTaskService({ pluginDirectory:()=>'/plugin', language:()=> ui, defaultReasoning:()=> 'low', exchangeLoggingEnabled:()=>false, exchanges:()=>null, codexRuntime:()=>runtime, claudeRuntime:()=>runtime });
    await service.askModel({ title:'Goal', summary:'', rules:'', detail:'', task:'Write', ancestors:'', mode:'task', researchMode:'local', timeoutMs:600_000, outputLanguage: content, promptProfile: 'aim' }, 'gpt-6-luna', 'low');
    assert.match(seen.timeoutMessage, pattern);
  }
});
test('summary truncation never leaves trailing whitespace and prefers a sentence boundary', () => {
  const { truncateSummary } = load('ai/result-utils.ts');
  const spaced = truncateSummary(`${'a'.repeat(79)} tail that continues past the limit`);
  assert.equal(spaced, spaced.trimEnd()); assert.ok(Array.from(spaced).length <= 80);
  const observed = truncateSummary('三個來源大致一致，公開版為 1.14.4（2026-10-05）；但 changelog 公開條目標為「1.14」，需注意 Catalyst 1.14.4 於 10/1 先行，且尚有標示差異。');
  assert.equal(observed, observed.trimEnd()); assert.ok(Array.from(observed).length <= 80); assert.match(observed, /…$/);
  assert.equal(truncateSummary(`${'第一句完整結論'.repeat(7)}。${'後續補充說明'.repeat(15)}`), `${'第一句完整結論'.repeat(7)}。`);
  assert.equal(truncateSummary('  Short.  '), 'Short.');
  assert.equal(Array.from(truncateSummary('字'.repeat(200))).length, 80);
});
test('search failure detection uses the structured status and still honours legacy wording', () => {
  const { reportedSearchFailure } = load('ai/result-utils.ts');
  assert.equal(reportedSearchFailure({ summary: '摘要', detail: '研究狀態：未搜尋', searchStatus: 'not_attempted' }), true);
  assert.equal(reportedSearchFailure({ summary: 's', detail: 'Findings https://example.org', searchStatus: 'failed' }), true);
  assert.equal(reportedSearchFailure({ summary: 's', detail: 'Findings https://example.org', searchStatus: 'completed' }), false);
  assert.equal(reportedSearchFailure({ summary: 's', detail: 'Source B — Research status: unavailable; Source A answered it.', searchStatus: 'completed' }), false);
  assert.equal(reportedSearchFailure({ summary: 's', detail: 'Research status: not searched' }), true);
  assert.equal(reportedSearchFailure({ summary: 's', detail: 'Research status: search completed' }), false);
});
integrationTest('isolated web research requests a structured search status and returns a trimmed summary', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
  let call;
  plugin.claudeCli = () => ({ runTask: async (...args) => { call = args; return JSON.stringify({ summary: `${'a'.repeat(79)} trailing words beyond the limit`, detail: 'Detail', suggestions: [], visualReferences: [], searchStatus: 'not_attempted' }); } });
  plugin.runtime = () => { assert.fail('Claude selection must not fall back to Codex'); };
  const result = await plugin.askModel({ title: 'AIM', summary: '', rules: '', detail: '', task: 'Search', ancestors: '', mode: 'task', researchMode: 'research', researchDepth: 'normal', visualMode: 'off', aimIsolatedResearch: true }, 'claude:sonnet', 'low');
  assert.ok(call[3].required.includes('searchStatus'));
  assert.deepEqual(plain(call[3].properties.searchStatus.enum), ['completed', 'failed', 'not_attempted']);
  assert.equal(result.searchStatus, 'not_attempted');
  assert.equal(result.summary, result.summary.trimEnd()); assert.ok(Array.from(result.summary).length <= 80);
  let localCall;
  plugin.claudeCli = () => ({ runTask: async (...args) => { localCall = args; return JSON.stringify({ summary: 'Local', detail: 'Local detail', suggestions: [], visualReferences: [] }); } });
  const local = await plugin.askModel({ title: 'Topic', summary: '', rules: '', detail: '', task: 'Plan', ancestors: '', mode: 'task', researchMode: 'local', visualMode: 'off', aimIsolatedResearch: true }, 'claude:sonnet', 'low');
  assert.equal(localCall[3].required.includes('searchStatus'), false);
  assert.equal('searchStatus' in local, false);
});
integrationTest('result draft readback accepts the Repository whitespace normalization', async () => {
  const { repo } = fixture('en');
  const { createAimMap } = load('experiences/aim/create-map.ts');
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'readback-normalization-map', topic: 'Readback normalization', context: 'Synthetic.' });
  const store = new AimRunStore(repo);
  const mapDoc = await repo.readMap(created.mapPath);
  const question = await repo.createNote('Readback question', 'gpt-6-luna', mapDoc, created.mapPath, 'workspace');
  question.aimKind = 'question';
  question.aimQuestion = { requestId: 'readback-question', parentBranchId: null, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], allowMultiple: false, allowFreeText: false };
  mapDoc.nodes.push(question); await repo.saveMap(created.mapPath, mapDoc);
  const branch = await store.createAnswerBranch(created.mapPath, { requestId: 'readback-answer', questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: ['a'], freeText: '' }, inputSnapshot: { topic: mapDoc.title, conditions: {}, upstreamResults: [] } });
  const attempt = await store.startAttempt(created.mapPath, branch.id, 'readback-run');
  const draft = (await store.createResultDraft(created.mapPath, attempt, 'Readback draft', 'gpt-6-luna', undefined, { kind: 'research' })).draft;
  assert.equal(await store.updateResultDraftReport(created.mapPath, attempt, draft.id, `${'a'.repeat(79)} `, '\nResearch status: search completed\nDetail with surrounding whitespace.\n\n'), true);
  const saved = await repo.readNote(draft.notePath);
  assert.equal(saved.summary, 'a'.repeat(79));
  assert.equal(saved.detail, 'Research status: search completed\nDetail with surrounding whitespace.');
  assert.equal(await store.updateResultDraftPresentation(created.mapPath, attempt, draft.id, ' Final synthesis title ', 'synthesis'), true);
});
integrationTest('task prompt uses the context template; no template keeps the Standard text', async () => {
  const { AiTaskService } = load('core/ai-task-service.ts');
  const templates = load('ai/detail-templates.ts');
  const teach = () => {
    const t = templates.copyTemplate(templates.standardTemplate('zh-TW'), '教學', 't1');
    t.sections[1] = { ...t.sections[1], name: '概念', aliases: ['關鍵知識', 'Key knowledge'] };
    t.sections.splice(2, 0, { id: 'ex', name: '範例', description: '', role: 'none', count: { mode: 'exact', n: 3 }, aliases: [] });
    t.sections = t.sections.filter(s => s.id !== 'tradeoffs');
    return t;
  };
  const prompts = [];
  const runtime = { runTask: async prompt => { prompts.push(prompt); return JSON.stringify({ summary: 'S', detail: 'D', suggestions: [], visualReferences: [] }); } };
  const service = new AiTaskService({ pluginDirectory: () => '/plugin', language: () => 'zh-TW', defaultReasoning: () => 'low', exchangeLoggingEnabled: () => false, exchanges: () => null, codexRuntime: () => runtime, claudeRuntime: () => runtime });
  const base = { title: 'Goal', summary: '', rules: '', detail: '', task: 'Write', ancestors: '', mode: 'task', researchMode: 'local', outputLanguage: 'zh-TW' };
  await service.askModel(base, 'gpt-6-luna', 'low');
  await service.askModel({ ...base, detailTemplate: teach() }, 'gpt-6-luna', 'low');
  assert.match(prompts[0], /### 核心結論, ### 關鍵知識/);
  assert.match(prompts[0], /依序使用以下六個三級標題/);
  assert.match(prompts[1], /### 範例 必須剛好有 3 個項目/);
  assert.match(prompts[1], /6 個三級標題/);
  assert.doesNotMatch(prompts[1], /### 取捨與限制/);
});
const countFixture = () => {
  const { AiTaskService } = load('core/ai-task-service.ts');
  const templates = load('ai/detail-templates.ts');
  const template = templates.copyTemplate(templates.standardTemplate('zh-TW'), '教學', 't1');
  template.sections.splice(2, 0, { id: 'ex', name: '範例', description: '', role: 'none', count: { mode: 'exact', n: 3 }, aliases: [] });
  const detailWith = (items, extra = '') => `### 核心結論\n\n- a\n\n### 範例\n\n${Array.from({ length: items }, (_, i) => `- ${i + 1}`).join('\n')}${extra}`;
  const reply = detail => JSON.stringify({ summary: 'S', detail, suggestions: [], visualReferences: [] });
  const prompts = [];
  const run = async (replies, { signal, input } = {}) => {
    const queue = [...replies];
    const runtime = { runTask: async prompt => { prompts.push(prompt); const next = queue.shift(); if (next instanceof Error) throw next; if (typeof next === 'function') return next(); return next; } };
    const service = new AiTaskService({ pluginDirectory: () => '/plugin', language: () => 'zh-TW', defaultReasoning: () => 'low', exchangeLoggingEnabled: () => false, exchanges: () => null, codexRuntime: () => runtime, claudeRuntime: () => runtime });
    const base = { title: 'Goal', summary: '', rules: '', detail: '', task: 'Write', ancestors: '', mode: 'task', researchMode: 'local', outputLanguage: 'zh-TW', detailTemplate: template, ...input };
    return service.askModel(base, 'gpt-6-luna', 'low', signal);
  };
  return { prompts, run, reply, detailWith };
};
integrationTest('enforced count met on first reply: no repair request, no issues', async () => {
  const { prompts, run, reply, detailWith } = countFixture();
  const result = await run([reply(detailWith(3))]);
  assert.equal(prompts.length, 1);
  assert.deepEqual(plain(result.formatIssues), []);
});
integrationTest('enforced count unmet: one repair request with the issue, fixed reply wins', async () => {
  const { prompts, run, reply, detailWith } = countFixture();
  const first = detailWith(2);
  const result = await run([reply(first), reply(detailWith(3))]);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /### 範例/);
  assert.match(prompts[1], /要求剛好 3 個，實際 2 個/);
  assert.ok(prompts[1].includes('- 2'), 'repair prompt carries the first reply as the previous detail');
  assert.equal((result.detail.match(/^- \d$/gm) || []).length, 3);
  assert.match(result.detail, /- 3/);
  assert.deepEqual(plain(result.formatIssues), []);
});
integrationTest('enforced count still unmet after repair: second result kept, issues reported, no third call', async () => {
  const { prompts, run, reply, detailWith } = countFixture();
  const result = await run([reply(detailWith(2)), reply(detailWith(1)), reply(detailWith(3))]);
  assert.equal(prompts.length, 2);
  assert.deepEqual(plain(result.formatIssues), [{ section: '範例', mode: 'exact', n: 3, actual: 1 }]);
});
integrationTest('repair request failure keeps the first result and reports its issues', async () => {
  const { prompts, run, reply, detailWith } = countFixture();
  const result = await run([reply(detailWith(2)), new Error('boom')]);
  assert.equal(prompts.length, 2);
  assert.match(result.detail, /- 2/);
  assert.deepEqual(plain(result.formatIssues), [{ section: '範例', mode: 'exact', n: 3, actual: 2 }]);
});
integrationTest('abort during repair propagates as AbortError', async () => {
  const { run, reply, detailWith } = countFixture();
  const controller = new AbortController();
  const abort = () => { controller.abort(); const error = new Error('Aborted'); error.name = 'AbortError'; throw error; };
  await assert.rejects(run([reply(detailWith(2)), abort], { signal: controller.signal }), error => error.name === 'AbortError');
});
integrationTest('count repair keeps a source footnote whose definition the repair reply omitted', async () => {
  const { prompts, run, reply, detailWith } = countFixture();
  const first = `${detailWith(2).replace('- a', '- a[^1]')}\n\n### 證據與來源\n\n[^1]: [[來源.md]]`;
  const second = detailWith(3).replace('- a', '- a[^1]');
  const result = await run([reply(first), reply(second)]);
  assert.equal(prompts.length, 2);
  assert.match(result.detail, /\[\^1\]: \[\[來源\.md\]\]/);
  assert.deepEqual(plain(result.formatIssues), []);
});
const exchangeFixture = () => {
  const { AiTaskService } = load('core/ai-task-service.ts');
  const templates = load('ai/detail-templates.ts');
  const template = templates.copyTemplate(templates.standardTemplate('zh-TW'), '教學', 't1');
  template.sections.splice(2, 0, { id: 'ex', name: '範例', description: '', role: 'none', count: { mode: 'exact', n: 3 }, aliases: [] });
  const detail = n => `### 核心結論\n\n- a\n\n### 範例\n\n${Array.from({ length: n }, (_, i) => `- ${i + 1}`).join('\n')}`;
  const reply = n => JSON.stringify({ summary: 'S', detail: detail(n), suggestions: [], visualReferences: [] });
  const status = {}; const seen = [];
  const exchanges = {
    milestones: () => {}, begin: e => { status[e.id] = 'begun'; seen.push(e.id); }, sent: id => { status[id] = 'sent'; }, received: id => { status[id] = 'received'; },
    parsed: id => { status[id] = 'parsed'; }, completed: id => { status[id] = 'completed'; }, failed: id => { status[id] = 'failed'; }
  };
  const run = async (replies, signal) => {
    const queue = [...replies];
    const runtime = { runTask: async () => { const next = queue.shift(); return typeof next === 'function' ? next() : next; } };
    const service = new AiTaskService({ pluginDirectory: () => '/plugin', language: () => 'zh-TW', defaultReasoning: () => 'low', exchangeLoggingEnabled: () => true, exchanges: () => exchanges, codexRuntime: () => runtime, claudeRuntime: () => runtime });
    let last = '';
    const base = { title: 'Goal', summary: '', rules: '', detail: '', task: 'Write', ancestors: '', mode: 'task', researchMode: 'local', outputLanguage: 'zh-TW', detailTemplate: template };
    const promise = service.askModel(base, 'gpt-6-luna', 'low', signal, id => { last = id; });
    return { promise, last: () => last };
  };
  return { run, reply, status, seen };
};
integrationTest('count repair leaves no exchange in the parsed state when the repair succeeds', async () => {
  const { run, reply, status, seen } = exchangeFixture();
  const { promise, last } = await run([reply(2), reply(3)]);
  await promise;
  assert.equal(seen.length, 2);
  assert.equal(status[seen[0]], 'completed');
  assert.equal(status[seen[1]], 'parsed');
  assert.equal(last(), seen[1]);
});
integrationTest('abort during count repair does not turn the first exchange into a failure', async () => {
  const { run, reply, status, seen } = exchangeFixture();
  const controller = new AbortController();
  const abort = () => { controller.abort(); const error = new Error('Aborted'); error.name = 'AbortError'; throw error; };
  const { promise } = await run([reply(2), abort], controller.signal);
  await assert.rejects(promise, error => error.name === 'AbortError');
  assert.equal(status[seen[0]], 'completed');
  assert.equal(status[seen[1]], 'failed');
});
integrationTest('count repair takes only the detail: first summary, suggestions and visual references survive', async () => {
  const { prompts, run, detailWith } = countFixture();
  const visual = { title: 'Pic', imageUrl: 'https://example.com/pic.jpg', sourceUrl: 'https://example.com/page', description: 'd', palette: [], formula: '' };
  const first = JSON.stringify({ summary: 'First summary', detail: detailWith(2), suggestions: [{ title: 'Keep me', task: 'Do it', contribution: '' }], visualReferences: [visual] });
  const repair = JSON.stringify({ summary: 'Repair summary', detail: detailWith(3), suggestions: [], visualReferences: [] });
  const result = await run([first, repair]);
  assert.equal(prompts.length, 2);
  assert.match(result.detail, /- 3/);
  assert.equal(result.summary, 'First summary');
  assert.deepEqual(plain(result.suggestions.map(s => s.title)), ['Keep me']);
  assert.deepEqual(plain(result.visualReferences.map(v => v.imageUrl)), ['https://example.com/pic.jpg']);
  assert.deepEqual(plain(result.formatIssues), []);
});

// ---- Segment B: observed main call, first-event watchdog and user re-send (fake clock, fake runtime) ----
function fakeClock() {
  const clock = { time: 0, timers: new Map(), next: 1 };
  clock.now = () => clock.time;
  clock.setTimeout = (callback, ms) => { const id = clock.next++; clock.timers.set(id, { at: clock.time + ms, callback }); return id; };
  clock.clearTimeout = id => { clock.timers.delete(id); };
  clock.advance = ms => {
    const target = clock.time + ms;
    for (;;) {
      const due = [...clock.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      clock.timers.delete(due[0]); clock.time = due[1].at; due[1].callback();
    }
    clock.time = target;
  };
  return clock;
}
function observedHarness({ attempts, logging = true } = {}) {
  const { AiTaskService } = load('core/ai-task-service.ts');
  const clock = fakeClock();
  const calls = [];
  const events = [];
  const entries = new Map();
  const exchanges = {
    begin: entry => entries.set(entry.id, { ...entry, status: 'preparing' }),
    sent: id => { entries.get(id).status = 'sent'; }, received: id => { entries.get(id).status = 'received'; },
    parsed: id => { entries.get(id).status = 'parsed'; }, completed: id => { entries.get(id).status = 'completed'; },
    failed: (id, error) => { Object.assign(entries.get(id), { status: 'failed', error }); },
    milestones: (id, data) => { entries.get(id).milestones = JSON.parse(JSON.stringify(data)); }
  };
  const answer = JSON.stringify({ summary: 'Synthetic summary', detail: 'Synthetic detail', suggestions: [], visualReferences: [] });
  const service = new AiTaskService({
    pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low', exchangeLoggingEnabled: () => logging, exchanges: () => exchanges, clock,
    codexRuntime: () => { throw new Error('unexpected provider'); },
    claudeRuntime: () => ({ runTask: (prompt, model, effort, schema, controls) => { const call = { prompt, controls, number: calls.length + 1 }; calls.push(call); return attempts(call); } })
  });
  const observer = {
    onAttempt: (id, number) => events.push(['attempt', number]), onStage: (id, stage, query) => events.push(['stage', stage, query]),
    onPreview: (id, fields) => events.push(['preview', fields]), onSlow: (id, slow, resend) => { events.push(['slow', slow]); observer.resend = resend; }
  };
  const context = { title: 'Synthetic topic', summary: '', rules: '', detail: '', task: 'Research the synthetic topic', ancestors: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off' };
  const ask = (signal, accepted) => service.askModel(context, 'claude:sonnet', 'low', signal, undefined, accepted, undefined, observer);
  const waitFor = async predicate => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve)); assert.ok(predicate(), 'condition reached'); };
  return { clock, calls, events, entries, observer, ask, answer, waitFor };
}
const abortOn = (signal, ignore = false) => new Promise((resolve, reject) => { if (!ignore) signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }))); });

test('W2: synthesize and merge are observed on the main request only; reference extraction (when the sources do not fit one batch) is not', async () => {
  const { AiTaskService } = load('core/ai-task-service.ts');
  const reply = JSON.stringify({ summary: 'S', detail: 'D', suggestions: [], visualReferences: [] });
  const run = async (mode, delivery, content) => {
    const calls = [];
    const service = new AiTaskService({ pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low', exchangeLoggingEnabled: () => false, exchanges: () => null, codexRuntime: () => { throw new Error('x'); },
      claudeRuntime: () => ({ runTask: async (prompt, _m, _e, _s, controls) => { calls.push({ prompt, stream: controls.stream }); controls.onStreamMode?.('stream-json'); controls.onAccepted?.(); return reply; } }) });
    const attempts = [];
    const context = { title: 'T', summary: '', rules: '', detail: '', task: 'Combine', ancestors: '', mode, researchMode: 'local', researchDepth: 'normal', visualMode: 'off', ...(delivery ? { referenceDelivery: delivery } : {}), referenceGroups: [{ id: 'g', name: 'Sources', location: 'Map.md', documents: [{ path: 'A.md', content }, { path: 'B.md', content: 'second' }] }] };
    await service.askModel(context, 'claude:sonnet', 'low', undefined, undefined, undefined, undefined, { onAttempt: id => attempts.push(id) });
    return { calls, attempts };
  };
  for (const mode of ['synthesize', 'merge']) {
    const direct = await run(mode, 'direct', 'short');
    assert.equal(direct.calls.length, 1, `${mode}: one request`); assert.equal(direct.calls[0].stream, true, `${mode}: the one request streams`); assert.equal(direct.attempts.length, 1);
    const extracted = await run(mode, 'direct', 'x'.repeat(18_001));
    assert.ok(extracted.calls.length >= 2, `${mode}: over-budget sources are extracted first`);
    assert.deepEqual(extracted.calls.slice(0, -1).map(call => call.stream), extracted.calls.slice(0, -1).map(() => undefined), `${mode}: extraction is not observed`);
    assert.equal(extracted.calls.at(-1).stream, true, `${mode}: the main request streams`); assert.equal(extracted.attempts.length, 1);
  }
  const old = await run('synthesize', undefined, 'short');
  assert.equal(old.calls.length, 2, 'without the direct flag a synthesis still extracts first'); assert.equal(old.calls[0].stream, undefined); assert.equal(old.calls[1].stream, true);
});
test('S3: 20 s without a model event shows the slow notice; re-send replaces the attempt with the same prompt and nothing from the old one counts', async () => {
  const h = observedHarness({ attempts: call => {
    call.controls.onStreamMode?.('stream-json'); call.controls.onAccepted();
    if (call.number === 1) return abortOn(call.controls.signal);
    call.controls.onFirstEvent(); call.controls.onStage('writing'); call.controls.onStructuredDelta({ summary: 'Syn', summaryComplete: false, detailComplete: false });
    return Promise.resolve(h.answer);
  } });
  let accepted = 0;
  const done = h.ask(undefined, () => { accepted++; });
  await h.waitFor(() => h.calls.length === 1);
  assert.equal(h.calls[0].controls.stream, true, 'an observed call asks for stream mode');
  h.clock.advance(19_999); assert.deepEqual(h.events.filter(e => e[0] === 'slow'), [], 'not before 20 s');
  h.clock.advance(1); assert.deepEqual(h.events.filter(e => e[0] === 'slow'), [['slow', true]]);
  const first = h.calls[0];
  h.observer.resend();
  const result = await done;
  assert.equal(result.summary, 'Synthetic summary');
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].prompt, first.prompt, 'the same prompt is sent again');
  assert.ok(first.controls.signal.aborted && !h.calls[1].controls.signal.aborted);
  assert.deepEqual(h.events.filter(e => e[0] === 'attempt'), [['attempt', 1], ['attempt', 2]]);
  assert.ok(accepted >= 1);
  // A late event from the replaced attempt reaches nobody.
  const before = h.events.length;
  first.controls.onStage('searching', 'late'); first.controls.onStructuredDelta({ summary: 'OLD' }); first.controls.onFirstEvent();
  assert.equal(h.events.length, before);
  const [one, two] = [...h.entries.values()];
  assert.equal(one.status, 'failed'); assert.match(one.error, /Resent by the user|使用者重新送出/);
  assert.equal(one.milestones.resentAs, two.id); assert.ok(one.milestones.slowShownAt); assert.ok(one.milestones.acceptedAt);
  assert.equal(two.milestones.resendOf, one.id); assert.equal(two.milestones.resentAs, undefined); assert.ok(two.milestones.firstEventAt);
  assert.notEqual(two.status, 'failed');
  // The new attempt's timer is its own: nothing fires once the first event arrived.
  h.clock.advance(60_000); assert.equal(h.events.filter(e => e[0] === 'slow').length, 1);
});

test('S3: the first event cancels the notice, and a notice already shown disappears when the event arrives', async () => {
  let release;
  const h = observedHarness({ attempts: call => { call.controls.onStreamMode?.('stream-json'); call.controls.onAccepted(); return new Promise(resolve => { release = () => resolve(h.answer); call.release = release; }); } });
  const done = h.ask();
  await h.waitFor(() => h.calls.length === 1);
  h.clock.advance(10_000); h.calls[0].controls.onFirstEvent(); h.clock.advance(60_000);
  assert.deepEqual(h.events.filter(e => e[0] === 'slow'), [], 'an early first event means no notice');
  release(); await done;
  const slow = observedHarness({ attempts: call => { call.controls.onStreamMode?.('stream-json'); call.controls.onAccepted(); return new Promise(resolve => { call.release = () => resolve(slow.answer); }); } });
  const second = slow.ask(); await slow.waitFor(() => slow.calls.length === 1);
  slow.clock.advance(20_000); slow.calls[0].controls.onStage('searching', 'q');
  assert.deepEqual(slow.events.filter(e => e[0] === 'slow'), [['slow', true], ['slow', false]]);
  assert.deepEqual(slow.events.filter(e => e[0] === 'stage'), [['stage', 'searching', 'q']]);
  slow.calls[0].release(); await second;
  assert.equal([...slow.entries.values()][0].milestones.slowShownAt !== undefined, true);
});

test('S3: json mode has no model events to wait for, so no notice is raised', async () => {
  const h = observedHarness({ attempts: call => { call.controls.onStreamMode?.('json'); call.controls.onAccepted(); return new Promise(resolve => { call.release = () => resolve(h.answer); }); } });
  const done = h.ask(); await h.waitFor(() => h.calls.length === 1);
  h.clock.advance(120_000); assert.deepEqual(h.events.filter(e => e[0] === 'slow'), []);
  h.calls[0].release(); await done;
});

test('S3: Stop wins over re-send, also when both happen together; the old exchange is not resent', async () => {
  const h = observedHarness({ attempts: call => { call.controls.onStreamMode?.('stream-json'); call.controls.onAccepted(); return abortOn(call.controls.signal); } });
  const stop = new AbortController();
  const done = h.ask(stop.signal);
  const outcome = done.then(() => 'resolved', error => error.name);
  await h.waitFor(() => h.calls.length === 1);
  h.clock.advance(20_000);
  h.observer.resend(); stop.abort();
  assert.equal(await outcome, 'AbortError');
  assert.equal(h.calls.length, 1, 'no attempt starts after Stop');
  const later = observedHarness({ attempts: call => { call.controls.onStreamMode?.('stream-json'); call.controls.onAccepted(); return abortOn(call.controls.signal); } });
  const stopLater = new AbortController(); const doneLater = later.ask(stopLater.signal); const outcomeLater = doneLater.then(() => 'resolved', error => error.name);
  await later.waitFor(() => later.calls.length === 1); later.clock.advance(20_000);
  stopLater.abort(); later.observer.resend();
  assert.equal(await outcomeLater, 'AbortError'); assert.equal(later.calls.length, 1);
});

test('S3: a runtime that ignores the abort cannot hold up the re-send, and its late result is discarded', async () => {
  const h = observedHarness({ attempts: call => {
    call.controls.onStreamMode?.('stream-json'); call.controls.onAccepted();
    if (call.number === 1) return new Promise(resolve => { call.late = () => resolve(JSON.stringify({ summary: 'OLD', detail: 'OLD', suggestions: [], visualReferences: [] })); });
    return Promise.resolve(h.answer);
  } });
  const done = h.ask(); await h.waitFor(() => h.calls.length === 1);
  h.clock.advance(20_000); h.observer.resend();
  assert.equal((await done).summary, 'Synthetic summary');
  const firstId = [...h.entries.keys()][0];
  assert.equal(h.entries.get(firstId).status, 'failed', 'the replaced attempt is marked failed');
  h.calls[0].late();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.entries.get(firstId).status, 'failed', 'its late reply does not flip the entry back to received');
  assert.match(h.entries.get(firstId).error, /./);
});

test('S3: there is no automatic re-send and only the main call is observed', async () => {
  const h = observedHarness({ attempts: call => { call.controls.onStreamMode?.('stream-json'); call.controls.onAccepted(); return new Promise(resolve => { call.release = () => resolve(h.answer); }); } });
  const done = h.ask(); await h.waitFor(() => h.calls.length === 1);
  h.clock.advance(10 * 60_000);
  assert.equal(h.calls.length, 1, 'waiting never sends again by itself');
  h.calls[0].release(); await done;
  // A call without an observer is a plain call: no stream request, no accepted wrapper needed.
  const { AiTaskService } = load('core/ai-task-service.ts'); let controls;
  const plain = new AiTaskService({ pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low', exchangeLoggingEnabled: () => false, exchanges: () => null, codexRuntime: () => { throw new Error('x'); }, claudeRuntime: () => ({ runTask: async (_p, _m, _e, _s, c) => { controls = c; return h.answer; } }) });
  await plain.askModel({ title: 'T', summary: '', rules: '', detail: '', task: 'Research', ancestors: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off' }, 'claude:sonnet', 'low');
  assert.equal(controls.stream, undefined);
});

// ---- AI mode Quick / Standard (D-2026-10-228..233, 239..248) --------------------------------------------------------
const quickBase = { title: 'Topic T', summary: 'Summary S', rules: '', detail: 'Detail D', task: 'Research the topic', ancestors: '', sourceContext: 'Source [S1]: a fact', mode: 'task', researchMode: 'local', researchDepth: 'normal', visualMode: 'off' };
const QUICK_MARKERS = { en: 'Model knowledge is insufficient', 'zh-TW': '模型知識不足', 'zh-CN': '模型知识不足' };
const promptOf = (context, language) => load('core/steps/task/render.ts', { obsidian }).generalTaskPrompt({ ...context, outputLanguage: language }, language, 'codex');
integrationTest('Quick prompt: the Quick source-safety and knowledge texts replace the local-research text; no web policy and no LOCAL_FIRST; the marker sentence is quoted in each language', () => {
  for (const language of ['en', 'zh-TW', 'zh-CN']) {
    const standard = promptOf({ ...quickBase, researchMode: 'research' }, language);
    const local = promptOf(quickBase, language);
    const quick = promptOf({ ...quickBase, mapAiMode: 'quick' }, language);
    assert.notEqual(quick, local); assert.notEqual(quick, standard);
    assert.ok(quick.includes(QUICK_MARKERS[language]), `${language}: the fixed marker sentence is in the Quick prompt`);
    assert.equal(local.includes(QUICK_MARKERS[language]), false, 'the old local text does not carry it');
    const t = load('i18n.ts').translate;
    assert.ok(local.includes(t(language, 'research.local')) && !quick.includes(t(language, 'research.local')), 'research.local is replaced');
    assert.equal(quick.includes(t(language, 'research.web')), false, 'no web policy');
    assert.equal(quick.includes(load('core/steps/_shared/fragments.ts').inLanguage(load('core/steps/_shared/fragments.ts').LOCAL_FIRST, language)), false, 'no LOCAL_FIRST');
    assert.ok(quick.includes('[S#]') || quick.includes('[S'), 'provided sources keep their [S#] markers');
  }
  // Standard is the current research text, byte for byte, whether or not the context says so.
  assert.equal(promptOf({ ...quickBase, researchMode: 'research', mapAiMode: 'standard' }, 'en'), promptOf({ ...quickBase, researchMode: 'research' }, 'en'));
  // Quick with a fast depth keeps the depth sentence and swaps only the knowledge text.
  const fast = promptOf({ ...quickBase, mapAiMode: 'quick', researchDepth: 'fast' }, 'en');
  assert.ok(fast.includes(load('i18n.ts').translate('en', 'research.fast'))); assert.equal(fast.includes(load('i18n.ts').translate('en', 'research.normal')), false);
});
integrationTest('Quick prompt guards: a helper request, an AIM prompt, a count repair or an intermediate extraction keeps the original source-safety and local-research text even with mapAiMode quick', () => {
  const cases = {
    synthesize: { mode: 'synthesize' }, merge: { mode: 'merge' }, decompose: { mode: 'decompose' },
    countRepair: { countRepair: true }, intermediateDetail: { intermediateDetail: true }
  };
  for (const [name, patch] of Object.entries(cases)) for (const language of ['en', 'zh-TW']) {
    const context = { ...quickBase, ...patch };
    assert.equal(promptOf({ ...context, mapAiMode: 'quick' }, language), promptOf(context, language), `${name}/${language}: unchanged by mapAiMode`);
    assert.equal(promptOf({ ...context, mapAiMode: 'quick' }, language).includes(QUICK_MARKERS[language]), false, `${name}/${language}: no Quick text`);
  }
  // AIM goes through its own shell, which never reads mapAiMode.
  const { taskPrompt } = load('core/steps/task/render.ts', { obsidian });
  const aim = { ...quickBase, promptProfile: 'aim', task: 'Research the subtopic', researchMode: 'research' };
  assert.equal(taskPrompt({ ...aim, mapAiMode: 'quick' }, 'en', 'codex'), taskPrompt(aim, 'en', 'codex'));
  // The only requests a Quick map research is allowed to change: a plain task, and it must be local.
  assert.equal(promptOf({ ...quickBase, researchMode: 'research', mapAiMode: 'quick' }, 'en'), promptOf({ ...quickBase, researchMode: 'research' }, 'en'), 'a web request with a stray quick flag is not Quick');
  const gate = load('core/steps/task/render.ts', { obsidian }).isQuickTask;
  assert.equal(gate({ ...quickBase, mapAiMode: 'quick' }), true);
  assert.equal(gate({ ...quickBase, mode: undefined, mapAiMode: 'quick' }), true, 'no mode means a task');
  for (const patch of [{ mapAiMode: 'standard' }, { mapAiMode: undefined }, { researchMode: 'research' }, { mode: 'synthesize' }, { promptProfile: 'aim' }, { countRepair: true }, { intermediateDetail: true }])
    assert.equal(gate({ ...quickBase, mapAiMode: 'quick', ...patch }), false, JSON.stringify(patch));
});
integrationTest('Quick research reaches the providers without any web tool; a Standard research from the dialog still hits the forced-web gate', async () => {
  const { aiModeOptions } = load('experiences/visual-map/ai-mode.ts');
  const make = () => {
    const { default: Plugin } = load('main.ts', { obsidian });
    const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
    const calls = [];
    const reply = JSON.stringify({ summary: 'S', detail: 'D', suggestions: [], visualReferences: [], searchStatus: 'completed' });
    plugin.claudeCli = () => ({ runTask: async (...args) => { calls.push({ provider: 'claude', prompt: args[0], options: args[4] }); return reply; } });
    plugin.runtime = (_directory, local) => ({ runTask: async (prompt, _model, _effort, _schema, options) => { calls.push({ provider: 'codex', local, prompt, options }); return reply; } });
    return { plugin, calls };
  };
  const research = (mode, kind = 'research') => ({ ...quickBase, sourceContext: undefined, ...aiModeOptions(mode, kind) });
  for (const model of ['claude:sonnet', 'gpt-test']) {
    const q = make(); await q.plugin.askModel(research('quick'), model, 'low');
    assert.equal(q.calls.length, 1, `${model}: one request`);
    assert.equal(q.calls[0].options.webSearch, false, `${model}: Quick has no web tools`);
    assert.equal('webSearchOnly' in q.calls[0].options, false, `${model}: Quick never takes the web-only thread`);
    if (model.startsWith('gpt')) assert.equal(q.calls[0].local, true, 'Codex runs the local (no network) runtime');
    assert.equal(q.calls[0].prompt.includes('Model knowledge is insufficient'), true);
    assert.equal(q.calls[0].prompt.includes('Use only the provided topic and source context'), false);
    const s = make(); await s.plugin.askModel(research('standard'), model, 'low');
    assert.equal(s.calls[0].options.webSearch, true, `${model}: Standard keeps the web`);
    assert.equal(s.calls[0].options.webSearchOnly, true, `${model}: Standard research of normal depth must search (B2 gate)`);
    assert.ok(s.calls[0].prompt.includes(load('i18n.ts').translate('en', 'research.web_required')) || s.calls[0].prompt.includes(load('i18n.ts').translate('zh-TW', 'research.web_required')));
  }
  // Known gap, deferred to Packet B (D-2026-10-248): a Standard subtopic research (short overview) has the web but is not forced to use it.
  const sub = make(); await sub.plugin.askModel(research('standard', 'subtopic'), 'claude:sonnet', 'low');
  assert.equal(sub.calls[0].options.webSearch, true); assert.equal('webSearchOnly' in sub.calls[0].options, false);
});
