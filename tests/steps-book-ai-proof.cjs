// Picture-book AI proofread contract (P1): the reply whitelist, the word-for-word quote rule and N, sources, the two-round comparison,
// what stays open, and the step (parse, prompt inputs, one web-search call). The runner and the machine are tested elsewhere.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nodeFsAdapter } = require('./support-fs-adapter.cjs');
const { load } = require('./support-replay.cjs');
const { loadWithAiCalls } = require('./support-ai-calls.cjs');

const core = load('core/book-pipeline/ai-proof.ts');
const stepMod = loadWithAiCalls('core/steps/book-pipeline/ai-proof.ts');
const { AiExchangeLog } = load('ai-exchange-log.ts');

const plain = value => JSON.parse(JSON.stringify(value));
const BODY = '《蒙娜麗莎》完成於 1503 年。畫作尺寸是 77×53 公分。有學者認為這幅畫沒有畫完。';
const LISTED = 'https://example.org/mona';
const raw = (over = {}) => ({ id: 'P1', kind: 'fact', quote: '《蒙娜麗莎》完成於 1503 年。', verdict: 'problem', problem: '年份與來源不符', fixable: true, why: '', suggestion: '改為 1503 至 1519 年', sources: [LISTED], ...over });
const review = (checks, input = {}, prior = []) => core.reviewAiProof({ checks, prior }, { body: BODY, allowedSources: [LISTED], ...input });

// ---- N and the quote rule ----

test('a quote that is not in the text drops the whole item: it is not counted in N and nothing can be applied to it', () => {
  const r = review([raw(), raw({ id: 'P2', quote: '這句話原文裡沒有。' }), raw({ id: 'P3', quote: '' })]);
  assert.deepEqual(plain(r.checks.map(c => c.id)), ['P1']);
  assert.equal(r.dropped.quote, 2);
  // a look-alike sentence with the same figure is not the quote either (verbatimQuote would hand back another sentence)
  assert.equal(review([raw({ quote: '畫作尺寸是 77×53 厘米。' })]).checks.length, 0);
  assert.equal(review([raw({ quote: 'x'.repeat(301) })]).checks.length, 0);
  assert.equal(review([raw({ quote: '《蒙娜麗莎》完成於 1503 年。\n畫作尺寸是 77×53 公分。' })]).checks.length, 0);
});

test('spacing and punctuation differences in a quote still match; CRLF text and Unicode quotes are read', () => {
  assert.equal(review([raw({ quote: '《蒙娜麗莎》完成於1503年' })]).checks.length, 1);
  const crlf = core.reviewAiProof({ checks: [raw({ quote: 'Line two states 5 cm.' })], prior: [] }, { body: 'Line one.\r\nLine two states 5 cm.\r\n', allowedSources: [] });
  assert.equal(crlf.checks.length, 1);
});

test('kind and verdict outside the whitelist are dropped, duplicates keep the first, more than 40 are cut and counted', () => {
  const r = review([raw({ kind: 'opinion' }), raw({ id: 'P2', verdict: 'maybe' }), raw({ id: 'P3' }), raw({ id: 'P3', problem: 'again' }), raw({ id: '' })]);
  assert.deepEqual(plain(r.checks.map(c => c.id)), ['P3']);
  assert.deepEqual(plain(r.dropped), { kind: 1, verdict: 1, quote: 0, invalid: 1, duplicate: 1, truncated: 0 });
  const many = review(Array.from({ length: 45 }, (_, i) => raw({ id: `P${i + 1}`, verdict: 'ok', problem: '' })));
  assert.equal(many.checks.length, 40); assert.equal(many.dropped.truncated, 5);
  assert.equal(review(Array.from({ length: 3 }, (_, i) => raw({ id: `P${i + 1}` })), { maxItems: 2 }).checks.length, 2);
});

test('an empty reply or an ok-only reply has N of the checks and nothing open', () => {
  assert.equal(review([]).checks.length, 0);
  const ok = review([raw({ verdict: 'ok', problem: '' })]);
  assert.equal(ok.checks.length, 1); assert.deepEqual(plain(core.unresolvedItems(ok.checks)), []);
  assert.equal(core.checkState(ok.checks[0]), 'ok');
  const unv = review([raw({ verdict: 'unverifiable', problem: '', fixable: false })]);
  assert.equal(core.checkState(unv.checks[0]), 'unverifiable'); assert.equal(core.unresolvedItems(unv.checks).length, 0);
});

test('a problem with no text is dropped; text fields are one plain line', () => {
  assert.equal(review([raw({ problem: '   ' })]).checks.length, 0);
  const c = review([raw({ problem: '## 標題\n第二行 %% x', suggestion: '# 改\n法' })]).checks[0];
  assert.doesNotMatch(c.problem, /\n/); assert.doesNotMatch(c.problem, /^#{1,2}\s/); assert.doesNotMatch(c.suggestion, /\n|^#{1,2}\s/);
});

test('sources: only the chapter\'s listed addresses this call opened, https only, no duplicates', () => {
  const r = review([raw({ sources: [LISTED, LISTED, 'https://other.example/x', 'http://example.org/mona', 'javascript:alert(1)', 'https://u:p@example.org/mona'] })]);
  assert.deepEqual(plain(r.checks[0].sources), [LISTED]);
  assert.deepEqual(plain(review([raw()], { openedUrls: [] }).checks[0].sources), []);
  assert.deepEqual(plain(review([raw()], { openedUrls: [LISTED] }).checks[0].sources), [LISTED]);
});

// ---- fixable / unfixable ----

test('fixable only for a problem the proofreader says editing can repair; a named reason makes it unfixable', () => {
  const r = review([raw(), raw({ id: 'P2', quote: '畫作尺寸是 77×53 公分。', fixable: false, why: 'sources_conflict' }), raw({ id: 'P3', quote: '有學者認為這幅畫沒有畫完。', fixable: true, why: 'source_unreachable' }), raw({ id: 'P4', quote: '畫作尺寸是 77×53 公分。', fixable: false, why: 'bogus' })]);
  assert.deepEqual(plain(r.checks.map(c => core.checkState(c))), ['fixable', 'unfixable', 'unfixable', 'unfixable']);
  assert.deepEqual(plain(core.fixTargetsOf(r.checks).map(t => t.id)), ['P1']);
  assert.deepEqual(plain(core.unresolvedItems(r.checks).map(i => `${i.id}:${i.reason}`)), ['P1:still_present', 'P2:sources_conflict', 'P3:source_unreachable', 'P4:unfixable']);
});

// ---- two rounds ----

test('the re-check: a problem reported again on the same quote is still open whatever the model says; "resolved" cannot hide it', () => {
  const prior = [{ id: 'P1', quote: '《蒙娜麗莎》完成於 1503 年。', problem: '年份' }, { id: 'P2', quote: '畫作尺寸是 77×53 公分。', problem: '尺寸' }];
  const next = review([raw({ id: 'P7', quote: '《蒙娜麗莎》完成於 1503 年。' })], {}, [{ id: 'P1', status: 'resolved' }, { id: 'P2', status: 'resolved' }]);
  const d = core.compareRounds(prior, next, BODY);
  assert.deepEqual(plain(d.still.map(i => i.id)), ['P1']); assert.deepEqual(plain(d.resolved.map(i => i.id)), ['P2']); assert.equal(d.fresh.length, 0);
  // "still" with the quote still in the text counts, "still" for a sentence that is gone does not
  const said = core.compareRounds(prior, review([], {}, [{ id: 'P1', status: 'still' }, { id: 'P2', status: 'still' }]), '新的正文。畫作尺寸是 77×53 公分。');
  assert.deepEqual(plain(said.still.map(i => i.id)), ['P2']); assert.deepEqual(plain(said.resolved.map(i => i.id)), ['P1']);
  const fresh = core.compareRounds([], review([raw()]), BODY);
  assert.equal(fresh.fresh.length, 1);
});

test('after the last round a fixable problem still reported is still_present; a refused or failed fix keeps its own reason', () => {
  const r = review([raw(), raw({ id: 'P2', quote: '畫作尺寸是 77×53 公分。' })]);
  assert.deepEqual(plain(core.unresolvedItems(r.checks, { refused: { P2: 'fix_refused_picture' } }).map(i => i.reason)), ['still_present', 'fix_refused_picture']);
  assert.deepEqual(plain(core.unresolvedItems(r.checks, { fixFailed: true }).map(i => i.reason)), ['fix_failed', 'fix_failed']);
});

test('an unfinished proofread is one open item and never an empty list, so "all solved" cannot show', () => {
  const ok = review([raw({ verdict: 'ok', problem: '' })]);
  const open = core.unresolvedItems(ok.checks, { incomplete: true });
  assert.deepEqual(plain(open.map(i => i.reason)), ['proof_incomplete']);
});

test('whole-book mode: each quote is checked in its own chapter, chapter numbers are validated', () => {
  const book = ['第一章說種子三天發芽。', '第二章說種子一到兩天發芽。'];
  const r = core.reviewAiProof({ checks: [raw({ id: 'P1', quote: '第二章說種子一到兩天發芽。', chapter: 2, otherChapter: 1 }), raw({ id: 'P2', quote: '第二章說種子一到兩天發芽。', chapter: 1 }), raw({ id: 'P3', quote: '第一章說種子三天發芽。', chapter: 9 }), raw({ id: 'P4', quote: '第一章說種子三天發芽。', chapter: 1, otherChapter: 1 })], prior: [] }, { body: book, allowedSources: [] });
  assert.deepEqual(plain(r.checks.map(c => `${c.id}:${c.chapter}:${c.otherChapter}`)), ['P1:2:1', 'P4:1:undefined']);
});

test('the key and the body: pictures and notes are not claims; the key changes with the revision or the text', () => {
  assert.equal(core.aiProofBody('文字一。\n\n![圖](https://example.org/a.png)\n圖說\n\n文字二。'), '文字一。\n\n文字二。');
  assert.notEqual(core.aiProofKey(1, 'a'), core.aiProofKey(2, 'a')); assert.notEqual(core.aiProofKey(1, 'a'), core.aiProofKey(1, 'b')); assert.equal(core.aiProofKey(3, 'a'), core.aiProofKey(3, 'a'));
});

test('chapterSources reads the shape live chapters have: text links in the body and link lines of the Sources section, not picture credits', () => {
  const detail = ['## 詳細內容', '種子可以直接播種（[OSU 推廣單位](https://extension.oregonstate.edu/a)）。', '', '![圖](https://upload.wikimedia.org/x.png)', '圖說（[內嵌圖說連結](https://commons.wikimedia.org/c)）', '', '## 來源', '', '- 圖「Soil」：commons.wikimedia.org · 作者 X（[連結](https://commons.wikimedia.org/wiki/File:Soil.jpg)）', '- [VT 日照建議](https://pubs.ext.vt.edu/426/426-336.html)', '- [重複](https://extension.oregonstate.edu/a)', '- [不安全](http://insecure.example/x)', '', '> [!vam-book]- 研究備註', '> - [不算](https://hidden.example/y)'].join('\n');
  assert.deepEqual(plain(core.chapterSources(detail).map(s => s.url)), ['https://extension.oregonstate.edu/a', 'https://pubs.ext.vt.edu/426/426-336.html']);
  assert.deepEqual(plain(core.chapterSources('沒有連結的章。')), []);
  assert.deepEqual(plain(core.chapterSources('## 來源\r\n- [A](https://a.example/p)\r\n').map(s => s.title)), ['A']);
});

// ---- the step ----

const base = { language: 'zh-TW', model: 'claude-opus-4-8', reasoning: 'low' };
const goodReply = (checks = [raw()], prior = []) => JSON.stringify({ checks, prior });
const page = url => ({ method: 'item/completed', params: { item: { type: 'webSearch', action: { type: 'openPage', url } } } });
const signal = () => new AbortController().signal;
function harness({ answer = goodReply(), events = [] } = {}) {
  const runs = [];
  const log = new AiExchangeLog(nodeFsAdapter, path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vam-aiproof-')), 'ai-exchanges.json'), error => { throw error; });
  const runtime = () => ({ runTask: async (...args) => {
    runs.push(args);
    args[4].onRequest?.({ provider: 'codex', input: [{ type: 'text', text: args[0] }] });
    for (const event of events) args[4].onWebSearchEvent?.(event);
    return answer;
  } });
  const calls = new stepMod.AiCalls({ runtimeFor: model => stepMod.aiRuntimeForModel(model, { claude: runtime, codex: () => runtime() }), exchanges: () => log });
  return { runs, log, calls };
}
const request = (extra = {}) => ({ ...base, title: '蒙娜麗莎', body: BODY, sources: [{ url: LISTED, title: 'Mona' }], ...extra });

test('the prompt carries the chapter, its listed sources and the prior list; nothing of a plan, checklist or author', () => {
  const prompt = stepMod.aiProofStep.render(request({ prior: [{ id: 'P1', quote: '《蒙娜麗莎》完成於 1503 年。', problem: '年份' }], sources: [{ url: LISTED, title: 'Mona' }, { url: 'http://insecure.example/x', title: 'bad' }, { url: LISTED, title: 'dup' }] }));
  assert.ok(prompt.includes(JSON.stringify(BODY))); assert.ok(prompt.includes(LISTED)); assert.ok(!prompt.includes('insecure.example'));
  assert.ok(prompt.includes('[{"id":"P1","quote":"《蒙娜麗莎》完成於 1503 年。","problem":"年份"}]'));
  assert.ok(!prompt.includes(base.model)); assert.doesNotMatch(prompt, /\bC1\b|self-check result/);
  assert.match(stepMod.aiProofStep.render(request()), /array means this is the first check[^\n]*: \[\]/);
  assert.throws(() => stepMod.aiProofStep.policy('p', request({ body: '  ' })), /needs the chapter text/);
});

test('parse: only checks and prior are read; a reply that is not that shape fails; entries are coerced, not judged', () => {
  const parsed = plain(stepMod.parseAiProof(JSON.stringify({ checks: [{ id: ' P1 ', kind: 'weird', quote: 'q', verdict: 'ok', fixable: 'yes', sources: ['a', 3], extra: 1 }], prior: [{ id: 'P1', status: 'still' }], rewrite: 'x' })));
  assert.equal(parsed.checks[0].id, 'P1'); assert.equal(parsed.checks[0].kind, 'weird'); assert.equal(parsed.checks[0].fixable, false); assert.deepEqual(parsed.checks[0].sources, ['a']);
  assert.equal(parsed.prior.length, 1);
  assert.throws(() => stepMod.parseAiProof('nope'), /not JSON/);
  assert.throws(() => stepMod.parseAiProof('{"checks":"x"}'), /must be an array/);
  assert.throws(() => stepMod.parseAiProof('{"checks":[1]}'), /must be an object/);
  assert.equal(stepMod.parseAiProof('{"checks":[]}').prior.length, 0);
});

test('runAiProof: with sources: web search only, budget 4, one reservation, sources only when listed and opened, nothing in the exchange log', async () => {
  const h = harness({ answer: goodReply([raw({ sources: [LISTED, 'https://other.example/x'] })]), events: [page(LISTED), page('https://other.example/x')] });
  let reserved = 0;
  const result = await stepMod.runAiProof(h.calls, request(), { signal: signal(), admission: { reserve: async () => { reserved += 1; } } });
  assert.equal(reserved, 1); assert.equal(h.runs.length, 1);
  const controls = h.runs[0][4];
  assert.equal(controls.webSearchOnly, true); assert.equal(controls.searchBudget, 4);
  assert.deepEqual(plain(result.checks[0].sources), [LISTED]);
  const unopened = harness({ events: [] });
  assert.deepEqual(plain((await stepMod.runAiProof(unopened.calls, request(), { signal: signal() })).checks[0].sources), []);
  const dump = JSON.stringify(h.log.getEntries()); assert.ok(h.log.getEntries().length >= 1); assert.ok(!dump.includes('1503') && !dump.includes('蒙娜麗莎'), 'chapter text and reply stay out of the log');
  const bad = harness({ answer: 'not json' });
  await assert.rejects(stepMod.runAiProof(bad.calls, request(), { signal: signal() }));
});

test('runAiProof: a chapter with no sources is a text-only call (not blocked by SearchNotPerformed) and the prompt says so', async () => {
  const h = harness({ answer: goodReply([raw({ sources: [] })]), events: [] });
  await stepMod.runAiProof(h.calls, request({ sources: [] }), { signal: signal() });
  const controls = h.runs[0][4];
  assert.notEqual(controls.webSearchOnly, true); assert.equal(controls.textOnly, true); assert.equal(controls.searchBudget, 0);
  assert.ok(stepMod.aiProofStep.render(request({ sources: [] })).includes('lists no sources'));
  const withSources = stepMod.aiProofStep.render(request());
  assert.ok(withSources.includes('source_unreachable') && !withSources.includes('lists no sources'));
});

// ---- P6a: the whole-book step ----
const bookRequest = (extra = {}) => ({ ...base, chapters: [{ title: '一', text: '第一章說發芽要三天。' }, { title: '二', text: '第二章說發芽要一週。' }], ...extra });

test('the book prompt carries every chapter with its number, the leads and the prior list; no web, no sources', () => {
  const prompt = stepMod.aiBookProofStep.render(bookRequest({ hints: ['chapter 1 vs chapter 2'], prior: [{ id: 'B1', quote: 'q', problem: 'p' }] }));
  assert.ok(prompt.includes('[{"number":1,"title":"一","text":"第一章說發芽要三天。"},{"number":2,'));
  assert.ok(prompt.includes('["chapter 1 vs chapter 2"]')); assert.ok(prompt.includes('[{"id":"B1","quote":"q","problem":"p"}]'));
  assert.ok(!prompt.includes(base.model));
  assert.throws(() => stepMod.aiBookProofStep.policy('p', bookRequest({ chapters: [{ title: 'x', text: ' ' }] })), /needs the text/);
});

test('runAiBookProof: a text-only call; the quote is checked in the chapter it names, other chapters are ignored, no web search', async () => {
  const good = { id: 'B1', kind: 'consistency', chapter: 2, otherChapter: 1, quote: '第二章說發芽要一週。', verdict: 'problem', problem: '與第一章不同', fixable: true, why: '', suggestion: '統一', sources: [] };
  const wrongChapter = { ...good, id: 'B2', chapter: 1 };
  const h = harness({ answer: goodReply([good, wrongChapter]) });
  const result = await stepMod.runAiBookProof(h.calls, bookRequest(), { signal: signal(), admission: { reserve: async () => {} } });
  assert.deepEqual(plain(result.checks.map(c => [c.id, c.chapter, c.otherChapter])), [['B1', 2, 1]]);
  assert.equal(result.dropped.quote, 1);
  assert.notEqual(h.runs[0][4].webSearchOnly, true);
});
