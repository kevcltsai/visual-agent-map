// Picture-book review core (T2 of "book without a panel"): the attention rules moved out of the gate 2 panel, the fingerprint, the two
// callouts the program writes at the top of a chapter's Detail, their reading and editing in raw text, plain-text escaping of untrusted
// text, the notes parser and the shared proof body. Pure text in and out; the real Obsidian look is UI evidence for the tester.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { loadSource } = require('./support-replay.cjs');

const b = loadSource(`
export * from "./experiences/visual-map/book-pipeline-review";
export { projectProofBody as projectDirect } from "./core/book-pipeline/book-notes";
export { neutralizeDetail, neutralizeText, chapterBody } from "./core/book-pipeline/note-sections";
export { proofKey } from "./core/book-pipeline/proof";
export { setUiLanguage, t } from "./i18n";
export { shortHash, diagramHash } from "./core/book-pipeline/image-slots";
export { bookIssueText } from "./experiences/visual-map/book-pipeline-ui";
`, { obsidian: { ...S.obsidian, Modal: dom.makeModal(), Notice: dom.makeNotice([]), Component: class {}, MarkdownRenderChild: class {} } }, { createFragment: dom.createFragment, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, window: { setTimeout, clearTimeout, setInterval, clearInterval } });
b.setUiLanguage('zh-TW');
const legacy = require('./support-legacy-boxes.cjs')(b);

const START = '<!-- visual-agent-map:detail:start -->';
const END = '<!-- visual-agent-map:detail:end -->';
const note = (detail, head = '# T\n\n## Current Summary\n\nS\n\n## Detail\n\n') => `${head}${START}\n${detail}\n${END}\n\n## Prompt\n\nP\n`;
const card = (over = {}) => ({ id: 'n1', index: 1, title: 'T', stage: 'checked', structureUnmet: 0, factsOpen: 0, galleryBare: false, seam: false, ...over });
const link = { path: 'Notes/Next', title: '第二章' };
const review = (over = {}, reasons = ['有 2 項寫作要求還沒達成']) => legacy.reviewCallout(card(over), reasons, link, 'abc123', 'run-1');
const trial = (stopped) => legacy.trialCallout(1, 3, undefined, link, stopped, { runId: 'run-1', nodeId: 'n1' });
const tick = (text, at) => { let n = 0; return text.replace(/\[ \]/g, m => (n++ === at ? '[x]' : m)); };

// ---- attention rules (moved from the gate 2 panel, unchanged behaviour; the panel's own test keeps its copy until the panel goes) ----
test('attention: every reason keeps a card in the list, reads plain, and a clean checked card is not listed', () => {
  assert.equal(b.needsAttention(card()), false);
  const cases = {
    review: card({ stage: 'needs-review', failureText: '結尾沒有接到下一章' }),
    reviewNoText: card({ stage: 'needs-review' }),
    unfinished: card({ stage: 'written' }),
    pending: card({ stage: 'pending' }),
    structure: card({ structureUnmet: 2 }),
    facts: card({ factsOpen: 1 }),
    gallery: card({ galleryBare: true }),
    seam: card({ seam: true })
  };
  for (const [name, c] of Object.entries(cases)) {
    assert.ok(b.needsAttention(c), name);
    assert.ok(b.attentionReasons(c).every(x => x && !/\b[CN]\d+\b|unmet|proof/i.test(x)), `${name}: ${JSON.stringify(b.attentionReasons(c))}`);
  }
  assert.equal(b.attentionReasons(card({ structureUnmet: 2, factsOpen: 1, seam: true })).length, 3, 'reasons add up');
  assert.equal(b.attentionReasons(card({ stage: 'needs-review', failureText: 'X' }))[0], 'X');
});
test('plainNote and reasonOf: codes never reach the reader, at most 3 distinct proof notes', () => {
  assert.equal(b.plainNote('C1: Xie 2013 沒能打開核對'), 'Xie 2013 沒能打開核對');
  assert.equal(b.plainNote('N2：  a   b'), 'a b');
  const items = ['C1: a', 'C2: b', 'C3: c', 'C4: d', 'C5: a'].map((n, i) => ({ id: `C${i}`, type: 'fact', status: 'unmet', note: n, sources: [] }));
  const reason = b.reasonOf('proof unmet: C1', { items });
  assert.equal(reason, ['a', 'b', 'c'].join('，'));
  assert.ok(!/\bC\d/.test(b.reasonOf('proof unmet: C1', { items: [{ id: 'C1', type: 'fact', status: 'unmet', note: 'C1', sources: [] }] })));
  assert.match(b.reasonOf('proof unmet: facts_unverified', undefined), /./);
});
test('reasons joined: no separator after a sentence end (live v5 「位置不符。，」), in the review panel and on the card; a caption with English reads as its own reason', () => {
  const items = [{ id: 'C1', type: 'fact', status: 'unmet', note: '位置不符。', sources: [] }, { id: 'C2', type: 'fact', status: 'unmet', note: '刪除或改寫', sources: [] }];
  const reason = b.reasonOf('proof unmet: C1 C2 images:under:1:2', { items });
  assert.ok(!/。，/.test(reason), reason);
  assert.match(reason, /^位置不符。刪除或改寫，圖片不足/);
  const card = b.bookIssueText('write failed: no_body images:under:1:2');
  assert.ok(!/。，/.test(card) && /圖片不足/.test(card), card);
  assert.ok(!/。，/.test(b.bookIssueText('write failed: no_body length:over:241:100-200:字:v1')));
  assert.match(b.reasonOf('images unmet: captions:latin', undefined), /英文字/);
  assert.match(b.bookIssueText('images unmet: images:under:0:1 captions:latin'), /圖片不足.*，圖說的中文裡夾著英文字/);
  assert.equal(b.joinReasons(['Too short.', 'Check it']), 'Too short. Check it');
});
test('a failed automatic fix keeps the reasons the chapter had (live v6 W): the three v6 shapes name the failure and every shortfall, on the card and in the box', () => {
  const { carryIssue } = loadSource('export { carryIssue } from "./experiences/visual-map/book-pipeline-reasons";');
  const shapes = [
    // 〈澆水〉: the expansion gave no usable block; the box said only 「寫作失敗」, no length, no pictures.
    ['write failed: fix_no_edits', 'length unmet: length:under:2913:5000-8000:字:v2 images:under:2:6', [/章節維持原樣/, /2913 字/, /放了 2 張，設定至少 6 張/]],
    // 〈土壤〉: gate 1 had C8 and the picture shortfall; the fix after gate 1 failed (author_failed).
    ['write failed: author_failed', 'proof unmet: C8 images:under:3:6', [/寫作呼叫失敗/, /校對/, /放了 3 張，設定至少 6 張/]],
    // 〈播種〉: the fix wrote no body; the facts still to check were lost.
    ['write failed: no_body', 'proof unmet: facts_unverified', [/沒寫出正文/, /無法查證/]]
  ];
  for (const [failure, before, words] of shapes) {
    const issue = carryIssue(failure, before);
    assert.equal(issue, `${failure} + ${before}`);
    for (const text of [b.bookIssueText(issue), b.reasonOf(issue, undefined)]) for (const word of words) assert.match(text, word, `${issue}: ${text}`);
    assert.equal(carryIssue('write failed: no_body', issue), `write failed: no_body + ${before}`, 'an earlier failure is dropped, never stacked');
  }
  assert.equal(carryIssue('write failed: no_body', 'write failed: author_failed'), 'write failed: no_body');
  assert.equal(carryIssue('write failed: no_body', undefined), 'write failed: no_body');
});
test('galleryBare: only a gallery chapter whose every slot is missing', () => {
  const prompt = '圖安排：\n- 圖位 1｜圖表｜睡眠週期｜位置：第二段\n- 圖位 2｜照片｜腦波｜位置：結尾\n';
  const rec = slots => `<!-- book-slots:v1 ${JSON.stringify({ slots, bad: 0 })} -->\n`;
  const missing = rec([{ index: 1, state: 'missing', reasonCode: 'not_found' }, { index: 2, state: 'missing', reasonCode: 'not_found' }]);
  assert.equal(b.galleryBare('gallery', { prompt, detail: `text\n\n${missing}` }), true);
  assert.equal(b.galleryBare('body', { prompt, detail: `text\n\n${missing}` }), false);
  assert.equal(b.galleryBare('gallery', { prompt, detail: 'plain' }), false, 'no record: not bare');
  assert.equal(b.galleryBare('gallery', { prompt: '圖安排：無\n', detail: missing }), false);
  assert.equal(b.galleryBare('gallery', undefined), false);
});
test('galleryBare: a slot filled by a drawn diagram is not bare, and a hand-edited block is not bare either', () => {
  const prompt = '圖安排：\n- 圖位 1｜圖表｜睡眠週期｜位置：第二段\n- 圖位 2｜照片｜腦波｜位置：結尾\n';
  const chart = 'flowchart LR\n  A[甲] --> B[乙]';
  const rec = h => `<!-- book-slots:v1 ${JSON.stringify({ slots: [{ index: 1, state: 'diagram', hash: h }, { index: 2, state: 'missing', reasonCode: 'not_found' }], bad: 0 })} -->\n`;
  const detail = (block, h) => `text\n\n\`\`\`mermaid\n${block}\n\`\`\`\n\n示意圖｜睡眠週期（依本章內文整理，非史料原圖）\n\n${rec(h)}`;
  assert.equal(b.galleryBare('gallery', { prompt, detail: detail(chart, b.diagramHash(chart)) }), false, 'the chart fills slot 1');
  assert.equal(b.galleryBare('gallery', { prompt, detail: detail('flowchart LR\n  A[甲] --> B[丙]', b.diagramHash(chart)) }), false, 'edited by hand: still not bare');
  assert.equal(b.galleryBare('gallery', { prompt, detail: `text\n\n${rec(b.diagramHash(chart))}` }), false, 'record only (block deleted): "edited", not missing');
});

// ---- fingerprint ----
test('seam reason names the chapter that changed (re-verify 2 item 3: after "rewrite with AI" the neighbour box says why it is new), only while that chapter is still next to it', () => {
  const order = ['a', 'b', 'c', 'd'];
  const titles = { a: '豆子', b: '手沖', c: '法式濾壓', d: '水質' };
  const entries = (seams, ord = order) => b.reviewEntries({
    order: ord,
    titleOf: id => titles[id],
    noteOf: id => ({ pipelineStage: 'checked', ...(seams[id] ? { pipelineSeam: seams[id] } : {}) })
  });
  const zh = n => `鄰卡企劃或正文已變更，尚未人工核對（第 ${n} 張，版本 4）`;
  const one = entries({ c: zh(2) });
  assert.equal(one.map(e => e.card.id).join(), 'c', 'the neighbour of the rewritten chapter is listed (seam counts, design §7-3)');
  assert.equal(one[0].problems.map(p => p.text).join('|'), '「手沖」改過，和這章的銜接還沒確認');
  assert.equal(entries({ a: zh(2) })[0].problems[0].text, '「手沖」改過，和這章的銜接還沒確認', 'the next chapter names it too');
  assert.equal(entries({ c: zh(2) }, ['a', 'c', 'b', 'd'])[0].problems[0].text, '前後章改過，銜接還沒確認', 'reordered: card 2 is no longer next to it, no title is guessed');
  assert.equal(entries({ d: zh(1) })[0].problems[0].text, '前後章改過，銜接還沒確認', 'not adjacent');
  assert.equal(entries({ c: 'Neighbouring card\'s plan or text changed; not yet checked by a person (card 2, revision 4)' })[0].problems[0].text, '「手沖」改過，和這章的銜接還沒確認', 'the English seam line');
  assert.equal(entries({ c: '舊格式' })[0].problems[0].text, '前後章改過，銜接還沒確認', 'no position: the plain sentence');
});

test('fingerprint: stage, issue codes, proof key and the full seam value each change it; the same input is stable', () => {
  const base = { stage: 'checked', issue: 'structure unmet: S1', proofKey: 'r:n:1:h:l', seam: '前後章變了（第 2 張，版本 2）' };
  const fp = b.attentionFingerprint(base);
  assert.equal(fp, b.attentionFingerprint({ ...base }));
  assert.match(fp, /^[0-9a-f]+$/, 'safe inside a marker');
  for (const change of [{ stage: 'needs-review' }, { issue: 'structure unmet: S2' }, { proofKey: 'r:n:2:h:l' }, { seam: '前後章變了（第 2 張，版本 3）' }, { seam: '前後章變了（第 3 張，版本 2）' }, { seam: undefined }])
    assert.notEqual(b.attentionFingerprint({ ...base, ...change }), fp, JSON.stringify(change));
  assert.equal(b.attentionFingerprint({ stage: 'checked' }), b.attentionFingerprint({ stage: 'checked', issue: '', proofKey: '', seam: '' }), 'missing = empty');
});

test('stale proof (T6c): the edited problem feeds the list and the fingerprint; non-stale fingerprints are unchanged', () => {
  const card = { id: 'n1', index: 1, title: 'T', stage: 'checked', structureUnmet: 0, factsOpen: 0, galleryBare: false, seam: false };
  assert.equal(b.reviewProblems(card).length, 0);
  const stale = b.reviewProblems({ ...card, proofStale: true });
  assert.deepEqual([...stale.map(p => p.kind)], ['edited']);
  assert.equal(stale[0].text, '已修改，未重新校對');
  assert.equal(b.needsAttention({ ...card, proofStale: true }), true);
  const base = { stage: 'checked', issue: '', proofKey: 'k', seam: '' };
  assert.equal(b.attentionFingerprint({ ...base, stale: false }), b.attentionFingerprint(base), 'old hashes stay equal');
  assert.notEqual(b.attentionFingerprint({ ...base, stale: true }), b.attentionFingerprint(base));
});

// ---- escaping untrusted text ----
test('plain text: callout, checkbox, wikilink, image, comment, highlight, HTML and heading syntax cannot form', () => {
  const evil = ['[!x]', '- [ ] box', '[[a]]', '![](http://x)', '%% hidden %%', '==hl==', '<img src=x onerror=1>', '# Heading', '> quote', '1. item', '```', '| a | b |', 'https://evil.test/p'];
  for (const text of evil) {
    const out = b.plainText(text);
    assert.ok(!/\[!|\[\[|!\[|%%|==|<|>|^#|^- |^\d+\. |```|\]\(|:\/\//.test(out), `${JSON.stringify(text)} -> ${JSON.stringify(out)}`);
    assert.ok(!out.includes('\n'));
  }
  assert.equal(b.plainText('line\n[!x]\r\n- [ ] y'), b.plainText('line [!x] - [ ] y'), 'one line');
  assert.equal(b.plainText(undefined), '');
  assert.equal(Array.from(b.plainText('字'.repeat(1000))).length, 300, 'long text is cut');
  assert.equal(b.plainText('日本語 ✓ 😀'), '日本語 ✓ 😀', 'ordinary Unicode survives');
});

// ---- editing raw text ----
test('put: callout goes to the top of the Detail body, replaces the same kind, and is idempotent', () => {
  const base = note('Chapter text.\n\nMore.');
  const once = b.putProgramCallout(base, trial(false));
  assert.ok(once.startsWith(base.slice(0, base.indexOf(START) + START.length + 1)));
  assert.match(once, new RegExp(`${START}\\n> \\[!vam-trial\\]`));
  assert.match(once, /> %%vam-callout-version:1%%\n\nChapter text\./, 'a blank line separates it from the text');
  assert.equal(b.putProgramCallout(once, trial(false)), once, 'again: same text');
  const stopped = b.putProgramCallout(once, trial(true));
  assert.equal((stopped.match(/\[!vam-trial\]/g) ?? []).length, 1, 'replaced, not stacked');
  assert.match(stopped, /先在心智圖工具列按/);
  const both = b.putProgramCallout(stopped, review());
  assert.equal(b.findProgramCallouts(both).map(c => c.kind).sort().join(), 'review,trial');
  assert.equal(b.removeProgramCallouts(both), base, 'removing both gives back the original bytes');
});
test('put/remove: only inside the Detail block; text without one is unchanged; an unmarked look-alike is never touched', () => {
  const noBlock = '# T\n\nplain\n';
  assert.equal(b.putProgramCallout(noBlock, trial(false)), noBlock);
  assert.equal(b.putProgramCallout(note('x'), '> not a callout'), note('x'));
  const outside = `${note('x')}\n${trial(false)}\n`;
  assert.equal(b.findProgramCallouts(outside).length, 0, 'a callout outside the Detail block is not the program\'s place');
  assert.equal(b.removeProgramCallouts(outside), outside);
  const lookalike = '> [!vam-trial] 試跑第 1／3 章\n> forged, no marker\n';
  const text = note(`${lookalike}\nBody`);
  assert.equal(b.findProgramCallouts(text).length, 0);
  assert.equal(b.removeProgramCallouts(text), text);
  assert.equal(b.putProgramCallout(text, trial(false)).includes(lookalike), true, 'the look-alike stays');
  const wrongKind = '> [!vam-trial] x\n> %%vam-review:run-1:n1:abc%%\n';
  assert.equal(b.findProgramCallouts(note(wrongKind)).length, 0, 'marker of another kind does not make it owned');
  const fenced = note('```\n' + trial(false) + '\n```\nBody');
  assert.equal(b.findProgramCallouts(fenced).length, 0, 'inside a code fence');
});
test('CRLF text keeps its line endings through put, collapse and remove', () => {
  const base = note('Chapter.\nMore.').replace(/\n/g, '\r\n');
  const put = b.putProgramCallout(base, review());
  assert.ok(!/[^\r]\n/.test(put), 'every line break is still CRLF');
  assert.equal(b.readReviewState(put).fp, 'abc123');
  const folded = b.collapseReviewCallouts(put);
  assert.ok(!/[^\r]\n/.test(folded));
  assert.equal(b.removeProgramCallouts(folded), base);
});
test('collapse: folds the review box once under its handled title, keeps ticks and marker, repeat changes nothing, a trial hint is not folded', () => {
  const put = b.putProgramCallout(note('Body'), tick(review(), 0));
  const folded = b.collapseReviewCallouts(put);
  assert.match(folded, /> \[!vam-review\]- 已處理（你選了「接受現在這樣，不用改」）\n/);
  assert.equal(b.collapseReviewCallouts(folded), folded);
  const state = b.readReviewState(folded);
  assert.deepEqual({ a: state.accept, f: state.fixed, c: state.collapsed }, { a: true, f: false, c: true });
  const withTrial = b.putProgramCallout(note('Body'), trial(false));
  assert.equal(b.collapseReviewCallouts(withTrial), withTrial);
  assert.equal(b.collapseReviewCallouts('no block'), 'no block');
});
test('handled title (mockup ⑦-3): either box ends the same way: titled "handled" while open, then folded; unticked opens with the question again; CRLF kept', () => {
  for (const at of [0, 1]) {
    const put = b.putProgramCallout(note('Body'), tick(review(), at));
    const label = at === 0 ? '接受現在這樣，不用改' : '我改好了';
    const shown = b.markReviewHandled(put);
    assert.match(shown, new RegExp(`> \\[!vam-review\\] 已處理（你選了「${label}」）\n`), 'open, titled handled');
    assert.equal(b.markReviewHandled(shown), shown, 'again: unchanged');
    const st = b.readReviewState(shown);
    assert.deepEqual({ c: st.collapsed, h: st.handled }, { c: false, h: true });
    const folded = b.collapseReviewCallouts(shown);
    assert.match(folded, new RegExp(`> \\[!vam-review\\]- 已處理（你選了「${label}」）\n`));
    const untick = folded.replace('[x]', '[ ]');
    const open = b.reopenReviewCallouts(untick);
    assert.match(open, /> \[!vam-review\] 這章要你看\n/);
    assert.deepEqual({ c: b.readReviewState(open).collapsed, h: b.readReviewState(open).handled }, { c: false, h: false });
    assert.equal(b.reopenReviewCallouts(folded), folded, 'a ticked box is not reopened');
  }
  const unticked = b.putProgramCallout(note('Body'), review());
  assert.equal(b.markReviewHandled(unticked), unticked, 'nothing ticked: nothing to mark');
  assert.equal(b.readReviewState(unticked).handled, false);
  // a hand-edited box: only "keep" answers it; "rewrite" is a command, not an answer
  const hand = b.putProgramCallout(note('Body'), legacy.reviewCallout(card(), ['x'], link, 'abc123', 'run-1', { op: 'op1', ifp: 'f1' }));
  assert.equal(b.markReviewHandled(tick(hand, 1)), tick(hand, 1));
  assert.match(b.markReviewHandled(tick(hand, 0)), /已處理（你選了「保留我的版本」）/);
  const crlf = b.putProgramCallout(note('Body').replace(/\n/g, '\r\n'), tick(review(), 0));
  assert.ok(!/[^\r]\n/.test(b.collapseReviewCallouts(b.markReviewHandled(crlf))), 'CRLF stays');
  assert.equal(b.chapterBody(b.collapseReviewCallouts(put0())), b.chapterBody(put0()), 'the chapter text does not move');
});
test('old-build box: ticked and already folded with the old title 這章要你看 is retitled handled, stays folded, CRLF kept', () => {
  for (const at of [0, 1]) {
    const label = at === 0 ? '接受現在這樣，不用改' : '我改好了';
    const old = b.putProgramCallout(note('Body'), tick(review(), at)).replace('[!vam-review]', '[!vam-review]-');
    assert.match(old, /> \[!vam-review\]- 這章要你看\n/);
    const fixed = b.markReviewHandled(old);
    assert.match(fixed, new RegExp(`> \\[!vam-review\\]- 已處理（你選了「${label}」）\n`));
    assert.equal(b.markReviewHandled(fixed), fixed);
    assert.equal(b.collapseReviewCallouts(fixed), fixed);
    const crlf = b.markReviewHandled(old.replace(/\n/g, '\r\n'));
    assert.ok(!/[^\r]\n/.test(crlf) && crlf.includes('已處理'));
  }
});
const put0 = () => b.putProgramCallout(note('Body'), tick(review(), 0));
test('review state: first or second box ticks count, the fingerprint decides if the tick still stands', () => {
  const put = at => b.putProgramCallout(note('Body'), at === undefined ? review() : tick(review(), at));
  const none = b.readReviewState(put());
  assert.deepEqual({ a: none.accept, f: none.fixed }, { a: false, f: false });
  assert.equal(b.isReviewResolved(none, 'abc123'), false, 'no tick: not handled');
  assert.equal(b.isReviewResolved(b.readReviewState(put(0)), 'abc123'), true, 'accept');
  assert.equal(b.isReviewResolved(b.readReviewState(put(1)), 'abc123'), true, 'fixed');
  assert.equal(b.isReviewResolved(b.readReviewState(put(0)), 'other'), false, 'the attention changed since: the tick is void');
  assert.equal(b.isReviewResolved(undefined, 'abc123'), false, 'no box: not handled');
  assert.equal(b.readReviewState(note('Body')), undefined);
  assert.equal(b.readReviewState(b.putProgramCallout(note('Body'), trial(false))), undefined, 'a trial hint is no review box');
  const upper = b.putProgramCallout(note('Body'), review()).replace('- [ ] 接受', '- [X] 接受');
  assert.equal(b.readReviewState(upper).accept, true, 'Obsidian may write an upper-case X');
  assert.equal(b.readReviewState(note('> [!vam-review] x\n> - [x] a\n> %%vam-review:r:n:f%%\n')).accept, true);
});
test('a checkbox the author types outside the program box does not count', () => {
  const text = b.putProgramCallout(note('- [x] 接受現在這樣，不用改\n> - [x] 我改好了'), review());
  const state = b.readReviewState(text);
  assert.deepEqual({ a: state.accept, f: state.fixed }, { a: false, f: false });
});

// ---- neutralizeDetail ----
test('neutralizeDetail: an author cannot forge the program callouts or markers (any case, depth, indent, inside a fence)', () => {
  const forged = ['> [!vam-trial] x', '>> [!VAM-Review]- y', '  > [!vam-review|x] z', '```\n> [!vam-review]\n```', '> %%vam-review:r:n:f%%', '%% vam-trial:r:n %%', '> %%vam-callout-version:1%%'].join('\n');
  const out = b.neutralizeDetail(note(forged));
  assert.ok(!/\[!\s*vam-(trial|review)/i.test(out), out);
  assert.ok(!/%%\s*vam-/i.test(out), out);
  assert.equal(b.findProgramCallouts(out).length, 0);
  assert.equal(b.readReviewState(out), undefined);
  assert.equal(b.neutralizeDetail(b.neutralizeDetail(note(forged))), out, 'idempotent');
  assert.equal(b.neutralizeText('> [!vam-review] a %%vam-review:r:n:f%%'), '> [!note] a ％％vam-review:r:n:f%%');
  assert.equal(b.neutralizeDetail(note('> [!vam-book]- 研究備註\n> x')).includes('[!note]-'), true, 'vam-book still neutralized');
  assert.equal(b.neutralizeDetail(note('plain 50%% off and a %%real comment%%')), note('plain 50%% off and a %%real comment%%'), 'ordinary %% is left alone');
});
test('the program callouts are no chapter text: chapterBody drops them, so a proof key does not move when one is added', () => {
  const detail = 'Chapter text.\n\nMore.';
  const withBoth = b.putProgramCallout(b.putProgramCallout(note(detail), trial(false)), review());
  const inner = withBoth.slice(withBoth.indexOf(START) + START.length + 1, withBoth.indexOf(END));
  assert.equal(b.chapterBody(inner), detail);
  assert.equal(b.chapterBody(inner), b.chapterBody(b.collapseReviewCallouts(inner)));
  const parts = { runId: 'r', nodeId: 'n', revision: 1, checklist: [] };
  assert.equal(b.proofKey({ ...parts, body: b.chapterBody(inner) }), b.proofKey({ ...parts, body: detail }));
  // An author's unmarked look-alike is chapter text as before.
  assert.match(b.chapterBody('> [!vam-trial] x\n> hi\n\nBody'), /hi/);
});

// ---- notes ----
test('countNotes: counts only the program wrapper in chapter text; not code, hidden records, program callouts or other markup', () => {
  const w = (n) => `==字${n}==%%備註#${n}：改一下%%`;
  assert.equal(b.countNotes(note('plain')), 0);
  assert.equal(b.countNotes(note(`a ${w(1)} b\n\n${w(2)}`)), 2);
  assert.equal(b.countNotes(note('```\n' + w(1) + '\n```')), 0, 'in code');
  assert.equal(b.countNotes(note(`> [!vam-book]- 研究備註\n> ${w(1)}\n\nBody`)), 0, 'in a hidden record');
  assert.equal(b.countNotes(note('==x== %%c%% ==y==%%not a note%%')), 0, 'plain highlight and comment');
  assert.equal(b.countNotes(note(w(1)).replace(/\n/g, '\r\n')), 1, 'CRLF');
  assert.equal(b.countNotes(''), 0);
  assert.equal(b.wrapNote('字', 1, '改一下'), '==字==%%備註#1：改一下%%');
  for (const bad of [['a==b', 1, 'n'], ['a', 1, 'n%%m'], ['a', 1, 'n\nm'], ['', 1, 'n'], ['a', 1, ''], ['a', 0, 'n']]) assert.equal(b.wrapNote(...bad), null, JSON.stringify(bad));
});
test('proof body: the note wrapper goes, the annotated text stays; text without notes is byte-identical; the proof key round-trips', () => {
  const original = '第一段。\n\n第二段有重點文字，還有 a=b 與 50% 和 %%真註解%% 與 ==亮==。\n\n結尾。';
  assert.equal(b.projectDirect(original), original, 'no wrapper: same bytes');
  for (const text of ['', 'x', '==a==%%備註：舊格式%%', '==a==%%備註#x：no number%%', '==a== %%備註#1：space%%']) assert.equal(b.projectDirect(text), text, JSON.stringify(text));
  const noted = original.replace('重點文字', '==重點文字==%%備註#1：寫清楚一點%%');
  assert.notEqual(noted, original);
  assert.equal(b.projectDirect(noted), original, 'wrapper removed, annotated text kept');
  const twice = noted.replace('結尾', '==結尾==%%備註#2：太短%%');
  assert.equal(b.projectDirect(twice), original);
  assert.equal(b.projectDirect(b.projectDirect(twice)), original, 'idempotent');
  const parts = { runId: 'r', nodeId: 'n', revision: 2, checklist: [{ id: 'C1', type: 'fact', text: 'x' }] };
  const key = body => b.proofKey({ ...parts, body });
  assert.equal(key(b.projectDirect(noted)), key(original), 'original -> note added -> same key');
  assert.notEqual(key(noted), key(original), 'the unprojected body would have moved the key');
  assert.equal(b.projectProofBody(noted), original, 're-exported from the review module');
});

// ---- T10c: the length reason in the review text and the fingerprint ----
test('T10c length: failureText shows the length sentence (measured, range, unit), alone or after the proof reason, never the token', () => {
  const lone = b.reasonOf('length unmet: length:over:241:100-200:字:v1', undefined);
  assert.match(lone, /241/); assert.match(lone, /100/); assert.match(lone, /200/);
  assert.ok(!lone.includes('length:') && !lone.includes('unmet'));
  assert.equal(b.reasonOf('length unmet: length:over:241:100-200:字:v1 image_1', undefined), lone, 'notice tokens add no text');
  const mixed = b.reasonOf('proof unmet: C2 length:under:79:100-200:字:v1', { items: [{ id: 'C2', status: 'unmet', note: '日期不對' }] });
  assert.match(mixed, /日期不對/); assert.match(mixed, /79/);
});

test('T10c length: a different range, measured count, unit or rule version changes the fingerprint, so a ticked box no longer stands', () => {
  const fp = issue => b.attentionFingerprint({ stage: 'needs-review', issue, proofKey: 'k', seam: '' });
  const base = fp('length unmet: length:over:241:100-200:字:v1');
  for (const other of ['length:over:260:100-200:字:v1', 'length:over:241:100-300:字:v1', 'length:over:241:100-200:words:v1', 'length:over:241:100-200:字:v2', 'length:under:241:100-200:字:v1'])
    assert.notEqual(fp(`length unmet: ${other}`), base, other);
  assert.equal(fp('length unmet: length:over:241:100-200:字:v1'), base, 'stable');
  const ticked = b.readReviewState(b.putProgramCallout(note('Body'), tick(legacy.reviewCallout(card({ stage: 'needs-review' }), ['x'], link, base, 'run-1'), 0)));
  assert.equal(b.isReviewResolved(ticked, base), true);
  assert.equal(b.isReviewResolved(ticked, fp('length unmet: length:over:260:100-200:字:v1')), false, 'the measured number moved: the tick is void');
  assert.equal(b.isReviewResolved(ticked, fp('length unmet: length:over:241:100-300:字:v1')), false, 'the asked range changed: the tick is void');
});

test('kept text: no hand-edit question and no consistency findings while the keep holds; an edit after the keep asks the hand-edit question again whatever the stage says', () => {
  const integrity = require('./support-replay.cjs').load('core/book-pipeline/body-integrity.ts');
  const kept = integrity.keepDetail(integrity.stampDetail('程式寫的。').replace('程式寫的', '我改過的'));
  const found = [{ other: 'n2', own: 'x', theirs: 'y', suggestion: 'z' }];
  const of = (detail, stage = 'checked') => b.gate2Cards({ order: ['n1'], titleOf: () => 'T', noteOf: () => ({ detail, pipelineStage: stage, pipelineIssue: null }), inconsistencies: () => found })[0];
  const held = of(kept);
  assert.ok(!held.handEdited, 'the keep is the reader\'s answer');
  assert.equal(held.inconsistencies?.length ?? 0, 0, 'the consistency check does not ask about a kept text again');
  const later = of(kept.replace('我改過的', '我又改了'));
  assert.equal(later.handEdited, true, 'edited since the keep: the box asks again although the stage is still checked');
  assert.equal(later.inconsistencies.length, 1, 'no longer kept: the findings show again');
  assert.ok(b.reviewProblems(later).some(p => p.text === '這章有你手改的內容，這次重跑沒有重寫它'));
});

test('C7 hand-edited wording: text the program never wrote (no fingerprint, no [!vam-book] callout, a review box does not count) says it was there before the book', () => {
  const integrity = require('./support-replay.cjs').load('core/book-pipeline/body-integrity.ts');
  const box = review({ stage: 'needs-review' });
  const of = detail => b.gate2Cards({ order: ['n1'], titleOf: () => 'T', noteOf: () => ({ detail, pipelineStage: 'needs-review', pipelineIssue: 'write failed: hand_edited' }) })[0];
  const before = of(`${box}\n\n我自己寫的內容。`);
  assert.equal(before.handEdited, true);
  assert.equal(before.handBeforeBook, true);
  assert.deepEqual([...b.reviewProblems(before).map(p => p.text)], ['這張卡加入書之前就有內容，這次重跑沒有重寫它']);
  const stamped = of(integrity.stampDetail('程式寫的。').replace('程式寫的', '我改過的'));
  assert.equal(stamped.handBeforeBook, undefined);
  assert.deepEqual([...b.reviewProblems(stamped).map(p => p.text)], ['這章有你手改的內容，這次重跑沒有重寫它']);
  const withCallout = of('舊的內容。\n\n> [!vam-book]- 研究筆記\n> x\n');
  assert.equal(withCallout.handBeforeBook, undefined, 'a [!vam-book] callout shows the program wrote here');
  assert.equal(of('x').handBeforeBook, true);
  const notHand = b.gate2Cards({ order: ['n1'], titleOf: () => 'T', noteOf: () => ({ detail: 'x', pipelineStage: 'needs-review', pipelineIssue: 'proof failed: timeout' }) })[0];
  assert.equal(notHand.handBeforeBook, undefined, 'only a hand-edited skip');
});

// ---- Cover image B4: a cover that may not fit is a reason to look (token cover:off) ----
test('cover:off: the token reads as one plain sentence (alone or beside other picture reasons), never as a code; the same word as cover.ts', () => {
  const cover = require('./support-replay.cjs').load('core/book-pipeline/cover.ts');
  const slots = require('./support-replay.cjs').load('core/book-pipeline/image-slots.ts');
  assert.equal(cover.coverOffToken, 'cover:off');
  assert.deepEqual(JSON.parse(JSON.stringify(slots.splitPictureIssue(`images unmet: ${cover.coverOffToken}`))), { rest: '', coverOff: true });
  const lone = b.reasonOf('images unmet: cover:off', undefined);
  assert.match(lone, /封面圖可能對不上/); assert.ok(!/cover:off|unmet/.test(lone));
  const mixed = b.reasonOf('images unmet: images:off:2 cover:off', undefined);
  assert.match(mixed, /第 2 張圖和前後文對不上/); assert.match(mixed, /封面圖可能對不上/);
  assert.deepEqual(b.reasonLinesOf('images unmet: images:under:1:3 cover:off', undefined).filter(line => /封面/.test(line)).length, 1);
  assert.equal(b.bookIssueText('images unmet: cover:off'), lone);
});
test('cover:off: a needs-review card with the token is in the attention list with that sentence; without the token (a cover that fits) nothing changes', () => {
  const of = issue => b.gate2Cards({ order: ['n1'], titleOf: () => 'T', noteOf: () => ({ detail: 'x', pipelineStage: 'needs-review', pipelineIssue: issue }) })[0];
  const flagged = of('images unmet: cover:off');
  assert.ok(b.needsAttention(flagged)); assert.ok(b.attentionReasons(flagged).some(text => /封面圖可能對不上/.test(text)));
  assert.equal(b.attentionReasons(of('images unmet: images:off:1')).filter(text => /封面/.test(text)).length, 0);
  const fp = issue => b.attentionFingerprint({ stage: 'needs-review', issue, proofKey: 'k', seam: '' });
  assert.notEqual(fp('images unmet: cover:off'), fp('images unmet: images:off:1'), 'a ticked box for another picture reason does not cover this one');
});
