// A paused run: the card of the phase it stopped in says so, why, and offers the bar's 接續. Also the 競爭解釋 label and readable need cards.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support.cjs');
const card = S.load('experiences/visual-map/argument-card.ts');
const machine = S.load('core/argument-map/machine.ts');
const { translate } = S.load('i18n.ts');

const t = (key, ...values) => translate('zh-TW', key, ...values);
const roles = { proposition: 'p', situation: 's', conclusion: 'c', verified: 'v', eliminated: 'e' };
const make = (phase, status, stopReason, facets = false) => {
  const state = machine.newArgumentMap(roles, 'run');
  state.run.phase = phase;
  state.run.status = status;
  if (stopReason) state.run.stopReason = stopReason;
  if (facets) state.situation.facets = [{ id: 'f1', title: 'F', verdict: 'pending', reason: '', citedData: [], summary: '' }];
  return state;
};
const view = (state, id) => card.describeArgumentCard(state, id, t);
const chipTexts = v => [...v.chips.map(c => c.text)];

for (const facets of [false, true]) {
  const kind = facets ? 'facet map' : 'old map';
  test(`${kind}: paused in the situation phase: the situation card shows 已暫停 + reason + 接續, never 現況判斷中`, () => {
    const v = view(make('situation', 'paused', 'user', facets), 's');
    assert.deepEqual(chipTexts(v), ['已暫停']);
    assert.ok(v.lines.includes('原因：你已停止'), JSON.stringify(v));
    assert.equal(v.resume.text, '接續');
    assert.ok(v.resume.ariaLabel);
    assert.ok(!JSON.stringify(v).includes('判斷中'));
    assert.equal(view(make('situation', 'paused', 'user', facets), 'c').resume, undefined, 'the conclusion card is quiet');
  });
  test(`${kind}: paused in analysis: the conclusion card carries it, the situation card does not`, () => {
    const state = make('analysis', 'paused', 'error', facets);
    state.situation.gate = { state: 'matched', citedData: [] };
    const v = view(state, 'c');
    assert.deepEqual(chipTexts(v), ['已暫停']);
    assert.ok(v.lines.includes('原因：AI 回覆格式不對，重試一次仍失敗'), JSON.stringify(v));
    assert.equal(v.resume.text, '接續');
    assert.equal(view(state, 's').resume, undefined);
    assert.ok(!chipTexts(view(state, 's')).includes('已暫停'));
  });
  test(`${kind}: a finished run offers no 接續 and no 已暫停`, () => {
    for (const [phase, id] of [['concluded', 'c'], ['stopped_limit', 'c'], ['stopped_mismatch', 'c']]) {
      const v = view(make(phase, 'finished', 'limit', facets), id);
      assert.equal(v.resume, undefined, phase);
      assert.ok(!chipTexts(v).includes('已暫停'), phase);
    }
    assert.equal(view(make('analysis', 'running', undefined, facets), 'c').resume, undefined);
  });
}

test('every stop reason reads as plain words; an unknown reason adds no raw code', () => {
  const reasons = { user: '你已停止', interrupted: '上次中斷', limit: '研究次數已用完' };
  for (const [code, text] of Object.entries(reasons)) {
    const v = view(make('situation', 'paused', code, true), 's');
    assert.ok(v.lines.includes(`原因：${text}`), code);
  }
  const none = view(make('situation', 'paused', undefined, true), 's');
  assert.ok(none.lines.every(l => !l.startsWith('原因')));
  assert.ok(none.resume);
});

const el = (tag, o = {}) => { const n = { tag, cls: o.cls, text: o.text, attrs: {}, listeners: {}, children: [], dataset: {} }; n.createDiv = x => { const c = el('div', x); n.children.push(c); return c; }; n.createSpan = x => { const c = el('span', x); n.children.push(c); return c; }; n.createEl = (tg, x) => { const c = el(tg, x); n.children.push(c); return c; }; n.setAttr = (k, v) => { n.attrs[k] = v; }; n.addEventListener = (type, fn) => { (n.listeners[type] ??= []).push(fn); }; return n; };
test('the card 接續 is a native labelled button, stops pointer/key events, and click calls the resume handler (not the re-run one)', () => {
  const v = view(make('situation', 'paused', 'user', true), 's');
  const root = el('div'); let resumed = 0, rerun = 0;
  card.renderArgumentCardBody(root, v, () => { rerun++; }, () => { resumed++; });
  const flat = []; const walk = n => { flat.push(n); n.children.forEach(walk); }; walk(root);
  const buttons = flat.filter(n => n.tag === 'button');
  assert.equal(buttons.length, 1);
  const button = buttons[0];
  assert.equal(button.text, '接續');
  assert.equal(button.attrs.type, 'button');
  assert.equal(button.attrs['aria-label'], v.resume.ariaLabel);
  for (const type of ['pointerdown', 'mousedown', 'keydown']) {
    let stopped = false;
    button.listeners[type].forEach(fn => fn({ stopPropagation: () => { stopped = true; } }));
    assert.ok(stopped, type);
  }
  button.listeners.click.forEach(fn => fn({ stopPropagation() {} }));
  assert.deepEqual([resumed, rerun], [1, 0]);
});

test('view.ts: the card and the bar call the same requestArgumentResume, which calls argumentRuns.resume', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'experiences/visual-map/view.ts'), 'utf8');
  assert.equal(src.split('argumentRuns.resume(').length - 1, 1, 'one resume call site');
  assert.equal(src.split('requestArgumentResume(this.plugin').length - 1, 2, 'bar and card both go through requestArgumentResume');
});

const hyp = (id, needs, over = {}) => ({ id, citedData: [], round: 1, location: 'verifying', needs, ...over });
const proof = { url: 'https://www.stats.example.org/a', quote: 'q', claim: 'claim', check: 'page_match', checkedAt: 'x' };
test('facet map: 競爭解釋 label only when alternative is true; an old map never shows it', () => {
  const state = make('analysis', 'running', undefined, true);
  state.hypotheses = [hyp('h1', [], { alternative: true }), hyp('h2', [], { alternative: false }), hyp('h3', [])];
  assert.equal(view(state, 'h1').kind, '假設 1・競爭解釋');
  assert.ok(view(state, 'h1').label.startsWith('假設 1・競爭解釋'));
  assert.equal(view(state, 'h2').kind, '假設 2');
  assert.equal(view(state, 'h3').kind, '假設 3');
  const old = make('analysis', 'running');
  old.hypotheses = [hyp('h1', [], { alternative: true })];
  assert.equal(view(old, 'h1').kind, '假設 1');
});

test('facet map: need cards under a hypothesis read as 支持/反對/不確定 and dashed 還缺 with readable reasons', () => {
  const state = make('analysis', 'running', undefined, true);
  const found = (id, stance) => ({ id, text: id, addedRound: 1, state: 'found', stance, proof });
  state.hypotheses = [hyp('h1', [
    found('n1', 'supports'), found('n2', 'contradicts'), found('n3', 'uncertain'),
    { id: 'n4', text: 'x', addedRound: 1, state: 'not_found', reason: 'no_answer' },
    { id: 'n5', text: 'x', addedRound: 1, state: 'pending' }
  ])];
  const chips = ['n1', 'n2', 'n3'].map(id => chipTexts(view(state, id))[0]);
  ['支持', '反對', '不確定'].forEach((word, i) => assert.ok(chips[i].includes(word), chips[i]));
  const missing = view(state, 'n4');
  assert.equal(missing.dashed, true);
  assert.match(chipTexts(missing)[0], /還缺/);
  assert.ok(missing.lines.length === 1 && !/no_answer/.test(missing.lines[0]), JSON.stringify(missing));
  assert.equal(view(state, 'n5').dashed, true);
  assert.match(chipTexts(view(state, 'n5'))[0], /待找/);
});
