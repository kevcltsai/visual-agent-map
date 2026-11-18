// Picture-book pipeline data contract (02a): card fields, the root's six book-* settings, the map's `bookPipeline`, the three
// model defaults and the call-budget admission. Notes and maps without any new key read and write exactly as before.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { core, fixture, obsidian } = S;
const model = S.load('core/book-pipeline/model.ts');
const machine = S.load('core/book-pipeline/machine.ts');
const budget = S.load('core/book-pipeline/budget.ts');
const admission = S.load('core/admission.ts');
const Main = S.load('main.ts', { obsidian: { ...obsidian, Notice: class {} } });

const plain = value => JSON.parse(JSON.stringify(value));
const baseMap = extra => ({ version: 1, id: 'm1', title: 'T', nodes: [{ id: 'a', path: 'a.md', parentId: null, x: 0, y: 0, collapsed: false }], viewport: { x: 0, y: 0, zoom: 1 }, ...extra });
const usable = () => plain(machine.newBookPipeline({ runId: 'run-1', order: ['a'], now: '2026-11-16T00:00:00.000Z' }));
const roundTrip = text => core.serializeMap(core.parseMap(text));

async function oneNote(extraFrontmatter = '') {
  const env = fixture('en');
  const note = await S.topicNote(env.repo, 'Chapter');
  if (extraFrontmatter) env.contents.set(note.path, env.contents.get(note.path).replace(/^---\n/, `---\n${extraFrontmatter}\n`));
  return { ...env, note };
}

test('a note without any new key reads without pipeline fields and reading writes nothing', async () => {
  const { repo, note, contents } = await oneNote();
  const before = contents.get(note.path);
  const read = await repo.readNote(note.path);
  for (const key of ['pipelineStage', 'bookRole', 'pipelineIssue', 'pipelineSeam', 'bookSettings']) assert.equal(key in read, false, key);
  assert.equal(contents.get(note.path), before);
});

test('card fields are read; unknown values, blanks and non-strings are absent; the issue is one line of at most 200 characters', async () => {
  const long = 'x'.repeat(260);
  const a = await oneNote(`pipeline-stage: planned\nbook-role: gallery\npipeline-issue: "first\\nsecond"\npipeline-seam: "neighbour changed"`);
  const read = await a.repo.readNote(a.note.path);
  assert.deepEqual([read.pipelineStage, read.bookRole, read.pipelineIssue, read.pipelineSeam], ['planned', 'gallery', 'first second', 'neighbour changed']);
  const bad = await oneNote(`pipeline-stage: done\nbook-role: 7\npipeline-issue: "   "\npipeline-seam: ${long}`);
  const r2 = await bad.repo.readNote(bad.note.path);
  assert.equal('pipelineStage' in r2, false);
  assert.equal('bookRole' in r2, false);
  assert.equal('pipelineIssue' in r2, false);
  assert.equal(r2.pipelineSeam.length, 200);
  const cjk = await oneNote(`pipeline-issue: ${'字'.repeat(300)}`);
  assert.equal((await cjk.repo.readNote(cjk.note.path)).pipelineIssue.length, 200);
});

test('writePipelineFields sets only its keys: other bytes, updated and status stay; null removes; an empty patch writes nothing', async () => {
  const { repo, note, contents } = await oneNote();
  const before = contents.get(note.path);
  await repo.writePipelineFields(note.path, {});
  assert.equal(contents.get(note.path), before);
  await repo.writePipelineFields(note.path, { pipelineStage: 'planned', bookRole: 'intro', pipelineIssue: 'a\nb', pipelineSeam: 'x' });
  const after = contents.get(note.path);
  const strip = text => text.split('\n').filter(line => !/^(pipeline-|book-role)/.test(line)).join('\n');
  assert.equal(strip(after), before, 'every other line and the body are byte-identical');
  const fm = obsidian.parseYaml(after.match(/^---\n([\s\S]*?)\n---/)[1]);
  assert.equal(fm['pipeline-issue'], 'a b');
  assert.equal(fm.updated, obsidian.parseYaml(before.match(/^---\n([\s\S]*?)\n---/)[1]).updated);
  assert.equal(fm.status, 'idea');
  await repo.writePipelineFields(note.path, { pipelineStage: 'checked', pipelineIssue: null, pipelineSeam: null, bookRole: null });
  const read = await repo.readNote(note.path);
  assert.deepEqual([read.pipelineStage, read.bookRole, read.pipelineIssue, read.pipelineSeam], ['checked', undefined, undefined, undefined]);
  await repo.writePipelineFields(note.path, { pipelineStage: 'bogus' });
  assert.equal((await repo.readNote(note.path)).pipelineStage, undefined, 'an invalid stage removes the key; nothing unreadable is written');
});

test('writePipelineFields keeps CRLF notes in CRLF', async () => {
  const { repo, note, contents } = await oneNote();
  contents.set(note.path, contents.get(note.path).replace(/\n/g, '\r\n'));
  await repo.writePipelineFields(note.path, { pipelineStage: 'planned' });
  assert.equal(/[^\r]\n/.test(contents.get(note.path)), false);
  assert.equal((await repo.readNote(note.path)).pipelineStage, 'planned');
});

test('the six book-* settings read and write; blank is absent; nothing else on the note moves', async () => {
  const { repo, note, contents } = await oneNote();
  const before = contents.get(note.path);
  await repo.writeBookSettings(note.path, { reader: 'adults', goal: 'learn', angle: 'a', tone: 'warm', length: '800', style: 'plain' });
  assert.deepEqual(plain((await repo.readNote(note.path)).bookSettings), { reader: 'adults', goal: 'learn', angle: 'a', tone: 'warm', length: '800', style: 'plain' });
  await repo.writeBookSettings(note.path, { reader: null, goal: '  ', angle: undefined, length: '900' });
  assert.deepEqual(plain((await repo.readNote(note.path)).bookSettings), { angle: 'a', tone: 'warm', length: '900', style: 'plain' });
  await repo.writeBookSettings(note.path, { angle: null, tone: null, length: null, style: null });
  assert.equal(contents.get(note.path), before);
  const numeric = await oneNote('book-length: 800');
  assert.equal((await numeric.repo.readNote(numeric.note.path)).bookSettings.length, '800');
});

test('a map without bookPipeline round-trips byte-identical and reads as absent', () => {
  const text = core.serializeMap(baseMap());
  assert.equal(roundTrip(text), text);
  assert.ok(!text.includes('bookPipeline'));
  const parsed = core.parseMap(text);
  assert.equal('bookPipeline' in parsed, false);
  assert.equal(model.readBookPipeline(parsed).kind, 'absent');
});

test('a usable bookPipeline round-trips byte-identical and reads as usable', () => {
  const text = core.serializeMap(baseMap({ aiMode: 'quick', bookPipeline: usable() }));
  assert.equal(roundTrip(text), text);
  const read = model.readBookPipeline(core.parseMap(text));
  assert.equal(read.kind, 'usable');
  assert.equal(read.data.budget.limit, 300);
  assert.equal(read.data.budget.used, 0);
});

test('autoRoles is optional: older data without it round-trips byte-identical and stays usable; with it, it round-trips too', () => {
  const old = core.serializeMap(baseMap({ aiMode: 'quick', bookPipeline: usable() }));
  assert.ok(!old.includes('autoRoles'));
  assert.equal(roundTrip(old), old);
  const withRoles = core.serializeMap(baseMap({ aiMode: 'quick', bookPipeline: { ...usable(), autoRoles: ['a'] } }));
  assert.equal(roundTrip(withRoles), withRoles);
  assert.deepEqual(plain(model.readBookPipeline(core.parseMap(withRoles)).data.autoRoles), ['a']);
});

const corrupt = {
  'v:2': s => { s.v = 2; },
  'v missing': s => { delete s.v; },
  'unknown phase': s => { s.phase = 'warp'; },
  'unknown status': s => { s.status = 'dreaming'; },
  'unknown pauseReason': s => { s.pauseReason = 'boredom'; },
  'order not strings': s => { s.order = [1]; },
  'duplicate order': s => { s.order = ['a', 'a']; },
  'globalPlanned not bool': s => { s.globalPlanned = 'yes'; },
  'attempts.global missing': s => { delete s.attempts.global; },
  'attempt entry short': s => { s.attempts.a = { plan: 1 }; },
  'negative revision': s => { s.revision = -1; },
  'revisions bad': s => { s.revisions.a = 'x'; },
  'autoRoles not strings': s => { s.autoRoles = [1]; },
  'autoRoles not array': s => { s.autoRoles = 'a'; },
  'budget limit 0': s => { s.budget.limit = 0; },
  'budget used fraction': s => { s.budget.used = 1.5; },
  'future field with v:2': s => { s.v = 2; s.futureThing = { deep: [1, { x: 'y' }] }; },
  'not an object': (s, doc) => { doc.bookPipeline = 'oops'; },
  'array': (s, doc) => { doc.bookPipeline = []; },
  'null': (s, doc) => { doc.bookPipeline = null; }
};
for (const [name, change] of Object.entries(corrupt))
  test(`an unreadable bookPipeline (${name}) is unusable and saved back exactly as it was`, () => {
    const state = usable();
    const doc = baseMap({ bookPipeline: state });
    change(state, doc);
    const text = core.serializeMap(doc);
    const parsed = core.parseMap(text);
    const read = model.readBookPipeline(parsed);
    assert.equal(read.kind, 'unusable');
    assert.deepEqual(plain(read.raw), plain(doc.bookPipeline));
    assert.equal(roundTrip(text), text);
  });

test('the four model defaults are sonnet, opus, haiku, haiku; saved ids are kept (old data.json gets the new field only); blanks fall back', () => {
  const fresh = Main.settingsFromSaved(null);
  assert.deepEqual([fresh.bookPlanModel, fresh.bookWriteModel, fresh.bookImageModel, fresh.bookProofModel], ['claude:sonnet', 'claude:opus', 'claude:haiku', 'claude:haiku']);
  const saved = Main.settingsFromSaved({ bookPlanModel: ' claude:opus ', bookWriteModel: '', bookProofModel: 5 });
  assert.deepEqual([saved.bookPlanModel, saved.bookWriteModel, saved.bookImageModel, saved.bookProofModel], ['claude:opus', 'claude:opus', 'claude:haiku', 'claude:haiku']);
  const oldOwner = Main.settingsFromSaved({ bookPlanModel: 'claude:haiku', bookWriteModel: 'claude:sonnet', bookProofModel: 'claude:sonnet' });
  assert.deepEqual([oldOwner.bookPlanModel, oldOwner.bookWriteModel, oldOwner.bookImageModel, oldOwner.bookProofModel], ['claude:haiku', 'claude:sonnet', 'claude:haiku', 'claude:sonnet']);
  const old = Main.settingsFromSaved({ cliModel: 'claude:sonnet' });
  assert.equal(old.cliModel, 'claude:sonnet');
});

// --- Admission gate -------------------------------------------------------------------------------------------------------
const portOf = (used, limit, persisted = []) => {
  const state = { used, limit };
  return { state, persisted, get: () => ({ ...state }), persist: async next => { await Promise.resolve(); persisted.push(next.used); state.used = next.used; state.limit = next.limit; } };
};

test('budget: five parallel reservations with one call left take exactly one; the rest are budget-exhausted', async () => {
  const port = portOf(299, 300);
  const gate = budget.createBudgetAdmission(port);
  const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => gate.reserve()));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const refused = results.filter(r => r.status === 'rejected');
  assert.equal(refused.length, 4);
  assert.ok(refused.every(r => r.reason.outcome === 'budget-exhausted' && admission.isBudgetExhausted(r.reason)));
  assert.deepEqual(port.persisted, [300], 'the reservation was saved before it resolved');
  assert.equal(port.state.used, 300);
});

test('budget: a reservation is saved before the call; a failing save reserves nothing; a raised limit is seen at once', async () => {
  const order = [];
  const port = portOf(0, 1);
  const gate = budget.createBudgetAdmission({ get: port.get, persist: async next => { order.push('saved'); await port.persist(next); } });
  await gate.reserve();
  order.push('call');
  assert.deepEqual(order, ['saved', 'call']);
  await assert.rejects(gate.reserve(), e => admission.isBudgetExhausted(e));
  port.state.limit = 2;
  await gate.reserve();
  assert.equal(port.state.used, 2);
  const failing = createFailing();
  await assert.rejects(failing.gate.reserve(), /disk full/);
  assert.equal(failing.state.used, 0);
  await failing.gate.reserve();
  assert.equal(failing.state.used, 1, 'the queue survives a failed save');
});
function createFailing() {
  const state = { used: 0, limit: 5 };
  let fail = true;
  const gate = budget.createBudgetAdmission({ get: () => ({ ...state }), persist: async next => { if (fail) { fail = false; throw new Error('disk full'); } state.used = next.used; } });
  return { gate, state };
}

test('budget: another map\'s gate is independent', async () => {
  const a = portOf(300, 300), b = portOf(0, 300);
  const gateA = budget.createBudgetAdmission(a), gateB = budget.createBudgetAdmission(b);
  await assert.rejects(gateA.reserve(), e => admission.isBudgetExhausted(e));
  await gateB.reserve();
  assert.equal(b.state.used, 1);
  assert.equal(a.state.used, 300);
});

test('budget: the pipeline port saves through PipelineStore.commit; concurrent commits and reservations never move used back or drop a raised limit', async () => {
  const machine = S.load('core/book-pipeline/machine.ts');
  const saved = [];
  const store = new machine.PipelineStore(machine.newBookPipeline({ runId: 'r', order: ['a'], now: 'n', budgetLimit: 10 }), async state => { await Promise.resolve(); saved.push([state.budget.used, state.budget.limit]); });
  const gate = budget.createBudgetAdmission(budget.createStoreBudgetPort(store));
  const owner = store.commit(data => ({ state: machine.addBudget(data, 5), accepted: true }));
  const calls = Array.from({ length: 6 }, () => gate.reserve());
  const attempts = [store.commit(data => machine.beginStep(data, 'global')), store.commit(data => ({ state: machine.addBudget(data, 1), accepted: true })), store.commit(data => machine.beginStep(data, 'global'))];
  await Promise.all([owner, ...calls, ...attempts]);
  assert.equal(store.state.budget.used, 6); assert.equal(store.state.budget.limit, 16, 'the raised limit survives the reservations');
  const useds = saved.map(entry => entry[0]);
  assert.deepEqual(useds, [...useds].sort((x, y) => x - y), 'saved used never goes down');
  // a reservation computed from an old budget cannot overwrite a newer one: the port keeps the larger used and the latest limit
  const port = budget.createStoreBudgetPort(store);
  await port.persist({ used: 2, limit: 3 });
  assert.deepEqual(plain(store.state.budget), { used: 6, limit: 16 });
  store.dispose();
  await assert.rejects(port.persist({ used: 7, limit: 16 }), /not saved/);
  assert.equal(store.state.budget.used, 6);
});

test('reserveBudget is pure', () => {
  const before = { used: 2, limit: 3 };
  assert.deepEqual(plain(model.reserveBudget(before)), { used: 3, limit: 3 });
  assert.deepEqual(before, { used: 2, limit: 3 });
  assert.equal(model.reserveBudget({ used: 3, limit: 3 }), null);
});
