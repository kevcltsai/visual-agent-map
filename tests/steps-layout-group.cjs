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
  // The arrangements whose engines do not exist yet are not accepted by parse; each engine packet adds its own value.
  for (const direction of ['radial', 'timeline', 'fishbone'])
    assert.equal('layout' in roundTrip({ direction, spacing: 'compact' }), false, direction);
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
  assert.deepEqual(layoutOf({ layout: { direction: 'radial', spacing: 'huge' } }), { direction: 'right' });
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
  assert.equal(layout.isLayoutKind('radial'), false);
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
