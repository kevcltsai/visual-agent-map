// Image ring P1 (A3, A4 pure part): the invariants of ringViolations on real and synthetic anchors, counter-examples, determinism, membership.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support.cjs');
const ring = load('experiences/visual-map/image-ring.ts');
const fixture = require('./fixtures/image-ring-anchors.json');
const plain = value => JSON.parse(JSON.stringify(value));
const viol = (...args) => plain(ring.ringViolations(...args));

const IMAGE = { x: 100, y: 50, w: 716, h: 512 };
const toCards = (anchors, size = () => ({ w: 280, h: 110 })) => anchors.map(([x, y], i) => ({ id: `t${i}`, anchorX: x, anchorY: y, ...size(i) }));
const states = (layout, inputs) =>
  layout.cards.map(c => {
    const input = inputs.find(i => i.id === c.id);
    return { id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, anchorX: input.anchorX, anchorY: input.anchorY };
  });
const check = (image, inputs) => {
  const layout = ring.solveRing(image, inputs);
  return { layout, violations: viol(image, states(layout, inputs), { memberCount: inputs.length }) };
};
// Deterministic pseudo-random numbers so the cases never change between runs.
const lcg = seed => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

const cluster12 = Array.from({ length: 12 }, (_, i) => [0.05 + 0.01 * i, 0.05 + 0.005 * i]);
const n3 = [[0.2, 0.2], [0.5, 0.8], [0.8, 0.3]];
const n30 = Array.from({ length: 30 }, (_, i) => [((i * 37) % 100) / 100, ((i * 61) % 100) / 100]);
const cases = { mockup11: fixture.mockup11, claude12: fixture.claude12, luna12: fixture.luna12, cluster12, n3, n30 };

test('A3: every case has no violation at both card sizes of the prototype', () => {
  for (const [name, anchors] of Object.entries(cases))
    for (const size of [{ w: 280, h: 110 }, { w: 280, h: 180 }]) {
      const { violations, layout } = check(IMAGE, toCards(anchors, () => size));
      assert.deepEqual(violations, [], `${name} ${size.h}`);
      assert.equal(layout.cards.length, anchors.length);
    }
});

test('A3: mixed card sizes (width 280-560, height 110-260) have no violation, over many random rings', () => {
  const random = lcg(7);
  for (let round = 0; round < 60; round++) {
    const n = 1 + Math.floor(random() * 30);
    const anchors = Array.from({ length: n }, () => (random() < 0.3 ? [0.5, 0.5] : [random(), random()]));
    const inputs = toCards(anchors, () => ({ w: 280 + Math.floor(random() * 281), h: 110 + Math.floor(random() * 151) }));
    const image = round % 3 === 0 ? { x: -40, y: 10, w: 512, h: 720 } : IMAGE;
    assert.deepEqual(check(image, inputs).violations, [], `round ${round} n=${n}`);
  }
  for (const [name, anchors] of Object.entries(cases)) {
    const random2 = lcg(name.length);
    const inputs = toCards(anchors, () => ({ w: 280 + Math.floor(random2() * 281), h: 110 + Math.floor(random2() * 151) }));
    assert.deepEqual(check(IMAGE, inputs).violations, [], name);
  }
});

test('A3: cards keep their distance (24) from each other and a corner never touches', () => {
  const inputs = toCards(cases.n30, i => ({ w: 280 + (i % 4) * 80, h: 110 + (i % 5) * 35 }));
  const { layout } = check(IMAGE, inputs);
  const grown = layout.cards.map(c => ({ x: c.x - 11.99, y: c.y - 11.99, w: c.w + 23.98, h: c.h + 23.98 }));
  for (let i = 0; i < grown.length; i++)
    for (let j = i + 1; j < grown.length; j++) {
      const a = grown[i], b = grown[j];
      assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), `${i} ${j} closer than 24`);
    }
});

test('A3: edge cases hold: no members, two anchors on one point, missing size, a card with two anchors is one card, tall and huge pictures', () => {
  assert.deepEqual(plain(ring.solveRing(IMAGE, []).cards), []);
  assert.deepEqual(viol(IMAGE, [], { memberCount: 0 }), []);
  assert.deepEqual(check(IMAGE, toCards([[0.5, 0.5], [0.5, 0.5], [0.5, 0.5]])).violations, [], 'same coordinates');
  const bare = [{ id: 'a', anchorX: 0.3, anchorY: 0.3 }, { id: 'b', anchorX: 0.6, anchorY: 0.4 }];
  const { layout, violations } = check(IMAGE, bare);
  assert.deepEqual(violations, []);
  assert.deepEqual(layout.cards.map(c => [c.w, c.h]), [[280, 180], [280, 180]], 'default size is a card width and DEFAULT_CARD_HEIGHT');
  assert.deepEqual(check({ x: 0, y: 0, w: 300, h: 1800 }, toCards(cases.claude12)).violations, [], 'tall');
  assert.deepEqual(check({ x: 0, y: 0, w: 4000, h: 3000 }, toCards(cases.n30)).violations, [], 'huge');
  assert.deepEqual(check(IMAGE, toCards([[-1, 2], [3, -4]])).violations, [], 'anchors outside 0-1 are clamped to the picture');
});

test('A3: same input gives the same layout, and the slot count grows R when needed', () => {
  const inputs = toCards(cases.n30);
  assert.equal(JSON.stringify(ring.solveRing(IMAGE, inputs)), JSON.stringify(ring.solveRing(IMAGE, inputs)));
  const small = ring.solveRing(IMAGE, toCards(cases.n3)).clearance;
  const big = ring.solveRing(IMAGE, inputs).clearance;
  assert.equal(small.x, IMAGE.x - 64, 'R starts 64 out');
  assert.ok(big.w > small.w, '30 cards need a bigger R');
  assert.equal(ring.ringSlots(IMAGE, 12, { w: 280, h: 110 }).slots.length >= 12, true);
});

test('A3: ringViolations names each kind of defect (counter-examples)', () => {
  const inputs = toCards(cases.mockup11);
  const base = states(ring.solveRing(IMAGE, inputs), inputs);
  const codes = list => viol(IMAGE, list, { memberCount: inputs.length }).map(v => v.code);
  assert.deepEqual(codes(base), []);
  const withCard = (i, patch) => base.map((c, k) => (k === i ? { ...c, ...patch } : c));
  assert.ok(codes(withCard(0, { x: base[1].x + 10, y: base[1].y + 10 })).includes('overlap'), 'dragged onto another card');
  assert.ok(codes(withCard(0, { x: IMAGE.x + 100, y: IMAGE.y + 100 })).includes('card-on-image'), 'dragged onto the picture');
  // A card dragged into R, onto another card's line (not onto the picture), blocks that line.
  const line = ring.ringLine(IMAGE, inputs[1].anchorX, inputs[1].anchorY, base[1]);
  const at = { x: line.x1 + (line.x2 - line.x1) * 0.85, y: line.y1 + (line.y2 - line.y1) * 0.85 };
  const blocked = ring.ringViolations(IMAGE, withCard(0, { x: at.x - 140, y: at.y - 55 }), { memberCount: inputs.length });
  assert.ok(blocked.some(v => v.code === 'line-through-card' && v.ids[0] === 't1' && v.ids[1] === 't0'), 'a card on another card line');
  assert.ok(codes(base.slice(1)).includes('count'), 'one card missing');
  assert.ok(codes([...base, { ...base[0] }]).includes('count'), 'duplicate id / extra card');
  // Swap the positions of two cards on different sides: lines cross and a swap back is shorter.
  const a = base.findIndex(c => ring.ringSide(IMAGE, c) === 'left');
  const b = base.findIndex(c => ring.ringSide(IMAGE, c) === 'right');
  const swapped = base.map((c, k) => (k === a ? { ...c, x: base[b].x, y: base[b].y } : k === b ? { ...c, x: base[a].x, y: base[a].y } : c));
  const swappedCodes = codes(swapped);
  assert.ok(swappedCodes.includes('pairing'), 'not a shortest matching');
  assert.ok(swappedCodes.includes('crossing') || swappedCodes.includes('line-through-card'));
  assert.ok(viol(IMAGE, base, { others: [{ x: base[0].x, y: base[0].y, w: 10, h: 10 }] }).some(v => v.code === 'overlap-other'));
});

test('A3: the line goes from the anchor to the middle of the picture-facing edge, and ringSide agrees with the slot', () => {
  const { layout } = check(IMAGE, toCards(cases.luna12));
  for (const c of layout.cards) {
    assert.equal(ring.ringSide(IMAGE, c), c.side);
    const line = ring.ringLine(IMAGE, 0, 0, c);
    assert.equal(line.x2, c.line.x2);
    assert.equal(line.y2, c.line.y2);
  }
  assert.equal(ring.ringSide(IMAGE, { x: 0, y: 0, w: 280, h: 110 }), 'top', 'a corner tie is vertical');
  assert.equal(ring.ringSide(IMAGE, { x: 2000, y: 100, w: 280, h: 110 }), 'right');
  assert.equal(ring.ringSide(IMAGE, { x: -500, y: 100, w: 280, h: 110 }), 'left');
  assert.equal(ring.ringSide(IMAGE, { x: 300, y: 900, w: 280, h: 110 }), 'bottom');
});

test('A4: a picture shorter than 720 is scaled up about its centre, a bigger one is not touched, and scaling twice changes nothing', () => {
  const small = { x: 100, y: 200, w: 320, h: 160 };
  const big = ring.ringImageSize(small);
  assert.deepEqual(plain(big), { x: -100, y: 100, w: 720, h: 360 });
  assert.equal(big.x + big.w / 2, 260);
  assert.equal(big.y + big.h / 2, 280);
  assert.equal(big.w / big.h, small.w / small.h);
  assert.deepEqual(plain(ring.ringImageSize(big)), plain(big));
  const tall = ring.ringImageSize({ x: 0, y: 0, w: 200, h: 400 });
  assert.deepEqual([tall.w, tall.h], [360, 720]);
  assert.deepEqual(plain(ring.ringImageSize({ x: 5, y: 6, w: 720, h: 100 })), { x: 5, y: 6, w: 720, h: 100 });
  assert.deepEqual(plain(ring.ringImageSize({ x: 5, y: 6, w: 3000, h: 100 })), { x: 5, y: 6, w: 3000, h: 100 });
  assert.deepEqual(plain(ring.ringImageSize({ x: 1, y: 2, w: 0, h: 0 })), { x: 1, y: 2, w: 0, h: 0 }, 'a zero size is left alone');
});

const anchorOf = (id, x, y) => ({ id, at: { kind: 'image-2d', x, y } });
const image = (id, anchors, relations) => ({ id, kind: 'annotated-image', path: 'a.png', x: 0, y: 0, w: 10, h: 10, anchors, relations });
const nodes = (...pairs) => pairs.map(([id, parentId]) => ({ id, parentId }));

test('A1: ringMembers takes only ring:true relations to existing parentless topics', () => {
  const items = [image('g1', [anchorOf('p1', 0.1, 0.2), anchorOf('p2', 0.3, 0.4), anchorOf('p3', 0.5, 0.6), { id: 'f', at: { kind: 'model-3d', z: 1 } }], [
    { kind: 'related', from: 'p1', to: 't1', ring: true },
    { kind: 'related', from: 't2', to: 'p2', ring: true },
    { kind: 'related', from: 'p3', to: 't3' },
    { kind: 'related', from: 'p3', to: 'gone', ring: true },
    { kind: 'related', from: 'p3', to: 'child', ring: true },
    { kind: 'related', from: 'f', to: 't1', ring: true }
  ])];
  const all = nodes(['t1', null], ['t2', null], ['t3', null], ['child', 't1']);
  assert.deepEqual(plain(ring.ringMembers(items, all)), [
    { imageId: 'g1', topicId: 't1', anchorId: 'p1', x: 0.1, y: 0.2 },
    { imageId: 'g1', topicId: 't2', anchorId: 'p2', x: 0.3, y: 0.4 }
  ]);
  assert.deepEqual(plain(ring.ringMembers(items, nodes(['t1', 'x'], ['t2', 'x']))), [], 'a card dragged under another is out');
  assert.deepEqual(plain(ring.ringMembers([], all)), []);
  assert.deepEqual(plain(ring.ringMembers([image('g1', [], undefined)], all)), []);
});

test('A1: a card marked by two pictures belongs to the first, and a card with two anchors is one member', () => {
  const g1 = image('g1', [anchorOf('p1', 0.1, 0.1), anchorOf('p2', 0.9, 0.9)], [
    { kind: 'related', from: 'p1', to: 't1', ring: true },
    { kind: 'related', from: 'p2', to: 't1', ring: true }
  ]);
  const g2 = image('g2', [anchorOf('q1', 0.5, 0.5)], [{ kind: 'related', from: 'q1', to: 't1', ring: true }, { kind: 'related', from: 'q1', to: 't2', ring: true }]);
  const members = ring.ringMembers([g1, g2], nodes(['t1', null], ['t2', null]));
  assert.deepEqual(plain(members.map(m => [m.imageId, m.topicId, m.anchorId])), [['g1', 't1', 'p1'], ['g2', 't2', 'q1']]);
});

test('A3: placeNewMember uses a free slot without moving anyone, and returns null when nothing is free', () => {
  const inputs = toCards(cases.claude12.slice(0, 8));
  const layout = ring.solveRing(IMAGE, inputs);
  const current = states(layout, inputs);
  const before = JSON.stringify(current);
  const more = { id: 'new', anchorX: 0.5, anchorY: 0.5, w: 280, h: 110 };
  const spot = ring.placeNewMember(IMAGE, current, more);
  assert.ok(spot);
  assert.equal(JSON.stringify(current), before, 'existing cards untouched');
  assert.deepEqual(viol(IMAGE, [...current, { id: 'new', x: spot.x, y: spot.y, w: spot.w, h: spot.h, anchorX: 0.5, anchorY: 0.5 }]), []);
  assert.deepEqual(plain(ring.placeNewMember(IMAGE, current, more)), plain(spot), 'deterministic');
  // Every card of the ring got in the way, including a hand-dragged one: no free slot.
  const wall = { x: -5000, y: -5000, w: 10000, h: 10000 };
  assert.equal(ring.placeNewMember(IMAGE, current, more, [wall]), null);
  assert.equal(ring.placeNewMember(IMAGE, [], more) !== null, true, 'an empty ring has room');
});

test('A3: placeNewMember in a full ring grows into a larger slot ring or returns null, never a violation', () => {
  const inputs = toCards(cases.n30);
  const current = states(ring.solveRing(IMAGE, inputs), inputs);
  const spot = ring.placeNewMember(IMAGE, current, { id: 'new', anchorX: 0.1, anchorY: 0.9 });
  if (spot) assert.deepEqual(viol(IMAGE, [...current, { id: 'new', x: spot.x, y: spot.y, w: spot.w, h: spot.h, anchorX: 0.1, anchorY: 0.9 }]), []);
});

test('A3: findFreeOffset leaves a clear ring alone and otherwise finds the smallest clear shift, same every time', () => {
  const box = { x: 0, y: 0, w: 1000, h: 800 };
  assert.deepEqual(plain(ring.findFreeOffset(box, [])), { dx: 0, dy: 0 });
  assert.deepEqual(plain(ring.findFreeOffset(box, [{ x: 2000, y: 0, w: 100, h: 100 }])), { dx: 0, dy: 0 });
  const obstacles = [{ x: 900, y: 700, w: 300, h: 200 }, { x: -400, y: 300, w: 450, h: 100 }];
  const shift = ring.findFreeOffset(box, obstacles);
  const moved = { ...box, x: box.x + shift.dx, y: box.y + shift.dy };
  for (const o of obstacles) assert.ok(!(moved.x < o.x + o.w && o.x < moved.x + moved.w && moved.y < o.y + o.h && o.y < moved.y + moved.h), 'clear');
  assert.deepEqual(plain(ring.findFreeOffset(box, obstacles)), plain(shift));
  const surrounded = [{ x: -3000, y: -3000, w: 7000, h: 7000 }];
  const out = ring.findFreeOffset(box, surrounded);
  assert.ok(out.dx !== 0 || out.dy !== 0, 'always a way out');
});

test('A3: moveRing shifts picture, cards and lines together and changes nothing else', () => {
  const inputs = toCards(cases.mockup11);
  const layout = ring.solveRing(IMAGE, inputs);
  const moved = ring.moveRing(IMAGE, layout.cards, 30, -20);
  assert.deepEqual(plain(moved.image), { ...IMAGE, x: IMAGE.x + 30, y: IMAGE.y - 20 });
  moved.cards.forEach((c, i) => {
    const o = layout.cards[i];
    assert.deepEqual([c.x - o.x, c.y - o.y, c.line.x1 - o.line.x1, c.line.y2 - o.line.y2, c.w, c.h, c.id], [30, -20, 30, -20, o.w, o.h, o.id]);
  });
  assert.deepEqual(viol(moved.image, moved.cards.map((c, i) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, anchorX: inputs[i].anchorX, anchorY: inputs[i].anchorY }))), []);
  assert.deepEqual(plain(ring.ringBounds(IMAGE, [])), IMAGE);
  const bounds = ring.ringBounds(IMAGE, layout.cards);
  assert.ok(bounds.w > IMAGE.w && bounds.h > IMAGE.h);
});
