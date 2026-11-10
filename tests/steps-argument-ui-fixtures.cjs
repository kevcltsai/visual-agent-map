// UI fixture facet states (V1 boost): each reads as a usable facet map after bind, and its cards show plain words, never raw reason codes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const fixture = require('./fixtures/argument-map-ui.cjs');
const model = S.load('core/argument-map/model.ts');
const card = S.load('experiences/visual-map/argument-card.ts');
const { translate } = S.load('i18n.ts');

const t = (key, ...values) => translate('zh-TW', key, ...values);
const RAW = /not_matching|data_insufficient|data_missing|stopped_mismatch|stopped_limit|round_limit|budget_|not_found|irrelevant|insufficient|refutes|\bsupports\b|ui\.argument/;

for (const name of ['facet_matched', 'facet_mismatch', 'facet_insufficient']) {
  test(`UI fixture ${name}: usable facet map, every owned card describes without raw reason codes`, () => {
    const one = fixture.states[name];
    assert.ok(one, `${name} exists`);
    const ids = Object.fromEntries(one.notes.map(n => [n.key, `id-${n.key}`]));
    const read = model.readArgumentMap({ nodes: one.notes.map(n => ({ id: ids[n.key] })), argumentMap: fixture.bind(one.map.argumentMap, ids) });
    assert.equal(read.kind, 'usable', read.reason);
    const { facets, assumptions, data } = read.data.situation;
    assert.ok(facets.length >= 3 && assumptions.items.length === 4);
    assert.ok(data.every(d => facets.some(f => f.id === d.facetId)));
    const owned = new Set([...Object.values(read.data.roles), assumptions.id, ...facets.map(f => f.id), ...data.map(d => d.id), ...read.data.hypotheses.flatMap(h => [h.id, ...h.needs.map(n => n.id)])]);
    for (const id of owned) {
      const view = card.describeArgumentCard(read.data, id, t);
      assert.ok(view, id);
      const text = [view.kind, view.title, view.label, ...view.lines, ...view.chips.map(c => c.text), ...(view.definitions || []).flatMap(d => [d.label, d.value])].filter(Boolean).join(' | ');
      assert.doesNotMatch(text, RAW, `${id}: ${text}`);
    }
  });
}
