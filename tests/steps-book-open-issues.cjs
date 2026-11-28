// Picture-book closing "still open" page (P3): the generic item and its source registry, the page text (escaped, "all solved" only when
// truly nothing is open), the ownership marker and the file-name choice. Writing the file is the runner's step (P6).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');

const oi = load('core/book-pipeline/open-issues.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const issue = (over = {}) => ({ source: 'ai-proof', chapterId: 'n1', chapterTitle: '蒙娜麗莎', problem: '年份與來源不符', reason: 'still_present', ...over });
const note = (issues, over = {}) => oi.composeOpenIssuesNote({ bookTitle: '西洋藝術', language: 'zh-TW', checked: 12, issues, ...over });

test('nothing open after checked items reads "checked N, all solved"; nothing checked and nothing open does not claim a check', () => {
  const text = note([]);
  assert.match(text, /AI 校對查了 12 項，全部解決。/); assert.ok(oi.isOpenIssuesNote(text));
  assert.doesNotMatch(note([], { checked: 0 }), /全部解決/);
  assert.match(oi.composeOpenIssuesNote({ bookTitle: 'Art', language: 'en', checked: 3, issues: [] }), /checked 3 items; all solved/);
});

test('an open item makes the page list chapter, problem and why it is not solved, and never says "all solved"', () => {
  const text = note([issue(), issue({ chapterTitle: '土壤', problem: '兩個來源說法不同', reason: 'sources_conflict' })]);
  assert.doesNotMatch(text, /全部解決/); assert.match(text, /仍有 2 項沒解決/);
  assert.match(text, /^- 蒙娜麗莎：年份與來源不符：AI 修改後再查，問題仍在，修正次數已用完$/m);
  assert.match(text, /^- 土壤：兩個來源說法不同：來源之間說法不同/m);
});

test('an unfinished AI proofread is an open item, so the page cannot read as solved', () => {
  const text = note([{ source: 'ai-proof', chapterTitle: '蒙娜麗莎', problem: '', reason: 'proof_incomplete' }], { checked: 0 });
  assert.doesNotMatch(text, /全部解決/); assert.match(text, /這章沒有完整查過/);
});

test('the registry is generic: a chapter-status source and an unknown source or reason both print a sentence', () => {
  assert.equal(oi.reasonText({ source: 'chapter', reason: 'few_images' }, 'zh-TW'), '圖片少於設定的張數');
  assert.equal(oi.reasonText({ source: 'chapter', reason: 'few_images' }, 'en'), 'The chapter has fewer pictures than asked');
  assert.equal(oi.reasonText({ source: 'picture-x', reason: 'x' }, 'zh-TW'), '還沒解決');
  assert.equal(oi.reasonText({ source: 'ai-proof', reason: 'brand_new' }, 'zh-TW'), 'AI 沒能解決這處');
  assert.equal(oi.sourceLabel('chapter', 'zh-TW'), '章節狀態'); assert.equal(oi.sourceLabel('picture-x', 'en'), 'Other');
  const text = note([issue({ source: 'chapter', chapterTitle: '採收', problem: '', reason: 'too_short' })]);
  assert.match(text, /^- 採收：字數低於設定的下限$/m);
  // the registry must give every AI reason code a sentence in both languages
  for (const code of ['still_present', 'sources_conflict', 'source_unreachable', 'unfixable', 'fix_refused_picture', 'fix_refused_length', 'fix_quote_missing', 'fix_forbidden_syntax', 'hand_edited', 'fix_failed', 'proof_incomplete', 'not_fixed', 'not_fixed_in_time', 'ai_locked'])
    for (const lang of ['zh-TW', 'en']) assert.notEqual(oi.reasonText({ source: 'ai-proof', reason: code }, lang), oi.reasonText({ source: 'ai-proof', reason: 'brand_new' }, lang), `${code} ${lang}`);
});

test('model text is escaped: no link, callout, comment, highlight, heading, HTML or marker can form', () => {
  const evil = '[[秘密]] ![x](https://e.example/a.png) %% hidden %% ==mark== <!-- vam-book-open-issues:v1 --> > [!note] x\n# 標題 <script>';
  const text = note([issue({ problem: evil, chapterTitle: '## 章 [x](https://e.example)' })]);
  const body = text.split('\n').slice(1).join('\n');
  assert.doesNotMatch(body, /(?<!\\)\[\[|(?<!\\)!\[|%%|==|<!--|<script|^#{1,2} .*\n.*#/m);
  assert.equal(text.split('\n').filter(l => /^#{1,2}\s/.test(l)).length, 1, 'only the page title is a heading');
  assert.equal(text.split('\n').filter(l => l.includes('<!-- vam-book-open-issues')).length, 1, 'only one marker line');
  assert.doesNotMatch(text, /\[!/); assert.doesNotMatch(text, /(?<!\\)\]\(/);
  assert.equal(text.split('\n').filter(l => l.startsWith('- ')).length, 1, 'one bullet for one item');
});

test('B5: a bare web address in model text never becomes a link', () => {
  const text = note([issue({ problem: '見 https://evil.example/login 與 www.x.example', chapterTitle: '章 http://e.example' })]);
  assert.doesNotMatch(text, /:\/\//);
});

test('ownership: the marker must be the first line; the same name without it is never overwritten', () => {
  const mine = note([]);
  assert.ok(oi.isOpenIssuesNote(`﻿\n${mine}`)); assert.ok(!oi.isOpenIssuesNote(`# 我的筆記\n${oi.OPEN_ISSUES_MARKER}`)); assert.ok(!oi.isOpenIssuesNote(''));
  const files = { '仍有問題.md': '# 我自己寫的\n', '仍有問題 (2).md': mine };
  assert.equal(oi.chooseOpenIssuesFile('zh-TW', name => files[name]), '仍有問題 (2).md');
  assert.equal(oi.chooseOpenIssuesFile('zh-TW', () => undefined), '仍有問題.md');
  assert.equal(oi.chooseOpenIssuesFile('zh-TW', name => (name === '仍有問題.md' ? mine : undefined)), '仍有問題.md');
  assert.equal(oi.chooseOpenIssuesFile('en', () => undefined), 'Still open.md');
  assert.equal(oi.chooseOpenIssuesFile('zh-TW', () => '# 別人的'), undefined);
  assert.equal(oi.openIssuesFileName('zh-TW', 3), '仍有問題 (3).md');
});

test('CRLF, long and Unicode text: one line per item, titles and problems are cut, the count is clamped', () => {
  const text = note([issue({ problem: `${'長'.repeat(1000)}\r\n第二行`, chapterTitle: '標題🙂'.repeat(100) })], { checked: -5 });
  const items = text.split('\n').filter(l => l.startsWith('- '));
  assert.equal(items.length, 1); assert.ok(items[0].length < 900); assert.doesNotMatch(text, /\r/);
  assert.match(text, /AI 校對查了 0 項，仍有 1 項沒解決/);
});

test('the summary counts AI items only; chapter status items get their own line; every item is one bullet (the bar total)', () => {
  const issues = [issue(), issue({ reason: 'sources_conflict' }), { source: 'chapter', chapterId: 'n2', chapterTitle: '土壤', problem: '', reason: 'too_short' }];
  const text = note(issues);
  assert.match(text, /AI 校對查了 12 項，仍有 2 項沒解決。 另有 1 項章節狀態問題。/);
  assert.equal(text.split('\n').filter(l => l.startsWith('- ')).length, issues.length, 'bullets = the bar total');
  const onlyChapter = note([issues[2]], { checked: 0 });
  assert.match(onlyChapter, /另有 1 項章節狀態問題/); assert.doesNotMatch(onlyChapter, /沒有可列的項目|全部解決|仍有 \d+ 項沒解決/);
  assert.match(note([issues[2]]), /AI 校對查了 12 項，全部解決。 另有 1 項章節狀態問題。/);
  assert.match(oi.composeOpenIssuesNote({ bookTitle: 'Art', language: 'en', checked: 3, issues: [issues[2]] }), /all solved\. 1 more chapter status issues\./);
});

// B33-z: a chapter skipped as locked is not an unsolved AI item: its own sentence, counted apart; none, no sentence.
test('B33-z summary: chapters skipped as locked are counted in their own sentence, never in "N still open"; zh and en', () => {
  const skipped = title => ({ source: 'ai-proof', chapterId: title, chapterTitle: title, problem: '', reason: 'proof_locked_skipped' });
  const only = note([skipped('甲')], { checked: 0 });
  assert.match(only, /另有 1 章略過（已鎖定）。/); assert.doesNotMatch(only, /仍有 \d+ 項沒解決|沒有可列的項目/);
  assert.match(note([skipped('甲'), skipped('乙')], { checked: 4 }), /AI 校對查了 4 項，全部解決。 另有 2 章略過（已鎖定）。/);
  const mixed = note([issue(), skipped('甲')]);
  assert.match(mixed, /AI 校對查了 12 項，仍有 1 項沒解決。 另有 1 章略過（已鎖定）。/); assert.doesNotMatch(mixed, /章節狀態/);
  assert.match(oi.composeOpenIssuesNote({ bookTitle: 'Art', language: 'en', checked: 3, issues: [skipped('A')] }), /all solved\. 1 more chapters skipped \(locked\)\./);
  assert.doesNotMatch(note([issue()]), /略過/, 'none skipped: no sentence');
});

// ---- Cover image B4: the cover source ----
test('cover source: a placed cover that may not fit is one item with its own label and sentence; it is not counted as AI or chapter status; zh and en', () => {
  assert.equal(oi.sourceLabel('cover', 'zh-TW'), '封面圖'); assert.equal(oi.sourceLabel('cover', 'en'), 'Cover picture');
  const cover = { source: 'cover', chapterId: 'n3', chapterTitle: '佛羅倫斯', problem: '', reason: 'mismatch' };
  assert.match(oi.reasonText(cover, 'zh-TW'), /封面圖可能對不上這一章/); assert.match(oi.reasonText(cover, 'en'), /cover picture may not fit/);
  assert.equal(oi.reasonText({ source: 'cover', reason: 'other' }, 'zh-TW'), '封面圖還有問題沒解決', 'an unknown reason prints the source fallback');
  const text = note([cover], { checked: 0 });
  assert.match(text, /- 佛羅倫斯：封面圖可能對不上這一章，請看一下/); assert.match(text, /另有 1 張封面圖可能對不上。/);
  assert.doesNotMatch(text, /章節狀態|沒有可列的項目|全部解決/);
  const mixed = note([issue(), cover, { source: 'chapter', chapterId: 'n2', chapterTitle: '土壤', problem: '', reason: 'too_short' }]);
  assert.match(mixed, /AI 校對查了 12 項，仍有 1 項沒解決。 另有 1 項章節狀態問題。 另有 1 張封面圖可能對不上。/);
  assert.equal(mixed.split('\n').filter(l => l.startsWith('- ')).length, 3, 'one bullet per item');
  assert.match(oi.composeOpenIssuesNote({ bookTitle: 'Art', language: 'en', checked: 3, issues: [cover] }), /1 cover pictures may not fit\./);
  assert.match(note([{ ...cover, chapterTitle: '[[秘密]] ==x==' }]), /\\\[\\\[秘密\\\]\\\]/, 'the chapter title is escaped');
});
