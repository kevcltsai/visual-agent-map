const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { commitLivingMarkdown, livingSnapshotRevision } = S.load('experiences/visual-map/living-node-markdown.ts', { obsidian: S.obsidian });
const { applyLivingChanges } = S.load('experiences/visual-map/living-node-changes.ts');
const initial = '---\nagent-map-id: map\ntopic-id: card\nai-card: true\ncustom-key: keep\n---\n# Existing title\n\n## Detail\n\nManual notes, never replace.\n';
const empty = () => ({ revision: 'empty', records: [], suppressed: [], output: { text: '', owner: 'ai', evidence: [] } });
const context = { at: '2026-11-27T04:00:00+08:00', evidence: [{ id: 'e1', source: 'https://example.com', retrievedAt: 't1' }] };
const proposal = { baseRevision: 'empty', operations: [{ kind: 'output', text: 'Current findings', evidence: ['e1'] }] };
const path = 'card.md';
async function setup() {
  const f = S.fixture();
  await f.app.vault.create(path, initial);
  return f;
}
function request(f, extra = {}) {
  const expectedContent = extra.expectedContent ?? f.contents.get(path);
  const candidate = { executionId: 'e1', cardId: 'card', mapId: 'map', baseRevision: livingSnapshotRevision(expectedContent), inputRevision: 'i1', viewSession: 'v1', ...extra.candidate };
  return { path, expectedContent, base: empty(), proposal, context, signal: new AbortController().signal, isCurrent: () => true,
    ...extra, candidate, inspect: extra.inspect ?? (async () => ({ ...candidate, locked: false, aborted: false, dependenciesReady: true, alreadyCommitted: false })) };
}

S.integrationTest('Living Node: first commit uses real Repository guard and preserves original note body and custom metadata', async () => {
  const f = await setup();
  assert.equal(await commitLivingMarkdown(f.repo, request(f)), 'written');
  const actual = f.contents.get(path);
  assert.ok(actual.includes('custom-key: keep'));
  assert.ok(actual.includes('# Existing title\n\n## Detail\n\nManual notes, never replace.'));
  assert.ok(actual.includes('> Current findings'));
  assert.ok(actual.includes('living-node-last-execution: "e1"'));
  assert.ok(actual.includes('living-node-last-successful-check:'));
  assert.equal((actual.match(/vam-living-node:begin/g) ?? []).length, 1);
});

S.integrationTest('Living Node: repeat no-change writes diagnostics only and does not advance content change time', async () => {
  const f = await setup();
  const first = request(f);
  assert.equal(await commitLivingMarkdown(f.repo, first), 'written');
  const before = f.contents.get(path);
  const result = applyLivingChanges(first.base, first.proposal, first.context);
  const revision = before.match(/living-node-region-hash: "([a-f0-9]+)"/)[1];
  const base = { ...first.base, records: result.records, output: result.output, revision };
  const second = request(f, { base, proposal: { baseRevision: revision, operations: [] }, candidate: { executionId: 'e2' }, context: { ...context, at: 't2' } });
  assert.equal(await commitLivingMarkdown(f.repo, second), 'written');
  const after = f.contents.get(path);
  assert.equal(after.slice(after.indexOf('# Existing title')), before.slice(before.indexOf('# Existing title')));
  assert.equal(after.match(/living-node-last-content-change: .+/)[0], before.match(/living-node-last-content-change: .+/)[0]);
  assert.ok(after.includes('living-node-last-successful-check: "t2"'));
});

S.integrationTest('Living Node: external edit during inspect is preserved by the real compare-and-write guard', async () => {
  const f = await setup();
  const r = request(f);
  const inspect = r.inspect;
  r.inspect = async () => {
    await f.app.vault.process(f.files.get(path), () => initial + '\nOwner typed this.');
    return inspect();
  };
  assert.equal(await commitLivingMarkdown(f.repo, r), 'discarded');
  assert.equal(f.contents.get(path), initial + '\nOwner typed this.');
});

S.integrationTest('Living Node: cancelled or stale candidate never commits and replay does not duplicate knowledge', async () => {
  const f = await setup();
  const controller = new AbortController();
  const r = request(f, { signal: controller.signal });
  const inspect = r.inspect;
  r.inspect = async () => { controller.abort(); return inspect(); };
  assert.equal(await commitLivingMarkdown(f.repo, r), 'discarded');
  assert.equal(f.contents.get(path), initial);
  assert.equal(await commitLivingMarkdown(f.repo, request(f)), 'written');
  const before = f.contents.get(path);
  assert.equal(await commitLivingMarkdown(f.repo, request(f)), 'discarded');
  assert.equal(f.contents.get(path), before);
});

S.integrationTest('Living Node: manually edited or removed owned region fails closed without overwriting', async () => {
  const f = await setup();
  assert.equal(await commitLivingMarkdown(f.repo, request(f)), 'written');
  const edited = f.contents.get(path).replace('> Current findings', '> Owner revised it');
  await f.app.vault.process(f.files.get(path), () => edited);
  await assert.rejects(() => commitLivingMarkdown(f.repo, request(f, { candidate: { executionId: 'e2' } })), /edited-or-deleted-knowledge/);
  assert.equal(f.contents.get(path), edited);
});

S.integrationTest('Living Node: an empty first proposal is not evidence of a successful no-match', async () => {
  const f = await setup();
  await assert.rejects(() => commitLivingMarkdown(f.repo, request(f, { proposal: { baseRevision: 'empty', operations: [] } })), /missing-formal-result/);
  assert.equal(f.contents.get(path), initial);
});
