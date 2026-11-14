// Map chat's token estimate (core/steps/map-chat/step.ts estimateMapChatTokens): Chinese is counted at 1.25 tokens a character,
// calibrated on the real tokenizer (13,000 Chinese characters = about 16,000 tokens), other text at length / 4 as before. A Chinese
// request too large for the model is refused before sending (over_budget); requests of ordinary size are sent as before.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const { estimateTokens } = load('ai/context-builder.ts');
const { estimateMapChatTokens, MAP_CHAT_TOKEN_BUDGET, MAP_CHAT_MODEL_WINDOW, MAP_CHAT_CJK_TOKENS_PER_CHAR, mapChatStep } = load('core/steps/map-chat/step.ts');
const { prepareStep } = load('core/step-runner.ts');
const { buildMapChatContext } = load('core/map-chat-context.ts');
const { zhText } = require('./tools/map-chat-eval/size.cjs');

/** Real tokens per character measured with the model's tokenizer (inventory 2026-11-13). */
const MEASURED_ZH = 16_000 / 13_000;
const MEASURED_EN = 1 / 4;
const base = { mapTitle: '地圖', outline: [], selected: [], references: [], snippets: [], files: [], history: [] };
const request = (input, message = '整理這份筆記') => ({ message, context: buildMapChatContext({ ...base, ...input }), language: 'zh-TW', model: 'claude:haiku', reasoning: 'low' });
const refusal = req => { try { prepareStep(mapChatStep, req); return null; } catch (error) { return error.code; } };

test('Chinese is not under-estimated: at least the measured 16,000 tokens for 13,000 characters', () => {
  const zh = zhText(13_000, 3);
  const cjk = (zh.match(/[㐀-鿿　-〿＀-￯]/g) || []).length;
  assert.ok(estimateMapChatTokens(zh) >= Math.ceil(cjk * MEASURED_ZH), `${estimateMapChatTokens(zh)} for ${cjk} CJK characters`);
  assert.ok(estimateMapChatTokens('中'.repeat(13_000)) >= 16_000);
  assert.ok(estimateTokens('中'.repeat(13_000)) < 4_000, 'the shared estimate under-counts it about 5x (why map chat has its own)');
  assert.ok(MAP_CHAT_CJK_TOKENS_PER_CHAR >= MEASURED_ZH);
});

test('English is estimated as before (length / 4) and so is not under-estimated either', () => {
  const en = 'The team discussed delivery dates and staffing. '.repeat(200);
  assert.equal(estimateMapChatTokens(en), estimateTokens(en));
  assert.ok(estimateMapChatTokens(en) >= en.length * MEASURED_EN);
  assert.equal(estimateMapChatTokens(''), 0);
});

test('mixed text: each part counted at its own rate, never below either the shared estimate or the measured rates', () => {
  const zh = '中文內容'.repeat(1000);
  const en = 'english text'.repeat(1000);
  const mixed = zh + en + JSON.stringify({ title: '標題', summary: 'summary' });
  assert.ok(estimateMapChatTokens(mixed) >= Math.floor(4000 * MEASURED_ZH + en.length * MEASURED_EN));
  assert.ok(estimateMapChatTokens(mixed) >= estimateTokens(mixed));
  assert.equal(estimateMapChatTokens(zh + en), estimateMapChatTokens(zh) + estimateMapChatTokens(en));
});

test('other CJK scripts and characters outside the BMP count as CJK, one character each', () => {
  assert.equal(estimateMapChatTokens('ひらがなカタカナ'), Math.ceil(8 * MAP_CHAT_CJK_TOKENS_PER_CHAR));
  assert.equal(estimateMapChatTokens('한국어'), Math.ceil(3 * MAP_CHAT_CJK_TOKENS_PER_CHAR));
  assert.equal(estimateMapChatTokens('，。「」！'), Math.ceil(5 * MAP_CHAT_CJK_TOKENS_PER_CHAR));
  assert.equal(estimateMapChatTokens('𠀀𠀁'), Math.ceil(2 * MAP_CHAT_CJK_TOKENS_PER_CHAR), 'a surrogate pair is one character');
});

test('the budget leaves room in the model window for the CLI system prompt and the reply', () => {
  assert.equal(MAP_CHAT_MODEL_WINDOW, 200_000);
  assert.ok(MAP_CHAT_TOKEN_BUDGET <= MAP_CHAT_MODEL_WINDOW - 40_000);
});

test('a Chinese context that the length / 4 estimate let through, but that is really over the window, is now refused', () => {
  // A selected snippet: the one part the context never cuts (files are cut to fit since the total budget).
  const req = request({ snippets: [{ path: 'Notes/長筆記.md', text: zhText(185_000, 5) }] });
  const prompt = mapChatStep.render(req);
  assert.ok(estimateTokens(prompt) < MAP_CHAT_TOKEN_BUDGET, 'the old estimate passed it');
  const cjk = (prompt.match(/[㐀-鿿]/g) || []).length;
  assert.ok(cjk * MEASURED_ZH > MAP_CHAT_MODEL_WINDOW, 'at the measured rate it does not fit the model at all');
  assert.equal(refusal(req), 'over_budget');
});

test('a Chinese context that fits is still sent, and so is an English one of the same length', () => {
  assert.equal(refusal(request({ files: [{ path: 'Notes/筆記.md', content: zhText(100_000, 6) }] })), null);
  assert.equal(refusal({ ...request({ files: [{ path: 'Notes/a.md', content: 'plain english words '.repeat(25_000) }] }, 'Summarise this note'), language: 'en' }), null);
});

test('requests of ordinary size are unchanged: sent, and far below the budget', () => {
  const small = request({ outline: [{ id: 'r', title: '咖啡', summary: '咖啡的摘要', parentId: null, depth: 0 }], history: [{ role: 'user', text: '你好' }, { role: 'assistant', text: '你好，有什麼要整理的？' }] });
  assert.equal(refusal(small), null);
  assert.ok(estimateMapChatTokens(mapChatStep.render(small)) < MAP_CHAT_TOKEN_BUDGET / 5);
});
