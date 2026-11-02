// Note style files (P1a): parsing, comment removal, fail-closed validation, frozen legacy export.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./support-replay.cjs');

const S = loadSource(`
export * from "./ai/note-style-file";
export { sectionLookup, checkCounts, standardTemplate, textbookTemplate } from "./ai/detail-templates";
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
