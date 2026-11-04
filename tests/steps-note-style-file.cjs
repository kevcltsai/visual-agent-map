// Note style files (P1a): parsing, comment removal, fail-closed validation, frozen legacy export.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./support-replay.cjs');

const S = loadSource(`
export * from "./ai/note-style-file";
export { sectionLookup, checkCounts, standardTemplate, textbookTemplate, sourcesHeadingKeys, detailStructurePrompt } from "./ai/detail-templates";
export { canonicalDetail } from "./ai/result-utils";
export { SECTION_NAME, sectionAliasRows, sectionAliasesFor, isNewSourcesHeading, NEW_STANDARD_HEADING_KEYS } from "./ai/section-aliases";
export { assembleTaskPrompt, selectionFromContext, promptStepOf } from "./core/steps/task/assemble";
`);
const plain = value => structuredClone(value);
const eq = (actual, expected) => assert.deepEqual(plain(actual), plain(expected));
const parse = (text, name = 'A') => S.parseNoteStyleFile(text, { id: `style:${name}`, name });
const ok = text => {
  const result = parse(text);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  return result.style;
};
const fail = (text, code) => {
  const result = parse(text);
  assert.equal(result.ok, false);
  assert.ok(result.issues.length > 0);
  for (const found of result.issues) assert.ok(found.line >= 1 && Number.isInteger(found.line));
  if (code) assert.ok(result.issues.some(found => found.code === code), `${code} in ${JSON.stringify(result.issues)}`);
  return result.issues;
};

const OWNER_EXAMPLE = `---
語氣: 親切白話，短句；專有名詞第一次出現先用一句話解釋
圖表: 關
---
先用 2–4 段導讀帶讀者進入主題。

## 核心結論
> [!summary]
> 用 1–3 句講最重要的結論。

## 常見誤解
> [!warning]
> 用「初學者常以為…，其實…」的句型。
`;

test('owner example parses into the expected structure', () => {
  const style = ok(OWNER_EXAMPLE);
  assert.equal(style.tone, '親切白話，短句；專有名詞第一次出現先用一句話解釋');
  assert.equal(style.layout, 'intro');
  assert.equal(style.intro, '先用 2–4 段導讀帶讀者進入主題。');
  eq(style.sections.map(s => s.name), ['核心結論', '常見誤解']);
  eq(style.sections.map(s => s.callouts.map(c => [c.type, c.body])), [
    [['summary', '用 1–3 句講最重要的結論。']],
    [['warning', '用「初學者常以為…，其實…」的句型。']]
  ]);
  eq(style.sections.map(s => s.description), ['', '']);
  eq(style.sections.map(s => s.line), [7, 11]);
  assert.equal(style.template.sections, style.sections);
});

test('frontmatter: keys in three languages, toggles, defaults, ignored keys and lists', () => {
  const s = ok('---\ntags:\n  - a\n- b\nfoo: bar\n语气: x\n方框: 指定\n图表: off\ntables: FALSE\n待辦清單: 關\nhighlight: 開\n---\n## A\nbody');
  const text = '---\ntags:\n  - a\n- b\nfoo: bar\n语气: x\n方框: 指定\n图表: off\ntables: FALSE\n待辦清單: 關\nhighlight: 開\n---\n## A\nbody';
  eq([s.tone, s.layout], ['x', 'sections']);
  const d = ok('## A\nx');
  eq([d.tone, d.layout], [undefined, 'sections']);
  assert.equal(ok('---\n語氣: "quoted"\n---\n## A').tone, 'quoted');
});

test('fail closed with line numbers and no repair', () => {
  const sections = n => Array.from({ length: n }, (_, i) => `## S${i}\nx`).join('\n');
  assert.equal(fail('---\n語氣: x\n## A', 'frontmatter_unclosed')[0].line, 1);
  // The old switches no longer fail the parser (skipped).
  ok('---\n語氣: x\nnot a pair\n---\n## A');
  assert.equal(fail('just text, no heading', 'no_sections').length, 1);
  assert.equal(fail('# only h1\ntext\n### h3', 'no_sections')[0].code, 'no_sections');
  fail(sections(13), 'ui.detail_template_error_section_count');
  fail('## C# 語言\nx', 'ui.detail_template_error_section_name_invalid');
  assert.equal(fail('---\nx: 1\n---\n\n## A\nx\n## a\ny', 'ui.detail_template_error_section_name_taken')[0].line, 7);
  fail('##\nx', 'ui.detail_template_error_section_name_required');
  fail(`## ${'a'.repeat(41)}\nx`, 'ui.detail_template_error_section_name_long');
  fail(`## A\n${'x'.repeat(8000)}`, 'file_long');
  fail(`---\n語氣: ${'x'.repeat(1001)}\n---\n## A`, 'tone_long');
  ok('---\n圖表: maybe\n---\n## A');
  ok('---\n方框: sometimes\n---\n## A');
  fail('## 證據與來源\nx\n## Evidence and sources\ny', 'ui.detail_template_error_role_taken');
  fail('## 更新紀錄\nx\n## 更新记录\ny', 'ui.detail_template_error_role_taken');
  fail('## A\n數量: 0', 'ui.detail_template_error_count_range');
  fail('## A\n數量: 21', 'ui.detail_template_error_count_range');
  assert.equal(fail('## A\nx\n## B\nCount: many', 'count_invalid')[0].line, 4);
  assert.equal(fail('## A\nx\n%% never closed\n', 'comment_unclosed')[0].line, 3);
});

test('a description may be long: only the file limit applies', () => {
  const style = ok(`## A\n${'x'.repeat(2000)}`);
  assert.equal(style.sections[0].description.length, 2000);
});

test('comments: single and multi line vanish, never form an intro, keep line numbers', () => {
  const style = ok('%% a note to myself %%\n\n%% multi\nline\n%%\n## A\nkeep %% inline %% this\n%% x\ny %%\n## B\ntext');
  assert.equal(style.layout, 'sections');
  assert.equal(style.intro, '');
  assert.equal(style.sections[0].description, 'keep  this');
  eq(style.sections.map(s => s.line), [6, 10]);
  assert.equal(JSON.stringify(style).includes('multi'), false);
  const bad = fail('%% c %%\n## A\nx\n## A\ny');
  assert.equal(bad[0].line, 4);
});

test('comments: %% inside a code block is kept, and a heading inside a code block is not a section', () => {
  const style = ok('## A\n```\n%% not a comment %%\n## not a heading\n```\n~~~md\n%%\n~~~\nafter');
  assert.equal(style.sections.length, 1);
  assert.ok(style.sections[0].description.includes('%% not a comment %%'));
  assert.ok(style.sections[0].description.includes('## not a heading'));
  assert.ok(style.sections[0].description.includes('after'));
  eq(S.stripNoteStyleComments('a %% b %% c\n```\n%% d\n```').text, 'a  c\n```\n%% d\n```');
});

test('comments: changing only the usage comment keeps the parsed structure the same', () => {
  const original = '---\n語氣: x\n---\n%% the usage comment %%\n\n## A\nbody\n';
  const edited = original.replace(/^%% .* %%$/m, '%% my own words %%');
  assert.notEqual(edited, original);
  const a = ok(original);
  const b = ok(edited);
  assert.deepEqual(plain(b), plain(a));
});

test('sections: count lines, callouts of any type with folds, nested quotes and plain blockquotes', () => {
  const style = ok('## A\n數量: 至少 3\n說明一\n> [!tip]- 標題\n> 第一行\n> 第二行\n> > [!note] nested\n\n說明二\n> 普通引用\n> [!custom-type]+\n> body\n## B\nCount: 2\n## C\nCount: at least 4\n> > [!quote] only nested');
  const [a, b, c] = style.sections;
  eq(a.count, { mode: 'min', n: 3 });
  eq(a.callouts.map(x => [x.type, x.fold, x.title, x.body]), [
    ['tip', '-', '標題', '第一行\n第二行\n> [!note] nested'],
    ['custom-type', '+', '', 'body']
  ]);
  assert.equal(a.description, '說明一\n\n說明二\n> 普通引用');
  eq(b.count, { mode: 'exact', n: 2 });
  eq(c.count, { mode: 'min', n: 4 });
  eq(c.callouts, []);
  assert.ok(c.description.includes('[!quote]'));
});

test('count lines feed checkCounts through the template', () => {
  const style = ok('## 清單\n數量: 3\n列出三項');
  assert.equal(S.checkCounts('### 清單\n- a\n- b', style.template).length, 1);
  assert.equal(S.checkCounts('### 清單\n- a\n- b\n- c', style.template).length, 0);
});

test('roles and aliases come from the standard section names in any language', () => {
  const style = ok('## Evidence and sources\nx\n## 更新记录\ny\n## Core conclusions\nz\n## Mine\nw');
  eq(style.sections.map(s => s.role), ['sources', 'log', 'none', 'none']);
  eq(style.sections[0].aliases, ['證據與來源']);
  eq(style.sections[2].aliases, ['核心結論']);
  eq(style.sections[3].aliases, []);
  assert.equal(S.sectionLookup(style.template).get('證據與來源'), 0);
});

test('CRLF files parse like LF files', () => {
  const lf = ok(OWNER_EXAMPLE);
  const crlf = ok(OWNER_EXAMPLE.replace(/\n/g, ' \r\n'));
  assert.deepEqual(plain(crlf), plain(lf));
});

const LEGACY = {
  id: 'uuid-1',
  name: '我的模板',
  sections: [
    { id: 'a', name: '核心結論', description: '先講結論', role: 'none', count: { mode: 'min', n: 3 }, aliases: [] },
    { id: 'b', name: '步驟', description: '', role: 'none', count: { mode: 'exact', n: 2 }, aliases: ['做法'] },
    { id: 'c', name: '證據與來源', description: '第一行\n第二行', role: 'sources', aliases: [] },
    { id: 'd', name: '更新紀錄', description: '', role: 'log', aliases: [] }
  ]
};

test('serializeLegacyV1 bytes are frozen', () => {
  assert.equal(
    S.serializeLegacyV1(LEGACY, 'zh-TW'),
    '---\n方框: 自動\n---\n%% 這個檔決定 AI 怎麼寫「我的模板」風格的筆記。改完存檔，下次 AI 更新就照新內容寫，已寫好的筆記不會變。 %%\n\n' +
      '## 核心結論\n數量: 至少 3\n先講結論\n\n## 步驟\n數量: 2\n\n## 證據與來源\n第一行\n第二行\n\n## 更新紀錄\n'
  );
  assert.equal(
    S.serializeLegacyV1({ ...LEGACY, name: 'Mine' }, 'en'),
    '---\ncallouts: auto\n---\n%% This file decides how the AI writes notes in the "Mine" style. Save your edits and the next AI update follows them; notes already written do not change. %%\n\n' +
      '## 核心結論\nCount: at least 3\n先講結論\n\n## 步驟\nCount: 2\n\n## 證據與來源\n第一行\n第二行\n\n## 更新紀錄\n'
  );
  assert.equal(
    S.serializeLegacyV1({ ...LEGACY, name: '我的' }, 'zh-CN').split('\n').slice(0, 4).join('\n'),
    '---\n方框: 自动\n---\n%% 这个文件决定 AI 怎么写「我的」风格的笔记。改完保存，下次 AI 更新就按新内容写，已写好的笔记不会变。 %%'
  );
  assert.equal(S.serializeLegacyV1(LEGACY, 'zh-TW').includes('恢復預設'), false);
});

test('a legacy export parses back to the same sections, counts, roles and the usage comment is first', () => {
  for (const language of ['zh-TW', 'zh-CN', 'en']) {
    const text = S.serializeLegacyV1(LEGACY, language);
    const style = ok(text);
    assert.equal(style.layout, 'sections');
    eq(style.sections.map(s => s.name), LEGACY.sections.map(s => s.name));
    eq(style.sections.map(s => s.count), LEGACY.sections.map(s => s.count));
    eq(style.sections.map(s => s.description), LEGACY.sections.map(s => s.description));
    eq(style.sections.map(s => s.role), ['none', 'none', 'sources', 'log']);
    const lines = text.split('\n');
    assert.ok(lines[3].startsWith('%% ') && lines[3].endsWith(' %%'));
  }
});

test('normalizeStyleContent', () => {
  assert.equal(S.normalizeStyleContent('﻿a  \r\nb\t\r\n\r\n'), 'a\nb\n');
  assert.equal(S.normalizeStyleContent('a\n'), S.normalizeStyleContent('a'));
});

test('callout rule keys (counter 18): bad values, empty values, duplicates and custom types in the frontmatter are skipped by the parser, which reads the sections', () => {
  for (const text of ['---\n結論方框: banana\n---\n## A', '---\n語氣: x\n問題方框:\n---\n## A', '---\n風險方框: my-custom\n---\n## A',
    '---\n結論方框: note\n語氣: x\n结论方框: info\n---\n## A', '---\ntip callout: note\n技巧方框: info\n---\n## A', '---\n技巧方框: summary callout\n---\n## A']) {
    assert.equal(ok(text).sections.length, 1, 'the parser skips the line and reads the sections');
  }
  assert.equal(ok('---\n語氣: x\n問題方框:\n---\n## A').tone, 'x');
  // the only frontmatter error left is one that never closes
  assert.equal(fail('---\n結論方框: note\n## A', 'frontmatter_unclosed')[0].line, 1);
});

// ---- note-style-editorial K1: section aliases, role detection, omitEmpty (0.29.0 compatibility) ----
const fs = require('node:fs');
const path = require('node:path');
const FIXTURES = path.join(__dirname, 'fixtures', 'note-style-0.29.0');
const oldNote = type => fs.readFileSync(path.join(FIXTURES, `${type}.md`), 'utf8').trimEnd();
const N = S.SECTION_NAME;
const zh = value => value['zh-TW'];
// The new structures of the redesign, as style files (section names only; K2 writes the real built-in texts).
const NEW_STRUCTURES = {
  standard: ['核心結論', '背景與機制', '不同看法與限制', '待確認問題', zh(N.sources), zh(N.log)],
  atomic: [zh(N.oneSentence), zh(N.why), '例子', '和誰不同', zh(N.source), zh(N.log)],
  hypothesis: ['主張', '目前判斷', zh(N.ifTrue), '什麼會推翻它', '驗證方式', zh(N.evidenceTable), zh(N.sources), zh(N.log)],
  evidence: [zh(N.summary), '原文或數據', '怎麼得到的', '可信度', zh(N.relatedTopics), zh(N.source), zh(N.log)],
  conclusion: ['結論', zh(N.confidence), '依據', '什麼會改變這個結論', zh(N.scope), zh(N.impact), zh(N.sources), zh(N.log)],
  action: ['狀態', zh(N.goalDone), '下一步', zh(N.steps), '阻礙與風險', '預期產出', zh(N.references), zh(N.log)]
};
const structureFile = names => names.map(name => `## ${name}\n`).join('\n');
const styleOf = type => ok(structureFile(NEW_STRUCTURES[type]));
const indexOf = (style, name) => style.sections.findIndex(section => section.name === name);
const lookupOf = style => S.sectionLookup(style.template);

test('K1 alias table: every old name of every row maps to the new section, in zh-TW, zh-CN spellings of the standard rows and en', () => {
  const rows = S.sectionAliasRows();
  assert.ok(rows.length >= 14);
  for (const row of rows) {
    for (const current of row.names) {
      const style = ok(`## ${current}\n\n## 更新紀錄\n`);
      const lookup = lookupOf(style);
      for (const alias of row.aliases) assert.equal(lookup.get(alias.toLocaleLowerCase()), 0, `${alias} -> ${current}`);
    }
  }
});

test('K1 alias table: the plan rows, spelled out (old name -> new section)', () => {
  const expected = [
    ['standard', '證據與來源', zh(N.sources)], ['standard', '证据与来源', zh(N.sources)], ['standard', 'Evidence and sources', zh(N.sources)],
    ['standard', '關鍵知識', '背景與機制'], ['standard', '关键知识', '背景與機制'], ['standard', 'Key knowledge', '背景與機制'],
    ['standard', '取捨與限制', '不同看法與限制'], ['standard', '取舍与限制', '不同看法與限制'], ['standard', 'Tradeoffs and limitations', '不同看法與限制'],
    ['standard', '待確認事項', '待確認問題'], ['standard', '待确认事项', '待確認問題'], ['standard', 'Open questions', '待確認問題'],
    ['atomic', '定義', zh(N.oneSentence)], ['atomic', 'Definition', zh(N.oneSentence)], ['atomic', '解釋', zh(N.why)], ['atomic', 'Explanation', zh(N.why)],
    ['atomic', '證據與來源', zh(N.source)],
    ['hypothesis', '預測', zh(N.ifTrue)], ['hypothesis', 'Prediction', zh(N.ifTrue)],
    ['hypothesis', '支持', zh(N.evidenceTable)], ['hypothesis', '反駁', zh(N.evidenceTable)], ['hypothesis', 'Support', zh(N.evidenceTable)], ['hypothesis', 'Counterevidence', zh(N.evidenceTable)],
    ['evidence', '內容', zh(N.summary)], ['evidence', 'Content', zh(N.summary)], ['evidence', '支持或反駁', zh(N.relatedTopics)], ['evidence', 'Supports or refutes', zh(N.relatedTopics)],
    ['conclusion', '信心程度', zh(N.confidence)], ['conclusion', '適用範圍與限制', zh(N.scope)], ['conclusion', 'Scope and limits', zh(N.scope)],
    ['conclusion', '後續行動', zh(N.impact)], ['conclusion', 'Next actions', zh(N.impact)],
    ['action', '目標', zh(N.goalDone)], ['action', '完成條件', zh(N.goalDone)], ['action', 'Goal', zh(N.goalDone)], ['action', 'Done when', zh(N.goalDone)],
    ['action', '檢查點', zh(N.steps)], ['action', 'Checkpoints', zh(N.steps)]
  ];
  for (const [type, old, now] of expected) {
    const style = styleOf(type);
    assert.equal(lookupOf(style).get(old.toLocaleLowerCase()), indexOf(style, now), `${type}: ${old} -> ${now}`);
  }
  // The English names of the new sections are constants K2 reuses.
  assert.equal(N.evidenceTable.en, 'Evidence table');
  assert.equal(N.confidence.en, 'Confidence');
  assert.equal(N.steps.en, 'Steps');
});

test('K1 role detection: every new structure has exactly one sources section and one log section; the new sources names carry the role', () => {
  for (const type of Object.keys(NEW_STRUCTURES)) {
    const style = styleOf(type);
    assert.equal(style.sections.filter(section => section.role === 'sources').length, 1, `${type} sources`);
    assert.equal(style.sections.filter(section => section.role === 'log').length, 1, `${type} log`);
    assert.equal(style.sections[style.sections.length - 1].role, 'log');
  }
  for (const heading of ['來源', '出處', '參考資料', '来源', '出处', '参考资料', 'Sources', 'Source', 'References', 'references'])
    assert.equal(ok(`## 摘要\n\n## ${heading}\n`).sections[1].role, 'sources', heading);
  assert.equal(ok('## 摘要\n\n## 備註\n').sections.some(section => section.role === 'sources'), false);
  // The sources role finds the old footnote home of an old note: sourcesHeadingKeys knows the old name
  const keys = S.sourcesHeadingKeys(styleOf('standard').template);
  for (const heading of ['證據與來源', '证据与来源', 'evidence and sources', '來源', '出處', '參考資料', 'sources']) assert.ok(keys.has(heading.toLocaleLowerCase()), heading);
});

test('K1 counterexample: an alias equal to another section\'s current name loses to that name', () => {
  // 證據對照 has the aliases 支持 and 反駁, but this file also has a section named 支持
  const style = ok(structureFile(['主張', '支持', zh(N.evidenceTable), zh(N.sources), zh(N.log)]));
  const lookup = lookupOf(style);
  assert.equal(lookup.get('支持'), indexOf(style, '支持'));
  assert.equal(lookup.get('反駁'), indexOf(style, zh(N.evidenceTable)));
  const table = style.sections[indexOf(style, zh(N.evidenceTable))];
  assert.equal(table.aliases.includes('支持'), false);
  assert.equal(table.aliases.includes('反駁'), true);
});

test('K1 counterexample: a file with no new names keeps main\'s roles, aliases and lookup', () => {
  const style = ok('## 核心結論\n\n## 常見誤解\n\n## 證據與來源\n\n## 更新紀錄\n');
  eq(style.sections.map(section => section.role), ['none', 'none', 'sources', 'log']);
  eq(style.sections.map(section => section.id), ['core', 's2', 'sources', 'log']);
  eq(style.sections.map(section => section.aliases), [['Core conclusions'], [], ['Evidence and sources'], ['Update log']]);
  const lookup = lookupOf(style);
  assert.equal(lookup.get('檢查點'), undefined);
  assert.equal(lookup.get('來源'), undefined);
  assert.equal(lookup.get('关键知识'), undefined);
});

test('K1 counterexample: an old sources section keeps the role when a new sources name is also in the file (one sources section only)', () => {
  const style = ok('## 核心結論\n\n## 參考資料\n\n## 證據與來源\n\n## 更新紀錄\n');
  eq(style.sections.map(section => section.role), ['none', 'none', 'sources', 'log']);
  assert.equal(lookupOf(style).get('參考資料'), 1, 'the new name stays a section of its own');
});

test('K1 canonicalDetail: old-note headings land in the new sections and footnotes go to the sources section', () => {
  const style = styleOf('standard');
  const out = S.canonicalDetail(oldNote('standard'), 'zh-TW', style.template);
  const headings = out.split('\n').filter(line => line.startsWith('### '));
  eq(headings, style.sections.map(section => `### ${section.name}`));
  assert.ok(out.includes('### 背景與機制\n\n舊知識 KNOW-0290'));
  assert.ok(out.includes('### 不同看法與限制\n\n舊取捨 TRADE-0290'));
  assert.ok(out.includes('### 待確認問題\n\n舊問題 QUESTION-0290'));
  const sources = out.slice(out.indexOf('### 來源'), out.indexOf('### 更新紀錄'));
  assert.ok(sources.includes('[^1]: 舊註腳一') && sources.includes('[^src-1]: [[舊來源一]]') && sources.includes('- [[舊來源二]]'));
  assert.ok(out.includes('| A | 低 | 中 |'), 'the table survives');
});

test('K1 canonicalDetail: the old hypothesis note keeps both 支持 and 反駁 under one 證據對照 section and loses nothing', () => {
  const style = styleOf('hypothesis');
  const out = S.canonicalDetail(oldNote('hypothesis'), 'zh-TW', style.template);
  const table = out.slice(out.indexOf('### 證據對照'), out.indexOf('### 來源'));
  assert.ok(table.includes('SUPPORT-0290') && table.includes('REFUTE-0290') && table.includes('| 實驗一 | 高 |'));
  assert.equal((out.match(/### 證據對照/g) ?? []).length, 1);
  assert.ok(out.includes('JUDGE-A-0290') && out.includes('JUDGE-B-0290'));
  assert.ok(out.includes('### 如果成立會看到\n\n舊預測 PREDICT-0290'));
});

test('K1 canonicalDetail: every 0.29.0 fixture keeps all its content and footnotes under a structure with the new names', () => {
  for (const type of ['atomic', 'evidence', 'conclusion', 'action', 'hypothesis', 'standard']) {
    const note = oldNote(type);
    const out = S.canonicalDetail(note, 'zh-TW', styleOf(type).template);
    for (const token of note.match(/[A-Z]+(?:-[A-Z])?-0290/g)) assert.ok(out.includes(token), `${type}: ${token}`);
    assert.ok(out.includes('[^1]: 舊註腳'), `${type} footnote`);
    assert.ok(out.includes('[^src-1]: [[舊來源'), `${type} source footnote`);
  }
});

const OMIT = template => ({ ...template, omitEmpty: true });
test('K1 omitEmpty: set, empty and placeholder-only sections are left out and nothing is filled; unset, the placeholder is still written', () => {
  const style = styleOf('atomic');
  const reply = '### 一句話\n\n回饋迴圈是輸出影響輸入。\n\n### 為什麼\n\n本次無新增內容。\n\n### 出處\n\n本次無新增內容\n\n[^1]: [[來源一]]\n\n### 更新紀錄\n\n2026-11-04　寫入';
  const omitted = S.canonicalDetail(reply, 'zh-TW', OMIT(style.template));
  assert.equal(omitted, '### 一句話\n\n回饋迴圈是輸出影響輸入。\n\n### 出處\n\n[^1]: [[來源一]]\n\n### 更新紀錄\n\n2026-11-04　寫入');
  assert.equal(omitted.includes('本次無新增內容'), false);
  const filled = S.canonicalDetail(reply, 'zh-TW', style.template);
  assert.ok(filled.includes('### 例子\n\n本次無新增內容。'));
  assert.equal((filled.match(/本次無新增內容/g) ?? []).length >= 3, true);
  // en placeholder wording is omitted as well
  assert.equal(S.canonicalDetail('### Summary\n\nx\n\n### Source\n\nNo new content this time', 'en', OMIT(ok('## Summary\n\n## Source\n\n## Update log\n').template)), '### Summary\n\nx');
});

test('K1 omitEmpty: the structure text says to omit a whole empty section and that this beats the later format rule; unset, it does not', () => {
  const style = styleOf('evidence');
  const prompt = (template, language) => S.detailStructurePrompt(template, language, headings => `STANDARD ${headings}`);
  assert.match(prompt(OMIT(style.template), 'zh-TW'), /整段省略[^]*優先於後面格式規則/);
  assert.match(prompt(OMIT(style.template), 'en'), /Leave out a whole section[^]*overrides the later formatting rule/);
  assert.match(prompt(OMIT(style.template), 'zh-TW'), /### 摘要, ### 可信度|### 摘要/);
  assert.doesNotMatch(prompt(style.template, 'zh-TW'), /整段省略/);
  assert.match(prompt(style.template, 'zh-TW'), /沒有適用內容的段落寫「本次無新增內容」/);
  // the section rules (log, descriptions, counts) still follow
  const described = ok('## 摘要\n一到三句。\n\n## 更新紀錄\n一行。\n');
  const text = prompt(OMIT(described.template), 'en');
  assert.ok(text.includes('### 摘要') && text.includes('一到三句。') && text.includes('### 更新紀錄'));
});

test('K1 omitEmpty reaches the lead-in path of the assembler: a template block with a lead and omitEmpty omits empty sections too', () => {
  const style = ok('## 摘要\n\n## 更新紀錄\n');
  const base = { title: 'T', summary: 'S', rules: '', detail: '', task: 'X', ancestors: '', workingFindings: '', sourceContext: '', mode: 'task', researchMode: 'local', researchDepth: 'normal', visualMode: 'off', outputLanguage: 'en' };
  const run = template => {
    const context = { ...base, detailTemplate: template };
    const selection = { ...S.selectionFromContext(context, 'en'), template: { id: 'atomic', body: 'LEAD-X sentence.\n\n## Summary\n\nOne to three sentences.\n\n## Update log\n\nOne line.\n' } };
    return S.assembleTaskPrompt(selection, S.promptStepOf(context), context, 'en').text;
  };
  const withFlag = run({ ...OMIT(style.template), id: 'atomic' });
  const without = run({ ...style.template, id: 'atomic' });
  assert.match(withFlag, /LEAD-X sentence\.[^]*Leave out a whole section[^]*overrides the later formatting rule/);
  assert.doesNotMatch(without, /Leave out a whole section/);
});
