// Payload size (ticket 08): an AIM request carries each passage of a saved report once. The passage de-duplication
// replaces a repeat of a paragraph or line by a reference to the complete copy elsewhere in the same request; these
// tests prove that every replaced passage keeps one complete copy, that nothing unique or short is touched, and that the
// measurement tool handles an empty note and a very long one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const { duplicatedChars, summarize, SCALES, aimFlowContexts, filler } = require('./tools/payload-size.cjs');

const { deduplicateAimRequest, AIM_PASSAGE_MIN_CHARS } = load('experiences/aim/request-context.ts');
const { PASSAGE_REFERENCE } = load('experiences/aim/steps/_shared/rules.ts');
const FIELDS = ['title', 'summary', 'rules', 'detail', 'task', 'ancestors', 'workingFindings'];
const base = { title: 'T', summary: '', rules: '', detail: '', task: '', ancestors: '', workingFindings: '' };
const passage = (tag, length) => `${tag}:`.padEnd(length, 'x');
const joined = request => FIELDS.map(key => request[key] ?? '').join('\n');
const occurrences = (text, part) => text.split(part).length - 1;

test('the threshold is below the typical paragraph of a saved report and above the reference text', () => {
  assert.ok(AIM_PASSAGE_MIN_CHARS > PASSAGE_REFERENCE.length, 'a replaced passage must be longer than its reference');
  assert.ok(AIM_PASSAGE_MIN_CHARS <= 300);
});

test('a repeated paragraph of 200 to 511 characters keeps exactly one complete copy and the repeat becomes a reference', () => {
  for (const length of [AIM_PASSAGE_MIN_CHARS, 300, 511, 512, 2000]) {
    const report = passage('REPORT', length);
    const out = deduplicateAimRequest({ ...base, task: `Supplied reports:\n${report}\n\nEnd`, detail: `Prior research:\n\n${report}\n\nTail` });
    assert.equal(occurrences(joined(out), report), 1, `length ${length}: one complete copy remains`);
    assert.equal(out.task.includes(report), true, `length ${length}: the first copy stays where it was`);
    assert.equal(out.detail.includes(PASSAGE_REFERENCE), true, `length ${length}: the repeat is a reference`);
    assert.match(out.detail, /Prior research:/, 'surrounding text is kept');
    assert.match(out.detail, /Tail/, 'text after the repeat is kept');
  }
});

test('a repeated line inside a differing paragraph is referenced; the complete line stays once', () => {
  const line = passage('LINE', 300);
  const out = deduplicateAimRequest({ ...base, task: `${line}\n\nother`, detail: `Header A\n${line}\nfooter` });
  assert.equal(occurrences(joined(out), line), 1);
  assert.match(out.detail, /Header A\n/);
  assert.match(out.detail, /\nfooter/);
});

test('short or unique content is returned byte for byte', () => {
  const short = passage('SHORT', AIM_PASSAGE_MIN_CHARS - 1);
  const request = { ...base, task: `${short}\n\nunique ${passage('U1', 400)}`, detail: `${short}\n\nunique ${passage('U2', 400)}`, ancestors: 'Known conditions: {"a":"b"}', rules: 'Rule R' };
  assert.equal(JSON.stringify(deduplicateAimRequest(request)), JSON.stringify(request));
  assert.equal(JSON.stringify(deduplicateAimRequest({ ...base })), JSON.stringify(base), 'an empty note changes nothing');
});

test('the repair still carries the failing fragment: the first copy of a repeated passage is never the one removed', () => {
  // A format repair names the validation error and quotes the original response; the quoted response is later in the
  // request than the task, so when both hold the same passage the model still reads the passage in full.
  const failing = passage('FAILING-RESPONSE', 350);
  const out = deduplicateAimRequest({ ...base, task: `Repair this.\nFormat validation error: missing field\n\nOriginal response to repair:\n${failing}`, detail: `Original response to repair:\n${failing}` });
  assert.equal(out.task.includes(failing), true);
  assert.equal(occurrences(joined(out), failing), 1);
  assert.match(out.task, /Format validation error: missing field/);
});

test('every report paragraph of a three-answer AIM branch reaches every delivery request once, at typical report size', async () => {
  const { calls, reports } = await aimFlowContexts(SCALES.typical);
  assert.ok(reports.length >= 6, 'saved reports were produced');
  const paragraphs = reports.flatMap(report => report.split('\n\n'));
  for (const phase of ['delivery-outline', 'delivery-acceptance']) {
    const call = calls.find(item => item.phase === phase);
    assert.ok(call, `${phase} was requested`);
    const text = FIELDS.map(key => call.context[key] ?? '').join('\n') + (call.context.sourceContext ?? '');
    const present = paragraphs.filter(part => occurrences(text, part) >= 1).length;
    assert.ok(present >= 1, `${phase}: the supplied reports are in the request`);
    for (const part of paragraphs) assert.ok(occurrences(text, part) <= 1, `${phase}: a report paragraph is sent at most once`);
  }
  // The outline names the evidence it needs by source id, so the catalog of reports must still be in the request in full.
  const outline = calls.find(item => item.phase === 'delivery-outline');
  const outlineText = FIELDS.map(key => outline.context[key] ?? '').join('\n');
  const catalogReports = reports.filter(report => outlineText.includes(report.split('\n\n')[0]));
  assert.ok(catalogReports.length >= 2, 'the supplied source reports remain in full');
  assert.match(outlineText, /Supplied evidence IDs and reports:/);
});

test('the measurement tool gives sane numbers for an empty note and a very long one, and counts repeats', async () => {
  assert.equal(duplicatedChars(''), 0);
  assert.equal(duplicatedChars('short\nshort'), 0);
  const line = 'y'.repeat(130);
  assert.equal(duplicatedChars(`${line}\n${line}\n${line}`), 260);
  assert.equal(JSON.stringify(summarize([])), JSON.stringify({ count: 0, chars: 0, tokens: 0, mean: 0, max: 0, dup: 0 }));
  const sizes = {};
  for (const [name, scale] of Object.entries(SCALES)) {
    const { calls } = await aimFlowContexts(scale);
    sizes[name] = Math.max(...calls.map(call => JSON.stringify(call.context).length));
    assert.ok(calls.length > 0 && Number.isFinite(sizes[name]) && sizes[name] > 0, `${name} scale produced requests`);
  }
  assert.ok(sizes.empty < sizes.typical && sizes.typical < sizes.long);
  assert.ok(filler('t', 0, 1) === '');
});
