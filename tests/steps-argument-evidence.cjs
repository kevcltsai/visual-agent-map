// Argument map evidence research reply contract (P4): `responseContract: "argument-evidence"` on the existing task.run path.
// The parser refuses everything verifySource could not use; existing contracts and the AIM web-event consumers are unchanged.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { load, makeService, capturingRuntime, EMPTY_RESULT } = require('./support-replay.cjs');
const parse = S.load('core/steps/task/parse.ts');
const schemas = S.load('core/steps/task/schemas.ts');
const sp = S.load('core/argument-map/source-proof.ts');

const plain = value => JSON.parse(JSON.stringify(value));
const IDS = ['n1', 'n2', 'n3'];
const QUOTE = 'Youth unemployment rose to 9.2 percent in March';
const found = (need = 'n1', over = {}) => ({ need, status: 'found', stance: 'supports', claim: 'Rate rose', quote: QUOTE, url: 'https://stats.example.org/report', ...over });
const miss = (need = 'n2', over = {}) => ({ need, status: 'not_found', stance: 'uncertain', claim: '', quote: '', url: '', ...over });
const parseEv = (items, ids = IDS) => parse.parseArgumentEvidence(items, ids);
const refuse = (items, ids) => assert.throws(() => parseEv(items, ids), /argument evidence reply is not usable/);
const body = (items, extra = {}) => JSON.stringify({ summary: 'S', detail: 'D', suggestions: [], visualReferences: [], argumentEvidence: items, ...extra });

test('accepts found and not_found entries; a not_found reason is dropped; omitted needs stay unanswered', () => {
  const out = plain(parseEv([found('n1'), miss('n2', { claim: 'no page had it' })]));
  assert.deepEqual(out, [{ need: 'n1', status: 'found', stance: 'supports', claim: 'Rate rose', quote: QUOTE, url: 'https://stats.example.org/report' }, { need: 'n2', status: 'not_found' }]);
  for (const stance of ['supports', 'contradicts', 'uncertain']) assert.equal(parseEv([found('n1', { stance })])[0].stance, stance);
  assert.equal(parseEv([found('n1', { quote: ` ${QUOTE} `, claim: ' Rate rose ' })])[0].quote, QUOTE);
});

test('refuses ids outside the request, repeated ids and an empty or non-array value', () => {
  refuse([found('n9')]);
  refuse([found('n1'), miss('n1')]);
  refuse([found('N1')]);
  refuse([]);
  refuse(undefined);
  refuse({ need: 'n1' });
  refuse(['n1']);
  refuse([null]);
  refuse([[found()]]);
  refuse([found('n1')], []);
});

test('refuses fabricated, missing and extra fields', () => {
  const { url, ...noUrl } = found();
  refuse([noUrl]);
  refuse([found('n1', { checkedAt: '2026-11-09', proof: { check: 'page_match' } })]);
  refuse([found('n1', { stance: 'opposes' })]);
  refuse([found('n1', { stance: undefined })]);
  refuse([found('n1', { status: 'FOUND' })]);
  refuse([found('n1', { status: 'maybe' })]);
  refuse([found('n1', { claim: 5 })]);
  refuse([found('n1', { quote: null })]);
  refuse([found('n1', { claim: '   ' })]);
  refuse([found('n1', { claim: '' })]);
});

test('refuses a quote the source proof cannot use: too short, too long, punctuation only', () => {
  refuse([found('n1', { quote: 'x'.repeat(11) })]);
  assert.equal(parseEv([found('n1', { quote: 'x'.repeat(12) })]).length, 1);
  assert.equal(parseEv([found('n1', { quote: 'x'.repeat(200) })]).length, 1);
  refuse([found('n1', { quote: 'x'.repeat(201) })]);
  refuse([found('n1', { quote: '.'.repeat(30) })]);
  refuse([found('n1', { quote: '   \n  ' })]);
  // 12 to 200 counts characters, not UTF-16 units: 200 astral characters pass, 201 do not.
  assert.equal(parseEv([found('n1', { quote: '𠀀'.repeat(200) })]).length, 1);
  refuse([found('n1', { quote: '𠀀'.repeat(201) })]);
});

test('refuses a url that is not http or https', () => {
  for (const url of ['', 'ftp://example.org/a', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'example.org/page', 'not a url', 'mailto:a@b.co'])
    refuse([found('n1', { url })]);
  assert.equal(parseEv([found('n1', { url: 'http://example.org/a' })]).length, 1);
});

test('a not_found entry may not carry a source or a stance other than uncertain', () => {
  refuse([miss('n2', { quote: QUOTE })]);
  refuse([miss('n2', { url: 'https://example.org/a' })]);
  refuse([miss('n2', { stance: 'supports' })]);
  refuse([miss('n2', { extra: 1 })]);
});

test('the reply is read through the task parser only when need ids are passed; other requests are untouched', () => {
  const items = [found('n1')];
  const withIds = parse.parseAiResult(body(items), 'T', 'en', IDS);
  assert.equal(withIds.argumentEvidence.length, 1);
  assert.equal(withIds.summary, 'S');
  assert.throws(() => parse.parseAiResult(body([found('n9')]), 'T', 'en', IDS), /not usable/);
  assert.throws(() => parse.parseAiResult(EMPTY_RESULT, 'T', 'en', IDS), /not usable/);
  // Existing contracts: the same reply parses to exactly what it did, with no new key, whatever extra field it carries.
  const old = parse.parseAiResult(body(items), 'T', 'en');
  assert.deepEqual(plain(old), { summary: 'S', detail: 'D', suggestions: [], visualReferences: [] });
  assert.equal('argumentEvidence' in old, false);
  assert.deepEqual(plain(parse.parseAiResult(EMPTY_RESULT, 'T', 'en')), { summary: 'S', detail: 'D', suggestions: [], visualReferences: [] });
});

const context = (over = {}) => ({ title: 'T', summary: '', rules: '', detail: '', task: 'Does the page support the hypothesis?', ancestors: '', mode: 'task', researchMode: 'research', responseContract: 'argument-evidence', argumentEvidenceNeeds: [{ id: 'n1', text: 'a' }, { id: 'n2', text: 'b' }], ...over });

test('response shape: strict per-need schema; contract misuse throws; other contexts keep their schema', () => {
  const shape = schemas.taskResponseShape(context(), 'en');
  assert.deepEqual(shape.argumentEvidenceNeedIds, ['n1', 'n2']);
  const schema = plain(shape.schema);
  assert.ok(schema.required.includes('argumentEvidence'));
  assert.equal(schema.additionalProperties, false);
  const item = schema.properties.argumentEvidence.items;
  assert.deepEqual(item.properties.need.enum, ['n1', 'n2']);
  assert.equal(schema.properties.argumentEvidence.maxItems, 2);
  assert.deepEqual(item.required, ['need', 'status', 'stance', 'claim', 'quote', 'url']);
  assert.equal(item.additionalProperties, false);
  for (const bad of [{ argumentEvidenceNeeds: undefined }, { argumentEvidenceNeeds: [] }, { researchMode: 'local' }, { argumentEvidenceNeeds: [{ id: 'a', text: '' }, { id: 'a', text: '' }] }, { argumentEvidenceNeeds: [{ id: '', text: 'x' }] }])
    assert.throws(() => schemas.taskResponseShape(context(bad), 'en'), /argument-evidence contract/);
  // Existing contexts: the argument fields do not appear, and the schema is the response schema exactly as before.
  const base = schemas.taskResponseShape(context({ responseContract: undefined, argumentEvidenceNeeds: undefined }), 'en');
  assert.equal('argumentEvidenceNeedIds' in base, false);
  assert.deepEqual(plain(base.schema), plain(schemas.localizedResponseSchema('en')));
});

function runtimeEmitting(events, reply) {
  const rt = capturingRuntime([reply]);
  const inner = rt.runTask;
  rt.runTask = async (prompt, model, effort, schema, controls) => {
    for (const event of events) controls?.onWebSearchEvent?.(event);
    return inner(prompt, model, effort, schema, controls);
  };
  return rt;
}
const opened = url => ({ method: 'item/completed', params: { item: { id: url, type: 'webSearch', action: { type: 'openPage', url } } } });
const searched = { method: 'item/completed', params: { item: { id: 's', type: 'webSearch', action: { type: 'search' } } } };

test('AiTaskService: the result carries the parsed entries and the opened urls; the prompt names the needs and nothing else changes', async () => {
  const rt = runtimeEmitting([searched, opened('https://stats.example.org/report'), { method: 'item/started', params: { item: { type: 'webSearch', action: null } } }], body([found('n1'), miss('n2')]));
  const seen = [];
  const result = await makeService(rt).askModel(context(), 'gpt-6-luna', 'low', undefined, undefined, undefined, event => seen.push(event));
  assert.deepEqual(plain(result.argumentEvidence.map(item => item.need)), ['n1', 'n2']);
  assert.deepEqual(plain(result.evidence), { openedUrls: ['https://stats.example.org/report'] });
  assert.equal(result.retrievals, 2);
  assert.equal(seen.length, 3);
  assert.match(rt.calls[0].prompt, /"argumentEvidence"/);
  assert.match(rt.calls[0].prompt, /\[\{"id":"n1","text":"a"\},\{"id":"n2","text":"b"\}\]/);
  assert.deepEqual(plain(rt.calls[0].schema.properties.argumentEvidence.items.properties.need.enum), ['n1', 'n2']);
});

test('AiTaskService: a need with a context shows it to the research; a need without one renders exactly as before', async () => {
  const withContext = context({ argumentEvidenceNeeds: [{ id: 'n1', text: 'a', context: 'Period: ages 16 to 24, 2023 to 2024' }, { id: 'n2', text: 'b' }] });
  const rt = runtimeEmitting([opened('https://stats.example.org/report')], body([found('n1'), miss('n2')]));
  await makeService(rt).askModel(withContext, 'gpt-6-luna', 'low');
  assert.match(rt.calls[0].prompt, /\[\{"id":"n1","text":"a","context":"Period: ages 16 to 24, 2023 to 2024"\},\{"id":"n2","text":"b"\}\]/);
  const plainRt = runtimeEmitting([opened('https://stats.example.org/report')], body([found('n1'), miss('n2')]));
  await makeService(plainRt).askModel(context({ argumentEvidenceNeeds: [{ id: 'n1', text: 'a', context: undefined }, { id: 'n2', text: 'b' }] }), 'gpt-6-luna', 'low');
  assert.match(plainRt.calls[0].prompt, /\[\{"id":"n1","text":"a"\},\{"id":"n2","text":"b"\}\]/);
  assert.equal(plain(plainRt.calls[0].schema).properties.argumentEvidence.items.properties.need.enum.length, 2);
});

test('AiTaskService: the context instruction appears only when a need carries a context', async () => {
  const rt = runtimeEmitting([opened('https://stats.example.org/report')], body([found('n1'), miss('n2')]));
  await makeService(rt).askModel(context({ argumentEvidenceNeeds: [{ id: 'n1', text: 'a', context: 'Period: 2023' }, { id: 'n2', text: 'b' }] }), 'gpt-6-luna', 'low');
  assert.match(rt.calls[0].prompt, /period and definitions of that need/);
  const plainRt = runtimeEmitting([opened('https://stats.example.org/report')], body([found('n1'), miss('n2')]));
  await makeService(plainRt).askModel(context({ argumentEvidenceNeeds: [{ id: 'n1', text: 'a' }, { id: 'n2', text: 'b' }] }), 'gpt-6-luna', 'low');
  assert.doesNotMatch(plainRt.calls[0].prompt, /period and definitions of that need/);
});
test('AiTaskService: out-of-scope or malformed evidence rejects the whole reply; no entry is kept', async () => {
  for (const items of [[found('n9')], [found('n1', { url: 'ftp://x.org/a' })], [found('n1', { quote: 'short' })]]) {
    const rt = runtimeEmitting([opened('https://stats.example.org/report')], body(items));
    await assert.rejects(() => makeService(rt).askModel(context(), 'gpt-6-luna', 'low'), /not usable/);
  }
});

test('AiTaskService: an existing research request gets no argumentEvidence and no evidence field', async () => {
  const rt = runtimeEmitting([opened('https://stats.example.org/report')], EMPTY_RESULT);
  const result = await makeService(rt).askModel(context({ responseContract: undefined, argumentEvidenceNeeds: undefined }), 'gpt-6-luna', 'low');
  assert.equal('evidence' in result, false);
  assert.equal('argumentEvidence' in result, false);
  assert.equal(result.retrievals, 1);
  assert.doesNotMatch(rt.calls[0].prompt, /argumentEvidence/);
});

test('AiTaskService: only pages from this call count', () => {
  assert.deepEqual(plain(sp.openedUrlsFromEvents([searched, opened('https://a.example.org/x'), { method: 'item/started', params: { item: { type: 'webSearch', action: { type: 'openPage', url: 'https://b.example.org' } } } }])), ['https://a.example.org/x']);
});

test('AiTaskService: a page opened in a failed first attempt is not counted for the retried call', async () => {
  let attempt = 0;
  const rt = capturingRuntime([body([found('n1')])]);
  const inner = rt.runTask;
  rt.runTask = async (prompt, model, effort, schema, controls) => {
    attempt++;
    if (attempt === 1) {
      controls?.onWebSearchEvent?.(opened('https://first.example.org/a'));
      const error = new Error('no search');
      error.name = 'SearchNotPerformedError';
      throw error;
    }
    controls?.onWebSearchEvent?.(opened('https://second.example.org/b'));
    return inner(prompt, model, effort, schema, controls);
  };
  const result = await makeService(rt).askModel(context(), 'gpt-6-luna', 'low');
  assert.equal(attempt, 2);
  assert.deepEqual(plain(result.evidence), { openedUrls: ['https://second.example.org/b'] });
});
