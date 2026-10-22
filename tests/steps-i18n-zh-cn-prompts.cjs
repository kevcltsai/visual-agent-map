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
// Returns the text without the additions, and how many of each it carried.
const stripVerbatim = text => {
  const rules = text.split(HEADING_RULE_CN).length - 1;
  const lines = text.split('\n'), kept = lines.filter(line => line !== CLAUSE_CN);
  return { text: kept.join('\n').split(HEADING_RULE_CN).join(HEADING_RULE_TW), rules, clauses: lines.length - kept.length };
};
const toTraditional = text => {
  let result = text;
  CN.forEach(name => { result = result.split(name).join(`\u0000${CN.indexOf(name)}\u0000`); });
  result = result.replace(/\u0000(\d+)\u0000/g, (_, index) => TW[Number(index)] ?? '');
  for (const [cn, tw] of dictionaryPairs) result = result.split(cn).join(tw);
  return result;
};

// A base is a snapshot stem, optionally numbered (service.reference-groups.zh.1.txt pairs with ...zh-CN.1.txt).
const bases = fs.readdirSync(directory).map(file => /^(.+)\.zh(\.\d+)?\.txt$/.exec(file)).filter(Boolean).map(match => `${match[1]}${match[2] ?? ''}`);
const twFile = base => { const m = /^(.+?)(\.\d+)?$/.exec(base); return `${m[1]}.zh${m[2] ?? ''}.txt`; };
const cnFile = base => twFile(base).replace('.zh', '.zh-CN');
const schemaFile = (base, tag) => twFile(base).replace('.zh', `.${tag}`).replace(/\.txt$/, '.schema.json');

test('zh-CN prompt snapshots: every zh snapshot has a zh-CN twin (prompt and schema)', () => {
  const missing = bases.filter(base => !fs.existsSync(path.join(directory, cnFile(base))));
  assert.deepEqual(missing, []);
  for (const base of bases) {
    const schema = path.join(directory, schemaFile(base, 'zh'));
    if (fs.existsSync(schema)) assert.equal(fs.readFileSync(path.join(directory, schemaFile(base, 'zh-CN')), 'utf8'), fs.readFileSync(schema, 'utf8'), `${base} schema`);
  }
});

test('zh-CN prompt snapshots differ from zh-TW only on language names (one position each) and research.* dictionary texts', () => {
  assert.equal(TW.length, CN.length, 'registry name forms line up between zh-TW and zh-CN');
  const unexplained = [];
  let total = 0;
  for (const base of bases) {
    const zh = fs.readFileSync(path.join(directory, twFile(base)), 'utf8');
    const cn = stripVerbatim(fs.readFileSync(path.join(directory, cnFile(base)), 'utf8')).text;
    const twPositions = positions(zh, TW);
    const cnPositions = positions(cn, CN);
    if (twPositions !== cnPositions) unexplained.push(`${base}: ${twPositions} zh-TW name positions vs ${cnPositions} zh-CN`);
    if (positions(cn, TW) !== 0) unexplained.push(`${base}: zh-CN snapshot still names zh-TW`);
    if (positions(zh, CN) !== 0) unexplained.push(`${base}: zh-TW snapshot names zh-CN`);
    const restored = toTraditional(cn);
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

test('zh-CN prompt snapshots: exactly 19 lines carry a research.* text that differs from zh-TW (the dictionary-sourced instructions)', () => {
  const simplified = RESEARCH_KEYS.filter(key => zhCN[key] !== zhTW[key]).map(key => zhCN[key]);
  assert.ok(simplified.length > 0, 'some research.* texts are Simplified');
  const lines = bases.flatMap(base => fs.readFileSync(path.join(directory, cnFile(base)), 'utf8').split('\n').filter(line => simplified.some(text => line.includes(text))));
  assert.equal(lines.length, 19);
});

test('zh-CN prompt snapshots: the heading-verbatim additions are exactly 19 output-language sentences and 19 clauses, none in zh-TW', () => {
  const total = { rules: 0, clauses: 0 };
  for (const file of fs.readdirSync(directory).filter(name => /\.zh-CN(\.\d+)?\.txt$/.test(name))) {
    const found = stripVerbatim(fs.readFileSync(path.join(directory, file), 'utf8'));
    total.rules += found.rules; total.clauses += found.clauses;
  }
  for (const file of fs.readdirSync(directory).filter(name => /\.zh(\.\d+)?\.txt$/.test(name)))
    assert.equal(fs.readFileSync(path.join(directory, file), 'utf8').includes('固定標題必須逐字'), false, `${file}: zh-TW has no clause`);
  assert.deepEqual(total, { rules: 19, clauses: 19 });
});
