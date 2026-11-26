const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planLivingNodes, hasLivingNodeCycle, shouldRunLivingNode } = require('./support.cjs').load('experiences/visual-map/living-node-plan.ts');
const ai = (id, extra = {}) => ({ id, aiCard: true, prompt: 'research', hasKnowledge: true, ...extra });
const ordinary = (id, extra = {}) => ({ id, prompt: 'old prompt', hasKnowledge: true, ...extra });
const plain = value => JSON.parse(JSON.stringify(value));
const ids = plan => plan.order.map(item => item.id);

test('Run All targets every unlocked AI card, including below locked and ordinary parents', () => {
  const nodes = [ai('root'), ai('locked', { parentId: 'root', aiLocked: true }), ai('leaf', { parentId: 'locked' }), ordinary('plain', { parentId: 'root' }), ai('hidden', { parentId: 'plain', collapsed: true })];
  const plan = planLivingNodes(nodes);
  assert.deepEqual(plain(ids(plan)), ['root', 'leaf', 'hidden']);
  assert.ok(plan.order.every(item => item.forced));
  assert.deepEqual(plain(plan.frozen), ['locked']);
  assert.equal(plan.blocked.size, 0);
  const locked = planLivingNodes(nodes, ['locked']);
  assert.deepEqual(plain(locked.lockedTargets), ['locked']);
  assert.equal(locked.order.length, 0);
});

test('Run Card deduplicates shared direct and explicit dependencies and stops at ordinary cards', () => {
  const nodes = [ai('root', { explicitCardIds: ['left', 'right', 'left'] }), ai('left', { parentId: 'root', explicitCardIds: ['up'] }), ai('right', { explicitCardIds: ['up'] }), ai('up'), ordinary('plain', { parentId: 'left' }), ai('unrelated', { parentId: 'plain' })];
  const plan = planLivingNodes(nodes, ['root']);
  assert.deepEqual(plain(plan.order), [{ id: 'up', forced: false }, { id: 'left', forced: false }, { id: 'right', forced: false }, { id: 'root', forced: true }]);
  assert.equal(plan.blocked.size, 0);
  assert.equal(hasLivingNodeCycle(nodes), false);
});

test('missing or locked-empty dependency blocks only affected targets; valid frozen data is reusable', () => {
  const nodes = [ai('root', { explicitCardIds: ['broken'] }), ai('broken', { explicitCardIds: ['missing'] }), ai('healthy', { explicitCardIds: ['frozen'] }), ai('frozen', { aiLocked: true }), ai('empty', { aiLocked: true, hasKnowledge: false }), ai('needs-empty', { explicitCardIds: ['empty'] })];
  const plan = planLivingNodes(nodes);
  assert.deepEqual(plain(ids(plan)), ['healthy']);
  assert.equal(plan.blocked.get('broken'), 'missing-source');
  assert.equal(plan.blocked.get('root'), 'dependency-blocked');
  assert.equal(plan.blocked.get('needs-empty'), 'locked-without-knowledge');
  assert.deepEqual(plain(plan.frozen), ['frozen']);
});

test('cycles, including self-references, do not dispatch; unrelated branches continue', () => {
  const nodes = [ai('a', { explicitCardIds: ['b'] }), ai('b', { explicitCardIds: ['a'] }), ai('consumer', { explicitCardIds: ['a'] }), ai('self', { explicitCardIds: ['self'] }), ai('good')];
  assert.equal(hasLivingNodeCycle(nodes), true);
  const plan = planLivingNodes(nodes);
  assert.deepEqual(plain(ids(plan)), ['good']);
  for (const id of ['a', 'b', 'consumer', 'self']) assert.equal(plan.blocked.get(id), 'cycle');
  assert.equal(hasLivingNodeCycle([ai('a', { aiLocked: true, explicitCardIds: ['b'] }), ai('b', { explicitCardIds: ['a'] })]), true);
});

test('a blocked target does not cause unnecessary upstream work', () => {
  const plan = planLivingNodes([ai('a', { explicitCardIds: ['valid', 'missing'] }), ai('valid')], ['a']);
  assert.equal(plan.order.length, 0);
  assert.equal(plan.blocked.get('a'), 'missing-source');
});

test('dispatch uses current validity after upstream settlement, not initial derived staleness', () => {
  assert.equal(shouldRunLivingNode(true, 'valid'), true);
  assert.equal(shouldRunLivingNode(false, 'valid'), false);
  assert.equal(shouldRunLivingNode(false, 'none'), true);
  assert.equal(shouldRunLivingNode(false, 'stale'), true);
});

test('empty map and legacy Prompt-only cards produce no work', () => {
  assert.equal(planLivingNodes([]).order.length, 0);
  assert.equal(planLivingNodes([ordinary('old')]).order.length, 0);
  assert.equal(planLivingNodes([ai('blank', { prompt: '  ' })]).order.length, 0);
});

test('deep dependency chains do not recurse on the JavaScript call stack', () => {
  const count = 12000;
  const nodes = Array.from({ length: count }, (_, i) => ai(String(i), { parentId: i ? String(i - 1) : null }));
  const plan = planLivingNodes(nodes, ['0']);
  assert.equal(plan.order.length, count);
  assert.equal(plan.order[0].id, String(count - 1));
  assert.equal(plan.order[count - 1].id, '0');
  assert.equal(hasLivingNodeCycle(nodes), false);
});

test('a pre-existing structural cycle cannot be hidden by a frozen dependency', () => {
  const nodes = [ai('a', { explicitCardIds: ['b'] }), ai('b', { aiLocked: true, explicitCardIds: ['a'] }), ai('consumer', { explicitCardIds: ['b'] }), ai('independent')];
  const plan = planLivingNodes(nodes);
  assert.deepEqual(plain(ids(plan)), ['independent']);
  assert.equal(plan.blocked.get('a'), 'cycle');
  assert.equal(plan.blocked.get('consumer'), 'cycle');
});
