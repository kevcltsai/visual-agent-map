// Picture-book notes, apply half (T6a): the pure logic (paragraph snapshot, placeholders, one-pass replace, skip marks, undo) and the
// stale-proof helper. Unit level; no model.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');

const na = load('core/book-pipeline/notes-apply.ts');
const bookNotes = load('core/book-pipeline/book-notes.ts');
const proof = load('core/book-pipeline/proof.ts');
const sections = load('core/book-pipeline/note-sections.ts');
const imageSlots = load('core/book-pipeline/image-slots.ts');
const review = load('experiences/visual-map/book-pipeline-review.ts');
const plain = value => JSON.parse(JSON.stringify(value));

const W = (text, n, note) => `==${text}==%%備註#${n}：${note}%%`;
const detailOf = body => `<!-- visual-agent-map:detail:start -->\n${body}\n<!-- visual-agent-map:detail:end -->`;
const P1 = `Brunelleschi showed linear ${W('perspective', 2, '說明是什麼')} around 1415 ![[mona.jpg]].`;
const P2 = 'A plain paragraph with no note.';
const P3 = `Second ${W('note', 3, '再短一點')} here with [site](https://a.b/c).`;
const RAW = `Title\n${detailOf(`${P1}\n\n${P2}\n\n${P3}`)}\n`;

test('findNotes: ranges, numbers and texts of the program wrappers only', () => {
  const found = bookNotes.findNotes(`x ${W('a', 1, 'n1')} y ==plain== z ${W('b', 12, 'n2')}`);
  assert.deepEqual(plain(found).map(f => [f.n, f.selected, f.note]), [[1, 'a', 'n1'], [12, 'b', 'n2']]);
  assert.equal(`x ${W('a', 1, 'n1')} y`.slice(found[0].from, found[0].to), W('a', 1, 'n1'));
});

test('snapshot: only annotated visible paragraphs, numbered p1.., headings and the pictures section left out', () => {
  const raw = `${RAW}\n## 圖片\n\n${W('x', 9, 'y')} in a system section\n`;
  const items = na.snapshotNotes(`# H ${W('a', 1, 'n')}\n${detailOf(`# Heading ${W('h', 4, 'n')}\n\n${P1}\n\n${P2}\n\n${P3}`)}`);
  assert.deepEqual(plain(items).map(i => [i.id, i.numbers]), [['p1', [2]], ['p2', [3]]]);
  assert.equal(items[0].text, P1);
  assert.equal(na.snapshotNotes(raw).length, 2);
  assert.equal(na.snapshotNotes('no detail block').length, 0);
});

test('placeholders: links and images round-trip exactly once; notes become markers', () => {
  const [a, b] = na.snapshotNotes(RAW).map(i => i.encoded);
  assert.equal(a.text, 'Brunelleschi showed linear ⟦N2⟧perspective⟦/N2⟧ around 1415 ⟦L1⟧.');
  assert.deepEqual(plain(a.links), ['![[mona.jpg]]']);
  assert.deepEqual(plain(a.notes), [{ id: 'N2', note: '說明是什麼' }]);
  assert.equal(b.text, 'Second ⟦N3⟧note⟦/N3⟧ here with ⟦L1⟧.');
  assert.deepEqual(plain(b.links), ['[site](https://a.b/c)']);
  const back = na.checkRewrite(a, 'Brunelleschi showed linear perspective, the way lines meet, around 1415 ⟦L1⟧.');
  assert.equal(back.ok, true);
  assert.equal(back.text, 'Brunelleschi showed linear perspective, the way lines meet, around 1415 ![[mona.jpg]].');
  for (const url of ['<https://x.y/z>', 'https://x.y/z', '[[Note|alias]]', '![alt](a.png)']) {
    const e = na.encodeParagraph('p1', `see ${url} and ${W('t', 1, 'n')}`);
    assert.equal(e.links.length, 1, url);
    assert.ok(!e.text.includes('x.y') && !e.text.includes('alias') && !e.text.includes('a.png'), url);
  }
});

test('placeholders: paragraphs that cannot be sent safely are not sent (their notes stay)', () => {
  assert.equal(na.encodeParagraph('p1', `has ⟦L1⟧ already ${W('a', 1, 'n')}`), null);
  assert.equal(na.encodeParagraph('p1', `| a | ${W('b', 1, 'n')} |`), null);
  assert.equal(na.encodeParagraph('p1', `[${W('a', 1, 'n')}](https://x.y)`), null, 'a link around a note');
  assert.equal(na.encodeParagraph('p1', `==plain highlight== and ${W('a', 1, 'n')}`), null);
  assert.equal(na.encodeParagraph('p1', `<b>html</b> ${W('a', 1, 'n')}`), null);
});

test('whitelist counterexamples: callout, checkbox, new link, %%, ==, heading, html each refuse the reply', () => {
  const item = { text: 'a ⟦L1⟧', links: ['[x](y)'] };
  const bad = { callout: '[!tip] a ⟦L1⟧', checkbox: '[x] a ⟦L1⟧', link: 'a [b](c) ⟦L1⟧', wiki: 'a [[b]] ⟦L1⟧', image: '![b](c) a ⟦L1⟧', url: 'a www.x.y ⟦L1⟧', comment: 'a %%b%% ⟦L1⟧', highlight: 'a ==b== ⟦L1⟧', heading: '# a ⟦L1⟧', html: 'a <div> ⟦L1⟧' };
  for (const [name, text] of Object.entries(bad)) assert.equal(na.checkRewrite(item, text).ok, false, name);
  assert.equal(na.checkRewrite(item, 'a better ⟦L1⟧').ok, true);
  assert.equal(na.checkRewrite({ text: 'a\nb', links: [] }, 'a\n\nb').ok, false);
  assert.equal(na.checkRewrite({ text: 'a ⟦L1⟧', links: ['$&'] }, 'x ⟦L1⟧').text, 'x $&', 'a link with replacement patterns is restored literally');
});

test('whitelist (review-a B1): a reply line that opens a block construct, or uses a mark the original never had, is refused', () => {
  const one = { text: 'line one\nline two', links: [] };
  const bad = {
    fence: 'line one\n```', tilde: 'line one\n~~~', fenceStart: '```js\nline two', math: 'line one\n$$', thematic: 'line one\n---', setext: 'line one\n===',
    spaced: 'line one\n- - -', stars: 'line one\n***', underscore: 'line one\n___', footnote: '[^1]: x\nline two', tag: '#tag one\nline two',
    indent: 'line one\n    code', tab: 'line one\n\tcode', list: '- line one\nline two', nested: 'line one\n- x', ordered: 'line one\n1. x',
    quote: '> line one\nline two', pipe: 'line | one\nline two', backtick: 'line `one`\nline two', angle: 'line <one\nline two', brace: 'line {one}\nline two', dollar: 'line $one\nline two',
    tokenOnly: 'line one\nline ⟦L9⟧'
  };
  for (const [name, text] of Object.entries(bad)) assert.equal(na.checkRewrite(one, text).ok, false, name);
  assert.equal(na.checkRewrite(one, 'line 一, 二。 (three)\nline “two” — ok…').ok, true, 'letters, numbers, spaces and prose marks pass');
  const marks = { text: 'a *b* and `c`', links: [] };
  assert.equal(na.checkRewrite(marks, 'a *bb* and `cc`').ok, true, 'a mark the original used is allowed');
  assert.equal(na.checkRewrite(marks, '```\n').ok, false);
  const list = { text: '- one\n- two', links: [] };
  assert.equal(na.checkRewrite(list, '- uno\n- dos').ok, true, 'a list the original had keeps its marks');
  assert.equal(na.checkRewrite({ text: 'a\n    b', links: [] }, 'x\n    y').ok, true, 'an indent the original had is allowed');
});

test('whitelist (review-a B1): a refused reply changes nothing, so the hidden record stays and an earlier undo still restores', () => {
  const steps = load('core/steps/book-pipeline/apply-notes.ts');
  const record = '> [!vam-book]- 校對紀錄\n> proof-record';
  const raw = `Title\n${detailOf(`${P1}\n\nsecond line\n\n${P3}`)}\n\n${record}\n`;
  const items = na.snapshotNotes(raw);
  const request = { items: items.map(i => i.encoded) };
  const good = na.applyReplies(raw, items, replies(items));
  const fenced = JSON.stringify({ paragraphs: [{ id: 'p1', text: 'Brunelleschi showed linear perspective ⟦L1⟧\n```' }, { id: 'p2', text: 'x ⟦L1⟧' }] });
  const mixed = steps.parseApplyNotes(fenced, { ...request, items: request.items });
  assert.deepEqual([...mixed.refused.map(r => r.id)], ['p1'], 'the fenced paragraph is refused, not the step');
  const fixed = JSON.stringify({ paragraphs: [{ id: 'p1', text: 'Brunelleschi showed linear perspective ⟦L1⟧\n```' }] });
  const only = steps.parseApplyNotes(fixed, { items: [request.items[0]] });
  assert.equal(only.paragraphs.length, 0);
  assert.equal(only.refused.length, 1);
  assert.ok(good.text.includes(record), 'the hidden record is in the written text');
  assert.equal(sections.chapterBody(good.text).includes('proof-record'), false, 'the record stays out of the chapter text');
  assert.equal(na.undoApplied(good.text, good.applied).text, raw, 'the undo of the accepted apply is whole');
});

test('applyReplies (review-a Low): two identical annotated paragraphs get the skip mark once per note', () => {
  const raw = `T\n${detailOf(`${P1}\n\n${P1}`)}\n`;
  const items = na.snapshotNotes(raw);
  const out = na.applyReplies(raw, items, replies(items));
  assert.equal(out.skipped, 2);
  for (const n of bookNotes.findNotes(out.text)) assert.equal(n.note.split(na.SKIP_MARK).length - 1, 1, 'one mark per note');
});

const replies = items => items.map(i => ({ id: i.id, text: i.text.replace(/==([^=]+)==%%[^%]*%%/g, '$1 (rewritten)') }));

test('applyReplies: one pass, notes gone from replaced paragraphs, other text untouched, new ranges reported', () => {
  const items = na.snapshotNotes(RAW);
  const out = na.applyReplies(RAW, items, replies(items));
  assert.equal(out.skipped, 0);
  assert.equal(out.applied.length, 2);
  assert.ok(!out.text.includes('%%備註'));
  assert.ok(out.text.includes(P2));
  for (const a of out.applied) assert.equal(out.text.slice(a.from, a.to), a.after);
  assert.equal(bookNotes.countNotes(out.text), 0);
});

test('applyReplies: an edited, duplicated or deleted original is skipped and its note says so once', () => {
  const items = na.snapshotNotes(RAW);
  const edited = RAW.replace('showed linear', 'showed a linear');
  const a = na.applyReplies(edited, items, replies(items));
  assert.equal(a.skipped, 1); assert.equal(a.applied.length, 1); assert.equal(a.marked, 1);
  assert.ok(a.text.includes(`說明是什麼${na.SKIP_MARK}%%`));
  assert.equal(bookNotes.findNotes(a.text).filter(n => n.note.endsWith(na.SKIP_MARK)).length, 1);
  assert.equal(na.applyReplies(a.text, items, replies(items)).marked, 0, 'the mark is added once');
  const dup = RAW.replace(P2, P1);
  const d = na.applyReplies(dup, items, replies(items));
  assert.equal(d.skipped, 1, 'two identical paragraphs: ambiguous, skipped');
  assert.ok(d.applied.every(x => x.before !== P1));
  const gone = RAW.replace(P1, 'nothing');
  const g = na.applyReplies(gone, items, replies(items));
  assert.equal(g.skipped, 1); assert.equal(g.marked, 0);
});

test('applyReplies: CRLF files keep CRLF; a paragraph outside the visible chapter text is never matched', () => {
  const crlf = RAW.replace(/\n/g, '\r\n');
  const items = na.snapshotNotes(crlf);
  assert.equal(items.length, 2);
  const out = na.applyReplies(crlf, items, replies(items));
  assert.equal(out.applied.length, 2);
  assert.ok(!/[^\r]\n/.test(out.text));
  const hidden = RAW + `\n${P1}\n`;
  assert.equal(na.applyReplies(hidden, items, replies(items)).applied.length, 2, 'the copy after the Detail block does not make P1 ambiguous');
});

test('undo restores paragraphs and notes; the proof key is the same as before', () => {
  const items = na.snapshotNotes(RAW);
  const out = na.applyReplies(RAW, items, replies(items));
  const undone = na.undoApplied(out.text, out.applied);
  assert.equal(undone.text, RAW);
  assert.equal(undone.restored, 2); assert.equal(undone.skipped, 0);
  assert.equal(bookNotes.countNotes(undone.text), 2);
  const keyOf = raw => proof.proofKey({ runId: 'r', nodeId: 'n', revision: 1, body: bookNotes.projectProofBody(imageSlots.stripImageLines(sections.chapterBody(raw))), checklist: [] });
  assert.equal(keyOf(undone.text), keyOf(RAW));
  assert.notEqual(keyOf(out.text), keyOf(RAW), 'the applied text is a new text');
  const typed = out.text.replace(out.applied[0].after, `${out.applied[0].after} (typed)`);
  const part = na.undoApplied(typed, out.applied);
  assert.equal(part.restored, 1); assert.equal(part.skipped, 1);
  const crlf = out.text.replace(/\n/g, '\r\n');
  assert.equal(na.undoApplied(crlf, out.applied).text, RAW.replace(/\n/g, '\r\n'));
});

test('stripNotes removes the chosen wrappers and keeps the annotated text', () => {
  const text = `a ${W('b', 1, 'n')} c ${W('d', 2, 'm')}`;
  assert.equal(na.stripNotes(text), 'a b c d');
  assert.equal(na.stripNotes(text, [2]), `a ${W('b', 1, 'n')} c d`);
  assert.equal(na.stripNotes('plain'), 'plain');
});

test('proofIsStale: true only after the chapter text changed since a stored proof; notes do not make it stale', () => {
  const checklist = [{ id: 'C1', type: 'structure', text: 'Names the technique' }];
  const prompt = '## Checklist\n- [ ] C1 structure: Names the technique\n';
  const body = detailOf(P2);
  const key = text => proof.proofKey({ runId: 'r1', nodeId: 'n1', revision: 2, body: bookNotes.projectProofBody(imageSlots.stripImageLines(sections.chapterBody(text))), checklist: require('./support-replay.cjs').load('core/book-pipeline/plan-text.ts').parseChecklist(prompt) });
  const result = proof.evaluateProof([{ id: 'C1', status: 'met', note: 'ok', sources: [] }], checklist, ['https://example.org/a/']);
  const withRecord = detail => `${detail}\n\n> [!vam-book]- Research notes\n${sections.quoteAll(proof.appendProofRecord('', key(detail), result).text.trim())}\n`;
  const detail = withRecord(body);
  const card = d => ({ prompt, detail: d });
  const stale = (d, stage = 'checked') => review.proofIsStale(card(d), stage, 'n1', 'r1', 2);
  assert.equal(stale(detail), false);
  assert.equal(stale(detail.replace(P2, `${P2} edited`)), true);
  assert.equal(stale(detail.replace(P2, `${P2} edited`), 'needs-review'), true);
  assert.equal(stale(detail.replace(P2, `${P2} edited`), 'writing'), false, 'only checked or needs-review cards show the pill');
  assert.equal(stale(detail.replace(P2, W('A plain', 5, 'n') + ' paragraph')), true, 'sanity: another text');
  assert.equal(stale(body), false, 'no stored proof, nothing to be stale against');
  const noted = detail.replace('A plain', W('A plain', 5, 'a note'));
  assert.equal(stale(noted), false, 'adding a note keeps the proof key');
  assert.equal(review.proofIsStale(card(detail), 'checked', 'n1', 'r2', 2), true, 'another run');
});

test('keep (T9): a kept text drops the stale, open-fact and unmet-structure marks; an edit after the keep brings the chapter back to the list', () => {
  const integrity = load('core/book-pipeline/body-integrity.ts');
  const checklist = [{ id: 'C1', type: 'structure', text: 'Names the technique' }, { id: 'F1', type: 'fact', text: 'Year 1415' }];
  const prompt = '## Checklist\n- [ ] C1 structure: Names the technique\n- [ ] F1 fact: Year 1415\n';
  const parse = load('core/book-pipeline/plan-text.ts').parseChecklist;
  const key = text => proof.proofKey({ runId: 'r1', nodeId: 'n1', revision: 2, body: bookNotes.projectProofBody(imageSlots.stripImageLines(sections.chapterBody(text))), checklist: parse(prompt) });
  const result = proof.evaluateProof([{ id: 'C1', status: 'unmet', note: 'no', sources: [] }, { id: 'F1', status: 'unmet', note: 'no', sources: [] }], checklist, ['https://example.org/a/']);
  const body = detailOf(P2);
  const detail = `${body}\n\n> [!vam-book]- Research notes\n${sections.quoteAll(proof.appendProofRecord('', key(body), result).text.trim())}\n`;
  const cards = text => review.gate2Cards({
    order: ['n1'], titleOf: () => 'T',
    noteOf: () => ({ prompt, detail: text, pipelineStage: 'checked', pipelineIssue: 'structure unmet: C1' }),
    proofContext: { runId: 'r1', revisionOf: () => 2 }
  })[0];
  const pick = c => [c.structureUnmet, c.factsOpen, !!c.proofStale];
  assert.deepEqual(pick(cards(detail)), [1, 1, false], 'not kept: the open items count');
  const edited = detail.replace(P2, `${P2} edited`);
  assert.deepEqual(pick(cards(edited)), [1, 1, true], 'edited, not kept: stale too');
  const kept = integrity.keepDetail(edited);
  assert.equal(integrity.isKept(kept), true);
  assert.deepEqual(pick(cards(kept)), [0, 0, false], 'kept: the reader\'s answer stands');
  assert.equal(review.needsAttention(cards(kept)), false);
  const after = kept.replace(`${P2} edited`, `${P2} edited again`);
  assert.equal(integrity.isKept(after), false);
  assert.deepEqual(pick(cards(after)), [1, 1, true], 'an edit after the keep: asked again');
  assert.equal(review.needsAttention(cards(after)), true);
});

test('stale proof (T6c): reviewEntries flags the chapter with the edited problem and a new fingerprint; the card pill says edited', () => {
  const checklist = [{ id: 'C1', type: 'structure', text: 'Names the technique' }];
  const prompt = '## Checklist\n- [ ] C1 structure: Names the technique\n';
  const parse = require('./support-replay.cjs').load('core/book-pipeline/plan-text.ts').parseChecklist;
  const key = text => proof.proofKey({ runId: 'r1', nodeId: 'n1', revision: 2, body: bookNotes.projectProofBody(imageSlots.stripImageLines(sections.chapterBody(text))), checklist: parse(prompt) });
  const result = proof.evaluateProof([{ id: 'C1', status: 'met', note: 'ok', sources: [] }], checklist, ['https://example.org/a/']);
  const body = detailOf(P2);
  const detail = `${body}\n\n> [!vam-book]- Research notes\n${sections.quoteAll(proof.appendProofRecord('', key(body), result).text.trim())}\n`;
  const entries = text => review.reviewEntries({
    order: ['n1'], titleOf: () => 'T',
    noteOf: () => ({ prompt, detail: text, pipelineStage: 'checked' }),
    proofContext: { runId: 'r1', revisionOf: () => 2 }
  });
  assert.equal(entries(detail).length, 0, 'a fitting proof: nothing to look at');
  const edited = entries(detail.replace(P2, `${P2} edited`));
  assert.equal(edited.length, 1);
  assert.deepEqual([...edited[0].problems.map(p => p.kind)], ['edited']);
  const noted = entries(detail.replace('A plain', W('A plain', 5, 'a note')));
  assert.equal(noted.length, 0, 'a note does not make it stale');
  const withoutContext = review.reviewEntries({ order: ['n1'], titleOf: () => 'T', noteOf: () => ({ prompt, detail: detail.replace(P2, `${P2} edited`), pipelineStage: 'checked' }) });
  assert.equal(withoutContext.length, 0, 'without the run context nothing is flagged');
  const ui = require('./support-replay.cjs').load('experiences/visual-map/book-pipeline-ui.ts');
  assert.equal(ui.bookCardView({ pipelineStage: 'checked' }, false, true).edited, true);
  assert.equal(ui.bookCardView({ pipelineStage: 'checked' }, false, false).edited, undefined);
  assert.equal(ui.bookCardView({ pipelineStage: 'checked' }, true, true).edited, undefined, 'an accepted book shows no proof marks');
  assert.equal(ui.bookCardView({ pipelineStage: 'writing' }, false, true).edited, undefined);
  const ticked = ui.bookCardView({ pipelineStage: 'needs-review', pipelineIssue: 'x', pipelineSeam: 's（第 2 張，版本 1）' }, false, false, true);
  assert.deepEqual([ticked.hideStage, ticked.issueText, ticked.seam], [true, undefined, false], 'review-a B3: a ticked box looks done like an accepted book');
  assert.equal(ui.bookCardView({ pipelineStage: 'checked' }, false, true, true).edited, undefined, 'a ticked edited chapter loses its edited pill');
  assert.equal(ui.bookCardView({ pipelineStage: 'needs-review', pipelineIssue: 'x' }, false, false, false).hideStage, undefined, 'not ticked: unchanged');
});

test('whitelist (fix3): a line body must start with a letter, number, link token or opening mark; no mark the original used lets a block start through', () => {
  const dash = { text: 'one - two\nline', links: [] };
  const eq = { text: 'a = b\nline', links: [] };
  const pipe = { text: 'a | b - c\nline', links: [] };
  const bad = [
    [dash, 'one - two\n--'], [dash, 'one - two\n---'], [dash, 'one - two\n- - -'], [eq, 'a = b\n='], [eq, 'a = b\n=='],
    [pipe, 'a | b - c\n|-|-|'], [dash, 'Word\n--'], [dash, 'word\n-'], [dash, '-- one\nline'], [dash, '/ one\nline'], [dash, '% one\nline']
  ];
  for (const [item, text] of bad) assert.equal(na.checkRewrite(item, text).ok, false, JSON.stringify(text));
  assert.equal(na.checkRewrite({ text: 'Word\nline', links: [] }, 'Word\n--').ok, false, 'setext under a single word');
});

test('whitelist (fix3): common prose marks pass', () => {
  const ok = ['菲利波·布魯內萊斯基', '《蒙娜麗莎》', 'one-point perspective', 'about 30%', '約 1415～1420 年', '「引言」與『書名』：好；對、是。', 'a / b – c — d', '〈短篇〉 ok'];
  for (const text of ok) assert.equal(na.checkRewrite({ text: 'x', links: [] }, text).ok, true, text);
  assert.equal(na.checkRewrite({ text: 'x ⟦L1⟧', links: ['[a](b)'] }, '⟦L1⟧ x').ok, true, 'a line may start with a link token');
});

test('whitelist (fix3): one refused paragraph is skipped with its note kept; the valid ones are applied', () => {
  const steps = load('core/steps/book-pipeline/apply-notes.ts');
  const items = na.snapshotNotes(RAW);
  const request = { items: items.map(i => i.encoded) };
  const body = JSON.stringify({ paragraphs: [{ id: 'p1', text: '-- Brunelleschi showed linear perspective ⟦L1⟧' }, { id: 'p2', text: 'Second remark here with ⟦L1⟧.' }] });
  const parsed = steps.parseApplyNotes(body, request);
  assert.equal(parsed.paragraphs.length, 1);
  assert.equal(parsed.refused.length, 1);
  assert.equal(parsed.refused[0].id, 'p1');
  assert.ok(parsed.refused[0].reason);
  assert.throws(() => steps.parseApplyNotes(JSON.stringify({ paragraphs: [{ id: 'p1', text: 'x' }] }), request), /count/, 'the id set stays strict');
  const out = na.applyReplies(RAW, items, [...parsed.paragraphs], parsed.refused.map(r => r.id));
  assert.equal(out.skipped, 1);
  assert.equal(out.applied.length, 1);
  assert.ok(out.text.includes(`==perspective==%%備註#2：說明是什麼${na.REFUSED_MARK}%%`), 'the refused paragraph keeps its marked span and note');
  assert.ok(out.text.includes('Second remark'), 'the valid paragraph is rewritten');
  assert.ok(out.text.includes(`說明是什麼${na.REFUSED_MARK}%%`), 'its note says it was skipped');
});

test('checkRewrite (fix 4): indented code through the lead whitespace is refused; the original lead may only gain one space after a mark', () => {
  const chk = (original, reply) => na.checkRewrite({ text: original, links: [] }, reply).ok;
  const bad = [
    ['- first\n- second item', '-     code one\n- second item'],
    ['- first\n- second', '- first\n-     code two'],
    ['1. first\n2. second', '1.     code\n2. second'],
    ['> quoted one\n> quoted two', '>     code\n> quoted two'],
    ['First alpha line\nsecond line of p1', '   \tFirst alpha line\nsecond line of p1'],
    ['First alpha line\nsecond line of p1', ' \tFirst alpha line\nsecond line of p1'],
    ['First alpha line\nsecond line of p1', '  \tFirst alpha line\nsecond line of p1'],
    ['First alpha line\nsecond', '    First alpha line\nsecond'],
    ['- first\n- second', '-\tfirst\n- second'],
    ['> a\n> b', '>\ta\n> b']
  ];
  for (const [o, r] of bad) assert.equal(chk(o, r), false, JSON.stringify(r));
  assert.equal(chk('- a\n- b', '- c\n- d'), true, 'same leads pass');
  assert.equal(chk('>a\n>b', '> a\n> b'), true, 'one space after > may be added');
  assert.equal(chk('- a\n- b', '-  c\n- d'), false, 'two spaces after a marker are not the original');
  assert.equal(chk('x\n    y', 'p\n    q'), true, 'an indent the original had is kept');
});

test('applyReplies (fix 4): a refused reply gets the refusal mark, not the changed-text mark; each mark once, never stacked', () => {
  const items = na.snapshotNotes(RAW);
  const first = na.applyReplies(RAW, items, [], items.map(i => i.id));
  assert.equal(first.skipped, 2);
  assert.ok(first.text.includes(`說明是什麼${na.REFUSED_MARK}%%`));
  assert.ok(!first.text.includes(na.SKIP_MARK));
  const again = na.applyReplies(first.text, na.snapshotNotes(first.text), [], na.snapshotNotes(first.text).map(i => i.id));
  assert.equal(again.marked, 0, 'a note that already has a mark is not marked again');
  const changed = na.applyReplies(RAW.replace('showed linear', 'showed a linear'), items, [], [items[0].id]);
  assert.ok(changed.text.includes(`說明是什麼${na.REFUSED_MARK}%%`), 'refused wins over the edit: the mark names the reply');
});

test('fix5 marks: a note carrying the other mark gets the current reason instead (both directions); the same mark is not doubled', () => {
  const marked = mark => RAW.replace('說明是什麼%%', `說明是什麼${mark}%%`);
  // refused mark, then the paragraph changed meanwhile -> skip mark replaces it
  const refusedRaw = marked(na.REFUSED_MARK);
  const items = na.snapshotNotes(RAW);
  const a = na.applyReplies(refusedRaw, items, [{ id: 'p1', text: 'x' }]);
  assert.ok(a.text.includes(`說明是什麼${na.SKIP_MARK}%%`));
  assert.ok(!a.text.includes(na.REFUSED_MARK));
  // skip mark, then a refused reply -> refused mark replaces it
  const skipRaw = marked(na.SKIP_MARK);
  const b = na.applyReplies(skipRaw, na.snapshotNotes(skipRaw), [], ['p1']);
  assert.ok(b.text.includes(`說明是什麼${na.REFUSED_MARK}%%`));
  assert.ok(!b.text.includes(na.SKIP_MARK));
  assert.equal(b.marked, 1);
  // same mark again: unchanged
  const c = na.applyReplies(refusedRaw, na.snapshotNotes(refusedRaw), [], ['p1']);
  assert.equal(c.text, refusedRaw);
});

test('fix5 encode: a program mark on a note never goes to the model', () => {
  for (const mark of [na.SKIP_MARK, na.REFUSED_MARK]) {
    const raw = RAW.replace('說明是什麼%%', `說明是什麼${mark}%%`);
    const item = na.snapshotNotes(raw)[0];
    assert.equal(item.encoded.notes.find(n => n.id === 'N2').note, '說明是什麼');
    assert.ok(!JSON.stringify(item.encoded).includes('⚠'));
  }
});

test('fix5 punctuation: ‧ ・ 【】 are allowed in a rewrite, a line may start with 【 or ……, other new marks still refuse', () => {
  const item = { text: 'Plain words here', links: [] };
  for (const ok of ['Plain ‧ words・here', '【Plain】 words here', '……Plain words here']) assert.equal(na.checkRewrite(item, ok).ok, true, ok);
  assert.equal(na.checkRewrite(item, 'Plain ★ words here').ok, false);
});
