// T2 (flow v3): a picture-book card keeps its work records (Prompt, picture plan, proofread result, research notes, log) in hidden
// `> [!vam-book]-` callouts. Old cards (a `## 校對結果` section, a `### 研究備註` section with a `[!note]-` callout) are read as before and
// turned into the new form on the first write; a card that is not a book card is written exactly as before.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const support = require('./support.cjs');

const sections = load('core/book-pipeline/note-sections.ts');
const proof = load('core/book-pipeline/proof.ts');
const count = (haystack, needle) => haystack.split(needle).length - 1;
const checklist = [{ id: 'C1', type: 'fact', text: 'x' }];
const result = { aggregate: 'checked', items: [{ id: 'C1', type: 'fact', status: 'met', note: 'ok', sources: [] }] };
const key = proof.proofKey({ runId: 'r1', nodeId: 'n1', revision: 1, body: 'BODY', checklist });
const record = proof.composeProofRecord(key, result);
const PROOF = '校對結果（最新一次）';
// No hidden callout may touch another: every callout title line is the first line of the text or follows a blank line.
const separated = text => text.split('\n').every((line, i, all) => !/^> \[!/.test(line) || i === 0 || all[i - 1] === '');

const OLD_CARD = ['正文一段。', '', '### 圖像', '', '![A](https://e.com/a.jpg)', 'A 說明', '', '### 來源', '', '- [[S]]', '', '### 研究備註', '', '> [!note]- 研究備註', '> - 2026-01-01　舊紀錄一', `> ${record.split('\n').join('\n> ')}`, ''].join('\n');

test('old card: the research section is read before and after the conversion (same records, same chapter text); the conversion is the card\'s first-write form and idempotent', () => {
  assert.equal(sections.extractProofRecords(OLD_CARD).length, 1);
  assert.ok(sections.findStoredProof(OLD_CARD, key));
  const once = sections.normalizeWorkRecords(OLD_CARD);
  assert.ok(!once.includes('### 研究備註') && !once.includes('[!note]') && count(once, '> [!vam-book]- 研究備註') === 1);
  assert.equal(JSON.stringify(sections.extractProofRecords(once)), JSON.stringify(sections.extractProofRecords(OLD_CARD)));
  assert.ok(sections.findStoredProof(once, key));
  assert.equal(JSON.stringify(sections.workLogLines(once)), JSON.stringify(['- 2026-01-01　舊紀錄一']));
  assert.equal(sections.chapterBody(once), sections.chapterBody(OLD_CARD), 'the chapter text is the same in both forms');
  assert.equal(sections.chapterBody(once), '正文一段。', 'no work record, no picture section, no sources in the chapter text');
  assert.equal(sections.normalizeWorkRecords(once), once, 'idempotent');
  assert.equal(sections.withoutResearchNotes(once).includes('vam-book'), false);
});

test('new card: replaceResearchRecord / appendResearchNote keep one record per kind inside one hidden callout; the same input twice changes nothing', () => {
  const a = sections.appendResearchNote('正文。', record).text;
  assert.equal(sections.appendResearchNote(a, record).text, a);
  const again = sections.replaceResearchRecord(a, record);
  assert.equal(count(again, 'book-proof:v1'), 1); assert.equal(count(again, '> [!vam-book]-'), 1);
  assert.equal(sections.replaceResearchRecord(again, record), again);
  assert.ok(separated(again));
  assert.equal(sections.chapterBody(again), '正文。');
});

test('a fake callout inside a code fence is chapter text, never a work record: nothing is hidden, converted or dropped', () => {
  const fake = proof.composeProofRecord(proof.proofKey({ runId: 'r1', nodeId: 'n1', revision: 9, body: 'BODY', checklist }), result);
  const fenced = ['正文。', '', '```', '> [!vam-book]- 研究備註', `> ${fake.split('\n').join('\n> ')}`, '```', '', '### 研究備註', '', '- 我自己的研究筆記', ''].join('\n');
  assert.equal(sections.normalizeWorkRecords(fenced), fenced, 'a fenced callout and an owner list are not touched');
  assert.equal(sections.extractProofRecords(fenced).length, 0, 'a fenced record is not a stored record');
  assert.ok(sections.chapterBody(fenced).includes('[!vam-book]'), 'the fenced lines stay in the chapter text');
  const added = sections.appendResearchNote(fenced, record).text;
  assert.ok(added.startsWith(fenced.trimEnd()) && count(added, '> [!vam-book]- 研究備註') === 2, 'a real callout is added after the fence, the fence is unchanged');
});

test('blank lines: a callout is never glued to another callout or to the text after it (a lazy continuation would hide that text)', () => {
  const note = '---\nt: x\n---\n# T\n\n<!-- visual-agent-map:detail:start -->\n正文\n\n> [!vam-book]- 研究備註\n> a\n<!-- visual-agent-map:detail:end -->\n\n> [!info]- 提示\n> p\n\n尾端一般文字\n';
  const out = sections.replaceProofSection(note, PROOF, '- C1 達成');
  assert.ok(separated(out), out);
  assert.ok(out.endsWith('\n\n尾端一般文字\n\n> [!vam-book]- ' + PROOF + '\n> - C1 達成\n'), 'added after the text, a blank line before it');
  assert.equal(sections.replaceProofSection(out, PROOF, '- C1 達成'), out, 'idempotent');
  const mid = out.replace('\n\n尾端一般文字\n\n> [!vam-book]- ' + PROOF + '\n> - C1 達成\n', '\n\n> [!vam-book]- ' + PROOF + '\n> - C1 達成\n\n尾端一般文字\n');
  const replaced = sections.replaceProofSection(mid, PROOF, '- C1 未達成');
  assert.ok(replaced.endsWith('> [!vam-book]- ' + PROOF + '\n> - C1 未達成\n\n尾端一般文字\n') && separated(replaced), 'the text after the callout keeps its blank line (no lazy continuation)');
  const text = sections.appendResearchNote('正文', record).text;
  const both = sections.replaceProofSection(text, PROOF, '- C1 達成');
  assert.ok(separated(both));
  assert.equal(count(sections.replaceProofSection(both, PROOF, '- C1 未達成'), '> [!vam-book]-'), 2, 'a second callout, not a merged one');
});

test('an old proof section is replaced by the callout in place and only what the system wrote goes; the owner\'s text after it stays', () => {
  const note = `# T\n\n## ${PROOF}\n\n- C1 達成\n\n我的備註一行\n`;
  const out = sections.replaceProofSection(note, PROOF, '- C1 未達成');
  assert.equal(out, `# T\n\n> [!vam-book]- ${PROOF}\n> - C1 未達成\n\n我的備註一行\n`);
});

test('standard / textbook cards: only a log section of dated lines moves; an Update log with other text and the author\'s sections stay', () => {
  const textbook = ['### 核心結論', '', '內容', '', '### 更新紀錄', '', '- 2026-01-01　舊紀錄', '我自己加的一句話', ''].join('\n');
  assert.equal(sections.normalizeWorkRecords(textbook), textbook, 'a mixed section is the author\'s');
  const pure = ['### 核心結論', '', '內容', '', '### 更新紀錄', '', '- 2026-01-01　舊紀錄', ''].join('\n');
  const moved = sections.normalizeWorkRecords(pure);
  assert.ok(!moved.includes('### 更新紀錄') && moved.includes('> [!vam-book]-') && moved.includes('> - 2026-01-01　舊紀錄'));
  assert.ok(moved.startsWith('### 核心結論\n\n內容\n\n'));
});

// ---- the real repository ----
const bookCard = async (language = 'zh-TW', book = true) => {
  const { repo, contents } = support.fixture(language);
  const note = await support.topicNote(repo);
  const text = () => contents.get(note.path);
  if (book) contents.set(note.path, text().replace(/\n---\n/, '\npipeline-stage: "written"\nbook-role: body\n---\n'));
  return { repo, contents, note, text };
};
const PROMPT = '角色：本文\n驗收清單：\n- C1 [結構型] x';

test('repository: a book card writes Preview and Prompt as hidden callouts and reads them back; a second write changes nothing', async () => {
  const { repo, note, text } = await bookCard();
  await repo.updateNote(note.path, { summary: '摘要一', preview: '預覽一', prompt: PROMPT, detail: '### 內文\n\n正文。' });
  assert.match(text(), /\n> \[!vam-book\]- 預覽\n> 預覽一\n/);
  assert.match(text(), /\n> \[!vam-book\]- (?:提示|Prompt)\n> 角色：本文\n/);
  assert.ok(!text().includes('[!info]'));
  const read = await repo.readNote(note.path);
  assert.equal(read.prompt, PROMPT); assert.equal(read.preview, '預覽一');
  const before = text();
  await repo.updateNote(note.path, { status: 'completed' });
  assert.equal(text().replace(/^updated: .*$/m, '').replace(/^status: .*\n/m, ''), before.replace(/^updated: .*$/m, '').replace(/^status: .*\n/m, ''), 'the callouts and the body are stable');
});

test('repository: a book card in the older form ([!info]- Prompt / 預覽) is read, and turned into the hidden type on its first write', async () => {
  const { repo, contents, note, text } = await bookCard();
  await repo.updateNote(note.path, { summary: '摘要一', preview: '預覽一', prompt: PROMPT, detail: '### 內文\n\n正文。' });
  contents.set(note.path, text().replaceAll('[!vam-book]', '[!info]'));
  const read = await repo.readNote(note.path);
  assert.equal(read.prompt, PROMPT); assert.equal(read.preview, '預覽一');
  await repo.updateNote(note.path, { summary: '摘要二' });
  assert.ok(!text().includes('[!info]') && text().includes('> [!vam-book]- 提示'));
  assert.equal((await repo.readNote(note.path)).prompt, PROMPT);
});

test('repository: the proofread callout after Prompt is its own block through a write (the Prompt text does not swallow it), and a plain paragraph after it stays plain', async () => {
  const { repo, contents, note, text } = await bookCard();
  await repo.updateNote(note.path, { summary: '摘要一', prompt: PROMPT, detail: '### 內文\n\n正文。' });
  contents.set(note.path, `${text().trimEnd()}\n\n> [!vam-book]- ${PROOF}\n> - C1 達成\n\n之後的一般段落\n`);
  await repo.updateNote(note.path, { summary: '摘要二' });
  const out = text();
  assert.equal((await repo.readNote(note.path)).prompt, PROMPT, 'the Prompt text has no proof line');
  assert.equal(count(out, `> [!vam-book]- ${PROOF}\n> - C1 達成`), 1, 'the proof callout is still its own block');
  assert.ok(!out.includes('> > '), 'nothing nested');
  assert.ok(separated(out) && out.includes('\n\n之後的一般段落'), 'the paragraph after it is not a lazy continuation');
});

test('repository: a card that is not a book card is written as before (info callouts, no vam-book anywhere, no change by a second write)', async () => {
  const { repo, note, text } = await bookCard('zh-TW', false);
  await repo.updateNote(note.path, { summary: '摘要一', preview: '預覽一', prompt: PROMPT, detail: '### 內文\n\n正文。' });
  assert.match(text(), /\n> \[!info\]- 預覽\n> 預覽一\n/); assert.match(text(), /\n> \[!info\]- 提示\n/);
  assert.ok(!text().includes('vam-book'));
  const before = text().replace(/^updated: .*$/m, '');
  await repo.updateNote(note.path, { summary: '摘要一' });
  assert.equal(text().replace(/^updated: .*$/m, ''), before);
});

test('rerun x3 (the run.ts carry order): the log grows by one line each time, no repeated line, one book-slots record, one proof record', () => {
  let card = ['正文。', '', '> [!vam-book]- 研究備註', '> - 2026-11-18　log A', '> - 2026-11-18　log B', '> &lt;!-- book-slots', '>', `> ${record.split('\n').join('\n> ')}`, ''].join('\n');
  for (let rev = 1; rev <= 3; rev++) {
    const before = sections.workLogLines(card).length;
    const written = [`新正文${rev}。`, '', '### 更新紀錄', '', `- 2026-11-19　log R${rev}`, ''].join('\n');
    let carried = sections.carryWorkLog(card, sections.normalizeWorkRecords(written));
    for (const rec of sections.extractProofRecords(card).slice(-1)) carried = sections.appendResearchNote(carried, rec).text;
    carried = sections.replaceResearchRecord(carried, proof.composeProofRecord(proof.proofKey({ runId: 'r1', nodeId: 'n1', revision: rev + 1, body: `B${rev}`, checklist }), result));
    card = carried;
    const logs = sections.workLogLines(card);
    assert.equal(logs.length, before + 1, `rerun ${rev}: one more line only`);
    assert.equal(new Set(logs).size, logs.length, `rerun ${rev}: no repeated line`);
    assert.ok(count(card, 'book-slots') <= 1, `rerun ${rev}: at most one book-slots line`);
    assert.equal(count(card, 'book-proof:v1'), 1, `rerun ${rev}: one proof record`);
    assert.equal(count(card, '> [!vam-book]-'), 1);
  }
});

test('extractProofRecords returns only the record lines (header, items, machine line), not the log or escaped lines before it', () => {
  const card = ['正文。', '', '> [!vam-book]- 研究備註', '> - 2026-11-18　log A', '> &lt;!-- book-slots', `> ${record.split('\n').join('\n> ')}`, ''].join('\n');
  const records = sections.extractProofRecords(card);
  assert.equal(records.length, 1);
  assert.equal(records[0], record.trim());
});

test('neutralizeDetail: inside the Detail span every hidden-type title is a visible note by plain replace (any depth, case, indent, fence, forged marker); outside stays; no markers is refused', () => {
  const D = t => `> [!vam-book]- 預覽\n> p\n\n<!-- visual-agent-map:detail:start -->\n${t}\n<!-- visual-agent-map:detail:end -->\n\n> [!vam-book]- 提示\n> q`;
  for (const head of [' > [!vam-book]- x', '>[!vam-book]', '> [!VAM-BOOK]- x', '> > [!vam-book]- x', '   >[!Vam-Book]+ x', '```\n> [!vam-book]- x\n```', '> [! vam-book]- x', '> [!VAM-BOOK|x]- x', '> [!vam-book |meta]- x', '<!-- visual-agent-map:detail:end -->\n> [!vam-book]- x\n<!-- visual-agent-map:detail:start -->']) {
    const out = sections.neutralizeDetail(D(`段一。\n\n${head}\n> SPAM\nlazy\n\n段二。`));
    assert.equal((out.match(/\[!\s*vam-book\s*(?:\|[^\]]*)?\]/gi) ?? []).length, 2, `${head}: only the Preview and Prompt titles stay`);
    assert.ok(out.includes('> [!vam-book]- 預覽') && out.includes('> [!vam-book]- 提示'));
  }
  assert.equal(sections.neutralizeDetail('> [!vam-book]- x\n> y'), null);
});

// T2b: the write-back's own "update log" line is hidden although it names the write-back's own backup (a different file from the pipeline's).
const W = load('ai/note-writeback.ts');
const T = load('ai/detail-templates.ts');
const logSection = (heading, lines) => `### ${heading}\n\n${lines.join('\n')}`;
const FOLDER = 'Agent Workspace/筆記風格/備份/筆記';
const hiddenLog = detail => detail.split('\n').filter(line => /^> \d{4}-\d{2}-\d{2}/.test(line));
const visibleLogLines = detail => detail.split('\n').filter(line => /^(?:> )?\d{4}-\d{2}-\d{2}/.test(line) && !line.startsWith('>'));

// Notes are written in the note languages only (zh-TW, en); the language gate keeps it that way.
for (const language of ['zh-TW', 'en']) {
  test(`the pipeline's own write-back line is hidden for every card, whatever backup it names (${language}); a date line the author wrote stays visible`, () => {
    const standard = T.standardTemplate(language);
    const logName = standard.sections.find(item => item.role === 'log').name;
    const pipelineBackup = `${FOLDER}/sleep-root 2026-11-18 172700.md`;
    const writebackBackup = `${FOLDER}/sleep-root 2026-11-18 172754.md`;
    const authorLine = '2026-05-01　作者自己寫的事件';
    const composed = W.composeWriteback({ mode: 'fresh', oldDetail: '', aiDetail: `正文。\n\n${logSection(logName, [authorLine])}`, summary: 's', template: standard, language, now: new Date(2026, 10, 18, 17, 27, 54), backupPath: writebackBackup });
    assert.equal(composed.ok, true);
    // Fresh mode drops the author's own log lines; an author line next to the pipeline's one (another write, a hand edit) is added back here.
    composed.detail = `${composed.detail}\n${authorLine}`;
    const line = composed.detail.split('\n').find(row => row.includes(writebackBackup));
    assert.ok(line, 'the write-back wrote one line naming its backup');
    // The write-back's backup is not the pipeline's backup path: only folder + note name + time stamp match.
    const out = sections.hidePipelineLog(composed.detail, new Set(), pipelineBackup);
    assert.ok(!visibleLogLines(out).some(row => row.includes(writebackBackup)), 'the pipeline line is no longer visible');
    assert.equal(hiddenLog(out).filter(row => row.includes(writebackBackup)).length, 1, 'it moved into the hidden callout once');
    assert.ok(out.split('\n').some(row => row === `### ${logName}`), 'the author line keeps its own update log heading');
    assert.ok(out.includes(authorLine) && !hiddenLog(out).some(row => row.includes(authorLine)), 'the date line the author wrote stays visible, not moved');
    assert.equal(sections.hidePipelineLog(out, new Set(), pipelineBackup), out, 'the same text again changes nothing');
    assert.equal(sections.workLogLines(out).filter(row => row.includes(writebackBackup)).length, 1);
  });
}

test('hidePipelineLog: a lookalike line stays visible (another folder, another note name, extra text, no backup path); the wording no longer says "new research"', () => {
  const standard = T.standardTemplate('zh-TW');
  const logName = standard.sections.find(item => item.role === 'log').name;
  const real = `${FOLDER}/sleep-root 2026-11-18 172754.md`;
  const head = '2026-11-18　已重新寫入，舊版備份在 ';
  const base = `${FOLDER}/sleep-root 2026-11-18 172700.md`;
  for (const fake of [`${head}Other/folder/sleep-root 2026-11-18 172754.md`, `${head}${FOLDER}/another 2026-11-18 172754.md`, `${head}${real} 還有別的字`, `${head}${FOLDER}/sleep-root 2026-11-18 172754.txt`, '2026-11-18　作者寫的：已重新寫入，舊版備份在 x.md']) {
    const out = sections.hidePipelineLog(`正文\n\n${logSection(logName, [fake])}`, new Set(), base);
    assert.ok(out.includes(`\n${fake}`) && !out.includes('[!vam-book]'), fake);
  }
  assert.equal(sections.hidePipelineLog(`正文\n\n${logSection(logName, [`${head}${real}`])}`, new Set(), undefined).includes('[!vam-book]'), false, 'no backup path: nothing is hidden');
  for (const language of ['zh-TW', 'zh-CN', 'en']) {
    const text = W.composeWriteback({ mode: 'fresh', oldDetail: '', aiDetail: 'x', summary: 's', template: T.standardTemplate(language), language, now: new Date(2026, 10, 18), backupPath: 'B/x.md' }).detail;
    assert.ok(!/新研究|new research|地圖/i.test(text), language);
  }
});

test('a card of the book flow: the earlier hidden log line is kept and a second rewrite does not double it', () => {
  const standard = T.standardTemplate('zh-TW');
  const logName = standard.sections.find(item => item.role === 'log').name;
  const first = sections.hidePipelineLog(`正文\n\n${logSection(logName, [`2026-11-18　已重新寫入，舊版備份在 ${FOLDER}/c 2026-11-18 100000.md`])}`, new Set(), `${FOLDER}/c 2026-11-18 095900.md`);
  const known = new Set(sections.workLogLines(first));
  assert.equal(known.size, 1);
  // The run's own order: the rewritten text (only its own log section), the earlier hidden lines carried back.
  const second = sections.carryWorkLog(first, sections.hidePipelineLog(`正文二\n\n${logSection(logName, [`2026-11-19　已重新寫入，舊版備份在 ${FOLDER}/c 2026-11-19 100000.md`])}`, known, `${FOLDER}/c 2026-11-19 095900.md`));
  assert.equal(sections.workLogLines(second).length, 2);
  assert.equal(second.split('[!vam-book]').length - 1, 1, 'one hidden callout, nothing doubled');
  assert.ok(!/^### /m.test(second.split('\n').filter(row => /更新紀錄/.test(row)).join('\n')), 'no visible update log section is left');
});

test('the smoke-vault shape: the write-back log section is followed directly by the pipeline\'s hidden callout; the line moves in, the heading goes, the callout and its records stay once', () => {
  const backup = `${FOLDER}/sleep-root 2026-11-18 172754.md`;
  const detail = `正文。\n\n### 來源\n\n- a\n\n### 更新紀錄\n\n2026-11-18　已重新寫入，舊版備份在 ${backup}\n\n> [!vam-book]- 研究備註\n> - C1 達成\n`;
  const out = sections.hidePipelineLog(detail, new Set(), `${FOLDER}/sleep-root 2026-11-18 172700.md`);
  assert.ok(!out.includes('### 更新紀錄'), 'no visible heading');
  assert.equal(out.split('\n').filter(line => line.includes('已重新寫入')).every(line => line.startsWith('> ')), true);
  assert.equal(count(out, '> [!vam-book]-'), 1); assert.equal(count(out, '> - C1 達成'), 1);
  assert.equal(JSON.stringify(sections.workLogLines(out)), JSON.stringify([`2026-11-18　已重新寫入，舊版備份在 ${backup}`]));
  assert.equal(sections.hidePipelineLog(out, new Set(), `${FOLDER}/sleep-root 2026-11-18 172700.md`), out, 'again: nothing changes');
  // The older card (the previous wording, nothing known): the first write turns the whole log section into the hidden form, callout kept.
  const old = detail.replace('已重新寫入', '已用新研究取代');
  const moved = sections.normalizeWorkRecords(old);
  assert.ok(!moved.includes('### 更新紀錄') && count(moved, '> [!vam-book]-') === 1 && count(moved, '已用新研究取代') === 1);
});

// T2b UI fail: two "rerun this card" presses piled up log lines and left a visible `[!note]- 研究備註` copy of the records (escaped record comments).
// The fixture is the card as the UI tester saw it after one rerun; the run's own steps are replayed offline for two more reruns.
const fs = require('node:fs');
const path = require('node:path');
const AFTER1 = fs.readFileSync(path.join(__dirname, 'fixtures', 'book-sleep-cycle-after-rerun1.md'), 'utf8');
const rerunOnce = (detail, stamp) => {
  // What the author returns: the card's own text as the model saw it (hidden callouts turned into `[!note]` by neutralize), the write-back's log line added.
  const earlier = sections.normalizeWorkRecords(detail);
  const authored = earlier.replace(/\[!vam-book\]/g, '[!note]').replace(/<!-- (book-(?:slots|proof):v1)/g, '&lt;!-- $1');
  const logLine = `2026-11-18　已重新寫入，舊版備份在 ${FOLDER}/sleep-cycle 2026-11-18 ${stamp}.md`;
  const written = `${authored.replace(/\s+$/, '')}\n\n### 更新紀錄\n\n${sections.workLogLines(earlier).join('\n')}\n${logLine}\n`;
  const hidden = sections.hidePipelineLog(written, new Set(sections.workLogLines(earlier)), `${FOLDER}/sleep-cycle 2026-11-18 ${stamp.replace(/\d$/, '0')}.md`);
  let carried = sections.carryWorkLog(earlier, hidden);
  for (const record of sections.extractProofRecords(earlier).slice(-1)) carried = sections.appendResearchNote(carried, record).text;
  return carried;
};

test('rerun of the UI tester\'s card (fixture after one rerun): the log gains one line per rerun, no visible record callout or escaped record text is left, records are not doubled', () => {
  const detail = sections.detailBlockOf(AFTER1);
  assert.ok(detail.includes('> [!note]- 研究備註') && detail.includes('&lt;!-- book-slots'), 'the fixture holds the visible junk');
  const first = rerunOnce(detail, '174001');
  const second = rerunOnce(first, '174102');
  for (const out of [first, second]) {
    assert.ok(!out.includes('[!note]- 研究備註') && !out.includes('&lt;!--'), 'no visible copy of the records');
    assert.ok(!/^### 更新紀錄/m.test(out), 'no visible update log section');
    assert.equal(count(out, '> [!vam-book]- 研究備註'), 1);
    assert.equal(count(out, '<!-- book-proof:v1'), 1);
    assert.ok(count(out, '<!-- book-slots:v1') <= 1, 'the slots record is written again by the picture step, never doubled');
  }
  const lines = sections.workLogLines(first);
  assert.equal(lines.length, 3, 'two lines of the card before (one real, one the junk section\'s) are kept once, plus one new line');
  assert.equal(sections.workLogLines(second).length, lines.length + 1, 'one more line per rerun, no more');
  assert.equal(new Set(sections.workLogLines(second)).size, sections.workLogLines(second).length, 'no line twice');
  assert.equal(sections.chapterBody(second), sections.chapterBody(detail), 'the chapter text is untouched');
  // An author callout that merely has a similar title stays.
  const keep = sections.hidePipelineLog('正文\n\n> [!note]- 研究備註\n> 我自己的筆記\n', new Set(), undefined);
  assert.ok(keep.includes('> [!note]- 研究備註\n> 我自己的筆記'));
});
