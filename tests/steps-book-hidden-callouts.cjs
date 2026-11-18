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
