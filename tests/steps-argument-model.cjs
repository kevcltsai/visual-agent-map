// Argument map data contract (P1): Map.md top-level `argumentMap` is carried through parse/serialize untouched, read by
// readArgumentMap, and a key this version cannot read stays byte-for-byte as saved while the flow refuses it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { core } = S;
const model = S.load('core/argument-map/model.ts');
const machine = S.load('core/argument-map/machine.ts');

const plain = value => JSON.parse(JSON.stringify(value));
const ROLES = { proposition: 'p', situation: 's', conclusion: 'c', verified: 'v', eliminated: 'e' };
const baseMap = extra => ({ version: 1, id: 'm1', title: 'T', nodes: ['p', 's', 'c', 'v', 'e'].map((id, i) => ({ id, path: `${id}.md`, parentId: null, x: i, y: 0, collapsed: false })), viewport: { x: 0, y: 0, zoom: 1 }, ...extra });
const usable = () => plain(machine.newArgumentMap(ROLES, 'run-1'));
/** Map.md text the way serializeMap writes it, then parse again. */
const roundTrip = text => core.serializeMap(core.parseMap(text));

test('a map without the key round-trips byte-identical and reads as absent', () => {
  const text = core.serializeMap(baseMap());
  assert.equal(roundTrip(text), text);
  assert.ok(!text.includes('argumentMap'));
  const parsed = core.parseMap(text);
  assert.equal(parsed.argumentMap, undefined);
  assert.equal(model.readArgumentMap(parsed).kind, 'absent');
  assert.equal(Object.keys(parsed).includes('argumentMap'), false, 'parse adds no key');
});
test('a usable key round-trips byte-identical and reads as usable', () => {
  const text = core.serializeMap(baseMap({ aiMode: 'quick', argumentMap: usable() }));
  assert.equal(roundTrip(text), text);
  const read = model.readArgumentMap(core.parseMap(text));
  assert.equal(read.kind, 'usable');
  assert.equal(read.data.run.runId, 'run-1');
  assert.equal(read.data.v, 1);
});
test('key order of the other top-level keys is unchanged by the pass-through', () => {
  const text = core.serializeMap(baseMap({ aiMode: 'quick', argumentMap: usable(), layout: { direction: 'right' } }));
  assert.deepEqual(Object.keys(JSON.parse(text.match(/```agent-map\n([\s\S]*?)\n```/)[1])), Object.keys(core.parseMap(text)));
});

// Corrupt or newer-version keys: every one stays verbatim, reads unusable, never throws out of parseMap.
const corrupt = {
  'v:2': s => { s.v = 2; },
  'v missing': s => { delete s.v; },
  'unknown run phase': s => { s.run.phase = 'warp'; },
  'unknown run status': s => { s.run.status = 'dreaming'; },
  'unknown stop reason': s => { s.run.stopReason = 'boredom'; },
  'unknown gate state': s => { s.situation.gate.state = 'maybe'; },
  'unknown conclusion state': s => { s.conclusion.state = 'victory'; },
  'unknown hypothesis location': s => { s.hypotheses.push({ id: 'h1', citedData: [], round: 1, location: 'limbo', needs: [] }); },
  'unknown need state': s => { s.hypotheses.push({ id: 'h1', citedData: [], round: 1, location: 'verifying', needs: [{ id: 'n1', text: 'x', addedRound: 1, state: 'lost' }] }); },
  'unknown stance': s => { s.situation.data.push({ id: 'd1', need: 'x', attempts: 0, state: 'found', stance: 'shrug' }); },
  'unknown proof check': s => { s.situation.data.push({ id: 'd1', need: 'x', attempts: 1, state: 'found', stance: 'supports', proof: { url: 'https://a.b', quote: 'q', claim: 'c', check: 'vibes', checkedAt: 't' } }); },
  'role points to a missing node': s => { s.roles.conclusion = 'ghost'; },
  'role missing': s => { delete s.roles.eliminated; },
  'duplicate id': s => { s.hypotheses.push({ id: 'h', citedData: [], round: 1, location: 'verifying', needs: [] }, { id: 'h', citedData: [], round: 1, location: 'verifying', needs: [] }); },
  'negative counter': s => { s.run.researchCalls = -1; },
  'not an object': (s, doc) => { doc.argumentMap = 'oops'; },
  'array': (s, doc) => { doc.argumentMap = []; },
  'null': (s, doc) => { doc.argumentMap = null; },
  'future field with v:2 and extra data': s => { s.v = 2; s.futureThing = { deep: [1, 2, { x: 'y' }] }; }
};
for (const [name, edit] of Object.entries(corrupt)) {
  test(`unusable but preserved: ${name}`, () => {
    const doc = baseMap({ argumentMap: usable() });
    edit(doc.argumentMap, doc);
    const text = core.serializeMap(doc);
    const parsed = core.parseMap(text);
    assert.deepEqual(plain(parsed.argumentMap), plain(doc.argumentMap), 'parse keeps the value as saved');
    assert.equal(roundTrip(text), text, 'serialize writes it back byte for byte');
    const read = model.readArgumentMap(parsed);
    assert.equal(read.kind, 'unusable');
    assert.ok(read.reason);
    assert.deepEqual(plain(read.raw), plain(doc.argumentMap));
    assert.deepEqual(plain(parsed.nodes), plain(doc.nodes), 'the map still opens as an ordinary map');
  });
}
test('reading never changes the stored value', () => {
  const doc = baseMap({ argumentMap: usable() });
  doc.argumentMap.v = 2;
  const before = JSON.stringify(doc.argumentMap);
  model.readArgumentMap(doc);
  assert.equal(JSON.stringify(doc.argumentMap), before);
});
test('a role pointing at a node that exists in the map is usable; the same role after the node is gone is not', () => {
  const doc = baseMap({ argumentMap: usable() });
  assert.equal(model.readArgumentMap(doc).kind, 'usable');
  doc.nodes = doc.nodes.filter(n => n.id !== 'v');
  assert.equal(model.readArgumentMap(doc).kind, 'unusable');
});
test('the flow refuses an unusable key: nothing in the machine accepts what readArgumentMap rejected', () => {
  const doc = baseMap({ argumentMap: usable() });
  doc.argumentMap.run.phase = 'warp';
  const read = model.readArgumentMap(doc);
  assert.equal(read.data, undefined, 'unusable carries no data the runner could use');
  assert.equal(read.kind === 'usable', false);
});
test('an existing map with other optional keys and no argumentMap is unaffected (aiMode, layout, relations)', () => {
  const doc = baseMap({ aiMode: 'quick', layout: { direction: 'right' }, topicRelations: [{ kind: 'supports', from: 'p', to: 's' }] });
  const text = core.serializeMap(doc);
  assert.equal(roundTrip(text), text);
});
