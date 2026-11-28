// Map search matching (pure functions, not yet wired to UI): title-only literal substring, cycling, collapsed ancestors.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const S = require('./support.cjs');

const { foldSearchText, findMatches, searchMatches, nextMatch, collapsedAncestors } = load('experiences/visual-map/map-search.ts');
const { foldOutlineSearch } = load('ui/outline-view.ts', { obsidian: S.obsidian });

// The bundle runs in its own realm; compare plain host-realm copies.
const plain = value => JSON.parse(JSON.stringify(value));

const titles = {
  n1: '產品地圖', n2: '使用者研究', n3: '訪談紀錄', n4: '市場分析', n5: '競品比較', n6: '定價策略',
  n7: '圖表設計', n8: 'Pricing Strategy', n9: 'İstanbul 市場', n10: '風險清單', n11: '下一步', n12: '待辦事項',
};
const order = Object.keys(titles);
const bodies = { n4: '抽樣調查顯示價格敏感', n12: 'Needle in the haystack' };
const titleOf = id => ({ title: titles[id], body: bodies[id] ?? '' });
const node = (id, parentId, collapsed = false) => ({ id, path: `${id}.md`, parentId, x: 0, y: 0, collapsed });

test('findMatches matches Chinese titles as substrings in order', () => {
  assert.deepEqual(plain(findMatches(order, titleOf, '市場')), ['n4', 'n9']);
});
test('findMatches ignores English case', () => {
  assert.deepEqual(plain(findMatches(order, titleOf, 'PRICING')), ['n8']);
});
test('findMatches folds Traditional and Simplified both ways', () => {
  assert.deepEqual(plain(findMatches(order, titleOf, '图')), ['n1', 'n7']);
  assert.deepEqual(plain(findMatches(order, titleOf, '圖')), ['n1', 'n7']);
  assert.ok(findMatches(order, titleOf, '产品').includes('n1'));
});
test('findMatches: Turkish İ is found by plain i', () => {
  assert.deepEqual(plain(findMatches(order, titleOf, 'istanbul')), ['n9']);
});
test('findMatches: whitespace-only query returns []', () => {
  assert.deepEqual(plain(findMatches(order, titleOf, '   \t')), []);
  assert.deepEqual(plain(findMatches(order, titleOf, '')), []);
});
test('findMatches trims the query', () => {
  assert.deepEqual(plain(findMatches(order, titleOf, '  定價 ')), ['n6']);
});
test('findMatches treats regex characters literally', () => {
  const t = { a: 'a.*(b', b: 'axxb', c: 'plain' };
  assert.deepEqual(plain(findMatches(['a', 'b', 'c'], id => ({ title: t[id], body: '' }), '.*(')), ['a']);
  assert.deepEqual(plain(findMatches(['a', 'b', 'c'], id => ({ title: t[id], body: '' }), '(')), ['a']);
});
test('findMatches follows `order`, not insertion of titles', () => {
  assert.deepEqual(plain(findMatches(['n9', 'n4'], titleOf, '市場')), ['n9', 'n4']);
});
test('findMatches finds a word that only the body has, and returns [] when neither title nor body has it', () => {
  assert.deepEqual(plain(findMatches(order, titleOf, 'haystack')), ['n12']);
  assert.deepEqual(plain(findMatches(order, titleOf, 'n4')), []);
});
test('findMatches: Traditional/Simplified fold applies to the body too', () => {
  assert.deepEqual(plain(findMatches(order, titleOf, '价格')), ['n4']);
  assert.deepEqual(plain(findMatches(order, titleOf, '抽样')), ['n4']);
});
test('searchMatches tells body-only hits from title hits; two cards with the same title are both listed', () => {
  const t = { a: { title: '市場', body: '' }, b: { title: '其他', body: '市場規模' }, c: { title: '市場', body: '市場' } };
  const r = searchMatches(['a', 'b', 'c'], id => t[id], '市場');
  assert.deepEqual(plain(r.matches), ['a', 'b', 'c']);
  assert.deepEqual([...r.bodyOnly], ['b']);
});
test('foldSearchText equals foldOutlineSearch on fixed samples', () => {
  for (const s of ['圖表 Chart', 'İstanbul', 'ABC def', '產品地圖', '', '  mixed 繁體 ÇA  ', ...Object.values(titles)]) {
    assert.equal(foldSearchText(s), foldOutlineSearch(s), s);
  }
});

test('nextMatch returns null when nothing matches', () => {
  assert.equal(nextMatch(order, [], 'n1', 1), null);
  assert.equal(nextMatch(order, [], null, -1), null);
});
test('nextMatch cycles forward and backward with index and total', () => {
  const m = ['n4', 'n7', 'n9'];
  assert.deepEqual(plain(nextMatch(order, m, 'n4', 1)), { id: 'n7', index: 1, total: 3 });
  assert.deepEqual(plain(nextMatch(order, m, 'n9', 1)), { id: 'n4', index: 0, total: 3 });
  assert.deepEqual(plain(nextMatch(order, m, 'n4', -1)), { id: 'n9', index: 2, total: 3 });
});
test('nextMatch from a non-match moves along `order`', () => {
  const m = ['n4', 'n7', 'n9'];
  assert.deepEqual(plain(nextMatch(order, m, 'n5', 1)), { id: 'n7', index: 1, total: 3 });
  assert.deepEqual(plain(nextMatch(order, m, 'n5', -1)), { id: 'n4', index: 0, total: 3 });
  assert.deepEqual(plain(nextMatch(order, m, 'n11', 1)), { id: 'n4', index: 0, total: 3 });
  assert.deepEqual(plain(nextMatch(order, m, 'n1', -1)), { id: 'n9', index: 2, total: 3 });
});
test('nextMatch with null or unknown current picks first (forward) or last (backward)', () => {
  const m = ['n4', 'n7'];
  assert.deepEqual(plain(nextMatch(order, m, null, 1)), { id: 'n4', index: 0, total: 2 });
  assert.deepEqual(plain(nextMatch(order, m, null, -1)), { id: 'n7', index: 1, total: 2 });
  assert.deepEqual(plain(nextMatch(order, m, 'ghost', 1)), { id: 'n4', index: 0, total: 2 });
});
test('nextMatch with a single match stays on it', () => {
  assert.deepEqual(plain(nextMatch(order, ['n4'], 'n4', 1)), { id: 'n4', index: 0, total: 1 });
});

test('collapsedAncestors lists collapsed ancestors root first, excluding the node', () => {
  const nodes = [node('r', null, true), node('a', 'r', false), node('b', 'a', true), node('c', 'b', true)];
  assert.deepEqual(plain(collapsedAncestors(nodes, 'c')), ['r', 'b']);
  assert.deepEqual(plain(collapsedAncestors(nodes, 'r')), []);
});
test('collapsedAncestors returns [] for a missing target', () => {
  assert.deepEqual(plain(collapsedAncestors([node('r', null, true)], 'ghost')), []);
});
test('collapsedAncestors stops at a missing parent', () => {
  assert.deepEqual(plain(collapsedAncestors([node('c', 'gone')], 'c')), []);
});
test('collapsedAncestors terminates on a parent cycle', () => {
  const nodes = [node('a', 'b', true), node('b', 'c', true), node('c', 'a', true)];
  assert.deepEqual(plain(collapsedAncestors(nodes, 'a')).sort(), ['b', 'c']);
});

test('shared search normalization preserves case, script, spaces and non-Han text', () => {
  const { foldSearchText: shared } = load('i18n/han-fold.ts');
  for (const [input, expected] of [['İstanbul 圖', 'istanbul 图'], ['  髮型 ABC  ', '  发型 abc  '], ['😀 123', '😀 123'], ['', '']]) {
    assert.equal(shared(input), expected);
    assert.equal(foldSearchText(input), expected);
    assert.equal(foldOutlineSearch(input), expected);
  }
});
