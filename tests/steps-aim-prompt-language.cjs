// Fast static language check (no AI): builds the prompt of every reachable AIM phase/step for a Chinese-content and an
// English-content map under both interface languages, and asserts that the content language alone decides the output
// language line and the fixed frame. Also writes the zh-content / UI-en prompts for live probing when
// AIM_PHASE_PROMPT_EXPORT names a file (scratchpad use only).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { promptsFor, normalizeText } = require('./support-replay.cjs');
const support = require('./support.cjs');
const { captureAimPhaseVariants } = require('./support-aim-flow-capture.cjs');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'core', 'steps', 'aim', name), 'utf8').trim();
// The language line is a template; these are the spellings the registry must put in it for each content language.
const LANGUAGE_NAMES = { en: { language: 'English', languagePlain: 'English' }, 'zh-TW': { language: '繁體中文（台灣）', languagePlain: '繁體中文' } };
const filled = (name, content) => read(name).replace(/\{\{(\w+)\}\}/g, (_, key) => LANGUAGE_NAMES[content][key]);
const LANGUAGE_LINE = { en: filled('language.en.md', 'en'), 'zh-TW': filled('language.zh.md', 'zh-TW') };
const TOPIC = { en: 'Plan a 5-day Taipei trip', 'zh-TW': '東京五天自由行怎麼排' };
// The language the flow derives from the topic text (D-2026-10-83/90): an English sentence cannot be told from Spanish or
// French by letters, so a map created today carries the follow-the-text language, while a fixture map holding only the 0.24-shaped
// `contentLanguage` resolves to its note language; the audit below renders both as the content language to check the fixed frame.
const FLOW_LANGUAGE = { en: 'same-as-input', 'zh-TW': 'zh-TW' };
// Variants captured from fixtures whose repository/map is English by construction (fake `{settings:{language:'en'}}` repos or
// English fixture maps). Their flow-set outputLanguage is not the topic's, so the test sets it explicitly like the snapshots do.
const SYNTHETIC_ENGLISH_FIXTURE = new Set(['evidence-reuse-audit', 'subtopic-research-update', 'subtopic-research-reuse-rejected', 'research-plan-repair', 'topic-root-research-plan', 'topic-root-report-review', 'saved-report-review', 'saved-report-followup-search',
  'format-repair-state-question', 'format-repair-imposed-options', 'format-repair-missing-choices', 'format-repair-answered-without-target', 'format-repair-preserve-decision', 'format-repair-no-decision']);
// Instructions that would tell the model to answer in the other language. Each pattern is scanned on every line after the first.
const CONFLICTING_INSTRUCTION = {
  'zh-TW': [/\bin English\b/i, /\bEnglish only\b/i, /\banswer in English\b/i, /輸出語言：English/],
  en: [/用中文/, /以(繁體)?中文(回答|撰寫|輸出)/, /\bin (Traditional )?Chinese\b/i, /Traditional Chinese/i, /輸出語言：繁體中文/, /繁體中文（台灣）/]
};
// The fixed frame ends where the data blocks begin (the first block that is present).
const FRAME_END = { en: /^(Current topic|Current summary|Current detail and supplied reports|Topic AI rules \(highest priority\)|Previous findings|Source context|Ancestor topic context|Current task):$/, 'zh-TW': /^(目前議題|目前理解|目前內容與提供的報告|目前議題的 AI 規則（優先遵守）|先前發現|整合來源背景|祖先議題背景|目前任務):$/ };

async function gather(content, ui) {
  const found = new Map();
  for (const [variant, context] of await captureAimPhaseVariants({ topic: TOPIC[content], ui })) found.set(variant, context);
  // Phases the variant capture does not repeat: initial-question, research-plan, subtopic-research, report-review-first and delivery-*.
  const subject = await support.coverageSetup(TOPIC[content], { sharedRepo: support.fixture(ui).repo });
  const first = new Map(), inner = subject.model.ask;
  const { AimManualFlow } = support.load('experiences/aim/manual-flow.ts');
  const { AimRunStore } = support.load('experiences/aim/research-run-store.ts');
  subject.flow = new AimManualFlow(subject.repo, new AimRunStore(subject.repo), async context => {
    const phase = context.task.match(/aim-phase:\s*([a-z-]+)/)?.[1] ?? 'none';
    const key = phase === 'report-review' && /Hard floor: \d+ answered/.test(context.task) ? `${phase}-${first.has(phase) ? 'later' : 'first'}` : phase;
    if (!first.has(key)) first.set(key, { ...context, onProgress: undefined, signal: undefined });
    return inner(context);
  });
  await support.coverageThreeAnswers(subject);
  for (const [phase, context] of first) if (!found.has(phase)) found.set(phase, context);
  return found;
}

function auditPrompt(prompt, content, label) {
  const lines = prompt.split('\n');
  assert.equal(lines[0], LANGUAGE_LINE[content], `${label}: first line must be the ${content} language line`);
  const problems = [];
  lines.slice(1).forEach((line, index) => { for (const pattern of CONFLICTING_INSTRUCTION[content]) if (pattern.test(line)) problems.push(`line ${index + 2}: ${line.slice(0, 100)}`); });
  assert.deepEqual(problems, [], `${label}: another line instructs a different output language`);
  const end = lines.findIndex(line => FRAME_END[content].test(line));
  assert.ok(end > 1, `${label}: the frame must end at the first data block heading`);
  const frame = lines.slice(1, end).join('\n');
  if (content === 'zh-TW') {
    assert.match(frame, /[㐀-鿿]/, `${label}: zh frame has no Chinese text`);
    assert.doesNotMatch(frame, /(?:[A-Za-z]+ ){4,}[A-Za-z]+/, `${label}: zh frame contains an English sentence`);
  } else {
    assert.doesNotMatch(frame, /[㐀-鿿]/, `${label}: en frame contains Chinese text`);
  }
}

const covered = new Set(), exported = new Map();
for (const content of ['zh-TW', 'en']) for (const ui of ['en', 'zh-TW']) {
  test(`AIM prompt language: every phase prompt of a ${content} content map under ${ui} interface follows the content language`, async () => {
    const variants = await gather(content, ui);
    assert.ok(variants.size >= 35, `expected the full AIM phase set, saw ${variants.size}: ${[...variants.keys()].join(', ')}`);
    for (const [variant, captured] of variants) {
      if (!SYNTHETIC_ENGLISH_FIXTURE.has(variant)) assert.ok([content, FLOW_LANGUAGE[content]].includes(captured.outputLanguage), `${variant}: the flow must set outputLanguage to the map's content language, not the interface language`);
      const context = { ...captured, outputLanguage: content };
      // The AiTaskService used for the capture runs with the interface language; the prompt must not depend on it.
      const sent = await promptsFor(context, { language: ui });
      assert.ok(sent.length >= 1, `${variant}: no prompt reached the provider`);
      sent.forEach((call, index) => {
        const prompt = normalizeText(call.prompt), label = `${variant}${sent.length > 1 ? `.${index + 1}` : ''} (${content} content, ${ui} UI)`;
        auditPrompt(prompt, content, label);
        covered.add(variant);
        if (content === 'zh-TW' && ui === 'en' && process.env.AIM_PHASE_PROMPT_EXPORT && !exported.has(label)) exported.set(label, { step: sent.length > 1 ? `${variant}.${index + 1}` : variant, prompt, outputSchema: call.schema });
      });
    }
  });
}
test('AIM prompt language: optional export of the zh-content prompts for live probing', () => {
  if (!process.env.AIM_PHASE_PROMPT_EXPORT) return;
  const rows = [...exported.values()].sort((a, b) => a.step.localeCompare(b.step)).map(row => ({ ...row, model: 'gpt-6-luna', effort: 'low' }));
  assert.ok(rows.length >= 35);
  fs.writeFileSync(process.env.AIM_PHASE_PROMPT_EXPORT, `${JSON.stringify(rows, null, 2)}\n`);
  console.log(`AIM phase prompts exported: ${rows.length} -> ${process.env.AIM_PHASE_PROMPT_EXPORT}`);
  console.log(`AIM phase steps covered: ${[...covered].sort().join(', ')}`);
});
