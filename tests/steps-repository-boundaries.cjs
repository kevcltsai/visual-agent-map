// The extracted repository modules retain the public facade and the persisted text format.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, obsidian, TFile } = require('./support.cjs');
const repository = load('repository.ts', { obsidian });
const frontmatter = load('core/repository-frontmatter.ts', { obsidian });
const mapContent = load('core/repository-map-content.ts', { obsidian });
const body = load('core/repository-note-body.ts', { obsidian });
const settings = load('core/repository-settings.ts', { obsidian });
const relocation = load('core/repository-relocation.ts', { obsidian });
const workspace = load('core/repository-workspace-move.ts', { obsidian });

test('frontmatter patch preserves CRLF, unrelated lines, body and the facade contract', () => {
  const input = '---\r\nkeep: "value"\r\nremove: old\r\n---\r\n# Title\r\n';
  const expected = '---\r\nkeep: "value"\r\nlist:\r\n  - "one"\r\n  - "two"\r\n---\r\n# Title\r\n';
  const patch = { remove: null, list: ['one', 'two'] };
  assert.equal(frontmatter.setFrontmatterKeys(input, patch), expected);
  assert.equal(repository.setFrontmatterKeys(input, patch), expected);
  assert.equal(frontmatter.frontmatter(expected).keep, 'value');
  assert.equal(frontmatter.setFrontmatterKeys('# No frontmatter', { remove: null }), '# No frontmatter');
});

test('frontmatter patch distinguishes an explicit empty list from a removed key', () => {
  const input = '---\r\nkeep: "value"\r\nlist:\r\n  - "old"\r\n---\r\n# Title\r\n';
  const updated = frontmatter.setFrontmatterKeys(input, { list: [] });
  assert.equal(updated, '---\r\nkeep: "value"\r\nlist: []\r\n---\r\n# Title\r\n');
  assert.deepEqual(JSON.parse(JSON.stringify(frontmatter.frontmatter(updated).list)), []);
  const removed = frontmatter.setFrontmatterKeys(updated, { list: null });
  assert.equal(frontmatter.frontmatter(removed).list, undefined);
  assert.equal(removed, '---\r\nkeep: "value"\r\n---\r\n# Title\r\n');
});

test('frontmatter patch replaces quoted keys without adding duplicates or dropping unrelated keys', () => {
  const input = '---\n"ai-card": false\n\'living-node-refs\' :\n  - "old"\n"unrelated": keep\n---\n# Title\n';
  const updated = frontmatter.setFrontmatterKeys(input, { 'ai-card': true, 'living-node-refs': [] });
  assert.equal(updated, '---\nai-card: true\nliving-node-refs: []\n"unrelated": keep\n---\n# Title\n');
  const removed = frontmatter.setFrontmatterKeys(input, { 'living-node-refs': null });
  assert.equal(removed, '---\n"ai-card": false\n"unrelated": keep\n---\n# Title\n');
});

test('map content preserves unrelated text and orders coordinates independently of viewport', () => {
  const map = { title: 'New title', nodes: [{ id: 'b', x: 2, y: 3 }, { id: 'a', x: 1, y: 4 }], viewport: { x: 20 } };
  const source = '---\nowner: keep\n---\n# Old title\n\n```agent-map\n{}\n```\n\nUser text\n';
  const expected = '---\nowner: keep\n---\n# New title\n\n```agent-map\n' + JSON.stringify(map, null, 2) + '\n```\n\nUser text\n';
  assert.equal(mapContent.writeMapContent(source, map), expected);
  assert.equal(mapContent.coordinatePrint(map), '[["a",1,4],["b",2,3]]');
  assert.equal(repository.coordinatePrint(map), mapContent.coordinatePrint(map));
  assert.equal(mapContent.coordinatePrint({ ...map, viewport: { x: 90 } }), mapContent.coordinatePrint(map));
});

test('note body converts managed callouts, not detail content that resembles a heading', () => {
  const raw = '# Topic\n\n> [!info]- Preview\n> reader text\n\n## Detail\n<!-- visual-agent-map:detail:start -->\n## Prompt\ninside detail\n<!-- visual-agent-map:detail:end -->\n';
  const decoded = body.decodeCalloutSections(raw);
  assert.equal(body.previewSection(decoded), 'reader text');
  assert.equal(body.section(decoded, 'Detail'), '## Prompt\ninside detail');
  assert.equal(body.noteHeadingLanguage(raw), repository.noteHeadingLanguage(raw));
});

test('settings module retains custom workspace and explicit saved container defaults', () => {
  const saved = { workspaceFolder: 'Custom', mindMapsFolder: 'Elsewhere/Maps' };
  const expected = { mindMapsFolder: 'Elsewhere/Maps', aimFolder: 'Custom/AIM' };
  assert.deepEqual({ ...settings.resolveMapFolders(saved) }, expected);
  assert.deepEqual({ ...repository.resolveMapFolders(saved) }, expected);
  assert.equal(settings.isManagedMapPath(settings.DEFAULT_SETTINGS, 'Agent Workspace/Mind Maps/A/Map.md'), true);
  assert.equal(settings.isManagedMapPath(settings.DEFAULT_SETTINGS, 'Agent Workspace/Mind Maps Other/A/Map.md'), false);
});

test('relocation delegates to Obsidian when no resolved link index exists', async () => {
  const calls = [];
  const file = new TFile('A.md');
  await relocation.relocateFile({
    app: { metadataCache: {}, vault: { getAbstractFileByPath: p => p === file.path ? file : undefined }, fileManager: { renameFile: async (item, target) => { calls.push([item.path, target]); item.path = target; } } },
    language: () => 'en',
    message: key => key,
    markedNotes: async () => { throw new Error('unexpected scan'); }
  }, file, 'B.md');
  assert.deepEqual(calls, [['A.md', 'B.md']]);
});

test('workspace move respects disposal before the first write', async () => {
  const calls = [];
  const move = { mapPath: 'Old/A/Map.md', title: 'A', kind: 'mind', fromRoot: 'Old/A', toRoot: 'New/A' };
  await assert.rejects(workspace.moveTopicsWithRollback({
    isDisposed: () => true,
    message: key => key,
    folder: async path => { calls.push(path); },
    rebuildDerivedData: async () => { calls.push('rebuild'); }
  }, [move]), /error.plugin_unloaded/);
  // The existing recovery path still calls rebuild, even when no folder move was admitted.
  assert.deepEqual(calls, ['rebuild']);
});
