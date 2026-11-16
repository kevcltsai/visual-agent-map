// Picture-book pipeline (03a): the pure edits of the Research notes callout and the root note's whole-book plan section.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');

const sections = load('core/book-pipeline/note-sections.ts');
const proof = load('core/book-pipeline/proof.ts');

const checklist = [{ id: 'C1', type: 'fact', text: 'x' }];
const result = (note = 'ok') => ({ aggregate: 'checked', items: [{ id: 'C1', type: 'fact', status: 'met', note, sources: ['https://example.com/a'] }] });
const keyOf = revision => proof.proofKey({ runId: 'r1', nodeId: 'n1', revision, body: 'BODY', checklist });
const recordOf = (revision, note) => proof.composeProofRecord(keyOf(revision), result(note));
const count = (haystack, needle) => haystack.split(needle).length - 1;

test('appendResearchNote: no Research notes section: a new section with a folded callout at the end', () => {
  const out = sections.appendResearchNote('Lead text\n\n### Sources\n\n- a', recordOf(1));
  assert.equal(out.appended, true);
  assert.match(out.text, /\n### 研究備註\n\n> \[!note\]- 研究備註\n> 校對（已校）\n> - C1 達成：ok（開頁：`https:\/\/example\.com\/a`）\n> <!-- book-proof:v1 /);
  assert.ok(out.text.startsWith('Lead text\n\n### Sources\n\n- a\n\n### 研究備註'));
  assert.equal(count(out.text, '### '), 2);
});

test('appendResearchNote: an empty Detail gets just the section', () => {
  const out = sections.appendResearchNote('', recordOf(1));
  assert.ok(out.text.startsWith('### 研究備註\n\n> [!note]- 研究備註\n'));
});

test('appendResearchNote: appends inside the existing callout, uses the section\'s own name, keeps what follows', () => {
  const first = sections.appendResearchNote('Lead\n\n### Research notes\n\n> [!note]- Research notes\n> old line\n\n### After\n\ntail', recordOf(1));
  assert.equal(first.appended, true);
  assert.equal(count(first.text, '[!note]-'), 1, 'still one callout');
  assert.match(first.text, /> old line\n>\n> 校對（已校）/);
  assert.match(first.text, /\n\n### After\n\ntail$/);
  const second = sections.appendResearchNote(first.text, recordOf(2));
  assert.equal(count(second.text, '[!note]-'), 1);
  assert.equal(count(second.text, 'book-proof:v1'), 2);
});

test('appendResearchNote: a section without a callout gets one named after the heading', () => {
  const out = sections.appendResearchNote('### 研究备注\n\nplain note\n', recordOf(1));
  assert.match(out.text, /### 研究备注\n\nplain note\n\n> \[!note\]- 研究备注\n> 校對/);
});

test('appendResearchNote: the same key (read through the > prefix) is not appended twice, and the text is returned as it was', () => {
  const once = sections.appendResearchNote('Lead', recordOf(1)).text;
  const again = sections.appendResearchNote(once, recordOf(1));
  assert.equal(again.appended, false); assert.equal(again.text, once);
  assert.equal(sections.appendResearchNote(once, recordOf(2)).appended, true, 'a new revision is a new record');
});

test('appendResearchNote: a heading-like line inside a fence or a callout is not a section; a record with hostile text stays quoted', () => {
  const detail = '```\n### 研究備註\n```\n\nbody';
  const out = sections.appendResearchNote(detail, recordOf(1, '## evil ![x](http://a) %% <b> ```'));
  assert.ok(out.text.startsWith(detail), 'the fenced heading is not the section');
  const added = out.text.slice(detail.length).split('\n').filter(Boolean);
  assert.ok(added.every(line => line.startsWith('> ') || line.startsWith('### 研究備註')), 'every line is quoted or the heading');
  assert.equal(/^\s{0,3}#{1,2} /m.test(out.text.replace(detail, '')), false);
  assert.ok(!/!\[x\]\(|%%|<b>/.test(out.text.slice(detail.length).replace(/<!-- book-proof[^\n]*/, '')));
});

test('appendResearchNote: a record without a key is appended as it is (no dedupe), CRLF text keeps working', () => {
  const out = sections.appendResearchNote('Lead\r\n\r\n### 研究備註\r\n\r\n> [!note]- 研究備註\r\n> old\r\n', recordOf(1));
  assert.equal(out.appended, true);
  assert.equal(count(out.text, '[!note]-'), 1);
  assert.equal(sections.appendResearchNote('x', 'just text').appended, true);
});

const ROOT = '---\nbook-goal: g\n---\n\n## 摘要\n\nS\n\n## 全書企劃\n\nOLD PLAN\n\n### 小節\n\nold sub\n\n## 其他\n\nO\n';

test('replaceBookPlanSection: replaces only that section (its ### children too) and keeps everything else byte for byte', () => {
  const out = sections.replaceBookPlanSection(ROOT, 'NEW PLAN\n- a');
  assert.equal(out, '---\nbook-goal: g\n---\n\n## 摘要\n\nS\n\n## 全書企劃\n\nNEW PLAN\n- a\n\n## 其他\n\nO\n');
  assert.equal(sections.replaceBookPlanSection(out, 'NEW PLAN\n- a'), out, 'idempotent');
});

test('replaceBookPlanSection: no section: appended at the end; section last: replaced to the end', () => {
  assert.equal(sections.replaceBookPlanSection('---\nk: v\n---\n\nbody\n', 'P'), '---\nk: v\n---\n\nbody\n\n## 全書企劃\n\nP\n');
  assert.equal(sections.replaceBookPlanSection('body\n\n## 全書企劃\n\nold\n', 'P'), 'body\n\n## 全書企劃\n\nP\n');
  assert.equal(sections.replaceBookPlanSection('', 'P'), '## 全書企劃\n\nP\n');
});

test('replaceBookPlanSection: a heading inside a fence is not the section; markdown headings are demoted and cannot open a section', () => {
  const fenced = 'x\n\n```\n## 全書企劃\n```\n';
  assert.ok(sections.replaceBookPlanSection(fenced, 'P').startsWith(fenced), 'fence untouched, section appended after it');
  const out = sections.replaceBookPlanSection(ROOT, '## Injected\n# Top\nline');
  assert.ok(!/^## Injected/m.test(out) && !/^# Top/m.test(out));
  assert.match(out, /### Injected\n### Top\nline/);
});

test('chapterBody: Research notes, Update log and Sources are not the chapter; a fenced heading and the chapter text stay', () => {
  const detail = ['### 核心結論', '', 'Body line.', '', '```', '### 更新紀錄', '```', '', '最後一句。', '', '### 來源', '', '[^1]: a', '', '### 更新紀錄', '', '2026-11-17　已用新研究取代', '', '### 研究備註', '', '> [!note]- 研究備註', '> 校對'].join('\n');
  assert.equal(sections.chapterBody(detail), ['### 核心結論', '', 'Body line.', '', '```', '### 更新紀錄', '```', '', '最後一句。'].join('\n'));
  assert.equal(sections.chapterBody('### Sources\n\n- a\n\n### Update log\n\nx\n\n### Research notes\n\n> y'), '');
  assert.equal(sections.chapterBody('Plain text\n'), 'Plain text');
});
