const assert = require('node:assert/strict');
const S = require('../support.cjs');
const { commitLivingMarkdown, livingSnapshotRevision, readLivingMarkdown } = S.load('experiences/visual-map/living-node-markdown.ts', { obsidian: S.obsidian });
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
  const base = readLivingMarkdown(before);
  const revision = base.revision;
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

S.integrationTest('Living Node: reconstructs persisted knowledge after reload, including corrections and multiline markup', async () => {
  const f = await setup();
  assert.equal(readLivingMarkdown(initial).revision, 'empty');
  const r = request(f, { proposal: { baseRevision: 'empty', operations: [
    { kind: 'output', text: 'Line one\n### heading\n<!-- marker --> & literal &lt;', evidence: ['e1'] },
    { kind: 'append', id: 'r1', subject: 'price', scope: 'daily', granularity: 'day', eventTime: '2026-11-26', claim: '100\n**raw**', evidence: ['e1'] }
  ] } });
  assert.equal(await commitLivingMarkdown(f.repo, r), 'written');
  const base = readLivingMarkdown(f.contents.get(path));
  assert.equal(base.output.text, 'Line one\n### heading\n<!-- marker --> & literal &lt;');
  assert.equal(base.records[0].claim, '100\n**raw**');
  const second = request(f, { base, candidate: { executionId: 'e2' }, proposal: { baseRevision: base.revision, operations: [
    { kind: 'correct', id: 'r1', claim: '105', reason: 'corrected close', evidence: ['e2'] }
  ] }, context: { ...context, evidence: [...context.evidence, { id: 'e2', source: 'https://example.org', retrievedAt: 't2' }] } });
  assert.equal(await commitLivingMarkdown(f.repo, second), 'written');
  const recovered = readLivingMarkdown(f.contents.get(path));
  assert.equal(recovered.records[0].claim, '105');
  assert.equal(recovered.records[0].history[0].claim, '100\n**raw**');
  assert.equal(recovered.records[0].history[0].previousEvidence[0].id, 'e1');
  assert.equal(recovered.records[0].history[0].evidence[0].id, 'e2');
  assert.notEqual(recovered.revision, base.revision);
});

S.integrationTest('Living Node: readback refuses tampered Markdown or ownership instead of silently migrating', async () => {
  const f = await setup();
  assert.equal(await commitLivingMarkdown(f.repo, request(f)), 'written');
  const saved = f.contents.get(path);
  assert.throws(() => readLivingMarkdown(saved.replace('> Current findings', '> Manual changes')), /edited-or-deleted-knowledge/);
  assert.throws(() => readLivingMarkdown(saved.replace('<!-- vam-living-node:end v1 -->', '')), /unknown-ownership/);
});

S.integrationTest('Living Node: source text cannot inject managed-region markers', async () => {
  const f = await setup();
  const source = '<!-- vam-living-node:begin v1 -->';
  const r = request(f, { context: { ...context, evidence: [{ id: 'e1', source, retrievedAt: 't1' }] } });
  assert.equal(await commitLivingMarkdown(f.repo, r), 'written');
  assert.equal(readLivingMarkdown(f.contents.get(path)).output.evidence[0].source, source);
});

const { LivingCoordinator } = S.load('experiences/visual-map/living-node-coordinator.ts');
const { LivingTrial } = S.load('experiences/visual-map/living-node-trial.ts', { obsidian: S.obsidian });
function trialRequest(f, generate, extra = {}) {
  return { ...request(f), generate, stillCurrent: async () => true, ...extra };
}

S.integrationTest('Living Node trial: preview never writes; adoption uses the same guard once without another AI call', async () => {
  const f = await setup();
  const trial = new LivingTrial(new LivingCoordinator());
  let calls = 0;
  const r = trialRequest(f, async () => { calls++; return proposal; });
  assert.equal(await trial.run(r), true);
  assert.equal(trial.state, 'ready');
  assert.equal(trial.result.output.text, 'Current findings');
  assert.equal(f.contents.get(path), initial);
  assert.equal(await trial.adopt(f.repo, r), 'written');
  assert.equal(calls, 1);
  assert.equal(trial.state, 'none');
  assert.equal(await trial.adopt(f.repo, r), 'discarded');
  assert.equal(readLivingMarkdown(f.contents.get(path)).output.text, 'Current findings');
});

S.integrationTest('Living Node trial: stale source, lock or draft invalidation cannot commit preview', async () => {
  const f = await setup();
  const trial = new LivingTrial(new LivingCoordinator());
  const r = trialRequest(f, async () => proposal);
  assert.equal(await trial.run(r), true);
  const oldCheck = r.inspect;
  assert.equal(await trial.adopt(f.repo, { ...r, inspect: async () => ({ ...await oldCheck(), dependenciesReady: false }) }), 'discarded');
  assert.equal(f.contents.get(path), initial);
  assert.equal(await trial.run(r), true);
  trial.invalidate();
  assert.equal(trial.state, 'invalid');
  assert.equal(await trial.adopt(f.repo, r), 'discarded');
  assert.equal(f.contents.get(path), initial);
});

S.integrationTest('Living Node trial: late provider result cannot revive a closed editor', async () => {
  const f = await setup();
  const trial = new LivingTrial(new LivingCoordinator());
  let finish;
  const r = trialRequest(f, () => new Promise(resolve => { finish = resolve; }));
  const pending = trial.run(r);
  trial.close();
  finish(proposal);
  assert.equal(await pending, false);
  assert.equal(trial.state, 'none');
  assert.equal(trial.result, undefined);
  assert.equal(f.contents.get(path), initial);
});

S.integrationTest('Living Node trial: exact configuration-only save permits adoption, unrelated changes do not', async () => {
  const f = await setup();
  const trial = new LivingTrial(new LivingCoordinator());
  const savedContent = initial + '\n## Prompt\n\nResearch this topic.\n';
  let calls = 0;
  const r = trialRequest(f, async () => { calls++; return proposal; }, { savedContent });
  assert.equal(await trial.run(r), true);
  await f.app.vault.process(f.files.get(path), () => savedContent);
  const check = {
    isCurrent: () => true,
    readSavedContent: async () => f.contents.get(path),
    inspect: async () => ({ ...await r.inspect(), baseRevision: livingSnapshotRevision(f.contents.get(path)) })
  };
  assert.equal(await trial.adopt(f.repo, check), 'written');
  assert.equal(calls, 1);
  assert.ok(f.contents.get(path).includes('Research this topic.'));
  const other = await setup();
  const invalid = new LivingTrial(new LivingCoordinator());
  const next = trialRequest(other, async () => proposal, { savedContent });
  assert.equal(await invalid.run(next), true);
  const edited = savedContent + '\nUnrelated manual edit.';
  await other.app.vault.process(other.files.get(path), () => edited);
  assert.equal(await invalid.adopt(other.repo, { ...next, readSavedContent: async () => edited }), 'discarded');
  assert.equal(other.contents.get(path), edited);
});

S.integrationTest('Living Node: ordinary Repository note edits preserve the managed region byte for byte', async () => {
  const f = await setup();
  assert.equal(await commitLivingMarkdown(f.repo, request(f)), 'written');
  const old = f.contents.get(path);
  const knowledge = readLivingMarkdown(old);
  await f.repo.updateNote(path, { prompt: 'New saved instruction', title: 'New title' });
  const updated = f.contents.get(path);
  assert.equal(readLivingMarkdown(updated).revision, knowledge.revision);
  assert.ok(updated.includes('New saved instruction'));
  assert.equal((updated.match(/vam-living-node:begin/g) ?? []).length, 1);
  await f.repo.writeAiCard(path, false);
  assert.equal(readLivingMarkdown(f.contents.get(path)).revision, knowledge.revision);
});
