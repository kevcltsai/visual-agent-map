// UI audit bugfix-2 P2: a map whose frontmatter does not parse is skipped with a notice (the good maps still load), and a hover preview is not dropped in a narrow pane.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, core, fixture, obsidian } = require('./support.cjs');
const { placeHoverPreview, shrinkHoverPreview } = load('ui/preview-utils.ts', { obsidian });

test('P2 preview: a 160 preview that fits no side at full size is narrowed beside the card, inside the pane, not over the card', () => {
  const host = { width: 640, height: 775 };
  const card = { left: 300, top: 300, right: 420, bottom: 380 };
  const preview = { width: 427, height: 560 };
  assert.equal(placeHoverPreview(host, card, preview), null, 'no full-size side has room (the case the bug reports)');
  const spot = shrinkHoverPreview(host, card, preview);
  assert.ok(spot, 'a narrower preview is still shown');
  assert.ok(spot.width >= 180 && spot.width < preview.width, 'narrowed to the room beside the card');
  const right = spot.left + spot.width, bottom = spot.top + preview.height;
  assert.ok(spot.left >= 12 && spot.top >= 12 && right <= host.width - 12 && bottom <= host.height - 12, 'inside the pane');
  assert.ok(right <= card.left || spot.left >= card.right || bottom <= card.top || spot.top >= card.bottom, 'does not cover the card');
});

test('P2 preview: a cramped pane with no room beside the card still shows no preview', () => {
  assert.equal(shrinkHoverPreview({ width: 300, height: 300 }, { left: 20, top: 20, right: 280, bottom: 280 }, { width: 276, height: 276 }), null);
});

test('P2 map state: a Map.md with broken frontmatter is skipped and reported as skipped; a valid map is unchanged', async () => {
  const { repo, app } = fixture('zh-TW');
  const GOOD = 'Agent Workspace/Topics/good/Map.md', BAD = 'Agent Workspace/Topics/bad/Map.md';
  const goodMap = { id: 'map-good', title: 'Good', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/good');
  await repo.ensureTopicFolders('Agent Workspace/Topics/bad');
  await app.vault.create(GOOD, core.serializeMap(goodMap));
  await app.vault.create(BAD, '---\nvisual-agent-map: [unclosed\n---\n# Bad\n');
  const realCache = app.metadataCache.getFileCache.bind(app.metadataCache);
  // Obsidian keeps no `frontmatter` for a block it cannot parse, but still reports where the block is.
  app.metadataCache.getFileCache = file => (file.path === BAD ? { frontmatterPosition: { start: { line: 0, col: 0, offset: 0 }, end: { line: 2, col: 3, offset: 40 } } } : realCache(file));
  const reports = [];
  repo.onUnreadableMaps = failures => reports.push(...failures);
  const readable = await repo.readableMaps();
  // Spread copies the vm-realm array (load() runs the module in a new context) so deepStrictEqual compares values only.
  assert.deepEqual([...readable.map(item => item.file.path)], [GOOD], 'the broken map is not a readable map');
  assert.equal(readable[0].map.title, 'Good', 'the valid map parses as before');
  assert.equal(reports.length, 1, 'one report for the broken map');
  assert.equal(reports[0].path, BAD);
  assert.ok(reports[0].error.length > 0, 'the reason is given');
});
