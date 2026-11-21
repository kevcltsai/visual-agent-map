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
const prose = load('core/book-pipeline/prose-checks.ts');
const noteSections = load('core/book-pipeline/note-sections.ts');
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
  const request = { ...base, thread: 'thread', settings: {}, materials: [], chapters: [{ place: 'preface', title: 'Intro' }, { place: 'chapter 1', title: 'Chapter two' }, { place: 'chapter 2', title: 'Outro' }], card: { id: 'n2', kind: 'chapter', chapter: 1, role: 'body', title: TITLE, summary: 's' }, previous: { position: 1, title: 'Intro', summary: 'sum' } };
  const good = over => JSON.stringify({ points: ['p1', 'p2', 'p3'], covers: 'covers\n## Detail', entry: 'entry', handoff: 'next q', previous: 'prev line', next: 'should be dropped', images: [], checklist: [{ type: 'structure', text: 'Shape' }, { type: 'fact', text: 'Date 1415' }], ...over });
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
  assert.equal(unmet.aggregate, 'needs-review', 'T10a: the only structure point unmet = all unmet'); assert.equal(unmet.items[0].status, 'unmet');
  const partly = proof.evaluateProof([item('C1', 'unmet'), item('C2', 'met', ['https://example.org/a']), item('C3', 'met')], [{ id: 'C1', type: 'structure', text: 'a' }, { id: 'C3', type: 'structure', text: 'b' }, checklist[1]].map((c, i) => ({ ...c, id: ['C1', 'C3', 'C2'][i] })), ['https://example.org/a']);
  assert.equal(partly.aggregate, 'needs-review', 'any unmet structure point needs a person (live re-verify: checked with structure unmet)');
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

// ---- the whole-book checks (names, research voice, repetition) ----

test('prose checks: research-voice phrases in zh-TW, zh-CN and English are found; ordinary prose is not', () => {
  assert.deepEqual(plain(prose.researchVoiceHits('本次搜尋未取得蘭格的原始底片資料。')), ['本次搜尋', '搜尋未取得']);
  assert.deepEqual(plain(prose.researchVoiceHits('根據搜尋結果，她在 1936 年拍下這張照片。')), ['搜尋結果', '根據搜尋']);
  assert.deepEqual(plain(prose.researchVoiceHits('本次检索没有找到。')), ['本次检索']);
  assert.deepEqual(plain(prose.researchVoiceHits('As of my search, no print survives.')), ['my search']);
  assert.deepEqual(plain(prose.researchVoiceHits('她在研究光線，也搜尋街頭的瞬間。Light shapes the face.')), []);
  assert.deepEqual(plain(prose.researchVoiceHits('')), []);
});

test('prose checks (live v4): citation-style vague sources are research voice (「推廣單位建議」, 「農業改良場的資料指出」, 「有資料指出」); a named study or record is not', () => {
  const hit = text => plain(prose.researchVoiceHits(text));
  assert.deepEqual(hit('美國多所大學推廣單位（如內布拉斯加大學）也建議，容器一定要有足夠的排水孔。'), ['推廣單位（如內布拉斯加大學）也建議']);
  assert.deepEqual(hit('威斯康辛大學推廣單位建議，像番茄、甜椒、茄子這類長得大的蔬菜。'), ['推廣單位建議']);
  assert.deepEqual(hit('台灣農業改良場的資料指出，幼苗 3 到 4 片本葉期，根系發育完整。'), ['資料指出']);
  assert.deepEqual(hit('有資料指出，小白菜覆土約 0.3 到 0.5 公分。'), ['有資料指出']);
  assert.deepEqual(hit('有衛教文章建議把葉片攤開吹乾。'), ['有衛教文章建議']);
  assert.deepEqual(hit('也有論文指出，排水層會讓整體保水量上升。'), ['有論文指出']);
  assert.deepEqual(hit('研究指出，番茄喜光。'), ['研究指出']);
  assert.deepEqual(hit('根據資料，台北年均溫 23 度。'), ['根據資料']);
  assert.deepEqual(hit('有资料指出，小白菜覆土很浅。'), ['有资料指出']);
  assert.deepEqual(hit('推广单位建议每天浇水。'), ['推广单位建议']);
  assert.deepEqual(hit('Some sources say tomatoes need sun.'), ['some sources say']);
  assert.deepEqual(hit('According to the data, tomatoes need sun.'), ['according to the data']);
  assert.deepEqual(hit('Research shows that tomatoes need sun.'), ['research shows']);
  for (const text of ['哈佛大學 2019 年的研究指出，番茄喜光。', '根據氣象局資料，台北年均溫 23 度。', '把照片存進資料夾和資料庫。', '她在研究光線。', 'A 2019 Harvard study shows tomatoes need sun.', '推廣這種做法的人很多。'])
    assert.deepEqual(hit(text), [], text);
});

test('prose checks (live v5): the vague attributions the v5 run missed are research voice (說過, 旁證, 不同來源給的／寫的, 依園藝資料, 以栽培資料為準, 改良場介紹); ordinary prose with the same words is not', () => {
  const hit = text => plain(prose.researchVoiceHits(text));
  assert.deepEqual(hit('美國華盛頓州立大學、伊利諾大學的推廣單位都說過類似的觀念。'), ['單位都說過']);
  assert.deepEqual(hit('美國馬里蘭大學推廣單位的容器蔬菜表也列出相近的數字，可以當作旁證。'), ['當作旁證']);
  assert.deepEqual(hit('不同來源給的最低盆量不完全一樣。'), ['不同來源給的']);
  assert.deepEqual(hit('不同來源寫的天數略有差異。'), ['不同來源寫的']);
  assert.deepEqual(hit('不同來源的數字略有出入，有的甚至寫到十到十二小時。'), ['不同來源的數字']);
  assert.deepEqual(hit('依園藝資料，有些品種寫得更長。'), ['依園藝資料']);
  assert.deepEqual(hit('小白菜的天數以家庭栽培資料為準。'), ['以家庭栽培資料為準']);
  assert.deepEqual(hit('桃園區農業改良場介紹葉菜類的育苗移植時，也是把幼苗育到3到4片本葉。'), ['改良場介紹']);
  for (const text of ['我們在前一章說過，土要鬆。', '老師說過要多澆水。', '不同來源的水質差很多。', '把照片依資料夾分類。', '以實際觀察為準。', '改良場位於桃園。', '他手上有旁證。'])
    assert.deepEqual(hit(text), [], text);
});

test('prose checks: the V1 note quotes the offending sentences and every note is in the note language (zh-TW, zh-CN, en); an intro that previews a later chapter too much makes R1 unmet', () => {
  const items = ['N1', 'V1', 'R1'].map(id => ({ id, type: 'structure', status: 'met', note: '', sources: [] }));
  const result = { aggregate: 'checked', items };
  const body = '番茄要曬太陽。至於一天中什麼時候採，現有資料不足，我沒有查到可靠的官方建議。桃樂絲・蘭格拍過農場。';
  const titles = ['多蘿西婭・蘭格'];
  const note = (language, id) => prose.applyProseChecks(result, body, titles, { language }).items.find(item => item.id === id).note;
  assert.equal(note('zh-TW', 'V1'), '刪除或改寫這些研究、處理過程口吻的句子（直接寫事實，來源放在「來源」）：「至於一天中什麼時候採，現有資料不足，我沒有查到可靠的官方建議。」');
  assert.equal(note('zh-TW', 'N1'), '人名請照章名的寫法：「桃樂絲・蘭格」→「多蘿西婭・蘭格」');
  // A Simplified Chinese interface writes its notes in the note language (zh-TW), like every other proof line.
  assert.equal(note('zh-CN', 'V1'), note('zh-TW', 'V1'));
  assert.match(note('en', 'V1'), /^Remove or rewrite these sentences in research or process voice/);
  assert.match(prose.applyProseChecks(result, body, titles).items[1].note, /^Remove or rewrite/, 'no language: English');
  for (const language of ['zh-TW', 'zh-CN']) assert.doesNotMatch(note(language, 'V1') + note(language, 'N1'), /[A-Za-z]{3,}/, language);
  // Intro (live v4): a section per later chapter, or more than two sentences naming one, is too much preview.
  const others = ['家庭菜園入門', '土壤與容器準備', '播種與育苗', '採收與保存'];
  const intro = ['我的陽台能不能種菜？接下來依序是土壤與容器準備、播種與育苗、採收與保存。', '', '### 土壤與容器：預告裡沒講完的小細節', '', '盆的材質。', '', '播種與育苗要淺覆土。播種與育苗要保濕。播種與育苗要移植。'].join('\n');
  assert.deepEqual(plain(prose.introPreviewHits(intro, others.slice(1))), ['土壤與容器準備', '播種與育苗']);
  const judged = prose.applyProseChecks(result, intro, others, { language: 'zh-TW', role: 'intro', title: '家庭菜園入門' });
  const r1 = judged.items.find(item => item.id === 'R1');
  assert.equal(r1.status, 'unmet');
  assert.equal(r1.note, '導讀章只做導覽，每個後續章節最多預告一兩句；這些章節預告過多：〈土壤與容器準備〉〈播種與育苗〉');
  assert.equal(judged.aggregate, 'needs-review');
  // One or two sentences each is a guide; a body chapter is not checked for previews.
  assert.equal(prose.applyProseChecks(result, intro.split('\n')[0], others, { role: 'intro', title: '家庭菜園入門' }), result);
  assert.equal(prose.applyProseChecks(result, intro, others, { role: 'body', title: '家庭菜園入門' }), result);
});

test('prose checks (live v6): a reader-visible [!note]/[!question] box under the Sources is in V1\'s scope; the pipeline\'s vam-* boxes and boxes in the chapter text are not read twice', () => {
  const detail = [
    '澆水要看土。',
    '',
    '> [!tip] 提示',
    '> 早上澆。',
    '',
    '### 來源',
    '',
    '- [農業部](https://example.org)',
    '',
    '> [!note]- 待確認事項',
    '> 現有資料不足：蚜蟲的處理方法，搜尋結果沒有找到直接的官方來源。',
    '',
    '> [!question] 問題',
    '> 小白菜「30 天」屬一般經驗值，本次未取得台灣在地權威來源逐項佐證。',
    '',
    '> [!question] 待確認',
    '> 小番茄從播種到首次採收「三個月以上」未找到可直接引用的來源。',
    '',
    '> [!vam-book]- 研究備註',
    '> 搜尋結果：無'
  ].join('\n');
  const body = noteSections.chapterBody(detail);
  assert.doesNotMatch(body, /待確認事項/, 'the Sources section (and its box) is not chapter text');
  const notes = noteSections.readerCallouts(detail);
  assert.match(notes, /^\[!note\]- 待確認事項\n現有資料不足/);
  assert.match(notes, /本次未取得台灣在地權威來源/);
  assert.match(notes, /未找到可直接引用的來源/);
  assert.doesNotMatch(notes, /研究備註|早上澆/);
  assert.equal(noteSections.readerCallouts('澆水要看土。'), '');
  const items = ['V1'].map(id => ({ id, type: 'structure', status: 'met', note: '', sources: [] }));
  const result = { aggregate: 'checked', items };
  assert.equal(prose.applyProseChecks(result, body, []), result, 'without the boxes V1 stays met (the v6 miss)');
  const judged = prose.applyProseChecks(result, body, [], { language: 'zh-TW', readerNotes: notes });
  assert.equal(judged.items[0].status, 'unmet');
  for (const quote of ['搜尋結果沒有找到', '本次未取得台灣在地權威來源', '未找到可直接引用的來源']) assert.match(judged.items[0].note, new RegExp(quote));
  // Prose about a source that is not process voice stays clean.
  assert.deepEqual(plain(prose.researchVoiceHits('他終於找到水源。')), []);
});

test('prose checks: a dotted person name that shares a chapter title\'s family name but not its spelling is a variant (live run: 桃樂絲・蘭格, 理察・艾維頓, 歐文・潘)', () => {
  const titles = ['多蘿西婭・蘭格', '理查・艾維頓', '艾文・潘', '尤瑟夫・卡許', '羅伯特・卡帕', '亨利・卡蒂埃-布列松', '技法與器材'];
  const body = '攝影師桃樂絲・蘭格拍下移民母親；理察・艾維頓的白底肖像與歐文・潘的角落肖像，都和卡什一樣講究光。';
  assert.deepEqual(plain(prose.nameVariantHits(body, titles)), [
    { variant: '桃樂絲・蘭格', title: '多蘿西婭・蘭格' },
    { variant: '理察・艾維頓', title: '理查・艾維頓' },
    { variant: '歐文・潘', title: '艾文・潘' }
  ]);
  // The title's own spelling (any middle dot), a shared given name of another person, and a hyphenated family name spelled right are no hit.
  assert.deepEqual(plain(prose.nameVariantHits('多蘿西婭·蘭格與羅伯特・法蘭克，還有亨利・卡蒂埃-布列松。', titles)), []);
  assert.deepEqual(plain(prose.nameVariantHits('亨利・卡帝爾-布列松', ['亨利・卡蒂埃-布列松'])), []);
  assert.deepEqual(plain(prose.nameVariantHits('昂利・卡蒂埃-布列松', ['亨利・卡蒂埃-布列松'])), [{ variant: '昂利・卡蒂埃-布列松', title: '亨利・卡蒂埃-布列松' }]);
  // English titles are not checked by program; an empty body or list finds nothing.
  assert.deepEqual(plain(prose.nameVariantHits('Dorothy Lange', ['Dorothea Lange'])), []);
  assert.deepEqual(plain(prose.nameVariantHits('', titles)), []);
});

test('runProofread: the chapter list and covers lines reach the prompt; a program hit makes N1 or V1 unmet over the model\'s met and the chapter needs review; R1 unmet from the model needs review too', async () => {
  const list = [...checklist, ...prose.BOOK_CHECKS];
  const chapters = [{ title: '多蘿西婭・蘭格', covers: '移民母親與紀實攝影' }, { title: '大師作品參考', covers: '十位大師一覽' }];
  const body = `${BODY} 桃樂絲・蘭格的作品；本次搜尋未取得原始底片。`;
  const allMet = [item('C1'), item('C2', 'met', ['https://example.org/a']), item('N1'), item('V1'), item('R1')];
  const h = harness({ answer: reply(allMet), events: [search('q'), page('https://example.org/a')] });
  const result = await proofMod.runProofread(h.proofCalls, proofRequest({ body, checklist: list, title: '大師作品參考', chapters }), { signal: signal() });
  const [prompt] = h.runs[0];
  assert.ok(prompt.includes(JSON.stringify(chapters)), 'the chapter list with covers lines');
  assert.ok(prompt.includes('this chapter\'s title is "大師作品參考"'));
  for (const id of ['N1', 'V1', 'R1']) assert.ok(prompt.includes(`"id":"${id}"`));
  assert.equal(result.aggregate, 'needs-review');
  const by = id => result.items.find(entry => entry.id === id);
  assert.equal(by('N1').status, 'unmet'); assert.match(by('N1').note, /「桃樂絲・蘭格」→「多蘿西婭・蘭格」/);
  assert.equal(by('V1').status, 'unmet'); assert.match(by('V1').note, /^Remove or rewrite these sentences in research or process voice .*: 「桃樂絲・蘭格的作品；本次搜尋未取得原始底片。」$/);
  assert.equal(by('R1').status, 'met');
  // A clean chapter with the model's met stays checked; the model's R1 unmet alone needs review.
  const clean = harness({ answer: reply(allMet), events: [search('q'), page('https://example.org/a')] });
  assert.equal((await proofMod.runProofread(clean.proofCalls, proofRequest({ checklist: list, chapters }), { signal: signal() })).aggregate, 'checked');
  const repeat = harness({ answer: reply([...allMet.slice(0, 4), item('R1', 'unmet', [], 'The window-light exercise is taught again')]), events: [search('q'), page('https://example.org/a')] });
  assert.equal((await proofMod.runProofread(repeat.proofCalls, proofRequest({ checklist: list, chapters }), { signal: signal() })).aggregate, 'needs-review');
  // Any unmet point, a plan's own structure point included, needs review (live re-verify: "structure unmet: C4" ended checked).
  assert.equal(proof.proofVerdict({ items: [{ id: 'C1', type: 'structure', status: 'unmet' }, { id: 'C3', type: 'structure', status: 'met' }] }), 'needs-review');
  assert.equal(proof.proofVerdict({ items: [{ id: 'V1', type: 'structure', status: 'unmet' }, { id: 'C3', type: 'structure', status: 'met' }] }), 'needs-review');
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
  // v6fix2: 「已校」 only when nothing is left unresolved (length, pictures); the label of a stored record follows the chapter as it is now.
  assert.match(proof.composeProofRecord(key, result, undefined, undefined, true), /^校對（有問題要你看）/);
  assert.match(proof.composeProofRecord(key, result, undefined, undefined, false), /^校對（已校）/);
  assert.match(proof.composeProofRecord(key, { ...result, aggregate: 'needs-review' }, undefined, undefined, true), /^校對（需人看）/);
  const open = proof.composeProofRecord(key, result, undefined, undefined, true);
  assert.match(proof.relabelProofRecord(`x\n> ${open}`, false), /> 校對（已校）/);
  assert.match(proof.relabelProofRecord(proof.composeProofRecord(key, result), true), /^校對（有問題要你看）/);
  assert.equal(proof.relabelProofRecord('> 校對（需人看）', true), '> 校對（需人看）');
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
    const request = { ...base, thread: 'thread', settings: {}, materials: [], chapters: [{ place: 'preface', title: 'Intro' }, { place: 'chapter 1', title: 'Chapter two' }, { place: 'chapter 2', title: 'Outro' }], card: { id: 'n2', kind: 'chapter', chapter: 1, role: 'body', title: TITLE, summary: 'SECRET-BODY summary' } };
    const goodPlan = JSON.stringify({ points: ['p1', 'p2', 'p3'], covers: 'SECRET-REPLY covers', entry: 'e', handoff: 'h', previous: '', next: '', images: [], checklist: [{ type: 'fact', text: 'SECRET-REPLY' }] });
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
  const request = { ...base, thread: 't', settings: {}, materials: [], chapters: [{ place: 'preface', title: 'Intro' }, { place: 'chapter 1', title: 'Chapter two' }, { place: 'chapter 2', title: 'Outro' }], card: { id: 'n2', kind: 'chapter', chapter: 1, role: 'body', title: TITLE, summary: 's' } };
  const good = list => JSON.stringify({ points: ['p1', 'p2', 'p3'], covers: 'c', entry: 'e', handoff: 'h', previous: '', next: '', images: [], checklist: list });
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
  const request = { ...base, thread: 't', settings: {}, materials: [], chapters: [{ place: 'preface', title: 'Intro' }, { place: 'chapter 1', title: 'Chapter two' }, { place: 'chapter 2', title: 'Outro' }], card: { id: 'n2', kind: 'chapter', chapter: 1, role: 'body', title: TITLE, summary: 's' } };
  const run = texts => plain(cardPlan.cardPlanStep.parse(JSON.stringify({ points: ['p1', 'p2', 'p3'], covers: 'c', entry: 'e', handoff: 'h', previous: '', next: '', images: [], checklist: texts.map(text => ({ type: 'fact', text })) }), request)).checklist.map(c => c.text);
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
  assert.match(none, /Open with this chapter's own scene, question or claim/); assert.match(none, /Do not open by recapping or pointing back to the previous chapter/); assert.match(none, /never cards/); assert.match(none, /End with one sentence that leads into the next chapter/); assert.match(none, /Do not end the chapter with an update log/); assert.match(none, /no next chapter \(the last card\).*close the whole book/); assert.match(none, /what the later chapters show together and why/);
  const some = settings.bookAuthorRequirements({ tone: 'warm' });
  assert.ok(some.startsWith(none)); assert.match(some, /- tone: warm/);
  assert.doesNotMatch(none, /The whole book's chapters/, 'no chapter list when none is given');
  const book = settings.bookAuthorRequirements({}, [], [{ title: 'A', covers: 'a "x"' }, { title: 'B', covers: 'b', current: true }]);
  assert.match(book, /The whole book's chapters in reading order/);
  assert.match(book, /- 1: "A" covers "a \\"x\\""/); assert.match(book, /- 2 \(this chapter\): "B" covers "b"/);
});

// ---- second device acceptance: subjective items, proofread counts, author picture rule ----

test('card plan: subjective or evaluative items (Traditional and Simplified) are dropped and counted; structural quote-checkable items stay', () => {
  const request = { ...base, thread: 't', settings: {}, materials: [], chapters: [{ place: 'preface', title: 'Intro' }, { place: 'chapter 1', title: 'Chapter two' }, { place: 'chapter 2', title: 'Outro' }], card: { id: 'n2', kind: 'chapter', chapter: 1, role: 'body', title: TITLE, summary: 's' } };
  const run = texts => plain(cardPlan.cardPlanStep.parse(JSON.stringify({ points: ['p1', 'p2', 'p3'], covers: 'c', entry: 'e', handoff: 'h', previous: '', next: '', images: [], checklist: texts.map(text => ({ type: 'structure', text })) }), request));
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
  const parsed = findImagesStep.parse('x {"slots":[{"slot":1,"images":[{"title":"A","shows":"s","relevant":true,"imageUrl":"https://upload.wikimedia.org/a.jpg","sourceUrl":"https://commons.wikimedia.org/wiki/File:A.jpg"},{"title":"B","shows":"s","imageUrl":"http://e.com/b.jpg","sourceUrl":"https://e.com"}]}]} y');
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

test('card plan images: indexes 1..n assigned by program, 0 to 8 slots (cut to 8 without an owner count, refused past 12), fields single-line without marker brackets or the separator; missing/extra keys refused', () => {
  const request = { ...base, thread: 't', settings: {}, materials: [], chapters: [{ place: 'preface', title: 'Intro' }, { place: 'chapter 1', title: 'Chapter two' }, { place: 'chapter 2', title: 'Outro' }], card: { id: 'n2', kind: 'chapter', chapter: 1, role: 'body', title: TITLE, summary: 's' } };
  const good = images => JSON.stringify({ points: ['p1', 'p2', 'p3'], covers: 'c', entry: 'e', handoff: 'h', previous: '', next: '', checklist: [{ type: 'structure', text: 'Shape' }], images });
  assert.deepEqual(plain(cardPlan.cardPlanStep.parse(good([]), request).images), []);
  const two = plain(cardPlan.cardPlanStep.parse(good([{ kind: 'map', explains: 'the 〔圖位 9：x〕 route\nof trade｜x', anchor: 'after the first paragraph' }, { kind: 'photo', explains: 'a port', anchor: 'end' }]), request).images);
  assert.deepEqual(two.map(s => s.index), [1, 2]);
  assert.equal(two[0].explains, 'the 圖位 9：x route of trade x'); assert.ok(!/[〔〕｜]/.test(JSON.stringify(two)));
  const nine = Array.from({ length: 9 }, () => ({ kind: 'k', explains: 'e', anchor: 'a' }));
  assert.equal(cardPlan.cardPlanStep.parse(good(nine), request).images.length, 8);
  assert.throws(() => cardPlan.cardPlanStep.parse(good(Array.from({ length: 13 }, () => nine[0])), request), /0 to 12/);
  assert.throws(() => cardPlan.cardPlanStep.parse(good([{ kind: 'k', explains: 'e' }]), request), /unexpected fields/);
  assert.throws(() => cardPlan.cardPlanStep.parse(good([{ kind: 'k', explains: '〔〕', anchor: 'a' }]), request), /image explains/);
  assert.throws(() => cardPlan.cardPlanStep.parse(JSON.stringify({ points: ['p1', 'p2', 'p3'], covers: 'c', entry: 'e', handoff: 'h', previous: '', next: '', checklist: [{ type: 'structure', text: 'Shape' }] }), request), /unexpected fields/);
  assert.equal(cardPlan.CARD_PLAN_SCHEMA.properties.images.maxItems, 12); assert.ok(cardPlan.CARD_PLAN_SCHEMA.required.includes('images'));
  assert.match(cardPlan.cardPlanStep.render(request), /"images":\[\{"kind":"","explains":"","anchor":"","search":\["",""\]\}\]/);
});

test('card plan images: each slot asks for 2 to 4 English search terms; kept cleaned (no separator, Latin only, at most 4), and a slot without them still parses', () => {
  const request = { ...base, thread: 't', settings: {}, materials: [], chapters: [{ place: 'preface', title: 'Intro' }, { place: 'chapter 1', title: 'Chapter two' }, { place: 'chapter 2', title: 'Outro' }], card: { id: 'n2', kind: 'chapter', chapter: 1, role: 'body', title: TITLE, summary: 's' } };
  const good = images => JSON.stringify({ points: ['p1', 'p2', 'p3'], covers: 'c', entry: 'e', handoff: 'h', previous: '', next: '', checklist: [{ type: 'structure', text: 'Shape' }], images });
  const search = cardPlan.CARD_PLAN_SCHEMA.properties.images.items.properties.search;
  assert.equal(search.minItems, 2); assert.equal(search.maxItems, 4); assert.ok(cardPlan.CARD_PLAN_SCHEMA.properties.images.items.required.includes('search'));
  assert.match(cardPlan.cardPlanStep.render(request), /search \(2 to 4 English search terms for a Wikimedia Commons file search/);
  const [one, two, three] = plain(cardPlan.cardPlanStep.parse(good([
    { kind: 'painting', explains: '蒙娜麗莎', anchor: 'a', search: ['Mona Lisa', 'Leonardo, da Vinci', '蒙娜麗莎', 'mona lisa', 'Louvre', 'Salai', 'Florence'] },
    { kind: 'photo', explains: 'e', anchor: 'a' },
    { kind: 'photo', explains: 'e', anchor: 'a', search: 'not a list' }
  ]), request).images);
  assert.deepEqual(one.search, ['Mona Lisa', 'Leonardo da Vinci', 'Louvre', 'Salai'], 'no comma, no Han-only term, no repeat, at most 4');
  assert.equal(two.search, undefined, 'a slot without search terms is kept');
  assert.equal(three.search, undefined);
  assert.throws(() => cardPlan.cardPlanStep.parse(good([{ kind: 'k', explains: 'e', anchor: 'a', search: [], extra: 1 }]), request), /unexpected fields/);
});

test('Prompt image plan: search terms ride on the slot line (both languages) and come back; an older line without them parses as before', () => {
  const plan = { role: 'body', covers: 'c', entry: 'e', handoff: 'h', checklist: [{ id: 'C1', type: 'fact', text: 'Date 1415' }] };
  const images = [slot(1, { search: ['Mona Lisa', 'Leonardo da Vinci'] }), slot(2, { kind: '地圖', explains: '貿易路線：海上', anchor: '第二段後', search: ['Silk Road map', 'trade_route [old]'] }), slot(3)];
  for (const lang of ['en', 'zh-TW']) {
    const text = planText.composeCardPrompt({ ...plan, images }, lang);
    assert.deepEqual(plain(planText.parseImageSlots(text)), images);
  }
  assert.match(planText.composeCardPrompt({ ...plan, images }, 'zh-TW'), /- 圖位 1｜painting｜shows thing 1｜位置：after paragraph 1｜英文搜尋詞：Mona Lisa, Leonardo da Vinci\n/);
  assert.match(planText.composeCardPrompt({ ...plan, images }, 'en'), /- Image slot 1｜painting｜shows thing 1｜Position: after paragraph 1｜Search terms: Mona Lisa, Leonardo da Vinci\n/);
  assert.match(planText.composeCardPrompt({ ...plan, images }, 'en'), /- Image slot 3｜painting｜shows thing 3｜Position: after paragraph 3\n/, 'no search part without terms');
  // Old format (before search terms) and an owner's hand edit
  const old = '圖安排：\n- 圖位 1｜照片｜盆底的排水孔｜位置：第二段後\n- 圖位 2｜示意圖｜碎石層｜位置：結尾';
  assert.deepEqual(plain(planText.parseImageSlots(old)), [{ index: 1, kind: '照片', explains: '盆底的排水孔', anchor: '第二段後' }, { index: 2, kind: '示意圖', explains: '碎石層', anchor: '結尾' }]);
  const edited = 'Image plan:\r\n- Image slot 1｜photo｜a pot｜Position: end｜Search terms: flower pot,  drainage hole ,,只有中文\r\n- Image slot 2｜photo｜x｜Position: y｜Search terms:';
  assert.deepEqual(plain(planText.parseImageSlots(edited)), [{ index: 1, kind: 'photo', explains: 'a pot', anchor: 'end', search: ['flower pot', 'drainage hole'] }, { index: 2, kind: 'photo', explains: 'x', anchor: 'y' }]);
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
  // Owner edits: CRLF, duplicate index, bad index, a broken line ends the list, slots past the 12 ceiling dropped
  const head = 'Image plan:\r\n- Image slot 1｜map｜route｜Position: a\r\n- Image slot 1｜map｜again｜Position: b\r\n- Image slot 0｜map｜zero｜Position: c\r\n- Image slot 3｜map｜three｜Position: d\r\nnot a slot\r\n- Image slot 4｜map｜four｜Position: e';
  assert.deepEqual(plain(planText.parseImageSlots(head)).map(s => s.index), [1, 3]);
  const many = 'Image plan:\n' + Array.from({ length: 14 }, (_, i) => `- Image slot ${i + 1}｜k｜e｜Position: a`).join('\n');
  assert.equal(planText.parseImageSlots(many).length, 12);
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
  // a search-terms segment the author copied from the plan into the marker (all three languages) still matches the slot
  for (const seg of ['｜英文搜尋詞：Mona Lisa, Leonardo', '｜英文搜索词：Mona Lisa', '｜Search terms: Mona Lisa, Leonardo']) assert.deepEqual(plain([...slots.scanSlotMarkers('a\n〔圖位 1：x' + seg + '〕\nb', plan).found]), [[1, 1]], seg);
  assert.deepEqual(plain([...slots.scanSlotMarkers('a\n〔圖位 1：x〕｜英文搜尋詞：a, b\nb', plan).found]), [[1, 1]], 'segment after the marker');
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
  const t = text => plain(applyNotes.parseApplyNotes(applyReply({ id: 'p1', text }), applyRequest()));
  assert.match(t('Linear perspective in ⟦L1⟧ around 1415.').refused[0].reason, /link token missing/);
  assert.match(t('Linear ⟦L1⟧ ⟦L1⟧ ⟦L2⟧.').refused[0].reason, /repeated/);
  assert.match(t('Linear ⟦L1⟧ ⟦L2⟧ ⟦L3⟧.').refused[0].reason, /unknown link token/);
  assert.match(t('Linear ⟦N2⟧perspective⟦/N2⟧ ⟦L1⟧ ⟦L2⟧.').refused[0].reason, /note marker left/);
  assert.match(t('Linear ⟦X⟧ ⟦L1⟧ ⟦L2⟧.').refused[0].reason, /unknown token/);
});

test('apply-notes: a reply with a callout, checkbox, new link, %%, ==, heading or html is refused (skipped, not fatal)', () => {
  const t = text => plain(applyNotes.parseApplyNotes(applyReply({ id: 'p1', text }), applyRequest()));
  const cases = { callout: '[!note] x ⟦L1⟧ ⟦L2⟧', checkbox: '[ ] x ⟦L1⟧ ⟦L2⟧', 'new link': 'x [a](http://b.c) ⟦L1⟧ ⟦L2⟧', 'new link bare': 'x https://b.c ⟦L1⟧ ⟦L2⟧', 'new link wiki': 'x [[A]] ⟦L1⟧ ⟦L2⟧', comment: 'x %%c%% ⟦L1⟧ ⟦L2⟧', highlight: 'x ==h== ⟦L1⟧ ⟦L2⟧', heading: '## x ⟦L1⟧ ⟦L2⟧', html: 'x <b>y</b> ⟦L1⟧ ⟦L2⟧' };
  for (const [name, text] of Object.entries(cases)) assert.equal(t(text).refused.length, 1, name);
});

test('apply-notes: lines, list marks and blank lines are kept', () => {
  const item = notesApply.encodeParagraph('p1', '- first ==a==%%備註#1：n%%\n- second');
  const run = text => plain(applyNotes.parseApplyNotes(applyReply({ id: 'p1', text }), applyRequest([item]))).refused[0]?.reason ?? '';
  assert.deepEqual(plain(applyNotes.parseApplyNotes(applyReply({ id: 'p1', text: '- first A\n- second' }), applyRequest([item]))).paragraphs[0].text, '- first A\n- second');
  assert.match(run('- first A - second'), /line count/);
  assert.match(run('- first A\nsecond'), /list or quote mark/);
  assert.match(run('- first A\n\n'), /line count|blank/);
  assert.throws(() => run('   '), /empty|non-empty/);
});

test('verdict reducer: any unmet point (some structure points included) or an empty chapter is needs-review (also for a stored checked result); all met stays checked', () => {
  const r = (...statuses) => ({ aggregate: 'checked', items: statuses.map(([type, status], i) => ({ type, status, id: `C${i + 1}` })) });
  assert.equal(proof.proofVerdict(r(['structure', 'unmet'], ['structure', 'unmet'], ['fact', 'met'])), 'needs-review');
  assert.equal(proof.proofVerdict(r(['structure', 'unmet'], ['structure', 'met'], ['fact', 'met'])), 'needs-review');
  assert.equal(proof.proofVerdict(r(['structure', 'met'], ['structure', 'met'], ['fact', 'met'])), 'checked');
  assert.equal(proof.proofVerdict(r(['structure', 'met'], ['fact', 'met']), true), 'needs-review');
  assert.equal(proof.proofVerdict(r(['structure', 'met'], ['fact', 'unmet'])), 'needs-review');
  assert.equal(proof.proofVerdict({ ...r(['structure', 'met']), aggregate: 'needs-review' }), 'needs-review');
  const all = proof.evaluateProof([item('C1', 'unmet'), item('C2', 'met', ['https://example.org/a'])], checklist, ['https://example.org/a']);
  assert.equal(all.aggregate, 'needs-review', 'a new proof goes through the same reducer');
});

// ---- T10c: child cards in the card plan, chapter titles in the global plan (Bug4) ----
const { estimateTokens } = load('ai/context-builder.ts');
const planBase = (over = {}) => ({ ...base, thread: 'thread', settings: {}, materials: [], chapters: [{ place: 'preface', title: 'Intro' }, { place: 'chapter 1', title: 'Two' }], card: { id: 'n2', kind: 'chapter', chapter: 1, role: 'body', title: 'Two', summary: 's' }, ...over });
const kids = (n, make = i => ({ title: `Kid ${i + 1}`, summary: `Kid summary ${i + 1}` })) => Array.from({ length: n }, (_, i) => make(i));
const childBlock = prompt => { const at = prompt.indexOf('Child cards of this chapter (JSON array):\n'); return at < 0 ? null : JSON.parse(prompt.slice(at + 'Child cards of this chapter (JSON array):\n'.length).split('\n\n')[0]); };

test('T10c card plan: 9 child cards give 9 entries in order and say all are listed; no child cards give no child block', () => {
  const fitted = cardPlan.fitCardPlan(planBase({ children: kids(9) }));
  assert.equal(fitted.shown, 9); assert.equal(fitted.total, 9);
  const block = childBlock(fitted.prompt);
  assert.deepEqual(block.map(c => c.title), kids(9).map(c => c.title));
  assert.match(fitted.prompt, /All of this chapter's child cards are listed/);
  for (const request of [planBase(), planBase({ children: [] })]) {
    const prompt = cardPlan.cardPlanStep.render(request);
    assert.ok(!prompt.includes('Child cards of this chapter') && !prompt.includes('not listed here'));
    assert.equal(cardPlan.fitCardPlan(request).shown, 0);
  }
});

test('T10c card plan: 40 and 41 child cards; many long cards are trimmed to the token cap with the "more child cards are not listed" note', () => {
  const small = { title: 'K', summary: 'k' };
  assert.equal(cardPlan.fitCardPlan(planBase({ children: kids(40, () => small) })).shown, 40);
  assert.equal(cardPlan.fitCardPlan(planBase({ children: kids(41, () => small) })).shown, 41, 'a short list is not cut by count');
  const long = i => ({ title: `T${i}`.padEnd(80, '題'), summary: '摘'.repeat(200) });
  const fitted = cardPlan.fitCardPlan(planBase({ children: kids(120, long) }));
  assert.ok(fitted.shown > 0 && fitted.shown < 120, `shown ${fitted.shown}`);
  assert.equal(fitted.total, 120);
  assert.match(fitted.prompt, new RegExp(`${120 - fitted.shown} more child cards are not listed here`));
  assert.equal(childBlock(fitted.prompt).length, fitted.shown);
  assert.deepEqual(childBlock(fitted.prompt).map(c => c.title), kids(fitted.shown, long).map(c => c.title).map(t => t.slice(0, 80)), 'the first ones, in order');
  const childTokens = estimateTokens(fitted.prompt) - estimateTokens(cardPlan.cardPlanStep.render(planBase()));
  assert.ok(childTokens <= cardPlan.CHILD_CARDS_TOKENS + 200, `child block ${childTokens} tokens`);
});

test('T10c card plan: long child titles are cut at 80 and summaries at 200 characters (Chinese counted by character)', () => {
  const fitted = cardPlan.fitCardPlan(planBase({ children: [{ title: '題'.repeat(300), summary: '摘'.repeat(500) }] }));
  const [entry] = childBlock(fitted.prompt);
  assert.equal(Array.from(entry.title).length, cardPlan.CHILD_TITLE_MAX); assert.equal(cardPlan.CHILD_TITLE_MAX, 80);
  assert.equal(Array.from(entry.summary).length, cardPlan.CHILD_SUMMARY_MAX); assert.equal(cardPlan.CHILD_SUMMARY_MAX, 200);
});

test('T10c card plan: near the 32,000-token budget the child cards go first; a chapter list that does not fit refuses the step and is never cut', () => {
  const chaptersOf = (n, len) => Array.from({ length: n }, (_, i) => ({ place: `chapter ${i + 1}`, title: `${i}`.padEnd(len, '章') }));
  const roomy = planBase({ chapters: chaptersOf(100, 20), children: kids(60, i => ({ title: `T${i}`.padEnd(80, '題'), summary: '摘'.repeat(200) })) });
  const alone = cardPlan.fitCardPlan({ ...roomy, children: [] });
  const withKids = cardPlan.fitCardPlan(roomy);
  assert.ok(alone && withKids);
  // a chapter list that leaves only a little room: the children are trimmed to it and the whole request stays inside the budget
  let n = 100; let tight;
  while (n < 5000) { const request = planBase({ chapters: chaptersOf(n, 40), children: roomy.children }); const f = cardPlan.fitCardPlan(request); if (f && f.shown < 60) { tight = { request, f }; break; } n += 25; }
  assert.ok(tight, 'a list size exists where children are trimmed but the step still fits');
  assert.ok(estimateTokens(tight.f.prompt + JSON.stringify(cardPlan.CARD_PLAN_SCHEMA)) <= 32000);
  assert.equal(JSON.parse(tight.f.prompt.match(/\[\{"place":"chapter 1","title".*?\}\]/s)[0].replace(/\n.*/s, '')).length, n, 'every chapter is still listed');
  // too many chapters: refused, not shortened
  const huge = planBase({ chapters: chaptersOf(3000, 200), children: kids(3) });
  assert.equal(cardPlan.cardPlanFits(huge), false);
  assert.equal(cardPlan.fitCardPlan(huge), undefined);
  assert.throws(() => cardPlan.cardPlanStep.policy(cardPlan.cardPlanStep.render(huge), huge), /chapter list is too long/);
  assert.ok(cardPlan.cardPlanStep.render(huge).includes(`"place":"chapter 3000"`), 'render never drops a chapter');
});

test('T10c card plan: a legal chapter past the cut point is still in the chapter list', () => {
  const chapters = Array.from({ length: 400 }, (_, i) => ({ place: `chapter ${i + 1}`, title: `Chapter ${i + 1}` }));
  const request = planBase({ chapters, card: { id: 'n9', kind: 'chapter', chapter: 400, role: 'body', title: 'Last', summary: 's' }, children: kids(120, i => ({ title: `T${i}`.padEnd(80, '題'), summary: '摘'.repeat(200) })) });
  const fitted = cardPlan.fitCardPlan(request);
  assert.ok(fitted.shown < 120, 'the children were cut');
  assert.ok(fitted.prompt.includes('"place":"chapter 400","title":"Chapter 400"'));
  assert.ok(fitted.prompt.includes('"place":"chapter 1","title":"Chapter 1"'));
  const parsed = cardPlan.cardPlanStep.parse(JSON.stringify({ points: ['p1', 'p2', 'p3'], covers: 'c', entry: 'e', handoff: 'h', previous: '', next: '', images: [], checklist: [{ type: 'structure', text: 'Shape' }] }), request);
  assert.ok(parsed);
});

test('T10c global plan: child titles ride per card with moreChildren, only with children is the rule line added, and the 3,000-token cap cuts in reading order', () => {
  const plainPrompt = globalPlan.globalPlanStep.render(globalRequest());
  assert.ok(!plainPrompt.includes('moreChildren') && !plainPrompt.includes('"children"'), 'no children: unchanged prompt');
  const withKids = globalRequest({ cards: cards.map((c, i) => (i === 1 ? { ...c, children: ['Kid A', 'Kid B'] } : c)) });
  const prompt = globalPlan.globalPlanStep.render(withKids);
  assert.match(prompt, /"children":\["Kid A","Kid B"\]/);
  assert.ok(!/"moreChildren":/.test(prompt), 'all titles listed: no count of unlisted ones');
  assert.match(prompt, /"moreChildren" counts titles that are not listed/);
  const many = globalRequest({ cards: cards.map((c, i) => (i < 2 ? { ...c, children: Array.from({ length: 400 }, (_, k) => `${i}-${k}`.padEnd(80, '題')) } : c)) });
  const big = globalPlan.globalPlanStep.render(many);
  const entries = JSON.parse(big.match(/\[\{"id":"n1".*\}\]/s)[0].split('\n')[0]);
  assert.ok(estimateTokens(big) - estimateTokens(plainPrompt) <= globalPlan.GLOBAL_CHILD_TOKENS + 500);
  assert.ok(entries[0].children.length > 0 && entries[0].moreChildren > 0, 'the first card is cut, the count of the rest is kept');
  assert.equal(entries[0].children.length + entries[0].moreChildren, 400);
  assert.equal(entries[1].children, undefined, 'once the cap is hit later cards list none');
  assert.equal(entries[1].moreChildren, 400);
  assert.equal(entries[0].children[0], '0-0'.padEnd(80, '題'));
  const longTitle = globalPlan.globalPlanStep.render(globalRequest({ cards: [{ ...cards[0], children: ['題'.repeat(300)] }] }));
  assert.ok(longTitle.includes(`"${'題'.repeat(80)}"`) && !longTitle.includes('題'.repeat(81)));
});

test('rerun fix 3: card and global plan prompts number chapters only from the authoritative list and never number a non-listed topic', () => {
  const card = cardPlan.cardPlanStep.render(planBase());
  assert.match(card, /Number chapters only from this list: chapter n is the entry whose place is "chapter n"; the preface and the sections never get a chapter number\./);
  assert.match(card, /never gets a chapter number and is never announced as a chapter/);
  const global = globalPlan.globalPlanStep.render(globalRequest());
  assert.match(global, /Number chapters only from this list: chapter n is the card whose place says chapter n; keep the places as given/);
  assert.match(global, /never give a chapter number to, preview or announce as a chapter a topic that is not a card/);
});

// ---- book-chapter-plan P2: content headings (points) and the neighbour lines by card kind ----
const pointsReply = points => JSON.stringify({ covers: 'c', points, entry: 'e', handoff: 'h', previous: '', next: '', images: [], checklist: [{ type: 'structure', text: 'Shape' }] });

test('A5 card plan points: two are refused, seven are cut to six, one line each of at most 40 characters, "·" written as "・", empty ones do not count', () => {
  const request = planBase();
  assert.throws(() => cardPlan.cardPlanStep.parse(pointsReply(['a', 'b']), request), /points/);
  assert.throws(() => cardPlan.cardPlanStep.parse(pointsReply(['a', 'b', '  ', '']), request), /points/, 'blank items do not count');
  assert.throws(() => cardPlan.cardPlanStep.parse(JSON.stringify({ covers: 'c', entry: 'e', handoff: 'h', previous: '', next: '', images: [], checklist: [{ type: 'structure', text: 'Shape' }] }), request), undefined, 'points are required');
  const seven = cardPlan.cardPlanStep.parse(pointsReply(['1', '2', '3', '4', '5', '6', '7']), request);
  assert.deepEqual(plain(seven.points), ['1', '2', '3', '4', '5', '6']);
  const odd = cardPlan.cardPlanStep.parse(pointsReply(['a · b', 'x\ny', '題'.repeat(60)]), request);
  assert.deepEqual(plain(odd.points.slice(0, 2)), ['a ・ b', 'x y']);
  assert.equal(Array.from(odd.points[2]).length, 40);
  assert.ok(cardPlan.CARD_PLAN_SCHEMA.required.includes('points'));
});

test('A5 card plan Prompt: the 內容標題 / Content headings line is written after covers and read back; a Prompt without it reads as undefined', () => {
  const plan = { role: 'body', covers: 'c', points: ['Dome', 'Light · shade', 'Workshops'], entry: 'e', handoff: 'h', checklist: [{ id: 'C1', type: 'fact', text: 'Date 1415' }] };
  const zh = planText.composeCardPrompt(plan, 'zh-TW');
  const en = planText.composeCardPrompt(plan, 'en');
  assert.match(zh, /^本章會講：c\n內容標題：Dome · Light ・ shade · Workshops\n接入點：/m);
  assert.match(en, /^Content headings: Dome · Light ・ shade · Workshops$/m);
  assert.deepEqual(plain(planText.parseCardPoints(zh)), ['Dome', 'Light ・ shade', 'Workshops']);
  assert.deepEqual(plain(planText.parseCardPoints(en)), ['Dome', 'Light ・ shade', 'Workshops']);
  const old = planText.composeCardPrompt({ ...plan, points: undefined }, 'zh-TW');
  assert.equal(planText.parseCardPoints(old), undefined);
  assert.equal(planText.parseCardPrompt(zh).covers, 'c', 'covers stays');
});

test('A6 neighbour lines: chapter labels with the preface before chapter 1; section labels without numbers; 無 when none; English labels', () => {
  const base = { role: 'body', covers: 'c', entry: 'e', handoff: 'h', checklist: [{ id: 'C1', type: 'structure', text: 'x' }] };
  const first = planText.composeCardPrompt({ ...base, kind: 'chapter', previous: { position: 'preface', title: 'Intro', summary: 's1' }, next: { position: 2, title: 'Two', summary: 's2' } }, 'zh-TW');
  assert.match(first, /^上一章：\(前言\) Intro — s1$/m);
  assert.match(first, /^下一章：\(2\) Two — s2$/m);
  const last = planText.composeCardPrompt({ ...base, kind: 'chapter', previous: { position: 1, title: 'One', summary: 's' } }, 'en');
  assert.match(last, /^Previous chapter: \(1\) One — s$/m);
  assert.match(last, /^Next chapter: none$/m);
  assert.match(planText.composeCardPrompt({ ...base, kind: 'chapter', previous: { position: 'preface', title: 'Intro', summary: '' } }, 'en'), /^Previous chapter: \(Preface\) Intro$/m);
  const section = planText.composeCardPrompt({ ...base, kind: 'section', parent: { position: 2, title: 'Two' }, next: { title: 'S2', summary: 'after' } }, 'zh-TW');
  assert.match(section, /^所屬章：\(2\) Two$/m);
  assert.match(section, /^前一節：無$/m);
  assert.match(section, /^後一節：S2 — after$/m);
  const sectionEn = planText.composeCardPrompt({ ...base, kind: 'section', parent: { position: 2, title: 'Two' }, previous: { title: 'S1', summary: 'before' } }, 'en');
  assert.match(sectionEn, /^Chapter: \(2\) Two$/m);
  assert.match(sectionEn, /^Previous section: S1 — before$/m);
  assert.match(sectionEn, /^Next section: none$/m);
});

test('A6 parseCardPrompt reads the new labels, the old 前一張 / 後一張 (zh, en) and the parent line under the same keys', () => {
  const parsed = planText.parseCardPrompt('角色：本文\n所屬章：(2) Two\n前一節：S1 — a\n後一節：無');
  assert.equal(parsed.parent, '(2) Two'); assert.equal(parsed.previous, 'S1 — a'); assert.equal(parsed.next, '無');
  assert.equal(planText.parseCardPrompt('上一章：(前言) I — x\n下一章：(2) T').previous, '(前言) I — x');
  assert.equal(planText.parseCardPrompt('前一張：(1) A — x\n後一張：(3) C').next, '(3) C');
  assert.equal(planText.parseCardPrompt('Previous card: (1) A\nNext card: (3) C').previous, '(1) A');
  assert.equal(planText.parseCardPrompt('Previous chapter: (1) A\nNext chapter: (3) C\nChapter: (2) B').parent, '(2) B');
  assert.equal(planText.parseCardPrompt('Previous section: A\nNext section: B').next, 'B');
});

test('A6 neighbourLineTitle / rewriteNeighbourLine / retargetNeighbourLine take the kind, write the new label and survive (前言)', () => {
  const { neighbourLineTitle, rewriteNeighbourLine, retargetNeighbourLine } = planText;
  assert.equal(neighbourLineTitle('上一章：(前言) Intro — x', 'previous'), 'Intro');
  assert.equal(neighbourLineTitle('Previous chapter: (Preface) Intro', 'previous'), 'Intro');
  assert.equal(neighbourLineTitle('前一張：(3) Old — x', 'previous'), 'Old', 'an old line is read');
  assert.equal(neighbourLineTitle('前一節：S1 — x', 'previous', 'section'), 'S1');
  assert.equal(neighbourLineTitle('所屬章：(2) Two', 'parent', 'section'), 'Two');
  assert.equal(neighbourLineTitle('前一節：無', 'previous', 'section'), undefined);
  assert.equal(neighbourLineTitle('上一章：無', 'previous'), undefined);
  // rewrite: an old line takes the label of the kind; the preface may be the position
  assert.equal(rewriteNeighbourLine('前一張：(2) A — a', 'previous', { position: 'preface', title: 'Intro', summary: 'i' }, 'chapter'), '上一章：(前言) Intro — i');
  assert.equal(rewriteNeighbourLine('Previous card: (2) A', 'previous', { position: 'preface', title: 'Intro', summary: '' }, 'chapter'), 'Previous chapter: (Preface) Intro');
  assert.equal(rewriteNeighbourLine('後一張：(3) C — c', 'next', { title: 'S2', summary: 'two' }, 'section'), '後一節：S2 — two');
  assert.equal(rewriteNeighbourLine('Next card: (3) C', 'next', null, 'section'), 'Next section: none');
  assert.equal(rewriteNeighbourLine('上一章：(1) A — a', 'previous', { position: 1, title: 'A', summary: 'a' }, 'chapter'), undefined, 'already says it');
  // retarget: (前言) is a position like any other
  const line = '上一章：(前言) Intro — about';
  assert.equal(retargetNeighbourLine(line, 'previous', { position: 'preface', title: 'Intro', summary: 'new' }, 'chapter'), undefined, 'names it already');
  assert.equal(retargetNeighbourLine(line, 'previous', { position: 1, title: 'Intro', summary: 'new' }, 'chapter'), '上一章：(1) Intro — about', 'only the position moved: the sentence is kept');
  assert.equal(retargetNeighbourLine('上一章：(1) A — a', 'previous', { position: 'preface', title: 'Intro', summary: 'n' }, 'chapter'), '上一章：(前言) Intro — n');
  assert.equal(retargetNeighbourLine('前一節：S1 — about', 'previous', { title: 'S1', summary: 'new' }, 'section'), undefined);
  assert.equal(retargetNeighbourLine('前一節：S1 — about', 'previous', { title: 'S0', summary: 'new' }, 'section'), '前一節：S0 — new');
});

test('A6 card plan request: a section prompt carries its chapter and (last section) the next chapter; a chapter prompt has no section lines; continuity rules follow the kind', () => {
  const section = cardPlan.cardPlanStep.render(planBase({ card: { id: 's2', kind: 'section', chapter: 2, sectionIndex: 2, sectionCount: 2, role: 'body', title: 'Two', summary: 's' }, parent: { position: 2, title: 'Chapter two' }, previous: { title: 'One', summary: 'o' }, nextChapter: { position: 3, title: 'Outro', summary: 'x' } }));
  assert.match(section, /"place":"section 2 of 2 in chapter 2"/);
  assert.match(section, /Chapter this section belongs to \(JSON object\):\n\{"place":"chapter 2","title":"Chapter two"\}/);
  assert.match(section, /Next chapter, which this section's handoff leads to \(JSON object\):\n\{"place":"chapter 3","title":"Outro"/);
  assert.match(section, /its entry takes up where the previous section ended/);
  assert.match(section, /last section of the chapter, its handoff leads out to the next chapter/);
  const firstSection = cardPlan.cardPlanStep.render(planBase({ card: { id: 's1', kind: 'section', chapter: 2, sectionIndex: 1, sectionCount: 2, role: 'body', title: 'One', summary: 's' }, parent: { position: 2, title: 'Chapter two' }, next: { title: 'Two', summary: 't' } }));
  assert.match(firstSection, /first section of its chapter, so its entry takes up the chapter's own text/);
  assert.ok(!/Next chapter, which/.test(firstSection));
  const chapter = cardPlan.cardPlanStep.render(planBase({ previous: { position: 'preface', title: 'Intro', summary: 'i' } }));
  assert.ok(!/belongs to|Next chapter, which/.test(chapter));
  assert.match(chapter, /"place":"preface","title":"Intro"/);
  assert.match(chapter, /takes up the end of the previous chapter .* and does not retell it\. This chapter has no sections, so its handoff leads into the next chapter\./);
  const withSections = cardPlan.cardPlanStep.render(planBase({ children: [{ title: 'S1', summary: 'a' }] }));
  assert.match(withSections, /handoff leads into its own first section/);
});

test('A6 global plan: every card carries its place, and the prompt explains the preface, chapters and sections', () => {
  const text = globalPlan.globalPlanStep.render(globalRequest({ cards: [{ id: 'r', place: 'preface', title: 'Root', summary: 's' }, { id: 'a', place: 'chapter 1', title: 'A', summary: 's' }, { id: 'b', place: 'section 1 of 1 in chapter 1', title: 'B', summary: 's' }] }));
  assert.match(text, /\{"id":"r","place":"preface","title":"Root"/);
  assert.match(text, /\{"id":"b","place":"section 1 of 1 in chapter 1"/);
  assert.match(text, /The root card is the preface/);
  assert.ok(!/Every card is one chapter/.test(text));
});
