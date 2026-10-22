// Model "follow default" (D-2026-10-98): a topic pinned to a model can go back to following the workspace / upper topic.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const support = require('./support.cjs');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

async function setup() {
  const { repo, app } = support.fixture('en');
  repo.settings.cliModel = 'claude:sonnet';
  const root = await support.topicNote(repo, 'Root', 'gpt-5.5');
  await repo.updateNote(root.path, { model: 'gpt-5.5', modelSource: 'manual' });
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', map = support.map([root]); map.id = 'map-a';
  await app.vault.create(mapPath, support.core.serializeMap(map));
  const child = await repo.createNote('Child', 'gpt-5.5', map, mapPath, 'inherited');
  child.parentId = root.id; map.nodes.push(child);
  return { repo, root, child, map };
}

test('root pinned to gpt-5.5 returns to the workspace model after choosing follow default', async () => {
  const { repo, root, map } = await setup();
  assert.equal((await repo.readNote(root.path, map)).model, 'gpt-5.5');
  const follow = await repo.followDefaultModel(root.path, map);
  assert.deepEqual(support.plain(follow), { source: 'workspace', model: 'claude:sonnet' });
  await repo.updateNote(root.path, { modelSource: follow.source });
  const note = await repo.readNote(root.path, map);
  assert.equal(note.modelSource, 'workspace');
  assert.equal(note.model, 'claude:sonnet');
});

test('child follow default resolves through the nearest manual ancestor and is saved as inherited', async () => {
  const { repo, root, child, map } = await setup();
  await repo.updateNote(child.path, { model: 'gpt-6-sol', modelSource: 'manual' });
  const follow = await repo.followDefaultModel(child.path, map);
  assert.deepEqual(support.plain(follow), { source: 'inherited', model: 'gpt-5.5' });
  await repo.updateNote(child.path, { modelSource: follow.source });
  assert.equal((await repo.readNote(child.path, map)).modelSource, 'inherited');
  assert.equal((await repo.readNote(child.path, map)).model, 'gpt-5.5');
  // Root follows the workspace: the whole chain now runs on the workspace model.
  await repo.updateNote(root.path, { modelSource: 'workspace' });
  assert.equal((await repo.readNote(child.path, map)).model, 'claude:sonnet');
});

test('the dialog wiring and strings exist', () => {
  assert.match(read('experiences/visual-map/view.ts'), /followDefault: await this\.plugin\.repo\.followDefaultModel\(/);
  for (const lang of ['en', 'zh-TW', 'zh-CN']) assert.match(read(`i18n/${lang}.ts`), /"ui\.follow_default_model": ".*\{0\}/);
});
