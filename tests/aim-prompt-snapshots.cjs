// Byte-exact AIM prompt (and provider response schema) snapshots: the AIM prompt builder per phase, the AIM flow phase tasks
// and the Claude AIM phase. Every other prompt is in tests/prompt-snapshots.cjs. Same harness and update switch
// (tests/support-prompt-snapshots.cjs); the files are tests/snapshots/prompts-aim, removed with AIM.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { load: loadModule } = require('./support-replay.cjs');
const support = require('./support.cjs');
const { captureAimPhaseVariants } = require('./support-aim-flow-capture.cjs');
const { LANGUAGES, snapshotCollector } = require('./support-prompt-snapshots.cjs');
const { recordContext, compareTest } = snapshotCollector({ directory: path.join(__dirname, 'snapshots', 'prompts-aim'), generator: 'tests/aim-prompt-snapshots.cjs', minimum: 100 });

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

test('collect snapshots: AIM flow final delivery with a note style (claim to judgment, plain voice, lean format)', async () => {
  const { AimManualFlow } = loadModule('experiences/aim/manual-flow.ts');
  const { AimRunStore } = loadModule('experiences/aim/research-run-store.ts');
  const { lookupBuiltinFormat } = loadModule('core/blocks/builtin.ts');
  const names = ['Claim', 'Prediction', 'How to check', 'Support', 'Counter', 'Current judgment', 'Evidence and sources', 'Update log'];
  const drive = async (language, withStyle) => {
    const subject = await support.coverageSetup('Snapshot goal');
    const first = new Map();
    const inner = subject.model.ask;
    const ask = async context => {
      const phase = context.task.match(/aim-phase:\s*([a-z-]+)/)?.[1] ?? 'none';
      const key = phase === 'report-review' && /Hard floor: \d+ answered/.test(context.task) ? `${phase}-${first.has(phase) ? 'later' : 'first'}` : phase;
      if (!first.has(key)) first.set(key, { ...context, onProgress: undefined, signal: undefined });
      return inner(context);
    };
    subject.flow = new AimManualFlow(subject.repo, new AimRunStore(subject.repo), ask);
    if (withStyle)
      subject.flow.noteStyle = () => ({
        recipe: { ref: 'file:AIM plain lean', name: 'AIM plain lean', source: 'kind' },
        template: { id: 'aim-plain-lean', name: 'AIM plain lean', sections: names.map(name => ({ id: name, name, description: `${name}: what this section says.`, role: 'none', aliases: [] })) },
        toneText: 'Write in plain words: short sentences, everyday terms, the conclusion first.',
        formatText: lookupBuiltinFormat('lean', language),
        contextFields: { styleSelection: { template: { id: 'aim-plain-lean' }, tone: {}, format: { id: 'lean' } } }
      });
    await support.coverageThreeAnswers(subject);
    return first;
  };
  for (const [language, tag] of LANGUAGES) {
    const plain = await drive(language, false);
    const styled = await drive(language, true);
    for (const [phase, context] of styled) {
      if (phase === 'delivery-outline' || phase === 'delivery-writing') continue;
      // askAimModel drops the tone of structured calls, so the contract phases are compared without it.
      const { toneText, ...rest } = context;
      const { toneText: _plainTone, ...plainRest } = plain.get(phase) ?? {};
      const ids = value => JSON.parse(JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')); // each run has its own ids
      assert.deepEqual(ids(rest), ids(plainRest), `${language}: phase ${phase} is unchanged by the style`);
    }
    for (const phase of ['delivery-outline', 'delivery-writing'])
      await recordContext(`aim-flow.style-${phase}.${tag}`, `AimManualFlow/final-delivery phase ${phase} with an AIM note style (claim to judgment, plain voice, lean format) through AiTaskService`, language, { ...styled.get(phase), outputLanguage: language });
  }
});

test('collect snapshots: AIM flow phase task variants (safety net before the templates move)', async () => {
  // Phase-task text assembled in manual-flow.ts and planner-review.ts, captured at the flow's model-call seam for every variant
  // the older test above does not reach. support-aim-flow-capture.cjs fails if any expected variant could not be driven.
  const variants = await captureAimPhaseVariants();
  for (const [variant, context] of [...variants.entries()].sort(([a], [b]) => a.localeCompare(b)))
    for (const [language, tag] of LANGUAGES)
      await recordContext(`aim-flow.${variant}.${tag}`, `AimManualFlow/planner-review phase task variant ${variant} through AiTaskService`, language, { ...context, outputLanguage: language });
});
test('collect snapshots: Claude structured-output instruction (AIM phase)', async () => {
  // Claude prompts add the StructuredOutput-first sentence.
  const claude = 'claude:sonnet';
  for (const [language, tag] of LANGUAGES) {
    const aim = { title: 'Goal G', summary: 'Summary S', rules: 'Rule R', detail: 'Reports D', ancestors: 'Known conditions C', workingFindings: 'Prior findings F', sourceContext: 'Source [S1]: fact', mode: 'task', promptProfile: 'aim', researchMode: 'research', researchDepth: 'normal', visualMode: 'off', task: '<!-- aim-phase: subtopic-research -->\nPhase task text.', outputLanguage: language };
    await recordContext(`claude.aim-subtopic-research.${tag}`, 'buildAimPrompt for Claude (phase subtopic-research)', language, aim, claude);
  }
});

compareTest('AIM prompt snapshots match the checked-in files byte for byte');
