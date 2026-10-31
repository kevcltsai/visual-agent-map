// MS-08 P8b: a card whose model is its own (manual, or inherited from a manual ancestor) carries a quiet model tag;
// a card that follows the current model has none and never changes when the current model changes; the share file never has the tag.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support.cjs');
const replay = require('./support-replay.cjs');
const dom = require('./support-dom.cjs');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const { VisualAgentMapView } = replay.load(
  'experiences/visual-map/view.ts',
  { obsidian: { ...S.obsidian, Component: class {}, MarkdownRenderChild: class {} } },
  { window: { setTimeout, clearTimeout }, CSS: { escape: s => s } }
);
const { t } = S.load('i18n.ts');
const view = () => Object.assign(Object.create(VisualAgentMapView.prototype), { plugin: { modelLabel: id => `L:${id}` } });
const tags = header => dom.findAll(header, item => (item.cls ?? '').split(/\s+/).includes('vam-node-model-tag'));
const paint = (header, note) => view().paintModelTag(header, note);

test('an override card shows the tag with the model label, an accessible name and a title', () => {
  const header = dom.element('div');
  paint(header, { model: 'gpt-x', modelOverride: true });
  const [tag] = tags(header);
  assert.equal(tags(header).length, 1);
  assert.equal(tag.tag, 'span');
  assert.equal(tag.text, 'L:gpt-x');
  assert.equal(tag.attrs['aria-label'], t('ui.card_model_override_0', 'L:gpt-x'));
  assert.equal(tag.attrs.title, t('ui.card_model_override_0', 'L:gpt-x'));
});

test('counterexample: a card that follows the current model has no tag', () => {
  const header = dom.element('div');
  paint(header, { model: 'gpt-x' });
  paint(header, { model: 'gpt-x', modelOverride: false });
  paint(header, undefined);
  assert.equal(tags(header).length, 0);
});

test('counterexample: switching the current model leaves an override tag as it was and gives a following card none', () => {
  const v = view();
  const override = dom.element('div'), following = dom.element('div');
  v.paintModelTag(override, { model: 'manual-m', modelOverride: true });
  v.paintModelTag(following, { model: 'current-1' });
  // The note read after the switch: the override keeps its own model, the other follows the new current model.
  v.paintModelTag(override, { model: 'manual-m', modelOverride: true });
  v.paintModelTag(following, { model: 'current-2' });
  assert.deepEqual(tags(override).map(item => item.text), ['L:manual-m']);
  assert.equal(tags(following).length, 0);
});

test('painting again replaces the tag (no duplicates) and removes it when the override ends', () => {
  const header = dom.element('div');
  paint(header, { model: 'a', modelOverride: true });
  paint(header, { model: 'b', modelOverride: true });
  assert.deepEqual(tags(header).map(item => item.text), ['L:b']);
  paint(header, { model: 'b' });
  assert.equal(tags(header).length, 0);
});

test('renderNode and refreshCard both paint the tag, next to (not inside) the marker row', () => {
  const source = read('experiences/visual-map/view.ts');
  assert.equal((source.match(/this\.paintModelTag\(header, note\)/g) ?? []).length, 2);
  const method = source.match(/private paintCardMarkers[\s\S]*?\n  }\n/)[0];
  assert.ok(!method.includes('model-tag'), 'the marker row code is untouched');
});

test('readNote flags a manual topic and a child of a manual ancestor, and no workspace or plain inherited topic', async () => {
  const { repo, contents } = S.fixture();
  const parent = await S.topicNote(repo);
  const noOverride = await repo.readNote(parent.path);
  assert.equal('modelOverride' in noOverride, false);
  await repo.updateNote(parent.path, { model: 'model-b', modelSource: 'manual' });
  assert.equal((await repo.readNote(parent.path)).modelOverride, true);
  await repo.updateNote(parent.path, { modelSource: 'inherited' });
  assert.equal('modelOverride' in (await repo.readNote(parent.path)), false, 'inherited with no manual ancestor: no override');
  assert.ok(contents.get(parent.path));
});

test('readNote flags a child that inherits a manual ancestor model, and not a child under a workspace root', async () => {
  const { repo, app } = S.fixture('en');
  repo.settings = { ...S.DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const doc = { id: 'map-a', title: 'M', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a');
  const add = async (title, parent) => {
    const created = await repo.createNote(title, 'gpt-6-luna', doc, mapPath, parent ? 'inherited' : 'workspace');
    Object.assign(created, { parentId: parent?.id ?? null, x: 0, y: 0 });
    doc.nodes.push(created);
    return created;
  };
  const root = await add('Root'), child = await add('Child', root);
  await app.vault.create(mapPath, S.core.serializeMap(doc));
  assert.equal('modelOverride' in (await repo.readNote(child.path, doc)), false, 'workspace root: the child follows the current model');
  await repo.updateNote(root.path, { model: 'model-b', modelSource: 'manual' });
  const note = await repo.readNote(child.path, doc);
  assert.equal(note.modelOverride, true);
  assert.equal(note.model, 'model-b');
});

test('the tag style is muted small text from theme variables', () => {
  const rule = read('styles.css').split('\n').find(line => line.startsWith('.vam-node-model-tag'));
  assert.ok(rule);
  assert.match(rule, /color: var\(--text-muted\)/);
  assert.match(rule, /font-size: var\(--font-ui-smaller\)/);
  assert.doesNotMatch(rule, /#[0-9a-fA-F]{3,8}\b|rgb\(/, 'no fixed colours: light and dark both follow the theme');
});

test('counterexample: the share file (shell, payload and stylesheet) never mentions the model tag', () => {
  const html = S.load('experiences/sharing/share-html.ts');
  const text = S.load('experiences/sharing/share-viewer-text.ts');
  const data = JSON.parse(read('tests/fixtures/sharing/viewer-payload.json'));
  const output = html.renderShareHtml(data, text.shareViewerUiFor('en'));
  assert.ok(output.length > 1000);
  assert.ok(!output.includes('vam-node-model-tag'));
});
