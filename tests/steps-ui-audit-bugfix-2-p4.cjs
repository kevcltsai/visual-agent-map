// UI audit bugfix-2, packet P4 (Coffee Tables): read-only sample, batch reference files, delete wording and list,
// fill-summary on a sample, translated missing-note and status text, and the zh-TW/en/zh-CN wording fixes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, obsidian } = require('./support.cjs');
const coffeeTypes = load('experiences/coffee-tables/types.ts');

// A call that the code under test may leave pending (for example an unresolved modal) must not hang the run.
const settle = (promise, ms = 200) => Promise.race([Promise.resolve(promise).catch(() => {}), new Promise(resolve => setTimeout(resolve, ms))]);
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const dictionary = file => Object.values(load(file)).find(value => value && typeof value === 'object' && 'coffee.unreadable' in value);

// vc-sample-not-readonly: the built-in sample is read-only; the engine refuses every generating or editing action.
test('vc-sample-not-readonly: the engine never calls the AI or saves for a built-in sample', async () => {
  const { CoffeeEngine } = load('experiences/coffee-tables/engine.ts');
  const session = coffeeTypes.createSession('Sample topic', 'test-model', 'high', 'zh-TW');
  session.id = 'sample-zh-TW';
  session.status = 'completed';
  session.rounds = [{ id: 'sample-round', markdown: '### Host|Host\nLine.', notes: '', status: 'completed', createdAt: session.createdAt }];
  session.questions = [];
  let calls = 0, saves = 0;
  const engine = new CoffeeEngine(session, async () => { calls++; return ''; }, async () => { saves++; });
  const attempts = [
    () => engine.ask('What next?', 'question-1', []),
    () => engine.continueTable(),
    () => engine.intervene('comment', 'A comment'),
    () => engine.refreshObserverNotes(),
    () => engine.start()
  ];
  for (const attempt of attempts) await settle(attempt());
  assert.equal(calls, 0, 'no AI call');
  assert.equal(saves, 0, 'nothing written');
  assert.equal(engine.session.questions.length, 0);
});

test('vc-sample-not-readonly: a built-in sample shows only the copy action in the composer', () => {
  const view = read('experiences/coffee-tables/view.ts');
  assert.match(view, /const sampleRoom = isSampleSessionId\(engine\.session\.id\);\s*if \(sampleRoom && engine\.session\.status === "completed"\) \{\s*this\.button\(composer, this\.t\("coffee\.copy_sample_to_my_table"\)/);
  assert.match(view, /copy_sample_to_my_table"\)[\s\S]*?\} else if \(engine\.session\.status === "completed"\) \{/);
});

test('vc-sample-not-readonly: the sample check tolerates a session without an id string', () => {
  const { isSampleSessionId } = load('experiences/coffee-tables/samples.ts');
  assert.equal(isSampleSessionId('sample-zh-TW'), true);
  assert.equal(isSampleSessionId('abc123'), false);
  assert.equal(isSampleSessionId(undefined), false);
});

// vc-fill-summary-sample: a sample never offers to fill summaries; the user gets the read-only notice instead.
test('vc-fill-summary-sample: confirming a summary fill on a sample shows the read-only notice, not a model error', async () => {
  const modals = [], notices = [];
  class Modal { constructor() { this.contentEl = { empty() {}, createEl() { return { addClass() {}, onclick: null }; }, createDiv() { return { createEl() { return { addClass() {}, onclick: null }; } }; } }; } open() { modals.push(this); } close() {} }
  class Notice { constructor(message) { notices.push(message); } }
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian: { ...obsidian, Modal, Notice } });
  const plugin = { settings: { language: 'zh-TW' }, modelLabel: id => id, confirmAiUsage: async (_m, run) => run() };
  const view = new CoffeeTablesView({ app: {} }, plugin);
  let filled = 0;
  view.engine = { busy: false, session: { id: 'sample-zh-TW', model: 'test-model' }, fillSegmentSummaries: async () => { filled++; } };
  await settle(view.confirmFillSummaries());
  assert.equal(modals.length, 0, 'no confirmation dialog for a sample');
  assert.equal(filled, 0, 'no summary request');
  assert.equal(notices.length, 1);
  assert.equal(notices[0], dictionary('i18n/zh-TW.ts')['coffee.engine_sample_read_only']);
});

// vc-refs-batch-aborts: one unsupported or empty file no longer aborts the batch; the others are kept and each skipped file is named.
test('vc-refs-batch-aborts: the reference picker keeps the usable files and names the skipped ones', () => {
  const view = read('experiences/coffee-tables/view.ts');
  assert.match(view, /skipped\.push\(this\.t\("coffee\.unsupported_reference_file", file\.name\)\);\s*continue;/);
  assert.match(view, /skipped\.push\(this\.t\("coffee\.the_reference_file_is_empty", file\.name\)\);\s*continue;/);
  assert.doesNotMatch(view, /throw new Error\(this\.t\("coffee\.unsupported_reference_file"/);
  assert.match(view, /if \(skipped\.length\) new Notice\(skipped\.join\("\\n"\)\);/);
});

// dcd-sidecar-not-in-trash: the dialog states what really happens to the settings file (text only).
test('dcd-sidecar-not-in-trash: the delete dialog says settings are backed up to .sessions/trash, not the vault trash', () => {
  const zh = dictionary('i18n/zh-TW.ts')['coffee.will_be_backed_up_and_moved_to_the_vault_trash'];
  const en = dictionary('i18n/en.ts')['coffee.will_be_backed_up_and_moved_to_the_vault_trash'];
  assert.match(zh, /\.sessions\/trash/);
  assert.match(zh, /不在垃圾桶/);
  assert.doesNotMatch(zh, /設定會先備份，再移入垃圾桶/);
  assert.match(en, /\.sessions\/trash/);
  assert.match(en, /not the vault trash/);
});

// vc-delete-many-list-run-on: each selected table is its own numbered line, with a time that tells same-topic tables apart.
test('vc-delete-many-list-run-on: three same-topic tables give three distinct lines, one per table', () => {
  const { tableDeleteLines } = load('experiences/coffee-tables/list.ts');
  const targets = [0, 1, 2].map(index => ({ id: `id-${index}`, path: `p${index}.md`, topic: 'Same Topic Alpha', status: 'completed', createdAt: `2026-11-0${index + 1}T10:00:00.000Z`, updatedAt: '', model: '' }));
  const lines = tableDeleteLines(targets, 'zh-TW');
  assert.equal(lines.length, 3);
  assert.equal(new Set(lines).size, 3, 'each line is distinct');
  for (const line of lines) assert.match(line, /Same Topic Alpha/);
  assert.match(lines[0], /^1\./);
  assert.ok(lines.every(line => !/\n/.test(line)), 'a line has no embedded newline');
});

// vc-open-md-missing-english: the missing-note message follows the interface language.
// Each load() gets its own i18n instance, so the zh-TW runtime switch cannot be driven from here; the test checks the
// key path at runtime (English, the default) and the zh-TW dictionary entry directly. The live zh-TW path is a UI check.
test('vc-open-md-missing-english: a missing Markdown note gives a translated message in the interface language', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian });
  const storage = new CoffeeStorage({ getAbstractFileByPath: () => null }, 'Agent Workspace');
  await assert.rejects(storage.openMarkdown('sample-missing'), error => {
    assert.equal(error.message, dictionary('i18n/en.ts')['coffee.markdown_note_missing']);
    return true;
  });
  assert.match(dictionary('i18n/zh-TW.ts')['coffee.markdown_note_missing'], /[\u4e00-\u9fff]/);
  assert.match(read('experiences/coffee-tables/storage.ts'), /throw new Error\(t\("coffee\.markdown_note_missing"\)\)/);
});

// vc-list-filter-empty-wrong-text: a status filter with no match says "no matching tables", not "tables will appear here".
test('vc-list-filter-empty-wrong-text: an empty status filter uses the no-match text', () => {
  const view = read('experiences/coffee-tables/view.ts');
  assert.match(view, /this\.homeQuery \|\| this\.focusedTopic \|\| this\.tableFilter !== "all"\s*\?\s*this\.t\("coffee\.no_matching_tables"\)/);
  const zh = dictionary('i18n/zh-TW.ts'), en = dictionary('i18n/en.ts');
  assert.equal(zh['coffee.no_matching_tables'], '找不到符合的桌聊。');
  assert.ok(en['coffee.no_matching_tables'], 'en has a value');
});

// vc-language-mixed-english: the Coffee Tables text that leaked English or a raw value into the zh-TW interface.
test('vc-language-mixed-english: the list timestamp is localized, not US-style', () => {
  const { formatTableDateTime } = load('experiences/coffee-tables/list.ts');
  const ts = Date.UTC(2026, 10, 8, 6, 5, 53);
  const zh = formatTableDateTime(ts, 'zh-TW');
  assert.doesNotMatch(zh, /\d{1,2}\/\d{1,2}\/\d{4}/, zh);
  assert.doesNotMatch(zh, /\b(AM|PM)\b/, zh);
  const en = formatTableDateTime(ts, 'en');
  assert.match(en, /2026/);
  assert.equal(formatTableDateTime(Number.NaN, 'en'), '');
});

test('vc-language-mixed-english: the sample sessions show a translated built-in label and a localized guest role', () => {
  const zh = dictionary('i18n/zh-TW.ts'), en = dictionary('i18n/en.ts');
  assert.equal(zh['coffee.built_in_sample'], '內建示範');
  assert.equal(en['coffee.built_in_sample'], 'Built-in sample');
  const { COFFEE_SAMPLE_ZH } = load('experiences/coffee-tables/samples.ts');
  assert.doesNotMatch(COFFEE_SAMPLE_ZH.markdown, /Generalist/);
  assert.match(COFFEE_SAMPLE_ZH.markdown, /好奇的通才/);
});

test('vc-language-mixed-english: the handoff reasoning choices use the translated labels, not raw values', () => {
  const handoff = read('experiences/coffee-tables/handoff-modal.ts');
  assert.doesNotMatch(handoff, /\["low", "medium", "high", "auto"\]\)/);
  assert.match(handoff, /coffee\.reasoning_auto/);
  assert.match(handoff, /coffee\.reasoning_low/);
});

test('vc-language-mixed-english: the model status line names the provider and translates the status', () => {
  const view = read('experiences/coffee-tables/view.ts');
  assert.doesNotMatch(view, /`\$\{state\.provider\}: \$\{state\.status\}/);
  assert.match(view, /coffee\.model_provider_status/);
  const zh = dictionary('i18n/zh-TW.ts'), en = dictionary('i18n/en.ts');
  assert.equal(zh['coffee.model_provider_status'], '{0}：{1}');
  assert.equal(en['coffee.model_provider_status'], '{0}: {1}');
});

test('vc-language-mixed-english: the stopped-generation message is translated for the zh-TW interface', () => {
  const engine = read('experiences/coffee-tables/engine.ts');
  assert.doesNotMatch(engine, /error: "Generation stopped when Obsidian closed; saved draft is available\."/);
  assert.match(engine, /coffee\.engine_generation_stopped_obsidian_closed/);
  const zh = dictionary('i18n/zh-TW.ts'), en = dictionary('i18n/en.ts');
  assert.ok(zh['coffee.engine_generation_stopped_obsidian_closed'], 'zh-TW key');
  assert.equal(en['coffee.engine_generation_stopped_obsidian_closed'], 'Generation stopped when Obsidian closed; saved draft is available.');
});
