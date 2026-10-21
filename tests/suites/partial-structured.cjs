// Partial StructuredOutput JSON: summary/detail extraction from an incomplete buffer. Fixtures are synthetic.
const assert = require('node:assert/strict');
const { test, load } = require('../support.cjs');

const { partialFields, StructuredPreview } = load('ai/partial-structured.ts');
const fields = buffer => JSON.parse(JSON.stringify(partialFields(buffer)));

test('partial structured: complete and in-progress strings report completeness', () => {
  assert.deepEqual(fields('{"summary":"Alpha","detail":"Beta'), { summary: 'Alpha', summaryComplete: true, detail: 'Beta', detailComplete: false });
  assert.deepEqual(fields('{"summary":"Alpha","detail":"Beta"}'), { summary: 'Alpha', summaryComplete: true, detail: 'Beta', detailComplete: true });
  assert.deepEqual(fields(''), { summaryComplete: false, detailComplete: false });
  assert.deepEqual(fields('{'), { summaryComplete: false, detailComplete: false });
});

test('partial structured: decodes JSON string escapes', () => {
  const text = fields('{"summary":"line1\\nline2 \\"q\\" back\\\\slash \\u00e9 \\ud83d\\ude00 tab\\t"}');
  assert.equal(text.summary, 'line1\nline2 "q" back\\slash é \u{1F600} tab\t');
  assert.equal(text.summaryComplete, true);
});

test('partial structured: a cut inside an escape drops the incomplete tail', () => {
  assert.equal(fields('{"summary":"ab\\u00').summary, 'ab');
  assert.equal(fields('{"summary":"ab\\u').summary, 'ab');
  assert.equal(fields('{"summary":"ab\\').summary, 'ab');
  assert.equal(fields('{"summary":"ab\\ud83d').summary, 'ab', 'a lone high surrogate waits for its partner');
  assert.equal(fields('{"summary":"ab\\ud83d\\').summary, 'ab');
  assert.equal(fields('{"summary":"ab\\ud83d\\ude').summary, 'ab');
  assert.equal(fields('{"summary":"ab\\ud83d\\ude00').summary, 'ab\u{1F600}');
  assert.equal(fields('{"summary":"ab\\ud83d\\ude00').summaryComplete, false);
  assert.equal(fields('{"summary":"ab\\n').summary, 'ab\n');
});

test('partial structured: key order is free and keys may be absent', () => {
  const reversed = fields('{"detail":"D","suggestions":[],"summary":"S');
  assert.equal(reversed.detail, 'D');
  assert.equal(reversed.detailComplete, true);
  assert.equal(reversed.summary, 'S');
  assert.equal(reversed.summaryComplete, false);
  const noDetail = fields('{"summary":"S","suggestions":[{"title":"t"}]}');
  assert.equal(noDetail.summary, 'S');
  assert.equal(noDetail.detail, undefined);
  assert.equal(noDetail.detailComplete, false);
});

test('partial structured: nested keys and values that mention summary or detail are ignored', () => {
  const nested = fields('{"suggestions":[{"summary":"nested","detail":"nested","x":"\\"summary\\":\\"no\\""}],"meta":{"detail":"deep"},"note":"summary","summary":"real","detail":"real detail"}');
  assert.equal(nested.summary, 'real');
  assert.equal(nested.detail, 'real detail');
  const open = fields('{"suggestions":[{"summary":"nested"');
  assert.equal(open.summary, undefined);
});

test('partial structured: malformed input never throws', () => {
  for (const input of ['not json', '[1,2]', '{"summary"', '{"summary":', '{"summary" 3}', '{"a":{"b":[', '{"summary":12,"detail":"d"}', null, undefined, 42])
    assert.doesNotThrow(() => partialFields(input), String(input));
  assert.equal(fields('{"summary":12,"detail":"d"}').detail, 'd');
});

test('StructuredPreview: append accumulates, start replaces, reject retracts', () => {
  const preview = new StructuredPreview();
  preview.start();
  preview.append('{"summary":"One","det');
  preview.append('ail":"First');
  assert.deepEqual(JSON.parse(JSON.stringify(preview.snapshot())), { summary: 'One', summaryComplete: true, detail: 'First', detailComplete: false });
  preview.reject();
  assert.deepEqual(JSON.parse(JSON.stringify(preview.snapshot())), { summaryComplete: false, detailComplete: false });
  preview.start();
  preview.append('{"summary":"Two"}');
  assert.equal(preview.snapshot().summary, 'Two');
  preview.start();
  assert.equal(preview.snapshot().summary, undefined, 'a new StructuredOutput call replaces the previous one');
  const copy = preview.snapshot();
  copy.summary = 'mutated';
  assert.equal(preview.snapshot().summary, undefined, 'snapshot is a copy');
});
