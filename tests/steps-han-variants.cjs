// Han variants (multilingual D-73 rev 2, D-2026-10-87): Traditional->Simplified table, script votes, search folding.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const { obsidian } = require('./support.cjs');

const fold = load('i18n/han-fold.ts');
const table = load('i18n/han-variants.ts');

test('han table: known Traditional to Simplified pairs', () => {
  const pairs = { 圖: '图', 發: '发', 髮: '发', 臺: '台', 後: '后', 裡: '里', 麵: '面', 書: '书', 館: '馆', 與: '与', 展: '展' };
  for (const [traditional, simplified] of Object.entries(pairs)) assert.equal(fold.toSimplifiedFold(traditional), simplified, traditional);
  assert.equal(fold.toSimplifiedFold('圖書館與發展'), '图书馆与发展');
  assert.ok(Array.from(table.HAN_TRADITIONAL).length === Array.from(table.HAN_SIMPLIFIED).length);
  assert.ok(Array.from(table.HAN_TRADITIONAL).length > 2500);
});

test('han table: shared characters are absent and non-Han text passes through', () => {
  for (const char of ['中', '人', '台', '图']) assert.ok(!Array.from(table.HAN_TRADITIONAL).includes(char), char);
  assert.equal(fold.toSimplifiedFold('中人 Alpha İ 😀'), '中人 Alpha İ 😀');
});

const votes = text => ({ ...fold.hanScriptVotes(text) });
test('han votes: simplified-only, traditional-only and shared characters', () => {
  assert.deepEqual(votes('图书馆'), { simplified: 3, traditional: 0 });
  assert.deepEqual(votes('圖書館'), { simplified: 0, traditional: 3 });
  assert.deepEqual(votes('中人'), { simplified: 0, traditional: 0 });
  assert.deepEqual(votes('Hello'), { simplified: 0, traditional: 0 });
  assert.deepEqual(votes('台北'), { simplified: 0, traditional: 0 });
  assert.deepEqual(votes('台灣'), { simplified: 0, traditional: 1 });
  assert.deepEqual(votes('图书'), { simplified: 2, traditional: 0 });
  assert.deepEqual(votes('后面'), { simplified: 1, traditional: 0 });
  assert.deepEqual(votes('發髮'), { simplified: 0, traditional: 2 });
  assert.deepEqual(votes('发'), { simplified: 1, traditional: 0 });
});

test('han search: simplified query finds traditional text and vice versa, Turkish fold intact', () => {
  const { foldOutlineSearch } = load('ui/outline-view.ts', { obsidian: { ...obsidian, ItemView: class {}, Notice: class {} } });
  assert.ok(foldOutlineSearch('圖書館').includes(foldOutlineSearch('图')));
  assert.ok(foldOutlineSearch('图书馆').includes(foldOutlineSearch('圖')));
  assert.ok(foldOutlineSearch('髮型').includes(foldOutlineSearch('发')));
  assert.ok(!foldOutlineSearch('圖書館').includes(foldOutlineSearch('旅')));
  assert.ok(foldOutlineSearch('İstanbul 圖').includes('istanbul 图'));
});
