// G1: fixture note-language audit. Runs real AIM flows against the REAL Repository (not a fake), then re-writes every
// note through updateNote({}) and rebuildDerivedData() (the paths that once rewrote the placeholder in the interface
// language) and scans every saved note file. With a Chinese content language no Latin word may remain, with an English
// content language no CJK character may remain, except for the explicit, reasoned exceptions below.
const assert = require('node:assert/strict');
const { integrationTest, load, plannerReview, aimPhase, fixture, coverageSetup, coverageThreeAnswers } = require('../support.cjs');

// ---- exceptions: every entry says why the text is allowed to be in the other language -------------------------------
// The zh-TW names (C8) are the same frame headings, written in a Chinese note's own language.
const FRAME_HEADINGS = /^## (Current Summary|Prompt|Rules|Preview|預覽|Detail|Working Findings|Thinking Origin|Visual References|Reference Links|參考連結|目前摘要|詳細內容|規則|進行中的發現|思考起點|關聯連結)\s*$/;
const COMMON = [
  [/### AIM (incomplete|stale)-attempt diagnostic[\s\S]*?(?=### Original draft response|$)/g, 'retired-draft diagnostic block (research-run-store.ts retireDraftNote, incl. its Stop reason line) is machine-read and stays English; only this block is exempt'],
  [/<!--[\s\S]*?-->/g, 'machine markers (<!-- aim-* -->, detail frame markers) are parsed by VAM and stay English'],
  [/https?:\/\/\S+/g, 'URLs'],
  [/\[\[[^\]]*\]\]/g, 'wiki links inside the shared Reference Links frame carry vault paths'],
  [/^\s*(- )?(Topic\b|Mind map\b|Parent topic\b|Child topics\b|Status\b|所屬主題|所屬心智圖|母議題|子議題|狀態).*$/gm, 'Reference Links block labels are the shared frame and follow the interface language'],
  [/\*\*Status:\*\* Diagnostic only\.|\*\*Prior attempt:\*\*|\*\*Source boundary:\*\*/g, 'retained-report frame parsed by retry-targets.ts'],
  [/### AIM (incomplete|stale)-attempt diagnostic|### Original draft response|Original summary:/g, 'diagnostic markers parsed by retry-targets.ts / research-run-store.ts'],
  [/This draft was not published because attempt \S+ [a-z ]+\.|The original draft is retained below for diagnosis; it is not an active research result\./g, 'retired-draft diagnostic body (research-run-store.ts retireDraftNote) is a machine-read diagnostic and stays English'],
  [/^## Searcher report \d+$/gm, 'machine heading read by retry-targets.ts'],
  [/^Report \d+:/gm, 'summary prefix parsed by retry-targets.ts'],
  [/Research status: (search completed|unavailable)/g, 'status line the research gate parses'],
  [/\b(VAM|AIM)\b/g, 'product names'],
  [/attempt-\d+/g, 'attempt identifiers'],
  [/User answer to .*|Saved research result v\d+ \(/g, 'lineage lines parsed by manual-flow-support.ts / manual-flow.ts']
];
// Text that the fixture model (tests/support.cjs coverageModel and the scenarios below) returns; the plugin does not author it.
const FIXTURE_MODEL_TEXT = [
  /Keep the answer conditional until the conflicting responsibility is clarified\.|The supplied responsibility descriptions conflict; do not choose one\.|The same project is described as both occasional contribution and primary operations ownership; clarify responsibility[^\n]*|For this same project, are you an occasional contributor or the primary operations owner\?|Occasional contributor|Primary operations owner/g,
  /Initial clarification: known background; unknown constraints may be explored conditionally\./g,
  /Researched evidence|Applicable evidence( and limitations)?:?|Interim evidence|Search unavailable|Saved condition|Specific condition \d|Additional condition \d/g,
  /Method and options|Constraints and quality|Two complementary research dimensions\.?/g,
  /What is your intended outcome\??|Which constraint matters at stage \d\??|Executable project|Compare alternatives|Time constraint|Resource constraint|Unknown success criterion\.?/g,
  /Document outline|Delivery evidence|Canvas preview|Completed document preview|Complete execution plan|Build a small example\.|Check the output against requirements\.|Extend with evidence\.|Concrete example and source|Source:|Execution plan/g,
  /Three answers and reports support delivery\.|Ready for delivery\.?|Document usable for original goal\.?|Every required section is concrete and supported\.?/g,
  /Evidence is still missing\.|Partial|Detail\.|Follow-up|More evidence|Search for the missing evidence\.|Closes the gap\.|A different unknown constraint changes execution\./g,
  /Practical methods? and relevant alternatives|Research practical methods[^\n]*|Compare feasible ways[^\n]*|Research key constraints[^\n]*/g
];
function residual(raw) {
  let text = raw.replace(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/, (_, fm) => fm.split('\n').filter(line => /^(title|summary):/.test(line)).map(line => line.replace(/^(title|summary): /, '')).join('\n') + '\n');
  // The Prompt section holds the task text sent to the model; it sits above Preview (older layout) or after it.
  text = text.replace(/## Prompt[\s\S]*?(?=\n## |$)/, '## Prompt');
  // Preview and Prompt as collapsed callouts: the titles are frame labels and the Prompt holds the model task text.
  text = text.replace(/^> \[!info\]- (?:Prompt|提示)\n(?:>.*(?:\n|$))*/m, '');
  text = text.replace(/^> \[!info\]- (Preview|預覽)$/gm, '');
  text = text.split('\n').filter(line => !FRAME_HEADINGS.test(line)).join('\n');
  // A callout type such as [!warning] is Obsidian syntax and is not shown; the callout's own title text is still checked.
  text = text.replace(/^((?:> ?)+)\[![a-z]+\][+-]?/gm, '$1');
  for (const [pattern] of COMMON) text = text.replace(pattern, ' ');
  for (const pattern of FIXTURE_MODEL_TEXT) text = text.replace(pattern, ' ');
  return text;
}
function offenders(raw, kind) {
  const pattern = kind === 'latin' ? /[A-Za-z]{3,}/g : /[㐀-鿿]/g;
  return residual(raw).split('\n').map((line, index) => ({ line: index + 1, text: line })).filter(item => pattern.test(item.text) && ((pattern.lastIndex = 0), true));
}

async function subjectFor(ui, topic, config = {}) {
  const made = fixture(ui);
  const subject = await coverageSetup(topic, { sharedRepo: made.repo, ...config });
  return { ...subject, files: made.files };
}
async function auditNotes(subject, kind, label) {
  const { repo } = subject;
  const paths = [...subject.files.keys()].filter(path => path.endsWith('.md') && path.includes('/Notes/'));
  assert.ok(paths.length >= 1, `${label}: no notes to audit`);
  const failures = [];
  const scan = async stage => {
    for (const path of paths) {
      const raw = await repo.app.vault.read(repo.file(path));
      for (const item of offenders(raw, kind)) failures.push(`${label} [${stage}]: ${path}:${item.line}: ${item.text.trim().slice(0, 120)}`);
    }
  };
  await scan('as written by the flow');
  for (const path of paths) await repo.updateNote(path, {});
  await scan('after an empty updateNote');
  await repo.rebuildDerivedData();
  await scan('after rebuildDerivedData');
  if (process.env.AUDIT_DEBUG) console.log(failures.join('\n'));
  assert.deepEqual(failures, [], `unexpected ${kind === 'latin' ? 'Latin' : 'CJK'} text in AIM notes:\n${failures.join('\n')}`);
  return paths.length;
}

const zhTopic = '東京五天自由行怎麼排', enTopic = 'Plan a 5-day Taipei trip';

integrationTest('AIM language audit: UI en + Chinese content, full flow to a delivered conclusion, survives updateNote and rebuildDerivedData', async () => {
  const subject = await subjectFor('en', zhTopic);
  const topic = await subject.repo.readNote(subject.created.root.path);
  await subject.flow.prepareClarification(topic, 'zh-TW');
  await subject.repo.updateNote(subject.created.root.path, { detail: `${topic.detail}\n\n<!-- aim-intake-complete -->` }, { contentLanguage: 'zh-TW' });
  const outcome = await coverageThreeAnswers(subject);
  assert.equal(outcome.status, 'completed');
  await auditNotes(subject, 'latin', 'full-flow');
});
integrationTest('AIM language audit: UI en + Chinese content, conflicting answers force ask_user through the reconciliation path', async () => {
  const subject = await subjectFor('en', zhTopic, { clarifyConflict: true });
  await coverageThreeAnswers(subject);
  await auditNotes(subject, 'latin', 'forced-ask-user');
});
integrationTest('AIM language audit: UI en + Chinese content, failed search leaves retired draft notes that are retried', async () => {
  const subject = await subjectFor('en', zhTopic, { failSearch: true });
  const q = await subject.flow.planNextQuestion(subject.created.mapPath, subject.created.root.id, 'gpt-6-luna', 'low', 'audit-retry-question');
  await assert.rejects(() => subject.flow.answerAndResearch(subject.created.mapPath, q.node.id, { requestId: 'audit-retry-answer', selections: [q.options[0].id], freeText: 'Saved condition' }, 'gpt-6-luna', 'low'));
  await auditNotes(subject, 'latin', 'failed-search');
  subject.model.state.failSearch = false;
  const saved = await subject.repo.readMap(subject.created.mapPath);
  await subject.flow.resumeAnswerResearch(subject.created.mapPath, saved.aim.branches[0].id, 'gpt-6-luna', 'low');
  await auditNotes(subject, 'latin', 'retry-resumed');
});
integrationTest('AIM language audit: UI en + Chinese content, a delivery rejected at the research budget is published in the content language', async () => {
  const subject = await subjectFor('en', zhTopic);
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  const reply = (summary, detail) => ({ summary, detail, suggestions: [], visualReferences: [] });
  const target = { title: '補查目標', task: 'Search for the missing evidence.', contribution: 'Closes the gap.' };
  let mode = 'ask_user'; const base = subject.model.ask;
  subject.flow = new AimManualFlow(subject.repo, new AimRunStore(subject.repo), async (context, ...rest) => {
    if (mode === 'research_more') {
      if (aimPhase(context, 'report-review')) return plannerReview('research_more', { rationale: 'Evidence is still missing.' }, 'Partial', 'Detail.', [target]);
      if (aimPhase(context, 'research-gap-audit')) return reply('external_evidence', 'An external fact is missing.');
      if (aimPhase(context, 'targeted-followup-research')) return reply('Follow-up', 'Research status: search completed\nMore evidence https://example.org/more');
      if (context.aimContract?.kind === 'review' && !aimPhase(context, 'decision-quality-review') && !aimPhase(context, 'saved-evidence-review')) return plannerReview('research_more', { rationale: 'Evidence is still missing.' }, 'Partial', 'Detail.', [target]);
    }
    return base(context, ...rest);
  });
  const q1 = (await subject.flow.planNextQuestion(subject.created.mapPath, subject.created.root.id, 'gpt-6-luna', 'low', 'audit-q1')).node;
  const asked = await subject.flow.answerAndResearch(subject.created.mapPath, q1.id, { requestId: 'audit-a1', selections: [q1.aimQuestion.options[0].id], freeText: '條件一' }, 'gpt-6-luna', 'low');
  const q2 = (await subject.repo.readMap(subject.created.mapPath)).nodes.find(node => node.id === asked.questionNodeId);
  const asked2 = await subject.flow.answerAndResearch(subject.created.mapPath, q2.id, { requestId: 'audit-a2', selections: [q2.aimQuestion.options[0].id], freeText: '條件二' }, 'gpt-6-luna', 'low');
  // A gap left at the research budget becomes a conditional answer, and a final delivery still rejected there is
  // published with the gap stated, so no attempt is left partial.
  mode = 'research_more';
  const q3 = (await subject.repo.readMap(subject.created.mapPath)).nodes.find(node => node.id === asked2.questionNodeId);
  await subject.flow.answerAndResearch(subject.created.mapPath, q3.id, { requestId: 'audit-a3', selections: [q3.aimQuestion.options[0].id], freeText: '條件三' }, 'gpt-6-luna', 'low');
  const map = await subject.repo.readMap(subject.created.mapPath);
  assert.ok(!map.aim.runs.some(item => item.attempts.some(attempt => attempt.status === 'partial')), 'nothing is left partial');
  assert.ok(map.aim.branches.at(-1).results.some(result => result.kind === 'conclusion'), 'the written document is published');
  await auditNotes(subject, 'latin', 'published-at-budget');
});
integrationTest('AIM language audit mirror: UI zh-TW + English content, full flow keeps notes free of Chinese text', async () => {
  const subject = await subjectFor('zh-TW', enTopic);
  const topic = await subject.repo.readNote(subject.created.root.path);
  await subject.flow.prepareClarification(topic, 'en');
  const outcome = await coverageThreeAnswers(subject);
  assert.equal(outcome.status, 'completed');
  await auditNotes(subject, 'cjk', 'mirror-full-flow');
});
