// Picture-book AI in-place fix (P2): the protection rules (quote, syntax, pictures, links, length, reader notes), the batch outcome, the
// reply parser, the prompt and the one text-only call. Writing the result into a note is the runner's guarded write, tested with it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nodeFsAdapter } = require('./support-fs-adapter.cjs');
const { load } = require('./support-replay.cjs');
const { loadWithAiCalls } = require('./support-ai-calls.cjs');

const fix = load('core/book-pipeline/ai-fix.ts');
const stepMod = loadWithAiCalls('core/steps/book-pipeline/ai-fix.ts');
const { AiExchangeLog } = load('ai-exchange-log.ts');
const plain = value => JSON.parse(JSON.stringify(value));

const IMG = '![蒙娜麗莎](https://upload.wikimedia.org/a.png)';
const S1 = '《蒙娜麗莎》完成於 1503 年。';
const S2 = '畫作尺寸是 53×77 公分。';
const TEXT = `${S1}${S2}\n\n${IMG}\n圖說：蒙娜麗莎\n\n後面還有一段說明文字。`;
const edit = (id, quote, replacement, extra = {}) => ({ id, quote, replacement, ...extra });
const run = (edits, guard = {}, text = TEXT) => fix.applyAiEdits(text, edits.map(e => ({ id: e.id })), edits, guard);

test('a good edit replaces only the quoted sentence; the pictures and everything else stay byte for byte', () => {
  const r = run([edit('P1', S1, '《蒙娜麗莎》約於 1503 至 1519 年間完成。')]);
  assert.equal(r.applied, 1); assert.deepEqual(plain(r.outcomes), [{ id: 'P1', applied: true }]);
  assert.equal(r.text, TEXT.replace(S1, '《蒙娜麗莎》約於 1503 至 1519 年間完成。'));
  assert.ok(r.text.includes(IMG));
});

test('a quote that is not in the text, or is in it twice, is not applied and the text is untouched', () => {
  const missing = run([edit('P1', '原文沒有這句。', '新句。')]);
  assert.deepEqual(plain(missing.outcomes), [{ id: 'P1', applied: false, reason: 'fix_quote_missing' }]); assert.equal(missing.text, TEXT);
  const twice = run([edit('P1', '說明', '解說')], {}, '說明一。說明二。');
  assert.equal(twice.outcomes[0].reason, 'fix_quote_missing'); assert.equal(twice.applied, 0);
  assert.equal(run([edit('P1', '  ', 'x')]).outcomes[0].reason, 'fix_quote_missing');
});

test('program syntax in the new sentence is refused: %%, ==, a link, an address, a heading, a callout, HTML, a line break', () => {
  for (const bad of ['新句 %% 註 %%。', '新句 ==標==。', '新句[連結](https://x.example/a)。', '新句 https://x.example。', '## 標題', '> [!note] x', '新句<b>粗</b>。', '第一行\n第二行', '   ', ''])
    assert.equal(run([edit('P1', S1, bad)]).outcomes[0].reason, 'fix_forbidden_syntax', JSON.stringify(bad));
  assert.equal(run([edit('P1', S1, 'x')]).applied, 1);
});

test('a fix that would delete or change a picture is refused and the text stays byte for byte', () => {
  const r = run([edit('P1', IMG, '一張圖的說明。')]);
  assert.deepEqual(plain(r.outcomes), [{ id: 'P1', applied: false, reason: 'fix_refused_picture' }]); assert.equal(r.text, TEXT);
  const wiki = run([edit('P1', '![[a.png]]', '沒有圖了。')], {}, `前文。\n![[a.png]]\n後文。`);
  assert.equal(wiki.outcomes[0].reason, 'fix_refused_picture');
});

test('a fix that drops an inline link is refused; the link of an untouched sentence is no problem', () => {
  const text = `種子要先泡水（[OSU](https://extension.oregonstate.edu/a)）。另一句 5 公分。`;
  assert.equal(run([edit('P1', '（[OSU](https://extension.oregonstate.edu/a)）', '')], {}, text).applied, 0);
  assert.equal(run([edit('P1', '另一句 5 公分。', '另一句 6 公分。')], {}, text).applied, 1);
});

test('length: a fix that leaves the chapter below the asked minimum or shorter than it was while below it is refused', () => {
  const body = '字'.repeat(100);
  const guard = { length: { unit: '字', min: 90 } };
  assert.equal(run([edit('P1', body, '字'.repeat(80))], guard, body).outcomes[0].reason, 'fix_refused_length');
  assert.equal(run([edit('P1', body, '字'.repeat(95))], guard, body).applied, 1);
  const short = '字'.repeat(50);
  assert.equal(run([edit('P1', short, '字'.repeat(40))], guard, short).outcomes[0].reason, 'fix_refused_length');
  assert.equal(run([edit('P1', short, '字'.repeat(60))], guard, short).applied, 1);
  assert.equal(run([edit('P1', body, '字'.repeat(10))], {}, body).applied, 1);
  // pictures and captions never count toward the length
  const withPic = `${body}\n\n${IMG}\n${'圖'.repeat(500)}\n`;
  assert.equal(run([edit('P1', body, '字'.repeat(80))], guard, withPic).outcomes[0].reason, 'fix_refused_length');
});

test('a quote on a reader\'s note is hand-edited ground: refused', () => {
  const text = '種子約三天發芽。==這句我標了==%%備註#1：我的備註%%。後文。';
  assert.equal(run([edit('P1', '這句我標了', '改')], {}, text).outcomes[0].reason, 'hand_edited');
  assert.equal(run([edit('P1', '種子約三天發芽。', '種子約兩至三天發芽。')], {}, text).applied, 1);
});

test('a batch: each edit is judged alone, unknown and repeated ids are ignored, and when nothing applies the text is the original', () => {
  const r = fix.applyAiEdits(TEXT, [{ id: 'P1' }, { id: 'P2' }, { id: 'P3' }], [edit('P1', '沒有的句子。', 'x'), edit('P2', S2, '畫作尺寸是 77×53 公分。'), edit('P2', S1, 'again'), edit('P9', S1, 'unknown')], {});
  assert.deepEqual(plain(r.outcomes), [{ id: 'P1', applied: false, reason: 'fix_quote_missing' }, { id: 'P2', applied: true }]);
  assert.equal(r.applied, 1); assert.equal(r.text, TEXT.replace(S2, '畫作尺寸是 77×53 公分。'));
  const none = run([edit('P1', '沒有。', 'x')]); assert.equal(none.applied, 0); assert.equal(none.text, TEXT);
  assert.deepEqual(plain(fix.refusedReasons(r.outcomes)), { P1: 'fix_quote_missing' });
  const crlf = run([edit('P1', S1, '新句。')], {}, TEXT.replace(/\n/g, '\r\n'));
  assert.equal(crlf.applied, 1); assert.ok(crlf.text.includes('\r\n'));
  assert.equal(run([edit('P1', S1, '新的句子：「蒙娜麗莎」🙂。')]).applied, 1);
});

test('an earlier edit changes what a later quote can match (the text is edited in order)', () => {
  const r = run([edit('P1', S1, 'AAA。'), edit('P2', 'AAA。', 'BBB。')]);
  assert.equal(r.applied, 2); assert.ok(r.text.startsWith('BBB。'));
});

// ---- the step ----

const base = { language: 'zh-TW', model: 'claude-sonnet-4-6', reasoning: 'low' };
const target = { id: 'P1', quote: S1, problem: '年份與來源不符', suggestion: '改為 1503 至 1519 年' };
const request = (extra = {}) => ({ ...base, chapters: [{ number: 1, title: '蒙娜麗莎', text: `${S1}${S2}` }], targets: [target], ...extra });

test('the prompt carries the chapter text and the problems; no picture, no model name', () => {
  const prompt = stepMod.aiFixStep.render(request());
  assert.ok(prompt.includes(JSON.stringify(`${S1}${S2}`))); assert.ok(prompt.includes('年份與來源不符')); assert.ok(!prompt.includes(base.model));
  assert.match(prompt, /Do not search the web/);
  assert.throws(() => stepMod.aiFixStep.policy('p', request({ targets: [] })), /needs a problem/);
  assert.throws(() => stepMod.aiFixStep.policy('p', request({ chapters: [{ number: 1, title: 't', text: ' ' }] })), /needs the chapter text/);
});

test('parse: only edits are read, coerced and capped; a wrong shape fails', () => {
  const parsed = plain(stepMod.parseAiFix(JSON.stringify({ edits: [{ id: ' P1 ', chapter: 2, quote: ' q ', replacement: ' r ', extra: 1 }, { id: 7 }], text: 'rewrite' })));
  assert.deepEqual(parsed, [{ id: 'P1', chapter: 2, quote: 'q', replacement: 'r' }, { id: '', quote: '', replacement: '' }]);
  assert.equal(stepMod.parseAiFix(JSON.stringify({ edits: Array.from({ length: 60 }, () => ({})) })).length, 40);
  assert.throws(() => stepMod.parseAiFix('x'), /not JSON/); assert.throws(() => stepMod.parseAiFix('{"edits":{}}'), /must be an array/);
});

test('runAiFix: text only, no web, one reservation, nothing of the chapter in the exchange log', async () => {
  const runs = [];
  const log = new AiExchangeLog(nodeFsAdapter, path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vam-aifix-')), 'ai-exchanges.json'), error => { throw error; });
  const runtime = () => ({ runTask: async (...args) => { runs.push(args); args[4].onRequest?.({ provider: 'codex', input: [{ type: 'text', text: args[0] }] }); return JSON.stringify({ edits: [{ id: 'P1', chapter: 1, quote: S1, replacement: '新句。' }] }); } });
  const calls = new stepMod.AiCalls({ runtimeFor: model => stepMod.aiRuntimeForModel(model, { claude: runtime, codex: () => runtime() }), exchanges: () => log });
  let reserved = 0;
  const edits = await stepMod.runAiFix(calls, request(), { signal: new AbortController().signal, admission: { reserve: async () => { reserved += 1; } } });
  assert.equal(reserved, 1); assert.equal(runs.length, 1); assert.equal(runs[0][4].textOnly, true); assert.equal(runs[0][4].searchBudget, 0);
  assert.deepEqual(plain(edits), [{ id: 'P1', chapter: 1, quote: S1, replacement: '新句。' }]);
  const dump = JSON.stringify(log.getEntries()); assert.ok(log.getEntries().length >= 1); assert.ok(!dump.includes('1503') && !dump.includes('蒙娜麗莎'));
});
