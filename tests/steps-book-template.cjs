// Book pipeline S0 (T0): the "picture-book chapter" template through the real chain (built-in template block -> block parser ->
// canonicalDetail -> composeWriteback -> repository), and the repository's guarded write (`expectedContent`, `authorize`).
// Unit level. The regression table pins the old output of every built-in template x language x write-back mode.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadSource } = require('./support-replay.cjs');
const S = require('./support.cjs');

const M = loadSource(`
export { composeWriteback } from "./ai/note-writeback";
export { canonicalDetail } from "./ai/result-utils";
export { standardTemplate, textbookTemplate } from "./ai/detail-templates";
export { parseTemplateBlock } from "./core/blocks/template-block";
export { BUILTIN_BLOCKS, builtinTemplateText } from "./core/blocks/builtin";
export { noteLanguageOf, translate } from "./i18n";
export { templateFromDetail } from "./ai/detail-sections";
`);

const NOW = new Date(2026, 10, 16, 9, 8, 7);
const LANGUAGES = ['zh-TW', 'zh-CN', 'en'];
const plain = value => JSON.parse(JSON.stringify(value));
const count = (haystack, needle) => haystack.split(needle).length - 1;

/** The template the store gives a built-in block (store.structurePart): the parsed block, with the block's omitEmpty flag. */
function builtinTemplate(id, language) {
  const note = M.noteLanguageOf(language);
  if (id === 'standard') return M.standardTemplate(note);
  if (id === 'textbook') return M.textbookTemplate(note);
  const block = M.BUILTIN_BLOCKS.find(item => item.category === 'template' && item.id === id);
  const parsed = M.parseTemplateBlock(M.builtinTemplateText(id, language), { id, name: id });
  assert.equal(parsed.ok, true, `${id} ${language} parses`);
  return { ...parsed.template, ...(block.omitEmpty ? { omitEmpty: true } : {}) };
}
const logName = template => template.sections.find(section => section.role === 'log')?.name;
const logHeadingOf = (template, note) => logName(template) ?? M.translate(note, 'detail.update_log');

/** A reply as the model writes it: a lead, a free body with its own sub-heading, every section, and one AI log line. */
function replyFor(template, tag) {
  const parts = [`導讀 LEAD-${tag}`, '', '### 自訂小標', '', `自由正文 FREE-${tag}`];
  for (const section of template.sections) {
    if (section.role === 'log') parts.push('', `### ${section.name}`, '', `2026-11-16　AI 自寫紀錄 ${tag}`);
    else if (section.role === 'sources') parts.push('', `### ${section.name}`, '', `- [[來源${tag}]]`);
    else parts.push('', `### ${section.name}`, '', `${section.name} 內容 ${tag}`);
  }
  return parts.join('\n');
}
function oldFor(template, note) {
  const parts = ['舊導讀 OLD-LEAD'];
  for (const section of template.sections)
    if (section.role !== 'log') parts.push('', `### ${section.name}`, '', `舊內容 OLD-${section.id}`);
  parts.push('', `### ${logHeadingOf(template, note)}`, '', '- 2026-01-01　舊紀錄一', '- 2026-02-01　舊紀錄二');
  return parts.join('\n');
}
function write(template, note, mode, oldDetail, reply) {
  const aiDetail = mode === 'top' ? reply : M.canonicalDetail(reply, note, template);
  const result = M.composeWriteback({ mode, oldDetail, aiDetail, summary: '本次摘要 S', template, language: note, now: NOW, backupPath: 'Backups/old.md' });
  assert.equal(result.ok, true);
  return result.detail;
}

// ---------------------------------------------------------------------------------------------------------------------
// Regression: the output of every built-in template, language and mode before this change (sha256 of the three outputs).

const sha = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
const REGRESSION_IDS = ['standard', 'textbook', 'hypothesis', 'evidence', 'action', 'atomic', 'conclusion', 'guide'];
const regressionKey = (id, language, mode) => `${id}/${language}/${mode}`;
function regressionOutput(id, language, mode) {
  const note = M.noteLanguageOf(language);
  const template = builtinTemplate(id, language);
  return write(template, note, mode, oldFor(template, note), replyFor(template, 'R'));
}
const BASELINE = require('./fixtures/book-template-baseline.json');

test('regression: 8 built-in templates x 3 languages x fresh/top/merge give the same output as before the change (72 outputs)', () => {
  let checked = 0;
  for (const id of REGRESSION_IDS)
    for (const language of LANGUAGES)
      for (const mode of ['fresh', 'top', 'merge']) {
        const key = regressionKey(id, language, mode);
        assert.equal(sha(regressionOutput(id, language, mode)), BASELINE[key], key);
        checked++;
      }
  assert.equal(checked, 72);
  assert.equal(Object.keys(BASELINE).length, 72);
});

if (process.env.DUMP_BASELINE) {
  const table = {};
  for (const id of REGRESSION_IDS)
    for (const language of LANGUAGES)
      for (const mode of ['fresh', 'top', 'merge']) table[regressionKey(id, language, mode)] = sha(regressionOutput(id, language, mode));
  require('node:fs').writeFileSync(process.env.DUMP_BASELINE, JSON.stringify(table, null, 1) + '\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// The chapter template through the chain.

const BOOK_ID = 'book-chapter';
const hasBook = () => M.BUILTIN_BLOCKS.some(block => block.category === 'template' && block.id === BOOK_ID);

test('the chapter template is built in and parses in all three languages: lead kept, omit-empty, sources then Research notes', () => {
  assert.ok(hasBook(), 'registered');
  for (const language of LANGUAGES) {
    const text = M.builtinTemplateText(BOOK_ID, language);
    const parsed = M.parseTemplateBlock(text, { id: BOOK_ID, name: BOOK_ID });
    assert.equal(parsed.ok, true, language);
    assert.ok(parsed.lead.length > 0, `${language}: the block keeps its lead`);
    const names = parsed.template.sections.map(section => section.name);
    assert.equal(parsed.template.sections.length, 2, language);
    assert.equal(parsed.template.sections[0].role, 'sources', language);
    assert.equal(parsed.template.sections[1].role, 'log', `${language}: Research notes takes the log role`);
    assert.equal(names[1], language === 'en' ? 'Research notes' : '研究備註');
    assert.equal(M.BUILTIN_BLOCKS.find(block => block.id === BOOK_ID).omitEmpty, true);
  }
});

test('fresh write-back: exactly one Research notes section at the end, folded callout, lead and free body and the AI sub-heading kept', () => {
  for (const language of LANGUAGES) {
    const note = M.noteLanguageOf(language);
    const template = builtinTemplate(BOOK_ID, language);
    const name = logName(template);
    const detail = write(template, note, 'fresh', oldFor(template, note), replyFor(template, 'A'));
    assert.equal(count(detail, `### ${name}`), 1, `${language}: one section`);
    assert.ok(detail.trimEnd().split('\n').slice(-6).join('\n').includes(`### ${name}`), 'it is the last section');
    assert.ok(/^> \[!note\]- \S/m.test(detail), `${language}: a folded callout`);
    assert.ok(detail.includes(`> [!note]- ${name}`), `${language}: the callout title is the section name`);
    assert.ok(!detail.includes('更新紀錄'), `${language}: no 更新紀錄 anywhere`);
    assert.ok(!detail.includes(`### ${M.translate(note, 'detail.update_log')}`), 'no second log section');
    assert.ok(detail.startsWith('導讀 LEAD-A'), 'the lead stays on top');
    assert.ok(detail.includes('### 自訂小標\n\n自由正文 FREE-A'), 'the AI sub-heading and the free body stay as written');
    assert.ok(detail.includes('- [[來源A]]'), 'sources kept');
  }
});

test('second fresh write-back keeps the old log lines and adds exactly one; the old Update log lines are not lost', () => {
  const language = 'zh-TW';
  const note = 'zh-TW';
  const template = builtinTemplate(BOOK_ID, language);
  const noteOld = oldFor(template, note);
  const first = write(template, note, 'fresh', noteOld, replyFor(template, 'A'));
  const lines = detail => detail.split('\n').filter(line => /^> (?:- )?\d{4}-\d{2}-\d{2}/.test(line));
  assert.equal(lines(first).length, 3, 'two old lines and one new');
  assert.ok(first.includes('舊紀錄一') && first.includes('舊紀錄二'));
  const second = write(template, note, 'fresh', first, replyFor(template, 'B'));
  assert.equal(lines(second).length, 4, 'one more line only');
  assert.deepEqual(lines(second).slice(0, 3), lines(first), 'the earlier lines come first, in order');
  assert.equal(count(second, '### 研究備註'), 1);
  // An old note that only has "### 更新紀錄" (an old standard note): its lines come into the new section in fresh, merge and top.
  const legacy = ['### 核心結論', '', '舊結論', '', '### 更新紀錄', '', '- 2026-01-01　舊紀錄一', '- 2026-02-01　舊紀錄二'].join('\n');
  for (const mode of ['fresh', 'merge', 'top']) {
    const result = write(template, note, mode, legacy, replyFor(template, 'C'));
    assert.ok(result.includes('舊紀錄一') && result.includes('舊紀錄二'), `${mode}: old log lines kept`);
    if (mode !== 'top') assert.equal(count(result, '### 更新紀錄'), 0, `${mode}: one log section only`);
    // top keeps the old text byte for byte, so the legacy heading stays there; fresh and merge move the lines into Research notes.
    if (mode !== 'top') {
      assert.ok(count(result, '研究備註') >= 1, `${mode}: Research notes section`);
      assert.ok(!result.includes('更新紀錄'), `${mode}: no 更新紀錄 anywhere`);
    } else assert.ok(count(result, '研究備註') + count(result, '### 更新紀錄') >= 1);
  }
});

test('top and merge on a note that already has a folded Research notes section: old lines stay, one line is added inside the callout', () => {
  const note = 'zh-TW';
  const template = builtinTemplate(BOOK_ID, 'zh-TW');
  const first = write(template, note, 'fresh', oldFor(template, note), replyFor(template, 'A'));
  for (const mode of ['top', 'merge']) {
    const result = write(template, note, mode, first, replyFor(template, 'B'));
    const lines = result.split('\n').filter(line => /^> (?:- )?\d{4}-\d{2}-\d{2}/.test(line));
    assert.equal(lines.length, 4, `${mode}: 3 old + 1`);
    assert.equal(count(result, '### 研究備註'), 1, mode);
    assert.equal(count(result, '[!note]-'), 1, `${mode}: one callout`);
    assert.ok(!result.includes('更新紀錄'), `${mode}: no 更新紀錄 anywhere`);
  }
  // top keeps the old text byte for byte apart from the inserts
  const top = M.composeWriteback({ mode: 'top', oldDetail: first, aiDetail: replyFor(template, 'B'), summary: 'S', template, language: note, now: NOW });
  assert.equal(top.ok, true);
  let position = 0;
  const pieces = [];
  for (const insert of top.record.inserts) {
    pieces.push(top.detail.slice(position, insert.offset));
    position = insert.offset + insert.text.length;
  }
  pieces.push(top.detail.slice(position));
  assert.equal(pieces.join(''), first);
});

test('a "###" line inside the Research notes callout is not a new section; a note with both log names gives the role to Update log only', () => {
  const note = 'zh-TW';
  const template = builtinTemplate(BOOK_ID, 'zh-TW');
  const withHeading = ['導讀', '', '### 研究備註', '', '> [!note]- 更新紀錄', '> ### 不是區段', '> - 2026-01-01　舊紀錄一'].join('\n');
  const result = write(template, note, 'fresh', withHeading, replyFor(template, 'D'));
  assert.ok(result.includes('> ### 不是區段'), 'the callout line stays');
  assert.ok(result.includes('舊紀錄一'));
  assert.equal(count(result, '### 研究備註'), 1);
  // custom template with both names
  const both = M.parseTemplateBlock('## 核心\n說明\n\n## 更新紀錄\n只新增一行\n\n## 研究備註\n別的\n', { id: 'both', name: 'both' });
  assert.equal(both.ok, true);
  assert.deepEqual(plain(both.template.sections.map(section => section.role)), ['none', 'log', 'none']);
  const twice = M.parseTemplateBlock('## 核心\n說明\n\n## 研究備註\n甲\n\n## Research notes\n乙\n', { id: 'two', name: 'two' });
  assert.equal(twice.ok, true);
  assert.deepEqual(plain(twice.template.sections.map(section => section.role)), ['none', 'log', 'none']);
  // standard templates keep the old behaviour: the log name is still the Update log
  assert.equal(logName(builtinTemplate('standard', 'zh-TW')), '更新紀錄');
});

test('a Detail the AI wrote with a Research notes heading maps to the log role (AI suggested style)', () => {
  const made = M.templateFromDetail('### 核心\n\n內容\n\n### 研究備註\n\n- 2026-01-01　x', 'zh-TW');
  assert.equal(made.ok, true);
  assert.deepEqual(plain(made.template.sections.map(section => section.role)), ['none', 'log']);
});

// ---------------------------------------------------------------------------------------------------------------------
// Repository: root issue sections survive, and the guarded write (P0b).

test('a root topic "## 全書企劃" section is unchanged by a fresh Detail write-back through the repository', async () => {
  const { repo, contents } = S.fixture('zh-TW');
  const note = await S.topicNote(repo, '根議題');
  const plan = '## 全書企劃\n\n全書主線：甲\n\n- 登記 1\n- 登記 2\n';
  contents.set(note.path, `${contents.get(note.path).trimEnd()}\n\n${plan}`);
  const before = contents.get(note.path);
  assert.ok(before.includes(plan));
  const template = builtinTemplate(BOOK_ID, 'zh-TW');
  const detail = write(template, 'zh-TW', 'fresh', (await repo.readNote(note.path)).detail, replyFor(template, 'E'));
  await repo.updateNote(note.path, { detail, summary: '新摘要' });
  const after = contents.get(note.path);
  assert.ok(after.includes(plan), 'the section is byte for byte there');
  assert.equal(count(after, '## 全書企劃'), 1);
  assert.ok(after.includes('LEAD-E'));
});

async function guarded() {
  const env = S.fixture('zh-TW');
  const note = await S.topicNote(env.repo, '題目');
  await env.repo.updateNote(note.path, { detail: '原始內容 ORIGINAL', summary: '舊摘要' });
  return { ...env, note, expected: env.contents.get(note.path) };
}

test('without the guard options it is updateNote: it writes and reports written, and updateNote itself still resolves with nothing', async () => {
  const { repo, note, contents } = await guarded();
  assert.equal(await repo.updateNoteGuarded(note.path, { detail: '新內容 N' }), 'written');
  assert.ok(contents.get(note.path).includes('新內容 N'));
  assert.equal(await repo.updateNote(note.path, { detail: '新內容 M' }), undefined);
  assert.ok(contents.get(note.path).includes('新內容 M'));
});

test('expectedContent: a file that is still the expected text is written; a different file is left alone and reported discarded', async () => {
  const { repo, note, contents, expected } = await guarded();
  assert.equal(await repo.updateNoteGuarded(note.path, { detail: '新內容 N1' }, { expectedContent: 'something else' }), 'discarded');
  assert.equal(contents.get(note.path), expected, 'nothing written');
  assert.equal(await repo.updateNoteGuarded(note.path, { detail: '新內容 N2' }, { expectedContent: expected }), 'written');
  assert.ok(contents.get(note.path).includes('新內容 N2'));
});

test('counterexample: the owner edits the file after the last read and before the write callback: discarded, the owner text stays', async () => {
  const { repo, app, note, contents, expected } = await guarded();
  const original = app.vault.process;
  const OWNER = `${expected}\nOWNER-EDIT-4821`;
  app.vault.process = async (file, change) => {
    contents.set(file.path, OWNER); // the owner types between our last read and Obsidian running the callback
    return original(file, change);
  };
  assert.equal(await repo.updateNoteGuarded(note.path, { detail: '寫回 W' }, { expectedContent: expected }), 'discarded');
  assert.equal(contents.get(note.path), OWNER, 'the owner edit is untouched');
});

test('authorize runs inside the write callback: false discards, true writes, and it is not called when expectedContent already failed', async () => {
  const { repo, note, contents, expected } = await guarded();
  const calls = [];
  assert.equal(await repo.updateNoteGuarded(note.path, { detail: 'X1' }, { authorize: () => (calls.push('a'), false) }), 'discarded');
  assert.equal(contents.get(note.path), expected);
  assert.equal(await repo.updateNoteGuarded(note.path, { detail: 'X2' }, { expectedContent: 'other', authorize: () => (calls.push('b'), true) }), 'discarded');
  assert.deepEqual(calls, ['a'], 'a failed content check never reaches authorize');
  assert.equal(await repo.updateNoteGuarded(note.path, { detail: 'X3' }, { expectedContent: expected, authorize: () => (calls.push('c'), true) }), 'written');
  assert.deepEqual(calls, ['a', 'c']);
  assert.ok(contents.get(note.path).includes('X3'));
});

test('authorize revoked after the content check but within the same callback still discards (revoked while queued)', async () => {
  const { repo, app, note, contents, expected } = await guarded();
  let authorized = true;
  const original = app.vault.process;
  app.vault.process = async (file, change) => {
    authorized = false; // the run is stopped while the write waits for its turn
    return original(file, change);
  };
  assert.equal(await repo.updateNoteGuarded(note.path, { detail: 'Y' }, { expectedContent: expected, authorize: () => authorized }), 'discarded');
  assert.equal(contents.get(note.path), expected);
});

test('the restore after a cancel or an error is guarded the same way: a status restore with a revoked authorize writes nothing', async () => {
  const { repo, note, contents, expected } = await guarded();
  assert.equal(await repo.updateNoteGuarded(note.path, { status: 'error', lastError: 'x' }, { authorize: () => false }), 'discarded');
  assert.equal(contents.get(note.path), expected);
});
