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

// ---- drawn diagrams (book-ai-diagrams P1) ---------------------------------------------------------------------------------------------
const draw = S.load('core/steps/book-pipeline/draw-diagrams.ts', { obsidian: S.obsidian });
const find = S.load('core/steps/book-pipeline/find-images.ts', { obsidian: S.obsidian });
const CHAPTER = '幼蟲期約 3 天，之後化蛹 5 天，成蟲可活 20 天。\n\n[〔圖位 1：生命週期〕]'.replace('[', '').replace(']', '');
const LIFE = 'timeline\n  title 生命週期\n  幼蟲 : 3 天\n  蛹 : 5 天\n  成蟲 : 20 天';
const MARKED = `前文。\n\n〔圖位 1：生命週期〕\n\n後文。`;

test('isDiagramKind: diagram words in both scripts and English pass; real-picture words always win', () => {
  for (const kind of ['示意圖', '流程圖', '时间轴', '步骤', '比較表', '對照', '結構圖', '关系', '循環', '表格', 'diagram', 'Flow chart', 'timeline', 'comparison table', '圖解', '图表', 'Flowchart', 'charts', 'flows'])
    assert.equal(find.isDiagramKind(kind), true, kind);
  for (const kind of ['照片', '攝影', '畫作', '插畫', '地圖', '地图', 'photo', 'painting', 'map', '照片的示意圖', 'photo of a flow chart', 'painting', '', 'cover', '肖像', 'mindmap', 'flower', 'tablet', 'photograph', 'Maps'])
    assert.equal(find.isDiagramKind(kind), false, kind);
});

test('diagramTitle and diagramCaption: markup stripped, Chinese book without Han falls back to the shortened slot text, three caption formats', () => {
  assert.equal(slots.diagramTitle('生命週期 [x](y)*_#', '說明', 'zh-TW'), '生命週期 x y');
  assert.equal(slots.diagramTitle('Life cycle', '蝴蝶一生的階段與時間長度說明圖示的很長很長很長', 'zh-TW'), '蝴蝶一生的階段與時間長度說明圖示的很長很長很長'.slice(0, 20));
  assert.equal(slots.diagramTitle('Life cycle', 'x', 'en'), 'Life cycle');
  assert.equal(slots.diagramTitle('〔｜〕 [] ()', '', 'en'), 'chapter content', 'nothing left reads as a generic word');
  assert.equal(slots.diagramTitle('<b>', '', 'zh-TW'), '本章內容');
  // Whitelist: nothing that renders as a link, comment, math, highlight, strike, wikilink or table survives.
  for (const bad of ['參考 https://evil.example/x', '參考 www.evil.example', '%% 隱藏 %%', '$x$ 公式', '==重點==', '~~刪~~', '[[頁面]]', 'a|b', 'x\\y', 'a^b'])
    assert.doesNotMatch(slots.diagramTitle(bad, '', 'en'), /:\/\/|www\.|%|\$|=|~|\[|\]|\||\\|\^/, bad);
  assert.equal(slots.diagramTitle('參考 https://evil.example/x 生命週期', '', 'zh-TW'), '參考 生命週期');
  assert.equal(slots.diagramTitle('%%隱藏%%生命', '', 'en'), '隱藏 生命');
  assert.equal(slots.diagramTitle('Life https://evil.example', '蝴蝶 $x$ 一生', 'zh-TW'), '蝴蝶 x 一生', 'the fallback is cleaned the same way');
  assert.equal(slots.diagramTitle('蝴蝶的一生：卵、幼蟲（四階段）', 'x', 'zh-TW'), '蝴蝶的一生：卵、幼蟲（四階段）', 'a normal Chinese title is unchanged');
  assert.equal(slots.diagramCaption('生命週期', 'zh-TW'), '示意圖｜生命週期（依本章內文整理，非史料原圖）');
  assert.equal(slots.diagramCaption('生命周期', 'zh-CN'), '示意图｜生命周期（依本章内文整理，非史料原图）');
  assert.equal(slots.diagramCaption('Life cycle', 'en'), "Diagram | Life cycle (drawn from this chapter's text, not a source image)");
});

test('fillSlotMarkers writes a diagram at the marker with the caption after it; verifyFill passes; the body is unchanged but for the marker', () => {
  const plan = [slot(1, '生命週期')];
  const outcome = new Map([[1, { diagram: { title: '生命週期', mermaid: LIFE } }]]);
  const result = slots.fillSlotMarkers(MARKED, plan, outcome, 'zh-TW');
  assert.equal(result.text, `前文。\n\n\`\`\`mermaid\n${LIFE}\n\`\`\`\n示意圖｜生命週期（依本章內文整理，非史料原圖）\n\n後文。`);
  assert.deepEqual(plain(result.diagrams), [{ index: 1, mermaid: LIFE }]);
  assert.deepEqual(plain(result.placed), []);
  assert.deepEqual(plain(result.missing), []);
  assert.equal(slots.verifyFill(MARKED, result, plan), undefined);
  assert.deepEqual(slots.stripImageLines(result.text).includes('前文。'), true);
  // CRLF text keeps its line ends
  const crlf = slots.fillSlotMarkers(MARKED.replace(/\n/g, '\r\n'), plan, outcome, 'en');
  assert.ok(crlf.text.includes(`\`\`\`mermaid\r\ntimeline\r\n`) && !/[^\r]\n/.test(crlf.text), 'CRLF kept');
  assert.equal(slots.verifyFill(MARKED.replace(/\n/g, '\r\n'), crlf, plan), undefined);
  // a slot with no diagram and no picture still ends as before; mixed with a picture slot
  const mixed = slots.fillSlotMarkers(`A。\n\n〔圖位 1：x〕\n\nB。\n\n〔圖位 2：y〕\n\nC。\n\n〔圖位 3：z〕`, [slot(1, 'x'), slot(2, 'y'), slot(3, 'z')], new Map([[1, { diagram: { title: 'T', mermaid: LIFE } }], [2, { figure: { href: url(2), alt: 'P2', caption: 'Cap' } }]]), 'en');
  assert.deepEqual(plain(mixed.missing), [{ index: 3, reasonCode: 'not_found' }]);
  assert.equal(slots.verifyFill(`A。\n\n〔圖位 1：x〕\n\nB。\n\n〔圖位 2：y〕\n\nC。\n\n〔圖位 3：z〕`, mixed, [slot(1, 'x'), slot(2, 'y'), slot(3, 'z')]), undefined);
  // a diagram with a blank line inside still verifies (blank lines are not compared)
  const blank = slots.fillSlotMarkers(MARKED, plan, new Map([[1, { diagram: { title: 'T', mermaid: 'timeline\n\n  title T\n  A : 3' } }]]), 'en');
  assert.equal(slots.verifyFill(MARKED, blank, plan), undefined);
  // a text with no diagram outcome is exactly what it was before
  assert.equal(slots.fillSlotMarkers(MARKED, plan, new Map(), 'zh-TW').text, '前文。\n\n後文。');
  assert.deepEqual(plain(slots.fillSlotMarkers(MARKED, plan, new Map(), 'zh-TW').diagrams), []);
});

test('slots record: a diagram item is {index, state diagram, hash}; read back; reread says diagram, a hand-edited or deleted block says edited; old records read the same', () => {
  const line = slots.composeSlotsRecord({ placed: placed(2), diagrams: [{ index: 1, mermaid: LIFE }], missing: [{ index: 3, reasonCode: 'not_found' }], bad: 0 });
  const hash = slots.diagramHash(LIFE);
  assert.match(hash, /^[0-9a-f]{8}$/);
  assert.match(line, new RegExp(`\\{"index":1,"state":"diagram","hash":"${hash}"\\}`));
  const record = slots.latestSlotsRecord(line);
  assert.deepEqual(plain(record.slots[0]), { index: 1, state: 'diagram', hash });
  const plan = [1, 2, 3, 4].map(n => slot(n, `s${n}`));
  const text = `x\n\n\`\`\`mermaid\n${LIFE}\n\`\`\`\n示意圖｜T（…）\n`;
  const at = (t, i = 0) => slots.describeSlots(plan, record, [url(2)], slots.diagramHashesOf(t))[i];
  assert.deepEqual(plain(at(text)), { index: 1, state: 'diagram' });
  assert.equal(at(text.replace('幼蟲 : 3 天', '幼蟲 : 4 天')).state, 'edited', 'hand-edited block');
  assert.equal(at('x').state, 'edited', 'block deleted');
  assert.equal(at(text.replace(/\n/g, '\r\n')).state, 'diagram', 'CRLF is the same chart');
  assert.equal(slots.describeSlots(plan, record, [url(2)])[0].state, 'edited', 'no hashes given: edited');
  assert.equal(slots.diagramHashesOf(`~~~mermaid\n${LIFE}\n~~~`)[0], hash);
  // an old record (placed/missing only) is read field for field
  for (const name of ['book-sources-lead-r5.md', 'book-sources-lead-r3.md', 'book-sleep-cycle-after-rerun1.md']) {
    const fixture = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', name), 'utf8');
    const raw = [...fixture.matchAll(/<!-- book-slots:v1 (\{.*\}) -->/g)].pop();
    if (!raw) continue;
    const expected = JSON.parse(raw[1]);
    assert.deepEqual(plain(slots.latestSlotsRecord(fixture)), { slots: expected.slots.map(item => plain(item)), bad: expected.bad }, name);
  }
});

test('checkImageText: a diagram slot is no missing, count or mismatch issue and counts as filled for the shortfall floor', () => {
  const plan = [slot(1, '生命週期'), slot(2, '貿易路線')];
  const record = slots.latestSlotsRecord(slots.composeSlotsRecord({ placed: [], diagrams: [{ index: 1, mermaid: LIFE }], missing: [{ index: 2, reasonCode: 'not_found' }], bad: 0 }));
  const body = `生命週期的三個階段。\n\n\`\`\`mermaid\n${LIFE}\n\`\`\`\n示意圖｜T（…）\n\n結尾。`;
  const check = slots.checkImageText(body, plan, record);
  assert.deepEqual(plain(check.issues), [{ index: 2, code: 'not_found' }]);
  assert.equal(check.placed, 0); assert.equal(check.diagrams, 1); assert.equal(check.imageCount, 0);
  assert.deepEqual(plain(slots.imageIssueTokens(check)), ['image_2']);
  const only = slots.checkImageText(body, [slot(1, '生命週期')], slots.latestSlotsRecord(slots.composeSlotsRecord({ placed: [], diagrams: [{ index: 1, mermaid: LIFE }], missing: [], bad: 0 })));
  assert.deepEqual(plain(only.issues), []);
  // an old record has no diagrams
  assert.equal(slots.checkImageText('t', plan, slots.latestSlotsRecord(slots.composeSlotsRecord({ placed: placed(1), missing: [], bad: 0 }))).diagrams, 0);
});

test('checkDiagram: a good chart passes; every rejection class drops the chart alone', () => {
  const ok = (mermaid, title = '生命週期') => draw.checkDiagram({ title, mermaid }, CHAPTER);
  assert.deepEqual(plain(ok(LIFE)), { ok: true, mermaid: LIFE });
  assert.deepEqual(plain(ok(`${LIFE}\r\n`)), { ok: true, mermaid: LIFE }, 'CRLF and trailing blanks normalized');
  const code = (mermaid, title) => ok(mermaid, title).code;
  // type whitelist
  for (const t of ['classDiagram\n  class A', 'gantt\n  title x', 'journey\n  title x', 'erDiagram', 'block-beta\n  a', 'sankey-beta', 'unknown\n  A', 'Timeline\n  x'])
    assert.equal(code(t), 'type', t);
  for (const t of ['pie\n  title T\n  "甲" : 3', 'pie showData\n  title T\n  "甲" : 3', 'mindmap\n  root["幼蟲"]', 'sequenceDiagram\n  A->>B: hi', 'stateDiagram-v2\n  [*] --> A'])
    assert.equal(ok(t).ok, true, t);
  // unsafe content
  assert.equal(code('flowchart LR\n  A["a"] --> B["b"]\n  click A callback'), 'unsafe');
  assert.equal(code('flowchart LR\n  A["a"] --> B["b"]\n  style A fill:#f00'), 'unsafe');
  assert.equal(code('flowchart LR\n  A["https://x.example/a"]'), 'unsafe');
  assert.equal(code('flowchart LR\n  A["a<br>b"]'), 'angle');
  assert.equal(code('flowchart LR\n  A["a"]\n  <script>'), 'angle');
  assert.equal(code(LIFE, '<b>x'), 'angle');
  assert.equal(code('flowchart LR\n  A["〔圖位 1〕"]'), 'marker');
  assert.equal(code('timeline\n  title ```x'), 'bad_body');
  assert.equal(code('timeline\n' + '  a : 3\n'.repeat(31)), 'bad_body');
  assert.equal(code('timeline\n  title ' + '3'.repeat(1600)), 'bad_body');
  // numbers
  assert.equal(code('timeline\n  title T\n  幼蟲 : 4 天'), 'number_not_in_text');
  assert.equal(code(LIFE, '共 99 天'), 'number_not_in_text', 'a number in the title too');
  assert.equal(ok('flowchart LR\n  A1["幼蟲"] --> B2["蛹 5 天"]').ok, true, 'identifier digits are not quantities');
  // size
  const chain = n => 'flowchart TD\n' + Array.from({ length: n - 1 }, (_, i) => `  N${i}["甲"] --> N${i + 1}["乙"]`).join('\n');
  assert.equal(ok(chain(5)).ok, true); assert.equal(code(chain(6)), 'too_tall');
  assert.equal(code(chain(6).replace('TD', 'TB')), 'too_tall'); assert.equal(code(chain(6).replace('flowchart TD', 'graph')), 'too_tall', 'no direction');
  assert.equal(code(chain(6).replace('TD', 'LR')), 'too_tall', 'LR is not trusted: the book page may stack it');
  assert.equal(ok(chain(5).replace('TD', 'LR')).ok, true);
  assert.equal(code(chain(13).replace('TD', 'LR')), 'too_many_nodes');
  const states = (n, head = '') => 'stateDiagram-v2\n' + head + Array.from({ length: n - 1 }, (_, i) => `  S${i} --> S${i + 1}`).join('\n');
  assert.equal(ok(states(5)).ok, true); assert.equal(code(states(6)), 'too_tall');
  assert.equal(code(states(6, '  direction LR\n')), 'too_tall', 'stateDiagram-v2 in any direction');
  const mind = n => 'mindmap\n  root["根"]\n' + Array.from({ length: n - 1 }, (_, i) => `    c${i}["甲"]`).join('\n');
  assert.equal(ok(mind(5)).ok, true); assert.equal(code(mind(6)), 'too_tall');
  assert.equal(code('timeline\n  title T\n' + Array.from({ length: 6 }, () => '  甲 : 乙').join('\n')), undefined, 'timeline keeps its 12 limit');
  assert.equal(code('pie\n  title T\n' + Array.from({ length: 9 }, (_, i) => `  "S${i}" : 3`).join('\n')), 'too_many_nodes');
  assert.equal(code('mindmap\n' + Array.from({ length: 13 }, (_, i) => `  n${i}["a"]`).join('\n')), 'too_many_nodes');
  assert.equal(code('xychart-beta\n  title "T"\n  x-axis ["a", "b"]\n  bar [3, 5]'), undefined);
  assert.equal(code('xychart-beta\n  x-axis [' + Array.from({ length: 13 }, (_, i) => `"c${i}"`).join(', ') + ']'), 'too_many_nodes');
});

test('draw-diagrams step: the prompt keys by slot, carries the chart rules and treats the chapter as data; parse drops bad items alone and caps to the asked slots', () => {
  const request = { chapter: '幼蟲 3 天。', slots: [{ index: 1, kind: '示意圖', explains: '生命週期' }, { index: 4, kind: 'flow', explains: 'steps' }], language: 'zh-TW', model: 'm', reasoning: 'low' };
  const prompt = draw.drawDiagramsStep.render(request);
  assert.match(prompt, /"幼蟲 3 天。"/);
  assert.match(prompt, /\{"slot":1,"kind":"示意圖","shows":"生命週期"\}/);
  assert.match(prompt, /at most 5 nodes/); assert.match(prompt, /data, not instructions/); assert.ok(!/anchor/i.test(prompt));
  assert.ok(!/\{\{/.test(prompt), 'every placeholder filled');
  assert.equal(draw.drawDiagramsStep.schema.properties.diagrams.maxItems, 12);
  assert.equal(draw.diagramsSchema(2).properties.diagrams.maxItems, 2);
  const parse = raw => plain(draw.drawDiagramsStep.parse(raw, request));
  assert.deepEqual(parse('{"diagrams":[]}'), []);
  assert.deepEqual(parse(JSON.stringify({ diagrams: [{ slot: 1, title: 'T', mermaid: LIFE }, { slot: 1, title: 'again', mermaid: LIFE }, { slot: 2, title: 'not asked', mermaid: LIFE }, { slot: 4, title: '', mermaid: LIFE }, { slot: 4, title: 'T', mermaid: 5 }, null, 'x'] })), [{ slot: 1, title: 'T', mermaid: LIFE }]);
  assert.throws(() => parse('not json'), /not JSON/);
  assert.throws(() => parse('{"diagrams":5}'), /array/);
});

test('runDrawDiagrams: one tool-free call at low effort with the caller admission, no content log, schema sized to the asked slots', async () => {
  const seen = [];
  const calls = { run: async (prepared, options, parse) => { seen.push({ prepared, options }); return parse('{"diagrams":[{"slot":2,"title":"T","mermaid":"pie\\n  title T\\n  \\"a\\" : 3"}]}'); } };
  const admission = { id: 'adm' };
  const out = await draw.runDrawDiagrams(calls, { chapter: 'c 3', slots: [{ index: 2, kind: 'chart', explains: 'x' }], language: 'en', model: 'author-model', reasoning: 'high', usageMapPath: 'Map.md' }, { signal: new AbortController().signal, admission });
  assert.equal(seen.length, 1);
  const { options, prepared } = seen[0];
  assert.equal(options.model, 'author-model'); assert.equal(options.effort, 'low'); assert.equal(options.noContentLog, true); assert.equal(options.admission, admission);
  assert.deepEqual(plain(options.task), { textOnly: true, searchBudget: 0, timeoutMs: 120000 });
  assert.equal(prepared.step.schema.properties.diagrams.maxItems, 1);
  assert.deepEqual(plain(out), [{ slot: 2, title: 'T', mermaid: 'pie\n  title T\n  "a" : 3' }]);
});

test('draw-diagrams figures: parse keeps a figure item (null chart ok), drops one with both or a non-object figure; checkFigureDraft checks title and figure; fence and hash', () => {
  const request = { chapter: 'x', slots: [{ index: 1, kind: 'a', explains: 'b' }, { index: 2, kind: 'a', explains: 'b' }, { index: 3, kind: 'a', explains: 'b' }, { index: 4, kind: 'a', explains: 'b' }], language: 'zh-TW', model: 'm', reasoning: 'low' };
  const figure = { type: 'bar', stacked: false, groups: [{ label: '甲', values: [{ value: '25' }] }] };
  const out = plain(draw.drawDiagramsStep.parse(JSON.stringify({ diagrams: [{ slot: 1, title: 'T', mermaid: null, figure }, { slot: 2, title: 'T', mermaid: LIFE, figure }, { slot: 3, title: 'T', figure: 'x' }, { slot: 4, title: 'T', figure: [] }] }), request));
  assert.deepEqual(out, [{ slot: 1, title: 'T', figure }]);
  const props = draw.drawDiagramsStep.schema.properties.diagrams.items;
  assert.deepEqual(plain(props.required), ['slot', 'title']);
  assert.deepEqual(plain(props.properties.figure.properties.type.enum), ['bar', 'scale', 'graph', 'board']);
  const text = '甲 25 %。';
  assert.equal(draw.checkFigureDraft({ title: '甲 25', figure }, text).ok, true);
  assert.equal(draw.checkFigureDraft({ title: '甲 26', figure }, text).code, 'number_not_in_text');
  assert.equal(draw.checkFigureDraft({ title: 'a<b', figure }, text).code, 'unsafe_text');
  assert.equal(draw.checkFigureDraft({ title: 'T', figure: { type: 'x' } }, text).code, 'figure_type');
  const body = '{"type":"bar"}';
  const filled = slots.fillSlotMarkers('a\n\n〔圖位 1：s〕\n', [slot(1, 's')], new Map([[1, { diagram: { title: 'T', mermaid: body, fence: 'vam-figure' } }]]), 'zh-TW');
  assert.match(filled.text, /```vam-figure\n\{"type":"bar"\}\n```\n示意圖｜T/);
  assert.deepEqual(plain(filled.diagrams), [{ index: 1, mermaid: body }]);
  assert.deepEqual(plain(slots.diagramHashesOf(filled.text)), [slots.diagramHash(body)]);
});
