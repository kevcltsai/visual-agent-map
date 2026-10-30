// Byte-exact prompt (and provider response schema) snapshots, English and Traditional Chinese.
// Compare mode is the default: any difference fails. UPDATE_PROMPT_SNAPSHOTS=1 rewrites tests/snapshots/prompts.
// tests/snapshots/prompts/index.json is the coverage table (snapshot -> builder/flow -> language -> i18n keys).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load: loadModule, loadSource, normalizeText, promptsFor, root } = require('./support-replay.cjs');
const support = require('./support.cjs');
const { runPanel } = require('./support-selection-ai.cjs');
const { captureAimPhaseVariants } = require('./support-aim-flow-capture.cjs');

const directory = path.join(__dirname, 'snapshots', 'prompts');
const update = process.env.UPDATE_PROMPT_SNAPSHOTS === '1';
// [language id, snapshot tag] for every registered language. The tag is the instruction language for the first language
// that uses it (so the files stay `.en.` / `.zh.`) and the language id for later ones (`.zh-CN.`).
const REGISTRY = loadRegistry();
const LANGUAGES = REGISTRY.map((entry, index) => [entry.id, REGISTRY.findIndex(other => other.instruction === entry.instruction) === index ? entry.instruction : entry.id]);
function loadRegistry() { return loadModule('i18n/languages.ts').LANGUAGES; }
const snapshots = new Map(); // name -> { prompt, schema, builder, language }

function record(name, builder, language, prompt, schema) {
  assert.ok(!snapshots.has(name), `duplicate snapshot ${name}`);
  snapshots.set(name, { builder, language, prompt: normalizeText(prompt), schema });
}
async function recordContext(name, builder, language, context, model) {
  const sent = await promptsFor(context, { language, ...(model ? { model } : {}) });
  assert.ok(sent.length >= 1, `${name}: no prompt reached the provider`);
  sent.forEach((call, index) => record(sent.length === 1 ? name : `${name}.${index + 1}`, builder, language, call.prompt, call.schema));
}

const base = { title: 'Topic T', summary: 'Current summary S', rules: 'Rule R', detail: 'Existing detail D', task: 'Do task X', ancestors: 'Ancestor A', workingFindings: 'Older finding F', sourceContext: 'Source [S1]: fact', mode: 'task', researchMode: 'research', researchDepth: 'normal', visualMode: 'auto' };

test('collect snapshots: AiTaskService general task prompt', async () => {
  for (const [language, tag] of LANGUAGES) {
    const ctx = { ...base, outputLanguage: language };
    await recordContext(`service.task-web.${tag}`, 'AiTaskService instructions: mode task, web research, visual auto', language, ctx);
    await recordContext(`service.task-web-visual-on.${tag}`, 'AiTaskService instructions: mode task, visual on', language, { ...ctx, visualMode: 'on' });
    await recordContext(`service.task-local-fast.${tag}`, 'AiTaskService instructions: mode task, local research, fast', language, { ...ctx, researchMode: 'local', researchDepth: 'fast' });
    // AI mode Quick (D-2026-10-228, 240): the Quick source-safety and knowledge texts replace the local research text; Standard prompts above are untouched.
    const quick = { ...ctx, researchMode: 'local', researchDepth: 'normal', visualMode: 'off', mapAiMode: 'quick' };
    await recordContext(`service.task-quick.${tag}`, 'AiTaskService instructions: Quick AI mode research (knowledge text, Quick source safety, no web, no images)', language, quick);
    await recordContext(`service.task-quick-subtopic.${tag}`, 'AiTaskService instructions: Quick AI mode subtopic research (short overview depth)', language, { ...quick, researchDepth: 'fast' });
    await recordContext(`service.decompose-deep.${tag}`, 'AiTaskService instructions: mode decompose, deep research', language, { ...ctx, mode: 'decompose', researchDepth: 'deep' });
    await recordContext(`service.synthesize-local.${tag}`, 'AiTaskService instructions: mode synthesize, local, visual off', language, { ...ctx, mode: 'synthesize', researchMode: 'local', visualMode: 'off' });
    await recordContext(`service.task-tone.${tag}`, 'AiTaskService instructions: mode task with a resolved tone text (B1)', language, { ...ctx, toneText: language === 'en' ? 'Tone: example voice. Write warmly.' : '寫作語氣：範例語氣。請溫暖地寫作。' });
    await recordContext(`service.task-textbook.${tag}`, 'AiTaskService instructions: mode task with the built-in Textbook template (intro, six sections, empty sections omitted)', language, { ...ctx, detailTemplate: loadModule('ai/detail-templates.ts').textbookTemplate(loadModule('i18n.ts').noteLanguageOf(language)) });
    await recordContext(`service.default-adaptive.${tag}`, 'AiTaskService instructions: no mode, adaptive detail, no sources', language, { ...ctx, mode: undefined, detailFormat: 'adaptive', sourceContext: undefined, workingFindings: undefined, detail: '', rules: '', ancestors: '' });
    await recordContext(`service.reference-groups.${tag}`, 'AiTaskService reference extraction then task', language, { ...ctx, sourceContext: undefined, referenceGroups: [{ id: 'g1', name: 'Group', location: '/refs', documents: [{ path: '/refs/a.md', content: 'Reference body A' }] }] });
  }
});

test('collect snapshots: topics whose language is read from the text (D-2026-10-94)', async () => {
  // The existing snapshots name an explicit language id; these two start from the topic text. An English topic with function
  // words is detected as en (the en path); a French topic keeps the follow-input row, whose clause quotes the topic.
  const { chooseAimContentLanguage } = loadModule('experiences/aim/content-language.ts');
  const english = 'How to plan a trip to Taipei', french = 'Histoire de la Révolution française';
  const englishLanguage = chooseAimContentLanguage('zh-TW', english), frenchLanguage = chooseAimContentLanguage('zh-TW', french);
  assert.equal(englishLanguage, 'en');
  assert.equal(frenchLanguage, 'same-as-input');
  await recordContext('service.task-topic-english.detected-en', 'AiTaskService instructions: general task, English topic detected as en (D-2026-10-94)', englishLanguage, { ...base, title: english, outputLanguage: englishLanguage });
  await recordContext('service.task-topic-french.follow-input', 'AiTaskService instructions: general task, French topic on the follow-input row with the anchored clause (D-2026-10-94)', frenchLanguage, { ...base, title: french, outputLanguage: frenchLanguage });
});

test('collect snapshots: AIM prompt builder per phase', async () => {
  const phases = ['research-gap-audit', 'initial-clarification', 'initial-question', 'research-plan', 'research-plan-repair', 'subtopic-research', 'targeted-followup-research', 'report-review', 'decision-quality-review', 'format-repair', 'delivery-outline', 'delivery-research', 'delivery-writing', 'delivery-acceptance'];
  const aimBase = { title: 'Goal G', summary: 'Summary S', rules: 'Rule R', detail: 'Reports D', ancestors: 'Known conditions C', workingFindings: 'Prior findings F', sourceContext: 'Source [S1]: fact', mode: 'task', promptProfile: 'aim', researchMode: 'local', researchDepth: 'normal', visualMode: 'off' };
  for (const [language, tag] of LANGUAGES) for (const phase of [undefined, ...phases]) {
    const task = phase ? `<!-- aim-phase: ${phase} -->\nPhase task text.` : 'Plain task text.';
    const research = ['subtopic-research', 'targeted-followup-research', 'delivery-research'].includes(phase);
    const context = { ...aimBase, task, outputLanguage: language, researchMode: research ? 'research' : 'local', ...(phase === 'research-gap-audit' ? { responseContract: 'aim-gap-audit' } : {}), ...(phase === 'delivery-acceptance' ? { responseContract: 'aim-delivery-acceptance' } : {}), ...(research ? { aimIsolatedResearch: true } : {}) };
    await recordContext(`aim-builder.${phase ?? 'no-phase'}.${tag}`, `buildAimPrompt via AiTaskService (phase ${phase ?? 'none'}, legacy marker contract)`, language, context);
  }
  for (const [language, tag] of LANGUAGES)
    await recordContext(`aim-builder.tone.${tag}`, 'buildAimPrompt via AiTaskService with a resolved tone text (B1)', language, { ...aimBase, task: 'Plain task text.', outputLanguage: language, toneText: language === 'en' ? 'Tone: example voice. Write warmly.' : '寫作語氣：範例語氣。請溫暖地寫作。' });
  const contracts = { intake: { kind: 'intake' }, 'question-required': { kind: 'question', requireQuestion: true }, 'question-optional': { kind: 'question', requireQuestion: false }, plan: { kind: 'plan' }, reuse: { kind: 'reuse' }, 'review-all': { kind: 'review', decisions: ['research_more', 'ask_user', 'conclude'] }, 'review-floor': { kind: 'review', decisions: ['research_more', 'ask_user'] }, outline: { kind: 'outline' }, 'delivery-research': { kind: 'delivery-research' } };
  for (const [name, contract] of Object.entries(contracts)) {
    const context = { ...aimBase, task: '<!-- aim-phase: report-review -->\nStructured contract task.', outputLanguage: 'en', aimContract: contract, aimEvidenceLookup: name === 'review-all', ...(name === 'delivery-research' ? { researchMode: 'research', aimIsolatedResearch: true } : {}) };
    await recordContext(`aim-contract.${name}.en`, `AiTaskService schema + structured-contract prompt (${contract.kind})`, 'en', context);
  }
});

test('collect snapshots: AIM flow phase tasks (manual-flow, final-delivery)', async () => {
  const subject = await support.coverageSetup('Snapshot goal');
  const first = new Map();
  const inner = subject.model.ask;
  const { AimManualFlow } = loadModule('experiences/aim/manual-flow.ts');
  const { AimRunStore } = loadModule('experiences/aim/research-run-store.ts');
  const ask = async context => {
    const phase = context.task.match(/aim-phase:\s*([a-z-]+)/)?.[1] ?? 'none';
    const key = phase === 'report-review' && /Hard floor: \d+ answered/.test(context.task) ? `${phase}-${first.has(phase) ? 'later' : 'first'}` : phase;
    if (!first.has(key)) first.set(key, { ...context, onProgress: undefined, signal: undefined });
    return inner(context);
  };
  subject.flow = new AimManualFlow(subject.repo, new AimRunStore(subject.repo), ask);
  await support.coverageThreeAnswers(subject);
  assert.ok(first.size >= 6, `expected several AIM phases, saw ${[...first.keys()].join(',')}`);
  for (const [phase, context] of [...first.entries()].sort(([a], [b]) => a.localeCompare(b)))
    for (const [language, tag] of LANGUAGES)
      await recordContext(`aim-flow.${phase}.${tag}`, `AimManualFlow/final-delivery phase ${phase} through AiTaskService`, language, { ...context, outputLanguage: language });
});

test('collect snapshots: AIM flow phase task variants (safety net before the templates move)', async () => {
  // Phase-task text assembled in manual-flow.ts and planner-review.ts, captured at the flow's model-call seam for every variant
  // the older test above does not reach. support-aim-flow-capture.cjs fails if any expected variant could not be driven.
  const variants = await captureAimPhaseVariants();
  for (const [variant, context] of [...variants.entries()].sort(([a], [b]) => a.localeCompare(b)))
    for (const [language, tag] of LANGUAGES)
      await recordContext(`aim-flow.${variant}.${tag}`, `AimManualFlow/planner-review phase task variant ${variant} through AiTaskService`, language, { ...context, outputLanguage: language });
});

test('collect snapshots: Visual Map expansion and synthesis tasks', async () => {
  const { VisualAgentMapView } = support.load('main.ts', { obsidian: support.obsidian });
  for (const [language, tag] of LANGUAGES) {
    const { repo, app } = support.fixture(language), parent = await support.topicNote(repo, 'Parent topic', 'model-a');
    await repo.updateNote(parent.path, { summary: 'Parent summary', detail: 'Parent detail' });
    const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = support.map([parent]); mapDoc.id = 'map-a';
    await app.vault.create(mapPath, support.core.serializeMap(mapDoc));
    const child = await repo.createNote('Child topic', 'model-a', mapDoc, mapPath, 'workspace'); child.parentId = parent.id; mapDoc.nodes.push(child);
    await repo.updateNote(child.path, { summary: 'Child summary', detail: 'Child detail', newFindings: 'Child finding', visualReferences: '![diagram](https://example.org/diagram.png)' });
    const contexts = [];
    const plugin = support.withExpansionCoordinator({ repo, settings: { ...support.DEFAULT_SETTINGS, language }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (_label, error) => error.message,
      askModel: async context => { contexts.push({ kind: contexts.kind === 'merge-draft' && context.detail ? 'merge-repair' : contexts.kind, context }); return { summary: 'S', detail: 'D', visualReferences: [], suggestions: contexts.suggestions ?? [] }; } });
    const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {}; view.ancestorContext = async () => 'Ancestor chain A';
    const options = { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], shallowResearch: false, outputLanguage: language };
    contexts.kind = 'guided';
    await view.proposeChildren(parent, options, 'Focus on risks', () => {}, () => {}).catch(() => {});
    contexts.kind = 'guided-empty-direction';
    await view.proposeChildren(parent, options, '', () => {}, () => {}).catch(() => {});
    contexts.kind = 'synthesis-directions';
    contexts.suggestions = [{ title: 'Direction one', task: 't', contribution: 'c' }];
    const synthesisOptions = { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', requirements: 'Only compare cost', referenceGroups: [], outputLanguage: language };
    await view.proposeIntegrationDirections(parent, synthesisOptions, () => {}, message => { throw new Error(message); });
    contexts.kind = 'synthesis-draft-default-goal';
    // The draft step (no chosen direction) is written directly; the prompt it sends is what is snapshotted.
    await view.integrateChildren(parent, synthesisOptions, '', () => {}, message => { throw new Error(message); });
    // AI merge of two sibling topics (prompt.merge_goal): the sources go in as one reference group, without Thinking Origin.
    const second = await repo.createNote('Second child', 'model-a', mapDoc, mapPath, 'workspace'); second.parentId = parent.id; mapDoc.nodes.push(second);
    await repo.updateNote(second.path, { summary: 'Second summary', detail: 'Second detail', thinkingOrigin: 'Origin never sent' });
    view.notes = new Map(await Promise.all(mapDoc.nodes.map(async item => [item.id, await repo.readNote(item.path, mapDoc)])));
    plugin.confirmAiUsage = async (_model, run) => { await run(); return true; };
    contexts.kind = 'merge-draft';
    await view.startMergeDraft('Merged child', { path: mapPath, mapId: 'map-a', parentId: parent.id, sources: [child, second].map(item => ({ id: item.id, path: item.path })) }, () => {}, new AbortController().signal);
    await view.mergeTasks.get(mapPath).run;
    assert.doesNotMatch(JSON.stringify(contexts.at(-1).context), /Origin never sent/);
    const seen = new Set();
    for (const { kind, context } of contexts) {
      if (seen.has(kind)) continue; seen.add(kind);
      assert.ok(context.task.length > 0);
      await recordContext(`view.${kind}.${tag}`, `VisualAgentMapView ${kind} TaskContext through AiTaskService`, language, { ...context, onProgress: undefined, signal: undefined, addCharts: undefined }); // the chart step is a separate call, snapshotted as chart.add below
    }
    assert.ok(seen.has('guided') && seen.has('synthesis-directions') && seen.has('merge-draft') && seen.has('merge-repair'), `view cases captured: ${[...seen].join(',')}`);
  }
});

test('collect snapshots: Coffee Tables, Reframe, Markdown context', async () => {
  // One bundle, so the Coffee modules and setUiLanguage share the same interface-language state (Coffee names the table language from it).
  const coffeeModules = loadSource(`export * as i18n from './i18n'; export * as prompts from './experiences/coffee-tables/prompts'; export * as types from './experiences/coffee-tables/types'; export * as engine from './experiences/coffee-tables/engine'; export * as customization from './experiences/coffee-tables/customization'; export { convergenceStep } from './experiences/coffee-tables/steps/convergence/step';`);
  const prompts = coffeeModules.prompts, types = coffeeModules.types;
  const customization = coffeeModules.customization;
  const { convergenceStep } = coffeeModules;
  for (const [language, tag] of LANGUAGES) {
    coffeeModules.i18n.setUiLanguage(language);
    const noteLanguage = coffeeModules.i18n.noteLanguageOf(language); // a session stores the note language; the table speaks the interface language
    const topic = language === 'en' ? 'Should lunches allow parent top-ups' : '營養午餐是否開放家長加價';
    const session = types.createSession(topic, 'test-model', 'high', noteLanguage);
    session.id = 'session-fixed'; session.createdAt = '2026-01-01T00:00:00.000Z'; session.updatedAt = session.createdAt;
    record(`coffee.table-opening.${tag}`, 'coffee-tables/prompts.ts tablePrompt (opening, default guests)', language, prompts.tablePrompt(topic, noteLanguage));
    record(`coffee.table-continue.${tag}`, 'coffee-tables/prompts.ts tablePrompt (draft + prior context + invited guest)', language, prompts.tablePrompt(topic, noteLanguage, session.guests, 'Unfinished draft text', 'Prior discussion text', [{ id: 'g1', name: 'Guest Name', category: 'experts', description: 'Guest background' }]));
    record(`coffee.opening-preview.${tag}`, 'coffee-tables/prompts.ts openingPromptPreview', language, prompts.openingPromptPreview(topic, noteLanguage, session.guests));
    session.status = 'completed';
    session.rounds = [{ id: 'round-1', createdAt: session.createdAt, status: 'completed', markdown: '### Host|Host\nOpening line one.\n\n### Expert|Expert\nSecond speaker line.', notes: '' }];
    session.interventions = [{ id: 'iv-1', roundId: 'round-1', afterTurn: 1, text: 'User intervention text', createdAt: session.createdAt }];
    record(`coffee.question.${tag}`, 'coffee-tables/prompts.ts questionPrompt', language, prompts.questionPrompt(session, 'Follow-up question text', 'Earlier answer draft'));
    record(`coffee.observer-only.${tag}`, 'coffee-tables/prompts.ts observerOnlyPrompt', language, prompts.observerOnlyPrompt(session));
    session.questions = [{ id: 'question-1', question: 'Follow-up question text', answer: 'Answer text for the follow-up.', status: 'complete', createdAt: '2026-01-01T00:00:01.000Z' }];
    const navigation = [];
    const navigationEngine = new coffeeModules.engine.CoffeeEngine(JSON.parse(JSON.stringify(session)), async request => { navigation.push(request.prompt); return ''; }, async () => {});
    await navigationEngine.fillSegmentSummaries();
    assert.equal(navigation.length, 1, 'navigation summary prompt reached the provider once');
    record(`coffee.navigation-summary.${tag}`, 'coffee-tables/engine.ts fillSegmentSummaries (navigation summary request)', language, navigation[0]);
    session.questions = [];
    const baseline = [{ id: 'insight-1', category: 'connections', summary: 'Insight summary one', detail: 'Insight detail one', sources: ['source quote'], question: '', proposedSolution: '', limitations: '' }, { id: 'insight-2', category: 'questions', summary: 'Insight summary two', detail: 'Insight detail two', sources: [], question: '', proposedSolution: '', limitations: '' }];
    session.pinnedInsightIds = ['insight-2'];
    record(`coffee.convergence.${tag}`, 'coffee-tables/convergence.ts convergencePrompt', language, convergenceStep.render({ session, baseline, customization: customization.defaultCustomization(noteLanguage) }));
  }
  coffeeModules.i18n.setUiLanguage('en');
  const { buildReframePrompt } = support.load('core/reframing-service.ts', { obsidian: support.obsidian });
  for (const [language, tag] of LANGUAGES) record(`reframe.${tag}`, 'core/reframing-service.ts buildReframePrompt', language, buildReframePrompt({ language, question: 'Direction question', context: 'Direction context', source: 'Source thinking text' }));
  // Share translation prompts are written in English for every target; the target and source languages are named inside.
  const { buildShareTranslatePrompt, buildShareTranslateLabelsPrompt, SHARE_TRANSLATE_SCHEMA } = support.load('experiences/sharing/share-translate-service.ts', { obsidian: support.obsidian });
  const shareItems = [{ id: '1', text: 'Heat changes \u27e61/\u27e7 and \u27e62\u27e7starches\u27e6/2\u27e7.' }, { id: '2', text: 'Roast' }];
  const shareLabels = [{ id: '1', text: 'Start here' }, { id: '2', text: 'Heat the pan' }];
  for (const target of ['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'es']) {
    const sourceLanguage = target === 'en' ? 'zh-TW' : 'en';
    record(`share-translate.target-${target}`, 'experiences/sharing/share-translate-service.ts buildShareTranslatePrompt', target, buildShareTranslatePrompt({ items: shareItems, sourceLanguage, targetLanguage: target, model: 'm', reasoning: 'low' }), SHARE_TRANSLATE_SCHEMA);
    record(`share-translate-labels.target-${target}`, 'experiences/sharing/share-translate-service.ts buildShareTranslateLabelsPrompt', target, buildShareTranslateLabelsPrompt({ items: shareLabels, sourceLanguage, targetLanguage: target, model: 'm', reasoning: 'low' }), SHARE_TRANSLATE_SCHEMA);
  }
  const { buildOutlineGeneratePrompt } = support.load('core/outline-generation-service.ts', { obsidian: support.obsidian });
  const { buildStructureReviewPrompt, STRUCTURE_REVIEW_SCHEMA } = support.load('core/structure-review-service.ts', { obsidian: support.obsidian });
  const { buildRelevanceGradePrompt, RELEVANCE_GRADE_SCHEMA, relevanceGradeRepairStep, relevanceGradeMissingRepairStep, RELEVANCE_RECALIBRATE_SCHEMA, relevanceRecalibrateStep, relevanceRecalibrateRepairStep } = support.load('core/relevance-grade-service.ts', { obsidian: support.obsidian });
  const reviewNodes = [{ id: 'n1', title: 'Root topic', summary: 'Root summary', status: 'completed', parentId: null, depth: 0 }, { id: 'n2', title: 'Child topic', summary: 'Child summary', status: 'idea', parentId: 'n1', depth: 1 }];
  const { buildMapChatPrompt, MAP_CHAT_SCHEMA } = support.load('core/map-chat-service.ts', { obsidian: support.obsidian });
  const { buildMapChatContext } = support.load('core/map-chat-context.ts', { obsidian: support.obsidian });
  const chatOutline = [{ id: 'n1', title: 'Root topic', summary: 'Root summary', parentId: null, depth: 0 }, { id: 'n2', title: 'Child topic', summary: 'Child summary', parentId: 'n1', depth: 1 }];
  const chatContext = buildMapChatContext({ mapTitle: 'Map title', outline: chatOutline, selected: [{ id: 'n2', title: 'Child topic', summary: 'Child summary', detail: 'Child detail text', path: 'Maps/Notes/Child topic.md' }], references: [{ id: 'n1', title: 'Root topic', summary: 'Root summary', detail: 'Root detail text', path: 'Maps/Notes/Root topic.md' }], snippets: [{ path: 'Notes/Draft.md', text: 'Snippet text', pathGuessed: true }], files: [{ path: 'Notes/File.md', content: 'File body text' }], activeFile: { path: 'Notes/Active.md', content: 'Active body text' }, history: [{ role: 'user', text: 'Earlier question' }, { role: 'assistant', text: 'Earlier answer' }] });
  for (const [language, tag] of LANGUAGES) {
    record(`outline-generate.${tag}`, 'core/outline-generation-service.ts buildOutlineGeneratePrompt (preset with topic placeholder)', language, buildOutlineGeneratePrompt({ language, topic: 'Topic under study', presetText: 'Build a knowledge tree for {填入研究主題} in three levels.', model: 'm', reasoning: 'low' }));
    record(`outline-generate-appended.${tag}`, 'core/outline-generation-service.ts buildOutlineGeneratePrompt (preset without placeholder)', language, buildOutlineGeneratePrompt({ language, topic: 'Topic under study', presetText: 'Build a knowledge tree in three levels.', model: 'm', reasoning: 'low' }));
    record(`structure-review.${tag}`, 'core/structure-review-service.ts buildStructureReviewPrompt', language, buildStructureReviewPrompt({ language, rootQuestion: 'Root question text', nodes: reviewNodes, model: 'm', reasoning: 'low' }), STRUCTURE_REVIEW_SCHEMA);
    record(`map-chat.${tag}`, 'core/map-chat-service.ts buildMapChatPrompt', language, buildMapChatPrompt({ language, message: 'Add two subtopics under the child topic', context: chatContext, model: 'm', reasoning: 'low' }), MAP_CHAT_SCHEMA);
    record(`map-chat-detailed.${tag}`, 'core/map-chat-service.ts buildMapChatPrompt (detailed style)', language, buildMapChatPrompt({ language, message: 'Add two subtopics under the child topic', context: chatContext, model: 'm', reasoning: 'low', style: 'detailed' }), MAP_CHAT_SCHEMA);
    record(`map-chat-redo.${tag}`, 'core/map-chat-service.ts buildMapChatPrompt (detailed re-send of an answered question)', language, buildMapChatPrompt({ language, message: 'Add two subtopics under the child topic', context: chatContext, model: 'm', reasoning: 'low', style: 'detailed', redo: true }), MAP_CHAT_SCHEMA);
    record(`relevance-grade.${tag}`, 'core/relevance-grade-service.ts buildRelevanceGradePrompt', language, buildRelevanceGradePrompt({ language, goal: 'Learner goal text', nodes: reviewNodes, model: 'm', reasoning: 'low' }), RELEVANCE_GRADE_SCHEMA);
    record(`relevance-grade-repair.${tag}`, 'core/relevance-grade-service.ts relevanceGradeRepairStep.render (one hierarchy violation)', language, relevanceGradeRepairStep.render({ language, goal: 'Learner goal text', nodes: reviewNodes, model: 'm', reasoning: 'low', previousReply: { items: [{ id: 'n2', tier: 'core' }] }, violations: [{ childId: 'n2', childTier: 'core', parentId: 'n1', parentTier: 'support' }] }), RELEVANCE_GRADE_SCHEMA);
    // Pinned cards: n3 under n2 is pinned core, n4 under n2 is graded, n5 is a second child of the top-level card.
    const pinNodes = [...reviewNodes, { id: 'n3', title: 'Pinned grandchild', summary: 'Pinned summary', status: 'idea', parentId: 'n2', depth: 2 }, { id: 'n4', title: 'Open grandchild', summary: '', status: 'idea', parentId: 'n2', depth: 2 }, { id: 'n5', title: 'Second child', summary: 'Second summary', status: 'idea', parentId: 'n1', depth: 1 }];
    const pinned = { language, goal: 'Learner goal text', nodes: pinNodes, model: 'm', reasoning: 'low', pins: [{ id: 'n3', tier: 'core' }] };
    record(`relevance-grade-pinned.${tag}`, 'core/relevance-grade-service.ts buildRelevanceGradePrompt (one pinned card)', language, buildRelevanceGradePrompt(pinned), RELEVANCE_GRADE_SCHEMA);
    record(`relevance-grade-repair-pinned.${tag}`, 'core/relevance-grade-service.ts relevanceGradeRepairStep.render (one pinned card, bounds violation)', language, relevanceGradeRepairStep.render({ ...pinned, previousReply: { items: [{ id: 'n2', tier: 'support', anchor: 'n3' }, { id: 'n4', tier: 'side' }, { id: 'n5', tier: 'core' }] }, violations: [{ childId: 'n3', childTier: 'core', parentId: 'n2', parentTier: 'support' }] }), RELEVANCE_GRADE_SCHEMA);
    record(`relevance-grade-repair-missing.${tag}`, 'core/relevance-grade-service.ts relevanceGradeMissingRepairStep.render (a bounded card left out)', language, relevanceGradeMissingRepairStep.render({ ...pinned, previousReply: { items: [{ id: 'n4', tier: 'support' }, { id: 'n5', tier: 'core' }] }, violations: [], missing: ['n2'] }), RELEVANCE_GRADE_SCHEMA);
    const recal = { ...pinned, previous: [{ id: 'n2', tier: 'support' }, { id: 'n4', tier: 'support' }] };
    record(`relevance-recalibrate.${tag}`, 'core/relevance-grade-service.ts relevanceRecalibrateStep.render (one pinned card, one card not graded yet)', language, relevanceRecalibrateStep.render(recal), RELEVANCE_RECALIBRATE_SCHEMA);
    record(`relevance-recalibrate-repair.${tag}`, 'core/relevance-grade-service.ts relevanceRecalibrateRepairStep.render (bounds violation)', language, relevanceRecalibrateRepairStep.render({ ...recal, previousReply: { items: [{ id: 'n5', tier: 'core' }] }, violations: [{ childId: 'n3', childTier: 'core', parentId: 'n2', parentTier: 'support' }] }), RELEVANCE_RECALIBRATE_SCHEMA);
    // Claude gets the StructuredOutput wording (no "Reply with ONLY", no "use tools"); the Codex snapshots above keep the old sentences.
    const claudeModel = 'claude:sonnet';
    record(`claude.relevance-grade.${tag}`, 'core/relevance-grade-service.ts buildRelevanceGradePrompt for Claude (StructuredOutput wording, no reason)', language, buildRelevanceGradePrompt({ language, goal: 'Learner goal text', nodes: reviewNodes, model: claudeModel, reasoning: 'low' }), RELEVANCE_GRADE_SCHEMA);
    record(`claude.relevance-grade-pinned.${tag}`, 'core/relevance-grade-service.ts buildRelevanceGradePrompt for Claude (one pinned card)', language, buildRelevanceGradePrompt({ ...pinned, model: claudeModel }), RELEVANCE_GRADE_SCHEMA);
    record(`claude.relevance-grade-repair.${tag}`, 'core/relevance-grade-service.ts relevanceGradeRepairStep.render for Claude (one hierarchy violation)', language, relevanceGradeRepairStep.render({ language, goal: 'Learner goal text', nodes: reviewNodes, model: claudeModel, reasoning: 'low', previousReply: { items: [{ id: 'n2', tier: 'core' }] }, violations: [{ childId: 'n2', childTier: 'core', parentId: 'n1', parentTier: 'support' }] }), RELEVANCE_GRADE_SCHEMA);
    record(`claude.relevance-grade-repair-missing.${tag}`, 'core/relevance-grade-service.ts relevanceGradeMissingRepairStep.render for Claude (a bounded card left out)', language, relevanceGradeMissingRepairStep.render({ ...pinned, model: claudeModel, previousReply: { items: [{ id: 'n4', tier: 'support' }, { id: 'n5', tier: 'core' }] }, violations: [], missing: ['n2'] }), RELEVANCE_GRADE_SCHEMA);
    record(`claude.relevance-recalibrate.${tag}`, 'core/relevance-grade-service.ts relevanceRecalibrateStep.render for Claude', language, relevanceRecalibrateStep.render({ ...recal, model: claudeModel }), RELEVANCE_RECALIBRATE_SCHEMA);
    record(`claude.relevance-recalibrate-repair.${tag}`, 'core/relevance-grade-service.ts relevanceRecalibrateRepairStep.render for Claude (bounds violation)', language, relevanceRecalibrateRepairStep.render({ ...recal, model: claudeModel, previousReply: { items: [{ id: 'n5', tier: 'core' }] }, violations: [{ childId: 'n3', childTier: 'core', parentId: 'n2', parentTier: 'support' }] }), RELEVANCE_RECALIBRATE_SCHEMA);
  }
  const { planStep } = support.load('experiences/markdown-context/steps/plan/step.ts', { obsidian: support.obsidian });
  const planPrompt = (instruction, selected, context, hasImage) => planStep.render({ instruction, selected, context, hasImage });
  record('markdown-context.plan-text', 'markdown-context/action-plan.ts planPrompt (not localized)', 'none', planPrompt('Rewrite this', 'Selected text', 'Nearby context', false));
  record('markdown-context.plan-image', 'markdown-context/action-plan.ts planPrompt with image (not localized)', 'none', planPrompt('Describe this', 'Selected text', 'Nearby context', true));
  // runPrompt is private to selection-ai.ts: drive the real panel and read what it sends through its `run` seam.
  const planReply = JSON.stringify({ action: 'transform', query: '', instruction: 'Make the selected text shorter', placement: 'after', captionInstruction: '' });
  const sentByPanel = await runPanel({ markdown: 'Intro line.\nSelected sentence here.\nOutro line.', selected: 'Selected sentence here.', replies: [planReply, 'Shorter.'] });
  assert.equal(sentByPanel.length, 2, 'the panel asked for a plan, then for the transformation');
  record('markdown-context.run-prompt', 'markdown-context/selection-ai.ts runPrompt via the panel (transform action, not localized)', 'none', sentByPanel[1]);
});

test('collect snapshots: Claude structured-output instruction (task, AIM phase, chart)', async () => {
  // Claude prompts add the StructuredOutput-first sentence; the Codex snapshots above stay byte-identical.
  const claude = 'claude:sonnet';
  for (const [language, tag] of LANGUAGES) {
    const ctx = { ...base, outputLanguage: language };
    await recordContext(`claude.task-general.${tag}`, 'AiTaskService instructions for Claude: mode task, web research (StructuredOutput-first sentence)', language, ctx, claude);
    await recordContext(`claude.task-quick.${tag}`, 'AiTaskService instructions for Claude: Quick AI mode research (StructuredOutput-first sentence, no tools)', language, { ...ctx, researchMode: 'local', researchDepth: 'normal', visualMode: 'off', mapAiMode: 'quick' }, claude);
    await recordContext(`claude.task-decompose.${tag}`, 'AiTaskService instructions for Claude: mode decompose', language, { ...ctx, mode: 'decompose', researchDepth: 'deep' }, claude);
    await recordContext(`claude.task-synthesize.${tag}`, 'AiTaskService instructions for Claude: mode synthesize, local', language, { ...ctx, mode: 'synthesize', researchMode: 'local', visualMode: 'off' }, claude);
    const aim = { title: 'Goal G', summary: 'Summary S', rules: 'Rule R', detail: 'Reports D', ancestors: 'Known conditions C', workingFindings: 'Prior findings F', sourceContext: 'Source [S1]: fact', mode: 'task', promptProfile: 'aim', researchMode: 'research', researchDepth: 'normal', visualMode: 'off', task: '<!-- aim-phase: subtopic-research -->\nPhase task text.', outputLanguage: language };
    await recordContext(`claude.aim-subtopic-research.${tag}`, 'buildAimPrompt for Claude (phase subtopic-research)', language, aim, claude);
  }
  const { chartStep } = loadModule('core/steps/chart/step.ts');
  for (const [language, tag] of LANGUAGES) {
    const detail = language === 'en' ? 'Larvae hatch in 3 days.\n\nThe pupa stage lasts 5 days.' : '幼蟲 3 天孵化。\n\n蛹期持續 5 天。';
    record(`claude.chart-add.${tag}`, 'core/steps/chart/step.ts chartStep for Claude (StructuredOutput-first sentence)', language, chartStep.render({ title: 'Topic T', detail, language, existingCount: 0, existingTypes: [], remaining: 3, provider: 'claude' }), chartStep.schema);
  }
});

test('collect snapshots: chart step (chart.add@1)', () => {
  const { chartStep } = loadModule('core/steps/chart/step.ts');
  for (const [language, tag] of LANGUAGES) {
    const detail = language === 'en' ? 'Larvae hatch in 3 days.\n\n```mermaid\nflowchart TD\nA["Egg"] --> B["Larva"]\n```\n\nThe pupa stage lasts 5 days.' : '幼蟲 3 天孵化。\n\n```mermaid\nflowchart TD\nA["卵"] --> B["幼蟲"]\n```\n\n蛹期持續 5 天。';
    record(`chart.add.${tag}`, 'core/steps/chart/step.ts chartStep (one existing diagram, two remaining)', language, chartStep.render({ title: 'Topic T', detail, language, existingCount: 1, existingTypes: ['flowchart'], remaining: 2 }), chartStep.schema);
  }
  for (const [language, tag] of LANGUAGES) record(`chart.add-none.${tag}`, 'core/steps/chart/step.ts chartStep (no existing diagram)', language, chartStep.render({ title: 'Topic T', detail: language === 'en' ? 'Plain text.' : '純文字。', language, existingCount: 0, existingTypes: [], remaining: 3 }), chartStep.schema);
});

test('collect snapshots: preset instruction strings composed directly from i18n', () => {
  // None of these texts are i18n keys any more; the snapshot keeps the old key as its label so the text stays comparable.
  const { researchTopicTask } = loadModule('experiences/visual-map/steps/fragments.ts');
  const { referenceTask } = loadModule('core/steps/reference/step.ts');
  const { searchBudgetExhaustedMessage } = loadModule('ai/runtime/messages/index.ts');
  const presetSteps = support.load('experiences/markdown-context/steps/presets/step.ts');
  for (const [language, tag] of LANGUAGES) {
    const presets = { 'prompt.context_ai_condense': presetSteps.condensePresetStep, 'prompt.context_ai_translate': presetSteps.translatePresetStep, 'prompt.context_ai_search_images': presetSteps.searchImagesPresetStep };
    const others = { 'prompt.research_topic': () => researchTopicTask(language, 'Target language'), 'prompt.search_budget_exhausted': () => searchBudgetExhaustedMessage(language), 'prompt.reference_reduce': () => referenceTask('reduce', language) };
    const keys = [...Object.keys(presets), 'prompt.research_topic', 'prompt.search_budget_exhausted', 'prompt.reference_reduce'];
    const text = key => (presets[key] ? presets[key].render({ language, target: 'Target language' }) : others[key]());
    record(`i18n-direct.preset-instructions.${tag}`, 'i18n translate() of strings assembled in UI/runtime classes (selection-ai presets, view research task, codex search-budget steer, reference reduce round which needs >18k chars of evidence to trigger); weaker than a builder snapshot', language, keys.map(key => `${key}: ${text(key)}`).join('\n\n'));
  }
});

test('prompt snapshots match the checked-in files byte for byte', () => {
  assert.ok(snapshots.size > 100, `unexpectedly few snapshots: ${snapshots.size}`);
  const index = {
    note: 'Generated by tests/prompt-snapshots.cjs. Do not edit by hand; rerun with UPDATE_PROMPT_SNAPSHOTS=1.',
    snapshots: Object.fromEntries([...snapshots.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, { builder: value.builder, language: value.language, schema: value.schema !== undefined }]))
  };
  const expected = new Map();
  for (const [name, value] of snapshots) {
    expected.set(`${name}.txt`, value.prompt);
    if (value.schema !== undefined) expected.set(`${name}.schema.json`, `${JSON.stringify(value.schema, null, 2)}\n`);
  }
  expected.set('index.json', `${JSON.stringify(index, null, 2)}\n`);
  if (update) {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    for (const [file, content] of expected) fs.writeFileSync(path.join(directory, file), content);
    return;
  }
  assert.ok(fs.existsSync(directory), 'snapshots missing; run once with UPDATE_PROMPT_SNAPSHOTS=1');
  const onDisk = new Set(fs.readdirSync(directory));
  assert.deepEqual([...onDisk].sort(), [...expected.keys()].sort(), 'snapshot file set differs (stale or missing snapshots)');
  for (const [file, content] of expected) assert.equal(fs.readFileSync(path.join(directory, file), 'utf8'), content, `snapshot ${file} changed`);
});
