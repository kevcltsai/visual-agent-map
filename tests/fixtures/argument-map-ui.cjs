// UI fixture for the argument map (P7c): `{ map, notes[] }` plus one fixture per conclusion state. No provider is involved.
// `notes[]` are `{ key, parent, title, summary, kind }` (kind is the note's topic-kind); every id inside `map.argumentMap` is a
// key like "k:hyp1". A loader creates the notes with repo.createNote, then calls `bind(map, idByKey)` to swap keys for node ids
// (see docs/history/tasks/2026-11-09-argument-map-layout/ui-harness-notes.md in agents-spec).
// The default export covers: in progress, dashed missing needs and data, an eliminated hypothesis, supports/contradicts/uncertain
// needs, supports/opposes situation data. `states.*` give the other three conclusion states on the same tree shape.
const proof = (host, claim) => ({ url: `https://${host}/report`, quote: claim, claim, check: 'page_match', checkedAt: '2026-11-09T00:00:00.000Z' });
const datum = (key, need, over = {}) => ({ id: key, need, attempts: 1, state: 'found', stance: 'supports', proof: proof('www.nyfed.example.org', `${need}: 5.6% against 4.2%`), ...over });
const need = (key, text, over = {}) => ({ id: key, text, addedRound: 1, state: 'found', stance: 'supports', proof: proof('www.bls.example.org', `${text} found`), ...over });
const ROLES = { proposition: 'k:prop', situation: 'k:situation', conclusion: 'k:conclusion', verified: 'k:verified', eliminated: 'k:eliminated' };

function tree(hypotheses, data) {
  const notes = [
    { key: 'k:prop', parent: null, title: 'Is the US youth unemployment rate caused by AI?', summary: 'The proposition under study.', kind: 'topic' },
    { key: 'k:situation', parent: 'k:prop', title: 'Young workers are in a weak job market', summary: 'Situation summary.', kind: 'topic' },
    { key: 'k:conclusion', parent: 'k:prop', title: 'Conclusion', summary: 'AI is a partial factor, not the main cause.', kind: 'conclusion' },
    { key: 'k:verified', parent: 'k:conclusion', title: 'Verified hypotheses', summary: '', kind: 'topic' },
    { key: 'k:eliminated', parent: 'k:conclusion', title: 'Eliminated hypotheses', summary: '', kind: 'topic' }
  ];
  for (const d of data) notes.push({ key: d.id, parent: 'k:situation', title: d.need, summary: d.proof ? d.proof.claim : 'Not found yet.', kind: 'evidence' });
  for (const h of hypotheses) {
    notes.push({ key: h.id, parent: h.location === 'eliminated' ? 'k:eliminated' : 'k:verified', title: h.title, summary: 'Hypothesis summary.', kind: 'hypothesis' });
    for (const n of h.needs) notes.push({ key: n.id, parent: h.id, title: n.text, summary: n.proof ? n.proof.claim : 'Not found yet.', kind: 'evidence' });
  }
  return notes;
}

function build(phase, hypotheses, data, gate = { state: 'matched', citedData: ['k:data1'] }, status = 'running') {
  const notes = tree(hypotheses, data);
  const map = {
    title: `Argument fixture ${phase}`,
    argumentMap: {
      v: 1,
      roles: { ...ROLES },
      run: { runId: 'fixture-run', phase, status, researchCalls: 5, ...(phase === 'stopped_mismatch' ? { stopReason: 'mismatch' } : phase === 'stopped_limit' ? { stopReason: 'limit' } : {}) },
      situation: { data, gate },
      hypotheses: hypotheses.map(({ title, ...h }) => h),
      conclusion: { state: phase === 'concluded' ? 'concluded' : phase.startsWith('stopped') ? 'stopped' : 'pending', basedOn: [], missing: phase === 'stopped_limit' ? ['Evidence for hypothesis 2'] : [] }
    }
  };
  return { map, notes };
}
const hyp = (id, title, needs, over = {}) => ({ id, title, citedData: ['k:data1'], round: 1, location: 'verifying', needs, aiVerdict: 'supported', ...over });
const supported = n => hyp(`k:hyp${n}`, `Supported hypothesis ${n}`, [need(`k:hyp${n}-n1`, `Evidence A${n}`), need(`k:hyp${n}-n2`, `Evidence B${n}`, { stance: 'contradicts' }), need(`k:hyp${n}-n3`, `Evidence C${n}`, { stance: 'uncertain' })]);
const DATA = [
  datum('k:data1', 'Compared with all workers'),
  datum('k:data2', 'Job quality', { stance: 'supports' }),
  datum('k:data3', 'Compared with last year', { stance: 'opposes' }),
  datum('k:data4', 'Hiring rate', { state: 'not_found', stance: undefined, proof: undefined, reason: 'The source page could not be opened.' }),
  datum('k:data5', 'Still to find', { state: 'pending', stance: undefined, proof: undefined })
];
const clean = list => list.map(item => Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined)));

const inProgress = build('analysis', [
  supported(1),
  hyp('k:hyp2', 'Business cycle and high rates cut hiring', [need('k:hyp2-n1', 'Weak overall labour market'), need('k:hyp2-n2', 'Workers without degrees also affected', { state: 'not_found', stance: undefined, proof: undefined, reason: 'Both sources would not open.' })], { aiVerdict: 'undecided' }),
  hyp('k:hyp3', 'AI replaced entry-level work', [need('k:hyp3-n1', 'Exposure study'), need('k:hyp3-n2', 'Still to find', { state: 'pending', stance: undefined, proof: undefined })], { aiVerdict: 'undecided' }),
  hyp('k:hyp4', 'Graduate oversupply and skills mismatch', [need('k:hyp4-n1', 'Surplus evidence kept', { stance: 'uncertain' })], { location: 'eliminated', eliminationReason: 'No authoritative ratio found after 3 rounds.', aiVerdict: 'undecided' })
], clean(DATA));

const concluded = build('concluded', [supported(1), supported(2), supported(3)], clean(DATA.slice(0, 3)));
const mismatch = build('stopped_mismatch', [], clean(DATA.slice(0, 3)), { state: 'unmatched', kind: 'not_matching', reason: 'The data run the other way.', citedData: ['k:data1'] }, 'finished');
const limit = build('stopped_limit', [
  supported(1),
  hyp('k:hyp2', 'Hypothesis 2', [need('k:hyp2-n1', 'Missing evidence', { state: 'not_found', stance: undefined, proof: undefined, reason: 'Not found.' })], { aiVerdict: 'undecided' }),
  hyp('k:hyp3', 'Hypothesis 3', [need('k:hyp3-n1', 'Evidence', { stance: 'contradicts' })], { location: 'eliminated', eliminationReason: 'Refuted.', aiVerdict: 'refuted' })
], clean(DATA.slice(0, 3)), { state: 'matched', citedData: ['k:data1'] }, 'finished');

/** Swaps every key in `argumentMap` for the node id the loader got back from repo.createNote. */
function bind(argumentMap, idByKey) {
  const swap = value => (typeof value === 'string' && idByKey[value] ? idByKey[value] : Array.isArray(value) ? value.map(swap) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swap(v)])) : value);
  return swap(argumentMap);
}

module.exports = { map: inProgress.map, notes: inProgress.notes, states: { in_progress: inProgress, concluded, stopped_mismatch: mismatch, stopped_limit: limit }, bind };
