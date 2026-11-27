const assert = require('node:assert/strict');
const S = require('../support.cjs');
const { commitLivingMarkdown, livingSnapshotRevision } = S.load('experiences/visual-map/living-node-markdown.ts', { obsidian: S.obsidian });
const { livingMarkerState, isLivingNodeNote } = S.load('core/living-node-region.ts', { obsidian: S.obsidian });
const BEGIN = '<!-- vam-living-node:begin v1 -->', END = '<!-- vam-living-node:end v1 -->';
const head = (flag = true) => `---\nagent-map-node: true\nagent-map-id: map\ntopic-id: map\nnode-id: card\n${flag ? 'ai-card: true\n' : ''}living-node-region-hash: "abc"\nliving-node-outcome: "ok"\ncustom-key: keep\n---\n# Title\n\n## Prompt\n\nQuestion\n\n## Detail\n\nManual detail.\n\n`;
const paired = `${BEGIN}\nregion\n${END}\n`;
const corrupt = {
  'unpaired begin': `${BEGIN}\nregion\n`,
  'unpaired end': `region\n${END}\n`,
  'duplicate begin': `${BEGIN}\n${BEGIN}\nregion\n${END}\n`,
  'duplicate end': `${BEGIN}\nregion\n${END}\n${END}\n`,
  'end before begin': `${END}\nregion\n${BEGIN}\n`
};
const path = 'card.md';
const en = () => S.i18nSource('en').match(/"error\.living_node_markers_damaged":\s*"([^"]+)"/)?.[1];
async function setup(text) { const f = S.fixture('en'); await f.app.vault.create(path, text); return f; }
const message = /Living Node markers.*damaged/;

S.integrationTest('writer admission: the marker state is none, paired or corrupt', () => {
  assert.equal(livingMarkerState('plain'), 'none');
  assert.equal(livingMarkerState(`a ${paired} b`), 'paired');
  for (const text of Object.values(corrupt)) assert.equal(livingMarkerState(text), 'corrupt');
});

S.integrationTest('writer admission: book callout writes use the marker-keyed Living Node test, not only the flag', () => {
  assert.equal(isLivingNodeNote(head(false) + paired, {}), true);
  assert.equal(isLivingNodeNote(head(false) + corrupt['unpaired end'], {}), true);
  assert.equal(isLivingNodeNote('---\ncustom: 1\n---\n# Plain\n', {}), false);
  assert.equal(isLivingNodeNote('---\nai-card: true\n---\n# Flag only\n', { 'ai-card': true }), true);
  assert.ok(require('node:fs').readFileSync(require('node:path').join(S.root, 'main.ts'), 'utf8').includes('canWrite: content => !isLivingNodeNote('));
});

S.integrationTest('writer admission: a converted managed region (no ai-card flag) refuses every AI writer', async () => {
  const f = await setup(head(false) + paired);
  const before = f.contents.get(path);
  for (const options of [{ rejectAiCard: true }, { newVisualReferences: true }])
    await assert.rejects(() => f.repo.updateNoteGuarded(path, { detail: 'AI' }, options), /Run card/);
  let invoked = false;
  await assert.rejects(() => f.repo.updateNoteRawGuarded(path, () => { invoked = true; return 'x'; }, { rejectAiCard: true }), /Run card/);
  assert.equal(invoked, false);
  assert.equal(f.contents.get(path), before);
  // A stale late callback is discarded before it can write, and a manual (unflagged) write still works.
  assert.equal(await f.repo.updateNoteGuarded(path, { detail: 'late' }, { rejectAiCard: true, expectedContent: 'older' }), 'discarded');
  assert.equal(await f.repo.updateNoteGuarded(path, { detail: 'Owner edit' }), 'written');
});

S.integrationTest('writer admission: a region-less ordinary note and a healthy region keep ordinary writers', async () => {
  const f = await setup(head(false).replace('living-node-region-hash: "abc"\nliving-node-outcome: "ok"\n', ''));
  assert.equal(await f.repo.updateNoteGuarded(path, { detail: 'Research' }, { rejectAiCard: true, newVisualReferences: true }), 'written');
  assert.ok(f.contents.get(path).includes('Research'));
  const g = await setup(head() + paired);
  assert.equal(await g.repo.updateNoteGuarded(path, { status: 'error', lastError: 'x' }), 'written');
  assert.ok(g.contents.get(path).includes(paired));
});

for (const [name, tail] of Object.entries(corrupt)) for (const flag of [true, false]) {
  const label = `writer admission: ${name}${flag ? '' : ' (no ai-card flag)'}`;
  S.integrationTest(`${label}: whole-body, section, raw, AI and formal writers refuse and leave bytes untouched`, async () => {
    const f = await setup(head(flag) + tail);
    const before = f.contents.get(path);
    const check = async work => { await assert.rejects(work, message); assert.equal(f.contents.get(path), before); };
    await check(() => f.repo.updateNoteGuarded(path, { detail: 'Edited' }));
    await check(() => f.repo.updateNoteGuarded(path, { summary: 'Edited' }));
    await check(() => f.repo.updateNoteGuarded(path, { prompt: 'Edited' }));
    await check(() => f.repo.updateNoteGuarded(path, { detail: 'AI' }, { rejectAiCard: true }));
    await check(() => f.repo.updateNoteGuarded(path, { detail: 'AI' }, { newVisualReferences: true }));
    await check(() => f.repo.updateNote(path, { detail: 'Edited' }));
    await check(() => f.repo.updateNoteRawGuarded(path, c => c + '\nappended'));
    await check(() => f.repo.updateNoteRawGuarded(path, () => 'replaced', { rejectAiCard: true }));
    await check(() => f.repo.updateNoteRawGuarded(path, c => c.replace('living-node-outcome: "ok"', 'living-node-outcome: "failed"')));
    await check(() => f.repo.updateNoteRawGuarded(path, c => c.replace('# Title', '# Changed')));
    await check(() => f.repo.clearPrompt(path));
    const candidate = { executionId: 'e9', cardId: 'card', mapId: 'map', baseRevision: livingSnapshotRevision(before), inputRevision: 'i', viewSession: 'v' };
    await assert.rejects(() => commitLivingMarkdown({ updateNoteRawGuarded: (p, t, o) => f.repo.updateNoteRawGuarded(p, t, o) }, {
      path, expectedContent: before, candidate, base: { revision: 'empty', records: [], suppressed: [], output: { text: '', owner: 'ai', evidence: [] } },
      proposal: { baseRevision: 'empty', operations: [{ kind: 'output', text: 'Findings', evidence: ['e1'] }] },
      context: { at: '2026-11-27T04:00:00+08:00', evidence: [{ id: 'e1', source: 'https://example.com', retrievedAt: 't1' }] },
      signal: new AbortController().signal, isCurrent: () => true,
      inspect: async () => ({ ...candidate, locked: false, aborted: false, dependenciesReady: true, alreadyCommitted: false })
    }));
    assert.equal(f.contents.get(path), before);
  });
  S.integrationTest(`${label}: frontmatter-only transactions that keep body and Living Node metadata are admitted; manual edit works`, async () => {
    const f = await setup(head(flag) + tail);
    const before = f.contents.get(path);
    const body = text => text.replace(/^---\n[\s\S]*?\n---\n/, '');
    const living = text => text.split('\n').filter(line => line.startsWith('living-node-')).join('\n');
    assert.equal(await f.repo.updateNoteGuarded(path, { status: 'error', lastError: 'boom' }), 'written');
    assert.ok(f.contents.get(path).includes('last-error: "boom"'));
    assert.equal(await f.repo.updateNoteGuarded(path, { status: 'completed' }), 'written');
    assert.ok(!f.contents.get(path).includes('last-error'));
    await f.repo.writeAiLocked(path, true);
    assert.equal(await f.repo.updateNoteRawGuarded(path, c => c.replace('custom-key: keep', 'custom-key: other')), 'written');
    const after = f.contents.get(path);
    assert.equal(body(after), body(before));
    assert.equal(living(after), living(before));
    // The user's own edit does not go through the plugin and is never blocked.
    f.contents.set(path, after + '\nmanual note');
    assert.ok(f.contents.get(path).endsWith('manual note'));
  });
}

for (const [name, tail] of Object.entries(corrupt)) {
  S.integrationTest(`writer admission: ${name}: a raw write that disguises a Living Node metadata change is refused, bytes unchanged`, async () => {
    const listHead = head().replace('living-node-outcome: "ok"\n', 'living-node-outcome: "ok"\nliving-node-sources:\n  - "one"\n  - "two"\n');
    const f = await setup(listHead + tail);
    const before = f.contents.get(path);
    // Swapping the continuation lines keeps the sorted line set but changes the list value.
    await assert.rejects(() => f.repo.updateNoteRawGuarded(path, c => c.replace('  - "one"\n  - "two"', '  - "two"\n  - "one"')), message);
    assert.equal(f.contents.get(path), before);
    // An escaped duplicate key hides from a raw-text key match but still parses as a Living Node key.
    await assert.rejects(() => f.repo.updateNoteRawGuarded(path, c => c.replace('custom-key: keep', 'custom-key: keep\n"living\\x2dnode-outcome": "failed"')), message);
    assert.equal(f.contents.get(path), before);
  });
}

S.integrationTest('writer admission: the damaged-markers message exists in every language and never claims a repair', () => {
  for (const id of S.languageIds()) {
    const m = S.i18nSource(id).match(/"error\.living_node_markers_damaged":\s*"([^"]+)"/)?.[1];
    assert.ok(m, id);
    assert.ok(!/(已修復|已修复|was repaired|has been repaired|fixed automatically)/i.test(m), id);
  }
  assert.match(en(), /Living Node markers/);
});
