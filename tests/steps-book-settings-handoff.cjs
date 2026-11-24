// Whole-book settings in the "Create research map" dialog (06): six optional fields, written to the root topic only when filled,
// always as single quoted lines; the first pipeline start fills missing roles (first level intro, the rest body) and keeps existing ones.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support.cjs');
const { until, plain } = S;
const { BookPipelineRuns } = S.load('experiences/visual-map/book-pipeline-run.ts');
const { BOOK_SETTING_FIELDS } = S.load('core/book-pipeline/model.ts');
const { cleanBookSettingsInput, BOOK_SETTING_INPUT_MAX } = S.load('core/book-pipeline/settings.ts');

test('cleanBookSettingsInput drops empty, non-string and over-long input', () => {
  assert.deepEqual(plain(cleanBookSettingsInput(undefined)), {});
  assert.deepEqual(plain(cleanBookSettingsInput({ reader: '   ', goal: 5, angle: null })), {});
  assert.equal(cleanBookSettingsInput({ goal: 'g'.repeat(300) }).goal.length, 200);
  assert.deepEqual(cleanBookSettingsInput({ style: '😀'.repeat(250) }).style, '😀'.repeat(200));
});

test('cleanBookSettingsInput removes control characters (NUL, escape, tab)', () => {
  assert.deepEqual(plain(cleanBookSettingsInput({ reader: 'a\u0000b\u001bc\u007fd\te' })), { reader: 'a b c d e' });
  assert.deepEqual(plain(cleanBookSettingsInput({ goal: '\u0000\u0001' })), {});
});

test('the global plan does not overwrite a role the owner already set', async () => {
  const data = S.fixture('zh-TW');
  const { repo, contents } = data;
  const mapPath = await repo.createMap('Book');
  const doc = await repo.readMap(mapPath);
  const nodes = [];
  for (const title of ['Root', 'A', 'B', 'A1']) nodes.push(await repo.createNote(title, 'm', doc, mapPath, 'workspace', { summary: `s ${title}` }));
  nodes.forEach((n, i) => { n.x = i * 300; n.y = 0; if (i === 1 || i === 2) n.parentId = nodes[0].id; if (i === 3) n.parentId = nodes[1].id; });
  await repo.updateMap(mapPath, d => { d.nodes.push(...nodes); });
  await repo.writePipelineFields(nodes[2].path, { bookRole: 'gallery' });
  let queue = Promise.resolve(), ids = 0;
  const ports = {
    mutate: work => { const next = queue.then(work); queue = next.catch(() => undefined); return next; },
    readMap: p => repo.readMap(p), updateMap: (p, c) => repo.updateMap(p, c),
    readCard: async p => { const n = await repo.readNote(p); return { path: p, title: n.title, summary: n.summary, prompt: n.prompt, detail: n.detail, raw: contents.get(p), settings: n.bookSettings ?? {}, fields: { ...(n.pipelineStage ? { pipelineStage: n.pipelineStage } : {}), ...(n.bookRole ? { bookRole: n.bookRole } : {}) } }; },
    writePipelineFields: (p, patch) => repo.writePipelineFields(p, patch),
    updateNoteGuarded: (p, patch, o) => repo.updateNoteGuarded(p, patch, o),
    updateNoteRawGuarded: (p, t, o) => repo.updateNoteRawGuarded(p, t, o),
    // the whole-book plan proposes a role for every card; a card the owner already gave a role keeps it
    runPlan: async (step, request, run) => {
      await run.admission.reserve();
      if (step.id === 'book-pipeline.global-plan') return { thread: 't', cards: nodes.map(n => ({ id: n.id, role: 'closing' })), materials: [], decisions: {} };
      return { covers: 'c', entry: 'e', handoff: 'h', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'x' }] };
    },
    runProofread: async () => { throw new Error('unused'); }, author: async () => { throw new Error('unused'); },
    probeImage: async () => ({ ok: true }), backupNote: async p => ({ ok: true, path: `${p}.bak` }),
    blocked: () => false, config: () => ({ planModel: 'm1', authorModel: 'm2', imageModel: 'm4', proofModel: 'm3', reasoning: 'low', language: 'zh-TW' }),
    now: () => '2026-11-17T00:00:00.000Z', newId: () => `run-${++ids}`, log: () => {}
  };
  const runs = new BookPipelineRuns(ports);
  await runs.start(mapPath);
  for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r));
  const roles = await Promise.all(nodes.map(async n => (await repo.readNote(n.path)).bookRole));
  // the plan may replace the defaults this start filled, but never the owner's value (B)
  assert.deepEqual(roles, ['closing', 'closing', 'gallery', 'closing']);
});

test('role defaults before the plan: root and first level intro, deeper body, existing value kept (plan returns the defaults)', async () => {
  const data = S.fixture('zh-TW');
  const { repo, contents } = data;
  const mapPath = await repo.createMap('Book2');
  const doc = await repo.readMap(mapPath);
  const nodes = [];
  for (const title of ['Root', 'A', 'B', 'A1']) nodes.push(await repo.createNote(title, 'm', doc, mapPath, 'workspace', { summary: `s ${title}` }));
  nodes.forEach((n, i) => { n.x = i * 300; n.y = 0; if (i === 1 || i === 2) n.parentId = nodes[0].id; if (i === 3) n.parentId = nodes[1].id; });
  await repo.updateMap(mapPath, d => { d.nodes.push(...nodes); });
  await repo.writePipelineFields(nodes[2].path, { bookRole: 'closing' });
  let queue = Promise.resolve(), ids = 0, planned;
  const ports = {
    mutate: work => { const next = queue.then(work); queue = next.catch(() => undefined); return next; },
    readMap: p => repo.readMap(p), updateMap: (p, c) => repo.updateMap(p, c),
    readCard: async p => { const n = await repo.readNote(p); return { path: p, title: n.title, summary: n.summary, prompt: n.prompt, detail: n.detail, raw: contents.get(p), settings: {}, fields: { ...(n.pipelineStage ? { pipelineStage: n.pipelineStage } : {}), ...(n.bookRole ? { bookRole: n.bookRole } : {}) } }; },
    writePipelineFields: (p, patch) => repo.writePipelineFields(p, patch),
    updateNoteGuarded: (p, patch, o) => repo.updateNoteGuarded(p, patch, o),
    updateNoteRawGuarded: (p, t, o) => repo.updateNoteRawGuarded(p, t, o),
    runPlan: async (step, request, run) => { await run.admission.reserve(); throw new Error('plan fails'); },
    runProofread: async () => { throw new Error('unused'); }, author: async () => { throw new Error('unused'); },
    probeImage: async () => ({ ok: true }), backupNote: async p => ({ ok: true, path: `${p}.bak` }),
    blocked: () => false, config: () => ({ planModel: 'm1', authorModel: 'm2', imageModel: 'm4', proofModel: 'm3', reasoning: 'low', language: 'zh-TW' }),
    now: () => '2026-11-17T00:00:00.000Z', newId: () => `run-${++ids}`, log: () => {}
  };
  const runs = new BookPipelineRuns(ports);
  await runs.start(mapPath);
  for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r));
  const roles = await Promise.all(nodes.map(async n => (await repo.readNote(n.path)).bookRole));
  assert.deepEqual(roles, ['intro', 'intro', 'closing', 'body']);
  await runs.stop?.(mapPath);
});

test('i18n: all three languages carry the new keys, no placeholder drift', () => {
  const keys = ['book_settings', 'book_settings_hint', 'book_reader', 'book_goal', 'book_angle', 'book_tone', 'book_length', 'book_style', 'book_setting_empty', 'book_setting_limit'];
  for (const lang of ['zh-TW', 'zh-CN', 'en']) {
    const text = fs.readFileSync(path.join(S.root, `i18n/${lang}.ts`), 'utf8');
    for (const k of keys) assert.match(text, new RegExp(`"coffee\\.${k}":\\s*["']`), `${lang} ${k}`);
    assert.match(text, /"coffee\.book_setting_limit":\s*["'].*\{0\}.*\{1\}/);
  }
  assert.ok(BOOK_SETTING_FIELDS.length === 6);
});
