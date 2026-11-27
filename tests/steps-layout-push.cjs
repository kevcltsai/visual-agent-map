// A9 local push: pushAffected moves only the cards that a freshly placed card (with its decorations) overlaps, plus the siblings after them. Pure function, no UI, no AI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const push = load('layouts/push.ts');
const layout = load('map-layout.ts');

const node = (id, parentId, x, y, extra = {}) => ({ id, parentId, path: `${id}.md`, x, y, collapsed: false, ...extra });
const H = 100;
const heights = (over = {}) => id => over[id] ?? H;
const run = (nodes, moving, over = {}) => push.pushAffected(nodes, new Set(moving), { heightOf: heights(over.heights), decorations: [], layout: { direction: 'right' }, ...over.opts });
const pos = (result, id) => { const n = result.nodes.find(item => item.id === id); return [n.x, n.y]; };
const rect = (n, hf, w = 280) => ({ l: n.x, r: n.x + (n.width ?? w), t: n.y, b: n.y + hf(n.id) });
const cross = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
const noOverlap = (result, hf = heights(), skip = () => false) => {
  const shown = result.nodes.filter(item => !item.hidden);
  for (const a of shown) for (const b of shown) if (a.id < b.id && !skip(a, b)) assert.equal(cross(rect(a, hf), rect(b, hf)), false, `${a.id} overlaps ${b.id}`);
};
const unchangedExcept = (before, result, changed) => {
  for (const item of before) if (!changed.includes(item.id)) assert.deepEqual(pos(result, item.id), [item.x, item.y], `${item.id} must not move`);
};
const column = () => [
  node('root', null, 0, 0), node('p1', 'root', 360, 0), node('p2', 'root', 360, 124), node('p3', 'root', 360, 248),
  node('p2k', 'p2', 720, 124), node('far', null, 0, 2000)
];

test('a: right, new card mid-column with a tall cover pushes later siblings and their subtrees', () => {
  const nodes = [...column(), node('n', 'root', 360, 124)];
  const result = run(nodes, ['n'], { heights: { n: 300 } });
  assert.deepEqual(pos(result, 'n'), [360, 124]);
  assert.deepEqual(pos(result, 'p2'), [360, 448]);
  assert.deepEqual(pos(result, 'p3'), [360, 572]);
  assert.deepEqual(pos(result, 'p2k'), [720, 448]);
  unchangedExcept(nodes, result, ['p2', 'p3', 'p2k']);
  noOverlap(result, heights({ n: 300 }));
});

test('b: manual card sizes from boxOf decide the overlap', () => {
  const nodes = [...column(), node('n', 'root', 360, 100)];
  const boxes = { p2: { w: 400, h: 300 } };
  const boxOf = id => { const n = nodes.find(item => item.id === id); return n ? { dx: 0, dy: 0, w: boxes[id]?.w ?? 280, h: boxes[id]?.h ?? 100 } : undefined; };
  const result = push.pushAffected(nodes, new Set(['n']), { boxOf, heightOf: heights(), decorations: [], layout: { direction: 'right' } });
  assert.deepEqual(pos(result, 'p2'), [360, 224]);
  assert.deepEqual(pos(result, 'p3'), [360, 348]);
  unchangedExcept(nodes, result, ['p2', 'p3', 'p2k']);
});

test('c: a summary bracket pad counts as part of its members, a non-member touching it is pushed away', () => {
  const nodes = [node('root', null, 0, 0), node('p1', 'root', 360, 0), node('p2', 'root', 360, 124), node('n', 'root', 360, 190), node('p4', 'root', 360, 400)];
  const heightOf = heights({ p2: 60 });
  const decorations = [{ members: ['p1', 'p2'], pad: { l: 10, t: 30, r: 10, b: 10 } }];
  const result = push.pushAffected(nodes, new Set(['n']), { heightOf, decorations, layout: { direction: 'right' } });
  assert.deepEqual(pos(result, 'n'), [360, 218]);
  assert.deepEqual(pos(result, 'p4'), [360, 428]);
  unchangedExcept(nodes, result, ['n', 'p4']);
});

test('d: a frame made of moving cards pushes fixed cards it covers, not only the cards themselves', () => {
  const nodes = [node('root', null, 0, 0), node('p1', 'root', 360, 0), node('n', 'root', 360, 124), node('nk', 'n', 720, 124), node('p2', 'root', 360, 230), node('p3', 'root', 360, 400)];
  const decorations = [{ members: ['n', 'nk'], pad: { l: 20, t: 20, r: 20, b: 20 } }];
  const result = push.pushAffected(nodes, new Set(['n', 'nk']), { heightOf: heights(), decorations, layout: { direction: 'right' } });
  assert.deepEqual(pos(result, 'p2'), [360, 268]);
  assert.deepEqual(pos(result, 'p3'), [360, 438]);
  unchangedExcept(nodes, result, ['p2', 'p3']);
});

for (const direction of ['down', 'up']) {
  test(`e: ${direction} pushes along x`, () => {
    const y = direction === 'down' ? 200 : -200;
    const nodes = [node('root', null, 0, 0), node('c1', 'root', 0, y), node('c2', 'root', 304, y), node('n', 'root', 304, y), node('c2k', 'c2', 304, y + 200 * (direction === 'down' ? 1 : -1))];
    const result = push.pushAffected(nodes, new Set(['n']), { heightOf: heights(), decorations: [], layout: { direction } });
    assert.deepEqual(pos(result, 'c2'), [608, y]);
    assert.deepEqual(pos(result, 'c2k'), [608, nodes[4].y]);
    unchangedExcept(nodes, result, ['c2', 'c2k']);
    noOverlap(result);
  });
}

test('e2: left pushes along y', () => {
  const nodes = [node('root', null, 0, 0), node('p1', 'root', -360, 0), node('p2', 'root', -360, 124), node('n', 'root', -360, 124)];
  const result = push.pushAffected(nodes, new Set(['n']), { heightOf: heights(), decorations: [], layout: { direction: 'left' } });
  assert.deepEqual(pos(result, 'p2'), [-360, 248]);
  unchangedExcept(nodes, result, ['p2']);
});

test('f: balanced pushes only the side the new card is on', () => {
  const nodes = [
    node('root', null, 0, 0), node('r1', 'root', 360, 0), node('r2', 'root', 360, 124), node('n', 'root', 360, 124),
    node('l1', 'root', -360, 0), node('l2', 'root', -360, 124), node('l3', 'root', -360, 248)
  ];
  const result = push.pushAffected(nodes, new Set(['n']), { heightOf: heights(), decorations: [], layout: { direction: 'balanced' } });
  assert.deepEqual(pos(result, 'r2'), [360, 248]);
  unchangedExcept(nodes, result, ['r2']);
});

test('g: compose follows the branch layout of the parent', () => {
  const nodes = [
    node('root', null, 0, 0), node('b', 'root', 360, 0, { layout: { direction: 'down' } }),
    node('k1', 'b', 360, 200), node('k2', 'b', 664, 200), node('n', 'b', 664, 200),
    node('s', 'root', 360, 124), node('s2', 'root', 360, 248)
  ];
  const result = push.pushAffected(nodes, new Set(['n']), { heightOf: heights(), decorations: [], layout: { direction: 'right' } });
  assert.deepEqual(pos(result, 'k2'), [968, 200]);
  unchangedExcept(nodes, result, ['k2']);
});

test('h: ten new cards at once end without overlap, the first sibling stays, and the loop terminates', () => {
  const fresh = Array.from({ length: 10 }, (_, i) => node(`n${i}`, 'root', 360, 124 + i * 124));
  const nodes = [...column(), ...fresh];
  const result = run(nodes, fresh.map(item => item.id));
  noOverlap(result, heights(), (a, b) => (a.id === 'root' || b.id === 'root' || a.id === 'far' || b.id === 'far'));
  assert.deepEqual(pos(result, 'p1'), [360, 0]);
  assert.deepEqual(pos(result, 'far'), [0, 2000]);
});

test('i: collapsed descendants are no obstacle and stay where they are; expanded they are', () => {
  const hiddenRoot = [node('root', null, 0, 0), node('p1', 'root', 360, 0, { collapsed: true }), node('p1k', 'p1', 720, 300), node('n', 'root', 720, 300), node('p2', 'root', 360, 400)];
  const collapsedRun = run(hiddenRoot, ['n']);
  assert.deepEqual(collapsedRun.nodes, hiddenRoot);
  const open = hiddenRoot.map(item => (item.id === 'p1' ? { ...item, collapsed: false } : item));
  const openRun = run(open, ['n']);
  assert.notDeepEqual(pos(openRun, 'p2'), [360, 400]);
});

test('j: radial, timeline and fishbone keep the whole-map rearrange', () => {
  for (const direction of ['radial', 'timeline', 'fishbone']) {
    const nodes = [node('root', null, 0, 0), node('p1', 'root', 360, 0), node('p2', 'root', 360, 124), node('n', 'root', 360, 124)];
    const result = push.pushAffected(nodes, new Set(['n']), { heightOf: heights(), decorations: [], layout: { direction } });
    assert.equal(result.unsupported, true);
    assert.deepEqual(result.nodes, nodes);
    const whole = layout.arrangeNewBranch(nodes.map(item => ({ ...item })), 'root', new Set(['n']), undefined, undefined, direction);
    const full = layout.arrangeMap(nodes.map(item => ({ ...item })), undefined, undefined, direction);
    const rel = list => list.map(item => [item.id, Math.round(item.x - list[0].x), Math.round(item.y - list[0].y)]);
    assert.deepEqual(rel(whole), rel(full));
    assert.deepEqual([whole[0].x, whole[0].y], [0, 0]);
  }
});

// Wired into arrangeNewBranch (A9 phase 2): a new card goes after its previous sibling and only the affected branch is pushed.
const place = (nodes, ids, direction = 'right', extra = {}) => layout.arrangeNewBranch(nodes.map(item => ({ ...item })), 'root', new Set(ids), heights(extra.heights), undefined, direction, extra.push);
const xy = (list, id) => { const n = list.find(item => item.id === id); return [n.x, n.y]; };
const sameExcept = (before, list, changed) => { for (const item of before) if (!changed.includes(item.id)) assert.deepEqual(xy(list, item.id), [item.x, item.y], `${item.id} must not move`); };

test('k: arrangeNewBranch mid-column insert pushes the later siblings and their subtrees, nothing else', () => {
  const nodes = [node('root', null, 0, 0), node('p1', 'root', 360, 0), node('p2', 'root', 360, 124), node('p2k', 'p2', 720, 124), node('n', 'root', 0, 0), node('p3', 'root', 360, 248), node('p3k', 'p3', 720, 248), node('far', null, 0, 2000)];
  const out = place(nodes, ['n']);
  assert.ok(xy(out, 'n')[1] >= 224 && xy(out, 'n')[1] < xy(out, 'p3')[1]);
  assert.ok(xy(out, 'p3')[1] > 248);
  assert.equal(xy(out, 'p3k')[1] - xy(out, 'p3')[1], 0);
  sameExcept(nodes, out, ['n', 'p3', 'p3k']);
  noOverlap({ nodes: out }, heights(), (a, b) => a.id === 'root' || b.id === 'root' || a.id === 'far' || b.id === 'far');
});

test('l: arrangeNewBranch ten new cards in the middle keep earlier cards and push the later branch down', () => {
  const fresh = Array.from({ length: 10 }, (_, i) => node(`n${i}`, 'root', 0, 0));
  const nodes = [node('root', null, 0, 0), node('p1', 'root', 360, 0), node('p2', 'root', 360, 124), ...fresh, node('p3', 'root', 360, 248), node('p3k', 'p3', 720, 248), node('far', null, 0, 2000)];
  const out = place(nodes, fresh.map(item => item.id));
  assert.ok(xy(out, 'p3')[1] >= xy(out, 'n9')[1] + H);
  assert.ok(xy(out, 'n0')[1] >= 224);
  sameExcept(nodes, out, [...fresh.map(item => item.id), 'p3', 'p3k']);
  noOverlap({ nodes: out }, heights(), (a, b) => a.id === 'root' || b.id === 'root' || a.id === 'far' || b.id === 'far');
});

test('m: arrangeNewBranch down map keeps the slide-along-x rule: nothing else moves', () => {
  const nodes = [node('root', null, 0, 0), node('a', 'root', 0, 200), node('n', 'root', 0, 0), node('b', 'root', 330, 200), node('far', null, 0, 2000)];
  const out = place(nodes, ['n'], 'down');
  sameExcept(nodes, out, ['n']);
});

test('n: arrangeNewBranch passes boxOf to the push (a wider measured previous card makes more room)', () => {
  const nodes = [node('root', null, 0, 0), node('p1', 'root', 360, 0), node('n', 'root', 0, 0), node('p3', 'root', 360, 124)];
  const boxOf = id => (id === 'p1' ? { dx: 0, dy: 0, w: 280, h: 400 } : undefined);
  const out = place(nodes, ['n'], 'right', { push: { boxOf } });
  assert.ok(xy(out, 'n')[1] >= 400);
});

test('o: a card already drawn and moved is measured where it is now (boxOf is an offset, not a stored position)', () => {
  // m was drawn far below; this arrangement put it at y 124 on top of p2 (which has a 300-high drawn box).
  const nodes = [...column(), node('m', 'root', 360, 124)];
  const boxOf = id => ({ dx: 0, dy: 0, w: 280, h: id === 'p2' ? 300 : 100 });
  const result = push.pushAffected(nodes, new Set(['m']), { boxOf, heightOf: heights(), decorations: [], layout: { direction: 'right' } });
  const [, my] = pos(result, 'm');
  const [, p2y] = pos(result, 'p2');
  const m = { l: 360, r: 640, t: my, b: my + 100 }, p2 = { l: 360, r: 640, t: p2y, b: p2y + 300 };
  assert.equal(cross(m, p2), false, 'm and p2 must not overlap');
});

test('p: an old card pushed into a fixed text block moves on past it instead of spinning', () => {
  const nodes = [...column(), node('n', 'root', 360, 124), node('T', null, 360, 400, { path: '' })];
  const result = push.pushAffected(nodes, new Set(['n']), { heightOf: heights(), decorations: [], fixed: new Set(['T']), layout: { direction: 'right' } });
  assert.deepEqual(pos(result, 'T'), [360, 400], 'the text block stays');
  noOverlap(result);
});

test('q: a card inserted on top of many siblings is pushed in about linear time (against a baseline from the same run)', () => {
  const build = count => {
    const many = [node('root', null, 0, 0), node('n', 'root', 360, 0)];
    for (let i = 0; i < count; i++) many.push(node(`c${i}`, 'root', 360, i * 124));
    return many;
  };
  const timed = count => {
    const many = build(count);
    let best = Infinity, result;
    for (let k = 0; k < 3; k++) {
      const started = process.hrtime.bigint();
      result = push.pushAffected(many, new Set(['n']), { heightOf: heights(), decorations: [], layout: { direction: 'right' } });
      best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
    }
    return { best, result };
  };
  const small = timed(30);
  const large = timed(300);
  assert.deepEqual(pos(large.result, 'c299'), [360, 299 * 124 + 124]);
  // 10x the cards: linear is ~10x, quadratic ~100x, cubic ~1000x.
  assert.ok(large.best < 40 * Math.max(small.best, 0.2), `30 siblings ${small.best}ms, 300 siblings ${large.best}ms`);
});
