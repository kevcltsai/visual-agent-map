// Generated note layout: the answer comes first, internal review text stays out of Detail, and Detail headings sit
// below "## Detail" without skipped levels.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { promptsFor, makeService } = require('./support-replay.cjs');
const support = require('./support.cjs');
const { load, obsidian } = support;

const reply = detail => JSON.stringify({ summary: 'S', detail, suggestions: [], visualReferences: [] });
const ask = async (context, detail) => {
  const runtime = { runTask: async () => reply(detail) };
  return makeService(runtime, { language: 'en' }).askModel({ title: 'T', summary: '', rules: '', detail: '', task: 'X', ancestors: '', researchMode: 'local', researchDepth: 'fast', visualMode: 'off', outputLanguage: 'en', ...context }, 'gpt-6-luna', 'low');
};

test('P1-b: reader-facing detail headings start at ### and never skip a level', async () => {
  const written = '## Route overview\n\ntext\n\n#### Meals\n\n- a\n\n```md\n## not a heading\n```\n\n## Checklist\n\n###### Deep';
  const expected = '### Route overview\n\ntext\n\n#### Meals\n\n- a\n\n```md\n## not a heading\n```\n\n### Checklist\n\n#### Deep';
  assert.equal((await ask({ mode: undefined, detailFormat: 'adaptive' }, written)).detail, expected);
  assert.equal((await ask({ mode: 'task', promptProfile: 'aim', task: '<!-- aim-phase: delivery-writing -->\nWrite.', detailFormat: 'adaptive' }, written)).detail, expected);
  assert.equal((await ask({ mode: undefined, detailFormat: 'adaptive' }, '# Title\n\n## Part\n\n### Sub')).detail, '### Title\n\n#### Part\n\n##### Sub');
  // Machine-read structures of control phases keep their headings.
  assert.equal((await ask({ mode: 'task', promptProfile: 'aim', task: '<!-- aim-phase: delivery-outline -->\nOutline.' }, written)).detail, written);
  assert.equal((await ask({ mode: 'decompose' }, written)).detail, written);
});

test('P0/P1-b: reader-facing prompts forbid internal IDs and review comments and ask for headings from ###', async () => {
  for (const [language, rules] of [['en', ['internal IDs', 'level-three']], ['zh-TW', ['內部 ID', '三級標題']]]) {
    const prompt = (await promptsFor({ title: 'T', summary: 'S', rules: '', detail: 'D', task: 'X', ancestors: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off', outputLanguage: language }, { language })).at(-1).prompt;
    for (const rule of rules) assert.ok(prompt.includes(rule), `${language}: ${rule}`);
  }
});

test('P0: an AIM delivery task asks for ### section headings', () => {
  const { renderWritingTask } = load('experiences/aim/steps/delivery-writing/step.ts');
  const task = renderWritingTask({ outline: 'A; B', knownConditions: 'C', evidence: 'E' });
  assert.match(task, /each section heading as a ### heading/);
});

test('P0: the open items marker is kept outside the Detail block and still read back', async () => {
  const { openItemsMarker, readOpenItems } = load('experiences/aim/manual-flow.ts', { obsidian });
  const { repo, contents } = support.fixture('en');
  const note = await support.topicNote(repo);
  await repo.updateNote(note.path, { detail: `### Answer\n\nBody.\n\n${openItemsMarker(['Budget'])}` });
  const markdown = contents.get(note.path);
  const block = markdown.slice(markdown.indexOf('<!-- visual-agent-map:detail:start -->'), markdown.indexOf('<!-- visual-agent-map:detail:end -->'));
  assert.ok(!block.includes('aim-open-items'), 'the marker is not inside the Detail block');
  assert.match(markdown, /<!-- aim-open-items \["Budget"\] -->/, 'the marker is saved in the note');
  assert.deepEqual([...readOpenItems((await repo.readNote(note.path)).detail)], ['Budget']);
  // A new detail without open items drops the old marker.
  await repo.updateNote(note.path, { detail: '### Answer\n\nRevised.' });
  assert.ok(!contents.get(note.path).includes('aim-open-items'));
  // A note saved before this change (marker inside the block) still reads.
  const legacy = markdown.replace(/\n*<!-- aim-open-items[^\n]*-->/, '').replace('Body.', `Body.\n\n${openItemsMarker(['Legacy'])}`);
  contents.set(note.path, legacy);
  assert.deepEqual([...readOpenItems((await repo.readNote(note.path)).detail)], ['Legacy']);
});

test('P1-a: summary, then Preview, then Detail, then Prompt; an empty Prompt is left out', async () => {
  const { repo, contents } = support.fixture('en');
  const note = await support.topicNote(repo);
  await repo.updateNote(note.path, { summary: 'One-line answer.', detail: '### Answer\n\nBody.' });
  let markdown = contents.get(note.path);
  const at = pattern => markdown.search(new RegExp(pattern, 'm'));
  assert.ok(at('^## Current Summary') >= 0 && at('^## Current Summary') < at('^> \\[!info\\]- Preview$'), 'summary, then Preview');
  assert.ok(at('^> \\[!info\\]- Preview$') < at('^## Detail'), 'Preview before Detail');
  assert.equal(at('Prompt'), -1, 'an empty Prompt is not written');
  assert.equal((await repo.readNote(note.path)).prompt, '');
  await repo.updateNote(note.path, { prompt: 'Research the route.' });
  markdown = contents.get(note.path);
  assert.ok(at('^> \\[!info\\]- Prompt$') > at('^## Detail'), 'a Prompt with text comes after Detail');
  assert.ok(at('^> \\[!info\\]- Preview$') < at('^## Detail') && at('^## Detail') < at('^> \\[!info\\]- Prompt$'), 'Preview, Detail, Prompt');
  assert.equal((await repo.readNote(note.path)).prompt, 'Research the route.');
});

test('P0: the rejected-document warning lists what to fix in reader wording, without internal IDs', () => {
  const { rejectedDeliveryWarning } = load('experiences/aim/rejected-warning.ts');
  const zh = rejectedDeliveryWarning(['高雄鹽埕／鼓山一帶單人住宿候選', '依 9a7207f4-…-v3、64442f66-…-v5 補租車規定', '高雄鹽埕／鼓山一帶單人住宿候選'], 'zh-TW');
  assert.match(zh, /^> \[!warning\] 這份文件未通過最終審查\n/);
  assert.match(zh, /^> - 高雄鹽埕／鼓山一帶單人住宿候選$/m);
  assert.match(zh, /^> - 依 補租車規定$|^> - 補租車規定$/m);
  assert.equal((zh.match(/高雄鹽埕/g) ?? []).length, 1, 'each item once');
  assert.ok(!/[0-9a-f]{8}-/.test(zh), 'no internal IDs');
  assert.match(rejectedDeliveryWarning(['Commute'], 'en'), /^> \[!warning\] This document did not pass the final review\n(?:>.*\n)*> - Commute$/);
  assert.equal(rejectedDeliveryWarning([], 'en'), '');
});

// P1-a (owner decisions 2026-10-15 and 2026-10-19): Preview and Prompt are collapsed callouts; Preview follows the
// summary, Prompt follows Detail.
const body = markdown => markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
const calloutNote = async (language = 'zh-TW') => {
  const { repo, contents } = support.fixture(language);
  const note = await support.topicNote(repo);
  return { repo, contents, note, text: () => body(contents.get(note.path)) };
};

test('P1-a: Preview (after the summary) and Prompt (after Detail) are collapsed callouts; an empty Prompt and an empty Preview are left out', async () => {
  const { repo, note, text } = await calloutNote();
  assert.ok(!/預覽|Preview|Prompt/.test(text()), 'a new note shows neither an empty Preview nor an empty Prompt');
  await repo.updateNote(note.path, { summary: '一句結論。', detail: '### 答案\n\n內容。' });
  // A note made under the zh-TW interface writes zh-TW headings, the Prompt callout titled 提示 (C8).
  assert.match(text(), /## 目前摘要\n\n一句結論。\n\n> \[!info\]- 預覽\n> 一句結論。\n\n## 詳細內容\n/);
  assert.ok(!/^## (預覽|Preview|Prompt|提示)\s*$/m.test(text()), 'no ## Preview or ## Prompt section');
  await repo.updateNote(note.path, { prompt: '研究路線。\n第二行。' });
  assert.match(text(), /> \[!info\]- 預覽\n> 一句結論。\n\n## 詳細內容[\s\S]*<!-- visual-agent-map:detail:end -->\n\n> \[!info\]- 提示\n> 研究路線。\n> 第二行。\n/);
  const read = await repo.readNote(note.path);
  assert.equal(read.preview, '一句結論。');
  assert.equal(read.prompt, '研究路線。\n第二行。');
  const before = text();
  await repo.updateNote(note.path, { status: 'completed' });
  assert.equal(text(), before, 'a write that changes no content leaves the body byte-identical');
});

test('P1-a: Preview content with quotes, tables, code and images round-trips through the callout', async () => {
  const { repo, note, text } = await calloutNote('en');
  const preview = '> quoted line\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\n![img](https://example.org/a.png)';
  await repo.updateNote(note.path, { preview });
  assert.match(text(), /^> \[!info\]- Preview\n> > quoted line\n>\n> \| a \| b \|/m);
  assert.equal((await repo.readNote(note.path)).preview, preview);
  const before = text();
  await repo.updateNote(note.path, { summary: 'Later summary.' });
  assert.equal((await repo.readNote(note.path)).preview, preview, 'a maintained Preview is not overwritten');
  assert.equal(text().slice(text().indexOf('> [!info]- Preview')), before.slice(before.indexOf('> [!info]- Preview')));
});

test('P1-a: a Preview the user edited or cleared in the callout is kept', async () => {
  const { repo, contents, note, text } = await calloutNote();
  await repo.updateNote(note.path, { summary: '第一版。', detail: '### 答案' });
  contents.set(note.path, contents.get(note.path).replace('> [!info]- 預覽\n> 第一版。', '> [!info]- 預覽\n> 我自己寫的預覽。'));
  await repo.updateNote(note.path, { summary: '第二版。', detail: '### 答案\n\n更新。' });
  assert.equal((await repo.readNote(note.path)).preview, '我自己寫的預覽。');
  contents.set(note.path, contents.get(note.path).replace(/\n> \[!info\]- 預覽\n> 我自己寫的預覽。\n/, '\n'));
  await repo.updateNote(note.path, { summary: '第三版。' });
  assert.ok(!/預覽/.test(text()), 'a cleared Preview is not filled again');
  assert.equal((await repo.readNote(note.path)).preview, '');
});

test('P1-a: notes in the older layouts read correctly; ## Preview after Detail becomes a callout on write, Prompt before Detail stays', async () => {
  const { repo, contents, note, text } = await calloutNote('en');
  const fm = contents.get(note.path).match(/^---\n[\s\S]*?\n---\n/)[0];
  const answerFirst = `${fm}# T\n\n## Current Summary\n\nS.\n\n## Detail\n\n<!-- visual-agent-map:detail:start -->\nD.\n<!-- visual-agent-map:detail:end -->\n\n## Preview\n\nMy preview.\n\n## Prompt\n\nMy task.\n`;
  contents.set(note.path, answerFirst);
  let read = await repo.readNote(note.path);
  assert.equal(read.preview, 'My preview.'); assert.equal(read.prompt, 'My task.');
  await repo.updateNote(note.path, { status: 'completed' });
  assert.match(text(), /## Current Summary\n\nS\.\n\n> \[!info\]- Preview\n> My preview\.\n\n## Detail[\s\S]*detail:end -->\n\n> \[!info\]- Prompt\n> My task\./);
  read = await repo.readNote(note.path);
  assert.equal(read.preview, 'My preview.'); assert.equal(read.prompt, 'My task.');
  const legacy = `${fm}# T\n\n## Current Summary\n\nS.\n\n## Prompt\n\nOld task.\n\n## Preview\n\nOld preview.\n\n## Detail\n\n<!-- visual-agent-map:detail:start -->\nD.\n<!-- visual-agent-map:detail:end -->\n`;
  contents.set(note.path, legacy);
  await repo.updateNote(note.path, { status: 'completed' });
  assert.match(text(), /## Prompt\n\nOld task\.\n\n## Preview\n\nOld preview\.\n\n## Detail/, 'the older layout keeps its sections');
  assert.ok(!text().includes('[!info]'));
});

test('P1-a: a Chinese note keeps the 預覽 callout title under an English interface', async () => {
  const { repo, note, text } = await calloutNote('zh-TW');
  await repo.updateNote(note.path, { summary: '結論。' });
  repo.settings.language = 'en';
  await repo.updateNote(note.path, { summary: '新結論。', preview: '我的預覽。' });
  assert.match(text(), /^> \[!info\]- 預覽$/m);
  assert.ok(!/\[!info\]- Preview/.test(text()));
});

test('P1-a: quoted Thinking Origin text that looks like a callout title stays Thinking Origin', async () => {
  const { repo, note } = await calloutNote('en');
  const origin = 'line one\n[!info]- Prompt\nsecret origin text\n[!info]+ Preview';
  await repo.updateNote(note.path, { thinkingOrigin: origin, prompt: 'Real task.', summary: 'S.' });
  let read = await repo.readNote(note.path);
  assert.equal(read.thinkingOrigin, origin);
  assert.equal(read.prompt, 'Real task.');
  await repo.updateNote(note.path, { status: 'completed' });
  read = await repo.readNote(note.path);
  assert.equal(read.thinkingOrigin, origin, 'a later write keeps it');
  assert.equal(read.prompt, 'Real task.');
});

test('P1-a: callouts without a blank line between them, or with CRLF line ends, still read separately', async () => {
  const { repo, contents, note } = await calloutNote('en');
  await repo.updateNote(note.path, { summary: 'S1', prompt: 'P' });
  contents.set(note.path, contents.get(note.path).replace('> S1\n\n> [!info]- Prompt', '> S1\n> [!info]- Prompt'));
  let read = await repo.readNote(note.path);
  assert.equal(read.preview, 'S1'); assert.equal(read.prompt, 'P');
  contents.set(note.path, contents.get(note.path).replace(/\n/g, '\r\n'));
  read = await repo.readNote(note.path);
  assert.equal(read.preview, 'S1'); assert.equal(read.prompt, 'P');
});

test('P1-a (2026-10-19): an answer-first note with Preview after Detail moves Preview up on write; Preview, Detail and Prompt stay identical', async () => {
  const { repo, contents, note, text } = await calloutNote('en');
  const fm = contents.get(note.path).match(/^---\n[\s\S]*?\n---\n/)[0];
  const old = `${fm}# T\n\n## Current Summary\n\nS.\n\n## Detail\n\n<!-- visual-agent-map:detail:start -->\n### A\n\nD line.\n<!-- visual-agent-map:detail:end -->\n\n> [!info]- Preview\n> My preview.\n> > quoted\n\n> [!info]- Prompt\n> My task.\n\n## Rules\n\nR.\n\n## Working Findings\n\nF.\n`;
  contents.set(note.path, old);
  const before = await repo.readNote(note.path);
  await repo.updateNote(note.path, { status: 'completed' });
  const after = await repo.readNote(note.path);
  for (const key of ['preview', 'detail', 'prompt', 'summary', 'rules', 'newFindings']) assert.equal(after[key], before[key], key);
  const expected = old.replace(/^---\n[\s\S]*?\n---\n/, '').replace('> [!info]- Preview\n> My preview.\n> > quoted\n\n', '').replace('## Detail', '> [!info]- Preview\n> My preview.\n> > quoted\n\n## Detail');
  assert.equal(text(), expected, 'only the Preview position changes');
  const again = text();
  await repo.updateNote(note.path, { status: 'idea' });
  assert.equal(text(), again, 'a second write is stable');
});

test('P0 (2026-10-19): the open items marker survives with Preview before Detail and a Prompt after it', async () => {
  const { openItemsMarker, readOpenItems } = load('experiences/aim/manual-flow.ts', { obsidian });
  const { repo, contents } = support.fixture('en');
  const note = await support.topicNote(repo);
  await repo.updateNote(note.path, { summary: 'S.', prompt: 'Task.', detail: `### Answer\n\nBody.\n\n${openItemsMarker(['Budget'])}` });
  const markdown = contents.get(note.path);
  assert.ok(markdown.indexOf('> [!info]- Preview') < markdown.indexOf('## Detail'));
  assert.ok(markdown.indexOf('aim-open-items') > markdown.indexOf('detail:end') && markdown.indexOf('aim-open-items') < markdown.indexOf('> [!info]- Prompt'), 'marker sits between Detail and Prompt');
  assert.deepEqual([...readOpenItems((await repo.readNote(note.path)).detail)], ['Budget']);
  await repo.updateNote(note.path, { status: 'completed' });
  assert.deepEqual([...readOpenItems((await repo.readNote(note.path)).detail)], ['Budget'], 'a content-neutral write keeps it');
  assert.equal((await repo.readNote(note.path)).prompt, 'Task.');
  // The same note in the older order (Preview after Detail and marker).
  const older = markdown.replace(/> \[!info\]- Preview\n(?:>.*\n)*\n/, '').replace('> [!info]- Prompt', '> [!info]- Preview\n> S.\n\n> [!info]- Prompt');
  contents.set(note.path, older);
  assert.deepEqual([...readOpenItems((await repo.readNote(note.path)).detail)], ['Budget']);
  await repo.updateNote(note.path, { status: 'idea' });
  assert.deepEqual([...readOpenItems((await repo.readNote(note.path)).detail)], ['Budget']);
});
