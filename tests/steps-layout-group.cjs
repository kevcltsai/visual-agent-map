// Layout group P0 (ticket 22): spacing and the layout data contract. Pure functions only; no UI, no AI.
// Later packets of the group (down/up, balanced, radial, timeline, fishbone, per-branch) add their own cases to this file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const layout = load('map-layout.ts');
const nav = () => load('layouts/navigation.ts');
const geometry = load('experiences/visual-map/relation-geometry.ts');
const core = load('map-model.ts');

const WIDTH = 300;
const GAPS = { compact: 12, standard: 24, spacious: 48 };
const node = (id, parentId = null, extra = {}) => ({ id, parentId, path: `${id}.md`, x: 0, y: 0, collapsed: false, ...extra });
const snap = list => list.map(item => [item.id, item.x, item.y]);
const sample = () => require('../samples/taiwan-travel/compiled.json').locales['zh-TW'].nodes.map(item => ({ ...item }));
const sampleHeight = id => 60 + (id.length % 5) * 37;
const aim = (id, parentId, aimKind, converges) => node(id, parentId, { aimKind, ...(converges ? { aimConvergesFromNodeIds: converges } : {}) });
const converging = () => [
  aim('topic', null, 'topic'), aim('Q', 'topic', 'question'),
  aim('R1', 'Q', 'research'), aim('R2', 'Q', 'research'), aim('R3', 'Q', 'research'),
  aim('C', 'R3', 'conclusion', ['R1', 'R2', 'R3']), aim('Q2', 'C', 'question'),
  ...[1, 2, 3, 4].map(i => aim(`S${i}`, 'Q2', 'research')),
  aim('C2', 'S4', 'conclusion', ['S1', 'S2', 'S3', 'S4'])
];
const sized = () => [node('r'), node('a', 'r'), node('b', 'r'), node('c', 'r'), node('a1', 'a'), node('a2', 'a')];
const sizedHeight = id => ({ r: 70, a: 300, b: 60, c: 120, a1: 90 })[id];
/** One root, seven first-level topics with 0/1/5/2/8/0/3 children and card heights cycling through 120-260. */
const wide = () => {
  const nodes = [node('root')];
  [0, 1, 5, 2, 8, 0, 3].forEach((count, i) => {
    nodes.push(node(`t${i}`, 'root'));
    for (let k = 0; k < count; k++) nodes.push(node(`t${i}-${k}`, `t${i}`));
  });
  return nodes;
};
const wideHeight = (() => {
  const order = new Map(wide().map((item, index) => [item.id, index]));
  return id => 120 + ((order.get(id) * 35) % 141);
})();
const fixtures = () => ({
  sample: [sample(), undefined],
  sampleHeights: [sample(), sampleHeight],
  sized: [sized(), sizedHeight],
  converging: [converging(), undefined],
  wide: [wide(), wideHeight]
});

/** True when no two cards, each padded by `gap`, intersect; a card is WIDTH wide. */
function noOverlap(nodes, heightOf, gap) {
  const high = id => heightOf?.(id) ?? layout.DEFAULT_CARD_HEIGHT;
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (Math.abs(a.x - b.x) < WIDTH && a.y < b.y + high(b.id) + gap && b.y < a.y + high(a.id) + gap) return false;
    }
  return true;
}

const doc = extra => ({ version: 1, id: 'm', title: 'M', nodes: [node('a')], viewport: { x: 0, y: 0, zoom: 1 }, ...extra });
const plain = value => JSON.parse(JSON.stringify(value));
const roundTrip = value => core.parseMap(core.serializeMap(doc({ layout: value })));

test('S1: spacing compact and spacious survive a round trip; standard, huge and 3 are dropped', () => {
  for (const spacing of ['compact', 'spacious']) {
    for (const direction of ['right', 'left']) {
      assert.deepEqual(plain(roundTrip({ direction, spacing }).layout), { direction, spacing });
    }
  }
  for (const spacing of ['standard', 'huge', 3, null, {}, []]) {
    const parsed = roundTrip({ direction: 'left', spacing });
    assert.deepEqual(plain(parsed.layout), { direction: 'left' }, JSON.stringify(spacing));
  }
  // An invalid direction still removes the whole layout, spacing included.
  assert.equal('layout' in roundTrip({ direction: 'sideways', spacing: 'compact' }), false);
  assert.equal('layout' in roundTrip({ spacing: 'compact' }), false);
  // Every arrangement has an engine now, so parse accepts all eight; only unknown names are dropped.
  for (const direction of ['fishbone'])
    assert.deepEqual(plain(roundTrip({ direction, spacing: 'compact' }).layout), { direction, spacing: 'compact' }, direction);
  for (const direction of ['zigzag', 'RIGHT', 3, null, ['right']])
    assert.equal('layout' in roundTrip({ direction, spacing: 'compact' }), false, String(direction));
});

test('S2: passing {direction:"right"} gives the same coordinates as "right" and as no argument (the G0 golden)', () => {
  const golden = [['explore', 80, 641], ['constraints', 440, 182], ['budget', 800, 80], ['companions', 800, 284], ['transport', 440, 488], ['rail-car', 800, 488], ['food', 440, 692], ['nature', 440, 896], ['weather', 800, 896], ['lodging', 440, 1100], ['journey', 80, 1304], ['next', 440, 1304]];
  assert.deepEqual(snap(layout.arrangeMap(sample())), golden);
  assert.deepEqual(snap(layout.arrangeMap(sample(), undefined, undefined, { direction: 'right' })), golden);
  assert.deepEqual(snap(layout.arrangeMap(sample(), undefined, undefined, 'right')), golden);
  assert.deepEqual(snap(layout.arrangeMap(sample(), undefined, undefined, layout.layoutOf({}))), golden);
  const fresh = new Set(['transport', 'rail-car']);
  const viaString = snap(layout.arrangeNewBranch(sample(), 'explore', fresh, sampleHeight, 100, 'left'));
  assert.deepEqual(snap(layout.arrangeNewBranch(sample(), 'explore', fresh, sampleHeight, 100, { direction: 'left' })), viaString);
  const tree = new Set(['journey', 'next']);
  assert.deepEqual(
    snap(layout.arrangeNewTree(sample(), 'journey', tree, sampleHeight, { direction: 'left' })),
    snap(layout.arrangeNewTree(sample(), 'journey', tree, sampleHeight, 'left'))
  );
  assert.deepEqual(snap(layout.arrangeNewTree(sample(), 'journey', tree, sampleHeight, { direction: 'right', spacing: undefined })), snap(layout.arrangeNewTree(sample(), 'journey', tree, sampleHeight)));
});

const layoutOf = map => plain(layout.layoutOf(map));
test('S2b: layoutOf returns direction and stored spacing; AIM maps and bad values give right at standard spacing', () => {
  assert.deepEqual(layoutOf({}), { direction: 'right' });
  assert.deepEqual(layoutOf(null), { direction: 'right' });
  assert.deepEqual(layoutOf({ layout: { direction: 'left', spacing: 'compact' } }), { direction: 'left', spacing: 'compact' });
  assert.deepEqual(layoutOf({ layout: { direction: 'left', spacing: 'standard' } }), { direction: 'left' });
  assert.deepEqual(layoutOf({ layout: { direction: 'left', spacing: 'compact' }, aim: { version: 1 } }), { direction: 'right' });
  assert.deepEqual(layoutOf({ layout: { direction: 'radial', spacing: 'huge' } }), { direction: 'radial' });
  assert.deepEqual(layoutOf({ layout: { direction: 'fishbone', spacing: 'huge' } }), { direction: 'fishbone' });
  assert.deepEqual(layoutOf({ layout: { direction: 'balanced', spacing: 'huge' } }), { direction: 'balanced' });
  assert.equal(layout.layoutDirectionOf({ layout: { direction: 'left', spacing: 'compact' } }), 'left');
});

test('S3: right and left at three spacings never overlap on the sample, converging, sized and wide fixtures', () => {
  for (const [name, [nodes, heightOf]] of Object.entries(fixtures()))
    for (const direction of ['right', 'left'])
      for (const spacing of ['compact', 'standard', 'spacious']) {
        const placed = layout.arrangeMap(nodes, undefined, heightOf, { direction, spacing });
        assert.equal(placed.length, nodes.length);
        assert.ok(noOverlap(placed, heightOf, GAPS[spacing]), `${name} ${direction} ${spacing}`);
      }
});

test('S3b: new branch and new tree at each spacing keep older cards and do not overlap', () => {
  for (const direction of ['right', 'left'])
    for (const spacing of ['compact', 'standard', 'spacious']) {
      const spec = { direction, spacing };
      const base = layout.arrangeMap(wide().filter(item => !item.id.startsWith('t4')), undefined, wideHeight, spec);
      const withNew = [...base, ...wide().filter(item => item.id.startsWith('t4'))];
      const branch = layout.arrangeNewBranch(withNew, 'root', new Set(withNew.filter(item => item.id.startsWith('t4')).map(item => item.id)), wideHeight, undefined, spec);
      assert.deepEqual(snap(branch.filter(item => !item.id.startsWith('t4'))), snap(base), `${direction} ${spacing} older cards stay`);
      assert.ok(noOverlap(branch, wideHeight, GAPS[spacing]), `branch ${direction} ${spacing}`);
      const tree = layout.arrangeNewTree([...base, node('n'), node('n1', 'n')], 'n', new Set(['n', 'n1']), wideHeight, spec);
      assert.ok(noOverlap(tree, wideHeight, GAPS[spacing]), `tree ${direction} ${spacing}`);
    }
});

test('S4: compact column distance is below standard and spacious is above it', () => {
  const columnOf = spacing => {
    const placed = layout.arrangeMap([node('r'), node('c', 'r')], undefined, undefined, { direction: 'right', spacing });
    return placed[1].x - placed[0].x;
  };
  assert.equal(columnOf(undefined), 360);
  assert.equal(columnOf('standard'), 360);
  assert.ok(columnOf('compact') < 360 && columnOf('compact') === 330);
  assert.ok(columnOf('spacious') > 360 && columnOf('spacious') === 420);
  const rowOf = spacing => {
    const placed = layout.arrangeMap([node('r'), node('a', 'r'), node('b', 'r')], undefined, undefined, { direction: 'right', spacing });
    return placed[2].y - placed[1].y - layout.DEFAULT_CARD_HEIGHT;
  };
  assert.deepEqual([rowOf('compact'), rowOf(undefined), rowOf('spacious')], [12, 24, 48]);
  assert.equal(layout.LAYOUT_GAP, 24);
  const leftColumn = layout.arrangeMap([node('r', null), node('c', 'r')], undefined, undefined, { direction: 'left', spacing: 'compact' });
  assert.equal(leftColumn[0].x - leftColumn[1].x, 330);
});

// ---- P1 (ticket 20): down and up ----
const heightIn = (list, heightOf) => id => heightOf?.(id) ?? layout.DEFAULT_CARD_HEIGHT;
const depthOf = (list, id) => { const by = new Map(list.map(item => [item.id, item])); let d = 0; for (let n = by.get(id); n.parentId; n = by.get(n.parentId)) d++; return d; };
const SPACINGS = ['compact', 'standard', 'spacious'];
const plainTrees = () => ({ sample: [sample(), undefined], sampleHeights: [sample(), sampleHeight], sized: [sized(), sizedHeight], wide: [wide(), wideHeight] });

test('D-1: in a down map every child sits below its parent, and siblings spread along x', () => {
  for (const [name, [nodes, heightOf]] of Object.entries(plainTrees())) {
    const placed = layout.arrangeMap(nodes, undefined, heightOf, 'down');
    const by = new Map(placed.map(item => [item.id, item]));
    for (const item of placed) {
      if (!item.parentId) continue;
      const parent = by.get(item.parentId);
      assert.ok(item.y > parent.y, `${name} ${item.id} below ${parent.id}`);
      assert.ok(item.y >= parent.y + heightIn(nodes, heightOf)(parent.id), `${name} ${item.id} clears the parent card`);
    }
  }
  const pair = layout.arrangeMap([node('r'), node('a', 'r'), node('b', 'r')], undefined, undefined, { direction: 'down' });
  assert.ok(pair[1].x < pair[2].x && pair[1].y === pair[2].y);
  assert.equal(pair[0].x, (pair[1].x + pair[2].x) / 2, 'the parent is centred over its children');
});

test('D-2: cards of one level share the top edge in a down map, whatever their heights', () => {
  for (const [name, [nodes, heightOf]] of Object.entries(plainTrees())) {
    const placed = layout.arrangeMap(nodes, undefined, heightOf, { direction: 'down', spacing: 'compact' });
    const tops = new Map();
    for (const item of placed) {
      const level = depthOf(nodes, item.id);
      tops.set(level, [...(tops.get(level) ?? []), item.y]);
    }
    for (const [level, list] of tops) assert.equal(new Set(list).size, 1, `${name} level ${level}`);
    // Each row is as tall as its tallest card: the next level starts one gap below it.
    const high = heightIn(nodes, heightOf);
    const rowHeight = level => Math.max(...nodes.filter(item => depthOf(nodes, item.id) === level).map(item => high(item.id)));
    for (let level = 0; tops.has(level + 1); level++) assert.equal(tops.get(level + 1)[0] - tops.get(level)[0], rowHeight(level) + 30, `${name} row ${level}`);
  }
  // A tall card in the middle of a level does not move its neighbours' tops.
  const placed = layout.arrangeMap(sized(), undefined, sizedHeight, 'down');
  assert.equal(placed.find(item => item.id === 'a').y, placed.find(item => item.id === 'b').y);
});

test('D-3: up is the mirror image of down: same x, bottom edges aligned per level, y reflected', () => {
  for (const [name, [nodes, heightOf]] of Object.entries(plainTrees()))
    for (const spacing of SPACINGS) {
      const down = layout.arrangeMap(nodes, undefined, heightOf, { direction: 'down', spacing });
      const up = layout.arrangeMap(nodes, undefined, heightOf, { direction: 'up', spacing });
      const high = heightIn(nodes, heightOf);
      const sums = new Set(down.map((item, i) => item.y + high(item.id) + up[i].y));
      assert.equal(sums.size, 1, `${name} ${spacing} y mirrored`);
      assert.deepEqual(down.map(item => item.x), up.map(item => item.x), `${name} ${spacing} x equal`);
      const bottoms = new Map();
      for (const item of up) {
        const level = depthOf(nodes, item.id);
        bottoms.set(level, new Set([...(bottoms.get(level) ?? []), item.y + high(item.id)]));
      }
      for (const [level, set] of bottoms) assert.equal(set.size, 1, `${name} up level ${level} bottoms`);
      const by = new Map(up.map(item => [item.id, item]));
      for (const item of up) if (item.parentId) assert.ok(item.y + high(item.id) < by.get(item.parentId).y, `${name} child above parent`);
      assert.ok(Math.min(...up.map(item => item.y)) >= 0);
    }
});

test('D-4: down and up at three spacings never overlap, including converging joins, collapsed topics and new branches/trees', () => {
  for (const [name, [nodes, heightOf]] of Object.entries(fixtures()))
    for (const direction of ['down', 'up'])
      for (const spacing of SPACINGS) {
        const placed = layout.arrangeMap(nodes, undefined, heightOf, { direction, spacing });
        assert.equal(placed.length, nodes.length);
        assert.ok(noOverlap(placed, heightOf, GAPS[spacing]), `${name} ${direction} ${spacing}`);
        // The levels really run along y: the first level below the root shares one y (a right layout would not).
        const rootId = nodes.find(item => !item.parentId).id;
        const edge = item => (direction === 'down' ? item.y : item.y + heightIn(nodes, heightOf)(item.id));
        assert.equal(new Set(placed.filter(item => item.parentId === rootId).map(edge)).size, 1, `${name} ${direction} ${spacing} first level on one row`);
      }
  for (const direction of ['down', 'up'])
    for (const spacing of SPACINGS) {
      const spec = { direction, spacing };
      const folded = wide().map(item => ({ ...item, collapsed: item.id === 't4' }));
      const placed = layout.arrangeMap(folded, undefined, wideHeight, spec);
      assert.ok(noOverlap(placed.filter(item => !item.parentId || item.parentId !== 't4'), wideHeight, GAPS[spacing]), `folded ${direction} ${spacing}`);
      const base = layout.arrangeMap(wide().filter(item => !item.id.startsWith('t4')), undefined, wideHeight, spec);
      const withNew = [...base, ...wide().filter(item => item.id.startsWith('t4'))];
      const branch = layout.arrangeNewBranch(withNew, 'root', new Set(withNew.filter(item => item.id.startsWith('t4')).map(item => item.id)), wideHeight, undefined, spec);
      assert.deepEqual(snap(branch.filter(item => !item.id.startsWith('t4'))), snap(base), `${direction} ${spacing} older cards stay`);
      assert.ok(noOverlap(branch, wideHeight, GAPS[spacing]), `branch ${direction} ${spacing}`);
      const tree = layout.arrangeNewTree([...base, node('n'), node('n1', 'n')], 'n', new Set(['n', 'n1']), wideHeight, spec);
      assert.deepEqual(snap(tree.filter(item => item.id !== 'n' && item.id !== 'n1')), snap(base), `${direction} ${spacing} tree keeps old cards`);
      assert.ok(noOverlap(tree, wideHeight, GAPS[spacing]), `tree ${direction} ${spacing}`);
    }
});

const boxOf = (item, heightOf) => ({ x: item.x, y: item.y, width: WIDTH, height: heightIn([], heightOf)(item.id) });
const firstPoint = path => path.match(/^M (\S+) (\S+)/).slice(1).map(Number);
const lastPoint = path => path.match(/(\S+) (\S+)$/).slice(1).map(Number);

test('D-5: tree edges in a down map leave the parent bottom midpoint and enter the child top midpoint; up is reversed', () => {
  const parent = { x: 100, y: 50, width: 300, height: 120 };
  const child = { x: 40, y: 400, width: 300, height: 90 };
  assert.equal(geometry.treeEdgePathData(parent, child, 'down'), 'M 250 170 C 250 285, 190 285, 190 400');
  assert.equal(geometry.treeEdgePathData(parent, { ...child, y: 190 }, 'down'), 'M 250 170 C 250 230, 190 130, 190 190', 'a short run keeps arms of 60');
  const above = { x: 40, y: -300, width: 300, height: 90 };
  assert.equal(geometry.treeEdgePathData(parent, above, 'up'), 'M 250 50 C 250 -80, 190 -80, 190 -210');
  for (const [name, [nodes, heightOf]] of Object.entries(plainTrees())) {
    for (const direction of ['down', 'up']) {
      const placed = layout.arrangeMap(nodes, undefined, heightOf, direction);
      const by = new Map(placed.map(item => [item.id, boxOf(item, heightOf)]));
      for (const item of placed) {
        if (!item.parentId) continue;
        const p = by.get(item.parentId), c = by.get(item.id);
        const path = geometry.treeEdgePathData(p, c, direction);
        const [x1, y1] = firstPoint(path), [x2, y2] = lastPoint(path);
        assert.equal(x1, p.x + 150); assert.equal(x2, c.x + 150);
        assert.equal(y1, direction === 'down' ? p.y + p.height : p.y, `${name} ${direction} start`);
        assert.equal(y2, direction === 'down' ? c.y : c.y + c.height, `${name} ${direction} end`);
      }
    }
  }
});

test('D-6: relationPathData between cards two levels apart in a down map meets the bottom and top edges', () => {
  const chain = [node('r'), node('a', 'r'), node('b', 'a'), node('c', 'b'), node('r2'), node('s', 'r2'), node('t', 'r2'), node('s1', 's'), node('s2', 's'), node('t1', 't')];
  const chainHeight = id => 100 + (id.length * 53 + id.charCodeAt(0)) % 90;
  for (const spacing of SPACINGS)
    for (const direction of ['down', 'up']) {
      const placed = layout.arrangeMap(chain, undefined, chainHeight, { direction, spacing });
      const by = new Map(placed.map(item => [item.id, boxOf(item, chainHeight)]));
      for (const [from, to] of [['r', 'b'], ['r', 'c'], ['a', 'c'], ['r2', 's1'], ['r2', 't1']]) {
        const a = by.get(from), b = by.get(to);
        const path = geometry.relationPathData(a, b);
        const [x1, y1] = firstPoint(path), [x2, y2] = lastPoint(path);
        assert.equal(y1, direction === 'down' ? a.y + a.height : a.y, `${direction} ${spacing} ${from}->${to} leaves the facing edge`);
        assert.equal(y2, direction === 'down' ? b.y : b.y + b.height, `${direction} ${spacing} ${from}->${to} enters the facing edge`);
        assert.equal(x1, a.x + 150); assert.equal(x2, b.x + 150);
      }
    }
});

test('D-7: neighborKey maps arrow keys to parent, child or sibling for every direction', () => {
  const { neighborKey } = nav();
  const table = {
    right: { ArrowLeft: 'parent', ArrowRight: 'child', ArrowUp: 'sibling-', ArrowDown: 'sibling+' },
    left: { ArrowRight: 'parent', ArrowLeft: 'child', ArrowUp: 'sibling-', ArrowDown: 'sibling+' },
    down: { ArrowUp: 'parent', ArrowDown: 'child', ArrowLeft: 'sibling-', ArrowRight: 'sibling+' },
    up: { ArrowDown: 'parent', ArrowUp: 'child', ArrowLeft: 'sibling-', ArrowRight: 'sibling+' }
  };
  for (const [direction, keys] of Object.entries(table))
    for (const [key, expected] of Object.entries(keys)) assert.equal(neighborKey(direction, key), expected, `${direction} ${key}`);
  for (const direction of Object.keys(table)) for (const key of ['Enter', 'a', '', 'Home']) assert.equal(neighborKey(direction, key), null);
});

test('D-8: arrangeNewBranch in a down map starts one row below the parent (above it for up) and slides along x on a collision', () => {
  for (const spacing of SPACINGS) {
    const gapRow = { compact: 30, standard: 60, spacious: 120 }[spacing];
    const base = layout.arrangeMap([node('root'), node('a', 'root'), node('b', 'root')], undefined, sizedHeight, { direction: 'down', spacing });
    const root = base[0];
    const grown = [...base, node('n', 'root'), node('n1', 'n'), node('n2', 'n')];
    const fresh = new Set(['n', 'n1', 'n2']);
    const down = layout.arrangeNewBranch(grown, 'root', fresh, sizedHeight, undefined, { direction: 'down', spacing });
    const n = down.find(item => item.id === 'n');
    assert.equal(n.y, root.y + (sizedHeight('root') ?? 180) + gapRow, `${spacing} one row below the parent`);
    assert.ok(down.find(item => item.id === 'n1').y > n.y);
    assert.ok(noOverlap(down, sizedHeight, GAPS[spacing]), `${spacing} down no overlap`);
    const upBase = layout.arrangeMap([node('root'), node('a', 'root'), node('b', 'root')], undefined, sizedHeight, { direction: 'up', spacing });
    const up = layout.arrangeNewBranch([...upBase, node('n', 'root'), node('n1', 'n'), node('n2', 'n')], 'root', fresh, sizedHeight, undefined, { direction: 'up', spacing });
    const un = up.find(item => item.id === 'n');
    assert.equal(un.y + (sizedHeight('n') ?? 180) + gapRow, upBase[0].y, `${spacing} one row above the parent`);
    assert.ok(up.find(item => item.id === 'n1').y < un.y);
    assert.ok(noOverlap(up, sizedHeight, GAPS[spacing]), `${spacing} up no overlap`);
  }
  // The row below the parent is already taken by older cards: the new branch moves along x, never down onto them.
  const taken = [node('root', null, { x: 80, y: 80 }), node('old', 'root', { x: 80, y: 320 }), node('fresh', 'root')];
  const slid = layout.arrangeNewBranch(taken, 'root', new Set(['fresh']), undefined, undefined, 'down');
  const fresh = slid.find(item => item.id === 'fresh');
  assert.equal(fresh.y, 80 + layout.DEFAULT_CARD_HEIGHT + 60);
  assert.ok(fresh.x >= 80 + WIDTH + 24, 'moved to the right of the card that is in the way');
  assert.ok(noOverlap(slid, undefined, 24));
});

test('P1 data: down and up are stored and read back; layoutOf keeps them, layoutDirectionOf (right/left only) still answers right', () => {
  for (const direction of ['down', 'up'])
    for (const spacing of [undefined, 'compact', 'spacious']) {
      const value = spacing ? { direction, spacing } : { direction };
      assert.deepEqual(plain(roundTrip(value).layout), value);
      assert.deepEqual(layoutOf({ layout: value }), value);
      assert.deepEqual(layoutOf({ layout: value, aim: { version: 1 } }), { direction: 'right' });
    }
  assert.equal(layout.layoutDirectionOf({ layout: { direction: 'down' } }), 'right');
  assert.equal(layout.isLayoutDirection('down'), false);
  assert.equal(layout.isLayoutKind('up'), true);
  assert.equal(layout.isLayoutKind('balanced'), true);
  assert.equal(layout.isLayoutKind('radial'), true);
  assert.equal(layout.isLayoutKind('timeline'), true);
  assert.equal(layout.isLayoutKind('fishbone'), true);
  assert.equal(layout.isLayoutKind('zigzag'), false);
});

// ---- P2 (ticket 21): balanced ----
const sideOf = (list, id) => {
  const by = new Map(list.map(item => [item.id, item]));
  let n = by.get(id);
  while (n.parentId && by.get(n.parentId).parentId) n = by.get(n.parentId);
  const root = by.get(n.parentId);
  return n.x < root.x ? 'left' : 'right';
};
const subtreeIds = (list, id) => {
  const out = [id];
  for (const item of list) if (item.parentId === id) out.push(...subtreeIds(list, item.id));
  return out;
};
/** Vertical extent of the cards on one side of the root and of one first-level subtree. */
const extent = (list, ids, heightOf) => {
  const by = new Map(list.map(item => [item.id, item]));
  const high = heightIn(list, heightOf);
  const top = Math.min(...ids.map(id => by.get(id).y)), bottom = Math.max(...ids.map(id => by.get(id).y + high(id)));
  return bottom - top;
};
const sideHeights = (list, heightOf) => {
  const root = list.find(item => !item.parentId);
  const out = { left: [], right: [] };
  for (const kid of list.filter(item => item.parentId === root.id)) out[sideOf(list, kid.id)].push(...subtreeIds(list, kid.id));
  return { left: out.left.length ? extent(list, out.left, heightOf) : 0, right: out.right.length ? extent(list, out.right, heightOf) : 0, ids: out };
};
const balancedSpec = spacing => ({ direction: 'balanced', spacing });

test('B-1: the two sides differ in height by at most the tallest first-level subtree, at every spacing', () => {
  for (const spacing of SPACINGS) {
    const placed = layout.arrangeMap(wide(), undefined, wideHeight, balancedSpec(spacing));
    const heights = sideHeights(placed, wideHeight);
    assert.ok(heights.left > 0 && heights.right > 0, 'both sides are used');
    const tallest = Math.max(...placed.filter(item => item.parentId === 'root').map(kid => extent(placed, subtreeIds(placed, kid.id), wideHeight)));
    assert.ok(Math.abs(heights.left - heights.right) <= tallest, `${spacing} ${heights.left} vs ${heights.right} within ${tallest}`);
    const root = placed.find(item => item.id === 'root');
    const kidsTop = Math.min(...placed.filter(item => item.parentId === 'root').map(item => item.y));
    assert.ok(root.y >= kidsTop - 1, 'the root sits inside the span of its children');
  }
  const sampleSides = layout.arrangeMap(sample(), undefined, sampleHeight, 'balanced');
  assert.equal(sampleSides.length, 12);
});

test('B-2: every descendant of a first-level topic is on that topic\'s side of the root', () => {
  for (const [name, [nodes, heightOf]] of Object.entries(plainTrees()))
    for (const spacing of SPACINGS) {
      const placed = layout.arrangeMap(nodes, undefined, heightOf, balancedSpec(spacing));
      const roots = placed.filter(item => !item.parentId);
      if (name === 'wide') assert.equal(new Set(placed.filter(item => item.parentId === 'root').map(item => sideOf(placed, item.id))).size, 2, `${spacing} both sides are used`);
      for (const root of roots)
        for (const kid of placed.filter(item => item.parentId === root.id)) {
          const side = sideOf(placed, kid.id);
          for (const id of subtreeIds(placed, kid.id)) {
            assert.equal(sideOf(placed, id), side, `${name} ${spacing} ${id}`);
            const item = placed.find(entry => entry.id === id);
            assert.ok(side === 'left' ? item.x < root.x : item.x > root.x, `${name} ${spacing} ${id} clear of the root`);
          }
        }
    }
});

test('B-3: adding a last first-level topic and arranging again keeps the older branches on their sides', () => {
  for (const spacing of SPACINGS) {
    const spec = balancedSpec(spacing);
    const base = layout.arrangeMap(wide(), undefined, wideHeight, spec);
    const before = new Map(base.filter(item => item.parentId === 'root').map(item => [item.id, sideOf(base, item.id)]));
    assert.equal(new Set(before.values()).size, 2, `${spacing} both sides are used`);
    // The same topic list plus one more at the end, positions as the view leaves them (stale or at the origin).
    const grown = [...base, node('extra', 'root'), node('extra-1', 'extra')];
    const again = layout.arrangeMap(grown, undefined, wideHeight, spec);
    for (const [id, side] of before) assert.equal(sideOf(again, id), side, `${spacing} ${id}`);
    assert.ok(noOverlap(again, wideHeight, GAPS[spacing]), `${spacing} no overlap`);
    // Arranging a third time changes nothing.
    assert.deepEqual(snap(layout.arrangeMap(again, undefined, wideHeight, spec)), snap(again));
    // Dropping a middle topic does not move the others across either.
    const fewer = layout.arrangeMap(base.filter(item => !item.id.startsWith('t2')), undefined, wideHeight, spec);
    for (const [id, side] of before) if (!id.startsWith('t2')) assert.equal(sideOf(fewer, id), side, `${spacing} after removing t2: ${id}`);
  }
});

test('B-4: a new first-level topic goes to the shorter side, and a new sub-topic stays on its parent\'s side', () => {
  for (const spacing of SPACINGS) {
    const spec = balancedSpec(spacing);
    const base = layout.arrangeMap(wide(), undefined, wideHeight, spec);
    const heights = sideHeights(base, wideHeight);
    const shorter = heights.left < heights.right ? 'left' : 'right';
    const grown = [...base, node('extra', 'root'), node('extra-1', 'extra')];
    const placed = layout.arrangeNewBranch(grown, 'root', new Set(['extra', 'extra-1']), wideHeight, undefined, spec);
    assert.equal(sideOf(placed, 'extra'), shorter, `${spacing} shorter side`);
    assert.equal(sideOf(placed, 'extra-1'), shorter);
    assert.deepEqual(snap(placed.filter(item => !item.id.startsWith('extra'))), snap(base), `${spacing} older cards stay`);
    assert.ok(noOverlap(placed, wideHeight, GAPS[spacing]), `${spacing} no overlap`);
    // Sub-topics follow the side of the branch they hang under, whichever side that is.
    for (const side of ['left', 'right']) {
      const parentId = base.find(item => item.parentId === 'root' && sideOf(base, item.id) === side).id;
      const withSub = [...base, node('sub', parentId)];
      const subPlaced = layout.arrangeNewBranch(withSub, parentId, new Set(['sub']), wideHeight, undefined, spec);
      assert.equal(sideOf(subPlaced, 'sub'), side, `${spacing} sub-topic under a ${side} branch`);
      assert.ok(noOverlap(subPlaced, wideHeight, GAPS[spacing]), `${spacing} sub ${side} no overlap`);
    }
  }
  // A new tree beside an existing balanced one shares the root column and sits below.
  const base = layout.arrangeMap(wide(), undefined, wideHeight, 'balanced');
  const tree = layout.arrangeNewTree([...base, node('n'), node('n1', 'n'), node('n2', 'n')], 'n', new Set(['n', 'n1', 'n2']), wideHeight, 'balanced');
  assert.equal(tree.find(item => item.id === 'n').x, base.find(item => item.id === 'root').x);
  assert.deepEqual(snap(tree.filter(item => !item.id.startsWith('n'))), snap(base.filter(item => !item.id.startsWith('n'))));
  assert.ok(noOverlap(tree, wideHeight, 24));
  assert.notEqual(sideOf(tree, 'n1'), sideOf(tree, 'n2'), 'the new tree is itself balanced');
});

test('B-5: left-side edges leave the parent left edge and enter the child right edge; right-side edges are the right curves', () => {
  const parent = { x: 500, y: 100, width: 300, height: 120 };
  const leftChild = { x: 100, y: 300, width: 300, height: 90 };
  const rightChild = { x: 900, y: 300, width: 300, height: 90 };
  assert.equal(geometry.treeEdgePathData(parent, leftChild, 'balanced'), geometry.treeEdgePathData(parent, leftChild, 'left'));
  assert.equal(geometry.treeEdgePathData(parent, rightChild, 'balanced'), geometry.treeEdgePathData(parent, rightChild, 'right'));
  for (const [name, [nodes, heightOf]] of Object.entries(plainTrees())) {
    const placed = layout.arrangeMap(nodes, undefined, heightOf, 'balanced');
    const by = new Map(placed.map(item => [item.id, boxOf(item, heightOf)]));
    for (const item of placed) {
      if (!item.parentId) continue;
      const p = by.get(item.parentId), c = by.get(item.id);
      const path = geometry.treeEdgePathData(p, c, 'balanced');
      const [x1] = firstPoint(path), [x2] = lastPoint(path);
      if (c.x < p.x) { assert.equal(x1, p.x, `${name} ${item.id} leaves the left edge`); assert.equal(x2, c.x + c.width, `${name} ${item.id} ends on the right edge`); }
      else { assert.equal(x1, p.x + p.width, `${name} ${item.id} leaves the right edge`); assert.equal(x2, c.x, `${name} ${item.id} ends on the left edge`); }
    }
  }
});

test('B-6: balanced at three spacings never overlaps, including converging joins and collapsed topics', () => {
  for (const [name, [nodes, heightOf]] of Object.entries(fixtures()))
    for (const spacing of SPACINGS) {
      const placed = layout.arrangeMap(nodes, undefined, heightOf, balancedSpec(spacing));
      assert.equal(placed.length, nodes.length);
      assert.ok(noOverlap(placed, heightOf, GAPS[spacing]), `${name} ${spacing}`);
    }
  for (const spacing of SPACINGS) {
    const folded = wide().map(item => ({ ...item, collapsed: item.id === 't4' || item.id === 't2' }));
    const placed = layout.arrangeMap(folded, undefined, wideHeight, balancedSpec(spacing));
    assert.ok(noOverlap(placed.filter(item => item.parentId !== 't4' && item.parentId !== 't2'), wideHeight, GAPS[spacing]), `folded ${spacing}`);
    const two = [node('r1'), node('a', 'r1'), node('b', 'r1'), node('r2'), node('c', 'r2'), node('d', 'r2')];
    assert.ok(noOverlap(layout.arrangeMap(two, undefined, sizedHeight, balancedSpec(spacing)), sizedHeight, GAPS[spacing]), `two roots ${spacing}`);
  }
});

test('B-7: arrow keys in a balanced map: the root goes to the first child on that side, other cards follow their side', () => {
  const { neighborKey } = nav();
  assert.equal(neighborKey('balanced', 'ArrowRight', 'root'), 'child-right');
  assert.equal(neighborKey('balanced', 'ArrowLeft', 'root'), 'child-left');
  assert.equal(neighborKey('balanced', 'ArrowUp', 'root'), 'sibling-');
  assert.equal(neighborKey('balanced', 'ArrowDown', 'root'), 'sibling+');
  for (const key of ['Enter', 'a', '']) assert.equal(neighborKey('balanced', key, 'root'), null);
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    assert.equal(neighborKey('balanced', key, 'right'), neighborKey('right', key), `right side ${key}`);
    assert.equal(neighborKey('balanced', key, 'left'), neighborKey('left', key), `left side ${key}`);
  }
  // Without a side, balanced behaves like right (the other arrangements are unchanged).
  assert.equal(neighborKey('balanced', 'ArrowRight'), 'child');
  assert.equal(neighborKey('right', 'ArrowRight', 'root'), 'child');
});

test('B-8: balanced keeps the first-level kids of one root in order on each side, and single-child maps stay valid', () => {
  const placed = layout.arrangeMap(wide(), undefined, wideHeight, 'balanced');
  for (const side of ['left', 'right']) {
    const ys = placed.filter(item => item.parentId === 'root' && sideOf(placed, item.id) === side).map(item => item.y);
    assert.deepEqual(ys, [...ys].sort((a, b) => a - b), `${side} order`);
  }
  const single = layout.arrangeMap([node('r'), node('a', 'r')], undefined, undefined, 'balanced');
  assert.equal(single.length, 2);
  assert.ok(noOverlap(single, undefined, 24));
  assert.deepEqual(snap(layout.arrangeMap([], undefined, undefined, 'balanced')), []);
  assert.deepEqual(plain(roundTrip({ direction: 'balanced', spacing: 'compact' }).layout), { direction: 'balanced', spacing: 'compact' });
});

// ---- P3 (tickets 38, 39): radial and timeline ----
const radialSpec = spacing => ({ direction: 'radial', spacing });
const timelineSpec = spacing => ({ direction: 'timeline', spacing });
const centreOfCard = (item, heightOf) => ({ x: item.x + WIDTH / 2, y: item.y + heightIn([], heightOf)(item.id) / 2 });
/** Two roots (one with a collapsed topic) to cover stacking of several trees. */
const twoRoots = () => [...sized(), node('r2'), node('b1', 'r2'), node('b2', 'r2'), node('b3', 'r2'), node('b3x', 'b3')];
const twoRootsHeight = id => sizedHeight(id) ?? 100 + (id.length % 3) * 40;
const everyTree = () => ({ ...plainTrees(), converging: [converging(), undefined], twoRoots: [twoRoots(), twoRootsHeight] });
const leavesOf = (list, id) => { const kids = list.filter(item => item.parentId === id); return kids.length ? kids.reduce((sum, kid) => sum + leavesOf(list, kid.id), 0) : 1; };
const TAU = Math.PI * 2;
/** Clockwise angle from straight up, in [0, TAU), of a card centre around the root's centre. */
const angleAround = (centre, point) => (Math.atan2(point.x - centre.x, centre.y - point.y) + TAU) % TAU;

test('R-1: radial never overlaps on every fixture at three spacings, and is repeatable', () => {
  for (const spacing of SPACINGS)
    for (const [name, [nodes, heightOf]] of Object.entries(everyTree())) {
      const placed = layout.arrangeMap(nodes, undefined, heightOf, radialSpec(spacing));
      assert.equal(placed.length, nodes.length, name);
      assert.ok(placed.every(item => Number.isFinite(item.x) && Number.isFinite(item.y)), `${name} ${spacing} finite`);
      assert.ok(noOverlap(placed, heightOf, GAPS[spacing]), `${name} ${spacing}`);
      assert.deepEqual(snap(layout.arrangeMap(nodes, undefined, heightOf, radialSpec(spacing))), snap(placed), `${name} ${spacing} repeatable`);
      if (nodes.length > 2) assert.notDeepEqual(snap(placed), snap(layout.arrangeMap(nodes, undefined, heightOf, { direction: 'right', spacing })), `${name} ${spacing} is its own arrangement`);
    }
  // A collapsed topic is a leaf and its hidden cards keep their coordinates.
  const folded = wide().map(item => (item.id === 't4' ? { ...item, collapsed: true } : item));
  const hidden = new Set(folded.filter(item => item.parentId === 't4').map(item => item.id));
  const placed = layout.arrangeMap(folded, hidden, wideHeight, radialSpec('standard'));
  assert.ok(noOverlap(placed.filter(item => !hidden.has(item.id)), wideHeight, 24));
  for (const id of hidden) assert.deepEqual([placed.find(i => i.id === id).x, placed.find(i => i.id === id).y], [0, 0]);
  assert.deepEqual(snap(layout.arrangeMap([], undefined, undefined, 'radial')), []);
  assert.deepEqual(snap(layout.arrangeMap([node('r')], undefined, undefined, 'radial')), [['r', 80, 80]]);
});

test('R-1b: radial rings are at least a column apart and the cards of one depth share a ring around their root', () => {
  const placed = layout.arrangeMap(sample(), undefined, sampleHeight, radialSpec('standard'));
  const by = new Map(placed.map(item => [item.id, item]));
  const rootOf = item => { let n = item; while (n.parentId) n = by.get(n.parentId); return n; };
  const radius = item => { const c = centreOfCard(rootOf(item), sampleHeight), p = centreOfCard(item, sampleHeight); return Math.hypot(p.x - c.x, p.y - c.y); };
  assert.ok(placed.filter(item => !item.parentId).length >= 2, 'the sample has several roots');
  const rings = new Map();
  for (const item of placed) {
    if (!item.parentId) continue;
    const parentRadius = item.parentId === rootOf(item).id ? 0 : radius(by.get(item.parentId));
    assert.ok(radius(item) >= parentRadius + 360 - 2, `${item.id} is a ring beyond its parent`);
    const key = `${rootOf(item).id}:${depthOf(placed, item.id)}`, list = rings.get(key) ?? [];
    list.push(radius(item)); rings.set(key, list);
  }
  for (const [key, list] of rings) assert.ok(Math.max(...list) - Math.min(...list) <= 2, `${key} on one ring`);
});

test('R-5: radial growth takes a number of rounds that is logarithmic in the card count, not linear (ticket 38 perf)', () => {
  const radial = load('layouts/radial.ts');
  // One root, 20 topics, `per` details each, no height data (every card the same height), as in the P4 measurement.
  const run = per => {
    const tree = { id: 'root', kids: [] };
    let count = 1;
    for (let i = 0; i < 20; i++) {
      const topic = { id: `t${i}`, kids: [] };
      for (let k = 0; k < per; k++) { topic.kids.push({ id: `t${i}-${k}`, kids: [] }); count++; }
      tree.kids.push(topic);
      count++;
    }
    const stats = { rounds: 0, checks: 0 };
    const placed = radial.radialPositions({ roots: [tree], kidsOf: item => item.kids, joinsOf: () => [], heightFor: () => 110, width: WIDTH, column: 380, gap: 24, left: 80, top: 80, stats });
    return { count, stats, placed };
  };
  for (const per of [12, 24, 48]) {
    const { count, stats, placed } = run(per);
    assert.equal(placed.size, count);
    assert.ok(stats.rounds > 0 && stats.checks > 0, 'the engine reports the work it did');
    // The old fixed-step loop needed about 0.8 rounds per card (384 at 501 cards); doubling steps need about 18.
    assert.ok(stats.rounds <= 12 * Math.log2(count), `${count} cards took ${stats.rounds} rounds`);
    // The padded pair check stays far below comparing every pair in every round.
    assert.ok(stats.checks <= (count * count * stats.rounds) / 20, `${count} cards made ${stats.checks} checks`);
  }
});

test('R-2: the angle of a branch is proportional to its leaf count, clockwise from straight up', () => {
  for (const spacing of SPACINGS)
    for (const name of ['wide', 'sample', 'sized']) {
      const [nodes, heightOf] = plainTrees()[name];
      const placed = layout.arrangeMap(nodes, undefined, heightOf, radialSpec(spacing));
      const root = placed.find(item => !item.parentId);
      const centre = centreOfCard(root, heightOf);
      const topics = placed.filter(item => item.parentId === root.id);
      const total = topics.reduce((sum, topic) => sum + leavesOf(placed, topic.id), 0);
      let before = 0;
      for (const topic of topics) {
        const share = leavesOf(placed, topic.id);
        const expected = (TAU * (before + share / 2)) / total;
        const actual = angleAround(centre, centreOfCard(topic, heightOf));
        const off = Math.abs(((actual - expected + Math.PI * 3) % TAU) - Math.PI);
        assert.ok(off < 0.01, `${name} ${spacing} ${topic.id}: ${actual.toFixed(3)} vs ${expected.toFixed(3)}`);
        before += share;
      }
    }
  // Deeper: the children of one topic spread inside the topic's own slice, in proportion.
  const placed = layout.arrangeMap(wide(), undefined, wideHeight, radialSpec('standard'));
  const root = placed.find(item => item.id === 'root'), centre = centreOfCard(root, wideHeight);
  const total = leavesOf(placed, 'root');
  let before = 0;
  for (let i = 0; i < 7; i++) {
    const kids = placed.filter(item => item.parentId === `t${i}`);
    const share = leavesOf(placed, `t${i}`);
    kids.forEach((kid, k) => {
      const expected = (TAU * (before + k + 0.5)) / total;
      const actual = angleAround(centre, centreOfCard(kid, wideHeight));
      assert.ok(Math.abs(((actual - expected + Math.PI * 3) % TAU) - Math.PI) < 0.01, `t${i}-${k}`);
    });
    before += share;
  }
});

test('R-3: radial edges run between the nearest edge midpoints of parent and child', () => {
  const box = (x, y, height = 100) => ({ x, y, width: 300, height });
  const parent = box(500, 500);
  const cases = [
    [box(1000, 480), [800, 550], [1000, 530]], // right
    [box(0, 520), [500, 550], [300, 570]], // left
    [box(520, 100), [650, 500], [670, 200]], // above
    [box(480, 900), [650, 600], [630, 900]] // below
  ];
  for (const [child, from, to] of cases) {
    const path = geometry.treeEdgePathData(parent, child, 'radial');
    assert.deepEqual(firstPoint(path), from, 'start');
    assert.deepEqual(lastPoint(path), to, 'end');
  }
  assert.equal(geometry.treeEdgePathData(parent, box(1000, 480), 'radial'), geometry.relationPathData(parent, box(1000, 480)));
  for (const spacing of SPACINGS)
    for (const [name, [nodes, heightOf]] of Object.entries(plainTrees())) {
      const placed = layout.arrangeMap(nodes, undefined, heightOf, radialSpec(spacing));
      const by = new Map(placed.map(item => [item.id, boxOf(item, heightOf)]));
      for (const item of placed) {
        if (!item.parentId) continue;
        const p = by.get(item.parentId), c = by.get(item.id);
        const path = geometry.treeEdgePathData(p, c, 'radial');
        const hGap = Math.max(c.x - (p.x + p.width), p.x - (c.x + c.width));
        const vGap = Math.max(c.y - (p.y + p.height), p.y - (c.y + c.height));
        const [x1, y1] = firstPoint(path), [x2, y2] = lastPoint(path);
        const pc = { x: p.x + p.width / 2, y: p.y + p.height / 2 }, cc = { x: c.x + c.width / 2, y: c.y + c.height / 2 };
        if (hGap >= vGap) {
          assert.equal(x1, cc.x >= pc.x ? p.x + p.width : p.x, `${name} ${item.id} leaves a side edge`);
          assert.equal(x2, cc.x >= pc.x ? c.x : c.x + c.width, `${name} ${item.id} enters the facing side edge`);
          assert.equal(y1, pc.y); assert.equal(y2, cc.y);
        } else {
          assert.equal(y1, cc.y >= pc.y ? p.y + p.height : p.y, `${name} ${item.id} leaves a top or bottom edge`);
          assert.equal(y2, cc.y >= pc.y ? c.y : c.y + c.height, `${name} ${item.id} enters the facing edge`);
          assert.equal(x1, pc.x); assert.equal(x2, cc.x);
        }
      }
    }
});

test('R-4: radial and timeline are accepted by the data format; the other arrangements keep their curves', () => {
  for (const direction of ['radial', 'timeline'])
    for (const spacing of [undefined, 'compact', 'spacious']) {
      const value = spacing ? { direction, spacing } : { direction };
      assert.deepEqual(plain(roundTrip(value).layout), value);
      assert.deepEqual(layoutOf({ layout: value }), value);
      assert.deepEqual(layoutOf({ layout: value, aim: { version: 1 } }), { direction: 'right' });
    }
  assert.equal(layout.layoutDirectionOf({ layout: { direction: 'radial' } }), 'right');
  const a = { x: 0, y: 0, width: 300, height: 100 }, b = { x: 400, y: 200, width: 300, height: 100 };
  assert.notEqual(geometry.treeEdgePathData(a, b, 'radial'), geometry.treeEdgePathData(a, b, 'right'), 'radial has its own curve');
});

const topicsOf = (list, rootId = 'root') => list.filter(item => item.parentId === rootId);

test('T-1: timeline puts the root at the left end and the first-level topics left to right in array order', () => {
  for (const spacing of SPACINGS)
    for (const [name, [nodes, heightOf]] of Object.entries(everyTree())) {
      const placed = layout.arrangeMap(nodes, undefined, heightOf, timelineSpec(spacing));
      for (const root of placed.filter(item => !item.parentId)) {
        const topics = topicsOf(placed, root.id);
        let last = root.x;
        for (const topic of topics) {
          assert.ok(topic.x >= last + WIDTH, `${name} ${spacing} ${topic.id} is right of the previous card`);
          last = topic.x;
        }
        const axisTop = new Set([root, ...topics].map(item => item.y));
        assert.equal(axisTop.size, 1, `${name} ${spacing} axis cards share one top edge`);
      }
    }
  // Array order, not the old coordinates, decides: shuffle the array and the x order follows.
  const nodes = [node('root'), ...['t3', 't0', 't6'].map(id => node(id, 'root'))];
  const placed = layout.arrangeMap(nodes, undefined, undefined, 'timeline');
  assert.deepEqual(topicsOf(placed).sort((a, b) => a.x - b.x).map(item => item.id), ['t3', 't0', 't6']);
});

test('T-2: timeline details alternate below and above the axis, growing outward', () => {
  for (const spacing of SPACINGS)
    for (const [name, [nodes, heightOf]] of Object.entries(plainTrees())) {
      const placed = layout.arrangeMap(nodes, undefined, heightOf, timelineSpec(spacing));
      const by = new Map(placed.map(item => [item.id, item]));
      const high = heightIn([], heightOf);
      for (const root of placed.filter(item => !item.parentId))
        topicsOf(placed, root.id).forEach((topic, index) => {
          const down = index % 2 === 0;
          const stack = [];
          const walk = id => { for (const kid of placed.filter(item => item.parentId === id)) { stack.push(kid); walk(kid.id); } };
          walk(topic.id);
          for (const item of stack)
            if (down) assert.ok(item.y >= topic.y + high(topic.id), `${name} ${spacing} ${item.id} below ${topic.id}`);
            else assert.ok(item.y + high(item.id) <= topic.y, `${name} ${spacing} ${item.id} above ${topic.id}`);
          for (const item of stack) {
            const parent = by.get(item.parentId);
            if (parent.id === topic.id) continue;
            if (down) assert.ok(item.y >= parent.y + high(parent.id), `${name} ${item.id} further out than its parent`);
            else assert.ok(item.y + high(item.id) <= parent.y, `${name} ${item.id} further out than its parent`);
          }
        });
    }
});

test('T-4: timeline never overlaps on every fixture at three spacings, collapsed topics included', () => {
  for (const spacing of SPACINGS) {
    for (const [name, [nodes, heightOf]] of Object.entries(everyTree())) {
      const placed = layout.arrangeMap(nodes, undefined, heightOf, timelineSpec(spacing));
      assert.equal(placed.length, nodes.length);
      assert.ok(noOverlap(placed, heightOf, GAPS[spacing]), `${name} ${spacing}`);
      assert.deepEqual(snap(layout.arrangeMap(nodes, undefined, heightOf, timelineSpec(spacing))), snap(placed), `${name} ${spacing} repeatable`);
      if (nodes.length > 2) assert.notDeepEqual(snap(placed), snap(layout.arrangeMap(nodes, undefined, heightOf, { direction: 'right', spacing })), `${name} ${spacing} is its own arrangement`);
    }
    const folded = wide().map(item => (item.id === 't4' ? { ...item, collapsed: true } : item));
    const hidden = new Set(folded.filter(item => item.parentId === 't4').map(item => item.id));
    const placed = layout.arrangeMap(folded, hidden, wideHeight, timelineSpec(spacing));
    assert.ok(noOverlap(placed.filter(item => !hidden.has(item.id)), wideHeight, GAPS[spacing]));
  }
  // A larger spacing spreads the topics further apart.
  const x = spacing => layout.arrangeMap(wide(), undefined, wideHeight, timelineSpec(spacing)).find(item => item.id === 't6').x;
  assert.ok(x('compact') < x('standard') && x('standard') < x('spacious'));
  assert.deepEqual(snap(layout.arrangeMap([], undefined, undefined, 'timeline')), []);
});

const reorderIds = (list, rootId, movedId, dropX) => layout.reorderTopLevel(list, rootId, movedId, dropX).map(item => item.id);

test('T-3: reorderTopLevel moves a first-level topic to where dropX points and changes nothing else', () => {
  const placed = layout.arrangeMap(wide(), undefined, wideHeight, 'timeline');
  const before = placed.map(item => item.id);
  const topicIds = topicsOf(placed).map(item => item.id);
  const centres = Object.fromEntries(topicsOf(placed).map(item => [item.id, item.x + WIDTH / 2]));
  const orderOf = list => list.filter(item => topicIds.includes(item.id)).map(item => item.id);
  // Drop t0 past the centre of t3 and before the centre of t4.
  const out = layout.reorderTopLevel(placed, 'root', 't0', (centres.t3 + centres.t4) / 2);
  assert.deepEqual(orderOf(out), ['t1', 't2', 't3', 't0', 't4', 't5', 't6']);
  // Every non-topic card keeps its index, every card keeps its own coordinates, nothing is lost.
  placed.forEach((item, index) => { if (!topicIds.includes(item.id)) assert.equal(out[index].id, item.id, `index ${index}`); });
  assert.deepEqual([...out.map(item => item.id)].sort(), [...before].sort());
  for (const item of out) assert.equal(item, placed.find(other => other.id === item.id), 'same object');
  // Dropping far left puts it first, far right last, near its own place changes nothing.
  assert.deepEqual(orderOf(layout.reorderTopLevel(placed, 'root', 't4', -9999)), ['t4', 't0', 't1', 't2', 't3', 't5', 't6']);
  assert.deepEqual(orderOf(layout.reorderTopLevel(placed, 'root', 't2', 99999)), ['t0', 't1', 't3', 't4', 't5', 't6', 't2']);
  assert.deepEqual(orderOf(layout.reorderTopLevel(placed, 'root', 't2', centres.t2 + 20)), topicIds);
  // The input array is not modified.
  assert.deepEqual(placed.map(item => item.id), before);
  // The moved topic keeps its own subtree: after a re-arrange its children follow it.
  const again = layout.arrangeMap(out, undefined, wideHeight, 'timeline');
  const t0 = again.find(item => item.id === 't0');
  assert.ok(t0.x > again.find(item => item.id === 't3').x && t0.x < again.find(item => item.id === 't4').x);
  // Invalid requests change nothing: unknown ids, a deeper card, the root itself, a non-finite drop.
  for (const args of [['root', 'nope', 0], ['nope', 't1', 0], ['root', 't0-0', 0], ['root', 'root', 0], ['root', 't1', NaN], ['root', 't1', Infinity]])
    assert.deepEqual(reorderIds(placed, ...args), before, args.join());
  // Only the named root's topics are involved: a second root keeps its order.
  const two = layout.arrangeMap(twoRoots(), undefined, twoRootsHeight, 'timeline');
  const outTwo = layout.reorderTopLevel(two, 'r', 'c', -9999);
  assert.deepEqual(topicsOf(outTwo, 'r').map(item => item.id), ['c', 'a', 'b']);
  assert.deepEqual(topicsOf(outTwo, 'r2').map(item => item.id), ['b1', 'b2', 'b3']);
  assert.deepEqual(outTwo.filter(item => !['a', 'b', 'c'].includes(item.id)).map(item => item.id), two.filter(item => !['a', 'b', 'c'].includes(item.id)).map(item => item.id));
});

test('D5: adding topics to a radial or timeline map re-arranges the whole map without overlap, keeping the first root in place', () => {
  for (const kind of ['radial', 'timeline'])
    for (const spacing of SPACINGS) {
      const spec = { direction: kind, spacing };
      const base = layout.arrangeMap(wide(), undefined, wideHeight, spec);
      const grown = [...base, node('n1', 'root'), node('n2', 'root'), node('n1a', 'n1')];
      const heightOf = id => wideHeight(id) ?? 150;
      const out = layout.arrangeNewBranch(grown, 'root', new Set(['n1', 'n2', 'n1a']), heightOf, undefined, spec);
      assert.equal(out.length, grown.length);
      assert.ok(noOverlap(out, heightOf, GAPS[spacing]), `${kind} ${spacing}`);
      const root = (list) => list.find(item => item.id === 'root');
      assert.deepEqual([root(out).x, root(out).y], [root(base).x, root(base).y], `${kind} ${spacing} root stays`);
      // Hand-dragged positions are reset by the re-arrange (D5).
      const dragged = grown.map(item => (item.id === 't2' ? { ...item, x: 9000, y: 9000 } : item));
      const reset = layout.arrangeNewBranch(dragged, 'root', new Set(['n1', 'n2', 'n1a']), heightOf, undefined, spec);
      assert.deepEqual(snap(reset), snap(out), `${kind} ${spacing} dragged positions are reset`);
      // A new top-level tree goes below everything and nothing moves.
      const tree = [...base, node('z'), node('z1', 'z')];
      const placed = layout.arrangeNewTree(tree, 'z', new Set(['z', 'z1']), heightOf, spec);
      assert.ok(noOverlap(placed, heightOf, GAPS[spacing]), `${kind} ${spacing} new tree`);
      for (const item of base) assert.deepEqual([placed.find(o => o.id === item.id).x, placed.find(o => o.id === item.id).y], [item.x, item.y]);
    }
});

test('P3 navigation: radial and timeline arrow keys follow the right layout', () => {
  const { neighborKey } = nav();
  for (const direction of ['radial', 'timeline'])
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])
      assert.equal(neighborKey(direction, key), neighborKey('right', key), `${direction} ${key}`);
});

// ---- P4 (ticket 40): fishbone ----
const fishSpec = spacing => ({ direction: 'fishbone', spacing });
const K = 1 / Math.tan(Math.PI / 3);
const rootsOf = list => list.filter(item => !item.parentId);
const centreY = (item, heightOf) => item.y + heightIn([], heightOf)(item.id) / 2;
const treeOf = (list, rootId) => { const by = new Map(list.map(item => [item.id, item])); return list.filter(item => { let n = item; while (n.parentId) n = by.get(n.parentId); return n.id === rootId; }); };

test('F-1: fishbone never overlaps on every fixture at three spacings, is repeatable, and has the head at the right end', () => {
  for (const spacing of SPACINGS)
    for (const [name, [nodes, heightOf]] of Object.entries(everyTree())) {
      const placed = layout.arrangeMap(nodes, undefined, heightOf, fishSpec(spacing));
      assert.equal(placed.length, nodes.length, name);
      assert.ok(placed.every(item => Number.isFinite(item.x) && Number.isFinite(item.y)), `${name} ${spacing} finite`);
      assert.ok(noOverlap(placed, heightOf, GAPS[spacing]), `${name} ${spacing}`);
      assert.deepEqual(snap(layout.arrangeMap(nodes, undefined, heightOf, fishSpec(spacing))), snap(placed), `${name} ${spacing} repeatable`);
      if (nodes.length > 2) assert.notDeepEqual(snap(placed), snap(layout.arrangeMap(nodes, undefined, heightOf, { direction: 'right', spacing })), `${name} ${spacing} is its own arrangement`);
      const heads = rootsOf(placed);
      assert.equal(new Set(heads.map(item => item.x)).size, 1, `${name} ${spacing} heads share one x`);
      for (const head of heads) {
        const own = treeOf(placed, head.id);
        for (const item of own) if (item.id !== head.id) assert.ok(item.x + WIDTH <= head.x, `${name} ${spacing} ${item.id} is left of the head`);
        // The first-level topics alternate above and below the spine, the first one above.
        const topics = placed.filter(item => item.parentId === head.id);
        topics.forEach((topic, index) => {
          const above = centreY(topic, heightOf) < centreY(head, heightOf);
          assert.equal(above, index % 2 === 0, `${name} ${spacing} ${topic.id} side`);
        });
        // Each side is far enough from the spine that the topics never sit on it.
        for (const item of own) if (item.id !== head.id) assert.ok(item.y + heightIn([], heightOf)(item.id) <= centreY(head, heightOf) || item.y >= centreY(head, heightOf), `${name} ${spacing} ${item.id} clears the spine`);
      }
    }
  assert.deepEqual(snap(layout.arrangeMap([], undefined, undefined, 'fishbone')), []);
  assert.deepEqual(snap(layout.arrangeMap([node('r')], undefined, undefined, 'fishbone')), [['r', 80, 80]]);
  const folded = wide().map(item => (item.id === 't4' ? { ...item, collapsed: true } : item));
  const hidden = new Set(folded.filter(item => item.parentId === 't4').map(item => item.id));
  const placed = layout.arrangeMap(folded, hidden, wideHeight, fishSpec('standard'));
  assert.ok(noOverlap(placed.filter(item => !hidden.has(item.id)), wideHeight, 24));
  for (const id of hidden) assert.deepEqual([placed.find(i => i.id === id).x, placed.find(i => i.id === id).y], [0, 0]);
});

test('F-1b: adding topics to a fishbone map re-arranges the whole map without overlap and keeps the first root in place', () => {
  for (const spacing of SPACINGS) {
    const spec = fishSpec(spacing);
    const base = layout.arrangeMap(wide(), undefined, wideHeight, spec);
    const grown = [...base, node('n1', 'root'), node('n2', 'root'), node('n1a', 'n1')];
    const heightOf = id => wideHeight(id) ?? 150;
    const out = layout.arrangeNewBranch(grown, 'root', new Set(['n1', 'n2', 'n1a']), heightOf, undefined, spec);
    assert.equal(out.length, grown.length);
    assert.ok(noOverlap(out, heightOf, GAPS[spacing]), spacing);
    const rootOf = list => list.find(item => item.id === 'root');
    assert.deepEqual([rootOf(out).x, rootOf(out).y], [rootOf(base).x, rootOf(base).y], `${spacing} root stays`);
    assert.notDeepEqual(snap(out.filter(item => base.some(b => b.id === item.id))), snap(base), `${spacing} older cards were arranged again`);
    const tree = [...base, node('z'), node('z1', 'z')];
    const placed = layout.arrangeNewTree(tree, 'z', new Set(['z', 'z1']), heightOf, spec);
    assert.ok(noOverlap(placed, heightOf, GAPS[spacing]), `${spacing} new tree`);
    for (const item of base) assert.deepEqual([placed.find(o => o.id === item.id).x, placed.find(o => o.id === item.id).y], [item.x, item.y]);
  }
});

test('F-2: fishbone bones are 60 degree straight lines from the topic card edge midpoint to the spine; ribs run from the bone to the detail card edge midpoint', () => {
  const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-6, `${message}: ${a} vs ${b}`);
  for (const spacing of SPACINGS)
    for (const [name, [nodes, heightOf]] of Object.entries(everyTree())) {
      const placed = layout.arrangeMap(nodes, undefined, heightOf, fishSpec(spacing));
      const by = new Map(placed.map(item => [item.id, boxOf(item, heightOf)]));
      const bone = new Map();
      for (const item of placed) {
        if (!item.parentId) continue;
        const p = by.get(item.parentId), c = by.get(item.id);
        const parentItem = placed.find(o => o.id === item.parentId);
        const depth = depthOf(placed, item.id);
        const path = geometry.treeEdgePathData(p, c, 'fishbone', depth);
        const label = `${name} ${spacing} ${item.id}`;
        if (depth === 1) {
          assert.match(path, /^M \S+ \S+ L \S+ \S+$/, label);
          const [jx, jy] = firstPoint(path), [ax, ay] = lastPoint(path);
          const above = c.y + c.height / 2 < p.y + p.height / 2;
          near(jy, p.y + p.height / 2, `${label} joint is on the spine`);
          assert.ok(jx <= p.x, `${label} joint is left of the head`);
          near(ax, c.x + c.width / 2, `${label} bone meets the card edge midpoint x`);
          near(ay, above ? c.y + c.height : c.y, `${label} bone meets the card edge midpoint y`);
          near(Math.abs(jy - ay) / Math.abs(jx - ax), Math.tan(Math.PI / 3), `${label} slope`);
          assert.ok(jx > ax, `${label} the bone leans toward the head`);
          bone.set(item.id, { jx, jy, ax, ay });
        } else if (depth === 2) {
          const { jx, jy, ax, ay } = bone.get(parentItem.id);
          const [sx, sy] = firstPoint(path), [ex, ey] = lastPoint(path);
          assert.match(path, /^M \S+ \S+ L \S+ \S+$/, label);
          near(ex, c.x + c.width, `${label} rib meets the card right edge`);
          near(ey, c.y + c.height / 2, `${label} rib meets the card edge midpoint`);
          near(sy, ey, `${label} rib is horizontal`);
          // The rib starts on the bone: the point lies on the segment from the topic card to the spine joint.
          near((sx - ax) * (jy - ay), (sy - ay) * (jx - ax), `${label} rib starts on the bone line`);
          assert.ok(sy >= Math.min(ay, jy) - 1e-6 && sy <= Math.max(ay, jy) + 1e-6, `${label} rib starts within the bone`);
          assert.ok(sx > ex, `${label} rib has length`);
        } else assert.equal(path, geometry.treeEdgePathData(p, c, 'left'), `${label} deeper edges curve to the left`);
      }
    }
});

test('P4 data: fishbone is stored and read back; the AIM map and layoutDirectionOf still answer right; arrow keys follow the right layout', () => {
  for (const spacing of [undefined, 'compact', 'spacious']) {
    const value = spacing ? { direction: 'fishbone', spacing } : { direction: 'fishbone' };
    assert.deepEqual(plain(roundTrip(value).layout), value);
    assert.deepEqual(layoutOf({ layout: value }), value);
    assert.deepEqual(layoutOf({ layout: value, aim: { version: 1 } }), { direction: 'right' });
  }
  assert.equal(layout.layoutDirectionOf({ layout: { direction: 'fishbone' } }), 'right');
  const { neighborKey } = nav();
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])
    assert.equal(neighborKey('fishbone', key), neighborKey('right', key), key);
});

// ---- P4 (ticket 41): per-branch layout ----
const withLayout = (list, id, direction) => list.map(item => (item.id === id ? { ...item, layout: { direction } } : item));
const without = list => list.map(({ layout: _unused, ...rest }) => rest);
/** The first-level topic with the most cards below it, which makes the biggest block. */
const bigTopic = list => {
  const root = rootsOf(list)[0];
  return list.filter(item => item.parentId === root.id).map(item => [item, subtreeIds(list, item.id).length]).sort((a, b) => b[1] - a[1])[0][0];
};
const COLUMNS = { compact: 330, standard: 360, spacious: 420 };
const boundsOf = (list, ids, heightOf) => {
  const by = new Map(list.map(item => [item.id, item]));
  const high = heightIn(list, heightOf);
  const cards = ids.map(id => by.get(id));
  return { left: Math.min(...cards.map(c => c.x)), right: Math.max(...cards.map(c => c.x + WIDTH)), top: Math.min(...cards.map(c => c.y)), bottom: Math.max(...cards.map(c => c.y + high(c.id))) };
};

test('C-1: a down branch in a right map lies under its head without overlapping, and the block starts one column right of the parent', () => {
  for (const spacing of SPACINGS)
    for (const [name, [nodes, heightOf]] of Object.entries({ wide: [wide(), wideHeight], sample: [sample(), sampleHeight], sized: [sized(), sizedHeight] })) {
      const head = bigTopic(nodes);
      const spec = { direction: 'right', spacing };
      const plainOut = layout.arrangeMap(nodes, undefined, heightOf, spec);
      const out = layout.arrangeMap(withLayout(nodes, head.id, 'down'), undefined, heightOf, spec);
      const label = `${name} ${spacing}`;
      assert.ok(noOverlap(out, heightOf, GAPS[spacing]), label);
      assert.notDeepEqual(snap(out), snap(plainOut), `${label} the override changes the arrangement`);
      const by = new Map(out.map(item => [item.id, item]));
      const block = subtreeIds(out, head.id);
      for (const item of out) if (item.parentId === head.id) assert.ok(item.y > by.get(head.id).y, `${label} ${item.id} is below the head`);
      const box = boundsOf(out, block, heightOf);
      const parent = by.get(head.parentId);
      assert.equal(box.left, parent.x + COLUMNS[spacing], `${label} block starts at the column right of the parent`);
      // Cards outside the block keep the right layout: column by depth.
      for (const item of out) if (!block.includes(item.id)) assert.equal(item.x, 80 + depthOf(out, item.id) * COLUMNS[spacing], `${label} ${item.id}`);
    }
});

test('C-1b: every map direction with every branch direction (not the opposite one) never overlaps; nested overrides too', () => {
  const opposite = { right: 'left', left: 'right', down: 'up', up: 'down' };
  for (const spacing of SPACINGS)
    for (const mapDirection of ['right', 'left', 'down', 'up'])
      for (const branch of ['right', 'left', 'down', 'up'].filter(d => d !== opposite[mapDirection]))
        for (const [name, [nodes, heightOf]] of Object.entries({ wide: [wide(), wideHeight], sample: [sample(), sampleHeight], sized: [sized(), sizedHeight], converging: [converging(), undefined] })) {
          const head = bigTopic(nodes);
          const spec = { direction: mapDirection, spacing };
          const out = layout.arrangeMap(withLayout(nodes, head.id, branch), undefined, heightOf, spec);
          assert.equal(out.length, nodes.length);
          assert.ok(noOverlap(out, heightOf, GAPS[spacing]), `${name} ${mapDirection}+${branch} ${spacing}`);
          if (branch !== mapDirection) assert.notDeepEqual(snap(out), snap(layout.arrangeMap(nodes, undefined, heightOf, spec)), `${name} ${mapDirection}+${branch} ${spacing} the override takes effect`);
          // A nested override: a deeper branch inside the block turns the other way.
          const inner = nodes.find(item => item.parentId === head.id && nodes.some(o => o.parentId === item.id));
          if (inner) {
            const turn = ['right', 'down'].includes(branch) ? 'down' : 'up';
            const nested = layout.arrangeMap(withLayout(withLayout(nodes, head.id, branch), inner.id, turn === branch ? 'right' : turn), undefined, heightOf, spec);
            assert.ok(noOverlap(nested, heightOf, GAPS[spacing]), `${name} ${mapDirection}+${branch}+nested ${spacing}`);
          }
        }
  // Two sibling branches with different directions, and an override on a branch of a second root.
  const nodes = twoRoots();
  const set = withLayout(withLayout(withLayout(nodes, 'a', 'down'), 'c', 'up'), 'b3', 'left');
  for (const spacing of SPACINGS) assert.ok(noOverlap(layout.arrangeMap(set, undefined, twoRootsHeight, { direction: 'right', spacing }), twoRootsHeight, GAPS[spacing]), spacing);
});

test('C-2: an up branch on the left half of a balanced map stays on the left, above its head, without overlap', () => {
  for (const spacing of SPACINGS) {
    const spec = balancedSpec(spacing);
    const base = layout.arrangeMap(wide(), undefined, wideHeight, spec);
    const root = base.find(item => item.id === 'root');
    const lefts = base.filter(item => item.parentId === 'root' && item.x < root.x);
    assert.ok(lefts.length, 'there is a left side');
    const head = lefts.map(item => [item, subtreeIds(base, item.id).length]).sort((a, b) => b[1] - a[1])[0][0];
    const out = layout.arrangeMap(withLayout(base, head.id, 'up'), undefined, wideHeight, spec);
    assert.ok(noOverlap(out, wideHeight, GAPS[spacing]), spacing);
    const by = new Map(out.map(item => [item.id, item]));
    const block = subtreeIds(out, head.id);
    const box = boundsOf(out, block, wideHeight);
    assert.equal(box.right, by.get('root').x - COLUMNS[spacing] + WIDTH, `${spacing} the block ends at the column left of the root`);
    for (const item of out) if (item.parentId === head.id) assert.ok(item.y < by.get(head.id).y, `${spacing} ${item.id} is above the head`);
    const sidesAfter = out.filter(item => item.parentId === 'root').map(item => item.x < by.get('root').x ? 'left' : 'right');
    assert.deepEqual(sidesAfter, base.filter(item => item.parentId === 'root').map(item => item.x < root.x ? 'left' : 'right'), `${spacing} no topic changes side`);
    // The same on the right half, with a down branch.
    const rights = base.filter(item => item.parentId === 'root' && item.x > root.x);
    const rhead = rights[0];
    const down = layout.arrangeMap(withLayout(base, rhead.id, 'down'), undefined, wideHeight, spec);
    assert.ok(noOverlap(down, wideHeight, GAPS[spacing]), `${spacing} right half down`);
  }
});

test('C-3: removing the override and arranging again gives exactly the arrangement without it', () => {
  for (const spacing of SPACINGS)
    for (const mapDirection of ['right', 'left', 'down', 'up']) {
      const spec = { direction: mapDirection, spacing };
      const head = bigTopic(wide());
      const baseline = layout.arrangeMap(wide(), undefined, wideHeight, spec);
      const direction = mapDirection === 'right' || mapDirection === 'left' ? 'down' : 'right';
      const overridden = layout.arrangeMap(withLayout(wide(), head.id, direction), undefined, wideHeight, spec);
      assert.notDeepEqual(snap(overridden), snap(baseline), `${mapDirection} ${spacing} the override takes effect`);
      assert.deepEqual(snap(layout.arrangeMap(without(overridden), undefined, wideHeight, spec)), snap(baseline), `${mapDirection} ${spacing}`);
    }
  // Radial, timeline and fishbone maps ignore overrides (decision D9).
  for (const direction of ['radial', 'timeline', 'fishbone']) {
    const head = bigTopic(wide());
    assert.deepEqual(snap(layout.arrangeMap(withLayout(wide(), head.id, 'down'), undefined, wideHeight, direction)), snap(layout.arrangeMap(wide(), undefined, wideHeight, direction)), direction);
  }
});

test('C-4: parseMap deletes a node layout that is not one of right, left, down or up, sits on a root, or points opposite its parent', () => {
  const parse = (nodes, extra = {}) => {
    const out = core.parseMap(core.serializeMap(doc({ nodes, ...extra })));
    return Object.fromEntries(out.nodes.map(item => [item.id, item.layout]));
  };
  const tree = overrides => [node('r', null, overrides.r ? { layout: overrides.r } : {}), ...['a', 'b', 'c'].map(id => node(id, 'r', overrides[id] ? { layout: overrides[id] } : {})), node('a1', 'a', overrides.a1 ? { layout: overrides.a1 } : {})];
  // Invalid values.
  for (const bad of [{ direction: 'radial' }, { direction: 'timeline' }, { direction: 'fishbone' }, { direction: 'balanced' }, { direction: 'sideways' }, { direction: 3 }, { spacing: 'compact' }, {}, 3, 'down', [], [{ direction: 'down' }], null, true])
    assert.equal(parse(tree({ a: bad })).a, undefined, JSON.stringify(bad));
  // Valid values stay; stray keys inside are dropped.
  for (const direction of ['right', 'left', 'down', 'up']) assert.deepEqual(plain(parse(tree({ a: { direction } }), { layout: { direction: 'balanced' } }).a), { direction }, direction);
  assert.deepEqual(plain(parse(tree({ a: { direction: 'down', spacing: 'compact', extra: 1 } })).a), { direction: 'down' });
  // A root has no branch layout.
  assert.equal(parse(tree({ r: { direction: 'down' } })).r, undefined);
  // The opposite of the parent's direction is deleted; the same direction and the sideways ones stay.
  const opposite = { right: 'left', left: 'right', down: 'up', up: 'down' };
  for (const mapDirection of ['right', 'left', 'down', 'up']) {
    const parsed = parse(tree({ a: { direction: opposite[mapDirection] }, b: { direction: mapDirection }, c: { direction: mapDirection === 'right' || mapDirection === 'left' ? 'down' : 'right' } }), { layout: { direction: mapDirection } });
    assert.equal(parsed.a, undefined, `${mapDirection} opposite`);
    assert.deepEqual(plain(parsed.b), { direction: mapDirection }, `${mapDirection} same`);
    assert.ok(parsed.c, `${mapDirection} sideways`);
  }
  // A map without a stored layout is a right map.
  assert.equal(parse(tree({ a: { direction: 'left' } })).a, undefined);
  // The parent's direction is the nearest override above: under a down branch, up is opposite and right is not.
  const nested = parse(tree({ a: { direction: 'down' }, a1: { direction: 'up' } }));
  assert.deepEqual(plain(nested.a), { direction: 'down' });
  assert.equal(nested.a1, undefined);
  assert.deepEqual(plain(parse(tree({ a: { direction: 'down' }, a1: { direction: 'right' } })).a1), { direction: 'right' });
  // An override that was deleted does not decide for its children: the child of a deleted 'left' still follows the map.
  assert.equal(parse(tree({ a: { direction: 'left' }, a1: { direction: 'left' } })).a1, undefined);
  // In a balanced map the opposite is the other way than the topic's side; a topic near the root has no side yet.
  const sided = (x, direction) => [node('r', null, { x: 1000 }), node('a', 'r', { x, layout: { direction } }), node('a1', 'a', { x: x + (x > 1000 ? 360 : -360) })];
  const sidedParse = (x, direction) => core.parseMap(core.serializeMap(doc({ nodes: sided(x, direction), layout: { direction: 'balanced' } }))).nodes[1].layout;
  assert.equal(sidedParse(1400, 'left'), undefined, 'right half: left is opposite');
  assert.deepEqual(plain(sidedParse(1400, 'right')), { direction: 'right' });
  assert.equal(sidedParse(600, 'right'), undefined, 'left half: right is opposite');
  assert.deepEqual(plain(sidedParse(600, 'up')), { direction: 'up' });
  assert.deepEqual(plain(sidedParse(1050, 'left')), { direction: 'left' }, 'a topic that is too close to the root has no side');
  // Radial, timeline and fishbone maps keep valid values (ignored when arranging) and skip the opposite check.
  for (const direction of ['radial', 'timeline', 'fishbone'])
    assert.deepEqual(plain(parse(tree({ a: { direction: 'left' } }), { layout: { direction } }).a), { direction: 'left' }, direction);
  // The map-level check is as strict as before.
  assert.equal('layout' in roundTrip({ direction: 'zigzag' }), false);
});

test('C-5: layoutDirectionFor finds the nearest branch override above a card, the card itself included', () => {
  const nodes = withLayout(withLayout([node('r'), node('a', 'r'), node('a1', 'a'), node('a1x', 'a1'), node('b', 'r'), node('b1', 'b')], 'a', 'down'), 'a1', 'left');
  const dir = (id, mapDirection = 'right') => layout.layoutDirectionFor(nodes, id, mapDirection);
  assert.equal(dir('r'), 'right');
  assert.equal(dir('b'), 'right');
  assert.equal(dir('b1', 'balanced'), 'balanced');
  assert.equal(dir('a'), 'down', 'the head grows in its own direction');
  assert.equal(dir('a1'), 'left', 'the nearest override wins');
  assert.equal(dir('a1x'), 'left');
  assert.equal(dir('missing'), 'right');
  for (const mapDirection of ['radial', 'timeline', 'fishbone']) assert.equal(dir('a1x', mapDirection), mapDirection, mapDirection);
  // A root never carries an override, and a cycle does not hang.
  assert.equal(layout.layoutDirectionFor(withLayout([node('r')], 'r', 'down'), 'r', 'right'), 'right');
  const cyc = withLayout([node('x', 'y'), node('y', 'x')], 'x', 'up');
  assert.equal(layout.layoutDirectionFor(cyc, 'y', 'right'), 'up');
  assert.equal(layout.layoutDirectionFor(without(cyc), 'y', 'right'), 'right');
});

test('C-6: a new branch inside an override branch grows in that branch\'s direction and older cards stay put', () => {
  for (const spacing of SPACINGS) {
    const spec = { direction: 'right', spacing };
    const head = bigTopic(wide());
    const base = layout.arrangeMap(withLayout(wide(), head.id, 'down'), undefined, wideHeight, spec);
    const kid = base.find(item => item.parentId === head.id);
    const grown = [...base, node('n1', kid.id), node('n2', kid.id), node('n1a', 'n1')];
    const heightOf = id => wideHeight(id) ?? 150;
    const out = layout.arrangeNewBranch(grown, kid.id, new Set(['n1', 'n2', 'n1a']), heightOf, undefined, spec);
    assert.deepEqual(snap(out.filter(item => base.some(b => b.id === item.id))), snap(base), `${spacing} older cards stay`);
    assert.ok(noOverlap(out, heightOf, GAPS[spacing]), spacing);
    const by = new Map(out.map(item => [item.id, item]));
    assert.ok(by.get('n1').y > by.get(kid.id).y, `${spacing} the new card is below its parent, as in a down branch`);
    // Under the head itself too.
    const more = [...base, node('h1', head.id)];
    const placed = layout.arrangeNewBranch(more, head.id, new Set(['h1']), heightOf, undefined, spec);
    assert.ok(placed.find(item => item.id === 'h1').y > placed.find(item => item.id === head.id).y, `${spacing} under the head`);
    assert.ok(noOverlap(placed, heightOf, GAPS[spacing]), `${spacing} under the head`);
  }
  // In a balanced map a branch inside an override follows the override, not the side.
  const balanced = layout.arrangeMap(wide(), undefined, wideHeight, balancedSpec('standard'));
  const left = balanced.find(item => item.parentId === 'root' && item.x < balanced.find(o => o.id === 'root').x && balanced.some(o => o.parentId === item.id));
  const set = layout.arrangeMap(withLayout(balanced, left.id, 'up'), undefined, wideHeight, balancedSpec('standard'));
  const out = layout.arrangeNewBranch([...set, node('q', left.id)], left.id, new Set(['q']), wideHeight, undefined, balancedSpec('standard'));
  assert.ok(out.find(item => item.id === 'q').y < out.find(item => item.id === left.id).y, 'above the head');
});

test('C-4b: cleanBranchLayouts keeps none on an AIM map and is safe on long parent chains', () => {
  const compose = load('layouts/compose.ts');
  const chain = Array.from({ length: 5000 }, (_, i) => node(`n${i}`, i ? `n${i - 1}` : null, { layout: { direction: 'down' } }));
  compose.cleanBranchLayouts(chain, 'right', false);
  assert.equal(chain[0].layout, undefined, 'the root has none');
  assert.ok(chain.slice(1).every(item => item.layout.direction === 'down'));
  const aimNodes = [node('r'), node('a', 'r', { layout: { direction: 'down' } })];
  compose.cleanBranchLayouts(aimNodes, 'right', true);
  assert.equal(aimNodes[1].layout, undefined);
});

// ---- PV1 (tickets 20, 21, 22, 38, 39, 40): the view. A real view over a fake vault, as in tests/steps-layout-direction.cjs. ----
const support = require('./support.cjs');
const dom = require('./support-dom.cjs');
const MAP = 'Agent Workspace/Topics/map-pv1/Map.md';
const RIGHT_TITLE = 'Lay out to the right', LEFT_TITLE = 'Lay out to the left';

/** `spec` is [title, parentTitle|null, x, y] per node; `extra` is merged into the map before it is saved. */
async function harness(spec, extra = {}) {
  const { repo, app } = support.fixture('en', { linkIndex: true });
  const settings = { ...support.DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const mapDoc = { id: 'map-pv1', title: 'PV1', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-pv1');
  const byTitle = new Map();
  for (const [title, parentTitle, x, y] of spec) {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, 'workspace');
    Object.assign(created, { parentId: parentTitle ? byTitle.get(parentTitle).id : null, x, y });
    byTitle.set(title, created);
    mapDoc.nodes.push(created);
  }
  Object.assign(mapDoc, extra);
  await app.vault.create(MAP, support.core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const menus = [];
  class Menu {
    constructor() { this.items = []; menus.push(this); }
    addItem(callback) { const item = { checked: undefined, setTitle(value) { this.title = value; return this; }, setIcon(value) { this.icon = value; return this; }, setChecked(value) { this.checked = value; return this; }, onClick(handler) { this.click = handler; return this; } }; callback(item); this.items.push(item); return this; }
    addSeparator() { this.items.push({ separator: true }); return this; }
    showAtMouseEvent() { return this; }
  }
  const Base = dom.makeModal();
  class Modal extends Base { open() { super.open(); this.close(); } }
  const createSvg = tag => ({ tag, attrs: {}, classes: [], children: [], setAttribute(n, v) { this.attrs[n] = v; }, getAttribute(n) { return this.attrs[n]; }, addClass(n) { this.classes.push(n); }, appendChild(c) { this.children.push(c); } });
  const { VisualAgentMapView } = support.load('main.ts', { obsidian: { ...support.obsidian, Modal, Menu, Notice: dom.makeNotice([]) } }, { createFragment: dom.createFragment, createSvg });
  let pending = Promise.resolve();
  const plugin = support.withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: work => (pending = Promise.resolve().then(work))
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = dom.element('div'); view.stageEl = dom.element('div');
  let fits = 0;
  view.focusNode = () => {}; view.openDetails = () => {}; view.render = () => {}; view.fit = () => { fits++; };
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  view.cardHeightOf = () => 180;
  const named = title => view.map.nodes.find(n => view.notes.get(n.id)?.title === title);
  const menuTitles = () => menus.at(-1).items.map(item => (item.separator ? '---' : item.title));
  const choose = async title => { view.openLayoutMenu({}); menus.at(-1).items.find(item => item.title === title).click(); await pending; await pending; };
  return { repo, view, named, menus, menuTitles, choose, settled: () => pending, fits: () => fits, saved: () => repo.readMap(MAP), createSvg };
}
const edgeHost = () => ({ children: [], replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); } });
const card = (x, y, width = 300, height = 180) => ({ offsetLeft: x, offsetTop: y, offsetWidth: width, offsetHeight: height });
const tree4 = [['Root', null, 1000, 80], ['A', 'Root', 1360, 0], ['B', 'Root', 1360, 300], ['A1', 'A', 1720, 0]];
const plainJson = value => JSON.parse(JSON.stringify(value));
const DOWN = 'Lay out downward', UP = 'Lay out upward', BALANCED = 'Lay out balanced left and right', RADIAL = 'Lay out radially', TIMELINE = 'Lay out as a timeline', FISHBONE = 'Lay out as a fishbone';
const COMPACT = 'Compact spacing', STANDARD = 'Standard spacing', SPACIOUS = 'Spacious spacing';

test('V1: choosing Lay out downward is one write and one undo step; the field is {direction:"down"} and undo restores it', async () => {
  const h = await harness(tree4);
  const positions = () => JSON.stringify(h.view.map.nodes.map(n => [n.id, n.x, n.y]));
  const before = positions();
  const writes = h.view.history.past.length;
  await h.choose(DOWN);
  assert.equal(h.view.history.past.length, writes + 1, 'one history entry');
  assert.deepEqual(plainJson(h.view.map.layout), { direction: 'down' });
  assert.deepEqual(plainJson((await h.saved()).layout), { direction: 'down' }, 'stored in Map.md');
  const root = h.named('Root'), a = h.named('A');
  assert.ok(a.y > root.y && h.named('A1').y > a.y, 'children sit below their parent');
  assert.equal(h.fits(), 1);
  await h.view.travel(false);
  assert.equal('layout' in h.view.map, false, 'undo removes the field'); assert.equal(positions(), before, 'undo restores the coordinates');
  for (const [title, kind] of [[UP, 'up'], [BALANCED, 'balanced'], [RADIAL, 'radial'], [TIMELINE, 'timeline'], [FISHBONE, 'fishbone']]) {
    await h.choose(title);
    assert.deepEqual(plainJson(h.view.map.layout), { direction: kind }, kind);
    assert.deepEqual(plainJson((await h.saved()).layout), { direction: kind }, `${kind} stored`);
  }
});

test('V1b: the menu lists the eight arrangements and the three spacings after the original items and checks the current ones', async () => {
  const h = await harness(tree4);
  h.view.openLayoutMenu({});
  assert.deepEqual(h.menuTitles(), ['Collapse all', 'Expand all', 'Expand to level 1', 'Expand to level 2', 'Expand to level 3', '---', 'Lay out to the right', 'Lay out to the left', DOWN, UP, BALANCED, RADIAL, TIMELINE, FISHBONE, '---', COMPACT, STANDARD, SPACIOUS, 'Auto layout']);
  const checked = () => h.menus.at(-1).items.filter(item => item.checked).map(item => item.title);
  assert.deepEqual(checked(), ['Lay out to the right', STANDARD]);
  await h.choose(DOWN);
  h.view.openLayoutMenu({});
  assert.deepEqual(checked(), [DOWN, STANDARD]);
});

test('V2: choosing Spacious writes spacing and re-arranges; going back to Standard deletes the field (and the whole layout on a right map)', async () => {
  const h = await harness(tree4);
  await h.choose(SPACIOUS);
  const root = () => h.named('Root');
  assert.deepEqual(plainJson(h.view.map.layout), { direction: 'right', spacing: 'spacious' });
  assert.equal(h.named('A').x, root().x + 420, 'the column is 420 apart');
  assert.deepEqual(plainJson((await h.saved()).layout), { direction: 'right', spacing: 'spacious' });
  await h.choose(COMPACT);
  assert.deepEqual(plainJson(h.view.map.layout), { direction: 'right', spacing: 'compact' });
  assert.equal(h.named('A').x, root().x + 330);
  await h.choose(DOWN);
  assert.deepEqual(plainJson(h.view.map.layout), { direction: 'down', spacing: 'compact' }, 'a direction change keeps the spacing');
  await h.choose(STANDARD);
  assert.deepEqual(plainJson(h.view.map.layout), { direction: 'down' }, 'standard removes spacing only');
  await h.choose('Lay out to the right');
  assert.equal('layout' in h.view.map, false, 'right and standard leave no layout field');
  assert.equal('layout' in (await h.saved()), false);
});

test('V3: in a down map ArrowDown goes to the child, ArrowUp to the parent, ArrowLeft and ArrowRight between siblings; up swaps the vertical keys; balanced follows each side', async () => {
  const down = await harness(tree4, { layout: { direction: 'down' } });
  const root = down.named('Root'), a = down.named('A'), b = down.named('B');
  await down.choose(DOWN);
  assert.equal(down.view.keyboardNeighbor(down.named('Root'), 'ArrowDown').id, a.id);
  assert.equal(down.view.keyboardNeighbor(down.named('A'), 'ArrowUp').id, root.id);
  const [first, second] = [down.named('A'), down.named('B')].sort((p, q) => p.x - q.x);
  assert.equal(down.view.keyboardNeighbor(first, 'ArrowRight').id, second.id);
  assert.equal(down.view.keyboardNeighbor(second, 'ArrowLeft').id, first.id);
  const up = await harness(tree4, { layout: { direction: 'up' } });
  await up.choose(UP);
  assert.equal(up.view.keyboardNeighbor(up.named('Root'), 'ArrowUp').id, up.named('A').id, 'up map: ArrowUp goes to the first child');
  assert.equal(up.view.keyboardNeighbor(up.named('A'), 'ArrowDown').id, up.named('Root').id);
  const bal = await harness([['Root', null, 1000, 80], ['A', 'Root', 0, 0], ['B', 'Root', 0, 0], ['A1', 'A', 0, 0]], { layout: { direction: 'balanced' } });
  await bal.choose(BALANCED);
  const sideOf = title => (bal.named(title).x < bal.named('Root').x ? 'left' : 'right');
  assert.notEqual(sideOf('A'), sideOf('B'), 'the two topics are on opposite halves');
  const goes = (from, key) => bal.view.keyboardNeighbor(bal.named(from), key)?.id;
  assert.equal(goes('Root', 'ArrowLeft'), bal.named(sideOf('A') === 'left' ? 'A' : 'B').id);
  assert.equal(goes('Root', 'ArrowRight'), bal.named(sideOf('A') === 'right' ? 'A' : 'B').id);
  const outer = sideOf('A') === 'left' ? 'ArrowLeft' : 'ArrowRight', inner = sideOf('A') === 'left' ? 'ArrowRight' : 'ArrowLeft';
  assert.equal(goes('A', outer), bal.named('A1').id, 'outward key goes to the child');
  assert.equal(goes('A1', inner), bal.named('A').id, 'inward key goes to the parent');
});

test('V4: in a down map the parent line leaves the parent\'s bottom edge for the child\'s top edge, also while dragging; a fishbone passes the depth', async () => {
  const h = await harness(tree4.slice(0, 2), { layout: { direction: 'down' } });
  const root = h.named('Root'), a = h.named('A');
  h.view.edgesEl = edgeHost(); h.view.relationsLayerEl = edgeHost();
  h.view.cardEls.set(root.id, card(1000, 80)); h.view.cardEls.set(a.id, card(1000, 420));
  h.view.drawEdges();
  assert.equal(h.view.edgesEl.children[0].attrs.d, 'M 1150 260 C 1150 340, 1150 340, 1150 420');
  const drag = h.view.dragEdges(a.id, { offsetWidth: 300, offsetHeight: 180 });
  drag.update(1200, 500);
  assert.equal(h.view.edgeEls.get(`${root.id}\u0000${a.id}`).attrs.d, 'M 1150 260 C 1150 380, 1350 380, 1350 500', 'dragging the child keeps the down geometry');
  const f = await harness([['Root', null, 1000, 80], ['A', 'Root', 600, 0], ['A1', 'A', 300, 0]], { layout: { direction: 'fishbone' } });
  const geometry2 = load('experiences/visual-map/relation-geometry.ts');
  f.view.edgesEl = edgeHost(); f.view.relationsLayerEl = edgeHost();
  const ids = ['Root', 'A', 'A1'].map(title => f.named(title).id);
  const boxes = [card(1000, 80), card(600, 0), card(300, 0)];
  ids.forEach((id, i) => f.view.cardEls.set(id, boxes[i]));
  f.view.drawEdges();
  const box = c => ({ x: c.offsetLeft, y: c.offsetTop, width: c.offsetWidth, height: c.offsetHeight });
  assert.equal(f.view.edgeEls.get(`${ids[0]}\u0000${ids[1]}`).attrs.d, geometry2.treeEdgePathData(box(boxes[0]), box(boxes[1]), 'fishbone', 1), 'depth 1 is the diagonal bone');
  assert.equal(f.view.edgeEls.get(`${ids[1]}\u0000${ids[2]}`).attrs.d, geometry2.treeEdgePathData(box(boxes[1]), box(boxes[2]), 'fishbone', 2), 'depth 2 is the rib');
});

test('V4b: a branch with its own direction draws its edges by the parent card\'s direction; right maps keep the old curve text', async () => {
  const h = await harness(tree4, { layout: { direction: 'right' } });
  h.view.map.nodes.find(n => n.id === h.named('A').id).layout = { direction: 'down' };
  h.view.edgesEl = edgeHost(); h.view.relationsLayerEl = edgeHost();
  const root = h.named('Root'), a = h.named('A'), a1 = h.named('A1'), b = h.named('B');
  h.view.cardEls.set(root.id, card(1000, 80)); h.view.cardEls.set(a.id, card(1360, 0)); h.view.cardEls.set(b.id, card(1360, 300)); h.view.cardEls.set(a1.id, card(1360, 300));
  h.view.drawEdges();
  const d = (p, c) => h.view.edgeEls.get(`${p.id}\u0000${c.id}`).attrs.d;
  assert.equal(d(root, a), 'M 1300 170 C 1360 170, 1300 90, 1360 90', 'into the branch: the parent (right map) decides');
  assert.equal(d(a, a1), 'M 1510 180 C 1510 240, 1510 240, 1510 300', 'inside the branch: down');
});

test('V5: an AIM map and the built-in sample have none of the new menu items', async () => {
  const original = ['Collapse all', 'Expand all', 'Expand to level 1', 'Expand to level 2', 'Expand to level 3', '---', 'Auto layout'];
  const h = await harness(tree4);
  h.view.map.aim = { version: 1, branches: [], runs: [], pendingCommits: [] };
  h.view.openLayoutMenu({});
  assert.deepEqual(h.menuTitles(), original);
  h.view.map.aim = undefined; h.view.builtIn = true;
  h.view.openLayoutMenu({});
  assert.deepEqual(h.menuTitles(), original);
});

test('V6: switching to balanced deals the topics out again even when their old x already straddles the root', async () => {
  const h = await harness([['Root', null, 1000, 80], ['A', 'Root', 1000, 0], ['B', 'Root', 1000, 400], ['C', 'Root', 1000, 800], ['D', 'Root', 1000, 1200]], { layout: { direction: 'down' } });
  await h.choose(BALANCED);
  const sides = ['A', 'B', 'C', 'D'].map(title => (h.named(title).x < h.named('Root').x ? 'left' : 'right'));
  assert.ok(sides.includes('left') && sides.includes('right'), 'both halves are used');
});
