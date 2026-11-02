// Note style recipe T4: the write-back modes (merge / top / fresh). P1 is the prompt layer: the conflict rule in a merge, the top and
// fresh mode text, the old Detail label, and the context builder. Unit level. Later packets add the pure write-back module and the wiring.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./support-replay.cjs');

const M = loadSource(`
export { assembleTaskPrompt, selectionFromContext, promptStepOf } from "./core/steps/task/assemble";
export { CONFLICT_RULE, GENERAL_TASK, SYNTHESIZE, GENERAL_TASK_TOP, GENERAL_TASK_FRESH, SYNTHESIZE_TOP, SYNTHESIZE_FRESH, LABEL_DETAIL, LABEL_DETAIL_TOP } from "./core/steps/task/fragments";
export { inLanguage } from "./core/steps/_shared/fragments";
export { buildPreparedTaskContext } from "./ai/context-builder";
`);

const LANGUAGES = ['zh-TW', 'zh-CN', 'en'];
const CANARY = 'CANARY-OLD-DETAIL-4821';
const base = { title: 'Topic T', summary: 'Current summary S', rules: 'Rule R', detail: `${CANARY} line`, task: 'Do task X', ancestors: 'Ancestor A', workingFindings: '', sourceContext: 'Source [S1]: fact', mode: 'task', researchMode: 'local', researchDepth: 'normal', visualMode: 'off' };
const promptOf = (language, extra = {}) => {
  const context = { ...base, outputLanguage: language, ...extra };
  return M.assembleTaskPrompt(M.selectionFromContext(context, language), M.promptStepOf(context), context, language);
};
const text = (fragment, language) => M.inLanguage(fragment, language).trim();
const count = (haystack, needle) => haystack.split(needle).length - 1;

test('merge research and synthesize prompts carry the conflict rule exactly once, right after the mode text', () => {
  for (const language of LANGUAGES) {
    const rule = text(M.CONFLICT_RULE, language);
    for (const [extra, mode] of [[{}, M.GENERAL_TASK], [{ mode: 'synthesize' }, M.SYNTHESIZE], [{ updateMode: 'merge' }, M.GENERAL_TASK]]) {
      const prompt = promptOf(language, extra).text;
      assert.equal(count(prompt, rule), 1, `${language} ${JSON.stringify(extra)}`);
      assert.ok(prompt.includes(`${text(mode, language)}\n\n${rule}\n\n`), 'the rule follows the mode text');
    }
  }
});

test('the conflict rule names the five elements in zh and en: keep both, date and source, current judgment, open questions, one log line', () => {
  const zh = text(M.CONFLICT_RULE, 'zh-TW');
  for (const word of ['兩種說法都保留', '日期與來源', '目前判斷', '待確認事項', '並列', '更新紀錄寫一行', '與先前結論不一致']) assert.ok(zh.includes(word), word);
  const en = text(M.CONFLICT_RULE, 'en');
  for (const word of ['keep both', 'date and source', 'current judgment', 'open questions', 'side by side', 'one line in the update log', 'Disagrees with an earlier conclusion']) assert.ok(en.includes(word), word);
});

test('the other steps have no conflict rule and no update-mode text: decompose, merge, default', () => {
  for (const language of LANGUAGES) {
    const rule = text(M.CONFLICT_RULE, language);
    for (const mode of ['decompose', 'merge']) {
      const prompt = promptOf(language, { mode, updateMode: 'top' }).text;
      assert.ok(!prompt.includes(rule), `${language} ${mode}`);
      assert.ok(!prompt.includes(text(M.GENERAL_TASK_TOP, language)));
    }
    const merge = promptOf(language, { mode: 'merge' }).text;
    assert.equal(merge, promptOf(language, { mode: 'merge', updateMode: 'fresh' }).text, 'merge mode ignores updateMode');
  }
});

test('top uses its own mode text, no conflict rule, and the read-only old Detail label with the old Detail', () => {
  for (const language of LANGUAGES) {
    for (const [extra, top, plain] of [[{}, M.GENERAL_TASK_TOP, M.GENERAL_TASK], [{ mode: 'synthesize' }, M.SYNTHESIZE_TOP, M.SYNTHESIZE]]) {
      const prompt = promptOf(language, { ...extra, updateMode: 'top' }).text;
      assert.ok(prompt.includes(text(top, language)));
      assert.ok(!prompt.includes(text(plain, language)));
      assert.ok(!prompt.includes(text(M.CONFLICT_RULE, language)));
      assert.ok(prompt.includes(`${text(M.LABEL_DETAIL_TOP, language)}:\n${CANARY} line`));
      assert.ok(!prompt.includes(text(M.LABEL_DETAIL, language)), 'the replace-fully label is gone');
    }
  }
});

test('top texts: only the new findings by ### heading, nothing rewritten, no update log section; zh and en', () => {
  assert.ok(text(M.GENERAL_TASK_TOP, 'zh-TW').includes('只回傳本次新發現，依段落標題（###）分段，沒有新發現的段落省略；不要重寫或重複現有筆記'));
  assert.ok(text(M.GENERAL_TASK_TOP, 'zh-TW').includes('不要寫更新紀錄段'));
  assert.ok(text(M.LABEL_DETAIL_TOP, 'zh-TW').includes('以下是現有筆記，只供參考；只回傳本次新發現，依段落標題分段，沒有新發現的段落省略'));
  assert.ok(text(M.GENERAL_TASK_TOP, 'en').includes('only what this research newly found'));
  assert.ok(text(M.SYNTHESIZE_TOP, 'en').includes('do not write an update log section'));
});

test('fresh sends no old Detail and no Detail label, in every language and for research and synthesize', () => {
  for (const language of LANGUAGES) {
    for (const extra of [{}, { mode: 'synthesize' }]) {
      const prompt = promptOf(language, { ...extra, updateMode: 'fresh' }).text;
      assert.ok(!prompt.includes(text(M.LABEL_DETAIL, language)));
      assert.ok(!prompt.includes(text(M.LABEL_DETAIL_TOP, language)));
      assert.ok(!prompt.includes(CANARY), 'the assembler leaves the old Detail out');
      assert.ok(prompt.includes(text(extra.mode ? M.SYNTHESIZE_FRESH : M.GENERAL_TASK_FRESH, language)));
      assert.ok(!prompt.includes(text(M.CONFLICT_RULE, language)));
      assert.ok(!/replace|取代舊 Detail|吸收舊內容/.test(text(extra.mode ? M.SYNTHESIZE_FRESH : M.GENERAL_TASK_FRESH, language)), 'no mention of the old Detail');
    }
  }
});

test('fresh mode text does not mention an old Detail; top and fresh carry no replace-the-old-Detail sentence', () => {
  for (const language of LANGUAGES) for (const fragment of [M.GENERAL_TASK_TOP, M.GENERAL_TASK_FRESH, M.SYNTHESIZE_TOP, M.SYNTHESIZE_FRESH]) {
    const body = text(fragment, language);
    assert.ok(!body.includes('取代舊 Detail') && !body.includes('replaces the old Detail') && !body.includes('吸收舊內容'), body);
  }
});

test('context builder: fresh empties the old Detail and reports 0 tokens; top and merge keep it', () => {
  const sent = updateMode => M.buildPreparedTaskContext({ ...base, updateMode }, 'model');
  const fresh = sent('fresh');
  assert.equal(fresh.context.detail, '');
  assert.equal(fresh.metrics.contextBreakdown.currentDetail, 0);
  for (const mode of ['top', 'merge', undefined]) {
    const kept = sent(mode);
    assert.equal(kept.context.detail, base.detail);
    assert.ok(kept.metrics.contextBreakdown.currentDetail > 0);
  }
});

test('merge prompt with no updateMode equals updateMode merge', () => {
  for (const language of LANGUAGES) assert.equal(promptOf(language).text, promptOf(language, { updateMode: 'merge' }).text);
});
