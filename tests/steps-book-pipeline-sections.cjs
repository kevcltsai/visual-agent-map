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

test('appendResearchNote: no work records yet: a new hidden vam-book callout at the end (no heading), a blank line before it', () => {
  const out = sections.appendResearchNote('Lead text\n\n### Sources\n\n- a', recordOf(1));
  assert.equal(out.appended, true);
  assert.match(out.text, /\n\n> \[!vam-book\]- 研究備註\n> 校對（已校）\n> - C1 達成：ok（開頁：`https:\/\/example\.com\/a`）\n> <!-- book-proof:v1 /);
  assert.ok(out.text.startsWith('Lead text\n\n### Sources\n\n- a\n\n> [!vam-book]- 研究備註'));
  assert.equal(count(out.text, '### '), 1, 'no new heading');
});

test('appendResearchNote: an empty Detail gets just the hidden callout', () => {
  const out = sections.appendResearchNote('', recordOf(1));
  assert.ok(out.text.startsWith('> [!vam-book]- 研究備註\n'));
});

test('normalizeWorkRecords then appendResearchNote: an older Research notes section is turned into the hidden callout (heading gone, own title kept), the record goes inside it, what follows stays (append itself never converts text)', () => {
  const first = sections.appendResearchNote(sections.normalizeWorkRecords('Lead\n\n### Research notes\n\n> [!note]- Research notes\n> old line\n\n### After\n\ntail'), recordOf(1));
  assert.equal(first.appended, true);
  assert.equal(count(first.text, '[!vam-book]-'), 1, 'still one callout'); assert.ok(!first.text.includes('[!note]') && !first.text.includes('### Research notes'));
  assert.ok(first.text.startsWith('Lead\n\n> [!vam-book]- Research notes\n> old line'));
  assert.match(first.text, /> old line\n>\n> 校對（已校）/);
  assert.match(first.text, /\n\n### After\n\ntail$/);
  const second = sections.appendResearchNote(first.text, recordOf(2));
  assert.equal(count(second.text, '[!vam-book]-'), 1);
  assert.equal(count(second.text, 'book-proof:v1'), 2);
});

test('appendResearchNote: an older section without a callout keeps its text; the records go in a new hidden callout', () => {
  const out = sections.appendResearchNote('### 研究备注\n\nplain note\n', recordOf(1));
  assert.match(out.text, /### 研究备注\n\nplain note\n\n> \[!vam-book\]- 研究備註\n> 校對/);
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
  assert.ok(added.every(line => line.startsWith('> ')), 'every added line is quoted');
  assert.equal(/^\s{0,3}#{1,2} /m.test(out.text.replace(detail, '')), false);
  assert.ok(!/!\[x\]\(|%%|<b>/.test(out.text.slice(detail.length).replace(/<!-- book-proof[^\n]*/, '')));
});

test('appendResearchNote: a record without a key is appended as it is (no dedupe), CRLF text keeps working', () => {
  const out = sections.appendResearchNote(sections.normalizeWorkRecords('Lead\r\n\r\n### 研究備註\r\n\r\n> [!note]- 研究備註\r\n> old\r\n'), recordOf(1));
  assert.equal(out.appended, true);
  assert.equal(count(out.text, '[!vam-book]-'), 1); assert.ok(!out.text.includes('### 研究備註'));
  assert.equal(sections.appendResearchNote('x', 'just text').appended, true);
});

const ROOT = '---\nbook-goal: g\n---\n\n## 摘要\n\nS\n\n## 全書企劃\n\nOLD PLAN\n\n### 小節\n\nold sub\n\n## 其他\n\nO\n';

const CALLOUT = '> [!vam-book]- 全書企劃';
const planText = load('core/book-pipeline/plan-text.ts');

test('replaceBookPlanSection: an older `##` section becomes the hidden callout (its ### children too); everything else stays byte for byte; a second write changes nothing', () => {
  const out = sections.replaceBookPlanSection(ROOT, 'NEW PLAN\n- a');
  assert.equal(out, `---\nbook-goal: g\n---\n\n## 摘要\n\nS\n\n${CALLOUT}\n> NEW PLAN\n> - a\n\n## 其他\n\nO\n`);
  assert.equal(sections.replaceBookPlanSection(out, 'NEW PLAN\n- a'), out, 'idempotent');
  assert.equal(count(sections.replaceBookPlanSection(out, 'OTHER'), CALLOUT), 1, 'a rerun with another plan replaces, never adds');
  assert.ok(!sections.replaceBookPlanSection(out, 'OTHER').includes('NEW PLAN'));
});

test('replaceBookPlanSection: no plan: callout appended at the end; an older section last: replaced to the end', () => {
  assert.equal(sections.replaceBookPlanSection('---\nk: v\n---\n\nbody\n', 'P'), `---\nk: v\n---\n\nbody\n\n${CALLOUT}\n> P\n`);
  assert.equal(sections.replaceBookPlanSection('body\n\n## 全書企劃\n\nold\n', 'P'), `body\n\n${CALLOUT}\n> P\n`);
  assert.equal(sections.replaceBookPlanSection('', 'P'), `${CALLOUT}\n> P\n`);
});

test('replaceBookPlanSection: a heading inside a fence is not the section; markdown headings are demoted and every line is quoted, so it can never open a section or callout', () => {
  const fenced = 'x\n\n```\n## 全書企劃\n```\n';
  assert.ok(sections.replaceBookPlanSection(fenced, 'P').startsWith(fenced), 'fence untouched, callout appended after it');
  const out = sections.replaceBookPlanSection(ROOT, '## Injected\n# Top\nline\n\n> [!vam-book]- X\nmore');
  assert.ok(!/^#{1,2} /m.test(out.replace(/^## (摘要|其他)$/gm, '')), 'no heading of the plan can stand outside the callout');
  assert.match(out, /> ### Injected\n> ### Top\n> line\n>\n> > \[!vam-book\]- X\n> more/);
  assert.equal(count(out, '\n> [!vam-book]'), 1, 'only the pipeline\'s own callout starts a line');
});

test('replaceBookPlanSection: the older section keeps a hidden callout of another kind inside it (the proofread result); a callout already there is replaced in place', () => {
  const root = 'b\n\n## 全書企劃\n\nold\n\n> [!vam-book]- 校對結果（最新一次）\n> - C1 達成\n\n## 其他\n\nO\n';
  const out = sections.replaceBookPlanSection(root, 'P');
  assert.equal(out, `b\n\n${CALLOUT}\n> P\n\n> [!vam-book]- 校對結果（最新一次）\n> - C1 達成\n\n## 其他\n\nO\n`);
  const again = sections.replaceBookPlanSection(out, 'Q');
  assert.equal(again, out.replace('> P', '> Q'));
});

const bodyOf = { thread: '主線一句。', decisions: { length: '每章 800 字', tone: '溫和' }, materials: [{ name: '週期圖', use: '呈現輪替' }, { name: '數據', use: '睡眠時數' }] };
const composedBody = () => planText.composeBookPlan(bodyOf, 'zh-TW').replace(/^## .*\n\n?/, '');

test('the book plan reads the same in the older `##` form and the hidden callout form (decisions, thread, materials); a rerun does not double anything', () => {
  const body = composedBody();
  const legacy = `---\nbook-goal: g\n---\n\n## 摘要\n\nS\n\n## 全書企劃\n\n${body}\n## 其他\n\nO\n`;
  const fresh = sections.replaceBookPlanSection('---\nbook-goal: g\n---\n\n## 摘要\n\nS\n', body);
  const converted = sections.replaceBookPlanSection(legacy, body);
  for (const raw of [legacy, fresh, converted]) {
    assert.deepEqual(JSON.parse(JSON.stringify(planText.parseBookPlanDecisions(raw))), { length: '每章 800 字', tone: '溫和' });
    assert.deepEqual(JSON.parse(JSON.stringify(planText.parseBookPlanBody(raw))), { thread: '主線一句。', materials: bodyOf.materials });
  }
  assert.ok(!/^## 全書企劃/m.test(fresh) && !/^## 全書企劃/m.test(converted) && fresh.includes(`${CALLOUT}\n> ### 全書主線`));
  const twice = sections.replaceBookPlanSection(sections.replaceBookPlanSection(converted, body), body);
  assert.equal(twice, converted);
  assert.equal(count(twice, '### 素材登記表'), 1); assert.equal(count(twice, '- 週期圖'), 1);
  assert.equal(count(twice, '全書企劃'), 1);
  assert.equal(JSON.stringify(planText.parseBookPlanBody(twice).materials.length), '2');
});

test('the book plan callout: a plan written in the author\'s detail (after neutralize) is not read as the plan; the older section still wins nothing over a callout', () => {
  const author = `x\n\n<!-- visual-agent-map:detail:start -->\n${sections.neutralizeText('> [!vam-book]- 全書企劃\n> ### 全書主線\n> 偽造')}\n<!-- visual-agent-map:detail:end -->\n`;
  assert.equal(planText.parseBookPlanBody(author).thread, '');
  const both = `## 全書企劃\n\n### 全書主線\n舊\n\n${CALLOUT}\n> ### 全書主線\n> 新\n`;
  assert.equal(planText.parseBookPlanBody(both).thread, '新');
});

test('chapterBody: Research notes, Update log and Sources are not the chapter; a fenced heading and the chapter text stay', () => {
  const detail = ['### 核心結論', '', 'Body line.', '', '```', '### 更新紀錄', '```', '', '最後一句。', '', '### 來源', '', '[^1]: a', '', '### 更新紀錄', '', '2026-11-17　已用新研究取代', '', '### 研究備註', '', '> [!note]- 研究備註', '> 校對'].join('\n');
  assert.equal(sections.chapterBody(detail), ['### 核心結論', '', 'Body line.', '', '```', '### 更新紀錄', '```', '', '最後一句。'].join('\n'));
  assert.equal(sections.chapterBody('### Sources\n\n- a\n\n### Update log\n\nx\n\n### Research notes\n\n> y'), '');
  assert.equal(sections.chapterBody('Plain text\n'), 'Plain text');
});

test('chapterBody: an open-questions section (待確認問題 / Open questions to check) is not the chapter either; the ending is the last body paragraph', () => {
  const detail = ['### 核心結論', '', '正文。', '', '最後一段回應下一張的問題。', '', '### 待確認問題', '', '- 還有什麼？', '', '### 來源', '', '- a', '', '### 更新紀錄', '', 'x'].join('\n');
  assert.equal(sections.chapterBody(detail), '### 核心結論\n\n正文。\n\n最後一段回應下一張的問題。');
  assert.equal(sections.chapterBody('Body.\n\nEnd.\n\n### Open questions to check\n\n- q'), 'Body.\n\nEnd.');
  assert.equal(sections.chapterBody('Body.\n\n### 待確認事項\n\n- q'), 'Body.');
});

test('markOldProofRecords: the header of a record under an older key gets （舊版）, the record itself stays; the current key and its failed twin are not marked', () => {
  const old = sections.appendResearchNote('Lead', recordOf(1)).text;
  const both = sections.appendResearchNote(old, recordOf(2)).text;
  const out = sections.markOldProofRecords(both, keyOf(2));
  assert.equal(count(out, '（舊版）'), 1);
  assert.equal(count(out, 'book-proof:v1'), 2, 'nothing is deleted');
  assert.ok(out.includes(`> （舊版）校對（`), 'the mark sits after the quote prefix, before the header text');
  assert.equal(sections.markOldProofRecords(out, keyOf(2)), out, 'idempotent: an old record is marked once');
  const failed = sections.appendResearchNote(old, proof.composeProofRecord(proof.failedProofKey(keyOf(2)), { aggregate: 'needs-review', items: result().items }, 'no_open_page')).text;
  assert.equal(count(sections.markOldProofRecords(failed, keyOf(2)), '（舊版）'), 1, 'only the revision-1 record; the failed twin of the current key stays');
});

test('markOldProofRecords: no old record (a first run, or only the current key) leaves the text byte for byte; text outside the records, such as a seam notice, is never touched', () => {
  const plain = 'Lead\n\n鄰卡企劃或正文已變更，尚未人工核對（第 3 張，版本 2）\n\n### 研究備註\n\n> [!note]- 研究備註\n> 無圖：未找到可驗證的公開圖片\n';
  assert.equal(sections.markOldProofRecords(plain, keyOf(2)), plain);
  assert.equal(sections.markOldProofRecords('', keyOf(2)), '');
  const current = sections.appendResearchNote(plain, recordOf(2)).text;
  assert.equal(sections.markOldProofRecords(current, keyOf(2)), current);
  const marked = sections.markOldProofRecords(sections.appendResearchNote(current, recordOf(3)).text, keyOf(3));
  assert.ok(marked.includes('鄰卡企劃或正文已變更，尚未人工核對（第 3 張，版本 2）\n'), 'the line outside the records is unchanged');
  assert.ok(marked.includes('> 無圖：未找到可驗證的公開圖片\n'));
});

// ---- T1: latest-only records, proof-result section, picture-section carry-over ----
test('replaceResearchRecord: only valid pipeline records of the same kind go; owner text, other callouts, damaged records and fenced fake markers stay verbatim', () => {
  let detail = 'Text.\n\n### 研究備註\n\n> [!note]- 研究備註\n> 作者研究：A\n>\n> 我的備註（owner）';
  detail = sections.appendResearchNote(detail, recordOf(1, 'one')).text;
  detail = sections.appendResearchNote(detail, recordOf(2, 'two')).text;
  const damaged = '> <!-- book-proof:v1 {not json} -->';
  const slots = '> <!-- book-slots:v1 {"key":"s"} -->';
  detail = detail.replace(/\n$/, '') + `\n>\n${damaged}\n>\n${slots}\n\n> [!tip] 其他\n> 其他 callout\n`;
  const fake = '```\n> <!-- book-proof:v1 {"key":"fake","result":{"items":[]}} -->\n```';
  detail += `\n${fake}\n`;
  const next = sections.replaceResearchRecord(detail, recordOf(3, 'three'));
  assert.equal(count(next, 'book-proof:v1 {"key"'), 2, 'the new record and the fenced fake only');
  assert.ok(next.includes(fake) && next.includes(damaged) && next.includes(slots));
  assert.ok(next.includes('作者研究：A') && next.includes('我的備註（owner）') && next.includes('> [!tip] 其他\n> 其他 callout'));
  assert.ok(next.includes('three') && !next.includes('one') && !next.includes('two'));
  assert.ok(!next.includes('（舊版）'));
  // same input twice is stable; a slots record replaces only slots
  assert.equal(sections.replaceResearchRecord(next, recordOf(3, 'three')), next);
  const slots2 = proof.composeProofRecord(keyOf(9), result('s')).replace('book-proof', 'book-slots');
  const swapped = sections.replaceResearchRecord(next, slots2);
  assert.ok(!swapped.includes('"key":"s"') && swapped.includes('three'));
});

test('replaceResearchRecord: no section yet adds it; a plain text with no records changes nothing but the addition', () => {
  const out = sections.replaceResearchRecord('正文', recordOf(1));
  assert.equal(out, sections.appendResearchNote('正文', recordOf(1)).text);
  const twice = sections.replaceResearchRecord(sections.replaceResearchRecord('正文', recordOf(1, 'a')), recordOf(2, 'b'));
  assert.equal(count(twice, 'book-proof:v1'), 1); assert.ok(twice.includes('b') && !twice.includes('：a'));
});

test('carryImageSection: the old section comes back verbatim after a rewrite; a rewrite that kept one is unchanged; no old section changes nothing', () => {
  const old = '舊文。\n\n### 圖像\n\n![A](https://e.com/a.jpg)\nA\n\n### 來源\n- s';
  const carried = sections.carryImageSection(old, '新文。');
  assert.ok(carried.includes('### 圖像\n\n![A](https://e.com/a.jpg)\nA') && carried.startsWith('新文。'));
  assert.equal(sections.carryImageSection(old, '新文。\n\n### 圖像\n\n![B](https://e.com/b.jpg)\nB'), '新文。\n\n### 圖像\n\n![B](https://e.com/b.jpg)\nB');
  assert.equal(sections.carryImageSection('舊文。', '新文。'), '新文。');
  const en = sections.carryImageSection('x\n\n### Images\n\n![A](https://e.com/a.jpg)\nA', 'y');
  assert.ok(en.includes('### Images'));
});

test('replaceProofSection: the owner\'s `- ` list after the section (one blank line away) stays verbatim, at the end and before the reference block', () => {
  const mine = '- 我的待辦一\n- 我的待辦二';
  const atEnd = '# T\n\n## 校對結果（最新一次）\n\n- C1 達成\n\n' + mine + '\n';
  const outEnd = sections.replaceProofSection(atEnd, '校對結果（最新一次）', '- C1 未達成');
  assert.equal(outEnd, '# T\n\n> [!vam-book]- 校對結果（最新一次）\n> - C1 未達成\n\n' + mine + '\n');
  const refs = '<!-- visual-agent-map:references:start -->\n[1]: x\n<!-- visual-agent-map:references:end -->\n';
  const beforeRefs = '# T\n\n## 校對結果（最新一次）\n\n- C1 達成\n- C2 達成\n\n' + mine + '\n\n' + refs;
  const outRefs = sections.replaceProofSection(beforeRefs, '校對結果（最新一次）', '- C1 未達成');
  assert.equal(outRefs, '# T\n\n> [!vam-book]- 校對結果（最新一次）\n> - C1 未達成\n\n' + mine + '\n\n' + refs);
  assert.equal(sections.replaceProofSection(outRefs, '校對結果（最新一次）', '- C1 未達成'), outRefs, 'idempotent');
  const tight = sections.replaceProofSection('## 校對結果（最新一次）\n- C1 達成\n\n' + mine + '\n', '校對結果（最新一次）', '- C1 未達成');
  assert.ok(tight.includes('\n\n' + mine + '\n') && count(tight, '- C1') === 1, 'no blank after the heading');
});

test('replaceProofSection: adds the section before the reference block / at the end, replaces it (any language heading), never touches the Detail block, code or frontmatter', () => {
  const note = '---\ntitle: T\n---\n# T\n\n## 詳細內容\n\n<!-- visual-agent-map:detail:start -->\n\n## 校對結果（最新一次）\n\n- 在 Detail 內，不動\n\n<!-- visual-agent-map:detail:end -->\n\n> [!info]- 提示\n> x\n';
  const added = sections.replaceProofSection(note, '校對結果（最新一次）', '- C1 達成');
  assert.ok(added.includes('- 在 Detail 內，不動'));
  assert.ok(added.endsWith('> [!info]- 提示\n> x\n\n> [!vam-book]- 校對結果（最新一次）\n> - C1 達成\n'));
  const replaced = sections.replaceProofSection(added, '校對結果（最新一次）', '- C1 未達成：y');
  assert.equal(count(replaced, '- C1'), 1); assert.ok(replaced.includes('- C1 未達成：y') && replaced.includes('在 Detail 內'));
  assert.equal(sections.replaceProofSection(replaced, '校對結果（最新一次）', '- C1 未達成：y'), replaced);
  const en = sections.replaceProofSection(added, 'Proofread result (latest)', '- C1 met');
  assert.equal(count(en, '- C1'), 1, 'a heading in another language is found and replaced');
  const owner = sections.replaceProofSection(added + '\n我自己寫的一行\n\n## 我的標題\n\n內容\n', '校對結果（最新一次）', '- C1 達成');
  assert.ok(owner.includes('我自己寫的一行') && owner.includes('## 我的標題\n\n內容'), 'text after the section is never taken');
  assert.equal(count(owner, '- C1'), 1);
  const refs = '# T\n\n正文\n\n<!-- visual-agent-map:references:start -->\n[1]: x\n<!-- visual-agent-map:references:end -->\n';
  assert.ok(sections.replaceProofSection(refs, 'H', 'b').indexOf('[!vam-book]- H') < sections.replaceProofSection(refs, 'H', 'b').indexOf('references:start'));
  const fenced = '# T\n\n```\n## 校對結果（最新一次）\n\n- fake\n```\n';
  assert.ok(sections.replaceProofSection(fenced, '校對結果（最新一次）', '- real').includes('- fake'));
});

test('composeProofSection: lines per item (note only when not met), the two model lines, 未記錄 without an id, a failure is one line with no model; ids and labels are escaped', () => {
  const res = { aggregate: 'needs-review', items: [{ id: 'C1', type: 'fact', status: 'met', note: 'ok', sources: [] }, { id: 'C2', type: 'fact', status: 'unmet', note: 'bad *x*', sources: [] }, { id: 'C3', type: 'fact', status: 'unverified', note: '', sources: [] }] };
  const out = proof.composeProofSection('zh-TW', { result: res }, { model: 'm3' }, id => `<${id}>`);
  assert.match(out, /^- C1 達成\n- C2 未達成：bad /m); assert.ok(!out.includes('ok'));
  assert.match(out, /- 作者模型：未記錄\n- 校對模型：＜m3＞$/);
  const failed = proof.composeProofSection('zh-TW', { failure: 'invalid_reply' }, { model: 'm3', authorModel: 'm2' });
  assert.equal(failed, '- 失敗：invalid\\_reply'); assert.ok(!/模型|m2|m3/.test(failed));
  assert.equal(proof.findProofModels(proof.composeProofRecord('k', res, undefined, { model: 'm3', authorModel: 'm2' }), 'k').authorModel, 'm2');
  assert.deepEqual({ ...proof.findProofModels(proof.composeProofRecord('k', res), 'k') }, {});
  assert.equal(proof.findProofModels(proof.composeProofRecord('k', res), 'other'), undefined);
});

test('addPictureSources: entries go to the end of the Sources section (before a hidden callout) or a new section; each address once; CRLF kept', () => {
  const e = (n, extra = '') => ({ href: `https://s.example/${n}`, entry: `圖 ${n}：s.example（[連結](https://s.example/${n})）${extra}` });
  const hidden = '> [!vam-book]- 研究備註\n> <!-- book-slots:v1 {"slots":[],"bad":0} -->';
  const withSection = `正文。\n\n## 來源\n- https://own.example/a\n\n${hidden}\n`;
  const added = sections.addPictureSources(withSection, [e(1), e(1), e(2)], 'zh-TW');
  assert.equal(added, `正文。\n\n## 來源\n- https://own.example/a\n- ${e(1).entry}\n- ${e(2).entry}\n\n${hidden}\n`);
  assert.equal(sections.addPictureSources(added, [e(1), e(2)], 'zh-TW'), added, 'a second fill adds nothing');
  assert.equal(sections.addPictureSources(withSection, [], 'zh-TW'), withSection);
  const own = '正文。\n\n## Sources\n- https://s.example/1\n';
  assert.equal(sections.addPictureSources(own, [e(1)], 'en'), own, 'the author already cites that page');
  const none = sections.addPictureSources(`正文。\n\n${hidden}\n`, [e(1)], 'zh-TW');
  assert.equal(none, `正文。\n\n## 來源\n\n- ${e(1).entry}\n\n${hidden}\n`);
  assert.match(sections.addPictureSources('Text.\n', [e(1)], 'en'), /^Text\.\n\n## Sources\n\n- 圖 1/);
  const crlf = sections.addPictureSources('正文。\r\n\r\n## 來源\r\n- a\r\n', [e(3)], 'zh-TW');
  assert.equal(crlf, `正文。\r\n\r\n## 來源\r\n- a\r\n- ${e(3).entry}\r\n`);
  const afterHeading = sections.addPictureSources('正文。\n\n## 來源\n\n## 其他\nx\n', [e(4)], 'zh-TW');
  assert.equal(afterHeading, `正文。\n\n## 來源\n- ${e(4).entry}\n\n## 其他\nx\n`);
});

// ---- T10a: a sources heading with a trailing colon; the narrow lift of chapter prose written under the first sources heading ----
const fs = require('node:fs');
const path = require('node:path');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const PROSE = '第一段正文，先把這一章要講的事說清楚。'.repeat(8) + '\n\n' + '第二段正文接著講做法與步驟，讓讀者能照著做。'.repeat(8);
const LIST = '- [A](https://a.example/x)\n- [B](https://b.example/y)';

test('T10a sources heading: "來源：" (full-width or ASCII colon) is a system section like "來源"; chapterBody drops it', () => {
  for (const heading of ['### 來源：', '### 來源:', '### Sources:']) assert.equal(sections.chapterBody(`正文。\n\n${heading}\n\n- a`), '正文。');
  assert.equal(sections.chapterBody('### 來源\n\n正文\n\n### 來源：\n\n- a'), '');
});

test('T10a (decision #24): the two evidence shapes (prose under the first sources heading) are no chapter text; nothing lifts them', () => {
  assert.equal(sections.liftChapterFromSources, undefined, 'the auto-lift is gone');
  for (const name of ['book-sources-lead-r5.md', 'book-sources-lead-r3.md']) assert.equal(sections.chapterBody(fixture(name)), '', name);
});

test('T10a (decision #24): a double sources heading around long commentary reads as no chapter text', () => {
  const detail = `### 來源\n\n${PROSE}\n\n### 參考資料\n\n${LIST}`;
  assert.equal(sections.chapterBody(detail), '');
});

// ---- the expansion of a too-short chapter (the program puts the author's change blocks in) ----
test('expandChapterDetail: insertions go to the end of the named section or before the last heading; replaces only touch the chapter text; hidden records, pictures and sources stay; new sources join', () => {
  const { expandChapterDetail, parseChapterEdits, chapterBody } = sections;
  const old = [
    '', '## 開場', '', '開場段落。', '', '### 土壤', '', '土壤段落。', '', '### 小結', '', '結尾一句。', '',
    '### 圖像', '', '![a](https://example.org/a.png)', '圖說 a', '',
    '## 來源', '', '- [舊來源](https://example.org/old)', '',
    '> [!vam-book]- 研究備註', '> 土壤段落。', '> <!-- book-slots:v1 {"slots":[]} -->', ''
  ].join('\n');
  const answer = [
    'preamble is ignored',
    '@@insert after: ### 土壤', '### 排水', '', '排水段落。',
    '@@insert', '### 盆器', '', '盆器段落。',
    '@@insert after: ### 不存在', '孤兒段落。',
    '@@replace', '土壤段落。', '@@with', '土壤段落（更正）。',
    '@@replace', '找不到的句子。', '@@with', '無效。',
    '', '## 來源', '', '- [新來源](https://example.org/new)', '- [舊來源](https://example.org/old)'
  ].join('\n');
  assert.equal(parseChapterEdits(chapterBody(answer)).length, 5);
  const { detail, applied } = expandChapterDetail(old, answer, 'zh-TW');
  assert.equal(applied, 4, 'the passage that is not in the chapter is not applied');
  const at = text => detail.indexOf(text);
  assert.ok(at('土壤段落（更正）。') > at('### 土壤') && at('### 排水') > at('土壤段落（更正）。') && at('### 排水') < at('### 盆器'));
  assert.ok(at('### 盆器') < at('### 小結') && at('孤兒段落。') < at('### 小結'), 'unknown anchor: before the last section');
  assert.ok(at('結尾一句。') < at('### 圖像'), 'the ending stays the chapter\'s last text');
  assert.ok(detail.includes('> 土壤段落。'), 'the hidden record is not a chapter passage');
  assert.ok(detail.includes('<!-- book-slots:v1') && detail.includes('![a](https://example.org/a.png)'));
  assert.ok(detail.includes('https://example.org/new') && detail.split('https://example.org/old').length === 2, 'new source added once');
  assert.ok(!detail.includes('@@') && !detail.includes('preamble'));
});

test('expandChapterDetail: an answer with no block line, or blocks that apply nowhere, is undefined (the chapter is never rewritten); CRLF stays CRLF; a chapter with no headings gets an insertion before its last paragraph', () => {
  const { expandChapterDetail } = sections;
  const old = '\r\n第一段很長的內容。\r\n\r\n最後一段。\r\n';
  assert.equal(expandChapterDetail(old, '\n新段落。\n', 'zh-TW'), undefined, 'a shorter answer with no block is not put in');
  assert.equal(expandChapterDetail(old, '\n' + '整章重寫'.repeat(20) + '\n', 'zh-TW'), undefined, 'a whole longer chapter is not put in');
  assert.equal(expandChapterDetail(old, '\n@@insert\n\n', 'zh-TW'), undefined, 'an empty block is no usable block');
  const short = expandChapterDetail(old, '\n@@insert\n新段落。\n', 'zh-TW');
  assert.ok(short.detail.includes('\r\n') && !/[^\r]\n/.test(short.detail), 'line endings kept');
  assert.ok(short.detail.indexOf('新段落。') > short.detail.indexOf('第一段') && short.detail.indexOf('新段落。') < short.detail.indexOf('最後一段。'));
});

test('expandChapterDetail: lines echoing the request are left out of every block (the live run\'s exact line, a copied request sentence); a plain bracketed sentence stays', () => {
  const { expandChapterDetail, isEchoedLine } = sections;
  const echoed = '（本章結構以既有標題為準，以下新增段落接在章節正文各處；若找不到對應標題，請放在結語之前。）';
  const sent = 'Expansion (hard requirement). The program puts the blocks into the chapter; text outside a block is ignored. Keep the chapter\'s voice and terms.';
  assert.equal(isEchoedLine(echoed, ''), true, 'the exact line, with no request text at all');
  assert.equal(isEchoedLine('(The new paragraphs below are placed after the existing headings.)', ''), true);
  assert.equal(isEchoedLine('  keep the chapter’s VOICE and terms ', sent), true, 'a copy of a request sentence (case, quotes and spaces aside)');
  assert.equal(isEchoedLine('圖位 1｜photo｜a pot｜位置：end｜英文搜尋詞：flower pot', ''), true, 'a plan line with search terms');
  assert.equal(isEchoedLine('Image slot 1｜photo｜a pot｜Search terms: flower pot', ''), true);
  assert.equal(isEchoedLine('（番茄一天要六小時以上的日照。）', sent), false);
  assert.equal(isEchoedLine('（詳見本章後段）', sent), false, 'a reference to the chapter that is not about placement');
  assert.equal(isEchoedLine('Keep it.', sent), false, 'a short phrase is the chapter\'s own');
  const old = '\n## 開場\n\n開場段落。\n\n### 小結\n\n結尾。\n';
  const done = expandChapterDetail(old, ['', '@@insert after: ## 開場', echoed, '', '新段落。', '@@replace', '開場段落。', '@@with', echoed, '@@insert', 'Keep the chapter\'s voice and terms.'].join('\n'), 'zh-TW', sent);
  assert.equal(done.applied, 1, 'the insertion with real text; the replacement that was only an echo and the echo-only insertion are dropped');
  assert.ok(done.detail.includes('新段落。') && done.detail.includes('開場段落。') && !done.detail.includes('本章結構') && !done.detail.includes('voice'), done.detail);
});

// Live run v4 (2026-11-20), 〈家庭菜園入門〉 (intro): the model's no-op line went in as prose, and four patch sections pre-told later chapters.
const V4_OTHERS = ['土壤與容器準備', '播種與育苗', '澆水施肥與病蟲害', '採收與保存', '新手推薦蔬菜'];
const V4_INTRO = ['## 開場', '', '我的陽台，到底能不能種菜？', '', '### 為什麼先做小的？', '', '先從一盆開始。', '', '### 小結', '', '下一章先準備盆和土。'].join('\n');
const V4_ANSWER = [
  '@@insert after: ### 為什麼先做小的？',
  '本次無新增內容。',
  '',
  '### 把陽台條件看得更細一點',
  '',
  '早上曬到的東向陽台，比西曬的陽台溫和。',
  '',
  '### 土壤與容器：預告裡沒講完的小細節',
  '',
  '第一站提到培養土，這裡先補三個初學者常問的小問題，細節留到第二章。',
  '',
  '### 播種與育苗：預告裡沒講完的小細節',
  '',
  '覆土厚度為種子直徑的 2 到 3 倍，是一個記憶口訣，不用拿尺量。',
  '',
  '### 澆水、施肥與病蟲害：預告裡沒講完的小細節',
  '',
  '用手指測土再澆水。',
  '',
  '### 採收與保存：預告裡沒講完的小細節',
  '',
  '採收的關鍵是「勤摘」。'
].join('\n');

test('expandChapterDetail (live v4): the no-op line 「本次無新增內容。」 and the four 「預告裡沒講完的小細節」 sections of an intro are dropped; the section that deepens the intro stays', () => {
  const { expandChapterDetail } = sections;
  const { detail } = expandChapterDetail(V4_INTRO, V4_ANSWER, 'zh-TW', '', { role: 'intro', others: V4_OTHERS });
  assert.ok(!detail.includes('本次無新增內容'), detail);
  assert.ok(!detail.includes('預告裡沒講完') && !detail.includes('覆土厚度') && !detail.includes('勤摘') && !detail.includes('第一站提到培養土'), detail);
  assert.ok(detail.includes('### 把陽台條件看得更細一點') && detail.includes('早上曬到的東向陽台'), detail);
  assert.ok(!/\n{3,}/.test(detail), 'no double blank line left');
  // A body chapter keeps a section named after its own topic, but never a generic or repeated heading nor a no-op line.
  const body = expandChapterDetail(V4_INTRO, ['@@insert', '### 補充', '', '補充段落。', '', '### 為什麼先做小的？', '', '重複段落。', '', '### 盆器的材質', '', '塑膠盆輕。', '@@insert', 'No new content.'].join('\n'), 'zh-TW', '', { role: 'body', others: V4_OTHERS });
  assert.ok(body.detail.includes('### 盆器的材質') && !body.detail.includes('補充段落') && !body.detail.includes('重複段落') && !body.detail.includes('No new content'), body.detail);
  assert.equal(body.applied, 1);
  // An answer that is only a no-op line applies nothing: the chapter stays as it was.
  assert.equal(expandChapterDetail(V4_INTRO, '@@insert\n本次無新增內容。\n', 'zh-TW'), undefined);
  // A @@with that is only a no-op line never deletes the passage.
  assert.equal(expandChapterDetail(V4_INTRO, '@@replace\n先從一盆開始。\n@@with\n無需修改。\n', 'zh-TW'), undefined);
  // Closing: a paragraph that names another chapter goes; its own paragraph stays.
  const closing = expandChapterDetail(V4_INTRO, ['@@insert', '回頭看〈採收與保存〉的做法，摘外葉就好。', '', '一年後，你的陽台會是什麼樣子？'].join('\n'), 'zh-TW', '', { role: 'closing', others: V4_OTHERS });
  assert.ok(!closing.detail.includes('摘外葉') && closing.detail.includes('一年後'), closing.detail);
});

test('isNoOpLine / isGenericHeading: zh-TW, zh-CN and English no-op lines and generic headings; real prose and real headings are kept', () => {
  for (const line of ['本次無新增內容。', '（本次無新增內容）', '無需修改。', '本章没有新增内容', '本次无需修改', 'No new content.', 'Nothing to add.', 'No changes needed.'])
    assert.equal(sections.isNoOpLine(line), true, line);
  for (const line of ['本次新增兩段。', '無論如何都要先修改盆土。', '沒有排水孔的盆不要用。', 'No soil, no harvest.', ''])
    assert.equal(sections.isNoOpLine(line), false, line);
  for (const heading of ['### 土壤與容器：預告裡沒講完的小細節', '### 補充', '### 补充说明', '### 其他', '### More details', '### Additional notes'])
    assert.equal(sections.isGenericHeading(heading), true, heading);
  for (const heading of ['### 補充水分的時機', '### 為什麼先做小的？', '### 把陽台條件看得更細一點', '### Details of drainage'])
    assert.equal(sections.isGenericHeading(heading), false, heading);
});

test('dropProcessNotes (live v4 〈採收與保存〉): the flagged process-note sentence the fix left in goes; a sentence carrying a number stays; headings, records and sources stay', () => {
  const LINE = '至於一天中什麼時候採，現有資料不足，我沒有查到可靠的官方建議，所以這裡只分享常見的家庭做法，請當作參考。很多人習慣在早上或傍晚採葉菜，因為中午太陽大，葉片容易軟軟垂垂的。';
  const detail = ['## 採收', '', LINE, '', '我沒有查到可靠的官方建議。', '', '本次搜尋只找到 2 篇文章。', '', '## 來源', '', '- [沒有查到](https://example.org/a)', '', '> [!vam-book]- 研究備註', '> 現有資料不足，我沒有查到。', ''].join('\n');
  const out = sections.dropProcessNotes(detail);
  assert.deepEqual([...out.removed], ['至於一天中什麼時候採，現有資料不足，我沒有查到可靠的官方建議，所以這裡只分享常見的家庭做法，請當作參考。', '我沒有查到可靠的官方建議。']);
  assert.ok(out.detail.includes('\n很多人習慣在早上或傍晚採葉菜，因為中午太陽大，葉片容易軟軟垂垂的。\n'), out.detail);
  assert.ok(out.detail.includes('本次搜尋只找到 2 篇文章。'), 'a sentence with a number is not deleted (the proofread flags it again)');
  assert.ok(out.detail.includes('- [沒有查到](https://example.org/a)') && out.detail.includes('> 現有資料不足，我沒有查到。'), 'sources and records stay');
  assert.ok(!/\n{3,}/.test(out.detail), out.detail);
  assert.equal(sections.dropProcessNotes('## A\n\n普通段落。\n').detail, '## A\n\n普通段落。\n', 'nothing to drop: unchanged');
  assert.equal(sections.dropProcessNotes('I could not find the source. Water daily.').detail, 'Water daily.');
});

test('dropProcessNotes: CRLF text keeps CRLF and drops the process-note sentence', () => {
  const out = sections.dropProcessNotes('## A\r\n\r\n我沒有查到可靠的官方建議。\r\n\r\n普通段落。\r\n');
  assert.deepEqual([...out.removed], ['我沒有查到可靠的官方建議。']);
  assert.ok(out.detail.includes('普通段落。') && !out.detail.includes('我沒有查到'), out.detail);
  assert.ok(!/(^|[^\r])\n/.test(out.detail), 'line endings stay CRLF');
});

test('expandChapterDetail: a @@replace passage applies only as whole lines (never a part of a line)', () => {
  const { expandChapterDetail } = sections;
  const old = '\n## 開場\n\n開場段落有圖。\n\n結尾。\n';
  assert.equal(expandChapterDetail(old, '\n@@replace\n段落有\n@@with\n![x](https://example.org/x.png)\n', 'zh-TW'), undefined, 'nothing applies');
  const whole = expandChapterDetail(old, '\n@@replace\n開場段落有圖。\n@@with\n開場段落（新）。\n', 'zh-TW');
  assert.equal(whole.applied, 1); assert.ok(whole.detail.includes('開場段落（新）。') && !whole.detail.includes('開場段落有圖。'));
});

test('bookExpandRequirements: the chapter goes in as data, the amount is the target minus the measure, the length setting is left out and the point list comes last', () => {
  const { bookExpandRequirements } = load('core/book-pipeline/settings.ts');
  const text = bookExpandRequirements({ tone: '親切', length: '每章約5000至8000字' }, '## 開場\n內容', { kind: 'under', measured: 2253, min: 5000, max: 8000, unit: '字', version: 1 }, 'POINTS');
  assert.match(text, /the chapter text is 2253 characters \(字\), short of the asked 5000 to 8000/);
  // The ask is the setting's minimum at least (never the 0.8x tolerance), aiming at the midpoint.
  assert.match(text, /Write about 4247 characters \(字\) of new text, never less than 2747 characters \(字\) \(the whole chapter must reach at least 5000 characters \(字\); aim at about 6500\)/);
  assert.match(text, /<<<CHAPTER\n## 開場\n內容\nCHAPTER>>>\n\nPOINTS$/);
  assert.match(text, /- tone: 親切/);
  assert.doesNotMatch(text, /- length:/);
  assert.match(text, /New ### headings \(hard requirement\).*never generic.*「本次無新增內容」/s);
  assert.doesNotMatch(text, /This chapter's role|Do not cover/, 'no scope given: no scope lines');
  // An intro is told its role and the other chapters as "do not cover".
  const intro = bookExpandRequirements({}, '內容', undefined, undefined, { role: 'intro', others: ['土壤與容器準備', '播種與育苗'] });
  assert.match(intro, /This chapter's role: intro, the book's guide\. Deepen its own covers only: at most one or two sentences of preview for each later chapter/);
  assert.ok(intro.includes('Do not cover (each has its own chapter; JSON strings): "土壤與容器準備" "播種與育苗"'), intro);
  const closing = bookExpandRequirements({}, '內容', undefined, undefined, { role: 'closing', others: ['A'] });
  assert.match(closing, /This chapter's role: closing\. Deepen its own covers only/);
});

test('lengthReason: the first verdict keeps the 0.8x tolerance; after the fix round (strict) a chapter below the minimum is under', () => {
  const { lengthReason } = load('core/book-pipeline/settings.ts');
  const body = '好'.repeat(90);
  assert.equal(lengthReason('100-200 字', body), undefined, '90 of 100 is within the tolerance');
  assert.equal(lengthReason('100-200 字', body, undefined, true)?.kind, 'under');
  assert.equal(lengthReason('100-200 字', body, undefined, true)?.measured, 90);
  assert.equal(lengthReason('100-200 字', '好'.repeat(100), undefined, true), undefined, 'the minimum itself is enough');
  assert.equal(lengthReason('100-200 字', '好'.repeat(230), undefined, true), undefined, 'strict is about the minimum only; the 1.2x top stays');
});
