const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, root, load, plain } = require('../support.cjs');
test('product architecture keeps shell, core, and experiences separated', () => {
  const shell = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  assert.doesNotMatch(shell, /class VisualAgentMapView/);
  assert.doesNotMatch(shell, /class CoffeeTablesView/);
  assert.doesNotMatch(shell, /class AiTaskService/);

  const coreFiles = fs.readdirSync(path.join(root, 'core')).filter(name => name.endsWith('.ts'));
  for (const name of coreFiles) {
    const source = fs.readFileSync(path.join(root, 'core', name), 'utf8');
    assert.doesNotMatch(source, /(?:\.\.\/)+experiences\//, `core/${name} must not import an experience`);
    assert.doesNotMatch(source, /from ["'][^"']*repository["']/, `core/${name} must not depend on repository settings that include experience state`);
  }

  for (const sharedAi of ['types.ts', 'task-policy.ts', 'visual-guidance.ts', 'model-resolution.ts']) {
    const source = fs.readFileSync(path.join(root, 'ai', sharedAi), 'utf8');
    assert.doesNotMatch(source, /from ["'][^"']*repository["']/, `ai/${sharedAi} must stay experience-independent`);
    assert.doesNotMatch(source, /experiences\//, `ai/${sharedAi} must not import an experience`);
  }

  const visualFiles = fs.readdirSync(path.join(root, 'experiences', 'visual-map')).filter(name => name.endsWith('.ts'));
  for (const name of visualFiles) {
    const source = fs.readFileSync(path.join(root, 'experiences', 'visual-map', name), 'utf8');
    assert.doesNotMatch(source, /experiences\/coffee-tables|\.\.\/coffee-tables/, `visual-map/${name} must not import Coffee Tables`);
  }

  const coffeeFiles = fs.readdirSync(path.join(root, 'experiences', 'coffee-tables')).filter(name => name.endsWith('.ts'));
  for (const name of coffeeFiles) {
    const source = fs.readFileSync(path.join(root, 'experiences', 'coffee-tables', name), 'utf8');
    assert.doesNotMatch(source, /experiences\/visual-map|\.\.\/visual-map/, `coffee-tables/${name} must not import Visual Map`);
  }
});
test('thinking artifacts route through shared core without view coupling', async () => {
  const artifacts = load('core/thinking-artifact.ts');
  const { ExperienceRouter } = load('core/experience-router.ts');
  const artifact = artifacts.createThinkingArtifact({
    id: 'artifact-1',
    kind: 'insight',
    title: 'A useful insight',
    content: 'The discussion exposed a tradeoff.',
    origin: { experience: 'coffee-tables', sessionId: 'table-1' },
    sources: [{ label: 'Coffee Table', experience: 'coffee-tables', sessionId: 'table-1' }]
  });
  assert.equal(artifact.version, 1);
  const router = new ExperienceRouter();
  let received;
  const unregister = router.register('visual-map', async value => { received = value; });
  assert.equal(router.canHandoff('visual-map'), true);
  await router.handoff({ target: 'visual-map', artifact });
  assert.deepEqual(plain(received), plain(artifact));
  unregister();
  assert.equal(router.canHandoff('visual-map'), false);
  await assert.rejects(() => router.handoff({ target: 'visual-map', artifact }), /not available/);
});
