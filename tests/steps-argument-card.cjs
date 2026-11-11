// Argument map card content (P7b): describeArgumentCard is a pure function of the flow state; unit level, no DOM.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const card = S.load('experiences/visual-map/argument-card.ts');
const machine = S.load('core/argument-map/machine.ts');
const { translate } = S.load('i18n.ts');

const t = (key, ...values) => translate('zh-TW', key, ...values);
const roles = { proposition: 'p', situation: 's', conclusion: 'c', verified: 'v', eliminated: 'e' };
const need = (id, state, over = {}) => ({ id, text: id, addedRound: 1, state, ...(state === 'found' ? { stance: 'supports', proof: { url: 'https://www.stats.example.org/a', quote: 'q', claim: `claim-${id}`, check: 'page_match', checkedAt: 'x' } } : {}), ...over });
const hyp = (id, needs, over = {}) => ({ id, citedData: [], round: 1, location: 'verifying', needs, ...over });
const make = (phase, hypotheses = [], over = {}) => {
  const state = machine.newArgumentMap(roles, 'run');
  state.run.phase = phase;
  state.hypotheses = hypotheses;
  Object.assign(state.conclusion, over);
  return state;
};
const verifiedHyp = id => hyp(id, [need(`${id}-n`, 'found')], { aiVerdict: 'supported' });
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
const SECRET = 'NOTE-BODY-SECRET';

test('four conclusion states are derived by the selector, not stored on the card', () => {
  const three = [verifiedHyp('h1'), verifiedHyp('h2'), verifiedHyp('h3')];
  assert.equal(card.describeArgumentCard(make('concluded', three), 'c', t).state, 'concluded');
  assert.equal(card.describeArgumentCard(make('concluded', three.slice(0, 2)), 'c', t).state, 'in_progress', 'support lost falls back to in progress');
  assert.equal(card.describeArgumentCard(make('verifying', three.slice(0, 1)), 'c', t).state, 'in_progress');
  assert.equal(card.describeArgumentCard(make('stopped_limit', three.slice(0, 1)), 'c', t).state, 'stopped_limit');
  assert.equal(card.describeArgumentCard(make('stopped_mismatch'), 'c', t).state, 'stopped_mismatch');
});

test('in-progress and both stopped conclusion cards never read the note: their text comes from the state and t() only', () => {
  for (const phase of ['verifying', 'stopped_limit', 'stopped_mismatch']) {
    const state = make(phase, [verifiedHyp('h1')], { basedOn: [SECRET], missing: [SECRET] });
    state.situation.gate.reason = SECRET;
    const view = card.describeArgumentCard(state, 'c', t);
    assert.equal(view.titleFrom, 'text', phase);
    assert.ok(view.title, phase);
    assert.equal(JSON.stringify(view).includes(SECRET), false, phase);
  }
  const done = card.describeArgumentCard(make('concluded', [verifiedHyp('h1'), verifiedHyp('h2'), verifiedHyp('h3')]), 'c', t);
  assert.equal(done.titleFrom, 'summary', 'only a concluded card shows the note summary');
  assert.equal(card.describeArgumentCard(make('verifying', [verifiedHyp('h1')]), 'c', t).title, '未結案 1／3');
});

test('hypothesis card: 驗證中 while needs are not all found, whatever the stored verdict says', () => {
  const state = make('verifying', [hyp('h1', [need('a', 'found'), need('b', 'pending')], { aiVerdict: 'supported', userVerdict: 'supported' })]);
  const view = card.describeArgumentCard(state, 'h1', t);
  same(view.chips.map(chip => chip.text), ['驗證中']);
  assert.equal(view.chips.some(chip => chip.text.includes('驗證完成')), false);
  assert.ok(view.lines[0].includes('1／2'));
  const ok = card.describeArgumentCard(make('verifying', [verifiedHyp('h1')]), 'h1', t);
  same(ok.chips.map(chip => chip.text), ['被支持', '✓ 驗證完成']);
});

test('eliminated hypothesis shows the eliminated chip and its reason; no verified chip', () => {
  const state = make('verifying', [hyp('h1', [need('a', 'found')], { location: 'eliminated', aiVerdict: 'supported', eliminationReason: 'no data' })]);
  const view = card.describeArgumentCard(state, 'h1', t);
  same(view.chips.map(chip => chip.text), ['已淘汰']);
  assert.ok(view.lines.some(line => line.includes('no data')));
});

test('evidence cards: stance chips for found needs; dashed with a missing chip for the rest', () => {
  const state = make('verifying', [hyp('h1', [need('na', 'found'), need('nb', 'found', { stance: 'contradicts' }), need('nc', 'found', { stance: 'uncertain' }), need('nd', 'pending'), need('ne', 'searching'), need('nf', 'not_found', { reason: 'nothing' })])]);
  const of = id => card.describeArgumentCard(state, id, t);
  same(['na', 'nb', 'nc'].map(id => of(id).chips[0].tone), ['yes', 'no', 'maybe']);
  assert.ok(of('na').kind.includes('stats.example.org') && !of('na').kind.includes('www.'));
  assert.equal(of('na').dashed, undefined);
  for (const id of ['nd', 'ne', 'nf']) assert.equal(of(id).dashed, true, id);
  same(['nd', 'ne', 'nf'].map(id => of(id).chips[0].text), ['還缺・待找', '找資料中', '還缺・找不到']);
  same(['nd', 'ne', 'nf'].map(id => of(id).chips[0].tone), ['gap', 'run', 'gap']);
  assert.ok(of('nf').lines.includes('nothing'));
});

test('situation card: the gate line with the data count; each datum is its own card with a stance chip', () => {
  const state = make('situation');
  state.situation.data = [
    { id: 'd1', need: 'n1', attempts: 1, state: 'found', stance: 'supports', proof: { url: 'https://x.example/a', quote: 'q', claim: 'c1', check: 'page_match', checkedAt: 'x' } },
    { id: 'd2', need: 'n2', attempts: 1, state: 'found', stance: 'opposes', proof: { url: 'https://y.example/a', quote: 'q', claim: 'c2', check: 'page_match', checkedAt: 'x' } },
    { id: 'd3', need: 'n3', attempts: 0, state: 'pending' }
  ];
  const pending = card.describeArgumentCard(state, 's', t);
  same(pending.chips.map(chip => chip.text), ['現況判斷中']);
  assert.ok(pending.lines[0].includes('2／3'));
  state.situation.gate.state = 'matched';
  state.situation.data.pop();
  const matched = card.describeArgumentCard(state, 's', t);
  same(matched.lines, ['✓ 符合命題・2／2 項數據找到']);
  assert.equal(matched.rows, undefined, 'data are cards of their own, not rows');
  assert.equal(card.describeArgumentCard(state, 'd1', t).chips[0].text, '✓ 支持');
  assert.equal(card.describeArgumentCard(state, 'd2', t).chips[0].text, '✕ 方向相反');
  assert.equal(card.describeArgumentCard(state, 'd1', t).role, 'datum');
  state.situation.data.push({ id: 'd4', need: 'n4', attempts: 3, state: 'not_found' });
  assert.equal(card.describeArgumentCard(state, 'd4', t).dashed, true);
});

test('groups, proposition and ordinary cards', () => {
  const state = make('verifying', [verifiedHyp('h1'), hyp('h2', [need('a', 'pending')]), hyp('h3', [], { location: 'eliminated' })]);
  assert.ok(card.describeArgumentCard(state, 'v', t).lines[0].includes('1／3'));
  assert.ok(card.describeArgumentCard(state, 'e', t).lines[0].includes('1'));
  assert.equal(card.describeArgumentCard(state, 'p', t).role, 'proposition');
  assert.equal(card.describeArgumentCard(state, 'free-card', t), null);
});

test('renderArgumentCardBody writes text only (no markup is parsed) and sets the data attributes', () => {
  const made = [];
  const el = tag => { const node = { tag, children: [], dataset: {}, text: undefined }; node.createDiv = o => { const c = el('div'); c.cls = o.cls; node.children.push(c); return c; }; node.createSpan = o => { const c = el('span'); c.cls = o.cls; c.text = o.text; node.children.push(c); return c; }; node.createEl = (_t, o) => { const c = el(_t); c.cls = o.cls; c.text = o.text; node.children.push(c); return c; }; made.push(node); return node; };
  const view = { role: 'need', kind: 'k', titleFrom: 'note', dashed: true, state: 'in_progress', chips: [{ tone: 'gap', text: '<b>x</b>' }], lines: ['<img src=x onerror=1>'], label: 'l' };
  const root = el('div');
  card.renderArgumentCardBody(root, view);
  assert.equal(root.dataset.argumentRole, 'need');
  assert.equal(root.dataset.argumentMissing, 'true');
  assert.equal(root.dataset.argumentState, 'in_progress');
  const flat = [];
  const walk = n => { flat.push(n); n.children.forEach(walk); };
  walk(root);
  assert.ok(flat.some(n => n.text === '<img src=x onerror=1>'));
  assert.equal(flat.some(n => 'innerHTML' in n), false);
});

test('shapeKindFor: an argument map card is always the rectangle ("action"); an ordinary card keeps its own kind', () => {
  const shape = S.load('experiences/visual-map/topic-kind-shape.ts');
  for (const kind of ['topic', 'action', 'atomic', 'hypothesis', 'evidence', 'conclusion']) {
    assert.equal(shape.shapeKindFor(kind, true), 'action', kind);
    assert.equal(shape.shapeKindFor(kind, false), kind, kind);
  }
  assert.equal(shape.TOPIC_KIND_SHAPES.action.shape, 'rect');
});

test('stopped mismatch: the conclusion card says only the stop sentence and its hint; the groups show no "0 / 3" count', () => {
  const state = make('stopped_mismatch');
  const view = card.describeArgumentCard(state, 'c', t);
  assert.equal(view.title, t('ui.argument_stopped_mismatch'));
  same(view.lines, [t('ui.argument_mismatch_hint')]);
  for (const id of ['v', 'e']) {
    const group = card.describeArgumentCard(state, id, t);
    same(group.lines, [], id);
    assert.equal(JSON.stringify(group).includes('0 / 3'), false, id);
  }
  // other phases keep the counts
  assert.ok(card.describeArgumentCard(make('verifying'), 'v', t).lines.length === 1);
});

// ---- P7: a map without facets keeps the V1 card text, byte for byte --------------------------------------------------------------------
test('old map (no facets): every card is identical to the V1 output stored in tests/fixtures/argument-card-v1.json', () => {
  const fs = require('node:fs'), path = require('node:path');
  const proof = { url: 'https://www.stats.example.org/a', quote: 'q', claim: 'c1', check: 'page_match', checkedAt: 'x' };
  const datum = (id, state, over = {}) => ({ id, need: `need-${id}`, attempts: 1, state, ...over });
  const build = (phase, gate, hypotheses) => {
    const state = make(phase, hypotheses);
    state.situation.gate = { citedData: [], ...gate };
    state.situation.data = [datum('d1', 'found', { stance: 'supports', proof }), datum('d2', 'found', { stance: 'opposes', proof }), datum('d3', 'not_found', { reason: 'source_quote_missing' }), datum('d4', 'pending'), datum('d5', 'searching')];
    return state;
  };
  const hyps = [hyp('h1', [need('n1', 'found'), need('n2', 'not_found', { reason: 'not_found: gone' }), need('n3', 'searching')], { aiVerdict: 'supported' }), hyp('h2', [need('n4', 'found', { stance: 'contradicts' })], { location: 'eliminated', eliminationReason: 'round_limit: no more', aiVerdict: 'refuted' }), verifiedHyp('h3'), verifiedHyp('h4')];
  const out = {};
  for (const [name, phase, gate] of [['matched', 'concluded', { state: 'matched' }], ['unmatched', 'stopped_mismatch', { state: 'unmatched', kind: 'not_matching' }], ['missing', 'stopped_mismatch', { state: 'unmatched', kind: 'data_missing', reason: 'x' }], ['pending', 'situation', { state: 'pending' }], ['limit', 'stopped_limit', { state: 'matched' }], ['analysis', 'analysis', { state: 'matched' }]]) {
    const state = build(phase, gate, hyps);
    out[name] = {};
    for (const id of ['p', 's', 'c', 'v', 'e', 'd1', 'd2', 'd3', 'd4', 'd5', 'h1', 'h2', 'h3', 'n1', 'n2', 'n3', 'n4']) out[name][id] = card.describeArgumentCard(state, id, t);
  }
  const file = path.join(__dirname, 'fixtures', 'argument-card-v1.json');
  if (process.env.UPDATE_GOLDEN) fs.writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
  assert.equal(JSON.stringify(out, null, 1) + '\n', fs.readFileSync(file, 'utf8'));
});

// ---- P7: facet-judged maps --------------------------------------------------------------------------------------------------------------
const WHY_CODES = ['budget', 'no_answer', 'not_found', 'stance_uncertain', 'provider_error', 'card_deleted', 'source_rejected_url', 'source_bad_quote', 'source_bad_claim', 'source_network_error', 'source_http_status', 'source_content_type', 'source_no_parser', 'source_quote_missing', 'source_blocked_unverified', 'round_limit'];
const fproof = (over = {}) => ({ url: 'https://www.bls.gov/news/youth.htm', quote: 'The youth rate was 9.1 percent in July 2026', claim: 'Youth rate 9.1% in July 2026', check: 'page_match', checkedAt: 'x', figure: { number: '9.1', period: '2026 年 7 月', unit: '%' }, ...over });
const fdatum = (id, facetId, state, over = {}) => ({ id, need: `need-${id}`, attempts: 1, state, facetId, ...over });
const facetState = (phase = 'analysis', gate = { state: 'matched', citedData: [] }, over = {}) => {
  const state = make(phase, over.hypotheses ?? []);
  state.situation.question = 'Is youth unemployment high?';
  state.situation.assumptions = { id: 'as', items: [{ label: 'Age', value: '16-24', reason: 'BLS youth' }, { label: 'Period', value: '2025-07 on', reason: 'latest' }] };
  state.situation.facets = [
    { id: 'f1', title: 'Versus overall', verdict: 'supports', reason: 'about twice', citedData: ['d1'], summary: 'Youth rate is twice the overall.' },
    { id: 'f2', title: 'Past year', verdict: over.f2 ?? 'insufficient', reason: 'rate fell 1.7 points', citedData: ['d2'], summary: '' },
    { id: 'f3', title: 'Ten-year mean', verdict: 'insufficient', reason: 'none', citedData: [], summary: '' }
  ];
  state.situation.data = [
    fdatum('d1', 'f1', 'found', { stance: 'supports', propStance: 'supports', stanceReason: 'twice', proof: fproof() }),
    fdatum('d2', 'f2', 'found', { stance: 'opposes', propStance: 'refutes', stanceReason: 'lower than last year', proof: fproof({ claim: 'Rate 9.1%, 1.7 points lower than a year ago', url: 'https://www.bls.gov/news/lower.htm' }) }),
    fdatum('d3', 'f1', 'found', { stance: 'supports', propStance: 'irrelevant', stanceReason: 'about jobs counts, not the rate', proof: fproof() }),
    fdatum('d4', 'f1', 'found', { stance: 'supports', proof: fproof() }),
    fdatum('d5', 'f3', 'not_found', { reason: 'source_quote_missing: page has no such text' }),
    fdatum('d6', 'f3', 'not_found', { reason: 'some_unknown_code' }),
    fdatum('d7', 'f3', 'pending'),
    fdatum('d8', 'f3', 'not_found', { reason: 'budget', searchLog: { queries: ['a', 'b'], opened: [], why: 'budget' } })
  ];
  state.situation.gate = gate;
  return state;
};
const allIds = ['p', 's', 'c', 'v', 'e', 'as', 'f1', 'f2', 'f3', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'];
const textOf = view => JSON.stringify(view);

test('facet map: a datum with no propStance never shows 支持命題 (it is not judged yet)', () => {
  const view = card.describeArgumentCard(facetState(), 'd4', t);
  assert.ok(!textOf(view).includes('支持命題'), textOf(view));
  assert.ok(!view.chips.some(c => c.tone === 'yes'), textOf(view));
  assert.equal(view.chips.length, 1);
  const supports = card.describeArgumentCard(facetState(), 'd1', t);
  same(supports.chips, [{ tone: 'yes', text: '支持命題' }]);
});

test('facet map: datum chips and lines (支持命題 / 反駁命題 / 無關 / 還缺・找不到) with the figure line', () => {
  const state = facetState();
  const d1 = card.describeArgumentCard(state, 'd1', t);
  same(d1.lines, ['9.1%（2026 年 7 月）']);
  assert.equal(d1.kind, '數據 · bls.gov');
  same(card.describeArgumentCard(state, 'd2', t).chips, [{ tone: 'no', text: '反駁命題' }]);
  const d3 = card.describeArgumentCard(state, 'd3', t);
  same(d3.chips, [{ tone: 'gap', text: '無關' }]);
  same(d3.lines, ['about jobs counts, not the rate']);
  const d5 = card.describeArgumentCard(state, 'd5', t);
  same(d5.chips, [{ tone: 'gap', text: '還缺・找不到' }]);
  assert.equal(d5.dashed, true);
  assert.equal(card.describeArgumentCard(state, 'd7', t).chips[0].text, '還缺・待找');
  same(card.describeArgumentCard(state, 'd8', t).lines, [t('ui.argument_why_budget'), '查過 2 種寫法，筆記裡有記錄']);
});

test('facet map: no raw reason code is on any card', () => {
  const hyps = [hyp('h1', [need('n1', 'not_found', { reason: 'source_blocked_unverified: x' }), need('n2', 'not_found', { reason: 'budget' })], { aiVerdict: 'undecided' }), hyp('h2', [need('n3', 'found')], { location: 'eliminated', eliminationReason: 'round_limit: stopped', aiVerdict: 'undecided' })];
  const states = [facetState('analysis', undefined, { hypotheses: hyps }), facetState('stopped_mismatch', { state: 'unmatched', kind: 'not_matching', reason: 'budget', citedData: ['d2'] }, { f2: 'refutes', hypotheses: hyps }), facetState('stopped_mismatch', { state: 'unmatched', kind: 'data_insufficient', reason: 'source_quote_missing', citedData: [] }, { hypotheses: hyps })];
  for (const state of states) for (const id of [...allIds, 'h1', 'h2', 'n1', 'n2', 'n3']) {
    const view = card.describeArgumentCard(state, id, t);
    assert.ok(view, id);
    for (const code of WHY_CODES) assert.ok(!new RegExp(`(^|[^a-z_])${code}([^a-z_]|$)`).test(textOf(view)), `${id} shows ${code}: ${textOf(view)}`);
    assert.ok(!/some_unknown_code/.test(textOf(view)), id);
  }
});

test('facet map: situation card (question title, chip, 原因) and the facet cards (面向 N, verdict chip, 小結)', () => {
  const ok = card.describeArgumentCard(facetState(), 's', t);
  assert.equal(ok.titleFrom, 'text');
  assert.equal(ok.title, 'Is youth unemployment high?');
  const refuted = card.describeArgumentCard(facetState('stopped_mismatch', { state: 'unmatched', kind: 'not_matching', citedData: ['d2'] }, { f2: 'refutes' }), 's', t);
  same(refuted.chips, [{ tone: 'no', text: '✕ 不符合命題' }]);
  assert.ok(refuted.lines.some(l => l.startsWith('原因：') && l.includes('Past year') && l.includes('rate fell 1.7 points')), textOf(refuted));
  const lacking = card.describeArgumentCard(facetState('stopped_mismatch', { state: 'unmatched', kind: 'data_insufficient', citedData: [] }), 's', t);
  same(lacking.chips, [{ tone: 'maybe', text: '資料不足' }]);
  assert.ok(lacking.lines.some(l => l.startsWith('原因：')), textOf(lacking));
  const f1 = card.describeArgumentCard(facetState(), 'f1', t);
  assert.equal(f1.kind, '面向 1');
  same(f1.chips, [{ tone: 'yes', text: '支持' }]);
  same(f1.lines, ['小結：Youth rate is twice the overall.']);
  assert.equal(card.describeArgumentCard(facetState(), 'f3', t).kind, '面向 3');
  same(card.describeArgumentCard(facetState(), 'f3', t).chips, [{ tone: 'maybe', text: '資料不足' }]);
  assert.equal(card.describeArgumentCard(facetState(), 'f2', t).lines.length, 0, 'no summary, no 小結 line');
});

test('facet map: the definitions card lists the items as a dl and offers the re-run button', () => {
  const view = card.describeArgumentCard(facetState(), 'as', t);
  assert.equal(view.role, 'assumptions');
  same(view.definitions, [{ label: 'Age', value: '16-24' }, { label: 'Period', value: '2025-07 on' }]);
  assert.equal(view.action.text, '用這組假設重跑…');
  assert.ok(view.action.ariaLabel.includes('重跑'));
  same(view.lines, [t('ui.argument_definitions_hint')]);
});

test('conclusion card: insufficient and mismatch are different views (state, look and text)', () => {
  const mismatch = card.describeArgumentCard(facetState('stopped_mismatch', { state: 'unmatched', kind: 'not_matching', citedData: ['d2'] }, { f2: 'refutes' }), 'c', t);
  const lacking = card.describeArgumentCard(facetState('stopped_mismatch', { state: 'unmatched', kind: 'data_insufficient', citedData: [] }), 'c', t);
  assert.equal(mismatch.state, 'stopped_mismatch');
  assert.equal(lacking.state, 'stopped_insufficient');
  assert.notEqual(mismatch.title, lacking.title);
  assert.equal(lacking.title, '現況資料不足，已停止');
  assert.equal(lacking.kind, '結論・資料不足');
  assert.ok(lacking.lines.includes('還缺：Past year、Ten-year mean'), textOf(lacking));
  assert.ok(!lacking.lines.some(l => l.startsWith('反駁：')));
  assert.equal(mismatch.lines[0], '反駁：面向「Past year」');
  assert.equal(mismatch.lines[1], '數據：Rate 9.1%, 1.7 points lower than a year ago');
  assert.ok(mismatch.lines[2].includes('The youth rate was 9.1 percent'));
  assert.ok(mismatch.lines.includes('https://www.bls.gov/news/lower.htm'), 'the URL is plain text');
  assert.ok(!mismatch.lines.some(l => l.startsWith('還缺')));
  assert.notEqual(card.describeArgumentCard(facetState(), 'c', t).state, 'stopped_insufficient');
});

test('conclusion card: a non-http(s) URL is not shown', () => {
  const state = facetState('stopped_mismatch', { state: 'unmatched', kind: 'not_matching', citedData: ['d2'] }, { f2: 'refutes' });
  state.situation.data[1].proof.url = 'javascript:alert(1)';
  const view = card.describeArgumentCard(state, 'c', t);
  assert.ok(!textOf(view).includes('javascript'));
});

test('definitions card render: a native button with aria-label; pointerdown/keydown never reach the card (no drag); click calls the handler; dl is text only', () => {
  const el = (tag, o = {}) => { const n = { tag, cls: o.cls, text: o.text, attrs: {}, listeners: {}, children: [], dataset: {} }; n.createDiv = x => { const c = el('div', x); n.children.push(c); return c; }; n.createSpan = x => { const c = el('span', x); n.children.push(c); return c; }; n.createEl = (tg, x) => { const c = el(tg, x); n.children.push(c); return c; }; n.setAttr = (k, v) => { n.attrs[k] = v; }; n.addEventListener = (type, fn) => { (n.listeners[type] ??= []).push(fn); }; return n; };
  const view = card.describeArgumentCard(facetState(), 'as', t);
  view.definitions[0].value = '<img src=x onerror=1>';
  const root = el('div'); let clicked = 0;
  card.renderArgumentCardBody(root, view, () => { clicked++; });
  const flat = []; const walk = n => { flat.push(n); n.children.forEach(walk); }; walk(root);
  const button = flat.find(n => n.tag === 'button');
  assert.ok(button, 'a button');
  assert.equal(button.attrs.type, 'button');
  assert.equal(button.attrs['aria-label'], view.action.ariaLabel);
  for (const type of ['pointerdown', 'mousedown', 'keydown']) {
    let stopped = false;
    button.listeners[type].forEach(fn => fn({ stopPropagation: () => { stopped = true; } }));
    assert.ok(stopped, `${type} stops at the button`);
  }
  button.listeners.click.forEach(fn => fn({ stopPropagation() {} }));
  assert.equal(clicked, 1);
  assert.deepEqual(flat.filter(n => n.tag === 'dt').map(n => n.text), ['Age', 'Period']);
  assert.ok(flat.some(n => n.tag === 'dd' && n.text === '<img src=x onerror=1>'));
  assert.equal(flat.some(n => 'innerHTML' in n), false);
});

test('live4: a facet-map card for a not-found datum or need shows readable text for a plain or composite reason', () => {
  const NOTE = 'BLS 2026年10月新聞稿沒有16至24歲合併數字';
  const st = facetState();
  st.situation.data.push(
    fdatum('d9', 'f3', 'not_found', { reason: 'not_found', searchLog: { queries: ['q'], opened: [], why: `not_found: ${NOTE}` } }),
    fdatum('d10', 'f3', 'not_found', { reason: `source_quote_missing: ${NOTE}` })
  );
  st.hypotheses = [hyp('h1', [need('n1', 'not_found', { reason: `not_found: ${NOTE}` })])];
  for (const id of ['d9', 'd10', 'n1']) {
    const text = textOf(card.describeArgumentCard(st, id, t));
    for (const code of WHY_CODES) assert.ok(!text.includes(code), `${code} in ${id}: ${text}`);
  }
});
