// "AI suggested" note style, packet P3: the whole flow over a real Repository and fake replies (first research, chart job,
// re-read, second and third research), the fallbacks, the notes whose sections cannot be followed, and the numbers and
// links a rewrite dropped. Layer 2 of the ai-semantic check: the note that was written is scanned, not only the context.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, core, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator, until, attachTopicRuns } = require('./support.cjs');
const { promptsFor, makeService } = require('./support-replay.cjs');

const { NoteStyleStore } = load('ai/note-style-store.ts', { obsidian });
const { templateFromDetail } = load('ai/detail-sections.ts');
const { countItems, standardTemplate } = load('ai/detail-templates.ts');
const { keepDroppedContent } = load('core/steps/task/merge-check.ts');
const { translate } = load('i18n.ts');

const MAP = 'Agent Workspace/Topics/map-a/Map.md';
const research = { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] };
const noticeText = key => translate('en', key);
const plain = value => JSON.parse(JSON.stringify(value));
const sectionsOf = detail => (detail.match(/^### .+$/gm) ?? []).map(line => line.slice(4));
const headingsOf = (detail, level) => (detail.match(new RegExp(`^${level} .+$`, 'gm')) ?? []).map(line => line.slice(level.length + 1));

async function harness({ style = 'builtin:ai-suggested', detail } = {}) {
  const { repo, app } = fixture('en');
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a');
  await app.vault.create(MAP, core.serializeMap({ ...mapDoc }));
  const node = await repo.createNote('Swing plane', 'gpt-6-luna', mapDoc, MAP, 'workspace', {});
  mapDoc.nodes.push(node);
  await repo.saveMap(MAP, mapDoc);
  if (detail !== undefined) await repo.updateNote(node.path, { detail });
  const contexts = [], notices = [], jobs = [];
  const replies = [], prompts = [];
  // The real AiTaskService over a fake provider: the reply is what the model sends back, the service parses and judges it.
  const service = makeService({ runTask: async prompt => { prompts.push(prompt); return JSON.stringify({ summary: 'S', visualReferences: [], suggestions: [], ...replies.shift() }); } }, { language: 'en', reuseModule: true });
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna', cliReasoning: 'low', ...(style ? { noteStyleByKind: { topic: style } } : {}) };
  const noteStyles = new NoteStyleStore({ settings: () => settings, port: { folderExists: () => false, listFiles: async () => [], readFile: async () => '' }, save: async () => {} });
  const host = withExpansionCoordinator({
    repo, settings, noteStyles, running: new Set(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {},
    recordFailure: (_label, error) => String(error?.message ?? error), views: () => [], mutate: async work => work(),
    confirmAiUsage: async (_model, run) => { await run(); return true; },
    researchProgress: { get: () => undefined, begin() {}, newAttempt() {}, stage() {}, preview() {}, markSlow() {}, end() {} },
    askModel: (context, model, reasoning, signal, onExchange, accepted, ...rest) => {
      contexts.push(context); accepted?.();
      return service.askModel(context, model, reasoning, signal, onExchange, accepted, ...rest);
    }
  });
  host.addChartsAfterWrite = job => jobs.push(job);
  repo.settings = host.settings;
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: class { constructor(message) { notices.push(message); } } } });
  const view = new VisualAgentMapView({ app }, attachTopicRuns(host));
  view.notes = new Map([[node.id, { title: 'Swing plane' }]]);
  Object.assign(view, { path: MAP, map: mapDoc, contentEl: { querySelector: () => null }, render() {}, hydrate: async () => {}, ancestorContext: async () => '' });
  const read = () => repo.readNote(node.path, mapDoc);
  const run = async (reply, extra = {}) => {
    replies.push(reply);
    const before = contexts.length;
    await view.runAgent(node, undefined, undefined, { task: 'go', ...research, ...extra });
    await until(() => contexts.length === before + 1 && !host.running.has(node.path));
    await until(() => true);
  };
  return { repo, host, view, node, mapDoc, contexts, prompts, notices, jobs, read, run, settings, noteStyles };
}

const FIRST = [
  '### Swing plane', 'The plane is 60 degrees.', '#### Setup', 'Stand with 2 feet apart.', '',
  '### Common faults', '- Over the top 3 times.', '', '### Drills', 'Use drill A.', '',
  '### Sources', '[S1] https://example.com/plane', ''
].join('\n');

test('flow: first research decides the sections, the chart job keeps them, the re-read, second and third research follow them', async () => {
  const h = await harness();
  await h.run({ detail: FIRST });
  assert.equal(h.contexts[0].aiSections, 'decide');
  let note = await h.read();
  // The write-back adds the update log; the chart job carries the sections the AI decided.
  const decided = ['Swing plane', 'Common faults', 'Drills', 'Sources', 'Update log'];
  assert.deepEqual(sectionsOf(note.detail), decided);
  assert.equal(h.jobs.length, 1);
  assert.deepEqual(plain(h.jobs[0].context.detailTemplate.sections.map(section => section.name)), decided.slice(0, 4));
  // The chart job writes through the same template: the sections do not change.
  const chart = `${h.jobs[0].detail}\n\n#### Chart\n\n\`\`\`mermaid\ngraph TD; A-->B\n\`\`\`\n`;
  assert.equal(await h.jobs[0].apply(chart), true);
  note = await h.read();
  assert.deepEqual(sectionsOf(note.detail), decided);
  // The re-read (a new Repository over the same vault) reads the same sections.
  const again = new h.repo.constructor(h.repo.app ?? h.view.app, h.settings);
  assert.deepEqual(sectionsOf((await again.readNote(h.node.path, h.mapDoc)).detail), decided);
  // Second research: the reply has a section the note does not have; its content stays in the section before it.
  await h.run({ detail: [FIRST.replace('The plane is 60 degrees.', 'The plane is 60 degrees. Also 61 degrees.'), '', '### Extra thoughts', 'EXTRA-LINE with 77 yards.'].join('\n').replace('### Sources', '### Sources') });
  assert.equal(h.contexts[1].aiSections, 'follow');
  note = await h.read();
  assert.deepEqual(sectionsOf(note.detail), decided);
  assert.ok(note.detail.includes('EXTRA-LINE with 77 yards.'));
  assert.ok(headingsOf(note.detail, '####').includes('Extra thoughts'), 'the unknown heading is a #### now');
  const extra = note.detail.indexOf('EXTRA-LINE');
  assert.ok(extra > note.detail.indexOf('### Drills') || extra > note.detail.indexOf('### Common faults'));
  // Third research: the section list that is parsed from the note is the same.
  await h.run({ detail: FIRST });
  assert.equal(h.contexts[2].aiSections, 'follow');
  assert.deepEqual(plain(h.contexts[2].detailTemplate.sections.map(section => section.name)), decided);
  const read = templateFromDetail((await h.read()).detail, 'en');
  assert.deepEqual(plain(read.template.sections.map(section => section.name)), decided);
  assert.deepEqual(sectionsOf((await h.read()).detail), decided);
});

test('flow: a second research that drops an old number or link gets it back once, with one Notice; the sections stay', async () => {
  const h = await harness();
  await h.run({ detail: FIRST });
  h.notices.length = 0;
  // The reply drops "60", "2 feet" and the link; it adds new numbers.
  await h.run({ detail: ['### Swing plane', 'The plane is about 59 degrees.', '', '### Common faults', '- Over the top.', '', '### Drills', 'Use drill A.', '', '### Sources', '[S2] https://example.com/other', ''].join('\n') });
  const note = await h.read();
  assert.deepEqual(sectionsOf(note.detail), ['Swing plane', 'Common faults', 'Drills', 'Sources', 'Update log']);
  assert.ok(note.detail.includes('> The plane is 60 degrees.'), note.detail);
  assert.ok(note.detail.includes('> - Over the top 3 times.'), note.detail);
  assert.ok(note.detail.includes('https://example.com/plane'));
  assert.equal(note.detail.split(translate('en', 'note.kept_from_earlier_version')).length - 1 >= 1, true);
  const restored = h.notices.filter(message => message.startsWith('The rewrite dropped'));
  assert.equal(restored.length, 1);
  // Running the same dropped reply again does not stack the quotes.
  const once = note.detail.split('> The plane is 60 degrees.').length - 1;
  assert.equal(once, 1);
  await h.run({ detail: ['### Swing plane', 'The plane is about 59 degrees.', '', '### Common faults', '- Over the top.', '', '### Drills', 'Use drill A.', '', '### Sources', '[S2] https://example.com/other', ''].join('\n') });
  const next = (await h.read()).detail;
  assert.equal(next.split('The plane is 60 degrees.').length - 1, 1, next);
  assert.equal(next.includes('> > '), false);
});

test('flow: not selected, nothing is put back (a style without aiSections runs as it did)', async () => {
  const h = await harness({ style: 'builtin:general', detail: '### Core conclusion\nOld 4242.\n' });
  await h.run({ detail: '### Core conclusion\nNew.\n' });
  assert.equal('aiSections' in h.contexts[0], false);
  const note = await h.read();
  assert.equal(note.detail.includes('4242'), false);
  assert.equal(h.notices.some(message => message.startsWith('The rewrite dropped')), false);
});

const unusable = {
  'no sections in a reply': ['plain text with 5 facts and a link https://example.com/x', null],
};
test('flow: a first reply with no sections falls back to the general sections; every line is kept, one Notice, one call', async () => {
  const h = await harness();
  const body = 'Line one 11.\nLine two 22.\n- item https://example.com/a';
  await h.run({ detail: body });
  assert.equal(h.contexts.length, 1);
  const note = await h.read();
  for (const line of body.split('\n')) assert.ok(note.detail.includes(line.replace(/^- /, '')) || note.detail.includes(line), line);
  assert.ok(sectionsOf(note.detail).length >= 1);
  assert.deepEqual(h.notices.filter(message => message === noticeText('ui.note_style_ai_sections_invalid')).length, 1);
  assert.equal(h.jobs[0].context.detailTemplate.id !== 'note-sections', true);
});

test('flow: a first reply with more than 12 sections or a repeated name falls back; every line is kept', async () => {
  const many = Array.from({ length: 13 }, (_, n) => `### Part ${n + 1}\nCONTENT-${n + 1}\n`).join('\n');
  const twice = '### Same\nFIRST-LINE\n\n### same\nSECOND-LINE\n\n### Other\nTHIRD-LINE\n';
  for (const [reply, lines] of [[many, Array.from({ length: 13 }, (_, n) => `CONTENT-${n + 1}`)], [twice, ['FIRST-LINE', 'SECOND-LINE', 'THIRD-LINE']]]) {
    const h = await harness();
    await h.run({ detail: reply });
    assert.equal(h.contexts.length, 1);
    const note = await h.read();
    for (const line of lines) assert.ok(note.detail.includes(line), line);
    assert.equal(h.notices.filter(message => message === noticeText('ui.note_style_ai_sections_invalid')).length, 1);
  }
});

const fourteen = Array.from({ length: 14 }, (_, n) => `### Part ${n + 1}\nOLD-${n + 1} value ${n + 100}.\n`).join('\n');
const notes = {
  'a note with 14 sections': fourteen,
  'a note with a repeated section name': '### Same\nOLD-A value 301.\n\n### same\nOLD-B value 302.\n',
  'a note with only a # heading': '# Title\nOLD-C value 303.\n',
  'a note of plain text': 'OLD-D value 304 and https://example.com/old',
};
for (const [name, detail] of Object.entries(notes)) {
  test(`flow: ${name} is not an error; the prompt is the general research prompt, one Notice, and the check still runs`, async () => {
    const h = await harness({ detail });
    await h.run({ detail: '### Core conclusion\nNothing kept.\n' });
    assert.equal(h.contexts.length, 1);
    const context = h.contexts[0];
    assert.equal(context.aiSections, 'general');
    // The prompt equals a general research run's prompt, byte for byte.
    const [asked] = await promptsFor({ ...context, outputLanguage: 'en' }, { language: 'en' });
    const { aiSections, ...plain } = context;
    const [general] = await promptsFor({ ...plain, outputLanguage: 'en' }, { language: 'en' });
    assert.equal(asked.prompt, general.prompt);
    assert.equal(h.notices.filter(message => message === noticeText('ui.note_style_note_sections_unusable')).length, 1);
    // The comparison ran: the old value is back in the note and the user was told.
    const note = await h.read();
    const value = detail.match(/\d{3}/)[0];
    assert.ok(note.detail.includes(value), note.detail);
    // A number on a line with a link comes back with the link in the sources section; any other line comes back as a quote.
    assert.ok(note.detail.split('\n').some(line => (line.startsWith('> ') || line.startsWith('- ')) && line.includes(value)), note.detail);
    assert.equal(h.notices.filter(message => message.startsWith('The rewrite dropped')).length, 1);
  });
}

test('flow: the path table, entries that resolve the style without a note read get the general sections, and a note read gets decide or follow', async () => {
  const h = await harness();
  // Merge into a target, AI merge, outline import, selection synthesis and contribution call mapStyle: no note, general sections.
  const mapStyle = await h.view.mapStyle('en', { kind: 'topic' });
  assert.equal(mapStyle.aiSections.mode, 'no-note');
  assert.equal('aiSections' in mapStyle.contextFields, false);
  assert.deepEqual(plain(mapStyle.template.sections.map(section => section.name)), plain(standardTemplate('en').sections.map(section => section.name)));
  // A topic run reads the note: empty is decide, a note with sections is follow.
  let resolved = await h.view.detailTemplateFor(h.node);
  assert.equal(resolved.aiSections.mode, 'decide');
  await h.repo.updateNote(h.node.path, { detail: FIRST });
  resolved = await h.view.detailTemplateFor(h.node);
  assert.equal(resolved.aiSections.mode, 'follow');
  assert.equal(resolved.contextFields.aiSections, 'follow');
  // Integration (synthesize): follow keeps the sections; a note that cannot be followed shows one Notice.
  h.notices.length = 0;
  await h.repo.updateNote(h.node.path, { detail: 'plain' });
  const gate = { shown: false };
  await h.view.detailTemplateFor(h.node, undefined, gate);
  await h.view.detailTemplateFor(h.node, undefined, gate);
  assert.equal(h.notices.filter(message => message === noticeText('ui.note_style_note_sections_unusable')).length, 1);
});

// ---- keepDroppedContent ----
const lang = 'en';
const base = { summary: '', references: '', language: lang };
const withSources = standardTemplate(lang);
const noSources = { ...withSources, sections: withSources.sections.filter(section => section.role !== 'sources') };
const names = detail => sectionsOf(detail);

test('keepDroppedContent: numbers dropped, links dropped, both dropped; a restore adds nothing the next run repeats', () => {
  const sourcesName = withSources.sections.find(section => section.role === 'sources').name;
  const first = withSources.sections[0].name, second = withSources.sections[1].name;
  const old = `### ${first}\nThe rate is 44 percent.\n\n### ${second}\nSee https://example.com/a for it.\n\n### ${sourcesName}\n- [S1] https://example.com/a\n`;
  // numbers
  const numbers = keepDroppedContent({ ...base, template: withSources, oldDetail: old, newDetail: `### ${first}\nThe rate is high.\n\n### ${second}\nSee https://example.com/a for it.\n\n### ${sourcesName}\n- [S1] https://example.com/a\n` });
  assert.equal(numbers.restored, 1);
  assert.ok(numbers.detail.includes('> The rate is 44 percent.'));
  assert.deepEqual(names(numbers.detail), names(old));
  // links (go to the sources section, no quote needed)
  const links = keepDroppedContent({ ...base, template: withSources, oldDetail: old, newDetail: `### ${first}\nThe rate is 44 percent.\n\n### ${second}\nNothing.\n\n### ${sourcesName}\n- nothing\n` });
  assert.equal(links.restored, 1);
  assert.ok(links.detail.includes('https://example.com/a'));
  assert.deepEqual(names(links.detail), names(old));
  // both
  const both = keepDroppedContent({ ...base, template: withSources, oldDetail: old, newDetail: `### ${first}\nNothing.\n\n### ${second}\nNothing.\n\n### ${sourcesName}\n- nothing\n` });
  assert.equal(both.restored, 2);
  assert.ok(both.detail.includes('> The rate is 44 percent.') && both.detail.includes('https://example.com/a'));
  // nothing missing: nothing changes
  const same = keepDroppedContent({ ...base, template: withSources, oldDetail: old, newDetail: old });
  assert.deepEqual({ ...same }, { detail: old, restored: 0 });
  // run again on the restored note with the same dropped rewrite: the line is there once, as one quote
  const again = keepDroppedContent({ ...base, template: withSources, oldDetail: numbers.detail, newDetail: `### ${first}\nThe rate is high.\n\n### ${second}\nSee https://example.com/a for it.\n\n### ${sourcesName}\n- [S1] https://example.com/a\n` });
  assert.equal(again.detail.split('The rate is 44 percent.').length - 1, 1);
  assert.equal(again.detail.includes('> > '), false);
  assert.equal(again.detail.split(translate(lang, 'note.kept_from_earlier_version')).length - 1, 1);
});

test('keepDroppedContent: source numbers ("來源 1" -> [^1]) are not dropped numbers, in three languages', () => {
  const first = noSources.sections[0].name;
  for (const [line, fresh] of [
    ['球桿角度很重要（見來源 1）。另一點（見來源 2）。', '球桿角度很重要[^1]。另一點[^2]。'],
    ['球杆角度很重要（见来源 1、2）。', '球杆角度很重要[^1][^2]。'],
    ['Swing plane matters (see source 1). Also (sources 1, 2) and References 3.', 'Swing plane matters[^1]. Also[^2] and[^3].']
  ]) {
    const out = keepDroppedContent({ ...base, template: noSources, oldDetail: `### ${first}\n${line}\n`, newDetail: `### ${first}\n${fresh}\n` });
    assert.equal(out.restored, 0);
    assert.equal(out.detail, `### ${first}\n${fresh}\n`);
  }
});

test('keepDroppedContent: a real number next to a source number is still restored, as the original line', () => {
  const first = noSources.sections[0].name;
  const line = '距離少了 42 公里（見來源 1）。';
  const out = keepDroppedContent({ ...base, template: noSources, oldDetail: `### ${first}\n${line}\n`, newDetail: `### ${first}\n距離變短[^1]。\n` });
  assert.equal(out.restored, 1);
  assert.ok(out.detail.includes(`> ${line}`));
  // a year, or a quantity with a unit after "source", is a number
  for (const text of ['來源 2018 年報告', 'source 2018 report', 'source 5 km away', '來源 3 公里']) {
    const kept = keepDroppedContent({ ...base, template: noSources, oldDetail: `### ${first}\n${text}\n`, newDetail: `### ${first}\nnothing\n` });
    assert.equal(kept.restored, 1, text);
    assert.ok(kept.detail.includes(`> ${text}`), text);
  }
});

test('keepDroppedContent: a template without a sources section is not given one, and links are not carried', () => {
  const first = noSources.sections[0].name;
  const old = `### ${first}\nSee https://example.com/a and 55.\n`;
  const out = keepDroppedContent({ ...base, template: noSources, oldDetail: old, newDetail: `### ${first}\nNothing.\n` });
  assert.deepEqual(names(out.detail), [first]);
  assert.equal(out.detail.includes('earlier research'), false);
  assert.ok(out.detail.includes('> See https://example.com/a and 55.'));
  assert.equal(out.restored, 2);
});

test('keepDroppedContent: quoted lines do not change the item count of a section; the log is not taken, code and headings are put back as quotes', () => {
  const first = withSources.sections[0].name, log = withSources.sections.find(section => section.role === 'log').name;
  const old = `### ${first}\n- a 11\n- b 22\n\`\`\`\ncode 33\n\`\`\`\n#### head 44\n\n### ${log}\n- 2020-01-01 changed 55\n`;
  const newDetail = `### ${first}\n- a\n- b\n`;
  const out = keepDroppedContent({ ...base, template: withSources, oldDetail: old, newDetail });
  const body = out.detail.split('\n').slice(1).join('\n');
  assert.equal(countItems(body), countItems('- a\n- b\n'));
  // Code and headings are put back too (as inline code and as text, B3); only the log section is left out.
  assert.equal(out.detail.includes('> `code 33`'), true);
  assert.equal(out.detail.includes('> head 44'), true);
  assert.equal(out.detail.includes('changed 55'), false);
  assert.ok(out.detail.includes('> - a 11') && out.detail.includes('> - b 22'));
});

test('keepDroppedContent: a line goes to the section of the same name, else the last section that is not sources or log', () => {
  const [one, two] = withSources.sections.filter(section => section.role === 'none').map(section => section.name);
  const old = `### ${one}\nA 11.\n\n### ${two}\nB 22.\n\n### Gone section\nC 33.\n`;
  const out = keepDroppedContent({ ...base, template: withSources, oldDetail: old, newDetail: `### ${one}\nx\n\n### ${two}\ny\n` });
  const lines = out.detail.split('\n');
  const at = text => lines.findIndex(line => line.includes(text));
  assert.ok(at('> A 11.') > lines.indexOf(`### ${one}`) && at('> A 11.') < lines.indexOf(`### ${two}`));
  assert.ok(at('> B 22.') > lines.indexOf(`### ${two}`));
  assert.ok(at('> C 33.') > lines.indexOf(`### ${two}`), 'an unknown section goes to the last plain section');
});

// ---- review fixes: B1 source-number whitelist, B2 footnote remap, B3 nothing silently left out, Medium 1 ----
const { checkMergePreservation } = load('core/steps/task/merge-check.ts');
const keep = (oldBody, newBody, template = noSources) => {
  const first = template.sections[0].name;
  return keepDroppedContent({ ...base, template, oldDetail: `### ${first}\n${oldBody}\n`, newDetail: `### ${first}\n${newBody}\n` });
};

test('B1: a number after "source" that counts something (a unit, a noun, a glued character) is a real number and is restored as the original line', () => {
  for (const line of [
    '資料來源 300 家企業', '營收來源 7 成來自廣告', '收入來源 3 種', '共納入來源 12 篇', '來源 2 位', '來源 12 筆', '資料來源 30 分鐘訪談',
    '來源 5 週追蹤', '來源 300 美元', '來源 8 名選手', '來源12家', 'source 12 hours of footage', 'source 3 million users',
    'open source 40 projects', 'data sources 25 countries', 'references 3 studies', '資料來源 300', '來源 1, 2 million 人'
  ]) {
    const out = keep(line, 'nothing');
    assert.equal(out.restored >= 1, true, line);
    assert.ok(out.detail.includes(`> ${line}`), line);
  }
});

test('B1: a source number followed by the end of the line, punctuation, a bracket or a short verb is a pointer, not a dropped number', () => {
  for (const line of [
    '（見來源 1）', '（见来源 2）', '見來源 1、2。', '(see source 1)', 'sources 1, 2.', 'Growth is clear, see source 3', '詳見來源 4；另見出處 5！', '來源 3 指出成長', 'Source 2 says growth'
  ]) {
    const out = keep(line, 'nothing');
    assert.equal(out.restored, 0, line);
    assert.equal(out.detail, `### ${noSources.sections[0].name}\nnothing\n`, line);
  }
  // 3 is the pointer and 9 is the number: only 9 is restored.
  const mixed = keep('來源 3 指出成長 9 倍', '成長很多');
  assert.equal(mixed.restored, 1);
  assert.ok(mixed.detail.includes('> 來源 3 指出成長 9 倍'));
  // Ambiguous, decided toward reporting: a three-digit number after "source" at the end of a line stays a number; one or two digits are a pointer.
  assert.equal(keep('共 12 個來源 3', 'nothing').restored, 1, 'the 12 is a count, the trailing 3 is a pointer');
  assert.equal(keep('資料來源 300', 'nothing').restored, 1);
});

test('Medium 1: the new draft is read without its source pointers too, so a pointer cannot hide a dropped number', () => {
  const out = keep('成長 3 倍（見來源 1）', '成長很多（見來源 3）');
  assert.equal(out.restored, 1);
  assert.ok(out.detail.includes('> 成長 3 倍（見來源 1）'));
  const summaryOnly = keepDroppedContent({ ...base, summary: '趨勢（see source 3）', template: noSources, oldDetail: `### ${noSources.sections[0].name}\n成長 3 倍\n`, newDetail: `### ${noSources.sections[0].name}\nnothing\n` });
  assert.equal(summaryOnly.restored, 1);
});

test('B2: a restored line points at the new footnote that has the same source URL; one with no match loses the marker and carries the URL', () => {
  const sourcesName = withSources.sections.find(section => section.role === 'sources').name;
  const first = withSources.sections[0].name;
  const old = `### ${first}\n速度 42 公里[^2]\n\n### ${sourcesName}\n[^2]: https://b.example/2\n`;
  const swapped = keepDroppedContent({ ...base, template: withSources, oldDetail: old, newDetail: `### ${first}\n速度 40 公里[^1] 另一點[^2]\n\n### ${sourcesName}\n[^1]: https://b.example/2\n[^2]: https://a.example/1\n` });
  assert.equal(swapped.restored, 1);
  assert.ok(swapped.detail.includes('> 速度 42 公里[^1]'), swapped.detail);
  assert.equal(swapped.detail.includes('42 公里[^2]'), false);
  const gone = keepDroppedContent({ ...base, template: withSources, oldDetail: old, newDetail: `### ${first}\n速度 40 公里[^1]\n\n### ${sourcesName}\n[^1]: https://a.example/1\n` });
  assert.ok(gone.detail.includes('> 速度 42 公里 <https://b.example/2>'), gone.detail);
  assert.equal(gone.detail.includes('42 公里[^'), false);
  // A footnote with no definition in the old detail is dropped, not pointed at whatever the new detail numbers the same.
  const dangling = keep('速度 42 公里[^7]', '速度 40 公里[^7]\n\n[^7]: https://z.example');
  assert.ok(dangling.detail.includes('> 速度 42 公里'), dangling.detail);
  assert.equal(dangling.detail.includes('42 公里[^7]'), false);
  // Without a sources section the quoted definition line keeps its URL as text, not as a second definition.
  const noSection = keep('速度 42 公里[^2]\n[^2]: https://b.example/2', 'nothing');
  assert.equal(noSection.detail.includes('> [^2]:'), false);
  assert.ok(noSection.detail.includes('https://b.example/2'));
});

test('B3: whatever the comparison found missing is put back, except inside a mermaid fence; restored counts what was put back', () => {
  const cases = [
    '#### 2024 年 65% 的人\nplain',
    '```\nrate = 77\n```',
    '```python3\ncurl https://c.example/x\nn = 5\n```',
    '~~~js\nconst x = 31\n~~~',
    '> [!note] Title 88\n> quoted 99',
    '| a | b |\n| --- | --- |\n| 11 | 22 |'
  ];
  for (const body of cases) {
    const first = withSources.sections[0].name;
    const old = `### ${first}\n${body}\n`;
    const out = keepDroppedContent({ ...base, template: withSources, oldDetail: old, newDetail: `### ${first}\nnothing\n` });
    const before = checkMergePreservation({ sourceTexts: [old], mergedTexts: [`### ${first}\nnothing\n`] }).missing;
    const after = checkMergePreservation({ sourceTexts: [old], mergedTexts: [out.detail] }).missing;
    assert.deepEqual(plain(after), [], body);
    assert.equal(out.restored, before.length, body);
    assert.equal(names(out.detail)[0], first, body);
    const lines = out.detail.split('\n');
    assert.equal(lines.some(line => /^\s*(`{3,}|~{3,})/.test(line)), false, `no fence is rebuilt: ${body}`);
    assert.equal(lines.some(line => /^#{4}/.test(line)), false, `no heading is rebuilt: ${body}`);
  }
  const heading = keep('#### 2024 年 65% 的人\nplain', 'nothing');
  assert.ok(heading.detail.includes('> 2024 年 65% 的人'));
  const code = keep('```\nrate = 77\n```', 'nothing');
  assert.ok(code.detail.includes('> `rate = 77`'), code.detail);
  // Backticks inside the code line get a longer delimiter.
  const ticks = keep('```\nuse `x` = 41\n```', 'nothing');
  assert.ok(ticks.detail.includes('> `` use `x` = 41 ``'), ticks.detail);
});

test('B3: a mermaid fence is a chart, regenerated by the chart step, and is not put back into the note', () => {
  const first = noSources.sections[0].name;
  const old = `### ${first}\nKept 12.\n\n\`\`\`mermaid\ngraph TD\nA[Node 77] --> B[Node 88]\nclick A "https://m.example/x"\n\`\`\`\n`;
  const out = keepDroppedContent({ ...base, template: withSources, oldDetail: old, newDetail: `### ${first}\nKept 12.\n` });
  assert.deepEqual({ ...out }, { detail: `### ${first}\nKept 12.\n`, restored: 0 });
  const dropped = keepDroppedContent({ ...base, template: noSources, oldDetail: old, newDetail: `### ${first}\nnothing\n` });
  assert.equal(dropped.restored, 1);
  assert.equal(dropped.detail.includes('Node'), false);
  assert.equal(dropped.detail.includes('m.example'), false);
  assert.ok(dropped.detail.includes('> Kept 12.'));
});

// ---- synthesize mode through the real AiTaskService (P3 gaps) ----
const synthContext = extra => ({
  title: 'Swing plane', summary: '', rules: '', detail: '', task: 'combine', ancestors: '', workingFindings: 'finding 1', sourceContext: '',
  outputLanguage: 'en', mode: 'synthesize', researchMode: 'local', researchDepth: 'normal', visualMode: 'off', ...extra
});
async function askSynthesize(context, detail) {
  const reply = JSON.stringify({ summary: 'S', detail, visualReferences: [], suggestions: [] });
  const runtime = require('./support-replay.cjs').capturingRuntime([reply]);
  const result = await makeService(runtime, { language: 'en', reuseModule: true }).askModel(context, 'gpt-6-luna', 'low');
  return { result, prompts: runtime.calls.map(call => call.prompt) };
}

test('synthesize + follow: a ### the note does not have becomes ####, the section list stays', async () => {
  const template = templateFromDetail(FIRST, 'en').template;
  const reply = [FIRST.replace('### Sources', '### Extra thoughts\nEXTRA-LINE with 9 yards.\n\n### Sources')].join('');
  const { result, prompts } = await askSynthesize(synthContext({ detail: FIRST, aiSections: 'follow', detailTemplate: template }), reply);
  assert.equal(prompts.length, 1);
  assert.deepEqual(sectionsOf(result.detail), sectionsOf(FIRST));
  assert.ok(headingsOf(result.detail, '####').includes('Extra thoughts'));
  assert.ok(result.detail.includes('EXTRA-LINE with 9 yards.'));
  assert.equal(result.decidedTemplate, undefined);
  assert.equal(result.aiSectionsFallback, undefined);
});

test('synthesize + decide on an empty note: no decided template, no fallback, and the prompt is the standard one', async () => {
  const reply = FIRST;
  const decide = await askSynthesize(synthContext({ aiSections: 'decide', detailTemplate: standardTemplate('en') }), reply);
  const standard = await askSynthesize(synthContext({ detailTemplate: standardTemplate('en') }), reply);
  const follow = await askSynthesize(synthContext({ aiSections: 'follow', detailTemplate: templateFromDetail(FIRST, 'en').template }), reply);
  assert.equal(decide.result.decidedTemplate, undefined);
  assert.equal(decide.result.aiSectionsFallback, undefined);
  assert.equal(decide.prompts[0], standard.prompts[0]);
  assert.notEqual(follow.prompts[0], standard.prompts[0]);
});
