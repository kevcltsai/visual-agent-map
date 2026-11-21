// Picture slots (T2): the stored record, gate 2's slot states, the picture-and-text check, the merge-gate numbers and the fallback of
// the T1 Prompt reader on a new-format Prompt. Pure functions only (the run-level cases are in steps-book-pipeline-images.cjs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const slots = S.load('core/book-pipeline/image-slots.ts');
const planText = S.load('core/book-pipeline/plan-text.ts');
const text = S.load('core/book-pipeline/text.ts');
const notes = S.load('core/book-pipeline/note-sections.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const url = n => `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/P${n}.jpg/1280px-P${n}.jpg`;
const fig = (n, caption = `Caption ${n}`) => `![P${n}](${url(n)})\n${caption}`;
const slot = (index, explains) => ({ index, kind: 'painting', explains, anchor: 'after' });
const placed = (...ns) => ns.map(n => ({ index: n, href: url(n) }));

test('slots record: one line with codes and hashes only; read back as written; a hand-damaged or fenced record is ignored; the latest valid one wins', () => {
  const line = slots.composeSlotsRecord({ placed: placed(2), missing: [{ index: 1, reasonCode: 'not_found' }, { index: 3, reasonCode: 'author_omitted' }], bad: 1 });
  assert.ok(!/\n/.test(line) && !/https?:|wikimedia/.test(line));
  assert.deepEqual(plain(slots.latestSlotsRecord(`正文\n\n${line}\n`)), { slots: [{ index: 1, state: 'missing', reasonCode: 'not_found' }, { index: 2, state: 'placed', hash: slots.shortHash(url(2)) }, { index: 3, state: 'missing', reasonCode: 'author_omitted' }], bad: 1 });
  assert.equal(slots.latestSlotsRecord('<!-- book-slots:v1 {broken -->'), undefined);
  assert.equal(slots.latestSlotsRecord('```\n' + line + '\n```'), undefined, 'fenced');
  assert.equal(slots.latestSlotsRecord('no record'), undefined);
  const newer = slots.composeSlotsRecord({ placed: placed(1), missing: [], bad: 0 });
  assert.equal(slots.latestSlotsRecord(`${line}\n${newer}\n`).slots.length, 1);
  assert.equal(slots.latestSlotsRecord(`${newer}\n<!-- book-slots:v1 {broken -->`).slots.length, 1, 'a damaged later line does not erase the last valid one');
  assert.deepEqual(plain(slots.latestSlotsRecord('<!-- book-slots:v1 {"slots":[{"index":0,"state":"placed"},{"index":1,"state":"x"},{"index":2,"state":"missing","reasonCode":"evil","hash":"zz"}],"bad":-3} -->')), { slots: [{ index: 2, state: 'missing' }], bad: 0 });
});

test('slots record: replaceResearchRecord keeps one book-slots record per card; a rewrite replaces it and the proof record stays', () => {
  const first = slots.composeSlotsRecord({ placed: placed(1), missing: [], bad: 0 });
  const second = slots.composeSlotsRecord({ placed: [], missing: [{ index: 1, reasonCode: 'load_failed' }], bad: 0 });
  const once = notes.replaceResearchRecord('正文。', first);
  const twice = notes.replaceResearchRecord(once, second);
  assert.equal(twice.split('book-slots:v1').length - 1, 1);
  assert.equal(slots.latestSlotsRecord(twice).slots[0].state, 'missing');
  assert.ok(twice.startsWith('正文。'));
});

test('describeSlots: placed while the picture is in the text; edited when replaced or deleted by hand; missing keeps its reason; no record = unrecorded', () => {
  const record = slots.latestSlotsRecord(slots.composeSlotsRecord({ placed: placed(1, 2), missing: [{ index: 3, reasonCode: 'not_found' }], bad: 0 }));
  const plan = [{ index: 1 }, { index: 2 }, { index: 3 }, { index: 4 }];
  assert.deepEqual(plain(slots.describeSlots(plan, record, [url(1), url(2)])), [{ index: 1, state: 'placed' }, { index: 2, state: 'placed' }, { index: 3, state: 'missing', reasonCode: 'not_found' }, { index: 4, state: 'unrecorded' }]);
  assert.equal(slots.describeSlots(plan, record, [url(2)])[0].state, 'edited', 'deleted by hand');
  assert.equal(slots.describeSlots(plan, record, [url(9), url(2)])[0].state, 'edited', 'replaced by another picture');
  assert.equal(slots.describeSlots(plan, record, [`${url(1)}?width=300`, url(2)])[0].state, 'placed', 'the same picture by key');
  assert.deepEqual(plain(slots.describeSlots([{ index: 1 }], undefined, [url(1)])), [{ index: 1, state: 'unrecorded' }]);
});

test('slotGate: share of chapters with a picture and share of slots with a valid marker; chapters without a plan do not count; empty = 1', () => {
  const rec = (placedN, missing) => slots.latestSlotsRecord(slots.composeSlotsRecord({ placed: placed(...placedN), missing, bad: 0 }));
  const gate = slots.slotGate([
    { planned: 2, record: rec([1], [{ index: 2, reasonCode: 'not_found' }]) },
    { planned: 2, record: rec([], [{ index: 1, reasonCode: 'author_omitted' }, { index: 2, reasonCode: 'bad_marker' }]) },
    { planned: 0 },
    { planned: 1 }
  ]);
  assert.equal(gate.chapters, 3); assert.equal(gate.withPicture, 1);
  assert.ok(Math.abs(gate.pictureShare - 1 / 3) < 1e-9);
  assert.equal(gate.slots, 5); assert.equal(gate.marked, 2);
  assert.ok(Math.abs(gate.markerShare - 2 / 5) < 1e-9);
  assert.deepEqual(plain(slots.slotGate([])), { chapters: 0, withPicture: 0, pictureShare: 1, slots: 0, marked: 0, markerShare: 1 });
});

test('checkImageText: picture next to its text is ok; a missing slot, a picture whose neighbours do not talk about it and a count mismatch are issues; none / unrecorded kinds', () => {
  const plan = [slot(1, 'Mona Lisa smile'), slot(2, 'Venice canal')];
  const record = slots.latestSlotsRecord(slots.composeSlotsRecord({ placed: placed(1, 2), missing: [], bad: 0 }));
  const good = `The Mona Lisa smile is famous.\n\n${fig(1)}\n\nThe Venice canal at dusk.\n\n${fig(2)}\n\nEnd.`;
  const ok = slots.checkImageText(good, plan, record);
  assert.deepEqual(plain({ kind: ok.kind, planned: ok.planned, placed: ok.placed, imageCount: ok.imageCount, issues: ok.issues }), { kind: 'checked', planned: 2, placed: 2, imageCount: 2, issues: [] });
  const off = slots.checkImageText(`Totally unrelated.\n\n${fig(1)}\n\nThe Venice canal at dusk.\n\n${fig(2)}\n\nEnd.`, plan, record);
  assert.deepEqual(plain(off.issues), [{ index: 1, code: 'mismatch' }]);
  const deleted = slots.checkImageText(`The Mona Lisa smile is famous.\n\n${fig(1)}\n\nThe Venice canal at dusk.\n`, plan, record);
  assert.ok(plain(deleted.issues).some(i => i.code === 'count'));
  const missing = slots.latestSlotsRecord(slots.composeSlotsRecord({ placed: placed(1), missing: [{ index: 2, reasonCode: 'not_found' }], bad: 1 }));
  const gone = slots.checkImageText(`The Mona Lisa smile is famous.\n\n${fig(1)}\n\nEnd.`, plan, missing);
  assert.deepEqual(plain(gone.issues), [{ index: 2, code: 'not_found' }]);
  assert.equal(gone.bad, 1);
  assert.deepEqual(plain(slots.imageIssueTokens(gone)), ['image_2', 'image_marker']);
  assert.deepEqual(plain(slots.imageIssueTokens(deleted)), ['image_count']);
  // A placed picture that does not match is named apart from a slot with no picture (live: slot 6 filled yet "image_6" read as missing).
  assert.deepEqual(plain(slots.imageIssueTokens(off)), ['image_1_mismatch']);
  assert.equal(slots.checkImageText('x', undefined, undefined).kind, 'none');
  assert.equal(slots.checkImageText('x', [], undefined).kind, 'none');
  assert.equal(slots.checkImageText('x', plan, undefined).kind, 'unrecorded');
  // an image in a fence or quote is not a picture of the chapter; CRLF text works the same
  assert.equal(slots.checkImageText('```\n' + fig(1) + '\n```\n\ntext', plan, record).imageCount, 0);
  assert.equal(slots.checkImageText(good.replace(/\n/g, '\r\n'), plan, record).issues.length, 0);
});

test('composeImageTextLine: one line in each language; ok / issues with the reason; none / unrecorded; no address or note text', () => {
  const plan = [slot(1, 'Mona Lisa smile'), slot(2, 'Venice canal')];
  const record = slots.latestSlotsRecord(slots.composeSlotsRecord({ placed: placed(1), missing: [{ index: 2, reasonCode: 'unsafe_url' }], bad: 0 }));
  const check = slots.checkImageText(`The Mona Lisa smile is famous.\n\n${fig(1)}\n\nEnd.`, plan, record);
  assert.equal(slots.composeImageTextLine('zh-TW', check), '圖文：圖 2 圖網址不安全');
  assert.equal(slots.composeImageTextLine('en', check), 'Pictures: Picture 2: the picture address is not safe');
  for (const lang of ['zh-TW', 'zh-CN', 'en']) {
    const line = slots.composeImageTextLine(lang, check);
    assert.ok(line && !/\n|https?:/.test(line), line);
    assert.notEqual(line, slots.composeImageTextLine(lang, { kind: 'none', planned: 0, placed: 0, imageCount: 0, bad: 0, issues: [] }));
  }
  const ok = slots.checkImageText(`The Mona Lisa smile.\n\n${fig(1)}\n\nVenice canal.\n\n${fig(2)}\n`, plan, slots.latestSlotsRecord(slots.composeSlotsRecord({ placed: placed(1, 2), missing: [], bad: 0 })));
  assert.equal(slots.composeImageTextLine('zh-TW', ok), '圖文：對得上（2 張圖）');
  assert.equal(slots.composeImageTextLine('zh-TW', { kind: 'none', planned: 0, placed: 0, imageCount: 0, bad: 0, issues: [] }), '圖文：企劃未安排圖');
  assert.equal(slots.composeImageTextLine('zh-TW', { kind: 'unrecorded', planned: 2, placed: 0, imageCount: 0, bad: 0, issues: [] }), '圖文：未記錄');
});

test('stripImageLines: image lines and their one caption line leave the proof text; fences, quotes and headings after a picture stay; CRLF', () => {
  const body = `A。\n\n${fig(1)}\n\nB。\n\n${fig(2)}\n## 標題\n\n\`\`\`\n${fig(3)}\n\`\`\`\n\n> ${fig(4).split('\n')[0]}\n\nC。`;
  const out = slots.stripImageLines(body);
  assert.ok(!out.includes('Caption 1') && !out.includes('P1.jpg') && !out.includes('Caption 2') && !out.includes('P2.jpg'));
  assert.ok(out.includes('## 標題') && out.includes('P3.jpg') && out.includes('P4.jpg') && out.includes('B。'));
  assert.ok(!/\n\n\n/.test(out));
  assert.ok(!slots.stripImageLines(`A。\r\n\r\n${fig(1).replace(/\n/g, '\r\n')}\r\n\r\nB。`).includes('P1.jpg'));
  assert.equal(slots.stripImageLines('沒有圖。'), '沒有圖。');
});

// Frozen copy of the T1 reader of a Prompt (core/book-pipeline/plan-text.ts at 5e6dfa3e): the labelled lines and the checklist only.
const T1_LABELS = { role: ['角色', 'Role'], covers: ['本章會講', 'This chapter covers'], entry: ['接入點', 'Entry point'], handoff: ['留給下一張的問題', 'Question left for the next card'], previous: ['前一張', 'Previous card'], next: ['後一張', 'Next card'] };
function t1ParseCardPrompt(prompt) {
  const out = {};
  for (const line of prompt.split(/\r?\n/)) {
    const m = /^([^:：]+)[:：]\s*(.*)$/.exec(line);
    if (!m) continue;
    const label = m[1].trim();
    for (const key of Object.keys(T1_LABELS)) if (T1_LABELS[key].includes(label) && out[key] === undefined) out[key] = text.unescapeMarkdownText(m[2].trim());
  }
  return out;
}
const T1_CHECK_LINE = /^[-*]\s+(C\d+)\s+\[([^\]]+)\]\s+(.+?)\s*$/;
function t1ParseChecklist(prompt) {
  const items = [];
  for (const line of prompt.split(/\r?\n/)) {
    const m = T1_CHECK_LINE.exec(line);
    if (!m) continue;
    const type = [['structure', ['結構型', 'structure']], ['fact', ['事實型', 'fact']]].find(([, words]) => words.includes(m[2].trim()));
    if (type) items.push({ id: m[1], type: type[0], text: text.unescapeMarkdownText(m[3]) });
  }
  return items;
}

test('T1 fallback: the frozen T1 parseCardPrompt / parseChecklist read a new-format Prompt (with 圖安排) the same as the current reader, in both languages', () => {
  const plan = { role: 'body', covers: 'c', entry: 'e', handoff: 'h', previous: { position: 1, title: 'T', summary: 'S' }, checklist: [{ id: 'C1', type: 'structure', text: 'has a start' }, { id: 'C2', type: 'fact', text: 'Date 1415' }] };
  const images = [slot(1, 'Mona Lisa smile'), slot(2, '貿易路線：海上')];
  for (const lang of ['zh-TW', 'en']) {
    const prompt = planText.composeCardPrompt({ ...plan, images }, lang);
    const oldPrompt = planText.composeCardPrompt(plan, lang);
    // The frozen reader knows only the old 前一張 / 後一張 labels, so the comparison is of the four lines it shares.
    const shared = ({ role, covers, entry, handoff }) => ({ role, covers, entry, handoff });
    assert.deepEqual(plain(t1ParseCardPrompt(prompt)), plain(shared(planText.parseCardPrompt(prompt))));
    assert.deepEqual(plain(t1ParseCardPrompt(prompt)), plain(t1ParseCardPrompt(oldPrompt)), 'slot lines add nothing to the labelled lines');
    assert.deepEqual(plain(t1ParseChecklist(prompt)), plain(t1ParseChecklist(oldPrompt)), 'slot lines are not checklist items');
    assert.equal(t1ParseChecklist(prompt).length, 2);
    assert.equal(t1ParseCardPrompt(prompt).previous, undefined, 'the frozen reader knows no new label');
    assert.equal(t1ParseCardPrompt(prompt).next, undefined);
    assert.equal(t1ParseCardPrompt(planText.composeCardPrompt({ ...plan, images: [] }, lang)).covers, 'c');
  }
});
