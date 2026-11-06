// Image ring P2: the layout wiring in the view. "Auto layout" and new branches in all 8 arrangements never fold a ring into
// a tree, ring cards grow their branches away from the picture, a ring that lands on other cards moves off them, and a
// card that grew re-solves its ring only when it is really in the way. The ring algorithm itself is tested in steps-image-ring.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { obsidian } = require('./support.cjs');
const replay = require('./support-replay.cjs');

const { VisualAgentMapView } = replay.load('experiences/visual-map/view.ts', { obsidian: { ...obsidian, Component: class {}, MarkdownRenderChild: class {} } }, { window: { setTimeout, clearTimeout }, CSS: { escape: s => s } });
const ring = replay.load('experiences/visual-map/image-ring.ts');
const layout = replay.load('map-layout.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const KINDS = ['right', 'left', 'down', 'up', 'balanced', 'radial', 'timeline', 'fishbone'];
const IMAGE = { x: 400, y: 300, w: 720, h: 512 };

const node = (id, parentId, x = 0, y = 0, extra = {}) => ({ id, path: `${id}.md`, parentId, x, y, collapsed: false, ...extra });
const picture = (relations, over = {}) => ({
  id: 'img', kind: 'annotated-image', path: 'a.png', ...IMAGE,
  anchors: relations.map(([anchor, , at]) => ({ id: anchor, at: { kind: 'image-2d', x: at[0], y: at[1] } })),
  relations: relations.map(([anchor, topic]) => ({ kind: 'related', from: anchor, to: topic, ring: true })),
  ...over
});
/** A view that only has what the layout methods read. */
function bare(map, heights = {}) {
  const view = Object.assign(Object.create(VisualAgentMapView.prototype), { map });
  view.cardHeightOf = id => heights[id] ?? 120;
  view.textWidthOf = () => undefined;
  return view;
}
const doc = (nodes, canvasItems, direction = 'right') => ({ id: 'm', title: 'M', version: 1, nodes, viewport: { x: 0, y: 0, zoom: 1 }, canvasItems, ...(direction === 'right' ? {} : { layout: { direction } }) });
const rect = (n, h = 120) => ({ x: n.x, y: n.y, w: n.width ?? 280, h });
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const imageOf = map => map.canvasItems.find(i => i.kind === 'annotated-image');
const ringStates = (map, ids, heights = {}) => ids.map(id => {
  const n = map.nodes.find(x => x.id === id);
  const rel = imageOf(map).relations.find(r => r.to === id);
  const at = imageOf(map).anchors.find(a => a.id === rel.from).at;
  return { id, ...rect(n, heights[id] ?? 120), anchorX: at.x, anchorY: at.y };
});
const RING = [['a1', 't1', [0.2, 0.2]], ['a2', 't2', [0.8, 0.2]], ['a3', 't3', [0.2, 0.8]], ['a4', 't4', [0.8, 0.8]], ['a5', 't5', [0.5, 0.5]]];
const ringIds = RING.map(r => r[1]);
const tree = () => [node('r', null, 80, 80), node('c1', 'r', 400, 80), node('c2', 'r', 400, 300), node('g1', 'c1', 720, 80)];
const withRing = (kind, extra = []) => doc([...tree(), ...extra, ...ringIds.map(id => node(id, null, 5000, 5000))], [picture(RING)], kind);
const withRingOf = (rows, kind, extra = []) => doc([...tree(), ...extra, ...rows.map(r => node(r[1], null, 5000, 5000))], [picture(rows)], kind);
const treeOnly = (map) => map.nodes.filter(n => !ringIds.includes(n.id));

test('arrange all: every arrangement keeps the ring out of the tree and the tree as it would be alone', () => {
  for (const kind of KINDS) {
    const map = withRing(kind);
    bare(map).arrangeAll(map);
    const alone = doc(tree(), undefined, kind);
    bare(alone).arrangeAll(alone);
    assert.deepEqual(plain(treeOnly(map)), plain(alone.nodes), `${kind}: the tree is laid out as if the ring was not there`);
    for (const id of ringIds) assert.equal(map.nodes.find(n => n.id === id).parentId, null, `${kind}: ${id} stays a top-level topic`);
    const others = treeOnly(map).map(n => rect(n));
    assert.deepEqual(plain(ring.ringViolations(imageOf(map), ringStates(map, ringIds), { memberCount: 5, others })), [], `${kind}: ring is clean`);
    assert.ok(!others.some(o => hit(o, imageOf(map))), `${kind}: the picture is clear of the tree`);
  }
});

test('arrange all: a ring that lands on the tree moves off it, picture and cards together; the tree does not move', () => {
  const map = doc(tree(), [picture(RING, { x: 80, y: 80 })]);
  map.nodes.push(...ringIds.map(id => node(id, null, 0, 0)));
  bare(map).arrangeAll(map);
  const alone = doc(tree());
  bare(alone).arrangeAll(alone);
  assert.deepEqual(plain(treeOnly(map)), plain(alone.nodes));
  const footprint = ring.ringBounds(imageOf(map), ringStates(map, ringIds));
  assert.ok(!treeOnly(map).some(n => hit(rect(n), footprint)), 'ring clear of every tree card');
  assert.ok(imageOf(map).x !== 80 || imageOf(map).y !== 80, 'the picture moved off');
});

test('arrange all: a map with only a ring (no root) does not throw and solves the ring', () => {
  for (const kind of KINDS) {
    const map = doc(ringIds.map(id => node(id, null, 7, 7)), [picture(RING)], kind);
    bare(map).arrangeAll(map);
    assert.deepEqual(plain(ring.ringViolations(imageOf(map), ringStates(map, ringIds), { memberCount: 5 })), [], kind);
  }
});

test('arrange all: a map without ring relations is exactly what arrangeMap gives', () => {
  const plainPicture = picture(RING.map(r => r), {});
  plainPicture.relations = plainPicture.relations.map(r => ({ kind: r.kind, from: r.from, to: r.to }));
  for (const kind of KINDS) {
    const map = withRing(kind);
    map.canvasItems = [plainPicture];
    const expected = layout.arrangeMap(map.nodes, new Set(), bare(map).cardHeightOf, kind === 'right' ? 'right' : kind);
    bare(map).arrangeAll(map);
    assert.deepEqual(plain(map.nodes), plain(expected), kind);
    assert.deepEqual(plain(map.canvasItems), plain([plainPicture]));
  }
});

test('arrange all: text blocks under a ring card and its branch follow them; a folded ring card takes its hidden branch along', () => {
  const nodes = [...ringIds.map(id => node(id, null, 0, 0)), node('k', 't2', 9000, 9000), node('hid', 't3', 9100, 9100)];
  nodes.find(n => n.id === 't3').collapsed = true;
  const items = [picture(RING), { id: 'tx1', kind: 'text', text: 'x', parentId: 't1', x: 9500, y: 9500 }, { id: 'tx2', kind: 'text', text: 'y', parentId: 'k', x: 9500, y: 9800 }, { id: 'tx3', kind: 'text', text: 'z', parentId: 'hid', x: 9500, y: 9900 }];
  const map = doc(nodes, items);
  bare(map).arrangeAll(map);
  const at = id => map.nodes.find(n => n.id === id);
  const text = id => map.canvasItems.find(i => i.id === id);
  assert.ok(Math.abs(text('tx1').x - at('t1').x) < 1000 && Math.abs(text('tx1').y - at('t1').y) < 400, 'text stays beside its card');
  assert.ok(Math.abs(at('k').x - at('t2').x) < 1200 && Math.abs(at('k').y - at('t2').y) < 600, 'child of an open card is laid out next to it');
  assert.equal(at('hid').x - at('t3').x, 9100, 'folded branch keeps its offset from the card');
  assert.equal(at('hid').y - at('t3').y, 9100);
  assert.equal(text('tx3').x - at('t3').x, 9500, 'text of the folded branch keeps its offset too');
  assert.equal(text('tx3').y - at('t3').y, 9900);
  assert.deepEqual(plain(ring.ringViolations(imageOf(map), ringStates(map, ringIds), { memberCount: 5 })), []);
});

test('new branch: no arrangement folds a ring into the tree, and the tree grows as it would alone', () => {
  for (const kind of KINDS) {
    const map = withRing(kind);
    bare(map).arrangeAll(map);
    const before = plain(map.nodes.filter(n => ringIds.includes(n.id)));
    const imageBefore = plain(imageOf(map));
    map.nodes.push(node('new', 'c2', 0, 0));
    bare(map).arrangeBranch(map, 'c2', new Set(['new']));
    assert.deepEqual(plain(map.nodes.filter(n => ringIds.includes(n.id))), before, `${kind}: ring cards did not move`);
    assert.deepEqual(plain(imageOf(map)), imageBefore, `${kind}: the picture did not move`);
    const alone = doc(tree(), undefined, kind);
    bare(alone).arrangeAll(alone);
    alone.nodes.push(node('new', 'c2', 0, 0));
    bare(alone).arrangeBranch(alone, 'c2', new Set(['new']));
    const mine = map.nodes.find(n => n.id === 'new');
    assert.ok(Number.isFinite(mine.x) && Number.isFinite(mine.y), kind);
    if (!['radial', 'timeline', 'fishbone'].includes(kind)) assert.equal(mine.parentId, 'c2');
    if (['radial', 'timeline', 'fishbone'].includes(kind)) assert.deepEqual(plain(treeOnly(map)), plain(alone.nodes), `${kind}: same as the tree alone`);
    else {
      assert.ok(!ringIds.some(id => hit(rect(map.nodes.find(n => n.id === id)), rect(mine))), `${kind}: the new card is clear of the ring cards`);
      assert.deepEqual(plain(treeOnly(map).filter(n => n.id !== 'new')), plain(alone.nodes.filter(n => n.id !== 'new')), `${kind}: the rest of the tree is untouched`);
    }
  }
});

test('new branch under a ring card grows away from the picture, in every arrangement, and not onto the picture', () => {
  for (const kind of ['right', 'left', 'down', 'up', 'balanced', 'radial', 'timeline', 'fishbone']) {
    const map = withRing(kind);
    bare(map).arrangeAll(map);
    const image = imageOf(map);
    for (const id of ringIds) {
      const card = map.nodes.find(n => n.id === id);
      const side = ring.ringSide(image, rect(card));
      const child = node(`${id}-k`, id, 0, 0);
      map.nodes.push(child);
      bare(map).arrangeBranch(map, id, new Set([child.id]));
      const kid = rect(map.nodes.find(n => n.id === child.id));
      const parent = rect(card);
      if (side === 'top') assert.ok(kid.y + kid.h <= parent.y + 1e-6, `${kind} ${id}: above its card`);
      if (side === 'bottom') assert.ok(kid.y >= parent.y + parent.h - 1e-6, `${kind} ${id}: below its card`);
      if (side === 'left') assert.ok(kid.x + kid.w <= parent.x + 1e-6, `${kind} ${id}: left of its card`);
      if (side === 'right') assert.ok(kid.x >= parent.x + parent.w - 1e-6, `${kind} ${id}: right of its card`);
      assert.ok(!hit(kid, image), `${kind} ${id}: not on the picture`);
      map.nodes = map.nodes.filter(n => n.id !== child.id);
    }
  }
});

test('A7: expanded cards on all four sides have their branch outside the card, the direction helper agrees', () => {
  const four = [['a1', 't1', [0.5, 0.02]], ['a2', 't2', [0.5, 0.98]], ['a3', 't3', [0.02, 0.5]], ['a4', 't4', [0.98, 0.5]]];
  const map = doc([...tree(), ...four.map(r => node(r[1], null, 5000, 5000))], [picture(four)]);
  bare(map).arrangeAll(map);
  const image = imageOf(map);
  const view = bare(map);
  const seen = new Set();
  for (const id of four.map(r => r[1])) {
    const side = ring.ringSide(image, rect(map.nodes.find(n => n.id === id)));
    const expected = { top: 'up', bottom: 'down', left: 'left', right: 'right' }[side];
    seen.add(side);
    assert.equal(view.directionOf(map, id), expected, `${id} ${side}`);
    map.nodes.push(node(`${id}-k`, id, 0, 0), node(`${id}-g`, `${id}-k`, 0, 0));
    assert.equal(view.directionOf(map, `${id}-g`), expected, `grandchild of ${id}`);
  }
  assert.equal(seen.size, 4, 'the four-card ring uses all four sides');
  assert.equal(view.directionOf(map, 'c1'), 'right', 'a tree card keeps the map direction');
});

test('radial map: adding a branch to the tree leaves the ring and picture exactly where they were', () => {
  const map = withRing('radial');
  bare(map).arrangeAll(map);
  const before = plain({ ring: map.nodes.filter(n => ringIds.includes(n.id)), image: imageOf(map) });
  map.nodes.push(node('n1', 'r', 0, 0));
  bare(map).arrangeBranch(map, 'r', new Set(['n1']));
  assert.deepEqual(plain({ ring: map.nodes.filter(n => ringIds.includes(n.id)), image: imageOf(map) }), before);
});

test('dropped card: a ring card is never "among siblings" (the drop only moves it), a tree root still can be', () => {
  const map = withRing('right', [node('r2', null, 90, 400)]);
  bare(map).arrangeAll(map);
  const view = bare(map);
  for (const id of ringIds) assert.equal(view.droppedAmongSiblings(map, map.nodes.find(n => n.id === id)), false, id);
});

test('relevance order: ring cards and their branches keep their coordinates in the sorted display', () => {
  const map = withRing('right');
  bare(map).arrangeAll(map);
  map.nodes.push(node('t1-k', 't1', 123, 456));
  const view = bare(map);
  view.relevanceSortOn = () => true;
  view.notes = new Map();
  const shown = view.canvasNodes();
  for (const id of [...ringIds, 't1-k']) {
    const real = map.nodes.find(n => n.id === id);
    const got = shown.find(n => n.id === id);
    assert.deepEqual([got.x, got.y], [real.x, real.y], id);
  }
});

test('tidy after resize: a hand-dragged ring card that grows is left alone; a card that really gets in the way re-solves its ring', () => {
  const map = doc([node('t1', null, 0, 0), node('t2', null, 0, 0)], [picture([['a1', 't1', [0.5, 0.1]], ['a2', 't2', [0.5, 0.9]]])]);
  bare(map).arrangeAll(map);
  const image = imageOf(map);
  const centreX = image.x + image.w / 2;
  // Swap the two cards onto the far sides, in line with their anchors: only the "pairing" check says it is not the tidiest.
  const t1 = map.nodes.find(n => n.id === 't1');
  const t2 = map.nodes.find(n => n.id === 't2');
  t1.x = centreX - 140; t1.y = image.y + image.h + 64;
  t2.x = centreX - 140; t2.y = image.y - 64 - 120;
  const states = () => ringStates(map, ['t1', 't2'], { t1: 300, t2: 120 });
  assert.deepEqual(plain(ring.ringViolations(image, ringStates(map, ['t1', 't2']))).map(v => v.code), ['pairing'], 'setup: only pairing');
  const heights = { t1: 300 };
  const view = bare(map, heights);
  const moved = plain(map.nodes);
  assert.equal(view.ringTidyNeeded(new Set(['t1'])), false);
  assert.equal(view.tidyAfterResize(map, new Set(['t1'])), false, 't1 grew downward, away from the picture: nothing to fix');
  assert.deepEqual(plain(map.nodes), moved, 'the dragged cards stay where the user put them');
  assert.ok(states().length);
  // t2 sits above the picture: growing makes it cover the picture.
  heights.t2 = 400;
  assert.equal(view.ringTidyNeeded(new Set(['t2'])), true);
  assert.equal(view.tidyAfterResize(map, new Set(['t2'])), true);
  const after = ringStates(map, ['t1', 't2'], heights);
  assert.deepEqual(plain(ring.ringViolations(imageOf(map), after, { memberCount: 2 })), [], 'solved against the new heights');
});

test('tidy after resize: without rings it is the old rule (overlap only), with a plain overlap it arranges the whole map', () => {
  const map = doc([node('r', null, 80, 80), node('a', 'r', 400, 80), node('b', 'r', 400, 200)], undefined);
  const view = bare(map, { a: 300 });
  assert.equal(view.tidyAfterResize(map, new Set(['a'])), true);
  const calm = doc([node('r', null, 80, 80), node('a', 'r', 400, 80), node('b', 'r', 400, 600)], undefined);
  assert.equal(bare(calm, {}).tidyAfterResize(calm, new Set(['a'])), false);
});

// ---- P3: arrow keys around a picture ---------------------------------------------------------------------------------------
const keyView = map => {
  const view = bare(map);
  view.relevanceSortOn = () => false;
  return view;
};
const MANY = Array.from({ length: 12 }, (_, i) => [`a${i}`, `m${i}`, [0.1 + 0.07 * i, 0.15 + 0.06 * ((i * 5) % 12)]]);
const FORWARD = { top: 'ArrowRight', right: 'ArrowDown', bottom: 'ArrowLeft', left: 'ArrowUp' };
const BACK = { ArrowRight: 'ArrowLeft', ArrowLeft: 'ArrowRight', ArrowDown: 'ArrowUp', ArrowUp: 'ArrowDown' };

test('keys around a picture: from any card the forward key reaches every ring card exactly once and returns; the opposite key walks it back', () => {
  for (const kind of ['right', 'down']) {
    const ids = MANY.map(r => r[1]);
    const map = withRingOf(MANY, kind, [node('r2', null, 90, 900)]);
    bare(map).arrangeAll(map);
    const view = keyView(map);
    const image = imageOf(map);
    const sideOf = id => ring.ringSide(image, rect(map.nodes.find(n => n.id === id)));
    for (const start of ids) {
      const seen = [start];
      let at = start;
      for (let step = 1; step < ids.length; step++) {
        const here = map.nodes.find(n => n.id === at);
        const next = view.displayedNeighbor(here, FORWARD[sideOf(at)]);
        assert.ok(next, `${kind} ${start}: a next card after ${at}`);
        assert.ok(ids.includes(next.id), `${kind}: stays on the ring`);
        seen.push(next.id);
        at = next.id;
      }
      assert.equal(new Set(seen).size, ids.length, `${kind} from ${start}: every card exactly once`);
      const last = view.displayedNeighbor(map.nodes.find(n => n.id === at), FORWARD[sideOf(at)]);
      assert.equal(last.id, start, `${kind} from ${start}: the walk closes`);
      // And back again with the opposite key.
      let back = at;
      for (let step = 1; step < ids.length; step++) {
        back = view.displayedNeighbor(map.nodes.find(n => n.id === back), BACK[FORWARD[sideOf(back)]]).id;
        assert.equal(back, seen[ids.length - 1 - step], `${kind}: back is the same walk reversed`);
      }
    }
  }
});

test('keys around a picture: the arrow points the way it moves on the screen (right on the top row, left on the bottom row, down on the right column, up on the left column)', () => {
  const map = withRingOf(MANY, 'right');
  bare(map).arrangeAll(map);
  const view = keyView(map);
  const image = imageOf(map);
  const at = id => map.nodes.find(n => n.id === id);
  for (const id of MANY.map(r => r[1])) {
    const side = ring.ringSide(image, rect(at(id)));
    const here = at(id);
    const next = view.displayedNeighbor(here, FORWARD[side]);
    const nextSide = ring.ringSide(image, rect(next));
    if (nextSide !== side) continue;
    if (side === 'top') assert.ok(next.x > here.x, 'top row: to the right');
    if (side === 'bottom') assert.ok(next.x < here.x, 'bottom row: to the left');
    if (side === 'right') assert.ok(next.y > here.y, 'right column: down');
    if (side === 'left') assert.ok(next.y < here.y, 'left column: up');
  }
});

test('keys: a ring card goes to its child with the outward arrow; other top-level topics do not walk into the ring; without a picture nothing changes', () => {
  const map = withRing('right', [node('r2', null, 90, 400)]);
  bare(map).arrangeAll(map);
  const view = keyView(map);
  const image = imageOf(map);
  const outward = { top: 'ArrowUp', bottom: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
  for (const id of ringIds) {
    const card = map.nodes.find(n => n.id === id);
    map.nodes.push(node(`${id}-k`, id, 0, 0));
    bare(map).arrangeBranch(map, id, new Set([`${id}-k`]));
    const side = ring.ringSide(image, rect(card));
    assert.equal(view.displayedNeighbor(card, outward[side])?.id, `${id}-k`, `${id} ${side}`);
    assert.equal(view.displayedNeighbor(map.nodes.find(n => n.id === `${id}-k`), BACK[outward[side]])?.id, id, 'and back to the card');
  }
  const r = map.nodes.find(n => n.id === 'r');
  assert.equal(view.displayedNeighbor(r, 'ArrowDown')?.id, 'r2', 'r to r2: the ring cards are not among its siblings');
  assert.equal(view.displayedNeighbor(map.nodes.find(n => n.id === 'r2'), 'ArrowUp')?.id, 'r');
  const plainMap = doc([node('r', null, 80, 80), node('r2', null, 90, 400), node('r3', null, 90, 700)], undefined);
  const plainView = keyView(plainMap);
  assert.equal(plainView.displayedNeighbor(plainMap.nodes[0], 'ArrowDown')?.id, 'r2');
  assert.equal(plainView.displayedNeighbor(plainMap.nodes[1], 'ArrowDown')?.id, 'r3');
  assert.equal(plainView.displayedNeighbor(plainMap.nodes[2], 'ArrowUp')?.id, 'r2');
});
