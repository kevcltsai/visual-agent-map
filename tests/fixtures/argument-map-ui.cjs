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

// Facet-judged maps (V1 boost): the proposition 「美國年輕人失業率高是AI造成的嗎」, no provider involved. Same `{ map, notes }` shape and `bind`.
const BLS = { url: 'https://www.bls.gov/news.release/archives/youth_08202026.htm', quote: 'The youth unemployment rate, at 9.1 percent in July 2026, was 1.7 percentage points lower than the rate in July 2025.', claim: '2026 年 7 月青年失業率 9.1%，比 2025 年 7 月低 1.7 個百分點。', check: 'page_match', checkedAt: '2026-11-09T00:00:00.000Z', figure: { number: '9.1', period: '2026 年 7 月', unit: '%' } };
const ASSUMPTIONS = [
  { label: '年齡層', value: '16 至 24 歲', reason: '官方青年失業統計以這個年齡層為準。' },
  { label: '期間', value: '2023 至 2026 年', reason: '涵蓋生成式 AI 普及前後。' },
  { label: '地區', value: '美國全國', reason: '命題指的是美國，不是單一州。' },
  { label: '比較基準', value: '與全體勞工失業率相比', reason: '要看年輕人是否比整體更差。' }
];
const fdatum = (n, facet, need, over = {}) => ({ id: `k:d${n}`, need, attempts: 1, state: 'found', facetId: facet, propStance: 'supports', stanceReason: '數字顯示年輕人失業率偏高。', proof: BLS, ...over });
const fnote = (key, parent, title, summary, kind) => ({ key, parent, title, summary, kind });

function buildFacet(phase, { facets, data, hypotheses = [], gate, status = 'running', conclusion, insights = [], stopReason }) {
  const notes = [
    fnote('k:prop', null, '美國年輕人失業率高是 AI 造成的嗎', '要研究的命題。', 'topic'),
    fnote('k:situation', 'k:prop', '美國年輕人失業率現況如何？', '現況摘要。', 'topic'),
    fnote('k:assumptions', 'k:situation', '定義與假設', '研究採用的定義。', 'topic'),
    fnote('k:conclusion', 'k:prop', 'Conclusion', conclusion || '', 'conclusion'),
    fnote('k:verified', 'k:conclusion', 'Verified hypotheses', '', 'topic'),
    fnote('k:eliminated', 'k:conclusion', 'Eliminated hypotheses', '', 'topic')
  ];
  for (const f of facets) notes.push(fnote(f.id, 'k:situation', f.title, f.summary, 'topic'));
  for (const d of data) notes.push(fnote(d.id, d.facetId, d.need, d.proof ? d.proof.claim : '還沒找到。', 'evidence'));
  for (const h of hypotheses) {
    notes.push(fnote(h.id, 'k:verified', h.title, h.basis || '', 'hypothesis'));
    for (const n of h.needs) notes.push(fnote(n.id, h.id, n.text, n.proof ? n.proof.claim : '還沒找到。', 'evidence'));
  }
  const map = {
    title: `Argument fixture ${phase === 'analysis' ? 'facet matched' : phase}`,
    argumentMap: {
      v: 1,
      roles: { ...ROLES },
      run: { runId: 'fixture-run', phase, status, researchCalls: 9, ...(stopReason ? { stopReason } : {}) },
      situation: { data, gate, question: '美國年輕人失業率現況如何？', assumptions: { id: 'k:assumptions', items: ASSUMPTIONS, insights }, facets },
      hypotheses,
      conclusion: { state: phase.startsWith('stopped') ? 'stopped' : 'pending', basedOn: [], missing: [] }
    }
  };
  return { map, notes };
}
const facet = (n, title, verdict, summary, reason, citedData) => ({ id: `k:f${n}`, title, verdict, summary, reason, citedData });
const fneed = (id, text, over = {}) => ({ id, text, addedRound: 1, state: 'found', stance: 'supports', proof: proof('www.bls.gov', `${text}：已找到`), ...over });
const fhyp = (n, title, basis, needs, over = {}) => ({ id: `k:hyp${n}`, title, basis, citedData: ['k:d1'], round: 1, location: 'verifying', needs, aiVerdict: 'undecided', insights: [{ kind: 'consistent', text: '多筆資料方向一致。' }, { kind: 'missing', text: '還缺產業別的細項數字。' }], ...over });

const facetMatched = buildFacet('analysis', {
  facets: [
    facet(1, '年輕人失業率是否偏高', 'supports', '2026 年 7 月 16 至 24 歲失業率 9.1%，仍高於全體勞工。', '官方統計直接顯示。', ['k:d1']),
    facet(2, '失業是否集中在高 AI 暴露職業', 'supports', '新鮮人集中的入門職位受 AI 影響較大。', '兩筆資料方向一致。', ['k:d2']),
    facet(3, '失業率是否在 AI 普及後才上升', 'insufficient', '找不到足夠的時間序列。', '時間序列資料不足。', ['k:d3'])
  ],
  data: [
    fdatum(1, 'k:f1', '16 至 24 歲失業率'),
    fdatum(2, 'k:f2', '入門職位受 AI 影響程度', { propStance: 'irrelevant', stanceReason: '這筆資料沒有直接回答命題。', proof: { ...BLS, quote: 'Entry-level postings fell 12 percent.', claim: '入門職位的職缺數下降 12%。', figure: undefined } }),
    fdatum(3, 'k:f3', 'AI 普及前後的失業率時間序列', { state: 'not_found', propStance: undefined, stanceReason: undefined, proof: undefined, reason: 'budget_exhausted', searchLog: { queries: ['youth unemployment rate 2022 2026 monthly', 'BLS youth unemployment AI adoption'], opened: ['https://www.bls.gov/cps/'], why: '頁面沒有按月份的序列。' } })
  ].map(d => Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined))),
  gate: { state: 'matched', citedData: ['k:d1', 'k:d2'], round: 1 },
  insights: ['現況數據與假設方向一致。', '時間序列還缺一塊。'],
  hypotheses: [
    fhyp(1, 'AI 取代入門職位', '從資料 1 看到年輕人失業率偏高，所以推測入門職位被 AI 取代。', [fneed('k:hyp1-n1', '入門職位職缺變化'), fneed('k:hyp1-n2', '應屆畢業生就業率', { state: 'not_found', stance: undefined, proof: undefined, reason: 'budget_exhausted', searchLog: { queries: ['new graduate employment rate 2026'], opened: [], why: '沒有找到可用頁面。' } })]),
    fhyp(2, '景氣循環與高利率壓低招聘', '從資料 1 看到整體勞動市場偏弱，所以推測景氣因素。', [fneed('k:hyp2-n1', '整體失業率走勢', { stance: 'uncertain' })], { alternative: true }),
    fhyp(3, '大學畢業生供過於求', '從資料 1 看到年輕人失業率偏高，所以推測學歷供過於求。', [fneed('k:hyp3-n1', '大學畢業生占比')])
  ],
  conclusion: ''
});
const facetMismatch = buildFacet('stopped_mismatch', {
  facets: [
    facet(1, '年輕人失業率是否偏高', 'refutes', '2026 年 7 月青年失業率比去年同期低 1.7 個百分點。', '官方資料顯示失業率在下降。', ['k:d1']),
    facet(2, '失業是否集中在高 AI 暴露職業', 'insufficient', '沒有足夠資料。', '資料不足。', []),
    facet(3, '失業率是否在 AI 普及後才上升', 'supports', '部分資料顯示近年略升。', '單一資料。', ['k:d3'])
  ],
  data: [
    fdatum(1, 'k:f1', '16 至 24 歲失業率', { propStance: 'refutes', stanceReason: '失業率比去年低，與「偏高」相反。' }),
    fdatum(3, 'k:f3', '近年失業率變化', { proof: { ...BLS, quote: 'The rate was little changed over the month.', claim: '失業率近月變化不大。', figure: undefined } })
  ],
  gate: { state: 'unmatched', kind: 'not_matching', reason: 'not_matching', citedData: ['k:d1'], round: 1 },
  status: 'finished', stopReason: 'mismatch'
});
const facetInsufficient = buildFacet('stopped_mismatch', {
  facets: [
    facet(1, '年輕人失業率是否偏高', 'insufficient', '只找到一筆舊資料。', '資料不足。', []),
    facet(2, '失業是否集中在高 AI 暴露職業', 'insufficient', '沒有可用資料。', '資料不足。', []),
    facet(3, '失業率是否在 AI 普及後才上升', 'supports', '有一筆資料支持。', '單一資料。', ['k:d3'])
  ],
  data: [
    fdatum(1, 'k:f1', '16 至 24 歲失業率', { state: 'not_found', propStance: undefined, stanceReason: undefined, proof: undefined, attempts: 2, reason: 'budget_exhausted', searchLog: { queries: ['US youth unemployment rate 2026', 'BLS youth unemployment July 2026'], opened: ['https://www.bls.gov/news.release/youth.nr0.htm'], why: '搜尋次數用完（budget），頁面內容沒有數字。' } }),
    fdatum(2, 'k:f2', '高 AI 暴露職業的失業', { state: 'not_found', propStance: undefined, stanceReason: undefined, proof: undefined, attempts: 2, reason: 'budget_exhausted', searchLog: { queries: ['AI exposure occupations unemployment youth'], opened: [], why: '預算用完，沒有找到頁面。' } }),
    fdatum(3, 'k:f3', '近年失業率變化')
  ].map(d => Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined))),
  gate: { state: 'unmatched', kind: 'data_insufficient', reason: 'data_insufficient', citedData: [], round: 2 },
  status: 'finished', stopReason: 'data_missing'
});

/** Swaps every key in `argumentMap` for the node id the loader got back from repo.createNote. */
function bind(argumentMap, idByKey) {
  const swap = value => (typeof value === 'string' && idByKey[value] ? idByKey[value] : Array.isArray(value) ? value.map(swap) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swap(v)])) : value);
  return swap(argumentMap);
}

module.exports = { map: inProgress.map, notes: inProgress.notes, states: { in_progress: inProgress, concluded, stopped_mismatch: mismatch, stopped_limit: limit, facet_matched: facetMatched, facet_mismatch: facetMismatch, facet_insufficient: facetInsufficient }, bind };
