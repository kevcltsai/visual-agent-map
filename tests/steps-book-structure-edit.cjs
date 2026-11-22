// The editor's structure changes: simulated on a plain tree, each op checked, over-cap refused whole, undo closure and inverse ops.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const E = S.load('core/book-pipeline/structure-edit.ts');

const plain = value => JSON.parse(JSON.stringify(value));
const N = (id, parentId, title = id) => ({ id, parentId, title });
// r: c1 (s1a, s1b), c2 (s2a), c3
const INPUT = { rootId: 'r', nodes: [N('r', null), N('c1', 'r'), N('s1a', 'c1'), N('s1b', 'c1'), N('c2', 'r'), N('s2a', 'c2'), N('c3', 'r')] };
const NONE = new Set();
let n = 0;
const op = o => ({ id: `S${++n}`, reason: 'because', ...o });
const run = (ops, locked = NONE) => E.simulateStructure(INPUT, ops, locked);
// Each op alone: a rejected op makes the ops that lean on its cards fail too, so independent refusals are checked one per run.
const eachCode = (ops, locked = NONE) => ops.map(o => codes(run([o], locked))[0]);
const shape = r => r.result.map(x => `${x.id}<${x.parentId ?? ''}`).join(' ');
const codes = r => plain(r.rejected.map(x => x.code));

test('edit: add puts a new card after a sibling, first when after is missing, and under another add', () => {
  const r = run([
    op({ kind: 'add', title: 'New A', summary: 's', parent: 'c1', after: 's1a', ref: 'new1' }),
    op({ kind: 'add', title: 'New B', summary: 's', parent: 'r', ref: 'new2' }),
    op({ kind: 'add', title: 'New C', summary: 's', parent: 'new2', ref: 'new3' }),
  ]);
  assert.equal(r.applied.length, 3);
  assert.equal(shape(r), 'r< new2<r new3<new2 c1<r s1a<c1 new1<c1 s1b<c1 c2<r s2a<c2 c3<r');
});

test('edit: remove a leaf, merge a leaf into another card, rename', () => {
  const r = run([op({ kind: 'remove', card: 's1a' }), op({ kind: 'merge', card: 's2a', into: 's1b' }), op({ kind: 'rename', card: 'c3', title: 'Third' })]);
  assert.equal(r.applied.length, 3);
  assert.equal(shape(r), 'r< c1<r s1b<c1 c2<r c3<r');
  assert.equal(r.result.find(x => x.id === 'c3').title, 'Third');
});

test('edit: move within a level changes the order', () => {
  assert.equal(shape(run([op({ kind: 'move', card: 'c3', parent: 'r' })])), 'r< c3<r c1<r s1a<c1 s1b<c1 c2<r s2a<c2');
  assert.equal(shape(run([op({ kind: 'move', card: 's1a', parent: 'c1', after: 's1b' })])), 'r< c1<r s1b<c1 s1a<c1 c2<r s2a<c2 c3<r');
});

test('edit: move a section to another chapter', () => {
  assert.equal(shape(run([op({ kind: 'move', card: 's1b', parent: 'c3' })])), 'r< c1<r s1a<c1 c2<r s2a<c2 c3<r s1b<c3');
});

test('edit: a section becomes a chapter (parent is the root)', () => {
  assert.equal(shape(run([op({ kind: 'move', card: 's2a', parent: 'r', after: 'c1' })])), 'r< c1<r s1a<c1 s1b<c1 s2a<r c2<r c3<r');
});

test('edit: a chapter without sections becomes a section', () => {
  assert.equal(shape(run([op({ kind: 'move', card: 'c3', parent: 'c1', after: 's1a' })])), 'r< c1<r s1a<c1 c3<c1 s1b<c1 c2<r s2a<c2');
});

test('edit: unknown cards, also in after and into', () => {
  const r = run([op({ kind: 'remove', card: 'zz' }), op({ kind: 'move', card: 'c3', parent: 'r', after: 'zz2' }), op({ kind: 'merge', card: 's1a', into: 'zz3' }), op({ kind: 'add', title: 'T', summary: '', parent: 'zz4', ref: 'n1' })]);
  assert.deepEqual(codes(r), ['unknown_card', 'unknown_card', 'unknown_card', 'unknown_card']);
  assert.equal(shape(r), shape({ result: INPUT.nodes }));
});

test('edit: after must be a child of the target parent', () => {
  assert.deepEqual(codes(run([op({ kind: 'move', card: 'c3', parent: 'c1', after: 's2a' })])), ['unknown_card']);
});

test('edit: the root cannot be removed, merged, moved or renamed, nor merged into', () => {
  const r = eachCode([op({ kind: 'remove', card: 'r' }), op({ kind: 'merge', card: 'r', into: 'c1' }), op({ kind: 'move', card: 'r', parent: 'c1' }), op({ kind: 'rename', card: 'r', title: 'x' }), op({ kind: 'merge', card: 's1a', into: 'r' })]);
  assert.deepEqual(r, ['root', 'root', 'root', 'root', 'root']);
});

test('edit: locked cards cannot be removed, merged (either side), moved or renamed', () => {
  const locked = new Set(['s1a', 's2a']);
  const r = eachCode([op({ kind: 'remove', card: 's1a' }), op({ kind: 'merge', card: 's1b', into: 's1a' }), op({ kind: 'merge', card: 's1a', into: 's1b' }), op({ kind: 'move', card: 's2a', parent: 'c3' }), op({ kind: 'rename', card: 's2a', title: 'x' })], locked);
  assert.deepEqual(r, ['locked', 'locked', 'locked', 'locked', 'locked']);
});

test('edit: a chapter holding a locked card cannot be removed, merged or demoted', () => {
  const locked = new Set(['s1a']);
  const r = eachCode([op({ kind: 'remove', card: 'c1' }), op({ kind: 'merge', card: 'c1', into: 'c2' }), op({ kind: 'move', card: 'c1', parent: 'c2' })], locked);
  assert.deepEqual(r, ['locked', 'locked', 'locked']);
  assert.equal(codes(run([op({ kind: 'move', card: 'c1', parent: 'r', after: 'c2' })], locked)).length, 0, 'reordering it is fine');
});

test('edit: removing or merging a card that still has children is refused', () => {
  const r = run([op({ kind: 'remove', card: 'c2' }), op({ kind: 'merge', card: 'c1', into: 'c3' })]);
  assert.deepEqual(codes(r), ['has_children', 'has_children']);
});

test('edit: removing the children first lets the parent be removed', () => {
  const r = run([op({ kind: 'remove', card: 's2a' }), op({ kind: 'remove', card: 'c2' })]);
  assert.equal(r.applied.length, 2);
  assert.equal(shape(r), 'r< c1<r s1a<c1 s1b<c1 c3<r');
});

test('edit: a chapter with sections cannot become a section', () => {
  assert.deepEqual(codes(run([op({ kind: 'move', card: 'c1', parent: 'c3' })])), ['chapter_has_sections']);
});

test('edit: a move under itself or its own descendant is a cycle; so is merging into itself', () => {
  assert.deepEqual(eachCode([op({ kind: 'move', card: 's1a', parent: 's1a' }), op({ kind: 'merge', card: 's1a', into: 's1a' })]), ['cycle', 'cycle']);
  const r = run([op({ kind: 'move', card: 's1b', parent: 's1a' }), op({ kind: 'move', card: 's1a', parent: 's1b' })]);
  assert.equal(r.applied.length, 1);
  assert.deepEqual(codes(r), ['cycle']);
});

test('edit: merging into a card that was already removed is refused', () => {
  const r = run([op({ kind: 'remove', card: 's1a' }), op({ kind: 'merge', card: 's1b', into: 's1a' })]);
  assert.deepEqual(codes(r), ['unknown_card']);
});

test('edit: titles are cleaned to one safe line; empty, over 80 or only unsafe characters is bad_title', () => {
  const r = run([
    op({ kind: 'rename', card: 'c3', title: '  A/B:\n"C"?#[x] ' }),
    op({ kind: 'rename', card: 'c2', title: '/\\:*?' }),
    op({ kind: 'rename', card: 'c1', title: 'x'.repeat(81) }),
    op({ kind: 'add', title: '   ', summary: '', parent: 'r', ref: 'n1' }),
  ]);
  assert.equal(r.result.find(x => x.id === 'c3').title, 'AB Cx');
  assert.deepEqual(codes(r), ['bad_title', 'bad_title', 'bad_title']);
  assert.equal(r.applied[0].op.title, 'AB Cx');
});

test('edit: reasons are one line and at most 120 characters; the input is not changed', () => {
  const o = op({ kind: 'rename', card: 'c3', title: 'T', reason: `a\nb ${'z'.repeat(200)}` });
  const before = plain(INPUT);
  const r = run([o]);
  assert.equal(r.applied[0].op.reason.length, 120);
  assert.ok(!r.applied[0].op.reason.includes('\n'));
  assert.deepEqual(plain(INPUT), before);
  assert.ok(o.reason.includes('\n'), 'the op passed in is untouched');
});

test('edit: an add with a used ref is refused', () => {
  assert.deepEqual(codes(run([op({ kind: 'add', title: 'T', summary: '', parent: 'r', ref: 'c1' })])), ['bad_ref']);
});

test('edit: ops leaning on a rejected add or on a card a rejected op named are dropped too', () => {
  const r = run([
    op({ kind: 'add', title: '', summary: '', parent: 'r', ref: 'new1' }),
    op({ kind: 'add', title: 'Child', summary: '', parent: 'new1', ref: 'new2' }),
    op({ kind: 'remove', card: 'c2' }),
    op({ kind: 'rename', card: 'c2', title: 'Z' }),
    op({ kind: 'move', card: 'c3', parent: 'r', after: 'c2' }),
  ]);
  assert.deepEqual(codes(r), ['bad_title', 'depends_on_rejected', 'has_children', 'depends_on_rejected', 'depends_on_rejected']);
  assert.equal(r.applied.length, 0);
});

test('edit: more than 6 ops or more than 3 adds applies nothing, truncates nothing', () => {
  const seven = Array.from({ length: 7 }, () => op({ kind: 'rename', card: 'c3', title: 'X' }));
  const r7 = run(seven);
  assert.equal(r7.overCap, true);
  assert.deepEqual(plain(r7.applied), []);
  assert.deepEqual(plain(r7.result), plain(INPUT.nodes));
  const four = Array.from({ length: 4 }, (_, i) => op({ kind: 'add', title: `T${i}`, summary: '', parent: 'r', ref: `n${i}` }));
  const r4 = run(four);
  assert.equal(r4.overCap, true);
  assert.deepEqual(plain(r4.applied), []);
  assert.equal(run(seven.slice(0, 6)).overCap, undefined, 'exactly 6 is within the cap');
});

const CHAIN = () => [
  op({ kind: 'add', title: 'Fresh', summary: '', parent: 'c1', after: 's1a', ref: 'new1' }),
  op({ kind: 'move', card: 's2a', parent: 'new1' }),
  op({ kind: 'rename', card: 's2a', title: 'Renamed' }),
  op({ kind: 'rename', card: 'c3', title: 'Other' }),
];

test('closure: picking an add brings the ops placed under it and later edits of those cards, not unrelated ones', () => {
  const r = run(CHAIN());
  assert.equal(r.applied.length, 4);
  const [a, m, rn, other] = r.applied.map(x => x.id);
  assert.deepEqual([...E.undoClosure(r.applied, [a])].sort(), [a, m, rn].sort());
  assert.deepEqual([...E.undoClosure(r.applied, [m])].sort(), [m, rn].sort());
  assert.deepEqual([...E.undoClosure(r.applied, [other])], [other]);
  assert.deepEqual([...E.undoClosure(r.applied, [rn])], [rn], 'the last edit leans on nothing after it');
});

test('closure: a later op after a card that was moved comes along', () => {
  const r = run([op({ kind: 'move', card: 'c3', parent: 'r' }), op({ kind: 'move', card: 'c2', parent: 'r', after: 'c3' })]);
  assert.deepEqual([...E.undoClosure(r.applied, [r.applied[0].id])].sort(), plain(r.applied.map(x => x.id)).sort());
});

const roundTrip = ops => {
  const r = run(ops);
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
  const ids = new Set(r.applied.map(x => x.id));
  const inv = E.inverseOps(r.applied, ids);
  const back = E.applyInverseOps({ rootId: 'r', nodes: r.result }, inv);
  assert.deepEqual(plain(back), plain(INPUT.nodes));
  return inv;
};

test('inverse: add becomes a remove of the new card', () => {
  assert.deepEqual(plain(roundTrip([op({ kind: 'add', title: 'T', summary: '', parent: 'r', after: 'c1', ref: 'n1' })]).map(x => [x.kind, x.card])), [['remove', 'n1']]);
});

test('inverse: remove and merge restore the card to its parent and place', () => {
  const inv = roundTrip([op({ kind: 'remove', card: 's1b' }), op({ kind: 'merge', card: 's1a', into: 's2a' })]);
  assert.deepEqual(plain(inv.map(x => x.kind)), ['restore', 'restore']);
  assert.equal(inv[1].card, 's1b');
  assert.equal(inv[1].parent, 'c1');
});

test('inverse: each kind of move goes back', () => {
  roundTrip([op({ kind: 'move', card: 'c3', parent: 'r' })]);
  roundTrip([op({ kind: 'move', card: 's1b', parent: 'c3' })]);
  roundTrip([op({ kind: 'move', card: 's2a', parent: 'r', after: 'c1' })]);
  roundTrip([op({ kind: 'move', card: 'c3', parent: 'c1', after: 's1a' })]);
});

test('inverse: rename goes back to the original title, twice over too', () => {
  roundTrip([op({ kind: 'rename', card: 'c3', title: 'A' }), op({ kind: 'rename', card: 'c3', title: 'B' })]);
});

test('inverse: a chain of dependent ops undoes in reverse order to the original', () => {
  const inv = roundTrip(CHAIN());
  assert.deepEqual(plain(inv.map(x => x.kind)), ['rename', 'rename', 'move', 'remove']);
});

test('inverse: undoing one op through its closure leaves the independent ones', () => {
  const r = run(CHAIN());
  const ids = E.undoClosure(r.applied, [r.applied[0].id]);
  const back = E.applyInverseOps({ rootId: 'r', nodes: r.result }, E.inverseOps(r.applied, ids));
  assert.equal(back.find(x => x.id === 'c3').title, 'Other');
  assert.equal(back.find(x => x.id === 's2a').title, 's2a');
  assert.ok(!back.some(x => x.id === 'new1'));
});

test('inverse: simulating on a locked-free mix of all five kinds and undoing everything restores the original', () => {
  roundTrip([
    op({ kind: 'remove', card: 's1a' }),
    op({ kind: 'merge', card: 's2a', into: 's1b' }),
    op({ kind: 'move', card: 'c3', parent: 'r' }),
    op({ kind: 'rename', card: 'c1', title: 'One' }),
    op({ kind: 'add', title: 'N', summary: '', parent: 'c2', ref: 'n1' }),
  ]);
});

test('undo closure: moving the only section out of a chapter, then removing the empty chapter: undoing the move takes the removal too', () => {
  const r = run([op({ kind: 'move', card: 's2a', parent: 'c3' }), op({ kind: 'remove', card: 'c2' })]);
  assert.equal(r.applied.length, 2);
  const ids = E.undoClosure(r.applied, [r.applied[0].id]);
  assert.deepEqual(plain([...ids].sort()), plain(r.applied.map(a => a.id).sort()));
  const back = E.applyInverseOps({ rootId: 'r', nodes: r.result }, E.inverseOps(r.applied, ids));
  assert.equal(shape({ result: back }), shape({ result: INPUT.nodes }));
});

test('undo closure: removing a section, then merging its empty chapter away: undoing the removal takes the merge too', () => {
  const r = run([op({ kind: 'remove', card: 's2a' }), op({ kind: 'merge', card: 'c2', into: 'c3' })]);
  assert.equal(r.applied.length, 2);
  const ids = E.undoClosure(r.applied, [r.applied[0].id]);
  assert.deepEqual(plain([...ids].sort()), plain(r.applied.map(a => a.id).sort()));
  const back = E.applyInverseOps({ rootId: 'r', nodes: r.result }, E.inverseOps(r.applied, ids));
  assert.equal(shape({ result: back }), shape({ result: INPUT.nodes }));
});

test('undo closure: undoing a rename takes nothing else, even when later ops add or move cards around it', () => {
  const ops = [
    op({ kind: 'rename', card: 'c3', title: 'Third' }),
    op({ kind: 'add', title: 'New', summary: 's', parent: 'r', ref: 'new1' }),
    op({ kind: 'move', card: 'c2', parent: 'r' }),
  ];
  const r = run(ops);
  assert.equal(r.applied.length, 3);
  assert.deepEqual([...E.undoClosure(r.applied, [ops[0].id], 'r')], [ops[0].id]);
  const sec = [op({ kind: 'rename', card: 's1a', title: 'A' }), op({ kind: 'add', title: 'Under', summary: 's', parent: 'c1', ref: 'new2' })];
  const r2 = run(sec);
  assert.deepEqual([...E.undoClosure(r2.applied, [sec[0].id], 'r')], [sec[0].id]);
});

test('undo closure: a chapter that sat under the root does not pull in later root-level adds or moves', () => {
  const ops = [op({ kind: 'move', card: 'c3', parent: 'c2' }), op({ kind: 'add', title: 'New', summary: 's', parent: 'r', ref: 'new1' })];
  const r = run(ops);
  assert.equal(r.applied.length, 2);
  assert.deepEqual([...E.undoClosure(r.applied, [ops[0].id], 'r')], [ops[0].id]);
  // without the root id the old, wider rule still holds (callers always pass it)
  assert.equal(E.undoClosure(r.applied, [ops[0].id]).size, 2);
});

test('undo closure: random edits, undoing any one op through its closure never loses a card that existed before', () => {
  let seed = 7;
  const rnd = k => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % k);
  const ids = INPUT.nodes.map(x => x.id).filter(x => x !== 'r');
  for (let round = 0; round < 3000; round++) {
    const ops = [];
    let refs = 0;
    const pool = () => [...ids, ...Array.from({ length: refs }, (_, i) => `n${i}`)];
    for (let k = 0, count = 1 + rnd(6); k < count; k++) {
      const p = pool();
      const pick = () => p[rnd(p.length)];
      const kind = ['add', 'remove', 'merge', 'move', 'rename'][rnd(5)];
      const parent = rnd(3) === 0 ? 'r' : pick();
      if (kind === 'add' && refs < 3) ops.push({ id: `x${k}`, reason: 'r', kind, title: `T${k}`, summary: 's', parent, ref: `n${refs++}` });
      else if (kind === 'remove') ops.push({ id: `x${k}`, reason: 'r', kind, card: pick() });
      else if (kind === 'merge') ops.push({ id: `x${k}`, reason: 'r', kind, card: pick(), into: pick() });
      else if (kind === 'move') ops.push({ id: `x${k}`, reason: 'r', kind, card: pick(), parent });
      else ops.push({ id: `x${k}`, reason: 'r', kind: 'rename', card: pick(), title: `R${k}` });
    }
    const r = E.simulateStructure(INPUT, ops, NONE);
    if (r.overCap || !r.applied.length) continue;
    const after = { rootId: 'r', nodes: r.result };
    for (const a of r.applied) {
      const picked = E.undoClosure(r.applied, [a.id], 'r');
      const back = E.applyInverseOps(after, E.inverseOps(r.applied, picked));
      const present = new Set(back.map(x => x.id));
      for (const x of r.result) {
        if (x.id.startsWith('n')) continue;
        assert.ok(present.has(x.id), `round ${round}: undoing ${a.id} lost ${x.id}`);
      }
    }
  }
});
