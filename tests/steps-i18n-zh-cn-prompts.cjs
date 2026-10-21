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
const toTraditional = text => {
  let result = text;
  CN.forEach(name => { result = result.split(name).join(`\u0000${CN.indexOf(name)}\u0000`); });
  result = result.replace(/\u0000(\d+)\u0000/g, (_, index) => TW[Number(index)] ?? '');
  for (const [cn, tw] of dictionaryPairs) result = result.split(cn).join(tw);
  return result;
};

const bases = fs.readdirSync(directory).filter(file => file.endsWith('.zh.txt')).map(file => file.slice(0, -'.zh.txt'.length));

test('zh-CN prompt snapshots: every zh snapshot has a zh-CN twin (prompt and schema)', () => {
  const missing = bases.filter(base => !fs.existsSync(path.join(directory, `${base}.zh-CN.txt`)));
  assert.deepEqual(missing, []);
  for (const base of bases) {
    const schema = path.join(directory, `${base}.zh.schema.json`);
    if (fs.existsSync(schema)) assert.equal(fs.readFileSync(path.join(directory, `${base}.zh-CN.schema.json`), 'utf8'), fs.readFileSync(schema, 'utf8'), `${base} schema`);
  }
});

test('zh-CN prompt snapshots differ from zh-TW only on language names (one position each) and research.* dictionary texts', () => {
  assert.equal(TW.length, CN.length, 'registry name forms line up between zh-TW and zh-CN');
  const unexplained = [];
  let total = 0;
  for (const base of bases) {
    const zh = fs.readFileSync(path.join(directory, `${base}.zh.txt`), 'utf8');
    const cn = fs.readFileSync(path.join(directory, `${base}.zh-CN.txt`), 'utf8');
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

test('zh-CN prompt snapshots: exactly 17 lines carry a research.* text that differs from zh-TW (the dictionary-sourced instructions)', () => {
  const simplified = RESEARCH_KEYS.filter(key => zhCN[key] !== zhTW[key]).map(key => zhCN[key]);
  assert.ok(simplified.length > 0, 'some research.* texts are Simplified');
  const lines = bases.flatMap(base => fs.readFileSync(path.join(directory, `${base}.zh-CN.txt`), 'utf8').split('\n').filter(line => simplified.some(text => line.includes(text))));
  assert.equal(lines.length, 17);
});
