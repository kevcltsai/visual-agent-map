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
  same(['nd', 'ne', 'nf'].map(id => of(id).chips[0].text), ['還缺・待找', '還缺・搜尋中', '還缺・找不到']);
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
