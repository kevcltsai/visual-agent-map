// AIM conclusion note style (note-style-recipe T7, P1): the final-delivery pipeline accepts a note style other than the AIM
// report: its sections shape the outline and the written document, its format replaces the Obsidian format in the written
// document only, and it joins the checkpoint fingerprint. Unit level; no style leaves every context and fingerprint unchanged.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./support-replay.cjs');

const M = loadSource(`
export { aimNoteStyleOf, renderAimStructure } from "./experiences/aim/aim-note-style";
export { buildFinalDelivery } from "./experiences/aim/final-delivery";
export { renderOutlineTask } from "./experiences/aim/steps/delivery-outline/step";
export { renderWritingTask } from "./experiences/aim/steps/delivery-writing/step";
export { buildAimPrompt, aimPhase } from "./core/steps/aim/shell";
export { OBSIDIAN_FORMAT, inLanguage } from "./core/steps/_shared/fragments";
export { lookupBuiltinFormat } from "./core/blocks/builtin";
`);

const plain = value => JSON.parse(JSON.stringify(value));
const section = (name, description = '', count) => ({ id: name, name, description, role: 'none', aliases: [], ...(count ? { count } : {}) });
const runStyle = (sections, extra = {}) => ({
  recipe: { ref: 'file:Mine', name: 'Mine', source: 'kind' },
  template: { id: 'mine', name: 'Mine', sections },
  formatText: M.lookupBuiltinFormat('lean', 'en'),
  contextFields: { styleSelection: { template: { id: 'mine' }, tone: {}, format: { id: 'lean' } } },
  ...extra
});
const HYPOTHESIS = ['Claim', 'Prediction', 'How to check', 'Support', 'Counter', 'Current judgment', 'Evidence and sources', 'Update log']
  .map(name => section(name, `${name} description.`));
const lean = () => M.aimNoteStyleOf(runStyle(HYPOTHESIS, { toneText: 'Write in plain words.' }));

const outline = names => `<!-- aim-delivery-outline ${JSON.stringify({ sections: names.map(heading => ({ heading, purpose: `${heading} purpose`, searchTask: '' })) })} -->`;
const answerOf = detail => ({ summary: 'S', detail, suggestions: [], visualReferences: [] });
const REVIEW = '<!-- aim-review {"decision":"conclude","rationale":"ok","stopReason":"done"} -->\nDocument';
const base = { title: 'Goal', rules: '', detail: 'Conditions', ancestors: '', summary: '', workingFindings: '', sourceContext: '', outputLanguage: 'en', toneText: 'Write in plain words.' };

async function run(options = {}, names = ['A', 'B'], baseContext = base) {
  const calls = [];
  let saved;
  const replies = { 'delivery-outline': outline(names), 'delivery-writing': 'Document body', 'delivery-acceptance': REVIEW };
  const delivery = await M.buildFinalDelivery(baseContext, async context => {
    calls.push(plain(context));
    const phase = M.aimPhase(context.task);
    return answerOf(replies[phase] ?? 'x');
  }, { webSearch: false, onCheckpoint: checkpoint => { saved = plain(checkpoint); }, ...options });
  return { calls, saved, delivery };
}
const phaseOf = context => M.aimPhase(context.task);
const promptOf = (context, language = 'en') => M.buildAimPrompt({ ...context, promptProfile: 'aim' }, language);

test('counter 1: no style, the AIM report style, or an unusable section count read as the AIM report', () => {
  assert.equal(M.aimNoteStyleOf(undefined), undefined);
  assert.equal(M.aimNoteStyleOf(runStyle(HYPOTHESIS, { recipe: { ref: 'builtin:aim', name: 'AIM', source: 'kind', aimDelivery: true } })), undefined);
  assert.equal(M.aimNoteStyleOf(runStyle([])), undefined);
  assert.equal(M.aimNoteStyleOf(runStyle(Array.from({ length: 13 }, (_, i) => section(`S${i}`)))), undefined);
  assert.equal(M.aimNoteStyleOf(runStyle(Array.from({ length: 12 }, (_, i) => section(`S${i}`)))).sections.length, 12);
});

test('counter 1: a style converts to its sections (trimmed descriptions, counts), tone, format and chart wish', () => {
  const got = M.aimNoteStyleOf(runStyle([section('Claim', '  The claim.  ', { mode: 'min', n: 3 }), section('Why')], { toneText: 'Plain.' }));
  assert.deepEqual(plain(got.sections), [{ name: 'Claim', description: 'The claim.', count: { mode: 'min', n: 3 } }, { name: 'Why', description: '' }]);
  assert.equal(got.ref, 'file:Mine');
  assert.equal(got.toneText, 'Plain.');
  assert.equal(got.charts, false, 'the lean format never charts');
  const academic = M.aimNoteStyleOf(runStyle([section('Claim')]));
  assert.ok(!('toneText' in academic), 'no tone text: no key');
  const rich = M.aimNoteStyleOf(runStyle([section('Claim')], { formatText: 'Use ```mermaid blocks.', contextFields: {} }));
  assert.equal(rich.charts, true);
  const viaDescription = M.aimNoteStyleOf(runStyle([section('Flow', 'Draw a ```mermaid flowchart.')], { formatText: '', contextFields: {} }));
  assert.equal(viaDescription.charts, true);
  const leanWithChartSection = M.aimNoteStyleOf(runStyle([section('Flow', 'Draw a ```mermaid flowchart.')]));
  assert.equal(leanWithChartSection.charts, false, 'lean wins over a section that asks for a chart');
  assert.equal(M.aimNoteStyleOf(runStyle([section('Claim')], { formatText: '', contextFields: {} })).charts, false);
});

test('renderAimStructure: a heading, the description and the count per section, deterministic', () => {
  const text = M.renderAimStructure([{ name: 'Claim', description: 'The claim.', count: { mode: 'exact', n: 2 } }, { name: 'Why', description: '', count: { mode: 'min', n: 3 } }, { name: 'End', description: 'Close.' }]);
  assert.equal(text, '### Claim\nThe claim.\nExactly 2 items.\n\n### Why\nAt least 3 items.\n\n### End\nClose.');
  assert.equal(M.renderAimStructure(lean().sections), M.renderAimStructure(lean().sections));
});

test('counter 1: without a style every phase context, the checkpoint and the fingerprint equal those with noteStyle undefined, and no aimNoteFormat key exists', async () => {
  const plainRun = await run();
  const undefinedRun = await run({ noteStyle: undefined });
  assert.deepEqual(plainRun.calls, undefinedRun.calls);
  assert.equal(plainRun.saved.baseFingerprint, undefinedRun.saved.baseFingerprint);
  for (const call of plainRun.calls) assert.ok(!('aimNoteFormat' in call), phaseOf(call));
  const withStyle = await run({ noteStyle: lean() });
  assert.notEqual(withStyle.saved.baseFingerprint, plainRun.saved.baseFingerprint, 'a style joins the fingerprint');
});

test('counter 3: with no structure the outline and writing tasks are the unchanged default text', () => {
  const variables = { outline: '[]', knownConditions: 'K', evidence: 'E' };
  assert.equal(M.renderOutlineTask('CAT', undefined), M.renderOutlineTask('CAT'));
  assert.ok(M.renderOutlineTask('CAT').endsWith('Supplied evidence IDs and reports:\nCAT'));
  assert.equal(M.renderWritingTask({ ...variables, structure: undefined }), M.renderWritingTask(variables));
  assert.ok(M.renderWritingTask(variables).endsWith('summary is only a short canvas preview.'));
});

test('counter 3: the hypothesis structure reaches the outline and the writing task, headings in order, and nothing else', async () => {
  const { calls } = await run({ noteStyle: lean() }, HYPOTHESIS.map(item => item.name));
  const structure = M.renderAimStructure(lean().sections);
  const outlineCall = calls.find(call => phaseOf(call) === 'delivery-outline');
  const writingCall = calls.find(call => phaseOf(call) === 'delivery-writing');
  assert.ok(outlineCall.task.includes(structure));
  assert.ok(writingCall.task.includes(structure));
  const positions = HYPOTHESIS.map(item => outlineCall.task.indexOf(`### ${item.name}`));
  assert.ok(positions.every(position => position > 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'in order');
  assert.equal(HYPOTHESIS.length, 8);
  for (const call of calls) if (!['delivery-outline', 'delivery-writing'].includes(phaseOf(call))) assert.ok(!call.task.includes(structure), phaseOf(call));
});

test('counter 2: the style format replaces the Obsidian format in the written document only; research and acceptance requests carry no format', async () => {
  const { calls } = await run({ noteStyle: lean() });
  const obsidian = M.inLanguage(M.OBSIDIAN_FORMAT, 'en');
  const formats = Object.fromEntries(calls.map(call => [phaseOf(call), call.aimNoteFormat]));
  assert.equal(formats['delivery-writing'], lean().formatText);
  assert.equal(formats['delivery-outline'], undefined);
  assert.equal(formats['delivery-acceptance'], undefined);
  const writing = promptOf(calls.find(call => phaseOf(call) === 'delivery-writing'));
  assert.ok(!writing.includes(obsidian));
  assert.ok(writing.includes(lean().formatText));
  assert.ok(writing.includes('Write in plain words.'), 'the tone stays on the written document');
  for (const phase of ['subtopic-research', 'targeted-followup-research']) {
    const prompt = promptOf({ ...base, task: `<!-- aim-phase: ${phase} -->\nResearch.` });
    assert.ok(prompt.includes(obsidian), phase);
  }
  const noStyleWriting = promptOf((await run()).calls.find(call => phaseOf(call) === 'delivery-writing'));
  assert.ok(noStyleWriting.includes(obsidian), 'no style: the Obsidian format as before');
});

test('counter 2: an empty format adds no format text and no empty block', async () => {
  const style = M.aimNoteStyleOf(runStyle([section('Claim')], { formatText: '', contextFields: {} }));
  const { calls } = await run({ noteStyle: style }, ['Claim']);
  const writing = calls.find(call => phaseOf(call) === 'delivery-writing');
  assert.equal(writing.aimNoteFormat, '');
  const prompt = promptOf(writing);
  assert.ok(!prompt.includes(M.inLanguage(M.OBSIDIAN_FORMAT, 'en')));
  assert.ok(!prompt.includes('\n\n\n\n'));
  assert.ok(!prompt.includes('\n\n\n'));
});

test('counter 9: another style ref regenerates the outline and the document; the same ref reuses them; no style keeps an old checkpoint', async () => {
  const first = await run({ noteStyle: lean() });
  const resume = async options => {
    const result = await run({ checkpoint: first.saved, evidence: undefined, ...options });
    return result.calls.map(phaseOf).filter(phase => phase !== undefined);
  };
  const same = await resume({ noteStyle: lean() });
  assert.ok(!same.includes('delivery-outline') && !same.includes('delivery-writing'), `same ref reuses: ${same}`);
  const other = await resume({ noteStyle: { ...lean(), ref: 'file:Other' } });
  assert.ok(other.includes('delivery-outline') && other.includes('delivery-writing'), `another ref regenerates: ${other}`);
  const plainFirst = await run();
  const plainAgain = await run({ checkpoint: plainFirst.saved });
  assert.ok(!plainAgain.calls.map(phaseOf).some(phase => phase === 'delivery-outline' || phase === 'delivery-writing'), 'no style: reused');
  const fromStyleToNone = await run({ checkpoint: first.saved });
  assert.ok(fromStyleToNone.calls.map(phaseOf).includes('delivery-outline'), 'dropping the style regenerates');
});

test('the structured delivery phases never carry the note format, so the contract calls stay unchanged', async () => {
  const { calls } = await run({ noteStyle: lean() });
  for (const call of calls) if (phaseOf(call) !== 'delivery-writing') assert.ok(!('aimNoteFormat' in call), phaseOf(call));
});
