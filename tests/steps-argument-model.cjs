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
  'role missing': s => { delete s.roles.conclusion; },
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

// ---- dead need replaced: reader (ticket 01) --------------------------------------------------------------------------------------
const withNeeds = needs => doc => { doc.hypotheses.push({ id: 'h1', citedData: [], round: 2, location: 'verifying', needs }); };
const need = (id, round, state, extra = {}) => ({ id, text: id, addedRound: round, state, ...extra });
const readWith = needs => { const doc = baseMap({ argumentMap: usable() }); withNeeds(needs)(doc.argumentMap); return model.readArgumentMap(doc); };
test('dead need reader: a valid replaces is usable and round-trips; forgeries make the key unusable', () => {
  const ok = [need('a', 1, 'not_found'), need('b', 2, 'found', { replaces: 'a' })];
  assert.equal(readWith(ok).kind, 'usable');
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

// ---- V1 boost P1: facets, assumptions, data_insufficient ----------------------------------------------------------------------------
const facetPlan = () => ({
  assumptions: { id: 'as1', items: [{ label: 'Age', value: '16-24 in 2024', reason: 'young people' }] },
  facets: [1, 2, 3, 4].map(i => ({ id: `f${i}`, title: `Facet ${i}`, needs: [{ id: `d${i}`, need: `need ${i}` }] })),
  causalQuestions: ['why?'],
  questionType: 'fact'
});
const withNeed = fn => { const d = facetMapDoc(); fn(d.argumentMap.situation); return model.readArgumentMap(core.parseMap(core.serializeMap(d))); };
test('sem3 model: criterion, baseline and definitionNeeds are optional (old maps) and, when present, must be strings', () => {
  assert.equal(withNeed(sit => { sit.facets[0].criterion = 'supports when higher'; sit.facets[0].baseline = 'overall'; sit.assumptions.definitionNeeds = ['how it is measured']; }).kind, 'usable');
  for (const mutate of [sit => { sit.facets[0].criterion = 5; }, sit => { sit.facets[0].baseline = ['x']; }, sit => { sit.assumptions.definitionNeeds = 'x'; }, sit => { sit.assumptions.definitionNeeds = [1]; }])
    assert.equal(withNeed(mutate).kind, 'unusable');
});
const facetMapDoc = () => {
  const state = machine.applySituationPlan(machine.newArgumentMap(ROLES, 'run-1'), facetPlan());
  return baseMap({ argumentMap: plain(state) });
};
test('facet boost model: facets, assumptions, facetId, propStance, round and data_insufficient read as usable and round-trip', () => {
  const doc = facetMapDoc();
  doc.argumentMap.situation.data[0].propStance = 'irrelevant';
  doc.argumentMap.situation.data[0].stanceReason = 'no stance';
  doc.argumentMap.situation.gate = { state: 'unmatched', kind: 'data_insufficient', reason: 'r', citedData: [], round: 2 };
  doc.argumentMap.situation.facets[1].verdict = 'insufficient';
  doc.argumentMap.situation.facets[2].verdict = 'refutes';
  const text = core.serializeMap(doc);
  assert.equal(roundTrip(text), text);
  const read = model.readArgumentMap(core.parseMap(text));
  assert.equal(read.kind, 'usable');
  assert.equal(read.data.situation.facets.length, 4);
  assert.equal(model.readArgumentMap(facetMapDoc()).kind, 'usable');
});
test('facet hypotheses model: basis and alternative are optional, read as usable and round-trip; a wrong type is unusable', () => {
  const doc = facetMapDoc();
  doc.argumentMap.hypotheses.push({ id: 'h1', citedData: [], round: 1, location: 'verifying', needs: [], basis: 'from d1 we observe x, so we guess y', alternative: true });
  const text = core.serializeMap(doc);
  assert.equal(roundTrip(text), text);
  assert.equal(model.readArgumentMap(core.parseMap(text)).kind, 'usable');
  for (const over of [{ basis: 5 }, { alternative: 'yes' }]) {
    const d = facetMapDoc();
    d.argumentMap.hypotheses.push({ id: 'h1', citedData: [], round: 1, location: 'verifying', needs: [], ...over });
    assert.notEqual(model.readArgumentMap(core.parseMap(core.serializeMap(d))).kind, 'usable');
  }
});
const badFacets = {
  'datum with a facetId that is not a facet': d => { d.situation.data[0].facetId = 'ghost'; },
  'datum without a facetId on a facet map': d => { delete d.situation.data[0].facetId; },
  'six facets': d => { for (const i of [5, 6]) d.situation.facets.push({ id: `f${i}`, title: `F${i}`, verdict: 'pending', reason: '', citedData: [], summary: '' }); },
  'two facets': d => { d.situation.facets.length = 2; d.situation.data = d.situation.data.slice(0, 2); },
  'duplicate facet id': d => { d.situation.facets[1].id = 'f1'; },
  'facet id equals a datum id': d => { d.situation.facets[1].id = 'd1'; },
  'facet id equals the assumption id': d => { d.situation.facets[1].id = 'as1'; },
  'unknown facet verdict': d => { d.situation.facets[0].verdict = 'maybe'; },
  'unknown propStance': d => { d.situation.data[0].propStance = 'opposes'; },
  'unknown gate kind': d => { d.situation.gate.kind = 'data_unknown'; },
  'gate round 3': d => { d.situation.gate.round = 3; },
  'assumptions without items': d => { d.situation.assumptions = { id: 'as1' }; },
  'assumption item blank': d => { d.situation.assumptions.items[0].value = ''; },
  'causalQuestions not strings': d => { d.situation.causalQuestions = [1]; },
  'facet citedData not strings': d => { d.situation.facets[0].citedData = [1]; }
};
for (const [name, edit] of Object.entries(badFacets)) {
  test(`facet boost model: unusable and preserved: ${name}`, () => {
    const doc = facetMapDoc();
    edit(doc.argumentMap);
    const text = core.serializeMap(doc);
    assert.equal(roundTrip(text), text);
    assert.equal(model.readArgumentMap(core.parseMap(text)).kind, 'unusable');
  });
}
test('facet boost model: an old map keeps reading without facets, and a datum without facetId is fine there', () => {
  const doc = baseMap({ argumentMap: usable() });
  doc.argumentMap.situation.data.push({ id: 'd1', need: 'x', attempts: 0, state: 'pending' });
  assert.equal(model.readArgumentMap(doc).kind, 'usable');
});

// ---- V1 boost P4b: question, figure, searchLog ----
const SEARCH_LOG = { queries: ['youth unemployment 2024'], opened: ['https://stats.example.org/a'], why: 'the page had only 2019 data' };
const proofOf = extra => ({ url: 'https://stats.example.org/a', quote: 'quote number one', claim: 'claim', check: 'page_match', checkedAt: '2026-11-11T00:00:00.000Z', ...extra });
const longText = 'x'.repeat(201);
const hypothesisWith = insights => d => { d.hypotheses.push({ id: 'h1', citedData: [], round: 1, location: 'verifying', needs: [], ...(insights === undefined ? {} : { insights }) }); };
const goodOptionals = {
  'question on the situation': d => { d.situation.question = 'Did the youth rate rise?'; },
  'figure on a datum proof': d => { d.situation.data[0].state = 'found'; d.situation.data[0].proof = proofOf({ figure: { number: '9.2', period: '2024-03', unit: 'percent' } }); },
  'searchLog on a datum': d => { d.situation.data[0].searchLog = SEARCH_LOG; },
  'searchLog on a need': d => { d.hypotheses.push({ id: 'h1', citedData: [], round: 1, location: 'verifying', needs: [{ id: 'n1', text: 'n', addedRound: 1, state: 'not_found', searchLog: SEARCH_LOG }] }); },
  'assumption insights (three, 300 characters)': d => { d.situation.assumptions = { id: 'as1', items: [{ label: 'a', value: 'v', reason: 'r' }], insights: ['x'.repeat(300), 'two', 'three'] }; },
  'hypothesis insights (one to three, all kinds)': hypothesisWith([{ kind: 'consistent', text: 'a' }, { kind: 'tension', text: 'b' }, { kind: 'missing', text: 'c' }]),
  'searchLog with five queries of 200 characters': d => { d.situation.data[0].searchLog = { queries: Array(5).fill('x'.repeat(200)), opened: [], why: 'w' }; }
};
for (const [name, edit] of Object.entries(goodOptionals)) {
  test(`boost optional fields read as usable and round-trip: ${name}`, () => {
    const doc = facetMapDoc();
    edit(doc.argumentMap);
    const text = core.serializeMap(doc);
    assert.equal(roundTrip(text), text);
    assert.equal(model.readArgumentMap(core.parseMap(text)).kind, 'usable');
  });
}
const badOptionals = {
  'blank question': d => { d.situation.question = ''; },
  'question not a string': d => { d.situation.question = 5; },
  'figure not an object': d => { d.situation.data[0].proof = proofOf({ figure: '9.2' }); },
  'figure number as a JS number': d => { d.situation.data[0].proof = proofOf({ figure: { number: 9.2, period: 'p', unit: 'u' } }); },
  'figure missing unit': d => { d.situation.data[0].proof = proofOf({ figure: { number: '9.2', period: 'p' } }); },
  'figure blank period': d => { d.situation.data[0].proof = proofOf({ figure: { number: '9.2', period: '', unit: 'u' } }); },
  'figure with an extra key': d => { d.situation.data[0].proof = proofOf({ figure: { number: '9.2', period: 'p', unit: 'u', x: 1 } }); },
  'figure on a need proof': d => { d.hypotheses.push({ id: 'h1', citedData: [], round: 1, location: 'verifying', needs: [{ id: 'n1', text: 'n', addedRound: 1, state: 'found', proof: proofOf({ figure: [] }) }] }); },
  'searchLog not an object': d => { d.situation.data[0].searchLog = 'q'; },
  'searchLog queries not strings': d => { d.situation.data[0].searchLog = { ...SEARCH_LOG, queries: [1] }; },
  'searchLog six queries': d => { d.situation.data[0].searchLog = { ...SEARCH_LOG, queries: Array(6).fill('q') }; },
  'searchLog six opened': d => { d.situation.data[0].searchLog = { ...SEARCH_LOG, opened: Array(6).fill('https://a.example.org/') }; },
  'searchLog query over 200 characters': d => { d.situation.data[0].searchLog = { ...SEARCH_LOG, queries: [longText] }; },
  'searchLog why over 200 characters': d => { d.situation.data[0].searchLog = { ...SEARCH_LOG, why: longText }; },
  'searchLog missing why': d => { d.situation.data[0].searchLog = { queries: [], opened: [] }; },
  'assumption insights not an array': d => { d.situation.assumptions = { id: 'as1', items: [{ label: 'a', value: 'v', reason: 'r' }], insights: 'x' }; },
  'assumption insights four items': d => { d.situation.assumptions = { id: 'as1', items: [{ label: 'a', value: 'v', reason: 'r' }], insights: ['1', '2', '3', '4'] }; },
  'assumption insight blank': d => { d.situation.assumptions = { id: 'as1', items: [{ label: 'a', value: 'v', reason: 'r' }], insights: [''] }; },
  'assumption insight over 300 characters': d => { d.situation.assumptions = { id: 'as1', items: [{ label: 'a', value: 'v', reason: 'r' }], insights: ['x'.repeat(301)] }; },
  'assumption insight not a string': d => { d.situation.assumptions = { id: 'as1', items: [{ label: 'a', value: 'v', reason: 'r' }], insights: [3] }; },
  'hypothesis insights not an array': hypothesisWith('x'),
  'hypothesis insights four items': hypothesisWith([1, 2, 3, 4].map(i => ({ kind: 'missing', text: `t${i}` }))),
  'hypothesis insight unknown kind': hypothesisWith([{ kind: 'maybe', text: 't' }]),
  'hypothesis insight blank text': hypothesisWith([{ kind: 'missing', text: '' }]),
  'hypothesis insight over 300 characters': hypothesisWith([{ kind: 'missing', text: 'x'.repeat(301) }]),
  'hypothesis insight with an extra key': hypothesisWith([{ kind: 'missing', text: 't', id: 1 }]),
  'searchLog on a need malformed': d => { d.hypotheses.push({ id: 'h1', citedData: [], round: 1, location: 'verifying', needs: [{ id: 'n1', text: 'n', addedRound: 1, state: 'not_found', searchLog: { queries: 'x', opened: [], why: '' } }] }); }
};
for (const [name, edit] of Object.entries(badOptionals)) {
  test(`boost optional fields: unusable and preserved: ${name}`, () => {
    const doc = facetMapDoc();
    edit(doc.argumentMap);
    const text = core.serializeMap(doc);
    assert.equal(roundTrip(text), text);
    assert.equal(model.readArgumentMap(core.parseMap(text)).kind, 'unusable');
  });
}

// ---- question types: optional fields (decisions #60, #62, #64, #66) ---------------------------------------------------------------------
const qUsable = fn => { const d = baseMap({ argumentMap: usable() }); fn(d.argumentMap, d); return model.readArgumentMap(core.parseMap(core.serializeMap(d))); };
test('question type fields read as usable and round-trip; an unknown value is unusable and preserved', () => {
  for (const type of ['fact', 'causal']) {
    const read = qUsable(a => { a.situation.questionType = type; a.run.presetQuestionType = type; });
    assert.equal(read.kind, 'usable');
    assert.equal(read.data.situation.questionType, type);
  }
  const text = core.serializeMap(baseMap({ argumentMap: Object.assign(usable(), { situation: { ...usable().situation, questionType: 'fact' } }) }));
  assert.equal(roundTrip(text), text);
  for (const mutate of [a => { a.situation.questionType = 'opinion'; }, a => { a.run.presetQuestionType = 'x'; }, a => { a.situation.questionType = 1; }]) {
    const read = qUsable(mutate);
    assert.equal(read.kind, 'unusable');
    assert.equal(read.reason, 'unknown ' + (read.reason.includes('run') ? 'run' : 'situation') + ' enum');
  }
});
test('group roles are optional; a present one must be a string pointing at an existing node (counter-example 8)', () => {
  const lean = () => qUsable((a, d) => { delete a.roles.verified; delete a.roles.eliminated; });
  assert.equal(lean().kind, 'usable');
  const three = qUsable((a, d) => { d.nodes.push({ id: 'u', path: 'u.md', parentId: null, x: 0, y: 0, collapsed: false }); a.roles.unconfirmed = 'u'; });
  assert.equal(three.kind, 'usable');
  assert.equal(qUsable(a => { a.roles.unconfirmed = 'ghost'; }).reason, 'role unconfirmed points to a missing node');
  assert.equal(qUsable(a => { a.roles.unconfirmed = 7; }).reason, 'role unconfirmed malformed');
  assert.equal(qUsable(a => { a.roles.verified = ''; }).kind, 'unusable');
  assert.equal(qUsable(a => { a.roles.eliminated = 'ghost'; }).kind, 'unusable');
  assert.equal(qUsable(a => { delete a.roles.proposition; }).kind, 'unusable', 'the three role nodes stay required');
});
test('need.core, proof.tier and proof.second are optional, round-trip, and reject malformed values (counter-example 8)', () => {
  const proofOf = extra => ({ url: 'https://a.example.org/x', quote: 'q', claim: 'c', check: 'page_match', checkedAt: '2026-11-09T00:00:00.000Z', ...extra });
  const second = { url: 'https://b.example.net/y', quote: 'q2', check: 'provider_read', checkedAt: '2026-11-09T00:00:00.000Z' };
  const withNeed = extra => qUsable(a => { a.hypotheses.push({ id: 'h1', citedData: [], round: 1, location: 'verifying', needs: [{ id: 'n1', text: 't', addedRound: 1, state: 'found', stance: 'supports', ...extra }] }); });
  const ok = withNeed({ core: true, proof: proofOf({ tier: 'other', second }) });
  assert.equal(ok.kind, 'usable');
  assert.equal(withNeed({ proof: proofOf({ tier: 'primary' }) }).kind, 'usable');
  assert.equal(withNeed({ proof: proofOf() }).kind, 'usable', 'an older proof has neither');
  for (const [name, extra] of Object.entries({
    'core false': { core: false }, 'core string': { core: 'true' },
    'unknown tier': { proof: proofOf({ tier: 'gold' }) },
    'second without url': { proof: proofOf({ tier: 'other', second: { ...second, url: '' } }) },
    'second with unknown check': { proof: proofOf({ tier: 'other', second: { ...second, check: 'guess' } }) },
    'second not an object': { proof: proofOf({ tier: 'other', second: 'https://b.example.net' }) }
  })) assert.equal(withNeed(extra).kind, 'unusable', name);
  const datum = qUsable(a => { a.situation.data.push({ id: 'd9', need: 'x', attempts: 1, state: 'found', stance: 'supports', proof: proofOf({ tier: 'other', second }) }); });
  assert.equal(datum.kind, 'usable');
});
test('managedNodeIds covers the unconfirmed group; composeFacets and isLegacyFacetMap read tolerant states', () => {
  assert.deepEqual([...model.managedNodeIds({ argumentMap: { roles: { proposition: 'p', unconfirmed: 'u', verified: 7 } } })].sort(), ['p', 'u']);
  const s = usable();
  assert.equal(model.isLegacyFacetMap(s), false);
  s.situation.facets = [];
  assert.equal(model.isLegacyFacetMap(s), true);
  s.situation.questionType = 'causal';
  assert.equal(model.isLegacyFacetMap(s), false);
  assert.equal(model.isFactMap(s), false);
});

test('quick run constants: the causal quick run is on; a research call has 45 seconds of model time; the research caps are unchanged', () => {
  assert.equal(model.QUICK_CAUSAL_RUN, true);
  assert.equal(model.RESEARCH_DEADLINE_MS, 45000);
  assert.equal(model.MAX_RESEARCH_CALLS, 78);
  assert.equal(model.MIN_VERIFIED, 3);
});
