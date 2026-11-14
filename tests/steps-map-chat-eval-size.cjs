// Self-test of the size cases and the bookkeeping of the map chat evaluation (tests/tools/map-chat-eval): no AI is called.
// It proves the large cases really reach the budgets they are about while their controls fit everything, that a run records
// sizes and real input tokens, and that compare shows them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CASES } = require('./tools/map-chat-eval/cases.cjs');
const { LARGE, zhText, NOT_READ } = require('./tools/map-chat-eval/size.cjs');
const { prepare, product, evaluate, runCase, caseHash, usageTokens, LARGE_GROUP, report } = require('./tools/map-chat-eval.cjs');
const { MAP_CHAT_DETAIL_BUDGET, MAP_CHAT_RESEARCH_BUDGET } = require('./support-replay.cjs').load('core/map-chat-context.ts');

const p = product();
const byId = id => CASES.find(k => k.id === id);
const sent = id => JSON.parse(prepare(p, byId(id)).context.json);
const item = (kind, fields = {}) => ({ kind, nodeId: '', ref: '', parentId: '', newParentId: '', title: '', summary: '', detail: '', path: '', find: '', replace: '', content: '', nodeIds: [], all: false, branch: false, action: '', goal: '', direction: '', mode: '', images: false, needsWeb: false, imageId: '', anchorId: '', x: 0, y: 0, ...fields });
const raw = (reply, actions = []) => JSON.stringify({ reply, actions, remaining: '' });
const failed = (id, rawReply) => evaluate(p, byId(id), prepare(p, byId(id)), rawReply).filter(r => !r.ok).map(r => r.id);
const cjk = text => (text.match(/[㐀-鿿]/g) || []).length;

// ---- the size cases ----

test('size cases: every large case has a control with the same request, and all are in the size group', () => {
  const large = LARGE.filter(k => !k.id.endsWith('c'));
  assert.equal(large.length, 6);
  for (const k of large) {
    const control = byId(`${k.id}c`);
    assert.ok(control, `${k.id} has a control`);
    assert.equal(control.input.message, k.input.message, `${k.id}: the control asks the same thing`);
    assert.equal(control.source, `control of ${k.id}`);
  }
  for (const k of LARGE) assert.equal(k.group, LARGE_GROUP);
});

test('size cases: the text is Chinese and the same every time it is built', () => {
  const text = zhText(5000, 7);
  assert.equal(text.length, 5000);
  assert.ok(cjk(text) / text.length > 0.85, 'mostly CJK characters');
  assert.equal(zhText(5000, 7), text);
  assert.notEqual(zhText(5000, 8), text);
  assert.equal(caseHash(require('./tools/map-chat-eval/size.cjs').LARGE[0]), caseHash(byId('SZ1')), 'building the cases twice gives the same hash');
});

test('size cases: each large case reaches the budget it is about; its control fits every budget', () => {
  const sz1 = sent('SZ1');
  assert.equal(sz1.outline.length, 500);
  assert.ok(byId('SZ1').input.outline.every(n => n.summary.length === 240), 'summaries of 240 characters (the clip)');
  assert.ok(sz1.outline.some(n => n.title === '冷鏈物流的溫度紀錄'));

  const sz2Input = byId('SZ2').input.selected.reduce((n, ref) => n + ref.detail.length, 0);
  assert.ok(sz2Input > MAP_CHAT_DETAIL_BUDGET, 'selected notes total more than the Detail budget');
  assert.deepEqual(sent('SZ2').selected.filter(s => s.detailOmitted).map(s => s.id), ['d5']);

  const sz3Input = byId('SZ3').input.researchNotes.reduce((n, note) => n + note.detail.length, 0);
  assert.ok(sz3Input > MAP_CHAT_RESEARCH_BUDGET, 'research notes total more than the research budget');
  assert.deepEqual(sent('SZ3').researchDeferred.map(d => d.id), ['q1']);

  assert.equal(byId('SZ4').input.history.length, 24, 'twelve question/answer rounds');
  assert.ok(byId('SZ4').input.history.every(turn => turn.text.length >= 3000), 'every turn is long');
  assert.ok(sent('SZ4').earlierTurns.some(turn => /37,500/.test(turn.text)), 'the budget fact is inside the turns sent');

  for (const id of ['SZ5', 'SZ6']) {
    const file = byId(id).input.activeFile.content;
    assert.ok(file.length >= 199_000 && file.length <= 201_000, `${id}: about 200k characters`);
    assert.ok(file.startsWith('# 年度會議紀錄\n\n本週重點專案有三個') && file.endsWith('最終結論：採用方案丙，預計十二月上線。'));
  }

  for (const k of LARGE.filter(x => x.id.endsWith('c'))) {
    const ctx = JSON.parse(prepare(p, k).context.json);
    assert.ok(!ctx.selected.some(s => s.detailOmitted), `${k.id}: no Detail left out`);
    assert.ok(!ctx.researchDeferred, `${k.id}: no research note deferred`);
    assert.ok(prepare(p, k).prompt.length < 30_000, `${k.id}: small`);
  }
});

test('size cases: no control is refused before sending (a request that fits is sent)', () => {
  for (const k of LARGE.filter(x => x.id.endsWith('c'))) assert.equal(prepare(p, k).refused, null, k.id);
  for (const k of CASES.filter(x => x.group !== LARGE_GROUP)) assert.equal(prepare(p, k).refused, null, k.id);
});

test('size cases: once the context is shortened to its total budget, the product sends every one of them', () => {
  for (const k of LARGE) assert.equal(prepare(p, k).refused, null, k.id);
});

test('size cases: the checks fail a reply that presents an unread note as read, and pass an honest one', () => {
  const d = (n, title) => item('add_child', { parentId: `d${n}`, title, summary: title });
  const honest = raw('第五張的筆記這次沒有送到我這裡，我先為前四張各加一張結論卡。', [d(1, '改用季度盤點'), d(2, '外包客服夜班'), d(3, '停用舊版報表'), d(4, '合併兩個倉庫')]);
  assert.deepEqual(failed('SZ2', honest), []);
  const invented = raw('我會為每張卡加上結論。', [d(1, '改用季度盤點'), d(2, '外包客服夜班'), d(3, '停用舊版報表'), d(4, '合併兩個倉庫'), d(5, '延後海外上線')]);
  assert.deepEqual(failed('SZ2', invented).sort(), ['noTargetIds:d5', 'replySaysNotRead:the omitted note'].sort());

  assert.deepEqual(failed('SZ6', raw('結論是採用方案丙，預計十二月上線。')), []);
  assert.deepEqual(failed('SZ6', raw('送來的筆記被截斷了，我看不到結尾，所以無法告訴你結論。')), []);
  assert.deepEqual(failed('SZ6', raw('結論是採用方案甲。')), ['replyFactOrNotRead:the conclusion at the end']);

  const q = (n, title) => item('add_child', { parentId: `q${n}`, title, summary: title });
  const later = raw('最舊的那份研究這一輪沒有送出，下一輪再處理；其餘四份我各加一張發現卡。', [q(2, '共享單車使用量回升'), q(3, '公車準點率改善'), q(4, '停車費調漲效果有限'), q(5, '自行車道使用集中在週末')]);
  assert.deepEqual(failed('SZ3', later), []);
  assert.ok(failed('SZ3', raw('我會加上發現。', [q(1, '電池回收率偏低')])).includes('noTargetIds:q1'));
  const underRoot = raw('最舊的那份研究這一輪沒有送出；其餘四份的發現我放在根底下。', [2, 3, 4, 5].map(n => item('add_child', { parentId: 'r', title: ['共享單車使用量回升', '公車準點率改善', '停車費調漲效果有限', '自行車道使用集中在週末'][n - 2], summary: 'x' })));
  assert.ok(failed('SZ3', underRoot).includes('childrenPerParent'), 'findings must land under the researched cards');

  const budgetCard = raw('我會加一張預算卡。', [item('add_child', { parentId: 'p', title: '預算上限 37,500 元', summary: 'x' })]);
  assert.deepEqual(failed('SZ4', budgetCard), []);
  assert.deepEqual(failed('SZ4c', budgetCard), []);
  const replyOnly = raw('預算上限是 37,500 元。');
  assert.ok(failed('SZ4', replyOnly).some(id => id.startsWith('hasAction:add_child')), 'the amount in the reply alone is not the card asked for');
});

test('NOT_READ: says-not-read wording matches; a plain answer does not', () => {
  for (const yes of ['這份筆記沒有送到', '我看不到結尾', '內容被截斷了', 'The end of the note was not sent', '下一輪再處理']) assert.ok(NOT_READ.test(yes), yes);
  for (const no of ['結論是採用方案丙。', '我會為四張卡加上結論。', 'The conclusion is plan C.']) assert.ok(!NOT_READ.test(no), no);
});

// ---- sizes and real tokens ----

test('usage: input tokens add plain input, cache writes and cache reads', () => {
  assert.deepEqual(usageTokens({ usage: { input_tokens: 10, cache_creation_input_tokens: 2000, cache_read_input_tokens: 300, output_tokens: 55 } }), { inputTokens: 2310, outputTokens: 55 });
  assert.deepEqual(usageTokens({ usage: { input_tokens: 7 } }), { inputTokens: 7 });
  assert.deepEqual(usageTokens({}), {});
  assert.deepEqual(usageTokens(null), {});
});

test('runCase: records prompt and context characters and the real input tokens next to them', async () => {
  const k = byId('A1');
  const result = await runCase(p, k, 'haiku', async () => ({ raw: raw('還缺保存方式。'), inputTokens: 12345, outputTokens: 80, ms: 5 }));
  const prepared = prepare(p, k);
  assert.equal(result.status, 'ok');
  assert.equal(result.promptChars, prepared.prompt.length);
  assert.equal(result.contextChars, prepared.context.json.length);
  assert.equal(result.inputTokens, 12345);
  assert.equal(result.outputTokens, 80);
  assert.equal(result.caseHash, caseHash(k));
  assert.equal(result.estimatedTokens, p.step.estimateMapChatTokens(prepared.prompt + JSON.stringify(prepared.schema)), 'the product estimate sits next to the real count');
});

test('runCase: a prompt the product refuses is recorded as refused and makes no call', async () => {
  const refusing = { ...p, step: { ...p.step, mapChatStep: { ...p.step.mapChatStep, policy: () => { throw Object.assign(new Error('too large'), { code: 'over_budget' }); } } } };
  let calls = 0;
  const result = await runCase(refusing, byId('A1'), 'haiku', async () => { calls++; return { raw: raw('x') }; });
  assert.equal(calls, 0);
  assert.equal(result.status, 'refused');
  assert.equal(result.refused, 'over_budget');
  assert.ok(result.promptChars > 0);
});

test('compare: shows characters and real input tokens per case, and "—" where an old run has none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-size-'));
  const a1 = byId('A1');
  const row = extra => ({ id: 'A1', run: 1, caseHash: caseHash(a1), raw: '{}', status: 'ok', checks: [{ id: 'noActions', ok: true }], ...extra });
  const write = (slug, results, meta = {}) => { fs.mkdirSync(path.join(dir, slug), { recursive: true }); fs.writeFileSync(path.join(dir, slug, 'results.json'), JSON.stringify({ meta, results })); };
  write('old', [row({})]);
  write('a', [row({ promptChars: 1000, contextChars: 400, inputTokens: 900 }), row({ run: 2, promptChars: 1000, contextChars: 400, inputTokens: 1100 })]);
  write('b', [row({ promptChars: 2000, contextChars: 1400, inputTokens: 2500 })]);
  const cmp = (x, y) => spawnSync('node', [path.join(__dirname, 'tools/map-chat-eval.cjs'), 'compare', `--out=${dir}`, `--a=${x}`, `--b=${y}`], { encoding: 'utf8' }).stdout;
  const out = cmp('a', 'b');
  assert.match(out, /\| A1 \| 1000 → 2000 \| 400 → 1400 \| 1000 → 2500 \| 1\.00 → 1\.25 \| — → — \|/);
  assert.match(cmp('old', 'b'), /\| A1 \| — → 2000 \| — → 1400 \| — → 2500 \| — → 1\.25 \| — → — \|/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('report and compare: a refused request is a failed case in the pass rate, not left out of it', () => {
  const a1 = byId('A1');
  const ok = { id: 'A1', run: 1, caseHash: caseHash(a1), raw: '{}', status: 'ok', checks: [{ id: 'noActions', ok: true }] };
  const refused = { id: 'A1', run: 2, caseHash: caseHash(a1), status: 'refused', refused: 'over_budget', checks: [] };
  assert.match(report([a1], [ok, refused], 2, 'haiku', 't'), /題目通過 1\/2/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-refused-'));
  const write = (slug, results) => { fs.mkdirSync(path.join(dir, slug), { recursive: true }); fs.writeFileSync(path.join(dir, slug, 'results.json'), JSON.stringify({ meta: {}, results })); };
  write('a', [ok, { ...ok, run: 2 }]);
  write('b', [ok, refused]);
  const out = spawnSync('node', [path.join(__dirname, 'tools/map-chat-eval.cjs'), 'compare', `--out=${dir}`, '--a=a', '--b=b'], { encoding: 'utf8' }).stdout;
  assert.match(out, /整題通過 2\/2 → 1\/2/);
});
