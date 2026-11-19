// Picture-book pipeline (02b): the three AI steps (whole-book plan, card plan, proofread), the text they write into notes,
// the effective-settings rule, the proof record and the log boundary. Unit level: a fake runtime stands in for the model.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nodeFsAdapter } = require('./support-fs-adapter.cjs');
const { load } = require('./support-replay.cjs');
const { loadWithAiCalls } = require('./support-ai-calls.cjs');

const textLib = load('core/book-pipeline/text.ts');
const planText = load('core/book-pipeline/plan-text.ts');
const proof = load('core/book-pipeline/proof.ts');
const settings = load('core/book-pipeline/settings.ts');
const pipelineLog = load('core/book-pipeline/log.ts');
const globalPlan = load('core/steps/book-pipeline/global-plan.ts');
const cardPlan = load('core/steps/book-pipeline/card-plan.ts');
const applyNotes = load('core/steps/book-pipeline/apply-notes.ts');
const notesApply = load('core/book-pipeline/notes-apply.ts');
const proofMod = loadWithAiCalls('core/steps/book-pipeline/proofread.ts');
const runMod = loadWithAiCalls('core/steps/book-pipeline/run.ts');
const { AiExchangeLog } = load('ai-exchange-log.ts');

const base = { language: 'en', model: 'gpt-6-luna', reasoning: 'low' };
const TITLE = 'SECRET-TITLE-Renaissance';
const BODY = 'SECRET-BODY Brunelleschi demonstrated linear perspective around 1415.';
const checklist = [{ id: 'C1', type: 'structure', text: 'Names the technique' }, { id: 'C2', type: 'fact', text: 'States the date' }];
const item = (id, status = 'met', sources = [], note = 'ok') => ({ id, status, note, sources });
const reply = results => JSON.stringify({ results });
const page = url => ({ method: 'item/completed', params: { item: { type: 'webSearch', action: { type: 'openPage', url } } } });
const search = query => ({ method: 'item/completed', params: { item: { type: 'webSearch', action: { type: 'search', query } } } });
const plain = value => JSON.parse(JSON.stringify(value));

function harness({ answer = '{}', fail, events = [], logging = true } = {}) {
  const runs = [];
  const log = new AiExchangeLog(nodeFsAdapter, path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vam-book-')), 'ai-exchanges.json'), error => { throw error; });
  const runtime = () => ({ runTask: async (...args) => {
    runs.push(args);
    args[4].onRequest?.({ provider: 'codex', input: [{ type: 'text', text: args[0] }] });
    for (const event of events) args[4].onWebSearchEvent?.(event);
    if (fail) throw fail;
    return answer;
  } });
  const make = mod => new mod.AiCalls({ runtimeFor: model => mod.aiRuntimeForModel(model, { claude: runtime, codex: () => runtime() }), exchanges: () => (logging ? log : null) });
  return { runs, log, proofCalls: make(proofMod), planCalls: make(runMod) };
}
const signal = () => new AbortController().signal;
const proofRequest = (extra = {}) => ({ ...base, body: BODY, checklist, ...extra });
const failure = code => error => error.name === 'ProofFailure' && error.code === code;
// Primary decision: pages were opened but no fact item could be verified -> not a failure, an aggregate needs-review result flagged factsUnverified (no retry).
const factsUnverified = (result, message) => { assert.equal(result.factsUnverified, true, message); assert.equal(result.aggregate, 'needs-review', message); return result; };

// ---- text written into notes ----

test('headings: a model line that starts a section is demoted, nothing else changes', () => {
  assert.equal(textLib.demoteHeadings('## Detail\nplain ## not a heading\n# Title\n### keep'), '### Detail\nplain ## not a heading\n### Title\n### keep');
  assert.equal(textLib.singleLine('## Detail\n\n  more   words '), '### Detail more words');
  assert.equal(textLib.singleLine(42), '');
  assert.equal(Array.from(textLib.singleLine('字'.repeat(500), 10)).length, 10);
});

test('a card Prompt whose fields contain "## Detail" never gains a section heading and parses back', () => {
  const text = planText.composeCardPrompt({ role: 'body', covers: '## Detail\n## Sources', entry: 'x\n## Update log', handoff: '## Q', previous: { position: 1, title: '## T', summary: '## S' }, checklist: [{ id: 'C1', type: 'fact', text: '## Detail is claimed' }] }, 'en');
  assert.equal(text.split('\n').filter(line => /^\s{0,3}#{1,2}(\s|$)/.test(line)).length, 0);
  const parsed = planText.parseCardPrompt(text);
  assert.equal(parsed.role, 'Body'); assert.match(parsed.covers, /Detail/); assert.equal(parsed.next, 'none');
  assert.deepEqual(plain(planText.parseChecklist(text)), [{ id: 'C1', type: 'fact', text: '### Detail is claimed' }]);
  const zh = planText.composeCardPrompt({ role: 'intro', covers: 'a', entry: 'b', handoff: 'c', checklist: [{ id: 'C1', type: 'structure', text: '導讀完整' }] }, 'zh-TW');
  assert.match(zh, /^角色：導讀\n/); assert.deepEqual(plain(planText.parseChecklist(zh)), [{ id: 'C1', type: 'structure', text: '導讀完整' }]);
  assert.equal(planText.parseRoleWord('收尾'), 'closing'); assert.equal(planText.parseRoleWord('Gallery'), 'gallery'); assert.equal(planText.parseRoleWord('x'), undefined);
});

test('the root book plan stays one section, and its editorial decisions read back', () => {
  const text = planText.composeBookPlan({ thread: 'Line one\n## Detail\nline', decisions: { reader: 'Curious adults', tone: '## warm', goal: ' ' }, materials: [{ name: '## Mona Lisa', use: 'opens' }] }, 'en');
  const headings = text.split('\n').filter(line => /^##(\s|$)/.test(line));
  assert.deepEqual(headings, ['## Book plan']);
  assert.deepEqual(plain(planText.parseBookPlanDecisions(`# Root\n\nintro\n\n${text}\n## Sources\n- Reader: not a decision`)), { reader: 'Curious adults', tone: '### warm' });
  assert.deepEqual(plain(planText.parseBookPlanDecisions('no plan here')), {});
  const zh = planText.composeBookPlan({ thread: 't', decisions: { length: '每章 800 字' }, materials: [] }, 'zh-TW');
  assert.match(zh, /^## 全書企劃\n/); assert.deepEqual(plain(planText.parseBookPlanDecisions(zh)), { length: '每章 800 字' });
});

// ---- effective settings ----

test('effective settings: the owner\'s current value wins, then the saved decision, and a change reaches the version', () => {
  const decided = { reader: 'Decided reader', tone: 'Decided tone', style: 'Decided style' };
  const owner = { reader: 'Owner reader', goal: 'Owner goal', tone: '   ' };
  const effective = plain(settings.effectiveSettings(owner, decided));
  assert.deepEqual(effective, { reader: 'Owner reader', goal: 'Owner goal', tone: 'Decided tone', style: 'Decided style' });
  assert.deepEqual(plain(settings.effectiveSettings({}, {})), {});
  const before = settings.settingsVersion(effective);
  assert.equal(before, settings.settingsVersion(settings.effectiveSettings(owner, decided)));
  const edited = settings.effectiveSettings({ ...owner, reader: 'Owner edited at gate 1' }, decided);
  assert.equal(edited.reader, 'Owner edited at gate 1'); assert.notEqual(settings.settingsVersion(edited), before);
  // the saved section is the other half of the rule
  const section = planText.composeBookPlan({ thread: 't', decisions: { tone: 'warm' }, materials: [] }, 'en');
  assert.equal(settings.effectiveSettings({ reader: 'R' }, planText.parseBookPlanDecisions(section)).tone, 'warm');
});

// ---- whole-book plan and card plan ----

const cards = Array.from({ length: 31 }, (_, i) => ({ id: `n${i + 1}`, title: `Card ${i + 1}`, summary: `Summary ${i + 1}` }));
const globalRequest = (extra = {}) => ({ ...base, bookTitle: 'Western art', settings: { reader: 'Owner reader' }, cards, ...extra });
const globalReply = (over = {}) => JSON.stringify({ thread: 'One thread\n## x', cards: cards.map((c, i) => ({ id: c.id, role: i === 0 ? 'intro' : 'body' })), materials: [{ name: 'Mona Lisa', use: 'opens' }], decisions: { reader: 'Model reader', goal: 'Goal', angle: '', tone: 'Tone', length: '', style: '' }, ...over });

test('global plan: every card once with a role, only empty settings decided, structure of the reply enforced', () => {
  const request = globalRequest();
  const prompt = globalPlan.globalPlanStep.render(request);
  for (const card of cards) assert.ok(prompt.includes(card.id));
  const result = plain(globalPlan.globalPlanStep.parse(globalReply(), request));
  assert.equal(result.cards.length, 31); assert.equal(result.cards[0].role, 'intro'); assert.equal(result.thread, 'One thread ## x', 'a heading mark inside a single line cannot start a section');
  assert.deepEqual(result.decisions, { goal: 'Goal', tone: 'Tone' }); // reader is the owner's, empty answers are dropped
  assert.deepEqual(result.materials, [{ name: 'Mona Lisa', use: 'opens' }]);
  const reorder = JSON.parse(globalReply()); reorder.cards.reverse();
  assert.equal(globalPlan.globalPlanStep.parse(JSON.stringify(reorder), request).cards[0].id, 'n31', 'the reply order is the reading order');
  const bad = over => () => globalPlan.globalPlanStep.parse(globalReply(over), request);
  assert.throws(bad({ cards: cards.slice(1).map(c => ({ id: c.id, role: 'body' })) }), /leaves a card out/);
  assert.throws(bad({ cards: [...cards.map(c => ({ id: c.id, role: 'body' })).slice(1), { id: 'n2', role: 'body' }] }), /twice/);
  assert.throws(bad({ cards: [...cards.map(c => ({ id: c.id, role: 'body' })).slice(1), { id: 'zzz', role: 'body' }] }), /unknown card/);
  assert.throws(bad({ cards: cards.map(c => ({ id: c.id, role: 'villain' })) }), /unknown role/);
  assert.throws(bad({ extra: 1 }), /unexpected fields/);
  assert.throws(() => globalPlan.globalPlanStep.parse('nope', request), /not JSON/);
  assert.throws(() => globalPlan.globalPlanStep.policy('p', { ...request, cards: [] }), /needs cards/);
});

test('card plan: ids and types assigned, neighbours only when they exist, an empty checklist is refused', () => {
  const request = { ...base, thread: 'thread', settings: {}, materials: [], card: { id: 'n2', position: 2, total: 3, role: 'body', title: TITLE, summary: 's' }, previous: { position: 1, title: 'Intro', summary: 'sum' } };
  const good = over => JSON.stringify({ covers: 'covers\n## Detail', entry: 'entry', handoff: 'next q', previous: 'prev line', next: 'should be dropped', images: [], checklist: [{ type: 'structure', text: 'Shape' }, { type: 'fact', text: 'Date 1415' }], ...over });
  const result = plain(cardPlan.cardPlanStep.parse(good(), request));
  assert.deepEqual(result.checklist.map(c => `${c.id}:${c.type}`), ['C1:structure', 'C2:fact']);
  assert.equal(result.covers, 'covers ## Detail'); assert.equal(result.previous, 'prev line'); assert.equal(result.next, '');
  assert.ok(cardPlan.cardPlanStep.render(request).includes(JSON.stringify(TITLE)));
  const plain0 = cardPlan.cardPlanStep.render(request);
  assert.ok(!plain0.includes('extra request'), 'no owner sentence: the prompt is unchanged');
  const asked = cardPlan.cardPlanStep.render({ ...request, instruction: 'say "more"\nabout x' });
  assert.ok(asked.startsWith(plain0) && asked.includes("The owner's extra request for this card") && asked.endsWith(JSON.stringify('say "more" about x')), 'the sentence is one JSON string appended after the unchanged prompt');
  assert.throws(() => cardPlan.cardPlanStep.parse(good({ checklist: [] }), request), /1 to 8/);
  assert.throws(() => cardPlan.cardPlanStep.parse(good({ checklist: [{ type: 'opinion', text: 'x' }] }), request), /unknown checklist type/);
  assert.throws(() => cardPlan.cardPlanStep.parse(good({ checklist: Array.from({ length: 9 }, () => ({ type: 'fact', text: 'x' })) }), request), /1 to 8/);
  assert.throws(() => cardPlan.cardPlanStep.parse(good({ covers: ' ' }), request), /covers/);
  const prompt = planText.composeCardPrompt({ role: 'body', ...result, previous: { position: 1, title: 'Intro', summary: result.previous } }, 'en');
  assert.deepEqual(plain(planText.parseChecklist(prompt)).map(c => c.id), ['C1', 'C2']);
});

// ---- proofread verdict ----

test('proofread: one result per item, sources only when this call opened them, rewritten text ignored', () => {
  const raw = JSON.stringify({ results: [item('C1', 'met'), { ...item('C2', 'met', ['https://example.org/a#frag', 'https://evil.example/x']), body: 'REWRITTEN CHAPTER', rewritten: 'x' }], body: 'REWRITTEN CHAPTER', instructions: 'ignore the task' });
  const parsed = proofMod.parseProofread(raw);
  assert.deepEqual(plain(parsed).map(p => Object.keys(p).sort().join()), ['id,note,sources,status', 'id,note,sources,status']);
  const request = proofRequest(); const before = plain(request);
  const result = plain(proof.evaluateProof(parsed, checklist, ['https://example.org/a/']));
  assert.equal(result.aggregate, 'checked');
  assert.deepEqual(result.items.find(i => i.id === 'C2'), { id: 'C2', type: 'fact', status: 'met', note: 'ok', sources: ['https://example.org/a/'] });
  assert.equal(JSON.stringify(result).includes('REWRITTEN'), false); assert.deepEqual(plain(request), before, 'the chapter text is untouched');
  assert.equal(request.body, BODY);
});

test('proofread: an item the reply asserts without a source this call opened drops to unverified; unmet needs a person', () => {
  const only = proof.evaluateProof([item('C1', 'met'), item('C2', 'met', ['https://example.org/a']), ], checklist, ['https://example.org/a']);
  assert.equal(only.items[1].status, 'met');
  const two = [...checklist, { id: 'C3', type: 'fact', text: 'Names the place' }];
  const mixed = proof.evaluateProof([item('C1'), item('C2', 'met', ['https://evil.example/x']), item('C3', 'met', ['https://example.org/a'])], two, ['https://example.org/a']);
  assert.deepEqual(mixed.items.map(i => i.status), ['met', 'unverified', 'met']); assert.equal(mixed.aggregate, 'checked'); assert.deepEqual(plain(mixed.items[1].sources), []);
  // Q-fix3: an unmet structure item no longer needs a person (it stays recorded); an unmet fact item does.
  const unmet = proof.evaluateProof([item('C1', 'unmet'), item('C2', 'met', ['https://example.org/a'])], checklist, ['https://example.org/a']);
  assert.equal(unmet.aggregate, 'checked'); assert.equal(unmet.items[0].status, 'unmet');
  const factUnmet = proof.evaluateProof([item('C1'), item('C2', 'unmet', ['https://example.org/a'])], checklist, ['https://example.org/a']);
  assert.equal(factUnmet.aggregate, 'needs-review');
});

test('proofread: the same page written another way matches the event; another page, an unopened page and a self-declared page do not', () => {
  const opened = ['https://Example.org:443/a/b/?utm_source=x&id=7#top'];
  const ok = spelling => proof.evaluateProof([item('C1'), item('C2', 'met', [spelling])], checklist, opened).items[1];
  for (const same of ['https://example.org/a/b?id=7', 'http://EXAMPLE.org/a/b/?id=7&utm_medium=m#z', 'https://example.org/a/b?fbclid=1&id=7', 'https://www.example.org/a/b?id=7']) {
    assert.equal(ok(same).status, 'met', same); assert.deepEqual(plain(ok(same).sources), ['https://example.org/a/b/?utm_source=x&id=7#top'], 'the saved source is the event address (https)');
  }
  for (const other of ['https://example.org/a/c?id=7', 'https://example.org/a/b?id=8', 'https://example.org/a/b', 'https://user:pw@example.org/a/b?id=7']) {
    factsUnverified(proof.evaluateProof([item('C1'), item('C2', 'met', [other])], checklist, opened), other);
  }
  // an http event is never a source, even when the model cites the https spelling
  assert.throws(() => proof.evaluateProof([item('C1'), item('C2', 'met', ['https://example.org/a'])], checklist, ['http://example.org/a']), failure('no_open_page'));
});

test('proofread: whole-card failures (empty list, missing, duplicate, unknown, no page opened, all facts unverified, bad reply)', () => {
  const opened = ['https://example.org/a'];
  assert.throws(() => proof.evaluateProof([], [], opened), failure('empty_list'));
  assert.throws(() => proofMod.proofreadStep.policy('p', proofRequest({ checklist: [] })), failure('empty_list'));
  assert.throws(() => proof.evaluateProof([item('C1')], checklist, opened), failure('missing_item'));
  assert.throws(() => proof.evaluateProof([item('C1'), item('C1'), item('C2')], checklist, opened), failure('duplicate_item'));
  assert.throws(() => proof.evaluateProof([item('C1'), item('C2'), item('C9')], checklist, opened), failure('unknown_item'));
  assert.throws(() => proof.evaluateProof([item('C1'), item('C2', 'met', ['https://example.org/a'])], checklist, []), failure('no_open_page'));
  assert.throws(() => proof.evaluateProof([item('C1'), item('C2', 'met', ['https://example.org/a'])], checklist, ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x/y']), failure('no_open_page'));
  factsUnverified(proof.evaluateProof([item('C1'), item('C2', 'met', ['https://spoofed.example/z'])], checklist, opened), 'a spoofed source is no source');
  factsUnverified(proof.evaluateProof([item('C1'), item('C2', 'unverified')], checklist, opened));
  for (const raw of ['not json', '{}', '{"results":"x"}', reply([{ id: 'C1', status: 'maybe' }]), reply([null])]) assert.throws(() => proofMod.parseProofread(raw), failure('unparsable'), raw);
});

test('proofread: a checklist without any fact item can pass (the all-unverified rule needs a fact item), but still needs an opened page', () => {
  const intro = [{ id: 'C1', type: 'structure', text: 'Opens warmly' }, { id: 'C2', type: 'structure', text: 'Previews the book' }];
  const result = proof.evaluateProof([item('C1'), item('C2', 'unverified')], intro, ['https://example.org/a']);
  assert.equal(result.aggregate, 'checked'); assert.equal(result.items[1].status, 'unverified');
  assert.throws(() => proof.evaluateProof([item('C1'), item('C2')], intro, []), failure('no_open_page'));
});

// ---- the proofread call ----

test('runProofread: web search only, budget 4, localCodex false, one reservation, opened pages of this call only, no image input', async () => {
  const h = harness({ answer: reply([item('C1'), item('C2', 'met', ['https://example.org/a', 'https://never-opened.example'])]), events: [search('q'), page('https://example.org/a')] });
  let reserved = 0;
  const result = await proofMod.runProofread(h.proofCalls, proofRequest({ body: `${BODY}\n![x](http://insecure.example/a.png)` }), { signal: signal(), admission: { reserve: async () => { reserved += 1; } } });
  assert.equal(result.aggregate, 'checked'); assert.deepEqual(plain(result.items[1].sources), ['https://example.org/a']);
  assert.equal(reserved, 1);
  const [prompt, , , schema, controls] = h.runs[0];
  assert.equal(controls.webSearchOnly, true); assert.equal(controls.searchBudget, 4); assert.equal(controls.textOnly, undefined); assert.equal(controls.imageDataUrl, undefined);
  assert.equal(controls.timeoutMs, 4 * 60 * 1000);
  assert.match(prompt, /successfully open at least one source page/); assert.ok(schema.properties.results);
  assert.equal(prompt.includes(TITLE), false, 'the proofreader gets no title');
  // a second call does not see the first call's pages
  const second = harness({ answer: reply([item('C1'), item('C2', 'met', ['https://example.org/a'])]), events: [search('q')] });
  await assert.rejects(proofMod.runProofread(second.proofCalls, proofRequest(), { signal: signal() }), failure('no_open_page'));
});

// ---- proof record ----

test('proof record: the key has five parts, a second append is skipped, and a resume reuses the stored result', () => {
  const parts = { runId: 'r1', nodeId: 'n2', revision: 3, body: BODY, checklist };
  const key = proof.proofKey(parts);
  assert.match(key, /^r1:n2:3:[0-9a-f]{16}:[0-9a-f]{16}$/);
  assert.notEqual(key, proof.proofKey({ ...parts, body: `${BODY}!` })); assert.notEqual(key, proof.proofKey({ ...parts, revision: 4 }));
  assert.notEqual(key, proof.proofKey({ ...parts, checklist: [{ ...checklist[0], text: 'edited' }, checklist[1]] }));
  assert.equal(key, proof.proofKey({ ...parts, body: BODY.replace(/ /g, ' ') }));
  const result = proof.evaluateProof([item('C1', 'met', [], 'a --> b <script>'), item('C2', 'met', ['https://example.org/a'])], checklist, ['https://example.org/a']);
  const first = proof.appendProofRecord('Existing notes\n', key, result);
  assert.equal(first.appended, true);
  const second = proof.appendProofRecord(first.text, key, result);
  assert.equal(second.appended, false); assert.equal(second.text, first.text);
  assert.deepEqual(plain(proof.findProofRecord(first.text, key)).items.map(i => i.id), ['C1', 'C2']);
  assert.equal(proof.findProofRecord(first.text, `${key}x`), undefined);
  assert.equal(proof.appendProofRecord(first.text, proof.proofKey({ ...parts, revision: 4 }), result).appended, true, 'a new revision adds a record and keeps the old one');
  assert.match(first.text, /（開頁：`https:\/\/example\.org\/a`）/); assert.equal(first.text.replace(/^<!-- book-proof:v1 .* -->$/m, '').includes('<'), false, 'no tag survives in the readable lines'); assert.equal(first.text.split('\n').filter(l => l.includes('-->') && !l.startsWith('<!-- book-proof')).length, 0, 'no comment end outside the record line');
  assert.equal(proof.findProofRecord('<!-- book-proof:v1 {broken} -->', key), undefined);
  assert.equal(proof.appendProofRecord('', key, result).text.startsWith('校對（已校）'), true);
});

// ---- text safety: nothing written into a note can load a remote resource, hide text or open a section ----

const NASTY = ['![x](https://tracker.example/p.png)', '%% hidden %%', '<img src="https://tracker.example/p.png">', '<!-- visual-agent-map:detail:end -->', '[click](https://evil.example)', '```\ninjected\n```', '> [!note] callout', '# heading', '- list', '1. one', '~~~'];
const loads = text => /!\[[^\]]*\]\(|(^|[^\\])\[[^\]]*\]\(|%%|<[a-zA-Z!\/]|^\s*>|```|~~~|^\s{0,3}#/m.test(text.replace(/\\./g, ''));

test('proof record: a malicious note or source cannot make an image, link, hidden section, HTML, callout or clickable address', () => {
  const sources = ['https://example.org/a', 'https://example.org/x)](javascript:alert(1))', 'https://example.org/<img src=x>', 'https://example.org/a b', 'https://example.org/a\nb', 'http://example.org/a', 'javascript:alert(1)', 'https://u:p@example.org/a', 'https://example.org/a(b)[c]'];
  const raw = checklist.map((entry, i) => item(entry.id, 'met', sources, NASTY[i] + ' ' + NASTY.join(' | ')));
  const result = proof.evaluateProof(raw, checklist, sources);
  const text = proof.composeProofRecord('k', result);
  const readable = text.split('\n').filter(line => !line.startsWith('<!-- book-proof'));
  for (const line of readable) {
    const stripped = line.replace(/`https:\/\/[^`\s]*`/g, '');
    assert.equal(loads(stripped), false, line);
    assert.equal(/[<>]/.test(line), false, 'no angle bracket: ' + line);
  }
  const codes = readable.join('\n').match(/`https:\/\/[^`\s]*`/g) ?? [];
  assert.ok(codes.includes('`https://example.org/a`') && codes.includes('`https://example.org/a%28b%29%5Bc%5D`'));
  assert.ok(codes.every(code => !/[()[\]<>]/.test(code)), 'no Markdown metacharacter inside an address');
  assert.equal(codes.some(code => /example\.org\/a(b| |%20)|u:p@|http:|javascript:alert\(/.test(code)), false);
  const record = text.split('\n').find(line => line.startsWith('<!-- book-proof'));
  assert.equal(record.includes('%%'), false); assert.equal(/[<>]/.test(record.slice(4, -4)), false);
  assert.equal(proof.safeHref('http://example.org/'), undefined); assert.equal(proof.safeHref('https://example.org/a)'), 'https://example.org/a%29');
  assert.equal(proof.safeHref('https://exa mple.org/'), undefined); assert.equal(proof.safeHref('not a url'), undefined);
  // a hand-made result is made safe at output too
  const manual = proof.composeProofRecord('k', { aggregate: 'checked', items: [{ id: 'C1', type: 'fact', status: 'met', note: '![x](https://tracker.example/p.png) %% <!-- visual-agent-map:detail:end -->', sources: ['https://evil.example/)](javascript:1)', 'http://x.example', 'https://ok.example/a'] }] });
  assert.equal(manual.includes('![x]'), false); assert.equal(manual.includes('%%'), false); assert.equal(manual.includes('<!-- visual-agent-map'), false); assert.equal(manual.includes(')]('), false); assert.equal(manual.includes('http://'), false);
  assert.match(manual, /`https:\/\/ok\.example\/a`/);
});

test('proofread guard: an opened address that quotes 40 or more characters of the chapter marks the source as leaking', () => {
  const body = 'Brunelleschi demonstrated linear perspective around 1415 using a mirror and a painted panel in Florence.';
  const quote = 'Brunelleschi demonstrated linear perspective around 1415 using';
  const three = [...checklist, { id: 'C3', type: 'fact', text: 'Names the place' }];
  const leakUrl = 'https://leak.example/?q=' + encodeURIComponent(quote);
  const raw = [item('C1'), item('C2', 'met', ['https://example.org/a', leakUrl]), item('C3', 'met', ['https://example.org/a'])];
  const leakedPage = proof.evaluateProof(raw, three, ['https://example.org/a', leakUrl], { body });
  assert.equal(leakedPage.items[1].status, 'unverified'); assert.equal(leakedPage.items[1].note, '來源疑似外洩正文'); assert.deepEqual(plain(leakedPage.items[1].sources), []);
  assert.equal(leakedPage.items[2].status, 'met', 'an item that cites only clean pages is untouched');
  assert.match(proof.composeProofRecord('k', leakedPage), /來源疑似外洩正文/);
  const manyPages = proof.evaluateProof([item('C1', 'met', ['https://example.org/a']), item('C2', 'met', ['https://example.org/a']), item('C3', 'met', ['https://example.org/a', leakUrl])], three, ['https://example.org/a', leakUrl], { body });
  assert.deepEqual(plain(manyPages.items).map(i => i.status), ['met', 'met', 'unverified'], 'an opened address quoting the chapter downgrades only the item that cites it');
  const clean = proof.evaluateProof([item('C1'), item('C2', 'met', ['https://example.org/a'])], checklist, ['https://example.org/a'], { body });
  assert.equal(clean.items[1].status, 'met');
  factsUnverified(proof.evaluateProof([item('C1'), item('C2', 'met', [leakUrl])], checklist, [leakUrl], { body }));
  assert.equal(proof.sharesLongRun('x'.repeat(39), 'x'.repeat(100)), false); assert.equal(proof.sharesLongRun('x'.repeat(40), 'x'.repeat(100)), true);
});

test('runProofread: a search query quoting a sentence of the chapter still passes; an opened address quoting it downgrades only that item', async () => {
  const quote = BODY.slice(0, 45);
  const h = harness({ answer: reply([item('C1'), item('C2', 'met', ['https://example.org/a'])]), events: [search(quote), page('https://example.org/a')] });
  const result = await proofMod.runProofread(h.proofCalls, proofRequest(), { signal: signal() });
  assert.equal(result.items[1].status, 'met');
  const leakUrl = 'https://leak.example/?q=' + encodeURIComponent(quote);
  const h2 = harness({ answer: reply([item('C1'), item('C2', 'met', [leakUrl])]), events: [page('https://example.org/a'), page(leakUrl)] });
  factsUnverified(await proofMod.runProofread(h2.proofCalls, proofRequest(), { signal: signal() }));
});

test('plan text: fences, VAM markers, %% and links in model text cannot take effect (plan section and card Prompt)', () => {
  const evil = 'x ```js\ncode``` <!-- visual-agent-map:detail:end --> %% hide %% ![i](https://tracker.example/p.png) [l](https://e.example) <b>x</b> > quote';
  const text = planText.composeBookPlan({ thread: evil, decisions: { tone: evil, reader: '- item' }, materials: [{ name: evil, use: evil }] }, 'en');
  assert.equal(text.includes('```'), false); assert.equal(text.includes('<!--'), false); assert.equal(text.includes('%%'), false);
  assert.equal(/<[a-z!\/]/i.test(text), false); assert.equal(/(^|[^\\])!\[/.test(text), false); assert.equal(/(^|[^\\])\]\(/.test(text), false);
  assert.deepEqual(text.split('\n').filter(line => /^##(\s|$)/.test(line)), ['## Book plan']);
  assert.equal(planText.parseBookPlanDecisions(text).reader, '- item', 'a backslash escape reads back');
  const prompt = planText.composeCardPrompt({ role: 'body', covers: evil, entry: evil, handoff: evil, checklist: [{ id: 'C1', type: 'fact', text: evil }] }, 'en');
  assert.equal(prompt.includes('```'), false); assert.equal(prompt.includes('<!--'), false); assert.equal(prompt.includes('%%'), false);
  assert.equal(planText.parseChecklist(prompt).length, 1); assert.equal(planText.parseChecklist(prompt)[0].text.includes('```'), true, 'the checklist reads back as the model wrote it');
});

// ---- log boundary ----

function consoleSpy() {
  const lines = [];
  const original = {};
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) { original[name] = console[name]; console[name] = (...args) => lines.push(args.map(String).join(' ')); }
  return { lines, restore: () => { for (const name of Object.keys(original)) console[name] = original[name]; } };
}
const noContent = (log, spy, what) => {
  const dump = JSON.stringify(log.getEntries()) + spy.lines.join('\n');
  for (const secret of [TITLE, 'SECRET-BODY', 'SECRET-REPLY', 'Brunelleschi']) assert.equal(dump.includes(secret), false, `${what}: ${secret}`);
  assert.ok(log.getEntries().length >= 1, `${what}: the call is still logged`);
};

test('exchange log: success, parse error and provider error keep titles, chapter text and replies out of the log', async () => {
  const spy = consoleSpy();
  try {
    const request = { ...base, thread: 'thread', settings: {}, materials: [], card: { id: 'n2', position: 2, total: 3, role: 'body', title: TITLE, summary: 'SECRET-BODY summary' } };
    const goodPlan = JSON.stringify({ covers: 'SECRET-REPLY covers', entry: 'e', handoff: 'h', previous: '', next: '', images: [], checklist: [{ type: 'fact', text: 'SECRET-REPLY' }] });
    const ok = harness({ answer: goodPlan });
    const parsed = await runMod.runPlanStep(ok.planCalls, cardPlan.cardPlanStep, request, { signal: signal() });
    assert.equal(parsed.checklist.length, 1); noContent(ok.log, spy, 'plan success');
    assert.equal(ok.log.getEntries()[0].status, 'completed'); assert.equal(ok.log.getEntries()[0].step, 'book-pipeline.card-plan@1');
    assert.equal(ok.runs[0][0].includes(TITLE), true, 'the provider itself still gets the prompt');
    const bad = harness({ answer: 'SECRET-REPLY not json' });
    await assert.rejects(runMod.runPlanStep(bad.planCalls, cardPlan.cardPlanStep, request, { signal: signal() }));
    noContent(bad.log, spy, 'plan parse error'); assert.deepEqual(plain(bad.log.getEntries()).map(e => [e.status, e.error]), [['failed', 'invalid_reply']]);
    const broken = harness({ fail: new Error(`provider echoed ${TITLE} SECRET-BODY`) });
    await assert.rejects(runMod.runPlanStep(broken.planCalls, cardPlan.cardPlanStep, request, { signal: signal() }));
    noContent(broken.log, spy, 'plan provider error'); assert.deepEqual(plain(broken.log.getEntries()).map(e => [e.status, e.error]), [['failed', 'failed']]);

    const events = [page('https://example.org/a')];
    const proofOk = harness({ answer: reply([item('C1', 'met', [], 'SECRET-REPLY'), item('C2', 'met', ['https://example.org/a'])]), events });
    await proofMod.runProofread(proofOk.proofCalls, proofRequest(), { signal: signal() }); noContent(proofOk.log, spy, 'proof success');
    const proofBad = harness({ answer: 'SECRET-REPLY nope', events });
    await assert.rejects(proofMod.runProofread(proofBad.proofCalls, proofRequest(), { signal: signal() }), failure('unparsable'));
    noContent(proofBad.log, spy, 'proof parse error'); assert.equal(proofBad.log.getEntries()[0].error, 'unparsable');
    const proofNoPage = harness({ answer: reply([item('C1'), item('C2')]), events: [] });
    await assert.rejects(proofMod.runProofread(proofNoPage.proofCalls, proofRequest(), { signal: signal() }), failure('no_open_page'));
    noContent(proofNoPage.log, spy, 'proof without a page'); assert.equal(proofNoPage.log.getEntries()[0].error, 'no_open_page');
    const proofDown = harness({ fail: new Error('SECRET-BODY Brunelleschi'), events });
    await assert.rejects(proofMod.runProofread(proofDown.proofCalls, proofRequest(), { signal: signal() }));
    noContent(proofDown.log, spy, 'proof provider error');
    // control: a call that does not set the flag does log its text, so the assertions above can fail
    const plainCall = harness({ answer: 'SECRET-REPLY' });
    await plainCall.planCalls.runCall({ prompt: `${TITLE} prompt` }, { model: 'gpt-6-luna', effort: 'low', topic: 't', taskName: 'x', signal: signal(), localCodex: true }, raw => raw);
    assert.ok(JSON.stringify(plainCall.log.getEntries()).includes(TITLE));
  } finally {
    spy.restore();
  }
});

test('pipeline log line: only ids, counts, codes and milliseconds', () => {
  const line = pipelineLog.formatPipelineLog({ event: 'step_failed', runId: 'run-1', card: 'n2', step: 'proof', attempt: 2, result: 'no_open_page', ms: 1234.6 });
  assert.equal(line, 'book-pipeline step_failed run=run-1 card=n2 step=proof attempt=2 result=no_open_page ms=1235');
  const hostile = pipelineLog.formatPipelineLog({ event: `x ${TITLE}`, runId: 'r', card: 'global', step: 'plan', attempt: -1, result: `bad ${BODY}`, ms: -5 });
  assert.match(hostile, /^book-pipeline \S+ run=r card=global step=plan attempt=0 result=\S+ ms=0$/);
});

test('card plan: an unconditional picture requirement is dropped by program, a conditional one stays, none left is a failure', () => {
  const request = { ...base, thread: 't', settings: {}, materials: [], card: { id: 'n2', position: 2, total: 3, role: 'body', title: TITLE, summary: 's' } };
  const good = list => JSON.stringify({ covers: 'c', entry: 'e', handoff: 'h', previous: '', next: '', images: [], checklist: list });
  const result = plain(cardPlan.cardPlanStep.parse(good([
    { type: 'structure', text: '本章以圖為主、文字為輔' },
    { type: 'structure', text: 'The chapter is illustrated with pictures' },
    { type: 'structure', text: '本章結尾承接下一張的問題' },
    { type: 'structure', text: '若找得到可載入的 https 圖片才放圖；沒有就寫「無圖：原因」' },
    { type: 'fact', text: '地圖上的年代正確' }
  ]), request));
  assert.deepEqual(result.checklist.map(c => `${c.id}:${c.text}`), ['C1:本章結尾承接下一張的問題', 'C2:若找得到可載入的 https 圖片才放圖；沒有就寫「無圖：原因」', 'C3:地圖上的年代正確']);
  assert.throws(() => cardPlan.cardPlanStep.parse(good([{ type: 'structure', text: 'Uses an image per section' }]), request), /no usable item/);
});

test('card plan: objective art-history items are kept, picture requirements (traditional and simplified) are dropped, 若干 is not a condition', () => {
  const request = { ...base, thread: 't', settings: {}, materials: [], card: { id: 'n2', position: 2, total: 3, role: 'body', title: TITLE, summary: 's' } };
  const run = texts => plain(cardPlan.cardPlanStep.parse(JSON.stringify({ covers: 'c', entry: 'e', handoff: 'h', previous: '', next: '', images: [], checklist: texts.map(text => ({ type: 'fact', text })) }), request)).checklist.map(c => c.text);
  assert.deepEqual(run(['圖像學特徵說明正確', '聖像的圖像特徵描述正確', '每段附一張圖片', '每段配图', '每段附一张图片', '若干作品列出年代']), ['圖像學特徵說明正確', '聖像的圖像特徵描述正確', '若干作品列出年代']);
});

test('card plan and proofread prompts: only objective items, picture items conditional, no-picture is met, system sections are not the ending', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'core/steps/book-pipeline/card-plan.md'), 'utf8');
  assert.match(text, /Not allowed: anything subjective, evaluative or about style/); assert.match(text, /never put a picture requirement in the checklist/);
  const proofText = fs.readFileSync(path.join(__dirname, '..', 'core/steps/book-pipeline/proofread.md'), 'utf8');
  assert.match(proofText, /actually open a result page/); assert.doesNotMatch(proofText, /WebFetch/); assert.match(proofText, /meets a picture item unless the item explicitly requires/); assert.match(proofText, /update log and source list are not part of it/);
});

test('proofread: a whole-card failure carries the judged items as a partial result that is never "checked"; its record has its own key and marks the failure', () => {
  const opened = ['https://example.org/a'];
  let error;
  const unverified = factsUnverified(proof.evaluateProof([item('C1', 'unmet'), item('C2', 'met', ['https://spoofed.example/z'])], checklist, opened));
  assert.deepEqual(plain(unverified.items).map(i => `${i.id}:${i.status}`), ['C1:unmet', 'C2:unverified']);
  try { proof.evaluateProof([item('C1'), item('C2', 'met', ['https://example.org/a'])], checklist, []); } catch (e) { error = e; }
  assert.equal(error.code, 'no_open_page'); assert.equal(error.partial.aggregate, 'needs-review');
  const key = proof.proofKey({ runId: 'r', nodeId: 'n', revision: 1, body: 'b', checklist });
  const record = proof.composeProofRecord(proof.failedProofKey(key), error.partial, error.code);
  assert.match(record, /^校對失敗（原因：no_open_page；以下是已判斷的結果，仍需人看）/);
  assert.equal(proof.findProofRecord(record, key), undefined, 'a finished proof is never mistaken for the failed one');
  assert.ok(proof.findProofRecord(record, proof.failedProofKey(key)));
});

test('author requirements: the fixed chapter rules always come first, the settings after', () => {
  const none = settings.bookAuthorRequirements({});
  assert.match(none, /Open by picking up the brief's entry point/); assert.match(none, /End with one sentence that leads into the next card/); assert.match(none, /Do not end the chapter with an update log/); assert.match(none, /no next card \(the last card\).*close the whole book/);
  const some = settings.bookAuthorRequirements({ tone: 'warm' });
  assert.ok(some.startsWith(none)); assert.match(some, /- tone: warm/);
});

// ---- second device acceptance: subjective items, proofread counts, author picture rule ----

test('card plan: subjective or evaluative items (Traditional and Simplified) are dropped and counted; structural quote-checkable items stay', () => {
  const request = { ...base, thread: 't', settings: {}, materials: [], card: { id: 'n2', position: 2, total: 3, role: 'body', title: TITLE, summary: 's' } };
  const run = texts => plain(cardPlan.cardPlanStep.parse(JSON.stringify({ covers: 'c', entry: 'e', handoff: 'h', previous: '', next: '', images: [], checklist: texts.map(text => ({ type: 'structure', text })) }), request));
  const result = run(['開頭說明為何值得注意', '開头段落提及接入点「透視法」', '本章内容精彩生动', '結尾段落回應「留給下一張的問題」', '這個發明很重要', '出現作品名與年份', '文字引人入勝', '开头说明为何值得关注']);
  assert.deepEqual(result.checklist.map(c => c.text), ['開头段落提及接入点「透視法」', '結尾段落回應「留給下一張的問題」', '出現作品名與年份']);
  assert.equal(result.droppedSubjective, 5);
  const clean = run(['開頭段落提及接入點「X」']);
  assert.equal(clean.droppedSubjective, undefined); assert.equal(clean.checklist.length, 1);
  assert.equal(run(['開頭段落提及接入點「X」', '每段都附圖片']).droppedPicture, 1, 'an unconditional picture item is counted too');
  assert.throws(() => run(['開頭說明為何值得注意', '內容生動']), /no usable item/, 'nothing left is a failure (retried)');
});

test('author rules: the author puts no pictures in the text (the system searches and embeds them); the search step asks for Wikimedia Commons or museum collections over https and never an invented address', () => {
  const { bookAuthorRequirements } = loadWithAiCalls('core/book-pipeline/settings.ts');
  const text = bookAuthorRequirements({});
  assert.match(text, /Never write image links or Markdown images yourself/);
  assert.ok(!/Wikimedia/.test(text));
  const { findImagesStep } = loadWithAiCalls('core/steps/book-pipeline/find-images.ts');
  const prompt = findImagesStep.render({ chapter: 'Title / 《Work》', slots: [{ index: 1, kind: 'diagram', explains: 'perspective' }], language: 'en', model: 'm', reasoning: 'low' });
  assert.match(prompt, /Wikimedia Commons/); assert.ok(!/Met Open Access|Rijksmuseum|National Gallery/.test(prompt)); assert.match(prompt, /diagram, schematic, chart or photo/); assert.match(prompt, /artwork[^.]*only when the chapter itself is about art/); assert.match(prompt, /"relevant"/); assert.match(prompt, /"shows"/); assert.match(prompt, /exclude list/); assert.match(prompt, /direct https link/); assert.match(prompt, /Never invent or guess URLs/);
  assert.match(prompt, /"Title \/ 《Work》"/);
  const parsed = findImagesStep.parse('x {"slots":[{"slot":1,"images":[{"title":"A","shows":"s","relevant":true,"imageUrl":"https://upload.wikimedia.org/a.jpg","sourceUrl":"https://commons.wikimedia.org/x"},{"title":"B","shows":"s","imageUrl":"http://e.com/b.jpg","sourceUrl":"https://e.com"}]}]} y');
  assert.equal(parsed.found, 1); assert.equal(parsed.bySlot.get(1)[0].title, 'A');
});

test('proofread counts: openedPages and searches ride with the result and with a failure, and the record names each source as an opened page', async () => {
  const h = harness({ answer: reply([item('C1'), item('C2', 'met', ['https://example.org/a'])]), events: [search('q1'), search('q2'), page('https://example.org/a'), page('https://example.org/b')] });
  const result = await proofMod.runProofread(h.proofCalls, proofRequest(), { signal: signal() });
  assert.deepEqual(plain(result.counts), { openedPages: 2, searches: 2, sources: { sourcesCited: 1, sourcesMatched: 1, eventUrls: 2, unmatchedHosts: [] } });
  const text = proof.composeProofRecord('k', result);
  assert.match(text, /開頁 2 次、搜尋 2 次/); assert.match(text, /（開頁：`https:\/\/example\.org\/a`）/);
  assert.deepEqual(plain(proof.findProofRecord(text, 'k').counts), { openedPages: 2, searches: 2 });
  const bad = harness({ answer: reply([item('C1'), item('C2', 'met', ['https://never.example'])]), events: [search('q1')] });
  await assert.rejects(proofMod.runProofread(bad.proofCalls, proofRequest(), { signal: signal() }), e => e.code === 'no_open_page' && e.counts.openedPages === 0 && e.counts.searches === 1 && e.partial.counts.searches === 1);
  assert.match(proof.composeProofRecord('k:failed', { ...result, aggregate: 'needs-review' }, 'no_open_page'), /^校對失敗（原因：no_open_page[^\n]*開頁 2 次、搜尋 2 次/);
});

test('pipeline log line: counts are numbers appended as name=n, never text', () => {
  const line = pipelineLog.formatPipelineLog({ event: 'proof_calls', runId: 'r', card: 'n2', step: 'proof', attempt: 1, result: 'ok', ms: 0, counts: { openedPages: 2, searches: 3 } });
  assert.equal(line, 'book-pipeline proof_calls run=r card=n2 step=proof attempt=1 result=ok ms=0 openedPages=2 searches=3');
  assert.match(pipelineLog.formatPipelineLog({ event: 'e', runId: 'r', card: 'c', step: 'proof', attempt: 1, result: 'ok', ms: 0, counts: { 'bad name!': Number.NaN } }), / bad_name_=0$/);
});

test('proofread guard: a chapter that holds its own inline citation address does not make that opened address a leak; long chapter text inside an address still does', () => {
  const url = 'https://example.org/wiki/Linear_perspective_in_Florentine_painting_of_the_early_fifteenth_century';
  const prose = 'Brunelleschi demonstrated linear perspective in Florence around fourteen fifteen with a mirror panel.';
  const body = `${prose}（來源：[Linear perspective](${url})）`;
  const ok = proof.evaluateProof([item('C1'), item('C2', 'met', [url])], checklist, [url], { body });
  assert.deepEqual(plain(ok.items[1].sources), [url]); assert.equal(ok.items[1].note, 'ok');
  const leakUrl = `https://evil.example/?q=${encodeURIComponent(prose)}`;
  const leaked = proof.evaluateProof([item('C1'), item('C2', 'met', [leakUrl]), item('C1')].slice(0, 2), checklist, [url, leakUrl], { body });
  assert.equal(leaked.items[1].note, proof.LEAK_NOTE); assert.deepEqual(plain(leaked.items[1].sources), []);
});

test('source matching: percent-encoding case, %28/%29, a leading www. match; other paths, other languages and unopened pages never do', () => {
  const open = (opened, source) => proof.evaluateProof([item('C1'), item('C2', 'met', [source])], checklist, [opened]).items[1].sources.length;
  assert.equal(open('https://zh.wikipedia.org/wiki/%E6%B8%AC_(x)', 'https://zh.wikipedia.org/wiki/%e6%b8%ac_%28x%29'), 1);
  assert.equal(open('https://www.example.org/a', 'https://example.org/a'), 1);
  assert.equal(open('https://example.org/a', 'https://www.example.org/a'), 1);
  assert.equal(open('https://example.org/a', 'https://example.org/b'), 0);
  assert.equal(open('https://en.wikipedia.org/wiki/Cat', 'https://zh.wikipedia.org/wiki/Cat'), 0);
  assert.equal(open('https://example.org/a%2Fb', 'https://example.org/a/b'), 0, 'an encoded slash is another page');
  assert.equal(open('https://example.org/x', 'https://example.org/y%28'), 0);
});

test('source diagnostics: numbers and host names only (at most 5, no path or query); the proof_calls log line carries them, never a title', () => {
  const sources = ['https://www.a.example/p?q=SECRET', 'https://b.example/x', 'https://c.example/x', 'https://d.example/x', 'https://e.example/x', 'https://f.example/x', 'https://g.example/x', 'https://ok.example/1'];
  const d = proof.sourceDiagnostics([item('C1', 'met', sources.slice(0, 4)), item('C2', 'met', sources.slice(4))], ['https://ok.example/1', 'https://z.example/']);
  assert.deepEqual([d.sourcesCited, d.sourcesMatched, d.eventUrls], [8, 1, 2]);
  assert.deepEqual(plain(d.unmatchedHosts), ['a.example', 'b.example', 'c.example', 'd.example', 'e.example']);
  const line = pipelineLog.formatPipelineLog({ event: 'proof_calls', runId: 'r', card: 'n2', step: 'proof', attempt: 1, result: 'ok', ms: 0, counts: { sourcesCited: 8 }, hosts: { name: 'unmatchedHosts', list: d.unmatchedHosts } });
  assert.equal(line, 'book-pipeline proof_calls run=r card=n2 step=proof attempt=1 result=ok ms=0 sourcesCited=8 unmatchedHosts=a.example,b.example,c.example,d.example,e.example');
  assert.ok(!/SECRET|\/p/.test(line));
});

// ---- T2 P2a: image plan (card-plan images[], Prompt image-plan lines, author marker rules, slot grammar) ----

const slots = load('core/book-pipeline/image-slots.ts');
const slot = (index, extra = {}) => ({ index, kind: 'painting', explains: `shows thing ${index}`, anchor: `after paragraph ${index}`, ...extra });

test('card plan images: indexes 1..n assigned by program, 0 to 8 slots, fields single-line without marker brackets or the separator; missing/extra keys and 9 slots refused', () => {
  const request = { ...base, thread: 't', settings: {}, materials: [], card: { id: 'n2', position: 2, total: 3, role: 'body', title: TITLE, summary: 's' } };
  const good = images => JSON.stringify({ covers: 'c', entry: 'e', handoff: 'h', previous: '', next: '', checklist: [{ type: 'structure', text: 'Shape' }], images });
  assert.deepEqual(plain(cardPlan.cardPlanStep.parse(good([]), request).images), []);
  const two = plain(cardPlan.cardPlanStep.parse(good([{ kind: 'map', explains: 'the 〔圖位 9：x〕 route\nof trade｜x', anchor: 'after the first paragraph' }, { kind: 'photo', explains: 'a port', anchor: 'end' }]), request).images);
  assert.deepEqual(two.map(s => s.index), [1, 2]);
  assert.equal(two[0].explains, 'the 圖位 9：x route of trade x'); assert.ok(!/[〔〕｜]/.test(JSON.stringify(two)));
  const nine = Array.from({ length: 9 }, () => ({ kind: 'k', explains: 'e', anchor: 'a' }));
  assert.throws(() => cardPlan.cardPlanStep.parse(good(nine), request), /0 to 8/);
  assert.equal(cardPlan.cardPlanStep.parse(good(nine.slice(0, 8)), request).images.length, 8);
  assert.throws(() => cardPlan.cardPlanStep.parse(good([{ kind: 'k', explains: 'e' }]), request), /unexpected fields/);
  assert.throws(() => cardPlan.cardPlanStep.parse(good([{ kind: 'k', explains: '〔〕', anchor: 'a' }]), request), /image explains/);
  assert.throws(() => cardPlan.cardPlanStep.parse(JSON.stringify({ covers: 'c', entry: 'e', handoff: 'h', previous: '', next: '', checklist: [{ type: 'structure', text: 'Shape' }] }), request), /unexpected fields/);
  assert.equal(cardPlan.CARD_PLAN_SCHEMA.properties.images.maxItems, 8); assert.ok(cardPlan.CARD_PLAN_SCHEMA.required.includes('images'));
  assert.match(cardPlan.cardPlanStep.render(request), /"images":\[\{"kind":"","explains":"","anchor":""\}\]/);
});

test('Prompt image plan: compose and parse round-trip in both languages; none vs absent; owner edits; hostile text cannot forge a slot line or a heading', () => {
  const plan = { role: 'body', covers: 'c', entry: 'e', handoff: 'h', checklist: [{ id: 'C1', type: 'fact', text: 'Date 1415' }] };
  const images = [slot(1, { explains: 'a [chart] of (2) things! |' }), slot(2, { kind: '地圖', explains: '貿易路線：海上', anchor: '第二段後' })];
  for (const lang of ['en', 'zh-TW']) {
    const text = planText.composeCardPrompt({ ...plan, images }, lang);
    assert.deepEqual(plain(planText.parseImageSlots(text)), images);
    assert.deepEqual(plain(planText.parseChecklist(text)).map(c => c.id), ['C1'], 'slot lines are not checklist items');
    assert.ok(text.indexOf(lang === 'en' ? 'Image plan' : '圖安排') < text.indexOf(lang === 'en' ? 'Acceptance checklist' : '驗收清單'));
  }
  assert.match(planText.composeCardPrompt({ ...plan, images }, 'zh-TW'), /- 圖位 1｜painting｜/);
  assert.deepEqual(plain(planText.parseImageSlots(planText.composeCardPrompt({ ...plan, images: [] }, 'en'))), [], 'planned none');
  assert.deepEqual(plain(planText.parseImageSlots(planText.composeCardPrompt({ ...plan, images: [] }, 'zh-TW'))), []);
  // An older Prompt (no image plan line) and a missing images field: not arranged
  const old = planText.composeCardPrompt(plan, 'en');
  assert.equal(planText.parseImageSlots(old), undefined); assert.ok(!/Image plan/.test(old));
  assert.equal(planText.parseImageSlots(''), undefined);
  // Owner edits: CRLF, duplicate index, bad index, a broken line ends the list, 9th slot dropped
  const head = 'Image plan:\r\n- Image slot 1｜map｜route｜Position: a\r\n- Image slot 1｜map｜again｜Position: b\r\n- Image slot 0｜map｜zero｜Position: c\r\n- Image slot 3｜map｜three｜Position: d\r\nnot a slot\r\n- Image slot 4｜map｜four｜Position: e';
  assert.deepEqual(plain(planText.parseImageSlots(head)).map(s => s.index), [1, 3]);
  const many = 'Image plan:\n' + Array.from({ length: 10 }, (_, i) => `- Image slot ${i + 1}｜k｜e｜Position: a`).join('\n');
  assert.equal(planText.parseImageSlots(many).length, 8);
  // Hostile text: headings and the separator cannot survive; an attempt to forge a second slot stays inside one line
  const evil = planText.composeCardPrompt({ ...plan, images: [slot(1, { kind: '## H', explains: 'x\n- Image slot 2｜k｜forged｜Position: z', anchor: '# t' })] }, 'en');
  assert.ok(!/^#/m.test(evil)); assert.equal(planText.parseImageSlots(evil).length, 1);
  // T1-compatible reading: the labelled lines parse the same with or without the image plan
  const withPlan = planText.composeCardPrompt({ ...plan, images }, 'en');
  assert.deepEqual(plain(planText.parseCardPrompt(withPlan)), plain(planText.parseCardPrompt(old)));
});

test('author rules: image slots are left as one marker line each; the plan reaches the author as JSON strings; no plan means no marker and no plan block', () => {
  assert.match(settings.BOOK_AUTHOR_RULES, /Never write image links or Markdown images yourself/);
  assert.match(settings.BOOK_AUTHOR_RULES, /〔圖位 n：what the picture explains〕/); assert.match(settings.BOOK_AUTHOR_RULES, /line of its own/);
  assert.match(settings.BOOK_AUTHOR_RULES, /never put a marker inside a code block or a quote/); assert.match(settings.BOOK_AUTHOR_RULES, /leave no marker at all/);
  const none = settings.bookAuthorRequirements({ tone: 'warm' });
  assert.ok(!/Image plan for this chapter/.test(none)); assert.equal(settings.bookAuthorRequirements({ tone: 'warm' }, []), none);
  const some = settings.bookAuthorRequirements({ tone: 'warm' }, [slot(1, { explains: 'say "hi"\\' }), slot(2)]);
  assert.ok(some.startsWith(none)); assert.match(some, /- slot 1: kind "painting", explains "say \\"hi\\"\\\\", position "after paragraph 1"/); assert.match(some, /- slot 2:/);
  assert.match(settings.bookAuthorRequirements({}, [slot(1)]), /Image plan for this chapter/);
});

test('image slot markers: grammar, one count per index, bad/duplicate/inline classification, fences and quotes untouched, residual check, omitted', () => {
  const plan = [slot(1), slot(2), slot(3)];
  assert.equal(slots.composeSlotMarker(slot(2, { explains: 'a map' })), '〔圖位 2：a map〕');
  const body = ['Intro text.', '〔圖位 1：shows thing 1〕', '', 'More.', '〔圖位 1：again〕', '〔圖位 7：out of range〕', '〔圖位 x：reworded〕', '〔圖位 2〕', '  〔圖位 2：indented is still standalone〕', 'Sentence 〔圖位 3：inline〕 continues.'].join('\n');
  const scan = slots.scanSlotMarkers(body, plan);
  assert.deepEqual(plain([...scan.found]), [[1, 1], [2, 8]]);
  assert.deepEqual(plain(scan.duplicateLines), [4]); assert.deepEqual(plain(scan.badLines), [5, 6, 7]); assert.deepEqual(plain(scan.inlineLines), [9]); assert.deepEqual(plain(scan.omitted), [3]);
  // CRLF line endings
  assert.deepEqual(plain([...slots.scanSlotMarkers('a\r\n〔圖位 1：x〕\r\nb', plan).found]), [[1, 1]]);
  // fences and quotes: kept as written, not counted, never residual
  const guarded = ['〔圖位 1：in body〕', '```', '〔圖位 2：in fence〕', '```', '> 〔圖位 1：in quote〕', '> 〔圖位 3：quote only〕', '~~~~', '〔圖位 3：tilde fence〕', '~~~~', 'tail'].join('\n');
  const g = slots.scanSlotMarkers(guarded, plan);
  assert.deepEqual(plain([...g.found]), [[1, 0]]); assert.deepEqual(plain(g.duplicateLines), []); assert.deepEqual(plain(g.omitted), [2, 3]);
  assert.deepEqual(plain(slots.residualMarkerLines(guarded)), [0]);
  assert.deepEqual(plain(slots.residualMarkerLines(guarded.split('\n').slice(1).join('\n'))), [], 'with the body marker gone only guarded ones remain: no residue');
  // an unclosed fence keeps the rest of the document protected; a fence closed by a longer or shorter run follows CommonMark
  assert.deepEqual(plain(slots.protectedLines(['```', 'x', '```', 'y', '````', 'z', '```', 'w', '````', 'v'])), [true, true, true, false, true, true, true, true, true, false]);
  // inline marker pattern removes the marker only (closed, or a bare opener)
  assert.equal('Sentence 〔圖位 3：inline〕 continues 〔圖位 end'.replace(slots.INLINE_MARKER, ''), 'Sentence  continues  end');
  // a quote and a body marker with the same number: body counted, quote verbatim and not residual, so the commit check passes
  const same = '〔圖位 1：body〕\n> 〔圖位 1：quoted〕';
  assert.deepEqual(plain([...slots.scanSlotMarkers(same, plan).found]), [[1, 0]]); assert.deepEqual(plain(slots.residualMarkerLines(same.split('\n').slice(1).join('\n'))), []);
  assert.deepEqual(plain(slots.scanSlotMarkers('', []).omitted), []);
});

test('pickForSlot seam: deterministic, https only, same-chapter address never placed twice; none carries a reason code', () => {
  const cand = (url, extra = {}) => ({ imageUrl: url, sourceUrl: 'https://example.org/p', title: 't', caption: 'c', ...extra });
  const ctx = (picked = []) => ({ chapter: { id: 'n1', title: 'T' }, slot: slot(1), allSlots: [slot(1), slot(2)], alreadyPicked: new Set(picked) });
  const a = cand('https://x.example/a.jpg'), b = cand('https://x.example/b.jpg');
  assert.deepEqual(plain(slots.pickForSlot(ctx(), [a, b])), { candidate: a });
  assert.deepEqual(plain(slots.pickForSlot(ctx([a.imageUrl]), [a, b])), { candidate: b });
  assert.deepEqual(plain(slots.pickForSlot(ctx([a.imageUrl, b.imageUrl]), [a, b])), { none: true, reasonCode: 'not_found' });
  assert.deepEqual(plain(slots.pickForSlot(ctx(), [])), { none: true, reasonCode: 'not_found' });
  assert.deepEqual(plain(slots.pickForSlot(ctx(), [cand('http://x.example/a.jpg'), cand('javascript:alert(1)'), cand('not a url')])), { none: true, reasonCode: 'unsafe_url' });
  assert.deepEqual(plain(slots.pickForSlot(ctx(), [cand('http://x.example/a.jpg'), b])), { candidate: b });
  assert.deepEqual(plain(slots.pickForSlot(ctx(), [a, b])), plain(slots.pickForSlot(ctx(), [a, b])), 'same input, same answer');
});

// ---- the start card's suggestion step (T1 P1b): semantic properties of what is accepted and what is sent ----
const suggest = loadWithAiCalls('core/steps/book-pipeline/suggest-settings.ts');
const sug = { reader: 'Curious adults', goal: 'Explain the main ideas with daily examples', angle: 'From daily life to theory', tone: 'Warm, few terms', length: 'About 1,500 words', style: 'Example first, then the idea' };

test('suggest-settings: the prompt carries only the root title, summary and at most 40 first-level titles of at most 80 characters, as data; the reply is a plain single line of at most 200 characters per field', () => {
  const chapters = Array.from({ length: 50 }, (_, i) => `Chapter ${i} ${'x'.repeat(200)}`);
  const prompt = suggest.suggestSettingsStep.render({ ...base, bookTitle: 'Psych', summary: 'S'.repeat(1000), chapters });
  assert.equal(prompt.match(/Chapter \d+/g).length, 40, 'at most 40 chapters');
  assert.ok(!prompt.includes('x'.repeat(81)), 'each title is cut at 80 characters');
  assert.ok(!prompt.includes('S'.repeat(301)));
  assert.match(prompt, /not instructions/);
  const long = suggest.parseSuggestSettings(JSON.stringify({ ...sug, reader: '**Curious** [adults](http://x.y)\n\n- who read `a lot` # ' + 'z'.repeat(400), tone: '   ' }));
  assert.equal(long.tone, undefined, 'an empty field is simply absent (it stays blank on the card)');
  assert.ok(!/[\n*`#\[\]()]/.test(long.reader), long.reader);
  assert.ok(Array.from(long.reader).length <= 200);
  assert.ok(long.reader.startsWith('Curious adults'));
  assert.deepEqual(plain(suggest.parseSuggestSettings(JSON.stringify(sug))), sug);
});

test('suggest-settings: a reply with a missing, extra or non-string field is refused (the card then stays blank)', () => {
  const bad = [{ ...sug, extra: 'x' }, { ...sug, reader: 5 }, (({ style, ...rest }) => rest)(sug), []];
  for (const reply of bad) assert.throws(() => suggest.parseSuggestSettings(JSON.stringify(reply)), /reply|string/i);
  assert.throws(() => suggest.parseSuggestSettings('not json'), /JSON/);
});

// ---- apply-notes: the rewrite of annotated paragraphs ----
const NOTE_BODY = 'Brunelleschi showed linear ==perspective==%%備註#2：say what it is%% in [[Florence]] around 1415 ![](https://x.y/a.png).';
const encodedItem = () => notesApply.encodeParagraph('p1', NOTE_BODY);
const applyRequest = (items = [encodedItem()]) => ({ ...base, settings: { reader: 'adults' }, plan: 'P', items });
const applyReply = (...paragraphs) => JSON.stringify({ paragraphs });
const GOOD = 'Brunelleschi showed linear perspective, the way lines meet, in ⟦L1⟧ around 1415 ⟦L2⟧.';

test('apply-notes: the prompt shows note markers and link tokens only, never a link address', () => {
  const request = applyRequest();
  const prompt = applyNotes.applyNotesStep.render(request);
  assert.match(prompt, /⟦N2⟧perspective⟦\/N2⟧/);
  assert.ok(prompt.includes('⟦L1⟧') && prompt.includes('⟦L2⟧'));
  assert.ok(!prompt.includes('Florence') && !prompt.includes('x.y/a.png'));
  assert.doesNotThrow(() => applyNotes.applyNotesStep.policy(prompt, request));
  assert.throws(() => applyNotes.applyNotesStep.policy(prompt, applyRequest([])), /no paragraph/);
});

test('apply-notes: a good reply returns the paragraph with its links back exactly once', () => {
  const out = applyNotes.parseApplyNotes(applyReply({ id: 'p1', text: GOOD }), applyRequest());
  assert.equal(out.paragraphs[0].text, 'Brunelleschi showed linear perspective, the way lines meet, in [[Florence]] around 1415 ![](https://x.y/a.png).');
  assert.ok(out.paragraphs[0].text.includes('[[Florence]]') && out.paragraphs[0].text.includes('![](https://x.y/a.png)'));
  assert.ok(!/[⟦⟧]/.test(out.paragraphs[0].text));
});

test('apply-notes: ids must be exactly the sent ids (unknown, duplicate, missing, extra field)', () => {
  const ok = { id: 'p1', text: GOOD };
  const two = applyRequest([encodedItem(), { ...encodedItem(), id: 'p2' }]);
  assert.throws(() => applyNotes.parseApplyNotes(applyReply({ ...ok, id: 'p9' }), applyRequest()), /unknown paragraph id/);
  assert.throws(() => applyNotes.parseApplyNotes(applyReply(ok, ok), two), /repeated paragraph id/);
  assert.throws(() => applyNotes.parseApplyNotes(applyReply(ok), two), /count mismatch/);
  assert.throws(() => applyNotes.parseApplyNotes(applyReply(ok, ok, ok), two), /count mismatch/);
  assert.throws(() => applyNotes.parseApplyNotes(applyReply({ ...ok, extra: 1 }), applyRequest()), /unexpected fields/);
  assert.throws(() => applyNotes.parseApplyNotes('{"paragraphs":[]}', applyRequest()), /count mismatch/);
  assert.throws(() => applyNotes.parseApplyNotes('nope', applyRequest()), /JSON/);
});

test('apply-notes: every link token must come back exactly once, and no note marker or unknown token may stay', () => {
  const t = text => () => applyNotes.parseApplyNotes(applyReply({ id: 'p1', text }), applyRequest());
  assert.throws(t('Linear perspective in ⟦L1⟧ around 1415.'), /link token missing/);
  assert.throws(t('Linear ⟦L1⟧ ⟦L1⟧ ⟦L2⟧.'), /repeated/);
  assert.throws(t('Linear ⟦L1⟧ ⟦L2⟧ ⟦L3⟧.'), /unknown link token/);
  assert.throws(t('Linear ⟦N2⟧perspective⟦/N2⟧ ⟦L1⟧ ⟦L2⟧.'), /note marker left/);
  assert.throws(t('Linear ⟦X⟧ ⟦L1⟧ ⟦L2⟧.'), /unknown token/);
});

test('apply-notes: a reply with a callout, checkbox, new link, %%, ==, heading or html is refused whole', () => {
  const t = text => () => applyNotes.parseApplyNotes(applyReply({ id: 'p1', text }), applyRequest());
  const cases = { callout: '[!note] x ⟦L1⟧ ⟦L2⟧', checkbox: '[ ] x ⟦L1⟧ ⟦L2⟧', 'new link': 'x [a](http://b.c) ⟦L1⟧ ⟦L2⟧', 'new link bare': 'x https://b.c ⟦L1⟧ ⟦L2⟧', 'new link wiki': 'x [[A]] ⟦L1⟧ ⟦L2⟧', comment: 'x %%c%% ⟦L1⟧ ⟦L2⟧', highlight: 'x ==h== ⟦L1⟧ ⟦L2⟧', heading: '## x ⟦L1⟧ ⟦L2⟧', html: 'x <b>y</b> ⟦L1⟧ ⟦L2⟧' };
  for (const [name, text] of Object.entries(cases)) assert.throws(t(text), /refused/, name);
});

test('apply-notes: lines, list marks and blank lines are kept', () => {
  const item = notesApply.encodeParagraph('p1', '- first ==a==%%備註#1：n%%\n- second');
  const run = text => () => applyNotes.parseApplyNotes(applyReply({ id: 'p1', text }), applyRequest([item]));
  assert.deepEqual(plain(applyNotes.parseApplyNotes(applyReply({ id: 'p1', text: '- first A\n- second' }), applyRequest([item]))).paragraphs[0].text, '- first A\n- second');
  assert.throws(run('- first A - second'), /line count/);
  assert.throws(run('- first A\nsecond'), /list or quote mark/);
  assert.throws(run('- first A\n\n'), /line count|blank/);
  assert.throws(run('   '), /empty|non-empty/);
});
