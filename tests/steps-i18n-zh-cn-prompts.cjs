// zh-CN prompt snapshots (multilingual P3): they equal the zh-TW snapshots except for the parameterised language names
// and the dictionary-sourced `research.*` instruction texts, which are Simplified in zh-CN.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./support-replay.cjs');

const directory = path.join(__dirname, 'snapshots', 'prompts');
const { LANGUAGES } = load('i18n/languages.ts');
const { zhTW } = load('i18n/zh-TW.ts');
const { zhCN } = load('i18n/zh-CN.ts');
const entry = id => LANGUAGES.find(item => item.id === id);
const names = id => ['zh', 'en'].flatMap(instruction => Object.values(entry(id).prompt[instruction]));
const TW = [...new Set(names('zh-TW'))].sort((a, b) => b.length - a.length);
const CN = [...new Set(names('zh-CN'))].sort((a, b) => b.length - a.length);
const count = (text, needles) => needles.reduce((sum, needle) => sum + text.split(needle).length - 1, 0) - 0;
// Count positions by longest-first matching so "繁體中文（台灣）" is one position, not two.
function positions(text, needles) {
  const pattern = new RegExp(needles.map(item => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return (text.match(pattern) ?? []).length;
}
void count;
// Dictionary texts that legitimately differ because they are rendered from the dictionary of the output language.
const DICTIONARY_PREFIXES = ['research.'];
const RESEARCH_KEYS = Object.keys(zhTW).filter(key => DICTIONARY_PREFIXES.some(prefix => key.startsWith(prefix)));
const dictionaryPairs = Object.keys(zhTW).filter(key => DICTIONARY_PREFIXES.some(prefix => key.startsWith(prefix))).map(key => [zhCN[key], zhTW[key]]).sort((a, b) => b[0].length - a[0].length);
// The R1 heading-verbatim additions (zh-CN only): the output-language sentence names the note language for the standard
// headings, and a clause after the fixed heading list says to copy them exactly. Both are removed before comparing.
const NOTE = entry('zh-CN').note, NOTE_ZH = entry(NOTE).prompt.zh.plain, CN_ZH = entry('zh-CN').prompt.zh.plain;
const HEADING_RULE_CN = `六個標準 Detail 標題固定使用筆記語言（${NOTE_ZH}），逐字照 detail 結構寫出；內文仍使用${CN_ZH}。`;
const HEADING_RULE_TW = '六個標準 Detail 標題固定跟隨介面語言。';
const CLAUSE_CN = `固定標題必須逐字照上列寫出（${NOTE_ZH}，不要轉成${CN_ZH}），不可增加另一套標題；只有標題底下的內容使用${CN_ZH}撰寫。`;
// The note style file prompts (custom headings) carry the shorter clause from headings-verbatim-custom.zh.md.
const CLAUSE_CUSTOM_CN = `固定標題必須逐字照上列寫出，不可增加另一套標題；只有標題底下的內容使用${CN_ZH}撰寫。`;
// Returns the text without the additions, and how many of each it carried.
const stripVerbatim = text => {
  const rules = text.split(HEADING_RULE_CN).length - 1;
  const lines = text.split('\n'), kept = lines.filter(line => line !== CLAUSE_CN && line !== CLAUSE_CUSTOM_CN);
  return { text: kept.join('\n').split(HEADING_RULE_CN).join(HEADING_RULE_TW), rules, clauses: lines.length - kept.length };
};
// The count issues that repair prompts quote (ui.detail_count_issue_*) are filled in the output language too; their
// literal pieces between the {n} placeholders are paired like the research.* texts.
const ISSUE_PAIRS = Object.keys(zhTW).filter(key => key.startsWith('ui.detail_count_issue_')).flatMap(key => {
  const cn = zhCN[key].split(/\{\d+\}/), tw = zhTW[key].split(/\{\d+\}/);
  return cn.map((piece, index) => [piece, tw[index]]).filter(([a, b]) => a && a !== b);
});
// Only the snapshots that quote count issues (the repair-counts prompt of a style file) may use these pairs. The list
// is exact: service.task-style-file-sections plus the 21 style-file snapshots the prompt-assembler safety net added
// (commit 3190387: task, quick, synthesize and merge variants, each with its numbered repair-counts prompt). Their
// repair-counts line has the same shape as the original one. Decompose has no count repair, so it is not listed.
const ISSUE_BASE_LIST = new Set([
  'service.merge-style-file-callout-map.2',
  'service.merge-style-file-callouts-placed.2',
  'service.merge-style-file-format-off.2',
  'service.merge-style-file-sections.2',
  'service.merge-style-file-tables-off.2',
  'service.quick-style-file-callout-map.2',
  'service.quick-style-file-callouts-placed.2',
  'service.quick-style-file-format-off.2',
  'service.quick-style-file-sections.2',
  'service.quick-style-file-tables-off.2',
  'service.synthesize-style-file-callout-map.2',
  'service.synthesize-style-file-callouts-placed.2',
  'service.synthesize-style-file-format-off.2',
  'service.synthesize-style-file-sections.2',
  'service.synthesize-style-file-tables-off.2',
  'service.task-style-file-callout-all-off.2',
  'service.task-style-file-callout-map-placed.2',
  'service.task-style-file-callouts-placed.2',
  'service.task-style-file-highlight-off.2',
  'service.task-style-file-sections.2',
  'service.task-style-file-tables-off.2',
  'service.task-style-file-tasks-off.2'
]);
const ISSUE_BASES = { test: base => ISSUE_BASE_LIST.has(base) };
const pairsFor = base => (ISSUE_BASES.test(base) ? [...dictionaryPairs, ...ISSUE_PAIRS] : dictionaryPairs).sort((a, b) => b[0].length - a[0].length);
const toTraditional = (text, base) => {
  let result = text;
  CN.forEach(name => { result = result.split(name).join(`\u0000${CN.indexOf(name)}\u0000`); });
  result = result.replace(/\u0000(\d+)\u0000/g, (_, index) => TW[Number(index)] ?? '');
  for (const [cn, tw] of pairsFor(base)) result = result.split(cn).join(tw);
  return result;
};

// A base is a snapshot stem, optionally numbered (service.reference-groups.zh.1.txt pairs with ...zh-CN.1.txt).
const bases = fs.readdirSync(directory).map(file => /^(.+)\.zh(\.\d+)?\.txt$/.exec(file)).filter(Boolean).map(match => `${match[1]}${match[2] ?? ''}`);
const twFile = base => { const m = /^(.+?)(\.\d+)?$/.exec(base); return `${m[1]}.zh${m[2] ?? ''}.txt`; };
const cnFile = base => twFile(base).replace('.zh', '.zh-CN');
const schemaFile = (base, tag) => twFile(base).replace('.zh', `.${tag}`).replace(/\.txt$/, '.schema.json');

const SCHEMA_DESCRIPTIONS = [
  ['适合思维导图的一句简体中文结论，80 字内', '適合心智圖的一句繁體中文結論，80 字內'],
  ['完整的简体中文 Markdown 分析', '完整的繁體中文 Markdown 分析']
];
test('zh-CN prompt snapshots: every zh snapshot has a zh-CN twin (prompt and schema)', () => {
  const missing = bases.filter(base => !fs.existsSync(path.join(directory, cnFile(base))));
  assert.deepEqual(missing, []);
  for (const base of bases) {
    const schema = path.join(directory, schemaFile(base, 'zh'));
    if (fs.existsSync(schema)) {
      // Persona 38: the two prose descriptions are Simplified in zh-CN. Everything else must still equal zh-TW, so map the
      // Simplified descriptions back to the Traditional ones (and require each to be present) before comparing.
      const cn = fs.readFileSync(path.join(directory, schemaFile(base, 'zh-CN')), 'utf8');
      const hits = SCHEMA_DESCRIPTIONS.filter(([simplified]) => cn.includes(simplified));
      const restored = hits.reduce((text, [simplified, traditional]) => text.split(simplified).join(traditional), cn);
      const tw = fs.readFileSync(schema, 'utf8');
      assert.equal(restored, tw, `${base} schema`);
      assert.deepEqual(hits.map(item => item[0]), SCHEMA_DESCRIPTIONS.filter(([, traditional]) => tw.includes(traditional)).map(item => item[0]), `${base} schema: Simplified descriptions replace exactly the Traditional ones`);
    }
  }
});

// note-style-editorial K2: the Taiwan wording sentence of the shared writing baseline is in zh-TW output only, by design.
const TAIWAN_WORDING = '用台灣用語，例如「軟體」「資料」「品質」，不用中國大陸用語。';
test('zh-CN prompt snapshots differ from zh-TW only on language names (one position each) and research.* dictionary texts', () => {
  assert.equal(TW.length, CN.length, 'registry name forms line up between zh-TW and zh-CN');
  const unexplained = [];
  let total = 0;
  for (const base of bases) {
    const zhFull = fs.readFileSync(path.join(directory, twFile(base)), 'utf8');
    const zh = zhFull.replace(TAIWAN_WORDING, '');
    const cn = stripVerbatim(fs.readFileSync(path.join(directory, cnFile(base)), 'utf8')).text;
    const twPositions = positions(zh, TW);
    const cnPositions = positions(cn, CN);
    if (twPositions !== cnPositions) unexplained.push(`${base}: ${twPositions} zh-TW name positions vs ${cnPositions} zh-CN`);
    if (positions(cn, TW) !== 0) unexplained.push(`${base}: zh-CN snapshot still names zh-TW`);
    if (positions(zh, CN) !== 0) unexplained.push(`${base}: zh-TW snapshot names zh-CN`);
    const restored = toTraditional(cn, base);
    if (restored !== zh) {
      const left = restored.split('\n'), right = zh.split('\n');
      const line = left.findIndex((value, index) => value !== right[index]);
      unexplained.push(`${base}: line ${line + 1} differs beyond language names: ${(left[line] ?? '').slice(0, 80)}`);
    }
    total += cnPositions;
  }
  assert.deepEqual(unexplained, []);
  assert.ok(total > 0, 'the snapshots parameterise at least one language name');
});

test('zh-CN prompt snapshots: exactly 104 lines carry a research.* text that differs from zh-TW (the dictionary-sourced instructions)', () => {
  const simplified = RESEARCH_KEYS.filter(key => zhCN[key] !== zhTW[key]).map(key => zhCN[key]);
  assert.ok(simplified.length > 0, 'some research.* texts are Simplified');
  const lines = bases.flatMap(base => fs.readFileSync(path.join(directory, cnFile(base)), 'utf8').split('\n').filter(line => simplified.some(text => line.includes(text))));
  // 19 + the three Quick AI mode prompts (service.task-quick, service.task-quick-subtopic, claude.task-quick) + service.synthesize-summary-direction + the four note style file prompts + the note style callout map prompt = 28
  // at 49c1005; + 58 lines in the 58 snapshot files the prompt-assembler safety net added (3190387, none of them existed
  // at 49c1005; no earlier hit moved) = 86; + the 5 per-kind default snapshots service.task-kind-* (zh-CN, P2b of
  // note-style-recipe), one line each = 91; + the four zh-CN snapshots service.{task,synthesize}-{top,fresh} of
  // note-style-recipe T4 P1, one line each = 95; + the four zh-CN snapshots service.reference-groups-{top,fresh}.{1,2}
  // of note-style-recipe T4 F1, one line each = 99; + the two zh-CN snapshots service.{research,decompose}-anchor-context
  // of annotated-image P5a, one line each = 101; + the two zh-CN snapshots service.task-ai-{decided,followed} of
  // ai-proposed-note-style P2, one line each = 103; + the zh-CN snapshot service.synthesize-standard (topic chat P1b), one line = 104.
  assert.equal(lines.length, 104);
});

test('zh-CN prompt snapshots: the heading-verbatim additions are exactly 102 output-language sentences and 95 clauses, none in zh-TW', () => {
  const total = { rules: 0, clauses: 0 };
  for (const file of fs.readdirSync(directory).filter(name => /\.zh-CN(\.\d+)?\.txt$/.test(name))) {
    const found = stripVerbatim(fs.readFileSync(path.join(directory, file), 'utf8'));
    total.rules += found.rules; total.clauses += found.clauses;
  }
  for (const file of fs.readdirSync(directory).filter(name => /\.zh(\.\d+)?\.txt$/.test(name)))
    assert.equal(fs.readFileSync(path.join(directory, file), 'utf8').includes('固定標題必須逐字'), false, `${file}: zh-TW has no clause`);
  // 28 and 28 at 49c1005; the 58 snapshots added by 3190387 bring 58 more sentences and 51 more clauses (the 7 decompose
  // snapshots have the sentence but no detail structure, so no clause); the 5 service.task-kind-* zh-CN snapshots of
  // note-style-recipe P2b add 5 sentences and 5 clauses; the four zh-CN snapshots service.{task,synthesize}-{top,fresh} of note-style-recipe
  // T4 P1 add 4 sentences and 4 clauses; the four zh-CN snapshots service.reference-groups-{top,fresh}.{1,2} of T4 F1 add 4 sentences and 4 clauses; the two zh-CN snapshots service.{research,decompose}-anchor-context of annotated-image P5a add
  // 2 sentences and 1 clause (the decompose snapshot has the sentence but no detail structure); the two zh-CN snapshots
  // service.task-ai-{decided,followed} of ai-proposed-note-style P2 add 2 sentences and 1 clause (the decided prompt has
  // no detail structure, so no clause). The same two snapshots then lose their sentence again (the AI decides or keeps the
  // sections, so no six-standard-headings sentence): 103 - 2 = 101; the followed one keeps its clause. The zh-CN snapshot
  // service.synthesize-standard (topic chat P1b) adds 1 sentence and 1 clause: 102 and 95.
  assert.deepEqual(total, { rules: 102, clauses: 95 });
});
