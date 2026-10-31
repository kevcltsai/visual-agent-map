// Layout group P0 (ticket 22): spacing and the layout data contract. Pure functions only; no UI, no AI.
// Later packets of the group (down/up, balanced, radial, timeline, fishbone, per-branch) add their own cases to this file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const layout = load('map-layout.ts');
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
  // The directions whose engines do not exist yet are not accepted by parse (P0 keeps isLayoutDirection at right/left).
  assert.equal('layout' in roundTrip({ direction: 'down', spacing: 'compact' }), false);
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
  assert.deepEqual(layoutOf({ layout: { direction: 'down', spacing: 'huge' } }), { direction: 'right' });
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
