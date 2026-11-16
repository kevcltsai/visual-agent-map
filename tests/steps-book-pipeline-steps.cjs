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
  const good = over => JSON.stringify({ covers: 'covers\n## Detail', entry: 'entry', handoff: 'next q', previous: 'prev line', next: 'should be dropped', checklist: [{ type: 'structure', text: 'Shape' }, { type: 'fact', text: 'Date 1415' }], ...over });
  const result = plain(cardPlan.cardPlanStep.parse(good(), request));
  assert.deepEqual(result.checklist.map(c => `${c.id}:${c.type}`), ['C1:structure', 'C2:fact']);
  assert.equal(result.covers, 'covers ## Detail'); assert.equal(result.previous, 'prev line'); assert.equal(result.next, '');
  assert.ok(cardPlan.cardPlanStep.render(request).includes(JSON.stringify(TITLE)));
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
  const unmet = proof.evaluateProof([item('C1', 'unmet'), item('C2', 'met', ['https://example.org/a'])], checklist, ['https://example.org/a']);
  assert.equal(unmet.aggregate, 'needs-review');
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
  assert.throws(() => proof.evaluateProof([item('C1'), item('C2', 'met', ['https://spoofed.example/z'])], checklist, opened), failure('all_facts_unverified'), 'a spoofed source is no source');
  assert.throws(() => proof.evaluateProof([item('C1'), item('C2', 'unverified')], checklist, opened), failure('all_facts_unverified'));
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
  assert.match(first.text, /（`https:\/\/example\.org\/a`）/); assert.equal(first.text.replace(/^<!-- book-proof:v1 .* -->$/m, '').includes('<'), false, 'no tag survives in the readable lines'); assert.equal(first.text.split('\n').filter(l => l.includes('-->') && !l.startsWith('<!-- book-proof')).length, 0, 'no comment end outside the record line');
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
  assert.throws(() => proof.evaluateProof([item('C1'), item('C2', 'met', [leakUrl])], checklist, [leakUrl], { body }), failure('all_facts_unverified'));
  assert.equal(proof.sharesLongRun('x'.repeat(39), 'x'.repeat(100)), false); assert.equal(proof.sharesLongRun('x'.repeat(40), 'x'.repeat(100)), true);
});

test('runProofread: a search query quoting a sentence of the chapter still passes; an opened address quoting it downgrades only that item', async () => {
  const quote = BODY.slice(0, 45);
  const h = harness({ answer: reply([item('C1'), item('C2', 'met', ['https://example.org/a'])]), events: [search(quote), page('https://example.org/a')] });
  const result = await proofMod.runProofread(h.proofCalls, proofRequest(), { signal: signal() });
  assert.equal(result.items[1].status, 'met');
  const leakUrl = 'https://leak.example/?q=' + encodeURIComponent(quote);
  const h2 = harness({ answer: reply([item('C1'), item('C2', 'met', [leakUrl])]), events: [page('https://example.org/a'), page(leakUrl)] });
  await assert.rejects(proofMod.runProofread(h2.proofCalls, proofRequest(), { signal: signal() }), failure('all_facts_unverified'));
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
    const goodPlan = JSON.stringify({ covers: 'SECRET-REPLY covers', entry: 'e', handoff: 'h', previous: '', next: '', checklist: [{ type: 'fact', text: 'SECRET-REPLY' }] });
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
  const good = list => JSON.stringify({ covers: 'c', entry: 'e', handoff: 'h', previous: '', next: '', checklist: list });
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

test('card plan and proofread prompts: only objective items, picture items conditional, no-picture is met, system sections are not the ending', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'core/steps/book-pipeline/card-plan.md'), 'utf8');
  assert.match(text, /Not allowed: anything subjective or about style/); assert.match(text, /never require pictures/);
  const proofText = fs.readFileSync(path.join(__dirname, '..', 'core/steps/book-pipeline/proofread.md'), 'utf8');
  assert.match(proofText, /WebFetch/); assert.match(proofText, /meets a picture item unless the item explicitly requires/); assert.match(proofText, /update log and source list are not part of it/);
});

test('proofread: a whole-card failure carries the judged items as a partial result that is never "checked"; its record has its own key and marks the failure', () => {
  const opened = ['https://example.org/a'];
  let error;
  try { proof.evaluateProof([item('C1', 'unmet'), item('C2', 'met', ['https://spoofed.example/z'])], checklist, opened); } catch (e) { error = e; }
  assert.equal(error.code, 'all_facts_unverified');
  assert.deepEqual(plain(error.partial.items).map(i => `${i.id}:${i.status}`), ['C1:unmet', 'C2:unverified']);
  assert.equal(error.partial.aggregate, 'needs-review');
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
  assert.match(none, /Open by picking up the brief's entry point/); assert.match(none, /End with one sentence that leads into the next card/); assert.match(none, /Do not end the chapter with an update log/);
  const some = settings.bookAuthorRequirements({ tone: 'warm' });
  assert.ok(some.startsWith(none)); assert.match(some, /- tone: warm/);
});
