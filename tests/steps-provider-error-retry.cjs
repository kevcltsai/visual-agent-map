// MS-09 P9a: provider errors are classified from the raw failure message, and a failed card or batch offers one retry on the
// other provider (this run only). Counterexamples: timeouts and format errors, no usable other provider, mixed batches.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const replay = require('./support-replay.cjs');

const { classifyProviderError, providerOfFailure, otherProviderModel } = S.load('ai/provider-error.ts');
const { VisualAgentMapView } = replay.load(
  'experiences/visual-map/view.ts',
  { obsidian: { ...S.obsidian, Component: class {}, MarkdownRenderChild: class {} } },
  { window: { setTimeout, clearTimeout }, CSS: { escape: s => s } }
);

// The real sample stored in `last-error` when a Codex account has run out of quota.
const CODEX_QUOTA = "You've hit your usage limit. Upgrade to Pro, visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:21 PM.";

test('classification: Codex quota sample, auth and unavailable-model messages', () => {
  assert.equal(classifyProviderError(CODEX_QUOTA), 'quota');
  assert.equal(classifyProviderError("You've hit your usage limit"), 'quota');
  assert.equal(classifyProviderError('429 rate limit exceeded'), 'quota');
  assert.equal(classifyProviderError('Not logged in · Please run /login'), 'auth');
  assert.equal(classifyProviderError('HTTP 401 invalid api key'), 'auth');
  assert.equal(classifyProviderError('The model `gpt-9` does not exist or is not supported'), 'model-unavailable');
  assert.equal(classifyProviderError('unknown model: foo'), 'model-unavailable');
});

test('counterexample: timeouts, network errors and format errors are not provider errors', () => {
  for (const reason of ['The AI call timed out after 300 seconds', 'ECONNRESET: network error', 'fetch failed', 'The reply was not valid JSON', 'Response did not match the schema', '', undefined, null])
    assert.equal(classifyProviderError(reason), null, String(reason));
});

test('provider of the failure: the message wins, otherwise the topic model', () => {
  assert.equal(providerOfFailure(CODEX_QUOTA, 'claude:sonnet'), 'codex');
  assert.equal(providerOfFailure('Claude usage limit reached', 'gpt-5.6-luna'), 'claude');
  assert.equal(providerOfFailure("You've hit your usage limit", 'claude:opus'), 'claude');
  assert.equal(providerOfFailure("You've hit your usage limit", 'gpt-5.6-luna'), 'codex');
});

test('other provider model: Codex fails -> claude:sonnet only when Claude is available', () => {
  assert.equal(otherProviderModel('codex', ['gpt-5.6-luna', 'claude:sonnet', 'claude:opus'], 'gpt-5.6-luna'), 'claude:sonnet');
  assert.equal(otherProviderModel('codex', ['gpt-5.6-luna'], 'gpt-5.6-luna'), null);
});

test('other provider model: Claude fails -> current Codex model, then fallback, then first Codex; none -> null', () => {
  const available = ['claude:sonnet', 'gpt-a', 'gpt-5.6-luna', 'gpt-b'];
  assert.equal(otherProviderModel('claude', available, 'gpt-b'), 'gpt-b');
  assert.equal(otherProviderModel('claude', available, 'claude:opus'), 'gpt-5.6-luna');
  assert.equal(otherProviderModel('claude', ['claude:sonnet', 'gpt-a', 'gpt-b'], 'claude:opus'), 'gpt-a');
  assert.equal(otherProviderModel('claude', ['claude:sonnet', 'claude:opus'], 'claude:opus'), null);
});

// ---- the view: button decision and the retry run ----
function fixture({ notes, available = ['gpt-5.6-luna', 'claude:sonnet'], current = 'gpt-5.6-luna' }) {
  const noteMap = new Map(Object.entries(notes));
  const nodes = Object.keys(notes).map(id => ({ id, path: `${id}.md`, parentId: null }));
  const started = [];
  const view = Object.assign(Object.create(VisualAgentMapView.prototype), {
    plugin: { availableModels: () => available, settings: { cliModel: current }, modelLabel: id => `L:${id}` },
    notes: noteMap,
    map: { nodes },
    multiSelected: new Set(),
    integrationMode: false,
    closed: true,
    startMultiResearch: async (request, key) => { started.push({ request, key, selected: [...view.multiSelected] }); },
    buttons: [],
    button(parent, text, onClick) { view.buttons.push({ text, onClick }); return { addClass() {}, setAttr() {} }; }
  });
  return { view, nodes, started };
}
const failed = (model, lastError) => ({ title: 'T', status: 'error', model, lastError });

test('a quota failure on Codex offers claude:sonnet; pressing it runs this batch once with that model and touches no note', async () => {
  const notes = { a: failed('gpt-5.6-luna', CODEX_QUOTA) };
  const { view, nodes, started } = fixture({ notes });
  const before = JSON.stringify([...view.notes]);
  assert.equal(view.otherProviderTarget(nodes), 'claude:sonnet');
  view.renderOtherProviderButton({}, nodes, 'key');
  assert.equal(view.buttons.length, 1);
  assert.match(view.buttons[0].text, /L:claude:sonnet/);
  await view.buttons[0].onClick();
  assert.equal(started.length, 1);
  assert.equal(started[0].request.model, 'claude:sonnet');
  assert.deepEqual(started[0].selected, ['a']);
  assert.equal(started[0].key, 'key');
  assert.equal(JSON.stringify([...view.notes]), before, 'cliModel-independent: model, model-source and frontmatter fields are not written');
  assert.equal(view.plugin.settings.cliModel, 'gpt-5.6-luna');
});

test('counterexample: a timeout or format error gets no button', () => {
  for (const reason of ['The AI call timed out', 'not valid JSON']) {
    const { view, nodes } = fixture({ notes: { a: failed('gpt-5.6-luna', reason) } });
    assert.equal(view.otherProviderTarget(nodes), null);
    view.renderOtherProviderButton({}, nodes);
    assert.equal(view.buttons.length, 0);
  }
});

test('counterexample: Claude failed and no Codex model is available -> no button', () => {
  const { view, nodes } = fixture({ notes: { a: failed('claude:sonnet', 'Claude usage limit reached') }, available: ['claude:sonnet', 'claude:opus'], current: 'claude:sonnet' });
  assert.equal(view.otherProviderTarget(nodes), null);
});

test('counterexample: Codex failed and Claude is not available -> no button', () => {
  const { view, nodes } = fixture({ notes: { a: failed('gpt-5.6-luna', CODEX_QUOTA) }, available: ['gpt-5.6-luna'] });
  assert.equal(view.otherProviderTarget(nodes), null);
});

test('counterexample: a batch whose failures belong to two providers shows no button; a uniform one does', () => {
  const mixed = fixture({ notes: { a: failed('gpt-5.6-luna', CODEX_QUOTA), b: failed('claude:sonnet', 'Claude usage limit reached') } });
  assert.equal(mixed.view.otherProviderTarget(mixed.nodes), null);
  const same = fixture({ notes: { a: failed('gpt-5.6-luna', CODEX_QUOTA), b: failed('gpt-5.6-luna', "You've hit your usage limit") } });
  assert.equal(same.view.otherProviderTarget(same.nodes), 'claude:sonnet');
  const oneOther = fixture({ notes: { a: failed('gpt-5.6-luna', CODEX_QUOTA), b: failed('gpt-5.6-luna', 'timed out') } });
  assert.equal(oneOther.view.otherProviderTarget(oneOther.nodes), null, 'a failure that is not a provider error blocks the batch button');
});

test('counterexample: a topic that is not in error state gets no button', () => {
  const { view, nodes } = fixture({ notes: { a: { title: 'T', status: 'completed', model: 'gpt-5.6-luna', lastError: CODEX_QUOTA } } });
  assert.equal(view.otherProviderTarget(nodes), null);
});
