// Living Node V1 A33: a card whose history grew keeps updating; the provider sees a bounded recent-first projection.
const assert = require('node:assert/strict');
const S = require('../support.cjs');
const { commitLivingMarkdown, livingGeneration, livingSnapshotRevision, readLivingMarkdown } = S.load('experiences/visual-map/living-node-markdown.ts', { obsidian: S.obsidian });
const { generateLivingProposal } = S.load('experiences/visual-map/living-node-provider.ts', { obsidian: S.obsidian });
const { applyLivingChanges } = S.load('experiences/visual-map/living-node-changes.ts', { obsidian: S.obsidian });
const initial = '---\nagent-map-id: map\ntopic-id: map\nnode-id: card\nai-card: true\n---\n# Card\n';
const path = 'card.md';
const day = n => new Date(Date.UTC(2020, 0, 1 + n)).toISOString().slice(0, 10);
const append = n => ({ kind: 'append', id: 'r' + n, subject: 'subject ' + n, scope: 'scope', granularity: 'day', eventTime: day(n), claim: 'claim ' + n + ' ' + 'x'.repeat(300), evidence: ['e1'] });
const context = { at: '2026-11-27T04:00:00+08:00', evidence: [{ id: 'e1', source: 'https://example.com', retrievedAt: 't1' }] };

async function commit(f, base, operations, expected) {
  const expectedContent = expected ?? f.contents.get(path);
  const candidate = { executionId: 'x' + Math.random(), cardId: 'card', mapId: 'map', baseRevision: livingSnapshotRevision(expectedContent), inputRevision: 'i', viewSession: 'v' };
  return commitLivingMarkdown(f.repo, { path, expectedContent, candidate, base, baseGeneration: livingGeneration(expectedContent), proposal: { baseRevision: base.revision, operations }, context, signal: new AbortController().signal, isCurrent: () => true,
    inspect: async () => ({ ...candidate, locked: false, aborted: false, dependenciesReady: true, alreadyCommitted: false }) });
}
async function bigCard(count) {
  const f = S.fixture();
  await f.app.vault.create(path, initial);
  for (let from = 0; from < count; from += 100) {
    const base = readLivingMarkdown(f.contents.get(path));
    const ops = Array.from({ length: Math.min(100, count - from) }, (_, i) => append(from + i));
    assert.equal(await commit(f, base, ops), 'written');
  }
  return f;
}
// One formal round: the fake transport answers with `operations`; the production validator runs against the full base.
async function round(f, operations, echoed) {
  const base = readLivingMarkdown(f.contents.get(path));
  const sent = [];
  const calls = { run: async (prepared, options, finish) => {
    sent.push(prepared.prompt);
    return finish(JSON.stringify({ baseRevision: echoed ?? base.revision, requiresWeb: false, operations }), { signal: options.signal, parsed() {} });
  } };
  const generated = await generateLivingProposal(calls, { model: 'm', reasoning: 'auto', prompt: 'track', language: 'en', base, context: '{}', evidence: context.evidence, mapPath: 'map.md' }, new AbortController().signal);
  return { sent, base, generated };
}

S.integrationTest('Living Node A33: a card over 100k chars of records makes one bounded provider call, commits, and keeps every record', async () => {
  const f = await bigCard(320);
  const base = readLivingMarkdown(f.contents.get(path));
  assert.equal(base.records.length, 320);
  assert.ok(JSON.stringify(base).length > 100_000);
  const { sent, generated } = await round(f, [append(1000)]);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].length <= 100_000);
  assert.ok(sent[0].includes('"id":"r319"') && !sent[0].includes('"id":"r0"'));
  assert.match(sent[0], /"omitted":\{"count":\d+,"oldest":"20\d\d-\d\d-\d\d","newest":"20\d\d-\d\d-\d\d"\}/);
  assert.equal(await commit(f, base, generated.proposal.operations), 'written');
  const after = readLivingMarkdown(f.contents.get(path));
  assert.equal(after.records.length, 321);
  assert.deepEqual(S.plain(after.records.slice(0, 320).map(r => r.id)), S.plain(base.records.map(r => r.id)));
});

S.integrationTest('Living Node A33: an unknown record is refused, a shown one is allowed, and a re-reported old event is a no-op', async () => {
  const f = await bigCard(320);
  const base = readLivingMarkdown(f.contents.get(path));
  const { sent } = await round(f, []);
  assert.ok(!sent[0].includes('"id":"r0"'));
  const ghost = { baseRevision: base.revision, operations: [{ kind: 'invalidate', id: 'nope', reason: 'why', evidence: ['e1'] }] };
  assert.throws(() => applyLivingChanges(base, ghost, context));
  await assert.rejects(() => round(f, [{ kind: 'invalidate', id: 'nope', reason: 'why', evidence: ['e1'] }]), /unknown|invalid|missing/i);
  const shown = await round(f, [{ kind: 'supplement', id: 'r319', evidence: ['e1'] }]);
  assert.equal(shown.generated.proposal.operations.length, 1);
  const again = applyLivingChanges(base, { baseRevision: base.revision, operations: [append(0)] }, context);
  assert.deepEqual(S.plain(again.records.map(r => r.id)), S.plain(base.records.map(r => r.id)));
  assert.equal(again.records.length, 320);
});

S.integrationTest('Living Node A33/A43: every non-append op on an omitted record (supplement included) is refused and counted; the rest of the round still commits', async () => {
  const f = await bigCard(320);
  const base = readLivingMarkdown(f.contents.get(path));
  const supp = await round(f, [{ kind: 'supplement', id: 'r0', evidence: ['e1'] }]);
  assert.equal(supp.generated.droppedOperations, 1);
  assert.equal(supp.generated.proposal.operations.length, 0);
  const mixed = await round(f, [{ kind: 'correct', id: 'r0', claim: 'rewritten', reason: 'why', evidence: ['e1'] }, { kind: 'dispute', id: 'r1', claim: 'c', reason: 'why', evidence: ['e1'] },
    { kind: 'invalidate', id: 'r2', reason: 'why', evidence: ['e1'] }, { kind: 'supplement', id: 'r3', evidence: ['e1'] }, append(1000)]);
  assert.equal(mixed.generated.droppedOperations, 4);
  assert.deepEqual(S.plain(mixed.generated.proposal.operations.map(o => o.kind)), ['append']);
  assert.equal(await commit(f, base, mixed.generated.proposal.operations), 'written');
  assert.equal(readLivingMarkdown(f.contents.get(path)).records.length, 321);
  // Safely omitted (above, counted) is separate from rejected: an id the card never had rejects the whole proposal.
  await assert.rejects(() => round(f, [{ kind: 'supplement', id: 'r0', evidence: ['e1'] }, { kind: 'supplement', id: 'ghost', evidence: ['e1'] }]), /unknown-record/);
});

S.integrationTest('Living Node A33: a record with no parseable time is ranked last; the omitted boundary appears only when omitting', async () => {
  const f = await bigCard(320);
  const base = readLivingMarkdown(f.contents.get(path));
  await commit(f, base, [{ ...append(5000), id: 'undated', eventTime: null }]);
  const { sent } = await round(f, []);
  assert.ok(!sent[0].includes('"id":"undated"'), 'untimed records come after every timed record that fits');
  assert.match(sent[0], /"omitted":\{"count":\d+,"oldest":"20\d\d-\d\d-\d\d"/);
  const small = await bigCard(3);
  await commit(small, readLivingMarkdown(small.contents.get(path)), [{ ...append(5000), id: 'undated', eventTime: null }]);
  const whole = (await round(small, [])).sent[0];
  assert.ok(whole.includes('"id":"undated"') && !whole.includes('"omitted"'));
});

const memBase = (count, mutate = () => ({})) => ({ revision: 'rev', suppressed: [], output: { text: '', owner: 'ai', evidence: [] },
  records: Array.from({ length: count }, (_, n) => ({ id: 'r' + n, subject: 's' + n, scope: 'sc', granularity: 'day', eventTime: day(n) + 'T00:00:00.000Z', claim: 'c' + n + ' ' + 'x'.repeat(300), evidence: [], validity: 'active', owner: 'ai', history: [], ...mutate(n) })) });
const sendOnce = async base => {
  const sent = [];
  const calls = { run: async (prepared, options, finish) => { sent.push(prepared.prompt); return finish(JSON.stringify({ baseRevision: base.revision, requiresWeb: false, operations: [] }), { signal: options.signal, parsed() {} }); } };
  await generateLivingProposal(calls, { model: 'm', reasoning: 'auto', prompt: 'track', language: 'en', base, context: '{}', evidence: [], mapPath: 'map.md' }, new AbortController().signal);
  return sent;
};

S.integrationTest('Living Node A33: the projected prompt never exceeds 100,000 chars however little room is left', async () => {
  for (let pad = 0; pad < 450; pad++) {
    const base = memBase(330, n => (n === 329 ? { claim: 'x'.repeat(300 + pad) } : {}));
    const sent = await sendOnce(base);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].length <= 100_000, 'pad ' + pad + ' length ' + sent[0].length);
  }
});

S.integrationTest('Living Node A33/A43: projection order is timed newest first, then untimed last; ties break by record id', async () => {
  const base = memBase(330, n => (n % 3 === 0 ? { eventTime: null } : {}));
  const shown = [...(await sendOnce(base))[0].matchAll(/"id":"r(\d+)"/g)].map(m => Number(m[1]));
  const untimed = Array.from({ length: 330 }, (_, n) => n).filter(n => n % 3 === 0);
  const timed = Array.from({ length: 330 }, (_, n) => n).filter(n => n % 3 !== 0);
  const timedShown = shown.filter(n => n % 3 !== 0);
  assert.ok(timedShown.length > 0 && timedShown.length < timed.length, 'budget omits some timed records');
  assert.ok(!shown.some(n => n % 3 === 0), 'no untimed record is shown while a timed one is omitted');
  const cutoff = Math.min(...timedShown);
  assert.ok(timed.filter(n => n >= cutoff).every(n => shown.includes(n)), 'timed shown form a newest suffix');
  assert.equal(untimed.length, 110);
  // Same event time: the lower id ranks first, whatever the insertion order.
  const tie = memBase(330, () => ({ eventTime: '2020-01-01T00:00:00.000Z' }));
  tie.records.reverse();
  const tied = [...(await sendOnce(tie))[0].matchAll(/"id":"r(\d+)"/g)].map(m => Number(m[1]));
  const lowest = Array.from({ length: 330 }, (_, n) => 'r' + n).sort().slice(0, tied.length).map(id => Number(id.slice(1))).sort((a, b) => a - b);
  assert.deepEqual([...tied].sort((a, b) => a - b), lowest);
});

S.integrationTest('Living Node A33: a wrong echoed baseRevision (a document hash) no longer fails the round, while a real concurrent edit is still refused', async () => {
  const f = await bigCard(3);
  const base = readLivingMarkdown(f.contents.get(path));
  const hash = 'a'.repeat(64);
  const { generated } = await round(f, [append(1000)], hash);
  assert.equal(generated.proposal.baseRevision, base.revision);
  const stale = f.contents.get(path);
  f.contents.set(path, stale + '\nOwner edit\n');
  const outcome = await commit(f, base, generated.proposal.operations, stale).catch(error => error.message);
  assert.notEqual(outcome, 'written');
  assert.ok(!f.contents.get(path).includes('r1000'));
});

S.integrationTest('A39 suppression v2: deleted-observation holds are never sent to the model; suppressed appends are dropped and counted', async () => {
  const { livingSuppressionV2, livingSuppressionV2Entry } = S.load('experiences/visual-map/living-node-changes.ts', { obsidian: S.obsidian });
  const gone = { id: 'gone', subject: 'stock', scope: 'price', granularity: 'day', eventTime: '2026-11-26', claim: 'SECRET-DELETED-TEXT', evidence: [], validity: 'active', owner: 'ai', history: [] };
  const base = { ...memBase(3), suppressed: ['legacy-only-id', livingSuppressionV2Entry(livingSuppressionV2(gone))] };
  for (const size of [3, 330]) {
    const b = size === 3 ? base : { ...memBase(330), suppressed: base.suppressed };
    const sent = (await sendOnce(b))[0];
    assert.ok(!/suppress|@v2|@event|legacy-only-id|SECRET-DELETED-TEXT/i.test(sent.replace(/Preserve|Deleted observations are held back locally[^.]*\./g, '')), 'size ' + size);
  }
  const alias = { kind: 'append', id: 'again', subject: 'Stock', scope: 'price', granularity: 'daily', eventTime: '2026-11-26T08:00:00+08:00', claim: 'reworded', evidence: ['e1'] };
  const fresh = { ...alias, id: 'fresh', eventTime: '2026-11-27' };
  const calls = { run: async (prepared, options, finish) => finish(JSON.stringify({ baseRevision: base.revision, requiresWeb: false, operations: [alias, fresh] }), { signal: options.signal, parsed() {} }) };
  const out = await generateLivingProposal(calls, { model: 'm', reasoning: 'auto', prompt: 'track', language: 'en', base, context: '{}', evidence: [{ id: 'e1', source: 'https://example.com', retrievedAt: 't' }], mapPath: 'map.md' }, new AbortController().signal);
  assert.equal(out.suppressedDropped, 1);
  assert.deepEqual(S.plain(out.proposal.operations.map(o => o.id)), ['fresh']);
});

S.integrationTest('T06: an AI output op blocked by a user-edited AI latest is dropped and disclosed; the other operations still run', async () => {
  const base = { ...memBase(3), output: { text: 'manual', owner: 'user', evidence: [] }, aiLatest: { text: 'edited', owner: 'user', at: 't0', evidence: [] } };
  const operations = [{ kind: 'output', text: 'AI text', evidence: ['e1'] }, { kind: 'append', id: 'fresh', subject: 'a', scope: 'b', granularity: 'day', eventTime: '2026-11-27', claim: 'c', evidence: ['e1'] }];
  const calls = { run: async (prepared, options, finish) => finish(JSON.stringify({ baseRevision: base.revision, requiresWeb: false, operations }), { signal: options.signal, parsed() {} }) };
  const out = await generateLivingProposal(calls, { model: 'm', reasoning: 'auto', prompt: 'track', language: 'en', base, context: '{}', evidence: [{ id: 'e1', source: 'https://example.com', retrievedAt: 't' }], mapPath: 'map.md' }, new AbortController().signal);
  assert.equal(out.aiLatestDropped, 'ai-latest-user-edited');
  assert.equal(out.proposal.operations.length, 2);
});

// ---- T05: exact retrieval and one budget (A07, A43) ----
const { parseLivingSelectors, resolveLivingSection, projectLivingRecords } = S.load('experiences/visual-map/living-node-retrieval.ts', { obsidian: S.obsidian });
const { LivingCoordinator } = S.load('experiences/visual-map/living-node-coordinator.ts');
const { runLivingRound, saveLivingConfig, prepareLivingTrial, setLivingIdentityStore: set } = S.load('experiences/visual-map/living-node-runtime.ts', { obsidian: S.obsidian });

S.test('A43 grammar: YYYY, YYYY-MM, YYYY-MM-DD, a day range, Qn YYYY and known record ids are the only selectors', () => {
  const range = prompt => S.plain(parseLivingSelectors(prompt, ['r5', 'evt:9']).ranges.map(r => [r.start, r.end]));
  assert.deepEqual(range('look at 2024'), [['2024-01-01', '2024-12-31']]);
  assert.deepEqual(range('look at 2024-02'), [['2024-02-01', '2024-02-29']]);
  assert.deepEqual(range('on 2024-03-05.'), [['2024-03-05', '2024-03-05']]);
  assert.deepEqual(range('2024-03-05..2024-03-09 only'), [['2024-03-05', '2024-03-09']]);
  assert.deepEqual(range('Q2 2024 and q4 2023'), [['2024-04-01', '2024-06-30'], ['2023-10-01', '2023-12-31']]);
  assert.deepEqual(range('2023-12-30..2024-01-02'), [['2023-12-30', '2024-01-02']]);
  assert.deepEqual(range('Q5 2024 Q0 2023'), [['2024-01-01', '2024-12-31'], ['2023-01-01', '2023-12-31']], 'an impossible quarter is plain text; the bare year after it still reads as a year');
  // Not selectors: impossible dates, a reversed range, digits inside words, quarters 0 and 5, plain numbers.
  for (const text of ['2024-13', '2024-02-30', '2024-03-09..2024-03-05', 'v12024', 'id2024-03', 'price 12345', 'build 2024x'])
    assert.deepEqual(range(text), [], text);
  // D2-6b: everyday range wording reads as the same day range; "and" alone still names two days.
  for (const text of ['between 2020-03-01 and 2020-03-10', 'Between 2020-03-01 AND 2020-03-10', '2020-03-01 到 2020-03-10', '從 2020-03-01至2020-03-10', '2020-03-01–2020-03-10', '2020-03-01 — 2020-03-10', '2020-03-01~2020-03-10', '2020-03-01～2020-03-10'])
    assert.deepEqual(range(text), [['2020-03-01', '2020-03-10']], text);
  assert.deepEqual(range('compare 2020-03-01 and 2020-03-10'), [['2020-03-01', '2020-03-01'], ['2020-03-10', '2020-03-10']]);
  // Not loosened: a reversed or impossible new-wording range is no selector, and an incomplete end date keeps the old reading.
  for (const text of ['between 2020-03-10 and 2020-03-01', '2020-03-10 到 2020-03-01', '2020-03-10–2020-03-01', '2020-02-30~2020-03-10'])
    assert.deepEqual(range(text), [], text);
  assert.deepEqual(range('2020-03 到 2020-03-10'), [['2020-03-01', '2020-03-31'], ['2020-03-10', '2020-03-10']]);
  assert.deepEqual(S.plain(parseLivingSelectors('compare r5 with evt:9, not r6 or r50.', ['r5', 'evt:9']).ids), ['r5', 'evt:9']);
  assert.deepEqual(S.plain(parseLivingSelectors('Use "Notes > Plan > Risks" and 「Notes > Plan」 but not "no path" or "a > "', []).paths), [['Notes', 'Plan', 'Risks'], ['Notes', 'Plan']]);
});

S.test('A43 heading path: it must resolve to exactly one section; duplicate, missing and the shared Observation heading fail closed', () => {
  const note = '# Note\nintro\n## A\nalpha\n### X\nx-one\n```\n### X\nnot a heading\n```\n## B\nbeta\n### X\nx-two\n### Observation\nshared\n## C\n### Observation\nshared too\n';
  assert.equal(resolveLivingSection(note, ['A', 'X']), '### X\nx-one\n```\n### X\nnot a heading\n```');
  assert.equal(resolveLivingSection(note, ['Note', 'B', 'X']), '### X\nx-two\n### Observation\nshared'.split('\n### Observation')[0]);
  assert.match(resolveLivingSection(note, ['B']), /^## B\nbeta[\s\S]*### X\nx-two[\s\S]*### Observation/);
  for (const path of [['X'], ['Z'], ['B', 'Z'], ['B', 'Observation'], ['C', 'Observation'], ['Observation'], []])
    assert.throws(() => resolveLivingSection(note, path), /^Error: living-section-ambiguous: /, path.join(' > '));
  assert.throws(() => resolveLivingSection(note, ['B', 'Observation']), /living-section-ambiguous: B > Observation/);
});

S.test('A43 projection: range records first (oldest to newest), then timed newest first, untimed last; required overflow throws with the range', () => {
  const rec = (id, eventTime) => ({ id, subject: 's', scope: 'sc', granularity: 'day', eventTime, claim: 'c'.repeat(100), evidence: [], validity: 'active', owner: 'ai', history: [] });
  const base = { records: [rec('a', '2020-01-01'), rec('b', '2020-01-02'), rec('c', '2020-01-03'), rec('d', null), rec('e', '2020-01-03'), rec('f', '2020-02-01')] };
  const one = JSON.stringify(base.records[0]).length + 1;
  const sel = parseLivingSelectors('2020-01-02', []);
  const out = projectLivingRecords(base, sel, one * 3);
  assert.deepEqual(S.plain(out.required.map(r => r.id)), ['b']);
  assert.deepEqual([...out.shown].sort(), ['b', 'f', 'c'].sort(), 'required b, then newest timed f, then c (tie with e broken by id)');
  const all = projectLivingRecords(base, parseLivingSelectors('track', []), one * 6);
  assert.equal(all.omitted.length, 0);
  const noUntimed = projectLivingRecords(base, parseLivingSelectors('track', []), one * 5);
  assert.deepEqual(S.plain(noUntimed.omitted.map(r => r.id)), ['d']);
  assert.throws(() => projectLivingRecords(base, parseLivingSelectors('2020-01', []), one * 2), /living-range-too-large: 2020-01/);
  const pref = projectLivingRecords(base, parseLivingSelectors('track 2020 revenue', []), one * 2);
  assert.deepEqual(S.plain(pref.required), [], 'a bare year is a preference, not a required range');
  assert.deepEqual([...pref.shown], ['a', 'b'], 'its records first, oldest to newest, partly omitted');
  assert.ok(pref.omitted.length > 0);
  assert.throws(() => projectLivingRecords(base, parseLivingSelectors('2020-01-01..2020-01-03', []), one * 2), /living-range-too-large: 2020-01-01\.\.2020-01-03/);
  const byId = projectLivingRecords(base, parseLivingSelectors('see d', ['d']), one * 3);
  assert.deepEqual(S.plain(byId.required.map(r => r.id)), ['d']);
});

const SEED_AT = { at: '2026-11-27T04:00:00+08:00', evidence: [{ id: 'e1', source: 'https://example.com', retrievedAt: 't1' }] };
async function runtimeFixture({ count, prompt, notes = {}, reply, mapSources } ) {
  const f = S.fixture();
  const map = S.map([S.node('parent')]);
  f.repo.readMap = async () => map;
  await f.app.vault.create('parent.md', '---\nagent-map-node: true\nagent-map-id: map\ntopic-id: map\nnode-id: parent\nai-card: true\n---\n# parent\n\n## Prompt\n\n' + prompt + '\n');
  for (const [name, text] of Object.entries(notes)) await f.app.vault.create(name + '.md', text);
  for (let from = 0; from < count; from += 100) {
    const expectedContent = f.contents.get('parent.md');
    const base = readLivingMarkdown(expectedContent);
    const operations = Array.from({ length: Math.min(100, count - from) }, (_, i) => append(from + i));
    const candidate = { executionId: 'seed' + from, cardId: 'parent', mapId: 'map', baseRevision: livingSnapshotRevision(expectedContent), inputRevision: 'i', viewSession: 'v' };
    assert.equal(await commitLivingMarkdown(f.repo, { path: 'parent.md', expectedContent, candidate, base, baseGeneration: livingGeneration(expectedContent), proposal: { baseRevision: base.revision, operations }, context: SEED_AT,
      signal: new AbortController().signal, isCurrent: () => true, inspect: async () => ({ ...candidate, locked: false, aborted: false, dependenciesReady: true, alreadyCommitted: false }) }), 'written');
  }
  await saveLivingConfig(f.app, f.repo, map, 'parent', prompt);
  const prompts = [];
  const failures = [];
  const port = { app: f.app, repo: f.repo, mapPath: 'Map.md', viewSession: 'view', signal: new AbortController().signal, coordinator: new LivingCoordinator(), current: () => true, busy: () => false,
    language: () => 'English', mapSources: mapSources ?? (async () => []), confirm: async (_m, run) => { await run(); return true; }, onStart() {}, onRunning() {}, onSettled() {}, onFailure: (_id, error) => failures.push(String(error.message)),
    calls: { run: async (prepared, options, finish) => { prompts.push(prepared.prompt);
      return finish(JSON.stringify({ baseRevision: prepared.input.base.revision, requiresWeb: false, operations: reply ? reply(prepared) : [] }), { signal: options.signal, parsed() {} }); } } };
  return { ...f, map, port, prompts, failures };
}

S.integrationTest('A43: a 600-record history answers an exact old date in one call: range record shown, bounded prompt, timing and call count measured', async () => {
  const f = await runtimeFixture({ count: 600, prompt: 'What did we record on 2020-03-05?' });
  assert.equal(readLivingMarkdown(f.contents.get('parent.md')).records.length, 600);
  const small = await runtimeFixture({ count: 6, prompt: 'What did we record on 2020-01-05?' });
  const warm = performance.now();
  await runLivingRound(small.port, ['parent']);
  const baseline = Math.max(1, Math.round(performance.now() - warm));
  const started = performance.now();
  const result = await runLivingRound(f.port, ['parent']);
  const elapsed = Math.round(performance.now() - started);
  console.log('A43 600 records vs 6-record baseline ' + baseline + ' ms: 1 round, ' + f.prompts.length + ' provider call, ' + elapsed + ' ms, prompt ' + f.prompts[0]?.length + ' chars');
  assert.equal(result.get('parent'), 'no-change');
  assert.equal(f.prompts.length, 1);
  assert.ok(f.prompts[0].length <= 100_000);
  assert.ok(f.prompts[0].includes('"id":"r64"') && f.prompts[0].includes('2020-03-05'), 'the record of the asked date is shown');
  assert.ok(!f.prompts[0].includes('"id":"r0"') && f.prompts[0].includes('"id":"r599"'), 'the rest is newest first');
  assert.match(f.prompts[0], /"omitted":\{"count":\d+/);
  assert.ok(elapsed < baseline * 40 + 1000, 'a 600-record round costs about a small one, not a scan per record (' + elapsed + ' vs ' + baseline + ' ms)');
});

S.integrationTest('D2-6b A43: "between X and Y" on a 600-record history sends every record of those ten days', async () => {
  const f = await runtimeFixture({ count: 600, prompt: 'Summarize what was recorded between 2020-03-01 and 2020-03-10 from the existing history.' });
  await runLivingRound(f.port, ['parent']);
  assert.equal(f.prompts.length, 1);
  for (let n = 60; n <= 69; n++) assert.ok(f.prompts[0].includes('"id":"r' + n + '"'), 'r' + n + ' is in the range and must be sent');
});

S.integrationTest('A43: a required range that cannot fit fails closed before any call and leaves every byte unchanged', async () => {
  const f = await runtimeFixture({ count: 600, prompt: 'Summarize 2020-01-01..2020-12-31' });
  const before = readLivingMarkdown(f.contents.get('parent.md'));
  const result = await runLivingRound(f.port, ['parent']);
  assert.equal(result.get('parent'), 'failed');
  assert.equal(f.prompts.length, 0);
  const after = readLivingMarkdown(f.contents.get('parent.md'));
  assert.equal(after.revision, before.revision, 'no knowledge write');
  assert.equal(after.records.length, 600);
  assert.match(f.failures.join('|'), /living-range-too-large: 2020-01-01\.\.2020-12-31/);
});

S.integrationTest('A43: a bare year in the Prompt is a preference: the card still runs and discloses what was omitted', async () => {
  const f = await runtimeFixture({ count: 600, prompt: 'track 2020 revenue' });
  const result = await runLivingRound(f.port, ['parent']);
  assert.notEqual(result.get('parent'), 'failed', f.failures.join('|'));
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0], /"omitted":\{"count":\d+/);
});

S.integrationTest('A43: one budget, in priority order: recent records come before optional sources, which are omitted with disclosure', async () => {
  const optional = async () => ({ unavailable: 0, groups: [{ documents: [{ path: 'Other.md', content: 'OPTIONAL-MAP-TEXT ' + 'y'.repeat(5000) }] }] });
  const small = await runtimeFixture({ count: 3, prompt: 'track things', notes: { 'Other': 'OPTIONAL-MAP-TEXT' }, mapSources: optional });
  await small.app.vault.create('Other.md', 'OPTIONAL-MAP-TEXT').catch(() => {});
  await runLivingRound(small.port, ['parent']);
  assert.ok(small.prompts[0].includes('OPTIONAL-MAP-TEXT'), 'room left: the optional source is delivered');
  const big = await runtimeFixture({ count: 600, prompt: 'track things', notes: { 'Other': 'OPTIONAL-MAP-TEXT' }, mapSources: optional });
  await runLivingRound(big.port, ['parent']);
  assert.ok(!big.prompts[0].includes('OPTIONAL-MAP-TEXT'), 'history fills the budget first');
  assert.ok(big.prompts[0].includes('map-source-budget-omitted: Other.md'), 'the omission is disclosed');
  assert.ok(big.prompts[0].length <= 100_000);
});

S.integrationTest('A43/B2: a quoted heading path delivers exactly that section of a Markdown source; duplicate, missing and Observation fail closed', async () => {
  const note = '# Note\n## A\nalpha-text\n### X\nx-one-text\n## B\nbeta-text\n### X\nx-two-text\n### Observation\nshared-text\n';
  const run = async question => {
    const f = await runtimeFixture({ count: 0, prompt: question + '\n\nSources: [[Note]]', notes: { Note: note } });
    const result = await runLivingRound(f.port, ['parent']);
    return { f, result, text: f.failures.join('|') };
  };
  const ok = await run('Check "Note > A > X"');
  assert.equal(ok.f.prompts.length, 1);
  const documents = JSON.parse(ok.f.prompts[0].slice(ok.f.prompts[0].indexOf('{"documents"'), ok.f.prompts[0].indexOf('\n\nDo not access'))).documents;
  const delivered = documents.find(d => d.title === 'Note');
  assert.equal(delivered.scope, 'section');
  assert.ok(delivered.text.includes('x-one-text') && !delivered.text.includes('x-two-text') && !delivered.text.includes('beta-text'));
  for (const [question, label] of [['Check "Note > X"', 'Note > X'], ['Check "Note > Z"', 'Note > Z'], ['Check "Note > B > Observation"', 'Note > B > Observation']]) {
    const bad = await run(question);
    assert.equal(bad.f.prompts.length, 0, label);
    assert.match(bad.text, new RegExp('living-section-ambiguous: ' + label.replace(/>/g, '>')), label);
  }
});

S.integrationTest('A43: a heading path whose note is no source warns section-path-no-source and does not fail', async () => {
  const f = await runtimeFixture({ count: 0, prompt: 'Check "Elsewhere > A"\n\nSources: [[Note]]', notes: { Note: '# Note\n## A\nalpha-text\n' } });
  await runLivingRound(f.port, ['parent']);
  assert.equal(f.prompts.length, 1, 'the unmatched path does not stop the call');
  assert.ok(!f.failures.some(text => /section|range|context/.test(text)), f.failures.join('|'));
  assert.ok(f.prompts[0].includes('section-path-no-source: Elsewhere > A'));
});

S.integrationTest('T04 follow-up: the checked artifact comes from observed web activity, not model text, and a no-change run records it', async () => {
  const url = 'https://example.com/current';
  const opened = { method: 'item/completed', params: { item: { type: 'webSearch', action: { type: 'openPage', url } } } };
  const searched = { method: 'item/completed', params: { item: { type: 'webSearch', action: { type: 'search', query: 'latest price' } } } };
  const f = S.fixture();
  await f.app.vault.create(path, initial);
  const generate = async (events, answer, base = readLivingMarkdown(f.contents.get(path))) => generateLivingProposal({ run: async (prepared, options, finish) => {
    for (const event of events) options.task.onWebSearchEvent(event);
    return finish(JSON.stringify({ baseRevision: base.revision, requiresWeb: false, ...answer, operations: [append(1)] }), { signal: options.signal, parsed() {} });
  } }, { model: 'm', reasoning: 'auto', prompt: 'track', language: 'en', base, context: '{}', evidence: context.evidence, mapPath: 'map.md' }, new AbortController().signal);
  // The model says nothing about web (requiresWeb false, no checkedWeb), yet the opened page and the search are recorded, deduplicated.
  const seen = await generate([opened, searched, opened], {});
  assert.deepEqual(S.plain(seen.checked.map(c => c.url ?? 'search: ' + c.query)), [url, 'search: latest price']);
  assert.ok(seen.checked.every(c => /^20\d\d-\d\d-\d\dT/.test(c.at)));
  assert.deepEqual(S.plain(seen.context.checked), S.plain(seen.checked));
  const expectedContent = f.contents.get(path);
  const candidate = { executionId: 'w1', cardId: 'card', mapId: 'map', baseRevision: livingSnapshotRevision(expectedContent), inputRevision: 'i', viewSession: 'v' };
  const save = async (generated, id) => commitLivingMarkdown(f.repo, { path, expectedContent: f.contents.get(path), candidate: { ...candidate, executionId: id, baseRevision: livingSnapshotRevision(f.contents.get(path)) },
    base: readLivingMarkdown(f.contents.get(path)), baseGeneration: livingGeneration(f.contents.get(path)), proposal: generated.proposal, context: generated.context, signal: new AbortController().signal, isCurrent: () => true,
    inspect: async () => ({ ...candidate, executionId: id, baseRevision: livingSnapshotRevision(f.contents.get(path)), locked: false, aborted: false, dependenciesReady: true, alreadyCommitted: false }) });
  assert.equal(await save(seen, 'w1'), 'written');
  const written = f.contents.get(path);
  assert.match(written, /living-node-checked:\n  - "20[^"]* https:\/\/example\.com\/current"\n  - "20[^"]* search: latest price"/);
  // A later run that touched no web clears it instead of leaving a stale proof.
  const none = await generate([], {});
  none.proposal.operations = [];
  assert.equal(await save(none, 'w2'), 'written');
  assert.ok(!f.contents.get(path).includes('living-node-checked'));
});

// ---- Draft source confirmation belongs to a saved configuration only ----
async function unresolvedSourceFixture() {
  const { LivingIdentityStore } = S.load('experiences/visual-map/living-node-sources.ts');
  const f = await runtimeFixture({ count: 0, prompt: 'track things', notes: { Note: '# Note\nbody\n' } });
  let n = 0;
  const store = new LivingIdentityStore(undefined, () => {}, () => 'id' + ++n);
  set(f.app, store);
  const file = f.app.vault.getAbstractFileByPath('Note.md');
  store.observe('Note.md', { ctime: file.stat.ctime + 1000, size: file.stat.size });
  assert.equal(store.observe('Note.md', file.stat).state, 'unknown', 'fixture: another file now sits at the source path');
  return { ...f, store, file, restore: () => set(f.app, undefined) };
}

S.integrationTest('Draft confirmation: a trial on an unsaved draft treats the unresolved link as resolved without touching the identity store or the card', async () => {
  const f = await unresolvedSourceFixture();
  const before = S.plain(f.store.at('Note.md'));
  const bytes = f.contents.get('parent.md');
  const prepared = await prepareLivingTrial(f.port, 'parent', 'track things\n\nSources: [[Note]]');
  assert.ok(prepared.request, 'the trial is built');
  assert.deepEqual(S.plain(f.store.at('Note.md')), before, 'identity store untouched');
  assert.equal(f.store.at('Note.md').state, 'unknown');
  assert.equal(f.contents.get('parent.md'), bytes);
  f.restore();
});

S.integrationTest('Draft confirmation: a failed save does not reconfirm; a successful save does', async () => {
  const f = await unresolvedSourceFixture();
  const before = S.plain(f.store.at('Note.md'));
  const real = f.repo.updateNoteGuarded;
  f.repo.updateNoteGuarded = async () => 'conflict';
  await assert.rejects(() => saveLivingConfig(f.app, f.repo, f.map, 'parent', 'track things\n\nSources: [[Note]]'), /changed-configuration/);
  assert.deepEqual(S.plain(f.store.at('Note.md')), before, 'failed save leaves the identity store untouched');
  f.repo.updateNoteGuarded = real;
  const saved = await saveLivingConfig(f.app, f.repo, f.map, 'parent', 'track things\n\nSources: [[Note]]');
  assert.equal(saved.outcome, 'written');
  assert.equal(f.store.at('Note.md').state, 'resolved', 'the saved configuration confirms the source');
  assert.notEqual(f.store.at('Note.md').refId, before.refId);
  f.restore();
});

// A cross-map reference reads a Living Node note as an ordinary note: the provider sees its model view, never holds or ownership.
async function foreignLivingNote() {
  const f = await runtimeFixture({ count: 3, prompt: 'seed' });
  const saved = f.contents.get('parent.md');
  const edited = saved.replace(/\n### Observation\n[\s\S]*?(?=\n### Suppression)/, '');
  await f.app.vault.process(f.files.get('parent.md'), () => edited);
  const base = readLivingMarkdown(edited);
  const candidate = { executionId: 'del', cardId: 'parent', mapId: 'map', baseRevision: livingSnapshotRevision(edited), inputRevision: 'i', viewSession: 'v' };
  assert.equal(await commitLivingMarkdown(f.repo, { path: 'parent.md', expectedContent: edited, candidate, base, baseGeneration: livingGeneration(edited),
    proposal: { baseRevision: base.revision, operations: [{ kind: 'output', text: 'FOREIGN-FINDINGS', evidence: ['e1'] }] }, context: SEED_AT, signal: new AbortController().signal, isCurrent: () => true,
    inspect: async () => ({ ...candidate, locked: false, aborted: false, dependenciesReady: true, alreadyCommitted: false }) }), 'written');
  const note = f.contents.get('parent.md');
  assert.match(note, /Suppression v2: /);
  return note;
}
const leaks = (prompt, note) => {
  const owned = String(note.match(/living-node-ownership:[^\n]*(?:\n[ \t]+[^\n]*)*/)?.[0] ?? '');
  const hashes = (owned.match(/[0-9a-f]{64}/g) ?? []).filter(hash => !prompt.includes('"revision":"' + hash + '"'));
  return [/@v2:/.test(prompt) && '@v2', /@event|evt:/.test(prompt) && 'tombstone', /Suppression/.test(prompt) && 'Suppression', /living-node-/.test(prompt) && 'frontmatter',
    hashes.some(hash => prompt.includes(hash)) && 'ownership hash'].filter(Boolean);
};

S.integrationTest('privacy: a Living Node note read as an ordinary cross-map note sends its model view, never suppression or ownership', async () => {
  const foreign = await foreignLivingNote();
  const f = await runtimeFixture({ count: 0, prompt: 'track things\n\nSources: [[Foreign]]', notes: { Foreign: foreign } });
  await runLivingRound(f.port, ['parent']);
  assert.equal(f.prompts.length, 1, f.failures.join('|'));
  assert.ok(f.prompts[0].includes('FOREIGN-FINDINGS'), 'the output still reaches the model');
  assert.deepEqual(leaks(f.prompts[0], foreign), []);
});

S.integrationTest('privacy: a Living Node note delivered as a map-level source is sanitised the same way', async () => {
  const foreign = await foreignLivingNote();
  const mapSources = async () => ({ unavailable: 0, groups: [{ documents: [{ path: 'Other.md', content: foreign }, { path: 'ext/x.md', content: foreign, external: true, key: 'k' }] }] });
  const f = await runtimeFixture({ count: 0, prompt: 'track things', mapSources });
  await runLivingRound(f.port, ['parent']);
  assert.equal(f.prompts.length, 1, f.failures.join('|'));
  assert.ok(f.prompts[0].includes('FOREIGN-FINDINGS'));
  assert.deepEqual(leaks(f.prompts[0], foreign), []);
});

// Every other AI reader of raw vault text: chat attachments, chat-started research and map-level file sources.
const { buildMapChatContext } = S.load('core/map-chat-context.ts', { obsidian: S.obsidian });
const chatBase = { mapTitle: 'M', outline: [], selected: [], references: [], snippets: [], files: [], activeFile: null, history: [] };

S.integrationTest('privacy: chat context (attached file, active note, own file) never carries a Living Node note\'s holds or ownership', async () => {
  const foreign = await foreignLivingNote();
  for (const input of [{ files: [{ path: 'F.md', content: foreign }] }, { activeFile: { path: 'A.md', content: foreign } }, { ownFiles: [{ path: 'O.md', content: foreign }] }]) {
    const sent = JSON.stringify(buildMapChatContext({ ...chatBase, ...input }));
    assert.ok(sent.includes('Current') || sent.includes('"path":'), 'the note is still delivered');
    assert.deepEqual(leaks(sent, foreign), [], Object.keys(input)[0]);
  }
});

S.integrationTest('chat: a Living Node note in the chat context carries its output and AI latest text, none of the managed parts', async () => {
  const { livingNoteForModel } = S.load('experiences/visual-map/living-node-markdown.ts', { obsidian: S.obsidian });
  // The user edits the AI's output (it becomes theirs); a new AI result then lands in AI latest.
  const f = await runtimeFixture({ count: 3, prompt: 'seed' });
  const commit = async (text, before) => {
    const base = readLivingMarkdown(before);
    const candidate = { executionId: 'x' + text, cardId: 'parent', mapId: 'map', baseRevision: livingSnapshotRevision(before), inputRevision: 'i', viewSession: 'v' };
    assert.equal(await commitLivingMarkdown(f.repo, { path: 'parent.md', expectedContent: before, candidate, base, baseGeneration: livingGeneration(before),
      proposal: { baseRevision: base.revision, operations: [{ kind: 'output', text, evidence: ['e1'] }] }, context: SEED_AT, signal: new AbortController().signal, isCurrent: () => true,
      inspect: async () => ({ ...candidate, locked: false, aborted: false, dependenciesReady: true, alreadyCommitted: false }) }), 'written');
    return f.contents.get('parent.md');
  };
  const trimmed = f.contents.get('parent.md').replace(/\n### Observation\n[\s\S]*?(?=\n### Suppression)/, '');
  await f.app.vault.process(f.files.get('parent.md'), () => trimmed);
  const first = await commit('OUTPUT-FIRST', trimmed);
  const edited = first.replace('OUTPUT-FIRST', 'OUTPUT-BY-USER').replace('### Current output\n- Ownership: "ai"', '### Current output\n- Ownership: "user"');
  await f.app.vault.process(f.files.get('parent.md'), () => edited);
  const note = await commit('AI-LATEST-TEXT', edited);
  assert.ok(readLivingMarkdown(note).aiLatest?.text.includes('AI-LATEST-TEXT'), 'the card has an AI latest');
  for (const input of [{ files: [{ path: 'F.md', content: note }] }, { activeFile: { path: 'A.md', content: note } }, { ownFiles: [{ path: 'O.md', content: note }] }]) {
    const sent = JSON.stringify(buildMapChatContext({ ...chatBase, ...input, noteForModel: livingNoteForModel }));
    const name = Object.keys(input)[0];
    assert.ok(sent.includes('OUTPUT-FIRST') && sent.includes('AI-LATEST-TEXT'), name + ' carries the output and AI latest');
    assert.deepEqual(leaks(sent, note), [], name);
    assert.equal(/- ID:|[0-9a-f]{64}/.test(sent.replace(/revision\\*":\\*"[0-9a-f]{64}/g, '').replace(/"contentHash":"[^"]*"/g, '')), false, name + ': no tombstone ids or hashes');
  }
  // Without the view the note still goes out with its managed parts removed.
  const plain = JSON.stringify(buildMapChatContext({ ...chatBase, files: [{ path: 'F.md', content: note }] }));
  assert.deepEqual(leaks(plain, note), []);
});

const { chatResearchReferenceGroups } = S.load('experiences/visual-map/chat-research-sources.ts', { obsidian: S.obsidian });
const { resolveMapSources } = S.load('experiences/visual-map/map-sources.ts', { obsidian: S.obsidian });
S.integrationTest('privacy: research started from the chat and map-level file sources get the model view of a Living Node note', async () => {
  const foreign = await foreignLivingNote();
  const groups = chatResearchReferenceGroups({ files: [{ path: 'F.md', content: foreign }], activeFile: null, snippets: [] });
  assert.deepEqual(leaks(JSON.stringify(groups), foreign), []);
  assert.ok(JSON.stringify(groups).includes('FOREIGN-FINDINGS'));
  const f = S.fixture();
  await f.app.vault.create('Src/live.md', foreign);
  const out = await resolveMapSources({ app: f.app, readMap: p => f.repo.readMap(p) }, [{ kind: 'file', path: 'Src/live.md' }, { kind: 'folder', path: 'Src' }], 'Cur/Map.md', new AbortController().signal);
  assert.equal(out.groups.length > 0, true);
  assert.deepEqual(leaks(JSON.stringify(out.groups), foreign), []);
  assert.ok(JSON.stringify(out.groups).includes('FOREIGN-FINDINGS'));
});

// A damaged region (lone end, lone begin, duplicate) still has to keep holds and ownership out of every reader of note text.
const { livingNoteWithoutManaged, LIVING_NODE_BEGIN: BEGIN, LIVING_NODE_END: END } = S.load('core/living-node-region.ts', { obsidian: S.obsidian });
const hex = ch => ch.repeat(64);
const damageFm = '---\nagent-map-node: true\nliving-node-ownership:\n  - ["r1","' + hex('b') + '"]\n"living-node-region-hash": ' + hex('c') + '\nai-card: true\n---\n';
const damageRegion = BEGIN + '\n### Records\n- x\n### Suppression\n- ID: legacy-tombstone-1\n- Suppression v2: abc@v2:' + hex('a') + '\n' + END;
const damageNotes = {
  healthy: damageFm + '# T\n\n## Detail\n\nuser text\n\n' + damageRegion + '\n\n## Prompt\np\n',
  loneEnd: damageFm + '# T\n\n## Detail\n\nuser text\n\n' + damageRegion.replace(BEGIN, '') + '\n\n## Prompt\np\n',
  loneBegin: damageFm + '# T\n\n## Detail\n\nuser text\n\n' + damageRegion.replace(END, '') + '\n\n## Prompt\np\n',
  duplicate: damageFm + '# T\n\n## Detail\n\nuser text\n\n' + damageRegion + '\n' + damageRegion + '\n\n## Prompt\np\n'
};
const damageLeaks = text => [/Suppression/.test(text) && 'Suppression', /@v2/.test(text) && '@v2', /[0-9a-f]{64}/.test(text) && '64-hex', /legacy-tombstone/.test(text) && 'legacy id', /living-node-/.test(text) && 'frontmatter'].filter(Boolean);

S.integrationTest('privacy: Note.detail and Note.prompt of a damaged Living Node note carry no holds, ownership or hash; a healthy note keeps its text', async () => {
  const f = S.fixture();
  for (const [name, content] of Object.entries(damageNotes)) {
    await f.app.vault.create(name + '.md', content);
    const note = await f.repo.readNote(name + '.md');
    assert.deepEqual(damageLeaks(note.detail + '\n' + note.prompt + '\n' + note.rules), [], name);
    // A lone end is cut from the start of the note up to the marker (fail closed), so the text before it goes too.
    if (name !== 'loneEnd') assert.ok(note.detail.includes('user text'), name + ' keeps the user text');
    // A lone begin is cut to the end of the note, so a Prompt after it goes too.
    assert.equal(note.prompt, name === 'loneBegin' ? '' : 'p', name);
  }
});

S.integrationTest('privacy: the sanitiser output of every damage shape has no hold, legacy tombstone or 64-hex string', async () => {
  for (const [name, content] of Object.entries(damageNotes)) assert.deepEqual(damageLeaks(livingNoteWithoutManaged(content)), [], name);
});

S.integrationTest('privacy: a leading byte-order mark does not hide the living-node-* frontmatter keys', async () => {
  const out = livingNoteWithoutManaged('﻿' + damageNotes.healthy);
  assert.deepEqual(damageLeaks(out), []);
  assert.ok(out.includes('user text'));
});

S.integrationTest('privacy: a file in an external folder that is a Living Node note is delivered as its model view', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const foreign = await foreignLivingNote();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vam-ext-')));
  try {
    const home = path.join(tmp, 'home'), vault = path.join(home, 'Vault'), docs = path.join(home, 'ext', 'docs');
    fs.mkdirSync(vault, { recursive: true }); fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, 'live.md'), foreign);
    const f = S.fixture();
    const out = await resolveMapSources({ app: f.app, readMap: p => f.repo.readMap(p), external: { sources: [{ path: docs, label: 'docs' }], scope: { vaultBase: vault, home } } }, [], 'Cur/Map.md', new AbortController().signal);
    const sent = JSON.stringify(out.groups);
    assert.ok(sent.includes('FOREIGN-FINDINGS'), 'the output still reaches the model');
    assert.deepEqual(leaks(sent, foreign), []);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

S.integrationTest('A11 live: the change-set step tells the model to correct or invalidate a superseded old record', async () => {
  const f = S.fixture();
  await f.app.vault.create(path, initial);
  const { sent } = await round(f, [append(1)]);
  assert.match(sent[0], /newer observation supersedes an older current-state fact of the same subject and scope[^.]*`correct` or `invalidate` the old record/);
});

// ---- D2-5 (A36): one repair re-send for an evidence rejection ----
// The stub transport answers each call from `replies` in order; every reply is checked by the production validator.
async function repairRound(replies, opened = [], seed = []) {
  const f = S.fixture();
  await f.app.vault.create(path, initial);
  if (seed.length) assert.equal(await commit(f, readLivingMarkdown(f.contents.get(path)), seed), 'written');
  const base = readLivingMarkdown(f.contents.get(path));
  const sent = [];
  const calls = { run: async (prepared, options, finish) => {
    sent.push({ prompt: prepared.prompt, options });
    for (const url of opened) options.task.onWebSearchEvent({ method: 'item/completed', params: { item: { type: 'webSearch', action: { type: 'openPage', url } } } });
    const operations = replies[Math.min(sent.length - 1, replies.length - 1)];
    const body = typeof operations === 'string' ? operations : JSON.stringify({ baseRevision: base.revision, requiresWeb: false, operations });
    return finish(body, { signal: options.signal, parsed() {} });
  } };
  const input = { model: 'm', reasoning: 'auto', prompt: 'track competitor', language: 'en', base, context: '{}', evidence: context.evidence, mapPath: 'map.md' };
  const result = generateLivingProposal(calls, input, new AbortController().signal);
  return { f, base, sent, result };
}
const good = { kind: 'append', id: 'n1', subject: 'Beta', scope: 'pricing', granularity: 'day', eventTime: '2026-11-27', claim: 'Beta cut prices', evidence: ['e1'] };

S.integrationTest('D2-5 A36: an unknown evidence id gets one repair call; the corrected reply is used (2 calls, writes)', async () => {
  const { f, base, sent, result } = await repairRound([[{ ...good, evidence: ['competitor-2026-11-27'] }], [good]]);
  const generated = await result;
  assert.equal(sent.length, 2);
  assert.deepEqual(S.plain(generated.proposal.operations.map(op => op.id)), ['n1']);
  // The repair names only the code, the operation number and the allowed ids: never the rejected reply's own text.
  const repair = sent[1].prompt.slice(sent[0].prompt.length);
  assert.match(repair, /unauthorized-evidence/);
  assert.match(repair, /operation 1\b/);
  assert.match(repair, /"e1"/);
  assert.ok(!repair.includes('competitor-2026-11-27') && !repair.includes('Beta cut prices'));
  assert.equal(await commit(f, base, generated.proposal.operations), 'written');
});

S.integrationTest('D2-5 A36: missing and missing-new evidence are repaired once too; both attempts wrong stays refused (2 calls, 0 writes)', async () => {
  const empty = await repairRound([[{ ...good, evidence: [] }], [good]]);
  assert.equal((await empty.result).proposal.operations.length, 1);
  assert.equal(empty.sent.length, 2);
  // A correction citing only the record's old evidence: repaired once, and the second answer stands.
  const correct = { kind: 'correct', id: 'n1', claim: 'Beta raised prices', reason: 'new filing', evidence: ['e1'] };
  const noNew = await repairRound([[correct]], [], [good]);
  await assert.rejects(() => noNew.result, /missing-new-evidence/);
  assert.equal(noNew.sent.length, 2);
  assert.match(noNew.sent[1].prompt.slice(noNew.sent[0].prompt.length), /missing-new-evidence at operation 1\b/);
  // Both attempts wrong: the round is refused after exactly two calls and nothing is written.
  const twice = await repairRound([[{ ...good, evidence: ['forged'] }]]);
  await assert.rejects(() => twice.result, /unauthorized-evidence/);
  assert.equal(twice.sent.length, 2);
  assert.equal(twice.f.contents.get(path), initial);
  // The repair only re-cites: it never starts a new web search.
  assert.equal(twice.sent[1].options.task.searchBudget, 0);
  assert.equal(twice.sent[1].options.task.textOnly, true);
  // A web URL the run never opened is the same class of rejection.
  const url = await repairRound([[{ ...good, evidence: ['https://evil.example/x'] }], [good]]);
  assert.equal((await url.result).proposal.operations.length, 1);
  assert.equal(url.sent.length, 2);
});

S.integrationTest('D2-5 A36: an unknown record, bad JSON or a stop is never re-sent (1 call)', async () => {
  const unknown = await repairRound([[{ kind: 'supplement', id: 'ghost', evidence: ['e1'] }], [good]]);
  await assert.rejects(() => unknown.result, /unknown-record/);
  assert.equal(unknown.sent.length, 1);
  const json = await repairRound(['not json', [good]]);
  await assert.rejects(() => json.result);
  assert.equal(json.sent.length, 1);
  // A stop during the first call is final: no repair is sent.
  const stopped = new AbortController();
  let stopCount = 0;
  const stopCalls = { run: async (prepared, options, finish) => {
    stopCount++;
    stopped.abort();
    return finish(JSON.stringify({ baseRevision: 'x', requiresWeb: false, operations: [{ ...good, evidence: ['forged'] }] }), { signal: options.signal, parsed() {} });
  } };
  await assert.rejects(() => generateLivingProposal(stopCalls, { model: 'm', reasoning: 'auto', prompt: 'track', language: 'en', base: readLivingMarkdown(initial), context: '{}', evidence: context.evidence, mapPath: 'map.md' }, stopped.signal), /cancelled/);
  assert.equal(stopCount, 1);
  // The operation number points at the model's own list, past an earlier valid operation.
  const second = await repairRound([[good, { ...good, id: 'n2', evidence: ['forged'] }], [good]]);
  await second.result;
  assert.match(second.sent[1].prompt.slice(second.sent[0].prompt.length), /unauthorized-evidence at operation 2\b/);
});
