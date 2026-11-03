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

// ---------------------------------------------------------------------------------------------------------------------
// P3: the wiring. A real view over a fake vault and the plugin's run module; only the model answer, the chart queue and
// (where a test says so) the composer are replaced. The old note, the written note and the vault files are read back.

const S = require('./support.cjs');
const L = loadSource('export { translate } from "./i18n";');
const TRANSLATED = key => ['zh-TW', 'zh-CN', 'en'].map(language => L.translate(language, key));
const MSG = {
  stale: TRANSLATED('ui.the_topic_changed_so_the_outdated_ai_result_was_not_saved'),
  topFailed: TRANSLATED('ui.writeback_top_failed'),
  backupFailed: TRANSLATED('ui.writeback_backup_failed'),
  stopped: TRANSLATED('ui.research_stopped_existing_content_was_preserved')
};
const MAP_PATH = 'Agent Workspace/Topics/map-a/Map.md';
const BACKUP_FILE = /(?:備份|Backups|备份)\/(?:筆記|Notes|笔记)\/主題 \d{4}-\d{2}-\d{2} \d{6}(?: \(\d+\))?\.md$/;
const backupKeys = files => [...files.keys()].filter(key => BACKUP_FILE.test(key));
const anyBackupFolder = files => [...files.keys()].some(key => /(?:備份|Backups|备份)/.test(key));

async function wiring({ kind = 'hypothesis', detail = OLD, reply, language = 'zh-TW' } = {}) {
  const { repo, app, contents, files } = S.fixture(language);
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a');
  await app.vault.create(MAP_PATH, S.core.serializeMap(mapDoc));
  const node = await repo.createNote('主題', 'model-a', mapDoc, MAP_PATH, 'workspace', { topicKind: kind });
  mapDoc.nodes.push(node);
  await repo.saveMap(MAP_PATH, mapDoc);
  await repo.updateNote(node.path, { detail, summary: '舊摘要', status: 'completed' });
  const calls = { asks: [], jobs: [], exchanges: [], failed: [], composed: 0 };
  const host = S.withExpansionCoordinator({
    repo, settings: { ...S.DEFAULT_SETTINGS, language, cliModel: 'gpt-6-luna', cliReasoning: 'low', aiExchangeLoggingEnabled: true },
    running: new Set(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, views: () => [],
    recordFailure: (_label, error) => String(error?.message ?? error), mutate: async work => work(),
    exchanges: { failed: (id, why) => calls.exchanges.push(['failed', id, why]), completed: id => calls.exchanges.push(['completed', id]), getEntries: () => [] },
    researchProgress: { get: () => undefined, begin() {}, newAttempt() {}, stage() {}, preview() {}, markSlow() {}, end() {} },
    askModel: async (context, _model, _reasoning, _signal, onExchange, accepted) => {
      calls.asks.push(context); onExchange?.('ex1'); accepted?.();
      return typeof reply === 'function' ? reply(context, host) : reply;
    },
    addChartsAfterWrite: job => calls.jobs.push(job)
  });
  repo.settings = host.settings;
  const { VisualAgentMapView } = S.load('main.ts', { obsidian: { ...S.obsidian, Notice: class {} } });
  const view = new VisualAgentMapView({ app }, S.attachTopicRuns(host));
  Object.assign(view, { path: MAP_PATH, map: mapDoc, contentEl: { querySelector: () => null }, render() {}, hydrate: async () => {}, ancestorContext: async () => '', updateHistoryButtons() {} });
  const before = await repo.readNote(node.path);
  const run = async (request = {}, over = {}) => {
    const handle = await view.runAgent(node, undefined, message => calls.failed.push(message), { task: 'go', researchMode: 'local', outputLanguage: language, ...request });
    await handle?.finished;
    return handle;
  };
  const wrap = fn => { const original = host.topicRuns.ports.composeWriteback; host.topicRuns.ports.composeWriteback = fn; return original; };
  return { repo, app, contents, files, node, view, host, calls, before, run, saved: () => repo.readNote(node.path), raw: () => contents.get(node.path), wrap };
}
const reply = (detail, extra = {}) => ({ summary: '新摘要', detail, visualReferences: [], suggestions: [], ...extra });
const hypothesisReply = context => {
  const [first, second] = context.detailTemplate.sections;
  return reply(`### ${first.name}\n\n新假設 N1\n\n### ${second.name}\n\n新證據 N2`);
};
// A failed write-back restores the status, which moves the `updated` stamp; everything else must be byte for byte the same.
const stable = text => String(text).replace(/^updated: .*$/m, 'updated: <t>');
const fresh = async w => ({ ...(await w.view.detailTemplateFor(w.node)), updateMode: 'fresh' });

test('top through the real run: old text stays, new sections go on top with a dated heading, one log line is added, one AI call (counterexamples 11, 14, 15)', async () => {
  const w = await wiring({ reply: hypothesisReply });
  await w.run();
  const saved = await w.saved();
  assert.equal(w.calls.asks.length, 1, 'one AI call');
  assert.equal(w.calls.asks[0].updateMode, 'top', 'the topic type decides the way: hypothesis is top');
  keepsOldLines(w.before.detail, saved.detail);
  assert.ok(saved.detail.includes('新假設 N1') && saved.detail.includes('新證據 N2'));
  assert.ok(saved.detail.includes(`#### ${W.formatDate(new Date())}`), 'a dated heading above the new content');
  assert.ok(saved.detail.indexOf('新假設 N1') < saved.detail.indexOf('舊結論 CANARY-舊判斷-4821'), 'the new section comes before the first old heading');
  assert.ok(saved.detail.indexOf('導讀：這是一段教科書導讀。') < saved.detail.indexOf('新假設 N1'), 'the lead-in stays first');
  assert.equal(logBody(saved.detail).length, logBody(w.before.detail).length + 1, 'exactly one log line more');
  assert.equal(w.calls.jobs.length, 1, 'a chart job is queued with the write-back'); assert.equal(w.calls.jobs[0].detail, saved.detail);
  assert.deepEqual(w.calls.exchanges, [['completed', 'ex1']]);
  assert.equal(saved.summary, '新摘要');
});

test('top: repository round trip keeps every old line in order, also with visual references, and the chart guard accepts the saved text (counterexample 15)', async () => {
  const references = [{ title: '圖', imageUrl: 'https://example.com/a.png', sourceUrl: 'https://example.com', palette: ['#ffffff'], description: '示意圖', formula: '' }];
  const w = await wiring({ reply: context => ({ ...hypothesisReply(context), visualReferences: references }) });
  await w.run();
  const saved = await w.saved();
  keepsOldLines(w.before.detail, saved.detail);
  assert.ok(saved.detail.includes('新假設 N1'));
  const stored = w.raw();
  assert.ok(stored.includes('舊結論 CANARY-舊判斷-4821[^1]') && stored.includes('[^src-1]: [[舊來源]]'));
});

test('top: undo covers the write-back: onWritten gets the old Detail as before and the written one as after, and undo restores the old Detail byte for byte (counterexample 11)', async () => {
  const w = await wiring({ reply: hypothesisReply });
  await w.run();
  const saved = await w.saved();
  assert.equal(w.view.history.canUndo, true);
  await w.view.history.undo().undo();
  const restored = await w.saved();
  assert.equal(restored.detail, w.before.detail);
  assert.notEqual(saved.detail, w.before.detail);
});

test('merge through the real run: undo restores the old Detail and the log gains exactly one line when the AI wrote none (counterexamples 9, 11)', async () => {
  const w = await wiring({ kind: 'topic', reply: () => reply(OLD.replace('舊結論', '新結論')) });
  await w.run();
  const saved = await w.saved();
  assert.equal(w.calls.asks[0].updateMode, 'merge');
  assert.ok(saved.detail.includes('新結論'));
  assert.equal(logBody(saved.detail).length, logBody(w.before.detail).length + 1);
  await w.view.history.undo().undo();
  assert.equal((await w.saved()).detail, w.before.detail);
});

test('fresh through the real run: the whole note file is backed up byte for byte first, the old log lines stay, one line names the backup, undo restores (counterexamples 8, 11)', async () => {
  // The backup is the file as it was before the run (status and stamp included), not the file at write time (status running).
  const w = await wiring({ kind: 'topic', reply: () => { w.atAnswer = w.raw(); return reply(`### ${names.core}\n\n全新結論 F1\n\n### ${names.log}\n\n2099-01-01　AI 的紀錄`); } });
  const rawBefore = w.raw();
  await w.run({ runStyle: await fresh(w) });
  assert.match(w.atAnswer, /^status: running$/m, 'the file at answer time is marked running');
  assert.notEqual(w.atAnswer, rawBefore);
  assert.match(rawBefore, /^status: completed$/m);
  const saved = await w.saved();
  const backups = backupKeys(w.files);
  assert.equal(backups.length, 1, [...w.files.keys()].join('\n'));
  assert.equal(w.contents.get(backups[0]), rawBefore, 'the backup is the whole note file, byte for byte');
  assert.ok(saved.detail.includes('全新結論 F1') && !saved.detail.includes('CANARY-舊判斷-4821'), 'only the new content');
  const log = logBody(saved.detail);
  assert.deepEqual(log.slice(0, 2), ['2026-01-01　舊紀錄一', '2026-02-01　舊紀錄二'], 'old log lines first, unchanged');
  assert.equal(log.length, 3);
  assert.ok(log[2].includes(backups[0]) && !log.some(line => line.includes('AI 的紀錄')));
  await w.view.history.undo().undo();
  assert.equal((await w.saved()).detail, w.before.detail);
  assert.equal(w.calls.asks.length, 1);
});

test('fresh: a backup that cannot be made or checked writes nothing and says so (counterexample 7: create throws, read differs, createFolder throws, a changed file)', async () => {
  const faults = {
    'create throws': w => { const original = w.app.vault.create; w.app.vault.create = async (path, text) => { if (BACKUP_FILE.test(path)) throw new Error('disk full'); return original(path, text); }; },
    'read differs': w => { const original = w.app.vault.read; w.app.vault.read = async file => (BACKUP_FILE.test(file.path) ? 'something else' : original(file)); },
    'createFolder throws': w => { const original = w.app.vault.createFolder; w.app.vault.createFolder = async path => { if (/(?:備份|Backups|备份)/.test(path)) throw new Error('read only'); return original(path); }; },
    'file changed before the write': w => { const original = w.app.vault.read; w.app.vault.read = async file => { const text = await original(file); return file.path === w.node.path && backupKeys(w.files).length ? `${text}\nedited` : text; }; }
  };
  for (const [label, install] of Object.entries(faults)) {
    const w = await wiring({ kind: 'topic', reply: () => reply(`### ${names.core}\n\n全新結論 F1`) });
    const rawBefore = w.raw();
    install(w);
    await w.run({ runStyle: await fresh(w) });
    assert.equal(stable(w.raw()), stable(rawBefore), `${label}: the note is byte for byte what it was`);
    assert.ok(MSG.backupFailed.includes(w.calls.failed[0]), `${label}: ${w.calls.failed[0]}`);
    assert.deepEqual(w.calls.exchanges.map(entry => entry[0]), ['failed']);
    assert.equal(w.view.history.canUndo, false, `${label}: no undo entry`);
  }
});

test('fresh: missing backup or read hooks count as a failed backup and write nothing (counterexample 7)', async () => {
  const w = await wiring({ kind: 'topic', reply: () => reply(`### ${names.core}\n\n全新結論 F1`) });
  const rawBefore = w.raw();
  const runStyle = await fresh(w);
  for (const missing of [['backupNote'], ['readRaw'], ['backupNote', 'readRaw']]) {
    const original = Object.getPrototypeOf(w.view).writebackHooks;
    w.view.writebackHooks = function () { const hooks = original.call(this); for (const key of missing) delete hooks[key]; return hooks; };
    await w.run({ runStyle });
    assert.equal(stable(w.raw()), stable(rawBefore), missing.join('+'));
    assert.ok(MSG.backupFailed.includes(w.calls.failed.at(-1)), missing.join('+'));
    assert.equal(anyBackupFolder(w.files), false, 'nothing is created');
  }
});

test('top invariant failure writes nothing: the note is byte for byte what it was, the Notice and the exchange say why (counterexample 2)', async () => {
  const w = await wiring({ reply: hypothesisReply });
  const rawBefore = w.raw();
  w.wrap(() => ({ ok: false, reason: 'top_invariant' }));
  await w.run();
  assert.equal(stable(w.raw()), stable(rawBefore));
  assert.ok(MSG.topFailed.includes(w.calls.failed[0]));
  assert.deepEqual(w.calls.exchanges.map(entry => entry[0]), ['failed']);
  assert.ok(MSG.topFailed.includes(w.calls.exchanges[0][2]));
  assert.equal(w.view.history.canUndo, false);
  assert.equal(w.calls.jobs.length, 0);
});

test('the stale fence comes first: a topic changed while the AI worked is neither composed nor backed up (counterexample 10)', async () => {
  for (const mode of ['top', 'fresh']) {
    const w = await wiring({ kind: mode === 'top' ? 'hypothesis' : 'topic', reply: async (context, host) => { await host.repo.updateNote(w.node.path, { detail: `${w.before.detail}\n改過` }); return hypothesisReply(context); } });
    const original = w.wrap(() => { w.calls.composed++; return { ok: false, reason: 'top_invariant' }; });
    assert.equal(original, undefined);
    const edited = `${w.before.detail}\n改過`;
    await w.run(mode === 'fresh' ? { runStyle: await fresh(w) } : {});
    assert.equal(w.calls.composed, 0, `${mode}: composeWriteback is not called`);
    assert.equal(anyBackupFolder(w.files), false, `${mode}: no backup`);
    assert.equal((await w.saved()).detail, edited, `${mode}: the user's edit stands`);
    assert.ok(MSG.stale.includes(w.calls.failed[0]), `${mode}: ${w.calls.failed[0]}`);
  }
});

test('Stop before the write: nothing is composed and no backup is made (counterexample 10)', async () => {
  for (const mode of ['top', 'fresh']) {
    const w = await wiring({ kind: mode === 'top' ? 'hypothesis' : 'topic', reply: async context => { w.host.activeTasks.get(w.node.path).abort(); return hypothesisReply(context); } });
    w.wrap(() => { w.calls.composed++; return { ok: false, reason: 'top_invariant' }; });
    const rawBefore = w.raw();
    await w.run(mode === 'fresh' ? { runStyle: await fresh(w) } : {});
    assert.equal(w.calls.composed, 0, mode);
    assert.equal(anyBackupFolder(w.files), false, mode);
    assert.equal(stable(w.raw()), stable(rawBefore), mode);
  }
});

test('top chart guard: a diagram step that changes one old character is dropped, one that only adds a diagram to the new content is applied with the lead-in still first (counterexample 5)', async () => {
  const w = await wiring({ reply: hypothesisReply });
  await w.run();
  const written = await w.saved();
  assert.equal(w.calls.jobs.length, 1, 'a chart job was queued');
  const [job] = w.calls.jobs;
  const damaged = written.detail.replace('舊知識 K1', '舊知識 K2');
  assert.equal(await job.apply(damaged), false, 'an altered old character drops the diagrams');
  assert.equal((await w.saved()).detail, written.detail, 'the note equals the write-back result');
  const charted = written.detail.replace('新假設 N1', `新假設 N1\n\n${FENCE}mermaid\ngraph TD\nX-->Y\n${FENCE}`);
  assert.equal(await job.apply(charted), true);
  const after = await w.saved();
  assert.equal(after.detail, charted, 'the whole Detail is not normalized');
  assert.ok(after.detail.startsWith('導讀：這是一段教科書導讀。'), 'the lead-in is still first');
  keepsOldLines(w.before.detail, after.detail);
});

test('merge keeps the old chart path: the diagrammed Detail is still normalized as a whole', async () => {
  const w = await wiring({ kind: 'topic', reply: () => reply(OLD.replace('舊結論', '新結論')) });
  await w.run();
  const [job] = w.calls.jobs;
  const written = await w.saved();
  assert.equal(await job.apply(`${written.detail}\n`), true);
});

test('map chat starts no run of its own: its research goes through view.runAgent and the run module, so a hypothesis topic gets a top write-back (counterexample 14)', async () => {
  const fs = require('node:fs');
  const read = file => fs.readFileSync(require('node:path').join(S.root, file), 'utf8');
  const chat = read('experiences/visual-map/map-chat.ts');
  assert.doesNotMatch(chat, /topicRuns|updateNote|note-writeback/, 'map-chat.ts does not write a note or start a run');
  const view = read('experiences/visual-map/view.ts');
  assert.equal(view.match(/topicRuns\.start\([^)]*"research"/g)?.length, 1, 'one place starts a research run: runAgent');
  // The request a map-chat or dialog research gives runAgent carries a task and a language, never an update mode; the topic decides.
  const w = await wiring({ reply: hypothesisReply });
  await w.run({ task: '地圖對話的研究任務', referenceGroups: [], rules: '', addCharts: false });
  const saved = await w.saved();
  assert.equal(w.calls.asks[0].updateMode, 'top');
  assert.ok(saved.detail.indexOf('新假設 N1') < saved.detail.indexOf('舊結論'));
  keepsOldLines(w.before.detail, saved.detail);
});

test('integrate children: top keeps the old text, fresh backs up and does not carry old links, merge adds one log line (counterexamples 8, 9)', async () => {
  const integrate = async (w, runStyle) => {
    const extra = { referenceGroups: [{ id: 'g', name: 'G', location: 'x', documents: [{ path: 'S.md', content: '來源內容' }] }], outputLanguage: 'zh-TW', researchMode: 'local' };
    const original = w.view.detailTemplateFor;
    if (runStyle) w.view.detailTemplateFor = async (...args) => ({ ...(await original.apply(w.view, args)), updateMode: runStyle });
    await w.view.integrateChildren(w.node, extra, '', async (_result, write, summary, detail) => { await write(summary, detail); }, message => w.calls.failed.push(message));
    w.view.detailTemplateFor = original;
  };
  const top = await wiring({ reply: hypothesisReply });
  await integrate(top);
  assert.equal(top.calls.asks[0].updateMode, 'top');
  keepsOldLines(top.before.detail, (await top.saved()).detail);
  assert.ok((await top.saved()).detail.includes('新假設 N1'));
  assert.equal(top.calls.jobs.length, 1);
  assert.equal(await top.calls.jobs[0].apply((await top.saved()).detail.replace('舊知識 K1', '舊知識 K2')), false, 'the chart guard is on for an integration too');
  assert.equal(logBody((await top.saved()).detail).length, logBody(top.before.detail).length + 1);
  await top.view.history.undo().undo();
  assert.equal((await top.saved()).detail, top.before.detail, 'undo covers the integration write');

  const freshRun = await wiring({ kind: 'topic', reply: () => reply(`### ${names.core}\n\n全新整合 F2`) });
  const rawBefore = freshRun.raw();
  await integrate(freshRun, 'fresh');
  assert.equal(backupKeys(freshRun.files).length, 1);
  // The backup is the file from before the integration started: same status and same stamp, byte for byte.
  assert.equal(freshRun.contents.get(backupKeys(freshRun.files)[0]), rawBefore);
  const freshSaved = await freshRun.saved();
  assert.ok(freshSaved.detail.includes('全新整合 F2') && !freshSaved.detail.includes('舊來源'), 'old links are not carried');
  assert.equal(logBody(freshSaved.detail).length, logBody(freshRun.before.detail).length + 1);

  const merge = await wiring({ kind: 'topic', reply: () => reply(OLD.replace('舊結論', '新結論')) });
  await integrate(merge);
  const mergeSaved = await merge.saved();
  assert.ok(mergeSaved.detail.includes('新結論'));
  assert.equal(logBody(mergeSaved.detail).length, logBody(merge.before.detail).length + 1);
});

test('integrate children: a failed top invariant or a failed backup writes nothing and reports why (counterexamples 2, 7)', async () => {
  const run = async w => {
    await w.view.integrateChildren(w.node, { referenceGroups: [{ id: 'g', name: 'G', location: 'x', documents: [{ path: 'S.md', content: 'x' }] }], outputLanguage: 'zh-TW', researchMode: 'local' }, '', async (_r, write, summary, detail) => { await write(summary, detail); }, message => w.calls.failed.push(message));
  };
  const top = await wiring({ reply: hypothesisReply });
  const topRaw = top.raw();
  top.wrap(() => ({ ok: false, reason: 'top_invariant' }));
  await run(top);
  assert.equal(stable(top.raw()), stable(topRaw));
  assert.ok(top.calls.failed.some(message => MSG.topFailed.some(text => message.includes(text))), top.calls.failed.join('|'));

  const fr = await wiring({ kind: 'topic', reply: () => reply(`### ${names.core}\n\n全新`) });
  const frRaw = fr.raw();
  const original = fr.view.detailTemplateFor;
  fr.view.detailTemplateFor = async (...args) => ({ ...(await original.apply(fr.view, args)), updateMode: 'fresh' });
  fr.view.writebackHooks = () => ({});
  await run(fr);
  assert.equal(stable(fr.raw()), stable(frRaw));
  assert.ok(fr.calls.failed.some(message => MSG.backupFailed.some(text => message.includes(text))), fr.calls.failed.join('|'));
  assert.equal(anyBackupFolder(fr.files), false);
});

test('not touched by the write-back: merge-topics and AIM never import it, and the module is used by the run module and the view only (counterexample 12)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const walk = dir => fs.readdirSync(path.join(S.root, dir), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? (entry.name === 'node_modules' || entry.name === 'tests' ? [] : walk(path.join(dir, entry.name))) : /\.ts$/.test(entry.name) ? [path.join(dir, entry.name)] : []);
  const users = ['experiences', 'core', 'ai'].flatMap(walk).filter(file => /note-writeback/.test(fs.readFileSync(path.join(S.root, file), 'utf8')));
  assert.deepEqual(users.sort(), ['experiences/visual-map/topic-run.ts', 'experiences/visual-map/view.ts']);
  const run = fs.readFileSync(path.join(S.root, 'experiences/visual-map/topic-run.ts'), 'utf8');
  assert.equal(run.match(/composeWriteback\b/g).length >= 1, true);
  const selection = run.slice(run.indexOf('private async runSelection'), run.indexOf('private chartGuard'));
  assert.ok(selection.length > 1000);
  assert.doesNotMatch(selection, /composeWrite|updateMode|chartGuard/, 'selection synthesis does not go through the write-back');
});

// ---------------------------------------------------------------------------------------------------------------------
// F1 (decision 38): an entry that resolves a style refreshes the store first, so a style edited since the last run is
// used the first time. The store below has never been refreshed; the kind row names a style file whose voice and
// structure are files.

const STORE = loadSource('export { NoteStyleStore } from "./ai/note-style-store";');
function unrefreshedStyles(w) {
  const files = {
    'WS/S/Styles/Mix.md': '---\nstructure: Mine\nvoice: Pirate\n---\n',
    'WS/S/Structures/Mine.md': '## Mine A\nbody\n## Mine B\nbody\n',
    'WS/S/Voices/Pirate.md': 'Talk like a pirate.\n'
  };
  const under = folder => Object.keys(files).filter(file => file.startsWith(`${folder}/`) && !file.slice(folder.length + 1).includes('/'));
  const port = {
    list: async folder => under(folder).map(file => file.slice(folder.length + 1)).filter(name => name.endsWith('.md')),
    read: async file => { if (!(file in files)) throw new Error(file); return files[file]; },
    folderExists: folder => Object.keys(files).some(file => file.startsWith(`${folder}/`)),
    createFolder: async () => {}, create: async () => {}, trash: async () => {}
  };
  Object.assign(w.host.settings, { workspaceFolder: 'WS', noteStylesFolder: 'WS/S', noteStyleByKind: { topic: 'file:Mix' } });
  const store = new STORE.NoteStyleStore({ settings: () => w.host.settings, port, save: async () => {} });
  w.host.noteStyles = store;
  const before = store.runStyle({ kind: 'topic', outputLanguage: 'zh-TW' });
  assert.equal(before.toneText, undefined, 'without a refresh the store knows no style file');
  return { store, files };
}
const sectionNames = style => style.template.sections.map(section => section.name);
const proposalOptions = { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], shallowResearch: false, outputLanguage: 'zh-TW' };
const proposalReply = reply('d', { suggestions: [{ title: '子議題甲', task: 't', contribution: 'c' }] });

test('F1 entries: proposalTone and mapStyle refresh the store first, so the first call already resolves the kind row file style', async () => {
  const w = await wiring({ kind: 'topic', reply: proposalReply });
  unrefreshedStyles(w);
  const tone = await w.view.proposalTone(undefined, { outputLanguage: 'zh-TW' });
  assert.match(tone.toneText ?? '', /pirate/);
  const w2 = await wiring({ kind: 'topic', reply: proposalReply });
  unrefreshedStyles(w2);
  assert.deepEqual(plain(sectionNames(await w2.view.mapStyle('zh-TW', { kind: 'topic' }))), ['Mine A', 'Mine B']);
});

test('F1 entries: a refresh that fails only warns and the cached styles stay in use', async () => {
  const w = await wiring({ kind: 'topic', reply: proposalReply });
  const { store } = unrefreshedStyles(w);
  store.refresh = async () => { throw new Error('disk'); };
  const warned = [];
  const original = console.warn;
  console.warn = (...args) => warned.push(args);
  try {
    const style = await w.view.mapStyle('zh-TW', { kind: 'topic' });
    assert.ok(style.template.sections.length > 0);
    assert.deepEqual(plain(await w.view.proposalTone(undefined, { outputLanguage: 'zh-TW' })), {});
  } finally { console.warn = original; }
  assert.equal(warned.length, 2);
});

test('F1 entries: proposeChildren, proposeIntegrationDirections and a selection synthesis carry the voice of a style file that was not loaded yet', async () => {
  const children = await wiring({ kind: 'topic', reply: proposalReply });
  unrefreshedStyles(children);
  await children.view.proposeChildren(children.node, proposalOptions, '', () => {}, message => assert.fail(message));
  assert.equal(children.calls.asks.length, 1);
  assert.match(children.calls.asks[0].toneText ?? '', /pirate/, 'proposeChildren');

  const directions = await wiring({ kind: 'topic', reply: proposalReply });
  unrefreshedStyles(directions);
  await directions.view.proposeIntegrationDirections(directions.node, { ...proposalOptions, researchDepth: 'normal', referenceGroups: [{ id: 'g', name: 'G', location: 'x', documents: [{ path: 'S.md', content: '來源內容' }] }] }, () => {}, message => assert.fail(message));
  assert.equal(directions.calls.asks.length, 1);
  assert.match(directions.calls.asks[0].toneText ?? '', /pirate/, 'proposeIntegrationDirections');

  const selection = await wiring({ kind: 'topic', reply: proposalReply });
  unrefreshedStyles(selection);
  const second = await selection.repo.createNote('第二', 'model-a', selection.view.map, MAP_PATH, 'workspace');
  selection.view.map.nodes.push(second);
  await selection.repo.updateNote(second.path, { detail: '二的內容', summary: '二', status: 'completed' });
  await selection.view.startSelectionSynthesis([selection.node, second], { ...proposalOptions, researchDepth: 'normal', synthesisTitle: 'S' }, null, message => assert.fail(message), () => {});
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(selection.calls.asks.length, 1);
  assert.match(selection.calls.asks[0].toneText ?? '', /pirate/, 'startSelectionSynthesis');
});

test('F1 entries: an AI merge reads a style file that was not loaded yet (its request carries the file structure); the merge writes stay as they were', async () => {
  const w = await wiring({ kind: 'topic', reply: () => reply('合併內容') });
  unrefreshedStyles(w);
  const [a, b] = [w.node, await w.repo.createNote('乙', 'model-a', w.view.map, MAP_PATH, 'workspace')];
  w.view.map.nodes.push(b);
  w.view.notes = new Map(await Promise.all(w.view.map.nodes.map(async item => [item.id, await w.repo.readNote(item.path, w.view.map)])));
  w.host.confirmAiUsage = async (_model, run) => { await run(); return true; };
  w.host.currentModelChoice = () => ({ model: 'model-a' });
  const began = await w.view.startMergeDraft('合併', { path: MAP_PATH, mapId: 'map-a', parentId: null, sources: [a, b].map(item => ({ id: item.id, path: item.path })) }, () => {}, new AbortController().signal);
  await w.view.mergeTasks.get(MAP_PATH)?.run;
  assert.equal(began, true);
  assert.deepEqual(plain(w.calls.asks[0].detailTemplate.sections.map(section => section.name)), ['Mine A', 'Mine B']);
});

test('F1 entries: every mapStyle and proposalTone call site in the view awaits it; the dialog default stays on the cached styles', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'experiences/visual-map/view.ts'), 'utf8');
  assert.deepEqual([...source.matchAll(/(.)this\.(?:mapStyle|proposalTone)\(/g)].filter(match => !/[ (]/.test(match[1]) ).map(match => match[0]), []);
  for (const match of source.matchAll(/(await )?this\.(mapStyle|proposalTone)\(/g)) assert.ok(match[1], `${match[2]} is awaited`);
  assert.match(source, /const current = this\.mapStyleCached\(settings\.language\)/);
});

// F1 reviewer R1: a file that changed after the run started is found before the backup, not after it.
test('F1 fresh: the note file differing from the run start is reported as outdated before any backup is made', async () => {
  const w = await wiring({ kind: 'topic', reply: () => { w.answered = true; return reply(`### ${names.core}\n\n全新結論 F1`); } });
  const rawBefore = w.raw();
  const original = Object.getPrototypeOf(w.view).writebackHooks;
  w.view.writebackHooks = function () {
    const hooks = original.call(this);
    const read = hooks.readRaw;
    return { ...hooks, readRaw: async path => { const text = await read(path); return w.answered ? `${text}\nedited elsewhere` : text; } };
  };
  await w.run({ runStyle: await fresh(w) });
  assert.equal(anyBackupFolder(w.files), false, 'no backup was created');
  assert.equal(stable(w.raw()), stable(rawBefore), 'the note is untouched');
  assert.ok(MSG.stale.includes(w.calls.failed[0]), w.calls.failed[0]);
  assert.equal(w.view.history.canUndo, false);
});

// F1 reviewer R2: a fresh run that cannot read the note file stops before the model is asked.
test('F1 fresh: a note file that cannot be read stops the run before any AI call (research and synthesis)', async () => {
  const research = await wiring({ kind: 'topic', reply: () => reply(`### ${names.core}\n\n全新`) });
  const rawBefore = research.raw();
  const original = Object.getPrototypeOf(research.view).writebackHooks;
  research.view.writebackHooks = function () { return { ...original.call(this), readRaw: async () => { throw new Error('gone'); } }; };
  const handle = await research.run({ runStyle: await fresh(research) });
  assert.equal(research.calls.asks.length, 0, 'research: no AI call');
  assert.equal(stable(research.raw()), stable(rawBefore));
  assert.ok(MSG.backupFailed.includes(research.calls.failed[0]), research.calls.failed[0]);
  assert.equal(research.host.running.has(research.node.path), false, 'the topic is released');
  assert.equal(handle, null);

  const integrate = await wiring({ kind: 'topic', reply: () => reply(`### ${names.core}\n\n全新`) });
  const raw2 = integrate.raw();
  const original2 = Object.getPrototypeOf(integrate.view).writebackHooks;
  integrate.view.writebackHooks = function () { return { ...original2.call(this), readRaw: async () => { throw new Error('gone'); } }; };
  const template = integrate.view.detailTemplateFor;
  integrate.view.detailTemplateFor = async (...args) => ({ ...(await template.apply(integrate.view, args)), updateMode: 'fresh' });
  await integrate.view.integrateChildren(integrate.node, { referenceGroups: [{ id: 'g', name: 'G', location: 'x', documents: [{ path: 'S.md', content: 'x' }] }], outputLanguage: 'zh-TW', researchMode: 'local' }, '', async (_r, write, summary, detail) => { await write(summary, detail); }, message => integrate.calls.failed.push(message));
  assert.equal(integrate.calls.asks.length, 0, 'integration: no AI call');
  assert.equal(stable(integrate.raw()), stable(raw2));
  assert.ok(MSG.backupFailed.includes(integrate.calls.failed[0]), integrate.calls.failed[0]);
  assert.equal(integrate.host.running.has(integrate.node.path), false);
});

// F1: the log line the plugin writes uses the list marker of the old log lines.
test('F1 log line marker: top, fresh and a merge supplement follow the old log lines ("- " stays "- "); no old line keeps the template way', () => {
  const dashed = `${section(names.core, '舊')}\n\n${section(names.log, '- 2026-01-01　舊一\n- 2026-02-01　舊二')}`;
  const base = { oldDetail: dashed, summary: '摘要', template: standard, language: 'zh-TW', now: NOW, backupPath: 'B/x.md' };
  assert.deepEqual(plain(logBody(W.composeWriteback({ ...base, mode: 'top', aiDetail: section(names.core, '新') }).detail)), ['- 2026-01-01　舊一', '- 2026-02-01　舊二', `- ${TODAY}　摘要`]);
  assert.deepEqual(plain(logBody(W.composeWriteback({ ...base, mode: 'fresh', aiDetail: section(names.core, '新') }).detail)).slice(2), [`- ${TODAY}　已用新研究取代，舊版備份在 B/x.md`]);
  assert.deepEqual(plain(logBody(W.composeWriteback({ ...base, mode: 'merge', aiDetail: `${section(names.core, '新')}\n\n${section(names.log, '- 2026-01-01　舊一\n- 2026-02-01　舊二')}` }).detail)), ['- 2026-01-01　舊一', '- 2026-02-01　舊二', `- ${TODAY}　摘要`]);
  // Plain old lines stay plain, and with no old line the line is written as the template does (no marker).
  const plainOld = `${section(names.core, '舊')}\n\n${section(names.log, '2026-01-01　舊一')}`;
  assert.deepEqual(plain(logBody(W.composeWriteback({ ...base, oldDetail: plainOld, mode: 'top', aiDetail: section(names.core, '新') }).detail)), ['2026-01-01　舊一', `${TODAY}　摘要`]);
  const none = `${section(names.core, '舊')}\n\n${section(names.log, '本次無新增內容。')}`;
  assert.deepEqual(plain(logBody(W.composeWriteback({ ...base, oldDetail: none, mode: 'top', aiDetail: section(names.core, '新') }).detail)).filter(line => !line.includes('本次無新增')), [`${TODAY}　摘要`]);
  assert.deepEqual(plain(logBody(W.composeWriteback({ ...base, oldDetail: section(names.core, '舊'), mode: 'top', aiDetail: section(names.core, '新') }).detail)), [`${TODAY}　摘要`]);
});
