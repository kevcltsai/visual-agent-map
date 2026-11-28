// V3.3 G08 / P5.5: what a share file carries of a Living Node and of a cross-map reference (P4.3).
// A Living Node's draft or trial text never reaches the share artifact; a reference reaches it as a title only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const support = require('./support.cjs');
const { load } = support;

const living = load('experiences/visual-map/living-node-markdown.ts', { obsidian: support.obsidian });
const { LivingTrial } = load('experiences/visual-map/living-node-trial.ts', { obsidian: support.obsidian });
class FileSystemAdapter { getBasePath() { return '/srv/vaults/Main Vault'; } }
const sharing = load('experiences/sharing/share-exporter.ts', { obsidian: { ...support.obsidian, FileSystemAdapter, Component: class { load() {} unload() {} addChild() {} removeChild() {} } } });

const COMMITTED = 'COMMITTED-CLAIM-ONE';
const TRIAL = 'TRIAL-PREVIEW-SECRET-TEXT';
const OPTIONS = { includeDetail: true, includeImages: false };

function exporter(map, notes, extra = {}) {
  return new sharing.ShareExporter({ vault: { adapter: new FileSystemAdapter(), getName: () => 'V' } }, { map, notes, mapPath: 'Folder/Map.md', ...extra }, { vamVersion: '1', language: 'en' });
}
const baseMap = (extra = {}) => ({ id: 'map-1', title: 'Map', outputLanguage: 'en', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'a', path: 'Folder/A.md', parentId: null, x: 0, y: 0, collapsed: false }], ...extra });

test('a Living Node trial preview and an unsaved draft stay out of the share payload and the share file; only the committed text is shared', async () => {
  const f = support.fixture();
  const initial = '---\nagent-map-id: map\ntopic-id: map\nnode-id: card\nai-card: true\n---\n# Title\n\n## Detail\n\nBody.\n';
  await f.app.vault.create('card.md', initial);
  const base = { revision: 'empty', records: [], suppressed: [], output: { text: '', owner: 'ai', evidence: [] } };
  const candidate = { executionId: 'e1', cardId: 'card', mapId: 'map', baseRevision: living.livingSnapshotRevision(initial), inputRevision: 'i1', viewSession: 'v1' };
  const context = { at: '2026-11-28T04:00:00+08:00', evidence: [] };
  const outcome = await living.commitLivingMarkdown(f.repo, { path: 'card.md', expectedContent: initial, base, baseGeneration: 0, proposal: { baseRevision: 'empty', operations: [{ kind: 'output', text: COMMITTED, evidence: [] }] },
    context, signal: new AbortController().signal, isCurrent: () => true, candidate,
    inspect: async () => ({ ...candidate, locked: false, aborted: false, dependenciesReady: true, alreadyCommitted: false }) });
  assert.equal(outcome, 'written');
  const committedFile = f.contents.get('card.md');

  // A trial preview: the model's answer is held in the editor only (positive control: the trial really holds it).
  const lease = { signal: new AbortController().signal, current: () => true, release() {}, stop() {} };
  const trial = new LivingTrial({ acquire: () => lease });
  const trialBase = living.readLivingMarkdown(committedFile);
  const trialCandidate = { ...candidate, executionId: 'e2', baseRevision: living.livingSnapshotRevision(committedFile) };
  const ran = await trial.run({ candidate: trialCandidate, path: 'card.md', expectedContent: committedFile, base: trialBase, context,
    generate: async () => ({ baseRevision: trialBase.revision, operations: [{ kind: 'output', text: TRIAL, evidence: [] }] }), stillCurrent: async () => true });
  assert.equal(ran, true, trial.failureCode);
  assert.equal(trial.state, 'ready');
  assert.ok(trial.result.output.text.includes(TRIAL), 'the preview holds the trial text');
  assert.equal(f.contents.get('card.md'), committedFile, 'a trial writes nothing to the note');

  const note = await f.repo.readNote('card.md');
  const run = exporter(baseMap(), new Map([['a', note]])).assemble(OPTIONS);
  assert.deepEqual(support.plain(run.leakCategories), []);
  const everything = JSON.stringify(run.payload) + run.html;
  assert.ok(everything.includes(COMMITTED), 'the committed text is shared');
  assert.equal(everything.includes('TRIAL-PREVIEW'), false, 'no trial or draft text in the share artifact');

  // Adopting the preview is the only way it reaches the file, and then it is committed text like any other.
  trial.close();
});

test('a cross-map reference reaches the share payload and file as a title only: no original body, path, map id or card id', () => {
  const ref = { id: 'ref-1', mapId: 'zz-other-map', nodeId: 'zz-node-9', parentId: 'a', x: 300, y: 20, pathHint: 'Mind Maps/ZZ-Private/Map.md' };
  const map = baseMap({ knowledgeRefs: [ref] });
  const notes = new Map([['a', { title: 'Host card', summary: 'host summary', status: 'idea', model: '' }]]);
  const run = exporter(map, notes, { refTitles: new Map([['ref-1', 'REF-TITLE-ONLY']]) }).assemble({ includeDetail: true, includeImages: false });
  assert.deepEqual(support.plain(run.leakCategories), []);
  assert.equal(run.payload.refs.length, 1);
  assert.equal(run.payload.refs[0].title, 'REF-TITLE-ONLY');
  assert.deepEqual(Object.keys(run.payload.refs[0]).sort(), ['id', 'parentId', 'title', 'x', 'y']);
  const everything = JSON.stringify(run.payload) + run.html;
  assert.ok(everything.includes('REF-TITLE-ONLY'));
  for (const leak of ['zz-other-map', 'zz-node-9', 'ZZ-Private', 'Mind Maps', 'pathHint', 'knowledgeRefs']) assert.equal(everything.includes(leak), false, leak);
});
