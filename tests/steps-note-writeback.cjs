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

// ---------------------------------------------------------------------------------------------------------------------
// P2: the pure write-back module (composeWriteback, chartPreserves, backupNote). Unit level; no wiring yet.

const W = loadSource(`
export { composeWriteback, chartPreserves, verifyInserts, backupNote, formatDate } from "./ai/note-writeback";
export { standardTemplate } from "./ai/detail-templates";
`);

const NOW = new Date(2026, 10, 3, 9, 8, 7);
const TODAY = '2026-11-03';
const standard = W.standardTemplate('zh-TW');
const names = Object.fromEntries(standard.sections.map(section => [section.id, section.name]));
const noLogTemplate = { id: 'no-log', name: 'No log', sections: standard.sections.filter(section => section.role !== 'log') };
const hypothesis = {
  id: 'hypo',
  name: 'Hypothesis',
  sections: [
    { id: 'h1', name: '假設陳述', description: '', role: 'none', aliases: [] },
    { id: 'h2', name: '支持證據', description: '', role: 'none', aliases: [] },
    { id: 'h3', name: '反對證據', description: '', role: 'none', aliases: [] }
  ]
};
// Values from the bundled module come from another realm; compare them as plain data.
const plain = value => JSON.parse(JSON.stringify(value));
const FENCE = '```';
// The old note: a lead-in, a table, a mermaid block with a fake heading inside, footnotes, source footnotes, no trailing newline.
const OLD = [
  '導讀：這是一段教科書導讀。',
  '',
  '| 欄 | 值 |',
  '|---|---|',
  '| a | 1 |',
  '',
  `### ${names.core}`,
  '',
  '舊結論 CANARY-舊判斷-4821[^1]',
  '',
  `${FENCE}mermaid`,
  'graph TD',
  '### 假標題',
  'A-->B',
  FENCE,
  '',
  `### ${names.knowledge}`,
  '',
  '舊知識 K1[^2]',
  '',
  `### ${names.sources}`,
  '',
  '- [[舊來源]]',
  '',
  '[^1]: 舊註腳一',
  '[^2]: 舊註腳二',
  '[^src-1]: [[舊來源]]',
  '',
  `### ${names.tradeoffs}`,
  '',
  '舊取捨',
  '',
  `### ${names.questions}`,
  '',
  '舊問題',
  '',
  `### ${names.log}`,
  '',
  '2026-01-01　舊紀錄一',
  '2026-02-01　舊紀錄二'
].join('\n');
const compose = (extra = {}) =>
  W.composeWriteback({ mode: 'top', oldDetail: OLD, aiDetail: '', summary: '本次摘要 S', template: standard, language: 'zh-TW', now: NOW, ...extra });
const section = (name, body) => `### ${name}\n\n${body}`;
const cutInserts = (result) => {
  let position = 0;
  const pieces = [];
  for (const insert of result.record.inserts) {
    assert.equal(result.detail.slice(insert.offset, insert.offset + insert.text.length), insert.text);
    assert.ok(insert.offset >= position, 'offsets increase without overlap');
    pieces.push(result.detail.slice(position, insert.offset));
    position = insert.offset + insert.text.length;
  }
  pieces.push(result.detail.slice(position));
  return pieces.join('');
};
const keepsOldLines = (oldText, detail) => {
  const lines = detail.split('\n');
  let at = 0;
  for (const line of oldText.split('\n')) {
    const found = lines.indexOf(line, at);
    assert.ok(found >= 0, `old line kept in order: ${JSON.stringify(line)}`);
    at = found + 1;
  }
};
const logBody = (detail, name = names.log) => {
  const lines = detail.split('\n');
  const start = lines.indexOf(`### ${name}`);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => line.startsWith('### '));
  return (end < 0 ? rest : rest.slice(0, end)).filter(line => line.trim());
};

test('top, names all match: new content goes under each old heading with a date heading; cutting the inserts gives the old Detail back', () => {
  const ai = [section(names.core, '新結論 N1'), section(names.knowledge, '新知識 N2'), section(names.log, '2026-11-03　AI 的紀錄不該寫入')].join('\n\n');
  const result = compose({ aiDetail: ai });
  assert.equal(result.ok, true);
  assert.equal(cutInserts(result), OLD);
  assert.ok(W.verifyInserts(OLD, result.detail, result.record.inserts));
  keepsOldLines(OLD, result.detail);
  assert.ok(result.detail.includes(`### ${names.core}\n\n#### ${TODAY}\n\n新結論 N1\n\n`));
  assert.ok(result.detail.includes(`### ${names.knowledge}\n\n#### ${TODAY}\n\n新知識 N2\n\n`));
  assert.equal(count(result.detail, `#### ${TODAY}`), 2);
  assert.ok(result.detail.startsWith('導讀：這是一段教科書導讀。\n\n| 欄 | 值 |'));
  assert.ok(result.detail.includes('CANARY-舊判斷-4821[^1]\n\n```mermaid\ngraph TD\n### 假標題\nA-->B\n```'));
  assert.equal(count(result.detail, 'CANARY-舊判斷-4821'), 1);
});

test('top, no old heading matches (hypothesis structure on a standard note): new sections go before the first old heading, after the lead-in, in structure order', () => {
  const ai = [section('反對證據', '反 B'), section('假設陳述', '假設 A'), section('支持證據', '支持 C')].join('\n\n');
  const result = compose({ aiDetail: ai, template: hypothesis });
  assert.equal(result.ok, true);
  assert.equal(cutInserts(result), OLD);
  keepsOldLines(OLD, result.detail);
  const first = result.detail.indexOf(`### ${names.core}`);
  const inserted = result.detail.slice(0, first);
  assert.ok(inserted.startsWith('導讀：這是一段教科書導讀。\n\n| 欄 | 值 |'));
  const order = ['### 假設陳述', '### 支持證據', '### 反對證據'].map(heading => inserted.indexOf(heading));
  assert.ok(order[0] > 0 && order[0] < order[1] && order[1] < order[2], `structure order ${order}`);
  assert.equal(count(inserted, `#### ${TODAY}`), 3);
  assert.ok(inserted.includes(`### 假設陳述\n\n#### ${TODAY}\n\n假設 A`));
  // The old update log is not a template section here, but it is still the update log: the plugin line joins it.
  const log = logBody(result.detail);
  assert.equal(log.length, 3);
  assert.equal(count(result.detail, `### ${names.log}`), 1);
});

test('top, partly matching: the matching section gets a dated insert and the section the old note lacks becomes a new one before the first heading', () => {
  const old = OLD.replace(`### ${names.tradeoffs}\n\n舊取捨\n\n`, '');
  const ai = [section(names.tradeoffs, '新取捨 T'), section(names.questions, '新問題 Q')].join('\n\n');
  const result = compose({ oldDetail: old, aiDetail: ai });
  assert.equal(result.ok, true);
  assert.equal(cutInserts(result), old);
  keepsOldLines(old, result.detail);
  const first = result.detail.indexOf(`### ${names.core}`);
  assert.ok(result.detail.slice(0, first).includes(`### ${names.tradeoffs}\n\n#### ${TODAY}\n\n新取捨 T`));
  assert.ok(result.detail.includes(`### ${names.questions}\n\n#### ${TODAY}\n\n新問題 Q\n\n舊問題`));
});

test('top, the old note has no heading at all: the new sections and the log section are appended at the end', () => {
  const old = '只有一段文字，沒有任何標題。\n\n[^1]: 註腳';
  const result = compose({ oldDetail: old, aiDetail: section(names.core, '新結論') });
  assert.equal(result.ok, true);
  assert.equal(cutInserts(result), old);
  assert.ok(result.detail.startsWith(`${old}\n\n### ${names.core}\n\n#### ${TODAY}\n\n新結論\n\n### ${names.log}\n\n${TODAY}　本次摘要 S`));
  const empty = compose({ oldDetail: '', aiDetail: section(names.core, '新結論') });
  assert.equal(empty.ok, true);
  assert.ok(empty.detail.startsWith(`### ${names.core}`));
  assert.equal(cutInserts(empty), '');
});

test('top, the old note ends right after a heading with no trailing newline: the insert supplies the newlines', () => {
  const old = `### ${names.core}`;
  const result = compose({ oldDetail: old, aiDetail: section(names.core, '新結論') });
  assert.equal(result.ok, true);
  assert.equal(cutInserts(result), old);
  assert.ok(result.detail.startsWith(`### ${names.core}\n\n#### ${TODAY}\n\n新結論`));
  assert.ok(result.detail.endsWith(`${TODAY}　本次摘要 S`));
});

test('top invariant blocks damage: a changed character in the old text gives top_invariant; bad insert records fail verifyInserts', () => {
  const ai = section(names.core, '新結論 N1');
  const damaged = compose({ aiDetail: ai, afterAssemble: detail => detail.replace('舊知識 K1', '舊知識 K2') });
  assert.deepEqual(plain(damaged), { ok: false, reason: 'top_invariant' });
  const result = compose({ aiDetail: ai });
  const [first, ...rest] = result.record.inserts;
  assert.ok(W.verifyInserts(OLD, result.detail, result.record.inserts));
  assert.equal(W.verifyInserts(OLD, result.detail, [{ ...first, offset: first.offset + 3 }, ...rest]), false);
  assert.equal(W.verifyInserts(OLD, result.detail, [{ ...first, text: `${first.text}x` }, ...rest]), false);
  assert.equal(W.verifyInserts(OLD, result.detail, [first, first]), false, 'overlapping inserts');
  assert.equal(W.verifyInserts(OLD, result.detail, rest), false, 'a missing insert leaves extra text');
  assert.equal(W.verifyInserts(`${OLD}x`, result.detail, result.record.inserts), false);
});

test('top footnotes: a label the new part defines is renumbered after the old maximum with its references; old references and definitions stay; a repeated source definition is dropped', () => {
  const ai = [
    section(names.core, '新結論引用自己[^1]，也引用舊的[^2]，來源[^src-1]。'),
    section(names.knowledge, '另一個新知識[^2]'),
    section(names.sources, '- [[新來源]]\n\n[^1]: 新註腳（自己的）\n[^2]: 新註腳二\n[^src-1]: [[舊來源]]\n[^src-2]: [[新來源]]')
  ].join('\n\n');
  const result = compose({ aiDetail: ai });
  assert.equal(result.ok, true);
  assert.equal(cutInserts(result), OLD);
  const added = result.record.inserts.map(insert => insert.text).join('\n');
  assert.ok(added.includes('新結論引用自己[^3]，也引用舊的[^4]'), 'a reply that defines [^2] itself owns that label');
  assert.ok(result.detail.includes('[^3]: 新註腳（自己的）'));
  assert.ok(result.detail.includes('[^4]: 新註腳二'));
  assert.ok(result.detail.includes('[^src-2]: [[新來源]]'));
  assert.equal(count(result.detail, '[^src-1]: [[舊來源]]'), 1, 'the duplicate source definition is dropped');
  assert.ok(result.detail.indexOf('[^src-1]: [[舊來源]]') < result.detail.indexOf('[^3]: 新註腳'), 'new definitions follow the old ones');
  assert.ok(result.detail.includes('[^1]: 舊註腳一\n[^2]: 舊註腳二\n[^src-1]: [[舊來源]]\n[^3]:'));
  // A reply that only references an old label keeps it.
  const refOnly = compose({ aiDetail: section(names.core, '只引用舊的[^2]') });
  assert.ok(refOnly.detail.includes('只引用舊的[^2]'));
});

test('top sources: new items follow the last old item without a date heading, before the footnote definitions; repeated items are skipped', () => {
  const result = compose({ aiDetail: section(names.sources, '- [[舊來源]]\n- [[新來源]]') });
  assert.equal(result.ok, true);
  assert.equal(cutInserts(result), OLD);
  assert.ok(result.detail.includes('- [[舊來源]]\n- [[新來源]]\n\n[^1]: 舊註腳一'));
  assert.equal(count(result.detail, `#### ${TODAY}`), 0);
  assert.equal(count(result.detail, '- [[舊來源]]'), 1);
});

test('top: an AI update log is discarded and the log section gains exactly one plugin line at the bottom', () => {
  const result = compose({ aiDetail: [section(names.core, '新'), section(names.log, `${TODAY}　AI 的一行\n${TODAY}　AI 的第二行`)].join('\n\n') });
  assert.equal(result.ok, true);
  assert.ok(!result.detail.includes('AI 的一行'));
  const log = logBody(result.detail);
  assert.deepEqual(log, ['2026-01-01　舊紀錄一', '2026-02-01　舊紀錄二', `${TODAY}　本次摘要 S`]);
  assert.ok(result.detail.endsWith(`${TODAY}　本次摘要 S`));
});

test('top: placeholder or empty sections, text before the first heading and sub-headings are handled; nothing new still writes the log line', () => {
  const result = compose({ aiDetail: `前言不寫入\n\n${section(names.core, 'No new content this time')}\n\n${section(names.knowledge, '')}` });
  assert.equal(result.ok, true);
  assert.equal(cutInserts(result), OLD);
  assert.equal(result.record.inserts.length, 1);
  assert.ok(!result.detail.includes('前言不寫入'));
  const deep = compose({ aiDetail: section(names.core, `#### 子標題\n\n內容\n\n${FENCE}\n# 程式碼裡的標題\n${FENCE}`) });
  assert.ok(deep.detail.includes('##### 子標題'));
  assert.ok(deep.detail.includes('\n# 程式碼裡的標題\n'), 'fenced lines are text');
  assert.equal(cutInserts(deep), OLD);
});

test('top: a reply section the template does not know is kept as its own section; the insert offsets never overlap', () => {
  const result = compose({ aiDetail: `${section('補充', '其他發現')}\n\n${section(names.core, '新結論')}` });
  assert.equal(result.ok, true);
  assert.equal(cutInserts(result), OLD);
  assert.ok(result.detail.includes(`### 補充\n\n#### ${TODAY}\n\n其他發現`));
  const offsets = result.record.inserts.map(insert => insert.offset);
  assert.deepEqual([...offsets].sort((a, b) => a - b), plain(offsets));
  assert.equal(result.record.kept.length, result.record.inserts.length + 1);
  assert.equal(result.record.kept.join(''), OLD);
});

test('chartPreserves: charts added to the new content pass; a changed old character or a changed lead-in fails', () => {
  const result = compose({ aiDetail: section(names.core, '新結論 N1') });
  const withChart = result.detail.replace('新結論 N1', `新結論 N1\n\n${FENCE}mermaid\ngraph LR\nA-->B\n${FENCE}`);
  assert.ok(W.chartPreserves(result.record, result.detail));
  assert.ok(W.chartPreserves(result.record, withChart));
  assert.equal(W.chartPreserves(result.record, withChart.replace('舊知識 K1', '舊知識 K9')), false);
  assert.equal(W.chartPreserves(result.record, withChart.replace('導讀：這是', '導讀：那是')), false);
  assert.equal(W.chartPreserves(result.record, `前面多了一行\n${withChart}`), false);
  assert.equal(W.chartPreserves(result.record, withChart.replace('舊取捨\n\n', '')), false);
});

test('merge log line: 1 new line stays, 0 gets a summary line (60 code points), 3 become one joined by ；, all at the bottom', () => {
  const oldDetail = `${section(names.core, '舊')}\n\n${section(names.log, '2026-01-01　舊紀錄一')}`;
  const merged = (log, summary = '摘要') =>
    W.composeWriteback({ mode: 'merge', oldDetail, aiDetail: `${section(names.core, '新')}\n\n${section(names.log, log)}`, summary, template: standard, language: 'zh-TW', now: NOW });
  const one = merged('2026-01-01　舊紀錄一\n2026-11-02　與先前結論不一致：1.8 對 2.1');
  assert.deepEqual(plain(logBody(one.detail)), ['2026-01-01　舊紀錄一', '2026-11-02　與先前結論不一致：1.8 對 2.1']);
  const zero = merged('2026-01-01　舊紀錄一', '長'.repeat(80));
  assert.deepEqual(plain(logBody(zero.detail)), ['2026-01-01　舊紀錄一', `${TODAY}　${'長'.repeat(60)}`]);
  const three = merged('2026-01-01　舊紀錄一\n- 2026-11-01　甲\n2026-11-02　乙\n2026-11-03　丙');
  assert.deepEqual(plain(logBody(three.detail)), ['2026-01-01　舊紀錄一', '- 2026-11-01　甲；乙；丙']);
  const placeholder = merged('本次無新增內容。');
  assert.deepEqual(plain(logBody(placeholder.detail)), [`${TODAY}　摘要`], 'a placeholder is no line');
  for (const result of [one, zero, three]) assert.equal(result.ok, true);
});

test('fresh: the old log lines stay in front, the AI log lines go, one line names the backup; log line count is old plus one', () => {
  const fresh = W.composeWriteback({
    mode: 'fresh', oldDetail: OLD,
    aiDetail: `${section(names.core, '全新結論')}\n\n${section(names.log, `${TODAY}　AI 自己寫的\n本次無新增內容。`)}`,
    summary: 's', template: standard, language: 'zh-TW', now: NOW, backupPath: '筆記風格/備份/筆記/T 2026-11-03 090807.md'
  });
  assert.equal(fresh.ok, true);
  assert.deepEqual(plain(logBody(fresh.detail)), ['2026-01-01　舊紀錄一', '2026-02-01　舊紀錄二', `${TODAY}　已用新研究取代，舊版備份在 筆記風格/備份/筆記/T 2026-11-03 090807.md`]);
  assert.ok(!fresh.detail.includes('CANARY-舊判斷-4821'));
  assert.ok(!fresh.detail.includes('AI 自己寫的'));
  assert.deepEqual(plain(fresh.record.inserts), []);
  const en = W.composeWriteback({ mode: 'fresh', oldDetail: '### Update log\n\n2026-01-01　old', aiDetail: '### Core conclusions\n\nNew', summary: 's', template: W.standardTemplate('en'), language: 'en', now: NOW, backupPath: 'B/x.md' });
  assert.deepEqual(plain(logBody(en.detail, 'Update log')), ['2026-01-01　old', `${TODAY}　Replaced with new research; the earlier version is backed up at B/x.md`]);
});

test('a structure with no log section gets an Update log section at the end in merge, top and fresh', () => {
  const heading = `### ${names.log}`;
  const oldDetail = section(names.core, '舊');
  const base = { oldDetail, summary: '摘要 X', template: noLogTemplate, language: 'zh-TW', now: NOW, backupPath: 'B/x.md' };
  const merge = W.composeWriteback({ ...base, mode: 'merge', aiDetail: section(names.core, '新') });
  assert.ok(merge.detail.endsWith(`${section(names.core, '新')}\n\n${heading}\n\n${TODAY}　摘要 X`));
  const top = W.composeWriteback({ ...base, mode: 'top', aiDetail: section(names.core, '新') });
  assert.equal(top.ok, true);
  assert.equal(cutInserts(top), oldDetail);
  assert.ok(top.detail.endsWith(`${heading}\n\n${TODAY}　摘要 X`));
  const fresh = W.composeWriteback({ ...base, mode: 'fresh', aiDetail: section(names.core, '新') });
  assert.ok(fresh.detail.endsWith(`${heading}\n\n${TODAY}　已用新研究取代，舊版備份在 B/x.md`));
  // The old note already has the log section: top and fresh add one line there, not a second section.
  const withLog = W.composeWriteback({ ...base, mode: 'top', oldDetail: `${oldDetail}\n\n${heading}\n\n2026-01-01　舊`, aiDetail: section(names.core, '新') });
  assert.equal(count(withLog.detail, heading), 1);
  assert.deepEqual(plain(logBody(withLog.detail)), ['2026-01-01　舊', `${TODAY}　摘要 X`]);
});

test('every mode adds exactly one log line to the old count, placeholder lines not counted', () => {
  const old = `${section(names.core, '舊')}\n\n${section(names.log, '本次無新增內容。')}`;
  const base = { oldDetail: old, summary: '摘要', template: standard, language: 'zh-TW', now: NOW, backupPath: 'B' };
  const ai = `${section(names.core, '新')}\n\n${section(names.log, '本次無新增內容。')}`;
  const merge = W.composeWriteback({ ...base, mode: 'merge', aiDetail: ai });
  assert.deepEqual(plain(logBody(merge.detail)), [`${TODAY}　摘要`]);
  const fresh = W.composeWriteback({ ...base, mode: 'fresh', aiDetail: ai });
  assert.equal(logBody(fresh.detail).length, 1);
  const top = W.composeWriteback({ ...base, mode: 'top', aiDetail: section(names.core, '新') });
  assert.equal(logBody(top.detail).filter(line => !line.includes('本次無新增')).length, 1);
});

const makePort = (overrides = {}) => {
  const files = new Map();
  const folders = new Set(overrides.folders ?? []);
  const calls = [];
  return {
    files, folders, calls,
    folderExists: async path => folders.has(path),
    list: async folder => [...files.keys()].filter(path => path.startsWith(`${folder}/`)),
    createFolder: async path => { calls.push(['createFolder', path]); if (overrides.createFolder) throw new Error('no folder'); folders.add(path); },
    create: async (path, content) => { calls.push(['create', path]); if (overrides.create) throw new Error('no create'); files.set(path, content); },
    read: async path => (overrides.read ? overrides.read : files.get(path))
  };
};
const noteFile = '---\ntitle: T\n---\n\n## Detail\n\n舊內容 CANARY\r\n結尾';

test('backupNote success: byte-identical copy at <folder>/<name> YYYY-MM-DD HHmmss.md, folders created only then, clash gives (1)', async () => {
  const port = makePort();
  const first = await W.backupNote(port, { notePath: '議題/我的議題.md', content: noteFile, folder: '筆記風格/備份/筆記', now: NOW });
  assert.deepEqual(plain(first), { ok: true, path: '筆記風格/備份/筆記/我的議題 2026-11-03 090807.md' });
  assert.equal(port.files.get(first.path), noteFile);
  assert.deepEqual(plain(port.calls.filter(call => call[0] === 'createFolder').map(call => call[1])), ['筆記風格', '筆記風格/備份', '筆記風格/備份/筆記']);
  const second = await W.backupNote(port, { notePath: '議題/我的議題.md', content: noteFile, folder: '筆記風格/備份/筆記', now: NOW });
  assert.equal(second.path, '筆記風格/備份/筆記/我的議題 2026-11-03 090807 (1).md');
  const third = await W.backupNote(port, { notePath: '我的議題.md', content: noteFile, folder: '筆記風格/備份/筆記/', now: NOW });
  assert.equal(third.path, '筆記風格/備份/筆記/我的議題 2026-11-03 090807 (2).md');
  assert.equal(port.calls.filter(call => call[0] === 'createFolder').length, 3, 'existing folders are not created again');
  assert.equal(port.files.size, 3);
});

test('backupNote failures never throw and never claim success: create throws, read-back differs, createFolder throws', async () => {
  const input = { notePath: 'T.md', content: noteFile, folder: 'B/N', now: NOW };
  assert.deepEqual(plain(await W.backupNote(makePort({ create: true }), input)), { ok: false });
  assert.deepEqual(plain(await W.backupNote(makePort({ read: `${noteFile} ` }), input)), { ok: false });
  const noFolder = makePort({ createFolder: true });
  assert.deepEqual(plain(await W.backupNote(noFolder, input)), { ok: false });
  assert.equal(noFolder.files.size, 0, 'nothing is written when the folder cannot be made');
  const broken = { ...makePort(), list: async () => { throw new Error('list'); }, folderExists: async () => true };
  assert.deepEqual(plain(await W.backupNote(broken, input)), { ok: false });
});
