// Argument map data contract (P1; rewritten for argumentMap v2 + legacy v1, V2 packet V1): Map.md top-level `argumentMap` is carried through parse/serialize untouched, read by
// readArgumentMap, and a key this version cannot read stays byte-for-byte as saved while the flow refuses it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { core } = S;
const model = S.load('core/argument-map/model.ts');
const modelV1 = S.load('core/argument-map/model-v1.ts');
const machine = S.load('core/argument-map/machine.ts');
const { v2State } = require('./fixtures/argument-map-v2-state.cjs');

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
test('a version 1 key round-trips byte-identical and reads as legacy (read-only), carrying the v1 data', () => {
  const text = core.serializeMap(baseMap({ aiMode: 'quick', argumentMap: usable() }));
  assert.equal(roundTrip(text), text);
  const read = model.readArgumentMap(core.parseMap(text));
  assert.equal(read.kind, 'legacy');
  assert.equal(read.data.run.runId, 'run-1');
  assert.equal(read.data.v, 1);
});
test('key order of the other top-level keys is unchanged by the pass-through', () => {
  const text = core.serializeMap(baseMap({ aiMode: 'quick', argumentMap: usable(), layout: { direction: 'right' } }));
  assert.deepEqual(Object.keys(JSON.parse(text.match(/```agent-map\n([\s\S]*?)\n```/)[1])), Object.keys(core.parseMap(text)));
});

// Corrupt or newer-version keys: every one stays verbatim, reads unusable, never throws out of parseMap.
const corrupt = {
  'v:3': s => { s.v = 3; },
  'v:0': s => { s.v = 0; },
  'v as string': s => { s.v = '1'; },
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
  'future field with v:3 and extra data': s => { s.v = 3; s.futureThing = { deep: [1, 2, { x: 'y' }] }; }
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
  doc.argumentMap.v = 3;
  const before = JSON.stringify(doc.argumentMap);
  model.readArgumentMap(doc);
  assert.equal(JSON.stringify(doc.argumentMap), before);
});
test('a role pointing at a node that exists in the map is legacy; the same role after the node is gone is unusable', () => {
  const doc = baseMap({ argumentMap: usable() });
  assert.equal(model.readArgumentMap(doc).kind, 'legacy');
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

// ---- dead need replaced: reader (ticket 01) --------------------------------------------------------------------------------------
const withNeeds = needs => doc => { doc.hypotheses.push({ id: 'h1', citedData: [], round: 2, location: 'verifying', needs }); };
const need = (id, round, state, extra = {}) => ({ id, text: id, addedRound: round, state, ...extra });
const readWith = needs => { const doc = baseMap({ argumentMap: usable() }); withNeeds(needs)(doc.argumentMap); return model.readArgumentMap(doc); };
test('dead need reader: a valid replaces is usable and round-trips; forgeries make the key unusable', () => {
  const ok = [need('a', 1, 'not_found'), need('b', 2, 'found', { replaces: 'a' })];
  assert.equal(readWith(ok).kind, 'legacy');
  const text = core.serializeMap(baseMap({ argumentMap: Object.assign(usable(), { hypotheses: [{ id: 'h1', citedData: [], round: 2, location: 'verifying', needs: ok }] }) }));
  assert.equal(roundTrip(text), text);
  const forged = {
    'unknown id': [need('a', 1, 'not_found'), need('b', 2, 'found', { replaces: 'zzz' })],
    'same round': [need('a', 1, 'not_found'), need('b', 1, 'found', { replaces: 'a' })],
    'earlier round': [need('a', 2, 'not_found'), need('b', 1, 'found', { replaces: 'a' })],
    'points to found': [need('a', 1, 'found'), need('b', 2, 'found', { replaces: 'a' })],
    'points to pending': [need('a', 1, 'pending'), need('b', 2, 'found', { replaces: 'a' })],
    'self': [need('a', 1, 'not_found', { replaces: 'a' })],
    'empty string': [need('a', 1, 'not_found'), need('b', 2, 'found', { replaces: '' })],
    'not a string': [need('a', 1, 'not_found'), need('b', 2, 'found', { replaces: 7 })],
    'two replace one': [need('a', 1, 'not_found'), need('b', 2, 'found', { replaces: 'a' }), need('c2', 2, 'found', { replaces: 'a' })]
  };
  for (const [name, needs] of Object.entries(forged)) {
    const read = readWith(needs);
    assert.equal(read.kind, 'unusable', name);
    assert.equal(read.reason, 'need malformed', name);
  }
  const doc = baseMap({ argumentMap: usable() });
  doc.argumentMap.hypotheses.push({ id: 'h1', citedData: [], round: 2, location: 'verifying', needs: [need('a', 1, 'not_found')] }, { id: 'h2', citedData: [], round: 2, location: 'verifying', needs: [need('b', 2, 'found', { replaces: 'a' })] });
  assert.equal(model.readArgumentMap(doc).kind, 'unusable', 'a need in another hypothesis');
});

// ---- V2 contract (packet V1) ------------------------------------------------------------------------------------------------------
const V2_NODES = ['p', 'pr', 'c', 'q1', 'd1', 'q2', 'cmp', 'h1', 'n1'];
const v2Map = extra => ({ version: 1, id: 'm2', title: 'T', nodes: V2_NODES.map((id, i) => ({ id, path: `${id}.md`, parentId: null, x: i, y: 0, collapsed: false })), viewport: { x: 0, y: 0, zoom: 1 }, ...extra });
const v2Read = edit => { const doc = v2Map({ argumentMap: v2State() }); if (edit) edit(doc.argumentMap, doc); return { doc, read: model.readArgumentMap(doc) }; };

test('v2: a well-formed value reads as usable, round-trips byte-identical and is never changed by reading', () => {
  const doc = v2Map({ argumentMap: v2State() });
  const text = core.serializeMap(doc);
  assert.equal(roundTrip(text), text);
  const before = JSON.stringify(doc.argumentMap);
  const read = model.readArgumentMap(core.parseMap(text));
  assert.equal(read.kind, 'usable');
  assert.equal(read.data.v, 2);
  assert.equal(read.data.roles.premises, 'pr');
  assert.equal(read.data.claims[1].comparison.nodeId, 'cmp');
  assert.equal(read.data.hypotheses[0].verdict.causal, 'conditional');
  model.readArgumentMap(doc);
  assert.equal(JSON.stringify(doc.argumentMap), before);
});
test('v2: the minimal value (no optional field, no hypothesis, no verdict) is usable', () => {
  const { read } = v2Read(s => {
    delete s.framing.composition; delete s.run.stopReason; delete s.conclusion.overall;
    s.claims[1].comparison = undefined; delete s.claims[1].comparison; delete s.claims[0].result;
    s.hypotheses = []; s.conclusion.answers = []; s.conclusion.deleted = [];
  });
  assert.equal(read.kind, 'usable', read.reason);
});
test('v2: a v:1 value is never usable and a v:2 value is never legacy', () => {
  assert.equal(v2Read().read.kind, 'usable');
  const doc = baseMap({ argumentMap: usable() });
  assert.equal(model.readArgumentMap(doc).kind, 'legacy');
  assert.notEqual(model.readArgumentMap(doc).kind, 'usable');
});

// v1 fixtures in every run state stay legacy (read-only), whatever phase they were left in.
for (const [name, edit] of Object.entries({
  running: s => { s.run.status = 'running'; },
  paused: s => { s.run.status = 'paused'; s.run.stopReason = 'interrupted'; },
  concluded: s => { s.run.phase = 'concluded'; s.run.status = 'finished'; s.conclusion.state = 'concluded'; },
  stopped_mismatch: s => { s.run.phase = 'stopped_mismatch'; s.run.status = 'finished'; s.run.stopReason = 'mismatch'; s.conclusion.state = 'stopped'; }
})) {
  test(`legacy v1 fixture (${name}): reads legacy with the data as saved, bytes unchanged by reading, key kept on round-trip`, () => {
    const state = usable();
    edit(state);
    const doc = baseMap({ argumentMap: state });
    const text = core.serializeMap(doc);
    const read = model.readArgumentMap(core.parseMap(text));
    assert.equal(read.kind, 'legacy');
    assert.deepEqual(plain(read.data), plain(state));
    assert.equal(roundTrip(text), text);
    assert.equal(modelV1.readArgumentMap(core.parseMap(text)).kind, 'usable', 'the v1 reader still reads it');
  });
}
test('v1 reader: a v:2 or v:3 value is unusable for it (version 1 is not guessed at)', () => {
  const doc = baseMap({ argumentMap: usable() });
  doc.argumentMap.v = 2;
  assert.equal(modelV1.readArgumentMap(doc).kind, 'unusable');
  doc.argumentMap.v = 3;
  assert.equal(modelV1.readArgumentMap(doc).reason, 'unsupported version');
});
test('a map without the key: readArgumentMap is absent and the saved bytes are identical to a pre-v2 save', () => {
  const doc = baseMap({ aiMode: 'quick', layout: { direction: 'right' } });
  const text = core.serializeMap(doc);
  assert.equal(roundTrip(text), text);
  assert.equal(text.includes('argumentMap'), false);
  assert.equal(model.readArgumentMap(core.parseMap(text)).kind, 'absent');
  assert.equal(model.managedNodeIds(core.parseMap(text)).size, 0);
});

// Every v2 corruption is unusable, the key survives parse/serialize byte for byte, and the map still opens as an ordinary map.
const v2Corrupt = {
  'v:3': s => { s.v = 3; },
  'v missing': s => { delete s.v; },
  'role premises missing': s => { delete s.roles.premises; },
  'role points to a missing node': s => { s.roles.premises = 'ghost'; },
  'a v1 role key instead': s => { delete s.roles.premises; s.roles.situation = 'pr'; },
  'framing missing': s => { delete s.framing; },
  'framing not locked (lockedAt empty)': s => { s.framing.lockedAt = ''; },
  'framing not locked (lockedAt missing)': s => { delete s.framing.lockedAt; },
  'chosen not among candidates': s => { s.framing.chosen = 'zzz'; },
  'unknown candidate kind': s => { s.framing.candidates[0].kind = 'guess'; },
  'duplicate candidate id': s => { s.framing.candidates[1].id = 'k1'; },
  'unknown claim type': s => { s.claims[1].type = 'vibes'; },
  'unknown claim role': s => { s.claims[1].role = 'boss'; },
  'unknown claim status': s => { s.claims[1].status = 'sleeping'; },
  'unknown premise result': s => { s.claims[0].result = 'maybe'; },
  'a causal claim as a premise': s => { s.claims[0].type = 'causal'; },
  'a premise without data': s => { delete s.claims[0].data; },
  'a testable claim with data': s => { s.claims[1].data = []; },
  'dependsOn an unknown claim': s => { s.claims[1].dependsOn = ['zzz']; },
  'a claim depends on itself': s => { s.claims[1].dependsOn = ['q2']; },
  'duplicate node id (claim vs hypothesis)': s => { s.hypotheses[0].id = 'q2'; },
  'unknown comparison state': s => { s.claims[1].comparison.state = 'meh'; },
  'unknown veto kind': s => { s.claims[1].comparison.vetoes[0].kind = 'sulk'; },
  'allocation to an unknown need': s => { s.claims[1].comparison.allocations[0].needId = 'zzz'; },
  'allocation to an unknown hypothesis': s => { s.claims[1].comparison.allocations[0].hypothesisId = 'zzz'; },
  'unknown comparison answer': s => { s.claims[1].comparison.answer = 'because'; },
  'hypothesis on an unknown claim': s => { s.hypotheses[0].claimId = 'zzz'; },
  'unknown hypothesis role': s => { s.hypotheses[0].role = 'hero'; },
  'unknown user verdict': s => { s.hypotheses[0].userVerdict = 'shrug'; },
  'unknown prediction kind': s => { s.hypotheses[0].predictions[0].kind = 'hope'; },
  'unknown overlap strength': s => { s.hypotheses[0].predictions[0].alsoPredictedBy[0].strength = 'huge'; },
  'overlap with an unknown hypothesis': s => { s.hypotheses[0].predictions[0].alsoPredictedBy[0].hypothesisId = 'zzz'; },
  'auxiliary is not a claim': s => { s.hypotheses[0].predictions[0].auxiliary = ['zzz']; },
  'need predicts nothing': s => { s.hypotheses[0].needs[0].predictionId = 'zzz'; },
  'need without criteria': s => { delete s.hypotheses[0].needs[0].criteria; },
  'unknown registration': s => { s.hypotheses[0].needs[0].registered = 'maybe'; },
  'unknown need state': s => { s.hypotheses[0].needs[0].state = 'lost'; },
  'provider_read is no longer a proof check': s => { s.hypotheses[0].needs[0].proof.check = 'provider_read'; },
  'unknown proof check': s => { s.hypotheses[0].needs[0].proof.check = 'vibes'; },
  'unknown assessment stance': s => { s.hypotheses[0].needs[0].assessment.stance = 'opposes'; },
  'assessment relevant not a boolean': s => { s.hypotheses[0].needs[0].assessment.relevant = 'yes'; },
  'assessment names an unknown hypothesis': s => { s.hypotheses[0].needs[0].assessment.alsoRelevantTo = ['zzz']; },
  'a need replaces a found need': s => { s.hypotheses[0].needs.push({ ...s.hypotheses[0].needs[0], id: 'n2', addedRound: 2, replaces: 'n1' }); },
  'unknown verdict value': s => { s.hypotheses[0].verdict.value = 'maybe'; },
  'unknown verdict by': s => { s.hypotheses[0].verdict.by = 'oracle'; },
  'unknown causal state': s => { s.hypotheses[0].verdict.causal = 'proven'; },
  'unknown confidence': s => { s.hypotheses[0].verdict.confidence = 'certain'; },
  'verdict cites an unknown need': s => { s.hypotheses[0].verdict.citedNeeds = ['zzz']; },
  'unknown refutation class': s => { s.hypotheses[0].verdict.refutations[0].class = 'fatal'; },
  'unknown assumption status': s => { s.hypotheses[0].verdict.assumptionStatus[0].status = 'vibes'; },
  'unknown run phase (a v1 phase)': s => { s.run.phase = 'situation'; },
  'unknown run status': s => { s.run.status = 'dreaming'; },
  'unknown stop reason': s => { s.run.stopReason = 'boredom'; },
  'negative counter': s => { s.run.researchCalls = -1; },
  'unknown conclusion state': s => { s.conclusion.state = 'victory'; },
  'unknown answer': s => { s.conclusion.answers[0].answer = 'yes'; },
  'answer for an unknown claim': s => { s.conclusion.answers[0].claimId = 'zzz'; },
  'v1 conclusion shape': s => { delete s.conclusion.answers; s.conclusion.basedOn = []; s.conclusion.missing = []; },
  'future field with v:3 and extra data': s => { s.v = 3; s.futureThing = { deep: [1, 2, { x: 'y' }] }; },
  'not an object': (s, doc) => { doc.argumentMap = 'oops'; },
  'array': (s, doc) => { doc.argumentMap = []; },
  'null': (s, doc) => { doc.argumentMap = null; }
};
for (const [name, edit] of Object.entries(v2Corrupt)) {
  test(`v2 unusable but preserved: ${name}`, () => {
    const doc = v2Map({ argumentMap: v2State() });
    edit(doc.argumentMap, doc);
    const text = core.serializeMap(doc);
    const parsed = core.parseMap(text);
    assert.deepEqual(plain(parsed.argumentMap), plain(doc.argumentMap), 'parse keeps the value as saved');
    assert.equal(roundTrip(text), text, 'serialize writes it back byte for byte');
    const read = model.readArgumentMap(parsed);
    assert.equal(read.kind, 'unusable');
    assert.ok(read.reason);
    assert.deepEqual(plain(read.raw), plain(doc.argumentMap));
    assert.equal(read.data, undefined, 'unusable carries no data the runner could use');
    assert.deepEqual(plain(parsed.nodes), plain(doc.nodes), 'the map still opens as an ordinary map');
  });
}

test('managedNodeIds: v2 names the roles, claims, premise data, comparison cards, hypotheses and needs; the same for an unusable v2 key', () => {
  const all = [...V2_NODES].sort();
  assert.deepEqual([...model.managedNodeIds(v2Map({ argumentMap: v2State() }))].sort(), all);
  const broken = v2Map({ argumentMap: v2State() });
  broken.argumentMap.run.phase = 'warp';
  assert.equal(model.readArgumentMap(broken).kind, 'unusable');
  assert.deepEqual([...model.managedNodeIds(broken)].sort(), all, 'an unusable key still protects what it names');
  assert.deepEqual([...model.managedNodeIds({ argumentMap: { v: 3, roles: { proposition: 'x' }, claims: [{ id: 'q', data: [{ id: 'd' }, 5, null], comparison: { nodeId: 'k' } }, 'junk', { id: 7 }] } })].sort(), ['d', 'k', 'q', 'x']);
  assert.equal(model.managedNodeIds({ argumentMap: { claims: 'junk' } }).size, 0);
});
test('v2 constants: the roles, answer keys and proof checks the plan names exist; unverified_quote replaces provider_read', () => {
  assert.deepEqual([...model.ROLE_KEYS], ['proposition', 'premises', 'conclusion']);
  assert.deepEqual([...model.PROOF_CHECKS], ['page_match', 'unverified_quote']);
  assert.deepEqual([...model.RUN_PHASES], ['premises', 'analysis', 'comparison', 'conclusion', 'inference_check', 'concluded', 'stopped_premise']);
  assert.equal(model.ARGUMENT_MAP_VERSION, 2);
  assert.equal(modelV1.ARGUMENT_MAP_VERSION, 1);
  assert.deepEqual([...modelV1.PROOF_CHECKS], ['page_match', 'provider_read']);
});
